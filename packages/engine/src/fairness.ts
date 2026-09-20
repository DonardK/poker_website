import { createHash, randomBytes } from "node:crypto";
import type { Card, CardProof } from "@poker/shared";

export interface DeckCommitment {
  context: string;
  root: string;
  deck: Card[];
  salts: string[];
  levels: string[][];
}

const hash = (value: unknown[]) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Salted Merkle commitment: openings reveal only cards a viewer may see. */
export function commitDeck(deck: Card[], tableId: string, handNumber: number): DeckCommitment {
  if (deck.length !== 52 || new Set(deck).size !== 52) throw new Error("Invalid committed deck");
  const context = JSON.stringify(["poker-deck-v1", tableId, handNumber]);
  const salts = Array.from({ length: 64 }, () => randomBytes(32).toString("hex"));
  const levels = [salts.map((salt, index) => hash(["leaf-v1", context, index, deck[index] ?? null, salt]))];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: string[] = [];
    for (let i = 0; i < previous.length; i += 2) next.push(hash(["node-v1", previous[i], previous[i + 1]]));
    levels.push(next);
  }
  return { context, root: levels.at(-1)![0]!, deck: [...deck], salts, levels };
}

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
