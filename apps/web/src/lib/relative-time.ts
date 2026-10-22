/** People-readable times for account pages (client-rendered only, so the viewer's locale settings never cause a hydration mismatch). */
const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function toMs(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
}

/** "3 minutes ago", "yesterday", "just now". */
export function formatRelativeTime(value: string | number | Date, now = Date.now()): string {
  const at = toMs(value);
  if (!Number.isFinite(at)) return "";
  const diff = at - now;
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return RELATIVE.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

/** "19 Oct 2026". */
export function formatDate(value: string | number | Date): string {
  const at = toMs(value);
  return Number.isFinite(at) ? DATE.format(at) : "";
}

/** "19 Oct 2026, 14:05". */
export function formatDateTime(value: string | number | Date): string {
  const at = toMs(value);
  return Number.isFinite(at) ? DATE_TIME.format(at) : "";
}
