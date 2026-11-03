import { DurableObject } from "cloudflare:workers";
import { readPaymentsConfig } from "../config";
import type { PaymentsEnv } from "../env";

/** Entries older than this are dropped by the object's own alarm (sandbox state is disposable). */
const RETENTION_MS = 30 * 86_400_000;

/**
 * The built-in sandbox provider's own state (design-payments section 12):
 * sandbox payments, disputes, payouts and applicants, as JSON values in the
 * object's storage, never in the payments database. One instance
 * ("sandbox"). It refuses to work unless PAYMENTS_MODE=sandbox outside
 * production, so even a misrouted call in production cannot fake a provider.
 */
export class SandboxPsp extends DurableObject<PaymentsEnv> {
  private allowed(): void {
    const config = readPaymentsConfig(this.env);
    if (config.mode !== "sandbox" || config.environment === "production") throw new Error("the sandbox provider is disabled here");
  }

  async read(key: string): Promise<unknown> {
    this.allowed();
    const entry = await this.ctx.storage.get<{ v: unknown }>(key);
    return entry ? entry.v : null;
  }

  async write(key: string, value: unknown): Promise<void> {
    this.allowed();
    await this.ctx.storage.put(key, { v: value, at: Date.now() });
    await this.armCleanup();
  }

  /** Atomic within the object (input gates): the first writer wins. */
  async writeIfAbsent(key: string, value: unknown): Promise<unknown> {
    this.allowed();
    const entry = await this.ctx.storage.get<{ v: unknown }>(key);
    if (entry) return entry.v;
    await this.ctx.storage.put(key, { v: value, at: Date.now() });
    await this.armCleanup();
    return value;
  }

  async increment(key: string): Promise<number> {
    this.allowed();
    const entry = await this.ctx.storage.get<{ v: number }>(key);
    const next = (entry?.v ?? 0) + 1;
    await this.ctx.storage.put(key, { v: next, at: Date.now() });
    return next;
  }

  /** SANDBOX_CONTROLS_ENABLED only (checked by the caller): forget everything. */
  async reset(): Promise<void> {
    this.allowed();
    await this.ctx.storage.deleteAll();
  }

  private async armCleanup(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }

  override async alarm(): Promise<void> {
    const cutoff = Date.now() - RETENTION_MS;
    const entries = await this.ctx.storage.list<{ at?: number }>({ limit: 500 });
    const stale = [...entries].filter(([, value]) => typeof value?.at === "number" && value.at < cutoff).map(([key]) => key);
    if (stale.length > 0) await this.ctx.storage.delete(stale.slice(0, 128));
    if (entries.size > 0) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}
