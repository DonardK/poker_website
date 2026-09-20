import { prisma } from "../db/prisma.js";

export async function getActiveTableForUser(userId: string): Promise<string | null> {
  const seat = await prisma.tableSeat.findUnique({ where: { userId }, select: { tableId: true } });
  return seat?.tableId ?? null;
}
