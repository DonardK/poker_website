/**
 * Familiar-address lockout counters live in process memory and are capped.
 * Filling the cap must not reset the counter of an address that is already tracked:
 * Map insertion order does not move on update, so evicting the oldest key first
 * would drop the account being counted and restart its lockout at one failure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loginLockMs } from '../dist/auth/routes.js';
import { FAMILIAR_MAX_ENTRIES, clearFamiliarFailures, familiarLockedUntil, recordFamiliarFailure } from '../dist/auth/smart-lockout.js';

const IP = '203.0.113.10';

test('a full familiar-address map does not reset the oldest counter', () => {
  const oldest = 'cap-user-0';
  const ids = [oldest];
  try {
    for (let i = 0; i < 4; i++) recordFamiliarFailure(oldest, IP, Date.now(), loginLockMs);
    assert.equal(familiarLockedUntil(oldest, IP), 0, 'four failures do not lock yet');
    for (let i = 1; i < FAMILIAR_MAX_ENTRIES; i++) {
      const id = `cap-user-${i}`;
      ids.push(id);
      recordFamiliarFailure(id, IP, Date.now(), () => 0);
    }
    recordFamiliarFailure(oldest, IP, Date.now(), loginLockMs);
    assert.ok(familiarLockedUntil(oldest, IP) > Date.now(), 'the fifth failure still locks this address');
  } finally {
    for (const id of ids) clearFamiliarFailures(id, IP);
  }
});
