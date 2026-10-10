/**
 * Username policy. Usernames are unique case-insensitively
 * (User.usernameCanonical = lower(username)).
 */

const PATTERN = /^[A-Za-z0-9_]{3,24}$/;
const RESERVED_PREFIXES = ["guest_", "bot_"] as const;
const RESERVED_WORDS = [
  "admin", "administrator", "support", "official", "staff", "moderator", "mod", "dealer", "system", "cashier",
  "security", "operator", "root", "owner", "helpdesk", "service", "team", "poker", "casino",
] as const;

export function canonicalUsername(username: string): string {
  return username.toLowerCase();
}

export function isReservedUsername(username: string): boolean {
  const lower = canonicalUsername(username);
  if (RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  const core = lower.replace(/_/g, "").replace(/\d+$/, "");
  return RESERVED_WORDS.some((word) => core.startsWith(word));
}

export type UsernameCheck = { ok: true; username: string; canonical: string } | { ok: false; error: string };

export function checkChosenUsername(input: unknown): UsernameCheck {
  if (typeof input !== "string" || !PATTERN.test(input)) return { ok: false, error: "Usernames are 3-24 characters: letters, digits and underscores" };
  if (isReservedUsername(input)) return { ok: false, error: "Username unavailable" };
  return { ok: true, username: input, canonical: canonicalUsername(input) };
}
