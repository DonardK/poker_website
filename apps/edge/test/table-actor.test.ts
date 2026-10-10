import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicTableState } from "@poker/shared";
import { workerEnv, workerFetch } from "./worker-bindings";

interface Frame {
  v: number;
  id?: string;
  type: string;
  payload: Record<string, unknown>;
}

interface Prepared {
  tableId: string;
  players: { userId: string; sessionId: string; username: string; ticket: string }[];
}

const openSockets: WebSocket[] = [];
const liveTables = new Set<string>();

function tableStub(tableId: string) {
  liveTables.add(tableId);
  return workerEnv().TABLES.getByName(tableId, { locationHint: "weur" });
}

/** The workers pool fails the run if a socket close or a scheduled alarm is still in flight when the file worker shuts down. */
function closeAndWait(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      ws.close(1000, "test");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

afterEach(async () => {
  const sockets = openSockets.splice(0);
  await Promise.all(sockets.map((ws) => closeAndWait(ws)));
  const ids = [...liveTables];
  liveTables.clear();
  for (const tableId of ids) {
    const stub = workerEnv().TABLES.getByName(tableId, { locationHint: "weur" });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    }).catch(() => undefined);
  }
});

async function prepare(label: string, count: number, hostIndex = 0): Promise<Prepared> {
  const tableId = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const players = Array.from({ length: count }, (_, index) => ({
    username: `${label}${index}${suffix}`,
    bankroll: 10_000,
  }));
  const stub = tableStub(tableId) as unknown as {
    testPrepare(input: unknown): Promise<Prepared>;
  };
  const prepared = await stub.testPrepare({
    tableId,
    tableName: label,
    smallBlind: 5,
    bigBlind: 10,
    maxSeats: 6,
    minBuyIn: 200,
    maxBuyIn: 2_000,
    timeBankMs: 20_000,
    hostIndex,
    players,
  });
  return { tableId, players: prepared.players };
}

async function facts(tableId: string, userIds: string[]) {
  const stub = tableStub(tableId) as unknown as {
    testFacts(ids: string[]): Promise<{
      commands: { id: string; kind: string; appliedRevision: number }[];
      bankrolls: Record<string, number>;
      handCount: number;
      status: string | null;
      revision: string | null;
      enginePrefix: string | null;
    }>;
  };
  return stub.testFacts(userIds);
}

function connect(tableId: string, ticket: string) {
  return (async () => {
    const response = await workerFetch(`http://example.com/ws/table/${tableId}`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade", Cookie: `poker_ws=${encodeURIComponent(ticket)}` },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (!ws) throw new Error("upgrade did not return a socket");
    const frames: Frame[] = [];
    let closeCode: number | null = null;
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string" || event.data === "pong" || event.data === "ping") return;
      frames.push(JSON.parse(event.data) as Frame);
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      closeCode = event.code;
    });
    ws.accept();
    openSockets.push(ws);
    return {
      ws,
      frames,
      closeCode: () => closeCode,
    };
  })();
}

