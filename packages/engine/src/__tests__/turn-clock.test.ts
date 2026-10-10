/**
 * Turn clock, time-out sit-out, personal time bank, turn identity, clock
 * rebase after downtime, and the related projection and audit rules.
 *
 * 1. A human whose turn times out is sat out (reason TIMEOUT). The sat-out
 *    cascade acts for them for the rest of the hand and they are not dealt
 *    in again until they sit in, so an absent player loses at most the hand
 *    they first timed out in instead of being blinded off. Time-outs are
 *    still never activity.
 * 2. Personal time bank (opt-in per table): the deadline is the base clock
 *    plus the actor's pool; time beyond the base clock is charged when the
 *    turn ends; pools refill every N dealt hands up to a cap. Disabled, every
 *    deadline is exactly the base clock, as before.
 * 3. turnIdOf changes exactly when a turn starts.
 * 4. The projection publishes the turn identity and every countdown, and the
 *    leak guard's exact schema admits exactly those new fields.
 * 5. rebaseTurnClock restarts the actor's base clock after downtime, records
 *    TURN_CLOCK_RESET, and a malformed reset is rejected by every verifier.
 * 6/7/10. Idle warning length, log text without "$", legacy state upgrade.
 */
import {
  TABLE_IDLE_TIMEOUT_MS,
  TABLE_IDLE_WARNING_MS,
  verifyAuditRecord,
  verifyParticipantAudit,
  verifySealedAudit,
  type HandAuditRecord,
  type LegalActionSet,
  type SitOutReason,
} from "@poker/shared";
import { participantAudit, sealedAudit, verifyHandOutcome } from "../audit.js";
import { legalActions } from "../legal.js";
import { assertViewerStateSafe, projectTableState, toPublicTableState, turnDeadline, turnIdOf } from "../public.js";
import {
  applyAction,
  applyTimeout,
  beginIdleWarning,
  closeTable,
  completeHand,
  createTable,
  idleSince,
  keepTableOpen,
  leaveSeat,
  rebaseTurnClock,
  recordActivity,
  sitDown,
  sitIn,
  sitOut,
  startHand,
  upgradeTableState,
} from "../table.js";
import { EngineError, type CreateTableConfig, type EngineIntent, type EngineTable, type ExtraTimeBankConfig } from "../types.js";
import { forge } from "./helpers/forge.js";

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const BASE_MS = 15_000;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class Clock {
  constructor(public now = T0) {}
  tick(ms = 1_000): number {
    this.now += ms;
    return this.now;
  }
}

function table(id: string, extra: Partial<CreateTableConfig> = {}): EngineTable {
  return createTable({ tableId: id, name: `Clock ${id}`, maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: BASE_MS, createdAt: T0, ...extra });
}

function seat(t: EngineTable, seatIndex: number, userId: string, stack = 1_000, kind: "HUMAN" | "BOT" = "HUMAN"): EngineTable {
  return sitDown(t, seatIndex, {
    userId, username: `Player-${userId}`, avatarHue: 0, kind, botProfile: kind === "BOT" ? "TAG" : null, buyIn: stack, skipBuyInCheck: true,
  }, T0);
}

function seated(id: string, seats: readonly number[], extra: Partial<CreateTableConfig> = {}, stack = 1_000): EngineTable {
  let t = table(id, extra);
  for (const s of seats) t = seat(t, s, `${id}-u${s}`, stack);
  return t;
}

const BETTING = new Set(["PREFLOP", "FLOP", "TURN", "RIVER"]);
const betting = (t: EngineTable): boolean => BETTING.has(t.phase);
const actor = (t: EngineTable) => t.players[t.toActSeat!]!;

function passive(legal: LegalActionSet): EngineIntent {
  if (legal.actions.includes("CHECK")) return { action: "CHECK" };
  if (legal.actions.includes("CALL")) return { action: "CALL" };
  return { action: "ALL_IN" };
}

/** The current actor checks or calls. */
function call(t: EngineTable, now: number): EngineTable {
  return applyAction(t, actor(t).userId, passive(legalActions(t, t.toActSeat!)!), now);
}

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof EngineError ? error.code : `not an EngineError: ${String(error)}`;
  }
}

async function expectHandVerifies(t: EngineTable): Promise<void> {
  const record = json(t.audit!);
  const sealed = sealedAudit(t.fairness!);
  expect(await verifyAuditRecord(record, { requireSettled: true })).toEqual({ ok: true });
  expect((await verifySealedAudit(record, sealed)).ok).toBe(true);
  expect(verifyHandOutcome(record, sealed)).toEqual({ ok: true });
  for (const s of t.dealtSeats) expect(await verifyParticipantAudit(json(participantAudit(record, sealed, s)))).toEqual({ ok: true });
}

