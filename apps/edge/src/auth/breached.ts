import { toHex, utf8 } from "./bytes";

/**
 * Have I Been Pwned "Pwned Passwords" range check (k-anonymity): only the
 * first 5 hex characters of SHA-1(password) leave the Worker, with
 * Add-Padding so the response size says nothing either. Fail-open: a
 * timeout or an error answers "unknown" and the password is allowed.
 * No API key, no rate limit. Used at register, reset and change only.
 */

const RANGE_URL = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 1_500;

export type BreachVerdict = "breached" | "ok" | "unknown";

async function check(password: string): Promise<BreachVerdict> {
  const digest = toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", utf8(password)))).toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  let body: string;
  try {
    const response = await fetch(`${RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "poker-edge/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) return "unknown";
    body = await response.text();
  } catch {
    return "unknown";
  }
  for (const line of body.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon !== 35) continue;
    if (line.slice(0, 35).toUpperCase() !== suffix) continue;
    // Padding lines carry a count of 0.
    return Number(line.slice(36).trim()) > 0 ? "breached" : "ok";
  }
  return "ok";
}

/** Object so tests can spy without patching the ESM namespace. */
export const breach = { check };
