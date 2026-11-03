/**
 * ReconciliationIssue rows raised outside the daily run (a payout reported
 * paid after its hold was released, a dispatch that needs a person): they
 * hang off one "alerts" PAYMENTS run per UTC day, and the admin issue queue
 * shows them with the daily findings. Each is also logged as an alert.
 */
import type { PrismaClient } from "../generated/prisma/client";
import { logError, logWarn } from "../http/log";
import type { MoneyTx } from "../money/tx";

type Db = PrismaClient | MoneyTx;

export interface IssueInput {
  code: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  subjectType: string;
  subjectId: string;
  details?: Record<string, string | number | boolean | null>;
}

const day = (now: Date) => new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);

async function alertsRun(db: Db, now: Date): Promise<string> {
  const scopeDate = day(now);
  const existing = await db.reconciliationRun.findFirst({
    where: { kind: "PAYMENTS", scopeDate, summary: { path: ["source"], equals: "alerts" } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const run = await db.reconciliationRun.create({
    data: { kind: "PAYMENTS", scopeDate, status: "ISSUES", summary: { source: "alerts" } },
    select: { id: true },
  });
  return run.id;
}

export async function raiseIssue(db: Db, issue: IssueInput, now: Date, runId?: string): Promise<void> {
  const id = runId ?? await alertsRun(db, now);
  await db.$executeRaw`
    INSERT INTO public."ReconciliationIssue" ("runId", "code", "severity", "subjectType", "subjectId", "details")
    VALUES (${id}::uuid, ${issue.code.slice(0, 64)}, ${issue.severity}, ${issue.subjectType}, ${issue.subjectId.slice(0, 200)}, ${JSON.stringify(issue.details ?? {})}::jsonb)
    ON CONFLICT ("runId", "code", "subjectId") DO NOTHING`;
  const fields = { alert: issue.code, severity: issue.severity, subjectType: issue.subjectType, subjectId: issue.subjectId };
  if (issue.severity === "CRITICAL") logError(fields, "payments reconciliation issue");
  else logWarn(fields, "payments reconciliation issue");
}
