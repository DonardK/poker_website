import { env, exports } from "cloudflare:workers";
import type { Env } from "../src/env";

/**
 * `wrangler types` fills Cloudflare.Env when vitest runs. `tsc` sees the empty
 * interface, so tests go through these casts. Bindings match wrangler.jsonc.
 */
export function workerEnv(): Env {
  return env as unknown as Env;
}

export function workerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const entry = exports as unknown as {
    default: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  };
  return entry.default.fetch(input, init);
}
