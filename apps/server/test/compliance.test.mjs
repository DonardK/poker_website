/**
 * Server compliance tests. They use no database and no network beyond
 * 127.0.0.1, and they are deterministic in outcome: randomness only varies the
 * hands played, and every assertion is an invariant that must hold for every
 * hand (there are no statistical assertions in this file).
 *
 * What they prove:
 * - TLS: `isSecureTransport` accepts only a real TLS socket or, behind a
 *   trusted proxy, an https X-Forwarded-Proto; production refuses to start
 *   without TLS and refuses plaintext HTTP (426), except the health probe,
 *   and every plaintext engine.io request: the handshake, a long-polling
 *   request of an open session (sid), a WebSocket upgrade with or without a
 *   sid, and a CORS preflight. Development is unchanged; HSTS is sent.
 * - Admin access log: every /api/admin request is logged once with method,
 *   path, IP, user id and status, including 426, 401 and 429 refusals.
 * - The player-entropy shuffle protocol and Math.random are gone, and every
 *   STATE_SNAPSHOT emission goes through the engine leak guard, which fails
 *   closed (nothing is emitted, a security event is reported).
 * - For real engine hands (showdown, fold-out, mucked hands, side pots and
 *   all-in runouts, 30 chained random hands): the persisted audit columns
 *   satisfy the database CHECK constraints and verify, including the outcome
 *   replay; the regulator report re-derives exactly the dealt hole cards and
 *   burns and checks the outcome and the per-table chain link; every dealt
 *   player's participant audit verifies and its response body contains only
 *   that player's own cards, the dealt board and hands tabled at showdown.
 * - Persistence fails closed: a re-sealed record with a forged outcome, a live
 *   settlement that differs from the record, or a settled hand with no audit
 *   is never recorded.
 * - Legacy state: a legacy in-flight hand is voided on load with every stack
 *   restored and chips conserved; legacy WAITING leftovers are purged; a
 *   legacy SHOWDOWN runs Hand Clean-up; each result emits to every viewer
 *   through the leak guard and passes the client card verifier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { TLSSocket } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyAction, applyTimeout, cardProof, completeHand, createTable, decideBotAction, leaveSeat, legalActions,
  participantAudit, projectTableState, sealedAudit, sitDown, sitIn, sitOut, startHand, verifyHandOutcome,
} from '@poker/engine';
import {
  eventPreimage, finalStatePreimage, genesisPreimage, holeCardPositions, holeCardsDigest, UUID_V4, verifyParticipantAudit, verifySealedAudit, verifyTableCards,
} from '@poker/shared';
import { decryptState, encryptState } from '../dist/game/encryption.js';
import {
  assertParticipantAuditRedacted, buildParticipantAudit, handAuditColumns, handContext, regulatorVerification, rowBindingError, sealedAuditContext,
} from '../dist/game/audit.js';
import { upgradeStoredTableState } from '../dist/game/legacy.js';
import { adminAccessLog } from '../dist/routes/admin-access-log.js';
import { guardedTableState } from '../dist/socket/mask.js';
import { createListener, engineTransportGuard, isSecureTransport } from '../dist/transport.js';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[a-f0-9]{64}$/;
const CARD = /^[2-9TJQKA][cdhs]$/;
const cardTokens = (text) => new Set(text.split(/[^0-9A-Za-z]+/).filter((token) => CARD.test(token)));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

test('isSecureTransport: only a real TLS socket, or https from a trusted proxy', (t) => {
  const tls = new TLSSocket(new Socket());
  const plain = new Socket();
  t.after(() => { tls.destroy(); plain.destroy(); });
  const req = (socket, proto) => ({ socket, headers: proto === undefined ? {} : { 'x-forwarded-proto': proto } });
  // [case, socket, X-Forwarded-Proto, trustProxyHops, expected]
  const cases = [
    ['direct TLS', tls, undefined, 0, true],
    ['direct TLS wins over a proxy header', tls, 'http', 1, true],
    ['plain HTTP', plain, undefined, 0, false],
    ['plain HTTP, trusted proxy, no header', plain, undefined, 1, false],
    ['proxied https', plain, 'https', 1, true],
    ['proxied https, two trusted hops', plain, 'https', 2, true],
    ['proxied http', plain, 'http', 1, false],
    ['spoofed https header, no trusted proxy', plain, 'https', 0, false],
    ['list, first value https', plain, 'https, http', 1, true],
    ['list, first value http', plain, 'http, https', 1, false],
    ['list without spaces, first value http', plain, 'http,https', 1, false],
    ['upper case', plain, 'HTTPS', 1, true],
    ['mixed case with padding', plain, '  HtTpS  ', 1, true],
    ['empty header', plain, '', 1, false],
    ['empty first value', plain, ',https', 1, false],
    ['look-alike value', plain, 'https2', 1, false],
    ['wss is not https', plain, 'wss', 1, false],
    ['repeated header (array), first https', plain, ['https', 'http'], 1, true],
    ['repeated header (array), first http', plain, ['http', 'https'], 1, false],
    ['negative hops', plain, 'https', -1, false],
    ['fractional hops', plain, 'https', 0.5, false],
    ['NaN hops', plain, 'https', Number.NaN, false],
  ];
  for (const [name, socket, proto, hops, expected] of cases) assert.equal(isSecureTransport(req(socket, proto), hops), expected, name);
  // Duck typing cannot fake TLS: only an actual TLSSocket counts.
  assert.equal(isSecureTransport({ socket: { encrypted: true }, headers: {} }, 0), false);
});

test('engineTransportGuard: passes TLS requests, refuses and reports everything else', (t) => {
  const tls = new TLSSocket(new Socket());
  const plain = new Socket();
  t.after(() => { tls.destroy(); plain.destroy(); });
  const refused = [];
  const guard = engineTransportGuard(1, (req) => refused.push(req.url));
  const run = (req) => { const calls = []; guard(req, {}, (err) => calls.push(err)); assert.equal(calls.length, 1, 'next is called exactly once'); return calls[0]; };
  assert.equal(run({ socket: tls, headers: {}, url: '/a' }), undefined);
  assert.equal(run({ socket: plain, headers: { 'x-forwarded-proto': 'https' }, url: '/b' }), undefined);
  assert.ok(run({ socket: plain, headers: { 'x-forwarded-proto': 'http' }, url: '/c' }) instanceof Error);
  assert.ok(run({ socket: plain, headers: {}, url: '/d' }) instanceof Error);
  assert.deepEqual(refused, ['/c', '/d']);
  // Without a trusted proxy the header is ignored.
  const direct = engineTransportGuard(0, (req) => refused.push(req.url));
  const calls = []; direct({ socket: plain, headers: { 'x-forwarded-proto': 'https' }, url: '/e' }, {}, (err) => calls.push(err));
  assert.ok(calls[0] instanceof Error); assert.deepEqual(refused, ['/c', '/d', '/e']);
});

test('createListener: http without files, https with both, fails fast on partial or missing files', () => {
  const plain = createListener(() => {}, {});
  assert.ok(plain.server instanceof HttpServer); assert.ok(!(plain.server instanceof HttpsServer)); assert.equal(plain.secure, false);
  assert.throws(() => createListener(() => {}, { certFile: 'cert.pem' }), /both TLS_CERT_FILE and TLS_KEY_FILE/);
  assert.throws(() => createListener(() => {}, { keyFile: 'key.pem' }), /both TLS_CERT_FILE and TLS_KEY_FILE/);
  const missing = join(tmpdir(), `missing-${randomUUID()}.pem`);
  assert.throws(() => createListener(() => {}, { certFile: missing, keyFile: missing }), { code: 'ENOENT' });
});

/** Environment for a child server process. Every secret is a throwaway, so no child can reach a real database. */
function childEnv(overrides) {
  const env = { ...process.env };
  for (const key of ['TLS_CERT_FILE', 'TLS_KEY_FILE', 'DIRECT_URL', 'REDIS_URL', 'NODE_TEST_CONTEXT']) delete env[key];
  return {
    ...env,
    DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:9/none?sslmode=require&sslaccept=strict',
    REDIS_URL: '',
    GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    ...overrides,
  };
}

const PROD = { NODE_ENV: 'production', CLIENT_ORIGIN: 'https://poker.example', TRUST_PROXY_HOPS: '1', TLS_CERT_FILE: '', TLS_KEY_FILE: '' };
const dist = (path) => pathToFileURL(join(serverDir, 'dist', path)).href;

/**
 * Run an ES module in a fresh Node process. Returns the JSON it prints after
 * "RESULT ", and every JSON log line (pino writes JSON to stdout in production).
 */
