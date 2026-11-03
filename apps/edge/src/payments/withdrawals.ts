/**
 * Withdrawals (docs/money/WALLET.md sections 7.2, 10.6-10.8).
 *
 * quote: a priced offer for one destination (no posting), valid for
 * WITHDRAWAL_QUOTE_TTL, with the step-up bind of exactly that offer.
 * request: one transaction that consumes the quote and the withdrawal grant,
 * inserts the Withdrawal, posts WITHDRAWAL_HOLD (insufficient funds rolls
 * everything back: no row remains), evaluates the review rules and either
 * approves it (SYSTEM action + PayoutDispatch outbox row, same commit) or
 * leaves it UNDER_REVIEW. No reverse withdrawals: a player may cancel only
 * while UNDER_REVIEW and only if ALLOW_WITHDRAWAL_CANCEL=true.
 *
 * Closed loop: a card receives at most what it deposited and kept, less what
 * it already received (cardPayoutRoom), with no clock, counted across the rows
 * one card can have. Checked at the quote and again under the compliance lock.
 * Anything above that needs a cooled-off payout address.
 *
 * Cancelling has two halves. requestCancels marks what must not leave and
 * posts nothing, so it commits with the protective change that asked for it
 * (a lockdown, a freeze, a screening hit) even during an emergency stop.
 * settleRequestedCancels releases the holds, each in its own transaction; the
 * dispatcher retries it until the ledger accepts.
 */
import {
  canonicalJson,
  RECENT_SECURITY_CHANGE_EVENT_TYPES,
  sha256HexAsync,
  withdrawalAction,
  type Page,
  type SettlementAsset,
  type WithdrawalQuoteResponse,
  type WithdrawalView,
} from "@poker/shared";
import type { PaymentInstrument, Withdrawal } from "../generated/prisma/client";
import { logError } from "../http/log";
import { ensureAccounts, execute } from "../money/ledger";
import { planHoldWithdrawal, planReleaseWithdrawal, planReturnWithdrawal, planSettleWithdrawal } from "../money/flows";
import { ledgerKeys, providerIdempotency } from "../money/keys";
import { moneyTx, type MoneyTx } from "../money/tx";
import { lockCompliance, readCompliance } from "./compliance";
import type { Caller, PageQuery, RequestWithdrawalInput } from "./contract";
import { moneyProviderByKey, type MoneyProvider, type PaymentsContext } from "./context";
import { parseAmount } from "./deposits";
import { NOT_ME_TTL_MS, signNotMe } from "./emails";
import { ProviderUnavailable, refuse } from "./errors";
import { assetEnabled, balances, readSwitches, WITHDRAW_SWITCH } from "./gate";
import { enqueueEmail } from "./notify";
import type { PayoutDestination } from "./providers/types";
import { evaluateWithdrawal } from "./rules";
import { isUuid, securityHeld, type CallerUser } from "./session";
import { consumeGrant, requirementFor } from "./stepup";
import { destinationView, money, withdrawalView } from "./views";

export const MAX_REQUESTS_PER_DAY = 5;
export const MAX_OPEN_WITHDRAWALS = 3;
const OPEN = ["HELD", "UNDER_REVIEW", "APPROVED", "SUBMITTED"] as const;
const CANCELLABLE = ["HELD", "UNDER_REVIEW", "APPROVED"] as const;

export function destinationOf(instrument: PaymentInstrument): PayoutDestination {
  if (instrument.kind === "CARD_TOKEN") return { kind: "CARD_TOKEN", token: instrument.cardToken ?? "", holderName: "" };
  return { kind: "CRYPTO_ADDRESS", asset: instrument.assetCode, network: instrument.network ?? "", address: instrument.addressNormalized ?? "", memo: instrument.memo };
}

/**
 * True for a refund that returns a deposit to where it came from: a card
 * deposit's refund to that deposit's own card. Any other refund goes to a
 * destination someone chose (a crypto refund to the address an administrator
 * named) and is a payout in all but name: every payout rule applies to it.
 */
export async function returnsToSource(db: PaymentsContext["db"] | MoneyTx, withdrawal: Withdrawal): Promise<boolean> {
  if (withdrawal.kind !== "REFUND" || withdrawal.sourceDepositId === null || withdrawal.instrumentId === null) return false;
  const deposit = await db.deposit.findUnique({ where: { id: withdrawal.sourceDepositId }, select: { instrumentId: true } });
  return deposit !== null && deposit.instrumentId === withdrawal.instrumentId;
}

function methodOf(instrument: PaymentInstrument): "CARD" | "CRYPTO" {
  return instrument.kind === "CARD_TOKEN" ? "CARD" : "CRYPTO";
}

async function usableInstrument(ctx: PaymentsContext, userId: string, instrumentId: string): Promise<{ instrument: PaymentInstrument; provider: MoneyProvider }> {
  if (!isUuid(instrumentId)) refuse("NOT_FOUND", "That payout destination does not exist.");
  const instrument = await ctx.db.paymentInstrument.findFirst({ where: { id: instrumentId, userId } });
  if (!instrument) refuse("NOT_FOUND", "That payout destination does not exist.");
  if (instrument.status !== "ACTIVE" || !instrument.payoutEnabled) refuse("DESTINATION_UNAVAILABLE", "This destination cannot receive payouts.");
  if (instrument.usableAfter.getTime() > ctx.now().getTime()) {
    refuse("DESTINATION_COOLING_OFF", "This new payout destination can be used a little later.", { details: { usableAfter: instrument.usableAfter.toISOString() } });
  }
  const provider = moneyProviderByKey(ctx.providers, instrument.providerKey);
  if (!provider) refuse("METHOD_DISABLED", "Payouts to this destination are not available right now.");
  // A card refund needs the asset the card settles in; an address pays out the settlement asset converted by the provider.
  if (instrument.kind === "CARD_TOKEN" && instrument.assetCode !== ctx.config.settlementAsset) refuse("DESTINATION_UNAVAILABLE", "This card belongs to another payment environment.");
  return { instrument, provider };
}

