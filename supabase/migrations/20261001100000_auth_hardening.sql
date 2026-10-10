-- Auth hardening: case-insensitive usernames, per-account login lockout,
-- terms/age acceptance, bounded session lifetime, refresh-token reuse
-- detection and revocation that keeps the row. Additive and safe on a live
-- database: every new column has a default or is backfilled here, and the
-- one check that can fail (case-duplicate usernames) fails before any change.
-- User and Session already have RLS enabled + forced, no PUBLIC/Supabase-role
-- access and the poker_server server_only policy (20260920140611_poker_security);
-- new columns inherit those table-level protections. No new tables.

-- Usernames are unique case-insensitively. Refuse loudly (no partial
-- migration: Prisma runs each migration in one transaction) if existing rows
-- differ only by case; an operator must rename them first.
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(canonical, ', ') INTO dup FROM (
    SELECT lower(username) AS canonical FROM public."User" GROUP BY lower(username) HAVING count(*) > 1 LIMIT 20
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'auth_hardening: usernames differing only by case exist (%); rename them before applying this migration', dup;
  END IF;
END $$;
-- A STORED generated column: Postgres backfills every existing row while adding
-- it and keeps it equal to lower(username) on every insert/update, whoever writes.
ALTER TABLE public."User" ADD COLUMN "usernameCanonical" TEXT GENERATED ALWAYS AS (lower(username)) STORED NOT NULL;
CREATE UNIQUE INDEX "User_usernameCanonical_key" ON public."User" ("usernameCanonical");

-- Per-account login throttling (independent of the client IP).
ALTER TABLE public."User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public."User" ADD COLUMN "lockedUntil" TIMESTAMP(3);
ALTER TABLE public."User" ADD CONSTRAINT "User_failedLoginCount_nonnegative" CHECK ("failedLoginCount" >= 0);

-- Terms / age acceptance (existing accounts have none recorded: NULL).
ALTER TABLE public."User" ADD COLUMN "termsVersion" TEXT;
ALTER TABLE public."User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE public."User" ADD COLUMN "ageConfirmedAt" TIMESTAMP(3);

-- Session lifetime, rotation and revocation.
ALTER TABLE public."Session" ADD COLUMN "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE public."Session" ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3);
-- Existing sessions (guests have no password: losing the session loses the
-- account) get at least the usual 7 idle days from now, and never less than
-- the 30-day absolute lifetime counted from their creation.
UPDATE public."Session" SET "absoluteExpiresAt" = GREATEST("createdAt" + interval '30 days', now() + interval '7 days');
ALTER TABLE public."Session" ALTER COLUMN "absoluteExpiresAt" SET NOT NULL;
-- Rolling-deploy safety: a server still running the previous release inserts
-- sessions without this column; the default keeps those inserts working (and
-- bounded to the 30-day absolute lifetime). The new code always sets it.
ALTER TABLE public."Session" ALTER COLUMN "absoluteExpiresAt" SET DEFAULT (CURRENT_TIMESTAMP + interval '30 days');
ALTER TABLE public."Session" ADD COLUMN "previousTokenHash" TEXT;
ALTER TABLE public."Session" ADD COLUMN "rotatedAt" TIMESTAMP(3);
ALTER TABLE public."Session" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE public."Session" ADD COLUMN "revokeReason" TEXT;
ALTER TABLE public."Session" ADD CONSTRAINT "Session_revocation_consistent" CHECK (("revokedAt" IS NULL) = ("revokeReason" IS NULL));
