import type {
  AddCryptoDestinationRequest, CreateDepositRequest, CreateDepositResponse, CreateWithdrawalRequest, DepositLimitsResponse,
  DepositResponse, InstrumentResponse, InstrumentsResponse, KycSessionResponse, PrepareCryptoDestinationRequest,
  PrepareCryptoDestinationResponse, SelfExclusionStatus, SetDepositLimitRequest, WalletSummary, WalletTransactionsResponse, WithdrawalQuoteRequest,
  WalletNotMeResponse, WithdrawalQuoteResponse, WithdrawalResponse, WithdrawalsResponse,
} from "@poker/shared";
import { api, ApiError, authedApi } from "@/lib/api";

/**
 * Typed wrappers for the wallet routes (apps/edge/src/http/wallet.ts; the
 * bodies are packages/shared/src/wallet.ts, docs/money/WALLET.md section 11).
 * Every route is Bearer-authenticated and answers `no-store`. Money is a
 * decimal string end to end (lib/money.ts). Errors are
 * `{ error, code, retryable?, details? }`, surfaced as ApiError; a step-up is
 * 403 STEP_UP_REQUIRED { purpose, bind, methods } (never 401), and a route
 * that spends a grant may answer 403 EMAIL_NOT_VERIFIED or
 * SECURITY_HOLD { until } first.
 *
 * POST routes that create a money object send `Idempotency-Key: <uuid v4>`:
 * the caller keeps one key per submission and reuses it when the same
 * submission is retried, so a lost response never pays twice.
 */

const post = (body: unknown, idempotencyKey?: string): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
});

const id = (value: string) => encodeURIComponent(value);

// ---------------------------------------------------------------------------
// Types the shared contract does not define (yet)
// ---------------------------------------------------------------------------

/**
 * 200 from POST /api/wallet/kyc/session: a Sumsub WebSDK token, or (the
 * built-in sandbox) `url`, a hosted page to open instead. A null `url` is
 * treated as absent.
 */
export type KycStart = Omit<KycSessionResponse, "url"> & { url?: string | null };

/** The GET /api/wallet answer when the route does not exist (an older API): treated as mode "off". */
function offSummary(chips: number): WalletSummary {
  return { mode: "off", realMoney: null, play: { chips, redeemable: false } };
}

// ---------------------------------------------------------------------------
// Summary and history
// ---------------------------------------------------------------------------

/**
 * GET /api/wallet. Fails closed: a 404 (no wallet route on this API) and any
 * mode other than sandbox or live are "off", so money forms never render
 * against an API that did not say it takes money.
 */
export async function fetchWalletSummary(fallbackChips: number): Promise<WalletSummary> {
  try {
    const summary = await authedApi<WalletSummary>("/api/wallet", { method: "GET" });
    if (summary.mode !== "sandbox" && summary.mode !== "live") return offSummary(summary.play?.chips ?? fallbackChips);
    return summary;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return offSummary(fallbackChips);
    throw err;
  }
}

