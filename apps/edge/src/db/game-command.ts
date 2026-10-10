import type { PrismaClient } from "../generated/prisma/client";

/** Id formats from ARCHITECTURE.md section 3. Clients never send the server-generated prefixes. */
export function clientCommandId(commandId: string): string {
  return `cmd:${commandId}`;
}

export function timerCommandId(tableId: string, turnId: string): string {
  return `timer:${tableId}:${turnId}`;
}

export function showdownCommandId(tableId: string, handNumber: number): string {
  return `showdown:${tableId}:${handNumber}`;
}

export function dealCommandId(tableId: string, handNumber: number): string {
  return `deal:${tableId}:${handNumber}`;
}

export function closeCommandId(tableId: string, closeReason: string, revision: number): string {
  return `close:${tableId}:${closeReason}:${revision}`;
}

export interface GameCommandRow {
  id: string;
  tableId: string;
  userId: string | null;
  kind: string;
  appliedRevision: number;
}

type GameCommandTx = {
  gameCommand: {
    create: PrismaClient["gameCommand"]["create"];
  };
};

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

/**
 * Insert the idempotency row inside the caller's Postgres transaction.
 * A unique conflict means this mutation already committed.
 */
export async function insertGameCommand(tx: GameCommandTx, row: GameCommandRow): Promise<"inserted" | "duplicate"> {
  try {
    await tx.gameCommand.create({
      data: {
        id: row.id,
        tableId: row.tableId,
        userId: row.userId,
        kind: row.kind,
        appliedRevision: row.appliedRevision,
      },
    });
    return "inserted";
  } catch (error) {
    if (isUniqueConflict(error)) return "duplicate";
    throw error;
  }
}
