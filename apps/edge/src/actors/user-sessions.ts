import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { acceptAndClose } from "./table-actor";
import { ensureTables } from "./sql";

/**
 * One object per user id. WP1 creates the connection table and hibernates.
 * WP3 replaces this class body with register / revoke / notify.
 */
export class UserSessions extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureTables(ctx.storage.sql, [
        `CREATE TABLE IF NOT EXISTS conns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          target TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      ]);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    return acceptAndClose(this.ctx, request);
  }
}
