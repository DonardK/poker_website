/**
 * Client of the money ledger (docs/money/LEDGER.md). The same file is
 * apps/server/src/money/ledger.ts and apps/edge/src/money/ledger.ts
 * (apps/edge/scripts/check-money-parity.mjs keeps them byte-identical).
 *
 * Every balance change goes through a SECURITY DEFINER entry point, which
 * re-validates everything: balance per asset, account/asset match, enabled
 * assets, per-entry cap, transaction shape, overdraft, idempotency. Each
 * database role has its own entry point and may post only its own types
 * (ENTRY_POINT; LEDGER.md section 10): public.ledger_post for the runtime
 * (poker_server), public.ledger_post_payments for the payments Worker
 * (poker_payments), public.ledger_post_backoffice for the operator
 * (poker_backoffice). This module only builds requests, resolves account ids
 * and maps the database's refusals to LedgerError. No role has a write
 * privilege on the ledger tables, so there is no other path.
 *
 * All functions take the caller's Prisma client or interactive-transaction
 * client: call them inside the same transaction as the game/payment state
 * change they account for (after locking that state's rows), so both commit
 * or neither does. A refusal raises, which aborts that transaction. A deposit
 * or withdrawal posting must be bound to its payment row in the same
 * transaction, or the database refuses the commit (LEDGER_UNBOUND_PAYMENT).
 */
import { AmountError, assertBigintRange } from "./amounts.js";
import {
  assertBalanced,
  assertIdempotencyKey,
  planAdjustment,
  planBuyIn,
  planCashOut,
  planCreditDeposit,
  planGrantPlay,
  planHoldWithdrawal,
  planProviderFee,
  planRake,
  planRecoverChargeback,
  planReleaseWithdrawal,
  planReturnWithdrawal,
  planReverseDeposit,
  planSettleWithdrawal,
  type AccountSpec,
  type LedgerAccountType,
  type LedgerReference,
  type LedgerTransactionType,
  type PostingPlan,
} from "./flows.js";

/**
 * PrismaClient or an interactive-transaction client (only tagged-template raw
 * queries are used). Structural, so this file needs no generated Prisma types
 * and compiles in both workspaces (NodeNext and bundler resolution).
 */
export interface LedgerDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export type LedgerErrorCode =
  | "INSUFFICIENT_FUNDS"
  | "IDEMPOTENCY_CONFLICT"
  | "INVARIANT"
  | "ASSET_DISABLED"
  | "RETRY"
  /** LG022 LEDGER_TYPE_FORBIDDEN (the entry point refuses the type), or Postgres 42501 (the role may not call it). */
  | "FORBIDDEN"
  /** LG023 LEDGER_UNBOUND_PAYMENT: a payment-type posting without exactly one matching payment row, at commit. */
  | "UNBOUND";

/** The database entry point (and so the database role) allowed to post each type. */
export type LedgerEntryPoint = "runtime" | "payments" | "backoffice";

export const ENTRY_POINT: Readonly<Record<LedgerTransactionType, LedgerEntryPoint>> = Object.freeze({
  PLAY_GRANT: "runtime",
  BUY_IN: "runtime",
  CASH_OUT: "runtime",
  RAKE: "runtime",
  DEPOSIT_CREDIT: "payments",
  DEPOSIT_REVERSAL: "payments",
  CHARGEBACK_RECOVERY: "payments",
  WITHDRAWAL_HOLD: "payments",
  WITHDRAWAL_RELEASE: "payments",
  WITHDRAWAL_SETTLE: "payments",
  WITHDRAWAL_RETURN: "payments",
  PROVIDER_FEE: "payments",
  ADJUSTMENT: "backoffice",
});

/**
 * A refusal by the ledger. `code` is what callers branch on; `dbCode` is the
 * precise database refusal (e.g. LEDGER_BAD_SHAPE) for logs and tests.
 * RETRY (SQLSTATE 40001 serialization failure or 40P01 deadlock) means: roll
 * back and retry the whole transaction; nothing was posted.
 */
export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    readonly dbCode: string,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export function isLedgerError(error: unknown): error is LedgerError {
  return error instanceof LedgerError;
}

