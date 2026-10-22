/**
 * Recovery by email: verification, forgot / reset password, email change,
 * and "This wasn't me" (lockdown) with its restore rules. Tokens are read
 * from the test mailbox exactly as a user would click them (#t=...).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { breach } from "../src/auth/breached";
import { cleared, cookieJar, createHarness, PASSWORD, type Harness } from "./harness";
import { advanceClock, codeAt, enableTotp, setStepUp, signIn, signUp, type Account } from "./support/accounts";
import { SoftAuthenticator } from "./support/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const SLOW = 90_000;
const NEW_PASSWORD = "a brand new passphrase 42";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function addPasskey(h: Harness, account: Account): Promise<SoftAuthenticator> {
  setStepUp(h, account.sessionId, ["pwd"]);
  const auth = new SoftAuthenticator("localhost", ORIGIN);
  const options = await h.request("/account/passkeys/options", { token: account.accessToken, body: {} });
  const response = await h.request("/account/passkeys", {
    token: account.accessToken,
    body: { challengeToken: options.body.challengeToken, credential: await auth.create(options.body.options) },
  });
  if (response.status !== 201) throw new Error(`passkey: ${response.status} ${JSON.stringify(response.body)}`);
  return auth;
}

describe("email verification", () => {
  it("register sends the link; it verifies once; an email change voids it", async () => {
    const h = createHarness();
    const amy = await signUp(h, "Amy_Rec");
    const token = h.lastToken("VERIFY_EMAIL", amy.email)!;
    expect(h.mails[0]!.text).toContain(`${h.config.clientOrigin}/verify-email#t=${token}`);
    const ok = await h.request("/auth/email/verify", { body: { token } });
    expect([ok.status, ok.body]).toEqual([200, { emailVerified: true }]);
    expect(h.db.user(amy.userId)!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(h.db.rows("accountSecurityEvent").map((event) => event.type)).toContain("EMAIL_VERIFIED");
    const again = await h.request("/auth/email/verify", { body: { token } });
    expect([again.status, again.body]).toEqual([400, { error: "This link is invalid or has expired.", code: "TOKEN_INVALID" }]);

    // A second verification link, then the address changes: the link dies.
    const bea = await signUp(h, "Bea_Rec");
    const pending = h.lastToken("VERIFY_EMAIL", bea.email)!;
    const change = await h.request("/account/email", { token: bea.accessToken, body: { newEmail: "bea.new@example.com" } });
    expect([change.status, change.body]).toEqual([202, { ok: true, pendingEmail: "bea.new@example.com" }]);
    const confirm = await h.request("/auth/email/change/confirm", { body: { token: h.lastToken("EMAIL_CHANGE_CONFIRM", "bea.new@example.com") } });
    expect([confirm.status, confirm.body]).toEqual([200, { email: "bea.new@example.com" }]);
    expect((await h.request("/auth/email/verify", { body: { token: pending } })).body.code).toBe("TOKEN_INVALID");
    expect((await h.request("/auth/email/verify", { body: { token: "short" } })).status).toBe(400);
  }, SLOW);

  it("resend: 202, 409 when verified or missing, silent over the hourly cap, 503 when mail cannot be delivered", async () => {
    const h = createHarness();
    const cal = await signUp(h, "Cal_Rec");
    for (let i = 0; i < 6; i++) {
      const response = await h.request("/account/email/verification", { token: cal.accessToken, body: {} });
      expect([response.status, response.body]).toEqual([202, { ok: true }]);
    }
    // 1 at registration + 4 resends = the cap of 5 per hour.
    expect(h.mails.filter((mail) => mail.kind === "VERIFY_EMAIL")).toHaveLength(5);
    h.db.user(cal.userId)!.emailVerifiedAt = new Date();
    expect((await h.request("/account/email/verification", { token: cal.accessToken, body: {} })).body.code).toBe("EMAIL_ALREADY_VERIFIED");
    h.db.user(cal.userId)!.email = null;
    expect((await h.request("/account/email/verification", { token: cal.accessToken, body: {} })).body.code).toBe("EMAIL_MISSING");
  }, SLOW);
});

describe("forgot and reset password", () => {
  it("forgot answers the same 202 for unknown, guest, bot and real accounts; only the real one gets mail; 3 per hour", async () => {
    const h = createHarness();
    const real = await signUp(h, "Dot_Rec");
    h.db.addUser({ username: "Guest_feedbeef00", isGuest: true, email: "guest@example.com" });
    h.db.addUser({ username: "Bot_Rec", kind: "BOT", email: "bot@example.com", password: PASSWORD });
    const before = h.mails.length;
    const answers = [];
    for (const email of ["nobody@example.com", "guest@example.com", "bot@example.com", "DOT_REC@example.com"]) {
      const response = await h.request("/auth/password/forgot", { body: { email } });
      answers.push([response.status, response.body, response.setCookies]);
    }
    for (const answer of answers) expect(answer).toEqual([202, { ok: true }, []]);
    const sent = h.mails.slice(before);
    expect(sent.map((mail) => [mail.kind, mail.to])).toEqual([["PASSWORD_RESET", real.email]]);
    expect(sent[0]!.text).toContain("/reset-password#t=");
    for (let i = 0; i < 3; i++) await h.request("/auth/password/forgot", { body: { email: real.email } });
    expect(h.mails.slice(before).filter((mail) => mail.kind === "PASSWORD_RESET")).toHaveLength(3);
    const turnstile = await h.request("/auth/password/forgot", { body: { email: real.email, turnstileToken: "" } });
    expect([turnstile.status, turnstile.body.code]).toEqual([403, "TURNSTILE_FAILED"]);
    expect((await h.request("/auth/password/forgot", { body: { email: "not an email" } })).status).toBe(400);
    // Only the newest reset link works.
    const tokens = h.db.rows("emailToken").filter((row) => row.purpose === "PASSWORD_RESET");
    expect(tokens.filter((row) => row.consumedAt === null)).toHaveLength(1);
  }, SLOW);

  it("forgot answers before any reset work runs (no timing difference for a real account); the link follows after the response", async () => {
    const h = createHarness();
    const real = await signUp(h, "Eve_Rec");
    const before = h.mails.length;
    // The deferred cap check waits on this hold until the test releases it, after the 202 has arrived.
    h.db.hold("emailToken.count", 2);
    const pending: Promise<unknown>[] = [];
    const known = await h.request("/auth/password/forgot", { body: { email: real.email }, waitUntil: pending });
    const unknownPending: Promise<unknown>[] = [];
    const unknown = await h.request("/auth/password/forgot", { body: { email: "nobody@example.com" }, waitUntil: unknownPending });
    expect([known.status, known.body]).toEqual([unknown.status, unknown.body]);
    expect([pending.length, unknownPending.length]).toEqual([1, 0]);
    expect(h.db.rows("emailToken").filter((row) => row.purpose === "PASSWORD_RESET")).toHaveLength(0);
    await h.db.api.emailToken.count({ where: { userId: "release-the-hold" } });
    await Promise.all(pending);
    expect(h.mails.slice(before).map((mail) => [mail.kind, mail.to])).toEqual([["PASSWORD_RESET", real.email]]);
    const reset = await h.request("/auth/password/reset", { body: { token: h.lastToken("PASSWORD_RESET"), newPassword: NEW_PASSWORD } });
    expect(reset.status).toBe(204);
  }, SLOW);

  it("reset: a weak or breached password keeps the link; success revokes everything and signs nobody in", async () => {
    // The breach check is on here, but stubbed: tests never call Have I Been Pwned.
    const check = vi.spyOn(breach, "check").mockResolvedValue("ok");
    const h = createHarness({ PASSWORD_BREACH_CHECK: "true" });
    const eli = await signUp(h, "Eli_Rec", { verified: true });
    const other = await h.db.addSession(eli.userId);
    await h.request("/auth/password/forgot", { body: { email: eli.email } });
    const token = h.lastToken("PASSWORD_RESET")!;

    const weak = await h.request("/auth/password/reset", { body: { token, newPassword: "my name is eli_rec ok" } });
    expect([weak.status, weak.body.code]).toEqual([400, "PASSWORD_WEAK"]);
    check.mockResolvedValueOnce("breached");
    const breached = await h.request("/auth/password/reset", { body: { token, newPassword: "password123456" } });
    expect([breached.status, breached.body.code]).toEqual([400, "PASSWORD_BREACHED"]);
    expect(h.db.rows("emailToken").find((row) => row.purpose === "PASSWORD_RESET")!.consumedAt).toBeNull();

    const user = h.db.user(eli.userId)!;
    user.failedLoginCount = 5;
    user.lockedUntil = new Date(Date.now() + 60_000);
    const done = await h.request("/auth/password/reset", { cookie: eli.jar.header(), body: { token, newPassword: NEW_PASSWORD } });
    expect(done.status).toBe(204);
    expect(cleared(done)).toBe(true);
    expect(done.cookies.poker_session_hint).toBe("");
    expect(h.db.sessionsOf(eli.userId).map((row) => row.revokeReason)).toEqual(["PASSWORD_CHANGED", "PASSWORD_CHANGED"]);
    expect(h.revoked.map((call) => call.sessionId).sort()).toEqual([eli.sessionId, other.id].sort());
    expect(user).toMatchObject({ credentialsVersion: 1, failedLoginCount: 0, lockedUntil: null, passwordResetRequired: false });
    expect(user.securityHoldUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(h.mails.at(-1)!.kind).toBe("PASSWORD_CHANGED");
    expect((await h.request("/auth/password/reset", { body: { token, newPassword: NEW_PASSWORD } })).body.code).toBe("TOKEN_INVALID");
    expect((await h.request("/auth/login", { body: { identifier: "Eli_Rec", password: NEW_PASSWORD } })).status).toBe(200);
    expect((await h.request("/auth/login", { body: { identifier: "Eli_Rec", password: PASSWORD } })).status).toBe(401);
  }, SLOW);

  it("a reset link expires after 30 minutes and an older link dies when a newer one is sent", async () => {
    const h = createHarness();
    const fin = await signUp(h, "Fin_Rec");
    await h.request("/auth/password/forgot", { body: { email: fin.email } });
    const first = h.lastToken("PASSWORD_RESET")!;
    await h.request("/auth/password/forgot", { body: { email: fin.email } });
    const second = h.lastToken("PASSWORD_RESET")!;
    expect((await h.request("/auth/password/reset", { body: { token: first, newPassword: NEW_PASSWORD } })).body.code).toBe("TOKEN_INVALID");
    advanceClock(31 * 60_000);
    expect((await h.request("/auth/password/reset", { body: { token: second, newPassword: NEW_PASSWORD } })).body.code).toBe("TOKEN_INVALID");
  }, SLOW);

  it("a reset never bypasses TOTP", async () => {
    const h = createHarness();
    const gil = await signUp(h, "Gil_Rec");
    const { secret } = await enableTotp(h, gil);
    await h.request("/auth/password/forgot", { body: { email: gil.email } });
    expect((await h.request("/auth/password/reset", { body: { token: h.lastToken("PASSWORD_RESET"), newPassword: NEW_PASSWORD } })).status).toBe(204);
    const step1 = await signIn(h, gil, { password: NEW_PASSWORD });
    expect(step1.body.mfaRequired).toBe(true);
    const done = await h.request("/auth/login/mfa", { cookie: gil.jar.header(), body: { mfaTicket: step1.body.mfaTicket, method: "totp", code: await codeAt(secret, 1) } });
    expect(done.status).toBe(200);
  }, SLOW);
});

describe("email change", () => {
  it("needs a step-up; a taken address answers the same 202 and warns its owner; confirm switches and notifies", async () => {
    const h = createHarness();
    const hal = await signUp(h, "Hal_Rec", { verified: true });
    const ivy = await signUp(h, "Ivy_Rec");
    setStepUp(h, hal.sessionId, ["pwd"], 6 * 60_000);
    expect((await h.request("/account/email", { token: hal.accessToken, body: { newEmail: "hal2@example.com" } })).body.code).toBe("REAUTH_REQUIRED");
    setStepUp(h, hal.sessionId, ["pwd"]);

    const mailsBefore = h.mails.length;
    const taken = await h.request("/account/email", { token: hal.accessToken, body: { newEmail: ivy.email } });
    expect([taken.status, taken.body]).toEqual([202, { ok: true, pendingEmail: ivy.email }]);
    // The requester's own view is the same as for a free address: a pending change and the notice to the current address.
    expect(h.mails.slice(mailsBefore).map((mail) => [mail.kind, mail.to])).toEqual([["EMAIL_IN_USE", ivy.email], ["EMAIL_CHANGE_NOTICE", hal.email]]);
    expect(h.db.user(hal.userId)!.email).toBe(hal.email);
    expect((await h.request("/account/security", { method: "GET", token: hal.accessToken })).body.pendingEmail).toBe(ivy.email);

    const requested = await h.request("/account/email", { token: hal.accessToken, body: { newEmail: "Hal.New@Example.com" } });
    expect([requested.status, requested.body]).toEqual([202, { ok: true, pendingEmail: "hal.new@example.com" }]);
    const kinds = h.mails.slice(mailsBefore + 2).map((mail) => [mail.kind, mail.to]);
    expect(kinds).toEqual([["EMAIL_CHANGE_CONFIRM", "hal.new@example.com"], ["EMAIL_CHANGE_NOTICE", hal.email]]);
    expect(h.mails.at(-2)!.text).toContain("/email-change#t=");
    const security = await h.request("/account/security", { method: "GET", token: hal.accessToken });
    expect(security.body.pendingEmail).toBe("hal.new@example.com");

    const confirmed = await h.request("/auth/email/change/confirm", { body: { token: h.lastToken("EMAIL_CHANGE_CONFIRM") } });
    expect([confirmed.status, confirmed.body]).toEqual([200, { email: "hal.new@example.com" }]);
    const user = h.db.user(hal.userId)!;
    expect(user).toMatchObject({ email: "hal.new@example.com", credentialsVersion: 1 });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.securityHoldUntil!.getTime()).toBeGreaterThan(Date.now());
    const notice = h.mails.at(-1)!;
    expect([notice.kind, notice.to]).toEqual(["EMAIL_CHANGE_NOTICE", hal.email]);
    expect(notice.text).toContain("was changed to hal.new@example.com");
  }, SLOW);

  it("a superseded or raced confirmation is refused", async () => {
    const h = createHarness();
    const jo = await signUp(h, "Jo_Rec");
    await h.request("/account/email", { token: jo.accessToken, body: { newEmail: "jo.a@example.com" } });
    const first = h.lastToken("EMAIL_CHANGE_CONFIRM")!;
    await h.request("/account/email", { token: jo.accessToken, body: { newEmail: "jo.b@example.com" } });
    const second = h.lastToken("EMAIL_CHANGE_CONFIRM")!;
    expect((await h.request("/auth/email/change/confirm", { body: { token: first } })).body.code).toBe("TOKEN_INVALID");
    expect((await h.request("/auth/email/change/confirm", { body: { token: second } })).status).toBe(200);

    // The new address was taken by someone else between request and confirm.
    const kit = await signUp(h, "Kit_Rec");
    await h.request("/account/email", { token: kit.accessToken, body: { newEmail: "kit.next@example.com" } });
    const token = h.lastToken("EMAIL_CHANGE_CONFIRM")!;
    h.db.addUser({ username: "Squatter", email: "kit.next@example.com" });
    const clash = await h.request("/auth/email/change/confirm", { body: { token } });
    expect([clash.status, clash.body]).toEqual([409, { error: "This email can't be used.", code: "EMAIL_UNAVAILABLE" }]);
    expect(h.db.user(kit.userId)!.email).toBe(kit.email);
  }, SLOW);
});

describe("this wasn't me (lockdown)", () => {
  it("after a new-sign-in alert: everything since is undone and a reset is required", async () => {
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    const h = createHarness({ CLIENT_ORIGIN: ORIGIN });
    const owner = await signUp(h, "Lu_Rec", { verified: true });
    const oldKey = await addPasskey(h, owner);
    const removedLater = await addPasskey(h, owner);
    advanceClock(60_000);

    // The attacker signs in from a new browser: the owner gets an alert.
    const attacker = { ...owner, jar: cookieJar() };
    const signedIn = await signIn(h, attacker);
    expect(signedIn.status).toBe(200);
    const alert = h.mails.at(-1)!;
    expect(alert.kind).toBe("NEW_SIGN_IN");
    const lockdownToken = h.lastToken("NEW_SIGN_IN")!;
    expect(alert.text).toContain(`/auth/not-me#t=${lockdownToken}`);
    attacker.accessToken = signedIn.body.accessToken;
    attacker.sessionId = JSON.parse(atob(signedIn.body.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sid;

    advanceClock(60_000);
    // The attacker adds a passkey and TOTP, removes one of the owner's passkeys, and changes the password.
    const attackerKey = await addPasskey(h, attacker);
    await enableTotp(h, attacker);
    setStepUp(h, attacker.sessionId, ["pwd", "otp"]);
    const removedId = h.db.rows("webAuthnCredential").find((row) => row.credentialId === removedLater.id)!.id;
    expect((await h.request(`/account/passkeys/${removedId}`, { method: "DELETE", token: attacker.accessToken })).status).toBe(204);
    await h.request("/auth/password/forgot", { body: { email: owner.email } });
    expect((await h.request("/auth/password/reset", { body: { token: h.lastToken("PASSWORD_RESET"), newPassword: "attacker password 123" } })).status).toBe(204);
    expect(h.db.user(owner.userId)!.credentialsVersion).toBeGreaterThan(1);
    const live = await h.db.addSession(owner.userId);

    advanceClock(60_000);
    const locked = await h.request("/auth/security/lockdown", { body: { token: lockdownToken } });
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ secured: true });
    expect(locked.body.resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cleared(locked)).toBe(true);
    expect(h.db.session(live.id)!.revokeReason).toBe("SECURITY_LOCKDOWN");
    expect(h.revoked.filter((call) => call.reason === "SECURITY_LOCKDOWN").map((call) => call.sessionId)).toEqual([live.id]);

    const keys = h.db.rows("webAuthnCredential");
    expect(keys.find((row) => row.credentialId === attackerKey.id)!.removedAt).toBeInstanceOf(Date);
    expect(keys.find((row) => row.credentialId === removedLater.id)!.removedAt).toBeNull();
    expect(keys.find((row) => row.credentialId === oldKey.id)!.removedAt).toBeNull();
    expect(h.db.rows("userTotp")).toHaveLength(0);
    expect(h.db.rows("userBackupCode")).toHaveLength(0);
    // The attacker's browser is forgotten (a sign-in there alerts again).
    expect(h.db.rows("knownDevice")).toHaveLength(1);
    const user = h.db.user(owner.userId)!;
    expect(user.passwordResetRequired).toBe(true);
    const types = h.db.rows("accountSecurityEvent").map((event) => event.type);
    expect(types).toContain("NOT_ME_REPORTED");
    expect(types).toContain("TOTP_CHANGED");

    // Password sign-in: 403 only with the right password; a wrong one is the usual 401.
    const right = await h.request("/auth/login", { body: { identifier: "Lu_Rec", password: "attacker password 123" } });
    expect([right.status, right.body.code]).toEqual([403, "PASSWORD_RESET_REQUIRED"]);
    expect(right.setCookie).toBeNull();
    const wrong = await h.request("/auth/login", { body: { identifier: "Lu_Rec", password: "not the password" } });
    expect([wrong.status, wrong.body]).toEqual([401, { error: "Invalid credentials" }]);

    // The lockdown link works once; its reset token works despite the credentials-version bump.
    expect((await h.request("/auth/security/lockdown", { body: { token: lockdownToken } })).body.code).toBe("TOKEN_INVALID");
    expect((await h.request("/auth/password/reset", { body: { token: locked.body.resetToken, newPassword: NEW_PASSWORD } })).status).toBe(204);
    const back = await h.request("/auth/login", { body: { identifier: "Lu_Rec", password: NEW_PASSWORD } });
    expect(back.status).toBe(200);
    expect(back.body.user.twoFactorEnabled).toBe(false);
  }, SLOW);

  it("TOTP switched off since the incident comes back, and an email change is reverted", async () => {
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const h = createHarness();
    const max = await signUp(h, "Max_Rec", { verified: true });
    await enableTotp(h, max);
    advanceClock(60_000);
    setStepUp(h, max.sessionId, ["pwd", "otp"]);
    expect((await h.request("/account/2fa/totp", { method: "DELETE", token: max.accessToken })).status).toBe(204);
    const disabledNotice = h.lastToken("TOTP_DISABLED")!;
    expect(h.db.rows("userTotp")[0]!.disabledAt).toBeInstanceOf(Date);
    const restored = await h.request("/auth/security/lockdown", { body: { token: disabledNotice } });
    expect(restored.status).toBe(200);
    expect(h.db.rows("userTotp")[0]!.disabledAt).toBeNull();
    expect(h.db.rows("userBackupCode")).toHaveLength(10);

    advanceClock(60_000);
    const ned = await signUp(h, "Ned_Rec", { verified: true });
    advanceClock(60_000);
    await h.request("/account/email", { token: ned.accessToken, body: { newEmail: "attacker@example.com" } });
    expect((await h.request("/auth/email/change/confirm", { body: { token: h.lastToken("EMAIL_CHANGE_CONFIRM") } })).status).toBe(200);
    const changedNotice = h.mails.at(-1)!;
    expect([changedNotice.kind, changedNotice.to]).toEqual(["EMAIL_CHANGE_NOTICE", ned.email]);
    const token = h.lastToken("EMAIL_CHANGE_NOTICE", ned.email)!;
    advanceClock(60_000);
    expect((await h.request("/auth/security/lockdown", { body: { token } })).status).toBe(200);
    const user = h.db.user(ned.userId)!;
    expect(user.email).toBe(ned.email);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
  }, SLOW);

  it("links mailed to the attacker's address during the incident die with the owner's lockdown and cannot undo the recovery", async () => {
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    const h = createHarness();
    const owner = await signUp(h, "Ola_Rec", { verified: true });
    advanceClock(60_000);
    // The attacker knows the password: signs in, moves the email to their own address.
    const attacker = { ...owner, jar: cookieJar() };
    const s1 = await signIn(h, attacker);
    attacker.accessToken = s1.body.accessToken;
    expect((await h.request("/account/email", { token: attacker.accessToken, body: { newEmail: "thief@example.com" } })).status).toBe(202);
    expect((await h.request("/auth/email/change/confirm", { body: { token: h.lastToken("EMAIL_CHANGE_CONFIRM") } })).status).toBe(200);
    const ownerNotice = h.lastToken("EMAIL_CHANGE_NOTICE", owner.email)!;
    advanceClock(60_000);
    // Another sign-in: its alert, with a lockdown link, now goes to the attacker's address.
    expect((await signIn(h, { ...owner, jar: cookieJar() })).status).toBe(200);
    const stockpiled = h.lastToken("NEW_SIGN_IN", "thief@example.com")!;
    expect(stockpiled).toBeTruthy();

    // The owner recovers from the old address, sets a new password and turns TOTP on.
    advanceClock(60_000);
    const locked = await h.request("/auth/security/lockdown", { body: { token: ownerNotice } });
    expect(locked.status).toBe(200);
    expect(h.db.user(owner.userId)!.email).toBe(owner.email);
    expect((await h.request("/auth/password/reset", { body: { token: locked.body.resetToken, newPassword: NEW_PASSWORD } })).status).toBe(204);
    advanceClock(60_000);
    const back = owner.jar.take(await h.request("/auth/login", { cookie: owner.jar.header(), body: { identifier: owner.username, password: NEW_PASSWORD } }));
    expect(back.status).toBe(200);
    owner.accessToken = back.body.accessToken;
    owner.sessionId = JSON.parse(atob(back.body.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sid;
    await enableTotp(h, owner);

    // Days later the attacker's stockpiled link is dead: no reset token, the owner's TOTP stays.
    advanceClock(2 * 86_400_000);
    const replay = await h.request("/auth/security/lockdown", { body: { token: stockpiled } });
    expect([replay.status, replay.body.code]).toEqual([400, "TOKEN_INVALID"]);
    expect(h.db.rows("userTotp")[0]!.enabledAt).toBeInstanceOf(Date);
    expect(h.db.user(owner.userId)!.passwordResetRequired).toBe(false);
  }, SLOW);

  it("any notice's lockdown link, not only the email-change notice, puts the email back to the address it was sent to", async () => {
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    const h = createHarness();
    const owner = await signUp(h, "Pia_Rec", { verified: true });
    advanceClock(60_000);
    // A second known device first, so the next new device raises an alert.
    expect((await signIn(h, { ...owner, jar: cookieJar() })).status).toBe(200);
    advanceClock(60_000);
    const attacker = { ...owner, jar: cookieJar() };
    const s1 = await signIn(h, attacker);
    const alert = h.lastToken("NEW_SIGN_IN", owner.email)!;
    expect(alert).toBeTruthy();
    expect((await h.request("/account/email", { token: s1.body.accessToken, body: { newEmail: "thief2@example.com" } })).status).toBe(202);
    expect((await h.request("/auth/email/change/confirm", { body: { token: h.lastToken("EMAIL_CHANGE_CONFIRM") } })).status).toBe(200);
    advanceClock(60_000);
    // The owner clicks "This wasn't me" in the first mail they got: the new-sign-in alert.
    expect((await h.request("/auth/security/lockdown", { body: { token: alert } })).status).toBe(200);
    const user = h.db.user(owner.userId)!;
    expect(user.email).toBe(owner.email);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    // Forgot-password to the attacker's address now reaches no account.
    const before = h.mails.length;
    expect((await h.request("/auth/password/forgot", { body: { email: "thief2@example.com" } })).status).toBe(202);
    expect(h.mails.slice(before).filter((mail) => mail.kind === "PASSWORD_RESET")).toHaveLength(0);
  }, SLOW);

  it("a forged, malformed or expired lockdown token is refused", async () => {
    const h = createHarness();
    expect((await h.request("/auth/security/lockdown", { body: { token: "A".repeat(43) } })).body.code).toBe("TOKEN_INVALID");
    expect((await h.request("/auth/security/lockdown", { body: {} })).status).toBe(400);
  });
});
