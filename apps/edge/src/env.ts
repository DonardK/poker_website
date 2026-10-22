import { z } from "zod";
import { AUTH_KEY_RING_NAMES, jwtSecretProblem, keyRingProblem, minDistinctCharacters, parseKeyRing, PLACEHOLDER_SECRET, type KeyRing } from "./game/key-ring";
import { logError } from "./http/log";

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
  /** Routes that send email (forgot password, email change, resend verification, step-up code). */
  RL_EMAIL: RateLimit;
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
  /**
   * PBKDF2-SHA256 iterations for new hashes. Free-plan default 10000.
   * Paid plan: 600000. Stored hashes above 1_000_000 are not computed.
   */
  PASSWORD_PBKDF2_ITERATIONS?: string;
  /** "true" compares leftover bcrypt hashes and rewrites them as PBKDF2. */
  ENABLE_LEGACY_BCRYPT?: string;
  /**
   * "true" keeps the strict Cloudflare Access check on /api/admin.
   * "false" (the workers.dev demo) skips the JWT when CF_ACCESS_* are unset
   * and still requires User.role === ADMIN.
   */
  ADMIN_REQUIRE_CF_ACCESS?: string;
  TURNSTILE_SITE_KEY: string;
  TABLE_DO_LOCATION_HINT: string;
  /** Empty unless Cloudflare Access is configured for /api/admin. Not a secret. */
  CF_ACCESS_AUD?: string;
  /** Team subdomain only, for example "contoso" in https://contoso.cloudflareaccess.com. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  // Account security. Every one is optional: a feature whose setting is absent
  // or unusable is off and its routes fail closed (503), so a missing, partial
  // or mistyped value never breaks sign-in or play (readEdgeConfig logs it).
  /**
   * Passkey relying-party id. Blank = the CLIENT_ORIGIN host. Otherwise that
   * host or a parent domain of it; never an IP address or a public suffix
   * (workers.dev is one, so the demo uses its full host).
   */
  WEBAUTHN_RP_ID?: string;
  /** Shown in the passkey prompt. Default "Hold'em Live", 1-64 characters. */
  WEBAUTHN_RP_NAME?: string;
  /** Comma list of extra https origins a passkey response may come from (a custom-domain move). */
  WEBAUTHN_EXTRA_ORIGINS?: string;
  /** Authenticator-app account label. Default "Hold'em Live", 1-64 characters, no ":". */
  TOTP_ISSUER?: string;
  /** Required with RESEND_API_KEY: "Name <addr@verified-domain>" or "addr@verified-domain". */
  MAIL_FROM?: string;
  MAIL_REPLY_TO?: string;
  /** "false" skips the Have I Been Pwned range check. Default "true". */
  PASSWORD_BREACH_CHECK?: string;
  /** Hours withdrawals stay held after a credential change, 0-168. Default 24. */
  SECURITY_HOLD_HOURS?: string;
  /** "true": admin routes need a passkey sign-in or a passkey step-up. Default "false". */
  ADMIN_REQUIRE_PASSKEY?: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  WS_TICKET_SECRET: string;
  GAME_ENCRYPTION_KEYS: string;
  GAME_ENCRYPTION_ACTIVE_KEY_ID: string;
  TURNSTILE_SECRET_KEY: string;
  /** Blank = no email is delivered (logged on an http origin, dropped on https). */
  RESEND_API_KEY?: string;
  /**
   * Set all three or none. Blank, partial or unusable = TOTP, passkeys, MFA
   * sign-in and money step-up are disabled (they answer 503, never a
   * misleading 401; an unusable set is logged as CONFIG_SETTING_IGNORED).
   * AUTH_HMAC_SECRET keys MFA tickets, challenge tokens and code hashes; the
   * ring (same format as GAME_ENCRYPTION_KEYS, independent keys) seals TOTP secrets.
   */
  AUTH_HMAC_SECRET?: string;
  AUTH_ENCRYPTION_KEYS?: string;
  AUTH_ENCRYPTION_ACTIVE_KEY_ID?: string;
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
/** "true" | "false" | "1" | "0"; blank or absent is `fallback`. */
const flag = (fallback: "true" | "false") => z.preprocess(
  (value) => (value == null || (typeof value === "string" && value.trim() === "") ? fallback : value),
  z.enum(["true", "false", "1", "0"]),
);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankIsUnset, schema.optional());
const isOn = (value: string) => value === "true" || value === "1";

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const EMAIL_ADDRESS = /^[^\s@<>"(),;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** "addr@domain" or "Display Name <addr@domain>" (no quotes, angle brackets or line breaks in the name). */
function isMailbox(value: string): boolean {
  const named = /^([^<>"\r\n]{1,64}) <([^<>\s]+)>$/.exec(value);
  return named ? EMAIL_ADDRESS.test(named[2]!) && named[1]!.trim() === named[1] : EMAIL_ADDRESS.test(value);
}
const displayName = z.string().trim().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

/**
 * The settings play depends on (as before the account-security work). A
 * missing or malformed one fails every request (HTTP 500): there is no
 * default secret.
 */
const requiredSchema = z.object({
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
  PASSWORD_PBKDF2_ITERATIONS: z.preprocess(
    (value) => (value == null || (typeof value === "string" && value.trim() === "") ? 10_000 : value),
    z.coerce.number().int().min(1).max(1_000_000),
  ),
  ENABLE_LEGACY_BCRYPT: flag("false"),
  ADMIN_REQUIRE_CF_ACCESS: flag("false"),
  TURNSTILE_SITE_KEY: z.string(),
  TABLE_DO_LOCATION_HINT: z.string().trim().min(1).max(16),
  JWT_ACCESS_SECRET: secret("JWT_ACCESS_SECRET"),
  JWT_REFRESH_SECRET: secret("JWT_REFRESH_SECRET"),
  WS_TICKET_SECRET: secret("WS_TICKET_SECRET"),
  GAME_ENCRYPTION_KEYS: z.string().min(1, "GAME_ENCRYPTION_KEYS is required"),
  GAME_ENCRYPTION_ACTIVE_KEY_ID: z.string().trim().min(1, "GAME_ENCRYPTION_ACTIVE_KEY_ID is required"),
  TURNSTILE_SECRET_KEY: z.string().min(1, "TURNSTILE_SECRET_KEY is required"),
});

type RequiredConfig = z.infer<typeof requiredSchema>;

/**
 * The account-security settings. Every one is optional, and a bad value
 * never fails a request: the setting is ignored (logged once per isolate,
 * naming the variable) and its feature stays off, or for a safety switch the
 * stricter value applies. So a half-finished `wrangler secret put` sequence
 * or a typo cannot stop sign-in, refresh or play.
 */
const optionalSchema = {
  WEBAUTHN_RP_ID: optional(z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9.-]+$/)),
  WEBAUTHN_RP_NAME: optional(displayName),
  WEBAUTHN_EXTRA_ORIGINS: optional(z.string().max(2048)),
  TOTP_ISSUER: optional(displayName.refine((value) => !value.includes(":"))),
  MAIL_FROM: optional(z.string().trim().max(320).refine(isMailbox)),
  MAIL_REPLY_TO: optional(z.string().trim().max(254).regex(EMAIL_ADDRESS)),
  PASSWORD_BREACH_CHECK: flag("true"),
  SECURITY_HOLD_HOURS: z.preprocess(blankIsUnset, z.coerce.number().int().min(0).max(168).default(24)),
  ADMIN_REQUIRE_PASSKEY: flag("false"),
  RESEND_API_KEY: optional(z.string().trim().regex(/^re_[A-Za-z0-9_]{8,200}$/)),
  AUTH_HMAC_SECRET: optional(secret("AUTH_HMAC_SECRET").refine((value) => new Set(value).size >= minDistinctCharacters(value))),
  AUTH_ENCRYPTION_KEYS: optional(z.string().trim().min(1)),
  AUTH_ENCRYPTION_ACTIVE_KEY_ID: optional(z.string().trim().min(1)),
};

type OptionalName = keyof typeof optionalSchema;
type OptionalConfig = { [K in OptionalName]: z.infer<(typeof optionalSchema)[K]> };

/**
 * Used for a setting that is present but invalid. Undefined is "not set"; the
 * feature that needs it is then off (readSecurity, readWebAuthn, readMail).
 * The safety switches take their stricter value.
 */
const INVALID_FALLBACK: OptionalConfig = {
  WEBAUTHN_RP_ID: undefined,
  WEBAUTHN_RP_NAME: undefined,
  WEBAUTHN_EXTRA_ORIGINS: undefined,
  TOTP_ISSUER: undefined,
  MAIL_FROM: undefined,
  MAIL_REPLY_TO: undefined,
  PASSWORD_BREACH_CHECK: "true",
  SECURITY_HOLD_HOURS: 24,
  ADMIN_REQUIRE_PASSKEY: "true",
  RESEND_API_KEY: undefined,
  AUTH_HMAC_SECRET: undefined,
  AUTH_ENCRYPTION_KEYS: undefined,
  AUTH_ENCRYPTION_ACTIVE_KEY_ID: undefined,
};

/** Settings ignored while reading one config, and weak production secrets that were accepted. Variable names only, never values. */
export interface ConfigProblems {
  /** An optional setting was invalid, or a feature's settings did not fit together: that feature is off. */
  ignored: string[];
  /** A required production secret looks weak or published. Accepted (play must keep working) but logged: rotate it. */
  weak: string[];
}

function readOptional(env: Env, problems: ConfigProblems): { raw: OptionalConfig; invalid: ReadonlySet<OptionalName> } {
  const raw = {} as Record<OptionalName, unknown>;
  const invalid = new Set<OptionalName>();
  for (const name of Object.keys(optionalSchema) as OptionalName[]) {
    const parsed = optionalSchema[name].safeParse((env as unknown as Record<string, unknown>)[name]);
    if (parsed.success) {
      raw[name] = parsed.data;
    } else {
      raw[name] = INVALID_FALLBACK[name];
      invalid.add(name);
      problems.ignored.push(`${name} is invalid and was ignored`);
    }
  }
  return { raw: raw as OptionalConfig, invalid };
}

const DEFAULT_SITE_NAME = "Hold'em Live";
/** Public-suffix hosts this deployment can sit under; a passkey RP ID can never be one (Public Suffix List). */
const PUBLIC_SUFFIXES = new Set(["workers.dev", "pages.dev"]);
/** Main's refusal for the JWT and WebSocket ticket secrets, plus the repository's own test marker (those values are public). */
const REFUSED_JWT_PHRASE = /change|replace|development|test-only/i;

export type MailConfig =
  | { transport: "resend"; apiKey: string; from: string; replyTo: string | null }
  /** No delivery. exposeLinks (an http origin only) lets local development log the link. */
  | { transport: "sink"; exposeLinks: boolean };

export interface SecurityConfig {
  hmacSecret: string;
  authKeys: string;
  authActiveKeyId: string;
}

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  /** CLIENT_ORIGIN first, then WEBAUTHN_EXTRA_ORIGINS. */
  origins: string[];
}

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
  passwordPbkdf2Iterations: number;
  enableLegacyBcrypt: boolean;
  adminRequireCfAccess: boolean;
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
  /** Account-security secrets; null when unset or unusable (TOTP, passkeys, MFA sign-in and money step-up fail closed). */
  security: SecurityConfig | null;
  /** Null when security is null, a WEBAUTHN_* setting is unusable, the RP ID would be an IP address, or the origin is not a secure context. */
  webauthn: WebAuthnConfig | null;
  totpIssuer: string;
  mail: MailConfig;
  passwordBreachCheck: boolean;
  securityHoldMs: number;
  adminRequirePasskey: boolean;
}

