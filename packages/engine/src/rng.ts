import { randomBytes, randomInt } from "node:crypto";

/**
 * Uniform integer in [0, maxExclusive) via CSPRNG with rejection sampling
 * (avoids modulo bias).
 */
export function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0 || !Number.isSafeInteger(maxExclusive) || maxExclusive >= 2 ** 48) {
    throw new Error("maxExclusive must be a positive safe integer below 2^48");
  }
  if (maxExclusive === 1) return 0;
  return randomInt(maxExclusive);
}

export function secureRandomFloat(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

export function randIntInclusive(min: number, max: number): number {
  return min + secureRandomInt(max - min + 1);
}
