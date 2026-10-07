/**
 * Re-check (2026-10-07) of CR-011 / F15 (web security headers) without a
 * Next.js build: evaluates the real apps/web/src/middleware.ts policy builder
 * and the headers() of apps/web/next.config.ts for the production phase.
 * Nothing is built, served or written; no network.
 *
 * Usage (repository root):
 *   TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/recheck/auth-security/web-headers.mjs
 */
process.env.NODE_ENV = 'production';
process.env.NEXT_PUBLIC_API_URL = 'https://poker.example.com';
process.env.NEXT_PUBLIC_SOCKET_URL = 'https://poker.example.com';

const { contentSecurityPolicy, middleware, config } = await import('../../../../apps/web/src/middleware.ts');
const { default: nextConfig } = await import('../../../../apps/web/next.config.ts');
const { PHASE_PRODUCTION_SERVER, PHASE_DEVELOPMENT_SERVER } = await import('next/constants.js');
const { NextRequest } = await import('next/server.js');

const prodCsp = contentSecurityPolicy('TESTNONCE', false);
const devCsp = contentSecurityPolicy('TESTNONCE', true);
const prodHeaders = (await nextConfig(PHASE_PRODUCTION_SERVER).headers())[0];
const devHeaders = (await nextConfig(PHASE_DEVELOPMENT_SERVER).headers())[0];
let middlewareResponse = null;
try {
  const res = middleware(new NextRequest('https://poker.example.com/table/x'));
  middlewareResponse = { csp: res.headers.get('content-security-policy'), forwardedRequestCsp: res.headers.get('x-middleware-request-content-security-policy') !== null };
} catch (err) { middlewareResponse = { error: String(err?.message ?? err).slice(0, 200) }; }
console.log(JSON.stringify({
  prodCsp, prodHasUnsafeEval: prodCsp.includes('unsafe-eval'), devCsp,
  prodHeaders, devHeaders, matcher: config.matcher, middlewareResponse,
}, null, 2));
