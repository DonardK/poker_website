import { jwtVerify } from "jose";
import type { SessionEndReason } from "@poker/shared";
import type { PrismaClient } from "../generated/prisma/client";

const ISSUER = "poker-server";
const END_REASONS: readonly SessionEndReason[] = [
  "LOGOUT",
  "LOGOUT_ALL",
  "SESSION_REVOKED",
  "PASSWORD_CHANGED",
  "REFRESH_REUSE",
  "EXPIRED",
  "ACCOUNT_RESTRICTED",
  "GUEST_RETIRED",
  "SECURITY_LOCKDOWN",
];

export interface WsIdentity {
  userId: string;
  sessionId: string;
  username: string;
}

export type SessionVerdict =
  | { ok: true; identity: WsIdentity }
  | { ok: false; action: "revoke"; reason: SessionEndReason }
  | { ok: false; action: "unavailable" };

/** HttpOnly `poker_ws` (or any other cookie) from a raw Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function endReason(stored: string | null | undefined): SessionEndReason {
  return stored && (END_REASONS as readonly string[]).includes(stored) ? (stored as SessionEndReason) : "SESSION_REVOKED";
}

function claimString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

async function verifyHs256(
  token: string,
  secret: string,
  audience: "poker-ws" | "poker-client",
  typ: "ws" | "access",
): Promise<{ sub: string; sid: string; username: string } | null> {
  if (token.length < 1 || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience,
    });
    if (payload.typ !== typ) return null;
    const sub = claimString(payload.sub, 128);
    const sid = claimString(payload.sid, 128);
    const username = claimString(payload.username, 64);
    if (!sub || !sid || !username) return null;
    return { sub, sid, username };
  } catch {
    return null;
  }
}

/** `poker_ws` compact JWS. Any failure is a credential failure (no database). */
export function verifyWsTicket(token: string, secret: string): Promise<{ sub: string; sid: string; username: string } | null> {
  return verifyHs256(token, secret, "poker-ws", "ws");
}

/** Access JWT presented on SESSION_RENEW. Failures are credential failures. */
export function verifyAccessToken(token: string, secret: string): Promise<{ sub: string; sid: string; username: string } | null> {
  return verifyHs256(token, secret, "poker-client", "access");
}

/**
 * Session row check matching `authenticate()`: revoked, idle expiry,
 * absolute expiry, HUMAN kind, and no retired guest account. Database errors are
 * `unavailable` so the caller answers retryable, never "signed out".
 */
export async function loadSession(prisma: PrismaClient, sub: string, sessionId: string): Promise<SessionVerdict> {
  try {
    const row = await prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
    if (!row || row.userId !== sub) return { ok: false, action: "revoke", reason: "SESSION_REVOKED" };
    if (row.revokedAt) return { ok: false, action: "revoke", reason: endReason(row.revokeReason) };
    const now = Date.now();
    if (row.expiresAt.getTime() <= now || row.absoluteExpiresAt.getTime() <= now) {
      return { ok: false, action: "revoke", reason: "EXPIRED" };
    }
    if (row.user.kind !== "HUMAN") return { ok: false, action: "revoke", reason: "ACCOUNT_RESTRICTED" };
    // Guest play was retired (2026-10); the migration revoked guest sessions, this is the second line.
    if (row.user.isGuest) return { ok: false, action: "revoke", reason: "GUEST_RETIRED" };
    return { ok: true, identity: { userId: row.user.id, sessionId: row.id, username: row.user.username } };
  } catch {
    return { ok: false, action: "unavailable" };
  }
}
