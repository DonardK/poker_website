/**
 * Real-money amounts in the wallet (packages/shared/src/wallet.ts): decimal
 * strings in the asset's major unit ("50.00", "-0.05") end to end. They are
 * never turned into a JavaScript number: a float cannot hold every cent
 * exactly, so parsing, comparing and formatting work on the digits (and on
 * BigInt minor units where arithmetic is needed).
 *
 * COMPLIANCE NOTE: play chips are not money and never pass through here
 * (lib/format.ts, decision D5). TEST_EUR is sandbox money with no value: it
 * is written with its code ("12.34 TEST_EUR"), never with a euro sign, so a
 * screenshot of the sandbox can never be mistaken for a real balance.
 */
import { MONEY_AMOUNT_PATTERN, WALLET_DECIMALS } from "@poker/shared";

const WIRE_AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/;

const SYMBOLS: Readonly<Record<string, string>> = { EUR: "€" };

/** "1234567" -> "1,234,567" (fixed grouping, as formatChips: the same on the server render and every browser). */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * An amount from the API for display: "€1,234.50", "12.34 TEST_EUR".
 * `signed` adds "+" to a positive amount (history rows); a negative one
 * always shows a minus sign. Anything that is not a decimal string (a bug or
 * a newer API) shows as a dash instead of a wrong number.
 */
export function formatMoney(amount: string | null | undefined, asset: string, opts: { signed?: boolean } = {}): string {
  const match = typeof amount === "string" ? WIRE_AMOUNT.exec(amount.trim()) : null;
  if (!match) return "—";
  const [, minus, whole, fraction = ""] = match;
  const integer = whole!.replace(/^0+(?=\d)/, "");
  // Responses carry exactly two places; fewer are padded, more are shown as sent (never rounded away).
  const cents = fraction.length >= WALLET_DECIMALS ? fraction : fraction.padEnd(WALLET_DECIMALS, "0");
  const zero = /^0+$/.test(integer + cents);
  const sign = zero ? "" : minus ? "−" : opts.signed ? "+" : "";
  const body = `${group(integer)}.${cents}`;
  const symbol = SYMBOLS[asset];
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${asset}`;
}

/** An amount in minor units (cents), or null when it is not a well-formed decimal string with at most `decimals` places. */
export function toMinor(amount: string, decimals = WALLET_DECIMALS): bigint | null {
  const match = WIRE_AMOUNT.exec(amount.trim());
  if (!match) return null;
  const [, minus, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const minor = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return minus ? -minor : minor;
}

/** Minor units back to a decimal string with exactly `decimals` places ("1234" cents -> "12.34"). */
export function fromMinor(minor: bigint, decimals = WALLET_DECIMALS): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}${decimals > 0 ? `.${fraction}` : ""}`;
}

/** -1, 0 or 1; null when either side is not an amount. */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 | null {
  const x = toMinor(a);
  const y = toMinor(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

export type AmountInputResult = { ok: true; amount: string } | { ok: false; error: string };

/**
 * What a player typed into an amount field, as the request amount the API
 * accepts (MONEY_AMOUNT_PATTERN: no sign, no grouping, at most two places).
 * A comma is accepted as the decimal separator ("12,50"), never as grouping;
 * leading zeros are dropped. The result is normalised to two places.
 */
export function parseAmountInput(raw: string): AmountInputResult {
  const typed = raw.trim().replace(/\s+/g, "");
  if (!typed) return { ok: false, error: "Enter an amount." };
  const decimal = /^\d+,\d{1,2}$/.test(typed) ? typed.replace(",", ".") : typed;
  if (/^\d+\.\d{3,}$/.test(decimal)) return { ok: false, error: `Use at most ${WALLET_DECIMALS} decimal places.` };
  if (!/^\d+(\.\d{1,2})?$/.test(decimal)) return { ok: false, error: "Enter an amount like 20 or 20.50, without currency signs or separators." };
  const [whole = "0", fraction = ""] = decimal.split(".");
  const normalised = `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(WALLET_DECIMALS, "0")}`;
  if (!MONEY_AMOUNT_PATTERN.test(normalised)) return { ok: false, error: "That amount is too large." };
  if (toMinor(normalised) === 0n) return { ok: false, error: "Enter an amount above zero." };
  return { ok: true, amount: normalised };
}

/** A friendly asset name for headings and labels. */
export function assetLabel(asset: string): string {
  return asset === "TEST_EUR" ? "test euros (TEST_EUR)" : asset === "EUR" ? "euros" : asset;
}
