import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, fixture, test } from "../support/fixtures";

type Patch = { state?: Record<string, unknown>; turn?: Record<string, unknown>; actor?: Record<string, unknown>; hero?: Record<string, unknown> } | null;

async function reset(request: APIRequestContext, mode: string) {
  await request.post(`${fixture}/__test/reset`, { data: { mode } });
}

async function patchSnapshot(request: APIRequestContext, patch: Patch) {
  await request.post(`${fixture}/__test/snapshot-patch`, { data: { patch } });
}

async function actions(request: APIRequestContext): Promise<{ actionCount: number; lastAction: { action: string; amount?: number } | null }> {
  return (await request.get(`${fixture}/__test/actions`)).json();
}

async function seatClaims(request: APIRequestContext): Promise<Array<{ tableId: string; seatIndex: number; buyIn: number; commandId?: string }>> {
  return (await (await request.get(`${fixture}/__test/seat-claims`)).json()).claims;
}

/** Three seated players, a hand running, and the viewer (Player-0) to act. */
async function openActiveTable(page: Page, request: APIRequestContext) {
  await reset(request, "active");
  await page.goto("/table/fixture-table");
  const call = page.getByRole("button", { name: "Call 10", exact: true });
  await expect(call).toBeEnabled();
  return call;
}

/** The hero's own seat HUD turn clock (the hero is to act in "active" mode). */
function heroClock(page: Page) {
  return page.locator(".poker-table-hero").getByTestId("turn-clock");
}

/** The horizontal scale of the clock's fill as rendered (the a of matrix(a, b, c, d, e, f)). */
async function fillScale(clock: Locator): Promise<number> {
  return clock.getByTestId("turn-clock-fill").evaluate((el) => {
    const transform = getComputedStyle(el).transform;
    if (transform === "none") return 1;
    const match = /matrix\(([^,]+),/.exec(transform);
    return match ? Number(match[1]) : Number.NaN;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.describe("turn clock", () => {
  test("counts from the server's relative remaining time, never the device's wall clock", async ({ page, request }) => {
    // The device clock runs 30 minutes fast. The old clock computed turnEndsAt - Date.now() and showed no time left.
    await page.addInitScript(() => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + 30 * 60_000;
    });
    await openActiveTable(page, request);
    const clock = heroClock(page);
    await expect(clock).toBeVisible();
    // The fixture gives 600 s per turn.
    await expect(clock.getByTestId("turn-clock-seconds")).toHaveText(/^(10:00|9:5\d)$/);
    expect(await fillScale(clock)).toBeGreaterThan(0.9);
    await expect(page.getByTestId("turn-countdown")).toHaveText(/^(10:00|9:5\d) left$/);

    // A newer server sends turnRemainingMs: it wins over everything else, measured from arrival.
    await patchSnapshot(request, { turn: { turnRemainingMs: 20_000 } });
    await expect(clock.getByTestId("turn-clock-seconds")).toHaveText(/^(20|19|18) s$/);
    await expect(page.getByTestId("turn-countdown")).toHaveText(/^(20|19|18) s left$/);
  });

  test("shows the time-bank phase distinctly when the server splits base and bank time", async ({ page, request }) => {
    await openActiveTable(page, request);
    const clock = heroClock(page);
    await patchSnapshot(request, { turn: { turnRemainingMs: 38_000 }, actor: { timeBankMsRemaining: 38_000, baseTimeMsRemaining: 8_000, extraTimeMs: 30_000 } });
    await expect(clock).toHaveAttribute("data-phase", "base");
    await expect(clock).toContainText("+30 s bank");
    await expect(page.getByTestId("turn-countdown")).toHaveText(/^[5-8] s left \(\+30 s bank\)$/);

    await patchSnapshot(request, { turn: { turnRemainingMs: 20_000 }, actor: { timeBankMsRemaining: 20_000, baseTimeMsRemaining: 0, extraTimeMs: 30_000 } });
    await expect(clock).toHaveAttribute("data-phase", "timebank");
    await expect(clock).toContainText("Time bank");
    await expect(page.getByTestId("turn-countdown")).toHaveText(/^Time bank (20|19|18) s$/);
    // The bank bar shows the share of the bank left (20 of 30 s), not an empty bar.
    // (Polled: the fill glides between updates.)
    await expect.poll(() => fillScale(clock)).toBeGreaterThan(0.5);
    expect(await fillScale(clock)).toBeLessThan(0.75);
  });

  test("under reduced motion the bar is not drained at once: it steps each second, with a text countdown", async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openActiveTable(page, request);
    const clock = heroClock(page);
    await expect(clock).toBeVisible();
    // The blanket reduced-motion rule used to collapse the drain animation and empty the bar immediately.
    await page.waitForTimeout(400);
    const scale = await fillScale(clock);
    expect(scale).toBeGreaterThan(0.95);
    // Stepped to whole seconds of the 600 s turn, with no transition.
    expect(Math.abs(scale * 600 - Math.round(scale * 600))).toBeLessThan(0.01);
    expect(await clock.getByTestId("turn-clock-fill").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");

    await patchSnapshot(request, { turn: { turnRemainingMs: 10_000 } });
    const seconds = clock.getByTestId("turn-clock-seconds");
    await expect(seconds).toHaveText(/^(10|9) s$/);
    const first = Number((await seconds.textContent())?.replace(" s", ""));
    await expect.poll(async () => Number((await seconds.textContent())?.replace(" s", "")), { timeout: 4_000 }).toBeLessThan(first);
  });
});

test.describe("actions never wait on sound or storage", () => {
  test("blocked storage and a broken AudioContext do not freeze the action buttons", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); } });
      // @ts-expect-error test double
      window.AudioContext = function BrokenAudioContext() { throw new Error("No audio device"); };
    });
    const call = await openActiveTable(page, request);
    await call.click();
    await expect(page.getByText("Waiting for an opponent to act…")).toBeVisible();
    expect((await actions(request)).actionCount).toBe(1);
    // The sound toggle still works for this tab, without storage.
    const sound = page.getByRole("button", { name: /^Sound (on|off)$/ });
    await sound.click();
    await expect(sound).toHaveText("Sound off");
    expect(errors).toEqual([]);
  });

  test("a suspended AudioContext is resumed on the first gesture", async ({ page, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __audioResumes: number; AudioContext: unknown };
      w.__audioResumes = 0;
      class FakeAudioContext {
        state = "suspended";
        currentTime = 0;
        destination = {};
        resume() { w.__audioResumes += 1; this.state = "running"; return Promise.resolve(); }
        createOscillator() { return { connect() {}, frequency: { setValueAtTime() {} }, start() {}, stop() {} }; }
        createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
      }
      w.AudioContext = FakeAudioContext;
    });
    await openActiveTable(page, request);
    await page.locator("h1").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __audioResumes: number }).__audioResumes)).toBeGreaterThan(0);
  });
});

