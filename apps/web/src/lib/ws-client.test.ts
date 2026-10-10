import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTH_TIMEOUT_MS,
  BACKOFF_STEPS_MS,
  PING_INTERVAL_MS,
  WsConnection,
  backoffDelayMs,
  httpOriginFromSocketUrl,
  interpretRenewReplies,
  lobbySocketUrl,
  tableSocketUrl,
  withCommandId,
  wsBaseFromSocketUrl,
  type SocketFactory,
  type SocketLike,
} from "./ws-client";

interface Timer {
  id: number;
  ms: number;
  fn: () => void;
  cleared: boolean;
  kind: "timeout" | "interval";
}

let events: string[] = [];
let timers: Timer[] = [];
let nextTimerId = 1;

class FakeSocket implements SocketLike {
  static created: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  url: string;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;

  constructor(url: string) {
    if (url.includes("?") || url.includes("secret-token") || url.includes("refreshed-token")) {
      throw new Error(`credential leaked into the socket url: ${url}`);
    }
    this.url = url;
    FakeSocket.created.push(this);
    events.push(`ws:${url}`);
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  serverClose(code: number): void {
    this.close(code);
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function clock() {
  timers = [];
  nextTimerId = 1;
  return {
    setTimeout(fn: () => void, ms: number) {
      const id = nextTimerId++;
      timers.push({ id, ms, fn, cleared: false, kind: "timeout" });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
      const timer = timers.find((item) => item.id === (handle as unknown as number));
      if (timer) timer.cleared = true;
    },
    setInterval(fn: () => void, ms: number) {
      const id = nextTimerId++;
      timers.push({ id, ms, fn, cleared: false, kind: "interval" });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle: ReturnType<typeof setInterval>) {
      const timer = timers.find((item) => item.id === (handle as unknown as number));
      if (timer) timer.cleared = true;
    },
  };
}

function fireTimeout(ms: number): void {
  const due = timers.filter((timer) => !timer.cleared && timer.kind === "timeout" && timer.ms === ms);
  for (const timer of due) timer.cleared = true;
  for (const timer of due) timer.fn();
}

function pendingTimeouts(): number[] {
  return timers.filter((timer) => !timer.cleared && timer.kind === "timeout").map((timer) => timer.ms);
}

interface FetchCall {
  url: string;
  authorization: string;
  credentials: RequestCredentials | undefined;
}

function harness(options?: {
  statuses?: number[];
  refresh?: () => Promise<{ accessToken: string }>;
  lobbyHello?: boolean;
}) {
  events = [];
  FakeSocket.created = [];
  const fetches: FetchCall[] = [];
  const statuses = [...(options?.statuses ?? [204])];
  let token = "secret-token";
  let refreshes = 0;
  const conn = new WsConnection({
    url: "ws://127.0.0.1:4107/ws/lobby",
    ticketUrl: "http://127.0.0.1:4107/api/ws-ticket",
    getToken: () => token,
    setToken: (next) => { token = next; },
    refreshSession: options?.refresh ?? (async () => {
      refreshes += 1;
      return { accessToken: "refreshed-token" };
    }),
    lobbyHello: options?.lobbyHello ?? false,
    random: () => 1,
    WebSocket: FakeSocket as unknown as SocketFactory,
    fetch: async (url, init) => {
      events.push("ticket");
      const headers = init?.headers as { Authorization?: string } | undefined;
      fetches.push({
        url: String(url),
        authorization: headers?.Authorization ?? "",
        credentials: init?.credentials,
      });
      const status = statuses.length > 0 ? statuses.shift() ?? 204 : 204;
      return new Response(null, { status });
    },
    visibilityState: () => "visible",
    ...clock(),
  });
  return {
    conn,
    fetches,
    get token() { return token; },
    get refreshes() { return refreshes; },
  };
}

const authOk = { v: 1, type: "AUTH_OK", payload: { userId: "u", username: "player", activeTableId: null } };

async function connectAuthed(env = harness()) {
  env.conn.connect();
  await settle();
  const ws = FakeSocket.created.at(-1);
  assert.ok(ws);
  ws.receive(authOk);
  return { ...env, ws };
}

describe("backoffDelayMs", () => {
  it("uses 500, 1000, 2000, 4000, 8000, then 15000, full jitter", () => {
    assert.deepEqual(BACKOFF_STEPS_MS, [500, 1_000, 2_000, 4_000, 8_000, 15_000]);
    const full = BACKOFF_STEPS_MS.map((_, attempt) => backoffDelayMs(attempt, () => 1));
    assert.deepEqual(full, [500, 1_000, 2_000, 4_000, 8_000, 15_000]);
    assert.equal(backoffDelayMs(6, () => 1), 15_000);
    assert.equal(backoffDelayMs(2, () => 0), 0);
    assert.equal(backoffDelayMs(1, () => 0.5), 500);
  });
});

describe("socket urls", () => {
  it("derives ws and http origins and never keeps a query", () => {
    assert.equal(wsBaseFromSocketUrl("http://127.0.0.1:4107"), "ws://127.0.0.1:4107");
    assert.equal(httpOriginFromSocketUrl("http://127.0.0.1:4107"), "http://127.0.0.1:4107");
    assert.equal(wsBaseFromSocketUrl("https://play.example/socket.io?token=no"), "wss://play.example");
    assert.equal(httpOriginFromSocketUrl("wss://play.example"), "https://play.example");
    assert.equal(lobbySocketUrl("http://127.0.0.1:4107"), "ws://127.0.0.1:4107/ws/lobby");
    assert.equal(tableSocketUrl("https://play.example", "fixture-table"), "wss://play.example/ws/table/fixture-table");
    assert.equal(tableSocketUrl("https://play.example", "a/b"), "wss://play.example/ws/table/a%2Fb");
  });
});

describe("WsConnection reconnect", () => {
  it("fetches a ticket before every open and backs off until AUTH_OK resets the schedule", async () => {
    const env = harness();
    env.conn.connect();
    await settle();
    assert.deepEqual(events, ["ticket", "ws:ws://127.0.0.1:4107/ws/lobby"]);
    assert.equal(env.fetches[0]?.url, "http://127.0.0.1:4107/api/ws-ticket");
    assert.equal(env.fetches[0]?.authorization, "Bearer secret-token");
    assert.equal(env.fetches[0]?.credentials, "include");
    assert.equal(env.conn.connected, false);

    FakeSocket.created[0]?.serverClose(1011);
    assert.equal(env.conn.active, true);
    assert.deepEqual(pendingTimeouts().filter((ms) => ms !== AUTH_TIMEOUT_MS), [500]);

    fireTimeout(500);
    await settle();
    FakeSocket.created[1]?.serverClose(1011);
    assert.ok(pendingTimeouts().includes(1_000));

    fireTimeout(1_000);
    await settle();
    FakeSocket.created[2]?.receive(authOk);
    assert.equal(env.conn.connected, true);
    FakeSocket.created[2]?.serverClose(1011);
    assert.ok(pendingTimeouts().includes(500));
    assert.equal(pendingTimeouts().includes(2_000), false);
    assert.deepEqual(events.filter((event) => event === "ticket").length, 3);
    assert.equal(events.filter((event) => event.startsWith("ws:")).length, 3);
    assert.ok(events.indexOf("ticket") < events.indexOf("ws:ws://127.0.0.1:4107/ws/lobby"));
  });

  it("does not reconnect after 4002", async () => {
    const { conn, ws } = await connectAuthed();
    const errors: string[] = [];
    const reasons: string[] = [];
    conn.on("connect_error", (error) => errors.push(error.message));
    conn.on("disconnect", (reason) => reasons.push(reason));
    ws.serverClose(4002);
    assert.equal(conn.connected, false);
    assert.equal(conn.active, false);
    assert.equal(conn.fatalClose, true);
    assert.deepEqual(reasons, ["io server disconnect"]);
    assert.deepEqual(errors, []);
    assert.equal(pendingTimeouts().some((ms) => ms === 500 || ms === 1_000), false);
  });

  it("reconnects immediately when the tab becomes visible and resets the backoff", async () => {
    const env = harness();
    env.conn.connect();
    await settle();
    FakeSocket.created[0]?.serverClose(1011);
    assert.ok(pendingTimeouts().includes(500));
    env.conn.noteVisibility("hidden");
    env.conn.noteVisibility("visible");
    await settle();
    assert.equal(FakeSocket.created.length, 2);
    assert.equal(pendingTimeouts().includes(500), false);
    FakeSocket.created[1]?.serverClose(1011);
    assert.ok(pendingTimeouts().includes(500));
    assert.equal(pendingTimeouts().includes(1_000), false);
  });
});

describe("ticket fetch", () => {
  it("refreshes once after a 401 and retries the ticket before opening", async () => {
    const env = harness({ statuses: [401, 204] });
    env.conn.connect();
    await settle();
    assert.equal(env.refreshes, 1);
    assert.equal(env.token, "refreshed-token");
    assert.equal(env.fetches[1]?.authorization, "Bearer refreshed-token");
    assert.equal(FakeSocket.created.length, 1);
    assert.equal(events[0], "ticket");
    assert.equal(events[1], "ticket");
    assert.equal(events[2], "ws:ws://127.0.0.1:4107/ws/lobby");
  });

  it("stops when the ticket is still unauthorized after a refresh", async () => {
    const env = harness({ statuses: [401, 401] });
    const errors: string[] = [];
    env.conn.on("connect_error", (error) => errors.push(error.message));
    env.conn.connect();
    await settle();
    assert.deepEqual(errors, ["Unauthorized"]);
    assert.equal(env.conn.active, false);
    assert.equal(FakeSocket.created.length, 0);
    assert.equal(pendingTimeouts().some((ms) => ms < AUTH_TIMEOUT_MS), false);
  });
});

describe("ack correlation", () => {
  it("resolves each ack by id, ignores a duplicate, and rejects on timeout", async () => {
    const { conn, ws } = await connectAuthed();
    const first = conn.request("ACTION_INTENT", { n: 1 }, 5_000);
    const second = conn.request("SEAT_CLAIM", { n: 2 }, 5_000);
    const frames = ws.sent.map((text) => JSON.parse(text) as { id: string; type: string; payload: { n: number } });
    assert.equal(frames[0]?.type, "ACTION_INTENT");
    assert.equal(frames[1]?.type, "SEAT_CLAIM");
    assert.notEqual(frames[0]?.id, frames[1]?.id);
    ws.receive({ v: 1, id: frames[1]?.id, type: "ACK", payload: { ok: true, duplicate: true } });
    ws.receive({ v: 1, id: frames[0]?.id, type: "ACK", payload: { ok: true } });
    ws.receive({ v: 1, id: frames[0]?.id, type: "ACK", payload: { ok: false, code: "ILLEGAL", message: "late" } });
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await second, { ok: true, duplicate: true });

    const timed = conn.request("STAND_UP", { tableId: "t" }, 40);
    const rejected = assert.rejects(timed, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "operation has timed out");
      return true;
    });
    fireTimeout(40);
    await rejected;
    const stand = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };
    ws.receive({ v: 1, id: stand.id, type: "ACK", payload: { ok: true } });
  });