/**
 * What this card may still receive, for life: what it deposited and we kept
 * (credited, less anything refund-held or reversed, plus a refund that came
 * back unsent), less what went or is on its way to it. A payout that failed,
 * was cancelled or came back does not count. A card can have several rows (a
 * revoked one stays, a fresh deposit adds another): they are one card when
 * they carry this user's token or fingerprint with this provider.
 */
async function cardPayoutRoom(db: PaymentsContext["db"] | MoneyTx, instrument: PaymentInstrument): Promise<bigint> {
  const rows = await db.$queryRaw<{ deposited: string; unsent: string; paid: string }[]>`
    WITH card AS (
      SELECT p."id" FROM public."PaymentInstrument" p
       WHERE p."userId" = ${instrument.userId} AND p."providerKey" = ${instrument.providerKey} AND p."kind" = 'CARD_TOKEN'
         AND (p."cardToken" = ${instrument.cardToken} OR (${instrument.cardFingerprint}::text IS NOT NULL AND p."cardFingerprint" = ${instrument.cardFingerprint}::text)))
    SELECT
      (SELECT COALESCE(SUM(d."creditedMinor" - d."excessMinor" - d."reversedMinor" + d."recoveredMinor"), 0)::text FROM public."Deposit" d
        WHERE d."instrumentId" IN (SELECT "id" FROM card) AND d."ledgerCreditTxId" IS NOT NULL) AS deposited,
      (SELECT COALESCE(SUM(r."amountMinor"), 0)::text FROM public."Withdrawal" r JOIN public."Deposit" d ON d."id" = r."sourceDepositId"
        WHERE d."instrumentId" IN (SELECT "id" FROM card) AND r."kind" = 'REFUND' AND r."status" IN ('FAILED', 'REJECTED', 'CANCELLED')) AS unsent,
      (SELECT COALESCE(SUM(w."amountMinor"), 0)::text FROM public."Withdrawal" w
        WHERE w."instrumentId" IN (SELECT "id" FROM card) AND w."kind" = 'PLAYER'
          AND w."status" IN ('HELD', 'UNDER_REVIEW', 'APPROVED', 'SUBMITTED', 'SETTLED')) AS paid`;
  const room = BigInt(rows[0]?.deposited ?? "0") + BigInt(rows[0]?.unsent ?? "0") - BigInt(rows[0]?.paid ?? "0");
  return room > 0n ? room : 0n;
}

function refuseOverCardRoom(amountMinor: bigint, room: bigint): void {
  if (amountMinor <= room) return;
  refuse("CARD_PAYOUT_LIMIT", `This card can receive up to ${money(room)}: what it deposited, less what it has already received. Withdraw the rest to a payout address.`, { details: { max: money(room) } });
}

async function requireWithdrawOpen(ctx: PaymentsContext, user: CallerUser, method: "CARD" | "CRYPTO"): Promise<void> {
  const now = ctx.now();
  if (securityHeld(user, now)) refuse("SECURITY_HOLD", "Withdrawals are paused for a while after a security change.", { details: { until: user.securityHoldUntil!.toISOString() } });
  if (!await assetEnabled(ctx.db, ctx.config.settlementAsset)) refuse("PAYMENTS_PAUSED", "Payments are paused. Please try again later.", { retryable: true });
  if (!(await readSwitches(ctx.db))[WITHDRAW_SWITCH[method]]) refuse("METHOD_DISABLED", "Withdrawals by this method are not available right now.");
  const compliance = await readCompliance(ctx.db, user.id);
  if (compliance.kycStatus !== "VERIFIED") refuse("KYC_REQUIRED", "Verify your identity before you withdraw.");
  if (compliance.screeningStatus !== "CLEAR" || compliance.restriction === "FROZEN") refuse("ACCOUNT_RESTRICTED", "Withdrawals are on hold for your account. Contact support.");
}

