-- Account security: email verification and password reset, TOTP and backup
-- codes, passkeys, known devices and sign-in alerts, step-up (the session
-- window for account changes and single-use grants for money actions),
-- security events, and retirement of guest sessions.
--
-- Additive and safe on a live database: new columns are nullable or have a
-- constant default (no table rewrite on PostgreSQL 11+), new tables start
-- empty. The only data change is revoking live guest sessions (owner
-- decision 2026-10-19: no guest play). Guest User rows are kept because hand
-- history references them (RESTRICT).
--
-- Grants follow 20261010130000_game_command: RLS enabled and forced, nothing
-- for PUBLIC or the Supabase roles, narrow grants for poker_server, a
-- server_only policy, then poker_assert_rls(). Column-level UPDATE grants
-- follow 20261007200000_table_incident_column_grants. The runtime role can
-- never rewrite a stored TOTP secret, passkey public key, token hash or code
-- hash, and it can mint a StepUpGrant but never consume, change or delete one.
--
-- poker_payments does not exist yet, so nothing is granted to it here. The
-- wallet migration (20261019120000_payments_wallet) creates that role and
-- grants it SELECT plus UPDATE ("consumedAt") on "StepUpGrant" with its own
-- policy, and SELECT on "AccountSecurityEvent" (design-wallet calls it
-- SecurityEvent, with "kind" for "type").
--
-- Supabase rls_auto_enable(): see 20261010130000_game_command.

DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO %I', current_user);
  EXCEPTION
    WHEN insufficient_privilege OR undefined_object THEN
      RAISE NOTICE 'rls_auto_enable: leaving execute grants unchanged (%)', SQLERRM;
  END;
END
$$;

-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('VERIFY_EMAIL', 'PASSWORD_RESET', 'EMAIL_CHANGE', 'SECURITY_LOCKDOWN');

-- AlterTable User (inherits RLS, policy and grants from 20260920140611_poker_security)
ALTER TABLE public."User"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "credentialsVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
  ADD COLUMN "passwordResetRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfaFailedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mfaLockedUntil" TIMESTAMP(3),
  ADD COLUMN "securityHoldUntil" TIMESTAMP(3),
  ADD COLUMN "webauthnUserId" TEXT;
CREATE UNIQUE INDEX "User_webauthnUserId_key" ON public."User"("webauthnUserId");
ALTER TABLE public."User" ADD CONSTRAINT "User_security_valid" CHECK (
  "credentialsVersion" >= 0 AND "mfaFailedCount" >= 0
  AND ("webauthnUserId" IS NULL OR "webauthnUserId" ~ '^[A-Za-z0-9_-]{43}$'));

-- AlterTable Session (inherits RLS, policy and grants)
ALTER TABLE public."Session"
  ADD COLUMN "deviceId" TEXT,
  ADD COLUMN "persistent" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "authMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "reauthAt" TIMESTAMP(3),
  ADD COLUMN "reauthMethods" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE public."Session" ADD CONSTRAINT "Session_auth_methods_valid" CHECK (
  "authMethods" <@ ARRAY['pwd', 'otp', 'backup', 'passkey']::TEXT[]
  AND "reauthMethods" <@ ARRAY['pwd', 'otp', 'backup', 'passkey']::TEXT[]);

-- CreateTable
CREATE TABLE public."KnownDevice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceHash" TEXT NOT NULL,
  "label" TEXT,
  "userAgent" TEXT,
  "lastIp" TEXT,
  "country" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnownDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnownDevice_valid" CHECK (
    "deviceHash" ~ '^[0-9a-f]{64}$'
    AND ("label" IS NULL OR length("label") BETWEEN 1 AND 64)
    AND ("userAgent" IS NULL OR length("userAgent") <= 256)
    AND ("lastIp" IS NULL OR length("lastIp") <= 64)
    AND ("country" IS NULL OR "country" ~ '^[A-Z0-9]{2}$'))
);
CREATE UNIQUE INDEX "KnownDevice_userId_deviceHash_key" ON public."KnownDevice"("userId", "deviceHash");

