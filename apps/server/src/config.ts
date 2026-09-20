import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = fileURLToPath(new URL(".", import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });
loadEnv({ path: resolve(here, "../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional().default(""),
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
