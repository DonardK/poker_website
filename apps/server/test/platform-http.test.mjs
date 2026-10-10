/**
 * Platform hardening of the HTTP layer (in process, no database: the runner
 * points DATABASE_URL at a dead port and no request here reaches a query
 * except the readiness probe, which must report the database as down).
 *
 * What it proves:
 * - Malformed, oversized or mis-encoded bodies get 400/413/415 JSON, and the
 *   raw input (a synthetic password marker) never reaches the log output; the
 *   catch-all serializer and pino redaction withhold credentials.
 * - Rate limiters run before body parsing: malformed auth requests consume
 *   the credential limit. Authenticated requests are counted per user,
 *   unauthenticated ones per IP; refresh has its own cookie-keyed limiter.
 * - Cache-Control: no-store on every /api response (errors included) except
 *   the lobby list, which is "private, no-cache".
 * - The CSRF guard refuses foreign, "null" and sibling origins, cross-site
 *   fetches without Origin, and non-JSON bodies; first-party JSON passes.
 * - Readiness: 503 with reasons for a dead database, unfinished startup and
 *   draining; liveness stays 200 without touching the database.
 * - The admin access log drops the query string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createApp } from '../dist/app.js';
import { env } from '../dist/config.js';
import { createLogger } from '../dist/logger.js';
import { signAccessToken } from '../dist/auth/jwt.js';
import { createReadiness } from '../dist/security/readiness.js';
import { createRateLimiters, CREDENTIAL_LIMIT, GENERAL_LIMIT, REFRESH_LIMIT } from '../dist/security/rate-limits.js';
import { isBodyParserError, serializeError } from '../dist/security/safe-log.js';

const MARKER = 'SYNTHETIC-PASSWORD-MARKER-6b1f0c';

/** Serves createApp() with a logger whose output is captured as text. */
async function serve(t, options = {}) {
  const lines = [];
  const logger = createLogger({ write: (chunk) => { lines.push(String(chunk)); } });
  const server = createServer(createApp({ logger, ...options }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, { method = 'GET', headers = {}, body } = {}) => {
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  };
  return { send, logs: () => lines.join('') };
}

const json = { 'content-type': 'application/json' };
const firstParty = { ...json, origin: env.CLIENT_ORIGIN };

// ---------------------------------------------------------------------------
// 1. Malformed bodies
// ---------------------------------------------------------------------------

test('malformed JSON containing a password: 400 JSON, and the password never reaches the logs', async (t) => {
  const { send, logs } = await serve(t);
  const bodies = [
    `{"username":"alice","password":"${MARKER}`,          // unterminated
    `{"username":"alice","password":"${MARKER}",}`,       // trailing comma
    `{"password": ${MARKER}}`,                            // bare token: JSON.parse quotes it in its message
    `"${MARKER}"`,                                        // strict mode: not an object
  ];
  for (const body of bodies) {
    const res = await send('/api/auth/login', { method: 'POST', headers: firstParty, body });
    assert.equal(res.status, 400, body);
    assert.deepEqual(JSON.parse(res.text), { error: 'Malformed request body' });
    assert.ok(!res.text.includes(MARKER));
  }
  const unsupported = await send('/api/auth/register', { method: 'POST', headers: { ...firstParty, 'content-type': 'application/json; charset=latin1' }, body: `{"password":"${MARKER}"}` });
  assert.equal(unsupported.status, 415, 'unsupported charset is a client error, not 500');
  assert.ok(logs().includes('entity.parse.failed'), 'the rejection itself is logged');
  assert.ok(!logs().includes(MARKER), 'no log line contains the submitted password');
});

test('oversized body: 413 JSON, raw input not logged', async (t) => {
  const { send, logs } = await serve(t);
  const res = await send('/api/auth/login', { method: 'POST', headers: firstParty, body: JSON.stringify({ username: 'alice', password: MARKER + 'x'.repeat(40_000) }) });
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.text), { error: 'Request body too large' });
  assert.ok(logs().includes('entity.too.large'));
  assert.ok(!logs().includes(MARKER));
});

test('16 malformed auth requests from one IP consume the credential limit', async (t) => {
  const { send } = await serve(t);
  const statuses = [];
  // Case and trailing-slash variants reach the same route, so they share the same budget.
  const paths = ['/api/auth/login', '/api/AUTH/Login', '/api/auth/login/'];
  for (let i = 0; i < CREDENTIAL_LIMIT + 1; i += 1) {
    statuses.push((await send(paths[i % paths.length], { method: 'POST', headers: firstParty, body: `{"password":"${MARKER}` })).status);
  }
  assert.deepEqual(statuses, [...Array(CREDENTIAL_LIMIT).fill(400), 429]);
  // The limit is per IP across the credential endpoints, whatever the body.
  assert.equal((await send('/api/auth/register', { method: 'POST', headers: firstParty, body: '{}' })).status, 429);
  assert.equal((await send('/api/auth/guest', { method: 'POST', headers: firstParty, body: '{}' })).status, 429);
});

