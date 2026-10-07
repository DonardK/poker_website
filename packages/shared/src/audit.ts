/**
 * Tamper-evident hand audit trail: shared types, canonical encoding, and
 * verifiers that run unchanged in Node and in the browser (WebCrypto).
 *
 * COMPLIANCE NOTES (audit trail and SHA-256 immutability logging)
 * - Every hand has a random UUID v4 `handId` and UTC ISO-8601 timestamps.
 * - `deckCommitment` is a salted SHA-256 commitment to the complete
 *   shuffled deck order. The engine calculates it before dealing any card.
 * - `events` is an append-only hash chain. Each event hashes its own content
 *   together with the previous hash, so any edit, insertion, deletion or
 *   reordering changes every later hash. The first event links to a genesis
 *   hash of the record header. The genesis hash includes the table's previous
 *   `finalStateHash`, so hands at the same table are also chained together.
 * - `finalStateHash` is the post-hand verification hash. It covers the head
 *   of the chain and, through it, the full record. It lets anyone inspect
 *   the hand without seeing live state.
 * - Events contain only information that was public when the event occurred.
 *   Hidden cards appear only as deck positions. The deck and salts are held
 *   in a separate SealedHandAudit for the operator and regulator. This design
 *   allows players to receive a redacted copy without seeing mucked or
 *   undealt cards.
 *
 * Hash preimages are built by the functions below and shared by the engine
 * (synchronous node:crypto) and these verifiers (asynchronous WebCrypto), so
 * both sides always hash identical bytes.
 */
import { HAND_VOID_REASON_MAX_LENGTH, RAKE_BPS_DENOMINATOR, RAKE_MAX_BPS, type HandPhase } from "./constants.js";
import { RANKS, SUITS, type Card } from "./poker.js";

/** Salted Merkle opening for one deck position. */
export interface CardProof { index: number; card: Card; salt: string; siblings: string[] }

/**
 * Audit format versions. Every new hand is written as v2; v1 records (hands
 * dealt before rake, voiding and time-bank pools existed) stay valid forever
 * and verify exactly as they always did.
 *
 * v2 adds, compared with v1:
 * - HAND_STARTED: the rake terms in force for the hand (rakeBps, rakeCapChips,
 *   rakeNoFlopNoDrop), the base turn time (turnTimeMs) and, when the personal
 *   time bank is enabled, each dealt seat's pool at the deal (timeBankPools,
 *   null otherwise), so an independent replay can check timeout timing;
 * - POTS_AWARDED: `rake` {total, perPot:[{potIndex, amount}]}. Pot amounts
 *   stay gross (the chips contested); each pot's winners share its amount
 *   minus its rake. HAND_SETTLED.chipTotal is still the hand's chip total,
 *   which now equals the final stacks plus the rake;
 * - HAND_VOIDED {reason}: staff voided the hand; every committed chip went
 *   back to its owner (see the engine's voidHand). It is followed directly by
 *   HAND_SETTLED with reason "void" and the starting stacks.
 *
 * The next engine step (auto-muck) also writes v2: it extends this same
 * version rather than adding a v3. A v1 record can never contain any of the
 * v2 fields or events above.
 */
export const HAND_AUDIT_VERSION_V1 = "poker-hand-audit-v1" as const;
export const HAND_AUDIT_VERSION = "poker-hand-audit-v2" as const;
export type HandAuditVersion = typeof HAND_AUDIT_VERSION_V1 | typeof HAND_AUDIT_VERSION;
export const HAND_AUDIT_VERSIONS: readonly HandAuditVersion[] = Object.freeze([HAND_AUDIT_VERSION_V1, HAND_AUDIT_VERSION]);
export const SEALED_AUDIT_VERSION = "poker-hand-sealed-v1" as const;
/** Merkle tree width. Leaves 52..63 are salted padding with a null card. */
export const MERKLE_LEAVES = 64;

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };
export type CanonicalObject = { [key: string]: CanonicalValue };

/**
 * Deterministic JSON: object keys sorted, no whitespace, integers only.
 * Rejects undefined, non-integer numbers, sparse arrays and class instances
 * so that two implementations can never disagree on the bytes being hashed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError("Canonical JSON accepts only safe integers");
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item)).join(",")}]`;
      // Realm-independent plain-object test: a plain object's prototype is some
      // realm's Object.prototype (whose own prototype is null) or null itself.
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto !== null && Object.getPrototypeOf(proto) !== null) throw new TypeError("Canonical JSON accepts only plain objects");
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
}

/** The single RNG configuration an audit record may declare. */
export interface RngDescriptor {
  source: "node:crypto.randomFillSync";
  algorithm: "fisher-yates-durstenfeld";
  scaling: "uint32-rejection-sampling";
}
export const RNG_DESCRIPTOR: RngDescriptor = Object.freeze({
  source: "node:crypto.randomFillSync",
  algorithm: "fisher-yates-durstenfeld",
  scaling: "uint32-rejection-sampling",
});

export type AuditEventType =
  | "HAND_STARTED"
  | "BLIND_POSTED"
  | "HOLE_CARDS_DEALT"
  | "STREET_DEALT"
  | "PLAYER_ACTION"
  | "PLAYER_STATUS"
  | "TURN_CLOCK_RESET"
  | "SHOWDOWN"
  | "POTS_AWARDED"
  /** v2 only: staff voided the hand and returned every committed chip. */
  | "HAND_VOIDED"
  | "HAND_SETTLED";

export interface AuditEvent {
  seq: number;
  type: AuditEventType;
  /** Engine phase when the event was recorded (state-transition trail). */
  phase: HandPhase;
  /** UTC ISO-8601 with milliseconds, e.g. 2026-09-24T10:00:00.000Z. */
  at: string;
  data: CanonicalObject;
  prevHash: string;
  hash: string;
}

export interface HandAuditHeader {
  version: HandAuditVersion;
  handId: string;
  tableId: string;
  handNumber: number;
  startedAt: string;
  /** finalStateHash of this table's previous audited hand, or null. */
  previousHandHash: string | null;
  rng: RngDescriptor;
  deckCommitment: string;
  merkleRoot: string;
}

export interface HandAuditRecord extends HandAuditHeader {
  events: AuditEvent[];
  settledAt: string | null;
  finalStateHash: string | null;
}

