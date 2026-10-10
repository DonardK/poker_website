import { describe, expect, it } from "vitest";
import { createHarness, PASSWORD, TERMS } from "./harness";

const SLOW = 90_000;

describe("tables and admin http", () => {
  it("creates a table, debits bankroll once, and still returns 201 if track() fails", async () => {
    const harness = createHarness();
    const registered = await harness.request("/auth/register", {
      body: { ...TERMS, username: "Host_One", email: "host@example.com", password: PASSWORD },
    });
    expect(registered.status).toBe(201);
    const userId = registered.body.user.id as string;
    expect(harness.db.user(userId)?.bankroll).toBe(10_000);
    const created = await harness.request("/tables", {
      method: "POST",
      token: registered.body.accessToken,
      body: { smallBlind: 5, bigBlind: 10, buyIn: 1000, botCount: 0 },
    });
    expect(created.status).toBe(201);
    expect(typeof created.body.tableId).toBe("string");
    expect(harness.db.user(userId)?.bankroll).toBe(9_000);
    expect(harness.db.calls["user.updateMany"]).toBe(1);
    expect(harness.tracked).toEqual([created.body.tableId]);

    const again = await harness.request("/tables", {
      method: "POST",
      token: registered.body.accessToken,
      body: { smallBlind: 5, bigBlind: 10, buyIn: 1000 },
    });
    expect(again.status).toBe(409);
    expect(harness.db.user(userId)?.bankroll).toBe(9_000);
    expect(harness.db.calls["user.updateMany"]).toBe(1);
    expect(harness.tracked).toHaveLength(1);
  }, SLOW);

  it("returns 201 and one debit when TableActor.track throws", async () => {
    const harness = createHarness();
    harness.failTrack = true;
    const registered = await harness.request("/auth/register", {
      body: { ...TERMS, username: "Host_Two", email: "host2@example.com", password: PASSWORD },
    });
    const created = await harness.request("/tables", {
      method: "POST",
      token: registered.body.accessToken,
      body: { smallBlind: 5, bigBlind: 10, buyIn: 1000 },
    });
    expect(created.status).toBe(201);
    expect(harness.db.user(registered.body.user.id)?.bankroll).toBe(9_000);
    expect(harness.db.calls["user.updateMany"]).toBe(1);
    expect(harness.tracked).toEqual([created.body.tableId]);
  }, SLOW);

  it("admin audit is 403 for a non-admin even when an Access header is present", async () => {
    const harness = createHarness();
    const registered = await harness.request("/auth/register", {
      body: { ...TERMS, username: "Plain_Player", email: "plain@example.com", password: PASSWORD },
    });
    const handUuid = crypto.randomUUID();
    const denied = await harness.request(`/admin/hands/${handUuid}/audit`, {
      method: "GET",
      token: registered.body.accessToken,
      headers: { "Cf-Access-Jwt-Assertion": "test-assertion" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: "Forbidden" });
  }, SLOW);

  it("admin audit is 404 for an admin when Access is not configured, and 401 when it is required but missing", async () => {
    const open = createHarness();
    const registered = await open.request("/auth/register", {
      body: { ...TERMS, username: "Reg_User", email: "reg@example.com", password: PASSWORD },
    });
    open.db.user(registered.body.user.id)!.role = "ADMIN";
    const missing = await open.request(`/admin/hands/${crypto.randomUUID()}/audit`, {
      method: "GET",
      token: registered.body.accessToken,
      headers: { "Cf-Access-Jwt-Assertion": "test-assertion" },
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Hand not found" });

    const locked = createHarness({
      CF_ACCESS_AUD: "aud-test",
      CF_ACCESS_TEAM_DOMAIN: "team-test",
    });
    const player = locked.db.addUser({ username: "Still_Admin", role: "ADMIN" });
    const session = await locked.db.addSession(player.id);
    const refused = await locked.request(`/admin/hands/${crypto.randomUUID()}/audit`, {
      method: "GET",
      token: session.accessToken,
    });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "Unauthorized" });

    const demo = createHarness({ CLIENT_ORIGIN: "https://poker-web.demo.workers.dev", ADMIN_REQUIRE_CF_ACCESS: "false" });
    const admin = demo.db.addUser({ username: "Demo_Admin", role: "ADMIN" });
    const demoSession = await demo.db.addSession(admin.id);
    const skipped = await demo.request(`/admin/hands/${crypto.randomUUID()}/audit`, {
      method: "GET",
      token: demoSession.accessToken,
    });
    expect(skipped.status).toBe(404);
    expect(skipped.body).toEqual({ error: "Hand not found" });

    expect(() => createHarness({
      CLIENT_ORIGIN: "https://poker-web.demo.workers.dev",
      ADMIN_REQUIRE_CF_ACCESS: "true",
    })).not.toThrow();
    const strict = createHarness({
      CLIENT_ORIGIN: "https://poker-web.demo.workers.dev",
      ADMIN_REQUIRE_CF_ACCESS: "true",
    });
    const strictAdmin = strict.db.addUser({ username: "Strict_Admin", role: "ADMIN" });
    const strictSession = await strict.db.addSession(strictAdmin.id);
    const misconfigured = await strict.request(`/admin/hands/${crypto.randomUUID()}/audit`, {
      method: "GET",
      token: strictSession.accessToken,
    });
    expect(misconfigured.status).toBe(500);
  }, SLOW);

  it("issues a short-lived poker_ws cookie", async () => {
    const harness = createHarness();
    const user = harness.db.addUser({ username: "Ticket" });
    const session = await harness.db.addSession(user.id);
    const response = await harness.request("/ws-ticket", { token: session.accessToken });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    const cookies = response.headers.getSetCookie?.() ?? [];
    const ws = cookies.find((cookie) => cookie.startsWith("poker_ws="));
    expect(ws).toMatch(/Path=\/ws/);
    expect(ws).toMatch(/Max-Age=60/);
    expect(ws).toMatch(/HttpOnly/);
  });
});
