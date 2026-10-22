import type { Context, Next } from "hono";
import type { Env } from "../env";
import { authenticate, type Authenticated } from "../auth/authenticate";
import { isAuthError } from "../auth/errors";
import { verifyTurnstile } from "../auth/turnstile";
import { errBrief, logWarn } from "./log";

export type Ctx = Context<{ Bindings: Env }>;
export type NextFn = Next;

export function serviceUnavailable(c: Ctx): Response {
  c.header("Retry-After", "2");
  return c.json({ error: "Service temporarily unavailable, please retry", retryable: true }, 503);
}

export function clientIp(c: Ctx): string | null {
  const value = c.req.header("cf-connecting-ip")?.trim();
  if (!value || value.length > 128) return null;
  return value;
}

export function pathname(c: Ctx): string {
  return new URL(c.req.url).pathname;
}

/** Address, user agent and Cloudflare country of this request, for sessions, devices and security events. */
export function requestFacts(c: Ctx): { ip: string | null; userAgent: string | null; country: string | null } {
  const country = (c.req.raw as Request & { cf?: { country?: unknown } }).cf?.country;
  return {
    ip: clientIp(c),
    userAgent: c.req.header("user-agent")?.slice(0, 256) ?? null,
    country: typeof country === "string" && /^[A-Z0-9]{2}$/.test(country) ? country : null,
  };
}

export interface GateOk {
  ok: true;
  userId: string;
  username: string;
  sessionId: string;
  user: Authenticated["user"];
  /** The session row as read for this request (step-up window, device, sign-in methods). */
  session: Authenticated["session"];
}

export type Gate = GateOk | { ok: false; response: Response };

export async function authed(c: Ctx): Promise<Gate> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token || token.length > 4096) return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  try {
    const result = await authenticate(c.get("db")!, token, c.get("config")!);
    c.set("userId", result.user.id);
    c.set("username", result.claims.username);
    c.set("sessionId", result.claims.sid);
    return { ok: true, userId: result.user.id, username: result.claims.username, sessionId: result.claims.sid, user: result.user, session: result.session };
  } catch (err) {
    if (isAuthError(err)) return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
    logWarn({ ...errBrief(err), path: pathname(c) }, "authentication unavailable; answered 503");
    return { ok: false, response: serviceUnavailable(c) };
  }
}

/** Runs before user lookup and password hashing. 403 does not change any cookie. */
export async function turnstileGate(c: Ctx): Promise<Response | null> {
  const body = c.get("jsonBody");
  const token = body && typeof body === "object" ? (body as { turnstileToken?: unknown }).turnstileToken : undefined;
  const result = await verifyTurnstile(c.get("config")!.turnstileSecretKey, token, clientIp(c));
  if (result.ok) return null;
  if (result.status === 503) {
    logWarn({ path: pathname(c) }, "turnstile siteverify unavailable; answered 503");
    return serviceUnavailable(c);
  }
  return c.json({ error: "Verification failed", code: "TURNSTILE_FAILED" }, 403);
}

/**
 * A definite answer decided inside a transaction: throwing it rolls the
 * transaction back (for example, a token is not consumed), then authRoute
 * sends the body.
 */
export class Refusal extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, readonly body: { error: string; code?: string } & Record<string, unknown>) {
    super(body.code ?? "refused");
    this.name = "Refusal";
  }
}

/** Non-credential failures on auth routes are 503 and do not clear cookies. */
export function authRoute(handler: (c: Ctx) => Promise<Response>): (c: Ctx) => Promise<Response> {
  return async (c) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof Refusal) return c.json(err.body, err.status);
      if (isAuthError(err)) return c.json({ error: "Unauthorized" }, 401);
      logWarn({ ...errBrief(err), path: pathname(c) }, "auth request failed; answered 503");
      return serviceUnavailable(c);
    }
  };
}
