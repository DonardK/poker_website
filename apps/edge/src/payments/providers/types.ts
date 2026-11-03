/**
 * Provider adapter contract (docs/money/WALLET.md section 9.2, reconciled
 * with the provider specs of design-payments sections 9-12). Three adapter
 * kinds: a card acquirer (Nuvei), a crypto payment provider (BVNK) and an
 * identity-verification provider (Sumsub); the built-in sandbox implements
 * the card and crypto kinds in TEST_EUR. The payments core
 * (src/payments/providers/registry.ts) picks one per kind from the config
 * (src/payments/config.ts) and never sees a provider's wire format.
 *
 * Rules every adapter follows:
 * - It never touches the database or the ledger. It returns facts; the core
 *   decides and books them. Calls happen outside any database transaction.
 * - Provider calls return ProviderResult and do not throw for provider
 *   outcomes: "rejected" is a definite answer (final = it will not change),
 *   "uncertain" means the outcome is unknown (timeout, network, 5xx, an
 *   unparsable answer) and the core must query before it ever retries a
 *   money-moving call, with the SAME idempotency key.
 * - Webhooks are verified on the raw bytes with a constant-time comparison
 *   before anything is parsed or stored. A provider whose signature is weak
 *   or partial (Nuvei's DMN checksum) sets authoritativeWebhooks = false: the
 *   core then re-reads the object with a signed status call and applies the
 *   provider's current state, never the event's claim.
 * - Money crosses this interface as minor units (bigint) of the settlement
 *   asset, and as exact decimal strings for chain amounts and rates. A JS
 *   number never carries an amount (BVNK's JSON numbers are read and written
 *   losslessly by the adapter).
 * - Errors thrown are the classes below: configuration problems at
 *   construction (ProviderConfigError, the provider then stays off), bugs and
 *   unsupported operations (ProviderNotImplementedError).
 */

import type { SettlementAsset } from "@poker/shared";

// ---------------------------------------------------------------------------
// Identity and dependencies
// ---------------------------------------------------------------------------

/** Which implementation (CARD_PROVIDER_KEY / CRYPTO_PROVIDER_KEY / KYC_PROVIDER_KEY). */
export type CardProviderKind = "nuvei" | "sandbox";
export type CryptoProviderKind = "bvnk" | "sandbox";
export type KycProviderKind = "sumsub" | "sandbox";
export type ProviderKind = CardProviderKind | CryptoProviderKind | KycProviderKind;

export const SANDBOX_PROVIDER_KEY = /^sandbox([-_.:]|$)/;

/**
 * The ledger providerKey an adapter books under (LedgerAccount.providerKey,
 * Deposit.providerKey, ...; ^[a-z0-9][a-z0-9_.:-]{0,63}$). The database treats
 * a key matching SANDBOX_PROVIDER_KEY as the sandbox: TEST_EUR only, while
 * every other key never touches TEST_EUR (migration
 * 20261019120000_payments_wallet). So in PAYMENTS_MODE=sandbox every adapter
 * books under a sandbox key: the built-in simulator as "sandbox-card" /
 * "sandbox-crypto" / "sandbox-kyc", a real provider pointed at its own test
 * environment as "sandbox-nuvei" / "sandbox-bvnk" / "sandbox-sumsub"; in
 * live mode a real provider books under its own name ("nuvei", "bvnk",
 * "sumsub") and the simulator is refused by the config.
 */
export function providerLedgerKey(rail: "card" | "crypto" | "kyc", kind: ProviderKind, mode: "sandbox" | "live"): string {
  if (kind === "sandbox") return `sandbox-${rail}`;
  return mode === "sandbox" ? `sandbox-${kind}` : kind;
}

/** Outbound HTTP, egress-aware (PAYMENTS_EGRESS_MODE direct | relay), no redirects followed, with a timeout. */
export type ProviderFetch = (request: Request, options?: { timeoutMs?: number }) => Promise<Response>;

/** Allow-listed structured logging: ids, statuses, codes and amounts only, never a secret, token, PAN or personal data. */
export type ProviderLog = (
  level: "info" | "warn" | "error",
  fields: Record<string, string | number | boolean | null>,
  message: string,
) => void;

/** What the registry hands every adapter factory. */
export interface ProviderDeps {
  fetch: ProviderFetch;
  log: ProviderLog;
  now: () => Date;
  /** Cryptographically random bytes (nonces). */
  randomBytes: (length: number) => Uint8Array;
}

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

