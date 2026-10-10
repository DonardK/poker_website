/** Persisted on the hibernating socket. No token, ticket, or cards. */
export interface LobbyAttachment {
  userId: string;
  sessionId: string;
  username: string;
  connectedAt: number;
}

export function writeAttachment(ws: WebSocket, attachment: LobbyAttachment): void {
  ws.serializeAttachment(attachment);
}

export function readAttachment(ws: WebSocket): LobbyAttachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.userId !== "string" || row.userId.length < 1 || row.userId.length > 128) return null;
  if (typeof row.sessionId !== "string" || row.sessionId.length < 1 || row.sessionId.length > 128) return null;
  if (typeof row.username !== "string" || row.username.length < 1 || row.username.length > 64) return null;
  if (typeof row.connectedAt !== "number" || !Number.isFinite(row.connectedAt)) return null;
  return { userId: row.userId, sessionId: row.sessionId, username: row.username, connectedAt: row.connectedAt };
}

/** Stable for the life of the socket. Composed from the attachment fields only. */
export function connectionId(attachment: LobbyAttachment): string {
  return `${attachment.userId}:${attachment.sessionId}:${attachment.connectedAt}`;
}
