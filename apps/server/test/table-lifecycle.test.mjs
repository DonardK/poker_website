/**
 * Table lifecycle on the server: the empty-table rule (a host who leaves a
 * table nobody joined, the last player to leave any table), the host leaving a
 * running game, and the idle clock (5-minute warning, closure TABLE_IDLE_WARNING_MS
 * later). A human whose turn times out is sat out (reason TIMEOUT), so AFK
 * players stop being dealt in; time-outs are never activity.
 * Round 2: the idle clock follows the humans still at the table (a seat
 * claimed and left, or a bot's actions, never extend it), a restart never
 * counts downtime as inactivity, seated players are told when a warning
 * starts or ends wherever they are in the app, and a join or command racing
 * the closure is told TABLE_CLOSED (SERVER_ERROR names the table).
 *
 * Persistence is an in-memory stand-in for Prisma with the same transaction
 * boundary as the real database: every `$transaction` works on a private copy
 * that is committed only when the callback succeeds, and transactions run one
 * at a time (the row lock). No real database, accounts or chips are touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { applyAction, beginIdleWarning, completeHand, createTable, EngineError, leaveSeat, legalActions, recordActivity, sitDown, sitOut, startHand } from '@poker/engine';
import { SOCKET_EVENTS, TABLE_IDLE_TIMEOUT_MS, TABLE_IDLE_WARNING_MS } from '@poker/shared';
import { prisma } from '../dist/db/prisma.js';
import { TableManager, tableManager } from '../dist/game/manager.js';
import { encryptState, decryptState } from '../dist/game/encryption.js';
import { upgradeStoredTableState } from '../dist/game/legacy.js';
import { regulatorVerification, sealedAuditContext } from '../dist/game/audit.js';
import { signAccessToken } from '../dist/auth/jwt.js';
import { createSocketServer } from '../dist/socket/index.js';
import { env } from '../dist/config.js';

const T = 'lifecycle-test';
const ROOM = `table:${T}`;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const IDLE = TABLE_IDLE_TIMEOUT_MS;
const WARNING = TABLE_IDLE_WARNING_MS;
const HAND_BREAK = 3_200;
const START_BANKROLL = 9_000;
const USERS = { 'player-0': 'Player-0', 'player-1': 'Player-1', 'player-2': 'Player-2', newcomer: 'Newcomer', watcher: 'Watcher' };
const BOTS = { 'bot-1': 'Bot_Alice' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config = (overrides = {}) => ({ tableId: T, name: 'Lifecycle', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000, ...overrides });
/** Humans player-0.. in seats 0.., seated when the table was created (their own idle clocks start there too). */
function seatPlayers(table, count, buyIn = 1000, at = table.lastActivityAt) {
  for (let seat = 0; seat < count; seat++) {
    table = sitDown(table, seat, { userId: `player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn, avatarHue: 0 }, at);
  }
  return table;
}
const seatBot = (table, seat, at = table.lastActivityAt) =>
  sitDown(table, seat, { userId: 'bot-1', username: 'Bot_Alice', kind: 'BOT', botProfile: 'TAG', buyIn: 1000, avatarHue: 0 }, at);
/** The state as if the table and every seated player last acted at `ms` (timer tests arm states directly). */
const lastActive = (state, ms) => ({ ...state, lastActivityAt: ms, players: state.players.map((p) => p && { ...p, lastActivityAt: ms }) });
/** The shape stored before the idle clock existed: no table or player clocks, no warning, no close reason. */
const legacyOf = (state) => {
  const copy = structuredClone(state);
  delete copy.lastActivityAt; delete copy.closingAt; delete copy.closeReason;
  for (const p of copy.players) if (p) delete p.lastActivityAt;
  return copy;
};
const passive = (_t, legal) => ({ action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
const actorId = (s) => s.players[s.toActSeat].userId;
function playOut(table, choose = passive) {
  for (let n = 0; table.phase !== 'SHOWDOWN'; n++) {
    assert.ok(n < 200, 'the hand ends');
    table = applyAction(table, actorId(table), choose(table, legalActions(table, table.toActSeat)));
  }
  return table;
}
/** TableSeat rows exactly as TableManager.persistSeats writes them. */
const seatRow = (p, seatIndex) => p
  ? { seatIndex, userId: p.userId, status: p.sittingOut ? 'SIT_OUT' : 'OCCUPIED', playerKind: p.kind, botProfile: p.botProfile, stack: p.stack, sittingOut: p.sittingOut }
  : { seatIndex, userId: null, status: 'EMPTY', playerKind: 'HUMAN', botProfile: null, stack: 0, sittingOut: false };
const seatsOf = (state) => state.players.map((p, seatIndex) => seatRow(p, seatIndex));
/** A brand-new table as POST /api/tables creates it: the host in seat 0, no stored state. */
const hostOnlySeats = (stack = 1000) => Array.from({ length: 6 }, (_, seatIndex) => seatIndex === 0 ? seatRow({ userId: 'player-0', kind: 'HUMAN', botProfile: null, stack, sittingOut: false }, 0) : seatRow(null, seatIndex));
const pick = (value, select) => select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, value[key]])) : value;

/**
 * In-memory persistence boundary. Reads outside a transaction see committed
 * data; a transaction's writes are committed only if its callback succeeds.
 * `log` records committed hand rows, wallet credits and table-row updates.
 */
function database(t, { state = null, row = {}, seats = null, bankrolls = {} } = {}) {
  const users = Object.fromEntries([
    ...Object.entries(USERS).map(([id, username]) => [id, { id, username, kind: 'HUMAN', avatarHue: 0, bankroll: bankrolls[id] ?? START_BANKROLL }]),
    ...Object.entries(BOTS).map(([id, username]) => [id, { id, username, kind: 'BOT', avatarHue: 0, bankroll: 0 }]),
  ]);
  let store = { row: null, seats: [], users, hands: [] };
  const log = { hands: [], cashOuts: [], tableUpdates: [] };
  const setState = (next, rowPatch = {}, seatRows = null) => {
    store.row = {
      id: T, name: 'Lifecycle', status: next ? next.status : 'WAITING', isPrivate: false, hostId: 'player-0', maxSeats: 6, smallBlind: 5, bigBlind: 10,
      minBuyIn: 200, maxBuyIn: 2000, timeBankMs: next?.timeBankMs ?? 15_000, closedAt: null, stateCiphertext: next ? encryptState(next, `table:${T}`) : null, ...rowPatch,
    };
    store.seats = structuredClone(seatRows ?? (next ? seatsOf(next) : []));
  };
  setState(state, row, seats);
  const api = (s, pending) => ({
    table: {
      findUnique: async ({ where }) => where.id === s.row.id ? structuredClone(s.row) : null,
      findMany: async ({ where }) => where.status.in.includes(s.row.status) ? [{ id: s.row.id }] : [],
      update: async ({ where, data }) => { assert.equal(where.id, s.row.id); s.row = { ...s.row, ...data }; pending.tableUpdates.push(data); return s.row; },
    },
    tableSeat: {
      findMany: async () => s.seats.map((seat) => ({ ...structuredClone(seat), user: seat.userId ? structuredClone(s.users[seat.userId]) : null })),
      findFirst: async ({ where }) => s.seats.find((seat) => seat.userId === where.userId && (where.tableId === undefined || where.tableId === s.row.id)) ?? null,
      findUnique: async ({ where }) => s.seats.some((seat) => seat.userId === where.userId) ? { tableId: s.row.id } : null,
      update: async ({ where, data }) => { const i = where.tableId_seatIndex.seatIndex; s.seats[i] = { ...s.seats[i], seatIndex: i, ...data }; return data; },
    },
    user: {
      findUnique: async ({ where, select }) => s.users[where.id] ? pick(structuredClone(s.users[where.id]), select) : null,
      updateMany: async ({ where, data }) => {
        const user = s.users[where.id];
        if (!user || (where.kind && user.kind !== where.kind) || (where.bankroll && user.bankroll < where.bankroll.gte)) return { count: 0 };
        if ('increment' in data.bankroll) { user.bankroll += data.bankroll.increment; pending.cashOuts.push({ userId: where.id, stack: data.bankroll.increment }); }
        else user.bankroll -= data.bankroll.decrement;
        return { count: 1 };
      },
    },
    session: { findUnique: async ({ where }) => s.users[where.id] ? { userId: where.id, expiresAt: new Date(Date.now() + 60_000), user: structuredClone(s.users[where.id]) } : null },
    hand: {
      findFirst: async () => s.hands.at(-1) ?? null,
      create: async ({ data }) => { s.hands.push({ handNumber: data.handNumber }); pending.hands.push(data); return data; },
    },
    botStatistic: { updateMany: async () => ({ count: 0 }) },
  });
  // Prisma delegates expose methods through a Proxy without method descriptors.
  const replace = (target, name, implementation) => {
    const original = target[name]; target[name] = implementation;
    t.after(() => { target[name] = original; });
  };
  const readOnly = { hands: [], cashOuts: [], tableUpdates: [] };
  for (const [delegate, methods] of Object.entries({ table: ['findUnique', 'findMany'], tableSeat: ['findMany', 'findFirst', 'findUnique'], user: ['findUnique'], session: ['findUnique'], hand: ['findFirst'] })) {
    for (const method of methods) replace(prisma[delegate], method, (args) => api(store, readOnly)[delegate][method](args));
  }
  let lock = Promise.resolve();
  replace(prisma, '$transaction', (run) => {
    const attempt = lock.then(async () => {
      const draft = structuredClone(store);
      const pending = { hands: [], cashOuts: [], tableUpdates: [] };
      const result = await run({ $queryRaw: async () => [{ id: draft.row.id }], ...api(draft, pending) });
      store = draft;
      for (const key of Object.keys(log)) log[key].push(...pending[key]);
      return result;
    });
    lock = attempt.catch(() => {});
    return attempt;
  });
  return {
    log, setState,
    row: () => store.row,
    state: () => decryptState(store.row.stateCiphertext, `table:${T}`),
    seats: () => store.seats,
    bankroll: (id) => store.users[id].bankroll,
    /** Wallets plus chips still at the table (stored stacks and unsettled bets). */
    chips: (ids) => ids.reduce((sum, id) => sum + store.users[id].bankroll, 0) + (store.row.stateCiphertext
      ? decryptState(store.row.stateCiphertext, `table:${T}`).players.reduce((sum, p) => sum + (p ? p.stack + p.committedThisHand : 0), 0) : 0),
  };
}

/**
 * Socket.io stand-in: authenticated viewers in the table room, user rooms, and socketsLeave.
 * Private events (USER_PATCH, TABLE_IDLE_NOTICE) go through notifyUser, which
 * re-validates each socket in user:<id>: every human has one signed-in socket
 * there, and what it receives is recorded against the room name.
 */
function room() {
  const events = [];
  const viewers = new Map();
  const userSocket = (name) => {
    const userId = name.slice('user:'.length);
    return {
      data: { userId, token: signAccessToken(userId, USERS[userId], userId) },
      emit: (event, payload) => events.push({ to: name, event, payload }),
      disconnect: () => events.push({ to: name, event: 'disconnect' }),
    };
  };
  const io = {
    in: (name) => ({
      fetchSockets: async () => name === ROOM ? [...viewers.values()] : name.startsWith('user:') && USERS[name.slice('user:'.length)] ? [userSocket(name)] : [],
      socketsLeave: (left) => { events.push({ to: name, event: 'socketsLeave', payload: left }); if (name === ROOM) viewers.clear(); },
    }),
    to: (name) => ({ emit: (event, payload) => events.push({ to: name, event, payload }) }),
  };
  return {
    io, events,
    watch: (userId) => viewers.set(userId, {
      data: { userId, token: signAccessToken(userId, USERS[userId], userId) },
      emit: (event, payload) => events.push({ to: userId, event, payload }),
      disconnect: () => events.push({ to: userId, event: 'disconnect' }),
    }),
    snapshots: (userId) => events.filter((e) => e.event === SOCKET_EVENTS.STATE_SNAPSHOT && e.to === userId).map((e) => e.payload),
    patches: (userId) => events.filter((e) => e.event === SOCKET_EVENTS.USER_PATCH && e.to === `user:${userId}`).map((e) => e.payload),
    /** Every TABLE_IDLE_NOTICE sent, with the room it went to. */
    notices: () => events.filter((e) => e.event === SOCKET_EVENTS.TABLE_IDLE_NOTICE).map(({ to, payload }) => ({ to, ...payload })),
  };
}

/**
 * A TableManager whose asynchronous work can be awaited: `settle` waits until
 * every mutation and load started by a timer has finished, and `advance`
 * moves the mocked clock in steps so timers armed after a commit also fire.
 */
function managerFor(t, io = null) {
  const manager = new TableManager();
  manager.io = io;
  t.after(() => manager.stop());
  const pending = new Set();
  for (const name of ['mutate', 'get']) {
    const original = manager[name].bind(manager);
    manager[name] = (...args) => { const p = original(...args); pending.add(p); const done = () => pending.delete(p); p.then(done, done); return p; };
  }
  const settle = async () => {
    for (let quiet = 0; quiet < 3;) {
      if (pending.size) { quiet = 0; await Promise.allSettled([...pending]); } else { quiet += 1; await new Promise((resolve) => setImmediate(resolve)); }
    }
  };
  const advance = async (ms, step = 1_000) => {
    for (let left = ms; left > 0; left -= step) { t.mock.timers.tick(Math.min(step, left)); await settle(); }
  };
  return { manager, settle, advance };
}
const mockClock = (t, now = NOW) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** Human actions through the manager (activity) until `done`. */
async function actUntil(db, manager, done, { choose = passive, never = null } = {}) {
  for (let n = 0; !done(db.state()); n++) {
    assert.ok(n < 100, 'the hand ends');
    const s = db.state();
    if (never) assert.notEqual(actorId(s), never, `${never} never acts`);
    await manager.intent(T, actorId(s), choose(s, legalActions(s, s.toActSeat)), s.revision);
  }
}

/** The regulator's verification of every recorded hand, chained as the regulator route links them. */
async function verifyRecordedHands(hands, previous = null) {
  for (const data of hands) {
    const row = { tableId: data.tableId, handNumber: data.handNumber, handUuid: data.handUuid, deckCommitment: data.deckCommitment, finalStateHash: data.finalStateHash };
    const sealed = decryptState(data.auditSealed, sealedAuditContext(data.tableId, data.handNumber));
    const report = await regulatorVerification(row, JSON.parse(JSON.stringify(data.auditRecord)), sealed, previous);
    assert.equal(report.ok, true, `hand #${data.handNumber}: ${report.reason}`);
    previous = { handNumber: data.handNumber, finalStateHash: data.finalStateHash };
  }
}

function assertClosed(db, { reason, at }) {
  const row = db.row();
  assert.equal(row.status, 'CLOSED');
  assert.ok(row.closedAt instanceof Date, 'closedAt is written');
  assert.equal(row.closedAt.getTime(), at);
  const state = db.state();
  assert.equal(state.status, 'CLOSED'); assert.equal(state.closeReason, reason); assert.equal(state.closingAt, null);
  assert.ok(state.players.every((p) => p === null), 'every seat released');
  assert.deepEqual(state.cashOuts, [], 'stored with no cash-out pending');
  assert.ok(db.seats().every((seat) => seat.userId === null && seat.status === 'EMPTY'), 'every TableSeat row released');
  assert.ok(state.log.some((entry) => entry.text === 'Table closed'));
}
/** Final snapshot to every viewer, then the room is emptied; the table's timers are gone. */
function assertRoomClosed(viewers, manager, userIds, reason) {
  for (const userId of userIds) {
    const last = viewers.snapshots(userId).at(-1);
    assert.equal(last.status, 'CLOSED'); assert.equal(last.closeReason, reason); assert.equal(last.closingInMs, null);
    assert.ok(last.players.every((p) => p.userId === ''), 'the final snapshot shows no one seated');
  }
  const leave = viewers.events.findIndex((e) => e.event === 'socketsLeave');
  assert.ok(leave >= 0, 'sockets leave the room');
  assert.deepEqual(viewers.events[leave], { to: ROOM, event: 'socketsLeave', payload: ROOM });
  assert.ok(viewers.events.slice(leave + 1).every((e) => e.event !== SOCKET_EVENTS.STATE_SNAPSHOT), 'nothing is broadcast after the room is emptied');
  for (const map of ['timers', 'idleTimers', 'armedRevision', 'idleArmed']) assert.equal(manager[map].has(T), false, `${map} disposed`);
}

// ---------------------------------------------------------------------------
// Empty tables and the host leaving
// ---------------------------------------------------------------------------

test('host alone leaves a table nobody joined: CLOSED (EMPTY) in the same commit, closedAt written, buy-in refunded once, final state then room emptied', async (t) => {
  mockClock(t);
  const db = database(t, { row: { status: 'WAITING', createdAt: new Date(NOW), updatedAt: new Date(NOW) }, seats: hostOnlySeats(), bankrolls: { 'player-0': 9_000 } });
  const viewers = room(); viewers.watch('player-0'); viewers.watch('watcher');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);
  assert.deepEqual(manager.idleArmed.get(T), { revision: 0, deadline: NOW + IDLE }, 'the idle clock runs from creation');

  assert.equal(await manager.standUp(T, 'player-0'), false, 'left at once, nothing pending');
  assertClosed(db, { reason: 'EMPTY', at: NOW });
  assert.equal(db.log.tableUpdates.length, 1, 'the leave, the cash-out and the closure are one commit');
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-0', stack: 1000 }]);
  assert.equal(db.bankroll('player-0'), 10_000);
  assert.deepEqual(viewers.patches('player-0'), [{ bankroll: 10_000, cashOutTableId: T }], 'no tableClosedReason for a player who left');
  assertRoomClosed(viewers, manager, ['player-0', 'watcher'], 'EMPTY');

  // Closed is final: nothing loads, nothing is paid again, no timer revives it.
  // A command that comes too late is told the table closed.
  await assert.rejects(manager.standUp(T, 'player-0'), { code: 'TABLE_CLOSED', message: 'This table has closed' });
  await assert.rejects(manager.seatClaim(T, 'newcomer', 1, 1000), { code: 'TABLE_CLOSED' });
  await assert.rejects(manager.keepAlive(T, 'player-0'), { code: 'TABLE_CLOSED' });
  assert.equal(await manager.snapshot(T, 'player-0'), null);
  await manager.track(T);
  await advance(IDLE + WARNING, 10_000);
  assert.equal(db.log.tableUpdates.length, 1);
  assert.equal(db.bankroll('player-0'), 10_000);
  assert.equal(db.bankroll('newcomer'), START_BANKROLL, 'no buy-in was taken at a closed table');
});

test('host leaves between hands with two others seated: cashed out, the table stays open and keeps dealing', async (t) => {
  mockClock(t);
  const between = completeHand(playOut(startHand(seatPlayers(createTable(config({ createdAt: NOW })), 3))));
  const hostStack = between.players[0].stack;
  const db = database(t, { state: between });
  const viewers = room(); viewers.watch('player-1');
  const { manager, advance } = managerFor(t, viewers.io);

  assert.equal(await manager.standUp(T, 'player-0'), false);
  assert.equal(db.bankroll('player-0'), START_BANKROLL + hostStack);
  assert.deepEqual(viewers.patches('player-0'), [{ bankroll: START_BANKROLL + hostStack, cashOutTableId: T }]);
  assert.equal(db.row().status, 'WAITING'); assert.equal(db.row().closedAt, null);
  assert.equal(db.state().players[0], null); assert.equal(db.state().closeReason, null);

  await advance(100, 100);
  let s = db.state();
  assert.equal(s.handNumber, 2, 'the next hand is dealt without the host');
  assert.equal(s.status, 'IN_HAND');
  assert.deepEqual([...s.dealtSeats].sort(), [1, 2]);
  await actUntil(db, manager, (st) => st.phase === 'SHOWDOWN', { never: 'player-0' });
  await advance(HAND_BREAK, HAND_BREAK);
  s = db.state();
  assert.equal(s.handNumber, 3, 'and the one after it');
  assert.deepEqual([...s.dealtSeats].sort(), [1, 2]);
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [2]);
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-0', stack: hostStack }], 'the host was paid exactly once');
  assert.equal(db.chips(['player-0', 'player-1', 'player-2']), 3 * START_BANKROLL + 3000, 'chips conserved');
});

