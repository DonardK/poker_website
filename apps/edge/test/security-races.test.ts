/**
 * Guess limits under parallel requests. The in-memory database's hold()
 * makes every request read its row before any of them writes, which is the
 * interleaving a check-then-count would lose to on Postgres. Each attempt is
 * counted before its code is checked, so the caps hold anyway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieJar, createHarness, PASSWORD, type ApiResult } from "./harness";
import { enableTotp, setStepUp, signUp } from "./support/accounts";

const SLOW = 120_000;
const BIND = "a".repeat(64);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tally(results: ApiResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const result of results) {
    const key = `${result.status}:${result.body?.code ?? ""}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

describe("parallel guesses", () => {
  it("emailed step-up code: 20 parallel wrong codes get at most the 5 attempts", async () => {
    const h = createHarness();
    const acct = await signUp(h, "Race_Mail", { verified: true });
    const sent = await h.request("/auth/step-up/email-code", { token: acct.accessToken, body: { purpose: "withdrawal", bind: BIND } });
    expect(sent.status).toBe(202);
    const real = /is (\d{6})/.exec(h.mails.at(-1)!.text)![1]!;
    const wrong = (i: number) => String((Number(real) + 1 + i) % 1_000_000).padStart(6, "0");
    h.db.hold("stepUpEmailChallenge.findUnique", 20);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => h.request("/auth/step-up", {
      token: acct.accessToken,
      body: { purpose: "withdrawal", bind: BIND, proof: { kind: "password_email", password: PASSWORD, emailCode: wrong(i), emailChallengeToken: sent.body.emailChallengeToken } },
    })));
    const counts = tally(results);
    expect(counts["401:EMAIL_CODE_INVALID"]).toBe(5);
    expect(counts["400:CHALLENGE_INVALID"]).toBe(15);
    expect(h.db.rows("stepUpEmailChallenge")[0]!.attempts).toBe(5);
    // The right code is refused too: the code is spent.
    const late = await h.request("/auth/step-up", {
      token: acct.accessToken,
      body: { purpose: "withdrawal", bind: BIND, proof: { kind: "password_email", password: PASSWORD, emailCode: real, emailChallengeToken: sent.body.emailChallengeToken } },
    });
    expect(late.body.code).toBe("CHALLENGE_INVALID");
  }, SLOW);

  it("TOTP sign-in: 30 parallel wrong codes on one ticket get at most 5 tries before the lock", async () => {
    const h = createHarness();
    const acct = await signUp(h, "Race_Mfa", { verified: true });
    await enableTotp(h, acct);
    const attacker = cookieJar();
    const first = attacker.take(await h.request("/auth/login", { ip: "203.0.113.7", body: { identifier: acct.username, password: PASSWORD } }));
    expect(first.body.mfaRequired).toBe(true);
    h.db.hold("user.findUnique", 30);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => h.request("/auth/login/mfa", {
      ip: "203.0.113.7",
      cookie: attacker.header(),
      body: { mfaTicket: first.body.mfaTicket, method: "totp", code: String(100000 + i) },
    })));
    const counts = tally(results);
    expect(counts["401:MFA_INVALID"]).toBe(5);
    expect((counts["429:MFA_LOCKED"] ?? 0) + (counts["401:MFA_TICKET_INVALID"] ?? 0)).toBe(25);
    expect(h.db.user(acct.userId)!.mfaFailedCount).toBe(5);
    expect(h.db.user(acct.userId)!.mfaLockedUntil).toBeInstanceOf(Date);
  }, SLOW);

  it("step-up with password + TOTP and reauth/mfa share the account-wide cap under parallel requests", async () => {
    const h = createHarness();
    const acct = await signUp(h, "Race_Step", { verified: true });
    await enableTotp(h, acct);
    h.db.user(acct.userId)!.securityHoldUntil = null;
    h.db.hold("userTotp.findUnique", 12);
    const grants = await Promise.all(Array.from({ length: 12 }, (_, i) => h.request("/auth/step-up", {
      token: acct.accessToken,
      body: { purpose: "withdrawal", bind: BIND, proof: { kind: "totp", password: PASSWORD, code: String(200000 + i) } },
    })));
    const counts = tally(grants);
    expect(counts["401:MFA_INVALID"]).toBe(5);
    expect(counts["429:MFA_LOCKED"]).toBe(7);

    // The same lock covers the account-change step-up.
    setStepUp(h, acct.sessionId, ["pwd"], 10 * 60_000);
    const ticket = await h.request("/auth/reauth/password", { token: acct.accessToken, body: { password: PASSWORD } });
    expect(ticket.body.mfaRequired).toBe(true);
    const reauth = await h.request("/auth/reauth/mfa", { token: acct.accessToken, body: { mfaTicket: ticket.body.mfaTicket, method: "totp", code: "123456" } });
    expect([reauth.status, reauth.body.code]).toEqual([429, "MFA_LOCKED"]);
  }, SLOW);
});
