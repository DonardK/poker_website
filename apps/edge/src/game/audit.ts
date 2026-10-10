/**
 * Server side of the per-hand compliance audit trail.
 *
 * COMPLIANCE NOTES (audit trail and SHA-256 immutability logging)
 * - `handAuditColumns` runs inside the transaction that records a settled
 *   hand. It re-verifies the sealed record with the independent WebCrypto
 *   verifier (hash chain, post-hand hash, SHA-256 deck commitment, Merkle
 *   root, every dealt/burned/shown card) and replays the hand's outcome with
 *   the engine's `verifyHandOutcome` (bets, folds, showdown ranks, side pots,
 *   refunds, odd chips, payouts, final stacks, chip conservation). It also
 *   checks that the engine's actual hole cards, board and burns sit at the
 *   committed deck positions, and that the live settlement the hand rows are
 *   written from equals the verified outcome. Any failure, or a settled hand
 *   with no audit record, throws AUDIT_INVALID and rolls the transaction back
 *   (fail closed): a hand is never recorded without an audit that verifies.
 * - The public record is stored as JSON. The regulator-only SealedHandAudit
 *   (deck order and salts) is stored AES-256-GCM encrypted, bound to its row
 *   by the `sealedAuditContext` AAD. Hand rows are append-only to the runtime
 *   database role, so neither can change after insert.
 * - `regulatorVerification` is the regulator route's report: row binding,
 *   card integrity, outcome replay and the per-table chain link.
 * - `buildParticipantAudit` produces the redacted post-hand audit for one
 *   dealt player. It verifies the result, bound to the requested table, hand
 *   and user, and then runs an independent redaction guard, which also checks
 *   the stored HandPlayer `showedCards` flags, before anything is returned to
 *   a client.
 */
import { EngineError, participantAudit, sealedAudit, verifyHandOutcome, type EngineTable } from "@poker/engine";
import {
  boardPositions,
  canonicalJson,
  holeCardPositions,
  verifyParticipantAudit,
  verifySealedAudit,
  verifyTableChainLink,
  type AuditCheck,
  type Card,
  type HandAuditRecord,
  type ParticipantHandAudit,
  type SealedAuditReport,
  type SealedHandAudit,
} from "@poker/shared";
import { encryptWithRing, type KeyRing } from "./key-ring";

/** AAD context of a hand's encrypted hole cards (`:seat:<n>` suffix) and of the legacy fairness blob in pre-audit-trail rows. */
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
/** Canonical-JSON equality; a value canonical JSON cannot encode is never equal. */
function sameCanonical(a: unknown, b: unknown): boolean {
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}

/**
 * Why the live settlement differs from the verified record, or null. The
 * HandPot rows are written from `table.awards`, and the HandPlayer money
 * columns from the live stacks, `winners`, `refunds` and `committedThisHand`,
 * so all of them must equal the record: pots, refunds, and each dealt seat's
 * payout, final stack and starting stack.
 */
function liveOutcomeError(table: EngineTable, record: HandAuditRecord): string | null {
  const started = record.events[0];
  const awarded = record.events.at(-2);
  const settled = record.events.at(-1);
  if (started?.type !== "HAND_STARTED" || awarded?.type !== "POTS_AWARDED" || settled?.type !== "HAND_SETTLED") return "record does not have the settled event layout";
  const pots = table.awards.map((p) => ({
    potIndex: p.potIndex, amount: p.amount, eligibleSeatIndexes: [...p.eligibleSeatIndexes],
    winnerSeatIndexes: [...p.winnerSeatIndexes], oddChipSeatIndex: p.oddChipSeatIndex,
  }));
  if (!sameCanonical(pots, awarded.data.pots)) return "pot awards differ from the verified record";
  if (!sameCanonical(table.refunds.map((r) => ({ seatIndex: r.seatIndex, amount: r.amount })), awarded.data.refunds)) return "refunds differ from the verified record";
  if (!Array.isArray(awarded.data.payouts) || !Array.isArray(started.data.seats)) return "record has no payouts or starting stacks";
  const recordedPayout = new Map((awarded.data.payouts as { seatIndex: number; amount: number }[]).map((row) => [row.seatIndex, row.amount]));
  if ([...recordedPayout.keys()].some((seat) => !table.dealtSeats.includes(seat))) return "a payout goes to a seat that was not dealt in";
  const startingStack = new Map((started.data.seats as { seatIndex: number; stack: number }[]).map((row) => [row.seatIndex, row.stack]));
  for (const seat of table.dealtSeats) {
    const p = table.players[seat];
    if (!p) return `dealt seat ${seat} is empty at settlement`;
    // A seat's payout is what it won (table.winners) plus its returned uncalled bet (table.refunds).
    const payout = (table.winners.find((w) => w.seatIndex === seat)?.amount ?? 0) + (table.refunds.find((r) => r.seatIndex === seat)?.amount ?? 0);
    if ((recordedPayout.get(seat) ?? 0) !== payout) return `payout for seat ${seat} differs from the verified record`;
    if (p.stack - payout + p.committedThisHand !== startingStack.get(seat)) return `starting stack for seat ${seat} differs from the verified record`;
  }
  const stacks = table.dealtSeats.map((seat) => ({ seatIndex: seat, stack: table.players[seat]!.stack }));
  if (!sameCanonical(stacks, settled.data.stacks)) return "final stacks differ from the verified record";
  return null;
}

