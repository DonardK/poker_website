/**
 * Single formatter for every chip amount the web client renders (CR-010 /
 * SOL-048, CR-029 b, decision D5).
 *
 * COMPLIANCE NOTE: play chips are not money. Nothing in the UI may show a
 * currency symbol ("$") next to a chip amount, and every amount must use the
 * same digit grouping so a stack, a pot, a bet label and a dialog never
 * disagree about the number shown. Chips are integers end to end (engine,
 * server, wire); this module only renders them.
 *
 * The grouping locale is pinned ("en-US") instead of following the browser:
 * table pages are server-rendered by Next.js and then hydrated, so a
 * browser-dependent separator would make the SSR text and the client text
 * differ (hydration mismatch) and would let two players see the same pot
 * written differently in screenshots sent to support.
 */
const CHIP_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  useGrouping: true,
});

/**
 * Normalises a chip amount for display. Amounts from the server are always
 * safe integers; a non-finite value can only come from a client bug and is
 * shown as 0 rather than "NaN"/"Infinity". Fractions are truncated toward
 * zero (never rounded up), so the UI can never display more chips than the
 * value it was given.
 */
function toDisplayInteger(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  const whole = Math.trunc(amount);
  // Avoid rendering "-0".
  return whole === 0 ? 0 : whole;
}

/** Locale-grouped integer chip amount without any unit or currency symbol, e.g. "1,250". */
export function formatChips(amount: number): string {
  return CHIP_FORMAT.format(toDisplayInteger(amount));
}

/** Chip amount with its unit, e.g. "1,250 chips" (singular "1 chip"). */
export function formatChipsWithUnit(amount: number): string {
  const value = toDisplayInteger(amount);
  return `${CHIP_FORMAT.format(value)} ${Math.abs(value) === 1 ? "chip" : "chips"}`;
}
