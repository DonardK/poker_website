"use client";

import { useEffect } from "react";
import {
  HEX_64,
  holeCardsDigest,
  SOCKET_EVENTS,
  UUID_V4,
  verifyTableCards,
  type PublicFairness,
  type PublicTableState,
  type SocketErrorPayload,
} from "@poker/shared";
import { getSocket } from "@/lib/socket";
import { useAuthStore, useTableStore } from "@/stores/session";

/**
 * The table header's connection status. "cards match commitment": the latest
 * snapshot's revealed cards were checked against the hand's deck commitment
 * (Merkle proofs) and match; it claims nothing more about fairness than that.
 * "disconnected": the connection is being re-established and the last
 * verified snapshot stays on screen meanwhile.
 */
export type TableSocketStatus =
  | "idle" | "connected" | "authenticated" | "live" | "cards match commitment"
  | "disconnected" | "verification failed" | "error" | "closed";

export const CARDS_MATCH_COMMITMENT = "cards match commitment" satisfies TableSocketStatus;

/** Statuses in which the table is playable: a verified snapshot over a live connection. */
export function isTableSocketLive(status: string): boolean {
  return status === "live" || status === CARDS_MATCH_COMMITMENT;
}

/** How often a join that has produced no snapshot is re-sent (and the "taking longer" note shown). */
const JOIN_RETRY_MS = 8_000;
/** A temporary refusal (retryable) of the join is retried after this pause. */
const RETRYABLE_JOIN_DELAY_MS = 2_000;

/**
 * Join `tableId` on the session's socket and keep the table store in step.
 * Keyed on the table and the signed-in user, not the access token: a token
 * refresh keeps the socket, the room and the snapshot on screen (the session
 * renews the socket's token in place). The table store is reset only when the
 * table or the user changes, or on sign-out.
 */
export function useTableSocket(tableId: string | undefined, accessToken: string | null) {
  const setSnapshot = useTableStore((s) => s.setSnapshot);
  const setSocketStatus = useTableStore((s) => s.setSocketStatus);
  const setTableError = useTableStore((s) => s.setTableError);
  const markTableClosed = useTableStore((s) => s.markTableClosed);
  const appendLog = useTableStore((s) => s.appendLog);
  const resetTable = useTableStore((s) => s.resetTable);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const signedIn = Boolean(accessToken);

  useEffect(() => {
    // Signed out (or not yet signed in): nothing of a previous session's table stays on screen.
    const token = useAuthStore.getState().accessToken;
    if (!signedIn || !userId || !tableId || !token) { resetTable(); return; }
    purgeUnscopedLiveEvidence();
    resetTable();
    const socket = getSocket(token);

    const join = () => socket.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId });
    const onConnect = () => {
      setSocketStatus("connected");
      join();
    };
    let cancelled = false;
    // Set once a snapshot fails verification. Every later snapshot, including
    // those already queued, is dropped, so none can clear the error and resume play.
    let failed = false;
    let queue = Promise.resolve();
    const onSnap = (payload: PublicTableState) => {
      if (payload.tableId !== tableId) return;
      // closingInMs was measured when the server built the snapshot, so the
      // idle countdown starts from arrival, not from when verification ends.
      const receivedAt = performance.now();
      // Snapshots are verified and recorded strictly one at a time, in arrival
      // order: each step (including the async hole-card digest) finishes
      // before the next starts.
      queue = queue.then(async () => {
        if (cancelled || failed) return;
        const previous = useTableStore.getState().snapshot;
        if (previous && payload.revision < previous.revision) return;
        if (!await verifyTableCards(payload)) throw new Error("Card verification failed. Reconnect before playing.");
        if (payload.fairness) await recordLiveEvidence(payload, payload.fairness);
        if (!cancelled) { setSnapshot(payload, receivedAt); setSocketStatus(payload.fairness ? CARDS_MATCH_COMMITMENT : "live"); }
      }).catch((err: Error) => {
        if (cancelled) return;
        failed = true;
        setSnapshot(null); setTableError(err.message); setSocketStatus("verification failed");
        socket.disconnect();
      });
    };
    // AUTH_OK on a socket already showing a live table (a server that
    // re-confirms after SESSION_RENEW) must not mark the table as connecting.
    const onAuth = () => { if (!isTableSocketLive(useTableStore.getState().socketStatus)) setSocketStatus("authenticated"); };
    const onConnectError = (err: Error) => {
      setSocketStatus("disconnected");
      // The session refreshes the token and reconnects, or signs out if the session is over.
      setTableError(err.message === "Unauthorized" ? "Renewing your session…" : "Live game connection unavailable. Retrying…");
    };
    const onDisconnect = () => {
      // The last verified snapshot stays on screen; the status says it is not live.
      if (useTableStore.getState().socketStatus !== "verification failed") setSocketStatus("disconnected");
    };
    let retryJoin: number | undefined;
    const onError = (payload: SocketErrorPayload) => {
      // A refusal of a request about another table (e.g. the app-wide idle
      // warning's "I'm still here" for the table this player kept a seat at)
      // says nothing about this one. Errors naming no table still show.
      if (payload.tableId !== undefined && payload.tableId !== tableId) return;
      // This table is refused on join, on reconnect and for every command
      // because it has closed. That is an outcome, not a fault: the page
      // shows the closed dialog.
      if (payload.code === "TABLE_CLOSED" && payload.tableId === tableId) { markTableClosed(); return; }
      // Temporary (e.g. SERVICE_UNAVAILABLE): the session shows a brief
      // notice. Nothing here is broken; a refused join is simply sent again.
      if (payload.retryable === true) {
        if (!useTableStore.getState().snapshot) {
          window.clearTimeout(retryJoin);
          retryJoin = window.setTimeout(() => {
            if (!cancelled && socket.connected && !useTableStore.getState().snapshot) join();
          }, RETRYABLE_JOIN_DELAY_MS);
        }
        return;
      }
      setTableError(payload.message);
      if (!useTableStore.getState().snapshot) setSocketStatus("error");
    };

    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);
    socket.on(SOCKET_EVENTS.AUTH_OK, onAuth);
    socket.on(SOCKET_EVENTS.STATE_SNAPSHOT, onSnap);
    socket.on(SOCKET_EVENTS.HAND_HISTORY_LOG, appendLog);
    socket.on(SOCKET_EVENTS.SERVER_ERROR, onError);

    if (socket.connected) onConnect();
    else socket.connect();

    // A slow network is not a stalled table: say it is taking longer than
    // usual and keep asking until a snapshot (or a refusal) arrives.
    const watchdog = window.setInterval(() => {
      const { snapshot, socketStatus, tableClosed } = useTableStore.getState();
      if (snapshot || tableClosed || socketStatus === "error" || socketStatus === "verification failed") return;
      setTableError("Joining this table is taking longer than usual. Still trying…");
      if (socket.connected) join();
    }, JOIN_RETRY_MS);

    return () => {
      cancelled = true;
      window.clearInterval(watchdog);
      window.clearTimeout(retryJoin);
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
      socket.off(SOCKET_EVENTS.AUTH_OK, onAuth);
      socket.off(SOCKET_EVENTS.STATE_SNAPSHOT, onSnap);
      socket.off(SOCKET_EVENTS.HAND_HISTORY_LOG, appendLog);
      socket.off(SOCKET_EVENTS.SERVER_ERROR, onError);
      if (socket.connected) socket.emit(SOCKET_EVENTS.TABLE_LEAVE, { tableId });
    };
  }, [
    signedIn,
    userId,
    tableId,
    setSnapshot,
    setSocketStatus,
    setTableError,
    markTableClosed,
    appendLog,
    resetTable,
  ]);
}

