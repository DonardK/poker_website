/** Documented dummy secrets. They do not call siteverify. */
export const TURNSTILE_PASS_SECRET = "1x0000000000000000000000000000000AA";
export const TURNSTILE_BLOCK_SECRET = "2x0000000000000000000000000000000AA";
export const TURNSTILE_SPENT_SECRET = "3x0000000000000000000000000000000AA";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

export type TurnstileResult =
  | { ok: true }
  | { ok: false; status: 403 }
  | { ok: false; status: 503 };

/**
 * Verify `turnstileToken` before any user lookup or password hashing.
 * A siteverify outage is 503 (retryable), not a bad password.
 */
export async function verifyTurnstile(secret: string, token: unknown, remoteIp: string | null): Promise<TurnstileResult> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, status: 403 };
  if (secret === TURNSTILE_PASS_SECRET) return { ok: true };
  if (secret === TURNSTILE_BLOCK_SECRET || secret === TURNSTILE_SPENT_SECRET) return { ok: false, status: 403 };
  try {
    const response = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: remoteIp ?? undefined }),
    });
    if (!response.ok) return { ok: false, status: 503 };
    const body = await response.json() as { success?: unknown };
    if (body.success !== true) return { ok: false, status: 403 };
    return { ok: true };
  } catch {
    return { ok: false, status: 503 };
  }
}
