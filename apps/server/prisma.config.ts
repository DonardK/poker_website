import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ quiet: true, path: path.resolve(here, "../../.env") });
loadEnv({ quiet: true, path: path.resolve(here, ".env") });
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("Configure DIRECT_URL for administrator migrations or DATABASE_URL for runtime commands");
export default defineConfig({
  schema: path.join(here, "prisma", "schema.prisma"),
  migrations: { path: path.join(here, "prisma", "migrations"), seed: "tsx prisma/seed.ts" },
  datasource: { url },
});
