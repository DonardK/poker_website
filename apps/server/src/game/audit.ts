/**
 * Server side of the per-hand compliance audit trail.
 *
 * COMPLIANCE NOTES (audit trail and SHA-256 immutability logging)
 * - `handAuditColumns` runs inside the transaction that records a settled
 *   hand. It re-verifies the sealed record with the independent WebCrypto
 *   verifier (hash chain, post-hand hash, SHA-256 deck commitment, Merkle
 *   root, every dealt/burned/shown card). It also checks that the engine's
 *   actual hole cards, board and burns sit at the committed deck positions.
 *   Any failure throws AUDIT_INVALID and rolls the transaction back (fail
 *   closed): a hand is never recorded with an audit that does not verify.
 * - The public record is stored as JSON. The regulator-only SealedHandAudit
 *   (deck order and salts) is stored AES-256-GCM encrypted, bound to its row
 *   by the `sealedAuditContext` AAD. Hand rows are append-only to the runtime
 *   database role, so neither can change after insert.
 * - `buildParticipantAudit` produces the redacted post-hand audit for one
 *   dealt player. It verifies the result and then runs an independent
 *   redaction guard before anything is returned to a client.
 */
import { EngineError, participantAudit, sealedAudit, type EngineTable } from "@poker/engine";
import {
  boardPositions,
  holeCardPositions,
  verifyParticipantAudit,
  verifySealedAudit,
  type Card,
  type HandAuditRecord,
  type ParticipantHandAudit,
  type SealedHandAudit,
} from "@poker/shared";
import { encryptState } from "./encryption.js";

/** AAD context of a hand's encrypted hole cards (`:seat:<n>` suffix) and legacy fairness blob. */
export const handContext = (tableId: string, handNumber: number): string => `hand:${tableId}:${handNumber}`;
/** Distinct AAD context: a sealed audit cannot be decrypted as, or swapped with, any other ciphertext. */
export const sealedAuditContext = (tableId: string, handNumber: number): string => `${handContext(tableId, handNumber)}:sealed-audit`;

export interface HandAuditColumns {
  handUuid: string;
  deckCommitment: string;
  finalStateHash: string;
  auditRecord: HandAuditRecord;
  auditSealed: string;
}

