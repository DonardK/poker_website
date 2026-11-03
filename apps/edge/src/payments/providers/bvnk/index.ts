/**
 * BVNK crypto adapter (design-payments section 11; facts verified against
 * BVNK's docs and OpenAPI on 2026-10-29, see README.md in this directory).
 *
 * - Deposits: one channel per player and pay asset (POST /api/v2/channel),
 *   converted to the EUR wallet. Its reference is derived from the player's
 *   pseudonymous ref and the asset (cha_<hash>), so a later session finds
 *   the same channel (GET /api/v2/channel?q=<reference>) and shows the same
 *   address. A channel payment names no deposit (merchantRef is always
 *   null): the core matches it by the receiving address, and channelRef is
 *   the channel's uuid.
 * - Payouts: create-then-confirm (twoStep), from the EUR wallet, with our
 *   idempotency key as the unique `reference` (a duplicate answers
 *   "Duplicate Reference"; the payout is then looked up by reference and the
 *   confirmation resumed). The X-Idempotency-Key header is a UUID derived
 *   from the same key (BVNK wants UUID-shaped keys).
 * - Hawk (HMAC-SHA256) request authentication (hawk.ts); x-signature
 *   webhooks: base64 HMAC-SHA256 over the raw body, current and previous
 *   secret accepted, compared in constant time. Webhooks are hints
 *   (authoritativeWebhooks = false): BVNK says to "always check the status
 *   of the payment on the API after you receive a webhook".
 * - Amounts are JSON numbers on the wire: read and written losslessly
 *   (wire.ts), never through a JS number.
 * - PAYMENTS_EGRESS_MODE=relay sends every call to the relay origin with the
 *   same path; the Hawk MAC is computed for BVNK's host. The relay's own
 *   authentication (mTLS client certificate) belongs to the registry's
 *   egress-aware fetch.
 */
import { z } from "zod";
import type { SettlementAsset } from "@poker/shared";
import { formatMinor } from "../../../money/amounts";
import {
  ProviderConfigError,
  providerLedgerKey,
  type BvnkConfig,
  type CryptoDepositSession,
  type CryptoDepositSessionInput,
  type CryptoProvider,
  type NormalizedEvent,
  type PaymentState,
  type PayoutDestination,
  type PayoutInput,
  type PayoutQuote,
  type ProviderDeps,
  type ProviderPayment,
  type ProviderPayout,
  type ProviderResult,
  type ReviewReason,
  type TravelRuleParty,
  type WebhookRequest,
  type WebhookVerification,
} from "../types";
import { hawkAuthorization } from "./hawk";
import {
  base64ToBytes,
  clip,
  dateFromEpochMs,
  decimalToMinor,
  decodeUtf8,
  equalBytes,
  hmac,
  JsonNumber,
  parseJsonLossless,
  plainDecimal,
  randomAlphanumeric,
  redactWith,
  SAFE_ID,
  sha256HexOf,
  send,
  stringifyJsonLossless,
  uuidFromKey,
  type WireResult,
} from "../wire";

/** OpenAPI servers (https://docs.bvnk.com/bvnk-api-endpoints.json). */
export const BVNK_BASE_URLS = {
  sandbox: "https://api.sandbox.bvnk.com",
  production: "https://api.bvnk.com",
} as const;

/** The wallet currency on the wire (BVNK's test environment uses real ISO codes; the ledger books TEST_EUR in sandbox mode). */
const WIRE_CURRENCY = "EUR";
const EUR_DECIMALS = 2;
/** PayRequestOutDto.amount minimum: 5 (EUR). */
const PAYOUT_MIN_MINOR = 500n;
/**
 * How long our quote is offered. BVNK has no estimate without the
 * beneficiary's travel-rule details (see quotePayout); a two-step payout's
 * own quote locks for one hour after creation (PayRequestOutDto.twoStep).
 */
const QUOTE_TTL_MS = 10 * 60_000;
const IDEMPOTENCY_NAMESPACE = "bvnk-idempotency-v1";
const CHANNEL_NAMESPACE = "bvnk-channel-v1";

// ---------------------------------------------------------------------------
// Wire schemas (unknown fields are ignored; numbers arrive as JsonNumber)
// ---------------------------------------------------------------------------

const num = z.instanceof(JsonNumber);
const text = (max: number) => z.string().max(max);
/** An amount: a JSON number in the OpenAPI; a plain decimal string is accepted too (other BVNK payloads quote amounts). */
const decimal = z.union([num, z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).max(64)]);
/** Epoch milliseconds: a JSON number in the OpenAPI, yet a string in some webhook examples (transactions[].dateConfirmed). */
const epochMs = z.union([num, z.string().max(20)]);

/** MerchantChannelDto. */
const channelSchema = z.object({
  uuid: text(128).min(1),
  reference: text(255).nullish(),
  address: text(256).min(1),
  tag: text(128).nullish(),
  network: text(64).nullish(),
  protocol: text(64).nullish(),
  walletCurrency: text(20).nullish(),
  payCurrency: text(20).nullish(),
  status: text(32).nullish(),
  redirectUrl: text(2048).nullish(),
  uri: text(2048).nullish(),
  dateCreated: epochMs.nullish(),
});
type Channel = z.infer<typeof channelSchema>;

