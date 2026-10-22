import { createUser, expectOnLogin, expectSignedIn, fixtureAuth, fixtureRequests, signInViaUi } from "../support/auth";
import { expect, fixture, test, TERMS_VERSION } from "../support/fixtures";

test.describe("signed out", () => {
  test.use({ session: "signed-out" });

  test("every page but the legal and sign-in pages sends a visitor to sign in, remembering where they were going", async ({ page }) => {
    for (const [path, next] of [
      ["/", "%2F"], ["/table/fixture-table", "%2Ftable%2Ffixture-table"], ["/account/security", "%2Faccount%2Fsecurity"],
      ["/welcome", "%2Fwelcome"], ["/no-such-page", "%2Fno-such-page"],
    ] as const) {
      await page.context().clearCookies();
      await page.goto(path);
      await expectOnLogin(page, next);
    }
  });

  test("the legal pages are readable signed out, each with its footer and draft notice", async ({ page }) => {
    for (const path of ["/terms", "/privacy", "/rules", "/fairness", "/responsible-gaming", "/complaints"]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("note", { name: "Draft notice" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Legal" })).toBeVisible();
      await expect(page.getByRole("link", { name: "← Sign in" })).toBeVisible();
    }
  });

  test("the client gate redirects too, without the middleware's help (an old or missing hint)", async ({ page, context }) => {
    // A hint cookie that no longer matches a session: the middleware lets the request through, the client gate decides.
    await context.addCookies([{ name: "poker_session_hint", value: "1", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
    await page.goto("/table/fixture-table");
    await expectOnLogin(page, "%2Ftable%2Ffixture-table");
  });

  test("next= is followed only to pages on this site", async ({ page }) => {
    for (const next of ["https://evil.example", "//evil.example", "/%2F%2Fevil.example", "/\\evil.example", "javascript:alert(1)"]) {
      await page.context().clearCookies();
      await fixtureAuth(page.request, { reset: true, signedOut: true });
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await signInViaUi(page, { identifier: "Player-0", password: "fixture-password-0", stay: false });
      await expect(page).toHaveURL(/3107\/$/);
      await expectSignedIn(page);
    }
    await page.context().clearCookies();
    await fixtureAuth(page.request, { reset: true, signedOut: true });
    await page.goto(`/login?next=${encodeURIComponent("/table/fixture-table")}`);
    await signInViaUi(page, { identifier: "Player-0", password: "fixture-password-0", stay: false });
    await expect(page).toHaveURL(/3107\/table\/fixture-table$/);
  });

  test("the game server being down is not a sign-out: no redirect, and Try again", async ({ page, context }) => {
    await context.addCookies([{ name: "poker_session_hint", value: "1", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
    await page.route(`${fixture}/api/auth/refresh`, (route) => route.fulfill({ status: 503, json: { error: "Service temporarily unavailable", retryable: true } }));
    await page.goto("/account/security");
    await expect(page.getByRole("heading", { name: "Game server unavailable" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page).toHaveURL(/\/account\/security$/);
  });
});

test.describe("signed in", () => {
  test("/login and /signup go straight on to next", async ({ page }) => {
    await page.goto("/login?next=%2Faccount%2Fsecurity");
    await expect(page).toHaveURL(/\/account\/security$/);
    await page.goto("/signup");
    await expect(page).toHaveURL(/3107\/$/);
    await expectSignedIn(page);
  });

  test("while the session is checked, a splash shows instead of the page", async ({ page, request }) => {
    await request.post(`${fixture}/__test/hold-refresh`);
    await page.goto("/");
    await expect(page.locator("main[aria-busy='true']")).toBeVisible();
    await expect(page.getByText("Checking your session…")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Account menu/ })).toHaveCount(0);
    await request.post(`${fixture}/__test/release-refresh`);
    await expectSignedIn(page);
  });

  test("an API that never sets the hint costs one trip through /login, not a loop", async ({ page, context, request }) => {
    await context.clearCookies();
    await fixtureAuth(request, { noHint: true });
    await page.goto("/account");
    // One bounce through /login (the refresh there finds the session), then back.
    await expect(page).toHaveURL(/\/account$/);
    await expectSignedIn(page);
  });
});

test.describe("updated terms", () => {
  test.use({ session: "signed-out" });

  test("an account on older terms accepts the current ones (18+ and terms, both unticked) before anything else", async ({ page, request }) => {
    await createUser(request, { username: "Old_Terms", password: "old-terms-password-1", termsVersion: "2026-01-01" });
    await page.goto("/login?next=%2Faccount");
    await signInViaUi(page, { identifier: "Old_Terms", password: "old-terms-password-1" });
    await expect(page.getByRole("heading", { level: 1, name: "We've updated our terms" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Account menu/ })).toHaveCount(0);
    const accept = page.getByRole("button", { name: "Accept and continue" });
    const age = page.getByLabel("I confirm that I am 18 years of age or older.");
    const terms = page.getByLabel(/I accept the Terms of Service/);
    await expect(age).not.toBeChecked();
    await expect(terms).not.toBeChecked();
    await expect(accept).toBeDisabled();
    await age.check();
    await expect(accept).toBeDisabled();
    await terms.check();
    await accept.click();
    await expect(page).toHaveURL(/\/account$/);
    await expectSignedIn(page, "Old_Terms");
    const [sent] = await fixtureRequests(request, "/api/auth/terms/accept");
    expect(sent!.body).toEqual({ acceptTerms: true, confirmAge: true, termsVersion: TERMS_VERSION });
  });

  test("an account that never accepted any terms (null) is asked too", async ({ page, request }) => {
    await createUser(request, { username: "No_Terms", password: "no-terms-password-1", termsVersion: null });
    await page.goto("/login");
    await signInViaUi(page, { identifier: "No_Terms", password: "no-terms-password-1" });
    await expect(page.getByRole("heading", { level: 1, name: "We've updated our terms" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expectOnLogin(page);
  });
});
