/**
 * The real Socket.io server against the payloads today's web client sends
 * (apps/web/src/components/table/action-bar.tsx, buy-in-dialog.tsx,
 * table-controls.tsx), and the turn-identity staleness rule in the real
 * TableManager. The browser suite cannot catch a contract mismatch: its
 * fixture server (apps/web/test/support/game-server.mjs) does not validate
 * payloads. In-memory database only (run through test/support/run-tests.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createTable, EngineError, sitDown, startHand, turnIdOf } from '@poker/engine';
import { SOCKET_EVENTS } from '@poker/shared';
import { prisma } from '../dist/db/prisma.js';
import { TableManager, tableManager } from '../dist/game/manager.js';
import { decryptState, encryptState } from '../dist/game/encryption.js';
import { createSocketServer } from '../dist/socket/index.js';
import { env } from '../dist/config.js';
import { fakeAuthDb } from './support/auth-fake-db.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seatedTable = (tableId) => {
  let table = createTable({ tableId, name: 'Contract', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let seat = 0; seat < 3; seat++) table = sitDown(table, seat, { userId: `player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  return startHand(table);
};

/** The real socket server with the in-memory auth database, one table in a hand, and a connected user. */
async function socketServer(t) {
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
  return { actor, outsider, open };
}

test('ACTION_INTENT exactly as the web client sends it (with turnId) reaches the table manager with that turn', async (t) => {
  const { actor, open } = await socketServer(t);
  const intent = t.mock.method(tableManager, 'intent', async () => {});
  const { c } = await open(actor);
  c.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId: 'contract' });
  const [snap] = await once(c, SOCKET_EVENTS.STATE_SNAPSHOT);
  assert.ok(snap.actorLegal, 'the connected user is the actor');
  assert.match(snap.turnId, /^\d+:\d+$/);
  // apps/web/src/components/table/action-bar.tsx
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, {
    tableId: 'contract', revision: snap.revision, action: 'CALL', amount: undefined, clientActionId: crypto.randomUUID(), turnId: snap.turnId,
  });
  assert.deepEqual(reply, { ok: true });
  assert.equal(intent.mock.calls.length, 1);
  const [tableId, , engineIntent, revision, turnId] = intent.mock.calls[0].arguments;
  assert.deepEqual([tableId, engineIntent.action, revision, turnId], ['contract', 'CALL', snap.revision, snap.turnId]);
});

test('the action schema stays strict: a malformed turnId or an unknown key is refused before the manager', async (t) => {
  const { actor, open } = await socketServer(t);
  const intent = t.mock.method(tableManager, 'intent', async () => {});
  const { c } = await open(actor);
  const base = { tableId: 'contract', revision: 0, action: 'CALL', clientActionId: crypto.randomUUID() };
  for (const payload of [{ ...base, turnId: 'not-a-turn' }, { ...base, turnId: '1:2', extra: true }]) {
    const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, payload);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'INVALID_REQUEST');
  }
  assert.equal(intent.mock.calls.length, 0);
});

test('SEAT_CLAIM exactly as the buy-in dialog sends it (commandId and ack) is claimed and acknowledged', async (t) => {
  const { outsider, open } = await socketServer(t);
  const claim = t.mock.method(tableManager, 'seatClaim', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c, errors } = await open(outsider);
  // apps/web/src/components/table/buy-in-dialog.tsx
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400, commandId: crypto.randomUUID() });
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(claim.mock.calls.map((call) => call.arguments.slice(2)), [[4, 400]]);
  assert.deepEqual(errors, []);
});

test('a refused SEAT_CLAIM is acknowledged with its reason, and SERVER_ERROR names the table', async (t) => {
  const { outsider, open } = await socketServer(t);
  t.mock.method(tableManager, 'seatClaim', async () => { throw new EngineError('BANKROLL', 'Not enough bankroll'); });
  const { c, errors } = await open(outsider);
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400, commandId: crypto.randomUUID() });
  assert.deepEqual(reply, { ok: false, code: 'BANKROLL', message: 'Not enough bankroll' });
  await pause(50);
  assert.deepEqual(errors, [{ code: 'BANKROLL', message: 'Not enough bankroll', tableId: 'contract' }]);
});

