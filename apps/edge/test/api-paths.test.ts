/**
 * Every path decision of the API sits on one canonical path, and that path is
 * the one Hono routes: a percent-encoded /api path is refused before anything
 * else (Hono decodes it, the checks would not), and a spelling variant
 * (trailing or doubled slash, another case) reaches no handler without the
 * limiter of the route it names. Without this, /api/%77allet/... reached the
 * wallet past RL_CREDENTIALS and /api/%61dmin/... past RL_ADMIN and the admin
 * access log (wallet review AHW-1).
 */
import { describe, expect, it } from "vitest";
import { rpcOk } from "../src/payments/contract";
import { createHarness, type Harness } from "./harness";
import { signUp } from "./support/accounts";

function paymentsMock() {
  const calls: string[] = [];
  const binding = new Proxy({}, {
    get(_target, method: string) {
      if (method === "then") return undefined;
      return async () => {
        calls.push(method);
        if (method === "adminListWithdrawals") return rpcOk({ items: [], next: null });
        return rpcOk({ quote: { id: "q" }, stepUp: { purpose: "withdrawal", bind: "a".repeat(64), methods: [] } });
      };
    },
  });
  return { binding, calls };
}

/** Refuses everything once `gate.block` is set, and records the keys it refused. */
function limiter(seen: string[], gate: { block: boolean }) {
  return { limit: async ({ key }: { key: string }) => { if (!gate.block) return { success: true }; seen.push(key); return { success: false }; } };
}

/** A request to a path that spells its own prefix (the harness adds /api; the URL parser folds "/api/.."). */
async function raw(h: Harness, path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number }> {
  return h.request(`/..${path}`, { method: init.method ?? "POST", ...(init.token ? { token: init.token } : {}), ...(init.method === "GET" ? {} : { body: init.body ?? {} }) });
}

const SPELLING_UUID = "11111111-2222-4333-8444-555555555555";

describe("the percent refusal against real paths", () => {
  it("does not refuse a real route, a query with escapes, or the auth callback pages", async () => {
    const h = createHarness({} as unknown as Record<string, string>);
    const a = await signUp(h, "Pct_Real", { verified: true });
    for (const path of ["/tables", "/account/devices", "/wallet/limits?x=%25", "/wallet/transactions?cursor=a%2Fb&limit=5"]) {
      const response = await h.request(path, { method: "GET", token: a.accessToken });
      expect(response.status, path).not.toBe(400);
    }
  }, 60_000);

  it("refuses every escape spelling of a guarded route, and no spelling reaches a handler", async () => {
    const h = createHarness({} as unknown as Record<string, string>);
    const a = await signUp(h, "Pct_Var", { verified: true });
    const paths = ["/%77allet", "/%57allet", "/wallet%2Fwithdrawals", "/wallet/withdrawals%2Fquote", "/wallet/%2e%2e/wallet", "/wallet/%00", "/wallet%20", "/wallet/%ZZ", "/%2577allet", "/wallet/withdrawals/quote%3Fx=1", "/wallet/withdrawals/quote%23x"];
    const bad: string[] = [];
    for (const path of paths) {
      const response = await h.request(path, { token: a.accessToken, body: { instrumentId: SPELLING_UUID, amount: "20.00" } });
      // Only 400 or 404 are safe: anything else ran a handler. REAL_MONEY_DISABLED would mean a handler ran.
      if ((response.status !== 400 && response.status !== 404) || (response.body as { code?: string } | null)?.code === "REAL_MONEY_DISABLED") bad.push(path);
    }
    expect(bad).toEqual([]);
  }, 60_000);
});