  it("delivers SERVER_ERROR to listeners and settles the promise only from ACK", async () => {
    const { conn, ws } = await connectAuthed();
    const seen: unknown[] = [];
    conn.on("frame", (frame) => { if (frame.type === "SERVER_ERROR") seen.push(frame.payload); });
    const pending = conn.request("SEAT_CLAIM", { tableId: "t" }, 5_000);
    const sent = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string };
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    ws.receive({ v: 1, id: sent.id, type: "SERVER_ERROR", payload: { code: "SEAT_TAKEN", message: "That seat was just taken." } });
    await settle();
    assert.equal(settled, false);
    assert.deepEqual(seen, [{ code: "SEAT_TAKEN", message: "That seat was just taken." }]);
    ws.receive({ v: 1, id: sent.id, type: "ACK", payload: { ok: false, code: "SEAT_TAKEN", message: "That seat was just taken." } });
    assert.deepEqual(await pending, { ok: false, code: "SEAT_TAKEN", message: "That seat was just taken." });
  });
});

describe("SESSION_RENEW", () => {
  it("acks in place and does not close the socket or fetch another ticket", async () => {
    const env = harness();
    const { conn, ws } = await connectAuthed(env);
    const tickets = events.filter((event) => event === "ticket").length;
    const pending = conn.request("SESSION_RENEW", { token: "browser-fixture-token-2" }, 5_000);
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { v: number; id: string; type: string; payload: { token: string } };
    assert.equal(frame.v, 1);
    assert.equal(frame.type, "SESSION_RENEW");
    assert.equal(frame.payload.token, "browser-fixture-token-2");
    assert.equal(typeof frame.id, "string");
    ws.receive({ v: 1, id: frame.id, type: "ACK", payload: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
    assert.equal(ws.readyState, 1);
    assert.equal(conn.connected, true);
    assert.equal(FakeSocket.created.length, 1);
    assert.equal(events.filter((event) => event === "ticket").length, tickets);
  });

  it("returns an unauthorized ack without the client closing the socket", async () => {
    const { conn, ws } = await connectAuthed();
    const pending = conn.request("SESSION_RENEW", { token: "other" }, 5_000);
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string };
    ws.receive({ v: 1, id: frame.id, type: "ACK", payload: { ok: false, code: "UNAUTHORIZED", message: "Session expired" } });
    assert.deepEqual(await pending, { ok: false, code: "UNAUTHORIZED", message: "Session expired" });
    assert.equal(ws.readyState, 1);
    assert.equal(conn.active, true);
    assert.equal(conn.fatalClose, false);
  });
});

describe("command ids and renew replies", () => {
  it("adds a command id only when sit, stand, or keep-alive omitted one", () => {
    const stamped = withCommandId("STAND_UP", { tableId: "t" }) as { commandId: string; tableId: string };
    assert.equal(stamped.tableId, "t");
    assert.match(stamped.commandId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(withCommandId("SIT_IN", { tableId: "t", commandId: "keep-me" }), { tableId: "t", commandId: "keep-me" });
    assert.deepEqual(withCommandId("ACTION_INTENT", { tableId: "t" }), { tableId: "t" });
    const filled = withCommandId("TABLE_KEEP_ALIVE", { tableId: "t", commandId: "" }) as { commandId: string };
    assert.match(filled.commandId, /^[0-9a-f-]{36}$/i);
  });

  it("keeps a retryable SESSION_RENEW up and reconnects other failures", () => {
    assert.equal(interpretRenewReplies([{ ok: true }, { ok: true }]), "renewed");
    assert.equal(interpretRenewReplies([
      { ok: true },
      { ok: false, code: "UNAUTHORIZED", message: "no" },
    ]), "unauthorized");
    assert.equal(interpretRenewReplies([
      { ok: false, code: "SERVICE_UNAVAILABLE", message: "busy", retryable: true },
    ]), "stay");
    assert.equal(interpretRenewReplies([
      { ok: false, code: "INVALID_REQUEST", message: "no" },
    ]), "reconnect");
  });
});

describe("keepalive ping", () => {
  it("sends the literal ping only while visible", async () => {
    const { conn, ws } = await connectAuthed();
    const interval = timers.find((timer) => !timer.cleared && timer.kind === "interval");
    assert.equal(interval?.ms, PING_INTERVAL_MS);
    interval?.fn();
    assert.equal(ws.sent.at(-1), "ping");
    conn.noteVisibility("hidden");
    assert.equal(timers.some((timer) => !timer.cleared && timer.kind === "interval"), false);
  });
});
