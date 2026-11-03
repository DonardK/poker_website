/**
 * The built-in sandbox provider (design-payments section 12): a card
 * acquirer, a crypto provider and a KYC provider that move TEST_EUR only (the
 * database refuses a sandbox key on any other asset). It exists for CI,
 * development and the preview deployment; the config refuses it in live mode
 * and PAYMENTS_MODE=sandbox in production.
 *
 * It behaves like a real provider on purpose, so the core is exercised
 * unchanged:
 * - its state lives outside the payments database (the SandboxPsp Durable
 *   Object; an in-memory store in tests);
 * - webhooks carry ids only, signed `X-Sandbox-Signature: t=<unix>,v1=<hex>`
 *   (HMAC-SHA256 of `t.rawBody` under SANDBOX_WEBHOOK_SECRET, 300 s
 *   tolerance), and the core re-reads the object before applying it;
 * - payouts are idempotent on our key, and the cents of the payout amount
 *   pick a fault scenario (PAYOUT_SCENARIOS) so the uncertain and re-dispatch
 *   paths can be tried by hand in preview.
 * There is never a card number: the hosted page offers outcome buttons only.
 */
import { formatMinor } from "../../money/amounts";
import { b64urlEncode, bytesEqual, hmacSha256, randomBytes, sha256Hex, toHex, utf8 } from "../../auth/bytes";
import type {
  CardDepositSession,
  CardDepositSessionInput,
  CardFacts,
  CardProvider,
  CryptoDepositSession,
  CryptoDepositSessionInput,
  CryptoProvider,
  KycProvider,
  KycSession,
  KycSessionInput,
  KycUpdate,
  NormalizedEvent,
  PaymentState,
  PayoutInput,
  PayoutQuote,
  ProviderDispute,
  ProviderPayment,
  ProviderPayout,
  ProviderResult,
  ReviewReason,
  WebhookRequest,
  WebhookVerification,
} from "./types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** What the sandbox remembers (JSON values only: amounts are decimal strings of minor units). */
export interface SandboxStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  /** Stores `value` unless the key exists; returns what is stored afterwards. */
  putIfAbsent<T>(key: string, value: T): Promise<T>;
  /** Adds one and returns the new count (test counters such as payout creations). */
  increment(key: string): Promise<number>;
}

/** An in-memory store for tests and the SandboxPsp object's own cache. */
export function memorySandboxStore(): SandboxStore & { dump(): Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    async get<T>(key: string) { return map.has(key) ? clone(map.get(key) as T) : null; },
    async put<T>(key: string, value: T) { map.set(key, clone(value)); },
    async putIfAbsent<T>(key: string, value: T) {
      if (!map.has(key)) map.set(key, clone(value));
      return clone(map.get(key) as T);
    },
    async increment(key: string) {
      const next = Number(map.get(key) ?? 0) + 1;
      map.set(key, next);
      return next;
    },
    dump: () => map,
  };
}

