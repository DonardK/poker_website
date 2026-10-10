import { config as loadEnv } from "dotenv";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertCookieSite, boundedDurationSeconds } from "./security/config-checks.js";
import { assertProductionSecrets, parseKeyRing, type KeyRing } from "./security/key-ring.js";
import { parseTrustedProxyCidrs, setDefaultTrustedPeers, type ProxyTrust } from "./transport.js";

const here = fileURLToPath(new URL(".", import.meta.url));
loadEnv({ quiet: true, path: resolve(here, "../../../.env") });
loadEnv({ quiet: true, path: resolve(here, "../.env") });

/** Optional file path; a blank value (e.g. `TLS_CERT_FILE=` in .env) means unset. */
const optionalPath = z.string().optional().transform((value) => value?.trim() || undefined);
/** Optional string; blank means unset. */
const optionalText = optionalPath;

// Every value is validated here, at import time, before index.ts opens any
// database or Redis connection: a bad value stops the process at startup.
// Error messages name the variable and its allowed range, never a secret.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  // Interface listen() binds to. Behind a proxy, bind a private interface so
  // only the proxy can reach the port (see TRUSTED_PROXY_CIDRS).
  HOST: z.string().optional().transform((value) => value?.trim() || "0.0.0.0")
    .refine((value) => isIP(value) !== 0 || /^(?!-)[A-Za-z0-9.-]{1,253}$/.test(value), "HOST must be an IP address or host name"),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:3000").transform((value) => new URL(value).origin),
  // The API's public origin, when the web app reaches it on another host (cookie site check below).
  PUBLIC_API_ORIGIN: optionalText.refine((value) => value === undefined || URL.canParse(value), "PUBLIC_API_ORIGIN must be a URL")
    .transform((value) => value === undefined ? undefined : new URL(value).origin),
  COOKIE_SITE: optionalText,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional().default(""),
  // Key ring (security/key-ring.ts): "kid:hex64,..." plus the active key id;
  // the legacy single key remains valid as key id "k0".
  GAME_ENCRYPTION_KEYS: optionalText,
  GAME_ENCRYPTION_ACTIVE_KEY_ID: optionalText,
  GAME_ENCRYPTION_KEY: optionalText,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  // Comma list of proxy addresses / CIDRs ("private" = loopback, RFC 1918, fc00::/7).
  TRUSTED_PROXY_CIDRS: optionalText,
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  DEFAULT_STARTING_BANKROLL: z.coerce.number().int().min(0).max(1_000_000_000).default(10_000),
  TURN_TIME_BANK_MS: z.coerce.number().int().min(5_000).max(120_000).default(20_000),
  // PEM certificate chain and private key for direct TLS termination (node:https).
  TLS_CERT_FILE: optionalPath,
  TLS_KEY_FILE: optionalPath,
});

const parsed = envSchema.parse(process.env);
const accessTtlSeconds = boundedDurationSeconds(parsed.JWT_ACCESS_TTL, "JWT_ACCESS_TTL", 60, 3_600, "1 minute and 60 minutes");
const refreshTtlSeconds = boundedDurationSeconds(parsed.JWT_REFRESH_TTL, "JWT_REFRESH_TTL", 3_600, 30 * 86_400, "1 hour and 30 days");
const { GAME_ENCRYPTION_KEYS, GAME_ENCRYPTION_ACTIVE_KEY_ID, GAME_ENCRYPTION_KEY, ...settings } = parsed;

/** Game-state key ring. Key material lives only here, never in `env`. */
export const encryptionKeyRing: KeyRing = parseKeyRing({ keys: GAME_ENCRYPTION_KEYS, legacyKey: GAME_ENCRYPTION_KEY, activeKeyId: GAME_ENCRYPTION_ACTIVE_KEY_ID });

