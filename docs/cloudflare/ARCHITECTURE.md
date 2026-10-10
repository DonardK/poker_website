# Cloudflare implementation spec

Status: authoritative for the Workers port. Other agents implement this document and [PROTOCOL.md](./PROTOCOL.md). They do not redesign it.

This program does not change poker rules, chip amounts, session lifetimes, or the ledger's "foundation only" status. `User.bankroll` stays the live wallet until a later program calls `ledger_post`. See `docs/money/LEDGER.md`.

Do not deploy this against the current production database. The repo-root `.env` points at live Supabase. The edge runtime uses a **new Neon Postgres** reached only through Hyperdrive. `apps/server` keeps using its own env for local Node tests and is not pointed at Neon by this spec.

## 0. How to use this spec

- Implement the work package that names you. Touch only the files that package owns (section 13).
- Wire types live in `docs/cloudflare/PROTOCOL.md`. Copy them into `packages/shared/src/protocol.ts` (WP1). Do not invent a second envelope.
- If a Cloudflare or Prisma fact below conflicts with a newer doc, the doc wins and the spec should be updated in the same change. Citations are in section 14.
- Do not edit application code in order to "prepare" a package you do not own. Do not commit unless the operator asks.

## 1. Decisions

| Topic | Decision |
|---|---|
| Where the API lives | New workspace `apps/edge` (`@poker/edge`). It reuses `packages/engine` and `packages/shared`. It does not import `apps/server`. |
| `apps/server` | Stays through parity. It is the Node reference and the home of the existing `node:test` suites and of `prisma/migrations`. No WP deletes it. A later retirement PR removes the Express/Socket.IO entrypoint after the edge runtime is the only writer. |
| Redis | Not used on the edge. Durable Objects replace the Socket.IO Redis adapter and the in-process timer maps. |
| Processes | Two Workers on one hostname. Routes: `example.com/*` → web, `example.com/api/*` and `example.com/ws/*` → API. The more specific pattern wins. No service binding. The browser calls `/api` and `/ws` directly. |
| Frontend host | `@opennextjs/cloudflare` for this repo's Next.js **15.5** App Router app. Cloudflare's default recommendation is vinext, and vinext's documented `vinext init` path is an existing **Next.js 16** app. The compatibility dashboard sampled here runs against Next `16.2.6`. Do not upgrade Next to 16 in this program. Re-check vinext only as a follow-up (section 9). |
| ORM | Prisma **6.16.x** (same major as `apps/server`), generator `prisma-client` with `runtime = "cloudflare"`, driver `@prisma/adapter-pg` + `pg`. Not `prisma-client-js` (deprecated, Rust engine, not a Workers target). Not Prisma 7 in this program. Not the Neon HTTP driver. |
| Hyperdrive cache | One Hyperdrive config with caching **disabled**. Session, wallet, and table reads must be fresh. Hyperdrive's default cache is 60s and is not invalidated on write. |
| Prisma client lifetime | Construct `PrismaClient` inside the handler or DO event, never in global scope. `$disconnect()` when the event finishes (`ctx.waitUntil` on the Worker fetch path). |
| Transactions | Interactive `prisma.$transaction(async (tx) => …)` plus `SELECT … FOR UPDATE` on `"Table"`. Hyperdrive's pool is transaction-mode and holds one server connection for the whole transaction, which is what row locks require. |
| Realtime | WebSocket Hibernation API on SQLite-backed Durable Objects. One `TableActor` per table id, one `LobbyActor` named `lobby`, one `UserSessions` DO per user id. |
| Turn clocks | One DO alarm per actor. The handler runs whichever deadline is due, then arms the next. No `setTimeout`. |
| WS auth | `POST /api/ws-ticket` sets a 60s HttpOnly cookie `poker_ws` on `Path=/ws`. The browser sends it on the upgrade. The token is not a query parameter and not a `Sec-WebSocket-Protocol` value. |
| Money authority | Postgres is the only authority for `User.bankroll`, seats, and append-only `Hand*` rows. The DO SQLite blob is the hot copy of in-progress engine state and must match the Postgres checkpoint revision before a broadcast. Idempotency is a new `GameCommand` row in the same Postgres transaction. |
| Encryption | Keep AES-256-GCM for engine state and sealed audits in both DO storage and Postgres. DO at-rest encryption is additional, not a replacement. |
| Ledger | Do not call `ledger_post` from the edge port. Preserve the bankroll `updateMany` behavior in `apps/server/src/game/manager.ts`. |
| Chat | Not in this program. No chat frame in the protocol. |
| Sessions | Still Postgres rows. JWT access token + HttpOnly refresh cookie. Claim shape unchanged. Sign with `jose`, not `jsonwebtoken`. |
| Rate limits | Workers Rate Limiting binding on HTTP. Exact 2-second buckets inside the table DO. Binding windows are per Cloudflare location and only 10s or 60s. |
| Plan | Workers Paid. The free plan's 10ms CPU limit cannot run bcrypt cost 12. |

## 2. What exists today (do not reinterpret)

`apps/server` is Express 5 + Socket.IO 4. `TableManager` (`apps/server/src/game/manager.ts`) is a single process with `setTimeout` turn timers, idle timers, and a showdown pause of `HAND_BREAK_MS = 3200`. Every mutation runs in one Prisma interactive transaction that:

1. `SELECT id FROM "Table" WHERE id = $1 FOR UPDATE`
2. Decrypts `Table.stateCiphertext` (AES-256-GCM, AAD context `table:${tableId}`) or, only for a brand-new table with no hand rows, builds state from seats
3. Applies a pure `@poker/engine` function
4. Credits `User.bankroll` for `cashOuts`, updates `TableSeat`, inserts `Hand` + players/actions/pots when the phase becomes `SHOWDOWN`, writes the new ciphertext and status
5. After commit, broadcasts a **per-viewer** `projectTableState` and sends `USER_PATCH` / `TABLE_IDLE_NOTICE`

A missing ciphertext on a table that is `IN_HAND` or that already has a `Hand` row throws `RECOVERY_REQUIRED`. Never redeal.

Socket.IO authenticates with `handshake.auth.token` (the access JWT), not the query string. The socket joins `user:${userId}` and `session:${sessionId}`. Revocation emits `SESSION_REVOKED` and disconnects. `commandId` / `clientActionId` are accepted and **not stored** (comment in `apps/server/src/socket/index.ts`). This port **starts storing them**. That is a required behavior change so retries cannot double-debit. Acks gain `duplicate: true` when the stored command is replayed.

`User.bankroll` is a mutable `INT`. The ledger tables exist and nothing in the game server calls them.

Auth (preserve exactly):

- Access JWT ~15 minutes, refresh cookie idle TTL default 7 days, absolute session end default 30 days (`absoluteExpiresAt`).
- Refresh rotation stores `previousTokenHash`. Presenting the previous token within `REFRESH_GRACE_MS` (15s) returns a new access token and does not rotate again. Presenting it later revokes the session (`REFRESH_REUSE`).
- Login lockout after 5 failures, exponential delay from 30s to 15 minutes, separate familiar-address lock. Unknown users still pay one bcrypt compare against the dummy hash. Cost factor **12**.
- Register and guest require `acceptTerms: true`, `confirmAge: true`, and `termsVersion` equal to the server's current version.
- Auth cache TTL is 5s and is process-local. On Workers there is no process-local cache that spans isolates. Do not cache session rows in memory across requests. The DO may remember a session check only until it hibernates, and revocation is push-based (section 8.6), so a hibernated DO does not trust that memory after wake: it re-reads the session row on the next mutating command and on `SESSION_RENEW`.

HTTP limits today (`apps/server/src/security/rate-limits.ts`): general 120/min per user or IP, credentials 15/min per IP, refresh 30/min per refresh-cookie hash or IP, admin 30/min per IP. Socket: 20 packets / 2s per connection and 8 actions / 2s per user (`ACTION_RATE_LIMIT_*`). Body cap 32kb. CSRF guard: non-GET must be JSON if it has a body, `Origin` must match `CLIENT_ORIGIN` when present, `Sec-Fetch-Site: cross-site` is refused.

Cookies today: name `poker_refresh` (`REFRESH_COOKIE_NAME`), `HttpOnly`, `Path=/api/auth`, `Secure` and `SameSite=Strict` in production, `SameSite=Lax` and not `Secure` in development.

The web app is Next.js 15.5 (`next@^15.5.3`), React 19, App Router. Pages: `/`, `/login`, `/table/[id]`, and the legal pages. `src/middleware.ts` sets a per-request CSP nonce. `src/app/layout.tsx` calls `connection()` so pages are not prerendered without a nonce, and loads `next/font/google` (`Outfit`, `Fraunces`) which are self-hosted at build time. `font-src 'self'` stays valid. The client uses `socket.io-client` through `src/lib/socket.ts`. Components call `getSocket`, `.on`, `.emit`, `.timeout().emitWithAck`. WP5 keeps that surface.

Lobby data is `GET /api/tables` from `src/app/page.tsx`. There is no lobby socket today. This program adds one.

## 3. Repository layout

```
apps/edge/                      @poker/edge  — API Worker + Durable Objects
  wrangler.jsonc
  package.json
  tsconfig.json
  prisma/schema.prisma          generator differs; models must match apps/server
  src/index.ts                  fetch entry: HTTP router or WebSocket upgrade
  src/env.ts
  src/db/client.ts
  src/db/game-command.ts
  src/http/                     Hono routes (WP2)
  src/table/                    TableActor (WP3)
  src/session/contract.ts       RPC signatures (WP1)
  src/session/user-sessions.ts  UserSessions DO (WP3)
  src/lobby/                    LobbyActor (WP4)
  src/auth/                     ported session/jwt/lockout logic (WP2)
  src/game/                     ported encryption, audit, seat/hand persist (WP3)
  test/
apps/web/                       unchanged UI; OpenNext wrapper + WS adapter
apps/server/                    Node reference until the retirement PR
packages/engine/                unchanged public API
packages/shared/src/protocol.ts wire types (WP1), re-exported from index.ts
```

