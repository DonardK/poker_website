import {
  EngineError,
  applyAction,
  applyTimeout,
  beginIdleWarning,
  clearIdleWarning,
  closeTable,
  completeHand,
  idleSince,
  keepTableOpen,
  leaveSeat,
  recordActivity,
  sitDown,
  sitIn,
  sitOut,
  startHand,
  turnDeadline,
  turnIdOf,
  type EngineIntent,
  type EngineTable,
} from "@poker/engine";
import {
  TABLE_IDLE_TIMEOUT_MS,
  TABLE_IDLE_WARNING_MS,
  type CommandResult,
  type HandHistoryLogEntry,
  type LobbySeatPatch,
  type PublicTableState,
  type TableCloseReason,
  type TableIdleNoticePayload,
  type TableListItem,
  type TableStatus,
} from "@poker/shared";
import {
  clientCommandId,
  closeCommandId,
  dealCommandId,
  showdownCommandId,
  timerCommandId,
} from "../db/game-command";
import type { Env } from "../env";
import { readEdgeConfig } from "../env";
import { guardedTableState } from "../game/mask";
import { decryptState, ringFromConfig } from "../game/crypto";
import { logEvent } from "../game/log";
import {
  TestFault,
  TransientDb,
  applyMutation,
  checkVisible,
  openTable,
  settlePending,
  walletPatch,
  withDb,
  type MutationOutcome,
  type MutationRequest,
  type TableRowInfo,
} from "../game/persist";
import { assertLiveSession, isAuthError, signHs256, verifyAccessToken, type AuthError } from "../game/session";
import type { LobbyActorRpc, SessionDelivery, UserSessionsRpc } from "../session/contract";
import { planAlarm, parsePlan, readyToDeal, type AlarmPlan } from "./alarm";
import {
  connId,
  fanKey,
  frameByteLength,
  isMutating,
  parseClientFrame,
  readAttachment,
  readCookie,
  sendFailure,
  sendFrame,
  type ClientMessage,
  type SocketAttachment,
} from "./frames";
import { bumpBucket, metaDelete, metaGet, metaSet, pendingOutbox, purgeOldRows } from "./store";

const VIEWERS = 64;
const IDLE_LATE_MS = 5_000;

export interface TableRuntime {
  ctx: DurableObjectState;
  env: Env;
  tableId: string;
  gate<T>(fn: () => T | Promise<T>): Promise<T>;
}

export interface Effects {
  notices: SessionDelivery[];
  lobby?: LobbySeatPatch;
  unregister?: { userId: string; connId: string };
  reregister?: { userId: string; previousConnId: string; sessionId: string; connId: string; target: string };
}

export function emptyEffects(): Effects {
  return { notices: [] };
}

export async function flushEffects(env: Env, effects: Effects): Promise<void> {
  for (const notice of effects.notices) {
    try {
      const sessions = env.USER_SESSIONS.getByName(notice.userId) as unknown as UserSessionsRpc;
      await sessions.notify({ ...(notice.sessionId ? { sessionId: notice.sessionId } : {}), event: notice.event, payload: notice.payload });
    } catch (err) {
      logEvent("warn", "user session notify failed", { userId: notice.userId, name: err instanceof Error ? err.name : "error" });
    }
  }
  if (effects.unregister) {
    try {
      const sessions = env.USER_SESSIONS.getByName(effects.unregister.userId) as unknown as UserSessionsRpc;
      await sessions.unregister({ connId: effects.unregister.connId });
    } catch (err) {
      logEvent("warn", "user session unregister failed", { name: err instanceof Error ? err.name : "error" });
    }
  }
  if (effects.reregister) {
    const sessions = env.USER_SESSIONS.getByName(effects.reregister.userId) as unknown as UserSessionsRpc;
    try {
      await sessions.unregister({ connId: effects.reregister.previousConnId });
    } catch {
      /* The new registration is the one revoke must find. */
    }
    try {
      await sessions.register({ sessionId: effects.reregister.sessionId, target: effects.reregister.target, connId: effects.reregister.connId });
    } catch (err) {
      logEvent("warn", "user session reregister failed", { name: err instanceof Error ? err.name : "error" });
    }
  }
  if (effects.lobby) {
    try {
      const lobby = env.LOBBY.getByName("lobby") as unknown as LobbyActorRpc;
      await lobby.patch(effects.lobby);
    } catch (err) {
      logEvent("warn", "lobby patch failed", { name: err instanceof Error ? err.name : "error" });
    }
  }
}

function sessionsOf(env: Env, userId: string): UserSessionsRpc {
  return env.USER_SESSIONS.getByName(userId) as unknown as UserSessionsRpc;
}

