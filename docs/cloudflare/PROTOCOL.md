# WebSocket protocol

Normative wire format for `apps/edge` and `apps/web`. WP1 copies the TypeScript in this file into `packages/shared/src/protocol.ts` and re-exports it from `packages/shared/src/index.ts`. Payload types that already exist (`PublicTableState`, `CommandResult`, `AuthOkPayload`, and the rest) stay in `packages/shared/src/events.ts` and are imported, not duplicated.

`SOCKET_EVENTS` strings are the frame `type` values. Do not rename them.

## 1. Transport

| Item | Value |
|---|---|
| Table | `wss://<host>/ws/table/<tableId>` (local dev: `ws://127.0.0.1:8787/ws/table/<tableId>`) |
| Lobby | `wss://<host>/ws/lobby` |
| Upgrade credential | Cookie `poker_ws` (`Path=/ws`). See ARCHITECTURE.md §8.2. |
| Subprotocol | none |
| Query string | none |
| Frames | one JSON object per text frame, UTF-8 |
| Max frame size | 8,192 bytes. Larger frames are ignored and counted toward the connection rate limit. The socket is closed with `1009` if a frame exceeds 8,192 bytes. |
| Binary frames | illegal. Close `1003`. |
| Keepalive | client sends the exact text frame `ping` (four characters, not JSON) at most every 20s. The DO auto-responds `pong` and does not run application code. `ping` / `pong` do not count toward the 20-frame budget. |

The access token is not on the URL. After the socket is open, `SESSION_RENEW` carries a new access token in the JSON body.

## 2. Envelope

```ts
export const PROTOCOL_VERSION = 1 as const;

export interface ClientFrame<T = unknown> {
  v: 1;
  /** Correlates ACK. Required for every frame that had a Socket.IO ack. UUID v4. */
  id?: string;
  type: ClientFrameType;
  payload: T;
}

export interface ServerFrame<T = unknown> {
  v: 1;
  /** Present on ACK and on a pushed error that answers a frame id. */
  id?: string;
  type: ServerFrameType;
  payload: T;
}
```

Unknown `type` values: the server responds with `SERVER_ERROR` / `UNKNOWN_TYPE` if the frame was valid JSON under the size cap, and does not change state. The client ignores unknown server `type` values so a newer server can add pushes.

`v` other than `1` → `SERVER_ERROR` / `BAD_VERSION`, no state change.

## 3. Client → server

Types are the `SOCKET_EVENTS` values plus lobby frames.

```ts
import type {
  ActionIntentPayload,
  CommandResult,
  RehydratePayload,
  SeatClaimPayload,
  SessionRenewPayload,
  SitTogglePayload,
  TableJoinPayload,
} from "./events.js";

export const CLIENT_FRAME = {
  TABLE_JOIN: "TABLE_JOIN",
  TABLE_LEAVE: "TABLE_LEAVE",
  SEAT_CLAIM: "SEAT_CLAIM",
  SIT_OUT: "SIT_OUT",
  SIT_IN: "SIT_IN",
  ACTION_INTENT: "ACTION_INTENT",
  REHYDRATE: "REHYDRATE",
  STAND_UP: "STAND_UP",
  TABLE_KEEP_ALIVE: "TABLE_KEEP_ALIVE",
  SESSION_RENEW: "SESSION_RENEW",
  LOBBY_HELLO: "LOBBY_HELLO",
} as const;

export type ClientFrameType = (typeof CLIENT_FRAME)[keyof typeof CLIENT_FRAME];
```

| type | Socket | Payload | Ack `id` required | Effect |
|---|---|---|---|---|
| `TABLE_JOIN` | table | `TableJoinPayload` | no | Join this DO's fanout. `payload.tableId` must equal the URL id. Sends `STATE_SNAPSHOT` or `SERVER_ERROR`. |
| `TABLE_LEAVE` | table | `TableJoinPayload` | no | Stop snapshots to this socket. Seat unchanged. |
| `SEAT_CLAIM` | table | `SeatClaimPayload` | yes | Buy-in. `commandId` required on the edge (optional in the old type). |
| `SIT_OUT` | table | `SitTogglePayload` | yes | `commandId` required. |
| `SIT_IN` | table | `SitTogglePayload` | yes | `commandId` required. |
| `STAND_UP` | table | `SitTogglePayload` | yes | `commandId` required. |
| `ACTION_INTENT` | table | `ActionIntentPayload` | yes | `clientActionId` is the idempotency key. |
| `REHYDRATE` | table | `RehydratePayload` | no | Resend the current snapshot if `tableId` matches the URL or is omitted. |
| `TABLE_KEEP_ALIVE` | table or lobby | `TableJoinPayload` | yes | Seated human cancels the idle warning. On the lobby socket the DO RPCs the table. |
| `SESSION_RENEW` | either | `SessionRenewPayload` | yes | Replace this socket's session id if `sub` matches. |
| `LOBBY_HELLO` | lobby | `Record<string, never>` (`{}`) | no | Server replies `LOBBY_SNAPSHOT`. Sent by the client after `AUTH_OK`. |

