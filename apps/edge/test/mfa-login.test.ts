/**
 * TOTP enrolment and the two-step password sign-in: the MFA ticket, replay
 * protection, the second-factor lock (account-wide, or per known device),
 * backup codes, and the unchanged first step (Turnstile, one PBKDF2, lockout).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { passwords } from "../src/auth/password";
import { cookieJar, createHarness, PASSWORD, TERMS } from "./harness";
import { adopt, advanceClock, codeAt, enableTotp, nextStepCode, setStepUp, signIn, signUp } from "./support/accounts";

const SLOW = 90_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("totp enrolment", () => {
  it("setup then enable returns 10 backup codes; a wrong code is 400; a stale setup is 409", async () => {
    const h = createHarness();
    const alice = await signUp(h, "Alice_Mfa");
    const setup = await h.request("/account/2fa/totp/setup", { token: alice.accessToken, body: {} });
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUri).toContain(`secret=${setup.body.secret}`);
    expect(Date.parse(setup.body.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    const row = h.db.rows("userTotp")[0]!;
    expect(row.secretCiphertext).toMatch(/^v2\.a1\./);
    expect(row.enabledAt).toBeNull();

    const wrong = await h.request("/account/2fa/totp/enable", { token: alice.accessToken, body: { code: await codeAt(setup.body.secret, 5) } });
    expect([wrong.status, wrong.body.code]).toEqual([400, "TOTP_INVALID"]);

    const enabled = await h.request("/account/2fa/totp/enable", { token: alice.accessToken, body: { code: await codeAt(setup.body.secret) } });
    expect(enabled.status).toBe(200);
    expect(enabled.body.backupCodes).toHaveLength(10);
    expect(h.db.rows("userBackupCode")).toHaveLength(10);
    expect(h.db.rows("userTotp")[0]!.enabledAt).toBeInstanceOf(Date);
    expect(h.db.user(alice.userId)!.credentialsVersion).toBe(1);
    expect(h.db.session(alice.sessionId)!.reauthMethods).toEqual(["pwd", "otp"]);
    expect(h.db.rows("accountSecurityEvent").map((event) => event.type)).toContain("TOTP_ENABLED");

    const again = await h.request("/account/2fa/totp/setup", { token: alice.accessToken, body: {} });
    expect([again.status, again.body.code]).toEqual([409, "TOTP_ALREADY_ENABLED"]);

    const bob = await signUp(h, "Bob_Mfa");
    const stale = await h.request("/account/2fa/totp/setup", { token: bob.accessToken, body: {} });
    h.db.rows("userTotp").find((entry) => entry.userId === bob.userId)!.createdAt = new Date(Date.now() - 16 * 60_000);
    const late = await h.request("/account/2fa/totp/enable", { token: bob.accessToken, body: { code: await codeAt(stale.body.secret) } });
    expect([late.status, late.body.code]).toEqual([409, "TOTP_NOT_PENDING"]);
  }, SLOW);

  it("setup needs a step-up from the last 5 minutes", async () => {
    const h = createHarness();
    const carol = await signUp(h, "Carol_Mfa");
    setStepUp(h, carol.sessionId, ["pwd"], 6 * 60_000);
    const refused = await h.request("/account/2fa/totp/setup", { token: carol.accessToken, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "REAUTH_REQUIRED", methods: ["password"] });
    expect(h.db.rows("userTotp")).toHaveLength(0);
  }, SLOW);
});

describe("sign-in with TOTP", () => {
  it("the password step answers an MFA ticket: no refresh cookie, a device cookie, one PBKDF2", async () => {
    const h = createHarness();
    const dana = await signUp(h, "Dana_Mfa");
    await enableTotp(h, dana);
    const verify = vi.spyOn(passwords, "verify");
    const fresh = cookieJar();
    const step1 = fresh.take(await h.request("/auth/login", { body: { identifier: "dana_mfa", password: PASSWORD } }));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(step1.status).toBe(200);
    expect(step1.body).toMatchObject({ mfaRequired: true, methods: ["totp", "backup_code"] });
    expect(typeof step1.body.mfaTicket).toBe("string");
    expect(step1.body.user).toBeUndefined();
    expect(step1.setCookie).toBeNull();
    expect(step1.cookies.poker_session_hint).toBeUndefined();
    expect(step1.cookies.poker_device).toMatch(/^d1\.[A-Za-z0-9_-]{43}$/);

    // The registration browser already has a device cookie: it is not set again.
    const known = await signIn(h, dana);
    expect(known.body.mfaRequired).toBe(true);
    expect(known.cookies.poker_device).toBeUndefined();

    // The email works as the identifier too.
    const byEmail = await h.request("/auth/login", { body: { identifier: dana.email.toUpperCase(), password: PASSWORD } });
    expect(byEmail.body.mfaRequired).toBe(true);
  }, SLOW);

  it("the right code finishes the sign-in with authMethods pwd+otp; codes and tickets work once", async () => {
    const h = createHarness();
    const erin = await signUp(h, "Erin_Mfa");
    const { secret } = await enableTotp(h, erin);
    const enrolmentCode = await codeAt(secret);

    const step1 = await signIn(h, erin, { remember: false });
    // The enrolment code cannot be used again to sign in.
    const replayEnrol = await h.request("/auth/login/mfa", {
      cookie: erin.jar.header(), body: { mfaTicket: step1.body.mfaTicket, method: "totp", code: enrolmentCode },
    });
    expect([replayEnrol.status, replayEnrol.body]).toEqual([401, { error: "Invalid code", code: "MFA_INVALID" }]);

    const code = await codeAt(secret, 1);
    const done = erin.jar.take(await h.request("/auth/login/mfa", {
      cookie: erin.jar.header(), body: { mfaTicket: step1.body.mfaTicket, method: "totp", code },
    }));
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ username: "Erin_Mfa", twoFactorEnabled: true });
    adopt(erin, done);
    const row = h.db.session(erin.sessionId)!;
    expect(row.authMethods).toEqual(["pwd", "otp"]);
    expect(row.reauthMethods).toEqual(["pwd", "otp"]);
    // remember:false was carried by the ticket.
    expect(row.persistent).toBe(false);
    expect(done.setCookie).not.toMatch(/Max-Age|Expires/);

    // Same code again (same step), with a new ticket: replay refused.
    const step1b = await signIn(h, erin);
    const replay = await h.request("/auth/login/mfa", {
      cookie: erin.jar.header(), body: { mfaTicket: step1b.body.mfaTicket, method: "totp", code },
    });
    expect([replay.status, replay.body.code]).toEqual([401, "MFA_INVALID"]);

    // The used ticket, with a code that would be valid: refused as an expired sign-in.
    const reused = await h.request("/auth/login/mfa", {
      cookie: erin.jar.header(), body: { mfaTicket: step1.body.mfaTicket, method: "totp", code: await nextStepCode(secret) },
    });
    expect([reused.status, reused.body]).toEqual([401, { error: "Sign-in expired. Start again.", code: "MFA_TICKET_INVALID" }]);
  }, SLOW);

  it("a ticket is bound to its browser and to the credentials version", async () => {
    const h = createHarness();
    const finn = await signUp(h, "Finn_Mfa");
    const { secret } = await enableTotp(h, finn);
    const step1 = await signIn(h, finn);
    const otherBrowser = cookieJar({ poker_device: `d1.${"A".repeat(43)}` });
    const wrongDevice = await h.request("/auth/login/mfa", {
      cookie: otherBrowser.header(), body: { mfaTicket: step1.body.mfaTicket, method: "totp", code: await codeAt(secret, 1) },
    });
    expect([wrongDevice.status, wrongDevice.body.code]).toEqual([401, "MFA_TICKET_INVALID"]);
    const noCookie = await h.request("/auth/login/mfa", { body: { mfaTicket: step1.body.mfaTicket, method: "totp", code: await codeAt(secret, 1) } });
    expect(noCookie.body.code).toBe("MFA_TICKET_INVALID");

    // A password reset (or any credential change) since the ticket was issued.
    h.db.user(finn.userId)!.credentialsVersion += 1;
    const changed = await h.request("/auth/login/mfa", {
      cookie: finn.jar.header(), body: { mfaTicket: step1.body.mfaTicket, method: "totp", code: await codeAt(secret, 1) },
    });
    expect([changed.status, changed.body.code]).toEqual([401, "MFA_TICKET_INVALID"]);
    const garbage = await h.request("/auth/login/mfa", { cookie: finn.jar.header(), body: { mfaTicket: "x.y.z", method: "totp", code: "123456" } });
    expect(garbage.body.code).toBe("MFA_TICKET_INVALID");
  }, SLOW);

  it("five wrong codes lock the second factor (429 + Retry-After); the owner's known device is not locked", async () => {
    const h = createHarness();
    const gail = await signUp(h, "Gail_Mfa");
    const { secret } = await enableTotp(h, gail);
    const attacker = cookieJar();
    const ip = "203.0.113.9";
    const ticket = attacker.take(await h.request("/auth/login", { ip, body: { identifier: "Gail_Mfa", password: PASSWORD } })).body.mfaTicket;
    for (let i = 1; i <= 5; i++) {
      const wrong = await h.request("/auth/login/mfa", { ip, cookie: attacker.header(), body: { mfaTicket: ticket, method: "totp", code: "000000" } });
      expect([wrong.status, wrong.body.code], `attempt ${i}`).toEqual([401, "MFA_INVALID"]);
    }
    expect(h.db.user(gail.userId)!.mfaFailedCount).toBe(5);
    expect(h.db.user(gail.userId)!.mfaLockedUntil).toBeInstanceOf(Date);
    const locked = await h.request("/auth/login/mfa", { ip, cookie: attacker.header(), body: { mfaTicket: ticket, method: "totp", code: await codeAt(secret, 1) } });
    expect([locked.status, locked.body]).toEqual([429, { error: "Too many wrong codes. Try again later.", code: "MFA_LOCKED" }]);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.db.rows("accountSecurityEvent").map((event) => event.type)).toContain("MFA_LOCKOUT");

    // The owner's browser is a known device: its own counter applies.
    const owner = await signIn(h, gail);
    const ok = await h.request("/auth/login/mfa", { cookie: gail.jar.header(), body: { mfaTicket: owner.body.mfaTicket, method: "totp", code: await codeAt(secret, 1) } });
    expect(ok.status).toBe(200);
    // Signing in clears the account-wide counter.
    expect(h.db.user(gail.userId)!.mfaFailedCount).toBe(0);
    expect(h.db.user(gail.userId)!.mfaLockedUntil).toBeNull();
  }, SLOW);

  it("a backup code works once and sends a BACKUP_CODE_USED notice with the remaining count", async () => {
    const h = createHarness();
    const hana = await signUp(h, "Hana_Mfa", { verified: true });
    const { backupCodes } = await enableTotp(h, hana);
    const step1 = await signIn(h, hana);
    const used = await h.request("/auth/login/mfa", {
      cookie: hana.jar.header(), body: { mfaTicket: step1.body.mfaTicket, method: "backup_code", code: backupCodes[0]!.toLowerCase() },
    });
    expect(used.status).toBe(200);
    adopt(hana, used);
    expect(h.db.session(hana.sessionId)!.authMethods).toEqual(["pwd", "backup"]);
    expect(h.db.rows("userBackupCode").filter((code) => code.usedAt !== null)).toHaveLength(1);
    const notice = h.mails.find((mail) => mail.kind === "BACKUP_CODE_USED");
    expect(notice?.to).toBe(hana.email);
    expect(notice?.text).toContain("9 unused codes are left");
    expect(h.lastToken("BACKUP_CODE_USED")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const step1b = await signIn(h, hana);
    const again = await h.request("/auth/login/mfa", {
      cookie: hana.jar.header(), body: { mfaTicket: step1b.body.mfaTicket, method: "backup_code", code: backupCodes[0]! },
    });
    expect([again.status, again.body.code]).toEqual([401, "MFA_INVALID"]);
  }, SLOW);

  it("without the account-security secrets a TOTP account gets 503, never a misleading 401", async () => {
    const h = createHarness({ AUTH_HMAC_SECRET: "", AUTH_ENCRYPTION_KEYS: "", AUTH_ENCRYPTION_ACTIVE_KEY_ID: "" });
    const user = h.db.addUser({ username: "Ivy_Mfa", password: PASSWORD });
    h.db.insert("userTotp", { userId: user.id, secretCiphertext: "v2.a1.00.00.AA", enabledAt: new Date(), lastUsedStep: 0 });
    const response = await h.request("/auth/login", { body: { identifier: "Ivy_Mfa", password: PASSWORD } });
    expect([response.status, response.body.code]).toEqual([503, "SECURITY_NOT_CONFIGURED"]);
    expect(response.setCookie).toBeNull();
    // A wrong password is still the ordinary 401.
    const wrong = await h.request("/auth/login", { body: { identifier: "Ivy_Mfa", password: "wrong password!!" } });
    expect([wrong.status, wrong.body]).toEqual([401, { error: "Invalid credentials" }]);
    const config = await h.request("/auth/config", { method: "GET" });
    expect(config.body).toMatchObject({ totpEnabled: false, passkeysEnabled: false });
  }, SLOW);

  it("the first step is unchanged for TOTP accounts: Turnstile, then lockout with the same 401 and no ticket", async () => {
    const h = createHarness();
    const jack = await signUp(h, "Jack_Mfa");
    await enableTotp(h, jack);
    const noTurnstile = await h.request("/auth/login", { body: { identifier: "Jack_Mfa", password: PASSWORD, turnstileToken: "" } });
    expect([noTurnstile.status, noTurnstile.body.code]).toEqual([403, "TURNSTILE_FAILED"]);
    const ip = "198.51.100.7";
    for (let i = 1; i <= 5; i++) {
      const wrong = await h.request("/auth/login", { ip, body: { identifier: "Jack_Mfa", password: `wrong guess ${i}!` } });
      expect([wrong.status, wrong.body]).toEqual([401, { error: "Invalid credentials" }]);
    }
    expect(h.db.user(jack.userId)!.lockedUntil).toBeInstanceOf(Date);
    const right = await h.request("/auth/login", { ip, body: { identifier: "Jack_Mfa", password: PASSWORD } });
    expect([right.status, right.body]).toEqual([401, { error: "Invalid credentials" }]);
    expect(h.db.rows("authNonce")).toHaveLength(0);
  }, SLOW);

  it("the TOTP replay guard holds across clock steps: each step's code signs in once", async () => {
    const h = createHarness();
    const kim = await signUp(h, "Kim_Mfa");
    const { secret } = await enableTotp(h, kim);
    for (let round = 0; round < 2; round++) {
      advanceClock(31_000);
      const step1 = await signIn(h, kim);
      const ok = await h.request("/auth/login/mfa", { cookie: kim.jar.header(), body: { mfaTicket: step1.body.mfaTicket, method: "totp", code: await codeAt(secret) } });
      expect(ok.status, `round ${round}`).toBe(200);
    }
  }, SLOW);
});

describe("register", () => {
  it("answers the security extras and a device cookie, and sends a verification email", async () => {
    const h = createHarness();
    const result = await h.request("/auth/register", { body: { ...TERMS, username: "Lena_New", email: "lena@example.com", password: PASSWORD } });
    expect(result.status).toBe(201);
    expect(result.body.user).toMatchObject({ emailVerified: false, twoFactorEnabled: false, passkeyCount: 0, isGuest: false });
    expect(result.setCookies).toHaveLength(3);
    expect(Object.keys(result.cookies).sort()).toEqual(["poker_device", "poker_refresh", "poker_session_hint"]);
    expect(h.mails.map((mail) => mail.kind)).toEqual(["VERIFY_EMAIL"]);
    expect(h.mails[0]!.text).toContain("/verify-email#t=");
    const events = h.db.rows("accountSecurityEvent");
    expect(events.map((event) => event.type)).toEqual(["SIGN_IN"]);
    expect(events[0]!.data).toMatchObject({ registered: true, methods: ["pwd"] });
  }, SLOW);
});