function runChildWithLogs(t, source, env) {
  const dir = mkdtempSync(join(tmpdir(), 'poker-compliance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'child.mjs');
  writeFileSync(file, source);
  const run = spawnSync(process.execPath, [file], { cwd: serverDir, env, encoding: 'utf8', timeout: 60_000 });
  const lines = (run.stdout ?? '').split(/\r?\n/);
  const line = lines.find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no result (exit ${run.status}): ${run.stderr || run.stdout}`);
  const logs = lines.filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { result: JSON.parse(line.slice('RESULT '.length)), logs };
}
const runChild = (t, source, env) => runChildWithLogs(t, source, env).result;

test('production refuses to start without TLS; TLS files are both-or-neither', (t) => {
  const probe = `
    try { const { tlsEnabled } = await import(${JSON.stringify(dist('config.js'))}); console.log('RESULT ' + JSON.stringify({ ok: true, tlsEnabled })); }
    catch (err) { console.log('RESULT ' + JSON.stringify({ ok: false, error: err.message })); }`;
  const noTls = runChild(t, probe, childEnv({ ...PROD, TRUST_PROXY_HOPS: '0' }));
  assert.equal(noTls.ok, false); assert.match(noTls.error, /Production requires TLS/);
  const certOnly = runChild(t, probe, childEnv({ NODE_ENV: 'development', TLS_CERT_FILE: 'cert.pem' }));
  assert.equal(certOnly.ok, false); assert.match(certOnly.error, /both TLS_CERT_FILE and TLS_KEY_FILE/);
  const keyOnly = runChild(t, probe, childEnv({ ...PROD, TLS_KEY_FILE: 'key.pem' }));
  assert.equal(keyOnly.ok, false); assert.match(keyOnly.error, /both TLS_CERT_FILE and TLS_KEY_FILE/);
  assert.deepEqual(runChild(t, probe, childEnv(PROD)), { ok: true, tlsEnabled: false });
  assert.deepEqual(runChild(t, probe, childEnv({ ...PROD, TRUST_PROXY_HOPS: '0', TLS_CERT_FILE: 'c.pem', TLS_KEY_FILE: 'k.pem' })), { ok: true, tlsEnabled: true });
});

/** Child that serves createApp() + Socket.io exactly as index.ts wires them, then issues the given requests. */
const serveAndProbe = (requests, ca) => `
  import { request as httpRequest } from 'node:http';
  import { request as httpsRequest } from 'node:https';
  const { createApp } = await import(${JSON.stringify(dist('app.js'))});
  const { createSocketServer } = await import(${JSON.stringify(dist('socket/index.js'))});
  const { createListener } = await import(${JSON.stringify(dist('transport.js'))});
  const { env } = await import(${JSON.stringify(dist('config.js'))});
  const { tableManager } = await import(${JSON.stringify(dist('game/manager.js'))});
  const { server, secure } = createListener(createApp(), { certFile: env.TLS_CERT_FILE, keyFile: env.TLS_KEY_FILE });
  const io = createSocketServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ca = ${JSON.stringify(ca ?? null)};
  const send = ({ path, method = 'GET', headers = {}, scheme = secure ? 'https' : 'http' }) => new Promise((resolve) => {
    const request = scheme === 'https' ? httpsRequest : httpRequest;
    const req = request({ host: '127.0.0.1', port, path, method, headers, ...(scheme === 'https' ? { ca } : {}) }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, hsts: res.headers['strict-transport-security'] ?? null, upgrade: res.headers.upgrade ?? null, body: body.slice(0, 200) }));
    });
    req.on('error', (err) => resolve({ status: null, error: err.code ?? err.message }));
    req.end();
  });
  const results = [];
  for (const r of ${JSON.stringify(requests)}) results.push(await send(r));
  tableManager.stop();
  io.close();
  process.stdout.write('RESULT ' + JSON.stringify({ secure, results }) + '\\n', () => process.exit(0));`;

const HANDSHAKE = '/socket.io/?EIO=4&transport=polling';
const XFP = (proto) => ({ 'x-forwarded-proto': proto });
/** engine.io's response when a middleware refuses a request (build/server.js abortRequest). */
const ENGINE_REFUSED = JSON.stringify({ code: 3, message: 'Bad request' });

test('production behind a TLS proxy: plaintext HTTP gets 426, Socket.io handshakes need TLS, health probe exempt, HSTS on', (t) => {
  const requests = [
    { path: '/api/health' },
    { path: '/api/tables' },
    { path: '/api/tables', headers: XFP('http') },
    { path: '/api/tables', headers: XFP('https') },
    { path: '/api/auth/login', method: 'POST', headers: { 'content-type': 'application/json' } },
    { path: `/api/admin/hands/${randomUUID()}/audit` },
    { path: `/api/admin/hands/${randomUUID()}/audit`, headers: { ...XFP('https'), authorization: 'Bearer not-a-token' } },
    { path: HANDSHAKE },
    { path: HANDSHAKE, headers: XFP('http') },
    { path: HANDSHAKE, headers: XFP('https') },
    { path: HANDSHAKE, headers: { ...XFP('https'), origin: 'https://poker.example' } },
    { path: HANDSHAKE, headers: { ...XFP('https'), origin: 'https://evil.example' } },
    { path: '/api/health', method: 'POST' },
  ];
  const { secure, results } = runChild(t, serveAndProbe(requests), childEnv(PROD));
  assert.equal(secure, false);
  const [health, plain, proxiedHttp, proxiedHttps, login, adminPlain, adminProxied, hsPlain, hsHttp, hsHttps, hsOrigin, hsEvil, healthPost] = results;
  assert.equal(health.status, 200, 'GET /api/health is exempt for load-balancer probes');
  for (const [name, r] of Object.entries({ plain, proxiedHttp, login, adminPlain, healthPost })) {
    assert.equal(r.status, 426, name);
    assert.deepEqual(JSON.parse(r.body), { error: 'HTTPS is required' });
    assert.equal(r.upgrade, 'TLS/1.2, HTTP/1.1');
  }
  assert.equal(proxiedHttps.status, 401, 'proxied https reaches authentication');
  assert.equal(adminProxied.status, 401, 'admin routes require authentication');
  for (const r of [health, plain, proxiedHttps]) assert.match(r.hsts ?? '', /max-age=\d+/, 'helmet HSTS header');
  // The engine.io transport guard refuses plaintext handshakes before allowRequest runs.
  for (const r of [hsPlain, hsHttp]) { assert.equal(r.status, 400); assert.equal(r.body, ENGINE_REFUSED); }
  assert.equal(hsHttps.status, 200); assert.match(hsHttps.body, /^0\{"sid"/);
  assert.equal(hsOrigin.status, 200);
  assert.equal(hsEvil.status, 403, 'the origin check still applies');
});

/**
 * Child: production server behind a simulated TLS proxy. It opens an
 * engine.io session over "TLS" (X-Forwarded-Proto: https), then sends
 * follow-up requests for that session without TLS, and finally controls over
 * TLS that prove the session was still open.
 */
const engineSessionProbe = `
  import { request as httpRequest } from 'node:http';
  import { randomBytes } from 'node:crypto';
  const { createApp } = await import(${JSON.stringify(dist('app.js'))});
  const { createSocketServer } = await import(${JSON.stringify(dist('socket/index.js'))});
  const { createListener } = await import(${JSON.stringify(dist('transport.js'))});
  const { tableManager } = await import(${JSON.stringify(dist('game/manager.js'))});
  const { server } = createListener(createApp(), {});
  const io = createSocketServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const https = { 'x-forwarded-proto': 'https' };
  const http = { 'x-forwarded-proto': 'http' };
  const send = ({ path, method = 'GET', headers = {}, body }) => new Promise((resolve) => {
    const extra = body === undefined ? {} : { 'content-type': 'text/plain;charset=UTF-8', 'content-length': Buffer.byteLength(body) };
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { ...headers, ...extra } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text.slice(0, 300), type: res.headers['content-type'] ?? null }));
    });
    // A request that is not refused may be held open as a long poll; never wait for it.
    req.setTimeout(5000, () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (err) => resolve({ status: null, error: err.message }));
    req.end(body);
  });
  const upgrade = (path, headers = {}) => new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
    req.on('response', (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: text })); });
    req.setTimeout(5000, () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (err) => resolve({ status: null, error: err.message }));
    req.end();
  });
  const results = {};
  results.handshake = await send({ path: '/socket.io/?EIO=4&transport=polling', headers: https });
  const sid = JSON.parse(results.handshake.body.slice(1)).sid;
  const poll = '/socket.io/?EIO=4&transport=polling&sid=' + encodeURIComponent(sid);
  const ws = '/socket.io/?EIO=4&transport=websocket&sid=' + encodeURIComponent(sid);
  results.pollGetPlain = await send({ path: poll });
  results.pollGetHttp = await send({ path: poll, headers: http });
  results.pollPostPlain = await send({ path: poll, method: 'POST', body: '3' });
  results.pollPostHttp = await send({ path: poll, method: 'POST', headers: http, body: '3' });
  results.upgradePlain = await upgrade(ws);
  results.upgradeHttp = await upgrade(ws, http);
  results.freshUpgradePlain = await upgrade('/socket.io/?EIO=4&transport=websocket');
  const preflight = { origin: 'https://poker.example', 'access-control-request-method': 'POST' };
  results.preflightPlain = await send({ path: poll, method: 'OPTIONS', headers: preflight });
  results.preflightHttps = await send({ path: poll, method: 'OPTIONS', headers: { ...https, ...preflight } });
  results.clientFile = await send({ path: '/socket.io/socket.io.js', headers: https });
  // Controls over TLS: the same session is still open and its requests pass the guard.
  results.pollPostHttps = await send({ path: poll, method: 'POST', headers: https, body: '3' });
  results.upgradeHttps = await upgrade(ws, https);
  tableManager.stop();
  io.close();
  process.stdout.write('RESULT ' + JSON.stringify({ sid, results }) + '\\n', () => process.exit(0));`;

test('production behind a TLS proxy: every engine.io request of a session needs TLS (polling with sid, WebSocket upgrade, preflight)', (t) => {
  const { result: { sid, results: r }, logs } = runChildWithLogs(t, engineSessionProbe, childEnv(PROD));
  assert.equal(r.handshake.status, 200, 'handshake with X-Forwarded-Proto: https succeeds');
  assert.ok(typeof sid === 'string' && sid.length > 0);
  for (const name of ['pollGetPlain', 'pollGetHttp', 'pollPostPlain', 'pollPostHttp', 'preflightPlain']) {
    assert.equal(r[name].status, 400, `${name} is refused`);
    assert.equal(r[name].body, ENGINE_REFUSED, name);
  }
  for (const name of ['upgradePlain', 'upgradeHttp', 'freshUpgradePlain']) {
    assert.equal(r[name].status, 400, `${name} is refused, never switched to WebSocket`);
    assert.equal(r[name].body, 'Bad request', name);
  }
  // The refusals were about transport: the same session over TLS still works.
  assert.equal(r.pollPostHttps.status, 200); assert.equal(r.pollPostHttps.body, 'ok');
  assert.equal(r.upgradeHttps.status, 101, 'WebSocket upgrade over TLS is accepted');
  assert.equal(r.preflightHttps.status, 204, 'CORS preflight over TLS is answered');
  // The Socket.io client file is not served (the web app bundles it).
  assert.equal(r.clientFile.status, 400); assert.doesNotMatch(r.clientFile.type ?? '', /javascript/);
  // Each refusal is a logged security event; the logged path never carries the session id.
  const refusals = logs.filter((l) => l.security === 'INSECURE_TRANSPORT');
  assert.equal(refusals.length, 8);
  for (const l of refusals) { assert.equal(l.path, '/socket.io/'); assert.ok(!JSON.stringify(l).includes(sid)); }
});

/** Child: production app behind a simulated TLS proxy; issues the given requests and prints their statuses. */
const adminLogProbe = (requests) => `
  import { request as httpRequest } from 'node:http';
  const { createApp } = await import(${JSON.stringify(dist('app.js'))});
  const { createListener } = await import(${JSON.stringify(dist('transport.js'))});
  const { tableManager } = await import(${JSON.stringify(dist('game/manager.js'))});
  const { server } = createListener(createApp(), {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const send = ({ path, method = 'GET', headers = {} }) => new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (err) => resolve(err.message));
    req.end();
  });
  const statuses = [];
  for (const r of ${JSON.stringify(requests)}) statuses.push(await send(r));
  // Margin for the server's 'finish' events; pino flushes its buffer on exit.
  await new Promise((resolve) => setTimeout(resolve, 100));
  tableManager.stop();
  process.stdout.write('RESULT ' + JSON.stringify({ statuses }) + '\\n', () => process.exit(0));`;

test('admin access log: every /api/admin request is logged with its outcome, including 426, 401 and 429', (t) => {
  const audit = `/api/admin/hands/${randomUUID()}/audit`;
  const https = XFP('https');
  const requests = [
    { path: audit },                                                                  // plaintext: TLS gate, 426
    { path: audit, headers: { ...https, 'x-forwarded-for': '198.51.100.7', authorization: 'Bearer not-a-token' } }, // bad token, 401
    ...Array.from({ length: 30 }, () => ({ path: audit, headers: https })),           // no token, 401 (30 per minute)
    { path: audit, headers: https },                                                  // 31st from this IP: 429
    { path: '/api/admin/unknown', method: 'POST', headers: https },                   // rate limited as well: 429
    { path: '/api/tables', headers: https },                                          // not an admin request
  ];
  const { result: { statuses }, logs } = runChildWithLogs(t, adminLogProbe(requests), childEnv(PROD));
  assert.deepEqual(statuses, [426, 401, ...Array(30).fill(401), 429, 429, 401]);
  const entries = logs.filter((l) => l.audit === 'ADMIN_REQUEST');
  assert.equal(entries.length, statuses.length - 1, 'one entry per /api/admin request, none for other paths');
  assert.deepEqual(entries.map((e) => e.status), statuses.slice(0, -1), 'each entry carries the status that was sent');
  entries.forEach((e, i) => {
    assert.deepEqual(Object.keys(e).filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k)).sort(),
      ['audit', 'completed', 'durationMs', 'ip', 'method', 'path', 'status', 'userId']);
    assert.equal(e.method, requests[i].method ?? 'GET');
    assert.equal(e.path, requests[i].path);
    assert.equal(e.userId, null, 'no request here authenticates');
    assert.equal(e.completed, true);
    assert.equal(e.level, 40, 'refusals are warnings');
  });
  assert.equal(entries[1].ip, '198.51.100.7', 'the client IP honours TRUST_PROXY_HOPS');
  assert.match(entries[0].ip, /127\.0\.0\.1$/);
});

test('admin access log middleware: user id once known, status on finish, one entry per request, aborted requests', () => {
  const entries = [];
  const log = { info: (entry, msg) => entries.push({ level: 'info', entry, msg }), warn: (entry, msg) => entries.push({ level: 'warn', entry, msg }) };
  const middleware = adminAccessLog(log);
  const request = (overrides = {}) => ({ method: 'GET', originalUrl: `/api/admin/hands/x/audit?${'q'.repeat(400)}`, ip: '203.0.113.9', ...overrides });
  const response = () => Object.assign(new EventEmitter(), { statusCode: 200 });
  const run = (req, res) => { let nexts = 0; middleware(req, res, () => { nexts += 1; }); assert.equal(nexts, 1); assert.equal(entries.length, logged); };
  let logged = 0;

  // Served: requireAuth sets the user id on the same request object before the response finishes.
  let req = request(); let res = response();
  run(req, res);
  req.userId = 'admin-user'; res.statusCode = 200;
  res.emit('finish'); res.emit('close');
  logged += 1;
  assert.equal(entries.length, logged, 'finish followed by close logs once');
  assert.equal(entries[0].level, 'info');
  assert.deepEqual({ ...entries[0].entry, durationMs: 0 }, {
    audit: 'ADMIN_REQUEST', method: 'GET', path: req.originalUrl.slice(0, 200), ip: '203.0.113.9', userId: 'admin-user', status: 200, completed: true, durationMs: 0,
  });
  assert.equal(entries[0].entry.path.length, 200, 'the path is truncated');

  // Refused before authentication: 401 and 429 are logged with no user id.
  for (const status of [401, 429]) {
    req = request({ method: 'POST', ip: undefined }); res = response();
    run(req, res);
    res.statusCode = status; res.emit('finish'); res.emit('close');
    logged += 1;
    const { level, entry } = entries.at(-1);
    assert.equal(level, 'warn'); assert.equal(entry.status, status); assert.equal(entry.userId, null); assert.equal(entry.ip, null); assert.equal(entry.method, 'POST');
  }

  // The connection closed before the response completed.
  req = request(); res = response();
  run(req, res);
  res.emit('close'); res.emit('finish');
  logged += 1;
  assert.equal(entries.length, logged);
  assert.equal(entries.at(-1).level, 'warn'); assert.equal(entries.at(-1).entry.completed, false); assert.equal(entries.at(-1).entry.status, null);
});

test('development behaviour is unchanged: no TLS requirement, HSTS still sent', (t) => {
  const requests = [{ path: '/api/tables' }, { path: '/api/health' }, { path: HANDSHAKE }, { path: HANDSHAKE, headers: { origin: 'http://evil.example' } }];
  const env = childEnv({ NODE_ENV: 'development', CLIENT_ORIGIN: 'http://localhost:3000', TRUST_PROXY_HOPS: '0' });
  const { secure, results: [tables, health, hs, hsEvil] } = runChild(t, serveAndProbe(requests), env);
  assert.equal(secure, false);
  assert.equal(tables.status, 401); assert.equal(health.status, 200); assert.equal(hs.status, 200); assert.equal(hsEvil.status, 403);
  assert.match(tables.hsts ?? '', /max-age=\d+/);
});

test('production with direct TLS (node:https): TLS requests pass, plaintext cannot connect', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const certFile = join(dir, 'cert.pem'); const keyFile = join(dir, 'key.pem');
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { encoding: 'utf8' });
  if (gen.error || gen.status !== 0 || !existsSync(certFile)) { t.skip(`openssl unavailable: ${gen.error?.message ?? gen.stderr}`); return; }
  const requests = [
    { path: '/api/tables' },
    { path: '/api/tables', headers: XFP('http') },
    { path: '/api/health' },
    { path: HANDSHAKE },
    { path: '/api/tables', scheme: 'http' },
  ];
  const env = childEnv({ ...PROD, TRUST_PROXY_HOPS: '0', TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile });
  const { secure, results: [tables, spoofedHttp, health, hs, plaintext] } = runChild(t, serveAndProbe(requests, readFileSync(certFile, 'utf8')), env);
  assert.equal(secure, true);
  assert.equal(tables.status, 401, 'TLS request passes the transport gate');
  assert.equal(spoofedHttp.status, 401, 'a real TLS socket is secure regardless of headers');
  assert.equal(health.status, 200); assert.match(tables.hsts ?? '', /max-age=\d+/);
  assert.equal(hs.status, 200, 'Socket.io handshake over TLS');
  assert.notEqual(plaintext.status, 200, 'plaintext HTTP never gets a response from the TLS listener');
});

// ---------------------------------------------------------------------------
// Removed protocol, Math.random, guarded emissions, cash-outs
// ---------------------------------------------------------------------------

const sourceFiles = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);

test('static scan: no Math.random, no player-entropy shuffle protocol, every emitted snapshot is guarded', () => {
  const src = join(serverDir, 'src');
  const files = sourceFiles(src);
  assert.ok(files.length >= 20, 'scanned the server sources');
  const banned = [/Math\.random/, /SHUFFLE_ENTROPY/, /verifyShuffleAudit/, /ShuffleAudit/, /prepareShuffle/, /finalizeShuffle/, /contributeShuffleEntropy/, /shuffleEntropy/,
    /toPublicTableState/, /['"`]STATE_SNAPSHOT['"`]/];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) assert.doesNotMatch(text, pattern, `${relative(src, file)} contains ${pattern}`);
  }
  // Every STATE_SNAPSHOT emission sends a value produced by the guarded projection.
  const emits = files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\.emit\(\s*SOCKET_EVENTS\.STATE_SNAPSHOT\s*,\s*([^)]*?)\s*\)/g)].map((m) => [relative(src, file), m[1]]));
  assert.ok(emits.length >= 3, 'found the snapshot emissions');
  for (const [file, arg] of emits) assert.match(arg, /^(state|snap)$/, `${file} emits an unguarded value: ${arg}`);
  const manager = readFileSync(join(src, 'game', 'manager.ts'), 'utf8');
  assert.match(manager, /const state = this\.project\(table, socket\.data\.userId\);\s*if \(state\) socket\.emit\(SOCKET_EVENTS\.STATE_SNAPSHOT, state\)/);
  assert.match(manager, /return this\.project\(table, viewerUserId\);/);
  assert.match(manager, /return guardedTableState\(table, viewerUserId,/);
  assert.match(readFileSync(join(src, 'socket', 'mask.ts'), 'utf8'), /return projectTableState\(table, viewerUserId\);/);
  const socketIndex = readFileSync(join(src, 'socket', 'index.ts'), 'utf8');
  const snaps = [...socketIndex.matchAll(/const snap = await ([\w.]+)\(/g)].map((m) => m[1]);
  assert.ok(snaps.length >= 2); for (const source of snaps) assert.equal(source, 'tableManager.snapshot');
});

