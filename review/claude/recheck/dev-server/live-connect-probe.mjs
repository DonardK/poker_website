/**
 * READ-ONLY connectivity and schema probe for the project's configured database (the one `npm run dev`
 * uses). It does what the game server does in its first two start-up steps (connect, one SELECT) and then
 * runs catalog-only SELECTs. It never writes, never starts the game server, never runs recovery, and
 * never prints credentials: only success/failure, timing, a scrubbed error line (Prisma names host:port
 * in its "can't reach" message) and booleans.
 *
 * Usage (from anywhere): node review/claude/recheck/dev-server/live-connect-probe.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises';

const scrub = (text) => String(text ?? '')
  .replace(/postgres(ql)?:\/\/\S+/gi, '<url>')
  .replace(/(password|passwd|pwd)=\S+/gi, '$1=<hidden>')
  .split(/\r?\n/).filter((line) => line.trim()).slice(0, 3).join(' | ').slice(0, 400);

const out = { connected: false };
const started = Date.now();
let prisma;
try {
  ({ prisma } = await import('../../../../apps/server/dist/db/prisma.js'));
  await Promise.race([prisma.$connect(), sleep(25_000).then(() => { throw Object.assign(new Error('no answer within 25 s'), { code: 'PROBE_TIMEOUT' }); })]);
  out.connected = true;
  out.connectMs = Date.now() - started;
  const [{ one }] = await prisma.$queryRaw`SELECT 1 AS one`;
  out.selectOne = Number(one) === 1;
  const [{ ro }] = await prisma.$queryRaw`SELECT current_setting('transaction_read_only') AS ro`;
  out.sessionReadOnlyDefault = ro;
  // Catalog-only: which objects do the three October migrations create? (true = present)
  const col = async (table, column) => {
    const rows = await prisma.$queryRaw`SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
    return rows.length > 0;
  };
  const rel = async (name) => {
    const rows = await prisma.$queryRaw`SELECT to_regclass(${'public."' + name + '"'}) IS NOT NULL AS present`;
    return Boolean(rows[0]?.present);
  };
  out.schema = {
    auth_hardening: {
      'User.usernameCanonical': await col('User', 'usernameCanonical'),
      'User.termsVersion': await col('User', 'termsVersion'),
      'User.failedLoginCount': await col('User', 'failedLoginCount'),
      'Session.previousTokenHash': await col('Session', 'previousTokenHash'),
      'Session.revokedAt': await col('Session', 'revokedAt'),
    },
    ledger_foundation: {
      Asset: await rel('Asset'), LedgerAccount: await rel('LedgerAccount'),
      LedgerTransaction: await rel('LedgerTransaction'), LedgerEntry: await rel('LedgerEntry'),
    },
    game_reliability: { 'Table.pausedAt': await col('Table', 'pausedAt'), TableIncident: await rel('TableIncident') },
  };
  out.schemaVerdict = Object.fromEntries(Object.entries(out.schema).map(([migration, checks]) => [migration, Object.values(checks).every(Boolean) ? 'applied' : Object.values(checks).some(Boolean) ? 'PARTLY applied' : 'NOT applied']));
} catch (err) {
  out.error = { code: err?.code ?? err?.name ?? 'Error', message: scrub(err?.message) };
  out.afterMs = Date.now() - started;
} finally {
  try { await prisma?.$disconnect(); } catch { /* nothing to close */ }
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.connected ? 0 : 1);
