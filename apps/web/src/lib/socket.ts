"use client";

import { io, type Socket } from "socket.io-client";
import { SOCKET_EVENTS, type ClientToServerEvents, type ServerToClientEvents } from "@poker/shared";
import { useAuthStore } from "@/stores/session";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";

export type PokerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: PokerSocket | null = null;
/** The user the socket was opened for. Another user never shares it: their socket is a new one. */
let boundUserId: string | null = null;
/** The newest access token this socket was given; sent on every (re)connect. */
let socketToken: string | null = null;

/**
 * The session's socket. One socket serves a user for the whole session: a
 * token refresh does not replace it (that would drop the table's room, every
 * listener and the snapshot on screen). The new token is handed to the live
 * connection with SESSION_RENEW (renewSocketSession) and used by every later
 * reconnect. Only a different user (or sign-out, disconnectSocket) gets a new
 * socket.
 *
 * Callers pass the token they rendered with, which may be stale after an
 * await; the store's current token wins, so a stale caller can never put an
 * older token back on the socket.
 */
export function getSocket(accessToken: string): PokerSocket {
  const state = useAuthStore.getState();
  const token = state.accessToken ?? accessToken;
  const userId = state.user?.id ?? null;
  if (socket && boundUserId === userId) {
    socketToken = token;
    return socket;
  }
  disconnectSocket();
  boundUserId = userId;
  socketToken = token;
  socket = io(SOCKET_URL, {
    autoConnect: true,
    withCredentials: true,
    // Read at each (re)connect, so a reconnect after a refresh presents the new token.
    auth: (cb) => cb({ token: socketToken }),
    transports: ["websocket", "polling"],
  });
  return socket;
}

/** The session's socket if one is open, without creating one. */
export function currentSocket(): PokerSocket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (!socket) {
    boundUserId = null;
    socketToken = null;
    return;
  }
  const closing = socket;
  socket = null;
  boundUserId = null;
  socketToken = null;
  closing.removeAllListeners();
  closing.disconnect();
}

/** How long a server has to acknowledge SESSION_RENEW before we assume it predates it. */
const RENEW_TIMEOUT_MS = 5_000;

/**
 * - "renewed": the live connection now carries `token`; nothing else changes.
 * - "unauthorized": the server refused the token: the session is over.
 * - "reconnected": no usable answer (a server without SESSION_RENEW, or a
 *   temporary failure), so the same socket reconnects with the new token. The
 *   table keeps its last verified snapshot and re-joins on "connect".
 * - "idle": no connected socket; its next connect presents the new token.
 */
export type RenewOutcome = "renewed" | "unauthorized" | "reconnected" | "idle";

/** Hand a refreshed access token to the live socket without replacing it. */
export async function renewSocketSession(token: string): Promise<RenewOutcome> {
  const target = socket;
  if (!target) return "idle";
  socketToken = token;
  if (!target.connected) return "idle";
  try {
    const reply = await target.timeout(RENEW_TIMEOUT_MS).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token });
    if (reply.ok) return "renewed";
    if (reply.code === "UNAUTHORIZED") return "unauthorized";
  } catch {
    /* no ack in time, or the connection dropped: reconnect below */
  }
  // Signed out or replaced meanwhile: nothing to reconnect.
  if (socket !== target) return "idle";
  // Already reconnecting by itself (dropped while waiting): that reconnect presents the new token.
  if (!target.connected && target.active) return "idle";
  target.disconnect();
  target.connect();
  return "reconnected";
}

/**
 * Reconnect the same socket after the server closed it ("io server
 * disconnect") or refused a reconnect, both of which socket.io never retries
 * on its own. Listeners stay attached, so the table re-joins on "connect".
 */
export function resumeSocket(): void {
  if (socket && !socket.connected && !socket.active) socket.connect();
}
