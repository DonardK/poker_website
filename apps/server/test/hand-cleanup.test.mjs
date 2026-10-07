/**
 * Money safety in the real TableManager (in-memory persistence, as in
 * game-flow.test.mjs; run through test/support/run-tests.mjs):
 * - CR-033: Hand Clean-up commits on its own, so a next deal that fails (here
 *   an RNG outage) cannot undo a leaver's cash-out;
 * - F09: a human's cash-out that credits no row rolls the whole commit back
 *   (the seat keeps its chips); a bot's cash-out credits nothing by design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { applyAction, createTable, leaveSeat, legalActions, sitDown, startHand } from '@poker/engine';
import { prisma } from '../dist/db/prisma.js';
import { TableManager } from '../dist/game/manager.js';
import { decryptState, encryptState } from '../dist/game/encryption.js';

const ID = 'cleanup-test';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seated = (count) => {
  let table = createTable({ tableId: ID, name: 'Clean-up', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let seat = 0; seat < count; seat++) table = sitDown(table, seat, { userId: `player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  return table;
};

/** In-memory Table row and wallet; `credit(userId)` is the row count a bankroll update reports. */
function database(t, initial, { credit = () => 1, kindOf = () => 'HUMAN' } = {}) {
  let row = { id: ID, status: 'IN_HAND', isPrivate: false, hostId: 'player-0', stateCiphertext: encryptState(initial, `table:${ID}`) };
  const credits = [];
  const replace = (target, name, implementation) => { const original = target[name]; target[name] = implementation; t.after(() => { target[name] = original; }); };
  replace(prisma.table, 'findUnique', async () => structuredClone(row));
  replace(prisma, '$transaction', async (run) => {
    let nextRow = structuredClone(row);
    const pending = [];
    const tx = {
      $queryRaw: async () => [{ id: row.id }],
      table: { findUnique: async () => structuredClone(nextRow), update: async ({ data }) => { nextRow = { ...nextRow, ...data }; return nextRow; } },
      tableSeat: { update: async (args) => args.data },
      user: {
        updateMany: async ({ where, data }) => { const count = credit(where.id); if (count) pending.push({ userId: where.id, amount: data.bankroll.increment }); return { count }; },
        findUnique: async ({ where }) => ({ kind: kindOf(where.id) }),
      },
      hand: { create: async ({ data }) => data },
      botStatistic: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await run(tx);
    row = nextRow; credits.push(...pending);
    return result;
  });
  return { credits, state: () => decryptState(row.stateCiphertext, `table:${ID}`) };
}

test('a failed next deal cannot undo Hand Clean-up: the leaver is paid once, then dealing resumes (CR-033)', async (t) => {
  // Three players; the first to act leaves (folded on their turn, cash-out pending), the next folds: the hand settles.
  let table = startHand(seated(3));
  const leaver = table.players[table.toActSeat].userId;
  table = leaveSeat(table, leaver);
  while (table.phase !== 'SHOWDOWN') {
    const actor = table.players[table.toActSeat];
    table = applyAction(table, actor.userId, { action: legalActions(table, actor.seatIndex).actions.includes('CHECK') ? 'CHECK' : 'FOLD' });
  }
  const owed = table.players.find((p) => p?.userId === leaver).stack;
  assert.ok(table.players.find((p) => p?.userId === leaver).pendingLeave, 'the leaver waits for Hand Clean-up');
  table.settledAt = Date.now() - 60_000; // the hand break is over: the SHOWDOWN timer fires at once
  const db = database(t, table);
  const manager = new TableManager();
  t.after(() => manager.stop());

  const realRandom = crypto.randomFillSync;
  crypto.randomFillSync = () => { throw new Error('Synthetic RNG outage'); };
  syncBuiltinESMExports();
  try {
    manager['armTimers'](table);
    for (let i = 0; i < 40 && db.state().phase === 'SHOWDOWN'; i++) await pause(25);
    await pause(400); // the next deal (tryStart) is attempted and fails on the RNG
    const after = db.state();
    assert.notEqual(after.phase, 'SHOWDOWN', 'Hand Clean-up committed');
    assert.equal(after.handNumber, table.handNumber, 'no hand was dealt during the outage');
    assert.equal(after.players.some((p) => p?.userId === leaver), false, 'the leaver\'s seat is released');
    assert.deepEqual(db.credits, [{ userId: leaver, amount: owed }], 'the leaver is paid exactly once');
  } finally {
    crypto.randomFillSync = realRandom;
    syncBuiltinESMExports();
  }
  await manager.tryStart(ID);
  assert.equal(db.state().handNumber, table.handNumber + 1, 'dealing resumes once the RNG is healthy');
  assert.deepEqual(db.credits, [{ userId: leaver, amount: owed }], 'and nobody is paid twice');
});

test('a human cash-out that credits no row rolls the whole commit back (F09)', async (t) => {
  const table = seated(2);
  const db = database(t, table, { credit: () => 0, kindOf: () => 'HUMAN' });
  const manager = new TableManager(); manager.stop();
  await assert.rejects(manager.standUp(ID, 'player-1'), { code: 'CASHOUT_FAILED' });
  assert.equal(db.state().players[1]?.userId, 'player-1', 'the seat keeps the player and the chips');
  assert.deepEqual(db.credits, []);
});

test('a bot cash-out credits nothing, by design, and still commits', async (t) => {
  const table = seated(2);
  const db = database(t, table, { credit: () => 0, kindOf: () => 'BOT' });
  const manager = new TableManager(); manager.stop();
  await manager.standUp(ID, 'player-1');
  assert.equal(db.state().players.some((p) => p?.userId === 'player-1'), false);
});
