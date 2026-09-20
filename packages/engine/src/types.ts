import type {
  ActionType,
  BotProfile,
  Card,
  HandHistoryLogEntry,
  HandPhase,
  PlayerKind,
  PlayerStatus,
  TableStatus,
} from "@poker/shared";
import type { EvaluatedHand } from "@poker/shared";
import type { BuiltPot } from "./pots.js";
import type { DeckCommitment } from "./fairness.js";

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EnginePlayer {
  seatIndex: number;
  userId: string;
  username: string;
  avatarHue: number;
  kind: PlayerKind;
  botProfile: BotProfile | null;
  stack: number;
  holeCards: [Card, Card] | null;
  status: PlayerStatus;
  committedThisStreet: number;
  committedThisHand: number;
  sittingOut: boolean;
  showedCards: boolean;
  handResult: EvaluatedHand | null;
  /** Fold now, cash out remaining stack when the hand ends. */
  pendingLeave: boolean;
}

export interface EngineTable {
  revision: number;
  fairness: DeckCommitment | null;
  dealtSeats: number[];
  lastActedBet: (number | null)[];
  actions: { seq: number; seatIndex: number; street: HandPhase; action: ActionType | "POST_SB" | "POST_BB" | "TIMEOUT_CHECK" | "TIMEOUT_FOLD"; amount: number; toAmount: number; at: string }[];
  awards: import("@poker/shared").PotShare[];
  refunds: { seatIndex: number; amount: number }[];
  startedAt: number | null;
  settledAt: number | null;
  tableId: string;
  name: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  timeBankMs: number;
  status: TableStatus;
  handNumber: number;
  phase: HandPhase;
  dealerSeat: number;
  sbSeat: number | null;
  bbSeat: number | null;
  deck: Card[];
  burns: Card[];
  board: Card[];
  players: (EnginePlayer | null)[];
  toActSeat: number | null;
  currentBet: number;
  lastFullRaiseSize: number;
  lastAggressorSeat: number | null;
  actedThisStreet: boolean[];
  pots: BuiltPot[];
  potTotal: number;
  log: HandHistoryLogEntry[];
  logSeq: number;
  turnStartedAt: number | null;
  winners: { seatIndex: number; amount: number; handName: string | null }[];
  animToken: number;
  /** Stacks to return to bankrolls after a player is removed from the table. */
  cashOuts: { userId: string; stack: number }[];
}

export interface EngineIntent {
  action: ActionType;
  amount?: number;
}

export interface CreateTableConfig {
  tableId: string;
  name: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  timeBankMs: number;
}

export interface SeatPlayerConfig {
  userId: string;
  username: string;
  avatarHue: number;
  kind: PlayerKind;
  botProfile: BotProfile | null;
  buyIn: number;
  skipBuyInCheck?: boolean;
}
