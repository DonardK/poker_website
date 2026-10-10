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
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    absoluteExpiresAt: Date | null;
    revokedAt: Date | null;
    revokeReason: string | null;
  };
}

/**
 * Verify an access token and its session row. AuthError only for credential
 * problems. A database failure propagates unchanged (HTTP 503, not 401).
 * Session rows are not cached across requests.
 */
export async function authenticate(db: AppDb, token: unknown, config: EdgeConfig): Promise<Authenticated> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) throw new AuthError("NO_TOKEN", "Unauthorized");
  const claims = await verifyAccessToken(config.jwtAccessSecret, token);
  const now = Date.now();
  const row = await db.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!row || row.userId !== claims.sub || !row.user) throw new AuthError("REVOKED", "Session not found", "SESSION_REVOKED");
  if (row.revokedAt) throw new AuthError("REVOKED", "Session revoked", endReason(row.revokeReason));
  if (row.expiresAt.getTime() <= now || (row.absoluteExpiresAt != null && new Date(row.absoluteExpiresAt).getTime() <= now)) {
    throw new AuthError("EXPIRED", "Session expired", "EXPIRED");
  }
  if (row.user.kind !== "HUMAN") throw new AuthError("USER_BLOCKED", "Account cannot sign in", "ACCOUNT_RESTRICTED");
  const { user, ...session } = row;
  return { claims, user, session };
}