`apps/edge` must not load the repo-root `.env`. Wrangler uses `apps/edge/.dev.vars` (gitignored) and `wrangler secret`. A checked-in `apps/edge/.dev.vars.example` lists keys with empty values.

`packages/engine` and `packages/shared` stay pure TypeScript with no Node built-ins. The Worker imports their built `dist` just as the server does (`npm run build:core` before the edge typecheck).

Copy behavior from `apps/server` into `apps/edge`. Do not move files out of `apps/server` in this program (that collides with agents still editing it). A later cleanup may extract a shared package once the Node process is retired.

### Schema parity

`apps/edge/prisma/schema.prisma` is a copy of `apps/server/prisma/schema.prisma` with a different `generator` block (section 6). WP1 adds a script `apps/edge/scripts/check-schema-parity.mjs` that fails if the models, enums, and fields differ. Migrations are applied only from `apps/server/prisma/migrations`. The edge schema has no `migrations` directory.

### `GameCommand` (WP1, additive)

New model and one new migration file. Do not edit existing migration SQL.

```prisma
model GameCommand {
  id              String   @id
  tableId         String
  userId          String?
  kind            String
  appliedRevision Int
  createdAt       DateTime @default(now())

  @@index([tableId, createdAt])
}
```

`id` formats (normative):

| Kind | id |
|---|---|
| Client seat / sit / stand / keep-alive | `cmd:` + the client UUID |
| Client action | `cmd:` + `clientActionId` |
| Turn timeout | `timer:` + tableId + `:` + `turnId` |
| Showdown clean-up (`completeHand`) | `showdown:` + tableId + `:` + handNumber |
| Deal (`startHand`) | `deal:` + tableId + `:` + the new handNumber |
| Idle close / empty close | `close:` + tableId + `:` + closeReason + `:` + revision that closed it |

The row is inserted in the **same** Postgres transaction as the bankroll change, seat update, hand insert, and `stateCiphertext` write. A unique conflict means this mutation already committed. The caller loads the checkpoint and returns success with `duplicate: true`. It does not apply the engine function again.

Runtime DB role: `INSERT` and `SELECT` on `GameCommand`. No `UPDATE` or `DELETE` (same posture as append-only hand history).

## 4. Wrangler

Replace `example.com` and every `<…>` id at deploy time. Do not commit real ids if they are account-private; ids are not secrets, but placeholders keep the repo deployable for any account.

Compatibility date `2026-10-01` or newer. From that line, `nodejs_compat` is already the default (dates on or after `2026-08-04`). Set the flag anyway so the file documents the dependency.

### 4.1 `apps/edge/wrangler.jsonc`

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "poker-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": false,
  "routes": [
    { "pattern": "example.com/api/*", "zone_name": "example.com" },
    { "pattern": "example.com/ws/*", "zone_name": "example.com" }
  ],
  "placement": { "region": "aws:eu-central-1" },
  "vars": {
    "CLIENT_ORIGIN": "https://example.com",
    "TERMS_VERSION": "2026-10-01",
    "JWT_ACCESS_TTL": "15m",
    "JWT_REFRESH_TTL": "7d",
    "SESSION_IDLE_TTL": "7d",
    "SESSION_ABSOLUTE_TTL": "30d",
    "DEFAULT_STARTING_BANKROLL": "10000",
    "TURN_TIME_BANK_MS": "20000",
    "TIME_BANK_INITIAL_MS": "30000",
    "TIME_BANK_MAX_MS": "60000",
    "TIME_BANK_REFILL_MS": "5000",
    "TIME_BANK_REFILL_EVERY_HANDS": "10",
    "ENABLE_LEGACY_BOTS": "false",
    "TURNSTILE_SITE_KEY": "",
    "TABLE_DO_LOCATION_HINT": "weur"
  },
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<HYPERDRIVE_ID_CACHE_DISABLED>",
      "localConnectionString": "postgresql://poker_app:replace-with-local-password@127.0.0.1:5432/poker"
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "TABLES", "class_name": "TableActor" },
      { "name": "LOBBY", "class_name": "LobbyActor" },
      { "name": "USER_SESSIONS", "class_name": "UserSessions" }
    ]
  },
  "exports": {
    "TableActor": { "type": "durable-object", "storage": "sqlite" },
    "LobbyActor": { "type": "durable-object", "storage": "sqlite" },
    "UserSessions": { "type": "durable-object", "storage": "sqlite" }
  },
  "ratelimits": [
    { "name": "RL_GENERAL", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } },
    { "name": "RL_CREDENTIALS", "namespace_id": "1002", "simple": { "limit": 15, "period": 60 } },
    { "name": "RL_REFRESH", "namespace_id": "1003", "simple": { "limit": 30, "period": 60 } },
    { "name": "RL_ADMIN", "namespace_id": "1004", "simple": { "limit": 30, "period": 60 } },
    { "name": "RL_WS", "namespace_id": "1005", "simple": { "limit": 30, "period": 60 } }
  ]
}
```

`placement.region` must be the region of the Neon primary (the example `aws:eu-central-1` is a placeholder). Every table mutation is several sequential queries; placement keeps the Worker near Hyperdrive's pool. Change the value to the real Neon region before the first deploy. `TABLE_DO_LOCATION_HINT` is a Durable Object location hint (`weur`, `eeur`, `enam`, `wnam`, …) passed to `getByName(id, { locationHint })` only when the DO is first created. Use the hint closest to that same region.

`namespace_id` values are account-wide. If `1001`–`1005` are already used, pick unused positive integers and keep them stable. Two bindings that share a namespace share counters.

Do **not** set `limits.cpu_ms`. The paid default is 30s, which covers bcrypt. Do not raise it to 5 minutes.

Preview (non-production Neon branch, its own Hyperdrive, no production routes):

```jsonc
"env": {
  "preview": {
    "name": "poker-api-preview",
    "workers_dev": true,
    "routes": [],
    "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<PREVIEW_HYPERDRIVE_ID_CACHE_DISABLED>", "localConnectionString": "postgresql://poker_app:replace-with-local-password@127.0.0.1:5432/poker" }],
    "vars": { "CLIENT_ORIGIN": "https://<preview-web-host>" }
  }
}
```

Preview inherits the other bindings unless overridden. Give preview its **own** DO namespaces by using the `preview` environment (Wrangler isolates env resources). Do not point preview Hyperdrive at the production Neon database.

### 4.2 Secrets (API Worker)

Set with `wrangler secret put <NAME>` from `apps/edge`. Never print the value. Never put these in `wrangler.jsonc`, `.dev.vars` committed files, or the repo-root `.env`.

| Secret | Purpose |
|---|---|
| `JWT_ACCESS_SECRET` | HS256 access tokens. ≥32 bytes, distinct from the refresh secret. |
| `JWT_REFRESH_SECRET` | HS256 refresh tokens. |
| `WS_TICKET_SECRET` | HS256 `poker_ws` tickets. Distinct from both JWT secrets. |
| `GAME_ENCRYPTION_KEYS` | Same ring format as today: `kid:hex64,kid:hex64`. |
| `GAME_ENCRYPTION_ACTIVE_KEY_ID` | Active `kid`. |
| `TURNSTILE_SECRET_KEY` | Siteverify secret. |

The database password lives only in the Hyperdrive configuration, not in a Worker secret. There is no `DATABASE_URL` secret on the Worker.

Local development puts the same names in `apps/edge/.dev.vars`. Hyperdrive local override:

```
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://poker_app:<POKER_APP_PASSWORD>@127.0.0.1:5432/poker
```

That variable overrides `localConnectionString` and must target the Docker Postgres from `docker-compose.yml` on `127.0.0.1`, using the `poker_app` password from `.env.compose` (see `docker-compose.yml`; there is no default password). Never the live Supabase URL and never a Neon production URL. The `localConnectionString` in `wrangler.jsonc` is a localhost placeholder with a non-secret password so `vitest` and `wrangler dev` can boot without a remote database. Replace it via the environment variable before any query. Caching does not apply locally.

### 4.3 `apps/web/wrangler.jsonc` (OpenNext)

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "poker-web",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": false,
  "routes": [
    { "pattern": "example.com/*", "zone_name": "example.com" }
  ],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  "vars": {
    "NEXT_PUBLIC_API_URL": "https://example.com",
    "NEXT_PUBLIC_SOCKET_URL": "https://example.com",
    "NEXT_PUBLIC_TURNSTILE_SITE_KEY": ""
  }
}
```

`example.com/api/*` and `example.com/ws/*` are more specific than `example.com/*`, so those requests never reach the web Worker. `NEXT_PUBLIC_*` values are inlined at **build** time. Production and preview need separate builds, or a single same-origin build where both public URLs are `https://example.com` (preferred). The client then calls relative `/api` when the public URL's origin equals the page origin. Keep absolute URLs working for `next dev` on port 3000 against `wrangler dev` on port 8787.

### 4.4 Hyperdrive setup (operator, not an agent)

1. Create a new Neon project. Do not reuse the Supabase instance.
2. Create the Hyperdrive config with caching off, aimed at Neon's **direct** hostname (no `-pooler` in the host). Hyperdrive is already a transaction-mode pooler. A second pooler in front breaks session affinity for interactive transactions.

```sh
npx wrangler hyperdrive create poker-neon --connection-string="postgres://…@ep-….region.aws.neon.tech/poker?sslmode=require" --caching-disabled
```

3. Migrations use `DIRECT_URL` (that same Neon direct URL with `sslmode=require`) from a GitHub secret, via `apps/server`:

```sh
npm run prisma:migrate -w @poker/server
```

