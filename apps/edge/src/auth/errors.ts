import type { SessionEndReason } from "@poker/shared";

export type AuthErrorCode = "NO_TOKEN" | "INVALID_TOKEN" | "EXPIRED" | "REVOKED" | "USER_BLOCKED";

/**
 * A credential problem (HTTP 401). Database failures are never wrapped in
 * this error: callers answer 503 and leave the refresh cookie in place.
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

/** Prisma P2002, including the in-memory test double that uses the same name and code. */
export function uniqueViolation(e: unknown): { fields: string } | null {
  if (typeof e !== "object" || e === null) return null;
  const err = e as { name?: unknown; code?: unknown; meta?: { target?: unknown } };
  if (err.name !== "PrismaClientKnownRequestError" || err.code !== "P2002") return null;
  const target = err.meta?.target;
  return { fields: Array.isArray(target) ? target.join(",") : String(target ?? "") };
}
