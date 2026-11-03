/**
 * Deposits (docs/money/WALLET.md sections 7.1, 10.1 and 10.3).
 *
 * createDeposit: gate, then transaction A (compliance lock, player gates,
 * idempotency, INSERT CREATED), then the provider session outside any
 * transaction, then transaction B (PENDING with the session, or FAILED).
 *
 * applyProviderPayment: the provider's current state of a payment (always
 * re-read from the provider, never taken from a webhook body) applied to its
 * deposit as a monotonic transition; SUCCEEDED credits exactly once. The
 * credit is bound to the Deposit row (DEPOSIT_CREDIT with key
 * deposit-credit:<id>; the binding trigger refuses a second credit whatever
 * its key). Anything over the player's deposit limit, or the whole amount
 * when the player is self-excluded, restricted or paid with a card type we do
 * not accept, is credited and immediately held for refund to its source.
 */
import { canonicalJson, MONEY_AMOUNT_PATTERN, sha256HexAsync, WALLET_DECIMALS, type DepositStart, type DepositView } from "@poker/shared";
import type { Deposit, PaymentInstrument } from "../generated/prisma/client";
import { logError, logWarn } from "../http/log";
import { formatMinor, parseMinor } from "../money/amounts";
import { ensureAccounts, execute } from "../money/ledger";
import { planCreditDeposit, planHoldWithdrawal, planProviderFee, type AccountSpec } from "../money/flows";
import { ledgerKeys, providerIdempotency } from "../money/keys";
import { moneyTx, type MoneyTx } from "../money/tx";
import { lockCompliance, readCompliance, screeningMatched, type ComplianceRow } from "./compliance";
import type { Caller, CreateDepositInput } from "./contract";
import { usdtAllowedFor } from "./config";
import { configuredKeys, redirectAllowed, type MoneyProvider, type PaymentsContext } from "./context";
import { customerRef, travelRuleParty } from "./customer";
import { ProviderUnavailable, refuse } from "./errors";
import { assetEnabled, DEPOSIT_SWITCH, kycBlocksDeposit, regionAllowed, requireFlowOpen, sourceOfFundsBlocks } from "./gate";
import { upsertCardFromDeposit } from "./instruments";
import { activeDepositLimits, activeSelfExclusion, depositUsage, remainingCapacity } from "./limits";
import { enqueueEmail } from "./notify";
import type { ProviderPayment } from "./providers/types";
import { isUuid, type CallerUser } from "./session";
import { depositNext, depositView, money } from "./views";

export const MAX_OPEN_DEPOSITS = 3;
export const MAX_DEPOSITS_PER_HOUR = 10;
const OPEN = ["CREATED", "PENDING"] as const;

export function parseAmount(value: unknown): bigint {
  if (typeof value !== "string" || !MONEY_AMOUNT_PATTERN.test(value)) refuse("VALIDATION", "Enter an amount like 50 or 50.00.");
  const minor = parseMinor(value, WALLET_DECIMALS);
  if (minor <= 0n) refuse("VALIDATION", "Enter an amount above zero.");
  return minor;
}

function providerFor(ctx: PaymentsContext, method: "CARD" | "CRYPTO"): MoneyProvider {
  const provider = method === "CARD" ? ctx.providers.card : ctx.providers.crypto;
  if (!provider) refuse("METHOD_DISABLED", "This payment method is not available right now.");
  return provider;
}

function returnUrl(ctx: PaymentsContext, depositId: string): string {
  return `${ctx.config.publicSiteOrigin}/wallet?deposit=${depositId}`;
}

// ---------------------------------------------------------------------------
// 10.1 createDeposit
// ---------------------------------------------------------------------------

