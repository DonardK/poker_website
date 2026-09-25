import { randomBytes } from "node:crypto";
import { Router } from "express";
import {
  ABSOLUTE_MAX_SEATS,
  BOT_USERNAMES,
  DEFAULT_MAX_SEATS,
  type BotProfile,
  type CreateTableRequest,
  type HandAuditRecord,
  type SealedHandAudit,
  type TableListItem,
} from "@poker/shared";
import { z } from "zod";
import { env } from "../config.js";
import { prisma } from "../db/prisma.js";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import { tableManager } from "../game/manager.js";
import { logger } from "../logger.js";
import { EngineError } from "@poker/engine";
import { buildParticipantAudit, rowBindingError, sealedAuditContext } from "../game/audit.js";
import { decryptState } from "../game/encryption.js";

export const tablesRouter = Router();

const createTableSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  maxSeats: z.number().int().min(2).max(ABSOLUTE_MAX_SEATS).optional(),
  smallBlind: z.number().int().positive().max(100_000),
  bigBlind: z.number().int().positive().max(200_000),
  buyIn: z.number().int().positive().max(40_000_000),
  botCount: z.number().int().min(0).max(ABSOLUTE_MAX_SEATS - 1),
  botProfiles: z.array(z.enum(["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"])).optional(),
});

function cycleProfiles(count: number, requested?: BotProfile[]): BotProfile[] {
  const order: BotProfile[] = requested?.length
    ? requested
    : ["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"];
  return Array.from({ length: count }, (_, i) => order[i % order.length]!);
}

tablesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const tables = await prisma.table.findMany({
    where: { status: { not: "CLOSED" }, isPrivate: false },
    include: { seats: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
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
 *   runs, then applies an independent redaction guard before responding. Any
 *   failure is logged and returns 500 (fail closed).
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
      players: { where: { userId }, select: { seatIndex: true }, take: 2 },
    },
  });
  const viewer = hand?.players[0];
  if (!hand || !viewer) { res.status(404).json({ error: "Completed hand not found for this player" }); return; }
  if (hand.players.length !== 1) { logger.error({ tableId, handNumber, userId }, "user holds more than one seat in a recorded hand"); res.status(500).json({ error: "Stored hand audit failed verification" }); return; }
  if (!hand.auditRecord || !hand.auditSealed) { res.status(409).json({ error: "This hand predates the compliance audit trail" }); return; }
  const context = { tableId, handNumber, userId, viewerSeat: viewer.seatIndex };
  try {
    const record = hand.auditRecord as unknown as HandAuditRecord;
    const binding = rowBindingError(hand, record);
    if (binding) throw new EngineError("AUDIT_INVALID", binding);
    const sealed = decryptState<SealedHandAudit>(hand.auditSealed, sealedAuditContext(tableId, handNumber));
    const audit = await buildParticipantAudit(record, sealed, viewer.seatIndex);
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
  const body: CreateTableRequest = parsed.data;
  if (body.bigBlind !== body.smallBlind * 2) {
    res.status(400).json({ error: "Big blind must be exactly 2× small blind" });
    return;
  }
  const maxSeats = body.maxSeats ?? DEFAULT_MAX_SEATS;
  if (body.botCount >= maxSeats) {
    res.status(400).json({ error: "Need at least one open seat for a human" });
    return;
  }
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
  const paid = await tx.user.updateMany({ where: { id: host.id, kind: "HUMAN", bankroll: { gte: body.buyIn } }, data: { bankroll: { decrement: body.buyIn } } });
  if (!paid.count) throw new EngineError("BANKROLL", "Not enough bankroll");
  if (await tx.tableSeat.findFirst({ where: { userId: host.id } })) throw new EngineError("ALREADY_SEATED", "Leave your current table before creating another");
  const profiles = cycleProfiles(body.botCount, body.botProfiles);
  const bots = await Promise.all(
    profiles.map(async (profile, i) => {
      const pool = BOT_USERNAMES[profile];
      const username = `${pool[i % pool.length]}_${randomBytes(3).toString("hex")}`;
      return tx.user.create({
        data: {
          username,
          kind: "BOT",
          botProfile: profile,
          isGuest: true,
          bankroll: 0,
          avatarHue: (i * 47) % 360,
          botStats: { create: { profile } },
        },
      });
    }),
  );

  const created = await tx.table.create({
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
        create: Array.from({ length: maxSeats }, (_, seatIndex) => {
          const bot = bots[seatIndex];
          if (bot) {
            return {
              seatIndex,
              status: "OCCUPIED" as const,
              playerKind: "BOT" as const,
              botProfile: bot.botProfile,
              userId: bot.id,
              stack: body.buyIn,
            };
          }
          if (seatIndex === body.botCount && req.userId) {
            return {
              seatIndex,
              status: "OCCUPIED" as const,
              playerKind: "HUMAN" as const,
              userId: req.userId,
              stack: body.buyIn,
            };
          }
          return { seatIndex, status: "EMPTY" as const };
        }),
      },
    },
    include: { seats: true },
  });

  return created;
  }, { maxWait: 10_000, timeout: 20_000 });

  await tableManager.hydrateFromDb(table.id);
  try {
    await tableManager.tryStart(table.id);
  } catch (err) {
    logger.warn({ err, tableId: table.id }, "tryStart after create failed");
  }

  res.status(201).json({ tableId: table.id });
});
