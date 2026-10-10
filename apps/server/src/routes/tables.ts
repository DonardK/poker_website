import { Router } from "express";
import {
  ABSOLUTE_MAX_SEATS,
  DEFAULT_MAX_SEATS,
  type HandAuditRecord,
  type SealedHandAudit,
  type TableListItem,
} from "@poker/shared";
import { z } from "zod";
import { env } from "../config.js";
import { prisma } from "../db/prisma.js";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import { logger } from "../logger.js";
import { EngineError } from "@poker/engine";
import { buildParticipantAudit, rowBindingError, sealedAuditContext } from "../game/audit.js";
import { decryptState } from "../game/encryption.js";
import { tableManager } from "../game/manager.js";

export const tablesRouter = Router();

const createTableSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  maxSeats: z.number().int().min(2).max(ABSOLUTE_MAX_SEATS).optional(),
  smallBlind: z.number().int().positive().max(100_000),
  bigBlind: z.number().int().positive().max(200_000),
  buyIn: z.number().int().positive().max(40_000_000),
  botCount: z.number().int().min(0).max(ABSOLUTE_MAX_SEATS - 1).optional(),
});

tablesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const tables = await prisma.table.findMany({
    where: { status: { not: "CLOSED" }, isPrivate: false, seats: { none: { playerKind: "BOT" } } },
    include: { seats: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // The player's seat may be older than the latest 50 public tables.
  const activeSeat = await prisma.tableSeat.findUnique({ where: { userId: req.userId! }, select: { tableId: true } });
  if (activeSeat && !tables.some((table) => table.id === activeSeat.tableId)) {
    const active = await prisma.table.findUnique({ where: { id: activeSeat.tableId }, include: { seats: true } });
    if (active && active.status !== "CLOSED") tables.unshift(active);
  }
  const payload: TableListItem[] = tables.map((table) => ({
    id: table.id,
    isSeated: table.seats.some((seat) => seat.userId === req.userId),
    name: table.name,
    status: table.status,
    maxSeats: table.maxSeats,
    occupiedSeats: table.seats.filter((s) => s.status !== "EMPTY").length,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    botCount: table.seats.filter((s) => s.playerKind === "BOT").length,
  }));
  res.json({ tables: payload });
});

tablesRouter.get("/:id", requireAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) {
    res.status(400).json({ error: "Missing table id" });
    return;
  }
  const table = await prisma.table.findUnique({
    where: { id },
    include: { seats: { include: { user: true }, orderBy: { seatIndex: "asc" } } },
  });
  if (!table || (table.isPrivate && table.hostId !== (req as AuthedRequest).userId && !table.seats.some((seat) => seat.userId === (req as AuthedRequest).userId))) {
    res.status(404).json({ error: "Table not found" });
    return;
  }
  res.json({
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
      seats: table.seats.map((seat) => ({
        seatIndex: seat.seatIndex,
        status: seat.status,
        stack: seat.stack,
        sittingOut: seat.sittingOut,
        playerKind: seat.playerKind,
        botProfile: seat.botProfile,
        user: seat.user
          ? { id: seat.user.id, username: seat.user.username, avatarHue: seat.user.avatarHue }
          : null,
      })),
    },
  });
});

/**
 * Participant post-hand audit.
 *
 * COMPLIANCE NOTES
 * - Only a user dealt into the hand (a HandPlayer row) may read it; everyone
 *   else gets the same 404 as for a missing hand.
 * - The response is the redacted ParticipantHandAudit: the public hash-chained
 *   record, plus Merkle openings for the caller's own hole cards, the dealt
 *   board and hands tabled at showdown. The sealed deck, deck salt, other
 *   Merkle salts and any other player's unshown cards are never included.
 * - The server verifies the audit with the same public verifier the client
 *   runs, bound to the requested table, hand number and caller (the record
 *   must seat the caller at their HandPlayer seat). It then applies an
 *   independent redaction guard that also takes the hand's stored HandPlayer
 *   rows: no seat other than the caller's is opened unless its stored
 *   `showedCards` is true, whatever the record says. Any failure is logged
 *   and returns 500 (fail closed).
 */
