/**
 * Socket auth hardening over the real Socket.io server and an in-memory
 * database (support/auth-fake-db.mjs): retryable handshake/packet refusals on
 * a database failure, SESSION_REVOKED + disconnect on revocation, private
 * delivery only to sessions that re-validate, SESSION_RENEW, and the idle
 * warning in AUTH_OK.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createTable, sitDown, beginIdleWarning } from '@poker/engine';
import { SOCKET_EVENTS } from '@poker/shared';
import { tableManager } from '../dist/game/manager.js';
import { encryptState } from '../dist/game/encryption.js';
import { createSocketServer } from '../dist/socket/index.js';
import { notifyUser } from '../dist/socket/notify.js';
import { revokeSession, revokeUserSessions } from '../dist/auth/sessions.js';
import { clearAuthCache } from '../dist/auth/sessions.js';
import { env } from '../dist/config.js';
import { fakeAuthDb } from './support/auth-fake-db.mjs';

/** The real Socket.io server; `client(token)` opens an authenticated client and resolves once it is connected. */
async function socketServer(t) {
  const server = createServer();
  const io = createSocketServer(server); tableManager.stop();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.disconnect();
    tableManager.stop();
    await new Promise((resolve) => io.close(resolve));
    tableManager.io = null;
  });
  const open = (token) => {
    const c = connect(url, { transports: ['websocket'], extraHeaders: { Origin: env.CLIENT_ORIGIN }, auth: { token }, reconnection: false });
    clients.push(c);
    return c;
  };
  const client = async (token) => {
    const c = open(token);
    const events = record(c);
    await once(c, SOCKET_EVENTS.AUTH_OK);
    return { c, events, socketId: c.id };
  };
  return { io, open, client };
}
/** Everything a client receives, in order (including its disconnect). */
function record(c) {
  const events = [];
  c.onAny((event, payload) => events.push({ event, payload }));
  c.on('disconnect', (reason) => events.push({ event: 'disconnect', payload: reason }));
  return events;
}
const named = (events, event) => events.filter((e) => e.event === event).map((e) => e.payload);
/** Resolve once `predicate()` holds (polling the event loop), or fail after `ms`. */
async function until(predicate, ms = 2_000, what = 'condition') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const serverSocket = (io, c) => io.sockets.sockets.get(c.id);

test('handshake: a database failure is refused as retryable (data.retryable); a revoked session is refused as Unauthorized', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Shaky' });
  const session = db.addSession(user.id);
  const { open } = await socketServer(t);
  db.fail('session.findUnique');
  const down = open(session.accessToken);
  const [err] = await once(down, 'connect_error');
  assert.deepEqual(err.data, { code: 'SERVICE_UNAVAILABLE', retryable: true });
  db.revokeRow(session.id, 'LOGOUT');
  const revoked = open(session.accessToken);
  const [denied] = await once(revoked, 'connect_error');
  assert.equal(denied.message, 'Unauthorized');
  assert.equal(denied.data, undefined);
});

