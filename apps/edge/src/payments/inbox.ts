/**
 * Provider webhooks (docs/money/WALLET.md sections 10.2 and 10.3).
 *
 * ingestWebhook (POST /webhooks/:providerKey): the provider must be
 * configured for this mode; method, size, rate and the optional CIDR
 * allow-list are checked; the adapter verifies the signature on the raw
 * bytes; every event is stored once (UNIQUE (provider, providerEventId)) in
 * one short transaction; 200 only after that commit (a database error is 503,
 * so the provider retries). Nothing unverified is ever stored.
 *
 * processEvent: the event is a hint. The provider's current state is read
 * again (outside any transaction) and applied under the event's row lock, so
 * a replayed, forged-but-signed, duplicated or out-of-order notification can
 * at most cause a status read. Failures back off; after 12 attempts the event
 * is DEAD (admin requeue). An event that cannot post because the asset is
 * disabled has not failed: it is parked, however long the stop lasts, and
 * spends no attempt.
 */
import { errBrief, logError, logWarn } from "../http/log";
import { PaymentsInvariant, PaymentsRefusal, moneyTx, type MoneyTx } from "../money/tx";
import { applyKycUpdate, lockCompliance, readCompliance } from "./compliance";
import { configuredKeys, isMoneyProvider, providerByKey, type MoneyProvider, type PaymentsContext } from "./context";
import { travelRuleParty } from "./customer";
import { applyProviderPayment, type EventOutcome } from "./deposits";
import { applyPayoutStatus } from "./dispatch";
import { raiseIssue } from "./issues";
import { applyDispute, restrictForDispute } from "./reversals";
import { onScreeningHit } from "./security";
import { settleRequestedCancels } from "./withdrawals";
import type { KycProvider, NormalizedEvent, PaymentProvider, ProviderDispute, ProviderPayment, ProviderPayout, ProviderResult, KycUpdate } from "./providers/types";

export const WEBHOOK_BODY_LIMIT = 256 * 1024;
export const MAX_EVENT_ATTEMPTS = 12;
/** How often an event that waits for the asset to be enabled looks again. */
export const PARKED_EVENT_RETRY_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface IngestDeps {
  /** RL_WEBHOOK, keyed by provider and source IP; absent in tests. */
  rateLimit?: RateLimit;
  sourceIp: string | null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
});

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    out = out * 256 + Number(part);
  }
  return out;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/.test(ip) || ip.split("::").length > 2) return null;
  const [head, tail] = ip.includes("::") ? ip.split("::") as [string, string] : [ip, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === null && missing !== 0)) return null;
  const groups = [...left, ...new Array<string>(tail === null ? 0 : missing).fill("0"), ...right];
  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out = (out << 16n) | BigInt(parseInt(group, 16));
  }
  return out;
}

/** True when `ip` is inside one of the CIDR ranges (IPv4 a.b.c.d/n or IPv6 x::y/n). */
export function ipAllowed(ip: string | null, cidrs: readonly string[]): boolean {
  if (!ip) return false;
  for (const cidr of cidrs) {
    const [range, bitsText] = cidr.split("/") as [string, string];
    const bits = Number(bitsText);
    const v4 = ipv4ToInt(ip);
    const r4 = ipv4ToInt(range);
    if (v4 !== null && r4 !== null && bits >= 0 && bits <= 32) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((v4 & mask) >>> 0) === ((r4 & mask) >>> 0)) return true;
      continue;
    }
    const v6 = ipv6ToBigInt(ip);
    const r6 = ipv6ToBigInt(range);
    if (v6 !== null && r6 !== null && bits >= 0 && bits <= 128) {
      const shift = BigInt(128 - bits);
      if ((v6 >> shift) === (r6 >> shift)) return true;
    }
  }
  return false;
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > WEBHOOK_BODY_LIMIT) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > WEBHOOK_BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What processEvent needs again later: ids, states and dispute amounts. Never card data or identity. */
export function eventSummary(event: NormalizedEvent): Record<string, string | boolean | null> {
  if ("payment" in event) {
    return { kind: "payment", providerPaymentId: event.payment.providerPaymentId, merchantRef: event.payment.merchantRef, channelRef: event.payment.channelRef, state: event.payment.state };
  }
  if ("dispute" in event) {
    const d = event.dispute;
    return {
      kind: "dispute", providerReversalId: d.providerReversalId, providerPaymentId: d.providerPaymentId, disputeKind: d.kind, amountMinor: d.amountMinor.toString(),
      recoversProviderReversalId: d.recoversProviderReversalId ?? null, informational: d.informational === true, reasonCode: d.reasonCode ?? null, occurredAt: d.occurredAt.toISOString(),
    };
  }
  if ("payout" in event) {
    return { kind: "payout", providerPayoutId: event.payout.providerPayoutId, merchantRef: event.payout.merchantRef, state: event.payout.state };
  }
  if ("kyc" in event) return { kind: "kyc", applicantRef: event.kyc.applicantRef, userId: event.kyc.userId, decision: event.kyc.decision };
  return { kind: "info", externalId: event.informationRequest.externalId, providerPaymentId: event.informationRequest.providerPaymentId };
}

