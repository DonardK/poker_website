export const DEFAULT_MAX_SEATS = 6;
export const ABSOLUTE_MAX_SEATS = 9;
export const DEFAULT_SMALL_BLIND = 5;
export const DEFAULT_BIG_BLIND = 10;
export const DEFAULT_BUY_IN = 1000;
export const DEFAULT_STARTING_BANKROLL = 10_000;
export const TURN_TIME_BANK_MS = 15_000;
export const BOT_THINK_FOLD_MS = [1_000, 2_000] as const;
export const BOT_THINK_RIVER_RAISE_MS = [3_000, 6_000] as const;
export const ACTION_RATE_LIMIT_WINDOW_MS = 2_000;
export const ACTION_RATE_LIMIT_MAX = 8;
export const TABLE_LOCK_TTL_MS = 5_000;
/** A table with no voluntary player activity for this long gets the closing warning. */
export const TABLE_IDLE_TIMEOUT_MS = 5 * 60_000;
/** How long the closing warning is shown before an idle table closes. */
export const TABLE_IDLE_WARNING_MS = 30_000;
/** Why a table closed: IDLE = no activity (warning expired); EMPTY = every seat was released. */
export type TableCloseReason = "IDLE" | "EMPTY";
export const REFRESH_COOKIE_NAME = "poker_refresh";
/**
 * Set and cleared together with the refresh cookie (Path=/, HttpOnly, same lifetime).
 * Only a redirect hint for the web middleware, never an authenticator.
 */
export const SESSION_HINT_COOKIE_NAME = "poker_session_hint";

// Account security (docs/cloudflare/ARCHITECTURE.md §5).
/** Step-up freshness: account changes need a sign-in or re-auth this recent (Session.reauthAt). */
export const STEP_UP_WINDOW_MS = 5 * 60_000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 72;
/** Longest login identifier: an email address (RFC 5321 path limit). */
export const LOGIN_IDENTIFIER_MAX_LENGTH = 254;
export const TOTP_DIGITS = 6;
export const BACKUP_CODE_COUNT = 10;
/** Usernames this device remembers for quick re-login (localStorage only; never passwords or tokens). */
export const RECENT_ACCOUNTS_MAX = 5;
/** A money step-up grant lives at most this long (the database enforces it) and is used once. */
export const STEP_UP_GRANT_TTL_MS = 5 * 60_000;
/** The emailed step-up code: digits, lifetime and wrong tries allowed (the database enforces the last two). */
export const STEP_UP_EMAIL_CODE_DIGITS = 6;
export const STEP_UP_EMAIL_CODE_TTL_MS = 10 * 60_000;
export const STEP_UP_EMAIL_CODE_MAX_ATTEMPTS = 5;

export const BOT_USERNAMES: Record<BotProfile, readonly string[]> = {
  TAG: ["Bot_Alice", "Bot_Vera"],
  LOOSE_PASSIVE: ["Bot_Bob", "Bot_Clyde"],
  MANIAC: ["Bot_Rex", "Bot_Nova"],
  GTO: ["Bot_Gideon", "Bot_Iris"],
};

export type BotProfile = "TAG" | "LOOSE_PASSIVE" | "MANIAC" | "GTO";
export type PlayerKind = "HUMAN" | "BOT";
export type UserRole = "PLAYER" | "ADMIN";

export type TableStatus = "WAITING" | "IN_HAND" | "PAUSED" | "CLOSED";
export type SeatOccupancy = "EMPTY" | "OCCUPIED" | "SIT_OUT";
export type PlayerStatus = "ACTIVE" | "FOLDED" | "ALL_IN" | "SIT_OUT" | "ELIMINATED";

export type HandPhase =
  | "WAITING"
  | "PREFLOP"
  | "FLOP"
  | "TURN"
  | "RIVER"
  | "SHOWDOWN"
  | "COMPLETE";

export type ActionType = "FOLD" | "CHECK" | "CALL" | "BET" | "RAISE" | "ALL_IN";

export type StreetAction =
  | "POST_SB"
  | "POST_BB"
  | "POST_DEAD"
  | "FOLD"
  | "CHECK"
  | "CALL"
  | "BET"
  | "RAISE"
  | "ALL_IN"
  | "TIMEOUT_FOLD"
  | "TIMEOUT_CHECK";

// Rake and hand-audit constants (shared by the engine and the audit verifiers).
/** Rake is quoted in basis points of the chips contested in a hand: 10_000 bps = 100%. */
export const RAKE_BPS_DENOMINATOR = 10_000;
/** Highest rake a table may be configured with: 1000 bps = 10%. */
export const RAKE_MAX_BPS = 1_000;
/** Longest staff reason a HAND_VOIDED audit event may carry (it is public to every participant). */
export const HAND_VOID_REASON_MAX_LENGTH = 200;
