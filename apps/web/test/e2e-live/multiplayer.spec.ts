import { expect, test, type Page } from "@playwright/test";

/** Guest session on the local edge, through the Next dev proxy. */
async function playAsGuest(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("checkbox", { name: /18 years of age or older/ }).check();
  await page.getByRole("checkbox", { name: /Terms of Service/ }).check();
  const guest = page.getByRole("button", { name: "Play as guest" });
  await expect(guest).toBeEnabled();
  // Dummy site key 1x00000000000000000000AA does not render an iframe. It
  // writes the token into a hidden input. An empty token is a 403.
  await expect(page.locator("input[name='cf-turnstile-response']")).toHaveValue(/.+/);
  await guest.click();
  await expect(page.getByText("Play-chip balance")).toBeVisible();
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

test("two guests play a hand on the local edge", async ({ browser }) => {
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

  await playAsGuest(pageA);
  await playAsGuest(pageB);
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
  for (let step = 0; step < 40; step += 1) {
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

  await pageB.close();
  const resumed = await contextB.newPage();
  await resumed.goto(tableUrl);
  const resumedMarker = resumed.getByTestId("table-snapshot");
  await expect(resumedMarker).toHaveAttribute("data-revision", revision);
  await expect(resumedMarker).toHaveAttribute("data-board", board);
  await expect(resumedMarker).toHaveAttribute("data-hand", hand);

  await expect.poll(async () => (await pageA.locator(".seat-hud").allInnerTexts()).join("\n")).not.toBe(stacksBefore);

  let sawTurn = false;
  await expect.poll(async () => {
    const a = await pageA.getByRole("group", { name: "Your poker actions" }).isVisible().catch(() => false);
    const b = await resumed.getByRole("group", { name: "Your poker actions" }).isVisible().catch(() => false);
    if (a || b) sawTurn = true;
    if (!sawTurn) return "waiting";
    return a || b ? "acting" : "done";
  }, { timeout: 25_000, intervals: [200] }).toBe("done");

  await contextA.close();
  await contextB.close();
});
