/**
 * Claude review — randomized lifecycle fuzz of the poker engine plus the
 * server's own audit verification. Read-only: no database, no network.
 *
 * Emulates TableManager.mutate: every transition is followed by
 * closeIfEmpty, cash-outs are credited to an in-memory bankroll ledger (human
 * seats only, as the server does), a hand entering SHOWDOWN goes through the
 * real handAuditColumns + buildParticipantAudit, and the committed state is
 * JSON round-tripped through upgradeTableState (a reload) which must change
 * nothing. Invariants are checked after every committed transition.
 *
 * Usage: node review/claude/repro/engine-fuzz.mjs [seed] [tables] [steps]
 * Prerequisite: built packages (packages/shared/dist, packages/engine/dist, apps/server/dist).
 */
import { randomBytes } from 'node:crypto';

// Disposable configuration; nothing here can reach a database.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://review:unused@127.0.0.1:1/review',
  REDIS_URL: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
});
const E = await import('../../../packages/engine/dist/index.js');
const S = await import('../../../packages/shared/dist/index.js');
const { handAuditColumns, buildParticipantAudit } = await import('../../../apps/server/dist/game/audit.js');

const seed = Number(process.argv[2] ?? Date.now() % 1_000_000);
const TABLES = Number(process.argv[3] ?? 150);
const STEPS = Number(process.argv[4] ?? 1200);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// Rejections a well-behaved engine may return for a bad or ill-timed command.
const EXPECTED = new Set(['SEAT_TAKEN', 'ALREADY_SEATED', 'BUYIN', 'BAD_SEAT', 'NOT_SEATED', 'TABLE_CLOSING', 'NO_TURN',
  'NOT_YOUR_TURN', 'ILLEGAL', 'MIN_BET', 'MIN_RAISE', 'BAD_AMOUNT', 'IN_HAND', 'NOT_ENOUGH_PLAYERS']);
const BETTING = new Set(['PREFLOP', 'FLOP', 'TURN', 'RIVER']);

const stats = { tables: 0, steps: 0, hands: 0, showdowns: 0, closedIdle: 0, closedEmpty: 0, rejected: {}, verifiedParticipantAudits: 0, clientVerifications: 0 };
const failures = [];

function summary(t) {
  return {
    phase: t.phase, status: t.status, handNumber: t.handNumber, toActSeat: t.toActSeat, currentBet: t.currentBet,
    closingAt: t.closingAt, closeReason: t.closeReason, dealerSeat: t.dealerSeat, sbSeat: t.sbSeat, bbSeat: t.bbSeat,
    players: t.players.map((p) => p && { seat: p.seatIndex, kind: p.kind, stack: p.stack, status: p.status, committed: p.committedThisHand,
      street: p.committedThisStreet, out: p.sittingOut, leaving: p.pendingLeave, waitBB: p.waitingForBigBlind, missed: p.missedBlind }),
  };
}

function fail(kind, detail, table) {
  failures.push({ kind, detail, state: table ? summary(table) : null });
}

const readyToDeal = (t) => {
  if (t.closingAt != null || t.closeReason != null) return false;
  const live = t.players.filter((p) => p && !p.sittingOut && p.stack > 0);
  return live.length >= 2 && live.some((p) => p.kind === 'HUMAN');
};

