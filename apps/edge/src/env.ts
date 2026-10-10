import { z } from "zod";

/** Bindings and vars from wrangler.jsonc. Secrets arrive from wrangler secret / .dev.vars. */
export interface Env {
  HYPERDRIVE: Hyperdrive;
  TABLES: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  USER_SESSIONS: DurableObjectNamespace;
  RL_GENERAL: RateLimit;
  RL_CREDENTIALS: RateLimit;
  RL_REFRESH: RateLimit;
  RL_ADMIN: RateLimit;
  RL_WS: RateLimit;
  CLIENT_ORIGIN: string;
  TERMS_VERSION: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_TTL: string;
  SESSION_IDLE_TTL: string;
  SESSION_ABSOLUTE_TTL: string;
  DEFAULT_STARTING_BANKROLL: string;
  TURN_TIME_BANK_MS: string;
  TIME_BANK_INITIAL_MS: string;
  TIME_BANK_MAX_MS: string;
  TIME_BANK_REFILL_MS: string;
  TIME_BANK_REFILL_EVERY_HANDS: string;
  ENABLE_LEGACY_BOTS: string;
  TURNSTILE_SITE_KEY: string;
  TABLE_DO_LOCATION_HINT: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  WS_TICKET_SECRET: string;
  GAME_ENCRYPTION_KEYS: string;
  GAME_ENCRYPTION_ACTIVE_KEY_ID: string;
  TURNSTILE_SECRET_KEY: string;
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

function parseDurationSeconds(raw: string, name: string): number {
  const match = /^(\d{1,9})([smhd])?$/.exec(raw.trim());
  if (!match) throw new Error(`${name} must be an integer number of seconds or an integer with a unit s, m, h or d (e.g. "15m", "7d")`);
  return Number(match[1]) * UNIT_SECONDS[match[2] ?? "s"]!;
}

function boundedDurationSeconds(raw: string, name: string, minSeconds: number, maxSeconds: number, bounds: string): number {
  const seconds = parseDurationSeconds(raw, name);
  if (seconds < minSeconds || seconds > maxSeconds) throw new Error(`${name} must be between ${bounds}`);
  return seconds;
}

/** "500ms", "30s", "15m", "12h", "7d", or a bare number of seconds, in milliseconds. */
function durationMs(name: string, value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(match?.[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h" | "d"];
  const ms = match ? Number(match[1]) * unit : NaN;
  if (!Number.isSafeInteger(ms) || ms < 60_000 || ms > 366 * 86_400_000) {
    throw new Error(`${name} must be a duration between 1 minute and 366 days (e.g. "7d")`);
  }
  return ms;
}

const blankIsUnset = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const gameMs = (max: number, fallback: number) => z.preprocess(blankIsUnset, z.coerce.number().int().min(0).max(max).default(fallback));

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const bindingSchema = z.object({
  CLIENT_ORIGIN: z.string().url(),
  TERMS_VERSION: z.string().trim().min(1).max(64),
  JWT_ACCESS_TTL: z.string(),
  JWT_REFRESH_TTL: z.string(),
  SESSION_IDLE_TTL: z.string(),
  SESSION_ABSOLUTE_TTL: z.string(),
  DEFAULT_STARTING_BANKROLL: z.coerce.number().int().min(0).max(1_000_000_000),
  TURN_TIME_BANK_MS: z.coerce.number().int().min(5_000).max(120_000),
  TIME_BANK_INITIAL_MS: gameMs(300_000, 30_000),
  TIME_BANK_MAX_MS: gameMs(600_000, 60_000),
  TIME_BANK_REFILL_MS: gameMs(120_000, 5_000),
  TIME_BANK_REFILL_EVERY_HANDS: z.preprocess(blankIsUnset, z.coerce.number().int().min(1).max(1_000).default(10)),
  ENABLE_LEGACY_BOTS: z.enum(["true", "false", "1", "0"]),
  TURNSTILE_SITE_KEY: z.string(),
  TABLE_DO_LOCATION_HINT: z.string().trim().min(1).max(16),
  JWT_ACCESS_SECRET: secret("JWT_ACCESS_SECRET"),
  JWT_REFRESH_SECRET: secret("JWT_REFRESH_SECRET"),
  WS_TICKET_SECRET: secret("WS_TICKET_SECRET"),
  GAME_ENCRYPTION_KEYS: z.string().min(1, "GAME_ENCRYPTION_KEYS is required"),
  GAME_ENCRYPTION_ACTIVE_KEY_ID: z.string().trim().min(1, "GAME_ENCRYPTION_ACTIVE_KEY_ID is required"),
  TURNSTILE_SECRET_KEY: z.string().min(1, "TURNSTILE_SECRET_KEY is required"),
});

export interface EdgeConfig {
  clientOrigin: string;
  termsVersion: string;
  jwtAccessTtl: string;
  jwtRefreshTtl: string;
  jwtAccessTtlMs: number;
  jwtRefreshTtlMs: number;
  sessionIdleTtlMs: number;
  sessionAbsoluteTtlMs: number;
  defaultStartingBankroll: number;
  turnTimeBankMs: number;
  enableLegacyBots: boolean;
  timeBankInitialMs: number;
  timeBankMaxMs: number;
  timeBankRefillMs: number;
  timeBankRefillEveryHands: number;
  turnstileSiteKey: string;
  tableDoLocationHint: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  wsTicketSecret: string;
  gameEncryptionKeys: string;
  gameEncryptionActiveKeyId: string;
  turnstileSecretKey: string;
}

/**
 * Validate bindings and secrets for one request. Throws Error (no secret
 * values) when a required secret is missing or a TTL is out of range.
 * Callers turn that into HTTP 500. There is no default secret.
 */
export function readEdgeConfig(env: Env): EdgeConfig {
  const parsed = bindingSchema.safeParse(env);
  if (!parsed.success) {
    const name = parsed.error.issues[0]?.path.join(".") || "config";
    throw new Error(`Invalid edge config: ${name}`);
  }
  const raw = parsed.data;
  const accessTtlSeconds = boundedDurationSeconds(raw.JWT_ACCESS_TTL, "JWT_ACCESS_TTL", 60, 3_600, "1 minute and 60 minutes");
  const refreshTtlSeconds = boundedDurationSeconds(raw.JWT_REFRESH_TTL, "JWT_REFRESH_TTL", 3_600, 30 * 86_400, "1 hour and 30 days");
  const sessionIdleTtlMs = durationMs("SESSION_IDLE_TTL", raw.SESSION_IDLE_TTL);
  const sessionAbsoluteTtlMs = durationMs("SESSION_ABSOLUTE_TTL", raw.SESSION_ABSOLUTE_TTL);
  if (sessionIdleTtlMs > sessionAbsoluteTtlMs) throw new Error("SESSION_IDLE_TTL cannot exceed SESSION_ABSOLUTE_TTL");
  if (raw.TIME_BANK_INITIAL_MS > raw.TIME_BANK_MAX_MS) throw new Error("TIME_BANK_INITIAL_MS cannot exceed TIME_BANK_MAX_MS");
  if (raw.TIME_BANK_REFILL_MS > raw.TIME_BANK_MAX_MS) throw new Error("TIME_BANK_REFILL_MS cannot exceed TIME_BANK_MAX_MS");
  const secrets = [raw.JWT_ACCESS_SECRET, raw.JWT_REFRESH_SECRET, raw.WS_TICKET_SECRET];
  if (new Set(secrets).size !== secrets.length) throw new Error("JWT and WebSocket ticket secrets must be distinct");
  if (raw.CLIENT_ORIGIN.startsWith("https://") && /change|replace|development/i.test(secrets.join(""))) {
    throw new Error("Use independent random JWT and WebSocket ticket secrets");
  }
  return {
    clientOrigin: new URL(raw.CLIENT_ORIGIN).origin,
    termsVersion: raw.TERMS_VERSION,
    jwtAccessTtl: `${accessTtlSeconds}s`,
    jwtRefreshTtl: `${refreshTtlSeconds}s`,
    jwtAccessTtlMs: accessTtlSeconds * 1000,
    jwtRefreshTtlMs: refreshTtlSeconds * 1000,
    sessionIdleTtlMs,
    sessionAbsoluteTtlMs,
    defaultStartingBankroll: raw.DEFAULT_STARTING_BANKROLL,
    turnTimeBankMs: raw.TURN_TIME_BANK_MS,
    enableLegacyBots: raw.ENABLE_LEGACY_BOTS === "true" || raw.ENABLE_LEGACY_BOTS === "1",
    timeBankInitialMs: raw.TIME_BANK_INITIAL_MS,
    timeBankMaxMs: raw.TIME_BANK_MAX_MS,
    timeBankRefillMs: raw.TIME_BANK_REFILL_MS,
    timeBankRefillEveryHands: raw.TIME_BANK_REFILL_EVERY_HANDS,
    turnstileSiteKey: raw.TURNSTILE_SITE_KEY,
    tableDoLocationHint: raw.TABLE_DO_LOCATION_HINT,
    jwtAccessSecret: raw.JWT_ACCESS_SECRET,
    jwtRefreshSecret: raw.JWT_REFRESH_SECRET,
    wsTicketSecret: raw.WS_TICKET_SECRET,
    gameEncryptionKeys: raw.GAME_ENCRYPTION_KEYS,
    gameEncryptionActiveKeyId: raw.GAME_ENCRYPTION_ACTIVE_KEY_ID,
    turnstileSecretKey: raw.TURNSTILE_SECRET_KEY,
  };
}
