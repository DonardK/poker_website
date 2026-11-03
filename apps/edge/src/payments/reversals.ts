/**
 * Chargebacks, provider refunds, chain reorganisations and won disputes
 * (docs/money/WALLET.md section 10.4). Lock order: [L1] event (caller) ->
 * [L2] compliance -> [L3] deposit -> [L5] open withdrawals -> [L6] their
 * dispatches -> [L8] ledger. A reversal first cancels the player's
 * withdrawals that have not reached the provider (so the money is in the
 * available balance), then takes what it can from the available balance; the
 * rest is a house loss (CHARGEBACK_LOSSES). A recovery is the exact inverse,
 * pro rata. Each dispute is applied once ((providerKey, kind, providerReversalId) is unique).
 *
 * The restriction a reversal brings commits first, on its own
 * (restrictForDispute): a reversal cannot post during an emergency stop, and
 * the account must not stay open until it can.
 */
import { WALLET_DECIMALS } from "@poker/shared";
import { logWarn } from "../http/log";
import { formatMinor } from "../money/amounts";
import { ensureAccounts, execute, getAccountBalance } from "../money/ledger";
import { planRecoverChargeback, planReverseDeposit } from "../money/flows";
import { ledgerKeys } from "../money/keys";
import { moneyTx, type MoneyTx } from "../money/tx";
import { lockCompliance, restrict } from "./compliance";
import type { MoneyProvider, PaymentsContext } from "./context";
import type { EventOutcome } from "./deposits";
import { enqueueEmail } from "./notify";
import type { ProviderDispute } from "./providers/types";
import { cancelUndispatchedWithdrawals, requestCancels } from "./withdrawals";

/** What a reversal does to the account, in a transaction that posts nothing. Does nothing for a dispute that will not reverse anything. */
export async function restrictForDispute(ctx: PaymentsContext, provider: MoneyProvider, dispute: ProviderDispute): Promise<void> {
  if (dispute.informational || dispute.kind === "CHARGEBACK_RECOVERY" || dispute.amountMinor <= 0n) return;
  await moneyTx(ctx.db, async (tx) => {
    const deposit = await tx.deposit.findUnique({
      where: { providerKey_providerPaymentId: { providerKey: provider.key, providerPaymentId: dispute.providerPaymentId } },
      select: { userId: true, ledgerCreditTxId: true, creditedMinor: true, reversedMinor: true, recoveredMinor: true },
    });
    if (!deposit || deposit.ledgerCreditTxId === null || deposit.creditedMinor === null) return;
    if (deposit.creditedMinor - (deposit.reversedMinor - deposit.recoveredMinor) <= 0n) return;
    const already = await tx.depositReversal.findUnique({
      where: { providerKey_kind_providerReversalId: { providerKey: provider.key, kind: dispute.kind, providerReversalId: dispute.providerReversalId } },
      select: { id: true },
    });
    if (already) return;
    const compliance = await lockCompliance(tx, deposit.userId);
    await restrict(tx, compliance, dispute.kind === "CHARGEBACK" ? "FROZEN" : "WITHDRAWALS_MANUAL", dispute.kind, null, ctx.now());
    await requestCancels(tx, deposit.userId, "CHARGEBACK_HOLD", { kinds: ["PLAYER", "REFUND"], now: ctx.now() });
  }, { label: "dispute.restrict" });
}

