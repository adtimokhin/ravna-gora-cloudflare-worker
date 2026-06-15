import type { MiddlewareHandler } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getSupabase } from './supabase';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// NOTE: authMiddleware must run before this. It attaches user.sub (the Supabase
// user UUID) to the Hono context, which we use to look up the profile role.
// This is a UX gate — the real security is Supabase RLS + R2 service binding
// being available only inside this trusted Worker.
export const adminMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const user = c.get('user');
  const userId = user.sub;

  if (!userId) {
    return c.json({ error: 'Invalid token: missing user ID' }, 401);
  }

  const supabase = getSupabase(c.env);
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single<{ role: string }>();

  if (error || !data || data.role !== 'admin') {
    console.error('Admin check failed — userId:', userId, 'error:', error, 'data:', data);
    return c.json({ error: 'Admin access required' }, 403);
  }

  await next();
};
