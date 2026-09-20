import { BOT_THINK_FOLD_MS, BOT_THINK_RIVER_RAISE_MS } from "@poker/shared";
import { chenScore } from "../bots/chen.js";
import { decideBotAction } from "../bots/decide.js";
import { botDelayMs } from "../bots/delay.js";
import { monteCarloEquity } from "../bots/montecarlo.js";
import { analyzeBoard, hasFlushBlocker } from "../bots/texture.js";
import { legalActions } from "../legal.js";
import { applyAction, createTable, sitDown, startHand } from "../table.js";
import type { BotProfile, Card } from "@poker/shared";

describe("Chen formula", () => {
  it("scores premium pairs and broadway suited", () => {
    expect(chenScore(["Ah", "Ad"])).toBe(20);
    expect(chenScore(["2c", "2d"])).toBe(5);
    expect(chenScore(["Ah", "Kh"])).toBe(12);
  });

  it("penalizes gaps and offsuit junk", () => {
    expect(chenScore(["7c", "2d"])).toBeLessThan(0);
    expect(chenScore(["Jh", "9h"])).toBeGreaterThan(chenScore(["Jc", "9d"]));
  });
});

describe("board texture", () => {
  it("marks monotone and connected flops as wet", () => {
    const wet = analyzeBoard(["Ah", "Kh", "Qh"] as Card[]);
    expect(wet.monotone).toBe(true);
    expect(wet.flushDraw).toBe(true);
    expect(wet.wet).toBe(true);
    const dry = analyzeBoard(["Ah", "7c", "2d"] as Card[]);
    expect(dry.wet).toBe(false);
    expect(dry.paired).toBe(false);
  });

  it("detects a high flush blocker", () => {
    expect(hasFlushBlocker(["As", "2c"], ["Ks", "9s", "4s"])).toBe(true);
    expect(hasFlushBlocker(["2h", "3c"], ["Ks", "9s", "4s"])).toBe(false);
  });
});

describe("Monte Carlo equity", () => {
  it("gives AA a large favorite vs one random opponent", () => {
    const eq = monteCarloEquity(["Ah", "Ad"], [], 1, 400);
    expect(eq).toBeGreaterThan(0.75);
    expect(eq).toBeLessThan(0.92);
  });
});

describe("humanized delays", () => {
  it("folds preflop quickly and tanks a river call vs a big raise", () => {
    let table = createTable({
      tableId: "d",
      name: "D",
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      timeBankMs: 15_000,
    });
    table = sitDown(table, 0, {
      userId: "u0",
      username: "P0",
      avatarHue: 0,
      kind: "BOT",
      botProfile: "TAG",
      buyIn: 1000,
    });
    table = sitDown(table, 1, {
      userId: "u1",
      username: "P1",
      avatarHue: 20,
      kind: "BOT",
      botProfile: "TAG",
      buyIn: 1000,
    });
    table = startHand(table);
    const foldDelay = botDelayMs(table, { action: "FOLD" });
    expect(foldDelay).toBeGreaterThanOrEqual(BOT_THINK_FOLD_MS[0]);
    expect(foldDelay).toBeLessThanOrEqual(BOT_THINK_FOLD_MS[1]);

    table.phase = "RIVER";
    table.currentBet = 800;
    table.potTotal = 100;
    const tank = botDelayMs(table, { action: "CALL" });
    expect(tank).toBeGreaterThanOrEqual(BOT_THINK_RIVER_RAISE_MS[0]);
    expect(tank).toBeLessThanOrEqual(BOT_THINK_RIVER_RAISE_MS[1]);
  });
});

describe("decideBotAction legality", () => {
  it("only emits legal intents across profiles and streets", () => {
    const profiles: BotProfile[] = ["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"];
    for (const profile of profiles) {
      let table = createTable({
        tableId: profile,
        name: profile,
        maxSeats: 6,
        smallBlind: 5,
        bigBlind: 10,
        timeBankMs: 15_000,
      });
      for (let i = 0; i < 6; i += 1) {
        table = sitDown(table, i, {
          userId: `${profile}-${i}`,
          username: `${profile}-${i}`,
          avatarHue: i * 15,
          kind: "BOT",
          botProfile: profile,
          buyIn: 1000,
        });
      }
      table = startHand(table);
      let guard = 0;
      while (table.phase !== "SHOWDOWN" && guard < 100) {
        guard += 1;
        if (table.toActSeat == null) break;
        const actor = table.players[table.toActSeat]!;
        const { intent, delayMs } = decideBotAction(table);
        const legal = legalActions(table, actor.seatIndex);
        expect(legal?.actions).toContain(intent.action);
        expect(delayMs).toBeGreaterThan(0);
        table = applyAction(table, actor.userId, intent);
      }
      expect(table.phase).toBe("SHOWDOWN");
      expect(table.players.reduce((s, p) => s + (p?.stack ?? 0), 0)).toBe(6000);
    }
  });
});
