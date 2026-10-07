/**
 * Adversarial review: executable proof of the engine and shared fixes.
 *
 * 1. verifyParticipantAudit rejects a record that the operator re-sealed
 *    with valid hashes but that is semantically false. Examples: a deck that
 *    shows a card twice, a malformed or dishonest SHOWDOWN, a tabled
 *    folded hand, fields outside the hashed schema, unknown event types or
 *    phases, a record for another table, hand or user, and hole cards that
 *    differ from the ones dealt live. It accepts real hands of every ending.
 * 2. verifySealedAudit (card integrity) accepts real hands and rejects deck
 *    and salt tampering, including a deck recommitted after the deal.
 * 3. verifyHandOutcome accepts 1,000+ real hands (scripted, then random),
 *    and rejects re-sealed forgeries of the result: winners, payouts, odd
 *    chips, refunds, stacks, chip totals, bet amounts, hand ranks, and the
 *    showdown/award structure.
 * 4. Rules: wait-for-big-blind for newcomers and returning players (no
 *    blind dodging), the dead-button rule, heads-up transitions, leavers
 *    folding on their turn with the stranded-pot guard, sit-out and time-out
 *    recorded truthfully, and sit-out/sit-in/leave no-ops.
 * 5. upgradeTableState on state saved by the previous engine version.
 * 6. The leak guard's exact client-schema allow-list.
 *
 * HOW FORGERIES ARE BUILT. Each forgery starts from a real settled hand.
 * helpers/forge.ts re-seals it with the shared preimage functions and
 * node:crypto SHA-256: it recomputes every event hash and link, the post-hand
 * verification hash and, when a deck is substituted, both deck commitments.
 * Each re-sealed forgery is first shown to pass verifyAuditRecord, so the
 * rejection comes from the semantic check under test. Each test also matches
 * the reason string that names that check. The exceptions are the checks
 * that live in verifyAuditRecord itself (unknown event type or phase,
 * HAND_STARTED position): those tests expect verifyAuditRecord to fail.
 * Unhashed extra fields need no re-seal, because they change no hash.
 *
 * FALSE-FAILURE BUDGET. No API accepts a chosen deck, so cards come from the
 * engine's CSPRNG. The rules tests fold around or check down, so they do not
 * depend on the cards. Coverage of the sweep comes from scripted hands.
 * Only two searches depend on the cards, and both are bounded:
 * - a split pot with an odd chip: measured at 9.2% of 9-handed hands (SB
 *   folds, 8 check down) over 2,000 deals. With a bound of 5%, 300 tries
 *   all fail with probability 0.95^300 < 3e-7;
 * - a showdown pot with one winner and a losing eligible hand: a 4-way
 *   check-down fails this only when its single pot is split, which happens
 *   in well under 50% of such hands. The chance that 60 tries all fail is
 *   below 0.5^60 < 1e-18.
 */
import {
  boardPositions,
  holeCardPositions,
  holeCardsDigest,
  verifyAuditRecord,
  verifyParticipantAudit,
  verifySealedAudit,
  verifyTableCards,
  verifyTableChainLink,
  type AuditCheck,
  type AuditEvent,
  type Card,
  type HandAuditRecord,
  type ParticipantHandAudit,
  type PublicTableState,
  type SealedHandAudit,
} from "@poker/shared";
import { participantAudit, sealedAudit, verifyHandOutcome } from "../audit.js";
import { shuffle } from "../deck.js";
import { evaluate } from "../evaluate.js";
import { legalActions } from "../legal.js";
import { assertViewerStateSafe, projectTableState } from "../public.js";
import { completeHand, leaveSeat, sitIn, sitOut, startHand, upgradeTableState } from "../table.js";
import { EngineError, type EngineTable } from "../types.js";
import {
  blindLedgerViolations,
  checkDown,
  Clock,
  EvidenceRecorder,
  foldAround,
  join,
  ledgerHand,
  move,
  newTable,
  passive,
  playOut,
  T0,
  type Chooser,
  type LedgerHand,
} from "./helpers/drive.js";
import {
  actions,
  awards,
  blinds,
  clone,
  dataOf,
  eventsOf,
  forge,
  moveChips,
  recommit,
  settled,
  started,
  type ActionData,
  type BlindData,
  type ShowdownData,
  type ShownHand,
  type StreetData,
} from "./helpers/forge.js";
import { pick, randInt, STREETS, TableSim, type Style } from "./helpers/simulate.js";

// ---------------------------------------------------------------------------
// Real settled hands
// ---------------------------------------------------------------------------

interface Hand {
  label: string;
  /** The table at the moment of settlement (SHOWDOWN), before Hand Clean-up. */
  table: EngineTable;
  record: HandAuditRecord;
  sealed: SealedHandAudit;
}

/** Keeps each settled hand once, and (optionally) what every dealt player saw live. */
class HandCollector {
  readonly hands: Hand[] = [];
  label = "";
  private readonly seen = new Set<string>();
  constructor(readonly evidence: EvidenceRecorder | null) {}

  readonly observe = (sim: TableSim): void => this.add(sim.table);

  add(t: EngineTable): void {
    this.evidence?.capture(t);
    const record = t.audit;
    if (t.phase !== "SHOWDOWN" || !record || record.finalStateHash === null || this.seen.has(record.handId)) return;
    this.seen.add(record.handId);
    this.hands.push({ label: this.label, table: t, record: clone(record), sealed: sealedAudit(t.fairness!) });
  }
}

let serial = 0;
/** One deterministic hand at a fresh table: seats [seat, stack], decisions from `choose`. */
function scripted(label: string, maxSeats: number, seats: readonly (readonly [number, number])[], choose: Chooser,
  collector: HandCollector = new HandCollector(null)): Hand {
  const clock = new Clock();
  const id = `rv-${label}-${++serial}`;
  let t = newTable(id, maxSeats);
  for (const [seat, stack] of seats) t = join(t, seat, `${id}-u${seat}`, stack);
  collector.label = label;
  t = startHand(t, clock.tick());
  collector.add(t);
  playOut(t, choose, clock, (s) => collector.add(s));
  return collector.hands.at(-1)!;
}

/** Check/call to `street`; there the first actor bets or raises the minimum and everyone else folds. */
function foldOn(street: EngineTable["phase"]): Chooser {
  let opened = false;
  return (t, _seat, legal) => {
    if (!opened && t.phase !== street) return passive(legal);
    if (!opened) {
      opened = true;
      if (legal.actions.includes("BET")) return { action: "BET", amount: legal.minBet };
      if (legal.actions.includes("RAISE")) return { action: "RAISE", amount: legal.minRaiseTo };
      return passive(legal);
    }
    return legal.actions.includes("FOLD") ? { action: "FOLD" } : passive(legal);
  };
}
/**
 * A (100) is all-in short; B and C (1,000 each) put in 300 each, so a 400-chip
 * side pot belongs to B and C only. On the turn B leaves on its own turn,
 * with a free check. With `cLeaves`, C has already left, off turn.
 */
function strandedPotHand(cLeaves: boolean): EngineTable {
  const clock = new Clock();
  let t = newTable(`rv-strand-${cLeaves ? "both" : "one"}-${++serial}`, 6);
  t = join(t, 0, "rv-strand-a", 100);
  t = join(t, 1, "rv-strand-b", 1_000);
  t = join(t, 2, "rv-strand-c", 1_000);
  t = startHand(t, clock.tick()); // button 0 (A acts first), blinds B/C
  t = move(t, { action: "ALL_IN" }, clock); // A: 100
  t = move(t, { action: "CALL" }, clock); // B
  t = move(t, { action: "CALL" }, clock); // C
  t = move(t, { action: "BET", amount: 200 }, clock); // flop: B bets, C calls
  t = move(t, { action: "CALL" }, clock);
  if (t.phase !== "TURN" || t.toActSeat !== 1 || !legalActions(t, 1)!.actions.includes("CHECK")) throw new Error("Stranded-pot setup did not reach B's free turn check");
  if (cLeaves) t = leaveSeat(t, "rv-strand-c", clock.tick());
  return leaveSeat(t, "rv-strand-b", clock.tick());
}

/** The first actor folds; everyone else checks or calls to showdown. */
const firstFoldsRestCheck: Chooser = (_t, _seat, legal, step) => (step === 0 && legal.actions.includes("FOLD") ? { action: "FOLD" } : passive(legal));
const shoveAll: Chooser = (_t, _seat, legal) => (legal.actions.includes("ALL_IN") ? { action: "ALL_IN" } : passive(legal));

/**
 * Insert a SHOWDOWN event just before POTS_AWARDED that tables `seats` with
 * their real cards and correct rankings.
 */
function insertShowdown(r: HandAuditRecord, hand: Hand, seats: readonly number[]): void {
  const dealt = started(r).dealtSeats;
  const shown: ShownHand[] = seats.map((seat) => {
    const positions = holeCardPositions(dealt.indexOf(seat), dealt.length);
    const cards: [Card, Card] = [hand.sealed.deck[positions[0]]!, hand.sealed.deck[positions[1]]!];
    const best = evaluate([...cards, ...settled(r).board]);
    return { seatIndex: seat, cards, positions, category: best.category, rankValue: best.rankValue, handName: best.name, bestFive: [...best.bestFive] };
  });
  const at = r.events.findIndex((e) => e.type === "POTS_AWARDED");
  r.events.splice(at, 0, { ...clone(r.events[at]!), type: "SHOWDOWN", phase: "SHOWDOWN", data: { shown } as unknown as AuditEvent["data"] });
}

const seatsOf = (record: HandAuditRecord): number[] => started(record).dealtSeats;
const userAt = (record: HandAuditRecord, seat: number): string => started(record).seats.find((row) => row.seatIndex === seat)!.userId;
const showdownOf = (record: HandAuditRecord): ShowdownData => dataOf<ShowdownData>(record, "SHOWDOWN");
const streetEvent = (record: HandAuditRecord, street: StreetData["street"]): AuditEvent =>
  eventsOf(record, "STREET_DEALT").find((e) => (e.data as unknown as StreetData).street === street)!;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const toParticipant = (hand: Hand, seat: number): ParticipantHandAudit => json(participantAudit(hand.record, hand.sealed, seat));

function check(condition: unknown, message: () => string): asserts condition {
  if (!condition) throw new Error(message());
}

function expectRejected(result: AuditCheck, reason: RegExp): void {
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(reason);
}

async function expectChainIntact(record: HandAuditRecord): Promise<void> {
  expect(await verifyAuditRecord(record, { requireSettled: true })).toEqual({ ok: true });
}

const SPREAD_SEATS = [0, 2, 4, 6, 8, 1, 3, 5, 7];
const SIDE_POT_STACKS: readonly (readonly number[])[] = [[150, 400, 900], [60, 150, 400, 900, 2_000], [3, 35, 120, 500, 500, 1_500, 7]];

/** Real hands of every ending, with what each dealt player saw live. */
async function endingsCorpus(): Promise<HandCollector> {
  const collector = new HandCollector(new EvidenceRecorder());
  let tables = 0;
  const newSim = (maxSeats: number): TableSim =>
    new TableSim({ tableId: `rv-endings-t${++tables}`, name: `Endings ${tables}`, maxSeats, smallBlind: 5 }, collector.observe);
  for (const players of [2, 3, 6, 9]) {
    const sim = newSim(9);
    for (const seat of SPREAD_SEATS.slice(0, players)) await sim.seat(seat, 10_000);
    for (const street of STREETS) {
      collector.label = `fold on ${street}, ${players} players`;
      await sim.playHand({ kind: "foldOn", street });
    }
    collector.label = `showdown, ${players} players`;
    await sim.playHand({ kind: "checkdown" });
    collector.label = `all-in runout, ${players} players`;
    await sim.playHand({ kind: "shove" });
  }
  for (const stacks of SIDE_POT_STACKS) {
    const sim = newSim(9);
    for (const [i, stack] of stacks.entries()) await sim.seat(SPREAD_SEATS[i]!, stack);
    collector.label = `side pots ${stacks.join("/")}`;
    await sim.playHand({ kind: "shove" });
  }
  const sim = newSim(7);
  for (let seat = 0; seat < 6; seat++) await sim.seat(seat, 2_000);
  collector.label = "time-out, sit-out on turn, leave off turn";
  await sim.playHand({ kind: "events" });
  collector.label = "showdown after events";
  await sim.playHand({ kind: "checkdown" });
  return collector;
}

