import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LobbySeatPatch, SessionEndReason, TableListItem } from "@poker/shared";
import { LobbyActor, type LobbyDelivery } from "../src/actors/lobby-actor";
import type { Env } from "../src/env";
import { TableStatus } from "../src/generated/prisma/enums";
import { readAttachment, writeAttachment, type LobbyAttachment } from "../src/lobby/attachment";
import { readCookie } from "../src/lobby/auth";
import { parseClientFrame } from "../src/lobby/frames";
import { idleNoticeFor } from "../src/lobby/idle";
import { isSeatedHuman, keepAliveFailure, relayKeepAlive } from "../src/lobby/keep-alive";
import { toLobbyPatch } from "../src/lobby/patch";
import { lobbyPorts } from "../src/lobby/ports";
import { allowFrame } from "../src/lobby/rate";
import { loadLobbyTables } from "../src/lobby/tables";
import type { PrismaClient } from "../src/generated/prisma/client";

/** Must match the test bindings in vitest.config.ts. Not production secrets. */
const WS_TICKET_SECRET = "test-only-ws-ticket-secret-32chars";
const JWT_ACCESS_SECRET = "test-only-access-secret-32chars-min";

const realKeepAlive = lobbyPorts.tableKeepAlive;
lobbyPorts.userSessions = () => ({
  register: async () => undefined,
  unregister: async () => undefined,
});

/** wrangler types augment Cloudflare.Env when vitest runs; tsc sees the empty interface. */
function edgeEnv(): Env {
  return env as unknown as Env;
}

function lobbyStub(): DurableObjectStub & {
  patch(entry: LobbySeatPatch): Promise<void>;
  deliver(input: LobbyDelivery): Promise<void>;
  disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void>;
} {
  return edgeEnv().LOBBY.getByName("lobby") as DurableObjectStub & {
    patch(entry: LobbySeatPatch): Promise<void>;
    deliver(input: LobbyDelivery): Promise<void>;
    disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void>;
  };
}

function attachment(userId: string, sessionId: string, connectedAt: number): LobbyAttachment {
  return { userId, sessionId, username: userId, connectedAt };
}

function seatPatch(seatedUserIds: string[], occupiedSeats: number, removed = false, status: TableListItem["status"] = "WAITING"): LobbySeatPatch {
  return {
    removed,
    seatedUserIds,
    table: {
      id: "table-1",
      name: "Noon",
      status,
      maxSeats: 6,
      occupiedSeats,
      smallBlind: 5,
      bigBlind: 10,
      minBuyIn: 200,
      maxBuyIn: 2000,
      botCount: 0,
    },
  };
}

interface Wire { v: number; id?: string; type: string; payload: Record<string, unknown> }
function wire(raw: string): Wire {
  return JSON.parse(raw) as Wire;
}

async function signTicket(
  input: { sub: string; sid: string; username: string },
  options?: { secret?: string; audience?: string; typ?: string; exp?: string | number },
): Promise<string> {
  return new SignJWT({ sid: input.sid, username: input.username, typ: options?.typ ?? "ws" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.sub)
    .setIssuer("poker-server")
    .setAudience(options?.audience ?? "poker-ws")
    .setExpirationTime(options?.exp ?? "60s")
    .sign(new TextEncoder().encode(options?.secret ?? WS_TICKET_SECRET));
}

async function signAccess(input: { sub: string; sid: string; username: string }): Promise<string> {
  return new SignJWT({ sid: input.sid, username: input.username, typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.sub)
    .setIssuer("poker-server")
    .setAudience("poker-client")
    .setJti(crypto.randomUUID())
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(JWT_ACCESS_SECRET));
}

function listen(ws: WebSocket): { frames: string[]; closed: Promise<number> } {
  const frames: string[] = [];
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code));
  });
  ws.addEventListener("message", (event) => {
    frames.push(typeof event.data === "string" ? event.data : "binary");
  });
  return { frames, closed };
}

