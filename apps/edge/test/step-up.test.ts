/**
 * Step-up: the 5-minute session window for account changes
 * (/api/auth/reauth/*), requireMoneyAuth, and the single-use, action-bound
 * StepUpGrant for money (/api/auth/step-up and /api/auth/step-up/email-code).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireMoneyAuth } from "../src/auth/step-up";
import { authed, authRoute } from "../src/http/guard";
import { createHarness, PASSWORD, type Harness } from "./harness";
import { advanceClock, codeAt, enableTotp, setStepUp, signUp, type Account } from "./support/accounts";
import { SoftAuthenticator } from "./support/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const SLOW = 90_000;
const BIND = "a".repeat(64);
const OTHER_BIND = "b".repeat(64);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function moneyHarness(): Harness {
  return createHarness({ CLIENT_ORIGIN: ORIGIN }, {
    routes(app) {
      app.post("/api/test/money", authRoute(async (c) => {
        const gate = await authed(c);
        if (!gate.ok) return gate.response;
        const body = c.get("jsonBody") as { needSecondFactor?: boolean } | undefined;
        return await requireMoneyAuth(c, gate, { needSecondFactor: body?.needSecondFactor === true }) ?? c.json({ ok: true });
      }));
    },
  });
}

async function addPasskey(h: Harness, account: Account): Promise<SoftAuthenticator> {
  setStepUp(h, account.sessionId, ["pwd"]);
  const auth = new SoftAuthenticator("localhost", ORIGIN);
  const options = await h.request("/account/passkeys/options", { token: account.accessToken, body: {} });
  const response = await h.request("/account/passkeys", {
    token: account.accessToken,
    body: { challengeToken: options.body.challengeToken, credential: await auth.create(options.body.options) },
  });
  if (response.status !== 201) throw new Error(`passkey: ${response.status}`);
  return auth;
}

describe("session step-up (account changes)", () => {
  it("every step-up route answers 403 REAUTH_REQUIRED once the window is older than 5 minutes", async () => {
    const h = moneyHarness();
    const ada = await signUp(h, "Ada_Step");
    setStepUp(h, ada.sessionId, ["pwd", "otp"], 5 * 60_000 + 1_000);
    const routes: [string, string, unknown][] = [
      ["POST", "/account/password", { newPassword: "another fine passphrase" }],
      ["POST", "/account/email", { newEmail: "ada2@example.com" }],
      ["POST", "/account/2fa/totp/setup", {}],
      ["DELETE", "/account/2fa/totp", undefined],
      ["POST", "/account/2fa/backup-codes", {}],
      ["POST", "/account/passkeys/options", {}],
      ["POST", "/account/passkeys", { challengeToken: "x", credential: {} }],
      ["DELETE", "/account/passkeys/some-id", undefined],
    ];
    for (const [method, path, body] of routes) {
      const response = await h.request(path, { method, token: ada.accessToken, body });
      expect([response.status, response.body.code], `${method} ${path}`).toEqual([403, "REAUTH_REQUIRED"]);
      expect(response.body.methods).toEqual(["password"]);
    }
  }, SLOW);

  it("reauth/password opens the window for a password-only account; a TOTP account needs reauth/mfa too", async () => {
    const h = moneyHarness();
    const bo = await signUp(h, "Bo_Step");
    setStepUp(h, bo.sessionId, ["pwd"], 10 * 60_000);
    const wrong = await h.request("/auth/reauth/password", { token: bo.accessToken, body: { password: "not my password" } });
    expect([wrong.status, wrong.body]).toEqual([401, { error: "Invalid credentials" }]);
    const ok = await h.request("/auth/reauth/password", { token: bo.accessToken, body: { password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(Date.parse(ok.body.reauthenticatedUntil) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(h.db.session(bo.sessionId)!.reauthMethods).toEqual(["pwd"]);
    expect(h.db.rows("accountSecurityEvent").map((event) => event.type)).toContain("STEP_UP");

    const cy = await signUp(h, "Cy_Step", { verified: true });
    const { secret, backupCodes } = await enableTotp(h, cy);
    setStepUp(h, cy.sessionId, ["pwd"], 10 * 60_000);
    const ticket = await h.request("/auth/reauth/password", { token: cy.accessToken, body: { password: PASSWORD } });
    expect(ticket.body).toMatchObject({ mfaRequired: true, methods: ["totp", "backup_code"] });
    const window = h.db.session(cy.sessionId)!.reauthAt!;
    expect(Date.now() - window.getTime()).toBeGreaterThan(9 * 60_000);
    // A fresh window with only the password is not enough for a TOTP account.
    setStepUp(h, cy.sessionId, ["pwd"]);
    const needSecond = await h.request("/account/2fa/backup-codes", { token: cy.accessToken, body: {} });
    expect(needSecond.body).toMatchObject({ code: "REAUTH_REQUIRED", needs: "second_factor" });

    const other = await signUp(h, "Dee_Step");
    const foreign = await h.request("/auth/reauth/mfa", { token: other.accessToken, body: { mfaTicket: ticket.body.mfaTicket, method: "totp", code: await codeAt(secret, 1) } });
    expect(foreign.body.code).toBe("MFA_TICKET_INVALID");
    const done = await h.request("/auth/reauth/mfa", { token: cy.accessToken, body: { mfaTicket: ticket.body.mfaTicket, method: "totp", code: await codeAt(secret, 1) } });
    expect(done.status).toBe(200);
    expect(h.db.session(cy.sessionId)!.reauthMethods).toEqual(["pwd", "otp"]);
    const codes = await h.request("/account/2fa/backup-codes", { token: cy.accessToken, body: {} });
    expect(codes.status).toBe(200);
    expect(codes.body.backupCodes).toHaveLength(10);
    expect(codes.body.backupCodes).not.toContain(backupCodes[0]);
    expect(h.mails.at(-1)!.kind).toBe("BACKUP_CODES_REGENERATED");
  }, SLOW);

  it("password change needs a step-up that included the password; it keeps this session and ends the others", async () => {
    const h = moneyHarness();
    const eve = await signUp(h, "Eve_Step", { verified: true });
    const other = await h.db.addSession(eve.userId);
    setStepUp(h, eve.sessionId, ["passkey"]);
    const refused = await h.request("/account/password", { token: eve.accessToken, body: { newPassword: "another fine passphrase" } });
    expect(refused.body).toMatchObject({ code: "REAUTH_REQUIRED", needs: "password", methods: ["password"] });
    setStepUp(h, eve.sessionId, ["pwd"]);
    const weak = await h.request("/account/password", { token: eve.accessToken, body: { newPassword: "Eve_Step is my password" } });
    expect(weak.body.code).toBe("PASSWORD_WEAK");
    const changed = await h.request("/account/password", { token: eve.accessToken, body: { newPassword: "another fine passphrase" } });
    expect([changed.status, changed.body]).toEqual([200, { revokedSessions: 1 }]);
    expect(h.db.session(eve.sessionId)!.revokedAt).toBeNull();
    expect(h.db.session(other.id)!.revokeReason).toBe("PASSWORD_CHANGED");
    expect(h.revoked).toEqual([{ userId: eve.userId, sessionId: other.id, reason: "PASSWORD_CHANGED" }]);
    const user = h.db.user(eve.userId)!;
    expect(user.credentialsVersion).toBe(1);
    expect(user.passwordChangedAt).toBeInstanceOf(Date);
    expect(user.securityHoldUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(h.mails.at(-1)).toMatchObject({ kind: "PASSWORD_CHANGED", to: eve.email });
    expect((await h.request("/auth/login", { body: { identifier: "Eve_Step", password: "another fine passphrase" } })).status).toBe(200);
  }, SLOW);

  it("requireMoneyAuth: a verified email, a second-factor step-up when asked, and no security hold", async () => {
    const h = moneyHarness();
    const fox = await signUp(h, "Fox_Step");
    const money = (body: unknown = { needSecondFactor: true }) => h.request("/test/money", { token: fox.accessToken, body });
    expect((await money()).body.code).toBe("EMAIL_NOT_VERIFIED");
    h.db.user(fox.userId)!.emailVerifiedAt = new Date();
    const passwordOnly = await money();
    expect(passwordOnly.body).toMatchObject({ code: "REAUTH_REQUIRED", needs: "second_factor" });
    expect((await money({})).status).toBe(200);
    setStepUp(h, fox.sessionId, ["passkey"]);
    expect((await money()).status).toBe(200);
    h.db.user(fox.userId)!.securityHoldUntil = new Date(Date.now() + 3_600_000);
    const held = await money();
    expect([held.status, held.body.code]).toEqual([403, "SECURITY_HOLD"]);
    expect(Date.parse(held.body.until)).toBeGreaterThan(Date.now());
  }, SLOW);

  it("failed password step-ups count toward the account lock", async () => {
    const h = moneyHarness();
    const gus = await signUp(h, "Gus_Step");
    const ip = "203.0.113.200";
    for (let i = 1; i <= 5; i++) {
      const response = await h.request("/auth/reauth/password", { ip, token: gus.accessToken, body: { password: `wrong guess ${i}!` } });
      expect(response.status).toBe(401);
    }
    expect(h.db.user(gus.userId)!.failedLoginCount).toBe(5);
    expect(h.db.user(gus.userId)!.lockedUntil).toBeInstanceOf(Date);
    const locked = await h.request("/auth/reauth/password", { ip, token: gus.accessToken, body: { password: PASSWORD } });
    expect([locked.status, locked.body]).toEqual([401, { error: "Invalid credentials" }]);
  }, SLOW);
});

describe("money step-up grants", () => {
  it("password + TOTP mints a 5-minute grant bound to the session, purpose and action", async () => {
    const h = moneyHarness();
    const hal = await signUp(h, "Hal_Grant", { verified: true });
    const { secret } = await enableTotp(h, hal);
    // Enrolled with a password-only step-up: withdrawals are held (see the enrolment test below). Let it pass.
    h.db.user(hal.userId)!.securityHoldUntil = null;
    const grant = (proof: unknown, purpose = "withdrawal", bind = BIND) => h.request("/auth/step-up", { token: hal.accessToken, body: { purpose, bind, proof } });
    expect((await grant({ kind: "totp", password: "wrong password", code: await codeAt(secret, 1) })).status).toBe(401);
    const badCode = await grant({ kind: "totp", password: PASSWORD, code: "000000" });
    expect([badCode.status, badCode.body.code]).toEqual([401, "MFA_INVALID"]);
    expect((await grant({ kind: "password_email", password: PASSWORD, emailCode: "123456", emailChallengeToken: "x" })).body.code).toBe("STEP_UP_METHOD_NOT_ALLOWED");
    expect((await grant({ kind: "totp", password: PASSWORD, code: await codeAt(secret, 1) }, "admin_payments")).body.code).toBe("STEP_UP_METHOD_NOT_ALLOWED");
    expect((await grant({ kind: "totp", password: PASSWORD, code: "000000" }, "withdrawal", "NOT-HEX")).status).toBe(400);

    const ok = await grant({ kind: "totp", password: PASSWORD, code: await codeAt(secret, 1) });
    expect(ok.status).toBe(200);
    const row = h.db.rows("stepUpGrant").find((entry) => entry.id === ok.body.stepUpGrantId)!;
    expect(row).toMatchObject({ userId: hal.userId, sessionId: hal.sessionId, purpose: "withdrawal", bindHash: BIND, method: "TOTP", consumedAt: null });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(5 * 60_000);
    expect(Date.parse(ok.body.expiresAt)).toBe(row.expiresAt.getTime());
    // The TOTP step is spent: the same code cannot mint a second grant.
    expect((await grant({ kind: "totp", password: PASSWORD, code: await codeAt(secret, 1) })).body.code).toBe("MFA_INVALID");

    // A security hold blocks withdrawals and destination changes.
    h.db.user(hal.userId)!.securityHoldUntil = new Date(Date.now() + 3_600_000);
    expect((await grant({ kind: "totp", password: PASSWORD, code: await codeAt(secret, 1) })).body.code).toBe("SECURITY_HOLD");
  }, SLOW);

  it("password + emailed code, only for accounts without TOTP or passkeys: bound, capped, 5 tries, single use", async () => {
    const h = moneyHarness();
    const ivy = await signUp(h, "Ivy_Grant");
    const sendCode = (bind = BIND, token = ivy.accessToken) => h.request("/auth/step-up/email-code", { token, body: { purpose: "withdrawal", bind } });
    expect((await sendCode()).body.code).toBe("EMAIL_NOT_VERIFIED");
    h.db.user(ivy.userId)!.emailVerifiedAt = new Date();
    const sent = await sendCode();
    expect(sent.status).toBe(202);
    expect(Date.parse(sent.body.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const mail = h.mails.at(-1)!;
    expect([mail.kind, mail.to]).toEqual(["STEP_UP_CODE", ivy.email]);
    const code = /is (\d{6})/.exec(mail.text)![1]!;
    const challenge = h.db.rows("stepUpEmailChallenge")[0]!;
    expect(challenge.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge.codeHash).not.toContain(code);

    const grant = (emailCode: string, bind = BIND, emailChallengeToken = sent.body.emailChallengeToken) =>
      h.request("/auth/step-up", { token: ivy.accessToken, body: { purpose: "withdrawal", bind, proof: { kind: "password_email", password: PASSWORD, emailCode, emailChallengeToken } } });
    const wrongCode = code === "000000" ? "111111" : "000000";
    const wrong = await grant(wrongCode);
    expect([wrong.status, wrong.body.code, wrong.body.attemptsRemaining]).toEqual([401, "EMAIL_CODE_INVALID", 4]);
    expect((await grant(code, OTHER_BIND)).body.code).toBe("CHALLENGE_INVALID");
    const ok = await grant(code);
    expect(ok.status).toBe(200);
    expect(h.db.rows("stepUpGrant").at(-1)).toMatchObject({ method: "PASSWORD_EMAIL", bindHash: BIND });
    expect((await grant(code)).body.code).toBe("CHALLENGE_INVALID");

    // Five wrong tries exhaust a code; a new request voids the previous one; codes expire after 10 minutes.
    const second = await sendCode();
    const secondCode = /is (\d{6})/.exec(h.mails.at(-1)!.text)![1]!;
    const miss = secondCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await grant(miss, BIND, second.body.emailChallengeToken)).body.code).toBe("EMAIL_CODE_INVALID");
    expect((await grant(secondCode, BIND, second.body.emailChallengeToken)).body.code).toBe("CHALLENGE_INVALID");
    const third = await sendCode();
    const thirdCode = /is (\d{6})/.exec(h.mails.at(-1)!.text)![1]!;
    advanceClock(11 * 60_000);
    expect((await grant(thirdCode, BIND, third.body.emailChallengeToken)).body.code).toBe("CHALLENGE_INVALID");

    // Another session of the same account cannot use this session's code.
    const otherSession = await h.db.addSession(ivy.userId);
    const fourth = await sendCode();
    const fourthCode = /is (\d{6})/.exec(h.mails.at(-1)!.text)![1]!;
    const elsewhere = await h.request("/auth/step-up", { token: otherSession.accessToken, body: { purpose: "withdrawal", bind: BIND, proof: { kind: "password_email", password: PASSWORD, emailCode: fourthCode, emailChallengeToken: fourth.body.emailChallengeToken } } });
    expect(elsewhere.body.code).toBe("CHALLENGE_INVALID");

    // Per-account cap: 5 codes per hour (this is the fifth; the sixth is refused).
    expect((await sendCode()).status).toBe(202);
    const capped = await sendCode();
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.db.rows("stepUpEmailChallenge")).toHaveLength(5);
  }, SLOW);

  it("accounts with a second factor cannot use the emailed code", async () => {
    const h = moneyHarness();
    const jay = await signUp(h, "Jay_Grant", { verified: true });
    await enableTotp(h, jay);
    const response = await h.request("/auth/step-up/email-code", { token: jay.accessToken, body: { purpose: "withdrawal", bind: BIND } });
    expect([response.status, response.body.code]).toEqual([403, "STEP_UP_METHOD_NOT_ALLOWED"]);
  }, SLOW);

  it("a passkey grant needs a challenge issued for exactly this purpose and action", async () => {
    const h = moneyHarness();
    const kai = await signUp(h, "Kai_Grant", { verified: true });
    const auth = await addPasskey(h, kai);
    // Added with a password-only step-up: withdrawals are held. Let it pass.
    h.db.user(kai.userId)!.securityHoldUntil = null;
    const options = async (body: unknown) => (await h.request("/auth/reauth/passkey/options", { token: kai.accessToken, body })).body;
    const grant = async (opts: { challengeToken: string; options: { challenge: string } }, purpose = "withdrawal", bind = BIND) =>
      h.request("/auth/step-up", { token: kai.accessToken, body: { purpose, bind, proof: { kind: "passkey", challengeToken: opts.challengeToken, credential: await auth.get(opts.options) } } });

    const unbound = await options({});
    expect((await grant(unbound)).body.code).toBe("CHALLENGE_INVALID");
    const otherAction = await options({ purpose: "withdrawal", bind: OTHER_BIND });
    expect((await grant(otherAction)).body.code).toBe("CHALLENGE_INVALID");
    expect((await h.request("/auth/reauth/passkey/options", { token: kai.accessToken, body: { purpose: "withdrawal" } })).status).toBe(400);

    const bound = await options({ purpose: "withdrawal", bind: BIND });
    // A bound challenge cannot open the account-change window instead.
    const misuse = await h.request("/auth/reauth/passkey", { token: kai.accessToken, body: { challengeToken: bound.challengeToken, credential: await auth.get(bound.options) } });
    expect(misuse.body.code).toBe("CHALLENGE_INVALID");
    const ok = await grant(bound);
    expect(ok.status).toBe(200);
    expect(h.db.rows("stepUpGrant").at(-1)).toMatchObject({ method: "PASSKEY", purpose: "withdrawal", bindHash: BIND });
    expect((await grant(bound)).body.code).toBe("CHALLENGE_INVALID");

    // Admin payment decisions take a passkey only, and are not held by a security hold.
    h.db.user(kai.userId)!.securityHoldUntil = new Date(Date.now() + 3_600_000);
    const admin = await options({ purpose: "admin_payments", bind: BIND });
    const adminGrant = await grant(admin, "admin_payments");
    expect(adminGrant.status).toBe(200);
    expect(h.db.rows("stepUpGrant").at(-1)).toMatchObject({ method: "PASSKEY", purpose: "admin_payments" });
    const held = await options({ purpose: "payout_destination", bind: BIND });
    expect((await grant(held, "payout_destination")).body.code).toBe("SECURITY_HOLD");
  }, SLOW);

  it("a factor enrolled with only the password holds withdrawals, so it cannot replace the emailed code for money at once", async () => {
    // Someone who knows only the password of a password-only account (no access to its inbox).
    const h = moneyHarness();
    const ada = await signUp(h, "Ada_Hold", { verified: true });
    const withdraw = (code: string) => h.request("/auth/step-up", { token: ada.accessToken, body: { purpose: "withdrawal", bind: BIND, proof: { kind: "totp", password: PASSWORD, code } } });
    expect((await withdraw("123456")).body.code).toBe("STEP_UP_METHOD_NOT_ALLOWED");
    const { secret } = await enableTotp(h, ada);
    expect(h.db.user(ada.userId)!.securityHoldUntil!.getTime()).toBeGreaterThan(Date.now());
    const held = await withdraw(await codeAt(secret, 1));
    expect([held.status, held.body.code]).toEqual([403, "SECURITY_HOLD"]);
    // The owner's notice ("This wasn't me") is the way out; the hold gives them time to see it.
    expect(h.mails.at(-1)!.kind).toBe("TOTP_ENABLED");

    // The same for a first passkey.
    const bo = await signUp(h, "Bo_Hold", { verified: true });
    await addPasskey(h, bo);
    expect(h.db.user(bo.userId)!.securityHoldUntil!.getTime()).toBeGreaterThan(Date.now());

    // A factor added after a step-up with an existing second factor sets no hold.
    const cy = await signUp(h, "Cy_Hold", { verified: true });
    const cyKey = await addPasskey(h, cy);
    h.db.user(cy.userId)!.securityHoldUntil = null;
    const reauth = (await h.request("/auth/reauth/passkey/options", { token: cy.accessToken, body: {} })).body;
    const stepped = await h.request("/auth/reauth/passkey", { token: cy.accessToken, body: { challengeToken: reauth.challengeToken, credential: await cyKey.get(reauth.options) } });
    expect(stepped.status).toBe(200);
    const setup = await h.request("/account/2fa/totp/setup", { token: cy.accessToken, body: {} });
    expect((await h.request("/account/2fa/totp/enable", { token: cy.accessToken, body: { code: await codeAt(setup.body.secret) } })).status).toBe(200);
    expect(h.db.user(cy.userId)!.securityHoldUntil).toBeNull();
  }, SLOW);

  it("is unavailable (503) without the account-security secrets", async () => {
    const h = createHarness({ AUTH_HMAC_SECRET: "", AUTH_ENCRYPTION_KEYS: "", AUTH_ENCRYPTION_ACTIVE_KEY_ID: "" });
    const lea = await signUp(h, "Lea_Grant", { verified: true });
    const response = await h.request("/auth/step-up", { token: lea.accessToken, body: { purpose: "withdrawal", bind: BIND, proof: { kind: "totp", password: PASSWORD, code: "123456" } } });
    expect([response.status, response.body.code]).toEqual([503, "SECURITY_NOT_CONFIGURED"]);
  }, SLOW);
});

describe("account overview", () => {
  it("GET /account/security and the paged history", async () => {
    const h = moneyHarness();
    const mo = await signUp(h, "Mo_Over", { verified: true });
    await enableTotp(h, mo);
    const security = await h.request("/account/security", { method: "GET", token: mo.accessToken });
    expect(security.status).toBe(200);
    expect(security.body).toMatchObject({
      email: mo.email,
      emailVerified: true,
      pendingEmail: null,
      totp: { enabled: true, backupCodesRemaining: 10 },
      passkeys: [],
      capabilities: { email: false, passkeys: true, totp: true },
    });
    // The first second factor was enrolled after a password-only step-up: withdrawals are held.
    expect(Date.parse(security.body.securityHoldUntil)).toBeGreaterThan(Date.now());
    expect(Date.parse(security.body.passwordChangedAt)).toBeGreaterThan(0);
    expect(Date.parse(security.body.stepUpUntil)).toBeGreaterThan(Date.now());
    expect(Date.parse(security.body.totp.enabledAt)).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      advanceClock(1_000);
      await h.request("/auth/logout-all", { token: mo.accessToken, body: { exceptCurrent: true } });
    }
    const page1 = await h.request("/account/events?limit=2", { method: "GET", token: mo.accessToken });
    expect(page1.body.events).toHaveLength(2);
    expect(page1.body.events.map((event: { type: string }) => event.type)).toEqual(["LOGOUT_ALL", "LOGOUT_ALL"]);
    expect(Object.keys(page1.body.events[0]).sort()).toEqual(["country", "createdAt", "data", "id", "ip", "type", "userAgent"]);
    const page2 = await h.request(`/account/events?limit=50&before=${encodeURIComponent(page1.body.next)}`, { method: "GET", token: mo.accessToken });
    expect(page2.body.events.map((event: { type: string }) => event.type)).toEqual(["LOGOUT_ALL", "TOTP_ENABLED", "SIGN_IN"]);
    expect(page2.body.next).toBeNull();
    expect((await h.request("/account/events?limit=500", { method: "GET", token: mo.accessToken })).status).toBe(400);
    expect((await h.request("/account/security", { method: "GET" })).status).toBe(401);
  }, SLOW);

  it("TOTP can be switched off with a second-factor step-up; it holds withdrawals and keeps the codes for a lockdown", async () => {
    const h = moneyHarness();
    const ned = await signUp(h, "Ned_Over", { verified: true });
    await enableTotp(h, ned);
    setStepUp(h, ned.sessionId, ["pwd"]);
    expect((await h.request("/account/2fa/totp", { method: "DELETE", token: ned.accessToken })).body.needs).toBe("second_factor");
    setStepUp(h, ned.sessionId, ["pwd", "otp"]);
    expect((await h.request("/account/2fa/totp", { method: "DELETE", token: ned.accessToken })).status).toBe(204);
    expect(h.db.rows("userTotp")[0]!.disabledAt).toBeInstanceOf(Date);
    expect(h.db.rows("userBackupCode")).toHaveLength(10);
    expect(h.db.user(ned.userId)!.securityHoldUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(h.mails.at(-1)!.kind).toBe("TOTP_DISABLED");
    expect((await h.request("/account/2fa/totp", { method: "DELETE", token: ned.accessToken })).body.code).toBe("TOTP_NOT_ENABLED");
    expect((await h.request("/account/2fa/backup-codes", { token: ned.accessToken, body: {} })).body.code).toBe("TOTP_NOT_ENABLED");
    // Password sign-in no longer asks for a code.
    const login = await h.request("/auth/login", { body: { identifier: "Ned_Over", password: PASSWORD } });
    expect(login.body.accessToken).toBeTruthy();
    // Setting it up again replaces the old authenticator and its codes.
    const setup = await h.request("/account/2fa/totp/setup", { token: ned.accessToken, body: {} });
    expect(setup.status).toBe(200);
    expect(h.db.rows("userBackupCode")).toHaveLength(0);
  }, SLOW);
});
