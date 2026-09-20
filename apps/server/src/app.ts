import { EngineError } from "@poker/engine";
import { logger } from "./logger.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { env } from "./config.js";
import { authRouter } from "./auth/routes.js";
import { healthRouter } from "./routes/health.js";
import { tablesRouter } from "./routes/tables.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", env.TRUST_PROXY_HOPS || false);
  app.use(helmet());
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

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "request failed");
    if (err instanceof EngineError) { res.status(409).json({ error: err.message }); return; }
    res.status(500).json({ error: "Request could not be completed" });
  });

  return app;
}
