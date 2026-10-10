import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { acceptAndClose } from "./table-actor";
import { ensureTables } from "./sql";

/**
 * The single lobby object. WP1 hibernates. WP4 owns the snapshot and patch fanout
 * and replaces this class body. The lobby does not store table ciphertext.
 */
export class LobbyActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureTables(ctx.storage.sql, [
        `CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`,
      ]);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    return acceptAndClose(this.ctx, request);
  }
}
