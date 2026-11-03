/**
 * Payment instruments (docs/money/WALLET.md sections 7.4 and 10.5): cards
 * come only from a provider-confirmed deposit; crypto payout addresses are
 * added by the player with a payout_destination step-up. Either way a new
 * payout destination cools off for at least 24 hours (the database floors it)
 * and announces itself by email with a "This wasn't me" link, so a small
 * deposit with someone else's card is no shortcut past the address rules.
 *
 * A revoked instrument stays revoked. A fresh deposit with that card proves
 * possession again and adds a new row, which cools off and announces itself
 * like any new destination; an administrator pair can do the same for one named
 * card (restoreCard). The closed loop counts all of a card's rows as one card.
 */
import { payoutDestinationAction, type InstrumentView, type PrepareCryptoDestinationResponse } from "@poker/shared";
import type { PaymentInstrument } from "../generated/prisma/client";
import { logWarn } from "../http/log";
import { moneyTx, type MoneyTx } from "../money/tx";
import type { AddCryptoDestinationInput, Caller } from "./contract";
import { lockCompliance } from "./compliance";
import { usdtAllowedFor } from "./config";
import type { PaymentsContext } from "./context";
import { normalizeCryptoAddress } from "./crypto-address";
import { NOT_ME_TTL_MS, signNotMe } from "./emails";
import { refuse } from "./errors";
import { readSwitches } from "./gate";
import { enqueueEmail } from "./notify";
import type { CardFacts } from "./providers/types";
import { securityHeld, type CallerUser } from "./session";
import { consumeGrant, requirementFor } from "./stepup";
import { instrumentView, iso } from "./views";

