/**
 * Deterministic idempotency keys (docs/money/WALLET.md section 8.2). Edge
 * only; not shared with apps/server.
 *
 * ledgerKeys are the ledger's (LedgerTransaction.idempotencyKey, format
 * IDEMPOTENCY_KEY in flows.ts): one key per money effect, derived from the
 * payment row it is bound to, so a replay of the same effect posts nothing
 * new. The payment binding trigger (LG023) makes a deposit credit exactly-once
 * even if a code path ever used another key: a Deposit names one ledger
 * transaction.
 *
 * providerIdempotency are the keys sent to a provider (PayoutDispatch
 * providerIdempotencyKey, ^[A-Za-z0-9:._-]{1,100}$): one per deposit session,
 * payout and refund, for the life of the row. A retry after a timeout must
 * reuse the same key, never mint a new one.
 */
import { createHash } from "node:crypto";

/** Longest provider-supplied value that is used verbatim inside a key. */
export const KEY_PART_MAX = 64;
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
/** The shape of a hashed part; a verbatim value of this shape is hashed too, so the two never collide. */
const HASHED_PART = /^h[0-9a-f]{47}$/;

/**
 * A provider-supplied id (or a ticket) as one key segment. Short, safe values
 * stay readable; anything longer, containing a separator (":" or "/") or
 * another character the key format refuses, becomes "h" + the first 47 hex
 * digits of its SHA-256 (188 bits). Deterministic, at most 64 characters.
 */
export function keyPart(value: string): string {
  if (value.length > 0 && value.length <= KEY_PART_MAX && SAFE_PART.test(value) && !HASHED_PART.test(value)) return value;
  return `h${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 47)}`;
}

export type ReversalKeyKind = "CHARGEBACK" | "PROVIDER_REFUND" | "CHAIN_REORG";

/**
 * Ledger idempotency keys. Ids we mint (deposit, withdrawal) are UUIDs and go
 * in verbatim; provider ids and tickets go through keyPart. Provider keys are
 * config (^[a-z0-9][a-z0-9_.:-]{0,63}$). Every key stays under 200 characters.
 * Phase 2 (runtime, real-money tables): buy-in:<tableId>:<commandId>:<userId>,
 * cash-out:<tableId>:<commandId>:<userId>, rake:<handUuid>.
 */
export const ledgerKeys = {
  depositCredit: (depositId: string) => `deposit-credit:${depositId}`,
  depositReversal: (providerKey: string, providerReversalId: string, kind: ReversalKeyKind) =>
    `deposit-reversal:${providerKey}:${kind}:${keyPart(providerReversalId)}`,
  chargebackRecovery: (providerKey: string, providerReversalId: string) => `chargeback-recovery:${providerKey}:${keyPart(providerReversalId)}`,
  depositFee: (depositId: string) => `provider-fee:deposit:${depositId}`,
  statementFee: (providerKey: string, lineId: string) => `provider-fee:statement:${providerKey}:${keyPart(lineId)}`,
  withdrawalHold: (withdrawalId: string) => `withdrawal-hold:${withdrawalId}`,
  withdrawalRelease: (withdrawalId: string) => `withdrawal-release:${withdrawalId}`,
  withdrawalSettle: (withdrawalId: string) => `withdrawal-settle:${withdrawalId}`,
  withdrawalReturn: (withdrawalId: string) => `withdrawal-return:${withdrawalId}`,
  adjustment: (ticket: string) => `adjustment:${keyPart(ticket)}`,
} as const;

/** Keys sent to providers. One per object for its whole life (a retry reuses it). */
export const providerIdempotency = {
  depositSession: (depositId: string) => `dep_${depositId}`,
  payout: (withdrawalId: string) => `wd_${withdrawalId}`,
  refund: (withdrawalId: string) => `rf_${withdrawalId}`,
} as const;

/** PayoutDispatch.providerIdempotencyKey's database format. */
export const PROVIDER_IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{1,100}$/;