async function until(frames: string[], count: number): Promise<void> {
  const start = Date.now();
  while (frames.length < count) {
    if (Date.now() - start > 5_000) throw new Error(`timed out after ${frames.length} frame(s)`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function openUpgrade(cookie: string | null): Promise<Response> {
  const headers = new Headers({ Upgrade: "websocket" });
  if (cookie !== null) headers.set("Cookie", cookie);
  return lobbyStub().fetch("http://internal/ws/lobby", { headers });
}

afterEach(async () => {
  lobbyPorts.tableKeepAlive = realKeepAlive;
  try {
    await runInDurableObject(lobbyStub(), async (_instance: LobbyActor, state) => {
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "bye"); } catch { /* already closed */ }
      }
    });
  } catch {
    /* The object may not exist yet. */
  }
});

describe("lobby patch and keep-alive", () => {
  it("fills isSeated per viewer and carries the patched seated count", () => {
    const entry = seatPatch(["user-a"], 4);
    const seated = toLobbyPatch(entry, "user-a");
    const watching = toLobbyPatch(entry, "user-b");
    expect(seated.table?.occupiedSeats).toBe(4);
    expect(seated.table?.isSeated).toBe(true);
    expect(watching.table?.isSeated).toBe(false);
    expect(watching.table?.occupiedSeats).toBe(4);
    expect(JSON.stringify(seated)).not.toContain("seatedUserIds");
    expect(seated.removed).toBeUndefined();
  });

  it("drops a removed public table for spectators and keeps it for the seated player", () => {
    const entry = seatPatch(["user-a"], 1, true, "WAITING");
    expect(toLobbyPatch(entry, "user-b").removed).toBe(true);
    expect(toLobbyPatch(entry, "user-a").removed).toBeUndefined();
    expect(toLobbyPatch(entry, "user-a").table?.isSeated).toBe(true);
    const closed = seatPatch(["user-a"], 0, true, "CLOSED");
    expect(toLobbyPatch(closed, "user-a").removed).toBe(true);
  });

  it("invokes keep-alive for a seated user and refuses a spectator", async () => {
    const calls: string[] = [];
    const caller = {
      async keepAlive(userId: string, commandId: string) {
        calls.push(`${userId}:${commandId}`);
        return { duplicate: true };
      },
    };
    const spectator = { async keepAlive() { throw new Error("spectator rpc"); } };
    expect(await relayKeepAlive(false, "user-b", "cmd-1", spectator)).toEqual({
      ok: false,
      code: "NOT_SEATED",
      message: "Only seated players can keep the table open",
    });
    expect(await relayKeepAlive(true, "user-a", "cmd-1", caller)).toEqual({ ok: true, duplicate: true });
    expect(calls).toEqual(["user-a:cmd-1"]);
    expect(isSeatedHuman({ tableId: "t", playerKind: "HUMAN", status: "OCCUPIED" }, "t")).toBe(true);
    expect(isSeatedHuman({ tableId: "t", playerKind: "HUMAN", status: "EMPTY" }, "t")).toBe(false);
    expect(isSeatedHuman({ tableId: "other", playerKind: "HUMAN", status: "OCCUPIED" }, "t")).toBe(false);
    expect(isSeatedHuman(null, "t")).toBe(false);
    const remote = new Error("boom");
    (remote as Error & { code: string }).code = "NOT_SEATED";
    expect(keepAliveFailure(remote).code).toBe("NOT_SEATED");
    expect(keepAliveFailure(new Error("missing method")).retryable).toBe(true);
  });

  it("parses lobby frames and rejects table frames", () => {
    expect(parseClientFrame(JSON.stringify({ v: 2, type: "LOBBY_HELLO", payload: {} })).kind).toBe("bad_version");
    expect(parseClientFrame(JSON.stringify({ v: 1, type: "TABLE_JOIN", payload: { tableId: "t" } })).kind).toBe("unknown");
    expect(parseClientFrame(JSON.stringify({ v: 1, type: "LOBBY_HELLO", payload: {} })).kind).toBe("hello");
    const missing = parseClientFrame(JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "TABLE_KEEP_ALIVE", payload: { tableId: "t" } }));
    expect(missing.kind).toBe("invalid");
    expect(readCookie("a=1; poker_ws=abc.def.ghi", "poker_ws")).toBe("abc.def.ghi");
    expect(readCookie(null, "poker_ws")).toBeNull();
  });

  it("recomputes an idle notice until the stored deadline", () => {
    const now = 1_000_000;
    const row = { table_id: "t", table_name: "Noon", closing_at: now + 5_000 };
    expect(idleNoticeFor(row, "t", now)).toEqual({ tableId: "t", tableName: "Noon", closingInMs: 5_000 });
    expect(idleNoticeFor(row, "t", now + 5_000)).toBeNull();
    expect(idleNoticeFor(row, "other", now)).toBeNull();
  });
});

