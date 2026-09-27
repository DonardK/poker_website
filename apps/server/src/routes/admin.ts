/**
 * Regulator / operator audit access.
 *
 * COMPLIANCE NOTES
 * - Access log: app.ts mounts `adminAccessLog` (admin-access-log.ts) on
 *   /api/admin before any other middleware. Every request to this router,
 *   and every request to /api/admin refused before it (TLS 426, rate limit
 *   429), is logged once with method, path, client IP, user id (once
 *   authenticated) and HTTP status, including 401 (no or bad token), 403,
 *   429 and errors.
 * - Every route requires an authenticated session and role ADMIN, read from
 *   the database user row on each request (a revoked role takes effect
 *   immediately; token claims are not trusted for the role). A refused ADMIN
 *   check is also logged as a security event (ADMIN_DENIED), and each read of
 *   a hand audit as REGULATOR_HAND_AUDIT_ACCESS with the requested hand UUID.
 * - The router is rate-limited: 30 requests per minute per client IPv4
 *   address or IPv6 /56 (express-rate-limit's default key).
 * - GET /hands/:handUuid/audit returns the full sealed record (deck order and
 *   salts) together with the independent verification report
 *   (`regulatorVerification`): row binding, card integrity with the hole
 *   cards and burns derived from the committed deck, the outcome replay and
 *   the per-table chain link. A failed report is logged as AUDIT_INTEGRITY.
 *   This data never goes to players; see the participant route in tables.ts
 *   for that.
 */
import { Router, type NextFunction, type Response } from "express";
import rateLimit from "express-rate-limit";
import { UUID_V4, type HandAuditRecord, type SealedHandAudit } from "@poker/shared";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import { prisma } from "../db/prisma.js";
import { regulatorVerification, sealedAuditContext } from "../game/audit.js";
import { decryptState } from "../game/encryption.js";
import { logger } from "../logger.js";

export const adminRouter = Router();

async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const user = req.userId ? await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } }) : null;
  if (user?.role !== "ADMIN") {
    logger.warn({ security: "ADMIN_DENIED", userId: req.userId, method: req.method, path: req.originalUrl.slice(0, 200) }, "admin route denied");
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

adminRouter.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/hands/:handUuid/audit", async (req: AuthedRequest, res) => {
  res.set("Cache-Control", "no-store");
  const handUuid = String(req.params.handUuid).toLowerCase();
  logger.info({ audit: "REGULATOR_HAND_AUDIT_ACCESS", userId: req.userId, handUuid: handUuid.slice(0, 64) }, "regulator hand audit accessed");
  if (!UUID_V4.test(handUuid)) { res.status(400).json({ error: "handUuid must be a UUID v4" }); return; }
  const hand = await prisma.hand.findUnique({
    where: { handUuid },
    select: { tableId: true, handNumber: true, handUuid: true, deckCommitment: true, finalStateHash: true, auditRecord: true, auditSealed: true },
  });
  if (!hand) { res.status(404).json({ error: "Hand not found" }); return; }
  if (!hand.auditRecord || !hand.auditSealed) { res.status(409).json({ error: "This hand predates the compliance audit trail" }); return; }
  const record = hand.auditRecord as unknown as HandAuditRecord;
  let sealed: SealedHandAudit;
  try {
    sealed = decryptState<SealedHandAudit>(hand.auditSealed, sealedAuditContext(hand.tableId, hand.handNumber));
  } catch (err) {
    logger.error({ err, security: "AUDIT_INTEGRITY", userId: req.userId, handUuid }, "sealed hand audit failed authenticated decryption");
    res.status(500).json({ error: "Sealed audit failed authenticated decryption" });
    return;
  }
  // Per-table chain: the most recent EARLIER hand of this table that has a final state hash.
  const previous = await prisma.hand.findFirst({
    where: { tableId: hand.tableId, handNumber: { lt: hand.handNumber }, finalStateHash: { not: null } },
    orderBy: { handNumber: "desc" },
    select: { handNumber: true, finalStateHash: true },
  });
  const verification = await regulatorVerification(hand, record, sealed,
    previous && previous.finalStateHash !== null ? { handNumber: previous.handNumber, finalStateHash: previous.finalStateHash } : null);
  if (!verification.ok) {
    logger.error({
      security: "AUDIT_INTEGRITY", userId: req.userId, handUuid, reason: verification.reason,
      outcome: verification.outcome.ok, tableChain: verification.tableChain.ok, previousHandNumber: verification.tableChain.previousHandNumber,
    }, "stored hand audit failed regulator verification");
  }
  res.json({ record, sealed, verification });
});