export async function quoteWithdrawal(ctx: PaymentsContext, user: CallerUser, input: { instrumentId: string; amount: string }): Promise<WithdrawalQuoteResponse> {
  const amountMinor = parseAmount(input?.amount);
  const { instrument, provider } = await usableInstrument(ctx, user.id, input?.instrumentId);
  await requireWithdrawOpen(ctx, user, methodOf(instrument));
  const { limits } = ctx.config;
  if (amountMinor < limits.withdrawalMinMinor) refuse("AMOUNT_BELOW_MIN", `The minimum withdrawal is ${money(limits.withdrawalMinMinor)}.`, { details: { min: money(limits.withdrawalMinMinor) } });
  if (amountMinor > limits.withdrawalMaxMinor) refuse("AMOUNT_ABOVE_MAX", `The maximum withdrawal is ${money(limits.withdrawalMaxMinor)}.`, { details: { max: money(limits.withdrawalMaxMinor) } });
  const asset = ctx.config.settlementAsset;
  const { available } = await balances(ctx.db, user.id, asset);
  if (available < amountMinor) refuse("INSUFFICIENT_FUNDS", "Your balance is too low for this withdrawal.", { details: { available: money(available) } });
  if (instrument.kind === "CARD_TOKEN") refuseOverCardRoom(amountMinor, await cardPayoutRoom(ctx.db, instrument));
  const priced = await provider.quotePayout({ amountMinor, destination: destinationOf(instrument) });
  if (priced.kind === "uncertain") throw new ProviderUnavailable(provider.key, priced.reason);
  if (priced.kind === "rejected") refuse(priced.final ? "DESTINATION_UNAVAILABLE" : "PROVIDER_UNAVAILABLE", "This destination cannot receive this payout right now.", { retryable: !priced.final });
  const fee = priced.value.feeMinor;
  if (fee < 0n || fee >= amountMinor) refuse("AMOUNT_BELOW_MIN", "This amount does not cover the payout fee.");
  const now = ctx.now();
  const quoteId = crypto.randomUUID();
  const expiresAt = new Date(Math.min(now.getTime() + ctx.config.withdrawalQuoteTtlMs, priced.value.expiresAt.getTime()));
  const requirement = await requirementFor(withdrawalAction({
    userId: user.id, asset, instrumentId: instrument.id, amountMinor: amountMinor.toString(), feeMinor: fee.toString(), quoteId,
  }));
  const receiveAsset = instrument.kind === "CARD_TOKEN" ? asset : instrument.assetCode;
  await ctx.db.withdrawalQuote.create({
    data: {
      id: quoteId, userId: user.id, instrumentId: instrument.id, providerKey: provider.key, assetCode: asset, amountMinor, feeMinor: fee,
      receiveAssetCode: receiveAsset, receiveEstimate: priced.value.receiveEstimate?.slice(0, 64) ?? null, rate: priced.value.rate?.slice(0, 64) ?? null,
      bindHash: requirement.bind, expiresAt,
    },
  });
  return {
    quote: {
      id: quoteId, asset, amount: money(amountMinor), fee: money(fee), youReceive: money(amountMinor - fee), receiveAsset,
      receiveEstimate: priced.value.receiveEstimate, rate: priced.value.rate, expiresAt: expiresAt.toISOString(),
    },
    stepUp: requirement,
  };
}

interface RuleFacts {
  settled: number;
  autoApproved: bigint;
  shared: boolean;
  cumulative: bigint;
  recentDepositCard: boolean;
  closedLoop: bigint;
  buyIns: bigint;
  depositsSince: bigint;
  recentSecurityChange: boolean;
  notMe: boolean;
}

/** The SQL reads behind evaluateWithdrawal (section 10.7), inside the request transaction. */
async function ruleFacts(tx: MoneyTx, userId: string, asset: string, instrument: PaymentInstrument, withdrawalId: string, now: Date): Promise<RuleFacts> {
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const ninety = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const threeDays = new Date(now.getTime() - 72 * 3_600_000).toISOString();
  const thirty = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const securityTypes = RECENT_SECURITY_CHANGE_EVENT_TYPES.join(",");
  const rows = await tx.$queryRaw<{
    settled: number; auto_approved: string; shared: boolean; cumulative: string; recent_card: boolean; card_deposits: string; card_payouts: string;
    buy_ins: string; deposits_since: string; security: boolean; not_me: boolean;
  }[]>`
    WITH last_settled AS (
      SELECT MAX("settledAt") AS at FROM public."Withdrawal" WHERE "userId" = ${userId} AND "status" IN ('SETTLED', 'RETURNED')),
    last_credit AS (
      SELECT MAX("creditedAt") AS at FROM public."Deposit" WHERE "userId" = ${userId} AND "assetCode" = ${asset} AND "ledgerCreditTxId" IS NOT NULL)
    SELECT
      (SELECT COUNT(*)::int FROM public."Withdrawal" WHERE "userId" = ${userId} AND "status" IN ('SETTLED', 'RETURNED')) AS settled,
      (SELECT COALESCE(SUM(w."amountMinor"), 0)::text FROM public."Withdrawal" w
        WHERE w."userId" = ${userId} AND w."id" <> ${withdrawalId}::uuid AND w."decidedAt" >= ${day}::timestamp
          AND EXISTS (SELECT 1 FROM public."PaymentReviewAction" a WHERE a."subjectType" = 'WITHDRAWAL' AND a."subjectId" = w."id"::text
                       AND a."verb" = 'APPROVE' AND a."actorKind" = 'SYSTEM')) AS auto_approved,
      EXISTS (SELECT 1 FROM public."PaymentInstrument" p WHERE p."userId" <> ${userId} AND p."status" = 'ACTIVE'
               AND ((${instrument.addressNormalized}::text IS NOT NULL AND p."addressNormalized" = ${instrument.addressNormalized}::text)
                 OR (${instrument.cardFingerprint}::text IS NOT NULL AND p."cardFingerprint" = ${instrument.cardFingerprint}::text))) AS shared,
      (SELECT COALESCE(SUM("amountMinor"), 0)::text FROM public."Withdrawal" WHERE "instrumentId" = ${instrument.id}::uuid
        AND "status" IN ('HELD', 'UNDER_REVIEW', 'APPROVED', 'SUBMITTED', 'SETTLED')) AS cumulative,
      EXISTS (SELECT 1 FROM public."Deposit" WHERE "instrumentId" = ${instrument.id}::uuid AND "ledgerCreditTxId" IS NOT NULL
               AND "createdAt" >= ${ninety}::timestamp) AS recent_card,
      (SELECT COALESCE(SUM("creditedMinor" - "excessMinor"), 0)::text FROM public."Deposit" WHERE "userId" = ${userId} AND "method" = 'CARD'
        AND "ledgerCreditTxId" IS NOT NULL AND "createdAt" >= ${ninety}::timestamp) AS card_deposits,
      (SELECT COALESCE(SUM(w."amountMinor"), 0)::text FROM public."Withdrawal" w JOIN public."PaymentInstrument" p ON p."id" = w."instrumentId"
        WHERE w."userId" = ${userId} AND p."kind" = 'CARD_TOKEN' AND w."kind" = 'PLAYER' AND w."status" IN ('SETTLED', 'SUBMITTED', 'APPROVED')
          AND w."createdAt" >= ${ninety}::timestamp) AS card_payouts,
      (SELECT COALESCE(-SUM(e."amount"), 0)::text FROM public."LedgerEntry" e
         JOIN public."LedgerAccount" a ON a."id" = e."accountId" JOIN public."LedgerTransaction" t ON t."id" = e."transactionId"
        WHERE a."userId" = ${userId} AND a."assetCode" = ${asset} AND a."type" = 'USER_AVAILABLE' AND t."type" = 'BUY_IN'
          AND t."createdAt" >= COALESCE((SELECT at FROM last_credit), 'epoch'::timestamp)) AS buy_ins,
      (SELECT COALESCE(SUM("creditedMinor" - "excessMinor"), 0)::text FROM public."Deposit" WHERE "userId" = ${userId} AND "assetCode" = ${asset}
        AND "ledgerCreditTxId" IS NOT NULL AND "creditedAt" >= COALESCE((SELECT at FROM last_settled), 'epoch'::timestamp)) AS deposits_since,
      EXISTS (SELECT 1 FROM public."AccountSecurityEvent" WHERE "userId" = ${userId} AND "createdAt" >= ${threeDays}::timestamp
               AND "type" = ANY (string_to_array(${securityTypes}, ','))) AS security,
      EXISTS (SELECT 1 FROM public."AccountSecurityEvent" WHERE "userId" = ${userId} AND "createdAt" >= ${thirty}::timestamp
               AND "type" = 'NOT_ME_REPORTED') AS not_me`;
  const row = rows[0]!;
  return {
    settled: row.settled, autoApproved: BigInt(row.auto_approved), shared: row.shared, cumulative: BigInt(row.cumulative),
    recentDepositCard: row.recent_card, closedLoop: BigInt(row.card_deposits) - BigInt(row.card_payouts), buyIns: BigInt(row.buy_ins),
    depositsSince: BigInt(row.deposits_since), recentSecurityChange: row.security, notMe: row.not_me,
  };
}

