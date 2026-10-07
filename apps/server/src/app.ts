import { EngineError } from "@poker/engine";
import { REFRESH_COOKIE_NAME } from "@poker/shared";
import { logger as defaultLogger } from "./logger.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { env, isProd, proxyTrust } from "./config.js";
import { authRouter } from "./auth/routes.js";
import { verifyAccessToken, verifyRefreshToken } from "./auth/jwt.js";
import { adminRouter } from "./routes/admin.js";
import { adminAccessLog } from "./routes/admin-access-log.js";
import { createHealthRouter } from "./routes/health.js";
import { tablesRouter } from "./routes/tables.js";
import { createRateLimiters } from "./security/rate-limits.js";
import type { Readiness } from "./security/readiness.js";
import { requestGuard } from "./security/request-guard.js";
import { bodyParserStatus, isBodyParserError, serializeError } from "./security/safe-log.js";
import { expressTrustProxy, isSecureTransport } from "./transport.js";

export interface AppOptions {
  /** Logger for access/error logs (tests pass one that captures output). */
  logger?: Logger;
  /** Readiness state behind GET /api/ready (defaults to the process-wide one). */
  readiness?: Readiness;
}

/** The full request path without the query (req.path is relative to the mount point inside app.use("/api", ...)). */
const fullPath = (req: express.Request): string => req.originalUrl.split("?")[0]!;
/** Load-balancer probes: no TLS requirement, no general rate limit, never cached. */
const isProbe = (req: express.Request): boolean => req.method === "GET" && ["/api/health", "/api/ready"].includes(fullPath(req));
/** The lobby list may be revalidated by the browser (ETag/304); everything else under /api is no-store. */
const isLobbyList = (req: express.Request): boolean => req.method === "GET" && ["/api/tables", "/api/tables/"].includes(fullPath(req));
const CREDENTIAL_PATHS = ["/api/auth/login", "/api/auth/register", "/api/auth/guest"];

export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? defaultLogger;
  const app = express();
  // SECURITY: X-Forwarded-For/Proto are honoured only from peers inside
  // TRUSTED_PROXY_CIDRS (within TRUST_PROXY_HOPS), so req.ip, which keys the
  // rate limits and the admin access log, cannot be forged by a direct client.
  app.set("trust proxy", expressTrustProxy(proxyTrust));
  // COMPLIANCE (audit access logging): first, so every /api/admin request is
  // logged with its outcome, including TLS (426) and rate-limit (429) refusals.
  app.use("/api/admin", adminAccessLog(logger));
  // helmet's defaults include Strict-Transport-Security (max-age 365 days, includeSubDomains).
  app.use(helmet());
  // SECURITY (caching): API responses carry tokens, balances and private
  // table state; no browser or intermediary may store them. Set before any
  // other middleware so refusals (426, 403, 415, 429, 400) are covered too.
  // The lobby list is private to the user but may be revalidated (ETag/304).
  app.use("/api", (req, res, next) => {
    if (isLobbyList(req)) res.set({ "Cache-Control": "private, no-cache", Vary: "Authorization" });
    else res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    next();
  });
  // COMPLIANCE (TLS): in production every request except the load-balancer
  // probes must arrive over TLS (directly or via a trusted TLS proxy).
  // Plain HTTP is refused, not redirected, so no API payload is ever served in cleartext.
  if (isProd) {
    app.use((req, res, next) => {
      if (isProbe(req) || isSecureTransport(req, proxyTrust)) { next(); return; }
      res.status(426).set({ Upgrade: "TLS/1.2, HTTP/1.1", Connection: "Upgrade" }).json({ error: "HTTPS is required" });
    });
  }
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  // Cookies are needed by the refresh limiter's key; parsing them is cheap and reads no body.
  app.use(cookieParser());
  // SECURITY (rate limits before body parsing): a malformed or oversized body
  // used to be rejected by express.json before any limiter ran, so it was
  // never counted. Every limiter now runs first (see security/rate-limits.ts).
  const limiters = createRateLimiters({ verifyAccessToken, verifyRefreshToken, refreshCookieName: REFRESH_COOKIE_NAME, skipGeneral: isProbe });
  app.use(limiters.general);
  // Mounted through the router (not a string comparison) so the limiters match
  // exactly what the auth routes match: case-insensitive, optional trailing slash.
  app.post(CREDENTIAL_PATHS, limiters.credentials);
  app.post("/api/auth/refresh", limiters.refresh);
  // SECURITY (CSRF / cross-origin writes): refused before the body is parsed.
  app.use("/api", requestGuard({
    clientOrigin: env.CLIENT_ORIGIN,
    contentTypeExemptPrefixes: ["/api/payments/webhooks/"],
    onRefused: (reason, req) => logger.warn({ security: "CROSS_ORIGIN_REFUSED", reason, method: req.method, path: fullPath(req).slice(0, 200) }, "refused state-changing request"),
  }));
  app.use(express.json({ limit: "32kb" }));

  app.use("/api", createHealthRouter(options.readiness));
  app.use("/api/auth", authRouter);
  app.use("/api/tables", tablesRouter);
  app.use("/api/admin", adminRouter);

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const path = fullPath(req).slice(0, 200);
    // SECURITY: a body-parser failure is the client's malformed, oversized or
    // mis-encoded body. Its message and `body` property quote the raw input
    // (passwords included), so only its type and status are logged or sent.
    if (isBodyParserError(err)) {
      const status = bodyParserStatus(err);
      logger.warn({ request: { type: err.type, status, method: req.method, path } }, "request body rejected");
      res.status(status).json({ error: status === 413 ? "Request body too large" : status === 415 ? "Unsupported request body encoding" : "Malformed request body" });
      return;
    }
    // Allow-list serializer: name, code, a scrubbed message; stack outside production only.
    logger.error({ err: serializeError(err, !isProd), method: req.method, path }, "request failed");
    if (err instanceof EngineError) { res.status(409).json({ error: err.message }); return; }
    res.status(500).json({ error: "Request could not be completed" });
  });

  return app;
}