export async function createDeposit(ctx: PaymentsContext, caller: Caller, user: CallerUser, input: CreateDepositInput): Promise<{ start: DepositStart; replay: boolean }> {
  const { config } = ctx;
  const now = ctx.now();
  const method = input?.method;
  if (method !== "CARD" && method !== "CRYPTO") refuse("VALIDATION", "Choose card or crypto.");
  if (!isUuid(input.clientRequestId)) refuse("IDEMPOTENCY_KEY_REQUIRED", "This request needs an Idempotency-Key.");
  const amountMinor = parseAmount(input.amount);
  const provider = providerFor(ctx, method);
  await requireFlowOpen(ctx, DEPOSIT_SWITCH[method], method);
  if (!regionAllowed(config, caller.ipCountry)) refuse("REGION_BLOCKED", "Real-money play is not available in your region.");
  if (amountMinor < config.limits.depositMinMinor) refuse("AMOUNT_BELOW_MIN", `The minimum deposit is ${money(config.limits.depositMinMinor)}.`, { details: { min: money(config.limits.depositMinMinor) } });
  if (amountMinor > config.limits.depositMaxMinor) refuse("AMOUNT_ABOVE_MAX", `The maximum deposit is ${money(config.limits.depositMaxMinor)}.`, { details: { max: money(config.limits.depositMaxMinor) } });
  const payAsset = method === "CRYPTO" ? String((input as { payAsset?: unknown }).payAsset ?? "") : null;
  const instrumentId = method === "CARD" ? (input as { instrumentId?: string }).instrumentId ?? null : null;
  const saveCard = method === "CARD" ? (input as { saveCard?: boolean }).saveCard !== false : false;
  if (instrumentId !== null && !isUuid(instrumentId)) refuse("VALIDATION", "Unknown card.");
  let payNetwork: string | null = null;
  if (payAsset !== null) {
    const asset = await ctx.db.asset.findUnique({ where: { code: payAsset }, select: { kind: true, network: true } });
    if (!config.cryptoPayAssets.includes(payAsset) || !asset || asset.kind !== "CRYPTO") refuse("ASSET_UNSUPPORTED", "Deposits in this currency are not available.");
    payNetwork = asset.network;
  }
  const requestHash = await sha256HexAsync(canonicalJson({ method, amountMinor: amountMinor.toString(), payAsset, instrumentId, saveCard }));

  const created = await moneyTx(ctx.db, async (tx) => {
    const compliance = await lockCompliance(tx, user.id);
    const existing = await tx.deposit.findUnique({ where: { userId_clientRequestId: { userId: user.id, clientRequestId: input.clientRequestId } } });
    if (existing) {
      if (existing.requestHash !== requestHash) refuse("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different deposit.");
      return { deposit: existing, compliance, token: null as string | null, replay: true };
    }
    // A screening match holds every withdrawal until a person decides: no new money goes in meanwhile.
    if (compliance.restriction === "DEPOSITS_BLOCKED" || compliance.restriction === "FROZEN" || screeningMatched(compliance)) {
      refuse("ACCOUNT_RESTRICTED", "Deposits are not available on your account. Contact support.");
    }
    const exclusion = await activeSelfExclusion(tx, user.id, now);
    if (exclusion) refuse("SELF_EXCLUDED", "You are self-excluded. Deposits stay closed until your exclusion has ended and you have asked to come back.", { details: exclusion.endsAt ? { endsAt: exclusion.endsAt.toISOString() } : {} });
    if (kycBlocksDeposit(config, compliance, amountMinor)) {
      if (compliance.kycStatus === "PENDING") refuse("KYC_PENDING", "Your identity check is still in progress.");
      refuse("KYC_REQUIRED", "Verify your identity before your first deposit.");
    }
    if (compliance.residenceCountry !== null && !regionAllowed(config, compliance.residenceCountry)) refuse("REGION_BLOCKED", "Real-money play is not available in your country of residence.");
    if (payAsset !== null && !usdtAllowedFor(config, payAsset, compliance.residenceCountry ?? caller.ipCountry)) refuse("ASSET_UNSUPPORTED", "This currency is not available in your country.");
    if (sourceOfFundsBlocks(config, compliance, amountMinor)) refuse("SOURCE_OF_FUNDS_REQUIRED", "We need to confirm the source of your funds before more deposits.");
    if (compliance.rgLimitsPromptedAt === null) refuse("LIMITS_SETUP_REQUIRED", "Set your deposit limits (or choose no limit) before your first deposit.");
    const open = await tx.deposit.count({ where: { userId: user.id, status: { in: [...OPEN] }, expiresAt: { gt: now } } });
    const lastHour = await tx.deposit.count({ where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
    if (open >= MAX_OPEN_DEPOSITS || lastHour >= MAX_DEPOSITS_PER_HOUR) refuse("TOO_MANY_PENDING", "Finish or cancel your open deposits first.");
    const remaining = remainingCapacity(await activeDepositLimits(tx, user.id, now), await depositUsage(tx, user.id, config.settlementAsset, now));
    if (remaining !== null && remaining < amountMinor) {
      refuse("DEPOSIT_LIMIT_EXCEEDED", `This is over your deposit limit. You can deposit up to ${money(remaining)} now.`, { details: { remaining: money(remaining) } });
    }
    let token: string | null = null;
    if (instrumentId !== null) {
      const card = await tx.paymentInstrument.findFirst({
        where: { id: instrumentId, userId: user.id, kind: "CARD_TOKEN", providerKey: provider.key, status: "ACTIVE", depositEnabled: true },
      });
      if (!card) refuse("DESTINATION_UNAVAILABLE", "This card cannot be used. Pay with a new card instead.");
      token = card.cardToken;
    }
    const deposit = await tx.deposit.create({
      data: {
        userId: user.id, clientRequestId: input.clientRequestId, requestHash, method, providerKey: provider.key, assetCode: config.settlementAsset,
        requestedMinor: amountMinor, payAssetCode: payAsset, payNetwork, expiresAt: new Date(now.getTime() + config.depositSessionTtlMs),
        ip: caller.ip?.slice(0, 64) ?? null, ipCountry: caller.ipCountry && /^[A-Z0-9]{2}$/.test(caller.ipCountry) ? caller.ipCountry : null,
        ...(instrumentId !== null ? { instrumentId } : {}),
      },
    });
    return { deposit, compliance, token, replay: false };
  }, { label: "deposit.create" });

  let deposit = created.deposit;
  if (deposit.status === "CREATED" && !deposit.hostedUrl && !deposit.payAddress && deposit.expiresAt.getTime() > now.getTime()) {
    deposit = await openSession(ctx, caller, user, deposit, provider, created.compliance, created.token, saveCard);
  }
  return { start: { deposit: depositView(deposit), next: depositNext(deposit, ctx.now()) }, replay: created.replay };
}

/** Steps 3 and 4: the provider session (outside any transaction), then transaction B. */
async function openSession(
  ctx: PaymentsContext, caller: Caller, user: CallerUser, deposit: Deposit, provider: MoneyProvider, compliance: ComplianceRow, token: string | null, saveCard: boolean,
): Promise<Deposit> {
  const customer = customerRef({ userId: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null, ip: caller.ip, country: caller.ipCountry, compliance });
  const common = { depositId: deposit.id, idempotencyKey: providerIdempotency.depositSession(deposit.id), amountMinor: deposit.requestedMinor, customer, expiresAt: deposit.expiresAt };
  let session: Awaited<ReturnType<MoneyProvider["createDepositSession"]>>;
  if (provider.method === "CARD") {
    session = await provider.createDepositSession({
      ...common, saveCard, returnUrl: returnUrl(ctx, deposit.id),
      notificationUrl: `${ctx.config.paymentsPublicOrigin ?? ctx.config.publicSiteOrigin}/webhooks/${provider.key}`,
      ...(token ? { instrumentToken: token } : {}),
    });
  } else {
    const originator = travelRuleParty(compliance, "ORIGINATOR");
    if (!originator) refuse("KYC_REQUIRED", "Verify your identity before a crypto deposit.");
    session = await provider.createDepositSession({ ...common, payAsset: deposit.payAssetCode!, originator });
  }
  if (session.kind === "uncertain" || (session.kind === "rejected" && !session.final)) {
    throw new ProviderUnavailable(provider.key, session.kind === "uncertain" ? session.reason : "retry_later");
  }
  // What the browser is sent to is checked here, whatever the adapter or the provider's answer said.
  if (session.kind === "ok") {
    const url = session.value.type === "REDIRECT" ? session.value.url : session.value.hostedUrl;
    if (url && !redirectAllowed(provider, url)) {
      logError({ alert: "PROVIDER_URL_REFUSED", provider: provider.key, depositId: deposit.id }, "provider session names a host outside its allow-list");
      if (session.value.type === "REDIRECT") throw new ProviderUnavailable(provider.key, "redirect_host");
      session = { kind: "ok", value: { ...session.value, hostedUrl: null } };
    }
  }
  return moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, deposit.userId);
    await tx.$queryRaw`SELECT "id" FROM public."Deposit" WHERE "id" = ${deposit.id}::uuid FOR UPDATE`;
    const current = await tx.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    // The webhook won the race (already PENDING, CONFIRMED or CREDITED): keep what it did.
    if (current.status !== "CREATED") return current;
    if (session.kind === "rejected") {
      return tx.deposit.update({ where: { id: deposit.id }, data: { status: "FAILED", statusReason: `PROVIDER_${session.code}`.slice(0, 100), closedAt: ctx.now() } });
    }
    const value = session.value;
    if (value.type === "REDIRECT") {
      return tx.deposit.update({
        where: { id: deposit.id },
        data: { status: "PENDING", hostedUrl: value.url.slice(0, 2048), ...(value.providerPaymentId && !current.providerPaymentId ? { providerPaymentId: value.providerPaymentId } : {}) },
      });
    }
    return tx.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "PENDING", payAddress: value.address.slice(0, 256), payMemo: value.memo, payNetwork: value.network || current.payNetwork,
        payAmount: value.payAmount, hostedUrl: value.hostedUrl?.slice(0, 2048) ?? null,
        // A per-user channel address is reused by later deposits: the payment id arrives with the payment.
        ...(!value.reusableAddress && !current.providerPaymentId ? { providerPaymentId: value.providerPaymentId } : {}),
      },
    });
  }, { label: "deposit.session" });
}

