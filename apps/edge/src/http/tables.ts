import {
  ABSOLUTE_MAX_SEATS,
  DEFAULT_MAX_SEATS,
  UUID_V4,
  type HandAuditRecord,
  type SealedHandAudit,
  type TableListItem,
} from "@poker/shared";
import { EngineError } from "@poker/engine";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { uniqueViolation } from "../auth/errors";
import { buildParticipantAudit, regulatorVerification, rowBindingError, sealedAuditContext, type StoredHandPlayer } from "../game/audit";
import { decryptState, ringFromConfig } from "../game/crypto";
import { authed, authRoute, type Ctx } from "./guard";
import { errBrief, logError, logInfo } from "./log";
import { trackNewTable } from "./realtime";

const createTableSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  maxSeats: z.number().int().min(2).max(ABSOLUTE_MAX_SEATS).optional(),
  smallBlind: z.number().int().positive().max(100_000),
  bigBlind: z.number().int().positive().max(200_000),
  buyIn: z.number().int().positive().max(40_000_000),
  botCount: z.number().int().min(0).max(ABSOLUTE_MAX_SEATS - 1).optional(),
});

function listItem(table: {
  id: string;
  name: string;
  status: TableListItem["status"];
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  seats: { userId: string | null; status: string; playerKind: string }[];
}, userId: string): TableListItem {
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

export function registerTables(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/tables", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const db = c.get("db")!;
    const tables = await db.table.findMany({
      where: { status: { not: "CLOSED" }, isPrivate: false, seats: { none: { playerKind: "BOT" } } },
      include: { seats: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const activeSeat = await db.tableSeat.findUnique({ where: { userId: gate.userId }, select: { tableId: true } });
    if (activeSeat && !tables.some((table: { id: string }) => table.id === activeSeat.tableId)) {
      const active = await db.table.findUnique({ where: { id: activeSeat.tableId }, include: { seats: true } });
      if (active && active.status !== "CLOSED") tables.unshift(active);
    }
    return c.json({ tables: tables.map((table: Parameters<typeof listItem>[0]) => listItem(table, gate.userId)) });
  }));

  app.get("/api/tables/:id/hands/:handNumber/audit", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    return participantAudit(c, gate.userId);
  }));

  app.get("/api/tables/:id", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing table id" }, 400);
    const table = await c.get("db")!.table.findUnique({
      where: { id },
      include: { seats: { include: { user: true }, orderBy: { seatIndex: "asc" } } },
    });
    if (!table || (table.isPrivate && table.hostId !== gate.userId && !table.seats.some((seat: { userId: string | null }) => seat.userId === gate.userId))) {
      return c.json({ error: "Table not found" }, 404);
    }
    return c.json({
      table: {
        id: table.id,
        name: table.name,
        status: table.status,
        maxSeats: table.maxSeats,
        smallBlind: table.smallBlind,
        bigBlind: table.bigBlind,
        minBuyIn: table.minBuyIn,
        maxBuyIn: table.maxBuyIn,
        timeBankMs: table.timeBankMs,
        seats: table.seats.map((seat: {
          seatIndex: number;
          status: string;
          stack: number;
          sittingOut: boolean;
          playerKind: string;
          botProfile: string | null;
          user: { id: string; username: string; avatarHue: number } | null;
        }) => ({
          seatIndex: seat.seatIndex,
          status: seat.status,
          stack: seat.stack,
          sittingOut: seat.sittingOut,
          playerKind: seat.playerKind,
          botProfile: seat.botProfile,
          user: seat.user ? { id: seat.user.id, username: seat.user.username, avatarHue: seat.user.avatarHue } : null,
        })),
      },
    });
  }));

  app.post("/api/tables", async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = createTableSchema.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid table payload", details: parsed.error.flatten() }, 400);
    const body = parsed.data;
    if (body.botCount) return c.json({ error: "New tables are for human players only" }, 400);
    if (body.bigBlind !== body.smallBlind * 2) return c.json({ error: "Big blind must be exactly 2× small blind" }, 400);
    const maxSeats = body.maxSeats ?? DEFAULT_MAX_SEATS;
    if (body.buyIn < body.bigBlind * 20 || body.buyIn > body.bigBlind * 200) {
      return c.json({ error: "Buy-in must be between 20bb and 200bb" }, 400);
    }
    const db = c.get("db")!;
    const host = await db.user.findUnique({ where: { id: gate.userId } });
    if (!host || host.bankroll < body.buyIn) return c.json({ error: "Not enough bankroll for that buy-in" }, 400);
    let table: { id: string };
    try {
      table = await db.$transaction(async (tx) => {
        if (await tx.tableSeat.findFirst({ where: { userId: host.id } })) {
          throw new EngineError("ALREADY_SEATED", "Leave your current table before creating another");
        }
        const paid = await tx.user.updateMany({
          where: { id: host.id, kind: "HUMAN", bankroll: { gte: body.buyIn } },
          data: { bankroll: { decrement: body.buyIn } },
        });
        if (!paid.count) throw new EngineError("BANKROLL", "Not enough bankroll");
        return tx.table.create({
          data: {
            name: body.name ?? `${gate.username}'s Table`,
            hostId: gate.userId,
            maxSeats,
            smallBlind: body.smallBlind,
            bigBlind: body.bigBlind,
            minBuyIn: body.bigBlind * 20,
            maxBuyIn: body.bigBlind * 200,
            timeBankMs: c.get("config")!.turnTimeBankMs,
            seats: {
              create: Array.from({ length: maxSeats }, (_, seatIndex) => seatIndex === 0
                ? { seatIndex, status: "OCCUPIED", playerKind: "HUMAN", userId: gate.userId, stack: body.buyIn }
                : { seatIndex, status: "EMPTY" }),
            },
          },
          select: { id: true },
        });
      }, { maxWait: 10_000, timeout: 20_000 });
    } catch (err) {
      const clash = uniqueViolation(err);
      const unnamed = clash != null && (clash.fields.length === 0 || clash.fields === "(not available)");
      if (clash && (unnamed || /userId/i.test(clash.fields))) {
        throw new EngineError("ALREADY_SEATED", "Already seated. Leave your current table before creating another");
      }
      if (err instanceof EngineError) throw err;
      logError({ ...errBrief(err), path: "/api/tables" }, "table create failed");
      throw err;
    }
    await trackNewTable(c.env, table.id);
    return c.json({ tableId: table.id }, 201);
  });
}

