/**
 * Payments transactions (docs/money/WALLET.md section 8.3). Edge only.
 *
 * moneyTx runs one READ COMMITTED interactive transaction in UTC with short
 * lock and statement timeouts, ends it with SET CONSTRAINTS ALL IMMEDIATE (so the
 * deferred payment-binding check, LG023, fails as an ordinary error at a
 * known point instead of at COMMIT), retries what is safe to retry, and turns
 * every database refusal into one of three errors the RPC layer answers:
 *
 * - PaymentsRefusal: a domain answer (INSUFFICIENT_FUNDS 422, PAYMENTS_PAUSED
 *   503, DESTINATION_EXISTS 409, RG_RULE 422, SECURITY_HOLD 403,
 *   STEP_UP_REQUIRED 403, DESTINATION_UNAVAILABLE 409). Nothing was written.
 * - PaymentsUnavailable: infrastructure (connection loss, lock or statement
 *   timeout twice, retries exhausted). 503, retryable. Nothing was written.
 * - PaymentsInvariant: a bug (idempotency conflict, ledger invariant,
 *   forbidden type, unbound payment, PM001-PM004 or PM006). Logged with
 *   alert PAYMENTS_INVARIANT, answered 500, never retried.
 *
 * Never make an external HTTP call inside `fn`: provider calls happen between
 * transactions (recorded through the PaymentEvent inbox and PayoutDispatch
 * outbox). `fn` may run more than once (a retry re-reads everything).
 * SET CONSTRAINTS ALL IMMEDIATE stays in force for the rest of a transaction,
 * so a deferred check is only meaningful as the last statement; moneyTx
 * issues it after `fn` returns.
 */
import type { WalletErrorCode } from "@poker/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { logError, logWarn } from "../http/log";
import { LedgerError, sqlstateOf, toLedgerError } from "./ledger";

export interface MoneyTxOptions {
  /** Logged with every retry and failure; never the payload. */
  label: string;
  /** Total tries for retryable failures (serialization, deadlock, unique race, retryOn). Default 4. */
  attempts?: number;
  /** Also retry these ledger refusals (e.g. a reversal recomputing its user portion on INSUFFICIENT_FUNDS). */
  retryOn?: (error: LedgerError) => boolean;
  /** Test hook: the pause before retry n (1-based). Default 25 * 2^(n-1) + random(0..25) ms. */
  backoffMs?: (retry: number) => number;
}

/** What moneyTx needs of a Prisma client (an interactive $transaction). */
export type MoneyTxClient = Pick<PrismaClient, "$transaction">;
export type MoneyTx = Prisma.TransactionClient;

export const MONEY_TX_DEFAULTS = Object.freeze({
  attempts: 4,
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5_000,
  timeout: 15_000,
});