interface Shape { reason: "fold" | "showdown"; board: number; runout: boolean; pots: number; timeout: boolean; sitOut: boolean; leave: boolean }
function shapeOf(record: HandAuditRecord): Shape {
  const acts = actions(record);
  return {
    reason: settled(record).reason,
    board: settled(record).board.length,
    runout: eventsOf(record, "STREET_DEALT").some((e) => (e.data as unknown as StreetData).runout),
    pots: awards(record).pots.length,
    timeout: acts.some((a) => a.timeout),
    sitOut: acts.some((a) => a.auto === "SIT_OUT"),
    leave: acts.some((a) => a.auto === "LEAVE"),
  };
}

// ===========================================================================
// 1. Participant verifier hardening
// ===========================================================================

describe("1. verifyParticipantAudit hardening", () => {
  let corpus: HandCollector;
  const fixtures = {} as {
    showdown: Hand; foldRiver: Hand; folded: Hand;
    tableA: Hand; tableB: Hand; tableAHand2: Hand; evidence: EvidenceRecorder;
  };

  beforeAll(async () => {
    corpus = await endingsCorpus();
    fixtures.evidence = new EvidenceRecorder();
    const withEvidence = new HandCollector(fixtures.evidence);
    fixtures.showdown = scripted("showdown", 9, SPREAD_SEATS.slice(0, 6).map((seat) => [seat, 5_000] as const), checkDown, withEvidence);
    fixtures.foldRiver = scripted("fold-river", 6, [0, 1, 2, 3, 4].map((seat) => [seat, 5_000] as const), foldOn("RIVER"), withEvidence);
    fixtures.folded = scripted("folded", 6, [0, 1, 2, 3].map((seat) => [seat, 5_000] as const), firstFoldsRestCheck, withEvidence);

    // Two tables where the same user sits in seat 0, and two hands at the first table.
    const clock = new Clock();
    const hands: Hand[] = [];
    for (const tableId of ["rv-bind-a", "rv-bind-b"]) {
      let t = newTable(tableId, 6);
      t = join(t, 0, "rv-alice", 2_000);
      t = join(t, 1, "rv-bob", 2_000);
      t = join(t, 2, `${tableId}-carol`, 2_000);
      const rounds = tableId === "rv-bind-a" ? 2 : 1;
      for (let i = 0; i < rounds; i++) {
        t = startHand(t, clock.tick());
        withEvidence.add(t);
        t = playOut(t, checkDown, clock, (s) => withEvidence.add(s));
        hands.push(withEvidence.hands.at(-1)!);
        t = completeHand(t);
      }
    }
    [fixtures.tableA, fixtures.tableAHand2, fixtures.tableB] = [hands[0]!, hands[1]!, hands[2]!];
  }, 300_000);

  it("accepts every participant of real hands of every ending: folds on each street, showdowns, runouts, side pots, time-outs, sit-outs, leaves", async () => {
    const shapes = corpus.hands.map((hand) => shapeOf(hand.record));
    for (const board of [0, 3, 4, 5]) expect(shapes.some((s) => s.reason === "fold" && s.board === board)).toBe(true);
    expect(shapes.some((s) => s.reason === "showdown" && !s.runout)).toBe(true);
    expect(shapes.some((s) => s.reason === "showdown" && s.runout)).toBe(true);
    expect(shapes.some((s) => s.pots >= 3)).toBe(true);
    expect(shapes.some((s) => s.timeout)).toBe(true);
    expect(shapes.some((s) => s.sitOut)).toBe(true);
    expect(shapes.some((s) => s.leave)).toBe(true);

    let verified = 0;
    for (const hand of corpus.hands) {
      for (const seat of seatsOf(hand.record)) {
        const observed = await corpus.evidence!.observed(hand.record.handId, userAt(hand.record, seat));
        const result = await verifyParticipantAudit(toParticipant(hand, seat), observed);
        check(result.ok, () => `${hand.label}, seat ${seat}: ${result.reason}`);
        verified++;
      }
    }
    expect(verified).toBeGreaterThan(100);
  }, 120_000);

  describe("(a) a forged deck in which a visible card appears twice", () => {
    it("control: re-committing the real deck reproduces the exact record, which verifies", async () => {
      const hand = fixtures.showdown;
      const same = recommit(hand.record, hand.sealed, hand.sealed.deck);
      expect(same.record).toEqual(hand.record);
      for (const seat of seatsOf(hand.record)) expect(await verifyParticipantAudit(json(participantAudit(same.record, same.sealed, seat)))).toEqual({ ok: true });
    });

    it("rejects a river that repeats a flop card, with the Merkle root and deck commitment rebuilt for that deck", async () => {
      const hand = fixtures.showdown;
      const board = boardPositions(seatsOf(hand.record).length);
      const deck = [...hand.sealed.deck];
      deck[board[4]!] = deck[board[0]!]!;
      const forged = recommit(hand.record, hand.sealed, deck, (r) => {
        (streetEvent(r, "RIVER").data as unknown as StreetData).cards[0] = deck[board[4]!]!;
        settled(r).board[4] = deck[board[4]!]!;
      });
      await expectChainIntact(forged.record);
      for (const seat of seatsOf(hand.record)) {
        // Every opening verifies against the forged root; only the permutation check can object.
        expectRejected(await verifyParticipantAudit(json(participantAudit(forged.record, forged.sealed, seat))), /visible card appears more than once/);
      }
      expectRejected(await verifySealedAudit(forged.record, forged.sealed), /not a permutation/);
    });

    it("rejects the viewer's own hole card repeated on the board, in a hand where nobody is tabled", async () => {
      const hand = fixtures.foldRiver;
      const dealt = seatsOf(hand.record);
      const board = boardPositions(dealt.length);
      for (const [i, viewer] of dealt.entries()) {
        const [own] = holeCardPositions(i, dealt.length);
        const deck = [...hand.sealed.deck];
        deck[own] = deck[board[2]!]!;
        const forged = recommit(hand.record, hand.sealed, deck);
        await expectChainIntact(forged.record);
        expectRejected(await verifyParticipantAudit(json(participantAudit(forged.record, forged.sealed, viewer))), /appears at two deck positions/);
      }
    });

    it("rejects a tabled opponent holding one of the viewer's cards", async () => {
      const hand = fixtures.showdown;
      const dealt = seatsOf(hand.record);
      const [viewerPos] = holeCardPositions(0, dealt.length);
      const [opponentPos] = holeCardPositions(1, dealt.length);
      const deck = [...hand.sealed.deck];
      deck[opponentPos] = deck[viewerPos]!;
      const forged = recommit(hand.record, hand.sealed, deck, (r) => {
        showdownOf(r).shown.find((s) => s.seatIndex === dealt[1])!.cards[0] = deck[viewerPos]!;
      });
      await expectChainIntact(forged.record);
      for (const seat of dealt) expectRejected(await verifyParticipantAudit(json(participantAudit(forged.record, forged.sealed, seat))), /more than once/);
    });
  });

  describe("(b) a malformed SHOWDOWN", () => {
    it("rejects a SHOWDOWN that lists a seat twice", async () => {
      const hand = fixtures.showdown;
      const forged = forge(hand.record, (r) => { showdownOf(r).shown.push(clone(showdownOf(r).shown[1]!)); });
      await expectChainIntact(forged);
      for (const seat of seatsOf(hand.record)) {
        expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seat))), /Showdown lists seat \d+, which may not be tabled/);
      }
    });

    it("rejects made-up cards for a tabled hand, for every viewer", async () => {
      const hand = fixtures.showdown;
      const madeUp: [Card, Card] = [hand.sealed.deck[51]!, hand.sealed.deck[50]!]; // never dealt
      for (const target of seatsOf(hand.record)) {
        const forged = forge(hand.record, (r) => { showdownOf(r).shown.find((s) => s.seatIndex === target)!.cards = [...madeUp]; });
        await expectChainIntact(forged);
        for (const seat of seatsOf(hand.record)) {
          expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seat))), /differs from the public record/);
        }
      }
      const garbage = forge(hand.record, (r) => { (showdownOf(r).shown[0] as unknown as { cards: string[] }).cards = ["Xx", "1c"]; });
      expectRejected(await verifyParticipantAudit(json(participantAudit(garbage, hand.sealed, seatsOf(hand.record)[0]!))), /Invalid shown hand/);
    });

    it("rejects a showdown on an incomplete board (river removed from the deal and the settlement)", async () => {
      const hand = fixtures.showdown;
      const forged = forge(hand.record, (r) => {
        r.events.splice(r.events.indexOf(streetEvent(r, "RIVER")), 1);
        settled(r).board.pop();
      });
      await expectChainIntact(forged);
      expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seatsOf(hand.record)[0]!))), /Showdown settlement without a complete board/);
    });

    it("rejects a HAND_SETTLED board that differs from the dealt board", async () => {
      const hand = fixtures.showdown;
      const forged = forge(hand.record, (r) => { settled(r).board[4] = hand.sealed.deck[51]!; });
      await expectChainIntact(forged);
      expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seatsOf(hand.record)[0]!))), /Settled board differs from the dealt board/);
    });

    it("rejects wrong deck positions for a tabled hand (another seat's, swapped, or off the deal)", async () => {
      const hand = fixtures.showdown;
      const n = seatsOf(hand.record).length;
      const variants: [string, (shown: ShownHand[]) => void][] = [
        ["another seat's positions", (shown) => { shown[0]!.positions = [...shown[1]!.positions]; }],
        ["swapped positions", (shown) => { shown[0]!.positions = [shown[0]!.positions[1], shown[0]!.positions[0]]; }],
        ["burn positions", (shown) => { shown[0]!.positions = [2 * n, 2 * n + 4]; }],
      ];
      for (const [name, mutate] of variants) {
        const forged = forge(hand.record, (r) => mutate(showdownOf(r).shown));
        await expectChainIntact(forged);
        const result = await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seatsOf(hand.record)[2]!)));
        check(!result.ok && /Showdown positions for seat/.test(result.reason ?? ""), () => `${name}: ${JSON.stringify(result)}`);
      }
    });
  });

  describe("(c) tabling a folded hand", () => {
    it("rejects a SHOWDOWN that tables a seat that FOLDED, even with valid Merkle openings of its real cards", async () => {
      const hand = fixtures.folded;
      const record = hand.record;
      const foldedSeat = actions(record).find((a) => a.action === "FOLD")!.seatIndex;
      const dealt = seatsOf(record);
      const positions = holeCardPositions(dealt.indexOf(foldedSeat), dealt.length);
      const cards: [Card, Card] = [hand.sealed.deck[positions[0]]!, hand.sealed.deck[positions[1]]!];
      const best = evaluate([...cards, ...settled(record).board]);
      const forged = forge(record, (r) => {
        showdownOf(r).shown.push({
          seatIndex: foldedSeat, cards, positions, category: best.category, rankValue: best.rankValue, handName: best.name, bestFive: [...best.bestFive],
        });
      });
      await expectChainIntact(forged);
      for (const seat of dealt) {
        const audit = json(participantAudit(forged, hand.sealed, seat));
        // The server's own proof builder opens the folded cards, and each opening is genuine.
        expect(audit.proofs.map((p) => p.card)).toEqual(expect.arrayContaining(cards));
        expectRejected(await verifyParticipantAudit(audit), new RegExp(`Showdown lists seat ${foldedSeat}, which may not be tabled`));
      }
      expect(verifyHandOutcome(forged, hand.sealed).ok).toBe(false);
    });

    it("rejects a second SHOWDOWN event", async () => {
      const hand = fixtures.folded;
      const forged = forge(hand.record, (r) => {
        const at = r.events.findIndex((e) => e.type === "SHOWDOWN");
        r.events.splice(at + 1, 0, clone(r.events[at]!));
      });
      await expectChainIntact(forged);
      expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seatsOf(hand.record)[1]!))), /More than one SHOWDOWN event/);
    });

    it("rejects a hand won by folds that tables the winner's hand", async () => {
      const hand = fixtures.foldRiver;
      const winner = awards(hand.record).pots[0]!.winnerSeatIndexes[0]!;
      const forged = forge(hand.record, (r) => insertShowdown(r, hand, [winner]));
      await expectChainIntact(forged);
      for (const seat of seatsOf(hand.record)) {
        expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seat))), /A hand won by folds has one remaining player and no showdown/);
      }
      expectRejected(await verifySealedAudit(forged, hand.sealed), /A hand won by folds has one remaining player and no showdown/);
    });

    it("rejects a seat that folds twice", async () => {
      const hand = fixtures.folded;
      const forged = forge(hand.record, (r) => {
        const at = r.events.findIndex((e) => e.type === "PLAYER_ACTION" && (e.data as unknown as ActionData).action === "FOLD");
        r.events.splice(at + 1, 0, clone(r.events[at]!));
      });
      await expectChainIntact(forged);
      expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, seatsOf(hand.record)[1]!))), /folded twice/);
    });
  });

  describe("(d) a showdown that hides a live hand", () => {
    it("rejects a SHOWDOWN that omits any hand that did not fold, including the viewer's own", async () => {
      for (const hand of [fixtures.showdown, fixtures.folded]) {
        const live = showdownOf(hand.record).shown.map((s) => s.seatIndex);
        for (const omitted of live) {
          const forged = forge(hand.record, (r) => { showdownOf(r).shown = showdownOf(r).shown.filter((s) => s.seatIndex !== omitted); });
          await expectChainIntact(forged);
          for (const viewer of seatsOf(hand.record)) {
            expectRejected(await verifyParticipantAudit(json(participantAudit(forged, hand.sealed, viewer))), /exactly the hands that did not fold/);
          }
        }
      }
    });
  });

  describe("(e) data outside the hashed schema, unknown event types and phases", () => {
    it("rejects an extra field on the record, an event, a proof or the audit envelope", async () => {
      const hand = fixtures.showdown;
      const viewer = seatsOf(hand.record)[0]!;
      const base = toParticipant(hand, viewer);
      expect(await verifyParticipantAudit(base)).toEqual({ ok: true });
      const variants: [string, (a: ParticipantHandAudit & Record<string, unknown>) => void, RegExp][] = [
        ["record field", (a) => { (a.record as unknown as Record<string, unknown>).winnerNote = "seat 0 won"; }, /Unexpected record field "winnerNote"/],
        ["event field", (a) => { (a.record.events[3] as unknown as Record<string, unknown>).amountOverride = 500; }, /Event 3 has unexpected field "amountOverride"/],
        ["settled event field", (a) => { (a.record.events.at(-1) as unknown as Record<string, unknown>).payout = 1; }, /unexpected field "payout"/],
        ["proof field", (a) => { (a.proofs[0] as unknown as Record<string, unknown>).note = "x"; }, /Malformed proof/],
        ["envelope field", (a) => { a.sealed = { deckSalt: "0".repeat(64) }; }, /Malformed participant audit/],
      ];
      for (const [name, mutate, reason] of variants) {
        const copy = clone(base) as ParticipantHandAudit & Record<string, unknown>;
        mutate(copy);
        // Unhashed extras leave every hash valid; only the schema check can see them.
        const result = await verifyParticipantAudit(copy);
        check(!result.ok && reason.test(result.reason ?? ""), () => `${name}: ${JSON.stringify(result)}`);
      }
    });

    it("rejects an unknown event type or phase, and HAND_STARTED anywhere but first, even when re-hashed", async () => {
      const hand = fixtures.showdown;
      const variants: [string, (r: HandAuditRecord) => void, RegExp][] = [
        ["unknown type", (r) => { (r.events[4] as { type: string }).type = "RAKE_TAKEN"; }, /Event 4 has unknown type/],
        ["WAITING phase", (r) => { (r.events[4] as { phase: string }).phase = "WAITING"; }, /Event 4 has unknown phase/],
        ["COMPLETE phase", (r) => { (r.events.at(-1) as { phase: string }).phase = "COMPLETE"; }, /unknown phase/],
        ["HAND_STARTED repeated", (r) => { r.events.splice(2, 0, clone(r.events[0]!)); }, /HAND_STARTED must be the first event/],
        ["HAND_STARTED not first", (r) => { const [first, second] = [r.events[0]!, r.events[1]!]; r.events[0] = second; r.events[1] = first; }, /HAND_STARTED must be the first event/],
      ];
      for (const [name, mutate, reason] of variants) {
        const forged = forge(hand.record, mutate);
        const chain = await verifyAuditRecord(forged, { requireSettled: true });
        check(!chain.ok && reason.test(chain.reason ?? ""), () => `${name} (chain): ${JSON.stringify(chain)}`);
        const audit: ParticipantHandAudit = { ...toParticipant(hand, seatsOf(hand.record)[0]!), record: forged };
        const result = await verifyParticipantAudit(audit);
        check(!result.ok && reason.test(result.reason ?? ""), () => `${name}: ${JSON.stringify(result)}`);
      }
    });
  });

  describe("(f) the record must be the requested table, hand and user", () => {
    it("rejects a genuine record of another table, another hand, or another user's seat", async () => {
      const { tableA, tableB, tableAHand2 } = fixtures;
      const aliceA = toParticipant(tableA, 0);
      const bind = { tableId: "rv-bind-a", handNumber: 1, userId: "rv-alice" };
      expect(await verifyParticipantAudit(aliceA, bind)).toEqual({ ok: true });
      // Same user, same seat, same hand number, but table B.
      expect(userAt(tableB.record, 0)).toBe("rv-alice");
      expect(tableB.record.handNumber).toBe(1);
      expectRejected(await verifyParticipantAudit(toParticipant(tableB, 0), bind), /different table/);
      expect(await verifyParticipantAudit(toParticipant(tableB, 0), { ...bind, tableId: "rv-bind-b" })).toEqual({ ok: true });
      // Hand 2 of table A answered for hand 1.
      expectRejected(await verifyParticipantAudit(toParticipant(tableAHand2, 0), bind), /different hand/);
      expect(await verifyParticipantAudit(toParticipant(tableAHand2, 0), { ...bind, handNumber: 2 })).toEqual({ ok: true });
      // Bob's seat given to Alice, and a user who never sat.
      expectRejected(await verifyParticipantAudit(toParticipant(tableA, 1), bind), /does not belong to this user/);
      expectRejected(await verifyParticipantAudit(aliceA, { ...bind, userId: "rv-mallory" }), /does not belong to this user/);
      expect(await verifyParticipantAudit(toParticipant(tableA, 1), { ...bind, userId: "rv-bob" })).toEqual({ ok: true });
    });
  });

  describe("(g) hole cards against the digest recorded live", () => {
    it("accepts the live digest and rejects a digest of other cards, swapped cards or another hand", async () => {
      const hand = fixtures.showdown;
      const viewer = seatsOf(hand.record)[1]!;
      const userId = userAt(hand.record, viewer);
      const observed = await fixtures.evidence.observed(hand.record.handId, userId);
      const audit = toParticipant(hand, viewer);
      expect(await verifyParticipantAudit(audit, observed)).toEqual({ ok: true });
      const own = hand.table.players[viewer]!.holeCards!;
      expect(observed.holeCardsDigest).toBe(await holeCardsDigest(hand.record.handId, own));
      const wrong: [string, string][] = [
        ["board card", await holeCardsDigest(hand.record.handId, [settled(hand.record).board[0]!, own[1]])],
        ["swapped order", await holeCardsDigest(hand.record.handId, [own[1], own[0]])],
        ["another hand's id", await holeCardsDigest(fixtures.foldRiver.record.handId, own)],
        ["not a digest", "0".repeat(64)],
      ];
      for (const [name, digest] of wrong) {
        const result = await verifyParticipantAudit(audit, { ...observed, holeCardsDigest: digest });
        check(!result.ok && /hole cards differ from the live deal/.test(result.reason ?? ""), () => `${name}: ${JSON.stringify(result)}`);
      }
    });
  });
});

