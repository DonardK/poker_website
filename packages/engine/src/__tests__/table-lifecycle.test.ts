/**
 * Table lifecycle: the idle warning, closing idle and empty tables, and the
 * host leaving.
 *
 * WHAT IS PROVEN HERE
 * 1. closeTable FINISHES a hand in progress; it never voids or abandons it.
 *    This holds on every street, with the action checked to a player or
 *    facing a bet, with an all-in player, with a player who had already
 *    clicked leave, and with seated players who were not dealt in. The forced
 *    hand is an ordinary audited hand: verifyAuditRecord (settled),
 *    verifySealedAudit, verifyHandOutcome and every participant's audit
 *    (checked against what that player saw live) accept it. Closure appends
 *    exactly one SIT_OUT status for each dealt player who was still playing,
 *    then only automatic checks and folds, recorded truthfully (never as
 *    time-outs). A player who had clicked leave keeps LEAVE semantics.
 * 2. Chips. The chips the table holds (stacks, the unsettled pot, unpaid
 *    cash-outs) are identical before closeTable and after Hand Clean-up.
 *    Every player is cashed out exactly once, with exactly their final stack
 *    (the sealed record's settled stack for a dealt player). A dealt seat is
 *    never released before the hand is recorded. A hand whose chips do not
 *    add up is refused, with the input untouched.
 * 3. closeIfEmpty (requirements 1 and 2). A host alone who leaves closes the
 *    table (EMPTY) with the buy-in returned. A host who leaves while others
 *    sit, between hands or mid-hand, changes nothing: play continues. The
 *    last player to leave closes the table.
 * 4. Guards. Once closure has begun, sitDown, sitIn, keepTableOpen and
 *    startHand are refused (TABLE_CLOSING). During the idle warning no hand
 *    is dealt, but players can still sit down and act.
 * 5. Idle clock. Only recordActivity and keepTableOpen touch it (sitDown
 *    starts the newcomer's own clock). No betting, time-out, sit-out, leave
 *    or clean-up transition does, and the server decides what counts as
 *    activity. beginIdleWarning leaves a running hand exactly as it was.
 *    keepTableOpen is for seated humans who are not leaving.
 *    Per player (round 2): recordActivity restarts the named player's own
 *    clock, and idleSince runs from the humans still at the table (seated,
 *    not leaving), so a player who acted and then left, or a bot, never keeps
 *    it open. clearIdleWarning drops only the warning.
 * 6. upgradeTableState on state saved before these fields existed: defaults
 *    (a legacy player gets the table's clock), deterministic for a given
 *    fallback time, idempotent.
 * 7. The projection's two new fields pass the leak guard for tables in the
 *    warning, closing and closed states, for every viewer. The server-only
 *    lifecycle fields are never sent, and injecting them is refused.
 *
 * FALSE-FAILURE BUDGET. After the point of closure the scripted hands only
 * check and fold, so none of their assertions depends on the cards. The
 * random sweep asserts invariants that hold for every deal. Its one coverage
 * assertion is that each street was a close point at least once. It targets
 * each street in exactly SWEEP / 5 hands. A targeted hand misses the river
 * only if all players but one fold, or an all-in ends the betting, before
 * then. The driver mostly checks and calls, so that happens in well under
 * 3/4 of hands. The chance that all 60 river targets miss is below
 * 0.75^60 < 4e-8.
 */
import {
  TABLE_IDLE_WARNING_MS,
  verifyAuditRecord,
  verifyParticipantAudit,
  verifySealedAudit,
  verifyTableCards,
  type PublicTableState,
} from "@poker/shared";
import { participantAudit, sealedAudit, verifyHandOutcome } from "../audit.js";
import { legalActions } from "../legal.js";
import { assertViewerStateSafe, projectTableState } from "../public.js";
import {
  applyAction,
  beginIdleWarning,
  clearIdleWarning,
  closeIfEmpty,
  closeTable,
  completeHand,
  createTable,
  idleSince,
  keepTableOpen,
  leaveSeat,
  recordActivity,
  sitDown,
  sitIn,
  sitOut,
  startHand,
  upgradeTableState,
} from "../table.js";
import { EngineError, type CreateTableConfig, type EnginePlayer, type EngineTable } from "../types.js";
import {
  checkDown,
  Clock,
  EvidenceRecorder,
  foldAround,
  isBetting,
  join,
  move,
  newTable,
  passive,
  playOut,
  T0,
  type Chooser,
} from "./helpers/drive.js";
import { actions, awards, clone, eventsOf, settled, type StreetData } from "./helpers/forge.js";
import { chance, pick, randInt, randomIntent, STREETS, type Street } from "./helpers/simulate.js";

type Loose = Record<string, unknown>;
type Viewer = string | null;

const OUTSIDER = "lc-outsider";
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function check(condition: unknown, message: () => string): asserts condition {
  if (!condition) throw new Error(message());
}

function expectEngineError(fn: () => unknown, code: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  check(caught instanceof EngineError, () => `expected EngineError ${code}, got ${String(caught)}`);
  expect((caught as EngineError).code).toBe(code);
}

/**
 * The chips the table holds, re-derived here from the rules: every stack,
 * the chips committed to a pot that is not settled yet, and cash-outs not yet
 * paid. (At SHOWDOWN the committed chips are already in the stacks.)
 */
function chipsHeld(t: EngineTable): number {
  const unsettled = isBetting(t);
  return t.players.reduce((sum, p) => sum + (p ? p.stack + (unsettled ? p.committedThisHand : 0) : 0), 0) +
    t.cashOuts.reduce((sum, cash) => sum + cash.stack, 0);
}

const seatedPlayers = (t: EngineTable): EnginePlayer[] => t.players.filter((p): p is EnginePlayer => p !== null);

let serial = 0;
/** A fresh table with one human per stack, in seats 0, 1, 2... */
function seated(label: string, stacks: readonly number[], maxSeats = 6): EngineTable {
  const id = `lc-${label}-${++serial}`;
  let t = newTable(id, maxSeats);
  stacks.forEach((stack, seat) => {
    t = join(t, seat, `${id}-u${seat}`, stack);
  });
  return t;
}

const newcomer = (userId: string, stack = 1_000) => ({
  userId, username: `Player-${userId}`, avatarHue: 0, kind: "HUMAN" as const, botProfile: null, buyIn: stack, skipBuyInCheck: true,
});

/** Every current and former player, an anonymous spectator and an authenticated outsider. */
function viewersOf(...tables: EngineTable[]): Viewer[] {
  const ids = new Set<string>();
  for (const t of tables) {
    for (const p of t.players) if (p) ids.add(p.userId);
    for (const cash of t.cashOuts) ids.add(cash.userId);
  }
  return [...ids, null, OUTSIDER];
}

/** projectTableState and the leak guard accept the table for every viewer, the new fields are right, and every card verifies. */
async function expectProjectable(t: EngineTable, viewers: Viewer[]): Promise<PublicTableState[]> {
  const states: PublicTableState[] = [];
  for (const viewer of viewers) {
    let state: PublicTableState | null = null;
    let error: unknown = null;
    try {
      state = json(projectTableState(t, viewer));
      assertViewerStateSafe(state, t, viewer);
    } catch (caught) {
      error = caught;
    }
    check(error === null && state !== null, () => `${t.tableId} ${t.phase}/${t.status}, viewer ${String(viewer)}: ${String(error)}`);
    expect(state.status).toBe(t.status);
    expect(state.closeReason).toBe(t.closeReason ?? null);
    if (t.closingAt == null) expect(state.closingInMs).toBeNull();
    else expect(state.closingInMs).toBeGreaterThanOrEqual(0);
    const raw = JSON.stringify(state);
    for (const secret of ["lastActivityAt", "closingAt"]) expect(raw).not.toContain(`"${secret}"`);
    expect(await verifyTableCards(state)).toBe(true);
    states.push(state);
  }
  return states;
}