`TABLE_JOIN` on the lobby socket is `UNKNOWN_TYPE` there (the lobby is not a table). `LOBBY_HELLO` on a table socket is `UNKNOWN_TYPE`.

Validation matches `apps/server/src/socket/index.ts` (strict objects, UUID `commandId` / `clientActionId`, `turnId` `/^\d{1,12}:\d{1,12}$/`, seat 0–8, buy-in bounds). Invalid payload → ack `{ ok: false, code: "INVALID_REQUEST", message: "Request could not be completed" }` when `id` is set, and a `SERVER_ERROR` frame either way. `SERVER_ERROR.tableId` is set when the payload named a well-formed table id, including when the rest of the payload failed validation.

## 4. Server → client

```ts
import type {
  AuthOkPayload,
  HandHistoryLogEntry,
  PublicTableState,
  SessionRevokedPayload,
  SocketErrorPayload,
  TableIdleNoticePayload,
  TableListItem,
  UserPatchPayload,
} from "./events.js";

export const SERVER_FRAME = {
  AUTH_OK: "AUTH_OK",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  HAND_HISTORY_LOG: "HAND_HISTORY_LOG",
  SERVER_ERROR: "SERVER_ERROR",
  USER_PATCH: "USER_PATCH",
  TABLE_IDLE_NOTICE: "TABLE_IDLE_NOTICE",
  SESSION_REVOKED: "SESSION_REVOKED",
  ACK: "ACK",
  LOBBY_SNAPSHOT: "LOBBY_SNAPSHOT",
  LOBBY_PATCH: "LOBBY_PATCH",
} as const;

export type ServerFrameType = (typeof SERVER_FRAME)[keyof typeof SERVER_FRAME];

export interface AckPayload extends Extract<CommandResult, { ok: true }> {
  ok: true;
}
export interface AckFailure {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
}

/** ACK payload is CommandResult. Named here so the frame map is obvious. */
export type AckBody = CommandResult;

export interface LobbySnapshotPayload {
  tables: TableListItem[];
}

export interface LobbyPatchPayload {
  /** Present when the table should disappear from this user's list. */
  removed?: boolean;
  table?: TableListItem;
}
```

| type | When | Payload |
|---|---|---|
| `AUTH_OK` | Immediately after a successful upgrade, before any snapshot. | `AuthOkPayload` |
| `STATE_SNAPSHOT` | After join, rehydrate, and every committed mutation, per socket, per viewer. | `PublicTableState` |
| `HAND_HISTORY_LOG` | New log line after commit. The snapshot's `logTail` is the recovery path. | `HandHistoryLogEntry` |
| `SERVER_ERROR` | Refused request, or a push that is not tied to an ack. | `SocketErrorPayload` |
| `USER_PATCH` | Bankroll changed, including when the player is on the lobby socket. | `UserPatchPayload` |
| `TABLE_IDLE_NOTICE` | Warning started or cleared for a seated human. | `TableIdleNoticePayload` |
| `SESSION_REVOKED` | Then the socket is closed with `4001`. | `SessionRevokedPayload` |
| `ACK` | Response to a client frame that included `id`. | `CommandResult` |
| `LOBBY_SNAPSHOT` | Reply to `LOBBY_HELLO`, and on lobby reconnect. | `LobbySnapshotPayload` |
| `LOBBY_PATCH` | One table's public list row changed. | `LobbyPatchPayload` |

`STATE_SNAPSHOT.revision` is the committed revision. The client drops a snapshot whose `revision` is lower than the one it already applied for that `tableId`. Equal revision replaces the view (a resync of the same commit is allowed).

There is no delta frame. Reconnect is a full snapshot.

### Internal RPC (not on the wire to browsers)

These are Durable Object RPC arguments, not WebSocket frames. They must not be accepted from a client frame.

