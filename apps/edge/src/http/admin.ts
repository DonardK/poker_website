import type { Hono } from "hono";
import type { Env } from "../env";
import { accessJwtValid, accessSettings } from "../auth/access";
import { authed, type Ctx } from "./guard";
import { errBrief, logError, logWarn } from "./log";
import { readRegulatorAudit } from "./tables";

export function registerAdmin(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/admin/hands/:handUuid/audit", async (c) => {
    const access = await requireAccess(c);
    if (access) return access;
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const user = await c.get("db")!.user.findUnique({ where: { id: gate.userId }, select: { role: true } });
    if (user?.role !== "ADMIN") {
      logWarn({ security: "ADMIN_DENIED", userId: gate.userId, method: c.req.method, path: new URL(c.req.url).pathname.slice(0, 200) }, "admin route denied");
      return c.json({ error: "Forbidden" }, 403);
    }
    return readRegulatorAudit(c, gate.userId);
  });
}

async function requireAccess(c: Ctx): Promise<Response | null> {
  let settings: ReturnType<typeof accessSettings>;
  try {
    settings = accessSettings(c.env);
  } catch (err) {
    logError({ ...errBrief(err) }, "Cloudflare Access is misconfigured");
    return c.json({ error: "Request could not be completed" }, 500);
  }
  if (!settings) return null;
  const assertion = c.req.header("Cf-Access-Jwt-Assertion") ?? "";
  if (!await accessJwtValid(assertion, settings)) return c.json({ error: "Unauthorized" }, 401);
  return null;
}
