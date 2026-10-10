import { defineConfig, devices } from "@playwright/test";

/**
 * Live two-browser run against local `wrangler dev` and `next dev`.
 * Not part of CI: the default playwright.config.ts only loads test/browser.
 * This file runs nothing unless POKER_LIVE_E2E=1.
 */
const live = process.env.POKER_LIVE_E2E === "1";

export default defineConfig({
  testDir: "./test/e2e-live",
  testIgnore: live ? undefined : ["**/*"],
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    channel: process.env.PLAYWRIGHT_CHANNEL || "msedge",
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
