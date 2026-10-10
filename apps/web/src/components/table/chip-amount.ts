/**
 * One integer amount model for every chip input on the table page (bet/raise
 * size, buy-in). Chips are integers end to end: the server refuses a
 * fractional or non-finite amount, so the client never holds one. The text a
 * player types is kept as a draft (so a field can be cleared and retyped),
 * but the amount derived from it, the label that shows it and the amount
 * sent are always the same finite integer.
 */

/** Clamp an amount to [min, max] as an integer. Bounds come from the server (integers); max wins if they cross. */
export function clampChips(value: number, min: number, max: number): number {
  const lo = Math.floor(min);
  const hi = Math.floor(max);
  const whole = Number.isFinite(value) ? Math.floor(value) : lo;
  return Math.min(hi, Math.max(lo, whole));
}

/**
 * The integer a draft names, floored, or null when it names no finite number
 * (empty while retyping, a lone "-"). Fractions are floored, never rounded
 * up, so a typed amount can only move down to what is actually sent.
 */
export function parseChipDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  const whole = Math.floor(value);
  return Number.isSafeInteger(whole) ? whole : null;
}

/**
 * The draft to keep after a change: a typed fraction is floored on the spot
 * (so "150.5" becomes "150" and the field never shows an amount that is not
 * the one sent); anything that names no number is kept for retyping.
 */
export function normaliseChipDraft(draft: string): string {
  const parsed = parseChipDraft(draft);
  if (parsed === null) return draft.trim() === "" ? "" : draft;
  return /[.,eE]/.test(draft) ? String(parsed) : draft;
}