/** A settled hand verifies end to end: chain, cards, outcome, and every participant against what they saw live. */
async function expectHandVerifies(t: EngineTable, evidence?: EvidenceRecorder): Promise<void> {
  const record = clone(t.audit!);
  const sealed = sealedAudit(t.fairness!);
  expect(await verifyAuditRecord(record, { requireSettled: true })).toEqual({ ok: true });
  expect((await verifySealedAudit(record, sealed)).ok).toBe(true);
  expect(verifyHandOutcome(record, sealed)).toEqual({ ok: true });
  for (const seat of t.dealtSeats) {
    const observed = evidence ? await evidence.observed(record.handId, t.players[seat]!.userId) : {};
    const result = await verifyParticipantAudit(json(participantAudit(record, sealed, seat)), observed);
    check(result.ok, () => `seat ${seat}: ${result.reason}`);
  }
}

/**
 * The events closure appended: first one SIT_OUT status for each dealt player
 * who was still playing (seat order), then only automatic checks and folds
 * that put no chips in. They are recorded as LEAVE for players who had clicked
 * leave and as SIT_OUT otherwise, never as time-outs.
 */
function expectClosureEventsTruthful(before: EngineTable, closing: EngineTable): void {
  const appended = closing.audit!.events.slice(before.audit!.events.length);
  const playing = [...before.dealtSeats].sort((a, b) => a - b).filter((seat) => !before.players[seat]!.sittingOut);
  expect(appended.slice(0, playing.length).map((e) => [e.type, e.data])).toEqual(playing.map((seatIndex) => ["PLAYER_STATUS", { seatIndex, status: "SIT_OUT" }]));
  expect(appended.slice(playing.length).some((e) => e.type === "PLAYER_STATUS")).toBe(false);
  const forced = actions({ ...closing.audit!, events: appended });
  for (const act of forced) {
    expect({ seat: act.seatIndex, action: ["CHECK", "FOLD"].includes(act.action), amount: act.amount, timeout: act.timeout, auto: act.auto })
      .toEqual({ seat: act.seatIndex, action: true, amount: 0, timeout: false, auto: before.players[act.seatIndex]!.pendingLeave ? "LEAVE" : "SIT_OUT" });
  }
  expect(eventsOf(closing.audit!, "BLIND_POSTED").length).toBe(eventsOf(before.audit!, "BLIND_POSTED").length);
}

interface Closed {
  /** closeTable's result: SHOWDOWN with every player leaving, or CLOSED between hands. */
  closing: EngineTable;
  /** After Hand Clean-up and closeIfEmpty: CLOSED, every seat empty, everyone paid. */
  closed: EngineTable;
}

/**
 * Close `t` for inactivity and check everything that must hold in every
 * phase: the input is untouched, a hand in progress settles and verifies, no
 * dealt seat is released early, players not dealt in are paid in full at
 * once, chips are conserved through Hand Clean-up, every player is paid
 * exactly once with their final stack, and every viewer's projection passes
 * the leak guard.
 */
async function closeAndVerify(t: EngineTable, clock: Clock, evidence?: EvidenceRecorder): Promise<Closed> {
  const before = clone(t);
  const chips = chipsHeld(t);
  const viewers = viewersOf(t);
  const closing = closeTable(t, "IDLE", clock.tick());
  expect(t).toEqual(before);
  expect([closing.closeReason, closing.closingAt]).toEqual(["IDLE", null]);
  evidence?.capture(closing);

  const handRunning = isBetting(before) || before.phase === "SHOWDOWN";
  const undealt = seatedPlayers(before).filter((p) => !handRunning || !before.dealtSeats.includes(p.seatIndex));
  if (handRunning) {
    expect([closing.phase, closing.status]).toEqual(["SHOWDOWN", "IN_HAND"]);
    // A dealt seat stays occupied until Hand Clean-up: the hand is recorded from these seats.
    expect(closing.dealtSeats).toEqual(before.dealtSeats);
    for (const seat of before.dealtSeats) expect(closing.players[seat]?.userId).toBe(before.players[seat]!.userId);
    for (const p of seatedPlayers(closing)) expect([p.seatIndex, p.pendingLeave, p.sittingOut]).toEqual([p.seatIndex, true, true]);
    // The record is append-only: nothing already recorded changes.
    expect(closing.audit!.events.slice(0, before.audit!.events.length)).toEqual(before.audit!.events);
    if (before.phase === "SHOWDOWN") {
      expect(closing.audit).toEqual(before.audit);
      expect(closing.cashOuts).toEqual(before.cashOuts);
    } else {
      // Not dealt in: nothing at stake, paid in full now.
      for (const p of undealt) expect(closing.players[p.seatIndex]).toBeNull();
      expect(closing.cashOuts).toEqual([...before.cashOuts, ...undealt.map((p) => ({ userId: p.userId, stack: p.stack }))]);
      expectClosureEventsTruthful(before, closing);
    }
    await expectHandVerifies(closing, evidence);
  } else {
    expect(closing.status).toBe("CLOSED");
    expect(closing.cashOuts).toEqual([...before.cashOuts, ...undealt.map((p) => ({ userId: p.userId, stack: p.stack }))]);
  }

  const done = closing.phase === "SHOWDOWN" ? completeHand(closing) : closing;
  const closed = closeIfEmpty(done);
  if (closing.status === "CLOSED") expect(closed).toBe(closing);
  expect([closed.status, closed.closeReason, closed.closingAt, closed.phase]).toEqual(["CLOSED", "IDLE", null, "WAITING"]);
  expect(closed.players.every((p) => p === null)).toBe(true);
  expect(closed.log.at(-1)?.text).toBe("Table closed");

  // Chips: identical before closeTable and after Hand Clean-up.
  expect(chipsHeld(closed)).toBe(chips);
  // Every player who was seated is paid exactly once, with exactly their final stack.
  const paid = closed.cashOuts.slice(before.cashOuts.length);
  expect(paid.map((cash) => cash.userId).sort()).toEqual(seatedPlayers(before).map((p) => p.userId).sort());
  const final = new Map(undealt.map((p) => [p.userId, p.stack]));
  if (handRunning) for (const row of settled(closing.audit!).stacks) final.set(before.players[row.seatIndex]!.userId, row.stack);
  for (const cash of paid) expect([cash.userId, cash.stack]).toEqual([cash.userId, final.get(cash.userId)]);

  await expectProjectable(closing, viewers);
  await expectProjectable(closed, viewers);
  return { closing, closed };
}

/** Deal a hand and record what every dealt player sees. */
function deal(t: EngineTable, clock: Clock, evidence: EvidenceRecorder): EngineTable {
  const next = startHand(t, clock.tick());
  evidence.capture(next);
  return next;
}

function checkOrCall(t: EngineTable, clock: Clock): EngineTable {
  return move(t, passive(legalActions(t, t.toActSeat!)!), clock);
}

const shownSeats = (t: EngineTable): number[] =>
  ((eventsOf(t.audit!, "SHOWDOWN")[0]?.data.shown ?? []) as unknown as { seatIndex: number }[]).map((s) => s.seatIndex).sort((a, b) => a - b);

// ===========================================================================
// 1-2. closeTable mid-hand: finished by the sit-out rule, audited, conserving
// ===========================================================================

