import type { ActionType, LegalActionSet } from "@poker/shared";
import { canAct } from "./seats.js";
import type { EngineTable } from "./types.js";

export function legalActions(table: EngineTable, seatIndex: number): LegalActionSet | null {
  if (table.toActSeat !== seatIndex) return null;
  if (table.phase === "WAITING" || table.phase === "SHOWDOWN" || table.phase === "COMPLETE") return null;
  const player = table.players[seatIndex];
  if (!canAct(player)) return null;

  const toCall = Math.max(0, table.currentBet - player.committedThisStreet);
  const maxRaiseTo = player.stack + player.committedThisStreet;
  const minBet = table.bigBlind;
  // An all-in below the big blind on a street with no full bet is not itself
  // a full bet. The facing player may complete to the big blind:
  // min raise-to = max(BB, countedBet + lastFullRaiseSize), and those short
  // chips are not counted. Once a full bet exists, one full increment is
  // added on top of every chip already in the bet.
  const countedBet = table.currentBet < minBet ? 0 : table.currentBet;
  const minRaiseTo = Math.max(minBet, countedBet + table.lastFullRaiseSize);
  const lastBet = table.lastActedBet[seatIndex];
  const opponentCanBet = table.players.some((p) => p && p.seatIndex !== seatIndex && canAct(p));
  const mayRaise = opponentCanBet && (!table.actedThisStreet[seatIndex] || lastBet == null || lastBet === 0 || table.currentBet - lastBet >= table.lastFullRaiseSize);

  const actions: ActionType[] = [];
  if (toCall === 0) {
    actions.push("CHECK");
    if (player.stack > 0 && mayRaise) {
      if (table.currentBet === 0) actions.push("BET");
      else actions.push("RAISE");
      actions.push("ALL_IN");
    }
  } else {
    actions.push("FOLD");
    actions.push("CALL");
    if (player.stack > toCall && mayRaise) actions.push("RAISE");
    if (player.stack <= toCall || mayRaise) actions.push("ALL_IN");
  }

  return {
    actions: [...new Set(actions)],
    callAmount: Math.min(toCall, player.stack),
    minBet,
    minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
    maxRaiseTo,
  };
}
