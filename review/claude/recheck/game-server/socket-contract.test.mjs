/**
 * Re-check (2026-10-07): the real Socket.io server (apps/server/dist) against
 * the payloads today's web client sends, with the in-memory database of
 * apps/server/test/support/auth-fake-db.mjs. Listens on port 0 (loopback).
 *
 * Run from apps/server (forces a dead DATABASE_URL):
 *   node test/support/run-tests.mjs ../../review/claude/recheck/game-server/socket-contract.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createTable, sitDown, startHand } from '@poker/engine';
import { SOCKET_EVENTS } from '@poker/shared';
import { tableManager } from '../../../../apps/server/dist/game/manager.js';
import { encryptState } from '../../../../apps/server/dist/game/encryption.js';
import { createSocketServer } from '../../../../apps/server/dist/socket/index.js';
import { env } from '../../../../apps/server/dist/config.js';
import { fakeAuthDb } from '../../../../apps/server/test/support/auth-fake-db.mjs';

assert.ok(/127\.0\.0\.1:1\//.test(process.env.DATABASE_URL ?? ''), 'run through run-tests.mjs (dead DATABASE_URL)');

const pause = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t) {
  const db = fakeAuthDb(t);
  const users = [0, 1, 2].map((i) => db.addUser({ username: `Seat_${i}` }));
  let table = createTable({ tableId: 'contract', name: 'Contract', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  users.forEach((u, i) => { table = sitDown(table, i, { userId: u.id, username: u.username, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 }); });
  table = startHand(table);
  const actor = users.find((u) => u.id === table.players[table.toActSeat].userId);
  db.table({ id: 'contract', name: 'Contract', status: 'IN_HAND', isPrivate: false, hostId: users[0].id, maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000,
    createdAt: new Date(), updatedAt: new Date(), stateCiphertext: encryptState(table, 'table:contract') });
  for (const u of users) db.seat(u.id, 'contract');
  const outsider = db.addUser({ username: 'Outsider' });

  const server = createServer();
  const io = createSocketServer(server); tableManager.stop();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => { for (const c of clients) c.disconnect(); tableManager.stop(); await new Promise((resolve) => io.close(resolve)); tableManager.io = null; });
  const open = async (user) => {
    const c = connect(url, { transports: ['websocket'], extraHeaders: { Origin: env.CLIENT_ORIGIN }, auth: { token: db.addSession(user.id).accessToken }, reconnection: false });
    clients.push(c);
    const errors = [];
    c.on(SOCKET_EVENTS.SERVER_ERROR, (e) => errors.push(e));
    await once(c, SOCKET_EVENTS.AUTH_OK);
    return { c, errors };
  };
  return { db, actor, outsider, open };
}

test('ACTION_INTENT exactly as action-bar.tsx sends it (with turnId) is refused before it reaches the manager', async (t) => {
  const { actor, open } = await setup(t);
  const intent = t.mock.method(tableManager, 'intent', async () => {});
  const { c } = await open(actor);
  c.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId: 'contract' });
  const [snap] = await once(c, SOCKET_EVENTS.STATE_SNAPSHOT);
  assert.ok(snap.actorLegal, 'the connected user is the actor');
  console.log('snapshot turnId:', snap.turnId, 'revision:', snap.revision);
  assert.equal(typeof snap.turnId, 'string');
  // apps/web/src/components/table/action-bar.tsx:98-100
  const webPayload = { tableId: 'contract', revision: snap.revision, action: 'CALL', amount: undefined, clientActionId: crypto.randomUUID(), ...(snap.turnId ? { turnId: snap.turnId } : {}) };
  const withTurnId = await c.timeout(2000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, webPayload);
  console.log('ack for the web payload (with turnId):', JSON.stringify(withTurnId));
  const { turnId: _drop, ...legacyPayload } = webPayload;
  const withoutTurnId = await c.timeout(2000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, { ...legacyPayload, clientActionId: crypto.randomUUID() });
  console.log('ack without turnId:', JSON.stringify(withoutTurnId));
  console.log('manager.intent calls:', intent.mock.calls.length);
  assert.deepEqual(withTurnId, { ok: false, code: 'INVALID_REQUEST', message: 'Request could not be completed' });
  assert.deepEqual(withoutTurnId, { ok: true });
  assert.equal(intent.mock.calls.length, 1);
});

test('CR-019 server side: a fractional amount gets the generic INVALID_REQUEST, not BAD_AMOUNT', async (t) => {
  const { actor, open } = await setup(t);
  const intent = t.mock.method(tableManager, 'intent', async () => {});
  const { c } = await open(actor);
  const reply = await c.timeout(2000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, { tableId: 'contract', revision: 0, action: 'RAISE', amount: 150.5, clientActionId: crypto.randomUUID() });
  console.log('ack for amount 150.5:', JSON.stringify(reply));
  assert.equal(reply.code, 'INVALID_REQUEST');
  assert.equal(intent.mock.calls.length, 0);
});

test('SEAT_CLAIM exactly as buy-in-dialog.tsx sends it (with commandId) is refused; no ack in either case (CR-017)', async (t) => {
  const { outsider, open } = await setup(t);
  const claim = t.mock.method(tableManager, 'seatClaim', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c, errors } = await open(outsider);
  // apps/web/src/components/table/buy-in-dialog.tsx:123
  let ackWithCommandId = null;
  c.emit(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400, commandId: crypto.randomUUID() }, (result) => { ackWithCommandId = result; });
  await pause(400);
  console.log('SERVER_ERROR after web SEAT_CLAIM:', JSON.stringify(errors), 'ack:', JSON.stringify(ackWithCommandId), 'seatClaim calls:', claim.mock.calls.length);
  assert.equal(errors.at(-1)?.code, 'INVALID_REQUEST');
  assert.equal(claim.mock.calls.length, 0);
  let ackWithout = null;
  c.emit(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400 }, (result) => { ackWithout = result; });
  await pause(400);
  console.log('payload without commandId: seatClaim calls:', claim.mock.calls.length, 'ack:', JSON.stringify(ackWithout));
  assert.equal(claim.mock.calls.length, 1);
  assert.equal(ackWithout, null, 'SEAT_CLAIM success is never acknowledged');
});

test('CR-017: SIT_OUT / SIT_IN have no acknowledgement', async (t) => {
  const { actor, open } = await setup(t);
  const toggle = t.mock.method(tableManager, 'sitToggle', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c } = await open(actor);
  let ack = null;
  c.emit(SOCKET_EVENTS.SIT_OUT, { tableId: 'contract' }, (r) => { ack = r; });
  await pause(300);
  console.log('SIT_OUT: sitToggle calls', toggle.mock.calls.length, 'ack', JSON.stringify(ack));
  assert.equal(toggle.mock.calls.length, 1);
  assert.equal(ack, null);
});