test('host leaves mid-hand with two others: the hand finishes and is recorded, the host is paid once at clean-up, the next hand is dealt', async (t) => {
  mockClock(t);
  const db = database(t, { state: startHand(seatPlayers(createTable(config({ createdAt: NOW })), 3)) });
  const viewers = room();
  const { manager, advance } = managerFor(t, viewers.io);

  assert.equal(await manager.standUp(T, 'player-0'), true, 'dealt in: leaves at the end of the hand');
  assert.equal(db.state().players[0].pendingLeave, true);
  assert.equal(db.bankroll('player-0'), START_BANKROLL);
  await actUntil(db, manager, (s) => s.phase === 'SHOWDOWN', { never: 'player-0' });
  const settled = db.state();
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [1], 'the hand is recorded once');
  assert.ok(db.log.hands[0].players.create.some((p) => p.userId === 'player-0'), 'the host is in the hand history');
  await verifyRecordedHands(db.log.hands);
  assert.deepEqual(db.log.cashOuts, [], 'nobody is paid before Hand Clean-up');

  await advance(HAND_BREAK, HAND_BREAK);
  const s = db.state();
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-0', stack: settled.players[0].stack }]);
  assert.equal(db.bankroll('player-0'), START_BANKROLL + settled.players[0].stack);
  assert.equal(s.players[0], null);
  assert.equal(s.handNumber, 2); assert.equal(s.status, 'IN_HAND'); assert.deepEqual([...s.dealtSeats].sort(), [1, 2]);
  assert.equal(db.row().status, 'IN_HAND');
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [1], 'the settled hand is not recorded again');
  // Leaving again pays nothing.
  const writes = db.log.tableUpdates.length;
  assert.equal(await manager.standUp(T, 'player-0'), false);
  assert.equal(db.log.tableUpdates.length, writes);
  assert.equal(db.chips(['player-0', 'player-1', 'player-2']), 3 * START_BANKROLL + 3000, 'chips conserved');
});

