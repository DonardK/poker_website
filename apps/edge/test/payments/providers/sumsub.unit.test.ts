/**
 * Sumsub adapter (src/payments/providers/sumsub): request signing
 * (docs.sumsub.com/reference/authentication), applicant find-or-create, SDK
 * access tokens, review mapping with the verified identity, and webhook
 * digests (docs.sumsub.com/docs/webhook-manager). Signatures are recomputed
 * here from the documented formulas with random secrets; webhook bodies
 * follow the documented applicantReviewed example. No network.
 */
import { describe, expect, it } from "vitest";
import { createSumsubAdapter } from "../../../src/payments/providers/sumsub";
import { ALPHA3_TO_ALPHA2, alpha3ToAlpha2 } from "../../../src/payments/providers/sumsub/countries";
import type { SumsubConfig } from "../../../src/payments/providers/types";
import { bytes, fakeDeps, hex, hmacBytes, json, logText, NOW, queue, randomSecret, type Recorded } from "./fakes";

const USER = "6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const APPLICANT = "5cb56e8e0a975a35f333cb83";

function config(overrides: Partial<SumsubConfig> = {}): SumsubConfig {
  return {
    mode: "sandbox",
    baseUrl: "https://api.sumsub.com",
    appToken: `sbx:${randomSecret()}`,
    secretKey: randomSecret(),
    webhookSecret: randomSecret(),
    levelName: "basic-kyc-level",
    tokenTtlSeconds: 600,
    screeningIncluded: false,
    ...overrides,
  };
}

/** X-App-Access-Sig = hex HMAC-SHA256(secret, ts + METHOD + path?query + body). */
async function expectSigned(request: Recorded, cfg: SumsubConfig): Promise<void> {
  const ts = request.headers.get("x-app-access-ts");
  expect(ts).toBe(String(Math.floor(NOW.getTime() / 1000)));
  expect(request.headers.get("x-app-token")).toBe(cfg.appToken);
  const expected = hex(await hmacBytes("SHA-256", cfg.secretKey, `${ts}${request.method}${request.url.pathname}${request.url.search}${request.body}`));
  expect(request.headers.get("x-app-access-sig")).toBe(expected);
}

