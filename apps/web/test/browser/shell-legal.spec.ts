import type { Page, Route } from "@playwright/test";
import { accountMenuButton, expectOnLogin, expectSignedIn, openAccountMenu, signInViaUi } from "../support/auth";
import { expect, fixture, test, TERMS_VERSION } from "../support/fixtures";

const PLAY_CHIPS_NOTICE = "Play chips have no cash value and cannot be redeemed.";

const LEGAL_PAGES = [
  { path: "/terms", title: "Terms of Service", mustSay: ["at least 18 years old", PLAY_CHIPS_NOTICE, "two-step verification", "This wasn't me"] },
  {
    path: "/privacy", title: "Privacy Notice", mustSay: [
      "IP address and browser user agent", "password hash", "PBKDF2-SHA256", "passkey", "backup codes", "Resend", "usernames of up to five accounts",
      "hand history", "For counsel review",
    ],
  },
  {
    path: "/rules", title: "House Rules", mustSay: [
      "forward-moving big blind with a dead button", "waits for the big blind", "you wait for the big blind",
      "base time of 20 seconds", "starts at 30 seconds", "grows by 5 seconds for every 10 hands", "at most 60 seconds",
      "you are sat out automatically", "Losing hands are mucked automatically", "every live hand is shown", "Winning hands are always shown",
      "Uncalled bets are returned", "side pots", "starting with the first winner to the left of the button",
      "your hand is folded when your turn comes", "remains eligible for the pots", "for 5 minutes", "for 30 seconds",
      "fresh base time", "two different authorised staff members",
    ],
  },
  {
    path: "/fairness", title: "Game Fairness", mustSay: [
      "Fisher–Yates", "rejection sampling", "SHA-256 deck commitment", "Merkle root", "hash of the previous event", "Verify hand",
      "The server generates and knows every deck", "Laboratory certification is pending", "Nothing on this page is a laboratory certification",
    ],
  },
  { path: "/responsible-gaming", title: "Responsible Gaming", mustSay: ["Deposit limits", "Self-exclusion", "Reality checks", "Time-out", "national responsible gambling helpline"] },
  { path: "/complaints", title: "Complaints", mustSay: ["How to complain", "ADR entity name and contact details", "hand number"] },
] as const;

/** Answer a fixture request with a different status/body, keeping the fixture's CORS headers. */
async function fulfillWith(route: Route, status: number, json: unknown) {
  await route.fulfill({ response: await route.fetch(), status, json });
}

/** Lets a test hide/show the page: document.visibilityState is read-only and headless pages are always "visible". */
async function controllableVisibility(page: Page) {
  await page.addInitScript(() => {
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => state !== "visible" });
    (window as unknown as { __setVisibility: (next: DocumentVisibilityState) => void }).__setVisibility = (next) => {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

async function setVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((next) => (window as unknown as { __setVisibility: (s: string) => void }).__setVisibility(next), state);
}

/**
 * The page's own error message. Scoped to <main>: Next.js keeps an empty route announcer (role="alert",
 * #__next-route-announcer__) outside it on every page, which is not the page's message.
 */
function pageAlert(page: Page) {
  return page.locator("main").getByRole("alert");
}

/** Two animation frames: React has committed whatever the last event or response caused. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * Every visible text element meets WCAG AA contrast: 4.5:1, or 3:1 for large text (≥ 24 px, or ≥ 18.66 px bold).
 * Backgrounds are composited from the element up; the page's own gradient is taken at its lightest stop (#143d31),
 * the worst case for the light text used throughout. Disabled controls, hidden and aria-hidden content are exempt.
 */
async function lowContrastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (color: string) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); };
    const sample = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    const alphaOf = (color: string) => { ctx.clearRect(0, 0, 1, 1); paint(color); return ctx.getImageData(0, 0, 1, 1).data[3]!; };
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    };
    const failures: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const text = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if (!text) continue;
      if (el.closest("[aria-hidden='true'], [disabled], script, style, noscript")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const layers: string[] = [];
      let opaqueImage = false;
      for (let node: HTMLElement | null = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") opaqueImage = true;
        if (alphaOf(style.backgroundColor) > 0) layers.unshift(style.backgroundColor);
      }
      if (opaqueImage) continue;
      ctx.clearRect(0, 0, 1, 1);
      paint("#143d31");
      for (const layer of layers) paint(layer);
      const bg = sample();
      const style = getComputedStyle(el);
      paint(style.color);
      const fg = sample();
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      const ratio = (hi! + 0.05) / (lo! + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 60)}" (${style.color})`);
    }
    return failures;
  });
}