/** SQLSTATE raised by the ledger functions -> the refusal's message prefix (docs/money/LEDGER.md section 11). */
export const LEDGER_SQLSTATES: Readonly<Record<string, string>> = Object.freeze({
  LG001: "LEDGER_BAD_REQUEST",
  LG002: "LEDGER_MALFORMED_ENTRY",
  LG003: "LEDGER_TOO_FEW_ENTRIES",
  LG004: "LEDGER_AMOUNT_OVERFLOW",
  LG005: "LEDGER_AMOUNT_LIMIT",
  LG006: "LEDGER_UNKNOWN_ACCOUNT",
  LG007: "LEDGER_ASSET_MISMATCH",
  LG008: "LEDGER_UNBALANCED",
  LG009: "LEDGER_ASSET_DISABLED",
  LG010: "LEDGER_UNKNOWN_ASSET",
  LG011: "LEDGER_INSUFFICIENT_FUNDS",
  LG012: "LEDGER_IDEMPOTENCY_CONFLICT",
  LG013: "LEDGER_DUPLICATE_ACCOUNT",
  LG014: "LEDGER_BAD_ACCOUNT",
  LG015: "LEDGER_TOO_MANY_ENTRIES",
  LG016: "LEDGER_IMMUTABLE",
  LG017: "LEDGER_ZERO_AMOUNT",
  LG018: "LEDGER_BAD_SHAPE",
  LG019: "LEDGER_UNKNOWN_OWNER",
  LG022: "LEDGER_TYPE_FORBIDDEN",
  LG023: "LEDGER_UNBOUND_PAYMENT",
});
const KNOWN_DB_CODES: ReadonlySet<string> = new Set([...Object.values(LEDGER_SQLSTATES), "LEDGER_RETRY"]);
const LEDGER_MESSAGE = /\b(LEDGER_[A-Z_]+)\b/;
/**
 * The SQLSTATEs this module maps: the ledger's own (LGnnn), Postgres' retry
 * conditions, and 42501 (insufficient_privilege: this role may not execute
 * that entry point; refused before any lookup).
 */
const MAPPED_SQLSTATE = /^(?:LG\d{3}|40001|40P01|42501)$/;

/** Where a driver error keeps the database's own SQLSTATE and message. */
interface DriverErrorShape {
  code?: unknown;
  message?: unknown;
  meta?: { code?: unknown; message?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } };
  cause?: { originalCode?: unknown; originalMessage?: unknown };
}

const isSqlstate = (value: unknown): value is string => typeof value === "string" && /^[0-9A-Z]{5}$/.test(value);

/**
 * The Postgres SQLSTATE of a driver error, if it carries one. Prisma's own
 * `code` is P1000..P6999 and never a SQLSTATE. The places, in order:
 * - Prisma's library engine (apps/server): meta.code;
 * - Prisma with a driver adapter (apps/edge, @prisma/adapter-pg 6.19): a raw
 *   query or a mapped constraint error (P2010, P2002, ...) carries it in
 *   meta.driverAdapterError.cause.originalCode, and a model query that a
 *   trigger refuses throws the DriverAdapterError itself, with cause.originalCode;
 * - node-postgres: code.
 */
export function sqlstateOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as DriverErrorShape;
  for (const value of [candidate.meta?.code, candidate.meta?.driverAdapterError?.cause?.originalCode, candidate.cause?.originalCode]) {
    if (isSqlstate(value)) return value;
  }
  const code = candidate.code;
  if (isSqlstate(code) && !/^P[1-9][0-9]{3}$/.test(code)) return code;
  return undefined;
}