// ===========================================================================
// 2. Sealed card integrity
// ===========================================================================

describe("2. verifySealedAudit: card integrity", () => {
  const hand = scripted("sealed", 9, SPREAD_SEATS.slice(0, 5).map((seat) => [seat, 5_000] as const), checkDown);
  const dealt = seatsOf(hand.record);
  const n = dealt.length;

  it("accepts a real hand and reports exactly the dealt hole cards and burns", async () => {
    const report = await verifySealedAudit(hand.record, hand.sealed);
    expect(report.ok).toBe(true);
    expect(report.holeCards).toEqual(dealt.map((seatIndex) => ({ seatIndex, cards: hand.table.players[seatIndex]!.holeCards })));
    expect(report.burns).toEqual(hand.table.burns);
  });

  it("rejects deck and salt tampering in the sealed record", async () => {
    const undealt = 2 * n + 8; // first position after the river
    const variants: [string, (s: SealedHandAudit & Record<string, unknown>) => void, RegExp][] = [
      ["two undealt cards swapped", (s) => { [s.deck[undealt], s.deck[undealt + 1]] = [s.deck[undealt + 1]!, s.deck[undealt]!]; }, /Deck commitment does not match/],
      ["a card duplicated", (s) => { s.deck[undealt] = s.deck[0]!; }, /not a permutation/],
      ["a non-card", (s) => { (s.deck as string[])[undealt] = "Zz"; }, /not a permutation/],
      ["deck salt", (s) => { s.deckSalt = "0".repeat(64); }, /Deck commitment does not match/],
      ["one Merkle salt", (s) => { s.merkleSalts[7] = "f".repeat(64); }, /Merkle root does not match/],
      ["a padding salt", (s) => { s.merkleSalts[63] = "f".repeat(64); }, /Merkle root does not match/],
      ["hand id", (s) => { s.handId = "11111111-1111-4111-8111-111111111111"; }, /does not belong to this hand/],
      ["extra field", (s) => { s.shuffleSeed = "00"; }, /does not belong to this hand/],
    ];
    for (const [name, mutate, reason] of variants) {
      const copy = clone(hand.sealed) as SealedHandAudit & Record<string, unknown>;
      mutate(copy);
      const result = await verifySealedAudit(hand.record, copy);
      check(!result.ok && reason.test(result.reason ?? ""), () => `${name}: ${JSON.stringify(result)}`);
    }
  });

  it("rejects a deck recommitted after the deal (board, tabled or undealt cards moved), even with valid commitments", async () => {
    const board = boardPositions(n);
    const undealt = 2 * n + 8;
    const [shownPos] = holeCardPositions(0, n);
    const variants: [string, number, RegExp][] = [
      ["a flop card", board[1]!, /Board card at position/],
      ["the river card", board[4]!, /Board card at position/],
      ["a tabled hole card", shownPos, /Shown cards for seat/],
    ];
    for (const [name, position, reason] of variants) {
      const deck = [...hand.sealed.deck];
      [deck[position], deck[undealt]] = [deck[undealt]!, deck[position]!];
      const forged = recommit(hand.record, hand.sealed, deck);
      await expectChainIntact(forged.record);
      const result = await verifySealedAudit(forged.record, forged.sealed);
      check(!result.ok && reason.test(result.reason ?? ""), () => `${name}: ${JSON.stringify(result)}`);
    }
  });
});

// ===========================================================================
// 3. Regulator outcome replay
// ===========================================================================

const RANDOM_HANDS = 1_000;
const STYLES: readonly Style[] = ["passive", "balanced", "aggressive"];

function randomStack(bigBlind: number): number {
  const roll = randInt(10);
  if (roll < 3) return 1 + randInt(4 * bigBlind); // short: under four big blinds, sometimes under a blind
  if (roll < 7) return 10 * bigBlind + randInt(50 * bigBlind);
  return 100 * bigBlind + randInt(200 * bigBlind);
}

/** Scripted coverage first (independent of the cards), then random tables up to `target` settled hands. */
async function sweep(target: number): Promise<Hand[]> {
  const collector = new HandCollector(null);
  let tables = 0;
  const newSim = (maxSeats: number, smallBlind: number): TableSim =>
    new TableSim({ tableId: `rv-sweep-t${++tables}`, name: `Sweep ${tables}`, maxSeats, smallBlind }, collector.observe);
  for (let players = 2; players <= 9; players++) {
    const sim = newSim(9, 5);
    for (const seat of SPREAD_SEATS.slice(0, players)) await sim.seat(seat, 10_000);
    collector.label = `scripted ${players} players`;
    for (const street of STREETS) await sim.playHand({ kind: "foldOn", street });
    await sim.playHand({ kind: "checkdown" });
    await sim.playHand({ kind: "shove" });
  }
  for (const stacks of SIDE_POT_STACKS) {
    const sim = newSim(9, 5);
    for (const [i, stack] of stacks.entries()) await sim.seat(SPREAD_SEATS[i]!, stack);
    collector.label = `side pots ${stacks.join("/")}`;
    await sim.playHand({ kind: "shove" });
  }
  for (let i = 0; i < 3; i++) {
    const sim = newSim(7, 5);
    for (let seat = 0; seat < 6; seat++) await sim.seat(seat, 2_000);
    collector.label = "events";
    await sim.playHand({ kind: "events" });
    await sim.playHand({ kind: "checkdown" });
  }
  while (collector.hands.length < target) {
    const players = 2 + randInt(8);
    const maxSeats = players + randInt(10 - players);
    const smallBlind = pick([1, 5, 50]);
    const sim = newSim(maxSeats, smallBlind);
    for (const seat of shuffle([...Array(maxSeats).keys()]).slice(0, players)) await sim.seat(seat, randomStack(2 * smallBlind));
    const style = pick(STYLES);
    const events = randInt(5) !== 0;
    collector.label = `random ${style}${events ? " with events" : ""}`;
    const quota = 3 + randInt(8);
    for (let h = 0; h < quota && collector.hands.length < target && sim.liveForDeal() >= 2; h++) {
      await sim.playHand({ kind: "random", style, events });
      if (events) await sim.betweenHands();
    }
  }
  return collector.hands;
}

