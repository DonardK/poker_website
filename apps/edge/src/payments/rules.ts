/**
 * Withdrawal review rules (docs/money/WALLET.md section 10.7). Pure: the
 * caller (withdrawals.ts) reads every input with SQL inside the request
 * transaction and stores the reasons, the approvals required and
 * RULES_VERSION on the withdrawal. Any reason means manual review; none
 * means automatic approval (still subject to the AUTO_APPROVE switch, which
 * is itself a reason when off). In Phase 1 every withdrawal is manual by
 * design: deposits cannot be played at tables yet, so LOW_PLAY always applies.
 */

export const RULES_VERSION = "wr-2026-10-21";

/** €1,000: the Transfer of Funds Regulation threshold for self-hosted wallets (Regulation (EU) 2023/1113). */
export const OWNERSHIP_PROOF_THRESHOLD_MINOR = 100_000n;
export const DESTINATION_YOUNG_MS = 7 * 86_400_000;

export const WITHDRAWAL_REASONS = [
  "AUTO_APPROVE_DISABLED", "FIRST_WITHDRAWAL", "AMOUNT_OVER_AUTO_LIMIT", "DAILY_AUTO_LIMIT", "RISK_NOT_LOW", "SCREENING_NOT_CLEAR",
  "SOURCE_OF_FUNDS_PENDING", "RESTRICTED_MANUAL", "CHARGEBACK_HISTORY", "NEW_DESTINATION", "DESTINATION_YOUNG", "DESTINATION_SHARED",
  "OWNERSHIP_PROOF_REQUIRED", "CLOSED_LOOP", "LOW_PLAY", "RECENT_SECURITY_CHANGE", "NOT_ME_REPORTED", "REFUND_TO_SOURCE",
] as const;
export type WithdrawalReason = (typeof WITHDRAWAL_REASONS)[number];

export interface WithdrawalRuleInput {
  kind: "PLAYER" | "REFUND";
  method: "CARD" | "CRYPTO";
  amountMinor: bigint;
  liveMode: boolean;
  autoApproveEnabled: boolean;
  limits: { autoApproveMaxMinor: bigint; autoApproveDailyMaxMinor: bigint; dualApprovalMinMinor: bigint };
  /** SETTLED (or RETURNED) withdrawals of this user before this one. */
  settledWithdrawals: number;
  /** Amount of this user's withdrawals approved automatically in the last 24 hours. */
  autoApprovedLast24hMinor: bigint;
  compliance: {
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    screeningStatus: "NOT_SCREENED" | "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";
    sourceOfFundsStatus: "NOT_REQUIRED" | "REQUESTED" | "SUBMITTED" | "APPROVED" | "REJECTED";
    restriction: "NONE" | "DEPOSITS_BLOCKED" | "WITHDRAWALS_MANUAL" | "FROZEN";
    chargebackCount: number;
  };
  destination: {
    successfulPayouts: number;
    createdAt: Date;
    /** The same address or card fingerprint is active for another user. */
    sharedWithOtherUser: boolean;
    ownershipVerified: boolean;
    /** Everything sent to this destination before, plus this withdrawal. */
    cumulativeMinor: bigint;
    /** A card that made a deposit in the last 90 days. */
    isRecentDepositCard: boolean;
  };
  /** Card deposits in the last 90 days minus card payouts and refunds in the last 90 days. */
  closedLoopOutstandingMinor: bigint;
  /** BUY_IN in the settlement asset since the last credited deposit. */
  buyInSinceLastDepositMinor: bigint;
  /** Deposits credited since the last settled withdrawal. */
  depositsSinceLastWithdrawalMinor: bigint;
  /** A credential or second-factor change in the last 72 hours (RECENT_SECURITY_CHANGE_EVENT_TYPES). */
  recentSecurityChange: boolean;
  /** "This wasn't me" in the last 30 days. */
  notMeReported: boolean;
  now: Date;
}

export interface WithdrawalDecision {
  action: "AUTO_APPROVE" | "MANUAL_REVIEW";
  reasons: WithdrawalReason[];
  approvalsRequired: 1 | 2;
  rulesVersion: string;
}

export function evaluateWithdrawal(input: WithdrawalRuleInput): WithdrawalDecision {
  const reasons: WithdrawalReason[] = [];
  const add = (reason: WithdrawalReason, when: boolean) => { if (when) reasons.push(reason); };
  const { compliance: c, destination: d, limits } = input;
  add("AUTO_APPROVE_DISABLED", !input.autoApproveEnabled);
  add("FIRST_WITHDRAWAL", input.settledWithdrawals === 0);
  add("AMOUNT_OVER_AUTO_LIMIT", input.amountMinor > limits.autoApproveMaxMinor);
  add("DAILY_AUTO_LIMIT", input.autoApprovedLast24hMinor + input.amountMinor > limits.autoApproveDailyMaxMinor);
  add("RISK_NOT_LOW", c.riskLevel !== "LOW");
  add("SCREENING_NOT_CLEAR", c.screeningStatus !== "CLEAR");
  add("SOURCE_OF_FUNDS_PENDING", c.sourceOfFundsStatus === "REQUESTED" || c.sourceOfFundsStatus === "SUBMITTED");
  add("RESTRICTED_MANUAL", c.restriction === "WITHDRAWALS_MANUAL");
  add("CHARGEBACK_HISTORY", c.chargebackCount > 0);
  add("NEW_DESTINATION", d.successfulPayouts === 0);
  add("DESTINATION_YOUNG", input.now.getTime() - d.createdAt.getTime() < DESTINATION_YOUNG_MS);
  add("DESTINATION_SHARED", d.sharedWithOtherUser);
  add("OWNERSHIP_PROOF_REQUIRED", input.method === "CRYPTO" && d.cumulativeMinor > OWNERSHIP_PROOF_THRESHOLD_MINOR && !d.ownershipVerified);
  add("CLOSED_LOOP", input.closedLoopOutstandingMinor > 0n && !d.isRecentDepositCard);
  add("LOW_PLAY", input.buyInSinceLastDepositMinor === 0n || input.buyInSinceLastDepositMinor < input.depositsSinceLastWithdrawalMinor);
  add("RECENT_SECURITY_CHANGE", input.recentSecurityChange);
  add("NOT_ME_REPORTED", input.notMeReported);
  add("REFUND_TO_SOURCE", input.kind === "REFUND" && input.method === "CRYPTO");
  if (reasons.length === 0) return { action: "AUTO_APPROVE", reasons, approvalsRequired: 1, rulesVersion: RULES_VERSION };
  const dual = input.amountMinor >= limits.dualApprovalMinMinor || c.riskLevel === "HIGH" || d.sharedWithOtherUser || input.liveMode;
  return { action: "MANUAL_REVIEW", reasons, approvalsRequired: dual ? 2 : 1, rulesVersion: RULES_VERSION };
}
