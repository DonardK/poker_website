import type { EdgeConfig } from "../env";
import type { AppDb } from "../http/db";
import { AuthError } from "./errors";
import { endReason } from "./sessions";
import { verifyAccessToken, type AccessClaims } from "./tokens";

export interface Authenticated {
  claims: AccessClaims;
  user: {
    id: string;
    username: string;
    email: string | null;
    isGuest: boolean;
    role: "PLAYER" | "ADMIN";
    kind: "HUMAN" | "BOT";
    botProfile: string | null;
    bankroll: number;
    avatarHue: number;
    passwordHash: string | null;
    failedLoginCount: number;
    lockedUntil: Date | null;
    // Account security (migration 20261019100000_account_security).
    emailVerifiedAt: Date | null;
    credentialsVersion: number;
    passwordChangedAt: Date | null;
    passwordResetRequired: boolean;
    mfaFailedCount: number;
    mfaLockedUntil: Date | null;
    securityHoldUntil: Date | null;
    webauthnUserId: string | null;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    absoluteExpiresAt: Date | null;
    revokedAt: Date | null;
    revokeReason: string | null;
    deviceId: string | null;
    persistent: boolean;
    authMethods: string[];
    reauthAt: Date | null;
    reauthMethods: string[];
  };
}

/**
 * Verify an access token and its session row. AuthError only for credential
 * problems. A database failure propagates unchanged (HTTP 503, not 401).
 * Session rows are not cached across requests. Guest accounts were retired
 * (2026-10): a guest session is refused here even if it was never revoked.
 */
export async function authenticate(db: AppDb, token: unknown, config: EdgeConfig): Promise<Authenticated> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) throw new AuthError("NO_TOKEN", "Unauthorized");
  const claims = await verifyAccessToken(config.jwtAccessSecret, token);
  const now = Date.now();
  const row = await db.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!row || row.userId !== claims.sub || !row.user) throw new AuthError("REVOKED", "Session not found", "SESSION_REVOKED");
  if (row.revokedAt) throw new AuthError("REVOKED", "Session revoked", endReason(row.revokeReason));
  if (new Date(row.expiresAt).getTime() <= now || (row.absoluteExpiresAt != null && new Date(row.absoluteExpiresAt).getTime() <= now)) {
    throw new AuthError("EXPIRED", "Session expired", "EXPIRED");
  }
  if (row.user.kind !== "HUMAN") throw new AuthError("USER_BLOCKED", "Account cannot sign in", "ACCOUNT_RESTRICTED");
  if (row.user.isGuest) throw new AuthError("USER_BLOCKED", "Account cannot sign in", "GUEST_RETIRED");
  const { user, ...session } = row;
  return {
    claims,
    user,
    session: {
      ...session,
      persistent: session.persistent !== false,
      authMethods: Array.isArray(session.authMethods) ? session.authMethods : [],
      reauthMethods: Array.isArray(session.reauthMethods) ? session.reauthMethods : [],
    },
  };
}
