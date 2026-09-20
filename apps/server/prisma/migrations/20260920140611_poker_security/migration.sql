-- Authoritative server owns gameplay; browser Supabase roles have no access.
ALTER TABLE public."Table" ADD COLUMN "stateCiphertext" TEXT;
ALTER TABLE public."Hand" ADD COLUMN "fairnessRoot" TEXT, ADD COLUMN "fairnessAudit" TEXT;
ALTER TABLE public."HandPlayer" ADD COLUMN "encryptedHoleCards" TEXT;
CREATE INDEX "Table_hostId_idx" ON public."Table" ("hostId");
CREATE UNIQUE INDEX "TableSeat_userId_key" ON public."TableSeat" ("userId");
ALTER TABLE public."User" ADD CONSTRAINT "User_bankroll_nonnegative" CHECK (bankroll >= 0);
ALTER TABLE public."Table" ADD CONSTRAINT "Table_valid_limits" CHECK (
  "maxSeats" BETWEEN 2 AND 9 AND "smallBlind" BETWEEN 1 AND 100000 AND "bigBlind" = 2 * "smallBlind"
  AND "minBuyIn" = 20 * "bigBlind" AND "maxBuyIn" = 200 * "bigBlind" AND "timeBankMs" > 0);
ALTER TABLE public."TableSeat" ADD CONSTRAINT "TableSeat_valid_stack" CHECK (stack >= 0 AND "seatIndex" BETWEEN 0 AND 8);
ALTER TABLE public."Hand" ADD CONSTRAINT "Hand_valid_amounts" CHECK ("potTotal" >= 0 AND rake >= 0 AND "handNumber" > 0);
ALTER TABLE public."HandPlayer" ADD CONSTRAINT "HandPlayer_valid_stacks" CHECK ("startingStack" >= 0 AND "endingStack" >= 0 AND net = "endingStack" - "startingStack");
ALTER TABLE public."HandAction" ADD CONSTRAINT "HandAction_valid_amount" CHECK (amount >= 0 AND ("toAmount" IS NULL OR "toAmount" >= 0));
ALTER TABLE public."HandPot" ADD CONSTRAINT "HandPot_valid_amount" CHECK (amount > 0);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poker_server') THEN
    CREATE ROLE poker_server NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO poker_server;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['User','Session','Table','TableSeat','Hand','HandPlayer','HandAction','HandPot','BotStatistic'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    -- Supabase roles do not exist on plain local Postgres.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO poker_server', t);
    EXECUTE format('CREATE POLICY server_only ON public.%I TO poker_server USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
-- Completed hand receipts are append-only to the application role.
REVOKE UPDATE, DELETE ON public."Hand", public."HandPlayer", public."HandAction", public."HandPot" FROM poker_server;
