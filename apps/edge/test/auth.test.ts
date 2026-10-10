/**
 * Port of apps/server/test/auth-http.test.mjs onto the edge HTTP stack.
 * The in-memory database is the same strategy as auth-fake-db.mjs. There is
 * no session-row cache, so a later database failure is not served from one.
 */
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { authenticate } from "../src/auth/authenticate";
import { isAuthError } from "../src/auth/errors";
import { passwords } from "../src/auth/password";
import { hashRefresh, REFRESH_GRACE_MS } from "../src/auth/sessions";
import { cleared, cookieOf, createHarness, PASSWORD, TERMS } from "./harness";
import { uniqueViolation } from "./memory-db";

const DAY = 86_400_000;
const SLOW = 90_000;

describe("auth http", () => {
  it("refresh: a database failure answers 503 retryable and leaves the cookie alone", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "Guest_00aa11bb22", isGuest: true });
    const session = await db.addSession(user.id);
    for (const failing of ["session.findUnique", "session.updateMany"]) {
      db.fail(failing);
      const response = await request("/auth/refresh", { cookie: cookieOf(session.refreshToken) });
      expect(response.status, failing).toBe(503);
      expect(response.body.retryable).toBe(true);
      expect(response.headers.get("retry-after")).toBe("2");
      expect(response.setCookie, failing).toBeNull();
      expect(db.session(session.id)?.refreshToken).toBe(await hashRefresh(session.refreshToken));
    }
    const ok = await request("/auth/refresh", { cookie: cookieOf(session.refreshToken) });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(user.id);
    expect(ok.setCookie).toBeTruthy();
  });

  it("requireAuth and /me: a database failure is 503; a bad token is 401", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "Alice" });
    const session = await db.addSession(user.id);
    db.fail("session.findUnique");
    const down = await request("/auth/me", { method: "GET", token: session.accessToken });
    expect(down.status).toBe(503);
    expect(down.body.retryable).toBe(true);
    expect(down.headers.get("retry-after")).toBe("2");
    expect((await request("/auth/me", { method: "GET", token: session.accessToken })).status).toBe(200);
    expect((await request("/auth/me", { method: "GET", token: "not-a-token" })).status).toBe(401);
  });

  it("authenticate: credential problems are AuthError and a database error is not cached", async () => {
    const { db, config } = createHarness();
    const user = db.addUser({ username: "Bob" });
    const session = await db.addSession(user.id);
    db.fail("session.findUnique");
    await expect(authenticate(db.api, session.accessToken, config)).rejects.toMatchObject({ name: "PrismaClientInitializationError" });
    const ok = await authenticate(db.api, session.accessToken, config);
    expect(ok.user.id).toBe(user.id);
    expect(ok.session.id).toBe(session.id);
    db.down = true;
    await expect(authenticate(db.api, session.accessToken, config)).rejects.toMatchObject({ name: "PrismaClientInitializationError" });
    db.down = false;
    db.revokeRow(session.id, "LOGOUT");
    await expect(authenticate(db.api, session.accessToken, config)).rejects.toSatisfy((err: unknown) => isAuthError(err) && err.code === "REVOKED" && err.reason === "LOGOUT");
    await expect(authenticate(db.api, "garbage", config)).rejects.toSatisfy((err: unknown) => isAuthError(err) && err.code === "INVALID_TOKEN" && err.reason === undefined);
    await expect(authenticate(db.api, undefined, config)).rejects.toSatisfy((err: unknown) => isAuthError(err) && err.code === "NO_TOKEN");
    const expired = await db.addSession(user.id, { expiresAt: new Date(Date.now() - 1) });
    await expect(authenticate(db.api, expired.accessToken, config)).rejects.toSatisfy((err: unknown) => isAuthError(err) && err.code === "EXPIRED" && err.reason === "EXPIRED");
    const bot = db.addUser({ username: "Bot_Zed", kind: "BOT" });
    const botSession = await db.addSession(bot.id);
    await expect(authenticate(db.api, botSession.accessToken, config)).rejects.toSatisfy((err: unknown) => isAuthError(err) && err.code === "USER_BLOCKED");
  });

  it("lifetime: cookie, row and refresh JWT share one expiry and refresh cannot pass the absolute end", async () => {
    const { db, request, config } = createHarness();
    const before = Date.now();
    const guest = await request("/auth/guest", { body: TERMS });
    expect(guest.status).toBe(201);
    const row = db.sessionsOf(guest.body.user.id)[0]!;
    const agree = (response: { cookie: string | null; setCookie: string | null }, sessionRow: { expiresAt: Date }) => {
      const token = decodeURIComponent(response.cookie!.split("=")[1]!);
      const exp = decodeJwt(token).exp;
      const maxAge = Number(/Max-Age=(\d+)/.exec(response.setCookie!)?.[1]);
      const expires = Date.parse(/Expires=([^;]+)/.exec(response.setCookie!)?.[1] ?? "");
      expect(exp).toBe(Math.floor(sessionRow.expiresAt.getTime() / 1000));
      expect(Math.abs(expires - sessionRow.expiresAt.getTime())).toBeLessThan(2_000);
      expect(Math.abs(maxAge * 1000 - (sessionRow.expiresAt.getTime() - Date.now()))).toBeLessThan(2_000);
    };
    agree(guest, row);
    expect(Math.abs(row.expiresAt.getTime() - (before + config.sessionIdleTtlMs))).toBeLessThan(2_000);
    expect(Math.abs(row.absoluteExpiresAt.getTime() - (before + config.sessionAbsoluteTtlMs))).toBeLessThan(2_000);
    row.absoluteExpiresAt = new Date(Date.now() + 3_600_000);
    const refreshed = await request("/auth/refresh", { cookie: guest.cookie });
    expect(refreshed.status).toBe(200);
    expect(row.expiresAt.getTime()).toBe(row.absoluteExpiresAt.getTime());
    agree(refreshed, row);
    expect(row.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("lifetime: a session past its absolute expiry is refused even if the idle expiry is still ahead", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "Oldtimer" });
    const old = await db.addSession(user.id, {
      createdAt: new Date(Date.now() - 365 * DAY),
      absoluteExpiresAt: new Date(Date.now() - 335 * DAY),
      expiresAt: new Date(Date.now() + DAY),
    });
    const response = await request("/auth/refresh", { cookie: cookieOf(old.refreshToken) });
    expect(response.status).toBe(401);
    expect(cleared(response)).toBe(true);
    expect(db.session(old.id)?.refreshToken).toBe(await hashRefresh(old.refreshToken));
    expect((await request("/auth/me", { method: "GET", token: old.accessToken })).status).toBe(401);
  });

  it("rotation: two concurrent refreshes both succeed and exactly one rotates", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "TwoTabs" });
    const session = await db.addSession(user.id);
    db.hold("session.findUnique", 2);
    const both = await Promise.all([1, 2].map(() => request("/auth/refresh", { cookie: cookieOf(session.refreshToken) })));
    expect(both.map((response) => response.status)).toEqual([200, 200]);
    expect(both.filter((response) => response.setCookie).length).toBe(1);
    const row = db.session(session.id)!;
    expect(row.previousTokenHash).toBe(await hashRefresh(session.refreshToken));
    expect(row.revokedAt).toBeNull();
    for (const response of both) {
      expect((await request("/auth/me", { method: "GET", token: response.body.accessToken })).status).toBe(200);
    }
    const again = await request("/auth/refresh", { cookie: cookieOf(session.refreshToken) });
    expect(again.status).toBe(200);
    expect(again.setCookie).toBeNull();
    expect(db.session(session.id)?.refreshToken).toBe(row.refreshToken);
  });

  it("reuse: a previous token after the grace window revokes the session", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "Victim" });
    const session = await db.addSession(user.id);
    const first = await request("/auth/refresh", { cookie: cookieOf(session.refreshToken) });
    expect(first.status).toBe(200);
    db.session(session.id)!.rotatedAt = new Date(Date.now() - REFRESH_GRACE_MS - 1_000);
    const replay = await request("/auth/refresh", { cookie: cookieOf(session.refreshToken) });
    expect(replay.status).toBe(401);
    expect(cleared(replay)).toBe(true);
    const row = db.session(session.id)!;
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe("REFRESH_REUSE");
    expect((await request("/auth/refresh", { cookie: first.cookie })).status).toBe(401);
    expect((await request("/auth/me", { method: "GET", token: first.body.accessToken })).status).toBe(401);

    const other = await db.addSession(user.id);
    const r1 = await request("/auth/refresh", { cookie: cookieOf(other.refreshToken) });
    const r2 = await request("/auth/refresh", { cookie: r1.cookie });
    expect(r2.status).toBe(200);
    expect((await request("/auth/refresh", { cookie: cookieOf(other.refreshToken) })).status).toBe(401);
    expect(db.session(other.id)?.revokeReason).toBe("REFRESH_REUSE");
  });

  it("sessions: list, revoke one, logout-all, logout keeps the row", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "Multi", password: PASSWORD });
    const stranger = db.addUser({ username: "Stranger" });
    const theirs = await db.addSession(stranger.id);
    const a = await request("/auth/login", { body: { username: "Multi", password: PASSWORD } });
    const b = await request("/auth/login", { body: { username: "multi", password: PASSWORD } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const list = await request("/auth/sessions", { method: "GET", token: a.body.accessToken });
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.map((session: { current: boolean }) => session.current).sort()).toEqual([false, true]);
    for (const session of list.body.sessions) {
      expect(session.ip).toMatch(/^127\.0\.0\.0\/24$/);
      expect(Object.keys(session).sort()).toEqual(["createdAt", "current", "id", "ip", "lastUsedAt", "userAgent"]);
    }
    const bId = list.body.sessions.find((session: { current: boolean; id: string }) => !session.current).id;
    expect((await request(`/auth/sessions/${theirs.id}`, { method: "DELETE", token: a.body.accessToken })).status).toBe(404);
    expect(db.session(theirs.id)?.revokedAt).toBeNull();
    expect((await request(`/auth/sessions/${bId}`, { method: "DELETE", token: a.body.accessToken })).status).toBe(204);
    expect(db.session(bId)?.revokeReason).toBe("SESSION_REVOKED");
    expect((await request("/auth/refresh", { cookie: b.cookie })).status).toBe(401);

    const c = await request("/auth/login", { body: { username: "MULTI", password: PASSWORD } });
    const all = await request("/auth/logout-all", { token: c.body.accessToken, body: {} });
    expect(all.status).toBe(200);
    expect(all.body.revoked).toBe(2);
    expect(cleared(all)).toBe(true);
    expect(db.sessionsOf(user.id).every((session) => session.revokedAt)).toBe(true);
    expect(db.session(theirs.id)?.revokedAt).toBeNull();

    const d = await request("/auth/login", { body: { username: "Multi", password: PASSWORD } });
    const dId = decodeJwt(d.body.accessToken).sid as string;
    const out = await request("/auth/logout", { cookie: d.cookie });
    expect(out.status).toBe(204);
    expect(cleared(out)).toBe(true);
    expect(db.session(dId)?.revokeReason).toBe("LOGOUT");
    expect((await request("/auth/me", { method: "GET", token: d.body.accessToken })).status).toBe(401);
  });

  it("logout, logout-all, and session revoke call UserSessions.revoke", async () => {
    const harness = createHarness();
    const { request } = harness;
    const user = harness.db.addUser({ username: "Revoker", password: PASSWORD });
    const first = await request("/auth/login", { body: { username: "Revoker", password: PASSWORD } });
    const firstId = decodeJwt(first.body.accessToken).sid as string;
    expect((await request("/auth/logout", { cookie: first.cookie })).status).toBe(204);

    const kept = await request("/auth/login", { body: { username: "Revoker", password: PASSWORD } });
    const extra = await request("/auth/login", { body: { username: "revoker", password: PASSWORD } });
    const keptId = decodeJwt(kept.body.accessToken).sid as string;
    const extraId = decodeJwt(extra.body.accessToken).sid as string;
    expect((await request(`/auth/sessions/${extraId}`, { method: "DELETE", token: kept.body.accessToken })).status).toBe(204);
    const all = await request("/auth/logout-all", { token: kept.body.accessToken, body: {} });
    expect(all.status).toBe(200);
    expect(all.body.revoked).toBe(1);

    expect(harness.revoked).toEqual([
      { userId: user.id, sessionId: firstId, reason: "LOGOUT" },
      { userId: user.id, sessionId: extraId, reason: "SESSION_REVOKED" },
      { userId: user.id, sessionId: keptId, reason: "LOGOUT_ALL" },
    ]);
  });

  it("logout-all with exceptCurrent keeps the calling session", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "KeepMe" });
    const mine = await db.addSession(user.id);
    const other = await db.addSession(user.id);
    const response = await request("/auth/logout-all", { token: mine.accessToken, body: { exceptCurrent: true } });
    expect(response.body.revoked).toBe(1);
    expect(response.setCookie).toBeNull();
    expect(db.session(mine.id)?.revokedAt).toBeNull();
    expect(db.session(other.id)?.revokeReason).toBe("LOGOUT_ALL");
  });

  it("login: unknown users, guests and bots do one bcrypt compare and the same 401", async () => {
    const { db, request } = createHarness();
    db.addUser({ username: "RealOne", password: PASSWORD });
    db.addUser({ username: "Guest_0123456789", isGuest: true });
    db.addUser({ username: "Bot_Alice", kind: "BOT", password: PASSWORD });
    const compare = vi.spyOn(passwords, "compare");
    try {
      const answers = [];
      for (const username of ["nobody_here", "Guest_0123456789", "Bot_Alice", "RealOne"]) {
        const before = compare.mock.calls.length;
        const response = await request("/auth/login", {
          body: { username, password: username === "Bot_Alice" ? PASSWORD : "wrong password!!" },
        });
        expect(compare.mock.calls.length - before, username).toBe(1);
        answers.push([response.status, response.body]);
      }
      for (const answer of answers) expect(answer).toEqual([401, { error: "Invalid credentials" }]);
    } finally {
      compare.mockRestore();
    }
  }, SLOW);

  it("login: 5 failures lock the account; a correct password during the lock does not extend it", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "Target", password: PASSWORD });
    for (let i = 1; i <= 5; i++) {
      const response = await request("/auth/login", { body: { username: "target", password: `wrong guess ${i}!` } });
      expect([response.status, response.body]).toEqual([401, { error: "Invalid credentials" }]);
    }
    const locked = db.user(user.id)!;
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil).toBeInstanceOf(Date);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(locked.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    const until = locked.lockedUntil!.getTime();
    const right = await request("/auth/login", { body: { username: "Target", password: PASSWORD } });
    expect([right.status, right.body, right.setCookie]).toEqual([401, { error: "Invalid credentials" }, null]);
    expect(db.user(user.id)?.failedLoginCount).toBe(5);
    expect(db.user(user.id)?.lockedUntil?.getTime()).toBe(until);
    db.user(user.id)!.lockedUntil = new Date(Date.now() - 1);
    const ok = await request("/auth/login", { body: { username: "Target", password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(db.user(user.id)?.failedLoginCount).toBe(0);
    expect(db.user(user.id)?.lockedUntil).toBeNull();
  }, SLOW);

  it("login: a familiar address is not locked by failures from elsewhere", async () => {
    const { db, request } = createHarness();
    const user = db.addUser({ username: "Owner", password: PASSWORD });
    expect((await request("/auth/login", { body: { username: "owner", password: PASSWORD } })).status).toBe(200);
    db.user(user.id)!.failedLoginCount = 5;
    db.user(user.id)!.lockedUntil = new Date(Date.now() + 30_000);
    const owner = await request("/auth/login", { body: { username: "owner", password: PASSWORD } });
    expect(owner.status).toBe(200);
    expect(db.user(user.id)?.lockedUntil).toBeNull();
    for (let i = 1; i <= 5; i++) {
      const response = await request("/auth/login", { body: { username: "owner", password: `wrong guess ${i}!` } });
      expect([response.status, response.body]).toEqual([401, { error: "Invalid credentials" }]);
    }
    const right = await request("/auth/login", { body: { username: "owner", password: PASSWORD } });
    expect([right.status, right.body, right.setCookie]).toEqual([401, { error: "Invalid credentials" }, null]);
    expect(db.user(user.id)?.failedLoginCount).toBe(0);
  }, SLOW);

  it("register: terms, case-insensitive usernames, email clash message, reserved names", async () => {
    const { db, request, config } = createHarness();
    const created = await request("/auth/register", {
      body: { ...TERMS, username: "Alice_Smith", email: "Alice@Example.com", password: PASSWORD },
    });
    expect(created.status).toBe(201);
    const row = db.userByName("Alice_Smith")!;
    expect(row.email).toBe("alice@example.com");
    expect(row.termsVersion).toBe(config.termsVersion);
    expect(row.termsAcceptedAt).toBeInstanceOf(Date);
    expect(row.ageConfirmedAt).toBeInstanceOf(Date);
    expect(created.setCookie).toBeTruthy();
    const sameName = await request("/auth/register", {
      body: { ...TERMS, username: "ALICE_smith", email: "other@example.com", password: PASSWORD },
    });
    expect([sameName.status, sameName.body]).toEqual([409, { error: "Username unavailable" }]);
    const sameEmail = await request("/auth/register", {
      body: { ...TERMS, username: "Someone_Else", email: "alice@example.com", password: PASSWORD },
    });
    expect([sameEmail.status, sameEmail.body]).toEqual([409, { error: "Registration could not be completed with these details" }]);
    for (const username of ["Admin", "admin_1", "Support_Team", "Guest_abc", "bot_x", "Moderator99"]) {
      const response = await request("/auth/register", {
        body: { ...TERMS, username, email: `${username}@example.com`.toLowerCase(), password: PASSWORD },
      });
      expect([response.status, response.body], username).toEqual([409, { error: "Username unavailable" }]);
    }
    const invalid = await request("/auth/register", {
      body: { ...TERMS, username: "bad name!", email: "x@example.com", password: PASSWORD },
    });
    expect(invalid.status).toBe(400);
    expect(db.users.size).toBe(1);
  }, SLOW);

  it("register: P2002 races map to 409; any other database error is 503 and leaves no user", async () => {
    const { db, request } = createHarness();
    const queue: Error[] = [];
    db.onUserCreate(() => {
      const next = queue.shift();
      if (next) throw next;
    });
    const body = (n: number) => ({ ...TERMS, username: `Racer_${n}`, email: `racer${n}@example.com`, password: PASSWORD });
    queue.push(uniqueViolation(["usernameCanonical"]));
    expect([...(await request("/auth/register", { body: body(1) }).then((response) => [response.status, response.body]))]).toEqual([409, { error: "Username unavailable" }]);
    queue.push(uniqueViolation(["email"]));
    expect([...(await request("/auth/register", { body: body(2) }).then((response) => [response.status, response.body]))]).toEqual([409, { error: "Registration could not be completed with these details" }]);
    db.fail("session.create");
    const down = await request("/auth/register", { body: body(3) });
    expect(down.status).toBe(503);
    expect(down.body.retryable).toBe(true);
    expect(db.users.size).toBe(0);
  }, SLOW);

  it("guest: name clashes are retried up to 5 times, then 503", async () => {
    const { db, request, config } = createHarness();
    let clashes = 4;
    db.onUserCreate(() => {
      if (clashes > 0) {
        clashes -= 1;
        throw uniqueViolation(["usernameCanonical"]);
      }
    });
    const ok = await request("/auth/guest", { body: TERMS });
    expect(ok.status).toBe(201);
    expect(ok.body.user.username).toMatch(/^Guest_[0-9a-f]{10}$/);
    expect(ok.body.user.isGuest).toBe(true);
    expect(db.calls["user.create"]).toBe(5);
    const row = db.user(ok.body.user.id)!;
    expect(row.termsVersion).toBe(config.termsVersion);
    expect(row.ageConfirmedAt).toBeInstanceOf(Date);
    clashes = 5;
    const exhausted = await request("/auth/guest", { body: TERMS });
    expect(exhausted.status).toBe(503);
    expect(exhausted.body.retryable).toBe(true);
    db.fail("user.create");
    expect((await request("/auth/guest", { body: TERMS })).status).toBe(503);
    expect(db.users.size).toBe(1);
  });

  it("terms: guest and register require acceptance of the current version", async () => {
    const { db, request, config } = createHarness();
    const account = { username: "Terms_Tester", email: "terms@example.com", password: PASSWORD };
    for (const path of ["/auth/guest", "/auth/register"]) {
      const extra = path === "/auth/register" ? account : {};
      for (const body of [undefined, { ...extra }, { ...extra, ...TERMS, acceptTerms: false }, { ...extra, ...TERMS, confirmAge: "yes" }, { ...extra, acceptTerms: true, confirmAge: true }]) {
        const response = await request(path, { body });
        expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(400);
        expect(response.body.code).toBe("TERMS_REQUIRED");
      }
      const outdated = await request(path, { body: { ...extra, ...TERMS, termsVersion: "2020-01-01" } });
      expect(outdated.status).toBe(409);
      expect({ code: outdated.body.code, currentVersion: outdated.body.currentVersion }).toEqual({
        code: "TERMS_OUTDATED",
        currentVersion: config.termsVersion,
      });
    }
    expect(db.users.size).toBe(0);
  });
});