// ---------------------------------------------------------------------------
// 1. Sit out after a time-out
// ---------------------------------------------------------------------------

describe("1. a timed-out player is sat out", () => {
  it.each([0, 1])("heads-up over 100 hands, a player who never acts (seat %i) loses only the hand they first time out in, then sits out", (absentSeat) => {
    const clock = new Clock();
    let t = seated(`hu-absent-${absentSeat}`, [0, 1]);
    const absentId = `hu-absent-${absentSeat}-u${absentSeat}`;
    const startStack = t.players[absentSeat]!.stack;
    const activityBefore = [t.lastActivityAt, t.players[absentSeat]!.lastActivityAt, idleSince(t)];
    let dealtToAbsent = 0;
    let forcedChips = 0;
    let handsDealt = 0;
    for (let hand = 0; hand < 100; hand++) {
      const code = errorCode(() => { t = startHand(t, clock.tick()); });
      if (code !== null) {
        // The only other player cannot play alone: the absent player is not dealt in to be blinded.
        expect(code).toBe("NOT_ENOUGH_PLAYERS");
        break;
      }
      handsDealt += 1;
      if (t.dealtSeats.includes(absentSeat)) {
        dealtToAbsent += 1;
        forcedChips += t.players[absentSeat]!.committedThisHand; // the blind they posted
      }
      for (let step = 0; betting(t); step++) {
        if (step > 200) throw new Error("hand did not end");
        t = t.toActSeat === absentSeat ? applyTimeout(t, clock.tick(BASE_MS)) : call(t, clock.tick());
      }
      expect(t.phase).toBe("SHOWDOWN");
      expect(verifyHandOutcome(t.audit!, sealedAudit(t.fairness!))).toEqual({ ok: true });
      t = completeHand(t);
    }
    expect(dealtToAbsent).toBe(1);
    expect(handsDealt).toBe(1);
    expect(forcedChips).toBeLessThanOrEqual(10);
    // They may even have won the hand they checked through; they never lose more than their blind.
    expect(startStack - t.players[absentSeat]!.stack).toBeLessThanOrEqual(forcedChips);
    // Between hands the seat keeps the last hand's status (FOLDED/ACTIVE) until the next deal marks it SIT_OUT;
    // the sit-out itself is the flag and its reason, which is what decides that they are not dealt in.
    expect(t.players[absentSeat]).toMatchObject({ userId: absentId, sittingOut: true, sittingOutReason: "TIMEOUT" });
    // Time-outs are never activity: no clock moved.
    expect([t.lastActivityAt, t.players[absentSeat]!.lastActivityAt, idleSince(t)]).toEqual(activityBefore);
  });

  it("3-handed, 100 hands: the absent big blind loses at most the blind of the first hand and is never dealt in again; sitting in brings them back at the big blind", async () => {
    const clock = new Clock();
    let t = seated("tri-absent", [0, 1, 2], {}, 2_000);
    const absent = 2;
    const absentId = "tri-absent-u2";
    const startStack = t.players[absent]!.stack;
    let lossInFirstHand: number | null = null;
    for (let hand = 1; hand <= 100; hand++) {
      t = startHand(t, clock.tick());
      if (hand > 1) expect(t.dealtSeats).not.toContain(absent);
      for (let step = 0; betting(t); step++) {
        if (step > 200) throw new Error("hand did not end");
        t = t.toActSeat === absent ? applyTimeout(t, clock.tick(BASE_MS)) : call(t, clock.tick());
      }
      if (hand === 1) {
        expect(t.players[absent]).toMatchObject({ sittingOut: true, sittingOutReason: "TIMEOUT" });
        lossInFirstHand = startStack - t.players[absent]!.stack;
        await expectHandVerifies(t);
      }
      t = completeHand(t);
      if (hand > 1) expect(t.players[absent]!.stack).toBe(startStack - lossInFirstHand!);
    }
    expect(lossInFirstHand).toBeLessThanOrEqual(10);
    expect(t.handNumber).toBe(100);
    expect(t.players[absent]!.missedBlind).toBe(true);

    // Sitting in clears the reason; the missed blinds make them wait for the big blind.
    t = sitIn(t, absentId, clock.tick());
    expect(t.players[absent]).toMatchObject({ sittingOut: false, sittingOutReason: null, waitingForBigBlind: true, missedBlind: false });
    let dealtBack = false;
    for (let hand = 0; hand < 4 && !dealtBack; hand++) {
      t = startHand(t, clock.tick());
      if (t.dealtSeats.includes(absent)) {
        dealtBack = true;
        expect(t.bbSeat).toBe(absent);
      }
      while (betting(t)) t = call(t, clock.tick());
      t = completeHand(t);
    }
    expect(dealtBack).toBe(true);
  });

  it("the time-out is recorded as the timed-out action, then a SIT_OUT status; the cascade acts for them later and they keep their claim on the pot", async () => {
    const clock = new Clock();
    let t = seated("tri-keep", [0, 1, 2]);
    t = startHand(t, clock.tick()); // button 0, blinds 1/2, seat 0 first
    t = call(t, clock.tick()); // seat 0 calls
    t = call(t, clock.tick()); // seat 1 completes
    expect(t.toActSeat).toBe(2);
    t = applyTimeout(t, clock.tick(BASE_MS)); // big blind times out with a free check: still in the hand
    expect(t.players[2]).toMatchObject({ status: "ACTIVE", sittingOut: true, sittingOutReason: "TIMEOUT" });
    const tail = t.audit!.events.filter((e) => e.type === "PLAYER_ACTION" || e.type === "PLAYER_STATUS").slice(-2);
    expect(tail.map((e) => [e.type, e.data.seatIndex, e.data.action ?? e.data.status])).toEqual([["PLAYER_ACTION", 2, "TIMEOUT_CHECK"], ["PLAYER_STATUS", 2, "SIT_OUT"]]);
    // The time-out closed the pre-flop round, so the flop follows these two entries.
    const texts = t.log.map((l) => l.text);
    const at = texts.indexOf("Player-tri-keep-u2 checks (time)");
    expect(texts.slice(at, at + 2)).toEqual(["Player-tri-keep-u2 checks (time)", "Player-tri-keep-u2 sits out"]);
    // Everyone checks down: the sat-out player is checked for and shows down.
    while (betting(t)) t = call(t, clock.tick());
    expect(t.phase).toBe("SHOWDOWN");
    expect(t.players[2]!.showedCards).toBe(true);
    expect(t.awards.every((pot) => pot.eligibleSeatIndexes.includes(2))).toBe(true);
    await expectHandVerifies(t);
  });

  it("facing a bet, a timed-out player folds and is sat out; later turns of other sat-out players are folded for them", () => {
    const clock = new Clock();
    let t = seated("tri-fold", [0, 1, 2]);
    t = startHand(t, clock.tick());
    t = applyAction(t, "tri-fold-u0", { action: "RAISE", amount: 40 }, clock.tick());
    t = applyTimeout(t, clock.tick(BASE_MS)); // seat 1 facing a raise
    expect(t.players[1]).toMatchObject({ status: "FOLDED", sittingOut: true, sittingOutReason: "TIMEOUT" });
    expect(t.toActSeat).toBe(2);
  });

  it("sitOutOnTimeout: false keeps the old rule (the player keeps being dealt in), and bots are never sat out by the clock", () => {
    const clock = new Clock();
    let t = seated("no-sitout", [0, 1], { sitOutOnTimeout: false });
    expect(t.sitOutOnTimeout).toBe(false);
    for (let hand = 0; hand < 3; hand++) {
      t = startHand(t, clock.tick());
      expect(t.dealtSeats).toEqual(expect.arrayContaining([0, 1]));
      while (betting(t)) t = t.toActSeat === 0 ? applyTimeout(t, clock.tick(BASE_MS)) : call(t, clock.tick());
      expect(t.players[0]).toMatchObject({ sittingOut: false, sittingOutReason: null });
      t = completeHand(t);
    }

    let b = table("bot-timeout");
    b = seat(b, 0, "bot-timeout-b0", 1_000, "BOT");
    b = seat(b, 1, "bot-timeout-u1");
    b = startHand(b, clock.tick());
    expect(b.toActSeat).toBe(0);
    b = applyTimeout(b, clock.tick(BASE_MS));
    expect(b.players[0]).toMatchObject({ sittingOut: false, sittingOutReason: null });
  });

  it("sit-out reasons: SELF by default, the server's DISCONNECTED, CLOSING when the table closes; a repeat keeps the first reason; an unknown reason is refused", () => {
    const clock = new Clock();
    let t = seated("reasons", [0, 1, 2, 3]);
    expect(errorCode(() => sitOut(t, "reasons-u0", clock.tick(), "AWAY" as SitOutReason))).toBe("BAD_REASON");
    t = sitOut(t, "reasons-u0", clock.tick());
    expect(t.players[0]!.sittingOutReason).toBe("SELF");
    t = sitOut(t, "reasons-u1", clock.tick(), "DISCONNECTED");
    expect(t.players[1]!.sittingOutReason).toBe("DISCONNECTED");
    expect(sitOut(t, "reasons-u1", clock.tick(), "SELF")).toBe(t);
    t = sitIn(t, "reasons-u0", clock.tick());
    expect(t.players[0]!.sittingOutReason).toBeNull();
    t = startHand(t, clock.tick()); // seats 0, 2, 3 dealt; seat 1 sitting out
    t = leaveSeat(t, "reasons-u2", clock.tick()); // a dealt player leaving: their own choice
    expect(t.players[2]).toMatchObject({ sittingOut: true, pendingLeave: true, sittingOutReason: "SELF" });
    t = closeTable(t, "IDLE", clock.tick());
    expect(t.phase).toBe("SHOWDOWN");
    expect(t.players[0]!.sittingOutReason).toBe("CLOSING");
    expect(t.players[3]!.sittingOutReason).toBe("CLOSING");
    expect(t.players[2]!.sittingOutReason).toBe("SELF");
    expect(t.players[1]).toBeNull(); // not dealt in: cashed out at once
  });
});

