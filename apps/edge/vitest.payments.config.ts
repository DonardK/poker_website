import { randomBytes } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { bundlePg } from "./scripts/bundle-pg.mjs";

/**
 * The poker-payments Worker's own test project (docs/money/WALLET.md section
 * 14.1): src/payments/worker.ts as the main module with
 * wrangler.payments.jsonc's Durable Objects, in PAYMENTS_MODE=sandbox with
 * ENVIRONMENT=development. Run by `npm test -w @poker/edge` after the
 * poker-api project; tests live in test/payments-worker/.
 *
 * HYPERDRIVE_PAYMENTS is the payments login from apps/server/test/support/pg.mjs.
 * HYPERDRIVE_TEST_RUNTIME (poker_app) and HYPERDRIVE_TEST_ADMIN (the test
 * superuser) write fixtures payments may not write (users, sessions, step-up
 * grants, an ADMIN role). Both exist only here and only for loopback URLs:
 * wrangler.payments.jsonc never has them.
 */
function loopbackHyperdrive(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const host = new URL(value).hostname;
    if (host === "127.0.0.1" || host === "localhost") return value;
  } catch {
    return undefined;
  }
  return undefined;
}

const payments = loopbackHyperdrive(process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_PAYMENTS);
const runtime = loopbackHyperdrive(process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE);
const admin = loopbackHyperdrive(process.env.POKER_TEST_ADMIN_DATABASE_URL);
const hyperdrives: Record<string, string> = {
  ...(payments ? { HYPERDRIVE_PAYMENTS: payments } : {}),
  ...(runtime ? { HYPERDRIVE_TEST_RUNTIME: runtime } : {}),
  ...(admin ? { HYPERDRIVE_TEST_ADMIN: admin } : {}),
};

export default defineConfig(async () => {
  const pgBundle = await bundlePg();
  return {
    resolve: { alias: { pg: pgBundle } },
    // One file at a time: the database suites here flip cluster-wide state (the emergency stop, the switches).
    test: { include: ["test/payments-worker/**/*.test.ts"], fileParallelism: false },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.payments.jsonc" },
        miniflare: {
          bindings: {
            ENVIRONMENT: "development",
            PAYMENTS_MODE: "sandbox",
            PUBLIC_SITE_ORIGIN: "https://poker-web.test.example",
            PAYMENTS_PUBLIC_ORIGIN: "https://poker-payments.test.example",
            REAL_MONEY_COUNTRIES: "",
            CARD_PROVIDER_KEY: "sandbox",
            CRYPTO_PROVIDER_KEY: "sandbox",
            KYC_PROVIDER_KEY: "sandbox",
            ADMIN_REQUIRE_CF_ACCESS: "false",
            NUVEI_ENV: "int",
            BVNK_ENV: "sandbox",
            // Fresh per run, so nothing committed could be copied into a real deployment.
            SANDBOX_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
            NOTIFY_LINK_SECRET: randomBytes(32).toString("hex"),
            POKER_REQUIRE_DB_TESTS: process.env.POKER_REQUIRE_DB_TESTS ?? "",
          },
          ...(Object.keys(hyperdrives).length > 0 ? { hyperdrives } : {}),
        },
      }),
    ],
  };
});
