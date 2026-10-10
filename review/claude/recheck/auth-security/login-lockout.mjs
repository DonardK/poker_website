/**
 * Re-check (2026-10-07): the per-account login lockout added on 2026-10-05
 * (apps/server/src/auth/routes.ts:27-42, :198-227). Shows that anyone who
 * knows a username (it is shown at every table) can keep that account
 * locked: one wrong guess each time a lock lapses re-locks it, and the owner's
 * CORRECT password gets the same 401 "Invalid credentials" throughout.
 * Lock expiry is simulated by moving lockedUntil into the past (no waiting).
 * SAFETY: dead loopback DATABASE_URL/DIRECT_URL set before any server import;
 * Prisma stubbed in memory; listens on port 0 only.
 *
 * Usage (repo root): node review/claude/recheck/auth-security/login-lockout.mjs
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
const bcrypt = createRequire(new URL('apps/server/package.json', root))('bcryptjs');
const imp = (p) => import(new URL(p, root).href);
const { prisma } = await imp('apps/server/dist/db/prisma.js');
const { createApp } = await imp('apps/server/dist/app.js');
const { logger } = await imp('apps/server/dist/logger.js');
for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) logger[level] = () => {};

const PASSWORD = 'the owners correct password';
const victim = { id: 'victim', username: 'Victim', usernameCanonical: 'victim', kind: 'HUMAN', role: 'PLAYER', isGuest: false, email: null, botProfile: null,
  bankroll: 10_000, avatarHue: 0, passwordHash: bcrypt.hashSync(PASSWORD, 4), failedLoginCount: 0, lockedUntil: null };
prisma.user.findUnique = async ({ where }) => (where.usernameCanonical === 'victim' || where.id === 'victim' ? { ...victim } : null);
prisma.user.update = async ({ data, select }) => {
  for (const [k, v] of Object.entries(data)) victim[k] = v && typeof v === 'object' && 'increment' in v ? victim[k] + v.increment : v;
  return select ? { failedLoginCount: victim.failedLoginCount } : { ...victim };
};
prisma.user.updateMany = async ({ data }) => { Object.assign(victim, data); return { count: 1 }; };
prisma.session.create = async ({ data }) => data;

// Several apps: each request comes from a "different IP" as far as the 15/min per-IP limiter is concerned.
const apps = [];
async function freshBase() { const s = createServer(createApp()); apps.push(s); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
const login = async (password) => {
  const base = await freshBase();
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'victim', password }) });
  return [r.status, (await r.json()).error ?? 'signed in'];
};
const lockSeconds = () => victim.lockedUntil ? Math.round((victim.lockedUntil.getTime() - Date.now()) / 1000) : 0;

const timeline = [];
for (let i = 1; i <= 5; i++) await login(`attacker guess ${i}`);
timeline.push({ step: 'attacker: 5 wrong guesses', lockSeconds: lockSeconds(), ownerWithCorrectPassword: await login(PASSWORD) });
let attackerRequests = 5;
for (let cycle = 1; cycle <= 8; cycle++) {
  victim.lockedUntil = new Date(Date.now() - 1); // the lock lapses
  await login(`attacker guess after lapse ${cycle}`); attackerRequests += 1;
  timeline.push({ step: `lock lapsed #${cycle}; attacker sends ONE wrong guess`, lockSeconds: lockSeconds(), ownerWithCorrectPassword: await login(PASSWORD) });
}
console.log(JSON.stringify({ timeline, attackerRequests, steadyStateLockMinutes: lockSeconds() / 60,
  attackerRequestsPerDayToKeepLocked: Math.ceil(86_400 / Math.max(lockSeconds(), 1)) }, null, 2));
for (const s of apps) { s.closeAllConnections(); s.close(); }