export interface SandboxPaymentRecord {
  id: string;
  depositId: string;
  method: "CARD" | "CRYPTO";
  channelRef: string;
  amountMinor: string;
  state: PaymentState;
  creditMinor: string | null;
  reviewReason: ReviewReason | null;
  card: CardFacts | null;
  crypto: { asset: string; network: string; address: string; amount: string | null; txHash: string | null; confirmations: number | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxDisputeRecord {
  id: string;
  paymentId: string;
  kind: ProviderDispute["kind"];
  amountMinor: string;
  recovers: string | null;
  createdAt: string;
}

export interface SandboxPayoutRecord {
  id: string;
  key: string;
  scenario: PayoutScenario;
  amountMinor: string;
  feeMinor: string;
  createdAt: string;
}

export interface SandboxApplicantRecord {
  applicantRef: string;
  userId: string;
  decision: KycUpdate["decision"];
  identity: { firstName: string; lastName: string; birthDate: string; country: string } | null;
  screening: "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";
  rejectReason: string | null;
  updatedAt: string;
}

/** Payout behaviour by the cents of the amount (design-payments section 12). */
export type PayoutScenario = "PAID" | "DECLINE" | "TIMEOUT_EXECUTED" | "TIMEOUT_LOST" | "HELD_THEN_PAID" | "PAID_THEN_RETURNED" | "INELIGIBLE";

export const PAYOUT_SCENARIOS: Readonly<Record<string, PayoutScenario>> = Object.freeze({
  "01": "DECLINE",
  "02": "TIMEOUT_EXECUTED",
  "03": "TIMEOUT_LOST",
  "04": "HELD_THEN_PAID",
  "05": "PAID_THEN_RETURNED",
  "06": "INELIGIBLE",
});

/** How long HELD_THEN_PAID stays PROCESSING and PAID_THEN_RETURNED stays paid. */
export const SANDBOX_PAYOUT_DELAY_MS = 60_000;
/** Flat network fee of a sandbox crypto payout. */
export const SANDBOX_CRYPTO_FEE_MINOR = 150n;

export function payoutScenario(amountMinor: bigint): PayoutScenario {
  const cents = (amountMinor % 100n).toString().padStart(2, "0");
  return PAYOUT_SCENARIOS[cents] ?? "PAID";
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export const SANDBOX_SIGNATURE_HEADER = "x-sandbox-signature";
const TOLERANCE_S = 300;

export async function signSandboxBody(secret: string, rawBody: string, at: Date): Promise<string> {
  const t = Math.floor(at.getTime() / 1000);
  const mac = toHex(await hmacSha256(utf8(secret), `${t}.${rawBody}`));
  return `t=${t},v1=${mac}`;
}

async function signatureValid(secret: string, header: string | null, rawBody: Uint8Array, now: Date): Promise<"ok" | "signature" | "timestamp"> {
  if (!header || header.length > 1024) return "signature";
  let t: number | null = null;
  const macs: string[] = [];
  for (const part of header.split(",")) {
    const [name, value] = part.trim().split("=", 2) as [string, string | undefined];
    if (name === "t" && value && /^\d{1,12}$/.test(value)) t = Number(value);
    if (name === "v1" && value && /^[0-9a-f]{64}$/.test(value)) macs.push(value);
  }
  if (t === null || macs.length === 0) return "signature";
  const body = new Uint8Array(utf8(`${t}.`).byteLength + rawBody.byteLength);
  body.set(utf8(`${t}.`), 0);
  body.set(rawBody, utf8(`${t}.`).byteLength);
  const expected = await hmacSha256(utf8(secret), body);
  const match = macs.some((mac) => bytesEqual(expected, hexBytes(mac)));
  if (!match) return "signature";
  if (Math.abs(now.getTime() / 1000 - t) > TOLERANCE_S) return "timestamp";
  return "ok";
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Short signed links to the sandbox pages (the page needs no session: whoever has the link may click its buttons). */
export async function sandboxLinkSig(secret: string, subject: string): Promise<string> {
  return b64urlEncode(await hmacSha256(utf8(secret), `sandbox-link:${subject}`)).slice(0, 32);
}

export async function sandboxLinkValid(secret: string, subject: string, sig: string | null): Promise<boolean> {
  if (!sig || sig.length !== 32) return false;
  return bytesEqual(utf8(await sandboxLinkSig(secret, subject)), utf8(sig));
}

export interface SandboxEnvelope {
  eventId: string;
  type: string;
  createdAt: string;
  data: { objectType: "PAYMENT" | "PAYOUT" | "DISPUTE" | "KYC"; id: string };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface SandboxOptions {
  store: SandboxStore;
  webhookSecret: string;
  /** This Worker's public origin (the pay and verification pages); null hides the links. */
  publicOrigin: string | null;
  now: () => Date;
}

const id = (prefix: string) => `${prefix}_${toHex(randomBytes(12))}`;

function paymentOf(record: SandboxPaymentRecord): ProviderPayment {
  return {
    providerPaymentId: record.id,
    merchantRef: record.depositId,
    channelRef: record.channelRef,
    state: record.state,
    rawState: record.state.toLowerCase(),
    creditMinor: record.creditMinor === null ? null : BigInt(record.creditMinor),
    feeMinor: 0n,
    ...(record.card ? { card: record.card } : {}),
    ...(record.crypto
      ? { crypto: { asset: record.crypto.asset, network: record.crypto.network, amount: record.crypto.amount ?? "0", txHash: record.crypto.txHash, confirmations: record.crypto.confirmations, address: record.crypto.address, memo: null, sources: [] } }
      : {}),
    ...(record.reviewReason ? { reviewReason: record.reviewReason } : {}),
    occurredAt: new Date(record.updatedAt),
  };
}

function payoutOf(record: SandboxPayoutRecord, now: Date): ProviderPayout {
  const age = now.getTime() - new Date(record.createdAt).getTime();
  const base = { providerPayoutId: record.id, merchantRef: record.key, occurredAt: new Date(record.createdAt) };
  if (record.scenario === "HELD_THEN_PAID" && age < SANDBOX_PAYOUT_DELAY_MS) return { ...base, state: "PROCESSING", final: false, rawState: "held" };
  if (record.scenario === "PAID_THEN_RETURNED" && age >= SANDBOX_PAYOUT_DELAY_MS) {
    return { ...base, state: "RETURNED", final: true, rawState: "returned", returnedMinor: BigInt(record.amountMinor) - BigInt(record.feeMinor) };
  }
  return { ...base, state: "SUCCEEDED", final: true, rawState: "paid", payoutAmount: formatMinor(BigInt(record.amountMinor) - BigInt(record.feeMinor), 2) };
}

const KEEP = new Set(["eventId", "type", "createdAt", "data", "objectType", "id"]);

function redactEnvelope(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!KEEP.has(key)) continue;
    out[key] = value && typeof value === "object" ? redactEnvelope(value) : value;
  }
  return out;
}

async function parseEnvelope(secret: string, request: WebhookRequest): Promise<SandboxEnvelope | { error: "signature" | "timestamp" | "format" }> {
  const check = await signatureValid(secret, request.headers.get(SANDBOX_SIGNATURE_HEADER), request.rawBody, request.receivedAt);
  if (check !== "ok") return { error: check };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(request.rawBody)) as SandboxEnvelope;
    if (typeof parsed?.eventId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(parsed.eventId) || typeof parsed.type !== "string"
        || !parsed.data || typeof parsed.data.id !== "string" || !["PAYMENT", "PAYOUT", "DISPUTE", "KYC"].includes(parsed.data.objectType)) {
      return { error: "format" };
    }
    return parsed;
  } catch {
    return { error: "format" };
  }
}

/** Money events: the object is read from the store (ids only on the wire). */
async function moneyEvents(opts: SandboxOptions, envelope: SandboxEnvelope): Promise<NormalizedEvent[] | null> {
  const common = { providerEventId: envelope.eventId, eventType: envelope.type.slice(0, 100), payload: redactEnvelope(envelope) };
  if (envelope.data.objectType === "PAYMENT") {
    const record = await opts.store.get<SandboxPaymentRecord>(`pay:${envelope.data.id}`);
    if (!record) return null;
    return [{ ...common, objectType: "PAYMENT", objectRef: record.id, merchantRef: record.depositId, payment: paymentOf(record) }];
  }
  if (envelope.data.objectType === "DISPUTE") {
    const record = await opts.store.get<SandboxDisputeRecord>(`dsp:${envelope.data.id}`);
    if (!record) return null;
    const dispute: ProviderDispute = {
      providerReversalId: record.id, providerPaymentId: record.paymentId, kind: record.kind, amountMinor: BigInt(record.amountMinor),
      ...(record.recovers ? { recoversProviderReversalId: record.recovers } : {}), occurredAt: new Date(record.createdAt),
    };
    return [{ ...common, objectType: "DISPUTE", objectRef: record.paymentId, merchantRef: null, dispute }];
  }
  if (envelope.data.objectType === "PAYOUT") {
    const record = await opts.store.get<SandboxPayoutRecord>(`po:${envelope.data.id}`);
    if (!record) return null;
    return [{ ...common, objectType: "PAYOUT", objectRef: record.id, merchantRef: record.key, payout: payoutOf(record, opts.now()) }];
  }
  return null;
}

function moneyBase(opts: SandboxOptions, rail: "card" | "crypto") {
  const key = `sandbox-${rail}`;
  return {
    key,
    sandbox: true as const,
    settlementAsset: "TEST_EUR" as const,
    authoritativeWebhooks: false,
    dedupesOnOurKey: true,
    // Its pages live on the payments Worker (PAYMENTS_PUBLIC_ORIGIN).
    redirectHosts: opts.publicOrigin ? [new URL(opts.publicOrigin).hostname] : [],
    async verifyWebhook(request: WebhookRequest): Promise<WebhookVerification> {
      const envelope = await parseEnvelope(opts.webhookSecret, request);
      if ("error" in envelope) return { ok: false, reason: envelope.error };
      const events = await moneyEvents(opts, envelope);
      if (!events) return { ok: false, reason: "format" };
      return { ok: true, scheme: "sandbox-v1", events };
    },
    redact: redactEnvelope,
    async getPayment(ref: { providerPaymentId?: string; merchantRef?: string }): Promise<ProviderResult<ProviderPayment | null>> {
      let paymentId = ref.providerPaymentId ?? null;
      if (!paymentId && ref.merchantRef) paymentId = await opts.store.get<string>(`dep:${ref.merchantRef}`);
      const record = paymentId ? await opts.store.get<SandboxPaymentRecord>(`pay:${paymentId}`) : null;
      return { kind: "ok", value: record && record.method === (rail === "card" ? "CARD" : "CRYPTO") ? paymentOf(record) : null };
    },
    async quotePayout(input: { amountMinor: bigint }): Promise<ProviderResult<PayoutQuote>> {
      const feeMinor = rail === "crypto" ? SANDBOX_CRYPTO_FEE_MINOR : 0n;
      if (input.amountMinor <= feeMinor) return { kind: "rejected", final: true, code: "AMOUNT_TOO_SMALL", message: "The amount does not cover the fee." };
      return { kind: "ok", value: { feeMinor, receiveEstimate: rail === "crypto" ? formatMinor(input.amountMinor - feeMinor, 2) : null, rate: rail === "crypto" ? "1" : null, expiresAt: new Date(opts.now().getTime() + 120_000) } };
    },
    async createPayout(input: PayoutInput): Promise<ProviderResult<ProviderPayout>> {
      const now = opts.now();
      await opts.store.increment(`count:create:${input.idempotencyKey}`);
      const existing = await opts.store.get<SandboxPayoutRecord>(`po:${input.idempotencyKey}`);
      if (existing) {
        await opts.store.increment(`count:dedupe:${input.idempotencyKey}`);
        return { kind: "ok", value: payoutOf(existing, now) };
      }
      const scenario = payoutScenario(input.amountMinor);
      if (scenario === "DECLINE") return { kind: "rejected", final: true, code: "DECLINED", message: "The payout was declined." };
      if (scenario === "INELIGIBLE") return { kind: "rejected", final: true, code: "REFUND_LIMIT", message: "This destination cannot receive the payout.", methodIneligible: true };
      // TIMEOUT_LOST: the request "never arrived". A later create with the same key succeeds normally.
      const lostOnce = scenario === "TIMEOUT_LOST" && (await opts.store.increment(`count:lost:${input.idempotencyKey}`)) === 1;
      if (lostOnce) return { kind: "uncertain", reason: "timeout" };
      const record: SandboxPayoutRecord = {
        id: id("sbx_po"), key: input.idempotencyKey, scenario: scenario === "TIMEOUT_LOST" ? "PAID" : scenario, amountMinor: input.amountMinor.toString(),
        feeMinor: input.feeMinor.toString(), createdAt: now.toISOString(),
      };
      const stored = await opts.store.putIfAbsent(`po:${input.idempotencyKey}`, record);
      await opts.store.put(`po:${stored.id}`, stored);
      if (scenario === "TIMEOUT_EXECUTED") return { kind: "uncertain", reason: "timeout" };
      return { kind: "ok", value: payoutOf(stored, now) };
    },
    async getPayout(ref: { idempotencyKey: string; providerPayoutId?: string | null }): Promise<ProviderResult<ProviderPayout | null>> {
      const record = await opts.store.get<SandboxPayoutRecord>(`po:${ref.idempotencyKey}`);
      return { kind: "ok", value: record ? payoutOf(record, opts.now()) : null };
    },
  };
}

/** A stable sandbox card per player and variant (so a repeat deposit reuses the saved instrument). */
async function sandboxCard(customerRef: string, variant: "debit" | "credit" | "prepaid"): Promise<CardFacts> {
  const token = `sbx_upo_${(await sha256Hex(`${customerRef}:${variant}`)).slice(0, 24)}`;
  return {
    token, fingerprint: `sbx_fp_${token.slice(8, 32)}`, brand: "VISA", last4: variant === "prepaid" ? "0005" : variant === "credit" ? "4444" : "4242",
    expMonth: 12, expYear: 2030, issuerCountry: "MT", funding: variant, payoutEligible: variant !== "prepaid", holderName: null,
  };
}

export function createSandboxCardAdapter(opts: SandboxOptions): CardProvider {
  return {
    ...moneyBase(opts, "card"),
    kind: "sandbox",
    method: "CARD",
    async createDepositSession(input: CardDepositSessionInput): Promise<ProviderResult<CardDepositSession>> {
      const now = opts.now().toISOString();
      const paymentId = await opts.store.putIfAbsent(`dep:${input.depositId}`, id("sbx_pay"));
      await opts.store.putIfAbsent<SandboxPaymentRecord>(`pay:${paymentId}`, {
        id: paymentId, depositId: input.depositId, method: "CARD", channelRef: input.customer.providerCustomerRef, amountMinor: input.amountMinor.toString(),
        state: "PENDING", creditMinor: null, reviewReason: null, card: null, crypto: null, createdAt: now, updatedAt: now,
      });
      await opts.store.put(`ret:${paymentId}`, input.returnUrl);
      if (!opts.publicOrigin) return { kind: "rejected", final: true, code: "NO_PUBLIC_ORIGIN", message: "PAYMENTS_PUBLIC_ORIGIN is not set." };
      const sig = await sandboxLinkSig(opts.webhookSecret, `pay:${paymentId}`);
      return { kind: "ok", value: { type: "REDIRECT", providerPaymentId: paymentId, url: `${opts.publicOrigin}/sandbox/pay/${paymentId}?sig=${sig}`, expiresAt: input.expiresAt } };
    },
  };
}

export function createSandboxCryptoAdapter(opts: SandboxOptions): CryptoProvider {
  return {
    ...moneyBase(opts, "crypto"),
    kind: "sandbox",
    method: "CRYPTO",
    async createDepositSession(input: CryptoDepositSessionInput): Promise<ProviderResult<CryptoDepositSession>> {
      const now = opts.now().toISOString();
      const paymentId = await opts.store.putIfAbsent(`dep:${input.depositId}`, id("sbx_pay"));
      const network = input.payAsset.toLowerCase().includes("trc20") ? "tron" : input.payAsset === "BTC" ? "bitcoin" : "ethereum";
      // Invalid on every real chain on purpose.
      const address = `sbx:${input.payAsset.toLowerCase()}:${paymentId.slice(8)}`;
      const record = await opts.store.putIfAbsent<SandboxPaymentRecord>(`pay:${paymentId}`, {
        id: paymentId, depositId: input.depositId, method: "CRYPTO", channelRef: input.customer.providerCustomerRef, amountMinor: input.amountMinor.toString(),
        state: "PENDING", creditMinor: null, reviewReason: null, card: null,
        crypto: { asset: input.payAsset, network, address, amount: null, txHash: null, confirmations: null }, createdAt: now, updatedAt: now,
      });
      const hostedUrl = opts.publicOrigin ? `${opts.publicOrigin}/sandbox/pay/${paymentId}?sig=${await sandboxLinkSig(opts.webhookSecret, `pay:${paymentId}`)}` : null;
      return {
        kind: "ok",
        value: {
          type: "CRYPTO_INVOICE", providerPaymentId: paymentId, reusableAddress: false, asset: input.payAsset, network, address: record.crypto!.address, memo: null,
          payAmount: formatMinor(input.amountMinor, 2), expiresAt: input.expiresAt, minConfirmations: 1, hostedUrl,
        },
      };
    },
    async screenAddress(input: { address: string }): Promise<ProviderResult<{ risk: "LOW" | "MEDIUM" | "HIGH" | "SEVERE" }>> {
      // A test hook: an address ending in "dead" (any case) is SEVERE.
      return { kind: "ok", value: { risk: /dead$/i.test(input.address) ? "SEVERE" : "LOW" } };
    },
  };
}

export function createSandboxKycAdapter(opts: SandboxOptions): KycProvider {
  const applicantOf = (record: SandboxApplicantRecord): KycUpdate => ({
    applicantRef: record.applicantRef, userId: record.userId, decision: record.decision, level: "sandbox-basic", rejectReason: record.rejectReason,
    final: record.decision === "REJECTED", ...(record.identity && record.decision === "VERIFIED" ? { identity: record.identity } : {}),
    screening: record.screening, reviewDueAt: null, occurredAt: new Date(record.updatedAt),
  });
  return {
    kind: "sandbox",
    key: "sandbox-kyc",
    sandbox: true,
    method: "KYC",
    authoritativeWebhooks: false,
    redact: redactEnvelope,
    async verifyWebhook(request: WebhookRequest): Promise<WebhookVerification> {
      const envelope = await parseEnvelope(opts.webhookSecret, request);
      if ("error" in envelope) return { ok: false, reason: envelope.error };
      if (envelope.data.objectType !== "KYC") return { ok: false, reason: "format" };
      const record = await opts.store.get<SandboxApplicantRecord>(`kyc:${envelope.data.id}`);
      if (!record) return { ok: false, reason: "format" };
      return {
        ok: true, scheme: "sandbox-v1",
        events: [{ providerEventId: envelope.eventId, eventType: envelope.type.slice(0, 100), objectType: "KYC", objectRef: record.applicantRef, merchantRef: null, payload: redactEnvelope(envelope), kyc: applicantOf(record) }],
      };
    },
    async createSession(input: KycSessionInput): Promise<ProviderResult<KycSession>> {
      const applicantRef = `sbx_app_${(await sha256Hex(`kyc:${input.externalUserId}`)).slice(0, 24)}`;
      await opts.store.putIfAbsent<SandboxApplicantRecord>(`kyc:${applicantRef}`, {
        applicantRef, userId: input.externalUserId, decision: "PENDING", identity: null, screening: "CLEAR", rejectReason: null, updatedAt: opts.now().toISOString(),
      });
      const expiresAt = new Date(opts.now().getTime() + input.ttlSeconds * 1000);
      const subject = `kyc:${applicantRef}:${expiresAt.getTime()}`;
      return { kind: "ok", value: { sdkToken: `${applicantRef}.${expiresAt.getTime()}.${await sandboxLinkSig(opts.webhookSecret, subject)}`, applicantRef, expiresAt } };
    },
    async getApplicant(ref: { applicantRef?: string; externalUserId?: string }): Promise<ProviderResult<KycUpdate | null>> {
      let applicantRef = ref.applicantRef ?? null;
      if (!applicantRef && ref.externalUserId) applicantRef = `sbx_app_${(await sha256Hex(`kyc:${ref.externalUserId}`)).slice(0, 24)}`;
      const record = applicantRef ? await opts.store.get<SandboxApplicantRecord>(`kyc:${applicantRef}`) : null;
      return { kind: "ok", value: record ? applicantOf(record) : null };
    },
  };
}

/** The applicant ref of a valid, unexpired sandbox verification token, else null. */
export async function sandboxKycToken(secret: string, token: string, now: Date): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !/^sbx_app_[0-9a-f]{24}$/.test(parts[0]!) || !/^\d{13}$/.test(parts[1]!)) return null;
  if (Number(parts[1]) <= now.getTime()) return null;
  return (await sandboxLinkValid(secret, `kyc:${parts[0]}:${parts[1]}`, parts[2]!)) ? parts[0]! : null;
}

