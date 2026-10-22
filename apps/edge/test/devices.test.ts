/**
 * Known devices (poker_device cookie), new-sign-in alerts, the familiar
 * device exemption from the account lock, "sign out, then sign in", forgetting
 * a device, and "keep me signed in".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieJar, cookieOf, createHarness, PASSWORD, TERMS } from "./harness";
import { adopt, signIn, signUp } from "./support/accounts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SLOW = 90_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("new sign-in alerts", () => {
  it("first sign-in after rollout from a familiar address: no alert; a second new device alerts a verified email", async () => {
    const h = createHarness();
    const user = h.db.addUser({ username: "Ora_Dev", password: PASSWORD, email: "ora@example.com", emailVerifiedAt: new Date() });
    await h.db.addSession(user.id, { ip: "127.0.0.1", createdAt: new Date(Date.now() - 10 * DAY) });

    const first = await h.request("/auth/login", { body: { identifier: "Ora_Dev", password: PASSWORD } });
    expect(first.status).toBe(200);
    expect(h.mails).toHaveLength(0);
    expect(h.db.rows("knownDevice")).toHaveLength(1);
    expect(h.db.rows("accountSecurityEvent").map((event) => event.type)).toEqual(["SIGN_IN_NEW_DEVICE"]);

    const second = await h.request("/auth/login", { country: "MT", headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" }, body: { identifier: "Ora_Dev", password: PASSWORD } });
    expect(second.status).toBe(200);
    expect(h.mails.map((mail) => [mail.kind, mail.to])).toEqual([["NEW_SIGN_IN", "ora@example.com"]]);
    const alert = h.mails[0]!;
    expect(alert.text).toContain("Device: Chrome on Windows");
    expect(alert.text).toContain("Location: MT");
    expect(alert.text).toContain("Network: 127.0.0.0/24");
    expect(alert.text).toContain("/auth/not-me#t=");
    const device = h.db.rows("knownDevice").find((row) => row.label === "Chrome on Windows")!;
    expect(device).toMatchObject({ country: "MT", lastIp: "127.0.0.0/24" });
    expect(device.deviceHash).toMatch(/^[0-9a-f]{64}$/);

    // The same browser again: known, no alert.
    const again = await h.request("/auth/login", { cookie: `poker_device=${second.cookies.poker_device}`, body: { identifier: "Ora_Dev", password: PASSWORD } });
    expect(again.status).toBe(200);
    expect(again.cookies.poker_device).toBeUndefined();
    expect(h.mails).toHaveLength(1);
  }, SLOW);

  it("an unverified address gets no alert; an unfamiliar address after rollout does alert", async () => {
    const h = createHarness();
    const unverified = await signUp(h, "Pip_Dev");
    const mails = h.mails.length;
    expect((await h.request("/auth/login", { body: { identifier: "Pip_Dev", password: PASSWORD } })).status).toBe(200);
    expect(h.mails.length).toBe(mails);
    expect(h.db.rows("accountSecurityEvent").filter((event) => event.userId === unverified.userId).map((event) => event.type)).toContain("SIGN_IN_NEW_DEVICE");

    const rollout = h.db.addUser({ username: "Quin_Dev", password: PASSWORD, email: "quin@example.com", emailVerifiedAt: new Date() });
    await h.db.addSession(rollout.id, { ip: "127.0.0.1" });
    const elsewhere = await h.request("/auth/login", { ip: "203.0.113.50", body: { identifier: "Quin_Dev", password: PASSWORD } });
    expect(elsewhere.status).toBe(200);
    expect(h.mails.at(-1)).toMatchObject({ kind: "NEW_SIGN_IN", to: "quin@example.com" });
  }, SLOW);

  it("registration itself never alerts", async () => {
    const h = createHarness();
    await signUp(h, "Ray_Dev");
    expect(h.mails.map((mail) => mail.kind)).toEqual(["VERIFY_EMAIL"]);
  }, SLOW);
});

describe("cookies", () => {
  it("the device cookie is HttpOnly, /api/auth, 400 days, Strict and Secure on https, next to the refresh and hint cookies", async () => {
    const origin = "https://poker-web.demo.workers.dev";
    const h = createHarness({ CLIENT_ORIGIN: origin });
    const response = await h.request("/auth/register", {
      baseUrl: origin,
      headers: { origin },
      body: { ...TERMS, username: "Sol_Dev", email: "sol@example.com", password: PASSWORD },
    });
    expect(response.status).toBe(201);
    expect(response.setCookies).toHaveLength(3);
    const device = response.setCookies.find((cookie) => cookie.startsWith("poker_device="))!;
    expect(device).toMatch(/^poker_device=d1\.[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/api\/auth; HttpOnly; SameSite=Strict; Secure$/);
    const hint = response.setCookies.find((cookie) => cookie.startsWith("poker_session_hint="))!;
    expect(hint).toMatch(/^poker_session_hint=1; Max-Age=\d+; Expires=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    const refresh = response.setCookie!;
    expect(refresh).toMatch(/Path=\/api\/auth; HttpOnly; SameSite=Strict; Secure$/);
    expect(/Max-Age=(\d+)/.exec(hint)?.[1]).toBe(/Max-Age=(\d+)/.exec(refresh)?.[1]);
  }, SLOW);

  it("keep me signed in off: session cookies, 12 h idle and 24 h absolute, kept through refresh", async () => {
    const h = createHarness();
    const before = Date.now();
    const account = await signUp(h, "Tam_Dev", { remember: false });
    const row = h.db.session(account.sessionId)!;
    expect(row.persistent).toBe(false);
    expect(Math.abs(row.expiresAt.getTime() - (before + 12 * HOUR))).toBeLessThan(2_000);
    expect(Math.abs(row.absoluteExpiresAt.getTime() - (before + 24 * HOUR))).toBeLessThan(2_000);
    const refreshed = await h.request("/auth/refresh", { cookie: cookieOf(account.jar.get("poker_refresh")!) });
    expect(refreshed.status).toBe(200);
    expect(refreshed.setCookie).not.toMatch(/Max-Age|Expires/);
    expect(refreshed.setCookies.find((cookie) => cookie.startsWith("poker_session_hint="))).not.toMatch(/Max-Age|Expires/);
    expect(h.db.session(account.sessionId)!.persistent).toBe(false);
    expect(h.db.session(account.sessionId)!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 12 * HOUR);

    const kept = await signIn(h, account, { remember: true });
    expect(kept.setCookie).toMatch(/Max-Age=\d+/);
    adopt(account, kept);
    const persistent = h.db.session(account.sessionId)!;
    expect(persistent.persistent).toBe(true);
    expect(persistent.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * DAY);
  }, SLOW);
});

describe("familiar devices and sessions", () => {
  it("a known device is not locked by failures from elsewhere", async () => {
    const h = createHarness();
    const uma = await signUp(h, "Uma_Dev");
    for (let i = 1; i <= 5; i++) {
      await h.request("/auth/login", { ip: "198.51.100.1", body: { identifier: "Uma_Dev", password: `wrong guess ${i}!` } });
    }
    expect(h.db.user(uma.userId)!.lockedUntil).toBeInstanceOf(Date);
    // An unfamiliar address without the device cookie: the lock holds, even with the right password.
    const stranger = await h.request("/auth/login", { ip: "192.0.2.78", body: { identifier: "Uma_Dev", password: PASSWORD } });
    expect(stranger.status).toBe(401);
    // A new address, but the browser that registered: signs in (and, as for a familiar address, clears the lock).
    const owner = await h.request("/auth/login", { ip: "192.0.2.77", cookie: uma.jar.header(), body: { identifier: "Uma_Dev", password: PASSWORD } });
    expect(owner.status).toBe(200);
    expect(h.db.user(uma.userId)!.lockedUntil).toBeNull();
  }, SLOW);

  it("signing in with an old refresh cookie ends that session (sign out, then sign in)", async () => {
    const h = createHarness();
    const vic = await signUp(h, "Vic_Dev");
    const wes = await signUp(h, "Wes_Dev");
    // Wes signs in on Vic's browser: Vic's session there ends.
    const response = await h.request("/auth/login", { cookie: vic.jar.header(), body: { identifier: "Wes_Dev", password: PASSWORD } });
    expect(response.status).toBe(200);
    expect(h.db.session(vic.sessionId)!.revokeReason).toBe("LOGOUT");
    expect(h.revoked).toEqual([{ userId: vic.userId, sessionId: vic.sessionId, reason: "LOGOUT" }]);
    expect(h.db.session(wes.sessionId)!.revokedAt).toBeNull();
  }, SLOW);

  it("lists devices with the current one, and forgetting a device ends its sessions", async () => {
    const h = createHarness();
    const xia = await signUp(h, "Xia_Dev");
    const laptop = { ...xia, jar: cookieJar() };
    adopt(laptop, await signIn(h, laptop));
    const list = await h.request("/account/devices", { method: "GET", token: xia.accessToken });
    expect(list.status).toBe(200);
    expect(list.body.devices).toHaveLength(2);
    expect(list.body.devices.filter((device: { current: boolean }) => device.current)).toHaveLength(1);
    const laptopDevice = h.db.session(laptop.sessionId)!.deviceId!;
    expect(list.body.devices.find((device: { id: string }) => device.id === laptopDevice).current).toBe(false);

    const yan = await signUp(h, "Yan_Dev");
    expect((await h.request(`/account/devices/${laptopDevice}`, { method: "DELETE", token: yan.accessToken })).status).toBe(404);

    const forgot = await h.request(`/account/devices/${laptopDevice}`, { method: "DELETE", token: xia.accessToken });
    expect(forgot.status).toBe(204);
    expect(forgot.setCookie).toBeNull();
    expect(h.db.session(laptop.sessionId)!.revokeReason).toBe("SESSION_REVOKED");
    expect(h.db.session(xia.sessionId)!.revokedAt).toBeNull();
    expect(h.revoked).toContainEqual({ userId: xia.userId, sessionId: laptop.sessionId, reason: "SESSION_REVOKED" });
    expect(h.db.rows("knownDevice").filter((row) => row.userId === xia.userId)).toHaveLength(1);
    expect(h.db.rows("accountSecurityEvent").map((event) => event.type)).toContain("DEVICE_FORGOTTEN");

    // Forgetting this browser signs it out too.
    const own = h.db.session(xia.sessionId)!.deviceId!;
    const self = await h.request(`/account/devices/${own}`, { method: "DELETE", token: xia.accessToken });
    expect(self.status).toBe(204);
    expect(self.cookies.poker_refresh).toBe("");
    expect(self.cookies.poker_session_hint).toBe("");
    expect((await h.request("/auth/me", { method: "GET", token: xia.accessToken })).status).toBe(401);
  }, SLOW);
});
