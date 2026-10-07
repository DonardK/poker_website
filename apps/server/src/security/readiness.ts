/**
 * Readiness state for GET /api/ready (routes/health.ts).
 *
 * Liveness (GET /api/health) says "the process is up" and never touches the
 * database, so a database outage does not make an orchestrator restart every
 * healthy process. Readiness says "send me traffic": the load balancer should
 * route players here only when
 * - the database answers `SELECT 1` (bounded by a timeout, result cached
 *   briefly so probes cannot hammer the database),
 * - the schema check (assertGameSchemaReady) passed at startup,
 * - table recovery (tableManager.recover) finished, so no table is served
 *   from a half-loaded state, and
 * - the process is not draining for shutdown (SIGTERM/SIGINT in index.ts).
 *
 * This module imports no configuration or database: the probe is injected.
 */

export type ReadinessReason = "database" | "schema" | "recovery" | "draining";

export interface ReadinessResult {
  ready: boolean;
  reasons: ReadinessReason[];
}

export interface ReadinessOptions {
  /** Resolves when the database answers; rejects otherwise. */
  probeDatabase: () => Promise<unknown>;
  /** Probe timeout (default 1500 ms): a hung connection counts as down. */
  timeoutMs?: number;
  /** How long a probe result is reused (default 2000 ms). */
  cacheMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

export interface Readiness {
  markSchemaReady(): void;
  markRecoveryFinished(): void;
  startDraining(): void;
  readonly draining: boolean;
  check(): Promise<ReadinessResult>;
}

export function createReadiness(options: ReadinessOptions): Readiness {
  const timeoutMs = options.timeoutMs ?? 1500;
  const cacheMs = options.cacheMs ?? 2000;
  const now = options.now ?? Date.now;
  let schemaReady = false;
  let recoveryFinished = false;
  let draining = false;
  let cached: { ok: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  const probe = (): Promise<boolean> => {
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.ok);
    // Concurrent probes share one database round trip.
    inFlight ??= new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      Promise.resolve().then(options.probeDatabase).then(() => resolve(true), () => resolve(false)).finally(() => clearTimeout(timer));
    }).then((ok) => { cached = { ok, at: now() }; inFlight = null; return ok; });
    return inFlight;
  };

  return {
    markSchemaReady() { schemaReady = true; },
    markRecoveryFinished() { recoveryFinished = true; },
    startDraining() { draining = true; },
    get draining() { return draining; },
    async check() {
      const reasons: ReadinessReason[] = [];
      // A draining process is never ready; skip the database round trip.
      if (draining) return { ready: false, reasons: ["draining"] };
      if (!(await probe())) reasons.push("database");
      if (!schemaReady) reasons.push("schema");
      if (!recoveryFinished) reasons.push("recovery");
      return { ready: reasons.length === 0, reasons };
    },
  };
}
