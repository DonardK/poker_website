/**
 * The mail module: the Resend request, its retry policy, the sink transport
 * (local development and production without a key), HTML escaping, and that
 * no token, code, password or full address ever reaches a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailConfig } from "../src/env";
import { notice, verifyEmail } from "../src/mail/templates";
import { deliverMail, resendRetry, type MailMessage } from "../src/mail/transport";
import { createHarness, PASSWORD, TERMS } from "./harness";

const RESEND: Extract<MailConfig, { transport: "resend" }> = {
  transport: "resend",
  apiKey: "re_test_key_123456",
  from: "Hold'em Live <security@example.com>",
  replyTo: "help@example.com",
};
const MESSAGE: MailMessage = {
  kind: "PASSWORD_RESET",
  to: "player@example.com",
  subject: "Reset your password | Hold'em Live",
  text: "text body",
  html: "<p>html body</p>",
  idempotencyKey: "PASSWORD_RESET:tok_123",
  userId: "user-1",
  devSecret: "https://example.com/reset-password#t=secret",
};
const SLOW = 90_000;

function reply(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const saved = { ...resendRetry, serverMs: [...resendRetry.serverMs] };
beforeEach(() => {
  resendRetry.conflictMs = 0;
  resendRetry.rateLimitMs = 0;
  resendRetry.serverMs = [0, 0];
});
afterEach(() => {
  Object.assign(resendRetry, saved);
  vi.restoreAllMocks();
});

describe("Resend transport", () => {
  it("sends the documented request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { id: "5f1f-uuid" }));
    expect(await deliverMail(RESEND, MESSAGE)).toEqual({ ok: true, id: "5f1f-uuid" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Authorization: "Bearer re_test_key_123456",
      "Content-Type": "application/json",
      "User-Agent": "poker-edge/1.0",
      "Idempotency-Key": "PASSWORD_RESET:tok_123",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Hold'em Live <security@example.com>",
      to: ["player@example.com"],
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
      reply_to: "help@example.com",
      tags: [{ name: "category", value: "password_reset" }],
    });
  });

  it("retries a 429 once and a 5xx twice with the same key; never a 401/422; a timeout counts as a failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(reply(429, { name: "rate_limit_exceeded" })).mockResolvedValueOnce(reply(200, { id: "a" }));
    expect((await deliverMail(RESEND, MESSAGE)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockReset();
    fetch.mockResolvedValue(reply(503));
    expect((await deliverMail(RESEND, MESSAGE)).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    const keys = fetch.mock.calls.map((call) => ((call[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(new Set(keys)).toEqual(new Set(["PASSWORD_RESET:tok_123"]));

    for (const [status, name] of [[422, "validation_error"], [401, "missing_api_key"], [429, "daily_quota_exceeded"], [409, "invalid_idempotent_request"]] as const) {
      fetch.mockReset();
      fetch.mockResolvedValue(reply(status, { name }));
      expect((await deliverMail(RESEND, MESSAGE)).ok, name).toBe(false);
      expect(fetch, name).toHaveBeenCalledTimes(1);
    }
    fetch.mockReset();
    fetch.mockResolvedValueOnce(reply(409, { name: "concurrent_idempotent_requests" })).mockResolvedValueOnce(reply(200, { id: "b" }));
    expect((await deliverMail(RESEND, MESSAGE)).ok).toBe(true);

    fetch.mockReset();
    fetch.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    expect((await deliverMail(RESEND, MESSAGE)).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    const lines = error.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('"mail":"FAILED"') && line.includes('"toDomain":"example.com"'))).toBe(true);
    expect(lines.join("\n")).not.toContain("player@example.com");
    expect(lines.join("\n")).not.toContain("#t=secret");
  });
});

describe("sink transport", () => {
  it("on http logs the link for local development; on https logs no link and email is reported off", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await deliverMail({ transport: "sink", exposeLinks: true }, MESSAGE);
    expect(log.mock.calls.some(([line]) => String(line).includes('"mail":"SINK"') && String(line).includes("#t=secret"))).toBe(true);
    await deliverMail({ transport: "sink", exposeLinks: false }, MESSAGE);
    const disabled = warn.mock.calls.map(([line]) => String(line)).find((line) => line.includes('"mail":"DISABLED"'))!;
    expect(disabled).toBeTruthy();
    expect(disabled).not.toContain("#t=");

    const origin = "https://poker-web.demo.workers.dev";
    const h = createHarness({ CLIENT_ORIGIN: origin }, { noMailbox: true });
    const config = await h.request("/auth/config", { method: "GET" });
    expect(config.body).toMatchObject({ emailEnabled: false, termsVersion: "2026-10-19", stepUpWindowMs: 300_000, passwordMinLength: 12 });
    const registered = await h.request("/auth/register", { baseUrl: origin, headers: { origin }, body: { ...TERMS, username: "Sink_Mail", email: "sink@example.com", password: PASSWORD } });
    expect(registered.status).toBe(201);
    const resend = await h.request("/account/email/verification", { baseUrl: origin, headers: { origin }, token: registered.body.accessToken, body: {} });
    expect([resend.status, resend.body.code, resend.body.retryable]).toEqual([503, "MAIL_UNAVAILABLE", false]);
    // forgot still answers 202 (no enumeration), and logs that mail is off.
    const forgot = await h.request("/auth/password/forgot", { baseUrl: origin, headers: { origin }, body: { email: "sink@example.com" } });
    expect(forgot.status).toBe(202);
    const all = [...log.mock.calls, ...warn.mock.calls].map(([line]) => String(line)).join("\n");
    expect(all).not.toMatch(/#t=[A-Za-z0-9_-]{43}/);
  }, SLOW);

  it("with Resend configured, /auth/config reports email on", async () => {
    const h = createHarness({ RESEND_API_KEY: "re_live_key_12345678", MAIL_FROM: "security@example.com" });
    expect((await h.request("/auth/config", { method: "GET" })).body.emailEnabled).toBe(true);
  });
});

describe("templates and logs", () => {
  it("escape every interpolated value", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const rendered = notice("NEW_SIGN_IN", { username: hostile, lockdownLink: "https://example.com/auth/not-me#t=abc\"><script>", device: hostile, country: "MT", ip: null });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(rendered.text).toContain(hostile);
    expect(verifyEmail({ username: "A&B", link: "https://example.com/verify-email#t=x" }).html).toContain("A&amp;B");
  });

  it("no token, code, password or full address appears in any log line of a recovery flow", async () => {
    const lines: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((line: unknown) => { lines.push(String(line)); });
    }
    const h = createHarness();
    const registered = await h.request("/auth/register", { body: { ...TERMS, username: "Quiet_Logs", email: "quiet@example.com", password: PASSWORD } });
    const verify = h.lastToken("VERIFY_EMAIL")!;
    await h.request("/auth/email/verify", { body: { token: verify } });
    await h.request("/auth/password/forgot", { body: { email: "quiet@example.com" } });
    const reset = h.lastToken("PASSWORD_RESET")!;
    await h.request("/auth/password/reset", { body: { token: reset, newPassword: "a new long passphrase" } });
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [verify, reset, PASSWORD, "a new long passphrase", "quiet@example.com", registered.body.accessToken]) {
      expect(text).not.toContain(secret);
    }
  }, SLOW);
});