test('heads-up: the host leaves mid-hand and the table stays open; when the last player leaves it closes', async (t) => {
  mockClock(t);
  const db = database(t, { state: startHand(seatPlayers(createTable(config({ createdAt: NOW })), 2)) });
  const viewers = room(); viewers.watch('player-1');
  const { manager, advance } = managerFor(t, viewers.io);

  assert.equal(await manager.standUp(T, 'player-0'), true);
  await actUntil(db, manager, (s) => s.phase === 'SHOWDOWN', { never: 'player-0' });
  const settled = db.state();
  await advance(HAND_BREAK, HAND_BREAK);
  let s = db.state();
  assert.equal(s.players[0], null); assert.equal(s.players[1].userId, 'player-1');
  assert.equal(s.phase, 'WAITING'); assert.equal(s.closeReason, null);
  assert.equal(db.row().status, 'WAITING', 'one player left: open, waiting for opponents');
  assert.equal(db.bankroll('player-0'), START_BANKROLL + settled.players[0].stack);

  assert.equal(await manager.standUp(T, 'player-1'), false);
  assertClosed(db, { reason: 'EMPTY', at: NOW + HAND_BREAK });
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-0', stack: settled.players[0].stack }, { userId: 'player-1', stack: settled.players[1].stack }]);
  assert.equal(db.bankroll('player-0') + db.bankroll('player-1'), 2 * START_BANKROLL + 2000, 'chips conserved');
  assertRoomClosed(viewers, manager, ['player-1'], 'EMPTY');
  assert.deepEqual(viewers.patches('player-1'), [{ bankroll: START_BANKROLL + settled.players[1].stack, cashOutTableId: T }]);
});

// ---------------------------------------------------------------------------
// Idle clock
// ---------------------------------------------------------------------------

test('idle: warning at exactly 5 minutes, closure (IDLE) TABLE_IDLE_WARNING_MS later, chips returned once with tableClosedReason', async (t) => {
  mockClock(t);
  const db = database(t, { row: { status: 'WAITING', createdAt: new Date(NOW), updatedAt: new Date(NOW) }, seats: hostOnlySeats() });
  const viewers = room(); viewers.watch('player-0'); viewers.watch('watcher');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);

  await advance(IDLE - 1);
  assert.equal(db.row().stateCiphertext, null, 'nothing is written while the clock runs');
  assert.equal(db.log.tableUpdates.length, 0);
  await advance(1);
  let s = db.state();
  assert.equal(s.closingAt, NOW + IDLE + WARNING);
  assert.equal(s.lastActivityAt, NOW, 'the clock started at creation');
  assert.equal(s.closeReason, null);
  assert.equal(s.log.at(-1).text, `No activity for ${IDLE / 60_000} minutes — the table closes in ${WARNING / 1_000} seconds unless a player acts`);
  for (const viewer of ['player-0', 'watcher']) {
    const snap = viewers.snapshots(viewer).at(-1);
    assert.equal(snap.closingInMs, WARNING); assert.equal(snap.closeReason, null); assert.equal(snap.status, 'WAITING');
    assert.equal('lastActivityAt' in snap || 'closingAt' in snap, false, 'the idle clock itself is never sent');
  }

  await advance(WARNING - 1);
  assert.equal(db.row().status, 'WAITING');
  assert.equal(db.bankroll('player-0'), START_BANKROLL);
  await advance(1);
  assertClosed(db, { reason: 'IDLE', at: NOW + IDLE + WARNING });
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-0', stack: 1000 }]);
  assert.equal(db.bankroll('player-0'), START_BANKROLL + 1000);
  assert.deepEqual(viewers.patches('player-0'), [{ bankroll: START_BANKROLL + 1000, cashOutTableId: T, tableClosedReason: 'IDLE' }]);
  assertRoomClosed(viewers, manager, ['player-0', 'watcher'], 'IDLE');
  const writes = db.log.tableUpdates.length;
  await advance(2 * IDLE, 10_000);
  assert.equal(db.log.tableUpdates.length, writes, 'a closed table is never touched again');
  assert.equal(db.bankroll('player-0'), START_BANKROLL + 1000);
});

test('idle: "I\'m still here" from a seated player cancels the warning and restarts the clock; spectators cannot', async (t) => {
  mockClock(t);
  const db = database(t, { state: seatPlayers(createTable(config({ createdAt: NOW })), 1) });
  const viewers = room(); viewers.watch('watcher');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);
  await advance(IDLE);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING);

  await assert.rejects(manager.keepAlive(T, 'watcher'), { code: 'NOT_SEATED' });
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING, 'a spectator cannot hold the table open');
  await advance(4_000);
  await manager.keepAlive(T, 'player-0');
  let s = db.state();
  assert.equal(s.closingAt, null);
  assert.equal(s.lastActivityAt, NOW + IDLE + 4_000);
  assert.equal(s.log.at(-1).text, 'Player-0 is back — the table stays open');
  assert.equal(viewers.snapshots('watcher').at(-1).closingInMs, null);

  await advance(WARNING);
  assert.equal(db.row().status, 'WAITING', 'the old deadline passes without closure');
  const revision = db.state().revision;
  await manager.keepAlive(T, 'player-0');
  assert.equal(db.state().revision, revision, 'no warning: nothing changes, no new revision');

  // The next warning comes 5 minutes after the keep-alive.
  await advance(IDLE - WARNING - 4_000 - 1 + 4_000);
  assert.equal(db.state().closingAt, null);
  await advance(1);
  s = db.state();
  assert.equal(s.closingAt, NOW + IDLE + 4_000 + IDLE + WARNING);
  assert.equal(db.bankroll('player-0'), START_BANKROLL);
});

test('idle: a real sit-out/sit-in and a seat claim are activity; a repeated toggle is not; a hand is dealt once the warning is gone', async (t) => {
  mockClock(t);
  const db = database(t, { state: seatPlayers(createTable(config({ createdAt: NOW })), 1), bankrolls: { newcomer: 9_000 } });
  const { manager, advance } = managerFor(t, room().io);
  await manager.track(T);
  await advance(IDLE);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING);

  let revision = db.state().revision;
  await manager.sitToggle(T, 'player-0', false);
  assert.equal(db.state().revision, revision, 'sitting in while seated in changes nothing');
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING, 'and is not activity');
  await manager.sitToggle(T, 'player-0', true);
  assert.equal(db.state().closingAt, null, 'a real sit-out is activity');
  assert.equal(db.state().lastActivityAt, NOW + IDLE);
  assert.equal(db.state().players[0].lastActivityAt, NOW + IDLE, 'the player\'s own activity');
  revision = db.state().revision;
  await manager.sitToggle(T, 'player-0', true);
  assert.equal(db.state().revision, revision, 'a repeated sit-out changes nothing');

  await advance(IDLE);
  assert.equal(db.state().closingAt, NOW + 2 * IDLE + WARNING, 'warned again 5 minutes after the sit-out');
  await manager.seatClaim(T, 'newcomer', 1, 1000);
  let s = db.state();
  assert.equal(s.closingAt, null, 'taking a seat cancels the warning');
  assert.equal(s.lastActivityAt, NOW + 2 * IDLE);
  assert.equal(s.players[1].userId, 'newcomer');
  assert.equal(db.bankroll('newcomer'), 8_000);
  await advance(100, 100);
  assert.equal(db.state().handNumber, 0, 'player-0 is sitting out');
  await manager.sitToggle(T, 'player-0', false);
  assert.equal(db.state().lastActivityAt, NOW + 2 * IDLE + 100, 'a real sit-in is activity');
  assert.equal(db.state().players[0].lastActivityAt, NOW + 2 * IDLE + 100);
  await advance(100, 100);
  s = db.state();
  assert.equal(s.handNumber, 1); assert.deepEqual([...s.dealtSeats].sort(), [0, 1]);
});