/** Operator/regulator-only secrets. Never sent to a player. */
export interface SealedHandAudit {
  version: typeof SEALED_AUDIT_VERSION;
  handId: string;
  deck: Card[];
  deckSalt: string;
  merkleSalts: string[];
}

/** Redacted post-hand audit for one participant: no hidden cards. */
export interface ParticipantHandAudit {
  record: HandAuditRecord;
  viewerSeat: number;
  proofs: CardProof[];
}

export interface AuditCheck {
  ok: boolean;
  reason?: string;
}

/**
 * What the client expects of an audit: the hand it asked for, plus evidence
 * it recorded during live play. Every field present is compared.
 */
export interface ObservedHandEvidence {
  /** The requested hand: the record must be exactly this hand at this table. */
  tableId?: string;
  handNumber?: number;
  /** The requesting user: must be the player seated at `viewerSeat`. */
  userId?: string;
  handId?: string;
  merkleRoot?: string;
  deckCommitment?: string;
  auditSeq?: number;
  auditHead?: string;
  /**
   * holeCardsDigest(handId, ownCards) recorded live. This is an INTEGRITY
   * check only. With 2,652 possible ordered pairs and a known handId it can be
   * reversed by trial, so it does not hide the cards; the client keeps it
   * per-user, prunes it and clears it at sign-out.
   */
  holeCardsDigest?: string;
}

export const HEX_64 = /^[a-f0-9]{64}$/;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CARD = /^[2-9TJQKA][cdhs]$/;

// ---------------------------------------------------------------------------
// Hash preimages (single source of truth for engine and verifiers)
// ---------------------------------------------------------------------------

export function deckCommitmentPreimage(handId: string, tableId: string, handNumber: number, deck: readonly Card[], deckSalt: string): string {
  return canonicalJson(["poker-deck-commitment-v1", handId, tableId, handNumber, [...deck], deckSalt]);
}

/** Merkle leaf context; binds every leaf to one table, hand number and hand UUID. */
export function merkleContext(tableId: string, handNumber: number, handId: string): string {
  return JSON.stringify(["poker-deck-v2", tableId, handNumber, handId]);
}

export function merkleLeafPreimage(context: string, index: number, card: Card | null, salt: string): string {
  return canonicalJson(["leaf-v1", context, index, card, salt]);
}

export function merkleNodePreimage(left: string, right: string): string {
  return canonicalJson(["node-v1", left, right]);
}

export function genesisPreimage(header: HandAuditHeader): string {
  return canonicalJson([
    "poker-audit-genesis-v1", header.version, header.handId, header.tableId, header.handNumber, header.startedAt,
    header.previousHandHash, { ...header.rng }, header.deckCommitment, header.merkleRoot,
  ]);
}

export function eventPreimage(handId: string, event: Omit<AuditEvent, "hash">): string {
  return canonicalJson(["poker-audit-event-v1", handId, event.seq, event.type, event.phase, event.at, event.data, event.prevHash]);
}

export function finalStatePreimage(handId: string, headHash: string, eventCount: number, settledAt: string): string {
  return canonicalJson(["poker-audit-final-v1", handId, headHash, eventCount, settledAt]);
}

// ---------------------------------------------------------------------------
// Deal geometry. Casino order: all first hole cards, then all second hole
// cards, then burn/flop x3, burn/turn, burn/river.
// ---------------------------------------------------------------------------

export function holeCardPositions(dealIndex: number, dealtCount: number): [number, number] {
  return [dealIndex, dealIndex + dealtCount];
}

/** Board positions in deal order: flop x3, turn, river. */
export function boardPositions(dealtCount: number): number[] {
  const n = 2 * dealtCount;
  return [n + 1, n + 2, n + 3, n + 5, n + 7];
}

export function burnPositions(dealtCount: number): number[] {
  const n = 2 * dealtCount;
  return [n, n + 4, n + 6];
}

// ---------------------------------------------------------------------------
// Rake (single source of truth for the engine's settlement and the verifiers)
// ---------------------------------------------------------------------------

/**
 * The rake terms a hand is dealt under. Recorded in v2 HAND_STARTED, so a
 * hand is always settled and verified under the terms in force when it was
 * dealt, even if the table's configuration changes later.
 * - rakeBps: integer 0..RAKE_MAX_BPS, basis points of the chips contested;
 * - rakeCapChips: integer >= 0, the most a hand can be raked. 0 means no
 *   rake at all (the rake is min(cap, ...)), not "uncapped";
 * - rakeNoFlopNoDrop: no rake unless a flop was dealt (all-in runouts count).
 */
export interface RakeTerms {
  rakeBps: number;
  rakeCapChips: number;
  rakeNoFlopNoDrop: boolean;
}

/** The terms of a table that takes no rake (also every v1 hand). */
export const NO_RAKE: RakeTerms = Object.freeze({ rakeBps: 0, rakeCapChips: 0, rakeNoFlopNoDrop: true });

export function validRakeTerms(terms: unknown): terms is RakeTerms {
  if (!isPlainObject(terms)) return false;
  const { rakeBps, rakeCapChips, rakeNoFlopNoDrop } = terms;
  return Number.isSafeInteger(rakeBps) && (rakeBps as number) >= 0 && (rakeBps as number) <= RAKE_MAX_BPS &&
    Number.isSafeInteger(rakeCapChips) && (rakeCapChips as number) >= 0 && typeof rakeNoFlopNoDrop === "boolean";
}

/**
 * Chips raked from a hand: min(cap, floor(contested x bps / 10000)), or 0
 * when no flop was dealt under "no flop, no drop". `contested` is the sum of
 * the pots, which never includes a returned uncalled bet. Integer arithmetic
 * only: contested x bps stays far below 2^53 for any stack the engine allows.
 */
export function rakeFor(contested: number, terms: RakeTerms, flopDealt: boolean): number {
  if (!Number.isSafeInteger(contested) || contested < 0 || !validRakeTerms(terms)) throw new RangeError("Invalid rake input");
  if (terms.rakeNoFlopNoDrop && !flopDealt) return 0;
  const product = contested * terms.rakeBps;
  if (!Number.isSafeInteger(product)) throw new RangeError("Rake computation out of range");
  return Math.min(terms.rakeCapChips, (product - (product % RAKE_BPS_DENOMINATOR)) / RAKE_BPS_DENOMINATOR);
}

/**
 * Take `total` out of the pots: main pot first, then each side pot in order,
 * never driving a pot below zero. Returns the per-pot deduction, listing only
 * pots that were actually raked (so a hand without rake has an empty list).
 */
