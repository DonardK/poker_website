/**
 * Startup configuration checks (config.ts), each run in a fresh Node process
 * that imports ONLY dist/config.js, the first module index.ts loads, before
 * any database or Redis connection. Every connection variable points at a
 * dead loopback port and every secret is a throwaway.
 *
 * config.ts loads the repository .env for variables that are NOT set, so
 * every variable a case depends on is set explicitly here (a blank value
 * counts as set and means "unset" to config.ts).
 *
 * What it proves: out-of-range PORT, DEFAULT_STARTING_BANKROLL,
 * TURN_TIME_BANK_MS and JWT TTLs are refused; TTLs are normalised to seconds;
 * production refuses weak or reused encryption keys and JWT secrets, proxy
 * mode without TRUSTED_PROXY_CIDRS, and API/web host combinations on which
 * the SameSite=Strict refresh cookie could never be sent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configUrl = pathToFileURL(join(serverDir, 'dist', 'config.js')).href;
const hex = () => randomBytes(32).toString('hex');
const secret = () => randomBytes(48).toString('base64url');

function baseEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'DIRECT_URL']) delete env[key];
  return {
    ...env,
    NODE_ENV: 'development',
    PORT: '4000',
    HOST: '',
    CLIENT_ORIGIN: 'http://localhost:3000',
    PUBLIC_API_ORIGIN: '',
    COOKIE_SITE: '',
    DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none?sslmode=require&sslaccept=strict',
    REDIS_URL: '',
    GAME_ENCRYPTION_KEY: hex(),
    GAME_ENCRYPTION_KEYS: '',
    GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
    TRUST_PROXY_HOPS: '0',
    TRUSTED_PROXY_CIDRS: '',
    JWT_ACCESS_SECRET: secret(),
    JWT_REFRESH_SECRET: secret(),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '7d',
    DEFAULT_STARTING_BANKROLL: '10000',
    TURN_TIME_BANK_MS: '20000',
    TLS_CERT_FILE: '',
    TLS_KEY_FILE: '',
    SESSION_IDLE_TTL: '',
    SESSION_ABSOLUTE_TTL: '',
    ...overrides,
  };
}

const PROD = {
  NODE_ENV: 'production', CLIENT_ORIGIN: 'https://poker.example', TRUST_PROXY_HOPS: '1', TRUSTED_PROXY_CIDRS: 'private',
};

/** Imports config.js in a child; returns { ok, error } or { ok, env } (selected, non-secret fields). */
function loadConfig(overrides) {
  const source = `
    try {
      const { env, proxyTrust, encryptionKeyRing } = await import(${JSON.stringify(configUrl)});
      console.log('RESULT ' + JSON.stringify({ ok: true, env: {
        PORT: env.PORT, HOST: env.HOST, DEFAULT_STARTING_BANKROLL: env.DEFAULT_STARTING_BANKROLL, TURN_TIME_BANK_MS: env.TURN_TIME_BANK_MS,
        JWT_ACCESS_TTL: env.JWT_ACCESS_TTL, JWT_REFRESH_TTL: env.JWT_REFRESH_TTL, jwtAccessTtlMs: env.jwtAccessTtlMs, jwtRefreshTtlMs: env.jwtRefreshTtlMs,
        hops: proxyTrust.hops, peerCheck: typeof proxyTrust.trustedPeers === 'function', activeKeyId: encryptionKeyRing.activeKeyId,
        keyIds: [...encryptionKeyRing.keys.keys()], keyInEnv: 'GAME_ENCRYPTION_KEY' in env || 'GAME_ENCRYPTION_KEYS' in env,
      } }));
    } catch (err) { console.log('RESULT ' + JSON.stringify({ ok: false, error: String(err && err.message) })); }`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: serverDir, env: baseEnv(overrides), encoding: 'utf8', timeout: 30_000 });
  const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no result (exit ${run.status}): ${run.stderr}`);
  return JSON.parse(line.slice(7));
}

const refused = (overrides, pattern, label) => {
  const result = loadConfig(overrides);
  assert.equal(result.ok, false, `${label ?? JSON.stringify(overrides)} must be refused`);
  if (pattern) assert.match(result.error, pattern, label);
  return result.error;
};
const accepted = (overrides, label) => {
  const result = loadConfig(overrides);
  assert.equal(result.ok, true, `${label ?? JSON.stringify(overrides)}: ${result.error}`);
  return result.env;
};

test('baseline development config loads; HOST defaults to 0.0.0.0; key material is not exported in env', () => {
  const env = accepted({});
  assert.equal(env.HOST, '0.0.0.0'); assert.equal(env.PORT, 4000); assert.equal(env.activeKeyId, 'k0');
  assert.equal(env.keyInEnv, false);
  assert.equal(accepted({ HOST: '127.0.0.1' }).HOST, '127.0.0.1');
  refused({ HOST: 'bad host!' }, /HOST/);
});

test('PORT, DEFAULT_STARTING_BANKROLL and TURN_TIME_BANK_MS bounds', () => {
  for (const PORT of ['0', '65536', '-1', 'abc', '80.5']) refused({ PORT }, /PORT/, `PORT=${PORT}`);
  assert.equal(accepted({ PORT: '1' }).PORT, 1); assert.equal(accepted({ PORT: '65535' }).PORT, 65535);
  for (const DEFAULT_STARTING_BANKROLL of ['-1', '1000000001', '10.5', 'lots']) refused({ DEFAULT_STARTING_BANKROLL }, /DEFAULT_STARTING_BANKROLL/, DEFAULT_STARTING_BANKROLL);
  assert.equal(accepted({ DEFAULT_STARTING_BANKROLL: '0' }).DEFAULT_STARTING_BANKROLL, 0, '0 is allowed');
  assert.equal(accepted({ DEFAULT_STARTING_BANKROLL: '1000000000' }).DEFAULT_STARTING_BANKROLL, 1_000_000_000);
  for (const TURN_TIME_BANK_MS of ['4999', '120001', '0', '']) refused({ TURN_TIME_BANK_MS }, /TURN_TIME_BANK_MS/, `TURN_TIME_BANK_MS=${TURN_TIME_BANK_MS}`);
  assert.equal(accepted({ TURN_TIME_BANK_MS: '5000' }).TURN_TIME_BANK_MS, 5000);
  assert.equal(accepted({ TURN_TIME_BANK_MS: '120000' }).TURN_TIME_BANK_MS, 120000);
});

test('JWT TTLs: parsed at startup, bounded, normalised to seconds', () => {
  const env = accepted({ JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d' });
  assert.equal(env.JWT_ACCESS_TTL, '900s'); assert.equal(env.jwtAccessTtlMs, 900_000);
  assert.equal(env.JWT_REFRESH_TTL, '604800s'); assert.equal(env.jwtRefreshTtlMs, 604_800_000);
  // A bare number is SECONDS (jsonwebtoken would read the string "900" as 900 ms).
  assert.equal(accepted({ JWT_ACCESS_TTL: '900' }).jwtAccessTtlMs, 900_000);
  assert.equal(accepted({ JWT_REFRESH_TTL: '12h' }).jwtRefreshTtlMs, 43_200_000);
  assert.equal(accepted({ JWT_ACCESS_TTL: '1m', JWT_REFRESH_TTL: '1h' }).jwtAccessTtlMs, 60_000);
  assert.equal(accepted({ JWT_ACCESS_TTL: '60m', JWT_REFRESH_TTL: '30d' }).jwtRefreshTtlMs, 2_592_000_000);
  for (const JWT_ACCESS_TTL of ['59s', '61m', '2h', '0', 'abc', '1.5h', '15 minutes', '-15m']) refused({ JWT_ACCESS_TTL }, /JWT_ACCESS_TTL/, JWT_ACCESS_TTL);
  for (const JWT_REFRESH_TTL of ['59m', '3599', '31d', '1y', '']) refused({ JWT_REFRESH_TTL }, /JWT_REFRESH_TTL/, JWT_REFRESH_TTL);
});

test('key ring configuration: GAME_ENCRYPTION_KEYS with an active id, legacy key as k0', () => {
  const ring = accepted({ GAME_ENCRYPTION_KEYS: `k1:${hex()},k2:${hex()}`, GAME_ENCRYPTION_ACTIVE_KEY_ID: 'k2' });
  assert.deepEqual(ring.keyIds, ['k0', 'k1', 'k2']); assert.equal(ring.activeKeyId, 'k2');
  assert.deepEqual(accepted({ GAME_ENCRYPTION_KEY: '', GAME_ENCRYPTION_KEYS: `only:${hex()}` }).keyIds, ['only']);
  refused({ GAME_ENCRYPTION_KEY: '', GAME_ENCRYPTION_KEYS: '' }, /Set GAME_ENCRYPTION_KEYS/);
  refused({ GAME_ENCRYPTION_KEYS: `k1:${hex()}` }, /ACTIVE_KEY_ID is required/);
  refused({ GAME_ENCRYPTION_ACTIVE_KEY_ID: 'nope' }, /not in the key ring/);
});

test('production refuses weak, placeholder, duplicated or reused secrets', () => {
  accepted(PROD, 'a sound production configuration');
  const key = hex();
  refused({ ...PROD, GAME_ENCRYPTION_KEY: '0'.repeat(64) }, /repeats a single byte/, 'all-zero key');
  refused({ ...PROD, GAME_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4) }, /placeholder/, 'placeholder key');
  refused({ ...PROD, GAME_ENCRYPTION_KEY: '0102'.repeat(16) }, /fewer than 16 distinct/, 'low-entropy key');
  refused({ ...PROD, GAME_ENCRYPTION_KEY: '', GAME_ENCRYPTION_KEYS: `a:${key},b:${key}`, GAME_ENCRYPTION_ACTIVE_KEY_ID: 'a' }, /identical/, 'duplicate keys');
  refused({ ...PROD, GAME_ENCRYPTION_KEY: key, JWT_ACCESS_SECRET: key }, /JWT_ACCESS_SECRET reuses encryption key/, 'key reused as access secret');
  refused({ ...PROD, GAME_ENCRYPTION_KEY: key, JWT_REFRESH_SECRET: key }, /JWT_REFRESH_SECRET reuses encryption key/, 'key reused as refresh secret');
  refused({ ...PROD, JWT_ACCESS_SECRET: 'Zx9!'.repeat(10) }, /16 distinct characters/, 'low-variety JWT secret');
  const shared = secret();
  refused({ ...PROD, JWT_ACCESS_SECRET: shared, JWT_REFRESH_SECRET: shared }, /independent|must differ/, 'identical JWT secrets');
  // The same values are tolerated outside production (local development keys).
  accepted({ GAME_ENCRYPTION_KEY: '0'.repeat(64) }, 'development');
});

test('production proxy mode requires TRUSTED_PROXY_CIDRS; malformed CIDRs are refused everywhere', () => {
  refused({ ...PROD, TRUSTED_PROXY_CIDRS: '' }, /requires TRUSTED_PROXY_CIDRS/);
  const env = accepted({ ...PROD, TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::/32,192.0.2.10' });
  assert.equal(env.hops, 1); assert.equal(env.peerCheck, true);
  for (const TRUSTED_PROXY_CIDRS of ['10.0.0.0/33', 'not-an-ip', '10.0.0.0/8/1', '::/129', '10.0.0.0/x']) refused({ TRUSTED_PROXY_CIDRS }, /TRUSTED_PROXY_CIDRS/, TRUSTED_PROXY_CIDRS);
  assert.equal(accepted({ TRUST_PROXY_HOPS: '1' }).peerCheck, false, 'development keeps the legacy any-peer proxy mode');
  // Direct TLS without proxy hops needs no CIDRs.
  accepted({ ...PROD, TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '', TLS_CERT_FILE: 'c.pem', TLS_KEY_FILE: 'k.pem' });
});

test('production cookie-site check for a separate API host', () => {
  const api = { ...PROD, PUBLIC_API_ORIGIN: 'https://api.poker.example' };
  const missing = refused(api, /COOKIE_SITE/);
  assert.match(missing, /SameSite=Strict/, 'the message explains the refresh cookie');
  accepted({ ...api, COOKIE_SITE: 'poker.example' });
  accepted({ ...PROD, CLIENT_ORIGIN: 'https://www.poker.example', PUBLIC_API_ORIGIN: 'https://api.poker.example', COOKIE_SITE: '.poker.example' });
  accepted({ ...PROD, PUBLIC_API_ORIGIN: 'https://poker.example:8443' }, 'same host, other port: same site, no COOKIE_SITE needed');
  refused({ ...api, COOKIE_SITE: 'example' }, /at least two labels/);
  refused({ ...api, COOKIE_SITE: 'other.example' }, /must both be other.example or a subdomain/);
  refused({ ...api, COOKIE_SITE: 'ker.example' }, /subdomain/, 'suffix match must be on a label boundary');
  for (const suffix of ['vercel.app', 'onrender.com', 'github.io', 'pages.dev', 'azurewebsites.net']) {
    refused({ ...PROD, CLIENT_ORIGIN: `https://poker.${suffix}`, PUBLIC_API_ORIGIN: `https://poker-api.${suffix}`, COOKIE_SITE: suffix }, /shared-hosting suffix/, suffix);
  }
  refused({ ...PROD, PUBLIC_API_ORIGIN: 'http://api.poker.example', COOKIE_SITE: 'poker.example' }, /https/);
  refused({ ...PROD, PUBLIC_API_ORIGIN: 'not a url' }, /PUBLIC_API_ORIGIN/);
  accepted({ PUBLIC_API_ORIGIN: 'http://127.0.0.1:4000' }, 'development does not apply the check');
});
