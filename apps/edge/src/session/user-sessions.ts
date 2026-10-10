import { DurableObject } from "cloudflare:workers";
import { prismaRuntime } from "../db/client";
import type { Env } from "../env";

void prismaRuntime;
import { logEvent } from "../game/log";
import type { LobbyActorRpc, RegisterConnection, RevokeSession, SessionDelivery, TableActorRpc, UnregisterConnection, NotifySession } from "./contract";
import { ensureTables } from "../actors/sql";

interface ConnRow extends Record<string, SqlStorageValue> {
  id: string;
  session_id: string;
  target: string;
}

/**
 * One object per user id. Remembers which table or lobby socket to wake
 * for a wallet patch, an idle notice, or a session revoke.
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

  override async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async register(input: RegisterConnection): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO conns (id, session_id, target, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, target = excluded.target",
      input.connId,
      input.sessionId,
      input.target,
      Date.now(),
    );
  }

  async unregister(input: UnregisterConnection): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM conns WHERE id = ?", input.connId);
  }

  async revoke(input: RevokeSession): Promise<void> {
    const rows = this.ctx.storage.sql.exec<ConnRow>(
      "SELECT id, session_id, target FROM conns WHERE session_id = ?",
      input.sessionId,
    ).toArray();
    for (const row of rows) {
      try {
        await this.disconnect(row.target, input.sessionId, input.reason);
      } catch (err) {
        logEvent("warn", "session revoke fanout failed", { target: row.target, name: err instanceof Error ? err.name : "error" });
      }
      this.ctx.storage.sql.exec("DELETE FROM conns WHERE id = ?", row.id);
    }
  }

  async notify(input: NotifySession): Promise<void> {
    const userId = this.ctx.id.name;
    if (!userId) return;
    const rows = input.sessionId
      ? this.ctx.storage.sql.exec<ConnRow>("SELECT id, session_id, target FROM conns WHERE session_id = ?", input.sessionId).toArray()
      : this.ctx.storage.sql.exec<ConnRow>("SELECT id, session_id, target FROM conns").toArray();
    const delivery: SessionDelivery = {
      userId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      event: input.event,
      payload: input.payload,
    };
    for (const row of rows) {
      try {
        await this.deliver(row.target, delivery);
      } catch (err) {
        logEvent("warn", "session notify fanout failed", { target: row.target, name: err instanceof Error ? err.name : "error" });
      }
    }
  }

  private async disconnect(target: string, sessionId: string, reason: RevokeSession["reason"]): Promise<void> {
    if (target === "lobby") {
      const lobby = this.env.LOBBY.getByName("lobby") as unknown as LobbyActorRpc;
      await lobby.disconnectSession(sessionId, reason);
      return;
    }
    if (target.startsWith("table:")) {
      const table = this.env.TABLES.getByName(target.slice("table:".length)) as unknown as TableActorRpc;
      await table.disconnectSession(sessionId, reason);
    }
  }

  private async deliver(target: string, input: SessionDelivery): Promise<void> {
    if (target === "lobby") {
      const lobby = this.env.LOBBY.getByName("lobby") as unknown as LobbyActorRpc;
      await lobby.deliver(input);
      return;
    }
    if (target.startsWith("table:")) {
      const table = this.env.TABLES.getByName(target.slice("table:".length)) as unknown as TableActorRpc;
      await table.deliver(input);
    }
  }
}