test.describe("legal pages", () => {
  for (const doc of LEGAL_PAGES) {
    test(`${doc.path} is a versioned draft with its substance`, async ({ page }) => {
      await page.goto(doc.path);
      await expect(page.getByRole("heading", { level: 1, name: doc.title })).toBeVisible();
      const banner = page.getByRole("note", { name: "Draft notice" });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Draft — pending legal review");
      await expect(page.getByText(`Version ${TERMS_VERSION}`, { exact: false }).first()).toBeVisible();
      const main = page.locator("main");
      for (const phrase of doc.mustSay) await expect(main).toContainText(phrase);
      await expect(page).toHaveTitle(new RegExp(doc.title));
    });
  }

  test("every page links every legal document in its footer", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "waiting" } });
    for (const path of ["/", "/login", "/signup", "/table/fixture-table", "/rules", "/account/security", "/verify-email", "/reset-password"]) {
      await page.goto(path);
      const footer = page.getByRole("navigation", { name: "Legal" });
      for (const doc of LEGAL_PAGES) {
        await expect(footer.locator(`a[href="${doc.path}"]`)).toHaveCount(1);
      }
    }
    await page.goto("/");
    await page.getByRole("navigation", { name: "Legal" }).getByRole("link", { name: "House rules" }).click();
    await expect(page).toHaveURL(/\/rules$/);
  });

  test("the play-chip disclaimer is in the site metadata, not AI opponents", async ({ page }) => {
    await page.goto("/");
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    expect(description).toContain("human players");
    expect(description).toContain("no cash value");
    expect(description).not.toMatch(/\bAI\b|autonomous/i);
  });
});