export const env = {
  ...settings,
  // Normalised to "<seconds>s": jsonwebtoken reads a digits-only string as
  // milliseconds, so "900" would otherwise mean 0.9 s (auth/jwt.ts passes these through).
  JWT_ACCESS_TTL: `${accessTtlSeconds}s`,
  JWT_REFRESH_TTL: `${refreshTtlSeconds}s`,
  jwtAccessTtlMs: accessTtlSeconds * 1000,
  jwtRefreshTtlMs: refreshTtlSeconds * 1000,
};
export const isProd = env.NODE_ENV === "production";
export const redisEnabled = env.REDIS_URL.length > 0;
export const tlsEnabled = Boolean(env.TLS_CERT_FILE && env.TLS_KEY_FILE);

if (Boolean(env.TLS_CERT_FILE) !== Boolean(env.TLS_KEY_FILE)) throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither");

/**
 * Proxy trust for X-Forwarded-Proto / X-Forwarded-For (transport.ts). Also
 * registered as the process default, so code that passes the bare
 * TRUST_PROXY_HOPS number gets the same peer check.
 */
export const proxyTrust: ProxyTrust = {
  hops: env.TRUST_PROXY_HOPS,
  trustedPeers: env.TRUSTED_PROXY_CIDRS ? parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS) : undefined,
};
setDefaultTrustedPeers(proxyTrust.trustedPeers);

if (isProd) {
  if (!env.CLIENT_ORIGIN.startsWith("https://")) throw new Error("Production requires HTTPS");
  // COMPLIANCE (TLS): hole cards may only travel over TLS. Either this process
  // terminates TLS, or it runs behind a trusted TLS-terminating proxy.
  if (!tlsEnabled && env.TRUST_PROXY_HOPS < 1) {
    throw new Error("Production requires TLS: set TLS_CERT_FILE and TLS_KEY_FILE, or set TRUST_PROXY_HOPS >= 1 behind a TLS-terminating proxy");
  }
  // SECURITY: in proxy mode X-Forwarded-Proto decides whether a request "used
  // TLS". Without a peer allow-list any client that reaches the port directly
  // could claim it, so production names the proxies explicitly.
  if (env.TRUST_PROXY_HOPS >= 1 && !proxyTrust.trustedPeers) {
    throw new Error("Production proxy mode (TRUST_PROXY_HOPS >= 1) requires TRUSTED_PROXY_CIDRS: the proxy addresses or networks allowed to set X-Forwarded-Proto/For (\"private\" = loopback, RFC 1918 and fc00::/7)");
  }
  if (env.REDIS_URL && !env.REDIS_URL.startsWith("rediss://")) throw new Error("Production Redis requires TLS");
  const url = new URL(env.DATABASE_URL);
  if (!url.searchParams.has("sslmode") || url.searchParams.get("sslmode") !== "require" || url.searchParams.get("sslaccept") !== "strict") throw new Error("Database TLS with certificate validation is required");
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET || /change|replace|development/i.test(env.JWT_ACCESS_SECRET + env.JWT_REFRESH_SECRET)) throw new Error("Use independent random JWT secrets");
  assertProductionSecrets(encryptionKeyRing, env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET);
  assertCookieSite(env.CLIENT_ORIGIN, env.PUBLIC_API_ORIGIN, env.COOKIE_SITE);
}

