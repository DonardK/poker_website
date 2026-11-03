/**
 * Payments state machines (docs/money/WALLET.md section 7). These tables are
 * the TypeScript copy of the transition arrays in the guard triggers of
 * migration 20261019120000_payments_wallet (payment_deposit_guard,
 * payment_withdrawal_guard, payout_dispatch_guard, payment_instrument_guard).
 * The database is the authority: it refuses any other change with SQLSTATE
 * PM003 (PAYMENT_BAD_TRANSITION). apps/server/test/db/payments-schema.test.mjs
 * proves the two copies are equal and attempts every pair against the
 * database. Pure data, no imports: usable from both Workers and the tests.
 */

export const DEPOSIT_STATUSES = [
  "CREATED", "PENDING", "CONFIRMED", "CREDITED", "NEEDS_REVIEW", "FAILED", "EXPIRED", "CANCELLED", "PARTIALLY_REVERSED", "REVERSED",
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export const WITHDRAWAL_STATUSES = [
  "REQUESTED", "HELD", "UNDER_REVIEW", "APPROVED", "SUBMITTED", "SETTLED", "FAILED", "REJECTED", "CANCELLED", "RETURNED",
] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const PAYOUT_DISPATCH_STATUSES = [
  "PENDING", "IN_FLIGHT", "SENT", "UNCERTAIN", "RETRY_WAIT", "COMPLETED", "FAILED", "MANUAL", "CANCELLED",
] as const;
export type PayoutDispatchStatus = (typeof PAYOUT_DISPATCH_STATUSES)[number];

export const INSTRUMENT_STATUSES = ["ACTIVE", "REVOKED", "BLOCKED"] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

type Pair<S extends string> = readonly [from: S, to: S];

/**
 * Deposit (section 7.1). Monotonic: a stale provider status never moves a
 * deposit back. FAILED / EXPIRED / CANCELLED can still become CONFIRMED (a
 * late verified success, lateSuccess = true). CONFIRMED is normally transient
 * (set in the transaction that posts the credit). The reversal states move
 * with the reversed and recovered totals.
 */
export const DEPOSIT_TRANSITIONS: readonly Pair<DepositStatus>[] = Object.freeze([
  ["CREATED", "PENDING"], ["CREATED", "CONFIRMED"], ["CREATED", "NEEDS_REVIEW"], ["CREATED", "FAILED"], ["CREATED", "EXPIRED"], ["CREATED", "CANCELLED"],
  ["PENDING", "CONFIRMED"], ["PENDING", "NEEDS_REVIEW"], ["PENDING", "FAILED"], ["PENDING", "EXPIRED"], ["PENDING", "CANCELLED"],
  ["FAILED", "CONFIRMED"], ["EXPIRED", "CONFIRMED"], ["CANCELLED", "CONFIRMED"],
  ["FAILED", "NEEDS_REVIEW"], ["EXPIRED", "NEEDS_REVIEW"], ["CANCELLED", "NEEDS_REVIEW"],
  ["NEEDS_REVIEW", "CONFIRMED"], ["NEEDS_REVIEW", "FAILED"],
  ["CONFIRMED", "CREDITED"],
  ["CREDITED", "PARTIALLY_REVERSED"], ["CREDITED", "REVERSED"], ["PARTIALLY_REVERSED", "REVERSED"],
  ["PARTIALLY_REVERSED", "CREDITED"], ["REVERSED", "PARTIALLY_REVERSED"], ["REVERSED", "CREDITED"],
] as const);

/**
 * Withdrawal (section 7.2). SUBMITTED is the point of no return: it ends only
 * as SETTLED or FAILED (provider-confirmed). The database also requires the
 * approvals for APPROVED (PM004), an untouched dispatch to reject or cancel an
 * APPROVED withdrawal, and a PayoutDispatch row for SUBMITTED.
 */
export const WITHDRAWAL_TRANSITIONS: readonly Pair<WithdrawalStatus>[] = Object.freeze([
  ["REQUESTED", "HELD"], ["HELD", "UNDER_REVIEW"], ["HELD", "APPROVED"], ["HELD", "REJECTED"], ["HELD", "CANCELLED"],
  ["UNDER_REVIEW", "APPROVED"], ["UNDER_REVIEW", "REJECTED"], ["UNDER_REVIEW", "CANCELLED"],
  ["APPROVED", "SUBMITTED"], ["APPROVED", "REJECTED"], ["APPROVED", "CANCELLED"],
  ["SUBMITTED", "SETTLED"], ["SUBMITTED", "FAILED"], ["SETTLED", "RETURNED"],
] as const);

/** PayoutDispatch (section 7.3). PENDING -> CANCELLED only while attempts = 0. */
export const PAYOUT_DISPATCH_TRANSITIONS: readonly Pair<PayoutDispatchStatus>[] = Object.freeze([
  ["PENDING", "IN_FLIGHT"], ["PENDING", "CANCELLED"], ["PENDING", "MANUAL"],
  ["IN_FLIGHT", "SENT"], ["IN_FLIGHT", "COMPLETED"], ["IN_FLIGHT", "FAILED"], ["IN_FLIGHT", "UNCERTAIN"], ["IN_FLIGHT", "RETRY_WAIT"],
  ["UNCERTAIN", "IN_FLIGHT"], ["UNCERTAIN", "SENT"], ["UNCERTAIN", "COMPLETED"], ["UNCERTAIN", "FAILED"], ["UNCERTAIN", "MANUAL"],
  ["RETRY_WAIT", "IN_FLIGHT"], ["RETRY_WAIT", "MANUAL"], ["SENT", "COMPLETED"], ["SENT", "FAILED"], ["SENT", "UNCERTAIN"],
  ["MANUAL", "COMPLETED"], ["MANUAL", "FAILED"],
] as const);

/** PaymentInstrument (section 7.4). REVOKED is terminal; cooling-off is derived (usableAfter > now). */
export const INSTRUMENT_TRANSITIONS: readonly Pair<InstrumentStatus>[] = Object.freeze([
  ["ACTIVE", "REVOKED"], ["ACTIVE", "BLOCKED"], ["BLOCKED", "ACTIVE"], ["BLOCKED", "REVOKED"],
] as const);

export type StateMachine = "deposit" | "withdrawal" | "payoutDispatch" | "instrument";

/** Every machine's transition table, by name. */
export const TRANSITIONS: Readonly<Record<StateMachine, readonly Pair<string>[]>> = Object.freeze({
  deposit: DEPOSIT_TRANSITIONS,
  withdrawal: WITHDRAWAL_TRANSITIONS,
  payoutDispatch: PAYOUT_DISPATCH_TRANSITIONS,
  instrument: INSTRUMENT_TRANSITIONS,
});

const pairSet = (pairs: readonly Pair<string>[]): ReadonlySet<string> => new Set(pairs.map(([from, to]) => `${from}>${to}`));

const ALLOWED: Readonly<Record<StateMachine, ReadonlySet<string>>> = Object.freeze({
  deposit: pairSet(DEPOSIT_TRANSITIONS),
  withdrawal: pairSet(WITHDRAWAL_TRANSITIONS),
  payoutDispatch: pairSet(PAYOUT_DISPATCH_TRANSITIONS),
  instrument: pairSet(INSTRUMENT_TRANSITIONS),
});

/** True when the database accepts `from -> to` for that machine (a change to the same state is no transition). */
export function canTransition(machine: "deposit", from: DepositStatus, to: DepositStatus): boolean;
export function canTransition(machine: "withdrawal", from: WithdrawalStatus, to: WithdrawalStatus): boolean;
export function canTransition(machine: "payoutDispatch", from: PayoutDispatchStatus, to: PayoutDispatchStatus): boolean;
export function canTransition(machine: "instrument", from: InstrumentStatus, to: InstrumentStatus): boolean;
export function canTransition(machine: StateMachine, from: string, to: string): boolean {
  return from === to || ALLOWED[machine].has(`${from}>${to}`);
}

/** Terminal states (no transition leaves them). */
export const TERMINAL: Readonly<Record<StateMachine, readonly string[]>> = Object.freeze({
  deposit: [],
  withdrawal: ["FAILED", "REJECTED", "CANCELLED", "RETURNED"],
  payoutDispatch: ["COMPLETED", "FAILED", "CANCELLED"],
  instrument: ["REVOKED"],
});
