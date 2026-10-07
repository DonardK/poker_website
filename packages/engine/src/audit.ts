/**
 * Per-hand audit trail (hash-chained event log).
 *
 * COMPLIANCE NOTES (audit trail and SHA-256 immutability logging)
 * - `openHandAudit` runs after the deck is shuffled and committed and before
 *   any blind is posted or card is dealt. Its HAND_STARTED event records the
 *   UUID v4 hand id, UTC start time, seats, stacks, button, blinds, deal
 *   order, the SHA-256 deck commitment and the Merkle root.
 * - Every later state transition (blinds, the hole-card deal, each street,
 *   every player action or time-out, sit-out/leave, showdown, pot awards and
 *   settlement) is appended through `appendAudit`. Each event is hashed with
 *   its predecessor; see @poker/shared/audit for the exact preimages.
 * - `sealHandAudit` writes the UTC settlement time and the post-hand
 *   verification hash (`finalStateHash`). After that the record is read-only.
 *   Its hash becomes the next hand's `previousHandHash`, which chains the
 *   table's hands together.
 * - Events hold only information that was public when the event occurred.
 *   Hidden cards are recorded only as deck positions. Players can therefore
 *   receive the redacted record without seeing mucked or undealt cards.
 * - Regulators get `SealedHandAudit` (deck and salts). `verifySealedAudit`
 *   (in @poker/shared) recomputes card integrity: the commitments and every
 *   dealt card. `verifyHandOutcome` (here) replays the hand's result: bets,
 *   folds, showdown ranks, side pots, odd chips, payouts and final stacks.
 */
import {
  canonicalJson,
  eventPreimage,
  finalStatePreimage,
  genesisPreimage,
  HAND_AUDIT_VERSION,
  handRakeTerms,
  handStartedTermsProblem,
  holeCardPositions,
  merkleContext,
  RNG_DESCRIPTOR,
  SEALED_AUDIT_VERSION,
  turnClockResetProblem,
  type AuditCheck,
  type AuditEvent,
  type AuditEventType,
  type CanonicalObject,
  type Card,
  type CardProof,
  type HandAuditRecord,
  type ParticipantHandAudit,
  type SealedHandAudit,
} from "@poker/shared";
import { evaluate } from "./evaluate.js";
import { cardProof, merkleLevels, sha256Hex, type DeckCommitment } from "./fairness.js";
import { awardPots } from "./pots.js";
import type { EngineTable } from "./types.js";

/** Date#toISOString always renders UTC with a "Z" suffix and millisecond precision. */
const utc = (now: number): string => new Date(now).toISOString();

export function openHandAudit(table: EngineTable, fairness: DeckCommitment, now: number, handStarted: CanonicalObject): void {
  table.audit = {
    version: HAND_AUDIT_VERSION,
    handId: fairness.handId,
    tableId: table.tableId,
    handNumber: table.handNumber,
    startedAt: utc(now),
    previousHandHash: table.auditChainTip ?? null,
    rng: { ...RNG_DESCRIPTOR },
    deckCommitment: fairness.deckCommitment,
    merkleRoot: fairness.root,
    events: [],
    settledAt: null,
    finalStateHash: null,
  };
  appendAudit(table, "HAND_STARTED", handStarted, now);
}

/** Append one hash-chained event. No-op only for a legacy hand that began before auditing existed. */
export function appendAudit(table: EngineTable, type: AuditEventType, data: CanonicalObject, now: number): void {
  const record = table.audit;
  if (!record) return;
  if (record.finalStateHash !== null) throw new Error("Audit record is sealed");
  const prevHash = record.events.at(-1)?.hash ?? sha256Hex(genesisPreimage(record));
  const body = { seq: record.events.length, type, phase: table.phase, at: utc(now), data, prevHash };
  record.events.push({ ...body, hash: sha256Hex(eventPreimage(record.handId, body)) });
}

/** Write the post-hand verification hash; the record is immutable afterwards. */
export function sealHandAudit(table: EngineTable, now: number): void {
  const record = table.audit;
  if (!record) return;
  const head = record.events.at(-1);
  if (!head || head.type !== "HAND_SETTLED") throw new Error("Only a settled hand can be sealed");
  record.settledAt = utc(now);
  record.finalStateHash = sha256Hex(finalStatePreimage(record.handId, head.hash, record.events.length, record.settledAt));
  table.auditChainTip = record.finalStateHash;
}

