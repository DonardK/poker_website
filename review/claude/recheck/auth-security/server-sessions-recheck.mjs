/**
 * Re-check (2026-10-07) of review/claude/repro/server-sessions.mjs sections
 * A-F and scripts/security-review.mjs session/HTTP probes, adapted to the
 * current API (terms body on /guest, $transaction, usernameCanonical,
 * revocation columns, auth cache, SESSION_RENEW).
 *
 * SAFETY: DATABASE_URL / DIRECT_URL point at loopback port 1 BEFORE any
 * server module is imported; REDIS_URL is empty; every Prisma method used is
 * replaced in memory (an unstubbed call would only hit 127.0.0.1:1). Every
 * server listens on port 0 (ephemeral) on 127.0.0.1. Nothing from any .env
 * file is printed: every variable config.ts reads is set here.
 *
 * Usage: node review/claude/recheck/auth-security/server-sessions-recheck.mjs
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';

const DEAD = 'postgresql://review:unused@127.0.0.1:1/review';
Object.assign(process.env, {
  NODE_ENV: 'test', CLIENT_ORIGIN: 'http://127.0.0.1:3999', PUBLIC_API_ORIGIN: '', COOKIE_SITE: '', HOST: '', PORT: '4999',
  DATABASE_URL: DEAD, DIRECT_URL: DEAD, REDIS_URL: '',
  TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'), GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d', DEFAULT_STARTING_BANKROLL: '10000', TURN_TIME_BANK_MS: '20000',
  SESSION_IDLE_TTL: '', SESSION_ABSOLUTE_TTL: '', TERMS_VERSION: 'review-terms-1', ENABLE_LEGACY_BOTS: 'false',
  TIME_BANK_INITIAL_MS: '', TIME_BANK_MAX_MS: '', TIME_BANK_REFILL_MS: '', TIME_BANK_REFILL_EVERY_HANDS: '',
});

const { default: jwt } = await import('jsonwebtoken');
const { io: connect } = await import('socket.io-client');
const { Prisma } = await import('@prisma/client');
const { prisma } = await import('../../../../apps/server/dist/db/prisma.js');
const { createApp } = await import('../../../../apps/server/dist/app.js');
const { createSocketServer } = await import('../../../../apps/server/dist/socket/index.js');
const { tableManager } = await import('../../../../apps/server/dist/game/manager.js');
const { logger, createLogger } = await import('../../../../apps/server/dist/logger.js');
const { signAccessToken, signRefreshToken } = await import('../../../../apps/server/dist/auth/jwt.js');
const { authenticate } = await import('../../../../apps/server/dist/auth/middleware.js');
const { clearAuthCache, revokeSession } = await import('../../../../apps/server/dist/auth/sessions.js');
const { createTable } = await import('../../../../packages/engine/dist/index.js');
const { SOCKET_EVENTS, REFRESH_COOKIE_NAME } = await import('../../../../packages/shared/dist/index.js');

if (!process.env.DATABASE_URL.includes('127.0.0.1:1/')) throw new Error('refusing to run: DATABASE_URL is not the dead loopback URL');

// ---- capture every log line through the production serializer + redaction ----
const logLines = [];
const sink = new Writable({ write(chunk, _enc, cb) { logLines.push(chunk.toString()); cb(); } });
const captureLogger = createLogger(sink);
for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) logger[level] = captureLogger[level].bind(captureLogger);

// ---- in-memory Prisma (independent of the project's own test fake) ----------
const sha = (v) => createHash('sha256').update(v).digest('hex');
const DAY = 86_400_000;
const users = new Map();
const sessions = new Map();
let failSessionLookups = 0;           // next N session.findUnique calls throw like an unreachable DB
let holdSessionLookups = 0;           // park the next N session.findUnique calls until all have arrived
let held = [];
let tableCreateMode = null;           // 'race' => the second table.create throws P2002 (TableSeat_userId_key)
let tableCreates = 0;
let guestClashes = 0;                 // the next N guest user.create calls throw P2002 on usernameCanonical
const outage = () => Object.assign(new Error("Can't reach database server at 127.0.0.1:5432"), { name: 'PrismaClientInitializationError' });
const p2002 = (target) => new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (\`${target}\`)`, { code: 'P2002', clientVersion: 'review', meta: { target: [target] } });
const clone = (v) => structuredClone(v);
const select = (row, sel) => sel ? Object.fromEntries(Object.keys(sel).filter((k) => sel[k]).map((k) => [k, clone(row[k])])) : clone(row);
const whereMatches = (row, where = {}) => Object.entries(where).every(([k, c]) => {
  if (c === null) return row[k] == null;
  if (c && typeof c === 'object' && !(c instanceof Date)) {
    if ('not' in c) return row[k] !== c.not;
    if ('gt' in c) return row[k] != null && row[k] > c.gt;
    if ('gte' in c) return row[k] != null && row[k] >= c.gte;
    return true;
  }
  return row[k] === c;
});
const applyData = (row, data) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) row[k] += v.increment;
    else if (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in v) row[k] -= v.decrement;
    else row[k] = v;
  }
};
const userDefaults = () => ({ email: null, passwordHash: null, isGuest: false, role: 'PLAYER', kind: 'HUMAN', botProfile: null, bankroll: 10_000,
  avatarHue: 0, createdAt: new Date(), updatedAt: new Date(), lastSeenAt: null, failedLoginCount: 0, lockedUntil: null,
  termsVersion: null, termsAcceptedAt: null, ageConfirmedAt: null });

prisma.user.findUnique = async ({ where, select: sel }) => {
  const row = [...users.values()].find((u) => whereMatches(u, where));
  return row ? select(row, sel) : null;
};
prisma.user.create = async ({ data }) => {
  await Promise.resolve();
  if (data.isGuest && guestClashes > 0) { guestClashes -= 1; throw p2002('usernameCanonical'); }
  const row = { id: `u-${randomUUID()}`, ...userDefaults(), ...clone(data), usernameCanonical: data.username.toLowerCase() };
  for (const field of ['usernameCanonical', 'email']) {
    if (row[field] != null && [...users.values()].some((u) => u[field] === row[field])) throw p2002(field);
  }
  users.set(row.id, row);
  return clone(row);
};
prisma.user.update = async ({ where, data, select: sel }) => { const row = users.get(where.id); applyData(row, data); return select(row, sel); };
prisma.user.updateMany = async ({ where, data }) => {
  const rows = [...users.values()].filter((u) => whereMatches(u, where)); for (const r of rows) applyData(r, data); return { count: rows.length };
};
prisma.session.create = async ({ data }) => {
  const row = { createdAt: new Date(), lastUsedAt: new Date(), userAgent: null, ip: null, previousTokenHash: null, rotatedAt: null, revokedAt: null, revokeReason: null, ...clone(data) };
  sessions.set(row.id, row); return clone(row);
};
prisma.session.findUnique = async ({ where, include, select: sel }) => {
  await Promise.resolve();
  if (holdSessionLookups > 0) {
    holdSessionLookups -= 1;
    await new Promise((resolve) => { held.push(resolve); if (holdSessionLookups === 0) { for (const r of held) r(); held = []; } });
  }
  if (failSessionLookups > 0) { failSessionLookups -= 1; throw outage(); }
  const row = sessions.get(where.id);
  if (!row) return null;
  return include?.user ? { ...clone(row), user: clone(users.get(row.userId)) } : select(row, sel);
};
prisma.session.findMany = async ({ where, select: sel }) => [...sessions.values()].filter((s) => whereMatches(s, where)).map((r) => select(r, sel));
prisma.session.updateMany = async ({ where, data }) => {
  const rows = [...sessions.values()].filter((s) => whereMatches(s, where)); for (const r of rows) applyData(r, clone(data)); return { count: rows.length };
};
prisma.session.updateManyAndReturn = async ({ where, data, select: sel }) => {
  const rows = [...sessions.values()].filter((s) => whereMatches(s, where)); for (const r of rows) applyData(r, clone(data)); return rows.map((r) => select(r, sel));
};
prisma.tableSeat.findUnique = async () => null;
prisma.tableSeat.findFirst = async () => null;
prisma.table.findUnique = async () => null;
prisma.table.findMany = async () => [];
prisma.table.create = async () => {
  await new Promise((r) => setTimeout(r, 20));
  tableCreates += 1;
  if (tableCreateMode === 'race' && tableCreates === 2) throw p2002('userId');
  return { id: `t-${tableCreates}` };
};
prisma.$transaction = async (fn) => fn(prisma);

/** A user and a live session exactly as createSession() writes them. */
function seed({ username = `Guest_${randomBytes(5).toString('hex')}`, isGuest = true, createdAt = new Date(), absoluteExpiresAt, expiresAt } = {}) {
  const user = { id: `u-${randomUUID()}`, ...userDefaults(), username, usernameCanonical: username.toLowerCase(), isGuest };
  users.set(user.id, user);
  const id = randomUUID();
  const exp = expiresAt ?? new Date(Date.now() + 7 * DAY);
  const refreshToken = signRefreshToken(user.id, id, exp);
  sessions.set(id, { id, userId: user.id, refreshToken: sha(refreshToken), expiresAt: exp, createdAt, userAgent: null, ip: null,
    lastUsedAt: new Date(), absoluteExpiresAt: absoluteExpiresAt ?? new Date(createdAt.getTime() + 30 * DAY), previousTokenHash: null,
    rotatedAt: null, revokedAt: null, revokeReason: null });
  return { user, sessionId: id, refreshToken, cookie: `${REFRESH_COOKIE_NAME}=${refreshToken}`, accessToken: signAccessToken(user.id, user.username, id) };
}
/** An access token with a custom lifetime (seconds), signed exactly like signAccessToken. */
const shortToken = (userId, username, sid, seconds) => jwt.sign({ sub: userId, sid, username, typ: 'access' }, process.env.JWT_ACCESS_SECRET,
  { algorithm: 'HS256', issuer: 'poker-server', audience: 'poker-client', expiresIn: seconds, jwtid: randomUUID() });