test.describe("lobby", () => {
  test("sign-out clears the session, socket and evidence first and still signs out offline", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    let logout: Route | null = null;
    let logoutAuth: string | undefined;
    await page.route(`${fixture}/api/auth/logout`, (route) => {
      logoutAuth = route.request().headers()["authorization"];
      logout = route;
    });
    await page.goto("/");
    await expectSignedIn(page);
    await page.evaluate(() => sessionStorage.setItem("poker-live-evidence:fixture-table:1", "{}"));

    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    // Signed out here while the server has not answered yet.
    await expectOnLogin(page);
    await expect.poll(() => logout !== null).toBe(true);
    expect(logoutAuth).toBe("Bearer browser-fixture-token");
    expect(await page.evaluate(() => sessionStorage.getItem("poker-live-evidence:fixture-table:1"))).toBeNull();
    // SECURITY (G4): until the server confirms, this browser must not sign back in with the old cookie.
    expect(await page.evaluate(() => localStorage.getItem("poker-pending-logout"))).toContain('"v":1');

    // Still offline for the retries (the newest handler runs first), then the first request fails.
    await page.route(`${fixture}/api/auth/logout`, (route) => route.abort("internetdisconnected"));
    await logout!.abort("internetdisconnected");
    await expect(page.locator("main").getByText("You're signed out on this device. We couldn't reach the server to end the session", { exact: false })).toBeVisible();
    await expect(accountMenuButton(page)).toHaveCount(0);
    await expect(page.getByText("Open tables")).toHaveCount(0);

    // A reload keeps it signed out: no refresh is attempted while the sign-out is pending.
    let refreshes = 0;
    await page.route(`${fixture}/api/auth/refresh`, (route) => { refreshes++; return route.continue(); });
    await page.reload();
    await expectOnLogin(page);
    await page.waitForTimeout(1_500);
    expect(refreshes).toBe(0);
    await expect(accountMenuButton(page)).toHaveCount(0);

    // Back online: the retry ends the server session and the marker goes.
    await page.unroute(`${fixture}/api/auth/logout`);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => page.evaluate(() => localStorage.getItem("poker-pending-logout")), { timeout: 10_000 }).toBeNull();
  });

  test("table status labels are written for people", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "spectator" } });
    await page.goto("/");
    await expect(page.getByText("Hand in progress", { exact: true })).toBeVisible();
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("Waiting for players", { exact: true })).toBeVisible();
    await expect(page.getByText(/^(WAITING|IN_HAND)$/)).toHaveCount(0);
    await expect(page.getByText(PLAY_CHIPS_NOTICE).first()).toBeVisible();
  });

  test("polling runs only while visible, never overlaps, backs off on errors and clears its error on success", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await controllableVisibility(page);
    await page.clock.install();
    let mode: "ok" | "fail" | "hold" = "ok";
    let gets = 0;
    const held: Route[] = [];
    await page.route(`${fixture}/api/tables`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      gets++;
      if (mode === "hold") { held.push(route); return; }
      if (mode === "fail") return fulfillWith(route, 500, { error: "Fixture outage" });
      return route.fulfill({ response: await route.fetch() });
    });
    const expectGets = (n: number) => expect.poll(() => gets).toBe(n);
    const quiet = async (n: number) => { await page.waitForTimeout(300); expect(gets).toBe(n); };

    await page.goto("/");
    await expect(page.getByText("Waiting for players", { exact: true })).toBeVisible();
    await expectGets(1);

    // Hidden: no polling at all, however long. Visible again: refresh at once.
    await setVisibility(page, "hidden");
    await page.clock.fastForward(60_000);
    await quiet(1);
    await setVisibility(page, "visible");
    await expectGets(2);
    await settle(page);

    // A slow request: neither the poll timer nor the Refresh button starts another one meanwhile.
    mode = "hold";
    await page.clock.fastForward(5_500);
    await expectGets(3);
    // Two poll intervals and more, but less than api()'s 12 s request timeout: after that the request is abandoned
    // (a failure, retried after the back-off), which is not an overlap.
    await page.clock.fastForward(10_000);
    await page.getByRole("button", { name: "Refresh" }).click();
    await quiet(3);
    mode = "ok";
    await held.shift()!.fulfill({ response: await (await page.request.get(`${fixture}/api/tables`)) });
    // The Refresh asked for state newer than its click: one more request, after the slow one.
    await expectGets(4);
    await settle(page);

    // Failures back off: 10 s, then 20 s, ...
    mode = "fail";
    await page.clock.fastForward(5_500);
    await expectGets(5);
    const banner = page.getByText("Could not refresh the table list (Fixture outage). Retrying automatically.");
    await expect(banner).toBeVisible();
    await settle(page);
    await page.clock.fastForward(8_000);
    await quiet(5);
    await page.clock.fastForward(3_000);
    await expectGets(6);
    await settle(page);
    await page.clock.fastForward(17_000);
    await quiet(6);
    await page.clock.fastForward(4_000);
    await expectGets(7);
    await settle(page);

    // Recovery clears the earlier poll's error banner.
    mode = "ok";
    await page.clock.fastForward(36_000);
    await quiet(7);
    await page.clock.fastForward(5_000);
    await expectGets(8);
    await expect(banner).toBeHidden();
    await expect(page.getByText("Waiting for players", { exact: true })).toBeVisible();
  });

  test("a stale lobby wallet fetch cannot overwrite a newer cash-out", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "active" } });
    await page.goto("/table/fixture-table");
    await page.getByRole("button", { name: "Fold & leave", exact: true }).click();
    await expect(page).toHaveURL(/3107\/$/);
    await expect(page.getByText("current hand is finishing", { exact: false })).toBeVisible();
    await expect(page.getByText("9,000 chips", { exact: true })).toBeVisible();

    // The lobby sees the seat gone and asks for the wallet; that answer (9,000) is held back.
    await request.post(`${fixture}/__test/hold-me`);
    await page.route(`${fixture}/api/tables`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ response: await route.fetch(), json: { tables: [] } });
    });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(async () => (await (await request.get(`${fixture}/__test/waiting-me`)).json()).count).toBeGreaterThan(0);

    // The cash-out arrives (newer), then the stale answer.
    await request.post(`${fixture}/__test/settle`);
    await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
    const stale = page.waitForResponse((response) => response.url().endsWith("/api/auth/me") && response.status() === 200);
    await request.post(`${fixture}/__test/release-me`);
    await stale;
    await settle(page);
    await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
  });
});

