-- Compliance audit trail (GLI-19 / MGA): per-hand UUID v4, SHA-256 pre-deal deck
-- commitment, hash-chained event record and post-hand verification hash.
-- "auditRecord" is the public record (no hidden cards). "auditSealed" is the
-- AES-256-GCM encrypted regulator record (deck order and salts).
-- Immutability: Hand rows are already append-only to poker_server (UPDATE and
-- DELETE revoked in 20260920140611_poker_security; table-level privileges also
-- cover columns added later), so these columns cannot change once inserted.
ALTER TABLE public."Hand"
  ADD COLUMN "handUuid" UUID,
  ADD COLUMN "deckCommitment" TEXT,
  ADD COLUMN "finalStateHash" TEXT,
  ADD COLUMN "auditRecord" JSONB,
  ADD COLUMN "auditSealed" TEXT;
CREATE UNIQUE INDEX "Hand_handUuid_key" ON public."Hand" ("handUuid");
ALTER TABLE public."Hand" ADD CONSTRAINT "Hand_deckCommitment_sha256" CHECK ("deckCommitment" IS NULL OR "deckCommitment" ~ '^[a-f0-9]{64}$');
ALTER TABLE public."Hand" ADD CONSTRAINT "Hand_finalStateHash_sha256" CHECK ("finalStateHash" IS NULL OR "finalStateHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE public."Hand" ADD CONSTRAINT "Hand_audit_record_sealed_pair" CHECK (("auditRecord" IS NULL) = ("auditSealed" IS NULL));
-- An audited hand carries all of its indexed audit columns; a legacy hand carries none.
ALTER TABLE public."Hand" ADD CONSTRAINT "Hand_audit_columns_complete" CHECK (
  ("handUuid" IS NULL) = ("auditRecord" IS NULL) AND ("deckCommitment" IS NULL) = ("auditRecord" IS NULL)
  AND ("finalStateHash" IS NULL) = ("auditRecord" IS NULL));