export async function acceptSocket(runtime: TableRuntime, request: Request): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const ticket = readCookie(request.headers.get("cookie"), "poker_ws");
  if (!ticket) return new Response("Unauthorized", { status: 401 });
  let claims: { sub: string; sid: string; username: string };
  try {
    const { verifyWsTicket } = await import("../game/session");
    claims = await verifyWsTicket(ticket, readEdgeConfig(runtime.env).wsTicketSecret);
  } catch (err) {
    if (isAuthError(err)) return new Response("Unauthorized", { status: 401 });
    logEvent("error", "websocket ticket check failed", { name: err instanceof Error ? err.name : "error" });
    return new Response("Service unavailable", { status: 503 });
  }
  const connectedAt = Date.now();
  const attachment: SocketAttachment = { userId: claims.sub, sessionId: claims.sid, username: claims.username, connectedAt };
  let client: WebSocket;
  let server: WebSocket;
  let full = false;
  const opened = await runtime.gate(() => {
    const pair = new WebSocketPair();
    client = pair[0];
    server = pair[1];
    full = runtime.ctx.getWebSockets().length >= VIEWERS;
    runtime.ctx.acceptWebSocket(server, [`user:${claims.sub}`, `session:${claims.sid}`]);
    server.serializeAttachment(attachment);
    if (full) {
      sendFailure(server, { code: "TABLE_FULL", message: "This table is full" });
      server.close(4003, "full");
    }
    return true;
  });
  void opened;
  if (full) return new Response(null, { status: 101, webSocket: client! });
  try {
    await withDb(runtime.env, async (db) => {
      const live = await assertLiveSession(db.prisma, claims.sid, claims.sub);
      attachment.username = live.username;
      server!.serializeAttachment(attachment);
      await sessionsOf(runtime.env, live.userId).register({
        sessionId: live.sessionId,
        target: `table:${runtime.tableId}`,
        connId: connId(attachment),
      });
      const idleNotice = await idleNoticeFor(db, runtime.tableId, live.userId);
      const seat = await db.prisma.tableSeat.findUnique({ where: { userId: live.userId }, select: { tableId: true } });
      sendFrame(server!, "AUTH_OK", { userId: live.userId, username: live.username, activeTableId: seat?.tableId ?? null, idleNotice });
    });
  } catch (err) {
    if (isAuthError(err)) {
      sendFrame(server!, "SESSION_REVOKED", { reason: err.reason ?? "SESSION_REVOKED" });
      server!.close(4001, "session");
    } else {
      logEvent("error", "socket session check failed", { name: err instanceof Error ? err.name : "error" });
      server!.close(1011, "error");
    }
  }
  return new Response(null, { status: 101, webSocket: client! });
}