describe("lobby durable object", () => {
  it("auto-responds to ping and budgets 20 frames per 2 seconds", async () => {
    const result = await runInDurableObject(lobbyStub(), async (_instance: LobbyActor, state) => {
      const auto = state.getWebSocketAutoResponse();
      const conn = "rate-user";
      const allowed: boolean[] = [];
      for (let i = 0; i < 20; i++) allowed.push(allowFrame(state.storage.sql, conn, 5_000));
      const blocked = allowFrame(state.storage.sql, conn, 5_000);
      const reset = allowFrame(state.storage.sql, conn, 7_000);
      return { request: auto?.request ?? null, response: auto?.response ?? null, allowed, blocked, reset };
    });
    expect(result.request).toBe("ping");
    expect(result.response).toBe("pong");
    expect(result.allowed.every(Boolean)).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.reset).toBe(true);
  });

  it("fans a patch out with a per-connection isSeated and the new seated count", async () => {
    const frames = await runInDurableObject(lobbyStub(), async (instance: LobbyActor, state) => {
      const open = (userId: string, connectedAt: number) => {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        if (!client || !server) throw new Error("WebSocketPair");
        const user = attachment(userId, `session-${userId}`, connectedAt);
        state.acceptWebSocket(server, [`user:${userId}`, `session:${user.sessionId}`]);
        writeAttachment(server, user);
        const messages: string[] = [];
        client.addEventListener("message", (event) => {
          messages.push(typeof event.data === "string" ? event.data : "binary");
        });
        client.accept();
        return { server, messages };
      };
      const seated = open("user-a", 10);
      const watching = open("user-b", 11);
      await instance.patch(seatPatch(["user-a"], 4));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { seated: [...seated.messages], watching: [...watching.messages] };
    });
    expect(frames.seated).toHaveLength(1);
    expect(frames.watching).toHaveLength(1);
    const seated = wire(frames.seated[0] ?? "{}");
    const watching = wire(frames.watching[0] ?? "{}");
    expect(seated.type).toBe("LOBBY_PATCH");
    expect(seated.payload.table).toMatchObject({ id: "table-1", occupiedSeats: 4, isSeated: true });
    expect(watching.payload.table).toMatchObject({ occupiedSeats: 4, isSeated: false });
    expect(JSON.stringify(seated.payload)).not.toContain("seatedUserIds");
  });

  it("delivers wallet and idle frames only to that user's sockets", async () => {
    const frames = await runInDurableObject(lobbyStub(), async (instance: LobbyActor, state) => {
      const open = (userId: string) => {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        if (!client || !server) throw new Error("WebSocketPair");
        state.acceptWebSocket(server, [`user:${userId}`, `session:${userId}`]);
        writeAttachment(server, attachment(userId, userId, userId === "user-a" ? 21 : 22));
        const messages: string[] = [];
        client.addEventListener("message", (event) => {
          messages.push(typeof event.data === "string" ? event.data : "binary");
        });
        client.accept();
        return messages;
      };
      const a = open("user-a");
      const b = open("user-b");
      await instance.deliver({ userId: "user-a", event: "USER_PATCH", payload: { bankroll: 9000 } });
      await instance.deliver({
        userId: "user-a",
        event: "TABLE_IDLE_NOTICE",
        payload: { tableId: "table-1", tableName: "Noon", closingInMs: 30_000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { a: [...a], b: [...b] };
    });
    expect(frames.b).toEqual([]);
    expect(frames.a.map((raw) => wire(raw).type)).toEqual(["USER_PATCH", "TABLE_IDLE_NOTICE"]);
    expect(wire(frames.a[0] ?? "{}").payload.bankroll).toBe(9000);
  });

  it("disconnectSession sends SESSION_REVOKED and closes 4001", async () => {
    const result = await runInDurableObject(lobbyStub(), async (instance: LobbyActor, state) => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (!client || !server) throw new Error("WebSocketPair");
      state.acceptWebSocket(server, ["user:user-a", "session:sess-a"]);
      writeAttachment(server, attachment("user-a", "sess-a", 30));
      const messages: string[] = [];
      let closeCode: number | null = null;
      client.addEventListener("message", (event) => {
        messages.push(typeof event.data === "string" ? event.data : "binary");
      });
      client.addEventListener("close", (event) => { closeCode = event.code; });
      client.accept();
      await instance.disconnectSession("sess-a", "LOGOUT");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const still = readAttachment(server);
      return { messages: [...messages], closeCode, attachmentUser: still?.userId ?? null };
    });
    expect(result.closeCode).toBe(4001);
    expect(wire(result.messages[0] ?? "{}")).toMatchObject({ type: "SESSION_REVOKED", payload: { reason: "LOGOUT" } });
  });

  it("rejects binary, oversized, and non-lobby frames", async () => {
    const result = await runInDurableObject(lobbyStub(), async (instance: LobbyActor, state) => {
      const open = (connectedAt: number) => {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        if (!client || !server) throw new Error("WebSocketPair");
        state.acceptWebSocket(server, ["user:user-a", `session:s-${connectedAt}`]);
        writeAttachment(server, attachment("user-a", `s-${connectedAt}`, connectedAt));
        const messages: string[] = [];
        let closeCode: number | null = null;
        client.addEventListener("message", (event) => {
          messages.push(typeof event.data === "string" ? event.data : "binary");
        });
        client.addEventListener("close", (event) => { closeCode = event.code; });
        client.accept();
        return { server, messages, closeCode: () => closeCode };
      };
      const boundary = open(40);
      await instance.webSocketMessage(boundary.server, "ping");
      await instance.webSocketMessage(boundary.server, "x".repeat(8192));
      await instance.webSocketMessage(boundary.server, JSON.stringify({ v: 1, type: "TABLE_JOIN", payload: { tableId: "t1" } }));
      await instance.webSocketMessage(boundary.server, JSON.stringify({ v: 1, type: "LOBBY_HELLO", payload: { extra: true } }));
      const flood = open(43);
      for (let i = 0; i < 20; i++) {
        await instance.webSocketMessage(flood.server, JSON.stringify({ v: 1, type: "TABLE_JOIN", payload: {} }));
      }
      await instance.webSocketMessage(flood.server, JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "TABLE_JOIN", payload: {} }));
      const binary = open(41);
      await instance.webSocketMessage(binary.server, new Uint8Array([1, 2, 3]).buffer);
      const huge = open(42);
      await instance.webSocketMessage(huge.server, "y".repeat(8193));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        boundary: boundary.messages.map((raw) => wire(raw).payload.code),
        boundaryOpen: boundary.closeCode(),
        flood: flood.messages.slice(-2).map((raw) => wire(raw).type),
        limited: wire(flood.messages.at(-1) ?? "{}").payload.code,
        binaryCode: binary.closeCode(),
        hugeCode: huge.closeCode(),
      };
    });
    expect(result.boundary).toEqual(["INVALID_REQUEST", "UNKNOWN_TYPE", "INVALID_REQUEST"]);
    expect(result.boundaryOpen).toBeNull();
    expect(result.flood).toEqual(["SERVER_ERROR", "ACK"]);
    expect(result.limited).toBe("RATE_LIMITED");
    expect(result.binaryCode).toBe(1003);
    expect(result.hugeCode).toBe(1009);
  });
});