export async function ingestWebhook(ctx: PaymentsContext, deps: IngestDeps, providerKey: string, request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" }, { allow: "POST" });
  const provider = providerByKey(ctx.providers, providerKey);
  if (!provider) return json(404, { error: "Not found" });
  if (deps.rateLimit) {
    try {
      const { success } = await deps.rateLimit.limit({ key: `${providerKey}:${deps.sourceIp ?? "unknown"}` });
      if (!success) return json(429, { error: "Too many requests" }, { "retry-after": "60" });
    } catch {
      return json(503, { error: "Unavailable" }, { "retry-after": "5" });
    }
  }
  const allowlist = ctx.config.webhookIpAllowlist[providerKey];
  if (allowlist && allowlist.length > 0 && !ipAllowed(deps.sourceIp, allowlist)) {
    logWarn({ security: "WEBHOOK_REJECTED", provider: providerKey, reason: "ip" }, "webhook from an address outside the allow-list");
    return json(403, { error: "Forbidden" });
  }
  const rawBody = await readBody(request);
  if (rawBody === null) return json(413, { error: "Payload too large" });
  const receivedAt = ctx.now();
  let verification: Awaited<ReturnType<PaymentProvider["verifyWebhook"]>>;
  try {
    verification = await provider.verifyWebhook({ method: request.method, url: new URL(request.url), headers: request.headers, rawBody, receivedAt, sourceIp: deps.sourceIp });
  } catch (error) {
    logWarn({ security: "WEBHOOK_REJECTED", provider: providerKey, reason: "adapter", ...errBrief(error) }, "webhook verification threw");
    return json(401, { error: "Unauthorized" });
  }
  if (!verification.ok) {
    logWarn({ security: "WEBHOOK_REJECTED", provider: providerKey, reason: verification.reason }, "webhook signature refused");
    return json(401, { error: "Unauthorized" });
  }
  const payloadSha256 = await sha256Hex(rawBody);
  let ids: string[];
  try {
    ids = await moneyTx(ctx.db, async (tx) => {
      const created: string[] = [];
      for (const event of verification.events) {
        const summary = eventSummary(event);
        let payload: Record<string, unknown> = { ...provider.redact(event.payload), _n: summary };
        if (JSON.stringify(payload).length > 60_000) payload = { _n: summary, _truncated: true };
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO public."PaymentEvent" ("provider", "providerEventId", "eventType", "objectType", "objectRef", "merchantRef",
            "payloadSha256", "payload", "signatureScheme", "signatureVerified", "sourceIp")
          VALUES (${provider.key}, ${event.providerEventId.slice(0, 200)}, ${event.eventType.slice(0, 100)}, ${event.objectType}::"PaymentObjectType",
            ${event.objectRef?.slice(0, 200) ?? null}, ${event.merchantRef?.slice(0, 200) ?? null}, ${payloadSha256}, ${JSON.stringify(payload)}::jsonb,
            ${verification.scheme.slice(0, 64)}, true, ${deps.sourceIp?.slice(0, 64) ?? null})
          ON CONFLICT ("provider", "providerEventId") DO NOTHING
          RETURNING "id"::text AS id`;
        if (rows[0]) created.push(rows[0].id);
      }
      return created;
    }, { label: "webhook.ingest" });
  } catch (error) {
    logWarn({ provider: providerKey, ...errBrief(error) }, "webhook could not be stored; answered 503");
    return json(503, { error: "Unavailable" }, { "retry-after": "30" });
  }
  if (ids.length > 0) ctx.defer(processEvents(ctx, ids));
  return json(200, { received: verification.events.length });
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  provider: string;
  objectType: string;
  payload: unknown;
  attempts: number;
  processedAt: Date | null;
}

type Fetched =
  | { kind: "payment"; provider: MoneyProvider; payment: ProviderPayment | null }
  | { kind: "payout"; provider: MoneyProvider; payout: ProviderPayout | null; merchantRef: string }
  | { kind: "dispute"; provider: MoneyProvider; dispute: ProviderDispute }
  | { kind: "kyc"; provider: KycProvider; update: KycUpdate | null }
  | { kind: "info"; provider: MoneyProvider; externalId: string; providerPaymentId: string | null; unanswered?: { code: string; userId: string | null } };

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function disputeFrom(n: Record<string, unknown>): ProviderDispute | null {
  const kind = str(n.disputeKind);
  if (!str(n.providerReversalId) || !str(n.providerPaymentId) || !kind || !/^\d{1,18}$/.test(String(n.amountMinor))) return null;
  if (!["CHARGEBACK", "PROVIDER_REFUND", "CHAIN_REORG", "CHARGEBACK_RECOVERY"].includes(kind)) return null;
  return {
    providerReversalId: n.providerReversalId as string, providerPaymentId: n.providerPaymentId as string, kind: kind as ProviderDispute["kind"],
    amountMinor: BigInt(String(n.amountMinor)), ...(str(n.recoversProviderReversalId) ? { recoversProviderReversalId: n.recoversProviderReversalId as string } : {}),
    informational: n.informational === true, ...(str(n.reasonCode) ? { reasonCode: n.reasonCode as string } : {}),
    occurredAt: new Date(String(n.occurredAt ?? Date.now())),
  };
}

/** Re-reads the object from the provider (outside any transaction). "uncertain" means try again later. */
async function fetchCurrent(ctx: PaymentsContext, provider: PaymentProvider, event: EventRow): Promise<Fetched | "uncertain" | "unusable"> {
  const n = (event.payload && typeof event.payload === "object" ? (event.payload as { _n?: Record<string, unknown> })._n : null) ?? null;
  if (!n) return "unusable";
  const settle = <T>(result: ProviderResult<T>): T | "uncertain" | "rejected" => (result.kind === "ok" ? result.value : result.kind === "uncertain" ? "uncertain" : "rejected");
  if (n.kind === "kyc") {
    if (provider.method !== "KYC") return "unusable";
    const result = settle(await provider.getApplicant({ ...(str(n.applicantRef) ? { applicantRef: n.applicantRef as string } : {}), ...(str(n.userId) ? { externalUserId: n.userId as string } : {}) }));
    if (result === "uncertain") return "uncertain";
    return { kind: "kyc", provider, update: result === "rejected" ? null : result };
  }
  if (!isMoneyProvider(provider)) return "unusable";
  switch (n.kind) {
    case "payment": {
      const result = settle(await provider.getPayment({
        ...(str(n.providerPaymentId) ? { providerPaymentId: n.providerPaymentId as string } : {}),
        ...(str(n.merchantRef) ? { merchantRef: n.merchantRef as string } : {}),
      }));
      if (result === "uncertain") return "uncertain";
      return { kind: "payment", provider, payment: result === "rejected" ? null : result };
    }
    case "payout": {
      const merchantRef = str(n.merchantRef);
      if (!merchantRef) return "unusable";
      const result = settle(await provider.getPayout({ idempotencyKey: merchantRef, providerPayoutId: str(n.providerPayoutId) }));
      if (result === "uncertain") return "uncertain";
      return { kind: "payout", provider, payout: result === "rejected" ? null : result, merchantRef };
    }
    case "dispute": {
      const dispute = disputeFrom(n);
      return dispute ? { kind: "dispute", provider, dispute } : "unusable";
    }
    case "info": {
      const externalId = str(n.externalId);
      return externalId ? { kind: "info", provider, externalId, providerPaymentId: str(n.providerPaymentId) } : "unusable";
    }
    default:
      return "unusable";
  }
}

async function failAttempt(ctx: PaymentsContext, event: EventRow, error: string): Promise<void> {
  const attempts = event.attempts + 1;
  const now = ctx.now();
  const dead = attempts >= MAX_EVENT_ATTEMPTS;
  if (dead) logError({ alert: "PAYMENT_EVENT_DEAD", eventId: event.id, provider: event.provider, error }, "payment event gave up after its last attempt");
  await ctx.db.$executeRaw`
    UPDATE public."PaymentEvent"
       SET "attempts" = ${attempts}, "lastError" = ${error.slice(0, 500)},
           "nextAttemptAt" = ${new Date(now.getTime() + Math.min(2 ** attempts, 60) * 60_000).toISOString()}::timestamp,
           "outcome" = CASE WHEN ${dead} THEN 'DEAD'::"PaymentEventOutcome" ELSE NULL END,
           "processedAt" = CASE WHEN ${dead} THEN ${now.toISOString()}::timestamp ELSE NULL END
     WHERE "id" = ${event.id}::uuid AND "processedAt" IS NULL`;
}

/** The asset is disabled, so this event cannot post yet: it waits, and spends no attempt. */
async function parkEvent(ctx: PaymentsContext, event: EventRow): Promise<void> {
  await ctx.db.$executeRaw`
    UPDATE public."PaymentEvent" SET "lastError" = 'PAYMENTS_PAUSED', "nextAttemptAt" = ${new Date(ctx.now().getTime() + PARKED_EVENT_RETRY_MS).toISOString()}::timestamp
     WHERE "id" = ${event.id}::uuid AND "processedAt" IS NULL`;
}

/** Applies the fetched state under [L1] (the event row) and marks the event processed. `stopped` names a player whose withdrawals were marked for cancelling. */
async function applyFetched(tx: MoneyTx, ctx: PaymentsContext, eventId: string, fetched: Fetched, stopped: { userId: string | null }): Promise<EventOutcome | "SKIPPED"> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS id FROM public."PaymentEvent" WHERE "id" = ${eventId}::uuid AND "processedAt" IS NULL FOR UPDATE SKIP LOCKED`;
  if (locked.length === 0) return "SKIPPED";
  let outcome: EventOutcome;
  switch (fetched.kind) {
    case "payment":
      outcome = fetched.payment ? await applyProviderPayment(tx, ctx, fetched.provider, fetched.payment) : "UNKNOWN_OBJECT";
      break;
    case "dispute":
      outcome = await applyDispute(tx, ctx, fetched.provider, fetched.dispute, eventId);
      break;
    case "payout": {
      const dispatch = await tx.payoutDispatch.findUnique({ where: { providerIdempotencyKey: fetched.merchantRef }, select: { withdrawalId: true, userId: true } });
      if (!dispatch || !fetched.payout) {
        outcome = "UNKNOWN_OBJECT";
        break;
      }
      await lockCompliance(tx, dispatch.userId);
      await tx.$queryRaw`SELECT "id" FROM public."Withdrawal" WHERE "id" = ${dispatch.withdrawalId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "withdrawalId" FROM public."PayoutDispatch" WHERE "withdrawalId" = ${dispatch.withdrawalId}::uuid FOR UPDATE`;
      const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: dispatch.withdrawalId } });
      const row = await tx.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: dispatch.withdrawalId } });
      outcome = await applyPayoutStatus(tx, ctx, withdrawal, row, fetched.payout);
      break;
    }
    case "kyc": {
      // Providers know the player only by an opaque reference: the applicant bound at startKyc names the account.
      const owner = fetched.update
        ? await tx.playerCompliance.findFirst({ where: { kycApplicantRef: fetched.update.applicantRef }, select: { userId: true } })
        : null;
      if (!fetched.update || !owner) {
        outcome = "UNKNOWN_OBJECT";
        break;
      }
      const { userId } = owner;
      const applied = await applyKycUpdate(tx, { userId, providerKey: fetched.provider.key, update: fetched.update, now: ctx.now() });
      const { screening } = fetched.update;
      if (applied === "APPLIED" && (screening === "POTENTIAL_MATCH" || screening === "CONFIRMED_MATCH")) {
        await onScreeningHit(tx, ctx, userId, screening);
        stopped.userId = userId;
      }
      outcome = applied;
      break;
    }
    case "info":
      if (fetched.unanswered) {
        // The provider keeps the funds on hold (or returns them) until someone answers: a person must.
        await raiseIssue(tx, {
          code: "TRAVEL_RULE_UNANSWERED", severity: "CRITICAL", subjectType: "PAYMENT_EVENT", subjectId: eventId,
          details: { provider: fetched.provider.key, reason: fetched.unanswered.code, userId: fetched.unanswered.userId },
        }, ctx.now());
        outcome = "NEEDS_REVIEW";
      } else {
        outcome = "APPLIED";
      }
      break;
  }
  await tx.$executeRaw`
    UPDATE public."PaymentEvent" SET "processedAt" = ${ctx.now().toISOString()}::timestamp, "outcome" = ${outcome}::"PaymentEventOutcome", "lastError" = NULL
     WHERE "id" = ${eventId}::uuid`;
  return outcome;
}

