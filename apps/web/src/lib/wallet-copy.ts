import type {
  DepositStatus, RealMoneyReason, WalletTxKind, WithdrawalDisplayStatus,
} from "@poker/shared";
import { ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import { formatDateTime } from "@/lib/relative-time";

/**
 * Every word the wallet shows about a status, a reason or an error. Raw enum
 * values and provider messages are never shown: an unknown value gets a
 * neutral label instead (a newer API must not leak "PARTIALLY_REVERSED" or a
 * processor's error text onto the page).
 */

export type StatusTone = "success" | "warning" | "neutral";

const DEPOSIT_STATUS: Readonly<Record<DepositStatus, { label: string; tone: StatusTone }>> = {
  CREATED: { label: "Started", tone: "neutral" },
  PENDING: { label: "Awaiting payment", tone: "warning" },
  CONFIRMED: { label: "Confirming", tone: "warning" },
  CREDITED: { label: "Completed", tone: "success" },
  NEEDS_REVIEW: { label: "Being checked", tone: "warning" },
  FAILED: { label: "Failed", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  PARTIALLY_REVERSED: { label: "Partly reversed", tone: "warning" },
  REVERSED: { label: "Reversed", tone: "neutral" },
};

const WITHDRAWAL_STATUS: Readonly<Record<WithdrawalDisplayStatus, { label: string; tone: StatusTone }>> = {
  PENDING_REVIEW: { label: "Pending review", tone: "warning" },
  PROCESSING: { label: "Sending", tone: "warning" },
  PAID: { label: "Paid", tone: "success" },
  FAILED: { label: "Failed — funds returned", tone: "neutral" },
  REJECTED: { label: "Rejected — funds returned", tone: "neutral" },
  CANCELLED: { label: "Cancelled — funds returned", tone: "neutral" },
  RETURNED: { label: "Returned to your balance", tone: "neutral" },
};

/** WithdrawalStatus (database) to what the player sees, for history rows that carry the raw status. */
const WITHDRAWAL_RAW: Readonly<Record<string, WithdrawalDisplayStatus>> = {
  REQUESTED: "PENDING_REVIEW", HELD: "PENDING_REVIEW", UNDER_REVIEW: "PENDING_REVIEW",
  APPROVED: "PROCESSING", SUBMITTED: "PROCESSING", SETTLED: "PAID",
  FAILED: "FAILED", REJECTED: "REJECTED", CANCELLED: "CANCELLED", RETURNED: "RETURNED",
};

export function depositStatus(status: string): { label: string; tone: StatusTone } {
  return DEPOSIT_STATUS[status as DepositStatus] ?? { label: "In progress", tone: "neutral" };
}

export function withdrawalStatus(display: string): { label: string; tone: StatusTone } {
  return WITHDRAWAL_STATUS[display as WithdrawalDisplayStatus] ?? { label: "In progress", tone: "neutral" };
}

/** A history row's status: the payment object behind it decides which vocabulary applies. */
export function historyStatus(refType: "DEPOSIT" | "WITHDRAWAL" | "REVERSAL" | null, status: string | null): { label: string; tone: StatusTone } | null {
  if (!status) return null;
  if (refType === "WITHDRAWAL") return withdrawalStatus(WITHDRAWAL_RAW[status] ?? "");
  if (refType === "DEPOSIT") return depositStatus(status);
  return null;
}

export const DEPOSIT_TERMINAL: ReadonlySet<string> = new Set(["CREDITED", "FAILED", "EXPIRED", "CANCELLED", "PARTIALLY_REVERSED", "REVERSED"]);
/** Withdrawal display statuses that still change on their own. */
export const WITHDRAWAL_OPEN: ReadonlySet<string> = new Set(["PENDING_REVIEW", "PROCESSING"]);

const TX_KIND: Readonly<Record<WalletTxKind, string>> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  WITHDRAWAL_RELEASED: "Withdrawal returned to balance",
  PAYOUT_RETURNED: "Payout returned to balance",
  REVERSAL: "Deposit reversed",
  RECOVERY: "Reversal recovered",
  REFUND: "Held for refund",
  FEE: "Fee",
  ADJUSTMENT: "Adjustment",
};

export function txKindLabel(kind: string): string {
  return TX_KIND[kind as WalletTxKind] ?? "Balance change";
}

/** Why money cannot move (RealMoneySummary.reasons), as the player reads it. KYC reasons have their own card. */
export const REASON_COPY: Readonly<Record<RealMoneyReason, string>> = {
  NOT_LAUNCHED: "Deposits and withdrawals are not available yet.",
  PAUSED: "Payments are paused for maintenance. Your balance is safe; try again later.",
  REGION: "Real-money play is not available in your region. You can still withdraw your balance.",
  KYC_REQUIRED: "Verify your identity to deposit and withdraw.",
  KYC_PENDING: "We're checking your documents. This usually takes a few minutes.",
  LIMITS_SETUP_REQUIRED: "Before your first deposit, choose your deposit limits (or choose no limit).",
  SELF_EXCLUDED: "Deposits are closed during your self-exclusion. You can still withdraw your balance.",
  ACCOUNT_RESTRICTED:
    "Some payments on your account are paused for your protection, and withdrawals are reviewed by our team first. Contact support if you didn't expect this.",
  SOURCE_OF_FUNDS_REQUIRED: "Before you deposit more, we need to confirm where your funds come from. Our team will contact you by email.",
};

/** The copy shown while real money is off on this deployment (production today). */
export const OFF_TITLE = "Deposits and withdrawals are not available yet";
export const OFF_BODY =
  "Real-money play isn't available yet. Deposits and withdrawals will open only once Hold'em Live holds a gaming licence. Your play chips are for fun and have no cash value.";

export const SANDBOX_TITLE = "Test money (TEST_EUR) — not real";
export const SANDBOX_BODY = "Sandbox: test payments only. No real money moves, and test euros can never be paid out or spent outside this sandbox.";

/** "until 19 Oct 2026, 14:05", or "for a while" when the time is unknown. */
export function untilText(iso: string | null | undefined): string {
  const text = iso ? formatDateTime(iso) : "";
  return text ? `until ${text}` : "for a while";
}

export function securityHoldText(until: string | null | undefined): string {
  return `For your security, withdrawals and new payout addresses are paused ${untilText(until)} after a recent change to your account's sign-in details.`;
}

function detail(err: ApiError, key: string): string | null {
  const nested = err.details.details;
  const value = typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>)[key] : undefined;
  const top = err.details[key];
  const picked = typeof value === "string" ? value : typeof top === "string" ? top : null;
  return picked && picked.length <= 200 ? picked : null;
}

