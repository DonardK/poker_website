/**
 * Access log for the regulator / operator API (/api/admin).
 *
 * COMPLIANCE NOTE (audit access logging): app.ts mounts `adminAccessLog` on
 * /api/admin before any other middleware, so every request to that path is
 * logged exactly once with its outcome. That includes requests refused by the
 * TLS gate (426), a rate limiter (429), authentication (401) or the ADMIN
 * check (403), as well as failures and successful reads. Each entry records
 * the method, the path (without the query string, truncated), the client IP
 * (`req.ip`, which honours TRUST_PROXY_HOPS and TRUSTED_PROXY_CIDRS), the
 * authenticated user id when requireAuth has set it (otherwise null) and the
 * HTTP status. A request whose connection closes before the response is
 * complete is logged with `completed: false` and a null status.
 *
 * SECURITY: the query string is never logged. It is client-controlled and may
 * carry tokens or personal data, and audit lookups are identified by path.
 *
 * This module imports no configuration or database, so it can be tested
 * directly with a logger spy.
 */
import type { NextFunction, Request, Response } from "express";

export const ADMIN_ACCESS_EVENT = "ADMIN_REQUEST";

export interface AdminAccessEntry {
  audit: typeof ADMIN_ACCESS_EVENT;
  method: string;
  path: string;
  ip: string | null;
  userId: string | null;
  status: number | null;
  completed: boolean;
  durationMs: number;
}

/** The two pino methods the access log uses (a pino Logger satisfies this). */
export interface AccessLogger {
  info(entry: AdminAccessEntry, message: string): void;
  warn(entry: AdminAccessEntry, message: string): void;
}

/** First middleware on /api/admin: logs each request once, when its response finishes or its connection closes. */
export function adminAccessLog(log: AccessLogger): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const started = Date.now();
    let logged = false;
    const write = (completed: boolean): void => {
      if (logged) return;
      logged = true;
      const entry: AdminAccessEntry = {
        audit: ADMIN_ACCESS_EVENT,
        method: req.method,
        // originalUrl keeps the /api/admin mount prefix (req.path would not); the query is dropped.
        path: req.originalUrl.split("?")[0]!.slice(0, 200),
        ip: req.ip ?? null,
        // Set on this same request object by requireAuth once the token and session verify.
        userId: (req as Request & { userId?: string }).userId ?? null,
        status: completed ? res.statusCode : null,
        completed,
        durationMs: Date.now() - started,
      };
      if (!completed) log.warn(entry, "admin request closed before its response completed");
      else if (res.statusCode >= 400) log.warn(entry, "admin request refused or failed");
      else log.info(entry, "admin request served");
    };
    // "finish" fires when the response has been handed to the OS; "close"
    // follows it, or fires alone when the connection ends first.
    res.on("finish", () => write(true));
    res.on("close", () => write(false));
    next();
  };
}