// ---------------------------------------------------------------------------
// Live hand evidence (sessionStorage)
// ---------------------------------------------------------------------------

/**
 * What this browser saw of one hand during live play. "Verify hand" compares
 * it with the post-hand audit.
 *
 * COMPLIANCE NOTE: the hole cards themselves are never stored, only
 * holeCardsDigest(handId, cards). That digest is an integrity check, not
 * encryption: it is unsalted over at most 2,652 ordered card pairs, so anyone
 * who can read this tab's storage can recover the cards. Entries are
 * therefore scoped to the signed-in user, kept only for the last
 * LIVE_EVIDENCE_HANDS_KEPT hands per table, and all removed whenever the app
 * clears the session or another account replaces it (clearLiveEvidence).
 */
export interface LiveHandEvidence {
  handId: string;
  merkleRoot: string;
  deckCommitment: string;
  /** Number of audit events at the latest snapshot seen, and that event's hash. */
  auditSeq: number;
  auditHead: string;
  /** holeCardsDigest(handId, ownCards); absent if no recorded snapshot of the hand showed this user's hole cards. */
  holeCardsDigest?: string;
}

const LIVE_EVIDENCE_PREFIX = "poker-live-evidence:";
/** A new hand's entry deletes that user's entries for the same table more than this many hands older. */
const LIVE_EVIDENCE_HANDS_KEPT = 50;

/** poker-live-evidence:<userId>:<tableId>:<handNumber>. Ids are URI-encoded so the key cannot be ambiguous. */
export function liveEvidenceKey(userId: string, tableId: string, handNumber: number): string {
  return `${liveEvidenceTablePrefix(userId, tableId)}${handNumber}`;
}

function liveEvidenceTablePrefix(userId: string, tableId: string): string {
  return `${LIVE_EVIDENCE_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(tableId)}:`;
}

