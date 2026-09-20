import type { Card, HandHistoryLogEntry, PublicPlayerView, PublicTableState } from "@poker/shared";
import { legalActions } from "./legal.js";
import type { EngineTable } from "./types.js";

const REVEAL_PHASES = new Set(["SHOWDOWN", "COMPLETE"]);

export function toPublicTableState(table: EngineTable, viewerUserId: string | null): PublicTableState {
  const reveal = REVEAL_PHASES.has(table.phase);
  const viewerSeat = table.players.find((p) => p?.userId === viewerUserId)?.seatIndex ?? null;
  const actorLegal =
    table.toActSeat != null && table.players[table.toActSeat]?.userId === viewerUserId
      ? legalActions(table, table.toActSeat)
      : null;

  return {
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
    players: table.players.map((p, seatIndex) => playerView(table, p, seatIndex, viewerUserId, viewerSeat, reveal)),
    logTail: table.log.slice(-40),
    winners: table.winners,
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

function playerView(
  table: EngineTable,
  player: EngineTable["players"][number],
  seatIndex: number,
  viewerUserId: string | null,
  _viewerSeat: number | null,
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

  const showHoles =
    Boolean(player.holeCards) &&
    (player.userId === viewerUserId || (reveal && player.showedCards));

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
    holeCards: showHoles ? player.holeCards : null,
    timeBankMsRemaining,
    empty: false,
    avatarHue: player.avatarHue,
  };
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