// ---------------------------------------------------------------------------
// What the sandbox pages do (public.ts renders them and delivers the webhook)
// ---------------------------------------------------------------------------

export type CardOutcome = "approve" | "approve_credit" | "approve_prepaid" | "decline" | "abandon" | "chargeback" | "refund";
export type CryptoOutcome = "confirm" | "underpay" | "overpay" | "expire" | "reorg";

export const CARD_OUTCOMES: readonly CardOutcome[] = ["approve", "approve_credit", "approve_prepaid", "decline", "abandon", "chargeback", "refund"];
export const CRYPTO_OUTCOMES: readonly CryptoOutcome[] = ["confirm", "underpay", "overpay", "expire", "reorg"];

/** Applies a button press to the stored payment; returns the envelope to deliver, or null when nothing changes. */
export async function applySandboxOutcome(opts: SandboxOptions, paymentId: string, outcome: CardOutcome | CryptoOutcome): Promise<SandboxEnvelope | null> {
  const record = await opts.store.get<SandboxPaymentRecord>(`pay:${paymentId}`);
  if (!record) return null;
  const now = opts.now().toISOString();
  const event = (objectType: SandboxEnvelope["data"]["objectType"], objectId: string, type: string): SandboxEnvelope => ({ eventId: id("sbx_evt"), type, createdAt: now, data: { objectType, id: objectId } });
  const amount = BigInt(record.amountMinor);
  if (outcome === "chargeback" || outcome === "refund" || outcome === "reorg") {
    if (record.state !== "SUCCEEDED" || record.creditMinor === null) return null;
    const dispute: SandboxDisputeRecord = {
      id: id("sbx_dsp"), paymentId, kind: outcome === "chargeback" ? "CHARGEBACK" : outcome === "refund" ? "PROVIDER_REFUND" : "CHAIN_REORG",
      amountMinor: record.creditMinor, recovers: null, createdAt: now,
    };
    await opts.store.put(`dsp:${dispute.id}`, dispute);
    return event("DISPUTE", dispute.id, `dispute.${dispute.kind.toLowerCase()}`);
  }
  if (record.state !== "PENDING") return null;
  if (record.method === "CARD" && !(CARD_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (record.method === "CRYPTO" && !(CRYPTO_OUTCOMES as readonly string[]).includes(outcome)) return null;
  let next: Partial<SandboxPaymentRecord>;
  switch (outcome) {
    case "approve":
    case "approve_credit":
    case "approve_prepaid":
      next = { state: "SUCCEEDED", creditMinor: amount.toString(), card: await sandboxCard(record.channelRef, outcome === "approve" ? "debit" : outcome === "approve_credit" ? "credit" : "prepaid") };
      break;
    case "decline":
      next = { state: "FAILED" };
      break;
    case "abandon":
    case "expire":
      next = { state: "EXPIRED" };
      break;
    case "confirm":
    case "overpay": {
      const credit = outcome === "overpay" ? (amount * 3n) / 2n : amount;
      next = { state: "SUCCEEDED", creditMinor: credit.toString(), crypto: { ...record.crypto!, amount: formatMinor(credit, 2), txHash: `0xsbx${toHex(randomBytes(16))}`, confirmations: 3 } };
      break;
    }
    case "underpay": {
      const credit = amount / 2n;
      next = { state: "NEEDS_REVIEW", reviewReason: "UNDERPAID", creditMinor: credit.toString(), crypto: { ...record.crypto!, amount: formatMinor(credit, 2), txHash: `0xsbx${toHex(randomBytes(16))}`, confirmations: 3 } };
      break;
    }
    default:
      return null;
  }
  await opts.store.put(`pay:${paymentId}`, { ...record, ...next, updatedAt: now });
  return event("PAYMENT", paymentId, `payment.${String(next.state).toLowerCase()}`);
}

/** The KYC page's decision. */
export async function applySandboxKyc(opts: SandboxOptions, applicantRef: string, input: { decision: "VERIFIED" | "REJECTED"; identity: SandboxApplicantRecord["identity"]; screening?: SandboxApplicantRecord["screening"] }): Promise<SandboxEnvelope | null> {
  const record = await opts.store.get<SandboxApplicantRecord>(`kyc:${applicantRef}`);
  if (!record) return null;
  const now = opts.now().toISOString();
  await opts.store.put<SandboxApplicantRecord>(`kyc:${applicantRef}`, {
    ...record, decision: input.decision, identity: input.decision === "VERIFIED" ? input.identity : null, screening: input.screening ?? "CLEAR",
    rejectReason: input.decision === "REJECTED" ? "SANDBOX_REJECTED" : null, updatedAt: now,
  });
  return { eventId: id("sbx_evt"), type: "applicant.reviewed", createdAt: now, data: { objectType: "KYC", id: applicantRef } };
}