test('idle: a player\'s own action during the warning cancels it; time-outs neither cancel it nor restart the clock; the hand is untouched by the warning', async (t) => {
  mockClock(t);
  const hand = startHand(seatPlayers(createTable(config({ createdAt: NOW - IDLE, timeBankMs: 5_000 })), 3));
  const db = database(t, { state: hand });
  const { manager, advance } = managerFor(t, room().io);
  await manager.track(T);
  await advance(1);
  let s = db.state();
  assert.equal(s.closingAt, NOW + 1 + WARNING);
  for (const key of ['phase', 'toActSeat', 'turnStartedAt', 'actions', 'audit', 'players', 'pots', 'handNumber', 'deck']) assert.deepEqual(s[key], hand[key], `${key} unchanged by the warning`);

  await advance(5_000);
  s = db.state();
  assert.equal(s.actions.at(-1).action, 'TIMEOUT_FOLD', 'the first actor timed out');
  assert.equal(s.closingAt, NOW + 1 + WARNING, 'a time-out does not cancel the warning');
  assert.equal(s.lastActivityAt, NOW - IDLE, 'nor restart the clock');
  assert.equal(s.phase, 'PREFLOP');

  const actor = s.toActSeat;
  await manager.intent(T, actorId(s), { action: 'CALL' }, s.revision);
  s = db.state();
  assert.equal(s.closingAt, null, 'acting cancels the warning');
  assert.equal(s.lastActivityAt, NOW + 5_001);
  assert.equal(s.players[actor].lastActivityAt, NOW + 5_001, 'the actor\'s own clock restarts');
  assert.equal(manager.idleArmed.get(T).deadline, NOW + 5_001 + IDLE, 'so the table is timed from the action');
  await advance(WARNING);
  assert.notEqual(db.row().status, 'CLOSED');
  assert.equal(db.state().closeReason, null);
});

test('idle: a warning stops the next deal (the SHOWDOWN timer only cleans up); closure between hands cashes everyone out at once', async (t) => {
  mockClock(t);
  const settled = playOut(startHand(seatPlayers(createTable(config({ createdAt: NOW - IDLE })), 2)));
  const db = database(t, { state: settled });
  const viewers = room(); viewers.watch('player-0');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);
  await advance(1);
  assert.equal(db.state().closingAt, NOW + 1 + WARNING);

  await advance(HAND_BREAK);
  let s = db.state();
  assert.equal(s.phase, 'WAITING', 'Hand Clean-up ran');
  assert.equal(s.handNumber, 1, 'no new hand while the warning is up');
  assert.ok(s.players[0] && s.players[1], 'both players are still seated');
  const revision = s.revision;
  await manager.tryStart(T);
  assert.equal(db.state().revision, revision, 'tryStart does not deal during the warning');
  assert.deepEqual(db.log.hands, [], 'the stored hand had already been recorded when it settled');

  await advance(WARNING - HAND_BREAK);
  assertClosed(db, { reason: 'IDLE', at: NOW + 1 + WARNING });
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-0', stack: settled.players[0].stack }, { userId: 'player-1', stack: settled.players[1].stack }]);
  assert.equal(db.bankroll('player-0') + db.bankroll('player-1'), 2 * START_BANKROLL + 2000, 'chips conserved');
  assert.deepEqual(viewers.patches('player-1'), [{ bankroll: START_BANKROLL + settled.players[1].stack, cashOutTableId: T, tableClosedReason: 'IDLE' }]);
  assertRoomClosed(viewers, manager, ['player-0'], 'IDLE');
  s = db.state();
  assert.equal(s.handNumber, 1);
});

test('idle: AFK players are sat out by their first time-out (no more hands dealt), warned at exactly 5 minutes and closed; every hand recorded and verified once, everyone paid once', async (t) => {
  mockClock(t);
  const ids = ['player-0', 'player-1', 'player-2'];
  const db = database(t, { state: startHand(seatPlayers(createTable(config({ createdAt: NOW })), 3)) });
  const viewers = room(); for (const id of ids) viewers.watch(id);
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);

  for (let second = 1; second < IDLE / 1000; second++) {
    await advance(1_000);
    const s = db.state();
    assert.equal(s.lastActivityAt, NOW, `time-outs are not activity (t=${second}s)`);
    assert.ok(s.players.every((p) => p === null || p.lastActivityAt === NOW), `nor any player's own activity (t=${second}s)`);
    assert.equal(s.closingAt, null, `no warning before 5 minutes (t=${second}s)`);
  }
  await advance(1_000);
  let s = db.state();
  assert.equal(s.closingAt, NOW + IDLE + WARNING);
  // Hand 1 was played out by time-outs; each human who timed out was sat out
  // (reason TIMEOUT), which left one player sitting in, so no later hand was dealt.
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [1], 'hands stopped once the AFK players were sat out');
  assert.equal(s.handNumber, 1); assert.equal(s.phase, 'WAITING');
  const timedOut = db.log.hands[0].actions.create.filter((a) => a.action.startsWith('TIMEOUT_')).map((a) => a.seatIndex);
  assert.ok(timedOut.length >= 1, 'the hand was played by time-outs');
  assert.equal(new Set(timedOut).size, timedOut.length, 'each AFK player timed out once: the sat-out cascade acted for them afterwards');
  for (const seat of [0, 1, 2]) {
    const p = s.players[seat];
    if (timedOut.includes(seat)) { assert.equal(p.sittingOut, true, `${p.userId} sat out by the time-out`); assert.equal(p.sittingOutReason, 'TIMEOUT'); }
    else { assert.equal(p.sittingOut, false, `${p.userId} never timed out`); assert.equal(p.sittingOutReason, null); }
  }
  assert.ok(s.players.filter((p) => p && !p.sittingOut).length < 2, 'fewer than two players sitting in: nothing to deal');

  await advance(WARNING - 1);
  assert.equal(db.row().status, 'WAITING');
  assert.deepEqual(db.log.cashOuts, []);
  await advance(1);
  assertClosed(db, { reason: 'IDLE', at: NOW + IDLE + WARNING });
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [1], 'every hand recorded exactly once');
  await verifyRecordedHands(db.log.hands);
  assert.deepEqual(db.log.cashOuts.map((c) => c.userId).sort(), ids, 'every player paid exactly once');
  assert.equal(ids.reduce((sum, id) => sum + db.bankroll(id), 0), 3 * START_BANKROLL + 3000, 'chips conserved');
  for (const id of ids) assert.deepEqual(viewers.patches(id), [{ bankroll: db.bankroll(id), cashOutTableId: T, tableClosedReason: 'IDLE' }]);
  assertRoomClosed(viewers, manager, ids, 'IDLE');
});

test('idle closure mid-hand (flop, facing a bet, a leaver and a newcomer): the hand is settled and recorded once, verified, and each player paid exactly once', async (t) => {
  mockClock(t);
  // A turn clock longer than the warning: the closure, not a time-out, settles the hand.
  const timeBankMs = 2 * WARNING;
  let s = startHand(seatPlayers(createTable(config({ createdAt: NOW - IDLE, timeBankMs })), 3));
  while (s.phase === 'PREFLOP') s = applyAction(s, actorId(s), passive(s, legalActions(s, s.toActSeat)));
  s = applyAction(s, actorId(s), { action: 'BET', amount: legalActions(s, s.toActSeat).minBet });
  const leaverSeat = s.dealtSeats.find((seat) => seat !== s.toActSeat && s.players[seat].status === 'ACTIVE');
  const leaver = s.players[leaverSeat].userId;
  s = leaveSeat(s, leaver);
  s = sitDown(s, 3, { userId: 'newcomer', username: 'Newcomer', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 }, NOW - IDLE);
  assert.equal(s.phase, 'FLOP'); assert.equal(s.players[3].holeCards, null);
  assert.ok(s.turnStartedAt + timeBankMs > NOW + 1 + WARNING, 'no turn times out before the closure');
  const ids = ['player-0', 'player-1', 'player-2', 'newcomer'];
  // Every chip in play: three players with 9,000 + 1,000 at the table, the newcomer 8,000 + 1,000.
  const total = 3 * (START_BANKROLL + 1000) + 8_000 + 1000;
  const db = database(t, { state: s, bankrolls: { newcomer: 8_000 } });
  const viewers = room(); for (const id of ids) viewers.watch(id);
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);
  await advance(1);
  assert.equal(db.state().closingAt, NOW + 1 + WARNING);

  await advance(WARNING);
  const closing = db.state();
  assert.equal(closing.phase, 'SHOWDOWN', 'the hand was settled under the sit-out rule');
  assert.equal(closing.closeReason, 'IDLE');
  assert.equal(db.row().status, 'IN_HAND', 'not closed until Hand Clean-up');
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [1], 'recorded in the transaction that settled it');
  const recorded = db.log.hands[0];
  assert.deepEqual(recorded.players.create.map((p) => p.userId).sort(), ['player-0', 'player-1', 'player-2'], 'every dealt player is in the history, including the leaver');
  const flopActions = recorded.actions.create.filter((a) => a.street === 'FLOP');
  assert.ok(flopActions.length > 1, 'the closure acted on the flop');
  assert.ok(flopActions.slice(1).every((a) => a.action === 'FOLD' || a.action === 'CHECK'), 'closure only checks or folds');
  await verifyRecordedHands(db.log.hands);
  assert.deepEqual(db.log.cashOuts, [{ userId: 'newcomer', stack: 1000 }], 'the player not dealt in is cashed out at once');
  assert.deepEqual(viewers.patches('newcomer'), [{ bankroll: 9_000, cashOutTableId: T, tableClosedReason: 'IDLE' }]);
  for (const p of closing.players.filter(Boolean)) { assert.equal(p.pendingLeave, true); assert.equal(p.sittingOut, true); }
  assert.equal(ids.reduce((sum, id) => sum + db.bankroll(id), 0) + closing.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0), total, 'chips conserved while closing');

  await advance(HAND_BREAK);
  assertClosed(db, { reason: 'IDLE', at: NOW + 1 + WARNING + HAND_BREAK });
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [1], 'the settled hand is recorded exactly once');
  assert.deepEqual(db.log.cashOuts.map((c) => c.userId).sort(), [...ids].sort(), 'each player paid exactly once');
  for (const id of ['player-0', 'player-1', 'player-2']) {
    const seat = closing.players.findIndex((p) => p?.userId === id);
    assert.equal(db.bankroll(id), START_BANKROLL + closing.players[seat].stack, `${id} gets the settled stack`);
    assert.deepEqual(viewers.patches(id), [{ bankroll: db.bankroll(id), cashOutTableId: T, tableClosedReason: 'IDLE' }]);
  }
  assert.equal(ids.reduce((sum, id) => sum + db.bankroll(id), 0), total, 'chips conserved');
  assertRoomClosed(viewers, manager, ids, 'IDLE');
  const writes = db.log.tableUpdates.length;
  await advance(IDLE + WARNING, 10_000);
  assert.equal(db.log.tableUpdates.length, writes);
  assert.equal(db.log.cashOuts.length, 4);
});

