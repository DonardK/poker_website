/**
 * Payout dispatch (docs/money/WALLET.md sections 7.3 and 10.9). One unit of
 * work per call: claim a due PayoutDispatch row (transaction: [L2]
 * compliance -> [L5] withdrawal -> [L6] dispatch), call the provider outside
 * any transaction, record the PayoutAttempt and apply the result (same lock
 * order). The provider idempotency key never changes, so a resend can never
 * pay twice; an uncertain result never releases the hold. After two NOT_FOUND
 * answers at least 10 minutes apart, and only for a provider that dedupes on
 * our key, the same key is sent again; after 24 hours of uncertainty a person
 * decides (MANUAL, two admins). Every send re-checks the player under the
 * same locks: a freeze, a screening hit or a security hold that arrived after
 * the approval stops the money (payoutBlock).
 *
 * The emergency stop (Asset.enabled false, or PAYOUT_DISPATCH off): nothing is
 * sent. A row that was going to be sent stays exactly as it is, with its hold,
 * and goes out when the stop lifts. A payout the provider already has is still
 * followed (status reads only, and webhooks), so it is known what happened to
 * it; an outcome that has to post waits for the ledger and is read again.
 */
import { canonicalJson, sha256HexAsync } from "@poker/shared";
import type { PayoutDispatch, Withdrawal } from "../generated/prisma/client";
import { logError, logWarn } from "../http/log";
import { moneyTx, PaymentsRefusal, type MoneyTx } from "../money/tx";
import { lockCompliance, readCompliance, type ComplianceRow } from "./compliance";
import { configuredKeys, moneyProviderByKey, type MoneyProvider, type PaymentsContext } from "./context";
import { customerRef, travelRuleParty } from "./customer";
import type { EventOutcome } from "./deposits";
import { assetEnabled, readSwitches } from "./gate";
import { raiseIssue } from "./issues";
import type { PayoutInput, ProviderPayout, ProviderResult, TravelRuleParty } from "./providers/types";
import { securityHeld } from "./session";
import { destinationOf, releaseWithdrawal, returnsToSource, returnWithdrawal, settleWithdrawal } from "./withdrawals";

export const LEASE_MS = 90_000;
export const MANUAL_AFTER_MS = 24 * 3_600_000;
export const NOT_FOUND_SPACING_MS = 10 * 60_000;
const UNCERTAIN_BACKOFF_MIN = [1, 5, 15, 60];

type Action = "CREATE" | "QUERY";

interface Claim {
  withdrawalId: string;
  userId: string;
  action: Action;
  /** The status the dispatch had when claimed (SENT stays SENT while it is polled). */
  from: PayoutDispatch["status"];
  seq: number;
  startedAt: Date;
}

const due = (ctx: PaymentsContext) => ctx.now().toISOString();

/** The emergency stop: true while nothing may be sent for this asset. */
export async function sendsStopped(db: Parameters<typeof readSwitches>[0], asset: string): Promise<boolean> {
  return !(await readSwitches(db)).PAYOUT_DISPATCH || !await assetEnabled(db, asset);
}

/**
 * The next due dispatch of one of this Worker's providers, without a lock (the
 * claim re-checks under lock). A row of any other provider is left alone: a
 * sandbox Worker that shared a database with the live one must not touch it.
 * While sends are stopped only rows the provider may already have are picked,
 * so an unsent row at the head of the queue cannot hide them.
 */
async function candidate(ctx: PaymentsContext, keys: readonly string[], sending: boolean): Promise<{ withdrawalId: string; userId: string } | null> {
  const now = due(ctx);
  const rows = await ctx.db.$queryRaw<{ withdrawalId: string; userId: string }[]>`
    SELECT "withdrawalId"::text AS "withdrawalId", "userId" FROM public."PayoutDispatch"
     WHERE "providerKey" = ANY (string_to_array(${keys.join(",")}, ','))
       AND (("status" IN ('UNCERTAIN', 'SENT') AND "nextAttemptAt" <= ${now}::timestamp)
            OR (${sending}::boolean AND "status" IN ('PENDING', 'RETRY_WAIT') AND "nextAttemptAt" <= ${now}::timestamp)
            OR ("status" = 'IN_FLIGHT' AND "leaseUntil" < ${now}::timestamp))
     ORDER BY "nextAttemptAt" LIMIT 1`;
  return rows[0] ?? null;
}

