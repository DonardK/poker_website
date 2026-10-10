import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns 200 without a database", async () => {
    const response = await exports.default.fetch("http://example.com/api/health");
    expect(response.status).toBe(200);
    const body = await response.json() as { ok?: boolean; service?: string; timestamp?: string; redis?: unknown };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("poker-edge");
    expect(body.redis).toBeUndefined();
    expect(typeof body.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(body.timestamp ?? ""))).toBe(false);
  });
});