export async function getDeposit(ctx: PaymentsContext, userId: string, depositId: string): Promise<DepositView> {
  if (!isUuid(depositId)) refuse("NOT_FOUND", "That deposit does not exist.");
  const row = await ctx.db.deposit.findFirst({ where: { id: depositId, userId } });
  if (!row) refuse("NOT_FOUND", "That deposit does not exist.");
  return depositView(row);
}

export async function cancelDeposit(ctx: PaymentsContext, userId: string, depositId: string): Promise<DepositView> {
  if (!isUuid(depositId)) refuse("NOT_FOUND", "That deposit does not exist.");
  const row = await moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, userId);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id"::text AS id FROM public."Deposit" WHERE "id" = ${depositId}::uuid AND "userId" = ${userId} FOR UPDATE`;
    if (locked.length === 0) refuse("NOT_FOUND", "That deposit does not exist.");
    const current = await tx.deposit.findUniqueOrThrow({ where: { id: depositId } });
    if (current.status === "CANCELLED") return current;
    if (current.status !== "CREATED" && current.status !== "PENDING") refuse("INVALID_STATE", "This deposit can no longer be cancelled.");
    return tx.deposit.update({ where: { id: depositId }, data: { status: "CANCELLED", statusReason: "PLAYER_CANCELLED", closedAt: ctx.now() } });
  }, { label: "deposit.cancel" });
  return depositView(row);
}

