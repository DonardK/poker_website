import type { Page } from "@playwright/test";
import { createUser, expectOnLogin, expectSignedIn, fixtureAuth, fixtureRequests, fixtureUser, mintToken, signInViaUi } from "../support/auth";
import { expect, test } from "../support/fixtures";

function pageAlert(page: Page) {
  return page.locator("main").getByRole("alert");
}

test.describe("confirming an email address", () => {
  test("signed in: the link confirms the address, the banner goes, and the token never reaches a URL", async ({ page, request }) => {
    await fixtureAuth(request, { emailVerified: false });
    await page.goto("/");
    await expect(page.getByText("Confirm your email to secure your account")).toBeVisible();
    const token = await mintToken(request, { kind: "verify" });
    await page.goto(`/verify-email#t=${token}`);
    await expect(page.locator("main").getByText("Email confirmed. Thank you.")).toBeVisible();
    expect(page.url()).not.toContain(token);
    expect(page.url()).not.toContain("#");
    await page.getByRole("link", { name: "Continue to the lobby" }).click();
    await expectSignedIn(page);
    await expect(page.getByText("Confirm your email to secure your account")).toHaveCount(0);
    const requests = await fixtureRequests(request);
    expect(requests.some((r) => r.url.includes(token))).toBe(false);
    expect(requests.filter((r) => r.path === "/api/auth/email/verify").map((r) => r.body)).toEqual([{ token }]);
  });

  test.describe("signed out", () => {
    test.use({ session: "signed-out" });

    test("the link works without a session and offers sign-in", async ({ page, request }) => {
      const token = await mintToken(request, { kind: "verify", username: "Player-1" });
      await page.goto(`/verify-email#t=${token}`);
      await expect(page.locator("main").getByText("Email confirmed. Thank you.")).toBeVisible();
      await page.getByRole("link", { name: "Sign in" }).last().click();
      await expect(page).toHaveURL(/\/login\?notice=verified$/);
      await expect(page.getByText("Email verified. Sign in to continue.")).toBeVisible();
    });

    test("a used, expired or incomplete link says so", async ({ page, request }) => {
      const token = await mintToken(request, { kind: "verify" });
      await page.goto(`/verify-email#t=${token}`);
      await expect(page.locator("main").getByText("Email confirmed. Thank you.")).toBeVisible();
      // Opened again later (a new page load: the address bar no longer holds the token).
      await page.goto("/terms");
      await page.goto(`/verify-email#t=${token}`);
      await expect(pageAlert(page)).toHaveText("That link is invalid, has expired or was already used.");
      const expired = await mintToken(request, { kind: "verify", expired: true });
      await page.goto(`/verify-email#t=${expired}`);
      await expect(pageAlert(page)).toHaveText("That link is invalid, has expired or was already used.");
      await page.goto("/verify-email");
      await expect(page.getByText("This link is incomplete.", { exact: false })).toBeVisible();
    });
  });
});

test.describe("confirming an email change", () => {
  test("nothing happens on page load; one click moves the account to the new address", async ({ page, request }) => {
    const token = await mintToken(request, { kind: "email-change", email: "new-address@example.test" });
    await page.goto(`/email-change#t=${token}`);
    expect(page.url()).not.toContain(token);
    expect(page.url()).not.toContain("#");
    const confirm = page.getByRole("button", { name: "Confirm new email" });
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(500);
    expect(await fixtureRequests(request, "/api/auth/email/change/confirm")).toHaveLength(0);

    await confirm.click();
    await expect(page.locator("main").getByText("Email changed. We'll use new-address@example.test from now on.")).toBeVisible();
    const calls = await fixtureRequests(request, "/api/auth/email/change/confirm");
    expect(calls.map((r) => r.body)).toEqual([{ token }]);
    expect((await fixtureRequests(request)).some((r) => r.url.includes(token))).toBe(false);
    expect((await fixtureUser(request, "Player-0")).email).toBe("new-address@example.test");

    await page.getByRole("link", { name: "Back to your account" }).click();
    await expect(page.locator("main").getByText("new-address@example.test", { exact: true })).toBeVisible();
    await expect(page.locator("main").getByText("Confirmed", { exact: true })).toBeVisible();
    await expectSignedIn(page);
  });

  test.describe("signed out", () => {
    test.use({ session: "signed-out" });

    test("a used, stale, wrong-kind or incomplete link says so and changes nothing", async ({ page, request }) => {
      const token = await mintToken(request, { kind: "email-change", username: "Player-1", email: "player1-new@example.test" });
      await page.goto(`/email-change#t=${token}`);
      await page.getByRole("button", { name: "Confirm new email" }).click();
      await expect(page.locator("main").getByText("Email changed.", { exact: false })).toBeVisible();
      await page.getByRole("link", { name: "Sign in" }).last().click();
      await expectOnLogin(page);

      // The same link again (a new page load: the address bar no longer holds the token).
      await page.goto(`/email-change#t=${token}`);
      await page.getByRole("button", { name: "Confirm new email" }).click();
      await expect(pageAlert(page)).toContainText("That link is invalid, has expired or was already used.");
      await expect(page.getByRole("button", { name: "Confirm new email" })).toHaveCount(0);

      // A verification link is not an email-change link. (Each link opens as a new page load, as from a mail app:
      // going to the same path with only a new fragment would not reload the page.)
      const verify = await mintToken(request, { kind: "verify", username: "Player-1" });
      await page.goto("/terms");
      await page.goto(`/email-change#t=${verify}`);
      await page.getByRole("button", { name: "Confirm new email" }).click();
      await expect(pageAlert(page)).toContainText("That link is invalid, has expired or was already used.");

      // An address another account already uses.
      const taken = await mintToken(request, { kind: "email-change", username: "Player-1", email: "player0@example.test" });
      await page.goto("/terms");
      await page.goto(`/email-change#t=${taken}`);
      await page.getByRole("button", { name: "Confirm new email" }).click();
      await expect(pageAlert(page)).toHaveText("This email address can't be used for your account.");
      expect((await fixtureUser(request, "Player-1")).email).toBe("player1-new@example.test");

      await page.goto("/terms");
      await page.goto("/email-change");
      await expect(page.getByText("This link is incomplete.", { exact: false })).toBeVisible();
    });
  });
});

