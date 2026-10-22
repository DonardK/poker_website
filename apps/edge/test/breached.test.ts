/**
 * Have I Been Pwned range check (k-anonymity, fail-open) and its use at
 * registration. fetch is stubbed: tests never reach the real API.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { breach } from "../src/auth/breached";
import { createHarness, PASSWORD, TERMS } from "./harness";

const SLOW = 90_000;

async function sha1Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("breached passwords", () => {
  it("sends only the 5-character prefix with Add-Padding and reads the matching suffix", async () => {
    const hash = await sha1Hex("password123456");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${hash.slice(5)}:2413\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n`,
      { status: 200 },
    ));
    expect(await breach.check("password123456")).toBe("breached");
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(init.headers).toMatchObject({ "Add-Padding": "true", "User-Agent": "poker-edge/1.0" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(url).not.toContain(hash.slice(5));
  });

  it("ignores padding lines (count 0) and answers unknown on an error or a timeout", async () => {
    const hash = await sha1Hex("a perfectly fine passphrase");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`${hash.slice(5)}:0\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3\r\n`, { status: 200 }));
    expect(await breach.check("a perfectly fine passphrase")).toBe("ok");
    fetch.mockResolvedValue(new Response("oops", { status: 500 }));
    expect(await breach.check("a perfectly fine passphrase")).toBe("unknown");
    fetch.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await breach.check("a perfectly fine passphrase")).toBe("unknown");
  });

  it("registration refuses a breached password, allows one when the check is down (logged), and skips it when off", async () => {
    const warn = vi.spyOn(console, "warn");
    const check = vi.spyOn(breach, "check").mockResolvedValue("breached");
    const on = createHarness({ PASSWORD_BREACH_CHECK: "true" });
    const refused = await on.request("/auth/register", { body: { ...TERMS, username: "Pwned_One", email: "pwned@example.com", password: PASSWORD } });
    expect([refused.status, refused.body.code]).toEqual([400, "PASSWORD_BREACHED"]);
    expect(on.db.users.size).toBe(0);

    check.mockResolvedValue("unknown");
    const allowed = await on.request("/auth/register", { body: { ...TERMS, username: "Pwned_Two", email: "pwned2@example.com", password: PASSWORD } });
    expect(allowed.status).toBe(201);
    expect(warn.mock.calls.some(([line]) => String(line).includes("BREACH_CHECK_UNAVAILABLE"))).toBe(true);

    check.mockClear();
    const off = createHarness();
    expect(off.config.passwordBreachCheck).toBe(false);
    expect((await off.request("/auth/register", { body: { ...TERMS, username: "Pwned_Three", email: "pwned3@example.com", password: PASSWORD } })).status).toBe(201);
    expect(check).not.toHaveBeenCalled();
  }, SLOW);

  it("a password containing the username is weak (case-insensitive)", async () => {
    const h = createHarness();
    const response = await h.request("/auth/register", { body: { ...TERMS, username: "Mallory", email: "mallory@example.com", password: "i am MALLORY forever" } });
    expect([response.status, response.body.code]).toEqual([400, "PASSWORD_WEAK"]);
  }, SLOW);
});