async function participantAudit(c: Ctx, userId: string): Promise<Response> {
  const tableId = c.req.param("id") ?? "";
  const rawHandNumber = c.req.param("handNumber") ?? "";
  const handNumber = Number(rawHandNumber);
  if (!/^[1-9][0-9]{0,9}$/.test(rawHandNumber) || handNumber > 2_147_483_647 || tableId.length > 128) {
    return c.json({ error: "Invalid hand number" }, 400);
  }
  const hand = await c.get("db")!.hand.findUnique({
    where: { tableId_handNumber: { tableId, handNumber } },
    select: {
      tableId: true, handNumber: true, handUuid: true, deckCommitment: true, finalStateHash: true, auditRecord: true, auditSealed: true,
      players: { select: { userId: true, seatIndex: true, showedCards: true } },
    },
  });
  const players = (hand?.players ?? []) as { userId: string | null; seatIndex: number; showedCards: boolean }[];
  const own = players.filter((player) => player.userId === userId);
  const viewer = own[0];
  if (!hand || !viewer) return c.json({ error: "Completed hand not found for this player" }, 404);
  if (own.length !== 1) {
    logError({ tableId, handNumber, userId }, "user holds more than one seat in a recorded hand");
    return c.json({ error: "Stored hand audit failed verification" }, 500);
  }
  if (!hand.auditRecord || !hand.auditSealed) return c.json({ error: "This hand predates the compliance audit trail" }, 409);
  const context = { tableId, handNumber, userId, viewerSeat: viewer.seatIndex };
  try {
    const record = hand.auditRecord as HandAuditRecord;
    const binding = rowBindingError(hand, record);
    if (binding) throw new EngineError("AUDIT_INVALID", binding);
    const sealed = decryptState<SealedHandAudit>(ringFromConfig(c.get("config")!), hand.auditSealed, sealedAuditContext(tableId, handNumber));
    const stored: StoredHandPlayer[] = players.map((player) => ({ seatIndex: player.seatIndex, showedCards: player.showedCards }));
    const audit = await buildParticipantAudit(record, sealed, context, stored);
    return c.json({ audit });
  } catch (err) {
    logError({ ...errBrief(err), security: "AUDIT_INTEGRITY", tableId, handNumber, userId }, "participant hand audit failed verification; nothing was returned");
    return c.json({ error: "Stored hand audit failed verification" }, 500);
  }
}

export async function readRegulatorAudit(c: Ctx, userId: string): Promise<Response> {
  const handUuid = (c.req.param("handUuid") ?? "").toLowerCase();
  logInfo({ audit: "REGULATOR_HAND_AUDIT_ACCESS", userId, handUuid: handUuid.slice(0, 64) }, "regulator hand audit accessed");
  if (!UUID_V4.test(handUuid)) return c.json({ error: "handUuid must be a UUID v4" }, 400);
  const hand = await c.get("db")!.hand.findUnique({
    where: { handUuid },
    select: { tableId: true, handNumber: true, handUuid: true, deckCommitment: true, finalStateHash: true, auditRecord: true, auditSealed: true },
  });
  if (!hand) return c.json({ error: "Hand not found" }, 404);
  if (!hand.auditRecord || !hand.auditSealed) return c.json({ error: "This hand predates the compliance audit trail" }, 409);
  const record = hand.auditRecord as HandAuditRecord;
  let sealed: SealedHandAudit;
  try {
    sealed = decryptState<SealedHandAudit>(ringFromConfig(c.get("config")!), hand.auditSealed, sealedAuditContext(hand.tableId, hand.handNumber));
  } catch (err) {
    logError({ ...errBrief(err), security: "AUDIT_INTEGRITY", userId, handUuid }, "sealed hand audit failed authenticated decryption");
    return c.json({ error: "Sealed audit failed authenticated decryption" }, 500);
  }
  const previous = await c.get("db")!.hand.findFirst({
    where: { tableId: hand.tableId, handNumber: { lt: hand.handNumber }, finalStateHash: { not: null } },
    orderBy: { handNumber: "desc" },
    select: { handNumber: true, finalStateHash: true },
  });
  const verification = await regulatorVerification(
    hand,
    record,
    sealed,
    previous && previous.finalStateHash !== null ? { handNumber: previous.handNumber, finalStateHash: previous.finalStateHash } : null,
  );
  if (!verification.ok) {
    logError({
      security: "AUDIT_INTEGRITY", userId, handUuid, reason: verification.reason,
      outcome: verification.outcome.ok, tableChain: verification.tableChain.ok, previousHandNumber: verification.tableChain.previousHandNumber,
    }, "stored hand audit failed regulator verification");
  }
  return c.json({ record, sealed, verification });
}
