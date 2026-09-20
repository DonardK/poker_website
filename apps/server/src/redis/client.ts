import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { env, redisEnabled } from "../config.js";
import { logger } from "../logger.js";

export let redis: Redis | null = null;
export let redisPub: Redis | null = null;
export let redisSub: Redis | null = null;

export async function connectRedis(): Promise<void> {
  if (!redisEnabled) {
    logger.warn("REDIS_URL unset — using one Socket.io process; game state is durable in Postgres");
    return;
  }

  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  redisPub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  redisSub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

  await Promise.all([redis.connect(), redisPub.connect(), redisSub.connect()]);
  logger.info("Redis connected");
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all([redis?.quit(), redisPub?.quit(), redisSub?.quit()]);
  redis = redisPub = redisSub = null;
}

export function newOpaqueId(bytes = 32): string { return randomBytes(bytes).toString("hex"); }
