/**
 * Wallet wire contract (docs/money/WALLET.md sections 11 and 12): the bodies
 * of the player routes (/api/wallet/*, apps/edge/src/http/wallet.ts), the
 * admin routes (/api/admin/payments/*, apps/edge/src/http/admin-payments.ts)
 * and the views the payments Worker returns over RPC
 * (apps/edge/src/payments/contract.ts). apps/web renders exactly these.
 *
 * Money on the wire is always a decimal string in the asset's major unit
 * with exactly WALLET_DECIMALS places in responses ("50.00", "-0.05"); a
 * request may send fewer places ("50", "50.5") but never more, and never a
 * sign, exponent, grouping or a JSON number (MONEY_AMOUNT_PATTERN; the server
 * parses it with parseMinor, never through a float). Ids are strings, times
 * are UTC ISO-8601 strings, and nothing here carries a bigint.
 */
import { canonicalJson, sha256HexAsync } from "./audit.js";
import type { StepUpGrantMethod, StepUpPurpose } from "./account.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** PAYMENTS_MODE of the payments Worker. "off" (production today): no money moves. */
export const PAYMENTS_MODES = ["off", "sandbox", "live"] as const;
export type PaymentsMode = (typeof PAYMENTS_MODES)[number];

/**
 * The asset player balances are booked in. EUR in live mode; TEST_EUR (no
 * value, usable only with the sandbox provider) in sandbox mode.
 */
export type SettlementAsset = "EUR" | "TEST_EUR";
/** Both settlement assets have 2 decimals (Asset.decimals). */
export const WALLET_DECIMALS = 2;
/** A request amount: digits, optionally a point and 1..2 more digits; no sign, no leading zeros. */
export const MONEY_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/;