test('error serializer: allow-list only, no input-bearing messages, no stack in production', () => {
  const parser = Object.assign(new SyntaxError(`Unexpected token in JSON: {"password":"${MARKER}`), { type: 'entity.parse.failed', status: 400, body: `{"password":"${MARKER}`, expose: true });
  assert.ok(isBodyParserError(parser));
  const safeParser = serializeError(parser, true);
  assert.deepEqual(Object.keys(safeParser).sort(), ['name', 'stack', 'status', 'type']);
  assert.ok(!JSON.stringify(safeParser).includes(MARKER));
  const prisma = Object.assign(new Error(`Invalid \`prisma.user.create()\` invocation:\n{ data: { passwordHash: "${MARKER}" } }`), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
  const safePrisma = serializeError(prisma, true);
  assert.equal(safePrisma.code, 'P2002'); assert.equal(safePrisma.message, undefined);
  assert.ok(!JSON.stringify(safePrisma).includes(MARKER), 'Prisma invocation arguments are withheld, from the stack too');
  const generic = Object.assign(new Error('boom Bearer abc.def.ghi with ' + 'ab'.repeat(32)), { secretField: MARKER });
  const safeGeneric = serializeError(generic, false);
  assert.deepEqual(Object.keys(safeGeneric).sort(), ['message', 'name']);
  assert.equal(safeGeneric.message, 'boom [REDACTED] with [REDACTED]');
  assert.ok(!('stack' in safeGeneric), 'no stack in production');
});

test('pino redaction censors credential keys at depth', () => {
  const lines = [];
  const logger = createLogger({ write: (chunk) => { lines.push(String(chunk)); } });
  logger.info({
    headers: { authorization: `Bearer ${MARKER}`, cookie: MARKER, 'set-cookie': MARKER },
    body: { password: MARKER, newPassword: MARKER, nested: { token: MARKER, refreshToken: MARKER, accessToken: MARKER, deeper: { secret: MARKER, apiKey: MARKER } } },
    password: MARKER,
  }, 'probe');
  logger.error(Object.assign(new Error('failure'), { body: MARKER }), 'error as first argument');
  const out = lines.join('');
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(!out.includes(MARKER), out);
});

// ---------------------------------------------------------------------------
// 2. Cache-Control
// ---------------------------------------------------------------------------

test('Cache-Control: no-store on API responses including errors; the lobby list may revalidate', async (t) => {
  const { send } = await serve(t);
  const noStore = [
    await send('/api/health'),
    await send('/api/ready'),
    await send('/api/auth/me'),                                                                    // 401
    await send('/api/auth/login', { method: 'POST', headers: firstParty, body: '{' }),             // 400
    await send('/api/auth/logout', { method: 'POST', headers: { ...json, origin: 'https://evil.example' } }), // 403
    await send('/api/auth/logout', { method: 'POST', headers: { origin: env.CLIENT_ORIGIN, 'content-type': 'text/plain' }, body: 'x' }), // 415
    await send('/api/auth/logout', { method: 'POST', headers: firstParty }),
    await send('/api/tables/some-table'),
    await send('/api/unknown'),                                                                    // 404
  ];
  for (const res of noStore) {
    assert.equal(res.headers.get('cache-control'), 'no-store', `${res.status} ${res.text.slice(0, 60)}`);
    assert.equal(res.headers.get('pragma'), 'no-cache');
  }
  const lobby = await send('/api/tables');
  assert.equal(lobby.headers.get('cache-control'), 'private, no-cache');
  assert.match(lobby.headers.get('vary') ?? '', /Authorization/);
  // Rate-limit refusals are covered too.
  let limited;
  for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) limited = await send('/api/auth/guest', { method: 'POST', headers: firstParty, body: '{' });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('cache-control'), 'no-store');
});

// ---------------------------------------------------------------------------
// 3. CSRF / cross-origin guard
// ---------------------------------------------------------------------------

