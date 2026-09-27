// Browser-only fixtures: real engine, HTTP and sockets; no database or .env import.
import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { applyAction, completeHand, createTable, leaveSeat, legalActions, projectTableState, sitDown, startHand } from '@poker/engine';
import { SOCKET_EVENTS as E } from '@poker/shared';

const app = express();
app.use(cors({ origin: 'http://127.0.0.1:3107', credentials: true }));
app.use(express.json());
const server = createServer(app);
const io = new Server(server, { cors: { origin: 'http://127.0.0.1:3107', credentials: true } });
const hero = 'fixture-player-0';
let table;
let bankroll;
let rejectNext = false;
let actionCount = 0;
let holdMe = false;
let waitingMe = [];
let holdRefresh = false;
let waitingRefresh = [];
let createdBody = null;
function reset(mode = 'active') {
  bankroll = mode === 'unseated' ? 10000 : 9000; actionCount = 0; rejectNext = mode === 'reject'; holdMe = mode === 'slow-me'; waitingMe = []; createdBody = null;
  holdRefresh = false; waitingRefresh = [];
  table = createTable({ tableId: 'fixture-table', name: 'Browser test table', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 600_000 });
  if (mode !== 'unseated') {
    for (let seat = 0; seat < 3; seat++) table = sitDown(table, seat, {
      userId: `fixture-player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: seat * 90,
    });
    if (mode !== 'waiting') table = startHand(table);
  }
}
reset();
const user = () => ({ id: hero, username: 'Player-0', kind: 'HUMAN', role: 'PLAYER', isGuest: true, bankroll, avatarHue: 0 });
function publish() { io.to('table:fixture-table').emit(E.STATE_SNAPSHOT, projectTableState(table, hero)); }
function pay() {
  for (const cash of table.cashOuts) if (cash.userId === hero) {
    bankroll += cash.stack;
    io.emit(E.USER_PATCH, { bankroll, cashOutTableId: table.tableId });
  }
  table.cashOuts = [];
}
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/__test/reset', (req, res) => { reset(req.body.mode); res.json({ ok: true }); });
app.post('/__test/settle', (_req, res) => {
  for (let n = 0; table.phase !== 'SHOWDOWN' && n < 100; n++) {
    const legal = legalActions(table, table.toActSeat);
    table = applyAction(table, table.players[table.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
  }
  table = completeHand(table); table.revision++; pay(); publish(); res.json({ bankroll });
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
  const captured = { user: user(), accessToken: 'browser-fixture-token' };
  if (holdRefresh) waitingRefresh.push(() => res.json(captured));
  else res.json(captured);
});
app.get('/api/auth/me', (_req, res) => {
  const captured = { user: user() };
  if (holdMe) waitingMe.push(() => res.json(captured));
  else res.json(captured);
});
app.get('/api/tables', (_req, res) => res.json({ tables: [{
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
  const join = () => { socket.join('table:fixture-table'); socket.emit(E.STATE_SNAPSHOT, projectTableState(table, hero)); };
  socket.on(E.TABLE_JOIN, join); socket.on(E.REHYDRATE, join);
  socket.on(E.TABLE_LEAVE, () => socket.leave('table:fixture-table'));
  socket.on(E.STAND_UP, (_payload, ack) => {
    if (table.players.some((p) => p?.userId === hero)) { table = leaveSeat(table, hero); table.revision++; }
    pay(); publish(); ack({ ok: true, pendingLeave: table.players.some((p) => p?.userId === hero && p.pendingLeave) });
  });
  socket.on(E.ACTION_INTENT, (payload, ack) => {
    actionCount++;
    if (rejectNext) {
      rejectNext = false;
      const error = { code: 'ILLEGAL', message: 'Fixture rejected this action; try again.' };
      socket.emit(E.SERVER_ERROR, error); ack({ ok: false, ...error }); return;
    }
    table = applyAction(table, hero, { action: payload.action, amount: payload.amount }); table.revision++;
    publish(); ack({ ok: true });
  });
});
server.listen(4107, '127.0.0.1');
