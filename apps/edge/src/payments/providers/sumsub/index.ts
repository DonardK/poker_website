/**
 * Sumsub KYC adapter (INTEGRATION.md override 15): applicant creation,
 * WebSDK access tokens, applicant reads and signed webhooks. Facts verified
 * against Sumsub's developer documentation on 2026-10-29; README.md in this
 * directory lists each with its URL and what is still UNVERIFIED.
 *
 * - Request signing (https://docs.sumsub.com/reference/authentication):
 *   X-App-Token, X-App-Access-Ts (unix seconds, UTC; Sumsub refuses a
 *   timestamp more than a minute off) and X-App-Access-Sig = lowercase hex
 *   HMAC-SHA256 with the secret key over ts + METHOD + path-with-query +
 *   raw body (nothing when there is no body).
 * - A session finds or creates the applicant for our externalUserId
 *   (GET /resources/applicants/-;externalUserId={id}/one, then
 *   POST /resources/applicants?levelName=), then asks for an SDK token
 *   (POST /resources/accessTokens/sdk,
 *   https://docs.sumsub.com/reference/generate-access-token). The applicant
 *   id comes back as applicantRef, so the core binds the account to it.
 * - Results are read with GET /resources/applicants/{id}/one
 *   (https://docs.sumsub.com/reference/get-applicant-data): review status
 *   and answer, and the verified identity (Latin-script names, birth date,
 *   alpha-3 country converted to alpha-2). Only "completed" reviews decide.
 * - Webhooks (https://docs.sumsub.com/docs/webhook-manager): x-payload-digest
 *   is a hex HMAC over the raw body with the webhook secret, the algorithm in
 *   x-payload-digest-alg (HMAC_SHA256_HEX, the default, or HMAC_SHA512_HEX;
 *   the legacy HMAC_SHA1_HEX is refused). A webhook carries no identity and
 *   no event id; it is a hint (authoritativeWebhooks = false) and the core
 *   re-reads the applicant.
 * - Sandbox or live: SumsubConfig.mode (PAYMENTS_MODE). An app token whose
 *   prefix says otherwise ("sbx:" sandbox, "prd:" production; the prefixes are
 *   not in the official docs, UNVERIFIED) keeps the adapter off, and a webhook
 *   whose sandboxMode disagrees is refused.
 */
import { z } from "zod";
import { toHex } from "../../../auth/bytes";
import {
  ProviderConfigError,
  providerLedgerKey,
  type KycDecision,
  type KycProvider,
  type KycSession,
  type KycSessionInput,
  type KycUpdate,
  type NormalizedEvent,
  type ProviderDeps,
  type ProviderResult,
  type SumsubConfig,
  type WebhookRequest,
  type WebhookVerification,
} from "../types";
import { clip, decodeUtf8, equalBytes, hexToBytes, hmac, parseJsonLossless, redactWith, send, sha256HexOf } from "../wire";
import { alpha3ToAlpha2 } from "./countries";

/** Sumsub refuses a signature timestamp more than a minute away from its clock. */
const TOKEN_TTL_MIN = 60;
const TOKEN_TTL_MAX = 3600;
/** Our externalUserId values are opaque customer references (customer.ts); this also keeps ";" and "/" out of the lookup path. */
const EXTERNAL_USER_ID = /^[A-Za-z0-9._@:-]{1,512}$/;
const LEVEL_NAME = /^[A-Za-z0-9 _.-]{1,128}$/;
const APPLICANT_ID = /^[A-Za-z0-9]{1,64}$/;
/** idDocs[].validUntil of a document with no expiry. */
const TERMLESS_FROM = Date.UTC(2099, 0, 1);

// ---------------------------------------------------------------------------
// Wire schemas (unknown fields are ignored)
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().max(max);

const reviewResultSchema = z.object({
  reviewAnswer: text(16).nullish(),
  reviewRejectType: text(16).nullish(),
  rejectLabels: z.array(text(64)).max(50).nullish(),
});

const reviewSchema = z.object({
  reviewStatus: text(32).nullish(),
  levelName: text(128).nullish(),
  reviewDate: text(40).nullish(),
  createDate: text(40).nullish(),
  reviewResult: reviewResultSchema.nullish(),
});

