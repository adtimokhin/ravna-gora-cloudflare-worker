import { createClient } from '@supabase/supabase-js';
import type { Env } from './types';

export function getSupabase(env: Env) {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false },
	});
}

// Thrown by createAuthUser when the email is already registered, so the caller
// can treat it as "skip" rather than a hard failure during a bulk import.
export class AuthUserExistsError extends Error {
	constructor(email: string) {
		super(`Auth user already exists: ${email}`);
		this.name = 'AuthUserExistsError';
	}
}

// Create a confirmed auth user via the GoTrue admin REST endpoint (same reason
// as banAuthUser for not using supabase-js's admin client). `emailConfirm: true`
// means the account is usable immediately with no verification email. The
// password is sent verbatim to GoTrue over TLS and is never logged here.
export async function createAuthUser(
	env: Env,
	input: { email: string; password: string; emailConfirm: boolean; userMetadata?: Record<string, unknown> },
): Promise<{ id: string }> {
	const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
		method: 'POST',
		headers: {
			apikey: env.SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			email: input.email,
			password: input.password,
			email_confirm: input.emailConfirm,
			user_metadata: input.userMetadata ?? {},
		}),
	});

	if (res.ok) {
		const body = (await res.json().catch(() => ({}))) as { id?: unknown };
		if (typeof body.id !== 'string') throw new Error('GoTrue create-user returned no id');
		return { id: body.id };
	}

	const detail = await res.text().catch(() => '');
	// GoTrue answers a duplicate email with 422 (older builds) or 409 (newer),
	// message/`error_code` mentioning "already registered" / "email_exists".
	if ((res.status === 422 || res.status === 409) && /alread|exist|registered/i.test(detail)) {
		throw new AuthUserExistsError(input.email);
	}
	throw new Error(`GoTrue create-user failed (${res.status}): ${detail}`);
}

// Disable a user's ability to sign in / refresh tokens. Supabase has no
// "disabled" boolean — the mechanism is an indefinite ban. Pass '0h' (or
// call unbanAuthUser) to reverse it. Uses the GoTrue admin REST endpoint
// directly rather than supabase-js's admin client so we don't pull in that
// surface just for this one call.
export async function banAuthUser(env: Env, userId: string, banDuration = '876000h'): Promise<void> {
	const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
		method: 'PUT',
		headers: {
			apikey: env.SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ ban_duration: banDuration }),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`GoTrue ban failed (${res.status}): ${detail}`);
	}
}
