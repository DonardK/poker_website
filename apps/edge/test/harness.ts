import { REFRESH_COOKIE_NAME } from "@poker/shared";
import { Hono } from "hono";
import { resetFamiliarLockout } from "../src/auth/lockout";
import { readEdgeConfig, type EdgeConfig, type Env } from "../src/env";
import { attachTestDatabase, mountHttp } from "../src/http/app";
import { attachTestMailbox, type MailKind, type MailMessage } from "../src/mail/transport";
import { createMemoryDb, type MemoryDb } from "./memory-db";

export const TERMS = { acceptTerms: true as const, confirmAge: true as const, termsVersion: "2026-10-19" };
export const PASSWORD = "correct horse battery staple";

/** 32 random bytes as hex: a fresh test secret, never a value committed to the repository. */
export function randomTestHex(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** This run's harness secrets and keys (generated once per test file). */
export const TEST_SECRETS = {
  JWT_ACCESS_SECRET: randomTestHex(),
  JWT_REFRESH_SECRET: randomTestHex(),
  WS_TICKET_SECRET: randomTestHex(),
  GAME_ENCRYPTION_KEYS: `k0:${randomTestHex()}`,
  AUTH_HMAC_SECRET: randomTestHex(),
  AUTH_ENCRYPTION_KEYS: `a1:${randomTestHex()}`,
} as const;

/** Routes behind Turnstile: the harness adds a passing test token unless the body sets one. */
const CREDENTIAL = new Set(["/auth/register", "/auth/login", "/auth/password/forgot"]);

function allow() {
  return { limit: async () => ({ success: true }) };
}

export interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
  /** The poker_refresh Set-Cookie, if any. */
  setCookie: string | null;
  /** "poker_refresh=<value>" from setCookie. */
  cookie: string | null;
  /** Every Set-Cookie header. */
  setCookies: string[];
  /** name -> value from every Set-Cookie ("" when the cookie is cleared). */
  cookies: Record<string, string>;
}

export interface RevokeCall {
  userId: string;
  sessionId: string;
  reason: string;
}

export interface Harness {
  db: MemoryDb;
  config: EdgeConfig;
  tracked: string[];
  revoked: RevokeCall[];
  failTrack: boolean;
  /** Every email the API sent (attachTestMailbox), oldest first. */
  mails: MailMessage[];
  /** The #t= token of the newest email of this kind (optionally to one address). */
  lastToken(kind: MailKind, to?: string): string | null;
  request(path: string, opts?: {
    method?: string;
    body?: unknown;
    /** A Cookie header: one or more name=value pairs joined with "; ". */
    cookie?: string | null;
    token?: string;
    headers?: Record<string, string>;
    ip?: string;
    /** Cloudflare's request.cf.country. */
    country?: string;
    /** Request origin. Defaults to http://example.com. Use the CLIENT_ORIGIN host to imitate the service binding. */
    baseUrl?: string;
    /**
     * Give the request an execution context whose waitUntil promises land
     * here, so deferred work (defer.ts) runs after the response as in
     * production. Without it, deferred work finishes before the response.
     */
    waitUntil?: Promise<unknown>[];
  }): Promise<ApiResult>;
}

export interface HarnessOptions {
  /** Extra routes mounted after the API (they get the same middleware). */
  routes?(app: Hono<{ Bindings: Env }>): void;
  /** Deliver through the configured transport (Resend or the sink) instead of the test mailbox. */
  noMailbox?: boolean;
}

