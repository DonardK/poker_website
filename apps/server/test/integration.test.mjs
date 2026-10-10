import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../dist/app.js';
import { authConfig } from '../dist/config.js';
import { prisma } from '../dist/db/prisma.js';
import { TableManager, tableManager } from '../dist/game/manager.js';
import { decryptState } from '../dist/game/encryption.js';
import { authenticate } from '../dist/auth/middleware.js';
import { signAccessToken } from '../dist/auth/jwt.js';
import { sealedAuditContext } from '../dist/game/audit.js';
import { UUID_V4, verifyParticipantAudit, verifySealedAudit, verifyTableCards } from '@poker/shared';
import { completeHand } from '@poker/engine';
import { io as connectSocket } from 'socket.io-client';
import { createSocketServer } from '../dist/socket/index.js';

// Explicit opt-in. Use a disposable database and a separate administrator URL for cleanup.
const enabled = process.env.POKER_INTEGRATION_TESTS === '1';
test('Supabase: transactions, recovery, encrypted history, audit trail routes, HTTP auth, socket validation', { skip: !enabled, timeout: 120_000 }, async () => {
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
    const register = await request('/auth/register', { username: prefix, email: prefix + '@example.invalid', password: randomUUID(), acceptTerms: true, confirmAge: true, termsVersion: authConfig.termsVersion });
    const registerBody = await register.text();
    assert.equal(register.status, 201, registerBody);
    const session = JSON.parse(registerBody); userIds.push(session.user.id);
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
    assert.equal(state.phase, 'PREFLOP', 'tryStart deals at once: no player entropy round');
    const root = state.fairness.root; const handId = state.fairness.handId; const revision = state.revision;
    assert.match(handId, UUID_V4); assert.equal(state.audit.handId, handId); assert.equal(state.audit.events[0].type, 'HAND_STARTED');
    const snapshot = await manager.snapshot(tableId, session.user.id); manager.stop();
    assert.ok(await verifyTableCards(snapshot)); assert.equal(snapshot.players[1].holeCards, null);
    assert.equal(snapshot.fairness.handId, handId); assert.equal(snapshot.fairness.deckCommitment, state.fairness.deckCommitment);
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
    assert.ok(history.players.every((p) => p.holeCards.length === 0 && p.encryptedHoleCards.startsWith('v2.')));
    assert.equal(history.players.reduce((sum, p) => sum + p.net, 0), 0);
    // Compliance audit columns, written in the settling transaction.
    assert.equal(history.fairnessAudit, null, 'the legacy commitment column is not written for audited hands');
    assert.equal(history.handUuid, handId); assert.equal(history.auditRecord.handId, handId);
    assert.equal(history.deckCommitment, history.auditRecord.deckCommitment); assert.equal(history.finalStateHash, history.auditRecord.finalStateHash);
    assert.match(history.finalStateHash, /^[a-f0-9]{64}$/); assert.equal(history.auditRecord.previousHandHash, null);
    const sealed = decryptState(history.auditSealed, sealedAuditContext(tableId, 1));
    const sealedReport = await verifySealedAudit(history.auditRecord, sealed);
    assert.equal(sealedReport.ok, true, sealedReport.reason);
    for (const p of history.players) {
      assert.deepEqual(decryptState(p.encryptedHoleCards, `hand:${tableId}:1:seat:${p.seatIndex}`), sealedReport.holeCards.find((h) => h.seatIndex === p.seatIndex).cards);
    }
    // Participant route: redacted, verifiable, only for players dealt in.
    const participant = await request(`/tables/${tableId}/hands/1/audit`, undefined, renewed.accessToken);
    assert.equal(participant.status, 200);
    const { audit } = await participant.json();
    assert.equal(audit.viewerSeat, history.players.find((p) => p.userId === session.user.id).seatIndex);
    // Bound to the request: this table, hand #1, this user, and the hand id seen live.
    const participantCheck = await verifyParticipantAudit(audit, { tableId, handNumber: 1, userId: session.user.id, handId });
    assert.equal(participantCheck.ok, true, participantCheck.reason);
    const auditBody = JSON.stringify(audit);
    assert.ok(!auditBody.includes(sealed.deckSalt) && !auditBody.includes('"deck":') && !auditBody.includes('"merkleSalts":'));
    assert.equal((await request(`/tables/${tableId}/hands/2/audit`, undefined, renewed.accessToken)).status, 404);
    assert.equal((await request(`/tables/${tableId}/hands/1e0/audit`, undefined, renewed.accessToken)).status, 400);
    // Regulator route: ADMIN only (checked against the database row), UUID v4 only.
    assert.equal((await request(`/admin/hands/${handId}/audit`, undefined, renewed.accessToken)).status, 403);
    const admin = await prisma.user.create({ data: { username: prefix + '_adm', role: 'ADMIN', isGuest: true, bankroll: 0 } }); userIds.push(admin.id);
    const adminSession = await prisma.session.create({ data: { userId: admin.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 600_000) } });
    const adminToken = signAccessToken(admin.id, admin.username, adminSession.id);
    assert.equal((await request('/admin/hands/not-a-uuid/audit', undefined, adminToken)).status, 400);
    assert.equal((await request(`/admin/hands/${randomUUID()}/audit`, undefined, adminToken)).status, 404);
    const regulator = await request(`/admin/hands/${handId}/audit`, undefined, adminToken);
    assert.equal(regulator.status, 200);
    const regulatorView = await regulator.json();
    assert.equal(regulatorView.verification.ok, true, regulatorView.verification.reason);
    assert.deepEqual(regulatorView.sealed, sealed); assert.deepEqual(regulatorView.verification.holeCards, sealedReport.holeCards);
    assert.deepEqual(regulatorView.verification.burns, sealedReport.burns);
    // Outcome replay and the per-table chain link (hand #1 is the table's first audited hand).
    assert.deepEqual(regulatorView.verification.outcome, { ok: true });
    assert.deepEqual(regulatorView.verification.tableChain, { ok: true, previousHandNumber: null });
    assert.equal((await request(`/tables/${tableId}/hands/1/audit`, undefined, adminToken)).status, 404, 'players not dealt in cannot read a hand audit');
    // Hand rows, including every audit column, are append-only to the runtime role.
    await assert.rejects(prisma.hand.update({ where: { id: history.id }, data: { potTotal: 999 } }));
    await assert.rejects(prisma.hand.update({ where: { id: history.id }, data: { finalStateHash: '0'.repeat(64) } }));
    await manager.mutate(tableId, (current) => completeHand(current)); manager.stop();
    await manager.standUp(tableId, session.user.id); manager.stop();
    const bankroll = (await prisma.user.findUnique({ where: { id: session.user.id } })).bankroll;
    assert.equal(await manager.standUp(tableId, session.user.id), false, 'a second stand-up finds an empty seat and pays nothing');
    assert.equal((await prisma.user.findUnique({ where: { id: session.user.id } })).bankroll, bankroll);
    client = connectSocket(url, { auth: { token: renewed.accessToken }, transports: ['websocket'], autoConnect: false });
    client.connect(); await once(client, 'connect');
    const invalid = once(client, 'SERVER_ERROR'); client.emit('SEAT_CLAIM', { tableId, seatIndex: 1.2, buyIn: -1 });
    assert.equal((await invalid)[0].code, 'INVALID_REQUEST');
    assert.equal((await request('/auth/logout', {}, null, nextCookie)).status, 204);
    await assert.rejects(authenticate(renewed.accessToken));
    assert.equal((await request('/auth/me', undefined, renewed.accessToken)).status, 401);
    console.log('Verified concurrency, rollback, full hand, encrypted history, audit trail and routes (outcome replay, table chain, request-bound participant audit), immutable records, restart recovery, socket validation and session revocation.');
  } finally {
    client?.disconnect(); for (const manager of managers) manager.stop(); tableManager.stop();
    await new Promise((r) => socketServer.close(r)); server.close();
    // Hand history is append-only unless poker.break_glass is on, and deleting a
    // table or user does not cascade into it. Clear the hands first, then the
    // tables and users, in one transaction so the setting stays local.
    if (cleanup) {
      try {
        await cleanup.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('poker.break_glass', 'on', true)`;
          if (tableIds.length) {
            await tx.hand.deleteMany({ where: { tableId: { in: tableIds }, table: { name: { startsWith: prefix } } } });
            await tx.table.deleteMany({ where: { id: { in: tableIds }, name: { startsWith: prefix } } });
          }
          if (userIds.length) await tx.user.deleteMany({ where: { id: { in: userIds }, username: { startsWith: prefix } } });
        });
      } finally {
        await cleanup.$disconnect();
      }
    }
    else console.log(JSON.stringify({ cleanupRequired: { prefix, tableIds, userIds } }));
    await prisma.$disconnect();
  }
});
