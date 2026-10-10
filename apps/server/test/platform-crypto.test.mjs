/**
 * Game-state encryption key ring (security/key-ring.ts) and the rotation
 * script (scripts/rotate-game-key.mjs). No database: the script is driven
 * with an in-memory fake, and its CLI is only run in ways that stop before
 * any connection.
 *
 * What it proves:
 * - "v1." ciphertexts written by the old single-key code decrypt through the
 *   ring as key id "k0"; new ciphertexts are "v2.<kid>..." and round trip.
 * - Relabelling a ciphertext with another key id, moving it to another
 *   context, an unknown key id or tampering all fail closed.
 * - After rotation (new active key, old key kept) old data still decrypts,
 *   and a ring without the new key cannot read new data.
 * - Production refuses weak, placeholder, duplicated or reused secrets.
 * - The rotation script is a dry run by default, uses compare-and-set, leaves
 *   undecryptable rows alone, and never falls back to .env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertProductionSecrets, ciphertextKeyId, decryptWithRing, encryptWithRing, parseKeyRing } from '../dist/security/key-ring.js';
import { decryptState, encryptState } from '../dist/game/encryption.js';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(serverDir, 'scripts', 'rotate-game-key.mjs');
const key = () => randomBytes(32).toString('hex');

/** Exactly what the pre-key-ring encryptState wrote: AES-256-GCM, AAD = context, "v1.<iv>.<tag>.<b64>". */
function legacyEncrypt(hexKey, value, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('base64')].join('.');
}

test('legacy v1 ciphertext decrypts through the ring as key "k0"', () => {
  const legacyKey = key();
  const state = { deck: ['As', 'Kd'], seed: 'secret seed' };
  const v1 = legacyEncrypt(legacyKey, state, 'table:t1');
  const ring = parseKeyRing({ legacyKey });
  assert.equal(ring.activeKeyId, 'k0');
  assert.equal(ciphertextKeyId(v1), 'k0');
  assert.deepEqual(decryptWithRing(ring, v1, 'table:t1'), state);
  assert.throws(() => decryptWithRing(ring, v1, 'table:t2'), 'context still bound');
  // A ring that does not hold k0 cannot read v1 data (fail closed, no fallback key).
  assert.throws(() => decryptWithRing(parseKeyRing({ keys: `k1:${key()}` }), v1, 'table:t1'), /unknown key id "k0"/);
});

test('v2 round trip: format, fresh nonce, active key id', () => {
  const ring = parseKeyRing({ keys: `a1:${key()},b2:${key()}`, activeKeyId: 'b2' });
  const value = { cards: ['Qs'], n: 7 };
  const a = encryptWithRing(ring, value, 'table:x'); const b = encryptWithRing(ring, value, 'table:x');
  assert.notEqual(a, b);
  assert.match(a, /^v2\.b2\.[a-f0-9]{24}\.[a-f0-9]{32}\.[A-Za-z0-9+/=]+$/);
  assert.equal(ciphertextKeyId(a), 'b2');
  assert.deepEqual(decryptWithRing(ring, a, 'table:x'), value);
});

test('swapped key id, swapped context, unknown key id and tampering fail closed', () => {
  const shared = key();
  // Even when two ids name the SAME key bytes, relabelling fails: the key id is in the AAD.
  const ring = parseKeyRing({ keys: `a:${shared},b:${key()},c:${shared}`, activeKeyId: 'a' });
  const ct = encryptWithRing(ring, { v: 1 }, 'table:one');
  const parts = ct.split('.');
  assert.throws(() => decryptWithRing(ring, ['v2', 'c', ...parts.slice(2)].join('.'), 'table:one'), 'relabelled to an id with the same key bytes');
  assert.throws(() => decryptWithRing(ring, ['v2', 'b', ...parts.slice(2)].join('.'), 'table:one'), 'relabelled to another key');
  assert.throws(() => decryptWithRing(ring, ['v2', 'zz', ...parts.slice(2)].join('.'), 'table:one'), /unknown key id/);
  assert.throws(() => decryptWithRing(ring, ct, 'table:two'), 'moved to another row');
  const tampered = [...parts]; tampered[4] = Buffer.from('{"v":2}').toString('base64');
  assert.throws(() => decryptWithRing(ring, tampered.join('.'), 'table:one'));
  assert.throws(() => decryptWithRing(ring, ['v1', ...parts.slice(2)].join('.'), 'table:one'), 'v2 data presented as v1');
  for (const bad of ['', '{}', 'v2.a', 'v3.a.b.c.d', `${ct}.extra`, 'v2.a:b.' + parts.slice(2).join('.')]) assert.throws(() => decryptWithRing(ring, bad, 'table:one'), bad);
});