/** MerchantChannelPaymentDto, also the `data` of the channel webhooks. */
const channelPaymentSchema = z.object({
  uuid: text(128).min(1),
  channelId: text(128).nullish(),
  reference: text(255).nullish(),
  status: text(32).min(1),
  hash: text(256).nullish(),
  address: text(256).nullish(),
  tag: text(128).nullish(),
  paidCurrency: text(20).nullish(),
  paidAmount: decimal.nullish(),
  walletCurrency: text(20).nullish(),
  walletAmount: decimal.nullish(),
  feeCurrency: text(20).nullish(),
  feeAmount: decimal.nullish(),
  sources: z.array(text(256)).max(100).nullish(),
  dateCreated: epochMs.nullish(),
  lastUpdated: epochMs.nullish(),
});
type ChannelPayment = z.infer<typeof channelPaymentSchema>;

const payAmounts = z.object({ currency: text(20).nullish(), amount: decimal.nullish(), actual: decimal.nullish() }).nullish();

/** SummaryPaymentDto, also the `data` of bvnk:payment:crypto:* webhooks. */
const summarySchema = z.object({
  uuid: text(128).min(1),
  reference: text(255).nullish(),
  status: text(32).min(1),
  type: text(8).nullish(),
  quoteStatus: text(32).nullish(),
  walletCurrency: payAmounts,
  paidCurrency: payAmounts,
  feeCurrency: payAmounts,
  exchangeRate: z.object({ rate: decimal.nullish() }).nullish(),
  transactions: z.array(z.object({ hash: text(256).nullish(), amount: decimal.nullish(), dateConfirmed: epochMs.nullish() })).max(100).nullish(),
  dateCreated: epochMs.nullish(),
  quoteExpiryDate: epochMs.nullish(),
  acceptanceExpiryDate: epochMs.nullish(),
});
type Summary = z.infer<typeof summarySchema>;

const envelopeSchema = z.object({
  event: text(100).min(1),
  eventId: text(200).min(1),
  timestamp: text(64).nullish(),
  data: z.record(z.string(), z.unknown()),
});

const infoRequestSchema = z.object({
  id: text(128).min(1),
  relatedPayment: z.object({ id: text(128).nullish(), reference: text(255).nullish() }).nullish(),
});

/** Error bodies come in three shapes: {errorList:[{code,parameter,message}]}, [{code,message}], {code,message}. */
function errorsOf(body: unknown): { code: string; parameter: string; message: string }[] {
  const items: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? Array.isArray((body as { errorList?: unknown }).errorList)
        ? ((body as { errorList: unknown[] }).errorList)
        : [body]
      : [];
  const field = (item: unknown, key: string): string => {
    const value = item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? clip(value, 200) : "";
  };
  return items.slice(0, 10).map((item) => ({
    code: field(item, "code"),
    parameter: field(item, "parameter") || field(item, "fieldName"),
    message: field(item, "message"),
  }));
}

