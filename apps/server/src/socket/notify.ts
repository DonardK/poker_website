import { SOCKET_EVENTS, type ServerToClientEvents, type SocketData } from "@poker/shared";
import { isAuthError } from "../auth/errors.js";
import { authenticate } from "../auth/middleware.js";
import { logger } from "../logger.js";
import type { PokerServer } from "./types.js";

/** What a delivery needs from a socket; a local Socket and a cluster RemoteSocket (fetchSockets) both fit. */
export interface DeliverySocket {
  data: Partial<SocketData>;
  emit(event: string, ...args: unknown[]): unknown;
  disconnect(close?: boolean): unknown;
}
type Rooms = { in(room: string): { fetchSockets(): Promise<DeliverySocket[]> } };

let attached: Rooms | null = null;
/** The Socket.io server notifyUser uses by default (set by createSocketServer). */
export function attachNotifier(io: PokerServer | Rooms | null): void { attached = io as Rooms | null; }

/**
 * COMPLIANCE (private delivery): re-validate a socket's session right before
 * something private or per-viewer is sent to it (cached per session for at
 * most AUTH_CACHE_TTL_MS, see auth/sessions.ts).
 * - Valid: true.
 * - Credential problem (revoked or expired session, expired access token,
 *   restricted account): the socket is told SESSION_REVOKED when the session
 *   itself is over, then disconnected; false.
 * - The check itself failed (database unavailable): false, and nothing else.
 *   This one delivery is skipped and logged; the socket stays connected and
 *   catches up from the next snapshot or a REHYDRATE. An outage never signs
 *   anyone out, and nothing is delivered on an unverified session.
 */
export async function admitSocket(socket: DeliverySocket): Promise<boolean> {
  try {
    await authenticate(socket.data.token);
    return true;
  } catch (err) {
    if (isAuthError(err)) {
      if (err.reason) socket.emit(SOCKET_EVENTS.SESSION_REVOKED, { reason: err.reason });
      socket.disconnect(true);
      return false;
    }
    logger.warn({ err, userId: socket.data.userId }, "session check unavailable; skipped one delivery to this socket (it stays connected)");
    return false;
  }
}

/**
 * Private per-user delivery (USER_PATCH, TABLE_IDLE_NOTICE, future account
 * events): only to that user's sockets, cluster-wide (room user:<id>), and
 * only to those whose session re-validates (admitSocket). A revoked session's
 * socket that has not been disconnected yet gets nothing. Returns how many
 * sockets received it. `io` defaults to the attached server.
 */
export async function notifyUser<E extends keyof ServerToClientEvents>(
  userId: string, event: E, payload: Parameters<ServerToClientEvents[E]>[0], io: Rooms | PokerServer | null = attached,
): Promise<number> {
  if (!io) return 0;
  const sockets = await (io as Rooms).in(`user:${userId}`).fetchSockets();
  let delivered = 0;
  for (const socket of sockets) {
    // Defence in depth: a socket in this room always belongs to this user.
    if (socket.data.userId !== userId) continue;
    if (await admitSocket(socket)) { socket.emit(event, payload); delivered += 1; }
  }
  return delivered;
}