function invalid(reason: string): never {
  throw new EngineError("AUDIT_INVALID", `Hand audit failed verification: ${reason}`);
}
const sameCards = (a: readonly Card[] | null | undefined, b: readonly Card[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((card, i) => card === b[i]);

/**
 * Hand-row audit columns for a table that has just settled, or null for a
 * legacy in-flight hand that began before the audit trail existed.
 */
export async function handAuditColumns(table: EngineTable): Promise<HandAuditColumns | null> {
  const live = table.audit;
  const fairness = table.fairness;
  if (!live || !fairness) return null;
  // Verify exactly the bytes that will be stored (JSON round trip).
  const record = JSON.parse(JSON.stringify(live)) as HandAuditRecord;
  if (record.handId !== fairness.handId || record.tableId !== table.tableId || record.handNumber !== table.handNumber) invalid("record does not belong to this hand");
  if (record.deckCommitment !== fairness.deckCommitment || record.merkleRoot !== fairness.root) invalid("record commitments differ from the live commitment");
  if (record.finalStateHash === null) invalid("hand is not sealed");
  const sealed = sealedAudit(fairness);
  const report = await verifySealedAudit(record, sealed);
  if (!report.ok || !report.holeCards || !report.burns) return invalid(report.reason ?? "incomplete verification report");

  // The cards the engine actually dealt must be the committed cards at the audited positions.
  // Same seats in the same deal order, and every hole-card holder (a future HandPlayer row) is an audited seat.
  const auditedSeats = report.holeCards.map((hand) => hand.seatIndex);
  if (auditedSeats.join() !== table.dealtSeats.join() || table.players.some((p) => p?.holeCards && !auditedSeats.includes(p.seatIndex))) invalid("dealt seats differ from the record");
  for (const { seatIndex, cards } of report.holeCards) {
    if (!sameCards(table.players[seatIndex]?.holeCards, cards)) invalid(`hole cards for seat ${seatIndex} differ from the committed deck`);
  }
  const board = boardPositions(table.dealtSeats.length).slice(0, table.board.length).map((position) => sealed.deck[position]!);
  if (!sameCards(table.board, board)) invalid("board differs from the committed deck");
  if (!sameCards(table.burns, report.burns)) invalid("burns differ from the committed deck");

  return {
    handUuid: record.handId,
    deckCommitment: record.deckCommitment,
    finalStateHash: record.finalStateHash,
    auditRecord: record,
    auditSealed: encryptState(sealed, sealedAuditContext(table.tableId, table.handNumber)),
  };
}

/** Indexed hand-row columns that must agree with the stored audit record. */
export interface StoredHandRow {
  tableId: string;
  handNumber: number;
  handUuid: string | null;
  deckCommitment: string | null;
  finalStateHash: string | null;
}

/** Why a stored record does not belong to its row, or null when it does. */
export function rowBindingError(row: StoredHandRow, record: HandAuditRecord): string | null {
  if (record === null || typeof record !== "object") return "audit record is not an object";
  if (record.tableId !== row.tableId || record.handNumber !== row.handNumber) return "audit record belongs to a different hand";
  if (record.handId !== row.handUuid) return "audit record hand id differs from the row";
  if (record.deckCommitment !== row.deckCommitment) return "deck commitment differs from the row";
  if (record.finalStateHash !== row.finalStateHash) return "final state hash differs from the row";
  return null;
}

/** Keys that exist only in regulator/operator data. */
const SEALED_KEYS = new Set(["deck", "deckSalt", "merkleSalts", "salts", "levels", "sealed"]);
const CARD_TOKEN = /^[2-9TJQKA][cdhs]$/;

/** Deck positions a participant may see: own hole cards, dealt board, hands tabled at showdown. */
function visiblePositions(record: HandAuditRecord, viewerSeat: number): Set<number> {
  const dealtSeats = record.events[0]?.data.dealtSeats;
  if (!Array.isArray(dealtSeats)) throw new EngineError("AUDIT_INVALID", "Audit record has no dealt seats");
  const seats = dealtSeats as number[];
  const at = (seat: number): [number, number] => {
    const index = seats.indexOf(seat);
    if (index < 0) throw new EngineError("AUDIT_INVALID", `Seat ${seat} was not dealt into this hand`);
    return holeCardPositions(index, seats.length);
  };
  const positions = new Set<number>(at(viewerSeat));
  let boardCards = 0;
  for (const event of record.events) {
    if (event.type === "STREET_DEALT" && Array.isArray(event.data.cards)) boardCards += event.data.cards.length;
    if (event.type === "SHOWDOWN" && Array.isArray(event.data.shown)) {
      for (const hand of event.data.shown as { seatIndex: number }[]) at(hand.seatIndex).forEach((p) => positions.add(p));
    }
  }
  boardPositions(seats.length).slice(0, boardCards).forEach((p) => positions.add(p));
  return positions;
}

/**
 * Independent redaction guard for a participant audit (fail closed). Throws
 * LEAK_BLOCKED if the payload contains a sealed-only field, the deck salt, a
 * Merkle salt or proof for a position the viewer may not open, or any card
 * that was neither the viewer's own, on the board, nor tabled at showdown
 * (undealt, burned or mucked cards).
 */
export function assertParticipantAuditRedacted(audit: ParticipantHandAudit, sealed: SealedHandAudit): void {
  const block = (reason: string): never => {
    throw new EngineError("LEAK_BLOCKED", `Refusing to return participant audit: ${reason}`);
  };
  const visible = visiblePositions(audit.record, audit.viewerSeat);
  const hidden = new Set(sealed.deck.filter((_, position) => !visible.has(position)));
  for (const proof of audit.proofs) if (!visible.has(proof.index)) block(`proof opens position ${proof.index}`);

  const text = JSON.stringify(audit);
  if (text.includes(sealed.deckSalt)) block("deck salt present");
  sealed.merkleSalts.forEach((salt, position) => { if (!visible.has(position) && text.includes(salt)) block(`Merkle salt for position ${position} present`); });

  const scan = (value: unknown, key: string, path: string): void => {
    if (SEALED_KEYS.has(key)) block(`sealed field at ${path}`);
    if (typeof value === "string") {
      // Player-chosen names are not engine data and cannot carry dealt cards.
      if (key === "username") return;
      for (const token of value.split(/[^0-9A-Za-z]+/)) if (CARD_TOKEN.test(token) && hidden.has(token as Card)) block(`hidden card at ${path}`);
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, i) => scan(item, key, `${path}[${i}]`)); return; }
    if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) scan(v, k, path ? `${path}.${k}` : k);
  };
  scan(audit, "", "");
}

/**
 * The redacted audit a dealt player may download after the hand. It is
 * verified with the same public verifier the client runs, then passed through
 * the redaction guard; either failure throws and nothing is returned.
 */
export async function buildParticipantAudit(record: HandAuditRecord, sealed: SealedHandAudit, viewerSeat: number): Promise<ParticipantHandAudit> {
  const audit = participantAudit(record, sealed, viewerSeat);
  const check = await verifyParticipantAudit(audit);
  if (!check.ok) throw new EngineError("AUDIT_INVALID", `Participant audit failed verification: ${check.reason ?? "unknown"}`);
  assertParticipantAuditRedacted(audit, sealed);
  return audit;
}