async function lockPair(tx: MoneyTx, userId: string, withdrawalId: string): Promise<{ compliance: ComplianceRow; withdrawal: Withdrawal; dispatch: PayoutDispatch }> {
  const compliance = await lockCompliance(tx, userId);
  await tx.$queryRaw`SELECT "id" FROM public."Withdrawal" WHERE "id" = ${withdrawalId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "withdrawalId" FROM public."PayoutDispatch" WHERE "withdrawalId" = ${withdrawalId}::uuid FOR UPDATE`;
  const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  const dispatch = await tx.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId } });
  return { compliance, withdrawal, dispatch };
}

/**
 * Why this payout must not leave now, or null. An approval is a decision about
 * the player as they were then, so the state is read again before every send,
 * under the compliance lock every restriction change also takes.
 *
 * A withdrawal marked for cancelling stops first, whatever its kind. A refund
 * that returns a deposit to its own card (it is how a frozen or restricted
 * account's money goes back) stops only for a screening hit. Everything else
 * is a payout, including a refund to an address an administrator named: it
 * also stops for a freeze, KYC or screening that is no longer good, an active
 * security hold (the payments side of a lockdown may not have run yet),
 * WITHDRAWALS_MANUAL unless staff approved it after that restriction was set,
 * and a destination that is no longer active (revoked by a lockdown, say).
 */
async function payoutBlock(tx: MoneyTx, compliance: ComplianceRow, withdrawal: Withdrawal, now: Date): Promise<string | null> {
  if (withdrawal.cancelCode !== null) return withdrawal.cancelCode;
  if (compliance.screeningStatus === "POTENTIAL_MATCH" || compliance.screeningStatus === "CONFIRMED_MATCH") return "SCREENING_HIT";
  if (await returnsToSource(tx, withdrawal)) return null;
  if (compliance.restriction === "FROZEN") return "ACCOUNT_FROZEN";
  if (compliance.kycStatus !== "VERIFIED" || compliance.screeningStatus !== "CLEAR") return "KYC_NOT_CLEAR";
  const user = await tx.user.findUnique({ where: { id: withdrawal.userId }, select: { securityHoldUntil: true } });
  if (!user || securityHeld(user, now)) return "SECURITY_HOLD";
  if (compliance.restriction === "WITHDRAWALS_MANUAL") {
    const auto = await tx.paymentReviewAction.count({ where: { subjectType: "WITHDRAWAL", subjectId: withdrawal.id, verb: "APPROVE", actorKind: "SYSTEM" } });
    const approvedSince = withdrawal.decidedAt !== null && compliance.restrictedAt !== null && withdrawal.decidedAt.getTime() >= compliance.restrictedAt.getTime();
    if (auto > 0 || !approvedSince) return "RESTRICTED_MANUAL";
  }
  const destination = withdrawal.instrumentId === null ? null
    : await tx.paymentInstrument.findUnique({ where: { id: withdrawal.instrumentId }, select: { status: true, payoutEnabled: true } });
  if (!destination || destination.status !== "ACTIVE" || !destination.payoutEnabled) return "DESTINATION_UNAVAILABLE";
  return null;
}

