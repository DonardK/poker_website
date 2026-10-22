import type { Page } from "@playwright/test";
import { createUser, expectSignedIn, fixtureAuth, fixtureUser } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { totp } from "../support/totp.mjs";

function pageAlert(page: Page) {
  return page.locator("main").getByRole("alert");
}

async function passwordStep(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
}

test.describe("signing in with two-step verification", () => {
  test.use({ session: "signed-out" });

  test("a password then a code from the app; a wrong code says so and clears the field", async ({ page, request }) => {
    const user = await createUser(request, { username: "two_step", password: "two-step-password", totp: true });
    await passwordStep(page, "two_step", "two-step-password");
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeFocused();
    const code = page.getByLabel("Authentication code");
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await expect(code).toHaveAttribute("inputmode", "numeric");

    const right = totp(user.totpSecret!);
    await code.fill(right === "000000" ? "111111" : "000000");
    await expect(pageAlert(page)).toContainText("That code didn't work.");
    await expect(code).toHaveValue("");

    // Six digits submit by themselves.
    await code.fill(right);
    await expectSignedIn(page, "two_step");
  });

  test("a backup code works once instead", async ({ page, request }) => {
    await createUser(request, { username: "backup_user", password: "backup-password-1", totp: true, backupCodes: ["ABCDE-FGH12", "KLMNP-QRS34"] });
    await passwordStep(page, "backup_user", "backup-password-1");
    await page.getByRole("button", { name: "Use a backup code instead" }).click();
    const field = page.getByLabel("Backup code");
    await field.fill("abcde fgh12");
    await page.getByRole("button", { name: "Verify" }).click();
    await expectSignedIn(page, "backup_user");
    const account = await fixtureUser(request, "backup_user");
    expect(account.totp.backupCodesRemaining).toBe(1);
  });

  test("an expired sign-in goes back to the password with a message", async ({ page, request }) => {
    const user = await createUser(request, { username: "slow_typer", password: "slow-typer-password", totp: true });
    await passwordStep(page, "slow_typer", "slow-typer-password");
    await fixtureAuth(request, { expireTickets: true });
    await page.getByLabel("Authentication code").fill(totp(user.totpSecret!));
    await expect(pageAlert(page)).toHaveText("This sign-in timed out. Enter your password again.");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });
});

test.describe("setting up two-step verification", () => {
  test("confirm it's you, scan or type the key, confirm a code, save the backup codes", async ({ page, request }) => {
    await page.goto("/account/security");
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
    await fixtureAuth(request, { reauthRequired: true });
    await page.getByRole("button", { name: "Set up" }).click();

    const reauth = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(reauth).toBeVisible();
    await reauth.getByLabel("Password", { exact: true }).fill("wrong-password-here");
    await reauth.getByRole("button", { name: "Confirm" }).click();
    await expect(reauth.getByRole("alert")).toHaveText("That password isn't right.");
    await reauth.getByLabel("Password", { exact: true }).fill("fixture-password-0");
    await reauth.getByRole("button", { name: "Confirm" }).click();
    await expect(reauth).toHaveCount(0);

    const setup = page.getByRole("dialog", { name: "Scan the QR code" });
    await expect(setup.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
    await setup.getByText("Can't scan? Enter this key").click();
    const key = (await setup.getByTestId("totp-secret").innerText()).replace(/\s+/g, "");
    expect(key).toMatch(/^[A-Z2-7]{16,}$/);
    await setup.getByRole("button", { name: "Next" }).click();

    const verify = page.getByRole("dialog", { name: "Enter a code" });
    await verify.getByLabel("6-digit code from the app").fill(totp(key));
    const codes = page.getByRole("dialog", { name: "Save your backup codes" });
    await expect(codes.getByTestId("backup-code")).toHaveCount(10);
    const done = codes.getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    await codes.getByLabel("I've saved these codes somewhere safe").check();
    await done.click();
    await expect(codes).toHaveCount(0);
    await expect(page.getByText(/^On since .* · 10 backup codes left$/)).toBeVisible();
    // The lobby's recommendation is gone now.
    await page.goto("/");
    await expect(page.getByText("Protect your account")).toHaveCount(0);
  });

  test("turning it off needs the password and a code", async ({ page, request }) => {
    const user = await createUser(request, { username: "turn_off", password: "turn-off-password", totp: true });
    await fixtureAuth(request, { as: user.id, reauthRequired: true });
    await page.goto("/account/security");
    await page.getByRole("button", { name: "Turn off" }).click();
    await page.getByRole("alertdialog", { name: "Turn off two-step verification?" }).getByRole("button", { name: "Turn off" }).click();
    const reauth = page.getByRole("dialog", { name: "Confirm it's you" });
    await reauth.getByLabel("Password", { exact: true }).fill("turn-off-password");
    await reauth.getByRole("button", { name: "Confirm" }).click();
    // The next step's code: the replay rule refuses a code from a step already used.
    await reauth.getByLabel("Code from your authenticator app").fill(totp(user.totpSecret!, Date.now(), 1));
    await expect(page.locator("main").getByText("Two-step verification is off.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
  });
});
