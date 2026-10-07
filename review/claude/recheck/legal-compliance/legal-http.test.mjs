/**
 * Recheck (legal-compliance group): HTTP behaviour of sign-up terms/age
 * acceptance (CR-001, F01, F04) and table-name moderation (CR-018).
 *
 * SAFETY: run ONLY through the server's safe runner, which forces
 * DATABASE_URL/DIRECT_URL to a dead loopback port before config.ts loads:
 *   cd apps/server && node test/support/run-tests.mjs ../../review/claude/recheck/legal-compliance/legal-http.test.mjs
 * As a second guard this file refuses to run unless DATABASE_URL points at
 * 127.0.0.1. Every Prisma delegate used is replaced in memory
 * (test/support/auth-fake-db.mjs plus local stubs). HTTP listens on port 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const dbUrl = process.env.DATABASE_URL ?? '';
if (!/^postgres(ql)?:\/\/[^@]*@127\.0\.0\.1:1\//.test(dbUrl) || process.env.POKER_TEST_ISOLATED !== '1') {
  console.error('refusing to run: not started through apps/server/test/support/run-tests.mjs');
  process.exit(2);
}

const { createApp } = await import('../../../../apps/server/dist/app.js');
const { authConfig } = await import('../../../../apps/server/dist/config.js');
const { prisma } = await import('../../../../apps/server/dist/db/prisma.js');
const { tableManager } = await import('../../../../apps/server/dist/game/manager.js');
const { fakeAuthDb } = await import('../../../../apps/server/test/support/auth-fake-db.mjs');

const TERMS = { acceptTerms: true, confirmAge: true, termsVersion: authConfig.termsVersion };
const PASSWORD = 'correct horse battery staple';

async function api(t) {
  const server = createServer(createApp());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return async (path, { method = 'POST', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

test('F01/CR-001: guest sign-up needs terms+18+, then still mints DEFAULT_STARTING_BANKROLL into User.bankroll', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  const refused = await request('/auth/guest', { body: {} });
  console.log('[F01] guest without acceptance ->', refused.status, refused.body?.code);
  const ok = await request('/auth/guest', { body: TERMS });
  const row = [...db.users.values()][0];
  console.log('[F01] guest with acceptance ->', ok.status, 'bankroll', ok.body?.user?.bankroll, 'isGuest', ok.body?.user?.isGuest,
    'stored termsVersion', row?.termsVersion, 'ageConfirmedAt set', row?.ageConfirmedAt instanceof Date);
  assert.equal(refused.status, 400);
  assert.equal(ok.status, 201);
});

test('CR-001 gap: an account with NO recorded acceptance (pre-2026-10-01 row) still signs in and is served', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  const legacy = db.addUser({ username: 'Legacy_Player', password: PASSWORD }); // termsVersion/ageConfirmedAt null
  const login = await request('/auth/login', { body: { username: 'Legacy_Player', password: PASSWORD } });
  console.log('[CR-001] login of account with termsVersion=null ->', login.status, 'termsVersion still', db.user(legacy.id).termsVersion);
  const guest = db.addUser({ username: 'Guest_0123456789', isGuest: true });
  const session = db.addSession(guest.id);
  const me = await request('/auth/me', { method: 'GET', token: session.accessToken });
  console.log('[CR-001] /auth/me for legacy guest with termsVersion=null ->', me.status, 'keys:', me.body?.user ? Object.keys(me.body.user).join(',') : null);
});

test('CR-018: a table name with U+202E, zero-width and staff-like text is stored unchanged', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  const host = db.addUser({ username: 'Host_Player', password: PASSWORD, bankroll: 10_000 });
  const { accessToken } = db.addSession(host.id);
  let captured = null;
  const tx = {
    tableSeat: { findFirst: async () => null },
    user: { updateMany: async () => ({ count: 1 }) },
    table: { create: async ({ data }) => { captured = data; return { id: 'recheck-table' }; } },
  };
  const originalTx = prisma.$transaction;
  prisma.$transaction = async (run) => run(tx);
  const originalTrack = tableManager.track;
  tableManager.track = async () => {};
  t.after(() => { prisma.$transaction = originalTx; tableManager.track = originalTrack; });

  const name = '‮OFFICIAL SUPPORT​ confirm password';
  const r = await request('/tables', { body: { name, smallBlind: 5, bigBlind: 10, buyIn: 1000 }, token: accessToken });
  const codepoints = captured ? [...captured.name].filter((c) => /[​-‏‪-‮⁦-⁩]/.test(c)).map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')) : null;
  console.log('[CR-018] POST /tables ->', r.status, 'stored name has invisible/bidi code points:', codepoints, 'unchanged:', captured?.name === name);
});
