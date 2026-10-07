/**
 * Re-check (2026-10-07) of the startup configuration items F11, CR-040 and
 * CR-012. Each case imports ONLY apps/server/dist/config.js in a fresh child
 * process (the first module index.ts loads; it opens no connection). EVERY
 * variable config.ts reads is set here (blank = unset), so nothing from any
 * .env file can influence a case or appear in an error message; DATABASE_URL
 * and DIRECT_URL are the dead loopback URL.
 *
 * Usage: node review/claude/recheck/auth-security/config-probes.mjs
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const serverDir = join(repo, 'apps', 'server');
const configUrl = pathToFileURL(join(serverDir, 'dist', 'config.js')).href;
const hex = () => randomBytes(32).toString('hex');
const secret = () => randomBytes(48).toString('base64url');
const DEAD = 'postgresql://review:unused@127.0.0.1:1/review?sslmode=require&sslaccept=strict';

function baseEnv(overrides) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return {
    ...env,
    NODE_ENV: 'development', PORT: '4999', HOST: '', CLIENT_ORIGIN: 'http://localhost:3999', PUBLIC_API_ORIGIN: '', COOKIE_SITE: '',
    DATABASE_URL: DEAD, DIRECT_URL: DEAD, REDIS_URL: '',
    GAME_ENCRYPTION_KEY: hex(), GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
    TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '',
    JWT_ACCESS_SECRET: secret(), JWT_REFRESH_SECRET: secret(), JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d',
    DEFAULT_STARTING_BANKROLL: '10000', TURN_TIME_BANK_MS: '20000', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    SESSION_IDLE_TTL: '', SESSION_ABSOLUTE_TTL: '', TERMS_VERSION: 'review-terms-1', ENABLE_LEGACY_BOTS: '',
    TIME_BANK_INITIAL_MS: '', TIME_BANK_MAX_MS: '', TIME_BANK_REFILL_MS: '', TIME_BANK_REFILL_EVERY_HANDS: '',
    ...overrides,
  };
}
const PROD = { NODE_ENV: 'production', CLIENT_ORIGIN: 'https://poker.example.com', TRUST_PROXY_HOPS: '1', TRUSTED_PROXY_CIDRS: 'private' };

function load(overrides) {
  const source = `
    try {
      const { env, authConfig, gameConfig } = await import(${JSON.stringify(configUrl)});
      console.log('RESULT ' + JSON.stringify({ ok: true, JWT_ACCESS_TTL: env.JWT_ACCESS_TTL, bankroll: env.DEFAULT_STARTING_BANKROLL,
        turnMs: env.TURN_TIME_BANK_MS, hops: env.TRUST_PROXY_HOPS, idleTtlMs: authConfig.sessionIdleTtlMs, extraTimeBank: gameConfig.extraTimeBank }));
    } catch (err) { console.log('RESULT ' + JSON.stringify({ ok: false, error: String(err && err.message).slice(0, 220) })); }`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: serverDir, env: baseEnv(overrides), encoding: 'utf8', timeout: 30_000 });
  const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  return line ? JSON.parse(line.slice(7)) : { ok: false, error: `no result (exit ${run.status})` };
}

const zero = '0'.repeat(64);
const k = hex();
const cases = {
  // F11
  F11_zeroKeyReusedAsAccessSecret: { ...PROD, GAME_ENCRYPTION_KEY: zero, JWT_ACCESS_SECRET: zero, JWT_REFRESH_SECRET: '1'.repeat(64) },
  F11_randomKeyReusedAsAccessSecret: { ...PROD, GAME_ENCRYPTION_KEY: k, JWT_ACCESS_SECRET: k },
  F11_placeholderKey: { ...PROD, GAME_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
  F11_lowEntropyJwtSecret: { ...PROD, JWT_ACCESS_SECRET: 'ab'.repeat(20) },
  F11_twoKeyRingActiveK2: { ...PROD, GAME_ENCRYPTION_KEY: '', GAME_ENCRYPTION_KEYS: `k1:${hex()},k2:${hex()}`, GAME_ENCRYPTION_ACTIVE_KEY_ID: 'k2' },
  F11_duplicateKeysInRing: { ...PROD, GAME_ENCRYPTION_KEY: '', GAME_ENCRYPTION_KEYS: `k1:${k},k2:${k}`, GAME_ENCRYPTION_ACTIVE_KEY_ID: 'k2' },
  // CR-040 (SOL-047)
  CR040_bankroll_2147483648: { DEFAULT_STARTING_BANKROLL: '2147483648' },
  CR040_turnTimeBank_2147483648: { TURN_TIME_BANK_MS: '2147483648' },
  CR040_timeBankInitial_2147483648: { TIME_BANK_INITIAL_MS: '2147483648' },
  CR040_accessTtl_notADuration: { JWT_ACCESS_TTL: 'not-a-duration' },
  CR040_accessTtl_bare900: { JWT_ACCESS_TTL: '900' },
  CR040_accessTtl_5m_belowClientRefreshInterval: { JWT_ACCESS_TTL: '5m' },
  CR040_accessTtl_2m: { JWT_ACCESS_TTL: '2m' },
  CR040_refreshTtl_400d: { JWT_REFRESH_TTL: '400d' },
  CR040_trustProxyHops_huge: { TRUST_PROXY_HOPS: '999999999' },
  // CR-012 (production cookie-site check)
  CR012_prod_publicApiOriginUnset: { ...PROD },
  CR012_prod_apiOnOtherSite: { ...PROD, CLIENT_ORIGIN: 'https://poker.vercel.app', PUBLIC_API_ORIGIN: 'https://poker-api.onrender.com' },
  CR012_prod_siblingWithoutCookieSite: { ...PROD, CLIENT_ORIGIN: 'https://app.example.com', PUBLIC_API_ORIGIN: 'https://api.example.com' },
  CR012_prod_siblingWithCookieSite: { ...PROD, CLIENT_ORIGIN: 'https://app.example.com', PUBLIC_API_ORIGIN: 'https://api.example.com', COOKIE_SITE: 'example.com' },
  CR012_prod_sharedSuffixAsCookieSite: { ...PROD, CLIENT_ORIGIN: 'https://a.vercel.app', PUBLIC_API_ORIGIN: 'https://b.vercel.app', COOKIE_SITE: 'vercel.app' },
  CR012_prod_publicSuffixCoUkAsCookieSite: { ...PROD, CLIENT_ORIGIN: 'https://poker.alpha.co.uk', PUBLIC_API_ORIGIN: 'https://api.beta.co.uk', COOKIE_SITE: 'co.uk' },
};
const out = {};
for (const [name, overrides] of Object.entries(cases)) out[name] = load(overrides);
console.log(JSON.stringify(out, null, 2));
