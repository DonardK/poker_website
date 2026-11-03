/**
 * One PaymentsContext per event (RPC call, webhook, alarm): the active
 * config, a fresh database client over HYPERDRIVE_PAYMENTS with the role
 * isolation check of its isolate, the provider adapters of the mode, and the
 * two hooks (kick the dispatcher, run work after the answer). close() waits
 * for the deferred work, then disconnects; callers hand it to waitUntil.
 */
import { errBrief, logWarn } from "../http/log";
import { readPaymentsConfig, type PaymentsActiveConfig, type PaymentsConfig } from "./config";
import type { PaymentsContext } from "./context";
import { assertRoleIsolation, openPaymentsDb } from "./db";
import type { PaymentsEnv } from "./env";
import { buildProviders } from "./providers/registry";

export interface Runtime {
  ctx: PaymentsContext;
  /** Waits for deferred work (bounded), then disconnects the client. Never throws. */
  close(): Promise<void>;
}

/** The config, or a PaymentsConfigError for a mode that must not run. */
export function paymentsConfig(env: PaymentsEnv): PaymentsConfig {
  return readPaymentsConfig(env);
}

export async function kickDispatcher(env: PaymentsEnv): Promise<void> {
  const namespace = env.PAYOUT_DISPATCHER;
  if (!namespace) return;
  try {
    await namespace.getByName("payouts", { locationHint: "weur" }).kick();
  } catch (error) {
    logWarn({ ...errBrief(error) }, "payout dispatcher kick failed; the cron retries");
  }
}

export async function openRuntime(env: PaymentsEnv, config: PaymentsActiveConfig, options: { now?: () => Date } = {}): Promise<Runtime> {
  const db = openPaymentsDb(env);
  const deferred: Promise<unknown>[] = [];
  const now = options.now ?? (() => new Date());
  const ctx: PaymentsContext = {
    db,
    config,
    providers: buildProviders(env, config, { now }),
    now,
    kick: () => kickDispatcher(env),
    defer: (work) => { deferred.push(work.catch((error: unknown) => logWarn({ ...errBrief(error) }, "deferred payments work failed"))); },
  };
  try {
    await assertRoleIsolation(db);
  } catch (error) {
    await db.$disconnect().catch(() => undefined);
    throw error;
  }
  return {
    ctx,
    async close() {
      // Deferred work may defer more (processing a webhook kicks the dispatcher); drain a few rounds.
      for (let round = 0; round < 3 && deferred.length > 0; round += 1) {
        const batch = deferred.splice(0, deferred.length);
        await Promise.allSettled(batch);
      }
      await db.$disconnect().catch(() => undefined);
    },
  };
}
