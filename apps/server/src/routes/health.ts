import { Router } from "express";
import { redisEnabled } from "../config.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "poker-server",
    redis: redisEnabled ? "configured" : "disabled",
    timestamp: new Date().toISOString(),
  });
});
