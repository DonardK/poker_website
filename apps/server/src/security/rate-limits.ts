/**
 * HTTP rate limits.
 *
 * SECURITY NOTES
 * - Every limiter is mounted BEFORE body parsing (app.ts), so a malformed or
 *   oversized body still consumes the caller's budget: rejecting it in the
 *   parser no longer bypasses the limits.
 * - Keys: an authenticated request is counted against its user (the bearer
 *   token's `sub`, after a signature/expiry check with no database access), so
 *   players behind one NAT or carrier-grade NAT do not exhaust each other's
 *   budget and one user cannot spread load over many IPs. Unauthenticated
 *   requests are counted per IP, IPv6 grouped by /56 (ipKeyGenerator), so one
 *   host cannot rotate through its own IPv6 prefix.
 * - Credential endpoints (login, register, guest) keep a strict per-IP limit
 *   whatever token is sent: they are the password-guessing and account-creation
 *   surface.
 * - POST /api/auth/refresh has its own limiter keyed by a hash of the refresh
 *   cookie when that cookie carries a valid signature (no database access), so
 *   many tabs or users behind one IP refreshing do not lock each other out. A
 *   missing or forged cookie falls back to the IP key, so random cookie values
 *   cannot mint fresh buckets.
 * - PER PROCESS: the counters live in this process's memory (the
 *   express-rate-limit MemoryStore). With several server processes behind a
 *   load balancer each one counts separately, so the effective limit is
 *   multiplied by the process count until a shared store (e.g. Redis via
 *   rate-limit-redis) is configured.
 *
 * This module imports no configuration: token verification is injected.
 */
import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export interface RateLimitOptions {
  /** Verifies an access token (signature, expiry, audience) WITHOUT database access; throws when invalid. */
  verifyAccessToken: (token: string) => { sub: string };
  /** Verifies a refresh token's signature WITHOUT database access; throws when invalid. */
  verifyRefreshToken: (token: string) => unknown;
  /** Name of the refresh cookie (cookie-parser must run before the refresh limiter). */
  refreshCookieName: string;
  /** Requests that skip the general limiter (load-balancer probes). */
  skipGeneral?: (req: Request) => boolean;
}

export interface RateLimiters {
  /** Every /api request: 120 per minute per user (valid bearer) or per IP. */
  general: RequestHandler;
  /** POST login / register / guest: 15 per minute per IP. */
  credentials: RequestHandler;
  /** POST /api/auth/refresh: 30 per minute per refresh session (valid cookie) or per IP. */
  refresh: RequestHandler;
}

const WINDOW_MS = 60_000;
export const GENERAL_LIMIT = 120;
export const CREDENTIAL_LIMIT = 15;
export const REFRESH_LIMIT = 30;

/** The per-IP key: ipKeyGenerator masks IPv6 addresses to their /56 prefix. */
export function ipKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")}`;
}

/** The bearer token of an Authorization header, if it has one of a sane length. */
function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 && token.length <= 4096 ? token : null;
}

export function createRateLimiters(options: RateLimitOptions): RateLimiters {
  const common = { windowMs: WINDOW_MS, standardHeaders: true as const, legacyHeaders: false };
  const userOrIp = (req: Request): string => {
    const token = bearer(req);
    if (token) {
      try { return `user:${options.verifyAccessToken(token).sub}`; } catch { /* invalid or expired: count by IP */ }
    }
    return ipKey(req);
  };
  const refreshOrIp = (req: Request): string => {
    const cookie = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[options.refreshCookieName];
    if (typeof cookie === "string" && cookie.length > 0 && cookie.length <= 4096) {
      try {
        options.verifyRefreshToken(cookie);
        return `refresh:${createHash("sha256").update(cookie).digest("hex")}`;
      } catch { /* forged or expired: count by IP */ }
    }
    return ipKey(req);
  };
  return {
    general: rateLimit({ ...common, limit: GENERAL_LIMIT, keyGenerator: userOrIp, ...(options.skipGeneral ? { skip: options.skipGeneral } : {}) }),
    credentials: rateLimit({ ...common, limit: CREDENTIAL_LIMIT, keyGenerator: ipKey }),
    refresh: rateLimit({ ...common, limit: REFRESH_LIMIT, keyGenerator: refreshOrIp }),
  };
}