describe("percent-encoded API paths", () => {
  it("are refused 400 before the wallet handler, on any route", async () => {
    const seen: string[] = [];
    const gate = { block: false };
    const mock = paymentsMock();
    const h = createHarness({ PAYMENTS: mock.binding, RL_CREDENTIALS: limiter(seen, gate) } as unknown as Record<string, string>);
    const a = await signUp(h, "Enc_Wallet", { verified: true });
    const body = { instrumentId: crypto.randomUUID(), amount: "20.00" };
    gate.block = true;
    expect((await h.request("/wallet/withdrawals/quote", { token: a.accessToken, body })).status).toBe(429);
    gate.block = false;
    for (const path of ["/%77allet/withdrawals/quote", "/wallet/%77ithdrawals/quote", "/wallet/withdrawals/quot%65"]) {
      expect((await h.request(path, { token: a.accessToken, body })).status, path).toBe(400);
    }
    // An encoded prefix too: it would otherwise skip every check and fail on the missing request state.
    expect((await raw(h, "/%61pi/wallet/withdrawals/quote", { token: a.accessToken, body })).status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  }, 60_000);

  it("an admin read cannot skip RL_ADMIN or the access log", async () => {
    const seen: string[] = [];
    const gate = { block: false };
    const mock = paymentsMock();
    const h = createHarness({ PAYMENTS: mock.binding, RL_ADMIN: limiter(seen, gate) } as unknown as Record<string, string>);
    const admin = await signUp(h, "Enc_Admin", { verified: true });
    h.db.user(admin.userId)!.role = "ADMIN";
    gate.block = true;
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
    console.warn = (...args: unknown[]) => { lines.push(String(args[0])); };
    let plain;
    let encoded;
    try {
      plain = await h.request("/admin/payments/withdrawals", { method: "GET", token: admin.accessToken });
      encoded = await h.request("/%61dmin/payments/withdrawals", { method: "GET", token: admin.accessToken });
    } finally {
      console.log = original.log;
      console.warn = original.warn;
    }
    expect(plain.status).toBe(429);
    expect(encoded.status).toBe(400);
    expect(lines.filter((line) => line.includes("ADMIN_REQUEST"))).toHaveLength(1);
    expect(mock.calls).toHaveLength(0);
  }, 60_000);

  it("the login limit cannot be skipped", async () => {
    const seen: string[] = [];
    const gate = { block: false };
    const h = createHarness({ RL_CREDENTIALS: limiter(seen, gate) } as unknown as Record<string, string>);
    const a = await signUp(h, "Enc_Login", { verified: true });
    gate.block = true;
    const body = { identifier: a.username, password: "wrong password guess 1", turnstileToken: "test-token" };
    expect((await h.request("/auth/login", { body })).status).toBe(429);
    expect((await h.request("/auth/%6Cogin", { body })).status).toBe(400);
  }, 60_000);

  it("a query string keeps its escapes", async () => {
    const h = createHarness({});
    const a = await signUp(h, "Enc_Query", { verified: true });
    expect((await h.request("/wallet/transactions?cursor=a%3Ab", { method: "GET", token: a.accessToken })).status).toBe(200);
  }, 60_000);
});

describe("spelling variants of a limited path", () => {
  const VARIANTS = (path: string) => [`${path}/`, `${path}//`, path.replace("/api/", "/api//"), path.toUpperCase(), path.replace("/api/", "/API/")];

  it("a credential route: the variant is limited like the route, and no handler runs", async () => {
    const seen: string[] = [];
    const gate = { block: true };
    const h = createHarness({ RL_CREDENTIALS: limiter(seen, gate) } as unknown as Record<string, string>);
    for (const path of VARIANTS("/api/auth/login")) expect((await raw(h, path, { body: {} })).status, path).toBe(429);
    gate.block = false;
    const body = { identifier: "nobody_here", password: "wrong password guess 1" };
    for (const path of VARIANTS("/api/auth/login")) expect((await raw(h, path, { body })).status, path).toBe(404);
  }, 60_000);

  it("a wallet route: never reaches payments, limited or not", async () => {
    const seen: string[] = [];
    const gate = { block: false };
    const mock = paymentsMock();
    const h = createHarness({ PAYMENTS: mock.binding, RL_CREDENTIALS: limiter(seen, gate) } as unknown as Record<string, string>);
    const a = await signUp(h, "Var_Wallet", { verified: true });
    const body = { instrumentId: crypto.randomUUID(), amount: "20.00" };
    for (const path of VARIANTS("/api/wallet/withdrawals/quote")) expect((await raw(h, path, { token: a.accessToken, body })).status, path).toBe(404);
    gate.block = true;
    for (const path of VARIANTS("/api/wallet/withdrawals/quote")) expect((await raw(h, path, { token: a.accessToken, body })).status, path).toBe(429);
    expect(mock.calls).toHaveLength(0);
  }, 60_000);

  it("an admin route: RL_ADMIN and the access log see the variant", async () => {
    const seen: string[] = [];
    const gate = { block: true };
    const mock = paymentsMock();
    const h = createHarness({ PAYMENTS: mock.binding, RL_ADMIN: limiter(seen, gate) } as unknown as Record<string, string>);
    const admin = await signUp(h, "Var_Admin", { verified: true });
    h.db.user(admin.userId)!.role = "ADMIN";
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
    console.warn = (...args: unknown[]) => { lines.push(String(args[0])); };
    try {
      for (const path of VARIANTS("/api/admin/payments/withdrawals")) expect((await raw(h, path, { method: "GET", token: admin.accessToken })).status, path).toBe(429);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
    }
    expect(lines.filter((line) => line.includes("ADMIN_REQUEST"))).toHaveLength(VARIANTS("/api/admin/payments/withdrawals").length);
    expect(mock.calls).toHaveLength(0);
  }, 60_000);
});
