-- Idempotency rows for table mutations (GameCommand).
-- Additive: a new table and index only. No existing row is read or changed.
--
-- RLS and grants follow the boilerplate in 20261010120000_runtime_hardening.
-- poker_assert_rls() fails closed if a public table lacks enabled+forced RLS
-- and a poker_server policy, so this migration applies that boilerplate and
-- then calls the assert. The runtime role may SELECT and INSERT, never
-- UPDATE or DELETE (same posture as append-only hand history). The existing
-- poker_refuse_history_mutation() trigger enforces that even if a grant is
-- widened later. There is no break-glass hatch beyond the one that function
-- already documents (poker.break_glass = 'on').

CREATE TABLE public."GameCommand" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "userId" TEXT,
  "kind" TEXT NOT NULL,
  "appliedRevision" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GameCommand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GameCommand_tableId_createdAt_idx" ON public."GameCommand"("tableId", "createdAt");

ALTER TABLE public."GameCommand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."GameCommand" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."GameCommand" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."GameCommand" FROM anon, authenticated, service_role';
  END IF;
END $$;
REVOKE ALL ON TABLE public."GameCommand" FROM poker_server;
GRANT SELECT, INSERT ON TABLE public."GameCommand" TO poker_server;
CREATE POLICY server_only ON public."GameCommand" TO poker_server USING (true) WITH CHECK (true);

CREATE TRIGGER "GameCommand_append_only" BEFORE UPDATE OR DELETE ON public."GameCommand"
  FOR EACH ROW EXECUTE FUNCTION public.poker_refuse_history_mutation();

SELECT public.poker_assert_rls();