test('packets: a database failure refuses only that packet (SERVICE_UNAVAILABLE, retryable) and keeps the socket; a revoked session gets SESSION_REVOKED, UNAUTHORIZED and a disconnect', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'PacketUser' });
  const session = db.addSession(user.id);
  // STAND_UP checks the table row (membership/closed) before calling the manager.
  db.table({ id: 'some-table', name: 'Some table', status: 'WAITING', isPrivate: false, hostId: null });
  const { client } = await socketServer(t);
  const stand = t.mock.method(tableManager, 'standUp', async () => false);
  t.mock.method(tableManager, 'snapshot', async () => null);
  const { c, events } = await client(session.accessToken);

  clearAuthCache();
  db.fail('session.findUnique');
  const refused = await c.timeout(2000).emitWithAck(SOCKET_EVENTS.STAND_UP, { tableId: 'some-table' });
  assert.deepEqual(refused, { ok: false, code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, please retry', retryable: true });
  await until(() => named(events, SOCKET_EVENTS.SERVER_ERROR).length === 1, 2000, 'SERVER_ERROR');
  assert.deepEqual(named(events, SOCKET_EVENTS.SERVER_ERROR)[0], { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, please retry', retryable: true, tableId: 'some-table' });
  assert.equal(stand.mock.callCount(), 0, 'the refused packet did nothing');
  await pause();
  assert.equal(c.connected, true, 'still connected');
  assert.equal(named(events, SOCKET_EVENTS.SESSION_REVOKED).length, 0);
  // The same request succeeds once the database answers again.
  assert.deepEqual(await c.timeout(2000).emitWithAck(SOCKET_EVENTS.STAND_UP, { tableId: 'some-table' }), { ok: true, pendingLeave: false });

  db.revokeRow(session.id, 'PASSWORD_CHANGED');
  c.emit(SOCKET_EVENTS.STAND_UP, { tableId: 'some-table' });
  await until(() => events.some((e) => e.event === 'disconnect'), 2000, 'disconnect');
  assert.deepEqual(named(events, SOCKET_EVENTS.SESSION_REVOKED), [{ reason: 'PASSWORD_CHANGED' }]);
  assert.equal(named(events, SOCKET_EVENTS.SERVER_ERROR).at(-1).code, 'UNAUTHORIZED');
  const order = events.map((e) => e.event);
  assert.ok(order.indexOf(SOCKET_EVENTS.SESSION_REVOKED) < order.lastIndexOf('disconnect'), 'told why before the disconnect');
  assert.equal(stand.mock.callCount(), 1);
});

test('revocation: revokeSession / revokeUserSessions tell each socket of the revoked sessions why and disconnect them; other sessions stay', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'RevokeMe' });
  const [s1, s2, s3] = [db.addSession(user.id), db.addSession(user.id), db.addSession(user.id)];
  const { client } = await socketServer(t);
  const a = await client(s1.accessToken);
  const a2 = await client(s1.accessToken); // a second tab on the same session
  const b = await client(s2.accessToken);
  const c = await client(s3.accessToken);
  assert.equal(await revokeSession(s1.id, 'LOGOUT'), true);
  await until(() => !a.c.connected && !a2.c.connected, 2000, 'session 1 sockets to disconnect');
  for (const x of [a, a2]) assert.deepEqual(named(x.events, SOCKET_EVENTS.SESSION_REVOKED), [{ reason: 'LOGOUT' }]);
  await pause();
  assert.equal(b.c.connected, true); assert.equal(c.c.connected, true);
  assert.equal(db.session(s1.id).revokeReason, 'LOGOUT');

  assert.equal(await revokeUserSessions(user.id, 'LOGOUT_ALL', { exceptSessionId: s3.id }), 1);
  await until(() => !b.c.connected, 2000, 'session 2 socket to disconnect');
  assert.deepEqual(named(b.events, SOCKET_EVENTS.SESSION_REVOKED), [{ reason: 'LOGOUT_ALL' }]);
  await pause();
  assert.equal(c.c.connected, true, 'the excepted session stays');
});

test('private delivery: a revoked session\'s socket receives no USER_PATCH (it is told SESSION_REVOKED and closed) while the user\'s other valid session does', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Wallet', bankroll: 4321 });
  const valid = db.addSession(user.id); const stale = db.addSession(user.id);
  const { client } = await socketServer(t);
  const good = await client(valid.accessToken);
  const bad = await client(stale.accessToken);
  // Revoked by another server process: no listener ran here and the socket is still attached.
  db.revokeRow(stale.id, 'SESSION_REVOKED');
  await tableManager.patchBankroll(user.id, 'some-table');
  await until(() => named(good.events, SOCKET_EVENTS.USER_PATCH).length === 1 && !bad.c.connected, 2000, 'patch and disconnect');
  assert.deepEqual(named(good.events, SOCKET_EVENTS.USER_PATCH), [{ bankroll: 4321, cashOutTableId: 'some-table' }]);
  assert.deepEqual(named(bad.events, SOCKET_EVENTS.USER_PATCH), [], 'nothing private reached the revoked session');
  assert.deepEqual(named(bad.events, SOCKET_EVENTS.SESSION_REVOKED), [{ reason: 'SESSION_REVOKED' }]);

  // A database failure skips the delivery but disconnects nobody.
  clearAuthCache();
  db.fail('session.findUnique');
  assert.equal(await notifyUser(user.id, SOCKET_EVENTS.USER_PATCH, { bankroll: 1 }), 0);
  await pause();
  assert.equal(good.c.connected, true);
  assert.equal(named(good.events, SOCKET_EVENTS.USER_PATCH).length, 1);
  assert.equal(await notifyUser(user.id, SOCKET_EVENTS.USER_PATCH, { bankroll: 2 }), 1);
});