describe("closeTable finishes a hand in progress and every audit verifies it", () => {
  const cases = STREETS.flatMap((street) => [[street, false], [street, true]] as [Street, boolean][]);

  // Four players, 1,000 each: button 0, blinds 1/2, seat 3 acts first preflop and seat 1 after the flop.
  it.each(cases)("on the %s (facing a bet: %p): every dealt player sits out and the hand runs to settlement", async (street, facingBet) => {
    const clock = new Clock();
    const evidence = new EvidenceRecorder();
    let t = deal(seated(`street-${street.toLowerCase()}`, [1_000, 1_000, 1_000, 1_000]), clock, evidence);
    expect([t.dealerSeat, t.sbSeat, t.bbSeat, t.toActSeat]).toEqual([0, 1, 2, 3]);
    let winner: number | null = null;
    if (street === "PREFLOP") {
      // Facing a bet: the first actor faces the big blind as dealt. Otherwise call round to the big blind's free option.
      if (facingBet) winner = 2;
      else while (t.toActSeat !== t.bbSeat) t = checkOrCall(t, clock);
    } else {
      while (t.phase !== street) t = checkOrCall(t, clock);
      if (facingBet) {
        winner = t.toActSeat!;
        t = move(t, { action: "BET", amount: legalActions(t, winner)!.minBet }, clock);
      }
    }
    expect([t.phase, legalActions(t, t.toActSeat!)!.actions.includes("CHECK")]).toEqual([street, !facingBet]);
    evidence.capture(t);

    const { closing } = await closeAndVerify(t, clock, evidence);
    const result = settled(closing.audit!);
    if (facingBet) {
      // Everyone facing the bet folds; the bettor (the big blind preflop) wins uncontested, and an uncalled bet comes back.
      expect([result.reason, closing.winners.map((w) => w.seatIndex)]).toEqual(["fold", [winner]]);
      expect(result.board.length).toBe(t.board.length);
    } else {
      // Nobody faces a bet, so everyone checks down and all four hands are tabled.
      expect([result.reason, result.board.length, shownSeats(closing)]).toEqual(["showdown", 5, [0, 1, 2, 3]]);
    }
  });

  it("an all-in player keeps every claim: players facing a bet fold, the board runs out, and the all-in hand is tabled", async () => {
    const clock = new Clock();
    const evidence = new EvidenceRecorder();
    let t = deal(seated("allin-flop", [1_000, 1_000, 1_000, 60]), clock, evidence);
    t = move(t, { action: "ALL_IN" }, clock); // seat 3: 60
    t = move(t, { action: "CALL" }, clock); // seat 0
    t = move(t, { action: "CALL" }, clock); // seat 1
    t = move(t, { action: "CALL" }, clock); // seat 2
    expect([t.phase, t.toActSeat, t.players[3]!.status]).toEqual(["FLOP", 1, "ALL_IN"]);
    t = move(t, { action: "BET", amount: 100 }, clock); // seat 1; seat 2 faces it
    evidence.capture(t);

    const { closing } = await closeAndVerify(t, clock, evidence);
    const record = closing.audit!;
    expect(actions(record).slice(-2).map((a) => [a.seatIndex, a.action, a.auto])).toEqual([[2, "FOLD", "SIT_OUT"], [0, "FOLD", "SIT_OUT"]]);
    expect(eventsOf(record, "STREET_DEALT").filter((e) => (e.data as unknown as StreetData).runout).length).toBe(2); // turn and river
    expect([settled(record).reason, shownSeats(closing)]).toEqual(["showdown", [1, 3]]);
    const main = awards(record).pots[0]!;
    expect([main.amount, main.eligibleSeatIndexes]).toEqual([240, [1, 3]]);
    expect(awards(record).refunds).toEqual([{ seatIndex: 1, amount: 100 }]);
  });

  it("an all-in preflop with callers still to act: they fold and the all-in wins the blinds, the uncalled chips returned", async () => {
    const clock = new Clock();
    const evidence = new EvidenceRecorder();
    let t = deal(seated("allin-pre", [1_000, 1_000, 1_000, 60]), clock, evidence);
    t = move(t, { action: "ALL_IN" }, clock); // seat 3: 60; seat 0 to act
    evidence.capture(t);
    const { closing, closed } = await closeAndVerify(t, clock, evidence);
    expect([settled(closing.audit!).reason, closing.winners.map((w) => w.seatIndex)]).toEqual(["fold", [3]]);
    expect(closed.cashOuts.find((cash) => cash.userId === t.players[3]!.userId)!.stack).toBe(60 + 5 + 10);
  });

  it("a player who had already clicked leave keeps LEAVE semantics (folds even when a check is free) and is paid once", async () => {
    const clock = new Clock();
    const evidence = new EvidenceRecorder();
    let t = deal(seated("leaver", [1_000, 1_000, 1_000, 1_000]), clock, evidence);
    while (t.phase === "PREFLOP") t = checkOrCall(t, clock);
    expect(t.toActSeat).toBe(1);
    t = leaveSeat(t, t.players[2]!.userId, clock.tick()); // off turn: pending leave
    expect([t.players[2]!.pendingLeave, t.players[2]!.sittingOut]).toEqual([true, true]);
    evidence.capture(t);

    const { closing, closed } = await closeAndVerify(t, clock, evidence);
    const flop = actions(closing.audit!).filter((a) => a.auto !== null).slice(0, 4);
    expect(flop.map((a) => [a.seatIndex, a.action, a.auto])).toEqual([[1, "CHECK", "SIT_OUT"], [2, "FOLD", "LEAVE"], [3, "CHECK", "SIT_OUT"], [0, "CHECK", "SIT_OUT"]]);
    expect([settled(closing.audit!).reason, shownSeats(closing)]).toEqual(["showdown", [0, 1, 3]]);
    expect(closed.cashOuts.filter((cash) => cash.userId === t.players[2]!.userId)).toEqual([{ userId: t.players[2]!.userId, stack: 990 }]);
  });

  it("players not dealt in (sitting out, waiting for the big blind, joined mid-hand) are paid in full at once and never enter the record", async () => {
    const clock = new Clock();
    const evidence = new EvidenceRecorder();
    let t = seated("undealt", [1_000, 1_000, 1_000, 1_000]);
    t = completeHand(playOut(startHand(t, clock.tick()), foldAround, clock)); // button 0, blinds 1/2
    t = sitDown(t, 5, newcomer(`${t.tableId}-waits`, 700)); // waits for the big blind
    t = sitOut(t, t.players[0]!.userId, clock.tick());
    t = deal(t, clock, evidence);
    expect([...t.dealtSeats].sort()).toEqual([1, 2, 3]);
    expect(t.players[5]!.waitingForBigBlind).toBe(true);
    t = sitDown(t, 4, newcomer(`${t.tableId}-late`, 450)); // joined mid-hand
    while (t.phase !== "TURN") t = checkOrCall(t, clock);
    evidence.capture(t);

    const stacks = [0, 4, 5].map((seat) => t.players[seat]!.stack);
    const { closing } = await closeAndVerify(t, clock, evidence);
    for (const seat of [0, 4, 5]) expect(closing.players[seat]).toBeNull();
    expect(closing.cashOuts.slice(-3).map((cash) => cash.stack)).toEqual(stacks);
    const started = closing.audit!.events[0]!.data as unknown as { dealtSeats: number[] };
    expect([...started.dealtSeats].sort()).toEqual([1, 2, 3]);
    expect(closing.log.filter((entry) => entry.text.endsWith("leaves the table")).map((entry) => entry.seatIndex)).toEqual([0, 4, 5]);
  });

  it("a hand already settled at SHOWDOWN: the sealed record is untouched; everyone, including a newcomer, is paid by Hand Clean-up", async () => {
    const clock = new Clock();
    const evidence = new EvidenceRecorder();
    let t = deal(seated("showdown", [800, 1_200, 1_000]), clock, evidence);
    t = sitDown(t, 4, newcomer(`${t.tableId}-late`, 500));
    t = playOut(t, checkDown, clock, (s) => evidence.capture(s));
    const { closing } = await closeAndVerify(t, clock, evidence);
    expect(closing.players[4]).toMatchObject({ pendingLeave: true, holeCards: null });
  });

  it.each([["never played", false], ["after a hand, with a player sitting out", true]] as const)(
    "between hands (%s): every player is paid at once and the table is CLOSED", async (_name, played) => {
      const clock = new Clock();
      let t = seated(`waiting-${played ? "played" : "fresh"}`, [1_000, 400, 2_500]);
      if (played) {
        t = completeHand(playOut(startHand(t, clock.tick()), checkDown, clock));
        t = sitOut(t, t.players[1]!.userId, clock.tick());
      }
      const { closing } = await closeAndVerify(t, clock);
      expect(closing.status).toBe("CLOSED");
      expect(closing.log.map((entry) => entry.text).slice(-4)).toEqual([
        ...[0, 1, 2].map((seat) => `${t.players[seat]!.username} leaves the table`), "Table closed",
      ]);
    });

  it("closure is final: closing again, for any reason, returns the same object", async () => {
    const clock = new Clock();
    let t = startHand(seated("final", [1_000, 1_000, 1_000]), clock.tick());
    const { closing, closed } = await closeAndVerify(t, clock);
    for (const reason of ["IDLE", "EMPTY"] as const) {
      expect(closeTable(closing, reason, clock.tick())).toBe(closing);
      expect(closeTable(closed, reason, clock.tick())).toBe(closed);
    }
    t = closeTable(seated("final-empty", []), "EMPTY", clock.tick());
    expect([t.status, t.closeReason]).toEqual(["CLOSED", "EMPTY"]);
  });

  it("a hand whose chips do not add up is refused (the transaction rolls back) and the input is untouched", () => {
    const clock = new Clock();
    let t = startHand(seated("invariant", [1_000, 1_000, 1_000]), clock.tick());
    while (t.phase === "PREFLOP") t = checkOrCall(t, clock);
    t.handChipTotal! += 1;
    const before = clone(t);
    expectEngineError(() => closeTable(t, "IDLE", clock.tick()), "CHIP_INVARIANT");
    expect(t).toEqual(before);
  });
});

