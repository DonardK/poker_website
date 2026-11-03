import { DurableObject } from "cloudflare:workers";
import { prismaRuntime } from "../../db/client";
import { errBrief, logError, logWarn } from "../../http/log";
import { PaymentsConfigError } from "../config";
import { retryConfirmedCredits, expireStaleDeposits } from "../deposits";
import { dispatchOne } from "../dispatch";
import type { PaymentsEnv } from "../env";
import { processDueEvents } from "../inbox";
import { drainOutbox } from "../notify";
import { runReconciliationStep } from "../reconcile";
import { openRuntime, paymentsConfig } from "../runtime";
import { applyPendingLockdowns } from "../security";
import { settleRequestedCancels } from "../withdrawals";
import type { PaymentsContext } from "../context";

void prismaRuntime;

/** Re-arm soon after a tick that found work, otherwise once a minute (the cron kicks too). */
const BUSY_DELAY_MS = 1_000;
const IDLE_DELAY_MS = 60_000;

type Task = { name: string; run: (ctx: PaymentsContext, env: PaymentsEnv) => Promise<boolean> };

/**
 * The sweeper's tasks, one per alarm in turn (design-wallet section 10.10):
 * each is a few indexed queries plus at most one provider call, so a tick
 * stays inside the Free plan's CPU budget.
 */
export const DISPATCHER_TASKS: readonly Task[] = Object.freeze([
  { name: "lockdowns", run: async (ctx) => (await applyPendingLockdowns(ctx, 3)) > 0 },
  { name: "cancels", run: async (ctx) => (await settleRequestedCancels(ctx, { limit: 3 })) > 0 },
  { name: "events", run: async (ctx) => (await processDueEvents(ctx, 5)) > 0 },
  { name: "dispatch", run: (ctx) => dispatchOne(ctx) },
  { name: "credits", run: async (ctx) => (await retryConfirmedCredits(ctx, 3)) > 0 },
  { name: "deposits", run: async (ctx) => (await expireStaleDeposits(ctx, 3)) > 0 },
  { name: "outbox", run: async (ctx, env) => (await drainOutbox(ctx.db, env, ctx.config, ctx.now(), 3)) > 0 },
  { name: "reconcile", run: (ctx) => runReconciliationStep(ctx) },
]);

/**
 * The PayoutDispatcher singleton ("payouts", location hint weur): payout
 * dispatch, the webhook inbox and email outbox sweeps, deposit expiry, the
 * confirmed-credit retry and the daily reconciliation. Kicked after every
 * commit that queues work and by the poker-payments cron every minute; its
 * alarm does one unit of work per invocation. Postgres is the only state that
 * matters (the outbox rows); this object stores just the round-robin cursor.
 */
export class PayoutDispatcher extends DurableObject<PaymentsEnv> {
  /** Wake now unless an alarm is already due within a second. */
  async kick(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > Date.now() + BUSY_DELAY_MS) await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    let config;
    try {
      config = paymentsConfig(this.env);
    } catch (error) {
      if (error instanceof PaymentsConfigError) logError({ alert: "PAYMENTS_CONFIG", problems: error.problems.join("; ").slice(0, 500) }, "payments configuration refused; dispatcher idle");
      return;
    }
    // Mode off: nothing may move. The cron does not kick in that mode; stay idle.
    if (config.mode === "off") return;
    let busy = false;
    try {
      const runtime = await openRuntime(this.env, config);
      try {
        const start = (await this.ctx.storage.get<number>("cursor")) ?? 0;
        for (let i = 0; i < DISPATCHER_TASKS.length; i += 1) {
          const index = (start + i) % DISPATCHER_TASKS.length;
          const task = DISPATCHER_TASKS[index]!;
          let did = false;
          try {
            did = await task.run(runtime.ctx, this.env);
          } catch (error) {
            logWarn({ task: task.name, ...errBrief(error) }, "payments sweep task failed; it runs again next tick");
          }
          if (did) {
            busy = true;
            await this.ctx.storage.put("cursor", (index + 1) % DISPATCHER_TASKS.length);
            break;
          }
        }
      } finally {
        await runtime.close();
      }
    } catch (error) {
      logWarn({ ...errBrief(error) }, "payout dispatcher tick failed");
    }
    await this.ctx.storage.setAlarm(Date.now() + (busy ? BUSY_DELAY_MS : IDLE_DELAY_MS));
  }
}