export async function requestWithdrawal(ctx: PaymentsContext, caller: Caller, user: CallerUser, input: RequestWithdrawalInput): Promise<{ view: WithdrawalView; replay: boolean }> {
  if (!isUuid(input?.clientRequestId)) refuse("IDEMPOTENCY_KEY_REQUIRED", "This request needs an Idempotency-Key.");
  if (!isUuid(input.quoteId)) refuse("QUOTE_EXPIRED", "That quote is not valid. Get a new quote.");
  const quote = await ctx.db.withdrawalQuote.findFirst({ where: { id: input.quoteId, userId: user.id } });
  if (!quote) refuse("QUOTE_EXPIRED", "That quote is not valid. Get a new quote.");
  const requestHash = await sha256HexAsync(canonicalJson({ quoteId: quote.id }));
  const instrument = await ctx.db.paymentInstrument.findUnique({ where: { id: quote.instrumentId } });
  if (!instrument) refuse("DESTINATION_UNAVAILABLE", "This destination cannot receive payouts.");
  const method = methodOf(instrument);
  const existing = await ctx.db.withdrawal.findUnique({ where: { userId_clientRequestId: { userId: user.id, clientRequestId: input.clientRequestId } } });
  if (existing) {
    if (existing.requestHash !== requestHash) refuse("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different withdrawal.");
    return { view: withdrawalView(existing, instrument), replay: true };
  }
  await requireWithdrawOpen(ctx, user, method);
  const requirement = await requirementFor(withdrawalAction({
    userId: user.id, asset: quote.assetCode as SettlementAsset, instrumentId: quote.instrumentId,
    amountMinor: quote.amountMinor.toString(), feeMinor: quote.feeMinor.toString(), quoteId: quote.id,
  }));
  const switches = await readSwitches(ctx.db);
  const now = ctx.now();
  const result = await moneyTx(ctx.db, async (tx) => {
    const compliance = await lockCompliance(tx, user.id);
    if (compliance.kycStatus !== "VERIFIED") refuse("KYC_REQUIRED", "Verify your identity before you withdraw.");
    if (compliance.screeningStatus !== "CLEAR" || compliance.restriction === "FROZEN") refuse("ACCOUNT_RESTRICTED", "Withdrawals are on hold for your account. Contact support.");
    // Self-exclusion does not block withdrawals (the balance is the player's).
    const replay = await tx.withdrawal.findUnique({ where: { userId_clientRequestId: { userId: user.id, clientRequestId: input.clientRequestId } } });
    if (replay) {
      if (replay.requestHash !== requestHash) refuse("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different withdrawal.");
      return { withdrawal: replay, replay: true };
    }
    const lastDay = await tx.withdrawal.count({ where: { userId: user.id, kind: "PLAYER", createdAt: { gte: new Date(now.getTime() - 86_400_000) } } });
    const open = await tx.withdrawal.count({ where: { userId: user.id, kind: "PLAYER", status: { in: [...OPEN] } } });
    if (lastDay >= MAX_REQUESTS_PER_DAY || open >= MAX_OPEN_WITHDRAWALS) refuse("TOO_MANY_PENDING", "You have too many withdrawals in progress. Wait for them to finish.");
    // [L7] the quote, the destination, the grant.
    const locked = await tx.$queryRaw<{ consumed: boolean; expired: boolean }[]>`
      SELECT ("consumedAt" IS NOT NULL) AS consumed, ("expiresAt" <= CURRENT_TIMESTAMP) AS expired
        FROM public."WithdrawalQuote" WHERE "id" = ${quote.id}::uuid AND "userId" = ${user.id} FOR UPDATE`;
    const state = locked[0];
    if (!state || state.consumed || state.expired) refuse("QUOTE_EXPIRED", "That quote expired. Get a new quote.");
    const destination = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT ("status" = 'ACTIVE' AND "payoutEnabled" AND "usableAfter" <= CURRENT_TIMESTAMP) AS ok
        FROM public."PaymentInstrument" WHERE "id" = ${quote.instrumentId}::uuid FOR SHARE`;
    if (!destination[0]?.ok) refuse("DESTINATION_UNAVAILABLE", "This destination cannot receive payouts right now.");
    if (instrument.kind === "CARD_TOKEN") refuseOverCardRoom(quote.amountMinor, await cardPayoutRoom(tx, instrument));
    const proof = await consumeGrant(tx, { grantId: input.stepUpGrantId, userId: user.id, sessionId: caller.sessionId, requirement });
    await tx.withdrawalQuote.update({ where: { id: quote.id }, data: { consumedAt: new Date() } });
    const withdrawal = await tx.withdrawal.create({
      data: {
        userId: user.id, kind: "PLAYER", clientRequestId: input.clientRequestId, requestHash, quoteId: quote.id, instrumentId: quote.instrumentId,
        providerKey: quote.providerKey, assetCode: quote.assetCode, amountMinor: quote.amountMinor, feeMinor: quote.feeMinor,
        payoutAssetCode: quote.receiveAssetCode, payoutRate: quote.rate, sessionId: caller.sessionId, stepUpGrantId: input.stepUpGrantId,
        ip: caller.ip?.slice(0, 64) ?? null, ipCountry: caller.ipCountry && /^[A-Z0-9]{2}$/.test(caller.ipCountry) ? caller.ipCountry : null,
      },
    });
    await ensureAccounts(tx, [
      { asset: quote.assetCode, type: "USER_AVAILABLE", userId: user.id },
      { asset: quote.assetCode, type: "USER_WITHDRAWAL_HOLD", userId: user.id },
    ]);
    // LG011 here rolls the whole transaction back (moneyTx answers 422 INSUFFICIENT_FUNDS): no Withdrawal row remains.
    const holdTxId = await execute(tx, planHoldWithdrawal({
      key: ledgerKeys.withdrawalHold(withdrawal.id), asset: quote.assetCode, userId: user.id, withdrawalId: withdrawal.id, amount: quote.amountMinor,
    }));
    const facts = await ruleFacts(tx, user.id, quote.assetCode, instrument, withdrawal.id, now);
    const decision = evaluateWithdrawal({
      kind: "PLAYER", method, amountMinor: quote.amountMinor, liveMode: ctx.config.mode === "live", autoApproveEnabled: switches.AUTO_APPROVE,
      limits: ctx.config.limits, settledWithdrawals: facts.settled, autoApprovedLast24hMinor: facts.autoApproved,
      compliance: {
        riskLevel: compliance.riskLevel, screeningStatus: compliance.screeningStatus, sourceOfFundsStatus: compliance.sourceOfFundsStatus,
        restriction: compliance.restriction, chargebackCount: compliance.chargebackCount,
      },
      destination: {
        successfulPayouts: instrument.successfulPayouts, createdAt: instrument.createdAt, sharedWithOtherUser: facts.shared,
        ownershipVerified: instrument.ownershipVerifiedAt !== null, cumulativeMinor: facts.cumulative, isRecentDepositCard: facts.recentDepositCard,
      },
      closedLoopOutstandingMinor: facts.closedLoop, buyInSinceLastDepositMinor: facts.buyIns, depositsSinceLastWithdrawalMinor: facts.depositsSince,
      recentSecurityChange: facts.recentSecurityChange, notMeReported: facts.notMe, now,
    });
    await tx.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: "HELD", holdTxId, heldAt: now, reviewReasons: decision.reasons, approvalsRequired: decision.approvalsRequired, rulesVersion: decision.rulesVersion },
    });
    let final: Withdrawal;
    if (decision.action === "AUTO_APPROVE") {
      await tx.paymentReviewAction.create({
        data: { subjectType: "WITHDRAWAL", subjectId: withdrawal.id, subjectUserId: user.id, actorKind: "SYSTEM", verb: "APPROVE", reasonCode: "AUTO_APPROVE", metadata: { proof } },
      });
      await tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "APPROVED", decidedAt: now } });
      final = await queueDispatch(tx, withdrawal.id);
    } else {
      final = await tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "UNDER_REVIEW" } });
    }
    const secret = ctx.config.notifyLinkSecret;
    const notMe = secret ? await signNotMe(secret, { u: user.id, k: "withdrawal-requested", s: withdrawal.id, e: now.getTime() + NOT_ME_TTL_MS }) : null;
    await enqueueEmail(tx, quote.assetCode, {
      userId: user.id, template: "withdrawal-requested", dedupeKey: `withdrawal-requested:${withdrawal.id}`,
      payload: { amount: money(quote.amountMinor), asset: quote.assetCode, withdrawalId: withdrawal.id, destination: destinationView(instrument)?.display ?? "", ...(notMe ? { notMe } : {}) },
    });
    return { withdrawal: final, replay: false };
  }, { label: "withdrawal.request" });
  if (result.withdrawal.status === "APPROVED") ctx.defer(ctx.kick());
  return { view: withdrawalView(result.withdrawal, instrument), replay: result.replay };
}

/** The PayoutDispatch outbox row of an APPROVED withdrawal (same transaction as the approval). */
export async function queueDispatch(tx: MoneyTx, withdrawalId: string): Promise<Withdrawal> {
  const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  await tx.payoutDispatch.create({
    data: {
      withdrawalId, userId: withdrawal.userId, providerKey: withdrawal.providerKey!, operation: withdrawal.kind === "REFUND" ? "REFUND" : "PAYOUT",
      providerIdempotencyKey: withdrawal.kind === "REFUND" ? providerIdempotency.refund(withdrawalId) : providerIdempotency.payout(withdrawalId),
    },
  });
  return withdrawal;
}

/**
 * Release a withdrawal's hold (REJECTED, CANCELLED or FAILED) in the
 * caller's transaction, which already holds [L2] and [L5]. Sets the status
 * and releaseTxId together (the binding trigger checks both at commit).
 */
export async function releaseWithdrawal(tx: MoneyTx, ctx: PaymentsContext, withdrawal: Withdrawal, status: "REJECTED" | "CANCELLED" | "FAILED", failureCode: string, reason: string): Promise<Withdrawal> {
  await ensureAccounts(tx, [
    { asset: withdrawal.assetCode, type: "USER_AVAILABLE", userId: withdrawal.userId },
    { asset: withdrawal.assetCode, type: "USER_WITHDRAWAL_HOLD", userId: withdrawal.userId },
  ]);
  const releaseTxId = await execute(tx, planReleaseWithdrawal({
    key: ledgerKeys.withdrawalRelease(withdrawal.id), asset: withdrawal.assetCode, userId: withdrawal.userId, withdrawalId: withdrawal.id,
    amount: withdrawal.amountMinor, reason: failureCode,
  }));
  const updated = await tx.withdrawal.update({
    where: { id: withdrawal.id },
    data: { status, releaseTxId, failureCode: failureCode.slice(0, 64), failureReason: reason.slice(0, 200), closedAt: ctx.now(), ...(status !== "FAILED" ? { decidedAt: ctx.now() } : {}) },
  });
  await enqueueEmail(tx, withdrawal.assetCode, {
    userId: withdrawal.userId, template: "withdrawal-failed", dedupeKey: `withdrawal-failed:${withdrawal.id}`,
    payload: { amount: money(withdrawal.amountMinor), asset: withdrawal.assetCode, withdrawalId: withdrawal.id, reason: reason.slice(0, 100) },
  });
  return updated;
}

const cancelReason = (code: string) => (code === "CHARGEBACK_HOLD" ? "A deposit was disputed" : "Cancelled for your security");

/**
 * Cancels this Worker's withdrawals of the user that have not reached the
 * provider (HELD, UNDER_REVIEW, or APPROVED with no dispatch attempt yet), with
 * releases, in the caller's transaction: for a flow that needs the money back
 * before it can go on (a reversal), which cannot complete during a stop anyway.
 * SUBMITTED ones are left alone (point of no return). Locks [L5] withdrawals
 * by ascending id, then [L6] their dispatches.
 */
export async function cancelUndispatchedWithdrawals(tx: MoneyTx, ctx: PaymentsContext, userId: string, code: string, opts: { kinds: ("PLAYER" | "REFUND")[] }): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS id FROM public."Withdrawal" WHERE "userId" = ${userId} AND "assetCode" = ${ctx.config.settlementAsset}
       AND "status" IN ('HELD', 'UNDER_REVIEW', 'APPROVED')
     ORDER BY "id" FOR UPDATE`;
  let cancelled = 0;
  for (const { id } of rows) {
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id } });
    if (!opts.kinds.includes(withdrawal.kind)) continue;
    const dispatch = await tx.$queryRaw<{ status: string; attempts: number }[]>`
      SELECT "status"::text AS status, "attempts" FROM public."PayoutDispatch" WHERE "withdrawalId" = ${id}::uuid FOR UPDATE`;
    const d = dispatch[0];
    if (d && !(d.status === "PENDING" && d.attempts === 0)) continue;
    if (d) await tx.payoutDispatch.update({ where: { withdrawalId: id }, data: { status: "CANCELLED", lastError: code } });
    await releaseWithdrawal(tx, ctx, withdrawal, "CANCELLED", code, cancelReason(code));
    cancelled += 1;
  }
  return cancelled;
}

