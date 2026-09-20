import { applyAction, applyTimeout, completeHand, createTable, leaveSeat, sitDown, sitIn, sitOut, startHand } from "../table.js";
import { evaluate } from "../evaluate.js";
import { decideBotAction } from "../bots/decide.js";
import { legalActions } from "../legal.js";
import { toPublicTableState } from "../public.js";
import type { BotProfile, PlayerKind } from "@poker/shared";
import type { SeatPlayerConfig } from "../types.js";

function seated(n: number, buyIn = 1000) {
  let table = createTable({
    tableId: "t1",
    name: "Test",
    maxSeats: 6,
    smallBlind: 5,
    bigBlind: 10,
    timeBankMs: 15_000,
  });
  for (let i = 0; i < n; i += 1) {
    const cfg: SeatPlayerConfig = {
      userId: `u${i}`,
      username: `P${i}`,
      avatarHue: i * 20,
      kind: (i === 0 ? "HUMAN" : "BOT") as PlayerKind,
      botProfile: i === 0 ? null : "TAG",
      buyIn,
    };
    table = sitDown(table, i, cfg);
  }
  return table;
}

describe("game loop", () => {
  it("posts blinds, deals UTG first, and folds around to the raiser", () => {
    let table = startHand(seated(3));
    expect(table.phase).toBe("PREFLOP");
    expect(table.board).toHaveLength(0);
    expect(table.dealerSeat).toBe(0);
    expect(table.sbSeat).toBe(1);
    expect(table.bbSeat).toBe(2);
    expect(table.toActSeat).toBe(0);
    expect(table.potTotal).toBe(15);

    table = applyAction(table, "u0", { action: "RAISE", amount: 40 });
    table = applyAction(table, "u1", { action: "FOLD" });
    table = applyAction(table, "u2", { action: "FOLD" });

    expect(table.phase).toBe("SHOWDOWN");
    expect(table.winners[0]?.seatIndex).toBe(0);
    expect(table.players.reduce((s, p) => s + (p?.stack ?? 0), 0)).toBe(3000);
    expect(table.players[0]?.stack).toBe(1015);
  });

  it("keeps unmatched blinds in one pot until someone is all-in", () => {
    const table = startHand(seated(3));
    expect(table.potTotal).toBe(15);
    expect(table.pots).toHaveLength(1);
    expect(table.pots[0]?.amount).toBe(15);
  });

  it("does not offer fold when a check is free", () => {
    let table = startHand(seated(2));
    table = applyAction(table, "u0", { action: "CALL" });
    const legal = legalActions(table, table.toActSeat!);
    expect(legal?.actions).toContain("CHECK");
    expect(legal?.actions).not.toContain("FOLD");
  });

  it("public sittingOut follows the sit-out flag, not mid-hand SIT_OUT status", () => {
    let table = startHand(seated(3));
    const idleId = table.players.find((p) => p && p.seatIndex !== table.toActSeat)!.userId;
    table = sitOut(table, idleId);
    expect(toPublicTableState(table, idleId).players.find((p) => p.userId === idleId)?.sittingOut).toBe(true);
    table = sitIn(table, idleId);
    const view = toPublicTableState(table, idleId).players.find((p) => p.userId === idleId);
    expect(view?.sittingOut).toBe(false);
    expect(view?.status).toBe("ACTIVE");
  });

  it("rejects a raise below the minimum", () => {
    let table = startHand(seated(3));
    const actor = table.players[table.toActSeat!]!;
    expect(() => applyAction(table, actor.userId, { action: "RAISE", amount: 15 })).toThrow(
      /Minimum raise|not legal/,
    );
  });

  it("timeout checks when the player is not facing a bet", () => {
    let table = startHand(seated(2));
    expect(table.toActSeat).toBe(table.sbSeat);
    table = applyAction(table, "u0", { action: "CALL" });
    table = applyAction(table, "u1", { action: "CHECK" });
    expect(table.phase).toBe("FLOP");
    const seat = table.toActSeat!;
    expect(legalActions(table, seat)?.actions).toContain("CHECK");
    table = applyTimeout(table);
    expect(table.players[seat]?.status).toBe("ACTIVE");
  });

  it("timeout folds when facing a bet", () => {
    let table = startHand(seated(3));
    table = applyAction(table, "u0", { action: "RAISE", amount: 40 });
    const sb = table.toActSeat!;
    table = applyTimeout(table);
    expect(table.players[sb]?.status).toBe("FOLDED");
  });

  it("heads-up button is the small blind and acts first preflop", () => {
    const table = startHand(seated(2));
    expect(table.sbSeat).toBe(table.dealerSeat);
    expect(table.bbSeat).not.toBe(table.dealerSeat);
    expect(table.toActSeat).toBe(table.sbSeat);
  });

  it("does not reopen betting after an incomplete all-in", () => {
    let table = createTable({
      tableId: "t1",
      name: "Test",
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      timeBankMs: 15_000,
    });
    table = sitDown(table, 0, {
      userId: "u0",
      username: "P0",
      avatarHue: 0,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 1000,
    });
    table = sitDown(table, 1, {
      userId: "u1",
      username: "P1",
      avatarHue: 20,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 1000,
    });
    table = sitDown(table, 2, {
      userId: "u2",
      username: "P2",
      avatarHue: 40,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 50,
      skipBuyInCheck: true,
    });
    table = startHand(table);
    table = applyAction(table, "u0", { action: "RAISE", amount: 40 });
    table = applyAction(table, "u1", { action: "CALL" });
    table = applyAction(table, "u2", { action: "ALL_IN" });
    expect(table.toActSeat).toBe(0);
    const legal = legalActions(table, 0);
    expect(legal?.actions).toContain("CALL");
    expect(legal?.actions).not.toContain("RAISE");
  });

  it("runs out the board when players are all-in", () => {
    let table = createTable({
      tableId: "t1",
      name: "Test",
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      timeBankMs: 15_000,
    });
    table = sitDown(table, 0, {
      userId: "u0",
      username: "P0",
      avatarHue: 0,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 40,
      skipBuyInCheck: true,
    });
    table = sitDown(table, 1, {
      userId: "u1",
      username: "P1",
      avatarHue: 20,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 40,
      skipBuyInCheck: true,
    });
    table = startHand(table);
    table = applyAction(table, "u0", { action: "ALL_IN" });
    if (table.phase !== "SHOWDOWN") {
      table = applyAction(table, "u1", { action: "ALL_IN" });
    }
    expect(table.phase).toBe("SHOWDOWN");
    expect(table.board).toHaveLength(5);
    expect(table.burns).toHaveLength(3);
    expect(table.players.reduce((s, p) => s + (p?.stack ?? 0), 0)).toBe(80);
  });

  it("clears busted-player commitments so the next hand starts at the blinds", () => {
    let table = createTable({
      tableId: "t1",
      name: "Test",
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      timeBankMs: 15_000,
    });
    table = sitDown(table, 0, {
      userId: "u0",
      username: "P0",
      avatarHue: 0,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 40,
      skipBuyInCheck: true,
    });
    table = sitDown(table, 1, {
      userId: "u1",
      username: "P1",
      avatarHue: 20,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 40,
      skipBuyInCheck: true,
    });
    table = sitDown(table, 2, {
      userId: "u2",
      username: "P2",
      avatarHue: 40,
      kind: "HUMAN",
      botProfile: null,
      buyIn: 1000,
    });
    table = startHand(table);
    let guard = 0;
    while (table.phase !== "SHOWDOWN" && table.toActSeat != null && guard < 20) {
      guard += 1;
      table = applyAction(table, table.players[table.toActSeat]!.userId, { action: legalActions(table, table.toActSeat!)!.actions.includes("ALL_IN") ? "ALL_IN" : "CALL" });
    }
    expect(table.phase).toBe("SHOWDOWN");
    table = completeHand(table);
    expect(table.players.filter((p) => p && p.stack <= 0)).toEqual([]);
    const remaining = table.players.filter((p) => p && p.stack > 0);
    expect(remaining.length).toBeGreaterThanOrEqual(1);
    if (remaining.length >= 2) {
      table = startHand(table);
      expect(table.phase).toBe("PREFLOP");
      expect(table.currentBet).toBe(10);
      expect(table.potTotal).toBe(15);
      expect(table.pots).toHaveLength(1);
    } else {
      expect(table.phase).toBe("WAITING");
    }
  });

  it("advances a dead button and forward-moving blinds after an elimination", () => {
    let table = startHand(seated(4));
    expect(table.dealerSeat).toBe(0);
    while (table.phase !== "SHOWDOWN" && table.toActSeat != null) {
      table = applyAction(table, table.players[table.toActSeat]!.userId, { action: "FOLD" });
    }
    table = completeHand(table);
    table.players[1]!.stack = 0;
    table = startHand(table);
    expect(table.dealerSeat).toBe(1);
    expect(table.players[1]?.status).toBe("ELIMINATED");
    expect(table.sbSeat).toBe(2);
    expect(table.bbSeat).toBe(3);
  });

  it("masks opponent hole cards until showdown", () => {
    const table = startHand(seated(3));
    const hero = toPublicTableState(table, "u0");
    expect(hero.players[0]?.holeCards).toHaveLength(2);
    expect(hero.players[1]?.holeCards).toBeNull();
    const stranger = toPublicTableState(table, "viewer");
    expect(stranger.players.every((p) => p.holeCards == null)).toBe(true);
  });

  it("bots always return a legal action", () => {
    let table = startHand(seated(4));
    for (let i = 0; i < 12 && table.toActSeat != null && table.phase !== "SHOWDOWN"; i += 1) {
      const { intent } = decideBotAction(table);
      const actor = table.players[table.toActSeat]!;
      const legal = legalActions(table, actor.seatIndex);
      expect(legal?.actions).toContain(intent.action);
      table = applyAction(table, actor.userId, intent);
    }
    expect(["PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"]).toContain(table.phase);
  });

  it("conserves chips through a full bot hand", () => {
    let table = startHand(seated(5));
    let guard = 0;
    while (table.phase !== "SHOWDOWN" && guard < 80) {
      guard += 1;
      if (table.toActSeat == null) break;
      const actor = table.players[table.toActSeat]!;
      const { intent } = decideBotAction(table);
      table = applyAction(table, actor.userId, intent);
    }
    const total = table.players.reduce((s, p) => s + (p?.stack ?? 0), 0);
    expect(total).toBe(5000);
  });
});

