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

export type Gate =
  | { ok: true; userId: string; username: string; sessionId: string; user: Authenticated["user"] }
  | { ok: false; response: Response };

export async function authed(c: Ctx): Promise<Gate> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token || token.length > 4096) return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  try {
    const result = await authenticate(c.get("db")!, token, c.get("config")!);
    c.set("userId", result.user.id);
    c.set("username", result.claims.username);
    c.set("sessionId", result.claims.sid);
    return { ok: true, userId: result.user.id, username: result.claims.username, sessionId: result.claims.sid, user: result.user };
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

/** Non-credential failures on auth routes are 503 and do not clear cookies. */
export function authRoute(handler: (c: Ctx) => Promise<Response>): (c: Ctx) => Promise<Response> {
  return async (c) => {
    try {
      return await handler(c);
    } catch (err) {
      if (isAuthError(err)) return c.json({ error: "Unauthorized" }, 401);
      logWarn({ ...errBrief(err), path: pathname(c) }, "auth request failed; answered 503");
      return serviceUnavailable(c);
    }
  };
}