test("the bet amount is always a whole number, and the label is what is sent", async ({ page, request }) => {
  await openActiveTable(page, request);
  const input = page.getByLabel("Raise to", { exact: true });
  await input.fill("150.5");
  await expect(input).toHaveValue("150");
  const raise = page.getByRole("button", { name: /^Raise to / });
  await expect(raise).toHaveText("Raise to 150");

  // Clearing the field never shows NaN; blur restores the amount that would be sent.
  await input.fill("");
  await expect(raise).toHaveText(/^Raise to \d[\d,]*$/);
  await input.blur();
  const restored = await input.inputValue();
  expect(restored).toMatch(/^\d+$/);
  await expect(raise).toHaveText(`Raise to ${Number(restored).toLocaleString("en-US")}`);

  // Shortcuts and the slider share the same integer model.
  await page.getByRole("button", { name: "Pot", exact: true }).click();
  const pot = await input.inputValue();
  expect(pot).toMatch(/^\d+$/);
  await expect(raise).toHaveText(`Raise to ${Number(pot).toLocaleString("en-US")}`);
  await expect(page.getByRole("slider", { name: "Bet amount slider" })).toHaveValue(pot);

  await input.fill("150.9");
  await raise.click();
  await expect(page.getByText("Waiting for an opponent to act…")).toBeVisible();
  expect((await actions(request)).lastAction).toEqual({ action: "RAISE", amount: 150 });
});

