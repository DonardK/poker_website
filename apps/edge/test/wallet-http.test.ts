/**
 * poker-api's wallet and payments-admin routes (docs/money/WALLET.md
 * sections 11 and 14.4) with a mocked PAYMENTS service binding, on the memory
 * harness. Covers: the "off" wallet without a binding, the error and step-up
 * bodies, Idempotency-Key, 200 on replay, a failing binding, rate limits,
 * the caller poker-api forwards, the admin guard, the payments
 * "This wasn't me" link and the account lockdown hook.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { onAccountLockdown } from "../src/auth/lockdown";
import type { Env } from "../src/env";
import { registerAdminPayments } from "../src/http/admin-payments";
import { registerWallet } from "../src/http/wallet";
import { rpcFail, rpcOk, type RpcResult } from "../src/payments/contract";
import { NOT_ME_TTL_MS, signNotMe } from "../src/payments/emails";
import { createHarness, type Harness } from "./harness";
import { adopt, signIn, signUp, type Account } from "./support/accounts";

type Call = { method: string; args: unknown[] };

/** A PAYMENTS binding double: every method records its call and answers `answers[method]` (default ok). */
function paymentsMock(answers: Record<string, (...args: unknown[]) => RpcResult<unknown> | Promise<RpcResult<unknown>>> = {}) {
  const calls: Call[] = [];
  const binding = new Proxy({}, {
    get(_target, method: string) {
      if (method === "then") return undefined;
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        const answer = answers[method];
        return answer ? answer(...args) : rpcOk(null);
      };
    },
  });
  return { binding, calls };
}

const KEY = () => crypto.randomUUID();
const summary = { mode: "sandbox", realMoney: { state: "ACTIVE", reasons: [], asset: "TEST_EUR", decimals: 2, available: "12.50", pendingWithdrawals: "0.00", canDeposit: true, canWithdraw: true, methods: { deposit: ["CARD"], withdraw: ["CARD"] }, cryptoAssets: [], kyc: { status: "VERIFIED", requiredForDeposit: true }, limits: { DAY: null, WEEK: null, MONTH: null } } };

function harness(payments: unknown | null, extra: Record<string, unknown> = {}): Harness {
  return createHarness({ ...(payments ? { PAYMENTS: payments } : {}), ...extra } as unknown as Record<string, string>);
}

async function player(h: Harness, name: string): Promise<Account> {
  return signUp(h, name, { verified: true });
}

describe("wallet without the PAYMENTS binding (production today)", () => {
  it("needs a session, shows play chips only, and refuses every money route", async () => {
    const h = harness(null);
    expect((await h.request("/wallet", { method: "GET" })).status).toBe(401);
    const a = await player(h, "Wallet_Off");
    const wallet = await h.request("/wallet", { method: "GET", token: a.accessToken });
    expect(wallet.status).toBe(200);
    expect(wallet.body).toEqual({ mode: "off", realMoney: null, play: { chips: 10000, redeemable: false } });
    expect(wallet.headers.get("cache-control")).toContain("no-store");
    const deposit = await h.request("/wallet/deposits", { token: a.accessToken, headers: { "idempotency-key": KEY() }, body: { method: "CARD", amount: "10.00" } });
    expect(deposit.status).toBe(403);
    expect(deposit.body).toMatchObject({ code: "REAL_MONEY_DISABLED" });
    expect((await h.request("/wallet/withdrawals/quote", { token: a.accessToken, body: { instrumentId: crypto.randomUUID(), amount: "20.00" } })).body.code).toBe("REAL_MONEY_DISABLED");
    expect((await h.request("/wallet/transactions", { method: "GET", token: a.accessToken })).body).toEqual({ items: [], next: null });
    expect((await h.request("/wallet/withdrawals", { method: "GET", token: a.accessToken })).body).toEqual({ withdrawals: [], next: null });
  }, 60_000);
});

