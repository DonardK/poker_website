import { NextResponse, type NextRequest } from "next/server";
import { SESSION_HINT_COOKIE_NAME } from "@poker/shared";
import { isProtectedPath } from "@/lib/routes";
import { safeNext } from "@/lib/safe-next";

/**
 * SECURITY: per-request Content-Security-Policy.
 *
 * - Scripts run only with this request's nonce ('strict-dynamic' lets those
 *   scripts load Next.js chunks). Next.js reads the nonce from the request's
 *   Content-Security-Policy header and stamps it on its own scripts; the root
 *   layout renders every page per request so no prerendered page is served
 *   without one. An injected <script> or inline handler never runs.
 * - connect-src is 'self' plus any API and socket origins baked into the
 *   build. Empty NEXT_PUBLIC_API_URL / NEXT_PUBLIC_SOCKET_URL add nothing:
 *   'self' covers the page, including its wss. A set URL (legacy server or
 *   Playwright) is listed with its ws: and wss: forms.
 * - script-src, frame-src, and connect-src allow https://challenges.cloudflare.com
 *   for the Turnstile widget. The widget's challenge requests are fetches, so
 *   connect-src needs that host even with pre-clearance off. Nonce +
 *   strict-dynamic stays; the host is the fallback for script-src.
 * - Styles allow 'unsafe-inline' because React and framer-motion set inline
 *   style attributes; styles cannot execute code.
 * - Development only: React Refresh needs eval ('unsafe-eval'). Production
 *   adds upgrade-insecure-requests instead.
 *
 * Also the sign-in gate's fast path (below) and the request's path for the
 * root layout (x-pathname: the Turnstile script tag is rendered only on the
 * pages with a Turnstile form).
 */
const DEV = process.env.NODE_ENV === "development";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The http(s) origin of a configured URL and its WebSocket form. Empty stays empty so 'self' is the same-origin policy. */
function connectSources(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    const ws = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
    return [url.origin, ws];
  } catch {
    return [];
  }
}

/** Explicit wss origin when a socket URL was baked in. Empty relies on 'self'. */
function socketWss(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    return [`wss://${url.host}`];
  } catch {
    return [];
  }
}

export function contentSecurityPolicy(nonce: string, dev = DEV): string {
  // Empty public URLs call this origin. 'self' allows that, including wss.
  const connect = new Set(["'self'",
    ...connectSources(process.env.NEXT_PUBLIC_API_URL),
    ...connectSources(process.env.NEXT_PUBLIC_SOCKET_URL),
    ...socketWss(process.env.NEXT_PUBLIC_SOCKET_URL),
    TURNSTILE_ORIGIN]);
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE_ORIGIN}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${[...connect].join(" ")}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `frame-src ${TURNSTILE_ORIGIN}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ];
  return directives.join("; ");
}

/**
 * Loop breaker: set on every gate redirect for 30 s. While it is present the
 * middleware does not redirect again and the client gate decides, so an API
 * that never sets the hint (older deploy, legacy apps/server) costs a signed-in
 * visitor at most one trip through /login (which signs them straight back in).
 */
const BOUNCE_COOKIE_NAME = "poker_gate_bounce";

/**
 * SECURITY: the sign-in gate's fast path (owner decision: no guest play).
 * The API sets poker_session_hint (HttpOnly, Path=/) with the refresh cookie,
 * whose own path (/api/auth) this middleware cannot see. With
 * AUTH_HINT_REDIRECT=1 a document request for a protected page without the
 * hint is sent to /login before anything renders. The hint is NOT an
 * authenticator: anyone can set it, and all it does is skip this redirect.
 * The client gate (RequireSession) and the bearer API stay the authority, and
 * no server component renders account data. Never redirects away from a
 * public page (/login, the legal and email-link pages).
 */
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * The origin the browser asked for. A redirect must stay on it (cookies and
 * storage are per host); `request.url` can name another host for the same
 * server (next dev reports "localhost" for 127.0.0.1). The Host header only
 * picks between names of this server: a forged one redirects only its sender.
 */
function requestOrigin(request: NextRequest): string {
  const host = request.headers.get("host");
  return `${request.nextUrl.protocol}//${host && HOST.test(host) ? host : request.nextUrl.host}`;
}

function signInRedirect(request: NextRequest): NextResponse | null {
  if (process.env.AUTH_HINT_REDIRECT !== "1") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  // A client-side navigation (React Server Components payload): the client gate handles it in place.
  if (request.headers.has("rsc") || request.headers.has("next-router-state-tree")) return null;
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/_next/") || pathname.startsWith("/__nextjs")) return null;
  if (!isProtectedPath(pathname)) return null;
  if (request.cookies.has(SESSION_HINT_COOKIE_NAME) || request.cookies.has(BOUNCE_COOKIE_NAME)) return null;
  const target = new URL(`/login?${new URLSearchParams({ next: safeNext(`${pathname}${search}`) })}`, requestOrigin(request));
  const response = NextResponse.redirect(target, 307);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(BOUNCE_COOKIE_NAME, "1", {
    path: "/", maxAge: 30, httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(request: NextRequest) {
  const redirect = signInRedirect(request);
  if (redirect) return redirect;
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Overwrites anything the browser sent under this name.
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Pages only: static assets carry no executable HTML, and prefetches reuse the page's policy.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|ws(?:/|$)).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
