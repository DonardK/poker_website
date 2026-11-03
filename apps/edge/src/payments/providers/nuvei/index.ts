/**
 * Nuvei card adapter (design-payments section 10; facts verified against
 * Nuvei's docs on 2026-10-29, see README.md in this directory).
 *
 * - Deposits: the hosted Payment Page (full-page redirect, PCI SAQ-A). The
 *   URL is built and signed locally (no API call); our deposit id travels as
 *   merchant_unique_id and the player's pseudonymous ref as user_token_id.
 *   "The browser redirect must not be used to confirm payment results."
 * - Confirmation: a DMN is only a hint (authoritativeWebhooks = false). Its
 *   checksum covers totalAmount, currency, responseTimeStamp,
 *   PPP_TransactionID, Status and productId only, so every other field
 *   (TransactionID, merchant_unique_id, user_token_id, the card) is
 *   unauthenticated. getPayment re-reads the transaction with a signed
 *   /getTransactionDetails call and returns Nuvei's own clientUniqueId and
 *   userTokenId: the core must match the deposit and the player on those,
 *   never on the event's.
 * - Payouts: /payout to the deposit card's userPaymentOptionId (OCT);
 *   refunds: /refundTransaction against the sale. clientRequestId and
 *   clientUniqueId are both our idempotency key (wd_<id> / rf_<id>);
 *   Nuvei refuses a repeated clientRequestId only when that is enabled for
 *   the merchant (NUVEI_IDEMPOTENCY_CONFIRMED -> dedupesOnOurKey).
 * - Chargebacks: Control Panel event DMNs (JSON, `checksum` header) become
 *   disputes. Chargeback, void and outside-refund payment DMNs link to the
 *   sale through unsigned fields, so they are informational (record and
 *   flag) until staff or a Control Panel event confirms them.
 * - Wire currency is EUR in both environments; the ledger books TEST_EUR in
 *   sandbox mode (NUVEI_ENV=int) and EUR in live mode (prod).
 */
import { z } from "zod";
import type { SettlementAsset } from "@poker/shared";
import { formatMinor } from "../../../money/amounts";
import {
  ProviderConfigError,
  providerLedgerKey,
  type CardDepositSession,
  type CardDepositSessionInput,
  type CardFacts,
  type CardProvider,
  type NormalizedEvent,
  type NuveiConfig,
  type PaymentState,
  type PayoutInput,
  type PayoutQuote,
  type ProviderDeps,
  type ProviderDispute,
  type ProviderPayment,
  type ProviderPayout,
  type ProviderResult,
  type ReviewReason,
  type WebhookRequest,
  type WebhookVerification,
} from "../types";
import {
  clip,
  decimalToMinor,
  decodeUtf8,
  equalBytes,
  hexToBytes,
  JsonNumber,
  last4Of,
  parseJsonLossless,
  redactWith,
  send,
  sha256HexOf,
} from "../wire";
import {
  DMN_FIELD_FORMAT,
  dmnChecksum,
  eventChecksumRaw,
  pageChecksum,
  pageTimestamp,
  parsePageTimestamp,
  restChecksum,
  restTimestamp,
} from "./checksum";

/** Base URLs (API reference; Payment Page quick start). */
export const NUVEI_URLS = {
  int: { rest: "https://ppp-test.nuvei.com/ppp/api/v1/", page: "https://ppp-test.safecharge.com/ppp/purchase.do" },
  prod: { rest: "https://secure.safecharge.com/ppp/api/v1/", page: "https://secure.safecharge.com/ppp/purchase.do" },
} as const;

const WIRE_CURRENCY = "EUR";
const EUR_DECIMALS = 2;
const PAYMENT_PAGE_VERSION = "4.0.0";
const QUOTE_TTL_MS = 10 * 60_000;
/** A payment DMN signed longer ago than this is refused (Nuvei retries for hours, not days). */
const DMN_MAX_AGE_MS = 7 * 86_400_000;
/** /payout clientUniqueId String(45); refundTransaction allows 64, the stricter limit is used. */
const CLIENT_UNIQUE_ID_MAX = 45;

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const num = z.instanceof(JsonNumber);
/** Nuvei mixes strings and numbers for ids and codes; both become text (never a lossy JS number). */
const idLike = z.union([z.string().max(64), num]).transform((value) => (typeof value === "string" ? value : value.text));
const textOf = (max: number) => z.string().max(max);
const flagLike = z.union([z.string().max(8), num, z.boolean()]).transform((value) =>
  value === true || (typeof value === "string" && /^(1|true|yes|y)$/i.test(value)) || (value instanceof JsonNumber && value.text === "1"));

const baseAnswer = {
  status: textOf(20),
  errCode: idLike.nullish(),
  reason: textOf(400).nullish(),
  merchantId: idLike.nullish(),
  merchantSiteId: idLike.nullish(),
};

const transactionDetailsSchema = z.object({
  ...baseAnswer,
  userDetails: z.object({ userTokenId: textOf(255).nullish() }).nullish(),
  transactionDetails: z.object({
    date: textOf(40).nullish(),
    transactionStatus: textOf(20).nullish(),
    transactionType: textOf(45).nullish(),
    clientUniqueId: textOf(64).nullish(),
    transactionId: idLike.nullish(),
    relatedTransactionId: idLike.nullish(),
    isVoided: flagLike.nullish(),
    gwErrorCode: idLike.nullish(),
    gwErrorReason: textOf(400).nullish(),
  }).nullish(),
  paymentOption: z.object({
    userPaymentOptionId: idLike.nullish(),
    card: z.object({
      ccCardNumber: textOf(20).nullish(),
      cardHolderName: textOf(70).nullish(),
      ccExpMonth: idLike.nullish(),
      ccExpYear: idLike.nullish(),
      issuingCountry: textOf(20).nullish(),
      issuerCountry: textOf(20).nullish(),
      isPrepaid: flagLike.nullish(),
      cardType: textOf(20).nullish(),
      cardBrand: textOf(40).nullish(),
    }).nullish(),
  }).nullish(),
  partialApproval: z.object({
    requestedAmount: z.union([textOf(20), num]).nullish(),
    requestedCurrency: textOf(3).nullish(),
    processedAmount: z.union([textOf(20), num]).nullish(),
    processedCurrency: textOf(3).nullish(),
  }).nullish(),
});
type TransactionDetails = z.infer<typeof transactionDetailsSchema>;

