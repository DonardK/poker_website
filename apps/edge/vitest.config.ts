import { existsSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { bundlePg } from "./scripts/bundle-pg.mjs";

/** Local secrets and the Docker Hyperdrive URL. The vitest pool does not load .dev.vars itself. */
function devVars(): Record<string, string> {
  const file = new URL("./.dev.vars", import.meta.url);
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const vars = devVars();
const hyperdrive = vars.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;

export default defineConfig(async () => {
  const pgBundle = await bundlePg();
  return {
    resolve: { alias: { pg: pgBundle } },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
        bindings: {
          // Stable test secrets. lobby.test.ts signs with these exact strings.
          JWT_ACCESS_SECRET: "test-only-access-secret-32chars-min",
          JWT_REFRESH_SECRET: "test-only-refresh-secret-32chars-ok",
          WS_TICKET_SECRET: "test-only-ws-ticket-secret-32chars",
          GAME_ENCRYPTION_KEYS: "k1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          GAME_ENCRYPTION_ACTIVE_KEY_ID: "k1",
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
        },
          ...(hyperdrive ? { hyperdrives: { HYPERDRIVE: hyperdrive } } : {}),
        },
      }),
    ],
  };
});