// ---------------------------------------------------------------------------
// Timers are advisory
// ---------------------------------------------------------------------------

test('idle timer: a stale lower-revision load never replaces a newer timer; a failed check retries without clobbering one; a closed table is forgotten', async (t) => {
  mockClock(t);
  const manager = new TableManager(); t.after(() => manager.stop());
  const state = { ...seatPlayers(createTable(config({ createdAt: NOW })), 1), revision: 5 };
  manager.armTimers(state);
  const first = manager.idleTimers.get(T);
  assert.ok(first);
  assert.deepEqual(manager.idleArmed.get(T), { revision: 5, deadline: NOW + IDLE });
  manager.armTimers({ ...lastActive(state, NOW - 2 * IDLE), revision: 4 });
  assert.equal(manager.idleTimers.get(T), first, 'a stale load is ignored');
  manager.armTimers({ ...state, revision: 6 });
  assert.equal(manager.idleTimers.get(T), first, 'same deadline: the pending timer is kept');
  assert.equal(manager.idleArmed.get(T).revision, 6);
  manager.armTimers({ ...lastActive(state, NOW - IDLE), revision: 5 });
  assert.equal(manager.idleTimers.get(T), first, 'older than the newest state seen');
  manager.armTimers({ ...lastActive(state, NOW + 1_000), revision: 7 });
  assert.notEqual(manager.idleTimers.get(T), first, 'activity moves the deadline');
  manager.armTimers({ ...state, revision: 8, closingAt: NOW + 5_000 });
  assert.deepEqual(manager.idleArmed.get(T), { revision: 8, deadline: NOW + 5_000 }, 'during a warning the deadline is closingAt');
  manager.armTimers({ ...state, revision: 9, closeReason: 'IDLE' });
  assert.equal(manager.idleTimers.has(T), false, 'no idle timer once closure has begun');

  let reject;
  const mutate = t.mock.method(manager, 'mutate', () => new Promise((_, fail) => { reject = fail; }));
  manager.armTimers({ ...lastActive(state, Date.now() - IDLE), revision: 10 });
  t.mock.timers.tick(1);
  assert.equal(mutate.mock.callCount(), 1, 'the due timer asks mutate to check');
  manager.armTimers({ ...lastActive(state, Date.now()), revision: 11 });
  const newer = manager.idleTimers.get(T);
  reject(new Error('database offline'));
  await flush();
  assert.equal(manager.idleTimers.get(T), newer, 'the failed check does not clobber the newer timer');

  manager.armTimers({ ...lastActive(state, Date.now() - IDLE), revision: 12 });
  t.mock.timers.tick(1);
  assert.equal(mutate.mock.callCount(), 2);
  reject(new Error('database offline'));
  await flush();
  assert.ok(manager.idleTimers.has(T), 'a retry is scheduled');
  const fresh = { ...lastActive(state, Date.now() - IDLE - 1), revision: 12 };
  const get = t.mock.method(manager, 'get', async () => fresh);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(get.mock.callCount(), 1, 'the retry reloads fresh state');
  t.mock.timers.tick(1);
  assert.equal(mutate.mock.callCount(), 3, 'and checks again');
  reject(new EngineError('TABLE_NOT_FOUND', 'Table not found'));
  await flush();
  for (const map of ['timers', 'idleTimers', 'armedRevision', 'idleArmed']) assert.equal(manager[map].has(T), false, `${map} disposed`);

  // A game timer that finds the table closed also forgets it.
  mutate.mock.mockImplementation(async () => { throw new EngineError('TABLE_NOT_FOUND', 'Table not found'); });
  const hand = { ...startHand(seatPlayers(createTable(config({ createdAt: Date.now() })), 2)), revision: 20 };
  manager.armTimers(hand);
  assert.ok(manager.timers.has(T) && manager.idleTimers.has(T));
  t.mock.timers.tick(15_000);
  await flush();
  for (const map of ['timers', 'idleTimers', 'armedRevision', 'idleArmed']) assert.equal(manager[map].has(T), false, `${map} disposed after a game timer found the table closed`);
  manager.stop();
  manager.armTimers({ ...state, revision: 30 });
  assert.equal(manager.idleTimers.size, 0, 'stop() also stops the idle clock');
});

test('idle timer: a timer kept for a newer state with the same deadline still retries when its check fails', async (t) => {
  mockClock(t);
  const manager = new TableManager(); t.after(() => manager.stop());
  // A lone player between hands: no game timer will come along to re-arm the idle clock.
  const state = { ...seatPlayers(createTable(config({ createdAt: NOW - IDLE + 1_000 })), 1), revision: 3 };
  manager.armTimers(state);
  const kept = manager.idleTimers.get(T);
  manager.armTimers({ ...state, revision: 4 });
  assert.equal(manager.idleTimers.get(T), kept, 'a change that is not activity keeps the pending timer');
  assert.deepEqual(manager.idleArmed.get(T), { revision: 4, deadline: NOW + 1_000 });

  const mutate = t.mock.method(manager, 'mutate', async () => { throw new Error('database offline'); });
  t.mock.timers.tick(1_000);
  assert.equal(mutate.mock.callCount(), 1);
  await flush();
  assert.ok(manager.idleTimers.has(T), 'the retry is scheduled for the revision the timer stood for');
  const get = t.mock.method(manager, 'get', async () => ({ ...state, revision: 4 }));
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(get.mock.callCount(), 1, 'the retry reloads fresh state');
  t.mock.timers.tick(1);
  assert.equal(mutate.mock.callCount(), 2, 'and the overdue check runs again');
});

test('idle timer: a corrupt far-future lastActivityAt is re-checked after one idle timeout, never in a tight loop', async (t) => {
  mockClock(t);
  const manager = new TableManager(); t.after(() => manager.stop());
  const state = lastActive(seatPlayers(createTable(config({ createdAt: NOW })), 1), NOW + 100 * 86_400_000);
  const mutate = t.mock.method(manager, 'mutate', async () => state);
  manager.armTimers(state);
  t.mock.timers.tick(IDLE - 1);
  assert.equal(mutate.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(mutate.mock.callCount(), 1, 'fired once, after one idle timeout');
});

// ---------------------------------------------------------------------------
// Recovery and legacy state
// ---------------------------------------------------------------------------

test('recover() closes a table that was left empty; an open table is only timed; nothing is paid twice', async (t) => {
  mockClock(t);
  const empty = leaveSeat(seatPlayers(createTable(config({ createdAt: NOW - 60_000 })), 1), 'player-0');
  empty.cashOuts = []; // paid in the transaction that stored this state
  const db = database(t, { state: empty });
  const { manager } = managerFor(t, room().io);
  await manager.recover();
  assertClosed(db, { reason: 'EMPTY', at: NOW });
  assert.deepEqual(db.log.cashOuts, []);
  assert.equal(db.bankroll('player-0'), START_BANKROLL);
  await manager.recover();
  assert.equal(db.log.tableUpdates.length, 1, 'a closed table is not recovered again');

  const open = seatPlayers(createTable(config({ createdAt: NOW })), 1);
  db.setState(open);
  const writes = db.log.tableUpdates.length;
  await manager.recover();
  assert.equal(db.log.tableUpdates.length, writes, 'nothing to write');
  assert.deepEqual(manager.idleArmed.get(T), { revision: 0, deadline: NOW + IDLE }, 'its idle clock is running');
});

test('legacy state without the idle clocks: upgraded (reported), clocks stored from the row\'s last update; the restart still gives a full 5 minutes', async (t) => {
  mockClock(t);
  const current = seatPlayers(createTable(config({ createdAt: NOW })), 1);

  const upgraded = upgradeStoredTableState(T, legacyOf(current), () => assert.fail('nothing to void'), { fallbackActivityAt: NOW - 3_600_000 });
  assert.equal(upgraded.upgraded, true, 'a state missing the lifecycle fields reports upgraded');
  assert.equal(upgraded.table.lastActivityAt, NOW - 3_600_000);
  assert.equal(upgraded.table.players[0].lastActivityAt, NOW - 3_600_000, 'a legacy player gets the table\'s clock');
  assert.equal(upgraded.table.closingAt, null); assert.equal(upgraded.table.closeReason, null);
  const again = upgradeStoredTableState(T, structuredClone(upgraded.table), () => {}, { fallbackActivityAt: NOW });
  assert.equal(again.upgraded, false, 'idempotent');
  assert.equal(again.table.lastActivityAt, NOW - 3_600_000, 'a later fallback is ignored');
  // Saved with the table's clock but before per-player clocks: upgraded too.
  const tableClockOnly = { ...structuredClone(current), lastActivityAt: NOW - 60_000 };
  delete tableClockOnly.players[0].lastActivityAt;
  const players = upgradeStoredTableState(T, tableClockOnly, () => assert.fail('nothing to void'), { fallbackActivityAt: NOW - 1 });
  assert.equal(players.upgraded, true, 'a seated player without a clock reports upgraded');
  assert.equal(players.table.players[0].lastActivityAt, NOW - 60_000, 'and gets the table\'s clock, not the fallback');

  const db = database(t, { state: legacyOf(current), row: { createdAt: new Date(NOW - 7_200_000), updatedAt: new Date(NOW - 3_600_000) } });
  const { manager, advance } = managerFor(t, room().io);
  await manager.recover();
  const s = db.state();
  assert.equal(s.lastActivityAt, NOW - 3_600_000, 'the upgrade is stored with the row\'s last update');
  assert.equal(s.players[0].lastActivityAt, NOW - 3_600_000);
  assert.equal(s.closingAt, null); assert.equal(s.closeReason, null);
  // Round 2: downtime is not inactivity. The idle clock runs from the restart, not from the hour-old update.
  await advance(IDLE - 1);
  assert.equal(db.state().closingAt, null, 'no warning within 5 minutes of the restart');
  await advance(1);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING);
  await advance(WARNING);
  assertClosed(db, { reason: 'IDLE', at: NOW + IDLE + WARNING });
  assert.equal(db.bankroll('player-0'), START_BANKROLL + 1000);
});

