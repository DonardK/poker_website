import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  globalTeardown: "./test/support/restore-next-env.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:3107", trace: "retain-on-failure", channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    { command: "node test/support/game-server.mjs", url: "http://127.0.0.1:4107/health", timeout: 30_000 },
    {
      command: "node ../../node_modules/next/dist/bin/next dev --port 3107 --hostname 127.0.0.1",
      url: "http://127.0.0.1:3107", timeout: 120_000,
      env: {
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:4107", NEXT_PUBLIC_SOCKET_URL: "http://127.0.0.1:4107",
        POKER_TEST_DIST_DIR: ".next-browser-test", NEXT_TELEMETRY_DISABLED: "1",
        // Cloudflare's always-passes test key; every spec answers the script with test/support/turnstile-stub.js.
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        // The middleware's sign-in redirect is on in the suite (the fixture sets poker_session_hint like the API).
        AUTH_HINT_REDIRECT: "1",
        // Next.js rewrites a middleware redirect to 127.0.0.1 as "localhost" (its loopback normalisation), which would move
        // the browser to another cookie and storage host. next.config.ts turns that off for this server only.
        POKER_SKIP_MIDDLEWARE_URL_NORMALIZE: "1",
      },
    },
  ],
});