CREATE TABLE public."UserTotp" (
  "userId" TEXT NOT NULL,
  "secretCiphertext" TEXT NOT NULL,
  "enabledAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "lastUsedStep" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserTotp_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "UserTotp_valid" CHECK (
    "secretCiphertext" ~ '^v2\.' AND length("secretCiphertext") <= 512
    AND "lastUsedStep" >= 0
    AND ("disabledAt" IS NULL OR "enabledAt" IS NOT NULL))
);

CREATE TABLE public."UserBackupCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserBackupCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserBackupCode_valid" CHECK ("codeHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "UserBackupCode_userId_codeHash_key" ON public."UserBackupCode"("userId", "codeHash");

CREATE TABLE public."WebAuthnCredential" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "deviceType" TEXT NOT NULL,
  "backedUp" BOOLEAN NOT NULL DEFAULT false,
  "aaguid" TEXT,
  "rpId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "removedAt" TIMESTAMP(3),
  CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id"),
  -- base64url text. PostgreSQL regex repetition counts stop at 255, so the
  -- lengths are separate checks (a credential id is at most 1023 bytes).
  CONSTRAINT "WebAuthnCredential_valid" CHECK (
    "credentialId" ~ '^[A-Za-z0-9_-]+$' AND length("credentialId") BETWEEN 16 AND 1366
    AND "publicKey" ~ '^[A-Za-z0-9_-]+$' AND length("publicKey") BETWEEN 16 AND 2048
    AND "counter" BETWEEN 0 AND 4294967295
    AND "deviceType" IN ('singleDevice', 'multiDevice')
    AND cardinality("transports") <= 8
    AND ("aaguid" IS NULL OR "aaguid" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND length("rpId") BETWEEN 1 AND 253
    AND length("name") BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON public."WebAuthnCredential"("credentialId");
CREATE INDEX "WebAuthnCredential_userId_idx" ON public."WebAuthnCredential"("userId");

CREATE TABLE public."EmailToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "purpose" "EmailTokenPurpose" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "credentialsVersion" INTEGER NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailToken_valid" CHECK (
    "tokenHash" ~ '^[0-9a-f]{64}$'
    AND length("email") BETWEEN 3 AND 254
    AND "credentialsVersion" >= 0
    AND jsonb_typeof("data") = 'object' AND octet_length("data"::text) <= 4096
    AND "expiresAt" > "createdAt"
    AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt"))
);
CREATE UNIQUE INDEX "EmailToken_tokenHash_key" ON public."EmailToken"("tokenHash");
CREATE INDEX "EmailToken_userId_purpose_createdAt_idx" ON public."EmailToken"("userId", "purpose", "createdAt");
CREATE INDEX "EmailToken_expiresAt_idx" ON public."EmailToken"("expiresAt");

CREATE TABLE public."AuthNonce" (
  "id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthNonce_valid" CHECK (length("id") BETWEEN 8 AND 128 AND "purpose" ~ '^[a-z_:]{1,32}$')
);
CREATE INDEX "AuthNonce_expiresAt_idx" ON public."AuthNonce"("expiresAt");

CREATE TABLE public."AccountSecurityEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "sessionId" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "country" TEXT,
  "data" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountSecurityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountSecurityEvent_valid" CHECK (
    "type" ~ '^[A-Z][A-Z0-9_]{1,63}$'
    AND ("sessionId" IS NULL OR length("sessionId") BETWEEN 1 AND 64)
    AND ("ip" IS NULL OR length("ip") <= 64)
    AND ("userAgent" IS NULL OR length("userAgent") <= 256)
    AND ("country" IS NULL OR "country" ~ '^[A-Z0-9]{2}$')
    AND jsonb_typeof("data") = 'object' AND octet_length("data"::text) <= 4096)
);
CREATE INDEX "AccountSecurityEvent_userId_createdAt_idx" ON public."AccountSecurityEvent"("userId", "createdAt");

-- Money step-up (docs/money/WALLET.md). purpose and method are the wire
-- values the payments Worker matches literally ('withdrawal', 'PASSKEY', ...).
-- PASSWORD alone never authorises money (every purpose below is a money
-- purpose); it stays in the vocabulary for a later non-money purpose. Admin
-- payment decisions need a passkey. The issuer writes createdAt and expiresAt
-- from one clock reading, so the lifetime bound never compares two clocks.
CREATE TABLE public."StepUpGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "bindHash" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "StepUpGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StepUpGrant_valid" CHECK (
    "purpose" IN ('withdrawal', 'payout_destination', 'admin_payments')
    AND "method" IN ('PASSKEY', 'TOTP', 'PASSWORD_EMAIL', 'PASSWORD')
    AND "bindHash" ~ '^[0-9a-f]{64}$'
    AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '5 minutes'),
  CONSTRAINT "StepUpGrant_method_strength" CHECK (
    ("method" <> 'PASSWORD' OR "purpose" NOT IN ('withdrawal', 'payout_destination', 'admin_payments'))
    AND ("purpose" <> 'admin_payments' OR "method" = 'PASSKEY'))
);
CREATE INDEX "StepUpGrant_userId_createdAt_idx" ON public."StepUpGrant"("userId", "createdAt");
CREATE INDEX "StepUpGrant_sessionId_idx" ON public."StepUpGrant"("sessionId");
CREATE INDEX "StepUpGrant_expiresAt_idx" ON public."StepUpGrant"("expiresAt");