tablesRouter.get("/:id/hands/:handNumber/audit", requireAuth, async (req: AuthedRequest, res) => {
  res.set("Cache-Control", "no-store");
  const tableId = String(req.params.id);
  const rawHandNumber = String(req.params.handNumber);
  const handNumber = Number(rawHandNumber);
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!/^[1-9][0-9]{0,9}$/.test(rawHandNumber) || handNumber > 2_147_483_647 || tableId.length > 128) { res.status(400).json({ error: "Invalid hand number" }); return; }
  const hand = await prisma.hand.findUnique({
    where: { tableId_handNumber: { tableId, handNumber } },
    select: {
      tableId: true, handNumber: true, handUuid: true, deckCommitment: true, finalStateHash: true, auditRecord: true, auditSealed: true,
      // Every player row: the redaction guard checks each seat's stored showedCards.
      players: { select: { userId: true, seatIndex: true, showedCards: true } },
    },
  });
  const own = hand?.players.filter((p) => p.userId === userId) ?? [];
  const viewer = own[0];
  if (!hand || !viewer) { res.status(404).json({ error: "Completed hand not found for this player" }); return; }
  if (own.length !== 1) { logger.error({ tableId, handNumber, userId }, "user holds more than one seat in a recorded hand"); res.status(500).json({ error: "Stored hand audit failed verification" }); return; }
  if (!hand.auditRecord || !hand.auditSealed) { res.status(409).json({ error: "This hand predates the compliance audit trail" }); return; }
  const context = { tableId, handNumber, userId, viewerSeat: viewer.seatIndex };
  try {
    const record = hand.auditRecord as unknown as HandAuditRecord;
    const binding = rowBindingError(hand, record);
    if (binding) throw new EngineError("AUDIT_INVALID", binding);
    const sealed = decryptState<SealedHandAudit>(hand.auditSealed, sealedAuditContext(tableId, handNumber));
    const audit = await buildParticipantAudit(record, sealed, context, hand.players);
    res.json({ audit });
  } catch (err) {
    logger.error({ err, security: "AUDIT_INTEGRITY", ...context }, "participant hand audit failed verification; nothing was returned");
    res.status(500).json({ error: "Stored hand audit failed verification" });
  }
});

tablesRouter.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = createTableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid table payload", details: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  if (body.botCount) {
    res.status(400).json({ error: "New tables are for human players only" });
    return;
  }
  if (body.bigBlind !== body.smallBlind * 2) {
    res.status(400).json({ error: "Big blind must be exactly 2× small blind" });
    return;
  }
  const maxSeats = body.maxSeats ?? DEFAULT_MAX_SEATS;
  if (body.buyIn < body.bigBlind * 20 || body.buyIn > body.bigBlind * 200) {
    res.status(400).json({ error: "Buy-in must be between 20bb and 200bb" });
    return;
  }

  const host = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!host || host.bankroll < body.buyIn) {
    res.status(400).json({ error: "Not enough bankroll for that buy-in" });
    return;
  }

  const table = await prisma.$transaction(async (tx) => {
    if (await tx.tableSeat.findFirst({ where: { userId: host.id } })) throw new EngineError("ALREADY_SEATED", "Leave your current table before creating another");
    const paid = await tx.user.updateMany({ where: { id: host.id, kind: "HUMAN", bankroll: { gte: body.buyIn } }, data: { bankroll: { decrement: body.buyIn } } });
    if (!paid.count) throw new EngineError("BANKROLL", "Not enough bankroll");

    return tx.table.create({
      data: {
        name: body.name ?? `${req.username ?? "Player"}'s Table`,
        hostId: req.userId,
        maxSeats,
        smallBlind: body.smallBlind,
        bigBlind: body.bigBlind,
        minBuyIn: body.bigBlind * 20,
        maxBuyIn: body.bigBlind * 200,
        timeBankMs: env.TURN_TIME_BANK_MS,
        seats: {
          create: Array.from({ length: maxSeats }, (_, seatIndex) => seatIndex === 0
            ? { seatIndex, status: "OCCUPIED" as const, playerKind: "HUMAN" as const, userId: req.userId, stack: body.buyIn }
            : { seatIndex, status: "EMPTY" as const }),
        },
      },
      select: { id: true },
    });
  }, { maxWait: 10_000, timeout: 20_000 });

  // Start the idle clock now: a host who never opens the table still gets it
  // closed and the buy-in returned. The table exists either way, so a failure
  // here is logged and the timers start when anyone opens it.
  void tableManager.track(table.id).catch((err) => logger.error({ err, tableId: table.id }, "could not start the new table's timers"));
  res.status(201).json({ tableId: table.id });
});