describe("3. verifyHandOutcome: regulator replay of the hand result", () => {
  let hands: Hand[] = [];
  beforeAll(async () => {
    hands = await sweep(RANDOM_HANDS);
  }, 600_000);

  it(`accepts ${RANDOM_HANDS}+ real hands (2-9 players, varied stacks, all-ins, side pots, time-outs, sit-outs, leaves), with card integrity and one participant per hand`, async () => {
    expect(hands.length).toBeGreaterThanOrEqual(RANDOM_HANDS);
    const coverage = { dealt: new Set<number>(), allIn: 0, sidePots: 0, timeouts: 0, sitOuts: 0, leaves: 0, folds: 0, showdowns: 0, runouts: 0, refunds: 0, splits: 0 };
    for (const [i, hand] of hands.entries()) {
      const where = (): string => `hand ${i} (${hand.label}, table ${hand.record.tableId} #${hand.record.handNumber})`;
      const card = await verifySealedAudit(hand.record, hand.sealed);
      check(card.ok, () => `${where()}: card integrity ${card.reason}`);
      const outcome = verifyHandOutcome(hand.record, hand.sealed);
      check(outcome.ok, () => `${where()}: outcome ${outcome.reason}`);
      // The replayed settlement equals the engine's live state at settlement.
      for (const { seatIndex, stack } of settled(hand.record).stacks) {
        check(hand.table.players[seatIndex]?.stack === stack, () => `${where()}: seat ${seatIndex} holds ${hand.table.players[seatIndex]?.stack}, record says ${stack}`);
      }
      const dealt = seatsOf(hand.record);
      const seat = dealt[i % dealt.length]!;
      const participant = await verifyParticipantAudit(toParticipant(hand, seat),
        { tableId: hand.record.tableId, handNumber: hand.record.handNumber, userId: userAt(hand.record, seat) });
      check(participant.ok, () => `${where()}: participant seat ${seat}: ${participant.reason}`);

      const shape = shapeOf(hand.record);
      coverage.dealt.add(dealt.length);
      if (blinds(hand.record).some((b) => b.allIn) || actions(hand.record).some((a) => a.stackAfter === 0)) coverage.allIn++;
      if (shape.pots >= 2) coverage.sidePots++;
      if (shape.timeout) coverage.timeouts++;
      if (shape.sitOut) coverage.sitOuts++;
      if (shape.leave) coverage.leaves++;
      if (shape.reason === "fold") coverage.folds++;
      else coverage.showdowns++;
      if (shape.runout) coverage.runouts++;
      if (awards(hand.record).refunds.length > 0) coverage.refunds++;
      if (awards(hand.record).pots.some((p) => p.winnerSeatIndexes.length > 1)) coverage.splits++;
    }
    expect([...coverage.dealt].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    for (const key of ["allIn", "sidePots", "timeouts", "sitOuts", "leaves", "folds", "showdowns", "runouts", "refunds"] as const) {
      check(coverage[key] > 0, () => `no ${key} in the sweep: ${JSON.stringify({ ...coverage, dealt: [...coverage.dealt] })}`);
    }
  }, 600_000);

  describe("rejects re-sealed forgeries that keep every hash valid", () => {
    // A 4-way check-down with a pot that some eligible hand loses to a single winner.
    let showdown: Hand | undefined;
    let loser = { pot: -1, winner: -1, loser: -1 };
    // Everyone folds to a flop bet: a fold win with an uncalled bet returned.
    const foldWin = scripted("fold-flop", 6, [0, 1, 2, 3].map((seat) => [seat, 3_000] as const), foldOn("FLOP"));
    // All-in runout with side pots: 60 / 150 / 400 / 900.
    const sidePots = scripted("side", 6, [[0, 60], [1, 150], [2, 400], [3, 900]], shoveAll);
    let oddChip: Hand | undefined;

    beforeAll(() => {
      for (let tries = 0; tries < 60 && !showdown; tries++) {
        const hand = scripted("showdown4", 6, [0, 1, 2, 3].map((seat) => [seat, 3_000] as const), checkDown);
        const pot = awards(hand.record).pots.findIndex((p) => p.winnerSeatIndexes.length === 1 && p.eligibleSeatIndexes.length > 1);
        if (pot < 0) continue;
        const row = awards(hand.record).pots[pot]!;
        showdown = hand;
        loser = { pot, winner: row.winnerSeatIndexes[0]!, loser: row.eligibleSeatIndexes.find((s) => s !== row.winnerSeatIndexes[0])! };
      }
      const sb = (t: EngineTable): number | null => t.sbSeat;
      const sbFolds: Chooser = (t, seat, legal) => (t.phase === "PREFLOP" && seat === sb(t) && legal.actions.includes("FOLD") ? { action: "FOLD" } : passive(legal));
      for (let tries = 0; tries < 300 && !oddChip; tries++) {
        const hand = scripted("oddchip", 9, [...Array(9).keys()].map((seat) => [seat, 3_000] as const), sbFolds);
        if (awards(hand.record).pots.some((p) => p.oddChipSeatIndex !== null)) oddChip = hand;
      }
    }, 120_000);

    it("finds the hand shapes it needs, and each one replays cleanly", async () => {
      expect(showdown).toBeDefined();
      expect(oddChip).toBeDefined();
      expect(awards(foldWin.record).refunds.length).toBe(1);
      expect(awards(sidePots.record).pots.length).toBe(3);
      for (const hand of [showdown!, oddChip!, foldWin, sidePots]) {
        expect(verifyHandOutcome(hand.record, hand.sealed)).toEqual({ ok: true });
        expect((await verifySealedAudit(hand.record, hand.sealed)).ok).toBe(true);
      }
    });

    type Forgery = [name: string, hand: () => Hand, mutate: (r: HandAuditRecord) => void, reason: RegExp, cardIntegrityPasses: boolean];
    const forgeries: Forgery[] = [
      ["a showdown pot reassigned to a losing hand (payouts and stacks moved to match)", () => showdown!, (r) => {
        const pot = awards(r).pots[loser.pot]!;
        pot.winnerSeatIndexes = [loser.loser];
        moveChips(r, loser.winner, loser.loser, pot.amount);
      }, /Pot awards differ/, true],
      ["a fold win reassigned to a player who folded", () => foldWin, (r) => {
        const pot = awards(r).pots[0]!;
        const winner = pot.winnerSeatIndexes[0]!;
        const folder = actions(r).find((a) => a.action === "FOLD")!.seatIndex;
        pot.eligibleSeatIndexes = [folder];
        pot.winnerSeatIndexes = [folder];
        moveChips(r, winner, folder, pot.amount);
      }, /Pot awards differ/, true],
      ["one chip of payout moved between players (stacks moved to match)", () => showdown!, (r) => {
        moveChips(r, loser.winner, loser.loser, 1);
      }, /Pot awards differ/, true],
      ["a side pot paid to a player not eligible for it", () => sidePots, (r) => {
        const top = awards(r).pots.at(-1)!;
        const outsider = started(r).dealtSeats.find((s) => !top.eligibleSeatIndexes.includes(s))!;
        // Move each winner's share (at most two winners; the odd chip goes to oddChipSeatIndex).
        const share = Math.floor(top.amount / top.winnerSeatIndexes.length);
        for (const winner of top.winnerSeatIndexes) {
          moveChips(r, winner, outsider, share + (winner === top.oddChipSeatIndex ? top.amount - share * top.winnerSeatIndexes.length : 0));
        }
        top.winnerSeatIndexes = [outsider];
        top.oddChipSeatIndex = null;
      }, /Pot awards differ/, true],
      ["the odd chip moved to the other winner", () => oddChip!, (r) => {
        const pot = awards(r).pots.find((p) => p.oddChipSeatIndex !== null)!;
        const from = pot.oddChipSeatIndex!;
        const to = pot.winnerSeatIndexes.find((s) => s !== from)!;
        pot.oddChipSeatIndex = to;
        moveChips(r, from, to, 1);
      }, /Pot awards differ/, true],
      ["an uncalled-bet refund reduced by one chip, added to the pot", () => foldWin, (r) => {
        awards(r).refunds[0]!.amount -= 1;
        awards(r).pots[0]!.amount += 1;
      }, /Pot awards differ/, true],
      ["an uncalled-bet refund removed, added to the pot", () => foldWin, (r) => {
        const refund = awards(r).refunds[0]!.amount;
        awards(r).refunds = [];
        awards(r).pots[0]!.amount += refund;
      }, /Pot awards differ/, true],
      ["final stacks changed (total kept)", () => showdown!, (r) => {
        const stacks = settled(r).stacks;
        stacks[0]!.stack += 7;
        stacks[1]!.stack -= 7;
      }, /Settlement differs/, true],
      ["HAND_SETTLED chipTotal changed", () => showdown!, (r) => { settled(r).chipTotal += 1; }, /Settlement differs/, true],
      ["HAND_STARTED chipTotal changed", () => showdown!, (r) => { started(r).chipTotal += 1; }, /HAND_STARTED chip total/, true],
      ["both chipTotals changed together", () => showdown!, (r) => { started(r).chipTotal += 100; settled(r).chipTotal += 100; }, /HAND_STARTED chip total/, true],
      ["a big blind amount changed", () => showdown!, (r) => {
        (eventsOf(r, "BLIND_POSTED").find((e) => (e.data as unknown as BlindData).blind === "BIG")!.data as unknown as BlindData).amount -= 1;
      }, /differs|Invalid amount/, true],
      ["a call amount changed", () => showdown!, (r) => {
        (eventsOf(r, "PLAYER_ACTION").find((e) => (e.data as unknown as ActionData).action === "CALL")!.data as unknown as ActionData).amount -= 1;
      }, /Recorded stack differs/, true],
      ["a stackAfter changed", () => showdown!, (r) => {
        (eventsOf(r, "PLAYER_ACTION")[0]!.data as unknown as ActionData).stackAfter += 1;
      }, /Recorded stack differs/, true],
      ["a call amount and every later stackAfter of that seat changed consistently", () => showdown!, (r) => {
        const call = eventsOf(r, "PLAYER_ACTION").find((e) => (e.data as unknown as ActionData).action === "CALL")!;
        const seat = (call.data as unknown as ActionData).seatIndex;
        (call.data as unknown as ActionData).amount -= 1;
        for (const e of eventsOf(r, "PLAYER_ACTION").filter((x) => x.seq >= call.seq && (x.data as unknown as ActionData).seatIndex === seat)) {
          (e.data as unknown as ActionData).stackAfter += 1;
        }
      }, /Pot awards differ/, true],
      ["a wrong handName in SHOWDOWN", () => showdown!, (r) => { showdownOf(r).shown[0]!.handName = "Royal Flush"; }, /Showdown hands or rankings differ/, true],
      ["a wrong rankValue in SHOWDOWN", () => showdown!, (r) => { showdownOf(r).shown[0]!.rankValue += 1; }, /Showdown hands or rankings differ/, true],
      ["a wrong category in SHOWDOWN", () => showdown!, (r) => {
        const row = showdownOf(r).shown[0]!;
        row.category = row.category === "STRAIGHT_FLUSH" ? "HIGH_CARD" : "STRAIGHT_FLUSH";
      }, /Showdown hands or rankings differ/, true],
      ["a wrong bestFive in SHOWDOWN", () => showdown!, (r) => { showdownOf(r).shown[0]!.bestFive.reverse(); }, /Showdown hands or rankings differ/, true],
      ["a SHOWDOWN that omits a live hand", () => showdown!, (r) => { showdownOf(r).shown.pop(); }, /Showdown hands or rankings differ/, false],
      ["a fold win with a SHOWDOWN of the winner", () => foldWin, (r) => {
        insertShowdown(r, foldWin, [awards(r).pots[0]!.winnerSeatIndexes[0]!]);
      }, /A hand won by folds cannot have a showdown/, false],
      ["a fold win with an empty SHOWDOWN", () => foldWin, (r) => insertShowdown(r, foldWin, []), /A hand won by folds cannot have a showdown/, false],
      ["a second SHOWDOWN event", () => showdown!, (r) => {
        const at = r.events.findIndex((e) => e.type === "SHOWDOWN");
        r.events.splice(at, 0, clone(r.events[at]!));
      }, /More than one SHOWDOWN event/, false],
      ["SHOWDOWN moved before the river betting", () => showdown!, (r) => {
        const [shown] = r.events.splice(r.events.findIndex((e) => e.type === "SHOWDOWN"), 1);
        r.events.splice(r.events.indexOf(streetEvent(r, "RIVER")) + 1, 0, shown!);
      }, /SHOWDOWN must directly precede POTS_AWARDED/, true],
      ["the river removed from a showdown", () => showdown!, (r) => { r.events.splice(r.events.indexOf(streetEvent(r, "RIVER")), 1); },
        /Showdown without a complete board/, false],
      ["a blind's all-in flag flipped", () => showdown!, (r) => {
        (eventsOf(r, "BLIND_POSTED")[1]!.data as unknown as BlindData).allIn = true;
      }, /Blind all-in flag is wrong/, true],
      ["an action by a seat that already folded", () => foldWin, (r) => {
        const fold = eventsOf(r, "PLAYER_ACTION").find((e) => (e.data as unknown as ActionData).action === "FOLD")!;
        const again = clone(fold);
        (again.data as unknown as ActionData).action = "CHECK";
        r.events.splice(r.events.findIndex((e) => e.type === "POTS_AWARDED"), 0, again);
      }, /acted after folding/, true],
      ["an action amount larger than the player's stack", () => showdown!, (r) => {
        const call = eventsOf(r, "PLAYER_ACTION").find((e) => (e.data as unknown as ActionData).action === "CALL")!.data as unknown as ActionData;
        call.amount = 1_000_000;
        call.stackAfter -= 1_000_000;
      }, /Invalid amount/, true],
      ["a seat row removed from HAND_STARTED", () => showdown!, (r) => { started(r).seats.pop(); }, /Starting seats differ from the dealt seats/, false],
      ["a starting stack raised with chipTotal (settled stacks unchanged)", () => showdown!, (r) => {
        started(r).seats[0]!.stack += 50;
        started(r).chipTotal += 50;
      }, /Recorded stack differs|Chips were not conserved|Settlement differs/, true],
      ["POTS_AWARDED missing", () => showdown!, (r) => { r.events.splice(r.events.findIndex((e) => e.type === "POTS_AWARDED"), 1); }, /ends with POTS_AWARDED then HAND_SETTLED/, true],
      ["POTS_AWARDED missing from a fold win", () => foldWin, (r) => { r.events.splice(r.events.findIndex((e) => e.type === "POTS_AWARDED"), 1); }, /ends with POTS_AWARDED then HAND_SETTLED/, true],
      ["POTS_AWARDED moved before SHOWDOWN", () => showdown!, (r) => {
        const at = r.events.findIndex((e) => e.type === "POTS_AWARDED");
        [r.events[at - 1], r.events[at]] = [r.events[at]!, r.events[at - 1]!];
      }, /ends with POTS_AWARDED then HAND_SETTLED/, true],
      ["POTS_AWARDED moved before the river is dealt", () => showdown!, (r) => {
        const [awarded] = r.events.splice(r.events.findIndex((e) => e.type === "POTS_AWARDED"), 1);
        r.events.splice(r.events.indexOf(streetEvent(r, "RIVER")), 0, awarded!);
      }, /Chips moved after the pots were awarded/, true],
      ["POTS_AWARDED duplicated", () => showdown!, (r) => {
        const at = r.events.findIndex((e) => e.type === "POTS_AWARDED");
        r.events.splice(at, 0, clone(r.events[at]!));
      }, /More than one POTS_AWARDED/, true],
    ];

    it.each(forgeries)("rejects %s", async (_name, handOf, mutate, reason, cardIntegrityPasses) => {
      const hand = handOf();
      const forged = forge(hand.record, mutate);
      expect(forged.finalStateHash).not.toBe(hand.record.finalStateHash);
      await expectChainIntact(forged);
      // Card integrity alone cannot see a pure outcome forgery; the replay must.
      if (cardIntegrityPasses) expect((await verifySealedAudit(forged, hand.sealed)).ok).toBe(true);
      expectRejected(verifyHandOutcome(forged, hand.sealed), reason);
    });

    it("rejects the sealed deck of another hand", () => {
      expectRejected(verifyHandOutcome(showdown!.record, foldWin.sealed), /Sealed record does not belong to this hand/);
    });

    it("rejects a history in which every player with chips in a side pot folds: the stranded pot breaks chip conservation", async () => {
      // Real hand: A all-in for 100; B and C put in 300 each (a 400-chip side pot); B left and folded.
      const t = strandedPotHand(false);
      const sealed = sealedAudit(t.fairness!);
      const [a, b, c] = [0, 1, 2];
      // Forgery: C folds as well, no showdown, and POTS_AWARDED is exactly what the replay computes.
      // Every chip, pot and payout rule is then satisfied, but nobody is eligible for the side pot.
      const forged = forge(t.audit!, (r) => {
        const bFold = eventsOf(r, "PLAYER_ACTION").find((e) => (e.data as unknown as ActionData).seatIndex === b && (e.data as unknown as ActionData).action === "FOLD")!;
        const cFold = clone(bFold);
        Object.assign(cFold.data as unknown as ActionData, { seatIndex: c, stackAfter: 700 });
        r.events.splice(r.events.indexOf(bFold) + 1, 0, cFold);
        r.events.splice(r.events.findIndex((e) => e.type === "SHOWDOWN"), 1);
        Object.assign(awards(r), {
          pots: [
            { potIndex: 0, amount: 300, eligibleSeatIndexes: [a], winnerSeatIndexes: [a], oddChipSeatIndex: null },
            { potIndex: 1, amount: 400, eligibleSeatIndexes: [], winnerSeatIndexes: [], oddChipSeatIndex: null },
          ],
          refunds: [],
          payouts: [{ seatIndex: a, amount: 300 }],
        });
        Object.assign(settled(r), { reason: "fold", stacks: started(r).dealtSeats.map((seat) => ({ seatIndex: seat, stack: seat === a ? 300 : 700 })) });
      });
      await expectChainIntact(forged);
      expectRejected(verifyHandOutcome(forged, sealed), /Chips were not conserved/);
    });
  });
});

// ===========================================================================
// 4. Rules fixes
// ===========================================================================

function seatTable(tableId: string, maxSeats: number, seats: readonly number[], stack = 1_000, prefix = tableId): EngineTable {
  let t = newTable(tableId, maxSeats);
  for (const seat of seats) t = join(t, seat, `${prefix}-u${seat}`, stack);
  return t;
}

/** Start a hand, record it, fold it around, clean up. */
function foldHand(t: EngineTable, clock: Clock, log: LedgerHand[] = []): EngineTable {
  t = startHand(t, clock.tick());
  log.push(ledgerHand(t));
  return completeHand(playOut(t, foldAround, clock));
}

const actionRows = (t: EngineTable): { seatIndex: number; action: string; auto: string | null; timeout: boolean }[] =>
  actions(t.audit!).map(({ seatIndex, action, auto, timeout }) => ({ seatIndex, action, auto, timeout }));

describe("4. rules fixes", () => {
  describe("wait for the big blind", () => {
    it("a newcomer at a running table is not dealt in until the big blind reaches them, and then posts it", () => {
      const clock = new Clock();
      let t = seatTable("rv-newcomer", 6, [0, 1, 2, 3]);
      t = foldHand(t, clock); // hand 1: button 0, blinds 1/2
      t = join(t, 5, "rv-newcomer-new", 1_000);
      expect(t.players[5]!.waitingForBigBlind).toBe(true);
      expect(projectTableState(t, "rv-newcomer-new").players[5]!.waitingForBigBlind).toBe(true);

      // Hand 2: the big blind moves from seat 2 to seat 3. Seat 5 sits out the hand.
      t = startHand(t, clock.tick());
      expect([t.bbSeat, t.dealtSeats.includes(5), t.players[5]!.status, t.players[5]!.holeCards]).toEqual([3, false, "SIT_OUT", null]);
      expect(started(t.audit!).dealtSeats).not.toContain(5);
      expect(projectTableState(t, "rv-newcomer-new").players[5]!.holeCards).toBeNull();
      t = completeHand(playOut(t, foldAround, clock));

      // Hand 3: the big blind reaches seat 5 (seat 4 is empty). The newcomer is dealt in and posts it.
      t = startHand(t, clock.tick());
      expect(t.bbSeat).toBe(5);
      expect(t.dealtSeats).toContain(5);
      expect(blinds(t.audit!)).toContainEqual({ seatIndex: 5, blind: "BIG", amount: 10, allIn: false });
      expect(t.players[5]!.waitingForBigBlind).toBe(false);
    });

    it("a newcomer who sits down during a hand also waits for the big blind", () => {
      const clock = new Clock();
      let t = seatTable("rv-midhand", 6, [0, 1, 2, 3]);
      t = startHand(t, clock.tick());
      t = join(t, 4, "rv-midhand-new", 1_000);
      expect(t.players[4]!.waitingForBigBlind).toBe(true);
      t = completeHand(playOut(t, foldAround, clock));
      t = startHand(t, clock.tick()); // big blind 2 -> 3
      expect(t.dealtSeats).not.toContain(4);
      t = completeHand(playOut(t, foldAround, clock));
      t = startHand(t, clock.tick()); // big blind 3 -> 4
      expect(t.bbSeat).toBe(4);
      expect(blinds(t.audit!)).toContainEqual({ seatIndex: 4, blind: "BIG", amount: 10, allIn: false });
    });

    it("a newcomer is dealt in at once at a brand-new table, or when fewer than two others could play", () => {
      const clock = new Clock();
      // Brand-new table (handNumber 0): nobody waits, everyone is dealt into hand 1.
      let fresh = seatTable("rv-fresh", 6, [1, 3, 5]);
      expect(fresh.players.filter((p) => p?.waitingForBigBlind)).toEqual([]);
      fresh = startHand(fresh, clock.tick());
      expect([...fresh.dealtSeats].sort()).toEqual([1, 3, 5]);

      // One other live player: the newcomer plays the next hand heads-up.
      let t = seatTable("rv-solo", 6, [0, 1]);
      t = foldHand(t, clock);
      t = leaveSeat(t, "rv-solo-u1", clock.tick());
      t = join(t, 3, "rv-solo-new", 1_000);
      expect(t.players[3]!.waitingForBigBlind).toBe(false);
      t = startHand(t, clock.tick());
      expect([...t.dealtSeats].sort()).toEqual([0, 3]);

      // Two others seated, but one sits out: only one other could play, so the newcomer plays at once.
      let u = seatTable("rv-sitter", 6, [0, 1, 2]);
      u = foldHand(u, clock);
      u = sitOut(u, "rv-sitter-u2", clock.tick());
      u = leaveSeat(u, "rv-sitter-u1", clock.tick());
      u = join(u, 4, "rv-sitter-new", 1_000);
      expect(u.players[4]!.waitingForBigBlind).toBe(false);
      u = startHand(u, clock.tick());
      expect([...u.dealtSeats].sort()).toEqual([0, 4]);

      // A newcomer who was waiting plays at once when the others drop below two, even though the
      // big blind (moving from seat 4) reaches seat 0 before the newcomer's seat 3.
      let w = seatTable("rv-dwindle", 6, [0, 2, 4]);
      w = foldHand(w, clock); // hand 1: button 0, blinds 2/4
      w = join(w, 3, "rv-dwindle-new", 1_000);
      expect(w.players[3]!.waitingForBigBlind).toBe(true);
      w = leaveSeat(w, "rv-dwindle-u2", clock.tick());
      w = sitOut(w, "rv-dwindle-u4", clock.tick());
      w = startHand(w, clock.tick());
      expect([...w.dealtSeats].sort()).toEqual([0, 3]);
      expect([w.bbSeat, w.dealerSeat, w.sbSeat]).toEqual([0, 3, 3]);
      expect(w.players[3]!.waitingForBigBlind).toBe(false);
    });
  });

  describe("no blind dodging", () => {
    it("sitting out over the big blind and back in makes the player wait for the big blind", () => {
      const clock = new Clock();
      const log: LedgerHand[] = [];
      let t = seatTable("rv-dodge-bb", 6, [0, 1, 2, 3, 4]);
      t = foldHand(t, clock, log); // hand 1: blinds 1/2; seat 3 is next in line for the big blind
      t = sitOut(t, "rv-dodge-bb-u3", clock.tick());
      t = foldHand(t, clock, log); // hand 2: the big blind skips seat 3 and goes to seat 4
      expect([log[1]!.bb, log[1]!.dealt.includes(3)]).toEqual([4, false]);
      expect(t.players[3]!.missedBlind).toBe(true);
      t = sitIn(t, "rv-dodge-bb-u3", clock.tick());
      expect(t.players[3]!.waitingForBigBlind).toBe(true);
      expect(projectTableState(t, "rv-dodge-bb-u1").players[3]!.waitingForBigBlind).toBe(true);
      for (let i = 0; i < 4; i++) t = foldHand(t, clock, log); // hands 3-6
      expect(log.slice(2, 5).map((h) => h.dealt.includes(3))).toEqual([false, false, false]);
      // Hand 6: the big blind comes round to seat 3, which is dealt in and posts it.
      expect([log[5]!.bb, log[5]!.bigBlindBy, log[5]!.dealt.includes(3)]).toEqual([3, "rv-dodge-bb-u3", true]);
      expect(blindLedgerViolations(log)).toEqual([]);
    });

    it("sitting out the small blind (dead small blind) and back in makes the player wait for the big blind", () => {
      const clock = new Clock();
      const log: LedgerHand[] = [];
      let t = seatTable("rv-dodge-sb", 6, [0, 1, 2, 3, 4]);
      t = foldHand(t, clock, log); // hand 1: big blind at seat 2
      t = foldHand(t, clock, log); // hand 2: big blind at seat 3
      expect(log[1]!.bb).toBe(3);
      t = sitOut(t, "rv-dodge-sb-u3", clock.tick()); // seat 3 owes the small blind next hand
      t = foldHand(t, clock, log); // hand 3: dead small blind
      expect([log[2]!.sb, log[2]!.smallBlindBy, log[2]!.bb]).toEqual([null, null, 4]);
      expect(t.players[3]!.missedBlind).toBe(true);
      t = sitIn(t, "rv-dodge-sb-u3", clock.tick());
      expect(t.players[3]!.waitingForBigBlind).toBe(true);
      for (let i = 0; i < 4; i++) t = foldHand(t, clock, log); // hands 4-7
      expect(log.slice(3, 6).map((h) => h.dealt.includes(3))).toEqual([false, false, false]);
      expect([log[6]!.bb, log[6]!.dealt.includes(3)]).toEqual([3, true]);
      expect(blindLedgerViolations(log)).toEqual([]);
    });

    it("across many orbits of a 5-handed game, a player who keeps toggling sit-out pays every blind it is dealt in for", () => {
      const clock = new Clock();
      const prefix = "rv-toggle";
      let t = seatTable(prefix, 6, [0, 1, 2, 3, 4], 5_000);
      const toggler = `${prefix}-u2`;
      const log: LedgerHand[] = [];
      const nextBigBlind = (table: EngineTable): number | null => {
        for (let i = 1; i <= table.maxSeats; i++) {
          const seat = (table.bbSeat! + i) % table.maxSeats;
          const p = table.players[seat];
          if (p && !p.sittingOut && p.stack > 0) return seat;
        }
        return null;
      };
      // Hands 2-20: sit out whenever the big blind is next (every other time).
      // Hands 21-45: sit out right after posting the big blind, to skip the small blind (every other time).
      // Hands 46-55: play straight. A sitting-out toggler always sits straight back in.
      const HANDS = 55;
      const dodge = { bigBlind: true, smallBlind: true };
      const attempts = { bigBlind: 0, smallBlind: 0 };
      for (let hand = 1; hand <= HANDS; hand++) {
        const me = t.players[2]!;
        if (hand > 1 && me.sittingOut) {
          t = sitIn(t, toggler, clock.tick());
        } else if (hand > 1 && hand <= 20 && nextBigBlind(t) === 2) {
          if (dodge.bigBlind) { t = sitOut(t, toggler, clock.tick()); attempts.bigBlind++; }
          dodge.bigBlind = !dodge.bigBlind;
        } else if (hand > 20 && hand <= 45 && t.bbSeat === 2) {
          if (dodge.smallBlind) { t = sitOut(t, toggler, clock.tick()); attempts.smallBlind++; }
          dodge.smallBlind = !dodge.smallBlind;
        }
        t = foldHand(t, clock, log);
      }
      expect(attempts.bigBlind).toBeGreaterThanOrEqual(2);
      expect(attempts.smallBlind).toBeGreaterThanOrEqual(2);
      expect(blindLedgerViolations(log)).toEqual([]);

      // Per-player blind totals: everyone who played paid blinds, the toggler included.
      const totals = new Map<string, { dealt: number; big: number; small: number }>();
      for (const hand of log) {
        for (const seat of hand.dealt) {
          const user = hand.seated.get(seat)!;
          const row = totals.get(user) ?? { dealt: 0, big: 0, small: 0 };
          row.dealt++;
          if (hand.bigBlindBy === user) row.big++;
          if (hand.smallBlindBy === user) row.small++;
          totals.set(user, row);
        }
      }
      for (const [user, row] of totals) check(row.big >= 2 && row.small >= 1, () => `${user}: ${JSON.stringify(row)}`);
      const mine = totals.get(toggler)!;
      expect(mine.dealt).toBeLessThan(HANDS);
      expect(mine.big).toBeGreaterThanOrEqual(3);
      // Every return to play after a missed blind begins with the toggler's big blind.
      const returns = log.filter((hand, i) => i > 0 && hand.dealt.includes(2) && !log[i - 1]!.dealt.includes(2));
      expect(returns.length).toBeGreaterThanOrEqual(attempts.bigBlind + attempts.smallBlind);
      for (const hand of returns) expect([hand.handNumber, hand.bigBlindBy]).toEqual([hand.handNumber, toggler]);

      // The ledger itself flags a dodge: deal the toggler into the hand right after its first dodge.
      const dodged = log.findIndex((h, i) => i > 0 && !h.dealt.includes(2) && log[i - 1]!.dealt.includes(2));
      const forgedLog = log.map((h, i) => (i === dodged + 1 ? { ...h, dealt: [...h.dealt, 2] } : h));
      expect(blindLedgerViolations(forgedLog).length).toBeGreaterThan(0);
    });
  });

  describe("dead-button rule: the button moves to the previous small blind's seat", () => {
    it("a gapped table (seats 0, 3, 6 of 9) records the real previous small blind as the button", () => {
      const clock = new Clock();
      const log: LedgerHand[] = [];
      let t = seatTable("rv-gap", 9, [0, 3, 6]);
      for (let i = 0; i < 4; i++) t = foldHand(t, clock, log);
      expect(log.map((h) => [h.dealer, h.sb, h.bb])).toEqual([[0, 3, 6], [3, 6, 0], [6, 0, 3], [0, 3, 6]]);
      log.slice(1).forEach((h, i) => expect(h.dealer).toBe(log[i]!.sb));
    });

    it("a dead button falls on the emptied seat when the previous small blind left", () => {
      const clock = new Clock();
      const log: LedgerHand[] = [];
      let t = seatTable("rv-deadbutton", 6, [0, 1, 3, 4]);
      t = foldHand(t, clock, log); // hand 1: button 0, small blind 1, big blind 3 (seat 2 is empty)
      expect([log[0]!.dealer, log[0]!.sb, log[0]!.bb]).toEqual([0, 1, 3]);
      t = leaveSeat(t, "rv-deadbutton-u1", clock.tick());
      t = startHand(t, clock.tick());
      // Hand 2: the button is dead on seat 1; seat 3 posts the small blind and seat 4 the big blind.
      expect([t.dealerSeat, t.players[1], t.sbSeat, t.bbSeat]).toEqual([1, null, 3, 4]);
      expect(started(t.audit!).dealerSeat).toBe(1);
      expect(t.dealtSeats).toEqual([3, 4, 0]);
      t = completeHand(playOut(t, foldAround, clock));
      t = startHand(t, clock.tick());
      expect([t.dealerSeat, t.sbSeat, t.bbSeat]).toEqual([3, 4, 0]);
    });
  });

  describe("heads-up transitions", () => {
    it("3->2 and 2->3 (with waiting newcomers) never give anyone two big blinds in a row, and heads-up the button posts the small blind", () => {
      const clock = new Clock();
      const log: LedgerHand[] = [];
      let t = seatTable("rv-hu", 6, [0, 2, 4]);
      t = foldHand(t, clock, log); // H1: button 0, blinds 2/4
      t = leaveSeat(t, "rv-hu-u4", clock.tick()); // the big blind leaves: 3 -> 2
      t = foldHand(t, clock, log); // H2
      t = foldHand(t, clock, log); // H3
      t = join(t, 5, "rv-hu-n1", 1_000); // 2 -> 3: the big blind reaches seat 5 next hand
      expect(t.players[5]!.waitingForBigBlind).toBe(true);
      for (let i = 0; i < 4; i++) t = foldHand(t, clock, log); // H4-H7
      t = leaveSeat(t, "rv-hu-n1", clock.tick()); // 3 -> 2 again
      t = foldHand(t, clock, log); // H8
      t = foldHand(t, clock, log); // H9
      t = join(t, 1, "rv-hu-n2", 1_000); // 2 -> 3: seat 1 is one seat past the next big blind (seat 0), so it waits a hand
      expect(t.players[1]!.waitingForBigBlind).toBe(true);
      t = foldHand(t, clock, log); // H10: still heads-up, seat 1 waits
      t = foldHand(t, clock, log); // H11: the big blind reaches seat 1
      t = leaveSeat(t, "rv-hu-u2", clock.tick()); // 3 -> 2
      for (let i = 0; i < 3; i++) t = foldHand(t, clock, log); // H12-H14

      expect(log.map((h) => h.dealt.length)).toEqual([3, 2, 2, 3, 3, 3, 3, 2, 2, 2, 3, 2, 2, 2]);
      log.forEach((hand, i) => {
        if (i > 0) check(hand.bigBlindBy !== log[i - 1]!.bigBlindBy, () => `hand #${hand.handNumber}: ${hand.bigBlindBy} posts the big blind twice in a row`);
        if (hand.dealt.length === 2) {
          check(hand.dealer === hand.sb && hand.smallBlindBy === hand.seated.get(hand.dealer), () => `hand #${hand.handNumber}: heads-up button is not the small blind`);
        }
      });
      // Each newcomer's first hand is its big blind.
      expect([log[3]!.bb, log[3]!.bigBlindBy]).toEqual([5, "rv-hu-n1"]);
      expect(log[9]!.dealt).not.toContain(1);
      expect([log[10]!.bb, log[10]!.bigBlindBy]).toEqual([1, "rv-hu-n2"]);
      expect(blindLedgerViolations(log)).toEqual([]);
    });
  });

  describe("a leaving player folds on their turn", () => {
    it("folds when a check is free (own turn), is not tabled, and is recorded as FOLD with auto LEAVE", async () => {
      const clock = new Clock();
      let t = seatTable("rv-leave", 6, [0, 1, 2]);
      t = startHand(t, clock.tick()); // button 0, blinds 1/2
      while (t.phase === "PREFLOP") t = move(t, passive(legalActions(t, t.toActSeat!)!), clock);
      expect([t.phase, t.toActSeat, legalActions(t, 1)!.actions.includes("CHECK")]).toEqual(["FLOP", 1, true]);
      t = leaveSeat(t, "rv-leave-u1", clock.tick());
      expect(actionRows(t).at(-1)).toEqual({ seatIndex: 1, action: "FOLD", auto: "LEAVE", timeout: false });
      expect(t.players[1]!.status).toBe("FOLDED");
      t = playOut(t, checkDown, clock);
      expect(showdownOf(t.audit!).shown.map((s) => s.seatIndex).sort()).toEqual([0, 2]);
      expect(verifyHandOutcome(t.audit!, sealedAudit(t.fairness!))).toEqual({ ok: true });
      for (const seat of t.dealtSeats) expect(await verifyParticipantAudit(json(participantAudit(t.audit!, sealedAudit(t.fairness!), seat)))).toEqual({ ok: true });
      const done = completeHand(t);
      expect(done.players[1]).toBeNull();
      expect(done.cashOuts).toContainEqual({ userId: "rv-leave-u1", stack: 990 });
    });

    it("a player who left off-turn folds when the free big-blind option comes round", () => {
      const clock = new Clock();
      let t = seatTable("rv-leave-bb", 6, [0, 1, 2]);
      t = startHand(t, clock.tick()); // button 0, blinds 1/2; seat 0 acts first
      t = leaveSeat(t, "rv-leave-bb-u2", clock.tick());
      expect(t.players[2]!.pendingLeave).toBe(true);
      t = move(t, { action: "CALL" }, clock);
      t = move(t, { action: "CALL" }, clock); // the big blind's free option: auto-fold for the leaver
      expect(actionRows(t)).toEqual([
        { seatIndex: 0, action: "CALL", auto: null, timeout: false },
        { seatIndex: 1, action: "CALL", auto: null, timeout: false },
        { seatIndex: 2, action: "FOLD", auto: "LEAVE", timeout: false },
      ]);
      expect(eventsOf(t.audit!, "PLAYER_STATUS").map((e) => e.data)).toEqual([{ seatIndex: 2, status: "LEAVE" }]);
      t = playOut(t, checkDown, clock);
      expect(showdownOf(t.audit!).shown.map((s) => s.seatIndex)).not.toContain(2);
      expect(verifyHandOutcome(t.audit!, sealedAudit(t.fairness!))).toEqual({ ok: true });
    });

    it("sitting back in cancels a pending leave: the player acts again and keeps the seat", () => {
      const clock = new Clock();
      let t = seatTable("rv-unleave", 6, [0, 1, 2]);
      t = startHand(t, clock.tick()); // button 0, blinds 1/2; seat 0 acts first
      t = leaveSeat(t, "rv-unleave-u2", clock.tick());
      expect([t.players[2]!.pendingLeave, t.players[2]!.sittingOut]).toEqual([true, true]);
      t = sitIn(t, "rv-unleave-u2", clock.tick());
      expect([t.players[2]!.pendingLeave, t.players[2]!.sittingOut]).toEqual([false, false]);
      expect(eventsOf(t.audit!, "PLAYER_STATUS").map((e) => e.data)).toEqual([
        { seatIndex: 2, status: "LEAVE" }, { seatIndex: 2, status: "SIT_IN" },
      ]);
      t = move(t, { action: "CALL" }, clock);
      t = move(t, { action: "CALL" }, clock);
      // The big blind's option is the player's own decision again: nothing is auto-played.
      expect(t.toActSeat).toBe(2);
      expect(actionRows(t).some((row) => row.seatIndex === 2)).toBe(false);
      t = playOut(t, checkDown, clock);
      expect(verifyHandOutcome(t.audit!, sealedAudit(t.fairness!))).toEqual({ ok: true });
      const done = completeHand(t);
      expect(done.players[2]).not.toBeNull();
      expect(done.cashOuts.some((c) => c.userId === "rv-unleave-u2")).toBe(false);
    });

    it.each([false, true])("stranded-pot guard: A all-in short, B and C deeper and equal; B leaves and folds, the hand runs out and C is not forced to fold (C also leaving: %p)", async (cLeaves) => {
      const chips = 2_100;
      // B leaves on its turn with a free check and folds: C still contests every pot. (C, if leaving, left off turn.)
      const t = strandedPotHand(cLeaves);
      expect(t.phase).toBe("SHOWDOWN");
      const record = t.audit!;
      const put = [0, 1, 2].map((seat) => [...blinds(record), ...actions(record)].filter((x) => x.seatIndex === seat).reduce((sum, x) => sum + x.amount, 0));
      expect(put).toEqual([100, 300, 300]);
      if (cLeaves) expect(eventsOf(record, "PLAYER_STATUS").map((e) => e.data)).toEqual([{ seatIndex: 2, status: "LEAVE" }, { seatIndex: 1, status: "LEAVE" }]);
      expect(actionRows(t).filter((a) => a.auto !== null)).toEqual([{ seatIndex: 1, action: "FOLD", auto: "LEAVE", timeout: false }]);
      expect(t.players[2]!.status).toBe("ACTIVE");
      expect(eventsOf(record, "STREET_DEALT").filter((e) => (e.data as unknown as StreetData).runout).length).toBe(1);
      expect(showdownOf(record).shown.map((s) => s.seatIndex).sort()).toEqual([0, 2]);
      const pots = awards(record).pots;
      expect(pots.map((p) => [p.amount, p.eligibleSeatIndexes])).toEqual([[300, [0, 2]], [400, [2]]]);
      expect(pots[1]!.winnerSeatIndexes).toEqual([2]);
      expect(settled(record).stacks.reduce((sum, s) => sum + s.stack, 0)).toBe(chips);
      expect(verifyHandOutcome(record, sealedAudit(t.fairness!))).toEqual({ ok: true });
      expect((await verifySealedAudit(record, sealedAudit(t.fairness!))).ok).toBe(true);
      for (const seat of t.dealtSeats) expect(await verifyParticipantAudit(json(participantAudit(record, sealedAudit(t.fairness!), seat)))).toEqual({ ok: true });
      const done = completeHand(t);
      const left = done.cashOuts.reduce((sum, c) => sum + c.stack, 0) + done.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0);
      expect(left).toBe(chips);
      expect(done.cashOuts.map((c) => c.userId)).toContain("rv-strand-b");
      if (cLeaves) expect(done.cashOuts.map((c) => c.userId)).toContain("rv-strand-c");
    });
  });

  describe("auto-actions are recorded truthfully", () => {
    it("a voluntary sit-out records CHECK/FOLD with auto SIT_OUT; only a real time-out records TIMEOUT_*", async () => {
      const clock = new Clock();
      let t = seatTable("rv-auto", 6, [0, 1, 2, 3]);
      t = startHand(t, clock.tick()); // button 0, blinds 1/2, seat 3 acts first
      expect(t.toActSeat).toBe(3);
      t = sitOut(t, "rv-auto-u3", clock.tick()); // own turn, facing the big blind
      t = move(t, "TIMEOUT", clock); // seat 0: real time-out facing the big blind, and sat out (TIMEOUT)
      t = move(t, { action: "CALL" }, clock); // seat 1
      expect(t.toActSeat).toBe(2);
      t = sitOut(t, "rv-auto-u2", clock.tick()); // own turn, free check: stays in the hand
      expect([t.phase, t.toActSeat]).toEqual(["FLOP", 1]);
      // Real time-out with a free check: seat 1 is sat out too, so from here the
      // sat-out cascade checks both remaining hands down to a showdown, where
      // both keep their claim on the pot.
      t = move(t, "TIMEOUT", clock);
      expect(t.phase).toBe("SHOWDOWN");
      expect(t.board).toHaveLength(5);
      expect(t.players[0]).toMatchObject({ sittingOut: true, sittingOutReason: "TIMEOUT" });
      expect(t.players[1]).toMatchObject({ sittingOut: true, sittingOutReason: "TIMEOUT" });
      expect(t.players[2]).toMatchObject({ sittingOut: true, sittingOutReason: "SELF" });
      expect(t.players[1]!.showedCards && t.players[2]!.showedCards).toBe(true);
      expect(actionRows(t)).toEqual([
        { seatIndex: 3, action: "FOLD", auto: "SIT_OUT", timeout: false },
        { seatIndex: 0, action: "TIMEOUT_FOLD", auto: null, timeout: true },
        { seatIndex: 1, action: "CALL", auto: null, timeout: false },
        { seatIndex: 2, action: "CHECK", auto: "SIT_OUT", timeout: false },
        { seatIndex: 1, action: "TIMEOUT_CHECK", auto: null, timeout: true },
        { seatIndex: 2, action: "CHECK", auto: "SIT_OUT", timeout: false },
        { seatIndex: 1, action: "CHECK", auto: "SIT_OUT", timeout: false },
        { seatIndex: 2, action: "CHECK", auto: "SIT_OUT", timeout: false },
        { seatIndex: 1, action: "CHECK", auto: "SIT_OUT", timeout: false },
        { seatIndex: 2, action: "CHECK", auto: "SIT_OUT", timeout: false },
      ]);
      // Every sit-out, the clock's included, is in the audit trail as a status change.
      expect(t.audit!.events.filter((e) => e.type === "PLAYER_STATUS").map((e) => e.data)).toEqual([
        { seatIndex: 3, status: "SIT_OUT" }, { seatIndex: 0, status: "SIT_OUT" }, { seatIndex: 2, status: "SIT_OUT" }, { seatIndex: 1, status: "SIT_OUT" },
      ]);
      expect(verifyHandOutcome(t.audit!, sealedAudit(t.fairness!))).toEqual({ ok: true });
      for (const seat of t.dealtSeats) expect(await verifyParticipantAudit(json(participantAudit(t.audit!, sealedAudit(t.fairness!), seat)))).toEqual({ ok: true });
    });
  });

  describe("no-op toggles", () => {
    it("sitOut, sitIn and leaveSeat that change nothing return the same table object and append no audit event", () => {
      const clock = new Clock();
      let t = seatTable("rv-noop", 6, [0, 1, 2, 3]);
      // Between hands.
      expect(sitIn(t, "rv-noop-u1", clock.tick())).toBe(t);
      let out = sitOut(t, "rv-noop-u1", clock.tick());
      expect(sitOut(out, "rv-noop-u1", clock.tick())).toBe(out);
      out = sitIn(out, "rv-noop-u1", clock.tick());
      // During a hand, for a player dealt in.
      t = startHand(out, clock.tick());
      const idle = t.players.find((p) => p && p.seatIndex !== t.toActSeat && p.status === "ACTIVE")!.userId;
      const events = t.audit!.events.length;
      expect(sitIn(t, idle, clock.tick())).toBe(t);
      const away = sitOut(t, idle, clock.tick());
      expect(away.audit!.events.length).toBe(events + 1); // one PLAYER_STATUS
      expect(sitOut(away, idle, clock.tick())).toBe(away);
      const leaving = leaveSeat(away, idle, clock.tick());
      expect(leaving.audit!.events.length).toBe(events + 2);
      expect(leaveSeat(leaving, idle, clock.tick())).toBe(leaving);
      expect(sitOut(leaving, idle, clock.tick())).toBe(leaving);
      expect(leaving.audit!.events.length).toBe(events + 2);
    });
  });
});

