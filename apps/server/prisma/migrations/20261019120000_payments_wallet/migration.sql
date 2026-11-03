-- Real-money wallet (docs/money/WALLET.md, docs/money/LEDGER.md section 10).
-- Additive: roles, enums, tables, triggers, ledger entry points and the email
-- outbox. ledger_post keeps its signature and ACL but now accepts only the
-- runtime types (PLAY_GRANT, BUY_IN, CASH_OUT, RAKE), and only in PLAY assets
-- (real-money tables are Phase 2): the game API's login can never move
-- payment money. No existing row is read or changed; the only rows written
-- are the TEST_EUR asset (sandbox money) and the PaymentSwitch seeds. Real
-- money stays off: Asset EUR stays disabled and every PaymentSwitch row is
-- seeded false.
--
-- Locks: the file is one transaction and takes short ACCESS EXCLUSIVE locks
-- on live tables (CREATE POLICY on "User", "Session", the ledger tables).
-- lock_timeout makes it fail fast and roll back completely instead of
-- queueing logins behind a long-running transaction; recovery is in
-- docs/cloudflare/DEPLOY.md ("Deploying the wallet migration").
--
-- =============================================================================
-- OPERATOR (once per environment, after this migration). No password is in
-- this file. Full steps: apps/server/prisma/RUNTIME_ROLE.md
--
--   ALTER ROLE poker_payments_app PASSWORD '<long random>';    -- the payments Worker (its own Hyperdrive)
--   ALTER ROLE poker_backoffice_app PASSWORD '<long random>';  -- the operator's machine only, never a Worker
--
-- Until then neither login can connect. Supabase: session pooler user
-- poker_payments_app.<ref>, port 5432, Hyperdrive caching disabled.
-- =============================================================================
--
-- Roles: one shape on Supabase, Neon and local docker. The NOLOGIN groups
-- poker_payments and poker_backoffice hold the grants and policies; the LOGIN
-- roles poker_payments_app and poker_backoffice_app (INHERIT) use them. A role
-- that already exists is checked, never altered: on Supabase the migration
-- role is not a superuser, and PostgreSQL 16+ refuses ALTER ROLE ...
-- NOSUPERUSER / NOBYPASSRLS / NOREPLICATION from a non-superuser even when
-- nothing changes. No login may belong to more than one of poker_server,
-- poker_payments and poker_backoffice. Guards compare role membership, not
-- names (as 20261010120000_runtime_hardening does). If CREATE ROLE fails with
-- insufficient_privilege, create the four roles once by hand with the
-- attributes below (no password in git) and re-apply.
--
-- Timestamps: TIMESTAMP(3) columns hold UTC (Prisma writes UTC). The two
-- logins get timezone UTC, and every guard trigger below runs with
-- timezone UTC (SET on the function), so CURRENT_TIMESTAMP agrees with what
-- the Workers write whichever login fires it (the runtime writes deposit
-- limits and self-exclusions) and wherever a server default is not UTC.
--
-- SQLSTATEs (docs/money/LEDGER.md section 11): LG022 LEDGER_TYPE_FORBIDDEN,
-- LG023 LEDGER_UNBOUND_PAYMENT; PM001 PAYMENT_IMMUTABLE, PM002
-- PAYMENT_IMMUTABLE_FIELD, PM003 PAYMENT_BAD_TRANSITION, PM004
-- PAYMENT_APPROVAL_REQUIRED, PM005 PAYMENT_DUPLICATE_INSTRUMENT, PM006
-- PAYMENT_MISMATCH, PM007 RG_RULE, PM008 PAYMENT_SECURITY_HOLD, PM009
-- PAYMENT_STEP_UP_REQUIRED, PM010 PAYMENT_INSTRUMENT_UNAVAILABLE.
--
-- Sandbox money: asset TEST_EUR (kind TEST). A provider key is the sandbox
-- when it matches ^sandbox([-_.:]|$) ("sandbox", "sandbox-card", ...). The
-- database keeps the two worlds apart: the sandbox's ledger accounts,
-- deposits, quotes, withdrawals and card instruments are in a TEST asset, and
-- a real provider's never are. A preview that ever shared this database could
-- not touch a real balance, and no real rail can pay out TEST_EUR.
--
-- poker.break_glass = 'on' (transaction-local) lets an administrator
-- (superuser or BYPASSRLS) delete payments rows, as for hand history; any
-- role can set the variable, so the role is checked too.

-- 0. Preconditions ------------------------------------------------------------
-- A plain SET: it is undone if this file fails, and prisma migrate deploy
-- closes its connection when the deploy ends.
SET lock_timeout = '10s';

DO $$
DECLARE
  v_owner oid;
  srv record;
BEGIN
  SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = 'public.ledger_post(text, text, jsonb, jsonb, text)'::regprocedure;
  IF v_owner IS DISTINCT FROM (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'payments wallet: apply this migration as the owner of public.ledger_post (the role that applied 20261002200000_ledger_foundation)';
  END IF;
  IF to_regclass('public."StepUpGrant"') IS NULL OR to_regclass('public."AccountSecurityEvent"') IS NULL THEN
    RAISE EXCEPTION 'payments wallet: apply 20261019100000_account_security (StepUpGrant, AccountSecurityEvent) first';
  END IF;
  IF to_regclass('public."EmailOutbox"') IS NOT NULL THEN
    RAISE EXCEPTION 'payments wallet: public."EmailOutbox" already exists; this migration creates it';
  END IF;
  SELECT r.rolsuper, r.rolbypassrls INTO srv FROM pg_roles r WHERE r.rolname = 'poker_server';
  IF NOT FOUND OR srv.rolsuper OR srv.rolbypassrls THEN
    RAISE EXCEPTION 'payments wallet: poker_server must exist, NOSUPERUSER and NOBYPASSRLS';
  END IF;
  -- Fail closed instead of rewriting anything: no provider account may
  -- already mix a test asset with a real provider, or the reverse.
  IF EXISTS (SELECT 1 FROM public."LedgerAccount" a JOIN public."Asset" s ON s."code" = a."assetCode"
              WHERE a."providerKey" IS NOT NULL
                AND (s."kind"::text = 'TEST') IS DISTINCT FROM (a."providerKey" ~ '^sandbox([-_.:]|$)')) THEN
    RAISE EXCEPTION 'payments wallet: a provider ledger account mixes sandbox and real money; resolve it before applying';
  END IF;
END
$$;

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

-- 1. Roles --------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poker_payments') THEN
    CREATE ROLE poker_payments NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poker_backoffice') THEN
    CREATE ROLE poker_backoffice NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poker_payments_app') THEN
    CREATE ROLE poker_payments_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poker_backoffice_app') THEN
    CREATE ROLE poker_backoffice_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
  -- Checked, not altered (see the header).
  FOR r IN SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit
             FROM pg_roles WHERE rolname IN ('poker_payments', 'poker_backoffice', 'poker_payments_app', 'poker_backoffice_app') LOOP
    IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
      RAISE EXCEPTION 'payments roles: % must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION', r.rolname;
    END IF;
    IF r.rolname IN ('poker_payments', 'poker_backoffice') AND r.rolcanlogin THEN
      RAISE EXCEPTION 'payments roles: % must be NOLOGIN; the login is %_app (apps/server/prisma/RUNTIME_ROLE.md)', r.rolname, r.rolname;
    END IF;
    IF r.rolname IN ('poker_payments_app', 'poker_backoffice_app') AND NOT (r.rolcanlogin AND r.rolinherit) THEN
      RAISE EXCEPTION 'payments roles: % must be LOGIN INHERIT', r.rolname;
    END IF;
  END LOOP;
  GRANT poker_payments TO poker_payments_app;
  GRANT poker_backoffice TO poker_backoffice_app;
  -- Session default only; a refusal (roles created by another administrator) is harmless where the server default is UTC.
  BEGIN
    ALTER ROLE poker_payments_app SET timezone TO 'UTC';
    ALTER ROLE poker_backoffice_app SET timezone TO 'UTC';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'payments roles: could not set timezone UTC on the logins (%)', SQLERRM;
  END;
  FOR r IN SELECT rolname FROM pg_roles
            WHERE rolname IN ('poker_server', 'poker_app', 'poker_payments', 'poker_backoffice', 'poker_payments_app', 'poker_backoffice_app') LOOP
    IF (pg_has_role(r.rolname, 'poker_server', 'MEMBER')::int + pg_has_role(r.rolname, 'poker_payments', 'MEMBER')::int
        + pg_has_role(r.rolname, 'poker_backoffice', 'MEMBER')::int) > 1 THEN
      RAISE EXCEPTION 'payments roles: % holds more than one of poker_server, poker_payments, poker_backoffice', r.rolname;
    END IF;
  END LOOP;
  IF NOT pg_has_role('poker_payments_app', 'poker_payments', 'USAGE') OR NOT pg_has_role('poker_backoffice_app', 'poker_backoffice', 'USAGE') THEN
    RAISE EXCEPTION 'payments roles: the logins do not inherit their group roles';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO poker_payments, poker_backoffice;

-- The single-use trigger of 20261019100000_account_security compares
-- "expiresAt" (UTC, no time zone) with statement_timestamp(): pin UTC so a
-- session in another time zone can neither stretch nor shorten a grant's life.
-- (The payments Worker also pins UTC in every money transaction.)
DO $$
BEGIN
  IF (SELECT p.proowner FROM pg_proc p WHERE p.oid = 'public.step_up_grant_single_use()'::regprocedure)
     = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) THEN
    ALTER FUNCTION public.step_up_grant_single_use() SET timezone = 'UTC';
  ELSE
    RAISE NOTICE 'step_up_grant_single_use: not the owner, timezone left unpinned (the payments Worker pins UTC per transaction)';
  END IF;
END
$$;

-- 2. Enums --------------------------------------------------------------------
CREATE TYPE "KycStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE "ScreeningStatus" AS ENUM ('NOT_SCREENED', 'CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH');
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "SourceOfFundsStatus" AS ENUM ('NOT_REQUIRED', 'REQUESTED', 'SUBMITTED', 'APPROVED', 'REJECTED');
CREATE TYPE "PaymentsRestriction" AS ENUM ('NONE', 'DEPOSITS_BLOCKED', 'WITHDRAWALS_MANUAL', 'FROZEN');
CREATE TYPE "RgLimitKind" AS ENUM ('DEPOSIT');
CREATE TYPE "RgLimitPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH');
CREATE TYPE "RgSource" AS ENUM ('PLAYER', 'OPERATOR');
CREATE TYPE "SelfExclusionKind" AS ENUM ('DEFINITE', 'INDEFINITE');
CREATE TYPE "PaymentMethodKind" AS ENUM ('CARD', 'CRYPTO');
CREATE TYPE "InstrumentKind" AS ENUM ('CARD_TOKEN', 'CRYPTO_ADDRESS');
CREATE TYPE "InstrumentStatus" AS ENUM ('ACTIVE', 'REVOKED', 'BLOCKED');
CREATE TYPE "InstrumentOrigin" AS ENUM ('DEPOSIT', 'PLAYER', 'OPERATOR');
CREATE TYPE "DepositStatus" AS ENUM ('CREATED', 'PENDING', 'CONFIRMED', 'CREDITED', 'NEEDS_REVIEW', 'FAILED',
  'EXPIRED', 'CANCELLED', 'PARTIALLY_REVERSED', 'REVERSED');
CREATE TYPE "DepositReversalKind" AS ENUM ('CHARGEBACK', 'PROVIDER_REFUND', 'CHAIN_REORG', 'CHARGEBACK_RECOVERY');
CREATE TYPE "WithdrawalKind" AS ENUM ('PLAYER', 'REFUND');
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'HELD', 'UNDER_REVIEW', 'APPROVED', 'SUBMITTED', 'SETTLED',
  'FAILED', 'REJECTED', 'CANCELLED', 'RETURNED');
CREATE TYPE "PayoutOperation" AS ENUM ('PAYOUT', 'REFUND');
CREATE TYPE "PayoutDispatchStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SENT', 'UNCERTAIN', 'RETRY_WAIT', 'COMPLETED',
  'FAILED', 'MANUAL', 'CANCELLED');
CREATE TYPE "PayoutAttemptOutcome" AS ENUM ('ACCEPTED', 'COMPLETED', 'REJECTED_FINAL', 'REJECTED_RETRYABLE',
  'UNCERTAIN', 'NOT_FOUND');
CREATE TYPE "PaymentObjectType" AS ENUM ('PAYMENT', 'PAYOUT', 'REFUND', 'DISPUTE', 'KYC');
CREATE TYPE "PaymentEventOutcome" AS ENUM ('APPLIED', 'DUPLICATE', 'STALE', 'UNKNOWN_OBJECT', 'NEEDS_REVIEW', 'DEAD');
CREATE TYPE "PaymentReviewSubject" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'INSTRUMENT', 'USER', 'SWITCH');
CREATE TYPE "PaymentReviewVerb" AS ENUM ('APPROVE', 'REJECT', 'NOTE', 'RESTRICT', 'UNRESTRICT', 'RESOLVE',
  'SWITCH_ON', 'SWITCH_OFF');
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'OK', 'ISSUES', 'FAILED');
CREATE TYPE "ReconciliationIssueStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
CREATE TYPE "EmailOutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- 3. Tables -------------------------------------------------------------------
-- Per-user compliance state; the row is also the per-user lock of every payments flow.
CREATE TABLE public."PlayerCompliance" (
  "userId" TEXT NOT NULL,
  "kycStatus" "KycStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "kycProvider" TEXT,
  "kycApplicantRef" TEXT,
  "kycLevel" TEXT,
  "kycSubmittedAt" TIMESTAMP(3),
  "kycVerifiedAt" TIMESTAMP(3),
  "kycRejectedAt" TIMESTAMP(3),
  "kycRejectReason" TEXT,
  "kycReviewDueAt" TIMESTAMP(3),
  "legalFirstName" TEXT,
  "legalLastName" TEXT,
  "birthDate" DATE,
  "residenceCountry" TEXT,
  "screeningStatus" "ScreeningStatus" NOT NULL DEFAULT 'NOT_SCREENED',
  "screenedAt" TIMESTAMP(3),
  "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
  "sourceOfFundsStatus" "SourceOfFundsStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "restriction" "PaymentsRestriction" NOT NULL DEFAULT 'NONE',
  "restrictionReason" TEXT,
  "restrictedAt" TIMESTAMP(3),
  "restrictedBy" TEXT,
  "rgLimitsPromptedAt" TIMESTAMP(3),
  "lifetimeDepositedMinor" BIGINT NOT NULL DEFAULT 0,
  "firstDepositAt" TIMESTAMP(3),
  "chargebackCount" INTEGER NOT NULL DEFAULT 0,
  "chargebackShortfallMinor" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerCompliance_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "PlayerCompliance_valid" CHECK (
    "lifetimeDepositedMinor" >= 0 AND "chargebackCount" >= 0 AND "chargebackShortfallMinor" >= 0
    AND ("residenceCountry" IS NULL OR "residenceCountry" ~ '^[A-Z]{2}$')
    AND ("kycStatus" <> 'VERIFIED' OR ("kycVerifiedAt" IS NOT NULL AND "legalFirstName" IS NOT NULL
         AND "legalLastName" IS NOT NULL AND "birthDate" IS NOT NULL AND "residenceCountry" IS NOT NULL))
    AND ("kycStatus" <> 'REJECTED' OR "kycRejectedAt" IS NOT NULL)
    AND (("restriction" = 'NONE') = ("restrictionReason" IS NULL AND "restrictedAt" IS NULL)))
);

CREATE TABLE public."ResponsibleGamingLimit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "kind" "RgLimitKind" NOT NULL,
  "period" "RgLimitPeriod" NOT NULL,
  "assetCode" TEXT NOT NULL DEFAULT 'EUR',
  "amountMinor" BIGINT,
  "source" "RgSource" NOT NULL DEFAULT 'PLAYER',
  "createdBy" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "ResponsibleGamingLimit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResponsibleGamingLimit_valid" CHECK (
    ("amountMinor" IS NULL OR "amountMinor" > 0) AND "effectiveFrom" >= "requestedAt"
    AND length("createdBy") BETWEEN 1 AND 128 AND ("cancelledAt" IS NULL OR "cancelledAt" >= "requestedAt"))
);

