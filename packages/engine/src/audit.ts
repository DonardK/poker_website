/**
 * Per-hand audit trail (hash-chained event log).
 *
 * COMPLIANCE NOTES (audit trail and SHA-256 immutability logging)
 * - `openHandAudit` runs after the deck is shuffled and committed and before
 *   any blind is posted or card is dealt. Its HAND_STARTED event records the
 *   UUID v4 hand id, UTC start time, seats, stacks, button, blinds, deal
 *   order, the SHA-256 deck commitment and the Merkle root.
 * - Every later state transition (blinds, the hole-card deal, each street,
 *   every player action or time-out, sit-out/leave, showdown, pot awards and
 *   settlement) is appended through `appendAudit`. Each event is hashed with
 *   its predecessor; see @poker/shared/audit for the exact preimages.
 * - `sealHandAudit` writes the UTC settlement time and the post-hand
 *   verification hash (`finalStateHash`). After that the record is read-only.
 *   Its hash becomes the next hand's `previousHandHash`, which chains the
 *   table's hands together.
 * - Events hold only information that was public when the event occurred.
 *   Hidden cards are recorded only as deck positions. Players can therefore
 *   receive the redacted record without seeing mucked or undealt cards.
 *   Regulators get `SealedHandAudit` (deck and salts) to recompute
 *   everything.
 */
import {
  eventPreimage,
  finalStatePreimage,
  genesisPreimage,
  HAND_AUDIT_VERSION,
  holeCardPositions,
  merkleContext,
  RNG_DESCRIPTOR,
  SEALED_AUDIT_VERSION,
  type AuditEventType,
  type CanonicalObject,
  type CardProof,
  type HandAuditRecord,
  type ParticipantHandAudit,
  type SealedHandAudit,
} from "@poker/shared";
import { cardProof, merkleLevels, sha256Hex, type DeckCommitment } from "./fairness.js";
import type { EngineTable } from "./types.js";

/** Date#toISOString always renders UTC with a "Z" suffix and millisecond precision. */
const utc = (now: number): string => new Date(now).toISOString();

export function openHandAudit(table: EngineTable, fairness: DeckCommitment, now: number, handStarted: CanonicalObject): void {
  table.audit = {
    version: HAND_AUDIT_VERSION,
    handId: fairness.handId,
    tableId: table.tableId,
    handNumber: table.handNumber,
    startedAt: utc(now),
    previousHandHash: table.auditChainTip ?? null,
    rng: { ...RNG_DESCRIPTOR },
    deckCommitment: fairness.deckCommitment,
    merkleRoot: fairness.root,
    events: [],
    settledAt: null,
    finalStateHash: null,
  };
  appendAudit(table, "HAND_STARTED", handStarted, now);
}

/** Append one hash-chained event. No-op only for a legacy hand that began before auditing existed. */
export function appendAudit(table: EngineTable, type: AuditEventType, data: CanonicalObject, now: number): void {
  const record = table.audit;
  if (!record) return;
  if (record.finalStateHash !== null) throw new Error("Audit record is sealed");
  const prevHash = record.events.at(-1)?.hash ?? sha256Hex(genesisPreimage(record));
  const body = { seq: record.events.length, type, phase: table.phase, at: utc(now), data, prevHash };
  record.events.push({ ...body, hash: sha256Hex(eventPreimage(record.handId, body)) });
}

/** Write the post-hand verification hash; the record is immutable afterwards. */
export function sealHandAudit(table: EngineTable, now: number): void {
  const record = table.audit;
  if (!record) return;
  const head = record.events.at(-1);
  if (!head || head.type !== "HAND_SETTLED") throw new Error("Only a settled hand can be sealed");
  record.settledAt = utc(now);
  record.finalStateHash = sha256Hex(finalStatePreimage(record.handId, head.hash, record.events.length, record.settledAt));
  table.auditChainTip = record.finalStateHash;
}

/** Operator/regulator-only secrets for the current hand. */
export function sealedAudit(fairness: DeckCommitment): SealedHandAudit {
  return {
    version: SEALED_AUDIT_VERSION,
    handId: fairness.handId,
    deck: [...fairness.deck],
    deckSalt: fairness.deckSalt,
    merkleSalts: [...fairness.salts],
  };
}

/**
 * Deck positions a participant may open after the hand: their own two hole
 * cards, every dealt board card, and hands tabled at showdown. Mucked hands,
 * burns and undealt cards are never included.
 */
export function participantPositions(record: HandAuditRecord, viewerSeat: number): number[] {
  const started = record.events[0]?.data;
  const dealtSeats = Array.isArray(started?.dealtSeats) ? started.dealtSeats as number[] : [];
  const dealIndex = dealtSeats.indexOf(viewerSeat);
  if (dealIndex < 0) throw new Error("Viewer was not dealt into this hand");
  const positions = new Set<number>(holeCardPositions(dealIndex, dealtSeats.length));
  for (const event of record.events) {
    if (event.type === "STREET_DEALT") (event.data.positions as number[]).forEach((p) => positions.add(p));
    if (event.type === "SHOWDOWN") {
      for (const hand of event.data.shown as { seatIndex: number }[]) {
        holeCardPositions(dealtSeats.indexOf(hand.seatIndex), dealtSeats.length).forEach((p) => positions.add(p));
      }
    }
  }
  return [...positions].sort((a, b) => a - b);
}

/** Build the redacted post-hand audit for one participant from the stored record. */
export function participantAudit(record: HandAuditRecord, sealed: SealedHandAudit, viewerSeat: number): ParticipantHandAudit {
  if (record.finalStateHash === null) throw new Error("Hand is not settled");
  if (sealed.handId !== record.handId) throw new Error("Sealed record does not belong to this hand");
  const context = merkleContext(record.tableId, record.handNumber, record.handId);
  const levels = merkleLevels(context, sealed.deck, sealed.merkleSalts);
  if (levels.at(-1)![0] !== record.merkleRoot) throw new Error("Sealed deck does not match the committed Merkle root");
  const commitment: DeckCommitment = {
    handId: record.handId, context, root: record.merkleRoot, deckCommitment: record.deckCommitment,
    deckSalt: sealed.deckSalt, deck: sealed.deck, salts: sealed.merkleSalts, levels,
  };
  const proofs: CardProof[] = participantPositions(record, viewerSeat).map((index) => cardProof(commitment, index));
  return { record: structuredClone(record), viewerSeat, proofs };
}