/** Self-exclusion (section 10.11): cancel open deposits; whatever still arrives is credited and refund-held. */
export async function cancelOpenDeposits(ctx: PaymentsContext, userId: string, reason: string): Promise<number> {
  return moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, userId);
    const open = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS id FROM public."Deposit" WHERE "userId" = ${userId} AND "status" IN ('CREATED', 'PENDING') ORDER BY "id" FOR UPDATE`;
    for (const row of open) {
      await tx.deposit.update({ where: { id: row.id }, data: { status: "CANCELLED", statusReason: reason, closedAt: ctx.now() } });
    }
    return open.length;
  }, { label: "deposit.cancel-open" });
}

// ---------------------------------------------------------------------------
// 10.3 applyProviderPayment
// ---------------------------------------------------------------------------

export type EventOutcome = "APPLIED" | "DUPLICATE" | "STALE" | "UNKNOWN_OBJECT" | "NEEDS_REVIEW";

const CREDITED = new Set(["CREDITED", "PARTIALLY_REVERSED", "REVERSED"]);
const CLOSED = new Set(["FAILED", "EXPIRED", "CANCELLED"]);

/** Finds the deposit a payment belongs to: our id (merchantRef), the provider's id, or an open deposit to the same crypto address. */
async function findDeposit(tx: MoneyTx, providerKey: string, payment: ProviderPayment): Promise<Deposit | null> {
  if (payment.merchantRef && isUuid(payment.merchantRef)) {
    const byRef = await tx.deposit.findFirst({ where: { id: payment.merchantRef, providerKey } });
    if (byRef) return byRef;
  }
  const byPayment = await tx.deposit.findUnique({ where: { providerKey_providerPaymentId: { providerKey, providerPaymentId: payment.providerPaymentId } } });
  if (byPayment) return byPayment;
  if (payment.crypto?.address) {
    return tx.deposit.findFirst({
      where: { providerKey, payAddress: payment.crypto.address, status: { in: ["CREATED", "PENDING"] }, providerPaymentId: null },
      orderBy: { createdAt: "asc" },
    });
  }
  return null;
}

/**
 * A payment for no deposit we know (a top-up to a reused channel address, or
 * an unknown reference): a success is recorded as NEEDS_REVIEW for the user
 * the address belongs to; anything else, or an unknown address, is UNKNOWN_OBJECT.
 */
async function adoptUnknownPayment(tx: MoneyTx, ctx: PaymentsContext, provider: MoneyProvider, payment: ProviderPayment): Promise<EventOutcome> {
  if ((payment.state !== "SUCCEEDED" && payment.state !== "NEEDS_REVIEW") || !payment.crypto?.address || payment.creditMinor === null || payment.creditMinor <= 0n) {
    logWarn({ alert: "PAYMENT_UNKNOWN_OBJECT", provider: provider.key, state: payment.state }, "provider payment matches no deposit");
    return "UNKNOWN_OBJECT";
  }
  const owner = await tx.deposit.findFirst({ where: { providerKey: provider.key, payAddress: payment.crypto.address }, orderBy: { createdAt: "desc" }, select: { userId: true } });
  if (!owner) {
    logWarn({ alert: "PAYMENT_UNKNOWN_OBJECT", provider: provider.key, state: payment.state }, "crypto payment to an address no user owns");
    return "UNKNOWN_OBJECT";
  }
  await lockCompliance(tx, owner.userId);
  await tx.deposit.create({
    data: {
      userId: owner.userId, method: provider.method, providerKey: provider.key, assetCode: provider.settlementAsset, status: "NEEDS_REVIEW",
      requestedMinor: payment.creditMinor, reportedMinor: payment.creditMinor, payAssetCode: payment.crypto.asset, payNetwork: payment.crypto.network, payAmount: payment.crypto.amount,
      payAddress: payment.crypto.address, txHash: payment.crypto.txHash, confirmations: payment.crypto.confirmations, providerPaymentId: payment.providerPaymentId,
      providerStatus: payment.rawState.slice(0, 64), statusReason: payment.reviewReason ?? "UNKNOWN_REFERENCE", expiresAt: ctx.now(),
    },
  });
  return "NEEDS_REVIEW";
}

/**
 * Applies the provider's current view of one payment. Runs inside the
 * caller's moneyTx (the event row, if any, is already locked [L1]); takes
 * [L2] compliance and [L3] the deposit.
 */
export async function applyProviderPayment(tx: MoneyTx, ctx: PaymentsContext, provider: MoneyProvider, payment: ProviderPayment): Promise<EventOutcome> {
  const found = await findDeposit(tx, provider.key, payment);
  if (!found) return adoptUnknownPayment(tx, ctx, provider, payment);
  await lockCompliance(tx, found.userId);
  await tx.$queryRaw`SELECT "id" FROM public."Deposit" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
  const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: found.id } });
  if (deposit.method !== provider.method || deposit.assetCode !== provider.settlementAsset) {
    logError({ alert: "PAYMENT_MISMATCH", depositId: deposit.id, provider: provider.key }, "provider payment does not match its deposit's method or asset");
    return "NEEDS_REVIEW";
  }
  const now = ctx.now();
  const status = deposit.status;
  // Written once, with the move to review: the ceiling of what a person may credit.
  const reported = payment.creditMinor !== null && payment.creditMinor > 0n ? { reportedMinor: payment.creditMinor } : {};
  // The card that paid, also for a deposit going to review: a person may credit it later.
  // The saveCard choice went to the provider's page; the card is kept as the payout and refund
  // destination either way (return to source), and the player can remove it.
  const paidWith = async (): Promise<{ instrumentId?: string }> => {
    if (deposit.instrumentId !== null || !payment.card) return {};
    const card = await upsertCardFromDeposit(tx, ctx, {
      userId: deposit.userId, providerKey: deposit.providerKey, assetCode: deposit.assetCode, card: payment.card, saveCard: true, depositId: deposit.id,
    });
    return { instrumentId: card.id };
  };
  const details = {
    providerStatus: payment.rawState.slice(0, 64),
    ...(payment.crypto ? { txHash: payment.crypto.txHash, confirmations: payment.crypto.confirmations, payAmount: payment.crypto.amount } : {}),
    ...(deposit.providerPaymentId === null ? { providerPaymentId: payment.providerPaymentId } : {}),
  };
  if (CREDITED.has(status)) return payment.state === "SUCCEEDED" ? "DUPLICATE" : "STALE";
  if (status === "CONFIRMED") {
    // A credit that waited for an infrastructure reason (asset paused): retry it.
    if (payment.state !== "SUCCEEDED") return "STALE";
    return creditConfirmed(tx, ctx, deposit.id);
  }
  if (status === "NEEDS_REVIEW") return "STALE";
  // A deposit that named a saved card must have been paid with that card: the
  // deposit stays linked to it (write-once), so another card's money would
  // become this card's payout room. Same token, or the same fingerprint when
  // both are known; anything else goes to a person and is never credited here.
  if ((payment.state === "SUCCEEDED" || payment.state === "NEEDS_REVIEW") && deposit.instrumentId !== null && payment.card) {
    const named = await tx.paymentInstrument.findUnique({ where: { id: deposit.instrumentId }, select: { cardToken: true, cardFingerprint: true } });
    const sameCard = named !== null && (named.cardToken === payment.card.token
      || (named.cardFingerprint !== null && payment.card.fingerprint !== null && named.cardFingerprint === payment.card.fingerprint));
    if (!sameCard) {
      logError({ alert: "PAYMENT_CARD_MISMATCH", depositId: deposit.id, provider: provider.key }, "a deposit that named a saved card was paid with another card");
      await tx.deposit.update({ where: { id: deposit.id }, data: { ...details, ...reported, status: "NEEDS_REVIEW", statusReason: "CARD_MISMATCH" } });
      return "NEEDS_REVIEW";
    }
  }
  switch (payment.state) {
    case "PENDING":
    case "PROCESSING":
      if (CLOSED.has(status)) return "STALE";
      await tx.deposit.update({ where: { id: deposit.id }, data: { ...details, status: "PENDING" } });
      return "APPLIED";
    case "FAILED":
    case "EXPIRED":
    case "CANCELLED":
      if (CLOSED.has(status)) return "STALE";
      await tx.deposit.update({ where: { id: deposit.id }, data: { ...details, status: payment.state, closedAt: now, statusReason: `PROVIDER_${payment.state}` } });
      return "APPLIED";
    case "NEEDS_REVIEW":
      await tx.deposit.update({ where: { id: deposit.id }, data: { ...details, ...reported, ...(await paidWith()), status: "NEEDS_REVIEW", statusReason: payment.reviewReason ?? "PROVIDER_REVIEW" } });
      return "NEEDS_REVIEW";
    case "SUCCEEDED": {
      const credit = payment.creditMinor;
      if (credit === null || credit <= 0n) {
        await tx.deposit.update({ where: { id: deposit.id }, data: { ...details, ...(await paidWith()), status: "NEEDS_REVIEW", statusReason: "AMOUNT_MISSING" } });
        return "NEEDS_REVIEW";
      }
      // A card is charged exactly what was asked; a different amount is a red flag for a person to look at.
      if (deposit.method === "CARD" && credit !== deposit.requestedMinor) {
        await tx.deposit.update({ where: { id: deposit.id }, data: { ...details, ...reported, ...(await paidWith()), status: "NEEDS_REVIEW", statusReason: "AMOUNT_MISMATCH" } });
        return "NEEDS_REVIEW";
      }
      const card = await paidWith();
      // A card deposit is never credited without its card: the refund and closed-loop rules hang on it.
      if (deposit.method === "CARD" && deposit.instrumentId === null && !card.instrumentId) {
        logError({ alert: "PAYMENT_CARD_MISSING", depositId: deposit.id, provider: provider.key }, "a card payment succeeded but the provider named no card");
        await tx.deposit.update({ where: { id: deposit.id }, data: { ...details, ...reported, status: "NEEDS_REVIEW", statusReason: "CARD_UNKNOWN" } });
        return "NEEDS_REVIEW";
      }
      await tx.deposit.update({
        where: { id: deposit.id },
        data: { ...details, ...card, status: "CONFIRMED", creditedMinor: credit, confirmedAt: now, feeMinor: payment.feeMinor ?? null, lateSuccess: CLOSED.has(status) },
      });
      return creditConfirmed(tx, ctx, deposit.id);
    }
  }
}