export async function applyDispute(tx: MoneyTx, ctx: PaymentsContext, provider: MoneyProvider, dispute: ProviderDispute, eventId: string | null): Promise<EventOutcome> {
  const found = await tx.deposit.findUnique({
    where: { providerKey_providerPaymentId: { providerKey: provider.key, providerPaymentId: dispute.providerPaymentId } },
    select: { id: true, userId: true },
  });
  if (!found) {
    logWarn({ alert: "DISPUTE_UNKNOWN_PAYMENT", provider: provider.key, kind: dispute.kind }, "dispute for a payment we never credited");
    return "UNKNOWN_OBJECT";
  }
  const compliance = await lockCompliance(tx, found.userId);
  await tx.$queryRaw`SELECT "id" FROM public."Deposit" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
  const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: found.id } });
  const already = await tx.depositReversal.findUnique({
    where: { providerKey_kind_providerReversalId: { providerKey: provider.key, kind: dispute.kind, providerReversalId: dispute.providerReversalId } },
    select: { id: true },
  });
  if (already) return "DUPLICATE";
  if (deposit.ledgerCreditTxId === null || deposit.creditedMinor === null) {
    logWarn({ alert: "DISPUTE_UNCREDITED", depositId: deposit.id, kind: dispute.kind }, "dispute for a deposit that was never credited");
    return "NEEDS_REVIEW";
  }
  if (dispute.informational) {
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "DEPOSIT", subjectId: deposit.id, subjectUserId: deposit.userId, actorKind: "SYSTEM", verb: "NOTE",
        reasonCode: `DISPUTE_${dispute.kind}_NOTICE`.slice(0, 64), metadata: { reasonCode: dispute.reasonCode ?? null },
      },
    });
    return "APPLIED";
  }
  const asset = deposit.assetCode;
  const p = deposit.providerKey;
  const now = ctx.now();
  const reversalId = crypto.randomUUID();

  if (dispute.kind === "CHARGEBACK_RECOVERY") {
    const original = dispute.recoversProviderReversalId
      ? await tx.depositReversal.findFirst({
        where: { depositId: deposit.id, providerReversalId: dispute.recoversProviderReversalId, kind: { not: "CHARGEBACK_RECOVERY" } },
      })
      : null;
    if (!original) return "NEEDS_REVIEW";
    const recovered = await tx.depositReversal.findUnique({ where: { recoversReversalId: original.id }, select: { id: true } });
    if (recovered) return "DUPLICATE";
    const amount = dispute.amountMinor < original.amountMinor ? dispute.amountMinor : original.amountMinor;
    if (amount <= 0n) return "STALE";
    // Pro rata, integer arithmetic, the remainder to the house.
    const userPortion = (original.userPortionMinor * amount) / original.amountMinor;
    await ensureAccounts(tx, [
      { asset, type: "USER_AVAILABLE", userId: deposit.userId },
      { asset, type: "DEPOSIT_CLEARING", providerKey: p },
      { asset, type: "CHARGEBACK_LOSSES" },
    ]);
    const ledgerTxId = await execute(tx, planRecoverChargeback({
      key: ledgerKeys.chargebackRecovery(p, dispute.providerReversalId), asset, userId: deposit.userId, providerKey: p, amount,
      providerReference: dispute.providerReversalId, userPortion, depositId: deposit.id, reversalId, recoversReversalId: original.id,
    }));
    await tx.depositReversal.create({
      data: {
        id: reversalId, depositId: deposit.id, userId: deposit.userId, providerKey: p, kind: "CHARGEBACK_RECOVERY",
        providerReversalId: dispute.providerReversalId.slice(0, 200), recoversReversalId: original.id, amountMinor: amount,
        userPortionMinor: userPortion, lossMinor: amount - userPortion, reasonCode: dispute.reasonCode?.slice(0, 64) ?? null, eventId, ledgerTxId,
      },
    });
    const recoveredMinor = deposit.recoveredMinor + amount;
    await tx.deposit.update({ where: { id: deposit.id }, data: { recoveredMinor, status: reversalStatus(deposit.creditedMinor, deposit.reversedMinor, recoveredMinor) } });
    // The restriction stays until an admin lifts it (UNRESTRICT).
    return "APPLIED";
  }

  // A reversal: never more than what is still credited.
  const outstanding = deposit.creditedMinor - (deposit.reversedMinor - deposit.recoveredMinor);
  if (outstanding <= 0n) return "STALE";
  let amount = dispute.amountMinor;
  if (amount > outstanding) {
    logWarn({ alert: "DISPUTE_OVER_CREDIT", depositId: deposit.id, kind: dispute.kind }, "dispute larger than the outstanding credit; capped");
    amount = outstanding;
  }
  if (amount <= 0n) return "STALE";
  await cancelUndispatchedWithdrawals(tx, ctx, deposit.userId, "CHARGEBACK_HOLD", { kinds: ["PLAYER", "REFUND"] });
  const [availableId] = await ensureAccounts(tx, [
    { asset, type: "USER_AVAILABLE", userId: deposit.userId },
    { asset, type: "USER_WITHDRAWAL_HOLD", userId: deposit.userId },
    { asset, type: "DEPOSIT_CLEARING", providerKey: p },
    { asset, type: "CHARGEBACK_LOSSES" },
  ]);
  // A concurrent spend can still lower the balance before the post: the post then fails
  // with LG011 and moneyTx retries the whole transaction (retryOn INSUFFICIENT_FUNDS).
  const balance = await getAccountBalance(tx, availableId!);
  const userPortion = balance <= 0n ? 0n : balance < amount ? balance : amount;
  const loss = amount - userPortion;
  const kind = dispute.kind as "CHARGEBACK" | "PROVIDER_REFUND" | "CHAIN_REORG";
  const ledgerTxId = await execute(tx, planReverseDeposit({
    key: ledgerKeys.depositReversal(p, dispute.providerReversalId, kind), asset, userId: deposit.userId, providerKey: p, amount,
    providerReference: dispute.providerReversalId, userPortion, depositId: deposit.id, reversalId, kind,
  }));
  await tx.depositReversal.create({
    data: {
      id: reversalId, depositId: deposit.id, userId: deposit.userId, providerKey: p, kind, providerReversalId: dispute.providerReversalId.slice(0, 200),
      amountMinor: amount, userPortionMinor: userPortion, lossMinor: loss, reasonCode: dispute.reasonCode?.slice(0, 64) ?? null, eventId, ledgerTxId,
    },
  });
  const reversedMinor = deposit.reversedMinor + amount;
  await tx.deposit.update({ where: { id: deposit.id }, data: { reversedMinor, status: reversalStatus(deposit.creditedMinor, reversedMinor, deposit.recoveredMinor) } });
  await tx.playerCompliance.update({
    where: { userId: deposit.userId },
    data: { chargebackCount: { increment: kind === "CHARGEBACK" ? 1 : 0 }, chargebackShortfallMinor: { increment: loss } },
  });
  await restrict(tx, compliance, kind === "CHARGEBACK" ? "FROZEN" : "WITHDRAWALS_MANUAL", kind, null, now);
  logWarn({ alert: "DEPOSIT_REVERSED", depositId: deposit.id, kind, lossMinor: loss.toString() }, "deposit reversed");
  await enqueueEmail(tx, ctx.config.settlementAsset, {
    userId: deposit.userId, template: "chargeback", dedupeKey: `chargeback:${reversalId}`,
    payload: { amount: formatMinor(amount, WALLET_DECIMALS), asset, depositId: deposit.id },
  });
  return "APPLIED";
}

/** CREDITED / PARTIALLY_REVERSED / REVERSED from the net reversed amount (the Deposit_valid CHECK). */
export function reversalStatus(credited: bigint, reversed: bigint, recovered: bigint): "CREDITED" | "PARTIALLY_REVERSED" | "REVERSED" {
  const net = reversed - recovered;
  if (net <= 0n) return "CREDITED";
  return net >= credited ? "REVERSED" : "PARTIALLY_REVERSED";
}
