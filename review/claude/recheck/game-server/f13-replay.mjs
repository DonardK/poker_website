/**
 * F13 re-check: an older valid ciphertext of a table's state is accepted on load
 * (no freshness binding). Real TableManager (dist), Prisma stubbed in memory,
 * DATABASE_URL set to a dead loopback port before any server import.
 * Usage (repo root): node review/claude/recheck/game-server/f13-replay.mjs
 */
import { randomBytes } from 'node:crypto';
const DEAD = 'postgresql://review:unused@127.0.0.1:1/review';
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: DEAD, DIRECT_URL: DEAD, REDIS_URL: '', GAME_ENCRYPTION_KEYS: '', GAME_ENCRYPTION_ACTIVE_KEY_ID: '',
  GAME_ENCRYPTION_KEY: randomBytes(32).toString('hex'), JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex') });
const E = await import('../../../../packages/engine/dist/index.js');
const { prisma } = await import('../../../../apps/server/dist/db/prisma.js');
const { TableManager } = await import('../../../../apps/server/dist/game/manager.js');
const { encryptState } = await import('../../../../apps/server/dist/game/encryption.js');
let t = E.createTable({ tableId: 'replay', name: 'r', maxSeats: 3, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
for (let i = 0; i < 3; i++) t = E.sitDown(t, i, { userId: `P${i}`, username: `P${i}`, avatarHue: 0, kind: 'HUMAN', botProfile: null, buyIn: 1000 });
t = E.startHand(t); t.revision = 1;
const old = encryptState(t, 'table:replay');
const l = E.legalActions(t, t.toActSeat); const newer = E.applyAction(t, t.players[t.toActSeat].userId, { action: l.actions.includes('CHECK') ? 'CHECK' : 'CALL' }); newer.revision = 2;
const row = { id: 'replay', status: 'IN_HAND', createdAt: new Date(), updatedAt: new Date(), stateCiphertext: encryptState(newer, 'table:replay') };
prisma.table.findUnique = async () => ({ ...row });
const m = new TableManager(); m.stop();
const current = await m.get('replay');
row.stateCiphertext = old; // a restored/replayed older row
const replayed = await m.get('replay');
console.log(JSON.stringify({ storedRevision: current.revision, afterReplacingWithOlderCiphertext: replayed.revision, olderStateAccepted: replayed.revision < current.revision,
  actionsBefore: current.actions.length, actionsAfterReplay: replayed.actions.length }));
await prisma.$disconnect().catch(() => {});
