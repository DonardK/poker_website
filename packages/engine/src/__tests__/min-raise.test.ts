import { applyAction, createTable, sitDown, startHand } from "../table.js";
import { legalActions } from "../legal.js";
import { EngineError, type EngineTable } from "../types.js";

/**
 * NL min-raise when the only wagers on a street are all-ins below the big blind.
 * Those chips open the action but are not a full bet, so a player may complete
 * to the big blind. BB = 10 throughout.
 */
function seated(stacks: number[]): EngineTable {
  let t = createTable({
    tableId: `min-raise-${stacks.join("-")}`,
    name: "Min raise",
    maxSeats: 6,
    smallBlind: 5,
    bigBlind: 10,
    timeBankMs: 15_000,
  });
  stacks.forEach((buyIn, seat) => {
    t = sitDown(t, seat, {
      userId: `u${seat}`,
      username: `P${seat}`,
      avatarHue: 0,
      kind: "HUMAN",
      botProfile: null,
      buyIn,
      skipBuyInCheck: true,
    });
  });
  return startHand(t);
}

function act(t: EngineTable, action: "CALL" | "ALL_IN" | "CHECK" | "FOLD" | "RAISE" | "BET", amount?: number): EngineTable {
  return applyAction(t, t.players[t.toActSeat!]!.userId, { action, amount });
}

/** Limp to the flop. Stacks are chosen so the listed seats still hold `left` chips. */
function flop(stacks: number[]): EngineTable {
  let t = seated(stacks);
  expect(t.phase).toBe("PREFLOP");
  while (t.phase === "PREFLOP") {
    const legal = legalActions(t, t.toActSeat!)!;
    t = act(t, legal.actions.includes("CHECK") ? "CHECK" : "CALL");
  }
  expect(t.phase).toBe("FLOP");
  return t;
}

function code(run: () => void): string {
  try {
    run();
    return "none";
  } catch (error) {
    return error instanceof EngineError ? error.code : "other";
  }
}

