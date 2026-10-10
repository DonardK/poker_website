import type { PrismaClient } from "../generated/prisma/client";

export interface TableKeepAlivePort {
  /** Second argument is the client command UUID. See the WP4 contract note. */
  keepAlive(userId: string, commandId: string): Promise<{ duplicate?: boolean } | void>;
}

export type KeepAliveRelay =
  | { ok: true; duplicate?: boolean }
  | { ok: false; code: "NOT_SEATED"; message: string };

const NOT_SEATED = "Only seated players can keep the table open";

/** Human seat at this table. EMPTY seats and bots cannot keep a table open. */
export function isSeatedHuman(
  seat: { tableId: string; playerKind: string; status: string } | null,
  tableId: string,
): boolean {
  return seat !== null && seat.tableId === tableId && seat.playerKind === "HUMAN" && seat.status !== "EMPTY";
}

export async function userIsSeated(prisma: PrismaClient, userId: string, tableId: string): Promise<boolean> {
  const seat = await prisma.tableSeat.findUnique({ where: { userId } });
  return isSeatedHuman(seat, tableId);
}

/**
 * Spectators are refused here and the table RPC is not called. A seated
 * human's keep-alive is forwarded. `pendingLeave` is enforced by TableActor
 * (`keepTableOpen`); that NOT_SEATED comes back as a thrown error.
 */
export async function relayKeepAlive(
  seated: boolean,
  userId: string,
  commandId: string,
  caller: TableKeepAlivePort,
): Promise<KeepAliveRelay> {
  if (!seated) return { ok: false, code: "NOT_SEATED", message: NOT_SEATED };
  const result = await caller.keepAlive(userId, commandId);
  if (result && result.duplicate === true) return { ok: true, duplicate: true };
  return { ok: true };
}

const KNOWN: Record<string, string> = {
  NOT_SEATED: NOT_SEATED,
  TABLE_CLOSING: "This table is closing",
  TABLE_CLOSED: "This table has closed",
  TABLE_NOT_FOUND: "Table not found",
};

/** Map a TableActor keep-alive failure. Unknown failures stay retryable. */
export function keepAliveFailure(err: unknown): { code: string; message: string; retryable?: boolean } {
  const code = readCode(err);
  if (code && KNOWN[code]) return { code, message: KNOWN[code] };
  return { code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable, please retry", retryable: true };
}

function readCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  if (err instanceof Error) {
    for (const code of Object.keys(KNOWN)) {
      if (err.message.includes(code)) return code;
    }
  }
  return undefined;
}
