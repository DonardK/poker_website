import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, fixture, test } from "../support/fixtures";

/** Three seated players, a hand running, and the viewer (Player-0) to act. */
async function openActiveTable(page: Page, request: APIRequestContext) {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call 10", exact: true });
  await expect(call).toBeEnabled();
  return call;
}

async function keepAliveStats(request: APIRequestContext): Promise<{ count: number; waiting: number; closingAt: number | null }> {
  return (await request.get(`${fixture}/__test/keep-alive`)).json();
}

/**
 * The control can be seen and pressed where it is: wholly inside the viewport as the intersection observer sees it
 * (so a clipping ancestor, like the warnings' scrolling layer, counts), and its centre hit-tests to it rather than to
 * whatever is under a clipped layer or over the control. A bounding box alone would pass for a clipped button.
 */
async function expectReachable(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect.poll(() => control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && el.contains(hit);
  })).toBe(true);
}

const warningName = "Table closing due to inactivity";
/** TABLE_IDLE_WARNING_MS (@poker/shared): how long the idle warning lasts before the table closes. */
const WARNING_SECONDS = 30;
const closedNoticeText = "Your table closed after 5 minutes without activity. Your chips were returned to your chip balance.";

/** Seated at an active table, then back in the lobby with the seat kept. */
async function keepSeatInLobby(page: Page, request: APIRequestContext) {
  await openActiveTable(page, request);
  await page.getByRole("link", { name: "Back to lobby" }).click();
  await expect(page.getByRole("button", { name: "Return to your table" })).toBeVisible();
}

/** The seated player was in the lobby when their table closed for inactivity; the lobby says so. */
async function closedWhileInLobby(page: Page, request: APIRequestContext) {
  await keepSeatInLobby(page, request);
  await request.post(`${fixture}/__test/close-idle`);
  await request.post(`${fixture}/__test/finish-close`);
  const notice = page.getByText(closedNoticeText);
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Open 6-seat table" })).toBeEnabled();
  return notice;
}

test("the idle warning floats over a playable table, counts down and \"I'm still here\" keeps the table open", async ({ page, request }) => {
  const call = await openActiveTable(page, request);
  await call.focus();
  await request.post(`${fixture}/__test/idle-warning`);

  const dialog = page.getByRole("alertdialog", { name: warningName });
  await expect(dialog).toBeVisible();
  // Not modal: the table behind stays live (acting keeps the table open too).
  await expect(dialog).toHaveAttribute("aria-modal", "false");
  await expect(page.locator("main")).toHaveJSProperty("inert", false);
  // The seated player's app-wide notice is not shown on the table's own page: one warning only.
  await expect(page.getByRole("alertdialog")).toHaveCount(1);
  await expect(dialog.getByRole("link", { name: "Go to table" })).toHaveCount(0);
  await expect(dialog).toHaveAccessibleDescription(/No one has played for 5 minutes\. The table closes in \d+ seconds? unless you're still here\./);
  await expect(dialog).toContainText("Chips at the table go back to each player's chip balance.");
  const countdown = dialog.getByTestId("idle-countdown");
  const first = Number(await countdown.textContent());
  // The warning lasts WARNING_SECONDS and counts down from (about) all of it.
  expect(first).toBeGreaterThanOrEqual(WARNING_SECONDS - 5);
  expect(first).toBeLessThanOrEqual(WARNING_SECONDS);
  await expect.poll(async () => Number(await countdown.textContent())).toBeLessThan(first);

  // Focus moves to the warning's primary action when it appears.
  const keep = dialog.getByRole("button", { name: "I'm still here" });
  await expect(keep).toBeFocused();
  // Escape never silently dismisses the warning.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(keep).toBeFocused();

  await keep.click();
  await expect(dialog).toBeHidden();
  expect(await keepAliveStats(request)).toMatchObject({ count: 1, closingAt: null });
  await expect(page.getByText("is back — the table stays open")).toBeVisible();
  // Focus returns to where the player was: their action buttons.
  await expect(call).toBeFocused();
  await call.click();
  await expect(page.getByText("Waiting for an opponent to act…")).toBeVisible();
});

test("during the warning the action bar stays usable, and acting ends the warning", async ({ page, request }) => {
  const call = await openActiveTable(page, request);
  await request.post(`${fixture}/__test/idle-warning`);
  const panel = page.getByRole("alertdialog", { name: warningName });
  await expect(panel.getByRole("button", { name: "I'm still here" })).toBeFocused();
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 1024) {
    // On a phone the warning floats above the fixed action dock, never over it.
    const panelBox = await panel.boundingBox();
    const dockBox = await page.locator(".table-action-dock").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(dockBox!.y);
  }

  await call.click();
  await expect(panel).toBeHidden();
  await expect(page.getByText("Waiting for an opponent to act…")).toBeVisible();
  // The action itself kept the table open: no "I'm still here" was sent.
  expect(await keepAliveStats(request)).toMatchObject({ count: 0, closingAt: null });
  expect((await (await request.get(`${fixture}/__test/actions`)).json()).actionCount).toBe(1);
});

