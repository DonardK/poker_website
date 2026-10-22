/**
 * readEdgeConfig: the optional account-security settings (design: all
 * optional, fail closed when absent, refuse loudly when present but wrong),
 * the production key checks on an https origin, and the deployed vars.
 */
import { describe, expect, it } from "vitest";
import { authRingFromConfig, ringFromConfig } from "../src/game/crypto";
import { readEdgeConfig, type Env } from "../src/env";
import { workerEnv } from "./worker-bindings";

const AUTH_KEY = "5f2c8e1a9b7d4c3e6f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a";
const GAME_KEY = "c549a47e88271398c0804736a4fcbaa0273d3b09c944b7ee5bea23f3ad51b784";
const SECURITY = {
  AUTH_HMAC_SECRET: "test-only-auth-hmac-secret-32chars-ok",
  AUTH_ENCRYPTION_KEYS: `a1:${AUTH_KEY}`,
  AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a1",
};

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
    JWT_ACCESS_SECRET: "test-only-access-secret-32chars-min",
    JWT_REFRESH_SECRET: "test-only-refresh-secret-32chars-ok",
    WS_TICKET_SECRET: "test-only-ws-ticket-secret-32chars",
    GAME_ENCRYPTION_KEYS: `k1:${GAME_KEY}`,
    GAME_ENCRYPTION_ACTIVE_KEY_ID: "k1",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    ...extra,
  } as unknown as Env;
}

