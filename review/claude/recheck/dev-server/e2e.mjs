/**
 * End-to-end check of today's fixes with the REAL game-server source (tsx src/index.ts) and a REAL
 * PostgreSQL: the disposable embedded cluster from apps/server/test/support/pg.mjs (127.0.0.1, random
 * ports, random secrets; never the configured database, never ports 3000/4000/3107/4107).
 *
 *  B. A database at the 2026-09-24 schema (first five migrations): the server must refuse to start and
 *     name the missing migrations.
 *  C. The database is unreachable when the server starts (development): the server must stay alive,
 *     say why, and come up once the database answers (a local TCP proxy is switched on later).
 *  D. On that server: three guests; a host creates a table; two players sit down exactly as the buy-in
 *     dialog does (commandId + ack); a hand is played exactly as the action bar sends actions (turnId);
 *     after a bystander sits out mid-turn the actor's action is still accepted (CR-008), and an action for
 *     a finished turn is refused as stale.
 *
 * Usage: node review/claude/recheck/dev-server/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const serverDir = join(repo, 'apps/server');
const harness = await import(pathToFileURL(join(serverDir, 'test/support/pg.mjs')).href);
const { default: pg } = await import('pg');
const { io: connect } = await import('socket.io-client');
const { SOCKET_EVENTS } = await import(pathToFileURL(join(repo, 'packages/shared/dist/index.js')).href);

const ORIGIN = 'http://localhost:3000';
const ansi = /\u001b\[[0-9;]*m/g;
const results = {};
const children = [];
const cleanups = [];

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const secrets = () => ({ GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'), JWT_ACCESS_SECRET: randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: randomBytes(48).toString('hex') });

/** Start the real server source; returns { child, port, output(), exited }. */
function startServer(databaseUrl, port) {
  harness.assertLoopbackUrl(databaseUrl, 'e2e DATABASE_URL');
  const output = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, ...secrets(), DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, PORT: String(port), HOST: '127.0.0.1',
      NODE_ENV: 'development', CLIENT_ORIGIN: ORIGIN, REDIS_URL: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '', DEFAULT_STARTING_BANKROLL: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => { for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) output.push(line.replace(ansi, '')); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const state = { child, port, output: () => output, exit: null };
  state.exited = new Promise((res) => child.on('exit', (code, signal) => { state.exit = { code, signal }; res(state.exit); }));
  children.push(state);
  return state;
}
const http = async (base, path, init = {}) => {
  try {
    const res = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
    const text = await res.text(); let body = text; try { body = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body };
  } catch (err) { return { status: 0, error: String(err?.cause?.code ?? err?.message ?? err) }; }
};
const waitFor = async (predicate, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await predicate(); if (v) return v; await sleep(200); } throw new Error(`timed out waiting for ${what}`); };

