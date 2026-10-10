// Browser-only fixtures: real engine, HTTP and sockets; no database or .env import.
import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import {
  applyAction, beginIdleWarning, closeIfEmpty, closeTable, completeHand, createTable, keepTableOpen, leaveSeat, legalActions,
  projectTableState, recordActivity, sitDown, startHand,
} from '@poker/engine';
import { SOCKET_EVENTS as E, TABLE_IDLE_WARNING_MS } from '@poker/shared';

const app = express();
app.use(cors({ origin: 'http://127.0.0.1:3107', credentials: true }));
app.use(express.json());
const server = createServer(app);
const io = new Server(server, { cors: { origin: 'http://127.0.0.1:3107', credentials: true } });
const hero = 'fixture-player-0';
/** The table's socket room; the fixture holds one table at a time, whose id a reset may choose. */
const room = () => `table:${table.tableId}`;
let table;
let bankroll;
let rejectNext = false;
let actionCount = 0;
let holdMe = false;
let waitingMe = [];
let holdRefresh = false;
let waitingRefresh = [];
let createdBody = null;
// TABLE_KEEP_ALIVE: 'ok' answers at once, 'reject' fails the next request once, 'hold' queues requests until released.
let keepAliveMode = 'ok';
let keepAliveCount = 0;
let waitingKeepAlive = [];
// The next STAND_UP races an idle closure: the table closes (and pays out) just before the request is handled.
let closeBeforeNextLeave = false;
// Table-UI tests: fields merged into every projected snapshot (state, the seat to act, the hero's seat), the last
// ACTION_INTENT and every SEAT_CLAIM payload, as received.
let snapshotPatch = null;
let lastAction = null;
let seatClaims = [];
let rejectNextSeat = false;
/**
 * Modes: 'active' (three seated, a hand running, the hero to act), 'waiting' (three seated, no hand), 'unseated'
 * (no one seated), 'spectator' (two others seated with a hand running, the hero watching with seats free),
 * 'closed', 'reject', 'slow-me'.
 */
