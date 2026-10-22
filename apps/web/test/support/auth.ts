import type { APIRequestContext, Page } from "@playwright/test";
import { expect, fixture } from "./fixtures";

/** Signed in: the header's account menu names someone. */
export function accountMenuButton(page: Page) {
  return page.getByRole("button", { name: /^Account menu, signed in as / });
}

export async function expectSignedIn(page: Page, username?: string) {
  await expect(username
    ? page.getByRole("button", { name: `Account menu, signed in as ${username}` })
    : accountMenuButton(page)).toBeVisible();
}

/** On the sign-in page, optionally with this (encoded) next=. */
export async function expectOnLogin(page: Page, next?: string) {
  await expect(page).toHaveURL(next === undefined ? /\/login(\?|$)/ : new RegExp(`/login\\?next=${next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
}

export async function openAccountMenu(page: Page) {
  const button = accountMenuButton(page);
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

/** The password form on /login (the chooser's "Use another account" first, when it shows). */
export async function signInViaUi(page: Page, opts: { identifier: string; password: string; stay?: boolean }) {
  const another = page.getByRole("button", { name: "Use another account" });
  const identifier = page.getByLabel("Username or email");
  await expect(another.or(identifier)).toBeVisible();
  if (await another.isVisible()) await another.click();
  await identifier.fill(opts.identifier);
  await page.getByLabel("Password", { exact: true }).fill(opts.password);
  const stay = page.getByLabel("Stay signed in on this device");
  if (opts.stay === false) await stay.uncheck(); else await stay.check();
  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
}

export interface FixtureUser { id: string; username: string; email: string; password: string; totpSecret: string | null }

export async function createUser(request: APIRequestContext, opts: {
  username: string; email?: string; password?: string; emailVerified?: boolean; totp?: boolean; backupCodes?: string[]; passwordResetRequired?: boolean;
  /** The terms version the account last accepted (null: never). Default: the current one. */
  termsVersion?: string | null;
}): Promise<FixtureUser> {
  return (await request.post(`${fixture}/__test/users`, { data: opts })).json();
}

export async function fixtureAuth(request: APIRequestContext, data: Record<string, unknown>) {
  await request.post(`${fixture}/__test/auth`, { data });
}

/** A link token as the email would carry it. */
export async function mintToken(request: APIRequestContext, data: { kind: "verify" | "reset" | "not-me" | "email-change"; username?: string; email?: string; expired?: boolean }): Promise<string> {
  return (await (await request.post(`${fixture}/__test/tokens`, { data })).json()).token;
}

export interface RecordedRequest { method: string; path: string; url: string; body: Record<string, unknown> | null }

export async function fixtureRequests(request: APIRequestContext, path?: string): Promise<RecordedRequest[]> {
  const { requests } = await (await request.get(`${fixture}/__test/requests`)).json() as { requests: RecordedRequest[] };
  return path ? requests.filter((r) => r.path === path) : requests;
}

/** The account as the fixture holds it (security overview plus password and reset flag). */
export async function fixtureUser(request: APIRequestContext, username: string) {
  return (await request.get(`${fixture}/__test/users/${encodeURIComponent(username)}`)).json();
}