test("on a short landscape phone the table warning shows its focused action above the action dock", async ({ page, request }) => {
  // 360px tall: the room left above the dock is shorter than the panel, so the panel scrolls inside its layer.
  await page.setViewportSize({ width: 780, height: 360 });
  await openActiveTable(page, request);
  const dock = page.locator(".table-action-dock");
  await expect(dock).toBeVisible();
  const scrollY = await page.evaluate(() => window.scrollY);
  await request.post(`${fixture}/__test/idle-warning`);

  const panel = page.getByRole("alertdialog", { name: warningName });
  const keep = panel.getByRole("button", { name: "I'm still here" });
  await expect(keep).toBeFocused();
  // Visible and pressable as it appears, before anything scrolls it into view.
  await expectReachable(keep);
  // The layer still stops above the dock, and it scrolled, not the page.
  const layerBox = await page.locator(".idle-float-layer").boundingBox();
  const dockBox = await dock.boundingBox();
  expect(layerBox!.y + layerBox!.height).toBeLessThanOrEqual(dockBox!.y);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

  // Refused once: the error note above the buttons pushes them down, and the retry must stay in view.
  await request.post(`${fixture}/__test/keep-alive-mode`, { data: { mode: "reject" } });
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("alert")).toHaveText("Too many requests");
  await expect(keep).toBeFocused();
  await expectReachable(keep);
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  expect(await keepAliveStats(request)).toMatchObject({ count: 2, closingAt: null });
});

test("a spectator can take a seat during the warning, which keeps the table open", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "spectator" } });
  await page.goto("/table/fixture-table");
  const sit = page.getByRole("button", { name: /Sit at seat/ }).first();
  await expect(sit).toBeEnabled();
  await request.post(`${fixture}/__test/idle-warning`);

  const panel = page.getByRole("alertdialog", { name: warningName });
  await expect(panel).toHaveAccessibleDescription(
    /The table closes in \d+ seconds? unless a seated player is still here or you take a seat\./);
  // Only a seated player can answer "I'm still here"; a spectator is offered the lobby.
  await expect(panel.getByRole("button", { name: "I'm still here" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Back to lobby" })).toBeFocused();

  // "Sit here" opens the buy-in dialog; the seat is claimed only on Confirm.
  await sit.click();
  const buyIn = page.getByRole("dialog", { name: /Buy in for seat/ });
  await buyIn.getByRole("button", { name: "Confirm buy-in" }).click();
  await expect(buyIn).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("link", { name: "Back to lobby" })).toBeVisible();
  expect(await keepAliveStats(request)).toMatchObject({ count: 0, closingAt: null });
});

