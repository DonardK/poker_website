/**
 * Daily reconciliation (docs/money/WALLET.md section 10.10). Driven by the
 * PayoutDispatcher after 03:15 UTC, one check kind per alarm (each is a few
 * aggregate queries): LEDGER, PAYMENTS, PROVIDER, CUSTODY. Every finding is
 * a ReconciliationIssue on that day's run; a run with findings is ISSUES. A
 * check that could not run is a finding too, never OK.
 *
 * A daily run says which Worker's it is (summary.scope, the settlement asset):
 * the "alerts" and "snapshot" rows that share the table carry none, and a
 * sandbox Worker on a shared database neither uses up the live day's run nor
 * reports on live rows. Each kind runs once a day; one that failed or crashed
 * gets up to RECONCILE_TRIES_PER_DAY tries, spaced out, so the tick never adds
 * a row each time it wakes.
 *
 * Nothing here posts to the ledger except provider fees found in a
 * settlement report (provider-fee:statement:<p>:<line>, idempotent).
 */
import type { PrismaClient } from "../generated/prisma/client";
import { errBrief, logError, logInfo } from "../http/log";
import { ensureAccounts, execute } from "../money/ledger";
import { planProviderFee } from "../money/flows";
import { ledgerKeys } from "../money/keys";
import { moneyTx } from "../money/tx";
import { configuredKeys, type MoneyProvider, type PaymentsContext } from "./context";
import { raiseIssue, type IssueInput } from "./issues";

export const RECONCILE_AFTER_UTC_MINUTES = 3 * 60 + 15;
export const RECONCILIATION_KINDS = ["LEDGER", "PAYMENTS", "PROVIDER", "CUSTODY"] as const;
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];
export const RECONCILE_TRIES_PER_DAY = 3;
export const RECONCILE_RETRY_SPACING_MS = 30 * 60_000;

const utcDay = (now: Date) => new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);

/**
 * The next kind due today for this Worker, or null (before 03:15 UTC, all
 * done, or waiting to try a failed one again). The filter names the path the
 * daily runs have: "NOT path = x" would also drop every row without the path.
 */
export async function nextReconciliation(db: PrismaClient, now: Date, scope: string): Promise<ReconciliationKind | null> {
  if (now.getUTCHours() * 60 + now.getUTCMinutes() < RECONCILE_AFTER_UTC_MINUTES) return null;
  const runs = await db.reconciliationRun.findMany({
    where: { scopeDate: utcDay(now), kind: { in: [...RECONCILIATION_KINDS] }, summary: { path: ["scope"], equals: scope } },
    select: { kind: true, status: true, startedAt: true },
  });
  const due = (kind: ReconciliationKind) => {
    const tries = runs.filter((run) => run.kind === kind);
    if (tries.some((run) => run.status === "OK" || run.status === "ISSUES")) return false;
    if (tries.length >= RECONCILE_TRIES_PER_DAY) return false;
    return tries.every((run) => now.getTime() - run.startedAt.getTime() >= RECONCILE_RETRY_SPACING_MS);
  };
  return RECONCILIATION_KINDS.find(due) ?? null;
}

type Check = (ctx: PaymentsContext, runId: string, previousCursor: string | null) => Promise<{ issues: IssueInput[]; summary: Record<string, unknown>; cursor?: string }>;

const ledgerCheck: Check = async (ctx, _runId, previousCursor) => {
  const issues: IssueInput[] = [];
  const imbalance = await ctx.db.$queryRaw<{ asset: string; total: string }[]>`
    SELECT "assetCode" AS asset, SUM("balance")::text AS total FROM public."LedgerAccount" GROUP BY "assetCode" HAVING SUM("balance") <> 0`;
  for (const row of imbalance) issues.push({ code: "LEDGER_ASSET_IMBALANCE", severity: "CRITICAL", subjectType: "ASSET", subjectId: row.asset, details: { total: row.total } });
  const since = previousCursor && /^\d{1,19}$/.test(previousCursor) ? previousCursor : "0";
  const broken = await ctx.db.$queryRaw<{ id: string }[]>`
    WITH tx AS (SELECT "id" FROM public."LedgerTransaction" WHERE "seq" > ${since}::bigint),
     touched AS (SELECT DISTINCT e."accountId" FROM public."LedgerEntry" e WHERE e."transactionId" IN (SELECT "id" FROM tx)),
     j AS (SELECT e."accountId", SUM(e."amount") AS s, COUNT(*) AS n, MAX(e."accountVersion") AS v
             FROM public."LedgerEntry" e WHERE e."accountId" IN (SELECT "accountId" FROM touched) GROUP BY e."accountId")
    SELECT a."id"::text AS id FROM public."LedgerAccount" a JOIN j ON j."accountId" = a."id"
     WHERE a."balance" <> j.s OR a."version" <> j.n OR j.v <> j.n`;
  for (const row of broken) issues.push({ code: "LEDGER_ACCOUNT_MISMATCH", severity: "CRITICAL", subjectType: "LEDGER_ACCOUNT", subjectId: row.id });
  const top = await ctx.db.$queryRaw<{ seq: string | null }[]>`SELECT MAX("seq")::text AS seq FROM public."LedgerTransaction"`;
  return { issues, summary: { assetsChecked: true, sinceSeq: since, accountsBroken: broken.length }, cursor: top[0]?.seq ?? since };
};

