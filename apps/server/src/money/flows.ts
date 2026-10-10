/**
 * Posting plans for every money flow (docs/money/LEDGER.md section 4).
 *
 * Pure functions: each turns a business event into one balanced transaction
 * (type, reference, legs on account *specs*). ledger.ts resolves the specs to
 * account ids and posts. Keeping the planning pure lets the unit tests prove
 * every flow balances without a database; the database re-checks everything
 * (balance per asset, account/asset match, transaction shape) regardless, so
 * a bug here is refused there rather than booked.
 *
 * Idempotency keys are supplied by the caller and must be derived from the
 * business event (command id, hand UUID, provider payment id), never random
 * per attempt, so a retry of the same event replays instead of double-posting.
 */
import { AmountError, BIGINT_MAX, assertBigintRange, chipsToMinor } from "./amounts.js";

export const PLAY_ASSET = "PLAY";

export type LedgerAccountType =
  | "USER_AVAILABLE"
  | "USER_WITHDRAWAL_HOLD"
  | "TABLE_ESCROW"
  | "PLAY_ISSUANCE"
  | "RAKE_REVENUE"
  | "DEPOSIT_CLEARING"
  | "WITHDRAWAL_CLEARING"
  | "PROVIDER_FEES"
  | "ADJUSTMENTS"
  | "CHARGEBACK_LOSSES";

export type LedgerTransactionType =
  | "PLAY_GRANT"
  | "BUY_IN"
  | "CASH_OUT"
  | "RAKE"
  | "DEPOSIT_CREDIT"
  | "DEPOSIT_REVERSAL"
  | "WITHDRAWAL_HOLD"
  | "WITHDRAWAL_RELEASE"
  | "WITHDRAWAL_SETTLE"
  | "PROVIDER_FEE"
  | "ADJUSTMENT";

/** Identifies an account by owner; the database creates it on first use. */
export interface AccountSpec {
  asset: string;
  type: LedgerAccountType;
  userId?: string | null;
  tableId?: string | null;
  providerKey?: string | null;
}

export interface PlannedLeg {
  account: AccountSpec;
  /** Signed minor units, added to the account balance. */
  amount: bigint;
}

/** JSON-only reference (no bigint: amounts are recorded as decimal strings). */
export type LedgerReference = Record<string, string | number | boolean | null>;

export interface PostingPlan {
  key: string;
  type: LedgerTransactionType;
  reference: LedgerReference;
  legs: PlannedLeg[];
  createdBy: string | null;
}

/** Same format the database enforces on LedgerTransaction.idempotencyKey. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,199}$/;
const ASSET_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const PROVIDER_KEY = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export function assertIdempotencyKey(key: string): string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) throw new AmountError("idempotency key is missing or malformed");
  return key;
}

function assertAsset(asset: string): string {
  if (typeof asset !== "string" || !ASSET_CODE.test(asset)) throw new AmountError("asset code is malformed");
  return asset;
}

function assertRealAsset(asset: string): string {
  assertAsset(asset);
  if (asset === PLAY_ASSET) throw new AmountError("PLAY chips are not redeemable: no deposit, withdrawal or fee flow exists for them");
  return asset;
}

function assertId(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new AmountError(`${what} is required`);
  return value;
}

function assertProvider(providerKey: string): string {
  if (typeof providerKey !== "string" || !PROVIDER_KEY.test(providerKey)) throw new AmountError("providerKey is malformed");
  return providerKey;
}

function assertPositive(amount: bigint, what = "amount"): bigint {
  if (typeof amount !== "bigint" || amount <= 0n) throw new AmountError(`${what} must be a positive bigint`);
  return assertBigintRange(amount, what);
}

function assertNonNegative(amount: bigint, what: string): bigint {
  if (typeof amount !== "bigint" || amount < 0n) throw new AmountError(`${what} must be a non-negative bigint`);
  return assertBigintRange(amount, what);
}

function plan(key: string, type: LedgerTransactionType, reference: LedgerReference, legs: PlannedLeg[], createdBy?: string | null): PostingPlan {
  const result: PostingPlan = {
    key: assertIdempotencyKey(key),
    type,
    reference,
    // A zero leg (e.g. no fee) is dropped: the ledger stores non-zero entries only.
    legs: legs.filter((leg) => leg.amount !== 0n),
    createdBy: createdBy ?? null,
  };
  assertBalanced(result.legs);
  return result;
}

/** Per-asset sum of the legs (all zero for a valid transaction). */
export function sumByAsset(legs: ReadonlyArray<{ account?: AccountSpec; asset?: string; amount: bigint }>): Map<string, bigint> {
  const sums = new Map<string, bigint>();
  for (const leg of legs) {
    const asset = leg.account?.asset ?? leg.asset ?? "";
    sums.set(asset, (sums.get(asset) ?? 0n) + leg.amount);
  }
  return sums;
}

