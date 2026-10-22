import { vi } from "vitest";
import { currentStep, totpCode } from "../../src/auth/totp";
import { cookieJar, PASSWORD, TERMS, type ApiResult, type Harness } from "../harness";

/**
 * Shared steps for the account-security suites: sign up through the API,
 * confirm the email, open a step-up window, and turn TOTP on, each the way a
 * browser would (cookies kept in a jar).
 */

export interface Account {
  userId: string;
  username: string;
  email: string;
  accessToken: string;
  sessionId: string;
  jar: ReturnType<typeof cookieJar>;
}

function sid(accessToken: string): string {
  const payload = JSON.parse(atob(accessToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { sid: string };
  return payload.sid;
}

export function sessionIdOf(accessToken: string): string {
  return sid(accessToken);
}

/** Register through the API (the new device cookie and the refresh cookie land in the jar). */
export async function signUp(h: Harness, username: string, opts: { email?: string; password?: string; remember?: boolean; verified?: boolean } = {}): Promise<Account> {
  const jar = cookieJar();
  const email = opts.email ?? `${username.toLowerCase()}@example.com`;
  const result = jar.take(await h.request("/auth/register", {
    body: { ...TERMS, username, email, password: opts.password ?? PASSWORD, ...(opts.remember === undefined ? {} : { remember: opts.remember }) },
  }));
  if (result.status !== 201) throw new Error(`register ${username}: ${result.status} ${JSON.stringify(result.body)}`);
  if (opts.verified) h.db.user(result.body.user.id)!.emailVerifiedAt = new Date();
  return { userId: result.body.user.id, username, email, accessToken: result.body.accessToken, sessionId: sid(result.body.accessToken), jar };
}

/** Password sign-in with the account's jar (its device cookie). */
export async function signIn(h: Harness, account: Account, extra: Record<string, unknown> = {}): Promise<ApiResult> {
  return account.jar.take(await h.request("/auth/login", {
    cookie: account.jar.header(),
    body: { identifier: account.username, password: PASSWORD, ...extra },
  }));
}

/** Adopt the session a sign-in answer issued. */
export function adopt(account: Account, result: ApiResult): Account {
  if (!result.body?.accessToken) throw new Error(`no session: ${result.status} ${JSON.stringify(result.body)}`);
  account.accessToken = result.body.accessToken;
  account.sessionId = sid(result.body.accessToken);
  return account;
}

/** Open (or age) the step-up window of a session directly. */
export function setStepUp(h: Harness, sessionId: string, methods: string[], ageMs = 0): void {
  const row = h.db.session(sessionId)!;
  row.reauthAt = new Date(Date.now() - ageMs);
  row.reauthMethods = methods;
}

/** The code an authenticator app shows `offset` steps from now. */
export function codeAt(secret: string, offset = 0): Promise<string> {
  return totpCode(secret, currentStep(Date.now()) + offset);
}

/** Move the clock (Date only) forward; restore with vi.useRealTimers(). */
export function advanceClock(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** setup + enable through the API, with a fresh step-up. Returns the secret and the backup codes. */
export async function enableTotp(h: Harness, account: Account): Promise<{ secret: string; backupCodes: string[] }> {
  setStepUp(h, account.sessionId, ["pwd"]);
  const setup = await h.request("/account/2fa/totp/setup", { token: account.accessToken, body: {} });
  if (setup.status !== 200) throw new Error(`totp setup: ${setup.status} ${JSON.stringify(setup.body)}`);
  const enable = await h.request("/account/2fa/totp/enable", { token: account.accessToken, body: { code: await codeAt(setup.body.secret) } });
  if (enable.status !== 200) throw new Error(`totp enable: ${enable.status} ${JSON.stringify(enable.body)}`);
  return { secret: setup.body.secret, backupCodes: enable.body.backupCodes };
}

/**
 * The TOTP replay guard needs a later step for each further code. Sign-ins
 * right after enrolment use the +1 step, so this moves the clock two steps.
 */
export async function nextStepCode(secret: string): Promise<string> {
  advanceClock(60_000);
  return codeAt(secret);
}
