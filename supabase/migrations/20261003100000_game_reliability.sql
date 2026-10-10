-- Game reliability (findings CR-004 / D12): a table the server can no longer
-- run is PAUSED for the operator instead of being retried forever.
-- Additive only, safe on a live database: two nullable columns on "Table"
-- (no default, so no table rewrite; every existing row stays NULL) and one new
-- table. No existing row is read, changed or backfilled.

ALTER TABLE public."Table" ADD COLUMN "pausedAt" TIMESTAMP(3), ADD COLUMN "pausedReason" TEXT;
ALTER TABLE public."Table" ADD CONSTRAINT "Table_pausedReason_length" CHECK ("pausedReason" IS NULL OR length("pausedReason") BETWEEN 1 AND 1000);

-- One row per incident; resolvedAt/resolvedBy are set together when an
-- operator closes it. The runtime role can never delete one (audit trail).
CREATE TABLE public."TableIncident" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  CONSTRAINT "TableIncident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TableIncident_valid" CHECK (
    "kind" ~ '^[A-Z][A-Z0-9_]{1,63}$'
    AND length("reason") BETWEEN 1 AND 1000
    AND ("resolvedAt" IS NULL) = ("resolvedBy" IS NULL)
    AND ("resolvedBy" IS NULL OR length("resolvedBy") BETWEEN 1 AND 128))
);
CREATE INDEX "TableIncident_tableId_createdAt_idx" ON public."TableIncident" ("tableId", "createdAt");
ALTER TABLE public."TableIncident" ADD CONSTRAINT "TableIncident_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES public."Table"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same pattern as 20260920140611_poker_security: row level security enabled
-- and forced, nothing for PUBLIC or the Supabase roles (which get default
-- privileges on new tables), and the runtime role through a server_only
-- policy. poker_server may record and resolve incidents, never delete them.
DO $$ BEGIN
  ALTER TABLE public."TableIncident" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public."TableIncident" FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public."TableIncident" FROM PUBLIC;
  -- Supabase roles do not exist on plain local Postgres.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public."TableIncident" FROM anon, authenticated, service_role;
  END IF;
  REVOKE ALL ON TABLE public."TableIncident" FROM poker_server;
  GRANT SELECT, INSERT, UPDATE ON TABLE public."TableIncident" TO poker_server;
  CREATE POLICY server_only ON public."TableIncident" TO poker_server USING (true) WITH CHECK (true);
END $$;
