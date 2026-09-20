import { BOT_THINK_FOLD_MS, BOT_THINK_RIVER_RAISE_MS } from "@poker/shared";
import { randIntInclusive } from "../rng.js";
import type { EngineIntent, EngineTable } from "../types.js";
import { legalActions } from "../legal.js";

export function botDelayMs(table: EngineTable, intent: EngineIntent): number {
  const legal = table.toActSeat != null ? legalActions(table, table.toActSeat) : null;
  const facing = legal?.callAmount ?? 0;
  const pot = Math.max(1, table.potTotal);
  if (intent.action === "FOLD" && table.phase === "PREFLOP") {
    return randIntInclusive(BOT_THINK_FOLD_MS[0], BOT_THINK_FOLD_MS[1]);
  }
  if (table.phase === "RIVER" && facing >= pot * 0.75 && intent.action !== "FOLD") {
    return randIntInclusive(BOT_THINK_RIVER_RAISE_MS[0], BOT_THINK_RIVER_RAISE_MS[1]);
  }
  if (intent.action === "RAISE" || intent.action === "BET" || intent.action === "ALL_IN") {
    return randIntInclusive(1400, 3200);
  }
  return randIntInclusive(700, 2200);
}