/** URL.hostname of an IP literal: dotted IPv4, or bracketed IPv6. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

const AUTH_SECRET_NAMES = ["AUTH_HMAC_SECRET", "AUTH_ENCRYPTION_KEYS", "AUTH_ENCRYPTION_ACTIVE_KEY_ID"] as const;

/**
 * All three account-security secrets or none. The ring must parse and share
 * no key with the game ring, and AUTH_HMAC_SECRET must be independent of every
 * other secret and key; on https the production checks apply too. Any problem
 * leaves security off (null) and is reported, never thrown.
 */
function readSecurity(
  required: RequiredConfig,
  opt: OptionalConfig,
  invalid: ReadonlySet<OptionalName>,
  gameRing: () => KeyRing,
  httpsOrigin: boolean,
  problems: ConfigProblems,
): SecurityConfig | null {
  const values = [opt.AUTH_HMAC_SECRET, opt.AUTH_ENCRYPTION_KEYS, opt.AUTH_ENCRYPTION_ACTIVE_KEY_ID];
  const malformed = AUTH_SECRET_NAMES.some((name) => invalid.has(name));
  if (!malformed && values.every((value) => value === undefined)) return null;
  try {
    // A malformed value was already reported by name; the other two alone are not a usable set.
    if (malformed) throw new Error("AUTH_* secrets are unusable (see the setting named above)");
    if (values.some((value) => value === undefined)) {
      throw new Error("Set AUTH_HMAC_SECRET, AUTH_ENCRYPTION_KEYS and AUTH_ENCRYPTION_ACTIVE_KEY_ID together, or none of them");
    }
    const security = { hmacSecret: opt.AUTH_HMAC_SECRET!, authKeys: opt.AUTH_ENCRYPTION_KEYS!, authActiveKeyId: opt.AUTH_ENCRYPTION_ACTIVE_KEY_ID! };
    const hmac = security.hmacSecret.trim();
    if ([required.JWT_ACCESS_SECRET, required.JWT_REFRESH_SECRET, required.WS_TICKET_SECRET].includes(security.hmacSecret)) {
      throw new Error("JWT, WebSocket ticket and AUTH_HMAC_SECRET secrets must be distinct");
    }
    if (httpsOrigin && PLACEHOLDER_SECRET.test(hmac)) throw new Error("Use an independent random AUTH_HMAC_SECRET");
    const ring = parseKeyRing({ keys: security.authKeys, activeKeyId: security.authActiveKeyId }, AUTH_KEY_RING_NAMES);
    const gameKeys = new Map([...gameRing().keys].map(([kid, key]) => [key.toString("hex"), kid]));
    if (gameKeys.has(hmac.toLowerCase())) throw new Error(`AUTH_HMAC_SECRET reuses game encryption key "${gameKeys.get(hmac.toLowerCase())}"; every purpose needs an independent secret`);
    for (const [kid, key] of ring.keys) {
      const hex = key.toString("hex");
      if (gameKeys.has(hex)) throw new Error(`AUTH_ENCRYPTION_KEYS key "${kid}" is also a game encryption key; every purpose needs an independent key`);
      if (hmac.toLowerCase() === hex) throw new Error(`AUTH_HMAC_SECRET reuses encryption key "${kid}"; every purpose needs an independent secret`);
    }
    if (httpsOrigin) {
      const problem = keyRingProblem(ring, [["JWT_ACCESS_SECRET", required.JWT_ACCESS_SECRET], ["JWT_REFRESH_SECRET", required.JWT_REFRESH_SECRET]]);
      if (problem) throw new Error(`AUTH_ENCRYPTION_KEYS: ${problem}`);
    }
    return security;
  } catch (err) {
    problems.ignored.push(`${err instanceof Error ? err.message : "AUTH_* secrets are unusable"}; TOTP, passkeys, MFA sign-in and money step-up are off`);
    return null;
  }
}