// ===========================================================================
// 5. upgradeTableState
// ===========================================================================

type Loose = Record<string, unknown>;
const OUTSIDER = "rv-outsider";

/**
 * The shape the previous engine version persisted: no audit, chain-tip,
 * chip-total, small-blind-position or wait-for-big-blind fields; fairness
 * without a hand id (context "poker-deck-v1"); and the retired seed
 * protocol's pendingShuffle.
 */
function legacyShape(t: EngineTable): EngineTable {
  const l = clone(t) as unknown as Loose & { players: (Loose | null)[]; fairness: Loose | null };
  delete l.audit;
  delete l.auditChainTip;
  delete l.handChipTotal;
  delete l.smallBlindPosition;
  for (const p of l.players) {
    if (!p) continue;
    delete p.waitingForBigBlind;
    delete p.missedBlind;
  }
  if (l.fairness) {
    const { root, deck, salts, levels } = l.fairness;
    l.fairness = { context: JSON.stringify(["poker-deck-v1", t.tableId, t.handNumber]), root, deck, salts, levels };
  }
  l.pendingShuffle = { serverSeed: "5e".repeat(32), serverSeedHash: "a7".repeat(32), clientSeeds: {} };
  return l as unknown as EngineTable;
}

/**
 * The previous version's Hand Clean-up: it removed leavers and busted players
 * but purged nothing. A leftover log line that names cards is appended too.
 */
