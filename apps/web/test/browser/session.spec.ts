import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const fixture = "http://127.0.0.1:4107";

interface SessionStats {
  refreshMode: string;
  renewMode: string;
  refreshStats: { ok: number; refused: number; unavailable: number };
  renewals: (string | null)[];
  handshakeTokens: (string | null)[];
  sockets: string[];
}

async function sessionStats(request: APIRequestContext): Promise<SessionStats> {
  return (await request.get(`${fixture}/__test/session`)).json();
}

async function setSession(request: APIRequestContext, data: Record<string, unknown>) {
  await request.post(`${fixture}/__test/session`, { data });
}

/** The 10-minute session refresh, run now through the app's development-only hook (timers are left real). */
async function refreshNow(page: Page) {
  await page.waitForFunction(() => "__pokerSession" in window);
  await page.evaluate(() => (window as unknown as { __pokerSession: { refresh: () => Promise<void> } }).__pokerSession.refresh());
}

/** Two animation frames: every socket message and store update already received has been rendered. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function signedInLobby(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test("two tabs refreshing at the same moment both stay signed in", async ({ context, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  // As the server: each refresh rotates the shared cookie and a superseded cookie is refused as a replay.
  await setSession(request, { refreshMode: "rotate" });
  const first = await context.newPage();
  const second = await context.newPage();
  await signedInLobby(first);
  await signedInLobby(second);
  expect((await sessionStats(request)).refreshStats.refused).toBe(0);

  // Both tabs' refresh timers fire together while the server is slow to answer.
  await request.post(`${fixture}/__test/hold-refresh`);
  const both = Promise.all([refreshNow(first), refreshNow(second)]);
  await expect.poll(async () => (await request.get(`${fixture}/__test/waiting-refresh`)).json().then((r) => r.count)).toBe(1);
  // Long enough for a second, uncoordinated request to arrive with the same cookie.
  await first.waitForTimeout(500);
  expect((await (await request.get(`${fixture}/__test/waiting-refresh`)).json()).count).toBe(1);
  await request.post(`${fixture}/__test/release-refresh`);
  await both;

  // One tab refreshed; the other took its result or refreshed after it with the new cookie. Nothing was refused.
  expect((await sessionStats(request)).refreshStats.refused).toBe(0);
  for (const page of [first, second]) {
    await settle(page);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Play as guest" })).toHaveCount(0);
  }
});

test("a 401 caused by another tab's rotation is re-checked before signing out", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await signedInLobby(page);
  await setSession(request, { refreshMode: "unauthorized-once" });
  await refreshNow(page);
  const stats = await sessionStats(request);
  expect(stats.refreshStats).toMatchObject({ refused: 1, ok: 1 });
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("a refresh answered 401 twice signs out", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await signedInLobby(page);
  await setSession(request, { refreshMode: "unauthorized" });
  await refreshNow(page);
  expect((await sessionStats(request)).refreshStats.refused).toBe(2);
  await expect(page.getByRole("button", { name: "Play as guest" })).toBeVisible();
});

test("a refresh answered 503 keeps the session and recovers when the server is back", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await signedInLobby(page);
  await setSession(request, { refreshMode: "unavailable" });
  await refreshNow(page);
  const offline = page.getByText("This page will reconnect automatically.", { exact: false });
  await expect(offline).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();

  // Retry-After: 1 is honoured: the retry comes in about a second, not at the next fixed interval.
  await setSession(request, { refreshMode: "rotate" });
  await expect(offline).toBeHidden({ timeout: 4_000 });
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect((await sessionStats(request)).refreshStats.ok).toBeGreaterThanOrEqual(1);
});

test("a token refresh on a seated table keeps the socket, the action bar and a typed bet", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await setSession(request, { refreshMode: "rotate", renewMode: "ok" });
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call 10", exact: true });
  await expect(call).toBeEnabled();
  const bet = page.locator("#bet-amount");
  await bet.fill("40");
  const before = await sessionStats(request);
  expect(before.sockets).toHaveLength(1);

  await refreshNow(page);
  await expect.poll(async () => (await sessionStats(request)).renewals).toEqual(["browser-fixture-token-2"]);
  await settle(page);

  const after = await sessionStats(request);
  expect(after.sockets).toEqual(before.sockets);
  expect(after.handshakeTokens).toHaveLength(1);
  await expect(call).toBeEnabled();
  await expect(bet).toHaveValue("40");
});

test("a server without SESSION_RENEW gets the same socket reconnected with the new token, the table kept on screen", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await setSession(request, { refreshMode: "rotate", renewMode: "ignore" });
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call 10", exact: true });
  await expect(call).toBeEnabled();
  const bet = page.locator("#bet-amount");
  await bet.fill("40");

  await refreshNow(page);
  // No answer within 5 s: the socket reconnects, presenting the refreshed token.
  await expect.poll(async () => (await sessionStats(request)).handshakeTokens, { timeout: 10_000 })
    .toEqual(["browser-fixture-token-1", "browser-fixture-token-2"]);
  await expect(call).toBeEnabled();
  await expect(bet).toHaveValue("40");
});

test("SESSION_RENEW refused as unauthorized signs out", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await setSession(request, { refreshMode: "rotate", renewMode: "unauthorized" });
  await page.goto("/table/fixture-table");
  await expect(page.getByRole("button", { name: "Call 10", exact: true })).toBeEnabled();
  await refreshNow(page);
  await expect(page.getByRole("heading", { name: "Sign in to sit down" })).toBeVisible();
});

test("a server-initiated disconnect refreshes the session and reconnects", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await setSession(request, { refreshMode: "rotate" });
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call 10", exact: true });
  await expect(call).toBeEnabled();
  await request.post(`${fixture}/__test/disconnect`);
  await expect(call).toBeDisabled();
  // Refreshed (a new token) and reconnected with it; the table is live again.
  await expect.poll(async () => (await sessionStats(request)).handshakeTokens, { timeout: 10_000 })
    .toEqual(["browser-fixture-token-1", "browser-fixture-token-2"]);
  await expect(call).toBeEnabled();
});

test("a server-initiated disconnect whose session is over signs out", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await page.goto("/table/fixture-table");
  await expect(page.getByRole("button", { name: "Call 10", exact: true })).toBeEnabled();
  await setSession(request, { refreshMode: "unauthorized" });
  await request.post(`${fixture}/__test/disconnect`);
  await expect(page.getByRole("heading", { name: "Sign in to sit down" })).toBeVisible({ timeout: 10_000 });
});

test("SESSION_REVOKED signs out, clears live evidence and says why once", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await page.goto("/table/fixture-table");
  await expect(page.getByRole("button", { name: "Call 10", exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("poker-live-evidence:")).length))
    .toBeGreaterThan(0);

  await request.post(`${fixture}/__test/revoke`, { data: { reason: "PASSWORD_CHANGED" } });
  const alert = page.getByRole("alert").filter({ hasText: "Your password was changed" });
  await expect(alert).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to sit down" })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("poker-live-evidence:")).length)).toBe(0);
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toHaveCount(0);
});

test("a retryable server error is a brief notice, never a sign-out", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call 10", exact: true });
  await expect(call).toBeEnabled();
  await request.post(`${fixture}/__test/server-error`, {
    data: { code: "SERVICE_UNAVAILABLE", message: "Database busy", retryable: true, tableId: "fixture-table" },
  });
  await expect(page.getByText("The game server is busy for a moment. Retrying…")).toBeVisible();
  await expect(page.getByText("Database busy")).toHaveCount(0);
  await expect(call).toBeEnabled();
  await expect(page.getByText("The game server is busy for a moment. Retrying…")).toBeHidden({ timeout: 8_000 });
});

test("AUTH_OK's idle warning shows in the lobby after a reconnect, and another table's late end leaves it", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await setSession(request, { idleNotice: { tableId: "fixture-table", tableName: "Browser test table", closingInMs: 60_000 } });
  await page.goto("/");
  const warning = page.getByRole("alertdialog", { name: "Table closing due to inactivity" });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("link", { name: "Go to table" })).toBeVisible();

  await request.post(`${fixture}/__test/idle-notice`, { data: { tableId: "another-table", tableName: "Elsewhere", closingInMs: null } });
  await settle(page);
  await expect(warning).toBeVisible();

  // The same warning again (a reconnect's AUTH_OK) changes nothing.
  await request.post(`${fixture}/__test/disconnect`);
  await expect.poll(async () => (await sessionStats(request)).handshakeTokens.length, { timeout: 10_000 }).toBe(2);
  await expect(warning).toBeVisible();
});

test("an out-of-order wallet patch never moves the balance backwards", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await signedInLobby(page);
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();

  await request.post(`${fixture}/__test/user-patch`, { data: { bankroll: 10_500, walletVersion: 7, persist: true } });
  await expect(page.getByText("10,500 chips", { exact: true })).toBeVisible();
  await request.post(`${fixture}/__test/user-patch`, { data: { bankroll: 10_200, walletVersion: 6 } });
  await request.post(`${fixture}/__test/user-patch`, { data: { bankroll: 10_100, walletVersion: 7 } });
  await page.waitForTimeout(300);
  await settle(page);
  await expect(page.getByText("10,500 chips", { exact: true })).toBeVisible();
  await expect(page.getByText("10,200 chips", { exact: true })).toHaveCount(0);

  // A refresh whose balance was read before a newer patch arrived does not overwrite it.
  await request.post(`${fixture}/__test/hold-refresh`);
  const refreshed = refreshNow(page);
  await expect.poll(async () => (await request.get(`${fixture}/__test/waiting-refresh`)).json().then((r) => r.count)).toBe(1);
  await request.post(`${fixture}/__test/user-patch`, { data: { bankroll: 10_900, walletVersion: 8 } });
  await expect(page.getByText("10,900 chips", { exact: true })).toBeVisible();
  await request.post(`${fixture}/__test/release-refresh`);
  await refreshed;
  await settle(page);
  await expect(page.getByText("10,900 chips", { exact: true })).toBeVisible();
});
