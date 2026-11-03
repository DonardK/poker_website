/**
 * Database rows to wire views (packages/shared/src/wallet.ts). Money leaves
 * as decimal strings with exactly two places, times as ISO strings; nothing
 * here returns a bigint, a provider token or a provider message.
 */
import {
  WALLET_DECIMALS,
  WITHDRAWAL_DISPLAY_STATUS,
  type DepositNext,
  type DepositView,
  type InstrumentView,
  type SettlementAsset,
  type WithdrawalDestinationView,
  type WithdrawalView,
} from "@poker/shared";
import type { Deposit, PaymentInstrument, Withdrawal } from "../generated/prisma/client";
import { formatMinor } from "../money/amounts";

export const money = (minor: bigint) => formatMinor(minor, WALLET_DECIMALS);
export const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

/** Informational confirmation counts shown with a crypto invoice (the provider decides when a payment is final). */
const MIN_CONFIRMATIONS: Readonly<Record<string, number>> = { bitcoin: 2, ethereum: 12, tron: 19 };

export function minConfirmations(network: string | null): number {
  return network ? MIN_CONFIRMATIONS[network] ?? 1 : 1;
}

export function depositView(row: Deposit): DepositView {
  return {
    id: row.id,
    method: row.method,
    status: row.status,
    asset: row.assetCode as SettlementAsset,
    amount: money(row.requestedMinor),
    creditedAmount: row.creditedMinor === null ? null : money(row.creditedMinor),
    reversedAmount: money(row.reversedMinor - row.recoveredMinor),
    refundHeldAmount: money(row.excessMinor),
    payAsset: row.payAssetCode,
    payNetwork: row.payNetwork,
    txHash: row.txHash,
    confirmations: row.confirmations,
    instrumentId: row.instrumentId,
    statusReason: row.statusReason,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    creditedAt: iso(row.creditedAt),
    closedAt: iso(row.closedAt),
  };
}

/** Where the player goes to pay, while the deposit still waits for them. */
export function depositNext(row: Deposit, now: Date): DepositNext | null {
  if (row.status !== "CREATED" && row.status !== "PENDING") return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.method === "CARD") {
    return row.hostedUrl ? { type: "REDIRECT", url: row.hostedUrl, expiresAt: row.expiresAt.toISOString() } : null;
  }
  if (!row.payAddress || !row.payAssetCode) return null;
  return {
    type: "CRYPTO_INVOICE",
    asset: row.payAssetCode,
    network: row.payNetwork ?? "",
    address: row.payAddress,
    memo: row.payMemo,
    payAmount: row.payAmount,
    expiresAt: row.expiresAt.toISOString(),
    minConfirmations: minConfirmations(row.payNetwork),
  };
}

export function instrumentView(row: PaymentInstrument): InstrumentView {
  const card = row.kind === "CARD_TOKEN";
  return {
    id: row.id,
    kind: card ? "CARD" : "CRYPTO_ADDRESS",
    status: row.status,
    label: row.label,
    card: card ? { brand: row.cardBrand, last4: row.cardLast4, expMonth: row.cardExpMonth, expYear: row.cardExpYear } : null,
    crypto: card ? null : { asset: row.assetCode, network: row.network ?? "", address: row.address ?? "", memo: row.memo },
    depositEnabled: row.depositEnabled,
    payoutEnabled: row.payoutEnabled,
    usableAfter: row.usableAfter.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function destinationView(row: PaymentInstrument | null): WithdrawalDestinationView | null {
  if (!row) return null;
  if (row.kind === "CARD_TOKEN") {
    return { instrumentId: row.id, kind: "CARD", display: `${row.cardBrand ?? "Card"} •••• ${row.cardLast4 ?? "????"}` };
  }
  return { instrumentId: row.id, kind: "CRYPTO_ADDRESS", display: row.address ?? "" };
}

/** Player-safe text for a failure code (never the provider's own message). */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  CHARGEBACK_HOLD: "Cancelled because a deposit was disputed.",
  SECURITY_LOCKDOWN: "Cancelled after you reported activity that was not yours.",
  SECURITY_HOLD: "Cancelled because of a recent security change on your account. The money is back in your balance.",
  ACCOUNT_FROZEN: "Cancelled because your account is restricted. The money is back in your balance. Contact support.",
  RESTRICTED_MANUAL: "Cancelled because withdrawals on your account now need a manual check. The money is back in your balance.",
  KYC_NOT_CLEAR: "Cancelled because your identity check needs attention. The money is back in your balance.",
  SCREENING_HIT: "Cancelled for a compliance check. The money is back in your balance. Contact support.",
  PLAYER_CANCELLED: "Cancelled at your request.",
  PROVIDER_REJECTED: "The payment provider could not send this payout. The money is back in your balance.",
  REJECTED: "This withdrawal was not approved. The money is back in your balance.",
};

export function withdrawalView(row: Withdrawal, instrument: PaymentInstrument | null): WithdrawalView {
  const failed = row.status === "FAILED" || row.status === "REJECTED" || row.status === "CANCELLED";
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    displayStatus: WITHDRAWAL_DISPLAY_STATUS[row.status],
    asset: row.assetCode as SettlementAsset,
    amount: money(row.amountMinor),
    fee: money(row.feeMinor),
    youReceive: money(row.amountMinor - row.feeMinor),
    payoutAsset: row.payoutAssetCode,
    payoutAmount: row.payoutAmount,
    destination: destinationView(instrument),
    txHash: row.txHash,
    failureReason: failed ? FAILURE_TEXT[row.failureCode ?? (row.status === "REJECTED" ? "REJECTED" : "PROVIDER_REJECTED")] ?? FAILURE_TEXT.PROVIDER_REJECTED! : null,
    createdAt: row.createdAt.toISOString(),
    settledAt: iso(row.settledAt),
    closedAt: iso(row.closedAt),
  };
}
