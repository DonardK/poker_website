/**
 * Pre-deal deck commitments.
 *
 * COMPLIANCE NOTES
 * - `commitDeck` runs on the complete shuffled deck before any card leaves
 *   it (see startHand). It produces two SHA-256 commitments:
 *     * `deckCommitment` = SHA-256 of the canonical encoding of
 *       (handId, tableId, handNumber, all 52 cards in order, 256-bit salt).
 *       This is the audit record's commitment to the initial deck sequence.
 *     * `root`: a salted Merkle root over the same 52 positions. It lets a
 *       player verify each card they are shown without learning any other
 *       card.
 * - Salts come from the host CSPRNG (`crypto.getRandomValues`). They make
 *   both commitments hiding, so a published commitment reveals nothing about
 *   undealt cards. The deck, salts and tree stay in server memory and the
 *   regulator's sealed record. They are never serialized to a client.
 * - SHA-256 is `node:crypto` `createHash` (synchronous; the same primitive
 *   the audit hash chain uses). workerd exposes it under `nodejs_compat`.
 */
import { createHash } from "node:crypto";
import {
  deckCommitmentPreimage,
  MERKLE_LEAVES,
  merkleContext,
  merkleLeafPreimage,
  merkleNodePreimage,
  UUID_V4,
  type Card,
  type CardProof,
} from "@poker/shared";
import { fullDeck } from "./cards.js";
import { csprngBytes, csprngUuid } from "./rng.js";

export interface DeckCommitment {
  handId: string;
  /** Merkle leaf context: ["poker-deck-v2", tableId, handNumber, handId]. */
  context: string;
  /** Salted Merkle root over the 52 deck positions (64 leaves). */
  root: string;
  /** Salted flat SHA-256 commitment to the whole deck order. */
  deckCommitment: string;
  deckSalt: string;
  deck: Card[];
  salts: string[];
  levels: string[][];
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const salt = (): string => {
  const bytes = csprngBytes(32);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
};

export function newHandId(): string {
  const id = csprngUuid();
  if (!UUID_V4.test(id)) throw new Error("randomUUID did not return a UUID v4");
  return id;
}

export function assertStandardDeck(deck: readonly Card[]): void {
  const valid = new Set(fullDeck());
  if (deck.length !== valid.size || new Set(deck).size !== valid.size || deck.some((card) => !valid.has(card))) {
    throw new Error("Invalid committed deck");
  }
}

export function merkleLevels(context: string, deck: readonly Card[], salts: readonly string[]): string[][] {
  if (salts.length !== MERKLE_LEAVES) throw new Error("Merkle tree needs one salt per leaf");
  const levels = [salts.map((leafSalt, index) => sha256Hex(merkleLeafPreimage(context, index, deck[index] ?? null, leafSalt)))];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: string[] = [];
    for (let i = 0; i < previous.length; i += 2) next.push(sha256Hex(merkleNodePreimage(previous[i]!, previous[i + 1]!)));
    levels.push(next);
  }
  return levels;
}

/** Commit to a complete deck order. Must be called before any card is dealt. */
export function commitDeck(deck: readonly Card[], tableId: string, handNumber: number, handId: string): DeckCommitment {
  assertStandardDeck(deck);
  if (!UUID_V4.test(handId) || !tableId || !Number.isSafeInteger(handNumber) || handNumber < 1) throw new Error("Invalid hand context");
  const context = merkleContext(tableId, handNumber, handId);
  const salts = Array.from({ length: MERKLE_LEAVES }, salt);
  const deckSalt = salt();
  const levels = merkleLevels(context, deck, salts);
  return {
    handId,
    context,
    root: levels.at(-1)![0]!,
    deckCommitment: sha256Hex(deckCommitmentPreimage(handId, tableId, handNumber, deck, deckSalt)),
    deckSalt,
    deck: [...deck],
    salts,
    levels,
  };
}

/** Merkle opening for one position. Callers must only open positions the recipient may see. */
export function cardProof(commitment: DeckCommitment, index: number): CardProof {
  if (!Number.isInteger(index) || index < 0 || index >= 52) throw new Error("Invalid card position");
  const siblings: string[] = [];
  let position = index;
  for (const level of commitment.levels.slice(0, -1)) {
    siblings.push(level[position ^ 1]!);
    position = Math.floor(position / 2);
  }
  return { index, card: commitment.deck[index]!, salt: commitment.salts[index]!, siblings };
}
