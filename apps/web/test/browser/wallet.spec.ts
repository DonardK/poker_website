import type { APIRequestContext, Page } from "@playwright/test";
import { createUser, fixtureAuth, fixtureRequests, openAccountMenu, signInViaUi } from "../support/auth";
import { lowContrastTexts } from "../support/contrast";
import { expect, fixture, test } from "../support/fixtures";
import { totp } from "../support/totp.mjs";

/**
 * The wallet (design-web section 5.18; docs/money/WALLET.md sections 11 and 12) against
 * test/support/wallet-fixture.mjs, which serves the /api/wallet routes, the payments Worker's sandbox
 * pages and the money step-up grants (auth-fixture.mjs). Every test starts with PAYMENTS_MODE "off".
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Sandbox, verified, limits chosen: money can move. */
const READY = { mode: "sandbox", kyc: "VERIFIED", limitsChosen: true } as const;

interface WalletLogEntry { method: string; path: string; url: string; idempotencyKey: string | null; body: Record<string, unknown> | null }

async function setWallet(request: APIRequestContext, data: Record<string, unknown>) {
  await request.post(`${fixture}/__test/wallet`, { data });
}

async function walletState(request: APIRequestContext) {
  return (await request.get(`${fixture}/__test/wallet`)).json() as Promise<{
    log: WalletLogEntry[];
    wallet: { kyc: string; available: string; held: string; restriction: string; instruments: { id: string; crypto: { address: string } | null }[] };
  }>;
}

async function walletCalls(request: APIRequestContext, method: string, path: string): Promise<WalletLogEntry[]> {
  return (await walletState(request)).log.filter((entry) => entry.method === method && entry.path === path);
}

async function stepUpInbox(request: APIRequestContext) {
  return (await request.get(`${fixture}/__test/step-up`)).json() as Promise<{
    lastCode: { code: string; purpose: string; bind: string } | null;
    grants: { id: string; purpose: string; bind: string; method: string; consumed: boolean }[];
  }>;
}

function moneyDialog(page: Page) {
  return page.getByRole("dialog", { name: "Confirm it's you" });
}

/** Player-0 has neither TOTP nor a passkey: the password plus a code emailed for this one request. */
async function confirmWithEmailCode(page: Page, request: APIRequestContext) {
  const dialog = moneyDialog(page);
  await dialog.getByLabel("Password", { exact: true }).fill("fixture-password-0");
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  await expect(dialog.getByText(/We emailed you a 6-digit code/)).toBeVisible();
  const { lastCode } = await stepUpInbox(request);
  expect(lastCode).not.toBeNull();
  await dialog.getByLabel("Code from the email").fill(lastCode!.code);
  await expect(dialog).toBeHidden();
}

function main(page: Page) {
  return page.locator("main");
}

