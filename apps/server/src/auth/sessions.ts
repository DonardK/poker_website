import type { SessionEndReason } from "@poker/shared";
import type { Session, User } from "@prisma/client";
import { authConfig } from "../config.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../logger.js";

/**
 * After a rotation, the token it replaced is still accepted for this long
 * (answered with a fresh access token, never rotated again): two tabs, or a
 * retried request whose response was lost, refresh with the same cookie at
 * about the same time and must not sign each other out. Any later use of a
 * replaced token is treated as theft (see the refresh route).
 */
export const REFRESH_GRACE_MS = 15_000;
/**
 * Positive per-session authentication cache. Every socket packet and every
 * table broadcast re-checks the viewer's session; this bounds the database
 * load to one lookup per session per window. Only successes are cached, a
 * revocation in this process clears its entries at once, and the socket
 * layer disconnects a revoked session's sockets cluster-wide immediately, so
 * the window only matters for a revocation made by ANOTHER server process
 * reaching a packet here: it is honoured within this bound.
 */
export const AUTH_CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Lifetime: one expiry for the cookie, the row and the refresh JWT.
// ---------------------------------------------------------------------------

/** The session expiry after a sign-in or refresh at `now`: the idle TTL, never past the absolute expiry. */
export function sessionExpiry(now: number, absoluteExpiresAt: Date): Date {
  return new Date(Math.min(now + authConfig.sessionIdleTtlMs, absoluteExpiresAt.getTime()));
}
/** Lifetime of a session created at `now`. */
export function newSessionLifetime(now: number): { absoluteExpiresAt: Date; expiresAt: Date } {
  const absoluteExpiresAt = new Date(now + authConfig.sessionAbsoluteTtlMs);
  return { absoluteExpiresAt, expiresAt: sessionExpiry(now, absoluteExpiresAt) };
}

// ---------------------------------------------------------------------------
// Authentication cache (see AUTH_CACHE_TTL_MS).
// ---------------------------------------------------------------------------

interface CachedSession { userId: string; user: User; session: Session; expiresAt: number; cachedAt: number }
const cache = new Map<string, CachedSession>();
/**
 * Bumped by every revocation. A lookup that started before a revocation
 * finished must not cache what it read (it may have read the row just before
 * it was revoked), so callers capture the epoch before reading.
 */
let epoch = 0;

export function authEpoch(): number { return epoch; }
/** A fresh cached success for this session and user, or null. A clock that moved backwards (mocked or adjusted) invalidates the entry. */
export function cachedSession(sessionId: string, userId: string, now: number): CachedSession | null {
  const hit = cache.get(sessionId);
  if (!hit) return null;
  const age = now - hit.cachedAt;
  if (age < 0 || age >= AUTH_CACHE_TTL_MS || hit.userId !== userId || hit.expiresAt <= now || (hit.session.absoluteExpiresAt != null && hit.session.absoluteExpiresAt.getTime() <= now)) { cache.delete(sessionId); return null; }
  return hit;
}
export function rememberSession(sessionId: string, user: User, session: Session, now: number, startedAtEpoch: number): void {
  if (startedAtEpoch !== epoch) return;
  cache.set(sessionId, { userId: user.id, user, session, expiresAt: session.expiresAt.getTime(), cachedAt: now });
}
/** Tests and administrative tools: forget every cached success. */
export function clearAuthCache(): void { cache.clear(); epoch += 1; }
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, hit] of cache) if (now - hit.cachedAt >= AUTH_CACHE_TTL_MS || now < hit.cachedAt) cache.delete(id);
}, 30_000);
sweep.unref();

// ---------------------------------------------------------------------------
// Revocation. Rows are kept with revokedAt/revokeReason (audit trail); a
// revoked row never authenticates or refreshes again.
// ---------------------------------------------------------------------------

export type SessionsRevokedListener = (sessionIds: string[], reason: SessionEndReason) => void;
const listeners = new Set<SessionsRevokedListener>();

/** Called after sessions are revoked (in this process). Returns the unsubscribe function. */
export function onSessionsRevoked(listener: SessionsRevokedListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function announce(sessionIds: string[], reason: SessionEndReason): void {
  epoch += 1;
  for (const id of sessionIds) cache.delete(id);
  for (const listener of listeners) {
    try { listener(sessionIds, reason); } catch (err) { logger.error({ err, reason }, "session revocation listener failed"); }
  }
}

/**
 * Revoke one session. Returns whether this call revoked it (false: unknown or
 * already revoked). Listeners run either way, so a socket that somehow
 * outlived an earlier revocation is still disconnected.
 */
export async function revokeSession(sessionId: string, reason: SessionEndReason): Promise<boolean> {
  const { count } = await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  announce([sessionId], reason);
  return count === 1;
}

/** Revoke every live session of a user (optionally all but one) in one statement. Returns how many were revoked. */
export async function revokeUserSessions(userId: string, reason: SessionEndReason, opts: { exceptSessionId?: string } = {}): Promise<number> {
  const revoked = await prisma.session.updateManyAndReturn({
    where: { userId, revokedAt: null, ...(opts.exceptSessionId ? { id: { not: opts.exceptSessionId } } : {}) },
    data: { revokedAt: new Date(), revokeReason: reason },
    select: { id: true },
  });
  if (revoked.length) announce(revoked.map((row) => row.id), reason);
  return revoked.length;
}

const END_REASONS: readonly SessionEndReason[] = ["LOGOUT", "LOGOUT_ALL", "SESSION_REVOKED", "PASSWORD_CHANGED", "REFRESH_REUSE", "EXPIRED", "ACCOUNT_RESTRICTED"];
/** A stored revokeReason as a wire reason (anything unexpected reads as a generic revocation). */
export function endReason(stored: string | null | undefined): SessionEndReason {
  return END_REASONS.includes(stored as SessionEndReason) ? stored as SessionEndReason : "SESSION_REVOKED";
}