/** Throws unless there are >= 2 non-zero legs and every asset sums to zero. */
export function assertBalanced(legs: ReadonlyArray<{ account?: AccountSpec; asset?: string; amount: bigint }>): void {
  if (legs.length < 2) throw new AmountError("a transaction needs at least two entries");
  for (const leg of legs) {
    if (typeof leg.amount !== "bigint" || leg.amount === 0n) throw new AmountError("entry amounts must be non-zero bigints");
    assertBigintRange(leg.amount);
  }
  for (const [asset, sum] of sumByAsset(legs)) {
    if (sum !== 0n) throw new AmountError(`entries for ${asset} do not sum to zero`);
  }
}

const user = (asset: string, userId: string): AccountSpec => ({ asset, type: "USER_AVAILABLE", userId });
const hold = (asset: string, userId: string): AccountSpec => ({ asset, type: "USER_WITHDRAWAL_HOLD", userId });
const escrow = (asset: string, tableId: string): AccountSpec => ({ asset, type: "TABLE_ESCROW", tableId });
const system = (asset: string, type: LedgerAccountType): AccountSpec => ({ asset, type });
const provider = (asset: string, type: LedgerAccountType, providerKey: string): AccountSpec => ({ asset, type, providerKey });

/** PLAY_ISSUANCE -> user. Guest/registration grants and play-chip top-ups. */
export function planGrantPlay(input: { key: string; userId: string; amount: bigint; reason: string; createdBy?: string | null }): PostingPlan {
  const amount = assertPositive(input.amount);
  const userId = assertId(input.userId, "userId");
  return plan(input.key, "PLAY_GRANT", { userId, reason: assertId(input.reason, "reason") }, [
    { account: system(PLAY_ASSET, "PLAY_ISSUANCE"), amount: -amount },
    { account: user(PLAY_ASSET, userId), amount },
  ], input.createdBy);
}

interface TableChipsInput {
  key: string;
  asset: string;
  userId: string;
  tableId: string;
  chips: number;
  chipUnit: bigint;
  createdBy?: string | null;
}

function tableReference(input: TableChipsInput): LedgerReference {
  return { tableId: input.tableId, userId: input.userId, chips: input.chips, chipUnit: input.chipUnit.toString() };
}

/** User -> table escrow: chips x chipUnit. */
export function planBuyIn(input: TableChipsInput): PostingPlan {
  const asset = assertAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  const tableId = assertId(input.tableId, "tableId");
  const amount = assertPositive(chipsToMinor(input.chips, input.chipUnit), "buy-in");
  return plan(input.key, "BUY_IN", tableReference(input), [
    { account: user(asset, userId), amount: -amount },
    { account: escrow(asset, tableId), amount },
  ], input.createdBy);
}

/** Table escrow -> user: chips x chipUnit. */
export function planCashOut(input: TableChipsInput): PostingPlan {
  const asset = assertAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  const tableId = assertId(input.tableId, "tableId");
  const amount = assertPositive(chipsToMinor(input.chips, input.chipUnit), "cash-out");
  return plan(input.key, "CASH_OUT", tableReference(input), [
    { account: escrow(asset, tableId), amount: -amount },
    { account: user(asset, userId), amount },
  ], input.createdBy);
}

