import { EngineError } from "@poker/engine";
import { logger } from "./logger.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { env, isProd } from "./config.js";
import { authRouter } from "./auth/routes.js";
import { adminRouter } from "./routes/admin.js";
import { adminAccessLog } from "./routes/admin-access-log.js";
import { healthRouter } from "./routes/health.js";
import { tablesRouter } from "./routes/tables.js";
import { isSecureTransport } from "./transport.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", env.TRUST_PROXY_HOPS || false);
  // COMPLIANCE (audit access logging): first, so every /api/admin request is
  // logged with its outcome, including TLS (426) and rate-limit (429) refusals.
  app.use("/api/admin", adminAccessLog(logger));
  // helmet's defaults include Strict-Transport-Security (max-age 365 days, includeSubDomains).
  app.use(helmet());
  // COMPLIANCE (TLS): in production every request except the load-balancer
  // health probe must arrive over TLS (directly or via a trusted TLS proxy).
  // Plain HTTP is refused, not redirected, so no API payload is ever served in cleartext.
  if (isProd) {
    app.use((req, res, next) => {
      if ((req.method === "GET" && req.path === "/api/health") || isSecureTransport(req, env.TRUST_PROXY_HOPS)) { next(); return; }
      res.status(426).set({ Upgrade: "TLS/1.2, HTTP/1.1", Connection: "Upgrade" }).json({ error: "HTTPS is required" });
    });
  }
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.use("/api", healthRouter);
  app.use("/api/auth", rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false }), authRouter);
  app.use("/api/tables", tablesRouter);
  app.use("/api/admin", adminRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "request failed");
    if (err instanceof EngineError) { res.status(409).json({ error: err.message }); return; }
    res.status(500).json({ error: "Request could not be completed" });
  });

  return app;
}
