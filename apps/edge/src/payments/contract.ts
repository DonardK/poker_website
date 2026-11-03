/**
 * The RPC contract between poker-api and the poker-payments Worker
 * (docs/money/WALLET.md section 11.4). poker-api reaches payments only
 * through the PAYMENTS service binding (entrypoint PaymentsRpc), with the
 * caller it authenticated; payments re-checks everything it depends on
 * (session, step-up grant, Cloudflare Access for admins, gates) itself, so a
 * compromised poker-api can only ask for what a signed-in player could.
 *
 * Every method answers RpcResult: either { ok: true, value } or a failure
 * carrying the HTTP status and the wallet error code (WALLET_ERROR_STATUS in
 * packages/shared/src/wallet.ts) that poker-api turns into its response.
 * Methods do not throw for a refusal; a thrown error (or a dropped binding)
 * is answered 503 PAYMENTS_UNAVAILABLE by poker-api. Values are structured
 * clones: plain objects, strings, numbers, booleans and null only (money as
 * decimal strings).
 *
 * The binding is optional on poker-api: production has no poker-payments
 * Worker yet, and an absent binding means PAYMENTS_MODE=off (the wallet
 * shows "not launched" and every money route answers REAL_MONEY_DISABLED).
 */
import {
  WALLET_ERROR_STATUS,
  type AddCryptoDestinationRequest,
  type AdminAcceptReactivationRequest,
  type AdminAcceptReactivationResponse,
  type AdminApproveWithdrawalRequest,
  type AdminCustodySnapshotRequest,
  type AdminCustodySnapshotResponse,
  type AdminDepositResponse,
  type AdminDepositsResponse,
  type AdminPaymentEventsResponse,
  type AdminReactivationsResponse,
  type AdminReconciliationIssuesResponse,
  type AdminReconciliationRunsResponse,
  type AdminRejectWithdrawalRequest,
  type AdminRequeueEventRequest,
  type AdminResolveDepositRequest,
  type AdminResolveIssueRequest,
  type AdminResolveUncertainRequest,
  type AdminRestoreInstrumentRequest,
  type AdminRestoreInstrumentResponse,
  type AdminRestrictionResponse,
  type AdminScreeningResponse,
  type AdminSetRestrictionRequest,
  type AdminSetScreeningRequest,
  type AdminSetSwitchRequest,
  type AdminSetSwitchResponse,
  type AdminSwitchesResponse,
  type AdminUserLedgerResponse,
  type AdminWithdrawalDecisionResponse,
  type AdminWithdrawalDetail,
  type AdminWithdrawalsResponse,
  type CreateDepositRequest,
  type CreateWithdrawalRequest,
  type DepositStart,
  type DepositStatus,
  type DepositView,
  type InstrumentView,
  type KycSessionResponse,
  type Page,
  type PaymentsMode,
  type PrepareCryptoDestinationRequest,
  type PrepareCryptoDestinationResponse,
  type RealMoneySummary,
  type SettlementAsset,
  type StepUpRequirement,
  type WalletErrorCode,
  type WalletTxView,
  type WithdrawalQuoteRequest,
  type WithdrawalQuoteResponse,
  type WithdrawalStatus,
  type WithdrawalView,
} from "@poker/shared";

/** wrangler.payments.jsonc "name" and the entrypoint class poker-api binds to. */
export const PAYMENTS_SERVICE = "poker-payments";
export const PAYMENTS_RPC_ENTRYPOINT = "PaymentsRpc";

// ---------------------------------------------------------------------------
// Callers and results
// ---------------------------------------------------------------------------

/** A signed-in player, as poker-api authenticated them (payments re-reads the session). */
export interface Caller {
  userId: string;
  sessionId: string;
  /** poker-api's request id, for correlated logs. */
  requestId: string;
  ip: string | null;
  /** ISO 3166 alpha-2 from request.cf.country via poker-web (x-poker-ip-country); "T1" is Tor; null if unknown. */
  ipCountry: string | null;
  userAgent: string | null;
}

