/**
 * Legal document registry and the terms/age acceptance sent at sign-up.
 *
 * COMPLIANCE NOTES
 * - TERMS_VERSION is the version of the legal documents this build shows.
 *   Registration sends it with an explicit 18+ and terms acceptance; the server stores version + time per account and refuses a
 *   version that is not its current one (409 TERMS_OUTDATED), so nobody is
 *   recorded as accepting text they were never shown. Bump it (together with
 *   the server's TERMS_VERSION) whenever any document below changes in
 *   substance.
 * - Every document is a DRAFT until counsel approves it. The banner on each
 *   page says so; real-money mode refuses to start until the approved version
 *   equals the current one (server-side, decision D10).
 */
export const TERMS_VERSION = "2026-10-19";

/** Human-readable effective date of TERMS_VERSION, shown on every document. */
export const TERMS_EFFECTIVE_DATE = "19 October 2026";

export interface LegalPageLink {
  href: "/terms" | "/privacy" | "/rules" | "/responsible-gaming" | "/complaints" | "/fairness";
  /** Full document title (page heading and <title>). */
  title: string;
  /** Short label for the footer. */
  label: string;
}

/** Every legal document, in footer order. Each one is linked from every page (site footer). */
export const LEGAL_PAGES: readonly LegalPageLink[] = [
  { href: "/terms", title: "Terms of Service", label: "Terms" },
  { href: "/privacy", title: "Privacy Notice", label: "Privacy" },
  { href: "/rules", title: "House Rules", label: "House rules" },
  { href: "/fairness", title: "Game Fairness", label: "Fairness" },
  { href: "/responsible-gaming", title: "Responsible Gaming", label: "Responsible gaming" },
  { href: "/complaints", title: "Complaints", label: "Complaints" },
];

/** The statement required wherever a play-chip balance is shown. */
export const PLAY_CHIPS_NOTICE = "Play chips have no cash value and cannot be redeemed.";

/** Short notice on the footer and on sign-up / sign-in. */
export const PLAY_MONEY_NOTICE = "Play chips only — no real money";

/** Body fields the server requires on POST /api/auth/register. */
export interface TermsAcceptance {
  acceptTerms: true;
  confirmAge: true;
  termsVersion: string;
}

/**
 * The acceptance block for a sign-up request. Only call this after the user
 * ticked both boxes: the literal `true`s are a statement the user made, never
 * a default.
 */
export function termsAcceptance(): TermsAcceptance {
  return { acceptTerms: true, confirmAge: true, termsVersion: TERMS_VERSION };
}

/**
 * A clear message for the server's terms refusals, or null for any other
 * error. The server answers 400 TERMS_REQUIRED (acceptance missing) and 409
 * TERMS_OUTDATED (this page shows an older version than the server's; a
 * reload loads the current documents). The `code` field is read when the API
 * error carries it; otherwise the refusal is recognised by status plus the
 * server's wording, because registration also uses 409 for a taken username,
 * which must keep its own message.
 */
export function termsErrorMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const { code, status, currentVersion } = err as Error & { code?: unknown; status?: unknown; currentVersion?: unknown };
  const mentionsTerms = /terms|age|18/i.test(err.message);
  const outdated = code === "TERMS_OUTDATED" || (code === undefined && status === 409 && /terms/i.test(err.message));
  if (outdated) {
    const version = typeof currentVersion === "string" && /^[\w.-]{1,32}$/.test(currentVersion) ? ` (version ${currentVersion})` : "";
    return `Our terms have been updated${version} since this page was loaded. Reload the page, review the current Terms and Privacy Notice, and accept them to continue.`;
  }
  if (code === "TERMS_REQUIRED" || (code === undefined && status === 400 && mentionsTerms)) {
    return "To continue, confirm that you are 18 or older and accept the Terms of Service and Privacy Notice.";
  }
  return null;
}
