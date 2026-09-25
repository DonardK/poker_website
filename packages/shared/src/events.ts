import type { ActionType, BotProfile, HandPhase, PlayerKind, PlayerStatus, TableStatus } from "./constants.js";
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
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  HAND_HISTORY_LOG: "HAND_HISTORY_LOG",
  SERVER_ERROR: "SERVER_ERROR",
  AUTH_OK: "AUTH_OK",
  USER_PATCH: "USER_PATCH",
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export interface TableJoinPayload {
  tableId: string;
}

export interface SeatClaimPayload {
  tableId: string;
  seatIndex: number;
  buyIn: number;
}

export interface SitTogglePayload {
  tableId: string;
}

export interface ActionIntentPayload {
  revision: number;
  tableId: string;
  action: ActionType;
  /** Absolute raise-to / bet size in chips. Ignored for fold/check/call/all-in. */
  amount?: number;
  clientActionId: string;
}

export interface RehydratePayload {
  tableId?: string;
}

export interface SocketErrorPayload {
  code: string;
  message: string;
}

export interface AuthOkPayload {
  userId: string;
  username: string;
  activeTableId: string | null;
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
  /** Present only for the viewing player, or for hands tabled at showdown. */
  holeCards: [Card, Card] | null;
  timeBankMsRemaining: number | null;
  empty: boolean;
  avatarHue: number;
}

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
  timeBankMs: number;
  turnEndsAt: string | null;
  minBuyIn: number;
  maxBuyIn: number;
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
}

export interface ServerToClientEvents {
  [SOCKET_EVENTS.AUTH_OK]: (payload: AuthOkPayload) => void;
  [SOCKET_EVENTS.STATE_SNAPSHOT]: (payload: PublicTableState) => void;
  [SOCKET_EVENTS.HAND_HISTORY_LOG]: (payload: HandHistoryLogEntry) => void;
  [SOCKET_EVENTS.SERVER_ERROR]: (payload: SocketErrorPayload) => void;
  [SOCKET_EVENTS.USER_PATCH]: (payload: UserPatchPayload) => void;
}

export interface ClientToServerEvents {
  [SOCKET_EVENTS.TABLE_JOIN]: (payload: TableJoinPayload) => void;
  [SOCKET_EVENTS.TABLE_LEAVE]: (payload: TableJoinPayload) => void;
  [SOCKET_EVENTS.SEAT_CLAIM]: (payload: SeatClaimPayload) => void;
  [SOCKET_EVENTS.SIT_OUT]: (payload: SitTogglePayload) => void;
  [SOCKET_EVENTS.SIT_IN]: (payload: SitTogglePayload) => void;
  [SOCKET_EVENTS.ACTION_INTENT]: (payload: ActionIntentPayload) => void;
  [SOCKET_EVENTS.REHYDRATE]: (payload: RehydratePayload) => void;
  [SOCKET_EVENTS.STAND_UP]: (payload: SitTogglePayload) => void;
}

export interface SocketData {
  sessionId: string;
  token: string;
  userId: string;
  username: string;
}
