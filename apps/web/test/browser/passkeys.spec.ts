import type { BrowserContext, Page } from "@playwright/test";
import { accountMenuButton, expectSignedIn, fixtureRequests, fixtureUser, openAccountMenu } from "../support/auth";
import { expect, test } from "../support/fixtures";

/**
 * WebAuthn refuses an IP address as the relying party ID, so these specs open the app at localhost (same server) and
 * give it a software authenticator through the Chrome DevTools Protocol (both projects run the Chrome channel).
 */
const LOCAL = "http://localhost:3107";

async function onLocalhost(context: BrowserContext) {
  await context.addCookies([{ name: "poker_session_hint", value: "1", domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
}

async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

test("add, rename and remove a passkey", async ({ page, context, request }) => {
  await onLocalhost(context);
  await addAuthenticator(page);
  await page.goto(`${LOCAL}/account/security`);
  const card = page.locator("#passkeys");
  await expect(card.getByText("No passkeys yet.")).toBeVisible();
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.locator("main").getByText(/^Passkey added: Chrome on /)).toBeVisible();
  const list = card.getByRole("list", { name: "Your passkeys" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  const [registered] = await fixtureRequests(request, "/api/account/passkeys");
  expect(Object.keys(registered!.body!).sort()).toEqual(["challengeToken", "credential", "name"]);

  // Rename: Enter saves.
  await list.getByRole("button", { name: /^Rename / }).click();
  const name = list.getByLabel("Passkey name");
  await name.fill("My laptop");
  await name.press("Enter");
  await expect(list.getByText("My laptop", { exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: "Rename My laptop" })).toBeFocused();
  // Escape cancels.
  await list.getByRole("button", { name: "Rename My laptop" }).click();
  await list.getByLabel("Passkey name").fill("Something else");
  await list.getByLabel("Passkey name").press("Escape");
  await expect(list.getByText("My laptop", { exact: true })).toBeVisible();

  // Remove: asks first, then the step-up window is still fresh from sign-in.
  await list.getByRole("button", { name: "Remove My laptop" }).click();
  await page.getByRole("alertdialog", { name: "Remove this passkey?" }).getByRole("button", { name: "Remove passkey" }).click();
  await expect(page.locator("main").getByText("Passkey removed: My laptop.")).toBeVisible();
  await expect(card.getByText("No passkeys yet.")).toBeVisible();
  expect((await fixtureUser(request, "Player-0")).passkeys).toEqual([]);
});

test("the same authenticator cannot be added twice", async ({ page, context }) => {
  await onLocalhost(context);
  await addAuthenticator(page);
  await page.goto(`${LOCAL}/account/security`);
  const card = page.locator("#passkeys");
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(card.getByRole("list", { name: "Your passkeys" }).getByRole("listitem")).toHaveCount(1);
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(card.getByRole("alert")).toHaveText("This passkey is already on your account.");
});

test("after signing out, the passkey signs straight back in (no password, no code)", async ({ page, context, request }) => {
  await onLocalhost(context);
  await addAuthenticator(page);
  await page.goto(`${LOCAL}/account/security`);
  await page.locator("#passkeys").getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.locator("main").getByText(/^Passkey added/)).toBeVisible();

  await openAccountMenu(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  // The software authenticator answers the username field's passkey autofill by itself (a person picks the passkey
  // there); otherwise the button does it. Either way it is the passkey route, with no password.
  await Promise.race([
    page.getByRole("button", { name: "Sign in with a passkey" }).click({ timeout: 10_000 }).catch(() => undefined),
    accountMenuButton(page).waitFor({ timeout: 10_000 }).catch(() => undefined),
  ]);
  await expectSignedIn(page, "Player-0");
  expect((await fixtureRequests(request, "/api/auth/passkey/login")).length).toBeGreaterThan(0);
  expect(await fixtureRequests(request, "/api/auth/login")).toHaveLength(0);
});