export const MAX_ACTIVE_INSTRUMENTS = 10;
export const MAX_ADDITIONS_PER_DAY = 3;
const LABEL = /^[\p{L}\p{N} ._'-]{1,40}$/u;

interface PreparedAddress {
  asset: string;
  network: string;
  normalized: string;
  display: string;
}

async function prepareAddress(ctx: PaymentsContext, user: CallerUser, residence: string | null, input: { asset: string; address: string; memo?: string | null }): Promise<PreparedAddress> {
  const asset = typeof input.asset === "string" ? input.asset.trim() : "";
  if (!ctx.config.cryptoPayAssets.includes(asset) || !usdtAllowedFor(ctx.config, asset, residence)) {
    refuse("ASSET_UNSUPPORTED", "Payouts in this currency are not available.");
  }
  const row = await ctx.db.asset.findUnique({ where: { code: asset }, select: { kind: true, network: true } });
  if (!row || row.kind !== "CRYPTO" || !row.network) refuse("ASSET_UNSUPPORTED", "Payouts in this currency are not available.");
  const checked = normalizeCryptoAddress(row.network, input.address, input.memo ?? null);
  if (!checked.ok) refuse(checked.code, checked.message);
  void user;
  return { asset, network: row.network, normalized: checked.normalized, display: checked.display };
}

/** The message a self-hosted wallet signs to prove control (Regulation (EU) 2023/1113 above €1,000). */
export function ownershipChallenge(userId: string, asset: string, normalized: string): string {
  return `Hold'em Live payout address ownership\nuser: ${userId}\nasset: ${asset}\naddress: ${normalized}`;
}

export async function prepareCryptoDestination(ctx: PaymentsContext, user: CallerUser, residence: string | null, input: { asset: string; address: string; memo?: string | null }): Promise<PrepareCryptoDestinationResponse> {
  const prepared = await prepareAddress(ctx, user, residence, input);
  const requirement = await requirementFor(payoutDestinationAction({ userId: user.id, asset: prepared.asset, addressNormalized: prepared.normalized, memo: null }));
  return { normalized: prepared.display, bind: requirement.bind, ownershipChallenge: ownershipChallenge(user.id, prepared.asset, prepared.normalized) };
}

/** The destination-added email, in the transaction that created the destination. */
async function announceDestination(tx: MoneyTx, ctx: PaymentsContext, instrument: PaymentInstrument, what: { asset: string; address: string; card?: boolean; restored?: boolean }): Promise<void> {
  const secret = ctx.config.notifyLinkSecret;
  const notMe = secret ? await signNotMe(secret, { u: instrument.userId, k: "destination-added", s: instrument.id, e: ctx.now().getTime() + NOT_ME_TTL_MS }) : null;
  await enqueueEmail(tx, ctx.config.settlementAsset, {
    userId: instrument.userId,
    template: "destination-added",
    dedupeKey: `destination-added:${instrument.id}`,
    payload: {
      asset: what.asset, address: what.address, usableAfter: iso(instrument.usableAfter) ?? "", sandbox: String(ctx.config.mode === "sandbox"),
      ...(what.card ? { card: "true" } : {}), ...(what.restored ? { restored: "true" } : {}), ...(notMe ? { notMe } : {}),
    },
  });
}

export async function addCryptoDestination(ctx: PaymentsContext, caller: Caller, user: CallerUser, residence: string | null, input: AddCryptoDestinationInput): Promise<{ view: InstrumentView; replay: boolean }> {
  const now = ctx.now();
  if (securityHeld(user, now)) refuse("SECURITY_HOLD", "Payout details cannot change for a while after a security change.");
  const switches = await readSwitches(ctx.db);
  const provider = ctx.providers.crypto;
  if (!switches.NEW_INSTRUMENTS || !provider) refuse("METHOD_DISABLED", "Adding payout addresses is not available right now.");
  const label = input.label === undefined || input.label === null || input.label === "" ? null : String(input.label).trim();
  if (label !== null && !LABEL.test(label)) refuse("VALIDATION", "A label is 1 to 40 letters, digits or spaces.");
  const prepared = await prepareAddress(ctx, user, residence, input);
  const requirement = await requirementFor(payoutDestinationAction({ userId: user.id, asset: prepared.asset, addressNormalized: prepared.normalized, memo: null }));

  // A replay of a request that already succeeded (same single-use grant): answer it again.
  if (typeof input.stepUpGrantId === "string") {
    const existing = await ctx.db.paymentInstrument.findUnique({ where: { stepUpGrantId: input.stepUpGrantId } });
    if (existing && existing.userId === user.id && existing.addressNormalized === prepared.normalized) return { view: instrumentView(existing), replay: true };
  }

  // KYT screening of the address, outside any transaction.
  if (provider.screenAddress) {
    const screened = await provider.screenAddress({ asset: prepared.asset, network: prepared.network, address: prepared.normalized });
    if (screened.kind === "ok" && screened.value.risk === "SEVERE") {
      await moneyTx(ctx.db, async (tx) => {
        await tx.paymentReviewAction.create({
          data: {
            subjectType: "USER", subjectId: user.id, subjectUserId: user.id, actorKind: "SYSTEM", verb: "NOTE", reasonCode: "ADDRESS_BLOCKED",
            metadata: { asset: prepared.asset, network: prepared.network },
          },
        });
      }, { label: "instrument.blocked" });
      refuse("ADDRESS_BLOCKED", "This address cannot be used for payouts.");
    }
  }

  const ownership = input.ownership && input.ownership.method === "MESSAGE_SIGNATURE"
    && typeof input.ownership.message === "string" && typeof input.ownership.signature === "string"
    && input.ownership.message.length <= 1000 && input.ownership.signature.length <= 1000
    ? { method: "MESSAGE_SIGNATURE", message: input.ownership.message, signature: input.ownership.signature }
    : null;

  const row = await moneyTx(ctx.db, async (tx) => {
    const compliance = await lockCompliance(tx, user.id);
    if (compliance.restriction === "FROZEN") refuse("ACCOUNT_RESTRICTED", "Your payments are restricted. Contact support.");
    const since = new Date(now.getTime() - 86_400_000);
    const active = await tx.paymentInstrument.count({ where: { userId: user.id, status: { not: "REVOKED" } } });
    const recent = await tx.paymentInstrument.count({ where: { userId: user.id, origin: "PLAYER", createdAt: { gte: since } } });
    if (active >= MAX_ACTIVE_INSTRUMENTS || recent >= MAX_ADDITIONS_PER_DAY) {
      refuse("DESTINATION_LIMIT", "You cannot add more payout addresses right now.");
    }
    await consumeGrant(tx, { grantId: input.stepUpGrantId, userId: user.id, sessionId: caller.sessionId, requirement });
    const created = await tx.paymentInstrument.create({
      data: {
        userId: user.id, kind: "CRYPTO_ADDRESS", origin: "PLAYER", providerKey: provider.key, assetCode: prepared.asset,
        network: prepared.network, address: prepared.display, addressNormalized: prepared.normalized, memo: null,
        payoutEnabled: true, depositEnabled: false, label, createdBySessionId: caller.sessionId, stepUpGrantId: input.stepUpGrantId,
        ...(ownership ? { ownershipMethod: ownership.method, ownershipProof: ownership } : {}),
        usableAfter: new Date(now.getTime() + ctx.config.newDestinationCooldownMs),
      },
    });
    await announceDestination(tx, ctx, created, { asset: prepared.asset, address: prepared.display });
    return created;
  }, { label: "instrument.add" });
  return { view: instrumentView(row), replay: false };
}

const OPEN_WITHDRAWAL = ["REQUESTED", "HELD", "UNDER_REVIEW", "APPROVED", "SUBMITTED"] as const;

export async function revokeInstrument(ctx: PaymentsContext, user: CallerUser, instrumentId: string): Promise<void> {
  const now = ctx.now();
  await moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, user.id);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS id FROM public."PaymentInstrument" WHERE "id" = ${instrumentId}::uuid AND "userId" = ${user.id} FOR UPDATE`;
    if (rows.length === 0) refuse("NOT_FOUND", "That payout destination does not exist.");
    const instrument = await tx.paymentInstrument.findUniqueOrThrow({ where: { id: instrumentId } });
    if (instrument.status === "REVOKED") return;
    const inUse = await tx.withdrawal.count({ where: { instrumentId, status: { in: [...OPEN_WITHDRAWAL] } } });
    if (inUse > 0) refuse("INSTRUMENT_IN_USE", "A withdrawal to this destination is still open.");
    await tx.paymentInstrument.update({
      where: { id: instrumentId },
      data: { status: "REVOKED", revokedAt: now, revokedReason: "PLAYER", revokedBy: user.id, depositEnabled: false },
    });
    const display = instrument.kind === "CARD_TOKEN" ? `${instrument.cardBrand ?? "Card"} •••• ${instrument.cardLast4 ?? "????"}` : instrument.address ?? "";
    await enqueueEmail(tx, ctx.config.settlementAsset, {
      userId: user.id, template: "destination-removed", dedupeKey: `destination-removed:${instrumentId}`,
      payload: { display, sandbox: String(ctx.config.mode === "sandbox") },
    });
  }, { label: "instrument.revoke" });
}

export async function listInstruments(ctx: PaymentsContext, userId: string): Promise<InstrumentView[]> {
  const rows = await ctx.db.paymentInstrument.findMany({
    where: { userId, status: { not: "REVOKED" } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(instrumentView);
}

/**
 * The card of a deposit the provider confirmed (section 10.3): this user's
 * live row for the same provider token, or a new row. A revoked row is left
 * revoked: paying with the card again proves possession, and the new row cools
 * off and announces itself like any new card. A token another user holds is
 * recorded (CARD_SHARED note) on a row of this user that can neither deposit
 * nor receive a payout, so the deposit still names its card (a refund can go
 * back to it and the closed loop counts it). A new card that can take payouts
 * is a new payout destination: it cools off like an address and the owner is told.
 */
export async function upsertCardFromDeposit(tx: MoneyTx, ctx: PaymentsContext, input: {
  userId: string; providerKey: string; assetCode: string; card: CardFacts; saveCard: boolean; depositId: string;
}): Promise<PaymentInstrument> {
  const { card } = input;
  const token = card.token.slice(0, 256);
  const mine = await tx.paymentInstrument.findFirst({ where: { userId: input.userId, providerKey: input.providerKey, cardToken: token, status: { not: "REVOKED" } } });
  if (mine) return mine;
  const other = await tx.paymentInstrument.findFirst({ where: { providerKey: input.providerKey, cardToken: token, userId: { not: input.userId } }, select: { userId: true } });
  if (other) {
    logWarn({ alert: "CARD_SHARED", userId: input.userId, providerKey: input.providerKey }, "a card token already belongs to another user");
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "DEPOSIT", subjectId: input.depositId, subjectUserId: input.userId, actorKind: "SYSTEM", verb: "NOTE", reasonCode: "CARD_SHARED",
        metadata: { otherUserId: other.userId },
      },
    });
  }
  const payable = card.payoutEligible && !other;
  const last4 = card.last4 && /^[0-9]{4}$/.test(card.last4) ? card.last4 : null;
  const country = card.issuerCountry && /^[A-Z]{2}$/.test(card.issuerCountry) ? card.issuerCountry : null;
  const month = card.expMonth !== null && card.expMonth >= 1 && card.expMonth <= 12 ? card.expMonth : null;
  const now = ctx.now().getTime();
  const created = await tx.paymentInstrument.create({
    data: {
      userId: input.userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: input.providerKey, assetCode: input.assetCode,
      cardToken: token, cardFingerprint: card.fingerprint?.slice(0, 128) ?? null, cardBrand: card.brand?.slice(0, 32) ?? null, cardLast4: last4,
      cardExpMonth: month, cardExpYear: card.expYear, cardIssuerCountry: country, cardFunding: card.funding,
      depositEnabled: input.saveCard && !other, payoutEnabled: payable,
      usableAfter: new Date(payable ? now + ctx.config.newDestinationCooldownMs : now),
    },
  });
  if (payable) {
    await announceDestination(tx, ctx, created, { asset: input.assetCode, address: `${created.cardBrand ?? "Card"} •••• ${created.cardLast4 ?? "????"}`, card: true });
  }
  return created;
}

/**
 * One named revoked card back for its owner, after two administrators agreed
 * (admin.ts restoreInstrument): a new row, cooling off and announced like a new
 * card. The revoked row stays as it is, and no other instrument changes.
 */
export async function restoreCard(tx: MoneyTx, ctx: PaymentsContext, revoked: PaymentInstrument): Promise<PaymentInstrument> {
  const created = await tx.paymentInstrument.create({
    data: {
      userId: revoked.userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: revoked.providerKey, assetCode: revoked.assetCode,
      cardToken: revoked.cardToken, cardFingerprint: revoked.cardFingerprint, cardBrand: revoked.cardBrand, cardLast4: revoked.cardLast4,
      cardExpMonth: revoked.cardExpMonth, cardExpYear: revoked.cardExpYear, cardIssuerCountry: revoked.cardIssuerCountry, cardFunding: revoked.cardFunding,
      depositEnabled: true, payoutEnabled: revoked.cardFunding !== "prepaid",
      usableAfter: new Date(ctx.now().getTime() + ctx.config.newDestinationCooldownMs),
    },
  });
  await announceDestination(tx, ctx, created, { asset: created.assetCode, address: `${created.cardBrand ?? "Card"} •••• ${created.cardLast4 ?? "????"}`, card: true, restored: true });
  return created;
}
