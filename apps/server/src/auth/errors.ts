import { Prisma } from "@prisma/client";
import type { SessionEndReason } from "@poker/shared";

export type AuthErrorCode = "NO_TOKEN" | "INVALID_TOKEN" | "EXPIRED" | "REVOKED" | "USER_BLOCKED";

/**
 * A CREDENTIAL problem: the caller must sign in again (HTTP 401, socket
 * UNAUTHORIZED). Only auth code throws it, and only when the token or the
 * session itself is bad: an unsigned/forged/expired JWT, a missing, expired or
 * revoked session, a non-HUMAN (or restricted) user. Database and other
 * infrastructure failures are NEVER wrapped in it; they propagate unchanged
 * and callers answer 503 / SERVICE_UNAVAILABLE (retryable), so a database blip
 * can never sign a player out (a guest who loses the refresh cookie loses the
 * account for good).
 *
 * `reason` is set when the SESSION is over (not merely the short-lived access
 * token): it is what SESSION_REVOKED tells the client. An expired access token
 * has no reason; the client refreshes and carries on.
 */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, message?: string, readonly reason?: SessionEndReason) {
    super(message ?? code);
    this.name = "AuthError";
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}

/** A unique-constraint violation (Prisma P2002), with the constrained field names when Prisma reports them. */
export function uniqueViolation(e: unknown): { fields: string } | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return null;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return { fields: Array.isArray(target) ? target.join(",") : String(target ?? "") };
}