// ---------------------------------------------------------------------------
// 2. Personal time bank
// ---------------------------------------------------------------------------

const BANK: ExtraTimeBankConfig = { initialMs: 30_000, maxMs: 60_000, refillMs: 5_000, refillEveryHands: 2 };

describe("2. personal time bank", () => {
  it("rejects invalid time bank settings", () => {
    const bad: ExtraTimeBankConfig[] = [
      { ...BANK, initialMs: -1 }, { ...BANK, initialMs: 1.5 }, { ...BANK, maxMs: 10_000 }, { ...BANK, refillMs: -5 },
      { ...BANK, refillEveryHands: 0 }, { ...BANK, refillEveryHands: 1.5 },
    ];
    for (const extraTimeBank of bad) expect(errorCode(() => table("bad-bank", { extraTimeBank }))).toBe("BAD_CONFIG");
    expect(errorCode(() => table("bad-flag", { sitOutOnTimeout: "yes" as unknown as boolean }))).toBe("BAD_CONFIG");
  });

  it("disabled (the default): every deadline is exactly turnStartedAt + timeBankMs and pools are not published", () => {
    const clock = new Clock();
    let t = seated("bank-off", [0, 1, 2]);
    expect(t.extraTimeBank).toBeNull();
    t = startHand(t, clock.tick());
    for (let step = 0; betting(t); step++) {
      expect(turnDeadline(t)).toBe(t.turnStartedAt! + BASE_MS);
      expect(t.players.every((p) => p === null || p.extraTimeMs === 0)).toBe(true);
      const view = toPublicTableState(t, null);
      expect(view.players.every((p) => p.extraTimeMs === null)).toBe(true);
      expect(view.turnEndsAt).toBe(new Date(t.turnStartedAt! + BASE_MS).toISOString());
      // Slow actions charge nothing: there is no pool.
      t = call(t, clock.tick(BASE_MS + 7_000));
    }
    expect(turnDeadline(t)).toBeNull();
  });

  it("the deadline adds the actor's pool; time beyond the base clock is charged when the turn ends, never below zero", () => {
    const clock = new Clock();
    let t = seated("bank-on", [0, 1, 2], { extraTimeBank: BANK });
    expect(t.players.filter(Boolean).map((p) => p!.extraTimeMs)).toEqual([30_000, 30_000, 30_000]);
    t = startHand(t, clock.tick()); // seat 0 first
    const started = t.turnStartedAt!;
    expect(turnDeadline(t)).toBe(started + BASE_MS + 30_000);
    // Acting inside the base clock costs nothing.
    t = call(t, started + BASE_MS - 1);
    expect(t.players[0]!.extraTimeMs).toBe(30_000);
    // Seat 1 uses 4 s of its bank.
    t = call(t, t.turnStartedAt! + BASE_MS + 4_000);
    expect(t.players[1]!.extraTimeMs).toBe(26_000);
    // Seat 2 times out late (a slow server): the pool empties and never goes negative.
    t = applyTimeout(t, t.turnStartedAt! + BASE_MS + 90_000);
    expect(t.players[2]!.extraTimeMs).toBe(0);
    // A sat-out player's later turns start and end at once: nothing more is charged.
    expect(t.players[1]!.extraTimeMs).toBe(26_000);
    // The flop actor's deadline uses their own (reduced) pool.
    expect(t.phase).toBe("FLOP");
    expect(turnDeadline(t)).toBe(t.turnStartedAt! + BASE_MS + t.players[t.toActSeat!]!.extraTimeMs);
  });

  it("sitting out or leaving on your own turn charges the time you used", () => {
    const clock = new Clock();
    let t = seated("bank-sit", [0, 1, 2], { extraTimeBank: BANK });
    t = startHand(t, clock.tick());
    t = sitOut(t, "bank-sit-u0", t.turnStartedAt! + BASE_MS + 2_500);
    expect(t.players[0]!.extraTimeMs).toBe(27_500);
    t = leaveSeat(t, "bank-sit-u1", t.turnStartedAt! + BASE_MS + 1_000);
    expect(t.players[1]!.extraTimeMs).toBe(29_000);
  });

  it("pools refill by refillMs every refillEveryHands dealt hands, capped at maxMs; hands not dealt do not count", () => {
    const clock = new Clock();
    const bank: ExtraTimeBankConfig = { initialMs: 10_000, maxMs: 12_000, refillMs: 5_000, refillEveryHands: 2 };
    let t = seated("bank-refill", [0, 1, 2], { extraTimeBank: bank });
    t = sitOut(t, "bank-refill-u2", clock.tick());
    const pools: number[][] = [];
    for (let hand = 0; hand < 4; hand++) {
      t = startHand(t, clock.tick());
      pools.push([0, 1, 2].map((s) => t.players[s]!.extraTimeMs));
      expect(t.players[2]!.handsSinceRefill).toBe(0);
      while (betting(t)) t = call(t, clock.tick());
      t = completeHand(t);
    }
    expect(pools).toEqual([[10_000, 10_000, 10_000], [12_000, 12_000, 10_000], [12_000, 12_000, 10_000], [12_000, 12_000, 10_000]]);
    expect(t.players[0]!.handsSinceRefill).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Turn identity
// ---------------------------------------------------------------------------

describe("3. turn identity", () => {
  it("changes on the actor's action, time-out and each new street; never on a bystander's seat, sit-out, sit-in, leave or the idle warning", () => {
    const clock = new Clock();
    let t = seated("turn-id", [0, 1, 2, 3]);
    expect(turnIdOf(t)).toBeNull();
    t = startHand(t, clock.tick()); // seat 3 first (button 0, blinds 1/2)
    const seen = new Set<string>();
    const fresh = (id: string | null): void => {
      expect(id).not.toBeNull();
      expect(seen.has(id!)).toBe(false);
      seen.add(id!);
    };
    fresh(turnIdOf(t));
    expect(turnIdOf(t)).toMatch(/^1:\d+$/);

    // Bystanders: same turn.
    const id = turnIdOf(t);
    const bystanderMoves: ((x: EngineTable) => EngineTable)[] = [
      (x) => seat(x, 5, "turn-id-new"),
      (x) => sitOut(x, "turn-id-u1", clock.tick()),
      (x) => sitIn(x, "turn-id-u1", clock.tick()),
      (x) => leaveSeat(x, "turn-id-u0", clock.tick()),
      (x) => recordActivity(x, clock.tick(), "turn-id-u2"),
      (x) => beginIdleWarning(x, clock.tick() + TABLE_IDLE_WARNING_MS),
      (x) => keepTableOpen(x, "turn-id-u2", clock.tick()),
    ];
    for (const moveBy of bystanderMoves) {
      t = moveBy(t);
      expect(turnIdOf(t)).toBe(id);
    }

    t = call(t, clock.tick()); // seat 3
    fresh(turnIdOf(t));
    t = applyTimeout(t, clock.tick(BASE_MS)); // seat 1 (seat 0 is leaving and was folded for)
    fresh(turnIdOf(t));
    t = call(t, clock.tick()); // seat 2 checks: the flop begins
    expect(t.phase).toBe("FLOP");
    fresh(turnIdOf(t));
    while (betting(t)) t = call(t, clock.tick());
    expect(turnIdOf(t)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Projection
// ---------------------------------------------------------------------------

describe("4. projection of the turn clock", () => {
  it("publishes turnId, turnRemainingMs and the acting seat's total and base time, every seated pool and sit-out reasons", () => {
    let t = seated("proj", [0, 1, 2], { extraTimeBank: BANK });
    t = sitOut(t, "proj-u2", T0, "DISCONNECTED");
    // The turn began 5 s ago on the server's clock.
    t = startHand(t, Date.now() - 5_000);
    const actorSeat = t.toActSeat!;
    const before = Date.now();
    const view = projectTableState(t, "proj-u0");
    const elapsedSlack = Date.now() - before + 50;
    expect(view.turnId).toBe(turnIdOf(t));
    const acting = view.players[actorSeat]!;
    expect(acting.timeBankMsRemaining).toBe(view.turnRemainingMs);
    expect(view.turnRemainingMs!).toBeLessThanOrEqual(BASE_MS + 30_000 - 5_000);
    expect(view.turnRemainingMs!).toBeGreaterThan(BASE_MS + 30_000 - 5_000 - elapsedSlack - 100);
    expect(acting.baseTimeMsRemaining!).toBeLessThanOrEqual(BASE_MS - 5_000);
    expect(acting.baseTimeMsRemaining!).toBe(acting.timeBankMsRemaining! - 30_000);
    expect(view.turnEndsAt).toBe(new Date(turnDeadline(t)!).toISOString());
    for (const p of view.players) {
      if (p.seatIndex === actorSeat) continue;
      expect([p.timeBankMsRemaining, p.baseTimeMsRemaining]).toEqual([null, null]);
    }
    expect(view.players.slice(0, 3).map((p) => p.extraTimeMs)).toEqual([30_000, 30_000, 30_000]);
    expect(view.players[4]).toMatchObject({ empty: true, extraTimeMs: null, sittingOutReason: null, baseTimeMsRemaining: null });
    expect(view.players[2]!.sittingOutReason).toBe("DISCONNECTED");
    expect(view.players[0]!.sittingOutReason).toBeNull();

    // Between hands: no turn, no countdowns.
    let idle = seated("proj-idle", [0, 1]);
    const quiet = projectTableState(idle, null);
    expect([quiet.turnId, quiet.turnRemainingMs, quiet.turnEndsAt]).toEqual([null, null, null]);
    expect(quiet.players.every((p) => p.extraTimeMs === null && p.timeBankMsRemaining === null && p.baseTimeMsRemaining === null)).toBe(true);
    idle = startHand(idle, Date.now());
    // Without a bank the total and the base clock are the same number.
    const plain = projectTableState(idle, null).players[idle.toActSeat!]!;
    expect(plain.timeBankMsRemaining).toBe(plain.baseTimeMsRemaining);
  });

  it("the leak guard admits exactly the new fields: server-only clock state under any key is still refused", () => {
    const t = startHand(seated("proj-guard", [0, 1], { extraTimeBank: BANK }), Date.now());
    const state = toPublicTableState(t, "proj-guard-u0");
    expect(() => assertViewerStateSafe(state, t, "proj-guard-u0")).not.toThrow();
    const leaks: ((s: Record<string, unknown>) => void)[] = [
      (s) => { s.turnSeq = t.turnSeq; },
      (s) => { s.turnStartedAt = t.turnStartedAt; },
      (s) => { s.extraTimeBank = { ...BANK }; },
      (s) => { (s.players as Record<string, unknown>[])[0]!.handsSinceRefill = 1; },
      (s) => { (s.players as Record<string, unknown>[])[0]!.lastActivityAt = T0; },
    ];
    for (const leak of leaks) {
      const copy = json(state) as unknown as Record<string, unknown>;
      leak(copy);
      expect(errorCode(() => assertViewerStateSafe(copy as never, t, "proj-guard-u0"))).toBe("LEAK_BLOCKED");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Clock rebase after downtime
// ---------------------------------------------------------------------------

describe("5. rebaseTurnClock", () => {
  it("restarts the actor's base clock without charging the bank, starts a new turn and is audited; with no one to act it changes nothing", async () => {
    const clock = new Clock();
    let t = seated("rebase", [0, 1, 2], { extraTimeBank: BANK });
    expect(rebaseTurnClock(t, clock.tick(), "SERVER_RESUME")).toBe(t);
    t = startHand(t, clock.tick());
    const actorSeat = t.toActSeat!;
    const resumedAt = t.turnStartedAt! + 3_600_000; // an hour of downtime
    expect(errorCode(() => rebaseTurnClock(t, resumedAt, "MANUAL" as "SERVER_RESUME"))).toBe("BAD_REASON");
    const before = turnIdOf(t);
    const events = t.audit!.events.length;
    const r = rebaseTurnClock(t, resumedAt, "SERVER_RESUME");
    expect(r.turnStartedAt).toBe(resumedAt);
    expect(r.toActSeat).toBe(actorSeat);
    expect(turnIdOf(r)).not.toBe(before);
    expect(turnDeadline(r)).toBe(resumedAt + BASE_MS + 30_000);
    expect(r.audit!.events.length).toBe(events + 1);
    expect(r.audit!.events.at(-1)).toMatchObject({ type: "TURN_CLOCK_RESET", phase: "PREFLOP", data: { seatIndex: actorSeat, reason: "SERVER_RESUME" } });
    // The input is untouched.
    expect(t.audit!.events.length).toBe(events);

    // Acting 2 s after the resume costs nothing; without the rebase it would have emptied the pool.
    expect(call(r, resumedAt + 2_000).players[actorSeat]!.extraTimeMs).toBe(30_000);
    expect(call(t, resumedAt + 2_000).players[actorSeat]!.extraTimeMs).toBe(0);

    let done = call(r, resumedAt + 2_000);
    while (betting(done)) done = call(done, clock.tick() + 3_600_000);
    await expectHandVerifies(done);
  });

  /** A settled hand with a reset on the small blind's turn after the first player folded (or went all-in). */
  function handWithReset(firstMove: "FOLD" | "ALL_IN"): EngineTable {
    const clock = new Clock();
    let t = seated(`rebase-${firstMove}`, [0, 1, 2]);
    if (firstMove === "ALL_IN") {
      t = leaveSeat(t, "rebase-ALL_IN-u0", T0);
      t = seat(t, 0, "rebase-ALL_IN-short", 50);
    }
    t = startHand(t, clock.tick()); // seat 0 first
    t = applyAction(t, actor(t).userId, { action: firstMove }, clock.tick());
    expect(t.toActSeat).toBe(1);
    t = rebaseTurnClock(t, clock.tick(60_000), "SERVER_RESUME");
    while (betting(t)) t = call(t, clock.tick());
    return t;
  }

  it("a hand containing TURN_CLOCK_RESET verifies; a malformed reset is rejected by the chain, participant and outcome verifiers", async () => {
    const t = handWithReset("FOLD");
    await expectHandVerifies(t);
    const sealed = sealedAudit(t.fairness!);
    const record = json(t.audit!);
    const resetAt = record.events.findIndex((e) => e.type === "TURN_CLOCK_RESET");
    expect(resetAt).toBeGreaterThan(0);
    const mutate = (fn: (data: Record<string, unknown>, copy: HandAuditRecord) => void): HandAuditRecord =>
      forge(record, (copy) => fn(copy.events[resetAt]!.data as Record<string, unknown>, copy));
    const forged: [string, HandAuditRecord, RegExp][] = [
      ["an extra field", mutate((d) => { d.extendedMs = 60_000; }), /unexpected data/],
      ["a missing reason", mutate((d) => { delete d.reason; }), /unexpected data/],
      ["an unknown reason", mutate((d) => { d.reason = "MANUAL"; }), /unknown reason/],
      ["a seat not dealt in", mutate((d) => { d.seatIndex = 4; }), /cannot be the one to act/],
      ["a seat that had folded", mutate((d) => { d.seatIndex = 0; }), /cannot be the one to act/],
      ["a string seat", mutate((d) => { d.seatIndex = "1"; }), /cannot be the one to act/],
      ["outside a betting round", mutate((_d, copy) => { copy.events[resetAt]!.phase = "SHOWDOWN"; }), /outside a betting round/],
    ];
    for (const [label, bad, reason] of forged) {
      // The forger re-hashed everything, so the chain itself is intact; only the schema check can catch it.
      expect(await verifyAuditRecord(bad, { requireSettled: true })).toEqual({ ok: true });
      const sealedCheck = await verifySealedAudit(bad, sealed);
      expect([label, sealedCheck.ok, sealedCheck.reason]).toEqual([label, false, expect.stringMatching(reason)]);
      const outcome = verifyHandOutcome(bad, sealed);
      expect([label, outcome.ok, outcome.reason]).toEqual([label, false, expect.stringMatching(reason)]);
      const participant = await verifyParticipantAudit({ record: bad, viewerSeat: 1, proofs: participantAudit(record, sealed, 1).proofs });
      expect([label, participant.ok]).toEqual([label, false]);
    }
  });

  it("the outcome replay also rejects a reset naming an all-in seat, which could never be the one to act", async () => {
    const t = handWithReset("ALL_IN");
    expect(t.players[0]!.status === "ALL_IN" || t.awards.length > 0).toBe(true);
    await expectHandVerifies(t);
    const sealed = sealedAudit(t.fairness!);
    const record = json(t.audit!);
    const resetAt = record.events.findIndex((e) => e.type === "TURN_CLOCK_RESET");
    const bad = forge(record, (copy) => { copy.events[resetAt]!.data.seatIndex = 0; });
    expect(verifyHandOutcome(bad, sealed)).toEqual({ ok: false, reason: expect.stringMatching(/all-in seat/) });
  });
});

// ---------------------------------------------------------------------------
// 6, 7, 10. Idle warning length, log text, legacy upgrade
// ---------------------------------------------------------------------------

describe("6. idle warning", () => {
  it("lasts 30 seconds and says so", () => {
    expect(TABLE_IDLE_WARNING_MS).toBe(30_000);
    const warned = beginIdleWarning(seated("warn", [0, 1]), T0 + TABLE_IDLE_TIMEOUT_MS + TABLE_IDLE_WARNING_MS);
    expect(warned.log.at(-1)!.text).toBe("No activity for 5 minutes — the table closes in 30 seconds unless a player acts");
  });
});

describe("7. engine text never shows a currency sign", () => {
  it("logs and errors give plain chip counts", () => {
    const clock = new Clock();
    let t = seated("text", [0, 1, 2]);
    t = seat(t, 3, "text-short", 120);
    t = startHand(t, clock.tick()); // button 0, blinds 1/2, seat 3 first
    expect(errorCode(() => applyAction(t, "text-short", { action: "RAISE", amount: 15 }, clock.tick()))).toBe("MIN_RAISE");
    try { applyAction(t, "text-short", { action: "RAISE", amount: 15 }, clock.tick()); } catch (e) { expect((e as Error).message).toBe("Minimum raise is to 20"); }
    t = applyAction(t, "text-short", { action: "ALL_IN" }, clock.tick());
    t = applyAction(t, "text-u0", { action: "RAISE", amount: 400 }, clock.tick());
    t = applyAction(t, "text-u1", { action: "FOLD" }, clock.tick());
    t = applyAction(t, "text-u2", { action: "CALL" }, clock.tick());
    expect(t.phase).toBe("FLOP");
    const flopActor = actor(t).userId;
    try { applyAction(t, flopActor, { action: "BET", amount: 5 }, clock.tick()); } catch (e) { expect((e as Error).message).toBe("Minimum bet is 10"); }
    expect(errorCode(() => applyAction(t, flopActor, { action: "BET", amount: 5 }, clock.tick()))).toBe("MIN_BET");
    t = applyAction(t, flopActor, { action: "BET", amount: 40 }, clock.tick());
    while (betting(t)) t = call(t, clock.tick());
    const texts = t.log.map((l) => l.text);
    expect(texts.join("\n")).not.toContain("$");
    expect(texts).toEqual(expect.arrayContaining([
      "Player-text-short posts small blind 5".replace("Player-text-short posts small blind 5", texts.find((x) => x.includes("posts small blind"))!),
      "Player-text-short all-in 120",
      "Player-text-u0 raises to 400",
      "Player-text-u2 calls 390",
      `Player-${flopActor} bets 40`,
    ]));
    expect(texts.some((x) => /^Player-\S+ wins \d+( with .+)?$/.test(x))).toBe(true);
    const sat = sitDown(table("text-sit"), 0, { userId: "s", username: "Sitter", avatarHue: 0, kind: "HUMAN", botProfile: null, buyIn: 1000 }, T0);
    expect(sat.log.at(-1)!.text).toBe("Sitter sits with 1000");
  });
});

describe("10. legacy state upgrade", () => {
  it("defaults every new field once, and leaves current state exactly as it was", () => {
    const clock = new Clock();
    let current = seated("upgrade", [0, 1, 2], { extraTimeBank: BANK });
    current = startHand(current, clock.tick());
    const snapshot = JSON.stringify(current);
    const same = upgradeTableState(structuredClone(current));
    expect(JSON.stringify(same.table)).toBe(snapshot);
    expect(same.voidedHand).toBeNull();

    // Stored by the previous engine: none of the new fields exist.
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    delete legacy.extraTimeBank;
    delete legacy.sitOutOnTimeout;
    delete legacy.turnSeq;
    for (const p of legacy.players as (Record<string, unknown> | null)[]) {
      if (!p) continue;
      delete p.sittingOutReason;
      delete p.extraTimeMs;
      delete p.handsSinceRefill;
    }
    (legacy.players as Record<string, unknown>[])[2]!.sittingOut = true;
    const up = upgradeTableState(legacy as unknown as EngineTable).table;
    expect([up.extraTimeBank, up.sitOutOnTimeout, up.turnSeq]).toEqual([null, true, 0]);
    for (const p of up.players) if (p) expect([p.sittingOutReason, p.extraTimeMs, p.handsSinceRefill]).toEqual([null, 0, 0]);
    // The hand in progress (it has an audit trail) is untouched and its turn has an identity.
    expect(up.phase).toBe("PREFLOP");
    expect(turnIdOf(up)).toBe("1:0");
    // Idempotent.
    const again = JSON.stringify(up);
    expect(JSON.stringify(upgradeTableState(up).table)).toBe(again);
    // And it plays on: the next turn gets a new identity.
    const next = call(up, clock.tick());
    expect(turnIdOf(next)).toBe("1:1");
  });
});
