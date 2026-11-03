/**
 * The daily reconciliation on the real database (docs/money/WALLET.md section
 * 10.10): each kind runs once a day and then nothing is due; a check that did
 * not run reads as that, never as OK; a seeded mismatch raises an issue; rows
 * of another environment count for nothing. The seeds corrupt shared ledger
 * rows for a moment, so this lives in the payments project, one file at a time.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { custodySnapshot } from "../../src/payments/admin";
import type { PaymentsContext } from "../../src/payments/context";
import { raiseIssue } from "../../src/payments/issues";
import type { SettlementLine } from "../../src/payments/providers/types";
import { nextReconciliation, RECONCILE_RETRY_SPACING_MS, RECONCILE_TRIES_PER_DAY, RECONCILIATION_KINDS, runReconciliationStep } from "../../src/payments/reconcile";
import { newPlayer, openFixture, type Fixture } from "../payments/support/fixture";
import { adminGrantFor, asAdmin, cardDeposit, newAdmin, withoutTriggers } from "../payments/support/flows";

let f: Fixture | null = null;

beforeAll(async () => {
  f = await openFixture();
}, 60_000);

afterAll(async () => {
  if (f) await f.close();
});

afterEach(() => {
  if (f) f.clock.offsetMs = 0;
});

function dbTest(name: string, run: (fx: Fixture) => Promise<void>): void {
  it(name, async (context) => {
    if (!f) return context.skip();
    await run(f);
  }, 120_000);
}

const DAY = 86_400_000;
let nextDay = 0;

/** Moves the clock to 04:00 UTC of a day no other test used (the tests share one table). */
function freshDay(fx: Fixture): void {
  nextDay += 1;
  const today = Math.floor(Date.now() / DAY) * DAY;
  fx.clock.offsetMs = today + nextDay * 3 * DAY + 4 * 3_600_000 - Date.now();
}

const scopeDate = (fx: Fixture) => new Date(`${fx.now().toISOString().slice(0, 10)}T00:00:00.000Z`);
const runsToday = (fx: Fixture) => fx.payments.reconciliationRun.findMany({ where: { scopeDate: scopeDate(fx) }, orderBy: { startedAt: "asc" } });
const issuesOf = (fx: Fixture, runId: string) => fx.payments.reconciliationIssue.findMany({ where: { runId } });

async function runAll(fx: Fixture, ctx: PaymentsContext = fx.ctx()): Promise<void> {
  for (let i = 0; i < RECONCILIATION_KINDS.length; i += 1) await runReconciliationStep(ctx);
}