test('load() tolerates rows without createdAt/updatedAt (the clock then starts now) and uses them when present', async (t) => {
  mockClock(t);
  const legacy = legacyOf(seatPlayers(createTable(config({ createdAt: NOW - 1 })), 1));
  const db = database(t, { state: legacy });
  const { manager } = managerFor(t);
  const upgraded = await manager.get(T);
  assert.equal(upgraded.lastActivityAt, NOW);
  assert.equal(upgraded.players[0].lastActivityAt, NOW);
  db.setState(null, { status: 'WAITING' }, hostOnlySeats());
  const undated = await manager.get(T);
  assert.equal(undated.lastActivityAt, NOW);
  assert.equal(undated.players[0].lastActivityAt, NOW);
  db.setState(null, { status: 'WAITING', createdAt: new Date(NOW - 90_000) }, hostOnlySeats());
  const hydrated = await manager.get(T);
  assert.equal(hydrated.lastActivityAt, NOW - 90_000, 'a new table\'s clock starts at its creation');
  assert.equal(hydrated.players[0].userId, 'player-0');
  assert.equal(hydrated.players[0].lastActivityAt, NOW - 90_000, 'and so does the clock of the host seated with it');
});

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

test('sockets: a closed table refuses joins and commands with TABLE_CLOSED (private tables stay hidden); TABLE_KEEP_ALIVE is acknowledged', async (t) => {
  const db = database(t, { state: seatPlayers(createTable(config()), 1) });
  db.setState(null, { status: 'CLOSED', closedAt: new Date(), stateCiphertext: encryptState({ ...createTable(config()), status: 'CLOSED', closeReason: 'IDLE' }, `table:${T}`) }, seatsOf(createTable(config())));
  const server = createServer();
  const io = createSocketServer(server); tableManager.stop();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = connect(`http://127.0.0.1:${server.address().port}`, {
    transports: ['websocket'], extraHeaders: { Origin: env.CLIENT_ORIGIN },
    auth: { token: signAccessToken('player-0', 'Player-0', 'player-0') },
  });
  t.after(async () => { client.disconnect(); tableManager.stop(); await new Promise((resolve) => io.close(resolve)); tableManager.io = null; });
  await once(client, SOCKET_EVENTS.AUTH_OK);

  const refused = once(client, SOCKET_EVENTS.SERVER_ERROR);
  client.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId: T });
  assert.deepEqual((await refused)[0], { code: 'TABLE_CLOSED', message: 'This table has closed', tableId: T });
  assert.equal(io.sockets.adapter.rooms.has(ROOM), false, 'not joined to a closed table');
  const closed = { ok: false, code: 'TABLE_CLOSED', message: 'This table has closed' };
  assert.deepEqual(await client.timeout(2000).emitWithAck(SOCKET_EVENTS.STAND_UP, { tableId: T }), closed);
  assert.deepEqual(await client.timeout(2000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId: T }), closed);
  // A private table is "not found" to anyone but its host and players, closed or not.
  db.setState(null, { status: 'CLOSED', isPrivate: true, hostId: 'someone-else', stateCiphertext: null }, seatsOf(createTable(config())));
  assert.deepEqual(await client.timeout(2000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId: T }), { ok: false, code: 'TABLE_NOT_FOUND', message: 'Table not found' });

  // Open table with an idle warning: the seated player's keep-alive cancels it.
  const warned = beginIdleWarning(seatPlayers(createTable(config()), 1), Date.now() + WARNING);
  db.setState(warned);
  assert.deepEqual(await client.timeout(2000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId: T }), { ok: true });
  assert.equal(db.state().closingAt, null);
  assert.equal(db.state().revision, warned.revision + 1);
  const invalid = await client.timeout(2000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId: T, extra: true });
  assert.equal(invalid.ok, false); assert.equal(invalid.code, 'INVALID_REQUEST');
});

// ---------------------------------------------------------------------------
// Round 2: per-player activity, restarts, idle notices, races with closure
// ---------------------------------------------------------------------------

test('idle: an AFK human and a bot on a legacy table: the bot\'s actions are not activity; the human is sat out by the time-out, warned at 5 minutes, closed, the human paid exactly once', async (t) => {
  mockClock(t);
  const HOUR = 3_600_000;
  // The bot holds the button (seat 0), so heads-up it acts first preflop: it
  // acts before the human's first time-out sits the human out and dealing stops.
  const human = { userId: 'player-0', username: 'Player-0', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 };
  const created = createTable(config({ createdAt: NOW - 2 * HOUR }));
  const stored = legacyOf(sitDown(seatBot(created, 0), 1, human, created.lastActivityAt));
  const db = database(t, { state: stored, row: { createdAt: new Date(NOW - 2 * HOUR), updatedAt: new Date(NOW - HOUR) } });
  const viewers = room(); viewers.watch('player-0');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.recover();
  assert.equal(db.state().players[0].kind, 'BOT');
  assert.equal(db.state().players[1].userId, 'player-0');

  for (let elapsed = 10_000; elapsed < IDLE; elapsed += 10_000) {
    await advance(10_000);
    const s = db.state();
    assert.equal(s.closingAt, null, `no warning before 5 minutes (t=${elapsed / 1000}s)`);
    assert.equal(s.lastActivityAt, NOW - HOUR, 'the bot\'s actions and the time-outs never restart the table\'s clock');
    assert.equal(s.players[1].lastActivityAt, NOW - HOUR, 'nor the human\'s');
  }
  await advance(9_999);
  assert.equal(db.state().closingAt, null);
  await advance(1);
  const s = db.state();
  assert.equal(s.closingAt, NOW + IDLE + WARNING, 'warned exactly 5 minutes after the restart');
  const moves = db.log.hands.flatMap((h) => h.actions.create).filter((a) => !a.action.startsWith('POST_'));
  assert.ok(db.log.hands.length >= 1, 'a hand was dealt after the restart');
  assert.ok(moves.some((a) => a.seatIndex === 0 && !a.action.startsWith('TIMEOUT_')), 'the bot acted');
  assert.ok(moves.filter((a) => a.seatIndex === 0).every((a) => !a.action.startsWith('TIMEOUT_')), 'the bot never timed out');
  const humanMoves = moves.filter((a) => a.seatIndex === 1);
  const timeouts = humanMoves.filter((a) => a.action.startsWith('TIMEOUT_'));
  assert.equal(timeouts.length, 1, 'the human timed out once');
  assert.ok(humanMoves.slice(humanMoves.indexOf(timeouts[0]) + 1).every((a) => a.action === 'CHECK' || a.action === 'FOLD'), 'after it the sat-out cascade only checks or folds for them');
  assert.equal(humanMoves.slice(0, humanMoves.indexOf(timeouts[0])).length, 0, 'the human never acted before the time-out');
  assert.equal(s.players[1].sittingOut, true); assert.equal(s.players[1].sittingOutReason, 'TIMEOUT');
  assert.equal(s.players[0].sittingOut, false, 'a bot is never sat out by the clock');
  assert.equal(db.log.hands.at(-1).actions.create.filter((a) => a.action.startsWith('TIMEOUT_')).length, 1, 'no hand was dealt after the time-out');
  assert.equal(s.handNumber, db.log.hands.at(-1).handNumber); assert.equal(s.phase, 'WAITING');

  await advance(WARNING - 1);
  assert.equal(db.row().status, 'WAITING');
  await advance(1);
  assertClosed(db, { reason: 'IDLE', at: NOW + IDLE + WARNING });
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), Array.from({ length: s.handNumber }, (_, i) => i + 1), 'every hand recorded exactly once, in order');
  await verifyRecordedHands(db.log.hands);
  // Heads-up, both players are in every hand: the last recorded hand holds the final stacks.
  const final = Object.fromEntries(db.log.hands.at(-1).players.create.map((p) => [p.userId, p.endingStack]));
  assert.equal(final['player-0'] + final['bot-1'], 2000, 'chips conserved at the table');
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-0', stack: final['player-0'] }], 'the human was paid exactly once (a bot has no bankroll)');
  assert.equal(db.bankroll('player-0'), START_BANKROLL + final['player-0']);
  assert.deepEqual(viewers.patches('player-0'), [{ bankroll: db.bankroll('player-0'), cashOutTableId: T, tableClosedReason: 'IDLE' }]);
});

