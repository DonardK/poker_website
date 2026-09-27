/**
 * Deterministic drivers for the review-fix tests.
 *
 * - Tables are driven only through the public engine API (createTable,
 *   sitDown, startHand, applyAction, applyTimeout, sitOut, sitIn, leaveSeat,
 *   completeHand). Every action is chosen from `legalActions`.
 * - `EvidenceRecorder` records what each dealt player's browser saw live,
 *   from the projection the server emits (projectTableState). It keeps
 *   the pre-deal commitments, the latest audit head, and the player's own
 *   hole cards. Only a digest of the cards reaches the verifier.
 * - `blindLedgerViolations` re-derives who owed a big blind from the audit
 *   records and the seat map at each hand start. It does not use the
 *   engine's waitingForBigBlind/missedBlind flags.
 */
import { holeCardsDigest, type Card, type HandAuditRecord, type LegalActionSet, type ObservedHandEvidence } from "@poker/shared";
import { legalActions } from "../../legal.js";
import { projectTableState } from "../../public.js";
import { applyAction, applyTimeout, createTable, leaveSeat, sitDown, sitOut } from "../../table.js";
import type { EngineIntent, EngineTable } from "../../types.js";
import { blinds, started } from "./forge.js";

export const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);

/** Strictly increasing UTC milliseconds, one second per transition. */
export class Clock {
  constructor(private now = T0) {}
  tick(): number {
    this.now += 1_000;
    return this.now;
  }
}

export const BETTING = new Set<EngineTable["phase"]>(["PREFLOP", "FLOP", "TURN", "RIVER"]);
export const isBetting = (t: EngineTable): boolean => BETTING.has(t.phase);

export function newTable(tableId: string, maxSeats: number, smallBlind = 5): EngineTable {
  return createTable({ tableId, name: `Review ${tableId}`, maxSeats, smallBlind, bigBlind: 2 * smallBlind, timeBankMs: 15_000 });
}

/** User ids and names that never tokenize to a card code. */
export function join(t: EngineTable, seat: number, userId: string, stack: number): EngineTable {
  return sitDown(t, seat, { userId, username: `Player-${userId}`, avatarHue: 0, kind: "HUMAN", botProfile: null, buyIn: stack, skipBuyInCheck: true });
}

export function passive(legal: LegalActionSet): EngineIntent {
  if (legal.actions.includes("CHECK")) return { action: "CHECK" };
  if (legal.actions.includes("CALL")) return { action: "CALL" };
  return { action: "ALL_IN" };
}

/** A decision: a legal intent, or one of the ways a player can stop acting. */
export type Move = EngineIntent | "TIMEOUT" | "SIT_OUT" | "LEAVE";
export type Chooser = (t: EngineTable, seat: number, legal: LegalActionSet, step: number) => Move;

/** Apply one decision for the player to act. */
export function move(t: EngineTable, m: Move, clock: Clock): EngineTable {
  const seat = t.toActSeat;
  if (seat === null) throw new Error("No player to act");
  const userId = t.players[seat]!.userId;
  if (m === "TIMEOUT") return applyTimeout(t, clock.tick());
  if (m === "SIT_OUT") return sitOut(t, userId, clock.tick());
  if (m === "LEAVE") return leaveSeat(t, userId, clock.tick());
  return applyAction(t, userId, m, clock.tick());
}

/** Drive the current hand to SHOWDOWN. `after` sees every intermediate state. */
export function playOut(t: EngineTable, choose: Chooser, clock: Clock, after: (t: EngineTable) => void = () => undefined): EngineTable {
  for (let step = 0; isBetting(t); step++) {
    if (step > 1_000) throw new Error("Hand did not terminate");
    const seat = t.toActSeat;
    if (seat === null) throw new Error(`No actor during ${t.phase}`);
    const legal = legalActions(t, seat);
    if (!legal) throw new Error(`Actor at seat ${seat} has no legal actions`);
    t = move(t, choose(t, seat, legal, step), clock);
    after(t);
  }
  if (t.phase !== "SHOWDOWN") throw new Error(`Hand ended in ${t.phase}`);
  return t;
}

export const checkDown: Chooser = (_t, _seat, legal) => passive(legal);
/** Everyone folds when they can: the big blind (or the last aggressor) wins uncontested. */
export const foldAround: Chooser = (_t, _seat, legal) => (legal.actions.includes("FOLD") ? { action: "FOLD" } : passive(legal));

// ---------------------------------------------------------------------------
// Live evidence, as a participant's browser records it.
// ---------------------------------------------------------------------------

interface Seen { evidence: ObservedHandEvidence; cards: [Card, Card] | null }