CREATE TABLE public."SelfExclusion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "kind" "SelfExclusionKind" NOT NULL,
  "source" "RgSource" NOT NULL DEFAULT 'PLAYER',
  "reason" TEXT,
  "createdBy" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3),
  "reactivationRequestedAt" TIMESTAMP(3),
  "reactivationAcceptedAt" TIMESTAMP(3),
  "reactivationAcceptedBy" TEXT,
  "accessRestoredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SelfExclusion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SelfExclusion_valid" CHECK (
    (("kind" = 'DEFINITE') = ("endsAt" IS NOT NULL)) AND ("endsAt" IS NULL OR "endsAt" > "startsAt")
    AND ("reactivationAcceptedAt" IS NULL OR "reactivationRequestedAt" IS NOT NULL)
    AND (("accessRestoredAt" IS NULL) = ("reactivationAcceptedAt" IS NULL))
    AND (("reactivationAcceptedAt" IS NULL) = ("reactivationAcceptedBy" IS NULL))
    AND length("createdBy") BETWEEN 1 AND 128 AND ("reason" IS NULL OR length("reason") <= 500)
    AND ("reactivationAcceptedBy" IS NULL OR length("reactivationAcceptedBy") BETWEEN 1 AND 128))
);

-- A PSP card token (deposits and payouts) or a crypto payout address.
CREATE TABLE public."PaymentInstrument" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "kind" "InstrumentKind" NOT NULL,
  "status" "InstrumentStatus" NOT NULL DEFAULT 'ACTIVE',
  "origin" "InstrumentOrigin" NOT NULL,
  "providerKey" TEXT NOT NULL,
  "assetCode" TEXT NOT NULL,
  "network" TEXT,
  "address" TEXT,
  "addressNormalized" TEXT,
  "memo" TEXT,
  "cardToken" TEXT,
  "cardFingerprint" TEXT,
  "cardBrand" TEXT,
  "cardLast4" TEXT,
  "cardExpMonth" SMALLINT,
  "cardExpYear" SMALLINT,
  "cardIssuerCountry" TEXT,
  "cardFunding" TEXT,
  "depositEnabled" BOOLEAN NOT NULL DEFAULT false,
  "payoutEnabled" BOOLEAN NOT NULL DEFAULT false,
  "label" TEXT,
  "createdBySessionId" TEXT,
  "stepUpGrantId" TEXT,
  "ownershipMethod" TEXT,
  "ownershipProof" JSONB,
  "ownershipVerifiedAt" TIMESTAMP(3),
  "usableAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "successfulPayouts" INTEGER NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  "revokedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentInstrument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentInstrument_valid" CHECK (
    "providerKey" ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
    AND (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL))
    AND "successfulPayouts" >= 0
    AND ("label" IS NULL OR length("label") BETWEEN 1 AND 40)
    AND ("cardFunding" IS NULL OR "cardFunding" IN ('debit', 'credit', 'prepaid', 'unknown'))
    AND ("origin" <> 'PLAYER' OR "stepUpGrantId" IS NOT NULL)
    AND ("ownershipProof" IS NULL OR (jsonb_typeof("ownershipProof") = 'object' AND octet_length("ownershipProof"::text) <= 4096))
    AND (CASE "kind"
      WHEN 'CARD_TOKEN' THEN "cardToken" IS NOT NULL AND length("cardToken") BETWEEN 1 AND 256
        AND "address" IS NULL AND "addressNormalized" IS NULL AND "network" IS NULL AND "memo" IS NULL
        AND "origin" <> 'PLAYER'
        AND ("cardLast4" IS NULL OR "cardLast4" ~ '^[0-9]{4}$')
        AND ("cardExpMonth" IS NULL OR "cardExpMonth" BETWEEN 1 AND 12)
        AND ("cardIssuerCountry" IS NULL OR "cardIssuerCountry" ~ '^[A-Z]{2}$')
      WHEN 'CRYPTO_ADDRESS' THEN "address" IS NOT NULL AND length("address") BETWEEN 14 AND 128
        AND "addressNormalized" IS NOT NULL AND length("addressNormalized") BETWEEN 14 AND 128
        AND "network" IS NOT NULL AND "cardToken" IS NULL
        AND "cardFingerprint" IS NULL AND "depositEnabled" = false
        AND ("memo" IS NULL OR length("memo") BETWEEN 1 AND 64)
    END))
);

CREATE TABLE public."Deposit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "clientRequestId" UUID,
  "requestHash" TEXT,
  "method" "PaymentMethodKind" NOT NULL,
  "providerKey" TEXT NOT NULL,
  "instrumentId" UUID,
  "status" "DepositStatus" NOT NULL DEFAULT 'CREATED',
  "assetCode" TEXT NOT NULL,
  "requestedMinor" BIGINT NOT NULL,
  "reportedMinor" BIGINT,
  "creditedMinor" BIGINT,
  "reversedMinor" BIGINT NOT NULL DEFAULT 0,
  "recoveredMinor" BIGINT NOT NULL DEFAULT 0,
  "excessMinor" BIGINT NOT NULL DEFAULT 0,
  "feeMinor" BIGINT,
  "payAssetCode" TEXT,
  "payAmount" TEXT,
  "payNetwork" TEXT,
  "payAddress" TEXT,
  "payMemo" TEXT,
  "txHash" TEXT,
  "confirmations" INTEGER,
  "providerPaymentId" TEXT,
  "providerStatus" TEXT,
  "hostedUrl" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "statusReason" TEXT,
  "lateSuccess" BOOLEAN NOT NULL DEFAULT false,
  "ledgerCreditTxId" UUID,
  "ip" TEXT,
  "ipCountry" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  "creditedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Deposit_valid" CHECK (
    "requestedMinor" > 0 AND ("creditedMinor" IS NULL OR "creditedMinor" > 0)
    AND ("reportedMinor" IS NULL OR "reportedMinor" > 0)
    AND ("feeMinor" IS NULL OR "feeMinor" >= 0)
    AND "providerKey" ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
    AND ("requestHash" IS NULL OR "requestHash" ~ '^[a-f0-9]{64}$')
    AND (("clientRequestId" IS NULL) = ("requestHash" IS NULL))
    AND "reversedMinor" >= 0 AND "recoveredMinor" >= 0 AND "excessMinor" >= 0
    AND (("method" = 'CRYPTO') = ("payAssetCode" IS NOT NULL))
    AND ("payAssetCode" IS NULL OR "payAssetCode" ~ '^[A-Z][A-Z0-9_]{1,31}$')
    AND ("confirmations" IS NULL OR "confirmations" >= 0)
    AND ("ipCountry" IS NULL OR "ipCountry" ~ '^[A-Z0-9]{2}$')
    AND (("status" IN ('CREDITED', 'PARTIALLY_REVERSED', 'REVERSED')) = ("ledgerCreditTxId" IS NOT NULL))
    AND ("ledgerCreditTxId" IS NULL OR "creditedMinor" IS NOT NULL)
    AND ("ledgerCreditTxId" IS NULL OR "method" <> 'CARD' OR "instrumentId" IS NOT NULL)
    AND "excessMinor" <= COALESCE("creditedMinor", 0)
    AND ("status" <> 'CONFIRMED' OR ("creditedMinor" IS NOT NULL AND "confirmedAt" IS NOT NULL))
    AND (CASE "status"
      WHEN 'CREDITED' THEN "reversedMinor" = "recoveredMinor"
      WHEN 'PARTIALLY_REVERSED' THEN "reversedMinor" - "recoveredMinor" > 0
        AND "reversedMinor" - "recoveredMinor" < "creditedMinor"
      WHEN 'REVERSED' THEN "reversedMinor" - "recoveredMinor" = "creditedMinor"
      ELSE "reversedMinor" = 0 AND "recoveredMinor" = 0 END))
);

-- Chargebacks, provider refunds, chain reorganisations and their recoveries. Append-only.
CREATE TABLE public."DepositReversal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "depositId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "kind" "DepositReversalKind" NOT NULL,
  "providerReversalId" TEXT NOT NULL,
  "recoversReversalId" UUID,
  "amountMinor" BIGINT NOT NULL,
  "userPortionMinor" BIGINT NOT NULL,
  "lossMinor" BIGINT NOT NULL,
  "reasonCode" TEXT,
  "eventId" UUID,
  "ledgerTxId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DepositReversal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DepositReversal_valid" CHECK (
    "amountMinor" > 0 AND "userPortionMinor" >= 0 AND "lossMinor" >= 0
    AND "userPortionMinor" + "lossMinor" = "amountMinor"
    AND (("kind" = 'CHARGEBACK_RECOVERY') = ("recoversReversalId" IS NOT NULL))
    AND length("providerReversalId") BETWEEN 1 AND 200)
);

CREATE TABLE public."WithdrawalQuote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "instrumentId" UUID NOT NULL,
  "providerKey" TEXT NOT NULL,
  "assetCode" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "feeMinor" BIGINT NOT NULL,
  "receiveAssetCode" TEXT NOT NULL,
  "receiveEstimate" TEXT,
  "rate" TEXT,
  "bindHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WithdrawalQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WithdrawalQuote_valid" CHECK (
    "amountMinor" > 0 AND "feeMinor" >= 0 AND "feeMinor" < "amountMinor"
    AND "providerKey" ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
    AND "bindHash" ~ '^[a-f0-9]{64}$' AND "expiresAt" > "createdAt"
    AND "expiresAt" <= "createdAt" + interval '10 minutes'
    AND "receiveAssetCode" ~ '^[A-Z][A-Z0-9_]{1,31}$')
);

CREATE TABLE public."Withdrawal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "kind" "WithdrawalKind" NOT NULL DEFAULT 'PLAYER',
  "clientRequestId" UUID,
  "requestHash" TEXT,
  "quoteId" UUID,
  "sourceDepositId" UUID,
  "instrumentId" UUID,
  "providerKey" TEXT,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
  "assetCode" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "feeMinor" BIGINT NOT NULL DEFAULT 0,
  "payoutAssetCode" TEXT,
  "payoutAmount" TEXT,
  "payoutRate" TEXT,
  "reviewReasons" JSONB NOT NULL DEFAULT '[]',
  "approvalsRequired" SMALLINT NOT NULL DEFAULT 1,
  "rulesVersion" TEXT,
  "sessionId" TEXT,
  "stepUpGrantId" TEXT,
  "providerPayoutId" TEXT,
  "txHash" TEXT,
  "failureCode" TEXT,
  "failureReason" TEXT,
  "holdTxId" UUID,
  "releaseTxId" UUID,
  "settleTxId" UUID,
  "returnTxId" UUID,
  "ip" TEXT,
  "ipCountry" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heldAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "cancelRequestedAt" TIMESTAMP(3),
  "cancelCode" TEXT,
  CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Withdrawal_valid" CHECK (
    "amountMinor" > 0 AND "feeMinor" >= 0 AND "feeMinor" < "amountMinor"
    AND "approvalsRequired" BETWEEN 1 AND 3
    AND jsonb_typeof("reviewReasons") = 'array'
    AND ("providerKey" IS NULL OR "providerKey" ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$')
    AND ("requestHash" IS NULL OR "requestHash" ~ '^[a-f0-9]{64}$')
    AND (("clientRequestId" IS NULL) = ("requestHash" IS NULL))
    AND (("kind" = 'PLAYER') = ("clientRequestId" IS NOT NULL AND "stepUpGrantId" IS NOT NULL AND "quoteId" IS NOT NULL))
    AND (("kind" = 'REFUND') = ("sourceDepositId" IS NOT NULL))
    AND ("status" = 'REQUESTED' OR "holdTxId" IS NOT NULL)
    AND ("status" NOT IN ('APPROVED', 'SUBMITTED', 'SETTLED', 'RETURNED')
         OR ("instrumentId" IS NOT NULL AND "providerKey" IS NOT NULL))
    AND (("status" IN ('SETTLED', 'RETURNED')) = ("settleTxId" IS NOT NULL))
    AND (("status" IN ('FAILED', 'REJECTED', 'CANCELLED')) = ("releaseTxId" IS NOT NULL))
    AND (("status" = 'RETURNED') = ("returnTxId" IS NOT NULL))
    AND NOT ("releaseTxId" IS NOT NULL AND "settleTxId" IS NOT NULL)
    AND (("cancelRequestedAt" IS NULL) = ("cancelCode" IS NULL))
    AND ("cancelCode" IS NULL OR length("cancelCode") BETWEEN 1 AND 64)
    AND ("ipCountry" IS NULL OR "ipCountry" ~ '^[A-Z0-9]{2}$'))
);

-- Payout outbox: one row and one provider idempotency key per withdrawal, for life.
CREATE TABLE public."PayoutDispatch" (
  "withdrawalId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "operation" "PayoutOperation" NOT NULL,
  "providerIdempotencyKey" TEXT NOT NULL,
  "status" "PayoutDispatchStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "queries" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "uncertainSince" TIMESTAMP(3),
  "providerPayoutId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayoutDispatch_pkey" PRIMARY KEY ("withdrawalId"),
  CONSTRAINT "PayoutDispatch_valid" CHECK (
    "attempts" >= 0 AND "queries" >= 0 AND "providerIdempotencyKey" ~ '^[A-Za-z0-9:._-]{1,100}$'
    AND ("status" <> 'IN_FLIGHT' OR "leaseUntil" IS NOT NULL)
    AND ("lastError" IS NULL OR length("lastError") <= 500))
);

CREATE TABLE public."PayoutAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "withdrawalId" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "requestSha256" TEXT,
  "httpStatus" INTEGER,
  "outcome" "PayoutAttemptOutcome" NOT NULL,
  "providerPayoutId" TEXT,
  "errorClass" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayoutAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayoutAttempt_valid" CHECK (
    "seq" > 0 AND "action" IN ('CREATE', 'QUERY', 'REFUND')
    AND ("requestSha256" IS NULL OR "requestSha256" ~ '^[a-f0-9]{64}$')
    AND ("errorClass" IS NULL OR length("errorClass") <= 100))
);

-- Provider event inbox. Only signature-verified events are stored.
CREATE TABLE public."PaymentEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "objectType" "PaymentObjectType" NOT NULL,
  "objectRef" TEXT,
  "merchantRef" TEXT,
  "payloadSha256" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "signatureScheme" TEXT NOT NULL,
  "signatureVerified" BOOLEAN NOT NULL,
  "sourceIp" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "outcome" "PaymentEventOutcome",
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentEvent_valid" CHECK (
    "signatureVerified" AND "provider" ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
    AND length("providerEventId") BETWEEN 1 AND 200 AND length("eventType") BETWEEN 1 AND 100
    AND length("signatureScheme") BETWEEN 1 AND 64
    AND "payloadSha256" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 65536
    AND (("processedAt" IS NULL) = ("outcome" IS NULL)) AND "attempts" >= 0
    AND ("lastError" IS NULL OR length("lastError") <= 500))
);

CREATE TABLE public."PaymentReviewAction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "subjectType" "PaymentReviewSubject" NOT NULL,
  "subjectId" TEXT NOT NULL,
  "subjectUserId" TEXT,
  "actorUserId" TEXT,
  "actorKind" TEXT NOT NULL,
  "actorAccessEmail" TEXT,
  "actorStepUpMethod" TEXT,
  "verb" "PaymentReviewVerb" NOT NULL,
  "reasonCode" TEXT,
  "note" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentReviewAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentReviewAction_valid" CHECK (
    "actorKind" IN ('ADMIN', 'SYSTEM', 'PLAYER') AND (("actorKind" = 'SYSTEM') = ("actorUserId" IS NULL))
    AND ("note" IS NULL OR length("note") <= 2000) AND jsonb_typeof("metadata") = 'object'
    AND octet_length("metadata"::text) <= 8192
    AND length("subjectId") BETWEEN 1 AND 128)
);

CREATE TABLE public."PaymentSwitch" (
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" TEXT,
  "reason" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentSwitch_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "PaymentSwitch_valid" CHECK ("key" IN ('DEPOSIT_CARD', 'DEPOSIT_CRYPTO', 'WITHDRAW_CARD',
    'WITHDRAW_CRYPTO', 'AUTO_APPROVE', 'PAYOUT_DISPATCH', 'NEW_INSTRUMENTS')
    AND ("reason" IS NULL OR length("reason") <= 500))
);
-- Seeded before row level security is forced (below), so the insert works
-- whether or not the migration role bypasses RLS. Every switch starts off.
INSERT INTO public."PaymentSwitch" ("key", "enabled") VALUES
  ('DEPOSIT_CARD', false), ('DEPOSIT_CRYPTO', false), ('WITHDRAW_CARD', false), ('WITHDRAW_CRYPTO', false),
  ('AUTO_APPROVE', false), ('PAYOUT_DISPATCH', false), ('NEW_INSTRUMENTS', false)