// ===========================================================================
// Random close points
// ===========================================================================

const SWEEP = 300;
const TARGETS = [...STREETS, "SHOWDOWN"] as const;
const SWEEP_STACKS = [15, 40, 90, 250, 1_000, 1_000, 2_500, 5_000];
const balanced: Chooser = (t, _seat, legal) => randomIntent(t, legal, "balanced");

describe("random close points: every forced hand settles, verifies and conserves chips", () => {
  let newcomers = 0;
  const seatNewcomer = (t: EngineTable): EngineTable => {
    const free = t.players.map((p, seat) => (p ? -1 : seat)).filter((seat) => seat >= 0);
    return free.length === 0 ? t : sitDown(t, pick(free), newcomer(`lc-sweep-n${++newcomers}`, pick(SWEEP_STACKS)));
  };
  const candidates = (t: EngineTable): number => seatedPlayers(t).filter((p) => !p.sittingOut && p.stack > 0).length;

  function randomTable(i: number): EngineTable {
    const maxSeats = 2 + randInt(8);
    const order = Array.from({ length: maxSeats }, (_, seat) => seat);
    for (let k = order.length - 1; k > 0; k--) {
      const j = randInt(k + 1);
      [order[k], order[j]] = [order[j]!, order[k]!];
    }
    let t = newTable(`lc-sweep-${i}`, maxSeats);
    for (const seat of order.slice(0, 2 + randInt(maxSeats - 1))) t = join(t, seat, `lc-sweep-${i}-u${seat}`, pick(SWEEP_STACKS));
    return t;
  }

  /** Mostly check/call, with off-turn departures and sit-outs, newcomers and time-outs, until `target`. */
  function driveTo(t: EngineTable, target: (typeof TARGETS)[number], clock: Clock): EngineTable {
    for (let step = 0; isBetting(t) && t.phase !== target; step++) {
      if (step > 1_000) throw new Error("Hand did not terminate");
      const seat = t.toActSeat;
      if (seat === null) throw new Error(`No actor during ${t.phase}`);
      const others = seatedPlayers(t).filter((p) => p.seatIndex !== seat && !p.pendingLeave);
      const roll = randInt(30);
      if (roll === 0 && others.length > 0) t = leaveSeat(t, pick(others).userId, clock.tick());
      else if (roll === 1 && others.length > 0) t = sitOut(t, pick(others).userId, clock.tick());
      else if (roll === 2) t = seatNewcomer(t);
      else if (roll === 3) t = move(t, "TIMEOUT", clock);
      else t = move(t, randomIntent(t, legalActions(t, seat)!, "passive"), clock);
    }
    return t;
  }

  it(`${SWEEP} random tables, each closed for inactivity at a chosen street`, async () => {
    const closedAt = new Map<string, number>();
    for (let i = 0; i < SWEEP; i++) {
      const clock = new Clock();
      let t = randomTable(i);
      // Earlier hands move the button, bust players and seat newcomers who wait for the big blind.
      for (let hands = randInt(3); hands > 0; hands--) {
        while (candidates(t) < 2) t = seatNewcomer(t);
        t = completeHand(playOut(startHand(t, clock.tick()), balanced, clock));
        if (chance(1, 2)) t = seatNewcomer(t);
      }
      while (candidates(t) < 2) t = seatNewcomer(t);
      t = driveTo(startHand(t, clock.tick()), TARGETS[i % TARGETS.length]!, clock);
      closedAt.set(t.phase, (closedAt.get(t.phase) ?? 0) + 1);
      const where = () => `sweep #${i}: table ${t.tableId} closed during ${t.phase}`;

      const chips = chipsHeld(t);
      const viewers = viewersOf(t);
      const closing = closeTable(t, "IDLE", clock.tick());
      check(closing.phase === "SHOWDOWN", () => `${where()}: ended in ${closing.phase}`);
      for (const seat of t.dealtSeats) check(closing.players[seat]?.userId === t.players[seat]!.userId, () => `${where()}: dealt seat ${seat} released early`);
      const record = clone(closing.audit!);
      const sealed = sealedAudit(closing.fairness!);
      const chain = await verifyAuditRecord(record, { requireSettled: true });
      check(chain.ok, () => `${where()}: ${chain.reason}`);
      const cards = await verifySealedAudit(record, sealed);
      check(cards.ok, () => `${where()}: ${cards.reason}`);
      const outcome = verifyHandOutcome(record, sealed);
      check(outcome.ok, () => `${where()}: ${outcome.reason}`);

      const closed = closeIfEmpty(completeHand(closing));
      check(closed.status === "CLOSED" && closed.closeReason === "IDLE" && closed.players.every((p) => p === null), () => `${where()}: not closed`);
      check(chipsHeld(closed) === chips, () => `${where()}: ${chipsHeld(closed)} chips after, ${chips} before`);
      const paid = closed.cashOuts.slice(t.cashOuts.length).map((cash) => cash.userId).sort();
      check(JSON.stringify(paid) === JSON.stringify(seatedPlayers(t).map((p) => p.userId).sort()), () => `${where()}: paid ${paid.join()}`);
      for (const viewer of viewers) {
        for (const state of [closing, closed]) {
          try {
            projectTableState(state, viewer);
          } catch (error) {
            throw new Error(`${where()}: projection for ${String(viewer)} during ${state.phase}: ${String(error)}`);
          }
        }
      }
    }
    for (const street of STREETS) expect([street, closedAt.get(street) ?? 0]).not.toEqual([street, 0]);
  }, 180_000);
});

// ===========================================================================
// 3. closeIfEmpty: the host's departure
// ===========================================================================

