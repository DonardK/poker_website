import { isAuthEntryPath, isAuthTokenPath } from "./routes";

/**
 * SECURITY: the only way a `next=` value (query string, middleware, server
 * pages, the client gate) becomes a navigation target. It returns a
 * same-origin path or `fallback`, so a crafted sign-in link can never send
 * someone to another site (open redirect) or into a `javascript:` URL.
 *
 * Accepted only when every rule holds:
 * 1. a string of 1-512 characters;
 * 2. starts with "/" but not "//" or "/\" (protocol-relative URLs);
 * 3. no backslash, control character or whitespace;
 * 4. the percent-decoded value still satisfies 2-3 ("/%2F%2Fevil.example");
 * 5. no "." or ".." path segment, raw or decoded ("/.//evil.example",
 *    "/%2e//evil.example"): URL resolution would collapse it into "//evil.example";
 * 6. resolves to the same origin, and the path it resolves to (the value
 *    returned) still satisfies 2-3;
 * 7. is not /login, /signup or an email-link page, so signing in never lands
 *    back on a sign-in screen or replays a spent token.
 */
const BAD_CHARACTER = /[\u0000- \u007f\\]|\s/;
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$|[?#])/;
const BASE = "http://n.invalid";

function wellFormed(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") && !BAD_CHARACTER.test(value);
}

export function safeNext(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 512) return fallback;
  if (!wellFormed(raw)) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (!wellFormed(decoded)) return fallback;
  if (DOT_SEGMENT.test(raw) || DOT_SEGMENT.test(decoded)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  if (isAuthEntryPath(url.pathname) || isAuthTokenPath(url.pathname)) return fallback;
  // What the router is given is checked too, not only what came in.
  const out = `${url.pathname}${url.search}${url.hash}`;
  return wellFormed(out) ? out : fallback;
}

/**
 * A username from `?as=` (the account chooser's prefill), or null. Looser than
 * the server's 3-24 [A-Za-z0-9_] rule so older names still prefill; it is only
 * ever rendered as React text and sent back as a login identifier.
 */
export function safeUsername(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(raw) ? raw : null;
}

/** The first value of a Next.js search param (a string, an array, or undefined). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
