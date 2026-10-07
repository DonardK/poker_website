/**
 * Re-check (2026-10-07) of startup configuration items: CR-040 (bounds and
 * durations), F11 (key/secret reuse), CR-012 (cookie-site check), F15 (proxy
 * trust, listener interface). Each case imports ONLY apps/server/dist/config.js
 * in a fresh child process. Every variable config.ts reads is set explicitly
 * (blank = unset), so the repository .env cannot fill any of them; the
 * database URL is a dead loopback port and config.ts opens no connection.
 * Only the first line of an error message is printed (messages name
 * variables, not secret values).
 *
 * Usage (repo root): node review/claude/recheck/auth-security/config-recheck.mjs
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../../../../', import.meta.url);
const serverDir = fileURLToPath(new URL('apps/server/', root));
const configUrl = pathToFileURL(fileURLToPath(new URL('apps/server/dist/config.js', root))).href;
const DEAD = 'postgresql://review:unused@127.0.0.1:1/review';
const hex = () => randomBytes(32).toString('hex');
const secret = () => randomBytes(48).toString('base64url');

function base(overrides) {
  return {
    ...process.env,
    NODE_ENV: 'development', PORT: '4999', HOST: '', CLIENT_ORIGIN: 'http://localhost:3999', PUBLIC_API_ORIGIN: '', COOKIE_SITE: '',
    DATABASE_URL: DEAD, DIRECT_URL: DEAD, REDIS_URL: '',
    GAME_ENCRYPTION_KEY: hex(), GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
    TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    JWT_ACCESS_SECRET: secret(), JWT_REFRESH_SECRET: secret(), JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d',
    SESSION_IDLE_TTL: '', SESSION_ABSOLUTE_TTL: '', TERMS_VERSION: '',
    DEFAULT_STARTING_BANKROLL: '10000', TURN_TIME_BANK_MS: '20000', ENABLE_LEGACY_BOTS: '',
    TIME_BANK_INITIAL_MS: '', TIME_BANK_MAX_MS: '', TIME_BANK_REFILL_MS: '', TIME_BANK_REFILL_EVERY_HANDS: '',
    ...overrides,
  };
}
const PROD = { NODE_ENV: 'production', CLIENT_ORIGIN: 'https://poker.example.com', TRUST_PROXY_HOPS: '1', TRUSTED_PROXY_CIDRS: '10.0.0.5',
  DATABASE_URL: `${DEAD}?sslmode=require&sslaccept=strict` };

function load(overrides) {
  const source = `try { const { env, authConfig } = await import(${JSON.stringify(configUrl)});
    console.log('RESULT ' + JSON.stringify({ ok: true, HOST: env.HOST, JWT_ACCESS_TTL: env.JWT_ACCESS_TTL, bankroll: env.DEFAULT_STARTING_BANKROLL, idleMs: authConfig.sessionIdleTtlMs }));
  } catch (err) { console.log('RESULT ' + JSON.stringify({ ok: false, error: String(err && err.message).split('\\n')[0].slice(0, 170) })); }`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: serverDir, env: base(overrides), encoding: 'utf8', timeout: 30_000 });
  const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  return line ? JSON.parse(line.slice(7)) : { ok: false, error: `no result (exit ${run.status})` };
}

const zero = '0'.repeat(64); const key = hex();
const cases = {
  'CR-040 DEFAULT_STARTING_BANKROLL=2147483648': { DEFAULT_STARTING_BANKROLL: '2147483648' },
  'CR-040 TURN_TIME_BANK_MS=2147483648': { TURN_TIME_BANK_MS: '2147483648' },
  'CR-040 JWT_ACCESS_TTL=not-a-duration': { JWT_ACCESS_TTL: 'not-a-duration' },
  'CR-040 JWT_ACCESS_TTL=900 (bare seconds)': { JWT_ACCESS_TTL: '900' },
  'CR-040 JWT_ACCESS_TTL=61m': { JWT_ACCESS_TTL: '61m' },
  'CR-040 JWT_ACCESS_TTL=60s (below the 10 min client refresh)': { JWT_ACCESS_TTL: '60s' },
  'CR-040 JWT_ACCESS_TTL=9m (below the 10 min client refresh)': { JWT_ACCESS_TTL: '9m' },
  'CR-040 TIME_BANK_INITIAL_MS=2147483648': { TIME_BANK_INITIAL_MS: '2147483648' },
  'CR-040 SESSION_IDLE_TTL=forever': { SESSION_IDLE_TTL: 'forever' },
  'F11 prod: all-zero key reused as access secret': { ...PROD, GAME_ENCRYPTION_KEY: zero, JWT_ACCESS_SECRET: zero, JWT_REFRESH_SECRET: '1'.repeat(64) },
  'F11 prod: random key reused as access secret': { ...PROD, GAME_ENCRYPTION_KEY: key, JWT_ACCESS_SECRET: key },
  'F11 prod: independent strong secrets': { ...PROD },
  'CR-012 prod: two *.vercel.app hosts': { ...PROD, CLIENT_ORIGIN: 'https://poker.vercel.app', PUBLIC_API_ORIGIN: 'https://poker-api.vercel.app', COOKIE_SITE: 'vercel.app' },
  'CR-012 prod: web vercel.app, API onrender.com': { ...PROD, CLIENT_ORIGIN: 'https://poker.vercel.app', PUBLIC_API_ORIGIN: 'https://poker-api.onrender.com' },
  'CR-012 prod: web vercel.app, PUBLIC_API_ORIGIN left unset': { ...PROD, CLIENT_ORIGIN: 'https://poker.vercel.app' },
  'CR-012 prod: app./api.example.com with COOKIE_SITE': { ...PROD, CLIENT_ORIGIN: 'https://app.example.com', PUBLIC_API_ORIGIN: 'https://api.example.com', COOKIE_SITE: 'example.com' },
  'CR-012 prod: app./api.co.uk with COOKIE_SITE=co.uk (a public suffix)': { ...PROD, CLIENT_ORIGIN: 'https://app.co.uk', PUBLIC_API_ORIGIN: 'https://api.co.uk', COOKIE_SITE: 'co.uk' },
  'F15 prod: proxy hops without TRUSTED_PROXY_CIDRS': { ...PROD, TRUSTED_PROXY_CIDRS: '' },
  'F15 prod: HOST left unset': { ...PROD },
};
const rows = {};
for (const [label, overrides] of Object.entries(cases)) rows[label] = load(overrides);
console.log(JSON.stringify(rows, null, 2));