const paymentsCheck: Check = async (ctx) => {
  const issues: IssueInput[] = [];
  const asset = ctx.config.settlementAsset;
  const missing = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT d."id"::text AS id FROM public."Deposit" d LEFT JOIN public."LedgerTransaction" t ON t."id" = d."ledgerCreditTxId"
     WHERE d."assetCode" = ${asset} AND d."status" IN ('CREDITED', 'PARTIALLY_REVERSED', 'REVERSED') AND (t."id" IS NULL OR t."type" <> 'DEPOSIT_CREDIT')`;
  for (const row of missing) issues.push({ code: "DEPOSIT_CREDIT_MISSING", severity: "CRITICAL", subjectType: "DEPOSIT", subjectId: row.id });
  const orphans = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT t."id"::text AS id FROM public."LedgerTransaction" t WHERE t."type" = 'DEPOSIT_CREDIT'
       AND NOT EXISTS (SELECT 1 FROM public."Deposit" d WHERE d."ledgerCreditTxId" = t."id")
       AND EXISTS (SELECT 1 FROM public."LedgerEntry" e JOIN public."LedgerAccount" a ON a."id" = e."accountId"
                    WHERE e."transactionId" = t."id" AND a."assetCode" = ${asset})`;
  for (const row of orphans) issues.push({ code: "CREDIT_WITHOUT_DEPOSIT", severity: "CRITICAL", subjectType: "LEDGER_TRANSACTION", subjectId: row.id });
  const holds = await ctx.db.$queryRaw<{ userId: string; asset: string; held: string; open: string }[]>`
    WITH h AS (SELECT "userId", "assetCode", "balance" FROM public."LedgerAccount" WHERE "type" = 'USER_WITHDRAWAL_HOLD' AND "assetCode" = ${asset}),
         o AS (SELECT "userId", "assetCode", SUM("amountMinor") AS open FROM public."Withdrawal"
                WHERE "assetCode" = ${asset} AND "status" IN ('HELD', 'UNDER_REVIEW', 'APPROVED', 'SUBMITTED') GROUP BY "userId", "assetCode")
    SELECT COALESCE(h."userId", o."userId") AS "userId", COALESCE(h."assetCode", o."assetCode") AS asset,
           COALESCE(h."balance", 0)::text AS held, COALESCE(o.open, 0)::text AS open
      FROM h FULL JOIN o ON o."userId" = h."userId" AND o."assetCode" = h."assetCode"
     WHERE COALESCE(h."balance", 0) <> COALESCE(o.open, 0)`;
  for (const row of holds) {
    issues.push({ code: "HOLD_MISMATCH", severity: "CRITICAL", subjectType: "USER", subjectId: `${row.userId}:${row.asset}`, details: { held: row.held, open: row.open } });
  }
  const clearing = await ctx.db.$queryRaw<{ providerKey: string; asset: string; balance: string; expected: string }[]>`
    SELECT a."providerKey", a."assetCode" AS asset, a."balance"::text AS balance,
           (-(COALESCE(SUM(d."creditedMinor"), 0) - COALESCE(SUM(d."reversedMinor" - d."recoveredMinor"), 0)))::text AS expected
      FROM public."LedgerAccount" a LEFT JOIN public."Deposit" d
        ON d."providerKey" = a."providerKey" AND d."ledgerCreditTxId" IS NOT NULL AND d."assetCode" = a."assetCode"
     WHERE a."type" = 'DEPOSIT_CLEARING' AND a."assetCode" = ${asset}
     GROUP BY a."providerKey", a."assetCode", a."balance"
    HAVING a."balance" <> -(COALESCE(SUM(d."creditedMinor"), 0) - COALESCE(SUM(d."reversedMinor" - d."recoveredMinor"), 0))`;
  for (const row of clearing) {
    issues.push({ code: "CLEARING_MISMATCH", severity: "CRITICAL", subjectType: "PROVIDER", subjectId: `${row.providerKey}:${row.asset}`, details: { balance: row.balance, expected: row.expected } });
  }
  const hourAgo = new Date(ctx.now().getTime() - 3_600_000).toISOString();
  const backlog = await ctx.db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM public."PaymentEvent" WHERE "processedAt" IS NULL AND "receivedAt" < ${hourAgo}::timestamp
       AND "provider" = ANY (string_to_array(${configuredKeys(ctx.providers).join(",")}, ','))`;
  if ((backlog[0]?.n ?? 0) > 0) issues.push({ code: "EVENT_BACKLOG", severity: "WARN", subjectType: "INBOX", subjectId: "PaymentEvent", details: { count: backlog[0]!.n } });
  const dayAgo = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const stuck = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS id FROM public."Withdrawal" WHERE "assetCode" = ${asset} AND "status" = 'SUBMITTED' AND "submittedAt" < ${dayAgo}::timestamp LIMIT 50`;
  for (const row of stuck) issues.push({ code: "PAYOUT_STUCK", severity: "WARN", subjectType: "WITHDRAWAL", subjectId: row.id });
  return { issues, summary: { creditMissing: missing.length, orphanCredits: orphans.length, holdMismatches: holds.length, clearingMismatches: clearing.length } };
};