```ts
export interface LobbySeatPatch {
  removed: boolean;
  /** TableListItem without isSeated. The lobby DO fills isSeated per socket. */
  table: Omit<import("./api.js").TableListItem, "isSeated">;
  seatedUserIds: string[];
}
```

## 5. Acks

Socket.IO acks become a server frame:

```json
{ "v": 1, "id": "<the client id>", "type": "ACK", "payload": { "ok": true } }
```

Rules:

- The client generates `id` (UUID v4) and stores a resolver until `ACK` with that `id`, or until `timeout` (the adapter's `timeout(ms).emitWithAck`).
- The server sends at most one `ACK` per `id`.
- A retry of the same **command** reuses `commandId` / `clientActionId` but uses a **new** frame `id`. The `ACK` may be `{ ok: true, duplicate: true }` or `{ ok: true, pendingLeave: true, duplicate: true }`.
- `duplicate` is only true when the original command committed. A retry of a command that failed with a definitive error returns that same error again (also stored).
- If the server emits `SERVER_ERROR` for a frame that had an `id`, it also emits `ACK` with the same code so `emitWithAck` settles. The client adapter delivers `SERVER_ERROR` to listeners and resolves the promise from `ACK`. One user-visible error, not two.
- Frames without `id` (`TABLE_JOIN`, `REHYDRATE`, `LOBBY_HELLO`) have no `ACK`. Success is the pushed snapshot. Failure is `SERVER_ERROR`.
- `SESSION_RENEW` success is `{ ok: true }`. Failure codes: `UNAUTHORIZED` (bad token or other user — the socket then closes `4002`) or `SERVICE_UNAVAILABLE` with `retryable: true` (socket stays up).

Adapter timeout: if no `ACK` arrives, the promise rejects and the client may resend with the **same** `commandId` / `clientActionId` and a new frame `id`. It must not generate a new command id for a retry of an action it is unsure about.

## 6. Error codes

`SocketErrorPayload.code` and `AckFailure.code`.

### Transport and auth

| Code | Retryable | Meaning |
|---|---|---|
| `UNAUTHORIZED` | no | Missing session, bad token, or renew for another user. |
| `SERVICE_UNAVAILABLE` | yes | Database or DO storage unavailable. Session still valid. |
| `RATE_LIMITED` | yes, after the window | DO bucket or upgrade limit. |
| `INVALID_REQUEST` | no | Schema rejection. |
| `UNKNOWN_TYPE` | no | Frame type not in this protocol. |
| `BAD_VERSION` | no | `v` is not `1`. |
| `TABLE_FULL` | no | More than 64 sockets on this table. |

### Table and engine (same strings the engine and the Node server already use)

`TABLE_NOT_FOUND`, `TABLE_CLOSED`, `TABLE_CLOSING`, `STALE_ACTION`, `TURN_EXPIRED`, `RECOVERY_REQUIRED`, `BANKROLL`, `CASHOUT_FAILED`, `ALREADY_SEATED`, `SEAT_TAKEN`, `BAD_SEAT`, `BUYIN`, `NOT_SEATED`, `NOT_YOUR_TURN`, `NO_TURN`, `ILLEGAL`, `MIN_BET`, `MIN_RAISE`, `BAD_AMOUNT`, `NOT_ENOUGH_PLAYERS`, `IN_HAND`, `NO_HAND`, `CHIP_INVARIANT`, `CLOSE_FAILED`, `LEAK_BLOCKED` (never sent to the client; the server sends nothing for that viewer).

`STALE_ACTION` is followed by a `STATE_SNAPSHOT` for that socket so the client can redraw the buttons.

HTTP-only codes (not WebSocket frames): `TURNSTILE_FAILED`, `TERMS_REQUIRED`, `TERMS_OUTDATED`. Bodies stay as in `apps/server/src/auth/routes.ts`.

## 7. Close codes

| Code | Reason text | When |
|---|---|---|
| `1000` | `bye` | Client closed on sign-out. |
| `1003` | `binary` | Binary frame. |
| `1008` | `policy` | Frame that fails authentication after the upgrade (should be rare; prefer `4002`). |
| `1009` | `too-large` | Frame over 8,192 bytes. |
| `4001` | `session` | After `SESSION_REVOKED`. |
| `4002` | `unauthorized` | Renew for another user, or session row missing on a mutating frame. |
| `4003` | `full` | Viewer cap. |
| `1011` | `error` | Unexpected server failure. Client reconnects with backoff. |

Application close codes are in the 4000–4999 range. The client treats `4001` and `4002` as "do not reconnect; the session is over" except `4002` during renew, where the auth hydrator already signs the user out. `1011`, `1006` (abnormal), and network errors use the reconnect schedule in ARCHITECTURE.md §9.1.

## 8. Idempotency

| Client field | Stored as | Reuse rule |
|---|---|---|
| `SeatClaimPayload.commandId` | `cmd:<uuid>` | Required. A second claim with the same id returns the first ack and does not debit again. |
| `SitTogglePayload.commandId` | `cmd:<uuid>` | Required for `SIT_IN`, `SIT_OUT`, `STAND_UP`, `TABLE_KEEP_ALIVE`. |
| `ActionIntentPayload.clientActionId` | `cmd:<uuid>` | Required. A retry after a lost `ACK` cannot apply the action twice. |

The old Node server accepted a missing `commandId`. The edge server requires it for those four mutating families. The web client already sends `commandId` on seat claim. WP5's adapter must send a UUID on sit, stand, and keep-alive too. The shared `events.ts` types stay optional so the Node server still compiles; the edge zod schema requires the field. A follow-up may tighten `events.ts` once `apps/server` is retired.

Server-generated ids (`timer:`, `showdown:`, `deal:`, `close:`) are in ARCHITECTURE.md §3. Clients never send those.

## 9. Sequencing

- One `revision` counter on the engine state, already on `PublicTableState`. It increments by 1 per committed mutation, including timeouts and deals.
- `turnId` (`"<handNumber>:<turnSeq>"`) is the staleness key for `ACTION_INTENT`. A revision bump from someone else sitting out does not by itself reject the action. This matches `TableManager.intent`.
- Wallet updates are not ordered by `revision`. They are ordered by `UserPatchPayload.walletVersion` when the server sends it. The edge server may omit `walletVersion` (the Node server omits it today). Clients that see a number ignore a lower one.

## 10. Client adapter notes

`apps/web/src/lib/ws-client.ts` maps:

| Existing call | Frames |
|---|---|
| `socket.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId })` | `{ v:1, type:"TABLE_JOIN", payload:{ tableId } }` |
| `socket.timeout(ms).emitWithAck(EVENT, payload)` | same, plus `id`, wait for `ACK` or `ms` |
| `socket.on(SOCKET_EVENTS.STATE_SNAPSHOT, fn)` | server frame `type === "STATE_SNAPSHOT"` |
| `socket.on("connect")` | WebSocket `open` **and** `AUTH_OK` received. The table hook's join runs on `connect`, so `connect` must mean "authenticated", not merely "TCP open". |
| `socket.on("disconnect")` | socket closed |
| `socket.on("connect_error", err)` | upgrade failed or `AUTH_OK` never arrived. `err.message === "Unauthorized"` when the ticket or session was rejected, so the existing hook text still matches. |

`getSocket` keeps a lobby connection for the signed-in user. The table page's `getSocket` also ensures the table connection for the current table id (the hook passes the table through `TABLE_JOIN`; the adapter reads `tableId` from that emit and opens `/ws/table/:id` if needed). Components stay on the facade.

Heartbeat: after `open`, `setInterval` 20s sends `ping` while `document.visibilityState !== "hidden"`. On `visible`, if the socket is closed, reconnect immediately (backoff reset to the first step).

## 11. Example

Seat claim and the committed snapshot (whitespace insignificant):

```json
{ "v": 1, "id": "9b1c0e2a-6f4d-4a3e-9c1b-7d2e5f6a8b0c", "type": "SEAT_CLAIM", "payload": { "tableId": "clx…", "seatIndex": 2, "buyIn": 2000, "commandId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" } }
```

```json
{ "v": 1, "id": "9b1c0e2a-6f4d-4a3e-9c1b-7d2e5f6a8b0c", "type": "ACK", "payload": { "ok": true } }
```

```json
{ "v": 1, "type": "STATE_SNAPSHOT", "payload": { "revision": 4, "tableId": "clx…", "turnId": null } }
```

The snapshot's other `PublicTableState` fields are required in real frames. The example only shows the ordering fields.

A replay of the same `commandId` after a lost ACK:

```json
{ "v": 1, "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "type": "ACK", "payload": { "ok": true, "duplicate": true } }
```

`revision` stays 4. Bankroll is not debited again.