/**
 * The protective half: marks every withdrawal of the user that has not reached
 * the provider, so it can only be released from now on (the database refuses
 * to approve or submit it, and the dispatcher cancels it instead of sending).
 * Posts nothing, so it commits whatever the ledger would say. It covers every
 * asset: a lockdown is about the account, whichever Worker recorded it, and
 * each Worker then releases only its own (settleRequestedCancels). Same lock
 * order as above. Returns how many were marked.
 *
 * "PLAYER" means every payout: a player's withdrawal, and a refund sent to a
 * destination someone chose (a crypto refund to the address an administrator
 * named), which is a payout in all but name. "REFUND" adds the refunds that
 * return a deposit to its own card, and those still waiting for a destination.
 */
export async function requestCancels(tx: MoneyTx, userId: string, code: string, opts: { kinds: ("PLAYER" | "REFUND")[]; now: Date }): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string; kind: "PLAYER" | "REFUND" }[]>`
    SELECT w."id"::text AS id,
           (CASE WHEN w."kind" = 'REFUND' AND w."instrumentId" IS NOT NULL AND w."instrumentId" IS DISTINCT FROM d."instrumentId"
                 THEN 'PLAYER' ELSE w."kind"::text END) AS kind
      FROM public."Withdrawal" w LEFT JOIN public."Deposit" d ON d."id" = w."sourceDepositId"
     WHERE w."userId" = ${userId} AND w."status" IN ('HELD', 'UNDER_REVIEW', 'APPROVED') AND w."cancelRequestedAt" IS NULL
     ORDER BY w."id" FOR UPDATE OF w`;
  let marked = 0;
  for (const { id, kind } of rows) {
    if (!opts.kinds.includes(kind)) continue;
    const dispatch = await tx.$queryRaw<{ status: string; attempts: number }[]>`
      SELECT "status"::text AS status, "attempts" FROM public."PayoutDispatch" WHERE "withdrawalId" = ${id}::uuid FOR UPDATE`;
    const d = dispatch[0];
    if (d && !(d.status === "PENDING" && d.attempts === 0)) continue;
    await tx.withdrawal.update({ where: { id }, data: { cancelRequestedAt: opts.now, cancelCode: code.slice(0, 64) } });
    marked += 1;
  }
  return marked;
}

