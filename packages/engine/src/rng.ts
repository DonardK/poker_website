import { randomBytes } from "node:crypto";

/**
 * Uniform integer in [0, maxExclusive) via CSPRNG with rejection sampling
 * (avoids modulo bias).
 */
export function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0 || !Number.isInteger(maxExclusive)) {
    throw new Error("maxExclusive must be a positive integer");
  }
  if (maxExclusive === 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < limit) return n % maxExclusive;
  }
}

export function secureRandomFloat(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

export function randIntInclusive(min: number, max: number): number {
  return min + secureRandomInt(max - min + 1);
}
