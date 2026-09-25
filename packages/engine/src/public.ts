/**
 * Per-viewer projection of the authoritative table state.
 *
 * COMPLIANCE NOTES (server-side state isolation and leakage prevention)
 * - `toPublicTableState` builds a new object from an allow-list of fields. It
 *   never spreads or clones EngineTable, so fields added to the server state
 *   do not reach clients unless they are added here.
 * - Hole cards are included only for their owner (`viewerUserId`), or for
 *   hands tabled at showdown. The server projects the state separately for
 *   each authenticated socket and sends it only to that socket (see
 *   apps/server TableManager.broadcast).
 * - The board contains only cards already dealt for the current street. The
 *   engine takes flop, turn and river cards from the deck only when that round
 *   starts, so future community cards cannot appear here.
 * - Merkle openings are produced only for the positions above (the viewer's
 *   own hole cards, the dealt board and shown hands).
 * - `assertViewerStateSafe` independently re-derives what the viewer may see
 *   and rejects any payload that contains more, including undealt, burned or
 *   opponent cards, and secret field names. `projectTableState` runs it on
 *   every projection the server emits (fail closed).
 */
import type { Card, HandHistoryLogEntry, PublicFairness, PublicPlayerView, PublicTableState } from "@poker/shared";
import { legalActions } from "./legal.js";
import { EngineError, type EngineTable } from "./types.js";
import { cardProof } from "./fairness.js";

const REVEAL_PHASES = new Set(["SHOWDOWN", "COMPLETE"]);
const BOARD_SIZES: Record<string, readonly number[]> = {
  WAITING: [0],
  PREFLOP: [0],
  FLOP: [3],
  TURN: [4],
  RIVER: [5],
  SHOWDOWN: [0, 3, 4, 5],
  COMPLETE: [0, 3, 4, 5],
};

export function toPublicTableState(table: EngineTable, viewerUserId: string | null): PublicTableState {
  const reveal = REVEAL_PHASES.has(table.phase);
  const actorLegal =
    table.toActSeat != null && table.players[table.toActSeat]?.userId === viewerUserId
      ? legalActions(table, table.toActSeat)
      : null;

  const players = table.players.map((p, seatIndex) => playerView(table, p, seatIndex, viewerUserId, reveal));
  return {
    revision: table.revision,
    fairness: publicFairness(table, players),
    tableId: table.tableId,
    name: table.name,
    status: table.status,
    handNumber: table.handNumber,
    phase: table.phase,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    board: table.board.slice() as Card[],
    pots: table.pots.map((p) => ({ index: p.potIndex, amount: p.amount })),
    potTotal: table.potTotal,
    toActSeat: table.toActSeat,
    actorLegal,
    players,
    logTail: table.log.slice(-40).map((entry) => ({ ...entry })),
    winners: table.winners.map((w) => ({ seatIndex: w.seatIndex, amount: w.amount, handName: w.handName })),
    animToken: table.animToken,
    timeBankMs: table.timeBankMs,
    turnEndsAt:
      table.toActSeat != null && table.turnStartedAt != null
        ? new Date(table.turnStartedAt + table.timeBankMs).toISOString()
        : null,
    minBuyIn: table.bigBlind * 20,
    maxBuyIn: table.bigBlind * 200,
  };
}

/** The projection the server must use: toPublicTableState plus the leak guard. */
export function projectTableState(table: EngineTable, viewerUserId: string | null): PublicTableState {
  const state = toPublicTableState(table, viewerUserId);
  assertViewerStateSafe(state, table, viewerUserId);
  return state;
}

function publicFairness(table: EngineTable, players: PublicPlayerView[]): PublicFairness | null {
  const fair = table.fairness;
  const audit = table.audit;
  // Hands begun before commitments carried a hand id (legacy state) publish nothing.
  if (!fair?.handId || !audit || audit.handId !== fair.handId || audit.events.length === 0) return null;
  const positions: number[] = [];
  const count = table.dealtSeats.length;
  for (const p of players) {
    if (!p.holeCards) continue;
    const index = table.dealtSeats.indexOf(p.seatIndex);
    positions.push(index, index + count);
  }
  positions.push(...[2 * count + 1, 2 * count + 2, 2 * count + 3, 2 * count + 5, 2 * count + 7].slice(0, table.board.length));
  return {
    version: "merkle-sha256-v2",
    handId: fair.handId,
    context: fair.context,
    root: fair.root,
    deckCommitment: fair.deckCommitment,
    auditSeq: audit.events.length,
    auditHead: audit.events.at(-1)!.hash,
    dealtSeats: [...table.dealtSeats],
    proofs: positions.map((index) => cardProof(fair, index)),
  };
}

