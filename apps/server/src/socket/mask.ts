import type { PublicPlayerView, PublicTableState } from "@poker/shared";

/**
 * Zero-trust mask: strip every hole card that does not belong to the viewer
 * unless the hand is at showdown (Phase 5 will also reveal mucked-show cards).
 */
export function maskTableState(state: PublicTableState, viewerUserId: string): PublicTableState {
  const revealAll = state.phase === "SHOWDOWN" || state.phase === "COMPLETE";
  return {
    ...state,
    players: state.players.map((player) => maskPlayer(player, viewerUserId, revealAll)),
  };
}

function maskPlayer(player: PublicPlayerView, viewerUserId: string, revealAll: boolean): PublicPlayerView {
  if (revealAll || player.userId === viewerUserId) return player;
  return { ...player, holeCards: null };
}
