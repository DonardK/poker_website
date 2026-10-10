/**
 * Re-check (2026-10-07) for CR-015: does the lobby list revalidate (ETag ->
 * 304) when the browser's HTTP cache sends If-None-Match? Uses node:http
 * directly (undici fetch adds Cache-Control: no-cache to conditional requests
 * per the Fetch spec, which a browser's own cache revalidation does not).
 *
 * SAFETY: dead loopback DATABASE_URL/DIRECT_URL set before any server import;
 * Prisma methods stubbed; listens on port 0. Every config variable is set.
 *
 * Usage: node review/claude/recheck/auth-security/lobby-revalidation.mjs
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';

const DEAD = 'postgresql://review:unused@127.0.0.1:1/review';
Object.assign(process.env, {
  NODE_ENV: 'test', CLIENT_ORIGIN: 'http://127.0.0.1:3999', PUBLIC_API_ORIGIN: '', COOKIE_SITE: '', HOST: '', PORT: '4999',
  DATABASE_URL: DEAD, DIRECT_URL: DEAD, REDIS_URL: '', TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'), GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d', DEFAULT_STARTING_BANKROLL: '10000', TURN_TIME_BANK_MS: '20000',
  SESSION_IDLE_TTL: '', SESSION_ABSOLUTE_TTL: '', TERMS_VERSION: 'review-terms-1', ENABLE_LEGACY_BOTS: 'false',
  TIME_BANK_INITIAL_MS: '', TIME_BANK_MAX_MS: '', TIME_BANK_REFILL_MS: '', TIME_BANK_REFILL_EVERY_HANDS: '',
});
const { prisma } = await import('../../../../apps/server/dist/db/prisma.js');
const { createApp } = await import('../../../../apps/server/dist/app.js');
const { logger } = await import('../../../../apps/server/dist/logger.js');
const { signAccessToken, signRefreshToken } = await import('../../../../apps/server/dist/auth/jwt.js');
for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) logger[level] = () => {};

const user = { id: 'u-1', username: 'Lobby_Viewer', usernameCanonical: 'lobby_viewer', kind: 'HUMAN', isGuest: true, bankroll: 10_000, role: 'PLAYER' };
const sid = randomUUID();
const exp = new Date(Date.now() + 86_400_000);
const session = { id: sid, userId: user.id, refreshToken: createHash('sha256').update(signRefreshToken(user.id, sid, exp)).digest('hex'), expiresAt: exp,
  absoluteExpiresAt: exp, createdAt: new Date(), lastUsedAt: new Date(), revokedAt: null, revokeReason: null, previousTokenHash: null, rotatedAt: null };
prisma.session.findUnique = async () => ({ ...session, user });
prisma.table.findMany = async () => [{ id: 't1', name: 'A', status: 'WAITING', maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000, seats: [] }];
prisma.tableSeat.findUnique = async () => null;
const token = signAccessToken(user.id, user.username, sid);

const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const get = (headers) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: '/api/tables', method: 'GET', headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag, cacheControl: res.headers['cache-control'], vary: res.headers.vary, bytes: body.length }));
  });
  req.on('error', reject); req.end();
});
try {
  const first = await get({});
  const revalidate = await get({ 'If-None-Match': first.etag });
  console.log(JSON.stringify({ first, revalidate }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await prisma.$disconnect().catch(() => {});
}