test('broadcast: a database failure skips that viewer for this snapshot and keeps it connected; a revoked viewer is told SESSION_REVOKED and disconnected', async (t) => {
  const db = fakeAuthDb(t);
  const alice = db.addUser({ username: 'Viewer_A' }); const bob = db.addUser({ username: 'Viewer_B' });
  const sa = db.addSession(alice.id); const sb = db.addSession(bob.id);
  const { io, client } = await socketServer(t);
  const a = await client(sa.accessToken); const b = await client(sb.accessToken);
  const tableId = 'broadcast-table';
  for (const x of [a, b]) serverSocket(io, x.c).join(`table:${tableId}`);
  let table = createTable({ tableId, name: 'Broadcast', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  table = sitDown(table, 0, { userId: alice.id, username: alice.username, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });

  clearAuthCache();
  db.down = true;
  await tableManager.broadcast(table);
  db.down = false;
  await pause();
  for (const x of [a, b]) {
    assert.equal(named(x.events, SOCKET_EVENTS.STATE_SNAPSHOT).length, 0, 'skipped while unverifiable');
    assert.equal(x.c.connected, true, 'never disconnected for an outage');
  }
  db.revokeRow(sb.id, 'ACCOUNT_RESTRICTED');
  await tableManager.broadcast(table);
  await until(() => named(a.events, SOCKET_EVENTS.STATE_SNAPSHOT).length === 1 && !b.c.connected, 2000, 'snapshot and disconnect');
  assert.equal(named(a.events, SOCKET_EVENTS.STATE_SNAPSHOT)[0].tableId, tableId);
  assert.deepEqual(named(b.events, SOCKET_EVENTS.STATE_SNAPSHOT), []);
  assert.deepEqual(named(b.events, SOCKET_EVENTS.SESSION_REVOKED), [{ reason: 'ACCOUNT_RESTRICTED' }]);
});

test('SESSION_RENEW: the same user\'s new token swaps in place and moves the socket to the new session room; a token of another user (or an invalid one) is refused and the socket closed', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Renewer' }); const other = db.addUser({ username: 'Intruder' });
  const oldS = db.addSession(user.id); const newS = db.addSession(user.id); const otherS = db.addSession(other.id);
  const { io, client } = await socketServer(t);
  const x = await client(oldS.accessToken);
  assert.deepEqual(await x.c.timeout(2000).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token: newS.accessToken }), { ok: true });
  const socket = serverSocket(io, x.c);
  assert.equal(socket.data.sessionId, newS.id);
  assert.equal(socket.data.token, newS.accessToken);
  assert.ok(socket.rooms.has(`session:${newS.id}`) && !socket.rooms.has(`session:${oldS.id}`));
  // Revoking the old session no longer touches this socket; revoking the new one does.
  await revokeSession(oldS.id, 'LOGOUT');
  await pause();
  assert.equal(x.c.connected, true);
  assert.equal(named(x.events, SOCKET_EVENTS.SESSION_REVOKED).length, 0);

  const y = await client(newS.accessToken);
  assert.deepEqual(await y.c.timeout(2000).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token: otherS.accessToken }), { ok: false, code: 'UNAUTHORIZED', message: 'Please sign in again' });
  await until(() => !y.c.connected, 2000, 'mismatched renew to disconnect');
  assert.equal(serverSocket(io, y.c), undefined);

  const z = await client(newS.accessToken);
  assert.deepEqual(await z.c.timeout(2000).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token: 'forged.token.value' }), { ok: false, code: 'UNAUTHORIZED', message: 'Please sign in again' });
  await until(() => !z.c.connected, 2000, 'invalid renew to disconnect');

  await revokeSession(newS.id, 'LOGOUT');
  await until(() => !x.c.connected, 2000, 'renewed socket to follow its new session');
});

test('AUTH_OK: carries the seated table\'s active idle warning (closingInMs measured now) and no table snapshot; null without a warning', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Seated' }); const calm = db.addUser({ username: 'Calm' });
  const tableId = 'idle-table';
  let table = createTable({ tableId, name: 'Sleepy', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  table = sitDown(table, 0, { userId: user.id, username: user.username, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  table = beginIdleWarning(table, Date.now() + 20_000);
  db.table({ id: tableId, name: 'Sleepy', status: 'WAITING', isPrivate: false, hostId: user.id, updatedAt: new Date(), createdAt: new Date(), stateCiphertext: encryptState(table, `table:${tableId}`) });
  db.seat(user.id, tableId);
  const { open } = await socketServer(t);
  const c = open(db.addSession(user.id).accessToken);
  const events = record(c);
  const [ok] = await once(c, SOCKET_EVENTS.AUTH_OK);
  assert.equal(ok.activeTableId, tableId);
  assert.equal(ok.idleNotice.tableId, tableId);
  assert.equal(ok.idleNotice.tableName, 'Sleepy');
  assert.ok(ok.idleNotice.closingInMs > 15_000 && ok.idleNotice.closingInMs <= 20_000, `closingInMs ${ok.idleNotice.closingInMs}`);
  await pause();
  assert.deepEqual(named(events, SOCKET_EVENTS.STATE_SNAPSHOT), [], 'no table snapshot on connect');

  const quiet = open(db.addSession(calm.id).accessToken);
  const [none] = await once(quiet, SOCKET_EVENTS.AUTH_OK);
  assert.equal(none.activeTableId, null);
  assert.equal(none.idleNotice, null);
});
