import Stripe from 'stripe';
import type { Context, Hono } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { authMiddleware } from './auth';
import { adminMiddleware } from './admin';
import { resolveAccess, bustAccessCache, type AccessDecision } from './membership';
import { getSupabase, banAuthUser } from './supabase';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// ---------------------------------------------------------------------------
// Stripe client (Cloudflare Workers)
// ---------------------------------------------------------------------------

// Workers have no Node sockets, so Stripe must use a fetch-based HTTP client.
// No apiVersion is pinned — the account default is used, and the helpers below
// read fields defensively across API-version differences.
function stripeClient(env: Env): Stripe {
	return new Stripe(env.STRIPE_SECRET_KEY, {
		httpClient: Stripe.createFetchHttpClient(),
	});
}

// Reused across webhook invocations — the sync `constructEvent` throws on
// Workers, so verification must go through `constructEventAsync` + this
// SubtleCrypto provider.
const webCrypto = Stripe.createSubtleCryptoProvider();

// ---------------------------------------------------------------------------
// Price → membership mapping (STRIPE_PRICE_MAP)
// ---------------------------------------------------------------------------

export type MembershipPlan = 'full' | 'supporting';
export type MembershipEdition = 'digital' | 'print' | null;

export interface PriceConfig {
	plan: MembershipPlan;
	edition: MembershipEdition;
}

type PriceMap = Record<string, PriceConfig>;

// A caller-supplied id must look like a UUID before it reaches a `uuid` column —
// Postgres raises (and Supabase surfaces a 500) on a malformed value otherwise.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fallback used by the webhook only (never at checkout) when a live
// subscription references a price id that isn't in STRIPE_PRICE_MAP.
const FALLBACK_PRICE_CONFIG: PriceConfig = { plan: 'supporting', edition: null };

let cachedRaw: string | undefined;
let cachedMap: PriceMap | undefined;

// Parse + validate STRIPE_PRICE_MAP once per distinct value. Throws on a
// malformed map so the caller can turn it into a 500 (checkout) or a logged
// warning (webhook).
function parsePriceMap(raw: string): PriceMap {
	if (raw === cachedRaw && cachedMap) return cachedMap;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('STRIPE_PRICE_MAP is not valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('STRIPE_PRICE_MAP must be a JSON object');
	}

	const out: PriceMap = {};
	for (const [priceId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`STRIPE_PRICE_MAP["${priceId}"] must be an object`);
		}
		const { plan, edition } = value as Record<string, unknown>;
		if (plan !== 'full' && plan !== 'supporting') {
			throw new Error(`STRIPE_PRICE_MAP["${priceId}"].plan must be "full" or "supporting"`);
		}
		if (edition !== 'digital' && edition !== 'print' && edition !== null) {
			throw new Error(`STRIPE_PRICE_MAP["${priceId}"].edition must be "digital", "print", or null`);
		}
		out[priceId] = { plan, edition };
	}

	cachedRaw = raw;
	cachedMap = out;
	return out;
}

// Countries Stripe Checkout will accept a shipping address from, for `print`
// editions. Verbatim from SHIPPING_COUNTRIES in the reference project.
const SHIPPING_COUNTRIES: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] = [
	'US',
	'CA',
	'MX',
	'GB',
	'IE',
	'RS',
	'BA',
	'HR',
	'SI',
	'ME',
	'MK',
	'AL',
	'BG',
	'RO',
	'HU',
	'AT',
	'DE',
	'CH',
	'FR',
	'BE',
	'NL',
	'LU',
	'IT',
	'ES',
	'PT',
	'GR',
	'CZ',
	'SK',
	'PL',
	'DK',
	'SE',
	'NO',
	'FI',
	'IS',
	'EE',
	'LV',
	'LT',
	'UA',
	'MD',
	'TR',
	'AU',
	'NZ',
	'JP',
	'KR',
	'IL',
	'BR',
	'AR',
	'CL',
	'ZA',
];

// Statuses ravna-gora treats as "a currently-running membership". Kept in sync
// with MEMBERSHIP_ACTIVE_STATUSES in membership.ts.
const SUBSCRIPTION_ACTIVE_STATUSES = ['active', 'past_due', 'trialing'];