/** Releases one marked withdrawal in its own transaction. False when nothing was left to release. */
async function releaseRequested(ctx: PaymentsContext, withdrawalId: string, userId: string): Promise<boolean> {
  return moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, userId);
    await tx.$queryRaw`SELECT "id" FROM public."Withdrawal" WHERE "id" = ${withdrawalId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "withdrawalId" FROM public."PayoutDispatch" WHERE "withdrawalId" = ${withdrawalId}::uuid FOR UPDATE`;
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    const code = withdrawal.cancelCode;
    if (code === null || !(CANCELLABLE as readonly string[]).includes(withdrawal.status)) return false;
    const dispatch = await tx.payoutDispatch.findUnique({ where: { withdrawalId }, select: { status: true, attempts: true } });
    if (dispatch && !(dispatch.status === "PENDING" && dispatch.attempts === 0)) return false;
    if (dispatch) await tx.payoutDispatch.update({ where: { withdrawalId }, data: { status: "CANCELLED", lastError: code } });
    await releaseWithdrawal(tx, ctx, withdrawal, "CANCELLED", code, cancelReason(code));
    return true;
  }, { label: "withdrawal.cancel-requested" });
}

/**
 * The money half: releases marked withdrawals of this Worker's asset, one
 * transaction each, so a row that fails holds up no other. Nothing can post
 * while the asset is disabled, so it does not try then. Random order: a row
 * that always fails cannot keep a place at the head of the queue, and it logs
 * an alert every time it is tried. Never throws; returns how many were released.
 */