test.describe("turn announcements", () => {
  test("announce the hero's turn once and once more at 5 seconds, with a visible countdown", async ({ page, request }) => {
    await reset(request, "active");
    await patchSnapshot(request, { turn: { turnRemainingMs: 8_000 } });
    await page.goto("/table/fixture-table");
    const announcer = page.getByTestId("turn-announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await expect(announcer).toHaveText(/^Your turn — [678] seconds to act$/);
    await expect(page.getByTestId("turn-countdown")).toHaveText(/^[5-8] s left$/);
    // A newer snapshot of the same turn is not announced again.
    await patchSnapshot(request, { turn: { turnRemainingMs: 7_000 } });
    await page.waitForTimeout(300);
    await expect(announcer).toHaveText(/^Your turn — [678] seconds to act$/);
    await expect(announcer).toHaveText("5 seconds left to act", { timeout: 4_000 });
    // No per-second ticking afterwards.
    await page.waitForTimeout(1_500);
    await expect(announcer).toHaveText("5 seconds left to act");
  });

  test("the felt announces meaningful changes only, not every pot change", async ({ page, request }) => {
    const call = await openActiveTable(page, request);
    expect(await page.locator(".poker-table-center").getAttribute("aria-live")).toBeNull();
    const felt = page.getByTestId("felt-announcer");
    await expect(felt).toHaveText("");
    await call.click();
    await expect(page.getByText("Waiting for an opponent to act…")).toBeVisible();
    await expect(page.getByText("Pot 25 chips", { exact: true })).toBeVisible();
    // The pot moved, nothing else did: nothing to announce.
    await expect(felt).toHaveText("");
    // The others call and check: the flop is dealt, and its cards are announced by name.
    await request.post(`${fixture}/__test/play-others`);
    await expect(felt).toHaveText(/^Flop: (\w+ of \w+, ){2}\w+ of \w+\.$/);
  });

  test("\"Focus actions on my turn\" moves focus to the actions when the turn starts", async ({ page, request }) => {
    await openActiveTable(page, request);
    const pref = page.getByRole("button", { name: "Focus actions on my turn" });
    await expect(pref).toHaveAttribute("aria-pressed", "false");
    await pref.click();
    await expect(pref).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByRole("button", { name: "Fold", exact: true })).toBeFocused();
  });
});