/** Base class of the errors moneyTx throws (instanceof checks; never thrown itself). */
export abstract class MoneyTxError extends Error {
  abstract readonly kind: "refusal" | "unavailable" | "invariant";
  constructor(
    readonly label: string,
    readonly code: WalletErrorCode,
    message: string,
    /** The database's refusal (LEDGER_*, PAYMENT_* or a SQLSTATE), for logs and tests. */
    readonly dbCode: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class PaymentsRefusal extends MoneyTxError {
  readonly kind = "refusal" as const;
  constructor(label: string, code: WalletErrorCode, message: string, dbCode: string | null, options?: { cause?: unknown }) {
    super(label, code, message, dbCode, options);
    this.name = "PaymentsRefusal";
  }
}

export class PaymentsUnavailable extends MoneyTxError {
  readonly kind = "unavailable" as const;
  readonly retryable = true;
  constructor(label: string, readonly reason: "timeout" | "connection" | "retries_exhausted", dbCode: string | null, options?: { cause?: unknown }) {
    super(label, "PAYMENTS_UNAVAILABLE", "Payments are temporarily unavailable. Please try again.", dbCode, options);
    this.name = "PaymentsUnavailable";
  }
}

export class PaymentsInvariant extends MoneyTxError {
  readonly kind = "invariant" as const;
  constructor(label: string, dbCode: string | null, options?: { cause?: unknown }) {
    super(label, "INTERNAL", "Something went wrong. The payment was not changed.", dbCode, options);
    this.name = "PaymentsInvariant";
  }
}

/** PMnnn refusals of the payments guards (migration 20261019120000_payments_wallet; docs/money/LEDGER.md section 11). */
export const PAYMENT_SQLSTATES: Readonly<Record<string, string>> = Object.freeze({
  PM001: "PAYMENT_IMMUTABLE",
  PM002: "PAYMENT_IMMUTABLE_FIELD",
  PM003: "PAYMENT_BAD_TRANSITION",
  PM004: "PAYMENT_APPROVAL_REQUIRED",
  PM005: "PAYMENT_DUPLICATE_INSTRUMENT",
  PM006: "PAYMENT_MISMATCH",
  PM007: "RG_RULE",
  PM008: "PAYMENT_SECURITY_HOLD",
  PM009: "PAYMENT_STEP_UP_REQUIRED",
  PM010: "PAYMENT_INSTRUMENT_UNAVAILABLE",
});

/** PMnnn that are domain answers (the rest are bugs: the core should have checked first). */
const PAYMENT_REFUSALS: Readonly<Record<string, { code: WalletErrorCode; message: string }>> = Object.freeze({
  PM005: { code: "DESTINATION_EXISTS", message: "This payout address is already saved." },
  PM007: { code: "RG_RULE", message: "A responsible-gaming rule does not allow this change yet." },
  PM008: { code: "SECURITY_HOLD", message: "Withdrawals and payout changes are paused after a recent security change." },
  PM009: { code: "STEP_UP_REQUIRED", message: "Please confirm this action again." },
  PM010: { code: "DESTINATION_UNAVAILABLE", message: "This payout destination cannot be used right now." },
});

/** How moneyTx treats one failure. */
export type MoneyTxDecision =
  | { action: "retry"; dbCode: string | null; reason: string }
  | { action: "retry-once"; dbCode: string }
  | { action: "throw"; error: MoneyTxError };

/**
 * Classifies a failure of one attempt (exported for the unit tests). `cause`
 * is the original error; nothing about it is logged except names and codes.
 */
export function classifyMoneyError(error: unknown, opts: Pick<MoneyTxOptions, "label" | "retryOn">): MoneyTxDecision {
  if (error instanceof MoneyTxError) return { action: "throw", error };
  const { label } = opts;
  const ledger = toLedgerError(error);
  if (ledger) {
    if (ledger.code === "RETRY") return { action: "retry", dbCode: ledger.dbCode, reason: "serialization" };
    if (opts.retryOn?.(ledger)) return { action: "retry", dbCode: ledger.dbCode, reason: "retryOn" };
    switch (ledger.code) {
      case "INSUFFICIENT_FUNDS":
        return { action: "throw", error: new PaymentsRefusal(label, "INSUFFICIENT_FUNDS", "Your balance is too low for this.", ledger.dbCode, { cause: error }) };
      case "ASSET_DISABLED":
        return { action: "throw", error: new PaymentsRefusal(label, "PAYMENTS_PAUSED", "Payments are paused. Please try again later.", ledger.dbCode, { cause: error }) };
      default:
        // IDEMPOTENCY_CONFLICT, INVARIANT, FORBIDDEN, UNBOUND.
        return { action: "throw", error: new PaymentsInvariant(label, ledger.dbCode, { cause: error }) };
    }
  }
  const code = (error as { code?: unknown } | null)?.code;
  // Prisma's own name for a write conflict or deadlock (adapter kind TransactionWriteConflict).
  if (code === "P2034") return { action: "retry", dbCode: "P2034", reason: "write-conflict" };
  const sqlstate = sqlstateOf(error);
  if (sqlstate === "55P03" || sqlstate === "57014") return { action: "retry-once", dbCode: sqlstate };
  // A concurrent insert won a unique race (e.g. the same Idempotency-Key twice): the retry finds its row.
  if (sqlstate === "23505" || code === "P2002") return { action: "retry", dbCode: sqlstate ?? "P2002", reason: "unique-race" };
  if (sqlstate && /^PM\d{3}$/.test(sqlstate)) {
    const refusal = PAYMENT_REFUSALS[sqlstate];
    const dbCode = PAYMENT_SQLSTATES[sqlstate] ?? sqlstate;
    if (refusal) return { action: "throw", error: new PaymentsRefusal(label, refusal.code, refusal.message, dbCode, { cause: error }) };
    return { action: "throw", error: new PaymentsInvariant(label, dbCode, { cause: error }) };
  }
  if (sqlstate) {
    // Any other database refusal (a CHECK, a foreign key, a type error) is a bug in the caller.
    return { action: "throw", error: new PaymentsInvariant(label, sqlstate, { cause: error }) };
  }
  // No SQLSTATE: the connection, the pool or Prisma's transaction itself failed.
  return { action: "throw", error: new PaymentsUnavailable(label, "connection", null, { cause: error }) };
}

function defaultBackoff(retry: number): number {
  return 25 * 2 ** (retry - 1) + Math.floor(Math.random() * 26);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Names and codes only: Prisma messages can contain a connection string. */
function errorFields(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { errName: "Unknown" };
  const sqlstate = sqlstateOf(error);
  const code = (error as { code?: unknown }).code;
  return { errName: error.name, ...(typeof code === "string" ? { errCode: code } : {}), ...(sqlstate ? { sqlstate } : {}) };
}

/**
 * Runs `fn` in a payments transaction (see the module comment). Returns its
 * result, or throws PaymentsRefusal / PaymentsUnavailable / PaymentsInvariant.
 */
export async function moneyTx<T>(prisma: MoneyTxClient, fn: (tx: MoneyTx) => Promise<T>, opts: MoneyTxOptions): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? MONEY_TX_DEFAULTS.attempts);
  const backoff = opts.backoffMs ?? defaultBackoff;
  let timeouts = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // TIMESTAMP(3) columns hold UTC and money checks compare them with CURRENT_TIMESTAMP (grant and
        // quote expiry, cooling-off): pinned here, not left to the login's default time zone.
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
        const result = await fn(tx);
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        return result;
      }, { isolationLevel: MONEY_TX_DEFAULTS.isolationLevel, maxWait: MONEY_TX_DEFAULTS.maxWait, timeout: MONEY_TX_DEFAULTS.timeout });
    } catch (error) {
      const decision = classifyMoneyError(error, opts);
      if (decision.action === "throw") {
        if (decision.error instanceof PaymentsInvariant) {
          logError({ alert: "PAYMENTS_INVARIANT", label: opts.label, dbCode: decision.error.dbCode, attempt, ...errorFields(error) }, "a payments transaction hit a database invariant");
        } else if (decision.error instanceof PaymentsUnavailable) {
          logWarn({ label: opts.label, attempt, ...errorFields(error) }, "a payments transaction failed (infrastructure)");
        }
        throw decision.error;
      }
      if (decision.action === "retry-once") {
        timeouts += 1;
        if (timeouts > 1 || attempt >= attempts) {
          logWarn({ label: opts.label, attempt, dbCode: decision.dbCode }, "a payments transaction timed out twice");
          throw new PaymentsUnavailable(opts.label, "timeout", decision.dbCode, { cause: error });
        }
      } else if (attempt >= attempts) {
        if (decision.reason === "unique-race") {
          // Still colliding after every retry: not a race but a bug (a key reused for another row).
          logError({ alert: "PAYMENTS_INVARIANT", label: opts.label, dbCode: decision.dbCode, attempt }, "a payments transaction kept violating a unique constraint");
          throw new PaymentsInvariant(opts.label, decision.dbCode, { cause: error });
        }
        logWarn({ label: opts.label, attempt, dbCode: decision.dbCode, reason: decision.reason }, "a payments transaction ran out of retries");
        throw new PaymentsUnavailable(opts.label, "retries_exhausted", decision.dbCode, { cause: error });
      }
      await sleep(backoff(attempt));
    }
  }
}