async function claim(ctx: PaymentsContext, pick: { withdrawalId: string; userId: string }): Promise<Claim | null> {
  return moneyTx(ctx.db, async (tx) => {
    const { compliance, withdrawal, dispatch } = await lockPair(tx, pick.userId, pick.withdrawalId);
    const now = ctx.now();
    const t = now.getTime();
    const isDue = (["PENDING", "RETRY_WAIT", "UNCERTAIN", "SENT"].includes(dispatch.status) && dispatch.nextAttemptAt.getTime() <= t)
      || (dispatch.status === "IN_FLIGHT" && dispatch.leaseUntil !== null && dispatch.leaseUntil.getTime() < t);
    if (!isDue) return null;
    // The last look before a send, in the transaction that would start it. Nothing changes: the row waits.
    if ((dispatch.status === "PENDING" || dispatch.status === "RETRY_WAIT") && await sendsStopped(tx, withdrawal.assetCode)) return null;
    if (withdrawal.status !== "APPROVED" && withdrawal.status !== "SUBMITTED") {
      logError({ alert: "PAYOUT_DISPATCH_ORPHAN", withdrawalId: withdrawal.id, status: withdrawal.status }, "dispatch row for a withdrawal that is not approved");
      if (dispatch.status === "PENDING" && dispatch.attempts === 0) await tx.payoutDispatch.update({ where: { withdrawalId: withdrawal.id }, data: { status: "CANCELLED" } });
      else await tx.payoutDispatch.update({ where: { withdrawalId: withdrawal.id }, data: { nextAttemptAt: new Date(t + 3_600_000) } });
      return null;
    }
    const uncertainLong = dispatch.uncertainSince !== null && t - dispatch.uncertainSince.getTime() > MANUAL_AFTER_MS;
    if (uncertainLong && (dispatch.status === "UNCERTAIN" || dispatch.status === "IN_FLIGHT")) {
      await toManual(tx, ctx, withdrawal, dispatch, "UNCERTAIN_24H");
      return null;
    }
    if (dispatch.status === "PENDING" || dispatch.status === "RETRY_WAIT") {
      // About to send. Nothing reached the provider before a first attempt, so the hold can go back;
      // after one (a retry) only a person can say what happened.
      const block = await payoutBlock(tx, compliance, withdrawal, now);
      if (block) {
        logWarn({ alert: "PAYOUT_BLOCKED", withdrawalId: withdrawal.id, code: block, attempts: dispatch.attempts }, "payout stopped before it was sent");
        if (dispatch.status === "PENDING" && dispatch.attempts === 0) {
          await tx.payoutDispatch.update({ where: { withdrawalId: withdrawal.id }, data: { status: "CANCELLED", lastError: block } });
          await releaseWithdrawal(tx, ctx, withdrawal, "CANCELLED", block, "Cancelled for your security");
        } else {
          await toManual(tx, ctx, withdrawal, dispatch, block);
        }
        return null;
      }
    }
    if (withdrawal.status === "APPROVED") {
      await tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "SUBMITTED", submittedAt: now } });
    }
    let action: Action;
    if (dispatch.status === "SENT") {
      action = "QUERY";
      // Polled in place (SENT cannot go back to IN_FLIGHT); a short soft lease stops a second poller.
      await tx.payoutDispatch.update({ where: { withdrawalId: withdrawal.id }, data: { queries: { increment: 1 }, lastAttemptAt: now, nextAttemptAt: new Date(t + LEASE_MS) } });
    } else if (dispatch.status === "UNCERTAIN" || dispatch.status === "IN_FLIGHT") {
      // An expired lease is a crash mid-call: the provider may have executed it. Ask before anything else.
      action = "QUERY";
      await tx.payoutDispatch.update({
        where: { withdrawalId: withdrawal.id },
        data: { status: "IN_FLIGHT", leaseUntil: new Date(t + LEASE_MS), lastAttemptAt: now, queries: { increment: 1 }, uncertainSince: dispatch.uncertainSince ?? now },
      });
    } else {
      action = "CREATE";
      await tx.payoutDispatch.update({
        where: { withdrawalId: withdrawal.id },
        data: { status: "IN_FLIGHT", leaseUntil: new Date(t + LEASE_MS), lastAttemptAt: now, attempts: { increment: 1 } },
      });
    }
    const after = await tx.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: withdrawal.id }, select: { attempts: true, queries: true } });
    return { withdrawalId: withdrawal.id, userId: withdrawal.userId, action, from: dispatch.status, seq: after.attempts + after.queries, startedAt: now };
  }, { label: "dispatch.claim" });
}

