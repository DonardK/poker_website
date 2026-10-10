-- Runtime login, append-only hand history, chip caps, lobby/session indexes,
-- and an RLS coverage check for every table created after poker_security.
--
-- Additive and safe on a live database: no backfill, no table rewrite. The
-- foreign-key changes take a short ACCESS EXCLUSIVE lock on "Hand" and
-- "HandPlayer" (drop and re-add the constraint; existing rows already satisfy
-- it). Indexes are created inside this transaction, not CONCURRENTLY, because
-- Prisma applies each migration in one transaction.
--
-- =============================================================================
-- OPERATOR (one time, after this migration). The password is NOT in this file.
-- Full steps: apps/server/prisma/RUNTIME_ROLE.md
--
--   ALTER ROLE poker_app PASSWORD 'choose-a-long-random-password';
--
-- Then point local docker / Neon Hyperdrive at poker_app.
-- The Supabase demo keeps poker_server (see the role block below).
-- Keep the administrator URL in DIRECT_URL for migrations only.
-- =============================================================================
--
-- Two runtime logins, chosen from the role that already exists
-- -------------------------------------------------------------
-- Local docker and a fresh Neon-style database: poker_security created
-- poker_server NOLOGIN. This migration creates poker_app LOGIN, INHERIT,
-- member of poker_server. Hyperdrive (or DATABASE_URL) uses poker_app.
-- The password is the ALTER ROLE above, never a statement in this file.
-- GRANT ... WITH INHERIT TRUE, SET TRUE needs PostgreSQL 16 (local docker).
--
-- Supabase demo (project tgfudufxslhrxbdxcnyl): poker_server is already a
-- LOGIN role and is the Hyperdrive user. Creating poker_app is not needed,
-- and requiring poker_server to be NOLOGIN would abort the migration.
-- This block leaves that LOGIN in place and does not create poker_app.
-- poker_server must still be NOSUPERUSER and NOBYPASSRLS. A role is a member
-- of itself, so the guards below match current_user = poker_server.
--
-- The migration role is not a true superuser on Neon (neondb_owner) or on
-- Supabase (postgres). This file does not CREATE EVENT TRIGGER. Extensions
-- are not required. 20260920141323_restrict_rls_event_trigger only REVOKEs
-- EXECUTE on public.rls_auto_enable() when that function exists.
--
-- If CREATE ROLE fails with insufficient_privilege on the NOLOGIN path,
-- create poker_app once (LOGIN, NOSUPERUSER, NOBYPASSRLS, INHERIT, no
-- password in git) and re-apply. The IF NOT EXISTS branch then only GRANTs.

-- ---------------------------------------------------------------------------
-- poker_app only when poker_server cannot log in. Supabase keeps poker_server.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  srv record;
  app record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcanlogin
    INTO srv FROM pg_roles WHERE rolname = 'poker_server';
  IF srv IS NULL THEN
    RAISE EXCEPTION 'runtime login: poker_server must exist';
  END IF;
  IF srv.rolsuper OR srv.rolbypassrls THEN
    RAISE EXCEPTION 'runtime login: poker_server must be NOSUPERUSER and NOBYPASSRLS';
  END IF;

  IF srv.rolcanlogin THEN
    RAISE NOTICE 'runtime login: poker_server is LOGIN; keeping it as the runtime role';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poker_app') THEN
    CREATE ROLE poker_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
  -- Re-assert attributes if docker init created the role first.
  -- This does not set or clear a password.
  ALTER ROLE poker_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
  -- PG16+. INHERIT TRUE makes poker_app use poker_server's grants and policies.
  -- SET TRUE lets a session SET ROLE poker_server (same privileges, no more).
  GRANT poker_server TO poker_app WITH INHERIT TRUE, SET TRUE;
  COMMENT ON ROLE poker_app IS 'Game-server login. Inherits poker_server. Password is set with ALTER ROLE, never in a migration.';

  SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb
    INTO app FROM pg_roles WHERE rolname = 'poker_app';
  IF app IS NULL THEN
    RAISE EXCEPTION 'runtime login: poker_app and poker_server must both exist';
  END IF;
  IF app.rolsuper OR app.rolbypassrls OR NOT app.rolcanlogin OR NOT app.rolinherit OR app.rolcreaterole OR app.rolcreatedb THEN
    RAISE EXCEPTION 'runtime login: poker_app must be LOGIN, INHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE';
  END IF;
  IF NOT pg_has_role('poker_app', 'poker_server', 'MEMBER') THEN
    RAISE EXCEPTION 'runtime login: poker_app is not a member of poker_server';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Guards that compared current_user to the literal 'poker_server' would not
