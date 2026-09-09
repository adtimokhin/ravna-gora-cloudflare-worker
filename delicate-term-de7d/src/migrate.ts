import type { Context, Hono } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { authMiddleware } from './auth';
import { adminMiddleware } from './admin';
import { bustAccessCache } from './membership';
import { getSupabase, createAuthUser, AuthUserExistsError } from './supabase';
import { parsePriceMap, plainAddress, upsertMailingAddress, type PriceConfig, type PriceMap } from './stripe';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// Bulk user import is bounded so one call can't blow the Worker's per-request
// subrequest budget (Free plan: 50; Paid: 10,000) or CPU time. Each row costs
// roughly 2–4 subrequests (create auth user, upsert profile, +membership,
// +mailing address). Import larger lists in successive calls.
const MAX_ROWS = 500;

// bcrypt caps the significant portion of a password at 72 bytes; GoTrue rejects
// longer. The lower bound is our own — Supabase's project minimum is separate
// and still enforced by GoTrue on top of this.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

const ALLOWED_ROLES = new Set(['user', 'admin']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quoted fields, "" escapes, CR/CRLF/LF line endings)
// ---------------------------------------------------------------------------

function parseCsv(input: string): string[][] {
	let text = input;
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM

	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let sawAny = false; // did this row have any content or delimiter?

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
			sawAny = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
			sawAny = true;
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			// Drop blank lines entirely (a lone newline yields ['']).
			if (sawAny || row.length > 1 || row[0] !== '') rows.push(row);
			row = [];
			field = '';
			sawAny = false;
		} else {
			field += ch;
			sawAny = true;
		}
	}
	// Trailing field/row when the file doesn't end with a newline.
	if (sawAny || field !== '') {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Row parsing / validation
// ---------------------------------------------------------------------------

function parseBool(raw: string | undefined, fallback: boolean): boolean | null {
	if (raw === undefined || raw.trim() === '') return fallback;
	const v = raw.trim().toLowerCase();
	if (['true', '1', 'yes', 'y'].includes(v)) return true;
	if (['false', '0', 'no', 'n'].includes(v)) return false;
	return null; // unrecognised -> caller turns this into a row error
}

interface ParsedRow {
	email: string;
	password: string;
	fullName: string | null;
	emailConfirm: boolean;
	role: string;
	grantMembership: boolean;
	priceId: string | null;
	membershipExpiration: string | null; // ISO string, once validated
	address: {
		recipient_name: string;
		line1: string;
		line2: string | null;
		city: string;
		state: string;
		postal_code: string;
		country: string;
	} | null;
}

type RowError = { message: string };

function parseRow(get: (col: string) => string | undefined, priceMap: PriceMap): ParsedRow | RowError {
	const email = (get('email') ?? '').trim().toLowerCase();
	if (!email || !EMAIL_RE.test(email) || email.length > 254) {
		return { message: 'invalid or missing email' };
	}

	const password = get('password') ?? ''; // used verbatim, never trimmed
	if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
		return { message: `password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters` };
	}

	const role = (get('role') ?? 'user').trim().toLowerCase() || 'user';
	if (!ALLOWED_ROLES.has(role)) {
		return { message: `role must be one of: ${[...ALLOWED_ROLES].join(', ')}` };
	}

	const emailConfirm = parseBool(get('email_confirm'), true);
	if (emailConfirm === null) return { message: 'email_confirm must be a boolean' };

	const grantMembership = parseBool(get('grant_membership'), false);
	if (grantMembership === null) return { message: 'grant_membership must be a boolean' };

	const fullNameRaw = (get('full_name') ?? '').trim();
	const fullName = fullNameRaw === '' ? null : fullNameRaw;

	let priceId: string | null = null;
	let membershipExpiration: string | null = null;
	let address: ParsedRow['address'] = null;

	if (grantMembership) {
		priceId = (get('price_id') ?? '').trim();
		if (!priceId.startsWith('price_')) return { message: 'grant_membership requires a valid price_id' };
		const config: PriceConfig | undefined = priceMap[priceId];
		if (!config) return { message: `price_id is not in STRIPE_PRICE_MAP` };

		const expRaw = (get('membership_expiration') ?? '').trim();
		if (!expRaw) return { message: 'grant_membership requires membership_expiration' };
		const exp = new Date(expRaw);
		if (Number.isNaN(exp.getTime())) return { message: 'membership_expiration is not a valid date' };
		membershipExpiration = exp.toISOString();

		if (config.edition === 'print') {
			const line1 = (get('line1') ?? '').trim();
			if (line1) {
				const line2 = (get('line2') ?? '').trim();
				address = {
					recipient_name: (get('recipient_name') ?? fullName ?? '').trim(),
					line1,
					line2: line2 === '' ? null : line2,
					city: (get('city') ?? '').trim(),
					state: (get('state') ?? '').trim(),
					postal_code: (get('postal_code') ?? '').trim(),
					country: (get('country') ?? '').trim(),
				};
			}
		}
	}

	return {
		email,
		password,
		fullName,
		emailConfirm,
		role,
		grantMembership,
		priceId,
		membershipExpiration,
		address,
	};
}