test("a newer snapshot restarts the countdown, which reads \"Closing the table…\" at zero", async ({ page, request }) => {
  await openActiveTable(page, request);
  await request.post(`${fixture}/__test/idle-warning`, { data: { closesInMs: 1_500 } });
  const dialog = page.getByRole("alertdialog", { name: "Table closing due to inactivity" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Closing the table…");
  await expect(dialog.getByTestId("idle-countdown")).toHaveCount(0);
  // The server can still accept "I'm still here" until it closes the table.
  await expect(dialog.getByRole("button", { name: "I'm still here" })).toBeVisible();

  await request.post(`${fixture}/__test/idle-warning`, { data: { closesInMs: 10_000 } });
  await expect(dialog.getByTestId("idle-countdown")).toHaveText(/^(10|9|8)$/);
  await expect(dialog).not.toContainText("Closing the table…");
});

test("the countdown ignores a device clock that is far off the server's", async ({ page, request }) => {
  // An hour fast: a countdown built from a server timestamp would already read zero.
  await page.clock.setSystemTime(Date.now() + 3_600_000);
  await openActiveTable(page, request);
  expect(await page.evaluate(() => Date.now())).toBeGreaterThan(Date.now() + 3_500_000);
  await request.post(`${fixture}/__test/idle-warning`);
  const countdown = page.getByRole("alertdialog", { name: "Table closing due to inactivity" }).getByTestId("idle-countdown");
  // The full warning (30 s, TABLE_IDLE_WARNING_MS), measured from the snapshot's arrival, not from the device clock.
  await expect(countdown).toHaveText(/^(30|29|28)$/);
  const first = Number(await countdown.textContent());
  await expect.poll(async () => Number(await countdown.textContent())).toBeLessThan(first);
});

test("keeping the table open shows pending and error states and can be retried", async ({ page, request }) => {
  await openActiveTable(page, request);
  await request.post(`${fixture}/__test/keep-alive-mode`, { data: { mode: "reject" } });
  await request.post(`${fixture}/__test/idle-warning`);
  const dialog = page.getByRole("alertdialog", { name: "Table closing due to inactivity" });
  const keep = dialog.getByRole("button", { name: "I'm still here" });
  await keep.click();
  await expect(dialog.getByRole("alert")).toHaveText("Too many requests");
  await expect(dialog).toBeVisible();

  await request.post(`${fixture}/__test/keep-alive-mode`, { data: { mode: "hold" } });
  await keep.click();
  const pending = dialog.getByRole("button", { name: "Keeping the table open…" });
  await expect(pending).toHaveAttribute("aria-disabled", "true");
  // Still focused: a pending button must not drop focus out of the dialog.
  await expect(pending).toBeFocused();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  // A second press while pending sends nothing more.
  await pending.click({ force: true });
  await expect.poll(async () => (await keepAliveStats(request)).waiting).toBe(1);
  expect((await keepAliveStats(request)).count).toBe(2);

  await request.post(`${fixture}/__test/release-keep-alive`);
  await expect(dialog).toBeHidden();
  expect(await keepAliveStats(request)).toMatchObject({ count: 2, closingAt: null });
});

test("a session refresh while \"I'm still here\" is pending leaves the table and the app live", async ({ page, request }) => {
  const call = await openActiveTable(page, request);
  // The next session refresh rotates the access token (the fixture accepts any token).
  await page.route(`${fixture}/api/auth/refresh`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), accessToken: "rotated-fixture-token" } });
  });
  await request.post(`${fixture}/__test/keep-alive-mode`, { data: { mode: "hold" } });
  await request.post(`${fixture}/__test/idle-warning`);
  const panel = page.getByRole("alertdialog", { name: warningName });
  await panel.getByRole("button", { name: "I'm still here" }).click();
  await expect(panel.getByRole("button", { name: "Keeping the table open…" })).toBeFocused();
  await expect.poll(async () => (await keepAliveStats(request)).waiting).toBe(1);

  // Back after more than 5 minutes away, the app refreshes the session. The new token replaces the socket, so the
  // pending "I'm still here" fails; its re-check must not bring back the old token's socket and drop the new one's
  // listeners (table and app-wide alike).
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/auth/refresh"));
  const replaced = page.waitForEvent("websocket");
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 6 * 60_000;
    try { document.dispatchEvent(new Event("visibilitychange")); } finally { Date.now = now; }
  });
  expect((await (await refreshed).json()).accessToken).toBe("rotated-fixture-token");
  await replaced;

  // The new socket joined the table: a fresh snapshot, with the warning still running and "I'm still here" ready again.
  await expect(call).toBeEnabled();
  const keep = panel.getByRole("button", { name: "I'm still here" });
  await expect(keep).toBeVisible();
  await request.post(`${fixture}/__test/keep-alive-mode`, { data: { mode: "ok" } });
  await keep.click();
  await expect(panel).toBeHidden();
  expect(await keepAliveStats(request)).toMatchObject({ count: 2, closingAt: null });
  // A newer snapshot still reaches the page.
  await request.post(`${fixture}/__test/idle-warning`);
  await expect(panel).toBeVisible();
  await call.click();
  await expect(panel).toBeHidden();
  await expect(page.getByText("Waiting for an opponent to act…")).toBeVisible();

  // The app-wide listeners moved to the new socket too: the lobby still gets the warning.
  await page.getByRole("link", { name: "Back to lobby" }).click();
  await expect(page.getByRole("button", { name: "Return to your table" })).toBeVisible();
  await request.post(`${fixture}/__test/idle-warning`);
  await expect(page.getByRole("alertdialog", { name: warningName }).getByRole("link", { name: "Go to table" })).toBeVisible();
});

