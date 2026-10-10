import { Router } from "express";
import { redisEnabled } from "../config.js";
import { prisma } from "../db/prisma.js";
import { createReadiness, type Readiness } from "../security/readiness.js";

/**
 * The process-wide readiness state. index.ts marks the schema check and table
 * recovery as done and starts draining on SIGTERM/SIGINT.
 */
export const readiness: Readiness = createReadiness({ probeDatabase: () => prisma.$queryRaw`SELECT 1` });

/**
 * GET /api/health: liveness. No database access, so a database outage does
 * not get healthy processes restarted.
 * GET /api/ready: readiness, 200 {ready:true} or 503 {ready:false, reasons}.
 * Both are no-store (app.ts) and exempt from the TLS gate and the general
 * rate limit so load-balancer probes always get an answer.
 */
export function createHealthRouter(state: Readiness = readiness): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "poker-server",
      redis: redisEnabled ? "configured" : "disabled",
      timestamp: new Date().toISOString(),
    });
  });
  router.get("/ready", async (_req, res) => {
    const result = await state.check();
    if (result.ready) res.json({ ready: true });
    else res.status(503).json({ ready: false, reasons: result.reasons });
  });
  return router;
}

export const healthRouter = createHealthRouter();