export async function onSocketMessage(runtime: TableRuntime, ws: WebSocket, message: string | ArrayBuffer): Promise<Effects> {
  const effects = emptyEffects();
  if (message instanceof ArrayBuffer) {
    try { ws.close(1003, "binary"); } catch { /* already closed */ }
    return effects;
  }
  if (message === "ping" || message === "pong") return effects;
  const attachment = readAttachment(ws);
  if (!attachment) {
    try { ws.close(1008, "policy"); } catch { /* already closed */ }
    return effects;
  }
  if (frameByteLength(message) > 8_192) {
    bumpBucket(runtime.ctx.storage.sql, `rate:${attachment.sessionId}`, 20);
    try { ws.close(1009, "too-large"); } catch { /* already closed */ }
    return effects;
  }
  const parsed = parseClientFrame(message, runtime.tableId);
  if (!parsed.ok) {
    countFrame(runtime, attachment, "TABLE_JOIN");
    sendFailure(ws, parsed.failure);
    return effects;
  }
  if (!countFrame(runtime, attachment, parsed.message.type)) {
    answer(ws, parsed.message.id, { ok: false, code: "RATE_LIMITED", message: "Too many requests", retryable: true });
    return effects;
  }
  try {
    if (parsed.message.type === "SESSION_RENEW") {
      await renew(runtime, ws, attachment, parsed.message, effects);
      return effects;
    }
    if (isMutating(parsed.message.type) || parsed.message.type === "TABLE_JOIN" || parsed.message.type === "REHYDRATE") {
      await recheck(runtime, ws, attachment);
    }
    await dispatch(runtime, ws, attachment, parsed.message, effects);
  } catch (err) {
    if (isAuthError(err)) {
      endSocket(ws, parsed.message.id, err);
      return effects;
    }
    if (err instanceof TransientDb || err instanceof TestFault) {
      await armSoon(runtime);
      answer(ws, parsed.message.id, { ok: false, code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable, please retry", retryable: true });
      return effects;
    }
    if (err instanceof EngineError) {
      answer(ws, parsed.message.id, { ok: false, code: err.code, message: err.message });
      if (err.code === "STALE_ACTION") await pushSnapshot(runtime, ws, attachment.userId);
      return effects;
    }
    throw err;
  }
  return effects;
}

export function onSocketClose(runtime: TableRuntime, ws: WebSocket): Effects {
  const effects = emptyEffects();
  const attachment = readAttachment(ws);
  if (!attachment) return effects;
  metaDelete(runtime.ctx.storage.sql, fanKey(attachment));
  effects.unregister = { userId: attachment.userId, connId: connId(attachment) };
  return effects;
}

export async function onAlarm(runtime: TableRuntime): Promise<Effects> {
  const effects = emptyEffects();
  purgeOldRows(runtime.ctx.storage.sql);
  const plan = parsePlan(metaGet(runtime.ctx.storage.sql, "alarm"));
  const now = Date.now();
  if (plan && (plan.kind === "idle-warn" || plan.kind === "idle-close") && now + 1_000 < plan.at) {
    await runtime.ctx.storage.setAlarm(plan.at);
    return effects;
  }
  try {
    if (!plan || plan.kind === "outbox" || plan.kind === "retry") {
      await drain(runtime, effects);
      await rearm(runtime, effects);
      return effects;
    }
    if (plan.kind === "idle-close" && now > plan.at + IDLE_LATE_MS) {
      logEvent("warn", "IDLE_ALARM_LATE", { tableId: runtime.tableId });
      await commit(runtime, effects, idleLateRequest(runtime.tableId));
      return effects;
    }
    if (plan.kind === "idle-warn") await commit(runtime, effects, idleWarnRequest(runtime.tableId));
    else if (plan.kind === "idle-close") await commit(runtime, effects, idleCloseRequest(runtime.tableId));
    else if (plan.kind === "timeout" || plan.kind === "bot") await commit(runtime, effects, turnRequest(runtime.tableId, plan));
    else if (plan.kind === "showdown") {
      const done = await commit(runtime, effects, showdownRequest(runtime.tableId, plan.handNumber));
      if (done.ok || !done.retryable) await commit(runtime, effects, dealRequest(runtime.tableId));
    } else if (plan.kind === "deal") await commit(runtime, effects, dealRequest(runtime.tableId));
  } catch (err) {
    if (err instanceof TransientDb || err instanceof TestFault) {
      await armSoon(runtime);
      return effects;
    }
    throw err;
  }
  return effects;
}

export async function track(runtime: TableRuntime): Promise<Effects> {
  const effects = emptyEffects();
  await drain(runtime, effects);
  await rearm(runtime, effects);
  await withDb(runtime.env, async (db) => {
    const opened = await openTable(db, runtime.ctx.storage, runtime.tableId);
    if (!opened.table || !opened.row) return;
    // The create transaction seated the host before this object existed, so
    // there is no prior engine snapshot to diff. A closed ghost forces the
    // same patch a seat change would send.
    const before = {
      ...opened.table,
      status: opened.table.status === "CLOSED" ? "WAITING" : "CLOSED",
      players: opened.table.players.map(() => null),
    } as EngineTable;
    const patch = lobbyPatch(opened.row, before, opened.table);
    if (patch) effects.lobby = patch;
  });
  return effects;
}

export async function keepAlive(runtime: TableRuntime, userId: string, commandId?: string): Promise<{ result: CommandResult; effects: Effects }> {
  const effects = emptyEffects();
  const request: MutationRequest = {
    commandId: commandId ? clientCommandId(commandId) : ((_before, next) => `keep:${runtime.tableId}:${userId}:${next.revision}`),
    kind: "keep",
    userId,
    storeEngineError: true,
    durableNoOp: Boolean(commandId),
    fn: (table) => keepTableOpen(table, userId),
    success: () => ({ ok: true }),
  };
  const outcome = await commit(runtime, effects, request);
  return { result: outcome.result, effects };
}

export async function currentIdleNotice(runtime: TableRuntime, userId: string): Promise<TableIdleNoticePayload | null> {
  return withDb(runtime.env, (db) => idleNoticeFor(db, runtime.tableId, userId));
}

export function armTestFault(runtime: TableRuntime, fault: string): void {
  metaSet(runtime.ctx.storage.sql, "testFault", fault);
}

export interface PreparedPlayer {
  userId: string;
  sessionId: string;
  username: string;
  ticket: string;
}

export async function prepareFixture(runtime: TableRuntime, input: {
  tableId: string;
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  minBuyIn: number;
  maxBuyIn: number;
  timeBankMs: number;
  hostIndex?: number;
  players: { username: string; bankroll: number }[];
}): Promise<{ players: PreparedPlayer[] }> {
  return withDb(runtime.env, async (db) => {
    const players: PreparedPlayer[] = [];
    for (const player of input.players) {
      const user = await db.prisma.user.create({ data: { username: player.username, bankroll: player.bankroll, isGuest: false, kind: "HUMAN" } });
      const session = await db.prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
          absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      });
      const ticket = await signHs256({
        sub: user.id,
        sid: session.id,
        username: user.username,
        typ: "ws",
        iss: "poker-server",
        aud: "poker-ws",
        exp: Math.floor(Date.now() / 1000) + 60,
      }, db.config.wsTicketSecret);
      players.push({ userId: user.id, sessionId: session.id, username: user.username, ticket });
    }
    const hostId = players[input.hostIndex ?? 0]?.userId ?? players[0]?.userId ?? null;
    await db.prisma.table.create({
      data: {
        id: input.tableId,
        name: input.tableName,
        isPrivate: true,
        hostId,
        smallBlind: input.smallBlind,
        bigBlind: input.bigBlind,
        minBuyIn: input.minBuyIn,
        maxBuyIn: input.maxBuyIn,
        maxSeats: input.maxSeats,
        timeBankMs: input.timeBankMs,
        seats: { create: Array.from({ length: input.maxSeats }, (_, seatIndex) => ({ seatIndex })) },
      },
    });
    return { players };
  });
}

