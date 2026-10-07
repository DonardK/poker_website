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
let rotateToken = false; let delayJoin = false;
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
function publish() { io.to(room()).emit(E.STATE_SNAPSHOT, projectTableState(table, hero)); }
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
app.post('/__test/reset', (req, res) => { reset(req.body.mode, req.body.tableId); res.json({ ok: true }); });
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
app.get('/__test/actions', (_req, res) => res.json({ actionCount }));
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
app.post('/api/auth/refresh', (_req, res) => {
  const captured = { user: user(), accessToken: rotateToken ? 'review-rotated-fixture-token' : 'browser-fixture-token' };
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
  socket.emit(E.AUTH_OK, { userId: hero, username: 'Player-0', activeTableId: table.tableId });
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
    socket.join(room()); if (delayJoin) setTimeout(() => socket.emit(E.STATE_SNAPSHOT, projectTableState(table, hero)), 1500); else socket.emit(E.STATE_SNAPSHOT, projectTableState(table, hero));
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
    if (rejectNext) {
      rejectNext = false;
      refuse({ code: 'ILLEGAL', message: 'Fixture rejected this action; try again.' }, payload, ack); return;
    }
    // A player's own action is activity: it cancels an idle warning.
    try { commit(recordActivity(applyAction(table, hero, { action: payload.action, amount: payload.amount }), Date.now(), hero)); ack({ ok: true }); } catch (err) { refuse(engineFailure(err), payload, ack); }
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
app.post('/__review/rotate', (_req,res)=>{rotateToken=true;delayJoin=true;res.json({ok:true});});
app.post('/__review/wallet', (_req,res)=>{bankroll=10000;io.emit(E.USER_PATCH,{bankroll});res.json({ok:true});});
app.post('/__review/remove-no-pay', (_req,res)=>{while(table.phase!=='SHOWDOWN')table=applyAction(table,table.players[table.toActSeat].userId,{action:legalActions(table,table.toActSeat).actions.includes('CHECK')?'CHECK':'CALL'});table=completeHand(table);res.json({ok:true});});
app.post('/__review/reset', (req,res)=>{rotateToken=false;delayJoin=false;reset(req.body.mode);res.json({ok:true});});
server.listen(4107, '127.0.0.1');
