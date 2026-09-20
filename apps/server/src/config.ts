import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = fileURLToPath(new URL(".", import.meta.url));
loadEnv({ quiet: true, path: resolve(here, "../../../.env") });
loadEnv({ quiet: true, path: resolve(here, "../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:3000").transform((value) => new URL(value).origin),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional().default(""),
  GAME_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  DEFAULT_STARTING_BANKROLL: z.coerce.number().int().positive().default(10_000),
  TURN_TIME_BANK_MS: z.coerce.number().int().positive().default(15_000),
});

export const env = envSchema.parse(process.env);
export const isProd = env.NODE_ENV === "production";
export const redisEnabled = env.REDIS_URL.length > 0;

if (isProd) {
  if (!env.CLIENT_ORIGIN.startsWith("https://")) throw new Error("Production requires HTTPS");
  if (env.REDIS_URL && !env.REDIS_URL.startsWith("rediss://")) throw new Error("Production Redis requires TLS");
  const url = new URL(env.DATABASE_URL);
  if (!url.searchParams.has("sslmode") || url.searchParams.get("sslmode") !== "require" || url.searchParams.get("sslaccept") !== "strict") throw new Error("Database TLS with certificate validation is required");
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET || /change|replace|development/i.test(env.JWT_ACCESS_SECRET + env.JWT_REFRESH_SECRET)) throw new Error("Use independent random JWT secrets");
}
