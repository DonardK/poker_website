import type { Ctx } from "./guard";
import { errBrief, logWarn } from "./log";

/**
 * Run work after the response (waitUntil). Failures are logged, never thrown.
 * Without an execution context (unit tests), the guarded promise is returned
 * so the caller's `await` finishes the work before the response.
 *
 * Deferred work must not touch the database: the request's Prisma client is
 * disconnected once the response is sent (app.ts).
 */
export function defer(c: Ctx, task: Promise<unknown>): Promise<void> {
  const guarded = task.then(
    () => undefined,
    (err: unknown) => logWarn({ ...errBrief(err), path: new URL(c.req.url).pathname.slice(0, 200) }, "deferred task failed"),
  );
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(guarded);
    return Promise.resolve();
  }
  return guarded;
}
