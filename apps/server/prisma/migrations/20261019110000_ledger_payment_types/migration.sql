-- Ledger vocabulary for the payments wallet (docs/money/WALLET.md,
-- docs/money/LEDGER.md sections 2 and 4). A migration of its own because a
-- value added by ALTER TYPE ... ADD VALUE cannot be used before its
-- transaction commits, and 20261019120000_payments_wallet uses all three
-- (trigger WHEN clauses, the TEST_EUR seed, the entry-point allow-lists).
--
-- CHARGEBACK_RECOVERY: the exact inverse of a DEPOSIT_REVERSAL after a won dispute.
-- WITHDRAWAL_RETURN:   a settled payout that the rail sent back.
-- AssetKind TEST:      sandbox money (TEST_EUR), never redeemable outside the sandbox provider.
--
-- Additive: no row is read or changed. IF NOT EXISTS keeps a re-run harmless.
ALTER TYPE "LedgerTransactionType" ADD VALUE IF NOT EXISTS 'CHARGEBACK_RECOVERY';
ALTER TYPE "LedgerTransactionType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_RETURN';
ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'TEST';
