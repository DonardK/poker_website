import { EngineError } from "@poker/engine";
import { REFRESH_COOKIE_NAME } from "@poker/shared";
import type { Context, Hono, Next } from "hono";
import { readEdgeConfig, type EdgeConfig, type Env } from "../env";
import { hashRefresh } from "../auth/sessions";
import { verifyAccessToken, verifyRefreshToken } from "../auth/tokens";
import { readCookie } from "./cookies";
import type { AppDb } from "./db";
import { clientIp, pathname, serviceUnavailable, type Ctx } from "./guard";
import { errBrief, logError, logInfo, logWarn } from "./log";
import { registerAdmin } from "./admin";
import { registerAuth } from "./auth";
import { registerTables } from "./tables";
import { registerWsTicket } from "./ws-ticket";

declare module "hono" {
  interface ContextVariableMap {
    requestId?: string;
    config?: EdgeConfig;
    db?: AppDb;
    userId?: string;
    username?: string;
    sessionId?: string;
    jsonBody?: unknown;
  }
}

const BODY_LIMIT = 32 * 1024;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CREDENTIAL_PATHS = new Set(["/api/auth/login", "/api/auth/register", "/api/auth/guest"]);
const TEST_DATABASE = Symbol.for("poker.edge.httpTestDatabase");

export function attachTestDatabase(env: object, db: AppDb): void {
  Object.defineProperty(env, TEST_DATABASE, { value: db, enumerable: false, configurable: true });
}

function testDatabase(env: Env): AppDb | null {
  const value = (env as Env & Record<symbol, AppDb | undefined>)[TEST_DATABASE];
  return value ?? null;
}

