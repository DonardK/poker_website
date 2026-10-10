/**
 * Claude review — session and socket-authentication behaviour of the real
 * server code (apps/server/dist) with Prisma replaced in memory.
 * Nothing here can reach a database: DATABASE_URL points at loopback port 1
 * and every Prisma method used is stubbed. Listens on an ephemeral port.
 *
 * Demonstrates:
 *  A. Two refreshes of one session at the same moment (two tabs, or a
 *     browser restoring tabs): one gets 401. The web client treats that 401
 *     as a sign-out (apps/web/src/components/auth-hydrator.tsx:36-50).
 *  B. A transient database error while re-authenticating a socket packet
 *     is reported to the player as "Please sign in again" and the socket is
 *     disconnected (apps/server/src/socket/index.ts:87-88).
 *  C. The same on a table broadcast: the viewer is silently disconnected
 *     (apps/server/src/game/manager.ts:295).
 *  D. A socket outlives its handshake access token only until its next
 *     packet: then it is disconnected (JWT_ACCESS_TTL shortened to 3s here).
 *  E. Two registrations of one username at the same moment: the loser gets
 *     HTTP 500 "Request could not be completed" instead of 409.
 *  F. A transient DB error during /refresh deletes the refresh cookie while
 *     the session is still valid (GPT-6.1-Sol SOL-011, re-checked here).
 *
 * Usage: node review/claude/repro/server-sessions.mjs
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';

Object.assign(process.env, {
  NODE_ENV: 'test', CLIENT_ORIGIN: 'http://127.0.0.1:3999',
  DATABASE_URL: 'postgresql://review:unused@127.0.0.1:1/review', REDIS_URL: '',
  TRUST_PROXY_HOPS: '0', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '3s', JWT_REFRESH_TTL: '7d', DEFAULT_STARTING_BANKROLL: '10000',
});
const { prisma } = await import('../../../apps/server/dist/db/prisma.js');
const { createApp } = await import('../../../apps/server/dist/app.js');
const { createSocketServer } = await import('../../../apps/server/dist/socket/index.js');
const { tableManager } = await import('../../../apps/server/dist/game/manager.js');
const { logger } = await import('../../../apps/server/dist/logger.js');
const { createTable } = await import('../../../packages/engine/dist/index.js');
const { SOCKET_EVENTS } = await import('../../../packages/shared/dist/index.js');

for (const level of ['error', 'warn', 'info', 'debug']) logger[level] = () => {};

// ---- in-memory Prisma --------------------------------------------------------
const users = new Map();
const sessions = new Map();
let failNextSessionLookup = false;
const uniqueViolation = () => Object.assign(new Error('Unique constraint failed on the fields: (`username`)'), { code: 'P2002' });
prisma.user.findUnique = async ({ where }) => users.get(where.id) ?? [...users.values()].find((u) => u.username === where.username) ?? null;
prisma.user.findFirst = async ({ where }) => [...users.values()].find((u) => where.OR.some((c) => (c.username && u.username === c.username) || (c.email && u.email === c.email))) ?? null;
prisma.user.create = async ({ data }) => {
  if ([...users.values()].some((u) => u.username === data.username)) throw uniqueViolation();
  const user = { id: `review-user-${users.size}`, email: null, role: 'PLAYER', kind: 'HUMAN', botProfile: null, ...data };
  users.set(user.id, user); return user;
};
prisma.user.update = async ({ where, data }) => Object.assign(users.get(where.id), data);
prisma.session.create = async ({ data }) => {
  const session = { id: `review-session-${sessions.size}`, createdAt: new Date(), ...data };
  sessions.set(session.id, session); return session;
};
prisma.session.update = async ({ where, data }) => Object.assign(sessions.get(where.id), data);
prisma.session.findUnique = async ({ where }) => {
  if (failNextSessionLookup) { failNextSessionLookup = false; throw new Error('Timed out fetching a new connection from the connection pool'); }
  const session = sessions.get(where.id);
  return session ? { ...structuredClone(session), user: users.get(session.userId) } : null;
};
prisma.session.updateMany = async ({ where, data }) => {
  const session = sessions.get(where.id);
  if (!session || session.refreshToken !== where.refreshToken) return { count: 0 };
  Object.assign(session, data); return { count: 1 };
};
prisma.session.delete = async ({ where }) => { sessions.delete(where.id); };
prisma.session.deleteMany = async ({ where }) => ({ count: Number(sessions.delete(where.id)) });
prisma.tableSeat.findUnique = async () => null;
prisma.table.findUnique = async () => null;

const server = createServer(createApp());
const io = createSocketServer(server);
tableManager.stop();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, { body = '{}', headers = {} } = {}) => fetch(base + path, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
const results = {};
const clients = [];
const openSocket = async (token) => {
  const client = connect(base, { auth: { token }, transports: ['websocket'], reconnection: false, autoConnect: false,
    extraHeaders: { Origin: process.env.CLIENT_ORIGIN } });
  clients.push(client);
  const ready = once(client, SOCKET_EVENTS.AUTH_OK, { signal: AbortSignal.timeout(5000) });
  client.connect(); await ready;
  return client;
};
const refusalAndDisconnect = (client) => Promise.all([
  once(client, SOCKET_EVENTS.SERVER_ERROR, { signal: AbortSignal.timeout(5000) }).then(([payload]) => payload),
  once(client, 'disconnect', { signal: AbortSignal.timeout(5000) }).then(([reason]) => reason),
]);

try {
  // A. Concurrent refresh of one session.
  const guest = await post('/api/auth/guest');
  const guestBody = await guest.json();
  const cookie = guest.headers.get('set-cookie').split(';')[0];
  const [r1, r2] = await Promise.all([post('/api/auth/refresh', { headers: { Cookie: cookie } }), post('/api/auth/refresh', { headers: { Cookie: cookie } })]);
  results.A_concurrentRefresh = {
    statuses: [r1.status, r2.status].sort(),
    loserBody: await (r1.status === 401 ? r1 : r2).json(),
    sessionStillValidForWinner: sessions.size === 1,
    clientConsequence: 'auth-hydrator.tsx:36-50 treats any non-network, non-429, non-5xx failure as sign-out: disconnectSocket(); clearSession(); clearLiveEvidence()',
  };

  // B. Transient DB error while re-authenticating a socket packet.
  const socketB = await openSocket(guestBody.accessToken);
  const expectedB = refusalAndDisconnect(socketB);
  failNextSessionLookup = true;
  socketB.emit(SOCKET_EVENTS.REHYDRATE, {});
  const [refusalB, reasonB] = await expectedB;
  results.B_transientDbErrorOnPacket = { refusal: refusalB, disconnectReason: reasonB, sessionActuallyValid: sessions.size === 1 };

  // C. Transient DB error during a table broadcast.
  const login2 = await post('/api/auth/guest');
  const socketC = await openSocket((await login2.json()).accessToken);
  const table = createTable({ tableId: 'review-broadcast', name: 'Broadcast', maxSeats: 2, smallBlind: 5, bigBlind: 10, timeBankMs: 15000 });
  io.in(socketC.id).socketsJoin('table:review-broadcast');
  const disconnectedC = once(socketC, 'disconnect', { signal: AbortSignal.timeout(5000) }).then(([reason]) => reason);
  failNextSessionLookup = true;
  await tableManager.broadcast(table);
  results.C_transientDbErrorOnBroadcast = { disconnectReason: await disconnectedC, toldWhy: false };

  // D. Handshake token expiry on a live socket (TTL shortened to 3s for the demonstration; production default 15m).
  const login3 = await post('/api/auth/guest');
  const socketD = await openSocket((await login3.json()).accessToken);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const expectedD = refusalAndDisconnect(socketD);
  socketD.emit(SOCKET_EVENTS.REHYDRATE, {});
  const [refusalD, reasonD] = await expectedD;
  results.D_tokenExpiryOnLiveSocket = { refusal: refusalD, disconnectReason: reasonD };

  // F. (GPT-6.1-Sol SOL-011, independently re-checked) A transient DB error during /refresh
  // lands in the route's catch-all, which DELETES the refresh cookie: the session is lost for good
  // (for a guest, the whole account, since guests have no password).
  const guestF = await post('/api/auth/guest');
  const cookieF = guestF.headers.get('set-cookie').split(';')[0];
  failNextSessionLookup = true;
  const refreshF = await post('/api/auth/refresh', { headers: { Cookie: cookieF } });
  const setCookieF = refreshF.headers.get('set-cookie') ?? '';
  results.F_transientDbErrorOnRefresh = {
    status: refreshF.status, body: await refreshF.json(),
    refreshCookieCleared: /poker_refresh=;/.test(setCookieF) && /Expires=Thu, 01 Jan 1970/i.test(setCookieF),
    sessionStillValidOnServer: [...sessions.values()].some((s) => s.userId === [...users.values()].at(-1).id),
  };

  // E. Concurrent registration of one username.
  const body = JSON.stringify({ username: 'RaceName', email: 'race@example.test', password: 'correct-horse-battery' });
  const body2 = JSON.stringify({ username: 'RaceName', email: 'race2@example.test', password: 'correct-horse-battery' });
  const [e1, e2] = await Promise.all([post('/api/auth/register', { body }), post('/api/auth/register', { body: body2 })]);
  const loser = e1.status === 201 ? e2 : e1;
  results.E_concurrentRegistration = { statuses: [e1.status, e2.status].sort(), loserBody: await loser.json() };

  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const client of clients) client.disconnect();
  tableManager.stop();
  await new Promise((resolve) => io.close(resolve));
  server.closeAllConnections();
  await prisma.$disconnect();
}