describe("leaveSeat", () => {
  it("cashes out immediately between hands", () => {
    let table = seated(3);
    table = leaveSeat(table, "u0");
    expect(table.players[0]).toBeNull();
    expect(table.cashOuts).toEqual([{ userId: "u0", stack: 1000 }]);
    expect(table.players.reduce((s, p) => s + (p?.stack ?? 0), 0) + table.cashOuts.reduce((s, c) => s + c.stack, 0)).toBe(
      3000,
    );
  });

  it("folds mid-hand and cashes out remaining chips after settlement", () => {
    let table = startHand(seated(3));
    const leaver = table.players.find((p) => p && p.userId !== table.players[table.toActSeat!]?.userId)!;
    const leaverId = leaver.userId;
    const leaverSeat = leaver.seatIndex;
    table = leaveSeat(table, leaverId);
    expect(table.players[leaverSeat]?.pendingLeave).toBe(true);
    expect(table.players[leaverSeat]?.status).toBe("ACTIVE");

    let guard = 0;
    while (table.phase !== "SHOWDOWN" && table.toActSeat != null && guard < 40) {
      guard += 1;
      const actor = table.players[table.toActSeat]!;
      const legal = legalActions(table, actor.seatIndex);
      table = applyAction(table, actor.userId, { action: legal?.actions.includes("CHECK") ? "CHECK" : "FOLD" });
    }
    expect(table.phase).toBe("SHOWDOWN");
    table = completeHand(table);
    expect(table.players[leaverSeat]).toBeNull();
    const cashed = table.cashOuts.find((c) => c.userId === leaverId);
    expect(cashed).toBeDefined();
    expect(table.players.reduce((s, p) => s + (p?.stack ?? 0), 0) + table.cashOuts.reduce((s, c) => s + c.stack, 0)).toBe(
      3000,
    );
  });
});