/** GET /resources/applicants/{id}/one (and the create answer). */
const applicantSchema = z.object({
  id: z.string().regex(APPLICANT_ID),
  externalUserId: text(512).nullish(),
  createdAt: text(40).nullish(),
  type: text(32).nullish(),
  info: z.object({
    firstName: text(200).nullish(),
    firstNameEn: text(200).nullish(),
    lastName: text(200).nullish(),
    lastNameEn: text(200).nullish(),
    dob: text(20).nullish(),
    country: text(3).nullish(),
    idDocs: z.array(z.object({ idDocType: text(64).nullish(), country: text(3).nullish(), validUntil: text(20).nullish() })).max(50).nullish(),
  }).nullish(),
  review: reviewSchema.nullish(),
});
type Applicant = z.infer<typeof applicantSchema>;

const accessTokenSchema = z.object({ token: z.string().min(1).max(4096), userId: text(512).nullish() });

/** The webhook body (user-verification webhooks page). */
const webhookSchema = z.object({
  type: text(64).min(1),
  applicantId: z.string().regex(APPLICANT_ID).nullish(),
  inspectionId: text(64).nullish(),
  applicantType: text(32).nullish(),
  correlationId: text(128).nullish(),
  externalUserId: text(512).nullish(),
  levelName: text(128).nullish(),
  sandboxMode: z.boolean().nullish(),
  reviewStatus: text(32).nullish(),
  createdAtMs: text(40).nullish(),
  clientId: text(128).nullish(),
  reviewResult: reviewResultSchema.nullish(),
});

/** Kept in PaymentEvent.payload: ids, statuses and labels; never names, documents or moderator comments. */
const REDACT_KEYS: ReadonlySet<string> = new Set([
  "type", "applicantId", "inspectionId", "applicantType", "correlationId", "externalUserId", "levelName", "sandboxMode",
  "reviewStatus", "createdAtMs", "reviewResult", "reviewAnswer", "reviewRejectType", "rejectLabels", "id", "review", "createdAt",
]);

/**
 * Reject labels that come from AML screening rather than the documents.
 * Label names from Sumsub's rejection-label list, not re-read in this
 * session (UNVERIFIED); an unknown label never sets a screening result.
 */