/** Operator/regulator-only secrets for the current hand. */
export function sealedAudit(fairness: DeckCommitment): SealedHandAudit {
  return {
    version: SEALED_AUDIT_VERSION,
    handId: fairness.handId,
    deck: [...fairness.deck],
    deckSalt: fairness.deckSalt,
    merkleSalts: [...fairness.salts],
  };
}

/**
 * Deck positions a participant may open after the hand: their own two hole
 * cards, every dealt board card, and hands tabled at showdown. Mucked hands,
 * burns and undealt cards are never included.
 */
export function participantPositions(record: HandAuditRecord, viewerSeat: number): number[] {
  const started = record.events[0]?.data;
  const dealtSeats = Array.isArray(started?.dealtSeats) ? started.dealtSeats as number[] : [];
  const dealIndex = dealtSeats.indexOf(viewerSeat);
  if (dealIndex < 0) throw new Error("Viewer was not dealt into this hand");
  const positions = new Set<number>(holeCardPositions(dealIndex, dealtSeats.length));
  for (const event of record.events) {
    if (event.type === "STREET_DEALT") (event.data.positions as number[]).forEach((p) => positions.add(p));
    if (event.type === "SHOWDOWN") {
      for (const hand of event.data.shown as { seatIndex: number }[]) {
        holeCardPositions(dealtSeats.indexOf(hand.seatIndex), dealtSeats.length).forEach((p) => positions.add(p));
      }
    }
  }
  return [...positions].sort((a, b) => a - b);
}

/** Build the redacted post-hand audit for one participant from the stored record. */
export function participantAudit(record: HandAuditRecord, sealed: SealedHandAudit, viewerSeat: number): ParticipantHandAudit {
  if (record.finalStateHash === null) throw new Error("Hand is not settled");
  if (sealed.handId !== record.handId) throw new Error("Sealed record does not belong to this hand");
  const context = merkleContext(record.tableId, record.handNumber, record.handId);
  const levels = merkleLevels(context, sealed.deck, sealed.merkleSalts);
  if (levels.at(-1)![0] !== record.merkleRoot) throw new Error("Sealed deck does not match the committed Merkle root");
  const commitment: DeckCommitment = {
    handId: record.handId, context, root: record.merkleRoot, deckCommitment: record.deckCommitment,
    deckSalt: sealed.deckSalt, deck: sealed.deck, salts: sealed.merkleSalts, levels,
  };
  const proofs: CardProof[] = participantPositions(record, viewerSeat).map((index) => cardProof(commitment, index));
  return { record: structuredClone(record), viewerSeat, proofs };
}

const FOLDS: ReadonlySet<unknown> = new Set(["FOLD", "TIMEOUT_FOLD"]);

/**
 * Regulator outcome replay. It recomputes a settled hand's result from its
 * hash-chained events and the sealed deck, independently of the stored
 * outcome:
 * - chip movements: every blind and action amount against a running stack,
 *   with the recorded `stackAfter` and all-in flags checked;
 * - who folded, derived only from the recorded fold actions;
 * - every TURN_CLOCK_RESET names a seat that could be the one to act;
 * - the showdown: every remaining hand tabled from its committed deck
 *   position, and ranked with the evaluator;
 * - pots, side pots, uncalled-bet refunds, winners, odd chips and payouts,
 *   rebuilt with the settlement algorithm;
 * - (v2) the rake: recomputed from the terms recorded in HAND_STARTED, the
 *   chips contested and whether a flop was dealt, and taken from the main
 *   pot first; payouts are net of it;
 * - (v2) a voided hand: HAND_VOIDED directly before HAND_SETTLED, no
 *   showdown and no awards, and every final stack equal to its starting stack;
 * - final stacks and chip conservation (final stacks plus rake equal the
 *   hand's chips).
 *
 * The recorded SHOWDOWN, POTS_AWARDED and HAND_SETTLED data must equal the
 * replay exactly (canonical JSON). Run `verifySealedAudit` first. It proves
 * the chain, the commitments and that the sealed deck is the committed one.
 * The replay does not re-judge betting legality (minimum raises, turn
 * order); the engine enforces that when each action is accepted.
 */