ON CONFLICT ("key") DO NOTHING;

CREATE TABLE public."ReconciliationRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL,
  "scopeDate" DATE,
  "status" "ReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
  "cursor" TEXT,
  "summary" JSONB NOT NULL DEFAULT '{}',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationRun_valid" CHECK ("kind" IN ('LEDGER', 'PAYMENTS', 'PROVIDER', 'CUSTODY')
    AND jsonb_typeof("summary") = 'object')
);

CREATE TABLE public."ReconciliationIssue" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "subjectType" TEXT,
  "subjectId" TEXT NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}',
  "status" "ReconciliationIssueStatus" NOT NULL DEFAULT 'OPEN',
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolution" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationIssue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationIssue_valid" CHECK ("severity" IN ('INFO', 'WARN', 'CRITICAL')
    AND jsonb_typeof("details") = 'object' AND (("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL)))
);

-- Durable notification outbox (INTEGRATION.md override 10). The payments
-- Worker inserts in the same transaction as the money change it reports and
-- drains it through apps/edge/src/mail. No address is stored: the sender reads
-- User.email at send time, so an email change is respected. scope is the
-- settlement asset of the Worker that wrote the row: only that Worker sends
-- it, so a sandbox Worker on a shared database neither mails a live notice nor
-- cancels one because its own mail is off. payload holds the
-- template's data only (amounts as strings, ids, signed short-lived links),
-- never a password, a code or a card number.
CREATE TABLE public."EmailOutbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "template" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "dedupeKey" TEXT NOT NULL,
  "status" "EmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailOutbox_valid" CHECK (
    "template" ~ '^[a-z][a-z0-9-]{1,63}$'
    AND "scope" IN ('EUR', 'TEST_EUR')
    AND length("dedupeKey") BETWEEN 1 AND 200
    AND jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 8192
    AND "attempts" >= 0
    AND (("status" = 'SENT') = ("sentAt" IS NOT NULL))
    AND ("status" <> 'SENDING' OR "leaseUntil" IS NOT NULL)
    AND ("lastError" IS NULL OR length("lastError") <= 500))
);

-- 4. Indexes (names = Prisma defaults, so migrate diff finds no drift) --------
CREATE INDEX "PlayerCompliance_kycApplicantRef_idx" ON public."PlayerCompliance" ("kycApplicantRef");
CREATE INDEX "ResponsibleGamingLimit_userId_kind_period_effectiveFrom_idx"
  ON public."ResponsibleGamingLimit" ("userId", "kind", "period", "effectiveFrom");
CREATE INDEX "SelfExclusion_userId_startsAt_idx" ON public."SelfExclusion" ("userId", "startsAt");
CREATE UNIQUE INDEX "PaymentInstrument_stepUpGrantId_key" ON public."PaymentInstrument" ("stepUpGrantId");
CREATE INDEX "PaymentInstrument_providerKey_cardToken_idx" ON public."PaymentInstrument" ("providerKey", "cardToken");
CREATE INDEX "PaymentInstrument_userId_status_idx" ON public."PaymentInstrument" ("userId", "status");
CREATE INDEX "PaymentInstrument_addressNormalized_idx" ON public."PaymentInstrument" ("addressNormalized");
CREATE INDEX "PaymentInstrument_cardFingerprint_idx" ON public."PaymentInstrument" ("cardFingerprint");
CREATE UNIQUE INDEX "Deposit_ledgerCreditTxId_key" ON public."Deposit" ("ledgerCreditTxId");
CREATE UNIQUE INDEX "Deposit_userId_clientRequestId_key" ON public."Deposit" ("userId", "clientRequestId");
CREATE UNIQUE INDEX "Deposit_providerKey_providerPaymentId_key" ON public."Deposit" ("providerKey", "providerPaymentId");
CREATE INDEX "Deposit_userId_createdAt_idx" ON public."Deposit" ("userId", "createdAt");
CREATE INDEX "Deposit_status_expiresAt_idx" ON public."Deposit" ("status", "expiresAt");
CREATE UNIQUE INDEX "DepositReversal_recoversReversalId_key" ON public."DepositReversal" ("recoversReversalId");
CREATE UNIQUE INDEX "DepositReversal_ledgerTxId_key" ON public."DepositReversal" ("ledgerTxId");
CREATE UNIQUE INDEX "DepositReversal_providerKey_kind_providerReversalId_key"
  ON public."DepositReversal" ("providerKey", "kind", "providerReversalId");
CREATE INDEX "DepositReversal_depositId_idx" ON public."DepositReversal" ("depositId");
CREATE INDEX "WithdrawalQuote_userId_createdAt_idx" ON public."WithdrawalQuote" ("userId", "createdAt");
CREATE UNIQUE INDEX "Withdrawal_quoteId_key" ON public."Withdrawal" ("quoteId");
CREATE UNIQUE INDEX "Withdrawal_stepUpGrantId_key" ON public."Withdrawal" ("stepUpGrantId");
CREATE UNIQUE INDEX "Withdrawal_holdTxId_key" ON public."Withdrawal" ("holdTxId");
CREATE UNIQUE INDEX "Withdrawal_releaseTxId_key" ON public."Withdrawal" ("releaseTxId");
CREATE UNIQUE INDEX "Withdrawal_settleTxId_key" ON public."Withdrawal" ("settleTxId");
CREATE UNIQUE INDEX "Withdrawal_returnTxId_key" ON public."Withdrawal" ("returnTxId");
CREATE UNIQUE INDEX "Withdrawal_userId_clientRequestId_key" ON public."Withdrawal" ("userId", "clientRequestId");
CREATE UNIQUE INDEX "Withdrawal_providerKey_providerPayoutId_key" ON public."Withdrawal" ("providerKey", "providerPayoutId");
CREATE INDEX "Withdrawal_status_createdAt_idx" ON public."Withdrawal" ("status", "createdAt");
CREATE INDEX "Withdrawal_userId_createdAt_idx" ON public."Withdrawal" ("userId", "createdAt");
CREATE INDEX "Withdrawal_cancelRequestedAt_idx" ON public."Withdrawal" ("cancelRequestedAt");
CREATE UNIQUE INDEX "PayoutDispatch_providerIdempotencyKey_key" ON public."PayoutDispatch" ("providerIdempotencyKey");
CREATE INDEX "PayoutDispatch_status_nextAttemptAt_idx" ON public."PayoutDispatch" ("status", "nextAttemptAt");
CREATE UNIQUE INDEX "PayoutAttempt_withdrawalId_seq_key" ON public."PayoutAttempt" ("withdrawalId", "seq");
CREATE UNIQUE INDEX "PaymentEvent_provider_providerEventId_key" ON public."PaymentEvent" ("provider", "providerEventId");
CREATE INDEX "PaymentEvent_processedAt_nextAttemptAt_idx" ON public."PaymentEvent" ("processedAt", "nextAttemptAt");
CREATE INDEX "PaymentEvent_provider_objectRef_idx" ON public."PaymentEvent" ("provider", "objectRef");
CREATE INDEX "PaymentReviewAction_subjectType_subjectId_createdAt_idx"
  ON public."PaymentReviewAction" ("subjectType", "subjectId", "createdAt");
CREATE INDEX "PaymentReviewAction_subjectUserId_createdAt_idx" ON public."PaymentReviewAction" ("subjectUserId", "createdAt");
CREATE UNIQUE INDEX "ReconciliationIssue_runId_code_subjectId_key" ON public."ReconciliationIssue" ("runId", "code", "subjectId");
CREATE UNIQUE INDEX "EmailOutbox_dedupeKey_key" ON public."EmailOutbox" ("dedupeKey");
CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON public."EmailOutbox" ("status", "nextAttemptAt");
CREATE INDEX "EmailOutbox_userId_createdAt_idx" ON public."EmailOutbox" ("userId", "createdAt");

-- 5. Foreign keys (RESTRICT everywhere, like the ledger; the outbox goes with its user) --
ALTER TABLE public."PlayerCompliance" ADD CONSTRAINT "PlayerCompliance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."ResponsibleGamingLimit" ADD CONSTRAINT "ResponsibleGamingLimit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."ResponsibleGamingLimit" ADD CONSTRAINT "ResponsibleGamingLimit_assetCode_fkey"
  FOREIGN KEY ("assetCode") REFERENCES public."Asset"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."SelfExclusion" ADD CONSTRAINT "SelfExclusion_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."PaymentInstrument" ADD CONSTRAINT "PaymentInstrument_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."PaymentInstrument" ADD CONSTRAINT "PaymentInstrument_assetCode_fkey"
  FOREIGN KEY ("assetCode") REFERENCES public."Asset"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Deposit" ADD CONSTRAINT "Deposit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Deposit" ADD CONSTRAINT "Deposit_instrumentId_fkey"
  FOREIGN KEY ("instrumentId") REFERENCES public."PaymentInstrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Deposit" ADD CONSTRAINT "Deposit_assetCode_fkey"
  FOREIGN KEY ("assetCode") REFERENCES public."Asset"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Deposit" ADD CONSTRAINT "Deposit_ledgerCreditTxId_fkey"
  FOREIGN KEY ("ledgerCreditTxId") REFERENCES public."LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."DepositReversal" ADD CONSTRAINT "DepositReversal_depositId_fkey"
  FOREIGN KEY ("depositId") REFERENCES public."Deposit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."DepositReversal" ADD CONSTRAINT "DepositReversal_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."DepositReversal" ADD CONSTRAINT "DepositReversal_recoversReversalId_fkey"
  FOREIGN KEY ("recoversReversalId") REFERENCES public."DepositReversal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."DepositReversal" ADD CONSTRAINT "DepositReversal_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES public."PaymentEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."DepositReversal" ADD CONSTRAINT "DepositReversal_ledgerTxId_fkey"
  FOREIGN KEY ("ledgerTxId") REFERENCES public."LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."WithdrawalQuote" ADD CONSTRAINT "WithdrawalQuote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."WithdrawalQuote" ADD CONSTRAINT "WithdrawalQuote_instrumentId_fkey"
  FOREIGN KEY ("instrumentId") REFERENCES public."PaymentInstrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."WithdrawalQuote" ADD CONSTRAINT "WithdrawalQuote_assetCode_fkey"
  FOREIGN KEY ("assetCode") REFERENCES public."Asset"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES public."WithdrawalQuote"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_sourceDepositId_fkey"
  FOREIGN KEY ("sourceDepositId") REFERENCES public."Deposit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_instrumentId_fkey"
  FOREIGN KEY ("instrumentId") REFERENCES public."PaymentInstrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_assetCode_fkey"
  FOREIGN KEY ("assetCode") REFERENCES public."Asset"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_holdTxId_fkey"
  FOREIGN KEY ("holdTxId") REFERENCES public."LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_releaseTxId_fkey"
  FOREIGN KEY ("releaseTxId") REFERENCES public."LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_settleTxId_fkey"
  FOREIGN KEY ("settleTxId") REFERENCES public."LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."Withdrawal" ADD CONSTRAINT "Withdrawal_returnTxId_fkey"
  FOREIGN KEY ("returnTxId") REFERENCES public."LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."PayoutDispatch" ADD CONSTRAINT "PayoutDispatch_withdrawalId_fkey"
  FOREIGN KEY ("withdrawalId") REFERENCES public."Withdrawal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."PayoutDispatch" ADD CONSTRAINT "PayoutDispatch_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."PayoutAttempt" ADD CONSTRAINT "PayoutAttempt_withdrawalId_fkey"
  FOREIGN KEY ("withdrawalId") REFERENCES public."PayoutDispatch"("withdrawalId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."PaymentReviewAction" ADD CONSTRAINT "PaymentReviewAction_subjectUserId_fkey"
  FOREIGN KEY ("subjectUserId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."PaymentReviewAction" ADD CONSTRAINT "PaymentReviewAction_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."ReconciliationIssue" ADD CONSTRAINT "ReconciliationIssue_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES public."ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."EmailOutbox" ADD CONSTRAINT "EmailOutbox_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Triggers -----------------------------------------------------------------
-- SECURITY INVOKER throughout: each guard reads only what the writing role
-- may read (granted in section 8). The sandbox test is the regex above.
CREATE FUNCTION public.payments_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('poker.break_glass', true) IS NOT DISTINCT FROM 'on'
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = format('PAYMENT_IMMUTABLE: %s rows are append-only', TG_TABLE_NAME);
END $fn$;
CREATE TRIGGER "DepositReversal_append_only" BEFORE UPDATE OR DELETE ON public."DepositReversal"
  FOR EACH ROW EXECUTE FUNCTION public.payments_append_only();
CREATE TRIGGER "PayoutAttempt_append_only" BEFORE UPDATE OR DELETE ON public."PayoutAttempt"
  FOR EACH ROW EXECUTE FUNCTION public.payments_append_only();
CREATE TRIGGER "PaymentReviewAction_append_only" BEFORE UPDATE OR DELETE ON public."PaymentReviewAction"
  FOR EACH ROW EXECUTE FUNCTION public.payments_append_only();
CREATE TRIGGER "PaymentSwitch_no_delete" BEFORE DELETE ON public."PaymentSwitch"
  FOR EACH ROW EXECUTE FUNCTION public.payments_append_only();

-- A reversal names a credited deposit of the same user and provider, and the
-- ledger transaction of its own kind (the binding check at commit then
-- matches the amounts); a recovery names an earlier reversal of that deposit.
CREATE FUNCTION public.deposit_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Deposit" d WHERE d."id" = NEW."depositId" AND d."userId" = NEW."userId"
                  AND d."providerKey" = NEW."providerKey" AND d."ledgerCreditTxId" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a reversal names a credited deposit of the same user and provider';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."LedgerTransaction" t WHERE t."id" = NEW."ledgerTxId"
                  AND t."type"::text = CASE WHEN NEW."kind" = 'CHARGEBACK_RECOVERY' THEN 'CHARGEBACK_RECOVERY' ELSE 'DEPOSIT_REVERSAL' END) THEN
    RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: ledgerTxId must name a ledger transaction of the reversal''s kind';
  END IF;
  IF NEW."kind" = 'CHARGEBACK_RECOVERY' AND NOT EXISTS (SELECT 1 FROM public."DepositReversal" o WHERE o."id" = NEW."recoversReversalId"
       AND o."depositId" = NEW."depositId" AND o."kind" <> 'CHARGEBACK_RECOVERY') THEN
    RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a recovery names an earlier reversal of the same deposit';
  END IF;
  NEW."createdAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "DepositReversal_guard" BEFORE INSERT ON public."DepositReversal"
  FOR EACH ROW EXECUTE FUNCTION public.deposit_reversal_guard();

-- Deposit limits: stricter applies now, looser or removal after at least 24 h,
-- and a new request cancels any pending change (MGA Player Protection guidance).
CREATE FUNCTION public.rg_limit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
DECLARE
  v_current bigint;
  v_has boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = 'PAYMENT_IMMUTABLE: ResponsibleGamingLimit rows are append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'cancelledAt') IS DISTINCT FROM (to_jsonb(OLD) - 'cancelledAt')
       OR OLD."cancelledAt" IS NOT NULL OR NEW."cancelledAt" IS NULL OR OLD."effectiveFrom" <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION USING ERRCODE = 'PM007', MESSAGE = 'RG_RULE: only a pending limit change can be cancelled';
    END IF;
    NEW."cancelledAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rg-limit:' || NEW."userId", 0));
  NEW."requestedAt" := CURRENT_TIMESTAMP;
  NEW."cancelledAt" := NULL;
  SELECT l."amountMinor", true INTO v_current, v_has FROM public."ResponsibleGamingLimit" l
   WHERE l."userId" = NEW."userId" AND l."kind" = NEW."kind" AND l."period" = NEW."period" AND l."assetCode" = NEW."assetCode"
     AND l."cancelledAt" IS NULL AND l."effectiveFrom" <= CURRENT_TIMESTAMP
   ORDER BY l."effectiveFrom" DESC, l."requestedAt" DESC LIMIT 1;
  IF NEW."amountMinor" IS NOT NULL AND (NOT COALESCE(v_has, false) OR v_current IS NULL OR NEW."amountMinor" <= v_current) THEN
    NEW."effectiveFrom" := CURRENT_TIMESTAMP;
  ELSE
    NEW."effectiveFrom" := CURRENT_TIMESTAMP + INTERVAL '24 hours';
  END IF;
  UPDATE public."ResponsibleGamingLimit" SET "cancelledAt" = CURRENT_TIMESTAMP
   WHERE "userId" = NEW."userId" AND "kind" = NEW."kind" AND "period" = NEW."period" AND "assetCode" = NEW."assetCode"
     AND "cancelledAt" IS NULL AND "effectiveFrom" > CURRENT_TIMESTAMP;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "ResponsibleGamingLimit_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ResponsibleGamingLimit"
  FOR EACH ROW EXECUTE FUNCTION public.rg_limit_guard();

-- Self-exclusion: immediate, and in force until access is restored, whatever
-- endsAt says. A definite one: the player asks to come back once it ended, no
-- operator is involved, and access returns 24 hours after the request. An
-- indefinite one: the player asks at any time, an administrator accepts, and
-- access returns 7 days after that.
CREATE FUNCTION public.self_exclusion_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = 'PAYMENT_IMMUTABLE: SelfExclusion rows are append-only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."startsAt" := CURRENT_TIMESTAMP;
    NEW."createdAt" := CURRENT_TIMESTAMP;
    IF NEW."kind" = 'DEFINITE' AND NEW."endsAt" < CURRENT_TIMESTAMP + INTERVAL '24 hours' THEN
      RAISE EXCEPTION USING ERRCODE = 'PM007', MESSAGE = 'RG_RULE: a definite self-exclusion lasts at least 24 hours';
    END IF;
    IF NEW."reactivationRequestedAt" IS NOT NULL OR NEW."reactivationAcceptedAt" IS NOT NULL OR NEW."accessRestoredAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PM007', MESSAGE = 'RG_RULE: a new self-exclusion has no reactivation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['reactivationRequestedAt', 'reactivationAcceptedAt', 'reactivationAcceptedBy', 'accessRestoredAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reactivationRequestedAt', 'reactivationAcceptedAt', 'reactivationAcceptedBy', 'accessRestoredAt'])
     OR (OLD."reactivationRequestedAt" IS NOT NULL AND NEW."reactivationRequestedAt" IS DISTINCT FROM OLD."reactivationRequestedAt")
     OR (OLD."reactivationAcceptedAt" IS NOT NULL AND (NEW."reactivationAcceptedAt" IS DISTINCT FROM OLD."reactivationAcceptedAt"
         OR NEW."reactivationAcceptedBy" IS DISTINCT FROM OLD."reactivationAcceptedBy")) THEN
    RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: only reactivation fields change, each once';
  END IF;
  IF NEW."reactivationRequestedAt" IS NOT NULL AND OLD."reactivationRequestedAt" IS NULL THEN
    NEW."reactivationRequestedAt" := CURRENT_TIMESTAMP;
    IF NEW."kind" = 'DEFINITE' THEN
      IF CURRENT_TIMESTAMP < NEW."endsAt" THEN
        RAISE EXCEPTION USING ERRCODE = 'PM007', MESSAGE = 'RG_RULE: a definite self-exclusion cannot be reopened before it ends';
      END IF;
      NEW."reactivationAcceptedAt" := CURRENT_TIMESTAMP;
      NEW."reactivationAcceptedBy" := 'PLAYER_REQUEST';
      NEW."accessRestoredAt" := CURRENT_TIMESTAMP + INTERVAL '24 hours';
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."reactivationAcceptedAt" IS NOT NULL AND OLD."reactivationAcceptedAt" IS NULL THEN
    IF OLD."reactivationRequestedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PM007', MESSAGE = 'RG_RULE: a reactivation is accepted only after the player asked for it';
    END IF;
    IF NEW."kind" = 'DEFINITE' THEN
      RAISE EXCEPTION USING ERRCODE = 'PM007', MESSAGE = 'RG_RULE: a definite self-exclusion ends on the player''s request, not an operator''s';
    END IF;
    NEW."reactivationAcceptedAt" := CURRENT_TIMESTAMP;
    NEW."accessRestoredAt" := CURRENT_TIMESTAMP + INTERVAL '7 days';
  ELSE
    NEW."accessRestoredAt" := OLD."accessRestoredAt";
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "SelfExclusion_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."SelfExclusion"
  FOR EACH ROW EXECUTE FUNCTION public.self_exclusion_guard();

CREATE FUNCTION public.payment_instrument_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
DECLARE
  v_kind text;
  v_network text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('poker.break_glass', true) IS NOT DISTINCT FROM 'on'
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = 'PAYMENT_IMMUTABLE: PaymentInstrument rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('instrument:' || NEW."userId", 0));
    SELECT a."kind"::text, a."network" INTO v_kind, v_network FROM public."Asset" a WHERE a."code" = NEW."assetCode";
    IF NEW."kind" = 'CRYPTO_ADDRESS' THEN
      IF v_kind IS DISTINCT FROM 'CRYPTO' OR NEW."network" IS DISTINCT FROM v_network THEN
        RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: address asset and network do not match';
      END IF;
      IF EXISTS (SELECT 1 FROM public."PaymentInstrument" p WHERE p."userId" = NEW."userId" AND p."kind" = 'CRYPTO_ADDRESS'
                  AND p."assetCode" = NEW."assetCode" AND p."addressNormalized" = NEW."addressNormalized"
                  AND p."memo" IS NOT DISTINCT FROM NEW."memo" AND p."status" <> 'REVOKED') THEN
        RAISE EXCEPTION USING ERRCODE = 'PM005', MESSAGE = 'PAYMENT_DUPLICATE_INSTRUMENT: this address is already saved';
      END IF;
      -- Cooling-off floor for every address the operator did not add.
      IF NEW."origin" <> 'OPERATOR' THEN
        NEW."usableAfter" := GREATEST(NEW."usableAfter", CURRENT_TIMESTAMP + INTERVAL '24 hours');
      END IF;
    ELSIF v_kind IS NULL OR v_kind NOT IN ('FIAT', 'TEST')
          OR (v_kind = 'TEST') IS DISTINCT FROM (NEW."providerKey" ~ '^sandbox([-_.:]|$)') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a card settles in a fiat asset with a real provider, or in a test asset with the sandbox';
    ELSIF NEW."payoutEnabled" AND NEW."origin" <> 'OPERATOR' THEN
      -- A card that can receive payouts is a new payout destination too: a
      -- small deposit with an attacker's card must not be a shortcut past the
      -- address cooling-off.
      NEW."usableAfter" := GREATEST(NEW."usableAfter", CURRENT_TIMESTAMP + INTERVAL '24 hours');
    END IF;
    -- One live row per player and card. A revoked row stays revoked for good;
    -- a fresh deposit with that card (or an admin restore) adds a new row,
    -- which cools off and announces itself like any new destination.
    IF NEW."kind" = 'CARD_TOKEN' AND EXISTS (SELECT 1 FROM public."PaymentInstrument" p WHERE p."userId" = NEW."userId"
         AND p."providerKey" = NEW."providerKey" AND p."cardToken" = NEW."cardToken" AND p."status" <> 'REVOKED') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM005', MESSAGE = 'PAYMENT_DUPLICATE_INSTRUMENT: this card is already saved';
    END IF;
    IF NEW."status" <> 'ACTIVE' OR NEW."successfulPayouts" <> 0 OR NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: an instrument starts ACTIVE and unused';
    END IF;
    -- A payout destination the player adds needs a consumed step-up grant
    -- for that purpose, and none may be added during a security hold.
    IF NEW."origin" = 'PLAYER' THEN
      IF EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = NEW."userId" AND u."securityHoldUntil" > CURRENT_TIMESTAMP) THEN
        RAISE EXCEPTION USING ERRCODE = 'PM008', MESSAGE = 'PAYMENT_SECURITY_HOLD: payout destinations cannot change during a security hold';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public."StepUpGrant" g WHERE g."id" = NEW."stepUpGrantId" AND g."userId" = NEW."userId"
                      AND g."purpose" = 'payout_destination' AND g."consumedAt" IS NOT NULL
                      AND g."method" IN ('PASSKEY', 'TOTP', 'PASSWORD_EMAIL')
                      AND (NEW."createdBySessionId" IS NULL OR g."sessionId" = NEW."createdBySessionId")) THEN
        RAISE EXCEPTION USING ERRCODE = 'PM009', MESSAGE = 'PAYMENT_STEP_UP_REQUIRED: a payout destination needs a consumed payout_destination grant';
      END IF;
    END IF;
    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."userId" <> OLD."userId" OR NEW."kind" <> OLD."kind" OR NEW."origin" <> OLD."origin"
     OR NEW."providerKey" <> OLD."providerKey" OR NEW."assetCode" <> OLD."assetCode"
     OR NEW."network" IS DISTINCT FROM OLD."network" OR NEW."address" IS DISTINCT FROM OLD."address"
     OR NEW."addressNormalized" IS DISTINCT FROM OLD."addressNormalized" OR NEW."memo" IS DISTINCT FROM OLD."memo"
     OR NEW."cardToken" IS DISTINCT FROM OLD."cardToken" OR NEW."cardFingerprint" IS DISTINCT FROM OLD."cardFingerprint"
     OR NEW."stepUpGrantId" IS DISTINCT FROM OLD."stepUpGrantId" OR NEW."createdBySessionId" IS DISTINCT FROM OLD."createdBySessionId"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."usableAfter" < OLD."usableAfter"
     OR NEW."successfulPayouts" < OLD."successfulPayouts" THEN
    RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: instrument identity is write-once';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT ((OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[
       'ACTIVE>REVOKED', 'ACTIVE>BLOCKED', 'BLOCKED>ACTIVE', 'BLOCKED>REVOKED'])) THEN
    RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = format('PAYMENT_BAD_TRANSITION: instrument %s -> %s', OLD."status", NEW."status");
  END IF;
  -- A card switched on for payouts later cools off from that moment.
  IF NEW."kind" = 'CARD_TOKEN' AND NEW."origin" <> 'OPERATOR' AND NEW."payoutEnabled" AND NOT OLD."payoutEnabled" THEN
    NEW."usableAfter" := GREATEST(NEW."usableAfter", CURRENT_TIMESTAMP + INTERVAL '24 hours');
  END IF;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "PaymentInstrument_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."PaymentInstrument"
  FOR EACH ROW EXECUTE FUNCTION public.payment_instrument_guard();