describe("lobby upgrade", () => {
  it("rejects a missing or bad poker_ws ticket before accepting", async () => {
    const missing = await openUpgrade(null);
    expect(missing.status).toBe(401);
    expect(missing.webSocket).toBeFalsy();
    const worker = await (exports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default.fetch("http://example.com/ws/lobby", { headers: { Upgrade: "websocket" } });
    expect(worker.status).toBe(401);

    const wrongKey = await signTicket({ sub: "u", sid: "s", username: "ada" }, { secret: "wrong-ws-ticket-secret-32-characters" });
    const bad = await openUpgrade(`poker_ws=${wrongKey}`);
    expect(bad.status).toBe(401);
    expect(bad.webSocket).toBeFalsy();

    const expired = await signTicket({ sub: "u", sid: "s", username: "ada" }, { exp: Math.floor(Date.now() / 1000) - 10 });
    expect((await openUpgrade(`poker_ws=${expired}`)).status).toBe(401);

    const accessAud = await signTicket({ sub: "u", sid: "s", username: "ada" }, { audience: "poker-client", typ: "access" });
    expect((await openUpgrade(`poker_ws=${accessAud}`)).status).toBe(401);

    const notWs = await lobbyStub().fetch("http://internal/ws/lobby");
    expect(notWs.status).toBe(426);
  });
});

describe("lobby snapshot against Postgres", () => {
  let db: PrismaClient | null = null;
  let prefix = "";
  let userA = "";
  let userB = "";
  let userC = "";
  let sessionA = "";
  let sessionA2 = "";
  let sessionB = "";
  let sessionC = "";
  let tableA = "";
  let privateB = "";
  let publicDesc: string[] = [];

  beforeAll(async () => {
    const connectionString = edgeEnv().HYPERDRIVE.connectionString;
    let host = "";
    try {
      host = new URL(connectionString).hostname;
    } catch {
      host = "";
    }
    const local = host === "127.0.0.1" || host === "localhost" || host.endsWith(".hyperdrive.local");
    if (!local) return;
    try {
      const { createPrisma } = await import("../src/db/client");
      const client = createPrisma(connectionString);
      // Untyped SELECT 1 comes back as a Postgres `name` on the workerd driver
      // and Prisma cannot deserialize it. A text cast proves the socket works.
      await client.$queryRaw`SELECT current_user::text AS role`;
      db = client;
    } catch {
      return;
    }
    prefix = `wp4${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    userA = `${prefix}_ua`;
    userB = `${prefix}_ub`;
    userC = `${prefix}_uc`;
    sessionA = `${prefix}_sa`;
    sessionA2 = `${prefix}_sa2`;
    sessionB = `${prefix}_sb`;
    sessionC = `${prefix}_sc`;
    tableA = `${prefix}_a`;
    privateB = `${prefix}_b`;
    const closed = `${prefix}_closed`;
    const bot = `${prefix}_bot`;
    const oldPublic = `${prefix}_old`;
    const origin = Date.now() + 86_400_000;
    try {
      // Earlier runs cannot DELETE Table rows. A public leftover crowds the
      // newest-50 lobby window this fixture asserts. The rows below are dated
      // ahead of any real local table so a shared Docker database does not
      // push the fixture out of that window. afterAll closes them.
      await db.table.updateMany({
        where: { id: { startsWith: "wp4" }, NOT: { status: TableStatus.CLOSED } },
        data: { status: TableStatus.CLOSED, isPrivate: true },
      });
      await db.user.createMany({
        data: [
          { id: userA, username: `${prefix}_a`, bankroll: 10000 },
          { id: userB, username: `${prefix}_b`, bankroll: 10000 },
          { id: userC, username: `${prefix}_c`, bankroll: 10000 },
        ],
      });
      const sessionData = (id: string, userId: string, revoked: boolean) => ({
        id,
        userId,
        refreshToken: `${id}${crypto.randomUUID().replace(/-/g, "")}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        lastUsedAt: new Date(),
        ...(revoked ? { revokedAt: new Date(), revokeReason: "LOGOUT" } : {}),
      });
      await db.session.createMany({
        data: [sessionData(sessionA, userA, false), sessionData(sessionA2, userA, false), sessionData(sessionB, userB, false), sessionData(sessionC, userC, true)],
      });
      const tableData = (id: string, name: string, createdAt: number, extra?: { status?: typeof TableStatus.CLOSED; isPrivate?: boolean }) => ({
        id,
        name,
        maxSeats: 6,
        smallBlind: 5,
        bigBlind: 10,
        minBuyIn: 200,
        maxBuyIn: 2000,
        timeBankMs: 15_000,
        createdAt: new Date(createdAt),
        status: extra?.status ?? TableStatus.WAITING,
        isPrivate: extra?.isPrivate ?? false,
      });
      const empties = Array.from({ length: 49 }, (_, index) => `${prefix}_e${index}`);
      await db.table.createMany({
        data: [
          tableData(privateB, "Private", origin, { isPrivate: true }),
          tableData(closed, "Closed", origin + 1_000, { status: TableStatus.CLOSED }),
          tableData(bot, "Bot", origin + 2_000),
          tableData(oldPublic, "Old", origin + 3_000),
          ...empties.map((id, index) => tableData(id, `Empty ${index}`, origin + 10_000 + index * 1_000)),
          tableData(tableA, "Ace", origin + 100_000),
        ],
      });
      await db.tableSeat.createMany({
        data: [
          { id: `${prefix}_seat_a`, tableId: tableA, seatIndex: 0, userId: userA, playerKind: "HUMAN", status: "OCCUPIED", stack: 1000 },
          { id: `${prefix}_seat_b`, tableId: privateB, seatIndex: 0, userId: userB, playerKind: "HUMAN", status: "OCCUPIED", stack: 1000 },
          { id: `${prefix}_seat_bot`, tableId: bot, seatIndex: 0, userId: null, playerKind: "BOT", status: "OCCUPIED", stack: 1000 },
        ],
      });
      publicDesc = [tableA, ...empties.slice().reverse()];
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "unknown";
      throw new Error(`lobby fixture failed: ${code}`);
    }
  });

  afterAll(async () => {
    if (!db || !prefix) return;
    try {
      // poker_app inherits poker_server, which may SELECT/INSERT/UPDATE Table
      // and User but not DELETE them. Close the fixture so it leaves the lobby.
      await db.tableSeat.deleteMany({ where: { tableId: { startsWith: prefix } } });
      await db.table.updateMany({
        where: { id: { startsWith: prefix } },
        data: { status: TableStatus.CLOSED, isPrivate: true },
      });
      await db.session.updateMany({
        where: { userId: { startsWith: prefix } },
        data: { revokedAt: new Date(), revokeReason: "LOGOUT" },
      });
    } finally {
      await db.$disconnect().catch(() => undefined);
    }
  });

  function skipWithoutDb(ctx: { skip: () => void }): boolean {
    if (db) return false;
    ctx.skip();
    return true;
  }

  it("matches the GET /api/tables filter for the same fixture", async (ctx) => {
    if (skipWithoutDb(ctx) || !db) return;
    const forA = await loadLobbyTables(db, userA);
    const forB = await loadLobbyTables(db, userB);
    expect(forA.map((table) => table.id)).toEqual(publicDesc);
    expect(forA[0]).toEqual({
      id: tableA,
      isSeated: true,
      name: "Ace",
      status: "WAITING",
      maxSeats: 6,
      occupiedSeats: 1,
      smallBlind: 5,
      bigBlind: 10,
      minBuyIn: 200,
      maxBuyIn: 2000,
      botCount: 0,
    });
    expect(forA.slice(1).every((table) => table.isSeated === false && table.occupiedSeats === 0 && table.botCount === 0)).toBe(true);
    expect(forB.map((table) => table.id)).toEqual([privateB, ...publicDesc]);
    expect(forB[0]).toMatchObject({ id: privateB, isSeated: true, name: "Private", occupiedSeats: 1 });
    expect(forB.find((table) => table.id === tableA)?.isSeated).toBe(false);
    expect(forA.some((table) => table.id === privateB)).toBe(false);
    expect(forB.some((table) => table.id === `${prefix}_closed` || table.id === `${prefix}_bot` || table.id === `${prefix}_old`)).toBe(false);
  });

  it("sends AUTH_OK then the same snapshot on LOBBY_HELLO", async (ctx) => {
    if (skipWithoutDb(ctx) || !db) return;
    const ticket = await signTicket({ sub: userA, sid: sessionA, username: `${prefix}_a` });
    const response = await openUpgrade(`other=1; poker_ws=${ticket}`);
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (!ws) throw new Error("missing websocket");
    const heard = listen(ws);
    ws.accept();
    await until(heard.frames, 1);
    const auth = wire(heard.frames[0] ?? "{}");
    expect(auth.type).toBe("AUTH_OK");
    expect(auth.payload).toMatchObject({ userId: userA, username: `${prefix}_a`, activeTableId: tableA, idleNotice: null });
    ws.send(JSON.stringify({ v: 1, type: "LOBBY_HELLO", payload: {} }));
    await until(heard.frames, 2);
    const snapshot = wire(heard.frames[1] ?? "{}");
    expect(snapshot.type).toBe("LOBBY_SNAPSHOT");
    const expected = await loadLobbyTables(db, userA);
    expect(snapshot.payload.tables).toEqual(expected);
    ws.close(1000, "bye");
  });

  it("refuses a spectator keep-alive and invokes the table RPC for a seated user", async (ctx) => {
    if (skipWithoutDb(ctx)) return;
    const calls: { userId: string; commandId: string }[] = [];
    lobbyPorts.tableKeepAlive = () => ({
      async keepAlive(userId: string, commandId: string) {
        calls.push({ userId, commandId });
      },
    });
    const spectator = await connectUser(userB, sessionB, `${prefix}_b`);
    const commandId = crypto.randomUUID();
    const frameId = crypto.randomUUID();
    spectator.ws.send(JSON.stringify({ v: 1, id: frameId, type: "TABLE_KEEP_ALIVE", payload: { tableId: tableA, commandId } }));
    await until(spectator.heard.frames, 3);
    const error = wire(spectator.heard.frames[1] ?? "{}");
    const ack = wire(spectator.heard.frames[2] ?? "{}");
    expect(error).toMatchObject({ type: "SERVER_ERROR", id: frameId, payload: { code: "NOT_SEATED", tableId: tableA } });
    expect(ack).toMatchObject({ type: "ACK", id: frameId, payload: { ok: false, code: "NOT_SEATED" } });
    expect(calls).toEqual([]);
    spectator.ws.close(1000, "bye");

    const seated = await connectUser(userA, sessionA, `${prefix}_a`);
    const seatedCommand = crypto.randomUUID();
    const seatedFrame = crypto.randomUUID();
    seated.ws.send(JSON.stringify({ v: 1, id: seatedFrame, type: "TABLE_KEEP_ALIVE", payload: { tableId: tableA, commandId: seatedCommand } }));
    await until(seated.heard.frames, 2);
    expect(wire(seated.heard.frames[1] ?? "{}")).toMatchObject({ type: "ACK", id: seatedFrame, payload: { ok: true } });
    expect(calls).toEqual([{ userId: userA, commandId: seatedCommand }]);
    seated.ws.close(1000, "bye");
  });

  it("includes a delivered idle notice on the next AUTH_OK and clears it", async (ctx) => {
    if (skipWithoutDb(ctx)) return;
    await lobbyStub().deliver({
      userId: userA,
      event: "TABLE_IDLE_NOTICE",
      payload: { tableId: tableA, tableName: "Ace", closingInMs: 20_000 },
    });
    const first = await connectUser(userA, sessionA, `${prefix}_a`);
    const auth = wire(first.heard.frames[0] ?? "{}");
    const notice = auth.payload.idleNotice as { tableId?: string; closingInMs?: number } | null;
    expect(notice?.tableId).toBe(tableA);
    expect(notice?.closingInMs).toBeGreaterThan(15_000);
    expect(notice?.closingInMs).toBeLessThanOrEqual(20_000);
    await lobbyStub().deliver({
      userId: userA,
      event: "TABLE_IDLE_NOTICE",
      payload: { tableId: tableA, tableName: "Ace", closingInMs: null },
    });
    await until(first.heard.frames, 2);
    expect(wire(first.heard.frames[1] ?? "{}").type).toBe("TABLE_IDLE_NOTICE");
    first.ws.close(1000, "bye");
    const second = await connectUser(userA, sessionA, `${prefix}_a`);
    expect(wire(second.heard.frames[0] ?? "{}").payload.idleNotice).toBeNull();
    second.ws.close(1000, "bye");
  });

  it("closes a revoked ticket with 4001 and renews only the same user", async (ctx) => {
    if (skipWithoutDb(ctx)) return;
    const revoked = await signTicket({ sub: userC, sid: sessionC, username: `${prefix}_c` });
    const denied = await openUpgrade(`poker_ws=${revoked}`);
    expect(denied.status).toBe(101);
    const deniedWs = denied.webSocket;
    if (!deniedWs) throw new Error("missing websocket");
    const deniedHeard = listen(deniedWs);
    deniedWs.accept();
    const code = await Promise.race([
      deniedHeard.closed,
      until(deniedHeard.frames, 1).then(() => 0),
    ]);
    expect(wire(deniedHeard.frames[0] ?? "{}")).toMatchObject({ type: "SESSION_REVOKED", payload: { reason: "LOGOUT" } });
    expect(code === 4001 || (await deniedHeard.closed) === 4001).toBe(true);

    const live = await connectUser(userA, sessionA, `${prefix}_a`);
    const other = await signAccess({ sub: userB, sid: sessionB, username: `${prefix}_b` });
    const mismatchId = crypto.randomUUID();
    live.ws.send(JSON.stringify({ v: 1, id: mismatchId, type: "SESSION_RENEW", payload: { token: other } }));
    const mismatchClose = await live.heard.closed;
    expect(mismatchClose).toBe(4002);

    const renewed = await connectUser(userA, sessionA, `${prefix}_a`);
    const next = await signAccess({ sub: userA, sid: sessionA2, username: `${prefix}_a` });
    const renewId = crypto.randomUUID();
    renewed.ws.send(JSON.stringify({ v: 1, id: renewId, type: "SESSION_RENEW", payload: { token: next } }));
    await until(renewed.heard.frames, 2);
    expect(wire(renewed.heard.frames[1] ?? "{}")).toMatchObject({ type: "ACK", id: renewId, payload: { ok: true } });
    await lobbyStub().disconnectSession(sessionA, "LOGOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renewed.ws.readyState).toBe(WebSocket.OPEN);
    await lobbyStub().disconnectSession(sessionA2, "LOGOUT");
    expect(await renewed.heard.closed).toBe(4001);
  });
});

async function connectUser(userId: string, sessionId: string, username: string): Promise<{ ws: WebSocket; heard: { frames: string[]; closed: Promise<number> } }> {
  const ticket = await signTicket({ sub: userId, sid: sessionId, username });
  const response = await openUpgrade(`poker_ws=${ticket}`);
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("missing websocket");
  const heard = listen(ws);
  ws.accept();
  await until(heard.frames, 1);
  expect(wire(heard.frames[0] ?? "{}").type).toBe("AUTH_OK");
  return { ws, heard };
}
