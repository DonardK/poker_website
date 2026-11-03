/**
 * Wallet ids from untrusted places (a query string, sessionStorage). Pure,
 * so server components can use it too (the /wallet page's redirect).
 */

/** A deposit or withdrawal id from a query string: short and URL-safe, or null. */
export function cleanObjectId(raw: string | null | undefined): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

/** sessionStorage key: the deposit this tab last sent to a provider page (the return page's fallback). */
export const LAST_DEPOSIT_KEY = "poker-last-deposit";

/** The deposit outcome page for this (clean) deposit id. */
export function depositReturnPath(depositId: string): string {
  return `/wallet/deposit/return?deposit=${encodeURIComponent(depositId)}`;
}
