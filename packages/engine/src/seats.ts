import type { EnginePlayer, EngineTable } from "./types.js";

export function isOccupied(p: EnginePlayer | null | undefined): p is EnginePlayer {
  return p != null && p.status !== "ELIMINATED";
}

export function isLiveForDeal(p: EnginePlayer | null | undefined): p is EnginePlayer {
  return isOccupied(p) && !p.sittingOut && p.status !== "SIT_OUT" && p.stack > 0;
}

export function receivesCards(p: EnginePlayer | null | undefined): p is EnginePlayer {
  return (
    isOccupied(p) &&
    !p.sittingOut &&
    p.status !== "SIT_OUT" &&
    p.status !== "ELIMINATED" &&
    (p.stack > 0 || p.status === "ALL_IN" || p.committedThisHand > 0)
  );
}

export function inHand(p: EnginePlayer | null | undefined): p is EnginePlayer {
  return isOccupied(p) && (p.status === "ACTIVE" || p.status === "ALL_IN");
}

export function canAct(p: EnginePlayer | null | undefined): p is EnginePlayer {
  return isOccupied(p) && p.status === "ACTIVE" && p.stack > 0;
}

export function nextIndex(from: number, max: number, step = 1): number {
  return (from + step) % max;
}

export function walkSeats(from: number, max: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= max; i += 1) out.push(nextIndex(from, max, i));
  return out;
}

export function nextMatching(
  table: EngineTable,
  from: number,
  pred: (p: EnginePlayer, seat: number) => boolean,
): number | null {
  for (const seat of walkSeats(from, table.maxSeats)) {
    const p = table.players[seat];
    if (p && pred(p, seat)) return seat;
  }
  return null;
}

export function nextLiveSeat(table: EngineTable, from: number): number | null {
  return nextMatching(table, from, (p) => isLiveForDeal(p));
}

export function nextToActSeat(table: EngineTable, from: number): number | null {
  return nextMatching(table, from, (p) => needsAction(table, p));
}

export function needsAction(table: EngineTable, p: EnginePlayer): boolean {
  if (!canAct(p)) return false;
  if (!table.actedThisStreet[p.seatIndex]) return true;
  return p.committedThisStreet < table.currentBet;
}

export function anyoneNeedsAction(table: EngineTable): boolean {
  return table.players.some((p) => p && needsAction(table, p));
}

export function contenders(table: EngineTable): EnginePlayer[] {
  return table.players.filter((p): p is EnginePlayer => inHand(p) && p.status !== "FOLDED");
}

export function liveDealSeats(table: EngineTable): number[] {
  return table.players
    .map((p, i) => (isLiveForDeal(p) ? i : -1))
    .filter((i) => i >= 0);
}