const providerCheck: Check = async (ctx, runId) => {
  const issues: IssueInput[] = [];
  const summary: Record<string, unknown> = {};
  const day = new Date(utcDay(ctx.now()).getTime() - 86_400_000);
  const dayText = day.toISOString().slice(0, 10);
  const notRun = (subjectId: string, reason: string) => {
    summary[subjectId] = { ran: false, reason };
    issues.push({ code: "SETTLEMENT_CHECK_NOT_RUN", severity: "WARN", subjectType: "PROVIDER", subjectId, details: { day: dayText, reason } });
  };
  const providers = [ctx.providers.card, ctx.providers.crypto].filter((p): p is MoneyProvider => p !== null);
  if (providers.length === 0) notRun("none", "no money provider is configured");
  for (const provider of providers) {
    // Nothing was compared, so this day's run must not read as clean.
    if (!provider.listSettlement) {
      notRun(provider.key, "this adapter has no settlement report API");
      continue;
    }
    const lines = await provider.listSettlement(dayText);
    if (lines.kind !== "ok") {
      summary[provider.key] = `report unavailable (${lines.kind})`;
      issues.push({ code: "SETTLEMENT_UNAVAILABLE", severity: "WARN", subjectType: "PROVIDER", subjectId: provider.key });
      continue;
    }
    const byRef = new Map(lines.value.lines.filter((line) => line.merchantRef).map((line) => [line.merchantRef!, line]));
    const credited = await ctx.db.deposit.findMany({
      where: { providerKey: provider.key, ledgerCreditTxId: { not: null }, creditedAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } },
      select: { id: true, creditedMinor: true },
    });
    for (const deposit of credited) {
      const line = byRef.get(deposit.id);
      if (!line) issues.push({ code: "SETTLEMENT_MISSING_DEPOSIT", severity: "CRITICAL", subjectType: "DEPOSIT", subjectId: deposit.id });
      else if (line.amountMinor !== deposit.creditedMinor) {
        issues.push({ code: "SETTLEMENT_AMOUNT_DIFF", severity: "WARN", subjectType: "DEPOSIT", subjectId: deposit.id, details: { ours: String(deposit.creditedMinor), theirs: line.amountMinor.toString() } });
      }
    }
    let feesPosted = 0;
    for (const line of lines.value.lines) {
      const fee = line.type === "FEE" ? (line.amountMinor < 0n ? -line.amountMinor : line.amountMinor) : 0n;
      if (fee <= 0n) continue;
      await moneyTx(ctx.db, async (tx) => {
        await ensureAccounts(tx, [{ asset: provider.settlementAsset, type: "ADJUSTMENTS" }, { asset: provider.settlementAsset, type: "PROVIDER_FEES", providerKey: provider.key }]);
        await execute(tx, planProviderFee({
          key: ledgerKeys.statementFee(provider.key, line.lineId), asset: provider.settlementAsset, providerKey: provider.key, amount: fee, providerReference: line.lineId.slice(0, 128),
        }));
      }, { label: "reconcile.fee" });
      feesPosted += 1;
    }
    summary[provider.key] = { lines: lines.value.lines.length, deposits: credited.length, feesPosted };
  }
  void runId;
  return { issues, summary };
};

