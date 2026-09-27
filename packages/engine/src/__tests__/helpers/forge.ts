/**
 * Forgery kit for the audit verifiers.
 *
 * A dishonest operator controls the stored record and the sealed deck. It can
 * rewrite any field and then recompute every hash. These helpers do exactly
 * that, using only the shared preimage functions and node:crypto SHA-256:
 * - `reseal` renumbers the events, recomputes every event hash and link, and
 *   recomputes the post-hand verification hash. Recomputing from the genesis
 *   hash gives every event before the mutation point its original hash back,
 *   so this is the same as re-hashing from the mutation point onwards.
 * - `recommit` substitutes a different deck (even one that is not a
 *   permutation). It recomputes the salted deck commitment and the salted
 *   Merkle root with the original salts, then reseals.
 * A forged record built here passes the hash-chain check
 * (`verifyAuditRecord`), so only a semantic check can reject it.
 */
import { createHash } from "node:crypto";
import {
  deckCommitmentPreimage,
  eventPreimage,
  finalStatePreimage,
  genesisPreimage,
  merkleContext,
  merkleLeafPreimage,
  merkleNodePreimage,
  type AuditEvent,
  type AuditEventType,
  type Card,
  type HandAuditRecord,
  type HandCategory,
  type SealedHandAudit,
} from "@poker/shared";

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const clone = <T>(value: T): T => structuredClone(value);

/** Recompute seq, prevHash, hash of every event, then finalStateHash (in place). */
export function reseal(record: HandAuditRecord): HandAuditRecord {
  let prev = sha256(genesisPreimage(record));
  record.events.forEach((event, i) => {
    event.seq = i;
    event.prevHash = prev;
    event.hash = sha256(eventPreimage(record.handId, {
      seq: event.seq, type: event.type, phase: event.phase, at: event.at, data: event.data, prevHash: event.prevHash,
    }));
    prev = event.hash;
  });
  if (record.settledAt !== null) {
    record.finalStateHash = sha256(finalStatePreimage(record.handId, prev, record.events.length, record.settledAt));
  }
  return record;
}

/** Copy, mutate, re-seal. */
export function forge(record: HandAuditRecord, mutate: (copy: HandAuditRecord) => void): HandAuditRecord {
  const copy = clone(record);
  mutate(copy);
  return reseal(copy);
}

/** Salted Merkle root over 64 leaves (52 deck positions + padding), computed independently of the engine. */
export function merkleRoot(context: string, deck: readonly Card[], salts: readonly string[]): string {
  let level = salts.map((salt, index) => sha256(merkleLeafPreimage(context, index, deck[index] ?? null, salt)));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(merkleNodePreimage(level[i]!, level[i + 1]!)));
    level = next;
  }
  return level[0]!;
}

/** Substitute `deck` for the committed deck: new commitments with the original salts, then re-seal. */
export function recommit(record: HandAuditRecord, sealed: SealedHandAudit, deck: readonly Card[],
  mutate: (copy: HandAuditRecord) => void = () => undefined): { record: HandAuditRecord; sealed: SealedHandAudit } {
  const forgedSealed: SealedHandAudit = { ...clone(sealed), deck: [...deck] };
  const forged = forge(record, (copy) => {
    copy.deckCommitment = sha256(deckCommitmentPreimage(copy.handId, copy.tableId, copy.handNumber, deck, forgedSealed.deckSalt));
    copy.merkleRoot = merkleRoot(merkleContext(copy.tableId, copy.handNumber, copy.handId), deck, forgedSealed.merkleSalts);
    mutate(copy);
  });
  return { record: forged, sealed: forgedSealed };
}

// ---------------------------------------------------------------------------
// Typed views of event data (the record stores them as canonical objects).
// ---------------------------------------------------------------------------

export interface SeatRow { seatIndex: number; userId: string; username: string; kind: string; stack: number }
export interface StartedData {
  maxSeats: number; smallBlind: number; bigBlind: number; dealerSeat: number; sbSeat: number | null; bbSeat: number | null;
  dealtSeats: number[]; seats: SeatRow[]; chipTotal: number;
}
export interface BlindData { seatIndex: number; blind: "SMALL" | "BIG"; amount: number; allIn: boolean }
export interface ActionData {
  seatIndex: number; action: string; amount: number; toAmount: number; stackAfter: number; timeout: boolean; auto: "SIT_OUT" | "LEAVE" | null;
}
export interface StreetData { street: "FLOP" | "TURN" | "RIVER"; burnPosition: number; positions: number[]; cards: Card[]; runout: boolean }
export interface ShownHand {
  seatIndex: number; cards: [Card, Card]; positions: [number, number]; category: HandCategory; rankValue: number; handName: string; bestFive: Card[];
}
export interface ShowdownData { shown: ShownHand[] }
export interface PotRow { potIndex: number; amount: number; eligibleSeatIndexes: number[]; winnerSeatIndexes: number[]; oddChipSeatIndex: number | null }
export interface SeatAmount { seatIndex: number; amount: number }
export interface AwardsData { pots: PotRow[]; refunds: SeatAmount[]; payouts: SeatAmount[] }
export interface SettledData { reason: "fold" | "showdown"; board: Card[]; stacks: { seatIndex: number; stack: number }[]; chipTotal: number }

export function eventsOf(record: HandAuditRecord, type: AuditEventType): AuditEvent[] {
  return record.events.filter((event) => event.type === type);
}

/** Data of the single event of `type`; throws if there is not exactly one. */
export function dataOf<T>(record: HandAuditRecord, type: AuditEventType): T {
  const found = eventsOf(record, type);
  if (found.length !== 1) throw new Error(`Expected exactly one ${type} event, found ${found.length}`);
  return found[0]!.data as unknown as T;
}

export const started = (record: HandAuditRecord): StartedData => record.events[0]!.data as unknown as StartedData;
export const settled = (record: HandAuditRecord): SettledData => dataOf<SettledData>(record, "HAND_SETTLED");
export const awards = (record: HandAuditRecord): AwardsData => dataOf<AwardsData>(record, "POTS_AWARDED");
export const actions = (record: HandAuditRecord): ActionData[] => eventsOf(record, "PLAYER_ACTION").map((e) => e.data as unknown as ActionData);
export const blinds = (record: HandAuditRecord): BlindData[] => eventsOf(record, "BLIND_POSTED").map((e) => e.data as unknown as BlindData);

/** Move `amount` chips of payout and final stack from seat `from` to seat `to`, keeping the engine's row format. */
export function moveChips(record: HandAuditRecord, from: number, to: number, amount: number): void {
  const award = awards(record);
  const payout = (seat: number): SeatAmount => {
    let row = award.payouts.find((p) => p.seatIndex === seat);
    if (!row) {
      row = { seatIndex: seat, amount: 0 };
      award.payouts.push(row);
      award.payouts.sort((a, b) => a.seatIndex - b.seatIndex);
    }
    return row;
  };
  payout(from).amount -= amount;
  payout(to).amount += amount;
  award.payouts = award.payouts.filter((p) => p.amount !== 0);
  const stacks = settled(record).stacks;
  stacks.find((s) => s.seatIndex === from)!.stack -= amount;
  stacks.find((s) => s.seatIndex === to)!.stack += amount;
}
