import type { ActionType, BotProfile, HandPhase, PlayerKind, PlayerStatus, TableCloseReason, TableStatus } from "./constants.js";
import type { Card } from "./poker.js";

export const SOCKET_EVENTS = {
  TABLE_JOIN: "TABLE_JOIN",
  TABLE_LEAVE: "TABLE_LEAVE",
  SEAT_CLAIM: "SEAT_CLAIM",
  SIT_OUT: "SIT_OUT",
  SIT_IN: "SIT_IN",
  ACTION_INTENT: "ACTION_INTENT",
  REHYDRATE: "REHYDRATE",
  STAND_UP: "STAND_UP",
  TABLE_KEEP_ALIVE: "TABLE_KEEP_ALIVE",
  TABLE_IDLE_NOTICE: "TABLE_IDLE_NOTICE",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  HAND_HISTORY_LOG: "HAND_HISTORY_LOG",
  SERVER_ERROR: "SERVER_ERROR",
  AUTH_OK: "AUTH_OK",
  USER_PATCH: "USER_PATCH",
  /** Client -> server: swap this socket's access token in place after a refresh (same user only); no reconnect, no table reset. */
  SESSION_RENEW: "SESSION_RENEW",
  /** Server -> client: this socket's session was revoked or expired; the socket is disconnected right after. */
  SESSION_REVOKED: "SESSION_REVOKED",
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export interface TableJoinPayload {
  tableId: string;
}

export interface SeatClaimPayload {
  tableId: string;
  seatIndex: number;
  buyIn: number;
  /** Client-generated UUID v4 identifying this command; a retry reuses it so the server can return the original outcome. */
  commandId?: string;
}

export interface SitTogglePayload {
  tableId: string;
  /** Client-generated UUID v4 identifying this command (see SeatClaimPayload.commandId). */
  commandId?: string;
}

export interface ActionIntentPayload {
  /** Snapshot revision the client acted on (ordering/diagnostics; staleness is judged by turnId when present). */
  revision: number;
  tableId: string;
  action: ActionType;
  /** Absolute raise-to / bet size in chips. Ignored for fold/check/call/all-in. */
  amount?: number;
  /** Client-generated UUID v4; doubles as the durable command id (a retry reuses it). */
  clientActionId: string;
  /** PublicTableState.turnId the action was chosen for. The server refuses it only if that turn is over. */
  turnId?: string;
}

export interface SessionRenewPayload {
  /** The freshly refreshed access token; must belong to the same user as the socket. */
  token: string;
}

/** Why a session ended; sent in SESSION_REVOKED just before the server disconnects the socket. */
export type SessionEndReason =
  | "LOGOUT" | "LOGOUT_ALL" | "SESSION_REVOKED" | "PASSWORD_CHANGED" | "REFRESH_REUSE" | "EXPIRED" | "ACCOUNT_RESTRICTED";

export interface SessionRevokedPayload {
  reason: SessionEndReason;
}

export interface RehydratePayload {
  tableId?: string;
}

export interface SocketErrorPayload {
  code: string;
  message: string;
  /** The table the refused request named, when it named one, so a page ignores another table's late refusal. */
  tableId?: string;
  /** True when the failure was temporary (e.g. SERVICE_UNAVAILABLE): the same request may be retried; the session is still valid. */
  retryable?: boolean;
}

/**
 * Sent to each seated player's own room (user:<id>) when their table's idle
 * warning starts or ends, so a player who kept their seat but is elsewhere
 * in the app (e.g. the lobby) still gets the warning and can keep the table
 * open. `closingInMs`: milliseconds until closure, measured when sent; null
 * means the warning is over (someone acted). A closure itself is reported by
 * the cash-out USER_PATCH.
 */
export interface TableIdleNoticePayload {
  tableId: string;
  tableName: string;
  closingInMs: number | null;
}

export type CommandResult =
  | { ok: true; pendingLeave?: boolean; /** The command was already applied earlier (a retry of the same command id). */ duplicate?: boolean }
  | { ok: false; code: string; message: string; /** Temporary failure; retrying the same command id is safe. */ retryable?: boolean };
export type CommandAck = (result: CommandResult) => void;

export interface AuthOkPayload {
  userId: string;
  username: string;
  activeTableId: string | null;
  /**
   * The active idle-closing warning of the table this user is seated at, if one is
   * counting down right now (closingInMs measured when AUTH_OK was sent), so a
   * reconnecting or reloading player never misses it. Null or absent: no warning.
   */
  idleNotice?: TableIdleNoticePayload | null;
}

export interface PotView {
  index: number;
  amount: number;
}

export interface PublicPlayerView {
  seatIndex: number;
  userId: string;
  username: string;
  kind: PlayerKind;
  botProfile: BotProfile | null;
  stack: number;
  committedThisStreet: number;
  status: PlayerStatus;
  isDealer: boolean;
  isSb: boolean;
  isBb: boolean;
  sittingOut: boolean;
  /** The seat will be released and its chips returned after this hand. */
  pendingLeave: boolean;
  /** Seated, but dealt in only once the big blind reaches this seat. */
  waitingForBigBlind: boolean;
  /** Present only for the viewing player, or for hands tabled at showdown. */
  holeCards: [Card, Card] | null;
  /**
   * The acting seat only: total time left for this turn (base time plus any
   * personal time bank), in ms, measured when the snapshot was built. Clients
   * anchor it to their own monotonic clock on arrival; never compare it with
   * the device's wall clock. Null for every other seat.
   */
  timeBankMsRemaining: number | null;
  /** The acting seat only: base (non time-bank) time left for this turn in ms, measured like timeBankMsRemaining. */
  baseTimeMsRemaining: number | null;
  /** This player's personal time-bank pool in ms (not counting a turn in progress); null when the table has no time bank. */
  extraTimeMs: number | null;
  /** Why the player is sitting out, when they are: they chose to, timed out, were disconnected, or the table is closing. */
  sittingOutReason: SitOutReason | null;
  empty: boolean;
  avatarHue: number;
}

export type SitOutReason = "SELF" | "TIMEOUT" | "DISCONNECTED" | "CLOSING";

export interface WinnerView {
  seatIndex: number;
  amount: number;
  handName: string | null;
}

export interface LegalActionSet {
  actions: ActionType[];
  callAmount: number;
  minBet: number;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface PublicTableState {
  revision: number;
  /** Pre-deal commitments and this viewer's card openings; null between hands. */
  fairness: import("./fairness.js").PublicFairness | null;
  tableId: string;
  name: string;
  status: TableStatus;
  handNumber: number;
  phase: HandPhase;
  smallBlind: number;
  bigBlind: number;
  board: Card[];
  pots: PotView[];
  potTotal: number;
  toActSeat: number | null;
  actorLegal: LegalActionSet | null;
  players: PublicPlayerView[];
  logTail: HandHistoryLogEntry[];
  winners: WinnerView[];
  animToken: number;
  /** Base action time per turn (ms). */
  timeBankMs: number;
  /**
   * Server wall-clock deadline of the current turn. Informational only: clients
   * must render countdowns from turnRemainingMs / timeBankMsRemaining, which are
   * relative and immune to device clock skew.
   */
  turnEndsAt: string | null;
  /**
   * Identity of the current turn (hand number and turn sequence), null when no
   * one is to act. ACTION_INTENT carries it; the server refuses an action only
   * when this turn is over, not when unrelated table state changed.
   */
  turnId: string | null;
  /** Total time left for the current turn in ms, measured when the snapshot was built; null when no one is to act. */
  turnRemainingMs: number | null;
  minBuyIn: number;
  maxBuyIn: number;
  /** Ledger asset the chips at this table represent ("PLAY" for play money). */
  assetCode?: string;
  /** Asset minor units per chip, as a decimal string (BigInt-safe); "1" for play money. */
  chipUnit?: string;
  /** Rake in basis points of each pot (0 = no rake) and its cap in chips per hand. */
  rakeBps?: number;
  rakeCapChips?: number;
  /** Idle warning: ms until this table closes for inactivity, measured when the snapshot was built; null when no warning is active. */
  closingInMs: number | null;
  /** Set once the table is closing or closed; null while open. */
  closeReason: TableCloseReason | null;
}

export interface HandHistoryLogEntry {
  seq: number;
  seatIndex: number | null;
  username: string;
  text: string;
  at: string;
}

export interface UserPatchPayload {
  bankroll: number;
  /**
   * Monotonic per-user wallet revision at the time `bankroll` was read. A client
   * ignores any wallet payload whose walletVersion is not newer than the last one
   * it applied, so out-of-order deliveries can never move the balance backwards.
   */
  walletVersion?: number;
  cashOutTableId?: string;
  /**
   * Present on the cash-out patch when the cash-out was caused by the table
   * closing for inactivity (only "IDLE" is sent), so the lobby can say why
   * the chips came back. A player who leaves an emptying table already knows.
   */
  tableClosedReason?: TableCloseReason;
}

export interface ServerToClientEvents {
  [SOCKET_EVENTS.AUTH_OK]: (payload: AuthOkPayload) => void;
  [SOCKET_EVENTS.STATE_SNAPSHOT]: (payload: PublicTableState) => void;
  [SOCKET_EVENTS.HAND_HISTORY_LOG]: (payload: HandHistoryLogEntry) => void;
  [SOCKET_EVENTS.SERVER_ERROR]: (payload: SocketErrorPayload) => void;
  [SOCKET_EVENTS.USER_PATCH]: (payload: UserPatchPayload) => void;
  [SOCKET_EVENTS.TABLE_IDLE_NOTICE]: (payload: TableIdleNoticePayload) => void;
  [SOCKET_EVENTS.SESSION_REVOKED]: (payload: SessionRevokedPayload) => void;
}

export interface ClientToServerEvents {
  [SOCKET_EVENTS.TABLE_JOIN]: (payload: TableJoinPayload, ack?: CommandAck) => void;
  [SOCKET_EVENTS.TABLE_LEAVE]: (payload: TableJoinPayload, ack?: CommandAck) => void;
  [SOCKET_EVENTS.SEAT_CLAIM]: (payload: SeatClaimPayload, ack?: CommandAck) => void;
  [SOCKET_EVENTS.SIT_OUT]: (payload: SitTogglePayload, ack?: CommandAck) => void;
  [SOCKET_EVENTS.SIT_IN]: (payload: SitTogglePayload, ack?: CommandAck) => void;
  [SOCKET_EVENTS.ACTION_INTENT]: (payload: ActionIntentPayload, ack?: CommandAck) => void;
  [SOCKET_EVENTS.REHYDRATE]: (payload: RehydratePayload) => void;
  [SOCKET_EVENTS.STAND_UP]: (payload: SitTogglePayload, ack?: CommandAck) => void;
  /** "I'm still here" from the idle-closing warning; cancels the warning for a seated player. */
  [SOCKET_EVENTS.TABLE_KEEP_ALIVE]: (payload: TableJoinPayload, ack?: CommandAck) => void;
  /** Swap the socket's access token after a refresh; acked. Refused (and the socket closed) if the token names another user. */
  [SOCKET_EVENTS.SESSION_RENEW]: (payload: SessionRenewPayload, ack?: CommandAck) => void;
}

export interface SocketData {
  sessionId: string;
  token: string;
  userId: string;
  username: string;
}