function reset(mode = 'active', tableId = 'fixture-table') {
  const watching = mode === 'unseated' || mode === 'spectator';
  bankroll = watching ? 10000 : 9000; actionCount = 0; rejectNext = mode === 'reject'; holdMe = mode === 'slow-me'; waitingMe = []; createdBody = null;
  holdRefresh = false; waitingRefresh = [];
  keepAliveMode = 'ok'; keepAliveCount = 0; waitingKeepAlive = []; closeBeforeNextLeave = false;
  snapshotPatch = null; lastAction = null; seatClaims = []; rejectNextSeat = false;
  table = createTable({ tableId, name: 'Browser test table', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 600_000 });
  if (mode !== 'unseated') {
    for (let seat = mode === 'spectator' ? 1 : 0; seat < 3; seat++) table = sitDown(table, seat, {
      userId: `fixture-player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: seat * 90,
    });
    if (mode !== 'waiting' && mode !== 'closed') table = startHand(table);
  }
  // Already closed for inactivity between hands: every player was paid, joins are refused.
  if (mode === 'closed') { table = closeTable(table, 'IDLE'); pay(); }
}
reset();
const user = () => ({ id: hero, username: 'Player-0', kind: 'HUMAN', role: 'PLAYER', isGuest: true, bankroll, avatarHue: 0 });
/** The hero's snapshot, with any test patch (optional fields a newer server sends) merged in. */
function project() {
  const state = projectTableState(table, hero);
  if (!snapshotPatch) return state;
  const players = state.players.map((p) => ({
    ...p,
    ...(snapshotPatch.actor && state.toActSeat != null && p.seatIndex === state.toActSeat ? snapshotPatch.actor : {}),
    ...(snapshotPatch.hero && p.userId === hero ? snapshotPatch.hero : {}),
  }));
  return { ...state, ...(state.toActSeat != null ? snapshotPatch.turn ?? {} : {}), ...(snapshotPatch.state ?? {}), players };
}
function publish() { io.to(room()).emit(E.STATE_SNAPSHOT, project()); }
function pay() {
  for (const cash of table.cashOuts) if (cash.userId === hero) {
    bankroll += cash.stack;
    // As the server does: a cash-out caused by an idle closure says so, for the lobby notice.
    io.emit(E.USER_PATCH, { bankroll, cashOutTableId: table.tableId, ...(table.closeReason === 'IDLE' ? { tableClosedReason: 'IDLE' } : {}) });
  }
  table.cashOuts = [];
}
/** One committed mutation, as the server's TableManager.mutate: close if empty, bump the revision, pay, notify, broadcast. */
function commit(next) {
  const before = table;
  table = closeIfEmpty(next); table.revision++; pay(); idleNotices(before, table); publish();
  // A closed table sends its final snapshot, then every socket leaves its room.
  if (table.status === 'CLOSED') io.in(room()).socketsLeave(room());
}
/**
 * TABLE_IDLE_NOTICE as the server's TableManager.idleNotices sends it: when the warning starts, to every seated human not
 * leaving; when it ends without closure, to every human seated before or after. Only the hero has a browser here, and every
 * connected socket is the hero's (user:<hero>), so the fixture emits to all sockets when the hero is a recipient.
 */
function idleNotices(before, next) {
  const humans = (t, staying) => t.players.flatMap((p) => p && p.kind === 'HUMAN' && !(staying && p.pendingLeave) ? [p.userId] : []);
  let to; let closingInMs;
  if (before.closingAt == null && next.closingAt != null) { to = humans(next, true); closingInMs = Math.max(0, next.closingAt - Date.now()); }
  else if (before.closingAt != null && next.closingAt == null && next.closeReason == null) { to = [...humans(before, false), ...humans(next, false)]; closingInMs = null; }
  else return;
  if (to.includes(hero)) io.emit(E.TABLE_IDLE_NOTICE, { tableId: next.tableId, tableName: next.name, closingInMs });
}
/** As the server's failure(): the refused request's table id, when it named one, rides on SERVER_ERROR. */
function namedTable(payload) {
  return typeof payload?.tableId === 'string' && payload.tableId.length <= 128 ? { tableId: payload.tableId } : {};
}
function engineFailure(err) {
  return { code: typeof err?.code === 'string' ? err.code : 'INVALID_REQUEST', message: err instanceof Error ? err.message : 'Request could not be completed' };
}
/** The idle warning expired: close for inactivity and, when a hand was running, run its Hand Clean-up (everyone cashed out). */
function closeIdleNow() {
  commit(closeTable(table, 'IDLE'));
  if (table.status !== 'CLOSED') commit(completeHand(table));
}
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/__test/reset', (req, res) => { reset(req.body.mode, req.body.tableId); resetSession(); res.json({ ok: true }); });
app.post('/__test/settle', (_req, res) => {
  for (let n = 0; table.phase !== 'SHOWDOWN' && n < 100; n++) {
    const legal = legalActions(table, table.toActSeat);
    table = applyAction(table, table.players[table.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
  }
  table = completeHand(table); table.revision++; pay(); publish(); res.json({ bankroll });
});
// The idle timer found five quiet minutes. A later call restarts the warning with a new deadline (a newer revision).
app.post('/__test/idle-warning', (req, res) => {
  const closesInMs = Number.isFinite(req.body?.closesInMs) ? req.body.closesInMs : TABLE_IDLE_WARNING_MS;
  commit(beginIdleWarning(recordActivity(table), Date.now() + closesInMs));
  res.json({ ok: true, revision: table.revision });
});
// The warning expired: close for inactivity. A running hand is settled (SHOWDOWN, everyone leaving) and the table is closing.
app.post('/__test/close-idle', (_req, res) => { commit(closeTable(table, 'IDLE')); res.json({ status: table.status, phase: table.phase }); });
// Hand Clean-up after an idle closure: everyone is cashed out and the empty table is CLOSED.
app.post('/__test/finish-close', (_req, res) => { commit(completeHand(table)); res.json({ status: table.status, bankroll }); });
// The connection drops mid-hand and the idle closure settles that hand and closes the table before the page is back: it
// still holds its mid-hand snapshot and learns of the closure only when its re-join is refused. The transport is closed
// (no disconnect packet), so the client reconnects by itself, as after a network drop.
app.post('/__test/close-while-away', (_req, res) => {
  for (const socket of [...io.sockets.sockets.values()]) socket.conn.close();
  closeIdleNow();
  res.json({ status: table.status, handNumber: table.handNumber });
});
// Another seated player answers the warning ("I'm still here"): it ends for everyone.
app.post('/__test/keep-alive-as', (req, res) => { commit(keepTableOpen(table, req.body.userId)); res.json({ closingAt: table.closingAt }); });
app.post('/__test/close-before-next-leave', (_req, res) => { closeBeforeNextLeave = true; res.json({ ok: true }); });
// A refusal as the server sends it, e.g. for a request about another table.
app.post('/__test/server-error', (req, res) => { io.emit(E.SERVER_ERROR, req.body); res.json({ ok: true }); });
app.post('/__test/keep-alive-mode', (req, res) => { keepAliveMode = req.body.mode; res.json({ ok: true }); });
app.get('/__test/keep-alive', (_req, res) => res.json({ count: keepAliveCount, waiting: waitingKeepAlive.length, closingAt: table.closingAt }));
app.post('/__test/release-keep-alive', (_req, res) => {
  keepAliveMode = 'ok';
  for (const run of waitingKeepAlive) run();
  waitingKeepAlive = [];
  res.json({ ok: true });
});
app.post('/__test/disconnect', (_req, res) => { io.disconnectSockets(true); res.json({ ok: true }); });
app.post('/__test/hold-me', (_req, res) => { holdMe = true; res.json({ ok: true }); });
app.get('/__test/created', (_req, res) => res.json({ body: createdBody }));
app.get('/__test/actions', (_req, res) => res.json({ actionCount, lastAction }));
// { state?, turn? (state fields sent only while someone is to act), actor?, hero? }; null clears. Republishes at once.
app.post('/__test/snapshot-patch', (req, res) => { snapshotPatch = req.body?.patch ?? null; table.revision++; publish(); res.json({ ok: true }); });
app.get('/__test/seat-claims', (_req, res) => res.json({ claims: seatClaims }));
// The other players check or call until the street changes or the hero is to act; one snapshot at the end.
app.post('/__test/play-others', (_req, res) => {
  const board = table.board.length;
  let next = table;
  for (let n = 0; n < 20 && next.toActSeat != null && next.players[next.toActSeat].userId !== hero && next.board.length === board; n++) {
    const legal = legalActions(next, next.toActSeat);
    next = applyAction(next, next.players[next.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
  }
  commit(next);
  res.json({ phase: table.phase, board: table.board.length });
});
// The next SEAT_CLAIM is refused (SERVER_ERROR naming the table, as the server sends it; no ack, as today).
app.post('/__test/reject-next-seat', (_req, res) => { rejectNextSeat = true; res.json({ ok: true }); });
// The wallet changed elsewhere (another tab, a cash-out): the new balance arrives as USER_PATCH.
app.post('/__test/bankroll', (req, res) => { bankroll = req.body.bankroll; io.emit(E.USER_PATCH, { bankroll }); res.json({ bankroll }); });
app.get('/__test/waiting-me', (_req, res) => res.json({ count: waitingMe.length }));
app.post('/__test/release-me', (_req, res) => {
  holdMe = false;
  for (const send of waitingMe) send();
  waitingMe = [];
  res.json({ ok: true });
});
app.post('/__test/hold-refresh', (_req, res) => { holdRefresh = true; res.json({ ok: true }); });
app.get('/__test/waiting-refresh', (_req, res) => res.json({ count: waitingRefresh.length }));
app.post('/__test/release-refresh', (_req, res) => {
  holdRefresh = false;
  for (const send of waitingRefresh) send();
  waitingRefresh = [];
  res.json({ ok: true });
});
app.post('/api/auth/refresh', (req, res) => {
  // Session fixtures (below) answer when a test chose a refresh mode; the default answers here.
  if (sessionRefresh(req, res)) return;
  const captured = { user: user(), accessToken: 'browser-fixture-token' };
  if (holdRefresh) waitingRefresh.push(() => res.json(captured));
  else res.json(captured);
});
app.get('/api/auth/me', (_req, res) => {
  const captured = { user: user() };
  if (holdMe) waitingMe.push(() => res.json(captured));
  else res.json(captured);
});
// The lobby lists open tables only, as the server does.
app.get('/api/tables', (_req, res) => res.json({ tables: table.status === 'CLOSED' ? [] : [{
  id: table.tableId, name: table.name, status: table.status, maxSeats: 6, occupiedSeats: table.players.filter(Boolean).length,
  smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000, botCount: 0, isSeated: table.players.some((p) => p?.userId === hero),
}] }));
app.post('/api/tables', (req, res) => {
  if (req.body.botCount !== 0 || table.players.some((player) => player?.userId === hero)) { res.status(400).json({ error: 'Human-only table could not be opened' }); return; }
  createdBody = req.body;
  bankroll -= req.body.buyIn;
  table = createTable({ tableId: 'fixture-table', name: req.body.name || 'New table', maxSeats: req.body.maxSeats, smallBlind: req.body.smallBlind, bigBlind: req.body.bigBlind, timeBankMs: 600_000 });
  table = sitDown(table, 0, { userId: hero, username: 'Player-0', kind: 'HUMAN', botProfile: null, buyIn: req.body.buyIn, avatarHue: 0 });
  res.status(201).json({ tableId: table.tableId });
});
io.on('connection', (socket) => {
  socket.emit(E.AUTH_OK, { userId: hero, username: 'Player-0', activeTableId: table.tableId, ...authOkExtras() });
  // SERVER_ERROR (naming the request's table, as the server does) and the ack, if one was asked for.
  const refuse = (error, payload, ack) => {
    socket.emit(E.SERVER_ERROR, { ...error, ...namedTable(payload) });
    if (typeof ack === 'function') ack({ ok: false, ...error });
  };
  const refuseClosed = (payload, ack) => {
    if (table.status !== 'CLOSED') return false;
    refuse({ code: 'TABLE_CLOSED', message: 'This table has closed' }, payload, ack);
    return true;
  };
  const join = (payload) => {
    if (refuseClosed(payload)) return;
    socket.join(room()); socket.emit(E.STATE_SNAPSHOT, project());
  };
  socket.on(E.TABLE_JOIN, join); socket.on(E.REHYDRATE, join);
  socket.on(E.TABLE_LEAVE, () => socket.leave(room()));
  socket.on(E.STAND_UP, (payload, ack) => {
    if (closeBeforeNextLeave) { closeBeforeNextLeave = false; closeIdleNow(); }
    if (refuseClosed(payload, ack)) return;
    const seatedBefore = table.players.some((p) => p?.userId === hero);
    if (seatedBefore) commit(leaveSeat(table, hero)); else { pay(); publish(); }
    ack({ ok: true, pendingLeave: table.players.some((p) => p?.userId === hero && p.pendingLeave) });
  });
  // Taking a seat is activity: it cancels an idle warning (as long as the new player stays).
  socket.on(E.SEAT_CLAIM, (payload) => {
    seatClaims.push(payload);
    if (rejectNextSeat) {
      rejectNextSeat = false;
      refuse({ code: 'SEAT_TAKEN', message: 'That seat was just taken. Choose another seat.' }, payload);
      return;
    }
    if (refuseClosed(payload)) return;
    try {
      if (payload.buyIn > bankroll) throw Object.assign(new Error('Not enough bankroll'), { code: 'BANKROLL' });
      const now = Date.now();
      const next = recordActivity(sitDown(table, payload.seatIndex, {
        userId: hero, username: 'Player-0', kind: 'HUMAN', botProfile: null, buyIn: payload.buyIn, avatarHue: 0,
      }, now), now, hero);
      bankroll -= payload.buyIn;
      commit(next);
      io.emit(E.USER_PATCH, { bankroll });
    } catch (err) {
      refuse(engineFailure(err), payload);
    }
  });
  socket.on(E.ACTION_INTENT, (payload, ack) => {
    actionCount++;
    lastAction = { action: payload.action, amount: payload.amount };
    if (rejectNext) {
      rejectNext = false;
      refuse({ code: 'ILLEGAL', message: 'Fixture rejected this action; try again.' }, payload, ack); return;
    }
    // A player's own action is activity: it cancels an idle warning.
    commit(recordActivity(applyAction(table, hero, { action: payload.action, amount: payload.amount }), Date.now(), hero));
    ack({ ok: true });
  });
  socket.on(E.TABLE_KEEP_ALIVE, (payload, ack) => {
    keepAliveCount++;
    const run = () => {
      if (refuseClosed(payload, ack)) return;
      try {
        if (keepAliveMode === 'reject') {
          keepAliveMode = 'ok';
          throw Object.assign(new Error('Too many requests'), { code: 'RATE_LIMITED' });
        }
        const next = keepTableOpen(table, hero);
        // No warning to cancel: nothing changed, so no new revision.
        if (next !== table) commit(next);
        ack({ ok: true });
      } catch (err) {
        refuse(engineFailure(err), payload, ack);
      }
    };
    if (keepAliveMode === 'hold') waitingKeepAlive.push(run);
    else run();
  });
});
// ---------------------------------------------------------------------------
// Session fixtures (session.spec.ts): refresh outcomes, refresh-cookie rotation, SESSION_RENEW, SESSION_REVOKED,
// AUTH_OK.idleNotice and wallet patches. Every test's /__test/reset also resets these.
// ---------------------------------------------------------------------------
/**
 * refreshMode: 'default' (the handler above: always 200 with one fixed token), 'unavailable' (503, Retry-After: 1,
 * { retryable: true }, cookie kept), 'unauthorized-once' (the next refresh is 401, later ones as 'rotate'),
 * 'unauthorized' (always 401) and 'rotate' (as the server: every refresh rotates an HttpOnly cookie and issues a new
 * access token; a request presenting a superseded cookie is refused 401, as a replay).
 * renewMode: 'ignore' (a server that predates SESSION_RENEW: no answer; the default, so older specs see no change),
 * 'ok', 'unauthorized'.
 */
let refreshMode = 'default';
let renewMode = 'ignore';
let refreshCookie = null;
let tokenSerial = 0;
let refreshStats = { ok: 0, refused: 0, unavailable: 0 };
let renewals = [];
let handshakeTokens = [];
/** undefined: AUTH_OK has no idleNotice field (as before); null or a notice: sent as is. */
let authIdleNotice;
function resetSession() {
  refreshMode = 'default'; renewMode = 'ignore'; refreshCookie = null; tokenSerial = 0;
  refreshStats = { ok: 0, refused: 0, unavailable: 0 }; renewals = []; handshakeTokens = []; authIdleNotice = undefined;
}
resetSession();
function authOkExtras() { return authIdleNotice === undefined ? {} : { idleNotice: authIdleNotice }; }
function presentedCookie(req) {
  const match = /(?:^|;\s*)fixture_refresh=([^;]+)/.exec(req.headers.cookie ?? '');
  return match ? match[1] : null;
}
/** Answers POST /api/auth/refresh unless the mode is 'default'. Outcomes are decided on arrival; 'hold-refresh' delays only the reply. */
function sessionRefresh(req, res) {
  if (refreshMode === 'default') return false;
  let send;
  if (refreshMode === 'unavailable') {
    refreshStats.unavailable++;
    res.setHeader('Retry-After', '1');
    send = () => res.status(503).json({ error: 'Service temporarily unavailable', retryable: true });
  } else if (refreshMode === 'unauthorized' || refreshMode === 'unauthorized-once' ||
      (refreshCookie !== null && presentedCookie(req) !== null && presentedCookie(req) !== refreshCookie)) {
    if (refreshMode === 'unauthorized-once') refreshMode = 'rotate';
    refreshStats.refused++;
    send = () => res.status(401).json({ error: 'Invalid refresh session' });
  } else {
    refreshStats.ok++;
    refreshCookie = globalThis.crypto.randomUUID();
    res.setHeader('Set-Cookie', `fixture_refresh=${refreshCookie}; Path=/; HttpOnly; SameSite=Lax`);
    const captured = { user: user(), accessToken: `browser-fixture-token-${++tokenSerial}` };
    send = () => res.json(captured);
  }
  if (holdRefresh) waitingRefresh.push(send); else send();
  return true;
}
app.get('/__test/session', (_req, res) => res.json({
  refreshMode, renewMode, refreshStats, renewals, handshakeTokens, sockets: [...io.sockets.sockets.keys()],
}));
app.post('/__test/session', (req, res) => {
  if (typeof req.body?.refreshMode === 'string') refreshMode = req.body.refreshMode;
  if (typeof req.body?.renewMode === 'string') renewMode = req.body.renewMode;
  if ('idleNotice' in (req.body ?? {})) authIdleNotice = req.body.idleNotice;
  res.json({ ok: true });
});
// The session was revoked (e.g. password changed): as the server, SESSION_REVOKED, then the socket is closed; the
// refresh cookie is dead too.
app.post('/__test/revoke', (req, res) => {
  refreshMode = 'unauthorized';
  for (const socket of [...io.sockets.sockets.values()]) {
    socket.emit(E.SESSION_REVOKED, { reason: req.body?.reason ?? 'SESSION_REVOKED' });
    socket.disconnect(true);
  }
  res.json({ ok: true });
});
// A wallet patch exactly as given (e.g. out of order); `persist` also makes it the balance /me and refresh report.
app.post('/__test/user-patch', (req, res) => {
  const { persist, ...patch } = req.body ?? {};
  if (persist) bankroll = patch.bankroll;
  io.emit(E.USER_PATCH, patch);
  res.json({ ok: true });
});
app.post('/__test/idle-notice', (req, res) => { io.emit(E.TABLE_IDLE_NOTICE, req.body); res.json({ ok: true }); });
io.on('connection', (socket) => {
  handshakeTokens.push(socket.handshake.auth?.token ?? null);
  socket.on(E.SESSION_RENEW, (payload, ack) => {
    renewals.push(payload?.token ?? null);
    if (renewMode === 'ignore' || typeof ack !== 'function') return;
    if (renewMode === 'unauthorized') ack({ ok: false, code: 'UNAUTHORIZED', message: 'Session expired' });
    else ack({ ok: true });
  });
});
server.listen(4107, '127.0.0.1');
