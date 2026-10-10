import { test, expect, type Page, type Route } from "@playwright/test";

const fixture = "http://127.0.0.1:4107";
const TERMS_VERSION = "2026-10-01";
const PLAY_CHIPS_NOTICE = "Play chips have no cash value and cannot be redeemed.";

const LEGAL_PAGES = [
  { path: "/terms", title: "Terms of Service", mustSay: ["at least 18 years old", PLAY_CHIPS_NOTICE, "cannot be recovered on another device"] },
  { path: "/privacy", title: "Privacy Notice", mustSay: ["IP address and browser user agent", "password hash", "hand history", "For counsel review"] },
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

/** No session: the refresh cookie is missing or expired, as for a first visit. */
async function signedOut(page: Page) {
  await page.route(`${fixture}/api/auth/refresh`, (route) => fulfillWith(route, 401, { error: "No refresh session" }));
}

const guestUser = { id: "fixture-player-0", username: "Guest_0a1b2c3d4e", kind: "HUMAN", role: "PLAYER", isGuest: true, bankroll: 10_000, avatarHue: 0 };

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
    for (const path of ["/", "/login", "/table/fixture-table", "/rules"]) {
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

test.describe("age and terms gate", () => {
  test("a guest account needs 18+ and terms, sends the acceptance as JSON, and is told it cannot be recovered", async ({ page, request }) => {
    // A brand-new guest holds no seat and the full starting bankroll. Without this reset the fixture's
    // hero is still seated from its default state (9,000 chips), and the lobby's first wallet refresh
    // replaced the 10,000 shown at sign-up before the check below could see it (flaky on desktop).
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await signedOut(page);
    let sent: { body: unknown; contentType: string | undefined } | null = null;
    await page.route(`${fixture}/api/auth/guest`, async (route) => {
      sent = { body: route.request().postDataJSON(), contentType: route.request().headers()["content-type"] };
      await fulfillWith(route, 201, { user: guestUser, accessToken: "browser-fixture-token" });
    });
    await page.goto("/");
    const guest = page.getByRole("button", { name: "Play as guest" });
    const age = page.getByLabel("I confirm that I am 18 years of age or older.");
    const terms = page.getByLabel(/I accept the Terms of Service/);
    await expect(age).not.toBeChecked();
    await expect(terms).not.toBeChecked();
    await expect(guest).toBeDisabled();
    await expect(page.locator('a[href="/terms"]').first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy Notice" })).toHaveAttribute("href", "/privacy");
    await expect(page.getByText("it cannot be recovered: it is lost if you sign out, clear this browser's data or switch device", { exact: false })).toBeVisible();

    await age.check();
    await expect(guest).toBeDisabled();
    await age.uncheck();
    await terms.check();
    await expect(guest).toBeDisabled();
    await age.check();
    await expect(guest).toBeEnabled();
    await guest.click();

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(sent).not.toBeNull();
    expect(sent!.body).toEqual({ acceptTerms: true, confirmAge: true, termsVersion: TERMS_VERSION });
    expect(sent!.contentType).toContain("application/json");
    await expect(page.getByText("10,000 chips", { exact: true })).toBeVisible();
    await expect(page.getByText(PLAY_CHIPS_NOTICE).first()).toBeVisible();
    await expect(page.getByText("Guest account: it cannot be recovered on another device", { exact: false })).toBeVisible();
  });

  test("terms refusals from the server are explained", async ({ page }) => {
    await signedOut(page);
    let reply: { status: number; json: unknown } = { status: 409, json: { error: "Terms version is outdated", code: "TERMS_OUTDATED", currentVersion: "2026-11-01" } };
    await page.route(`${fixture}/api/auth/guest`, (route) => fulfillWith(route, reply.status, reply.json));
    await page.goto("/");
    await page.getByLabel("I confirm that I am 18 years of age or older.").check();
    await page.getByLabel(/I accept the Terms of Service/).check();
    await page.getByRole("button", { name: "Play as guest" }).click();
    await expect(pageAlert(page)).toContainText("Our terms have been updated");
    await expect(pageAlert(page)).toContainText("Reload the page");

    reply = { status: 400, json: { error: "You must accept the terms and confirm your age", code: "TERMS_REQUIRED" } };
    await page.getByRole("button", { name: "Play as guest" }).click();
    await expect(pageAlert(page)).toHaveText("To continue, confirm that you are 18 or older and accept the Terms of Service and Privacy Notice.");
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("registration needs 18+ and terms and sends the acceptance; other conflicts keep their own message", async ({ page }) => {
    await signedOut(page);
    const bodies: unknown[] = [];
    // The server's own answers (apps/server/src/auth/routes.ts): a taken name is 409 "Username unavailable"; any other
    // clash (e.g. the e-mail) is a deliberately generic 409 that names no field.
    let reply: { status: number; json: unknown } = { status: 409, json: { error: "Username unavailable" } };
    await page.route(`${fixture}/api/auth/register`, async (route) => {
      bodies.push(route.request().postDataJSON());
      await fulfillWith(route, reply.status, reply.json);
    });
    await page.goto("/login");
    await page.getByRole("button", { name: "Register" }).click();
    await page.getByLabel("Username").fill("river_rat");
    await page.getByLabel("Email").fill("river@example.test");
    await page.getByLabel("Password").fill("a-long-enough-password");
    const create = page.getByRole("button", { name: "Create account" });
    await expect(create).toBeDisabled();
    await page.getByLabel("I confirm that I am 18 years of age or older.").check();
    await expect(create).toBeDisabled();
    await page.getByLabel(/I accept the Terms of Service/).check();
    await expect(create).toBeEnabled();
    await create.click();
    await expect(pageAlert(page)).toHaveText("Username unavailable");
    expect(bodies[0]).toEqual({
      username: "river_rat", email: "river@example.test", password: "a-long-enough-password",
      acceptTerms: true, confirmAge: true, termsVersion: TERMS_VERSION,
    });

    // Another 409 that is not about the terms keeps its own (generic) message.
    reply = { status: 409, json: { error: "Registration could not be completed with these details" } };
    await create.click();
    await expect(pageAlert(page)).toHaveText("Registration could not be completed with these details");

    reply = {
      status: 409,
      json: { error: "The terms have been updated; please review and accept the current version", code: "TERMS_OUTDATED", currentVersion: "2026-11-01" },
    };
    await create.click();
    await expect(pageAlert(page)).toContainText("Our terms have been updated (version 2026-11-01)");

    // Login is not account creation: no gate.
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.getByLabel("I confirm that I am 18 years of age or older.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
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
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.evaluate(() => sessionStorage.setItem("poker-live-evidence:fixture-table:1", "{}"));
    const sockets = () => page.evaluate(() => performance.getEntriesByType("resource").length);
    await sockets();

    await page.getByRole("button", { name: "Sign out" }).click();
    // Signed out here while the server has not answered yet.
    await expect(page.getByRole("button", { name: "Play as guest" })).toBeVisible();
    await expect.poll(() => logout !== null).toBe(true);
    expect(logoutAuth).toBe("Bearer browser-fixture-token");
    expect(await page.evaluate(() => sessionStorage.getItem("poker-live-evidence:fixture-table:1"))).toBeNull();

    await logout!.abort("internetdisconnected");
    await expect(page.getByText("You are signed out on this device, but the server could not be reached", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(page.getByText("Open tables")).toHaveCount(0);
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

test.describe("security headers", () => {
  for (const path of ["/", "/login", "/table/x"]) {
    test(`${path} sends a nonce-based CSP and the hardening headers`, async ({ request }) => {
      const first = await request.get(path);
      const second = await request.get(path);
      const csp = first.headers()["content-security-policy"] ?? "";
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
      expect(nonce, csp).toBeTruthy();
      expect(second.headers()["content-security-policy"]).not.toContain(nonce!);
      expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("connect-src 'self' http://127.0.0.1:4107 ws://127.0.0.1:4107");
      for (const directive of ["img-src 'self' data: blob:", "font-src 'self'", "frame-ancestors 'none'", "object-src 'none'",
        "base-uri 'none'", "form-action 'self'", "default-src 'self'"]) expect(csp).toContain(directive);
      // Next.js stamps this request's nonce on its own scripts.
      const html = await first.text();
      expect(html).toContain(`nonce="${nonce}"`);
      const headers = first.headers();
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=(), payment=()");
      expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
      // Development server: no HSTS (production only).
      expect(headers["strict-transport-security"]).toBeUndefined();
    });
  }

  test("a lobby → table → legal page journey raises no CSP violation", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
      document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const consoleViolations: string[] = [];
    page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) consoleViolations.push(message.text()); });
    const violations = () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);

    await page.goto("/");
    await page.getByRole("button", { name: "Custom table" }).click();
    await page.getByLabel("Seats").selectOption("2");
    await page.getByRole("button", { name: "Open table" }).click();
    await expect(page).toHaveURL(/3107\/table\/fixture-table$/);
    await expect(page.getByText("Waiting for another person to take a seat.", { exact: false })).toBeVisible();
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
  test("lobby, login and legal pages meet WCAG AA text contrast", async ({ page, request }) => {
    await request.post(`${fixture}/__test/reset`, { data: { mode: "spectator" } });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.getByRole("button", { name: "Custom table" }).click();
    await expect(page.getByText("Hand in progress", { exact: true })).toBeVisible();
    expect(await lowContrastTexts(page)).toEqual([]);

    for (const path of ["/terms", "/privacy", "/rules", "/fairness", "/responsible-gaming", "/complaints"]) {
      await page.goto(path);
      await expect(page.getByRole("note", { name: "Draft notice" })).toBeVisible();
      expect(await lowContrastTexts(page), path).toEqual([]);
    }

    await signedOut(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Play as guest" })).toBeVisible();
    expect(await lowContrastTexts(page)).toEqual([]);
    await page.goto("/login");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByLabel("I confirm that I am 18 years of age or older.")).toBeVisible();
    expect(await lowContrastTexts(page)).toEqual([]);
  });
});
