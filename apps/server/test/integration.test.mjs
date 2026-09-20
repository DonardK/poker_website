import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../dist/app.js';
import { prisma } from '../dist/db/prisma.js';
import { TableManager, tableManager } from '../dist/game/manager.js';
import { decryptState } from '../dist/game/encryption.js';
import { authenticate } from '../dist/auth/middleware.js';
import { verifyTableCards } from '@poker/shared';
import { completeHand } from '@poker/engine';
import { io as connectSocket } from 'socket.io-client';
import { createSocketServer } from '../dist/socket/index.js';

// Explicit opt-in. Use a disposable database and a separate administrator URL for cleanup.
const enabled = process.env.POKER_INTEGRATION_TESTS === '1';
test('Supabase: transactions, recovery, encrypted history, HTTP auth, socket validation', { skip: !enabled, timeout: 120_000 }, async () => {
  if (!process.env.DATABASE_TEST_ADMIN_URL && process.env.POKER_KEEP_TEST_FIXTURES !== '1') throw new Error('Set DATABASE_TEST_ADMIN_URL for cleanup, or POKER_KEEP_TEST_FIXTURES=1 for administrator cleanup afterwards.');
  const cleanup = process.env.DATABASE_TEST_ADMIN_URL ? new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_ADMIN_URL }) : null;
  const prefix = `qa_${randomUUID().slice(0, 8)}`;
  const userIds = []; const tableIds = []; const managers = [];
  const server = createServer(createApp()); const socketServer = createSocketServer(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, token, cookie) => fetch(url + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let client;
  try {
    const register = await request('/auth/register', { username: prefix, email: prefix + '@example.invalid', password: randomUUID() });
    assert.equal(register.status, 201); const session = await register.json(); userIds.push(session.user.id);
    const cookie = register.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/auth/me', undefined, session.accessToken)).status, 200);
    const refreshes = await Promise.all([request('/auth/refresh', {}, null, cookie), request('/auth/refresh', {}, null, cookie)]);
    assert.deepEqual(refreshes.map((r) => r.status).sort(), [200, 401]);
    const good = refreshes.find((r) => r.status === 200); const renewed = await good.json();
    const nextCookie = good.headers.get('set-cookie').split(';')[0];
    const created = await Promise.all([request('/tables', { name: prefix, smallBlind: 5, bigBlind: 10, buyIn: 1000, botCount: 0, maxSeats: 3 }, renewed.accessToken), request('/tables', { name: prefix + '_race', smallBlind: 5, bigBlind: 10, buyIn: 1000, botCount: 0, maxSeats: 3 }, renewed.accessToken)]);
    assert.deepEqual(created.map((r) => r.status).sort(), [201, 409]);
    const tableId = (await created.find((r) => r.status === 201).json()).tableId; tableIds.push(tableId);
    assert.equal((await prisma.user.findUnique({ where: { id: session.user.id } })).bankroll, 9000);
    assert.equal(await prisma.table.count({ where: { hostId: session.user.id } }), 1);
    const opponent = await prisma.user.create({ data: { username: prefix + '_p2', isGuest: true, bankroll: 1000 } }); userIds.push(opponent.id);
    const manager = new TableManager(); managers.push(manager);
    const claims = await Promise.allSettled([manager.seatClaim(tableId, opponent.id, 1, 1000), manager.seatClaim(tableId, opponent.id, 2, 1000)]);
    assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await prisma.user.findUnique({ where: { id: opponent.id } })).bankroll, 0);
    await manager.tryStart(tableId); manager.stop(); tableManager.stop();
    let state = await manager.get(tableId);
    const root = state.fairness.root; const revision = state.revision;
    const snapshot = await manager.snapshot(tableId, session.user.id); manager.stop();
    assert.ok(await verifyTableCards(snapshot)); assert.equal(snapshot.players[1].holeCards, null);
    const recovery = new TableManager(); managers.push(recovery);
    assert.deepEqual(await recovery.get(tableId), state);
    const actor = state.players[state.toActSeat];
    const action = 'CALL';
    const repeated = await Promise.allSettled([manager.intent(tableId, actor.userId, { action }, revision), recovery.intent(tableId, actor.userId, { action }, revision)]);
    manager.stop(); recovery.stop(); assert.equal(repeated.filter((r) => r.status === 'fulfilled').length, 1);
    await assert.rejects(manager.mutate(tableId, async (current, tx) => { await tx.user.update({ where: { id: opponent.id }, data: { bankroll: { increment: 777 } } }); throw new Error('intentional rollback'); }));
    assert.equal((await prisma.user.findUnique({ where: { id: opponent.id } })).bankroll, 0);
    for (let n = 0; n < 40; n++) {
      state = await manager.get(tableId); if (state.phase === 'SHOWDOWN') break;
      const a = state.players[state.toActSeat];
      const view = await manager.snapshot(tableId, a.userId); manager.stop();
      await manager.intent(tableId, a.userId, { action: view.actorLegal.actions.includes('CHECK') ? 'CHECK' : 'CALL' }, state.revision); manager.stop();
    }
    state = await manager.get(tableId); assert.equal(state.phase, 'SHOWDOWN');
    assert.equal(state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0), 2000);
    const history = await prisma.hand.findUnique({ where: { tableId_handNumber: { tableId, handNumber: 1 } }, include: { actions: true, players: true, pots: true } });
    assert.equal(history.fairnessRoot, root); assert.ok(history.actions.some((a) => a.street === 'RIVER'));
    assert.ok(history.players.every((p) => p.holeCards.length === 0 && p.encryptedHoleCards.startsWith('v1.')));
    assert.equal(decryptState(history.fairnessAudit, `hand:${tableId}:1`).root, root);
    assert.equal(history.players.reduce((sum, p) => sum + p.net, 0), 0);
    await assert.rejects(prisma.hand.update({ where: { id: history.id }, data: { potTotal: 999 } }));
    await manager.mutate(tableId, (current) => completeHand(current)); manager.stop();
    await manager.standUp(tableId, session.user.id); manager.stop();
    const bankroll = (await prisma.user.findUnique({ where: { id: session.user.id } })).bankroll;
    await assert.rejects(manager.standUp(tableId, session.user.id));
    assert.equal((await prisma.user.findUnique({ where: { id: session.user.id } })).bankroll, bankroll);
    client = connectSocket(url, { auth: { token: renewed.accessToken }, transports: ['websocket'], autoConnect: false });
    client.connect(); await once(client, 'connect');
    const invalid = once(client, 'SERVER_ERROR'); client.emit('SEAT_CLAIM', { tableId, seatIndex: 1.2, buyIn: -1 });
    assert.equal((await invalid)[0].code, 'INVALID_REQUEST');
    assert.equal((await request('/auth/logout', {}, null, nextCookie)).status, 204);
    await assert.rejects(authenticate(renewed.accessToken));
    assert.equal((await request('/auth/me', undefined, renewed.accessToken)).status, 401);
    console.log('Verified concurrency, rollback, full hand, encrypted history, immutable records, restart recovery, socket validation and session revocation.');
  } finally {
    client?.disconnect(); for (const manager of managers) manager.stop(); tableManager.stop();
    await new Promise((r) => socketServer.close(r)); server.close();
    // Runtime credentials deliberately cannot erase hand history through parent deletes.
    if (cleanup && tableIds.length) await cleanup.table.deleteMany({ where: { id: { in: tableIds }, name: { startsWith: prefix } } });
    if (cleanup && userIds.length) await cleanup.user.deleteMany({ where: { id: { in: userIds }, username: { startsWith: prefix } } });
    if (cleanup) await cleanup.$disconnect();
    else console.log(JSON.stringify({ cleanupRequired: { prefix, tableIds, userIds } }));
    await prisma.$disconnect();
  }
});