which is `prisma migrate deploy`. Never `migrate dev`, `db push`, or `migrate reset` against Neon. Never run migrate with the repo-root `.env` still pointing at Supabase.

4. Runtime queries use `env.HYPERDRIVE.connectionString` only.

## 5. HTTP API

Router: [Hono](https://hono.dev/) 4.x. The Worker receives the full path (`/api/...`, `/ws/...`). Mount routes on those paths. Do not strip `/api` in a way that changes cookie `Path=/api/auth`.

### 5.1 Middleware order

Match `createApp` in `apps/server/src/app.ts`:

1. Request id, then structured logs (no passwords, no tokens, no cookie values, no ciphertext).
2. Admin access log for `/api/admin` (method, path, `cf-connecting-ip`, user id once known, status), including 401/403/429.
3. `Cache-Control: no-store` on every `/api` response except `GET /api/tables`, which is `Cache-Control: private, no-cache` and `Vary: Authorization`. Do not add an ETag. The current handler does not implement conditional GET.
4. Rate limit **before** reading the body (section 10.3).
5. CSRF / origin guard, ported from `apps/server/src/security/request-guard.ts`. `CLIENT_ORIGIN` in production is `https://example.com`.
6. JSON body, maximum 32kb. Malformed JSON → 400. Oversize → 413. Wrong type → 415. Log only the failure class, never the body.
7. Routes.

Cloudflare terminates TLS and sets `cf-connecting-ip`. Use that header as the client IP for lockout, session rows, and rate-limit keys. Do not trust `X-Forwarded-For`. Drop the Express 426 "HTTPS required" check. HSTS is set by the web Worker (existing `next.config.ts` header).

CORS: in production the page and the API are the same origin, so browser calls are same-origin and do not need `Access-Control-Allow-Origin`. Still reject a foreign `Origin` on state-changing requests. In local dev (`http://localhost:3000` → `http://127.0.0.1:8787`), reflect `CLIENT_ORIGIN` and allow credentials, and use `SameSite=Lax` without `Secure`, matching today's dev cookies.

Errors: `EngineError` → 409 and `{ error: message }` as today. Auth credential failures stay 401 with the same bodies (`Invalid credentials`, `Unauthorized`, `Invalid refresh session`). Database failures on auth routes stay 503 `{ error, retryable: true }` with `Retry-After: 2` and **must not clear the refresh cookie** except when the failure is an `AuthError`.

### 5.2 Route table

| Method | Path | Auth | Hono | Notes |
|---|---|---|---|---|
| GET | `/api/health` | none | `src/health.ts` | `{ ok, service: "poker-edge", timestamp }`. No database. `redis` field omitted. |
| GET | `/api/ready` | none | `src/health.ts` | `SELECT 1` through Hyperdrive. 200 `{ ready: true }` or 503 `{ ready: false, reasons }`. |
| POST | `/api/auth/register` | Turnstile + credential limit | `http/auth.ts` | Port `auth/routes.ts`. 201 `{ user, accessToken }` + `Set-Cookie`. |
| POST | `/api/auth/login` | Turnstile + credential limit | `http/auth.ts` | Same dummy-bcrypt and lockout behavior. |
| POST | `/api/auth/guest` | Turnstile + credential limit | `http/auth.ts` | |
| POST | `/api/auth/refresh` | refresh cookie + refresh limit | `http/auth.ts` | Rotation and reuse detection unchanged. |
| POST | `/api/auth/logout` | cookie optional | `http/auth.ts` | Revoke row, clear cookie, 204, then `UserSessions.revoke`. |
| GET | `/api/auth/sessions` | Bearer | `http/auth.ts` | Coarse IP display unchanged. |
| DELETE | `/api/auth/sessions/:id` | Bearer | `http/auth.ts` | 404 if not owned. Revoke + fanout. |
| POST | `/api/auth/logout-all` | Bearer | `http/auth.ts` | `{ exceptCurrent?: true }`. |
| GET | `/api/auth/me` | Bearer | `http/auth.ts` | |
| GET | `/api/tables` | Bearer | `http/tables.ts` | Same query as `routes/tables.ts` (open, not private, no bot seats, limit 50, plus the caller's seat if older). |
| GET | `/api/tables/:id` | Bearer | `http/tables.ts` | 404 for unknown and for private tables the caller is not in. |
| GET | `/api/tables/:id/hands/:handNumber/audit` | Bearer | `http/tables.ts` | Participant audit. Fail closed. Port `game/audit.ts` usage, not the rules. |
| POST | `/api/tables` | Bearer | `http/tables.ts` | Creates the row, seats the host, debits bankroll, then RPC `TableActor.track` so the idle alarm starts. |
| GET | `/api/admin/hands/:handUuid/audit` | Bearer + DB role `ADMIN` + Cloudflare Access | `http/admin.ts` | Full sealed record. See section 10.5. |
| POST | `/api/ws-ticket` | Bearer + general limit | `http/ws-ticket.ts` | Sets `poker_ws`. Empty 204 body. |

There is no other Express route. Do not add payment routes.

`POST /api/tables` today calls `tableManager.track` after commit. The edge equivalent is `env.TABLES.getByName(id, { locationHint }).track()`, which arms the idle alarm. If that RPC fails, the table row still exists; the next viewer or a ready-check alarm must arm it. Log the failure. Do not fail the HTTP create (same as today).

### 5.3 Cookies

| Cookie | Path | Max-Age | Flags in production |
|---|---|---|---|
| `poker_refresh` | `/api/auth` | until `Session.expiresAt` | `HttpOnly; Secure; SameSite=Strict` |
| `poker_ws` | `/ws` | 60 | `HttpOnly; Secure; SameSite=Strict` |

Development (`wrangler dev` on http): `SameSite=Lax`, omit `Secure`.

`poker_ws` value is a compact JWS (`jose`, HS256, `WS_TICKET_SECRET`):

```ts
{ sub: userId, sid: sessionId, username: string, typ: "ws", exp, iss: "poker-server", aud: "poker-ws" }
```

`exp` is 60 seconds from issue. The ticket is not stored. Replay inside 60 seconds only helps someone who already has the cookie. The DO still loads the session row and rejects a revoked session.

Clear `poker_refresh` with `Set-Cookie` `Max-Age=0` and the same `Path`. Do not set a domain attribute (host-only).

### 5.4 Access tokens

`jose` `SignJWT` / `jwtVerify`. HS256. Preserve claims so existing clients and the Node server's tokens are the same shape during any overlap (there should be no overlap of writers; the shape match is so tests and the web client stay valid):

- Access: `sub`, `sid`, `username`, `typ: "access"`, `iss: "poker-server"`, `aud: "poker-client"`, `jti` (UUID), `exp` from `JWT_ACCESS_TTL`.
- Refresh: `sub`, `sid`, `typ: "refresh"`, same iss/aud, `jti`, `exp` = `floor(session.expiresAt / 1000)`.

Do not bundle `jsonwebtoken`. It works under `nodejs_compat` but pulls Node-specific paths the edge port does not need. `node:crypto` is available for the hash and the cipher (section 10.1) and is what the ported key ring should call.

Bearer parsing: `Authorization: Bearer`, token length 1–4096. `authenticate()` checks the signature, then the session row (revoked, idle expiry, absolute expiry, `kind === "HUMAN"`). A database error propagates as 503, not 401.

### 5.5 Config object

Build one `EdgeConfig` from `env` bindings and secrets at the start of the handler. Validate with zod the same ranges `apps/server/src/config.ts` enforces (TTL bounds, time-bank ordering, terms version length). Fail the request with 500 and a log line if a secret is missing. Do not fall through to a default secret.

## 6. Database access

### 6.1 Generator

`apps/edge/prisma/schema.prisma`:

```prisma
generator client {
  provider   = "prisma-client"
  output     = "../src/generated/prisma"
  runtime    = "cloudflare"
  engineType = "client"
  moduleFormat = "esm"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

`runtime = "cloudflare"` is the documented alias of `workerd`. `engineType = "client"` keeps the Rust query engine out of the bundle. `prisma-client-js` is deprecated and is the wrong generator for Workers.

`apps/server` keeps `provider = "prisma-client-js"`. Do not change it in this program.

Pin `prisma` and `@prisma/client` to `6.16.1` (the version already in `apps/server`) and `@prisma/adapter-pg` to the matching 6.16 release. `pg` `8.23.x` (already used in `apps/server`). If `prisma@6.16.1` rejects `runtime = "cloudflare"`, set `runtime = "workerd"`. If it rejects the `prisma-client` generator entirely, bump **only** `apps/edge` to the newest Prisma 6 patch that accepts it. Do not move to Prisma 7: v7 relocates the datasource URL into `prisma.config.ts` and would fork migrate tooling away from `apps/server`.

Do not set `previewFeatures = ["driverAdapters"]`. That flag belonged to `prisma-client-js`. The `prisma-client` generator uses driver adapters directly.

Generate:

```sh
npm run prisma:generate -w @poker/edge
```

The script sets `DATABASE_URL` to a dummy `postgres://127.0.0.1:5432/postgres` if unset, because generate does not connect, but the schema still references `env("DATABASE_URL")`. Gitignore `apps/edge/src/generated/`.

Import:

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export function createPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
```

Call `createPrisma(env.HYPERDRIVE.connectionString)` inside `fetch`, inside each DO event that touches Postgres, and inside `alarm()`. Do not store the client on `globalThis`. A client kept on `this` inside a DO dies on hibernation, which is correct; the next event constructs a new one. After the Worker responds, `ctx.waitUntil(prisma.$disconnect())`. Inside a DO, `await prisma.$disconnect()` at the end of the event.

`GET /api/health` must not import `pg`. The Workers Vitest evaluator (Vite) loads `pg/lib/connection.js` as CommonJS and throws `Cannot use import statement outside a module` if that module is in the static graph of the fetch handler. `src/health.ts` therefore dynamic-imports `createPrisma` only from `GET /api/ready`. `wrangler deploy` bundles `pg` with esbuild, which is the path Hyperdrive documents; the failure is the test evaluator, not workerd.

Hyperdrive's own guidance is the same: create the client inside the handler, not in global scope. A global `pg` pool pins connections incorrectly across isolate reuse.

### 6.2 Transactions and `FOR UPDATE`

Port `TableManager.mutate`'s transaction shape:

```ts
await prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM "Table" WHERE id = ${tableId} FOR UPDATE`;
  // GameCommand insert, bankroll updateMany, seats, hand insert, ciphertext update
}, { maxWait: 10_000, timeout: 20_000 });
```

This is valid on Hyperdrive because the pooler is in transaction mode: one client connection is held from `BEGIN` until `COMMIT`/`ROLLBACK`, then `RESET` and returned to the pool. `SELECT FOR UPDATE` and the later writes in that callback see the same connection. Named prepared statements from `node-postgres` (what `@prisma/adapter-pg` uses) are supported. Do not set a PgBouncer-style "disable prepared statements" workaround. Do not issue `SET` outside the transaction and expect it to stick.

Keep the transaction short. Bcrypt stays on the auth routes, never inside a table transaction. Audit verification that is pure CPU may stay inside the transaction only where today's `persistHand` already calls it; do not add new remote calls inside the transaction.

### 6.3 Caching

Create the Hyperdrive config with `--caching-disabled`. Default caching stores `SELECT` results for up to 60 seconds and does not drop them when a later write commits. That would serve a revoked session, a stale bankroll, or a stale seat. One cache-disabled binding is enough. There is no high-volume public read on this API that can tolerate a stale window. The lobby list is per-user (`isSeated`) and small.

### 6.4 What is authoritative

| Data | Authority | Hot copy |
|---|---|---|
| `User.bankroll` | Postgres | none |
| `TableSeat` rows | Postgres, written from the engine state in the same transaction | DO memory after load |
| `Hand`, `HandPlayer`, `HandAction`, `HandPot`, sealed audit | Postgres, append-only, written when phase first becomes `SHOWDOWN` for that hand number | none |
| `Session` and login lockout columns | Postgres | none across requests |
| In-progress engine state (hole cards, turn, pots, revision) | The committed pair (DO SQLite blob **and** `Table.stateCiphertext`) at the same revision | DO memory until hibernation |
| WebSocket membership, per-connection rate bucket, pending outbox | DO SQLite | DO memory |
| Who to notify on revoke | `UserSessions` DO SQLite | — |

Postgres wins for money. A chip move that is not in a committed Postgres transaction did not happen. The DO must not broadcast a snapshot whose revision is not yet in `Table.stateCiphertext`.

DO SQLite wins only as the place that remembers an in-flight **outbox** (section 8.4) across hibernation. After a crash, recovery prefers the committed Postgres checkpoint when the outbox row is still `pending` and the `GameCommand` row exists.

Divergence rule: if the DO blob's revision and the Postgres checkpoint revision differ **and** there is no `pending` outbox that explains the gap, write a `TableIncident` (`kind: STATE_DIVERGENCE`), set the table `PAUSED`, and refuse further mutations with a retryable error. Do not pick a winner by timestamp. Do not redeal.

Cold start (DO storage has no blob):

- Postgres ciphertext present → decrypt, store in DO SQLite, arm alarm.
- No ciphertext, no hand rows, status not `IN_HAND` → build from seats via `createTable` + `sitDown`, same as `TableManager.load`.
- Otherwise → `RECOVERY_REQUIRED`, pause, do not deal.

`stateCiphertext` remains the disaster-recovery copy if the DO namespace is deleted. Operators restore by leaving the DO empty and letting cold start read Postgres. Do not delete DO storage as a routine deploy step. SQLite-backed DO storage also has point-in-time recovery for 30 days; that restores the ciphertext blob, not plaintext cards, because the blob stays encrypted.

## 7. Encryption at rest

Keep the key ring (`apps/server/src/security/key-ring.ts` behavior, copied into `apps/edge`). New ciphertexts are `v2.<kid>.…`. Decrypt both `v1.` (legacy `k0`) and `v2.`. Contexts:

- Engine state: `table:${tableId}`
- Sealed hand audit: existing `sealedAuditContext(tableId, handNumber)`
- Hole cards on `HandPlayer.encryptedHoleCards`: existing per-seat context

`node:crypto` `createCipheriv` / `createDecipheriv` with `aes-256-gcm`, `createHash('sha256')`, `randomBytes`, and `randomUUID` are part of the Workers `node:crypto` implementation (full API except the documented gaps: no DSA/DH `generateKeyPair`, no `argon2`, no `ed448`/`x448`). Use them. Do not reimplement GCM.

Durable Object storage is encrypted at rest by Cloudflare. That stops a disk theft. It does not stop a SQL reader, a Neon backup, a DO storage export, or a log of decrypted JSON. The threat model that produced `stateCiphertext` still applies, and Postgres still stores the checkpoint. Store the **same ciphertext** in the DO meta row. Never `console.log` plaintext state.

## 8. Realtime

Read [PROTOCOL.md](./PROTOCOL.md) for frames. This section is the server behavior.

### 8.1 Upgrade path

`GET /ws/table/:id` and `GET /ws/lobby` with `Upgrade: websocket`.

1. `RL_WS.limit({ key: "ip:" + cf-connecting-ip })`. On failure, 429, do not create a DO.
2. Read cookie `poker_ws`. Verify the JWS (`typ === "ws"`, iss, aud, exp). Missing or bad → 401, do not call `acceptWebSocket`.
3. Table ids: string length 1–128, charset of the existing cuid ids. Lobby has no id.
4. Forward the original `Request` to the DO:

```ts
const stub = env.TABLES.getByName(tableId, { locationHint: env.TABLE_DO_LOCATION_HINT });
return stub.fetch(request);
```

Lobby: `env.LOBBY.getByName("lobby").fetch(request)`.

The DO verifies the cookie **again**. Do not trust an internal header injected by the Worker. The client cannot add a header on a browser `WebSocket`, so the cookie is the only credential on the upgrade.

Then `acceptWebSocket(server, ["user:" + userId, "session:" + sessionId])`. Tags are limited to 10 per socket and 256 characters. Those two tags are enough for `getWebSockets(tag)`.

`serializeAttachment` (16,384 byte cap) stores only:

```ts
{ userId, sessionId, username, connectedAt }
```

Not the access token, not the ticket, not cards.

On accept, load the session row once. If it is revoked or expired, close with `4001` and do not join. Register with `UserSessions` (section 8.6). Emit `AUTH_OK` (include `idleNotice` when this user is seated and a warning is active).

`setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` so a keepalive text frame `ping` does not wake application code. The client sends that literal. Protocol-level ping frames are not available to browser JS.

Hibernation: the constructor only runs `blockConcurrencyWhile` to `CREATE TABLE IF NOT EXISTS` the DO schema (below). It does not decrypt the table and it does not call `setAlarm` if `getAlarm()` is already set. The first message, RPC, or alarm lazy-loads state. In-memory fields are gone after hibernation; attachments and SQLite are not.

With compatibility date `2026-10-01`, `web_socket_auto_reply_to_close` is on. `webSocketClose` may still call `ws.close(code, reason)`. Unregister the connection from `UserSessions` there.

### 8.2 Why a ticket cookie

| Option | Why it is not the choice |
|---|---|
| Access token in the query string | Cloudflare logs, browser history, and `Referer` can retain it. Forbidden. |
| `Sec-WebSocket-Protocol` | Some intermediaries log the protocol list. A JWT is a poor subprotocol and can exceed practical header budgets. |
| First message after `acceptWebSocket` | The socket is already attached. A flood of unauthenticated sockets occupies DO connection slots until something closes them. Hibernation cannot be switched on after `ws.accept()`. |
| Ticket cookie, `Path=/ws`, 60s, HttpOnly | The upgrade is rejected before `acceptWebSocket`. The ticket is not in the URL. Same-origin `SameSite=Strict` means a foreign site cannot open the socket. |

The long-lived socket does not re-send the cookie. `SESSION_RENEW` carries the new access token in the frame body (same as today's event) and is checked with `authenticate()`. A mismatch of `sub` closes the socket (`4002`) and logs `SESSION_RENEW_USER_MISMATCH`.

### 8.3 TableActor

Class `TableActor extends DurableObject<Env>`. DO name = Postgres table id.

SQLite (application SQL, not Wrangler):

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

`meta` keys: `engine` (ciphertext), `revision` (decimal string). `commands.result` is the JSON `CommandResult` for that client command. `outbox.payload` is the ciphertext to commit and a JSON description of the bankroll deltas (user id, signed chip delta). No plaintext cards in `outbox` or `commands`.

**Concurrency.** A Durable Object is one JavaScript thread, but two `await`s interleave. Every mutation, snapshot broadcast, alarm handling, and outbox drain runs inside `this.ctx.blockConcurrencyWhile` so a second action cannot observe a half-applied wallet. Do not hand-roll a promise queue and also use the input gate; use the gate.

Responsibilities, all ported from `TableManager` + `socket/index.ts`:

- `track()`: cold-start load and arm the idle alarm. Used by `POST /api/tables`.
- `webSocketMessage`: the PROTOCOL frames.
- Join: same visibility rule as `checkTable` (unknown and private-not-member → `TABLE_NOT_FOUND`; `CLOSED` → `TABLE_CLOSED` after the membership check so outsiders cannot probe private ids).
- Leave: drop this socket from the table fanout. Do not change the seat.
- Seat claim, sit in/out, stand, keep-alive, action: the same engine calls (`sitDown`, `sitIn`, `sitOut`, `leaveSeat`, `keepTableOpen`, `applyAction`, `recordActivity`).
- `intent` uses `turnId` the way `TableManager.intent` does. `STALE_ACTION` also pushes a fresh snapshot to that socket.
- Disconnect does not sit the player out and does not count as activity (today's `onDisconnect`).
- Snapshot: `projectTableState` / the leak guard. On `LEAK_BLOCKED`, log and send nothing to that viewer. Each socket gets its own projection. Spectators (authenticated, allowed to see the table, no seat) get `holeCards: null` except showdown reveals the engine already exposes. Cap viewers at 64 sockets per table; the 65th gets `TABLE_FULL` and a close `4003`. The platform cap is 32,768; 64 is the product cap.
- After a committed mutation, broadcast. Delivery failure does not roll back. Reconnect sends a full snapshot (the client already ignores `revision` going backwards).
- `tryStart` after a successful seat or sit-in, and from the alarm when the phase is `WAITING` or `COMPLETE` and `readyToDeal`. A failed deal must not undo a committed seat (today's CR-017: ack the claim before `tryStart`).
- Hand history lines: send `HAND_HISTORY_LOG` for new log entries after commit, and include `logTail` on the snapshot so a reconnect does not need a replay.
- User patches: `USER_PATCH` to every socket of that user on this table, and RPC `UserSessions.notify` so the lobby socket gets it too.
- Idle notices: same start/stop rules as `idleNotices`, delivered on the table sockets and via `UserSessions`.

Rate limit inside the DO (exact, not the binding):

- 20 frames per 2s per connection (sliding window stored on the attachment is too small to update correctly; store `{ t, n }` in SQLite key `rate:<sessionId>` or in memory and accept reset on hibernation — **store in SQLite** so hibernation does not refresh the budget).
- 8 action frames per 2s per user (`ACTION_INTENT`, and the other mutating client frames), matching `allowAction`.
- Exceeding either → `RATE_LIMITED`, no state change.

`commands` rows older than 24h may be deleted by the alarm. `GameCommand` in Postgres is not deleted.

### 8.4 Outbox and idempotency

Normative sequence for every mutation that can move chips or write a hand. Pure no-ops (sit toggle that does not change state) skip the outbox.

1. Enter `blockConcurrencyWhile`.
2. Load the engine (section 6.4 cold start).
3. If the client command id is in DO `commands`, return that result and stop.
4. If it is in Postgres `GameCommand`, adopt the Postgres ciphertext if its revision is newer, store the ack `{ ok: true, duplicate: true }`, broadcast nothing new, return.
5. Run the pure engine function in memory. On `EngineError`, return it. Do not write.
6. DO SQL transaction: insert `outbox` (`pending`) with the command id, the next ciphertext, the intended revision (`current + 1`), and the chip deltas.
7. Postgres transaction (section 6.2):
   - Lock the table row.
   - If `GameCommand.id` already exists, stop (another attempt committed).
   - Apply bankroll `updateMany` exactly as `mutate` does today (human cash-out must update 1 row; bots credit nothing; seat claim debits only if `bankroll >= buyIn`).
   - `persistSeats`, `persistHand` when entering `SHOWDOWN` for that hand number, update `Table.status`, `stateCiphertext`, `closedAt` / pause columns.
   - Insert `GameCommand`.
8. On Postgres success: DO SQL transaction sets `outbox.status = 'committed'`, writes `meta.engine` and `meta.revision`, inserts `commands`. Then arm the alarm, then broadcast and send wallet patches.
9. On a **definitive** refusal (bankroll, seat taken, engine error discovered under the lock): mark outbox `aborted`, return the error, do not broadcast.
10. On a **transient** Postgres error: leave `pending`, return `SERVICE_UNAVAILABLE` / `retryable: true`, arm an alarm ~1s out to run step 7 again with the same payload. Do not re-run the engine function.

Crash after step 7 and before step 8: the next event sees `pending` plus an existing `GameCommand` and performs step 4/8 without a second debit.

Crash after step 6 and before step 7: the alarm retries step 7.

The next hand is not dealt until the showdown mutation's Postgres transaction has committed. `completeHand` (purge secrets, pay leavers) is its own mutation, 3200ms after `settledAt`, then `tryStart` is a separate mutation. A failed deal must not roll back the clean-up. This is today's `armTimers` showdown branch.

Client retries reuse `commandId` / `clientActionId`. The server returns the original ack.

### 8.5 Alarms

One alarm per DO. Store the next deadline only via `setAlarm`. On each committed state:

| Condition | Fire at |
|---|---|
| Phase `SHOWDOWN` | `settledAt + 3200` |
| Actor to act | `turnDeadline(table)` (base time + personal time bank, same engine helper) |
| Legacy bot and `ENABLE_LEGACY_BOTS` | the same bot-delay calculation as `armTimers` |
| Phase `WAITING` or `COMPLETE` and `readyToDeal` | `now + 100` |
| Idle, no warning yet | `idleSince + TABLE_IDLE_TIMEOUT_MS` (5 min) |
| Warning active | `closingAt` (`TABLE_IDLE_WARNING_MS` = 30s) |
| Outbox `pending` | `now + 1000` |

Pick the earliest. `alarm()` runs due work, then schedules the next. Catch errors, log, `setAlarm(now + 2000)`, and return. Do not rely on the platform's 6 automatic retries; a long Neon outage would otherwise leave the table without a clock. Turn timeouts that fire late still call `applyTimeout` (the turn ended). Idle **close** that fires more than 5 seconds after `closingAt` does not close: clear the warning, start a fresh idle timeout, log `IDLE_ALARM_LATE`. That preserves today's rule that downtime is not player inactivity. Hibernation itself is not downtime; an idle table keeps counting while the DO is evicted, because `lastActivityAt` is inside the encrypted state.

`alarm()` wall time limit is 15 minutes. A single hand commit is far under that. Do not loop all tables inside one table's alarm.

### 8.6 UserSessions DO

Name = `userId`. SQLite table:

```sql
CREATE TABLE IF NOT EXISTS conns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  target TEXT NOT NULL, -- "table:<id>" or "lobby"
  created_at INTEGER NOT NULL
);
```

RPC (plain structured-clone values, no class instances):

- `register({ sessionId, target, connId })`
- `unregister({ connId })`
- `revoke({ sessionId, reason })` → for each matching conn, RPC the `TableActor` or `LobbyActor` `disconnectSession(sessionId, reason)` which sends `SESSION_REVOKED` and closes those sockets (`4001`)
- `notify({ sessionId or user-wide, event, payload })` → forward `USER_PATCH` and `TABLE_IDLE_NOTICE` to the lobby connection and any table connection

Logout, logout-all, refresh reuse, and admin-style session delete call `revoke` **after** the Postgres `revokedAt` commit. If the RPC fails, the next mutating frame on the table still re-reads the session row and disconnects. Document that revoke is best-effort plus the synchronous re-check.

Do not put a global session cache in Workers KV.

### 8.7 LobbyActor

Name `lobby`. Sockets are authenticated the same way. It does not own table state.

- On connect: send `LOBBY_SNAPSHOT` built from the same query as `GET /api/tables` for this user.
- `TableActor`, after a committed mutation that changes occupancy, status, or blinds, RPC `lobby.patch(entry)` with a `TableListItem` plus `removed: true` when the table leaves the public list.
- The lobby DO fans that patch out to sockets. Each socket filters `isSeated` using the attachment's `userId` and a seat-user list on the patch (`seatedUserIds`), which the table DO includes and the client **strips** before it hits React state. The wire type in PROTOCOL.md includes `seatedUserIds` only on the server-internal RPC, not on the client frame. The client frame's `isSeated` is computed per socket inside the lobby DO.
- Keep-alive from a player who is on the home page: the client sends `TABLE_KEEP_ALIVE` on the **lobby** socket. The lobby DO checks the session and RPCs `TableActor.keepAlive(userId)`. The table page sends it on the table socket instead. Both are valid. Idempotent.
- Lobby DO does not run the game and does not hold ciphertext.

The home page keeps working with `GET /api/tables` alone if the lobby socket is down.

#### WP4 notes

Recorded with the lobby implementation. These are the wire and RPC choices WP3 and WP2 need; they do not change poker rules.

- `AUTH_OK` is sent on a successful upgrade. `LOBBY_SNAPSHOT` is the reply to `LOBBY_HELLO` (PROTOCOL.md), including on reconnect. Section 8.7's "on connect" is that handshake.
- `LOBBY_PATCH.removed` is decided per socket. `removed: true` drops the table for a viewer who is not in `seatedUserIds`. A viewer who is in `seatedUserIds` keeps the row unless `table.status` is `CLOSED`, so the active-seat inclusion on `GET /api/tables` (private, bot, or older than the newest 50) stays intact. The client frame lists `isSeated` and does not include `seatedUserIds`.
- Inbound lobby frames are `LOBBY_HELLO`, `TABLE_KEEP_ALIVE`, and `SESSION_RENEW`. Other client types, including `TABLE_JOIN`, are `UNKNOWN_TYPE`. The 20-frame / 2-second connection budget from section 8.3 is stored in the lobby DO's SQLite so a snapshot flood cannot pin this single object. `ping` / `pong` stay on the auto-response pair.
- `AUTH_OK.idleNotice` prefers `TableActor.currentIdleNotice` when the user has a seat. A null or a failed RPC leaves the last notice this lobby delivered (`closingAt = receivedAt + closingInMs`). Once `closingAt` is no longer in the future, the field is `null` rather than `closingInMs: 0`. The lobby does not decrypt ciphertext.
- `disconnectSession` matches `attachment.sessionId`. Hibernation tags cannot be rewritten after `SESSION_RENEW`, so a stale `session:` tag is not used to close a socket that has already moved to a new session.
- A spectator's `TABLE_KEEP_ALIVE` is refused with `NOT_SEATED` from the Postgres seat row (human, this table, status not `EMPTY`) and does not call `TableActor`. A seated human's keep-alive is forwarded. `pendingLeave` is enforced when that RPC runs; a `NOT_SEATED` error from it is forwarded on the ack.
- `UserSessions.register` / `unregister` failures are logged and do not refuse the lobby socket. Revoke stays best-effort plus the session re-read on `TABLE_KEEP_ALIVE` and `SESSION_RENEW`, as in section 8.6.

`apps/edge/src/session/contract.ts` already has the methods this object calls (WP3). No further contract edit is required. `UserSessions.notify` chooses the recipients. `LobbyActor.deliver` only writes `USER_PATCH` and `TABLE_IDLE_NOTICE` onto matching lobby sockets. `SESSION_REVOKED` stays on `disconnectSession` (close `4001`).

- `LobbyActorRpc.deliver` matches `SessionDelivery` (`USER_PATCH` | `TABLE_IDLE_NOTICE`).
- `TableActorRpc.keepAlive(userId, commandId?)` resolves `{ ok: true, duplicate? }` or rejects with `error.code` (`NOT_SEATED`, `TABLE_CLOSING`, `TABLE_CLOSED`, `TABLE_NOT_FOUND`). The lobby forwards `duplicate` on the ack.
- `TableActorRpc.currentIdleNotice(userId)` supplies `AUTH_OK.idleNotice` for a seated user. The lobby does not read engine state itself.

### 8.8 Spectators

Allowed, matching today: any authenticated user who passes `checkTable` may watch. They do not occupy a seat, do not receive other players' hole cards, and do not reset the idle clock by watching. `TABLE_KEEP_ALIVE` from a spectator is refused with `NOT_SEATED` (engine `keepTableOpen`).

### 8.9 Chat

Deferred. Do not add a chat table, a chat frame, or moderation tooling. A follow-up spec would need length caps, per-user rate limits, no HTML, and a decision on retention. Until then, clients must ignore unknown frame types.

## 9. Frontend

### 9.1 Transport (WP5)

Replace the body of `apps/web/src/lib/socket.ts`. Keep the exports and the behavior the hooks already use:

- `getSocket(accessToken)`, `currentSocket()`, `disconnectSocket()`, `renewSocketSession(token)`, `resumeSocket()`
- One socket per signed-in user for the table connection
- Events: `connect`, `connect_error`, `disconnect`, plus `SOCKET_EVENTS.*`
- `emit(event, payload, ack?)` and `timeout(ms).emitWithAck(event, payload)`
- `SOCKET_EVENTS.SESSION_RENEW` still updates the token without tearing down the table

Implementation: a small class in `apps/web/src/lib/ws-client.ts` that speaks PROTOCOL.md. Map `SOCKET_EVENTS` names to frame `type` strings one-for-one (they are already the right strings).

Reconnect: on unexpected close, backoff 500ms, 1s, 2s, 4s, 8s, cap 15s, full jitter, reset on a successful `AUTH_OK`. Before each reconnect, `POST /api/ws-ticket` with the current access token (refresh first if needed, using the existing `refreshSession()`). Then `new WebSocket((NEXT_PUBLIC_SOCKET_URL origin) + "/ws/table/" + tableId)` or `/ws/lobby`. Do not append the token.

The table hook stays logically the same: on connect, emit `TABLE_JOIN`; ignore stale revisions; verify cards before showing them; retry join on a retryable error. WP5 should not need to edit the hook if the adapter emits the same events. If a hook edit is unavoidable, it is limited to `use-table-socket.ts` and must keep the verification queue.

Add `useLobbySocket` only if the adapter cannot multiplex. Preferred shape: `getSocket` opens `/ws/lobby` for the signed-in app shell (auth hydrator, idle notice, wallet), and `joinTable(tableId)` opens or reuses `/ws/table/:id`. Two connections. The hydrator listens on the lobby socket for `USER_PATCH`, `TABLE_IDLE_NOTICE`, `AUTH_OK`, `SESSION_REVOKED`. The table hook listens on the table socket for snapshots and errors. Duplicate `USER_PATCH` on both sockets is allowed; applying the same bankroll twice is harmless. If `walletVersion` is present, ignore a lower version (the field is already optional and the server may omit it).

`TABLE_LEAVE` on unmount of the table page, matching today. Do not close the lobby socket on table unmount.

### 9.2 Deployment (WP6)

Use `@opennextjs/cloudflare`, not vinext, for the reason in section 1.

```sh
npm i @opennextjs/cloudflare@latest -w @poker/web
npm i -D wrangler@latest -w @poker/web
```

`apps/web/open-next.config.ts`:

```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
export default defineCloudflareConfig();
```

Scripts: `preview` = `opennextjs-cloudflare build && opennextjs-cloudflare preview`, `deploy` = build && deploy, `cf-typegen` = `wrangler types`.

`npm run dev` stays `next dev` for day-to-day UI work. Preview with OpenNext before calling the web Worker done.

Middleware stays on the Edge-compatible path. It uses `crypto.getRandomValues` and `NextResponse`. Do not switch it to the Node.js middleware runtime (Next 15.2+), which the OpenNext adapter does not support. Keep `connection()` in the root layout so nonce CSP and dynamic rendering stay intact. `next/font/google` stays; fonts are fetched on the build machine, not at the edge.

CSP changes in `contentSecurityPolicy` (section 10.2).

Turnstile widget: new `apps/web/src/components/turnstile-widget.tsx`. `login/page.tsx` (register and login) and the guest call on `page.tsx` send `turnstileToken` in the JSON body. Site key: `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. The widget script is `https://challenges.cloudflare.com/turnstile/v0/api.js` with the CSP nonce (`strict-dynamic` propagates it if the script tag carries the nonce). Do not enable Turnstile pre-clearance.

Local dummy keys (no siteverify round trip): site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` (always passes) and site `2x00000000000000000000AB`, secret `2x0000000000000000000000000000000AA` (always blocks). Use the pass pair in local `.dev.vars` and Playwright.

### 9.3 vinext follow-up (not this program)

Cloudflare recommends vinext for new Next apps and documents `vinext init` for Next.js 16. This app is 15.5.3. A later change may run `npx vinext check` in `apps/web`. Switch only if that check passes for App Router, `middleware.ts` nonces, `next/font/google`, and `connection()`, without a Next 16 upgrade. Until then OpenNext is the deployment path.

## 10. Security

### 10.1 Runtime crypto and CPU

Workers Paid is required. Free-plan CPU is 10ms per request. Paid default is 30s (raisable to 5 minutes; do not raise it). bcryptjs cost 12 is on the order of a few hundred milliseconds of CPU and fits. It is also a DoS lever: the credential rate limit and the account lockout stay. Never bcrypt inside a Durable Object (it would stall the table).

`node:crypto` is the right tool for SHA-256 refresh hashes, AES-256-GCM, and UUIDs. `argon2` is **not** implemented in workerd; do not switch the password hash in this program.

### 10.2 CSP

Extend `apps/web/src/middleware.ts`:

- `script-src` keeps `'self'`, the nonce, and `'strict-dynamic'`. Add `https://challenges.cloudflare.com` for Turnstile. Nonce + `strict-dynamic` is Cloudflare's preferred Turnstile CSP; the host allow is the fallback the Turnstile docs also list.
- `frame-src https://challenges.cloudflare.com` (the widget iframe). Today there is no `frame-src`; adding one replaces the `default-src` fallback.
- `connect-src` keeps `'self'` plus the configured API/socket origins and their `ws:`/`wss:` forms. Same-origin production means `'self'` already allows `wss://example.com`. Still add the explicit `wss:` origin derived from `NEXT_PUBLIC_SOCKET_URL` so a split-host preview does not break. Add `https://challenges.cloudflare.com` only if the chosen widget mode fetches it; the standard widget needs `script-src` and `frame-src`. Pre-clearance is off, so no `cf_clearance` flow.

No other CSP relaxations.

### 10.3 Rate limits

Binding (per location, eventually consistent, period only 10 or 60):

| Binding | Key | Limit |
|---|---|---|
| `RL_GENERAL` | `user:<sub>` if the bearer verifies, else `ip:<cf-connecting-ip>` | 120 / 60s |
| `RL_CREDENTIALS` | `ip:<cf-connecting-ip>` always | 15 / 60s on register, login, guest |
| `RL_REFRESH` | `refresh:<sha256(cookie)>` if the refresh JWT verifies, else IP | 30 / 60s |
| `RL_ADMIN` | IP | 30 / 60s |
| `RL_WS` | IP | 30 / 60s upgrades |

Respond 429 with `Retry-After`. These limits are **per Cloudflare location**, so they are a backstop, not a global budget. The Postgres login lockout is the global control for passwords. The DO buckets are the global control for a single table (one DO worldwide).

Health probes skip `RL_GENERAL`.

### 10.4 WAF (operator suggestions, not app code)

- Managed ruleset and bot fight mode on the zone.
- A zone rate-limiting rule on `POST /api/auth/login`, `/register`, and `/guest` as a second layer in front of the binding.
- Do not cache `/api/*` or `/ws/*` at the CDN (`Cache-Control` already says so; add a cache rule if a product override appears).

### 10.5 Admin

`GET /api/admin/*` requires:

1. Cloudflare Access on that path (policy: operator emails or a service token). The Worker does not implement the login UI.
2. A valid player session (Bearer), then `User.role === "ADMIN"` read from Postgres on every request.
3. `RL_ADMIN`.
4. The existing access log and `REGULATOR_HAND_AUDIT_ACCESS` / `ADMIN_DENIED` / `AUDIT_INTEGRITY` log lines.

Access is not a substitute for the role check. The role check is not a substitute for Access.

### 10.6 Turnstile

`POST` register, login, and guest require JSON `turnstileToken` (string, max 2048). The server `POST`s `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `{ secret, response: token, remoteip: cf-connecting-ip }` before any user lookup and before bcrypt. Tokens are single-use and expire in 5 minutes.

- Siteverify failure or `success !== true` → 403 `{ error: "Verification failed", code: "TURNSTILE_FAILED" }`. No session cookie change. No user lookup.
- Network failure talking to siteverify → 503 retryable. Do not treat it as a bad password.
- On success, the rest of the handler is unchanged, including the dummy hash.

Refresh, logout, and table routes do not use Turnstile.

## 11. Testing

### 11.1 Durable Objects

Use `@cloudflare/vitest-plugin` (Workers Vitest integration). The older `@cloudflare/vitest-pool-workers` package is what the docs now say to migrate off. Do not add it.

Tests live in `apps/edge/test/` and run inside workerd via Miniflare:

- Alarm fires a turn timeout once, and a second alarm does not double-apply (`GameCommand` / DO `commands`).
- Showdown alarm waits 3200ms of scheduled time (use fake timers / the alarm test helper) then commits `completeHand` before `tryStart`.
- Two concurrent `ACTION_INTENT` RPCs cannot both debit; the gate serializes them.
- Replaying `clientActionId` returns `duplicate: true` and does not change `revision`.
- Hibernation: `runDurableObjectAlarm` / storage round-trip. After dispose-and-wake, `deserializeAttachment` still has `userId`, and the ciphertext in SQLite reloads.
- Leak: a second socket does not receive the first user's hole cards. A forced `LEAK_BLOCKED` sends nothing.
- Revoke RPC closes the tagged socket with `SESSION_REVOKED`.

`@poker/engine` unit tests stay in `packages/engine` (Jest). Do not reimplement them.

### 11.2 Hyperdrive local

`wrangler dev` in `apps/edge` with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` aimed at Docker Postgres (`npm run db:up` from the repo root). Apply migrations to that Docker database with a **local** `DIRECT_URL`, never the repo-root production URL. The existing server test runner (`node test/support/run-tests.mjs`) remains the way to run `apps/server` tests; it forces a dead `DATABASE_URL`.

Auth integration: HTTP tests against `wrangler dev` that cover register, login lockout, refresh reuse, and absolute expiry. Port assertions from `apps/server/test/auth-http.test.mjs`; do not delete that file.

### 11.3 Playwright

Existing `apps/web` Playwright. Point it at `next dev` (or `opennextjs-cloudflare preview`) plus `wrangler dev`. Cover: guest with the Turnstile test key, create table, seat two players (two browser contexts), action, reconnect mid-hand, refresh cookie rotation while seated (`SESSION_RENEW` does not reset the table).

## 12. CI/CD

New workflow `.github/workflows/cloudflare.yml`. Do not weaken existing test workflows.

On pull request:

1. `npm run build:core`
2. `npm run typecheck`
3. `npm test -w @poker/engine`
4. `npm test -w @poker/server` (existing runner, dead database URL)
5. `npm run prisma:generate -w @poker/edge` and `npm run typecheck -w @poker/edge`
6. `npm test -w @poker/edge` (vitest plugin)
7. `npm run build -w @poker/web` (Next build, catches font and type errors)

On push to the default branch, after the above, in order:

1. `prisma migrate deploy` from `apps/server` with secret `NEON_DIRECT_URL` as `DIRECT_URL` / `DATABASE_URL` for that step only. The job must not load the repo-root `.env`. Refuse to run if the URL host contains the current Supabase host (check for the known production host fragment in the workflow and fail closed).
2. `wrangler deploy -w` is wrong for this repo layout. Deploy from each app:

```sh
npm exec -w @poker/edge -- wrangler deploy
npm run deploy -w @poker/web
```

with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Preview: on PR, `wrangler versions upload` or `wrangler deploy --env preview` for the API against the preview Hyperdrive, and an OpenNext preview Worker. Comment the preview URL. Preview secrets are separate. Never run preview against the production Hyperdrive id.

Migrations are additive. The operator still owns production Supabase, and this workflow must not target it.

## 13. Work packages

Ordered so two agents can share the tree. A package may start when its inputs exist. Do not edit another package's files. If a change needs a type update, change `PROTOCOL.md` first (operator) and then `packages/shared/src/protocol.ts` (only WP1 owns that file; later packages request a type change rather than editing it).

### WP1 — Skeleton, config, DB, protocol types

Inputs: this spec.

Outputs: an edge Worker that answers `GET /api/health` and `GET /api/ready`, a generated Prisma client, `GameCommand` migration, frozen protocol module, DO class files that export and hibernate but do not yet play poker (they may `acceptWebSocket` and close with `1011` until WP3/WP4).

Files owned:

- `apps/edge/**` except `src/http/**`, `src/table/**`, `src/lobby/**`, `src/session/user-sessions.ts`, `src/auth/**`, `src/game/**`
- `apps/edge/src/index.ts` may route `/api/*` to a router WP2 will fill, and `/ws/*` to the DO stubs
- `apps/edge/src/health.ts` — `GET /api/health` and `GET /api/ready`. Not under `src/http/`, which WP2 owns.
- `apps/edge/src/actors/table-actor.ts`, `lobby-actor.ts`, `user-sessions.ts` — hibernating class stubs exported from `src/index.ts`. WP3 replaces the `TableActor` and `UserSessions` bodies. WP4 replaces the `LobbyActor` body. Those three files are added to those packages' ownership. Do not create a second class with the same name.
- `apps/edge/src/session/contract.ts` (RPC method types only)
- `apps/edge/scripts/check-schema-parity.mjs`
- `apps/server/prisma/schema.prisma` — **only** the `GameCommand` model
- `apps/server/prisma/migrations/20261010130000_game_command/migration.sql` — new file only
- `packages/shared/src/protocol.ts` — new
- `packages/shared/src/index.ts` — one re-export line

Acceptance:

- `prisma generate` in `apps/edge` succeeds with `runtime = "cloudflare"` (or `workerd` fallback).
- Parity script passes.
- `wrangler deploy --dry-run` from `apps/edge` succeeds. With a `preview` env in the same file, pass `--env=""` if Wrangler asks for an explicit environment. Exit 0 with the warning is enough.
- Vitest (`@cloudflare/vitest-plugin`, not `@cloudflare/vitest-pool-workers`) boots the Worker and `GET /api/health` returns 200.
- Migration SQL is additive: `CREATE TABLE`, its index, the RLS boilerplate from `20261010120000_runtime_hardening` (required or `poker_assert_rls()` fails closed), `SELECT`+`INSERT` for `poker_server`, and the append-only trigger. No existing row is read or changed. It applies to Docker Postgres.

### WP2 — HTTP auth, tables, admin

Inputs: WP1 router mount and `createPrisma`.

Outputs: every route in section 5.2 except the DO game RPC can be stubbed for `track()` if WP3 is not merged; once WP3 is merged, `POST /api/tables` calls `track()`.

Files owned:

- `apps/edge/src/http/**`
- `apps/edge/src/auth/**`
- `apps/edge/test/auth.test.ts`
- `apps/edge/test/tables-http.test.ts`

Does not own `login/page.tsx`. Turnstile verification function lives in `src/auth/turnstile.ts` so WP6 can call the same contract from the client field name `turnstileToken`.

Acceptance: ported cases from `auth-http.test.mjs` (register, login dummy-timing not required to be bit-exact, lockout, refresh reuse revokes, absolute expiry, 503 keeps the cookie). Table create debits bankroll once. Admin route returns 403 for a non-admin even if Access is disabled in tests (tests simulate Access with a header `Cf-Access-Jwt-Assertion` that the test config treats as optional; production config requires it).

#### WP2 note (implementation)

- Auth and table HTTP tests run inside vitest against an in-memory Prisma double (`apps/edge/test/memory-db.ts`), the same strategy as `apps/server/test/support/auth-fake-db.mjs`. They do not open Docker Postgres or any remote database. Section 11.2's `wrangler dev` pass is still the operator check.
- Refresh-token hashing and guest randomness use Web Crypto (`crypto.subtle` SHA-256, `crypto.getRandomValues`). `apps/edge/tsconfig.json` types only `@cloudflare/workers-types`, so `node:crypto` does not typecheck. The digest is the same SHA-256 hex the Node server stores.
- Cloudflare Access on `GET /api/admin/*`: set both Worker vars `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` (they are not in `wrangler.jsonc`). The JWT is verified with that team's Access certs (RS256, issuer `https://<team>.cloudflareaccess.com`, audience `CF_ACCESS_AUD`). An `https://` `CLIENT_ORIGIN` without both vars makes the admin route 500. An `http://` origin with neither var skips the JWT (tests); `User.role === "ADMIN"` is still required. The `Cf-Access-Jwt-Assertion` header is optional only in that skipped case.

### WP3 — TableActor, UserSessions, game persist

Inputs: WP1 DO exports, `GameCommand`, protocol types, engine build.

Outputs: section 8.3–8.6 and 8.8.

Files owned:

- `apps/edge/src/table/**`
- `apps/edge/src/actors/table-actor.ts` — replace the WP1 stub body
- `apps/edge/src/actors/user-sessions.ts` — replace the WP1 stub body
- `apps/edge/src/session/user-sessions.ts`
- `apps/edge/src/game/**`
- `apps/edge/test/table-actor.test.ts`

Acceptance: two browsers' worth of scripted sockets play a hand to showdown against Miniflare; hole cards differ by viewer; timeout alarm folds or checks; replayed `clientActionId` does not move chips; kill between Postgres commit and DO meta write (simulate by throwing after the transaction) recovers from `GameCommand` without a second cash-out.

#### WP3 notes

Recorded with the TableActor implementation. These are the choices the lobby and HTTP callers already depend on.

**Authority.** Postgres owns chips, seats, and hand history (`User.bankroll`, `TableSeat`, append-only `Hand*`, `GameCommand`). The table Durable Object's SQLite owns the hot copy: AES-256-GCM ciphertext (`meta.engine`), decimal `revision`, the outbox, stored command results, rate-limit buckets, fan membership, and the one alarm plan. A broadcast revision is one that has been stored in `meta.engine`. Money never moves from the ciphertext alone.

**Alarm.** One `setAlarm`. The due work is the JSON plan in `meta.alarm`, not a fresh `Date.now()` check, so an early platform fire still runs the scheduled kind. Kinds, earliest first: `timeout` (`applyTimeout`), `showdown` (`completeHand`, then a separate deal in the same alarm), `deal` (`startHand` when `readyToDeal`), `idle-warn`, `idle-close`, `outbox` (about 1s), `retry`. `bot` exists only when `ENABLE_LEGACY_BOTS` is true; the default is false and edge tables do not seat bots. An idle plan that fires more than 1s early is rescheduled and does not close. An idle close more than 5s after `closingAt` logs `IDLE_ALARM_LATE`, clears the warning, and does not close. Late turn timeouts still apply. A thrown alarm is logged and rearmed about 2s later.

**Recovery.** `applyMutation` settles a pending outbox first (at most 8). A state change inserts the outbox row, commits Postgres (row lock, wallet, seats, `GameCommand`, hand history, ciphertext column), then writes DO meta and deletes the outbox. `armTestFault("throw-after-postgres")` throws once after that commit and before the meta write. The next mutation finds the `GameCommand` row, adopts it, and does not debit or credit again. A client replay of the same `clientActionId` / `commandId` returns the stored ack with `duplicate: true` and does not move chips. Definitive `EngineError`s are stored and returned again without `duplicate`. If the DO revision and Postgres revision diverge and no pending outbox explains it, the table is paused (`TableIncident` `STATE_DIVERGENCE`) and mutations answer `RECOVERY_REQUIRED`. Missing ciphertext while a hand is open pauses as `RECOVERY_REQUIRED` and does not redeal.

**Contract (minimal edits to `session/contract.ts`).** `SessionDelivery` is the shared fan-out shape. `TableActorRpc.keepAlive(userId, commandId?)` resolves `{ ok: true, duplicate? }` and rejects with `error.code` on a definitive refusal. `TableActorRpc.deliver` and `currentIdleNotice(userId)` were added. `LobbyActorRpc.deliver` takes `SessionDelivery`. `UserSessions.notify` and `lobby.patch` run after the input gate is released so they cannot deadlock on `deliver`.

**Deviations.**

- A client command that does not change state still inserts `GameCommand` when `durableNoOp` is true (the default for client ids). Alarm and deal ids use `durableNoOp: false`, so a no-op does not consume `deal:` or `timer:`.
- Extra server command ids, same idempotency table: `idle:<table>:<revision>`, `idle-late:<table>:<revision>`, `keep:<table>:<user>:<revision>` when the lobby omits `commandId`, `upgrade:<table>:<revision>`, and `bot:<table>:<turnId>` only if legacy bots are enabled.
- `TABLE_JOIN` has no `lastRevision`. Join and rehydrate always send a full `STATE_SNAPSHOT`.
- `Hand.rake` is `table.rakeTaken` (the Node writer left the column at its default 0).
- Hibernation is not downtime: idle warnings are not cleared on wake, and `rebaseTurnClock` is not applied.
- An empty waiting table closes on the first mutation (`closeIfEmpty`, same as Node `tryStart`). Seat before `TABLE_JOIN`.
- The vitest pool does not load `.dev.vars` or Hyperdrive's local URL, and it cannot evaluate `pg`'s CommonJS. `vitest.config.ts` injects the Hyperdrive URL plus the stable test secrets `lobby.test.ts` already signs with, and aliases `pg` to an esbuild ESM bundle (`scripts/bundle-pg.mjs`). That bundle is test-only; `wrangler deploy` still bundles `pg` itself. WP3 fixtures are `isPrivate`, so they stay out of the lobby's newest-50 public list.
- Docker's `POKER_APP_PASSWORD` is empty in the running container, so the local Hyperdrive URL uses the `poker` role from `apps/server/.env` with the host forced to `127.0.0.1`. That is the local database, not production. It is a superuser, so these tests do not exercise `poker_app` grants.

### WP4 — Lobby DO

Inputs: WP1 lobby export, WP3 `patch` RPC if merged; until then, implement `patch` and unit-test it with a fake caller.

Files owned:

- `apps/edge/src/lobby/**`
- `apps/edge/src/actors/lobby-actor.ts` — replace the WP1 stub body
- `apps/edge/test/lobby.test.ts`

Acceptance: snapshot matches `GET /api/tables` for the same fixture. A patch updates seated counts. `isSeated` is per connection. Keep-alive RPC is invoked for a seated user and refused for a spectator.

### WP5 — Web socket adapter

Inputs: PROTOCOL.md (types from WP1). Can proceed against a mock WS server before WP3 lands.

Files owned:

- `apps/web/src/lib/socket.ts`
- `apps/web/src/lib/ws-client.ts`
- `apps/web/src/hooks/use-lobby-socket.ts` (only if the lobby connection is not inside `socket.ts`)

Do not edit table components, `use-table-socket.ts`, or `auth-hydrator.tsx` unless an adapter bug makes it impossible. If an edit is required, stop and keep it to the event subscription lines.

Acceptance: existing component imports still typecheck. A unit test of `ws-client` covers reconnect backoff, ack correlation, and `SESSION_RENEW`. Manual or Playwright: seat, act, drop the socket, see the same revision return, wallet unchanged.

### WP6 — Web on Workers + Turnstile widget + CSP

Inputs: none from the API beyond the field name `turnstileToken` and the siteverify contract. Can land in parallel with WP2.

Files owned:

- `apps/web/open-next.config.ts`
- `apps/web/wrangler.jsonc`
- `apps/web/package.json` — script entries `preview`, `deploy`, `cf-typegen` only
- `apps/web/src/middleware.ts` — CSP additions only
- `apps/web/src/components/turnstile-widget.tsx`
- Turnstile insertions in `apps/web/src/app/login/page.tsx` and `apps/web/src/app/page.tsx` (the guest POST). No other edits in those files.

Acceptance: `opennextjs-cloudflare build` succeeds. A production build's CSP header contains the nonce and `https://challenges.cloudflare.com` in `script-src` and `frame-src`. Login POST body includes `turnstileToken`. `next/font` CSS is same-origin.

### WP7 — CI

Inputs: WP1 scripts exist. Extend as later packages add tests.

Files owned:

- `.github/workflows/cloudflare.yml`

Acceptance: the PR job does not receive `NEON_DIRECT_URL` and cannot reach a database. The default-branch job's migrate step fails if the URL looks like the current Supabase host. Workflow does not run `migrate dev`, `db push`, `db seed`, or `npm run dev`.

### Parallelism

| After | Can run together |
|---|---|
| Spec merged | WP1 only |
| WP1 merged | WP2, WP3, WP4, WP5, WP6, WP7 |
| WP3 merged | WP2's `track()` call and WP4's live patch wire-up (small follow-up commits in those owned files) |

WP2 and WP3 share no files. WP5 and WP6 share no files if WP6 stays out of `socket.ts` and WP5 stays out of `middleware.ts`.

## 14. Sources

Checked 2026-10-10.

- Prisma on Workers with `pg`: generator `prisma-client`, `new PrismaClient({ adapter })` per request, `@prisma/adapter-pg`. https://www.prisma.io/docs/orm/prisma-client/deployment/edge/deploy-to-cloudflare
- Generator fields: `runtime` values include `workerd` (alias `cloudflare`); `prisma-client-js` deprecated. https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/generators
- Hyperdrive + `pg`, `nodejs_compat`, recommended driver. https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
- Hyperdrive transaction-mode pooling (one connection for the transaction; `node-postgres` named prepared statements supported). https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/
- Hyperdrive query cache default 60s, not invalidated on write; disable with `--caching-disabled`; create clients inside the handler. https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
- Hyperdrive local connection string. https://developers.cloudflare.com/hyperdrive/configuration/local-development/ and https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- DO WebSocket hibernation (`acceptWebSocket`, `serializeAttachment` 16,384 bytes, `getWebSockets`, alarms, RPC). https://developers.cloudflare.com/durable-objects/best-practices/websockets/ and https://developers.cloudflare.com/durable-objects/api/state/
- DO alarms: one alarm, at-least-once, reschedule yourself. https://developers.cloudflare.com/durable-objects/api/alarms/
- DO SQLite via `exports` (`storage: "sqlite"`). Legacy `migrations` / `new_sqlite_classes` is the old flow; a Worker uses only one. https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
- Workers routes: most specific pattern wins. https://developers.cloudflare.com/workers/configuration/routing/routes/
- Next.js on Workers: vinext is the recommended default and targets a Next 16 `vinext init`; OpenNext remains the adapter for an app that cannot move yet. https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/ and https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/
- vinext compatibility run against Next 16.2.6. https://vinext.dev/compatibility
- OpenNext wrangler sample (`main: .open-next/worker.js`, `nodejs_compat`, observability) and the note that Node.js middleware is not supported. https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/
- Rate Limiting binding (`namespace_id`, `simple.limit`, `simple.period` of 10 or 60, per location). https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Turnstile siteverify. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Turnstile CSP (`script-src` and `frame-src` `https://challenges.cloudflare.com`; nonce + `strict-dynamic` recommended). https://developers.cloudflare.com/turnstile/reference/content-security-policy/
- `node:crypto` on Workers (full API with listed exceptions; `nodejs_compat` default on compatibility dates ≥ 2026-08-04). https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
- CPU time: free 10ms, paid default 30s. https://developers.cloudflare.com/workers/platform/limits/
- Workers Vitest plugin; migrate off `@cloudflare/vitest-pool-workers`. https://developers.cloudflare.com/workers/testing/vitest-integration/