// ---------------------------------------------------------------------------
// Per-user side effects
// ---------------------------------------------------------------------------

// Insert a gift `memberships` row (no Stripe subscription/customer) for a
// freshly-created user, then the optional mailing address. Mirrors the write in
// stripe.ts `giftMembership`. Returns the new membership_id.
async function grantGiftMembership(
	env: Env,
	input: { userId: string; priceId: string; expiration: string; address: ParsedRow['address'] },
): Promise<string> {
	const config = parsePriceMap(env.STRIPE_PRICE_MAP)[input.priceId];
	if (!config) throw new Error(`price_id ${input.priceId} not in STRIPE_PRICE_MAP`);

	const supabase = getSupabase(env);
	const { data: inserted, error } = await supabase
		.from('memberships')
		.insert({
			user_id: input.userId,
			stripe_customer_id: null,
			stripe_subscription_id: null,
			plan: config.plan,
			edition: config.edition,
			status: 'active',
			current_period_end: input.expiration,
			cancel_at_period_end: false,
			updated_at: new Date().toISOString(),
		})
		.select('membership_id')
		.single<{ membership_id: string }>();
	if (error) throw error;

	if (config.edition === 'print' && input.address) {
		await upsertMailingAddress(env, {
			membershipId: inserted.membership_id,
			userId: input.userId,
			recipientName: input.address.recipient_name,
			address: plainAddress(input.address),
		});
	}

	return inserted.membership_id;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

type MembershipOutcome = 'granted' | 'skipped' | 'failed';

interface RowResult {
	row: number; // 1-based index among data rows
	email: string;
	status: 'created' | 'skipped' | 'failed';
	user_id?: string;
	membership?: MembershipOutcome;
	membership_id?: string;
	reason?: string;
}

// POST /admin/migrate-users  (authMiddleware + adminMiddleware)
// Body: a CSV (text/csv raw, or multipart/form-data with a `file` part).
// Creates confirmed auth users from scratch and, per row, optionally grants a
// gift membership. Processes rows sequentially and returns a per-row report;
// the operation is NOT atomic across rows.
async function migrateUsers(c: Context<HonoEnv>) {
	const admin = c.get('user');
	if (!admin.sub) return c.json({ error: 'Invalid token: missing user ID' }, 401);

	// --- read the CSV text out of the request -------------------------------
	let csvText: string;
	const contentType = c.req.header('content-type') ?? '';
	try {
		if (contentType.includes('multipart/form-data')) {
			const form = await c.req.formData();
			const file = form.get('file');
			if (!(file instanceof File)) return c.json({ error: 'multipart body needs a "file" part' }, 400);
			csvText = await file.text();
		} else if (
			contentType.includes('text/csv') ||
			contentType.includes('application/csv') ||
			contentType.includes('text/plain') ||
			contentType === ''
		) {
			csvText = await c.req.text();
		} else {
			return c.json({ error: `Unsupported Content-Type: ${contentType}` }, 415);
		}
	} catch {
		return c.json({ error: 'Could not read request body' }, 400);
	}

	if (!csvText || csvText.trim() === '') return c.json({ error: 'Empty CSV body' }, 400);

	// --- parse + shape -----------------------------------------------------
	const table = parseCsv(csvText);
	if (table.length < 2) return c.json({ error: 'CSV needs a header row and at least one data row' }, 400);

	const header = table[0].map((h) => h.trim().toLowerCase());
	if (!header.includes('email') || !header.includes('password')) {
		return c.json({ error: 'CSV header must contain "email" and "password" columns' }, 400);
	}
	const dataRows = table.slice(1);
	if (dataRows.length > MAX_ROWS) {
		return c.json({ error: `Too many rows: ${dataRows.length} (max ${MAX_ROWS} per call)` }, 400);
	}

	let priceMap: PriceMap;
	try {
		priceMap = parsePriceMap(c.env.STRIPE_PRICE_MAP);
	} catch (err) {
		console.error('migrate-users: STRIPE_PRICE_MAP is misconfigured:', err);
		return c.json({ error: 'Internal server error' }, 500);
	}

	const supabase = getSupabase(c.env);
	const results: RowResult[] = [];
	const seenEmails = new Set<string>();
	let created = 0;
	let skipped = 0;
	let failed = 0;
	let membershipsGranted = 0;

	// --- process rows sequentially ---------------------------------------
	for (let i = 0; i < dataRows.length; i++) {
		const rowNum = i + 1;
		const cells = dataRows[i];
		const get = (col: string): string | undefined => {
			const idx = header.indexOf(col);
			return idx === -1 ? undefined : cells[idx];
		};

		const parsed = parseRow(get, priceMap);
		if ('message' in parsed) {
			failed++;
			results.push({ row: rowNum, email: (get('email') ?? '').trim().toLowerCase(), status: 'failed', reason: parsed.message });
			continue;
		}

		if (seenEmails.has(parsed.email)) {
			failed++;
			results.push({ row: rowNum, email: parsed.email, status: 'failed', reason: 'duplicate email within this CSV' });
			continue;
		}
		seenEmails.add(parsed.email);

		// 1. create the auth user
		let userId: string;
		try {
			const user = await createAuthUser(c.env, {
				email: parsed.email,
				password: parsed.password,
				emailConfirm: parsed.emailConfirm,
				userMetadata: parsed.fullName ? { full_name: parsed.fullName } : undefined,
			});
			userId = user.id;
		} catch (err) {
			if (err instanceof AuthUserExistsError) {
				skipped++;
				results.push({ row: rowNum, email: parsed.email, status: 'skipped', reason: 'auth user already exists' });
			} else {
				failed++;
				const reason = err instanceof Error ? err.message : 'auth user creation failed';
				console.error('migrate-users: create user failed for', parsed.email, '-', reason);
				results.push({ row: rowNum, email: parsed.email, status: 'failed', reason });
			}
			continue;
		}

		// 2. upsert the profile row (a handle_new_user trigger, if present,
		//    may already have made one — onConflict makes this idempotent).
		try {
			const { error } = await supabase.from('profiles').upsert({ id: userId, role: parsed.role }, { onConflict: 'id' });
			if (error) throw error;
		} catch (err) {
			failed++;
			const reason = `user created but profile write failed: ${err instanceof Error ? err.message : 'unknown error'}`;
			console.error('migrate-users: profile upsert failed for', parsed.email, userId, err);
			results.push({ row: rowNum, email: parsed.email, status: 'failed', user_id: userId, reason });
			continue;
		}

		created++;
		const result: RowResult = { row: rowNum, email: parsed.email, status: 'created', user_id: userId };

		// 3. optional gift membership
		if (parsed.grantMembership && parsed.priceId && parsed.membershipExpiration) {
			try {
				const membershipId = await grantGiftMembership(c.env, {
					userId,
					priceId: parsed.priceId,
					expiration: parsed.membershipExpiration,
					address: parsed.address,
				});
				membershipsGranted++;
				result.membership = 'granted';
				result.membership_id = membershipId;
			} catch (err) {
				result.membership = 'failed';
				result.reason = `membership grant failed: ${err instanceof Error ? err.message : 'unknown error'}`;
				console.error('migrate-users: membership grant failed for', parsed.email, userId, err);
			}
		} else if (parsed.grantMembership) {
			result.membership = 'skipped';
		}

		// Best-effort: a new user has no cached decision yet, but a re-run for a
		// user whose membership was just added benefits from the bust.
		await bustAccessCache(c.env, userId);

		results.push(result);
	}

	console.log(
		`migrate-users: processed ${dataRows.length} rows - created=${created} skipped=${skipped} failed=${failed} memberships=${membershipsGranted}`,
	);

	const summary = {
		total: dataRows.length,
		created,
		skipped,
		failed,
		memberships_granted: membershipsGranted,
		results,
	};
	// 200 when every row landed (created or intentionally skipped); 207 when at
	// least one row failed but others succeeded.
	return c.json(summary, failed > 0 ? 207 : 200);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function registerMigrationRoutes(app: Hono<HonoEnv>) {
	app.post('/admin/migrate-users', authMiddleware, adminMiddleware, migrateUsers);
}
