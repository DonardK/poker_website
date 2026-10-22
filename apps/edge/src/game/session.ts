import type { SessionEndReason } from "@poker/shared";
import type { PrismaClient } from "../generated/prisma/client";

const ISSUER = "poker-server";
const END_REASONS: readonly SessionEndReason[] = [
  "LOGOUT", "LOGOUT_ALL", "SESSION_REVOKED", "PASSWORD_CHANGED", "REFRESH_REUSE", "EXPIRED", "ACCOUNT_RESTRICTED",
  "GUEST_RETIRED", "SECURITY_LOCKDOWN",
];

export type AuthErrorCode = "NO_TOKEN" | "INVALID_TOKEN" | "EXPIRED" | "REVOKED" | "USER_BLOCKED";

/** Credential failure. Database errors are never wrapped in this. */
export class AuthError extends Error {
  /** 4001 after SESSION_REVOKED. 4002 when the session row is missing on a mutating frame. */
  constructor(readonly code: AuthErrorCode, message?: string, readonly reason?: SessionEndReason, readonly closeAs: 4001 | 4002 = 4001) {
    super(message ?? code);
    this.name = "AuthError";
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

export function endReason(stored: string | null | undefined): SessionEndReason {
  return END_REASONS.includes(stored as SessionEndReason) ? stored as SessionEndReason : "SESSION_REVOKED";
}

export interface TicketClaims {
  sub: string;
  sid: string;
  username: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyHs256(token: string, secret: string, expected: { typ: string; aud: string }): Promise<Record<string, unknown>> {
  if (token.length < 1 || token.length > 4096) throw new AuthError("INVALID_TOKEN", "Invalid token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("INVALID_TOKEN", "Invalid token");
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  let header: { alg?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart))) as { alg?: unknown };
  } catch {
    throw new AuthError("INVALID_TOKEN", "Invalid token");
  }
  if (header.alg !== "HS256") throw new AuthError("INVALID_TOKEN", "Invalid token");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(sigPart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  if (!ok) throw new AuthError("INVALID_TOKEN", "Invalid token");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart))) as Record<string, unknown>;
  } catch {
    throw new AuthError("INVALID_TOKEN", "Invalid token");
  }
  if (claims.iss !== ISSUER || claims.aud !== expected.aud || claims.typ !== expected.typ) throw new AuthError("INVALID_TOKEN", "Invalid token");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
    throw new AuthError("EXPIRED", "Invalid token");
  }
  return claims;
}

/** poker_ws compact JWS. Expired or malformed tickets are credential failures. */
export async function verifyWsTicket(token: string, secret: string): Promise<TicketClaims> {
  const claims = await verifyHs256(token, secret, { typ: "ws", aud: "poker-ws" });
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.sid !== "string" || !claims.sid || typeof claims.username !== "string") {
    throw new AuthError("INVALID_TOKEN", "Invalid token");
  }
  return { sub: claims.sub, sid: claims.sid, username: claims.username };
}

/** Access token presented on SESSION_RENEW. The shape matches the Node server. */
export async function verifyAccessToken(token: string, secret: string): Promise<TicketClaims> {
  const claims = await verifyHs256(token, secret, { typ: "access", aud: "poker-client" });
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.sid !== "string" || !claims.sid || typeof claims.username !== "string") {
    throw new AuthError("INVALID_TOKEN", "Invalid token");
  }
  return { sub: claims.sub, sid: claims.sid, username: claims.username };
}

export interface LiveSession {
  sessionId: string;
  userId: string;
  username: string;
}

/**
 * Re-read the session row. Throws AuthError only for a dead session.
 * A database failure propagates so the caller can answer retryable.
 */
export async function assertLiveSession(prisma: PrismaClient, sessionId: string, userId: string): Promise<LiveSession> {
  const row = await prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
  if (!row || row.userId !== userId) throw new AuthError("REVOKED", "Session not found", "SESSION_REVOKED", 4002);
  if (row.revokedAt) throw new AuthError("REVOKED", "Session revoked", endReason(row.revokeReason));
  const now = Date.now();
  if (row.expiresAt.getTime() <= now || row.absoluteExpiresAt.getTime() <= now) {
    throw new AuthError("EXPIRED", "Session expired", "EXPIRED");
  }
  if (row.user.kind !== "HUMAN") throw new AuthError("USER_BLOCKED", "Account cannot sign in", "ACCOUNT_RESTRICTED");
  // Guest play was retired (2026-10); the migration revoked guest sessions, this is the second line.
  if (row.user.isGuest) throw new AuthError("USER_BLOCKED", "Account cannot sign in", "GUEST_RETIRED");
  return { sessionId: row.id, userId: row.userId, username: row.user.username };
}

/** Sign a compact HS256 JWS. Tests and local tools use this; WP2 signs with jose, same bytes. */
export async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${bytesToBase64Url(sig)}`;
}