test("an idle closure settles the hand, then the closed dialog returns the player to the lobby", async ({ page, request }) => {
  await openActiveTable(page, request);
  await request.post(`${fixture}/__test/idle-warning`);
  await expect(page.getByRole("alertdialog", { name: "Table closing due to inactivity" })).toBeVisible();

  await request.post(`${fixture}/__test/close-idle`);
  const closing = page.getByRole("alertdialog", { name: "Closing the table…" });
  await expect(closing).toBeVisible();
  await expect(closing.getByRole("button", { name: "Back to lobby" })).toBeFocused();

  await request.post(`${fixture}/__test/finish-close`);
  const closed = page.getByRole("alertdialog", { name: "This table has closed" });
  await expect(closed).toBeVisible();
  await expect(closed).toHaveAccessibleDescription(
    "It closed after 5 minutes without activity. Any chips you had at this table are back in your chip balance.");
  await expect(closed.getByText("10,000 chips", { exact: true })).toBeVisible();
  // The hand the closure settled can be verified before leaving.
  await expect(closed.getByRole("button", { name: "Verify hand" })).toBeVisible();
  await expect(closed.getByRole("spinbutton", { name: "Hand" })).toHaveValue("1");
  const back = closed.getByRole("button", { name: "Back to lobby" });
  await expect(back).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(closed).toBeVisible();

  await back.click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByText("No live tables yet.", { exact: false })).toBeVisible();
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
  // The dialog already explained the closure, so the lobby does not repeat it.
  await expect(page.getByText("Your table closed", { exact: false })).toHaveCount(0);
});

test("the lobby explains an idle closure that happened while the player was away", async ({ page, request }) => {
  await openActiveTable(page, request);
  await page.getByRole("link", { name: "Back to lobby" }).click();
  await expect(page.getByRole("button", { name: "Return to your table" })).toBeVisible();
  await request.post(`${fixture}/__test/close-idle`);
  await request.post(`${fixture}/__test/finish-close`);

  const notice = page.getByText("Your table closed after 5 minutes without activity. Your chips were returned to your chip balance.");
  await expect(notice).toBeVisible();
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
  // The notice reloads the list at once (well inside the 5 s poll): the closed table is gone, no "Return to your table".
  await expect(page.getByRole("button", { name: "Open 6-seat table" })).toBeEnabled({ timeout: 3_000 });
  await expect(page.getByText("No live tables yet.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

test("joining a table that has closed shows the closed dialog", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "closed" } });
  await page.goto("/table/fixture-table");
  const closed = page.getByRole("alertdialog", { name: "This table has closed" });
  await expect(closed).toBeVisible();
  await expect(closed).toHaveAccessibleDescription(
    "This table is no longer available. Any chips you had at this table are back in your chip balance.");
  // The refusal is an outcome, not a connection fault.
  await expect(page.getByText("Could not join this table", { exact: false })).toHaveCount(0);
  // No snapshot of the table, so no hand to verify.
  await expect(closed.getByRole("button", { name: "Verify hand" })).toHaveCount(0);
  await closed.getByRole("button", { name: "Back to lobby" }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByText("No live tables yet.", { exact: false })).toBeVisible();
});

test("back from a dropped connection to a table that closed mid-hand, the closed dialog verifies that hand", async ({ page, request }) => {
  await openActiveTable(page, request);
  // The page's last snapshot is hand 1 preflop. While it is offline the closure settles hand 1 and closes the table;
  // the page learns of it only from the refused re-join, so the closed dialog has only that mid-hand snapshot.
  expect(await (await request.post(`${fixture}/__test/close-while-away`)).json()).toEqual({ status: "CLOSED", handNumber: 1 });
  const closed = page.getByRole("alertdialog", { name: "This table has closed" });
  await expect(closed).toBeVisible();
  await expect(closed).toHaveAccessibleDescription(
    "This table is no longer available. Any chips you had at this table are back in your chip balance.");
  // Closure settled the hand in progress, so it can be verified, and it is the default.
  const verify = closed.getByRole("button", { name: "Verify hand" });
  await expect(verify).toBeVisible();
  const hand = closed.getByRole("spinbutton", { name: "Hand" });
  await expect(hand).toHaveValue("1");

  // A later hand the page never saw may exist: the snapshot's hand is not a limit here, and the server decides.
  await expect(hand).not.toHaveAttribute("max");
  const requested: string[] = [];
  // The fixture has no hand records; answer as the server does for a hand this player has none of (keeping its CORS headers).
  await page.route(`${fixture}/api/tables/*/hands/*/audit`, async (route) => {
    requested.push(new URL(route.request().url()).pathname);
    await route.fulfill({ response: await route.fetch(), status: 404, json: { error: "Completed hand not found for this player" } });
  });
  await hand.fill("2");
  await verify.click();
  await expect(closed.getByRole("status")).toHaveText("Completed hand not found for this player");
  expect(requested).toEqual(["/api/tables/fixture-table/hands/2/audit"]);
});