async function toManual(tx: MoneyTx, ctx: PaymentsContext, withdrawal: Withdrawal, dispatch: PayoutDispatch, reason: string): Promise<void> {
  if (dispatch.status === "IN_FLIGHT") await tx.payoutDispatch.update({ where: { withdrawalId: withdrawal.id }, data: { status: "UNCERTAIN" } });
  await tx.payoutDispatch.update({ where: { withdrawalId: withdrawal.id }, data: { status: "MANUAL", lastError: reason, leaseUntil: null } });
  await raiseIssue(tx, { code: "PAYOUT_MANUAL", severity: "CRITICAL", subjectType: "WITHDRAWAL", subjectId: withdrawal.id, details: { reason } }, ctx.now());
}

/** What the provider needs to send this payout (destination, refund source, the player as beneficiary). */
async function payoutInput(ctx: PaymentsContext, withdrawal: Withdrawal, dispatch: PayoutDispatch): Promise<PayoutInput> {
  const instrument = await ctx.db.paymentInstrument.findUniqueOrThrow({ where: { id: withdrawal.instrumentId! } });
  const compliance = await readCompliance(ctx.db, withdrawal.userId);
  const user = await ctx.db.user.findUnique({ where: { id: withdrawal.userId }, select: { email: true, emailVerifiedAt: true } });
  const party: TravelRuleParty = travelRuleParty(compliance, "BENEFICIARY")
    ?? { type: "BENEFICIARY", firstName: compliance.legalFirstName ?? "", lastName: compliance.legalLastName ?? "", dateOfBirth: "", countryCode: compliance.residenceCountry ?? "", relationship: "SELF_OWNED" };
  const destination = destinationOf(instrument);
  if (destination.kind === "CARD_TOKEN") destination.holderName = [compliance.legalFirstName, compliance.legalLastName].filter(Boolean).join(" ");
  let refundOf: PayoutInput["refundOf"];
  if (dispatch.operation === "REFUND" && withdrawal.sourceDepositId) {
    const source = await ctx.db.deposit.findUnique({ where: { id: withdrawal.sourceDepositId }, select: { providerPaymentId: true } });
    if (source?.providerPaymentId) refundOf = { providerPaymentId: source.providerPaymentId };
  }
  return {
    withdrawalId: withdrawal.id, idempotencyKey: dispatch.providerIdempotencyKey, operation: dispatch.operation, amountMinor: withdrawal.amountMinor,
    feeMinor: withdrawal.feeMinor, destination, ...(refundOf ? { refundOf } : {}),
    customer: customerRef({ userId: withdrawal.userId, email: user?.email ?? null, emailVerified: user?.emailVerifiedAt != null, ip: withdrawal.ip, country: withdrawal.ipCountry, compliance }),
    beneficiary: party,
  };
}

function backoffMs(queries: number): number {
  const minutes = UNCERTAIN_BACKOFF_MIN[Math.max(0, queries - 1)] ?? 60;
  return minutes * 60_000;
}

/**
 * Moves a dispatch to `target` where the state machine allows it directly,
 * or through IN_FLIGHT (RETRY_WAIT and PENDING cannot jump to an outcome).
 */
