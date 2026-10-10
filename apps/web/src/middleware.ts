import { NextResponse, type NextRequest } from "next/server";

/**
 * SECURITY: per-request Content-Security-Policy.
 *
 * - Scripts run only with this request's nonce ('strict-dynamic' lets those
 *   scripts load Next.js chunks). Next.js reads the nonce from the request's
 *   Content-Security-Policy header and stamps it on its own scripts; the root
 *   layout renders every page per request so no prerendered page is served
 *   without one. An injected <script> or inline handler never runs.
 * - connect-src is limited to this origin plus the API and Socket.IO origins
 *   the client is built with (their ws:/wss: forms for the WebSocket
 *   transport), so a script that did run could not send data elsewhere.
 * - Styles allow 'unsafe-inline' because React and framer-motion set inline
 *   style attributes; styles cannot execute code.
 * - Development only: React Refresh needs eval ('unsafe-eval'). Production
 *   adds upgrade-insecure-requests instead.
 */
const DEV = process.env.NODE_ENV === "development";

/** The http(s) origin of a configured URL and its WebSocket form, or nothing if it does not parse. */
function connectSources(raw: string | undefined): string[] {
  try {
    const url = new URL(raw ?? "http://localhost:4000");
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    const ws = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
    return [url.origin, ws];
  } catch {
    return [];
  }
}

export function contentSecurityPolicy(nonce: string, dev = DEV): string {
  // The same defaults as lib/api.ts and lib/socket.ts, so the policy always allows what the client actually calls.
  const connect = new Set(["'self'",
    ...connectSources(process.env.NEXT_PUBLIC_API_URL),
    ...connectSources(process.env.NEXT_PUBLIC_SOCKET_URL)]);
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${[...connect].join(" ")}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
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
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