function isApi(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function isProbe(method: string, path: string): boolean {
  return method === "GET" && (path === "/api/health" || path === "/api/ready");
}

function isLobbyList(method: string, path: string): boolean {
  return method === "GET" && (path === "/api/tables" || path === "/api/tables/");
}

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

function hasBody(c: Ctx): boolean {
  if (c.req.header("transfer-encoding") !== undefined) return true;
  const length = c.req.header("content-length");
  return length !== undefined && Number(length) !== 0;
}

function applySecurityHeaders(c: Ctx): void {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-DNS-Prefetch-Control", "off");
  c.header("X-Download-Options", "noopen");
  c.header("X-Permitted-Cross-Domain-Policies", "none");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  const requestId = c.get("requestId");
  if (requestId) c.header("X-Request-Id", requestId);
}

function applyCache(c: Ctx, method: string, path: string): void {
  if (isLobbyList(method, path)) {
    c.header("Cache-Control", "private, no-cache");
    c.header("Vary", "Authorization");
  } else {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
  }
}

function reflectCors(c: Ctx): void {
  const config = c.get("config");
  if (!config) return;
  const origin = c.req.header("origin");
  if (!origin || origin !== config.clientOrigin) return;
  if (new URL(c.req.url).origin === config.clientOrigin) return;
  c.res.headers.set("Access-Control-Allow-Origin", config.clientOrigin);
  c.res.headers.set("Access-Control-Allow-Credentials", "true");
  c.res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  c.res.headers.append("Vary", "Origin");
}

async function readLimited(request: Request): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function outer(c: Ctx, next: Next): Promise<Response | void> {
  const path = pathname(c);
  if (!isApi(path)) {
    await next();
    return;
  }
  const started = Date.now();
  c.set("requestId", crypto.randomUUID());
  applySecurityHeaders(c);
  applyCache(c, c.req.method, path);
  if (isProbe(c.req.method, path)) {
    await next();
    return;
  }
  let config: EdgeConfig;
  try {
    config = readEdgeConfig(c.env);
  } catch (err) {
    logError({ ...errBrief(err), detail: err instanceof Error ? err.message : "config", path }, "edge config rejected");
    return c.json({ error: "Request could not be completed" }, 500);
  }
  c.set("config", config);
  const injected = testDatabase(c.env);
  let prisma: { $disconnect(): Promise<unknown> } | null = null;
  if (injected) {
    c.set("db", injected);
  } else {
    const connectionString = c.env.HYPERDRIVE?.connectionString;
    if (!connectionString) return serviceUnavailable(c);
    const { createPrisma } = await import("../db/client");
    const client = createPrisma(connectionString);
    prisma = client;
    c.set("db", client as unknown as AppDb);
  }
  try {
    await next();
    reflectCors(c);
    logInfo({
      requestId: c.get("requestId"),
      method: c.req.method,
      path: path.slice(0, 200),
      status: c.res.status,
      durationMs: Date.now() - started,
    }, "api request");
  } finally {
    if (prisma) {
      const pending = prisma.$disconnect().catch(() => undefined);
      if (typeof c.executionCtx?.waitUntil === "function") c.executionCtx.waitUntil(pending);
      else void pending;
    }
  }
}

function writeAdminLog(c: Ctx, method: string, path: string, started: number, status: number | null, completed: boolean): void {
  const entry = {
    audit: "ADMIN_REQUEST",
    method,
    path: path.slice(0, 200),
    ip: clientIp(c),
    userId: c.get("userId") ?? null,
    status: completed ? status : null,
    completed,
    durationMs: Date.now() - started,
  };
  const refused = !completed || (status != null && status >= 400);
  const message = !completed
    ? "admin request closed before its response completed"
    : refused
      ? "admin request refused or failed"
      : "admin request served";
  if (refused) logWarn(entry, message);
  else logInfo(entry, message);
}

async function adminAccessLog(c: Ctx, next: Next): Promise<void> {
  const path = pathname(c);
  if (!path.startsWith("/api/admin")) {
    await next();
    return;
  }
  const started = Date.now();
  try {
    await next();
    writeAdminLog(c, c.req.method, path, started, c.res.status, true);
  } catch (err) {
    writeAdminLog(c, c.req.method, path, started, 500, false);
    throw err;
  }
}

async function enforceLimit(c: Ctx, binding: RateLimit, key: string): Promise<Response | null> {
  try {
    const result = await binding.limit({ key });
    if (result.success) return null;
  } catch (err) {
    logWarn({ ...errBrief(err), path: pathname(c) }, "rate limit binding failed; answered 503");
    return serviceUnavailable(c);
  }
  c.header("Retry-After", "60");
  return c.json({ error: "Too many requests, please try again later." }, 429);
}

function ipKey(c: Ctx): string {
  return `ip:${clientIp(c) ?? "unknown"}`;
}

async function generalKey(c: Ctx): Promise<string> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length > 0 && token.length <= 4096) {
    try {
      const claims = await verifyAccessToken(c.get("config")!.jwtAccessSecret, token);
      return `user:${claims.sub}`;
    } catch {
      /* invalid or expired: count by IP */
    }
  }
  return ipKey(c);
}

async function refreshKey(c: Ctx): Promise<string> {
  const cookie = readCookie(c.req.header("cookie"), REFRESH_COOKIE_NAME);
  if (cookie && cookie.length > 0 && cookie.length <= 4096) {
    try {
      await verifyRefreshToken(c.get("config")!.jwtRefreshSecret, cookie);
      return `refresh:${await hashRefresh(cookie)}`;
    } catch {
      /* forged or expired: count by IP */
    }
  }
  return ipKey(c);
}

async function rateLimit(c: Ctx, next: Next): Promise<Response | void> {
  const path = pathname(c);
  const method = c.req.method;
  if (!isApi(path) || isProbe(method, path)) {
    await next();
    return;
  }
  const general = await enforceLimit(c, c.env.RL_GENERAL, await generalKey(c));
  if (general) return general;
  if (path.startsWith("/api/admin")) {
    const admin = await enforceLimit(c, c.env.RL_ADMIN, ipKey(c));
    if (admin) return admin;
  }
  if (method === "POST" && CREDENTIAL_PATHS.has(path)) {
    const credentials = await enforceLimit(c, c.env.RL_CREDENTIALS, ipKey(c));
    if (credentials) return credentials;
  }
  if (method === "POST" && path === "/api/auth/refresh") {
    const refresh = await enforceLimit(c, c.env.RL_REFRESH, await refreshKey(c));
    if (refresh) return refresh;
  }
  await next();
}

