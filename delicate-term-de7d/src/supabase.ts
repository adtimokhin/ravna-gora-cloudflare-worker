import { createClient } from '@supabase/supabase-js';
import type { Env } from './types';

export function getSupabase(env: Env) {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false },
	});
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