/** The settlement asset of the request that failed, for amounts in error details. */
export interface ErrorContext {
  asset?: string;
  network?: string;
}

const MESSAGES: Readonly<Record<string, string>> = {
  VALIDATION: "Check the details and try again.",
  IDEMPOTENCY_KEY_REQUIRED: "Something went wrong sending this request. Refresh the page and try again.",
  IDEMPOTENCY_CONFLICT: "This request was already sent with different details. Refresh the page and try again.",
  NOT_FOUND: "We couldn't find that payment.",
  REAL_MONEY_DISABLED: "Deposits and withdrawals are not available yet.",
  PAYMENTS_PAUSED: "Payments are paused for maintenance. Your balance is safe; try again later.",
  METHOD_DISABLED: "This payment method isn't available right now. Try another one.",
  REGION_BLOCKED: "Real-money play is not available in your region.",
  KYC_REQUIRED: "Verify your identity first.",
  KYC_PENDING: "Your identity check is still in progress. Try again once it's done.",
  SELF_EXCLUDED: "Deposits are closed during your self-exclusion. You can still withdraw your balance.",
  ACCOUNT_RESTRICTED: "Payments on your account are restricted for your protection. Contact support.",
  SOURCE_OF_FUNDS_REQUIRED: "We need to confirm where your funds come from first. Our team will contact you by email.",
  LIMITS_SETUP_REQUIRED: "Choose your deposit limits before your first deposit.",
  STEP_UP_REQUIRED: "Confirm it's you to continue.",
  ASSET_UNSUPPORTED: "That currency isn't available. Choose another one.",
  TOO_MANY_PENDING: "You have too many payments in progress. Wait for one to finish, then try again.",
  INVALID_STATE: "This payment can't be changed any more.",
  MEMO_REQUIRED: "This address needs a memo or tag, which isn't supported yet.",
  ADDRESS_BLOCKED: "This address can't be used for withdrawals.",
  DESTINATION_EXISTS: "This address is already saved.",
  DESTINATION_LIMIT: "You've added as many payout addresses as you can for now. Remove one or try again tomorrow.",
  INSTRUMENT_IN_USE: "A withdrawal in progress uses this destination. Try again once it has finished.",
  DESTINATION_UNAVAILABLE: "This destination can't receive withdrawals. Choose another one.",
  INSUFFICIENT_FUNDS: "That's more than your available balance.",
  QUOTE_EXPIRED: "This quote has expired. Review the withdrawal again to get a new one.",
  CANCEL_DISABLED: "This withdrawal can't be cancelled. Contact support if you need help.",
  RG_RULE: "This isn't possible under your responsible-gaming settings.",
  EXCLUSION_NOT_ENDED: "Your break hasn't ended yet. You can ask to come back once it has.",
  REFUND_DESTINATION_REQUIRED: "This refund needs a payout address. Add one in your wallet, and our team will send it there.",
  CARD_UNKNOWN: "This deposit can't be credited. Our team will return it to your card.",
  PROVIDER_UNAVAILABLE: "The payment provider isn't answering. Nothing was charged. Try again in a few minutes.",
  PAYMENTS_UNAVAILABLE: "Payments are unavailable right now. Try again in a few minutes.",
  INTERNAL: "Something went wrong on our side. Nothing was charged. Try again.",
  EMAIL_NOT_VERIFIED: "Confirm your email address first: we send payment receipts and security alerts there.",
  FORBIDDEN: "You can't do that on this account.",
};

