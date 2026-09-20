import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptState, decryptState } from '../dist/game/encryption.js';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '../dist/auth/jwt.js';

test('AES-256-GCM round trips and uses a fresh nonce', () => {
  const secret = { deck: ['As', 'Kh'], seed: 'private value' };
  const a = encryptState(secret, 'table:one'); const b = encryptState(secret, 'table:one');
  assert.notEqual(a, b); assert.ok(!a.includes('private value')); assert.deepEqual(decryptState(a, 'table:one'), secret);
});
test('ciphertext tampering and substitution between tables fail closed', () => {
  const a = encryptState({ cards: ['As'] }, 'table:one');
  assert.throws(() => decryptState(a, 'table:two'));
  const parts = a.split('.'); parts[2] = '0'.repeat(32); assert.throws(() => decryptState(parts.join('.'), 'table:one'));
  assert.throws(() => decryptState('{}', 'table:one'));
});
test('tokens bind to a session and refresh tokens are unique even in the same second', () => {
  const a = signRefreshToken('user', 'session'); const b = signRefreshToken('user', 'session'); assert.notEqual(a, b);
  assert.equal(verifyRefreshToken(a).sid, 'session');
  const access = signAccessToken('user', 'Player', 'session'); assert.equal(verifyAccessToken(access).sid, 'session');
  assert.throws(() => verifyAccessToken(a)); assert.throws(() => verifyRefreshToken(access));
  assert.throws(() => verifyAccessToken(access.slice(0, -3) + 'bad'));
});

// Browser Origin headers never contain a trailing slash.
test("configured client origin is normalized", async () => {
  const { env } = await import("../dist/config.js");
  assert.equal(env.CLIENT_ORIGIN, new URL(env.CLIENT_ORIGIN).origin);
});
