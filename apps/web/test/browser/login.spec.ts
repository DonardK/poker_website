import type { Page } from "@playwright/test";
import { createUser, expectSignedIn, fixtureRequests } from "../support/auth";
import { expect, fixture, test } from "../support/fixtures";

test.use({ session: "signed-out" });

function pageAlert(page: Page) {
  return page.locator("main").getByRole("alert");
}

async function fill(page: Page, identifier: string, password: string) {
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
}

const signIn = (page: Page) => page.getByRole("button", { name: "Sign in", exact: true });

test("a username or an email signs in, sending identifier, remember and a browser-check token", async ({ page, request }) => {
  await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await fill(page, "Player-0", "fixture-password-0");
  await signIn(page).click();
  await expect(page).toHaveURL(/3107\/$/);
  await expectSignedIn(page, "Player-0");
  let [sent] = await fixtureRequests(request, "/api/auth/login");
  expect(sent!.body).toEqual({ identifier: "Player-0", password: "fixture-password-0", remember: true, turnstileToken: "stub-token-1" });

  // Again with the email address, from a fresh signed-out state.
  await request.post(`${fixture}/__test/auth`, { data: { reset: true, signedOut: true } });
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto("/login");
  await fill(page, "player0@example.test", "fixture-password-0");
  await page.getByLabel("Stay signed in on this device").uncheck();
  await signIn(page).click();
  await expectSignedIn(page, "Player-0");
  [sent] = await fixtureRequests(request, "/api/auth/login");
  expect(sent!.body).toMatchObject({ identifier: "player0@example.test", remember: false });
});

test("a wrong password reads the same as an unknown user, clears the password and never resends a spent token", async ({ page, request }) => {
  await page.goto("/login");
  await fill(page, "Player-0", "not-the-password");
  await signIn(page).click();
  await expect(pageAlert(page)).toHaveText("That username or email and password don't match.");
  const password = page.getByLabel("Password", { exact: true });
  await expect(password).toHaveValue("");
  await expect(password).toBeFocused();

  await fill(page, "Nobody_Here", "not-the-password");
  await expect(signIn(page)).toBeEnabled();
  await signIn(page).click();
  await expect(pageAlert(page)).toHaveText("That username or email and password don't match.");

  const tokens = (await fixtureRequests(request, "/api/auth/login")).map((r) => r.body?.turnstileToken);
  expect(tokens).toEqual(["stub-token-1", "stub-token-2"]);
  expect(await page.evaluate(() => (window as unknown as { __turnstile: { resets: number } }).__turnstile.resets)).toBe(2);
});

test("too many attempts count down with the button disabled", async ({ page, request }) => {
  await page.goto("/login");
  await request.post(`${fixture}/__test/auth`, { data: { nextError: {
    path: "/api/auth/login", status: 429, json: { error: "Too many requests", retryable: true }, headers: { "Retry-After": "3" },
  } } });
  await fill(page, "Player-0", "fixture-password-0");
  await signIn(page).click();
  await expect(pageAlert(page)).toContainText("Too many attempts");
  const waiting = page.getByRole("button", { name: /^Try again in \d+ s$/ });
  await expect(waiting).toBeDisabled();
  await expect(signIn(page)).toBeEnabled({ timeout: 6_000 });
});

test("a correct password after 'This wasn't me' asks for a new password first", async ({ page, request }) => {
  await createUser(request, { username: "locked_down", password: "the-old-password", passwordResetRequired: true });
  await page.goto("/login");
  await fill(page, "locked_down", "the-old-password");
  await signIn(page).click();
  await expect(pageAlert(page)).toContainText("For your security, set a new password before signing in.");
  await expect(pageAlert(page).getByRole("link", { name: "Set a new password" })).toHaveAttribute("href", "/reset-password");
});

test("the identifier field offers passkeys from autofill, and a passkey button is there", async ({ page, request }) => {
  await page.goto("/login");
  const identifier = page.getByLabel("Username or email");
  await expect(identifier).toHaveAttribute("autocomplete", "username webauthn");
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  // Conditional mediation asks for a challenge once the page knows nobody is signed in.
  await expect.poll(async () => (await fixtureRequests(request, "/api/auth/passkey/options")).length).toBeGreaterThan(0);
  // On an IP-address host the browser cannot offer passkeys; the page says nothing about it.
  await expect(pageAlert(page)).toHaveCount(0);
});

test("no guest wording anywhere a visitor can land", async ({ page }) => {
  for (const path of ["/login", "/signup", "/terms", "/privacy", "/complaints"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByText(/guest/i)).toHaveCount(0);
  }
});