export const PAYMENT_METHODS = ["CARD", "CRYPTO"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const KYC_STATUSES = ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const RG_LIMIT_PERIODS = ["DAY", "WEEK", "MONTH"] as const;
export type RgLimitPeriod = (typeof RG_LIMIT_PERIODS)[number];

/** PaymentsRestriction (PlayerCompliance.restriction). */
export const PAYMENTS_RESTRICTIONS = ["NONE", "DEPOSITS_BLOCKED", "WITHDRAWALS_MANUAL", "FROZEN"] as const;
export type PaymentsRestriction = (typeof PAYMENTS_RESTRICTIONS)[number];

/** PaymentSwitch.key. Every switch starts off; turning one on in live mode needs two admins. */
export const PAYMENT_SWITCH_KEYS = [
  "DEPOSIT_CARD", "DEPOSIT_CRYPTO", "WITHDRAW_CARD", "WITHDRAW_CRYPTO", "AUTO_APPROVE", "PAYOUT_DISPATCH", "NEW_INSTRUMENTS",
] as const;
export type PaymentSwitchKey = (typeof PAYMENT_SWITCH_KEYS)[number];

/** Same values and order as the database enums (apps/edge/src/payments/state.ts is the transition table). */
export type DepositStatus =
  | "CREATED" | "PENDING" | "CONFIRMED" | "CREDITED" | "NEEDS_REVIEW" | "FAILED" | "EXPIRED" | "CANCELLED" | "PARTIALLY_REVERSED" | "REVERSED";
export type WithdrawalStatus =
  | "REQUESTED" | "HELD" | "UNDER_REVIEW" | "APPROVED" | "SUBMITTED" | "SETTLED" | "FAILED" | "REJECTED" | "CANCELLED" | "RETURNED";
export type WithdrawalKind = "PLAYER" | "REFUND";
export type InstrumentStatus = "ACTIVE" | "REVOKED" | "BLOCKED";

/**
 * What a player sees for a withdrawal (section 11.1): HELD and UNDER_REVIEW
 * are "Pending review", APPROVED and SUBMITTED are "Processing". REQUESTED is
 * never visible (it is HELD in the same transaction).
 */
export type WithdrawalDisplayStatus = "PENDING_REVIEW" | "PROCESSING" | "PAID" | "FAILED" | "REJECTED" | "CANCELLED" | "RETURNED";

export const WITHDRAWAL_DISPLAY_STATUS: Readonly<Record<WithdrawalStatus, WithdrawalDisplayStatus>> = Object.freeze({
  REQUESTED: "PENDING_REVIEW",
  HELD: "PENDING_REVIEW",
  UNDER_REVIEW: "PENDING_REVIEW",
  APPROVED: "PROCESSING",
  SUBMITTED: "PROCESSING",
  SETTLED: "PAID",
  FAILED: "FAILED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
  RETURNED: "RETURNED",
});

// ---------------------------------------------------------------------------
// GET /api/wallet (section 12.2)
// ---------------------------------------------------------------------------

export type RealMoneyState = "UNAVAILABLE" | "RESTRICTED" | "ACTIVE";

/** Why real money is not (fully) available, in the order the UI should address them. */
export type RealMoneyReason =
  | "NOT_LAUNCHED" | "PAUSED" | "REGION" | "KYC_REQUIRED" | "KYC_PENDING" | "LIMITS_SETUP_REQUIRED"
  | "SELF_EXCLUDED" | "ACCOUNT_RESTRICTED" | "SOURCE_OF_FUNDS_REQUIRED";

export interface CryptoAssetOption {
  /** Asset.code of the pay or payout currency, e.g. "BTC", "USDC_ERC20". */
  code: string;
  /** Asset.network, e.g. "bitcoin", "ethereum". */
  network: string;
  label: string;
}

/** The real-money part of the wallet, from the payments Worker (null when mode is "off" or the binding is absent). */
export interface RealMoneySummary {
  state: RealMoneyState;
  reasons: RealMoneyReason[];
  asset: SettlementAsset;
  decimals: typeof WALLET_DECIMALS;
  /** USER_AVAILABLE balance. */
  available: string;
  /** USER_WITHDRAWAL_HOLD balance: open withdrawals and refund holds. */
  pendingWithdrawals: string;
  canDeposit: boolean;
  canWithdraw: boolean;
  methods: { deposit: PaymentMethod[]; withdraw: PaymentMethod[] };
  cryptoAssets: CryptoAssetOption[];
  kyc: { status: KycStatus; requiredForDeposit: boolean };
  /** The deposit limit in force per period, or null for none. */
  limits: Record<RgLimitPeriod, string | null>;
}

/** 200 from GET /api/wallet. */
export interface WalletSummary {
  mode: PaymentsMode;
  realMoney: RealMoneySummary | null;
  /** User.bankroll: play chips, no cash value, never convertible. */
  play: { chips: number; redeemable: false };
}

// ---------------------------------------------------------------------------
// Pages and history
// ---------------------------------------------------------------------------

/** A cursor page. Pass `next` back as `cursor`; null at the end. */
export interface Page<T> {
  items: T[];
  next: string | null;
}

/**
 * One movement of the player's available balance, newest first. Ledger types:
 * DEPOSIT_CREDIT = DEPOSIT; WITHDRAWAL_HOLD = WITHDRAWAL (or REFUND for an
 * excess or refund-to-source hold); WITHDRAWAL_RELEASE = WITHDRAWAL_RELEASED;
 * WITHDRAWAL_RETURN = PAYOUT_RETURNED; DEPOSIT_REVERSAL = REVERSAL;
 * CHARGEBACK_RECOVERY = RECOVERY; ADJUSTMENT = ADJUSTMENT. FEE is reserved
 * for a fee charged to the player's available balance.
 */
export type WalletTxKind =
  | "DEPOSIT" | "WITHDRAWAL" | "WITHDRAWAL_RELEASED" | "PAYOUT_RETURNED" | "REVERSAL" | "RECOVERY" | "REFUND" | "FEE" | "ADJUSTMENT";

export interface WalletTxView {
  /** LedgerTransaction.id. */
  id: string;
  /** LedgerTransaction.seq (a bigint, as a decimal string). */
  seq: string;
  kind: WalletTxKind;
  /** Signed change of the available balance ("-20.00"). */
  amount: string;
  balanceAfter: string;
  /** The status of the payment object behind it (a DepositStatus or WithdrawalStatus), or null. */
  status: string | null;
  createdAt: string;
  /** The payment object behind it, if any. */
  ref: { type: "DEPOSIT" | "WITHDRAWAL" | "REVERSAL"; id: string } | null;
}

/** GET /api/wallet/transactions?cursor&limit (limit 1..WALLET_PAGE_MAX). */
export const WALLET_PAGE_MAX = 50;
export type WalletTransactionsResponse = Page<WalletTxView>;

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/** POST /api/wallet/deposits (header Idempotency-Key: <uuid v4>). */
export type CreateDepositRequest =
  | { method: "CARD"; amount: string; instrumentId?: string; saveCard?: boolean }
  | { method: "CRYPTO"; amount: string; payAsset: string };

/** Where the player goes next to pay. */
export type DepositNext =
  | { type: "REDIRECT"; url: string; expiresAt: string }
  | {
      type: "CRYPTO_INVOICE";
      asset: string;
      network: string;
      address: string;
      memo: string | null;
      /** Amount to send in the pay asset, chain units as a decimal string (informational; the provider's settled EUR is credited). */
      payAmount: string | null;
      expiresAt: string | null;
      minConfirmations: number;
    };

export interface DepositView {
  id: string;
  method: PaymentMethod;
  status: DepositStatus;
  asset: SettlementAsset;
  /** Requested amount. */
  amount: string;
  /** Credited (the provider's settled amount), once confirmed. */
  creditedAmount: string | null;
  /** Reversed by chargebacks, refunds or reorganisations, net of recoveries. */
  reversedAmount: string;
  /** Part of the credit held for refund (over a deposit limit, self-excluded, card not allowed). */
  refundHeldAmount: string;
  payAsset: string | null;
  payNetwork: string | null;
  txHash: string | null;
  confirmations: number | null;
  /** The card used (PaymentInstrument.id), once known. */
  instrumentId: string | null;
  statusReason: string | null;
  createdAt: string;
  expiresAt: string;
  creditedAt: string | null;
  closedAt: string | null;
}

/** 201 (200 on an idempotent replay) from POST /api/wallet/deposits. next is null once the deposit no longer waits for the player. */
export interface DepositStart {
  deposit: DepositView;
  next: DepositNext | null;
}
export type CreateDepositResponse = DepositStart;

/** GET /api/wallet/deposits/:id and POST /api/wallet/deposits/:id/cancel. */
export interface DepositResponse {
  deposit: DepositView;
}

// ---------------------------------------------------------------------------
// Payment instruments (cards from deposits, crypto payout addresses)
// ---------------------------------------------------------------------------

export interface InstrumentView {
  id: string;
  kind: "CARD" | "CRYPTO_ADDRESS";
  status: InstrumentStatus;
  label: string | null;
  /** Cards: brand, last 4 digits and expiry only. */
  card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
  /** Crypto addresses: shown as the player typed them (address) plus the asset's network. */
  crypto: { asset: string; network: string; address: string; memo: string | null } | null;
  depositEnabled: boolean;
  payoutEnabled: boolean;
  /** Cooling-off: not usable for withdrawals before this time. */
  usableAfter: string;
  createdAt: string;
}

/** GET /api/wallet/instruments. */
export interface InstrumentsResponse {
  instruments: InstrumentView[];
}

/** POST /api/wallet/instruments/crypto/prepare. */
export interface PrepareCryptoDestinationRequest {
  asset: string;
  address: string;
  memo?: string | null;
}

/**
 * 200 from .../crypto/prepare. Step up for purpose "payout_destination" with
 * this bind (POST /api/auth/step-up), then add the address with the grant.
 * ownershipChallenge is the message to sign for a self-hosted wallet proof.
 */
export interface PrepareCryptoDestinationResponse {
  normalized: string;
  bind: string;
  ownershipChallenge: string;
}

export interface OwnershipProof {
  method: "MESSAGE_SIGNATURE";
  message: string;
  signature: string;
}

/** POST /api/wallet/instruments/crypto (header Idempotency-Key). */
export interface AddCryptoDestinationRequest {
  asset: string;
  address: string;
  memo?: string | null;
  label?: string;
  stepUpGrantId: string;
  ownership?: OwnershipProof;
}

/** 201 from POST /api/wallet/instruments/crypto. */
export interface InstrumentResponse {
  instrument: InstrumentView;
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

/** What a money route needs before it can run: step up for this purpose and bind. */
export interface StepUpRequirement {
  purpose: StepUpPurpose;
  /** Lower-case hex SHA-256 of the canonical action (stepUpBind). */
  bind: string;
  methods: StepUpGrantMethod[];
}

/** POST /api/wallet/withdrawals/quote. */
export interface WithdrawalQuoteRequest {
  instrumentId: string;
  amount: string;
}

export interface QuoteView {
  id: string;
  asset: SettlementAsset;
  /** Debited from the available balance. */
  amount: string;
  fee: string;
  /** amount - fee, in the settlement asset. */
  youReceive: string;
  /** What arrives: the settlement asset for a card, the crypto asset for an address. */
  receiveAsset: string;
  /** Estimated amount in receiveAsset (crypto: chain units, informational), or null. */
  receiveEstimate: string | null;
  rate: string | null;
  expiresAt: string;
}

/** 200 from POST /api/wallet/withdrawals/quote. */
export interface WithdrawalQuoteResponse {
  quote: QuoteView;
  stepUp: StepUpRequirement;
}

/** POST /api/wallet/withdrawals (header Idempotency-Key). */
export interface CreateWithdrawalRequest {
  quoteId: string;
  stepUpGrantId: string;
}

export interface WithdrawalDestinationView {
  instrumentId: string;
  kind: "CARD" | "CRYPTO_ADDRESS";
  /** "Visa •••• 4242" or the address, for display only. */
  display: string;
}

export interface WithdrawalView {
  id: string;
  kind: WithdrawalKind;
  status: WithdrawalStatus;
  displayStatus: WithdrawalDisplayStatus;
  asset: SettlementAsset;
  amount: string;
  fee: string;
  youReceive: string;
  payoutAsset: string | null;
  payoutAmount: string | null;
  destination: WithdrawalDestinationView | null;
  txHash: string | null;
  /** A player-safe reason for FAILED or REJECTED. */
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
  closedAt: string | null;
}

/** 201 from POST /api/wallet/withdrawals; GET /api/wallet/withdrawals/:id; POST .../cancel. */
export interface WithdrawalResponse {
  withdrawal: WithdrawalView;
}

/** GET /api/wallet/withdrawals?cursor. */
export interface WithdrawalsResponse {
  withdrawals: WithdrawalView[];
  next: string | null;
}

// ---------------------------------------------------------------------------
// Responsible gaming and KYC
// ---------------------------------------------------------------------------

export interface DepositLimitPeriodView {
  /** The limit in force now, or null for none. */
  active: string | null;
  /** A looser limit (or a removal: amount null) waiting out its 24 h. */
  pending: { amount: string | null; effectiveFrom: string } | null;
}

/** GET and PUT /api/wallet/limits. */
export interface DepositLimitsResponse {
  deposit: Record<RgLimitPeriod, DepositLimitPeriodView>;
}

/** PUT /api/wallet/limits: a stricter limit applies now, a looser one or a removal (null) after 24 h. */
export interface SetDepositLimitRequest {
  period: RgLimitPeriod;
  amount: string | null;
}

/** 200 from POST /api/wallet/kyc/session: start the provider's SDK with this token. */
export interface KycSessionResponse {
  provider: string;
  sdkToken: string;
  expiresAt: string;
  /** Sandbox only: the built-in verification page to open instead of a provider SDK. */
  url?: string;
}

/**
 * POST /api/wallet/not-me (no session needed): the token from the "This
 * wasn't me" link of a payments email (/auth/not-me#w=<token>). Freezes
 * withdrawals, removes payout destinations added in the last 72 hours and
 * cancels undispatched withdrawals. 200 { secured: true } (also for a token
 * already used); 400 TOKEN_INVALID for a forged or expired one.
 */
export interface WalletNotMeRequest {
  token: string;
}

export interface WalletNotMeResponse {
  secured: true;
}

export const SELF_EXCLUSION_PERIODS = ["24h", "48h", "7d", "30d", "90d", "180d", "365d", "indefinite"] as const;
export type SelfExclusionPeriod = (typeof SELF_EXCLUSION_PERIODS)[number];

/** POST /api/account/self-exclusion. */
export interface SelfExclusionRequest {
  period: SelfExclusionPeriod;
}

/** 201 from POST /api/account/self-exclusion. */
export interface SelfExclusionResponse {
  id: string;
  kind: "DEFINITE" | "INDEFINITE";
  startsAt: string;
  /** null for an indefinite exclusion. */
  endsAt: string | null;
}

/**
 * GET /api/account/self-exclusion, and the answer to POST
 * /api/account/self-exclusion/reactivation. An exclusion stays in force after
 * endsAt until the player asks to come back and the cooling-off has passed.
 */
export interface SelfExclusionStatus {
  /** In force now: deposits are closed. */
  active: boolean;
  kind: "DEFINITE" | "INDEFINITE" | null;
  endsAt: string | null;
  /** The player may ask now: a timed exclusion that ended, or an indefinite one. */
  canRequestReturn: boolean;
  /** When the player asked. */
  requestedAt: string | null;
  /** When deposits reopen; null while an indefinite exclusion waits for an administrator. */
  accessRestoredAt: string | null;
}

// ---------------------------------------------------------------------------
// Admin (/api/admin/payments/*, section 11.2). Every mutating request carries
// an admin step-up grant: purpose admin_payments, a passkey, bound to
// adminPaymentsAction(subject, decision).
// ---------------------------------------------------------------------------

export interface AdminWithdrawalItem {
  id: string;
  userId: string;
  username: string;
  kind: WithdrawalKind;
  status: WithdrawalStatus;
  asset: SettlementAsset;
  amount: string;
  fee: string;
  destination: WithdrawalDestinationView | null;
  /** Review rule codes (rules.ts), e.g. FIRST_WITHDRAWAL. */
  reasons: string[];
  approvalsRequired: number;
  approvals: number;
  createdAt: string;
}

/** GET /api/admin/payments/withdrawals?status&cursor. */
export type AdminWithdrawalsResponse = Page<AdminWithdrawalItem>;

export interface AdminComplianceSummary {
  kycStatus: KycStatus;
  screeningStatus: "NOT_SCREENED" | "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  sourceOfFundsStatus: "NOT_REQUIRED" | "REQUESTED" | "SUBMITTED" | "APPROVED" | "REJECTED";
  restriction: PaymentsRestriction;
  restrictionReason: string | null;
  residenceCountry: string | null;
  lifetimeDeposited: string;
  chargebackCount: number;
  securityHoldUntil: string | null;
}

export interface AdminPayoutAttemptView {
  seq: number;
  action: "CREATE" | "QUERY" | "REFUND";
  outcome: "ACCEPTED" | "COMPLETED" | "REJECTED_FINAL" | "REJECTED_RETRYABLE" | "UNCERTAIN" | "NOT_FOUND";
  httpStatus: number | null;
  providerPayoutId: string | null;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface AdminReviewActionView {
  id: string;
  verb: "APPROVE" | "REJECT" | "NOTE" | "RESTRICT" | "UNRESTRICT" | "RESOLVE" | "SWITCH_ON" | "SWITCH_OFF";
  actorKind: "ADMIN" | "SYSTEM" | "PLAYER";
  actorUserId: string | null;
  reasonCode: string | null;
  note: string | null;
  createdAt: string;
}

export interface AdminLedgerEntryView {
  seq: string;
  txId: string;
  type: string;
  accountType: string;
  amount: string;
  balanceAfter: string;
  reference: Record<string, string | number | boolean | null>;
  createdAt: string;
}

/** GET /api/admin/payments/withdrawals/:id. */
export interface AdminWithdrawalDetail {
  withdrawal: AdminWithdrawalItem & {
    providerKey: string | null;
    providerPayoutId: string | null;
    txHash: string | null;
    failureCode: string | null;
    rulesVersion: string | null;
    dispatchStatus: string | null;
  };
  compliance: AdminComplianceSummary;
  instrument: InstrumentView | null;
  attempts: AdminPayoutAttemptView[];
  reviewActions: AdminReviewActionView[];
  ledger: AdminLedgerEntryView[];
}

/** POST /api/admin/payments/withdrawals/:id/approve. */
export interface AdminApproveWithdrawalRequest {
  note?: string;
  /**
   * A crypto deposit's refund only: the player's active payout address it goes
   * to (the source address is not known). Part of what the grant authorises:
   * the decision is "APPROVE:<id>", and a second administrator names the same one.
   */
  refundInstrumentId?: string;
  stepUpGrantId: string;
}

/** POST /api/admin/users/:userId/instruments/:id/restore: subject "instrument:<id>", decision "RESTORE". Two administrators. */
export interface AdminRestoreInstrumentRequest {
  reason: string;
  stepUpGrantId: string;
}

/** The new row once the second administrator agreed (null until then). */
export interface AdminRestoreInstrumentResponse {
  instrument: InstrumentView | null;
  approvalsRemaining: number;
}

/** An indefinite self-exclusion whose player asked to come back. */
export interface AdminReactivationItem {
  id: string;
  userId: string;
  username: string;
  startsAt: string;
  requestedAt: string;
}

export type AdminReactivationsResponse = Page<AdminReactivationItem>;

/** POST /api/admin/payments/self-exclusions/:id/accept: subject "self-exclusion:<id>", decision "ACCEPT". */
export interface AdminAcceptReactivationRequest {
  note: string;
  stepUpGrantId: string;
}

export interface AdminAcceptReactivationResponse {
  accessRestoredAt: string;
}

/** 200 from approve and resolve-uncertain: still UNDER_REVIEW while approvalsRemaining > 0. */
export interface AdminWithdrawalDecisionResponse {
  withdrawal: AdminWithdrawalItem;
  approvalsRemaining: number;
}

/** POST /api/admin/payments/withdrawals/:id/reject. */
export interface AdminRejectWithdrawalRequest {
  reasonCode: string;
  note?: string;
  stepUpGrantId: string;
}

/** POST /api/admin/payments/withdrawals/:id/resolve-uncertain (two distinct admins). */
export interface AdminResolveUncertainRequest {
  outcome: "SETTLED" | "FAILED";
  evidence: { providerPayoutId?: string; txHash?: string; statementLine?: string };
  stepUpGrantId: string;
}

export interface AdminDepositItem {
  id: string;
  userId: string;
  username: string;
  method: PaymentMethod;
  status: DepositStatus;
  providerKey: string;
  asset: SettlementAsset;
  amount: string;
  /** What the provider reported settling when the deposit went to review: the ceiling of a CREDIT. */
  reportedAmount: string | null;
  creditedAmount: string | null;
  payAsset: string | null;
  statusReason: string | null;
  createdAt: string;
}

/** GET /api/admin/payments/deposits?status=NEEDS_REVIEW&cursor. */
export type AdminDepositsResponse = Page<AdminDepositItem>;

/**
 * POST /api/admin/payments/deposits/:id/resolve. creditAmount is required for
 * CREDIT and is at most reportedAmount (for a card, also at most amount). In
 * live mode a CREDIT waits for a second administrator naming the same amount.
 */
export interface AdminResolveDepositRequest {
  action: "CREDIT" | "FAIL";
  creditAmount?: string;
  note: string;
  stepUpGrantId: string;
}

export interface AdminDepositResponse {
  deposit: AdminDepositItem;
  /** Administrators still to confirm this CREDIT; the deposit stays under review until 0. */
  approvalsRemaining: number;
}

/** GET /api/admin/users/:userId/ledger?asset&before&limit (limit 1..100). */
export interface AdminUserLedgerResponse {
  entries: AdminLedgerEntryView[];
  /** Pass as `before` (a seq); null at the end. */
  next: string | null;
}

/** POST /api/admin/users/:userId/payments-restriction. NONE lifts it (UNRESTRICT). */
export interface AdminSetRestrictionRequest {
  restriction: PaymentsRestriction;
  reason: string;
  stepUpGrantId: string;
}

export interface AdminRestrictionResponse {
  compliance: AdminComplianceSummary;
}

/**
 * POST /api/admin/users/:userId/screening: a person's screening decision.
 * A match (POTENTIAL_MATCH, CONFIRMED_MATCH) takes one administrator and stops
 * what has not been sent; CONFIRMED_MATCH also freezes the account. CLEAR
 * lifts a match and takes two administrators, both after the last screening
 * change. Grant: subject user:<id>, decision SCREENING:<status>.
 */
export interface AdminSetScreeningRequest {
  status: "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";
  reason: string;
  stepUpGrantId: string;
}

export interface AdminScreeningResponse {
  compliance: AdminComplianceSummary;
  /** 0 once the decision took effect. */
  approvalsRemaining: number;
}

export interface AdminSwitchView {
  key: PaymentSwitchKey;
  enabled: boolean;
  updatedBy: string | null;
  reason: string | null;
  updatedAt: string;
}

/** GET /api/admin/payments/switches. */
export interface AdminSwitchesResponse {
  switches: AdminSwitchView[];
}

/** POST /api/admin/payments/switches. Turning a switch ON in live mode needs two admins. */
export interface AdminSetSwitchRequest {
  key: PaymentSwitchKey;
  enabled: boolean;
  reason: string;
  stepUpGrantId: string;
}

export interface AdminSetSwitchResponse {
  switch: AdminSwitchView;
  approvalsRemaining: number;
}

export interface AdminReconciliationRunView {
  id: string;
  kind: "LEDGER" | "PAYMENTS" | "PROVIDER" | "CUSTODY";
  scopeDate: string | null;
  status: "RUNNING" | "OK" | "ISSUES" | "FAILED";
  summary: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

export interface AdminReconciliationIssueView {
  id: string;
  runId: string;
  code: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  subjectType: string | null;
  subjectId: string;
  details: Record<string, unknown>;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
}

/** GET /api/admin/payments/reconciliation/runs and .../issues?status=OPEN. */
export type AdminReconciliationRunsResponse = Page<AdminReconciliationRunView>;
export type AdminReconciliationIssuesResponse = Page<AdminReconciliationIssueView>;

/** POST /api/admin/payments/reconciliation/issues/:id/resolve. */
export interface AdminResolveIssueRequest {
  status: "ACKNOWLEDGED" | "RESOLVED";
  resolution: string;
  stepUpGrantId: string;
}

export interface AdminPaymentEventView {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  objectType: "PAYMENT" | "PAYOUT" | "REFUND" | "DISPUTE" | "KYC";
  objectRef: string | null;
  outcome: "APPLIED" | "DUPLICATE" | "STALE" | "UNKNOWN_OBJECT" | "NEEDS_REVIEW" | "DEAD" | null;
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
}

/** GET /api/admin/payments/events?outcome=DEAD&cursor. */
export type AdminPaymentEventsResponse = Page<AdminPaymentEventView>;

/** POST /api/admin/payments/events/:id/requeue (a DEAD event only). */
export interface AdminRequeueEventRequest {
  stepUpGrantId: string;
}

/** POST /api/admin/payments/custody-snapshot: the segregated player-funds balance the operator read. */
export interface AdminCustodySnapshotRequest {
  asOf: string;
  segregatedBalance: string;
  source: string;
  stepUpGrantId: string;
}

export interface AdminCustodySnapshotResponse {
  /** Σ USER_AVAILABLE + USER_WITHDRAWAL_HOLD (+ TABLE_ESCROW in Phase 2). */
  liabilities: string;
  segregatedBalance: string;
  /** segregatedBalance - liabilities; negative is a CRITICAL reconciliation issue. */
  surplus: string;
}

// ---------------------------------------------------------------------------
// Errors (body { error, code, ...details }; never 401 for a step-up)
// ---------------------------------------------------------------------------

/**
 * Every wallet `code`, with its HTTP status. The payments Worker returns it
 * in RpcResult; poker-api answers with that status and this body.
 */
export const WALLET_ERROR_STATUS = Object.freeze({
  VALIDATION: 422,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  /** A "This wasn't me" token that is forged, malformed or expired. */
  TOKEN_INVALID: 400,
  IDEMPOTENCY_CONFLICT: 409,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  // Gates (section 12.1).
  REAL_MONEY_DISABLED: 403,
  PAYMENTS_PAUSED: 503,
  METHOD_DISABLED: 403,
  REGION_BLOCKED: 403,
  KYC_REQUIRED: 403,
  KYC_PENDING: 403,
  SELF_EXCLUDED: 403,
  ACCOUNT_RESTRICTED: 403,
  SOURCE_OF_FUNDS_REQUIRED: 403,
  LIMITS_SETUP_REQUIRED: 422,
  /** User.securityHoldUntil has not passed (credential change, "this wasn't me"). */
  SECURITY_HOLD: 403,
  STEP_UP_REQUIRED: 403,
  // Deposits.
  AMOUNT_BELOW_MIN: 422,
  AMOUNT_ABOVE_MAX: 422,
  DEPOSIT_LIMIT_EXCEEDED: 422,
  ASSET_UNSUPPORTED: 422,
  TOO_MANY_PENDING: 422,
  INVALID_STATE: 409,
  // Instruments.
  ADDRESS_INVALID: 422,
  MEMO_REQUIRED: 422,
  ADDRESS_BLOCKED: 422,
  DESTINATION_EXISTS: 409,
  DESTINATION_LIMIT: 422,
  INSTRUMENT_IN_USE: 409,
  DESTINATION_COOLING_OFF: 409,
  /** Revoked, blocked or not enabled for payouts. */
  DESTINATION_UNAVAILABLE: 409,
  // Withdrawals.
  INSUFFICIENT_FUNDS: 422,
  QUOTE_EXPIRED: 409,
  /** Over what this card deposited less what it already received (details.max); the rest needs a payout address. */
  CARD_PAYOUT_LIMIT: 422,
  CANCEL_DISABLED: 403,
  /** An RG rule refused it (deposit limit timing, self-exclusion reopening). */
  RG_RULE: 422,
  /** A timed self-exclusion has not reached its end yet (details.endsAt). */
  EXCLUSION_NOT_ENDED: 409,
  // Admin.
  ADMIN_ACCESS_REQUIRED: 401,
  FORBIDDEN: 403,
  SELF_APPROVAL: 409,
  ALREADY_APPROVED: 409,
  /** A refund with nowhere known to go: approving a crypto refund needs one of the player's active payout addresses named. */
  REFUND_DESTINATION_REQUIRED: 409,
  /** A card deposit the provider named no card for: it cannot be credited, only failed and refunded at the provider. */
  CARD_UNKNOWN: 409,
  // Infrastructure.
  PROVIDER_UNAVAILABLE: 503,
  PAYMENTS_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const);

export type WalletErrorCode = keyof typeof WALLET_ERROR_STATUS;
export type WalletErrorStatus = (typeof WALLET_ERROR_STATUS)[WalletErrorCode];

export interface WalletErrorBody {
  error: string;
  code: WalletErrorCode;
  /** True when the same request may succeed later (503). */
  retryable?: boolean;
  /** DEPOSIT_LIMIT_EXCEEDED: { remaining }; DESTINATION_COOLING_OFF: { usableAfter }; ... */
  details?: Record<string, string>;
}

/** 403 when a money route needs a (new) step-up grant: get one for exactly this purpose and bind. */
export interface StepUpRequiredBody extends WalletErrorBody, StepUpRequirement {
  code: "STEP_UP_REQUIRED";
}

// ---------------------------------------------------------------------------
// Step-up binding (INTEGRATION.md override 8): what a grant authorises
// ---------------------------------------------------------------------------

/** Version of the canonical actions below; a change makes old binds match nothing. */
export const STEP_UP_BIND_VERSION = 1;

/** A withdrawal of exactly this quote: asset, amount (minor units, decimal strings) and destination (instrumentId). */
export function withdrawalAction(input: { userId: string; asset: SettlementAsset; instrumentId: string; amountMinor: string; feeMinor: string; quoteId: string }) {
  return { v: STEP_UP_BIND_VERSION, purpose: "withdrawal" as const, ...input };
}

/** Saving exactly this payout address (normalised as the payments Worker stores it). */
export function payoutDestinationAction(input: { userId: string; asset: string; addressNormalized: string; memo: string | null }) {
  return { v: STEP_UP_BIND_VERSION, purpose: "payout_destination" as const, ...input };
}

/** An admin decision on one subject, e.g. ("withdrawal:<id>", "APPROVE") or ("switch:DEPOSIT_CARD", "ON"). */
export function adminPaymentsAction(input: { subject: string; decision: string }) {
  return { v: STEP_UP_BIND_VERSION, purpose: "admin_payments" as const, ...input };
}

/**
 * An admin action that can only stop money: a switch turned OFF, an account
 * FROZEN. It stays possible with one administrator during that administrator's
 * own security hold (still grant-protected and audited): the worst it can do
 * is pause something a colleague turns back on. Everything else waits.
 */
export function isAdminSafetyAction(input: { subject: string; decision: string }): boolean {
  return (/^switch:[A-Z_]{1,40}$/.test(input.subject) && input.decision === "OFF")
    || (/^user:[A-Za-z0-9_-]{1,128}$/.test(input.subject) && input.decision === "RESTRICT:FROZEN");
}

export type StepUpAction =
  | ReturnType<typeof withdrawalAction>
  | ReturnType<typeof payoutDestinationAction>
  | ReturnType<typeof adminPaymentsAction>;

/**
 * StepUpGrant.bindHash of an action: lower-case hex SHA-256 of its canonical
 * JSON (canonicalJson: sorted keys, no whitespace, strings and safe integers
 * only). The payments Worker computes it, returns it as `bind`, and compares
 * it inside the transaction that consumes the grant.
 */
export function stepUpBind(action: StepUpAction): Promise<string> {
  return sha256HexAsync(canonicalJson(action));
}
