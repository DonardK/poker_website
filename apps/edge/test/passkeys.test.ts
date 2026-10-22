/**
 * Passkeys end to end with a software authenticator, through
 * @simplewebauthn/server inside workerd. This suite is also the
 * compatibility gate for the library on Workers (design-auth §2a).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, cookieJar, type Harness } from "./harness";
import { type Account, enableTotp, setStepUp, signUp } from "./support/accounts";
import { SoftAuthenticator } from "./support/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const SLOW = 90_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function passkeyHarness(): Harness {
  return createHarness({ CLIENT_ORIGIN: ORIGIN });
}

async function registrationOptions(h: Harness, account: Account) {
  const response = await h.request("/account/passkeys/options", { token: account.accessToken, body: {} });
  if (response.status !== 200) throw new Error(`options: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body as { options: { challenge: string; user: { id: string }; rp: { id: string } }; challengeToken: string };
}

async function addPasskey(h: Harness, account: Account, auth = new SoftAuthenticator("localhost", ORIGIN), name?: string) {
  const { options, challengeToken } = await registrationOptions(h, account);
  const credential = await auth.create(options);
  const response = await h.request("/account/passkeys", { token: account.accessToken, body: { challengeToken, credential, ...(name ? { name } : {}) } });
  return { auth, response };
}

async function passkeySignIn(h: Harness, auth: SoftAuthenticator, overrides: Parameters<SoftAuthenticator["get"]>[1] = {}, jar = cookieJar()) {
  const options = await h.request("/auth/passkey/options", { body: {} });
  expect(options.status).toBe(200);
  const credential = await auth.get(options.body.options, overrides);
  return jar.take(await h.request("/auth/passkey/login", { cookie: jar.header(), body: { challengeToken: options.body.challengeToken, credential } }));
}

describe("passkeys", () => {
  it("registration needs a step-up, stores the credential and lists it", async () => {
    const h = passkeyHarness();
    const ana = await signUp(h, "Ana_Key", { verified: true });
    setStepUp(h, ana.sessionId, ["pwd"], 6 * 60_000);
    const stale = await h.request("/account/passkeys/options", { token: ana.accessToken, body: {} });
    expect([stale.status, stale.body.code]).toEqual([403, "REAUTH_REQUIRED"]);
    setStepUp(h, ana.sessionId, ["pwd"]);

    const { options } = await registrationOptions(h, ana);
    expect(options.rp.id).toBe("localhost");
    expect(options).toMatchObject({ attestation: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    expect((options as unknown as { pubKeyCredParams: { alg: number }[] }).pubKeyCredParams.map((param) => param.alg)).toEqual([-7, -257]);
    // The WebAuthn user handle is random, never the account id.
    expect(h.db.user(ana.userId)!.webauthnUserId).toBe(options.user.id);
    expect(options.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { auth, response } = await addPasskey(h, ana, undefined, "My laptop");
    expect(response.status).toBe(201);
    expect(response.body.passkey).toMatchObject({ name: "My laptop", backedUp: true, deviceType: "multiDevice", transports: ["internal", "hybrid"], lastUsedAt: null });
    const row = h.db.rows("webAuthnCredential")[0]!;
    expect(row).toMatchObject({ userId: ana.userId, credentialId: auth.id, rpId: "localhost", counter: 0, removedAt: null });
    expect(row.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h.mails.map((mail) => mail.kind)).toContain("PASSKEY_ADDED");
    expect(h.db.rows("accountSecurityEvent").map((event) => event.type)).toContain("PASSKEY_ADDED");

    const list = await h.request("/account/passkeys", { method: "GET", token: ana.accessToken });
    expect(list.body.passkeys).toHaveLength(1);
    expect(Object.keys(list.body.passkeys[0]).sort()).toEqual(["backedUp", "createdAt", "deviceType", "id", "lastUsedAt", "name", "transports"]);

    const renamed = await h.request(`/account/passkeys/${row.id}/rename`, { token: ana.accessToken, body: { name: "Work phone" } });
    expect([renamed.status, renamed.body.passkey.name]).toEqual([200, "Work phone"]);
    const me = await h.request("/auth/me", { method: "GET", token: ana.accessToken });
    expect(me.body.user.passkeyCount).toBe(1);
  }, SLOW);

  it("refuses a wrong origin, a wrong RP ID, no user verification, and another session's challenge", async () => {
    const h = passkeyHarness();
    const ben = await signUp(h, "Ben_Key");
    const auth = new SoftAuthenticator("localhost", ORIGIN);
    const attempt = async (overrides: Parameters<SoftAuthenticator["create"]>[1]) => {
      const { options, challengeToken } = await registrationOptions(h, ben);
      const credential = await auth.create(options, overrides);
      return h.request("/account/passkeys", { token: ben.accessToken, body: { challengeToken, credential } });
    };
    for (const [label, overrides] of [
      ["origin", { origin: "https://evil.example" }],
      ["rpId", { rpId: "evil.example" }],
      ["uv", { uv: false }],
      ["type", { type: "webauthn.get" as const }],
      ["crossOrigin", { clientData: { crossOrigin: true } }],
      ["topOrigin", { clientData: { topOrigin: "https://evil.example" } }],
    ] as const) {
      const response = await attempt(overrides);
      expect([response.status, response.body], label).toEqual([400, { error: "Passkey not recognised", code: "PASSKEY_INVALID" }]);
    }
    expect(h.db.rows("webAuthnCredential")).toHaveLength(0);

    // A challenge issued to another user's session.
    const cleo = await signUp(h, "Cleo_Key");
    const theirs = await registrationOptions(h, cleo);
    const credential = await auth.create(theirs.options);
    const stolen = await h.request("/account/passkeys", { token: ben.accessToken, body: { challengeToken: theirs.challengeToken, credential } });
    expect([stolen.status, stolen.body.code]).toEqual([400, "CHALLENGE_INVALID"]);
  }, SLOW);

  it("a registration challenge works once", async () => {
    const h = passkeyHarness();
    const dee = await signUp(h, "Dee_Key");
    const { options, challengeToken } = await registrationOptions(h, dee);
    const first = await h.request("/account/passkeys", { token: dee.accessToken, body: { challengeToken, credential: await new SoftAuthenticator("localhost", ORIGIN).create(options) } });
    expect(first.status).toBe(201);
    const second = await h.request("/account/passkeys", { token: dee.accessToken, body: { challengeToken, credential: await new SoftAuthenticator("localhost", ORIGIN).create(options) } });
    expect([second.status, second.body.code]).toEqual([400, "CHALLENGE_INVALID"]);
    expect(h.db.rows("webAuthnCredential")).toHaveLength(1);
  }, SLOW);

  it("discoverable sign-in issues a passkey session, also for a TOTP account, and counts the signature", async () => {
    const h = passkeyHarness();
    const eve = await signUp(h, "Eve_Key");
    await enableTotp(h, eve);
    const { auth } = await addPasskey(h, eve);
    const nonces = h.db.rows("authNonce").length;
    const options = await h.request("/auth/passkey/options", { body: {} });
    expect(options.body.options).toMatchObject({ rpId: "localhost", userVerification: "required", allowCredentials: [] });
    // An options request writes nothing (single use is marked only after a verified assertion).
    expect(h.db.rows("authNonce")).toHaveLength(nonces);

    const signedIn = await passkeySignIn(h, auth);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user).toMatchObject({ username: "Eve_Key", twoFactorEnabled: true, passkeyCount: 1 });
    expect(signedIn.cookies.poker_refresh).toBeTruthy();
    const sid = JSON.parse(atob(signedIn.body.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sid as string;
    expect(h.db.session(sid)!.authMethods).toEqual(["passkey"]);
    const row = h.db.rows("webAuthnCredential")[0]!;
    expect(row.counter).toBe(1);
    expect(row.lastUsedAt).toBeInstanceOf(Date);

    // The same assertion's challenge cannot be replayed.
    const replayOptions = await h.request("/auth/passkey/options", { body: {} });
    const credential = await auth.get(replayOptions.body.options);
    const once = await h.request("/auth/passkey/login", { body: { challengeToken: replayOptions.body.challengeToken, credential } });
    expect(once.status).toBe(200);
    const twice = await h.request("/auth/passkey/login", { body: { challengeToken: replayOptions.body.challengeToken, credential: await auth.get(replayOptions.body.options) } });
    expect([twice.status, twice.body.code]).toEqual([400, "CHALLENGE_INVALID"]);
  }, SLOW);

  it("unknown, removed, bot, guest and user-handle mismatches all get the same 401", async () => {
    const h = passkeyHarness();
    const fay = await signUp(h, "Fay_Key");
    const { auth } = await addPasskey(h, fay);
    const expected = [401, { error: "Passkey not recognised", code: "PASSKEY_INVALID" }];
    expect([(await passkeySignIn(h, new SoftAuthenticator("localhost", ORIGIN))).status, (await passkeySignIn(h, new SoftAuthenticator("localhost", ORIGIN))).body])
      .toEqual(expected);
    const mismatch = await passkeySignIn(h, auth, { userHandle: "A".repeat(43) });
    expect([mismatch.status, mismatch.body]).toEqual(expected);
    const user = h.db.user(fay.userId)!;
    user.kind = "BOT";
    const bot = await passkeySignIn(h, auth);
    expect([bot.status, bot.body]).toEqual(expected);
    user.kind = "HUMAN";
    user.isGuest = true;
    const guest = await passkeySignIn(h, auth);
    expect([guest.status, guest.body]).toEqual(expected);
    user.isGuest = false;
    h.db.rows("webAuthnCredential")[0]!.removedAt = new Date();
    const removed = await passkeySignIn(h, auth);
    expect([removed.status, removed.body]).toEqual(expected);
    h.db.rows("webAuthnCredential")[0]!.removedAt = null;
    expect((await passkeySignIn(h, auth)).status).toBe(200);
  }, SLOW);

  it("a counter regression is refused and logged; success stores the new counter", async () => {
    const h = passkeyHarness();
    const gus = await signUp(h, "Gus_Key");
    const { auth } = await addPasskey(h, gus);
    expect((await passkeySignIn(h, auth, { counter: 10 })).status).toBe(200);
    expect(h.db.rows("webAuthnCredential")[0]!.counter).toBe(10);
    const warn = vi.spyOn(console, "warn");
    const cloned = await passkeySignIn(h, auth, { counter: 7 });
    expect([cloned.status, cloned.body.code]).toEqual([401, "PASSKEY_INVALID"]);
    expect(warn.mock.calls.some(([line]) => String(line).includes("PASSKEY_COUNTER_REGRESSION"))).toBe(true);
    expect(h.db.rows("webAuthnCredential")[0]!.counter).toBe(10);
  }, SLOW);

  it("a required password reset (after a lockdown) does not block passkey sign-in", async () => {
    const h = passkeyHarness();
    const hal = await signUp(h, "Hal_Key");
    const { auth } = await addPasskey(h, hal);
    h.db.user(hal.userId)!.passwordResetRequired = true;
    expect((await passkeySignIn(h, auth)).status).toBe(200);
  }, SLOW);

  it("removal needs a step-up; a removed passkey no longer signs in and can be added again; another account's is 409", async () => {
    const h = passkeyHarness();
    const ida = await signUp(h, "Ida_Key", { verified: true });
    const { auth } = await addPasskey(h, ida);
    const id = h.db.rows("webAuthnCredential")[0]!.id;
    setStepUp(h, ida.sessionId, ["pwd"], 6 * 60_000);
    const stale = await h.request(`/account/passkeys/${id}`, { method: "DELETE", token: ida.accessToken });
    expect([stale.status, stale.body.code]).toEqual([403, "REAUTH_REQUIRED"]);
    expect(stale.body.methods).toEqual(["password", "passkey"]);
    setStepUp(h, ida.sessionId, ["pwd"]);
    expect((await h.request(`/account/passkeys/${id}`, { method: "DELETE", token: ida.accessToken })).status).toBe(204);
    expect(h.db.rows("webAuthnCredential")[0]!.removedAt).toBeInstanceOf(Date);
    expect(h.mails.map((mail) => mail.kind)).toContain("PASSKEY_REMOVED");
    expect((await h.request(`/account/passkeys/${id}`, { method: "DELETE", token: ida.accessToken })).status).toBe(404);
    expect((await passkeySignIn(h, auth)).status).toBe(401);

    // excludeCredentials still lists the removed one (the browser warns), and adding it again works.
    const { options } = await registrationOptions(h, ida);
    expect((options as unknown as { excludeCredentials: { id: string }[] }).excludeCredentials.map((entry) => entry.id)).toEqual([auth.id]);
    const again = await addPasskey(h, ida, auth);
    expect(again.response.status).toBe(201);
    expect(h.db.rows("webAuthnCredential")).toHaveLength(1);
    expect((await passkeySignIn(h, auth)).status).toBe(200);

    // The same authenticator on another account.
    const jon = await signUp(h, "Jon_Key");
    const taken = await addPasskey(h, jon, auth);
    expect([taken.response.status, taken.response.body.code]).toEqual([409, "PASSKEY_ALREADY_REGISTERED"]);
    // And someone else's passkey id is 404 for rename and removal.
    expect((await h.request(`/account/passkeys/${h.db.rows("webAuthnCredential")[0]!.id}/rename`, { token: jon.accessToken, body: { name: "Mine" } })).status).toBe(404);
  }, SLOW);

  it("passkeys are off on an IP-address origin: config says so and options are 503", async () => {
    const h = createHarness({ CLIENT_ORIGIN: "http://127.0.0.1:3000" });
    const config = await h.request("/auth/config", { method: "GET" });
    expect(config.body).toMatchObject({ passkeysEnabled: false, totpEnabled: true });
    expect([(await h.request("/auth/passkey/options", { body: {} })).status]).toEqual([503]);
    const kai = await signUp(h, "Kai_Key");
    const options = await h.request("/account/passkeys/options", { token: kai.accessToken, body: {} });
    expect([options.status, options.body.code]).toEqual([503, "PASSKEYS_UNAVAILABLE"]);
  }, SLOW);

  it("an account holds at most 20 passkeys", async () => {
    const h = passkeyHarness();
    const lou = await signUp(h, "Lou_Key");
    for (let i = 0; i < 20; i++) {
      h.db.insert("webAuthnCredential", { userId: lou.userId, credentialId: `cred${String(i).padStart(14, "0")}`, publicKey: "A".repeat(77), deviceType: "singleDevice", rpId: "localhost", name: `Key ${i}` });
    }
    const response = await h.request("/account/passkeys/options", { token: lou.accessToken, body: {} });
    expect([response.status, response.body.code]).toEqual([409, "PASSKEY_LIMIT"]);
  }, SLOW);

  it("a passkey step-up opens the window with reauthMethods [passkey]", async () => {
    const h = passkeyHarness();
    const max = await signUp(h, "Max_Key");
    const { auth } = await addPasskey(h, max);
    setStepUp(h, max.sessionId, ["pwd"], 10 * 60_000);
    const options = await h.request("/auth/reauth/passkey/options", { token: max.accessToken, body: {} });
    expect(options.status).toBe(200);
    expect((options.body.options.allowCredentials as { id: string }[]).map((entry) => entry.id)).toEqual([auth.id]);
    const credential = await auth.get(options.body.options);
    const done = await h.request("/auth/reauth/passkey", { token: max.accessToken, body: { challengeToken: options.body.challengeToken, credential } });
    expect(done.status).toBe(200);
    expect(Date.parse(done.body.reauthenticatedUntil)).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(h.db.session(max.sessionId)!.reauthMethods).toEqual(["passkey"]);

    // A challenge for another session is refused; an account without passkeys gets 409.
    const nia = await signUp(h, "Nia_Key");
    const foreign = await h.request("/auth/reauth/passkey", { token: nia.accessToken, body: { challengeToken: options.body.challengeToken, credential } });
    expect([foreign.status, foreign.body.code]).toEqual([400, "CHALLENGE_INVALID"]);
    const none = await h.request("/auth/reauth/passkey/options", { token: nia.accessToken, body: {} });
    expect([none.status, none.body.code]).toEqual([409, "NO_PASSKEYS"]);
  }, SLOW);
});