CREATE FUNCTION public.payment_deposit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
DECLARE
  v_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('poker.break_glass', true) IS NOT DISTINCT FROM 'on'
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = 'PAYMENT_IMMUTABLE: Deposit rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('CREATED', 'NEEDS_REVIEW') OR NEW."ledgerCreditTxId" IS NOT NULL
       OR NEW."reversedMinor" <> 0 OR NEW."recoveredMinor" <> 0 OR NEW."excessMinor" <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: a deposit starts CREATED or NEEDS_REVIEW, uncredited';
    END IF;
    SELECT a."kind"::text INTO v_kind FROM public."Asset" a WHERE a."code" = NEW."assetCode";
    IF v_kind IS NULL OR v_kind NOT IN ('FIAT', 'TEST')
       OR (v_kind = 'TEST') IS DISTINCT FROM (NEW."providerKey" ~ '^sandbox([-_.:]|$)') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: deposits book a fiat asset with a real provider, or a test asset with the sandbox';
    END IF;
    NEW."createdAt" := CURRENT_TIMESTAMP;
  ELSE
    IF NEW."id" <> OLD."id" OR NEW."userId" <> OLD."userId" OR NEW."method" <> OLD."method"
       OR NEW."providerKey" <> OLD."providerKey" OR NEW."assetCode" <> OLD."assetCode"
       OR NEW."requestedMinor" <> OLD."requestedMinor" OR NEW."createdAt" <> OLD."createdAt"
       OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
       OR (OLD."providerPaymentId" IS NOT NULL AND NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId")
       OR (OLD."instrumentId" IS NOT NULL AND NEW."instrumentId" IS DISTINCT FROM OLD."instrumentId")
       OR (OLD."ledgerCreditTxId" IS NOT NULL AND NEW."ledgerCreditTxId" IS DISTINCT FROM OLD."ledgerCreditTxId")
       OR ((OLD."reportedMinor" IS NOT NULL OR OLD."status" = 'NEEDS_REVIEW') AND NEW."reportedMinor" IS DISTINCT FROM OLD."reportedMinor")
       OR (OLD."status" IN ('CONFIRMED', 'CREDITED', 'PARTIALLY_REVERSED', 'REVERSED')
           AND NEW."creditedMinor" IS DISTINCT FROM OLD."creditedMinor")
       OR NEW."reversedMinor" < OLD."reversedMinor" OR NEW."recoveredMinor" < OLD."recoveredMinor"
       OR NEW."excessMinor" < OLD."excessMinor"
       OR (OLD."status" NOT IN ('CONFIRMED', 'CREATED', 'PENDING', 'NEEDS_REVIEW', 'FAILED', 'EXPIRED', 'CANCELLED')
           AND NEW."excessMinor" IS DISTINCT FROM OLD."excessMinor") THEN
      RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: deposit identity, amounts and ledger links are write-once';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT ((OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[
         'CREATED>PENDING', 'CREATED>CONFIRMED', 'CREATED>NEEDS_REVIEW', 'CREATED>FAILED', 'CREATED>EXPIRED', 'CREATED>CANCELLED',
         'PENDING>CONFIRMED', 'PENDING>NEEDS_REVIEW', 'PENDING>FAILED', 'PENDING>EXPIRED', 'PENDING>CANCELLED',
         'FAILED>CONFIRMED', 'EXPIRED>CONFIRMED', 'CANCELLED>CONFIRMED',
         'FAILED>NEEDS_REVIEW', 'EXPIRED>NEEDS_REVIEW', 'CANCELLED>NEEDS_REVIEW',
         'NEEDS_REVIEW>CONFIRMED', 'NEEDS_REVIEW>FAILED',
         'CONFIRMED>CREDITED',
         'CREDITED>PARTIALLY_REVERSED', 'CREDITED>REVERSED', 'PARTIALLY_REVERSED>REVERSED',
         'PARTIALLY_REVERSED>CREDITED', 'REVERSED>PARTIALLY_REVERSED', 'REVERSED>CREDITED'])) THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = format('PAYMENT_BAD_TRANSITION: deposit %s -> %s', OLD."status", NEW."status");
    END IF;
    -- A person resolving a deposit under review credits at most what the
    -- provider reported settling (written once, when it went to review), and
    -- a card at most what was asked: a card is charged the asked amount or a
    -- red flag. With no reported amount the request is the ceiling.
    IF OLD."status" = 'NEEDS_REVIEW' AND NEW."status" = 'CONFIRMED' AND NEW."creditedMinor" > (CASE
         WHEN NEW."method" = 'CARD' THEN LEAST(NEW."requestedMinor", COALESCE(NEW."reportedMinor", NEW."requestedMinor"))
         ELSE COALESCE(NEW."reportedMinor", NEW."requestedMinor") END) THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a reviewed deposit is credited at most the amount the provider reported';
    END IF;
    IF NEW."ledgerCreditTxId" IS NOT NULL AND OLD."ledgerCreditTxId" IS NULL AND NOT EXISTS (
         SELECT 1 FROM public."LedgerTransaction" t WHERE t."id" = NEW."ledgerCreditTxId" AND t."type" = 'DEPOSIT_CREDIT') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: ledgerCreditTxId must name a DEPOSIT_CREDIT';
    END IF;
    NEW."updatedAt" := CURRENT_TIMESTAMP;
  END IF;
  -- The card a deposit used is this user's card with this provider.
  IF NEW."instrumentId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."instrumentId" IS NULL) AND NOT EXISTS (
       SELECT 1 FROM public."PaymentInstrument" p WHERE p."id" = NEW."instrumentId" AND p."userId" = NEW."userId"
          AND p."providerKey" = NEW."providerKey" AND p."kind" = 'CARD_TOKEN') THEN
    RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a deposit names another user''s or another provider''s instrument';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "Deposit_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."Deposit"
  FOR EACH ROW EXECUTE FUNCTION public.payment_deposit_guard();