function applicant(overrides: { review?: Record<string, unknown>; info?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  return {
    id: APPLICANT,
    createdAt: "2026-10-29 12:00:00",
    clientId: "pokerclient",
    inspectionId: "5cb56e8e0a975a35f333cb84",
    externalUserId: USER,
    info: {
      firstName: "Jürgen", firstNameEn: "Juergen", lastName: "Müller", lastNameEn: "Mueller", dob: "1989-07-16", country: "DEU",
      idDocs: [
        { idDocType: "PASSPORT", country: "DEU", validUntil: "2031-03-01" },
        { idDocType: "ID_CARD", country: "DEU", validUntil: "2029-05-31" },
        { idDocType: "SELFIE", country: "DEU", validUntil: "2099-01-01" },
      ],
      ...overrides.info,
    },
    email: "player@example.com",
    review: {
      reviewStatus: "completed", levelName: "basic-kyc-level", reviewDate: "2026-10-29 12:20:31", createDate: "2026-10-29 12:00:01",
      reviewResult: { reviewAnswer: "GREEN" },
      ...overrides.review,
    },
    type: "individual",
    ...overrides.top,
  };
}

describe("Sumsub adapter identity", () => {
  it("follows PAYMENTS_MODE (config.mode)", () => {
    const sandbox = createSumsubAdapter(config(), fakeDeps(queue()).deps);
    expect([sandbox.key, sandbox.sandbox, sandbox.method, sandbox.kind, sandbox.authoritativeWebhooks]).toEqual(["sandbox-sumsub", true, "KYC", "sumsub", false]);
    const live = createSumsubAdapter(config({ mode: "live", appToken: `prd:${randomSecret()}` }), fakeDeps(queue()).deps);
    expect([live.key, live.sandbox]).toEqual(["sumsub", false]);
  });

  it("stays off when the token belongs to the other environment or the config is unsafe", () => {
    expect(() => createSumsubAdapter(config({ mode: "live", appToken: `sbx:${randomSecret()}` }), fakeDeps(queue()).deps)).toThrow(/sandbox token/);
    expect(() => createSumsubAdapter(config({ mode: "sandbox", appToken: `prd:${randomSecret()}` }), fakeDeps(queue()).deps)).toThrow(/live token/);
    expect(createSumsubAdapter(config({ mode: "live", appToken: randomSecret() }), fakeDeps(queue()).deps).key).toBe("sumsub");
    expect(() => createSumsubAdapter(config({ baseUrl: "http://api.sumsub.com" }), fakeDeps(queue()).deps)).toThrow(/https/);
    expect(() => createSumsubAdapter(config({ appToken: `sbx:${randomSecret()}\nx` }), fakeDeps(queue()).deps)).toThrow(/SUMSUB_APP_TOKEN/);
  });
});

describe("Sumsub sessions", () => {
  it("reuses the existing applicant and signs both calls", async () => {
    const cfg = config();
    const { deps, requests } = fakeDeps(queue(json(200, applicant({ review: { reviewStatus: "init", reviewResult: null } })), json(200, { token: "_act-sbx-jwt-eyJhbGciOi", userId: USER })));
    const result = await createSumsubAdapter(cfg, deps).createSession({ userId: USER, externalUserId: USER, email: "player@example.com", country: "MT", level: "basic-kyc-level", ttlSeconds: 600 });
    expect(result).toEqual({ kind: "ok", value: { sdkToken: "_act-sbx-jwt-eyJhbGciOi", applicantRef: APPLICANT, expiresAt: new Date(NOW.getTime() + 600_000) } });
    const [read, token] = requests;
    expect(read!.method).toBe("GET");
    expect(read!.url.toString()).toBe(`https://api.sumsub.com/resources/applicants/-;externalUserId=${USER}/one`);
    await expectSigned(read!, cfg);
    expect(token!.url.pathname).toBe("/resources/accessTokens/sdk");
    expect(JSON.parse(token!.body)).toEqual({ userId: USER, levelName: "basic-kyc-level", ttlInSecs: 600 });
    await expectSigned(token!, cfg);
  });

  it("creates the applicant for a new player at the level", async () => {
    const cfg = config();
    const { deps, requests } = fakeDeps(queue(json(404, { description: "Applicant not found", code: 404, correlationId: "c1" }), json(201, applicant({ review: { reviewStatus: "init", reviewResult: null } })), json(200, { token: "t", userId: USER })));
    const result = await createSumsubAdapter(cfg, deps).createSession({ userId: USER, externalUserId: USER, email: "player@example.com", country: null, level: "basic-kyc-level", ttlSeconds: 99_999 });
    expect(result).toMatchObject({ kind: "ok", value: { applicantRef: APPLICANT, expiresAt: new Date(NOW.getTime() + 3_600_000) } });
    const create = requests[1]!;
    expect(create.method).toBe("POST");
    expect(create.url.pathname + create.url.search).toBe("/resources/applicants?levelName=basic-kyc-level");
    expect(JSON.parse(create.body)).toEqual({ externalUserId: USER, email: "player@example.com" });
    await expectSigned(create, cfg);
    expect(JSON.parse(requests[2]!.body).ttlInSecs).toBe(3600);
  });

  it("resolves a create race by reading again", async () => {
    const { deps, requests } = fakeDeps(queue(json(404, {}), json(409, { description: `Applicant with external user id '${USER}' already exists: ${APPLICANT}`, code: 409 }), json(200, applicant()), json(200, { token: "t" })));
    expect(await createSumsubAdapter(config(), deps).createSession({ userId: USER, externalUserId: USER, email: null, country: null, level: "basic-kyc-level", ttlSeconds: 600 }))
      .toMatchObject({ kind: "ok", value: { applicantRef: APPLICANT } });
    expect(requests).toHaveLength(4);
  });

  it("refuses a token or applicant issued for someone else", async () => {
    const token = fakeDeps(queue(json(200, applicant()), json(200, { token: "t", userId: "another-user" })));
    expect(await createSumsubAdapter(config(), token.deps).createSession({ userId: USER, externalUserId: USER, email: null, country: null, level: "basic-kyc-level", ttlSeconds: 600 }))
      .toEqual({ kind: "uncertain", reason: "malformed" });
    const other = fakeDeps(queue(json(200, applicant({ top: { externalUserId: "another-user" } }))));
    expect(await createSumsubAdapter(config(), other.deps).createSession({ userId: USER, externalUserId: USER, email: null, country: null, level: "basic-kyc-level", ttlSeconds: 600 }))
      .toEqual({ kind: "uncertain", reason: "malformed" });
    expect(other.logs.some((l) => l.fields.alert === "SUMSUB_APPLICANT_MISMATCH")).toBe(true);
  });

  it("refuses ids that could change the lookup path, without a call", async () => {
    const { deps, requests } = fakeDeps(queue());
    expect(await createSumsubAdapter(config(), deps).createSession({ userId: "x", externalUserId: "a/../b;c", email: null, country: null, level: "basic-kyc-level", ttlSeconds: 600 }))
      .toMatchObject({ kind: "rejected", code: "BAD_EXTERNAL_USER_ID" });
    expect(requests).toHaveLength(0);
  });

  it("maps auth, rate-limit and server failures", async () => {
    const cfg = config();
    const auth = fakeDeps(queue(json(401, { description: "Invalid signature", code: 401 })));
    expect(await createSumsubAdapter(cfg, auth.deps).getApplicant({ applicantRef: APPLICANT })).toMatchObject({ kind: "rejected", final: false, code: "PROVIDER_AUTH" });
    expect(auth.logs.some((l) => l.fields.alert === "SUMSUB_AUTH_REFUSED")).toBe(true);
    expect(logText(auth.logs)).not.toContain(cfg.secretKey);
    expect(logText(auth.logs)).not.toContain(cfg.appToken);
    expect(await createSumsubAdapter(cfg, fakeDeps(queue(json(429, {}))).deps).getApplicant({ applicantRef: APPLICANT })).toMatchObject({ kind: "rejected", final: false, code: "RATE_LIMITED" });
    expect(await createSumsubAdapter(cfg, fakeDeps(queue(json(500, {}))).deps).getApplicant({ applicantRef: APPLICANT })).toEqual({ kind: "uncertain", reason: "5xx" });
    expect(await createSumsubAdapter(cfg, fakeDeps(queue(new TypeError("reset"))).deps).getApplicant({ applicantRef: APPLICANT })).toEqual({ kind: "uncertain", reason: "network" });
  });
});

describe("Sumsub applicant results", () => {
  const read = async (body: unknown, status = 200) => {
    const { deps, requests, logs } = fakeDeps(queue(json(status, body)));
    return { result: await createSumsubAdapter(config(), deps).getApplicant({ applicantRef: APPLICANT }), requests, logs };
  };

  it("maps a completed GREEN review to VERIFIED with the Latin-script identity and the earliest document expiry", async () => {
    const { result, requests } = await read(applicant());
    expect(requests[0]!.url.pathname).toBe(`/resources/applicants/${APPLICANT}/one`);
    expect(result).toEqual({
      kind: "ok",
      value: {
        applicantRef: APPLICANT, userId: USER, decision: "VERIFIED", final: false, rejectReason: null, level: "basic-kyc-level",
        identity: { firstName: "Juergen", lastName: "Mueller", birthDate: "1989-07-16", country: "DE" },
        reviewDueAt: new Date("2029-05-31T00:00:00.000Z"),
        occurredAt: new Date("2026-10-29T12:20:31.000Z"),
      },
    });
  });

  it("a passed review sets screening CLEAR only for a level that screens, and never with a screening label", async () => {
    const answer = (labels: string[] = [], reviewAnswer = "GREEN") => ({
      id: APPLICANT, externalUserId: USER, createdAt: "2026-10-01 10:00:00", info: { firstNameEn: "Jane", lastNameEn: "Doe", dob: "1990-01-01", country: "MLT" },
      review: { reviewStatus: "completed", reviewResult: { reviewAnswer, rejectLabels: labels } },
    });
    const read = async (screeningIncluded: boolean, body: unknown) => {
      const adapter = createSumsubAdapter(config({ screeningIncluded }), fakeDeps(queue(json(200, body))).deps);
      const result = await adapter.getApplicant({ applicantRef: APPLICANT });
      if (result.kind !== "ok" || !result.value) throw new Error("no applicant");
      return result.value;
    };
    expect((await read(false, answer())).screening).toBeUndefined();
    expect(await read(true, answer())).toMatchObject({ decision: "VERIFIED", screening: "CLEAR" });
    expect((await read(true, answer(["SANCTIONS"]))).screening).toBeUndefined();
    expect((await read(true, answer(["PEP"]))).screening).toBeUndefined();
    expect(await read(true, answer(["SANCTIONS"], "RED"))).toMatchObject({ decision: "REJECTED", screening: "CONFIRMED_MATCH" });
  });

  it("reads RED reviews as final rejections or resubmission requests, with screening hits", async () => {
    expect((await read(applicant({ review: { reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL", rejectLabels: ["FORGERY", "SELFIE_MISMATCH"] } } }))).result)
      .toMatchObject({ kind: "ok", value: { decision: "REJECTED", final: true, rejectReason: "FORGERY,SELFIE_MISMATCH" } });
    expect((await read(applicant({ review: { reviewResult: { reviewAnswer: "RED", reviewRejectType: "RETRY", rejectLabels: ["BAD_PROOF_OF_IDENTITY"] } } }))).result)
      .toMatchObject({ kind: "ok", value: { decision: "RESUBMISSION_REQUESTED", final: false } });
    expect((await read(applicant({ review: { reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL", rejectLabels: ["SANCTIONS"] } } }))).result)
      .toMatchObject({ kind: "ok", value: { decision: "REJECTED", screening: "CONFIRMED_MATCH" } });
    expect((await read(applicant({ review: { reviewResult: { reviewAnswer: "RED", rejectLabels: ["PEP"] } } }))).result)
      .toMatchObject({ kind: "ok", value: { decision: "REJECTED", final: false, screening: "POTENTIAL_MATCH" } });
  });

  it("decides nothing until the review is completed", async () => {
    for (const reviewStatus of ["init", "pending", "prechecked", "queued", "onHold", "awaitingService", "awaitingUser"]) {
      // A GREEN answer on an unfinished review is not a decision.
      expect((await read(applicant({ review: { reviewStatus } }))).result, reviewStatus).toMatchObject({ kind: "ok", value: { decision: "PENDING", final: false } });
    }
  });

  it("returns VERIFIED without identity (the core keeps the player pending) when the identity is incomplete", async () => {
    const { result, logs } = await read(applicant({ info: { dob: "1989-02-30", country: "ZZZ" } }));
    expect(result.kind === "ok" && result.value).toMatchObject({ decision: "VERIFIED" });
    expect(result.kind === "ok" && result.value && "identity" in result.value).toBe(false);
    expect(logs.some((l) => l.fields.alert === "SUMSUB_IDENTITY_INCOMPLETE")).toBe(true);
  });

  it("answers null for an unknown applicant and uncertain for another applicant's answer", async () => {
    expect((await read({ description: "Not found", code: 404 }, 404)).result).toEqual({ kind: "ok", value: null });
    expect((await read(applicant({ top: { id: "000000000000000000000000" } }))).result).toEqual({ kind: "uncertain", reason: "malformed" });
    expect((await read("<html>")).result).toEqual({ kind: "uncertain", reason: "malformed" });
  });

  it("reads by externalUserId when the applicant id is unknown", async () => {
    const { deps, requests } = fakeDeps(queue(json(200, applicant())));
    await createSumsubAdapter(config(), deps).getApplicant({ externalUserId: USER });
    expect(requests[0]!.url.pathname).toBe(`/resources/applicants/-;externalUserId=${USER}/one`);
  });
});

describe("Sumsub webhooks", () => {
  // The documented applicantReviewed shape (user-verification webhooks page).
  const REVIEWED = JSON.stringify({
    applicantId: APPLICANT, inspectionId: "5cb56e8e0a975a35f333cb84", applicantType: "individual", correlationId: "req-a260b669-4f14-4bb5-a4c5-ac0218acb9a4",
    levelName: "basic-kyc-level", sandboxMode: true, externalUserId: USER, type: "applicantReviewed",
    reviewResult: { moderationComment: "Dear Juergen, ...", clientComment: "internal note", reviewAnswer: "RED", rejectLabels: ["UNSATISFACTORY_PHOTOS"], reviewRejectType: "RETRY" },
    reviewStatus: "completed", createdAtMs: "2026-10-29 12:20:31.321", clientId: "pokerclient",
  });
  async function hook(secret: string, body: string, algorithm: string | null = "HMAC_SHA256_HEX") {
    const hash = algorithm === "HMAC_SHA512_HEX" ? "SHA-512" : algorithm === "HMAC_SHA1_HEX" ? "SHA-1" : "SHA-256";
    const headers = new Headers({ "content-type": "application/json", "x-payload-digest": hex(await hmacBytes(hash, secret, body)) });
    if (algorithm) headers.set("x-payload-digest-alg", algorithm);
    return { method: "POST", url: new URL("https://poker-payments-preview.example.workers.dev/webhooks/sandbox-sumsub"), headers, rawBody: bytes(body), receivedAt: NOW, sourceIp: null };
  }

  it("verifies x-payload-digest and gives a KYC hint without identity or comments", async () => {
    const cfg = config();
    const adapter = createSumsubAdapter(cfg, fakeDeps(queue()).deps);
    const result = await adapter.verifyWebhook(await hook(cfg.webhookSecret, REVIEWED));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme).toBe("sumsub-digest");
    const [event] = result.events;
    expect(event).toMatchObject({
      eventType: "applicantReviewed", objectType: "KYC", objectRef: APPLICANT, merchantRef: USER,
      kyc: { applicantRef: APPLICANT, userId: USER, decision: "RESUBMISSION_REQUESTED", final: false, level: "basic-kyc-level", occurredAt: new Date("2026-10-29T12:20:31.321Z") },
    });
    expect(event!.providerEventId).toMatch(/^d_[0-9a-f]{64}$/);
    // The same notification resent is the same event; another one is not.
    const again = await adapter.verifyWebhook(await hook(cfg.webhookSecret, REVIEWED));
    expect(again.ok && again.events[0]!.providerEventId).toBe(event!.providerEventId);
    const pending = REVIEWED.replace('"type":"applicantReviewed"', '"type":"applicantPending"').replace('"reviewStatus":"completed"', '"reviewStatus":"pending"');
    const other = await adapter.verifyWebhook(await hook(cfg.webhookSecret, pending));
    expect(other.ok && other.events[0]!.providerEventId).not.toBe(event!.providerEventId);
    const stored = JSON.stringify(event!.payload);
    expect(stored).not.toContain("Juergen");
    expect(stored).not.toContain("internal note");
    expect(stored).toContain("UNSATISFACTORY_PHOTOS");
  });

  it("accepts HMAC_SHA512_HEX and the default (no algorithm header), refuses legacy SHA-1", async () => {
    const cfg = config();
    const adapter = createSumsubAdapter(cfg, fakeDeps(queue()).deps);
    expect((await adapter.verifyWebhook(await hook(cfg.webhookSecret, REVIEWED, "HMAC_SHA512_HEX"))).ok).toBe(true);
    expect((await adapter.verifyWebhook(await hook(cfg.webhookSecret, REVIEWED, null))).ok).toBe(true);
    expect(await adapter.verifyWebhook(await hook(cfg.webhookSecret, REVIEWED, "HMAC_SHA1_HEX"))).toEqual({ ok: false, reason: "unsupported_scheme" });
  });

  it("refuses a wrong secret, a tampered body, a missing digest and GET", async () => {
    const cfg = config();
    const adapter = createSumsubAdapter(cfg, fakeDeps(queue()).deps);
    expect(await adapter.verifyWebhook(await hook(randomSecret(), REVIEWED))).toEqual({ ok: false, reason: "signature" });
    const signed = await hook(cfg.webhookSecret, REVIEWED);
    expect(await adapter.verifyWebhook({ ...signed, rawBody: bytes(REVIEWED.replace("RETRY", "FINAL")) })).toEqual({ ok: false, reason: "signature" });
    expect(await adapter.verifyWebhook({ ...signed, headers: new Headers() })).toEqual({ ok: false, reason: "signature" });
    expect(await adapter.verifyWebhook({ ...signed, method: "GET" })).toEqual({ ok: false, reason: "format" });
  });

  it("refuses an event from the other environment and ignores company applicants", async () => {
    const cfg = config({ mode: "live", appToken: `prd:${randomSecret()}` });
    const { deps, logs } = fakeDeps(queue());
    const adapter = createSumsubAdapter(cfg, deps);
    expect(await adapter.verifyWebhook(await hook(cfg.webhookSecret, REVIEWED))).toEqual({ ok: false, reason: "format" });
    expect(logs.some((l) => l.fields.alert === "SUMSUB_WEBHOOK_MODE")).toBe(true);
    const company = REVIEWED.replace('"sandboxMode":true', '"sandboxMode":false').replace('"applicantType":"individual"', '"applicantType":"company"');
    expect(await adapter.verifyWebhook(await hook(cfg.webhookSecret, company))).toEqual({ ok: true, scheme: "sumsub-digest", events: [] });
  });

  it("refuses signed bodies that are not unambiguous JSON", async () => {
    const cfg = config();
    const adapter = createSumsubAdapter(cfg, fakeDeps(queue()).deps);
    for (const body of ["nope", '{"type":"applicantReviewed","type":"applicantReset"}', '{"applicantId":"x"}']) {
      expect(await adapter.verifyWebhook(await hook(cfg.webhookSecret, body)), body).toEqual({ ok: false, reason: "format" });
    }
  });
});

describe("country codes", () => {
  it("maps every ISO 3166-1 alpha-3 code (plus Kosovo) to a distinct alpha-2 code", () => {
    expect(ALPHA3_TO_ALPHA2.size).toBe(250);
    expect(new Set(ALPHA3_TO_ALPHA2.values()).size).toBe(250);
    for (const [a3, a2] of ALPHA3_TO_ALPHA2) {
      expect(a3).toMatch(/^[A-Z]{3}$/);
      expect(a2).toMatch(/^[A-Z]{2}$/);
    }
    expect([alpha3ToAlpha2("DEU"), alpha3ToAlpha2("mlt"), alpha3ToAlpha2("GBR"), alpha3ToAlpha2("XKX"), alpha3ToAlpha2("ZZZ"), alpha3ToAlpha2("DE"), alpha3ToAlpha2(null)])
      .toEqual(["DE", "MT", "GB", "XK", null, null, null]);
  });
});