test('a hand that fails to start after a committed claim is not reported as a failed claim (CR-017)', async (t) => {
  const { outsider, open } = await socketServer(t);
  t.mock.method(tableManager, 'seatClaim', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => { throw new Error('deal failed'); });
  const { c, errors } = await open(outsider);
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400, commandId: crypto.randomUUID() });
  assert.deepEqual(reply, { ok: true });
  await pause(100);
  assert.deepEqual(errors, []);
});

test('SEAT_CLAIM without commandId or ack (older clients) still claims', async (t) => {
  const { outsider, open } = await socketServer(t);
  const claim = t.mock.method(tableManager, 'seatClaim', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c, errors } = await open(outsider);
  c.emit(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400 });
  for (let i = 0; i < 40 && claim.mock.calls.length === 0; i++) await pause(25);
  assert.equal(claim.mock.calls.length, 1);
  assert.deepEqual(errors, []);
});

test('SIT_OUT and SIT_IN accept a commandId and are acknowledged', async (t) => {
  const { actor, open } = await socketServer(t);
  const toggle = t.mock.method(tableManager, 'sitToggle', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c } = await open(actor);
  assert.deepEqual(await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SIT_OUT, { tableId: 'contract', commandId: crypto.randomUUID() }), { ok: true });
  assert.deepEqual(await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SIT_IN, { tableId: 'contract' }), { ok: true });
  assert.deepEqual(toggle.mock.calls.map((call) => call.arguments[2]), [true, false]);
});

// --- turn identity in the real TableManager (in-memory persistence, as in game-flow.test.mjs) ---

function database(t) {
  let row = { id: 'turn-test', status: 'IN_HAND', isPrivate: false, hostId: 'player-0', stateCiphertext: encryptState(seatedTable('turn-test'), 'table:turn-test') };
  const replace = (target, name, implementation) => { const original = target[name]; target[name] = implementation; t.after(() => { target[name] = original; }); };
  replace(prisma.table, 'findUnique', async () => structuredClone(row));
  replace(prisma, '$transaction', async (run) => {
    let nextRow = structuredClone(row);
    const tx = {
      $queryRaw: async () => [{ id: row.id }],
      table: { findUnique: async () => structuredClone(nextRow), update: async ({ data }) => { nextRow = { ...nextRow, ...data }; return nextRow; } },
      tableSeat: { update: async (args) => args.data },
      user: { updateMany: async () => ({ count: 1 }) },
      hand: { create: async ({ data }) => data },
      botStatistic: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await run(tx);
    row = nextRow;
    return result;
  });
  return { state: () => decryptState(row.stateCiphertext, 'table:turn-test') };
}

test('an action for the current turn is accepted after an unrelated change bumped the revision (CR-008)', async (t) => {
  const db = database(t);
  const manager = new TableManager(); manager.stop();
  const before = db.state();
  const actor = before.players[before.toActSeat].userId;
  const bystander = before.players.find((p) => p && p.userId !== actor).userId;
  await manager.sitToggle('turn-test', bystander, true);
  assert.notEqual(db.state().revision, before.revision, 'the sit-out changed the table');
  assert.equal(turnIdOf(db.state()), turnIdOf(before), 'but not the turn');
  await manager.intent('turn-test', actor, { action: 'CALL' }, before.revision, turnIdOf(before));
  assert.notEqual(db.state().toActSeat, before.toActSeat, 'the call was applied');
});

test('an action naming a turn that is over is refused as stale; without a turnId the revision rule still applies', async (t) => {
  const db = database(t);
  const manager = new TableManager(); manager.stop();
  const first = db.state();
  await manager.intent('turn-test', first.players[first.toActSeat].userId, { action: 'CALL' }, first.revision, turnIdOf(first));
  const second = db.state();
  const nextActor = second.players[second.toActSeat].userId;
  await assert.rejects(manager.intent('turn-test', nextActor, { action: 'CALL' }, second.revision, turnIdOf(first)), { code: 'STALE_ACTION' });
  await assert.rejects(manager.intent('turn-test', nextActor, { action: 'CALL' }, first.revision), { code: 'STALE_ACTION' });
  assert.equal(db.state().toActSeat, second.toActSeat, 'nothing was applied');
});
