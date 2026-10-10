import type { Context } from "hono";
import type { Env } from "./env";

type EdgeContext = Context<{ Bindings: Env }>;

/** No database. The redis field from the Node health payload is omitted. */
export function health(c: EdgeContext): Response {
  return c.json(
    { ok: true, service: "poker-edge", timestamp: new Date().toISOString() },
    200,
    { "Cache-Control": "no-store" },
  );
}

/** SELECT 1 through Hyperdrive. 200 when Postgres answers, 503 otherwise. */
export async function ready(c: EdgeContext): Promise<Response> {
  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    return c.json({ ready: false, reasons: ["database"] }, 503, { "Cache-Control": "no-store" });
  }
  const { createPrisma } = await import("./db/client");
  const prisma = createPrisma(connectionString);
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({ ready: true }, 200, { "Cache-Control": "no-store" });
  } catch {
    return c.json({ ready: false, reasons: ["database"] }, 503, { "Cache-Control": "no-store" });
  } finally {
    c.executionCtx.waitUntil(prisma.$disconnect().catch(() => undefined));
  }
}