function previousCleanup(t: EngineTable): EngineTable {
  const l = clone(t);
  l.phase = "WAITING";
  l.status = "WAITING";
  l.toActSeat = null;
  l.turnStartedAt = null;
  for (const p of l.players) {
    if (!p) continue;
    if (p.pendingLeave || p.stack <= 0) {
      l.cashOuts.push({ userId: p.userId, stack: Math.max(p.stack, 0) });
      l.players[p.seatIndex] = null;
    }
  }
  l.logSeq += 1;
  l.log.push({ seq: l.logSeq, seatIndex: null, username: "Table", text: "Flop As Kd 2c", at: new Date(T0).toISOString() });
  return l;
}

const CARD_TOKEN = /^[2-9TJQKA][cdhs]$/;
const cardTokens = (value: unknown): string[] => JSON.stringify(value).split(/[^0-9A-Za-z]+/).filter((token) => CARD_TOKEN.test(token));

function viewersOf(t: EngineTable): (string | null)[] {
  return [...t.players.flatMap((p) => (p ? [p.userId] : [])), ...t.cashOuts.map((c) => c.userId), null, OUTSIDER];
}

async function expectCleanForEveryViewer(t: EngineTable): Promise<void> {
  for (const viewer of viewersOf(t)) {
    const state = projectTableState(t, viewer);
    expect(await verifyTableCards(json(state))).toBe(true);
    expect(cardTokens(state)).toEqual([]);
  }
}