/** An administrator: payments verifies the Cloudflare Access JWT (required in live mode), the session and User.role itself. */
export interface AdminCaller extends Caller {
  accessJwt: string | null;
}

/** A call made by poker-api itself after an account event, not by a request of that user (no live session). */
export interface SystemCaller {
  userId: string;
  requestId: string;
}

export type RpcStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

export interface RpcFailure {
  ok: false;
  status: RpcStatus;
  code: WalletErrorCode;
  /** Safe to show to the player (never a provider message, id or SQL). */
  message: string;
  retryable?: boolean;
  /** Extra fields of the error body, e.g. { remaining: "40.00" } or { usableAfter: "<ISO>" }. */
  details?: Record<string, string>;
  /** Set with STEP_UP_REQUIRED: what to step up for. */
  stepUp?: StepUpRequirement;
}

export type RpcResult<T> = { ok: true; value: T } | RpcFailure;

export function rpcOk<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

/** A failure with the status WALLET_ERROR_STATUS assigns to the code. */
export function rpcFail(
  code: WalletErrorCode,
  message: string,
  extra: { retryable?: boolean; details?: Record<string, string>; stepUp?: StepUpRequirement } = {},
): RpcFailure {
  return { ok: false, status: WALLET_ERROR_STATUS[code], code, message, ...extra };
}

// ---------------------------------------------------------------------------
// Inputs (the HTTP bodies plus what poker-api adds)
// ---------------------------------------------------------------------------

/** poker-api's Idempotency-Key header (a UUID v4), per user. The same key with another body is IDEMPOTENCY_CONFLICT. */
export interface ClientRequest {
  clientRequestId: string;
}

export type CreateDepositInput = CreateDepositRequest & ClientRequest;
export type AddCryptoDestinationInput = AddCryptoDestinationRequest & ClientRequest;
export type RequestWithdrawalInput = CreateWithdrawalRequest & ClientRequest;

export interface PageQuery {
  cursor?: string;
  /** 1..50 (WALLET_PAGE_MAX); payments clamps it. */
  limit?: number;
}

/** What GET /api/wallet needs from payments; poker-api adds play.chips from User.bankroll. */
export interface RealMoneyOverview {
  mode: PaymentsMode;
  realMoney: RealMoneySummary | null;
}

export type AdminWithdrawalDecision =
  | ({ decision: "APPROVE" } & AdminApproveWithdrawalRequest)
  | ({ decision: "REJECT" } & AdminRejectWithdrawalRequest);

export type LockdownReason = "NOT_ME" | "ADMIN";

/** One "This wasn't me" report, as poker-api recorded it (the security event written before it calls payments). */
export interface LockdownReportInput {
  /** AccountSecurityEvent.id. A report is applied once, however often it is delivered. */
  id: string;
  /** ISO time of the report: the 72-hour window is counted back from here. */
  at: string;
  /** What the notice named: its kind and the instrument or withdrawal. */
  notice: { k: string; s: string } | null;
}

/** A valid "This wasn't me" token's claims: who it is about and what the notice named. */
export interface NotMeTokenClaims {
  u: string;
  k: string;
  s: string;
  /** Expiry, epoch milliseconds: the link was sent NOT_ME_TTL_MS before it. */
  e: number;
}

/** A create answer plus whether it was an idempotent replay. */
export type Replayed<T> = T & { replay: boolean };

/** Liveness and role isolation of the payments Worker (no secrets). */
export interface PaymentsHealth {
  ok: boolean;
  mode: PaymentsMode;
  settlementAsset: SettlementAsset | null;
  /** assertRoleIsolation held for this isolate's database login. */
  roleIsolation: boolean;
}

// ---------------------------------------------------------------------------
// The RPC surface (implemented by class PaymentsRpc in src/payments/worker.ts)
// ---------------------------------------------------------------------------

export interface PaymentsApi {
  health(): Promise<PaymentsHealth>;