function playerView(
  table: EngineTable,
  player: EngineTable["players"][number],
  seatIndex: number,
  viewerUserId: string | null,
  reveal: boolean,
): PublicPlayerView {
  if (!player) {
    return {
      seatIndex,
      userId: "",
      username: "",
      kind: "HUMAN",
      botProfile: null,
      stack: 0,
      committedThisStreet: 0,
      status: "ELIMINATED",
      isDealer: table.dealerSeat === seatIndex,
      isSb: table.sbSeat === seatIndex,
      isBb: table.bbSeat === seatIndex,
      sittingOut: false,
      holeCards: null,
      timeBankMsRemaining: null,
      empty: true,
      avatarHue: 0,
    };
  }

  const showHoles = Boolean(player.holeCards) && mayViewHoleCards(player, viewerUserId, reveal);

  const timeBankMsRemaining =
    table.toActSeat === seatIndex && table.turnStartedAt
      ? Math.max(0, table.timeBankMs - (Date.now() - table.turnStartedAt))
      : null;

  return {
    seatIndex,
    userId: player.userId,
    username: player.username,
    kind: player.kind,
    botProfile: player.botProfile,
    stack: player.stack,
    committedThisStreet: player.committedThisStreet,
    status: player.status,
    isDealer: table.dealerSeat === seatIndex,
    isSb: table.sbSeat === seatIndex,
    isBb: table.bbSeat === seatIndex,
    sittingOut: player.sittingOut,
    holeCards: showHoles ? [player.holeCards![0], player.holeCards![1]] : null,
    timeBankMsRemaining,
    empty: false,
    avatarHue: player.avatarHue,
  };
}

function mayViewHoleCards(player: NonNullable<EngineTable["players"][number]>, viewerUserId: string | null, reveal: boolean): boolean {
  return (viewerUserId !== null && player.userId === viewerUserId) || (reveal && player.showedCards);
}

/** Every card `viewerUserId` is entitled to see right now. */
export function authorizedCards(table: EngineTable, viewerUserId: string | null): Set<Card> {
  const reveal = REVEAL_PHASES.has(table.phase);
  const cards = new Set<Card>(table.board);
  for (const p of table.players) {
    if (p?.holeCards && mayViewHoleCards(p, viewerUserId, reveal)) p.holeCards.forEach((card) => cards.add(card));
  }
  return cards;
}

const CARD_TOKEN = /^[2-9TJQKA][cdhs]$/;
/** Names of server-only fields. Any occurrence as a payload key is a leak. */
const FORBIDDEN_KEYS = new Set(["deck", "burns", "salts", "deckSalt", "levels", "merkleSalts", "sealed", "seed", "serverSeed", "shuffleSeed", "handChipTotal", "audit"]);

/**
 * Fail-closed leak guard. It throws LEAK_BLOCKED if `state` shows the viewer
 * any card they may not see, a board larger than the current street allows,
 * or a server-only field.
 *
 * It is structural rather than a raw substring search. It compares the card
 * fields with the engine, then checks every string token in the payload
 * against the authorized set. User-chosen names are excluded, so a player
 * named "As" cannot trigger a false alarm.
 */
export function assertViewerStateSafe(state: PublicTableState, table: EngineTable, viewerUserId: string | null): void {
  const block = (reason: string): never => {
    throw new EngineError("LEAK_BLOCKED", `Refusing to emit table state: ${reason}`);
  };
  const allowed = authorizedCards(table, viewerUserId);
  const reveal = REVEAL_PHASES.has(table.phase);

  if (!(BOARD_SIZES[table.phase] ?? [0]).includes(state.board.length)) block(`board has ${state.board.length} cards during ${table.phase}`);
  if (state.board.length !== table.board.length || state.board.some((card, i) => card !== table.board[i])) block("board differs from dealt board");

  for (const view of state.players) {
    if (!view.holeCards) continue;
    const owner = table.players[view.seatIndex];
    if (!owner?.holeCards || !mayViewHoleCards(owner, viewerUserId, reveal) ||
        view.holeCards.length !== 2 || view.holeCards.some((card, i) => card !== owner.holeCards![i])) {
      block(`hole cards for seat ${view.seatIndex} are not visible to this viewer`);
    }
  }

  for (const proof of state.fairness?.proofs ?? []) {
    if (!allowed.has(proof.card) || table.fairness?.deck[proof.index] !== proof.card) block(`proof opens an unauthorized position ${proof.index}`);
  }

  const scan = (value: unknown, key: string, path: string): void => {
    if (FORBIDDEN_KEYS.has(key)) block(`server-only field at ${path}`);
    if (typeof value === "string") {
      // User-controlled display names cannot carry engine cards; skip them.
      if (key === "username" || path === "name") return;
      for (const token of value.split(/[^0-9A-Za-z]+/)) {
        if (CARD_TOKEN.test(token) && !allowed.has(token as Card)) block(`unauthorized card token at ${path}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, key, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) scan(child, childKey, path ? `${path}.${childKey}` : childKey);
    }
  };
  // Player log lines begin with the player's name; strip it before scanning the rest.
  const { logTail, ...rest } = state;
  scan(rest, "", "");
  logTail.forEach((entry, i) => {
    const text = entry.seatIndex !== null && entry.text.startsWith(entry.username) ? entry.text.slice(entry.username.length) : entry.text;
    scan({ ...entry, text }, "", `logTail[${i}]`);
  });
}

export function pushLog(
  table: EngineTable,
  seatIndex: number | null,
  text: string,
  now = new Date(),
): void {
  const username =
    seatIndex == null ? "Table" : (table.players[seatIndex]?.username ?? `Seat ${seatIndex + 1}`);
  const entry: HandHistoryLogEntry = {
    seq: (table.logSeq += 1),
    seatIndex,
    username,
    text,
    at: now.toISOString(),
  };
  table.log.push(entry);
  if (table.log.length > 250) table.log.splice(0, table.log.length - 250);
}