export function verifyHandOutcome(record: HandAuditRecord, sealed: SealedHandAudit): AuditCheck {
  const fail = (reason: string): AuditCheck => ({ ok: false, reason });
  try {
    const events = record.events;
    const started = events[0];
    if (!started || started.type !== "HAND_STARTED") return fail("Missing HAND_STARTED");
    if (sealed.handId !== record.handId || sealed.deck.length !== 52) return fail("Sealed record does not belong to this hand");
    const dealtSeats = started.data.dealtSeats as number[];
    const seatRows = started.data.seats as { seatIndex: number; stack: number }[];
    const n = dealtSeats.length;
    const stack = new Map<number, number>();
    const committed = new Map<number, number>();
    for (const row of seatRows) {
      if (!Number.isSafeInteger(row.stack) || row.stack <= 0) return fail(`Invalid starting stack for seat ${row.seatIndex}`);
      stack.set(row.seatIndex, row.stack);
      committed.set(row.seatIndex, 0);
    }
    if (stack.size !== n || dealtSeats.some((seat) => !stack.has(seat))) return fail("Starting seats differ from the dealt seats");
    const chipTotal = [...stack.values()].reduce((sum, chips) => sum + chips, 0);
    if (started.data.chipTotal !== chipTotal) return fail("HAND_STARTED chip total differs from the starting stacks");
    const termsProblem = handStartedTermsProblem(record);
    if (termsProblem !== null) return fail(termsProblem);
    const v2 = record.version === HAND_AUDIT_VERSION;
    const startStacks = dealtSeats.map((seat) => ({ seatIndex: seat, stack: stack.get(seat)! }));

    const folded = new Set<number>();
    const board: Card[] = [];
    let showdown: AuditEvent | null = null;
    let awards: AuditEvent | null = null;
    let voided: AuditEvent | null = null;
    for (const event of events) {
      if (event.type === "BLIND_POSTED" || event.type === "PLAYER_ACTION") {
        if (awards || voided) return fail("Chips moved after the pots were awarded");
        const seat = event.data.seatIndex as number;
        const amount = event.data.amount;
        const before = stack.get(seat);
        if (before === undefined) return fail(`${event.type} for a seat that was not dealt in`);
        if (folded.has(seat)) return fail(`Seat ${seat} acted after folding`);
        if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 || amount > before) return fail(`Invalid amount for seat ${seat} at event ${event.seq}`);
        const after = before - amount;
        stack.set(seat, after);
        committed.set(seat, committed.get(seat)! + amount);
        if (event.type === "BLIND_POSTED" && event.data.allIn !== (after === 0)) return fail(`Blind all-in flag is wrong at event ${event.seq}`);
        if (event.type === "PLAYER_ACTION") {
          if (event.data.stackAfter !== after) return fail(`Recorded stack differs from the replay at event ${event.seq}`);
          if (FOLDS.has(event.data.action)) folded.add(seat);
        }
      } else if (event.type === "TURN_CLOCK_RESET") {
        // Moves no chips, but it must name the player who was really to act:
        // dealt in, not folded and not all-in, before the hand was decided.
        if (showdown || awards) return fail(`TURN_CLOCK_RESET after the hand was decided at event ${event.seq}`);
        const problem = turnClockResetProblem(event, dealtSeats, folded);
        if (problem !== null) return fail(problem);
        if (stack.get(event.data.seatIndex as number) === 0) return fail(`TURN_CLOCK_RESET at event ${event.seq} names an all-in seat`);
      } else if (event.type === "STREET_DEALT") {
        board.push(...(event.data.cards as Card[]));
      } else if (event.type === "SHOWDOWN") {
        if (showdown) return fail("More than one SHOWDOWN event");
        showdown = event;
      } else if (event.type === "POTS_AWARDED") {
        if (awards) return fail("More than one POTS_AWARDED event");
        awards = event;
      } else if (event.type === "HAND_VOIDED") {
        if (!v2 || voided) return fail("Unexpected HAND_VOIDED event");
        voided = event;
      }
    }
    const settled = events.at(-1)!;
    if (voided) {
      // Staff void: nothing shown, nothing awarded, every committed chip back with its owner.
      if (settled.type !== "HAND_SETTLED" || events.at(-2) !== voided) return fail("A voided hand ends with HAND_VOIDED then HAND_SETTLED");
      if (showdown || awards) return fail("A voided hand has no showdown and no awards");
      const restored = dealtSeats.map((seat) => ({ seatIndex: seat, stack: stack.get(seat)! + committed.get(seat)! }));
      if (canonicalJson(restored) !== canonicalJson(startStacks)) return fail("Chips were not conserved");
      const expectedVoid = { reason: "void", board, stacks: startStacks, chipTotal };
      if (canonicalJson(expectedVoid) !== canonicalJson(settled.data)) return fail("Void settlement differs from a replay of the hand");
      return { ok: true };
    }
    if (settled.type !== "HAND_SETTLED" || !awards || events.at(-2) !== awards) return fail("A settled hand ends with POTS_AWARDED then HAND_SETTLED");

    const contenders = dealtSeats.filter((seat) => !folded.has(seat));
    const reason = contenders.length <= 1 ? "fold" : "showdown";
    const holeCards: Record<number, [Card, Card]> = {};
    dealtSeats.forEach((seat, i) => {
      const [a, b] = holeCardPositions(i, n);
      holeCards[seat] = [sealed.deck[a]!, sealed.deck[b]!];
    });

    if (reason === "showdown") {
      if (board.length !== 5) return fail("Showdown without a complete board");
      if (!showdown || events.indexOf(showdown) !== events.length - 3) return fail("SHOWDOWN must directly precede POTS_AWARDED");
      const expectedShowdown = {
        shown: contenders.map((seat) => {
          const hand = evaluate([...holeCards[seat]!, ...board]);
          return {
            seatIndex: seat, cards: [...holeCards[seat]!], positions: holeCardPositions(dealtSeats.indexOf(seat), n),
            category: hand.category, rankValue: hand.rankValue, handName: hand.name, bestFive: [...hand.bestFive],
          };
        }),
      };
      if (canonicalJson(expectedShowdown) !== canonicalJson(showdown.data)) return fail("Showdown hands or rankings differ from the committed cards");
    } else if (showdown) {
      return fail("A hand won by folds cannot have a showdown");
    }

    // Settlement lists contributions in seat order, as the engine does.
    const bySeat = [...dealtSeats].sort((a, b) => a - b);
    const awarded = awardPots({
      contribs: bySeat.filter((seat) => committed.get(seat)! > 0).map((seat) => ({ seatIndex: seat, committed: committed.get(seat)!, folded: folded.has(seat) })),
      holeCards,
      board,
      dealerSeat: started.data.dealerSeat as number,
      maxSeats: started.data.maxSeats as number,
      rake: handRakeTerms(record),
    });
    const expectedAwards = {
      pots: awarded.pots.map((p) => ({
        potIndex: p.potIndex, amount: p.amount, eligibleSeatIndexes: [...p.eligibleSeatIndexes],
        winnerSeatIndexes: [...p.winnerSeatIndexes], oddChipSeatIndex: p.oddChipSeatIndex,
      })),
      refunds: [...awarded.returned].map(([seatIndex, amount]) => ({ seatIndex, amount })),
      payouts: [...awarded.payouts].sort(([a], [b]) => a - b).map(([seatIndex, amount]) => ({ seatIndex, amount })),
      // v1 has no rake field (every v1 hand was unraked: handRakeTerms gives NO_RAKE).
      ...(v2 ? { rake: { total: awarded.rake.total, perPot: awarded.rake.perPot } } : {}),
    };
    if (canonicalJson(expectedAwards) !== canonicalJson(awards.data)) return fail("Pot awards differ from a replay of the hand");

    const stacks = dealtSeats.map((seat) => ({ seatIndex: seat, stack: stack.get(seat)! + (awarded.payouts.get(seat) ?? 0) }));
    const finalTotal = stacks.reduce((sum, row) => sum + row.stack, 0) + awarded.rake.total;
    if (finalTotal !== chipTotal) return fail("Chips were not conserved");
    const expectedSettled = { reason, board, stacks, chipTotal };
    if (canonicalJson(expectedSettled) !== canonicalJson(settled.data)) return fail("Settlement differs from a replay of the hand");
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Malformed hand record");
  }
}
