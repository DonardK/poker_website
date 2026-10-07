/**
 * Re-check (2026-10-07) of CR-011: runs the real apps/web/src/middleware.ts
 * and next.config.ts in-process (no Next server, no build) with
 * NODE_ENV=production, and prints the headers a page response would carry.
 *
 * Usage (repo root):
 *   TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/recheck/auth-security/web-headers-recheck.mjs
 */
process.env.NODE_ENV = 'production';
process.env.NEXT_PUBLIC_API_URL = 'https://poker.example.com';
process.env.NEXT_PUBLIC_SOCKET_URL = 'https://poker.example.com';

const root = new URL('../../../../', import.meta.url);
const { middleware, contentSecurityPolicy, config } = await import(new URL('apps/web/src/middleware.ts', root).href);
const { NextRequest } = await import('next/server');
const nextConfig = (await import(new URL('apps/web/next.config.ts', root).href)).default;
const { PHASE_PRODUCTION_SERVER } = await import('next/constants');

const out = {};
for (const path of ['/', '/login', '/table/x']) {
  const res = middleware(new NextRequest(`https://poker.example.com${path}`));
  out[path] = { csp: res.headers.get('content-security-policy'), forwardsNonceToRender: res.headers.get('x-middleware-request-x-nonce') !== null };
}
const a = contentSecurityPolicy('AAAA', false); const b = contentSecurityPolicy('BBBB', false);
out.productionPolicyHasNoUnsafeEval = !a.includes('unsafe-eval');
out.nonceDiffersPerRequest = out['/'].csp !== out['/login'].csp;
out.policyDiffersOnlyByNonce = a.replace('AAAA', 'X') === b.replace('BBBB', 'X');
out.matcher = config.matcher;
const cfg = nextConfig(PHASE_PRODUCTION_SERVER);
out.nextConfigHeaders = (await cfg.headers()).map((h) => ({ source: h.source, headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])) }));
out.poweredByHeader = cfg.poweredByHeader;
console.log(JSON.stringify(out, null, 2));