describe("wallet with the PAYMENTS binding", () => {
  it("forwards the caller (session, address, Cloudflare country) and merges play chips into the summary", async () => {
    const mock = paymentsMock({ realMoneySummary: () => rpcOk(summary) });
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Sum");
    const response = await h.request("/wallet", { method: "GET", token: a.accessToken, ip: "203.0.113.9", country: "MT" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...summary, play: { chips: 10000, redeemable: false } });
    const caller = mock.calls[0]!.args[0] as Record<string, unknown>;
    expect(caller).toMatchObject({ userId: a.userId, sessionId: a.sessionId, ip: "203.0.113.9", ipCountry: "MT", userAgent: "vitest" });
    expect(typeof caller.requestId).toBe("string");
  }, 60_000);

  it("money routes need an Idempotency-Key (UUID v4); payments is not asked without one", async () => {
    const mock = paymentsMock();
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Idem");
    for (const [path, body] of [["/wallet/deposits", { method: "CARD", amount: "10.00" }], ["/wallet/withdrawals", { quoteId: crypto.randomUUID(), stepUpGrantId: "g1" }],
      ["/wallet/instruments/crypto", { asset: "BTC", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", stepUpGrantId: "g1" }]] as const) {
      const missing = await h.request(path, { token: a.accessToken, body });
      expect(missing.status, path).toBe(400);
      expect(missing.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect((await h.request(path, { token: a.accessToken, body, headers: { "idempotency-key": "not-a-uuid" } })).status, path).toBe(400);
    }
    expect(mock.calls).toHaveLength(0);
  }, 60_000);

  it("201 for a new deposit, 200 for a replay; the key reaches payments as clientRequestId", async () => {
    let replay = false;
    const mock = paymentsMock({ createDeposit: () => rpcOk({ deposit: { id: "d1" }, next: null, replay }) });
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Dep");
    const key = KEY();
    const first = await h.request("/wallet/deposits", { token: a.accessToken, headers: { "idempotency-key": key }, body: { method: "CARD", amount: "10.00", saveCard: true } });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ deposit: { id: "d1" }, next: null });
    replay = true;
    expect((await h.request("/wallet/deposits", { token: a.accessToken, headers: { "idempotency-key": key }, body: { method: "CARD", amount: "10.00", saveCard: true } })).status).toBe(200);
    expect(mock.calls[0]!.args[1]).toEqual({ method: "CARD", amount: "10.00", saveCard: true, clientRequestId: key });
    // Bodies are validated before payments is asked.
    const bad = await h.request("/wallet/deposits", { token: a.accessToken, headers: { "idempotency-key": KEY() }, body: { method: "CARD", amount: "10.001" } });
    expect(bad.status).toBe(422);
    expect(mock.calls).toHaveLength(2);
  }, 60_000);

  it("maps refusals to the documented status and body; STEP_UP_REQUIRED is 403 with purpose, bind and methods", async () => {
    const stepUp = { purpose: "withdrawal", bind: "a".repeat(64), methods: ["PASSKEY", "TOTP", "PASSWORD_EMAIL"] };
    const mock = paymentsMock({
      requestWithdrawal: () => rpcFail("STEP_UP_REQUIRED", "Confirm it's you.", { stepUp: stepUp as never }),
      quoteWithdrawal: () => rpcFail("DEPOSIT_LIMIT_EXCEEDED", "Over your limit.", { details: { remaining: "40.00" } }),
      getDeposit: () => rpcFail("NOT_FOUND", "That deposit does not exist."),
    });
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Errs");
    const step = await h.request("/wallet/withdrawals", { token: a.accessToken, headers: { "idempotency-key": KEY() }, body: { quoteId: crypto.randomUUID(), stepUpGrantId: "grant_1" } });
    expect(step.status).toBe(403);
    expect(step.body).toEqual({ error: "Confirm it's you.", code: "STEP_UP_REQUIRED", ...stepUp });
    const quote = await h.request("/wallet/withdrawals/quote", { token: a.accessToken, body: { instrumentId: crypto.randomUUID(), amount: "60.00" } });
    expect(quote.status).toBe(422);
    expect(quote.body).toEqual({ error: "Over your limit.", code: "DEPOSIT_LIMIT_EXCEEDED", details: { remaining: "40.00" } });
    expect((await h.request(`/wallet/deposits/${crypto.randomUUID()}`, { method: "GET", token: a.accessToken })).status).toBe(404);
  }, 60_000);

  it("a security hold or an unverified email stops a grant-consuming action before payments is asked", async () => {
    const mock = paymentsMock();
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Hold");
    h.db.user(a.userId)!.securityHoldUntil = new Date(Date.now() + 3_600_000);
    const held = await h.request("/wallet/withdrawals", { token: a.accessToken, headers: { "idempotency-key": KEY() }, body: { quoteId: crypto.randomUUID(), stepUpGrantId: "grant_1" } });
    expect(held.status).toBe(403);
    expect(held.body.code).toBe("SECURITY_HOLD");
    const b = await signUp(h, "Wallet_Unverified");
    const unverified = await h.request("/wallet/instruments/crypto", { token: b.accessToken, headers: { "idempotency-key": KEY() }, body: { asset: "BTC", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", stepUpGrantId: "g1" } });
    expect(unverified.body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(mock.calls).toHaveLength(0);
  }, 60_000);

  it("a dropped binding or a malformed answer is 503 PAYMENTS_UNAVAILABLE with Retry-After", async () => {
    const mock = paymentsMock({ getWithdrawal: () => { throw new Error("binding dropped"); }, listInstruments: () => ({ nope: true }) as never });
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Down");
    const down = await h.request(`/wallet/withdrawals/${crypto.randomUUID()}`, { method: "GET", token: a.accessToken });
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: "PAYMENTS_UNAVAILABLE", retryable: true });
    expect(down.headers.get("retry-after")).toBe("5");
    expect((await h.request("/wallet/instruments", { method: "GET", token: a.accessToken })).status).toBe(503);
  }, 60_000);

  it("state-changing wallet routes share RL_CREDENTIALS by account; the not-me link by IP; reads are not limited by it", async () => {
    const seen: string[] = [];
    const gate = { block: false };
    const limiter = { limit: async ({ key }: { key: string }) => { if (gate.block) seen.push(key); return { success: !gate.block }; } };
    const mock = paymentsMock({ listInstruments: () => rpcOk([]) });
    const h = harness(mock.binding, { RL_CREDENTIALS: limiter });
    const a = await player(h, "Wallet_Rate");
    gate.block = true;
    const limited = await h.request("/wallet/withdrawals/quote", { token: a.accessToken, body: { instrumentId: crypto.randomUUID(), amount: "20.00" } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await h.request("/wallet/not-me", { ip: "203.0.113.77", body: { token: "w1.aaaaaaaaaa.bbbbbbbbbb" } })).status).toBe(429);
    expect((await h.request("/wallet/instruments", { method: "GET", token: a.accessToken })).status).toBe(200);
    expect(seen).toEqual([`wallet:user:${a.userId}`, "ip:203.0.113.77"]);
    expect(mock.calls.map((c) => c.method)).toEqual(["listInstruments"]);
  }, 60_000);

  it("a cross-site POST is refused by the existing origin check", async () => {
    const mock = paymentsMock();
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Csrf");
    const response = await h.request("/wallet/deposits", {
      token: a.accessToken, headers: { "idempotency-key": KEY(), origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: { method: "CARD", amount: "10.00" },
    });
    expect(response.status).toBe(403);
    expect(mock.calls).toHaveLength(0);
  }, 60_000);

  it("deposit limits: written by poker-api, the first choice is reported to payments", async () => {
    const mock = paymentsMock();
    const h = harness(mock.binding);
    const a = await player(h, "Wallet_Limits");
    const empty = await h.request("/wallet/limits", { method: "GET", token: a.accessToken });
    expect(empty.body).toEqual({ deposit: { DAY: { active: null, pending: null }, WEEK: { active: null, pending: null }, MONTH: { active: null, pending: null } } });
    const none = await h.request("/wallet/limits", { token: a.accessToken, body: { period: "WEEK", amount: null } });
    expect(none.status).toBe(200);
    const set = await h.request("/wallet/limits", { token: a.accessToken, body: { period: "DAY", amount: "100.00" } });
    expect(set.body.deposit.DAY).toEqual({ active: "100.00", pending: null });
    expect(mock.calls.filter((c) => c.method === "markLimitsPrompted")).toHaveLength(2);
    expect((await h.request("/wallet/limits", { token: a.accessToken, body: { period: "YEAR", amount: "1" } })).status).toBe(422);
  }, 60_000);

  it("a limit of zero is a 422 the player can act on, never a retryable 503", async () => {
    const h = harness(paymentsMock().binding);
    const a = await player(h, "Wallet_Zero");
    for (const amount of ["0", "0.00"]) {
      const response = await h.request("/wallet/limits", { token: a.accessToken, body: { period: "DAY", amount } });
      expect(response.status, amount).toBe(422);
      expect(response.body.code).toBe("VALIDATION");
      expect(response.body.error).toMatch(/above zero/);
      expect(response.body.retryable).toBeUndefined();
    }
    expect((await h.request("/wallet/limits", { method: "GET", token: a.accessToken })).body.deposit.DAY).toEqual({ active: null, pending: null });
  }, 60_000);
});

describe("payments admin routes", () => {
  it("restoring a card, accepting a return and naming a refund's destination reach payments, validated, for admins only", async () => {
    const mock = paymentsMock({
      adminRestoreInstrument: () => rpcOk({ instrument: null, approvalsRemaining: 1 }),
      adminAcceptReactivation: () => rpcOk({ accessRestoredAt: new Date(0).toISOString() }),
      adminListReactivations: () => rpcOk({ items: [], next: null }),
      adminDecideWithdrawal: () => rpcOk({ withdrawal: {}, approvalsRemaining: 0 }),
      adminSetScreening: () => rpcOk({ compliance: {}, approvalsRemaining: 1 }),
    });
    const h = harness(mock.binding);
    const a = await player(h, "Restore_Player");
    const id = crypto.randomUUID();
    const restore = `/admin/users/${a.userId}/instruments/${id}/restore`;
    expect((await h.request(restore, { token: a.accessToken, body: { reason: "x", stepUpGrantId: "g1" } })).status).toBe(403);
    const admin = await player(h, "Restore_Admin");
    h.db.user(admin.userId)!.role = "ADMIN";
    expect((await h.request(restore, { token: admin.accessToken, body: { stepUpGrantId: "g1" } })).status).toBe(422);
    expect((await h.request(`/admin/users/${a.userId}/instruments/not-a-uuid/restore`, { token: admin.accessToken, body: { reason: "x", stepUpGrantId: "g1" } })).status).toBe(404);
    expect((await h.request(restore, { token: admin.accessToken, body: { reason: "owner's card", stepUpGrantId: "g1" } })).body).toEqual({ instrument: null, approvalsRemaining: 1 });
    expect(mock.calls.at(-1)).toMatchObject({ method: "adminRestoreInstrument", args: [expect.objectContaining({ userId: admin.userId }), a.userId, id, { reason: "owner's card", stepUpGrantId: "g1" }] });
    expect((await h.request("/admin/payments/self-exclusions", { method: "GET", token: admin.accessToken })).status).toBe(200);
    expect((await h.request(`/admin/payments/self-exclusions/${id}/accept`, { token: admin.accessToken, body: { note: "reviewed", stepUpGrantId: "g1" } })).status).toBe(200);
    expect((await h.request(`/admin/payments/withdrawals/${id}/approve`, { token: admin.accessToken, body: { refundInstrumentId: "nope", stepUpGrantId: "g1" } })).status).toBe(422);
    expect((await h.request(`/admin/payments/withdrawals/${id}/approve`, { token: admin.accessToken, body: { refundInstrumentId: id, stepUpGrantId: "g1" } })).status).toBe(200);
    expect(mock.calls.at(-1)).toMatchObject({ method: "adminDecideWithdrawal", args: [expect.anything(), id, { decision: "APPROVE", refundInstrumentId: id, stepUpGrantId: "g1" }] });
    // A person's screening decision: validated here, decided (and counted) by payments.
    const screening = `/admin/users/${a.userId}/screening`;
    expect((await h.request(screening, { token: a.accessToken, body: { status: "CLEAR", reason: "x", stepUpGrantId: "g1" } })).status).toBe(403);
    expect((await h.request(screening, { token: admin.accessToken, body: { status: "NOT_SCREENED", reason: "x", stepUpGrantId: "g1" } })).status).toBe(422);
    expect((await h.request(screening, { token: admin.accessToken, body: { status: "CLEAR", stepUpGrantId: "g1" } })).status).toBe(422);
    expect((await h.request(screening, { token: admin.accessToken, body: { status: "CLEAR", reason: "manual check", stepUpGrantId: "g1" } })).body).toEqual({ compliance: {}, approvalsRemaining: 1 });
    expect(mock.calls.at(-1)).toMatchObject({ method: "adminSetScreening", args: [expect.objectContaining({ userId: admin.userId }), a.userId, { status: "CLEAR", reason: "manual check", stepUpGrantId: "g1" }] });
  }, 60_000);

  it("non-admins get 403; an admin's call reaches payments with the Access JWT; bodies are validated", async () => {
    const mock = paymentsMock({ adminListWithdrawals: () => rpcOk({ items: [], next: null }) });
    const h = harness(mock.binding);
    const a = await player(h, "Pay_Player");
    expect((await h.request("/admin/payments/withdrawals", { method: "GET", token: a.accessToken })).status).toBe(403);
    const admin = await player(h, "Pay_Admin");
    h.db.user(admin.userId)!.role = "ADMIN";
    const list = await h.request("/admin/payments/withdrawals?status=UNDER_REVIEW", { method: "GET", token: admin.accessToken, headers: { "cf-access-jwt-assertion": "jwt.value.here" } });
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ items: [], next: null });
    expect(mock.calls[0]!.args[0]).toMatchObject({ userId: admin.userId, sessionId: admin.sessionId, accessJwt: "jwt.value.here" });
    expect(mock.calls[0]!.args[1]).toEqual({ status: "UNDER_REVIEW" });
    expect((await h.request("/admin/payments/withdrawals?status=BOGUS", { method: "GET", token: admin.accessToken })).status).toBe(422);
    expect((await h.request(`/admin/payments/withdrawals/${crypto.randomUUID()}/approve`, { token: admin.accessToken, body: {} })).status).toBe(422);
    expect(mock.calls).toHaveLength(1);
  }, 60_000);

  it("with Cloudflare Access configured, a missing JWT is 401 before payments is asked", async () => {
    const mock = paymentsMock();
    const h = harness(mock.binding, { ADMIN_REQUIRE_CF_ACCESS: "true", CF_ACCESS_AUD: "aud-tag", CF_ACCESS_TEAM_DOMAIN: "pokerteam" });
    const admin = await player(h, "Pay_Admin2");
    h.db.user(admin.userId)!.role = "ADMIN";
    expect((await h.request("/admin/payments/switches", { method: "GET", token: admin.accessToken })).status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  }, 60_000);
});

describe("\"This wasn't me\"", () => {
  const LINK_SECRET = "test-only-notify-link-secret-0123456789abcdef";
  const SUBJECT = "11111111-2222-4333-8444-555555555555";
  const link = (userId: string, secret = LINK_SECRET) => signNotMe(secret, { u: userId, k: "destination-added", s: SUBJECT, e: Date.now() + 3_600_000 });

  /** Every exit that names a real player leaves the account secured: sessions ended, the hold set, one report recorded. */
  function expectSecured(h: ReturnType<typeof harness>, userId: string) {
    expect(h.db.sessionsOf(userId).every((s) => s.revokedAt)).toBe(true);
    expect(new Date(h.db.user(userId)!.securityHoldUntil!).getTime()).toBeGreaterThan(Date.now());
    const reports = h.db.rows("accountSecurityEvent").filter((e) => e.userId === userId && e.type === "NOT_ME_REPORTED");
    expect(reports).toHaveLength(1);
    return reports[0]!;
  }

  it("poker-api checks the link itself, secures the account, then asks payments to lock the money, naming the report", async () => {
    const mock = paymentsMock({ securityLockdown: () => rpcOk(null) });
    const h = harness(mock.binding, { NOTIFY_LINK_SECRET: LINK_SECRET });
    const a = await player(h, "Not_Me_Pay");
    const response = await h.request("/wallet/not-me", { body: { token: await link(a.userId) } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ secured: true });
    const report = expectSecured(h, a.userId);
    expect(report.data).toMatchObject({ kind: "PAYMENT_NOTICE", notice: { k: "destination-added", s: SUBJECT } });
    expect(mock.calls.map((call) => call.method)).toEqual(["securityLockdown"]);
    expect(mock.calls[0]!.args).toEqual([
      { userId: a.userId, requestId: expect.any(String) }, "NOT_ME", { id: report.id, at: expect.any(String), notice: { k: "destination-added", s: SUBJECT } },
    ]);
    expect((await h.request("/wallet", { method: "GET", token: a.accessToken })).status).toBe(401);
  }, 60_000);

  it("a payments Worker that is down, or refuses the lockdown, changes nothing about the answer: the report is recorded for the sweep", async () => {
    for (const lockdown of [() => { throw new Error("down"); }, () => rpcFail("PAYMENTS_PAUSED", "Payments are paused.")]) {
      const mock = paymentsMock({ securityLockdown: lockdown });
      const h = harness(mock.binding, { NOTIFY_LINK_SECRET: LINK_SECRET });
      const a = await player(h, `Not_Me_${crypto.randomUUID().slice(0, 6)}`);
      const response = await h.request("/wallet/not-me", { body: { token: await link(a.userId) } });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ secured: true });
      expectSecured(h, a.userId);
    }
  }, 60_000);

  it("without the link secret payments says who the link names, and the account is secured before the lockdown is asked for", async () => {
    const target = { userId: "" };
    const order: string[] = [];
    const h0 = { db: null as null | ReturnType<typeof harness>["db"] };
    const mock = paymentsMock({
      verifyNotMeToken: () => { order.push("verify"); return rpcOk({ u: target.userId, k: "withdrawal-requested", s: SUBJECT, e: Date.now() + 3_600_000 }); },
      securityLockdown: () => { order.push(`lockdown:${h0.db!.rows("accountSecurityEvent").some((e) => e.type === "NOT_ME_REPORTED")}`); return rpcOk(null); },
    });
    const h = harness(mock.binding);
    h0.db = h.db;
    const a = await player(h, "Not_Me_Rpc");
    target.userId = a.userId;
    const response = await h.request("/wallet/not-me", { body: { token: "w1.payload-part.mac-part" } });
    expect(response.status).toBe(200);
    expectSecured(h, a.userId);
    expect(order).toEqual(["verify", "lockdown:true"]);
  }, 60_000);

  it("a link works once: used again, even at the same moment, it answers secured and changes nothing", async () => {
    const mock = paymentsMock({ securityLockdown: () => rpcOk(null) });
    const h = harness(mock.binding, { NOTIFY_LINK_SECRET: LINK_SECRET });
    const a = await player(h, "Not_Me_Once");
    const token = await link(a.userId);
    expect((await h.request("/wallet/not-me", { body: { token } })).status).toBe(200);
    expectSecured(h, a.userId);
    const holdAfterFirst = new Date(h.db.user(a.userId)!.securityHoldUntil!).getTime();
    // The owner signs in again; the same link (mailed to an attacker's address, say) is replayed.
    const signedIn = await signIn(h, a);
    expect(signedIn.status).toBe(200);
    const again = adopt(a, signedIn).sessionId;
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const response of await Promise.all([1, 2, 3].map(() => h.request("/wallet/not-me", { ip: "198.51.100.4", body: { token } })))) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ secured: true });
    }
    expect(h.db.rows("accountSecurityEvent").filter((e) => e.userId === a.userId && e.type === "NOT_ME_REPORTED")).toHaveLength(1);
    expect(new Date(h.db.user(a.userId)!.securityHoldUntil!).getTime()).toBe(holdAfterFirst);
    expect(h.db.sessionsOf(a.userId).find((row) => row.id === again)!.revokedAt ?? null).toBeNull();
    expect(mock.calls.filter((call) => call.method === "securityLockdown")).toHaveLength(1);
    // Another notice is another report.
    const other = await signNotMe(LINK_SECRET, { u: a.userId, k: "withdrawal-requested", s: crypto.randomUUID(), e: Date.now() + 3_600_000 });
    expect((await h.request("/wallet/not-me", { body: { token: other } })).status).toBe(200);
    expect(h.db.rows("accountSecurityEvent").filter((e) => e.userId === a.userId && e.type === "NOT_ME_REPORTED")).toHaveLength(2);
  }, 60_000);

  it("a link sent at or after the incident of a later account lockdown is void; one sent before it still works", async () => {
    const mock = paymentsMock({ securityLockdown: () => rpcOk(null) });
    const h = harness(mock.binding, { NOTIFY_LINK_SECRET: LINK_SECRET });
    const a = await player(h, "Not_Me_Void");
    const now = Date.now();
    // Sent 2 h ago (to the attacker's address), after an incident 3 h ago; the owner's account lockdown ran just now.
    const late = await signNotMe(LINK_SECRET, { u: a.userId, k: "destination-added", s: SUBJECT, e: now - 2 * 3_600_000 + NOT_ME_TTL_MS });
    const early = await signNotMe(LINK_SECRET, { u: a.userId, k: "withdrawal-requested", s: crypto.randomUUID(), e: now - 4 * 3_600_000 + NOT_ME_TTL_MS });
    h.db.insert("accountSecurityEvent", {
      id: crypto.randomUUID(), userId: a.userId, type: "NOT_ME_REPORTED", createdAt: new Date(now - 1000),
      data: { kind: "EMAIL_CHANGED", incidentAt: new Date(now - 3 * 3_600_000).toISOString() },
    });
    const refused = await h.request("/wallet/not-me", { body: { token: late } });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("TOKEN_INVALID");
    expect(h.db.user(a.userId)!.securityHoldUntil ?? null).toBeNull();
    expect(h.db.sessionsOf(a.userId).every((row) => !row.revokedAt)).toBe(true);
    expect(mock.calls).toHaveLength(0);
    // A link sent before the incident was the owner's: it still secures the account.
    expect((await h.request("/wallet/not-me", { body: { token: early } })).status).toBe(200);
    expect(new Date(h.db.user(a.userId)!.securityHoldUntil!).getTime()).toBeGreaterThan(Date.now());
    expect(mock.calls.map((call) => call.method)).toEqual(["securityLockdown"]);
  }, 60_000);

  it("a link signed with another secret is refused by both checks and changes nothing", async () => {
    const mock = paymentsMock({ verifyNotMeToken: () => rpcFail("TOKEN_INVALID", "This link is not valid or has expired.") });
    const h = harness(mock.binding, { NOTIFY_LINK_SECRET: LINK_SECRET });
    const a = await player(h, "Not_Me_Other");
    const response = await h.request("/wallet/not-me", { body: { token: await link(a.userId, "another-secret-another-secret-another-secret") } });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("TOKEN_INVALID");
    expect(h.db.user(a.userId)!.securityHoldUntil ?? null).toBeNull();
    expect(mock.calls.map((call) => call.method)).toEqual(["verifyNotMeToken"]);
  }, 60_000);

  it("a valid link for an account that no longer exists is refused, not a 500", async () => {
    const mock = paymentsMock({ securityLockdown: () => rpcOk(null) });
    const h = harness(mock.binding, { NOTIFY_LINK_SECRET: LINK_SECRET });
    const response = await h.request("/wallet/not-me", { body: { token: await link("no_such_user") } });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("TOKEN_INVALID");
    expect(mock.calls).toHaveLength(0);
  }, 60_000);

  it("a forged token is 400 TOKEN_INVALID and changes nothing; without the binding every token is invalid", async () => {
    const mock = paymentsMock({ verifyNotMeToken: () => rpcFail("TOKEN_INVALID", "This link is not valid or has expired.") });
    const h = harness(mock.binding);
    const a = await player(h, "Not_Me_Bad");
    const response = await h.request("/wallet/not-me", { body: { token: "w1.forged-part.mac-part" } });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("TOKEN_INVALID");
    expect(h.db.user(a.userId)!.securityHoldUntil ?? null).toBeNull();
    expect((await harness(null).request("/wallet/not-me", { body: { token: "w1.forged-part.mac-part" } })).body.code).toBe("TOKEN_INVALID");
  }, 60_000);

  it("the account lockdown hook asks payments to lock down, and never throws", async () => {
    const mock = paymentsMock({ securityLockdown: () => rpcOk(null) });
    const report = { id: "evt_1", at: new Date(0).toISOString(), notice: null };
    await onAccountLockdown({ PAYMENTS: mock.binding } as unknown as Env, "user_1", report);
    expect(mock.calls[0]).toMatchObject({ method: "securityLockdown", args: [{ userId: "user_1", requestId: expect.any(String) }, "NOT_ME", report] });
    const failing = paymentsMock({ securityLockdown: () => { throw new Error("down"); } });
    await expect(onAccountLockdown({ PAYMENTS: failing.binding } as unknown as Env, "user_1", report)).resolves.toBeUndefined();
    await expect(onAccountLockdown({} as Env, "user_1", report)).resolves.toBeUndefined();
  });
});