const CONFIRMED_MATCH_LABELS = new Set(["SANCTIONS", "COMPROMISED_PERSONS", "CRIMINAL", "BLACKLIST", "BLOCKLIST"]);
const POTENTIAL_MATCH_LABELS = new Set(["PEP", "ADVERSE_MEDIA"]);

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createSumsubAdapter(config: SumsubConfig, deps: ProviderDeps): KycProvider {
  const mode = sumsubMode(config);
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new ProviderConfigError("sumsub", "SUMSUB_BASE_URL", "SUMSUB_BASE_URL is not a URL");
  }
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.username || base.password) {
    throw new ProviderConfigError("sumsub", "SUMSUB_BASE_URL", "SUMSUB_BASE_URL must be an https origin (Sumsub requires HTTPS)");
  }
  if (!LEVEL_NAME.test(config.levelName)) throw new ProviderConfigError("sumsub", "SUMSUB_LEVEL_NAME", "SUMSUB_LEVEL_NAME has unexpected characters");
  // Header values: printable ASCII only (a pasted newline would split the header).
  if (!/^[\x21-\x7e]{16,512}$/.test(config.appToken)) throw new ProviderConfigError("sumsub", "SUMSUB_APP_TOKEN", "SUMSUB_APP_TOKEN is not a plausible app token");
  const key = providerLedgerKey("kyc", "sumsub", mode);
  const sandbox = mode === "sandbox";
  const log = (level: "info" | "warn" | "error", fields: Record<string, string | number | boolean | null>, message: string) =>
    deps.log(level, { provider: key, ...fields }, message);

  type Answer = { kind: "ok"; status: number; body: unknown } | { kind: "error"; status: number; body: unknown } | { kind: "uncertain"; reason: "timeout" | "network" | "5xx" | "malformed" };

  /** One signed call. `op` names the operation in logs (paths carry ids). */
  async function call(op: string, method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<Answer> {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const url = new URL(pathAndQuery, base);
    const ts = String(Math.floor(deps.now().getTime() / 1000));
    // Signed over the path exactly as sent (after URL serialisation).
    const signature = toHex(await hmac("SHA-256", config.secretKey, ts + method + url.pathname + url.search + (raw ?? "")));
    const headers: Record<string, string> = {
      "x-app-token": config.appToken,
      "x-app-access-ts": ts,
      "x-app-access-sig": signature,
      accept: "application/json",
    };
    if (raw !== undefined) headers["content-type"] = "application/json";
    const result = await send(deps.fetch, { method, url: url.toString(), headers, body: raw });
    if (result.kind === "failed") {
      log("warn", { op, reason: result.reason }, "sumsub call failed");
      return { kind: "uncertain", reason: result.reason };
    }
    if (result.status >= 500) {
      log("warn", { op, status: result.status }, "sumsub 5xx");
      return { kind: "uncertain", reason: "5xx" };
    }
    const parsed = result.text === null ? undefined : parseOrUndefined(result.text);
    if (result.status >= 200 && result.status < 300) {
      if (parsed === undefined) return { kind: "uncertain", reason: "malformed" };
      return { kind: "ok", status: result.status, body: parsed };
    }
    if (result.status === 401 || result.status === 403) {
      // A wrong token or key, or a clock more than a minute off.
      log("error", { op, status: result.status, alert: "SUMSUB_AUTH_REFUSED" }, "sumsub refused our credentials or timestamp");
    }
    if (result.status >= 300 && result.status < 400) return { kind: "uncertain", reason: "malformed" };
    return { kind: "error", status: result.status, body: parsed };
  }

  /** A non-2xx answer as a rejection. Error bodies are {code, correlationId, description}. */
  function refusal<T>(answer: Extract<Answer, { kind: "error" }>, fallbackCode: string): ProviderResult<T> {
    if (answer.status === 401 || answer.status === 403) return { kind: "rejected", final: false, code: "PROVIDER_AUTH", message: "Sumsub refused the request credentials" };
    if (answer.status === 429) return { kind: "rejected", final: false, code: "RATE_LIMITED", message: "Sumsub rate limit" };
    if (answer.status === 408) return { kind: "uncertain", reason: "timeout" };
    const body = answer.body && typeof answer.body === "object" ? (answer.body as Record<string, unknown>) : {};
    const description = typeof body.description === "string" ? clip(body.description, 200) : "";
    // errorName is not in the documented error body (UNVERIFIED); used only when present and plain.
    const code = typeof body.errorName === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(body.errorName) ? `SUMSUB_${body.errorName}`.slice(0, 64) : fallbackCode;
    return { kind: "rejected", final: true, code, message: description || `Sumsub answered ${answer.status}` };
  }

  // -------------------------------------------------------------------------
  // Applicants
  // -------------------------------------------------------------------------

  async function readApplicant(ref: { applicantRef?: string; externalUserId?: string }): Promise<ProviderResult<Applicant | null>> {
    let path: string;
    if (ref.applicantRef) {
      if (!APPLICANT_ID.test(ref.applicantRef)) return { kind: "ok", value: null };
      path = `/resources/applicants/${ref.applicantRef}/one`;
    } else if (ref.externalUserId) {
      if (!EXTERNAL_USER_ID.test(ref.externalUserId)) return { kind: "ok", value: null };
      path = `/resources/applicants/-;externalUserId=${encodeURIComponent(ref.externalUserId)}/one`;
    } else {
      return { kind: "ok", value: null };
    }
    const answer = await call("applicant.read", "GET", path);
    if (answer.kind === "uncertain") return answer;
    // 404 for an unknown applicant is the usual REST answer; not documented (UNVERIFIED).
    if (answer.kind === "error") return answer.status === 404 ? { kind: "ok", value: null } : refusal(answer, "SUMSUB_READ_FAILED");
    const parsed = applicantSchema.safeParse(answer.body);
    if (!parsed.success) return { kind: "uncertain", reason: "malformed" };
    const applicant = parsed.data;
    // The answer must be the applicant we asked for.
    if ((ref.applicantRef && applicant.id !== ref.applicantRef) || (ref.externalUserId && applicant.externalUserId && applicant.externalUserId !== ref.externalUserId)) {
      log("error", { applicantId: applicant.id, alert: "SUMSUB_APPLICANT_MISMATCH" }, "sumsub answered with another applicant");
      return { kind: "uncertain", reason: "malformed" };
    }
    return { kind: "ok", value: applicant };
  }

  async function findOrCreateApplicant(input: { externalUserId: string; email: string | null; level: string }): Promise<ProviderResult<Applicant>> {
    const existing = await readApplicant({ externalUserId: input.externalUserId });
    if (existing.kind !== "ok") return existing;
    if (existing.value) return { kind: "ok", value: existing.value };
    const answer = await call("applicant.create", "POST", `/resources/applicants?levelName=${encodeURIComponent(input.level)}`, {
      externalUserId: input.externalUserId,
      ...(input.email ? { email: clip(input.email, 254) } : {}),
    });
    if (answer.kind === "uncertain") return answer;
    if (answer.kind === "error") {
      // Two sessions raced, or the applicant appeared since the read: the
      // duplicate answer is not documented (UNVERIFIED), so any 409 or an
      // "already exists" 400 is resolved by reading again.
      const description = answer.body && typeof answer.body === "object" ? String((answer.body as { description?: unknown }).description ?? "") : "";
      if (answer.status === 409 || (answer.status === 400 && /already exists/i.test(description))) {
        const again = await readApplicant({ externalUserId: input.externalUserId });
        if (again.kind !== "ok") return again;
        return again.value ? { kind: "ok", value: again.value } : { kind: "uncertain", reason: "malformed" };
      }
      return refusal(answer, "SUMSUB_CREATE_FAILED");
    }
    const parsed = applicantSchema.safeParse(answer.body);
    if (!parsed.success) return { kind: "uncertain", reason: "malformed" };
    if (parsed.data.externalUserId && parsed.data.externalUserId !== input.externalUserId) {
      log("error", { applicantId: parsed.data.id, alert: "SUMSUB_APPLICANT_MISMATCH" }, "created applicant carries another externalUserId");
      return { kind: "uncertain", reason: "malformed" };
    }
    return { kind: "ok", value: parsed.data };
  }

  /** The core's view of a review: decision, finality, reason and screening. */
  function decide(status: string | null | undefined, result: z.infer<typeof reviewResultSchema> | null | undefined): Pick<KycUpdate, "decision" | "final" | "rejectReason" | "screening"> {
    // The answer means something only once the review is completed.
    if ((status ?? "").toLowerCase() !== "completed") return { decision: "PENDING", final: false, rejectReason: null };
    const answer = (result?.reviewAnswer ?? "").toUpperCase();
    const labels = (result?.rejectLabels ?? []).map((label) => label.toUpperCase());
    if (answer === "GREEN") {
      // Only a level that really screens can say "clear", and never with a screening label on the review.
      const clear = config.screeningIncluded && !labels.some((label) => CONFIRMED_MATCH_LABELS.has(label) || POTENTIAL_MATCH_LABELS.has(label));
      return { decision: "VERIFIED", final: false, rejectReason: null, ...(clear ? { screening: "CLEAR" as const } : {}) };
    }
    if (answer === "RED") {
      const type = (result?.reviewRejectType ?? "").toUpperCase();
      const decision: KycDecision = type === "RETRY" ? "RESUBMISSION_REQUESTED" : "REJECTED";
      const screening = labels.some((label) => CONFIRMED_MATCH_LABELS.has(label)) ? "CONFIRMED_MATCH"
        : labels.some((label) => POTENTIAL_MATCH_LABELS.has(label)) ? "POTENTIAL_MATCH" : undefined;
      return {
        decision,
        // A RED answer without a reject type is not treated as final: staff decides.
        final: type === "FINAL",
        rejectReason: clip(labels.length > 0 ? labels.join(",") : type || "REJECTED", 200),
        ...(screening ? { screening } : {}),
      };
    }
    log("warn", { reviewAnswer: clip(answer, 16) || null }, "completed sumsub review without a known answer; left pending");
    return { decision: "PENDING", final: false, rejectReason: null };
  }

  function updateFromApplicant(a: Applicant): KycUpdate {
    const review = a.review;
    const decided = decide(review?.reviewStatus, review?.reviewResult);
    const update: KycUpdate = {
      applicantRef: a.id,
      userId: a.externalUserId ?? null,
      ...decided,
      level: review?.levelName ?? null,
      occurredAt: sumsubDate(review?.reviewDate) ?? sumsubDate(review?.createDate) ?? sumsubDate(a.createdAt) ?? deps.now(),
    };
    if (decided.decision === "VERIFIED") {
      const info = a.info;
      const firstName = (info?.firstNameEn ?? info?.firstName ?? "").trim();
      const lastName = (info?.lastNameEn ?? info?.lastName ?? "").trim();
      const birthDate = info?.dob && validDate(info.dob) ? info.dob : null;
      const country = alpha3ToAlpha2(info?.country);
      if (firstName && lastName && birthDate && country) {
        update.identity = { firstName: clip(firstName, 100), lastName: clip(lastName, 100), birthDate, country };
      } else {
        // The core then keeps the player PENDING and alerts (compliance.ts).
        log("error", { applicantId: a.id, alert: "SUMSUB_IDENTITY_INCOMPLETE" }, "verified applicant without a complete identity");
      }
      update.reviewDueAt = earliestExpiry(info?.idDocs ?? []);
    }
    return update;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  async function digestMatches(request: WebhookRequest): Promise<"ok" | "signature" | "unsupported_scheme"> {
    const algorithm = (request.headers.get("x-payload-digest-alg") ?? "HMAC_SHA256_HEX").trim().toUpperCase();
    const hash = algorithm === "HMAC_SHA256_HEX" ? "SHA-256" : algorithm === "HMAC_SHA512_HEX" ? "SHA-512" : null;
    if (!hash) return "unsupported_scheme";
    const given = hexToBytes((request.headers.get("x-payload-digest") ?? "").trim());
    if (!given || given.length !== (hash === "SHA-256" ? 32 : 64)) return "signature";
    return equalBytes(await hmac(hash, config.webhookSecret, request.rawBody), given) ? "ok" : "signature";
  }

  // -------------------------------------------------------------------------
  // The provider
  // -------------------------------------------------------------------------

  return {
    kind: "sumsub",
    method: "KYC",
    key,
    sandbox,
    authoritativeWebhooks: false,

    async createSession(input: KycSessionInput): Promise<ProviderResult<KycSession>> {
      if (!EXTERNAL_USER_ID.test(input.externalUserId)) return { kind: "rejected", final: true, code: "BAD_EXTERNAL_USER_ID", message: "externalUserId has unexpected characters" };
      const level = input.level || config.levelName;
      if (!LEVEL_NAME.test(level)) return { kind: "rejected", final: true, code: "BAD_LEVEL", message: "level name has unexpected characters" };
      const ttl = Math.min(TOKEN_TTL_MAX, Math.max(TOKEN_TTL_MIN, Math.floor(Number.isFinite(input.ttlSeconds) ? input.ttlSeconds : config.tokenTtlSeconds)));
      const applicant = await findOrCreateApplicant({ externalUserId: input.externalUserId, email: input.email, level });
      if (applicant.kind !== "ok") return applicant;
      const answer = await call("token.create", "POST", "/resources/accessTokens/sdk", {
        userId: input.externalUserId,
        levelName: level,
        ttlInSecs: ttl,
      });
      if (answer.kind === "uncertain") return answer;
      if (answer.kind === "error") return refusal(answer, "SUMSUB_TOKEN_FAILED");
      const token = accessTokenSchema.safeParse(answer.body);
      if (!token.success) return { kind: "uncertain", reason: "malformed" };
      if (token.data.userId && token.data.userId !== input.externalUserId) {
        log("error", { applicantId: applicant.value.id, alert: "SUMSUB_TOKEN_MISMATCH" }, "access token issued for another user");
        return { kind: "uncertain", reason: "malformed" };
      }
      return { kind: "ok", value: { sdkToken: token.data.token, applicantRef: applicant.value.id, expiresAt: new Date(deps.now().getTime() + ttl * 1000) } };
    },

    async getApplicant(ref): Promise<ProviderResult<KycUpdate | null>> {
      const found = await readApplicant(ref);
      if (found.kind !== "ok") return found;
      return { kind: "ok", value: found.value ? updateFromApplicant(found.value) : null };
    },

    async verifyWebhook(request: WebhookRequest): Promise<WebhookVerification> {
      if (request.method.toUpperCase() !== "POST") return { ok: false, reason: "format" };
      const digest = await digestMatches(request);
      if (digest !== "ok") return { ok: false, reason: digest };
      const body = decodeUtf8(request.rawBody);
      const parsed = webhookSchema.safeParse(body === null ? undefined : parseOrUndefined(body));
      if (!parsed.success) return { ok: false, reason: "format" };
      const w = parsed.data;
      if (typeof w.sandboxMode === "boolean" && w.sandboxMode !== sandbox) {
        // A sandbox event at the live endpoint (or the reverse): never applied.
        log("error", { sandboxMode: w.sandboxMode, alert: "SUMSUB_WEBHOOK_MODE" }, "sumsub webhook from the other environment refused");
        return { ok: false, reason: "format" };
      }
      // Company applicants and events without an applicant carry nothing we apply.
      if (!w.applicantId || (w.applicantType && w.applicantType.toLowerCase() !== "individual")) return { ok: true, scheme: "sumsub-digest", events: [] };
      const decided = decide(w.reviewStatus, w.reviewResult);
      const occurredAt = sumsubDate(w.createdAtMs) ?? request.receivedAt;
      // No event id: a digest of what identifies this notification.
      const providerEventId = `d_${await sha256HexOf([key, w.applicantId, w.type, w.reviewStatus ?? "", w.reviewResult?.reviewAnswer ?? "", w.createdAtMs ?? "", w.correlationId ?? ""].join("|"))}`;
      const event: NormalizedEvent = {
        providerEventId,
        eventType: clip(w.type, 100),
        objectType: "KYC",
        objectRef: w.applicantId,
        merchantRef: w.externalUserId ?? null,
        payload: redactWith(REDACT_KEYS, w),
        kyc: {
          applicantRef: w.applicantId,
          userId: w.externalUserId ?? null,
          ...decided,
          level: w.levelName ?? null,
          occurredAt,
        },
      };
      return { ok: true, scheme: "sumsub-digest", events: [event] };
    },

    redact(payload: unknown): Record<string, unknown> {
      return redactWith(REDACT_KEYS, payload);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** config.mode, refused when the app token's prefix says it belongs to the other environment. */
function sumsubMode(config: SumsubConfig): "sandbox" | "live" {
  const prefix = config.appToken.startsWith("sbx:") ? "sandbox" : config.appToken.startsWith("prd:") ? "live" : null;
  if (prefix !== null && prefix !== config.mode) {
    throw new ProviderConfigError("sumsub", "SUMSUB_APP_TOKEN", `SUMSUB_APP_TOKEN looks like a ${prefix} token but PAYMENTS_MODE is ${config.mode}`);
  }
  return config.mode;
}

function parseOrUndefined(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return parseJsonLossless(text);
  } catch {
    return undefined;
  }
}

/** A real calendar date "YYYY-MM-DD". */
function validDate(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

/** Sumsub's UTC timestamps "2020-02-21 13:23:19" / "2020-02-21 13:23:19.321" (or ISO), else null. */
function sumsubDate(value: string | null | undefined): Date | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(?:Z|\+0000|\+00:00)?$/.exec(value ?? "");
  if (!match) return null;
  const ms = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), ms));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The earliest real document expiry (2099-01-01 and later mean "no expiry"). */
function earliestExpiry(docs: readonly { validUntil?: string | null }[]): Date | null {
  let earliest: Date | null = null;
  for (const doc of docs) {
    if (!doc.validUntil || !validDate(doc.validUntil)) continue;
    const date = new Date(`${doc.validUntil}T00:00:00.000Z`);
    if (date.getTime() >= TERMLESS_FROM) continue;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest;
}