describe("closeIfEmpty: a host alone closes the table by leaving; a host with company does not", () => {
  it("requirement 1: a host alone who leaves closes the table (EMPTY) and gets the whole buy-in back", async () => {
    let t = newTable("lc-host-alone", 6);
    const host = "lc-host-alone-host";
    t = join(t, 0, host, 1_000);
    expect(closeIfEmpty(t)).toBe(t);
    const left = leaveSeat(t, host, T0);
    const closed = closeIfEmpty(left);
    expect(left.status).toBe("WAITING");
    expect({ status: closed.status, closeReason: closed.closeReason, closingAt: closed.closingAt, cashOuts: closed.cashOuts, last: closed.log.at(-1)!.text })
      .toEqual({ status: "CLOSED", closeReason: "EMPTY", closingAt: null, cashOuts: [{ userId: host, stack: 1_000 }], last: "Table closed" });
    expect(closeIfEmpty(closed)).toBe(closed);
    expectEngineError(() => sitDown(closed, 0, newcomer("lc-host-alone-late")), "TABLE_CLOSING");
    expectEngineError(() => startHand(closed, T0), "TABLE_CLOSING");
    await expectProjectable(closed, [host, null, OUTSIDER]);
  });

  it("requirement 2: a host who leaves between hands or mid-hand while others sit: the table stays open and keeps dealing", async () => {
    const clock = new Clock();
    // Between hands.
    let t = seated("host-waiting", [1_000, 1_000, 1_000]);
    const host = t.players[0]!.userId;
    t = leaveSeat(t, host, clock.tick());
    expect(closeIfEmpty(t)).toBe(t);
    t = playOut(startHand(t, clock.tick()), checkDown, clock);
    expect([...t.dealtSeats].sort()).toEqual([1, 2]);
    await expectHandVerifies(t);

    // Mid-hand, off turn: the hand goes on without the host; the host is paid once, at Hand Clean-up.
    t = seated("host-midhand", [1_000, 1_000, 1_000]);
    const midHost = t.players[0]!.userId;
    t = startHand(t, clock.tick()); // button 0, blinds 1/2, seat 0 acts first
    t = move(t, { action: "CALL" }, clock);
    t = leaveSeat(t, midHost, clock.tick());
    expect(closeIfEmpty(t)).toBe(t);
    t = playOut(t, checkDown, clock);
    await expectHandVerifies(t);
    expect(closeIfEmpty(t)).toBe(t);
    const final = settled(t.audit!).stacks.find((row) => row.seatIndex === 0)!.stack;
    t = completeHand(t);
    expect(t.players[0]).toBeNull();
    expect(t.cashOuts).toEqual([{ userId: midHost, stack: final }]);
    expect(closeIfEmpty(t)).toBe(t);
    t = playOut(startHand(t, clock.tick()), checkDown, clock);
    expect([...t.dealtSeats].sort()).toEqual([1, 2]);
    await expectHandVerifies(t);
    expect(completeHand(t).cashOuts).toEqual([{ userId: midHost, stack: final }]);
  });

  it("heads-up: the host leaves and the table stays open for the last player; when they leave too, it closes", () => {
    const clock = new Clock();
    let t = seated("host-headsup", [1_000, 1_000]);
    const [host, guest] = [t.players[0]!.userId, t.players[1]!.userId];
    t = playOut(startHand(t, clock.tick()), foldAround, clock);
    t = leaveSeat(t, host, clock.tick()); // at SHOWDOWN the hand is already recorded: the seat is released and paid at once
    t = completeHand(t);
    expect(closeIfEmpty(t)).toBe(t);
    expect(t.status).toBe("WAITING");
    expectEngineError(() => startHand(t, clock.tick()), "NOT_ENOUGH_PLAYERS");
    const closed = closeIfEmpty(leaveSeat(t, guest, clock.tick()));
    expect([closed.status, closed.closeReason]).toEqual(["CLOSED", "EMPTY"]);
    expect(closed.cashOuts.map((cash) => cash.userId)).toEqual([host, guest]);
    expect(closed.cashOuts.reduce((sum, cash) => sum + cash.stack, 0)).toBe(2_000);
  });

  it("never closes a table that has a player seated or a hand in progress, and keeps an earlier close reason", () => {
    const clock = new Clock();
    let t = seated("not-empty", [1_000, 1_000, 1_000]);
    expect(closeIfEmpty(t)).toBe(t);
    t = startHand(t, clock.tick());
    expect(closeIfEmpty(t)).toBe(t);
    t = playOut(t, checkDown, clock);
    expect(closeIfEmpty(t)).toBe(t);
    const closing = closeTable(t, "IDLE", clock.tick());
    expect(closeIfEmpty(closing)).toBe(closing);
    expect(closeIfEmpty(completeHand(closing)).closeReason).toBe("IDLE");
  });
});

// ===========================================================================
// 4. Guards
// ===========================================================================

describe("guards: nothing revives a closing table", () => {
  it("refuses sitDown, sitIn, keepTableOpen and startHand with TABLE_CLOSING once closure has begun", () => {
    const clock = new Clock();
    let t = seated("guards", [1_000, 1_000, 1_000]);
    t = startHand(t, clock.tick());
    const player = t.players[1]!.userId;
    const closing = closeTable(t, "IDLE", clock.tick());
    const done = completeHand(closing);
    const closed = closeIfEmpty(done);
    for (const [name, state] of [["closing", closing], ["cleaned up", done], ["closed", closed]] as const) {
      for (const [op, run] of [
        ["sitDown", () => sitDown(state, 5, newcomer(`${t.tableId}-late`))],
        ["sitIn", () => sitIn(state, player, clock.tick())],
        ["keepTableOpen", () => keepTableOpen(state, player, clock.tick())],
      ] as const) {
        let code: string | null = null;
        try {
          run();
        } catch (error) {
          code = error instanceof EngineError ? error.code : String(error);
        }
        expect([name, op, code]).toEqual([name, op, "TABLE_CLOSING"]);
      }
      expect(recordActivity(state, clock.tick(), player)).toBe(state);
      expect(beginIdleWarning(state, clock.tick())).toBe(state);
      const warnedClosing = { ...state, closingAt: clock.tick() }; // never produced by the engine; clearIdleWarning still leaves closure alone
      expect(clearIdleWarning(warnedClosing)).toBe(warnedClosing);
    }
    expectEngineError(() => startHand(done, clock.tick()), "TABLE_CLOSING");
    expectEngineError(() => startHand(closed, clock.tick()), "TABLE_CLOSING");
    // Even with players seated, a table whose closure has begun deals no hand.
    const flagged = { ...clone(completeHand(playOut(t, checkDown, clock))), closeReason: "IDLE" as const };
    expectEngineError(() => startHand(flagged, clock.tick()), "TABLE_CLOSING");
  });

  it("during the idle warning no hand is dealt, but players can still sit down; activity then clears the warning", () => {
    const clock = new Clock();
    let t = seated("warning-guard", [1_000, 1_000]);
    t = beginIdleWarning(t, clock.tick() + TABLE_IDLE_WARNING_MS);
    expectEngineError(() => startHand(t, clock.tick()), "TABLE_CLOSING");
    const sat = clock.tick();
    const clockBefore = t.lastActivityAt;
    t = sitDown(t, 2, newcomer(`${t.tableId}-late`), sat);
    // sitDown starts only the newcomer's own clock; the server records the activity, which cancels the warning.
    expect([t.closingAt, t.lastActivityAt, t.players[2]!.lastActivityAt]).toEqual([expect.any(Number), clockBefore, sat]);
    const now = clock.tick();
    t = recordActivity(t, now, t.players[2]!.userId);
    expect([t.closingAt, t.lastActivityAt, t.players[2]!.lastActivityAt]).toEqual([null, now, now]);
    expect(startHand(t, clock.tick()).phase).toBe("PREFLOP");
  });
});

// ===========================================================================
// 5. Idle clock, warning and keep-alive
// ===========================================================================

const CONFIG: CreateTableConfig = { tableId: "lc-config", name: "Lifecycle", maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 };

