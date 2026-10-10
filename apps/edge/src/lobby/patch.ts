import type { LobbyPatchPayload, LobbySeatPatch, TableListItem } from "@poker/shared";

/**
 * One socket's lobby patch. `isSeated` is computed here and `seatedUserIds`
 * is omitted from the client frame.
 *
 * `removed: true` means the table left the public list. A viewer who is in
 * `seatedUserIds` still has the row while the table is not CLOSED, matching
 * the active-seat inclusion on GET /api/tables (private, bot, or older than
 * the newest 50).
 */
export function toLobbyPatch(entry: LobbySeatPatch, userId: string): LobbyPatchPayload {
  const isSeated = entry.seatedUserIds.includes(userId);
  const table: TableListItem = {
    id: entry.table.id,
    isSeated,
    name: entry.table.name,
    status: entry.table.status,
    maxSeats: entry.table.maxSeats,
    occupiedSeats: entry.table.occupiedSeats,
    smallBlind: entry.table.smallBlind,
    bigBlind: entry.table.bigBlind,
    minBuyIn: entry.table.minBuyIn,
    maxBuyIn: entry.table.maxBuyIn,
    botCount: entry.table.botCount,
  };
  if (entry.removed && (entry.table.status === "CLOSED" || !isSeated)) {
    return { removed: true, table };
  }
  return { table };
}