/**
 * Posts the credit of a CONFIRMED deposit (same transaction). Leaves it
 * CONFIRMED when the asset is paused (the emergency stop); the sweeper
 * retries. Everything here is in the transaction that holds [L2] and [L3].
 */
export async function creditConfirmed(tx: MoneyTx, ctx: PaymentsContext, depositId: string): Promise<EventOutcome> {
  const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: depositId } });
  if (deposit.status !== "CONFIRMED" || deposit.creditedMinor === null) return "STALE";
  if (!await assetEnabled(tx, deposit.assetCode)) {
    logWarn({ alert: "CREDIT_PAUSED", depositId, asset: deposit.assetCode }, "deposit confirmed but its asset is paused; credit waits");
    return "APPLIED";
  }
  const now = ctx.now();
  const credit = deposit.creditedMinor;
  const compliance = await readCompliance(tx, deposit.userId);
  const instrument = deposit.instrumentId ? await tx.paymentInstrument.findUnique({ where: { id: deposit.instrumentId } }) : null;
  const exclusion = await activeSelfExclusion(tx, deposit.userId, now);
  const restricted = compliance.restriction === "DEPOSITS_BLOCKED" || compliance.restriction === "FROZEN";
  const fundingRefused = deposit.method === "CARD" && instrument !== null
    && !(ctx.config.cardFundingAllowed as readonly string[]).includes(instrument.cardFunding ?? "unknown");
  let excess = 0n;
  let reason = "";
  if (exclusion || restricted || fundingRefused) {
    excess = credit;
    reason = exclusion ? "SELF_EXCLUDED" : restricted ? "ACCOUNT_RESTRICTED" : "CARD_TYPE_NOT_ACCEPTED";
  } else {
    const remaining = remainingCapacity(
      await activeDepositLimits(tx, deposit.userId, now),
      await depositUsage(tx, deposit.userId, deposit.assetCode, now, deposit.id),
    );
    if (remaining !== null && credit > remaining) {
      excess = credit - remaining;
      reason = "DEPOSIT_LIMIT";
    }
  }
  const fee = deposit.feeMinor ?? 0n;
  const asset = deposit.assetCode;
  const p = deposit.providerKey;
  const accounts: AccountSpec[] = [
    { asset, type: "USER_AVAILABLE", userId: deposit.userId },
    { asset, type: "DEPOSIT_CLEARING", providerKey: p },
    ...(excess > 0n ? [{ asset, type: "USER_WITHDRAWAL_HOLD" as const, userId: deposit.userId }] : []),
    ...(fee > 0n ? [{ asset, type: "ADJUSTMENTS" as const }, { asset, type: "PROVIDER_FEES" as const, providerKey: p }] : []),
  ];
  await ensureAccounts(tx, accounts);
  const txId = await execute(tx, planCreditDeposit({
    key: ledgerKeys.depositCredit(deposit.id), asset, userId: deposit.userId, providerKey: p, amount: credit,
    providerReference: deposit.providerPaymentId ?? deposit.id, depositId: deposit.id,
  }));
  await tx.deposit.update({ where: { id: deposit.id }, data: { status: "CREDITED", ledgerCreditTxId: txId, creditedAt: now, excessMinor: excess } });
  if (excess > 0n) await holdRefund(tx, ctx, deposit, instrument, excess, reason);
  if (fee > 0n) {
    await execute(tx, planProviderFee({ key: ledgerKeys.depositFee(deposit.id), asset, providerKey: p, amount: fee, providerReference: deposit.providerPaymentId ?? deposit.id }));
  }
  await tx.playerCompliance.update({
    where: { userId: deposit.userId },
    data: { lifetimeDepositedMinor: { increment: credit }, ...(compliance.firstDepositAt === null ? { firstDepositAt: now } : {}) },
  });
  await enqueueEmail(tx, asset, {
    userId: deposit.userId, template: "deposit-credited", dedupeKey: `deposit-credited:${deposit.id}`,
    payload: { amount: money(credit), asset, depositId: deposit.id, refundHeld: money(excess) },
  });
  return "APPLIED";
}

