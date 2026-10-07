-- Money ledger foundation (docs/money/LEDGER.md).
-- Additive only: new enums, tables, functions and triggers. No existing row is
-- read, changed or backfilled; User.bankroll stays authoritative until the
-- integration step moves the money flows onto the ledger.
-- Balances change ONLY through public.ledger_post (SECURITY DEFINER); the
-- runtime role poker_server can read the ledger and execute the two functions
-- but has no write privilege on any ledger table.

CREATE TYPE "AssetKind" AS ENUM ('PLAY', 'FIAT', 'CRYPTO');
CREATE TYPE "LedgerAccountType" AS ENUM (
  'USER_AVAILABLE', 'USER_WITHDRAWAL_HOLD', 'TABLE_ESCROW', 'PLAY_ISSUANCE', 'RAKE_REVENUE',
  'DEPOSIT_CLEARING', 'WITHDRAWAL_CLEARING', 'PROVIDER_FEES', 'ADJUSTMENTS', 'CHARGEBACK_LOSSES');
CREATE TYPE "LedgerTransactionType" AS ENUM (
  'PLAY_GRANT', 'BUY_IN', 'CASH_OUT', 'RAKE', 'DEPOSIT_CREDIT', 'DEPOSIT_REVERSAL',
  'WITHDRAWAL_HOLD', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_SETTLE', 'PROVIDER_FEE', 'ADJUSTMENT');

-- decimals = precision of the ledger minor unit; chainDecimals = on-chain
-- precision (ETH is booked in gwei: decimals 9, chainDecimals 18).
-- maxAmount bounds the magnitude of a single entry (overflow headroom).
CREATE TABLE public."Asset" (
  "code" TEXT NOT NULL,
  "kind" "AssetKind" NOT NULL,
  "decimals" SMALLINT NOT NULL,
  "chainDecimals" SMALLINT,
  "network" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "maxAmount" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Asset_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "Asset_valid" CHECK (
    "code" ~ '^[A-Z][A-Z0-9_]{1,31}$'
    AND "decimals" BETWEEN 0 AND 18
    AND "maxAmount" > 0
    AND ("kind" <> 'PLAY' OR ("decimals" = 0 AND "chainDecimals" IS NULL AND "network" IS NULL))
    AND (("kind" = 'CRYPTO') = ("chainDecimals" IS NOT NULL AND "network" IS NOT NULL))
    AND ("chainDecimals" IS NULL OR "chainDecimals" BETWEEN "decimals" AND 36)
    AND ("network" IS NULL OR "network" ~ '^[a-z][a-z0-9-]{1,31}$'))
);

-- One account per (asset, type, owner). The owner columns are nullable, so
-- uniqueness is over COALESCE(owner, '') (equivalent to NULLS NOT DISTINCT,
-- portable to every supported Postgres version); empty-string owners are
-- refused by the CHECKs below so they cannot collide with "no owner".
-- allowNegative is a function of the type, never chosen per account.
CREATE TABLE public."LedgerAccount" (
  "id" BIGSERIAL NOT NULL,
  "assetCode" TEXT NOT NULL,
  "type" "LedgerAccountType" NOT NULL,
  "userId" TEXT,
  "tableId" TEXT,
  "providerKey" TEXT,
  "allowNegative" BOOLEAN NOT NULL DEFAULT false,
  "balance" BIGINT NOT NULL DEFAULT 0,
  "version" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerAccount_id_assetCode_key" UNIQUE ("id", "assetCode"),
  CONSTRAINT "LedgerAccount_balance_sign" CHECK ("balance" >= 0 OR "allowNegative"),
  CONSTRAINT "LedgerAccount_version_nonnegative" CHECK ("version" >= 0),
  CONSTRAINT "LedgerAccount_negative_by_type" CHECK (
    "allowNegative" = ("type" IN ('PLAY_ISSUANCE', 'DEPOSIT_CLEARING', 'ADJUSTMENTS', 'CHARGEBACK_LOSSES'))),
  CONSTRAINT "LedgerAccount_owner_matches_type" CHECK (
    CASE
      WHEN "type" IN ('USER_AVAILABLE', 'USER_WITHDRAWAL_HOLD')
        THEN "userId" IS NOT NULL AND "userId" <> '' AND "tableId" IS NULL AND "providerKey" IS NULL
      WHEN "type" = 'TABLE_ESCROW'
        THEN "tableId" IS NOT NULL AND "tableId" <> '' AND "userId" IS NULL AND "providerKey" IS NULL
      WHEN "type" IN ('DEPOSIT_CLEARING', 'WITHDRAWAL_CLEARING', 'PROVIDER_FEES')
        THEN "providerKey" IS NOT NULL AND "userId" IS NULL AND "tableId" IS NULL
      ELSE "userId" IS NULL AND "tableId" IS NULL AND "providerKey" IS NULL
    END),
  CONSTRAINT "LedgerAccount_providerKey_format" CHECK (
    "providerKey" IS NULL OR "providerKey" ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$')
);
CREATE UNIQUE INDEX "LedgerAccount_owner_key" ON public."LedgerAccount" (
  "assetCode", "type", (COALESCE("userId", '')), (COALESCE("tableId", '')), (COALESCE("providerKey", '')));
CREATE INDEX "LedgerAccount_userId_idx" ON public."LedgerAccount" ("userId");
CREATE INDEX "LedgerAccount_tableId_idx" ON public."LedgerAccount" ("tableId");
-- RESTRICT everywhere: an account with history must outlive nothing it refers to.
ALTER TABLE public."LedgerAccount" ADD CONSTRAINT "LedgerAccount_assetCode_fkey"
  FOREIGN KEY ("assetCode") REFERENCES public."Asset"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."LedgerAccount" ADD CONSTRAINT "LedgerAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public."LedgerAccount" ADD CONSTRAINT "LedgerAccount_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES public."Table"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE public."LedgerTransaction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "seq" BIGSERIAL NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "type" "LedgerTransactionType" NOT NULL,
  "reference" JSONB NOT NULL DEFAULT '{}',
  "payloadHash" TEXT NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerTransaction_valid" CHECK (
    "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,199}$'
    AND "payloadHash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("reference") = 'object'
    AND ("createdBy" IS NULL OR length("createdBy") BETWEEN 1 AND 128))
);
CREATE UNIQUE INDEX "LedgerTransaction_seq_key" ON public."LedgerTransaction" ("seq");
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON public."LedgerTransaction" ("idempotencyKey");