/** The table without its idle bookkeeping (and the log line the warning adds). */
function withoutIdleFields(t: EngineTable): Loose {
  const copy = clone(t) as unknown as Loose;
  for (const key of ["lastActivityAt", "closingAt", "closeReason", "log", "logSeq"]) delete copy[key];
  return copy;
}

describe("idle clock, idle warning and keep-alive", () => {
  it("createTable starts the idle clock at createdAt, or now; a non-finite createdAt is refused", () => {
    expect(createTable({ ...CONFIG, createdAt: T0 })).toMatchObject({ lastActivityAt: T0, closingAt: null, closeReason: null, status: "WAITING" });
    const lo = Date.now();
    const t = createTable(CONFIG);
    expect(t.lastActivityAt).toBeGreaterThanOrEqual(lo);
    expect(t.lastActivityAt).toBeLessThanOrEqual(Date.now());
    expectEngineError(() => createTable({ ...CONFIG, createdAt: Number.NaN }), "BAD_CONFIG");
  });

  it("no seating, betting, time-out, sit-out, leave or clean-up transition touches the idle clock (the server decides what is activity)", () => {
    const clock = new Clock();
    let t = createTable({ ...CONFIG, tableId: "lc-clock", createdAt: T0 - 1 });
    const seen: EngineTable[] = [t];
    const keep = (next: EngineTable): EngineTable => {
      seen.push(next);
      return next;
    };
    for (let seat = 0; seat < 4; seat++) t = keep(sitDown(t, seat, newcomer(`lc-clock-u${seat}`), T0 + seat));
    t = keep(startHand(t, clock.tick()));
    t = keep(checkOrCall(t, clock));
    t = keep(move(t, "TIMEOUT", clock));
    const idle = seatedPlayers(t).find((p) => p.seatIndex !== t.toActSeat && p.status === "ACTIVE")!.userId;
    t = keep(sitOut(t, idle, clock.tick()));
    t = keep(sitIn(t, idle, clock.tick()));
    t = keep(leaveSeat(t, seatedPlayers(t).find((p) => p.seatIndex !== t.toActSeat && p.userId !== idle)!.userId, clock.tick()));
    t = keep(playOut(t, checkDown, clock, (s) => seen.push(s)));
    keep(completeHand(t));
    expect(seen.length).toBeGreaterThan(12);
    for (const s of seen) {
      expect([s.lastActivityAt, s.closingAt, s.closeReason]).toEqual([T0 - 1, null, null]);
      // Each player's own clock is where sitDown started it (seat N at T0 + N).
      for (const p of seatedPlayers(s)) expect([p.userId, p.lastActivityAt]).toEqual([p.userId, T0 + p.seatIndex]);
    }
  });

  it("recordActivity restarts the clock and cancels a warning, returns a new object and never mutates its input", () => {
    const t = beginIdleWarning(createTable({ ...CONFIG, createdAt: T0 }), T0 + 5_000);
    const before = clone(t);
    const next = recordActivity(t, T0 + 1_000);
    expect(next).not.toBe(t);
    expect(t).toEqual(before);
    expect([next.lastActivityAt, next.closingAt, next.closeReason]).toEqual([T0 + 1_000, null, null]);
    expect(withoutIdleFields(next)).toEqual(withoutIdleFields(t));
  });

  it("beginIdleWarning sets the deadline with one table log line, once; a running hand is left exactly as it was and still verifies", async () => {
    const clock = new Clock();
    let t = startHand(seated("warn-midhand", [1_000, 1_000, 1_000]), clock.tick());
    t = checkOrCall(t, clock);
    const deadline = clock.tick() + TABLE_IDLE_WARNING_MS;
    const warned = beginIdleWarning(t, deadline);
    expect(warned.closingAt).toBe(deadline);
    expect(warned.log.length).toBe(t.log.length + 1);
    expect(warned.log.at(-1)).toMatchObject({ seatIndex: null, username: "Table", text: "No activity for 5 minutes — the table closes in 30 seconds unless a player acts" });
    expect(withoutIdleFields(warned)).toEqual(withoutIdleFields(t));
    expect(beginIdleWarning(warned, deadline + 60_000)).toBe(warned);

    // Time-outs and the engine's own transitions keep the warning; only recorded activity clears it.
    let played = move(warned, "TIMEOUT", clock);
    expect(played.closingAt).toBe(deadline);
    played = applyAction(played, played.players[played.toActSeat!]!.userId, passive(legalActions(played, played.toActSeat!)!), clock.tick());
    expect(played.closingAt).toBe(deadline);
    expect(recordActivity(played, clock.tick()).closingAt).toBeNull();
    played = playOut(played, checkDown, clock);
    await expectHandVerifies(played);
    expect(played.closingAt).toBe(deadline);
  });

  it("keepTableOpen: only a seated human who is not leaving may keep the table open; without a warning nothing changes", () => {
    const clock = new Clock();
    let t = seated("keepalive", [1_000, 1_000]);
    t = sitDown(t, 2, { userId: "lc-keepalive-bot", username: "Bot_Alice", avatarHue: 0, kind: "BOT", botProfile: "TAG", buyIn: 1_000 });
    const [human, other] = [t.players[0]!, t.players[1]!];
    expect(keepTableOpen(t, human.userId, clock.tick())).toBe(t); // no warning: no new revision

    const deadline = clock.tick() + TABLE_IDLE_WARNING_MS;
    const warned = beginIdleWarning(t, deadline);
    expectEngineError(() => keepTableOpen(warned, OUTSIDER, clock.tick()), "NOT_SEATED");
    expectEngineError(() => keepTableOpen(warned, "lc-keepalive-bot", clock.tick()), "NOT_SEATED");
    const now = clock.tick();
    const kept = keepTableOpen(warned, human.userId, now);
    expect(warned.closingAt).toBe(deadline);
    expect([kept.closingAt, kept.lastActivityAt, kept.closeReason]).toEqual([null, now, null]);
    expect(kept.log.at(-1)).toMatchObject({ seatIndex: 0, username: human.username, text: `${human.username} is back — the table stays open` });

    // A player who has clicked leave cannot hold the table open.
    let hand = startHand(t, clock.tick());
    hand = leaveSeat(hand, other.userId === hand.players[hand.toActSeat!]!.userId ? human.userId : other.userId, clock.tick());
    const leaver = seatedPlayers(hand).find((p) => p.pendingLeave)!;
    expectEngineError(() => keepTableOpen(beginIdleWarning(hand, deadline), leaver.userId, clock.tick()), "NOT_SEATED");
  });
});

// ===========================================================================
// 5b. Per-player activity (round 2)
// ===========================================================================

const bot = (userId: string) => ({ userId, username: `Bot_${userId}`, avatarHue: 0, kind: "BOT" as const, botProfile: "TAG" as const, buyIn: 1_000 });

