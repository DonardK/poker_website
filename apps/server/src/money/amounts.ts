/**
 * Exact money arithmetic (docs/money/LEDGER.md sections 2 and 8).
 *
 * Ledger amounts are bigint minor units (cents, satoshi, gwei, play chips).
 * Table chips are JS safe integers (the engine's unit). Nothing here ever
 * touches a float: decimal strings are parsed digit by digit, chip/minor
 * conversions refuse any remainder or overflow instead of rounding, so no
 * fraction of a unit can be created or lost at a boundary.
 */

/** Postgres BIGINT range: the ledger can store nothing outside it. */
export const BIGINT_MAX = 9_223_372_036_854_775_807n;
export const BIGINT_MIN = -9_223_372_036_854_775_808n;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new AmountError("decimals must be an integer 0..18");
}

/** Throws unless `value` fits a Postgres BIGINT. */
export function assertBigintRange(value: bigint, what = "amount"): bigint {
  if (value > BIGINT_MAX || value < BIGINT_MIN) throw new AmountError(`${what} is outside the BIGINT range`);
  return value;
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Parses a non-negative decimal string ("12.34") into minor units (1234n for
 * 2 decimals). Strict: no sign, exponent, whitespace, grouping, leading zeros,
 * bare "." or ".5"; more fractional digits than the asset has are refused
 * (even "1.230" for 2 decimals) because an amount that needs rounding is a
 * caller error, never something to round silently. Refuses results beyond
 * the BIGINT range.
 */
export function parseMinor(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof value !== "string" || value.length > 64) throw new AmountError("amount must be a decimal string");
  const match = DECIMAL.exec(value);
  if (!match) throw new AmountError("amount must be a non-negative decimal number");
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new AmountError(`amount has more than ${decimals} decimal places`);
  const minor = BigInt(whole + fraction.padEnd(decimals, "0"));
  return assertBigintRange(minor);
}

/** Renders minor units as a decimal string with exactly `decimals` places ("-0.05", "1234"). */
export function formatMinor(minor: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (typeof minor !== "bigint") throw new AmountError("minor amount must be a bigint");
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString();
  if (decimals === 0) return (negative ? "-" : "") + digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function assertChipUnit(chipUnit: bigint): void {
  if (typeof chipUnit !== "bigint" || chipUnit <= 0n) throw new AmountError("chipUnit must be a positive bigint");
  assertBigintRange(chipUnit, "chipUnit");
}

/** Chips (non-negative JS safe integer) x chipUnit, exactly; refuses BIGINT overflow. */
export function chipsToMinor(chips: number, chipUnit: bigint): bigint {
  assertChipUnit(chipUnit);
  if (!Number.isSafeInteger(chips) || chips < 0) throw new AmountError("chips must be a non-negative safe integer");
  return assertBigintRange(BigInt(chips) * chipUnit);
}

/**
 * Minor units / chipUnit, exactly. A remainder means the amount is not a whole
 * number of chips: refused, because rounding would create or destroy value.
 */
export function minorToChips(minor: bigint, chipUnit: bigint): number {
  assertChipUnit(chipUnit);
  if (typeof minor !== "bigint" || minor < 0n) throw new AmountError("minor amount must be a non-negative bigint");
  if (minor % chipUnit !== 0n) throw new AmountError("amount is not a whole number of chips");
  const chips = minor / chipUnit;
  if (chips > BigInt(Number.MAX_SAFE_INTEGER)) throw new AmountError("chip count exceeds the safe integer range");
  return Number(chips);
}

/** Parses a chipUnit decimal string from configuration or the wire ("1", "10000"). */
export function parseChipUnit(value: string): bigint {
  const unit = parseMinor(value, 0);
  assertChipUnit(unit);
  return unit;
}

/** Value with every bigint (deeply) replaced by its decimal string. */
export type JsonSafe<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends readonly (infer U)[]
      ? JsonSafe<U>[]
      : T extends object
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : T;

/**
 * Deep copy with bigint -> decimal string, for res.json / socket payloads.
 * JSON.stringify throws on bigint, and Number(bigint) silently loses
 * precision above 2^53, so money must cross the wire as strings.
 */
export function jsonSafe<T>(value: T): JsonSafe<T> {
  return convert(value) as JsonSafe<T>;
}

function convert(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(convert);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = convert(inner);
  return out;
}