/**
 * The part of a credit that cannot stay (section 10.3): a REFUND withdrawal
 * held at once. A card deposit's refund is bound here to that deposit's card
 * and provider, and goes back automatically (a SYSTEM approval and a REFUND
 * dispatch) unless the card was revoked, when a person approves it. A crypto
 * deposit's source address is not known and is never guessed: it waits for
 * review (REFUND_TO_SOURCE) until an administrator names a payout address of
 * the player's (admin.ts refundTarget).
 */
async function holdRefund(tx: MoneyTx, ctx: PaymentsContext, deposit: Deposit, card: PaymentInstrument | null, amount: bigint, reason: string): Promise<void> {
  const source = deposit.method === "CARD" && card !== null && card.userId === deposit.userId ? card : null;
  const toCard = source !== null && source.status !== "REVOKED";
  const withdrawal = await tx.withdrawal.create({
    data: {
      userId: deposit.userId, kind: "REFUND", sourceDepositId: deposit.id, assetCode: deposit.assetCode, amountMinor: amount, feeMinor: 0n,
      ...(source ? { instrumentId: source.id, providerKey: deposit.providerKey } : {}),
      failureReason: null,
    },
  });
  const holdTxId = await execute(tx, planHoldWithdrawal({ key: ledgerKeys.withdrawalHold(withdrawal.id), asset: deposit.assetCode, userId: deposit.userId, withdrawalId: withdrawal.id, amount }));
  const now = ctx.now();
  await tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "HELD", holdTxId, heldAt: now } });
  if (toCard) {
    await tx.paymentReviewAction.create({
      data: { subjectType: "WITHDRAWAL", subjectId: withdrawal.id, subjectUserId: deposit.userId, actorKind: "SYSTEM", verb: "APPROVE", reasonCode: `REFUND_${reason}`.slice(0, 64) },
    });
    await tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "APPROVED", decidedAt: now, rulesVersion: "refund-to-source" } });
    await tx.payoutDispatch.create({
      data: {
        withdrawalId: withdrawal.id, userId: deposit.userId, providerKey: deposit.providerKey, operation: "REFUND",
        providerIdempotencyKey: providerIdempotency.refund(withdrawal.id),
      },
    });
    ctx.defer(ctx.kick());
  } else {
    await tx.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: "UNDER_REVIEW", reviewReasons: ["REFUND_TO_SOURCE"], approvalsRequired: ctx.config.mode === "live" ? 2 : 1, rulesVersion: "refund-to-source" },
    });
  }
  await enqueueEmail(tx, deposit.assetCode, {
    userId: deposit.userId, template: "refund-held", dedupeKey: `refund-held:${withdrawal.id}`,
    payload: { amount: formatMinor(amount, WALLET_DECIMALS), asset: deposit.assetCode, depositId: deposit.id, reason, ...(deposit.method === "CRYPTO" ? { needsAddress: "true" } : {}) },
  });
}

