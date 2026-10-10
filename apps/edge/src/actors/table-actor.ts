import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { ensureTables } from "./sql";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    result TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
] as const;

/**
 * One object per Postgres table id. WP1 only creates the SQLite schema and
 * hibernates. Poker play arrives in WP3, which replaces this class body.
 */
export class TableActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureTables(this.ctx.storage.sql, TABLES);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    return acceptAndClose(this.ctx, request);
  }
}

export function acceptAndClose(ctx: DurableObjectState, request: Request): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server);
  server.close(1011, "error");
  return new Response(null, { status: 101, webSocket: client });
}
