/**
 * Cross-origin / CSRF guard for state-changing API requests.
 *
 * SECURITY NOTE: the refresh cookie is SameSite=Strict in production, and the
 * CORS policy allows only CLIENT_ORIGIN to READ responses, but neither stops
 * a foreign page from SENDING a request: a cross-site <form> or a "simple"
 * fetch (text/plain, no preflight) reaches the server and acts before CORS is
 * consulted. This guard refuses those before any body is parsed, for every
 * /api request whose method is not GET, HEAD or OPTIONS:
 *
 * - A request that carries a body must declare Content-Type application/json
 *   (415 otherwise). A JSON content type cannot be sent cross-origin without a
 *   CORS preflight, and the preflight only succeeds for CLIENT_ORIGIN. A
 *   body-less request (logout, refresh, DELETE) has no content to type; it is
 *   covered by the Origin / Sec-Fetch-Site checks below, which every browser
 *   applies to cross-site POST and DELETE. Paths under an exempt prefix
 *   (payment webhooks, which will carry raw signed bodies authenticated by
 *   their signature) skip the Content-Type check, but not the origin check.
 * - If an Origin header is present it must equal CLIENT_ORIGIN exactly (403).
 *   "null" (sandboxed frames, file: pages, some redirects) is refused too.
 * - Without an Origin header, a request the browser labels
 *   Sec-Fetch-Site: cross-site is refused (403). Non-browser clients, which
 *   send neither header, stay allowed: they carry no ambient credentials a
 *   foreign page could abuse.
 *
 * This module imports no configuration, so it can be tested directly.
 */
import type { NextFunction, Request, Response } from "express";

export interface RequestGuardOptions {
  /** The only origin allowed to send state-changing requests (already normalized, no trailing slash). */
  clientOrigin: string;
  /** Path prefixes (full paths, e.g. "/api/payments/webhooks/") exempt from the Content-Type check. */
  contentTypeExemptPrefixes?: readonly string[];
  /** Called once per refused request with a short reason (never with the request body). */
  onRefused?: (reason: "content-type" | "origin" | "fetch-site", req: Request) => void;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The media type of a Content-Type header, lower-cased and without parameters. */
export function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

/** True when the request carries a body (same test as type-is, except that Content-Length: 0 is empty). */
export function hasBody(req: Request): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const length = req.headers["content-length"];
  return length !== undefined && Number(length) !== 0;
}

export function requestGuard(options: RequestGuardOptions): (req: Request, res: Response, next: NextFunction) => void {
  const exempt = options.contentTypeExemptPrefixes ?? [];
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) { next(); return; }
    // originalUrl, not path: this may be mounted under a prefix, and the exemption names full paths.
    const path = req.originalUrl.split("?")[0]!;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (origin !== options.clientOrigin) {
        options.onRefused?.("origin", req);
        res.status(403).json({ error: "Cross-origin request refused" });
        return;
      }
    } else if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") {
      options.onRefused?.("fetch-site", req);
      res.status(403).json({ error: "Cross-origin request refused" });
      return;
    }
    if (hasBody(req) && !exempt.some((prefix) => path.startsWith(prefix)) && mediaType(req.headers["content-type"]) !== "application/json") {
      options.onRefused?.("content-type", req);
      res.status(415).json({ error: "Content-Type must be application/json" });
      return;
    }
    next();
  };
}
