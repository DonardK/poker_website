/**
 * readEdgeConfig: the optional account-security settings (all optional; a
 * feature whose settings are absent, partial or unusable is off and its
 * routes answer 503, while sign-in, refresh and play keep working), the
 * production checks on an https origin, and the deployed vars.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { authRingFromConfig, ringFromConfig } from "../src/game/crypto";
import { readEdgeConfig, readEdgeConfigReport, type Env } from "../src/env";
import { createHarness, PASSWORD, randomTestHex } from "./harness";
import { setStepUp, signUp } from "./support/accounts";
import { workerEnv } from "./worker-bindings";

// Fresh random values for this run: nothing here is a secret anyone could copy.
const AUTH_KEY = randomTestHex();
const GAME_KEY = randomTestHex();
const JWT = { JWT_ACCESS_SECRET: randomTestHex(), JWT_REFRESH_SECRET: randomTestHex(), WS_TICKET_SECRET: randomTestHex() };
const SECURITY = {
  AUTH_HMAC_SECRET: randomTestHex(),
  AUTH_ENCRYPTION_KEYS: `a1:${AUTH_KEY}`,
  AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a1",
};
const HTTPS = { CLIENT_ORIGIN: "https://poker-web.example.workers.dev" };
/** Keys that were committed to this repository's test configuration (now refused as published). */
const COMMITTED_GAME_KEY = "c549a47e88271398c0804736a4fcbaa0273d3b09c944b7ee5bea23f3ad51b784";
const COMMITTED_AUTH_KEY = "5f2c8e1a9b7d4c3e6f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The vars and secrets every config needs (no account-security values). */
function base(extra: Record<string, string | undefined> = {}): Env {
  return {
    CLIENT_ORIGIN: "http://127.0.0.1:3000",
    TERMS_VERSION: "2026-10-19",
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "7d",
    SESSION_IDLE_TTL: "14d",
    SESSION_ABSOLUTE_TTL: "30d",
    DEFAULT_STARTING_BANKROLL: "10000",
    TURN_TIME_BANK_MS: "20000",
    ENABLE_LEGACY_BOTS: "false",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TABLE_DO_LOCATION_HINT: "weur",
    ...JWT,
    GAME_ENCRYPTION_KEYS: `k1:${GAME_KEY}`,
    GAME_ENCRYPTION_ACTIVE_KEY_ID: "k1",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    ...extra,
  } as unknown as Env;
}

/** Every reported problem, as one string (for matching), and a check that no key or secret value leaked into it. */
function reported(problems: { ignored: string[]; weak: string[] }): string {
  const text = [...problems.ignored, ...problems.weak].join("\n");
  for (const value of [AUTH_KEY, GAME_KEY, SECURITY.AUTH_HMAC_SECRET, ...Object.values(JWT), COMMITTED_AUTH_KEY, COMMITTED_GAME_KEY]) {
    expect(text).not.toContain(value);
  }
  return text;
}

