import type { Card } from "./poker.js";
import type { PublicTableState } from "./events.js";
import { boardPositions, HEX_64, merkleContext, UUID_V4, verifyCardProof, type CardProof } from "./audit.js";

/**
 * Live, per-viewer fairness data. The commitments are COMPUTED before any
 * card is dealt, and the audit record's event order proves it. They are
 * first PUBLISHED in the hand's first snapshot, together with the viewer's
 * hole cards and before any community card. The Merkle openings cover only
 * cards this viewer is entitled to see.
 */
export interface PublicFairness {
  version: "merkle-sha256-v2";
  handId: string;
  context: string;
  root: string;
  deckCommitment: string;
  /** Number of audit events so far and the hash of the latest event. */
  auditSeq: number;
  auditHead: string;
  dealtSeats: number[];
  proofs: CardProof[];
}

/**
 * Check every visible card against the pre-deal commitment and its exact
 * Hold'em deal position (holes, then burn-flop, burn-turn, burn-river).
 */
export async function verifyTableCards(state: PublicTableState): Promise<boolean> {
  const fair = state.fairness;
  // Between hands (after Hand Clean-up) no card may be visible at all.
  if (!fair) return state.board.length === 0 && state.players.every((player) => !player.holeCards);
  if (fair.version !== "merkle-sha256-v2" || !UUID_V4.test(fair.handId) || !HEX_64.test(fair.root) ||
      !HEX_64.test(fair.deckCommitment) || !HEX_64.test(fair.auditHead) || !Number.isSafeInteger(fair.auditSeq) || fair.auditSeq < 1 ||
      fair.context !== merkleContext(state.tableId, state.handNumber, fair.handId)) return false;
  const n = fair.dealtSeats.length;
  if (n < 2 || n > 9 || new Set(fair.dealtSeats).size !== n || fair.dealtSeats.some((s) => !Number.isInteger(s) || s < 0 || s >= state.players.length)) return false;
  const expected = new Map<number, Card>();
  const positions = boardPositions(n);
  if (![0, 3, 4, 5].includes(state.board.length)) return false;
  state.board.forEach((card, i) => expected.set(positions[i]!, card));
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