describe("edge config: account security", () => {
  it("leaves every account-security feature off, without failing, when nothing is set", () => {
    const config = readEdgeConfig(base({ AUTH_HMAC_SECRET: "", RESEND_API_KEY: " " }));
    expect(config.security).toBeNull();
    expect(config.webauthn).toBeNull();
    expect(authRingFromConfig(config)).toBeNull();
    expect(config.mail).toEqual({ transport: "sink", exposeLinks: true });
    expect(config.totpIssuer).toBe("Hold'em Live");
    expect(config.passwordBreachCheck).toBe(true);
    expect(config.securityHoldMs).toBe(24 * 3_600_000);
    expect(config.adminRequirePasskey).toBe(false);
  });

  it("parses the three secrets together and keeps the auth ring apart from the game ring", () => {
    const config = readEdgeConfig(base({ ...SECURITY, CLIENT_ORIGIN: "http://localhost:3000" }));
    expect(config.security).toEqual({ hmacSecret: SECURITY.AUTH_HMAC_SECRET, authKeys: SECURITY.AUTH_ENCRYPTION_KEYS, authActiveKeyId: "a1" });
    expect(authRingFromConfig(config)?.activeKeyId).toBe("a1");
    expect(ringFromConfig(config).activeKeyId).toBe("k1");
    expect(config.webauthn).toEqual({ rpId: "localhost", rpName: "Hold'em Live", origins: ["http://localhost:3000"] });
  });

  it("refuses a partial set, a reused key or secret, and a malformed ring, naming only the variable", () => {
    for (const [name, extra, message] of [
      ["partial", { AUTH_HMAC_SECRET: SECURITY.AUTH_HMAC_SECRET }, /together/],
      ["no hmac", { AUTH_ENCRYPTION_KEYS: SECURITY.AUTH_ENCRYPTION_KEYS, AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a1" }, /together/],
      ["game key reused", { ...SECURITY, AUTH_ENCRYPTION_KEYS: `a1:${GAME_KEY}` }, /also a game encryption key/],
      ["hmac equals jwt", { ...SECURITY, AUTH_HMAC_SECRET: "test-only-access-secret-32chars-min" }, /must be distinct/],
      ["hmac equals key", { ...SECURITY, AUTH_HMAC_SECRET: AUTH_KEY }, /AUTH_HMAC_SECRET reuses/],
      ["bad ring", { ...SECURITY, AUTH_ENCRYPTION_KEYS: "a1:abc" }, /^AUTH_ENCRYPTION_KEYS: key "a1" must be 64 hex/],
      ["unknown active id", { ...SECURITY, AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a2" }, /^AUTH_ENCRYPTION_ACTIVE_KEY_ID "a2" is not in the key ring/],
      ["short hmac", { ...SECURITY, AUTH_HMAC_SECRET: "too-short" }, /Invalid edge config: AUTH_HMAC_SECRET/],
      ["low-entropy hmac", { ...SECURITY, AUTH_HMAC_SECRET: "ab".repeat(20) }, /Invalid edge config: AUTH_HMAC_SECRET/],
    ] as const) {
      expect(() => readEdgeConfig(base(extra)), name).toThrow(message);
      try { readEdgeConfig(base(extra)); } catch (error) {
        expect((error as Error).message, name).not.toContain(AUTH_KEY);
        expect((error as Error).message, name).not.toContain(GAME_KEY);
      }
    }
  });

  it("on https, refuses placeholder game or auth keys (production checks)", () => {
    const https = { CLIENT_ORIGIN: "https://poker-web.example.workers.dev" };
    expect(() => readEdgeConfig(base({ ...https, GAME_ENCRYPTION_KEYS: `k1:${"0123456789abcdef".repeat(4)}` }))).toThrow(/published placeholder/);
    expect(() => readEdgeConfig(base({ ...https, ...SECURITY, AUTH_ENCRYPTION_KEYS: `a1:${"deadbeef".repeat(8)}` }))).toThrow(/published placeholder/);
    expect(() => readEdgeConfig(base({ ...https, ...SECURITY, AUTH_HMAC_SECRET: "please-replace-this-auth-hmac-secret-now" }))).toThrow(/independent random/);
    // The same placeholders are accepted for local development over http.
    expect(readEdgeConfig(base({ GAME_ENCRYPTION_KEYS: `k1:${"0123456789abcdef".repeat(4)}` })).security).toBeNull();
    const config = readEdgeConfig(base({ ...https, ...SECURITY }));
    expect(config.webauthn).toEqual({ rpId: "poker-web.example.workers.dev", rpName: "Hold'em Live", origins: ["https://poker-web.example.workers.dev"] });
    // Random hex secrets (DEPLOY.md: randomBytes(32).toString("hex")) often lack one of the 16 digits; they are fine.
    const hexMissingDigits = { JWT_ACCESS_SECRET: "3a1b2c4d5e6a7b8c9d0e1a2b3c4d5e6a7b8c9d0e1a2b3c4d5e6a7b8c9d0e1a2b", JWT_REFRESH_SECRET: "9c8b7a6d5e4c3b2a1d0e9c8b7a6d5e4c3b2a1d0e9c8b7a6d5e4c3b2a1d0e9c8b" };
    expect(new Set(hexMissingDigits.JWT_ACCESS_SECRET).size).toBeLessThan(16);
    expect(readEdgeConfig(base({ ...https, ...SECURITY, ...hexMissingDigits, AUTH_HMAC_SECRET: "7e6d5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3a2918f7e6" })).security).not.toBeNull();
    // A repetitive secret is still refused.
    expect(() => readEdgeConfig(base({ ...https, JWT_ACCESS_SECRET: "abcdabcdabcdabcdabcdabcdabcdabcdabcd" }))).toThrow(/at least 8 distinct/);
    expect(() => readEdgeConfig(base({ ...https, JWT_ACCESS_SECRET: "test-test-test-test-test-test-test-test" }))).toThrow(/at least 16 distinct/);
    expect(config.mail).toEqual({ transport: "sink", exposeLinks: false });
  });

  it("passkeys: an IP-literal origin turns them off; an explicit RP ID must be the host or a parent, never a suffix or IP", () => {
    expect(readEdgeConfig(base(SECURITY)).webauthn).toBeNull();
    const https = { ...SECURITY, CLIENT_ORIGIN: "https://play.poker.example.com" };
    expect(readEdgeConfig(base({ ...https, WEBAUTHN_RP_ID: "Poker.Example.com" })).webauthn?.rpId).toBe("poker.example.com");
    expect(readEdgeConfig(base({ ...https, WEBAUTHN_RP_ID: "play.poker.example.com", WEBAUTHN_RP_NAME: "Poker" })).webauthn?.rpName).toBe("Poker");
    for (const rpId of ["other.example.com", "ay.poker.example.com", "com", "127.0.0.1"]) {
      expect(() => readEdgeConfig(base({ ...https, WEBAUTHN_RP_ID: rpId })), rpId).toThrow();
    }
    expect(() => readEdgeConfig(base({ ...SECURITY, CLIENT_ORIGIN: "https://poker-web.demo.workers.dev", WEBAUTHN_RP_ID: "workers.dev" }))).toThrow(/public suffix/);
    // Not a secure context: http on a host other than localhost.
    expect(readEdgeConfig(base({ ...SECURITY, CLIENT_ORIGIN: "http://poker.lan:3000" })).webauthn).toBeNull();
    const extra = readEdgeConfig(base({ ...https, WEBAUTHN_EXTRA_ORIGINS: " https://poker.example.org , https://poker.example.org/" }));
    expect(extra.webauthn?.origins).toEqual(["https://play.poker.example.com", "https://poker.example.org"]);
    for (const origins of ["http://poker.example.org", "https://poker.example.org/path", "not a url", "https://203.0.113.9"]) {
      expect(() => readEdgeConfig(base({ ...https, WEBAUTHN_EXTRA_ORIGINS: origins })), origins).toThrow(/WEBAUTHN_EXTRA_ORIGINS/);
    }
  });

  it("mail: Resend needs a well-formed key and MAIL_FROM; addresses and names are validated", () => {
    const key = "re_test_0123456789";
    expect(() => readEdgeConfig(base({ RESEND_API_KEY: key }))).toThrow(/MAIL_FROM is required/);
    expect(() => readEdgeConfig(base({ RESEND_API_KEY: "sk_live_123456789", MAIL_FROM: "a@example.com" }))).toThrow(/RESEND_API_KEY/);
    expect(readEdgeConfig(base({ RESEND_API_KEY: key, MAIL_FROM: "Hold'em Live <security@mail.example.com>", MAIL_REPLY_TO: "help@example.com" })).mail)
      .toEqual({ transport: "resend", apiKey: key, from: "Hold'em Live <security@mail.example.com>", replyTo: "help@example.com" });
    expect(readEdgeConfig(base({ RESEND_API_KEY: key, MAIL_FROM: "security@mail.example.com" })).mail).toMatchObject({ replyTo: null });
    for (const from of ["security", "Name <security>", "Bad\"Name <a@example.com>", "a@example.com\r\nBcc: b@example.com"]) {
      expect(() => readEdgeConfig(base({ RESEND_API_KEY: key, MAIL_FROM: from })), from).toThrow(/MAIL_FROM/);
    }
    expect(() => readEdgeConfig(base({ MAIL_REPLY_TO: "not-an-address" }))).toThrow(/MAIL_REPLY_TO/);
  });

  it("flags, hold hours and labels: defaults, bounds and refusals", () => {
    const config = readEdgeConfig(base({ PASSWORD_BREACH_CHECK: "0", SECURITY_HOLD_HOURS: "0", ADMIN_REQUIRE_PASSKEY: "true", TOTP_ISSUER: "Poker Club" }));
    expect([config.passwordBreachCheck, config.securityHoldMs, config.adminRequirePasskey, config.totpIssuer]).toEqual([false, 0, true, "Poker Club"]);
    expect(readEdgeConfig(base({ SECURITY_HOLD_HOURS: "168" })).securityHoldMs).toBe(168 * 3_600_000);
    for (const [name, value] of [
      ["SECURITY_HOLD_HOURS", "169"], ["SECURITY_HOLD_HOURS", "1.5"], ["PASSWORD_BREACH_CHECK", "yes"], ["ADMIN_REQUIRE_PASSKEY", "on"],
      ["TOTP_ISSUER", "Poker: Club"], ["TOTP_ISSUER", "x".repeat(65)], ["WEBAUTHN_RP_NAME", "line\nbreak"],
    ] as const) {
      expect(() => readEdgeConfig(base({ [name]: value })), `${name}=${value}`).toThrow(new RegExp(name));
    }
  });

  it("the deployed vars and test bindings parse: 14-day idle sessions, terms 2026-10-19, account security configured", () => {
    const config = readEdgeConfig(workerEnv());
    expect(config.termsVersion).toBe("2026-10-19");
    expect(config.sessionIdleTtlMs).toBe(14 * 86_400_000);
    expect(config.sessionAbsoluteTtlMs).toBe(30 * 86_400_000);
    expect(config.security).not.toBeNull();
    expect(config.webauthn?.rpId).toBe(new URL(config.clientOrigin).hostname);
    expect(config.passwordBreachCheck).toBe(false);
    expect(typeof workerEnv().RL_EMAIL?.limit).toBe("function");
  });
});
