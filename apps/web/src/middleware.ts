import { NextResponse, type NextRequest } from "next/server";

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

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
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
