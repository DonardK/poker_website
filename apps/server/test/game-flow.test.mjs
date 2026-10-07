import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { applyAction, completeHand, createTable, EngineError, legalActions, sitDown, startHand } from '@poker/engine';
import { SOCKET_EVENTS } from '@poker/shared';
import { prisma } from '../dist/db/prisma.js';
import { TableManager, tableManager } from '../dist/game/manager.js';
import { encryptState, decryptState } from '../dist/game/encryption.js';
import { signAccessToken } from '../dist/auth/jwt.js';
import { createSocketServer } from '../dist/socket/index.js';
import { env } from '../dist/config.js';

function seated() {
  let table = createTable({ tableId: 'flow-test', name: 'Flow test', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let seat = 0; seat < 3; seat++) table = sitDown(table, seat, {
    userId: `player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0,
  });
  return startHand(table);
}

// In-memory persistence boundary. No real database, accounts or chips are touched.
function database(t) {
  let row = { id: 'flow-test', status: 'IN_HAND', isPrivate: false, hostId: 'player-0', stateCiphertext: encryptState(seated(), 'table:flow-test') };
  let bankroll = 9000;
  const writes = [];
  const reads = [];
  const user = () => ({ id: 'player-0', username: 'Player-0', kind: 'HUMAN', bankroll });
  // Prisma delegates expose methods through a Proxy without method descriptors.
  const replace = (target, name, implementation) => {
    const original = target[name]; target[name] = implementation;
    t.after(() => { target[name] = original; });
  };
  replace(prisma.table, 'findUnique', async (args) => { reads.push(args); return structuredClone(row); });
  replace(prisma.user, 'findUnique', async () => user());
  replace(prisma.tableSeat, 'findUnique', async () => ({ tableId: row.id }));
  replace(prisma.session, 'findUnique', async () => ({ userId: 'player-0', expiresAt: new Date(Date.now() + 60_000), user: user() }));
  replace(prisma, '$transaction', async (run) => {
    let nextRow = structuredClone(row);
    let nextBankroll = bankroll;
    const pendingWrites = [];
    const tx = {
      $queryRaw: async () => [{ id: row.id }],
      table: {
        findUnique: async (args) => { reads.push(args); return structuredClone(nextRow); },
        update: async ({ data }) => { nextRow = { ...nextRow, ...data }; return nextRow; },
      },
      tableSeat: { update: async (args) => { pendingWrites.push(args); return args.data; } },
      user: { updateMany: async ({ data }) => { nextBankroll += data.bankroll.increment; return { count: 1 }; } },
      hand: { create: async ({ data }) => data },
      botStatistic: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await run(tx);
    row = nextRow; bankroll = nextBankroll; writes.push(...pendingWrites);
    return result;
  });
  return { writes, reads, bankroll: () => bankroll, state: () => decryptState(row.stateCiphertext, 'table:flow-test') };
}

test('a call writes only the changed seat; encrypted loads do not fetch seat/user relations', async (t) => {
  const db = database(t);
  const manager = new TableManager(); manager.stop();
  await manager.intent('flow-test', 'player-0', { action: 'CALL' }, db.state().revision);
  assert.deepEqual(db.writes.map((w) => w.where.tableId_seatIndex.seatIndex), [0]);
  assert.ok(db.reads.every((r) => r.include === undefined));
  assert.equal(db.state().players[0].stack, 990);
  assert.equal(db.state().toActSeat, 1);
});

test('queued cash-out reaches the user room after leaving the table; retry never pays twice', async (t) => {
  const db = database(t);
  const manager = new TableManager(); manager.stop();
  const emitted = [];
  // The wallet goes through notifyUser: to each signed-in socket in user:<id> whose session re-validates.
  const userSocket = (room) => ({
    data: { userId: 'player-0', token: signAccessToken('player-0', 'Player-0', 'fixture-session') },
    emit: (event, payload) => emitted.push({ room, event, payload }), disconnect: () => emitted.push({ room, event: 'disconnect' }),
  });
  manager.io = { in: (room) => ({ fetchSockets: async () => room === 'user:player-0' ? [userSocket(room)] : [] }), to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  assert.equal(await manager.standUp('flow-test', 'player-0'), true);
  assert.equal(db.bankroll(), 9000);
  for (let n = 0; db.state().phase !== 'SHOWDOWN' && n < 100; n++) {
    await manager.mutate('flow-test', (state) => {
      const legal = legalActions(state, state.toActSeat);
      return applyAction(state, state.players[state.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
    });
  }
  await manager.mutate('flow-test', completeHand);
  assert.equal(db.bankroll(), 10000);
  assert.ok(emitted.some((e) => e.room === 'user:player-0' && e.event === SOCKET_EVENTS.USER_PATCH && e.payload.bankroll === 10000 && e.payload.cashOutTableId === 'flow-test'));
  const count = db.writes.length;
  assert.equal(await manager.standUp('flow-test', 'player-0'), false);
  assert.equal(db.bankroll(), 10000);
  assert.equal(db.writes.length, count);
});

test('failed persistence rolls back chips and emits no wallet update', async (t) => {
  const db = database(t);
  const manager = new TableManager(); manager.stop();
  await assert.rejects(manager.mutate('flow-test', async (state, tx) => {
    await tx.user.updateMany({ data: { bankroll: { increment: 1000 } } });
    throw new Error('storage failed');
  }), /storage failed/);
  assert.equal(db.bankroll(), 9000);
  assert.equal(db.state().players[0].stack, 1000);
});

test('stale timer failure cannot replace a newer turn timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const manager = new TableManager(); t.after(() => manager.stop());
  let reject;
  t.mock.method(manager, 'mutate', () => new Promise((_, fail) => { reject = fail; }));
  const state = seated(); state.revision = 1;
  manager.armTimers(state);
  t.mock.timers.tick(15_000);
  manager.armTimers({ ...state, revision: 2, turnStartedAt: Date.now() });
  const newer = manager.timers.get(state.tableId);
  reject(new EngineError('STALE_ACTION', 'stale'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(manager.timers.get(state.tableId), newer);
});

test('timer recovery retries a temporary read failure and stops cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const manager = new TableManager(); t.after(() => manager.stop());
  const state = seated();
  let attempts = 0;
  t.mock.method(manager, 'get', async () => { if (++attempts === 1) throw new Error('temporary outage'); return state; });
  manager.retryTimer(state.tableId, state.revision);
  t.mock.timers.tick(1000);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 2);
  assert.ok(manager.timers.has(state.tableId));
  manager.stop();
  manager.armTimers(state);
  assert.equal(manager.timers.size, 0);
});

test('real sockets acknowledge leave/errors and do not autojoin the lobby player to a table', async (t) => {
  database(t);
  const server = createServer();
  const io = createSocketServer(server); tableManager.stop();
  const stand = t.mock.method(tableManager, 'standUp', async () => true);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = connect(`http://127.0.0.1:${server.address().port}`, {
    transports: ['websocket'], extraHeaders: { Origin: env.CLIENT_ORIGIN },
    auth: { token: signAccessToken('player-0', 'Player-0', 'fixture-session') },
  });
  t.after(async () => { client.disconnect(); tableManager.stop(); await new Promise((resolve) => io.close(resolve)); tableManager.io = null; });
  await once(client, SOCKET_EVENTS.AUTH_OK);
  assert.equal(io.sockets.adapter.rooms.has('table:flow-test'), false);
  const reply = await client.timeout(2000).emitWithAck(SOCKET_EVENTS.STAND_UP, { tableId: 'flow-test' });
  assert.deepEqual(reply, { ok: true, pendingLeave: true });
  assert.deepEqual(stand.mock.calls[0].arguments, ['flow-test', 'player-0']);
  const invalid = await client.timeout(2000).emitWithAck(SOCKET_EVENTS.STAND_UP, {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_REQUEST');
  let rejectAction = true;
  t.mock.method(tableManager, 'intent', async () => {
    if (rejectAction) { rejectAction = false; throw new EngineError('ILLEGAL', 'Try a legal action'); }
  });
  const action = { tableId: 'flow-test', revision: 0, action: 'CALL', clientActionId: crypto.randomUUID() };
  assert.deepEqual(await client.timeout(2000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, action), { ok: false, code: 'ILLEGAL', message: 'Try a legal action' });
  assert.deepEqual(await client.timeout(2000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, { ...action, clientActionId: crypto.randomUUID() }), { ok: true });
  const burst = await Promise.all(Array.from({ length: 12 }, () => client.timeout(2000).emitWithAck(SOCKET_EVENTS.STAND_UP, { tableId: 'flow-test' })));
  assert.ok(burst.some((r) => !r.ok && r.code === 'RATE_LIMITED'));
});