export type ProviderResult<T> =
  | { kind: "ok"; value: T }
  /** A definite refusal. final=false: retry later (merchant balance, maintenance); final=true: it will not change. */
  | { kind: "rejected"; final: boolean; code: string; message: string; methodIneligible?: boolean }
  /** Outcome unknown: query before any retry; never release a payout hold on this. */
  | { kind: "uncertain"; reason: "timeout" | "network" | "5xx" | "malformed" };

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}

/** A setting or secret is missing, malformed or unsafe: the adapter is not built and its methods stay off. */
export class ProviderConfigError extends ProviderError {
  constructor(provider: ProviderKind, readonly setting: string, message: string) {
    super(provider, message);
    this.name = "ProviderConfigError";
  }
}

/** The adapter (or one optional operation of it) is not written yet. */
export class ProviderNotImplementedError extends ProviderError {
  constructor(provider: ProviderKind, readonly operation: string) {
    super(provider, `${provider}: ${operation} is not implemented yet`);
    this.name = "ProviderNotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// Normalised objects
// ---------------------------------------------------------------------------

export type PaymentState = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELLED" | "NEEDS_REVIEW";

export type ReviewReason = "UNDERPAID" | "OVERPAID" | "WRONG_ASSET" | "LATE" | "KYT_HOLD" | "UNKNOWN_REFERENCE" | "AMOUNT_MISMATCH";

export interface CardFacts {
  /** The provider's reusable card token (Nuvei userPaymentOptionId): deposits and payouts. */
  token: string;
  fingerprint: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  issuerCountry: string | null;
  funding: "debit" | "credit" | "prepaid" | "unknown";
  payoutEligible: boolean;
  holderName: string | null;
}

export interface CryptoFacts {
  /** Asset.code of what was paid, e.g. "BTC". */
  asset: string;
  network: string;
  /** Chain units as an exact decimal string. */
  amount: string;
  txHash: string | null;
  confirmations: number | null;
  /** Our deposit address that received it. */
  address: string;
  memo: string | null;
  /** Sending addresses, when the provider reports them (ownership proof DEPOSIT_SOURCE). */
  sources: string[];
}

/** A payment (deposit) as the provider reports it now. */
export interface ProviderPayment {
  providerPaymentId: string;
  /** Our Deposit.id when the provider echoes it (card), else null (a crypto channel payment). */
  merchantRef: string | null;
  /** The provider's channel or customer reference, to resolve the user when merchantRef is null. */
  channelRef: string | null;
  state: PaymentState;
  /** The provider's raw status, for logs and admin views only. */
  rawState: string;
  /** Settled amount in the settlement asset (SUCCEEDED), minor units. */
  creditMinor: bigint | null;
  feeMinor: bigint | null;
  card?: CardFacts;
  crypto?: CryptoFacts;
  reviewReason?: ReviewReason;
  occurredAt: Date;
}

export type DisputeKind = "CHARGEBACK" | "PROVIDER_REFUND" | "CHAIN_REORG" | "CHARGEBACK_RECOVERY";

export interface ProviderDispute {
  providerReversalId: string;
  providerPaymentId: string;
  kind: DisputeKind;
  /** Settlement-asset minor units. */
  amountMinor: bigint;
  /** CHARGEBACK_RECOVERY: the reversal it undoes. */
  recoversProviderReversalId?: string;
  /** A retrieval request or an opened case that does not move money yet: record and flag only. */
  informational?: boolean;
  reasonCode?: string;
  occurredAt: Date;
}

export type PayoutState = "ACCEPTED" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "RETURNED";

export interface ProviderPayout {
  providerPayoutId: string | null;
  /** Our idempotency key for it (wd_<id> / rf_<id>). */
  merchantRef: string;
  state: PayoutState;
  /** True when the state cannot change any more (SUCCEEDED, FAILED, RETURNED). */
  final: boolean;
  rawState: string;
  failureCode?: string;
  /** The destination rail cannot take this payout (scheme or BIN not supported, refund filter): route elsewhere. */
  methodIneligible?: boolean;
  /** What arrived, chain units for crypto. */
  payoutAmount?: string;
  rate?: string;
  txHash?: string;
  /** RETURNED: settlement-asset minor units that came back. */
  returnedMinor?: bigint;
  occurredAt: Date;
}

export type KycDecision = "PENDING" | "VERIFIED" | "REJECTED" | "RESUBMISSION_REQUESTED";

/** A verification result (PlayerCompliance.kyc*). */
export interface KycUpdate {
  /** The provider's applicant id (PlayerCompliance.kycApplicantRef). */
  applicantRef: string;
  /** The externalUserId the provider echoes: our opaque customer reference, not a user id. */
  userId: string | null;
  decision: KycDecision;
  level: string | null;
  rejectReason: string | null;
  /** Final rejection (no resubmission). */
  final: boolean;
  /** Identity facts, only on VERIFIED, as the provider verified them. */
  identity?: { firstName: string; lastName: string; birthDate: string; country: string };
  screening?: "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";
  /** When documents expire or a review is due (kycReviewDueAt). */
  reviewDueAt?: Date | null;
  occurredAt: Date;
}

export type PayoutDestination =
  | { kind: "CARD_TOKEN"; token: string; holderName: string }
  | { kind: "CRYPTO_ADDRESS"; asset: string; network: string; address: string; memo: string | null };

/** Travel-rule party (Regulation (EU) 2023/1113), from verified KYC data. */
export interface TravelRuleParty {
  type: "ORIGINATOR" | "BENEFICIARY";
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
  countryCode: string;
  relationship: "SELF_OWNED" | "THIRD_PARTY";
  /** BVNK requires it for Ukraine (countryCode UA). */
  regionCode?: string;
  /** Needed to answer an information request; absent while KYC keeps no postal address (a person answers then). */
  address?: TravelRuleAddress;
}

export interface TravelRuleAddress {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  region?: string;
  postCode: string;
  /** Two letters. */
  country: string;
}

export interface CustomerRef {
  userId: string;
  /** The stable pseudonymous id we give the provider (never the raw user id where avoidable). */
  providerCustomerRef: string;
  email: string | null;
  country: string | null;
  legalName: { first: string; last: string } | null;
  ip: string | null;
}

export interface SettlementLine {
  lineId: string;
  merchantRef: string | null;
  providerRef: string;
  type: "PAYMENT" | "PAYOUT" | "REFUND" | "CHARGEBACK" | "FEE" | "OTHER";
  /** Signed settlement-asset minor units. */
  amountMinor: bigint;
  feeMinor: bigint;
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** The exact bytes received (signatures are over these). */
  rawBody: Uint8Array;
  receivedAt: Date;
  sourceIp: string | null;
}

interface EventEnvelope {
  /** The provider's event id, or "d_" + sha256(provider|objectRef|state|occurredAt) when it has none. */
  providerEventId: string;
  eventType: string;
  /** PaymentEvent.objectType. */
  objectType: "PAYMENT" | "PAYOUT" | "REFUND" | "DISPUTE" | "KYC";
  objectRef: string | null;
  merchantRef: string | null;
  /** The redacted payload stored in PaymentEvent.payload (ids, statuses, amounts, last4/brand only). */
  payload: Record<string, unknown>;
}

export type NormalizedEvent = EventEnvelope & (
  | { payment: ProviderPayment }
  | { dispute: ProviderDispute }
  | { payout: ProviderPayout }
  | { kyc: KycUpdate }
  /** A travel-rule request for information about a payment (BVNK): the core answers it from KYC data. */
  | { informationRequest: { externalId: string; providerPaymentId: string | null } }
);

export type WebhookVerification =
  | { ok: true; scheme: string; events: NormalizedEvent[] }
  | { ok: false; reason: "signature" | "timestamp" | "format" | "unsupported_scheme" };

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

interface ProviderBase {
  readonly kind: ProviderKind;
  /** The ledger providerKey (providerLedgerKey). */
  readonly key: string;
  /** The key is a sandbox key: books only TEST_EUR (the database enforces it either way). */
  readonly sandbox: boolean;
  /** false: an event is a hint, re-read the object before applying it. */
  readonly authoritativeWebhooks: boolean;
  verifyWebhook(request: WebhookRequest): Promise<WebhookVerification>;
  /** Keep only ids, statuses, amounts and card brand/last4 of a provider payload. */
  redact(payload: unknown): Record<string, unknown>;
}

interface MoneyProviderBase extends ProviderBase {
  /** The ledger asset it settles in: TEST_EUR for the sandbox, EUR for a real provider. */
  readonly settlementAsset: SettlementAsset;
  /**
   * The only hosts a player may be sent to for this provider (exact, or
   * ".suffix" for any subdomain). A provider URL on any other host never
   * reaches the browser, even when it came from the provider's own answer.
   */
  readonly redirectHosts: readonly string[];
  /**
   * The provider deduplicates on our idempotency key (long enough to cover
   * our retries), so after two NOT_FOUND answers a payout may be re-created
   * with the same key. false: an uncertain payout goes to MANUAL instead.
   */
  readonly dedupesOnOurKey: boolean;
  getPayment(ref: { providerPaymentId?: string; merchantRef?: string }): Promise<ProviderResult<ProviderPayment | null>>;
  quotePayout(input: { amountMinor: bigint; destination: PayoutDestination }): Promise<ProviderResult<PayoutQuote>>;
  /** Sends money. Same idempotencyKey for the life of the withdrawal (PayoutDispatch). */
  createPayout(input: PayoutInput): Promise<ProviderResult<ProviderPayout>>;
  /** null: the provider has no payout for this key (NOT_FOUND). */
  getPayout(ref: { idempotencyKey: string; providerPayoutId?: string | null }): Promise<ProviderResult<ProviderPayout | null>>;
  listSettlement?(day: string, cursor?: string): Promise<ProviderResult<{ lines: SettlementLine[]; next?: string }>>;
}

export interface PayoutQuote {
  feeMinor: bigint;
  receiveEstimate: string | null;
  rate: string | null;
  expiresAt: Date;
}

export interface PayoutInput {
  withdrawalId: string;
  idempotencyKey: string;
  /** REFUND returns a card deposit (refundOf); PAYOUT pushes to a card token or sends to an address. */
  operation: "PAYOUT" | "REFUND";
  amountMinor: bigint;
  feeMinor: bigint;
  destination: PayoutDestination;
  refundOf?: { providerPaymentId: string };
  customer: CustomerRef;
  beneficiary: TravelRuleParty;
}

export interface CardDepositSessionInput {
  depositId: string;
  /** dep_<depositId>. */
  idempotencyKey: string;
  amountMinor: bigint;
  /** A saved card to pre-select (PaymentInstrument.cardToken), if any. */
  instrumentToken?: string;
  saveCard: boolean;
  customer: CustomerRef;
  /** Our return page; the redirect never confirms anything (the webhook plus a status read does). */
  returnUrl: string;
  notificationUrl: string;
  expiresAt: Date;
}

export interface CardDepositSession {
  type: "REDIRECT";
  providerPaymentId: string | null;
  url: string;
  expiresAt: Date;
}

export interface CryptoDepositSessionInput {
  depositId: string;
  idempotencyKey: string;
  amountMinor: bigint;
  /** Asset.code to pay with, e.g. "USDC_ERC20" (CRYPTO_PAY_ASSETS). */
  payAsset: string;
  customer: CustomerRef;
  originator: TravelRuleParty;
  expiresAt: Date;
}

export interface CryptoDepositSession {
  type: "CRYPTO_INVOICE";
  /** The provider's payment or channel id. */
  providerPaymentId: string;
  /** A per-user channel address is reused across deposits (BVNK); an invoice address is not. */
  reusableAddress: boolean;
  asset: string;
  network: string;
  address: string;
  memo: string | null;
  payAmount: string | null;
  expiresAt: Date | null;
  minConfirmations: number;
  /** The provider's hosted top-up page, if it offers one. */
  hostedUrl: string | null;
}

export interface CardProvider extends MoneyProviderBase {
  readonly method: "CARD";
  readonly kind: CardProviderKind;
  createDepositSession(input: CardDepositSessionInput): Promise<ProviderResult<CardDepositSession>>;
}

export interface CryptoProvider extends MoneyProviderBase {
  readonly method: "CRYPTO";
  readonly kind: CryptoProviderKind;
  createDepositSession(input: CryptoDepositSessionInput): Promise<ProviderResult<CryptoDepositSession>>;
  /** Provider-side address validation (in addition to our checksum checks). */
  validateAddress?(input: { asset: string; network: string; address: string; memo: string | null }): Promise<ProviderResult<{ valid: boolean; code?: string }>>;
  /** KYT risk of a payout address. SEVERE refuses it (ADDRESS_BLOCKED). */
  screenAddress?(input: { asset: string; network: string; address: string }): Promise<ProviderResult<{ risk: "LOW" | "MEDIUM" | "HIGH" | "SEVERE" }>>;
  /** Answer a travel-rule information request. */
  answerInformationRequest?(externalId: string, party: TravelRuleParty): Promise<ProviderResult<null>>;
}

export interface KycSessionInput {
  userId: string;
  /** The id the provider stores for the applicant (externalUserId). */
  externalUserId: string;
  email: string | null;
  country: string | null;
  /** The verification level / flow name. */
  level: string;
  ttlSeconds: number;
}

export interface KycSession {
  sdkToken: string;
  applicantRef: string | null;
  expiresAt: Date;
}

export interface KycProvider extends ProviderBase {
  readonly method: "KYC";
  readonly kind: KycProviderKind;
  createSession(input: KycSessionInput): Promise<ProviderResult<KycSession>>;
  getApplicant(ref: { applicantRef?: string; externalUserId?: string }): Promise<ProviderResult<KycUpdate | null>>;
}

export type PaymentProvider = CardProvider | CryptoProvider | KycProvider;

// ---------------------------------------------------------------------------
// Configuration per provider (src/payments/config.ts reads and validates it)
// ---------------------------------------------------------------------------

/** Nuvei (design-payments section 10). Secrets: NUVEI_SECRET_KEY (+ _PREVIOUS while rotating). */
export interface NuveiConfig {
  /** NUVEI_ENV: "int" (ppp-test hosts) or "prod". */
  env: "int" | "prod";
  merchantId: string;
  merchantSiteId: string;
  secretKey: string;
  secretKeyPrevious: string | null;
  /** Only the hosted Payment Page (PCI SAQ-A, full-page redirect). */
  depositUi: "payment_page";
  /** NUVEI_IDEMPOTENCY_CONFIRMED: Nuvei enabled clientRequestId dedupe for this merchant (dedupesOnOurKey). */
  idempotencyConfirmed: boolean;
  /** Where DMNs are sent (the poker-payments webhook URL for "nuvei"). */
  notifyUrl: string;
  /** The player return page base (PUBLIC_SITE_ORIGIN). */
  returnUrlBase: string;
}

/** BVNK (design-payments section 11). Secrets: BVNK_HAWK_AUTH_ID, BVNK_HAWK_AUTH_KEY, BVNK_WEBHOOK_SECRET (+ _PREVIOUS). */
export interface BvnkConfig {
  /** BVNK_ENV: api.sandbox.bvnk.com or api.bvnk.com. */
  env: "sandbox" | "production";
  walletIdEur: string;
  /** BVNK_ASSET_MAP: our Asset.code -> BVNK payCurrency and network (filled from BVNK's currencies endpoint). */
  assetMap: Record<string, { payCurrency: string; network: string }>;
  /** Only the raw-body base64 HMAC-SHA256 x-signature scheme; the legacy scheme is refused. */
  webhookScheme: "v2_base64";
  hawkAuthId: string;
  hawkAuthKey: string;
  webhookSecret: string;
  webhookSecretPrevious: string | null;
  /** Payouts need allow-listed egress IPs (PAYMENTS_EGRESS_MODE). */
  egress: { mode: "direct" } | { mode: "relay"; relayUrl: string };
}

/**
 * Sumsub. Secrets: SUMSUB_APP_TOKEN, SUMSUB_SECRET_KEY, SUMSUB_WEBHOOK_SECRET.
 * The request signing and webhook digest details are to be verified against
 * Sumsub's official documentation by the adapter author (INTEGRATION.md
 * override 15); this shape only names the settings.
 */
export interface SumsubConfig {
  /** PAYMENTS_MODE: decides the ledger key and which environment's webhooks are accepted. */
  mode: "sandbox" | "live";
  baseUrl: string;
  appToken: string;
  secretKey: string;
  webhookSecret: string;
  /** The verification level / flow name configured in the Sumsub dashboard. */
  levelName: string;
  /** SDK access-token lifetime. */
  tokenTtlSeconds: number;
  /**
   * SUMSUB_SCREENING_INCLUDED: this level includes AML and sanctions screening,
   * so a passed review also means screened clear. Default false: nothing then
   * sets CLEAR by itself, and withdrawals stay refused.
   */
  screeningIncluded: boolean;
}

/** Built-in sandbox (design-payments section 12). Secret: SANDBOX_WEBHOOK_SECRET. Never in production. */
export interface SandboxConfig {
  webhookSecret: string;
  /** SANDBOX_CONTROLS_ENABLED: the test-control endpoints (CI and development only). */
  controlsEnabled: boolean;
}

/** Factory signatures the registry calls (one per adapter module). */
export type CardProviderFactory<C> = (config: C, deps: ProviderDeps) => CardProvider;
export type CryptoProviderFactory<C> = (config: C, deps: ProviderDeps) => CryptoProvider;
export type KycProviderFactory<C> = (config: C, deps: ProviderDeps) => KycProvider;