const payoutAnswerSchema = z.object({
  ...baseAnswer,
  transactionStatus: textOf(20).nullish(),
  transactionId: idLike.nullish(),
  clientUniqueId: textOf(64).nullish(),
  clientRequestId: textOf(255).nullish(),
  amount: z.union([textOf(20), num]).nullish(),
  currency: textOf(3).nullish(),
  gwErrorCode: idLike.nullish(),
  gwErrorReason: textOf(400).nullish(),
});
type PayoutAnswer = z.infer<typeof payoutAnswerSchema>;

/** /getUserUPOs: only what identifies a saved card. */
const userUposSchema = z.object({
  ...baseAnswer,
  paymentMethods: z.array(z.object({
    userPaymentOptionId: idLike.nullish(),
    upoData: z.object({ uniqueCC: textOf(64).nullish() }).nullish(),
  })).max(500).nullish(),
});
/** Documented as String(28); the alphabet is not, so anything plain is taken. */
const UNIQUE_CC = /^[A-Za-z0-9+/=_-]{8,64}$/;

const eventSchema = z.object({
  EventType: textOf(64),
  EventId: idLike.nullish(),
  EventDateUTC: textOf(40).nullish(),
  EventDate: textOf(40).nullish(),
  Chargeback: z.object({
    Type: textOf(40).nullish(),
    Status: textOf(200).nullish(),
    ChargebackStatusCategory: textOf(40).nullish(),
    Amount: z.union([textOf(20), num]).nullish(),
    Currency: textOf(3).nullish(),
    ChargebackReason: textOf(200).nullish(),
    DisputeId: idLike.nullish(),
    Date: textOf(40).nullish(),
  }).nullish(),
  TransactionDetails: z.object({
    TransactionId: idLike.nullish(),
    ClientUniqueId: textOf(64).nullish(),
  }).nullish(),
});

/** Kept in PaymentEvent.payload: ids, statuses, amounts, brand; never names, emails, IPs, full masks or BINs. */
const REDACT_KEYS: ReadonlySet<string> = new Set([
  // Payment DMN
  "ppp_status", "Status", "PPP_TransactionID", "ppp_TransactionID", "PPP_TransactionId", "TransactionID", "totalAmount", "currency",
  "responseTimeStamp", "transactionType", "type", "merchant_unique_id", "clientUniqueId", "clientRequestId", "relatedTransactionId",
  "ErrCode", "ExErrCode", "ReasonCode", "Reason", "message", "userPaymentOptionId", "cardCompany", "isPartialApproval",
  "requestedAmount", "requestedCurrency", "productId", "last4",
  // REST answers
  "status", "transactionStatus", "transactionId", "errCode", "reason", "gwErrorCode", "gwErrorReason", "amount",
  "transactionDetails", "partialApproval", "processedAmount", "processedCurrency", "isVoided", "date",
  // Control Panel events
  "EventType", "EventId", "EventDate", "EventDateUTC", "Chargeback", "TransactionDetails", "Type", "ChargebackStatusCategory",
  "Amount", "Currency", "ReportedAmount", "ReportedCurrency", "ChargebackReason", "DisputeId", "DisputeDueDate", "TransactionId",
  "ClientUniqueId", "Date",
]);

/** Decline texts that mean "this card or rail cannot take the money" (UNVERIFIED: confirm the codes in the sandbox). */
const INELIGIBLE_TEXT = /not\s+supported|not\s+allowed|not\s+permitted|ineligible|restricted|card\s+type|bin\s+(?:is\s+)?blocked|filter\s+error/i;
/** Credit filters 1106 (above the sale), 1124 (7-day sales), 1126 (per-transaction cap): route elsewhere. */
const INELIGIBLE_CODES = new Set(["1106", "1124", "1126"]);
/** An ERROR answer to a lookup that means "no such transaction" (UNVERIFIED wording). */
const NOT_FOUND_TEXT = /not\s*found|no\s+(?:such\s+)?(?:transaction|payout|record)s?|does\s+not\s+exist|invalid\s+(?:transaction|client\s*request)\s*id/i;

