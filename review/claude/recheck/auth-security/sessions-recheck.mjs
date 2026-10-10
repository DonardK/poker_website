/**
 * Re-check (2026-10-07) of review/claude/repro/server-sessions.mjs (A-F) and
 * the session/HTTP items of scripts/security-review.mjs (F08, F16-F19) plus
 * CR-013, CR-015, CR-016, against today's apps/server/dist.
 *
 * SAFETY: no database is reachable. DATABASE_URL / DIRECT_URL point at
 * loopback port 1 and are set BEFORE anything from apps/server is imported;
 * every Prisma method used is replaced by an in-memory stub written here
 * (independent of the repo's test fake). Servers listen on port 0 only.
 *
 * Usage (repo root): node review/claude/recheck/auth-security/sessions-recheck.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';

const DEAD = 'postgresql://review:unused@127.0.0.1:1/review';
Object.assign(process.env, {
  NODE_ENV: 'test', CLIENT_ORIGIN: 'http://127.0.0.1:3999', PUBLIC_API_ORIGIN: '', COOKIE_SITE: '', HOST: '', PORT: '4999',
  DATABASE_URL: DEAD, DIRECT_URL: DEAD, REDIS_URL: '',
  TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'), GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d', SESSION_IDLE_TTL: '', SESSION_ABSOLUTE_TTL: '', TERMS_VERSION: '',
  DEFAULT_STARTING_BANKROLL: '10000', TURN_TIME_BANK_MS: '20000', ENABLE_LEGACY_BOTS: '',
  TIME_BANK_INITIAL_MS: '', TIME_BANK_MAX_MS: '', TIME_BANK_REFILL_MS: '', TIME_BANK_REFILL_EVERY_HANDS: '',
});

const root = new URL('../../../../', import.meta.url);
const serverRequire = createRequire(new URL('apps/server/package.json', root));
const { Prisma } = serverRequire('@prisma/client');
const jwt = serverRequire('jsonwebtoken');
const { io: connect } = serverRequire('socket.io-client');
const imp = (p) => import(new URL(p, root).href);

const { prisma } = await imp('apps/server/dist/db/prisma.js');
const { createApp } = await imp('apps/server/dist/app.js');
const { createSocketServer } = await imp('apps/server/dist/socket/index.js');
const { tableManager } = await imp('apps/server/dist/game/manager.js');
const { logger, createLogger } = await imp('apps/server/dist/logger.js');
const { authConfig, env } = await imp('apps/server/dist/config.js');
const { signAccessToken, signRefreshToken } = await imp('apps/server/dist/auth/jwt.js');
const { clearAuthCache, revokeSession } = await imp('apps/server/dist/auth/sessions.js');
const { createTable, sitDown } = await imp('packages/engine/dist/index.js');
const { SOCKET_EVENTS, REFRESH_COOKIE_NAME } = await imp('packages/shared/dist/index.js');

// Silence the module logger (pino-pretty in non-production); section J swaps in a capturing logger.
for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) logger[level] = () => {};

// ---- in-memory Prisma (written for this re-check) ----------------------------
const DAY = 86_400_000;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const users = new Map(); const sessions = new Map(); const tables = new Map();
const faults = { sessionFindUnique: 0, userCreate: [] };
let hold = null; // { count, waiting: [] }: park the first `count` session.findUnique calls until all arrived
const poolTimeout = () => new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: 'review' });
const p2002 = (field) => new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (\`${field}\`)`, { code: 'P2002', clientVersion: 'review', meta: { modelName: 'User', target: [field] } });
const clone = (v) => structuredClone(v);
const pick = (row, select) => select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, clone(row[k])])) : clone(row);
const matches = (row, where = {}) => Object.entries(where).every(([k, c]) => {
  if (c === null) return row[k] == null;
  if (c && typeof c === 'object' && !(c instanceof Date)) {
    if ('not' in c) return row[k] !== c.not;
    if ('gt' in c) return row[k] != null && row[k] > c.gt;
    if ('gte' in c) return row[k] != null && row[k] >= c.gte;
  }
  return row[k] === c;
});
const applyData = (row, data) => { for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v && typeof v === 'object' && 'decrement' in v ? row[k] - v.decrement : v; };
let seq = 0;
function addUser(username, extra = {}) {
  const u = { id: `u${++seq}`, username, usernameCanonical: username.toLowerCase(), email: null, passwordHash: null, isGuest: false, role: 'PLAYER', kind: 'HUMAN',
    botProfile: null, bankroll: 10_000, avatarHue: 0, failedLoginCount: 0, lockedUntil: null, createdAt: new Date(), lastSeenAt: null, ...extra };
  users.set(u.id, u); return u;
}
function addSession(userId, extra = {}) {
  const now = Date.now(); const id = `s${++seq}`;
  const expiresAt = extra.expiresAt ?? new Date(now + 7 * DAY);
  const refreshToken = signRefreshToken(userId, id, expiresAt);
  sessions.set(id, { id, userId, refreshToken: sha(refreshToken), expiresAt, absoluteExpiresAt: new Date(now + 30 * DAY), createdAt: new Date(now), lastUsedAt: new Date(now),
    previousTokenHash: null, rotatedAt: null, revokedAt: null, revokeReason: null, userAgent: null, ip: null, ...extra });
  return { id, refreshToken, accessToken: signAccessToken(userId, users.get(userId).username, id) };
}
const db = {
  user: {
    findUnique: async ({ where, select }) => { const r = [...users.values()].find((u) => matches(u, where)); return r ? pick(r, select) : null; },
    create: async ({ data }) => {
      await new Promise((r) => setImmediate(r));
      const forced = faults.userCreate.shift(); if (forced) throw forced;
      const row = { id: `u${++seq}`, email: null, passwordHash: null, isGuest: false, role: 'PLAYER', kind: 'HUMAN', botProfile: null, failedLoginCount: 0, lockedUntil: null, createdAt: new Date(), ...clone(data) };
      row.usernameCanonical = row.username.toLowerCase();
      for (const f of ['usernameCanonical', 'email']) if (row[f] != null && [...users.values()].some((u) => u[f] === row[f])) throw p2002(f);
      users.set(row.id, row); return clone(row);
    },
    update: async ({ where, data, select }) => { const r = users.get(where.id); applyData(r, data); return pick(r, select); },
    updateMany: async ({ where, data }) => { const rs = [...users.values()].filter((u) => matches(u, where)); rs.forEach((r) => applyData(r, data)); return { count: rs.length }; },
  },
  session: {
    create: async ({ data }) => { const row = { previousTokenHash: null, rotatedAt: null, revokedAt: null, revokeReason: null, createdAt: new Date(), ...clone(data) }; sessions.set(row.id, row); return clone(row); },
    findUnique: async ({ where, include, select }) => {
      await Promise.resolve();
      if (hold && hold.count > 0) { hold.count -= 1; await new Promise((r) => { hold.waiting.push(r); if (hold.count === 0) hold.waiting.forEach((f) => f()); }); }
      if (faults.sessionFindUnique > 0) { faults.sessionFindUnique -= 1; throw poolTimeout(); }
      const s = sessions.get(where.id); if (!s) return null;
      return include?.user ? { ...clone(s), user: clone(users.get(s.userId)) } : pick(s, select);
    },
    findMany: async ({ where, select }) => [...sessions.values()].filter((s) => matches(s, where)).map((s) => pick(s, select)),
    updateMany: async ({ where, data }) => { const rs = [...sessions.values()].filter((s) => matches(s, where)); rs.forEach((r) => Object.assign(r, clone(data))); return { count: rs.length }; },
    updateManyAndReturn: async ({ where, data, select }) => { const rs = [...sessions.values()].filter((s) => matches(s, where)); rs.forEach((r) => Object.assign(r, clone(data))); return rs.map((r) => pick(r, select)); },
  },
  tableSeat: { findUnique: async () => null, findFirst: async () => null },
  table: { findUnique: async ({ where, select }) => { const t = tables.get(where.id); return t ? pick(t, select) : null; }, findMany: async () => [] },
};
for (const [model, methods] of Object.entries(db)) Object.assign(prisma[model], methods);
prisma.$transaction = async (fn) => fn(db);

// ---- servers -------------------------------------------------------------
const servers = [];
async function listen(handler) {
  const server = createServer(handler); servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const main = await listen(createApp());
const io = createSocketServer(main.server); tableManager.stop();
const http = (base) => async (path, { method = 'POST', body, headers = {}, cookie, token } = {}) => {
  const res = await fetch(base + path, { method, body, headers: {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`)) ?? null;
  return { status: res.status, json, headers: res.headers, setCookie, cookie: setCookie ? setCookie.split(';')[0] : null,
    cleared: setCookie !== null && /Expires=Thu, 01 Jan 1970/i.test(setCookie) };
};
const req = http(main.base);
const TERMS = JSON.stringify({ acceptTerms: true, confirmAge: true, termsVersion: authConfig.termsVersion });
const cookieOf = (t) => `${REFRESH_COOKIE_NAME}=${t}`;
const clients = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function openSocket(token, origin = env.CLIENT_ORIGIN) {
  const c = connect(main.base, { auth: { token }, transports: ['websocket'], reconnection: false, autoConnect: false, extraHeaders: { Origin: origin } });
  clients.push(c); const events = [];
  c.onAny((event, payload) => events.push({ event, payload }));
  c.on('disconnect', (reason) => events.push({ event: 'disconnect', payload: reason }));
  const ready = Promise.race([once(c, SOCKET_EVENTS.AUTH_OK).then(() => 'ok'), once(c, 'connect_error').then(([e]) => `connect_error:${e.message}`)]);
  c.connect(); const outcome = await ready;
  return { c, events, outcome, named: (e) => events.filter((x) => x.event === e).map((x) => x.payload) };
}
const serverSocket = (c) => io.sockets.sockets.get(c.id);
const results = {};

try {
  // ---------------- A: concurrent refresh (CR-006, F16) ----------------
  {
    const guest = await req('/api/auth/guest', { body: TERMS });
    const natural = await Promise.all([1, 2].map(() => req('/api/auth/refresh', { cookie: guest.cookie })));
    const u = addUser('ForcedRace'); const s = addSession(u.id);
    hold = { count: 2, waiting: [] };
    const forced = await Promise.all([1, 2].map(() => req('/api/auth/refresh', { cookie: cookieOf(s.refreshToken) })));
    hold = null;
    const meStatuses = [];
    for (const r of forced) meStatuses.push((await req('/api/auth/me', { method: 'GET', token: r.json?.accessToken })).status);
    results.A_concurrentRefresh = {
      natural: natural.map((r) => r.status), naturalRotations: natural.filter((r) => r.setCookie && !r.cleared).length,
      forcedInterleaving: forced.map((r) => r.status), forcedRotations: forced.filter((r) => r.setCookie && !r.cleared).length,
      bothAccessTokensWork: meStatuses, sessionRevoked: sessions.get(s.id).revokedAt !== null,
    };
  }
  // ---------------- A2-A4: replay, absolute age, lifetime binding (F16) ----------------
  {
    const u = addUser('Replay'); const s = addSession(u.id);
    const first = await req('/api/auth/refresh', { cookie: cookieOf(s.refreshToken) });
    const insideGrace = await req('/api/auth/refresh', { cookie: cookieOf(s.refreshToken) });
    sessions.get(s.id).rotatedAt = new Date(Date.now() - 20_000);
    const replay = await req('/api/auth/refresh', { cookie: cookieOf(s.refreshToken) });
    const currentAfter = await req('/api/auth/refresh', { cookie: first.cookie });
    const meAfter = await req('/api/auth/me', { method: 'GET', token: first.json.accessToken });
    results.A2_refreshReplay = { firstRotation: first.status, previousTokenInsideGrace: insideGrace.status, replayAfterGrace: replay.status,
      replayClearedCookie: replay.cleared, revokeReason: sessions.get(s.id).revokeReason, currentTokenAfterReplay: currentAfter.status, accessTokenAfterReplay: meAfter.status };

    const old = addUser('Oldtimer'); const os = addSession(old.id, { createdAt: new Date(Date.now() - 365 * DAY), absoluteExpiresAt: new Date(Date.now() - 335 * DAY), expiresAt: new Date(Date.now() + DAY) });
    const oldRefresh = await req('/api/auth/refresh', { cookie: cookieOf(os.refreshToken) });
    const near = addUser('NearEnd'); const ns = addSession(near.id); sessions.get(ns.id).absoluteExpiresAt = new Date(Date.now() + 3_600_000);
    const capped = await req('/api/auth/refresh', { cookie: cookieOf(ns.refreshToken) });
    const row = sessions.get(ns.id);
    const maxAge = Number(/Max-Age=(\d+)/.exec(capped.setCookie ?? '')?.[1]);
    const exp = jwt.decode(decodeURIComponent(capped.cookie.split('=')[1])).exp;
    results.A3_lifetime = { createdDaysAgo365: oldRefresh.status, cookieCleared: oldRefresh.cleared,
      refreshNearAbsoluteEnd: capped.status, expiryCappedAtAbsolute: row.expiresAt.getTime() === row.absoluteExpiresAt.getTime(),
      cookieMaxAgeMatchesRowSeconds: Math.abs(maxAge - (row.expiresAt.getTime() - Date.now()) / 1000) < 3, jwtExpMatchesRow: exp === Math.floor(row.expiresAt.getTime() / 1000),
      idleTtlDays: authConfig.sessionIdleTtlMs / DAY, absoluteTtlDays: authConfig.sessionAbsoluteTtlMs / DAY };
  }
  // ---------------- B: transient DB error on a socket packet (CR-007) ----------------
  {
    const u = addUser('PacketUser'); const s = addSession(u.id);
    tables.set('t-b', { id: 't-b', status: 'WAITING', isPrivate: false, hostId: null });
    const sock = await openSocket(s.accessToken);
    clearAuthCache(); faults.sessionFindUnique = 1;
    const ack = await sock.c.timeout(3000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId: 't-b' }).catch((e) => `ack error ${e.message}`);
    await pause(300);
    results.B_transientDbErrorOnPacket = { ack, serverError: sock.named(SOCKET_EVENTS.SERVER_ERROR)[0] ?? null, stillConnected: sock.c.connected,
      sessionRevokedEvents: sock.named(SOCKET_EVENTS.SESSION_REVOKED).length };
  }
  // ---------------- C: transient DB error during a broadcast (CR-007) ----------------
  {
    const u = addUser('Viewer'); const s = addSession(u.id);
    const sock = await openSocket(s.accessToken);
    serverSocket(sock.c).join('table:t-c');
    const table = createTable({ tableId: 't-c', name: 'Broadcast', maxSeats: 2, smallBlind: 5, bigBlind: 10, timeBankMs: 15000 });
    clearAuthCache(); faults.sessionFindUnique = 1;
    await tableManager.broadcast(table); await pause(300);
    const duringOutage = { connected: sock.c.connected, snapshots: sock.named(SOCKET_EVENTS.STATE_SNAPSHOT).length };
    await tableManager.broadcast(table); await pause(300);
    results.C_transientDbErrorOnBroadcast = { duringOutage, afterRecovery: { connected: sock.c.connected, snapshots: sock.named(SOCKET_EVENTS.STATE_SNAPSHOT).length } };
  }
  // ---------------- D: access-token expiry on a live socket, with and without SESSION_RENEW (CR-005) ----------------
  {
    const shortToken = (u, sid) => jwt.sign({ sub: u.id, sid, username: u.username, typ: 'access' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', issuer: 'poker-server', audience: 'poker-client', expiresIn: 2 });
    const table = createTable({ tableId: 't-d', name: 'Renew', maxSeats: 2, smallBlind: 5, bigBlind: 10, timeBankMs: 15000 });
    const ua = addUser('Renewer'); const sa = addSession(ua.id);
    const renewed = await openSocket(shortToken(ua, sa.id));
    const idBefore = renewed.c.id;
    const renewAck = await renewed.c.timeout(3000).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token: signAccessToken(ua.id, ua.username, sa.id) });
    const ub = addUser('NoRenew'); const sb = addSession(ub.id);
    const stale = await openSocket(shortToken(ub, sb.id));
    for (const x of [renewed, stale]) serverSocket(x.c).join('table:t-d');
    await pause(2600); clearAuthCache();
    await tableManager.broadcast(table); await pause(300);
    const packetAck = renewed.c.connected ? await renewed.c.timeout(3000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId: 'missing' }).catch((e) => `ack error ${e.message}`) : null;
    const uc = addUser('Hijacker'); const sc = addSession(uc.id);
    const victim = await openSocket(signAccessToken(ua.id, ua.username, sa.id));
    const mismatch = await victim.c.timeout(3000).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token: signAccessToken(uc.id, uc.username, sc.id) });
    await pause(300);
    results.D_tokenExpiryOnLiveSocket = {
      withRenew: { renewAck, sameSocketId: renewed.c.id === idBefore, connectedAfterExpiry: renewed.c.connected, snapshotAfterExpiry: renewed.named(SOCKET_EVENTS.STATE_SNAPSHOT).length, packetAfterExpiry: packetAck?.code ?? packetAck },
      withoutRenew: { connectedAfterBroadcast: stale.c.connected, disconnectReason: stale.named('disconnect')[0] ?? null, snapshots: stale.named(SOCKET_EVENTS.STATE_SNAPSHOT).length, toldSessionRevoked: stale.named(SOCKET_EVENTS.SESSION_REVOKED).length },
      renewWithOtherUsersToken: { ack: mismatch, disconnected: !victim.c.connected },
    };
  }
  // ---------------- E: unique races and username policy (CR-016, CR-013) ----------------
  {
    const reg = (username, email) => req('/api/auth/register', { body: JSON.stringify({ ...JSON.parse(TERMS), username, email, password: 'correct horse battery staple' }) });
    const race = await Promise.all([reg('RaceName', 'race1@example.test'), reg('RaceName', 'race2@example.test')]);
    const loser = race.find((r) => r.status !== 201);
    const emailRace = await Promise.all([reg('MailOne', 'same@example.test'), reg('MailTwo', 'same@example.test')]);
    const policy = {};
    // A fresh app: the credential limiter is 15/min per IP per app instance.
    const policyApp = await listen(createApp()); const preq = http(policyApp.base);
    for (const name of ['racename', 'RACENAME', 'Guest_abc123', 'guest_1a2b3c', 'Admin', 'Support', 'Dealer', 'System', 'Bot_Alice', 'AdminJoe', 'Al1ce_ok']) {
      const r = await preq('/api/auth/register', { body: JSON.stringify({ ...JSON.parse(TERMS), username: name, email: `${name.toLowerCase()}@policy.test`, password: 'correct horse battery staple' }) });
      policy[name] = [r.status, r.json?.error];
    }
    faults.userCreate.push(p2002('usernameCanonical'), p2002('usernameCanonical'));
    const guestRetry = await preq('/api/auth/guest', { body: TERMS });
    results.E_uniqueRaces = { registrationRace: race.map((r) => r.status).sort(), loserBody: loser?.json, emailRace: emailRace.map((r) => r.status).sort(), emailLoserBody: emailRace.find((r) => r.status !== 201)?.json,
      usernamePolicy: policy, guestNameClashRetried: [guestRetry.status, guestRetry.json?.user?.username] };
  }
  // ---------------- F: transient DB error during /refresh and /me (CR-007) ----------------
  {
    const u = addUser('Guest_00ff00ff00', { isGuest: true }); const s = addSession(u.id);
    faults.sessionFindUnique = 1;
    const down = await req('/api/auth/refresh', { cookie: cookieOf(s.refreshToken) });
    const back = await req('/api/auth/refresh', { cookie: cookieOf(s.refreshToken) });
    clearAuthCache(); faults.sessionFindUnique = 1;
    const meDown = await req('/api/auth/me', { method: 'GET', token: back.json.accessToken });
    results.F_transientDbErrorOnRefresh = { status: down.status, body: down.json, retryAfter: down.headers.get('retry-after'), setCookieHeader: down.setCookie, refreshCookieCleared: down.cleared,
      sameCookieAfterRecovery: back.status, meDuringOutage: meDown.status };
  }
  // ---------------- G: revoked sessions and private delivery (F17) ----------------
  {
    const u = addUser('Wallet', { bankroll: 4321 });
    const live = addSession(u.id); const other = addSession(u.id); const warm = addSession(u.id); const inproc = addSession(u.id);
    const good = await openSocket(live.accessToken); const bad = await openSocket(other.accessToken); const cached = await openSocket(warm.accessToken); const local = await openSocket(inproc.accessToken);
    // Revoked by another process (row only): once the 5 s positive cache has lapsed (cleared here), nothing private is delivered.
    Object.assign(sessions.get(other.id), { revokedAt: new Date(), revokeReason: 'SESSION_REVOKED' });
    clearAuthCache();
    await tableManager.patchBankroll(u.id, 'some-table'); await pause(400);
    // Revoked by another process while this process still holds a fresh cached success (inside AUTH_CACHE_TTL_MS = 5 s).
    await (await imp('apps/server/dist/auth/middleware.js')).authenticate(warm.accessToken);
    const cachedBefore = cached.named(SOCKET_EVENTS.USER_PATCH).length;
    Object.assign(sessions.get(warm.id), { revokedAt: new Date(), revokeReason: 'SESSION_REVOKED' });
    await tableManager.patchBankroll(u.id); await pause(400);
    const cachedAfterRevocation = cached.named(SOCKET_EVENTS.USER_PATCH).length - cachedBefore;
    clearAuthCache(); // the 5 s window lapses
    await tableManager.patchBankroll(u.id); await pause(400);
    const cachedAfterTtl = cached.named(SOCKET_EVENTS.USER_PATCH).length - cachedBefore - cachedAfterRevocation;
    // Revoked in this process: told why and disconnected at once.
    await revokeSession(inproc.id, 'LOGOUT'); await pause(400);
    results.G_revokedSockets = {
      validSession: { patches: good.named(SOCKET_EVENTS.USER_PATCH).length, connected: good.c.connected },
      revokedElsewhereAfterCacheTtl: { patches: bad.named(SOCKET_EVENTS.USER_PATCH).length, toldRevoked: bad.named(SOCKET_EVENTS.SESSION_REVOKED), connected: bad.c.connected },
      revokedElsewhereWithin5sCache: { patchesDeliveredAfterRevocationInsideCacheWindow: cachedAfterRevocation, patchesAfterCacheLapsed: cachedAfterTtl, connected: cached.c.connected },
      revokedInProcess: { toldRevoked: local.named(SOCKET_EVENTS.SESSION_REVOKED), connected: local.c.connected },
    };
  }
  // ---------------- H + I: CSRF guard (F18) and cache headers (F19) ----------------
  {
    const app = await listen(createApp()); const r = http(app.base);
    const foreign = 'https://untrusted.example.test';
    const textGuest = await r('/api/auth/guest', { body: TERMS, headers: { 'Content-Type': 'text/plain', Origin: foreign } });
    const textNoOrigin = await r('/api/auth/guest', { body: TERMS, headers: { 'Content-Type': 'text/plain' } });
    const formSameOrigin = await r('/api/auth/guest', { body: 'acceptTerms=true', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: env.CLIENT_ORIGIN } });
    const crossSiteNoOrigin = await r('/api/auth/guest', { body: TERMS, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    const nullOrigin = await r('/api/auth/guest', { body: TERMS, headers: { Origin: 'null' } });
    const sibling = await r('/api/auth/guest', { body: TERMS, headers: { Origin: 'http://evil.127.0.0.1:3999' } });
    const ok = await r('/api/auth/guest', { body: TERMS, headers: { Origin: env.CLIENT_ORIGIN } });
    const refreshForeign = await r('/api/auth/refresh', { cookie: ok.cookie, headers: { Origin: foreign } });
    const logoutForeign = await r('/api/auth/logout', { cookie: ok.cookie, headers: { Origin: foreign } });
    const socketForeign = await openSocket(ok.json.accessToken, foreign);
    results.H_crossOrigin = { textPlainForeignOriginGuest: textGuest.status, textPlainNoOriginGuest: textNoOrigin.status, formSameOrigin: formSameOrigin.status,
      secFetchCrossSiteNoOrigin: crossSiteNoOrigin.status, nullOrigin: nullOrigin.status, siblingOrigin: sibling.status, jsonSameOrigin: ok.status,
      refreshForeignOrigin: refreshForeign.status, logoutForeignOrigin: logoutForeign.status, socketHandshakeForeignOrigin: socketForeign.outcome };
    const me = await r('/api/auth/me', { method: 'GET', token: ok.json.accessToken });
    const refreshed = await r('/api/auth/refresh', { cookie: ok.cookie, headers: { Origin: env.CLIENT_ORIGIN } });
    const unauth = await r('/api/auth/me', { method: 'GET' });
    const notFound = await r('/api/nope', { method: 'GET' });
    const lobby = await r('/api/tables', { method: 'GET', token: ok.json.accessToken });
    const etag = lobby.headers.get('etag');
    // node:http, not fetch: undici adds Cache-Control: no-cache to a request carrying If-None-Match, which (correctly) defeats a 304.
    const lobby304 = await new Promise((resolve, reject) => { const { request } = serverRequire('node:http'); const u = new URL(app.base + '/api/tables');
      request({ host: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Authorization: 'Bearer ' + ok.json.accessToken, 'If-None-Match': etag ?? '' } }, (res) => { res.resume(); resolve({ status: res.statusCode }); }).on('error', reject).end(); });
    const logout = await r('/api/auth/logout', { cookie: refreshed.cookie, headers: { Origin: env.CLIENT_ORIGIN } });
    const cc = (x) => `${x.status} ${x.headers.get('cache-control')}`;
    results.I_cacheControl = { guest201: cc(ok), me200: cc(me), refresh200: cc(refreshed), logout204: cc(logout), me401: cc(unauth), guest403: cc(textGuest), guest415: cc(textNoOrigin), api404: cc(notFound),
      lobbyList: `${cc(lobby)} vary=${lobby.headers.get('vary')} etag=${Boolean(etag)}`, lobbyRevalidate: lobby304.status };
  }
  // ---------------- J: malformed bodies and log hygiene (F08) ----------------
  {
    const lines = [];
    const sink = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
    const capture = createLogger(sink);
    for (const level of ['error', 'warn', 'info']) logger[level] = capture[level].bind(capture);
    const app = await listen(createApp({ logger: capture })); const r = http(app.base);
    const marker = 'RECHECK_SYNTHETIC_PASSWORD_ONLY';
    const big = await r('/api/auth/login', { body: JSON.stringify({ username: 'x', password: marker + 'x'.repeat(40_000) }) });
    const malformed = await r('/api/auth/login', { body: `{"username":"x","password":"${marker}",broken}` });
    const statuses = [];
    for (let i = 0; i < 16; i++) statuses.push((await r('/api/auth/login', { body: '{invalid' })).status);
    const queryMarker = 'RECHECK_QUERY_SECRET';
    const plain = addUser('PlainPlayer'); const ps = addSession(plain.id);
    const denied = await r(`/api/admin/hands/00000000-0000-4000-8000-000000000000/audit?token=${queryMarker}`, { method: 'GET', token: ps.accessToken });
    await pause(200);
    for (const level of ['error', 'warn', 'info']) logger[level] = () => {};
    const all = lines.join('');
    results.J_logHygiene = { malformedStatus: malformed.status, oversizeStatus: big.status, passwordInLogs: all.includes(marker), sixteenMalformed: statuses.join(','),
      adminDeniedStatus: denied.status, querySecretInLogs: all.includes(queryMarker),
      querySecretLogLines: lines.filter((l) => l.includes(queryMarker)).map((l) => { const o = JSON.parse(l); return { msg: o.msg, path: o.path, security: o.security, audit: o.audit }; }) };
  }
  // ---------------- K: shared-IP limits (CR-015, F20) ----------------
  {
    const app = await listen(createApp()); const r = http(app.base);
    const people = Array.from({ length: 50 }, (_, i) => { const u = addUser(`Crowd_${i}`); return addSession(u.id); });
    const statuses = [];
    for (let round = 0; round < 3; round++) for (const p of people) statuses.push((await r('/api/tables', { method: 'GET', token: p.accessToken })).status);
    for (const p of people) statuses.push((await r('/api/auth/refresh', { cookie: cookieOf(p.refreshToken), headers: { Origin: env.CLIENT_ORIGIN } })).status);
    const count = (list, s) => list.filter((x) => x === s).length;
    const guests = [];
    for (let i = 0; i < 20; i++) guests.push((await r('/api/auth/guest', { body: TERMS, headers: { Origin: env.CLIENT_ORIGIN } })).status);
    // K2: 130 different sessions refresh once each from one IP (fresh app). The refresh limiter is keyed per
    // cookie, but the general limiter also runs on /api/auth/refresh, and a refresh carries no bearer token.
    const app2 = await listen(createApp()); const r2 = http(app2.base);
    const crowd = Array.from({ length: 130 }, (_, i) => { const u = addUser(`Nat_${i}`); return addSession(u.id); });
    const refreshes = [];
    for (const p of crowd) refreshes.push(await r2('/api/auth/refresh', { cookie: cookieOf(p.refreshToken), headers: { Origin: env.CLIENT_ORIGIN } }));
    const limited = refreshes.filter((x) => x.status === 429);
    results.K_sharedIp = { fiftyUsersOneIp_requests: statuses.length, ok: count(statuses, 200), tooMany: count(statuses, 429),
      guestCreations20OneIp: { created: count(guests, 201), tooMany: count(guests, 429) },
      distinctSessionsRefreshingOnceFromOneIp: { sessions: crowd.length, ok: refreshes.filter((x) => x.status === 200).length, tooMany: limited.length,
        firstLimitedAt: refreshes.findIndex((x) => x.status === 429) + 1, rateLimitPolicyHeader: limited[0]?.headers.get('ratelimit-policy') ?? null } };
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const c of clients) c.disconnect();
  tableManager.stop();
  await new Promise((r) => io.close(r));
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  await prisma.$disconnect().catch(() => {});
}
