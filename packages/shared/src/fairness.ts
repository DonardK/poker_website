import type { Card } from "./poker.js";
import type { PublicTableState } from "./events.js";

export interface CardProof { index: number; card: Card; salt: string; siblings: string[] }
export interface PublicFairness {
  version: "merkle-sha256-v1";
  context: string;
  root: string;
  dealtSeats: number[];
  proofs: CardProof[];
}

async function hash(value: unknown[]): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function verifyCardProof(context: string, root: string, proof: CardProof): Promise<boolean> {
  const hex = /^[a-f0-9]{64}$/;
  if (!hex.test(root) || !hex.test(proof.salt) || !/^[2-9TJQKA][cdhs]$/.test(proof.card) ||
      !Number.isInteger(proof.index) || proof.index < 0 || proof.index >= 52 ||
      proof.siblings.length !== 6 || proof.siblings.some((s) => !hex.test(s))) return false;
  let digest = await hash(["leaf-v1", context, proof.index, proof.card, proof.salt]);
  let position = proof.index;
  for (const sibling of proof.siblings) {
    digest = await hash(position % 2 === 0 ? ["node-v1", digest, sibling] : ["node-v1", sibling, digest]);
    position = Math.floor(position / 2);
  }
  return digest === root;
}

/** Check both membership and the Hold'em deal positions, including burns. */
export async function verifyTableCards(state: PublicTableState): Promise<boolean> {
  const fair = state.fairness;
  if (!fair) return state.handNumber === 0;
  if (fair.version !== "merkle-sha256-v1" || fair.context !== JSON.stringify(["poker-deck-v1", state.tableId, state.handNumber])) return false;
  const n = fair.dealtSeats.length;
  if (n < 2 || n > 9 || new Set(fair.dealtSeats).size !== n || fair.dealtSeats.some((s) => !Number.isInteger(s) || s < 0 || s >= state.players.length)) return false;
  const expected = new Map<number, Card>();
  const boardPositions = [2 * n + 1, 2 * n + 2, 2 * n + 3, 2 * n + 5, 2 * n + 7];
  if (![0, 3, 4, 5].includes(state.board.length)) return false;
  state.board.forEach((card, i) => expected.set(boardPositions[i]!, card));
  for (const player of state.players) {
    if (!player.holeCards) continue;
    const first = fair.dealtSeats.indexOf(player.seatIndex);
    if (first < 0) return false;
    expected.set(first, player.holeCards[0]);
    expected.set(first + n, player.holeCards[1]);
  }
  if (new Set(expected.values()).size !== expected.size || fair.proofs.length !== expected.size || new Set(fair.proofs.map((p) => p.index)).size !== expected.size) return false;
  return (await Promise.all(fair.proofs.map((proof) => expected.get(proof.index) === proof.card && verifyCardProof(fair.context, fair.root, proof)))).every(Boolean);
}
