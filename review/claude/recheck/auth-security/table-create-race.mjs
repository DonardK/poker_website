/**
 * Re-check (2026-10-07) of the CR-016 sibling path: a double-submitted
 * "Open table" whose second transaction loses on the TableSeat.userId unique
 * key (Prisma P2002). Prisma is stubbed in memory; the second table.create
 * throws the P2002 Postgres would raise once the first transaction committed.
 * SAFETY: dead loopback DATABASE_URL/DIRECT_URL set before any server import;
 * listens on port 0 only.
 *
 * Usage (repo root): node review/claude/recheck/auth-security/table-create-race.mjs
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const DEAD = 'postgresql://review:unused@127.0.0.1:1/review';
Object.assign(process.env, {
  NODE_ENV: 'test', CLIENT_ORIGIN: 'http://127.0.0.1:3999', PUBLIC_API_ORIGIN: '', COOKIE_SITE: '', HOST: '', PORT: '4999',
  DATABASE_URL: DEAD, DIRECT_URL: DEAD, REDIS_URL: '', TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'), GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d', SESSION_IDLE_TTL: '', SESSION_ABSOLUTE_TTL: '', TERMS_VERSION: '',
  DEFAULT_STARTING_BANKROLL: '10000', TURN_TIME_BANK_MS: '20000', ENABLE_LEGACY_BOTS: '',
  TIME_BANK_INITIAL_MS: '', TIME_BANK_MAX_MS: '', TIME_BANK_REFILL_MS: '', TIME_BANK_REFILL_EVERY_HANDS: '',
});
const root = new URL('../../../../', import.meta.url);
const { Prisma } = createRequire(new URL('apps/server/package.json', root))('@prisma/client');
const imp = (p) => import(new URL(p, root).href);
const { prisma } = await imp('apps/server/dist/db/prisma.js');
const { createApp } = await imp('apps/server/dist/app.js');
const { logger } = await imp('apps/server/dist/logger.js');
const { signAccessToken } = await imp('apps/server/dist/auth/jwt.js');
const { tableManager } = await imp('apps/server/dist/game/manager.js');
for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) logger[level] = () => {};
tableManager.track = async () => {};

const user = { id: 'host-1', username: 'Host', kind: 'HUMAN', bankroll: 10_000, role: 'PLAYER', isGuest: false };
const session = { id: 'sess-1', userId: user.id, expiresAt: new Date(Date.now() + 86_400_000), absoluteExpiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, revokeReason: null };
let creates = 0;
prisma.session.findUnique = async () => ({ ...session, user: { ...user } });
prisma.user.findUnique = async () => ({ ...user });
prisma.$transaction = async (fn) => fn({
  tableSeat: { findFirst: async () => { await new Promise((r) => setTimeout(r, 20)); return null; } }, // both double-submits read before either commits
  user: { updateMany: async () => ({ count: 1 }) },
  table: { create: async () => {
    creates += 1;
    if (creates === 2) throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`userId`)', { code: 'P2002', clientVersion: 'review', meta: { modelName: 'TableSeat', target: ['userId'] } });
    return { id: 'table-1' };
  } },
});

const server = createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const token = signAccessToken(user.id, user.username, session.id);
const post = () => fetch(`${base}/api/tables`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: process.env.CLIENT_ORIGIN },
  body: JSON.stringify({ smallBlind: 5, bigBlind: 10, buyIn: 1000, botCount: 0, maxSeats: 6 }) }).then(async (r) => [r.status, await r.json()]);
const both = await Promise.all([post(), post()]);
console.log(JSON.stringify({ doubleSubmit: both }, null, 2));
server.closeAllConnections(); server.close();