const eventKeySafe = (value: string) => value.replace(/[^A-Za-z0-9._:-]/g, "_");

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createNuveiAdapter(config: NuveiConfig, deps: ProviderDeps): CardProvider {
  if (config.depositUi !== "payment_page") throw new ProviderConfigError("nuvei", "NUVEI_DEPOSIT_UI", "only the hosted Payment Page is supported");
  if (!/^[0-9]{1,32}$/.test(config.merchantId) || !/^[0-9]{1,32}$/.test(config.merchantSiteId)) {
    throw new ProviderConfigError("nuvei", "NUVEI_MERCHANT_ID", "merchant and site ids must be numeric");
  }
  if (!/^https:\/\//.test(config.notifyUrl)) throw new ProviderConfigError("nuvei", "PAYMENTS_PUBLIC_ORIGIN", "the DMN notify URL must be https");
  const mode = config.env === "prod" ? "live" : "sandbox";
  const key = providerLedgerKey("card", "nuvei", mode);
  const settlementAsset: SettlementAsset = mode === "live" ? "EUR" : "TEST_EUR";
  const urls = NUVEI_URLS[config.env];
  const secrets = [config.secretKey, config.secretKeyPrevious].filter((s): s is string => !!s);
  const log = (level: "info" | "warn" | "error", fields: Record<string, string | number | boolean | null>, message: string) =>
    deps.log(level, { provider: key, ...fields }, message);

  type Answer = { kind: "ok"; body: unknown } | { kind: "uncertain"; reason: "timeout" | "network" | "5xx" | "malformed" };

  /** One signed REST call. Nuvei answers 200 with status SUCCESS | ERROR; anything else is uncertain. */
  async function call(method: string, body: Record<string, unknown>, checksumValues: (string | undefined)[]): Promise<Answer> {
    const signedBody = { ...body, checksum: await restChecksum(checksumValues, config.secretKey) };
    const result = await send(deps.fetch, {
      method: "POST",
      url: `${urls.rest}${method}.do`,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(signedBody),
    });
    if (result.kind === "failed") {
      log("warn", { method, reason: result.reason }, "nuvei call failed");
      return { kind: "uncertain", reason: result.reason };
    }
    if (result.status >= 500) return { kind: "uncertain", reason: "5xx" };
    if (result.status !== 200 || result.text === null) {
      log("warn", { method, status: result.status }, "nuvei unexpected HTTP answer");
      return { kind: "uncertain", reason: "malformed" };
    }
    try {
      return { kind: "ok", body: parseJsonLossless(result.text) };
    } catch {
      return { kind: "uncertain", reason: "malformed" };
    }
  }

  const ours = (answer: { merchantId?: string | null; merchantSiteId?: string | null }) =>
    (answer.merchantId == null || answer.merchantId === config.merchantId) && (answer.merchantSiteId == null || answer.merchantSiteId === config.merchantSiteId);

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async function transactionDetails(by: { transactionId: string } | { clientUniqueId: string }): Promise<ProviderResult<TransactionDetails | null>> {
    const timeStamp = restTimestamp(deps.now());
    const transactionId = "transactionId" in by ? by.transactionId : undefined;
    const clientUniqueId = "clientUniqueId" in by ? by.clientUniqueId : undefined;
    const answer = await call(
      "getTransactionDetails",
      { merchantId: config.merchantId, merchantSiteId: config.merchantSiteId, transactionId, clientUniqueId, timeStamp },
      [config.merchantId, config.merchantSiteId, transactionId, clientUniqueId, timeStamp],
    );
    if (answer.kind !== "ok") return answer;
    const parsed = transactionDetailsSchema.safeParse(answer.body);
    if (!parsed.success || !ours(parsed.data)) return { kind: "uncertain", reason: "malformed" };
    if (parsed.data.status.toUpperCase() !== "SUCCESS") {
      if (NOT_FOUND_TEXT.test(parsed.data.reason ?? "")) return { kind: "ok", value: null };
      log("warn", { method: "getTransactionDetails", errCode: parsed.data.errCode ?? null }, "nuvei lookup refused");
      return { kind: "uncertain", reason: "malformed" };
    }
    if (!parsed.data.transactionDetails) return { kind: "ok", value: null };
    return { kind: "ok", value: parsed.data };
  }

  /**
   * The card's uniqueCC from a signed /getUserUPOs call: getTransactionDetails
   * does not return it, and the DMN's copy is unsigned. It lets the core see
   * one physical card on two accounts (DESTINATION_SHARED). Best effort: a
   * failed read leaves it null and the deposit goes on.
   */
  async function uniqueCcOf(userTokenId: string, userPaymentOptionId: string): Promise<string | null> {
    const clientRequestId = crypto.randomUUID();
    const timeStamp = restTimestamp(deps.now());
    const answer = await call(
      "getUserUPOs",
      { merchantId: config.merchantId, merchantSiteId: config.merchantSiteId, userTokenId, clientRequestId, timeStamp },
      [config.merchantId, config.merchantSiteId, userTokenId, clientRequestId, timeStamp],
    );
    if (answer.kind !== "ok") return null;
    const parsed = userUposSchema.safeParse(answer.body);
    if (!parsed.success || !ours(parsed.data) || parsed.data.status.toUpperCase() !== "SUCCESS") return null;
    const unique = parsed.data.paymentMethods?.find((method) => method.userPaymentOptionId === userPaymentOptionId)?.upoData?.uniqueCC;
    return unique && UNIQUE_CC.test(unique) ? unique : null;
  }

  function cardFromDetails(d: TransactionDetails): CardFacts | undefined {
    const token = d.paymentOption?.userPaymentOptionId;
    if (!token) return undefined;
    const card = d.paymentOption?.card;
    return {
      token,
      fingerprint: null,
      brand: card?.cardBrand ?? null,
      last4: last4Of(card?.ccCardNumber),
      expMonth: month(card?.ccExpMonth),
      expYear: year(card?.ccExpYear),
      issuerCountry: country(card?.issuingCountry ?? card?.issuerCountry),
      funding: card?.isPrepaid ? "prepaid" : funding(card?.cardType),
      payoutEligible: !card?.isPrepaid,
      holderName: card?.cardHolderName ?? null,
    };
  }

  /** The authoritative deposit view (getTransactionDetails). */
  function paymentFromDetails(d: TransactionDetails): ProviderPayment | null {
    const t = d.transactionDetails;
    if (!t?.transactionId) return null;
    const type = (t.transactionType ?? "").toLowerCase();
    const status = (t.transactionStatus ?? "").toUpperCase();
    let state: PaymentState;
    let reviewReason: ReviewReason | undefined;
    if (type === "void" || t.isVoided) {
      state = "CANCELLED";
      log("error", { transactionId: t.transactionId, alert: "NUVEI_VOIDED_SALE" }, "deposit transaction is voided; any credit needs a staff reversal");
    } else if (type !== "sale" && type !== "sale3d") {
      // An auth is not money; the site must run in sale mode.
      state = "NEEDS_REVIEW";
      reviewReason = "AMOUNT_MISMATCH";
      log("error", { transactionId: t.transactionId, transactionType: type || null, alert: "NUVEI_NOT_A_SALE" }, "deposit transaction is not a sale");
    } else if (status === "APPROVED") state = "SUCCEEDED";
    else if (status === "DECLINED" || status === "ERROR") state = "FAILED";
    else state = "PROCESSING";

    let creditMinor: bigint | null = null;
    if (state === "SUCCEEDED") {
      // getTransactionDetails documents no transaction amount: the requested
      // amount of partialApproval (example "100.0000") and, when present, the
      // processed amount. Neither is guaranteed (UNVERIFIED); without one the
      // deposit goes to review instead of crediting an unread amount. The
      // checksum-verified DMN totalAmount is in the event for the core to
      // compare with.
      const pa = d.partialApproval;
      const amount = pa?.processedAmount ?? pa?.requestedAmount;
      const currency = (pa?.processedAmount ? pa?.processedCurrency : pa?.requestedCurrency) ?? null;
      const requested = pa?.requestedAmount ? decimalToMinor(pa.requestedAmount, EUR_DECIMALS) : null;
      const parsed = amount ? decimalToMinor(amount, EUR_DECIMALS) : null;
      if (!parsed || (currency ?? "").toUpperCase() !== WIRE_CURRENCY) {
        state = "NEEDS_REVIEW";
        reviewReason = currency && currency.toUpperCase() !== WIRE_CURRENCY ? "WRONG_ASSET" : "AMOUNT_MISMATCH";
      } else if (requested && requested.minor !== parsed.minor) {
        state = "NEEDS_REVIEW";
        reviewReason = "AMOUNT_MISMATCH";
      } else creditMinor = parsed.minor;
    }
    const card = cardFromDetails(d);
    return {
      providerPaymentId: t.transactionId,
      merchantRef: t.clientUniqueId ?? null,
      channelRef: d.userDetails?.userTokenId ?? null,
      state,
      rawState: `${type || "unknown"}:${status || "unknown"}${t.isVoided ? ":voided" : ""}`,
      creditMinor,
      feeMinor: null,
      ...(card ? { card } : {}),
      ...(reviewReason ? { reviewReason } : {}),
      occurredAt: isoDate(t.date) ?? deps.now(),
    };
  }

  function payoutFromAnswer(a: { transactionStatus?: string | null; transactionId?: string | null; gwErrorCode?: string | null; errCode?: string | null; reason?: string | null; gwErrorReason?: string | null }, merchantRef: string, reading: boolean): ProviderPayout | null {
    const status = (a.transactionStatus ?? "").toUpperCase();
    const base = { providerPayoutId: a.transactionId ?? null, merchantRef, rawState: status || "UNKNOWN", occurredAt: deps.now() };
    if (status === "APPROVED") return { ...base, state: "SUCCEEDED", final: true };
    if (status === "PENDING") return { ...base, state: "PROCESSING", final: false };
    // ERROR on the dispatch itself is unknown (query first); on a status read it is the gateway's final answer.
    if (status === "DECLINED" || (status === "ERROR" && reading)) {
      const code = a.gwErrorCode ?? a.errCode ?? null;
      const methodIneligible = (code !== null && INELIGIBLE_CODES.has(code)) || INELIGIBLE_TEXT.test(`${a.reason ?? ""} ${a.gwErrorReason ?? ""}`);
      return { ...base, state: "FAILED", final: true, failureCode: clip(`NUVEI_${code ?? status}`, 64), ...(methodIneligible ? { methodIneligible: true } : {}) };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /** Case-insensitive lookup; more than one match (or a repeated parameter) is ambiguous. */
  function field(params: URLSearchParams, name: string): string | null | "ambiguous" {
    const wanted = name.toLowerCase();
    const found: string[] = [];
    for (const [k, v] of params) if (k.toLowerCase() === wanted) found.push(v);
    if (found.length > 1) return "ambiguous";
    return found[0] ?? null;
  }

  async function anySecretMatches(given: string, compute: (secret: string) => Promise<string>): Promise<boolean> {
    const givenBytes = hexToBytes(given);
    if (!givenBytes || givenBytes.length !== 32) return false;
    let match = false;
    for (const secret of secrets) {
      if (equalBytes(hexToBytes(await compute(secret))!, givenBytes)) match = true;
    }
    return match;
  }

  async function verifyDmn(params: URLSearchParams): Promise<WebhookVerification> {
    const read = (name: string): string | null | undefined => {
      const value = field(params, name);
      return value === "ambiguous" ? undefined : value;
    };
    const checksum = read("advanceResponseChecksum");
    const totalAmount = read("totalAmount");
    const currency = read("currency");
    const responseTimeStamp = read("responseTimeStamp");
    const pppTransactionId = read("PPP_TransactionID");
    const status = read("Status");
    const productId = read("productId");
    // A repeated signed parameter is ambiguous: refused before anything else.
    if ([checksum, totalAmount, currency, responseTimeStamp, pppTransactionId, status, productId].some((v) => v === undefined)) return { ok: false, reason: "format" };
    if (!checksum) return { ok: false, reason: "signature" };
    // An MD5 site setting: refused, the operator sets the site to SHA-256.
    if (/^[0-9a-fA-F]{32}$/.test(checksum)) return { ok: false, reason: "unsupported_scheme" };
    if (totalAmount == null || currency == null || responseTimeStamp == null || pppTransactionId == null || status == null) {
      return { ok: false, reason: "format" };
    }
    const signed = { totalAmount, currency, responseTimeStamp, pppTransactionId, status, productId: productId ?? "" };
    // Before the hash: a value of the wrong shape is a re-split, or not a DMN (see DMN_FIELD_FORMAT).
    const signedAt = parsePageTimestamp(responseTimeStamp);
    if (signedAt === null || !DMN_FIELD_FORMAT.totalAmount.test(totalAmount) || !DMN_FIELD_FORMAT.currency.test(currency)
        || !DMN_FIELD_FORMAT.pppTransactionId.test(pppTransactionId) || !DMN_FIELD_FORMAT.status.test(status) || !DMN_FIELD_FORMAT.productId.test(signed.productId)) {
      return { ok: false, reason: "format" };
    }
    if (!(await anySecretMatches(checksum, (secret) => dmnChecksum(signed, secret)))) return { ok: false, reason: "signature" };
    // A player keeps the signed parameter set of their own success redirect: an old one is refused
    // (each accepted DMN costs a status re-read at Nuvei).
    if (deps.now().getTime() - signedAt.getTime() > DMN_MAX_AGE_MS) return { ok: false, reason: "format" };
    const events = await dmnEvents(params, signed, signedAt);
    return events === null ? { ok: false, reason: "format" } : { ok: true, scheme: "nuvei-dmn-sha256", events };
  }

  async function dmnEvents(params: URLSearchParams, signed: { totalAmount: string; currency: string; pppTransactionId: string; status: string }, signedAt: Date): Promise<NormalizedEvent[] | null> {
    const get = (name: string): string | null => {
      const value = field(params, name);
      return value === "ambiguous" || value === null || value === "" ? null : value;
    };
    const { status } = signed;
    const transactionType = (get("transactionType") ?? "Sale").toLowerCase();
    const transactionId = get("TransactionID");
    if (transactionId !== null && !/^[0-9]{1,20}$/.test(transactionId)) return null;
    const occurredAt = signedAt;
    const raw: Record<string, string> = {};
    for (const [k, v] of params) if (!(k in raw)) raw[k] = v;
    const last4 = last4Of(get("cardNumber"));
    const payload = { ...redactWith(REDACT_KEYS, raw), ...(last4 ? { last4 } : {}) };
    // Only signed fields name the event, in one spelling: a replayed parameter set with another (unsigned)
    // TransactionID or transactionType is the same event again (deduplicated), not a new row and a new Nuvei re-read.
    const providerEventId = clip(eventKeySafe(`dmn:${signed.pppTransactionId}:${status}:${signedAt.toISOString()}`), 200);
    const eventType = clip(`dmn.${transactionType}.${status.toLowerCase()}`, 100);
    const amount = decimalToMinor(signed.totalAmount, EUR_DECIMALS);
    const euro = signed.currency.toUpperCase() === WIRE_CURRENCY;
    const merchantRef = get("merchant_unique_id") ?? get("clientUniqueId");

    if (status === "UPDATE") return []; // North-American bank transfers only.

    if (transactionType === "sale" || transactionType === "auth") {
      let state: PaymentState =
        transactionType === "auth" ? "PROCESSING"
        : status === "APPROVED" || status === "SUCCESS" ? "SUCCEEDED"
        : status === "DECLINED" ? "FAILED"
        : "PROCESSING"; // PENDING, and ERROR until the status read confirms it
      let reviewReason: ReviewReason | undefined;
      if (state === "SUCCEEDED" && (!euro || !amount)) {
        state = "NEEDS_REVIEW";
        reviewReason = euro ? "AMOUNT_MISMATCH" : "WRONG_ASSET";
      }
      const requested = get("requestedAmount");
      if (state === "SUCCEEDED" && requested !== null && decimalToMinor(requested, EUR_DECIMALS)?.minor !== amount?.minor) {
        state = "NEEDS_REVIEW";
        reviewReason = "AMOUNT_MISMATCH";
      }
      const token = get("userPaymentOptionId");
      const card: CardFacts | undefined = token
        ? {
          token,
          fingerprint: get("uniqueCC"),
          brand: get("cardCompany"),
          last4,
          expMonth: month(get("expMonth")),
          expYear: year(get("expYear")),
          issuerCountry: country(get("cardIssuerCountry")),
          funding: funding(get("cardType")),
          payoutEligible: true,
          holderName: get("nameOnCard"),
        }
        : undefined;
      const payment: ProviderPayment = {
        providerPaymentId: transactionId ?? `ppp:${eventKeySafe(signed.pppTransactionId)}`,
        merchantRef,
        channelRef: get("user_token_id"),
        state,
        rawState: `${transactionType}:${status}`,
        creditMinor: state === "SUCCEEDED" ? amount!.minor : null,
        feeMinor: null,
        ...(card ? { card } : {}),
        ...(reviewReason ? { reviewReason } : {}),
        occurredAt,
      };
      return [{ providerEventId, eventType, objectType: "PAYMENT", objectRef: payment.providerPaymentId, merchantRef, payload, payment }];
    }

    if (transactionType === "credit" && merchantRef && /^(wd|rf)_/.test(merchantRef)) {
      // Our own payout or refund: the dispatcher re-reads it (getPayout).
      const payout = payoutFromAnswer({ transactionStatus: status === "SUCCESS" ? "APPROVED" : status, transactionId, errCode: get("ErrCode"), reason: get("Reason") }, merchantRef, false)
        ?? { providerPayoutId: transactionId, merchantRef, state: "PROCESSING" as const, final: false, rawState: status, occurredAt };
      return [{ providerEventId, eventType, objectType: merchantRef.startsWith("rf_") ? "REFUND" : "PAYOUT", objectRef: transactionId, merchantRef, payload, payout }];
    }

    if (transactionType === "chargeback" || transactionType === "void" || transactionType === "credit") {
      // Linked to the sale through unsigned fields: informational only.
      const sale = get("relatedTransactionId");
      if (!sale || !/^[0-9]{1,20}$/.test(sale) || status === "DECLINED" || status === "ERROR") return [];
      const dispute: ProviderDispute = {
        providerReversalId: `dmn-${transactionType}:${transactionId ?? eventKeySafe(signed.pppTransactionId)}`,
        providerPaymentId: sale,
        kind: transactionType === "chargeback" ? "CHARGEBACK" : "PROVIDER_REFUND",
        amountMinor: euro && amount ? amount.minor : 0n,
        informational: true,
        occurredAt,
      };
      return [{ providerEventId, eventType, objectType: "DISPUTE", objectRef: sale, merchantRef: null, payload, dispute }];
    }
    return []; // Modification and anything else: nothing to apply.
  }

  async function verifyControlPanelEvent(request: WebhookRequest, body: string): Promise<WebhookVerification> {
    const checksum = request.headers.get("checksum")?.trim() ?? "";
    if (!checksum) return { ok: false, reason: "signature" };
    let parsed: unknown;
    try {
      parsed = parseJsonLossless(body);
    } catch {
      return { ok: false, reason: "format" };
    }
    // The raw-body form only (checksum.ts): the values form can be forged from a player's Payment Page checksum.
    if (!body.startsWith("{") || !(await anySecretMatches(checksum, (secret) => eventChecksumRaw(body, secret)))) return { ok: false, reason: "signature" };
    const scheme = "nuvei-event-raw-sha256";
    const event = eventSchema.safeParse(parsed);
    if (!event.success) return { ok: false, reason: "format" };
    const e = event.data;
    if (e.EventType.toLowerCase() !== "chargeback" || !e.Chargeback) return { ok: true, scheme, events: [] };
    const cb = e.Chargeback;
    const sale = e.TransactionDetails?.TransactionId ?? null;
    if (!sale || !/^[0-9]{1,20}$/.test(sale)) return { ok: false, reason: "format" };
    const category = (cb.ChargebackStatusCategory ?? "").toLowerCase();
    const type = (cb.Type ?? "Chargeback").toLowerCase();
    const amount = cb.Amount != null ? decimalToMinor(cb.Amount, EUR_DECIMALS, "floor") : null;
    const euro = (cb.Currency ?? "").toUpperCase() === WIRE_CURRENCY;
    // Retrievals, soft chargebacks, duplicates and cancellations move no
    // money now (the won/lost status values are UNVERIFIED): record and
    // flag; staff applies outcomes.
    const moves = type === "chargeback" && (category === "regular" || category === "rdr-refund" || category === "") && euro && amount !== null;
    const occurredAt = isoDate(e.EventDateUTC) ?? isoDate(cb.Date) ?? deps.now();
    const dispute: ProviderDispute = {
      providerReversalId: cb.DisputeId ? `dispute:${cb.DisputeId}` : `cb:${sale}`,
      providerPaymentId: sale,
      kind: "CHARGEBACK",
      amountMinor: euro && amount ? amount.minor : 0n,
      ...(moves ? {} : { informational: true }),
      ...(cb.ChargebackReason ? { reasonCode: clip(cb.ChargebackReason, 100) } : {}),
      occurredAt,
    };
    const providerEventId = e.EventId
      ? clip(`cp:${eventKeySafe(e.EventId)}`, 200)
      : `d_${await sha256HexOf(`${key}|${sale}|${cb.DisputeId ?? ""}|${cb.Status ?? ""}|${category}|${e.EventDateUTC ?? e.EventDate ?? ""}`)}`;
    return {
      ok: true,
      scheme,
      events: [{
        providerEventId,
        eventType: clip(`cp.chargeback.${type}.${category || "unknown"}`, 100),
        objectType: "DISPUTE",
        objectRef: sale,
        merchantRef: e.TransactionDetails?.ClientUniqueId ?? null,
        payload: redactWith(REDACT_KEYS, parsed),
        dispute,
      }],
    };
  }

  // -------------------------------------------------------------------------
  // The provider
  // -------------------------------------------------------------------------

  return {
    kind: "nuvei",
    method: "CARD",
    key,
    sandbox: mode === "sandbox",
    settlementAsset,
    authoritativeWebhooks: false,
    dedupesOnOurKey: config.idempotencyConfirmed,
    // The Payment Page, and only it: the URL is built here from the constants above.
    redirectHosts: [new URL(urls.page).hostname],

    async createDepositSession(input: CardDepositSessionInput): Promise<ProviderResult<CardDepositSession>> {
      if (input.amountMinor <= 0n) return { kind: "rejected", final: true, code: "BAD_AMOUNT", message: "amount must be positive" };
      if (input.depositId.length > 64 || !/^[A-Za-z0-9._-]+$/.test(input.depositId)) return { kind: "rejected", final: true, code: "BAD_REFERENCE", message: "merchant_unique_id is at most 64 safe characters" };
      const ref = input.customer.providerCustomerRef;
      if (!ref || ref.length > 255) return { kind: "rejected", final: true, code: "BAD_CUSTOMER_REF", message: "user_token_id is 1-255 characters" };
      let returnUrl: URL;
      try {
        returnUrl = new URL(input.returnUrl);
      } catch {
        return { kind: "rejected", final: true, code: "BAD_RETURN_URL", message: "return URL is not a URL" };
      }
      if (returnUrl.protocol !== "https:" && mode === "live") return { kind: "rejected", final: true, code: "BAD_RETURN_URL", message: "return URL must be https" };
      const amount = formatMinor(input.amountMinor, EUR_DECIMALS);
      // Order matters: the checksum is over the values in exactly this order.
      const params: [string, string][] = [
        ["merchant_id", config.merchantId],
        ["merchant_site_id", config.merchantSiteId],
        ["total_amount", amount],
        ["currency", WIRE_CURRENCY],
        ["user_token_id", ref],
        ["item_name_1", "Account deposit"],
        ["item_amount_1", amount],
        ["item_quantity_1", "1"],
        ["time_stamp", pageTimestamp(deps.now())],
        ["version", PAYMENT_PAGE_VERSION],
        // ISO-8859-1 is the default; UTF-8 must be declared.
        ["encoding", "utf-8"],
        ["notify_url", config.notifyUrl],
        ["merchant_unique_id", input.depositId],
        // Cards only (payment_method_mode=filter hides every other method).
        ["payment_method", "cc_card"],
        ["payment_method_mode", "filter"],
        // auto (the default) registers the card, whose userPaymentOptionId
        // the payouts need; readonlyupo forces a saved card.
        ...(input.instrumentToken
          ? ([["user_token", "readonlyupo"], ["userPaymentOptionId", input.instrumentToken]] as [string, string][])
          : ([["user_token", "auto"]] as [string, string][])),
        ["success_url", input.returnUrl],
        ["error_url", input.returnUrl],
        ["pending_url", input.returnUrl],
        ["back_url", input.returnUrl],
        ...(input.customer.email ? ([["email", clip(input.customer.email, 100)]] as [string, string][]) : []),
        ...(input.customer.country && /^[A-Z]{2}$/.test(input.customer.country) ? ([["country", input.customer.country]] as [string, string][]) : []),
        ...(input.customer.legalName
          ? ([["first_name", clip(input.customer.legalName.first, 30)], ["last_name", clip(input.customer.legalName.last, 40)]] as [string, string][])
          : []),
      ];
      const checksum = await pageChecksum(params, config.secretKey);
      const query = [...params, ["checksum", checksum] as const].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return { kind: "ok", value: { type: "REDIRECT", providerPaymentId: null, url: `${urls.page}?${query}`, expiresAt: input.expiresAt } };
    },

    async getPayment(ref): Promise<ProviderResult<ProviderPayment | null>> {
      const byId = ref.providerPaymentId && /^[0-9]{1,20}$/.test(ref.providerPaymentId) ? ref.providerPaymentId : null;
      if (!byId && !ref.merchantRef) return { kind: "ok", value: null };
      const found = await transactionDetails(byId ? { transactionId: byId } : { clientUniqueId: ref.merchantRef! });
      if (found.kind !== "ok") return found;
      if (!found.value) return { kind: "ok", value: null };
      const payment = paymentFromDetails(found.value);
      if (!payment) return { kind: "uncertain", reason: "malformed" };
      if (payment.card && payment.state === "SUCCEEDED" && payment.channelRef) {
        payment.card.fingerprint = await uniqueCcOf(payment.channelRef, payment.card.token);
      }
      return { kind: "ok", value: payment };
    },

    async quotePayout(input): Promise<ProviderResult<PayoutQuote>> {
      if (input.destination.kind !== "CARD_TOKEN") return { kind: "rejected", final: true, code: "DESTINATION_UNSUPPORTED", message: "Nuvei pays out only to a card token" };
      // No provider fee is passed to the player; the card receives the EUR amount.
      return { kind: "ok", value: { feeMinor: 0n, receiveEstimate: formatMinor(input.amountMinor, EUR_DECIMALS), rate: null, expiresAt: new Date(deps.now().getTime() + QUOTE_TTL_MS) } };
    },

    async createPayout(input: PayoutInput): Promise<ProviderResult<ProviderPayout>> {
      if (input.destination.kind !== "CARD_TOKEN") return { kind: "rejected", final: true, code: "DESTINATION_UNSUPPORTED", message: "Nuvei pays out only to a card token" };
      if (input.amountMinor <= 0n) return { kind: "rejected", final: true, code: "BAD_AMOUNT", message: "amount must be positive" };
      const idKey = input.idempotencyKey;
      if (idKey.length > CLIENT_UNIQUE_ID_MAX || !/^[A-Za-z0-9._:-]+$/.test(idKey)) return { kind: "rejected", final: true, code: "BAD_REFERENCE", message: "clientUniqueId is at most 45 characters" };
      const amount = formatMinor(input.amountMinor, EUR_DECIMALS);
      const timeStamp = restTimestamp(deps.now());
      const common = { merchantId: config.merchantId, merchantSiteId: config.merchantSiteId, clientRequestId: idKey, clientUniqueId: idKey, amount, currency: WIRE_CURRENCY, timeStamp };

      if (input.operation === "REFUND") {
        const sale = input.refundOf?.providerPaymentId;
        if (!sale || !/^[0-9]{1,19}$/.test(sale)) return { kind: "rejected", final: true, code: "BAD_REFERENCE", message: "a refund needs the sale's transaction id" };
        // Checksum order: merchantId, merchantSiteId, clientRequestId, clientUniqueId, amount, currency, relatedTransactionId, [authCode, comment, urlDetails: never sent], timeStamp.
        const answer = await call("refundTransaction", { ...common, relatedTransactionId: sale },
          [config.merchantId, config.merchantSiteId, idKey, idKey, amount, WIRE_CURRENCY, sale, timeStamp]);
        if (answer.kind !== "ok") return answer;
        const parsed = payoutAnswerSchema.safeParse(answer.body);
        if (!parsed.success || !ours(parsed.data)) return { kind: "uncertain", reason: "malformed" };
        return dispatchOutcome(parsed.data, idKey, input.withdrawalId);
      }

      const ip = ipv4Mapped(input.customer.ip);
      // deviceDetails.ipAddress is required (documented as String(15): an IPv6 address is UNVERIFIED).
      if (!ip) return { kind: "rejected", final: false, code: "CUSTOMER_IP_REQUIRED", message: "Nuvei payouts need the player's IP address" };
      // Checksum order: merchantId, merchantSiteId, clientRequestId, amount, currency, timeStamp.
      const answer = await call("payout", {
        ...common,
        userTokenId: input.customer.providerCustomerRef,
        userPaymentOption: { userPaymentOptionId: input.destination.token },
        deviceDetails: { ipAddress: ip },
        // UNVERIFIED: Mastercard gaming payouts need the cardholder name,
        // documented as cardData.cardHolderName; whether it may accompany a
        // userPaymentOption is to be confirmed with Nuvei. userDetails is a
        // documented optional class and carries the verified name.
        userDetails: {
          firstName: clip(input.beneficiary.firstName, 30),
          lastName: clip(input.beneficiary.lastName, 40),
          country: input.beneficiary.countryCode,
        },
      }, [config.merchantId, config.merchantSiteId, idKey, amount, WIRE_CURRENCY, timeStamp]);
      if (answer.kind !== "ok") return answer;
      const parsed = payoutAnswerSchema.safeParse(answer.body);
      if (!parsed.success || !ours(parsed.data)) return { kind: "uncertain", reason: "malformed" };
      return dispatchOutcome(parsed.data, idKey, input.withdrawalId);
    },

    async getPayout(ref): Promise<ProviderResult<ProviderPayout | null>> {
      const idKey = ref.idempotencyKey;
      if (idKey.startsWith("rf_")) {
        const found = await transactionDetails(ref.providerPayoutId && /^[0-9]{1,20}$/.test(ref.providerPayoutId) ? { transactionId: ref.providerPayoutId } : { clientUniqueId: idKey });
        if (found.kind !== "ok") return found;
        if (!found.value?.transactionDetails) return { kind: "ok", value: null };
        const t = found.value.transactionDetails;
        const type = (t.transactionType ?? "").toLowerCase();
        if (t.clientUniqueId !== idKey || (type !== "refund" && type !== "credit")) {
          log("error", { transactionId: t.transactionId ?? null, transactionType: type || null, alert: "NUVEI_REFUND_MISMATCH" }, "refund lookup returned another transaction");
          return { kind: "uncertain", reason: "malformed" };
        }
        const payout = payoutFromAnswer({ transactionStatus: t.transactionStatus, transactionId: t.transactionId, gwErrorCode: t.gwErrorCode, gwErrorReason: t.gwErrorReason }, idKey, true);
        return payout ? { kind: "ok", value: { ...payout, occurredAt: isoDate(t.date) ?? payout.occurredAt } } : { kind: "uncertain", reason: "malformed" };
      }
      const timeStamp = restTimestamp(deps.now());
      const answer = await call("getPayoutStatus", { merchantId: config.merchantId, merchantSiteId: config.merchantSiteId, clientRequestId: idKey, timeStamp },
        [config.merchantId, config.merchantSiteId, idKey, timeStamp]);
      if (answer.kind !== "ok") return answer;
      const parsed = payoutAnswerSchema.safeParse(answer.body);
      if (!parsed.success || !ours(parsed.data)) return { kind: "uncertain", reason: "malformed" };
      if (parsed.data.status.toUpperCase() !== "SUCCESS") {
        if (NOT_FOUND_TEXT.test(parsed.data.reason ?? "")) return { kind: "ok", value: null };
        log("warn", { method: "getPayoutStatus", errCode: parsed.data.errCode ?? null }, "nuvei payout lookup refused");
        return { kind: "uncertain", reason: "malformed" };
      }
      const payout = payoutFromAnswer(parsed.data, idKey, true);
      return payout ? { kind: "ok", value: payout } : { kind: "uncertain", reason: "malformed" };
    },

    async verifyWebhook(request: WebhookRequest): Promise<WebhookVerification> {
      const method = request.method.toUpperCase();
      const body = decodeUtf8(request.rawBody);
      if (body === null) return { ok: false, reason: "format" };
      if (method === "POST" && body.trimStart().startsWith("{")) return verifyControlPanelEvent(request, body);
      // Payment DMN: the HTTP method is not documented (UNVERIFIED), so a
      // form body (POST) and a query string (GET) are both accepted.
      if (method === "POST" && body.trim() !== "") return verifyDmn(new URLSearchParams(body));
      if ((method === "GET" || method === "POST") && request.url.search.length > 1) return verifyDmn(new URLSearchParams(request.url.search));
      return { ok: false, reason: "format" };
    },

    redact(payload: unknown): Record<string, unknown> {
      return redactWith(REDACT_KEYS, payload);
    },
  };

  function dispatchOutcome(a: PayoutAnswer, idKey: string, withdrawalId: string): ProviderResult<ProviderPayout> {
    if (a.clientRequestId && a.clientRequestId !== idKey) {
      log("error", { withdrawalId, alert: "NUVEI_PAYOUT_MISMATCH" }, "Nuvei answered for another clientRequestId");
      return { kind: "uncertain", reason: "malformed" };
    }
    if (a.status.toUpperCase() !== "SUCCESS") {
      // A refused request (including a repeated clientRequestId when
      // idempotency is on): whether a transaction exists is unknown here.
      log("warn", { withdrawalId, errCode: a.errCode ?? null }, "nuvei refused the dispatch request");
      return { kind: "uncertain", reason: "malformed" };
    }
    const payout = payoutFromAnswer(a, idKey, false);
    return payout ? { kind: "ok", value: payout } : { kind: "uncertain", reason: "malformed" };
  }
}

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

function month(value: string | null | undefined): number | null {
  const n = value && /^[0-9]{1,2}$/.test(value) ? Number(value) : NaN;
  return n >= 1 && n <= 12 ? n : null;
}

function year(value: string | null | undefined): number | null {
  if (!value || !/^[0-9]{2}([0-9]{2})?$/.test(value)) return null;
  return value.length === 2 ? 2000 + Number(value) : Number(value);
}

function country(value: string | null | undefined): string | null {
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

function funding(cardType: string | null | undefined): CardFacts["funding"] {
  const type = (cardType ?? "").toLowerCase();
  if (type.includes("prepaid")) return "prepaid";
  if (type.includes("debit")) return "debit";
  if (type.includes("credit")) return "credit";
  return "unknown";
}

function isoDate(value: string | null | undefined): Date | null {
  if (!value || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9]{2}:?[0-9]{2})?)?$/.test(value)) return null;
  const date = new Date(value.includes("T") || !value.includes(" ") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The player's IP for deviceDetails: IPv4, an IPv4-mapped IPv6 as IPv4, or another IPv6 as is. */
function ipv4Mapped(ip: string | null): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(ip) || /^[0-9a-fA-F:]{2,39}$/.test(ip)) return ip;
  return null;
}