// ---------------------------------------------------------------------------
// Stripe field helpers (defensive across API versions)
// ---------------------------------------------------------------------------

function subscriptionPeriodEnd(sub: Stripe.Subscription): Date | null {
	const raw =
		// Older API: on the subscription itself.
		(sub as unknown as { current_period_end?: unknown }).current_period_end ??
		// Newer API: moved onto the first subscription item.
		(sub.items?.data?.[0] as unknown as { current_period_end?: unknown } | undefined)?.current_period_end ??
		null;
	return typeof raw === 'number' ? new Date(raw * 1000) : null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	// `subscription` moved under `parent.subscription_details` in newer API
	// versions, and can be either an id string or an expanded object.
	const anyInvoice = invoice as unknown as {
		subscription?: string | { id: string } | null;
		parent?: { subscription_details?: { subscription?: string | { id: string } } } | null;
	};
	const raw = anyInvoice.subscription ?? anyInvoice.parent?.subscription_details?.subscription ?? null;
	return typeof raw === 'string' ? raw : (raw?.id ?? null);
}

interface PlainAddress {
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postal_code: string;
	country: string;
}

function plainAddress(a: Record<string, unknown> | null | undefined): PlainAddress {
	return {
		line1: typeof a?.line1 === 'string' ? a.line1 : '',
		line2: typeof a?.line2 === 'string' ? a.line2 : null,
		city: typeof a?.city === 'string' ? a.city : '',
		state: typeof a?.state === 'string' ? a.state : '',
		postal_code: typeof a?.postal_code === 'string' ? a.postal_code : '',
		country: typeof a?.country === 'string' ? a.country : '',
	};
}