export class EvidenceRecorder {
  private readonly byHand = new Map<string, Map<string, Seen>>();

  /** Project the table for every dealt player, as the server emits it, and keep what each one saw. */
  capture(t: EngineTable): void {
    for (const seat of t.dealtSeats) {
      const player = t.players[seat];
      if (!player) continue;
      const view = projectTableState(t, player.userId);
      const fair = view.fairness;
      if (!fair) continue;
      const hand = this.byHand.get(fair.handId) ?? new Map<string, Seen>();
      this.byHand.set(fair.handId, hand);
      const own = view.players[seat]?.holeCards ?? null;
      hand.set(player.userId, {
        evidence: {
          tableId: view.tableId, handNumber: view.handNumber, userId: player.userId, handId: fair.handId,
          merkleRoot: fair.root, deckCommitment: fair.deckCommitment, auditSeq: fair.auditSeq, auditHead: fair.auditHead,
        },
        cards: own ? [own[0], own[1]] : (hand.get(player.userId)?.cards ?? null),
      });
    }
  }

  /** Everything the player saw live, with the hole cards reduced to their digest. */
  async observed(handId: string, userId: string): Promise<ObservedHandEvidence> {
    const seen = this.byHand.get(handId)?.get(userId);
    if (!seen || !seen.cards) throw new Error(`No live evidence for ${userId} in hand ${handId}`);
    return { ...seen.evidence, holeCardsDigest: await holeCardsDigest(handId, seen.cards) };
  }
}

// ---------------------------------------------------------------------------
// Blind ledger: who owes a big blind, derived from the audit records only.
// ---------------------------------------------------------------------------

export interface LedgerHand {
  handNumber: number;
  maxSeats: number;
  dealer: number;
  sb: number | null;
  bb: number;
  dealt: number[];
  /** userId by seat for every player seated (dealt or not) when the hand started. */
  seated: Map<number, string>;
  bigBlindBy: string;
  smallBlindBy: string | null;
}

/** Summarise a started hand from its audit record plus the seat map at that moment. */
export function ledgerHand(t: EngineTable): LedgerHand {
  const record: HandAuditRecord = t.audit!;
  const head = started(record);
  const byseat = new Map(head.seats.map((row) => [row.seatIndex, row.userId]));
  const posted = blinds(record);
  const big = posted.find((b) => b.blind === "BIG");
  const small = posted.find((b) => b.blind === "SMALL");
  if (!big || head.bbSeat === null || big.seatIndex !== head.bbSeat) throw new Error(`Hand #${record.handNumber} has no big blind at the recorded seat`);
  const seated = new Map<number, string>();
  t.players.forEach((p, seat) => { if (p) seated.set(seat, p.userId); });
  return {
    handNumber: record.handNumber, maxSeats: head.maxSeats, dealer: head.dealerSeat, sb: head.sbSeat, bb: head.bbSeat,
    dealt: [...head.dealtSeats], seated, bigBlindBy: byseat.get(big.seatIndex)!, smallBlindBy: small ? byseat.get(small.seatIndex)! : null,
  };
}

/**
 * Standard blind rule, re-derived independently of the engine:
 * - when the big blind moves from seat P to seat Q, every seated player
 *   strictly between P and Q (clockwise) has missed a big blind;
 * - when the previous big blind is not dealt into the next hand, their small
 *   blind is dead and they have missed it;
 * - a player who has missed a blind may be dealt in again only as the big
 *   blind.
 * Returns one message per violation.
 */
export function blindLedgerViolations(hands: readonly LedgerHand[], initiallyOwing: ReadonlySet<string> = new Set()): string[] {
  const owes = new Set(initiallyOwing);
  const violations: string[] = [];
  hands.forEach((hand, i) => {
    const previous = hands[i - 1];
    if (previous) {
      for (let seat = (previous.bb + 1) % hand.maxSeats; seat !== hand.bb; seat = (seat + 1) % hand.maxSeats) {
        const user = hand.seated.get(seat);
        if (user !== undefined) owes.add(user);
      }
      const formerBig = previous.seated.get(previous.bb);
      if (formerBig !== undefined && hand.seated.get(previous.bb) === formerBig && !hand.dealt.includes(previous.bb)) owes.add(formerBig);
    }
    for (const seat of hand.dealt) {
      const user = hand.seated.get(seat)!;
      if (seat === hand.bb) owes.delete(user);
      else if (owes.has(user)) violations.push(`hand #${hand.handNumber}: ${user} (seat ${seat}) was dealt in without posting the big blind it owed`);
    }
  });
  return violations;
}
