import type { BotProfile } from "@poker/shared";
import { chenScore } from "./chen.js";
import { botDelayMs } from "./delay.js";
import { legalActions } from "../legal.js";
import { monteCarloEquity } from "./montecarlo.js";
import { secureRandomFloat } from "../rng.js";
import { contenders } from "../seats.js";
import { analyzeBoard, hasFlushBlocker } from "./texture.js";
import type { EngineIntent, EnginePlayer, EngineTable } from "../types.js";

export interface BotDecision {
  intent: EngineIntent;
  delayMs: number;
}

export function decideBotAction(table: EngineTable): BotDecision {
  if (table.toActSeat == null) throw new Error("No actor");
  const player = table.players[table.toActSeat];
  const legal = legalActions(table, table.toActSeat);
  if (!player || !legal || !player.holeCards) {
    return { intent: { action: "FOLD" }, delayMs: 800 };
  }
  const profile = player.botProfile ?? "TAG";
  const intent = choose(table, player, legal, profile);
  return { intent, delayMs: botDelayMs(table, intent) };
}

function choose(
  table: EngineTable,
  player: EnginePlayer,
  legal: NonNullable<ReturnType<typeof legalActions>>,
  profile: BotProfile,
): EngineIntent {
  const toCall = legal.callAmount;
  const pot = Math.max(table.potTotal, 1);
  const potOdds = toCall / (pot + toCall || 1);
  const chen = chenScore(player.holeCards!);
  const pos = positionTightness(table, player.seatIndex);
  const texture = analyzeBoard(table.board);
  const opponents = Math.max(1, contenders(table).length - 1);
  const equity =
    table.phase === "PREFLOP"
      ? Math.min(0.95, Math.max(0.08, chen / 22))
      : monteCarloEquity(player.holeCards!, table.board, opponents, profile === "GTO" ? 280 : 120);

  if (profile === "MANIAC") return maniac(legal, toCall, pot, chen);
  if (profile === "LOOSE_PASSIVE") return callingStation(legal, toCall, pot, potOdds, chen, texture, equity);
  if (profile === "GTO") return gto(legal, toCall, pot, potOdds, chen, pos, equity, player, table, texture);
  return tag(legal, toCall, pot, potOdds, chen, pos, equity, texture);
}

function tag(
  legal: NonNullable<ReturnType<typeof legalActions>>,
  toCall: number,
  pot: number,
  potOdds: number,
  chen: number,
  pos: number,
  equity: number,
  texture: ReturnType<typeof analyzeBoard>,
): EngineIntent {
  const openNeed = 8 - pos;
  if (toCall === 0) {
    if (chen >= openNeed || equity > 0.62) return betSize(legal, pot, 0.7);
    if (legal.actions.includes("CHECK")) return { action: "CHECK" };
    return { action: "FOLD" };
  }
  if (chen >= openNeed + 3 && legal.actions.includes("RAISE")) return betSize(legal, pot, 1);
  if (equity > potOdds + 0.08 || chen >= openNeed) return callOrCheck(legal);
  if (texture.wet && equity > potOdds) return callOrCheck(legal);
  return foldOrCheck(legal);
}

function callingStation(
  legal: NonNullable<ReturnType<typeof legalActions>>,
  toCall: number,
  pot: number,
  potOdds: number,
  chen: number,
  texture: ReturnType<typeof analyzeBoard>,
  equity: number,
): EngineIntent {
  if (toCall === 0) {
    if (chen >= 12) return betSize(legal, Math.max(pot, 1), 0.45);
    return foldOrCheck(legal);
  }
  if (chen >= 3 || equity + 0.12 > potOdds || texture.wet) return callOrCheck(legal);
  if (toCall < 40) return callOrCheck(legal);
  return foldOrCheck(legal);
}

function maniac(
  legal: NonNullable<ReturnType<typeof legalActions>>,
  toCall: number,
  pot: number,
  chen: number,
): EngineIntent {
  const r = secureRandomFloat();
  if (r < 0.55 && (legal.actions.includes("BET") || legal.actions.includes("RAISE") || legal.actions.includes("ALL_IN"))) {
    return betSize(legal, pot, 1.4 + r);
  }
  if (toCall === 0 && legal.actions.includes("CHECK") && r < 0.75) return { action: "CHECK" };
  if (toCall > 0 && (chen >= 2 || r < 0.65)) return callOrCheck(legal);
  return foldOrCheck(legal);
}

function gto(
  legal: NonNullable<ReturnType<typeof legalActions>>,
  toCall: number,
  pot: number,
  potOdds: number,
  chen: number,
  pos: number,
  equity: number,
  player: EnginePlayer,
  table: EngineTable,
  texture: ReturnType<typeof analyzeBoard>,
): EngineIntent {
  const blocker = player.holeCards ? hasFlushBlocker(player.holeCards, table.board) : false;
  const bluff = blocker && texture.flushDraw && secureRandomFloat() < 0.35;
  if (toCall === 0) {
    if (equity > 0.55 || chen >= 9 - pos || bluff) return betSize(legal, pot, 0.66);
    return legal.actions.includes("CHECK") ? { action: "CHECK" } : { action: "FOLD" };
  }
  const evCall = equity * (pot + toCall) - (1 - equity) * toCall;
  if (equity > 0.72 && legal.actions.includes("RAISE")) return betSize(legal, pot, 0.75);
  if (evCall > 0 || equity >= potOdds) return callOrCheck(legal);
  return foldOrCheck(legal);
}

function betSize(
  legal: NonNullable<ReturnType<typeof legalActions>>,
  pot: number,
  fraction: number,
): EngineIntent {
  if (legal.actions.includes("BET") || legal.actions.includes("RAISE")) {
    const raw = Math.floor(legal.minRaiseTo + Math.max(0, pot) * fraction);
    const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, raw));
    if (to >= legal.maxRaiseTo && legal.actions.includes("ALL_IN") && to > legal.minRaiseTo * 2) {
      return { action: "ALL_IN" };
    }
    return { action: legal.actions.includes("BET") ? "BET" : "RAISE", amount: to };
  }
  if (legal.actions.includes("ALL_IN") && secureRandomFloat() < 0.25) return { action: "ALL_IN" };
  return callOrCheck(legal);
}

function callOrCheck(legal: NonNullable<ReturnType<typeof legalActions>>): EngineIntent {
  if (legal.actions.includes("CHECK")) return { action: "CHECK" };
  if (legal.actions.includes("CALL")) return { action: "CALL" };
  if (legal.actions.includes("ALL_IN")) return { action: "ALL_IN" };
  return { action: "FOLD" };
}

function foldOrCheck(legal: NonNullable<ReturnType<typeof legalActions>>): EngineIntent {
  if (legal.actions.includes("CHECK")) return { action: "CHECK" };
  return { action: "FOLD" };
}

/** 0 = UTG (tight), 3 = button (widest). */
function positionTightness(table: EngineTable, seat: number): number {
  const seats = table.players
    .map((p, i) => (p && p.status !== "ELIMINATED" && p.status !== "SIT_OUT" ? i : -1))
    .filter((i) => i >= 0);
  const btn = table.dealerSeat;
  const idx = seats.indexOf(seat);
  const btnIdx = seats.indexOf(btn);
  if (idx < 0 || btnIdx < 0) return 1;
  const distFromUtg = (idx - ((btnIdx + 1) % seats.length) + seats.length) % seats.length;
  return Math.min(3, distFromUtg);
}