export async function tableFacts(runtime: TableRuntime, userIds: string[]): Promise<{
  commands: { id: string; kind: string; appliedRevision: number }[];
  bankrolls: Record<string, number>;
  handCount: number;
  status: string | null;
  revision: string | null;
  enginePrefix: string | null;
}> {
  return withDb(runtime.env, async (db) => {
    const [commands, users, hands, row] = await Promise.all([
      db.prisma.gameCommand.findMany({ where: { tableId: runtime.tableId }, select: { id: true, kind: true, appliedRevision: true }, orderBy: { createdAt: "asc" } }),
      db.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, bankroll: true } }),
      db.prisma.hand.count({ where: { tableId: runtime.tableId } }),
      db.prisma.table.findUnique({ where: { id: runtime.tableId }, select: { status: true } }),
    ]);
    const cipher = metaGet(runtime.ctx.storage.sql, "engine");
    const bankrolls: Record<string, number> = {};
    for (const user of users) bankrolls[user.id] = user.bankroll;
    return {
      commands,
      bankrolls,
      handCount: hands,
      status: row?.status ?? null,
      revision: metaGet(runtime.ctx.storage.sql, "revision"),
      enginePrefix: cipher ? cipher.slice(0, 3) : null,
    };
  });
}

function countFrame(runtime: TableRuntime, attachment: SocketAttachment, type: ClientMessage["type"]): boolean {
  const sql = runtime.ctx.storage.sql;
  const frames = bumpBucket(sql, `rate:${attachment.sessionId}`, 20);
  const actions = !isMutating(type) || bumpBucket(sql, `arate:${attachment.userId}`, 8);
  return frames && actions;
}

async function recheck(runtime: TableRuntime, ws: WebSocket, attachment: SocketAttachment): Promise<void> {
  await withDb(runtime.env, async (db) => {
    const live = await assertLiveSession(db.prisma, attachment.sessionId, attachment.userId);
    if (live.username !== attachment.username) {
      attachment.username = live.username;
      ws.serializeAttachment(attachment);
    }
  });
}

function endSocket(ws: WebSocket, id: string | undefined, err: AuthError): void {
  if (err.closeAs === 4001) sendFrame(ws, "SESSION_REVOKED", { reason: err.reason ?? "SESSION_REVOKED" });
  answer(ws, id, { ok: false, code: "UNAUTHORIZED", message: "Please sign in again" });
  try { ws.close(err.closeAs, err.closeAs === 4001 ? "session" : "unauthorized"); } catch { /* already closed */ }
}