CREATE FUNCTION public.payment_withdrawal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
DECLARE
  v_admins integer;
  v_system boolean;
  v_dispatch record;
  v_quote record;
  v_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('poker.break_glass', true) IS NOT DISTINCT FROM 'on'
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = 'PAYMENT_IMMUTABLE: Withdrawal rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' OR NEW."holdTxId" IS NOT NULL OR NEW."releaseTxId" IS NOT NULL
       OR NEW."settleTxId" IS NOT NULL OR NEW."returnTxId" IS NOT NULL OR NEW."cancelRequestedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: a withdrawal starts REQUESTED';
    END IF;
    IF NEW."kind" = 'PLAYER' THEN
      IF EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = NEW."userId" AND u."securityHoldUntil" > CURRENT_TIMESTAMP) THEN
        RAISE EXCEPTION USING ERRCODE = 'PM008', MESSAGE = 'PAYMENT_SECURITY_HOLD: withdrawals are held after a security change';
      END IF;
      -- A player withdrawal is exactly its consumed quote ...
      SELECT q.* INTO v_quote FROM public."WithdrawalQuote" q WHERE q."id" = NEW."quoteId";
      IF NOT FOUND OR v_quote."userId" <> NEW."userId" OR v_quote."consumedAt" IS NULL
         OR v_quote."instrumentId" IS DISTINCT FROM NEW."instrumentId" OR v_quote."providerKey" IS DISTINCT FROM NEW."providerKey"
         OR v_quote."assetCode" <> NEW."assetCode" OR v_quote."amountMinor" <> NEW."amountMinor" OR v_quote."feeMinor" <> NEW."feeMinor" THEN
        RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a player withdrawal must equal its consumed quote';
      END IF;
      -- ... authorised by a consumed withdrawal grant bound to that quote.
      IF NOT EXISTS (SELECT 1 FROM public."StepUpGrant" g WHERE g."id" = NEW."stepUpGrantId" AND g."userId" = NEW."userId"
                      AND g."purpose" = 'withdrawal' AND g."bindHash" = v_quote."bindHash" AND g."consumedAt" IS NOT NULL
                      AND g."method" IN ('PASSKEY', 'TOTP', 'PASSWORD_EMAIL')
                      AND (NEW."sessionId" IS NULL OR g."sessionId" = NEW."sessionId")) THEN
        RAISE EXCEPTION USING ERRCODE = 'PM009', MESSAGE = 'PAYMENT_STEP_UP_REQUIRED: a withdrawal needs a consumed withdrawal grant for its quote';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public."Deposit" d WHERE d."id" = NEW."sourceDepositId" AND d."userId" = NEW."userId"
                       AND d."assetCode" = NEW."assetCode") THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a refund returns one of this user''s deposits in its asset';
    END IF;
    NEW."createdAt" := CURRENT_TIMESTAMP;
  ELSE
    IF NEW."id" <> OLD."id" OR NEW."userId" <> OLD."userId" OR NEW."kind" <> OLD."kind" OR NEW."assetCode" <> OLD."assetCode"
       OR NEW."amountMinor" <> OLD."amountMinor" OR NEW."feeMinor" <> OLD."feeMinor" OR NEW."createdAt" <> OLD."createdAt"
       OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
       OR NEW."quoteId" IS DISTINCT FROM OLD."quoteId"
       OR NEW."sourceDepositId" IS DISTINCT FROM OLD."sourceDepositId" OR NEW."stepUpGrantId" IS DISTINCT FROM OLD."stepUpGrantId"
       OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
       OR (OLD."holdTxId" IS NOT NULL AND NEW."holdTxId" IS DISTINCT FROM OLD."holdTxId")
       OR (OLD."releaseTxId" IS NOT NULL AND NEW."releaseTxId" IS DISTINCT FROM OLD."releaseTxId")
       OR (OLD."settleTxId" IS NOT NULL AND NEW."settleTxId" IS DISTINCT FROM OLD."settleTxId")
       OR (OLD."returnTxId" IS NOT NULL AND NEW."returnTxId" IS DISTINCT FROM OLD."returnTxId")
       OR (OLD."providerPayoutId" IS NOT NULL AND NEW."providerPayoutId" IS DISTINCT FROM OLD."providerPayoutId")
       OR (OLD."cancelRequestedAt" IS NOT NULL AND (NEW."cancelRequestedAt" IS DISTINCT FROM OLD."cancelRequestedAt"
           OR NEW."cancelCode" IS DISTINCT FROM OLD."cancelCode"))
       OR ((OLD."kind" = 'PLAYER' OR OLD."status" NOT IN ('REQUESTED', 'HELD', 'UNDER_REVIEW'))
           AND (NEW."instrumentId" IS DISTINCT FROM OLD."instrumentId" OR NEW."providerKey" IS DISTINCT FROM OLD."providerKey"))
       OR (OLD."status" <> 'REQUESTED' AND NOT (OLD."reviewReasons" <@ NEW."reviewReasons"))
       OR NEW."approvalsRequired" < OLD."approvalsRequired" THEN
      RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: withdrawal identity, amounts and ledger links are write-once';
    END IF;
    IF (NEW."holdTxId" IS NOT NULL AND OLD."holdTxId" IS NULL AND NOT EXISTS (SELECT 1 FROM public."LedgerTransaction" t
          WHERE t."id" = NEW."holdTxId" AND t."type" = 'WITHDRAWAL_HOLD'))
       OR (NEW."releaseTxId" IS NOT NULL AND OLD."releaseTxId" IS NULL AND NOT EXISTS (SELECT 1 FROM public."LedgerTransaction" t
          WHERE t."id" = NEW."releaseTxId" AND t."type" = 'WITHDRAWAL_RELEASE'))
       OR (NEW."settleTxId" IS NOT NULL AND OLD."settleTxId" IS NULL AND NOT EXISTS (SELECT 1 FROM public."LedgerTransaction" t
          WHERE t."id" = NEW."settleTxId" AND t."type" = 'WITHDRAWAL_SETTLE'))
       OR (NEW."returnTxId" IS NOT NULL AND OLD."returnTxId" IS NULL AND NOT EXISTS (SELECT 1 FROM public."LedgerTransaction" t
          WHERE t."id" = NEW."returnTxId" AND t."type" = 'WITHDRAWAL_RETURN')) THEN
      RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: a ledger link names the wrong transaction type';
    END IF;
    -- A cancel is asked for only before the provider has it, and from then on
    -- the withdrawal can only be released: it is never approved or submitted.
    IF NEW."cancelRequestedAt" IS NOT NULL AND OLD."cancelRequestedAt" IS NULL AND OLD."status" NOT IN ('HELD', 'UNDER_REVIEW', 'APPROVED') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: only a withdrawal that has not been sent can be marked for cancelling';
    END IF;
    IF NEW."cancelRequestedAt" IS NOT NULL AND NEW."status" <> OLD."status" AND NEW."status" IN ('APPROVED', 'SUBMITTED') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: a withdrawal marked for cancelling cannot go forward';
    END IF;
    IF NEW."status" <> OLD."status" THEN
      IF NOT ((OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[
           'REQUESTED>HELD', 'HELD>UNDER_REVIEW', 'HELD>APPROVED', 'HELD>REJECTED', 'HELD>CANCELLED',
           'UNDER_REVIEW>APPROVED', 'UNDER_REVIEW>REJECTED', 'UNDER_REVIEW>CANCELLED',
           'APPROVED>SUBMITTED', 'APPROVED>REJECTED', 'APPROVED>CANCELLED',
           'SUBMITTED>SETTLED', 'SUBMITTED>FAILED', 'SETTLED>RETURNED'])) THEN
        RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = format('PAYMENT_BAD_TRANSITION: withdrawal %s -> %s', OLD."status", NEW."status");
      END IF;
      IF NEW."status" = 'APPROVED' THEN
        SELECT count(DISTINCT a."actorUserId") INTO v_admins FROM public."PaymentReviewAction" a
         WHERE a."subjectType" = 'WITHDRAWAL' AND a."subjectId" = NEW."id"::text AND a."verb" = 'APPROVE' AND a."actorKind" = 'ADMIN';
        SELECT EXISTS (SELECT 1 FROM public."PaymentReviewAction" a WHERE a."subjectType" = 'WITHDRAWAL'
          AND a."subjectId" = NEW."id"::text AND a."verb" = 'APPROVE' AND a."actorKind" = 'SYSTEM') INTO v_system;
        IF NOT (v_admins >= NEW."approvalsRequired"
                OR (v_system AND jsonb_array_length(NEW."reviewReasons") = 0 AND NEW."approvalsRequired" = 1)) THEN
          RAISE EXCEPTION USING ERRCODE = 'PM004', MESSAGE = 'PAYMENT_APPROVAL_REQUIRED: not enough distinct approvals';
        END IF;
      END IF;
      IF OLD."status" = 'APPROVED' AND NEW."status" IN ('REJECTED', 'CANCELLED') THEN
        SELECT d."status", d."attempts" INTO v_dispatch FROM public."PayoutDispatch" d WHERE d."withdrawalId" = NEW."id";
        IF FOUND AND (v_dispatch."status" <> 'CANCELLED' OR v_dispatch."attempts" > 0) THEN
          RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: dispatch already started';
        END IF;
      END IF;
      IF NEW."status" = 'SUBMITTED' AND NOT EXISTS (SELECT 1 FROM public."PayoutDispatch" d WHERE d."withdrawalId" = NEW."id") THEN
        RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: SUBMITTED needs a PayoutDispatch row';
      END IF;
      -- Money is sent only to an active destination. The one exception is a
      -- refund to the card its own deposit was paid with (return to source,
      -- even after the card was revoked); a refund to an address someone
      -- named is a payout like any other.
      IF NEW."status" = 'SUBMITTED' AND NOT EXISTS (SELECT 1 FROM public."PaymentInstrument" p
           WHERE p."id" = NEW."instrumentId" AND p."status" = 'ACTIVE' AND p."payoutEnabled")
         AND NOT (NEW."kind" = 'REFUND' AND EXISTS (SELECT 1 FROM public."Deposit" d
           WHERE d."id" = NEW."sourceDepositId" AND d."instrumentId" = NEW."instrumentId")) THEN
        RAISE EXCEPTION USING ERRCODE = 'PM010', MESSAGE = 'PAYMENT_INSTRUMENT_UNAVAILABLE: a payout is sent only to an active destination';
      END IF;
    END IF;
    NEW."updatedAt" := CURRENT_TIMESTAMP;
  END IF;
  -- Whenever a destination is (newly) named: the sandbox pays out only test
  -- money, a real provider never; the instrument is this user's, with this provider.
  IF NEW."providerKey" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."providerKey" IS DISTINCT FROM NEW."providerKey") THEN
    SELECT a."kind"::text INTO v_kind FROM public."Asset" a WHERE a."code" = NEW."assetCode";
    IF v_kind IS NULL OR v_kind NOT IN ('FIAT', 'TEST')
       OR (v_kind = 'TEST') IS DISTINCT FROM (NEW."providerKey" ~ '^sandbox([-_.:]|$)') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: withdrawals book a fiat asset with a real provider, or a test asset with the sandbox';
    END IF;
  END IF;
  IF NEW."instrumentId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."instrumentId" IS DISTINCT FROM NEW."instrumentId"
                                         OR OLD."providerKey" IS DISTINCT FROM NEW."providerKey") THEN
    IF NOT EXISTS (SELECT 1 FROM public."PaymentInstrument" p WHERE p."id" = NEW."instrumentId" AND p."userId" = NEW."userId"
                    AND p."providerKey" IS NOT DISTINCT FROM NEW."providerKey") THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a withdrawal names another user''s or another provider''s instrument';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "Withdrawal_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."Withdrawal"
  FOR EACH ROW EXECUTE FUNCTION public.payment_withdrawal_guard();

CREATE FUNCTION public.payout_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = 'PAYMENT_IMMUTABLE: PayoutDispatch rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."attempts" <> 0 OR NEW."queries" <> 0 OR NEW."providerPayoutId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: a dispatch starts PENDING';
    END IF;
    -- One dispatch for an approved withdrawal, to the same user and provider.
    IF NOT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."id" = NEW."withdrawalId" AND w."status" = 'APPROVED'
                    AND w."userId" = NEW."userId" AND w."providerKey" = NEW."providerKey"
                    AND (NEW."operation" <> 'REFUND' OR w."kind" = 'REFUND')) THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a dispatch follows its approved withdrawal (user, provider, operation)';
    END IF;
    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  IF NEW."withdrawalId" <> OLD."withdrawalId" OR NEW."userId" <> OLD."userId" OR NEW."providerKey" <> OLD."providerKey"
     OR NEW."operation" <> OLD."operation" OR NEW."providerIdempotencyKey" <> OLD."providerIdempotencyKey"
     OR NEW."attempts" < OLD."attempts" OR NEW."queries" < OLD."queries" OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."providerPayoutId" IS NOT NULL AND NEW."providerPayoutId" IS DISTINCT FROM OLD."providerPayoutId") THEN
    RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: dispatch identity and idempotency key are fixed';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT ((OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[
       'PENDING>IN_FLIGHT', 'PENDING>CANCELLED', 'PENDING>MANUAL',
       'IN_FLIGHT>SENT', 'IN_FLIGHT>COMPLETED', 'IN_FLIGHT>FAILED', 'IN_FLIGHT>UNCERTAIN', 'IN_FLIGHT>RETRY_WAIT',
       'UNCERTAIN>IN_FLIGHT', 'UNCERTAIN>SENT', 'UNCERTAIN>COMPLETED', 'UNCERTAIN>FAILED', 'UNCERTAIN>MANUAL',
       'RETRY_WAIT>IN_FLIGHT', 'RETRY_WAIT>MANUAL', 'SENT>COMPLETED', 'SENT>FAILED', 'SENT>UNCERTAIN',
       'MANUAL>COMPLETED', 'MANUAL>FAILED'])) THEN
    RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = format('PAYMENT_BAD_TRANSITION: dispatch %s -> %s', OLD."status", NEW."status");
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" = 'CANCELLED' AND OLD."attempts" > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: a dispatch that was attempted cannot be cancelled';
  END IF;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "PayoutDispatch_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."PayoutDispatch"
  FOR EACH ROW EXECUTE FUNCTION public.payout_dispatch_guard();

CREATE FUNCTION public.payment_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('poker.break_glass', true) IS NOT DISTINCT FROM 'on'
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'PM001', MESSAGE = 'PAYMENT_IMMUTABLE: PaymentEvent rows cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['processedAt', 'outcome', 'attempts', 'nextAttemptAt', 'lastError'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['processedAt', 'outcome', 'attempts', 'nextAttemptAt', 'lastError'])
     OR NEW."attempts" < OLD."attempts"
     OR (OLD."outcome" IS NOT NULL AND OLD."outcome" <> 'DEAD'
         AND (NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."processedAt" IS DISTINCT FROM OLD."processedAt")) THEN
    RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: an event is immutable; only processing state changes once';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "PaymentEvent_guard" BEFORE UPDATE OR DELETE ON public."PaymentEvent"
  FOR EACH ROW EXECUTE FUNCTION public.payment_event_guard();

-- A quote names this user's usable payout destination with the same provider,
-- in money that provider may move; it is consumed once, before it expires,
-- and never changed otherwise.
CREATE FUNCTION public.withdrawal_quote_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
DECLARE
  v_kind text;
  v_instrument record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT a."kind"::text INTO v_kind FROM public."Asset" a WHERE a."code" = NEW."assetCode";
    IF v_kind IS NULL OR v_kind NOT IN ('FIAT', 'TEST')
       OR (v_kind = 'TEST') IS DISTINCT FROM (NEW."providerKey" ~ '^sandbox([-_.:]|$)') THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: quotes book a fiat asset with a real provider, or a test asset with the sandbox';
    END IF;
    SELECT p."userId", p."providerKey", p."status", p."payoutEnabled", p."usableAfter" INTO v_instrument
      FROM public."PaymentInstrument" p WHERE p."id" = NEW."instrumentId";
    IF NOT FOUND OR v_instrument."userId" <> NEW."userId" OR v_instrument."providerKey" <> NEW."providerKey" THEN
      RAISE EXCEPTION USING ERRCODE = 'PM006', MESSAGE = 'PAYMENT_MISMATCH: a quote names another user''s or another provider''s instrument';
    END IF;
    IF v_instrument."status" <> 'ACTIVE' OR NOT v_instrument."payoutEnabled" OR v_instrument."usableAfter" > CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION USING ERRCODE = 'PM010', MESSAGE = 'PAYMENT_INSTRUMENT_UNAVAILABLE: the destination is not active for payouts or is still cooling off';
    END IF;
    IF NEW."consumedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: a quote starts unconsumed';
    END IF;
    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'consumedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'consumedAt')
     OR OLD."consumedAt" IS NOT NULL OR NEW."consumedAt" IS NULL OR OLD."expiresAt" <= pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: a quote is consumed once, before it expires, and never changed';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "WithdrawalQuote_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."WithdrawalQuote"
  FOR EACH ROW EXECUTE FUNCTION public.withdrawal_quote_guard();