// ---------------------------------------------------------------------------
// AUTH SETTINGS (server-auth workstream; auth/** reads these, nothing else).
// One session lifetime drives the refresh cookie's maxAge, Session.expiresAt
// and the refresh JWT's exp: min(last refresh + idle TTL, absolute expiry).
// ---------------------------------------------------------------------------
/** "500ms", "30s", "15m", "12h", "7d", or a bare number of seconds (jsonwebtoken's convention), in milliseconds. */
function durationMs(name: string, value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(match?.[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h" | "d"];
  const ms = match ? Number(match[1]) * unit : NaN;
  if (!Number.isSafeInteger(ms) || ms < 60_000 || ms > 366 * 86_400_000) throw new Error(`${name} must be a duration between 1 minute and 366 days (e.g. "7d"), got "${value}"`);
  return ms;
}
const authRaw = z.object({
  SESSION_IDLE_TTL: z.string().optional(),
  SESSION_ABSOLUTE_TTL: z.string().optional(),
  TERMS_VERSION: z.string().optional(),
}).parse(process.env);
export const authConfig = {
  /** A session not refreshed for this long expires (default: JWT_REFRESH_TTL, 7 days). */
  sessionIdleTtlMs: durationMs("SESSION_IDLE_TTL", authRaw.SESSION_IDLE_TTL?.trim() || env.JWT_REFRESH_TTL),
  /** Hard end of every session from its creation, however often it is refreshed (default 30 days). */
  sessionAbsoluteTtlMs: durationMs("SESSION_ABSOLUTE_TTL", authRaw.SESSION_ABSOLUTE_TTL?.trim() || "30d"),
  /** Terms version sign-ups must accept; must equal the web app's TERMS_VERSION (apps/web/src/lib/legal.ts). */
  termsVersion: authRaw.TERMS_VERSION?.trim() || "2026-10-01",
} as const;
if (authConfig.sessionIdleTtlMs > authConfig.sessionAbsoluteTtlMs) throw new Error("SESSION_IDLE_TTL cannot exceed SESSION_ABSOLUTE_TTL");
if (authConfig.termsVersion.length > 64) throw new Error("TERMS_VERSION is at most 64 characters");

// ---------------------------------------------------------------------------
// GAME SETTINGS (server-sg1 reliability workstream; game/manager.ts and
// routes/tables.ts read these). Blank means unset, so `NAME=` in .env keeps
// the default instead of becoming 0.
// ---------------------------------------------------------------------------
const blankIsUnset = (value: unknown) => typeof value === "string" && value.trim() === "" ? undefined : value;
const gameMs = (max: number, fallback: number) => z.preprocess(blankIsUnset, z.coerce.number().int().min(0).max(max).default(fallback));
const gameRaw = z.object({
  // Only "true"/"1" enable; anything unexpected is refused (z.coerce.boolean would read "false" as true).
  ENABLE_LEGACY_BOTS: z.preprocess(blankIsUnset, z.enum(["true", "false", "1", "0"]).default("false")).transform((value) => value === "true" || value === "1"),
  TIME_BANK_INITIAL_MS: gameMs(300_000, 30_000),
  TIME_BANK_MAX_MS: gameMs(600_000, 60_000),
  TIME_BANK_REFILL_MS: gameMs(120_000, 5_000),
  TIME_BANK_REFILL_EVERY_HANDS: z.preprocess(blankIsUnset, z.coerce.number().int().min(1).max(1_000).default(10)),
}).parse(process.env);
if (gameRaw.TIME_BANK_INITIAL_MS > gameRaw.TIME_BANK_MAX_MS) throw new Error("TIME_BANK_INITIAL_MS cannot exceed TIME_BANK_MAX_MS");
if (gameRaw.TIME_BANK_REFILL_MS > gameRaw.TIME_BANK_MAX_MS) throw new Error("TIME_BANK_REFILL_MS cannot exceed TIME_BANK_MAX_MS");
export const gameConfig = {
  /**
   * Legacy bot seats play (D11). Off by default: a bot's turn is then treated
   * like an absent player's (it times out), so legacy bot tables idle-close and
   * pay out instead of being kept alive by bots.
   */
  enableLegacyBots: gameRaw.ENABLE_LEGACY_BOTS,
  /**
   * Personal time bank for NEW tables (D4), or null when TIME_BANK_INITIAL_MS
   * is 0. A table keeps the setting it was created with (it is stored in its
   * engine state), so changing it never alters a running table.
   */
  extraTimeBank: gameRaw.TIME_BANK_INITIAL_MS === 0 ? null : {
    initialMs: gameRaw.TIME_BANK_INITIAL_MS,
    maxMs: gameRaw.TIME_BANK_MAX_MS,
    refillMs: gameRaw.TIME_BANK_REFILL_MS,
    refillEveryHands: gameRaw.TIME_BANK_REFILL_EVERY_HANDS,
  },
} as const;