describe("once a day", () => {
  dbTest("the four kinds run once each, then nothing is due and no row is added", async (fx) => {
    freshDay(fx);
    const ctx = fx.ctx();
    const kinds: (string | null)[] = [];
    for (let i = 0; i < 6; i += 1) {
      kinds.push(await nextReconciliation(fx.payments, ctx.now(), fx.config.settlementAsset));
      await runReconciliationStep(ctx);
    }
    expect(kinds).toEqual(["LEDGER", "PAYMENTS", "PROVIDER", "CUSTODY", null, null]);
    expect((await runsToday(fx)).map((run) => run.kind)).toEqual(["LEDGER", "PAYMENTS", "PROVIDER", "CUSTODY"]);
    await expect(runReconciliationStep(ctx)).resolves.toBe(false);
  });

  dbTest("before 03:15 UTC nothing is due", async (fx) => {
    freshDay(fx);
    fx.clock.offsetMs -= 2 * 3_600_000;
    expect(await nextReconciliation(fx.payments, fx.now(), fx.config.settlementAsset)).toBeNull();
    await expect(runReconciliationStep(fx.ctx())).resolves.toBe(false);
  });

  dbTest("the alerts run of the day and a custody snapshot do not stand in for the daily checks", async (fx) => {
    freshDay(fx);
    await raiseIssue(fx.payments, { code: "TEST_ALERT", severity: "INFO", subjectType: "TEST", subjectId: crypto.randomUUID() }, fx.now());
    await fx.payments.reconciliationRun.create({ data: { kind: "CUSTODY", scopeDate: scopeDate(fx), status: "OK", startedAt: fx.now(), summary: { source: "snapshot", asset: "TEST_EUR", segregatedMinor: "0" } } });
    await runAll(fx);
    const kinds = (await runsToday(fx)).map((run) => (run.summary as { source?: string }).source ?? run.kind);
    expect(kinds.filter((kind) => kind === "CUSTODY")).toHaveLength(1);
    expect(kinds).toEqual(expect.arrayContaining(["alerts", "snapshot", "LEDGER", "PAYMENTS", "PROVIDER", "CUSTODY"]));
  });

  dbTest("a check that fails is tried again, spaced out and a few times, and then the day is over", async (fx) => {
    freshDay(fx);
    const ctx = fx.ctx();
    const broken: PaymentsContext = {
      ...ctx,
      db: new Proxy(ctx.db, { get: (target, prop, receiver) => (prop === "$queryRaw" ? () => Promise.reject(new Error("no connection")) : Reflect.get(target, prop, receiver)) }),
    };
    const base = fx.clock.offsetMs;
    await runReconciliationStep(broken);
    expect((await runsToday(fx)).map((run) => [run.kind, run.status])).toEqual([["LEDGER", "FAILED"]]);
    // Not again on the next tick: the next kind is due instead.
    expect(await nextReconciliation(fx.payments, fx.now(), fx.config.settlementAsset)).toBe("PAYMENTS");
    await runReconciliationStep(broken);
    await runReconciliationStep(broken);
    await runReconciliationStep(broken);
    expect(await nextReconciliation(fx.payments, fx.now(), fx.config.settlementAsset)).toBeNull();
    for (let i = 1; i < RECONCILE_TRIES_PER_DAY; i += 1) {
      fx.clock.offsetMs = base + i * (RECONCILE_RETRY_SPACING_MS + 1_000);
      expect(await nextReconciliation(fx.payments, fx.now(), fx.config.settlementAsset)).toBe("LEDGER");
      for (let n = 0; n < 4; n += 1) await runReconciliationStep(broken);
    }
    fx.clock.offsetMs = base + (RECONCILE_TRIES_PER_DAY + 1) * (RECONCILE_RETRY_SPACING_MS + 1_000);
    expect(await nextReconciliation(fx.payments, fx.now(), fx.config.settlementAsset)).toBeNull();
    expect((await runsToday(fx)).filter((run) => run.kind === "LEDGER")).toHaveLength(RECONCILE_TRIES_PER_DAY);
  });

  dbTest("a run that crashed and stayed RUNNING counts as a try, and the check comes back later", async (fx) => {
    freshDay(fx);
    await fx.payments.reconciliationRun.create({ data: { kind: "LEDGER", scopeDate: scopeDate(fx), status: "RUNNING", startedAt: fx.now(), summary: { scope: fx.config.settlementAsset } } });
    expect(await nextReconciliation(fx.payments, fx.now(), fx.config.settlementAsset)).toBe("PAYMENTS");
    fx.clock.offsetMs += RECONCILE_RETRY_SPACING_MS + 1_000;
    expect(await nextReconciliation(fx.payments, fx.now(), fx.config.settlementAsset)).toBe("LEDGER");
  });
});