async function runTable(index) {
  stats.tables++;
  let now = Date.UTC(2026, 8, 30, 12, 0, 0) + index * 10_000_000;
  const maxSeats = int(2, 9);
  const sb = pick([1, 5, 25]);
  const bb = sb * 2;
  const withBots = rand() < 0.1;
  const names = ['Alice', 'Ah_Kd', 'Kd2c', 'Guest_7c', 'Td_9s', 'Bob', 'Qs', 'Zed_Ac', 'Js_Jh', 'Cleo', 'Mo_5d'];
  const users = Array.from({ length: maxSeats + 3 }, (_, i) => ({
    id: `fz${index}-u${i}`, username: `${names[i % names.length]}${i}`, kind: withBots && i % 3 === 2 ? 'BOT' : 'HUMAN',
  }));
  const bankroll = new Map(users.map((u) => [u.id, bb * 400]));
  let botSink = 0; // the server does not credit BOT cash-outs to any wallet
  const total0 = [...bankroll.values()].reduce((a, b) => a + b, 0);
  let table = E.createTable({ tableId: `fuzz-${seed}-${index}`, name: pick(['Fuzz table', 'Ah Kd 2c', 'Night game']), maxSeats,
    smallBlind: sb, bigBlind: bb, timeBankMs: 15_000, createdAt: now });
  let dead = false;

  const seatUser = (t, user, seat, buyIn) => E.sitDown(t, seat, { userId: user.id, username: user.username, avatarHue: 0,
    kind: user.kind, botProfile: user.kind === 'BOT' ? pick(['TAG', 'LOOSE_PASSIVE', 'MANIAC', 'GTO']) : null, buyIn }, now);

  async function verifyHand(t) {
    stats.hands++;
    if (t.players.some((p) => p?.showedCards)) stats.showdowns++;
    let cols;
    try {
      cols = await handAuditColumns(t);
    } catch (err) {
      fail('AUDIT_INVALID_ON_LEGIT_HAND', `${err.code ?? ''} ${err.message}`, t);
      return false;
    }
    const sealed = E.sealedAudit(t.fairness);
    const stored = t.dealtSeats.map((seat) => ({ seatIndex: seat, showedCards: t.players[seat].showedCards }));
    for (const seat of t.dealtSeats) {
      try {
        await buildParticipantAudit(cols.auditRecord, sealed, { tableId: t.tableId, handNumber: t.handNumber, userId: t.players[seat].userId, viewerSeat: seat }, stored);
        stats.verifiedParticipantAudits++;
      } catch (err) {
        fail('PARTICIPANT_AUDIT_REFUSED_ON_LEGIT_HAND', `${err.code ?? ''} seat ${seat}: ${err.message}`, t);
        return false;
      }
    }
    return true;
  }

  async function checkInvariants(t) {
    const betting = BETTING.has(t.phase);
    const onTable = t.players.reduce((s, p) => s + (p ? p.stack + (betting ? p.committedThisHand : 0) : 0), 0);
    const total = [...bankroll.values()].reduce((a, b) => a + b, 0) + onTable + botSink;
    if (total !== total0) { fail('CHIPS_NOT_CONSERVED', `total ${total} vs ${total0}`, t); return false; }
    for (const p of t.players) {
      if (p && (p.stack < 0 || p.committedThisHand < 0 || !Number.isSafeInteger(p.stack))) { fail('NEGATIVE_OR_BAD_STACK', `seat ${p.seatIndex}`, t); return false; }
    }
    if (betting) {
      if (t.toActSeat == null) { fail('BETTING_WITHOUT_ACTOR', 'hand in progress with nobody to act', t); return false; }
      const actor = t.players[t.toActSeat];
      if (!actor || actor.status !== 'ACTIVE' || actor.stack <= 0 || !E.legalActions(t, t.toActSeat)) { fail('BAD_ACTOR', `seat ${t.toActSeat}`, t); return false; }
    } else if (t.toActSeat != null) {
      fail('ACTOR_OUTSIDE_BETTING', `seat ${t.toActSeat} during ${t.phase}`, t); return false;
    }
    // Every viewer's projection must pass the fail-closed leak guard, and the
    // browser's card verification must accept it (a false alarm disconnects the player).
    const viewers = [null, ...t.players.filter(Boolean).map((p) => p.userId)];
    for (const viewer of viewers) {
      let state;
      try { state = E.projectTableState(t, viewer); } catch (err) { fail('LEAK_GUARD_FALSE_POSITIVE', `${viewer}: ${err.message}`, t); return false; }
      if (viewer !== null) {
        stats.clientVerifications++;
        if (!await S.verifyTableCards(state)) { fail('CLIENT_CARD_VERIFY_FALSE_ALARM', `viewer ${viewer}`, t); return false; }
      }
    }
    return true;
  }

  async function commit(before, after) {
    let result = E.closeIfEmpty(after);
    if (result === before) return before;
    result = structuredClone(result);
    result.revision = before.revision + 1;
    for (const cash of result.cashOuts) {
      const user = users.find((u) => u.id === cash.userId);
      if (user.kind === 'HUMAN') bankroll.set(cash.userId, bankroll.get(cash.userId) + cash.stack);
      else botSink += cash.stack;
    }
    result.cashOuts = [];
    if (result.phase === 'SHOWDOWN' && (before.phase !== 'SHOWDOWN' || before.handNumber !== result.handNumber)) {
      if (!await verifyHand(result)) { dead = true; return result; }
    }
    // A reload (encrypt/decrypt + upgradeTableState) must not change a current state.
    const text = JSON.stringify(result);
    const reloaded = E.upgradeTableState(JSON.parse(text)).table;
    if (JSON.stringify(reloaded) !== text) { fail('RELOAD_CHANGES_CURRENT_STATE', 'upgradeTableState altered a current state', result); dead = true; return result; }
    if (!await checkInvariants(reloaded)) { dead = true; return reloaded; }
    if (reloaded.status === 'CLOSED') {
      if (reloaded.closeReason === 'IDLE') stats.closedIdle++; else stats.closedEmpty++;
    }
    return reloaded;
  }

  /** One server mutation. `beforeCommit` applies wallet effects of the same transaction (e.g. the buy-in debit). */
  async function apply(label, fn, beforeCommit) {
    let after;
    try {
      after = fn(table);
    } catch (err) {
      if (err instanceof E.EngineError && EXPECTED.has(err.code)) { stats.rejected[err.code] = (stats.rejected[err.code] ?? 0) + 1; return false; }
      fail('UNEXPECTED_ENGINE_ERROR', `${label}: ${err.code ?? err.name} ${err.message}`, table);
      dead = true;
      return false;
    }
    if (after !== table && beforeCommit) beforeCommit(after);
    table = await commit(table, after);
    return true;
  }

  // A seat claim: the engine seats the player and the same transaction debits the buy-in.
  const trySeat = async (user) => {
    const empty = table.players.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
    if (!empty.length || table.players.some((p) => p?.userId === user.id)) return;
    const buyIn = rand() < 0.08 ? pick([bb * 20 - 1, bb * 200 + 1, 0]) : int(bb * 20, bb * 200);
    if (buyIn > bankroll.get(user.id)) return;
    await apply('sitDown', (t) => E.recordActivity(seatUser(t, user, pick(empty), buyIn), now, user.kind === 'HUMAN' ? user.id : undefined),
      (after) => { if (after.players.some((p) => p?.userId === user.id)) bankroll.set(user.id, bankroll.get(user.id) - buyIn); });
  };
  // The host's seat is created with the table (the server hydrates it from the seat row).
  const host = users[0];
  host.kind = 'HUMAN';
  table = seatUser(table, host, 0, bb * 100);
  bankroll.set(host.id, bankroll.get(host.id) - bb * 100);

  for (let step = 0; step < STEPS && !dead && table.status !== 'CLOSED'; step++) {
    stats.steps++;
    now += int(200, 4000);
    const betting = BETTING.has(table.phase);
    const r = rand();
    const seatedUsers = table.players.filter(Boolean);
    const anyUser = () => pick(users);
    const anySeated = () => (seatedUsers.length ? pick(seatedUsers) : null);

    if (r < 0.06) { // someone new sits down
      const user = users.find((u) => !table.players.some((p) => p?.userId === u.id) && rand() < 0.5) ?? anyUser();
      await trySeat(user);
      continue;
    }
    if (r < 0.10) { // leave
      const p = anySeated();
      if (p) await apply('leaveSeat', (t) => E.leaveSeat(t, p.userId, now));
      continue;
    }
    if (r < 0.15) { // sit out / sit in
      const p = anySeated();
      if (p) await apply(p.sittingOut ? 'sitIn' : 'sitOut', (t) => {
        const next = p.sittingOut ? E.sitIn(t, p.userId, now) : E.sitOut(t, p.userId, now);
        return next === t ? t : E.recordActivity(next, now, p.userId);
      });
      continue;
    }
    if (r < 0.17) { // idle warning begins (server decided the table is idle)
      await apply('beginIdleWarning', (t) => E.beginIdleWarning(t, now + 10_000));
      continue;
    }
    if (r < 0.19 && table.closingAt != null) { // I'm still here, or the warning expires
      const p = anySeated();
      if (rand() < 0.5 && p) await apply('keepTableOpen', (t) => E.keepTableOpen(t, p.userId, now));
      else await apply('closeTable(IDLE)', (t) => E.closeTable(t, 'IDLE', now));
      continue;
    }
    if (r < 0.21 && betting) { // a non-actor tries to act
      const p = anySeated();
      if (p && table.players[table.toActSeat]?.userId !== p.userId) await apply('outOfTurn', (t) => E.applyAction(t, p.userId, { action: 'CALL' }, now));
      continue;
    }

    if (table.phase === 'WAITING' || table.phase === 'COMPLETE') {
      if (readyToDeal(table)) await apply('startHand', (t) => E.startHand(t, now));
      else if (seatedUsers.length < 2) await trySeat(anyUser());
      continue;
    }
    if (table.phase === 'SHOWDOWN') {
      // The SHOWDOWN timer: Hand Clean-up, then deal if ready.
      await apply('cleanup+deal', (t) => { let next = E.completeHand(t); if (readyToDeal(next)) next = E.startHand(next, now); return next; });
      continue;
    }
    // Betting in progress.
    const actor = table.players[table.toActSeat];
    if (actor.kind === 'BOT') {
      const decision = E.decideBotAction(table);
      let after;
      try { after = E.applyAction(table, actor.userId, decision.intent, now); } catch (err) {
        fail('BOT_ILLEGAL_DECISION', `${err.code ?? err.name}: ${JSON.stringify(decision.intent)} ${err.message}`, table); dead = true; continue;
      }
      table = await commit(table, after);
      continue;
    }
    if (rand() < 0.08) { await apply('timeout', (t) => E.applyTimeout(t, now)); continue; }
    const legal = E.legalActions(table, table.toActSeat);
    const weights = legal.actions.flatMap((a) => (a === 'ALL_IN' ? [a] : a === 'FOLD' ? [a, a] : [a, a, a, a]));
    const action = pick(weights);
    let amount;
    if (action === 'BET' || action === 'RAISE') {
      const lo = action === 'BET' ? legal.minBet : legal.minRaiseTo;
      amount = rand() < 0.1 ? pick([lo - 1, legal.maxRaiseTo + 1, 0]) : int(lo, Math.min(legal.maxRaiseTo, lo + bb * 20));
    }
    await apply(`act ${action}`, (t) => E.recordActivity(E.applyAction(t, actor.userId, { action, ...(amount !== undefined ? { amount } : {}) }, now), now, actor.userId));
  }
}

const started = Date.now();
for (let i = 0; i < TABLES; i++) {
  await runTable(i);
  if (failures.length >= 5) break;
}
console.log(JSON.stringify({ seed, tables: TABLES, stepsPerTable: STEPS, durationMs: Date.now() - started, stats, failureCount: failures.length,
  failures: failures.slice(0, 5) }, null, 2));
process.exit(failures.length ? 1 : 0);
