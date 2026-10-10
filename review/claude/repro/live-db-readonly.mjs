/**
 * Claude review — READ-ONLY aggregate checks of the configured database.
 * Runs inside a transaction set READ ONLY; prints counts only (no names,
 * emails, ids, IPs, balances of individuals, ciphertext or cards).
 *
 * Usage: node review/claude/repro/live-db-readonly.mjs
 * (Uses the repository .env; run only where that is intended.)
 */
const { prisma } = await import('../../../apps/server/dist/db/prisma.js');

const n = (rows) => Number(rows[0]?.n ?? 0);
try {
  const report = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const q = async (sql) => n(await tx.$queryRawUnsafe(sql));
    return {
      tablesByStatus: Object.fromEntries((await tx.$queryRaw`SELECT status::text AS s, COUNT(*)::int AS n FROM public."Table" GROUP BY status`).map((r) => [r.s, r.n])),
      openTablesUntouchedOver24h: await q(`SELECT COUNT(*)::int AS n FROM public."Table" WHERE status IN ('WAITING','IN_HAND') AND "updatedAt" < now() - interval '24 hours'`),
      openTablesWithSeatedPlayersUntouchedOver24h: await q(`SELECT COUNT(DISTINCT t.id)::int AS n FROM public."Table" t JOIN public."TableSeat" s ON s."tableId" = t.id AND s."userId" IS NOT NULL WHERE t.status IN ('WAITING','IN_HAND') AND t."updatedAt" < now() - interval '24 hours'`),
      openTablesNeedingRecovery: await q(`SELECT COUNT(*)::int AS n FROM public."Table" t WHERE t.status IN ('WAITING','IN_HAND') AND t."stateCiphertext" IS NULL AND (t.status = 'IN_HAND' OR EXISTS (SELECT 1 FROM public."Hand" h WHERE h."tableId" = t.id))`),
      occupiedSeatsAtClosedTables: await q(`SELECT COUNT(*)::int AS n FROM public."TableSeat" s JOIN public."Table" t ON t.id = s."tableId" WHERE t.status = 'CLOSED' AND s."userId" IS NOT NULL`),
      chipsOnSeatsAtClosedTables: await q(`SELECT COALESCE(SUM(s.stack),0)::bigint AS n FROM public."TableSeat" s JOIN public."Table" t ON t.id = s."tableId" WHERE t.status = 'CLOSED'`),
      usersTotal: await q(`SELECT COUNT(*)::int AS n FROM public."User" WHERE kind = 'HUMAN'`),
      guestUsers: await q(`SELECT COUNT(*)::int AS n FROM public."User" WHERE kind = 'HUMAN' AND "isGuest"`),
      usernameGroupsDifferingOnlyByCase: await q(`SELECT COUNT(*)::int AS n FROM (SELECT lower(username) FROM public."User" GROUP BY lower(username) HAVING COUNT(*) > 1) d`),
      usersWithBankrollAboveOneBillion: await q(`SELECT COUNT(*)::int AS n FROM public."User" WHERE bankroll > 1000000000`),
      expiredSessionsStillStored: await q(`SELECT COUNT(*)::int AS n FROM public."Session" WHERE "expiresAt" < now()`),
      handsTotal: await q(`SELECT COUNT(*)::int AS n FROM public."Hand"`),
      handsWithoutAuditSince20260928: await q(`SELECT COUNT(*)::int AS n FROM public."Hand" WHERE "auditRecord" IS NULL AND "startedAt" >= '2026-09-28'`),
    };
  }, { timeout: 20_000, maxWait: 10_000 });
  console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
} catch (error) {
  // Never serialize Prisma's query context, URLs or data.
  console.error(JSON.stringify({ error: 'Read-only check failed', type: error?.name, code: error?.code ?? null,
    category: /connect|reach|P1001|timed out|ETIMEDOUT/i.test(error?.message ?? '') ? 'connection' : /permission|denied/i.test(error?.message ?? '') ? 'permission' : 'other' }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
