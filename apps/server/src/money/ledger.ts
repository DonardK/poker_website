/**
 * Server side of the money ledger (docs/money/LEDGER.md).
 *
 * Every balance change goes through the database function public.ledger_post
 * (SECURITY DEFINER), which re-validates everything: balance per asset,
 * account/asset match, enabled assets, per-entry cap, transaction shape,
 * overdraft, idempotency. This module only builds requests, resolves account
 * ids and maps the database's refusals to LedgerError. The runtime role has
 * no write privilege on the ledger tables, so there is no other path.
 *
 * All functions take the caller's Prisma client or interactive-transaction
 * client: call them inside the same transaction as the game/payment state
 * change they account for (after locking that state's rows), so both commit
 * or neither does. A refusal raises, which aborts that transaction.
 */
import type { Prisma } from "@prisma/client";
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
  planReleaseWithdrawal,
  planReverseDeposit,
  planSettleWithdrawal,
  type AccountSpec,
  type LedgerAccountType,
  type LedgerReference,
  type LedgerTransactionType,
  type PostingPlan,
} from "./flows.js";

/** PrismaClient or Prisma.TransactionClient (only raw queries are used). */
export type LedgerDb = Pick<Prisma.TransactionClient, "$queryRaw">;

export type LedgerErrorCode = "INSUFFICIENT_FUNDS" | "IDEMPOTENCY_CONFLICT" | "INVARIANT" | "ASSET_DISABLED" | "RETRY";

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
});
const KNOWN_DB_CODES: ReadonlySet<string> = new Set([...Object.values(LEDGER_SQLSTATES), "LEDGER_RETRY"]);
const LEDGER_MESSAGE = /\b(LEDGER_[A-Z_]+)\b/;
/** The SQLSTATEs this module maps: the ledger's own (LGnnn) and Postgres' retry conditions. */
const MAPPED_SQLSTATE = /^(?:LG\d{3}|40001|40P01)$/;

/**
 * The Postgres SQLSTATE of a driver error, if it carries one: Prisma puts it
 * in meta.code (its own `code` is P1000..P6999); node-postgres in `code`.
 */
function sqlstateOf(error: { code?: unknown; meta?: { code?: unknown } }): string | undefined {
  const isSqlstate = (value: unknown): value is string => typeof value === "string" && /^[0-9A-Z]{5}$/.test(value);
  const metaCode = error.meta?.code;
  if (isSqlstate(metaCode)) return metaCode;
  const code = error.code;
  if (isSqlstate(code) && !/^P[1-9][0-9]{3}$/.test(code)) return code;
  return undefined;
}

function codeFor(dbCode: string): LedgerErrorCode {
  switch (dbCode) {
    case "LEDGER_INSUFFICIENT_FUNDS": return "INSUFFICIENT_FUNDS";
    case "LEDGER_IDEMPOTENCY_CONFLICT": return "IDEMPOTENCY_CONFLICT";
    case "LEDGER_ASSET_DISABLED": return "ASSET_DISABLED";
    case "LEDGER_RETRY":
    case "SERIALIZATION_FAILURE":
    case "DEADLOCK_DETECTED": return "RETRY";
    default: return "INVARIANT";
  }
}

/**
 * Maps a database error raised by the ledger functions to LedgerError, or
 * returns null for anything else (connection loss, timeouts, ...), which the
 * caller must propagate unchanged: an infrastructure failure is not a refusal.
 *
 * The SQLSTATE decides whenever the driver exposes it (node-postgres: `code`;
 * Prisma raw-query failure P2010: `meta.code`): LG001..LG019 are the ledger's
 * refusals (table in docs/money/LEDGER.md section 11); 40001 (serialization
 * failure, including LEDGER_RETRY) and 40P01 (deadlock detected) both mean
 * "roll back and retry the whole transaction" and map to RETRY. Without a
 * SQLSTATE, a known LEDGER_* message prefix is matched instead.
 */
export function toLedgerError(error: unknown): LedgerError | null {
  if (error instanceof LedgerError) return error;
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
  const text = `${typeof candidate.meta?.message === "string" ? candidate.meta.message : ""}\n${typeof candidate.message === "string" ? candidate.message : ""}`;
  const sqlstate = sqlstateOf(candidate);
  const prefix = LEDGER_MESSAGE.exec(text)?.[1];
  let dbCode: string | undefined;
  if (sqlstate === "40001") dbCode = prefix === "LEDGER_RETRY" ? prefix : "SERIALIZATION_FAILURE";
  else if (sqlstate === "40P01") dbCode = "DEADLOCK_DETECTED";
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
 * Posts one balanced transaction and returns its id. Replaying the same key
 * with the same payload returns the original id without posting again; the
 * same key with a different payload is IDEMPOTENCY_CONFLICT. Amounts and ids
 * travel as decimal strings (the database refuses JSON numbers).
 */
export async function post(db: LedgerDb, input: PostInput): Promise<string> {
  assertIdempotencyKey(input.key);
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
  const rows = await guarded(() => db.$queryRaw<Array<{ id: string }>>`
    SELECT public.ledger_post(${input.key}::text, ${input.type}::text, ${reference}::jsonb, ${entries}::jsonb,
      ${input.createdBy ?? null}::text)::text AS id`);
  const id = rows[0]?.id;
  if (!id) throw new LedgerError("INVARIANT", "LEDGER_BAD_REQUEST", "ledger_post returned no id");
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
