/**
 * Route classes, shared by the middleware gate and the client.
 *
 * SECURITY: default deny. Every path is protected (a signed-out visitor is
 * sent to /login) unless it is listed here. The lists hold page paths only;
 * /api and /ws never reach the middleware (see its matcher).
 */

/** Legal documents: always readable, signed in or out. */
export const LEGAL_PATHS = ["/terms", "/privacy", "/rules", "/fairness", "/responsible-gaming", "/complaints"] as const;
/** Sign-in and sign-up. A signed-in visitor is sent on to `next`. */
export const AUTH_ENTRY_PATHS = ["/login", "/signup"] as const;
/**
 * Pages opened from an email link (token in the URL fragment, #t=...). They
 * work signed in or out and never redirect. The API builds these links
 * (apps/edge/src/mail/notify.ts EMAIL_LINK_PAGES): verification, password
 * reset, email change (confirmed from the new address) and "This wasn't me".
 */
export const AUTH_TOKEN_PATHS = ["/reset-password", "/verify-email", "/email-change", "/auth/not-me"] as const;
/** Files Next.js serves from the app directory. */
export const STATIC_PUBLIC = ["/robots.txt", "/sitemap.xml", "/icon.svg", "/apple-icon", "/favicon.ico"] as const;
/** Prefixes that are public as a whole (security.txt, a future /.well-known/webauthn). */
export const PUBLIC_PREFIXES = ["/.well-known/"] as const;
/** The only pages that render the Cloudflare Turnstile script tag. */
export const TURNSTILE_PATHS = ["/login", "/signup", "/reset-password"] as const;

const PUBLIC_EXACT: ReadonlySet<string> = new Set<string>([
  ...LEGAL_PATHS, ...AUTH_ENTRY_PATHS, ...AUTH_TOKEN_PATHS, ...STATIC_PUBLIC,
]);

/** The path without one trailing slash ("/" stays "/"). */
function trimmed(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Exact match (with or without a trailing slash) or a public prefix. */
export function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT.has(trimmed(path))) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Default deny: everything that is not explicitly public needs a session. */
export function isProtectedPath(path: string): boolean {
  return !isPublicPath(path);
}

/** /login and /signup: never a destination after signing in. */
export function isAuthEntryPath(path: string): boolean {
  return (AUTH_ENTRY_PATHS as readonly string[]).includes(trimmed(path));
}

/** Email-link pages: never a destination after signing in either (their token is single use). */
export function isAuthTokenPath(path: string): boolean {
  return (AUTH_TOKEN_PATHS as readonly string[]).includes(trimmed(path));
}

export function isTurnstilePath(path: string | null | undefined): boolean {
  return typeof path === "string" && (TURNSTILE_PATHS as readonly string[]).includes(trimmed(path));
}