-- fire for poker_app. Treat every non-superuser, non-BYPASSRLS member of
-- poker_server (including poker_server itself) as the runtime role.
-- Superusers are implicit members of every role, so rolsuper is excluded and
-- administrators can still change User.role / insert a legacy hand.
-- CREATE OR REPLACE keeps the existing ACL (PUBLIC already revoked).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_guard_privileged_columns() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS r
    WHERE r.rolname = current_user
      AND NOT r.rolsuper
      AND NOT r.rolbypassrls
      AND pg_catalog.pg_has_role(r.oid, 'poker_server', 'MEMBER')
  ) AND (NEW."role" IS DISTINCT FROM OLD."role" OR NEW."kind" IS DISTINCT FROM OLD."kind") THEN
    RAISE EXCEPTION USING ERRCODE = 'LG020', MESSAGE = 'USER_PRIVILEGE_CHANGE_FORBIDDEN: the runtime role cannot change User.role or User.kind';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.hand_require_audit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS r
    WHERE r.rolname = current_user
      AND NOT r.rolsuper
      AND NOT r.rolbypassrls
      AND pg_catalog.pg_has_role(r.oid, 'poker_server', 'MEMBER')
  ) AND (NEW."auditRecord" IS NULL OR NEW."auditSealed" IS NULL OR NEW."handUuid" IS NULL
      OR NEW."deckCommitment" IS NULL OR NEW."finalStateHash" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG021', MESSAGE = 'HAND_AUDIT_REQUIRED: hands must be recorded with the compliance audit trail';
  END IF;
  RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------------------
-- Append-only hand history for every role, not only via missing grants.
-- poker.break_glass = 'on' (transaction-local set_config(..., true)) is the
-- maintenance hatch. The ledger journal already refuses UPDATE/DELETE with
-- no hatch (ledger_refuse_mutation / LG016); LedgerAccount stays mutable
-- because ledger_post updates the cached balance. Do not weaken that.
-- Deleting "Hand" still cascades to HandPlayer / HandAction / HandPot; those
-- triggers see the same setting, so a break_glass delete removes the whole
-- hand. Deleting a Table or User cannot cascade into this history (RESTRICT).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.poker_refuse_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.current_setting('poker.break_glass', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = 'AP001',
      MESSAGE = format('APPEND_ONLY: %s rows cannot be updated or deleted unless poker.break_glass is on', TG_TABLE_NAME);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "Hand_append_only" BEFORE UPDATE OR DELETE ON public."Hand"
  FOR EACH ROW EXECUTE FUNCTION public.poker_refuse_history_mutation();
CREATE TRIGGER "HandPlayer_append_only" BEFORE UPDATE OR DELETE ON public."HandPlayer"
  FOR EACH ROW EXECUTE FUNCTION public.poker_refuse_history_mutation();
CREATE TRIGGER "HandAction_append_only" BEFORE UPDATE OR DELETE ON public."HandAction"
  FOR EACH ROW EXECUTE FUNCTION public.poker_refuse_history_mutation();
CREATE TRIGGER "HandPot_append_only" BEFORE UPDATE OR DELETE ON public."HandPot"
  FOR EACH ROW EXECUTE FUNCTION public.poker_refuse_history_mutation();

-- DropForeignKey / AddForeignKey (matches schema.prisma onDelete: Restrict).
-- Look the constraint up by column so a differently named foreign key is
-- still replaced. Existing rows must already satisfy RESTRICT (no dangling
-- Hand.tableId or HandPlayer.userId). NULL userId stays allowed.
DO $$
DECLARE
  con name;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'Hand' AND c.contype = 'f'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum = ANY (c.conkey) AND a.attname = 'tableId'
      )
  LOOP
    EXECUTE format('ALTER TABLE public."Hand" DROP CONSTRAINT %I', con);
  END LOOP;
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'HandPlayer' AND c.contype = 'f'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum = ANY (c.conkey) AND a.attname = 'userId'
      )
  LOOP
    EXECUTE format('ALTER TABLE public."HandPlayer" DROP CONSTRAINT %I', con);
  END LOOP;
