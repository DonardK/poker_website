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
import type { HandPhase } from "./constants.js";
import { RANKS, SUITS, type Card } from "./poker.js";

/** Salted Merkle opening for one deck position. */
export interface CardProof { index: number; card: Card; salt: string; siblings: string[] }

export const HAND_AUDIT_VERSION = "poker-hand-audit-v1" as const;
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
  | "SHOWDOWN"
  | "POTS_AWARDED"
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
  version: typeof HAND_AUDIT_VERSION;
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
const EVENT_TYPES: ReadonlySet<string> = new Set<AuditEventType>([
  "HAND_STARTED", "BLIND_POSTED", "HOLE_CARDS_DEALT", "STREET_DEALT", "PLAYER_ACTION", "PLAYER_STATUS", "SHOWDOWN", "POTS_AWARDED", "HAND_SETTLED",
]);
const EVENT_PHASES: ReadonlySet<string> = new Set<HandPhase>(["PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"]);
const FOLD_ACTIONS: ReadonlySet<unknown> = new Set(["FOLD", "TIMEOUT_FOLD"]);

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
    if (!isPlainObject(record) || record.version !== HAND_AUDIT_VERSION) return fail("Unsupported audit version");
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
      if (!EVENT_TYPES.has(event.type)) return fail(`Event ${i} has unknown type`);
      if (!EVENT_PHASES.has(event.phase)) return fail(`Event ${i} has unknown phase`);
      if ((i === 0) !== (event.type === "HAND_STARTED")) return fail("HAND_STARTED must be the first event, exactly once");
      if (typeof event.at !== "string" || !UTC_ISO.test(event.at)) return fail(`Event ${i} time is not UTC ISO-8601`);
      if (!isPlainObject(event.data)) return fail(`Event ${i} has no data object`);
      if (event.prevHash !== prev) return fail(`Event ${i} is not linked to the previous event`);
      const { hash, ...body } = event;
      if (await sha256HexAsync(eventPreimage(record.handId, body)) !== hash) return fail(`Event ${i} hash mismatch`);
      prev = hash;
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
    } else {
      return "Unknown settlement reason";
    }
  }
  const visible = [...board.map((entry) => entry.card), ...[...shown.values()].flat()];
  if (new Set(visible).size !== visible.length) return "A visible card appears more than once";
  return { dealtSeats: seats, holeBySeat, board, burns, folded, shown };
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
