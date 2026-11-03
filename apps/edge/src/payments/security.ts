/**
 * Account events that change what money may do (docs/money/WALLET.md
 * section 10.11).
 *
 * securityLockdown: "This wasn't me" (the auth lockdown, or the link in a
 * payments email) or an admin. Two steps, because protection must not depend
 * on whether money can move. The first is one transaction that posts nothing:
 * withdrawals become manual (WITHDRAWALS_MANUAL, reason SECURITY_LOCKDOWN),
 * every payout destination that appeared in the 72 hours before the report (an
 * address the player added, a card a deposit saved) or since is revoked, and so
 * is the destination the report names, whatever its age; every player
 * withdrawal that has not reached the provider is marked for cancelling, and
 * unconsumed step-up grants are voided. The second releases those withdrawals
 * (settleRequestedCancels). It fails during an emergency stop; the dispatcher
 * retries it, and meanwhile the marker and payoutBlock keep the money in.
 *
 * applyPendingLockdowns: the durable half. poker-api commits a report as a
 * NOT_ME_REPORTED security event before it asks payments anything, then asks
 * once after the response. The dispatcher sweeps those events: a report with
 * no lockdown recorded for it (metadata.reportId) is applied here until it
 * succeeds, so a payments outage at that moment cannot lose it, and one report
 * is never applied twice.
 *
 * onScreeningHit: a sanctions or PEP hit stops what has not been sent, in the
 * same two steps.
 * onSelfExcluded: open deposits are cancelled; anything that still arrives is
 * credited and held for refund (deposits.ts). Withdrawals stay open.
 */
import { lockCompliance, restrict } from "./compliance";
import type { PaymentsContext } from "./context";
import { cancelOpenDeposits } from "./deposits";
import { verifyNotMe, type NotMeClaims } from "./emails";
import { refuse } from "./errors";
import { enqueueEmail } from "./notify";
import { isUuid } from "./session";
import { voidGrants } from "./stepup";
import { requestCancels, settleRequestedCancels } from "./withdrawals";
import { moneyTx, type MoneyTx } from "../money/tx";
import { logError, logWarn } from "../http/log";

export const LOCKDOWN_REVOKE_WINDOW_MS = 72 * 3_600_000;
/** How far back an unapplied account lockdown is looked for (longer than any outage). */
export const PENDING_LOCKDOWN_WINDOW_MS = 30 * 86_400_000;

export interface LockdownResult {
  revoked: number;
  /** Released now. Anything still marked is released by the dispatcher. */
  cancelled: number;
}

/** One "This wasn't me" report: the security event that recorded it. */
export interface LockdownReport {
  /** AccountSecurityEvent.id: a report is applied once. */
  id: string;
  /** When it was reported. The 72 hours are counted back from here, not from whenever this runs. */
  at: Date;
  /** What the notice named, when it came from a payments email. */
  notice: Pick<NotMeClaims, "k" | "s"> | null;
}

const LOCKDOWN_ACTION = "SECURITY_LOCKDOWN_NOT_ME";

/** The instrument a "This wasn't me" token names, whatever its age: the thing the email was about. */
async function reportedInstrument(tx: MoneyTx, userId: string, claims: Pick<NotMeClaims, "k" | "s"> | null): Promise<string | null> {
  if (!claims || !isUuid(claims.s)) return null;
  if (claims.k === "destination-added") {
    const row = await tx.paymentInstrument.findFirst({ where: { id: claims.s, userId, status: { not: "REVOKED" } }, select: { id: true } });
    return row?.id ?? null;
  }
  if (claims.k === "withdrawal-requested") {
    const row = await tx.withdrawal.findFirst({ where: { id: claims.s, userId }, select: { instrumentId: true } });
    return row?.instrumentId ?? null;
  }
  return null;
}

export async function securityLockdown(ctx: PaymentsContext, userId: string, reason: "NOT_ME" | "ADMIN", by: string | null, report: LockdownReport | null = null): Promise<LockdownResult> {
  const now = ctx.now();
  const reportedAt = report?.at ?? now;
  const result = await moneyTx(ctx.db, async (tx) => {
    const compliance = await lockCompliance(tx, userId);
    // Under the player's lock: the fast path and the sweep cannot both apply one report.
    if (report) {
      const applied = await tx.paymentReviewAction.findFirst({
        where: { subjectType: "USER", subjectId: userId, verb: "RESTRICT", metadata: { path: ["reportId"], equals: report.id } },
        select: { id: true },
      });
      if (applied) return null;
    }
    await restrict(tx, compliance, "WITHDRAWALS_MANUAL", "SECURITY_LOCKDOWN", by, now);
    const named = await reportedInstrument(tx, userId, report?.notice ?? null);
    const recent = await tx.paymentInstrument.findMany({
      where: {
        userId, status: { not: "REVOKED" },
        OR: [{ createdAt: { gte: new Date(reportedAt.getTime() - LOCKDOWN_REVOKE_WINDOW_MS) } }, ...(named ? [{ id: named }] : [])],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    for (const instrument of recent) {
      await tx.paymentInstrument.update({
        where: { id: instrument.id },
        data: { status: "REVOKED", revokedAt: now, revokedReason: "SECURITY_LOCKDOWN", revokedBy: by ?? "SYSTEM", payoutEnabled: false },
      });
    }
    const marked = await requestCancels(tx, userId, "SECURITY_LOCKDOWN", { kinds: ["PLAYER"], now });
    await voidGrants(tx, userId);
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "USER", subjectId: userId, subjectUserId: userId, actorKind: by ? "ADMIN" : "SYSTEM", actorUserId: by,
        verb: "RESTRICT", reasonCode: `SECURITY_LOCKDOWN_${reason}`,
        metadata: { revoked: recent.length, cancelRequested: marked, ...(report ? { reportId: report.id, reportedAt: reportedAt.toISOString() } : {}) },
      },
    });
    if (reason === "NOT_ME" && (recent.length > 0 || marked > 0)) {
      await enqueueEmail(tx, ctx.config.settlementAsset, {
        userId, template: "security-lockdown", dedupeKey: `security-lockdown:${userId}:${report?.id ?? now.toISOString().slice(0, 16)}`,
        payload: { revoked: String(recent.length), cancelled: String(marked), sandbox: String(ctx.config.mode === "sandbox") },
      });
    }
    return { revoked: recent.length, marked };
  }, { label: "security.lockdown" });
  if (!result) return { revoked: 0, cancelled: 0 };
  const cancelled = await settleRequestedCancels(ctx, { userId });
  logWarn({ security: "PAYMENTS_LOCKDOWN", userId, reason, revoked: result.revoked, marked: result.marked, cancelled }, "payments locked down for an account");
  return { revoked: result.revoked, cancelled };
}

