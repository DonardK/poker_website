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
export const REFRESH_COOKIE_NAME = "poker_refresh";

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