describe("a check that did not run never reads as OK", () => {
  dbTest("PROVIDER without a settlement report API records that, as an issue the operator sees", async (fx) => {
    freshDay(fx);
    await runAll(fx);
    const run = (await runsToday(fx)).find((row) => row.kind === "PROVIDER")!;
    expect(run.status).toBe("ISSUES");
    const issues = await issuesOf(fx, run.id);
    expect(issues.map((issue) => [issue.code, issue.severity, issue.subjectId]).sort()).toEqual([
      ["SETTLEMENT_CHECK_NOT_RUN", "WARN", "sandbox-card"], ["SETTLEMENT_CHECK_NOT_RUN", "WARN", "sandbox-crypto"],
    ]);
    expect(run.summary).toMatchObject({ "sandbox-card": { ran: false } });
  });

  dbTest("with no money rail configured it says so too", async (fx) => {
    freshDay(fx);
    const ctx = fx.ctx();
    const none: PaymentsContext = { ...ctx, providers: { ...ctx.providers, card: null, crypto: null } };
    await runReconciliationStep(none);
    await runReconciliationStep(none);
    await runReconciliationStep(none);
    const run = (await runsToday(fx)).find((row) => row.kind === "PROVIDER")!;
    expect(run.status).toBe("ISSUES");
    expect((await issuesOf(fx, run.id)).map((issue) => issue.subjectId)).toEqual(["none"]);
  });

  dbTest("an adapter with a settlement report runs: a credited deposit missing from it is CRITICAL", async (fx) => {
    const player = await newPlayer(fx);
    const depositId = await cardDeposit(fx, player, "30.00");
    freshDay(fx);
    // The report of the day before: move the deposit there.
    const yesterday = new Date(`${new Date(fx.now().getTime() - DAY).toISOString().slice(0, 10)}T12:00:00.000Z`).toISOString();
    await withoutTriggers((tx) => tx.$executeRaw`UPDATE public."Deposit" SET "creditedAt" = ${yesterday}::timestamp WHERE "id" = ${depositId}::uuid`);
    const ctx = fx.ctx();
    const lines: SettlementLine[] = [];
    const card = { ...ctx.providers.card!, listSettlement: async () => ({ kind: "ok" as const, value: { lines } }) };
    const withReport: PaymentsContext = { ...ctx, providers: { ...ctx.providers, card } };
    await runAll(fx, withReport);
    const run = (await runsToday(fx)).find((row) => row.kind === "PROVIDER")!;
    const issues = await issuesOf(fx, run.id);
    expect(issues.find((issue) => issue.subjectId === depositId)).toMatchObject({ code: "SETTLEMENT_MISSING_DEPOSIT", severity: "CRITICAL" });
    expect(issues.find((issue) => issue.subjectId === "sandbox-crypto")).toMatchObject({ code: "SETTLEMENT_CHECK_NOT_RUN" });
  });
});