/** The CSP and hardening headers every rendered page carries. */
function expectHardened(headers: Record<string, string>, html: string) {
  const csp = headers["content-security-policy"] ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  expect(nonce, csp).toBeTruthy();
  expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(csp).toContain("connect-src 'self' http://127.0.0.1:4107 ws://127.0.0.1:4107");
  for (const directive of ["img-src 'self' data: blob:", "font-src 'self'", "frame-ancestors 'none'", "object-src 'none'",
    "base-uri 'none'", "form-action 'self'", "default-src 'self'"]) expect(csp).toContain(directive);
  // Next.js stamps this request's nonce on its own scripts.
  expect(html).toContain(`nonce="${nonce}"`);
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=(), payment=()");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  // Development server: no HSTS (production only).
  expect(headers["strict-transport-security"]).toBeUndefined();
  return nonce!;
}

const HINT = { cookie: "poker_session_hint=1" };

test.describe("security headers", () => {
  for (const path of ["/login", "/signup", "/rules", "/reset-password"]) {
    test(`${path} sends a nonce-based CSP and the hardening headers`, async ({ request }) => {
      const first = await request.get(path, { maxRedirects: 0 });
      const second = await request.get(path, { maxRedirects: 0 });
      expect(first.status()).toBe(200);
      const nonce = expectHardened(first.headers(), await first.text());
      expect(second.headers()["content-security-policy"]).not.toContain(nonce);
    });
  }

  for (const path of ["/", "/table/x"]) {
    test(`${path} sends a signed-out visitor to sign in before rendering, and renders hardened with a session hint`, async ({ request }) => {
      const redirect = await request.get(path, { maxRedirects: 0 });
      expect(redirect.status()).toBe(307);
      // On the host the browser asked for (cookies and storage are per host).
      expect(new URL(redirect.headers()["location"]!, "http://127.0.0.1:3107").href).toBe(`http://127.0.0.1:3107/login?next=${encodeURIComponent(path)}`);
      expect(redirect.headers()["cache-control"]).toContain("no-store");
      expect(redirect.headers()["set-cookie"]).toContain("poker_gate_bounce=1");
      // The loop breaker: within its 30 s the page renders and the client gate decides.
      const bounced = await request.get(path, { maxRedirects: 0, headers: { cookie: "poker_gate_bounce=1" } });
      expect(bounced.status()).toBe(200);

      const rendered = await request.get(path, { maxRedirects: 0, headers: HINT });
      expect(rendered.status()).toBe(200);
      expectHardened(rendered.headers(), await rendered.text());
    });
  }

  test("the Turnstile script is rendered only on the forms that use it", async ({ request }) => {
    for (const path of ["/login", "/signup", "/reset-password"]) {
      expect(await (await request.get(path, { maxRedirects: 0 })).text(), path).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    }
    for (const path of ["/", "/table/x", "/account/security", "/rules", "/verify-email"]) {
      const html = await (await request.get(path, { maxRedirects: 0, headers: HINT })).text();
      expect(html, path).not.toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    }
  });

  test("the hint cookie only skips the redirect: a forged one still meets the sign-in gate", async ({ page, request }) => {
    await request.post(`${fixture}/__test/auth`, { data: { signedOut: true } });
    await page.goto("/account/security");
    await expectOnLogin(page, "%2Faccount%2Fsecurity");
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toHaveCount(0);
  });

  test("a sign-in → lobby → table → security page → legal page journey raises no CSP violation", async ({ page, context, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await request.post(`${fixture}/__test/auth`, { data: { signedOut: true } });
    await context.clearCookies();
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
      document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const consoleViolations: string[] = [];
    page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) consoleViolations.push(message.text()); });
    const violations = () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);

    await page.goto("/");
    await expectOnLogin(page, "%2F");
    await signInViaUi(page, { identifier: "Player-0", password: "fixture-password-0" });
    await expectSignedIn(page, "Player-0");
    await expect(page).toHaveURL(/3107\/$/);
    await page.getByRole("button", { name: "Custom table" }).click();
    await page.getByLabel("Seats").selectOption("2");
    await page.getByRole("button", { name: "Open table" }).click();
    await expect(page).toHaveURL(/3107\/table\/fixture-table$/);
    await expect(page.getByText("Waiting for another person to take a seat.", { exact: false })).toBeVisible();
    await settle(page);
    expect(await violations()).toEqual([]);

    await page.goto("/account/security");
    await page.getByRole("button", { name: "Set up" }).click();
    await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await settle(page);
    expect(await violations()).toEqual([]);

    await page.getByRole("navigation", { name: "Legal" }).getByRole("link", { name: "Fairness" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Game Fairness" })).toBeVisible();
    await settle(page);
    expect(await violations()).toEqual([]);
    expect(consoleViolations).toEqual([]);
  });
});

