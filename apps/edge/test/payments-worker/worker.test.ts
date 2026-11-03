/**
 * The poker-payments Worker itself (vitest.payments.config.ts:
 * src/payments/worker.ts with wrangler.payments.jsonc's Durable Objects, in
 * sandbox mode): the public routes, the RPC entrypoint's gates, and one full
 * player journey through the built-in sandbox pages: verify identity, choose
 * limits, deposit by card, credited by a signed webhook, all on the real
 * database. With PAYMENTS_MODE=off nothing touches the database.
 */
import { createExecutionContext, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { adminPaymentsAction, stepUpBind } from "@poker/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { createPrisma } from "../../src/db/client";
import type { Caller, PaymentsApi } from "../../src/payments/contract";
import type { PaymentsEnv } from "../../src/payments/env";
import { PaymentsRpc } from "../../src/payments/worker";

const bindings = env as unknown as PaymentsEnv & { HYPERDRIVE_TEST_RUNTIME?: Hyperdrive; HYPERDRIVE_TEST_ADMIN?: Hyperdrive; POKER_REQUIRE_DB_TESTS?: string };
const ORIGIN = "https://poker-payments.test.example";

function rpc(overrides: Partial<Record<keyof PaymentsEnv, unknown>> = {}): PaymentsApi {
  return new PaymentsRpc(createExecutionContext(), { ...bindings, ...overrides } as PaymentsEnv) as unknown as PaymentsApi;
}

let runtime: PrismaClient | null = null;

beforeAll(async () => {
  const url = bindings.HYPERDRIVE_TEST_RUNTIME?.connectionString;
  if (!url || !bindings.HYPERDRIVE_PAYMENTS) {
    if (bindings.POKER_REQUIRE_DB_TESTS === "1") throw new Error("POKER_REQUIRE_DB_TESTS=1 but the payments worker project has no test database");
    return;
  }
  runtime = createPrisma(url);
  await runtime.$queryRaw`SELECT 1`;
}, 60_000);

afterAll(async () => {
  await runtime?.$disconnect();
});

async function player(): Promise<Caller> {
  const tag = crypto.randomUUID().slice(0, 8);
  const user = await runtime!.user.create({ data: { username: `pw_${tag}`, email: `pw_${tag}@example.com`, emailVerifiedAt: new Date() }, select: { id: true } }) as { id: string };
  const session = await runtime!.session.create({ data: { userId: user.id, refreshToken: `rt_${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } }) as { id: string };
  return { userId: user.id, sessionId: session.id, requestId: crypto.randomUUID(), ip: "203.0.113.20", ipCountry: "MT", userAgent: "vitest" };
}

/** An administrator turns a payments switch on through the admin RPC (passkey grant bound to the switch). */
async function switchOn(api: PaymentsApi, key: "DEPOSIT_CARD"): Promise<void> {
  const admin = await player();
  const superuser = createPrisma(bindings.HYPERDRIVE_TEST_ADMIN!.connectionString);
  try {
    await superuser.$executeRaw`UPDATE public."User" SET "role" = 'ADMIN' WHERE "id" = ${admin.userId}`;
  } finally {
    await superuser.$disconnect();
  }
  const createdAt = new Date();
  const grant = await runtime!.stepUpGrant.create({
    data: {
      userId: admin.userId, sessionId: admin.sessionId, purpose: "admin_payments", method: "PASSKEY", createdAt, expiresAt: new Date(createdAt.getTime() + 120_000),
      bindHash: await stepUpBind(adminPaymentsAction({ subject: `switch:${key}`, decision: "ON" })),
    },
    select: { id: true },
  }) as { id: string };
  const result = await api.adminSetSwitch({ ...admin, accessJwt: null }, { key, enabled: true, reason: "worker tests", stepUpGrantId: grant.id });
  expect(result).toMatchObject({ ok: true, value: { switch: { key, enabled: true }, approvalsRemaining: 0 } });
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}

describe("public routes", () => {
  it("GET /health reports the mode and role isolation, without secrets", async () => {
    const response = await SELF.fetch(`${ORIGIN}/health`);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["mode", "ok", "roleIsolation", "settlementAsset"]);
    expect(body.mode).toBe("sandbox");
    expect(body.settlementAsset).toBe("TEST_EUR");
    if (runtime) {
      expect(response.status).toBe(200);
      expect(body.roleIsolation).toBe(true);
    }
  });

  it("everything else is 404; an unsigned webhook is 401; a GET on a webhook is 405", async () => {
    expect((await SELF.fetch(`${ORIGIN}/`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/wallet`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/webhooks/nuvei`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/sandbox/pay/sbx_pay_000000000000000000000000?sig=x`)).status).toBe(404);
    if (!runtime) return;
    expect((await SELF.fetch(`${ORIGIN}/webhooks/sandbox-card`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
    expect((await SELF.fetch(`${ORIGIN}/webhooks/sandbox-card`)).status).toBe(405);
    const big = "x".repeat(300 * 1024);
    expect((await SELF.fetch(`${ORIGIN}/webhooks/sandbox-card`, { method: "POST", body: big })).status).toBe(413);
  });
});

/** Every PaymentsApi method, and nothing else, is callable by the binder (poker-api). */
const RPC_METHODS = [
  "addCryptoDestination", "adminCustodySnapshot", "adminDecideWithdrawal", "adminGetWithdrawal", "adminListDeposits", "adminListEvents",
  "adminAcceptReactivation", "adminListReactivations", "adminListReconciliationIssues", "adminListReconciliationRuns", "adminListSwitches",
  "adminListWithdrawals", "adminRequeueEvent", "adminResolveDeposit", "adminResolveReconciliationIssue", "adminResolveUncertain",
  "adminRestoreInstrument", "adminSetRestriction", "adminSetScreening", "adminSetSwitch",
  "adminUserLedger", "cancelDeposit", "cancelWithdrawal", "createDeposit", "getDeposit", "getWithdrawal", "health", "listInstruments",
  "listTransactions", "listWithdrawals", "markLimitsPrompted", "onSelfExcluded", "prepareCryptoDestination", "quoteWithdrawal",
  "realMoneySummary", "requestWithdrawal", "revokeInstrument", "securityLockdown", "startKyc", "verifyNotMeToken",
] as const satisfies readonly (keyof PaymentsApi)[];
type UnlistedRpc = Exclude<keyof PaymentsApi, (typeof RPC_METHODS)[number]>;
const everyMethodListed: [UnlistedRpc] extends [never] ? true : UnlistedRpc = true;
void everyMethodListed;

describe("RPC gates", () => {
  it("exposes exactly the PaymentsApi methods over RPC; the helpers that hold the database client are #private", () => {
    const exposed = Object.getOwnPropertyNames(PaymentsRpc.prototype).filter((name) => name !== "constructor").sort();
    expect(exposed).toEqual([...RPC_METHODS].sort());
  });

  it("PAYMENTS_MODE=off: the summary is off, money calls are REAL_MONEY_DISABLED, the lockdown is a no-op", async () => {
    const off = rpc({ PAYMENTS_MODE: "off", HYPERDRIVE_PAYMENTS: undefined });
    const caller: Caller = { userId: "u1", sessionId: "s1", requestId: "r1", ip: null, ipCountry: null, userAgent: null };
    expect(await off.realMoneySummary(caller)).toEqual({ ok: true, value: { mode: "off", realMoney: null } });
    expect(await off.createDeposit(caller, { method: "CARD", amount: "10.00", clientRequestId: crypto.randomUUID() })).toMatchObject({ ok: false, status: 403, code: "REAL_MONEY_DISABLED" });
    expect(await off.adminListSwitches({ ...caller, accessJwt: null })).toMatchObject({ ok: false, code: "REAL_MONEY_DISABLED" });
    expect(await off.securityLockdown({ userId: "u1", requestId: "r1" }, "NOT_ME")).toEqual({ ok: true, value: null });
    expect(await off.health()).toEqual({ ok: true, mode: "off", settlementAsset: null, roleIsolation: false });
  });

  it("a refused configuration (sandbox in production) answers INTERNAL and moves nothing", async () => {
    const refused = rpc({ ENVIRONMENT: "production" });
    const caller: Caller = { userId: "u1", sessionId: "s1", requestId: "r1", ip: null, ipCountry: null, userAgent: null };
    expect(await refused.createDeposit(caller, { method: "CARD", amount: "10.00", clientRequestId: crypto.randomUUID() })).toMatchObject({ ok: false, status: 500, code: "INTERNAL" });
  });

  it("an unknown or dead session is FORBIDDEN", async (context) => {
    if (!runtime) return context.skip();
    const caller = await player();
    const result = await rpc().listInstruments({ ...caller, sessionId: "not-this-session" });
    expect(result).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
  });
});

describe("sandbox journey", () => {
  it("verify identity, choose limits, deposit by card on the hosted page, credited once", async (context) => {
    if (!runtime) return context.skip();
    const api = rpc();
    const caller = await player();

    // KYC through the sandbox verification page.
    const kyc = await api.startKyc(caller);
    expect(kyc.ok).toBe(true);
    if (!kyc.ok) return;
    expect(kyc.value.provider).toBe("sandbox-kyc");
    const page = await SELF.fetch(kyc.value.url!);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // The form post ends in a 303 to the site: form-action must allow it or Chromium stops the navigation.
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://poker-web.test.example;");
    expect(await page.text()).toContain("SANDBOX: test payments only");
    const crossSite = await SELF.fetch(kyc.value.url!, { method: "POST", body: "decision=approve", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const approved = await SELF.fetch(kyc.value.url!, {
      method: "POST", redirect: "manual", body: "decision=approve&firstName=Test&lastName=Player&birthDate=1990-01-01&country=MT",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe("https://poker-web.test.example/wallet/verify/return");
    const verified = await until(() => api.realMoneySummary(caller), (r) => r.ok && r.value.realMoney?.kyc.status === "VERIFIED");
    expect(verified.ok && verified.value.realMoney?.kyc.status).toBe("VERIFIED");

    // Limits: the first choice unlocks deposits.
    expect(verified.ok && verified.value.realMoney?.reasons).toContain("LIMITS_SETUP_REQUIRED");
    expect(await api.markLimitsPrompted(caller)).toEqual({ ok: true, value: null });

    // An admin opens card deposits (all switches start off); then the card deposit on the hosted page.
    await switchOn(api, "DEPOSIT_CARD");
    const key = crypto.randomUUID();
    const started = await api.createDeposit(caller, { method: "CARD", amount: "25.00", saveCard: true, clientRequestId: key });
    expect(started).toMatchObject({ ok: true, value: { replay: false, deposit: { status: "PENDING", asset: "TEST_EUR", amount: "25.00" }, next: { type: "REDIRECT" } } });
    if (!started.ok || started.value.next?.type !== "REDIRECT") return;
    const replay = await api.createDeposit(caller, { method: "CARD", amount: "25.00", saveCard: true, clientRequestId: key });
    expect(replay).toMatchObject({ ok: true, value: { replay: true, deposit: { id: started.value.deposit.id } } });
    const conflict = await api.createDeposit(caller, { method: "CARD", amount: "26.00", saveCard: true, clientRequestId: key });
    expect(conflict).toMatchObject({ ok: false, status: 409, code: "IDEMPOTENCY_CONFLICT" });

    const hosted = started.value.next.url;
    expect(hosted.startsWith(`${ORIGIN}/sandbox/pay/`)).toBe(true);
    expect((await SELF.fetch(hosted.replace(/sig=[^&]+/, "sig=forged-forged-forged-forged-12"))).status).toBe(404);
    const paid = await SELF.fetch(hosted, { method: "POST", redirect: "manual", body: "outcome=approve", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN } });
    expect(paid.status).toBe(303);
    expect(paid.headers.get("location")).toBe(`https://poker-web.test.example/wallet?deposit=${started.value.deposit.id}`);
    const credited = await until(() => api.getDeposit(caller, started.value.deposit.id), (r) => r.ok && r.value.status === "CREDITED");
    expect(credited).toMatchObject({ ok: true, value: { status: "CREDITED", creditedAmount: "25.00" } });
    // A second press changes nothing.
    await SELF.fetch(hosted, { method: "POST", redirect: "manual", body: "outcome=approve", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN } });
    const summary = await api.realMoneySummary(caller);
    expect(summary).toMatchObject({ ok: true, value: { mode: "sandbox", realMoney: { available: "25.00", asset: "TEST_EUR" } } });
    const history = await api.listTransactions(caller, {});
    expect(history).toMatchObject({ ok: true, value: { items: [{ kind: "DEPOSIT", amount: "25.00", status: "CREDITED" }] } });
    const instruments = await api.listInstruments(caller);
    expect(instruments.ok && instruments.value.map((i) => i.kind)).toEqual(["CARD"]);
  }, 60_000);

  it("the dispatcher: a kick runs a tick, which re-arms the alarm", async () => {
    const stub = bindings.PAYOUT_DISPATCHER!.getByName("payouts");
    await stub.kick();
    const next = await until(() => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()), (at) => at !== null && at > Date.now());
    expect(next).not.toBeNull();
  }, 30_000);
});