/** Table escrow -> rake revenue, once per hand (key it by the hand UUID). */
export function planRake(input: { key: string; asset: string; tableId: string; handUuid: string; chips: number; chipUnit: bigint; createdBy?: string | null }): PostingPlan {
  const asset = assertAsset(input.asset);
  const tableId = assertId(input.tableId, "tableId");
  const amount = assertPositive(chipsToMinor(input.chips, input.chipUnit), "rake");
  return plan(input.key, "RAKE", {
    tableId, handUuid: assertId(input.handUuid, "handUuid"), chips: input.chips, chipUnit: input.chipUnit.toString(),
  }, [
    { account: escrow(asset, tableId), amount: -amount },
    { account: system(asset, "RAKE_REVENUE"), amount },
  ], input.createdBy);
}

interface ProviderInput {
  key: string;
  asset: string;
  userId: string;
  providerKey: string;
  amount: bigint;
  providerReference: string;
  createdBy?: string | null;
}

/** Provider-confirmed deposit: deposit clearing -> user. Real assets only. */
export function planCreditDeposit(input: ProviderInput): PostingPlan {
  const asset = assertRealAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  const providerKey = assertProvider(input.providerKey);
  const amount = assertPositive(input.amount);
  return plan(input.key, "DEPOSIT_CREDIT", { userId, providerKey, providerReference: assertId(input.providerReference, "providerReference") }, [
    { account: provider(asset, "DEPOSIT_CLEARING", providerKey), amount: -amount },
    { account: user(asset, userId), amount },
  ], input.createdBy);
}

/**
 * Refund/chargeback of a deposit. `userPortion` is the part still covered by
 * the user's available balance (the caller reads it under the same lock); the
 * rest is a loss the house absorbs. Either leg is dropped when zero.
 */
export function planReverseDeposit(input: ProviderInput & { userPortion: bigint }): PostingPlan {
  const asset = assertRealAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  const providerKey = assertProvider(input.providerKey);
  const amount = assertPositive(input.amount);
  const userPortion = assertNonNegative(input.userPortion, "userPortion");
  if (userPortion > amount) throw new AmountError("userPortion cannot exceed the reversed amount");
  return plan(input.key, "DEPOSIT_REVERSAL", {
    userId, providerKey, providerReference: assertId(input.providerReference, "providerReference"),
    amount: amount.toString(), userPortion: userPortion.toString(),
  }, [
    { account: provider(asset, "DEPOSIT_CLEARING", providerKey), amount },
    { account: user(asset, userId), amount: -userPortion },
    { account: system(asset, "CHARGEBACK_LOSSES"), amount: -(amount - userPortion) },
  ], input.createdBy);
}

interface WithdrawalInput {
  key: string;
  asset: string;
  userId: string;
  withdrawalId: string;
  amount: bigint;
  createdBy?: string | null;
}

/** Reserve funds for a withdrawal before any payout request leaves the system. */
export function planHoldWithdrawal(input: WithdrawalInput): PostingPlan {
  const asset = assertRealAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  const amount = assertPositive(input.amount);
  return plan(input.key, "WITHDRAWAL_HOLD", { userId, withdrawalId: assertId(input.withdrawalId, "withdrawalId") }, [
    { account: user(asset, userId), amount: -amount },
    { account: hold(asset, userId), amount },
  ], input.createdBy);
}

/** Return held funds (rejected, cancelled or failed payout). */
export function planReleaseWithdrawal(input: WithdrawalInput & { reason: string }): PostingPlan {
  const asset = assertRealAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  const amount = assertPositive(input.amount);
  return plan(input.key, "WITHDRAWAL_RELEASE", {
    userId, withdrawalId: assertId(input.withdrawalId, "withdrawalId"), reason: assertId(input.reason, "reason"),
  }, [
    { account: hold(asset, userId), amount: -amount },
    { account: user(asset, userId), amount },
  ], input.createdBy);
}