export async function settleRequestedCancels(ctx: PaymentsContext, opts: { userId?: string; limit?: number } = {}): Promise<number> {
  const asset = ctx.config.settlementAsset;
  if (!await assetEnabled(ctx.db, asset)) return 0;
  const userId = opts.userId ?? null;
  const rows = await ctx.db.$queryRaw<{ id: string; userId: string }[]>`
    SELECT "id"::text AS id, "userId" FROM public."Withdrawal"
     WHERE "cancelRequestedAt" IS NOT NULL AND "status" IN ('HELD', 'UNDER_REVIEW', 'APPROVED') AND "assetCode" = ${asset}
       AND (${userId}::text IS NULL OR "userId" = ${userId}::text)
     ORDER BY random() LIMIT ${opts.limit ?? 20}`;
  let released = 0;
  for (const row of rows) {
    try {
      if (await releaseRequested(ctx, row.id, row.userId)) released += 1;
    } catch (error) {
      logError({ alert: "WITHDRAWAL_CANCEL_RETRY_FAILED", withdrawalId: row.id, errName: error instanceof Error ? error.name : "Unknown" }, "a withdrawal marked for cancelling could not be released; it stays stopped and is tried again");
    }
  }
  return released;
}

export async function cancelWithdrawal(ctx: PaymentsContext, user: CallerUser, withdrawalId: string): Promise<WithdrawalView> {
  if (!isUuid(withdrawalId)) refuse("NOT_FOUND", "That withdrawal does not exist.");
  if (!ctx.config.allowWithdrawalCancel) refuse("CANCEL_DISABLED", "Withdrawals cannot be cancelled once requested.");
  const row = await moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, user.id);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id"::text AS id FROM public."Withdrawal" WHERE "id" = ${withdrawalId}::uuid AND "userId" = ${user.id} FOR UPDATE`;
    if (locked.length === 0) refuse("NOT_FOUND", "That withdrawal does not exist.");
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    if (withdrawal.kind !== "PLAYER" || withdrawal.status !== "UNDER_REVIEW") refuse("INVALID_STATE", "This withdrawal can no longer be cancelled.");
    return releaseWithdrawal(tx, ctx, withdrawal, "CANCELLED", "PLAYER_CANCELLED", "Cancelled at your request");
  }, { label: "withdrawal.cancel" });
  const instrument = row.instrumentId ? await ctx.db.paymentInstrument.findUnique({ where: { id: row.instrumentId } }) : null;
  return withdrawalView(row, instrument);
}