async function moveDispatch(tx: MoneyTx, dispatch: PayoutDispatch, target: PayoutDispatch["status"], data: Record<string, unknown>, now: Date): Promise<void> {
  if (dispatch.status === target && Object.keys(data).length === 0) return;
  if ((dispatch.status === "RETRY_WAIT" || dispatch.status === "PENDING") && target !== "IN_FLIGHT" && target !== "MANUAL" && target !== "CANCELLED") {
    await tx.payoutDispatch.update({ where: { withdrawalId: dispatch.withdrawalId }, data: { status: "IN_FLIGHT", leaseUntil: new Date(now.getTime() + LEASE_MS) } });
  }
  await tx.payoutDispatch.update({ where: { withdrawalId: dispatch.withdrawalId }, data: { status: target, ...data } });
}

/**
 * The provider's view of a payout, applied to its withdrawal and dispatch
 * (dispatch results and payout webhooks). The caller holds [L2] [L5] [L6].
 */
export async function applyPayoutStatus(tx: MoneyTx, ctx: PaymentsContext, withdrawal: Withdrawal, dispatch: PayoutDispatch, payout: ProviderPayout): Promise<EventOutcome> {
  const now = ctx.now();
  const ids = { ...(payout.providerPayoutId && !dispatch.providerPayoutId ? { providerPayoutId: payout.providerPayoutId.slice(0, 200) } : {}) };
  switch (payout.state) {
    case "SUCCEEDED":
    case "RETURNED": {
      if (withdrawal.status === "FAILED" || withdrawal.status === "CANCELLED" || withdrawal.status === "REJECTED") {
        // Paid after we released the hold: never post automatically. A person recovers it (ADJUSTMENT, two people).
        await raiseIssue(tx, { code: "PAYOUT_AFTER_RELEASE", severity: "CRITICAL", subjectType: "WITHDRAWAL", subjectId: withdrawal.id, details: { state: payout.state } }, now);
        return "NEEDS_REVIEW";
      }
      let current = withdrawal;
      if (current.status === "SUBMITTED") {
        current = await settleWithdrawal(tx, ctx, current, { providerPayoutId: payout.providerPayoutId, ...(payout.txHash ? { txHash: payout.txHash } : {}), ...(payout.payoutAmount ? { payoutAmount: payout.payoutAmount } : {}) });
      }
      if (dispatch.status !== "COMPLETED") await moveDispatch(tx, dispatch, "COMPLETED", { ...ids, leaseUntil: null, uncertainSince: null }, now);
      if (payout.state === "RETURNED") {
        if (current.status === "SETTLED") {
          await returnWithdrawal(tx, current, payout.returnedMinor ?? 0n);
          return "APPLIED";
        }
        return current.status === "RETURNED" ? "DUPLICATE" : "STALE";
      }
      return withdrawal.status === "SUBMITTED" ? "APPLIED" : "DUPLICATE";
    }
    case "FAILED": {
      if (withdrawal.status === "SETTLED" || withdrawal.status === "RETURNED") {
        await raiseIssue(tx, { code: "PAYOUT_FAILED_AFTER_SETTLE", severity: "CRITICAL", subjectType: "WITHDRAWAL", subjectId: withdrawal.id, details: {} }, now);
        return "NEEDS_REVIEW";
      }
      if (withdrawal.status !== "SUBMITTED") return "STALE";
      if (!payout.final) return "STALE";
      await moveDispatch(tx, dispatch, "FAILED", { ...ids, leaseUntil: null, lastError: (payout.failureCode ?? "FAILED").slice(0, 500) }, now);
      await releaseWithdrawal(tx, ctx, withdrawal, "FAILED", (payout.failureCode ?? "PROVIDER_REJECTED").slice(0, 64), "The payment provider could not send this payout");
      return "APPLIED";
    }
    case "ACCEPTED":
    case "PROCESSING": {
      if (withdrawal.status !== "SUBMITTED") return "STALE";
      if (dispatch.status === "SENT") {
        await tx.payoutDispatch.update({ where: { withdrawalId: dispatch.withdrawalId }, data: { ...ids, nextAttemptAt: new Date(now.getTime() + pollMs(ctx)) } });
        return "STALE";
      }
      if (dispatch.status === "COMPLETED" || dispatch.status === "FAILED" || dispatch.status === "MANUAL") return "STALE";
      await moveDispatch(tx, dispatch, "SENT", { ...ids, leaseUntil: null, uncertainSince: null, nextAttemptAt: new Date(now.getTime() + pollMs(ctx)) }, now);
      return "APPLIED";
    }
  }
}

