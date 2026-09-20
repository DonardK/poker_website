import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { env, redisEnabled } from "../config.js";
import { logger } from "../logger.js";

export let redis: Redis | null = null;
export let redisPub: Redis | null = null;
export let redisSub: Redis | null = null;

const memory = new Map<string, string>();
const memoryExpiries = new Map<string, NodeJS.Timeout>();

function memorySet(key: string, value: string, ttlMs?: number): void {
  memory.set(key, value);
  const existing = memoryExpiries.get(key);
  if (existing) clearTimeout(existing);
  if (ttlMs && ttlMs > 0) {
    memoryExpiries.set(
      key,
      setTimeout(() => {
        memory.delete(key);
        memoryExpiries.delete(key);
      }, ttlMs),
    );
  }
}

export async function connectRedis(): Promise<void> {
  if (!redisEnabled) {
    logger.warn("REDIS_URL unset — using in-process memory for table state (not horizontally scalable)");
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

export const kv = {
  async get(key: string): Promise<string | null> {
    if (redis) return redis.get(key);
    return memory.get(key) ?? null;
  },

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (redis) {
      if (ttlMs && ttlMs > 0) {
        await redis.set(key, value, "PX", ttlMs);
      } else {
        await redis.set(key, value);
      }
      return;
    }
    memorySet(key, value, ttlMs);
  },

  async del(key: string): Promise<void> {
    if (redis) {
      await redis.del(key);
      return;
    }
    memory.delete(key);
    const t = memoryExpiries.get(key);
    if (t) clearTimeout(t);
    memoryExpiries.delete(key);
  },
};

const UNLOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class LockBusyError extends Error {
  constructor(resource: string) {
    super(`Could not acquire lock for ${resource}`);
    this.name = "LockBusyError";
  }
}

export async function withLock<T>(resource: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const lockKey = `lock:${resource}`;
  const token = randomUUID();

  if (redis) {
    const acquired = await redis.set(lockKey, token, "PX", ttlMs, "NX");
    if (acquired !== "OK") throw new LockBusyError(resource);
    try {
      return await fn();
    } finally {
      await redis.eval(UNLOCK_LUA, 1, lockKey, token);
    }
  }

  const existing = memory.get(lockKey);
  if (existing) throw new LockBusyError(resource);
  memorySet(lockKey, token, ttlMs);
  try {
    return await fn();
  } finally {
    await kv.del(lockKey);
  }
}

export function newOpaqueId(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export const redisKeys = {
  tableState: (tableId: string) => `table:${tableId}:state`,
  userActiveTable: (userId: string) => `user:${userId}:activeTable`,
  socketUser: (socketId: string) => `socket:${socketId}:user`,
};