describe("edge config: account security", () => {
  it("leaves every account-security feature off, without failing, when nothing is set", () => {
    const { config, problems } = readEdgeConfigReport(base({ AUTH_HMAC_SECRET: "", RESEND_API_KEY: " " }));
    expect(config.security).toBeNull();
    expect(config.webauthn).toBeNull();
    expect(authRingFromConfig(config)).toBeNull();
    expect(config.mail).toEqual({ transport: "sink", exposeLinks: true });
    expect(config.totpIssuer).toBe("Hold'em Live");
    expect(config.passwordBreachCheck).toBe(true);
    expect(config.securityHoldMs).toBe(24 * 3_600_000);
    expect(config.adminRequirePasskey).toBe(false);
    expect(problems).toEqual({ ignored: [], weak: [] });
  });

  it("parses the three secrets together and keeps the auth ring apart from the game ring", () => {
    const config = readEdgeConfig(base({ ...SECURITY, CLIENT_ORIGIN: "http://localhost:3000" }));
    expect(config.security).toEqual({ hmacSecret: SECURITY.AUTH_HMAC_SECRET, authKeys: SECURITY.AUTH_ENCRYPTION_KEYS, authActiveKeyId: "a1" });
    expect(authRingFromConfig(config)?.activeKeyId).toBe("a1");
    expect(ringFromConfig(config).activeKeyId).toBe("k1");
    expect(config.webauthn).toEqual({ rpId: "localhost", rpName: "Hold'em Live", origins: ["http://localhost:3000"] });
  });

  it("a partial, reused or malformed set leaves security off (never a failed request), naming only the variable", () => {
    for (const [name, extra, message] of [
      ["partial", { AUTH_HMAC_SECRET: SECURITY.AUTH_HMAC_SECRET }, /together/],
      ["no hmac", { AUTH_ENCRYPTION_KEYS: SECURITY.AUTH_ENCRYPTION_KEYS, AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a1" }, /together/],
      ["game key reused", { ...SECURITY, AUTH_ENCRYPTION_KEYS: `a1:${GAME_KEY}` }, /also a game encryption key/],
      ["hmac equals jwt", { ...SECURITY, AUTH_HMAC_SECRET: JWT.JWT_ACCESS_SECRET }, /must be distinct/],
      ["hmac equals auth key", { ...SECURITY, AUTH_HMAC_SECRET: AUTH_KEY }, /AUTH_HMAC_SECRET reuses encryption key "a1"/],
      ["hmac equals game key", { ...SECURITY, AUTH_HMAC_SECRET: GAME_KEY }, /AUTH_HMAC_SECRET reuses game encryption key "k1"/],
      ["bad ring", { ...SECURITY, AUTH_ENCRYPTION_KEYS: "a1:abc" }, /AUTH_ENCRYPTION_KEYS: key "a1" must be 64 hex/],
      ["unknown active id", { ...SECURITY, AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a2" }, /AUTH_ENCRYPTION_ACTIVE_KEY_ID "a2" is not in the key ring/],
      ["short hmac", { ...SECURITY, AUTH_HMAC_SECRET: "too-short" }, /AUTH_HMAC_SECRET is invalid/],
      ["low-entropy hmac", { ...SECURITY, AUTH_HMAC_SECRET: "ab".repeat(20) }, /AUTH_HMAC_SECRET is invalid/],
    ] as const) {
      const { config, problems } = readEdgeConfigReport(base(extra));
      expect(config.security, name).toBeNull();
      expect(config.webauthn, name).toBeNull();
      expect(reported(problems), name).toMatch(message);
      expect(problems.ignored.join("\n"), name).toMatch(/TOTP, passkeys, MFA sign-in and money step-up are off/);
    }
  });

  it("readEdgeConfig logs an unusable setting once per isolate, by name, and does not throw", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = base({ AUTH_ENCRYPTION_KEYS: SECURITY.AUTH_ENCRYPTION_KEYS, AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a1" });
    for (let i = 0; i < 3; i++) expect(readEdgeConfig(env).security).toBeNull();
    const lines = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("CONFIG_SETTING_IGNORED") && line.includes("together"));
    expect(lines.length).toBeLessThanOrEqual(1);
    for (const line of lines) expect(line).not.toContain(AUTH_KEY);
  });

  it("on https: published or placeholder auth values turn security off; weak game keys and JWT secrets are reported but accepted", () => {
    // Account-security values that are public protect nothing: the feature stays off.
    for (const [name, extra, message] of [
      ["placeholder auth key", { ...SECURITY, AUTH_ENCRYPTION_KEYS: `a1:${"deadbeef".repeat(8)}` }, /published placeholder/],
      ["committed auth key", { ...SECURITY, AUTH_ENCRYPTION_KEYS: `a1:${COMMITTED_AUTH_KEY}` }, /published placeholder/],
      ["placeholder hmac", { ...SECURITY, AUTH_HMAC_SECRET: "please-replace-this-auth-hmac-secret-now" }, /independent random AUTH_HMAC_SECRET/],
      ["committed hmac", { ...SECURITY, AUTH_HMAC_SECRET: "test-only-auth-hmac-secret-32chars-ok" }, /independent random AUTH_HMAC_SECRET/],
    ] as const) {
      const { config, problems } = readEdgeConfigReport(base({ ...HTTPS, ...extra }));
      expect(config.security, name).toBeNull();
      expect(reported(problems), name).toMatch(message);
    }
    // The secrets play depends on: a published or weak value is reported, never a 500 for every player.
    for (const [name, extra, message] of [
      ["placeholder game key", { GAME_ENCRYPTION_KEYS: `k1:${"0123456789abcdef".repeat(4)}` }, /GAME_ENCRYPTION_KEYS: Encryption key "k1" is a published placeholder/],
      ["committed game key", { GAME_ENCRYPTION_KEYS: `k1:${COMMITTED_GAME_KEY}` }, /published placeholder/],
      ["repetitive hex jwt", { JWT_ACCESS_SECRET: "abcdabcdabcdabcdabcdabcdabcdabcdabcd" }, /at least 8 distinct/],
      ["repetitive jwt", { JWT_ACCESS_SECRET: "test-test-test-test-test-test-test-test" }, /at least 16 distinct/],
      ["malformed game ring", { GAME_ENCRYPTION_KEYS: "k1:abc" }, /GAME_ENCRYPTION_KEYS: key "k1" must be 64 hex/],
    ] as const) {
      const { config, problems } = readEdgeConfigReport(base({ ...HTTPS, ...extra }));
      expect(config.jwtAccessSecret, name).toBeTruthy();
      expect(reported(problems), name).toMatch(message);
      expect(problems.weak.length, name).toBeGreaterThan(0);
    }
    // What main already refused stays fatal, and so do the repository's own published test secrets.
    expect(() => readEdgeConfig(base({ ...HTTPS, JWT_ACCESS_SECRET: "please-change-this-access-secret-now-123" }))).toThrow(/independent random/);
    expect(() => readEdgeConfig(base({ ...HTTPS, JWT_ACCESS_SECRET: "test-only-access-secret-32chars-min" }))).toThrow(/independent random/);
    expect(() => readEdgeConfig(base({ JWT_REFRESH_SECRET: JWT.JWT_ACCESS_SECRET }))).toThrow(/must be distinct/);
    // Local development over http skips the production checks.
    const local = readEdgeConfigReport(base({ GAME_ENCRYPTION_KEYS: `k1:${"0123456789abcdef".repeat(4)}` }));
    expect(local.problems).toEqual({ ignored: [], weak: [] });
    const config = readEdgeConfig(base({ ...HTTPS, ...SECURITY }));
    expect(config.webauthn).toEqual({ rpId: "poker-web.example.workers.dev", rpName: "Hold'em Live", origins: ["https://poker-web.example.workers.dev"] });
    // Random hex secrets (DEPLOY.md: randomBytes(32).toString("hex")) often lack one of the 16 digits; they are fine.
    const hexMissingDigits = { JWT_ACCESS_SECRET: "3a1b2c4d5e6a7b8c9d0e1a2b3c4d5e6a7b8c9d0e1a2b3c4d5e6a7b8c9d0e1a2b", JWT_REFRESH_SECRET: "9c8b7a6d5e4c3b2a1d0e9c8b7a6d5e4c3b2a1d0e9c8b7a6d5e4c3b2a1d0e9c8b" };
    expect(new Set(hexMissingDigits.JWT_ACCESS_SECRET).size).toBeLessThan(16);
    const hex = readEdgeConfigReport(base({ ...HTTPS, ...SECURITY, ...hexMissingDigits, AUTH_HMAC_SECRET: "7e6d5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3a2918f7e6" }));
    expect(hex.config.security).not.toBeNull();
    expect(hex.problems).toEqual({ ignored: [], weak: [] });
    expect(config.mail).toEqual({ transport: "sink", exposeLinks: false });
  });

  it("passkeys: an unusable RP ID or extra origin turns them off (logged), never a failed request", () => {
    expect(readEdgeConfig(base(SECURITY)).webauthn).toBeNull();
    const https = { ...SECURITY, CLIENT_ORIGIN: "https://play.poker.example.com" };
    expect(readEdgeConfig(base({ ...https, WEBAUTHN_RP_ID: "Poker.Example.com" })).webauthn?.rpId).toBe("poker.example.com");
    expect(readEdgeConfig(base({ ...https, WEBAUTHN_RP_ID: "play.poker.example.com", WEBAUTHN_RP_NAME: "Poker" })).webauthn?.rpName).toBe("Poker");
    for (const rpId of ["other.example.com", "ay.poker.example.com", "com", "127.0.0.1", "bad host!"]) {
      const { config, problems } = readEdgeConfigReport(base({ ...https, WEBAUTHN_RP_ID: rpId }));
      expect(config.webauthn, rpId).toBeNull();
      expect(config.security, rpId).not.toBeNull();
      expect(reported(problems), rpId).toMatch(/WEBAUTHN_RP_ID.*passkeys are off/s);
    }
    const suffix = readEdgeConfigReport(base({ ...SECURITY, CLIENT_ORIGIN: "https://poker-web.demo.workers.dev", WEBAUTHN_RP_ID: "workers.dev" }));
    expect([suffix.config.webauthn, reported(suffix.problems)]).toEqual([null, expect.stringMatching(/public suffix/)]);
    // Not a secure context: http on a host other than localhost.
    expect(readEdgeConfig(base({ ...SECURITY, CLIENT_ORIGIN: "http://poker.lan:3000" })).webauthn).toBeNull();
    const extra = readEdgeConfig(base({ ...https, WEBAUTHN_EXTRA_ORIGINS: " https://poker.example.org , https://poker.example.org/" }));
    expect(extra.webauthn?.origins).toEqual(["https://play.poker.example.com", "https://poker.example.org"]);
    for (const origins of ["http://poker.example.org", "https://poker.example.org/path", "not a url", "https://203.0.113.9"]) {
      const { config, problems } = readEdgeConfigReport(base({ ...https, WEBAUTHN_EXTRA_ORIGINS: origins }));
      expect(config.webauthn, origins).toBeNull();
      expect(reported(problems), origins).toMatch(/WEBAUTHN_EXTRA_ORIGINS/);
    }
  });

  it("mail: Resend needs a well-formed key and MAIL_FROM, else email is off (logged); addresses and names are validated", () => {
    const key = "re_test_0123456789";
    for (const [name, extra, message] of [
      ["no MAIL_FROM", { RESEND_API_KEY: key }, /MAIL_FROM is required when RESEND_API_KEY is set/],
      ["bad key", { RESEND_API_KEY: "sk_live_123456789", MAIL_FROM: "a@example.com" }, /RESEND_API_KEY is invalid/],
    ] as const) {
      const { config, problems } = readEdgeConfigReport(base(extra));
      expect(config.mail, name).toEqual({ transport: "sink", exposeLinks: true });
      expect(reported(problems), name).toMatch(message);
    }
    expect(readEdgeConfig(base({ RESEND_API_KEY: key, MAIL_FROM: "Hold'em Live <security@mail.example.com>", MAIL_REPLY_TO: "help@example.com" })).mail)
      .toEqual({ transport: "resend", apiKey: key, from: "Hold'em Live <security@mail.example.com>", replyTo: "help@example.com" });
    expect(readEdgeConfig(base({ RESEND_API_KEY: key, MAIL_FROM: "security@mail.example.com" })).mail).toMatchObject({ replyTo: null });
    for (const from of ["security", "Name <security>", "Bad\"Name <a@example.com>", "a@example.com\r\nBcc: b@example.com"]) {
      const { config, problems } = readEdgeConfigReport(base({ RESEND_API_KEY: key, MAIL_FROM: from }));
      expect(config.mail.transport, from).toBe("sink");
      expect(reported(problems), from).toMatch(/MAIL_FROM/);
    }
    const reply = readEdgeConfigReport(base({ RESEND_API_KEY: key, MAIL_FROM: "a@example.com", MAIL_REPLY_TO: "not-an-address" }));
    expect(reply.config.mail).toMatchObject({ transport: "resend", replyTo: null });
    expect(reported(reply.problems)).toMatch(/MAIL_REPLY_TO is invalid/);
  });

  it("flags, hold hours and labels: defaults and bounds; an invalid value is ignored, and a safety switch takes its stricter value", () => {
    const config = readEdgeConfig(base({ PASSWORD_BREACH_CHECK: "0", SECURITY_HOLD_HOURS: "0", ADMIN_REQUIRE_PASSKEY: "true", TOTP_ISSUER: "Poker Club" }));
    expect([config.passwordBreachCheck, config.securityHoldMs, config.adminRequirePasskey, config.totpIssuer]).toEqual([false, 0, true, "Poker Club"]);
    expect(readEdgeConfig(base({ SECURITY_HOLD_HOURS: "168" })).securityHoldMs).toBe(168 * 3_600_000);
    for (const [name, value, check] of [
      ["SECURITY_HOLD_HOURS", "169", (c: ReturnType<typeof readEdgeConfig>) => c.securityHoldMs === 24 * 3_600_000],
      ["SECURITY_HOLD_HOURS", "1.5", (c: ReturnType<typeof readEdgeConfig>) => c.securityHoldMs === 24 * 3_600_000],
      ["PASSWORD_BREACH_CHECK", "yes", (c: ReturnType<typeof readEdgeConfig>) => c.passwordBreachCheck],
      ["ADMIN_REQUIRE_PASSKEY", "on", (c: ReturnType<typeof readEdgeConfig>) => c.adminRequirePasskey],
      ["TOTP_ISSUER", "Poker: Club", (c: ReturnType<typeof readEdgeConfig>) => c.totpIssuer === "Hold'em Live"],
      ["TOTP_ISSUER", "x".repeat(65), (c: ReturnType<typeof readEdgeConfig>) => c.totpIssuer === "Hold'em Live"],
      ["WEBAUTHN_RP_NAME", "line\nbreak", (c: ReturnType<typeof readEdgeConfig>) => c.webauthn === null],
    ] as const) {
      const { config: read, problems } = readEdgeConfigReport(base({ [name]: value }));
      expect(check(read), `${name}=${value}`).toBe(true);
      expect(reported(problems), `${name}=${value}`).toMatch(new RegExp(`${name} is invalid`));
    }
    // Settings play depends on still fail loudly.
    expect(() => readEdgeConfig(base({ ENABLE_LEGACY_BOTS: "maybe" }))).toThrow(/Invalid edge config: ENABLE_LEGACY_BOTS/);
  });

  it("the deployed vars and test bindings parse: 14-day idle sessions, terms 2026-10-19, account security configured, nothing reported", () => {
    const { config, problems } = readEdgeConfigReport(workerEnv());
    expect(config.termsVersion).toBe("2026-10-19");
    expect(config.sessionIdleTtlMs).toBe(14 * 86_400_000);
    expect(config.sessionAbsoluteTtlMs).toBe(30 * 86_400_000);
    expect(config.security).not.toBeNull();
    expect(config.webauthn?.rpId).toBe(new URL(config.clientOrigin).hostname);
    expect(config.passwordBreachCheck).toBe(false);
    expect(problems).toEqual({ ignored: [], weak: [] });
    expect(typeof workerEnv().RL_EMAIL?.limit).toBe("function");
  });

  it("the deployed vars with only the secrets production had before (no AUTH_*, no RESEND_API_KEY) parse with every new feature off", () => {
    const env = { ...workerEnv(), AUTH_HMAC_SECRET: undefined, AUTH_ENCRYPTION_KEYS: undefined, AUTH_ENCRYPTION_ACTIVE_KEY_ID: undefined, RESEND_API_KEY: undefined } as unknown as Env;
    const { config, problems } = readEdgeConfigReport(env);
    expect([config.security, config.webauthn, config.mail]).toEqual([null, null, { transport: "sink", exposeLinks: false }]);
    expect(problems).toEqual({ ignored: [], weak: [] });
  });
});

describe("a half-finished secret rollout never stops sign-in", () => {
  it("one AUTH_* secret, or RESEND_API_KEY without MAIL_FROM: password sign-in, refresh and logout work; TOTP answers 503", async () => {
    const rollouts: Record<string, string>[] = [
      { AUTH_ENCRYPTION_KEYS: "", AUTH_ENCRYPTION_ACTIVE_KEY_ID: "" },
      { AUTH_HMAC_SECRET: "", AUTH_ENCRYPTION_ACTIVE_KEY_ID: "" },
      { AUTH_ENCRYPTION_KEYS: "a1:abc" },
      { RESEND_API_KEY: "re_test_0123456789", MAIL_FROM: "" },
    ];
    for (const extra of rollouts) {
      const label = JSON.stringify(extra);
      const h = createHarness(extra);
      const pat = await signUp(h, "Rollout_Cfg");
      const login = await h.request("/auth/login", { body: { identifier: "Rollout_Cfg", password: PASSWORD } });
      expect(login.status, label).toBe(200);
      const refreshed = await h.request("/auth/refresh", { cookie: login.cookie });
      expect(refreshed.status, label).toBe(200);
      expect((await h.request("/auth/logout", { cookie: refreshed.cookie })).status, label).toBe(204);
      setStepUp(h, pat.sessionId, ["pwd"]);
      const setup = await h.request("/account/2fa/totp/setup", { token: pat.accessToken, body: {} });
      if ("RESEND_API_KEY" in extra) expect(setup.status, label).toBe(200);
      else expect([setup.status, setup.body.code], label).toEqual([503, "SECURITY_NOT_CONFIGURED"]);
    }
  }, 90_000);
});