/** Every message a driver error carries (the database's own first), one per line. */
function messagesOf(candidate: DriverErrorShape): string {
  return [candidate.meta?.driverAdapterError?.cause?.originalMessage, candidate.cause?.originalMessage, candidate.meta?.message, candidate.message]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function codeFor(dbCode: string): LedgerErrorCode {
  switch (dbCode) {
    case "LEDGER_INSUFFICIENT_FUNDS": return "INSUFFICIENT_FUNDS";
    case "LEDGER_IDEMPOTENCY_CONFLICT": return "IDEMPOTENCY_CONFLICT";
    case "LEDGER_ASSET_DISABLED": return "ASSET_DISABLED";
    case "LEDGER_RETRY":
    case "SERIALIZATION_FAILURE":
    case "DEADLOCK_DETECTED": return "RETRY";
    case "LEDGER_TYPE_FORBIDDEN":
    case "PERMISSION_DENIED": return "FORBIDDEN";
    case "LEDGER_UNBOUND_PAYMENT": return "UNBOUND";
    default: return "INVARIANT";
  }
}

/**
 * Maps a database error raised by the ledger functions to LedgerError, or
 * returns null for anything else (connection loss, timeouts, ...), which the
 * caller must propagate unchanged: an infrastructure failure is not a refusal.
 *
 * The SQLSTATE decides whenever the driver exposes it (sqlstateOf):
 * LG001..LG023 are the ledger's
 * refusals (table in docs/money/LEDGER.md section 11); 40001 (serialization
 * failure, including LEDGER_RETRY) and 40P01 (deadlock detected) both mean
 * "roll back and retry the whole transaction" and map to RETRY; 42501 (the
 * role may not execute that entry point) maps to FORBIDDEN. Without a
 * SQLSTATE, a known LEDGER_* message prefix is matched instead.
 */
export function toLedgerError(error: unknown): LedgerError | null {
  if (error instanceof LedgerError) return error;
  if (!error || typeof error !== "object") return null;
  const candidate = error as DriverErrorShape;
  const text = messagesOf(candidate);
  const sqlstate = sqlstateOf(candidate);
  const prefix = LEDGER_MESSAGE.exec(text)?.[1];
  let dbCode: string | undefined;
  if (sqlstate === "40001") dbCode = prefix === "LEDGER_RETRY" ? prefix : "SERIALIZATION_FAILURE";
  else if (sqlstate === "40P01") dbCode = "DEADLOCK_DETECTED";
  else if (sqlstate === "42501") dbCode = "PERMISSION_DENIED";
  else if (sqlstate) dbCode = MAPPED_SQLSTATE.test(sqlstate) ? LEDGER_SQLSTATES[sqlstate] : undefined;
  else if (prefix && KNOWN_DB_CODES.has(prefix)) dbCode = prefix;
  if (!dbCode) return null;
  const lines = text.split("\n").map((part) => part.trim()).filter((part) => part.length > 0);
  const line = lines.find((part) => part.includes(dbCode)) ?? lines[0] ?? dbCode;
  return new LedgerError(codeFor(dbCode), dbCode, line.slice(0, 500));
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toLedgerError(error) ?? error;
  }
}

/** Returns the id of the account for (asset, type, owner), creating it if needed. */
export async function ensureAccount(db: LedgerDb, spec: AccountSpec): Promise<bigint> {
  const rows = await guarded(() => db.$queryRaw<Array<{ id: string }>>`
    SELECT public.ledger_ensure_account(${spec.asset}::text, ${spec.type}::text, ${spec.userId ?? null}::text,
      ${spec.tableId ?? null}::text, ${spec.providerKey ?? null}::text)::text AS id`);
  const id = rows[0]?.id;
  if (!id) throw new LedgerError("INVARIANT", "LEDGER_BAD_ACCOUNT", "ledger_ensure_account returned no id");
  return BigInt(id);
}

export interface LedgerEntryInput {
  accountId: bigint;
  asset: string;
  /** Signed, non-zero minor units. */
  amount: bigint;
}

export interface PostInput {
  key: string;
  type: LedgerTransactionType;
  reference: LedgerReference;
  entries: LedgerEntryInput[];
  createdBy?: string | null;
}

/**
 * Posts one balanced transaction through the entry point of its type
 * (ENTRY_POINT) and returns its id. Replaying the same key with the same
 * payload returns the original id without posting again; the same key with a
 * different payload is IDEMPOTENCY_CONFLICT. Amounts and ids travel as
 * decimal strings (the database refuses JSON numbers). The connection's role
 * must own that entry point: anything else is FORBIDDEN.
 */
