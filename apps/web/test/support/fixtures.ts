import { resolve } from "node:path";
import { test as base, expect } from "@playwright/test";

/** The game and account fixture server (test/support/game-server.mjs). */
export const fixture = "http://127.0.0.1:4107";
/** TERMS_VERSION (apps/web/src/lib/legal.ts and the API's wrangler.jsonc). */
export const TERMS_VERSION = "2026-10-19";

const TURNSTILE_STUB = resolve(__dirname, "turnstile-stub.js");

/**
 * Every spec imports `test` and `expect` from here. Before each test:
 * - Cloudflare's Turnstile script is answered by a local stub (no network; tokens "stub-token-N");
 * - the account fixtures are reset: Player-0 signed in (the default), or nobody with
 *   `test.use({ session: "signed-out" })`;
 * - a signed-in browser gets the API's poker_session_hint cookie, as after a real sign-in, so the
 *   middleware's fast-path redirect (AUTH_HINT_REDIRECT=1) lets it through.
 */
export const test = base.extend<{ session: "signed-in" | "signed-out"; accountFixtures: void }>({
  session: ["signed-in", { option: true }],
  accountFixtures: [async ({ context, request, session }, use) => {
    await context.route(/^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/, (route) =>
      route.fulfill({ path: TURNSTILE_STUB, contentType: "text/javascript; charset=utf-8" }));
    await request.post(`${fixture}/__test/auth`, { data: { reset: true, signedOut: session === "signed-out" } });
    if (session === "signed-in") {
      await context.addCookies([{ name: "poker_session_hint", value: "1", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
    }
    await use();
  }, { auto: true }],
});

export { expect };