describe("the way back from a self-exclusion, over HTTP", () => {
  const exclusion = (h: ReturnType<typeof harness>, userId: string, data: Record<string, unknown>) => h.db.insert("selfExclusion", { id: crypto.randomUUID(), userId, kind: "DEFINITE", createdBy: userId, ...data });

  it("nothing in force, a running break, a break that ended: each answers what the player can do", async () => {
    const h = harness(null);
    const a = await player(h, "Back_Http");
    const status = async () => (await h.request("/account/self-exclusion", { method: "GET", token: a.accessToken })).body;
    const ask = () => h.request("/account/self-exclusion/reactivation", { body: {}, token: a.accessToken });
    expect(await status()).toEqual({ active: false, kind: null, endsAt: null, canRequestReturn: false, requestedAt: null, accessRestoredAt: null });
    expect((await ask()).status).toBe(409);
    const ends = new Date(Date.now() + 3_600_000);
    exclusion(h, a.userId, { endsAt: ends });
    expect(await status()).toMatchObject({ active: true, kind: "DEFINITE", endsAt: ends.toISOString(), canRequestReturn: false });
    const early = await ask();
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "EXCLUSION_NOT_ENDED", details: { endsAt: ends.toISOString() } });
    h.db.rows("selfExclusion").at(-1)!.endsAt = new Date(Date.now() - 1_000);
    expect(await status()).toMatchObject({ active: true, canRequestReturn: true });
    expect((await ask()).status).toBe(200);
    expect(h.db.rows("selfExclusion").at(-1)!.reactivationRequestedAt).not.toBeNull();
  }, 60_000);

  it("needs a session", async () => {
    const h = harness(null);
    expect((await h.request("/account/self-exclusion", { method: "GET" })).status).toBe(401);
    expect((await h.request("/account/self-exclusion/reactivation", { body: {} })).status).toBe(401);
  }, 60_000);
});