  // Player (section 11.1).
  realMoneySummary(caller: Caller): Promise<RpcResult<RealMoneyOverview>>;
  listTransactions(caller: Caller, query: PageQuery): Promise<RpcResult<Page<WalletTxView>>>;
  /** replay: the Idempotency-Key was seen before with the same body (poker-api answers 200 instead of 201). */
  createDeposit(caller: Caller, input: CreateDepositInput): Promise<RpcResult<Replayed<DepositStart>>>;
  getDeposit(caller: Caller, depositId: string): Promise<RpcResult<DepositView>>;
  /** CREATED or PENDING only (409 INVALID_STATE otherwise). */
  cancelDeposit(caller: Caller, depositId: string): Promise<RpcResult<DepositView>>;
  listInstruments(caller: Caller): Promise<RpcResult<InstrumentView[]>>;
  prepareCryptoDestination(caller: Caller, input: PrepareCryptoDestinationRequest): Promise<RpcResult<PrepareCryptoDestinationResponse>>;
  /** Consumes a payout_destination grant bound to prepareCryptoDestination's bind. */
  addCryptoDestination(caller: Caller, input: AddCryptoDestinationInput): Promise<RpcResult<Replayed<{ instrument: InstrumentView }>>>;
  revokeInstrument(caller: Caller, instrumentId: string): Promise<RpcResult<null>>;
  quoteWithdrawal(caller: Caller, input: WithdrawalQuoteRequest): Promise<RpcResult<WithdrawalQuoteResponse>>;
  /** Consumes the quote and a withdrawal grant bound to the quote's bind. */
  requestWithdrawal(caller: Caller, input: RequestWithdrawalInput): Promise<RpcResult<Replayed<{ withdrawal: WithdrawalView }>>>;
  getWithdrawal(caller: Caller, withdrawalId: string): Promise<RpcResult<WithdrawalView>>;
  listWithdrawals(caller: Caller, query: PageQuery): Promise<RpcResult<Page<WithdrawalView>>>;
  /** Only while UNDER_REVIEW and only with ALLOW_WITHDRAWAL_CANCEL=true (403 CANCEL_DISABLED by default). */
  cancelWithdrawal(caller: Caller, withdrawalId: string): Promise<RpcResult<WithdrawalView>>;
  /** Sets PlayerCompliance.rgLimitsPromptedAt (poker-api writes the limit rows itself). */
  markLimitsPrompted(caller: Caller): Promise<RpcResult<null>>;
  startKyc(caller: Caller): Promise<RpcResult<KycSessionResponse>>;
  /** After poker-api inserted a SelfExclusion: cancel open deposits (locally, best effort at the provider). */
  onSelfExcluded(caller: Caller): Promise<RpcResult<null>>;
  /**
   * "This wasn't me" (src/auth/lockdown.ts onAccountLockdown) or an admin:
   * WITHDRAWALS_MANUAL, revoke destinations added in the 72 h before the report
   * and the one the notice names, void grants, then cancel every undispatched
   * withdrawal. The protective part commits on its own; the releases follow
   * and the dispatcher retries them. A report is applied once. poker-api's call
   * is the fast path: the sweep applies a report it never reached payments.
   */
  securityLockdown(target: SystemCaller, reason: LockdownReason, report?: LockdownReportInput): Promise<RpcResult<null>>;
  /**
   * The "This wasn't me" link of a payments email: verifies the payments-signed
   * token and answers its claims, changing nothing, for a poker-api that does
   * not hold NOTIFY_LINK_SECRET itself. TOKEN_INVALID for a forged or expired token.
   */
  verifyNotMeToken(token: string): Promise<RpcResult<NotMeTokenClaims>>;