const pollMs = (ctx: PaymentsContext) => (ctx.config.mode === "sandbox" ? 60_000 : 15 * 60_000);

/** Records one provider answer (PayoutAttempt) and applies it. */
async function record(ctx: PaymentsContext, provider: MoneyProvider, claimed: Claim, result: ProviderResult<ProviderPayout | null>, requestSha256: string | null): Promise<void> {
  await moneyTx(ctx.db, async (tx) => {
    const { withdrawal, dispatch } = await lockPair(tx, claimed.userId, claimed.withdrawalId);
    const now = ctx.now();
    const outcome = result.kind === "uncertain" ? "UNCERTAIN"
      : result.kind === "rejected" ? (result.final ? "REJECTED_FINAL" : "REJECTED_RETRYABLE")
        : result.value === null ? "NOT_FOUND"
          : result.value.state === "SUCCEEDED" || result.value.state === "RETURNED" ? "COMPLETED" : result.value.state === "FAILED" ? "REJECTED_FINAL" : "ACCEPTED";
    await tx.payoutAttempt.create({
      data: {
        withdrawalId: withdrawal.id, seq: claimed.seq,
        action: claimed.action === "CREATE" ? (dispatch.operation === "REFUND" ? "REFUND" : "CREATE") : "QUERY",
        // finishedAt on the same clock as startedAt and nextAttemptAt: the NOT_FOUND spacing below compares it.
        requestSha256, outcome, startedAt: claimed.startedAt, finishedAt: now,
        providerPayoutId: result.kind === "ok" && result.value?.providerPayoutId ? result.value.providerPayoutId.slice(0, 200) : null,
        errorClass: result.kind === "rejected" ? result.code.slice(0, 100) : result.kind === "uncertain" ? result.reason : null,
      },
    });
    // Someone else (a webhook) already finished it while we were calling the provider.
    if (dispatch.status === "COMPLETED" || dispatch.status === "FAILED" || dispatch.status === "MANUAL" || dispatch.status === "CANCELLED") return;
    if (result.kind === "ok" && result.value !== null) {
      await applyPayoutStatus(tx, ctx, withdrawal, dispatch, result.value);
      return;
    }
    if (result.kind === "rejected") {
      if (result.final) {
        await moveDispatch(tx, dispatch, "FAILED", { leaseUntil: null, lastError: result.code.slice(0, 500) }, now);
        await releaseWithdrawal(tx, ctx, withdrawal, "FAILED", result.code.slice(0, 64), "The payment provider could not send this payout");
        return;
      }
      logWarn({ alert: "PAYOUT_RETRY_LATER", withdrawalId: withdrawal.id, code: result.code.slice(0, 64) }, "provider refused a payout for now (balance or maintenance)");
      await moveDispatch(tx, dispatch, "RETRY_WAIT", { leaseUntil: null, lastError: result.code.slice(0, 500), nextAttemptAt: new Date(now.getTime() + 10 * 60_000) }, now);
      return;
    }
    if (result.kind === "ok" && result.value === null && claimed.action === "QUERY" && provider.dedupesOnOurKey && claimed.from !== "SENT") {
      // Two NOT_FOUND answers at least 10 minutes apart since the last send: safe to send again with the SAME key.
      const misses = await tx.payoutAttempt.findMany({
        where: { withdrawalId: withdrawal.id, outcome: "NOT_FOUND" },
        orderBy: { seq: "desc" },
        take: 2,
        select: { finishedAt: true, seq: true },
      });
      const lastSend = await tx.payoutAttempt.findFirst({ where: { withdrawalId: withdrawal.id, action: { in: ["CREATE", "REFUND"] } }, orderBy: { seq: "desc" }, select: { seq: true } });
      const sinceSend = misses.filter((miss) => miss.seq > (lastSend?.seq ?? 0));
      if (sinceSend.length >= 2 && sinceSend[0]!.finishedAt.getTime() - sinceSend[1]!.finishedAt.getTime() >= NOT_FOUND_SPACING_MS) {
        await moveDispatch(tx, dispatch, "RETRY_WAIT", { leaseUntil: null, lastError: "NOT_FOUND_TWICE", nextAttemptAt: now }, now);
        return;
      }
    }
    // Uncertain (or not found yet): never release; ask again later.
    const queries = dispatch.queries;
    if (dispatch.status === "SENT" && result.kind === "ok") {
      await tx.payoutDispatch.update({ where: { withdrawalId: withdrawal.id }, data: { nextAttemptAt: new Date(now.getTime() + pollMs(ctx)) } });
      return;
    }
    await moveDispatch(tx, dispatch, "UNCERTAIN", {
      leaseUntil: null, uncertainSince: dispatch.uncertainSince ?? now, lastError: result.kind === "uncertain" ? result.reason : "NOT_FOUND",
      nextAttemptAt: new Date(now.getTime() + backoffMs(queries + 1)),
    }, now);
  }, { label: "dispatch.record" });
}

