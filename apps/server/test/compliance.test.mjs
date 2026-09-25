/**
 * Server compliance tests. They use no database and no network beyond
 * 127.0.0.1, and they are deterministic in outcome: randomness only varies the
 * hands played, and every assertion is an invariant that must hold for every
 * hand (there are no statistical assertions in this file).
 *
 * What they prove:
 * - TLS: `isSecureTransport` accepts only a real TLS socket or, behind a
 *   trusted proxy, an https X-Forwarded-Proto; production refuses to start
 *   without TLS and refuses plaintext HTTP (426) and Socket.io handshakes
 *   (403), except the health probe; development is unchanged; HSTS is sent.
 * - The player-entropy shuffle protocol and Math.random are gone, and every
 *   STATE_SNAPSHOT emission goes through the engine leak guard, which fails
 *   closed (nothing is emitted, a security event is reported).
 * - For real engine hands (showdown, fold-out, mucked hands, side pots and
 *   all-in runouts, 30 chained random hands): the persisted audit columns
 *   satisfy the database CHECK constraints and verify; the regulator view
 *   re-derives exactly the dealt hole cards and burns; every dealt player's
 *   participant audit verifies and its response body contains only that
 *   player's own cards, the dealt board and hands tabled at showdown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { TLSSocket } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyAction, applyTimeout, cardProof, completeHand, createTable, decideBotAction, legalActions,
  participantAudit, sealedAudit, sitDown, sitIn, sitOut, startHand,
} from '@poker/engine';
import { holeCardPositions, UUID_V4, verifyParticipantAudit, verifySealedAudit } from '@poker/shared';
import { decryptState } from '../dist/game/encryption.js';
import {
  assertParticipantAuditRedacted, buildParticipantAudit, handAuditColumns, handContext, rowBindingError, sealedAuditContext,
} from '../dist/game/audit.js';
import { guardedTableState } from '../dist/socket/mask.js';
import { createListener, isSecureTransport } from '../dist/transport.js';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[a-f0-9]{64}$/;
const CARD = /^[2-9TJQKA][cdhs]$/;
const cardTokens = (text) => new Set(text.split(/[^0-9A-Za-z]+/).filter((token) => CARD.test(token)));

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

/** Run an ES module in a fresh Node process and return the JSON it prints after "RESULT ". */
function runChild(t, source, env) {
  const dir = mkdtempSync(join(tmpdir(), 'poker-compliance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'child.mjs');
  writeFileSync(file, source);
  const run = spawnSync(process.execPath, [file], { cwd: serverDir, env, encoding: 'utf8', timeout: 60_000 });
  const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no result (exit ${run.status}): ${run.stderr || run.stdout}`);
  return JSON.parse(line.slice('RESULT '.length));
}

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
  assert.equal(hsPlain.status, 403); assert.equal(hsHttp.status, 403);
  assert.equal(hsHttps.status, 200); assert.match(hsHttps.body, /^0\{"sid"/);
  assert.equal(hsOrigin.status, 200);
  assert.equal(hsEvil.status, 403, 'the origin check still applies');
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
// Removed protocol, Math.random, guarded emissions
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

/**
 * Exactly what TableManager.persistHand, the participant route and the
 * regulator route do with a settled hand, with the database replaced by a
 * JSON round trip. Asserts every compliance property and returns the record.
 */
async function verifyHandAsRoutesDo(t) {
  assert.equal(t.phase, 'SHOWDOWN');
  // persistHand: audit columns (the migration's CHECK constraints hold).
  const cols = await handAuditColumns(t);
  assert.ok(cols, 'audited hand yields audit columns');
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

  // Regulator route: independent recomputation derives exactly the engine's hole cards and burns.
  const verification = await verifySealedAudit(record, sealed);
  assert.equal(verification.ok, true, verification.reason);
  assert.deepEqual(verification.holeCards, t.dealtSeats.map((seatIndex) => ({ seatIndex, cards: t.players[seatIndex].holeCards })));
  assert.deepEqual(verification.burns, t.burns);

  // Participant route for every dealt seat.
  const board = t.board;
  const shownSeats = t.dealtSeats.filter((s) => t.players[s].showedCards);
  for (const seat of t.dealtSeats) {
    const audit = await buildParticipantAudit(record, sealed, seat);
    assert.deepEqual(audit, participantAudit(record, sealed, seat), 'the route returns the engine redaction');
    const own = t.players[seat].holeCards;
    const check = await verifyParticipantAudit(audit, { handId: t.fairness.handId, merkleRoot: t.fairness.root, deckCommitment: t.fairness.deckCommitment, holeCards: own });
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
  await assert.rejects(buildParticipantAudit(record, sealed, outsider));
  return { record, sealed, cols };
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
    const { record } = await verifyHandAsRoutesDo(t);
    assert.equal(record.handNumber, hand);
    assert.equal(record.previousHandHash, previous, `hand ${hand} links to the previous hand`);
    previous = record.finalStateHash;
    handIds.add(record.handId);

    // Hand Clean-up purges every card secret before the next shuffle.
    t = completeHand(t);
    assert.equal(t.fairness, null); assert.equal(t.audit, null); assert.deepEqual(t.deck, []); assert.deepEqual(t.burns, []); assert.deepEqual(t.board, []);
    assert.ok(t.players.every((p) => !p || p.holeCards === null));
    assert.equal(t.auditChainTip, previous);
    for (const userId of sittingOut) if (t.players.some((p) => p?.userId === userId)) t = sitIn(t, userId);
    t.cashOuts = [];
    for (let seat = 0; seat < 6; seat++) {
      if (!t.players[seat]) t = sitDown(t, seat, { userId: `rebuy-${hand}-${seat}`, username: `Rebuy${seat}`, kind: 'BOT', botProfile: 'MANIAC', avatarHue: 0, buyIn: 200 + 100 * seat, skipBuyInCheck: true });
    }
  }
  assert.equal(handIds.size, 30, 'every hand has a distinct UUID');
});

test('persistence fails closed on any audit inconsistency and skips only legacy hands', async () => {
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
  };
  for (const [name, mutate] of Object.entries(tampers)) await assert.rejects(columnsFor(mutate), { code: 'AUDIT_INVALID' }, name);
  // Legacy in-flight hands (begun before the audit trail) persist without audit columns.
  assert.equal(await columnsFor((c) => { c.audit = null; }), null);
  assert.equal(await columnsFor((c) => { delete c.audit; delete c.fairness; }), null);

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
  await assert.rejects(buildParticipantAudit(cols.auditRecord, otherSealed, settled.dealtSeats[0]));
});

test('a legacy in-flight hand (pre-upgrade state) finishes, is emitted safely, and persists without audit columns', async () => {
  // State as saved by the pre-upgrade engine: no audit fields, old commitment shape (no hand id).
  const legacy = structuredClone(startHand(seated([1000, 1000, 1000])));
  const { context, root, deck, salts, levels } = legacy.fairness;
  legacy.fairness = { context, root, deck, salts, levels };
  delete legacy.audit; delete legacy.auditChainTip; delete legacy.handChipTotal;
  const settled = play(legacy, passive);
  assert.equal(settled.audit, undefined);
  for (const viewer of ['user-0', 'user-1', 'user-2', null]) {
    const state = guardedTableState(settled, viewer, () => assert.fail('legacy state must not trip the leak guard'));
    assert.ok(state); assert.equal(state.fairness, null);
  }
  assert.equal(await handAuditColumns(settled), null);
});

test('participant redaction guard blocks hidden cards, sealed fields, salts and extra proofs', async () => {
  const settled = play(startHand(seated([1000, 1000, 1000, 1000])), (tt, legal) => {
    if (tt.phase === 'FLOP' && legal.actions.includes('BET')) return { action: 'BET', amount: legal.minBet };
    if (tt.phase === 'FLOP' && legal.actions.includes('FOLD') && tt.toActSeat % 2 === 0) return { action: 'FOLD' };
    return passive(tt, legal);
  });
  const cols = await handAuditColumns(settled);
  const sealed = decryptState(cols.auditSealed, sealedAuditContext(settled.tableId, settled.handNumber));
  const viewer = settled.dealtSeats.find((s) => settled.players[s].showedCards);
  const mucked = settled.dealtSeats.find((s) => s !== viewer && !settled.players[s].showedCards);
  assert.notEqual(mucked, undefined);
  const clean = participantAudit(cols.auditRecord, sealed, viewer);
  assert.doesNotThrow(() => assertParticipantAuditRedacted(clean, sealed));
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
    assert.throws(() => assertParticipantAuditRedacted(leaky, sealed), { code: 'LEAK_BLOCKED' }, name);
  }
});