export function createHarness(extra: Record<string, string> = {}, options: HarnessOptions = {}): Harness {
  resetFamiliarLockout();
  const mails: MailMessage[] = [];
  const tracked: string[] = [];
  const revoked: RevokeCall[] = [];
  const flags = { failTrack: false };
  const bindings = {
    CLIENT_ORIGIN: "http://127.0.0.1:3000",
    TERMS_VERSION: "2026-10-19",
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "7d",
    SESSION_IDLE_TTL: "7d",
    SESSION_ABSOLUTE_TTL: "30d",
    DEFAULT_STARTING_BANKROLL: "10000",
    TURN_TIME_BANK_MS: "20000",
    TIME_BANK_INITIAL_MS: "30000",
    TIME_BANK_MAX_MS: "60000",
    TIME_BANK_REFILL_MS: "5000",
    TIME_BANK_REFILL_EVERY_HANDS: "10",
    ENABLE_LEGACY_BOTS: "false",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TABLE_DO_LOCATION_HINT: "weur",
    // Random per run (an https CLIENT_ORIGIN, in some tests, runs the production checks on them).
    ...TEST_SECRETS,
    GAME_ENCRYPTION_ACTIVE_KEY_ID: "k0",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a1",
    PASSWORD_BREACH_CHECK: "false",
    HYPERDRIVE: { connectionString: "postgresql://poker_app:local-only@127.0.0.1:5432/poker" },
    RL_GENERAL: allow(),
    RL_CREDENTIALS: allow(),
    RL_REFRESH: allow(),
    RL_ADMIN: allow(),
    RL_WS: allow(),
    RL_EMAIL: allow(),
    LOBBY: { getByName: () => ({}) },
    USER_SESSIONS: {
      getByName: (userId: string) => ({
        revoke: async (input: { sessionId: string; reason: string }) => {
          revoked.push({ userId, sessionId: input.sessionId, reason: input.reason });
        },
      }),
    },
    TABLES: {
      getByName: (name: string) => ({
        track: async () => {
          tracked.push(name);
          if (flags.failTrack) throw new Error("table actor unavailable");
        },
      }),
    },
    ...extra,
  };
  const config = readEdgeConfig(bindings as unknown as Env);
  const db = createMemoryDb({
    accessSecret: config.jwtAccessSecret,
    refreshSecret: config.jwtRefreshSecret,
    accessTtlSeconds: Math.floor(config.jwtAccessTtlMs / 1000),
    passwordIterations: config.passwordPbkdf2Iterations,
  });
  const app = new Hono<{ Bindings: Env }>();
  mountHttp(app);
  options.routes?.(app);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  const harness: Harness = {
    db,
    config,
    tracked,
    revoked,
    mails,
    lastToken(kind, to) {
      const mail = [...mails].reverse().find((entry) => entry.kind === kind && (to === undefined || entry.to === to));
      return mail ? /#t=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? null : null;
    },
    get failTrack() { return flags.failTrack; },
    set failTrack(value: boolean) { flags.failTrack = value; },
    request: async (path, opts = {}) => {
      const method = opts.method ?? "POST";
      const headers: Record<string, string> = {
        "cf-connecting-ip": opts.ip ?? "127.0.0.1",
        "user-agent": "vitest",
        ...(opts.headers ?? {}),
      };
      if (opts.cookie) headers.cookie = opts.cookie;
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      let payload = opts.body;
      if (CREDENTIAL.has(path) && method !== "GET" && method !== "HEAD") {
        const base = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        payload = { turnstileToken: "test-token", ...base };
      }
      let body: string | undefined;
      if (payload !== undefined && method !== "GET" && method !== "HEAD") {
        headers["content-type"] = "application/json";
        body = JSON.stringify(payload);
      }
      const env = { ...bindings, ...extra } as unknown as Env;
      attachTestDatabase(env, db.api);
      if (!options.noMailbox) attachTestMailbox(env, mails);
      const base = (opts.baseUrl ?? "http://example.com").replace(/\/+$/, "");
      const init: RequestInit & { cf?: { country: string } } = { method, headers, body };
      if (opts.country) init.cf = { country: opts.country };
      const pending = opts.waitUntil;
      const executionCtx = pending
        ? { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => undefined, props: {} }
        : undefined;
      const res = await app.request(`${base}/api${path}`, init, env, executionCtx as ExecutionContext | undefined);
      const text = await res.text();
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      const setCookie = setCookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`)) ?? null;
      const cookies: Record<string, string> = {};
      for (const entry of setCookies) {
        const pair = entry.split(";")[0]!;
        const eq = pair.indexOf("=");
        cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
      }
      let parsed: unknown = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      return {
        status: res.status,
        body: parsed,
        headers: res.headers,
        setCookie,
        cookie: setCookie ? setCookie.split(";")[0]! : null,
        setCookies,
        cookies,
      };
    },
  };
  return harness;
}

export const cookieOf = (refreshToken: string) => `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}`;
export const cleared = (result: ApiResult) => result.setCookie !== null && /Expires=Thu, 01 Jan 1970/.test(result.setCookie);

/**
 * A browser cookie jar for the auth cookies: feed it every response, send
 * header() with the next request. A cleared cookie (empty value) is dropped.
 */
export function cookieJar(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    take(result: ApiResult): ApiResult {
      for (const [name, value] of Object.entries(result.cookies)) {
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
      return result;
    },
    get: (name: string) => jar.get(name),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
    header: (): string | null => [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ") || null,
  };
}
