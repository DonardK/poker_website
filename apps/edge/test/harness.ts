import { REFRESH_COOKIE_NAME } from "@poker/shared";
import { Hono } from "hono";
import { resetFamiliarLockout } from "../src/auth/lockout";
import { readEdgeConfig, type EdgeConfig, type Env } from "../src/env";
import { attachTestDatabase, mountHttp } from "../src/http/app";
import { createMemoryDb, type MemoryDb } from "./memory-db";

export const TERMS = { acceptTerms: true as const, confirmAge: true as const, termsVersion: "2026-10-01" };
export const PASSWORD = "correct horse battery staple";

const CREDENTIAL = new Set(["/auth/register", "/auth/login", "/auth/guest"]);

function allow() {
  return { limit: async () => ({ success: true }) };
}

export interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
  setCookie: string | null;
  cookie: string | null;
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
  request(path: string, opts?: {
    method?: string;
    body?: unknown;
    cookie?: string | null;
    token?: string;
    headers?: Record<string, string>;
    ip?: string;
  }): Promise<ApiResult>;
}

export function createHarness(extra: Record<string, string> = {}): Harness {
  resetFamiliarLockout();
  const tracked: string[] = [];
  const revoked: RevokeCall[] = [];
  const flags = { failTrack: false };
  const bindings = {
    CLIENT_ORIGIN: "http://127.0.0.1:3000",
    TERMS_VERSION: "2026-10-01",
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
    JWT_ACCESS_SECRET: "test-only-access-secret-32chars-min",
    JWT_REFRESH_SECRET: "test-only-refresh-secret-32chars-min",
    WS_TICKET_SECRET: "test-only-ws-ticket-secret-32chars",
    GAME_ENCRYPTION_KEYS: "k0:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    GAME_ENCRYPTION_ACTIVE_KEY_ID: "k0",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    HYPERDRIVE: { connectionString: "postgresql://poker_app:local-only@127.0.0.1:5432/poker" },
    RL_GENERAL: allow(),
    RL_CREDENTIALS: allow(),
    RL_REFRESH: allow(),
    RL_ADMIN: allow(),
    RL_WS: allow(),
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
  });
  const app = new Hono<{ Bindings: Env }>();
  mountHttp(app);
  const harness: Harness = {
    db,
    config,
    tracked,
    revoked,
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
      const res = await app.request(`http://example.com/api${path}`, { method, headers, body }, env);
      const text = await res.text();
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      const setCookie = setCookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`)) ?? null;
      return {
        status: res.status,
        body: text ? JSON.parse(text) : null,
        headers: res.headers,
        setCookie,
        cookie: setCookie ? setCookie.split(";")[0]! : null,
      };
    },
  };
  return harness;
}

export const cookieOf = (refreshToken: string) => `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}`;
export const cleared = (result: ApiResult) => result.setCookie !== null && /Expires=Thu, 01 Jan 1970/.test(result.setCookie);