test('rotation: the new ring reads old data, writes under the new key; the old ring cannot read new data', () => {
  const k0 = key(); const k1 = key();
  const before = parseKeyRing({ legacyKey: k0 });
  const oldV1 = legacyEncrypt(k0, { hand: 1 }, 'table:r');
  const oldV2 = encryptWithRing(before, { hand: 2 }, 'table:r');
  const after = parseKeyRing({ legacyKey: k0, keys: `k1:${k1}`, activeKeyId: 'k1' });
  assert.deepEqual(decryptWithRing(after, oldV1, 'table:r'), { hand: 1 });
  assert.deepEqual(decryptWithRing(after, oldV2, 'table:r'), { hand: 2 });
  const fresh = encryptWithRing(after, { hand: 3 }, 'table:r');
  assert.equal(ciphertextKeyId(fresh), 'k1');
  assert.throws(() => decryptWithRing(before, fresh, 'table:r'), /unknown key id "k1"/);
});

test('key ring parsing rejects malformed configuration without echoing key material', () => {
  const k = key();
  const cases = [
    [{}, /Set GAME_ENCRYPTION_KEYS/],
    [{ legacyKey: 'replace-with-64-hex-characters' }, /GAME_ENCRYPTION_KEY must be 64 hex/],
    [{ keys: `a:${k.slice(2)}` }, /key "a" must be 64 hex/],
    [{ keys: k }, /each entry must be <kid>:<64 hex>/],
    [{ keys: `bad.id:${k}` }, /each entry must be/],
    [{ keys: `a:${k},a:${key()}`, activeKeyId: 'a' }, /appears twice/],
    [{ legacyKey: k, keys: `k0:${key()}`, activeKeyId: 'k0' }, /reserved for GAME_ENCRYPTION_KEY/],
    [{ keys: `a:${k},b:${key()}` }, /ACTIVE_KEY_ID is required/],
    [{ keys: `a:${k}`, activeKeyId: 'b' }, /not in the key ring/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => parseKeyRing(input), (err) => { assert.match(err.message, pattern); assert.ok(!err.message.includes(k)); return true; });
  }
});

test('production secret checks: all-zero key, low-entropy key, placeholder, duplicate, key reused as JWT secret, weak JWT secrets', () => {
  const access = randomBytes(48).toString('base64url'); const refresh = randomBytes(48).toString('base64url');
  const good = key();
  assert.doesNotThrow(() => assertProductionSecrets(parseKeyRing({ legacyKey: good, keys: `k1:${key()}`, activeKeyId: 'k1' }), access, refresh));
  const reject = (ring, a, r, pattern) => assert.throws(() => assertProductionSecrets(ring, a, r), pattern);
  reject(parseKeyRing({ legacyKey: '0'.repeat(64) }), access, refresh, /repeats a single byte/);
  reject(parseKeyRing({ keys: `k1:${'ab'.repeat(16)}${'cd'.repeat(16)}` }), access, refresh, /fewer than 16 distinct byte values/);
  reject(parseKeyRing({ legacyKey: '0123456789abcdef'.repeat(4) }), access, refresh, /published placeholder/);
  reject(parseKeyRing({ keys: `a:${good},b:${good.toUpperCase()}`, activeKeyId: 'a' }), access, refresh, /are identical/);
  reject(parseKeyRing({ legacyKey: good }), good, refresh, /JWT_ACCESS_SECRET reuses encryption key "k0"/);
  reject(parseKeyRing({ legacyKey: good }), access, good.toUpperCase(), /JWT_REFRESH_SECRET reuses encryption key "k0"/);
  reject(parseKeyRing({ legacyKey: good }), 'abcdefgh'.repeat(5), refresh, /16 distinct characters/);
  reject(parseKeyRing({ legacyKey: good }), access.slice(0, 31), refresh, /at least 32 characters/);
  reject(parseKeyRing({ legacyKey: good }), access, access, /must differ/);
});

test('env-backed encryptState writes v2 under the active key and decryptState reads it', () => {
  const ct = encryptState({ ok: true }, 'table:env');
  assert.match(ct, /^v2\.[A-Za-z0-9_-]+\./);
  assert.deepEqual(decryptState(ct, 'table:env'), { ok: true });
});

// ---------------------------------------------------------------------------
// Rotation script
// ---------------------------------------------------------------------------

/** In-memory stand-in for prisma.table with findMany/updateMany semantics the script uses. */
function fakeDb(rows) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const writes = [];
  return {
    rows: table, writes,
    table: {
      findMany: async ({ where, take }) => [...table.values()]
        .filter((r) => r.stateCiphertext !== null && (where.id?.gt === undefined || r.id > where.id.gt))
        .sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, take).map((r) => ({ id: r.id, stateCiphertext: r.stateCiphertext })),
      updateMany: async ({ where, data }) => {
        writes.push(where.id);
        const row = table.get(where.id);
        if (!row || row.stateCiphertext !== where.stateCiphertext) return { count: 0 };
        row.stateCiphertext = data.stateCiphertext; return { count: 1 };
      },
    },
  };
}

