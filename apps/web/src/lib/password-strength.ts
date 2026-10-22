import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@poker/shared";

/**
 * Password guidance for new passwords. The rules that refuse a password are
 * the server's (12 characters to 72 bytes, not containing the username, not
 * in a known breach); this module mirrors the first ones for instant feedback
 * and adds a strength estimate from zxcvbn-ts, loaded lazily as its own chunk
 * on first focus of a new-password field. Only the common dictionaries and
 * keyboard graphs are bundled (not language-en, 5 MB); feedback is our own copy.
 */
export type Score = 0 | 1 | 2 | 3 | 4;

export interface Strength {
  score: Score;
  label: string;
  warning: string | null;
  suggestions: string[];
  /** "length": the estimator has not loaded; a length-only guess that never blocks submit. */
  source: "zxcvbn" | "length";
}

/** The weakest score accepted at submit once the estimator has loaded. */
export const MIN_ACCEPTED_SCORE: Score = 2;

const LABELS: Record<Score, string> = { 0: "Too weak", 1: "Too weak", 2: "Fair", 3: "Strong", 4: "Very strong" };

const WARNINGS: Record<string, string> = {
  straightRow: "Rows of keys are easy to guess.",
  keyPattern: "Short keyboard patterns are easy to guess.",
  simpleRepeat: "Repeated characters like “aaa” are easy to guess.",
  extendedRepeat: "Repeated patterns like “abcabc” are easy to guess.",
  sequences: "Sequences like “abc” or “6543” are easy to guess.",
  recentYears: "Recent years are easy to guess.",
  dates: "Dates are easy to guess.",
  topTen: "This is one of the most used passwords.",
  topHundred: "This is a very commonly used password.",
  common: "This is a commonly used password.",
  similarToCommon: "This is similar to a commonly used password.",
  wordByItself: "A single word is easy to guess.",
  namesByThemselves: "Names on their own are easy to guess.",
  commonNames: "Common names are easy to guess.",
  userInputs: "Don’t use your username, email address or the site’s name.",
  pwned: "This password has appeared in a data breach.",
};

const SUGGESTIONS: Record<string, string> = {
  anotherWord: "Add another word or two.",
  useWords: "Use several words, ideally uncommon ones.",
  l33t: "Swapping letters for symbols (like @ for a) helps very little.",
  reverseWords: "Reversed words are still easy to guess.",
  allUppercase: "Capitals help only a little; add another word.",
  capitalization: "Capitals help only a little; add another word.",
  dates: "Avoid dates and years linked to you.",
  recentYears: "Avoid recent years.",
  associatedYears: "Avoid years linked to you.",
  sequences: "Avoid sequences.",
  repeated: "Avoid repeated words and characters.",
  longerKeyboardPattern: "Avoid keyboard patterns.",
  pwned: "Choose a password you don’t use anywhere else.",
};

export function passwordBytes(password: string): number {
  return new TextEncoder().encode(password).length;
}

/** The server's hard rules, checked locally first; null when the password may be sent. */
export function passwordRuleProblem(password: string, username?: string | null): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (passwordBytes(password) > PASSWORD_MAX_BYTES) {
    return `Too long — passwords can be up to ${PASSWORD_MAX_BYTES} bytes (fewer if you use emoji or accented letters).`;
  }
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    return "Your password can’t contain your username.";
  }
  return null;
}

/** Before the estimator loads: a length-only guess. */
export function lengthStrength(password: string): Strength {
  const n = password.length;
  if (n < PASSWORD_MIN_LENGTH) return { score: 0, label: "Too short", warning: null, suggestions: [], source: "length" };
  if (n < 16) return { score: 2, label: "Fair", warning: null, suggestions: [], source: "length" };
  return { score: 3, label: "Strong", warning: null, suggestions: [], source: "length" };
}

export type StrengthEstimator = (password: string, userInputs: string[]) => Strength;
let estimator: Promise<StrengthEstimator> | null = null;
/** The estimator once loaded, for the submit-time check. */
let loaded: StrengthEstimator | null = null;

/** Load zxcvbn-ts (its own lazy chunk). Safe to call often; it loads once. */
export function loadStrengthEstimator(): Promise<StrengthEstimator> {
  estimator ??= Promise.all([import("@zxcvbn-ts/core"), import("@zxcvbn-ts/language-common")]).then(([core, common]) => {
    const factory = new core.ZxcvbnFactory({
      graphs: common.adjacencyGraphs,
      dictionary: { ...common.dictionary },
    });
    const check = (password: string, userInputs: string[]): Strength => {
      const result = factory.check(password, userInputs.filter(Boolean));
      const short = password.length < PASSWORD_MIN_LENGTH;
      const score = (short ? Math.min(result.score, 1) : result.score) as Score;
      const warning = result.feedback.warning ? WARNINGS[result.feedback.warning] ?? null : null;
      const suggestions = result.feedback.suggestions.map((key) => SUGGESTIONS[key]).filter((s): s is string => Boolean(s));
      return { score, label: short ? "Too short" : LABELS[score], warning, suggestions, source: "zxcvbn" };
    };
    loaded = check;
    return check;
  }).catch((err: unknown) => {
    estimator = null;
    throw err;
  });
  return estimator;
}

/** The estimator if it has already loaded (submit-time check), else null: submit is never blocked by a missing chunk. */
export function loadedStrengthEstimator(): StrengthEstimator | null {
  return loaded;
}

/** Start loading the estimator (first focus of a new-password field). */
export function warmStrengthEstimator(): void {
  void loadStrengthEstimator().catch(() => undefined);
}