test.describe("forgotten password", () => {
  test.use({ session: "signed-out" });

  test("asking for a link reads the same whether or not the address has an account", async ({ page, request }) => {
    const answers: string[] = [];
    for (const email of ["player0@example.test", "nobody@example.test"]) {
      await page.goto("/reset-password");
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Email me a reset link" }).click();
      const notice = page.locator("main").getByRole("status").filter({ hasText: "we've sent it a link" });
      await expect(notice).toBeVisible();
      answers.push((await notice.innerText()).replace(email, "EMAIL"));
      await expect(page.getByRole("button", { name: /^Send again in \d+ s$/ })).toBeDisabled();
    }
    expect(answers[0]).toBe(answers[1]);
    const sent = await fixtureRequests(request, "/api/auth/password/forgot");
    expect(sent.map((r) => r.body)).toEqual([
      { email: "player0@example.test", turnstileToken: "stub-token-1" },
      { email: "nobody@example.test", turnstileToken: "stub-token-1" },
    ]);
  });

  test("a reset link sets a new password, signs out everywhere and never signs in by itself", async ({ page, request }) => {
    await createUser(request, { username: "forgetful", password: "the-old-password-1" });
    const token = await mintToken(request, { kind: "reset", username: "forgetful" });
    await page.goto(`/reset-password#t=${token}`);
    expect(page.url()).not.toContain(token);
    await expect(page.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
    // No browser check on the token form: the token is the proof (and no third-party script runs with it).
    await expect(page.locator("main iframe")).toHaveCount(0);
    const field = page.getByLabel("New password", { exact: true });
    await field.fill("short");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    // A refused password does not spend the link.
    await field.fill("violet-kettle-breach-9183");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText("This password has appeared in a data breach.", { exact: false })).toBeVisible();
    await field.fill("a-brand-new-passphrase-7");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page).toHaveURL(/\/login\?notice=reset$/);
    await expect(page.getByText("Your password was changed. Sign in with your new password.")).toBeVisible();
    expect((await fixtureUser(request, "forgetful")).password).toBe("a-brand-new-passphrase-7");

    // The link works once.
    await page.goto(`/reset-password#t=${token}`);
    await page.getByLabel("New password", { exact: true }).fill("another-new-passphrase-8");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(pageAlert(page)).toContainText("This link is invalid or has expired.");
    await expect(page.getByRole("button", { name: "Email me a reset link" })).toBeVisible();
  });
});

test.describe("This wasn't me", () => {
  test("nothing happens on page load; one click locks the account down and a new password finishes it", async ({ page, request }) => {
    const token = await mintToken(request, { kind: "not-me" });
    await page.goto(`/auth/not-me#t=${token}`);
    expect(page.url()).not.toContain(token);
    const secure = page.getByRole("button", { name: "This wasn't me — secure my account" });
    await expect(secure).toBeVisible();
    await page.waitForTimeout(500);
    expect(await fixtureRequests(request, "/api/auth/security/lockdown")).toHaveLength(0);

    await secure.click();
    await expect(page.getByText("Done. We signed out every session on your account.", { exact: false })).toBeVisible();
    expect(await fixtureRequests(request, "/api/auth/security/lockdown")).toHaveLength(1);
    // This browser was signed in to that account: it is signed out too.
    expect((await fixtureUser(request, "Player-0")).passwordResetRequired).toBe(true);

    await page.getByLabel("New password", { exact: true }).fill("a-fresh-passphrase-after-lockdown");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expectOnLogin(page);
    await expect(page.getByText("Your password was changed.", { exact: false })).toBeVisible();
    await signInViaUi(page, { identifier: "Player-0", password: "a-fresh-passphrase-after-lockdown" });
    await expectSignedIn(page, "Player-0");
  });
});
