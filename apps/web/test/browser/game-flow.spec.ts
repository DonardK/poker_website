import { test, expect } from "@playwright/test";

const fixture = "http://127.0.0.1:4107";

test("custom human table opens even while the wallet refresh is delayed", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Custom table" }).click();
  await page.getByRole("textbox", { name: "Table name" }).fill("Friends night");
  await page.getByLabel("Seats").selectOption("2");
  await request.post(`${fixture}/__test/hold-me`);
  await page.getByRole("button", { name: "Open table" }).click();
  await expect(page).toHaveURL(/3107\/table\/fixture-table$/);
  await expect(page.getByText("Waiting for another person to take a seat.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy table link" })).toBeVisible();
  const { body } = await (await request.get(`${fixture}/__test/created`)).json();
  expect(body).toMatchObject({ name: "Friends night", maxSeats: 2, botCount: 0, buyIn: 1000 });
  await request.post(`${fixture}/__test/release-me`);
});

test("leave during a hand returns to the lobby and the wallet updates after settlement", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await page.goto("/table/fixture-table");
  await page.getByRole("button", { name: "Fold & leave", exact: true }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByRole("status")).toContainText("current hand is finishing");
  await expect(page.getByText("$9,000", { exact: true })).toBeVisible();
  await request.post(`${fixture}/__test/settle`);
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
  await expect(page.getByText("The current hand is finishing", { exact: false })).toHaveCount(0);
});

test("the top leave control cashes out immediately between hands", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "waiting" } });
  await page.goto("/table/fixture-table");
  await page.getByRole("button", { name: "← Leave table", exact: true }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
  await expect(page.getByText("The current hand is finishing", { exact: false })).toHaveCount(0);
});

test("a stale wallet fetch cannot overwrite a newer cash-out event", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "slow-me" } });
  await page.goto("/table/fixture-table");
  await expect.poll(async () => (await (await request.get(`${fixture}/__test/waiting-me`)).json()).count).toBe(1);
  await page.getByRole("button", { name: "Fold & leave", exact: true }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await request.post(`${fixture}/__test/settle`);
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
  const staleResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/me") && response.status() === 200);
  await request.post(`${fixture}/__test/release-me`);
  await staleResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
});

test("a delayed session refresh cannot roll back a completed cash-out", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await page.clock.install();
  await page.goto("/table/fixture-table");
  await expect(page.getByRole("button", { name: "Fold & leave", exact: true })).toBeEnabled();
  await request.post(`${fixture}/__test/hold-refresh`);
  await page.clock.fastForward(5 * 60_000 + 1_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(async () => (await (await request.get(`${fixture}/__test/waiting-refresh`)).json()).count).toBe(1);
  await page.getByRole("button", { name: "Fold & leave", exact: true }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await request.post(`${fixture}/__test/settle`);
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
  const staleResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/refresh") && response.status() === 200);
  await request.post(`${fixture}/__test/release-refresh`);
  await staleResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
});

test("a rejected action can be retried without waiting for another snapshot", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "reject" } });
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call $10", exact: true });
  await call.click();
  await expect(page.getByText("Fixture rejected this action; try again.")).toBeVisible();
  await expect(call).toBeEnabled();
  await call.click();
  await expect(page.getByText("Waiting for an opponent to act…")).toBeVisible();
  const stats = await (await request.get(`${fixture}/__test/actions`)).json();
  expect(stats.actionCount).toBe(2);
});

test("disconnected action and leave buttons cannot queue commands", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call $10", exact: true });
  await expect(call).toBeEnabled();
  await request.post(`${fixture}/__test/disconnect`);
  await expect(call).toBeDisabled();
  await expect(page.getByRole("button", { name: "Fold & leave", exact: true })).toBeDisabled();
  const stats = await (await request.get(`${fixture}/__test/actions`)).json();
  expect(stats.actionCount).toBe(0);
  await page.getByRole("link", { name: "Lobby (keep seat)" }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByRole("button", { name: "Return to your table" })).toBeVisible();
});