/** Hand Clean-up state with every legacy field defaulted; `log` lists the only log lines allowed. */
function expectPurged(t: EngineTable, log: string[] = []): void {
  expect({ phase: t.phase, status: t.status, board: t.board, deck: t.deck, burns: t.burns, fairness: t.fairness, audit: t.audit, log: t.log.map((l) => l.text),
    dealtSeats: t.dealtSeats, pots: t.pots, potTotal: t.potTotal, winners: t.winners, handChipTotal: t.handChipTotal, toActSeat: t.toActSeat })
    .toEqual({ phase: "WAITING", status: "WAITING", board: [], deck: [], burns: [], fairness: null, audit: null, log, dealtSeats: [], pots: [], potTotal: 0, winners: [],
      handChipTotal: null, toActSeat: null });
  for (const p of t.players) {
    if (!p) continue;
    expect([p.holeCards, p.showedCards, p.handResult, p.committedThisHand, p.committedThisStreet]).toEqual([null, false, null, 0, 0]);
    expect([p.waitingForBigBlind, p.missedBlind]).toEqual([false, false]);
  }
  expect("pendingShuffle" in t).toBe(false);
  expect([t.auditChainTip, t.smallBlindPosition]).toEqual([null, null]);
}

/** Upgrading twice equals upgrading once, and the second pass voids nothing. */
function expectIdempotent(legacy: EngineTable): void {
  const once = upgradeTableState(clone(legacy)).table;
  const twice = upgradeTableState(clone(once));
  expect(twice.voidedHand).toBeNull();
  expect(twice.table).toEqual(once);
}