test("a host who leaves a table nobody joined closes it", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Open 6-seat table" }).click();
  await expect(page).toHaveURL(/3107\/table\/fixture-table$/);
  await expect(page.getByText("Waiting for another person to take a seat.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "← Leave table", exact: true }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByText("No live tables yet.", { exact: false })).toBeVisible();
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
  // The host chose to leave: no closed dialog on the way out, and no lobby notice.
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText("Your table closed", { exact: false })).toHaveCount(0);
});

test("a player who kept their seat gets the warning in the lobby and can keep the table open from there", async ({ page, request }) => {
  await keepSeatInLobby(page, request);
  await request.post(`${fixture}/__test/idle-warning`);

  const notice = page.getByRole("alertdialog", { name: warningName });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("aria-modal", "false");
  await expect(notice).toHaveAccessibleDescription(
    /No one has played at Browser test table for 5 minutes\. The table closes in \d+ seconds? unless you're still here\./);
  const countdown = notice.getByTestId("idle-countdown");
  const first = Number(await countdown.textContent());
  // The warning lasts WARNING_SECONDS and counts down from (about) all of it.
  expect(first).toBeGreaterThanOrEqual(WARNING_SECONDS - 5);
  expect(first).toBeLessThanOrEqual(WARNING_SECONDS);
  await expect.poll(async () => Number(await countdown.textContent())).toBeLessThan(first);
  const keep = notice.getByRole("button", { name: "I'm still here" });
  await expect(keep).toBeFocused();
  await expect(notice.getByRole("link", { name: "Go to table" })).toBeVisible();
  // It does not block the lobby, and Escape does not dismiss it.
  await expect(page.getByRole("button", { name: "Return to your table" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(notice).toBeVisible();

  await keep.click();
  await expect(notice).toBeHidden();
  expect(await keepAliveStats(request)).toMatchObject({ count: 1, closingAt: null });
  await expect(page).toHaveURL(/3107\/$/);
});

test("on a phone held in landscape the lobby warning's actions are on screen and work", async ({ page, request }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await keepSeatInLobby(page, request);
  const notice = page.getByRole("alertdialog", { name: warningName });
  let kept = 0;
  // Large and small phones. The lobby has no action dock, so nothing is held back for one.
  for (const viewport of [{ width: 915, height: 412 }, { width: 780, height: 360 }]) {
    await page.setViewportSize(viewport);
    await request.post(`${fixture}/__test/idle-warning`);
    await expect(notice).toBeVisible();
    const keep = notice.getByRole("button", { name: "I'm still here" });
    await expect(keep).toBeFocused();
    await expectReachable(keep);
    await expectReachable(notice.getByRole("link", { name: "Go to table" }));
    // The whole warning fits, countdown and title included: none of it is scrolled away to reach the actions.
    await expect(notice).toBeInViewport({ ratio: 1 });
    await keep.click();
    await expect(notice).toBeHidden();
    expect(await keepAliveStats(request)).toMatchObject({ count: ++kept, closingAt: null });
  }
  await expect(page).toHaveURL(/3107\/$/);
});

test("the lobby warning ends when another player keeps the table open, and \"Go to table\" opens the table's own warning", async ({ page, request }) => {
  await keepSeatInLobby(page, request);
  await request.post(`${fixture}/__test/idle-warning`);
  const notice = page.getByRole("alertdialog", { name: warningName });
  await expect(notice).toBeVisible();
  await request.post(`${fixture}/__test/keep-alive-as`, { data: { userId: "fixture-player-1" } });
  await expect(notice).toBeHidden();

  await request.post(`${fixture}/__test/idle-warning`);
  await expect(notice).toBeVisible();
  await notice.getByRole("link", { name: "Go to table" }).click();
  await expect(page).toHaveURL(/3107\/table\/fixture-table$/);
  // On the table's own page only the table's warning shows, not the app-wide one as well.
  const own = page.getByRole("alertdialog", { name: warningName });
  await expect(own).toBeVisible();
  await expect(own).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Go to table" })).toHaveCount(0);
  await expect(own.getByRole("button", { name: "I'm still here" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Call 10", exact: true })).toBeEnabled();
});

test("the lobby warning gives way to the closed notice when the table closes", async ({ page, request }) => {
  await keepSeatInLobby(page, request);
  await request.post(`${fixture}/__test/idle-warning`);
  const notice = page.getByRole("alertdialog", { name: warningName });
  await expect(notice).toBeVisible();
  await request.post(`${fixture}/__test/close-idle`);
  await request.post(`${fixture}/__test/finish-close`);
  // The cash-out from that table ends its warning; the lobby explains the closure instead.
  await expect(notice).toBeHidden();
  await expect(page.getByText(closedNoticeText)).toBeVisible();
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
});

test("opening another table's page clears the lobby's closed-table notice", async ({ page, request }) => {
  const closedNotice = await closedWhileInLobby(page, request);
  // The player is seated at a different table (e.g. a friend seated them), and opens it.
  await request.post(`${fixture}/__test/reset`, { data: { mode: "active", tableId: "second-table" } });
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: "Return to your table" }).click();
  await expect(page).toHaveURL(/3107\/table\/second-table$/);
  await expect(page.getByRole("button", { name: "Call 10", exact: true })).toBeEnabled();
  await page.getByRole("link", { name: "Back to lobby" }).click();
  await expect(page.getByRole("button", { name: "Return to your table" })).toBeVisible();
  await expect(closedNotice).toHaveCount(0);
});

test("opening a new table clears the lobby's closed-table notice", async ({ page, request }) => {
  const closedNotice = await closedWhileInLobby(page, request);
  await page.getByRole("button", { name: "Open 6-seat table" }).click();
  await expect(page).toHaveURL(/3107\/table\/fixture-table$/);
  await expect(page.getByText("Waiting for another person to take a seat.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Back to lobby" }).click();
  await expect(page.getByRole("button", { name: "Return to your table" })).toBeVisible();
  await expect(closedNotice).toHaveCount(0);
});

test("a refusal about another table does not close this one", async ({ page, request }) => {
  const call = await openActiveTable(page, request);
  // E.g. the app-wide warning's "I'm still here" for a table this player left.
  await request.post(`${fixture}/__test/server-error`, { data: { code: "TABLE_CLOSED", message: "This table has closed", tableId: "another-table" } });
  await request.post(`${fixture}/__test/server-error`, { data: { code: "RATE_LIMITED", message: "Too many requests", tableId: "another-table" } });
  // Delivered after both refusals on the same connection: once it shows, they have been handled.
  await request.post(`${fixture}/__test/idle-warning`);
  await expect(page.getByRole("alertdialog", { name: warningName })).toBeVisible();
  await expect(page.getByRole("alertdialog", { name: "This table has closed" })).toHaveCount(0);
  await expect(page.getByText("Too many requests")).toHaveCount(0);
  await expect(call).toBeEnabled();

  // The same refusal about this table closes it.
  await request.post(`${fixture}/__test/server-error`, { data: { code: "TABLE_CLOSED", message: "This table has closed", tableId: "fixture-table" } });
  await expect(page.getByRole("alertdialog", { name: "This table has closed" })).toBeVisible();
});

test("leaving as the table closes takes the player to the lobby with their chips back", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "waiting" } });
  await page.goto("/table/fixture-table");
  const leave = page.getByRole("button", { name: "← Leave table", exact: true });
  await expect(leave).toBeEnabled();
  // The idle closure commits just before the leave is handled, which is refused with TABLE_CLOSED.
  await request.post(`${fixture}/__test/close-before-next-leave`);
  await leave.click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
  // Closure cashed the seat out: nothing is left to settle, and no error or dialog follows the player out.
  await expect(page.getByText("The current hand is finishing", { exact: false })).toHaveCount(0);
  await expect(page.getByText("This table has closed")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  // The lobby says why the chips came back: the table closed for inactivity as they left.
  await expect(page.getByText(closedNoticeText)).toBeVisible();
});
