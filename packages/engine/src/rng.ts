/**
 * Random number generation for all game outcomes.
 *
 * COMPLIANCE NOTES (GLI-19 RNG requirements)
 * - Entropy source: every random word comes from `globalThis.crypto.getRandomValues`.
 *   That is the host CSPRNG, called synchronously: Node 20+ (OpenSSL's NIST
 *   SP 800-90A DRBG, seeded by the OS) and Cloudflare workerd (Workers CSPRNG).
 *   This module has no seeding API and no replay mode. It never uses a
 *   non-cryptographic generator such as Math.random() or a seeded PRNG.
 *   `node:crypto` `randomFillSync` / `randomBytes` are not used. Shuffle
 *   indexes do not depend on anything stored between calls.
 * - Scaling: `uniformFromWords` maps 32-bit words to [0, range) by explicit
 *   rejection sampling. Words at or above the largest multiple of `range` that
 *   fits in 2^32 are discarded. Every accepted residue therefore has exactly
 *   the same number of preimages, so the result has zero modulo bias.
 * - Consumed randomness is zeroed immediately. A block is also wiped when its
 *   stream is disposed, so a shuffle's inputs do not stay in memory.
 * - Continuous health test: each 256-byte block drawn from the CSPRNG is
 *   checked for being all-zero or identical to the previous block. The
 *   previous block is compared through its SHA-256 digest and is not retained.
 *   SHA-256 here is `node:crypto` `createHash`, which workerd's `nodejs_compat`
 *   provides synchronously. `crypto.subtle.digest` is asynchronous and would
 *   force the deal path to await; a second SHA-256 implementation could also
 *   drift from the audit verifier, which already treats this `createHash`
 *   output as the commitment hash.
 * - The digest is isolate-local health state, not a seed. It is never mixed
 *   into a draw, never persisted, and never required for a correct shuffle.
 *   A Durable Object or workerd isolate restart clears this module scope and
 *   simply opens a new comparison window. Do not store the digest in DO
 *   storage: that would couple later hands to a previous isolate's output
 *   without improving the shuffle.
 *   For a healthy source, the chance of a false alarm is negligible (below
 *   2^-256 per block). On failure, `RngFailure` is thrown and no hand can start.
 */
import { createHash } from "node:crypto";

/** 2^32: the number of distinct values of one random word. */
export const U32_SPAN = 0x1_0000_0000;
const WORDS_PER_BLOCK = 64; // 256 bytes per CSPRNG request
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

function hostCrypto(): NonNullable<typeof globalThis.crypto> {
  const webCrypto = globalThis.crypto;
  if (webCrypto == null || typeof webCrypto.getRandomValues !== "function") {
    throw new RngFailure("CSPRNG is unavailable");
  }
  return webCrypto;
}

type RandomView = Parameters<NonNullable<typeof globalThis.crypto>["getRandomValues"]>[0];

/** Fill `target` in place from the host CSPRNG. The same view is passed through so callers can wipe it. */
function fillRandom<T extends RandomView>(target: T): T {
  return hostCrypto().getRandomValues(target);
}

/**
 * In-isolate continuous health window. Not entropy. See the module notes:
 * an isolate restart clears it, and that must stay true.
 */
const rngHealth: { previousBlockDigest: Uint8Array | null } = {
  previousBlockDigest: null,
};

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

/** Continuous health test for one block drawn from the host CSPRNG. */
function assertHealthyBlock(block: Uint32Array): void {
  if (block.every((word) => word === 0)) throw new RngFailure("CSPRNG returned an all-zero block");
  const bytes = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
  const digest = new Uint8Array(createHash("sha256").update(bytes).digest());
  const previous = rngHealth.previousBlockDigest;
  if (previous !== null && sameBytes(previous, digest)) throw new RngFailure("CSPRNG repeated its previous output block");
  rngHealth.previousBlockDigest = digest;
}

/**
 * Stream of 32-bit words from the host CSPRNG, refilled in 256-byte blocks.
 * Each word is zeroed when consumed; dispose() wipes the rest.
 */
export class CsprngWordStream {
  readonly #block = new Uint32Array(WORDS_PER_BLOCK);
  #position = WORDS_PER_BLOCK;

  next(): number {
    if (this.#position >= this.#block.length) {
      fillRandom(this.#block);
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

/** Uniform integer in [0, maxExclusive) from the host CSPRNG, without modulo bias. */
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
  const word = new Uint32Array(1);
  fillRandom(word);
  return word[0]! / U32_SPAN;
}

export function randIntInclusive(min: number, max: number): number {
  return min + secureRandomInt(max - min + 1);
}

/** Host CSPRNG bytes for salts and other non-shuffle draws. At most one `getRandomValues` quota (65,536). */
export function csprngBytes(byteLength: number): Uint8Array {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 65_536) {
    throw new RangeError("CSPRNG byte length must be an integer from 1 to 65536");
  }
  const bytes = new Uint8Array(byteLength);
  fillRandom(bytes);
  return bytes;
}

/** UUID from the host CSPRNG (`crypto.randomUUID`). */
export function csprngUuid(): string {
  const webCrypto = hostCrypto();
  if (typeof webCrypto.randomUUID !== "function") throw new RngFailure("CSPRNG is unavailable");
  return webCrypto.randomUUID();
}
