import type { Hono } from "hono";
import type { Env } from "../env";
import { signWsTicket } from "../auth/tokens";
import { requestIsSecure, wsCookie } from "./cookies";
import { authed } from "./guard";

export function registerWsTicket(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/ws-ticket", async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const config = c.get("config")!;
    const ticket = await signWsTicket(config.wsTicketSecret, gate.userId, gate.sessionId, gate.username);
    c.header("Set-Cookie", wsCookie(ticket, requestIsSecure(c.req.url)));
    return c.body(null, 204);
  });
}