test('idle: a player leaving during the warning does not cancel it; the table closes on time, everyone paid once, and no "warning over" notice is sent', async (t) => {
  mockClock(t);
  const ids = ['player-0', 'player-1', 'player-2'];
  // Two of three sitting out: nothing is dealt, so the table is simply idle.
  const state = sitOut(sitOut(seatPlayers(createTable(config({ createdAt: NOW })), 3), 'player-1', NOW), 'player-2', NOW);
  const db = database(t, { state });
  const viewers = room(); for (const id of ids) viewers.watch(id);
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);
  await advance(IDLE);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING);
  assert.deepEqual(viewers.notices().map((n) => n.to), ids.map((id) => `user:${id}`), 'every seated human is told, sitting out or not');

  await advance(4_000);
  assert.equal(await manager.standUp(T, 'player-1'), false);
  const s = db.state();
  assert.equal(s.players[1], null);
  assert.equal(s.closingAt, NOW + IDLE + WARNING, 'leaving is not activity: the warning stands');
  assert.equal(db.bankroll('player-1'), START_BANKROLL + 1000, 'the leaver is paid at once');
  await advance(WARNING - 4_000 - 1);
  assert.equal(db.row().status, 'WAITING');
  await advance(1);
  assertClosed(db, { reason: 'IDLE', at: NOW + IDLE + WARNING });
  assert.deepEqual(db.log.cashOuts, [{ userId: 'player-1', stack: 1000 }, { userId: 'player-0', stack: 1000 }, { userId: 'player-2', stack: 1000 }]);
  assert.deepEqual(viewers.patches('player-1'), [{ bankroll: START_BANKROLL + 1000, cashOutTableId: T }], 'the leaver knows why: no close reason');
  for (const id of ['player-0', 'player-2']) assert.deepEqual(viewers.patches(id), [{ bankroll: START_BANKROLL + 1000, cashOutTableId: T, tableClosedReason: 'IDLE' }]);
  assert.equal(viewers.notices().length, 3, 'the closure is reported by the cash-out patch, not by a notice');
});

test('idle: an outsider who takes a seat and leaves again does not extend an AFK table\'s clock, before or during the warning', async (t) => {
  mockClock(t);
  const db = database(t, { state: seatPlayers(createTable(config({ createdAt: NOW })), 1) });
  const viewers = room(); viewers.watch('player-0');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);

  // A minute before the warning is due: claim a seat and leave at once, at no cost.
  await advance(IDLE - 60_000);
  await manager.seatClaim(T, 'newcomer', 1, 1000);
  const s = db.state();
  assert.equal(s.lastActivityAt, NOW + IDLE - 60_000); assert.equal(s.players[1].lastActivityAt, NOW + IDLE - 60_000);
  assert.equal(manager.idleArmed.get(T).deadline, NOW + 2 * IDLE - 60_000, 'while the newcomer stays, their activity counts');
  assert.equal(await manager.standUp(T, 'newcomer'), false);
  assert.equal(db.bankroll('newcomer'), START_BANKROLL, 'the buy-in came straight back');
  assert.equal(db.state().lastActivityAt, NOW + IDLE - 60_000, 'the table\'s own clock moved...');
  assert.equal(manager.idleArmed.get(T).deadline, NOW + IDLE, '...but the players still at the table did not act');
  await advance(60_000 - 1);
  assert.equal(db.state().closingAt, null);
  await advance(1);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING, 'warned on the AFK player\'s own clock');

  // During the warning: a newcomer who sits down cancels it; leaving again brings it straight back.
  await advance(3_000);
  await manager.seatClaim(T, 'newcomer', 1, 1000);
  assert.equal(db.state().closingAt, null, 'taking a seat cancels the warning');
  assert.deepEqual(viewers.notices().map((n) => [n.to, n.closingInMs]), [['user:player-0', WARNING], ['user:player-0', null], ['user:newcomer', null]]);
  assert.equal(await manager.standUp(T, 'newcomer'), false);
  await advance(1);
  const rewarned = NOW + IDLE + 3_000 + 1 + WARNING;
  assert.equal(db.state().closingAt, rewarned, 're-warned at once');
  assert.deepEqual(viewers.notices().at(-1), { to: 'user:player-0', tableId: T, tableName: 'Lifecycle', closingInMs: WARNING });
  await advance(WARNING);
  assertClosed(db, { reason: 'IDLE', at: rewarned });
  assert.deepEqual(db.log.cashOuts, [{ userId: 'newcomer', stack: 1000 }, { userId: 'newcomer', stack: 1000 }, { userId: 'player-0', stack: 1000 }], 'each buy-in returned exactly once');
  assert.equal(db.bankroll('newcomer'), START_BANKROLL);
  assert.equal(db.bankroll('player-0'), START_BANKROLL + 1000);
});

test('restart after a long outage: every table gets a full 5 minutes from the restart, even mid-hand, and the hand in progress plays on to the end', async (t) => {
  mockClock(t);
  const HOUR = 3_600_000;
  const hand = startHand(seatPlayers(createTable(config({ createdAt: NOW - HOUR })), 3), NOW - HOUR);
  const db = database(t, { state: hand, row: { updatedAt: new Date(NOW - HOUR) } });
  const viewers = room(); viewers.watch('player-0');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.recover();
  assert.equal(db.log.tableUpdates.length, 0, 'current state: nothing to write at boot');
  assert.equal(manager.idleArmed.get(T).deadline, NOW + IDLE, 'timed from the restart, not from the hour-old activity');

  await advance(IDLE - 1);
  const s = db.state();
  assert.equal(s.closingAt, null, 'no warning within 5 minutes of the restart');
  // The hand interrupted by the restart is played out (by time-outs: nobody is
  // back), settled and recorded once. Each human who timed out was sat out, so
  // with fewer than two players sitting in no later hand is dealt.
  assert.equal(s.handNumber, 1); assert.equal(s.phase, 'WAITING', 'the hand in progress was settled after the restart');
  assert.deepEqual(db.log.hands.map((h) => h.handNumber), [1]);
  await verifyRecordedHands(db.log.hands);
  const timedOut = db.log.hands[0].actions.create.filter((a) => a.action.startsWith('TIMEOUT_')).map((a) => a.seatIndex);
  assert.ok(timedOut.length >= 1, 'played on by time-outs');
  for (const seat of [0, 1, 2]) assert.equal(s.players[seat].sittingOutReason, timedOut.includes(seat) ? 'TIMEOUT' : null, `seat ${seat}`);
  assert.ok(s.players.filter((p) => p && !p.sittingOut).length < 2, 'nothing left to deal');
  assert.equal(db.chips(['player-0', 'player-1', 'player-2']), 3 * START_BANKROLL + 3000, 'chips conserved');
  assert.deepEqual(db.log.cashOuts, []);
  assert.deepEqual(viewers.notices(), []);
  await advance(1);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING);
  assert.equal(db.state().lastActivityAt, NOW - HOUR, 'the stored clocks are the players\' real ones');
});

test('restart during a warning: the stale warning is dropped at recover in one commit, dealing resumes, and the table is timed afresh', async (t) => {
  mockClock(t);
  // The warning began at NOW - 5 s - WARNING and its deadline passed while the server was down.
  const warned = beginIdleWarning(completeHand(playOut(startHand(seatPlayers(createTable(config({ createdAt: NOW - IDLE - 20_000 })), 2)))), NOW - 5_000);
  const db = database(t, { state: warned });
  const viewers = room(); viewers.watch('player-0');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.recover();
  let s = db.state();
  assert.equal(s.closingAt, null, 'the warning from before the restart is dropped');
  assert.equal(s.closeReason, null); assert.equal(db.row().status, 'WAITING');
  assert.equal(s.revision, warned.revision + 1, 'in one commit');
  assert.equal(db.log.tableUpdates.length, 1);
  assert.equal(s.lastActivityAt, warned.lastActivityAt, 'nothing else changes');
  assert.deepEqual(s.log, warned.log);
  assert.deepEqual(db.log.cashOuts, []);
  assert.deepEqual(viewers.notices(), ['player-0', 'player-1'].map((id) => ({ to: `user:${id}`, tableId: T, tableName: 'Lifecycle', closingInMs: null })));

  await advance(100, 100);
  s = db.state();
  assert.equal(s.handNumber, 2, 'dealing resumes');
  assert.equal(s.status, 'IN_HAND');
  await advance(IDLE - 100 - 1);
  assert.equal(db.state().closingAt, null, 'a full 5 minutes from the restart');
  await advance(1);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING);
  assert.deepEqual(db.log.cashOuts, []);
});

test('idle check: a warning from before the restart that reaches the idle timer is dropped, never acted on', async (t) => {
  mockClock(t);
  // Began at NOW + 5 s - WARNING, before this process resumed at NOW; its deadline is still ahead.
  const warned = { ...beginIdleWarning(seatPlayers(createTable(config({ createdAt: NOW - 2 * IDLE })), 1), NOW + 5_000), revision: 3 };
  const db = database(t, { state: warned });
  const { manager, advance } = managerFor(t, room().io);
  manager.resumedAt = NOW; // as recover() sets it; this table reaches the timer without recover's clean-up
  await manager.track(T);
  assert.deepEqual(manager.idleArmed.get(T), { revision: 3, deadline: NOW }, 'checked at once');
  await advance(1);
  assert.equal(db.state().closingAt, null, 'dropped');
  assert.equal(db.state().revision, 4);
  await advance(5_000 + WARNING);
  assert.equal(db.row().status, 'WAITING', 'never closed on the stale deadline');
  assert.equal(db.bankroll('player-0'), START_BANKROLL);
  // 1 + 5 s + WARNING have passed since the restart: run to 1 ms before 5 minutes from it.
  await advance(IDLE - 1 - (1 + 5_000 + WARNING));
  assert.equal(db.state().closingAt, null);
  await advance(1);
  assert.equal(db.state().closingAt, NOW + IDLE + WARNING, 'warned 5 minutes after the restart');
});