test('CSRF guard: foreign, null and sibling origins, cross-site fetches and non-JSON bodies are refused', async (t) => {
  const { send, logs } = await serve(t);
  const client = new URL(env.CLIENT_ORIGIN);
  const sibling = `${client.protocol}//evil.${client.hostname}${client.port ? `:${client.port}` : ''}`;
  const otherPort = `${client.protocol}//${client.hostname}:${Number(client.port || 443) + 1}`;
  const post = (headers, body) => send('/api/auth/logout', { method: 'POST', headers, body });
  for (const origin of ['https://evil.example', 'null', sibling, otherPort, `${env.CLIENT_ORIGIN}/`]) {
    const res = await post({ ...json, origin }, '{}');
    assert.equal(res.status, 403, origin);
    assert.deepEqual(JSON.parse(res.text), { error: 'Cross-origin request refused' });
  }
  assert.equal((await post({ ...json, 'sec-fetch-site': 'cross-site' }, '{}')).status, 403, 'no Origin but the browser says cross-site');
  for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
    const res = await post({ origin: env.CLIENT_ORIGIN, 'content-type': type }, 'a=b');
    assert.equal(res.status, 415, type);
  }
  assert.equal((await post({ origin: env.CLIENT_ORIGIN }, 'a=b')).status, 415, 'a POST body without Content-Type is refused');
  // A body-less POST has nothing to type: it passes the Content-Type rule and stays subject to the Origin checks above.
  assert.ok(![403, 415].includes((await post({ origin: env.CLIENT_ORIGIN })).status), 'a body-less first-party POST reaches the route');
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403, 'a body-less cross-origin POST is still refused');
  // Legitimate requests pass the guard and reach the route.
  const legit = await post(firstParty, '{}');
  const charset = await post({ ...firstParty, 'content-type': 'application/json; charset=utf-8' }, '{}');
  const sameOrigin = await post({ ...firstParty, 'sec-fetch-site': 'same-site' }, '{}');
  const nonBrowser = await post(json, '{}');
  for (const res of [legit, charset, sameOrigin, nonBrowser]) assert.ok(![403, 415].includes(res.status), `${res.status} ${res.text}`);
  assert.equal(legit.status, nonBrowser.status, 'first-party and non-browser JSON get the route\'s own answer');
  // Safe methods are not affected; the webhook prefix is exempt from the Content-Type rule only.
  assert.equal((await send('/api/health', { headers: { origin: 'https://evil.example' } })).status, 200);
  assert.equal((await send('/api/payments/webhooks/provider', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'signed' })).status, 404);
  assert.equal((await send('/api/payments/webhooks/provider', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body: 'x' })).status, 403);
  assert.match(logs(), /CROSS_ORIGIN_REFUSED/);
});

// ---------------------------------------------------------------------------
// 6. Readiness
// ---------------------------------------------------------------------------

test('readiness with the real (dead) database: /api/ready 503, /api/health still 200', async (t) => {
  const { send } = await serve(t);
  const health = await send('/api/health');
  assert.equal(health.status, 200); assert.equal(JSON.parse(health.text).ok, true);
  const ready = await send('/api/ready');
  assert.equal(ready.status, 503);
  const body = JSON.parse(ready.text);
  assert.equal(body.ready, false);
  assert.deepEqual(body.reasons, ['database', 'schema', 'recovery']);
});

test('readiness: ready only with database, schema and recovery; draining wins; probe timeout and cache', async (t) => {
  let calls = 0; let healthy = true; let clock = 0;
  const readiness = createReadiness({ probeDatabase: async () => { calls += 1; if (!healthy) throw new Error('down'); }, cacheMs: 2000, now: () => clock });
  const { send } = await serve(t, { readiness });
  assert.deepEqual(JSON.parse((await send('/api/ready')).text), { ready: false, reasons: ['schema', 'recovery'] });
  readiness.markSchemaReady();
  assert.deepEqual(JSON.parse((await send('/api/ready')).text).reasons, ['recovery']);
  readiness.markRecoveryFinished();
  const ok = await send('/api/ready');
  assert.equal(ok.status, 200); assert.deepEqual(JSON.parse(ok.text), { ready: true });
  assert.equal(calls, 1, 'probe results are cached');
  healthy = false; clock += 2001;
  const down = await send('/api/ready');
  assert.equal(down.status, 503); assert.deepEqual(JSON.parse(down.text).reasons, ['database']);
  readiness.startDraining();
  healthy = true; clock += 2001;
  const draining = await send('/api/ready');
  assert.equal(draining.status, 503); assert.deepEqual(JSON.parse(draining.text), { ready: false, reasons: ['draining'] });
  assert.equal((await send('/api/health')).status, 200, 'liveness is unaffected by draining');

  const hung = createReadiness({ probeDatabase: () => new Promise(() => {}), timeoutMs: 50 });
  hung.markSchemaReady(); hung.markRecoveryFinished();
  const started = Date.now();
  assert.deepEqual(await hung.check(), { ready: false, reasons: ['database'] });
  assert.ok(Date.now() - started < 1000, 'a hung database probe times out');
});

