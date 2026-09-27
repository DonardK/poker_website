/**
 * Leakage prevention: server-side state isolation (requirement 2) and the
 * serialized-payload tests of requirement 5.
 *
 * COMPLIANCE GUARANTEES PROVEN HERE
 * 1. Payload isolation. Over at least 2,000 complete hands (2..9 players,
 *    short stacks, multiway all-ins with side pots, runouts, time-outs,
 *    sit-outs, departures, newcomers and busts), after every transition and
 *    for every recipient (each current or former player, an anonymous
 *    spectator and an authenticated non-player), the exact JSON the server
 *    emits (JSON.stringify(projectTableState(table, viewer))) contains no
 *    undealt card, burn card, future community card or opponent hole card.
 *    The only exception is opponents' hands tabled at SHOWDOWN. The board
 *    holds 0/3/4/5 cards in PREFLOP/FLOP/TURN/RIVER, and no card at all
 *    appears between hands. No server-only field name, deck salt or salt of
 *    an unopened Merkle leaf appears. Every Merkle opening is for a card the
 *    viewer may see, and sampled payloads verify against the pre-deal
 *    commitment.
 * 2. Independence. These checks do not reuse the engine's guard. Each
 *    viewer's entitlement is re-derived from the rules. The server-side deal
 *    is checked against the committed deck positions, which shows that future
 *    streets are still in the undealt tail of the deck.
 * 3. Fail closed. assertViewerStateSafe / projectTableState reject every class
 *    of leak with EngineError("LEAK_BLOCKED"). They must also accept every
 *    legitimate payload, including players whose names look like cards.
 * 4. Hand Clean-up leaves no card secret in server memory or in any projection.
 * 5. Bot strategy never receives hidden information.
 * 6. The post-hand participant audit contains only the viewer's own cards,
 *    the board and tabled hands. It verifies against evidence the player
 *    received live.
 *
 * FALSE-FAILURE BUDGET. The driver uses the engine CSPRNG, never Math.random.
 * Sampling is stratified (exactly one random pick per block), so sample
 * counts are deterministic. Scripted hands guarantee the coverage of every
 * hand shape. Only one assertion depends on the cards dealt: at least one
 * player busts. Twenty scripted heads-up all-ins with equal stacks each bust
 * a player unless the pot is split. The split rate measured with this engine
 * was 4.1% over 200,000 deals. Using a bound of 10%, the chance of no bust is
 * below 0.1^20 = 1e-20, far below the file budget of 1e-3.
 */
import type { Card, HandAuditRecord, ObservedHandEvidence, PublicTableState } from "@poker/shared";
import { boardPositions, burnPositions, holeCardPositions, holeCardsDigest, verifyParticipantAudit, verifyTableCards } from "@poker/shared";
import { participantAudit, sealedAudit } from "../audit.js";
import { botInformationView, decideBotAction } from "../bots/decide.js";
import { shuffle } from "../deck.js";
import { cardProof } from "../fairness.js";
import { legalActions } from "../legal.js";
import { assertViewerStateSafe, authorizedCards, projectTableState, toPublicTableState } from "../public.js";
import { applyAction, completeHand, createTable, sitDown, startHand } from "../table.js";
import { EngineError, type EngineTable } from "../types.js";
import { freshIdentity, isBetting, pick, randInt, STREETS, TableSim, type Street, type Style, type Transition } from "./helpers/simulate.js";

type Viewer = string | null;

const CARD_TOKEN = /^[2-9TJQKA][cdhs]$/;
const HEX_64 = /^[0-9a-f]{64}$/;
/** Server-only field names, taken from the specification rather than from public.ts. */
const SERVER_ONLY_KEYS = new Set(["deck", "burns", "salts", "deckSalt", "levels", "merkleSalts", "sealed", "seed", "serverSeed", "shuffleSeed", "handChipTotal", "audit"]);
const BOARD_SIZE: Partial<Record<EngineTable["phase"], number>> = { WAITING: 0, PREFLOP: 0, FLOP: 3, TURN: 4, RIVER: 5 };
/** Authenticated user who never sits at any table. */
const OUTSIDER = "leak-outsider";

const TARGET_HANDS = 2_000;
/** One random snapshot out of every VERIFY_STRIDE is verified with verifyTableCards (>= 10% once there are 80+ snapshots). */
const VERIFY_STRIDE = 9;
/** One random settled hand out of every PARTICIPANT_STRIDE gets full participant audits for every dealt seat. */
const PARTICIPANT_STRIDE = 5;
/** One random decision point out of every BOT_DECISION_STRIDE also runs the full bot decision. */
const BOT_DECISION_STRIDE = 40;

function check(condition: unknown, message: () => string): asserts condition {
  if (!condition) throw new Error(message());
}

const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** Exactly one uniformly chosen hit in every block of `stride` calls, so hits >= floor(calls / stride). */
class StratifiedSampler {
  private position = 0;
  private slot: number;
  constructor(private readonly stride: number) {
    this.slot = randInt(stride);
  }
  take(): boolean {
    const hit = this.position === this.slot;
    this.position += 1;
    if (this.position === this.stride) {
      this.position = 0;
      this.slot = randInt(this.stride);
    }
    return hit;
  }
}

interface JsonScan {
  keys: string[];
  cards: { card: string; path: string }[];
  hexes: string[];
}

/**
 * Tokenize every string value (and every key) of a parsed JSON payload on
 * /[^0-9A-Za-z]+/. In adversarial mode (`displayNames`), user-chosen display
 * names are skipped: players[i].username, logTail[i].username, the top-level
 * table `name`, and the player-name prefix of log lines. Nothing else is skipped.
 */
