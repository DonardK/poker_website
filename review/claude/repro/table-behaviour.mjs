/**
 * Claude review — two table behaviours, run on the real engine and the real
 * TableManager (apps/server/dist) with the database transaction replaced in
 * memory. No database, no network.
 *
 *  1. An absent player (disconnected, tab closed, or "Lobby (keep seat)")
 *     is never sat out: every hand they are dealt in, post blinds, and time
 *     out. Their stack bleeds away while opponents wait a full time bank for
 *     each of their decisions. (plan.md asked for disconnected players to be
 *     sat out; manager.ts:49-53 deliberately does nothing on disconnect.)
 *  2. A valid action is refused as STALE_ACTION when anything else at the
 *     table changed the revision (here: another seated player sits out),
 *     although the actor's options did not change (manager.ts:152, :206-211).
 *
 * Usage: node review/claude/repro/table-behaviour.mjs
 */
import { randomBytes } from 'node:crypto';

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://review:unused@127.0.0.1:1/review', REDIS_URL: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
});
const E = await import('../../../packages/engine/dist/index.js');
const { prisma } = await import('../../../apps/server/dist/db/prisma.js');
const { TableManager } = await import('../../../apps/server/dist/game/manager.js');
const { encryptState } = await import('../../../apps/server/dist/game/encryption.js');
const { logger } = await import('../../../apps/server/dist/logger.js');
for (const level of ['error', 'warn', 'info', 'debug']) logger[level] = () => {};

const seat = (table, index, name, buyIn = 1000) => E.sitDown(table, index, { userId: name, username: name, avatarHue: 0, kind: 'HUMAN', botProfile: null, buyIn });
const results = {};

// ---- 1. The absent player -------------------------------------------------------
{
  let t = seat(seat(E.createTable({ tableId: 'absent', name: 'Absent', maxSeats: 2, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 }), 0, 'Active'), 1, 'Absent');
  let now = Date.UTC(2026, 8, 30, 12);
  let timeouts = 0;
  const stacks = [];
  for (let hand = 1; hand <= 100 && t.players[1]?.stack > 0; hand++) {
    t = E.startHand(t, now);
    while (!['SHOWDOWN', 'WAITING'].includes(t.phase)) {
      const actor = t.players[t.toActSeat];
      if (actor.userId === 'Absent') {
        // Nobody is there: the server's timer fires after the full time bank.
        now += t.timeBankMs; timeouts++;
        t = E.applyTimeout(t, now);
      } else {
        now += 1_000;
        const legal = E.legalActions(t, t.toActSeat);
        // The active player applies minimum pressure: a min-raise or min-bet when allowed, otherwise check/call.
        const intent = legal.actions.includes('RAISE') ? { action: 'RAISE', amount: legal.minRaiseTo }
          : legal.actions.includes('BET') ? { action: 'BET', amount: legal.minBet }
          : legal.actions.includes('CHECK') ? { action: 'CHECK' } : { action: 'CALL' };
        t = E.recordActivity(E.applyAction(t, actor.userId, intent, now), now, actor.userId);
      }
    }
    t = E.completeHand(t);
    now += 3_200;
    stacks.push(t.players[1]?.stack ?? 0);
    if (t.players[1]?.sittingOut) break;
  }
  results.absentPlayer = {
    handsPlayed: stacks.length,
    absentStackAfterEach10Hands: stacks.filter((_, i) => (i + 1) % 10 === 0),
    absentPlayerEverSatOutAutomatically: Boolean(t.players[1]?.sittingOut),
    timeoutsTaken: timeouts,
    minutesOpponentSpentWaitingOnTimeouts: Math.round((timeouts * 15) / 60),
  };
}

// ---- 2. STALE_ACTION for an unrelated change --------------------------------------
{
  let table = E.startHand(seat(seat(seat(E.createTable({ tableId: 'stale', name: 'Stale', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 }), 0, 'P0'), 1, 'P1'), 2, 'P2'));
  let row = { id: 'stale', status: 'IN_HAND', isPrivate: false, hostId: 'P0', createdAt: new Date(), updatedAt: new Date(), stateCiphertext: encryptState(table, 'table:stale') };
  prisma.table.findUnique = async () => structuredClone(row);
  prisma.user.findUnique = async () => ({ bankroll: 0 });
  prisma.$transaction = async (fn) => {
    let pending = structuredClone(row);
    const tx = {
      $queryRaw: async () => [{ id: 'stale' }],
      table: { findUnique: async () => structuredClone(pending), update: async ({ data }) => { pending = { ...pending, ...data }; } },
      tableSeat: { update: async () => {}, findFirst: async () => null },
      user: { updateMany: async () => ({ count: 1 }), findUnique: async () => null },
      hand: { findFirst: async () => null, create: async () => {} },
      botStatistic: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await fn(tx);
    row = pending;
    return result;
  };
  const manager = new TableManager();
  manager.stop();
  const seen = await manager.get('stale');
  const actor = seen.players[seen.toActSeat];
  const bystander = seen.players.find((p) => p && p.userId !== actor.userId && seen.toActSeat !== p.seatIndex);
  const optionsBefore = E.legalActions(seen, seen.toActSeat);
  // Another seated player (not the actor) sits out while the actor decides.
  await manager.sitToggle('stale', bystander.userId, true);
  const current = await manager.get('stale');
  let refusal = null;
  try {
    await manager.intent('stale', actor.userId, { action: 'CALL' }, seen.revision);
  } catch (err) {
    refusal = { code: err.code, message: err.message };
  }
  results.staleAction = {
    actorsOptionsUnchanged: JSON.stringify(E.legalActions(current, current.toActSeat)) === JSON.stringify(optionsBefore) && current.toActSeat === seen.toActSeat,
    revisionSeenByActor: seen.revision, revisionNow: current.revision,
    changeThatIntervened: `${bystander.username} sat out`,
    validCallRefused: refusal,
  };
}

console.log(JSON.stringify(results, null, 2));
await prisma.$disconnect();