/** Who a payments-email "This wasn't me" token names, for a poker-api that does not hold the link secret. */
export async function verifyNotMeToken(ctx: PaymentsContext, token: unknown): Promise<NotMeClaims> {
  const secret = ctx.config.notifyLinkSecret;
  const claims = secret ? await verifyNotMe(secret, token, ctx.now()) : null;
  if (!claims) refuse("TOKEN_INVALID", "This link is not valid or has expired. Sign in and contact support.");
  return claims;
}

/** What a report's security event says the notice named. Written by poker-api; anything else counts as nothing. */
function noticeOf(value: unknown): LockdownReport["notice"] {
  const notice = value as { k?: unknown; s?: unknown } | null;
  return notice && typeof notice.k === "string" && typeof notice.s === "string" ? { k: notice.k, s: notice.s } : null;
}

/**
 * Reports poker-api recorded that payments has not applied (the deferred call
 * failed, or poker-payments was down). Applied per report, each on its own, in
 * random order: a report that always fails cannot keep one of the slots from
 * the others, and logs an alert each time it is tried. Returns how many were
 * applied.
 */
export async function applyPendingLockdowns(ctx: PaymentsContext, limit = 3): Promise<number> {
  const since = new Date(ctx.now().getTime() - PENDING_LOCKDOWN_WINDOW_MS).toISOString();
  const rows = await ctx.db.$queryRaw<{ id: string; userId: string; createdAt: Date; notice: unknown }[]>`
    SELECT e."id", e."userId", e."createdAt", e."data"->'notice' AS notice FROM public."AccountSecurityEvent" e
     WHERE e."type" = 'NOT_ME_REPORTED' AND e."createdAt" >= ${since}::timestamp
       AND NOT EXISTS (SELECT 1 FROM public."PaymentReviewAction" a
                        WHERE a."subjectType" = 'USER' AND a."subjectId" = e."userId" AND a."verb" = 'RESTRICT'
                          AND a."reasonCode" = ${LOCKDOWN_ACTION} AND a."metadata"->>'reportId' = e."id")
     ORDER BY random() LIMIT ${limit}`;
  let applied = 0;
  for (const row of rows) {
    try {
      await securityLockdown(ctx, row.userId, "NOT_ME", null, { id: row.id, at: row.createdAt, notice: noticeOf(row.notice) });
      applied += 1;
    } catch (error) {
      // The next tick tries again; one account must not hold up the others.
      logError({ alert: "PAYMENTS_LOCKDOWN_RETRY_FAILED", userId: row.userId, errName: error instanceof Error ? error.name : "Unknown" }, "pending account lockdown could not be applied");
    }
  }
  return applied;
}

/**
 * A sanctions or PEP hit from the KYC provider, in the transaction of that
 * update ([L2] held): nothing unsent leaves, refunds included, and a
 * confirmed match freezes the account. Posts nothing: the caller releases what
 * was marked after the commit, and the dispatcher retries it.
 */
export async function onScreeningHit(tx: MoneyTx, ctx: PaymentsContext, userId: string, screening: "POTENTIAL_MATCH" | "CONFIRMED_MATCH"): Promise<number> {
  if (screening === "CONFIRMED_MATCH") await restrict(tx, await lockCompliance(tx, userId), "FROZEN", "SCREENING_MATCH", null, ctx.now());
  const marked = await requestCancels(tx, userId, "SCREENING_HIT", { kinds: ["PLAYER", "REFUND"], now: ctx.now() });
  logWarn({ alert: "SCREENING_HIT", userId, screening, marked }, "screening hit: unsent withdrawals stopped");
  return marked;
}

export async function onSelfExcluded(ctx: PaymentsContext, userId: string): Promise<number> {
  return cancelOpenDeposits(ctx, userId, "SELF_EXCLUDED");
}