/** The stored evidence, or null if there is none, it is malformed, or storage is unavailable. */
export function readLiveEvidence(key: string): LiveHandEvidence | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? parseLiveEvidence(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Remove every poker-live-evidence:* entry, in any key format. Called wherever the app clears the session. */
export function clearLiveEvidence(): void {
  try {
    for (const key of storedKeys((key) => key.startsWith(LIVE_EVIDENCE_PREFIX))) sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Record this verified snapshot's commitments, audit-chain head and own
 * hole-card digest. Throws if they contradict what was recorded earlier in
 * the same hand: the commitments and hole cards must never change within a
 * hand, and the audit chain only grows.
 */
async function recordLiveEvidence(state: PublicTableState, fair: PublicFairness): Promise<void> {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return;
  const key = liveEvidenceKey(userId, state.tableId, state.handNumber);
  const prior = readLiveEvidence(key);
  if (prior && (prior.handId !== fair.handId || prior.merkleRoot !== fair.root || prior.deckCommitment !== fair.deckCommitment)) {
    throw new Error("Deck commitment changed. Stop playing this hand.");
  }
  if (prior && fair.auditSeq < prior.auditSeq) throw new Error("Hand audit trail went backwards. Stop playing this hand.");
  if (prior && fair.auditSeq === prior.auditSeq && fair.auditHead !== prior.auditHead) {
    throw new Error("Hand audit trail was rewritten. Stop playing this hand.");
  }
  const hero = state.players.find((player) => player.userId === userId);
  const digest = hero?.holeCards ? await holeCardsDigest(fair.handId, hero.holeCards) : prior?.holeCardsDigest;
  if (prior?.holeCardsDigest !== undefined && digest !== prior.holeCardsDigest) {
    throw new Error("Your hole cards changed. Stop playing this hand.");
  }
  // The session may have ended or changed hands while hashing; then write nothing.
  if (useAuthStore.getState().user?.id !== userId) return;
  const evidence: LiveHandEvidence = {
    handId: fair.handId, merkleRoot: fair.root, deckCommitment: fair.deckCommitment,
    auditSeq: fair.auditSeq, auditHead: fair.auditHead,
    ...(digest !== undefined ? { holeCardsDigest: digest } : {}),
  };
  if (!prior) pruneLiveEvidence(userId, state.tableId, state.handNumber);
  try {
    sessionStorage.setItem(key, JSON.stringify(evidence));
  } catch {
    /* storage unavailable or full: this snapshot is not recorded */
  }
}

/**
 * Remove entries in the format used before keys were scoped by user
 * (poker-live-evidence:<tableId>:<handNumber>). Those entries held raw hole
 * cards. Current keys always have three segments, because the ids in them
 * are URI-encoded and so contain no ":".
 */
function purgeUnscopedLiveEvidence(): void {
  try {
    const legacy = storedKeys((key) => key.startsWith(LIVE_EVIDENCE_PREFIX) && key.slice(LIVE_EVIDENCE_PREFIX.length).split(":").length !== 3);
    for (const key of legacy) sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function pruneLiveEvidence(userId: string, tableId: string, handNumber: number): void {
  const prefix = liveEvidenceTablePrefix(userId, tableId);
  try {
    const stale = storedKeys((key) => {
      if (!key.startsWith(prefix)) return false;
      const suffix = key.slice(prefix.length);
      return /^\d+$/.test(suffix) && handNumber - Number(suffix) > LIVE_EVIDENCE_HANDS_KEPT;
    });
    for (const key of stale) sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** Snapshot of matching keys first: removing while iterating would shift the indexes. Throws if storage is unavailable. */
function storedKeys(match: (key: string) => boolean): string[] {
  const keys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key !== null && match(key)) keys.push(key);
  }
  return keys;
}

/** Accept only the exact shape recordLiveEvidence writes; copy only its fields. */
function parseLiveEvidence(value: unknown): LiveHandEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const allowed = new Set(["handId", "merkleRoot", "deckCommitment", "auditSeq", "auditHead", "holeCardsDigest"]);
  if (Object.keys(v).some((key) => !allowed.has(key))) return null;
  const { handId, merkleRoot, deckCommitment, auditSeq, auditHead, holeCardsDigest: digest } = v;
  if (typeof handId !== "string" || !UUID_V4.test(handId) ||
      typeof merkleRoot !== "string" || !HEX_64.test(merkleRoot) ||
      typeof deckCommitment !== "string" || !HEX_64.test(deckCommitment) ||
      typeof auditSeq !== "number" || !Number.isSafeInteger(auditSeq) || auditSeq < 1 ||
      typeof auditHead !== "string" || !HEX_64.test(auditHead) ||
      (digest !== undefined && (typeof digest !== "string" || !HEX_64.test(digest)))) return null;
  return { handId, merkleRoot, deckCommitment, auditSeq, auditHead, ...(digest !== undefined ? { holeCardsDigest: digest } : {}) };
}
