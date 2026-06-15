import { createClient } from '@supabase/supabase-js';
import type { Env } from './types';

export function getSupabase(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}
