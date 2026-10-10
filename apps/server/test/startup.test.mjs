/**
 * Start-up: the database connection is explained in plain words (the safe-log
 * serializer drops Prisma's own messages), retried in development, and the
 * schema check names every migration this version still needs. No database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDatabase, DatabaseConnectError, describeDatabaseFailure } from '../dist/db/connect.js';
import { assertGameSchemaReady, prisma } from '../dist/db/prisma.js';
import { assertRestrictedRuntimeRole, enforceRuntimeRole, RuntimeRoleError } from '../dist/db/runtime-role.js';
import { serializeError } from '../dist/security/safe-log.js';

const SUPABASE_DIRECT = 'postgresql://poker_server:s3cret-pass@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require';
const POOLER = 'postgresql://poker_server.abcdefghijklmnopqrst:s3cret-pass@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require';
const prismaInitError = (message, errorCode) => Object.assign(new Error(message), { name: 'PrismaClientInitializationError', errorCode });
const unreachable = (host) => prismaInitError(`Can't reach database server at \`${host}\``, 'P1001');

test('an unreachable Supabase direct host is explained with the IPv6 advice; credentials are never named', () => {
  const failure = describeDatabaseFailure(unreachable('db.abcdefghijklmnopqrst.supabase.co:5432'), SUPABASE_DIRECT);
  assert.equal(failure.code, 'P1001');
  assert.equal(failure.retryable, true);
  assert.equal(failure.host, 'db.abcdefghijklmnopqrst.supabase.co:5432');
  assert.match(failure.hint, /^Cannot reach the database at db\.abcdefghijklmnopqrst\.supabase\.co:5432\./);
  assert.match(failure.hint, /IPv6/);
  assert.match(failure.hint, /Session pooler/);
  assert.doesNotMatch(failure.hint, /s3cret|poker_server/);
});

test('a pooler host gets no IPv6 advice, and a rejected login is not treated as retryable', () => {
  const pooler = describeDatabaseFailure(unreachable('aws-0-eu-west-1.pooler.supabase.com:5432'), POOLER);
  assert.equal(pooler.retryable, true);
  assert.doesNotMatch(pooler.hint, /IPv6/);
  const login = describeDatabaseFailure(prismaInitError('Authentication failed against database server', 'P1000'), POOLER);
  assert.equal(login.retryable, false);
  assert.match(login.hint, /rejected the login in DATABASE_URL/);
  assert.doesNotMatch(login.hint, /s3cret/);
  // A message-only Prisma error is still recognised.
  assert.equal(describeDatabaseFailure(new Error("Can't reach database server at `h:1`"), 'postgresql://h:1/db').code, 'P1001');
});

test('in development an unreachable database is retried with back-off until it answers', async () => {
  let calls = 0;
  const client = { $connect: async () => { if (++calls < 5) throw unreachable('h:5432'); } };
  const waits = [];
  const retries = [];
  await connectDatabase(client, { url: 'postgresql://u:p@h:5432/db', retry: true, maxDelayMs: 5_000,
    sleep: async (ms) => { waits.push(ms); }, onRetry: (failure, attempt) => retries.push([failure.code, attempt]) });
  assert.equal(calls, 5);
  assert.deepEqual(waits, [1000, 2000, 4000, 5000]);
  assert.deepEqual(retries, [['P1001', 1], ['P1001', 2], ['P1001', 3], ['P1001', 4]]);
});

test('without retry the first failure is fatal, and the logged error keeps the explanation', async () => {
  const client = { $connect: async () => { throw unreachable('db.abcdefghijklmnopqrst.supabase.co:5432'); } };
  let thrown;
  await assert.rejects(connectDatabase(client, { url: SUPABASE_DIRECT, retry: false }), (err) => { thrown = err; return true; });
  assert.ok(thrown instanceof DatabaseConnectError);
  assert.equal(thrown.code, 'P1001');
  const logged = serializeError(thrown, false);
  assert.equal(logged.name, 'DatabaseConnectError');
  assert.match(logged.message, /Cannot reach the database at db\.abcdefghijklmnopqrst\.supabase\.co:5432/);
  // Prisma's own message is still withheld by the serializer; ours carries the reason.
  assert.equal(logged.cause.name, 'PrismaClientInitializationError');
  assert.equal(logged.cause.message, undefined);
  assert.doesNotMatch(JSON.stringify(logged), /s3cret/);
});

test('a rejected login is fatal at once, even in development', async () => {
  let calls = 0;
  const client = { $connect: async () => { calls++; throw prismaInitError('Authentication failed against database server', 'P1000'); } };
  await assert.rejects(connectDatabase(client, { url: POOLER, retry: true, sleep: async () => {} }), { name: 'DatabaseConnectError', code: 'P1000' });
  assert.equal(calls, 1);
});

test('the schema check names every missing migration, passes a current database, and rethrows other errors', async (t) => {
  const original = prisma.$queryRaw;
  t.after(() => { prisma.$queryRaw = original; });
  const missingColumn = () => Object.assign(new Error('column does not exist'), { code: 'P2010', meta: { code: '42703' } });
  // A database at the 2026-09-24 schema: the October columns are missing.
  prisma.$queryRaw = async (strings) => {
    const sql = strings.join('?');
    if (sql.includes('"usernameCanonical"') || sql.includes('"previousTokenHash"') || sql.includes('"pausedAt"')) throw missingColumn();
    return [];
  };
  await assert.rejects(assertGameSchemaReady(), (err) => {
    assert.match(err.message, /20261001100000_auth_hardening/);
    assert.match(err.message, /20261003100000_game_reliability/);
    assert.doesNotMatch(err.message, /compliance_audit_trail/);
    assert.equal((err.message.match(/auth_hardening/g) ?? []).length, 1, 'each migration is named once');
    return true;
  });
  prisma.$queryRaw = async () => [];
  await assertGameSchemaReady();
  prisma.$queryRaw = async () => { throw new Error('database offline'); };
  await assert.rejects(assertGameSchemaReady(), /database offline/);
});

const cleanRole = { currentUser: 'poker_app', superuser: false, bypassRls: false, handUpdate: false, handDelete: false };

test('production refuses a superuser, BYPASSRLS, or UPDATE/DELETE on Hand', async () => {
  await enforceRuntimeRole('development', async () => { throw new Error('should not query'); });
  await enforceRuntimeRole('test', async () => { throw new Error('should not query'); });
  assertRestrictedRuntimeRole(cleanRole);
  await enforceRuntimeRole('production', async () => [cleanRole]);
  for (const [patch, pattern] of [
    [{ superuser: true }, /superuser/],
    [{ bypassRls: true }, /BYPASSRLS/],
    [{ handUpdate: true }, /UPDATE/],
    [{ handDelete: true }, /DELETE/],
    [{ superuser: 't', bypassRls: 'on' }, /superuser/],
  ]) {
    await assert.rejects(enforceRuntimeRole('production', async () => [{ ...cleanRole, ...patch }]), pattern);
  }
  await assert.rejects(enforceRuntimeRole('production', async () => []), RuntimeRoleError);
  await assert.rejects(enforceRuntimeRole('production', async () => [{ currentUser: 'poker_app' }]), /did not return superuser/);
  let seen = '';
  await enforceRuntimeRole('production', async (sql) => { seen = sql; return [cleanRole]; });
  assert.match(seen, /has_table_privilege/);
  assert.match(seen, /"Hand"/);
});
