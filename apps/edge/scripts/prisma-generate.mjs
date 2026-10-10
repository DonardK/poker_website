import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const local = "postgres://127.0.0.1:5432/postgres";

/** Generate never opens a connection. Refuse any URL that is not loopback so a shell or .env value cannot be the one Prisma parses. */
function loopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

if (!loopback(process.env.DATABASE_URL ?? "")) process.env.DATABASE_URL = local;
if (!loopback(process.env.DIRECT_URL ?? "")) process.env.DIRECT_URL = process.env.DATABASE_URL;
const result = spawnSync("npx", ["prisma", "generate"], {
  cwd: app,
  env: process.env,
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