async function renew(runtime: TableRuntime, ws: WebSocket, attachment: SocketAttachment, message: ClientMessage, effects: Effects): Promise<void> {
  const token = message.payload.token;
  if (typeof token !== "string") {
    answer(ws, message.id, { ok: false, code: "UNAUTHORIZED", message: "Please sign in again" });
    return;
  }
  let claims: { sub: string; sid: string; username: string };
  try {
    claims = await verifyAccessToken(token, readEdgeConfig(runtime.env).jwtAccessSecret);
  } catch (err) {
    if (isAuthError(err)) {
      answer(ws, message.id, { ok: false, code: "UNAUTHORIZED", message: "Please sign in again" });
      try { ws.close(4002, "unauthorized"); } catch { /* already closed */ }
      return;
    }
    answer(ws, message.id, { ok: false, code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable, please retry", retryable: true });
    return;
  }
  if (claims.sub !== attachment.userId) {
    logEvent("warn", "SESSION_RENEW_USER_MISMATCH", { tableId: runtime.tableId });
    answer(ws, message.id, { ok: false, code: "UNAUTHORIZED", message: "Please sign in again" });
    try { ws.close(4002, "unauthorized"); } catch { /* already closed */ }
    return;
  }
  try {
    await withDb(runtime.env, (db) => assertLiveSession(db.prisma, claims.sid, claims.sub));
  } catch (err) {
    if (isAuthError(err)) {
      endSocket(ws, message.id, err.closeAs === 4002 ? err : Object.assign(err, { closeAs: 4002 as const }));
      return;
    }
    answer(ws, message.id, { ok: false, code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable, please retry", retryable: true });
    return;
  }
  const previousConnId = connId(attachment);
  const previousSession = attachment.sessionId;
  attachment.sessionId = claims.sid;
  attachment.username = claims.username;
  ws.serializeAttachment(attachment);
  if (previousSession !== claims.sid) {
    const member = metaGet(runtime.ctx.storage.sql, `fan:${previousSession}:${attachment.connectedAt}`);
    metaDelete(runtime.ctx.storage.sql, `fan:${previousSession}:${attachment.connectedAt}`);
    if (member) metaSet(runtime.ctx.storage.sql, fanKey(attachment), "1");
    effects.reregister = {
      userId: attachment.userId,
      previousConnId,
      sessionId: claims.sid,
      connId: connId(attachment),
      target: `table:${runtime.tableId}`,
    };
  }
  answer(ws, message.id, { ok: true });
}

async function dispatch(runtime: TableRuntime, ws: WebSocket, attachment: SocketAttachment, message: ClientMessage, effects: Effects): Promise<void> {
  const type = message.type;
  if (type === "TABLE_JOIN" || type === "REHYDRATE") {
    await join(runtime, ws, attachment, effects);
    return;
  }
  if (type === "TABLE_LEAVE") {
    metaDelete(runtime.ctx.storage.sql, fanKey(attachment));
    return;
  }
  if (type === "SEAT_CLAIM") {
    const buyIn = message.payload.buyIn as number;
    const seatIndex = message.payload.seatIndex as number;
    const claim = await commit(runtime, effects, {
      commandId: clientCommandId(String(message.payload.commandId)),
      kind: "seat",
      userId: attachment.userId,
      storeEngineError: true,
      extraChips: [{ userId: attachment.userId, amount: buyIn, mode: "debit" }],
      fn: async (table) => {
        const seated = await withDb(runtime.env, (db) => db.prisma.user.findUnique({ where: { id: attachment.userId } }));
        if (!seated || seated.kind !== "HUMAN") throw new EngineError("UNAUTHORIZED", "User missing");
        const now = Date.now();
        return recordActivity(sitDown(table, seatIndex, {
          userId: seated.id,
          username: seated.username,
          avatarHue: seated.avatarHue,
          kind: "HUMAN",
          botProfile: null,
          buyIn,
        }, now), now, seated.id);
      },
      success: () => ({ ok: true }),
    });
    answer(ws, message.id, claim.result);
    if (claim.result.ok && !claim.result.duplicate) {
      try { await commit(runtime, effects, dealRequest(runtime.tableId)); }
      catch (err) { logEvent("warn", "could not start a hand after a seat claim", { tableId: runtime.tableId, name: err instanceof Error ? err.name : "error" }); }
    }
    return;
  }
  if (type === "SIT_OUT" || type === "SIT_IN") {
    const out = type === "SIT_OUT";
    const toggled = await commit(runtime, effects, {
      commandId: clientCommandId(String(message.payload.commandId)),
      kind: out ? "sit_out" : "sit_in",
      userId: attachment.userId,
      storeEngineError: true,
      fn: (table) => {
        const next = out ? sitOut(table, attachment.userId) : sitIn(table, attachment.userId);
        return next === table ? table : recordActivity(next, Date.now(), attachment.userId);
      },
      success: () => ({ ok: true }),
    });
    answer(ws, message.id, toggled.result);
    if (type === "SIT_IN" && toggled.result.ok && !toggled.result.duplicate) {
      try { await commit(runtime, effects, dealRequest(runtime.tableId)); }
      catch (err) { logEvent("warn", "could not start a hand after sit-in", { tableId: runtime.tableId, name: err instanceof Error ? err.name : "error" }); }
    }
    return;
  }
  if (type === "STAND_UP") {
    const stood = await commit(runtime, effects, {
      commandId: clientCommandId(String(message.payload.commandId)),
      kind: "stand",
      userId: attachment.userId,
      storeEngineError: true,
      fn: (table) => table.players.some((player) => player?.userId === attachment.userId) ? leaveSeat(table, attachment.userId) : table,
      success: (table) => ({ ok: true, pendingLeave: table.players.some((player) => player?.userId === attachment.userId && player.pendingLeave) }),
    });
    answer(ws, message.id, stood.result);
    return;
  }
  if (type === "TABLE_KEEP_ALIVE") {
    const kept = await commit(runtime, effects, {
      commandId: clientCommandId(String(message.payload.commandId)),
      kind: "keep",
      userId: attachment.userId,
      storeEngineError: true,
      fn: (table) => keepTableOpen(table, attachment.userId),
      success: () => ({ ok: true }),
    });
    answer(ws, message.id, kept.result);
    return;
  }
  if (type === "ACTION_INTENT") {
    const revision = message.payload.revision as number;
    const turnId = typeof message.payload.turnId === "string" ? message.payload.turnId : undefined;
    const intent: EngineIntent = {
      action: message.payload.action as EngineIntent["action"],
      ...(message.payload.amount !== undefined ? { amount: message.payload.amount as number } : {}),
    };
    const acted = await commit(runtime, effects, {
      commandId: clientCommandId(String(message.payload.clientActionId)),
      kind: "action",
      userId: attachment.userId,
      storeEngineError: true,
      fn: (table) => {
        if (turnId !== undefined) {
          if (turnIdOf(table) !== turnId) throw new EngineError("STALE_ACTION", "The table changed; use the latest action buttons");
        } else if (table.revision !== revision) {
          throw new EngineError("STALE_ACTION", "The table changed; use the latest action buttons");
        }
        const deadline = turnDeadline(table);
        if (deadline != null && Date.now() >= deadline) throw new EngineError("TURN_EXPIRED", "Your turn has expired");
        return recordActivity(applyAction(table, attachment.userId, intent), Date.now(), attachment.userId);
      },
      success: () => ({ ok: true }),
    });
    answer(ws, message.id, acted.result);
    if (!acted.result.ok && acted.result.code === "STALE_ACTION") await pushSnapshot(runtime, ws, attachment.userId);
  }
}

async function join(runtime: TableRuntime, ws: WebSocket, attachment: SocketAttachment, effects: Effects): Promise<void> {
  try {
    await withDb(runtime.env, (db) => checkVisible(db, runtime.tableId, attachment.userId));
  } catch (err) {
    if (err instanceof EngineError) {
      sendFailure(ws, { code: err.code, message: err.message, tableId: runtime.tableId });
      return;
    }
    throw err;
  }
  metaSet(runtime.ctx.storage.sql, fanKey(attachment), "1");
  await ensureUpgraded(runtime, effects);
  await pushSnapshot(runtime, ws, attachment.userId);
  try { await commit(runtime, effects, dealRequest(runtime.tableId)); }
  catch (err) { logEvent("warn", "could not start a hand on join", { tableId: runtime.tableId, name: err instanceof Error ? err.name : "error" }); }
}

async function pushSnapshot(runtime: TableRuntime, ws: WebSocket, userId: string): Promise<void> {
  await withDb(runtime.env, async (db) => {
    const opened = await openTable(db, runtime.ctx.storage, runtime.tableId);
    if (!opened.table) return;
    const state = project(runtime, opened.table, userId);
    if (state) sendFrame(ws, "STATE_SNAPSHOT", state);
  });
}

async function ensureUpgraded(runtime: TableRuntime, effects: Effects): Promise<void> {
  await withDb(runtime.env, async (db) => {
    const opened = await openTable(db, runtime.ctx.storage, runtime.tableId);
    if (!opened.upgraded || !opened.table) return;
    await commit(runtime, effects, {
      commandId: `upgrade:${runtime.tableId}:${opened.table.revision}`,
      kind: "upgrade",
      userId: null,
      storeEngineError: false,
      durableNoOp: false,
      fn: (table) => table,
      success: () => ({ ok: true }),
    });
  });
}

async function commit(runtime: TableRuntime, effects: Effects, request: MutationRequest): Promise<{ ok: boolean; retryable: boolean; result: CommandResult }> {
  let outcome: MutationOutcome;
  try {
    outcome = await withDb(runtime.env, (db) => applyMutation(db, runtime.ctx.storage, runtime.tableId, request));
  } catch (err) {
    if (err instanceof TransientDb || err instanceof TestFault) {
      await armSoon(runtime);
      return { ok: false, retryable: true, result: { ok: false, code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable, please retry", retryable: true } };
    }
    throw err;
  }
  await publish(runtime, effects, outcome);
  const retryable = outcome.result.ok ? false : Boolean(outcome.result.retryable);
  return { ok: outcome.result.ok, retryable, result: outcome.result };
}

async function publish(runtime: TableRuntime, effects: Effects, outcome: MutationOutcome): Promise<void> {
  const table = outcome.broadcast;
  if (table && outcome.changed) broadcast(runtime, table, outcome.before);
  if (table) await arm(runtime, table, false);
  else if (!outcome.result.ok && outcome.result.code === "RECOVERY_REQUIRED") await runtime.ctx.storage.deleteAlarm();
  if (!table && !outcome.changed) await rearm(runtime, effects);
  await withDb(runtime.env, async (db) => {
    const credits = new Set(outcome.creditUserIds);
    const closedReason: TableCloseReason | undefined = table?.closeReason === "IDLE" ? "IDLE" : undefined;
    for (const userId of new Set(outcome.walletUserIds)) {
      const bankroll = await walletPatch(db, userId);
      if (bankroll == null) continue;
      const payload: Record<string, unknown> = { bankroll };
      if (credits.has(userId)) payload.cashOutTableId = runtime.tableId;
      if (credits.has(userId) && closedReason) payload.tableClosedReason = closedReason;
      sendUser(runtime, userId, "USER_PATCH", payload);
      effects.notices.push({ userId, event: "USER_PATCH", payload });
    }
    if (outcome.before && table) {
      const notice = idleDiff(outcome.before, table);
      if (notice) {
        for (const userId of notice.userIds) {
          sendUser(runtime, userId, "TABLE_IDLE_NOTICE", notice.payload);
          effects.notices.push({ userId, event: "TABLE_IDLE_NOTICE", payload: notice.payload });
        }
      }
      const patch = lobbyPatch(outcome.row, outcome.before, table);
      if (patch) effects.lobby = patch;
    }
  });
}

function broadcast(runtime: TableRuntime, table: EngineTable, before: EngineTable | null): void {
  const leak = metaGet(runtime.ctx.storage.sql, "testFault") === "leak";
  if (leak) {
    metaSet(runtime.ctx.storage.sql, "testFault", "");
    logEvent("error", "SECURITY EVENT: leak guard refused a table-state emission; nothing was sent to this viewer", {
      security: "LEAK_BLOCKED",
      tableId: table.tableId,
      revision: table.revision,
      handNumber: table.handNumber,
      phase: table.phase,
    });
    return;
  }
  const freshLog = before && table.log.length > before.log.length ? table.log.slice(before.log.length) : [];
  for (const ws of runtime.ctx.getWebSockets()) {
    const attachment = readAttachment(ws);
    if (!attachment || metaGet(runtime.ctx.storage.sql, fanKey(attachment)) !== "1") continue;
    const state = project(runtime, table, attachment.userId);
    if (!state) continue;
    sendFrame(ws, "STATE_SNAPSHOT", state);
    for (const entry of freshLog) sendFrame(ws, "HAND_HISTORY_LOG", entry as HandHistoryLogEntry);
  }
}

function project(runtime: TableRuntime, table: EngineTable, viewerUserId: string): PublicTableState | null {
  return guardedTableState(table, viewerUserId, (event) => {
    logEvent("error", "SECURITY EVENT: leak guard refused a table-state emission; nothing was sent to this viewer", {
      security: "LEAK_BLOCKED",
      tableId: event.tableId,
      revision: event.revision,
      handNumber: event.handNumber,
      phase: event.phase,
    });
  });
  void runtime;
}

function sendUser(runtime: TableRuntime, userId: string, type: "USER_PATCH" | "TABLE_IDLE_NOTICE", payload: unknown): void {
  for (const ws of runtime.ctx.getWebSockets()) {
    const attachment = readAttachment(ws);
    if (attachment?.userId === userId) sendFrame(ws, type, payload);
  }
}

function answer(ws: WebSocket, id: string | undefined, result: CommandResult): void {
  if (!id) {
    if (!result.ok) sendFrame(ws, "SERVER_ERROR", { code: result.code, message: result.message, ...(result.retryable ? { retryable: true } : {}) });
    return;
  }
  sendFrame(ws, "ACK", result, id);
  if (!result.ok) sendFrame(ws, "SERVER_ERROR", { code: result.code, message: result.message, ...(result.retryable ? { retryable: true } : {}) }, id);
}

function idleDiff(before: EngineTable, next: EngineTable): { userIds: string[]; payload: TableIdleNoticePayload } | null {
  const humans = (table: EngineTable, staying: boolean) => table.players.flatMap((player) => player && player.kind === "HUMAN" && !(staying && player.pendingLeave) ? [player.userId] : []);
  let userIds: string[];
  let closingInMs: number | null;
  if (before.closingAt == null && next.closingAt != null) {
    userIds = humans(next, true);
    closingInMs = Math.max(0, next.closingAt - Date.now());
  } else if (before.closingAt != null && next.closingAt == null && next.closeReason == null) {
    userIds = [...new Set([...humans(before, false), ...humans(next, false)])];
    closingInMs = null;
  } else return null;
  return { userIds, payload: { tableId: next.tableId, tableName: next.name, closingInMs } };
}

function lobbyPatch(row: TableRowInfo | null, before: EngineTable, next: EngineTable): LobbySeatPatch | null {
  if (!row) return null;
  if (material(before) === material(next)) return null;
  const seated = next.players.flatMap((player) => player ? [player] : []);
  const botCount = seated.filter((player) => player.kind === "BOT").length;
  const table: Omit<TableListItem, "isSeated"> = {
    id: next.tableId,
    name: next.name,
    status: next.status as TableStatus,
    maxSeats: next.maxSeats,
    occupiedSeats: seated.length,
    smallBlind: next.smallBlind,
    bigBlind: next.bigBlind,
    minBuyIn: row.minBuyIn,
    maxBuyIn: row.maxBuyIn,
    botCount,
  };
  return {
    removed: next.status === "CLOSED" || row.isPrivate || botCount > 0,
    table,
    seatedUserIds: seated.map((player) => player.userId),
  };
}

function material(table: EngineTable): string {
  const seated = table.players.flatMap((player) => player ? [player.userId] : []).sort();
  return JSON.stringify({ status: table.status, sb: table.smallBlind, bb: table.bigBlind, seated });
}

async function idleNoticeFor(db: { prisma: import("../generated/prisma/client").PrismaClient; ring: ReturnType<typeof ringFromConfig>; config: ReturnType<typeof readEdgeConfig> }, tableId: string, userId: string): Promise<TableIdleNoticePayload | null> {
  const seat = await db.prisma.tableSeat.findUnique({ where: { userId }, include: { table: { select: { id: true, stateCiphertext: true, status: true } } } });
  if (!seat?.table?.stateCiphertext || seat.table.status === "CLOSED" || seat.table.status === "PAUSED") return null;
  let table: EngineTable;
  try {
    table = decryptState<EngineTable>(db.ring, seat.table.stateCiphertext, `table:${seat.table.id}`);
  } catch {
    return null;
  }
  void tableId;
  if (table.closingAt == null || table.closeReason != null) return null;
  if (!table.players.some((player) => player?.userId === userId && player.kind === "HUMAN" && !player.pendingLeave)) return null;
  return { tableId: table.tableId, tableName: table.name, closingInMs: Math.max(0, table.closingAt - Date.now()) };
}

async function drain(runtime: TableRuntime, effects: Effects): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (!pendingOutbox(runtime.ctx.storage.sql)) return;
    const settled = await withDb(runtime.env, (db) => settlePending(db, runtime.ctx.storage, runtime.tableId));
    if (settled?.table) {
      broadcast(runtime, settled.table, null);
      await withDb(runtime.env, async (db) => {
        for (const userId of new Set(settled.walletUserIds)) {
          const bankroll = await walletPatch(db, userId);
          if (bankroll == null) continue;
          const credit = settled.creditUserIds.includes(userId);
          const payload: Record<string, unknown> = { bankroll };
          if (credit) payload.cashOutTableId = runtime.tableId;
          if (credit && settled.table?.closeReason === "IDLE") payload.tableClosedReason = "IDLE";
          sendUser(runtime, userId, "USER_PATCH", payload);
          effects.notices.push({ userId, event: "USER_PATCH", payload });
        }
      });
    }
  }
}

async function rearm(runtime: TableRuntime, effects: Effects): Promise<void> {
  await withDb(runtime.env, async (db) => {
    const opened = await openTable(db, runtime.ctx.storage, runtime.tableId);
    if (opened.paused || opened.closed || opened.missing || !opened.table) {
      metaDelete(runtime.ctx.storage.sql, "alarm");
      await runtime.ctx.storage.deleteAlarm();
      return;
    }
    if (opened.upgraded) {
      await commit(runtime, effects, {
        commandId: `upgrade:${runtime.tableId}:${opened.table.revision}`,
        kind: "upgrade",
        userId: null,
        storeEngineError: false,
        durableNoOp: false,
        fn: (table) => table,
        success: () => ({ ok: true }),
      });
      return;
    }
    await arm(runtime, opened.table, false);
  });
}

async function arm(runtime: TableRuntime, table: EngineTable, forcePending: boolean): Promise<void> {
  if (table.status === "CLOSED" || metaGet(runtime.ctx.storage.sql, "paused")) {
    metaDelete(runtime.ctx.storage.sql, "alarm");
    await runtime.ctx.storage.deleteAlarm();
    return;
  }
  const pending = forcePending || pendingOutbox(runtime.ctx.storage.sql) !== null;
  const bots = readEdgeConfig(runtime.env).enableLegacyBots;
  const plan = await planAlarm(table, Date.now(), { pending, bots });
  if (!plan) {
    metaDelete(runtime.ctx.storage.sql, "alarm");
    await runtime.ctx.storage.deleteAlarm();
    return;
  }
  metaSet(runtime.ctx.storage.sql, "alarm", JSON.stringify(plan));
  const current = await runtime.ctx.storage.getAlarm();
  if (current !== plan.at) await runtime.ctx.storage.setAlarm(plan.at);
}

async function armSoon(runtime: TableRuntime): Promise<void> {
  const plan: AlarmPlan = { at: Date.now() + 1_000, kind: "outbox" };
  metaSet(runtime.ctx.storage.sql, "alarm", JSON.stringify(plan));
  await runtime.ctx.storage.setAlarm(plan.at);
}

function dealRequest(tableId: string): MutationRequest {
  return {
    commandId: (_before, next) => dealCommandId(tableId, next.handNumber),
    kind: "deal",
    userId: null,
    storeEngineError: false,
    durableNoOp: false,
    fn: (table) => {
      if (table.phase !== "WAITING" && table.phase !== "COMPLETE") return table;
      if (!readyToDeal(table)) return table;
      return startHand(table);
    },
    success: () => ({ ok: true }),
  };
}

function showdownRequest(tableId: string, handNumber: number | undefined): MutationRequest {
  return {
    commandId: (before) => showdownCommandId(tableId, before.handNumber),
    kind: "showdown",
    userId: null,
    storeEngineError: false,
    durableNoOp: false,
    fn: (table) => {
      if (table.phase !== "SHOWDOWN") return table;
      if (handNumber !== undefined && table.handNumber !== handNumber) return table;
      return completeHand(table);
    },
    success: () => ({ ok: true }),
  };
}

function turnRequest(tableId: string, plan: AlarmPlan): MutationRequest {
  return {
    commandId: () => plan.kind === "bot" && plan.intent && plan.userId && plan.turnId
      ? `bot:${tableId}:${plan.turnId}`
      : timerCommandId(tableId, plan.turnId ?? "0"),
    kind: plan.kind === "bot" ? "bot" : "timer",
    userId: plan.userId ?? null,
    storeEngineError: false,
    durableNoOp: false,
    fn: (table) => {
      if (!plan.turnId || turnIdOf(table) !== plan.turnId) return table;
      const deadline = turnDeadline(table);
      if (plan.kind === "bot" && plan.intent && plan.userId && (deadline == null || Date.now() < deadline)) {
        return applyAction(table, plan.userId, plan.intent);
      }
      return applyTimeout(table);
    },
    success: () => ({ ok: true }),
  };
}

function idleWarnRequest(tableId: string): MutationRequest {
  return {
    commandId: (_before, next) => `idle:${tableId}:${next.revision}`,
    kind: "idle",
    userId: null,
    storeEngineError: false,
    durableNoOp: false,
    fn: (table) => {
      if (table.closeReason != null || table.closingAt != null) return table;
      if (Date.now() < idleSince(table) + TABLE_IDLE_TIMEOUT_MS) return table;
      return beginIdleWarning(table, Date.now() + TABLE_IDLE_WARNING_MS);
    },
    success: () => ({ ok: true }),
  };
}

function idleCloseRequest(tableId: string): MutationRequest {
  return {
    commandId: (_before, next) => closeCommandId(tableId, "IDLE", next.revision),
    kind: "close",
    userId: null,
    storeEngineError: false,
    durableNoOp: false,
    fn: (table) => {
      if (table.closeReason != null || table.closingAt == null) return table;
      if (Date.now() > table.closingAt + IDLE_LATE_MS) return clearIdleWarning(table);
      if (Date.now() < table.closingAt) return table;
      return closeTable(table, "IDLE");
    },
    success: () => ({ ok: true }),
  };
}

function idleLateRequest(tableId: string): MutationRequest {
  return {
    commandId: (_before, next) => `idle-late:${tableId}:${next.revision}`,
    kind: "idle",
    userId: null,
    storeEngineError: false,
    durableNoOp: false,
    fn: (table) => clearIdleWarning(table),
    success: () => ({ ok: true }),
  };
}
