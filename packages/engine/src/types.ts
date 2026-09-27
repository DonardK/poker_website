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
import type { EvaluatedHand, HandAuditRecord } from "@poker/shared";
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
  /**
   * Seated and ready, but dealt in only when the big blind reaches this seat
   * (standard rule for newcomers and for players returning after missing
   * blinds). This prevents joining in position or dodging blinds.
   */
  waitingForBigBlind: boolean;
  /** The blinds passed this seat while it was sitting out; it waits for the big blind on return. */
  missedBlind: boolean;
}

/**
 * Authoritative server-side table state.
 *
 * COMPLIANCE NOTE (state isolation): this object holds secrets: `deck`,
 * `burns`, `fairness` (deck order and salts) and every player's
 * `holeCards`. It exists only in server memory. At rest it is encrypted with
 * AES-256-GCM. It must never be serialized to a client. The only client
 * projection is `toPublicTableState` / `projectTableState` in public.ts,
 * which copies an allow-list of fields per viewer and is checked by
 * `assertViewerStateSafe` before every emission.
 */
export interface EngineTable {
  revision: number;
  /** Pre-deal commitments for the current hand; null between hands. */
  fairness: DeckCommitment | null;
  /** Hash-chained audit record for the current hand; null between hands. */
  audit: HandAuditRecord | null;
  /** finalStateHash of the previous audited hand at this table. */
  auditChainTip: string | null;
  /** Sum of dealt players' stacks at hand start (chip-conservation invariant). */
  handChipTotal: number | null;
  /** Seats dealt into the current hand, in deal order (first card left of the button). */
  dealtSeats: number[];
  /**
   * Seat where the small blind was due this hand, even if nobody posted it
   * (dead small blind). The next hand's button goes here (dead-button rule).
   */
  smallBlindPosition: number | null;
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