test.describe("wallet off (production today)", () => {
  test("the menu links to a wallet with play chips only, no money forms and no money requests", async ({ page, request }) => {
    await page.goto("/");
    await openAccountMenu(page);
    await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Wallet" }).click();
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(page.getByRole("heading", { level: 1, name: "Wallet" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deposits and withdrawals are not available yet" })).toBeVisible();
    await expect(page.getByTestId("wallet-play-chips")).toHaveText(/^[\d,]+$/);
    await expect(main(page)).toContainText("Play chips have no cash value and cannot be redeemed.");
    await expect(page.getByTestId("sandbox-banner")).toHaveCount(0);
    await expect(main(page).getByRole("link", { name: "Deposit", exact: true })).toHaveCount(0);
    await expect(main(page).getByRole("textbox")).toHaveCount(0);

    // The sub-pages say the same and offer nothing to fill in.
    for (const path of ["/wallet/deposit", "/wallet/withdraw", "/wallet/limits"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Deposits and withdrawals are not available yet" })).toBeVisible();
      await expect(main(page).getByRole("textbox")).toHaveCount(0);
    }
    const posts = (await walletState(request)).log.filter((entry) => entry.method !== "GET");
    expect(posts).toEqual([]);
  });

  test("an API without the wallet routes reads as off", async ({ page, request }) => {
    await setWallet(request, { mode: "absent" });
    await page.goto("/wallet");
    await expect(page.getByRole("heading", { name: "Deposits and withdrawals are not available yet" })).toBeVisible();
    await expect(page.getByTestId("wallet-play-chips")).toHaveText(/^[\d,]+$/);
  });
});

test.describe("sandbox and live", () => {
  test("sandbox carries the test-money banner; live shows euros without it", async ({ page, request }) => {
    await setWallet(request, { ...READY, available: "1234.50" });
    await page.goto("/wallet");
    const banner = page.getByRole("note", { name: "Sandbox notice" });
    await expect(banner).toContainText("Test money (TEST_EUR) — not real");
    await expect(page.getByTestId("wallet-available")).toHaveText("1,234.50 TEST_EUR");
    await expect(main(page)).toContainText("Test money (TEST_EUR)");
    await page.getByRole("link", { name: "Deposit", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Deposit" })).toBeVisible();
    await expect(banner).toBeVisible();

    await setWallet(request, { mode: "live" });
    await page.goto("/wallet");
    await expect(page.getByTestId("wallet-available")).toHaveText("€1,234.50");
    await expect(main(page)).toContainText("Cash balance");
    await expect(page.getByTestId("sandbox-banner")).toHaveCount(0);
  });
});

test.describe("deposits", () => {
  test("by card: the provider's page, then the outcome read from the API and never from the return URL", async ({ page, request }) => {
    await setWallet(request, READY);
    await page.goto("/wallet");
    await page.getByRole("link", { name: "Deposit", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Card" })).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("Amount (TEST_EUR)").fill("25");
    await page.getByRole("button", { name: "Continue to secure payment" }).click();

    // The sandbox provider's hosted page (the payments Worker's, outside production).
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4107\/sandbox\/pay\//);
    await expect(page.getByRole("heading", { name: "Sandbox payment" })).toBeVisible();
    await page.getByRole("button", { name: "Approve test payment" }).click();

    await expect(page).toHaveURL(/\/wallet\/deposit\/return\?deposit=/);
    await expect(page.getByRole("heading", { level: 1, name: "Your deposit" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "25.00 TEST_EUR added to your balance" })).toBeVisible({ timeout: 10_000 });

    const [created] = await walletCalls(request, "POST", "/api/wallet/deposits");
    expect(created!.idempotencyKey).toMatch(UUID_V4);
    expect(created!.body).toEqual({ method: "CARD", amount: "25.00" });

    await page.getByRole("link", { name: "Back to wallet", exact: true }).click();
    await expect(page.getByTestId("wallet-available")).toHaveText("25.00 TEST_EUR");
    const row = page.getByTestId("history-row").first();
    await expect(row).toContainText("Deposit");
    await expect(row).toContainText("+25.00 TEST_EUR");
    await expect(row).toContainText("Completed");
  });

  test("a declined card payment says so, although the return URL claims success", async ({ page, request }) => {
    await setWallet(request, READY);
    await page.goto("/wallet/deposit?method=card");
    await page.getByRole("button", { name: "20.00 TEST_EUR" }).click();
    await page.getByRole("button", { name: "Continue to secure payment" }).click();
    // The provider sends the browser back to /wallet?deposit=<id>&ppp_status=OK&status=success.
    await page.getByRole("button", { name: "Decline test payment" }).click();
    await expect(page).toHaveURL(/\/wallet\/deposit\/return\?deposit=/);
    await expect(page.getByRole("heading", { name: "Payment didn't go through" })).toBeVisible({ timeout: 10_000 });
    await expect(main(page)).toContainText("Nothing was added to your balance.");
    await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/wallet/deposit?method=card");

    // However the return URL is dressed up, the outcome is the API's.
    const depositId = new URL(page.url()).searchParams.get("deposit");
    await page.goto(`/wallet/deposit/return?deposit=${depositId}&status=success&ppp_status=OK`);
    await expect(page.getByRole("heading", { name: "Payment didn't go through" })).toBeVisible();
    await expect(page.getByTestId("wallet-available")).toHaveCount(0);
    expect((await walletState(request)).wallet.available).toBe("0.00");
  });

  test("by crypto: the summary's currencies (no USDT in the EEA), the address with its QR code, then the credit", async ({ page, request }) => {
    await setWallet(request, { ...READY, eea: true });
    await page.goto("/wallet/deposit?method=crypto");
    await expect(page.getByRole("tab", { name: "Crypto" })).toHaveAttribute("aria-selected", "true");
    const currencies = page.getByRole("group", { name: "Currency and network" });
    await expect(currencies.getByRole("radio")).toHaveCount(3);
    await expect(currencies).not.toContainText("Tether");
    await currencies.getByLabel(/Bitcoin \(BTC\)/).check();
    await page.getByLabel("Amount (TEST_EUR)").fill("50");
    await page.getByRole("button", { name: "Get a deposit address" }).click();

    await expect(page.getByRole("heading", { name: "Send Bitcoin (BTC)" })).toBeVisible();
    await expect(page.getByTestId("deposit-address")).toHaveText("bc1q w508 d6qe jxtd g4y5 r3za rvar y0c5 xw7k v8f3 t4");
    await expect(page.getByRole("img", { name: "QR code of the Bitcoin (BTC) deposit address" })).toBeVisible();
    await expect(main(page)).toContainText("Sandbox address: it isn't on any real chain.");
    await expect(main(page)).toContainText("We credit your balance after 2 network confirmations.");
    await expect(page.getByText("Waiting for your payment…")).toBeVisible();
    const [created] = await walletCalls(request, "POST", "/api/wallet/deposits");
    expect(created!.body).toEqual({ method: "CRYPTO", amount: "50.00", payAsset: "BTC" });

    await request.post(`${fixture}/__test/wallet/crypto-paid`, { data: {} });
    await expect(page.getByText("50.00 TEST_EUR added to your balance.")).toBeVisible({ timeout: 12_000 });

    // Outside the EEA the summary offers USDT, and the page follows it.
    await setWallet(request, { eea: false });
    await page.goto("/wallet/deposit?method=crypto");
    await expect(page.getByRole("group", { name: "Currency and network" }).getByRole("radio")).toHaveCount(4);
    await expect(page.getByRole("group", { name: "Currency and network" })).toContainText("Tether (USDT)");
  });

  test("errors and limits read as plain language", async ({ page, request }) => {
    await setWallet(request, { ...READY, limits: { DAY: "100.00" } });
    await page.goto("/wallet/deposit?method=card");
    const amount = page.getByLabel("Amount (TEST_EUR)");
    await amount.fill("12.345");
    await page.getByRole("button", { name: "Continue to secure payment" }).click();
    await expect(main(page)).toContainText("Use at most 2 decimal places.");
    expect(await walletCalls(request, "POST", "/api/wallet/deposits")).toEqual([]);

    await amount.fill("150");
    await page.getByRole("button", { name: "Continue to secure payment" }).click();
    await expect(main(page).getByRole("alert")).toHaveText("That's over your deposit limit. You can deposit up to 100.00 TEST_EUR more right now.");

    await setWallet(request, { nextError: { path: "/api/wallet/deposits", status: 503, body: { error: "paused", code: "PAYMENTS_PAUSED", retryable: true } } });
    await amount.fill("30");
    await page.getByRole("button", { name: "Continue to secure payment" }).click();
    await expect(main(page).getByRole("alert")).toHaveText("Payments are paused for maintenance. Your balance is safe; try again later.");
    // A retry after an unknown outcome (5xx) reuses the same Idempotency-Key, so it can never pay twice.
    await page.getByRole("button", { name: "Continue to secure payment" }).click();
    await expect(page).toHaveURL(/\/sandbox\/pay\//);
    const posts = await walletCalls(request, "POST", "/api/wallet/deposits");
    expect(posts.at(-1)!.idempotencyKey).toBe(posts.at(-2)!.idempotencyKey);
  });

  test("a timed break does not end by itself: the player asks to come back", async ({ page, request }) => {
    await setWallet(request, { ...READY, exclusion: { endsInMs: -3_600_000 } });
    await page.goto("/wallet/limits");
    const card = page.getByRole("region", { name: "Your break" });
    await expect(card).toContainText("Deposits stay closed until you ask to come back, and reopen 24 hours after you ask.");
    await card.getByRole("button", { name: "Ask to come back" }).click();
    await expect(card).toContainText(/You asked to come back\. Deposits reopen on /);
    await expect(card.getByRole("button", { name: "Ask to come back" })).toHaveCount(0);
    expect(await walletCalls(request, "POST", "/api/account/self-exclusion/reactivation")).toHaveLength(1);
  });

  test("a break still running offers no way back yet", async ({ page, request }) => {
    await setWallet(request, { ...READY, exclusion: { endsInMs: 3 * 86_400_000 } });
    await page.goto("/wallet/limits");
    const card = page.getByRole("region", { name: "Your break" });
    await expect(card).toContainText("Once it ends, deposits stay closed until you ask to come back here.");
    await expect(card.getByRole("button", { name: "Ask to come back" })).toHaveCount(0);
  });

  test("an indefinite self-exclusion waits for the team after the player asks", async ({ page, request }) => {
    await setWallet(request, { ...READY, exclusion: { indefinite: true } });
    await page.goto("/wallet/limits");
    const card = page.getByRole("region", { name: "Your break" });
    await expect(card).toContainText("Your self-exclusion has no end date.");
    await card.getByRole("button", { name: "Ask to come back" }).click();
    await expect(card).toContainText("Our team will review your request. Deposits reopen 7 days after they accept it.");
  });

  test("before the first deposit the player chooses limits", async ({ page, request }) => {
    await setWallet(request, { mode: "sandbox", kyc: "VERIFIED", limitsChosen: false });
    await page.goto("/wallet");
    await expect(main(page)).toContainText("Before your first deposit, choose your deposit limits (or choose no limit).");
    await expect(main(page).getByText("Choose your deposit limits first.")).toBeVisible();
    await expect(main(page).getByRole("link", { name: "Deposit", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Set your limits" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Deposit limits" })).toBeVisible();
    await page.getByLabel("No daily limit").uncheck();
    await page.locator("#limit-DAY-amount").fill("100");
    await page.getByRole("button", { name: "Save limits" }).click();
    await expect(page.getByText("Saved. Your limits apply now.")).toBeVisible();
    const sent = (await walletCalls(request, "POST", "/api/wallet/limits")).map((entry) => entry.body);
    expect(sent).toEqual([{ period: "DAY", amount: "100.00" }, { period: "WEEK", amount: null }, { period: "MONTH", amount: null }]);

    // Zero is not a limit: the page says what to do instead, and nothing is sent.
    await page.locator("#limit-DAY-amount").fill("0");
    await page.getByRole("button", { name: "Save limits" }).click();
    await expect(page.getByRole("region", { name: "Daily limit" })).toContainText('Enter a limit above zero, or tick "No daily limit".');
    expect(await walletCalls(request, "POST", "/api/wallet/limits")).toHaveLength(3);

    // A looser limit waits 24 hours.
    await page.locator("#limit-DAY-amount").fill("200");
    await page.getByRole("button", { name: "Save limits" }).click();
    await expect(page.getByText("Saved. Lower limits apply now; higher limits and removals take effect after 24 hours.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Daily limit" })).toContainText("Changes to 200.00 TEST_EUR on");

    await page.getByRole("link", { name: "← Back to wallet" }).click();
    await expect(page.getByRole("link", { name: "Deposit", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Deposit limits" })).toContainText("100.00 TEST_EUR");
  });
});

test.describe("identity verification", () => {
  test("the sandbox page, then the result read from the API", async ({ page, request }) => {
    // The provider's result reaches the Worker a few seconds after the player is back.
    await setWallet(request, { mode: "sandbox", kyc: "UNVERIFIED", limitsChosen: true, kycDelayMs: 6_000 });
    await page.goto("/wallet");
    const card = page.getByRole("region", { name: "Identity verification" });
    await expect(card).toContainText("Needed");
    await expect(main(page).getByText("Verify your identity to deposit.")).toBeVisible();
    await card.getByRole("link", { name: "Start verification" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Verify your identity" })).toBeVisible();
    await page.getByRole("button", { name: "Start verification" }).click();
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4107\/sandbox\/kyc\//);
    await page.getByRole("button", { name: "Approve verification" }).click();

    await expect(page).toHaveURL(/\/wallet\/verify\/return/);
    await expect(page.getByRole("heading", { name: "We're checking your documents" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "You're verified" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "← Back to wallet" }).click();
    await expect(page.getByRole("link", { name: "Deposit", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Identity verification" })).toHaveCount(0);
  });

  test("only the verification page's policy allows the KYC provider", async ({ page }) => {
    const verify = await page.goto("/wallet/verify");
    const verifyHeaders = verify!.headers();
    expect(verifyHeaders["content-security-policy"]).toMatch(/script-src [^;]*https:\/\/static\.sumsub\.com/);
    expect(verifyHeaders["content-security-policy"]).toMatch(/frame-src [^;]*https:\/\/in\.sumsub\.com/);
    expect(verifyHeaders["permissions-policy"]).toContain('camera=(self "https://in.sumsub.com"');

    for (const path of ["/wallet", "/wallet/verify/return", "/wallet/deposit"]) {
      const headers = (await page.goto(path))!.headers();
      expect(headers["content-security-policy"], path).not.toContain("sumsub");
      expect(headers["permissions-policy"], path).toContain("camera=()");
    }
  });

  test("the Sumsub WebSDK loads on demand with the page's nonce, and the result still comes from the API", async ({ page, context, request }) => {
    await setWallet(request, { mode: "live", kyc: "UNVERIFIED", limitsChosen: true, kycProvider: "sumsub" });
    // A stand-in for Sumsub's builder script: records the token, draws a frame, reports a submission.
    await context.route(/^https:\/\/static\.sumsub\.com\/idensic\/static\/sns-websdk-builder\.js/, (route) => route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: `window.snsWebSdk = { init(token) {
        window.__sumsub = { token, nonce: document.getElementById("sumsub-websdk")?.nonce ?? "" };
        const handlers = {};
        const builder = {
          withConf() { return builder; }, withOptions() { return builder; },
          on(type, fn) { handlers[type] = fn; return builder; }, onMessage(fn) { handlers.message = fn; return builder; },
          build() { return { launch(selector) {
            document.querySelector(selector).textContent = "Stand-in verification frame";
            setTimeout(() => handlers.message && handlers.message("idCheck.onApplicantSubmitted", {}), 50);
          } }; },
        };
        return builder;
      } };`,
    }));
    await page.goto("/wallet/verify");
    await page.getByRole("button", { name: "Start verification" }).click();
    await expect(page.getByText("Stand-in verification frame")).toBeVisible();
    await expect(page.getByText("Thanks. We're checking your documents; this usually takes a few minutes.")).toBeVisible();
    const sdk = await page.evaluate(() => (window as unknown as { __sumsub: { token: string; nonce: string } }).__sumsub);
    expect(sdk.token).toMatch(/^kyc-/);
    expect(sdk.nonce.length).toBeGreaterThan(0);

    // The SDK's own "submitted" changes nothing: verified only once the API says so.
    expect((await walletState(request)).wallet.kyc).toBe("UNVERIFIED");
    await setWallet(request, { kyc: "VERIFIED" });
    await expect(page.getByRole("heading", { name: "You're verified" })).toBeVisible({ timeout: 12_000 });
  });
});

test.describe("payout destinations and withdrawals", () => {
  test("a crypto address is checked, confirmed with a single-use step-up bound to it, then cools off", async ({ page, request }) => {
    await setWallet(request, { ...READY, available: "100.00" });
    await page.goto("/wallet/withdraw");
    await expect(main(page)).toContainText("No payout destinations yet. Deposit by card first, or add a crypto address.");
    await page.getByRole("button", { name: "Add a crypto address" }).click();

    const dialog = page.getByRole("dialog", { name: "Add a crypto address" });
    await dialog.getByLabel("Currency and network").selectOption("ETH");
    await dialog.getByLabel("Address", { exact: true }).fill("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Be");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByText("That doesn't look like a Ethereum (ERC-20) address.", { exact: false })).toBeVisible();
    expect(await walletCalls(request, "POST", "/api/wallet/instruments/crypto/prepare")).toEqual([]);

    // An EIP-55 address: the API shows it mixed-case and binds its lower-case form.
    await dialog.getByLabel("Address", { exact: true }).fill("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    await dialog.getByLabel("Name (optional)").fill("My wallet");
    await dialog.getByRole("button", { name: "Continue" }).click();
    const check = page.getByRole("dialog", { name: "Check the address" });
    await expect(check.getByTestId("prepared-address")).toHaveText("0x5a Aeb6 053F 3E94 C9b9 A09f 3366 9435 E7Ef 1BeA ed");
    await expect(check).toContainText("Starts 0x5aAe, ends 1BeAed");
    await check.getByRole("button", { name: "Save address" }).click();

    await expect(moneyDialog(page)).toContainText("To save the Ether (ETH) address ending 1BeAed, confirm it's you.");
    await confirmWithEmailCode(page, request);
    await expect(page.getByRole("status").filter({ hasText: "Address saved. For your safety, you can withdraw to it from" })).toBeVisible();
    const destination = page.getByRole("radio", { name: /My wallet: Ether \(ETH\) 0x5aAeb6…1BeAed/ });
    await expect(destination).toBeDisabled();
    await expect(main(page)).toContainText("Available for withdrawals from");

    const inbox = await stepUpInbox(request);
    expect(inbox.grants).toHaveLength(1);
    expect(inbox.grants[0]).toMatchObject({ purpose: "payout_destination", method: "PASSWORD_EMAIL", consumed: true });
    const [added] = await walletCalls(request, "POST", "/api/wallet/instruments/crypto");
    expect(added!.idempotencyKey).toMatch(UUID_V4);
    expect(added!.body).toEqual({
      asset: "ETH", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", memo: null, label: "My wallet", stepUpGrantId: inbox.grants[0]!.id,
    });
  });

  test("a withdrawal: quote, review, a step-up for exactly that quote (asked again when it lapses), then pending review", async ({ page, request }) => {
    const user = await createUser(request, { username: "cash_out", password: "cash-out-password", totp: true });
    await fixtureAuth(request, { as: user.id });
    await setWallet(request, { ...READY, available: "100.00", seedCard: true });
    await page.goto("/wallet");
    await page.getByRole("link", { name: "Withdraw", exact: true }).click();
    await expect(page.getByRole("radio", { name: /Visa •••• 4242/ })).toBeChecked();
    await page.getByLabel("Amount (TEST_EUR)").fill("40");
    await page.getByRole("button", { name: "Review withdrawal" }).click();

    const review = page.getByRole("region", { name: "Review your withdrawal" });
    await expect(review).toContainText("Amount40.00 TEST_EUR");
    await expect(review).toContainText("Fee0.00 TEST_EUR");
    await expect(review).toContainText("You receive40.00 TEST_EUR");
    await expect(review).toContainText("ToVisa •••• 4242");

    // The first grant "expires" before the request lands: the API asks again for the same action.
    await setWallet(request, { rejectNextGrant: true });
    await review.getByRole("button", { name: "Confirm withdrawal" }).click();
    const dialog = moneyDialog(page);
    await expect(dialog).toContainText("To withdraw 40.00 TEST_EUR to Visa •••• 4242, confirm it's you.");
    await dialog.getByLabel("Password", { exact: true }).fill("cash-out-password");
    await dialog.getByLabel("Code from your authenticator app").fill(totp(user.totpSecret!));
    await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
    await dialog.getByLabel("Password", { exact: true }).fill("cash-out-password");
    await dialog.getByLabel("Code from your authenticator app").fill(totp(user.totpSecret!, Date.now(), 1));

    await expect(page).toHaveURL(/\/wallet$/);
    await expect(page.getByRole("status").filter({ hasText: "Withdrawal requested: 40.00 TEST_EUR to Visa •••• 4242. Status: Pending review." })).toBeVisible();
    await expect(page.getByTestId("wallet-available")).toHaveText("60.00 TEST_EUR");
    await expect(main(page)).toContainText("40.00 TEST_EUR held for withdrawals in progress.");
    await expect(page.getByTestId("withdrawal-row").first()).toContainText("Pending review");
    await expect(page.getByTestId("history-row").first()).toContainText("−40.00 TEST_EUR");

    const inbox = await stepUpInbox(request);
    expect(inbox.grants.map((g) => [g.purpose, g.method, g.consumed])).toEqual([["withdrawal", "TOTP", false], ["withdrawal", "TOTP", true]]);
    expect(new Set(inbox.grants.map((g) => g.bind)).size).toBe(1);
    const sends = await walletCalls(request, "POST", "/api/wallet/withdrawals");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.body).toMatchObject({ stepUpGrantId: inbox.grants[1]!.id });
    expect(sends.every((s) => UUID_V4.test(s.idempotencyKey ?? ""))).toBe(true);
  });

  test("a step-up the page cannot match to what it shows is never asked for", async ({ page, request }) => {
    await setWallet(request, { ...READY, available: "100.00", seedCard: true, tamperBind: "quote" });
    await page.goto("/wallet/withdraw");
    await page.getByLabel("Amount (TEST_EUR)").fill("20");
    await page.getByRole("button", { name: "Review withdrawal" }).click();
    await page.getByRole("button", { name: "Confirm withdrawal" }).click();
    await expect(main(page).getByRole("alert")).toHaveText("We couldn't confirm this request safely, so nothing was sent. Review the withdrawal again.");
    await expect(moneyDialog(page)).toHaveCount(0);
    expect(await fixtureRequests(request, "/api/auth/step-up")).toEqual([]);
    expect(await fixtureRequests(request, "/api/auth/step-up/email-code")).toEqual([]);
    expect(await walletCalls(request, "POST", "/api/wallet/withdrawals")).toEqual([]);
  });

  test("a card saved by a deposit cools off like an address, and is told apart from a ready one", async ({ page, request }) => {
    await setWallet(request, READY);
    await page.goto("/wallet/deposit?method=card");
    await page.getByLabel("Amount (TEST_EUR)").fill("25");
    await page.getByRole("button", { name: "Continue to secure payment" }).click();
    await page.getByRole("button", { name: "Approve test payment" }).click();
    await expect(page.getByRole("heading", { name: "25.00 TEST_EUR added to your balance" })).toBeVisible({ timeout: 10_000 });
    await page.goto("/wallet/withdraw");
    await expect(page.getByRole("radio", { name: /Visa •••• 4242/ })).toBeDisabled();
    await expect(main(page)).toContainText("Available for withdrawals from");
  });

  test("a card receives at most what it deposited; the page says what to do with the rest", async ({ page, request }) => {
    await setWallet(request, { ...READY, available: "100.00", seedCard: { deposited: "30.00" } });
    await page.goto("/wallet/withdraw");
    await page.getByLabel("Amount (TEST_EUR)").fill("40");
    await page.getByRole("button", { name: "Review withdrawal" }).click();
    await expect(main(page).getByRole("alert")).toHaveText("This card can receive up to 30.00 TEST_EUR: what it deposited, less what it has already received. Withdraw the rest to a payout address.");
    await page.getByLabel("Amount (TEST_EUR)").fill("30");
    await page.getByRole("button", { name: "Review withdrawal" }).click();
    await expect(page.getByRole("region", { name: "Review your withdrawal" })).toContainText("Amount30.00 TEST_EUR");
  });

  test("a security hold pauses withdrawals and says until when", async ({ page, request }) => {
    await fixtureAuth(request, { securityHoldUntil: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    await setWallet(request, { ...READY, available: "50.00", seedCard: true });
    await page.goto("/wallet");
    await expect(main(page).getByText("Withdrawals are paused for your security", { exact: true })).toBeVisible();
    const withdraw = main(page).getByRole("button", { name: "Withdraw", exact: true });
    await expect(withdraw).toHaveAttribute("aria-disabled", "true");
    await expect(withdraw).toHaveAccessibleDescription(/^Withdrawals are paused for your security until /);
    await page.goto("/wallet/withdraw");
    await expect(main(page)).toContainText("For your security, withdrawals and new payout addresses are paused until");
    await expect(page.getByRole("button", { name: "Review withdrawal" })).toHaveCount(0);
  });

  test("\"This wasn't me\" from a payments email locks the money down and signs every session out", async ({ page, request }) => {
    await setWallet(request, { ...READY, available: "50.00", seedCard: true });
    const { token } = await (await request.post(`${fixture}/__test/wallet/not-me-token`, { data: {} })).json();
    const expired = await (await request.post(`${fixture}/__test/wallet/not-me-token`, { data: { expired: true } })).json();
    await page.goto(`/auth/not-me#w=${expired.token}`);
    await page.getByRole("button", { name: "This wasn't me — freeze my withdrawals" }).click();
    await expect(main(page).getByRole("alert")).toContainText("This link is invalid or has expired.");

    await page.goto("/wallet");
    await page.goto(`/auth/not-me#w=${token}`);
    await expect(page.getByRole("heading", { level: 1, name: "Secure your payments" })).toBeVisible();
    await expect(page).not.toHaveURL(/#w=/);
    // Nothing happens on page load: a mail scanner that opens the link changes nothing.
    await page.waitForTimeout(500);
    expect(await walletCalls(request, "POST", "/api/wallet/not-me")).toHaveLength(1);
    await page.getByRole("button", { name: "This wasn't me — freeze my withdrawals" }).click();
    await expect(page.getByText("Done. Withdrawals are frozen", { exact: false })).toBeVisible();

    // Every session ended: the wallet asks for a sign-in, and after it withdrawals stay paused by the hold.
    await page.goto("/wallet");
    await expect(page).toHaveURL(/\/login/);
    await signInViaUi(page, { identifier: "Player-0", password: "fixture-password-0" });
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(main(page).getByText("Withdrawals are paused for your security", { exact: true })).toBeVisible();
    expect((await walletState(request)).wallet.restriction).toBe("WITHDRAWALS_MANUAL");
  });

  test("a payments link in mode off is simply invalid", async ({ page, request }) => {
    const { token } = await (await request.post(`${fixture}/__test/wallet/not-me-token`, { data: {} })).json();
    await page.goto(`/auth/not-me#w=${token}`);
    await page.getByRole("button", { name: "This wasn't me — freeze my withdrawals" }).click();
    await expect(main(page).getByRole("alert")).toContainText("This link is invalid or has expired.");
  });
});

test.describe("history", () => {
  test("every movement with its status, newest first, a page at a time", async ({ page, request }) => {
    await setWallet(request, { ...READY, history: 25, reversal: "5.00" });
    await page.goto("/wallet");
    const rows = page.getByTestId("history-row");
    await expect(rows).toHaveCount(20);
    await expect(rows.first()).toContainText("Deposit reversed");
    await expect(rows.first()).toContainText("−5.00 TEST_EUR");
    await expect(rows.first()).toContainText("Balance 245.00 TEST_EUR");
    await expect(rows.nth(1)).toContainText("+10.00 TEST_EUR");
    await expect(rows.nth(1)).toContainText("Completed");
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(rows).toHaveCount(26);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    await expect(rows.last()).toContainText("Balance 10.00 TEST_EUR");
    const pages = (await walletState(request)).log.filter((entry) => entry.path === "/api/wallet/transactions").map((entry) => entry.url);
    expect(pages).toContain("/api/wallet/transactions?cursor=20&limit=20");
  });
});

test.describe("contrast", () => {
  test("wallet pages meet WCAG AA text contrast", async ({ page, request }) => {
    await page.goto("/wallet");
    await expect(page.getByRole("heading", { name: "Deposits and withdrawals are not available yet" })).toBeVisible();
    expect(await lowContrastTexts(page), "/wallet off").toEqual([]);

    await setWallet(request, { mode: "sandbox", kyc: "UNVERIFIED", limitsChosen: false, history: 2, seedCard: true });
    await page.goto("/wallet");
    await expect(page.getByTestId("history-row")).toHaveCount(2);
    expect(await lowContrastTexts(page), "/wallet sandbox, gated").toEqual([]);
    await page.goto("/wallet/limits");
    await expect(page.getByRole("button", { name: "Save limits" })).toBeVisible();
    expect(await lowContrastTexts(page), "/wallet/limits").toEqual([]);
    await page.goto("/wallet/verify");
    await expect(page.getByRole("button", { name: "Start verification" })).toBeVisible();
    expect(await lowContrastTexts(page), "/wallet/verify").toEqual([]);

    await setWallet(request, { kyc: "VERIFIED", limitsChosen: true, available: "80.00" });
    await page.goto("/wallet/deposit?method=card");
    await expect(page.getByLabel("Amount (TEST_EUR)")).toBeVisible();
    expect(await lowContrastTexts(page), "/wallet/deposit card").toEqual([]);
    await page.getByRole("tab", { name: "Crypto" }).click();
    await page.getByLabel("Amount (TEST_EUR)").fill("20");
    await page.getByRole("button", { name: "Get a deposit address" }).click();
    await expect(page.getByTestId("deposit-address")).toBeVisible();
    expect(await lowContrastTexts(page), "crypto invoice").toEqual([]);
    await page.goto("/wallet/withdraw");
    await page.getByLabel("Amount (TEST_EUR)").fill("20");
    await page.getByRole("button", { name: "Review withdrawal" }).click();
    await page.getByRole("button", { name: "Confirm withdrawal" }).click();
    await expect(moneyDialog(page).getByRole("button", { name: "Email me a code" })).toBeVisible();
    expect(await lowContrastTexts(page), "money step-up").toEqual([]);
  });
});