function readWebAuthn(opt: OptionalConfig, invalid: ReadonlySet<OptionalName>, origin: URL, security: SecurityConfig | null, problems: ConfigProblems): WebAuthnConfig | null {
  try {
    // A typo in the RP ID must not register passkeys under another one: an unusable value turns passkeys off.
    if (invalid.has("WEBAUTHN_RP_ID") || invalid.has("WEBAUTHN_EXTRA_ORIGINS")) throw new Error("WEBAUTHN_* settings are unusable (see the setting named above)");
    const host = origin.hostname.toLowerCase();
    const explicit = opt.WEBAUTHN_RP_ID;
    if (explicit !== undefined) {
      if (isIpLiteral(explicit)) throw new Error("WEBAUTHN_RP_ID must be a domain name, not an IP address");
      if (host !== explicit && !host.endsWith(`.${explicit}`)) throw new Error("WEBAUTHN_RP_ID must be the CLIENT_ORIGIN host or a parent domain of it");
      if (PUBLIC_SUFFIXES.has(explicit) || (!explicit.includes(".") && explicit !== "localhost")) {
        throw new Error("WEBAUTHN_RP_ID cannot be a public suffix; use the full host");
      }
    }
    const origins = [origin.origin];
    for (const entry of (opt.WEBAUTHN_EXTRA_ORIGINS ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
      let extra: URL;
      try { extra = new URL(entry); } catch { throw new Error("WEBAUTHN_EXTRA_ORIGINS must be a comma list of https origins"); }
      if (extra.protocol !== "https:" || extra.username || extra.password || extra.pathname !== "/" || extra.search || extra.hash || isIpLiteral(extra.hostname)) {
        throw new Error("WEBAUTHN_EXTRA_ORIGINS must be a comma list of https origins");
      }
      if (!origins.includes(extra.origin)) origins.push(extra.origin);
    }
    if (!security) return null;
    const rpId = explicit ?? host;
    // 127.0.0.1 is not a valid RP ID, and WebAuthn needs a secure context (https or localhost).
    if (isIpLiteral(rpId) || (origin.protocol !== "https:" && !isLocalhost(host))) return null;
    return { rpId, rpName: opt.WEBAUTHN_RP_NAME ?? DEFAULT_SITE_NAME, origins };
  } catch (err) {
    problems.ignored.push(`${err instanceof Error ? err.message : "WEBAUTHN_* settings are unusable"}; passkeys are off`);
    return null;
  }
}

function readMail(opt: OptionalConfig, invalid: ReadonlySet<OptionalName>, origin: URL, problems: ConfigProblems): MailConfig {
  const sink: MailConfig = { transport: "sink", exposeLinks: origin.protocol === "http:" };
  if (opt.RESEND_API_KEY === undefined) {
    if (invalid.has("RESEND_API_KEY")) problems.ignored.push("Email is off until RESEND_API_KEY is fixed");
    return sink;
  }
  if (opt.MAIL_FROM === undefined) {
    problems.ignored.push("MAIL_FROM is required when RESEND_API_KEY is set; email is off");
    return sink;
  }
  return { transport: "resend", apiKey: opt.RESEND_API_KEY, from: opt.MAIL_FROM, replyTo: opt.MAIL_REPLY_TO ?? null };
}

/**
 * The production (https) checks on the secrets play depends on. Only what
 * the API refused before the account-security work stays fatal, plus the
 * repository's own published test secrets: anything else is reported as
 * weak and accepted, so a deploy never locks every player out over a
 * heuristic. The game ring is parsed lazily, as the table actors do.
 */
function checkRequiredSecrets(required: RequiredConfig, gameRing: () => KeyRing, httpsOrigin: boolean, problems: ConfigProblems): void {
  const secrets = [required.JWT_ACCESS_SECRET, required.JWT_REFRESH_SECRET, required.WS_TICKET_SECRET];
  if (new Set(secrets).size !== secrets.length) throw new Error("JWT and WebSocket ticket secrets must be distinct");
  if (!httpsOrigin) return;
  if (REFUSED_JWT_PHRASE.test(secrets.join(""))) throw new Error("Use independent random JWT and WebSocket ticket secrets");
  if (PLACEHOLDER_SECRET.test(secrets.join(""))) problems.weak.push("A JWT or WebSocket ticket secret looks like a placeholder; rotate it");
  const jwt = jwtSecretProblem(required.JWT_ACCESS_SECRET, required.JWT_REFRESH_SECRET);
  if (jwt) problems.weak.push(jwt);
  let ring: KeyRing;
  try {
    ring = gameRing();
  } catch (err) {
    // Table actors refuse this ring themselves (as before); sign-in does not need it.
    problems.weak.push(err instanceof Error ? err.message : "GAME_ENCRYPTION_KEYS is unusable");
    return;
  }
  const keys = keyRingProblem(ring, [["JWT_ACCESS_SECRET", required.JWT_ACCESS_SECRET], ["JWT_REFRESH_SECRET", required.JWT_REFRESH_SECRET]]);
  if (keys) problems.weak.push(`GAME_ENCRYPTION_KEYS: ${keys}`);
}

/**
 * Validate bindings and secrets for one request and report every ignored or
 * weak setting. Throws Error (no secret values) only when a setting play
 * depends on is missing or malformed, or a TTL is out of range; callers turn
 * that into HTTP 500. There is no default secret.
 */
export function readEdgeConfigReport(env: Env): { config: EdgeConfig; problems: ConfigProblems } {
  const parsed = requiredSchema.safeParse(env);
  if (!parsed.success) {
    const name = parsed.error.issues[0]?.path.join(".") || "config";
    throw new Error(`Invalid edge config: ${name}`);
  }
  const raw = parsed.data;
  const problems: ConfigProblems = { ignored: [], weak: [] };
  const accessTtlSeconds = boundedDurationSeconds(raw.JWT_ACCESS_TTL, "JWT_ACCESS_TTL", 60, 3_600, "1 minute and 60 minutes");
  const refreshTtlSeconds = boundedDurationSeconds(raw.JWT_REFRESH_TTL, "JWT_REFRESH_TTL", 3_600, 30 * 86_400, "1 hour and 30 days");
  const sessionIdleTtlMs = durationMs("SESSION_IDLE_TTL", raw.SESSION_IDLE_TTL);
  const sessionAbsoluteTtlMs = durationMs("SESSION_ABSOLUTE_TTL", raw.SESSION_ABSOLUTE_TTL);
  if (sessionIdleTtlMs > sessionAbsoluteTtlMs) throw new Error("SESSION_IDLE_TTL cannot exceed SESSION_ABSOLUTE_TTL");
  if (raw.TIME_BANK_INITIAL_MS > raw.TIME_BANK_MAX_MS) throw new Error("TIME_BANK_INITIAL_MS cannot exceed TIME_BANK_MAX_MS");
  if (raw.TIME_BANK_REFILL_MS > raw.TIME_BANK_MAX_MS) throw new Error("TIME_BANK_REFILL_MS cannot exceed TIME_BANK_MAX_MS");
  const origin = new URL(raw.CLIENT_ORIGIN);
  const httpsOrigin = origin.protocol === "https:";
  let parsedGameRing: KeyRing | undefined;
  const gameRing = () => (parsedGameRing ??= parseKeyRing({ keys: raw.GAME_ENCRYPTION_KEYS, activeKeyId: raw.GAME_ENCRYPTION_ACTIVE_KEY_ID }));
  checkRequiredSecrets(raw, gameRing, httpsOrigin, problems);
  const { raw: opt, invalid } = readOptional(env, problems);
  const security = readSecurity(raw, opt, invalid, gameRing, httpsOrigin, problems);
  const config: EdgeConfig = {
    clientOrigin: origin.origin,
    termsVersion: raw.TERMS_VERSION,
    jwtAccessTtl: `${accessTtlSeconds}s`,
    jwtRefreshTtl: `${refreshTtlSeconds}s`,
    jwtAccessTtlMs: accessTtlSeconds * 1000,
    jwtRefreshTtlMs: refreshTtlSeconds * 1000,
    sessionIdleTtlMs,
    sessionAbsoluteTtlMs,
    defaultStartingBankroll: raw.DEFAULT_STARTING_BANKROLL,
    turnTimeBankMs: raw.TURN_TIME_BANK_MS,
    enableLegacyBots: isOn(raw.ENABLE_LEGACY_BOTS),
    passwordPbkdf2Iterations: raw.PASSWORD_PBKDF2_ITERATIONS,
    enableLegacyBcrypt: isOn(raw.ENABLE_LEGACY_BCRYPT),
    adminRequireCfAccess: isOn(raw.ADMIN_REQUIRE_CF_ACCESS),
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
    security,
    webauthn: readWebAuthn(opt, invalid, origin, security, problems),
    totpIssuer: opt.TOTP_ISSUER ?? DEFAULT_SITE_NAME,
    mail: readMail(opt, invalid, origin, problems),
    passwordBreachCheck: isOn(opt.PASSWORD_BREACH_CHECK),
    securityHoldMs: opt.SECURITY_HOLD_HOURS * 3_600_000,
    adminRequirePasskey: isOn(opt.ADMIN_REQUIRE_PASSKEY),
  };
  return { config, problems };
}

/** Problems already logged by this isolate (readEdgeConfig runs on every request). */
const loggedProblems = new Set<string>();
const LOGGED_PROBLEMS_MAX = 64;

function logOnce(key: string, log: () => void): void {
  if (loggedProblems.has(key) || loggedProblems.size >= LOGGED_PROBLEMS_MAX) return;
  loggedProblems.add(key);
  log();
}

/**
 * readEdgeConfigReport, logging each ignored or weak setting once per
 * isolate (variable names only). Throws only for the settings play needs.
 */
export function readEdgeConfig(env: Env): EdgeConfig {
  const { config, problems } = readEdgeConfigReport(env);
  for (const detail of problems.ignored) {
    logOnce(`ignored:${detail}`, () => logError({ security: "CONFIG_SETTING_IGNORED", detail }, "an account-security setting is unusable; its feature is off until it is fixed"));
  }
  for (const detail of problems.weak) {
    logOnce(`weak:${detail}`, () => logError({ security: "WEAK_PRODUCTION_SECRET", detail }, "a production secret looks weak or published; accepted so play continues, rotate it"));
  }
  return config;
}
