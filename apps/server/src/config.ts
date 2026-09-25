import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = fileURLToPath(new URL(".", import.meta.url));
loadEnv({ quiet: true, path: resolve(here, "../../../.env") });
loadEnv({ quiet: true, path: resolve(here, "../.env") });

/** Optional file path; a blank value (e.g. `TLS_CERT_FILE=` in .env) means unset. */
const optionalPath = z.string().optional().transform((value) => value?.trim() || undefined);

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
  // PEM certificate chain and private key for direct TLS termination (node:https).
  TLS_CERT_FILE: optionalPath,
  TLS_KEY_FILE: optionalPath,
});

export const env = envSchema.parse(process.env);
export const isProd = env.NODE_ENV === "production";
export const redisEnabled = env.REDIS_URL.length > 0;
export const tlsEnabled = Boolean(env.TLS_CERT_FILE && env.TLS_KEY_FILE);

if (Boolean(env.TLS_CERT_FILE) !== Boolean(env.TLS_KEY_FILE)) throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither");

if (isProd) {
  if (!env.CLIENT_ORIGIN.startsWith("https://")) throw new Error("Production requires HTTPS");
  // COMPLIANCE (TLS): hole cards may only travel over TLS. Either this process
  // terminates TLS, or it runs behind a trusted TLS-terminating proxy.
  if (!tlsEnabled && env.TRUST_PROXY_HOPS < 1) {
    throw new Error("Production requires TLS: set TLS_CERT_FILE and TLS_KEY_FILE, or set TRUST_PROXY_HOPS >= 1 behind a TLS-terminating proxy");
  }
  if (env.REDIS_URL && !env.REDIS_URL.startsWith("rediss://")) throw new Error("Production Redis requires TLS");
  const url = new URL(env.DATABASE_URL);
  if (!url.searchParams.has("sslmode") || url.searchParams.get("sslmode") !== "require" || url.searchParams.get("sslaccept") !== "strict") throw new Error("Database TLS with certificate validation is required");
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET || /change|replace|development/i.test(env.JWT_ACCESS_SECRET + env.JWT_REFRESH_SECRET)) throw new Error("Use independent random JWT secrets");
}