export async function getWithdrawal(ctx: PaymentsContext, userId: string, withdrawalId: string): Promise<WithdrawalView> {
  if (!isUuid(withdrawalId)) refuse("NOT_FOUND", "That withdrawal does not exist.");
  const row = await ctx.db.withdrawal.findFirst({ where: { id: withdrawalId, userId }, include: { instrument: true } });
  if (!row) refuse("NOT_FOUND", "That withdrawal does not exist.");
  return withdrawalView(row, row.instrument);
}

export async function listWithdrawals(ctx: PaymentsContext, userId: string, query: PageQuery): Promise<Page<WithdrawalView>> {
  const limit = Math.min(Math.max(Math.trunc(Number(query?.limit ?? 20)) || 20, 1), 50);
  const before = query?.cursor && /^\d{13}:[0-9a-f-]{36}$/.test(query.cursor) ? query.cursor : null;
  const where = before
    ? { userId, OR: [{ createdAt: { lt: new Date(Number(before.slice(0, 13))) } }, { createdAt: new Date(Number(before.slice(0, 13))), id: { lt: before.slice(14) } }] }
    : { userId };
  const rows = await ctx.db.withdrawal.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, include: { instrument: true } });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => withdrawalView(row, row.instrument)),
    next: rows.length > limit && last ? `${String(last.createdAt.getTime()).padStart(13, "0")}:${last.id}` : null,
  };
}

// ---------------------------------------------------------------------------
// Payout results (dispatch.ts and payout webhooks)
// ---------------------------------------------------------------------------

/** SUBMITTED -> SETTLED: the hold leaves custody, the fee to PROVIDER_FEES. [L2] [L5] held by the caller. */
export async function settleWithdrawal(tx: MoneyTx, ctx: PaymentsContext, withdrawal: Withdrawal, facts: { providerPayoutId: string | null; txHash?: string; payoutAmount?: string }): Promise<Withdrawal> {
  const p = withdrawal.providerKey!;
  const asset = withdrawal.assetCode;
  await ensureAccounts(tx, [
    { asset, type: "USER_WITHDRAWAL_HOLD", userId: withdrawal.userId },
    { asset, type: "WITHDRAWAL_CLEARING", providerKey: p },
    { asset, type: "PROVIDER_FEES", providerKey: p },
  ]);
  const settleTxId = await execute(tx, planSettleWithdrawal({
    key: ledgerKeys.withdrawalSettle(withdrawal.id), asset, userId: withdrawal.userId, withdrawalId: withdrawal.id, amount: withdrawal.amountMinor,
    providerKey: p, fee: withdrawal.feeMinor, providerReference: facts.providerPayoutId ?? withdrawal.id,
  }));
  const now = ctx.now();
  const updated = await tx.withdrawal.update({
    where: { id: withdrawal.id },
    data: {
      status: "SETTLED", settleTxId, settledAt: now, closedAt: now,
      ...(facts.providerPayoutId && !withdrawal.providerPayoutId ? { providerPayoutId: facts.providerPayoutId.slice(0, 200) } : {}),
      ...(facts.txHash ? { txHash: facts.txHash.slice(0, 200) } : {}),
      ...(facts.payoutAmount ? { payoutAmount: facts.payoutAmount.slice(0, 64) } : {}),
    },
  });
  if (withdrawal.instrumentId) {
    await tx.paymentInstrument.update({ where: { id: withdrawal.instrumentId }, data: { successfulPayouts: { increment: 1 }, lastUsedAt: now } });
  }
  const instrument = withdrawal.instrumentId ? await tx.paymentInstrument.findUnique({ where: { id: withdrawal.instrumentId } }) : null;
  await enqueueEmail(tx, withdrawal.assetCode, {
    userId: withdrawal.userId, template: "withdrawal-paid", dedupeKey: `withdrawal-paid:${withdrawal.id}`,
    payload: {
      amount: money(withdrawal.amountMinor), youReceive: money(withdrawal.amountMinor - withdrawal.feeMinor), asset, withdrawalId: withdrawal.id,
      destination: destinationView(instrument)?.display ?? "", ...(facts.txHash ? { txHash: facts.txHash.slice(0, 100) } : {}),
    },
  });
  return updated;
}

/** SETTLED -> RETURNED: the rail sent the payout back (at most amount - fee) to the available balance. */
export async function returnWithdrawal(tx: MoneyTx, withdrawal: Withdrawal, returnedMinor: bigint): Promise<Withdrawal> {
  const p = withdrawal.providerKey!;
  const cap = withdrawal.amountMinor - withdrawal.feeMinor;
  const amount = returnedMinor > 0n && returnedMinor <= cap ? returnedMinor : cap;
  await ensureAccounts(tx, [
    { asset: withdrawal.assetCode, type: "USER_AVAILABLE", userId: withdrawal.userId },
    { asset: withdrawal.assetCode, type: "WITHDRAWAL_CLEARING", providerKey: p },
  ]);
  const returnTxId = await execute(tx, planReturnWithdrawal({
    key: ledgerKeys.withdrawalReturn(withdrawal.id), asset: withdrawal.assetCode, userId: withdrawal.userId, withdrawalId: withdrawal.id, amount,
    providerKey: p, providerReference: withdrawal.providerPayoutId ?? withdrawal.id,
  }));
  return tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "RETURNED", returnTxId } });
}
