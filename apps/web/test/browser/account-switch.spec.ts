import type { Page } from "@playwright/test";
import { accountMenuButton, expectOnLogin, expectSignedIn, fixtureRequests, openAccountMenu, signInViaUi } from "../support/auth";
import { expect, fixture, test } from "../support/fixtures";

test.use({ session: "signed-out" });

const remembered = (page: Page) => page.evaluate(() => localStorage.getItem("poker-remembered-accounts"));

async function sessionStats(page: Page) {
  return (await page.request.get(`${fixture}/__test/session`)).json() as Promise<{ handshakeTokens: string[] }>;
}

test("a sign-in with 'Stay signed in' remembers only the username, colour and time", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await page.goto("/login");
  await signInViaUi(page, { identifier: "Player-0", password: "fixture-password-0" });
  await expectSignedIn(page, "Player-0");
  const stored = JSON.parse((await remembered(page))!) as { v: number; accounts: Record<string, unknown>[] };
  expect(stored.v).toBe(1);
  expect(stored.accounts).toHaveLength(1);
  expect(Object.keys(stored.accounts[0]!).sort()).toEqual(["avatarHue", "lastUsedAt", "username"]);
  expect(stored.accounts[0]).toMatchObject({ username: "Player-0", avatarHue: 0 });
  // Never an email, id or token.
  expect(await remembered(page)).not.toMatch(/example\.test|fixture-player|token/);
});

test("switch account: sign out, pick from the remembered accounts, sign in as someone else", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await page.goto("/login");
  await signInViaUi(page, { identifier: "Player-0", password: "fixture-password-0" });
  await expectSignedIn(page, "Player-0");
  await expect.poll(async () => (await sessionStats(page)).handshakeTokens.length).toBeGreaterThan(0);
  const firstToken = (await sessionStats(page)).handshakeTokens.at(-1);
  await page.evaluate(() => sessionStorage.setItem("poker-live-evidence:fixture-table:1", "{}"));

  await openAccountMenu(page);
  await page.getByRole("button", { name: "Switch account" }).click();
  await expect(page).toHaveURL(/\/login\?switch=1$/);
  expect((await fixtureRequests(request, "/api/auth/logout")).length).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem("poker-live-evidence:fixture-table:1"))).toBeNull();
  await expect(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Player-0 Last used/ })).toBeVisible();

  await page.getByRole("button", { name: "Use another account" }).click();
  await signInViaUi(page, { identifier: "Player-1", password: "fixture-password-1" });
  await expectSignedIn(page, "Player-1");
  // A new account, a new socket session.
  await expect.poll(async () => (await sessionStats(page)).handshakeTokens.at(-1)).not.toBe(firstToken);

  // Back to the first account: picking it locks the username and asks only for the password.
  await openAccountMenu(page);
  await page.getByRole("button", { name: "Switch account" }).click();
  const rows = page.locator("button[data-account-row]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Player-1");
  await page.getByRole("button", { name: /^Player-0 Last used/ }).click();
  const password = page.getByLabel("Password", { exact: true });
  await expect(password).toBeFocused();
  await expect(page.getByLabel("Username or email")).toHaveCount(0);
  await password.fill("fixture-password-0");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expectSignedIn(page, "Player-0");
});

test("removing a remembered account moves focus to the next row; forgetting all asks first", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    const now = Date.now();
    localStorage.setItem("poker-remembered-accounts", JSON.stringify({ v: 1, accounts: [
      { username: "Alpha_1", avatarHue: 10, lastUsedAt: now - 1_000 },
      { username: "Bravo_2", avatarHue: 120, lastUsedAt: now - 2_000 },
      { username: "Charlie_3", avatarHue: 240, lastUsedAt: now - 3_000 },
    ] }));
  });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await page.getByRole("button", { name: "Remove Alpha_1 from this device" }).click();
  await expect(page.getByRole("button", { name: /^Alpha_1/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Bravo_2 Last used/ })).toBeFocused();
  expect(await remembered(page)).not.toContain("Alpha_1");

  await page.getByRole("button", { name: "Forget all accounts on this device" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Forget all accounts?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Forget all" }).click();
  await expect(page.getByLabel("Username or email")).toBeVisible();
  expect(await remembered(page)).toBeNull();
});

test.describe("signed in", () => {
  test.use({ session: "signed-in" });

  test("signing out while seated asks first", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
    await page.goto("/");
    await expectSignedIn(page);
    await expect(page.getByRole("button", { name: "Return to your table" })).toBeVisible();
    // The lobby socket's AUTH_OK names the table this account is seated at.
    await expect.poll(async () => (await sessionStats(page)).handshakeTokens.length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Sign out?" });
    await expect(confirm).toContainText("You're seated at a table");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expectSignedIn(page);
    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out anyway" }).click();
    await expectOnLogin(page);
  });

  test("signing out in one tab signs out the others at once", async ({ context, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto("/");
    await second.goto("/account/security");
    await expectSignedIn(first);
    await expectSignedIn(second);
    await openAccountMenu(first);
    await first.getByRole("button", { name: "Sign out", exact: true }).click();
    await expectOnLogin(first);
    await expect(second).toHaveURL(/\/login\?next=%2Faccount%2Fsecurity/, { timeout: 3_000 });
  });

  test("a refresh still in flight when this browser signs out is never handed to the other tabs", async ({ context, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await request.post(`${fixture}/__test/session`, { data: { refreshMode: "rotate" } });
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto("/");
    await second.goto("/account/security");
    await expectSignedIn(first);
    await expectSignedIn(second);
    // The first tab's periodic refresh is on its way when the user signs out there, and the network fails.
    await request.post(`${fixture}/__test/hold-refresh`);
    await first.waitForFunction(() => "__pokerSession" in window);
    const inFlight = first.evaluate(() => (window as unknown as { __pokerSession: { refresh: () => Promise<void> } }).__pokerSession.refresh());
    await expect.poll(async () => (await (await request.get(`${fixture}/__test/waiting-refresh`)).json()).count).toBe(1);
    await first.route(`${fixture}/api/auth/logout`, (route) => route.abort("internetdisconnected"));
    await openAccountMenu(first);
    await first.getByRole("button", { name: "Sign out", exact: true }).click();
    await expectOnLogin(first);
    await expect(second).toHaveURL(/\/login\?next=%2Faccount%2Fsecurity/, { timeout: 3_000 });
    // The refresh answers after the sign-out: no tab takes that session back.
    await request.post(`${fixture}/__test/release-refresh`);
    await inFlight;
    await second.waitForTimeout(1_000);
    for (const tab of [first, second]) {
      await expect(tab).toHaveURL(/\/login/);
      await expect(accountMenuButton(tab)).toHaveCount(0);
    }
  });

  test("changing account remounts the page: nothing typed for one account survives into the next", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Custom table" }).click();
    await page.getByLabel("Table name").fill("Account A's table");
    // Another tab signs in as Player-1: this tab adopts that session.
    await request.post(`${fixture}/__test/auth`, { data: { as: "fixture-player-1" } });
    await page.evaluate(() => (window as unknown as { __pokerSession: { refresh: () => Promise<void> } }).__pokerSession.refresh());
    await expectSignedIn(page, "Player-1");
    await expect(page.getByLabel("Table name")).toHaveCount(0);
  });
});