export async function post(db: LedgerDb, input: PostInput): Promise<string> {
  assertIdempotencyKey(input.key);
  const entryPoint = Object.prototype.hasOwnProperty.call(ENTRY_POINT, input.type) ? ENTRY_POINT[input.type] : undefined;
  if (!entryPoint) throw new LedgerError("INVARIANT", "LEDGER_BAD_REQUEST", "unknown transaction type");
  // Fail fast on an obviously invalid request; the database checks it again.
  try {
    assertBalanced(input.entries);
    for (const entry of input.entries) assertBigintRange(entry.accountId, "accountId");
  } catch (error) {
    if (error instanceof AmountError) throw new LedgerError("INVARIANT", "LEDGER_UNBALANCED", error.message);
    throw error;
  }
  const entries = JSON.stringify(input.entries.map((entry) => ({
    accountId: entry.accountId.toString(),
    asset: entry.asset,
    amount: entry.amount.toString(),
  })));
  const reference = JSON.stringify(input.reference ?? {});
  const createdBy = input.createdBy ?? null;
  // Three literal statements (no SQL built from strings): the function name is never a parameter.
  const rows = await guarded(() => {
    switch (entryPoint) {
      case "runtime":
        return db.$queryRaw<Array<{ id: string }>>`
          SELECT public.ledger_post(${input.key}::text, ${input.type}::text, ${reference}::jsonb, ${entries}::jsonb,
            ${createdBy}::text)::text AS id`;
      case "payments":
        return db.$queryRaw<Array<{ id: string }>>`
          SELECT public.ledger_post_payments(${input.key}::text, ${input.type}::text, ${reference}::jsonb, ${entries}::jsonb,
            ${createdBy}::text)::text AS id`;
      case "backoffice":
        return db.$queryRaw<Array<{ id: string }>>`
          SELECT public.ledger_post_backoffice(${input.key}::text, ${input.type}::text, ${reference}::jsonb, ${entries}::jsonb,
            ${createdBy}::text)::text AS id`;
    }
  });
  const id = rows[0]?.id;
  if (!id) throw new LedgerError("INVARIANT", "LEDGER_BAD_REQUEST", "the ledger entry point returned no id");
  return id;
}

/** Total order on account specs; every caller resolves accounts in this order. */
export function accountSortKey(spec: AccountSpec): string {
  return JSON.stringify([spec.asset, spec.type, spec.userId ?? "", spec.tableId ?? "", spec.providerKey ?? ""]);
}

/**
 * Resolves several account specs; returns their ids in the input order.
 *
 * The accounts are resolved (and, on first use, created) in one global order,
 * accountSortKey, never in the caller's order. Creating an account inserts a
 * row that stays uncommitted until the caller's transaction ends, and a
 * concurrent creator of the same account waits for it. If two transactions
 * created two new accounts in opposite orders (a buy-in plans user then
 * escrow, a cash-out escrow then user) each would wait for the other's insert:
 * a deadlock. With one global order the waits cannot form a cycle.
 * A transaction that posts several times should resolve every account it
 * needs with one ensureAccounts call before its first post.
 */
export async function ensureAccounts(db: LedgerDb, specs: readonly AccountSpec[]): Promise<bigint[]> {
  const keys = specs.map(accountSortKey);
  const unique = [...new Set(keys)].sort();
  const ids = new Map<string, bigint>();
  for (const key of unique) ids.set(key, await ensureAccount(db, specs[keys.indexOf(key)]!));
  return keys.map((key) => ids.get(key)!);
}

/** Resolves a plan's accounts (ensureAccounts: one global order) and posts it. */
export async function execute(db: LedgerDb, plan: PostingPlan): Promise<string> {
  const ids = await ensureAccounts(db, plan.legs.map((leg) => leg.account));
  const entries: LedgerEntryInput[] = plan.legs.map((leg, i) => ({ accountId: ids[i]!, asset: leg.account.asset, amount: leg.amount }));
  return post(db, { key: plan.key, type: plan.type, reference: plan.reference, entries, createdBy: plan.createdBy });
}

export const grantPlay = (db: LedgerDb, input: Parameters<typeof planGrantPlay>[0]) => execute(db, planGrantPlay(input));
export const buyIn = (db: LedgerDb, input: Parameters<typeof planBuyIn>[0]) => execute(db, planBuyIn(input));
export const cashOut = (db: LedgerDb, input: Parameters<typeof planCashOut>[0]) => execute(db, planCashOut(input));
export const rake = (db: LedgerDb, input: Parameters<typeof planRake>[0]) => execute(db, planRake(input));
export const creditDeposit = (db: LedgerDb, input: Parameters<typeof planCreditDeposit>[0]) => execute(db, planCreditDeposit(input));
export const reverseDeposit = (db: LedgerDb, input: Parameters<typeof planReverseDeposit>[0]) => execute(db, planReverseDeposit(input));
export const holdWithdrawal = (db: LedgerDb, input: Parameters<typeof planHoldWithdrawal>[0]) => execute(db, planHoldWithdrawal(input));
export const releaseWithdrawal = (db: LedgerDb, input: Parameters<typeof planReleaseWithdrawal>[0]) => execute(db, planReleaseWithdrawal(input));
export const settleWithdrawal = (db: LedgerDb, input: Parameters<typeof planSettleWithdrawal>[0]) => execute(db, planSettleWithdrawal(input));
export const providerFee = (db: LedgerDb, input: Parameters<typeof planProviderFee>[0]) => execute(db, planProviderFee(input));
export const adjustment = (db: LedgerDb, input: Parameters<typeof planAdjustment>[0]) => execute(db, planAdjustment(input));
export const recoverChargeback = (db: LedgerDb, input: Parameters<typeof planRecoverChargeback>[0]) => execute(db, planRecoverChargeback(input));
export const returnWithdrawal = (db: LedgerDb, input: Parameters<typeof planReturnWithdrawal>[0]) => execute(db, planReturnWithdrawal(input));