END
$$;
ALTER TABLE "Hand" ADD CONSTRAINT "Hand_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandPlayer" ADD CONSTRAINT "HandPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
-- Lobby: public, non-closed tables, newest first (GET /api/tables).
-- Composite, not partial: Prisma 6 cannot model a WHERE index, and migrate
-- diff must match schema.prisma. (isPrivate, status, createdAt DESC) is the
-- prefix of that filter and its ORDER BY.
CREATE INDEX "Table_isPrivate_status_createdAt_idx" ON "Table"("isPrivate", "status", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- Chip amounts stay 32-bit INTEGER. Prisma BigInt becomes a TS bigint, which
-- does not survive JSON at the server/shared boundary, so the columns are not
-- widened. Caps sit safely below 2^31-1 (2147483647): 1000000000, so two of
-- them still add inside int4 (2000000000 < 2147483647). Nine seats at the
-- existing max buy-in (9 * 40000000 = 360000000) fit under the cap.
-- chipsWon is a cumulative counter and may be negative; its cap is 2000000000.
-- ---------------------------------------------------------------------------
ALTER TABLE public."User" ADD CONSTRAINT "User_bankroll_cap" CHECK (bankroll <= 1000000000);
ALTER TABLE public."TableSeat" ADD CONSTRAINT "TableSeat_stack_cap" CHECK (stack <= 1000000000);
ALTER TABLE public."Hand" ADD CONSTRAINT "Hand_amount_cap" CHECK ("potTotal" <= 1000000000 AND rake <= 1000000000);
ALTER TABLE public."HandPlayer" ADD CONSTRAINT "HandPlayer_stack_cap" CHECK (
  "startingStack" <= 1000000000 AND "endingStack" <= 1000000000 AND net BETWEEN -1000000000 AND 1000000000);
ALTER TABLE public."HandAction" ADD CONSTRAINT "HandAction_amount_cap" CHECK (
  amount <= 1000000000 AND ("toAmount" IS NULL OR "toAmount" <= 1000000000));
ALTER TABLE public."BotStatistic" ADD CONSTRAINT "BotStatistic_chipsWon_cap" CHECK ("chipsWon" BETWEEN -2000000000 AND 2000000000);

-- ---------------------------------------------------------------------------
-- RLS boilerplate for a table created after 20260920140611_poker_security.
-- Copy this for every new table, then SELECT public.poker_assert_rls().
-- Do not CREATE EVENT TRIGGER (see the Neon note at the top).
--
--   ALTER TABLE public."NewTable" ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE public."NewTable" FORCE ROW LEVEL SECURITY;
--   REVOKE ALL ON TABLE public."NewTable" FROM PUBLIC;
--   -- if anon exists: REVOKE ALL ON TABLE public."NewTable" FROM anon, authenticated, service_role;
--   REVOKE ALL ON TABLE public."NewTable" FROM poker_server;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."NewTable" TO poker_server; -- narrow this
--   CREATE POLICY server_only ON public."NewTable" TO poker_server USING (true) WITH CHECK (true);
--
-- The block below only touches a public table that is missing enabled+forced
-- RLS or a policy for poker_server (ledger and TableIncident already have
-- both). A table with no write grant gets SELECT only, so a repair cannot
-- widen the ledger.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  poker_server_oid oid;
  covered boolean;
  writable boolean;
BEGIN
  SELECT oid INTO poker_server_oid FROM pg_roles WHERE rolname = 'poker_server';
  IF poker_server_oid IS NULL THEN
    RAISE EXCEPTION 'RLS_COVERAGE: role poker_server does not exist';
  END IF;
  FOR r IN
    SELECT c.oid, c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
    ORDER BY c.relname
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = r.oid AND poker_server_oid = ANY (p.polroles)
    ) INTO covered;
    IF r.enabled AND r.forced AND covered THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', r.name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', r.name);
    END IF;
    IF NOT covered THEN
      IF EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = r.oid AND p.polname = 'server_only') THEN
        RAISE EXCEPTION 'RLS_COVERAGE: % has policy server_only that does not apply to poker_server', r.name;
      END IF;
      writable := has_table_privilege('poker_server', format('%I.%I', 'public', r.name), 'INSERT')
        OR has_table_privilege('poker_server', format('%I.%I', 'public', r.name), 'UPDATE')
        OR has_table_privilege('poker_server', format('%I.%I', 'public', r.name), 'DELETE');
      IF writable THEN
        EXECUTE format('CREATE POLICY server_only ON public.%I TO poker_server USING (true) WITH CHECK (true)', r.name);
      ELSE
        IF NOT has_table_privilege('poker_server', format('%I.%I', 'public', r.name), 'SELECT') THEN
          EXECUTE format('GRANT SELECT ON TABLE public.%I TO poker_server', r.name);
        END IF;
        EXECUTE format('CREATE POLICY server_only ON public.%I FOR SELECT TO poker_server USING (true)', r.name);
      END IF;
    END IF;
  END LOOP;
END
$$;

CREATE FUNCTION public.poker_assert_rls() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  missing text;
  poker_server_oid oid;
BEGIN
  SELECT oid INTO poker_server_oid FROM pg_roles WHERE rolname = 'poker_server';
  SELECT string_agg(format('%I (rls=%s, forced=%s)', c.relname, c.relrowsecurity, c.relforcerowsecurity), ', ' ORDER BY c.relname)
    INTO missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> '_prisma_migrations'
    AND (
      NOT c.relrowsecurity
      OR NOT c.relforcerowsecurity
      OR NOT EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = c.oid AND poker_server_oid = ANY (p.polroles)
      )
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'RL001',
      MESSAGE = format('RLS_COVERAGE: public tables missing enabled+forced RLS or a poker_server policy: %s. Use the boilerplate in 20261010120000_runtime_hardening, then SELECT public.poker_assert_rls().', missing);
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.poker_refuse_history_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.poker_assert_rls() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.poker_refuse_history_mutation() FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON FUNCTION public.poker_assert_rls() FROM anon, authenticated, service_role';
  END IF;
END
$$;
-- The migration role is not always a superuser (Neon). PUBLIC execute was
-- revoked, so grant it back to the role that applies migrations. poker_app
-- does not need it: triggers do not require EXECUTE of the invoker, and the
-- assert is for migrations.
GRANT EXECUTE ON FUNCTION public.poker_assert_rls() TO CURRENT_USER;
SELECT public.poker_assert_rls();