describe("production: no PAYMENTS binding", () => {
  function walletRoutes(): { method: string; path: string }[] {
    const app = new Hono<{ Bindings: Env }>();
    registerWallet(app);
    registerAdminPayments(app);
    return app.routes.filter((route) => route.method !== "ALL").map((route) => ({ method: route.method, path: route.path }));
  }

  const UUID = "11111111-2222-4333-8444-555555555555";
  const fill = (path: string) => path.split(":userId").join("cuser0000000000000000000000").split(":id").join(UUID);
  const BODIES: Record<string, unknown> = {
    "/api/wallet/deposits": { method: "CARD", amount: "10.00" },
    "/api/wallet/instruments/crypto/prepare": { asset: "USDC_ERC20", address: "0x0000000000000000000000000000000000000001" },
    "/api/wallet/instruments/crypto": { asset: "USDC_ERC20", address: "0x0000000000000000000000000000000000000001", stepUpGrantId: "g1" },
    "/api/wallet/withdrawals/quote": { instrumentId: UUID, amount: "20.00" },
    "/api/wallet/withdrawals": { quoteId: UUID, stepUpGrantId: "g1" },
    "/api/wallet/limits": { period: "DAY", amount: "50.00" },
    "/api/account/self-exclusion": { period: "24h" },
    "/api/wallet/not-me": { token: "w1.aaaaaaaaaaaa.bbbbbbbbbbbb" },
  };
  /** Reads that answer an empty "off" view, and the player-protection writes that work with no binding. */
  const ALLOWED_2XX = new Set([
    "GET /api/wallet", "GET /api/wallet/transactions", "GET /api/wallet/instruments", "GET /api/wallet/withdrawals", "GET /api/wallet/limits",
    "POST /api/wallet/limits", "POST /api/account/self-exclusion", "GET /api/account/self-exclusion",
  ]);

  it("every registered wallet and payments-admin route refuses, for a player and for an admin", async () => {
    const routes = walletRoutes();
    expect(routes.length).toBeGreaterThan(30);
    const h = harness(null);
    const a = await player(h, "Off_Player");
    const admin = await player(h, "Off_Admin");
    h.db.user(admin.userId)!.role = "ADMIN";
    const surprises: string[] = [];
    for (const who of [a, admin]) {
      for (const route of routes) {
        const key = `${route.method} ${route.path}`;
        const adminBody = route.path.startsWith("/api/admin") && route.method === "POST" ? { stepUpGrantId: "g1" } : undefined;
        const response = await h.request(`/..${fill(route.path)}`, {
          method: route.method, token: who.accessToken, headers: { "idempotency-key": crypto.randomUUID() },
          ...(route.method === "GET" || route.method === "DELETE" ? {} : { body: BODIES[route.path] ?? adminBody ?? {} }),
        });
        if (response.status >= 200 && response.status < 300 && !ALLOWED_2XX.has(key)) surprises.push(`${key} -> ${response.status}`);
      }
    }
    expect(surprises).toEqual([]);
    expect((await h.request("/wallet", { method: "GET", token: a.accessToken })).body).toMatchObject({ mode: "off", realMoney: null });
  }, 120_000);
});