test('rotate-game-key: dry run by default, compare-and-set on apply, bad rows untouched, old data readable', async () => {
  const { rotateTableStates, parseArgs } = await import(pathToFileURL(script).href);
  const k0 = key(); const k1 = key();
  const oldRing = parseKeyRing({ legacyKey: k0 });
  const ring = parseKeyRing({ legacyKey: k0, keys: `k1:${k1}`, activeKeyId: 'k1' });
  const rows = [
    { id: 'a', stateCiphertext: legacyEncrypt(k0, { t: 'a' }, 'table:a') },
    { id: 'b', stateCiphertext: encryptWithRing(oldRing, { t: 'b' }, 'table:b') },
    { id: 'c', stateCiphertext: encryptWithRing(ring, { t: 'c' }, 'table:c') },          // already current
    { id: 'd', stateCiphertext: encryptWithRing(oldRing, { t: 'd' }, 'table:other') },   // wrong context: undecryptable
    { id: 'e', stateCiphertext: null },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, stateCiphertext: encryptWithRing(oldRing, { t: `f${i}` }, `table:f${i}`) })),
  ];
  const original = new Map(rows.map((r) => [r.id, r.stateCiphertext]));

  const dry = fakeDb(rows);
  const dryCounts = await rotateTableStates({ db: dry, ring, apply: false, batchSize: 3 });
  assert.deepEqual(dryCounts, { scanned: 9, current: 1, rotated: 0, wouldRotate: 7, changedConcurrently: 0, failed: 1 });
  assert.equal(dry.writes.length, 0, 'a dry run never writes');

  const db = fakeDb(rows);
  // A running server saves table f2 between the script's read and its write.
  const update = db.table.updateMany;
  db.table.updateMany = async (args) => {
    if (args.where.id === 'f2') db.rows.get('f2').stateCiphertext = encryptWithRing(ring, { t: 'f2', newer: true }, 'table:f2');
    return update(args);
  };
  const counts = await rotateTableStates({ db, ring, apply: true, batchSize: 3 });
  assert.deepEqual(counts, { scanned: 9, current: 1, rotated: 6, wouldRotate: 0, changedConcurrently: 1, failed: 1 });
  for (const [id, row] of db.rows) {
    if (row.stateCiphertext === null) continue;
    if (id === 'd') { assert.equal(row.stateCiphertext, original.get('d'), 'an undecryptable row is left unchanged'); continue; }
    if (id === 'c') { assert.equal(row.stateCiphertext, original.get('c')); continue; }
    assert.equal(ciphertextKeyId(row.stateCiphertext), 'k1', id);
    const expected = id === 'f2' ? { t: 'f2', newer: true } : { t: id };
    assert.deepEqual(decryptWithRing(ring, row.stateCiphertext, `table:${id}`), expected, `${id}: the newer live save is never overwritten`);
  }

  assert.throws(() => parseArgs([]), /--database-url .* is required/);
  assert.throws(() => parseArgs(['--database-url', 'mysql://x']), /postgresql/);
  assert.throws(() => parseArgs(['--database-url', 'postgresql://h/db', '--force']), /Unknown argument/);
  assert.deepEqual(parseArgs(['--database-url=postgresql://h/db']), { databaseUrl: 'postgresql://h/db', apply: false, batchSize: 100 });
  assert.equal(parseArgs(['--database-url', 'postgresql://h/db', '--apply']).apply, true);
});

test('rotate-game-key CLI: refuses without --database-url and never takes keys from .env', () => {
  const env = { ...process.env };
  // The repository .env defines GAME_ENCRYPTION_KEY; config.ts (loaded by this
  // test process) copied it into process.env, so remove it for the child.
  for (const name of ['GAME_ENCRYPTION_KEY', 'GAME_ENCRYPTION_KEYS', 'GAME_ENCRYPTION_ACTIVE_KEY_ID', 'DATABASE_URL', 'DIRECT_URL', 'NODE_TEST_CONTEXT']) delete env[name];
  const noUrl = spawnSync(process.execPath, [script], { cwd: serverDir, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(noUrl.status, 2); assert.match(noUrl.stderr, /--database-url/);
  // A URL but no keys in the environment: refused before any connection, proving .env was not read.
  const noKeys = spawnSync(process.execPath, [script, '--database-url', 'postgresql://nobody:nothing@127.0.0.1:1/none'], { cwd: join(serverDir, '..', '..'), env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(noKeys.status, 2, noKeys.stderr + noKeys.stdout); assert.match(noKeys.stderr, /Key ring: Set GAME_ENCRYPTION_KEYS/);
});