/** WCAG relative-luminance contrast of an element's text over its own (opaque) background. */
async function contrastOf(control: Locator): Promise<{ ratio: number; backgroundAlpha: number }> {
  return control.evaluate((el) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // Tailwind 4 resolves to oklch(); the canvas converts any CSS colour to sRGB.
    const rgba = (css: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const style = getComputedStyle(el);
    const fg = rgba(style.color);
    const bg = rgba(style.backgroundColor);
    // Text alpha composited over the background.
    const mix = (f: number, b: number) => f * fg.a + b * (1 - fg.a);
    const text = { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
    const channel = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const [hi, lo] = [lum(text), lum(bg)].sort((x, y) => y - x);
    return { ratio: (hi + 0.05) / (lo + 0.05), backgroundAlpha: bg.a * Number(style.opacity) };
  });
}

test("action buttons and the open-seat label meet WCAG AA contrast", async ({ page, request }) => {
  await openActiveTable(page, request);
  const controls = [
    page.getByRole("button", { name: "Fold", exact: true }),
    page.getByRole("button", { name: "Call 10", exact: true }),
    page.getByRole("button", { name: /^Raise to / }),
    page.getByTestId("open-seat").first(),
  ];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const { ratio, backgroundAlpha } = await contrastOf(control);
    expect(backgroundAlpha, `${await control.textContent()} needs an opaque background for this check`).toBe(1);
    expect(ratio, `${await control.textContent()} contrast`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the header says the cards match the commitment, and explains what that does not mean", async ({ page, request }) => {
  await openActiveTable(page, request);
  await expect(page.getByTestId("table-status")).toHaveText("Cards match commitment");
  await expect(page.getByText("Cards verified")).toHaveCount(0);
  const info = page.getByRole("button", { name: "About the card check" });
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await info.click();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  const note = page.getByRole("note");
  await expect(note).toContainText("match the commitment the server published before the deal");
  await expect(note).toContainText("not a fairness certification");
  await page.keyboard.press("Escape");
  await expect(note).toHaveCount(0);
  await expect(info).toBeFocused();
});

test("chip amounts never show a currency symbol, and cards are named by rank", async ({ page, request }) => {
  await openActiveTable(page, request);
  await expect(page.getByText("Pot 15 chips", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("$");
  await expect(page.locator("main")).toContainText("Player-0 · 9,000 chips");
  const cards = page.locator(".poker-table-hero").getByRole("img");
  await expect(cards).toHaveCount(2);
  for (const name of await cards.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))) {
    expect(name).toMatch(/^(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Jack|Queen|King|Ace) of (hearts|diamonds|clubs|spades)$/);
  }
});

test.describe("buy-in dialog", () => {
  test("\"Sit here\" asks for the amount first; nothing is sent until Confirm", async ({ page, request }) => {
    await reset(request, "spectator");
    await page.goto("/table/fixture-table");
    const sit = page.getByRole("button", { name: /Sit at seat/ }).first();
    await sit.click();
    const dialog = page.getByRole("dialog", { name: "Buy in for seat 1" });
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const amount = dialog.getByRole("spinbutton", { name: "Buy-in" });
    // Default: 100 big blinds, within the table's 200-2,000 and the 10,000 bankroll.
    await expect(amount).toHaveValue("1000");
    await expect(amount).toBeFocused();
    await expect(dialog.getByTestId("buy-in-balance")).toContainText("9,000 chips");
    expect(await seatClaims(request)).toEqual([]);

    // Escape cancels, sends nothing and returns focus to "Sit here".
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(sit).toBeFocused();
    expect(await seatClaims(request)).toEqual([]);

    await sit.click();
    await amount.fill("1500.7");
    await expect(amount).toHaveValue("1500");
    await expect(dialog.getByTestId("buy-in-balance")).toContainText("8,500 chips");
    await amount.fill("5000");
    await amount.blur();
    await expect(amount).toHaveValue("2000");
    // Focus stays in the dialog.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await amount.fill("1500");
    await dialog.getByRole("button", { name: "Confirm buy-in" }).click();
    await expect(dialog).toHaveCount(0);
    const claims = await seatClaims(request);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ tableId: "fixture-table", seatIndex: 0, buyIn: 1500 });
    expect(claims[0].commandId).toMatch(UUID);
    await expect(page.locator(".poker-table-hero")).toContainText("1,500");
  });

  test("a refused claim keeps the dialog open with the reason and no false timeout", async ({ page, request }) => {
    await reset(request, "spectator");
    await page.goto("/table/fixture-table");
    await request.post(`${fixture}/__test/reject-next-seat`);
    await page.getByRole("button", { name: /Sit at seat/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Buy in for seat 1" });
    const confirm = dialog.getByRole("button", { name: "Confirm buy-in" });
    await confirm.click();
    await expect(dialog.getByRole("alert")).toHaveText("That seat was just taken. Choose another seat.");
    await expect(confirm).toBeEnabled();
    await expect(page.getByText(/timed out/i)).toHaveCount(0);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    const claims = await seatClaims(request);
    expect(claims).toHaveLength(2);
    // A new attempt after a refusal is a new command.
    expect(claims[0].commandId).not.toBe(claims[1].commandId);
  });

  test("Confirm is disabled when the bankroll no longer covers the minimum", async ({ page, request }) => {
    await reset(request, "spectator");
    await page.goto("/table/fixture-table");
    await page.getByRole("button", { name: /Sit at seat/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Buy in for seat 1" });
    await request.post(`${fixture}/__test/bankroll`, { data: { bankroll: 150 } });
    await expect(dialog.getByRole("alert")).toHaveText("You need at least 200 chips to sit here.");
    await expect(dialog.getByRole("button", { name: "Confirm buy-in" })).toBeDisabled();
  });
});

test.describe("absence copy", () => {
  test("\"Back to lobby\" says the seat is kept and what happens on a missed turn", async ({ page, request }) => {
    await openActiveTable(page, request);
    await expect(page.getByText("Lobby (keep seat)")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to lobby" }))
      .toHaveAccessibleDescription("You stay seated. If you miss a turn you are sat out automatically.");
  });

  test("a player sat out by the server is told why next to \"Sit in\"", async ({ page, request }) => {
    await reset(request, "waiting");
    await patchSnapshot(request, { hero: { sittingOut: true, sittingOutReason: "TIMEOUT" } });
    await page.goto("/table/fixture-table");
    const sitIn = page.getByRole("button", { name: "Sit in", exact: true });
    await expect(sitIn).toHaveAccessibleDescription(/time to act ran out/);
    await expect(page.getByTestId("sit-out-notice")).toBeVisible();

    await patchSnapshot(request, { hero: { sittingOut: true, sittingOutReason: "DISCONNECTED" } });
    await expect(sitIn).toHaveAccessibleDescription(/connection dropped/);

    // A sit-out the player chose needs no notice.
    await patchSnapshot(request, { hero: { sittingOut: true, sittingOutReason: "SELF" } });
    await expect(page.getByTestId("sit-out-notice")).toHaveCount(0);
  });
});
