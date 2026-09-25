/**
 * Random number generation for all game outcomes.
 *
 * COMPLIANCE NOTES (GLI-19 RNG requirements)
 * - Entropy source: every random word comes from `crypto.randomFillSync`.
 *   Node implements it with OpenSSL's CSPRNG, a NIST SP 800-90A DRBG that
 *   the OS entropy source (getrandom(2) or BCryptGenRandom) seeds and reseeds.
 *   This module has no seeding API and no replay mode. It never uses a
 *   non-cryptographic generator such as Math.random() or a seeded PRNG.
 * - Scaling: `uniformFromWords` maps 32-bit words to [0, range) by explicit
 *   rejection sampling. Words at or above the largest multiple of `range` that
 *   fits in 2^32 are discarded. Every accepted residue therefore has exactly
 *   the same number of preimages, so the result has zero modulo bias.
 * - Consumed randomness is zeroed immediately. A block is also wiped when its
 *   stream is disposed, so a shuffle's inputs do not stay in memory.
 * - Continuous health test: each 256-byte block drawn from the OS is checked
 *   for being all-zero or identical to the previous block. The previous block
 *   is compared through its SHA-256 digest and is not retained. For a healthy
 *   source, the chance of a false alarm is negligible (below 2^-256 per
 *   block). On failure, `RngFailure` is thrown and no hand can start.
 */
import { createHash, randomBytes, randomFillSync } from "node:crypto";

/** 2^32: the number of distinct values of one random word. */
export const U32_SPAN = 0x1_0000_0000;
const WORDS_PER_BLOCK = 64; // 256 bytes per OS request
/** Consecutive rejections before the source is declared broken (p <= 2^-128 for a healthy source). */
const MAX_CONSECUTIVE_REJECTIONS = 128;

export class RngFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RngFailure";
  }
}

function assertRange(range: number): void {
  if (!Number.isSafeInteger(range) || range < 1 || range > U32_SPAN) {
    throw new RangeError("Random range must be an integer between 1 and 2^32");
  }
}

/**
 * Largest multiple of `range` not exceeding 2^32. Words in [0, limit) are
 * accepted; words in [limit, 2^32) are rejected and redrawn.
 */
export function rejectionLimit(range: number): number {
  assertRange(range);
  return U32_SPAN - (U32_SPAN % range);
}

/**
 * Uniform integer in [0, range) from a source of uniform 32-bit words, using
 * explicit rejection sampling (see module notes). Pure with respect to
 * `nextWord`, so tests can verify the exact acceptance boundary.
 */
export function uniformFromWords(range: number, nextWord: () => number): number {
  const limit = rejectionLimit(range);
  for (let attempt = 0; attempt < MAX_CONSECUTIVE_REJECTIONS; attempt++) {
    const word = nextWord();
    if (!Number.isInteger(word) || word < 0 || word >= U32_SPAN) throw new RngFailure("Random word out of range");
    if (word < limit) return word % range;
  }
  throw new RngFailure("Random source failed the rejection-sampling health limit");
}

let previousBlockDigest: Buffer | null = null;

/** Continuous health test for one block drawn from the OS CSPRNG. */
function assertHealthyBlock(block: Uint32Array): void {
  if (block.every((word) => word === 0)) throw new RngFailure("CSPRNG returned an all-zero block");
  const digest = createHash("sha256").update(new Uint8Array(block.buffer, block.byteOffset, block.byteLength)).digest();
  if (previousBlockDigest?.equals(digest)) throw new RngFailure("CSPRNG repeated its previous output block");
  previousBlockDigest = digest;
}

/**
 * Stream of 32-bit words from the OS CSPRNG, refilled in 256-byte blocks.
 * Each word is zeroed when consumed; dispose() wipes the rest.
 */
export class CsprngWordStream {
  readonly #block = new Uint32Array(WORDS_PER_BLOCK);
  #position = WORDS_PER_BLOCK;

  next(): number {
    if (this.#position >= this.#block.length) {
      randomFillSync(this.#block);
      assertHealthyBlock(this.#block);
      this.#position = 0;
    }
    const word = this.#block[this.#position]!;
    this.#block[this.#position++] = 0;
    return word;
  }

  dispose(): void {
    this.#block.fill(0);
    this.#position = this.#block.length;
  }
}

/** Uniform integer in [0, maxExclusive) from the OS CSPRNG, without modulo bias. */
export function secureRandomInt(maxExclusive: number): number {
  const stream = new CsprngWordStream();
  try {
    return uniformFromWords(maxExclusive, () => stream.next());
  } finally {
    stream.dispose();
  }
}

/** Uniform float in [0, 1) on a 2^-32 grid. Used only for bot pacing and strategy, never for cards. */
export function secureRandomFloat(): number {
  return randomBytes(4).readUInt32BE(0) / U32_SPAN;
}

export function randIntInclusive(min: number, max: number): number {
  return min + secureRandomInt(max - min + 1);
}