function getSessionShipping(session: Stripe.Checkout.Session): { name: string | null; address: Record<string, unknown> } | null {
	const details =
		(session as unknown as { collected_information?: { shipping_details?: unknown } }).collected_information?.shipping_details ??
		(session as unknown as { shipping_details?: unknown }).shipping_details ??
		null;

	if (details && typeof details === 'object' && 'address' in details && details.address) {
		const name = 'name' in details && typeof details.name === 'string' ? details.name : (session.customer_details?.name ?? null);
		return { name, address: details.address as Record<string, unknown> };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Supabase writes
// ---------------------------------------------------------------------------

async function uidBySubscriptionId(env: Env, subscriptionId: string): Promise<string | null> {
	const supabase = getSupabase(env);
	const { data, error } = await supabase
		.from('memberships')
		.select('user_id')
		.eq('stripe_subscription_id', subscriptionId)
		.maybeSingle<{ user_id: string }>();
	if (error) {
		console.error('uidBySubscriptionId lookup failed:', error);
		return null;
	}
	return data?.user_id ?? null;
}

async function upsertMailingAddress(
	env: Env,
	input: { membershipId: string; userId: string; recipientName: string; address: PlainAddress },
): Promise<void> {
	const supabase = getSupabase(env);
	const row = {
		membership_id: input.membershipId,
		user_id: input.userId,
		recipient_name: input.recipientName,
		line1: input.address.line1,
		line2: input.address.line2,
		city: input.address.city,
		state: input.address.state,
		postal_code: input.address.postal_code,
		country: input.address.country,
		updated_at: new Date().toISOString(),
	};

	const { data: existing, error: lookupError } = await supabase
		.from('mailing_addresses')
		.select('mailing_address_id')
		.eq('membership_id', input.membershipId)
		.maybeSingle<{ mailing_address_id: string }>();
	if (lookupError) throw lookupError;

	if (existing) {
		const { error } = await supabase.from('mailing_addresses').update(row).eq('mailing_address_id', existing.mailing_address_id);
		if (error) throw error;
	} else {
		const { error } = await supabase.from('mailing_addresses').insert(row);
		if (error) throw error;
	}
}

// Create or refresh the `memberships` row for a Stripe subscription. The write
// is an upsert keyed on the `memberships_stripe_subscription_id_key` unique
// index (migration 20260907). A pre-read tells us the prior plan/edition so an
// unrecognised price on a renewal doesn't clobber them.
async function upsertSubscriptionFromStripe(
	stripe: Stripe,
	env: Env,
	subscriptionId: string,
	opts: { uid?: string | null; priceIdHint?: string | null; session?: Stripe.Checkout.Session },
): Promise<void> {
	const sub = await stripe.subscriptions.retrieve(subscriptionId);

	const metaUid = typeof sub.metadata?.supabase_uid === 'string' ? sub.metadata.supabase_uid : null;
	const uid = opts.uid || metaUid || (await uidBySubscriptionId(env, sub.id));
	if (!uid || !UUID_RE.test(uid)) {
		console.warn('Stripe webhook: no valid Supabase user for subscription', sub.id, '— skipping');
		return;
	}

	const priceId = sub.items.data[0]?.price?.id ?? opts.priceIdHint ?? null;
	let config: PriceConfig | null = null;
	if (priceId) {
		try {
			config = parsePriceMap(env.STRIPE_PRICE_MAP)[priceId] ?? null;
		} catch (err) {
			console.error('Stripe webhook: STRIPE_PRICE_MAP parse failed:', err);
		}
		if (!config) {
			console.warn(`Stripe webhook: price ${priceId} not in STRIPE_PRICE_MAP; using fallback config`);
		}
	}

	const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
	const periodEnd = subscriptionPeriodEnd(sub);
	const nowIso = new Date().toISOString();

	const supabase = getSupabase(env);
	const { data: existing, error: lookupError } = await supabase
		.from('memberships')
		.select('membership_id, plan, edition')
		.eq('stripe_subscription_id', sub.id)
		.maybeSingle<{ membership_id: string; plan: string; edition: string | null }>();
	if (lookupError) throw lookupError;

	// plan/edition: a recognised price wins outright (its `edition` may legitimately
	// be null); otherwise keep the row's current values; otherwise the fallback.
	const effective: PriceConfig = config ?? {
		plan: (existing?.plan as PriceConfig['plan']) ?? FALLBACK_PRICE_CONFIG.plan,
		edition: (existing?.edition as PriceConfig['edition']) ?? FALLBACK_PRICE_CONFIG.edition,
	};

	const row: Record<string, unknown> = {
		user_id: uid,
		stripe_customer_id: customerId,
		stripe_subscription_id: sub.id,
		// Raw Stripe status, written verbatim (the memberships_status_check
		// constraint accepts every Stripe subscription status).
		status: sub.status,
		current_period_end: periodEnd ? periodEnd.toISOString() : null,
		cancel_at_period_end: sub.cancel_at_period_end ?? false,
		plan: effective.plan,
		edition: effective.edition,
		updated_at: nowIso,
	};

	const { data: written, error: writeError } = await supabase
		.from('memberships')
		.upsert(row, { onConflict: 'stripe_subscription_id' })
		.select('membership_id')
		.single<{ membership_id: string }>();
	if (writeError) throw writeError;
	const membershipId = written.membership_id;

	// Shipping address: only available on the checkout session, only for print.
	const effectiveEdition = effective.edition;
	if (effectiveEdition === 'print' && opts.session) {
		const shipping = getSessionShipping(opts.session);
		if (shipping) {
			await upsertMailingAddress(env, {
				membershipId,
				userId: uid,
				recipientName: shipping.name ?? '',
				address: plainAddress(shipping.address),
			});
		}
	}

	// The paywall caches a positive access decision for up to 2h; drop it so a
	// status change takes effect on the member's next request.
	await bustAccessCache(env, uid);
}

async function markSubscriptionCanceled(env: Env, sub: Stripe.Subscription): Promise<void> {
	const supabase = getSupabase(env);
	const { error } = await supabase
		.from('memberships')
		.update({
			status: 'canceled',
			cancel_at_period_end: sub.cancel_at_period_end ?? false,
			updated_at: new Date().toISOString(),
		})
		.eq('stripe_subscription_id', sub.id);
	if (error) throw error;

	const metaUid = typeof sub.metadata?.supabase_uid === 'string' ? sub.metadata.supabase_uid : null;
	const uid = metaUid || (await uidBySubscriptionId(env, sub.id));
	if (uid) await bustAccessCache(env, uid);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// POST /create-checkout-session  (authMiddleware)
// Body: { price_id: string }  ->  { id, url }
async function createCheckoutSession(c: Context<HonoEnv>) {
	const user = c.get('user');
	const uid = user.sub;
	if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const priceId = (body as { price_id?: unknown }).price_id;
	if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
		return c.json({ error: 'A valid price_id is required' }, 400);
	}

	// Don't let an existing member (or an admin) start a second membership.
	let access: AccessDecision;
	try {
		access = await resolveAccess(c, uid);
	} catch {
		return c.json({ error: 'Internal server error' }, 500);
	}
	if (access !== 'denied') {
		return c.json({ error: 'You already have an active membership.' }, 409);
	}

	let priceMap: PriceMap;
	try {
		priceMap = parsePriceMap(c.env.STRIPE_PRICE_MAP);
	} catch (err) {
		console.error('STRIPE_PRICE_MAP is misconfigured:', err);
		return c.json({ error: 'Internal server error' }, 500);
	}
	const config = priceMap[priceId];
	if (!config) return c.json({ error: 'Unknown price_id' }, 400);

	const params: Stripe.Checkout.SessionCreateParams = {
		mode: 'subscription',
		line_items: [{ price: priceId, quantity: 1 }],
		client_reference_id: uid,
		metadata: { supabase_uid: uid, price_id: priceId },
		subscription_data: { metadata: { supabase_uid: uid, price_id: priceId } },
		billing_address_collection: 'required',
		tax_id_collection: { enabled: true },
		success_url: c.env.MEMBERSHIP_SUCCESS_URL,
		cancel_url: c.env.MEMBERSHIP_CANCEL_URL,
	};
	if (typeof user.email === 'string') params.customer_email = user.email;
	if (config.edition === 'print') {
		params.shipping_address_collection = { allowed_countries: SHIPPING_COUNTRIES };
	}

	const stripe = stripeClient(c.env);
	try {
		const session = await stripe.checkout.sessions.create(params);
		return c.json({ id: session.id, url: session.url });
	} catch (err) {
		console.error('Stripe checkout.sessions.create failed:', err);
		return c.json({ error: 'Could not start checkout' }, 500);
	}
}

// POST /cancel-subscription  (authMiddleware)
// Body: { subscription_id: string }  ->  { success: true }
// Sets cancel_at_period_end; the member keeps access until the period lapses.
async function cancelSubscription(c: Context<HonoEnv>) {
	const user = c.get('user');
	const uid = user.sub;
	if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}
	const subscriptionId = (body as { subscription_id?: unknown }).subscription_id;
	if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
		return c.json({ error: 'subscription_id is required' }, 400);
	}

	const supabase = getSupabase(c.env);
	// Scoped to user_id, so this doubles as the ownership check.
	const { data: membership, error } = await supabase
		.from('memberships')
		.select('membership_id, status')
		.eq('user_id', uid)
		.eq('stripe_subscription_id', subscriptionId)
		.maybeSingle<{ membership_id: string; status: string }>();

	if (error) {
		console.error('cancel-subscription lookup failed:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
	if (!membership) return c.json({ error: 'Subscription not found' }, 404);
	if (!SUBSCRIPTION_ACTIVE_STATUSES.includes(membership.status)) {
		return c.json({ error: `Subscription is already ${membership.status}` }, 409);
	}

	const stripe = stripeClient(c.env);
	try {
		await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
	} catch (err) {
		console.error('Stripe subscriptions.update (cancel) failed:', err);
		return c.json({ error: 'Could not cancel subscription' }, 500);
	}

	const { error: updateError } = await supabase
		.from('memberships')
		.update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
		.eq('membership_id', membership.membership_id);
	if (updateError) {
		console.error('cancel-subscription DB update failed:', updateError);
		return c.json({ error: 'Internal server error' }, 500);
	}

	return c.json({ success: true });
}

// POST /deactivate-account  (authMiddleware)
// No body. Pauses + cancels every active subscription, then bans the auth user.
async function deactivateAccount(c: Context<HonoEnv>) {
	const user = c.get('user');
	const uid = user.sub;
	if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

	const supabase = getSupabase(c.env);
	const { data: memberships, error } = await supabase
		.from('memberships')
		.select('membership_id, stripe_subscription_id, status')
		.eq('user_id', uid);

	if (error) {
		console.error('deactivate-account membership lookup failed:', error);
		return c.json({ error: 'Could not deactivate account' }, 500);
	}

	const stripe = stripeClient(c.env);
	let pauseFailed = false;

	for (const m of (memberships ?? []) as Array<{
		membership_id: string;
		stripe_subscription_id: string | null;
		status: string;
	}>) {
		if (!m.stripe_subscription_id) continue;
		if (!SUBSCRIPTION_ACTIVE_STATUSES.includes(m.status)) continue;

		try {
			await stripe.subscriptions.update(m.stripe_subscription_id, {
				pause_collection: { behavior: 'void' },
				cancel_at_period_end: true,
			});
			const { error: updateError } = await supabase
				.from('memberships')
				.update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
				.eq('membership_id', m.membership_id);
			if (updateError) {
				console.error('deactivate-account: DB update failed for', m.membership_id, updateError);
				pauseFailed = true;
			}
		} catch (err) {
			console.error('deactivate-account: Stripe pause failed for', m.stripe_subscription_id, err);
			pauseFailed = true;
		}
	}

	if (pauseFailed) return c.json({ error: 'Could not deactivate account' }, 500);

	try {
		await banAuthUser(c.env, uid);
	} catch (err) {
		console.error('deactivate-account: auth ban failed:', err);
		return c.json({ error: 'Could not deactivate account' }, 500);
	}

	await bustAccessCache(c.env, uid);
	return c.json({ success: true });
}

// POST /admin/gift-membership  (authMiddleware + adminMiddleware)
// Body: { target_uid, price_id, custom_expiration, mailing_address? }
// Grants a membership with no Stripe subscription/customer (both columns null;
// stripe_customer_id was made nullable in migration 20260907). The reference's
// provenance fields (gifted_by / amount / purchased_at) have no columns here
// and are dropped.
async function giftMembership(c: Context<HonoEnv>) {
	const admin = c.get('user');
	if (!admin.sub) return c.json({ error: 'Invalid token: missing user ID' }, 401);

	let body: Record<string, unknown>;
	try {
		body = (await c.req.json()) as Record<string, unknown>;
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const targetUid = body.target_uid;
	if (typeof targetUid !== 'string' || !UUID_RE.test(targetUid)) {
		return c.json({ error: 'A valid target_uid is required' }, 400);
	}
	const priceId = body.price_id;
	if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
		return c.json({ error: 'A valid price_id is required' }, 400);
	}
	const rawExp = body.custom_expiration;
	if (typeof rawExp !== 'string' && typeof rawExp !== 'number') {
		return c.json({ error: 'custom_expiration must be a valid date' }, 400);
	}
	const expiration = new Date(rawExp);
	if (Number.isNaN(expiration.getTime())) {
		return c.json({ error: 'custom_expiration must be a valid date' }, 400);
	}

	let priceMap: PriceMap;
	try {
		priceMap = parsePriceMap(c.env.STRIPE_PRICE_MAP);
	} catch (err) {
		console.error('STRIPE_PRICE_MAP is misconfigured:', err);
		return c.json({ error: 'Internal server error' }, 500);
	}
	const config = priceMap[priceId];
	if (!config) return c.json({ error: 'Unknown price_id' }, 400);

	const supabase = getSupabase(c.env);

	const { data: target, error: targetError } = await supabase
		.from('profiles')
		.select('id')
		.eq('id', targetUid)
		.maybeSingle<{ id: string }>();
	if (targetError) {
		console.error('gift-membership: target lookup failed:', targetError);
		return c.json({ error: 'Internal server error' }, 500);
	}
	if (!target) return c.json({ error: 'Member not found' }, 404);

	const { data: inserted, error: insertError } = await supabase
		.from('memberships')
		.insert({
			user_id: targetUid,
			stripe_customer_id: null,
			stripe_subscription_id: null,
			plan: config.plan,
			edition: config.edition,
			status: 'active',
			current_period_end: expiration.toISOString(),
			cancel_at_period_end: false,
			updated_at: new Date().toISOString(),
		})
		.select('membership_id')
		.single<{ membership_id: string }>();

	if (insertError) {
		console.error('gift-membership: insert failed:', insertError);
		return c.json({ error: 'Could not create gift membership' }, 500);
	}

	if (config.edition === 'print' && body.mailing_address && typeof body.mailing_address === 'object') {
		const a = body.mailing_address as Record<string, unknown>;
		try {
			await upsertMailingAddress(c.env, {
				membershipId: inserted.membership_id,
				userId: targetUid,
				recipientName: typeof a.recipient_name === 'string' ? a.recipient_name : '',
				address: plainAddress(a),
			});
		} catch (err) {
			// The membership itself is created — don't fail the request over the
			// address.
			console.error('gift-membership: mailing address write failed:', err);
		}
	}

	await bustAccessCache(c.env, targetUid);
	return c.json({ success: true, membership_id: inserted.membership_id });
}

// POST /webhooks/stripe  (Stripe signature only — needs the raw body)
async function stripeWebhook(c: Context<HonoEnv>) {
	const signature = c.req.header('stripe-signature') ?? '';
	const payload = await c.req.text();
	const stripe = stripeClient(c.env);

	let event: Stripe.Event;
	try {
		event = await stripe.webhooks.constructEventAsync(payload, signature, c.env.STRIPE_WEBHOOK_SECRET, undefined, webCrypto);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'invalid signature';
		console.error('Stripe webhook signature verification failed:', message);
		// 400 — Stripe will not retry.
		return c.text(`Webhook Error: ${message}`, 400);
	}

	try {
		switch (event.type) {
			case 'checkout.session.completed': {
				const session = event.data.object as Stripe.Checkout.Session;
				if (session.mode !== 'subscription' || typeof session.subscription !== 'string') break;
				const uid =
					session.client_reference_id ?? (typeof session.metadata?.supabase_uid === 'string' ? session.metadata.supabase_uid : null);
				const priceIdHint = typeof session.metadata?.price_id === 'string' ? session.metadata.price_id : null;
				await upsertSubscriptionFromStripe(stripe, c.env, session.subscription, {
					uid,
					priceIdHint,
					session,
				});
				break;
			}
			case 'invoice.paid': {
				const invoice = event.data.object as Stripe.Invoice;
				const subId = invoiceSubscriptionId(invoice);
				if (subId) await upsertSubscriptionFromStripe(stripe, c.env, subId, {});
				break;
			}
			case 'customer.subscription.updated': {
				const sub = event.data.object as Stripe.Subscription;
				const uid = typeof sub.metadata?.supabase_uid === 'string' ? sub.metadata.supabase_uid : null;
				await upsertSubscriptionFromStripe(stripe, c.env, sub.id, { uid });
				break;
			}
			case 'customer.subscription.deleted': {
				const sub = event.data.object as Stripe.Subscription;
				await markSubscriptionCanceled(c.env, sub);
				break;
			}
			default:
				// Explicitly ignored (includes charge.refunded — there is no one-time
				// purchase ledger in this project to reverse).
				break;
		}
		return c.json({ received: true });
	} catch (err) {
		console.error(`Stripe webhook handler error for ${event.type}:`, err);
		// 500 — Stripe retries the delivery.
		return c.text('Handler error', 500);
	}
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function registerStripeRoutes(app: Hono<HonoEnv>) {
	app.post('/create-checkout-session', authMiddleware, createCheckoutSession);
	app.post('/cancel-subscription', authMiddleware, cancelSubscription);
	app.post('/deactivate-account', authMiddleware, deactivateAccount);
	app.post('/admin/gift-membership', authMiddleware, adminMiddleware, giftMembership);
	app.post('/webhooks/stripe', stripeWebhook);
}