export function fetchTransactions(opts: { cursor?: string | null; limit?: number } = {}): Promise<WalletTransactionsResponse> {
  const query = new URLSearchParams();
  if (opts.cursor) query.set("cursor", opts.cursor);
  if (opts.limit) query.set("limit", String(opts.limit));
  const suffix = query.toString() ? `?${query}` : "";
  return authedApi<WalletTransactionsResponse>(`/api/wallet/transactions${suffix}`, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

export function createDeposit(body: CreateDepositRequest, idempotencyKey: string): Promise<CreateDepositResponse> {
  return authedApi<CreateDepositResponse>("/api/wallet/deposits", post(body, idempotencyKey));
}

export function fetchDeposit(depositId: string): Promise<DepositResponse> {
  return authedApi<DepositResponse>(`/api/wallet/deposits/${id(depositId)}`, { method: "GET" });
}

export function cancelDeposit(depositId: string): Promise<DepositResponse> {
  return authedApi<DepositResponse>(`/api/wallet/deposits/${id(depositId)}/cancel`, post({}));
}

// ---------------------------------------------------------------------------
// Payout destinations (cards from deposits, crypto addresses)
// ---------------------------------------------------------------------------

export function fetchInstruments(): Promise<InstrumentsResponse> {
  return authedApi<InstrumentsResponse>("/api/wallet/instruments", { method: "GET" });
}

/** Normalises and checks the address; the answer's `bind` is what the payout_destination step-up authorises. */
export function prepareCryptoDestination(body: PrepareCryptoDestinationRequest): Promise<PrepareCryptoDestinationResponse> {
  return authedApi<PrepareCryptoDestinationResponse>("/api/wallet/instruments/crypto/prepare", post(body));
}

export function addCryptoDestination(body: AddCryptoDestinationRequest, idempotencyKey: string): Promise<InstrumentResponse> {
  return authedApi<InstrumentResponse>("/api/wallet/instruments/crypto", post(body, idempotencyKey));
}

export function revokeInstrument(instrumentId: string): Promise<void> {
  return authedApi<void>(`/api/wallet/instruments/${id(instrumentId)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

/** The quote's `stepUp` names the withdrawal step-up (purpose and bind) that POST /api/wallet/withdrawals will consume. */
export function quoteWithdrawal(body: WithdrawalQuoteRequest): Promise<WithdrawalQuoteResponse> {
  return authedApi<WithdrawalQuoteResponse>("/api/wallet/withdrawals/quote", post(body));
}

export function createWithdrawal(body: CreateWithdrawalRequest, idempotencyKey: string): Promise<WithdrawalResponse> {
  return authedApi<WithdrawalResponse>("/api/wallet/withdrawals", post(body, idempotencyKey));
}

export function fetchWithdrawals(cursor?: string | null): Promise<WithdrawalsResponse> {
  const suffix = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  return authedApi<WithdrawalsResponse>(`/api/wallet/withdrawals${suffix}`, { method: "GET" });
}

export function cancelWithdrawal(withdrawalId: string): Promise<WithdrawalResponse> {
  return authedApi<WithdrawalResponse>(`/api/wallet/withdrawals/${id(withdrawalId)}/cancel`, post({}));
}

// ---------------------------------------------------------------------------
// Responsible gaming and verification
// ---------------------------------------------------------------------------

export function fetchDepositLimits(): Promise<DepositLimitsResponse> {
  return authedApi<DepositLimitsResponse>("/api/wallet/limits", { method: "GET" });
}

/** POST (design-wallet section 11.1 says PUT; the API takes POST, as CORS allows no PUT or PATCH). */
export function setDepositLimit(body: SetDepositLimitRequest): Promise<DepositLimitsResponse> {
  return authedApi<DepositLimitsResponse>("/api/wallet/limits", post(body));
}

export function fetchSelfExclusion(): Promise<SelfExclusionStatus> {
  return authedApi<SelfExclusionStatus>("/api/account/self-exclusion", { method: "GET" });
}

/** Asks to come back: a timed break that ended reopens 24 hours later, an indefinite one waits for our team first. */
export function requestSelfExclusionReturn(): Promise<SelfExclusionStatus> {
  return authedApi<SelfExclusionStatus>("/api/account/self-exclusion/reactivation", post({}));
}

/**
 * "This wasn't me" from a payments email (no session needed): withdrawals
 * become manual, the destination the email named and every one added in the
 * last 72 hours go, undispatched withdrawals are cancelled and every session
 * ends. 400 TOKEN_INVALID for a forged or expired token; a used one answers
 * secured again.
 */
export function reportWalletNotMe(token: string): Promise<WalletNotMeResponse> {
  return api<WalletNotMeResponse>("/api/wallet/not-me", post({ token }));
}

export function startKyc(): Promise<KycStart> {
  return authedApi<KycStart>("/api/wallet/kyc/session", post({}));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh Idempotency-Key (UUID v4). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * SECURITY: where a provider sends the browser to pay or verify. Only https
 * (http too while this page itself is plain http, i.e. local development and
 * the browser tests), never javascript:, data: or a relative path the API did
 * not mean. Null when the URL is not acceptable.
 */
export function safeProviderUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && typeof window !== "undefined" && window.location.protocol === "http:") return url.href;
    return null;
  } catch {
    return null;
  }
}

export { cleanObjectId, depositReturnPath, LAST_DEPOSIT_KEY } from "@/lib/wallet-ids";
