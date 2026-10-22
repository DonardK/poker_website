import { expect, test, type Page } from "@playwright/test";

/**
 * A fresh account on the local edge, through the Next dev proxy (there is no
 * guest play: every player signs up). The username is unique per run, so the
 * spec can run again against the same database. The welcome page recommends
 * two-step verification; "Skip for now" goes on to the lobby.
 */
async function signUp(page: Page, username: string): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.test`);
  // Not a known-breached password, and it must not contain the username.
  await page.getByLabel("Password", { exact: true }).fill("copper-meadow-lantern-drift-42");
  await page.getByLabel("I confirm that I am 18 years of age or older.").check();
  await page.getByLabel(/I accept the Terms of Service/).check();
  const create = page.getByRole("button", { name: "Create account" });
  // Enabled once the Turnstile token arrives. The dummy site key
  // 1x00000000000000000000AA passes at once; an empty token is a 403.
  await expect(create).toBeEnabled();
  await create.click();
  await page.waitForURL(/\/welcome$/);
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page.getByTestId("balance")).toBeVisible();
}

async function faceUpLabels(page: Page): Promise<string[]> {
  return page.getByRole("img", { name: / of / }).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? ""),
  );
}

async function actIfTurn(page: Page): Promise<boolean> {
  const group = page.getByRole("group", { name: "Your poker actions" });
  if (!(await group.isVisible().catch(() => false))) return false;
  const check = group.getByRole("button", { name: "Check", exact: true });
  const call = group.getByRole("button", { name: /^Call / });
  for (const button of [check, call]) {
    const visible = await button.isVisible().catch(() => false);
    const enabled = visible && await button.isEnabled().catch(() => false);
    if (!enabled) continue;
    await button.click({ timeout: 3_000 });
    return true;
  }
  return false;
}

test("two new accounts play a hand on the local edge", async ({ browser }) => {
  // Sign-ups, a full hand and a turn running out on its clock (base time plus time bank, about 50 s).
  test.setTimeout(300_000);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  let tableGets = 0;
  await pageB.route("**/api/tables**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    tableGets += 1;
    if (tableGets > 1) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  const run = Date.now().toString(36);
  await signUp(pageA, `live_a_${run}`);
  await signUp(pageB, `live_b_${run}`);
  await pageB.waitForResponse((response) => response.url().includes("/api/tables") && response.request().method() === "GET" && response.ok());

  const tableName = `Live ${Date.now().toString(36)}`;
  await pageA.getByRole("button", { name: "Custom table" }).click();
  await pageA.getByLabel("Table name").fill(tableName);
  const open = pageA.getByRole("button", { name: "Open table" });
  await expect(open).toBeEnabled();
  const getsBeforeCreate = tableGets;
  await open.click();
  await pageA.waitForURL(/\/table\/.+/);

  const joined = pageB.getByRole("button", { name: tableName });
  await expect(joined).toBeVisible();
  expect(tableGets).toBe(getsBeforeCreate);

  await joined.click();
  await pageB.waitForURL(/\/table\/.+/);
  await pageB.getByTestId("seat-claim").first().click();
  await pageB.getByRole("button", { name: "Confirm buy-in" }).click();

  await expect(pageA.getByRole("img", { name: / of / })).toHaveCount(2);
  await expect(pageB.getByRole("img", { name: / of / })).toHaveCount(2);
  await expect(pageA.getByRole("img", { name: "Face-down card" })).toHaveCount(2);
  await expect(pageB.getByRole("img", { name: "Face-down card" })).toHaveCount(2);
  const cardsA = await faceUpLabels(pageA);
  const cardsB = await faceUpLabels(pageB);
  expect(cardsA).toHaveLength(2);
  expect(cardsB).toHaveLength(2);
  expect(cardsA.filter((card) => cardsB.includes(card))).toEqual([]);

  const stacksBefore = (await pageA.locator(".seat-hud").allInnerTexts()).join("\n");
  let revision = "";
  let board = "";
  let hand = "";
  const tableUrl = pageB.url();
  // A time budget, not a step count: each action round-trips through the table Durable Object and
  // Postgres, which takes a second or more on a slow local machine.
  const handDeadline = Date.now() + 90_000;
  while (Date.now() < handDeadline) {
    await actIfTurn(pageA);
    await actIfTurn(pageB);
    const phase = await pageA.getByTestId("table-snapshot").getAttribute("data-phase");
    if (phase === "SHOWDOWN" || phase === "COMPLETE") {
      const marker = pageB.getByTestId("table-snapshot");
      revision = (await marker.getAttribute("data-revision")) ?? "";
      board = (await marker.getAttribute("data-board")) ?? "";
      hand = (await marker.getAttribute("data-hand")) ?? "";
      break;
    }
    await pageA.waitForTimeout(80);
  }
  expect(revision).not.toBe("");

  // Drop the lobby-request route first: a handler still waiting on a closed page would hold up the context's close.
  await pageB.unrouteAll({ behavior: "ignoreErrors" });
  await pageB.close();
  const resumed = await contextB.newPage();
  await resumed.goto(tableUrl);
  const resumedMarker = resumed.getByTestId("table-snapshot");
  // The reopened page shows the table as it is now: the same finished hand, or the next one when the
  // table dealt it while the page was loading (a few seconds after showdown). Never an older state.
  await expect.poll(async () => Number((await resumedMarker.getAttribute("data-revision")) ?? -1)).toBeGreaterThanOrEqual(Number(revision));
  const resumedHand = await resumedMarker.getAttribute("data-hand");
  if (resumedHand === hand) await expect(resumedMarker).toHaveAttribute("data-board", board);
  else expect(Number(resumedHand)).toBe(Number(hand) + 1);

  await expect.poll(async () => (await pageA.locator(".seat-hud").allInnerTexts()).join("\n")).not.toBe(stacksBefore);

  let sawTurn = false;
  await expect.poll(async () => {
    const a = await pageA.getByRole("group", { name: "Your poker actions" }).isVisible().catch(() => false);
    const b = await resumed.getByRole("group", { name: "Your poker actions" }).isVisible().catch(() => false);
    if (a || b) sawTurn = true;
    if (!sawTurn) return "waiting";
    return a || b ? "acting" : "done";
  }, { timeout: 90_000, intervals: [200] }).toBe("done");

  await contextA.close();
  await contextB.close();
});
