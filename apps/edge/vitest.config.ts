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

/** Only a loopback URL may be injected. A remote string would be the live database. */
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

const hyperdrive = loopbackHyperdrive(process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE)
  ?? loopbackHyperdrive(vars.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE);

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
            // CLIENT_ORIGIN (wrangler.jsonc) is https, so readEdgeConfig runs the
            // production key checks: the keys below are random test-only values,
            // never the published placeholders, and the auth key differs from the game key.
            JWT_ACCESS_SECRET: "test-only-access-secret-32chars-min",
            JWT_REFRESH_SECRET: "test-only-refresh-secret-32chars-ok",
            WS_TICKET_SECRET: "test-only-ws-ticket-secret-32chars",
            GAME_ENCRYPTION_KEYS: "k1:c549a47e88271398c0804736a4fcbaa0273d3b09c944b7ee5bea23f3ad51b784",
            GAME_ENCRYPTION_ACTIVE_KEY_ID: "k1",
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
            AUTH_HMAC_SECRET: "test-only-auth-hmac-secret-32chars-ok",
            AUTH_ENCRYPTION_KEYS: "a1:5f2c8e1a9b7d4c3e6f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a",
            AUTH_ENCRYPTION_ACTIVE_KEY_ID: "a1",
            // Tests never call Have I Been Pwned.
            PASSWORD_BREACH_CHECK: "false",
          },
          // Top-level Miniflare option. Nesting this under bindings is ignored,
          // and the Worker then uses wrangler.jsonc's port-5432 placeholder.
          ...(hyperdrive ? { hyperdrives: { HYPERDRIVE: hyperdrive } } : {}),
        },
      }),
    ],
  };
});