function connectLobby(ticket: string) {
  return (async () => {
    const response = await workerFetch("http://example.com/ws/lobby", {
      headers: { Upgrade: "websocket", Connection: "Upgrade", Cookie: `poker_ws=${encodeURIComponent(ticket)}` },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (!ws) throw new Error("lobby upgrade did not return a socket");
    const frames: Frame[] = [];
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string" || event.data === "pong" || event.data === "ping") return;
      frames.push(JSON.parse(event.data) as Frame);
    });
    ws.accept();
    openSockets.push(ws);
    return { ws, frames };
  })();
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function snapshots(frames: Frame[]): PublicTableState[] {
  return frames.filter((frame) => frame.type === "STATE_SNAPSHOT").map((frame) => frame.payload as unknown as PublicTableState);
}

function latest(frames: Frame[]): PublicTableState | undefined {
  const all = snapshots(frames);
  return all[all.length - 1];
}

function send(ws: WebSocket, type: string, payload: Record<string, unknown>, id = crypto.randomUUID()): string {
  ws.send(JSON.stringify({ v: 1, id, type, payload }));
  return id;
}

async function ack(frames: Frame[], id: string): Promise<Frame> {
  await waitFor(() => frames.some((frame) => frame.type === "ACK" && frame.id === id), `ack ${id}`);
  const frame = frames.find((item) => item.type === "ACK" && item.id === id);
  if (!frame) throw new Error("missing ack");
  return frame;
}

async function sit(ws: WebSocket, frames: Frame[], tableId: string, seatIndex: number, commandId = crypto.randomUUID()): Promise<string> {
  const id = send(ws, "SEAT_CLAIM", { tableId, seatIndex, buyIn: 200, commandId });
  const frame = await ack(frames, id);
  expect(frame.payload.ok, JSON.stringify(frame.payload)).toBe(true);
  return commandId;
}

describe("TableActor", () => {
  it("deals a hand to showdown with per-viewer hole cards and a 3200ms showdown alarm", async () => {
    const table = await prepare("show", 3, 2);
    const [hero, villain, watcher] = table.players;
    if (!hero || !villain || !watcher) throw new Error("fixture");
    const a = await connect(table.tableId, hero.ticket);
    const b = await connect(table.tableId, villain.ticket);
    const c = await connect(table.tableId, watcher.ticket);
    await sit(a.ws, a.frames, table.tableId, 0);
    await sit(b.ws, b.frames, table.tableId, 1);
    send(a.ws, "TABLE_JOIN", { tableId: table.tableId });
    send(b.ws, "TABLE_JOIN", { tableId: table.tableId });
    send(c.ws, "TABLE_JOIN", { tableId: table.tableId });
    await waitFor(() => snapshots(a.frames).some((state) => state.phase === "PREFLOP"), "preflop");
    await waitFor(() => snapshots(c.frames).some((state) => state.phase === "PREFLOP"), "spectator preflop");

    const heroView = snapshots(a.frames).find((state) => state.phase === "PREFLOP");
    const villainView = snapshots(b.frames).find((state) => state.phase === "PREFLOP");
    const watchView = snapshots(c.frames).find((state) => state.phase === "PREFLOP");
    if (!heroView || !villainView || !watchView) throw new Error("missing preflop");
    const heroCards = heroView.players.find((player) => player.userId === hero.userId)?.holeCards;
    const villainCards = villainView.players.find((player) => player.userId === villain.userId)?.holeCards;
    expect(heroCards).toHaveLength(2);
    expect(villainCards).toHaveLength(2);
    expect(heroCards).not.toEqual(villainCards);
    expect(heroView.players.find((player) => player.userId === villain.userId)?.holeCards).toBeNull();
    expect(villainView.players.find((player) => player.userId === hero.userId)?.holeCards).toBeNull();
    const heroJson = JSON.stringify(heroView);
    const villainJson = JSON.stringify(villainView);
    expect(heroJson).not.toContain(JSON.stringify(villainCards));
    expect(villainJson).not.toContain(JSON.stringify(heroCards));
    expect(watchView.players.every((player) => player.holeCards == null)).toBe(true);

    for (let step = 0; step < 24; step++) {
      const mine = latest(a.frames);
      const theirs = latest(b.frames);
      if (mine?.phase === "SHOWDOWN" || theirs?.phase === "SHOWDOWN") break;
      const actor = [a, b].find((socket, index) => {
        const state = latest(socket.frames);
        return state?.toActSeat === index && state.actorLegal;
      });
      if (!actor) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
      const state = latest(actor.frames);
      if (!state?.actorLegal || state.turnId == null) break;
      const action = state.actorLegal.actions.includes("CHECK") ? "CHECK" : "CALL";
      const id = send(actor.ws, "ACTION_INTENT", {
        tableId: table.tableId,
        revision: state.revision,
        action,
        clientActionId: crypto.randomUUID(),
        turnId: state.turnId,
      });
      const frame = await ack(actor.frames, id);
      expect(frame.payload.ok).toBe(true);
    }
    await waitFor(() => latest(a.frames)?.phase === "SHOWDOWN" || latest(b.frames)?.phase === "SHOWDOWN", "showdown");

    const alarmAt = await runInDurableObject(tableStub(table.tableId), (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    const remaining = (alarmAt ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(2_000);
    expect(remaining).toBeLessThan(4_500);
    expect(await runDurableObjectAlarm(tableStub(table.tableId))).toBe(true);
    const after = await facts(table.tableId, [hero.userId, villain.userId]);
    const showdown = after.commands.find((command) => command.kind === "showdown");
    const deal = after.commands.filter((command) => command.kind === "deal").at(-1);
    expect(showdown).toBeTruthy();
    expect(deal).toBeTruthy();
    expect(showdown!.appliedRevision).toBeLessThan(deal!.appliedRevision);
    expect(after.handCount).toBeGreaterThan(0);
    a.ws.close();
    b.ws.close();
    c.ws.close();
  }, 30_000);

  it("folds on the turn-timeout alarm once", async () => {
    const table = await prepare("time", 2);
    const [hero, villain] = table.players;
    if (!hero || !villain) throw new Error("fixture");
    const a = await connect(table.tableId, hero.ticket);
    const b = await connect(table.tableId, villain.ticket);
    await sit(a.ws, a.frames, table.tableId, 0);
    await sit(b.ws, b.frames, table.tableId, 1);
    send(a.ws, "TABLE_JOIN", { tableId: table.tableId });
    send(b.ws, "TABLE_JOIN", { tableId: table.tableId });
    await waitFor(() => (latest(a.frames)?.phase === "PREFLOP"), "preflop");
    const alarmAt = await runInDurableObject(tableStub(table.tableId), (_instance, state) => state.storage.getAlarm());
    expect((alarmAt ?? 0) > Date.now()).toBe(true);
    expect(await runDurableObjectAlarm(tableStub(table.tableId))).toBe(true);
    const once = await facts(table.tableId, [hero.userId]);
    const timers = once.commands.filter((command) => command.id.startsWith("timer:"));
    expect(timers).toHaveLength(1);
    await runDurableObjectAlarm(tableStub(table.tableId));
    const twice = await facts(table.tableId, [hero.userId]);
    expect(twice.commands.filter((command) => command.id.startsWith("timer:"))).toHaveLength(1);
    a.ws.close();
    b.ws.close();
  });

  it("returns the original ack when clientActionId is replayed", async () => {
    const table = await prepare("replay", 2);
    const [hero, villain] = table.players;
    if (!hero || !villain) throw new Error("fixture");
    const a = await connect(table.tableId, hero.ticket);
    const b = await connect(table.tableId, villain.ticket);
    await sit(a.ws, a.frames, table.tableId, 0);
    await sit(b.ws, b.frames, table.tableId, 1);
    send(a.ws, "TABLE_JOIN", { tableId: table.tableId });
    send(b.ws, "TABLE_JOIN", { tableId: table.tableId });
    await waitFor(() => latest(a.frames)?.phase === "PREFLOP" || latest(b.frames)?.phase === "PREFLOP", "preflop");
    await waitFor(() => {
      const state = latest(a.frames);
      return state?.toActSeat === 0 && state.actorLegal != null && state.turnId != null;
    }, "hero turn");
    const state = latest(a.frames);
    if (!state?.actorLegal || state.turnId == null) throw new Error("no legal action");
    const action = state.actorLegal.actions.includes("CHECK") ? "CHECK" : "CALL";
    const clientActionId = crypto.randomUUID();
    const first = send(a.ws, "ACTION_INTENT", {
      tableId: table.tableId, revision: state.revision, action, clientActionId, turnId: state.turnId,
    });
    expect((await ack(a.frames, first)).payload.ok).toBe(true);
    const pot = latest(a.frames)?.potTotal;
    const revision = latest(a.frames)?.revision;
    const second = send(a.ws, "ACTION_INTENT", {
      tableId: table.tableId, revision: state.revision, action, clientActionId, turnId: state.turnId,
    });
    const replay = await ack(a.frames, second);
    expect(replay.payload.ok).toBe(true);
    expect(replay.payload.duplicate).toBe(true);
    expect(latest(a.frames)?.potTotal).toBe(pot);
    expect(latest(a.frames)?.revision).toBe(revision);
    a.ws.close();
    b.ws.close();
  });

  it("recovers a cash-out that committed in Postgres before the DO meta write", async () => {
    const table = await prepare("crash", 1);
    const hero = table.players[0];
    if (!hero) throw new Error("fixture");
    const socket = await connect(table.tableId, hero.ticket);
    await sit(socket.ws, socket.frames, table.tableId, 0);
    const seated = await facts(table.tableId, [hero.userId]);
    expect(seated.bankrolls[hero.userId]).toBe(9_800);
    const stub = tableStub(table.tableId) as unknown as { armTestFault(fault: string): Promise<void> };
    await stub.armTestFault("throw-after-postgres");
    const commandId = crypto.randomUUID();
    const first = send(socket.ws, "STAND_UP", { tableId: table.tableId, commandId });
    const failed = await ack(socket.frames, first);
    expect(failed.payload.ok).toBe(false);
    expect(failed.payload.retryable).toBe(true);
    const crashed = await facts(table.tableId, [hero.userId]);
    expect(crashed.bankrolls[hero.userId]).toBe(10_000);
    expect(crashed.commands.filter((command) => command.kind === "stand")).toHaveLength(1);
    const second = send(socket.ws, "STAND_UP", { tableId: table.tableId, commandId });
    const again = await ack(socket.frames, second);
    expect(again.payload.ok).toBe(true);
    expect(again.payload.duplicate).toBe(true);
    const recovered = await facts(table.tableId, [hero.userId]);
    expect(recovered.bankrolls[hero.userId]).toBe(10_000);
    expect(recovered.commands.filter((command) => command.kind === "stand")).toHaveLength(1);
    socket.ws.close();
  });

  it("serializes two action frames so only one call debits", async () => {
    const table = await prepare("race", 2);
    const [hero, villain] = table.players;
    if (!hero || !villain) throw new Error("fixture");
    const a = await connect(table.tableId, hero.ticket);
    const b = await connect(table.tableId, villain.ticket);
    await sit(a.ws, a.frames, table.tableId, 0);
    await sit(b.ws, b.frames, table.tableId, 1);
    send(a.ws, "TABLE_JOIN", { tableId: table.tableId });
    send(b.ws, "TABLE_JOIN", { tableId: table.tableId });
    await waitFor(() => {
      const state = latest(a.frames);
      return state?.toActSeat === 0 && state.actorLegal?.actions.includes("CALL") === true && state.turnId != null;
    }, "call turn");
    const state = latest(a.frames);
    if (!state?.turnId) throw new Error("no turn");
    const stackBefore = state.players.find((player) => player.userId === hero.userId)?.stack;
    const first = send(a.ws, "ACTION_INTENT", {
      tableId: table.tableId, revision: state.revision, action: "CALL", clientActionId: crypto.randomUUID(), turnId: state.turnId,
    });
    const second = send(a.ws, "ACTION_INTENT", {
      tableId: table.tableId, revision: state.revision, action: "CALL", clientActionId: crypto.randomUUID(), turnId: state.turnId,
    });
    const left = await ack(a.frames, first);
    const right = await ack(a.frames, second);
    const oks = [left, right].filter((frame) => frame.payload.ok === true);
    expect(oks).toHaveLength(1);
    await waitFor(() => latest(a.frames)?.revision !== state.revision, "revision advanced");
    const stackAfter = latest(a.frames)?.players.find((player) => player.userId === hero.userId)?.stack;
    expect(stackBefore).toBeGreaterThan(stackAfter ?? 0);
    expect((stackBefore ?? 0) - (stackAfter ?? 0)).toBeLessThan(state.bigBlind);
    a.ws.close();
    b.ws.close();
  });

  it("sends nothing when a leak is forced, and still acks the actor", async () => {
    const table = await prepare("leak", 2);
    const [hero, villain] = table.players;
    if (!hero || !villain) throw new Error("fixture");
    const a = await connect(table.tableId, hero.ticket);
    const b = await connect(table.tableId, villain.ticket);
    await sit(a.ws, a.frames, table.tableId, 0);
    await sit(b.ws, b.frames, table.tableId, 1);
    send(a.ws, "TABLE_JOIN", { tableId: table.tableId });
    send(b.ws, "TABLE_JOIN", { tableId: table.tableId });
    await waitFor(() => {
      const state = latest(a.frames);
      return state?.toActSeat === 0 && state.actorLegal != null && state.turnId != null;
    }, "hero turn");
    await waitFor(() => latest(b.frames)?.revision === latest(a.frames)?.revision, "viewers synced");
    const before = b.frames.filter((frame) => frame.type === "STATE_SNAPSHOT").length;
    const stub = tableStub(table.tableId) as unknown as { armTestFault(fault: string): Promise<void> };
    await stub.armTestFault("leak");
    const state = latest(a.frames);
    if (!state?.actorLegal || state.turnId == null) throw new Error("no action");
    const action = state.actorLegal.actions.includes("CHECK") ? "CHECK" : "CALL";
    const id = send(a.ws, "ACTION_INTENT", {
      tableId: table.tableId, revision: state.revision, action, clientActionId: crypto.randomUUID(), turnId: state.turnId,
    });
    expect((await ack(a.frames, id)).payload.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(b.frames.filter((frame) => frame.type === "STATE_SNAPSHOT").length).toBe(before);
    expect(a.frames.filter((frame) => frame.type === "STATE_SNAPSHOT" && (frame.payload as { revision?: number }).revision === (state.revision + 1))).toHaveLength(0);
    a.ws.close();
    b.ws.close();
  });

  it("closes a revoked session", async () => {
    const table = await prepare("revoke", 1);
    const hero = table.players[0];
    if (!hero) throw new Error("fixture");
    const socket = await connect(table.tableId, hero.ticket);
    await waitFor(() => socket.frames.some((frame) => frame.type === "AUTH_OK"), "auth");
    const sessions = workerEnv().USER_SESSIONS.getByName(hero.userId) as unknown as {
      revoke(input: { sessionId: string; reason: "LOGOUT" }): Promise<void>;
    };
    await sessions.revoke({ sessionId: hero.sessionId, reason: "LOGOUT" });
    await waitFor(() => socket.frames.some((frame) => frame.type === "SESSION_REVOKED"), "revoked");
    await waitFor(() => socket.closeCode() === 4001, "close 4001");
  });

  it("keeps the socket attachment and ciphertext across hibernation", async () => {
    const table = await prepare("wake", 1);
    const hero = table.players[0];
    if (!hero) throw new Error("fixture");
    const socket = await connect(table.tableId, hero.ticket);
    await sit(socket.ws, socket.frames, table.tableId, 0);
    send(socket.ws, "TABLE_JOIN", { tableId: table.tableId });
    const stub = tableStub(table.tableId);
    await evictDurableObject(stub);
    const restored = await runInDurableObject(stub, (_instance, state) => {
      const attached = state.getWebSockets()[0]?.deserializeAttachment() as { userId?: string } | null;
      const rows = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'engine'").toArray();
      return { userId: attached?.userId ?? null, prefix: rows[0]?.value.slice(0, 3) ?? null };
    });
    expect(restored.userId).toBe(hero.userId);
    expect(restored.prefix).toBe("v2.");
    socket.ws.close();
  });

  it("track() arms the idle alarm on the TableActor", async () => {
    const table = await prepare("track", 1);
    const stub = tableStub(table.tableId) as DurableObjectStub & { track(): Promise<void> };
    await stub.track();
    const alarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    expect(typeof alarm).toBe("number");
  });

  it("sends a lobby patch when a player sits", async () => {
    const table = await prepare("patch", 1);
    const hero = table.players[0];
    if (!hero) throw new Error("fixture");
    const lobby = await connectLobby(hero.ticket);
    await waitFor(() => lobby.frames.some((frame) => frame.type === "AUTH_OK"), "lobby auth");
    const socket = await connect(table.tableId, hero.ticket);
    await waitFor(() => socket.frames.some((frame) => frame.type === "AUTH_OK"), "table auth");
    await sit(socket.ws, socket.frames, table.tableId, 0);
    await waitFor(() => lobby.frames.some((frame) => frame.type === "LOBBY_PATCH"), "lobby patch");
    const patch = lobby.frames.find((frame) => frame.type === "LOBBY_PATCH");
    const payload = patch?.payload as { table?: { id?: string; occupiedSeats?: number } } | undefined;
    expect(payload?.table?.id).toBe(table.tableId);
    expect(payload?.table?.occupiedSeats).toBe(1);
    lobby.ws.close();
    socket.ws.close();
  });
});
