import { describe, expect, it } from "vitest";
import { workerFetch } from "./worker-bindings";

// The first request evaluates the whole Worker module graph (every route, the
// Prisma client). With the full suite running in parallel on a laptop that
// cold start alone can pass Vitest's 5 s default, so this test allows 30 s.
const COLD_START_MS = 30_000;

describe("GET /api/health", () => {
  it("returns 200 without a database", async () => {
    const response = await workerFetch("http://example.com/api/health");
    expect(response.status).toBe(200);
    const body = await response.json() as { ok?: boolean; service?: string; timestamp?: string; redis?: unknown };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("poker-edge");
    expect(body.redis).toBeUndefined();
    expect(typeof body.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(body.timestamp ?? ""))).toBe(false);
  }, COLD_START_MS);
});