test('idle notices: the start goes to each seated human still at the table (not spectators, bots or leaving players); the end to every seated human', async (t) => {
  mockClock(t);
  // Button 0, blinds 1/2, the bot in seat 3 acts first; player-1 (small blind) has clicked leave.
  const hand = leaveSeat(startHand(seatBot(seatPlayers(createTable(config({ createdAt: NOW - IDLE })), 3), 3)), 'player-1');
  assert.equal(hand.players[1].pendingLeave, true);
  const db = database(t, { state: hand });
  const viewers = room(); viewers.watch('watcher'); viewers.watch('player-0');
  const { manager, advance } = managerFor(t, viewers.io);
  await manager.track(T);
  await advance(1);
  assert.equal(db.state().closingAt, NOW + 1 + WARNING);
  const notice = { tableId: T, tableName: 'Lifecycle' };
  assert.deepEqual(viewers.notices(), [{ to: 'user:player-0', ...notice, closingInMs: WARNING }, { to: 'user:player-2', ...notice, closingInMs: WARNING }]);
  assert.equal(viewers.snapshots('watcher').at(-1).closingInMs, WARNING, 'a spectator sees the warning in the table snapshot');

  await advance(2_000);
  assert.equal(viewers.notices().length, 2, 'nothing more while the warning runs');
  assert.equal(db.state().players[1]?.pendingLeave, true, 'the leaver is still seated until the hand ends');
  await manager.keepAlive(T, 'player-2');
  assert.equal(db.state().closingAt, null);
  assert.equal(db.state().players[2].lastActivityAt, NOW + 2_001, 'the keep-alive is the player\'s own activity');
  assert.deepEqual(viewers.notices().slice(2), ['player-0', 'player-1', 'player-2'].map((id) => ({ to: `user:${id}`, ...notice, closingInMs: null })));
  assert.ok(viewers.notices().every((n) => n.to !== 'user:bot-1' && n.to !== 'user:watcher' && n.to !== 'watcher'));
  assert.equal(viewers.snapshots('watcher').at(-1).closingInMs, null);
});

test('mutate: a command that meets a closed table is told TABLE_CLOSED; a table that does not exist is still TABLE_NOT_FOUND', async (t) => {
  mockClock(t);
  const db = database(t, { row: { status: 'WAITING', createdAt: new Date(NOW) }, seats: hostOnlySeats() });
  const { manager } = managerFor(t, room().io);
  await manager.standUp(T, 'player-0');
  assert.equal(db.row().status, 'CLOSED');
  const writes = db.log.tableUpdates.length;
  for (const [name, command] of [
    ['intent', () => manager.intent(T, 'player-0', { action: 'CHECK' }, 1)],
    ['seatClaim', () => manager.seatClaim(T, 'newcomer', 1, 1000)],
    ['sitToggle', () => manager.sitToggle(T, 'player-0', true)],
    ['standUp', () => manager.standUp(T, 'player-0')],
    ['keepAlive', () => manager.keepAlive(T, 'player-0')],
    ['tryStart', () => manager.tryStart(T)],
  ]) await assert.rejects(command(), { code: 'TABLE_CLOSED', message: 'This table has closed' }, name);
  await assert.rejects(manager.standUp('no-such-table', 'player-0'), { code: 'TABLE_NOT_FOUND', message: 'Table not found' });
  assert.equal(db.log.tableUpdates.length, writes, 'nothing written');
  assert.equal(db.bankroll('newcomer'), START_BANKROLL, 'no buy-in taken');
});

test('timers: a game or idle timer that finds the table closed (TABLE_CLOSED) forgets it, as for a missing table', async (t) => {
  mockClock(t);
  const manager = new TableManager(); t.after(() => manager.stop());
  const mutate = t.mock.method(manager, 'mutate', async () => { throw new EngineError('TABLE_CLOSED', 'This table has closed'); });
  manager.armTimers({ ...lastActive(seatPlayers(createTable(config({ createdAt: NOW })), 1), NOW - IDLE), revision: 1 });
  t.mock.timers.tick(1);
  await flush();
  assert.equal(mutate.mock.callCount(), 1, 'the idle check ran');
  for (const map of ['timers', 'idleTimers', 'armedRevision', 'idleArmed']) assert.equal(manager[map].has(T), false, `${map} disposed after the idle timer found the table closed`);

  manager.armTimers({ ...startHand(seatPlayers(createTable(config({ createdAt: Date.now() })), 2)), revision: 2 });
  assert.ok(manager.timers.has(T) && manager.idleTimers.has(T));
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(mutate.mock.callCount(), 2, 'the turn timer ran');
  for (const map of ['timers', 'idleTimers', 'armedRevision', 'idleArmed']) assert.equal(manager[map].has(T), false, `${map} disposed after the game timer found the table closed`);
  t.mock.timers.tick(2 * IDLE);
  await flush();
  assert.equal(mutate.mock.callCount(), 2, 'no retry');
});

/** The real Socket.io server over the in-memory database, with one authenticated client. */
async function socketClient(t, userId) {
  const server = createServer();
  const io = createSocketServer(server); tableManager.stop();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = connect(`http://127.0.0.1:${server.address().port}`, {
    transports: ['websocket'], extraHeaders: { Origin: env.CLIENT_ORIGIN },
    auth: { token: signAccessToken(userId, USERS[userId], userId) },
  });
  t.after(async () => { client.disconnect(); tableManager.stop(); await new Promise((resolve) => io.close(resolve)); tableManager.io = null; });
  await once(client, SOCKET_EVENTS.AUTH_OK);
  return { io, client };
}
/** The next SERVER_ERROR, or a failure if none arrives (a request left unanswered). */
const nextError = (client, ms = 2_000) => new Promise((resolve, reject) => {
  const onError = (payload) => { clearTimeout(timer); resolve(payload); };
  const timer = setTimeout(() => { client.off(SOCKET_EVENTS.SERVER_ERROR, onError); reject(new Error('no SERVER_ERROR arrived')); }, ms);
  client.once(SOCKET_EVENTS.SERVER_ERROR, onError);
});
/** The row and state a committed closure leaves. */
const closeRow = (db) => db.setState(null, { status: 'CLOSED', closedAt: new Date(), stateCiphertext: encryptState({ ...createTable(config()), status: 'CLOSED', closeReason: 'IDLE' }, `table:${T}`) }, seatsOf(createTable(config())));
/** The closure commits just before the next transaction takes the row lock: a command that passed its check while the table was open. */
function closeBeforeNextTransaction(t, db) {
  const run = prisma.$transaction;
  const racing = (...args) => { prisma.$transaction = run; closeRow(db); return run(...args); };
  prisma.$transaction = racing;
  t.after(() => { if (prisma.$transaction === racing) prisma.$transaction = run; });
}

test('sockets: a join or a command racing the closure is told TABLE_CLOSED (with its tableId) instead of silence, and nothing is taken or left behind', async (t) => {
  const db = database(t, { state: seatPlayers(createTable(config()), 1) });
  const { io, client } = await socketClient(t, 'newcomer');
  const closed = { code: 'TABLE_CLOSED', message: 'This table has closed' };

  // The table closes between the join's check and its snapshot (after closeRoom emptied the room).
  const snapshot = tableManager.snapshot.bind(tableManager);
  const racing = t.mock.method(tableManager, 'snapshot', async (...args) => { closeRow(db); return snapshot(...args); });
  for (const event of [SOCKET_EVENTS.TABLE_JOIN, SOCKET_EVENTS.REHYDRATE]) {
    db.setState(seatPlayers(createTable(config()), 1));
    const refused = nextError(client);
    client.emit(event, { tableId: T });
    assert.deepEqual(await refused, { ...closed, tableId: T }, event);
    assert.equal(io.sockets.adapter.rooms.has(ROOM), false, `${event}: the socket left the closed table's room`);
  }
  assert.equal(racing.mock.callCount(), 2);
  racing.mock.restore();

  // Commands that passed their check while the table was open, then met the closure under the row lock.
  db.setState(seatPlayers(createTable(config()), 1));
  closeBeforeNextTransaction(t, db);
  let refused = nextError(client);
  client.emit(SOCKET_EVENTS.SEAT_CLAIM, { tableId: T, seatIndex: 1, buyIn: 1000 });
  assert.deepEqual(await refused, { ...closed, tableId: T }, 'seat claim');
  assert.equal(db.bankroll('newcomer'), START_BANKROLL, 'no buy-in was taken');
  for (const event of [SOCKET_EVENTS.STAND_UP, SOCKET_EVENTS.TABLE_KEEP_ALIVE]) {
    db.setState(seatPlayers(createTable(config()), 1));
    closeBeforeNextTransaction(t, db);
    refused = nextError(client);
    assert.deepEqual(await client.timeout(2000).emitWithAck(event, { tableId: T }), { ok: false, ...closed }, `${event} ack (no tableId)`);
    assert.deepEqual(await refused, { ...closed, tableId: T }, event);
  }
});

test('sockets: SERVER_ERROR names the table the refused request named (acks unchanged); none for a missing or malformed tableId', async (t) => {
  database(t, { state: seatPlayers(createTable(config()), 1) });
  // A user the other socket tests do not use: seven requests fit the per-user rate limit.
  const { client } = await socketClient(t, 'player-1');

  let refused = nextError(client);
  const ack = await client.timeout(2000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId: 'another-table' });
  assert.deepEqual(ack, { ok: false, code: 'TABLE_NOT_FOUND', message: 'Table not found' });
  assert.deepEqual(await refused, { code: 'TABLE_NOT_FOUND', message: 'Table not found', tableId: 'another-table' });

  const invalid = { code: 'INVALID_REQUEST', message: 'Request could not be completed' };
  for (const [payload, scoped] of [
    [{ tableId: T, seatIndex: 1.5, buyIn: -1 }, { tableId: T }], // invalid, but it names a well-formed table
    [{ tableId: 'x'.repeat(129), seatIndex: 1, buyIn: 1000 }, {}],
    [{ tableId: 42, seatIndex: 1, buyIn: 1000 }, {}],
    [{ tableId: '', seatIndex: 1, buyIn: 1000 }, {}],
    [{ seatIndex: 1, buyIn: 1000 }, {}],
    ['not an object', {}],
  ]) {
    refused = nextError(client);
    client.emit(SOCKET_EVENTS.SEAT_CLAIM, payload);
    assert.deepEqual(await refused, { ...invalid, ...scoped }, JSON.stringify(payload).slice(0, 60));
  }
});