test.describe("contrast", () => {
  test("signed-in pages meet WCAG AA text contrast", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "spectator" } });
    await page.goto("/");
    await expectSignedIn(page);
    await page.getByRole("button", { name: "Custom table" }).click();
    await expect(page.getByText("Hand in progress", { exact: true })).toBeVisible();
    expect(await lowContrastTexts(page)).toEqual([]);
    await openAccountMenu(page);
    expect(await lowContrastTexts(page), "account menu").toEqual([]);

    for (const path of ["/terms", "/privacy", "/rules", "/fairness", "/responsible-gaming", "/complaints"]) {
      await page.goto(path);
      await expect(page.getByRole("note", { name: "Draft notice" })).toBeVisible();
      expect(await lowContrastTexts(page), path).toEqual([]);
    }

    await request.post(`${fixture}/__test/auth`, { data: { emailVerified: false } });
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { name: "Protect your account" })).toBeVisible();
    expect(await lowContrastTexts(page), "/welcome").toEqual([]);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Email", exact: true })).toBeVisible();
    expect(await lowContrastTexts(page), "/account").toEqual([]);
    await page.goto("/account/security");
    await expect(page.getByRole("heading", { name: "Where you're signed in" })).toBeVisible();
    await expect(page.getByTestId("session-row").first()).toBeVisible();
    expect(await lowContrastTexts(page), "/account/security").toEqual([]);
    await page.getByRole("button", { name: "Set up" }).click();
    await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
    expect(await lowContrastTexts(page), "TOTP setup").toEqual([]);
  });

  test.describe("signed out", () => {
    test.use({ session: "signed-out" });

    test("sign-in, sign-up and email-link pages meet WCAG AA text contrast", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByLabel("Username or email")).toBeVisible();
      expect(await lowContrastTexts(page), "/login").toEqual([]);
      await page.goto("/signup");
      await expect(page.getByLabel("I confirm that I am 18 years of age or older.")).toBeVisible();
      await page.getByLabel("Password", { exact: true }).fill("short");
      expect(await lowContrastTexts(page), "/signup").toEqual([]);
      for (const path of ["/reset-password", "/verify-email", "/email-change", "/auth/not-me"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await lowContrastTexts(page), path).toEqual([]);
      }
    });
  });
});