async function originAndBody(c: Ctx, next: Next): Promise<Response | void> {
  const path = pathname(c);
  const method = c.req.method;
  if (!isApi(path) || isProbe(method, path)) {
    await next();
    return;
  }
  if (SAFE_METHODS.has(method)) {
    if (method === "OPTIONS") {
      const origin = c.req.header("origin");
      const config = c.get("config");
      if (origin !== undefined && config && origin !== config.clientOrigin) {
        logWarn({ security: "CROSS_ORIGIN_REFUSED", reason: "origin", method, path: path.slice(0, 200) }, "refused state-changing request");
        return c.json({ error: "Cross-origin request refused" }, 403);
      }
      return c.body(null, 204);
    }
    c.set("jsonBody", undefined);
    await next();
    return;
  }
  const config = c.get("config");
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    if (!config || origin !== config.clientOrigin) {
      logWarn({ security: "CROSS_ORIGIN_REFUSED", reason: "origin", method, path: path.slice(0, 200) }, "refused state-changing request");
      return c.json({ error: "Cross-origin request refused" }, 403);
    }
  } else if ((c.req.header("sec-fetch-site") ?? "").toLowerCase() === "cross-site") {
    logWarn({ security: "CROSS_ORIGIN_REFUSED", reason: "fetch-site", method, path: path.slice(0, 200) }, "refused state-changing request");
    return c.json({ error: "Cross-origin request refused" }, 403);
  }
  if (hasBody(c) && mediaType(c.req.header("content-type")) !== "application/json") {
    logWarn({ security: "CROSS_ORIGIN_REFUSED", reason: "content-type", method, path: path.slice(0, 200) }, "refused state-changing request");
    return c.json({ error: "Content-Type must be application/json" }, 415);
  }
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > BODY_LIMIT) {
    logWarn({ class: "oversize", method, path: path.slice(0, 200) }, "request body rejected");
    return c.json({ error: "Request body too large" }, 413);
  }
  const bytes = await readLimited(c.req.raw);
  if (bytes === null) {
    logWarn({ class: "oversize", method, path: path.slice(0, 200) }, "request body rejected");
    return c.json({ error: "Request body too large" }, 413);
  }
  if (bytes.byteLength === 0) {
    c.set("jsonBody", undefined);
    await next();
    return;
  }
  if (mediaType(c.req.header("content-type")) !== "application/json") {
    logWarn({ class: "content-type", method, path: path.slice(0, 200) }, "request body rejected");
    return c.json({ error: "Unsupported request body encoding" }, 415);
  }
  try {
    c.set("jsonBody", JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    logWarn({ class: "malformed-json", method, path: path.slice(0, 200) }, "request body rejected");
    return c.json({ error: "Malformed request body" }, 400);
  }
  await next();
}

function onError(err: Error, c: Context<{ Bindings: Env }>): Response {
  const path = pathname(c).slice(0, 200);
  if (err instanceof EngineError) {
    logWarn({ errName: "EngineError", errCode: err.code, method: c.req.method, path }, "engine error");
    return c.json({ error: err.message }, 409);
  }
  logError({ ...errBrief(err), method: c.req.method, path }, "request failed");
  return c.json({ error: "Request could not be completed" }, 500);
}

/** Mount WP2 routes and the section 5.1 middleware. Health probes stay on the caller. */
export function mountHttp(app: Hono<{ Bindings: Env }>): void {
  app.use("*", outer);
  app.use("*", adminAccessLog);
  app.use("*", rateLimit);
  app.use("*", originAndBody);
  registerAuth(app);
  registerTables(app);
  registerAdmin(app);
  registerWsTicket(app);
  app.onError(onError);
}