-- (accountId, accountVersion) is unique: each entry is one numbered step of
-- its account's history, so the cached balance can be replayed and checked.
CREATE TABLE public."LedgerEntry" (
  "id" BIGSERIAL NOT NULL,
  "transactionId" UUID NOT NULL,
  "accountId" BIGINT NOT NULL,
  "assetCode" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "balanceAfter" BIGINT NOT NULL,
  "accountVersion" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerEntry_valid" CHECK ("amount" <> 0 AND "accountVersion" > 0)
);
CREATE UNIQUE INDEX "LedgerEntry_accountId_accountVersion_key" ON public."LedgerEntry" ("accountId", "accountVersion");
CREATE INDEX "LedgerEntry_transactionId_idx" ON public."LedgerEntry" ("transactionId");
ALTER TABLE public."LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES public."LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Composite key: an entry's asset is structurally its account's asset.
ALTER TABLE public."LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_assetCode_fkey"
  FOREIGN KEY ("accountId", "assetCode") REFERENCES public."LedgerAccount"("id", "assetCode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Real assets ship disabled; only an administrator enables one.
INSERT INTO public."Asset" ("code", "kind", "decimals", "chainDecimals", "network", "enabled", "maxAmount") VALUES
  ('PLAY',       'PLAY',   0, NULL, NULL,       true,  1000000000000),
  ('EUR',        'FIAT',   2, NULL, NULL,       false, 1000000000),
  ('BTC',        'CRYPTO', 8, 8,    'bitcoin',  false, 100000000000),
  ('ETH',        'CRYPTO', 9, 18,   'ethereum', false, 10000000000000),
  ('USDT_ERC20', 'CRYPTO', 6, 6,    'ethereum', false, 10000000000000),
  ('USDT_TRC20', 'CRYPTO', 6, 6,    'tron',     false, 10000000000000),
  ('USDC_ERC20', 'CRYPTO', 6, 6,    'ethereum', false, 10000000000000)
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- ledger_ensure_account: idempotent, race-safe account creation. Validates the
-- asset (exists, enabled), the type, the owner columns for the type and the
-- asset kind for the type (PLAY_ISSUANCE is PLAY-only; holds, provider and
-- house-equity accounts are real-asset only, so PLAY can never be withdrawn).
-- The owner's existence is checked by the foreign keys (RI checks bypass RLS,
-- so the function never has to read "User"/"Table" itself).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.ledger_ensure_account(
  p_asset text, p_type text, p_user_id text, p_table_id text, p_provider_key text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
  IF (v_type = 'PLAY_ISSUANCE' AND v_kind <> 'PLAY')
     OR (v_type IN ('USER_WITHDRAWAL_HOLD', 'DEPOSIT_CLEARING', 'WITHDRAWAL_CLEARING', 'PROVIDER_FEES',
                    'ADJUSTMENTS', 'CHARGEBACK_LOSSES') AND v_kind = 'PLAY') THEN
    RAISE EXCEPTION USING ERRCODE = 'LG014', MESSAGE = format('LEDGER_BAD_ACCOUNT: %s is not allowed for asset %s', v_type, p_asset);
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

-- ---------------------------------------------------------------------------
-- ledger_post: the only way a balance changes.
-- p_entries: JSON array of {"accountId": "<digits>", "asset": "<code>", "amount": "<signed digits>"};
-- amounts and ids are strings so no float can round them on the way.
-- Order of checks: request shape -> entry parsing -> per-asset balance ->
-- idempotent replay -> assets (FOR SHARE, code order) -> key claim -> account
-- locks (ascending id) -> transaction shape -> balances. A replay therefore
-- returns the original id even when the balances would no longer allow the
-- posting. Lock order, for every posting: asset rows, then the key, then the
-- accounts by ascending id; no posting ever waits for a lock "backwards".
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.ledger_post(
  p_idempotency_key text, p_type text, p_reference jsonb, p_entries jsonb, p_created_by text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
    SELECT a."enabled", a."maxAmount" INTO v_enabled, v_max
      FROM public."Asset" a WHERE a."code" = v_asset.code FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'LG010', MESSAGE = 'LEDGER_UNKNOWN_ASSET: asset does not exist';
    END IF;
    IF NOT v_enabled THEN
      RAISE EXCEPTION USING ERRCODE = 'LG009', MESSAGE = format('LEDGER_ASSET_DISABLED: asset %s is disabled', v_asset.code);
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

-- ---------------------------------------------------------------------------
-- Journal immutability for every role (the runtime role has no write
-- privilege anyway; this also stops an administrator's accidental UPDATE or
-- DELETE). Deliberate maintenance must drop/disable the trigger, which is
-- itself an audited DDL change.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.ledger_refuse_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'LG016', MESSAGE = format('LEDGER_IMMUTABLE: %s rows are append-only', TG_TABLE_NAME);
END
$fn$;
CREATE TRIGGER "LedgerTransaction_append_only" BEFORE UPDATE OR DELETE ON public."LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION public.ledger_refuse_mutation();
CREATE TRIGGER "LedgerEntry_append_only" BEFORE UPDATE OR DELETE ON public."LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION public.ledger_refuse_mutation();

-- ---------------------------------------------------------------------------
-- Privilege columns on "User": the runtime role keeps UPDATE on the table (it
-- maintains bankroll, lastSeenAt, ...) but may never change role or kind, so a
-- stolen runtime credential cannot mint an ADMIN or turn a human into a bot.
-- Only those two columns are compared, so columns added later stay writable.
-- SECURITY INVOKER on purpose: current_user is the role running the UPDATE.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.user_guard_privileged_columns() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF current_user = 'poker_server' AND (NEW."role" IS DISTINCT FROM OLD."role" OR NEW."kind" IS DISTINCT FROM OLD."kind") THEN
    RAISE EXCEPTION USING ERRCODE = 'LG020', MESSAGE = 'USER_PRIVILEGE_CHANGE_FORBIDDEN: the runtime role cannot change User.role or User.kind';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "User_guard_privileged_columns" BEFORE UPDATE ON public."User"
  FOR EACH ROW EXECUTE FUNCTION public.user_guard_privileged_columns();

-- ---------------------------------------------------------------------------
-- Every hand the runtime role records from now on carries the full compliance
-- audit trail (20260924120000_compliance_audit_trail). Existing legacy rows
-- are untouched (INSERT-only trigger); administrators restoring legacy
-- history are not affected.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.hand_require_audit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF current_user = 'poker_server' AND (NEW."auditRecord" IS NULL OR NEW."auditSealed" IS NULL OR NEW."handUuid" IS NULL
      OR NEW."deckCommitment" IS NULL OR NEW."finalStateHash" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG021', MESSAGE = 'HAND_AUDIT_REQUIRED: hands must be recorded with the compliance audit trail';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "Hand_require_audit" BEFORE INSERT ON public."Hand"
  FOR EACH ROW EXECUTE FUNCTION public.hand_require_audit();

-- ---------------------------------------------------------------------------
-- Grants. Same pattern as 20260920140611_poker_security, but read-only:
-- poker_server gets SELECT and a SELECT-only policy (so even a mistaken later
-- write grant stays blocked by RLS). The ledger_definer policy lets the
-- SECURITY DEFINER functions (owned by the migration role) work under FORCE
-- ROW LEVEL SECURITY even where that role lacks BYPASSRLS.
-- Supabase gives anon/authenticated/service_role default privileges on new
-- tables, sequences and functions; those are revoked explicitly.
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['Asset','LedgerAccount','LedgerTransaction','LedgerEntry'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', t);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM poker_server', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO poker_server', t);
    EXECUTE format('CREATE POLICY server_only ON public.%I FOR SELECT TO poker_server USING (true)', t);
    EXECUTE format('CREATE POLICY ledger_definer ON public.%I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['LedgerAccount_id_seq','LedgerTransaction_seq_seq','LedgerEntry_id_seq'] LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon, authenticated, service_role', t);
    END IF;
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM poker_server', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'public.ledger_ensure_account(text, text, text, text, text)',
    'public.ledger_post(text, text, jsonb, jsonb, text)',
    'public.ledger_refuse_mutation()',
    'public.user_guard_privileged_columns()',
    'public.hand_require_audit()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated, service_role', t);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.ledger_ensure_account(text, text, text, text, text) TO poker_server;
GRANT EXECUTE ON FUNCTION public.ledger_post(text, text, jsonb, jsonb, text) TO poker_server;
