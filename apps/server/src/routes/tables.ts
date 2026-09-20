import { randomBytes } from "node:crypto";
import { Router } from "express";
import {
  ABSOLUTE_MAX_SEATS,
  BOT_USERNAMES,
  DEFAULT_MAX_SEATS,
  type BotProfile,
  type CreateTableRequest,
  type TableListItem,
} from "@poker/shared";
import { z } from "zod";
import { env } from "../config.js";
import { prisma } from "../db/prisma.js";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import { tableManager } from "../game/manager.js";
import { logger } from "../logger.js";
import { setActiveTableForUser } from "../redis/table-state.js";

export const tablesRouter = Router();

const createTableSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  maxSeats: z.number().int().min(2).max(ABSOLUTE_MAX_SEATS).optional(),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  buyIn: z.number().int().positive(),
  botCount: z.number().int().min(0).max(ABSOLUTE_MAX_SEATS - 1),
  botProfiles: z.array(z.enum(["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"])).optional(),
});

function cycleProfiles(count: number, requested?: BotProfile[]): BotProfile[] {
  const order: BotProfile[] = requested?.length
    ? requested
    : ["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"];
  return Array.from({ length: count }, (_, i) => order[i % order.length]!);
}

tablesRouter.get("/", requireAuth, async (_req, res) => {
  const tables = await prisma.table.findMany({
    where: { status: { not: "CLOSED" } },
    include: { seats: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const payload: TableListItem[] = tables.map((table) => ({
    id: table.id,
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
  if (!table) {
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

  const profiles = cycleProfiles(body.botCount, body.botProfiles);
  const bots = await Promise.all(
    profiles.map(async (profile, i) => {
      const pool = BOT_USERNAMES[profile];
      const username = `${pool[i % pool.length]}_${randomBytes(3).toString("hex")}`;
      return prisma.user.create({
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

  const table = await prisma.table.create({
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

  await prisma.user.update({
    where: { id: host.id },
    data: { bankroll: { decrement: body.buyIn } },
  });
  await setActiveTableForUser(host.id, table.id);
  await tableManager.hydrateFromDb(table.id);
  try {
    await tableManager.tryStart(table.id);
  } catch (err) {
    logger.warn({ err, tableId: table.id }, "tryStart after create failed");
  }

  res.status(201).json({ tableId: table.id });
});