-- The emailed code of a password + email step-up (users with neither TOTP nor
-- a passkey): 6 digits, 10 minutes, 5 tries. codeHash is an HMAC under
-- AUTH_HMAC_SECRET, so a database copy alone cannot brute-force the code.
CREATE TABLE public."StepUpEmailChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "bindHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "StepUpEmailChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StepUpEmailChallenge_valid" CHECK (
    "purpose" IN ('withdrawal', 'payout_destination')
    AND "bindHash" ~ '^[0-9a-f]{64}$'
    AND "codeHash" ~ '^[0-9a-f]{64}$'
    AND length("email") BETWEEN 3 AND 254
    AND "attempts" BETWEEN 0 AND 5
    AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '10 minutes')
);
CREATE INDEX "StepUpEmailChallenge_userId_createdAt_idx" ON public."StepUpEmailChallenge"("userId", "createdAt");
CREATE INDEX "StepUpEmailChallenge_sessionId_idx" ON public."StepUpEmailChallenge"("sessionId");
CREATE INDEX "StepUpEmailChallenge_expiresAt_idx" ON public."StepUpEmailChallenge"("expiresAt");

-- CreateIndex / AddForeignKey
CREATE INDEX "Session_deviceId_idx" ON public."Session"("deviceId");
ALTER TABLE public."Session" ADD CONSTRAINT "Session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES public."KnownDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."KnownDevice" ADD CONSTRAINT "KnownDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."UserTotp" ADD CONSTRAINT "UserTotp_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."UserBackupCode" ADD CONSTRAINT "UserBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."AccountSecurityEvent" ADD CONSTRAINT "AccountSecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."StepUpGrant" ADD CONSTRAINT "StepUpGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."StepUpGrant" ADD CONSTRAINT "StepUpGrant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."StepUpEmailChallenge" ADD CONSTRAINT "StepUpEmailChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."StepUpEmailChallenge" ADD CONSTRAINT "StepUpEmailChallenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security and grants (the boilerplate of 20261010120000_runtime_hardening).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['KnownDevice', 'UserTotp', 'UserBackupCode', 'WebAuthnCredential', 'EmailToken',
                           'AuthNonce', 'AccountSecurityEvent', 'StepUpGrant', 'StepUpEmailChallenge'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    -- Supabase roles do not exist on plain local Postgres.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', t);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM poker_server', t);
    EXECUTE format('CREATE POLICY server_only ON public.%I TO poker_server USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;
GRANT SELECT, INSERT, DELETE ON TABLE public."KnownDevice" TO poker_server;
GRANT UPDATE ("label", "userAgent", "lastIp", "country", "lastSeenAt") ON TABLE public."KnownDevice" TO poker_server;
GRANT SELECT, INSERT, DELETE ON TABLE public."UserTotp" TO poker_server;
GRANT UPDATE ("enabledAt", "disabledAt", "lastUsedStep") ON TABLE public."UserTotp" TO poker_server;
GRANT SELECT, INSERT, DELETE ON TABLE public."UserBackupCode" TO poker_server;
GRANT UPDATE ("usedAt") ON TABLE public."UserBackupCode" TO poker_server;
GRANT SELECT, INSERT, DELETE ON TABLE public."WebAuthnCredential" TO poker_server;
GRANT UPDATE ("counter", "lastUsedAt", "name", "backedUp", "deviceType", "removedAt") ON TABLE public."WebAuthnCredential" TO poker_server;
GRANT SELECT, INSERT, DELETE ON TABLE public."EmailToken" TO poker_server;
GRANT UPDATE ("consumedAt") ON TABLE public."EmailToken" TO poker_server;
GRANT SELECT, INSERT, DELETE ON TABLE public."AuthNonce" TO poker_server;
GRANT SELECT, INSERT ON TABLE public."AccountSecurityEvent" TO poker_server;
-- The API mints grants; only the payments Worker consumes them (wallet migration).
GRANT SELECT, INSERT ON TABLE public."StepUpGrant" TO poker_server;
GRANT SELECT, INSERT, DELETE ON TABLE public."StepUpEmailChallenge" TO poker_server;
GRANT UPDATE ("attempts", "consumedAt") ON TABLE public."StepUpEmailChallenge" TO poker_server;

-- Security history is append-only for every role (same hatch as hand history).
CREATE TRIGGER "AccountSecurityEvent_append_only" BEFORE UPDATE OR DELETE ON public."AccountSecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION public.poker_refuse_history_mutation();

-- A grant is consumed once, before it expires, and nothing else about it ever
-- changes, whichever role holds UPDATE ("consumedAt"). A consumer's
-- UPDATE ... WHERE "consumedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP
-- matches no row for a used or expired grant, so this only fires on misuse.
-- Expiry is judged by the database clock, not by the consumedAt the caller
-- writes, and that value must be the time of use (give or take 5 minutes).
-- poker.break_glass = 'on' is the maintenance hatch, as for hand history,
-- but only for an administrator (superuser or BYPASSRLS, as the migration
-- role is): any role can set a custom setting like poker.break_glass.
CREATE FUNCTION public.step_up_grant_single_use() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.current_setting('poker.break_glass', true) IS NOT DISTINCT FROM 'on'
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RETURN NEW;
  END IF;
  IF OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL
     OR OLD."expiresAt" <= pg_catalog.statement_timestamp()
     OR NEW."consumedAt" >= OLD."expiresAt"
     OR NEW."consumedAt" < pg_catalog.statement_timestamp() - interval '5 minutes'
     OR NEW."consumedAt" > pg_catalog.statement_timestamp() + interval '5 minutes'
     OR ROW(NEW."id", NEW."userId", NEW."sessionId", NEW."purpose", NEW."bindHash", NEW."method", NEW."createdAt", NEW."expiresAt")
        IS DISTINCT FROM ROW(OLD."id", OLD."userId", OLD."sessionId", OLD."purpose", OLD."bindHash", OLD."method", OLD."createdAt", OLD."expiresAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'SU001',
      MESSAGE = 'STEP_UP_GRANT_SINGLE_USE: a step-up grant is consumed once, before it expires, and never changed otherwise';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.step_up_grant_single_use() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.step_up_grant_single_use() FROM anon, authenticated, service_role';
  END IF;
END
$$;
CREATE TRIGGER "StepUpGrant_single_use" BEFORE UPDATE ON public."StepUpGrant"
  FOR EACH ROW EXECUTE FUNCTION public.step_up_grant_single_use();

-- Guest play is retired: end every guest session that is not already ended.
-- The edge also refuses guests at authenticate, refresh and both socket
-- checks (GUEST_RETIRED). row_security = off makes this UPDATE fail loudly,
-- instead of silently matching no rows, if the migration role were subject
-- to the forced RLS on "Session" (apply with the administrator DIRECT_URL).
SET LOCAL row_security = off;
UPDATE public."Session" AS s
SET "revokedAt" = CURRENT_TIMESTAMP, "revokeReason" = 'GUEST_RETIRED'
FROM public."User" AS u
WHERE s."userId" = u."id" AND u."isGuest" = true AND s."revokedAt" IS NULL;
RESET row_security;

SELECT public.poker_assert_rls();