/**
 * Hand-row audit columns for a table that has just settled. Throws
 * AUDIT_INVALID unless everything described in the module notes verifies.
 * The server upgrades stored state on every load (`upgradeTableState`),
 * which voids a legacy hand dealt before the audit trail existed. Every hand
 * that settles afterwards was dealt by `startHand`, which opens its audit
 * record before any card is dealt, so a settled hand without a record is a
 * defect and is refused.
 */
export async function handAuditColumns(table: EngineTable, ring: KeyRing): Promise<HandAuditColumns> {
  const live = table.audit;
  const fairness = table.fairness;
  if (!live || !fairness) return invalid("settled hand has no audit record or deck commitment");
  // Verify exactly the bytes that will be stored (JSON round trip).
  const record = JSON.parse(JSON.stringify(live)) as HandAuditRecord;
  if (record.handId !== fairness.handId || record.tableId !== table.tableId || record.handNumber !== table.handNumber) invalid("record does not belong to this hand");
  if (record.deckCommitment !== fairness.deckCommitment || record.merkleRoot !== fairness.root) invalid("record commitments differ from the live commitment");
  if (record.finalStateHash === null) invalid("hand is not sealed");
  const sealed = sealedAudit(fairness);
  const report = await verifySealedAudit(record, sealed);
  if (!report.ok || !report.holeCards || !report.burns) return invalid(report.reason ?? "incomplete verification report");
  // The regulator's outcome replay of the result recorded in the chain.
  const outcome = verifyHandOutcome(record, sealed);
  if (!outcome.ok) invalid(`outcome replay: ${outcome.reason ?? "unknown"}`);

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
  const settlement = liveOutcomeError(table, record);
  if (settlement) invalid(settlement);

  return {
    handUuid: record.handId,
    deckCommitment: record.deckCommitment,
    finalStateHash: record.finalStateHash,
    auditRecord: record,
    auditSealed: encryptWithRing(ring, sealed, sealedAuditContext(table.tableId, table.handNumber)),
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

/** The table's most recent hand before this one that has a final state hash. */
export interface PreviousAuditedHand {
  handNumber: number;
  finalStateHash: string;
}

export interface RegulatorVerification extends SealedAuditReport {
  /** Outcome replay (verifyHandOutcome). */
  outcome: AuditCheck;
  /** Per-table chain link (verifyTableChainLink), and the hand it was compared with (null: none). */
  tableChain: AuditCheck & { previousHandNumber: number | null };
}

/**
 * The regulator's verification report for a stored hand. `ok` is true only
 * if all of these pass:
 * - row binding: the record belongs to its indexed row (`rowBindingError`);
 * - card integrity (`verifySealedAudit`): chain, commitments, and every
 *   dealt, burned and shown card at its committed position;
 * - the outcome replay (`verifyHandOutcome`). It relies on the sealed deck
 *   being the committed one, so it runs only when card integrity passed;
 * - the table chain link (`verifyTableChainLink`): `previousHandHash` equals
 *   the final state hash of `previous`, the table's most recent earlier hand
 *   that has one, or is null when there is no such hand.
 * `reason` is the first failure in that order. `holeCards` and `burns` are
 * present only when row binding and card integrity passed.
 */
export async function regulatorVerification(row: StoredHandRow, record: HandAuditRecord, sealed: SealedHandAudit, previous: PreviousAuditedHand | null): Promise<RegulatorVerification> {
  const binding = rowBindingError(row, record);
  const cards = await verifySealedAudit(record, sealed);
  const outcome: AuditCheck = cards.ok ? verifyHandOutcome(record, sealed) : { ok: false, reason: "Not replayed: card integrity verification failed" };
  const link: AuditCheck = record !== null && typeof record === "object"
    ? verifyTableChainLink(record, previous?.finalStateHash ?? null)
    : { ok: false, reason: "Audit record is not an object" };
  const tableChain = { ...link, previousHandNumber: previous?.handNumber ?? null };
  const reason = binding
    ?? (cards.ok ? null : cards.reason ?? "Card integrity verification failed")
    ?? (outcome.ok ? null : `Hand outcome: ${outcome.reason ?? "replay failed"}`)
    ?? (tableChain.ok ? null : `Table chain: ${tableChain.reason ?? "link failed"}`);
  return {
    ok: reason === null,
    ...(reason === null ? {} : { reason }),
    ...(binding === null && cards.ok ? { holeCards: cards.holeCards, burns: cards.burns } : {}),
    outcome,
    tableChain,
  };
}

/** A hand's stored HandPlayer row: the seat and whether that hand was tabled at showdown. */
export interface StoredHandPlayer {
  seatIndex: number;
  showedCards: boolean;
}

/** Keys that exist only in regulator/operator data. */
const SEALED_KEYS = new Set(["deck", "deckSalt", "merkleSalts", "salts", "levels", "sealed"]);
const CARD_TOKEN = /^[2-9TJQKA][cdhs]$/;

/**
 * Deck positions a participant may see: own hole cards, the dealt board, and
 * hands tabled at showdown. A hand the record tables is opened only if its
 * stored HandPlayer row also says it was shown (`showedCards === true`); the
 * record alone is not trusted for that. Otherwise `block` is called.
 */
function visiblePositions(record: HandAuditRecord, viewerSeat: number, stored: readonly StoredHandPlayer[], block: (reason: string) => never): Set<number> {
  const dealtSeats = record.events[0]?.data.dealtSeats;
  if (!Array.isArray(dealtSeats)) throw new EngineError("AUDIT_INVALID", "Audit record has no dealt seats");
  const seats = dealtSeats as number[];
  const at = (seat: number): [number, number] => {
    const index = seats.indexOf(seat);
    if (index < 0) throw new EngineError("AUDIT_INVALID", `Seat ${seat} was not dealt into this hand`);
    return holeCardPositions(index, seats.length);
  };
  const shownInDb = new Set(stored.filter((row) => row.showedCards === true).map((row) => row.seatIndex));
  const positions = new Set<number>(at(viewerSeat));
  let boardCards = 0;
  for (const event of record.events) {
    if (event.type === "STREET_DEALT" && Array.isArray(event.data.cards)) boardCards += event.data.cards.length;
    if (event.type === "SHOWDOWN" && Array.isArray(event.data.shown)) {
      for (const hand of event.data.shown as { seatIndex: number }[]) {
        if (hand.seatIndex !== viewerSeat && !shownInDb.has(hand.seatIndex)) block(`the record tables seat ${String(hand.seatIndex)}, whose stored hand was not shown`);
        at(hand.seatIndex).forEach((p) => positions.add(p));
      }
    }
  }
  boardPositions(seats.length).slice(0, boardCards).forEach((p) => positions.add(p));
  return positions;
}

/**
 * Independent redaction guard for a participant audit (fail closed). Throws
 * LEAK_BLOCKED if the record tables any seat other than the viewer's own
 * whose stored HandPlayer row (`stored`) does not have `showedCards` true, or
 * if the payload contains a sealed-only field, the deck salt, a Merkle salt
 * or proof for a position the viewer may not open, or any card that was
 * neither the viewer's own, on the board, nor tabled at showdown (undealt,
 * burned or mucked cards).
 */
export function assertParticipantAuditRedacted(audit: ParticipantHandAudit, sealed: SealedHandAudit, stored: readonly StoredHandPlayer[]): void {
  const block = (reason: string): never => {
    throw new EngineError("LEAK_BLOCKED", `Refusing to return participant audit: ${reason}`);
  };
  const visible = visiblePositions(audit.record, audit.viewerSeat, stored, block);
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

/** The participant-audit request: the hand asked for, the caller, and the caller's seat from their HandPlayer row. */
export interface ParticipantAuditRequest {
  tableId: string;
  handNumber: number;
  userId: string;
  viewerSeat: number;
}

/**
 * The redacted audit a dealt player may download after the hand. It is
 * verified with the same public verifier the client runs, bound to the
 * requested table and hand number and to the requesting user (who must own
 * `viewerSeat` in the record's HAND_STARTED seats). It is then passed through
 * the redaction guard with the hand's stored HandPlayer rows. Any failure
 * throws and nothing is returned.
 */
export async function buildParticipantAudit(record: HandAuditRecord, sealed: SealedHandAudit, request: ParticipantAuditRequest, stored: readonly StoredHandPlayer[]): Promise<ParticipantHandAudit> {
  const audit = participantAudit(record, sealed, request.viewerSeat);
  const check = await verifyParticipantAudit(audit, { tableId: request.tableId, handNumber: request.handNumber, userId: request.userId });
  if (!check.ok) throw new EngineError("AUDIT_INVALID", `Participant audit failed verification: ${check.reason ?? "unknown"}`);
  assertParticipantAuditRedacted(audit, sealed, stored);
  return audit;
}