// ---- servers -----------------------------------------------------------------
const servers = [];
async function startApp({ withSockets = false } = {}) {
  const server = createServer(createApp({ logger: captureLogger }));
  const io = withSockets ? createSocketServer(server) : null;
  if (withSockets) tableManager.stop();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, io });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'POST', body, headers = {}, json = true } = {}) => {
    const res = await fetch(base + path, { method, ...(body !== undefined ? { body } : {}), headers: { ...(json && body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } });
    const text = await res.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie'), cacheControl: res.headers.get('cache-control'), retryAfter: res.headers.get('retry-after'), etag: res.headers.get('etag'), headers: res.headers };
  };
  return { server, io, base, call };
}
const clients = [];
async function openSocket(base, token) {
  const client = connect(base, { auth: { token }, transports: ['websocket'], reconnection: false, autoConnect: false, extraHeaders: { Origin: process.env.CLIENT_ORIGIN } });
  clients.push(client);
  const ready = once(client, SOCKET_EVENTS.AUTH_OK, { signal: AbortSignal.timeout(5000) });
  client.connect(); await ready;
  return client;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Everything a socket receives (event name + payload) for `ms` after `fn` runs, and whether it is still connected. */
async function observe(client, ms, fn) {
  const seen = [];
  const any = (event, payload) => seen.push({ event, payload });
  const onDisconnect = (reason) => seen.push({ event: 'disconnect', payload: reason });
  client.onAny(any); client.on('disconnect', onDisconnect);
  try { await fn(); await sleep(ms); } finally { client.offAny(any); client.off('disconnect', onDisconnect); }
  return { seen, stillConnected: client.connected };
}
const terms = JSON.stringify({ acceptTerms: true, confirmAge: true, termsVersion: 'review-terms-1' });
const results = {};

try {
  const main = await startApp({ withSockets: true });
  const { call, base, io } = main;

  // A. Two refreshes of one session at the same moment (CR-006 / F16 grace).
  {
    const s = seed();
    holdSessionLookups = 2;
    const [r1, r2] = await Promise.all([call('/api/auth/refresh', { headers: { Cookie: s.cookie } }), call('/api/auth/refresh', { headers: { Cookie: s.cookie } })]);
    const row = sessions.get(s.sessionId);
    clearAuthCache();
    const tokensWork = [];
    for (const r of [r1, r2]) { try { await authenticate(r.body?.accessToken); tokensWork.push(true); } catch { tokensWork.push(false); } }
    results.A_concurrentRefresh = { statuses: [r1.status, r2.status], newCookieSetCount: [r1, r2].filter((r) => r.setCookie?.startsWith(`${REFRESH_COOKIE_NAME}=ey`)).length,
      bothAccessTokensAuthenticate: tokensWork, sessionRevoked: Boolean(row.revokedAt) };
  }

  // A2. F16: the replaced token presented after the 15 s grace window (rotatedAt moved 16 s back), and an older token.
  {
    const s = seed();
    const first = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });
    const rotatedCookie = first.setCookie.split(';')[0];
    sessions.get(s.sessionId).rotatedAt = new Date(Date.now() - 16_000);
    const replay = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });
    clearAuthCache();
    let currentStillValid = true; try { await authenticate(first.body.accessToken); } catch { currentStillValid = false; }
    const current = await call('/api/auth/refresh', { headers: { Cookie: rotatedCookie } });
    results.A2_replayAfterGrace = { replayStatus: replay.status, sessionRevokedReason: sessions.get(s.sessionId).revokeReason,
      currentAccessTokenStillValid: currentStillValid, currentCookieRefreshStatus: current.status,
      securityLogLine: logLines.some((l) => l.includes('REFRESH_REUSE')) };
  }

  // A3. NEW: a refresh whose response (and Set-Cookie) never reached the browser. The browser keeps the old cookie.
  {
    const s = seed();
    const lost = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });          // server rotated; response "lost"
    const retry = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });         // client retries within grace (old cookie)
    const retrySetCookie = retry.setCookie;
    sessions.get(s.sessionId).rotatedAt = new Date(Date.now() - 10 * 60_000);                 // the next 10-minute refresh
    const next = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });
    // Same thing when the network outage outlasts the 15 s grace (retry 20 s later).
    const s2 = seed();
    await call('/api/auth/refresh', { headers: { Cookie: s2.cookie } });
    sessions.get(s2.sessionId).rotatedAt = new Date(Date.now() - 20_000);
    const lateRetry = await call('/api/auth/refresh', { headers: { Cookie: s2.cookie } });
    results.A3_lostRefreshResponse = { serverRotated: lost.status === 200 && Boolean(lost.setCookie),
      retryWithinGrace: { status: retry.status, setsNewCookie: Boolean(retrySetCookie && retrySetCookie.includes('=ey')) },
      nextPeriodicRefresh: { status: next.status, sessionRevokedReason: sessions.get(s.sessionId).revokeReason },
      retryAfter20s: { status: lateRetry.status, sessionRevokedReason: sessions.get(s2.sessionId).revokeReason },
      guestAccount: s.user.isGuest };
  }

  // B. Transient DB error while re-authenticating a socket packet (CR-007).
  {
    const s = seed();
    const sock = await openSocket(base, s.accessToken);
    const idBefore = sock.id;
    clearAuthCache(); failSessionLookups = 1;
    const obs = await observe(sock, 400, async () => { sock.emit(SOCKET_EVENTS.REHYDRATE, {}); });
    results.B_transientDbErrorOnPacket = { received: obs.seen.map((e) => e.event === SOCKET_EVENTS.SERVER_ERROR ? { event: e.event, code: e.payload.code, retryable: e.payload.retryable } : e.event),
      stillConnected: obs.stillConnected, sameSocketId: sock.id === idBefore };
    // B2. A revoked session on a packet still fails closed.
    sessions.get(s.sessionId).revokedAt = new Date(); sessions.get(s.sessionId).revokeReason = 'LOGOUT'; clearAuthCache();
    const obs2 = await observe(sock, 400, async () => { sock.emit(SOCKET_EVENTS.REHYDRATE, {}); });
    results.B2_revokedSessionOnPacket = { received: obs2.seen.map((e) => e.event === SOCKET_EVENTS.SERVER_ERROR ? `${e.event}:${e.payload.code}` : e.event === SOCKET_EVENTS.SESSION_REVOKED ? `${e.event}:${e.payload.reason}` : e.event === 'disconnect' ? `disconnect:${e.payload}` : e.event),
      stillConnected: obs2.stillConnected };
  }

  // C. Transient DB error during a table broadcast (CR-007).
  {
    const s = seed();
    const sock = await openSocket(base, s.accessToken);
    const table = createTable({ tableId: 'review-broadcast', name: 'Broadcast', maxSeats: 2, smallBlind: 5, bigBlind: 10, timeBankMs: 15000 });
    io.in(sock.id).socketsJoin('table:review-broadcast');
    await sleep(50);
    clearAuthCache(); failSessionLookups = 1;
    const obs = await observe(sock, 400, async () => { await tableManager.broadcast(table); });
    clearAuthCache();
    const obs2 = await observe(sock, 400, async () => { await tableManager.broadcast(table); });
    results.C_transientDbErrorOnBroadcast = { duringOutage: obs.seen.map((e) => e.event), stillConnected: obs.stillConnected,
      nextBroadcastDelivered: obs2.seen.some((e) => e.event === SOCKET_EVENTS.STATE_SNAPSHOT) };
  }

  // D. CR-005: the socket outlives its handshake token when SESSION_RENEW is sent; another user's token is refused.
  {
    const s = seed();
    const sock = await openSocket(base, shortToken(s.user.id, s.user.username, s.sessionId, 2));
    const idBefore = sock.id;
    const renewAck = await sock.timeout(3000).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token: signAccessToken(s.user.id, s.user.username, s.sessionId) });
    await sleep(2600); // the handshake token has now expired
    clearAuthCache();
    const obs = await observe(sock, 400, async () => { sock.emit(SOCKET_EVENTS.REHYDRATE, {}); });
    // Without a renewal the expired socket is disconnected on its next packet (design: the client renews first).
    const s2 = seed();
    const sock2 = await openSocket(base, shortToken(s2.user.id, s2.user.username, s2.sessionId, 2));
    await sleep(2600); clearAuthCache();
    const obs2 = await observe(sock2, 400, async () => { sock2.emit(SOCKET_EVENTS.REHYDRATE, {}); });
    // Renewal with another user's valid token.
    const s3 = seed(); const other = seed();
    const sock3 = await openSocket(base, s3.accessToken);
    let mismatchAck;
    const obs3 = await observe(sock3, 400, async () => { mismatchAck = await sock3.timeout(3000).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token: other.accessToken }); });
    results.D_sessionRenew = { renewAck, afterExpiry: { received: obs.seen.map((e) => e.event), stillConnected: obs.stillConnected, sameSocketId: sock.id === idBefore },
      withoutRenew: { received: obs2.seen.map((e) => e.event === SOCKET_EVENTS.SERVER_ERROR ? `${e.event}:${e.payload.code}` : e.event), stillConnected: obs2.stillConnected },
      otherUsersToken: { ack: mismatchAck, stillConnected: obs3.stillConnected, socketStillOwnedBy: s3.user.id } };
  }

  // E. CR-016 / CR-013: registration races, case-insensitive names, reserved names, guest name clash retry.
  {
    const reg = (username, email) => call('/api/auth/register', { body: JSON.stringify({ username, email, password: 'correct-horse-battery', acceptTerms: true, confirmAge: true, termsVersion: 'review-terms-1' }) });
    const [e1, e2] = await Promise.all([reg('RaceName', 'race@example.test'), reg('RaceName', 'race2@example.test')]);
    const [e3, e4] = await Promise.all([reg('MailRace1', 'same@example.test'), reg('MailRace2', 'same@example.test')]);
    const alice = await reg('Alice', 'alice@example.test');
    const alice2 = await reg('alice', 'alice2@example.test');
    const reserved = {};
    for (const name of ['Guest_abc123', 'guest_1a2b3c4d5e', 'Admin', 'Support_Team', 'Dealer', 'System', 'Bot_x', 'moderator1']) reserved[name] = (await reg(name, `${name.toLowerCase()}@example.test`)).status;
    results.E_registration = { concurrentSameUsername: [e1.status, e2.status].sort(), loserBody: (e1.status === 201 ? e2 : e1).body,
      concurrentSameEmail: [e3.status, e4.status].sort(), emailLoserBody: (e3.status === 201 ? e4 : e3).body,
      caseVariant: { first: alice.status, second: alice2.status, body: alice2.body }, reservedStatuses: reserved };
  }
  // E2 lives on its own app (the credential limiter is 15/min per IP and E already used most of it).
  {
    const app2 = await startApp();
    guestClashes = 2;
    const g = await app2.call('/api/auth/guest', { body: terms });
    guestClashes = 5;
    const g5 = await app2.call('/api/auth/guest', { body: terms });
    guestClashes = 0;
    results.E2_guestNameClash = { twoClashesThenSuccess: { status: g.status, username: g.body?.user?.username }, fiveClashes: { status: g5.status, body: g5.body } };
  }

  // E3. CR-016 sibling path: table creation double-submit hits TableSeat_userId_key (P2002).
  {
    const s = seed({ username: 'TableHost', isGuest: false });
    tableCreateMode = 'race'; tableCreates = 0;
    const body = JSON.stringify({ smallBlind: 5, bigBlind: 10, buyIn: 1000 });
    const [t1, t2] = await Promise.all([call('/api/tables', { body, headers: { Authorization: `Bearer ${s.accessToken}` } }), call('/api/tables', { body, headers: { Authorization: `Bearer ${s.accessToken}` } })]);
    tableCreateMode = null;
    results.E3_tableCreateRace = { statuses: [t1.status, t2.status].sort(), loserBody: (t1.status === 201 ? t2 : t1).body };
  }

  // F. Transient DB error during /refresh (CR-007, SOL-011).
  {
    const s = seed();
    clearAuthCache(); failSessionLookups = 1;
    const r = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });
    const again = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });
    results.F_transientDbErrorOnRefresh = { status: r.status, body: r.body, retryAfter: r.retryAfter, setCookieHeader: r.setCookie,
      sameCookieWorksAfterwards: again.status, sessionRevoked: Boolean(sessions.get(s.sessionId).revokedAt) };
    // F2. login / me with the database down: 503 not 401.
    const s2 = seed(); clearAuthCache(); failSessionLookups = 1;
    const me = await call('/api/auth/me', { method: 'GET', headers: { Authorization: `Bearer ${s2.accessToken}` } });
    results.F2_meWithDbDown = { status: me.status, body: me.body };
  }

  // G. F08: malformed bodies and the logs; the credential limiter counts them.
  {
    const app3 = await startApp();
    const marker = 'RECHECK_SYNTHETIC_PASSWORD_ONLY';
    const before = logLines.length;
    const bad = await app3.call('/api/auth/login', { body: `{"username":"x","password":"${marker}",broken}` });
    const big = await app3.call('/api/auth/login', { body: JSON.stringify({ username: 'x', password: marker, pad: 'y'.repeat(40_000) }) });
    const statuses = [];
    for (let i = 0; i < 16; i++) statuses.push((await app3.call('/api/auth/login', { body: '{invalid' })).status);
    const newLines = logLines.slice(before).join('\n');
    results.G_malformedBodies = { malformedStatus: bad.status, malformedBody: bad.body, oversizedStatus: big.status,
      markerInLogs: newLines.includes(marker) || logLines.join('\n').includes(marker), markerInResponse: JSON.stringify(bad.body).includes(marker),
      sixteenMoreMalformed: statuses };
  }

  // H. F18: cross-origin and simple-request CSRF on cookie routes.
  {
    const app4 = await startApp();
    const s = seed();
    const h = {};
    h.textPlainGuestUntrustedOrigin = (await app4.call('/api/auth/guest', { body: terms, json: false, headers: { 'Content-Type': 'text/plain', Origin: 'https://untrusted.example.test' } })).status;
    h.textPlainGuestNoOrigin = (await app4.call('/api/auth/guest', { body: terms, json: false, headers: { 'Content-Type': 'text/plain' } })).status;
    h.formGuestTrustedOrigin = (await app4.call('/api/auth/guest', { body: 'a=1', json: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: process.env.CLIENT_ORIGIN } })).status;
    h.refreshUntrustedOrigin = (await app4.call('/api/auth/refresh', { headers: { Cookie: s.cookie, Origin: 'https://untrusted.example.test' } })).status;
    h.refreshSiblingOrigin = (await app4.call('/api/auth/refresh', { headers: { Cookie: s.cookie, Origin: 'http://evil.127.0.0.1:3999' } })).status;
    h.logoutNullOrigin = (await app4.call('/api/auth/logout', { headers: { Cookie: s.cookie, Origin: 'null' } })).status;
    h.logoutCrossSiteFetchMetadata = (await app4.call('/api/auth/logout', { headers: { Cookie: s.cookie, 'Sec-Fetch-Site': 'cross-site' } })).status;
    h.sessionStillLiveAfterRefusedLogouts = !sessions.get(s.sessionId).revokedAt;
    h.refreshTrustedOrigin = (await app4.call('/api/auth/refresh', { headers: { Cookie: s.cookie, Origin: process.env.CLIENT_ORIGIN } })).status;
    // Socket handshake from an untrusted origin.
    const evil = connect(base, { auth: { token: s.accessToken }, transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://untrusted.example.test' } });
    clients.push(evil);
    h.socketHandshakeUntrustedOrigin = await Promise.race([once(evil, 'connect').then(() => 'connected'), once(evil, 'connect_error').then(() => 'refused'), sleep(3000).then(() => 'timeout')]);
    results.H_crossOrigin = h;
  }

  // I. F19: Cache-Control on auth/account responses (including errors).
  {
    const app5 = await startApp();
    const guest = await app5.call('/api/auth/guest', { body: terms });
    const cookie = guest.setCookie.split(';')[0];
    const me = await app5.call('/api/auth/me', { method: 'GET', headers: { Authorization: `Bearer ${guest.body.accessToken}` } });
    const refresh = await app5.call('/api/auth/refresh', { headers: { Cookie: cookie } });
    const unauth = await app5.call('/api/auth/me', { method: 'GET', headers: { Authorization: 'Bearer nope' } });
    const lobby = await app5.call('/api/tables', { method: 'GET', headers: { Authorization: `Bearer ${guest.body.accessToken}` } });
    const lobby304 = await app5.call('/api/tables', { method: 'GET', headers: { Authorization: `Bearer ${guest.body.accessToken}`, 'If-None-Match': lobby.etag ?? '' } });
    results.I_cacheControl = { guest: guest.cacheControl, me: me.cacheControl, refresh: refresh.cacheControl, unauthorized401: unauth.cacheControl,
      lobbyList: lobby.cacheControl, lobbyEtag: Boolean(lobby.etag), lobbyRevalidationStatus: lobby304.status,
      refreshCookieAttributes: guest.setCookie.split(';').slice(1).map((p) => p.trim().split('=')[0]).join(',') };
  }

  // J. F16: absolute lifetime (a session created 365 days ago whose idle expiry was kept alive).
  {
    const created = new Date(Date.now() - 365 * DAY);
    const s = seed({ createdAt: created, absoluteExpiresAt: new Date(created.getTime() + 30 * DAY), expiresAt: new Date(Date.now() + 6 * DAY) });
    const r = await call('/api/auth/refresh', { headers: { Cookie: s.cookie } });
    clearAuthCache();
    // A fresh session: refresh never extends past absoluteExpiresAt.
    const s2 = seed({ absoluteExpiresAt: new Date(Date.now() + 2 * DAY) });
    const r2 = await call('/api/auth/refresh', { headers: { Cookie: s2.cookie } });
    const row2 = sessions.get(s2.sessionId);
    results.J_absoluteLifetime = { createdDaysAgo: 365, refreshStatus: r.status, cookieCleared: /Expires=Thu, 01 Jan 1970/i.test(r.setCookie ?? ''),
      nearAbsoluteRefresh: { status: r2.status, expiresAtCappedAtAbsolute: row2.expiresAt.getTime() <= row2.absoluteExpiresAt.getTime(),
        cookieMaxAgeSeconds: Number(/Max-Age=(\d+)/.exec(r2.setCookie ?? '')?.[1]) } };
  }

  // K. F17: a revoked session's socket receives no USER_PATCH.
  {
    const s = seed();
    const sock = await openSocket(base, s.accessToken);
    // (1) Revoked in this process: told why and disconnected at once.
    const obs1 = await observe(sock, 400, async () => { await revokeSession(s.sessionId, 'LOGOUT'); });
    // (2) Revoked by another process (row updated directly), after the auth cache window: no bankroll delivered.
    const s2 = seed();
    const sock2 = await openSocket(base, s2.accessToken);
    sessions.get(s2.sessionId).revokedAt = new Date(); sessions.get(s2.sessionId).revokeReason = 'LOGOUT_ALL';
    clearAuthCache();
    const obs2 = await observe(sock2, 400, async () => { await tableManager.patchBankroll(s2.user.id); });
    // (3) Same, inside the 5 s positive auth cache (accepted, documented delay).
    const s3 = seed();
    const sock3 = await openSocket(base, s3.accessToken);
    await authenticate(s3.accessToken); // warm the cache as the handshake did
    sessions.get(s3.sessionId).revokedAt = new Date(); sessions.get(s3.sessionId).revokeReason = 'LOGOUT_ALL';
    const obs3 = await observe(sock3, 400, async () => { await tableManager.patchBankroll(s3.user.id); });
    const fmt = (o) => o.seen.map((e) => e.event === SOCKET_EVENTS.SESSION_REVOKED ? `${e.event}:${e.payload.reason}` : e.event === 'disconnect' ? `disconnect:${e.payload}` : e.event);
    results.K_revokedSocket = { revokedHere: { received: fmt(obs1), stillConnected: obs1.stillConnected },
      revokedElsewhereAfterCacheWindow: { received: fmt(obs2), gotBankroll: obs2.seen.some((e) => e.event === SOCKET_EVENTS.USER_PATCH), stillConnected: obs2.stillConnected },
      revokedElsewhereWithin5sCache: { received: fmt(obs3), gotBankroll: obs3.seen.some((e) => e.event === SOCKET_EVENTS.USER_PATCH) } };
  }

  // L. CR-015 / F20: 50 signed-in players behind one IP; sign-ins behind one IP.
  {
    const app6 = await startApp();
    const players = Array.from({ length: 50 }, () => seed());
    let lobby429 = 0; let lobbyOk = 0;
    for (let round = 0; round < 13; round++) {
      const rs = await Promise.all(players.map((p) => app6.call('/api/tables', { method: 'GET', headers: { Authorization: `Bearer ${p.accessToken}` } })));
      lobby429 += rs.filter((r) => r.status === 429).length; lobbyOk += rs.filter((r) => r.status === 200 || r.status === 304).length;
    }
    const refreshes = await Promise.all(players.map((p) => app6.call('/api/auth/refresh', { headers: { Cookie: p.cookie } })));
    const guestStatuses = [];
    for (let i = 0; i < 17; i++) guestStatuses.push((await app6.call('/api/auth/guest', { body: terms })).status);
    results.L_sharedIp = { lobbyRequests: 50 * 13, lobbyOk, lobby429, refresh429: refreshes.filter((r) => r.status === 429).length,
      guestCreationsFromOneIp: { first15: guestStatuses.slice(0, 15).every((st) => st === 201), sixteenthAndSeventeenth: guestStatuses.slice(15) } };
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const client of clients) client.disconnect();
  tableManager.stop();
  for (const { server, io } of servers) {
    if (io) await new Promise((resolve) => io.close(resolve));
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => process.exit(0), 200).unref();
}
