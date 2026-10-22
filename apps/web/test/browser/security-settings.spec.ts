import { expectSignedIn, fixtureAuth, fixtureRequests, fixtureUser } from "../support/auth";
import { expect, test } from "../support/fixtures";

test("sessions: this device is marked, another can be signed out, and so can all the others", async ({ page, request }) => {
  await page.goto("/account/security");
  const sessions = page.getByRole("list", { name: "Active sessions" });
  await expect(sessions.getByTestId("session-row")).toHaveCount(2);
  await expect(sessions.getByTestId("session-row").first()).toContainText("This device");
  await expect(sessions.getByTestId("session-row").nth(1)).toContainText("Safari on iOS");

  await sessions.getByRole("button", { name: "Sign out Safari on iOS" }).click();
  await expect(page.locator("main").getByText("Signed out Safari on iOS.")).toBeVisible();
  await expect(sessions.getByTestId("session-row")).toHaveCount(1);
  const deletes = (await fixtureRequests(request)).filter((r) => r.method === "DELETE" && r.path.startsWith("/api/auth/sessions/"));
  expect(deletes.map((r) => r.path)).toEqual(["/api/auth/sessions/session-other-1"]);
  await expect(page.getByRole("button", { name: "Sign out of all other sessions" })).toHaveCount(0);
  await expectSignedIn(page);
});

test("sign out of all other sessions asks first and reports how many", async ({ page, request }) => {
  await page.goto("/account/security");
  await page.getByRole("button", { name: "Sign out of all other sessions" }).click();
  await page.getByRole("alertdialog", { name: "Sign out everywhere else?" }).getByRole("button", { name: "Sign out others" }).click();
  await expect(page.locator("main").getByText("Signed out of 1 other session.")).toBeVisible();
  expect((await fixtureRequests(request, "/api/auth/logout-all")).map((r) => r.body)).toEqual([{ exceptCurrent: true }]);
  await expectSignedIn(page);
});

test("changing the password: a wrong current password is only an error; the right one changes it", async ({ page, request }) => {
  await page.goto("/account/security");
  const form = page.getByRole("form", { name: "Change password" });
  await form.getByLabel("Current password").fill("not-my-password");
  await form.getByLabel("New password").fill("a-much-better-passphrase-1");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByText("That password isn't right.")).toBeVisible();
  await expect(form.getByLabel("Current password")).toBeFocused();
  await expectSignedIn(page);

  await form.getByLabel("Current password").fill("fixture-password-0");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByText("Password changed. We signed you out on your other devices (1 session).")).toBeVisible();
  expect((await fixtureUser(request, "Player-0")).password).toBe("a-much-better-passphrase-1");
  // The step-up checked the current password, then the change sent only the new one.
  const calls = (await fixtureRequests(request)).filter((r) => r.path === "/api/auth/reauth/password" || r.path === "/api/account/password");
  expect(calls.map((r) => [r.path, r.body])).toEqual([
    ["/api/auth/reauth/password", { password: "not-my-password" }],
    ["/api/auth/reauth/password", { password: "fixture-password-0" }],
    ["/api/account/password", { newPassword: "a-much-better-passphrase-1" }],
  ]);
});

test("an expired step-up asks to confirm it's you, then retries the change by itself", async ({ page, request }) => {
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Email", exact: true })).toBeVisible();
  await fixtureAuth(request, { reauthRequired: true });
  await page.getByRole("button", { name: "Change email" }).click();
  const change = page.getByRole("dialog", { name: "Change your email" });
  await change.getByLabel("New email").fill("new-address@example.test");
  await change.getByRole("button", { name: "Send link" }).click();
  const reauth = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(reauth).toContainText("confirm your identity to change your email");
  await reauth.getByLabel("Password", { exact: true }).fill("fixture-password-0");
  await reauth.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("main").getByText("We sent a confirmation link to new-address@example.test", { exact: false })).toBeVisible();
  const changes = await fixtureRequests(request, "/api/account/email");
  expect(changes.map((r) => r.body)).toEqual([{ newEmail: "new-address@example.test" }, { newEmail: "new-address@example.test" }]);
});

test("cancelling 'Confirm it's you' leaves everything as it was, silently", async ({ page, request }) => {
  await page.goto("/account/security");
  await fixtureAuth(request, { reauthRequired: true });
  await page.getByRole("button", { name: "Set up" }).click();
  const reauth = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(reauth).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reauth).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set up" })).toBeFocused();
});

test("recognised devices and recent activity are listed", async ({ page }) => {
  await page.goto("/account/security");
  const devices = page.getByRole("list", { name: "Recognised devices" });
  await expect(devices.getByRole("listitem")).toHaveCount(2);
  await devices.getByRole("button", { name: "Forget Safari on iOS" }).click();
  await page.getByRole("alertdialog", { name: "Forget this device?" }).getByRole("button", { name: "Forget device" }).click();
  await expect(page.locator("main").getByText("Forgot Safari on iOS and signed it out.")).toBeVisible();
  await expect(devices.getByRole("listitem")).toHaveCount(1);
  // Status labels are words, never raw event codes.
  await expect(page.getByText(/^[A-Z_]{6,}$/)).toHaveCount(0);
});
