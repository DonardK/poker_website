import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../dist/app.js';
import { prisma, assertGameSchemaReady } from '../dist/db/prisma.js';
import { signAccessToken } from '../dist/auth/jwt.js';

function replace(t, target, name, implementation) {
  const original = target[name];
  target[name] = implementation;
  t.after(() => { target[name] = original; });
}

test('startup refuses a database without the hand-audit migration', async (t) => {
  replace(t, prisma, '$queryRaw', async () => { throw Object.assign(new Error('column handUuid does not exist'), { code: 'P2010', meta: { code: '42703' } }); });
  await assert.rejects(assertGameSchemaReady(), /20260924120000_compliance_audit_trail/);
  prisma.$queryRaw = async () => { throw new Error('database offline'); };
  await assert.rejects(assertGameSchemaReady(), /database offline/);
});

test('custom tables seat only the human host, reject bots, and do not debit an already seated host', async (t) => {
  const host = { id: 'human-host', username: 'HumanHost', kind: 'HUMAN', bankroll: 10_000 };
  const token = signAccessToken(host.id, host.username, 'human-session');
  let occupied = false;
  let debits = 0;
  let creation = null;
  replace(t, prisma.session, 'findUnique', async () => ({ userId: host.id, expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, user: host }));
  replace(t, prisma.user, 'findUnique', async () => host);
  replace(t, prisma, '$transaction', async (run) => run({
    tableSeat: { findFirst: async () => occupied ? { userId: host.id } : null },
    user: { updateMany: async () => { debits++; return { count: 1 }; } },
    table: { create: async (args) => { creation = args.data; return { id: 'new-human-table' }; } },
  }));
  const server = createServer(createApp());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/tables`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const body = { name: ' Friends table ', maxSeats: 4, smallBlind: 5, bigBlind: 10, buyIn: 1000, botCount: 0 };

  const created = await post(body);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).tableId, 'new-human-table');
  assert.equal(creation.name, 'Friends table');
  assert.equal(creation.seats.create.length, 4);
  assert.deepEqual(creation.seats.create[0], { seatIndex: 0, status: 'OCCUPIED', playerKind: 'HUMAN', userId: host.id, stack: 1000 });
  assert.ok(creation.seats.create.slice(1).every((seat) => seat.status === 'EMPTY'));
  assert.equal(debits, 1);

  const bots = await post({ ...body, botCount: 2 });
  assert.equal(bots.status, 400);
  assert.match((await bots.json()).error, /human players only/);
  assert.equal(debits, 1);

  occupied = true;
  const alreadySeated = await post(body);
  assert.equal(alreadySeated.status, 409);
  assert.match((await alreadySeated.json()).error, /Leave your current table/);
  assert.equal(debits, 1);
});