describe("per-player activity: the idle clock runs from the humans still at the table", () => {
  it("sitDown starts the player's own clock at `now` (default: now) and leaves the table's alone", () => {
    const t = createTable({ ...CONFIG, tableId: "lc-sit-clock", createdAt: T0 });
    const seated = sitDown(t, 0, newcomer("lc-sit-clock-a"), T0 + 5_000);
    expect([seated.lastActivityAt, seated.players[0]!.lastActivityAt]).toEqual([T0, T0 + 5_000]);
    const lo = Date.now();
    const unset = sitDown(t, 1, newcomer("lc-sit-clock-b")).players[1]!.lastActivityAt;
    expect(unset).toBeGreaterThanOrEqual(lo);
    expect(unset).toBeLessThanOrEqual(Date.now());
  });

  it("recordActivity restarts the named seated player's clock with the table's, and nobody else's", () => {
    let t = createTable({ ...CONFIG, tableId: "lc-record", createdAt: T0 });
    for (const seat of [0, 1]) t = sitDown(t, seat, newcomer(`lc-record-u${seat}`), T0);
    const warned = beginIdleWarning(t, T0 + 1_000);
    const before = clone(warned);
    const named = recordActivity(warned, T0 + 500, "lc-record-u1");
    expect(warned).toEqual(before);
    expect([named.lastActivityAt, named.closingAt, named.players[0]!.lastActivityAt, named.players[1]!.lastActivityAt]).toEqual([T0 + 500, null, T0, T0 + 500]);
    for (const userId of [undefined, OUTSIDER]) {
      const anonymous = recordActivity(warned, T0 + 500, userId);
      expect([anonymous.lastActivityAt, anonymous.closingAt, ...seatedPlayers(anonymous).map((p) => p.lastActivityAt)]).toEqual([T0 + 500, null, T0, T0]);
    }
  });

  it("idleSince: the latest own activity of the seated humans who are not leaving; bots never count; with none, the table's clock", () => {
    let t = createTable({ ...CONFIG, tableId: "lc-since", createdAt: T0 });
    expect(idleSince(t)).toBe(T0);
    t = sitDown(t, 3, bot("lc-since-bot"), T0 + 90_000);
    expect(idleSince(t)).toBe(T0); // a bot alone: the table's clock
    t = sitDown(t, 0, newcomer("lc-since-a"), T0 + 10_000);
    t = sitDown(t, 1, newcomer("lc-since-b"), T0 + 20_000);
    expect(idleSince(t)).toBe(T0 + 20_000);
    t = recordActivity(t, T0 + 30_000, "lc-since-a");
    expect(idleSince(t)).toBe(T0 + 30_000);
    t = sitOut(t, "lc-since-a", T0 + 31_000); // sitting out is still at the table (the server records a real toggle as activity)
    expect(idleSince(t)).toBe(T0 + 30_000);
    // The bot's later clock never counts, and the table's own clock only when no human is left.
    t = recordActivity(t, T0 + 40_000);
    expect([t.lastActivityAt, idleSince(t)]).toEqual([T0 + 40_000, T0 + 30_000]);
  });

  it("a player who acted and then left no longer keeps the table open, between hands or mid-hand", () => {
    const clock = new Clock();
    let t = createTable({ ...CONFIG, tableId: "lc-left", createdAt: T0 });
    for (const seat of [0, 1, 2]) t = sitDown(t, seat, newcomer(`lc-left-u${seat}`), T0);
    // Between hands: an outsider takes a seat (activity) and leaves at once.
    const claimed = clock.tick();
    t = recordActivity(sitDown(t, 4, newcomer("lc-left-outsider"), claimed), claimed, "lc-left-outsider");
    expect(idleSince(t)).toBe(claimed);
    t = leaveSeat(t, "lc-left-outsider", clock.tick());
    expect([t.lastActivityAt, idleSince(t)]).toEqual([claimed, T0]);

    // Mid-hand: the player who acted last clicks leave (pending until the hand ends) and stops counting at once.
    t = startHand(t, clock.tick());
    const actor = t.players[t.toActSeat!]!.userId;
    const acted = clock.tick();
    t = recordActivity(applyAction(t, actor, passive(legalActions(t, t.toActSeat!)!), acted), acted, actor);
    expect(idleSince(t)).toBe(acted);
    t = leaveSeat(t, actor, clock.tick());
    expect(t.players.find((p) => p?.userId === actor)!.pendingLeave).toBe(true);
    expect(idleSince(t)).toBe(T0);
    t = completeHand(playOut(t, checkDown, clock));
    expect(t.players.some((p) => p?.userId === actor)).toBe(false);
    expect(idleSince(t)).toBe(T0);

    // Everyone gone but a bot: the table's own clock.
    t = sitDown(t, 4, bot("lc-left-bot"), clock.tick());
    for (const p of seatedPlayers(t)) if (p.kind === "HUMAN") t = leaveSeat(t, p.userId, clock.tick());
    expect(seatedPlayers(t).map((p) => p.kind)).toEqual(["BOT"]);
    expect(idleSince(t)).toBe(acted);
  });

  it("a newcomer who sits down during the warning cancels it; if they leave again, the AFK table is idle again at once", () => {
    let t = createTable({ ...CONFIG, tableId: "lc-newcomer", createdAt: T0 });
    t = sitDown(t, 0, newcomer("lc-newcomer-afk"), T0);
    t = beginIdleWarning(t, T0 + 300_000 + TABLE_IDLE_WARNING_MS);
    t = recordActivity(sitDown(t, 1, newcomer("lc-newcomer-new"), T0 + 305_000), T0 + 305_000, "lc-newcomer-new");
    expect([t.closingAt, idleSince(t)]).toEqual([null, T0 + 305_000]);
    t = leaveSeat(t, "lc-newcomer-new", T0 + 306_000);
    expect(idleSince(t)).toBe(T0);
  });

  it("keepTableOpen restarts the keeper's own clock", () => {
    let t = createTable({ ...CONFIG, tableId: "lc-keeper", createdAt: T0 });
    for (const seat of [0, 1]) t = sitDown(t, seat, newcomer(`lc-keeper-u${seat}`), T0);
    const kept = keepTableOpen(beginIdleWarning(t, T0 + 400_000), "lc-keeper-u1", T0 + 395_000);
    expect([kept.closingAt, kept.players[0]!.lastActivityAt, kept.players[1]!.lastActivityAt, idleSince(kept)]).toEqual([null, T0, T0 + 395_000, T0 + 395_000]);
  });

  it("a legacy player without a clock of their own counts from the table's (never NaN)", () => {
    const t = sitDown(createTable({ ...CONFIG, tableId: "lc-legacy-player", createdAt: T0 }), 0, newcomer("lc-legacy-player-a"), T0 + 1);
    const legacy = clone(t) as unknown as Loose & { players: (Loose | null)[] };
    delete legacy.players[0]!.lastActivityAt;
    expect(idleSince(legacy as unknown as EngineTable)).toBe(T0);
  });

  it("upgradeTableState: a seated player saved without a clock gets the table's, after its fallback; a player with one keeps it; idempotent", () => {
    let t = createTable({ ...CONFIG, tableId: "lc-upgrade-players", createdAt: T0 });
    t = sitDown(t, 0, newcomer("lc-upgrade-players-a"), T0 + 7);
    t = sitDown(t, 1, newcomer("lc-upgrade-players-b"), T0 + 9);
    const mixed = clone(t) as unknown as Loose & { players: (Loose | null)[] };
    delete mixed.players[1]!.lastActivityAt; // seated before per-player clocks existed
    const once = upgradeTableState(clone(mixed) as unknown as EngineTable, { fallbackActivityAt: T0 - 1 });
    expect(seatedPlayers(once.table).map((p) => p.lastActivityAt)).toEqual([T0 + 7, T0]);
    expect(upgradeTableState(clone(once.table), { fallbackActivityAt: T0 + 99 }).table).toEqual(once.table);
    // No table clock either: both come from the fallback.
    delete mixed.lastActivityAt;
    const legacy = upgradeTableState(clone(mixed) as unknown as EngineTable, { fallbackActivityAt: T0 - 1 }).table;
    expect([legacy.lastActivityAt, ...seatedPlayers(legacy).map((p) => p.lastActivityAt)]).toEqual([T0 - 1, T0 + 7, T0 - 1]);
    expect(upgradeTableState(clone(legacy), { fallbackActivityAt: T0 + 99 }).table).toEqual(legacy);
  });

  it("clearIdleWarning drops only the warning (clocks, hand and log untouched); without a warning, or once closing, it returns the input", async () => {
    const clock = new Clock();
    const t = checkOrCall(startHand(seated("clear-warning", [1_000, 1_000, 1_000]), clock.tick()), clock);
    expect(clearIdleWarning(t)).toBe(t);
    const warned = beginIdleWarning(t, clock.tick() + TABLE_IDLE_WARNING_MS);
    const before = clone(warned);
    const cleared = clearIdleWarning(warned);
    expect(warned).toEqual(before);
    expect(cleared).toEqual({ ...warned, closingAt: null });
    const played = playOut(cleared, checkDown, clock);
    await expectHandVerifies(played);
    // Between hands a warning stops the deal; once dropped, the next hand is dealt.
    const between = beginIdleWarning(completeHand(played), clock.tick());
    expectEngineError(() => startHand(between, clock.tick()), "TABLE_CLOSING");
    expect(startHand(clearIdleWarning(between), clock.tick()).phase).toBe("PREFLOP");
    const closing = closeTable(warned, "IDLE", clock.tick());
    expect(clearIdleWarning(closing)).toBe(closing);
  });
});