-- Four-eyes in the database: admins are real ADMINs, never approve their own
-- money, approve a subject (and reason) at most once, and the subject's owner
-- is the owner of the withdrawal or deposit named (so self-approval cannot
-- hide behind a wrong subjectUserId). The reason is part of what is approved
-- because a user subject is approved once per back-office adjustment
-- (reasonCode ADJUSTMENT:<key>); every four-eyes count is of distinct actors.
CREATE FUNCTION public.payment_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
DECLARE
  v_role text;
  v_owner text;
BEGIN
  NEW."createdAt" := CURRENT_TIMESTAMP;
  IF NEW."subjectType" IN ('WITHDRAWAL', 'DEPOSIT', 'INSTRUMENT') THEN
    IF NEW."subjectId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'PM004', MESSAGE = 'PAYMENT_APPROVAL_REQUIRED: the subject is not a payment id';
    END IF;
    IF NEW."subjectType" = 'WITHDRAWAL' THEN
      SELECT w."userId" INTO v_owner FROM public."Withdrawal" w WHERE w."id" = NEW."subjectId"::uuid;
    ELSIF NEW."subjectType" = 'INSTRUMENT' THEN
      SELECT p."userId" INTO v_owner FROM public."PaymentInstrument" p WHERE p."id" = NEW."subjectId"::uuid;
    ELSE
      SELECT d."userId" INTO v_owner FROM public."Deposit" d WHERE d."id" = NEW."subjectId"::uuid;
    END IF;
    IF v_owner IS NULL OR NEW."subjectUserId" IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION USING ERRCODE = 'PM004', MESSAGE = 'PAYMENT_APPROVAL_REQUIRED: subjectUserId must be the owner of the payment';
    END IF;
  ELSIF NEW."subjectType" = 'USER' AND NEW."subjectUserId" IS DISTINCT FROM NEW."subjectId" THEN
    RAISE EXCEPTION USING ERRCODE = 'PM004', MESSAGE = 'PAYMENT_APPROVAL_REQUIRED: subjectUserId must be the user named';
  END IF;
  IF NEW."actorKind" = 'ADMIN' THEN
    SELECT u."role"::text INTO v_role FROM public."User" u WHERE u."id" = NEW."actorUserId";
    IF v_role IS DISTINCT FROM 'ADMIN' THEN
      RAISE EXCEPTION USING ERRCODE = 'PM004', MESSAGE = 'PAYMENT_APPROVAL_REQUIRED: actor is not an administrator';
    END IF;
    IF NEW."verb" = 'APPROVE' THEN
      IF NEW."actorUserId" = NEW."subjectUserId" THEN
        RAISE EXCEPTION USING ERRCODE = 'PM004', MESSAGE = 'PAYMENT_APPROVAL_REQUIRED: administrators cannot approve their own payments';
      END IF;
      IF EXISTS (SELECT 1 FROM public."PaymentReviewAction" a WHERE a."subjectType" = NEW."subjectType"
                  AND a."subjectId" = NEW."subjectId" AND a."verb" = 'APPROVE' AND a."actorUserId" = NEW."actorUserId"
                  AND a."reasonCode" IS NOT DISTINCT FROM NEW."reasonCode") THEN
        RAISE EXCEPTION USING ERRCODE = 'PM004', MESSAGE = 'PAYMENT_APPROVAL_REQUIRED: the same administrator cannot approve twice';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "PaymentReviewAction_guard" BEFORE INSERT ON public."PaymentReviewAction"
  FOR EACH ROW EXECUTE FUNCTION public.payment_review_guard();

