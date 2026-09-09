-- ============================================================================
-- Migration: prepare `memberships` for the Stripe subscription port
-- Date: 2026-09-07
-- Branch: feature/redo-stripe
--
-- WHY: porting the Stripe membership endpoints from nasss-api (Firebase) into
-- this project (Supabase). Three schema facts block a faithful port:
--
--   1. memberships.stripe_customer_id is NOT NULL, but POST /admin/gift-membership
--      grants a membership with no Stripe customer at all.
--   2. There is no UNIQUE index on memberships.stripe_subscription_id, so the
--      Stripe webhook cannot upsert-by-subscription-id safely (concurrent
--      invoice.paid / customer.subscription.* deliveries would race).
--   3. memberships.status may carry a CHECK constraint narrower than the set of
--      raw Stripe subscription statuses the webhook writes verbatim.
--
-- HOW TO RUN: paste into the Supabase SQL editor (or `psql "$SUPABASE_DB_URL" -f
-- delicate-term-de7d/migrations/20260907_stripe_port_membership_schema.sql`).
-- Run STEP 0 first and eyeball the output; then run STEP 1 (the transaction).
-- STEP 0 and STEP 3 are read-only. STEP 1 is atomic (BEGIN/COMMIT).
-- Rollback SQL is at the bottom (commented).
--
-- STATUS: APPLIED 2026-09-07 by the project owner (Supabase SQL editor).
--   STEP 1 committed cleanly. No pre-existing status CHECK was found (the
--   ILIKE-'%status%' DO block dropped nothing / raised no NOTICE). STEP 3
--   verified: memberships_status_check =
--     CHECK ((status = ANY (ARRAY['active','past_due','canceled','incomplete',
--       'incomplete_expired','trialing','unpaid','paused'])))
--   1a (stripe_customer_id DROP NOT NULL) and 1b (partial unique index
--   memberships_stripe_subscription_id_key) applied in the same transaction.
--   The hardening tweaks below (lock_timeout, compound-CHECK guard, profiles
--   CHECK in STEP 0) were added AFTER the run for hygiene -- this file is a
--   checked-in artifact and is not expected to be re-run.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — pre-flight introspection (READ-ONLY). Run this and share the output
-- with the team. It confirms the assumptions this migration is built on.
-- ----------------------------------------------------------------------------

-- 0a. Every CHECK constraint on `memberships` (look for one mentioning `status`,
--     `plan`, or `edition`, and note its exact definition):
SELECT conname,
       pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  conrelid = 'public.memberships'::regclass
  AND  contype  = 'c'
ORDER  BY conname;

-- 0a-bis. CHECK constraints on `profiles` (esp. one on `role`) and any on
--     `memberships.plan` / `.edition` — new-code-writer must make sure the
--     STRIPE_PRICE_MAP `plan`/`edition` values it writes satisfy these:
SELECT conrelid::regclass AS table,
       conname,
       pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  contype = 'c'
  AND  conrelid IN ('public.profiles'::regclass, 'public.memberships'::regclass)
ORDER  BY conrelid::regclass::text, conname;

-- 0b. Foreign keys on the tables the port writes to:
SELECT conrelid::regclass AS table,
       conname,
       pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  contype = 'f'
  AND  conrelid IN ('public.memberships'::regclass,
                    'public.mailing_addresses'::regclass,
                    'public.profiles'::regclass)
ORDER  BY conrelid::regclass::text, conname;

-- 0c. Existing indexes on `memberships` (is stripe_subscription_id already unique?):
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public' AND tablename = 'memberships'
ORDER  BY indexname;

-- 0d. Would STEP 1b fail? Any duplicate non-null stripe_subscription_id values
--     must be resolved BEFORE running the transaction (expect zero rows):
SELECT stripe_subscription_id, count(*) AS n
FROM   public.memberships
WHERE  stripe_subscription_id IS NOT NULL
GROUP  BY stripe_subscription_id
HAVING count(*) > 1;

-- 0e. Triggers on the tables (does updated_at maintain itself?):
SELECT event_object_table AS table, trigger_name, action_timing, event_manipulation
FROM   information_schema.triggers
WHERE  event_object_schema = 'public'
  AND  event_object_table IN ('memberships', 'mailing_addresses')