/** Processes one stored event (idempotent: a processed event is left alone). */
export async function processEvent(ctx: PaymentsContext, eventId: string): Promise<EventOutcome | "SKIPPED" | "RETRY"> {
  const event = await ctx.db.paymentEvent.findUnique({
    where: { id: eventId },
    select: { id: true, provider: true, objectType: true, payload: true, attempts: true, processedAt: true },
  }) as EventRow | null;
  if (!event || event.processedAt) return "SKIPPED";
  const provider = providerByKey(ctx.providers, event.provider);
  if (!provider) {
    await failAttempt(ctx, event, "PROVIDER_NOT_CONFIGURED");
    return "RETRY";
  }
  let fetched: Awaited<ReturnType<typeof fetchCurrent>>;
  try {
    fetched = await fetchCurrent(ctx, provider, event);
  } catch (error) {
    await failAttempt(ctx, event, `FETCH_${errBrief(error).errName}`);
    return "RETRY";
  }
  if (fetched === "uncertain") {
    await failAttempt(ctx, event, "PROVIDER_UNCERTAIN");
    return "RETRY";
  }
  if (fetched === "unusable") {
    await ctx.db.$executeRaw`
      UPDATE public."PaymentEvent" SET "processedAt" = ${ctx.now().toISOString()}::timestamp, "outcome" = 'UNKNOWN_OBJECT', "lastError" = 'UNUSABLE_EVENT'
       WHERE "id" = ${event.id}::uuid AND "processedAt" IS NULL`;
    return "UNKNOWN_OBJECT";
  }
  if (fetched.kind === "info") {
    // Travel rule: answer the provider's information request from verified KYC data, outside any transaction.
    const deposit = fetched.providerPaymentId
      ? await ctx.db.deposit.findFirst({ where: { providerKey: fetched.provider.key, providerPaymentId: fetched.providerPaymentId }, select: { userId: true } })
      : null;
    const party = deposit ? travelRuleParty(await readCompliance(ctx.db, deposit.userId), "ORIGINATOR") : null;
    if (party && fetched.provider.method === "CRYPTO" && fetched.provider.answerInformationRequest) {
      const answered = await fetched.provider.answerInformationRequest(fetched.externalId, party);
      if (answered.kind === "uncertain") {
        await failAttempt(ctx, event, "PROVIDER_UNCERTAIN");
        return "RETRY";
      }
      // A refused answer (ADDRESS_REQUIRED, BAD_DATE_OF_BIRTH, NOT_FOUND, ...) is not an answer.
      if (answered.kind === "rejected") fetched.unanswered = { code: answered.code.slice(0, 64), userId: deposit?.userId ?? null };
    } else {
      fetched.unanswered = { code: !deposit ? "DEPOSIT_UNKNOWN" : !party ? "NO_VERIFIED_IDENTITY" : "NOT_SUPPORTED", userId: deposit?.userId ?? null };
    }
    if (fetched.unanswered) {
      logError({ alert: "TRAVEL_RULE_REQUEST_UNANSWERED", provider: fetched.provider.key, code: fetched.unanswered.code }, "information request needs a person");
    }
  }
  const stopped: { userId: string | null } = { userId: null };
  try {
    if (fetched.kind === "dispute") await restrictForDispute(ctx, fetched.provider, fetched.dispute);
    const outcome = await moneyTx(ctx.db, (tx) => applyFetched(tx, ctx, event.id, fetched, stopped), {
      label: "event.process",
      attempts: 5,
      retryOn: (error) => fetched.kind === "dispute" && error.code === "INSUFFICIENT_FUNDS",
    });
    if (stopped.userId) await settleRequestedCancels(ctx, { userId: stopped.userId });
    return outcome;
  } catch (error) {
    if (error instanceof PaymentsRefusal && error.code === "PAYMENTS_PAUSED") {
      await parkEvent(ctx, event).catch(() => undefined);
      return "RETRY";
    }
    const code = error instanceof PaymentsRefusal || error instanceof PaymentsInvariant ? `${error.code}:${error.dbCode ?? ""}` : errBrief(error).errName;
    await failAttempt(ctx, event, code).catch(() => undefined);
    return "RETRY";
  }
}

export async function processEvents(ctx: PaymentsContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await processEvent(ctx, id);
    } catch (error) {
      logWarn({ eventId: id, ...errBrief(error) }, "payment event processing failed; the sweeper retries it");
    }
  }
}

/** The sweeper's share: at most `limit` due, unprocessed events. */
export async function processDueEvents(ctx: PaymentsContext, limit = 5): Promise<number> {
  // Only this Worker's providers: another deployment's events are never touched (or failed) here.
  const keys = configuredKeys(ctx.providers);
  if (keys.length === 0) return 0;
  const rows = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS id FROM public."PaymentEvent"
     WHERE "processedAt" IS NULL AND "nextAttemptAt" <= ${ctx.now().toISOString()}::timestamp
       AND "provider" = ANY (string_to_array(${keys.join(",")}, ','))
     ORDER BY "nextAttemptAt" LIMIT ${limit}`;
  await processEvents(ctx, rows.map((row) => row.id));
  return rows.length;
}
