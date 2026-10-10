/**
 * HTTP auth hardening: infrastructure failures are 503 (never a sign-out),
 * bounded session lifetime with one expiry for cookie/row/JWT, refresh
 * rotation with a grace window and reuse detection, revocation endpoints,
 * login hardening, username policy, P2002 races and terms/age acceptance.
 * Runs over an in-memory database (support/auth-fake-db.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { REFRESH_COOKIE_NAME } from '@poker/shared';
import { createApp } from '../dist/app.js';
import { authConfig } from '../dist/config.js';
import { authenticate } from '../dist/auth/middleware.js';
import { isAuthError } from '../dist/auth/errors.js';
import { REFRESH_GRACE_MS } from '../dist/auth/sessions.js';
import { fakeAuthDb, sha256, uniqueViolation } from './support/auth-fake-db.mjs';

const DAY = 86_400_000;
const TERMS = { acceptTerms: true, confirmAge: true, termsVersion: authConfig.termsVersion };
const PASSWORD = 'correct horse battery staple';

/** A fresh app per test: the /api/auth IP limiter (15/min) is per app instance. */
async function api(t) {
  const server = createServer(createApp());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return async (path, { method = 'POST', body, cookie, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`)) ?? null;
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, setCookie, cookie: setCookie ? setCookie.split(';')[0] : null };
  };
}
const cookieOf = (refreshToken) => `${REFRESH_COOKIE_NAME}=${refreshToken}`;
const cleared = (r) => r.setCookie !== null && /Expires=Thu, 01 Jan 1970/.test(r.setCookie);

// ---------------------------------------------------------------------------
// Item 1: infrastructure errors are retryable, never a sign-out
// ---------------------------------------------------------------------------

test('refresh: a database failure answers 503 retryable with Retry-After and leaves the cookie alone; the same cookie works once the database is back', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Guest_00aa11bb22', isGuest: true });
  const session = db.addSession(user.id);
  const request = await api(t);
  for (const failing of ['session.findUnique', 'session.updateMany']) {
    db.fail(failing);
    const r = await request('/auth/refresh', { cookie: cookieOf(session.refreshToken) });
    assert.equal(r.status, 503, failing);
    assert.deepEqual(r.body.retryable, true);
    assert.equal(r.headers.get('retry-after'), '2');
    assert.equal(r.setCookie, null, `${failing}: the refresh cookie is not cleared or replaced`);
    assert.equal(db.session(session.id).refreshToken, sha256(session.refreshToken), 'nothing rotated');
  }
  const ok = await request('/auth/refresh', { cookie: cookieOf(session.refreshToken) });
  assert.equal(ok.status, 200, 'the guest keeps the account');
  assert.equal(ok.body.user.id, user.id);
  assert.ok(ok.setCookie);
});

test('requireAuth and /me: a database failure is 503 retryable (not 401); a bad token is still 401', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Alice' });
  const session = db.addSession(user.id);
  const request = await api(t);
  db.fail('session.findUnique');
  const down = await request('/auth/me', { method: 'GET', token: session.accessToken });
  assert.equal(down.status, 503);
  assert.equal(down.body.retryable, true);
  assert.equal(down.headers.get('retry-after'), '2');
  assert.equal((await request('/auth/me', { method: 'GET', token: session.accessToken })).status, 200);
  assert.equal((await request('/auth/me', { method: 'GET', token: 'not-a-token' })).status, 401);
});

test('authenticate: credential problems are AuthError, a database error propagates unchanged, a revoked session fails closed even after a cached success', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Bob' });
  const session = db.addSession(user.id);
  db.fail('session.findUnique');
  await assert.rejects(authenticate(session.accessToken), (err) => !isAuthError(err) && err.name === 'PrismaClientInitializationError');
  const ok = await authenticate(session.accessToken);
  assert.equal(ok.user.id, user.id); assert.equal(ok.session.id, session.id);
  // Served from the cache: no database read even while the database is down.
  db.down = true;
  assert.equal((await authenticate(session.accessToken)).user.id, user.id);
  db.down = false;
  db.revokeRow(session.id, 'LOGOUT');
  await assert.rejects(authenticate(session.accessToken), (err) => isAuthError(err) && err.code === 'REVOKED' && err.reason === 'LOGOUT');
  await assert.rejects(authenticate('garbage'), (err) => isAuthError(err) && err.code === 'INVALID_TOKEN' && err.reason === undefined);
  await assert.rejects(authenticate(undefined), (err) => isAuthError(err) && err.code === 'NO_TOKEN');
  const expired = db.addSession(user.id, { expiresAt: new Date(Date.now() - 1) });
  await assert.rejects(authenticate(expired.accessToken), (err) => isAuthError(err) && err.code === 'EXPIRED' && err.reason === 'EXPIRED');
  const bot = db.addUser({ username: 'Bot_Zed', kind: 'BOT' });
  await assert.rejects(authenticate(db.addSession(bot.id).accessToken), (err) => isAuthError(err) && err.code === 'USER_BLOCKED');
});

// ---------------------------------------------------------------------------
// Item 2: lifetime, rotation, grace window and reuse detection
// ---------------------------------------------------------------------------

test('lifetime: cookie maxAge, Session.expiresAt and the refresh JWT exp all come from one value; refresh never extends past the absolute expiry', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  const before = Date.now();
  const guest = await request('/auth/guest', { body: TERMS });
  assert.equal(guest.status, 201);
  const [row] = db.sessionsOf(guest.body.user.id);
  const agree = (r, sessionRow) => {
    const token = decodeURIComponent(r.cookie.split('=')[1]);
    const exp = jwt.decode(token).exp;
    const maxAge = Number(/Max-Age=(\d+)/.exec(r.setCookie)[1]);
    const expires = Date.parse(/Expires=([^;]+)/.exec(r.setCookie)[1]);
    assert.equal(exp, Math.floor(sessionRow.expiresAt.getTime() / 1000), 'JWT exp = row expiry');
    assert.ok(Math.abs(expires - sessionRow.expiresAt.getTime()) < 2_000, 'cookie Expires = row expiry');
    assert.ok(Math.abs(maxAge * 1000 - (sessionRow.expiresAt.getTime() - Date.now())) < 2_000, 'cookie Max-Age = time to row expiry');
    return token;
  };
  agree(guest, row);
  assert.ok(Math.abs(row.expiresAt.getTime() - (before + authConfig.sessionIdleTtlMs)) < 2_000, 'idle TTL from sign-in');
  assert.ok(Math.abs(row.absoluteExpiresAt.getTime() - (before + authConfig.sessionAbsoluteTtlMs)) < 2_000, 'absolute TTL from sign-in');
  // An hour before the absolute end, a refresh is capped by it.
  row.absoluteExpiresAt = new Date(Date.now() + 3_600_000);
  const refreshed = await request('/auth/refresh', { cookie: guest.cookie });
  assert.equal(refreshed.status, 200);
  assert.equal(row.expiresAt.getTime(), row.absoluteExpiresAt.getTime(), 'capped at the absolute expiry');
  agree(refreshed, row);
  assert.ok(row.lastUsedAt.getTime() >= before);
});

test('lifetime: a session past its absolute expiry is refused (401, cookie cleared) even if its idle expiry was kept alive', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Oldtimer' });
  // Created 365 days ago and refreshed weekly under the old rules (expiry pushed forward forever).
  const old = db.addSession(user.id, { createdAt: new Date(Date.now() - 365 * DAY), absoluteExpiresAt: new Date(Date.now() - 335 * DAY), expiresAt: new Date(Date.now() + DAY) });
  const request = await api(t);
  const r = await request('/auth/refresh', { cookie: cookieOf(old.refreshToken) });
  assert.equal(r.status, 401);
  assert.ok(cleared(r), 'the cookie is cleared');
  assert.equal(db.session(old.id).refreshToken, sha256(old.refreshToken), 'not rotated');
  assert.equal((await request('/auth/me', { method: 'GET', token: old.accessToken })).status, 401, 'an access token dies at the absolute end too');
});

test('rotation: two concurrent refreshes with the same cookie both succeed; exactly one rotates and sets a cookie; both access tokens work', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'TwoTabs' });
  const session = db.addSession(user.id);
  const request = await api(t);
  // Both requests read the session before either rotates: the loser hits the conditional update's race path.
  db.hold('session.findUnique', 2);
  const both = await Promise.all([1, 2].map(() => request('/auth/refresh', { cookie: cookieOf(session.refreshToken) })));
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(both.filter((r) => r.setCookie).length, 1, 'only the rotation sets a cookie');
  const row = db.session(session.id);
  assert.equal(row.previousTokenHash, sha256(session.refreshToken));
  assert.equal(row.revokedAt, null);
  for (const r of both) assert.equal((await request('/auth/me', { method: 'GET', token: r.body.accessToken })).status, 200);
  // Within the window the previous token keeps working without rotating again.
  const again = await request('/auth/refresh', { cookie: cookieOf(session.refreshToken) });
  assert.equal(again.status, 200);
  assert.equal(again.setCookie, null);
  assert.equal(db.session(session.id).refreshToken, row.refreshToken, 'no second rotation');
});

test('reuse: the previous token after the grace window, or any older token, revokes the session (REFRESH_REUSE) and every token of it stops working', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Victim' });
  const session = db.addSession(user.id);
  const request = await api(t);
  const first = await request('/auth/refresh', { cookie: cookieOf(session.refreshToken) });
  assert.equal(first.status, 200);
  db.session(session.id).rotatedAt = new Date(Date.now() - REFRESH_GRACE_MS - 1_000);
  const replay = await request('/auth/refresh', { cookie: cookieOf(session.refreshToken) });
  assert.equal(replay.status, 401);
  assert.ok(cleared(replay));
  const row = db.session(session.id);
  assert.ok(row.revokedAt instanceof Date, 'revoked, row kept');
  assert.equal(row.revokeReason, 'REFRESH_REUSE');
  assert.equal((await request('/auth/refresh', { cookie: first.cookie })).status, 401, 'the current token is dead too');
  assert.equal((await request('/auth/me', { method: 'GET', token: first.body.accessToken })).status, 401, 'and its access tokens');

  // An older token (two rotations back) is reuse even inside the window.
  const other = db.addSession(user.id);
  const r1 = await request('/auth/refresh', { cookie: cookieOf(other.refreshToken) });
  const r2 = await request('/auth/refresh', { cookie: r1.cookie });
  assert.equal(r2.status, 200);
  assert.equal((await request('/auth/refresh', { cookie: cookieOf(other.refreshToken) })).status, 401);
  assert.equal(db.session(other.id).revokeReason, 'REFRESH_REUSE');
});

// ---------------------------------------------------------------------------
// Item 3: logout keeps the row; session list, revoke one, logout-all
// ---------------------------------------------------------------------------

test('sessions: list (coarse IP, current flag), revoke one of mine (not another user\'s), logout-all, logout keeps the row with revokedAt', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Multi', password: PASSWORD });
  const stranger = db.addUser({ username: 'Stranger' });
  const theirs = db.addSession(stranger.id);
  const request = await api(t);
  const a = await request('/auth/login', { body: { username: 'Multi', password: PASSWORD } });
  const b = await request('/auth/login', { body: { username: 'multi', password: PASSWORD } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const list = await request('/auth/sessions', { method: 'GET', token: a.body.accessToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 2);
  assert.deepEqual(list.body.sessions.map((s) => s.current).sort(), [false, true]);
  for (const s of list.body.sessions) {
    assert.match(s.ip, /^127\.0\.0\.0\/24$/);
    assert.deepEqual(Object.keys(s).sort(), ['createdAt', 'current', 'id', 'ip', 'lastUsedAt', 'userAgent']);
  }
  const bId = list.body.sessions.find((s) => !s.current).id;
  assert.equal((await request(`/auth/sessions/${theirs.id}`, { method: 'DELETE', token: a.body.accessToken })).status, 404, 'another user\'s session looks unknown');
  assert.equal(db.session(theirs.id).revokedAt, null);
  assert.equal((await request(`/auth/sessions/${bId}`, { method: 'DELETE', token: a.body.accessToken })).status, 204);
  assert.equal(db.session(bId).revokeReason, 'SESSION_REVOKED');
  assert.equal((await request('/auth/refresh', { cookie: b.cookie })).status, 401, 'the revoked device is signed out');

  const c = await request('/auth/login', { body: { username: 'MULTI', password: PASSWORD } });
  const all = await request('/auth/logout-all', { token: c.body.accessToken, body: {} });
  assert.equal(all.status, 200);
  assert.equal(all.body.revoked, 2);
  assert.ok(cleared(all));
  assert.ok(db.sessionsOf(user.id).every((s) => s.revokedAt), 'every session of the user revoked');
  assert.equal(db.session(theirs.id).revokedAt, null, 'nobody else\'s');

  const d = await request('/auth/login', { body: { username: 'Multi', password: PASSWORD } });
  const dId = jwt.decode(d.body.accessToken).sid;
  const out = await request('/auth/logout', { cookie: d.cookie });
  assert.equal(out.status, 204);
  assert.ok(cleared(out));
  assert.equal(db.session(dId).revokeReason, 'LOGOUT', 'the row is kept, revoked');
  assert.equal((await request('/auth/me', { method: 'GET', token: d.body.accessToken })).status, 401);
});

test('logout-all with exceptCurrent keeps the calling session', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'KeepMe' });
  const mine = db.addSession(user.id); const other = db.addSession(user.id);
  const request = await api(t);
  const r = await request('/auth/logout-all', { token: mine.accessToken, body: { exceptCurrent: true } });
  assert.equal(r.body.revoked, 1);
  assert.equal(r.setCookie, null);
  assert.equal(db.session(mine.id).revokedAt, null);
  assert.equal(db.session(other.id).revokeReason, 'LOGOUT_ALL');
});

// ---------------------------------------------------------------------------
// Item 6: login hardening
// ---------------------------------------------------------------------------

test('login: unknown users, guests and bots do the same bcrypt work and get the same 401 as a wrong password', async (t) => {
  const db = fakeAuthDb(t);
  db.addUser({ username: 'RealOne', password: PASSWORD });
  db.addUser({ username: 'Guest_0123456789', isGuest: true });
  db.addUser({ username: 'Bot_Alice', kind: 'BOT', password: PASSWORD });
  const compare = t.mock.method(bcrypt, 'compare');
  const request = await api(t);
  const answers = [];
  for (const username of ['nobody_here', 'Guest_0123456789', 'Bot_Alice', 'RealOne']) {
    const before = compare.mock.callCount();
    const r = await request('/auth/login', { body: { username, password: username === 'Bot_Alice' ? PASSWORD : 'wrong password!!' } });
    assert.equal(compare.mock.callCount() - before, 1, `${username}: exactly one bcrypt comparison`);
    answers.push([r.status, r.body]);
  }
  for (const answer of answers) assert.deepEqual(answer, [401, { error: 'Invalid credentials' }]);
});

test('login: 5 failures lock the account (per account, any IP); while locked even the right password gets the identical 401 and does not extend the lock; success resets', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Target', password: PASSWORD });
  const request = await api(t);
  for (let i = 1; i <= 5; i++) {
    const r = await request('/auth/login', { body: { username: 'target', password: `wrong guess ${i}!` } });
    assert.deepEqual([r.status, r.body], [401, { error: 'Invalid credentials' }]);
  }
  const locked = db.user(user.id);
  assert.equal(locked.failedLoginCount, 5);
  assert.ok(locked.lockedUntil.getTime() > Date.now() + 25_000 && locked.lockedUntil.getTime() <= Date.now() + 30_000, 'first lock: 30 s');
  const until = locked.lockedUntil.getTime();
  const right = await request('/auth/login', { body: { username: 'Target', password: PASSWORD } });
  assert.deepEqual([right.status, right.body, right.setCookie], [401, { error: 'Invalid credentials' }, null]);
  assert.equal(db.user(user.id).failedLoginCount, 5, 'attempts during the lock are not counted');
  assert.equal(db.user(user.id).lockedUntil.getTime(), until);
  db.user(user.id).lockedUntil = new Date(Date.now() - 1);
  const ok = await request('/auth/login', { body: { username: 'Target', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(db.user(user.id).failedLoginCount, 0);
  assert.equal(db.user(user.id).lockedUntil, null);
});

test('login, smart lockout: others\' guesses cannot lock the owner out of an address they signed in from; failures there lock only that address (NEW-4)', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Owner', password: PASSWORD });
  const request = await api(t);
  // The owner signs in once from this address; their session records it, so it is now familiar.
  assert.equal((await request('/auth/login', { body: { username: 'owner', password: PASSWORD } })).status, 200);
  // Guesses from other addresses locked the account (for every address it has never signed in from).
  db.user(user.id).failedLoginCount = 5;
  db.user(user.id).lockedUntil = new Date(Date.now() + 30_000);
  const owner = await request('/auth/login', { body: { username: 'owner', password: PASSWORD } });
  assert.equal(owner.status, 200, 'the owner still signs in from a familiar address');
  assert.equal(db.user(user.id).lockedUntil, null, 'and a successful sign-in clears the lock, as before');
  // Wrong passwords from the familiar address lock that address, on the same schedule, with the identical answer.
  for (let i = 1; i <= 5; i++) {
    const r = await request('/auth/login', { body: { username: 'owner', password: `wrong guess ${i}!` } });
    assert.deepEqual([r.status, r.body], [401, { error: 'Invalid credentials' }]);
  }
  const right = await request('/auth/login', { body: { username: 'owner', password: PASSWORD } });
  assert.deepEqual([right.status, right.body, right.setCookie], [401, { error: 'Invalid credentials' }, null], 'locked for this address');
  assert.equal(db.user(user.id).failedLoginCount, 0, 'familiar-address failures do not feed the account-wide lock');
});

// ---------------------------------------------------------------------------
// Items 6-9: registration conflicts, usernames, P2002 races, terms/age
// ---------------------------------------------------------------------------

test('register: terms stored; usernames unique case-insensitively (409 "Username unavailable"); e-mail clash 409 without saying it was the e-mail; reserved names refused', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  const created = await request('/auth/register', { body: { ...TERMS, username: 'Alice_Smith', email: 'Alice@Example.com', password: PASSWORD } });
  assert.equal(created.status, 201);
  const row = db.userByName('Alice_Smith');
  assert.equal(row.email, 'alice@example.com');
  assert.equal(row.termsVersion, authConfig.termsVersion);
  assert.ok(row.termsAcceptedAt instanceof Date && row.ageConfirmedAt instanceof Date);
  assert.ok(created.setCookie);

  const sameName = await request('/auth/register', { body: { ...TERMS, username: 'ALICE_smith', email: 'other@example.com', password: PASSWORD } });
  assert.deepEqual([sameName.status, sameName.body], [409, { error: 'Username unavailable' }]);
  const sameEmail = await request('/auth/register', { body: { ...TERMS, username: 'Someone_Else', email: 'alice@example.com', password: PASSWORD } });
  assert.deepEqual([sameEmail.status, sameEmail.body], [409, { error: 'Registration could not be completed with these details' }]);
  for (const username of ['Admin', 'admin_1', 'Support_Team', 'Guest_abc', 'bot_x', 'Moderator99']) {
    const r = await request('/auth/register', { body: { ...TERMS, username, email: `${username}@example.com`.toLowerCase(), password: PASSWORD } });
    assert.deepEqual([r.status, r.body], [409, { error: 'Username unavailable' }], username);
  }
  const invalid = await request('/auth/register', { body: { ...TERMS, username: 'bad name!', email: 'x@example.com', password: PASSWORD } });
  assert.equal(invalid.status, 400);
  assert.equal(db.users.size, 1, 'nothing else was created');
});

test('register: P2002 races map to 409 with the right message; any other database error is 503 and leaves no user behind', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  const queue = [];
  db.onUserCreate(() => { const next = queue.shift(); if (next) throw next; });
  const body = (n) => ({ ...TERMS, username: `Racer_${n}`, email: `racer${n}@example.com`, password: PASSWORD });
  queue.push(uniqueViolation(['usernameCanonical']));
  assert.deepEqual(await request('/auth/register', { body: body(1) }).then((r) => [r.status, r.body]), [409, { error: 'Username unavailable' }]);
  queue.push(uniqueViolation(['email']));
  assert.deepEqual(await request('/auth/register', { body: body(2) }).then((r) => [r.status, r.body]), [409, { error: 'Registration could not be completed with these details' }]);
  db.fail('session.create');
  const down = await request('/auth/register', { body: body(3) });
  assert.equal(down.status, 503);
  assert.equal(down.body.retryable, true);
  assert.equal(db.users.size, 0, 'user and session are created together or not at all');
});

test('guest: Guest_ + 10 hex characters, a name clash is retried (up to 5 attempts), then 503; other database errors are 503', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  let clashes = 4;
  db.onUserCreate(() => { if (clashes > 0) { clashes -= 1; throw uniqueViolation(['usernameCanonical']); } });
  const ok = await request('/auth/guest', { body: TERMS });
  assert.equal(ok.status, 201);
  assert.match(ok.body.user.username, /^Guest_[0-9a-f]{10}$/);
  assert.equal(ok.body.user.isGuest, true);
  assert.equal(db.calls['user.create'], 5);
  const row = db.user(ok.body.user.id);
  assert.equal(row.termsVersion, authConfig.termsVersion);
  assert.ok(row.ageConfirmedAt instanceof Date);

  clashes = 5;
  const exhausted = await request('/auth/guest', { body: TERMS });
  assert.equal(exhausted.status, 503);
  assert.equal(exhausted.body.retryable, true);
  db.fail('user.create');
  assert.equal((await request('/auth/guest', { body: TERMS })).status, 503);
  assert.equal(db.users.size, 1);
});

test('terms: guest and register require acceptTerms, confirmAge and the current termsVersion (400 TERMS_REQUIRED / 409 TERMS_OUTDATED)', async (t) => {
  const db = fakeAuthDb(t);
  const request = await api(t);
  const account = { username: 'Terms_Tester', email: 'terms@example.com', password: PASSWORD };
  for (const path of ['/auth/guest', '/auth/register']) {
    const extra = path === '/auth/register' ? account : {};
    for (const body of [undefined, { ...extra }, { ...extra, ...TERMS, acceptTerms: false }, { ...extra, ...TERMS, confirmAge: 'yes' }, { ...extra, acceptTerms: true, confirmAge: true }]) {
      const r = await request(path, { body });
      assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal(r.body.code, 'TERMS_REQUIRED');
    }
    const outdated = await request(path, { body: { ...extra, ...TERMS, termsVersion: '2020-01-01' } });
    assert.equal(outdated.status, 409);
    assert.deepEqual({ code: outdated.body.code, currentVersion: outdated.body.currentVersion }, { code: 'TERMS_OUTDATED', currentVersion: authConfig.termsVersion });
  }
  assert.equal(db.users.size, 0);
});
