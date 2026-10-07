/**
 * Local evidence probes for the 2026-09-29 backend review, not a security gate.
 * Run after npm run build:core && npm run build -w @poker/server.
 * All credentials are disposable, Prisma methods are replaced in memory, and
 * DATABASE_URL points to loopback port 1. No configured database is contacted.
 * Output describes observed gaps; successful execution does not mean security passed.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import pino from 'pino';
import { io as connect } from 'socket.io-client';

Object.assign(process.env, {
  NODE_ENV: 'production', CLIENT_ORIGIN: 'https://poker.example.test',
  DATABASE_URL: 'postgresql://audit:unused@127.0.0.1:1/audit?sslmode=require&sslaccept=strict',
  REDIS_URL: '', TRUST_PROXY_HOPS: '1', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d', DEFAULT_STARTING_BANKROLL: '10000',
});
const { prisma } = await import('../apps/server/dist/db/prisma.js');
const { createApp } = await import('../apps/server/dist/app.js');
const { createSocketServer } = await import('../apps/server/dist/socket/index.js');
const { TableManager, tableManager } = await import('../apps/server/dist/game/manager.js');
const { encryptState } = await import('../apps/server/dist/game/encryption.js');
const { createTable, sitDown, startHand, applyAction, legalActions, verifyHandOutcome } = await import('../packages/engine/dist/index.js');
const { signAccessToken, signRefreshToken } = await import('../apps/server/dist/auth/jwt.js');
const { authenticate } = await import('../apps/server/dist/auth/middleware.js');
const { logger } = await import('../apps/server/dist/logger.js');
const { SOCKET_EVENTS, verifySealedAudit, genesisPreimage, eventPreimage, finalStatePreimage } = await import('../packages/shared/dist/index.js');
const { sealedAudit } = await import('../packages/engine/dist/audit.js');

const users = new Map();
const sessions = new Map();
const logged = [];
// Use the same default error serializer as the production pino logger.
logger.error = (fields) => logged.push(JSON.stringify({ ...fields, err: pino.stdSerializers.err(fields.err) }));
logger.warn = () => {};
logger.info = () => {};
prisma.user.findUnique = async ({ where }) => users.get(where.id) ?? [...users.values()].find((u) => u.username === where.username) ?? null;
prisma.user.create = async ({ data }) => {
  const user = { id: `audit-user-${users.size}`, email: null, role: 'PLAYER', kind: 'HUMAN', botProfile: null, ...data };
  users.set(user.id, user); return user;
};
prisma.session.create = async ({ data }) => {
  const session = { id: `audit-session-${sessions.size}`, createdAt: new Date(), ...data };
  sessions.set(session.id, session); return session;
};
prisma.session.update = async ({ where, data }) => Object.assign(sessions.get(where.id), data);
prisma.session.findUnique = async ({ where }) => {
  const session = sessions.get(where.id);
  return session ? { ...session, user: users.get(session.userId) } : null;
};
prisma.session.updateMany = async ({ where, data }) => {
  const session = sessions.get(where.id);
  if (!session || session.refreshToken !== where.refreshToken) return { count: 0 };
  Object.assign(session, data); return { count: 1 };
};
prisma.session.deleteMany = async ({ where }) => ({ count: Number(sessions.delete(where.id)) });
prisma.session.delete = async ({ where }) => { sessions.delete(where.id); };
prisma.tableSeat.findUnique = async () => null;

const server = createServer(createApp());
const sockets = createSocketServer(server);
tableManager.stop();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (path, { method = 'POST', body = '{}', headers = {} } = {}) => fetch(base + path, {
  method, ...(method === 'GET' ? {} : { body }),
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', ...headers },
});
const observations = {};
let client;
try {
  const marker = 'AUDIT_SYNTHETIC_PASSWORD_ONLY';
  const malformed = await request('/api/auth/login', { body: `{"password":"${marker}",broken}` });
  observations.malformedJson = { status: malformed.status, syntheticPasswordInErrorLog: logged.some((s) => s.includes(marker)) };
  assert.equal(observations.malformedJson.syntheticPasswordInErrorLog, true);
  const invalidStatuses = [];
  for (let i = 0; i < 16; i++) invalidStatuses.push((await request('/api/auth/login', { body: '{invalid' })).status);
  observations.malformedJson.bypassesAuthLimiter = invalidStatuses.every((s) => s === 500);

  const guest = await request('/api/auth/guest', {
    body: '', headers: { 'Content-Type': 'text/plain', Origin: 'https://untrusted.example.test' },
  });
  const guestBody = await guest.json();
  observations.crossOriginGuest = { status: guest.status, bankrollGranted: guestBody.user.bankroll };
  assert.equal(guest.status, 201);
  const cookie = guest.headers.get('set-cookie').split(';')[0];
  const me = await request('/api/auth/me', { method: 'GET', headers: { Authorization: `Bearer ${guestBody.accessToken}` } });
  observations.authCaching = { meCacheControl: me.headers.get('cache-control'), guestCacheControl: guest.headers.get('cache-control') };

  const refresh = await request('/api/auth/refresh', { headers: { Cookie: cookie } });
  assert.equal(refresh.status, 200);
  const renewed = await refresh.json();
  const replay = await request('/api/auth/refresh', { headers: { Cookie: cookie } });
  const stillValid = await authenticate(renewed.accessToken);
  observations.refreshReplay = { replayStatus: replay.status, rotatedSessionStillValid: Boolean(stillValid) };

  const old = [...sessions.values()][0];
  old.createdAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const oldRefresh = signRefreshToken(old.userId, old.id);
  old.refreshToken = createHash('sha256').update(oldRefresh).digest('hex');
  const oldResponse = await request('/api/auth/refresh', { headers: { Cookie: `${cookie.split('=')[0]}=${oldRefresh}` } });
  observations.absoluteSessionAge = { createdDaysAgo: 365, refreshStatus: oldResponse.status };
  assert.equal(oldResponse.status, 200);

  const token = signAccessToken(old.userId, users.get(old.userId).username, old.id);
  client = connect(base, { auth: { token }, transports: ['websocket'], autoConnect: false, reconnection: false,
    extraHeaders: { 'X-Forwarded-Proto': 'https', Origin: process.env.CLIENT_ORIGIN } });
  const ready = once(client, SOCKET_EVENTS.AUTH_OK, { signal: AbortSignal.timeout(5000) });
  client.connect(); await ready;
  sessions.delete(old.id);
  await assert.rejects(authenticate(token));
  const patch = once(client, SOCKET_EVENTS.USER_PATCH, { signal: AbortSignal.timeout(5000) });
  await tableManager.patchBankroll(old.userId);
  const [received] = await patch;
  observations.revokedSocket = { httpAuthenticationRejected: true, stillReceivedBankroll: received.bankroll };

  const health = await request('/api/health', { method: 'GET' });
  observations.healthWithoutDatabase = { status: health.status, ok: (await health.json()).ok };

  const weak = '0'.repeat(64);
  const configProbe = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./apps/server/dist/config.js')"], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, GAME_ENCRYPTION_KEY: weak, JWT_ACCESS_SECRET: weak, JWT_REFRESH_SECRET: '1'.repeat(64) },
  });
  observations.productionSecretValidation = { acceptsZeroEncryptionKeyReusedAsAccessSecret: configProbe.status === 0 };

  const seat = (table, index) => sitDown(table, index, { userId: `fixture-${index}`, username: `Fixture_${index}`,
    kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  const empty = () => createTable({ tableId: 'audit-fixture', name: 'Audit fixture', maxSeats: 3,
    smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  let row = { id: 'audit-fixture', status: 'WAITING', stateCiphertext: encryptState(seat(seat(empty(), 0), 1), 'table:audit-fixture') };
  const seatWrites = [];
  prisma.table.findUnique = async () => structuredClone(row);
  prisma.table.findMany = async () => [{ id: row.id }];
  prisma.$transaction = async (fn) => {
    let pendingRow = structuredClone(row);
    const tx = {
      $queryRaw: async () => [{ id: row.id }],
      table: { findUnique: async () => structuredClone(pendingRow), update: async ({ data }) => { pendingRow = { ...pendingRow, ...data }; } },
      user: { updateMany: async () => ({ count: 0 }) },
      tableSeat: { update: async (args) => { seatWrites.push(args); } },
    };
    const result = await fn(tx); row = pendingRow; return result;
  };
  const walletManager = new TableManager(); walletManager.stop();
  await walletManager.standUp(row.id, 'fixture-0');
  const afterCashout = await walletManager.get(row.id);
  observations.missingCashoutRecipient = { creditedRows: 0, playerSeatReleased: afterCashout.players[0] === null,
    remainingCashoutInstructions: afterCashout.cashOuts.length };
  assert.equal(afterCashout.players[0], null);

  let oldHand = startHand(seat(seat(seat(empty(), 0), 1), 2), Date.now() - 60_000);
  row = { id: oldHand.tableId, status: oldHand.status, stateCiphertext: encryptState(oldHand, `table:${oldHand.tableId}`) };
  const recovery = new TableManager();
  const startedRecovery = Date.now();
  let deadline;
  try {
    const timedOut = new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Recovery probe timed out')), 5000);
      recovery.mutate = async (_id, fn) => {
        const next = await fn(oldHand, {});
        recovery.stop(); resolve(next); return next;
      };
    });
    await recovery.recover();
    const recovered = await timedOut;
    observations.outageRecovery = { resumedAction: recovered.actions.at(-1).action, elapsedMs: Date.now() - startedRecovery,
      originalTurnExpiredDuringOutage: true };
  } finally { recovery.stop(); clearTimeout(deadline); }

  let hand = startHand(seat(seat(seat(empty(), 0), 1), 2));
  while (hand.phase !== 'SHOWDOWN') {
    const action = legalActions(hand, hand.toActSeat).actions.includes('CHECK') ? 'CHECK' : 'CALL';
    hand = applyAction(hand, hand.players[hand.toActSeat].userId, { action });
  }
  const record = structuredClone(hand.audit);
  const forgedAction = record.events.find((event) => event.type === 'PLAYER_ACTION' && event.data.action === 'CALL');
  assert.ok(forgedAction && forgedAction.data.amount > 0);
  forgedAction.data.action = 'CHECK';
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  let previous = sha(genesisPreimage(record));
  for (const event of record.events) {
    event.prevHash = previous;
    const { hash: _hash, ...body } = event;
    event.hash = sha(eventPreimage(record.handId, body)); previous = event.hash;
  }
  record.finalStateHash = sha(finalStatePreimage(record.handId, previous, record.events.length, record.settledAt));
  const sealed = sealedAudit(hand.fairness);
  observations.auditBettingLegality = { forgedAction: 'CHECK', amount: forgedAction.data.amount,
    resealedCardVerificationPasses: (await verifySealedAudit(record, sealed)).ok,
    outcomeVerificationPasses: verifyHandOutcome(record, sealed).ok };
  console.log(JSON.stringify({ purpose: 'Evidence of current gaps, not security pass/fail', observations }, null, 2));
} finally {
  client?.disconnect();
  tableManager.stop();
  await new Promise((resolve) => sockets.close(resolve));
  server.closeAllConnections();
  await prisma.$disconnect();
}
