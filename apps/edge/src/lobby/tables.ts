import type { TableListItem } from "@poker/shared";
import type { PrismaClient } from "../generated/prisma/client";

/**
 * Same filter, order, limit, and active-seat inclusion as GET /api/tables
 * (`apps/server/src/routes/tables.ts`). `isSeated` is for `userId` only.
 */
export async function loadLobbyTables(prisma: PrismaClient, userId: string): Promise<TableListItem[]> {
  const tables = await prisma.table.findMany({
    where: { status: { not: "CLOSED" }, isPrivate: false, seats: { none: { playerKind: "BOT" } } },
    include: { seats: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const activeSeat = await prisma.tableSeat.findUnique({ where: { userId }, select: { tableId: true } });
  if (activeSeat && !tables.some((table) => table.id === activeSeat.tableId)) {
    const active = await prisma.table.findUnique({ where: { id: activeSeat.tableId }, include: { seats: true } });
    if (active && active.status !== "CLOSED") tables.unshift(active);
  }
  return tables.map((table) => toListItem(table, userId));
}

export async function activeTableId(prisma: PrismaClient, userId: string): Promise<string | null> {
  const seat = await prisma.tableSeat.findUnique({ where: { userId }, select: { tableId: true } });
  return seat?.tableId ?? null;
}

function toListItem(
  table: {
    id: string;
    name: string;
    status: TableListItem["status"];
    maxSeats: number;
    smallBlind: number;
    bigBlind: number;
    minBuyIn: number;
    maxBuyIn: number;
    seats: { userId: string | null; status: string; playerKind: string }[];
  },
  userId: string,
): TableListItem {
  return {
    id: table.id,
    isSeated: table.seats.some((seat) => seat.userId === userId),
    name: table.name,
    status: table.status,
    maxSeats: table.maxSeats,
    occupiedSeats: table.seats.filter((seat) => seat.status !== "EMPTY").length,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    botCount: table.seats.filter((seat) => seat.playerKind === "BOT").length,
  };
}