describe("a seeded mismatch raises an issue", () => {
  async function holdAccount(fx: Fixture): Promise<{ userId: string; id: bigint }> {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "20.00");
    const rows = await fx.payments.$queryRaw<{ id: bigint }[]>`
      SELECT "id" FROM public."LedgerAccount" WHERE "userId" = ${player.userId} AND "assetCode" = 'TEST_EUR' AND "type" = 'USER_AVAILABLE'`;
    return { userId: player.userId, id: rows[0]!.id };
  }

  const nudge = (id: bigint, by: number) => withoutTriggers((tx) => tx.$executeRaw`UPDATE public."LedgerAccount" SET "balance" = "balance" + ${by} WHERE "id" = ${id}`);

  dbTest("LEDGER: a balance that does not add up, an account that disagrees with its entries", async (fx) => {
    const { id } = await holdAccount(fx);
    await nudge(id, 1);
    try {
      freshDay(fx);
      await runAll(fx);
      const run = (await runsToday(fx)).find((row) => row.kind === "LEDGER")!;
      expect(run.status).toBe("ISSUES");
      const issues = await issuesOf(fx, run.id);
      expect(issues.map((issue) => issue.code).sort()).toEqual(["LEDGER_ACCOUNT_MISMATCH", "LEDGER_ASSET_IMBALANCE"]);
      expect(issues.every((issue) => issue.severity === "CRITICAL")).toBe(true);
      expect(run.cursor).not.toBeNull();
    } finally {
      await nudge(id, -1);
    }
  });

  dbTest("PAYMENTS: a hold no withdrawal explains", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "20.00");
    await withoutTriggers(async (tx) => {
      await tx.$executeRaw`INSERT INTO public."LedgerAccount" ("assetCode", "type", "userId", "balance", "allowNegative") VALUES ('TEST_EUR', 'USER_WITHDRAWAL_HOLD', ${player.userId}, 123, false) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`UPDATE public."LedgerAccount" SET "balance" = 123 WHERE "userId" = ${player.userId} AND "assetCode" = 'TEST_EUR' AND "type" = 'USER_WITHDRAWAL_HOLD'`;
    });
    try {
      freshDay(fx);
      await runAll(fx);
      const run = (await runsToday(fx)).find((row) => row.kind === "PAYMENTS")!;
      const issue = (await issuesOf(fx, run.id)).find((row) => row.code === "HOLD_MISMATCH" && row.subjectId === `${player.userId}:TEST_EUR`);
      expect(issue).toMatchObject({ severity: "CRITICAL", details: { held: "123", open: "0" } });
      expect(run.status).toBe("ISSUES");
    } finally {
      await withoutTriggers((tx) => tx.$executeRaw`UPDATE public."LedgerAccount" SET "balance" = 0 WHERE "userId" = ${player.userId} AND "assetCode" = 'TEST_EUR' AND "type" = 'USER_WITHDRAWAL_HOLD'`);
    }
  });

  dbTest("CUSTODY: a snapshot below what is owed to players", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "20.00");
    freshDay(fx);
    const staff = await newAdmin(fx);
    const asOf = fx.now().toISOString();
    await custodySnapshot(fx.ctx(), asAdmin(staff), { asOf, segregatedBalance: "0.01", source: "statement", stepUpGrantId: await adminGrantFor(fx, staff, `custody:${asOf}`, "SNAPSHOT:1") });
    await runAll(fx);
    const run = (await runsToday(fx)).find((row) => row.kind === "CUSTODY" && (row.summary as { scope?: string }).scope === "TEST_EUR")!;
    expect(run.status).toBe("ISSUES");
    expect((await issuesOf(fx, run.id)).map((issue) => issue.code)).toEqual(["CUSTODY_SHORTFALL"]);
  });
});

describe("another environment's rows", () => {
  dbTest("a Worker of another environment neither uses up this day's run nor counts as it", async (fx) => {
    freshDay(fx);
    const ctx = fx.ctx();
    const live: PaymentsContext = { ...ctx, config: { ...ctx.config, settlementAsset: "EUR" } };
    await runAll(fx, live);
    expect(await nextReconciliation(fx.payments, fx.now(), "EUR")).toBeNull();
    expect(await nextReconciliation(fx.payments, fx.now(), "TEST_EUR")).toBe("LEDGER");
    await runAll(fx);
    expect(await nextReconciliation(fx.payments, fx.now(), "TEST_EUR")).toBeNull();
    expect(await fx.payments.reconciliationRun.count({ where: { scopeDate: scopeDate(fx), kind: "LEDGER" } })).toBe(2);
  });

  dbTest("the PAYMENTS check reports only this Worker's money", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "20.00");
    await withoutTriggers(async (tx) => {
      await tx.$executeRaw`INSERT INTO public."LedgerAccount" ("assetCode", "type", "userId", "balance", "allowNegative") VALUES ('TEST_EUR', 'USER_WITHDRAWAL_HOLD', ${player.userId}, 7, false) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`UPDATE public."LedgerAccount" SET "balance" = 7 WHERE "userId" = ${player.userId} AND "assetCode" = 'TEST_EUR' AND "type" = 'USER_WITHDRAWAL_HOLD'`;
    });
    try {
      freshDay(fx);
      const ctx = fx.ctx();
      const live: PaymentsContext = { ...ctx, config: { ...ctx.config, settlementAsset: "EUR" } };
      await runAll(fx, live);
      const run = (await runsToday(fx)).find((row) => row.kind === "PAYMENTS" && (row.summary as { scope?: string }).scope === "EUR")!;
      expect((await issuesOf(fx, run.id)).filter((issue) => issue.subjectId.endsWith(":TEST_EUR"))).toEqual([]);
    } finally {
      await withoutTriggers((tx) => tx.$executeRaw`UPDATE public."LedgerAccount" SET "balance" = 0 WHERE "userId" = ${player.userId} AND "assetCode" = 'TEST_EUR' AND "type" = 'USER_WITHDRAWAL_HOLD'`);
    }
  });

  dbTest("a custody snapshot of another asset is not this asset's", async (fx) => {
    freshDay(fx);
    await fx.payments.reconciliationRun.create({ data: { kind: "CUSTODY", scopeDate: scopeDate(fx), status: "OK", startedAt: fx.now(), summary: { source: "snapshot", asset: "EUR", segregatedMinor: "0" } } });
    await runAll(fx);
    const run = (await runsToday(fx)).find((row) => row.kind === "CUSTODY" && (row.summary as { scope?: string }).scope === "TEST_EUR")!;
    expect(run.summary).toMatchObject({ snapshot: null });
  });
});