/**
 * The most a person may credit on a deposit under review: what the provider
 * reported settling, and for a card no more than was asked (the database's
 * deposit guard holds the same line).
 */
export function reviewCreditCap(deposit: Pick<Deposit, "method" | "requestedMinor" | "reportedMinor">): bigint {
  const reported = deposit.reportedMinor ?? deposit.requestedMinor;
  return deposit.method === "CARD" && reported > deposit.requestedMinor ? deposit.requestedMinor : reported;
}

/** Admin resolution of a NEEDS_REVIEW deposit (section 11.2): CREDIT a set amount, or FAIL it. */
export async function resolveReviewedDeposit(tx: MoneyTx, ctx: PaymentsContext, depositId: string, action: "CREDIT" | "FAIL", creditMinor: bigint | null): Promise<Deposit> {
  const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: depositId } });
  if (deposit.status !== "NEEDS_REVIEW") refuse("INVALID_STATE", "Only a deposit under review can be resolved.");
  const now = ctx.now();
  if (action === "FAIL") {
    return tx.deposit.update({ where: { id: depositId }, data: { status: "FAILED", statusReason: "ADMIN_FAILED", closedAt: now } });
  }
  if (creditMinor === null || creditMinor <= 0n) refuse("VALIDATION", "Enter the amount to credit.");
  await tx.deposit.update({ where: { id: depositId }, data: { status: "CONFIRMED", creditedMinor: creditMinor, confirmedAt: now } });
  await creditConfirmed(tx, ctx, depositId);
  return tx.deposit.findUniqueOrThrow({ where: { id: depositId } });
}