// ---------------------------------------------------------------------------
// 9. Rate-limit keys
// ---------------------------------------------------------------------------

test('general limit: counted per verified user, per IP otherwise; a forged token counts against the IP', async (t) => {
  const { send } = await serve(t);
  const alice = { authorization: `Bearer ${signAccessToken('user-alice', 'Alice', 'session-a')}` };
  const bob = { authorization: `Bearer ${signAccessToken('user-bob', 'Bob', 'session-b')}` };
  for (let i = 0; i < GENERAL_LIMIT; i += 1) assert.equal((await send('/api/nothing-here', { headers: alice })).status, 404);
  assert.equal((await send('/api/nothing-here', { headers: alice })).status, 429, 'alice exhausted her own budget');
  assert.equal((await send('/api/nothing-here', { headers: bob })).status, 404, 'bob, same IP, is unaffected');
  assert.equal((await send('/api/nothing-here')).status, 404, 'anonymous requests from the IP are unaffected');
  const forged = { authorization: `Bearer ${signAccessToken('user-alice', 'Alice', 'session-a').slice(0, -4)}AAAA` };
  for (let i = 0; i < GENERAL_LIMIT - 1; i += 1) assert.equal((await send('/api/nothing-here', { headers: forged })).status, 404);
  assert.equal((await send('/api/nothing-here')).status, 429, 'forged-token requests were counted against the IP');
  assert.equal((await send('/api/nothing-here', { headers: bob })).status, 404);
  assert.equal((await send('/api/health')).status, 200, 'load-balancer probes skip the general limit');
});

test('refresh limiter: keyed by a verified refresh cookie, forged cookies share the IP bucket; credentials stay per IP', async (t) => {
  const limiters = createRateLimiters({
    verifyAccessToken: (token) => { if (!token.startsWith('valid-')) throw new Error('bad'); return { sub: token }; },
    verifyRefreshToken: (token) => { if (!token.startsWith('signed-')) throw new Error('bad'); return {}; },
    refreshCookieName: 'poker_refresh',
  });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(cookieParser());
  app.post('/refresh', limiters.refresh, (_req, res) => res.status(204).end());
  app.post('/login', limiters.credentials, (_req, res) => res.status(204).end());
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, headers = {}) => (await fetch(base + path, { method: 'POST', headers })).status;
  for (let i = 0; i < REFRESH_LIMIT; i += 1) assert.equal(await post('/refresh', { cookie: 'poker_refresh=signed-one' }), 204);
  assert.equal(await post('/refresh', { cookie: 'poker_refresh=signed-one' }), 429);
  assert.equal(await post('/refresh', { cookie: 'poker_refresh=signed-two' }), 204, 'another session behind the same IP is unaffected');
  for (let i = 0; i < REFRESH_LIMIT; i += 1) assert.equal(await post('/refresh', { cookie: `poker_refresh=forged-${i}` }), 204);
  assert.equal(await post('/refresh', { cookie: 'poker_refresh=forged-new' }), 429, 'random forged cookies cannot mint new buckets');
  assert.equal(await post('/refresh'), 429, 'no cookie: the same IP bucket');
  // Credential endpoints: per IP even with a valid bearer token; IPv6 grouped by /56.
  for (let i = 0; i < CREDENTIAL_LIMIT; i += 1) assert.equal(await post('/login', { authorization: `Bearer valid-${i}`, 'x-forwarded-for': '2001:db8:1:100::1' }), 204);
  assert.equal(await post('/login', { 'x-forwarded-for': '2001:db8:1:1ff::99' }), 429, 'same /56 prefix, same bucket');
  assert.equal(await post('/login', { 'x-forwarded-for': '2001:db8:2::1' }), 204, 'another prefix');
});

// ---------------------------------------------------------------------------
// Admin access log: no query string
// ---------------------------------------------------------------------------

test('admin access log records the path without the query string', async (t) => {
  const { send, logs } = await serve(t);
  const res = await send('/api/admin/hands/abc/audit?token=QUERY-SECRET-123&x=1');
  assert.equal(res.status, 401);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const entry = logs().split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((l) => l.audit === 'ADMIN_REQUEST');
  assert.equal(entry.path, '/api/admin/hands/abc/audit');
  assert.ok(!logs().includes('QUERY-SECRET-123'));
});