/**
 * The cached balance of one account (read inside the posting transaction,
 * e.g. to size a chargeback's user portion; ledger_post re-checks it).
 */
export async function getAccountBalance(db: LedgerDb, accountId: bigint): Promise<bigint> {
  const rows = await db.$queryRaw<Array<{ balance: string }>>`
    SELECT "balance"::text AS balance FROM public."LedgerAccount" WHERE "id" = ${accountId.toString()}::bigint`;
  const balance = rows[0]?.balance;
  if (balance === undefined) throw new LedgerError("INVARIANT", "LEDGER_UNKNOWN_ACCOUNT", `account ${accountId} does not exist`);
  return BigInt(balance);
}

export interface AccountBalance {
  accountId: bigint;
  asset: string;
  type: LedgerAccountType;
  balance: bigint;
  version: bigint;
}

/** A user's ledger accounts (available and withdrawal holds), every asset. */
export async function getBalances(db: LedgerDb, userId: string): Promise<AccountBalance[]> {
  const rows = await db.$queryRaw<Array<{ id: string; assetCode: string; type: LedgerAccountType; balance: string; version: string }>>`
    SELECT "id"::text AS id, "assetCode", "type"::text AS type, "balance"::text AS balance, "version"::text AS version
      FROM public."LedgerAccount" WHERE "userId" = ${userId}::text ORDER BY "assetCode", "type"`;
  return rows.map((row) => ({
    accountId: BigInt(row.id), asset: row.assetCode, type: row.type, balance: BigInt(row.balance), version: BigInt(row.version),
  }));
}

export interface BalanceReconstruction {
  accountId: bigint;
  /** LedgerAccount.balance / version as cached on the row. */
  cachedBalance: bigint;
  cachedVersion: bigint;
  /** Sum and count of the account's journal entries. */
  journalBalance: bigint;
  entryCount: bigint;
  /** Entries whose balanceAfter differs from the running sum, or whose version is out of sequence. */
  brokenEntries: bigint;
  consistent: boolean;
}

/**
 * Recomputes an account from its journal: the entries must sum to the cached
 * balance, their count must equal the cached version, and each entry's
 * balanceAfter must equal the running sum at its version. Any mismatch means
 * the row or the journal was altered outside ledger_post.
 */
export async function reconstructBalance(db: LedgerDb, accountId: bigint): Promise<BalanceReconstruction> {
  const rows = await db.$queryRaw<Array<{ balance: string; version: string; journal: string; entries: string; broken: string }>>`
    WITH entries AS (
      SELECT e."amount", e."balanceAfter", e."accountVersion",
             SUM(e."amount") OVER (ORDER BY e."accountVersion") AS running,
             ROW_NUMBER() OVER (ORDER BY e."accountVersion") AS position
        FROM public."LedgerEntry" e WHERE e."accountId" = ${accountId.toString()}::bigint)
    SELECT a."balance"::text AS balance, a."version"::text AS version,
           (SELECT COALESCE(SUM("amount"), 0)::text FROM entries) AS journal,
           (SELECT COUNT(*)::text FROM entries) AS entries,
           (SELECT COUNT(*)::text FROM entries WHERE running <> "balanceAfter" OR position <> "accountVersion") AS broken
      FROM public."LedgerAccount" a WHERE a."id" = ${accountId.toString()}::bigint`;
  const row = rows[0];
  if (!row) throw new LedgerError("INVARIANT", "LEDGER_UNKNOWN_ACCOUNT", `account ${accountId} does not exist`);
  const result = {
    accountId,
    cachedBalance: BigInt(row.balance),
    cachedVersion: BigInt(row.version),
    journalBalance: BigInt(row.journal),
    entryCount: BigInt(row.entries),
    brokenEntries: BigInt(row.broken),
  };
  return {
    ...result,
    consistent: result.cachedBalance === result.journalBalance && result.cachedVersion === result.entryCount && result.brokenEntries === 0n,
  };
}