ORDER  BY event_object_table, trigger_name;

-- 0f. Distinct status values currently stored (all must be in the STEP 1c set,
--     or that ADD CONSTRAINT will fail — expect only 'incomplete' / 'active'):
SELECT status, count(*) AS n
FROM   public.memberships
GROUP  BY status
ORDER  BY n DESC;


-- ----------------------------------------------------------------------------
-- STEP 1 — the migration. Atomic: all three changes commit together or none do.
-- ----------------------------------------------------------------------------
BEGIN;

-- Don't let the brief ACCESS EXCLUSIVE lock from the ALTER TABLE / CREATE INDEX
-- below queue indefinitely behind a long-running reader on a live table.
SET LOCAL lock_timeout = '5s';

-- 1a. gift memberships have no Stripe customer -> allow NULL.
ALTER TABLE public.memberships
  ALTER COLUMN stripe_customer_id DROP NOT NULL;

-- 1b. one membership row per Stripe subscription; NULLs (gifts) are exempt.
--     If this errors on duplicates, STOP — resolve them (see STEP 0d) and retry.
CREATE UNIQUE INDEX IF NOT EXISTS memberships_stripe_subscription_id_key
  ON public.memberships (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- 1c. status must accept every raw Stripe subscription status the webhook writes.
--     Drop any pre-existing CHECK that constrains `status`, then add the full set.
DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM   pg_constraint
    WHERE  conrelid = 'public.memberships'::regclass
      AND  contype  = 'c'
      AND  pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    -- Safety: only auto-drop a CHECK that is PURELY about `status`. If its
    -- definition also mentions another column, it's a compound constraint and
    -- dropping it would silently lose the other half -- abort so a human can
    -- handle it deliberately.
    IF con.def ILIKE '%plan%'
       OR con.def ILIKE '%edition%'
       OR con.def ILIKE '%period%'
       OR con.def ILIKE '%cancel_at%'
       OR con.def ILIKE '%customer%'
       OR con.def ILIKE '%subscription_id%'
       OR con.def ILIKE '%user_id%'
       OR con.def ILIKE '%created_at%'
       OR con.def ILIKE '%updated_at%'
    THEN
      RAISE EXCEPTION
        'CHECK % looks compound (mentions a non-status column): %  -- resolve manually, then re-run',
        con.conname, con.def;
    END IF;
    RAISE NOTICE 'Dropping existing status CHECK %: %', con.conname, con.def;
    EXECUTE format('ALTER TABLE public.memberships DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_status_check
  CHECK (status IN (
    'active',
    'past_due',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'trialing',
    'unpaid',
    'paused'
  ));

COMMIT;


-- ----------------------------------------------------------------------------
-- STEP 2 — DONE. new-code-writer can now:
--   * insert gift rows with stripe_customer_id = NULL
--   * .upsert(..., { onConflict: 'stripe_subscription_id' }) in the webhook
--   * write sub.status through verbatim (no remapping)
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- STEP 3 — post-migration verification (READ-ONLY). Expect:
--   * is_nullable = 'YES' for stripe_customer_id
--   * memberships_stripe_subscription_id_key present and UNIQUE
--   * memberships_status_check definition lists all 8 statuses
-- ----------------------------------------------------------------------------
SELECT column_name, is_nullable, data_type
FROM   information_schema.columns
WHERE  table_schema = 'public' AND table_name = 'memberships'
  AND  column_name = 'stripe_customer_id';

SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public' AND tablename = 'memberships'
  AND  indexname = 'memberships_stripe_subscription_id_key';

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  conrelid = 'public.memberships'::regclass
  AND  conname  = 'memberships_status_check';


-- ============================================================================
-- ROLLBACK (only if you need to undo STEP 1 — run manually, not part of migrate)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_status_check;
--   DROP INDEX IF EXISTS public.memberships_stripe_subscription_id_key;
--   -- Only re-add NOT NULL if no NULL rows exist (gift memberships would block it):
--   ALTER TABLE public.memberships ALTER COLUMN stripe_customer_id SET NOT NULL;
-- COMMIT;