-- The outbox: identity fixed (column grants), SENT and CANCELLED final, attempts only grow.
CREATE FUNCTION public.email_outbox_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."attempts" <> 0 OR NEW."sentAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PM003', MESSAGE = 'PAYMENT_BAD_TRANSITION: an email starts PENDING';
    END IF;
    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'attempts', 'nextAttemptAt', 'leaseUntil', 'lastError', 'sentAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'attempts', 'nextAttemptAt', 'leaseUntil', 'lastError', 'sentAt'])
     OR NEW."attempts" < OLD."attempts"
     OR (OLD."status" IN ('SENT', 'CANCELLED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION USING ERRCODE = 'PM002', MESSAGE = 'PAYMENT_IMMUTABLE_FIELD: an email''s content is fixed and a sent or cancelled email is final';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "EmailOutbox_guard" BEFORE INSERT OR UPDATE ON public."EmailOutbox"
  FOR EACH ROW EXECUTE FUNCTION public.email_outbox_guard();

-- 7. Ledger entry points ------------------------------------------------------
-- ledger_post_core: the body of public.ledger_post from
-- 20261002200000_ledger_foundation, copied verbatim, with exactly five
-- changes: (a) the signature takes p_allowed and p_kinds first; (b) right
-- after the type is parsed, a type outside p_allowed is refused (LG022),
-- before any lookup; (c) an asset whose kind is outside p_kinds is refused
-- (LG022) while its row is locked, so the runtime's PLAY_GRANT, BUY_IN,
-- CASH_OUT and RAKE can never move sandbox or real money; (d) the shapes of
-- CHARGEBACK_RECOVERY and WITHDRAWAL_RETURN; (e) timezone UTC, so the
-- timestamps it writes are UTC whichever login calls it. Nobody may execute
-- it directly: only the three wrappers below call it (as its owner).
CREATE FUNCTION public.ledger_post_core(
  p_allowed text[], p_kinds text[], p_idempotency_key text, p_type text, p_reference jsonb, p_entries jsonb, p_created_by text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET timezone = 'UTC'
AS $fn$
DECLARE
  c_min CONSTANT numeric := -9223372036854775808;
  c_max CONSTANT numeric := 9223372036854775807;
  v_type public."LedgerTransactionType";
  v_n integer;
  v_entry jsonb;
  v_amount_text text;
  v_id_text text;
  v_num numeric;
  v_raw_ids bigint[] := '{}';
  v_raw_assets text[] := '{}';
  v_raw_amounts bigint[] := '{}';
  v_ids bigint[];
  v_assets text[];
  v_amounts bigint[];
  v_acc_types text[] := '{}';
  v_acc_users text[] := '{}';
  v_acc_providers text[] := '{}';
  v_acc_allow boolean[] := '{}';
  v_acc_balances bigint[] := '{}';
  v_acc record;
  v_asset record;
  v_canonical text;
  v_hash text;
  v_tx uuid;
  v_existing_hash text;
  v_enabled boolean;
  v_max bigint;
  v_kind text;
  v_shape text;
  v_new_balance numeric;
  v_version bigint;
  i integer;
BEGIN
  -- Request.
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,199}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'LG001', MESSAGE = 'LEDGER_BAD_REQUEST: idempotency key is missing or malformed';
  END IF;
  IF p_type IS NULL OR NOT (p_type = ANY (enum_range(NULL::public."LedgerTransactionType")::text[])) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG001', MESSAGE = 'LEDGER_BAD_REQUEST: unknown transaction type';
  END IF;
  v_type := p_type::public."LedgerTransactionType";
  -- The entry point decides which types its role may post (D-W3). Checked
  -- before any lookup, so a forbidden type learns nothing about keys or balances.
  IF p_allowed IS NULL OR NOT (p_type = ANY (p_allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG022',
      MESSAGE = format('LEDGER_TYPE_FORBIDDEN: %s is not allowed through this entry point', p_type);
  END IF;
  IF p_reference IS NULL OR jsonb_typeof(p_reference) <> 'object' OR octet_length(p_reference::text) > 4096 THEN
    RAISE EXCEPTION USING ERRCODE = 'LG001', MESSAGE = 'LEDGER_BAD_REQUEST: reference must be a JSON object of at most 4096 bytes';
  END IF;
  IF p_created_by IS NOT NULL AND length(p_created_by) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING ERRCODE = 'LG001', MESSAGE = 'LEDGER_BAD_REQUEST: createdBy must be 1..128 characters';
  END IF;

  -- Entries.
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'LG002', MESSAGE = 'LEDGER_MALFORMED_ENTRY: entries must be a JSON array';
  END IF;
  v_n := jsonb_array_length(p_entries);
  IF v_n < 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'LG003', MESSAGE = 'LEDGER_TOO_FEW_ENTRIES: a transaction needs at least two entries';
  END IF;
  IF v_n > 16 THEN
    RAISE EXCEPTION USING ERRCODE = 'LG015', MESSAGE = 'LEDGER_TOO_MANY_ENTRIES: at most 16 entries per transaction';
  END IF;
  FOR v_entry IN SELECT e.value FROM jsonb_array_elements(p_entries) AS e(value) LOOP
    -- Separate IF: SQL does not guarantee OR short-circuits, and
    -- jsonb_object_keys raises on a non-object instead of refusing cleanly.
    IF jsonb_typeof(v_entry) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'LG002', MESSAGE = 'LEDGER_MALFORMED_ENTRY: each entry must be a JSON object';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v_entry)) <> 3
       OR jsonb_typeof(v_entry -> 'accountId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_entry -> 'asset') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_entry -> 'amount') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING ERRCODE = 'LG002',
        MESSAGE = 'LEDGER_MALFORMED_ENTRY: each entry must be exactly {accountId, asset, amount} with string values';
    END IF;
    v_id_text := v_entry ->> 'accountId';
    v_amount_text := v_entry ->> 'amount';
    IF v_id_text !~ '^[1-9][0-9]{0,18}$' OR v_amount_text !~ '^-?[0-9]{1,40}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'LG002', MESSAGE = 'LEDGER_MALFORMED_ENTRY: accountId and amount must be decimal integers';
    END IF;
    -- Range-check in numeric before casting: an out-of-range text amount is a
    -- refusal with its own code, never a wrapped or rounded value.
    v_num := v_amount_text::numeric;
    IF v_num < c_min OR v_num > c_max OR v_id_text::numeric > c_max THEN
      RAISE EXCEPTION USING ERRCODE = 'LG004', MESSAGE = 'LEDGER_AMOUNT_OVERFLOW: value outside the BIGINT range';
    END IF;
    IF v_num = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'LG017', MESSAGE = 'LEDGER_ZERO_AMOUNT: entry amounts must be non-zero';
    END IF;
    IF v_id_text::bigint = ANY (v_raw_ids) THEN
      RAISE EXCEPTION USING ERRCODE = 'LG013', MESSAGE = 'LEDGER_DUPLICATE_ACCOUNT: an account may appear only once per transaction';
    END IF;
    v_raw_ids := array_append(v_raw_ids, v_id_text::bigint);
    v_raw_assets := array_append(v_raw_assets, v_entry ->> 'asset');
    v_raw_amounts := array_append(v_raw_amounts, v_num::bigint);
  END LOOP;
  -- Ascending account id: the lock order and the canonical payload order.
  SELECT array_agg(t.id ORDER BY t.id), array_agg(t.asset ORDER BY t.id), array_agg(t.amount ORDER BY t.id)
    INTO v_ids, v_assets, v_amounts
    FROM unnest(v_raw_ids, v_raw_assets, v_raw_amounts) AS t(id, asset, amount);

  IF EXISTS (SELECT 1 FROM unnest(v_assets, v_amounts) AS t(asset, amount)
              GROUP BY t.asset HAVING sum(t.amount) <> 0) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG008', MESSAGE = 'LEDGER_UNBALANCED: entries must sum to zero for each asset';
  END IF;

  -- Canonical payload: type, normalised JSONB text of the reference, entries
  -- in account order. createdBy is metadata and deliberately not hashed.
  SELECT string_agg(t.id::text || '|' || t.asset || '|' || t.amount::text, ';' ORDER BY t.id)
    INTO v_canonical FROM unnest(v_ids, v_assets, v_amounts) AS t(id, asset, amount);
  v_canonical := v_type::text || E'\n' || p_reference::text || E'\n' || v_canonical;
  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- Idempotent replay (fast path).
  SELECT t."id", t."payloadHash" INTO v_tx, v_existing_hash
    FROM public."LedgerTransaction" t WHERE t."idempotencyKey" = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_hash = v_hash THEN
      RETURN v_tx;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'LG012', MESSAGE = 'LEDGER_IDEMPOTENCY_CONFLICT: key already used with a different payload';
  END IF;

  -- Assets, each row locked FOR SHARE (bytewise code order) and checked as
  -- locked. Postings share the lock with each other; an administrator's
  -- UPDATE of the asset (disable, new cap) waits for postings in flight, and
  -- a posting that reaches the row while such an UPDATE is uncommitted waits
  -- for it and then sees the new values (READ COMMITTED re-reads a locked
  -- row). So once a disable has committed, no posting validated against the
  -- old "enabled" can still commit: the emergency stop is exact.
  FOR v_asset IN
    SELECT d.code FROM (SELECT DISTINCT x AS code FROM unnest(v_assets) AS x) d ORDER BY d.code COLLATE "C"
  LOOP
    SELECT a."enabled", a."maxAmount", a."kind"::text INTO v_enabled, v_max, v_kind
      FROM public."Asset" a WHERE a."code" = v_asset.code FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'LG010', MESSAGE = 'LEDGER_UNKNOWN_ASSET: asset does not exist';
    END IF;
    IF NOT v_enabled THEN
      RAISE EXCEPTION USING ERRCODE = 'LG009', MESSAGE = format('LEDGER_ASSET_DISABLED: asset %s is disabled', v_asset.code);
    END IF;
    -- The entry point also decides which kinds of money its role may move.
    IF p_kinds IS NULL OR NOT (v_kind = ANY (p_kinds)) THEN
      RAISE EXCEPTION USING ERRCODE = 'LG022',
        MESSAGE = format('LEDGER_TYPE_FORBIDDEN: %s assets (%s) cannot be moved through this entry point', v_kind, v_asset.code);
    END IF;
    -- No abs(): abs(-9223372036854775808) itself overflows.
    IF EXISTS (SELECT 1 FROM unnest(v_assets, v_amounts) AS t(asset, amount)
                WHERE t.asset = v_asset.code AND (t.amount > v_max OR t.amount < -v_max)) THEN
      RAISE EXCEPTION USING ERRCODE = 'LG005', MESSAGE = format('LEDGER_AMOUNT_LIMIT: an entry exceeds the %s per-entry limit', v_asset.code);
    END IF;
  END LOOP;

  -- Claim the key. A concurrent first attempt with the same key blocks here on
  -- the unique index until it commits (then this replays or conflicts) or
  -- rolls back (then this posts). Done before any account lock so a replay
  -- never waits on balances.
  BEGIN
    INSERT INTO public."LedgerTransaction" ("idempotencyKey", "type", "reference", "payloadHash", "createdBy")
    VALUES (p_idempotency_key, v_type, p_reference, v_hash, p_created_by)
    RETURNING "id" INTO v_tx;
  EXCEPTION WHEN unique_violation THEN
    SELECT t."id", t."payloadHash" INTO v_tx, v_existing_hash
      FROM public."LedgerTransaction" t WHERE t."idempotencyKey" = p_idempotency_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'LEDGER_RETRY: concurrent posting with this key is not visible in this snapshot';
    END IF;
    IF v_existing_hash = v_hash THEN
      RETURN v_tx;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'LG012', MESSAGE = 'LEDGER_IDEMPOTENCY_CONFLICT: key already used with a different payload';
  END;

  -- Lock accounts one at a time in ascending id order: every posting takes
  -- the same order, so crossing transfers cannot deadlock each other.
  FOR i IN 1 .. v_n LOOP
    SELECT a."assetCode", a."type"::text AS type, a."userId", a."providerKey", a."allowNegative", a."balance"
      INTO v_acc FROM public."LedgerAccount" a WHERE a."id" = v_ids[i] FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'LG006', MESSAGE = format('LEDGER_UNKNOWN_ACCOUNT: account %s does not exist', v_ids[i]);
    END IF;
    IF v_acc."assetCode" <> v_assets[i] THEN
      RAISE EXCEPTION USING ERRCODE = 'LG007',
        MESSAGE = format('LEDGER_ASSET_MISMATCH: account %s holds %s, entry says %s', v_ids[i], v_acc."assetCode", v_assets[i]);
    END IF;
    -- array_append keeps NULL owners as elements (positions stay aligned).
    v_acc_types := array_append(v_acc_types, v_acc.type);
    v_acc_users := array_append(v_acc_users, v_acc."userId");
    v_acc_providers := array_append(v_acc_providers, v_acc."providerKey");
    v_acc_allow := array_append(v_acc_allow, v_acc."allowNegative");
    v_acc_balances := array_append(v_acc_balances, v_acc."balance");
  END LOOP;

  -- Shape: which account types may appear in each transaction type, and with
  -- which sign (docs/money/LEDGER.md section 4). Tokens sorted bytewise.
  SELECT string_agg(s.token, ',' ORDER BY s.token COLLATE "C") INTO v_shape
    FROM (SELECT t.typ || CASE WHEN t.amount > 0 THEN '+' ELSE '-' END AS token
            FROM unnest(v_acc_types, v_amounts) AS t(typ, amount)) s;
  IF NOT (CASE v_type
    WHEN 'PLAY_GRANT' THEN v_shape = 'PLAY_ISSUANCE-,USER_AVAILABLE+'
    WHEN 'BUY_IN' THEN v_shape = 'TABLE_ESCROW+,USER_AVAILABLE-'
    WHEN 'CASH_OUT' THEN v_shape = 'TABLE_ESCROW-,USER_AVAILABLE+'
    WHEN 'RAKE' THEN v_shape = 'RAKE_REVENUE+,TABLE_ESCROW-'
    WHEN 'DEPOSIT_CREDIT' THEN v_shape = 'DEPOSIT_CLEARING-,USER_AVAILABLE+'
    WHEN 'DEPOSIT_REVERSAL' THEN v_shape IN (
      'DEPOSIT_CLEARING+,USER_AVAILABLE-', 'CHARGEBACK_LOSSES-,DEPOSIT_CLEARING+',
      'CHARGEBACK_LOSSES-,DEPOSIT_CLEARING+,USER_AVAILABLE-')
    WHEN 'WITHDRAWAL_HOLD' THEN v_shape = 'USER_AVAILABLE-,USER_WITHDRAWAL_HOLD+'
      AND (SELECT count(DISTINCT u) FROM unnest(v_acc_users) AS u) = 1
    WHEN 'WITHDRAWAL_RELEASE' THEN v_shape = 'USER_AVAILABLE+,USER_WITHDRAWAL_HOLD-'
      AND (SELECT count(DISTINCT u) FROM unnest(v_acc_users) AS u) = 1
    WHEN 'WITHDRAWAL_SETTLE' THEN v_shape IN (
      'USER_WITHDRAWAL_HOLD-,WITHDRAWAL_CLEARING+', 'PROVIDER_FEES+,USER_WITHDRAWAL_HOLD-,WITHDRAWAL_CLEARING+')
      AND (SELECT count(DISTINCT p) FROM unnest(v_acc_providers) AS p) = 1
    WHEN 'PROVIDER_FEE' THEN v_shape = 'ADJUSTMENTS-,PROVIDER_FEES+'
    WHEN 'ADJUSTMENT' THEN v_shape IN (
      'ADJUSTMENTS-,USER_AVAILABLE+', 'ADJUSTMENTS+,USER_AVAILABLE-',
      'PLAY_ISSUANCE-,USER_AVAILABLE+', 'PLAY_ISSUANCE+,USER_AVAILABLE-')
      AND p_created_by IS NOT NULL
      AND jsonb_typeof(p_reference -> 'reason') = 'string' AND length(btrim(p_reference ->> 'reason')) > 0
    WHEN 'CHARGEBACK_RECOVERY' THEN v_shape IN (
      'CHARGEBACK_LOSSES+,DEPOSIT_CLEARING-', 'DEPOSIT_CLEARING-,USER_AVAILABLE+',
      'CHARGEBACK_LOSSES+,DEPOSIT_CLEARING-,USER_AVAILABLE+')
    WHEN 'WITHDRAWAL_RETURN' THEN v_shape = 'USER_AVAILABLE+,WITHDRAWAL_CLEARING-'
    ELSE false
  END) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG018', MESSAGE = format('LEDGER_BAD_SHAPE: %s does not allow entries %s', v_type, v_shape);
  END IF;

  -- Apply.
  FOR i IN 1 .. v_n LOOP
    v_new_balance := v_acc_balances[i]::numeric + v_amounts[i];
    IF v_new_balance < c_min OR v_new_balance > c_max THEN
      RAISE EXCEPTION USING ERRCODE = 'LG004', MESSAGE = format('LEDGER_AMOUNT_OVERFLOW: account %s balance would leave the BIGINT range', v_ids[i]);
    END IF;
    IF v_new_balance < 0 AND NOT v_acc_allow[i] THEN
      RAISE EXCEPTION USING ERRCODE = 'LG011', MESSAGE = format('LEDGER_INSUFFICIENT_FUNDS: account %s', v_ids[i]);
    END IF;
    UPDATE public."LedgerAccount"
       SET "balance" = v_new_balance::bigint, "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = v_ids[i]
     RETURNING "version" INTO v_version;
    INSERT INTO public."LedgerEntry" ("transactionId", "accountId", "assetCode", "amount", "balanceAfter", "accountVersion")
    VALUES (v_tx, v_ids[i], v_assets[i], v_amounts[i], v_new_balance::bigint, v_version);
  END LOOP;
  RETURN v_tx;
END
$fn$;

-- The runtime entry point keeps its name, signature and ACL (EXECUTE for poker_server only).
CREATE OR REPLACE FUNCTION public.ledger_post(
  p_idempotency_key text, p_type text, p_reference jsonb, p_entries jsonb, p_created_by text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- PLAY only until real-money tables (Phase 2) lift this deliberately.
  RETURN public.ledger_post_core(ARRAY['PLAY_GRANT', 'BUY_IN', 'CASH_OUT', 'RAKE'], ARRAY['PLAY'],
    p_idempotency_key, p_type, p_reference, p_entries, p_created_by);
END
$fn$;

CREATE FUNCTION public.ledger_post_payments(
  p_idempotency_key text, p_type text, p_reference jsonb, p_entries jsonb, p_created_by text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RETURN public.ledger_post_core(ARRAY['DEPOSIT_CREDIT', 'DEPOSIT_REVERSAL', 'CHARGEBACK_RECOVERY', 'WITHDRAWAL_HOLD',
    'WITHDRAWAL_RELEASE', 'WITHDRAWAL_SETTLE', 'WITHDRAWAL_RETURN', 'PROVIDER_FEE'], ARRAY['FIAT', 'TEST'],
    p_idempotency_key, p_type, p_reference, p_entries, p_created_by);
END
$fn$;

-- Back office: ADJUSTMENT only, with a ticket and a second approver who is
-- not the author. The two names are typed by whoever holds the back-office
-- login, so for money (any asset that is not PLAY) they are not enough: two
-- distinct administrators must each have approved exactly this adjustment
-- (user, asset, signed amount, idempotency key) in the last 24 hours. Those
-- APPROVE rows can only be written by poker_payments (after an admin passkey
-- step-up) or the database owner; the back-office login cannot write them.
CREATE FUNCTION public.ledger_post_backoffice(
  p_idempotency_key text, p_type text, p_reference jsonb, p_entries jsonb, p_created_by text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_entry jsonb;
  v_user text;
  v_asset text;
  v_kind text;
  v_admins integer;
BEGIN
  IF p_created_by IS NULL OR p_reference IS NULL OR jsonb_typeof(p_reference) <> 'object'
     OR jsonb_typeof(p_reference -> 'ticket') IS DISTINCT FROM 'string' OR length(btrim(p_reference ->> 'ticket')) = 0
     OR jsonb_typeof(p_reference -> 'approvedBy') IS DISTINCT FROM 'string' OR length(btrim(p_reference ->> 'approvedBy')) = 0
     OR btrim(p_reference ->> 'approvedBy') = btrim(p_created_by) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG022',
      MESSAGE = 'LEDGER_TYPE_FORBIDDEN: back-office adjustments need reference.ticket and a second approver (approvedBy <> createdBy)';
  END IF;
  -- Malformed entries are left to ledger_post_core, which refuses them.
  IF jsonb_typeof(p_entries) = 'array' THEN
    FOR v_entry IN SELECT e.value FROM jsonb_array_elements(p_entries) AS e(value) LOOP
      -- Separate checks: SQL does not guarantee that OR short-circuits before a cast.
      CONTINUE WHEN jsonb_typeof(v_entry) IS DISTINCT FROM 'object';
      CONTINUE WHEN jsonb_typeof(v_entry -> 'accountId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_entry -> 'amount') IS DISTINCT FROM 'string';
      CONTINUE WHEN (v_entry ->> 'accountId') !~ '^[1-9][0-9]{0,18}$';
      CONTINUE WHEN (v_entry ->> 'accountId')::numeric > 9223372036854775807;
      SELECT a."userId", a."assetCode", s."kind"::text INTO v_user, v_asset, v_kind
        FROM public."LedgerAccount" a JOIN public."Asset" s ON s."code" = a."assetCode"
       WHERE a."id" = (v_entry ->> 'accountId')::bigint AND a."type" = 'USER_AVAILABLE';
      CONTINUE WHEN NOT FOUND OR v_kind = 'PLAY';
      SELECT count(DISTINCT r."actorUserId") INTO v_admins FROM public."PaymentReviewAction" r
       WHERE r."subjectType" = 'USER' AND r."subjectId" = v_user AND r."verb" = 'APPROVE' AND r."actorKind" = 'ADMIN'
         AND r."reasonCode" = 'ADJUSTMENT:' || p_idempotency_key
         AND r."metadata" ->> 'asset' = v_asset AND r."metadata" ->> 'amountMinor' = (v_entry ->> 'amount')
         AND r."createdAt" >= (pg_catalog.statement_timestamp() AT TIME ZONE 'UTC') - interval '24 hours';
      IF v_admins < 2 THEN
        RAISE EXCEPTION USING ERRCODE = 'LG022',
          MESSAGE = 'LEDGER_TYPE_FORBIDDEN: a money adjustment needs two administrators'' recorded approvals of exactly this adjustment';
      END IF;
    END LOOP;
  END IF;
  RETURN public.ledger_post_core(ARRAY['ADJUSTMENT'], ARRAY['PLAY', 'FIAT', 'TEST'], p_idempotency_key, p_type, p_reference, p_entries, p_created_by);
END
$fn$;

-- ledger_ensure_account, as in 20261002200000_ledger_foundation plus two
-- rules: provider accounts (clearing, fees) are in a TEST asset exactly when
-- the provider is the sandbox; table accounts (escrow, rake) are PLAY only
-- until real-money tables (Phase 2). Timezone UTC like ledger_post_core.
-- CREATE OR REPLACE keeps its ACL.
CREATE OR REPLACE FUNCTION public.ledger_ensure_account(
  p_asset text, p_type text, p_user_id text, p_table_id text, p_provider_key text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET timezone = 'UTC'
AS $fn$
DECLARE
  v_kind public."AssetKind";
  v_enabled boolean;
  v_type public."LedgerAccountType";
  v_owner_ok boolean;
  v_id bigint;
BEGIN
  IF p_type IS NULL OR NOT (p_type = ANY (enum_range(NULL::public."LedgerAccountType")::text[])) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG014', MESSAGE = 'LEDGER_BAD_ACCOUNT: unknown account type';
  END IF;
  v_type := p_type::public."LedgerAccountType";
  SELECT a."kind", a."enabled" INTO v_kind, v_enabled FROM public."Asset" a WHERE a."code" = p_asset;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'LG010', MESSAGE = 'LEDGER_UNKNOWN_ASSET: asset does not exist';
  END IF;
  IF NOT v_enabled THEN
    RAISE EXCEPTION USING ERRCODE = 'LG009', MESSAGE = format('LEDGER_ASSET_DISABLED: asset %s is disabled', p_asset);
  END IF;
  v_owner_ok := CASE
    WHEN v_type IN ('USER_AVAILABLE', 'USER_WITHDRAWAL_HOLD')
      THEN p_user_id IS NOT NULL AND p_user_id <> '' AND p_table_id IS NULL AND p_provider_key IS NULL
    WHEN v_type = 'TABLE_ESCROW'
      THEN p_table_id IS NOT NULL AND p_table_id <> '' AND p_user_id IS NULL AND p_provider_key IS NULL
    WHEN v_type IN ('DEPOSIT_CLEARING', 'WITHDRAWAL_CLEARING', 'PROVIDER_FEES')
      THEN p_provider_key IS NOT NULL AND p_provider_key ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
        AND p_user_id IS NULL AND p_table_id IS NULL
    ELSE p_user_id IS NULL AND p_table_id IS NULL AND p_provider_key IS NULL
  END;
  IF NOT v_owner_ok THEN
    RAISE EXCEPTION USING ERRCODE = 'LG014', MESSAGE = format('LEDGER_BAD_ACCOUNT: invalid owner for %s', v_type);
  END IF;
  IF (v_type IN ('PLAY_ISSUANCE', 'TABLE_ESCROW', 'RAKE_REVENUE') AND v_kind <> 'PLAY')
     OR (v_type IN ('USER_WITHDRAWAL_HOLD', 'DEPOSIT_CLEARING', 'WITHDRAWAL_CLEARING', 'PROVIDER_FEES',
                    'ADJUSTMENTS', 'CHARGEBACK_LOSSES') AND v_kind = 'PLAY') THEN
    RAISE EXCEPTION USING ERRCODE = 'LG014', MESSAGE = format('LEDGER_BAD_ACCOUNT: %s is not allowed for asset %s', v_type, p_asset);
  END IF;
  -- Sandbox money never meets a real provider, and the sandbox never holds real money.
  IF v_type IN ('DEPOSIT_CLEARING', 'WITHDRAWAL_CLEARING', 'PROVIDER_FEES')
     AND (v_kind::text = 'TEST') IS DISTINCT FROM (p_provider_key ~ '^sandbox([-_.:]|$)') THEN
    RAISE EXCEPTION USING ERRCODE = 'LG014',
      MESSAGE = format('LEDGER_BAD_ACCOUNT: %s of provider %s cannot hold %s (test assets only with the sandbox, the sandbox only test assets)', v_type, p_provider_key, p_asset);
  END IF;

  SELECT a."id" INTO v_id FROM public."LedgerAccount" a
   WHERE a."assetCode" = p_asset AND a."type" = v_type
     AND COALESCE(a."userId", '') = COALESCE(p_user_id, '')
     AND COALESCE(a."tableId", '') = COALESCE(p_table_id, '')
     AND COALESCE(a."providerKey", '') = COALESCE(p_provider_key, '');
  IF FOUND THEN
    RETURN v_id;
  END IF;
  BEGIN
    INSERT INTO public."LedgerAccount" ("assetCode", "type", "userId", "tableId", "providerKey", "allowNegative")
    VALUES (p_asset, v_type, p_user_id, p_table_id, p_provider_key,
            v_type IN ('PLAY_ISSUANCE', 'DEPOSIT_CLEARING', 'ADJUSTMENTS', 'CHARGEBACK_LOSSES'))
    ON CONFLICT DO NOTHING
    RETURNING "id" INTO v_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'LG019', MESSAGE = 'LEDGER_UNKNOWN_OWNER: the user or table does not exist';
  END;
  IF v_id IS NULL THEN
    -- A concurrent caller created it first; READ COMMITTED sees its commit.
    SELECT a."id" INTO v_id FROM public."LedgerAccount" a
     WHERE a."assetCode" = p_asset AND a."type" = v_type
       AND COALESCE(a."userId", '') = COALESCE(p_user_id, '')
       AND COALESCE(a."tableId", '') = COALESCE(p_table_id, '')
       AND COALESCE(a."providerKey", '') = COALESCE(p_provider_key, '');
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'LEDGER_RETRY: concurrent account creation is not visible in this snapshot';
    END IF;
  END IF;
  RETURN v_id;
END
$fn$;

-- Payment binding (D-W4): at commit, every deposit or withdrawal posting is
-- matched by exactly one payment row (the *TxId columns are unique) for the
-- same user, provider and asset with equal amounts; a reversal or recovery
-- also names a credited deposit of that user. moneyTx runs SET CONSTRAINTS
-- ALL IMMEDIATE last, so a violation surfaces as an ordinary error (LG023)
-- inside the transaction instead of at COMMIT.
CREATE FUNCTION public.ledger_check_payment_binding() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_assets integer;
  v_asset text;
  v_providers integer;
  v_provider text;
  v_users integer;
  v_user text;
  v_user_amt bigint;
  v_hold_amt bigint;
  v_dep_clearing bigint;
  v_wd_clearing bigint;
  v_fees bigint;
  v_ok boolean := false;
BEGIN
  SELECT count(DISTINCT e."assetCode"), max(e."assetCode"), count(DISTINCT a."providerKey"), max(a."providerKey"),
         count(DISTINCT a."userId"), max(a."userId"),
         COALESCE(sum(e."amount") FILTER (WHERE a."type" = 'USER_AVAILABLE'), 0),
         COALESCE(sum(e."amount") FILTER (WHERE a."type" = 'USER_WITHDRAWAL_HOLD'), 0),
         COALESCE(sum(e."amount") FILTER (WHERE a."type" = 'DEPOSIT_CLEARING'), 0),
         COALESCE(sum(e."amount") FILTER (WHERE a."type" = 'WITHDRAWAL_CLEARING'), 0),
         COALESCE(sum(e."amount") FILTER (WHERE a."type" = 'PROVIDER_FEES'), 0)
    INTO v_assets, v_asset, v_providers, v_provider, v_users, v_user, v_user_amt, v_hold_amt, v_dep_clearing, v_wd_clearing, v_fees
    FROM public."LedgerEntry" e JOIN public."LedgerAccount" a ON a."id" = e."accountId"
   WHERE e."transactionId" = NEW."id";
  IF v_assets = 1 AND v_providers <= 1 AND v_users <= 1 THEN
    CASE NEW."type"::text
      WHEN 'DEPOSIT_CREDIT' THEN
        SELECT EXISTS (SELECT 1 FROM public."Deposit" d WHERE d."ledgerCreditTxId" = NEW."id" AND d."userId" = v_user
          AND d."assetCode" = v_asset AND d."providerKey" = v_provider
          AND d."creditedMinor" = v_user_amt AND -v_dep_clearing = v_user_amt) INTO v_ok;
      WHEN 'DEPOSIT_REVERSAL' THEN
        SELECT EXISTS (SELECT 1 FROM public."DepositReversal" r JOIN public."Deposit" d ON d."id" = r."depositId"
          WHERE r."ledgerTxId" = NEW."id" AND r."kind" <> 'CHARGEBACK_RECOVERY'
            AND r."amountMinor" = v_dep_clearing AND r."userPortionMinor" = -v_user_amt
            AND r."providerKey" = v_provider AND (v_user IS NULL OR r."userId" = v_user)
            AND d."userId" = r."userId" AND d."providerKey" = r."providerKey" AND d."assetCode" = v_asset
            AND d."ledgerCreditTxId" IS NOT NULL) INTO v_ok;
      WHEN 'CHARGEBACK_RECOVERY' THEN
        SELECT EXISTS (SELECT 1 FROM public."DepositReversal" r JOIN public."Deposit" d ON d."id" = r."depositId"
            JOIN public."DepositReversal" o ON o."id" = r."recoversReversalId"
          WHERE r."ledgerTxId" = NEW."id" AND r."kind" = 'CHARGEBACK_RECOVERY'
            AND r."amountMinor" = -v_dep_clearing AND r."userPortionMinor" = v_user_amt
            AND r."providerKey" = v_provider AND (v_user IS NULL OR r."userId" = v_user)
            AND d."userId" = r."userId" AND d."providerKey" = r."providerKey" AND d."assetCode" = v_asset
            AND d."ledgerCreditTxId" IS NOT NULL
            AND o."depositId" = r."depositId" AND o."kind" <> 'CHARGEBACK_RECOVERY'
            AND r."amountMinor" <= o."amountMinor" AND r."userPortionMinor" <= o."userPortionMinor") INTO v_ok;
      WHEN 'WITHDRAWAL_HOLD' THEN
        SELECT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."holdTxId" = NEW."id" AND w."userId" = v_user
          AND w."assetCode" = v_asset AND w."amountMinor" = v_hold_amt) INTO v_ok;
      WHEN 'WITHDRAWAL_RELEASE' THEN
        SELECT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."releaseTxId" = NEW."id" AND w."userId" = v_user
          AND w."assetCode" = v_asset AND w."amountMinor" = -v_hold_amt
          AND w."status" IN ('FAILED', 'REJECTED', 'CANCELLED') AND w."settleTxId" IS NULL) INTO v_ok;
      WHEN 'WITHDRAWAL_SETTLE' THEN
        SELECT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."settleTxId" = NEW."id" AND w."userId" = v_user
          AND w."assetCode" = v_asset AND w."providerKey" = v_provider
          AND w."amountMinor" = -v_hold_amt AND w."feeMinor" = v_fees AND w."amountMinor" - w."feeMinor" = v_wd_clearing
          AND w."status" IN ('SETTLED', 'RETURNED') AND w."releaseTxId" IS NULL) INTO v_ok;
      WHEN 'WITHDRAWAL_RETURN' THEN
        SELECT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."returnTxId" = NEW."id" AND w."userId" = v_user
          AND w."assetCode" = v_asset AND w."providerKey" = v_provider AND w."status" = 'RETURNED'
          AND w."settleTxId" IS NOT NULL
          AND v_user_amt = -v_wd_clearing AND v_user_amt <= w."amountMinor" - w."feeMinor") INTO v_ok;
      ELSE v_ok := true;
    END CASE;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION USING ERRCODE = 'LG023',
      MESSAGE = format('LEDGER_UNBOUND_PAYMENT: %s transaction %s has no matching payment record', NEW."type", NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER "LedgerTransaction_payment_binding"
  AFTER INSERT ON public."LedgerTransaction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."type" IN ('DEPOSIT_CREDIT', 'DEPOSIT_REVERSAL', 'CHARGEBACK_RECOVERY', 'WITHDRAWAL_HOLD',
                       'WITHDRAWAL_RELEASE', 'WITHDRAWAL_SETTLE', 'WITHDRAWAL_RETURN'))
  EXECUTE FUNCTION public.ledger_check_payment_binding();

-- 8. RLS, grants, policies ----------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PlayerCompliance', 'ResponsibleGamingLimit', 'SelfExclusion', 'PaymentInstrument', 'Deposit',
    'DepositReversal', 'WithdrawalQuote', 'Withdrawal', 'PayoutDispatch', 'PayoutAttempt', 'PaymentEvent',
    'PaymentReviewAction', 'PaymentSwitch', 'ReconciliationRun', 'ReconciliationIssue', 'EmailOutbox'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    -- Supabase roles do not exist on plain local Postgres.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', t);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM poker_server, poker_payments, poker_backoffice', t);
    EXECUTE format('CREATE POLICY payments_rw ON public.%I TO poker_payments USING (true) WITH CHECK (true)', t);
    -- The SECURITY DEFINER binding check reads these under FORCE RLS (as ledger_definer does for the ledger).
    EXECUTE format('CREATE POLICY definer_read ON public.%I FOR SELECT TO %I USING (true)', t, current_user);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['Asset', 'LedgerAccount', 'LedgerTransaction', 'LedgerEntry'] LOOP
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO poker_payments, poker_backoffice', t);
    EXECUTE format('CREATE POLICY payments_read ON public.%I FOR SELECT TO poker_payments, poker_backoffice USING (true)', t);
  END LOOP;
END
$$;

-- poker_payments (the trigger guards narrow every UPDATE further)
GRANT SELECT, INSERT, UPDATE ON TABLE public."PlayerCompliance" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."ResponsibleGamingLimit" TO poker_payments;
GRANT UPDATE ("cancelledAt") ON TABLE public."ResponsibleGamingLimit" TO poker_payments;
GRANT SELECT ON TABLE public."SelfExclusion" TO poker_payments;
-- An administrator accepts an indefinite exclusion's reactivation through the payments Worker.
GRANT UPDATE ("reactivationAcceptedAt", "reactivationAcceptedBy") ON TABLE public."SelfExclusion" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."PaymentInstrument" TO poker_payments;
GRANT UPDATE ("status", "depositEnabled", "payoutEnabled", "label", "ownershipMethod", "ownershipProof",
  "ownershipVerifiedAt", "usableAfter", "lastUsedAt", "successfulPayouts", "revokedAt", "revokedReason", "revokedBy",
  "cardExpMonth", "cardExpYear", "updatedAt") ON TABLE public."PaymentInstrument" TO poker_payments;
GRANT SELECT, INSERT, UPDATE ON TABLE public."Deposit" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."DepositReversal" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."WithdrawalQuote" TO poker_payments;
GRANT UPDATE ("consumedAt") ON TABLE public."WithdrawalQuote" TO poker_payments;
GRANT SELECT, INSERT, UPDATE ON TABLE public."Withdrawal" TO poker_payments;
GRANT SELECT, INSERT, UPDATE ON TABLE public."PayoutDispatch" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."PayoutAttempt" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."PaymentEvent" TO poker_payments;
GRANT UPDATE ("processedAt", "outcome", "attempts", "nextAttemptAt", "lastError") ON TABLE public."PaymentEvent" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."PaymentReviewAction" TO poker_payments;
GRANT SELECT ON TABLE public."PaymentSwitch" TO poker_payments;
GRANT UPDATE ("enabled", "updatedBy", "reason", "updatedAt") ON TABLE public."PaymentSwitch" TO poker_payments;
GRANT SELECT, INSERT, UPDATE ON TABLE public."ReconciliationRun", public."ReconciliationIssue" TO poker_payments;
GRANT SELECT, INSERT ON TABLE public."EmailOutbox" TO poker_payments;
GRANT UPDATE ("status", "attempts", "nextAttemptAt", "leaseUntil", "lastError", "sentAt") ON TABLE public."EmailOutbox" TO poker_payments;
-- Other tables, read only and by column: who the user is, whether the session
-- is live, the security hold, security history, and the money step-up grants.
GRANT SELECT ("id", "username", "email", "emailVerifiedAt", "role", "kind", "isGuest", "securityHoldUntil", "createdAt")
  ON TABLE public."User" TO poker_payments;
CREATE POLICY payments_read ON public."User" FOR SELECT TO poker_payments, poker_backoffice USING (true);
GRANT SELECT ("id", "userId", "expiresAt", "absoluteExpiresAt", "revokedAt") ON TABLE public."Session" TO poker_payments;
CREATE POLICY payments_read ON public."Session" FOR SELECT TO poker_payments USING (true);
-- data: a "This wasn't me" report keeps what the notice named there, for the
-- sweep that applies a report payments never heard about. It holds small facts
-- only, never a token or a full address (auth/security-events.ts); ip and the
-- user agent stay unreadable.
GRANT SELECT ("id", "userId", "type", "createdAt", "data") ON TABLE public."AccountSecurityEvent" TO poker_payments;
CREATE POLICY payments_read ON public."AccountSecurityEvent" FOR SELECT TO poker_payments USING (true);
-- Override 8: payments verifies and consumes a grant inside the transaction it
-- authorises. The single-use trigger of 20261019100000_account_security
-- refuses a second consumption, a late one and any other change.
GRANT SELECT ON TABLE public."StepUpGrant" TO poker_payments;
GRANT UPDATE ("consumedAt") ON TABLE public."StepUpGrant" TO poker_payments;
CREATE POLICY payments_read ON public."StepUpGrant" FOR SELECT TO poker_payments USING (true);
CREATE POLICY payments_consume ON public."StepUpGrant" FOR UPDATE TO poker_payments USING (true) WITH CHECK (true);

-- poker_server (runtime): deposit limits and self-exclusion, whose timing
-- rules the triggers enforce. Nothing else: KYC identities (PlayerCompliance)
-- and the switches are read only by the payments Worker.
GRANT SELECT, INSERT ON TABLE public."ResponsibleGamingLimit" TO poker_server;
GRANT UPDATE ("cancelledAt") ON TABLE public."ResponsibleGamingLimit" TO poker_server;
CREATE POLICY runtime_rw ON public."ResponsibleGamingLimit" TO poker_server USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON TABLE public."SelfExclusion" TO poker_server;
GRANT UPDATE ("reactivationRequestedAt") ON TABLE public."SelfExclusion" TO poker_server;
CREATE POLICY runtime_rw ON public."SelfExclusion" TO poker_server USING (true) WITH CHECK (true);

-- poker_backoffice: read the money and the review history, accept a
-- self-exclusion reactivation. It writes no review action: approvals count
-- towards four-eyes rules, so only poker_payments records them (after an
-- admin passkey step-up).
GRANT SELECT ON TABLE public."PlayerCompliance", public."Deposit", public."DepositReversal", public."Withdrawal",
  public."PaymentReviewAction", public."SelfExclusion" TO poker_backoffice;
GRANT UPDATE ("reactivationAcceptedAt", "reactivationAcceptedBy") ON TABLE public."SelfExclusion" TO poker_backoffice;
GRANT SELECT ("id", "username", "email", "role", "kind", "isGuest", "createdAt") ON TABLE public."User" TO poker_backoffice;
CREATE POLICY backoffice_read ON public."PlayerCompliance" FOR SELECT TO poker_backoffice USING (true);
CREATE POLICY backoffice_read ON public."Deposit" FOR SELECT TO poker_backoffice USING (true);
CREATE POLICY backoffice_read ON public."DepositReversal" FOR SELECT TO poker_backoffice USING (true);
CREATE POLICY backoffice_read ON public."Withdrawal" FOR SELECT TO poker_backoffice USING (true);
CREATE POLICY backoffice_read ON public."PaymentReviewAction" FOR SELECT TO poker_backoffice USING (true);
CREATE POLICY backoffice_rw ON public."SelfExclusion" TO poker_backoffice USING (true) WITH CHECK (true);

-- Functions: nothing for PUBLIC or the Supabase roles; each group gets its own entry point.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.ledger_post_core(text[], text[], text, text, jsonb, jsonb, text)',
    'public.ledger_post_payments(text, text, jsonb, jsonb, text)',
    'public.ledger_post_backoffice(text, text, jsonb, jsonb, text)',
    'public.ledger_check_payment_binding()', 'public.payments_append_only()', 'public.deposit_reversal_guard()', 'public.rg_limit_guard()',
    'public.self_exclusion_guard()', 'public.payment_instrument_guard()', 'public.payment_deposit_guard()',
    'public.payment_withdrawal_guard()', 'public.payout_dispatch_guard()', 'public.payment_event_guard()',
    'public.withdrawal_quote_guard()', 'public.payment_review_guard()', 'public.email_outbox_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated, service_role', f);
    END IF;
  END LOOP;
END
$$;
GRANT EXECUTE ON FUNCTION public.ledger_post_payments(text, text, jsonb, jsonb, text) TO poker_payments;
GRANT EXECUTE ON FUNCTION public.ledger_post_backoffice(text, text, jsonb, jsonb, text) TO poker_backoffice;
GRANT EXECUTE ON FUNCTION public.ledger_ensure_account(text, text, text, text, text) TO poker_payments, poker_backoffice;

-- 9. RLS coverage now accepts a policy for any of the three application roles -
CREATE OR REPLACE FUNCTION public.poker_assert_rls() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  missing text;
  v_roles oid[];
BEGIN
  SELECT array_agg(oid) INTO v_roles FROM pg_roles WHERE rolname IN ('poker_server', 'poker_payments', 'poker_backoffice');
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
      OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polroles && v_roles)
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'RL001',
      MESSAGE = format('RLS_COVERAGE: public tables missing enabled+forced RLS or a policy for poker_server, poker_payments or poker_backoffice: %s. Use the boilerplate in 20261010120000_runtime_hardening, then SELECT public.poker_assert_rls().', missing);
  END IF;