describe("incomplete opening all-in below the big blind", () => {
  it("lets the next player complete to the big blind (all-in 4, BB 10, min raise-to 10)", () => {
    // Seat 1 posts the small blind and is left with 4. Seat 1 acts first on the flop.
    let t = flop([1000, 14, 1000]);
    expect(t.toActSeat).toBe(1);
    expect(t.players[1]!.stack).toBe(4);
    t = act(t, "ALL_IN");
    expect(t.currentBet).toBe(4);
    expect(t.lastFullRaiseSize).toBe(10);
    expect(t.toActSeat).toBe(2);

    const legal = legalActions(t, 2)!;
    expect(legal.minRaiseTo).toBe(10);
    expect(legal.actions).toEqual(expect.arrayContaining(["FOLD", "CALL", "RAISE"]));
    expect(code(() => act(t, "RAISE", 9))).toBe("MIN_RAISE");
    expect(code(() => act(t, "RAISE", 14))).toBe("none");

    t = act(t, "RAISE", 10);
    expect(t.currentBet).toBe(10);
    expect(t.lastFullRaiseSize).toBe(10);
    expect(t.players[2]!.committedThisStreet).toBe(10);
    // The completion is the first full bet, so the next full raise is another 10.
    expect(legalActions(t, t.toActSeat!)!.minRaiseTo).toBe(20);
    expect(code(() => act(t, "RAISE", 19))).toBe("MIN_RAISE");
  });

  it("keeps the minimum at the big blind across cumulative short all-ins", () => {
    // Flop stacks: seat 1 has 4, seat 2 has 7. Neither reaches the big blind.
    let t = flop([1000, 14, 17, 1000]);
    expect([t.players[1]!.stack, t.players[2]!.stack]).toEqual([4, 7]);
    t = act(t, "ALL_IN");
    // Seat 2 has only 7, so the displayed minimum is capped by that stack.
    expect(legalActions(t, 2)!.minRaiseTo).toBe(7);
    expect(legalActions(t, 2)!.maxRaiseTo).toBe(7);
    t = act(t, "ALL_IN");
    expect(t.currentBet).toBe(7);
    expect(t.lastFullRaiseSize).toBe(10);
    expect(t.toActSeat).toBe(3);
    const legal = legalActions(t, 3)!;
    expect(legal.minRaiseTo).toBe(10);
    expect(code(() => act(t, "RAISE", 16))).toBe("none");
    expect(code(() => act(t, "RAISE", 9))).toBe("MIN_RAISE");

    t = act(t, "RAISE", 10);
    expect(t.lastFullRaiseSize).toBe(10);
    expect(legalActions(t, t.toActSeat!)!.minRaiseTo).toBe(20);
  });

  it("still allows a completion after three short all-ins that each stay under the big blind", () => {
    // Seat 4 is still able to bet, so seat 4 may raise; a lone caller of three all-ins could not.
    let t = flop([1000, 13, 16, 19, 1000]);
    expect([t.players[1]!.stack, t.players[2]!.stack, t.players[3]!.stack]).toEqual([3, 6, 9]);
    t = act(t, "ALL_IN");
    t = act(t, "ALL_IN");
    t = act(t, "ALL_IN");
    expect(t.currentBet).toBe(9);
    expect(t.toActSeat).toBe(4);
    expect(legalActions(t, 4)!.minRaiseTo).toBe(10);
    expect(legalActions(t, 4)!.actions).toContain("RAISE");
    t = act(t, "RAISE", 10);
    expect(t.currentBet).toBe(10);
    expect(t.lastFullRaiseSize).toBe(10);
    expect(legalActions(t, t.toActSeat!)!.minRaiseTo).toBe(20);
  });

  it("sizes the first full bet as the whole amount, ignoring the short chips under it", () => {
    let t = flop([1000, 14, 1000]);
    t = act(t, "ALL_IN");
    t = act(t, "RAISE", 25);
    expect(t.currentBet).toBe(25);
    expect(t.lastFullRaiseSize).toBe(25);
    expect(legalActions(t, t.toActSeat!)!.minRaiseTo).toBe(50);
    expect(code(() => act(t, "RAISE", 49))).toBe("MIN_RAISE");
  });

  it("treats an all-in that reaches the big blind as that full bet", () => {
    // Seat 2 is left with 12, which clears the 4-chip all-in and the big blind.
    let t = flop([1000, 14, 22]);
    t = act(t, "ALL_IN");
    expect(t.players[2]!.stack).toBe(12);
    t = act(t, "ALL_IN");
    expect(t.currentBet).toBe(12);
    expect(t.lastFullRaiseSize).toBe(12);
    expect(legalActions(t, 0)!.minRaiseTo).toBe(24);
  });

  it("reopens the caller of a short all-in once someone completes to the big blind", () => {
    let t = flop([1000, 14, 1000, 1000]);
    t = act(t, "ALL_IN"); // seat 1, 4
    t = act(t, "CALL"); // seat 2
    t = act(t, "RAISE", 10); // seat 3 completes
    expect(t.lastFullRaiseSize).toBe(10);
    t = act(t, "CALL"); // seat 0
    expect(t.toActSeat).toBe(2);
    const legal = legalActions(t, 2)!;
    expect(legal.actions).toContain("RAISE");
    expect(legal.minRaiseTo).toBe(20);
  });

  it("does not let a second short all-in reopen a player who only called the first", () => {
    let t = flop([1000, 14, 1000, 17]);
    t = act(t, "ALL_IN"); // seat 1, 4 — opening, reopens
    t = act(t, "CALL"); // seat 2
    t = act(t, "ALL_IN"); // seat 3, 7 — still under the big blind
    expect(t.currentBet).toBe(7);
    t = act(t, "FOLD"); // seat 0
    expect(t.toActSeat).toBe(2);
    expect(legalActions(t, 2)!.actions).toEqual(["FOLD", "CALL"]);
  });

  it("reopens a checker to a short opening all-in, at a minimum of the big blind", () => {
    let t = flop([1000, 1000, 14]);
    expect(t.toActSeat).toBe(1);
    t = act(t, "CHECK");
    t = act(t, "ALL_IN");
    expect(t.currentBet).toBe(4);
    t = act(t, "CALL"); // seat 0
    expect(t.toActSeat).toBe(1);
    const legal = legalActions(t, 1)!;
    expect(legal.actions).toContain("RAISE");
    expect(legal.minRaiseTo).toBe(10);
    t = act(t, "RAISE", 10);
    expect(t.currentBet).toBe(10);
    expect(t.lastFullRaiseSize).toBe(10);
  });

  it("does not let the original bettor reraise an incomplete all-in", () => {
    let t = flop([1000, 1000, 24]);
    t = act(t, "BET", 10);
    expect(t.lastFullRaiseSize).toBe(10);
    expect(t.players[2]!.stack).toBe(14);
    t = act(t, "ALL_IN");
    expect(t.currentBet).toBe(14);
    expect(t.lastFullRaiseSize).toBe(10);
    expect(legalActions(t, t.toActSeat!)!.minRaiseTo).toBe(24);
    t = act(t, "CALL");
    // The shove is four chips over a full bet of ten, so the bettor may call but not raise.
    expect(t.toActSeat).toBe(1);
    expect(legalActions(t, 1)!.actions).toEqual(["FOLD", "CALL"]);
  });
});
