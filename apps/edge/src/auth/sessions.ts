import type { SessionEndReason } from "@poker/shared";
import type { AppDb } from "../http/db";

export const REFRESH_GRACE_MS = 15_000;

export async function hashRefresh(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Idle TTL, never past the absolute expiry. One instant for the cookie, the row, and the refresh JWT. */
export function sessionExpiry(now: number, absoluteExpiresAt: Date, idleMs: number): Date {
  return new Date(Math.min(now + idleMs, absoluteExpiresAt.getTime()));
}

/**
 * "Keep me signed in" unticked: a browser-session cookie, and the row ends
 * after 12 h without use or 24 h in all. The absolute cap matters because
 * browser session-restore keeps "session" cookies alive.
 */
export const NON_PERSISTENT_IDLE_MS = 12 * 3_600_000;
export const NON_PERSISTENT_ABSOLUTE_MS = 24 * 3_600_000;

/** The idle period for a session: the configured one, or 12 h (at most) when not persistent. */
export function idleTtlMs(configuredIdleMs: number, persistent: boolean): number {
  return persistent ? configuredIdleMs : Math.min(configuredIdleMs, NON_PERSISTENT_IDLE_MS);
}

export function newSessionLifetime(now: number, idleMs: number, absoluteMs: number, persistent = true): { absoluteExpiresAt: Date; expiresAt: Date } {
  const absoluteExpiresAt = new Date(now + (persistent ? absoluteMs : Math.min(absoluteMs, NON_PERSISTENT_ABSOLUTE_MS)));
  return { absoluteExpiresAt, expiresAt: sessionExpiry(now, absoluteExpiresAt, idleTtlMs(idleMs, persistent)) };
}

const END_REASONS: readonly SessionEndReason[] = [
  "LOGOUT", "LOGOUT_ALL", "SESSION_REVOKED", "PASSWORD_CHANGED", "REFRESH_REUSE", "EXPIRED", "ACCOUNT_RESTRICTED",
  "GUEST_RETIRED", "SECURITY_LOCKDOWN",
];

export function endReason(stored: string | null | undefined): SessionEndReason {
  return END_REASONS.includes(stored as SessionEndReason) ? stored as SessionEndReason : "SESSION_REVOKED";
}

export async function revokeSession(db: AppDb, sessionId: string, reason: SessionEndReason): Promise<boolean> {
  const { count } = await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
  return count === 1;
}

/** Revoke every live session of a user (optionally all but one). Returns the revoked ids. */
export async function revokeUserSessions(db: AppDb, userId: string, reason: SessionEndReason, opts: { exceptSessionId?: string } = {}): Promise<string[]> {
  const revoked = await db.session.updateManyAndReturn({
    where: { userId, revokedAt: null, ...(opts.exceptSessionId ? { id: { not: opts.exceptSessionId } } : {}) },
    data: { revokedAt: new Date(), revokeReason: reason },
    select: { id: true },
  });
  return revoked.map((row: { id: string }) => row.id);
}