END
$fn$;

-- 10. Sandbox asset and final assertions ---------------------------------------
-- TEST_EUR: enabled (the sandbox needs it) and worth nothing outside the
-- sandbox: no real provider account can ever hold it (ledger_ensure_account).
INSERT INTO public."Asset" ("code", "kind", "decimals", "chainDecimals", "network", "enabled", "maxAmount")
VALUES ('TEST_EUR', 'TEST', 2, NULL, NULL, true, 1000000000)
ON CONFLICT ("code") DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Asset" WHERE "code" = 'TEST_EUR' AND "kind"::text = 'TEST' AND "decimals" = 2) THEN
    RAISE EXCEPTION 'payments wallet: asset TEST_EUR exists with another kind or precision';
  END IF;
  IF has_function_privilege('poker_server', 'public.ledger_post_payments(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_server', 'public.ledger_post_backoffice(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_payments', 'public.ledger_post(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_payments', 'public.ledger_post_backoffice(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_backoffice', 'public.ledger_post(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_backoffice', 'public.ledger_post_payments(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_server', 'public.ledger_post_core(text[], text[], text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_payments', 'public.ledger_post_core(text[], text[], text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('poker_backoffice', 'public.ledger_post_core(text[], text[], text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('poker_server', 'public.ledger_post(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('poker_payments', 'public.ledger_post_payments(text, text, jsonb, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('poker_backoffice', 'public.ledger_post_backoffice(text, text, jsonb, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'payments wallet: ledger entry points are not isolated';
  END IF;
END
$$;
SELECT public.poker_assert_rls();
