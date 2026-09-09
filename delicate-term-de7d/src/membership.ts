import type { MiddlewareHandler } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getSupabase } from './supabase';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// Mirrors MEMBERSHIP_ACTIVE_STATUSES in the Next.js app's
// lib/membershipPlans.ts — the shared definition of "this memberships row
// represents a real, currently-running membership". Kept in sync by hand
// since this Worker doesn't share code with that app.
const MEMBERSHIP_ACTIVE_STATUSES = ['active', 'past_due', 'trialing'];

// How long a resolved access decision is trusted before we re-check
// Supabase. Trades off freshness against load: a member who cancels, or an
// admin whose role is revoked, can keep access for up to this long.
const CACHE_TTL_SECONDS = 60 * 60 * 2; // 2 hours

export type AccessDecision = 'admin' | 'active_member' | 'denied';

function cacheKey(userId: string) {
	return `access:${userId}`;
}

// Given the user's newest `memberships` row, decide whether it still grants
// access. Subscription rows are status-only — a Stripe webhook keeps `status`
// current. A gift row (no Stripe subscription) is never touched after creation,
// so it also has to be within its `current_period_end`.
export function membershipRowGrantsAccess(row: {
	status: string;
	current_period_end: string | null;
	stripe_subscription_id: string | null;
}): boolean {
	if (!MEMBERSHIP_ACTIVE_STATUSES.includes(row.status)) return false;

	const isGift = row.stripe_subscription_id === null;
	if (isGift && row.current_period_end) {
		const expiresAt = Date.parse(row.current_period_end);
		if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return false;
	}
	return true;
}

// Drop a cached access decision. The Stripe flows call this after a change
// that should take effect before the 2h TTL would expire (account
// deactivation, a subscription going canceled/past_due, a gifted membership).
// Best-effort: a KV hiccup here must not fail the calling request (or cause a
// webhook to be retried) — the stale entry expires on its own within the TTL.
export async function bustAccessCache(env: Env, userId: string): Promise<void> {
	try {
		await env.MEMBERSHIP_CACHE.delete(cacheKey(userId));
	} catch (err) {
		console.error('bustAccessCache failed for', userId, err);
	}
}

// Exported so the Stripe checkout guard can reuse the exact same "does this
// user already have access?" logic without duplicating the status list.
// Callers outside the middleware should catch — this throws if the
// memberships lookup itself fails.
export async function resolveAccess(c: { env: Env }, userId: string): Promise<AccessDecision> {
	const supabase = getSupabase(c.env);

	const { data: profile, error: profileError } = await supabase.from('profiles').select('role').eq('id', userId).single<{ role: string }>();

	if (profileError) {
		console.error('Membership check — profile lookup failed:', profileError);
	}

	if (profile?.role === 'admin') {
		return 'admin';
	}

	const { data: membership, error: membershipError } = await supabase
		.from('memberships')
		.select('status, current_period_end, stripe_subscription_id')
		.eq('user_id', userId)
		.order('created_at', { ascending: false })
		.limit(1)
		.maybeSingle<{
			status: string;
			current_period_end: string | null;
			stripe_subscription_id: string | null;
		}>();

	if (membershipError) {
		console.error('Membership check — membership lookup failed:', membershipError);
		throw membershipError;
	}

	if (membership && membershipRowGrantsAccess(membership)) {
		return 'active_member';
	}

	return 'denied';
}

// NOTE: authMiddleware must run before this. Admins bypass the membership
// check entirely (they can view issue content with no membership at all);
// everyone else needs their most recent `memberships` row to have a status
// in MEMBERSHIP_ACTIVE_STATUSES. This is a UX gate, same caveat as
// adminMiddleware — the real security is Supabase RLS + this Worker being
// the only thing holding the service-role key.
//
// A positive decision ('admin' / 'active_member') is cached in the
// MEMBERSHIP_CACHE KV namespace for CACHE_TTL_SECONDS so repeat requests
// from the same paying member don't hit Supabase every time. 'denied' is
// never cached — see the comment below.
export const membershipMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
	const user = c.get('user');
	const userId = user.sub;

	if (!userId) {
		return c.json({ error: 'Invalid token: missing user ID' }, 401);
	}

	const key = cacheKey(userId);
	let decision = (await c.env.MEMBERSHIP_CACHE.get(key)) as AccessDecision | null;

	if (!decision) {
		try {
			decision = await resolveAccess(c, userId);
		} catch {
			return c.json({ error: 'Internal server error' }, 500);
		}
		// Only cache positive decisions. A "denied" result is often transient
		// (mid-checkout, subscription not yet synced from the webhook) and
		// caching it for the full TTL would lock a newly-active member out for
		// up to 2 hours after they actually gain access.
		if (decision !== 'denied') {
			// Don't await — cache population shouldn't add latency to this request.
			c.executionCtx.waitUntil(c.env.MEMBERSHIP_CACHE.put(key, decision, { expirationTtl: CACHE_TTL_SECONDS }));
		}
	}

	if (decision === 'denied') {
		return c.json({ error: 'An active membership is required to view this content' }, 403);
	}

	await next();
};