// ---------------------------------------------------------------------------
// Sweeps (section 10.10)
// ---------------------------------------------------------------------------

/**
 * Deposits nobody heard about: CREATED older than 15 minutes, PENDING past
 * expiresAt + 60 minutes with no transaction seen. The provider is asked
 * (outside any transaction); its state is adopted, or the deposit expires
 * when the provider has no such payment. Uncertain answers wait.
 */
export async function expireStaleDeposits(ctx: PaymentsContext, limit = 3): Promise<number> {
  const now = ctx.now();
  const created = new Date(now.getTime() - 15 * 60_000);
  const pending = new Date(now.getTime() - 60 * 60_000);
  const keys = configuredKeys(ctx.providers, ["card", "crypto"]);
  if (keys.length === 0) return 0;
  const stale = await ctx.db.deposit.findMany({
    where: {
      providerKey: { in: keys },
      OR: [
        { status: "CREATED", createdAt: { lt: created } },
        { status: "PENDING", expiresAt: { lt: pending }, txHash: null },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let handled = 0;
  for (const deposit of stale) {
    const provider = deposit.providerKey === ctx.providers.card?.key ? ctx.providers.card : deposit.providerKey === ctx.providers.crypto?.key ? ctx.providers.crypto : null;
    if (!provider) continue;
    const result = await provider.getPayment({ merchantRef: deposit.id, ...(deposit.providerPaymentId ? { providerPaymentId: deposit.providerPaymentId } : {}) });
    if (result.kind !== "ok") continue;
    await moneyTx(ctx.db, async (tx) => {
      if (result.value) {
        await applyProviderPayment(tx, ctx, provider, result.value);
        return;
      }
      await lockCompliance(tx, deposit.userId);
      await tx.$queryRaw`SELECT "id" FROM public."Deposit" WHERE "id" = ${deposit.id}::uuid FOR UPDATE`;
      const current = await tx.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
      if (current.status === "CREATED" || current.status === "PENDING") {
        await tx.deposit.update({ where: { id: deposit.id }, data: { status: "EXPIRED", statusReason: "NOT_PAID", closedAt: now } });
      }
    }, { label: "deposit.expire" });
    handled += 1;
  }
  return handled;
}

/** CONFIRMED deposits older than a minute (credit refused earlier, e.g. asset paused): retry the credit. */
export async function retryConfirmedCredits(ctx: PaymentsContext, limit = 3): Promise<number> {
  const keys = configuredKeys(ctx.providers, ["card", "crypto"]);
  if (keys.length === 0) return 0;
  if (!await assetEnabled(ctx.db, ctx.config.settlementAsset)) return 0;
  const before = new Date(ctx.now().getTime() - 60_000).toISOString();
  // Random order: a row that always fails cannot keep a place at the head of the queue.
  const rows = await ctx.db.$queryRaw<{ id: string; userId: string }[]>`
    SELECT "id"::text AS id, "userId" FROM public."Deposit"
     WHERE "status" = 'CONFIRMED' AND "providerKey" = ANY (string_to_array(${keys.join(",")}, ',')) AND "confirmedAt" < ${before}::timestamp
     ORDER BY random() LIMIT ${limit}`;
  let credited = 0;
  for (const row of rows) {
    try {
      const outcome = await moneyTx(ctx.db, async (tx) => {
        await lockCompliance(tx, row.userId);
        await tx.$queryRaw`SELECT "id" FROM public."Deposit" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
        return creditConfirmed(tx, ctx, row.id);
      }, { label: "deposit.retry-credit" });
      if (outcome === "APPLIED") credited += 1;
    } catch (error) {
      // It stays CONFIRMED and is tried again; one deposit must not hold up the others.
      logError({ alert: "CREDIT_RETRY_FAILED", depositId: row.id, errName: error instanceof Error ? error.name : "Unknown" }, "a confirmed deposit could not be credited");
    }
  }
  return credited;
}