export function rakeByPot(potAmounts: readonly number[], total: number): { potIndex: number; amount: number }[] {
  const perPot: { potIndex: number; amount: number }[] = [];
  let left = total;
  potAmounts.forEach((amount, potIndex) => {
    if (left <= 0) return;
    const take = Math.min(left, amount);
    if (take > 0) perPot.push({ potIndex, amount: take });
    left -= take;
  });
  if (left !== 0) throw new RangeError("Rake exceeds the pots");
  return perPot;
}

/** A staff void reason: 1..HAND_VOID_REASON_MAX_LENGTH printable characters, not blank. */
export function validVoidReason(reason: unknown): reason is string {
  // eslint-disable-next-line no-control-regex
  return typeof reason === "string" && reason.trim().length > 0 && reason.length <= HAND_VOID_REASON_MAX_LENGTH && !/[\u0000-\u001f\u007f]/.test(reason);
}

// ---------------------------------------------------------------------------
// WebCrypto verification
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export async function sha256HexAsync(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Verify that `proof.card` sat at `proof.index` in the deck committed by `root`. */
export async function verifyCardProof(context: string, root: string, proof: CardProof): Promise<boolean> {
  if (!isPlainObject(proof) || !HEX_64.test(root) || typeof proof.salt !== "string" || !HEX_64.test(proof.salt) ||
      typeof proof.card !== "string" || !CARD.test(proof.card) ||
      !Number.isInteger(proof.index) || proof.index < 0 || proof.index >= 52 || !Array.isArray(proof.siblings) ||
      proof.siblings.length !== Math.log2(MERKLE_LEAVES) || proof.siblings.some((s) => typeof s !== "string" || !HEX_64.test(s))) return false;
  let digest = await sha256HexAsync(merkleLeafPreimage(context, proof.index, proof.card, proof.salt));
  let position = proof.index;
  for (const sibling of proof.siblings) {
    digest = await sha256HexAsync(position % 2 === 0 ? merkleNodePreimage(digest, sibling) : merkleNodePreimage(sibling, digest));
    position = Math.floor(position / 2);
  }
  return digest === root;
}

export async function merkleRootAsync(context: string, deck: readonly Card[], salts: readonly string[]): Promise<string> {
  let level = await Promise.all(salts.map((salt, index) => sha256HexAsync(merkleLeafPreimage(context, index, deck[index] ?? null, salt))));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha256HexAsync(merkleNodePreimage(level[i]!, level[i + 1]!)));
    level = next;
  }
  return level[0]!;
}

