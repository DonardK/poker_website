import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://127.0.0.1:5432/postgres";
}
const result = spawnSync("npx", ["prisma", "generate"], {
  cwd: app,
  env: process.env,
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
