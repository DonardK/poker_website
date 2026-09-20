import { ACTION_RATE_LIMIT_MAX, ACTION_RATE_LIMIT_WINDOW_MS } from "@poker/shared";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export function allowAction(userId: string): boolean {
  const now = Date.now();
  const existing = buckets.get(userId);
  if (!existing) {
    buckets.set(userId, { tokens: ACTION_RATE_LIMIT_MAX - 1, lastRefill: now });
    return true;
  }
  const elapsed = now - existing.lastRefill;
  const refill = (elapsed / ACTION_RATE_LIMIT_WINDOW_MS) * ACTION_RATE_LIMIT_MAX;
  existing.tokens = Math.min(ACTION_RATE_LIMIT_MAX, existing.tokens + refill);
  existing.lastRefill = now;
  if (existing.tokens < 1) return false;
  existing.tokens -= 1;
  return true;
}