  // Admin (section 11.2). Every mutating call consumes an admin_payments
  // passkey grant bound to adminPaymentsAction({ subject, decision }).
  adminListWithdrawals(admin: AdminCaller, query: PageQuery & { status?: WithdrawalStatus }): Promise<RpcResult<AdminWithdrawalsResponse>>;
  adminGetWithdrawal(admin: AdminCaller, withdrawalId: string): Promise<RpcResult<AdminWithdrawalDetail>>;
  adminDecideWithdrawal(admin: AdminCaller, withdrawalId: string, input: AdminWithdrawalDecision): Promise<RpcResult<AdminWithdrawalDecisionResponse>>;
  adminResolveUncertain(admin: AdminCaller, withdrawalId: string, input: AdminResolveUncertainRequest): Promise<RpcResult<AdminWithdrawalDecisionResponse>>;
  adminListDeposits(admin: AdminCaller, query: PageQuery & { status?: DepositStatus }): Promise<RpcResult<AdminDepositsResponse>>;
  adminResolveDeposit(admin: AdminCaller, depositId: string, input: AdminResolveDepositRequest): Promise<RpcResult<AdminDepositResponse>>;
  adminUserLedger(admin: AdminCaller, userId: string, query: { asset?: string; before?: string; limit?: number }): Promise<RpcResult<AdminUserLedgerResponse>>;
  adminSetRestriction(admin: AdminCaller, userId: string, input: AdminSetRestrictionRequest): Promise<RpcResult<AdminRestrictionResponse>>;
  /** A person's screening decision: a match takes one administrator, CLEAR two (after the last screening change). */
  adminSetScreening(admin: AdminCaller, userId: string, input: AdminSetScreeningRequest): Promise<RpcResult<AdminScreeningResponse>>;
  adminRestoreInstrument(admin: AdminCaller, userId: string, instrumentId: string, input: AdminRestoreInstrumentRequest): Promise<RpcResult<AdminRestoreInstrumentResponse>>;
  adminListReactivations(admin: AdminCaller, query: PageQuery): Promise<RpcResult<AdminReactivationsResponse>>;
  adminAcceptReactivation(admin: AdminCaller, exclusionId: string, input: AdminAcceptReactivationRequest): Promise<RpcResult<AdminAcceptReactivationResponse>>;
  adminListSwitches(admin: AdminCaller): Promise<RpcResult<AdminSwitchesResponse>>;
  adminSetSwitch(admin: AdminCaller, input: AdminSetSwitchRequest): Promise<RpcResult<AdminSetSwitchResponse>>;
  adminListReconciliationRuns(admin: AdminCaller, query: PageQuery): Promise<RpcResult<AdminReconciliationRunsResponse>>;
  adminListReconciliationIssues(admin: AdminCaller, query: PageQuery & { status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" }): Promise<RpcResult<AdminReconciliationIssuesResponse>>;
  adminResolveReconciliationIssue(admin: AdminCaller, issueId: string, input: AdminResolveIssueRequest): Promise<RpcResult<null>>;
  adminListEvents(admin: AdminCaller, query: PageQuery & { outcome?: "DEAD" | "NEEDS_REVIEW" | "UNKNOWN_OBJECT" }): Promise<RpcResult<AdminPaymentEventsResponse>>;
  adminRequeueEvent(admin: AdminCaller, eventId: string, input: AdminRequeueEventRequest): Promise<RpcResult<null>>;
  adminCustodySnapshot(admin: AdminCaller, input: AdminCustodySnapshotRequest): Promise<RpcResult<AdminCustodySnapshotResponse>>;
}

/** The PAYMENTS service binding as poker-api sees it (typed RPC over a service binding). */
export type PaymentsService = Fetcher<PaymentsApi & Rpc.WorkerEntrypointBranded>;

/** poker-api's Env addition (src/env.ts): optional, absent in production until the operator deploys poker-payments. */
export interface PaymentsBindingEnv {
  PAYMENTS?: PaymentsService;
}

/** The binding, or null when this deployment has none (treat as PAYMENTS_MODE=off). */
export function paymentsBinding(env: PaymentsBindingEnv): PaymentsService | null {
  return env.PAYMENTS ?? null;
}