/** Payout confirmed: held amount leaves custody; the provider fee is charged out of it. */
export function planSettleWithdrawal(input: WithdrawalInput & { providerKey: string; fee: bigint; providerReference: string }): PostingPlan {
  const asset = assertRealAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  const providerKey = assertProvider(input.providerKey);
  const amount = assertPositive(input.amount);
  const fee = assertNonNegative(input.fee, "fee");
  if (fee >= amount) throw new AmountError("fee must be smaller than the withdrawn amount");
  return plan(input.key, "WITHDRAWAL_SETTLE", {
    userId, withdrawalId: assertId(input.withdrawalId, "withdrawalId"), providerKey,
    providerReference: assertId(input.providerReference, "providerReference"), fee: fee.toString(),
  }, [
    { account: hold(asset, userId), amount: -amount },
    { account: provider(asset, "WITHDRAWAL_CLEARING", providerKey), amount: amount - fee },
    { account: provider(asset, "PROVIDER_FEES", providerKey), amount: fee },
  ], input.createdBy);
}

/** A provider fee the house absorbs (house equity -> provider fees). */
export function planProviderFee(input: { key: string; asset: string; providerKey: string; amount: bigint; providerReference: string; createdBy?: string | null }): PostingPlan {
  const asset = assertRealAsset(input.asset);
  const providerKey = assertProvider(input.providerKey);
  const amount = assertPositive(input.amount);
  return plan(input.key, "PROVIDER_FEE", { providerKey, providerReference: assertId(input.providerReference, "providerReference") }, [
    { account: system(asset, "ADJUSTMENTS"), amount: -amount },
    { account: provider(asset, "PROVIDER_FEES", providerKey), amount },
  ], input.createdBy);
}

/**
 * Staff correction of a user's available balance (signed). The counterparty is
 * house equity (ADJUSTMENTS) for real assets and PLAY_ISSUANCE for PLAY (play
 * chips are minted/burned, never booked against real equity). The database
 * requires createdBy and a non-empty reason for this type.
 */
export function planAdjustment(input: { key: string; asset: string; userId: string; amount: bigint; reason: string; createdBy: string }): PostingPlan {
  const asset = assertAsset(input.asset);
  const userId = assertId(input.userId, "userId");
  if (typeof input.amount !== "bigint" || input.amount === 0n) throw new AmountError("adjustment amount must be a non-zero bigint");
  // -BIGINT_MIN does not fit a BIGINT; bound by +/- BIGINT_MAX.
  if (input.amount > BIGINT_MAX || input.amount < -BIGINT_MAX) throw new AmountError("adjustment amount is outside the BIGINT range");
  const createdBy = assertId(input.createdBy, "createdBy");
  const counterparty = asset === PLAY_ASSET ? system(asset, "PLAY_ISSUANCE") : system(asset, "ADJUSTMENTS");
  return plan(input.key, "ADJUSTMENT", { userId, reason: assertId(typeof input.reason === "string" ? input.reason.trim() : "", "reason") }, [
    { account: user(asset, userId), amount: input.amount },
    { account: counterparty, amount: -input.amount },
  ], createdBy);
}

/**
 * Right-hand side of the table escrow invariant: (stacks + chips committed in
 * the current hand + cash-outs not yet posted) x chipUnit must equal the
 * table's TABLE_ESCROW balance. Summed in bigint so many large stacks cannot
 * lose precision.
 */
export function expectedEscrowMinor(
  chips: { stacks: readonly number[]; committed: readonly number[]; unpaidCashOuts: readonly number[] },
  chipUnit: bigint,
): bigint {
  chipsToMinor(0, chipUnit); // validates chipUnit even for an empty table
  let total = 0n;
  for (const value of [...chips.stacks, ...chips.committed, ...chips.unpaidCashOuts]) total += chipsToMinor(value, 1n);
  return assertBigintRange(total * chipUnit, "escrow");
}
