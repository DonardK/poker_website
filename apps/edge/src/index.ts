import { Hono } from "hono";
import type { Env } from "./env";
import { prismaRuntime } from "./db/client";
import { health, ready } from "./health";
import { mountHttp } from "./http/app";

void prismaRuntime;

const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"] as const;

function locationHint(value: string): DurableObjectLocationHint {
  if ((LOCATION_HINTS as readonly string[]).includes(value)) return value as DurableObjectLocationHint;
  throw new Error("TABLE_DO_LOCATION_HINT is not a Durable Object location hint");
}

const app = new Hono<{ Bindings: Env }>();

mountHttp(app);

app.get("/api/health", health);
app.get("/api/ready", ready);

app.all("/ws/lobby", (c) => {
  const stub = c.env.LOBBY.getByName("lobby");
  return stub.fetch(c.req.raw);
});

app.all("/ws/table/:id", (c) => {
  const tableId = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tableId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const stub = c.env.TABLES.getByName(tableId, { locationHint: locationHint(c.env.TABLE_DO_LOCATION_HINT) });
  return stub.fetch(c.req.raw);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export { TableActor } from "./actors/table-actor";
export { LobbyActor } from "./actors/lobby-actor";
export { UserSessions } from "./actors/user-sessions";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
