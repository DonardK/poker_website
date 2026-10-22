/**
 * Rate-limit wiring for the account-security routes: every route that checks
 * a credential uses RL_CREDENTIALS (by IP), every route that sends email uses
 * RL_EMAIL (by user, else IP), and the limit answers before the body is read.
 */
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness";
import { signUp } from "./support/accounts";

function limiter(blocked: boolean, seen: string[]) {
  return { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: !blocked }; } };
}

const CREDENTIAL_ROUTES = [
  "/auth/login", "/auth/register", "/auth/login/mfa", "/auth/passkey/login", "/auth/password/forgot", "/auth/password/reset",
  "/auth/email/verify", "/auth/email/change/confirm", "/auth/security/lockdown", "/auth/reauth/password", "/auth/reauth/mfa",
  "/auth/reauth/passkey", "/auth/step-up", "/account/2fa/totp/enable",
];
const EMAIL_ROUTES = ["/auth/password/forgot", "/account/email", "/account/email/verification", "/auth/step-up/email-code"];

describe("rate limits", () => {
  it("RL_CREDENTIALS covers every credential-checking POST, keyed by IP", async () => {
    const seen: string[] = [];
    const h = createHarness({ RL_CREDENTIALS: limiter(true, seen) } as unknown as Record<string, string>);
    for (const path of CREDENTIAL_ROUTES) {
      const response = await h.request(path, { ip: "203.0.113.4", body: {} });
      expect(response.status, path).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
    }
    expect(new Set(seen)).toEqual(new Set(["ip:203.0.113.4"]));
    expect((await h.request("/auth/config", { method: "GET" })).status).toBe(200);
    expect((await h.request("/auth/passkey/options", { body: {} })).status).not.toBe(429);
  });

  it("RL_EMAIL covers every email-sending POST, keyed by the signed-in user", async () => {
    const seen: string[] = [];
    const h = createHarness({ RL_EMAIL: limiter(true, seen) } as unknown as Record<string, string>);
    for (const path of EMAIL_ROUTES) {
      expect((await h.request(path, { ip: "203.0.113.5", body: {} })).status, path).toBe(429);
    }
    expect(new Set(seen)).toEqual(new Set(["ip:203.0.113.5"]));
    expect((await h.request("/auth/login", { body: { identifier: "nobody_here", password: "wrong password!!" } })).status).toBe(401);

    const open = createHarness({ RL_EMAIL: limiter(false, seen) } as unknown as Record<string, string>);
    const account = await signUp(open, "Rate_Limited");
    seen.length = 0;
    await open.request("/account/email/verification", { token: account.accessToken, body: {} });
    expect(seen).toEqual([`user:${account.userId}`]);
  }, 90_000);
});