let db;
try {
  db = await harness.startTestDatabase({ log: (line) => console.error(line) });
  const admin = new pg.Client({ connectionString: db.adminUrl }); await admin.connect(); cleanups.push(() => admin.end());

  // ---- B: a database at the 2026-09-24 schema --------------------------------------------------------
  await admin.query('CREATE DATABASE poker_old');
  const oldAdmin = new pg.Client({ connectionString: harness.withDatabase(db.adminUrl, 'poker_old') }); await oldAdmin.connect();
  const migrations = harness.migrationNames();
  const before = migrations.filter((name) => name < '20261001');
  for (const name of before) await oldAdmin.query(readFileSync(join(harness.migrationsDir, name, 'migration.sql'), 'utf8'));
  await oldAdmin.end();
  const oldUrl = harness.withDatabase(db.runtimeUrl, 'poker_old');
  const serverB = startServer(oldUrl, await freePort());
  const exitB = await Promise.race([serverB.exited, sleep(45_000).then(() => null)]);
  const refusal = serverB.output().find((line) => /missing migration/i.test(line)) ?? null;
  results.B_oldSchema = { migrationsApplied: before, exitedWith: exitB, refusalLine: refusal,
    namesAuthHardening: /20261001100000_auth_hardening/.test(refusal ?? ''), namesGameReliability: /20261003100000_game_reliability/.test(refusal ?? ''),
    namesLedger: /ledger_foundation/.test(refusal ?? '') };
  if (!exitB) serverB.child.kill();

  // ---- C: database unreachable at start (development), then reachable --------------------------------
  const proxyPort = await freePort();
  const password = randomBytes(18).toString('hex');
  await admin.query(`ALTER ROLE poker_server WITH LOGIN PASSWORD '${password}'`);
  const realPort = new URL(db.runtimeUrl).port;
  const viaProxy = `postgresql://poker_server:${password}@127.0.0.1:${proxyPort}/poker_test?sslmode=disable`;
  const apiPort = await freePort();
  const serverC = startServer(viaProxy, apiPort);
  const base = `http://127.0.0.1:${apiPort}`;
  await sleep(6_000);
  const waiting = serverC.output().filter((line) => /database unavailable/i.test(line));
  results.C_unreachableAtStart = { aliveAfter6s: serverC.exit === null, retryLogLines: waiting.length, firstRetryLine: waiting[0] ?? null,
    healthWhileWaiting: (await http(base, '/api/health')).status };
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(realPort), '127.0.0.1');
    client.pipe(upstream).pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end); upstream.on('error', end);
  });
  await new Promise((res) => proxy.listen(proxyPort, '127.0.0.1', res));
  cleanups.push(() => new Promise((res) => proxy.close(res)));
  const upAt = Date.now();
  await waitFor(async () => (await http(base, '/api/health')).status === 200, 60_000, 'the server to come up after the database');
  results.C_unreachableAtStart.cameUpAfterDatabaseMs = Date.now() - upAt;
  results.C_unreachableAtStart.ready = (await http(base, '/api/ready')).status;

  // ---- D: join and play exactly as the web client does ------------------------------------------------
  let termsVersion = '2026-10-01';
  const guest = async () => {
    let reply = await http(base, '/api/auth/guest', { method: 'POST', body: JSON.stringify({ acceptTerms: true, confirmAge: true, termsVersion }) });
    if (reply.status === 409 && reply.body?.currentVersion) { termsVersion = reply.body.currentVersion; reply = await http(base, '/api/auth/guest', { method: 'POST', body: JSON.stringify({ acceptTerms: true, confirmAge: true, termsVersion }) }); }
    if (reply.status !== 201) throw new Error(`guest creation failed: ${reply.status} ${JSON.stringify(reply.body)}`);
    return { token: reply.body.accessToken, user: reply.body.user };
  };
  const players = [await guest(), await guest(), await guest()];
  const created = await http(base, '/api/tables', { method: 'POST', headers: { Authorization: `Bearer ${players[0].token}` }, body: JSON.stringify({ name: 'E2E', smallBlind: 5, bigBlind: 10, buyIn: 1000, maxSeats: 6 }) });
  if (created.status !== 201) throw new Error(`table creation failed: ${created.status} ${JSON.stringify(created.body)}`);
  const tableId = created.body.tableId;
  const sockets = [];
  for (const p of players) {
    const c = connect(base, { transports: ['websocket'], extraHeaders: { Origin: ORIGIN }, auth: { token: p.token }, reconnection: false });
    const s = { c, user: p.user, snap: null, errors: [] };
    c.on(SOCKET_EVENTS.STATE_SNAPSHOT, (snap) => { if (snap.tableId === tableId && (!s.snap || snap.revision >= s.snap.revision)) s.snap = snap; });
    c.on(SOCKET_EVENTS.SERVER_ERROR, (e) => s.errors.push(e));
    await once(c, SOCKET_EVENTS.AUTH_OK);
    c.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId });
    sockets.push(s);
  }
  cleanups.push(() => { for (const s of sockets) s.c.disconnect(); });
  await waitFor(() => sockets.every((s) => s.snap), 10_000, 'snapshots for every player');
  // Seats 1 and 2, exactly as apps/web/src/components/table/buy-in-dialog.tsx sends them.
  const claims = [];
  for (const [i, seatIndex] of [[1, 1], [2, 2]]) {
    claims.push(await sockets[i].c.timeout(8000).emitWithAck(SOCKET_EVENTS.SEAT_CLAIM, { tableId, seatIndex, buyIn: 1000, commandId: randomUUID() }));
  }
  results.D_join = { seatClaimAcks: claims };
  const latest = () => sockets.map((s) => s.snap).filter(Boolean).sort((a, b) => b.revision - a.revision)[0];
  await waitFor(() => latest()?.toActSeat != null && latest()?.turnId, 15_000, 'a hand to start');
  const socketOfSeat = (seat) => sockets.find((s) => s.user.id === latest().players[seat]?.userId);
  // apps/web/src/components/table/action-bar.tsx: revision, action, clientActionId and turnId.
  const act = async (snap, overrides = {}) => {
    const actor = socketOfSeat(snap.toActSeat);
    await waitFor(() => actor.snap?.turnId === snap.turnId && actor.snap.actorLegal, 5_000, 'the actor to see their turn');
    const legal = actor.snap.actorLegal.actions;
    const action = legal.includes('CHECK') ? 'CHECK' : 'CALL';
    return actor.c.timeout(8000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, { tableId, revision: snap.revision, action, clientActionId: randomUUID(), turnId: snap.turnId, ...overrides });
  };
  const first = latest();
  const firstReply = await act(first);
  await waitFor(() => latest().turnId && latest().turnId !== first.turnId, 8_000, 'the turn to move');
  const second = latest();
  // A bystander (not the actor) sits out mid-turn: the revision changes, the turn does not.
  const bystander = sockets.find((s) => s.user.id !== second.players[second.toActSeat].userId);
  const sitOutAck = await bystander.c.timeout(8000).emitWithAck(SOCKET_EVENTS.SIT_OUT, { tableId, commandId: randomUUID() });
  await waitFor(() => latest().revision > second.revision, 8_000, 'the sit-out snapshot');
  const afterSitOut = latest();
  const secondReply = await act(second); // old revision, same turnId
  await waitFor(() => latest().turnId !== second.turnId, 8_000, 'the turn to move again');
  const staleReply = await socketOfSeat(latest().toActSeat).c.timeout(8000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, {
    tableId, revision: latest().revision, action: 'FOLD', clientActionId: randomUUID(), turnId: second.turnId });
  results.D_play = {
    handStarted: { phase: first.phase, turnId: first.turnId },
    firstActionAck: firstReply,
    sitOutAck,
    revisionBumpedButTurnUnchanged: afterSitOut.revision > second.revision && afterSitOut.turnId === second.turnId,
    actionWithOldRevisionSameTurnAck: secondReply,
    actionForFinishedTurnAck: staleReply,
    unexpectedServerErrors: sockets.flatMap((s) => s.errors).filter((e) => e.code !== 'STALE_ACTION'),
  };
} catch (err) {
  results.error = String(err?.stack ?? err);
} finally {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
  for (const s of children) if (s.exit === null) s.child.kill();
  await sleep(500);
  if (db) await db.stop();
}
console.log(JSON.stringify(results, null, 2));
const c = results.C_unreachableAtStart;
const failedServer = children.find((s) => s.exit && s.exit.code !== 0 && s !== children[0]);
if (results.error || failedServer) console.log('--- server output (last 30 lines) ---\n' + (failedServer ?? children.at(-1))?.output().slice(-30).join('\n'));
process.exit(results.error ? 1 : 0);