// ===========================================================================
// 6. upgradeTableState: state saved before the lifecycle fields existed
// ===========================================================================

/** The shape saved before this change: no idle clocks (table or player), warning or close reason. */
function withoutLifecycle(t: EngineTable): EngineTable {
  const legacy = clone(t) as unknown as Loose & { players: (Loose | null)[] };
  delete legacy.lastActivityAt;
  delete legacy.closingAt;
  delete legacy.closeReason;
  for (const p of legacy.players) if (p) delete p.lastActivityAt;
  return legacy as unknown as EngineTable;
}

/** `t` as the upgrade leaves its legacy shape: open, no warning, the table and every player on the clock `at`. */
function upgradedAt(t: EngineTable, at: number): EngineTable {
  return { ...t, lastActivityAt: at, closingAt: null, closeReason: null, players: t.players.map((p) => p && { ...p, lastActivityAt: at }) };
}

describe("upgradeTableState on state saved before the lifecycle fields existed", () => {
  it("adds the defaults: open, no warning, idle clock at the fallback time; deterministic and idempotent", async () => {
    const clock = new Clock();
    const t = completeHand(playOut(startHand(seated("legacy-wait", [1_000, 1_000, 1_000]), clock.tick()), checkDown, clock));
    const legacy = withoutLifecycle(t);
    expect("lastActivityAt" in legacy || "closingAt" in legacy || "closeReason" in legacy).toBe(false);
    expect(seatedPlayers(legacy).some((p) => "lastActivityAt" in p)).toBe(false);
    // As stored, the projection already treats the missing fields as "open".
    const view = projectTableState(legacy, null);
    expect([view.closingInMs, view.closeReason]).toEqual([null, null]);

    const fallback = T0 - 90_000;
    const once = upgradeTableState(clone(legacy), { fallbackActivityAt: fallback });
    expect(once.voidedHand).toBeNull();
    expect(once.table).toEqual(upgradedAt(t, fallback));
    expect(upgradeTableState(clone(legacy), { fallbackActivityAt: fallback }).table).toEqual(once.table);
    const twice = upgradeTableState(clone(once.table), { fallbackActivityAt: fallback + 1 });
    expect([twice.voidedHand, twice.table]).toEqual([null, once.table]);

    const lo = Date.now();
    const unset = upgradeTableState(clone(legacy)).table.lastActivityAt;
    expect(unset).toBeGreaterThanOrEqual(lo);
    expect(unset).toBeLessThanOrEqual(Date.now());
    const broken = { ...clone(t), lastActivityAt: Number.NaN };
    expect(upgradeTableState(broken, { fallbackActivityAt: fallback }).table.lastActivityAt).toBe(fallback);
    const unsetPlayers = upgradeTableState(clone(legacy)).table;
    for (const p of seatedPlayers(unsetPlayers)) expect(p.lastActivityAt).toBe(unsetPlayers.lastActivityAt);

    await expectProjectable(once.table, viewersOf(t));
  });

  it("a hand in flight keeps its audit (not voided), gets the defaults, and can still be closed and verified", async () => {
    const clock = new Clock();
    const evidence = new EvidenceRecorder();
    let t = deal(seated("legacy-hand", [1_000, 1_000, 1_000]), clock, evidence);
    while (t.phase === "PREFLOP") t = checkOrCall(t, clock);
    evidence.capture(t);
    const { table, voidedHand } = upgradeTableState(withoutLifecycle(t), { fallbackActivityAt: T0 });
    expect(voidedHand).toBeNull();
    expect(table).toEqual(upgradedAt(t, T0));
    await closeAndVerify(table, clock, evidence);
  });

  it("startHand upgrades a raw legacy state itself, starting the clock at the hand's time", () => {
    const clock = new Clock();
    const legacy = withoutLifecycle(seated("legacy-start", [1_000, 1_000]));
    const now = clock.tick();
    const t = startHand(legacy, now);
    expect([t.lastActivityAt, t.closingAt, t.closeReason, t.phase]).toEqual([now, null, null, "PREFLOP"]);
    for (const p of seatedPlayers(t)) expect(p.lastActivityAt).toBe(now);
  });
});

// ===========================================================================
// 7. Projection and leak guard
// ===========================================================================

describe("projection: closingInMs / closeReason pass the leak guard in every lifecycle state", () => {
  it("warning, closing and closed tables project for every viewer with the right fields, mid-hand and between hands", async () => {
    const clock = new Clock();
    const between = seated("project-wait", [1_000, 1_000, 1_000]);
    const midHand = checkOrCall(startHand(seated("project-hand", [1_000, 1_000, 1_000]), clock.tick()), clock);

    for (const t of [between, midHand]) {
      const viewers = viewersOf(t);
      const warned = beginIdleWarning(t, Date.now() + TABLE_IDLE_WARNING_MS);
      for (const state of await expectProjectable(warned, viewers)) {
        expect(state.closingInMs).toBeGreaterThan(0);
        expect(state.closingInMs).toBeLessThanOrEqual(TABLE_IDLE_WARNING_MS);
        expect(state.closeReason).toBeNull();
      }
      // A deadline already past counts down to zero, never below.
      for (const state of await expectProjectable(beginIdleWarning(t, Date.now() - 5_000), viewers)) expect(state.closingInMs).toBe(0);

      const closing = closeTable(warned, "IDLE", clock.tick());
      for (const state of await expectProjectable(closing, viewers)) {
        expect([state.closingInMs, state.closeReason]).toEqual([null, "IDLE"]);
        expect(state.status).toBe(t === between ? "CLOSED" : "IN_HAND");
      }
      const closed = closeIfEmpty(closing.phase === "SHOWDOWN" ? completeHand(closing) : closing);
      for (const state of await expectProjectable(closed, viewers)) {
        expect([state.status, state.closingInMs, state.closeReason]).toEqual(["CLOSED", null, "IDLE"]);
        expect(state.players.every((p) => p.empty)).toBe(true);
      }
    }
    // An open table.
    for (const state of await expectProjectable(midHand, viewersOf(midHand))) {
      expect(Object.keys(state)).toEqual(expect.arrayContaining(["closingInMs", "closeReason"]));
      expect([state.closingInMs, state.closeReason]).toEqual([null, null]);
    }
  });

  it("the leak guard refuses the server-only lifecycle fields if they ever reach a payload", () => {
    const t = beginIdleWarning(seated("project-leak", [1_000, 1_000]), Date.now() + TABLE_IDLE_WARNING_MS);
    for (const key of ["lastActivityAt", "closingAt"]) {
      const state = json(projectTableState(t, t.players[0]!.userId)) as PublicTableState & Loose;
      state[key] = 1;
      let caught: unknown = null;
      try {
        assertViewerStateSafe(state, t, t.players[0]!.userId);
      } catch (error) {
        caught = error;
      }
      check(caught instanceof EngineError, () => `${key}: expected LEAK_BLOCKED, got ${String(caught)}`);
      expect([key, caught.code, caught.message]).toEqual([key, "LEAK_BLOCKED", expect.stringMatching(/outside the client schema/)]);
    }
  });
});
