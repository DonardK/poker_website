import type { Page } from "@playwright/test";
import { expectSignedIn, fixtureRequests } from "../support/auth";
import { expect, fixture, test, TERMS_VERSION } from "../support/fixtures";

const PLAY_CHIPS_NOTICE = "Play chips have no cash value and cannot be redeemed.";

test.use({ session: "signed-out" });

/** The page's own message (Next.js keeps an empty route announcer with role="alert" outside <main>). */
function pageAlert(page: Page) {
  return page.locator("main").getByRole("alert");
}

async function fillSignup(page: Page, opts: { username?: string; email?: string; password?: string } = {}) {
  await page.getByLabel("Username").fill(opts.username ?? "river_rat");
  await page.getByLabel("Email").fill(opts.email ?? "river@example.test");
  await page.getByLabel("Password", { exact: true }).fill(opts.password ?? "a-long-enough-password");
}

async function consent(page: Page) {
  await page.getByLabel("I confirm that I am 18 years of age or older.").check();
  await page.getByLabel(/I accept the Terms of Service/).check();
}

test("creating an account needs 18+ and terms, sends the acceptance as JSON and lands on /welcome", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await page.goto("/signup");
  const create = page.getByRole("button", { name: "Create account" });
  const age = page.getByLabel("I confirm that I am 18 years of age or older.");
  const terms = page.getByLabel(/I accept the Terms of Service/);
  await expect(age).not.toBeChecked();
  await expect(terms).not.toBeChecked();
  await expect(page.locator('main a[href="/terms"]').first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy Notice" })).toHaveAttribute("href", "/privacy");
  await fillSignup(page);
  await expect(create).toBeDisabled();
  await age.check();
  await expect(create).toBeDisabled();
  await age.uncheck();
  await terms.check();
  await expect(create).toBeDisabled();
  await age.check();
  await expect(create).toBeEnabled();
  await create.click();

  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole("heading", { level: 1, name: "You're in, river_rat" })).toBeVisible();
  await expectSignedIn(page, "river_rat");
  const [sent] = await fixtureRequests(request, "/api/auth/register");
  expect(sent!.body).toEqual({
    username: "river_rat", email: "river@example.test", password: "a-long-enough-password",
    remember: true, acceptTerms: true, confirmAge: true, termsVersion: TERMS_VERSION, turnstileToken: "stub-token-1",
  });
  await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();

  // Recommended, never forced: the welcome page offers protection and lets the player skip it.
  await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
  await expect(page.getByText("r***@example.test")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Protect your account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/3107\/$/);
  await expect(page.getByText(PLAY_CHIPS_NOTICE).first()).toBeVisible();
  // The unconfirmed address is flagged until it is confirmed.
  await expect(page.getByText("Confirm your email to secure your account")).toBeVisible();
});

test("terms refusals from the server are explained", async ({ page, request }) => {
  await page.goto("/signup");
  await fillSignup(page);
  await consent(page);
  const create = page.getByRole("button", { name: "Create account" });

  await request.post(`${fixture}/__test/auth`, { data: { nextError: {
    path: "/api/auth/register", status: 409,
    json: { error: "The terms have been updated; please review and accept the current version", code: "TERMS_OUTDATED", currentVersion: "2026-11-01" },
  } } });
  await create.click();
  await expect(pageAlert(page)).toContainText("Our terms have been updated (version 2026-11-01)");
  await expect(pageAlert(page)).toContainText("Reload the page");

  await request.post(`${fixture}/__test/auth`, { data: { nextError: {
    path: "/api/auth/register", status: 400, json: { error: "Please accept the terms and confirm you are 18 or older", code: "TERMS_REQUIRED" },
  } } });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(pageAlert(page)).toHaveText("To continue, confirm that you are 18 or older and accept the Terms of Service and Privacy Notice.");
  await expect(page.getByRole("button", { name: /^Account menu/ })).toHaveCount(0);
  // Each attempt sent a fresh browser-check token (a token is single use).
  const tokens = (await fixtureRequests(request, "/api/auth/register")).map((r) => r.body?.turnstileToken);
  expect(tokens).toEqual(["stub-token-1", "stub-token-2"]);
});

test("a taken username goes on its field; other conflicts keep their own message", async ({ page, request }) => {
  await request.post(`${fixture}/__test/users`, { data: { username: "taken_name" } });
  await page.goto("/signup");
  await fillSignup(page, { username: "Taken_Name" });
  await consent(page);
  await page.getByRole("button", { name: "Create account" }).click();
  const username = page.getByLabel("Username");
  await expect(page.getByText("That username is taken. Try another.")).toBeVisible();
  await expect(username).toHaveAttribute("aria-invalid", "true");
  await expect(username).toBeFocused();

  // Another 409 (here the email) is deliberately generic and names no field.
  await username.fill("fresh_name");
  await page.getByLabel("Email").fill("player0@example.test");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(pageAlert(page)).toHaveText("Registration could not be completed with these details");
});

test("passwords: 12 characters, 72 bytes, a strength meter, and the breach check", async ({ page, request }) => {
  await page.goto("/signup");
  await fillSignup(page, { password: "elevenchars" });
  await consent(page);
  const password = page.getByLabel("Password", { exact: true });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("aria-invalid", "true");

  // Twelve characters, but more than 72 bytes in UTF-8.
  await password.fill("😀".repeat(19));
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Too long — passwords can be up to 72 bytes", { exact: false })).toBeVisible();

  // The strength estimate is announced politely and updates as the password changes.
  const live = page.locator("#new-password-strength");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await password.fill("password1234");
  await expect(live).toContainText(/Strength: (Too weak|Fair)/);
  await password.fill("correct horse battery staple violet");
  await expect(live).toContainText(/Strength: (Strong|Very strong)/);

  await password.fill("violet-kettle-breach-9183");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("This password has appeared in a data breach. Choose a different one.")).toBeVisible();
  expect((await fixtureRequests(request, "/api/auth/register")).length).toBeGreaterThan(0);
});

test("without ticking 'Stay signed in', nothing is remembered on this device", async ({ page }) => {
  await page.goto("/signup");
  await fillSignup(page, { username: "quiet_one", email: "quiet@example.test" });
  await page.getByLabel("Stay signed in on this device").uncheck();
  await consent(page);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(await page.evaluate(() => localStorage.getItem("poker-remembered-accounts"))).toBeNull();
});

test("signing in is not account creation: no age gate on /login", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("I confirm that I am 18 years of age or older.")).toHaveCount(0);
  await page.getByLabel("Username or email").fill("Player-0");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password-0");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
});