/** One unit of payout work. Returns false when nothing was due. */
export async function dispatchOne(ctx: PaymentsContext): Promise<boolean> {
  const keys = configuredKeys(ctx.providers, ["card", "crypto"]);
  if (keys.length === 0) return false;
  const pick = await candidate(ctx, keys, !await sendsStopped(ctx.db, ctx.config.settlementAsset));
  if (!pick) return false;
  const claimed = await claim(ctx, pick);
  if (!claimed) return true;
  const withdrawal = await ctx.db.withdrawal.findUniqueOrThrow({ where: { id: claimed.withdrawalId } });
  const dispatch = await ctx.db.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: claimed.withdrawalId } });
  // candidate() took only keys of a built provider, and a context's providers do not change.
  const provider = moneyProviderByKey(ctx.providers, dispatch.providerKey)!;
  let result: ProviderResult<ProviderPayout | null>;
  let requestSha256: string | null = null;
  try {
    if (claimed.action === "QUERY") {
      result = await provider.getPayout({ idempotencyKey: dispatch.providerIdempotencyKey, providerPayoutId: dispatch.providerPayoutId });
    } else {
      const input = await payoutInput(ctx, withdrawal, dispatch);
      requestSha256 = await sha256HexAsync(canonicalJson({
        key: input.idempotencyKey, operation: input.operation, amountMinor: input.amountMinor.toString(), feeMinor: input.feeMinor.toString(),
        destination: input.destination.kind === "CARD_TOKEN" ? "card" : `${input.destination.network}:${input.destination.address}`,
      }));
      result = await provider.createPayout(input);
    }
  } catch (error) {
    // A thrown adapter error is as uncertain as a timeout: the request may have left.
    logWarn({ alert: "PAYOUT_ADAPTER_THREW", withdrawalId: claimed.withdrawalId, errName: error instanceof Error ? error.name : "Unknown" }, "payout adapter threw");
    result = { kind: "uncertain", reason: "network" };
  }
  try {
    await record(ctx, provider, claimed, result, requestSha256);
  } catch (error) {
    if (!(error instanceof PaymentsRefusal) || error.code !== "PAYMENTS_PAUSED") throw error;
    // An outcome that has to post, during a stop: nothing was written, and the provider is asked again later.
    logWarn({ alert: "PAYOUT_OUTCOME_PAUSED", withdrawalId: claimed.withdrawalId }, "payout outcome waits for the asset to be enabled");
    return false;
  }
  return true;
}