const custodyCheck: Check = async (ctx) => {
  const issues: IssueInput[] = [];
  const asset = ctx.config.settlementAsset;
  const liabilities = await custodyLiabilities(ctx.db, asset);
  const latest = await ctx.db.reconciliationRun.findFirst({
    where: { kind: "CUSTODY", AND: [{ summary: { path: ["source"], equals: "snapshot" } }, { summary: { path: ["asset"], equals: asset } }] },
    orderBy: { startedAt: "desc" },
    select: { summary: true, startedAt: true },
  });
  if (!latest || latest.startedAt.getTime() < ctx.now().getTime() - 7 * 86_400_000) {
    if (ctx.config.mode === "live") issues.push({ code: "CUSTODY_SNAPSHOT_MISSING", severity: "WARN", subjectType: "CUSTODY", subjectId: asset });
    return { issues, summary: { liabilities: liabilities.toString(), snapshot: null } };
  }
  const segregated = BigInt(String((latest.summary as Record<string, unknown>).segregatedMinor ?? "0"));
  if (segregated < liabilities) {
    issues.push({ code: "CUSTODY_SHORTFALL", severity: "CRITICAL", subjectType: "CUSTODY", subjectId: asset, details: { liabilities: liabilities.toString(), segregated: segregated.toString() } });
  }
  return { issues, summary: { liabilities: liabilities.toString(), segregated: segregated.toString() } };
};

/** Σ USER_AVAILABLE + USER_WITHDRAWAL_HOLD + TABLE_ESCROW of one asset (what is owed to players). */
export async function custodyLiabilities(db: PrismaClient, asset: string): Promise<bigint> {
  const rows = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM("balance"), 0)::text AS total FROM public."LedgerAccount"
     WHERE "assetCode" = ${asset} AND "type" IN ('USER_AVAILABLE', 'USER_WITHDRAWAL_HOLD', 'TABLE_ESCROW')`;
  return BigInt(rows[0]?.total ?? "0");
}

const CHECKS: Readonly<Record<ReconciliationKind, Check>> = { LEDGER: ledgerCheck, PAYMENTS: paymentsCheck, PROVIDER: providerCheck, CUSTODY: custodyCheck };

/** Runs one reconciliation kind for today; returns false when nothing was due. */
export async function runReconciliationStep(ctx: PaymentsContext): Promise<boolean> {
  const now = ctx.now();
  const scope = ctx.config.settlementAsset;
  const kind = await nextReconciliation(ctx.db, now, scope);
  if (!kind) return false;
  const previous = kind === "LEDGER"
    ? await ctx.db.reconciliationRun.findFirst({
      where: { kind: "LEDGER", status: { in: ["OK", "ISSUES"] }, summary: { path: ["scope"], equals: scope } }, orderBy: { startedAt: "desc" }, select: { cursor: true },
    })
    : null;
  const run = await ctx.db.reconciliationRun.create({ data: { kind, scopeDate: utcDay(now), status: "RUNNING", startedAt: now, summary: { scope } }, select: { id: true } });
  try {
    const result = await CHECKS[kind](ctx, run.id, previous?.cursor ?? null);
    for (const issue of result.issues) await raiseIssue(ctx.db, issue, now, run.id);
    await ctx.db.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: result.issues.length > 0 ? "ISSUES" : "OK", finishedAt: ctx.now(),
        summary: JSON.parse(JSON.stringify({ ...result.summary, scope })) as object, ...(result.cursor ? { cursor: result.cursor } : {}),
      },
    });
    logInfo({ reconciliation: kind, issues: result.issues.length }, "reconciliation run finished");
  } catch (error) {
    logError({ alert: "RECONCILIATION_FAILED", kind, ...errBrief(error) }, "reconciliation run failed");
    await ctx.db.reconciliationRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: ctx.now() } }).catch(() => undefined);
  }
  return true;
}