const stackTotal = (t: EngineTable): number => t.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0);

describe("5. upgradeTableState on state saved by the previous version", () => {
  it("WAITING with the previous hand's board, hole cards, commitments and log: purged, and every viewer's projection verifies", async () => {
    const clock = new Clock();
    let t = seatTable("rv-legacy-wait", 6, [0, 1, 2, 3]);
    t = startHand(t, clock.tick());
    t = playOut(t, checkDown, clock);
    const legacy = legacyShape(previousCleanup(t));
    expect(legacy.board.length).toBe(5);
    expect(legacy.players.filter((p) => p?.holeCards).length).toBe(4);
    // As saved, the state cannot be emitted at all.
    expect(() => projectTableState(legacy, "rv-legacy-wait-u0")).toThrow(EngineError);

    const { table, voidedHand } = upgradeTableState(clone(legacy));
    expect(voidedHand).toBeNull();
    expectPurged(table);
    expect(table.players.map((p) => p?.stack ?? null)).toEqual(legacy.players.map((p) => p?.stack ?? null));
    await expectCleanForEveryViewer(table);
    expectIdempotent(legacy);

    // The next hand starts from the upgraded state (startHand also upgrades raw legacy state).
    for (const start of [table, legacy]) {
      let next = startHand(clone(start), clock.tick());
      expect(next.audit!.previousHandHash).toBeNull();
      next = playOut(next, checkDown, clock);
      expect(verifyHandOutcome(next.audit!, sealedAudit(next.fairness!))).toEqual({ ok: true });
    }
  });

  it("a settled legacy SHOWDOWN runs Hand Clean-up: winnings kept, leavers cashed out", async () => {
    const clock = new Clock();
    let t = seatTable("rv-legacy-sd", 6, [0, 1, 2, 3]);
    t = startHand(t, clock.tick());
    t = leaveSeat(t, "rv-legacy-sd-u1", clock.tick()); // off turn; folds on its turn
    t = playOut(t, checkDown, clock);
    const final = new Map(settled(t.audit!).stacks.map((s) => [s.seatIndex, s.stack]));
    const legacy = legacyShape(t);
    const { table, voidedHand } = upgradeTableState(clone(legacy));
    expect(voidedHand).toBeNull();
    expectPurged(table);
    expect(table.players[1]).toBeNull();
    expect(table.cashOuts).toEqual([{ userId: "rv-legacy-sd-u1", stack: final.get(1) }]);
    for (const seat of [0, 2, 3]) expect(table.players[seat]!.stack).toBe(final.get(seat));
    await expectCleanForEveryViewer(table);
    expectIdempotent(legacy);
  });

  it.each(["PREFLOP", "TURN"] as const)("a legacy hand in flight at %s is voided: every bet returned, chips conserved, leavers cashed out", async (phase) => {
    const clock = new Clock();
    const id = `rv-legacy-${phase.toLowerCase()}`;
    let t = newTable(id, 6);
    for (const [seat, stack] of [[0, 1_000], [1, 1_000], [2, 1_000], [3, 25]] as const) t = join(t, seat, `${id}-u${seat}`, stack);
    t = startHand(t, clock.tick()); // button 0, blinds 1/2, seat 3 first
    const before = new Map(started(t.audit!).seats.map((row) => [row.userId, row.stack]));
    t = move(t, { action: "ALL_IN" }, clock); // seat 3, 25
    if (phase === "PREFLOP") {
      t = move(t, { action: "RAISE", amount: 60 }, clock); // seat 0
      t = leaveSeat(t, `${id}-u2`, clock.tick()); // off turn: pending leave
    } else {
      while (t.phase === "PREFLOP") t = move(t, passive(legalActions(t, t.toActSeat!)!), clock);
      t = move(t, { action: "BET", amount: 40 }, clock);
      while (t.phase === "FLOP") t = move(t, passive(legalActions(t, t.toActSeat!)!), clock);
      t = move(t, { action: "BET", amount: 80 }, clock);
      const leaverSeat = t.dealtSeats.find((s) => s !== t.toActSeat && t.players[s]!.status === "ACTIVE")!;
      t = leaveSeat(t, `${id}-u${leaverSeat}`, clock.tick()); // off turn: pending leave
    }
    t = join(t, 4, `${id}-new`, 800); // sat down mid-hand, not dealt in
    expect(t.phase).toBe(phase);
    const leaver = t.players.find((p) => p?.pendingLeave)!;
    expect(stackTotal(t)).toBeLessThan(3_025 + 800); // chips are in the pot

    const legacy = legacyShape(t);
    const { table, voidedHand } = upgradeTableState(clone(legacy));
    expect(voidedHand).toBe(1);
    expectPurged(table, ["Hand #1 was voided during a system upgrade; all bets were returned"]);
    expect(table.players[leaver.seatIndex]).toBeNull();
    expect(table.cashOuts).toEqual([{ userId: leaver.userId, stack: before.get(leaver.userId) }]);
    for (const p of table.players) if (p) expect(p.stack).toBe(before.get(p.userId) ?? 800);
    expect(stackTotal(table) + table.cashOuts.reduce((sum, c) => sum + c.stack, 0)).toBe(3_025 + 800);
    await expectCleanForEveryViewer(table);
    expectIdempotent(legacy);
    // Play resumes normally.
    let next = startHand(table, clock.tick());
    next = playOut(next, checkDown, clock);
    expect(verifyHandOutcome(next.audit!, sealedAudit(next.fairness!))).toEqual({ ok: true });
  });

  it("changes nothing in current-format state at any phase", () => {
    const clock = new Clock();
    const states: [string, EngineTable][] = [["empty table", newTable("rv-current-empty", 6)]];
    let t = seatTable("rv-current", 6, [0, 1, 2, 3, 4]);
    states.push(["seated, never played", t]);
    t = startHand(t, clock.tick());
    t = leaveSeat(t, t.players.find((p) => p && p.seatIndex !== t.toActSeat)!.userId, clock.tick());
    t = join(t, 5, "rv-current-new", 1_000);
    for (const phase of ["PREFLOP", "FLOP", "TURN", "RIVER"] as const) {
      while (t.phase !== phase) t = move(t, passive(legalActions(t, t.toActSeat!)!), clock);
      states.push([phase, t]);
    }
    t = playOut(t, checkDown, clock);
    states.push(["SHOWDOWN", t]);
    t = completeHand(t);
    t = sitOut(t, t.players.find((p) => p && !p.waitingForBigBlind)!.userId, clock.tick());
    states.push(["WAITING with a waiting newcomer and a sitter", t]);
    t = startHand(t, clock.tick());
    t = playOut(t, foldAround, clock);
    states.push(["SHOWDOWN after a fold", t]);
    states.push(["WAITING after clean-up", completeHand(t)]);
    for (const [name, state] of states) {
      const before = clone(state);
      const result = upgradeTableState(state);
      check(result.voidedHand === null, () => `${name}: voided hand ${result.voidedHand}`);
      expect({ name, table: result.table }).toEqual({ name, table: before });
    }
  });
});

// ===========================================================================
// 6. Leak guard: exact client schema
// ===========================================================================

function expectLeakBlocked(fn: () => unknown, where: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  check(caught instanceof EngineError && caught.code === "LEAK_BLOCKED", () => `${where}: expected LEAK_BLOCKED, got ${String(caught)}`);
  expect((caught as EngineError).message).toMatch(/outside the client schema|unexpected object/);
}

describe("6. leak guard: exact client-schema allow-list", () => {
  const clock = new Clock();
  const phases: [string, EngineTable][] = [];
  let t = seatTable("rv-schema", 6, [0, 1, 2, 3]);
  t = foldHand(t, clock);
  t = join(t, 5, "rv-schema-new", 1_000);
  phases.push(["WAITING", t]);
  t = startHand(t, clock.tick());
  for (const phase of ["PREFLOP", "FLOP", "TURN", "RIVER"] as const) {
    while (t.phase !== phase) t = move(t, passive(legalActions(t, t.toActSeat!)!), clock);
    phases.push([phase, t]);
  }
  phases.push(["SHOWDOWN", playOut(t, checkDown, clock)]);
  let f = startHand(completeHand(playOut(t, checkDown, clock)), clock.tick());
  f = playOut(f, foldOn("FLOP"), clock);
  phases.push(["SHOWDOWN (fold)", f]);

  it("accepts the legitimate payload of every phase for every viewer", () => {
    expect(phases.map(([phase]) => phase)).toEqual(["WAITING", "PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN", "SHOWDOWN (fold)"]);
    for (const [phase, table] of phases) {
      for (const viewer of viewersOf(table)) {
        let error: unknown = null;
        try {
          assertViewerStateSafe(json(projectTableState(table, viewer)), table, viewer);
        } catch (caught) {
          error = caught;
        }
        check(error === null, () => `${phase}, viewer ${String(viewer)}: ${String(error)}`);
      }
    }
  });

  type Site = [string, (s: PublicTableState & Loose) => boolean];
  const sites: Site[] = [
    ["the top level", (s) => { s.debugBuild = "7"; return true; }],
    ["the top level (an object)", (s) => { s.serverInfo = { region: "eu" }; return true; }],
    ["players[i]", (s) => { (s.players[0] as unknown as Loose).note = "ok"; return true; }],
    ["an empty seat's player view", (s) => { const empty = s.players.find((p) => p.empty); if (!empty) return false; (empty as unknown as Loose).reserved = true; return true; }],
    ["fairness", (s) => { if (!s.fairness) return false; (s.fairness as unknown as Loose).seedHint = "1"; return true; }],
    ["fairness.proofs[i]", (s) => { const proof = s.fairness?.proofs[0]; if (!proof) return false; (proof as unknown as Loose).depth = 6; return true; }],
    ["logTail[i]", (s) => { const entry = s.logTail[0]; if (!entry) return false; (entry as unknown as Loose).raw = "x"; return true; }],
    ["pots[i]", (s) => { const pot = s.pots[0]; if (!pot) return false; (pot as unknown as Loose).eligible = [0, 1]; return true; }],
    ["actorLegal", (s) => { if (!s.actorLegal) return false; (s.actorLegal as unknown as Loose).hint = "call"; return true; }],
    ["winners[i]", (s) => { const winner = s.winners[0]; if (!winner) return false; (winner as unknown as Loose).cards = 2; return true; }],
  ];

  it.each(sites)("throws LEAK_BLOCKED for an unknown key inside %s", (name, inject) => {
    let injected = 0;
    for (const [phase, table] of phases) {
      for (const viewer of viewersOf(table)) {
        const state = json(projectTableState(table, viewer)) as PublicTableState & Loose;
        if (!inject(state)) continue;
        injected++;
        expectLeakBlocked(() => assertViewerStateSafe(state, table, viewer), `${name}, ${phase}, viewer ${String(viewer)}`);
      }
    }
    expect(injected).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Per-table chain link
// ===========================================================================

describe("verifyTableChainLink", () => {
  it("links each hand to the table's previous audited hand and detects a deleted or replaced hand", () => {
    const clock = new Clock();
    let t = seatTable("rv-chain", 6, [0, 1, 2]);
    const records: HandAuditRecord[] = [];
    for (let i = 0; i < 3; i++) {
      t = startHand(t, clock.tick());
      t = playOut(t, foldAround, clock);
      records.push(clone(t.audit!));
      t = completeHand(t);
    }
    const [first, second, third] = [records[0]!, records[1]!, records[2]!];
    expect(verifyTableChainLink(first, null)).toEqual({ ok: true });
    expect(verifyTableChainLink(second, first.finalStateHash)).toEqual({ ok: true });
    expect(verifyTableChainLink(third, second.finalStateHash)).toEqual({ ok: true });
    expect(verifyTableChainLink(third, first.finalStateHash).ok).toBe(false); // hand 2 deleted
    expect(verifyTableChainLink(second, null).ok).toBe(false); // hand 1 deleted
    expect(verifyTableChainLink(first, second.finalStateHash).ok).toBe(false); // reordered
  });
});