const fail = (reason: string): AuditCheck => ({ ok: false, reason });
const OK: AuditCheck = { ok: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Strict schema: data outside the hashed fields must not ride along as if it
// were verified. Every key must be one of these, and nothing else is allowed.
const RECORD_KEYS: ReadonlySet<string> = new Set(["version", "handId", "tableId", "handNumber", "startedAt", "previousHandHash", "rng", "deckCommitment", "merkleRoot", "events", "settledAt", "finalStateHash"]);
const EVENT_KEYS: ReadonlySet<string> = new Set(["seq", "type", "phase", "at", "data", "prevHash", "hash"]);
const SEALED_KEYS: ReadonlySet<string> = new Set(["version", "handId", "deck", "deckSalt", "merkleSalts"]);
const PARTICIPANT_KEYS: ReadonlySet<string> = new Set(["record", "viewerSeat", "proofs"]);
const PROOF_KEYS: ReadonlySet<string> = new Set(["index", "card", "salt", "siblings"]);
const EVENT_TYPES_V1: ReadonlySet<string> = new Set<AuditEventType>([
  "HAND_STARTED", "BLIND_POSTED", "HOLE_CARDS_DEALT", "STREET_DEALT", "PLAYER_ACTION", "PLAYER_STATUS", "TURN_CLOCK_RESET", "SHOWDOWN", "POTS_AWARDED",
  "HAND_SETTLED",
]);
/** v2 adds HAND_VOIDED; a v1 record that contains one is refused as an unknown type. */
const EVENT_TYPES_V2: ReadonlySet<string> = new Set<string>([...EVENT_TYPES_V1, "HAND_VOIDED"]);
const EVENT_TYPES: Readonly<Record<HandAuditVersion, ReadonlySet<string>>> = {
  [HAND_AUDIT_VERSION_V1]: EVENT_TYPES_V1,
  [HAND_AUDIT_VERSION]: EVENT_TYPES_V2,
};
const VERSIONS: ReadonlySet<unknown> = new Set(HAND_AUDIT_VERSIONS);
/** v2 HAND_STARTED fields that v1 never had (see HAND_AUDIT_VERSION). */
const V2_STARTED_KEYS = ["rakeBps", "rakeCapChips", "rakeNoFlopNoDrop", "turnTimeMs", "timeBankPools"] as const;
const HAND_VOIDED_KEYS: ReadonlySet<string> = new Set(["reason"]);
const RAKE_KEYS: ReadonlySet<string> = new Set(["total", "perPot"]);
const SEAT_AMOUNT_KEYS: ReadonlySet<string> = new Set(["seatIndex", "amount"]);
const POT_RAKE_KEYS: ReadonlySet<string> = new Set(["potIndex", "amount"]);
const POOL_KEYS: ReadonlySet<string> = new Set(["seatIndex", "extraTimeMs"]);

/** The rake terms recorded in a hand's HAND_STARTED: v2 only; every v1 hand was unraked. */
export function handRakeTerms(record: HandAuditRecord): RakeTerms {
  if (record.version !== HAND_AUDIT_VERSION) return NO_RAKE;
  const data = record.events[0]?.data;
  const terms = { rakeBps: data?.rakeBps, rakeCapChips: data?.rakeCapChips, rakeNoFlopNoDrop: data?.rakeNoFlopNoDrop };
  if (!validRakeTerms(terms)) throw new Error("HAND_STARTED has invalid rake terms");
  return terms;
}

/**
 * Format of the v2-only HAND_STARTED fields, or null when they are valid.
 * A v1 record must not carry any of them (it would claim terms its version
 * cannot express). In v2: valid rake terms, a positive base turn time, and
 * either no time-bank pools (null) or exactly one whole, non-negative pool
 * per dealt seat, in deal order.
 */
export function handStartedTermsProblem(record: HandAuditRecord): string | null {
  const data = record.events[0]?.data;
  if (!isPlainObject(data)) return "HAND_STARTED has no data";
  if (record.version !== HAND_AUDIT_VERSION) {
    return V2_STARTED_KEYS.some((key) => key in data) ? `A ${record.version} record cannot carry v2 hand terms` : null;
  }
  if (V2_STARTED_KEYS.some((key) => !(key in data))) return "HAND_STARTED is missing the v2 hand terms";
  if (!validRakeTerms({ rakeBps: data.rakeBps, rakeCapChips: data.rakeCapChips, rakeNoFlopNoDrop: data.rakeNoFlopNoDrop })) return "HAND_STARTED has invalid rake terms";
  if (!Number.isSafeInteger(data.turnTimeMs) || (data.turnTimeMs as number) <= 0) return "HAND_STARTED has an invalid turn time";
  const pools = data.timeBankPools;
  if (pools === null) return null;
  const dealtSeats = data.dealtSeats;
  if (!Array.isArray(pools) || !Array.isArray(dealtSeats) || pools.length !== dealtSeats.length ||
      pools.some((row, i) => !isPlainObject(row) || extraKey(row, POOL_KEYS) !== null || row.seatIndex !== dealtSeats[i] ||
        !Number.isSafeInteger(row.extraTimeMs) || (row.extraTimeMs as number) < 0)) return "HAND_STARTED time-bank pools do not match the dealt seats";
  return null;
}
const EVENT_PHASES: ReadonlySet<string> = new Set<HandPhase>(["PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"]);
const FOLD_ACTIONS: ReadonlySet<unknown> = new Set(["FOLD", "TIMEOUT_FOLD"]);
const BETTING_PHASES: ReadonlySet<unknown> = new Set<HandPhase>(["PREFLOP", "FLOP", "TURN", "RIVER"]);
/** TURN_CLOCK_RESET data, exactly: the seat whose clock restarted and why. */
const TURN_CLOCK_RESET_KEYS: ReadonlySet<string> = new Set(["seatIndex", "reason"]);
const TURN_CLOCK_RESET_REASONS: ReadonlySet<unknown> = new Set(["SERVER_RESUME"]);

/**
 * Structural check of one TURN_CLOCK_RESET event (the server restarted the
 * pending actor's clock after downtime): exactly {seatIndex, reason}, a known
 * reason, during a betting round, for a dealt seat that has not folded (only
 * a player still in the hand can be the one to act). Returns the failure, or
 * null. The engine's verifyHandOutcome also checks the seat still had chips.
 */
export function turnClockResetProblem(event: AuditEvent, dealtSeats: readonly number[], folded: ReadonlySet<number>): string | null {
  const data = event.data;
  if (!isPlainObject(data) || extraKey(data, TURN_CLOCK_RESET_KEYS) !== null || Object.keys(data).length !== TURN_CLOCK_RESET_KEYS.size) {
    return `TURN_CLOCK_RESET at event ${String(event.seq)} has unexpected data`;
  }
  if (!TURN_CLOCK_RESET_REASONS.has(data.reason)) return `TURN_CLOCK_RESET at event ${String(event.seq)} has an unknown reason`;
  if (!BETTING_PHASES.has(event.phase)) return `TURN_CLOCK_RESET at event ${String(event.seq)} is outside a betting round`;
  const seat = data.seatIndex;
  if (typeof seat !== "number" || !dealtSeats.includes(seat) || folded.has(seat)) {
    return `TURN_CLOCK_RESET at event ${String(event.seq)} names seat ${String(seat)}, which cannot be the one to act`;
  }
  return null;
}

function extraKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

/** Digest of a player's own hole cards for live-versus-audit comparison (integrity, not secrecy). */
export function holeCardsDigestPreimage(handId: string, cards: readonly [Card, Card]): string {
  return canonicalJson(["poker-hole-evidence-v1", handId, cards[0], cards[1]]);
}

export async function holeCardsDigest(handId: string, cards: readonly [Card, Card]): Promise<string> {
  return sha256HexAsync(holeCardsDigestPreimage(handId, cards));
}

/**
 * Verify header formats, the genesis link, every event hash, sequence
 * numbers and (for settled hands) the post-hand verification hash. It
 * rejects any field outside the hashed schema and any unknown event type or
 * phase.
 */
export async function verifyAuditRecord(record: HandAuditRecord, opts: { requireSettled?: boolean } = {}): Promise<AuditCheck> {
  try {
    if (!isPlainObject(record) || !VERSIONS.has(record.version)) return fail("Unsupported audit version");
    const eventTypes = EVENT_TYPES[record.version];
    const extra = extraKey(record, RECORD_KEYS);
    if (extra !== null) return fail(`Unexpected record field "${extra}"`);
    if (typeof record.handId !== "string" || !UUID_V4.test(record.handId)) return fail("Hand id is not a UUID v4");
    if (typeof record.tableId !== "string" || !record.tableId) return fail("Missing table id");
    if (!Number.isSafeInteger(record.handNumber) || record.handNumber < 1) return fail("Invalid hand number");
    if (typeof record.startedAt !== "string" || !UTC_ISO.test(record.startedAt)) return fail("Start time is not UTC ISO-8601");
    if (record.previousHandHash !== null && (typeof record.previousHandHash !== "string" || !HEX_64.test(record.previousHandHash))) return fail("Invalid previous hand hash");
    if (canonicalJson(record.rng) !== canonicalJson(RNG_DESCRIPTOR)) return fail("Unexpected RNG descriptor");
    if (typeof record.deckCommitment !== "string" || !HEX_64.test(record.deckCommitment) ||
        typeof record.merkleRoot !== "string" || !HEX_64.test(record.merkleRoot)) return fail("Invalid commitment format");
    if (!Array.isArray(record.events) || record.events.length === 0) return fail("Audit has no events");

    let prev = await sha256HexAsync(genesisPreimage(record));
    for (let i = 0; i < record.events.length; i++) {
      const event = record.events[i]!;
      if (!isPlainObject(event)) return fail(`Event ${i} is not an object`);
      const extraEventKey = extraKey(event, EVENT_KEYS);
      if (extraEventKey !== null) return fail(`Event ${i} has unexpected field "${extraEventKey}"`);
      if (event.seq !== i) return fail(`Event ${i} has sequence ${String(event.seq)}`);
      if (!eventTypes.has(event.type)) return fail(`Event ${i} has unknown type`);
      if (!EVENT_PHASES.has(event.phase)) return fail(`Event ${i} has unknown phase`);
      if ((i === 0) !== (event.type === "HAND_STARTED")) return fail("HAND_STARTED must be the first event, exactly once");
      if (typeof event.at !== "string" || !UTC_ISO.test(event.at)) return fail(`Event ${i} time is not UTC ISO-8601`);
      if (!isPlainObject(event.data)) return fail(`Event ${i} has no data object`);
      if (event.prevHash !== prev) return fail(`Event ${i} is not linked to the previous event`);
      const { hash, ...body } = event;
      if (await sha256HexAsync(eventPreimage(record.handId, body)) !== hash) return fail(`Event ${i} hash mismatch`);
      prev = hash;
    }
    const termsProblem = handStartedTermsProblem(record);
    if (termsProblem !== null) return fail(termsProblem);
    // A void is written atomically with its settlement: HAND_VOIDED is always
    // the event directly before the final HAND_SETTLED, and carries only a reason.
    const voided = record.events.filter((event) => event.type === "HAND_VOIDED");
    if (voided.length > 0) {
      const event = voided[0]!;
      if (voided.length > 1 || record.events.at(-2) !== event || record.events.at(-1)!.type !== "HAND_SETTLED") return fail("HAND_VOIDED must directly precede HAND_SETTLED, exactly once");
      if (extraKey(event.data, HAND_VOIDED_KEYS) !== null || !validVoidReason(event.data.reason)) return fail("HAND_VOIDED has malformed data");
    }

    const settled = record.events.at(-1)!.type === "HAND_SETTLED";
    if (!settled) {
      if (opts.requireSettled) return fail("Hand is not settled");
      return record.finalStateHash === null && record.settledAt === null ? OK : fail("Unsettled hand carries a final hash");
    }
    if (typeof record.settledAt !== "string" || !UTC_ISO.test(record.settledAt) || typeof record.finalStateHash !== "string") return fail("Settled hand is missing its final hash");
    if (record.events.slice(0, -1).some((event) => event.type === "HAND_SETTLED")) return fail("HAND_SETTLED must be the last event");
    const expected = await sha256HexAsync(finalStatePreimage(record.handId, prev, record.events.length, record.settledAt));
    return expected === record.finalStateHash ? OK : fail("Post-hand verification hash mismatch");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Malformed audit record");
  }
}

/**
 * Per-table chain: `previousHandHash` must equal the finalStateHash of the
 * table's most recent earlier audited hand, or be null if there is none. A
 * deleted, replaced or reordered hand breaks this link for the hand after it.
 */
export function verifyTableChainLink(record: HandAuditRecord, previousFinalStateHash: string | null): AuditCheck {
  return record.previousHandHash === previousFinalStateHash ? OK : fail("previousHandHash does not match the table's preceding audited hand");
}

interface DealtLayout {
  dealtSeats: number[];
  holeBySeat: Map<number, [number, number]>;
  board: { position: number; card: Card }[];
  burns: number[];
  folded: Set<number>;
  shown: Map<number, [Card, Card]>;
}

/**
 * Recover deck positions and public cards from the events, and validate the
 * structure. Which seats folded is derived only from PLAYER_ACTION events, so
 * a record cannot "table" a hand that was folded (mucked). A settled
 * showdown must table exactly the hands that did not fold, at their deal
 * positions. No visible card may appear twice.
 */
function dealtLayout(record: HandAuditRecord): DealtLayout | string {
  const started = record.events[0]!.data;
  const dealtSeats = started.dealtSeats;
  if (!Array.isArray(dealtSeats) || dealtSeats.length < 2 || dealtSeats.length > 9 ||
      dealtSeats.some((seat) => !Number.isInteger(seat) || (seat as number) < 0 || (seat as number) > 8) ||
      new Set(dealtSeats).size !== dealtSeats.length) return "Invalid dealt seats";
  const seats = dealtSeats as number[];
  const n = seats.length;
  const seatRows = started.seats;
  if (!Array.isArray(seatRows) || seatRows.length !== n || seatRows.some((row) => !isPlainObject(row) || !seats.includes(row.seatIndex as number)) ||
      new Set(seatRows.map((row) => (row as { seatIndex: number }).seatIndex)).size !== n) return "HAND_STARTED seats do not match the dealt seats";

  const holeBySeat = new Map<number, [number, number]>();
  const board: DealtLayout["board"] = [];
  const burns: number[] = [];
  const folded = new Set<number>();
  const shown = new Map<number, [Card, Card]>();
  const holeEvents = record.events.filter((event) => event.type === "HOLE_CARDS_DEALT");
  if (holeEvents.length !== 1) return "Expected exactly one HOLE_CARDS_DEALT event";
  const deals = holeEvents[0]!.data.deals;
  if (!Array.isArray(deals) || deals.length !== n) return "Hole card deal does not match the dealt seats";
  deals.forEach((deal, index) => {
    if (!isPlainObject(deal) || deal.seatIndex !== seats[index]) return;
    const positions = deal.positions;
    const expected = holeCardPositions(index, n);
    if (Array.isArray(positions) && positions.length === 2 && positions[0] === expected[0] && positions[1] === expected[1]) {
      holeBySeat.set(seats[index]!, expected);
    }
  });
  if (holeBySeat.size !== n) return "Hole card positions do not follow the deal order";

  const expectedBoard = boardPositions(n);
  const expectedBurns = burnPositions(n);
  let showdowns = 0;
  let settledReason: unknown = null;
  let settledBoard: unknown = null;
  for (const event of record.events) {
    if (event.type === "STREET_DEALT") {
      const { street, cards, positions, burnPosition } = event.data;
      const streetIndex = street === "FLOP" ? 0 : street === "TURN" ? 1 : street === "RIVER" ? 2 : -1;
      const want = streetIndex === 0 ? expectedBoard.slice(0, 3) : streetIndex > 0 ? [expectedBoard[streetIndex + 2]!] : [];
      if (streetIndex !== burns.length || burnPosition !== expectedBurns[streetIndex] ||
          !Array.isArray(positions) || !Array.isArray(cards) || positions.length !== want.length || cards.length !== want.length ||
          positions.some((p, i) => p !== want[i]) || cards.some((card) => typeof card !== "string" || !CARD.test(card))) {
        return `Invalid ${String(street)} deal`;
      }
      burns.push(burnPosition as number);
      (cards as Card[]).forEach((card, i) => board.push({ position: want[i]!, card }));
    } else if (event.type === "TURN_CLOCK_RESET") {
      const problem = turnClockResetProblem(event, seats, folded);
      if (problem !== null) return problem;
    } else if (event.type === "PLAYER_ACTION" || event.type === "BLIND_POSTED" || event.type === "PLAYER_STATUS") {
      const seat = event.data.seatIndex as number;
      if (!holeBySeat.has(seat)) return `${event.type} for a seat that was not dealt in`;
      if (event.type === "PLAYER_ACTION" && FOLD_ACTIONS.has(event.data.action)) {
        if (folded.has(seat)) return `Seat ${seat} folded twice`;
        folded.add(seat);
      }
    } else if (event.type === "SHOWDOWN") {
      if (++showdowns > 1) return "More than one SHOWDOWN event";
      const hands = event.data.shown;
      if (!Array.isArray(hands)) return "Invalid showdown";
      for (const hand of hands) {
        if (!isPlainObject(hand)) return "Invalid shown hand";
        const seat = hand.seatIndex as number;
        const expected = holeBySeat.get(seat);
        if (!expected || shown.has(seat) || folded.has(seat)) return `Showdown lists seat ${String(seat)}, which may not be tabled`;
        if (!Array.isArray(hand.positions) || hand.positions.length !== 2 || hand.positions[0] !== expected[0] || hand.positions[1] !== expected[1]) return `Showdown positions for seat ${seat} are wrong`;
        if (!Array.isArray(hand.cards) || hand.cards.length !== 2 || hand.cards.some((card) => typeof card !== "string" || !CARD.test(card))) return "Invalid shown hand";
        shown.set(seat, hand.cards as [Card, Card]);
      }
    } else if (event.type === "HAND_SETTLED") {
      settledReason = event.data.reason;
      settledBoard = event.data.board;
    }
  }

  if (settledReason !== null) {
    const contenders = seats.filter((seat) => !folded.has(seat));
    if (!Array.isArray(settledBoard) || settledBoard.length !== board.length || settledBoard.some((card, i) => card !== board[i]!.card)) return "Settled board differs from the dealt board";
    if (settledReason === "showdown") {
      if (showdowns !== 1 || board.length !== 5) return "Showdown settlement without a complete board and one SHOWDOWN event";
      if (shown.size !== contenders.length || contenders.some((seat) => !shown.has(seat))) return "Showdown must table exactly the hands that did not fold";
    } else if (settledReason === "fold") {
      if (showdowns !== 0 || contenders.length !== 1) return "A hand won by folds has one remaining player and no showdown";
    } else if (settledReason === "void") {
      // Only a v2 record can be voided (verifyAuditRecord placed HAND_VOIDED); nothing is tabled or awarded.
      if (record.version !== HAND_AUDIT_VERSION || record.events.at(-2)?.type !== "HAND_VOIDED") return "A void settlement must follow HAND_VOIDED";
      if (showdowns !== 0 || record.events.some((event) => event.type === "POTS_AWARDED")) return "A voided hand has no showdown and no awards";
    } else {
      return "Unknown settlement reason";
    }
    if (settledReason !== "void" && record.events.some((event) => event.type === "HAND_VOIDED")) return "A voided hand must settle as void";
  }
  const visible = [...board.map((entry) => entry.card), ...[...shown.values()].flat()];
  if (new Set(visible).size !== visible.length) return "A visible card appears more than once";
  return { dealtSeats: seats, holeBySeat, board, burns, folded, shown };
}

const AWARD_KEYS_V2: ReadonlySet<string> = new Set(["pots", "refunds", "payouts", "rake"]);
const POT_KEYS: ReadonlySet<string> = new Set(["potIndex", "amount", "eligibleSeatIndexes", "winnerSeatIndexes", "oddChipSeatIndex"]);

/** Seat order for odd chips: clockwise from the seat left of the button (as the engine's splitOddChips). */
function oddChipOrder(dealerSeat: number, maxSeats: number): number[] {
  return Array.from({ length: maxSeats }, (_, i) => (dealerSeat + 1 + i) % maxSeats);
}

/**
 * Money replay of a settled v2 record that needs no hidden card and no hand
 * evaluator, so a participant's browser can run it. It recomputes:
 * - every seat's contribution from the blinds and actions, against its stack;
 * - the returned uncalled bet, and so the chips actually contested;
 * - the rake, exactly: from the HAND_STARTED terms, the contested chips and
 *   whether a flop was dealt, taken from the main pot first, then the side
 *   pots in order (`rakeFor`, `rakeByPot`);
 * - every payout from each pot's recorded winners: the pot minus its rake,
 *   split evenly, odd chips clockwise from the left of the button;
 * - the final stacks, and that stacks plus rake equal the hand's chip total.
 * A voided hand (reason "void") must end with every starting stack intact.
 * Which hands won is not judged here (that needs the evaluator; see the
 * engine's verifyHandOutcome). v1 records are not checked (they verify
 * exactly as before). Returns the failure, or null.
 */
export function settlementMoneyProblem(record: HandAuditRecord): string | null {
  if (record.version !== HAND_AUDIT_VERSION) return null;
  const events = record.events;
  const started = events[0]!.data;
  const dealtSeats = started.dealtSeats as number[];
  const start = new Map<number, number>();
  for (const row of started.seats as { seatIndex: number; stack: unknown }[]) {
    if (!Number.isSafeInteger(row.stack) || (row.stack as number) <= 0) return `Invalid starting stack for seat ${row.seatIndex}`;
    start.set(row.seatIndex, row.stack as number);
  }
  const chipTotal = [...start.values()].reduce((sum, chips) => sum + chips, 0);
  if (started.chipTotal !== chipTotal) return "HAND_STARTED chip total differs from the starting stacks";
  const stack = new Map(start);
  const committed = new Map(dealtSeats.map((seat) => [seat, 0]));
  let flopDealt = false;
  let awards: AuditEvent | null = null;
  for (const event of events) {
    if (event.type === "BLIND_POSTED" || event.type === "PLAYER_ACTION") {
      if (awards) return "Chips moved after the pots were awarded";
      const seat = event.data.seatIndex as number;
      const amount = event.data.amount;
      const before = stack.get(seat);
      if (before === undefined || !Number.isSafeInteger(amount) || (amount as number) < 0 || (amount as number) > before) return `Invalid amount at event ${event.seq}`;
      stack.set(seat, before - (amount as number));
      committed.set(seat, committed.get(seat)! + (amount as number));
    } else if (event.type === "STREET_DEALT" && event.data.street === "FLOP") {
      flopDealt = true;
    } else if (event.type === "POTS_AWARDED") {
      if (awards) return "More than one POTS_AWARDED event";
      awards = event;
    }
  }
  const settled = events.at(-1)!;
  if (settled.type !== "HAND_SETTLED") return "Hand is not settled";
  let rake = 0;
  const payouts = new Map<number, number>();
  if (settled.data.reason === "void") {
    if (awards) return "A voided hand has no awards";
    // Every committed chip went back: the final stacks are the starting stacks.
    for (const [seat, chips] of committed) payouts.set(seat, chips);
  } else {
    if (!awards || events.at(-2) !== awards) return "A settled hand ends with POTS_AWARDED then HAND_SETTLED";
    const data = awards.data;
    if (extraKey(data, AWARD_KEYS_V2) !== null || !Array.isArray(data.pots) || !Array.isArray(data.refunds) || !Array.isArray(data.payouts) ||
        !isPlainObject(data.rake) || extraKey(data.rake, RAKE_KEYS) !== null) return "POTS_AWARDED is malformed";
    // The uncalled part of the single largest contribution is returned before any pot is built.
    let maxSeat = -1;
    let max = 0;
    let second = 0;
    for (const seat of [...dealtSeats].sort((a, b) => a - b)) {
      const chips = committed.get(seat)!;
      if (chips > max) [second, max, maxSeat] = [max, chips, seat];
      else if (chips > second) second = chips;
    }
    const refund = max - second;
    const expectedRefunds = refund > 0 ? [{ seatIndex: maxSeat, amount: refund }] : [];
    if (canonicalJson(expectedRefunds) !== canonicalJson(data.refunds)) return "Returned uncalled bet differs from the contributions";
    if (refund > 0) payouts.set(maxSeat, refund);
    const contested = [...committed.values()].reduce((sum, chips) => sum + chips, 0) - refund;

    const pots = data.pots as unknown[];
    const amounts: number[] = [];
    for (const [i, pot] of pots.entries()) {
      if (!isPlainObject(pot) || extraKey(pot, POT_KEYS) !== null || pot.potIndex !== i || !Number.isSafeInteger(pot.amount) || (pot.amount as number) <= 0 ||
          !Array.isArray(pot.eligibleSeatIndexes) || !Array.isArray(pot.winnerSeatIndexes)) return `Pot ${i} is malformed`;
      const eligible = pot.eligibleSeatIndexes as unknown[];
      const winners = pot.winnerSeatIndexes as unknown[];
      if (eligible.some((seat) => !dealtSeats.includes(seat as number)) || winners.some((seat) => !eligible.includes(seat)) ||
          new Set(winners).size !== winners.length || (eligible.length > 0) !== (winners.length > 0)) return `Pot ${i} has invalid winners`;
      amounts.push(pot.amount as number);
    }
    if (amounts.reduce((sum, chips) => sum + chips, 0) !== contested) return "Pots differ from the chips contested";
    rake = rakeFor(contested, handRakeTerms(record), flopDealt);
    const perPot = rakeByPot(amounts, rake);
    if (canonicalJson({ total: rake, perPot }) !== canonicalJson(data.rake)) return "Rake differs from the hand's rake terms";

    const order = oddChipOrder(started.dealerSeat as number, started.maxSeats as number);
    pots.forEach((pot, i) => {
      const winners = (pot as { winnerSeatIndexes: number[] }).winnerSeatIndexes;
      if (winners.length === 0) return;
      const net = amounts[i]! - (perPot.find((row) => row.potIndex === i)?.amount ?? 0);
      let odd = net % winners.length;
      for (const seat of order) {
        if (!winners.includes(seat)) continue;
        const share = (net - (net % winners.length)) / winners.length + (odd > 0 ? 1 : 0);
        if (odd > 0) odd -= 1;
        payouts.set(seat, (payouts.get(seat) ?? 0) + share);
      }
    });
    const recorded = data.payouts as unknown[];
    if (recorded.some((row) => !isPlainObject(row) || extraKey(row, SEAT_AMOUNT_KEYS) !== null || !Number.isSafeInteger(row.amount) || (row.amount as number) < 0)) return "Payouts are malformed";
    const nonZero = (rows: { seatIndex: number; amount: number }[]) => rows.filter((row) => row.amount !== 0);
    const expectedPayouts = [...payouts].sort(([a], [b]) => a - b).map(([seatIndex, amount]) => ({ seatIndex, amount }));
    if (canonicalJson(nonZero(expectedPayouts)) !== canonicalJson(nonZero(recorded as { seatIndex: number; amount: number }[]))) return "Payouts differ from the pots, winners and rake";
  }
  const stacks = dealtSeats.map((seat) => ({ seatIndex: seat, stack: stack.get(seat)! + (payouts.get(seat) ?? 0) }));
  if (canonicalJson(stacks) !== canonicalJson(settled.data.stacks)) return "Final stacks differ from a replay of the hand";
  if (stacks.reduce((sum, row) => sum + row.stack, 0) + rake !== chipTotal || settled.data.chipTotal !== chipTotal) return "Chips were not conserved (final stacks plus rake must equal the hand's chips)";
  return null;
}

/**
 * Participant verification. It checks the chain and final hash; that the
 * record is the requested hand and the viewer's own seat; Merkle proofs for
 * exactly the cards this player may see, with no card twice; and agreement
 * with the evidence recorded during live play.
 *
 * Without live evidence, this proves only that the server's record is
 * internally consistent and that the opened cards match its commitment.
 * Participants never receive the deck or salts, so the SHA-256 deck
 * commitment itself can only be compared with the value seen live.
 */
export async function verifyParticipantAudit(audit: ParticipantHandAudit, observed: ObservedHandEvidence = {}): Promise<AuditCheck> {
  try {
    if (!isPlainObject(audit) || extraKey(audit, PARTICIPANT_KEYS) !== null) return fail("Malformed participant audit");
    const { record, viewerSeat, proofs } = audit;
    const chain = await verifyAuditRecord(record, { requireSettled: true });
    if (!chain.ok) return chain;
    if (observed.tableId !== undefined && observed.tableId !== record.tableId) return fail("Audit is for a different table");
    if (observed.handNumber !== undefined && observed.handNumber !== record.handNumber) return fail("Audit is for a different hand");
    if (observed.handId !== undefined && observed.handId !== record.handId) return fail("Hand id differs from the live hand");
    if (observed.merkleRoot !== undefined && observed.merkleRoot !== record.merkleRoot) return fail("Deck root differs from the live commitment");
    if (observed.deckCommitment !== undefined && observed.deckCommitment !== record.deckCommitment) return fail("Deck commitment differs from the live commitment");
    if (observed.auditSeq !== undefined) {
      const seen = record.events[observed.auditSeq - 1];
      if (observed.auditSeq < 1 || !seen || seen.hash !== observed.auditHead) return fail("Audit chain differs from the live chain");
    }
    const layout = dealtLayout(record);
    if (typeof layout === "string") return fail(layout);
    const money = settlementMoneyProblem(record);
    if (money !== null) return fail(money);
    const own = layout.holeBySeat.get(viewerSeat);
    if (!own) return fail("Viewer was not dealt into this hand");
    if (observed.userId !== undefined) {
      const seatRow = (record.events[0]!.data.seats as { seatIndex: number; userId: unknown }[]).find((row) => row.seatIndex === viewerSeat);
      if (seatRow?.userId !== observed.userId) return fail("Audit seat does not belong to this user");
    }

    const expected = new Map<number, Card | null>();
    own.forEach((position) => expected.set(position, null));
    for (const { position, card } of layout.board) expected.set(position, card);
    for (const [seat, cards] of layout.shown) {
      const [a, b] = layout.holeBySeat.get(seat)!;
      expected.set(a, cards[0]);
      expected.set(b, cards[1]);
    }
    if (!Array.isArray(proofs) || proofs.length !== expected.size || new Set(proofs.map((p) => p?.index)).size !== proofs.length) {
      return fail("Proof set does not match the cards this player may see");
    }
    const context = merkleContext(record.tableId, record.handNumber, record.handId);
    for (const proof of proofs) {
      if (!isPlainObject(proof) || extraKey(proof, PROOF_KEYS) !== null) return fail("Malformed proof");
      if (!expected.has(proof.index)) return fail(`Unexpected proof for position ${proof.index}`);
      const want = expected.get(proof.index);
      if (want !== null && want !== proof.card) return fail(`Card at position ${proof.index} differs from the public record`);
      if (!await verifyCardProof(context, record.merkleRoot, proof)) return fail(`Merkle proof failed at position ${proof.index}`);
    }
    // A committed deck is a permutation: no opened card may appear twice.
    if (new Set(proofs.map((p) => p.card)).size !== proofs.length) return fail("A card appears at two deck positions");
    if (observed.holeCardsDigest !== undefined) {
      const byIndex = new Map(proofs.map((p) => [p.index, p.card]));
      const mine: [Card, Card] = [byIndex.get(own[0])!, byIndex.get(own[1])!];
      if (await holeCardsDigest(record.handId, mine) !== observed.holeCardsDigest) return fail("Your hole cards differ from the live deal");
    }
    return OK;
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Malformed participant audit");
  }
}

export interface SealedAuditReport extends AuditCheck {
  holeCards?: { seatIndex: number; cards: [Card, Card] }[];
  burns?: Card[];
}

/**
 * Regulator card-integrity verification. It covers everything in
 * verifyAuditRecord and the structural checks above, plus the sealed deck.
 * It recomputes the SHA-256 deck commitment and the Merkle root, and checks
 * that every dealt, burned and shown card came from its committed deck
 * position. The hand OUTCOME (contributions, hand ranks, pots, payouts,
 * stacks) is recomputed by the engine's `verifyHandOutcome`, which needs the
 * evaluator and pot logic.
 */
export async function verifySealedAudit(record: HandAuditRecord, sealed: SealedHandAudit): Promise<SealedAuditReport> {
  try {
    const chain = await verifyAuditRecord(record, { requireSettled: true });
    if (!chain.ok) return chain;
    if (!isPlainObject(sealed) || extraKey(sealed, SEALED_KEYS) !== null || sealed.version !== SEALED_AUDIT_VERSION || sealed.handId !== record.handId) return fail("Sealed record does not belong to this hand");
    const standard = RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}` as Card));
    if (!Array.isArray(sealed.deck) || sealed.deck.length !== 52 || new Set(sealed.deck).size !== 52 ||
        sealed.deck.some((card) => !standard.includes(card))) return fail("Sealed deck is not a permutation of the standard deck");
    if (typeof sealed.deckSalt !== "string" || !HEX_64.test(sealed.deckSalt) || !Array.isArray(sealed.merkleSalts) || sealed.merkleSalts.length !== MERKLE_LEAVES ||
        sealed.merkleSalts.some((salt) => typeof salt !== "string" || !HEX_64.test(salt))) return fail("Invalid sealed salts");
    const commitment = await sha256HexAsync(deckCommitmentPreimage(record.handId, record.tableId, record.handNumber, sealed.deck, sealed.deckSalt));
    if (commitment !== record.deckCommitment) return fail("Deck commitment does not match the sealed deck");
    const root = await merkleRootAsync(merkleContext(record.tableId, record.handNumber, record.handId), sealed.deck, sealed.merkleSalts);
    if (root !== record.merkleRoot) return fail("Merkle root does not match the sealed deck");
    const layout = dealtLayout(record);
    if (typeof layout === "string") return fail(layout);
    const money = settlementMoneyProblem(record);
    if (money !== null) return fail(money);
    for (const { position, card } of layout.board) if (sealed.deck[position] !== card) return fail(`Board card at position ${position} was not dealt from the committed deck`);
    for (const [seat, cards] of layout.shown) {
      const [a, b] = layout.holeBySeat.get(seat)!;
      if (sealed.deck[a] !== cards[0] || sealed.deck[b] !== cards[1]) return fail(`Shown cards for seat ${seat} were not dealt from the committed deck`);
    }
    return {
      ok: true,
      holeCards: layout.dealtSeats.map((seatIndex) => {
        const [a, b] = layout.holeBySeat.get(seatIndex)!;
        return { seatIndex, cards: [sealed.deck[a]!, sealed.deck[b]!] as [Card, Card] };
      }),
      burns: layout.burns.map((position) => sealed.deck[position]!),
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Malformed sealed audit");
  }
}
