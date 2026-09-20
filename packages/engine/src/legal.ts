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
  const minRaiseTo =
    table.currentBet === 0 ? minBet : table.currentBet + table.lastFullRaiseSize;
  const mayRaise = !table.actedThisStreet[seatIndex];

  const actions: ActionType[] = [];
  if (toCall === 0) {
    actions.push("CHECK");
    if (player.stack > 0 && mayRaise) {
      if (table.currentBet === 0) actions.push("BET");
      else actions.push("RAISE");
      actions.push("ALL_IN");
    } else if (player.stack > 0) {
      actions.push("ALL_IN");
    }
  } else {
    actions.push("FOLD");
    if (player.stack >= toCall) actions.push("CALL");
    if (player.stack > toCall && mayRaise) actions.push("RAISE");
    actions.push("ALL_IN");
  }

  return {
    actions: [...new Set(actions)],
    callAmount: Math.min(toCall, player.stack),
    minBet,
    minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
    maxRaiseTo,
  };
}
