-- ============================================================================
-- Migration: make memberships.stripe_subscription_id upsert-able via PostgREST
-- Date: 2026-09-07 (follow-up to 20260907_stripe_port_membership_schema.sql)
-- Branch: feature/redo-stripe
--
-- WHY: the previous migration created `memberships_stripe_subscription_id_key`
-- as a PARTIAL unique index:
--     CREATE UNIQUE INDEX ... ON memberships (stripe_subscription_id)
--       WHERE stripe_subscription_id IS NOT NULL;
--
-- The Stripe webhook writes the subscription row with supabase-js:
--     .upsert(row, { onConflict: 'stripe_subscription_id' })
-- which PostgREST turns into:
--     INSERT INTO memberships (...) VALUES (...)
--     ON CONFLICT (stripe_subscription_id) DO UPDATE SET ...
-- with NO `WHERE` predicate. Postgres will only choose a *partial* index as the
-- ON CONFLICT arbiter when the statement's `ON CONFLICT ... WHERE` matches the
-- index predicate. With no predicate it cannot, and raises:
--     42P10  there is no unique or exclusion constraint matching the
--            ON CONFLICT specification
--
-- FIX: replace the partial index with a PLAIN unique index on the same column,
-- same name. A standard btree unique index treats NULLs as DISTINCT (that is the
-- default; we do NOT use NULLS NOT DISTINCT), so gift-membership rows with
-- stripe_subscription_id = NULL remain completely unconstrained -- unlimited
-- NULLs are still allowed. Data guarantees are identical to the partial index;
-- the only change is that ON CONFLICT inference now works.
--
-- STATUS: APPLIED 2026-09-07 by the project owner (Supabase SQL editor).
--   STEP 2 verified: CREATE UNIQUE INDEX memberships_stripe_subscription_id_key
--   ON public.memberships USING btree (stripe_subscription_id)  -- no WHERE.
-- HOW TO RUN: Supabase SQL editor, or
--   psql "$SUPABASE_DB_URL" -f delicate-term-de7d/migrations/20260907_02_stripe_subscription_id_plain_unique.sql
-- STEP 1 is atomic. STEP 2 is read-only verification. Rollback at the bottom.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — pre-flight (READ-ONLY). Expect: one row, indexdef CONTAINS
-- "WHERE (stripe_subscription_id IS NOT NULL)"  (the partial form to be fixed).
-- Also expect zero duplicate non-null values (the plain index needs this too).
-- ----------------------------------------------------------------------------
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public' AND tablename = 'memberships'
  AND  indexname = 'memberships_stripe_subscription_id_key';

SELECT stripe_subscription_id, count(*) AS n
FROM   public.memberships
WHERE  stripe_subscription_id IS NOT NULL
GROUP  BY stripe_subscription_id
HAVING count(*) > 1;   -- expect zero rows


-- ----------------------------------------------------------------------------
-- STEP 1 — swap partial -> plain unique index. Atomic.
-- ----------------------------------------------------------------------------
BEGIN;

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS public.memberships_stripe_subscription_id_key;

CREATE UNIQUE INDEX memberships_stripe_subscription_id_key
  ON public.memberships (stripe_subscription_id);

COMMIT;


-- ----------------------------------------------------------------------------
-- STEP 2 — verification (READ-ONLY). Expect:
--   * one row, indexdef has NO "WHERE" clause
-- ----------------------------------------------------------------------------
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public' AND tablename = 'memberships'
  AND  indexname = 'memberships_stripe_subscription_id_key';

-- Optional functional check (safe: inserts then deletes a throwaway row).
-- The second run must UPDATE, not raise 42P10.
--   INSERT INTO public.memberships
--     (user_id, stripe_customer_id, stripe_subscription_id, plan, status,
--      cancel_at_period_end, updated_at)
--   VALUES ('00000000-0000-0000-0000-000000000000', 'cus_test',
--           'sub_test_upsert', 'supporting', 'active', false, now())
--   ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = 'past_due';
--   -- run the INSERT above a second time; it must succeed as an UPDATE
--   DELETE FROM public.memberships WHERE stripe_subscription_id = 'sub_test_upsert';


-- ============================================================================
-- ROLLBACK (restore the partial index; run manually)
-- ============================================================================
-- BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP INDEX IF EXISTS public.memberships_stripe_subscription_id_key;
--   CREATE UNIQUE INDEX memberships_stripe_subscription_id_key
--     ON public.memberships (stripe_subscription_id)
--     WHERE stripe_subscription_id IS NOT NULL;
-- COMMIT;