describe("evaluator used at showdown", () => {
  it("still ranks a royal", () => {
    expect(evaluate(["Ah", "Kh", "Qh", "Jh", "Th"]).category).toBe("ROYAL_FLUSH");
  });
});

describe("bot profiles at a table", () => {
  it("conserves chips for mixed TAG / station / maniac / GTO seats", () => {
    const profiles: BotProfile[] = ["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"];
    let table = createTable({
      tableId: "mix",
      name: "Mix",
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      timeBankMs: 15_000,
    });
    for (let i = 0; i < 5; i += 1) {
      table = sitDown(table, i, {
        userId: `b${i}`,
        username: `B${i}`,
        avatarHue: i * 40,
        kind: "BOT",
        botProfile: profiles[i % profiles.length]!,
        buyIn: 1000,
      });
    }
    table = startHand(table);
    let guard = 0;
    while (table.phase !== "SHOWDOWN" && guard < 80) {
      guard += 1;
      if (table.toActSeat == null) break;
      const actor = table.players[table.toActSeat]!;
      const { intent } = decideBotAction(table);
      const legal = legalActions(table, actor.seatIndex);
      expect(legal?.actions).toContain(intent.action);
      table = applyAction(table, actor.userId, intent);
    }
    expect(table.phase).toBe("SHOWDOWN");
    expect(table.players.reduce((s, p) => s + (p?.stack ?? 0), 0)).toBe(5000);
  });
});
