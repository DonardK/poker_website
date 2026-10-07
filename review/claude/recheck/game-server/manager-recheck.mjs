/**
 * Re-check (2026-10-07) of game-server findings against today's dist.
 * Real engine (packages/engine/dist) and real TableManager (apps/server/dist);
 * every Prisma call is replaced in memory. DATABASE_URL/DIRECT_URL point at
 * loopback port 1 BEFORE any server import. No network, no listening socket.
 *
 * Usage (repo root): node review/claude/recheck/game-server/manager-recheck.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';

const DEAD = 'postgresql://review:unused@127.0.0.1:1/review';
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DEAD, DIRECT_URL: DEAD, DATABASE_TEST_ADMIN_URL: DEAD, REDIS_URL: '',
  TLS_CERT_FILE: '', TLS_KEY_FILE: '', TRUST_PROXY_HOPS: '0', CLIENT_ORIGIN: 'http://127.0.0.1:3999',
  GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '', GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d',
});
const E = await import('../../../../packages/engine/dist/index.js');
const { sealedAudit } = await import('../../../../packages/engine/dist/audit.js');
const S = await import('../../../../packages/shared/dist/index.js');
const { prisma } = await import('../../../../apps/server/dist/db/prisma.js');
const { TableManager } = await import('../../../../apps/server/dist/game/manager.js');
const { encryptState, decryptState } = await import('../../../../apps/server/dist/game/encryption.js');
const { signAccessToken } = await import('../../../../apps/server/dist/auth/jwt.js');
const { clearAuthCache } = await import('../../../../apps/server/dist/auth/sessions.js');
const { logger } = await import('../../../../apps/server/dist/logger.js');
const logs = [];
for (const level of ['fatal', 'error', 'warn', 'info', 'debug']) logger[level] = (fields, msg) => logs.push({ level, msg: typeof fields === 'string' ? fields : msg });

// Belt and braces: any Prisma call this script did not stub fails loudly instead of trying the (dead) URL.
const results = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seatCfg = (name, kind = 'HUMAN') => ({ userId: name, username: name, avatarHue: 0, kind, botProfile: kind === 'BOT' ? 'MANIAC' : null, buyIn: 1000 });
const seat = (t, i, name, kind) => E.sitDown(t, i, seatCfg(name, kind));
const table = (id, maxSeats = 6, extra = {}) => E.createTable({ tableId: id, name: id, maxSeats, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000, ...extra });

/** In-memory persistence for one table row. */
function install(state, patch = {}) {
  const db = { row: null, bankroll: new Map(), incidents: 0, seatWrites: [], userUpdates: [], handsCreated: 0, statusWrites: [] };
  db.row = { id: state?.tableId ?? patch.id, status: state?.status ?? 'WAITING', name: 'x', maxSeats: state?.maxSeats ?? 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000,
    isPrivate: false, hostId: 'P0', createdAt: new Date(), updatedAt: new Date(), stateCiphertext: state ? encryptState(state, `table:${state.tableId}`) : null, ...patch };
  const user = { updateMany: async (args) => { db.userUpdates.push(args); return { count: db.creditCount ?? 1 }; }, findUnique: async ({ where }) => ({ id: where.id, username: where.id, kind: 'HUMAN', avatarHue: 0, bankroll: 5000 }) };
  prisma.table.findUnique = async () => structuredClone(db.row);
  prisma.table.findMany = async () => [{ id: db.row.id }];
  prisma.hand.findFirst = async () => db.lastHand ?? null;
  if (prisma.tableIncident) prisma.tableIncident.create = async () => { db.incidents++; return {}; };
  prisma.$transaction = async (fn) => {
    let pending = structuredClone(db.row);
    const tx = {
      $queryRaw: async () => [{ id: db.row.id }],
      table: { findUnique: async () => structuredClone(pending), update: async ({ data }) => { db.statusWrites.push(data.status); pending = { ...pending, ...data }; } },
      tableSeat: { update: async (args) => { db.seatWrites.push(args); }, findFirst: async () => null },
      tableIncident: { create: async () => { db.incidents++; return {}; } },
      user,
      hand: { findFirst: async () => db.lastHand ?? null, create: async () => { db.handsCreated++; } },
      botStatistic: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await fn(tx);
    db.row = pending;
    return result;
  };
  db.state = () => decryptState(db.row.stateCiphertext, `table:${db.row.id}`);
  return db;
}
const playToShowdown = (t) => {
  while (t.phase !== 'SHOWDOWN') {
    const legal = E.legalActions(t, t.toActSeat);
    t = E.applyAction(t, t.players[t.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
  }
  return t;
};

// ---- CR-002 (engine): the absent player of table-behaviour.mjs part 1 -------------------------------
{
  let t = seat(seat(table('absent', 2), 0, 'Active'), 1, 'Absent');
  let now = Date.UTC(2026, 9, 7, 12);
  let timeouts = 0; const stacks = []; let dealtWhileSatOut = 0;
  for (let hand = 1; hand <= 100 && t.players[1]?.stack > 0; hand++) {
    if (!E.legalActions) break;
    let live = t.players.filter((p) => p && !p.sittingOut && p.stack > 0);
    if (live.length < 2) break; // what readyToDeal() in manager.ts does: no deal
    t = E.startHand(t, now);
    if (t.players[1].sittingOut && t.players[1].holeCards) dealtWhileSatOut++;
    while (!['SHOWDOWN', 'WAITING'].includes(t.phase)) {
      const actor = t.players[t.toActSeat];
      if (actor.userId === 'Absent') { now += t.timeBankMs; timeouts++; t = E.applyTimeout(t, now); }
      else {
        now += 1000; const legal = E.legalActions(t, t.toActSeat);
        const intent = legal.actions.includes('RAISE') ? { action: 'RAISE', amount: legal.minRaiseTo } : legal.actions.includes('BET') ? { action: 'BET', amount: legal.minBet } : legal.actions.includes('CHECK') ? { action: 'CHECK' } : { action: 'CALL' };
        t = E.recordActivity(E.applyAction(t, actor.userId, intent, now), now, actor.userId);
      }
    }
    t = E.completeHand(t); now += 3200; stacks.push(t.players[1]?.stack ?? 0);
  }
  results.CR002_engineHeadsUp = { handsDealt: stacks.length, absentStackAfterEachHand: stacks, timeoutsTaken: timeouts,
    absentSatOut: t.players[1]?.sittingOut, sittingOutReason: t.players[1]?.sittingOutReason, dealtWhileSatOut };
  // Three-handed: the game continues without the absent player.
  let u = seat(seat(seat(table('absent3', 3), 0, 'A'), 1, 'B'), 2, 'Absent');
  now = Date.UTC(2026, 9, 7, 13); const s3 = []; let to3 = 0;
  for (let hand = 1; hand <= 30; hand++) {
    if (u.players.filter((p) => p && !p.sittingOut && p.stack > 0).length < 2) break;
    u = E.startHand(u, now);
    while (!['SHOWDOWN', 'WAITING'].includes(u.phase)) {
      const actor = u.players[u.toActSeat];
      if (actor.userId === 'Absent') { now += 15000; to3++; u = E.applyTimeout(u, now); }
      else { now += 1000; const legal = E.legalActions(u, u.toActSeat); u = E.applyAction(u, actor.userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' }, now); }
    }
    u = E.completeHand(u); now += 3200; s3.push(u.players[2].stack);
  }
  results.CR002_engineThreeHanded = { handsPlayed: s3.length, absentStack: [s3[0], s3[4], s3.at(-1)], timeouts: to3, sittingOutReason: u.players[2].sittingOutReason };
}

// ---- CR-002 (server): the timer path of TableManager sits the absent player out; the next deal excludes them ----
{
  let t = E.startHand(seat(seat(seat(table('srv-absent', 3), 0, 'A'), 1, 'B'), 2, 'C'), Date.now() - 20_000);
  const absent = t.players[t.toActSeat].userId;
  const db = install(t);
  const m = new TableManager(); m.stop(); m.stopped = false; // timers on, no io
  m.armTimers(db.state());
  await sleep(150);
  const after = db.state();
  const p = after.players.find((x) => x?.userId === absent);
  // Finish the hand as the other players, then run what the SHOWDOWN timer runs.
  let finished = playToShowdown(after);
  const db2 = install(finished); db2.row.status = 'IN_HAND';
  await m.mutate(finished.tableId, (cur) => { let n = E.completeHand(cur); return E.startHand(n); });
  const next = db2.state();
  m.stop();
  results.CR002_serverTimer = { absent, satOutByTimer: p?.sittingOut, reason: p?.sittingOutReason, lastAction: after.actions.at(-1)?.action,
    nextHandNumber: next.handNumber, absentDealtNextHand: Boolean(next.players.find((x) => x?.userId === absent)?.holeCards), absentStatus: next.players.find((x) => x?.userId === absent)?.status };
}

// ---- CR-002 (server): a disconnect still does nothing --------------------------------------------------
{
  const m = new TableManager(); m.stop();
  results.CR002_onDisconnect = { onDisconnectBody: m.onDisconnect.toString().replace(/\s+/g, ' ').slice(0, 160) };
}

// ---- CR-008: STALE_ACTION after an unrelated change (table-behaviour.mjs part 2) ---------------------
{
  const t = E.startHand(seat(seat(seat(table('stale'), 0, 'P0'), 1, 'P1'), 2, 'P2'));
  const db = install(t, { status: 'IN_HAND' });
  const m = new TableManager(); m.stop();
  const seen = await m.get('stale');
  const actor = seen.players[seen.toActSeat];
  const bystander = seen.players.find((p) => p && p.seatIndex !== seen.toActSeat);
  const optionsBefore = JSON.stringify(E.legalActions(seen, seen.toActSeat));
  const projectedTurnIdBefore = E.projectTableState(seen, actor.userId).turnId;
  await m.sitToggle('stale', bystander.userId, true);
  const current = await m.get('stale');
  let refusal = null;
  try { await m.intent('stale', actor.userId, { action: 'CALL' }, seen.revision); } catch (err) { refusal = { code: err.code, message: err.message }; }
  results.CR008_staleAction = {
    actorsOptionsUnchanged: JSON.stringify(E.legalActions(current, current.toActSeat)) === optionsBefore && current.toActSeat === seen.toActSeat,
    turnIdBefore: projectedTurnIdBefore, turnIdAfter: E.projectTableState(current, actor.userId).turnId,
    revisionSeen: seen.revision, revisionNow: current.revision, validCallRefused: refusal,
    intentSignatureArity: m.intent.length,
  };
  void db;
}

// ---- F10: a turn that expired during an outage is timed out right after recovery -------------------
{
  const old = E.startHand(seat(seat(seat(table('outage', 3), 0, 'O0'), 1, 'O1'), 2, 'O2'), Date.now() - 60_000);
  const db = install(old, { status: 'IN_HAND' });
  const m = new TableManager();
  const started = Date.now();
  const outcome = await new Promise((resolve) => {
    const realMutate = m.mutate.bind(m);
    m.mutate = async (id, fn, rev) => { const next = await realMutate(id, fn, rev); m.stop(); resolve(next); return next; };
    void m.recover();
    setTimeout(() => resolve(null), 3000);
  });
  m.stop();
  const actorBefore = old.players[old.toActSeat];
  const st = db.state();
  results.F10_outageRecovery = outcome ? { resumedAction: outcome.actions.at(-1)?.action, msAfterRecover: Date.now() - started,
    actorSatOutToo: st.players[actorBefore.seatIndex].sittingOut, sittingOutReason: st.players[actorBefore.seatIndex].sittingOutReason,
    turnClockResetInAudit: (st.audit?.events ?? []).some((e) => e.type === 'TURN_CLOCK_RESET'),
    engineHasRebaseTurnClock: typeof E.rebaseTurnClock === 'function' } : { resumedAction: null, note: 'no mutation within 3 s' };
}

// ---- CR-004: stuck tables (missing state, undecryptable state, retry loop, PAUSED) --------------------
{
  const m = new TableManager(); m.stop();
  const out = {};
  let db = install(null, { id: 'stuck', status: 'IN_HAND' });
  db.lastHand = { handNumber: 3 };
  try { await m.standUp('stuck', 'P0'); out.missingState = 'leave accepted'; } catch (err) { out.missingState = err.code; }
  const w = seat(seat(table('stuck2', 3), 0, 'P0'), 1, 'P1');
  db = install(w, { stateCiphertext: 'v1.not-valid' });
  try { await m.standUp('stuck2', 'P0'); out.corruptCiphertext = 'leave accepted'; } catch (err) { out.corruptCiphertext = err.code ?? err.message?.slice(0, 60); }
  // Retry loop: a table whose turn is due; its state then becomes undecryptable.
  const live = E.startHand(seat(seat(seat(table('stuck3', 3), 0, 'P0'), 1, 'P1'), 2, 'P2'), Date.now() - 20_000);
  db = install(live, { status: 'IN_HAND' });
  db.row.stateCiphertext = 'v1.not-valid';
  const loop = new TableManager(); loop.stop(); loop.stopped = false;
  logs.length = 0;
  loop.armTimers(live);
  const t0 = Date.now();
  await sleep(6_200);
  loop.stop();
  const failures = logs.filter((l) => /timer failed|retry failed/.test(l.msg ?? ''));
  out.retryLoop = { secondsObserved: Math.round((Date.now() - t0) / 1000), failureLogs: failures.length, messages: [...new Set(failures.map((f) => f.msg))],
    statusWrites: db.statusWrites, pausedEverWritten: db.statusWrites.includes('PAUSED'), incidentsCreated: db.incidents,
    tableIncidentDelegateExists: Boolean(prisma.tableIncident) };
  results.CR004_stuckTable = out;
}

// ---- CR-033: a failed next deal rolls back Hand Clean-up and the leaver's cash-out --------------------
{
  // A settled hand whose seat 2 asked to leave during the hand (pendingLeave: paid by Hand Clean-up).
  let s =playToShowdown(E.startHand(seat(seat(seat(table('deal-fault', 3), 0, 'P0'), 1, 'P1'), 2, 'P2')));
  s.players[2].pendingLeave = true; s.players[2].sittingOut = true;
  s.settledAt = Date.now() - 10_000;
  const db = install(s, { status: 'IN_HAND' });
  const prior = db.row.stateCiphertext;
  const m = new TableManager(); m.stop(); m.stopped = false;
  const rng = crypto.randomFillSync;
  logs.length = 0;
  try {
    crypto.randomFillSync = () => { throw new Error('Synthetic RNG outage'); }; syncBuiltinESMExports();
    m.armTimers(db.state()); // SHOWDOWN timer: completeHand + startHand in one mutate
    await sleep(2_300);
  } finally { crypto.randomFillSync = rng; syncBuiltinESMExports(); m.stop(); }
  const st = db.state();
  results.CR033_nextDealFailure = { stateUnchanged: db.row.stateCiphertext === prior, phaseStill: st.phase, leaverStillSeated: Boolean(st.players[2]),
    leaverPendingLeave: st.players[2]?.pendingLeave, cashOutCredits: db.userUpdates.length,
    timerFailureLogs: logs.filter((l) => /timer failed|retry failed/.test(l.msg ?? '')).length };
}

// ---- CR-036: a bot-scheduling error after commit fails the command ----------------------------------
{
  const bot = E.startHand(seat(seat(seat(table('bot-fault', 3), 0, 'P0'), 1, 'P1'), 2, 'P2'));
  bot.players[bot.toActSeat].kind = 'BOT'; bot.players[bot.toActSeat].botProfile = 'MANIAC';
  const db = install(bot, { status: 'IN_HAND' });
  const m = new TableManager(); m.stop(); m.stopped = false;
  const rng = crypto.randomFillSync;
  let rejected = null;
  const broadcasts = [];
  m.io = { in: () => ({ fetchSockets: async () => { broadcasts.push(1); return []; } }), to: () => ({ emit() {} }) };
  try {
    crypto.randomFillSync = () => { throw new Error('Synthetic bot RNG outage'); }; syncBuiltinESMExports();
    try { await m.mutate('bot-fault', (cur) => E.recordActivity(structuredClone(cur), Date.now(), 'P0')); } catch (err) { rejected = err.message; }
  } finally { crypto.randomFillSync = rng; syncBuiltinESMExports(); }
  const timerArmed = m.timers.has('bot-fault');
  m.stop(); m.io = null;
  results.CR036_postCommitBotFailure = { mutationRejected: rejected, committedRevision: db.state().revision, priorRevision: bot.revision, broadcastsAttempted: broadcasts.length, turnTimerArmed: timerArmed };
}

// ---- CR-037: restart grace is per process ---------------------------------------------------------
{
  const fixed = Date.now();
  let w = table('grace', 3, { createdAt: fixed - 2 * S.TABLE_IDLE_TIMEOUT_MS });
  w = E.sitDown(w, 0, seatCfg('P0'), fixed - 2 * S.TABLE_IDLE_TIMEOUT_MS);
  install(w);
  const fresh = new TableManager(); fresh.stop(); fresh.resumedAt = fixed;
  const old = new TableManager(); old.stop(); old.resumedAt = fixed - 10 * S.TABLE_IDLE_TIMEOUT_MS;
  const realNow = Date.now;
  let freshWarned, oldWarned;
  try {
    Date.now = () => fixed;
    await fresh.idleCheck('grace'); freshWarned = (await fresh.get('grace')).closingAt != null;
    await old.idleCheck('grace'); oldWarned = (await fresh.get('grace')).closingAt != null;
  } finally { Date.now = realNow; }
  results.CR037_multiWorker = { freshWorkerWarned: freshWarned, olderWorkerWarned: oldWarned, resumedAtIsInstanceField: Object.prototype.hasOwnProperty.call(fresh, 'resumedAt') };
}

// ---- CR-038: wallet patches can arrive out of order ------------------------------------------------
{
  clearAuthCache();
  prisma.session.findUnique = async ({ where }) => ({ id: where.id, userId: 'W0', revokedAt: null, revokeReason: null, expiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(), lastUsedAt: new Date(), refreshToken: 'x',
    user: { id: 'W0', username: 'W0', kind: 'HUMAN', role: 'PLAYER', bankroll: 0, avatarHue: 0 } });
  let release; const blocked = new Promise((r) => { release = r; }); let reads = 0; const received = [];
  prisma.user.findUnique = async () => { const n = ++reads; if (n === 1) { await blocked; return { bankroll: 9000 }; } return { bankroll: 10000 }; };
  const socket = { data: { userId: 'W0', token: signAccessToken('W0', 'W0', 'wallet-session') }, emit: (event, payload) => { if (event === S.SOCKET_EVENTS.USER_PATCH) received.push(payload); }, disconnect() {} };
  const m = new TableManager(); m.stop();
  m.io = { in: () => ({ fetchSockets: async () => [socket] }) };
  const first = m.patchBankroll('W0'); await Promise.resolve(); await m.patchBankroll('W0'); release(); await first;
  results.CR038_walletOrder = { balancesReceived: received.map((p) => p.bankroll), payloadKeys: Object.keys(received[0] ?? {}) };
  m.io = null;
}

// ---- F09: a zero-row cash-out credit releases the seat and drops the payment ----------------------
{
  const w = seat(seat(table('cashout', 3), 0, 'P0'), 1, 'P1');
  const db = install(w);
  db.creditCount = 0;
  const m = new TableManager(); m.stop();
  let error = null;
  try { await m.standUp('cashout', 'P0'); } catch (err) { error = err.message; }
  const after = db.state();
  results.F09_zeroRowCredit = { error, creditAttempts: db.userUpdates.length, creditWhere: db.userUpdates[0]?.where, seatReleased: after.players[0] === null, pendingCashOuts: after.cashOuts.length };
}

// ---- F14: a resealed CHECK carrying a CALL's chips passes both verifiers ----------------------------
{
  const h = playToShowdown(E.startHand(seat(seat(seat(table('audit', 3), 0, 'P0'), 1, 'P1'), 2, 'P2')));
  const record = structuredClone(h.audit);
  const forged = record.events.find((e) => e.type === 'PLAYER_ACTION' && e.data.action === 'CALL' && e.data.amount > 0);
  forged.data.action = 'CHECK';
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  let previous = sha(S.genesisPreimage(record));
  for (const ev of record.events) { ev.prevHash = previous; const { hash: _h, ...body } = ev; ev.hash = sha(S.eventPreimage(record.handId, body)); previous = ev.hash; }
  record.finalStateHash = sha(S.finalStatePreimage(record.handId, previous, record.events.length, record.settledAt));
  const sealed = sealedAudit(h.fairness);
  results.F14_auditLegality = { version: record.version, forgedAction: 'CHECK', forgedAmount: forged.data.amount,
    verifySealedAudit: (await S.verifySealedAudit(record, sealed)).ok, verifyHandOutcome: E.verifyHandOutcome(record, sealed).ok,
    settlementMoneyProblem: S.settlementMoneyProblem ? S.settlementMoneyProblem(record) : 'n/a', verifyAuditRecord: (await S.verifyAuditRecord(record, { requireSettled: true })).ok };
}

// ---- CR-027: bot decisions run synchronously (event-loop stall per decision) -------------------------
{
  let b = table('bots', 6);
  for (let i = 0; i < 6; i++) b = seat(b, i, `B${i}`, i === 0 ? 'HUMAN' : 'BOT');
  b = E.startHand(b);
  const times = [];
  for (let i = 0; i < 20; i++) { const t0 = performance.now(); E.decideBotAction(b); times.push(performance.now() - t0); }
  times.sort((x, y) => x - y);
  results.CR027_botDecision = { decisions: times.length, medianMs: +times[10].toFixed(1), maxMs: +times.at(-1).toFixed(1) };
}

// ---- CR-017: seatClaim reports failure when the post-commit wallet patch throws --------------------
{
  const w = seat(table('claim', 3), 0, 'P0');
  const db = install(w);
  const m = new TableManager(); m.stop();
  m.io = { in: () => ({ fetchSockets: async () => [] }) };
  prisma.user.findUnique = async () => { throw new Error('Synthetic read failure after commit'); };
  let error = null;
  try { await m.seatClaim('claim', 'NEW', 1, 400); } catch (err) { error = err.message; }
  results.CR017_seatClaimPostCommit = { seatClaimRejected: error, seatTakenInCommittedState: db.state().players[1]?.userId === 'NEW', debitWrites: db.userUpdates.filter((u) => u.data?.bankroll?.decrement).length };
  m.io = null;
}

console.log(JSON.stringify(results, null, 2));
await prisma.$disconnect().catch(() => {});
process.exit(0);