/**
 * The message for a failed wallet request (docs/money/WALLET.md section 11,
 * WALLET_ERROR_STATUS), with the amounts and times the error carries.
 */
export function walletErrorMessage(err: unknown, context: ErrorContext = {}): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  if (err.status === 0) return err.message;
  const asset = context.asset ?? "EUR";
  switch (err.code) {
    case "SECURITY_HOLD":
      return securityHoldText(detail(err, "until"));
    case "DEPOSIT_LIMIT_EXCEEDED": {
      const remaining = detail(err, "remaining");
      return remaining
        ? `That's over your deposit limit. You can deposit up to ${formatMoney(remaining, asset)} more right now.`
        : "That's over your deposit limit.";
    }
    case "AMOUNT_BELOW_MIN": {
      const min = detail(err, "min");
      return min ? `The minimum is ${formatMoney(min, asset)}.` : "That amount is below the minimum.";
    }
    case "AMOUNT_ABOVE_MAX": {
      const max = detail(err, "max");
      return max ? `The maximum is ${formatMoney(max, asset)}.` : "That amount is above the maximum.";
    }
    case "CARD_PAYOUT_LIMIT": {
      const max = detail(err, "max");
      return `${max ? `This card can receive up to ${formatMoney(max, asset)}` : "This card can't receive that much"}: what it deposited, less what it has already received. Withdraw the rest to a payout address.`;
    }
    case "DESTINATION_COOLING_OFF": {
      const at = detail(err, "usableAfter");
      return `For your safety, a new payout destination can be used ${at ? `from ${formatDateTime(at)}` : "after a waiting period"}.`;
    }
    case "ADDRESS_INVALID":
      return `That doesn't look like a valid ${context.network ? `${networkLabel(context.network)} ` : ""}address. Check it and try again.`;
    default:
      break;
  }
  if (err.status === 429) {
    const seconds = err.retryAfterMs !== undefined ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : null;
    return seconds ? `Too many requests. Try again in ${seconds} s.` : "Too many requests. Wait a moment and try again.";
  }
  if (err.code && MESSAGES[err.code]) return MESSAGES[err.code]!;
  if (err.status >= 500) return MESSAGES.PAYMENTS_UNAVAILABLE!;
  return "That didn't work. Try again.";
}

const NETWORKS: Readonly<Record<string, string>> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum (ERC-20)",
  tron: "TRON (TRC-20)",
};

export function networkLabel(network: string): string {
  return NETWORKS[network] ?? network;
}

/** A card as the player recognises it: "Visa •••• 4242". */
export function cardLabel(card: { brand: string | null; last4: string | null }): string {
  const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1).toLowerCase() : "Card";
  return card.last4 ? `${brand} •••• ${card.last4}` : brand;
}

/** "0x12ab…9fKx": the first and last characters a player should compare after pasting. */
export function shortAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/** An address in groups of four, for reading it aloud or comparing it character by character. */
export function groupedAddress(address: string): string {
  return address.replace(/(.{4})(?=.)/g, "$1 ");
}

const ADDRESS_FORMATS: Readonly<Record<string, RegExp>> = {
  // Base58 (1…, 3…) or bech32/bech32m (bc1…, one case only).
  bitcoin: /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[02-9ac-hj-np-z]{11,71}|BC1[02-9AC-HJ-NP-Z]{11,71})$/,
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

/**
 * A format check only, to catch a truncated paste or the wrong network
 * before anything is sent. The payments Worker is the authority (checksums,
 * the provider's own validation, sanctions screening).
 */
export function addressFormatProblem(network: string, address: string): string | null {
  const value = address.trim();
  if (!value) return "Enter the address.";
  if (/\s/.test(value)) return "An address has no spaces. Paste it again.";
  if (value.length > 128) return "That's too long to be an address.";
  const format = ADDRESS_FORMATS[network];
  if (format && !format.test(value)) return `That doesn't look like a ${networkLabel(network)} address. Check that you copied all of it, from the right network.`;
  return null;
}
