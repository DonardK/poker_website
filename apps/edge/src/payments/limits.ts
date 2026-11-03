/**
 * Responsible gaming (docs/money/WALLET.md sections 7.4 and 10.1): deposit
 * limits per rolling day / week / month and self-exclusion. poker-api writes
 * the rows (the triggers fix their timing); payments reads them when a
 * deposit starts and again when it is credited.
 *
 * Limits are denominated in euro (ResponsibleGamingLimit.assetCode = EUR);
 * the sandbox applies them to TEST_EUR one to one.
 */
import { RG_LIMIT_PERIODS, type RgLimitPeriod } from "@poker/shared";
import type { PrismaClient } from "../generated/prisma/client";
import type { MoneyTx } from "../money/tx";

type Db = PrismaClient | MoneyTx;

export const LIMIT_ASSET = "EUR";
export const LIMIT_WINDOW_MS: Readonly<Record<RgLimitPeriod, number>> = Object.freeze({
  DAY: 86_400_000,
  WEEK: 7 * 86_400_000,
  MONTH: 30 * 86_400_000,
});

export type LimitSet = Record<RgLimitPeriod, bigint | null>;
export type UsageSet = Record<RgLimitPeriod, bigint>;

export interface PendingLimit {
  amountMinor: bigint | null;
  effectiveFrom: Date;
}

const iso = (date: Date) => date.toISOString();

/** The limit in force per period (newest uncancelled row already effective), null for none. */
export async function activeDepositLimits(db: Db, userId: string, now: Date): Promise<LimitSet> {
  const rows = await db.$queryRaw<{ period: RgLimitPeriod; amount: string | null }[]>`
    SELECT DISTINCT ON ("period") "period"::text AS period, "amountMinor"::text AS amount
      FROM public."ResponsibleGamingLimit"
     WHERE "userId" = ${userId} AND "kind" = 'DEPOSIT' AND "assetCode" = ${LIMIT_ASSET}
       AND "cancelledAt" IS NULL AND "effectiveFrom" <= ${iso(now)}::timestamp
     ORDER BY "period", "effectiveFrom" DESC, "requestedAt" DESC`;
  const out: LimitSet = { DAY: null, WEEK: null, MONTH: null };
  for (const row of rows) out[row.period] = row.amount === null ? null : BigInt(row.amount);
  return out;
}

/** A looser limit or removal still waiting out its 24 hours, per period. */
export async function pendingDepositLimits(db: Db, userId: string, now: Date): Promise<Record<RgLimitPeriod, PendingLimit | null>> {
  const rows = await db.$queryRaw<{ period: RgLimitPeriod; amount: string | null; effectiveFrom: Date }[]>`
    SELECT DISTINCT ON ("period") "period"::text AS period, "amountMinor"::text AS amount, "effectiveFrom"
      FROM public."ResponsibleGamingLimit"
     WHERE "userId" = ${userId} AND "kind" = 'DEPOSIT' AND "assetCode" = ${LIMIT_ASSET}
       AND "cancelledAt" IS NULL AND "effectiveFrom" > ${iso(now)}::timestamp
     ORDER BY "period", "requestedAt" DESC`;
  const out: Record<RgLimitPeriod, PendingLimit | null> = { DAY: null, WEEK: null, MONTH: null };
  for (const row of rows) out[row.period] = { amountMinor: row.amount === null ? null : BigInt(row.amount), effectiveFrom: row.effectiveFrom };
  return out;
}

/**
 * What counts against a limit (section 10.1): open deposits at their
 * requested amount, a confirmed one at the larger of requested and credited,
 * a credited one at what it kept (credited minus the refund-held excess),
 * by createdAt inside each window. `exclude` leaves one deposit out (the one
 * being credited).
 */
export async function depositUsage(db: Db, userId: string, asset: string, now: Date, exclude: string | null = null): Promise<UsageSet> {
  const day = new Date(now.getTime() - LIMIT_WINDOW_MS.DAY);
  const week = new Date(now.getTime() - LIMIT_WINDOW_MS.WEEK);
  const month = new Date(now.getTime() - LIMIT_WINDOW_MS.MONTH);
  const rows = await db.$queryRaw<{ day: string; week: string; month: string }[]>`
    WITH counted AS (
      SELECT d."createdAt",
             CASE WHEN d."status" IN ('CREATED', 'PENDING') THEN d."requestedMinor"
                  WHEN d."status" = 'CONFIRMED' THEN GREATEST(d."requestedMinor", COALESCE(d."creditedMinor", 0))
                  WHEN d."status" IN ('CREDITED', 'PARTIALLY_REVERSED', 'REVERSED') THEN COALESCE(d."creditedMinor", 0) - d."excessMinor"
                  ELSE 0 END AS amount
        FROM public."Deposit" d
       WHERE d."userId" = ${userId} AND d."assetCode" = ${asset} AND d."createdAt" >= ${iso(month)}::timestamp
         AND (${exclude}::uuid IS NULL OR d."id" <> ${exclude}::uuid))
    SELECT COALESCE(SUM(amount) FILTER (WHERE "createdAt" >= ${iso(day)}::timestamp), 0)::text AS day,
           COALESCE(SUM(amount) FILTER (WHERE "createdAt" >= ${iso(week)}::timestamp), 0)::text AS week,
           COALESCE(SUM(amount), 0)::text AS month
      FROM counted`;
  const row = rows[0] ?? { day: "0", week: "0", month: "0" };
  return { DAY: BigInt(row.day), WEEK: BigInt(row.week), MONTH: BigInt(row.month) };
}

/** The most that may still be deposited now (floored at 0), or null when no limit is set. */
export function remainingCapacity(limits: LimitSet, usage: UsageSet): bigint | null {
  let remaining: bigint | null = null;
  for (const period of RG_LIMIT_PERIODS) {
    const limit = limits[period];
    if (limit === null) continue;
    const left = limit - usage[period];
    const floored = left > 0n ? left : 0n;
    remaining = remaining === null || floored < remaining ? floored : remaining;
  }
  return remaining;
}

export interface ActiveExclusion {
  id: string;
  kind: "DEFINITE" | "INDEFINITE";
  endsAt: Date | null;
  accessRestoredAt: Date | null;
}

/**
 * The self-exclusion in force now, if any: from insertion until access is
 * restored, whatever endsAt says. A timed one does not lapse by itself: the
 * player asks to come back and 24 hours pass; an indefinite one also needs an
 * administrator (self_exclusion_guard sets accessRestoredAt).
 */
export async function activeSelfExclusion(db: Db, userId: string, now: Date): Promise<ActiveExclusion | null> {
  const rows = await db.$queryRaw<ActiveExclusion[]>`
    SELECT "id"::text AS id, "kind"::text AS kind, "endsAt", "accessRestoredAt" FROM public."SelfExclusion"
     WHERE "userId" = ${userId} AND "startsAt" <= ${iso(now)}::timestamp
       AND ("accessRestoredAt" IS NULL OR "accessRestoredAt" > ${iso(now)}::timestamp)
     ORDER BY "startsAt" DESC LIMIT 1`;
  return rows[0] ?? null;
}
