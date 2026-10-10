import type { NextFunction, Request, Response } from "express";
import type { Session, User } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../logger.js";
import { AuthError, isAuthError } from "./errors.js";
import { verifyAccessToken, type AccessClaims } from "./jwt.js";
import { authEpoch, cachedSession, endReason, rememberSession } from "./sessions.js";

export interface AuthedRequest extends Request { userId?: string; username?: string; sessionId?: string }
export interface Authenticated { claims: AccessClaims; user: User; session: Session }

/**
 * Verify an access token and its session. Throws AuthError ONLY for
 * credential problems (bad or expired token; missing, expired or revoked
 * session; a non-HUMAN user). A database failure propagates unchanged: the
 * caller answers "try again" (503 / SERVICE_UNAVAILABLE), never "signed out".
 * Successes are cached per session for AUTH_CACHE_TTL_MS (sessions.ts).
 */
export async function authenticate(token: unknown): Promise<Authenticated> {
  if (typeof token !== "string" || token.length === 0) throw new AuthError("NO_TOKEN", "Unauthorized");
  const claims = verifyAccessToken(token);
  const now = Date.now();
  const hit = cachedSession(claims.sid, claims.sub, now);
  if (hit) return { claims, user: hit.user, session: hit.session };
  const startedAt = authEpoch();
  const row = await prisma.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!row || row.userId !== claims.sub) throw new AuthError("REVOKED", "Session not found", "SESSION_REVOKED");
  if (row.revokedAt) throw new AuthError("REVOKED", "Session revoked", endReason(row.revokeReason));
  // Idle expiry and the absolute lifetime are both fatal. Refresh already
  // refuses a row whose idle expiry was pushed past absoluteExpiresAt; access
  // tokens must stop at the same instant, or a stolen access token keeps
  // working after the session's hard end.
  if (row.expiresAt.getTime() <= now || (row.absoluteExpiresAt != null && row.absoluteExpiresAt.getTime() <= now)) throw new AuthError("EXPIRED", "Session expired", "EXPIRED");
  if (row.user.kind !== "HUMAN") throw new AuthError("USER_BLOCKED", "Account cannot sign in", "ACCOUNT_RESTRICTED");
  const { user, ...session } = row;
  rememberSession(claims.sid, user, session, now, startedAt);
  return { claims, user, session };
}

/** 503 for a temporary failure: the request may be retried and the session is still valid. */
export function serviceUnavailable(res: Response): void {
  res.status(503).set("Retry-After", "2").json({ error: "Service temporarily unavailable, please retry", retryable: true });
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  let authed: Authenticated;
  try {
    authed = await authenticate(token);
  } catch (err) {
    if (isAuthError(err)) { res.status(401).json({ error: "Unauthorized" }); return; }
    logger.warn({ err, path: req.path }, "authentication unavailable; answered 503");
    serviceUnavailable(res);
    return;
  }
  req.userId = authed.claims.sub; req.username = authed.claims.username; req.sessionId = authed.claims.sid;
  next();
}
export async function loadUser(userId: string) { return prisma.user.findUnique({ where: { id: userId } }); }