test('static scan: cash-outs are paid only inside TableManager.mutate, and stored with none pending', () => {
  const src = join(serverDir, 'src');
  const users = sourceFiles(src).filter((file) => /\bcashOuts\b/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(users.map((file) => relative(src, file).replaceAll('\\', '/')), ['game/manager.ts']);
  const manager = readFileSync(join(src, 'game', 'manager.ts'), 'utf8');
  assert.equal([...manager.matchAll(/\bcashOuts\b/g)].length, 2, 'one payment loop and one reset');
  const mutate = manager.slice(manager.indexOf('async mutate('), manager.indexOf('async tryStart('));
  // Pay from the result, clear, then write the state, all inside the one transaction callback.
  assert.match(mutate, /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*for \(const cash of result\.cashOuts\) \{\s*await tx\.user\.updateMany\([\s\S]*?\}\s*result\.cashOuts = \[\];[\s\S]*stateCiphertext: encryptState\(result,[\s\S]*\}, \{ maxWait/);
  // Loading never pays: the load path does not touch the wallet.
  const load = manager.slice(manager.indexOf('private async load('), manager.indexOf('async get('));
  assert.doesNotMatch(load, /bankroll|updateMany|\.update\(/);
});

function seated(stacks, { tableId = 'compliance-table', bots = false } = {}) {
  let t = createTable({ tableId, name: 'Compliance', maxSeats: 9, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  const profiles = ['TAG', 'LOOSE_PASSIVE', 'MANIAC', 'GTO'];
  stacks.forEach((buyIn, i) => {
    t = sitDown(t, i, { userId: `user-${i}`, username: `Player${i}`, kind: bots ? 'BOT' : 'HUMAN', botProfile: bots ? profiles[i % 4] : null, avatarHue: 0, buyIn, skipBuyInCheck: true });
  });
  return t;
}

test('guarded projection: each viewer sees only their own cards; a leak is refused and reported, never emitted', () => {
  const t = startHand(seated([1000, 1000, 1000]));
  const events = [];
  const onLeak = (event) => events.push(event);
  for (const viewer of ['user-0', 'user-1', 'user-2', null]) {
    const state = guardedTableState(t, viewer, onLeak);
    assert.ok(state);
    for (const p of state.players.filter((p) => !p.empty)) assert.equal(p.holeCards !== null, p.userId === viewer, `${viewer} sees seat ${p.seatIndex}`);
  }
  assert.equal(events.length, 0);

  // Simulated defect: a log line naming seat 1's hole card.
  const leaky = structuredClone(t);
  leaky.log.push({ seq: leaky.logSeq + 1, seatIndex: null, username: 'Table', text: `debug ${leaky.players[1].holeCards[0]}`, at: new Date().toISOString() });
  assert.equal(guardedTableState(leaky, 'user-0', onLeak), null);
  assert.equal(guardedTableState(leaky, null, onLeak), null);
  assert.ok(guardedTableState(leaky, 'user-1', onLeak), 'the owner may see their own card');
  // Simulated defect: flop cards on the board during the pre-flop round.
  const early = structuredClone(t);
  early.board = early.deck.slice(0, 3);
  assert.equal(guardedTableState(early, 'user-2', onLeak), null);

  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.viewerUserId), ['user-0', null, 'user-2']);
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ['handNumber', 'phase', 'reason', 'revision', 'tableId', 'viewerUserId']);
    assert.equal(e.tableId, 'compliance-table'); assert.equal(e.revision, t.revision); assert.equal(e.handNumber, 1); assert.equal(e.phase, 'PREFLOP');
    assert.match(e.reason, /Refusing to emit/);
    assert.equal(cardTokens(JSON.stringify(e)).size, 0, 'the security event carries no card value');
  }
  // Any other failure propagates instead of being swallowed.
  assert.throws(() => guardedTableState({ ...t, players: null }, 'user-0', onLeak), TypeError);
});

// ---------------------------------------------------------------------------
// Audit trail: persistence columns, regulator and participant routes
// ---------------------------------------------------------------------------

/** Drive a hand to SHOWDOWN. `choose` returns an intent, 'TIMEOUT', or { sitOut: userId }. */
function play(t, choose) {
  for (let turn = 0; t.phase !== 'SHOWDOWN'; turn++) {
    // Loop guard only: a legal hand is far shorter (every raise costs at least a big blind).
    assert.ok(turn < 20_000, 'hand did not finish');
    const legal = legalActions(t, t.toActSeat);
    const choice = choose(t, legal, turn);
    if (choice === 'TIMEOUT') t = applyTimeout(t);
    else if (choice.sitOut) t = sitOut(t, choice.sitOut);
    else t = applyAction(t, t.players[t.toActSeat].userId, choice);
  }
  return t;
}
const passive = (_t, legal) => ({ action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });

/** The HandPlayer rows persistHand writes for a settled table (seat and showedCards). */
const storedPlayers = (t) => t.players.filter((p) => p?.holeCards).map((p) => ({ seatIndex: p.seatIndex, showedCards: p.showedCards }));
/** The participant route's request for a seat: requested table and hand, caller, caller's seat. */
const requestFor = (t, seat) => ({ tableId: t.tableId, handNumber: t.handNumber, userId: t.players[seat].userId, viewerSeat: seat });

/** Recompute every event hash and the final state hash, as a forger with the public preimages could. */
function reseal(record) {
  let prev = sha256(genesisPreimage(record));
  for (const event of record.events) {
    event.prevHash = prev;
    const { hash: _old, ...body } = event;
    event.hash = sha256(eventPreimage(record.handId, body));
    prev = event.hash;
  }
  record.finalStateHash = sha256(finalStatePreimage(record.handId, prev, record.events.length, record.settledAt));
}

/**
 * Exactly what TableManager.persistHand, the participant route and the
 * regulator route do with a settled hand, with the database replaced by a
 * JSON round trip. Asserts every compliance property and returns the record.
 * `previous` is the table's preceding audited hand, as the regulator route
 * queries it (null for the table's first audited hand).
 */
async function verifyHandAsRoutesDo(t, previous = null) {
  assert.equal(t.phase, 'SHOWDOWN');
  // persistHand: audit columns (the migration's CHECK constraints hold).
  const cols = await handAuditColumns(t);
  assert.match(cols.handUuid, UUID_V4);
  assert.match(cols.deckCommitment, HEX64);
  assert.match(cols.finalStateHash, HEX64);
  assert.equal(cols.handUuid, t.fairness.handId);
  assert.equal(cols.deckCommitment, t.fairness.deckCommitment);
  assert.equal(cols.finalStateHash, t.audit.finalStateHash);
  assert.deepEqual(cols.auditRecord, t.audit);
  assert.match(cols.auditSealed, /^v1\./);
  // Ciphertext only: no plaintext structure or secret is visible at rest.
  assert.ok(!cols.auditSealed.includes('"deck"') && !cols.auditSealed.includes(t.fairness.deckSalt) && !cols.auditSealed.includes(t.fairness.salts[0]));

  // AAD separation: the sealed audit decrypts only under its own context.
  const context = sealedAuditContext(t.tableId, t.handNumber);
  assert.equal(context, `hand:${t.tableId}:${t.handNumber}:sealed-audit`);
  assert.throws(() => decryptState(cols.auditSealed, handContext(t.tableId, t.handNumber)));
  assert.throws(() => decryptState(cols.auditSealed, `${handContext(t.tableId, t.handNumber)}:seat:${t.dealtSeats[0]}`));
  assert.throws(() => decryptState(cols.auditSealed, sealedAuditContext(t.tableId, t.handNumber + 1)));

  // Database round trip, then the routes' reads.
  const row = { tableId: t.tableId, handNumber: t.handNumber, handUuid: cols.handUuid, deckCommitment: cols.deckCommitment, finalStateHash: cols.finalStateHash };
  const record = JSON.parse(JSON.stringify(cols.auditRecord));
  const sealed = decryptState(cols.auditSealed, context);
  assert.deepEqual(sealed, sealedAudit(t.fairness));
  assert.equal(rowBindingError(row, record), null);

  // Regulator route: card integrity derives exactly the engine's hole cards and burns; outcome and chain verify.
  const verification = await regulatorVerification(row, record, sealed, previous);
  assert.equal(verification.ok, true, verification.reason);
  assert.equal(verification.reason, undefined);
  assert.deepEqual(verification.holeCards, t.dealtSeats.map((seatIndex) => ({ seatIndex, cards: t.players[seatIndex].holeCards })));
  assert.deepEqual(verification.burns, t.burns);
  assert.deepEqual(verification.outcome, { ok: true });
  assert.deepEqual(verification.tableChain, { ok: true, previousHandNumber: previous?.handNumber ?? null });

  // Participant route for every dealt seat.
  const board = t.board;
  const shownSeats = t.dealtSeats.filter((s) => t.players[s].showedCards);
  for (const seat of t.dealtSeats) {
    const audit = await buildParticipantAudit(record, sealed, requestFor(t, seat), storedPlayers(t));
    assert.deepEqual(audit, participantAudit(record, sealed, seat), 'the route returns the engine redaction');
    const own = t.players[seat].holeCards;
    const check = await verifyParticipantAudit(audit, { tableId: t.tableId, handNumber: t.handNumber, userId: t.players[seat].userId, handId: t.fairness.handId, merkleRoot: t.fairness.root, deckCommitment: t.fairness.deckCommitment,
      holeCardsDigest: await holeCardsDigest(t.fairness.handId, own) });
    assert.equal(check.ok, true, check.reason);

    // JSON token check on the exact response body: only own cards, the dealt board and tabled hands.
    const body = JSON.stringify({ audit });
    const allowed = new Set([...own, ...board, ...shownSeats.flatMap((s) => t.players[s].holeCards)]);
    const tokens = cardTokens(body);
    assert.deepEqual([...tokens].sort(), [...allowed].sort(), `seat ${seat} sees exactly its entitled cards`);
    const mucked = t.dealtSeats.filter((s) => s !== seat && !t.players[s].showedCards).flatMap((s) => t.players[s].holeCards);
    for (const card of mucked) assert.ok(!tokens.has(card), `mucked ${card} leaked to seat ${seat}`);
    for (const card of t.burns) assert.ok(!tokens.has(card), `burn ${card} leaked to seat ${seat}`);
    for (const card of t.deck) assert.ok(!tokens.has(card), `undealt ${card} leaked to seat ${seat}`);
    // No sealed material: deck salt, sealed keys, or salts for unopened positions.
    assert.ok(!body.includes(sealed.deckSalt), 'deck salt leaked');
    for (const key of ['"deck":', '"deckSalt":', '"merkleSalts":', '"salts":', '"levels":', '"sealed":']) assert.ok(!body.includes(key), `${key} in participant response`);
    const opened = new Set(audit.proofs.map((p) => p.index));
    sealed.merkleSalts.forEach((salt, i) => { if (!opened.has(i)) assert.ok(!body.includes(salt), `Merkle salt ${i} leaked`); });
  }
  // A seat that was not dealt in gets nothing.
  const outsider = [...Array(t.maxSeats).keys()].find((s) => !t.dealtSeats.includes(s));
  await assert.rejects(buildParticipantAudit(record, sealed, { ...requestFor(t, t.dealtSeats[0]), viewerSeat: outsider }, storedPlayers(t)));
  return { record, sealed, cols, row };
}

test('audit columns, regulator and participant audits verify for real hands; no hidden card reaches a participant', async () => {
  // Three players check down to showdown.
  let t = play(startHand(seated([1000, 1000, 1000])), passive);
  assert.ok(t.dealtSeats.every((s) => t.players[s].showedCards));
  await verifyHandAsRoutesDo(t);

  // Everyone folds to the big blind: no board, nothing tabled.
  t = play(startHand(seated([1000, 1000, 1000, 1000])), (_t, legal) => ({ action: legal.actions.includes('FOLD') ? 'FOLD' : 'CHECK' }));
  assert.equal(t.board.length, 0); assert.ok(t.dealtSeats.every((s) => !t.players[s].showedCards));
  await verifyHandAsRoutesDo(t);

  // Flop bet, even seats fold (mucked), the rest show down.
  t = play(startHand(seated([1000, 1000, 1000, 1000])), (tt, legal) => {
    if (tt.phase === 'FLOP' && legal.actions.includes('BET')) return { action: 'BET', amount: legal.minBet };
    if (tt.phase === 'FLOP' && legal.actions.includes('FOLD') && tt.toActSeat % 2 === 0) return { action: 'FOLD' };
    return passive(tt, legal);
  });
  assert.ok(t.dealtSeats.some((s) => !t.players[s].showedCards), 'a mucked hand');
  assert.ok(t.dealtSeats.filter((s) => t.players[s].showedCards).length >= 2, 'a showdown');
  await verifyHandAsRoutesDo(t);

  // Short stacks all in pre-flop: side pots and an all-in runout.
  t = play(startHand(seated([60, 150, 1000, 1000])), (tt, legal) =>
    tt.players[tt.toActSeat].stack <= 150 && legal.actions.includes('ALL_IN') ? { action: 'ALL_IN' } : passive(tt, legal));
  assert.ok(t.awards.length >= 2, 'side pots were built');
  assert.equal(t.board.length, 5);
  await verifyHandAsRoutesDo(t);

  // The blinds put both players all in: the hand settles inside startHand.
  t = startHand(seated([5, 10]));
  assert.equal(t.phase, 'SHOWDOWN');
  await verifyHandAsRoutesDo(t);
});

test('30 chained random hands (bots, time-outs, sit-outs, re-buys) all verify; the per-table hash chain links them', async () => {
  let t = seated([400, 1000, 250, 1000, 600, 1000], { bots: true, tableId: 'compliance-chain' });
  let previous = null;
  const handIds = new Set();
  for (let hand = 1; hand <= 30; hand++) {
    const sittingOut = [];
    t = play(startHand(t), (tt, legal, turn) => {
      if (turn % 13 === 12) return 'TIMEOUT';
      if (hand % 5 === 0 && turn === 2) { sittingOut.push(tt.players[tt.toActSeat].userId); return { sitOut: tt.players[tt.toActSeat].userId }; }
      return decideBotAction(tt).intent;
    });
    // The regulator route compares each hand with the table's preceding audited hand.
    const { record } = await verifyHandAsRoutesDo(t, previous);
    assert.equal(record.handNumber, hand);
    assert.equal(record.previousHandHash, previous?.finalStateHash ?? null, `hand ${hand} links to the previous hand`);
    previous = { handNumber: hand, finalStateHash: record.finalStateHash };
    handIds.add(record.handId);

    // Hand Clean-up purges every card secret before the next shuffle.
    t = completeHand(t);
    assert.equal(t.fairness, null); assert.equal(t.audit, null); assert.deepEqual(t.deck, []); assert.deepEqual(t.burns, []); assert.deepEqual(t.board, []);
    assert.ok(t.players.every((p) => !p || p.holeCards === null));
    assert.equal(t.auditChainTip, previous.finalStateHash);
    for (const userId of sittingOut) if (t.players.some((p) => p?.userId === userId)) t = sitIn(t, userId);
    t.cashOuts = [];
    for (let seat = 0; seat < 6; seat++) {
      if (!t.players[seat]) t = sitDown(t, seat, { userId: `rebuy-${hand}-${seat}`, username: `Rebuy${seat}`, kind: 'BOT', botProfile: 'MANIAC', avatarHue: 0, buyIn: 200 + 100 * seat, skipBuyInCheck: true });
    }
  }
  assert.equal(handIds.size, 30, 'every hand has a distinct UUID');
});

test('persistence fails closed on any audit inconsistency, and on a settled hand with no audit', async () => {
  const settled = play(startHand(seated([1000, 1000, 1000])), passive);
  const columnsFor = (mutate) => { const copy = structuredClone(settled); mutate(copy); return handAuditColumns(copy); };
  const tampers = {
    'edited event data': (c) => { c.audit.events[1].data.amount += 1; },
    'dropped event': (c) => { c.audit.events.splice(4, 1); },
    'forged final hash': (c) => { c.audit.finalStateHash = '0'.repeat(64); },
    'unsealed record': (c) => { c.audit.finalStateHash = null; c.audit.settledAt = null; },
    'deck salt differs from the commitment': (c) => { c.fairness.deckSalt = 'f'.repeat(64); },
    'Merkle salt differs from the root': (c) => { c.fairness.salts[60] = 'e'.repeat(64); },
    'hole card not from its committed position': (c) => { const s = c.dealtSeats[0]; c.players[s].holeCards = [c.deck[0], c.players[s].holeCards[1]]; },
    'board card not from its committed position': (c) => { c.board[4] = c.deck[0]; },
    'burns out of order': (c) => { c.burns.reverse(); },
    'deal order differs from the record': (c) => { c.dealtSeats.reverse(); },
    'undealt player holding cards': (c) => { c.players[5] = { ...c.players[0], seatIndex: 5, userId: 'intruder', holeCards: [c.deck[0], c.deck[1]] }; },
    'record from another hand number': (c) => { c.handNumber += 1; },
    'record from another table': (c) => { c.tableId = 'other-table'; },
    // upgradeTableState voids every legacy in-flight hand on load, so a settled hand without an audit is a defect.
    'no audit record': (c) => { c.audit = null; },
    'no audit record or commitment (legacy shape)': (c) => { delete c.audit; delete c.fairness; },
  };
  for (const [name, mutate] of Object.entries(tampers)) await assert.rejects(columnsFor(mutate), { code: 'AUDIT_INVALID' }, name);

  // A stored record is bound to its row: moving it to another row is detected.
  const cols = await handAuditColumns(settled);
  const row = { tableId: settled.tableId, handNumber: settled.handNumber, handUuid: cols.handUuid, deckCommitment: cols.deckCommitment, finalStateHash: cols.finalStateHash };
  assert.equal(rowBindingError(row, cols.auditRecord), null);
  for (const change of [{ handUuid: randomUUID() }, { handNumber: 2 }, { tableId: 'x' }, { deckCommitment: 'a'.repeat(64) }, { finalStateHash: 'b'.repeat(64) }]) {
    assert.equal(typeof rowBindingError({ ...row, ...change }, cols.auditRecord), 'string', JSON.stringify(change));
  }
  // A sealed record from another hand cannot open this hand's cards.
  const other = await handAuditColumns(play(startHand(seated([1000, 1000, 1000])), passive));
  const otherSealed = decryptState(other.auditSealed, sealedAuditContext(settled.tableId, 1));
  await assert.rejects(buildParticipantAudit(cols.auditRecord, otherSealed, requestFor(settled, settled.dealtSeats[0]), storedPlayers(settled)));
});

/** A settled three-way check-down with one pot and one winner (split pots are retried). */
function singleWinnerShowdown(tableId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const t = play(startHand(seated([1000, 1000, 1000], { tableId })), passive);
    if (t.awards.length === 1 && t.awards[0].winnerSeatIndexes.length === 1 && t.refunds.length === 0) return t;
  }
  assert.fail('no single-winner showdown in 100 hands');
}

/**
 * Reassign the pot to another player who showed down, in the live state and in
 * the record (payouts and final stacks moved consistently, chips conserved),
 * then re-seal the record so its hash chain and final hash verify.
 */
function reassignWinner(settled, { live = true, record = true } = {}) {
  const c = structuredClone(settled);
  const winner = c.awards[0].winnerSeatIndexes[0];
  const loser = c.dealtSeats.find((s) => s !== winner && c.players[s].showedCards);
  const amount = c.awards[0].amount;
  if (live) {
    c.awards[0].winnerSeatIndexes = [loser];
    c.players[winner].stack -= amount; c.players[loser].stack += amount;
    c.winners = [{ seatIndex: loser, amount, handName: c.players[loser].handResult?.name ?? null }];
  }
  if (record) {
    const [awarded, settledEvent] = c.audit.events.slice(-2);
    assert.deepEqual(awarded.data.payouts, [{ seatIndex: winner, amount }]);
    awarded.data.pots[0].winnerSeatIndexes = [loser];
    awarded.data.payouts = [{ seatIndex: loser, amount }];
    settledEvent.data.stacks = settledEvent.data.stacks.map((row) => ({
      seatIndex: row.seatIndex, stack: row.stack + (row.seatIndex === loser ? amount : row.seatIndex === winner ? -amount : 0),
    }));
    reseal(c.audit);
  }
  return c;
}

test('outcome replay before persisting: a re-sealed record with reassigned winners is never recorded', async () => {
  const settled = singleWinnerShowdown('compliance-forgery');
  const forged = reassignWinner(settled);
  const sealed = sealedAudit(forged.fairness);
  // The forgery passes every card-integrity check: only the outcome replay can catch it.
  const cards = await verifySealedAudit(forged.audit, sealed);
  assert.equal(cards.ok, true, cards.reason);
  const replay = verifyHandOutcome(forged.audit, sealed);
  assert.equal(replay.ok, false); assert.match(replay.reason, /Pot awards differ/);
  // Record and live state forged consistently (an engine defect): refused by the replay.
  await assert.rejects(handAuditColumns(forged), (err) => err.code === 'AUDIT_INVALID' && /outcome replay: Pot awards differ/.test(err.message));
  // Forged record only: refused by the replay as well.
  await assert.rejects(handAuditColumns(reassignWinner(settled, { live: false })), (err) => err.code === 'AUDIT_INVALID' && /outcome replay/.test(err.message));

  // The record is genuine but the live settlement (source of the HandPlayer/HandPot rows) differs from it.
  const liveTampers = {
    'pot reassigned in live state only': [(c) => Object.assign(c, reassignWinner(settled, { record: false })), /pot awards differ/],
    'winner amount differs': [(c) => { c.winners[0].amount -= 1; }, /payout for seat \d differs/],
    'stack moved between seats': [(c) => { const [a, b] = c.dealtSeats; c.players[a].stack -= 1; c.players[b].stack += 1; }, /starting stack for seat \d differs/],
    'contribution differs': [(c) => { c.players[c.dealtSeats[0]].committedThisHand += 1; }, /starting stack for seat \d differs/],
    'refund invented': [(c) => { c.refunds = [{ seatIndex: c.dealtSeats[0], amount: 5 }]; }, /refunds differ/],
  };
  for (const [name, [mutate, reason]] of Object.entries(liveTampers)) {
    const copy = structuredClone(settled); mutate(copy);
    await assert.rejects(handAuditColumns(copy), (err) => err.code === 'AUDIT_INVALID' && reason.test(err.message), name);
  }
  // The genuine hand still records.
  assert.ok(await handAuditColumns(settled));
});

test('regulator report: ok only if row binding, card integrity, outcome replay and table chain all pass', async () => {
  const settled = singleWinnerShowdown('compliance-regulator');
  const { record, sealed, row } = await verifyHandAsRoutesDo(settled);

  // Forged outcome, re-sealed, with a row that matches it: cards verify, the outcome does not.
  const forged = JSON.parse(JSON.stringify(reassignWinner(settled).audit));
  const forgedRow = { ...row, finalStateHash: forged.finalStateHash };
  const outcome = await regulatorVerification(forgedRow, forged, sealed, null);
  assert.equal(outcome.ok, false); assert.match(outcome.reason, /^Hand outcome: Pot awards differ/);
  assert.equal(outcome.outcome.ok, false); assert.equal(outcome.tableChain.ok, true);
  assert.ok(outcome.holeCards && outcome.burns, 'card integrity passed');

  // Table chain: the preceding audited hand's final hash must be the record's previousHandHash.
  const chain = await regulatorVerification(row, record, sealed, { handNumber: 7, finalStateHash: 'c'.repeat(64) });
  assert.equal(chain.ok, false); assert.match(chain.reason, /^Table chain: previousHandHash does not match/);
  assert.deepEqual(chain.outcome, { ok: true });
  assert.equal(chain.tableChain.ok, false); assert.equal(chain.tableChain.previousHandNumber, 7);
  const relinked = structuredClone(record); relinked.previousHandHash = 'd'.repeat(64); reseal(relinked);
  const orphan = await regulatorVerification({ ...row, finalStateHash: relinked.finalStateHash }, relinked, sealed, null);
  assert.equal(orphan.ok, false); assert.match(orphan.reason, /^Table chain:/, 'a link to a hand that does not exist');
  assert.equal((await regulatorVerification({ ...row, finalStateHash: relinked.finalStateHash }, relinked, sealed, { handNumber: 3, finalStateHash: 'd'.repeat(64) })).ok, true);

  // Row binding: reported first, and no derived cards are returned.
  const moved = await regulatorVerification({ ...row, handNumber: row.handNumber + 1 }, record, sealed, null);
  assert.equal(moved.ok, false); assert.equal(moved.reason, 'audit record belongs to a different hand');
  assert.equal(moved.holeCards, undefined); assert.equal(moved.burns, undefined);

  // Card integrity failure: the outcome is not replayed against an unverified deck.
  const badSealed = { ...sealed, deckSalt: 'f'.repeat(64) };
  const cards = await regulatorVerification(row, record, badSealed, null);
  assert.equal(cards.ok, false); assert.match(cards.reason, /Deck commitment/);
  assert.deepEqual(cards.outcome, { ok: false, reason: 'Not replayed: card integrity verification failed' });
  assert.equal(cards.holeCards, undefined);
});

// ---------------------------------------------------------------------------
// Legacy state (upgradeTableState on load)
// ---------------------------------------------------------------------------

/** Strip every field the pre-audit engine did not have, give it the old commitment shape and the retired seed round. */
function legacyOf(t) {
  const legacy = structuredClone(t);
  if (legacy.fairness) { const { context, root, deck, salts, levels } = legacy.fairness; legacy.fairness = { context, root, deck, salts, levels }; }
  delete legacy.audit; delete legacy.auditChainTip; delete legacy.handChipTotal; delete legacy.smallBlindPosition; delete legacy.dealtSeats;
  for (const p of legacy.players) if (p) { delete p.waitingForBigBlind; delete p.missedBlind; }
  legacy.pendingShuffle = { serverSeed: 'f'.repeat(64), commitments: [] };
  return legacy;
}
/** Store as TableManager does (AES-GCM, table AAD), then load: decrypt and upgrade. */
function storeAndLoad(tableId, state, onVoided) {
  return upgradeStoredTableState(tableId, decryptState(encryptState(state, `table:${tableId}`), `table:${tableId}`), onVoided);
}
/** The upgraded state emits to every viewer: engine projection and leak guard pass, and the client card verifier accepts it. */
async function assertEmitsCleanly(table, viewers) {
  for (const viewer of viewers) {
    const projected = projectTableState(table, viewer);
    const guarded = guardedTableState(table, viewer, (event) => assert.fail(`LEAK_BLOCKED for ${viewer}: ${event.reason}`));
    for (const state of [projected, guarded]) {
      assert.ok(state);
      assert.equal(await verifyTableCards(state), true, `verifyTableCards for ${viewer}`);
      assert.equal(state.fairness, null); assert.deepEqual(state.board, []);
      assert.ok(state.players.every((p) => !p.holeCards), `no hole cards for ${viewer}`);
    }
  }
}
function assertNoHandSecrets(table) {
  assert.equal(table.phase, 'WAITING'); assert.equal(table.status, 'WAITING');
  assert.equal('pendingShuffle' in table, false);
  assert.equal(table.audit, null); assert.equal(table.fairness, null);
  assert.deepEqual(table.deck, []); assert.deepEqual(table.burns, []); assert.deepEqual(table.board, []); assert.deepEqual(table.dealtSeats, []);
  assert.equal(table.toActSeat, null); assert.equal(table.potTotal, 0);
  for (const p of table.players) if (p) { assert.equal(p.holeCards, null); assert.equal(p.committedThisHand, 0); assert.equal(p.committedThisStreet, 0); }
}
const chipsOnTable = (table) => table.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + table.cashOuts.reduce((sum, c) => sum + c.stack, 0);
const actorId = (t) => t.players[t.toActSeat].userId;
/** A seat that is in the hand, not to act and not all in: it can leave without acting now. */
const idleSeat = (t) => t.dealtSeats.find((s) => s !== t.toActSeat && t.players[s].status === 'ACTIVE' && t.players[s].stack > 0);

test('legacy in-flight hands (PREFLOP and FLOP) are voided on load: every stack restored, chips conserved, safe to emit', async () => {
  // PREFLOP: a raise and a call, then a player who is not to act leaves.
  const buyIns = [1000, 1000, 1000, 1000];
  let pre = startHand(seated(buyIns, { tableId: 'legacy-preflop' }));
  pre = applyAction(pre, actorId(pre), { action: 'RAISE', amount: legalActions(pre, pre.toActSeat).minRaiseTo });
  pre = applyAction(pre, actorId(pre), { action: 'CALL' });
  const preLeaver = pre.players[idleSeat(pre)].userId;
  pre = leaveSeat(pre, preLeaver);

  // FLOP: a short stack all in pre-flop, then a flop bet and call; then an idle player leaves.
  const flopBuyIns = [300, 1000, 1000, 1000];
  let flop = startHand(seated(flopBuyIns, { tableId: 'legacy-flop' }));
  for (let turn = 0; !(flop.phase === 'FLOP' && flop.actions.filter((a) => a.street === 'FLOP').length >= 2); turn++) {
    assert.ok(turn < 100); assert.notEqual(flop.phase, 'SHOWDOWN');
    const legal = legalActions(flop, flop.toActSeat);
    const intent = flop.phase === 'PREFLOP' && flop.players[flop.toActSeat].stack <= 300 && legal.actions.includes('ALL_IN') ? { action: 'ALL_IN' }
      : flop.phase === 'FLOP' && legal.actions.includes('BET') ? { action: 'BET', amount: legal.minBet } : passive(flop, legal);
    flop = applyAction(flop, actorId(flop), intent);
  }
  assert.equal(flop.board.length, 3);
  assert.ok(flop.players.some((p) => p?.status === 'ALL_IN'), 'an all-in player');
  const flopLeaver = flop.players[idleSeat(flop)].userId;
  flop = leaveSeat(flop, flopLeaver);

  for (const [t, stacks, leaver] of [[pre, buyIns, preLeaver], [flop, flopBuyIns, flopLeaver]]) {
    assert.ok(t.players.some((p) => p && p.committedThisHand > 0), 'bets are on the table');
    const voided = [];
    const { table, upgraded } = storeAndLoad(t.tableId, legacyOf(t), (event) => voided.push(event));
    assert.equal(upgraded, true);
    assert.deepEqual(voided, [{ tableId: t.tableId, handNumber: 1 }], 'the voided hand is reported');
    assertNoHandSecrets(table);
    assert.equal(table.handNumber, 1, 'the hand number is not reused: the next hand is #2');
    // Every bet returned: each player holds exactly their buy-in, the leaver's is a pending cash-out.
    stacks.forEach((buyIn, seat) => {
      const userId = `user-${seat}`;
      if (userId === leaver) {
        assert.equal(table.players[seat], null);
        assert.deepEqual(table.cashOuts, [{ userId, stack: buyIn }]);
      } else {
        assert.equal(table.players[seat].stack, buyIn, `seat ${seat} stack restored`);
      }
    });
    assert.equal(chipsOnTable(table), stacks.reduce((a, b) => a + b, 0), 'chips conserved');
    assert.ok(table.log.some((entry) => /voided/.test(entry.text)));
    await assertEmitsCleanly(table, [...stacks.map((_, seat) => `user-${seat}`), null, 'not-seated']);
  }
});

test('legacy WAITING state with leftover board, hole cards, log and old-format fairness is purged and emits without LEAK_BLOCKED', async () => {
  const settled = play(startHand(seated([1000, 1000, 1000], { tableId: 'legacy-waiting' })), passive);
  // Old versions went back to WAITING without purging the hand.
  const leftover = structuredClone(settled);
  Object.assign(leftover, { phase: 'WAITING', status: 'WAITING', toActSeat: null, turnStartedAt: null });
  leftover.log.push({ seq: leftover.logSeq + 1, seatIndex: 0, username: 'Player0', text: `Player0 shows ${leftover.players[0].holeCards.join(' ')}`, at: new Date().toISOString() });
  const stored = legacyOf(leftover);
  assert.equal(stored.board.length, 5); assert.ok(stored.players.every((p) => !p || p.holeCards)); assert.ok(stored.fairness.deck);
  // Without the upgrade this state could not be emitted at all: the leak guard refuses it.
  const refusals = [];
  for (const viewer of ['user-0', null]) assert.equal(guardedTableState(structuredClone(stored), viewer, (e) => refusals.push(e.reason)), null);
  assert.equal(refusals.length, 2);

  const voided = [];
  const { table, upgraded } = storeAndLoad('legacy-waiting', stored, (event) => voided.push(event));
  assert.equal(upgraded, true); assert.deepEqual(voided, []);
  assertNoHandSecrets(table);
  assert.deepEqual(table.log, [], 'the old hand log (with its cards) is purged');
  assert.deepEqual(table.cashOuts, []);
  settled.players.forEach((p, seat) => { if (p) assert.equal(table.players[seat].stack, p.stack, 'settled stacks are kept'); });
  await assertEmitsCleanly(table, ['user-0', 'user-1', 'user-2', null, 'not-seated']);
});

test('legacy SHOWDOWN state (settled by the old server) runs Hand Clean-up on load', async () => {
  let t = startHand(seated([1000, 1000, 1000], { tableId: 'legacy-showdown' }));
  delete t.audit; // an old-engine hand: no audit trail
  const leaver = t.players[idleSeat(t)].userId;
  t = leaveSeat(t, leaver);
  t = play(t, passive);
  assert.equal(t.phase, 'SHOWDOWN'); assert.equal(t.audit, undefined);
  const settledStacks = t.players.map((p) => p?.stack ?? null);

  const voided = [];
  const { table, upgraded } = storeAndLoad('legacy-showdown', legacyOf(t), (event) => voided.push(event));
  assert.equal(upgraded, true); assert.deepEqual(voided, [], 'a settled hand is not voided');
  assertNoHandSecrets(table);
  const leaverSeat = t.players.findIndex((p) => p?.userId === leaver);
  assert.equal(table.players[leaverSeat], null);
  assert.deepEqual(table.cashOuts, [{ userId: leaver, stack: settledStacks[leaverSeat] }], 'the leaver is cashed out with the settled stack');
  settledStacks.forEach((stack, seat) => { if (seat !== leaverSeat && stack !== null) assert.equal(table.players[seat].stack, stack, 'no bet is returned twice'); });
  assert.equal(chipsOnTable(table), 3000, 'chips conserved');
  await assertEmitsCleanly(table, ['user-0', 'user-1', 'user-2', null]);
});

test('legacy upgrade: reported once per table and hand, deterministic, idempotent, and a no-op for current state', () => {
  const t = startHand(seated([1000, 1000, 1000], { tableId: 'legacy-once' }));
  const ciphertext = encryptState(legacyOf(t), 'table:legacy-once');
  const load = () => upgradeStoredTableState('legacy-once', decryptState(ciphertext, 'table:legacy-once'), (event) => voided.push(event));
  const voided = [];
  const first = load(); const second = load();
  assert.deepEqual(voided, [{ tableId: 'legacy-once', handNumber: 1 }], 'logged at most once per table and hand per process');
  // Every load of the same stored state derives the same upgrade and the same cash-outs (log times aside).
  const withoutTimes = (table) => JSON.stringify({ ...table, log: table.log.map(({ at: _at, ...entry }) => entry) });
  assert.equal(withoutTimes(first.table), withoutTimes(second.table));
  // Once stored, the upgraded state loads unchanged.
  const again = storeAndLoad('legacy-once', first.table, (event) => voided.push(event));
  assert.equal(again.upgraded, false); assert.equal(JSON.stringify(again.table), JSON.stringify(first.table)); assert.equal(voided.length, 1);
  // Another table's hand #1 is its own report.
  storeAndLoad('legacy-once-2', { ...legacyOf(t), tableId: 'legacy-once-2' }, (event) => voided.push(event));
  assert.deepEqual(voided.at(-1), { tableId: 'legacy-once-2', handNumber: 1 });

  // Current state (in a hand, settled, between hands) is never changed by loading.
  const settled = play(startHand(seated([1000, 1000], { tableId: 'current-state' })), passive);
  for (const current of [startHand(seated([1000, 1000], { tableId: 'current-state' })), settled, completeHand(settled)]) {
    const loaded = storeAndLoad('current-state', current, () => assert.fail('current state is never voided'));
    assert.equal(loaded.upgraded, false, current.phase);
    assert.equal(JSON.stringify(loaded.table), JSON.stringify(JSON.parse(JSON.stringify(current))), current.phase);
  }
});

// ---------------------------------------------------------------------------
// Participant redaction guard
// ---------------------------------------------------------------------------

test('participant redaction guard blocks hidden cards, sealed fields, salts and extra proofs', async () => {
  const settled = play(startHand(seated([1000, 1000, 1000, 1000])), (tt, legal) => {
    if (tt.phase === 'FLOP' && legal.actions.includes('BET')) return { action: 'BET', amount: legal.minBet };
    if (tt.phase === 'FLOP' && legal.actions.includes('FOLD') && tt.toActSeat % 2 === 0) return { action: 'FOLD' };
    return passive(tt, legal);
  });
  const cols = await handAuditColumns(settled);
  const sealed = decryptState(cols.auditSealed, sealedAuditContext(settled.tableId, settled.handNumber));
  const stored = storedPlayers(settled);
  const viewer = settled.dealtSeats.find((s) => settled.players[s].showedCards);
  const mucked = settled.dealtSeats.find((s) => s !== viewer && !settled.players[s].showedCards);
  assert.notEqual(mucked, undefined);
  const clean = participantAudit(cols.auditRecord, sealed, viewer);
  assert.doesNotThrow(() => assertParticipantAuditRedacted(clean, sealed, stored));
  const muckedPosition = holeCardPositions(settled.dealtSeats.indexOf(mucked), settled.dealtSeats.length)[0];
  const leaks = {
    'proof opening a mucked card': (a) => { a.proofs.push(cardProof(settled.fairness, muckedPosition)); },
    'proof opening an undealt card': (a) => { a.proofs.push(cardProof(settled.fairness, 51)); },
    'mucked card in event data': (a) => { a.record.events[0].data.note = `x ${settled.players[mucked].holeCards[1]}`; },
    'burn card in event data': (a) => { a.record.events.at(-1).data.note = settled.burns[0]; },
    'undealt card anywhere': (a) => { a.extra = [settled.deck[0]]; },
    'deck salt': (a) => { a.record.note = sealed.deckSalt; },
    'salt of an unopened position': (a) => { a.record.note = sealed.merkleSalts[51]; },
    'sealed field name': (a) => { a.deck = []; },
    'sealed object': (a) => { a.sealed = { version: 'x' }; },
  };
  for (const [name, mutate] of Object.entries(leaks)) {
    const leaky = structuredClone(clean);
    mutate(leaky);
    assert.throws(() => assertParticipantAuditRedacted(leaky, sealed, stored), { code: 'LEAK_BLOCKED' }, name);
  }
});

test('participant redaction guard trusts the stored showedCards flags, not the record, before opening another seat', async () => {
  const settled = play(startHand(seated([1000, 1000, 1000], { tableId: 'compliance-showed' })), passive);
  assert.ok(settled.dealtSeats.every((s) => settled.players[s].showedCards), 'a three-way showdown');
  const cols = await handAuditColumns(settled);
  const record = JSON.parse(JSON.stringify(cols.auditRecord));
  const sealed = decryptState(cols.auditSealed, sealedAuditContext(settled.tableId, settled.handNumber));
  const stored = storedPlayers(settled);
  const [viewer, other] = settled.dealtSeats;
  const clean = participantAudit(record, sealed, viewer);
  assert.doesNotThrow(() => assertParticipantAuditRedacted(clean, sealed, stored));
  // The viewer's own row does not need showedCards: their own cards are always theirs to see.
  assert.doesNotThrow(() => assertParticipantAuditRedacted(clean, sealed, stored.map((row) => row.seatIndex === viewer ? { ...row, showedCards: false } : row)));

  // The record tables a seat whose stored hand was NOT shown (or that has no stored row): nothing is returned.
  const notShown = stored.map((row) => row.seatIndex === other ? { ...row, showedCards: false } : row);
  const missing = stored.filter((row) => row.seatIndex !== other);
  for (const [name, rows] of Object.entries({ 'showedCards false': notShown, 'no stored row': missing })) {
    assert.throws(() => assertParticipantAuditRedacted(clean, sealed, rows), (err) => err.code === 'LEAK_BLOCKED' && new RegExp(`tables seat ${other}`).test(err.message), name);
    await assert.rejects(buildParticipantAudit(record, sealed, requestFor(settled, viewer), rows), { code: 'LEAK_BLOCKED' }, name);
  }
  assert.ok(await buildParticipantAudit(record, sealed, requestFor(settled, viewer), stored));

  // The audit is bound to the request: another table, hand number or user is refused.
  for (const change of [{ tableId: 'other-table' }, { handNumber: settled.handNumber + 1 }, { userId: settled.players[other].userId }]) {
    await assert.rejects(buildParticipantAudit(record, sealed, { ...requestFor(settled, viewer), ...change }, stored), { code: 'AUDIT_INVALID' }, JSON.stringify(change));
  }
});
