/**
 * Username policy (DECISIONS.md D7). Usernames are shown to every player at a
 * table, so they must not impersonate the operator or its staff, and they are
 * unique case-insensitively (User.usernameCanonical = lower(username), a
 * generated column with a unique index), so "Alice" and "alice" can never be
 * two different people at the same table.
 */

const PATTERN = /^[A-Za-z0-9_]{3,24}$/;
/** Prefixes of system-generated accounts (guest and bot names); never chosen by a person. */
const RESERVED_PREFIXES = ["guest_", "bot_"] as const;
/** Staff/operator words a name may not equal or start with (after normalizing, see isReservedUsername). */
const RESERVED_WORDS = [
  "admin", "administrator", "support", "official", "staff", "moderator", "mod", "dealer", "system", "cashier",
  "security", "operator", "root", "owner", "helpdesk", "service", "team", "poker", "casino",
] as const;

/** The canonical (case-insensitive) form used for uniqueness and lookups; equals Postgres lower() for the allowed charset. */
export function canonicalUsername(username: string): string {
  return username.toLowerCase();
}

/**
 * Lower-cased, with underscores and then trailing digits removed, the name
 * equals or starts with a reserved word ("Admin_1", "SUPPORT", "mod_team",
 * "Poker_Pro99" are refused; "xadmin" is not). Starts-with is deliberate:
 * "AdminJoe" and "SupportDesk" impersonate staff as well as "Admin" does.
 */
export function isReservedUsername(username: string): boolean {
  const lower = canonicalUsername(username);
  if (RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  const core = lower.replace(/_/g, "").replace(/\d+$/, "");
  return RESERVED_WORDS.some((word) => core.startsWith(word));
}

export type UsernameCheck = { ok: true; username: string; canonical: string } | { ok: false; error: string };

/** Validate a username a person chose (registration). */
export function checkChosenUsername(input: unknown): UsernameCheck {
  if (typeof input !== "string" || !PATTERN.test(input)) return { ok: false, error: "Usernames are 3-24 characters: letters, digits and underscores" };
  if (isReservedUsername(input)) return { ok: false, error: "Username unavailable" };
  return { ok: true, username: input, canonical: canonicalUsername(input) };
}
