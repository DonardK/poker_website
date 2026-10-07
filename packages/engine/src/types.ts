import type {
  ActionType,
  BotProfile,
  Card,
  HandHistoryLogEntry,
  HandPhase,
  PlayerKind,
  PlayerStatus,
  SitOutReason,
  TableCloseReason,
  TableStatus,
} from "@poker/shared";
import type { EvaluatedHand, HandAuditRecord, SealedHandAudit } from "@poker/shared";
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
  /**
   * Why `sittingOut` is set: SELF (their own sit-out or leave), TIMEOUT (their
   * turn timed out; see EngineTable.sitOutOnTimeout), DISCONNECTED (set by the
   * server) or CLOSING (closeTable). Null while sitting in, and for a legacy
   * player saved sitting out before reasons were recorded (reason unknown).
   */
  sittingOutReason: SitOutReason | null;
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
  /**
   * This player's last voluntary activity (ms epoch): taking the seat, then
   * whatever the server records for them (see EngineTable.lastActivityAt).
   * The idle clock runs from the latest of these among the humans still at
   * the table (idleSince), so a player who acts and then leaves no longer
   * keeps everyone else's AFK table open.
   */
  lastActivityAt: number;
  /**
   * Personal time bank pool (ms): extra thinking time used once the base
   * turn time (EngineTable.timeBankMs) has run out. Always 0 when the table
   * has no time bank (EngineTable.extraTimeBank null).
   */
  extraTimeMs: number;
  /** Hands dealt to this player since their pool was last refilled (see ExtraTimeBankConfig.refillEveryHands). */
  handsSinceRefill: number;
}

/**
 * Personal time bank settings. Every player starts with `initialMs`, gains
 * `refillMs` each time they have been dealt `refillEveryHands` hands, and
 * never holds more than `maxMs`. Integers, in ms.
 */
export interface ExtraTimeBankConfig {
  initialMs: number;
  maxMs: number;
  refillMs: number;
  refillEveryHands: number;
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
  /** Base time per turn (ms). */
  timeBankMs: number;
  /** Personal time bank settings, or null when the table has none (each turn is then exactly timeBankMs). */
  extraTimeBank: ExtraTimeBankConfig | null;
  /**
   * A human whose turn times out is sat out (sittingOutReason TIMEOUT): the
   * sat-out cascade acts for them for the rest of the hand and they are not
   * dealt in again until they sit in. Bots are never sat out this way.
   */
  sitOutOnTimeout: boolean;
  /**
   * Rake terms for hands dealt from now on (see RakeTerms in @poker/shared):
   * basis points of the chips contested (0..1000), the cap in chips per hand
   * (0 = no rake), and "no flop, no drop". startHand records them in the
   * hand's HAND_STARTED event, and settlement uses the recorded terms, so a
   * change between hands never reaches a hand already dealt.
   */
  rakeBps: number;
  rakeCapChips: number;
  rakeNoFlopNoDrop: boolean;
  /**
   * Chips raked from the hand settled last (0 when none, and between hands).
   * The server persists it as Hand.rake and posts it to the ledger once per
   * hand; it is no longer in any stack, so Σ stacks + rakeTaken = handChipTotal.
   */
  rakeTaken: number;
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
  /** When the current actor's turn (base clock) started, ms epoch; null when no one is to act. */
  turnStartedAt: number | null;
  /**
   * Bumped every time a turn starts (a new actor, a new street, a clock
   * rebase). With handNumber it identifies the turn (turnIdOf), so the server
   * can refuse an action chosen for a turn that is over without refusing it
   * for unrelated table changes. Never reset, never decreases.
   */
  turnSeq: number;
  winners: { seatIndex: number; amount: number; handName: string | null }[];
  animToken: number;
  /** Stacks to return to bankrolls after a player is removed from the table. */
  cashOuts: { userId: string; stack: number }[];
  /**
   * Last voluntary player activity (ms epoch): table creation, taking a seat,
   * a player's own betting action, a sit-out/sit-in that changes state, or
   * "I'm still here". Time-outs, bot actions, dealing, blinds, leaving and
   * spectators never count, so AFK players cannot keep a table alive.
   * While humans are seated the idle clock runs from their own
   * EnginePlayer.lastActivityAt instead (see idleSince); this is the clock
   * of a table with none.
   */
  lastActivityAt: number;
  /** Idle warning deadline (ms epoch). While set, no new hand is dealt; the table closes then unless someone acts. */
  closingAt: number | null;
  /** Set when closure begins; the table is CLOSED once it is empty. Closure cannot be undone. */
  closeReason: TableCloseReason | null;
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
  /** Creation time (ms epoch); the idle clock starts here. Defaults to now. */
  createdAt?: number;
  /** Sit a human out when their turn times out (default true). See EngineTable.sitOutOnTimeout. */
  sitOutOnTimeout?: boolean;
  /** Personal time bank; omitted or null disables it. */
  extraTimeBank?: ExtraTimeBankConfig | null;
  /** Rake in basis points of the chips contested, integer 0..1000 (default 0). */
  rakeBps?: number;
  /** Most chips raked from one hand, integer >= 0 (default 0, which means no rake). */
  rakeCapChips?: number;
  /** No rake unless a flop is dealt (default true). */
  rakeNoFlopNoDrop?: boolean;
}

/**
 * Result of voidHand: the table after Hand Clean-up, plus the voided hand's
 * sealed audit record and its card secrets. The server must persist both
 * (the next hand's previousHandHash chains to this record), exactly as it
 * persists a settled hand before Clean-up.
 */
export interface VoidedHand {
  table: EngineTable;
  handNumber: number;
  /** Sealed record ending HAND_VOIDED, HAND_SETTLED {reason: "void"}; null only for a legacy hand without an audit trail. */
  record: HandAuditRecord | null;
  sealed: SealedHandAudit | null;
  /** Chips returned to each dealt seat (its whole contribution to the hand), in deal order. */
  returned: { seatIndex: number; userId: string; amount: number }[];
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