/** Fields kept in PaymentEvent.payload: ids, statuses, amounts and currencies only. */
const REDACT_KEYS: ReadonlySet<string> = new Set([
  "event", "eventId", "timestamp", "data",
  "uuid", "channelId", "reference", "status", "quoteStatus", "type", "subType", "hash",
  "paidCurrency", "paidAmount", "walletCurrency", "walletAmount", "feeCurrency", "feeAmount", "displayCurrency", "displayAmount",
  "currency", "amount", "actual", "exchangeRate", "rate", "base", "counter",
  "dateCreated", "lastUpdated", "dateConfirmed", "expiryDate", "quoteExpiryDate",
  "transactions", "id", "relatedPayment", "requiredAction",
]);

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createBvnkAdapter(config: BvnkConfig, deps: ProviderDeps): CryptoProvider {
  if (config.webhookScheme !== "v2_base64") throw new ProviderConfigError("bvnk", "BVNK_WEBHOOK_SCHEME", "only the v2_base64 webhook scheme is supported");
  if (!/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(config.hawkAuthId)) throw new ProviderConfigError("bvnk", "BVNK_HAWK_AUTH_ID", "BVNK_HAWK_AUTH_ID has characters a Hawk header cannot carry");
  if (Object.keys(config.assetMap).length === 0) throw new ProviderConfigError("bvnk", "BVNK_ASSET_MAP", "BVNK_ASSET_MAP is empty");
  const mode = config.env === "production" ? "live" : "sandbox";
  const key = providerLedgerKey("crypto", "bvnk", mode);
  const settlementAsset: SettlementAsset = mode === "live" ? "EUR" : "TEST_EUR";
  const base = new URL(BVNK_BASE_URLS[config.env]);
  const egressOrigin = config.egress.mode === "relay" ? new URL(config.egress.relayUrl).origin : null;
  const credentials = { id: config.hawkAuthId, key: config.hawkAuthKey };
  const log = (level: "info" | "warn" | "error", fields: Record<string, string | number | boolean | null>, message: string) =>
    deps.log(level, { provider: key, ...fields }, message);

  type Answer = { kind: "ok"; status: number; body: unknown } | { kind: "error"; status: number; body: unknown } | { kind: "uncertain"; reason: "timeout" | "network" | "5xx" | "malformed" };

  /** One signed call. 2xx with an unparsable body is "uncertain/malformed"; 4xx is "error" with the parsed body. */
  async function call(method: "GET" | "POST" | "PUT", pathAndQuery: string, body?: unknown, idempotencyKey?: string): Promise<Answer> {
    const target = new URL(pathAndQuery, base);
    const url = egressOrigin ? new URL(target.pathname + target.search, egressOrigin) : target;
    const ts = Math.floor(deps.now().getTime() / 1000);
    const nonce = randomAlphanumeric(deps.randomBytes, 8);
    const headers: Record<string, string> = {
      authorization: await hawkAuthorization(credentials, { method, target }, ts, nonce),
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    // "X-Idempotency-Key" by default, "Idempotency-Key" on v2 endpoints (idempotency page).
    if (idempotencyKey) headers[target.pathname.startsWith("/api/v2/") ? "idempotency-key" : "x-idempotency-key"] = await uuidFromKey(IDEMPOTENCY_NAMESPACE, idempotencyKey);
    const result: WireResult = await send(deps.fetch, { method, url: url.toString(), headers, body: body === undefined ? undefined : stringifyJsonLossless(body) });
    if (result.kind === "failed") {
      log("warn", { method, path: target.pathname, reason: result.reason }, "bvnk call failed");
      return { kind: "uncertain", reason: result.reason };
    }
    const parsed = result.text === null ? undefined : parseOrUndefined(result.text);
    if (result.status >= 500) {
      log("warn", { method, path: target.pathname, status: result.status }, "bvnk 5xx");
      return { kind: "uncertain", reason: "5xx" };
    }
    if (result.status >= 200 && result.status < 300) {
      if (result.text === null || (result.text.trim() !== "" && parsed === undefined)) return { kind: "uncertain", reason: "malformed" };
      return { kind: "ok", status: result.status, body: parsed ?? null };
    }
    if (result.status === 401 || result.status === 403) {
      // Hawk clock skew, a wrong key, or an egress IP that is not allow-listed.
      log("error", { method, path: target.pathname, status: result.status, alert: "BVNK_AUTH_REFUSED" }, "bvnk refused our credentials or egress IP");
    }
    if (result.status >= 300 && result.status < 400) return { kind: "uncertain", reason: "malformed" };
    return { kind: "error", status: result.status, body: parsed };
  }

  /** A non-2xx answer as a ProviderResult rejection (or uncertain where the outcome is unknown). */
  function refusal<T>(answer: Extract<Answer, { kind: "error" }>, fallbackCode: string): ProviderResult<T> {
    const errors = errorsOf(answer.body);
    const first = errors[0];
    if (answer.status === 401 || answer.status === 403) return { kind: "rejected", final: false, code: "PROVIDER_AUTH", message: "BVNK refused the request credentials or source IP" };
    if (answer.status === 429) return { kind: "rejected", final: false, code: "RATE_LIMITED", message: "BVNK rate limit" };
    if (answer.status === 408 || answer.status === 409) return { kind: "uncertain", reason: "malformed" };
    return { kind: "rejected", final: true, code: first?.code ? `BVNK_${first.code}`.slice(0, 64) : fallbackCode, message: first?.message || `BVNK answered ${answer.status}` };
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  function assetFor(code: string): { payCurrency: string; network: string } | null {
    return Object.prototype.hasOwnProperty.call(config.assetMap, code) ? config.assetMap[code]! : null;
  }

  /** Our asset code for a paid currency, when exactly one map entry has it. */
  function assetCodeOf(paidCurrency: string | null | undefined): { code: string; network: string } | null {
    if (!paidCurrency) return null;
    const matches = Object.entries(config.assetMap).filter(([, entry]) => entry.payCurrency.toUpperCase() === paidCurrency.toUpperCase());
    return matches.length === 1 ? { code: matches[0]![0], network: matches[0]![1].network } : null;
  }

  function party(p: TravelRuleParty) {
    return {
      type: p.type,
      entityType: "INDIVIDUAL",
      firstName: clip(p.firstName, 100),
      lastName: clip(p.lastName, 100),
      // OpenAPI examples are YYYY-MM-DD (the format itself is not stated: UNVERIFIED).
      dateOfBirth: p.dateOfBirth,
      relationshipType: p.relationship,
      countryCode: p.countryCode,
      ...(p.regionCode ? { regionCode: p.regionCode } : {}),
    };
  }

  function complianceDetails(p: TravelRuleParty, ip: string | null) {
    return { ...(ip ? { requesterIpAddress: ip } : {}), partyDetails: [party(p)] };
  }

  const CHANNEL_STATES: Record<string, PaymentState> = {
    DETECTED: "PROCESSING",
    PENDING: "PROCESSING",
    PROCESSING: "PROCESSING",
    // A compliance hold: not in our wallet yet; released payments become COMPLETE.
    HELD: "PROCESSING",
    COMPLETE: "SUCCEEDED",
    CANCELLED: "CANCELLED",
    EXPIRED: "EXPIRED",
    UNDERPAID: "NEEDS_REVIEW",
  };

  function mapChannelPayment(p: ChannelPayment): ProviderPayment {
    const rawState = p.status.toUpperCase();
    let state: PaymentState = CHANNEL_STATES[rawState] ?? "PROCESSING";
    let reviewReason: ReviewReason | undefined = rawState === "HELD" ? "KYT_HOLD" : rawState === "UNDERPAID" ? "UNDERPAID" : undefined;
    let creditMinor: bigint | null = null;
    let feeMinor: bigint | null = null;
    if (state === "SUCCEEDED") {
      const credit = p.walletAmount && (p.walletCurrency ?? "").toUpperCase() === WIRE_CURRENCY ? decimalToMinor(p.walletAmount, EUR_DECIMALS, "floor") : null;
      if (!credit) {
        state = "NEEDS_REVIEW";
        reviewReason = (p.walletCurrency ?? "").toUpperCase() !== WIRE_CURRENCY ? "WRONG_ASSET" : "AMOUNT_MISMATCH";
        log("error", { paymentId: p.uuid, walletCurrency: p.walletCurrency ?? null, alert: "BVNK_CREDIT_UNREADABLE" }, "completed channel payment without a usable EUR wallet amount");
      } else {
        creditMinor = credit.minor;
        // LEDGER.md: credit floored; the sub-cent remainder is reported, never rounded up.
        if (credit.remainder) log("warn", { paymentId: p.uuid, remainder: credit.remainder, alert: "CREDIT_REMAINDER" }, "wallet amount has sub-cent digits; credit floored");
      }
      if (p.feeAmount && (p.feeCurrency ?? "").toUpperCase() === WIRE_CURRENCY) feeMinor = decimalToMinor(p.feeAmount, EUR_DECIMALS, "floor")?.minor ?? null;
    }
    const asset = assetCodeOf(p.paidCurrency);
    return {
      providerPaymentId: p.uuid,
      merchantRef: null,
      channelRef: p.channelId ?? null,
      state,
      rawState,
      creditMinor,
      feeMinor,
      crypto: {
        asset: asset?.code ?? (p.paidCurrency ?? "UNKNOWN").toUpperCase(),
        network: asset?.network ?? "UNKNOWN",
        amount: (p.paidAmount && plainDecimal(p.paidAmount)) || "0",
        txHash: p.hash ?? null,
        confirmations: null,
        address: p.address ?? "",
        memo: p.tag ?? null,
        sources: p.sources ?? [],
      },
      ...(reviewReason ? { reviewReason } : {}),
      occurredAt: dateFromEpochMs(p.lastUpdated) ?? dateFromEpochMs(p.dateCreated) ?? deps.now(),
    };
  }

  /**
   * A created two-step payout that can still be confirmed: PENDING, its
   * quote not EXPIRED and neither expiry passed. Only decides whether we
   * try to confirm; it never makes a payout final on our clock (BVNK moves
   * an unconfirmed payout to EXPIRED itself, and a confirmed one may still
   * show PENDING briefly).
   */
  function confirmable(s: Summary): boolean {
    if (s.status.toUpperCase() !== "PENDING" || (s.quoteStatus ?? "").toUpperCase() === "EXPIRED") return false;
    const now = deps.now().getTime();
    for (const expiry of [dateFromEpochMs(s.quoteExpiryDate), dateFromEpochMs(s.acceptanceExpiryDate)]) {
      if (expiry !== null && expiry.getTime() <= now) return false;
    }
    return true;
  }

  function mapSummary(s: Summary, merchantRef: string): ProviderPayout {
    const rawState = s.status.toUpperCase();
    const tx = s.transactions?.find((t) => t.hash) ?? s.transactions?.[0];
    const base = {
      providerPayoutId: s.uuid,
      merchantRef,
      rawState,
      occurredAt: dateFromEpochMs(tx?.dateConfirmed) ?? dateFromEpochMs(s.dateCreated) ?? deps.now(),
      ...(s.paidCurrency?.amount ? { payoutAmount: plainDecimal(s.paidCurrency.amount) ?? undefined } : {}),
      ...(s.exchangeRate?.rate ? { rate: plainDecimal(s.exchangeRate.rate) ?? undefined } : {}),
      ...(tx?.hash ? { txHash: tx.hash } : {}),
    };
    switch (rawState) {
      case "COMPLETE":
        return { ...base, state: "SUCCEEDED", final: true };
      case "CANCELLED":
      case "EXPIRED":
        // Funds stay in the merchant wallet.
        return { ...base, state: "FAILED", final: true, failureCode: rawState };
      case "PENDING":
        // Created; confirmed or not, nothing is final until BVNK says so.
        return { ...base, state: "ACCEPTED", final: false };
      default:
        // PROCESSING, IN_PROGRESS, an on-hold state outside the enum: still moving.
        return { ...base, state: "PROCESSING", final: false };
    }
  }

  /** The answer belongs to this payout: our reference, outgoing, the amount we asked for. */
  function matchesPayout(s: Summary, idempotencyKey: string, amountMinor: bigint | null): boolean {
    if (s.reference !== idempotencyKey) return false;
    if (s.type && s.type.toUpperCase() !== "OUT") return false;
    if (amountMinor !== null && s.walletCurrency?.amount) {
      const asked = decimalToMinor(s.walletCurrency.amount, EUR_DECIMALS, "exact");
      if (asked && asked.minor !== amountMinor) return false;
    }
    return true;
  }

  async function findByReference(reference: string): Promise<ProviderResult<Summary | null>> {
    const query = new URLSearchParams({ walletId: config.walletIdEur, reference });
    const answer = await call("GET", `/api/v1/pay/summary?${query.toString()}`);
    if (answer.kind === "uncertain") return answer;
    if (answer.kind === "error") return answer.status === 404 ? { kind: "ok", value: null } : refusal(answer, "BVNK_LOOKUP_FAILED");
    const parsed = z.array(summarySchema).max(100).safeParse(answer.body);
    if (!parsed.success) return { kind: "uncertain", reason: "malformed" };
    const matches = parsed.data.filter((s) => s.reference === reference);
    if (matches.length > 1) {
      log("error", { reference, count: matches.length, alert: "BVNK_DUPLICATE_REFERENCE" }, "several BVNK payments share one reference");
      return { kind: "uncertain", reason: "malformed" };
    }
    return { kind: "ok", value: matches[0] ?? null };
  }

  async function getSummary(uuid: string): Promise<ProviderResult<Summary | null>> {
    if (!SAFE_ID.test(uuid)) return { kind: "ok", value: null };
    const answer = await call("GET", `/api/v1/pay/${encodeURIComponent(uuid)}/summary`);
    if (answer.kind === "uncertain") return answer;
    if (answer.kind === "error") return answer.status === 404 ? { kind: "ok", value: null } : refusal(answer, "BVNK_LOOKUP_FAILED");
    const parsed = summarySchema.safeParse(answer.body);
    return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "uncertain", reason: "malformed" };
  }

  /** The per-player, per-asset channel reference: opaque, stable, 36 characters. */
  async function channelReference(customerRef: string, payAsset: string): Promise<string> {
    return `cha_${(await sha256HexOf(`${CHANNEL_NAMESPACE}|${config.walletIdEur}|${customerRef}|${payAsset}`)).slice(0, 32)}`;
  }

  /** The player's open channel for this reference and pay currency (the oldest when a race made two). */
  async function findChannel(reference: string, payCurrency: string): Promise<ProviderResult<Channel | null>> {
    const query = new URLSearchParams({ walletId: config.walletIdEur, q: reference, offset: "0", max: "50" });
    const answer = await call("GET", `/api/v2/channel?${query.toString()}`);
    if (answer.kind === "uncertain") return answer;
    if (answer.kind === "error") return answer.status === 404 ? { kind: "ok", value: null } : refusal(answer, "BVNK_LOOKUP_FAILED");
    const parsed = z.array(channelSchema).max(50).safeParse(answer.body);
    if (!parsed.success) return { kind: "uncertain", reason: "malformed" };
    const created = (c: Channel) => dateFromEpochMs(c.dateCreated)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const matches = parsed.data
      .filter((c) => c.reference === reference && (c.payCurrency ?? "").toUpperCase() === payCurrency.toUpperCase() && (!c.status || c.status.toUpperCase() === "OPEN"))
      .sort((a, b) => created(a) - created(b));
    if (matches.length > 1) log("warn", { count: matches.length, alert: "BVNK_DUPLICATE_CHANNEL" }, "several open channels share one player reference; the oldest is used");
    return { kind: "ok", value: matches[0] ?? null };
  }

  function cryptoDestination(destination: PayoutDestination): { payCurrency: string; network: string; address: string; tag: string | null } | null {
    if (destination.kind !== "CRYPTO_ADDRESS") return null;
    const mapped = assetFor(destination.asset);
    if (!mapped) return null;
    return { payCurrency: mapped.payCurrency, network: mapped.network, address: destination.address, tag: destination.memo };
  }

  function payoutDetails(d: { payCurrency: string; network: string; address: string; tag: string | null }) {
    return { code: "crypto", currency: d.payCurrency, network: d.network, address: d.address, ...(d.tag ? { tag: d.tag } : {}) };
  }

  /** Confirms a created two-step payout and returns its state. */
  async function confirm(s: Summary, input: PayoutInput): Promise<ProviderResult<ProviderPayout>> {
    const answer = await call("PUT", `/api/v1/pay/${encodeURIComponent(s.uuid)}/confirm/summary`);
    if (answer.kind === "uncertain") return answer;
    if (answer.kind === "ok") {
      const parsed = summarySchema.safeParse(answer.body);
      if (parsed.success && matchesPayout(parsed.data, input.idempotencyKey, input.amountMinor)) return { kind: "ok", value: mapSummary(parsed.data, input.idempotencyKey) };
    }
    // A refused or unreadable confirmation (expired quote, already confirmed): read the payout again.
    const reread = await getSummary(s.uuid);
    if (reread.kind !== "ok") return reread.kind === "rejected" ? { kind: "uncertain", reason: "malformed" } : reread;
    if (!reread.value || !matchesPayout(reread.value, input.idempotencyKey, input.amountMinor)) return { kind: "uncertain", reason: "malformed" };
    const payout = mapSummary(reread.value, input.idempotencyKey);
    // Still unconfirmed after a refused confirm: unknown, never "failed" (the hold must stay).
    if (payout.state === "ACCEPTED") return { kind: "uncertain", reason: "malformed" };
    return { kind: "ok", value: payout };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  async function signatureMatches(rawBody: Uint8Array, header: string | null): Promise<boolean> {
    const given = header ? base64ToBytes(header.trim()) : null;
    if (!given || given.length !== 32) return false;
    let match = false;
    for (const secret of [config.webhookSecret, config.webhookSecretPrevious]) {
      if (!secret) continue;
      // Both secrets are always computed, so timing does not reveal which one matched.
      if (equalBytes(await hmac("SHA-256", secret, rawBody), given)) match = true;
    }
    return match;
  }

  function eventsOf(envelope: z.infer<typeof envelopeSchema>): NormalizedEvent[] | null {
    const common = { providerEventId: envelope.eventId, eventType: envelope.event };
    const payload = redactWith(REDACT_KEYS, envelope);
    switch (envelope.event) {
      case "bvnk:payment:channel:transaction-detected":
      case "bvnk:payment:channel:transaction-confirmed":
      case "bvnk:payment:channel:transaction-on-hold": {
        const data = channelPaymentSchema.safeParse(envelope.data);
        if (!data.success) return null;
        return [{ ...common, objectType: "PAYMENT", objectRef: data.data.uuid, merchantRef: null, payload, payment: mapChannelPayment(data.data) }];
      }
      case "bvnk:payment:crypto:status-change":
      case "bvnk:payment:crypto:transaction-on-hold": {
        const data = summarySchema.safeParse(envelope.data);
        if (!data.success) return null;
        // Pay-ins through payment links are not used (channels are): ignored.
        if ((data.data.type ?? "").toUpperCase() !== "OUT" || !data.data.reference) return [];
        const reference = data.data.reference;
        return [{
          ...common,
          objectType: reference.startsWith("rf_") ? "REFUND" : "PAYOUT",
          objectRef: data.data.uuid,
          merchantRef: reference,
          payload,
          payout: mapSummary(data.data, reference),
        }];
      }
      case "bvnk:compliance:v1:information-request": {
        const data = infoRequestSchema.safeParse(envelope.data);
        if (!data.success) return null;
        const related = data.data.relatedPayment?.id ?? null;
        return [{ ...common, objectType: "PAYMENT", objectRef: related, merchantRef: null, payload, informationRequest: { externalId: data.data.id, providerPaymentId: related } }];
      }
      default:
        // Other BVNK events (ledger reports, wallets, customers) carry nothing we apply.
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // The provider
  // -------------------------------------------------------------------------

  return {
    kind: "bvnk",
    method: "CRYPTO",
    key,
    sandbox: mode === "sandbox",
    settlementAsset,
    authoritativeWebhooks: false,
    // Our key is the unique payout reference; a duplicate is found again by reference.
    dedupesOnOurKey: true,
    // BVNK's hosted top-up page (redirectUrl in a channel answer); its exact host is UNVERIFIED, its domain is not.
    redirectHosts: [".bvnk.com"],

    async createDepositSession(input: CryptoDepositSessionInput): Promise<ProviderResult<CryptoDepositSession>> {
      const mapped = assetFor(input.payAsset);
      if (!mapped) return { kind: "rejected", final: true, code: "ASSET_UNSUPPORTED", message: `no BVNK_ASSET_MAP entry for ${input.payAsset}` };
      const customerRef = input.customer.providerCustomerRef;
      if (!customerRef || customerRef.length > 255) return { kind: "rejected", final: true, code: "BAD_CUSTOMER_REF", message: "customerId is 1-255 characters" };
      const reference = await channelReference(customerRef, input.payAsset);
      const existing = await findChannel(reference, mapped.payCurrency);
      if (existing.kind !== "ok") return existing;
      let channel = existing.value;
      if (!channel) {
        const answer = await call("POST", "/api/v2/channel", {
          walletId: config.walletIdEur,
          payCurrency: mapped.payCurrency,
          displayCurrency: WIRE_CURRENCY,
          // Shown to the player as the channel title; opaque.
          reference,
          customerId: customerRef,
          // UNVERIFIED: the channel request schema has no network field, yet
          // "you specify the network when creating payment channels". Sent, and
          // the network in the answer is checked below.
          network: mapped.network,
          complianceDetails: complianceDetails(input.originator, input.customer.ip),
        }, reference);
        if (answer.kind === "uncertain") return answer;
        if (answer.kind === "error") {
          // An earlier attempt may have created it (a repeated idempotency key is a 400): look once more.
          const again = answer.status === 401 || answer.status === 403 || answer.status === 429 ? null : await findChannel(reference, mapped.payCurrency);
          if (again && again.kind === "uncertain") return again;
          if (!again || again.kind !== "ok" || !again.value) return refusal(answer, "BVNK_CHANNEL_REFUSED");
          channel = again.value;
        } else {
          const parsed = channelSchema.safeParse(answer.body);
          if (!parsed.success) return { kind: "uncertain", reason: "malformed" };
          channel = parsed.data;
        }
      }
      const c = channel;
      if (c.reference && c.reference !== reference) {
        log("error", { channelId: c.uuid, alert: "BVNK_CHANNEL_REFERENCE" }, "channel answer carries another reference");
        return { kind: "uncertain", reason: "malformed" };
      }
      if (c.walletCurrency && c.walletCurrency.toUpperCase() !== WIRE_CURRENCY) {
        log("error", { channelId: c.uuid, walletCurrency: c.walletCurrency, alert: "BVNK_CHANNEL_WALLET" }, "channel settles into a non-EUR wallet");
        return { kind: "rejected", final: true, code: "WALLET_MISMATCH", message: "the channel does not settle in EUR" };
      }
      const network = c.network ?? c.protocol ?? null;
      if (network !== null && network.toUpperCase() !== mapped.network.toUpperCase()) {
        // Never show an address on a chain other than the one the player chose.
        log("error", { channelId: c.uuid, network, expected: mapped.network, alert: "BVNK_CHANNEL_NETWORK" }, "channel network differs from BVNK_ASSET_MAP");
        return { kind: "rejected", final: true, code: "NETWORK_MISMATCH", message: "BVNK opened the channel on another network" };
      }
      return {
        kind: "ok",
        value: {
          type: "CRYPTO_INVOICE",
          providerPaymentId: c.uuid,
          reusableAddress: true,
          asset: input.payAsset,
          network: mapped.network,
          address: c.address,
          memo: c.tag ?? null,
          // A channel takes any amount; BVNK converts what arrives.
          payAmount: null,
          expiresAt: null,
          // Confirmation counts are BVNK's policy (UNVERIFIED); credit happens on COMPLETE only.
          minConfirmations: 0,
          hostedUrl: c.redirectUrl ?? null,
        },
      };
    },

    async getPayment(ref): Promise<ProviderResult<ProviderPayment | null>> {
      if (ref.providerPaymentId) {
        if (!SAFE_ID.test(ref.providerPaymentId)) return { kind: "ok", value: null };
        const answer = await call("GET", `/api/v2/channel/payment/${encodeURIComponent(ref.providerPaymentId)}`);
        if (answer.kind === "uncertain") return answer;
        if (answer.kind === "error") return answer.status === 404 ? { kind: "ok", value: null } : refusal(answer, "BVNK_LOOKUP_FAILED");
        const parsed = channelPaymentSchema.safeParse(answer.body);
        if (!parsed.success) return { kind: "uncertain", reason: "malformed" };
        return { kind: "ok", value: mapChannelPayment(parsed.data) };
      }
      // A deposit id alone finds nothing: channel payments name no deposit
      // (the channel belongs to the player, not to one session). A deposit
      // with no payment is therefore "not found" and expires; a payment that
      // still arrives is matched by its address (and reviewed when late).
      return { kind: "ok", value: null };
    },

    async quotePayout(input): Promise<ProviderResult<PayoutQuote>> {
      const destination = cryptoDestination(input.destination);
      if (!destination) return { kind: "rejected", final: true, code: "DESTINATION_UNSUPPORTED", message: "BVNK pays out only to a mapped crypto asset" };
      if (input.amountMinor < PAYOUT_MIN_MINOR) return { kind: "rejected", final: true, code: "BELOW_PROVIDER_MINIMUM", message: "BVNK's payout minimum is 5 EUR" };
      // BVNK's dry run and estimate both require the beneficiary's
      // travel-rule details, which this call does not carry: the network
      // fee and rate are BVNK's at dispatch, the player is debited the EUR
      // amount only (the network fee is billed to the merchant wallet).
      return { kind: "ok", value: { feeMinor: 0n, receiveEstimate: null, rate: null, expiresAt: new Date(deps.now().getTime() + QUOTE_TTL_MS) } };
    },

    async createPayout(input: PayoutInput): Promise<ProviderResult<ProviderPayout>> {
      const destination = cryptoDestination(input.destination);
      if (!destination) return { kind: "rejected", final: true, code: "DESTINATION_UNSUPPORTED", message: "BVNK pays out only to a mapped crypto asset" };
      if (input.amountMinor < PAYOUT_MIN_MINOR) return { kind: "rejected", final: true, code: "BELOW_PROVIDER_MINIMUM", message: "BVNK's payout minimum is 5 EUR" };
      if (input.idempotencyKey.length < 6 || input.idempotencyKey.length > 255) return { kind: "rejected", final: true, code: "BAD_REFERENCE", message: "payout reference must be 6-255 characters" };
      const answer = await call("POST", "/api/v1/pay/summary", {
        walletId: config.walletIdEur,
        type: "OUT",
        amount: new JsonNumber(formatMinor(input.amountMinor, EUR_DECIMALS)),
        currency: WIRE_CURRENCY,
        reference: input.idempotencyKey,
        customerId: input.customer.providerCustomerRef,
        twoStep: true,
        payOutDetails: payoutDetails(destination),
        complianceDetails: complianceDetails(input.beneficiary, input.customer.ip),
      }, input.idempotencyKey);
      if (answer.kind === "uncertain") return answer;
      let summary: Summary;
      if (answer.kind === "ok") {
        const parsed = summarySchema.safeParse(answer.body);
        if (!parsed.success) return { kind: "uncertain", reason: "malformed" };
        summary = parsed.data;
      } else {
        // Not authenticated or throttled: nothing was created.
        if (answer.status === 401 || answer.status === 403 || answer.status === 429) return refusal(answer, "BVNK_PAYOUT_REFUSED");
        // Any other refusal may answer a repeat of an earlier attempt
        // ("Duplicate Reference", a repeated idempotency key): our payout is
        // looked for before the refusal is believed.
        const found = await findByReference(input.idempotencyKey);
        if (found.kind === "uncertain") return found;
        if (found.kind === "rejected") return { kind: "uncertain", reason: "malformed" };
        if (!found.value) {
          const errors = errorsOf(answer.body);
          const duplicate = errors.some((e) => (e.code === "unique" && e.parameter === "reference") || /duplicate reference|already exists/i.test(e.message));
          // It exists, yet the lookup cannot see it yet: unknown, never refused.
          if (duplicate) return { kind: "uncertain", reason: "malformed" };
          if (errors.some((e) => e.code === "MER-PAY-2012")) {
            log("error", { withdrawalId: input.withdrawalId, alert: "BVNK_INSUFFICIENT_FUNDS" }, "BVNK merchant wallet cannot fund the payout");
            return { kind: "rejected", final: false, code: "PROVIDER_INSUFFICIENT_FUNDS", message: "the merchant wallet at BVNK is short of funds" };
          }
          if (errors.some((e) => e.code === "invalidPayout")) return { kind: "rejected", final: true, code: "DESTINATION_INVALID", message: "BVNK refused the payout instruction" };
          return refusal(answer, "BVNK_PAYOUT_REFUSED");
        }
        summary = found.value;
      }
      if (!matchesPayout(summary, input.idempotencyKey, input.amountMinor)) {
        log("error", { withdrawalId: input.withdrawalId, payoutId: summary.uuid, alert: "BVNK_PAYOUT_MISMATCH" }, "BVNK payout does not match the withdrawal");
        return { kind: "uncertain", reason: "malformed" };
      }
      if (confirmable(summary)) return confirm(summary, input);
      return { kind: "ok", value: mapSummary(summary, input.idempotencyKey) };
    },

    async getPayout(ref): Promise<ProviderResult<ProviderPayout | null>> {
      const found = ref.providerPayoutId ? await getSummary(ref.providerPayoutId) : await findByReference(ref.idempotencyKey);
      if (found.kind !== "ok") return found;
      if (!found.value) return { kind: "ok", value: null };
      if (!matchesPayout(found.value, ref.idempotencyKey, null)) {
        log("error", { payoutId: found.value.uuid, alert: "BVNK_PAYOUT_MISMATCH" }, "BVNK payout reference differs from our key");
        return { kind: "uncertain", reason: "malformed" };
      }
      if (confirmable(found.value)) {
        // Created but (as far as BVNK shows) never confirmed: no money moves
        // and the quote lapses within the hour. Reported as not found so the
        // dispatcher dispatches again with the same key, which finds it
        // (Duplicate Reference) and confirms it.
        log("info", { payoutId: found.value.uuid }, "unconfirmed two-step payout reported as not found for resumption");
        return { kind: "ok", value: null };
      }
      return { kind: "ok", value: mapSummary(found.value, ref.idempotencyKey) };
    },

    async validateAddress(input): Promise<ProviderResult<{ valid: boolean; code?: string }>> {
      const mapped = assetFor(input.asset);
      if (!mapped) return { kind: "ok", value: { valid: false, code: "ASSET_UNSUPPORTED" } };
      const answer = await call("PUT", "/api/v1/pay/validate", payoutDetails({ payCurrency: mapped.payCurrency, network: mapped.network, address: input.address, tag: input.memo }));
      if (answer.kind === "uncertain") return answer;
      if (answer.kind === "ok") return { kind: "ok", value: { valid: true } };
      if (answer.status === 400) return { kind: "ok", value: { valid: false, code: errorsOf(answer.body)[0]?.code || "ADDRESS_INVALID" } };
      return refusal(answer, "BVNK_VALIDATE_FAILED");
    },

    async answerInformationRequest(externalId: string, p: TravelRuleParty): Promise<ProviderResult<null>> {
      if (!/^[0-9a-fA-F-]{36}$/.test(externalId)) return { kind: "rejected", final: true, code: "BAD_REFERENCE", message: "information request ids are UUIDs" };
      // InformationRequestIndividualEntity requires a postal address; our KYC data has none yet,
      // so the core raises TRAVEL_RULE_UNANSWERED and a person answers.
      const parsedAddress = z.object({
        addressLine1: text(200).min(1),
        addressLine2: text(200).optional(),
        city: text(100).min(1),
        region: text(100).optional(),
        postCode: text(20).min(1),
        country: z.string().regex(/^[A-Z]{2}$/),
      }).safeParse(p.address);
      if (!parsedAddress.success) return { kind: "rejected", final: false, code: "ADDRESS_REQUIRED", message: "BVNK needs the originator's postal address" };
      const dob = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(p.dateOfBirth);
      if (!dob) return { kind: "rejected", final: true, code: "BAD_DATE_OF_BIRTH", message: "dateOfBirth must be YYYY-MM-DD" };
      const answer = await call("POST", `/compliance/v1/information-requests/${encodeURIComponent(externalId)}/actions`, {
        type: "PROVIDE_INFORMATION",
        entity: {
          type: "INDIVIDUAL",
          contactId: null,
          customerId: null,
          // "Your external identifier for this individual contact"; BVNK's example reuses the request id.
          externalId,
          firstName: clip(p.firstName, 100),
          lastName: clip(p.lastName, 100),
          // This endpoint documents dd-MM-yyyy.
          dateOfBirth: `${dob[3]}-${dob[2]}-${dob[1]}`,
          relationshipType: p.relationship,
          address: parsedAddress.data,
        },
      });
      if (answer.kind === "uncertain") return answer;
      if (answer.kind === "error") return answer.status === 404 ? { kind: "rejected", final: true, code: "NOT_FOUND", message: "no such information request" } : refusal(answer, "BVNK_INFO_REFUSED");
      return { kind: "ok", value: null };
    },

    async verifyWebhook(request: WebhookRequest): Promise<WebhookVerification> {
      if (request.method.toUpperCase() !== "POST") return { ok: false, reason: "format" };
      if (!(await signatureMatches(request.rawBody, request.headers.get("x-signature")))) return { ok: false, reason: "signature" };
      const body = decodeUtf8(request.rawBody);
      const parsed = body === null ? undefined : parseOrUndefined(body);
      const envelope = envelopeSchema.safeParse(parsed);
      if (!envelope.success) return { ok: false, reason: "format" };
      const events = eventsOf(envelope.data);
      if (events === null) return { ok: false, reason: "format" };
      return { ok: true, scheme: "bvnk-x-signature-v2-base64", events };
    },

    redact(payload: unknown): Record<string, unknown> {
      return redactWith(REDACT_KEYS, payload);
    },
  };
}

function parseOrUndefined(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return parseJsonLossless(text);
  } catch {
    return undefined;
  }
}