function scanJson(root: unknown, displayNames: readonly string[] | null = null): JsonScan {
  const out: JsonScan = { keys: [], cards: [], hexes: [] };
  const tokens = (text: string, path: string): void => {
    for (const token of text.split(/[^0-9A-Za-z]+/)) {
      if (CARD_TOKEN.test(token)) out.cards.push({ card: token, path });
      else if (HEX_64.test(token)) out.hexes.push(token);
    }
  };
  const visit = (value: unknown, key: string, path: string): void => {
    if (typeof value === "string") {
      let text = value;
      if (displayNames) {
        if (path === "name" || /^(players|logTail)\[\d+\]\.username$/.test(path)) return;
        if (/^logTail\[\d+\]\.text$/.test(path)) {
          const prefix = displayNames.filter((name) => text.startsWith(name)).sort((a, b) => b.length - a.length)[0];
          if (prefix !== undefined) text = text.slice(prefix.length);
        }
      }
      tokens(text, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, key, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${childKey}` : childKey;
        out.keys.push(childKey);
        tokens(childKey, `key ${childPath}`);
        visit(child, childKey, childPath);
      }
    }
  };
  visit(root, "", "");
  return out;
}

/** Cards `viewer` may see, derived from the rules: dealt board, own hole cards, hands tabled at SHOWDOWN. */
function entitledCards(table: EngineTable, viewer: Viewer): Set<Card> {
  const cards = new Set<Card>(table.board);
  for (const p of table.players) {
    if (!p?.holeCards) continue;
    if ((viewer !== null && p.userId === viewer) || (table.phase === "SHOWDOWN" && p.showedCards)) p.holeCards.forEach((c) => cards.add(c));
  }
  return cards;
}

/** Undealt cards (including future flop/turn/river), burns, and opponents' untabled hole cards. */
function forbiddenCards(table: EngineTable, viewer: Viewer): Set<Card> {
  const cards = new Set<Card>([...table.deck, ...table.burns]);
  for (const p of table.players) {
    if (!p?.holeCards) continue;
    const own = viewer !== null && p.userId === viewer;
    const tabled = table.phase === "SHOWDOWN" && p.showedCards;
    if (!own && !tabled) p.holeCards.forEach((c) => cards.add(c));
  }
  return cards;
}

interface PayloadContext {
  /** Merkle salt -> deck position for the live hand; salts of unopened positions are secret. */
  saltIndex: Map<string, number> | null;
  /** Adversarial mode: display names excluded from the token scan. */
  displayNames: readonly string[] | null;
  where: () => string;
}

/** Every requirement-2 assertion for one serialized, parsed client payload. */
function checkPayload(table: EngineTable, viewer: Viewer, state: PublicTableState, ctx: PayloadContext): void {
  const at = (message: string) => () => `${message} [viewer=${String(viewer)}] ${ctx.where()}`;
  const phase = table.phase;

  // Board: exactly the cards dealt so far, in deal order, and the street's size.
  const size = BOARD_SIZE[phase];
  if (size !== undefined) check(state.board.length === size, at(`board has ${state.board.length} cards in ${phase}`));
  else check(phase === "SHOWDOWN" && [0, 3, 4, 5].includes(state.board.length), at(`board has ${state.board.length} cards in ${phase}`));
  check(state.board.length === table.board.length && state.board.every((card, i) => card === table.board[i]), at("board differs from the dealt board"));

  // Hole cards: own seat, or tabled at SHOWDOWN; everything else null.
  check(state.players.length === table.maxSeats, at("player list size"));
  for (const view of state.players) {
    const p = table.players[view.seatIndex];
    const visible = !!p?.holeCards && ((viewer !== null && p.userId === viewer) || (phase === "SHOWDOWN" && p.showedCards));
    if (visible) check(view.holeCards?.length === 2 && view.holeCards[0] === p!.holeCards![0] && view.holeCards[1] === p!.holeCards![1], at(`seat ${view.seatIndex} hole cards wrong`));
    else check(view.holeCards === null, at(`seat ${view.seatIndex} hole cards exposed`));
  }

  // Entitlement: independent derivation agrees with the engine, and it partitions the deck during betting.
  const entitled = entitledCards(table, viewer);
  const engineAuthorized = authorizedCards(table, viewer);
  check(sameSet(entitled, engineAuthorized), at("engine authorizedCards disagrees with the rules"));
  const forbidden = forbiddenCards(table, viewer);
  if (isBetting(phase)) {
    check([...entitled].every((c) => !forbidden.has(c)) && entitled.size + forbidden.size === 52, at("entitled/forbidden do not partition the deck"));
  }

  // Every key and every token of every string value.
  const scan = scanJson(state, ctx.displayNames);
  for (const key of scan.keys) check(!SERVER_ONLY_KEYS.has(key), at(`server-only key "${key}" in payload`));
  for (const { card, path } of scan.cards) {
    check(phase !== "WAITING", at(`card token ${card} at ${path} between hands`));
    check(!forbidden.has(card as Card), at(`forbidden card ${card} (undealt, burn or opponent) at ${path}`));
    check(entitled.has(card as Card), at(`unauthorized card ${card} at ${path}`));
  }

  // Commitment evidence: present only during a hand; openings only for entitled cards.
  if (phase === "WAITING") {
    check(state.fairness === null, at("fairness data between hands"));
    return;
  }
  const fair = state.fairness;
  const commitment = table.fairness!;
  const audit = table.audit!;
  check(fair && fair.handId === commitment.handId && fair.root === commitment.root && fair.deckCommitment === commitment.deckCommitment &&
    fair.context === commitment.context && fair.auditSeq === audit.events.length && fair.auditHead === audit.events.at(-1)!.hash,
  at("live fairness evidence does not match the engine"));
  const opened = new Set<number>();
  for (const proof of fair.proofs) {
    check(entitled.has(proof.card) && engineAuthorized.has(proof.card), at(`proof opens unauthorized card ${proof.card}`));
    check(commitment.deck[proof.index] === proof.card && commitment.salts[proof.index] === proof.salt, at(`proof ${proof.index} does not match the committed deck`));
    opened.add(proof.index);
  }
  const shownCards = new Set<Card>([...state.board, ...state.players.flatMap((p) => p.holeCards ?? [])]);
  check(fair.proofs.length === shownCards.size && sameSet(new Set(fair.proofs.map((p) => p.card)), shownCards), at("proofs do not cover exactly the visible cards"));
  for (const hex of scan.hexes) {
    check(hex !== commitment.deckSalt, at("deck salt in payload"));
    const leaf = ctx.saltIndex?.get(hex);
    check(leaf === undefined || opened.has(leaf), at(`salt of unopened position ${String(leaf)} in payload`));
  }
}

/** Server-side deal geometry: every dealt card comes from its committed position; future streets stay in the deck tail. */
function checkServerState(table: EngineTable, where: () => string): void {
  const at = (message: string) => () => `${message}; ${where()}`;
  if (table.phase === "WAITING") {
    check(table.deck.length === 0 && table.burns.length === 0 && table.board.length === 0, at("cards in server state between hands"));
    check(table.fairness === null && table.audit === null && table.handChipTotal === null && table.dealtSeats.length === 0, at("hand secrets between hands"));
    check(table.players.every((p) => !p || p.holeCards === null), at("hole cards between hands"));
    return;
  }
  const size = BOARD_SIZE[table.phase];
  check(size === undefined ? table.phase === "SHOWDOWN" && [0, 3, 4, 5].includes(table.board.length) : table.board.length === size,
    at(`server board has ${table.board.length} cards in ${table.phase}`));
  const commitment = table.fairness;
  check(commitment && table.audit && commitment.handId === table.audit.handId, at("hand without commitment or audit"));
  const deck = commitment.deck;
  const n = table.dealtSeats.length;
  check(deck.length === 52 && new Set(deck).size === 52 && n >= 2 && n <= 9, at("committed deck or dealt seats invalid"));
  check(table.burns.length === (table.board.length === 0 ? 0 : table.board.length - 2), at("burn count does not match the street"));
  const used = 2 * n + table.board.length + table.burns.length;
  check(table.deck.length === 52 - used && table.deck.every((card, i) => card === deck[used + i]), at("undealt cards are not the untouched tail of the committed deck"));
  const boardPos = boardPositions(n);
  const burnPos = burnPositions(n);
  check(table.board.every((card, i) => deck[boardPos[i]!] === card), at("board card not from its committed position"));
  check(table.burns.every((card, i) => deck[burnPos[i]!] === card), at("burn card not from its committed position"));
  table.dealtSeats.forEach((seat, i) => {
    const p = table.players[seat];
    const [a, b] = holeCardPositions(i, n);
    if (isBetting(table.phase)) check(p?.holeCards, at(`dealt seat ${seat} lost its cards mid-hand`));
    if (p?.holeCards) check(p.holeCards[0] === deck[a] && p.holeCards[1] === deck[b], at(`seat ${seat} hole cards not from positions ${a},${b}`));
  });
  table.players.forEach((p, seat) => {
    if (p && !table.dealtSeats.includes(seat)) check(p.holeCards === null, at(`seat ${seat} holds cards but was not dealt in`));
  });
}

/** Bot isolation at a decision point: the view carries no hidden information and building it changes nothing. */
function checkBotView(table: EngineTable, where: () => string): void {
  const at = (message: string) => () => `${message}; ${where()}`;
  const before = JSON.stringify(table);
  const actor = table.toActSeat!;
  const view = botInformationView(table);
  check(view.deck.length === 0 && view.burns.length === 0 && view.fairness === null && view.audit === null, at("bot view holds deck, burns, fairness or audit"));
  view.players.forEach((p, seat) => {
    if (!p) return;
    if (seat !== actor) check(p.holeCards === null && p.handResult === null, at(`bot view shows seat ${seat} cards`));
    else check(JSON.stringify(p.holeCards) === JSON.stringify(table.players[actor]!.holeCards), at("bot view lost the actor's own cards"));
  });
  const allowed = new Set<string>([...table.board, ...(table.players[actor]!.holeCards ?? [])]);
  for (const { card, path } of scanJson(JSON.parse(JSON.stringify(view))).cards) check(allowed.has(card), at(`bot view exposes ${card} at ${path}`));
  check(JSON.stringify(table) === before, at("botInformationView changed the real table"));
}

/** Records the first failure per category so one sweep can report several independent requirements. */
class Findings {
  private readonly first = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  run<T>(category: string, fn: () => T): T | null {
    try {
      return fn();
    } catch (error) {
      this.record(category, error);
      return null;
    }
  }

  async runAsync(category: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.record(category, error);
    }
  }

  private record(category: string, error: unknown): void {
    this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
    if (!this.first.has(category)) this.first.set(category, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  expectNone(category: string): void {
    const count = this.counts.get(category) ?? 0;
    if (count > 0) throw new Error(`${count} ${category} violation(s); first: ${this.first.get(category)}`);
  }
}

class Coverage {
  hands = 0;
  snapshots = 0;
  verifiedSnapshots = 0;
  transitions = 0;
  decisionPoints = 0;
  botDecisions = 0;
  settled = 0;
  participantHands = 0;
  participantSeats = 0;
  cleanups = 0;
  dealtCounts = new Map<number, number>();
  foldEndingsByBoard = new Map<number, number>();
  showdowns = 0;
  runouts = 0;
  sidePotHands = 0;
  busts = 0;
  timeouts = 0;
  sitOutsMidHand = 0;
  leavesMidHand = 0;
  leavesOutsideBetting = 0;
  newcomersMidHand = 0;
  minRaises = 0;
  allInSizedBets = 0;
  allInActions = 0;
  buttonMoves = 0;
}

const bump = (map: Map<number, number>, key: number): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/** Observer run after every transition of every simulated table. */
class LeakChecker {
  readonly findings = new Findings();
  readonly coverage = new Coverage();
  private readonly verifySampler = new StratifiedSampler(VERIFY_STRIDE);
  private readonly participantSampler = new StratifiedSampler(PARTICIPANT_STRIDE);
  private readonly botSampler = new StratifiedSampler(BOT_DECISION_STRIDE);
  /** Live evidence each dealt player received during the current hand, per table. */
  private readonly evidence = new Map<string, Map<string, ObservedHandEvidence[]>>();
  private readonly settledHands = new Set<string>();
  private readonly lastDealer = new Map<string, number>();

  readonly observe = async (sim: TableSim, transition: Transition): Promise<void> => {
    const table = sim.table;
    const where = (): string => sim.describe();
    const cov = this.coverage;
    cov.transitions += 1;
    this.countTransition(sim, transition);

    this.findings.run("server", () => checkServerState(table, where));

    const handId = table.audit?.handId ?? null;
    const unsettled = handId !== null && !this.settledHands.has(handId);
    const dealtUsers = new Set(table.audit ? (table.audit.events[0]!.data.seats as { userId: string }[]).map((s) => s.userId) : []);
    const evidence = this.evidence.get(table.tableId) ?? new Map<string, ObservedHandEvidence[]>();
    this.evidence.set(table.tableId, evidence);
    const saltIndex = table.fairness ? new Map(table.fairness.salts.map((salt, i) => [salt, i] as const)) : null;
    const viewers: Viewer[] = [null, OUTSIDER, ...sim.everSeated];

    for (const viewer of viewers) {
      cov.snapshots += 1;
      // Exactly what the server emits to this socket, as the client parses it.
      const state = this.findings.run("payload", () => {
        const parsed = JSON.parse(JSON.stringify(projectTableState(table, viewer))) as PublicTableState;
        checkPayload(table, viewer, parsed, { saltIndex, displayNames: null, where });
        return parsed;
      });
      if (!state) continue;
      if (unsettled && viewer !== null && dealtUsers.has(viewer) && state.fairness) {
        const own = state.players.find((p) => p.userId === viewer)?.holeCards ?? undefined;
        const list = evidence.get(viewer) ?? [];
        list.push({ handId: state.fairness.handId, merkleRoot: state.fairness.root, deckCommitment: state.fairness.deckCommitment,
          auditSeq: state.fairness.auditSeq, auditHead: state.fairness.auditHead,
          ...(own ? { holeCardsDigest: await holeCardsDigest(state.fairness.handId, own) } : {}) });
        evidence.set(viewer, list);
      }
      if (this.verifySampler.take()) {
        cov.verifiedSnapshots += 1;
        await this.findings.runAsync("verify", async () => {
          check((await verifyTableCards(state)) === true, () => `verifyTableCards rejected a live payload [viewer=${String(viewer)}] ${where()}`);
        });
      }
    }

    if (isBetting(table.phase) && table.toActSeat !== null) {
      cov.decisionPoints += 1;
      this.findings.run("bot", () => checkBotView(table, where));
      if (this.botSampler.take()) {
        cov.botDecisions += 1;
        this.findings.run("bot", () => {
          const before = JSON.stringify(table);
          decideBotAction(table);
          check(JSON.stringify(table) === before, () => `decideBotAction changed the real table; ${where()}`);
        });
      }
    }

    if (table.phase === "SHOWDOWN" && unsettled) {
      this.settledHands.add(handId);
      await this.onSettled(sim, evidence, where);
    }
    if (transition.kind === "completeHand") {
      cov.cleanups += 1;
      this.findings.run("cleanup", () => checkCleanup(table, viewers, where));
    }
  };

  private countTransition(sim: TableSim, t: Transition): void {
    const cov = this.coverage;
    const table = sim.table;
    if (t.kind === "startHand") {
      cov.hands += 1;
      this.evidence.set(table.tableId, new Map());
      bump(cov.dealtCounts, table.dealtSeats.length);
      const previous = this.lastDealer.get(table.tableId);
      if (previous !== undefined && previous !== table.dealerSeat) cov.buttonMoves += 1;
      this.lastDealer.set(table.tableId, table.dealerSeat);
    }
    if (t.kind === "sitDown" && isBetting(table.phase)) cov.newcomersMidHand += 1;
    if (t.kind === "leaveSeat" && (table.phase === "WAITING" || table.phase === "SHOWDOWN") && !sim.player(t.userId)) cov.leavesOutsideBetting += 1;
    if (t.kind === "action") {
      const { intent, legal } = t;
      if (intent.action === "RAISE" && intent.amount === legal.minRaiseTo && legal.minRaiseTo < legal.maxRaiseTo) cov.minRaises += 1;
      if ((intent.action === "RAISE" || intent.action === "BET") && intent.amount === legal.maxRaiseTo) cov.allInSizedBets += 1;
      if (intent.action === "ALL_IN") cov.allInActions += 1;
    }
  }

  /** Settlement: audit-record redaction, live-evidence consistency and (sampled) participant audits. */
  private async onSettled(sim: TableSim, evidence: Map<string, ObservedHandEvidence[]>, where: () => string): Promise<void> {
    const cov = this.coverage;
    const table = sim.table;
    const record = table.audit!;
    const commitment = table.fairness!;
    const n = table.dealtSeats.length;
    cov.settled += 1;

    const settledEvent = record.events.at(-1)!;
    const reason = settledEvent.data.reason;
    if (reason === "fold") bump(cov.foldEndingsByBoard, table.board.length);
    else cov.showdowns += 1;
    if (record.events.some((e) => e.type === "STREET_DEALT" && e.data.runout === true)) cov.runouts += 1;
    if (table.awards.length >= 2) cov.sidePotHands += 1;
    cov.busts += table.dealtSeats.filter((seat) => table.players[seat]?.stack === 0).length;
    for (const event of record.events) {
      if (event.type === "PLAYER_ACTION" && event.data.timeout === true) cov.timeouts += 1;
      if (event.type === "PLAYER_STATUS" && event.data.status === "SIT_OUT") cov.sitOutsMidHand += 1;
      if (event.type === "PLAYER_STATUS" && event.data.status === "LEAVE") cov.leavesMidHand += 1;
    }

    // Hole cards per dealt seat, read from the committed deck (complete even if a player later leaves).
    const holes = new Map(table.dealtSeats.map((seat, i) => [seat, holeCardPositions(i, n).map((pos) => commitment.deck[pos]!)] as const));
    const allHoles = new Set<string>([...holes.values()].flat());
    const board = new Set<string>(table.board);
    const shownSeats = table.dealtSeats.filter((seat) => table.players[seat]?.showedCards);
    const shown = new Set<string>(shownSeats.flatMap((seat) => holes.get(seat)!));

    this.findings.run("participant", () => {
      const at = (message: string) => () => `${message}; ${where()}`;
      check(settledEvent.type === "HAND_SETTLED" && record.finalStateHash !== null, at("settled hand is not sealed"));
      check(reason === "fold" || table.board.length === 5, at("showdown without a full board"));
      // The shared record holds only public information: board and tabled hands.
      for (const { card, path } of scanJson(record).cards) check(board.has(card) || shown.has(card), at(`audit record exposes ${card} at ${path}`));
      // Hole-card values appear only in SHOWDOWN.shown, and only as the tabled seat's own dealt cards.
      for (const event of record.events) {
        if (event.type !== "SHOWDOWN") {
          for (const { card } of scanJson(event).cards) check(!allHoles.has(card), at(`${event.type} event carries hole card ${card}`));
          continue;
        }
        check(Object.keys(event.data).join() === "shown", at("SHOWDOWN event carries more than `shown`"));
        for (const { card } of scanJson({ ...event, data: {} }).cards) check(!allHoles.has(card), at("SHOWDOWN envelope carries a hole card"));
        const entries = event.data.shown as { seatIndex: number; cards: string[] }[];
        check(sameSet(new Set(entries.map((e) => e.seatIndex)), new Set(shownSeats)), at("SHOWDOWN.shown differs from the tabled seats"));
        for (const entry of entries) {
          const own = holes.get(entry.seatIndex)!;
          check(entry.cards.join() === own.join(), at(`SHOWDOWN.shown seat ${entry.seatIndex} cards are not its dealt cards`));
          for (const { card } of scanJson(entry).cards) check(own.includes(card as Card) || board.has(card), at(`SHOWDOWN.shown seat ${entry.seatIndex} carries ${card}`));
        }
      }
      // Every live snapshot a player received is a prefix of the sealed chain.
      for (const [userId, list] of evidence) {
        for (const e of list) {
          check(e.handId === record.handId && e.merkleRoot === record.merkleRoot && e.deckCommitment === record.deckCommitment &&
            record.events[e.auditSeq! - 1]?.hash === e.auditHead, at(`live evidence of ${userId} is not a prefix of the sealed chain`));
        }
      }
    });

    if (!this.participantSampler.take()) return;
    cov.participantHands += 1;
    await this.findings.runAsync("participant", async () => {
      const at = (message: string) => () => `${message}; ${where()}`;
      const sealed = sealedAudit(commitment);
      const seatUser = new Map((record.events[0]!.data.seats as { seatIndex: number; userId: string }[]).map((s) => [s.seatIndex, s.userId]));
      for (const seat of table.dealtSeats) {
        cov.participantSeats += 1;
        const audit = JSON.parse(JSON.stringify(participantAudit(record, sealed, seat))) as ReturnType<typeof participantAudit>;
        const allowed = new Set<string>([...holes.get(seat)!, ...board, ...shown]);
        const scan = scanJson(audit);
        for (const key of scan.keys) check(!SERVER_ONLY_KEYS.has(key), at(`participant audit for seat ${seat} has server-only key ${key}`));
        for (const { card, path } of scan.cards) check(allowed.has(card), at(`participant audit for seat ${seat} exposes ${card} at ${path}`));
        check(audit.proofs.length === allowed.size && sameSet(new Set(audit.proofs.map((p) => p.card)), allowed), at(`participant proofs for seat ${seat} are not exactly own + board + tabled`));
        check(!scan.hexes.includes(sealed.deckSalt), at("participant audit contains the deck salt"));
        const list = evidence.get(seatUser.get(seat)!) ?? [];
        check(list.length > 0, at(`no live evidence captured for seat ${seat}`));
        const observed = pick(list);
        const result = await verifyParticipantAudit(audit, observed);
        check(result.ok, at(`verifyParticipantAudit failed for seat ${seat}: ${String(result.reason)} (observed ${JSON.stringify(observed)})`));
      }
      // A seat that was not dealt in gets nothing.
      const undealt = [...Array(table.maxSeats).keys()].filter((seat) => !table.dealtSeats.includes(seat));
      for (const seat of [...undealt.slice(0, 1), 9]) {
        let threw = false;
        try {
          participantAudit(record, sealed, seat);
        } catch (error) {
          threw = /not dealt/.test(String(error));
        }
        check(threw, at(`participantAudit did not refuse undealt seat ${seat}`));
      }
    });
  }
}

/** Hand Clean-up: nothing card-bearing survives in server state or in any projection. */
function checkCleanup(t: EngineTable, viewers: Viewer[], where: () => string): void {
  const at = (message: string) => () => `${message}; ${where()}`;
  check(t.phase === "WAITING" && t.status === "WAITING" && t.toActSeat === null, at("not WAITING after clean-up"));
  check(t.deck.length === 0 && t.burns.length === 0, at("deck or burns survive clean-up"));
  check(t.fairness === null && t.audit === null && t.handChipTotal === null, at("commitments, audit or chip total survive clean-up"));
  check(t.board.length === 0 && t.log.length === 0 && t.actions.length === 0 && t.dealtSeats.length === 0, at("board, log, actions or dealt seats survive clean-up"));
  check(t.winners.length === 0 && t.awards.length === 0 && t.refunds.length === 0 && t.pots.length === 0 && t.potTotal === 0, at("results survive clean-up"));
  check(t.players.every((p) => !p || (p.holeCards === null && p.handResult === null && !p.showedCards && p.committedThisHand === 0 && p.committedThisStreet === 0)),
    at("per-player hand state survives clean-up"));
  const server = scanJson(JSON.parse(JSON.stringify(t)));
  check(server.cards.length === 0, at(`server state still holds ${server.cards.map((c) => `${c.card}@${c.path}`).join(", ")}`));
  for (const viewer of viewers) {
    const scan = scanJson(JSON.parse(JSON.stringify(projectTableState(t, viewer))));
    check(scan.cards.length === 0, at(`projection for ${String(viewer)} still shows ${scan.cards.map((c) => c.card).join(", ")}`));
  }
}

function randomStack(bigBlind: number): number {
  const roll = randInt(10);
  if (roll < 3) return 1 + randInt(4 * bigBlind); // short: under four big blinds, sometimes under a blind
  if (roll < 7) return 10 * bigBlind + randInt(50 * bigBlind);
  return 100 * bigBlind + randInt(200 * bigBlind);
}

const SPREAD_SEATS = [0, 2, 4, 6, 8, 1, 3, 5, 7];
const STYLES: readonly Style[] = ["passive", "balanced", "aggressive"];

async function runSweep(checker: LeakChecker): Promise<void> {
  let tables = 0;
  const newSim = (maxSeats: number, smallBlind: number): TableSim => {
    tables += 1;
    return new TableSim({ tableId: `leak-t${tables}`, name: `Leak table ${tables}`, maxSeats, smallBlind }, checker.observe);
  };

  // Scripted, per table size 2..9: fold on each street, check-down, then everyone all-in (runout).
  for (let n = 2; n <= 9; n++) {
    const sim = newSim(9, 5);
    for (const seat of SPREAD_SEATS.slice(0, n)) await sim.seat(seat, 10_000);
    for (const street of STREETS) await sim.playHand({ kind: "foldOn", street });
    await sim.playHand({ kind: "checkdown" });
    await sim.playHand({ kind: "shove" });
  }
  // Scripted multiway all-ins with distinct short stacks: main pot plus side pots.
  for (const stacks of [[150, 400, 900], [60, 150, 400, 900, 2_000], [3, 35, 120, 500, 500, 1_500, 7]]) {
    const sim = newSim(9, 5);
    for (const [i, stack] of stacks.entries()) await sim.seat(SPREAD_SEATS[i]!, stack);
    await sim.playHand({ kind: "shove" });
  }
  // Scripted events: newcomer, time-out, sit-out on turn, departure off turn, all-in-sized raise;
  // then stand-ups at SHOWDOWN and between hands.
  {
    const sim = newSim(7, 5);
    for (let seat = 0; seat < 6; seat++) await sim.seat(seat, 2_000);
    await sim.playHand({ kind: "events" });
    await sim.playHand({ kind: "checkdown" }, async (s) => s.leave(s.seated()[0]!.userId));
    await sim.leave(sim.seated()[0]!.userId);
    await sim.playHand({ kind: "foldOn", street: "FLOP" });
  }
  // Scripted heads-up all-ins with equal stacks: a player busts unless the pot is split (see budget).
  for (let i = 0; i < 20; i++) {
    const sim = newSim(2, 5);
    await sim.seat(0, 200);
    await sim.seat(1, 200);
    await sim.playHand({ kind: "shove" });
  }
  // Random tables until the target hand count: 2..9 players, gaps, mixed stacks and blinds, random play and events.
  while (checker.coverage.hands < TARGET_HANDS) {
    const n = 2 + randInt(8);
    const maxSeats = n + randInt(10 - n);
    const smallBlind = pick([1, 5, 50]);
    const sim = newSim(maxSeats, smallBlind);
    for (const seat of shuffle([...Array(maxSeats).keys()]).slice(0, n)) await sim.seat(seat, randomStack(2 * smallBlind), freshIdentity(), randInt(3) === 0);
    const style = pick(STYLES);
    const events = randInt(5) !== 0;
    const quota = 3 + randInt(8);
    for (let h = 0; h < quota && checker.coverage.hands < TARGET_HANDS && sim.liveForDeal() >= 2; h++) {
      await sim.playHand({ kind: "random", style, events });
      if (events) await sim.betweenHands();
    }
  }
}

describe(`leakage sweep: ${TARGET_HANDS}+ hands, every transition, every viewer`, () => {
  const checker = new LeakChecker();
  const started = Date.now();
  beforeAll(async () => {
    await runSweep(checker);
  }, 20 * 60_000);

  it("never serializes an undealt, burned, future-board or opponent card, secret salt or server-only field to any viewer", () => {
    checker.findings.expectNone("payload");
  });

  it("deals every card from its committed position and keeps future streets in the server-only deck", () => {
    checker.findings.expectNone("server");
  });

  it("verifies a stratified random sample (at least 10%) of emitted payloads against the pre-deal commitment", () => {
    checker.findings.expectNone("verify");
    const cov = checker.coverage;
    expect(cov.verifiedSnapshots).toBeGreaterThanOrEqual(Math.floor(cov.snapshots / VERIFY_STRIDE));
    expect(cov.verifiedSnapshots * 10).toBeGreaterThanOrEqual(cov.snapshots); // at least 10%
  });

  it("Hand Clean-up purges every card secret from server state and from every projection", () => {
    checker.findings.expectNone("cleanup");
    expect(checker.coverage.cleanups).toBe(checker.coverage.hands);
  });

  it("gives bot strategy no opponent cards, deck, burns, commitments or audit, and never mutates the table", () => {
    checker.findings.expectNone("bot");
    expect(checker.coverage.decisionPoints).toBeGreaterThan(0);
    expect(checker.coverage.botDecisions).toBeGreaterThanOrEqual(Math.floor(checker.coverage.decisionPoints / BOT_DECISION_STRIDE));
  });

  it("post-hand participant audits reveal only own, board and tabled cards and verify against live evidence (>= 300 hands)", () => {
    checker.findings.expectNone("participant");
    expect(checker.coverage.participantHands).toBeGreaterThanOrEqual(300);
    expect(checker.coverage.settled).toBe(checker.coverage.hands);
  });

  it("covered every required hand shape", () => {
    const cov = checker.coverage;
    const summary = {
      seconds: Math.round((Date.now() - started) / 1000), hands: cov.hands, transitions: cov.transitions, snapshots: cov.snapshots,
      verifiedSnapshots: cov.verifiedSnapshots, decisionPoints: cov.decisionPoints, botDecisions: cov.botDecisions,
      participantHands: cov.participantHands, participantSeats: cov.participantSeats,
      dealtCounts: Object.fromEntries(cov.dealtCounts), foldEndingsByBoard: Object.fromEntries(cov.foldEndingsByBoard),
      showdowns: cov.showdowns, runouts: cov.runouts, sidePotHands: cov.sidePotHands, busts: cov.busts, timeouts: cov.timeouts,
      sitOutsMidHand: cov.sitOutsMidHand, leavesMidHand: cov.leavesMidHand, leavesOutsideBetting: cov.leavesOutsideBetting,
      newcomersMidHand: cov.newcomersMidHand, minRaises: cov.minRaises, allInSizedBets: cov.allInSizedBets, allInActions: cov.allInActions,
      buttonMoves: cov.buttonMoves,
    };
    console.log(`leakage sweep coverage ${JSON.stringify(summary)}`);
    expect(cov.hands).toBeGreaterThanOrEqual(TARGET_HANDS);
    for (let n = 2; n <= 9; n++) expect([n, cov.dealtCounts.get(n) ?? 0]).not.toEqual([n, 0]);
    for (const boardSize of [0, 3, 4, 5]) expect([boardSize, cov.foldEndingsByBoard.get(boardSize) ?? 0]).not.toEqual([boardSize, 0]);
    for (const [name, value] of Object.entries({
      showdowns: cov.showdowns, runouts: cov.runouts, sidePotHands: cov.sidePotHands, busts: cov.busts, timeouts: cov.timeouts,
      sitOutsMidHand: cov.sitOutsMidHand, leavesMidHand: cov.leavesMidHand, leavesOutsideBetting: cov.leavesOutsideBetting,
      newcomersMidHand: cov.newcomersMidHand, minRaises: cov.minRaises, allInSizedBets: cov.allInSizedBets, allInActions: cov.allInActions,
      buttonMoves: cov.buttonMoves,
    })) {
      expect([name, value]).not.toEqual([name, 0]);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial display names
// ---------------------------------------------------------------------------

/** "Ah_Kd" passes the server's registration rule (/^[a-zA-Z0-9_]{3,24}$/) yet tokenizes to two card codes. */
const CARD_NAMES = ["As", "Kd Qh", "2c-3d", "Ah_Kd", "7s 7h-7d"];

/** Observer that requires projectTableState never to throw and checks the payload outside display names. */
function adversarialObserver(falsePositives: string[], phases: Set<string>, displayNames: () => string[]) {
  return (sim: TableSim): void => {
    const table = sim.table;
    phases.add(table.phase);
    const saltIndex = table.fairness ? new Map(table.fairness.salts.map((salt, i) => [salt, i] as const)) : null;
    for (const viewer of [null, OUTSIDER, ...sim.everSeated]) {
      let payload: string;
      try {
        payload = JSON.stringify(projectTableState(table, viewer));
      } catch (error) {
        const report = `${String(error)} (phase ${table.phase}, after ${JSON.stringify(sim.recent.at(-1))})`;
        if (!falsePositives.includes(report)) falsePositives.push(report);
        payload = JSON.stringify(toPublicTableState(table, viewer));
      }
      // Throws on a real leak anywhere outside the usernames, the table name and log-line name prefixes.
      checkPayload(table, viewer, JSON.parse(payload) as PublicTableState, { saltIndex, displayNames: displayNames(), where: () => sim.describe() });
    }
  };
}

async function cardNamedTable(observer: (sim: TableSim) => void): Promise<TableSim> {
  const sim = new TableSim({ tableId: "adv-table", name: "Ah Ah", maxSeats: 6, smallBlind: 5 }, observer);
  for (const [seat, username] of CARD_NAMES.entries()) await sim.seat(seat, 5_000, { userId: `adv-u${seat}`, username });
  return sim;
}

describe("adversarial display names (players named like cards, table named \"Ah Ah\")", () => {
  it("never raises a false LEAK_BLOCKED and leaks no card outside display names, through every phase", async () => {
    const falsePositives: string[] = [];
    const phases = new Set<string>();
    const names: string[] = [...CARD_NAMES, "Ah Ah"];
    const sim = await cardNamedTable(adversarialObserver(falsePositives, phases, () => names));
    for (const street of STREETS) await sim.playHand({ kind: "foldOn", street });
    await sim.playHand({ kind: "checkdown" });
    for (let i = 0; i < 40 && sim.liveForDeal() >= 2; i++) await sim.playHand({ kind: "random", style: pick(STYLES), events: false });
    if (sim.liveForDeal() >= 2) await sim.playHand({ kind: "shove" });
    // Fresh card-named table: newcomer, time-out, sit-out on turn, mid-hand departure (the name stays
    // on the seat until clean-up), all-in-sized raise, then another hand with the survivors.
    const second = await cardNamedTable(adversarialObserver(falsePositives, phases, () => names));
    await second.playHand({ kind: "events" });
    if (second.liveForDeal() >= 2) await second.playHand({ kind: "checkdown" });
    expect(falsePositives).toEqual([]);
    for (const phase of ["WAITING", "PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"]) expect(phases).toContain(phase);
  }, 120_000);

  it("does not block emission when a card-named player stands up at SHOWDOWN or between hands", async () => {
    const falsePositives: string[] = [];
    const phases = new Set<string>();
    const sim = await cardNamedTable(adversarialObserver(falsePositives, phases, () => [...CARD_NAMES, "Ah Ah"]));
    await sim.start();
    while (isBetting(sim.table.phase)) {
      const legal = legalActions(sim.table, sim.table.toActSeat!)!;
      await sim.act(legal.actions.includes("FOLD") ? { action: "FOLD" } : { action: "CHECK" });
    }
    await sim.leave("adv-u0"); // "As" stands up while the result is shown
    await sim.complete();
    await sim.leave("adv-u3"); // "Ah_Kd" (a registrable name) stands up between hands
    expect(falsePositives).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed guard: negative tests
// ---------------------------------------------------------------------------

const HERO = "guard-u0";
const GUARD_VIEWERS: Viewer[] = [HERO, null, "guard-outsider"];

/** Deterministic 4-handed hand, checked/called to the start of `street`. */
function tableAt(street: Street): EngineTable {
  let t = createTable({ tableId: "guard-t", name: "Guard", maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (const [seat, username] of ["Hero", "Villain-1", "Villain-2", "Villain-3"].entries()) {
    t = sitDown(t, seat, { userId: `guard-u${seat}`, username, avatarHue: 0, kind: "HUMAN", botProfile: null, buyIn: 5_000, skipBuyInCheck: true });
  }
  t = startHand(t);
  while (t.phase !== street) {
    const legal = legalActions(t, t.toActSeat!)!;
    t = applyAction(t, t.players[t.toActSeat!]!.userId, legal.actions.includes("CHECK") ? { action: "CHECK" } : { action: "CALL" });
  }
  return t;
}

/** The legitimate payload exactly as the client parses it; the guard must accept it unchanged. */
function legitimate(table: EngineTable, viewer: Viewer): PublicTableState {
  const state = JSON.parse(JSON.stringify(projectTableState(table, viewer))) as PublicTableState;
  expect(() => assertViewerStateSafe(state, table, viewer)).not.toThrow();
  return state;
}

function expectLeakBlocked(fn: () => unknown): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineError);
  expect((caught as EngineError).code).toBe("LEAK_BLOCKED");
}

function mutated(state: PublicTableState, mutate: (m: PublicTableState & Record<string, unknown>) => void): PublicTableState {
  const copy = structuredClone(state) as PublicTableState & Record<string, unknown>;
  mutate(copy);
  return copy;
}

const undealt = (table: EngineTable, k = 0): Card => table.deck[k]!;
const opponents = (table: EngineTable) => table.players.filter((p) => p && p.userId !== HERO && p.holeCards);

describe("fail-closed guard: assertViewerStateSafe rejects each leak class with LEAK_BLOCKED", () => {
  describe.each(STREETS)("during %s", (street) => {
    const table = tableAt(street);
    const n = table.dealtSeats.length;
    const heroSeat = table.players.find((p) => p?.userId === HERO)!.seatIndex;

    it.each(GUARD_VIEWERS)("opponent hole cards injected before showdown (viewer %p)", (viewer) => {
      const base = legitimate(table, viewer);
      for (const opp of table.players.filter((p) => p?.holeCards && p.userId !== viewer)) {
        expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => { m.players[opp!.seatIndex]!.holeCards = [...opp!.holeCards!]; }), table, viewer));
      }
    });

    it.each(GUARD_VIEWERS)("future community card appended to the board (viewer %p)", (viewer) => {
      const base = legitimate(table, viewer);
      const next = table.board.length < 5 ? table.fairness!.deck[boardPositions(n)[table.board.length]!]! : undealt(table);
      expect(table.deck).toContain(next);
      expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => { m.board.push(next); }), table, viewer));
    });

    if (street !== "PREFLOP") {
      it.each(GUARD_VIEWERS)("board length inconsistent with the phase, using only authorized cards (viewer %p)", (viewer) => {
        const base = legitimate(table, viewer);
        expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => { m.board.pop(); }), table, viewer));
      });
    }

    it.each([...SERVER_ONLY_KEYS])("server-only key %p added at any nesting depth", (key) => {
      const base = legitimate(table, HERO);
      const places: ((m: PublicTableState & Record<string, unknown>) => Record<string, unknown> | undefined)[] = [
        (m) => m,
        (m) => m.fairness as unknown as Record<string, unknown>,
        (m) => m.fairness?.proofs[0] as unknown as Record<string, unknown> | undefined,
        (m) => m.players[heroSeat] as unknown as Record<string, unknown>,
        (m) => m.players[5] as unknown as Record<string, unknown>,
        (m) => m.logTail[0] as unknown as Record<string, unknown>,
        (m) => m.pots[0] as unknown as Record<string, unknown> | undefined,
        (m) => m.actorLegal as unknown as Record<string, unknown> | undefined,
        (m) => {
          const deep = { level1: { level2: [{}] } };
          (m.players[1] as unknown as Record<string, unknown>).extra = deep;
          return deep.level1.level2[0] as Record<string, unknown>;
        },
      ];
      let tested = 0;
      for (const place of places) {
        const m = mutated(base, () => undefined) as PublicTableState & Record<string, unknown>;
        const target = place(m);
        if (!target) continue;
        target[key] = [];
        tested += 1;
        expectLeakBlocked(() => assertViewerStateSafe(m, table, HERO));
      }
      expect(tested).toBeGreaterThanOrEqual(6);
    });

    it.each(GUARD_VIEWERS)("log entry mentioning an undealt or burned card (viewer %p)", (viewer) => {
      const base = legitimate(table, viewer);
      const hidden = [undealt(table), undealt(table, table.deck.length - 1), ...table.burns];
      const at = new Date().toISOString();
      for (const card of hidden) {
        expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => {
          m.logTail.push({ seq: 9_999, seatIndex: null, username: "Table", text: `Next card ${card}`, at });
        }), table, viewer));
        // Attributed to a player: the name prefix is ignored, the rest is still scanned.
        expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => {
          m.logTail.push({ seq: 9_999, seatIndex: heroSeat, username: "Hero", text: `Hero peeks at ${card}`, at });
        }), table, viewer));
      }
    });

    it.each(GUARD_VIEWERS)("Merkle proof for an undealt, burn or opponent position (viewer %p)", (viewer) => {
      const base = legitimate(table, viewer);
      const commitment = table.fairness!;
      const positions = new Set<number>([51, 52 - table.deck.length, ...burnPositions(n)]);
      if (table.board.length < 5) positions.add(boardPositions(n)[table.board.length]!);
      for (const opp of opponents(table)) holeCardPositions(table.dealtSeats.indexOf(opp!.seatIndex), n).forEach((p) => positions.add(p));
      const allowed = authorizedCards(table, viewer);
      let tested = 0;
      for (const index of positions) {
        if (allowed.has(commitment.deck[index]!)) continue; // defensive: none of these positions is ever authorized
        tested += 1;
        expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => { m.fairness!.proofs.push(cardProof(commitment, index)); }), table, viewer));
      }
      expect(tested).toBeGreaterThanOrEqual(3);
      // An authorized card relabeled with a hidden position.
      const own = base.fairness!.proofs[0];
      if (own) expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => { m.fairness!.proofs[0]!.index = 51; }), table, viewer));
    });

    it.each(GUARD_VIEWERS)("winners[].handName containing an undealt card code (viewer %p)", (viewer) => {
      const base = legitimate(table, viewer);
      expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => {
        m.winners.push({ seatIndex: heroSeat, amount: 10, handName: `Pair of Aces, ${undealt(table)} kicker` });
      }), table, viewer));
    });

    it("viewer's own hole cards replaced by different cards", () => {
      const base = legitimate(table, HERO);
      const own = table.players[heroSeat]!.holeCards!;
      const replacements: [Card, Card][] = [
        [undealt(table), undealt(table, 1)],
        [own[0], undealt(table)],
        [...opponents(table)[0]!.holeCards!],
      ];
      // Cards the viewer may see, but not the viewer's hole cards: only the structural check can catch this.
      if (table.board.length >= 2) replacements.push([table.board[0]!, table.board[1]!]);
      for (const cards of replacements) {
        expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => { m.players[heroSeat]!.holeCards = cards; }), table, HERO));
      }
    });
  });

  it("mucked hands stay hidden at SHOWDOWN", () => {
    let t = tableAt("RIVER");
    t = applyAction(t, t.players[t.toActSeat!]!.userId, { action: "BET", amount: 10 });
    const mucked = t.players[t.toActSeat!]!;
    t = applyAction(t, mucked.userId, { action: "FOLD" });
    while (t.phase !== "SHOWDOWN") t = applyAction(t, t.players[t.toActSeat!]!.userId, { action: "CALL" });
    expect(t.players[mucked.seatIndex]!.showedCards).toBe(false);
    expect(t.players.filter((p) => p?.showedCards)).toHaveLength(3);
    for (const viewer of GUARD_VIEWERS.filter((v) => v !== mucked.userId)) {
      const base = legitimate(t, viewer);
      expect(base.players[mucked.seatIndex]!.holeCards).toBeNull();
      expectLeakBlocked(() => assertViewerStateSafe(mutated(base, (m) => { m.players[mucked.seatIndex]!.holeCards = [...mucked.holeCards!]; }), t, viewer));
    }
  });

  it("projectTableState itself refuses to emit when the engine's own output would leak", () => {
    const table = tableAt("FLOP");
    const hidden = undealt(table);
    const leakyLog = structuredClone(table);
    leakyLog.log.push({ seq: 9_999, seatIndex: null, username: "Table", text: `debug ${hidden}`, at: new Date().toISOString() });
    const leakyWinner = structuredClone(table);
    leakyWinner.winners.push({ seatIndex: 0, amount: 10, handName: `High card ${hidden}` });
    const overDealt = structuredClone(table);
    overDealt.board.push(overDealt.deck.shift()!); // a turn card dealt during the flop
    for (const broken of [leakyLog, leakyWinner, overDealt]) {
      for (const viewer of GUARD_VIEWERS) expectLeakBlocked(() => projectTableState(broken, viewer));
    }
  });
});

// ---------------------------------------------------------------------------
// The sweep's independent detectors are sensitive (the sweep cannot pass vacuously)
// ---------------------------------------------------------------------------

describe("independent leak detectors used by the sweep flag every leak class", () => {
  const table = tableAt("FLOP");
  const n = table.dealtSeats.length;
  const heroSeat = table.players.find((p) => p?.userId === HERO)!.seatIndex;
  const saltIndex = new Map(table.fairness!.salts.map((salt, i) => [salt, i] as const));
  const ctx: PayloadContext = { saltIndex, displayNames: null, where: () => "detector self-test" };
  const base = JSON.parse(JSON.stringify(toPublicTableState(table, HERO))) as PublicTableState;
  const opp = opponents(table)[0]!;
  const at = new Date().toISOString();

  it("accepts the legitimate payload", () => {
    expect(() => checkPayload(table, HERO, base, ctx)).not.toThrow();
  });

  const log = (text: string) => (m: PublicTableState): void => {
    m.logTail.push({ seq: 1, seatIndex: null, username: "Table", text, at });
  };
  it.each<[string, (m: PublicTableState & Record<string, unknown>) => void, RegExp]>([
    ["opponent hole cards", (m) => { m.players[opp.seatIndex]!.holeCards = [...opp.holeCards!]; }, /hole cards exposed/],
    ["future turn card on the board", (m) => { m.board.push(table.fairness!.deck[boardPositions(n)[3]!]!); }, /board has 4 cards in FLOP/],
    ["board shorter than the street", (m) => { m.board.pop(); }, /board has 2 cards in FLOP/],
    ["nested server-only key", (m) => { (m.players[2] as unknown as Record<string, unknown>).meta = { inner: { deckSalt: "x" } }; }, /server-only key "deckSalt"/],
    ["log line naming an undealt card", log(`Turn ${undealt(table)}`), /forbidden card .* at logTail/],
    ["log line naming a burn card", log(`Burn ${table.burns[0]!}`), /forbidden card .* at logTail/],
    ["proof of an undealt position", (m) => { m.fairness!.proofs.push(cardProof(table.fairness!, 51)); }, /forbidden card .* at fairness\.proofs/],
    ["winner hand name with an undealt card", (m) => { m.winners.push({ seatIndex: 0, amount: 1, handName: `High card ${undealt(table)}` }); }, /forbidden card .* at winners/],
    ["own hole cards replaced by board cards", (m) => { m.players[heroSeat]!.holeCards = [table.board[0]!, table.board[1]!]; }, /hole cards wrong/],
    ["card code used as an object key", (m) => { (m.players[0] as unknown as Record<string, unknown>)[undealt(table)] = 1; }, /forbidden card .* at key players/],
    ["Merkle salt of an unopened position", log(table.fairness!.salts[51]!), /salt of unopened position 51/],
    ["deck salt", log(table.fairness!.deckSalt), /deck salt in payload/],
  ])("flags %s", (_label, mutate, reason) => {
    expect(() => checkPayload(table, HERO, mutated(base, mutate), ctx)).toThrow(reason);
  });

  it("flags any card token between hands", () => {
    let hand = tableAt("RIVER");
    while (hand.phase !== "SHOWDOWN") hand = applyAction(hand, hand.players[hand.toActSeat!]!.userId, { action: "CHECK" });
    const idle = completeHand(hand);
    const state = JSON.parse(JSON.stringify(toPublicTableState(idle, HERO))) as PublicTableState;
    const idleCtx: PayloadContext = { saltIndex: null, displayNames: null, where: () => "detector self-test" };
    expect(() => checkPayload(idle, HERO, state, idleCtx)).not.toThrow();
    expect(() => checkPayload(idle, HERO, mutated(state, (m) => {
      m.logTail.push({ seq: 1, seatIndex: null, username: "Table", text: "Flop Ah Kd 7c", at });
    }), idleCtx)).toThrow(/between hands/);
    expect(() => checkCleanup(idle, GUARD_VIEWERS, () => "detector self-test")).not.toThrow();
    const leftover = structuredClone(idle);
    leftover.cashOuts.push({ userId: "Ah", stack: 0 });
    expect(() => checkCleanup(leftover, GUARD_VIEWERS, () => "detector self-test")).toThrow(/server state still holds/);
  });

  it("flags a street dealt early or a deck that is not the untouched committed tail", () => {
    expect(() => checkServerState(table, () => "detector self-test")).not.toThrow();
    const early = structuredClone(table);
    early.burns.push(early.deck.shift()!);
    early.board.push(early.deck.shift()!); // turn dealt during the flop
    expect(() => checkServerState(early, () => "detector self-test")).toThrow(/server board has 4 cards in FLOP/);
    const reordered = structuredClone(table);
    reordered.deck.reverse();
    expect(() => checkServerState(reordered, () => "detector self-test")).toThrow(/untouched tail/);
  });
});

// ---------------------------------------------------------------------------
// Hand Clean-up, bot isolation and participant audit: focused cases
// ---------------------------------------------------------------------------

describe("Hand Clean-up purge", () => {
  it.each(["fold", "showdown"] as const)("after a %s ending, completeHand leaves no card secret anywhere", (ending) => {
    let t = tableAt(ending === "fold" ? "TURN" : "RIVER");
    while (t.phase !== "SHOWDOWN") {
      const legal = legalActions(t, t.toActSeat!)!;
      const intent = ending === "fold" && legal.actions.includes("BET") ? { action: "BET" as const, amount: 10 }
        : ending === "fold" && legal.actions.includes("FOLD") ? { action: "FOLD" as const }
          : legal.actions.includes("CHECK") ? { action: "CHECK" as const } : { action: "CALL" as const };
      t = applyAction(t, t.players[t.toActSeat!]!.userId, intent);
    }
    // Secrets exist until clean-up...
    expect(t.fairness).not.toBeNull();
    expect(t.audit?.finalStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.deck.length).toBeGreaterThan(0);
    const cleaned = completeHand(t);
    expect(cleaned.deck).toEqual([]);
    expect(cleaned.burns).toEqual([]);
    expect(cleaned.fairness).toBeNull();
    expect(cleaned.audit).toBeNull();
    expect(cleaned.handChipTotal).toBeNull();
    expect(cleaned.players.every((p) => !p || p.holeCards === null)).toBe(true);
    expect(cleaned.board).toEqual([]);
    expect(cleaned.log).toEqual([]);
    expect(cleaned.actions).toEqual([]);
    expect(cleaned.dealtSeats).toEqual([]);
    // ...and afterwards nothing card-shaped remains in server memory or any projection.
    expect(scanJson(JSON.parse(JSON.stringify(cleaned))).cards).toEqual([]);
    for (const viewer of GUARD_VIEWERS) {
      const state = JSON.parse(JSON.stringify(projectTableState(cleaned, viewer))) as PublicTableState;
      expect(scanJson(state).cards).toEqual([]);
      expect(state.fairness).toBeNull();
    }
    // The original (pre-clean-up) table is untouched: transitions are pure.
    expect(t.deck.length).toBeGreaterThan(0);
  });
});

describe("bot isolation", () => {
  it.each(STREETS)("botInformationView during %s hides opponents, deck, burns, commitments and audit without mutating the table", (street) => {
    const table = tableAt(street);
    const before = JSON.stringify(table);
    const view = botInformationView(table);
    expect(view.deck).toEqual([]);
    expect(view.burns).toEqual([]);
    expect(view.fairness).toBeNull();
    expect(view.audit).toBeNull();
    for (const p of view.players) if (p && p.seatIndex !== table.toActSeat) expect(p.holeCards).toBeNull();
    expect(view.players[table.toActSeat!]!.holeCards).toEqual(table.players[table.toActSeat!]!.holeCards);
    decideBotAction(table);
    expect(JSON.stringify(table)).toBe(before);
  });
});

describe("participant audit edge cases", () => {
  async function settledHand(): Promise<{ table: EngineTable; evidence: ObservedHandEvidence; record: HandAuditRecord }> {
    let t = tableAt("PREFLOP");
    const live = JSON.parse(JSON.stringify(projectTableState(t, HERO))) as PublicTableState;
    const f = live.fairness!;
    const evidence: ObservedHandEvidence = { handId: f.handId, merkleRoot: f.root, deckCommitment: f.deckCommitment, auditSeq: f.auditSeq, auditHead: f.auditHead,
      holeCardsDigest: await holeCardsDigest(f.handId, live.players.find((p) => p.userId === HERO)!.holeCards!) };
    expect(() => participantAudit(t.audit!, sealedAudit(t.fairness!), 0)).toThrow(/not settled/);
    while (t.phase !== "SHOWDOWN") {
      const legal = legalActions(t, t.toActSeat!)!;
      t = applyAction(t, t.players[t.toActSeat!]!.userId, legal.actions.includes("CHECK") ? { action: "CHECK" } : { action: "CALL" });
    }
    return { table: t, evidence, record: t.audit! };
  }

  it("refuses an undealt seat, refuses an unsettled hand, and rejects evidence from a different live chain", async () => {
    const { table, evidence, record } = await settledHand();
    const sealed = sealedAudit(table.fairness!);
    expect(() => participantAudit(record, sealed, 4)).toThrow(/not dealt/);
    expect(() => participantAudit(record, sealed, 5)).toThrow(/not dealt/);
    const heroSeat = table.players.find((p) => p?.userId === HERO)!.seatIndex;
    const audit = participantAudit(record, sealed, heroSeat);
    expect(await verifyParticipantAudit(audit, evidence)).toEqual({ ok: true });
    // Evidence the player saw live must match: a different head, root or own cards is rejected.
    expect((await verifyParticipantAudit(audit, { ...evidence, auditHead: record.events[0]!.hash })).ok).toBe(false);
    expect((await verifyParticipantAudit(audit, { ...evidence, merkleRoot: "0".repeat(64) })).ok).toBe(false);
    expect((await verifyParticipantAudit(audit, { ...evidence, holeCardsDigest: await holeCardsDigest(record.handId, [table.deck[0]!, table.deck[1]!]) })).ok).toBe(false);
    // A tampered proof set (an extra opening of an undealt position) is rejected.
    const extra = { ...audit, proofs: [...audit.proofs, cardProof(table.fairness!, 51)] };
    expect((await verifyParticipantAudit(extra, evidence)).ok).toBe(false);
  });
});
