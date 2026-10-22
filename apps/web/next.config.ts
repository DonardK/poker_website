import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

/** Repo root (this file is apps/web/next.config.ts). Stops Next from treating a parent lockfile as the workspace. */
const repoRoot = path.resolve(__dirname, "../..");

/**
 * SECURITY: response headers for every route (the nonce-based CSP is set per
 * request in src/middleware.ts). HSTS only in production: on a development
 * http://localhost it would be ignored at best and pin a browser to https for
 * the host at worst.
 */
function securityHeaders(phase: string): { key: string; value: string }[] {
  const headers = [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
  if (phase !== PHASE_DEVELOPMENT_SERVER && process.env.NODE_ENV === "production") {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" });
  }
  return headers;
}

const nextConfig = (phase: string): NextConfig => ({
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@poker/shared"],
  reactStrictMode: true,
  poweredByHeader: false,
  distDir: process.env.POKER_TEST_DIST_DIR ?? (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  // Browser tests only (playwright.config.ts): their host is 127.0.0.1, which Next.js would rewrite to
  // "localhost" in the middleware's sign-in redirect. Real hosts are never loopback addresses.
  skipMiddlewareUrlNormalize: process.env.POKER_SKIP_MIDDLEWARE_URL_NORMALIZE === "1",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(phase) }];
  },
  /**
   * Local `next dev` only. Production is one workers.dev origin: worker.ts
   * forwards `/api/*` and `/ws/*` to the API service binding. In development
   * those paths are proxied to `wrangler dev` so cookies stay same-origin
   * (the API cookie paths are `/api/auth` and `/ws`). Leave
   * NEXT_PUBLIC_API_URL empty so the browser calls this origin. Set it to
   * http://localhost:4000 only for the legacy `npm run dev` server.
   */
  async rewrites() {
    if (phase !== PHASE_DEVELOPMENT_SERVER) return [];
    const edge = (process.env.POKER_EDGE_ORIGIN ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
    return [
      { source: "/api/:path*", destination: `${edge}/api/:path*` },
      { source: "/ws/:path*", destination: `${edge}/ws/:path*` },
    ];
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
});

export default nextConfig;
