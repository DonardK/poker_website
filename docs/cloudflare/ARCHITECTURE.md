# Cloudflare implementation spec

Status: authoritative for the Workers port. Other agents implement this document and [PROTOCOL.md](./PROTOCOL.md). They do not redesign it.

This program does not change poker rules, chip amounts, session lifetimes, or the ledger's "foundation only" status. `User.bankroll` stays the live wallet until a later program calls `ledger_post`. See `docs/money/LEDGER.md`.

The current target is the **Free-plan demo** in the next section. The rest of this document is the earlier paid-plan, custom-domain spec. Where they disagree, the demo section wins. The repo-root `.env` is the live Supabase database; do not point ad-hoc commands at it. `apps/server` keeps its own env for local Node tests.

## Demo on the Workers Free plan

A client demo on the Workers Free plan, with no custom domain. Every switch below is config, so a later paid plan can change it without a rewrite.

- **One public origin.** `poker-web.<account>.workers.dev` (`workers_dev: true` on `poker-web`). No zone routes. `poker-api` has `workers_dev: false` and is reached only by the service binding `API`. `apps/web/worker.ts` forwards `/api/*`, `/ws`, and `/ws/*`, including WebSocket upgrades, to `env.API.fetch(request)`. The browser Host and Origin stay the web host. `CLIENT_ORIGIN` is that origin (placeholder `https://poker-web.<subdomain>.workers.dev` until deploy). Cookies have no `Domain` attribute, so they stay host-only on that origin. CSRF accepts that Origin.
- **Same-origin browser.** Leave `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` empty. The client uses `window.location.origin` (and `wss` on https). CSP `'self'` covers that host. `next dev` still proxies `/api` and `/ws` to wrangler; set the public URLs to `http://localhost:4000` only for the legacy `npm run dev` server.
- **Passwords.** PBKDF2-SHA256, `pbkdf2-sha256$v1$<iterations>$<salt_b64url>$<dk_b64url>`, 16-byte salt, 32-byte key. `PASSWORD_PBKDF2_ITERATIONS` defaults to `10000` (Free). Paid: `600000`. Stored counts above 1,000,000 are not computed. Unknown users pay one PBKDF2 derivation at the current count. `ENABLE_LEGACY_BCRYPT` defaults to `false` (dummy PBKDF2, then 401). `true` compares `$2a$` / `$2b$` / `$2y$` via a dynamic `bcryptjs` import and rehashes to PBKDF2. Login also rehashes when the stored PBKDF2 count is below the current setting.
- **Database.** Existing Supabase project `tgfudufxslhrxbdxcnyl`, region `eu-west-1`, through Hyperdrive with caching disabled. Runtime login is `poker_server` (already `LOGIN` there) on the session pooler, port 5432. Migrations use the admin URL on port 5432 (session pooler user `postgres.<ref>`, or direct `db.<ref>.supabase.co`). Port 6543 is rejected. Worker placement `aws:eu-west-1`. Durable Object hint `weur`.
- **Admin.** `ADMIN_REQUIRE_CF_ACCESS` defaults to `false`. With `CF_ACCESS_*` unset, `/api/admin` skips the Access JWT and still requires `User.role === ADMIN`. `true` restores the strict https check.
- **Prisma.** The generated client and its WASM are imported at the top of the Worker and Durable Object entry modules so compile happens at startup. `new PrismaClient({ adapter })` is still per request. pg pools are not stored on `globalThis`.
- **Risks.** Free-plan CPU is 10 ms per request. PBKDF2 at 10,000 iterations and Prisma query execution share that budget; a paid plan raises the budget and the iteration count together. Free daily request quotas apply. Hyperdrive caching stays off so chip and seat reads are not stale. See [SUPABASE_MIGRATION_PLAN.md](./SUPABASE_MIGRATION_PLAN.md) before the first `prisma migrate deploy`.

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

### Account security tables (migration `20261019100000_account_security`)

New columns on `User` (`emailVerifiedAt`, `credentialsVersion`, `passwordChangedAt`, `passwordResetRequired`, `mfaFailedCount`, `mfaLockedUntil`, `securityHoldUntil`, `webauthnUserId`) and `Session` (`deviceId`, `persistent`, `authMethods`, `reauthAt`, `reauthMethods`), and nine tables. RLS is forced on all of them. The runtime role gets column-level `UPDATE` only, so it can never rewrite a secret, a hash or a binding (replacement is delete-then-insert):

| Table | Holds | Runtime role |
|---|---|---|
| `KnownDevice` | SHA-256 of the `poker_device` cookie, coarse IP, label, country | SELECT, INSERT, DELETE; UPDATE label, userAgent, lastIp, country, lastSeenAt |
| `UserTotp` | TOTP secret sealed with the auth key ring (section 7), pending until `enabledAt` | SELECT, INSERT, DELETE; UPDATE enabledAt, disabledAt, lastUsedStep |
| `UserBackupCode` | HMAC of each backup code | SELECT, INSERT, DELETE; UPDATE usedAt |
| `WebAuthnCredential` | Passkey id, COSE public key, counter, RP ID; soft delete | SELECT, INSERT, DELETE; UPDATE counter, lastUsedAt, name, backedUp, deviceType, removedAt |
| `EmailToken` | SHA-256 of email-link tokens (verify, reset, email change, lockdown) | SELECT, INSERT, DELETE; UPDATE consumedAt |
| `AuthNonce` | Used MFA-ticket and passkey-challenge ids | SELECT, INSERT, DELETE |
| `AccountSecurityEvent` | Append-only security history (`type` is a `SecurityEventType`) | SELECT, INSERT (a trigger refuses UPDATE/DELETE for every role) |
| `StepUpGrant` | Single-use, 5-minute grant for one money action: `purpose`, `bindHash`, `method`, `sessionId` | SELECT, INSERT only: the API mints, the payments role consumes |
| `StepUpEmailChallenge` | HMAC of the emailed step-up code: 10 minutes, 5 tries, bound to session, purpose and bindHash | SELECT, INSERT, DELETE; UPDATE attempts, consumedAt |

The database also enforces the money step-up policy: a `StepUpGrant` with method `PASSWORD` is refused for every money purpose, an `admin_payments` grant needs `PASSKEY`, `expiresAt` is at most 5 minutes after `createdAt` (the issuer writes both from one clock reading), and a trigger lets `consumedAt` be set once, before expiry, with nothing else ever changing (`poker.break_glass` is the maintenance hatch). The migration also revokes every guest session that had not ended (`GUEST_RETIRED`). The wallet migration grants `poker_payments` SELECT and UPDATE (`consumedAt`) on `StepUpGrant`, and SELECT on `AccountSecurityEvent`.

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
    "TERMS_VERSION": "2026-10-19",
    "JWT_ACCESS_TTL": "15m",
    "JWT_REFRESH_TTL": "7d",
    "SESSION_IDLE_TTL": "14d",
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
    { "name": "RL_WS", "namespace_id": "1005", "simple": { "limit": 30, "period": 60 } },
    { "name": "RL_EMAIL", "namespace_id": "1006", "simple": { "limit": 5, "period": 60 } }
  ]
}
```

Account-security vars (all optional; blank means the default): `WEBAUTHN_RP_ID` (blank = the `CLIENT_ORIGIN` host; otherwise that host or a parent domain, never an IP or a public suffix such as `workers.dev`), `WEBAUTHN_RP_NAME` and `TOTP_ISSUER` (default `Hold'em Live`), `WEBAUTHN_EXTRA_ORIGINS` (comma list of https origins), `MAIL_FROM` and `MAIL_REPLY_TO` (required with `RESEND_API_KEY`), `PASSWORD_BREACH_CHECK` (`true`), `SECURITY_HOLD_HOURS` (`24`, 0-168) and `ADMIN_REQUIRE_PASSKEY` (`false`). `SESSION_IDLE_TTL` is 14 days when "Keep me signed in" is on; off gives a browser-session cookie with 12 h idle and 24 h absolute.

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
| `AUTH_HMAC_SECRET` | Optional. Keys MFA tickets, passkey challenge tokens and code HMACs. ≥32 characters, ≥16 distinct, distinct from the JWT and ticket secrets. |
| `AUTH_ENCRYPTION_KEYS` | Optional. Auth key ring (seals TOTP secrets), same format as the game ring, no key shared with it. |
| `AUTH_ENCRYPTION_ACTIVE_KEY_ID` | Optional. Active auth `kid`. Set all three `AUTH_*` or none. |
| `RESEND_API_KEY` | Optional. Email delivery (`re_…`); needs `MAIL_FROM`. Blank: no email (an http origin logs links). |

The account-security settings (`AUTH_*`, `RESEND_API_KEY`, `MAIL_*`, `WEBAUTHN_*`, `TOTP_ISSUER`, `PASSWORD_BREACH_CHECK`, `SECURITY_HOLD_HOURS`, `ADMIN_REQUIRE_PASSKEY`) are optional, and no value of them can break sign-in, refresh or play (the Durable Objects read the same config): a missing, partial, malformed, placeholder, low-entropy or reused value turns its feature off (TOTP, passkeys, MFA sign-in and money step-up answer 503; email goes to the sink) and `readEdgeConfig` logs `CONFIG_SETTING_IGNORED` with the variable name once per isolate; a safety switch falls back to its stricter value (`ADMIN_REQUIRE_PASSKEY=true`, breach check on, 24 h hold). Only the settings play depends on fail the request with 500, and only for what `main` already refused (missing or short secrets, equal JWT and ticket secrets, `change`/`replace`/`development` in them) plus the repository's `test-only` marker. On an https `CLIENT_ORIGIN` a published, low-entropy or reused game key or a low-entropy JWT secret is accepted and logged as `WEAK_PRODUCTION_SECRET` (rotate it); in the auth ring the same problems keep account security off.

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
| GET | `/api/auth/config` | none | `http/auth.ts` | 200 `AuthClientConfig`: what this deployment offers (`emailEnabled`, `passkeysEnabled`, `totpEnabled`, terms version, step-up window). |
| POST | `/api/auth/register` | Turnstile + credential limit | `http/auth.ts` | `{ username, email, password, remember?, acceptTerms, confirmAge, termsVersion }`. 201 `{ user, accessToken }` + refresh, hint and device cookies; sends the verification email. 400 `PASSWORD_WEAK` / `PASSWORD_BREACHED` / `TERMS_REQUIRED`; 409 `TERMS_OUTDATED`, username or registration conflict. |
| POST | `/api/auth/login` | Turnstile + credential limit | `http/auth.ts` | `{ identifier, password, remember? }` (`identifier` is a username or an email; `username` is a deprecated alias). One PBKDF2 per request, lockout as before, the same 401 for every failure. 200 `{ user, accessToken }`, or 200 `MfaChallenge` (no session yet) when TOTP is on. 403 `PASSWORD_RESET_REQUIRED` (only after the right password); 503 `SECURITY_NOT_CONFIGURED` for a TOTP account without the `AUTH_*` secrets. |
| POST | `/api/auth/login/mfa` | MFA ticket + credential limit | `http/auth.ts` | `{ mfaTicket, method: "totp" \| "backup_code", code, remember? }`. 200 `{ user, accessToken }`. 401 `MFA_TICKET_INVALID` (expired, used, spent by the lock its wrong codes started, other browser, credentials changed) or `MFA_INVALID`; 429 `MFA_LOCKED` + `Retry-After`. |
| POST | `/api/auth/passkey/options` | none | `http/auth-passkey.ts` | 200 `{ options, challengeToken }` (discoverable, user verification required). Writes nothing. 503 `PASSKEYS_UNAVAILABLE`. |
| POST | `/api/auth/passkey/login` | challenge + credential limit | `http/auth-passkey.ts` | `{ challengeToken, credential, remember? }`. 200 `{ user, accessToken }`, `authMethods: ["passkey"]` (counts as two factors; allowed while a reset is required). 400 `CHALLENGE_INVALID`; 401 `PASSKEY_INVALID` (one body for every credential problem). |
| POST | `/api/auth/password/forgot` | Turnstile + credential + email limits | `http/auth-recovery.ts` | `{ email }`. Always 202 `{ ok: true }` (no enumeration; the link is issued after the response, on a database client of its own, so a real account costs the same before the 202 as an unknown address); 3 links per account per hour. |
| POST | `/api/auth/password/reset` | email token + credential limit | `http/auth-recovery.ts` | `{ token, newPassword }`. 204: every session revoked (`PASSWORD_CHANGED`), cookies cleared, nobody signed in, TOTP still required. 400 `TOKEN_INVALID` / `PASSWORD_WEAK` / `PASSWORD_BREACHED` (a weak password does not use up the link). |
| POST | `/api/auth/email/verify` | email token + credential limit | `http/auth-recovery.ts` | `{ token }`. 200 `{ emailVerified: true }`. 400 `TOKEN_INVALID`. |
| POST | `/api/auth/email/change/confirm` | email token + credential limit | `http/auth-recovery.ts` | `{ token }`. 200 `{ email }`; notice with a revert link to the old address. 400 `TOKEN_INVALID`; 409 `EMAIL_UNAVAILABLE`. |
| POST | `/api/auth/security/lockdown` | email token + credential limit | `http/auth-recovery.ts` | "This wasn't me": `{ token }`. 200 `{ secured: true, resetToken, expiresAt }`, cookies cleared (section 10.7). 400 `TOKEN_INVALID`. |
| POST | `/api/auth/refresh` | refresh cookie + refresh limit | `http/auth.ts` | Rotation and reuse detection unchanged; keeps a non-persistent session non-persistent; refuses a retired guest (`GUEST_RETIRED`). |
| POST | `/api/auth/logout` | cookie optional | `http/auth.ts` | Revoke row, clear the refresh and hint cookies, 204, then `UserSessions.revoke`. |
| GET | `/api/auth/sessions` | Bearer | `http/auth.ts` | Coarse IP display unchanged. |
| DELETE | `/api/auth/sessions/:id` | Bearer | `http/auth.ts` | 404 if not owned. Revoke + fanout. |
| POST | `/api/auth/logout-all` | Bearer | `http/auth.ts` | `{ exceptCurrent?: true }`. |
| GET | `/api/auth/me` | Bearer | `http/auth.ts` | `{ user }` with `emailVerified`, `twoFactorEnabled`, `passkeyCount`. Every user record (sign-in, refresh, `/me`) also carries `termsVersion`, the version the account last accepted (null: never). |
| POST | `/api/auth/terms/accept` | Bearer | `http/auth.ts` | `{ acceptTerms, confirmAge, termsVersion }` from an account on older terms (the web asks before anything else). Records the version and time like registration. 200 `{ user }`; 400 `TERMS_REQUIRED`; 409 `TERMS_OUTDATED`. |
| POST | `/api/auth/reauth/password` | Bearer + credential limit | `http/auth-reauth.ts` | `{ password }`. 200 `{ reauthenticatedUntil }`, or `MfaChallenge` for a TOTP account. 401 `Invalid credentials` (counts toward the lock). |
| POST | `/api/auth/reauth/mfa` | Bearer + ticket + credential limit | `http/auth-reauth.ts` | `{ mfaTicket, method, code }`. 200 `{ reauthenticatedUntil }`. |
| POST | `/api/auth/reauth/passkey/options` | Bearer | `http/auth-reauth.ts` | `{}`, or `{ purpose, bind }` for a money grant. 200 `{ options, challengeToken }`; 409 `NO_PASSKEYS`. |
| POST | `/api/auth/reauth/passkey` | Bearer + challenge + credential limit | `http/auth-reauth.ts` | `{ challengeToken, credential }`. 200 `{ reauthenticatedUntil }`. |
| POST | `/api/auth/step-up/email-code` | Bearer + email limit | `http/auth-step-up.ts` | `{ purpose, bind }`, only for an account with neither TOTP nor a passkey. 202 `{ emailChallengeToken, expiresAt }`; 5 codes per account per hour (429). |
| POST | `/api/auth/step-up` | Bearer + credential limit | `http/auth-step-up.ts` | `{ purpose, bind, proof }`. 200 `{ stepUpGrantId, expiresAt }`: a single-use 5-minute `StepUpGrant` for one money action (section 10.7). |
| GET | `/api/account/security` | Bearer | `http/account.ts` | 200 `AccountSecurity`. |
| GET | `/api/account/events` | Bearer | `http/account.ts` | `?before=<ISO>&limit=1-50`. 200 `{ events, next }`. |
| GET | `/api/account/devices` | Bearer | `http/account.ts` | 200 `{ devices }` (`current` = this session's device). |
| DELETE | `/api/account/devices/:id` | Bearer | `http/account.ts` | Revokes that device's sessions; 204 (cookies cleared if it is this browser); 404 if not owned. |
| POST | `/api/account/password` | Bearer + step-up with the password | `http/account.ts` | `{ newPassword }`. 200 `{ revokedSessions }` (the other sessions). |
| POST | `/api/account/email` | Bearer + step-up + email limit | `http/account.ts` | `{ newEmail }`. 202 `{ ok: true, pendingEmail }` whether or not the address is taken; both leave the same state (a pending change in `GET /api/account/security`, the notice to the current address). A taken address gets an `EMAIL_IN_USE` mail instead of the link. |
| POST | `/api/account/email/verification` | Bearer + email limit | `http/account.ts` | 202 `{ ok: true }`; 409 `EMAIL_ALREADY_VERIFIED` / `EMAIL_MISSING`; 503 `MAIL_UNAVAILABLE`. |
| POST | `/api/account/2fa/totp/setup` | Bearer + step-up | `http/account.ts` | 200 `{ secret, otpauthUri, expiresAt }` (15 minutes to confirm). 409 `TOTP_ALREADY_ENABLED`. |
| POST | `/api/account/2fa/totp/enable` | Bearer + credential limit | `http/account.ts` | `{ code }`. 200 `{ backupCodes }` (shown once). Holds withdrawals when the session's step-up had no second factor. 400 `TOTP_INVALID`; 409 `TOTP_NOT_PENDING`. |
| DELETE | `/api/account/2fa/totp` | Bearer + step-up with a second factor | `http/account.ts` | 204; withdrawals held. 409 `TOTP_NOT_ENABLED`. |
| POST | `/api/account/2fa/backup-codes` | Bearer + step-up with a second factor | `http/account.ts` | 200 `{ backupCodes }`. 409 `TOTP_NOT_ENABLED`. |
| GET | `/api/account/passkeys` | Bearer | `http/account.ts` | 200 `{ passkeys }`. |
| POST | `/api/account/passkeys/options` | Bearer + step-up | `http/account.ts` | 200 `{ options, challengeToken }`; 409 `PASSKEY_LIMIT` (20). |
| POST | `/api/account/passkeys` | Bearer + step-up | `http/account.ts` | `{ challengeToken, credential, name? }`. 201 `{ passkey }`. Holds withdrawals when the session's step-up had no second factor. 400 `CHALLENGE_INVALID` / `PASSKEY_INVALID`; 409 `PASSKEY_ALREADY_REGISTERED`. |
| POST | `/api/account/passkeys/:id/rename` | Bearer | `http/account.ts` | `{ name }`. 200 `{ passkey }`; 404. |
| DELETE | `/api/account/passkeys/:id` | Bearer + step-up | `http/account.ts` | Soft delete; 204; 404. |
| GET | `/api/tables` | Bearer | `http/tables.ts` | Same query as `routes/tables.ts` (open, not private, no bot seats, limit 50, plus the caller's seat if older). |
| GET | `/api/tables/:id` | Bearer | `http/tables.ts` | 404 for unknown and for private tables the caller is not in. |
| GET | `/api/tables/:id/hands/:handNumber/audit` | Bearer | `http/tables.ts` | Participant audit. Fail closed. Port `game/audit.ts` usage, not the rules. |
| POST | `/api/tables` | Bearer | `http/tables.ts` | Creates the row, seats the host, debits bankroll, then RPC `TableActor.track` so the idle alarm starts. |
| GET | `/api/admin/hands/:handUuid/audit` | Bearer + DB role `ADMIN` + Cloudflare Access | `http/admin.ts` | Full sealed record. See section 10.5. |
| POST | `/api/ws-ticket` | Bearer + general limit | `http/ws-ticket.ts` | Sets `poker_ws`. Empty 204 body. |

`POST /api/auth/guest` was removed (owner decision 2026-10-18: no guest play); it is a 404. Request and response bodies are typed in `packages/shared/src/account.ts`. Errors are `{ error, code? }`; a step-up route answers 403 `{ code: "REAUTH_REQUIRED", methods, needs? }` (never 401) when the session has not confirmed it is the user in the last 5 minutes, or not with the methods the change needs. There are no payment routes on this Worker; the money step-up grant above is consumed by the payments Worker.

`POST /api/tables` today calls `tableManager.track` after commit. The edge equivalent is `env.TABLES.getByName(id, { locationHint }).track()`, which arms the idle alarm. If that RPC fails, the table row still exists; the next viewer or a ready-check alarm must arm it. Log the failure. Do not fail the HTTP create (same as today).

### 5.3 Cookies

| Cookie | Path | Max-Age | Flags in production |
|---|---|---|---|
| `poker_refresh` | `/api/auth` | until `Session.expiresAt`; none (a browser-session cookie) when "Keep me signed in" is off | `HttpOnly; Secure; SameSite=Strict` |
| `poker_session_hint` | `/` | the same as `poker_refresh` | `HttpOnly; Secure; SameSite=Lax`. Value `1`. Set and cleared with `poker_refresh`. A redirect hint for the web middleware, never an authenticator. |
| `poker_device` | `/api/auth` | 34560000 (400 days) | `HttpOnly; Secure; SameSite=Strict`. `d1.<43 base64url>`; only its SHA-256 is stored (`KnownDevice`). Names the browser for new-sign-in alerts and the familiar-device lockout exemption. |
| `poker_ws` | `/ws` | 60 | `HttpOnly; Secure; SameSite=Strict` |

Development (`wrangler dev` on http): `SameSite=Lax`, omit `Secure`.

`poker_ws` value is a compact JWS (`jose`, HS256, `WS_TICKET_SECRET`):

```ts
{ sub: userId, sid: sessionId, username: string, typ: "ws", exp, iss: "poker-server", aud: "poker-ws" }
```

`exp` is 60 seconds from issue. The ticket is not stored. Replay inside 60 seconds only helps someone who already has the cookie. The DO still loads the session row and rejects a revoked session.

Clear `poker_refresh` with `Set-Cookie` `Max-Age=0` and the same `Path`, and clear `poker_session_hint` in the same response. Every cookie is host-only (no Domain attribute). Every cookie is appended (`c.header(..., { append: true })`), so one response can carry several. Session lifetime: 14 days idle and 30 days absolute when remembered; 12 hours idle and 24 hours absolute when not. A new sign-in revokes the session of any refresh cookie sent with it ("sign out, then sign in").

### 5.4 Access tokens

`jose` `SignJWT` / `jwtVerify`. HS256. Preserve claims so existing clients and the Node server's tokens are the same shape during any overlap (there should be no overlap of writers; the shape match is so tests and the web client stay valid):

- Access: `sub`, `sid`, `username`, `typ: "access"`, `iss: "poker-server"`, `aud: "poker-client"`, `jti` (UUID), `exp` from `JWT_ACCESS_TTL`.
- Refresh: `sub`, `sid`, `typ: "refresh"`, same iss/aud, `jti`, `exp` = `floor(session.expiresAt / 1000)`.

Do not bundle `jsonwebtoken`. It works under `nodejs_compat` but pulls Node-specific paths the edge port does not need. `node:crypto` is available for the hash and the cipher (section 10.1) and is what the ported key ring should call.

Bearer parsing: `Authorization: Bearer`, token length 1–4096. `authenticate()` checks the signature, then the session row (revoked, idle expiry, absolute expiry, `kind === "HUMAN"`, not a retired guest). A database error propagates as 503, not 401. The same guest refusal (`GUEST_RETIRED`) runs at refresh and at both socket session checks (`lobby/auth.ts`, `game/session.ts`).

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
- TOTP secrets on `UserTotp.secretCiphertext`: `user-totp:${userId}`, under the separate auth ring (`AUTH_ENCRYPTION_KEYS`, `authRingFromConfig`), never the game ring

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

Turnstile widget: `apps/web/src/components/turnstile-widget.tsx`. Sign-in (`/login`), sign-up (`/signup`) and the forgot-password form (`/reset-password`) send `turnstileToken` in the JSON body. The root layout renders the script tag on `/login` and `/signup` only; `/reset-password` can open with a reset token in its fragment, so its request form loads the script itself after the token check found none. A sign-in from a page that holds the script leaves it with a full page load (`leaveAuthPage`), so the third-party script never stays loaded on the lobby, table, account or wallet pages. Site key: `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. The widget script is `https://challenges.cloudflare.com/turnstile/v0/api.js` with the CSP nonce (`strict-dynamic` propagates it if the script tag carries the nonce). Do not enable Turnstile pre-clearance.

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
| `RL_CREDENTIALS` | `ip:<cf-connecting-ip>` always | 15 / 60s on the credential routes below |
| `RL_REFRESH` | `refresh:<sha256(cookie)>` if the refresh JWT verifies, else IP | 30 / 60s |
| `RL_ADMIN` | IP | 30 / 60s |
| `RL_WS` | IP | 30 / 60s upgrades |
| `RL_EMAIL` | same key as `RL_GENERAL` | 5 / 60s on routes that send email (the database also caps per account) |

`RL_CREDENTIALS` applies to every POST that checks a password, a code, a passkey assertion or an emailed token: `login`, `register`, `login/mfa`, `passkey/login`, `password/forgot`, `password/reset`, `email/verify`, `email/change/confirm`, `security/lockdown`, `reauth/password`, `reauth/mfa`, `reauth/passkey`, `step-up` (all under `/api/auth/`) and `/api/account/2fa/totp/enable`. `RL_EMAIL` applies to `/api/auth/password/forgot`, `/api/account/email`, `/api/account/email/verification` and `/api/auth/step-up/email-code`. Per-account caps in Postgres: reset links 3 per hour, verification links 5, email changes 3, security notices and alerts 20 per day, emailed step-up codes 5 per hour; over a cap the request still succeeds silently (no enumeration), except step-up codes (429).

Respond 429 with `Retry-After`. These limits are **per Cloudflare location**, so they are a backstop, not a global budget. The Postgres login lockout is the global control for passwords. The DO buckets are the global control for a single table (one DO worldwide).

Health probes skip `RL_GENERAL`.

### 10.4 WAF (operator suggestions, not app code)

- Managed ruleset and bot fight mode on the zone.
- A zone rate-limiting rule on `POST /api/auth/login`, `/register`, `/login/mfa`, `/passkey/login` and `/password/forgot` as a second layer in front of the binding.
- Do not cache `/api/*` or `/ws/*` at the CDN (`Cache-Control` already says so; add a cache rule if a product override appears).

### 10.5 Admin

`GET /api/admin/*` requires:

1. Cloudflare Access on that path (policy: operator emails or a service token). The Worker does not implement the login UI.
2. A valid player session (Bearer), then `User.role === "ADMIN"` read from Postgres on every request.
3. `RL_ADMIN`.
4. The existing access log and `REGULATOR_HAND_AUDIT_ACCESS` / `ADMIN_DENIED` / `AUDIT_INTEGRITY` log lines.
5. With `ADMIN_REQUIRE_PASSKEY=true` (recommended before real money): a session that signed in with a passkey, or stepped up with one in the last 5 minutes; otherwise 403 `ADMIN_PASSKEY_REQUIRED`.

Access is not a substitute for the role check. The role check is not a substitute for Access.

### 10.6 Turnstile

`POST` register, login and password/forgot require JSON `turnstileToken` (string, max 2048). The second sign-in step (`login/mfa`), passkey sign-in, step-up and the email-link routes do not: the MFA ticket, the signed challenge or the emailed token proves the earlier step, and they are rate limited as credential routes. The server `POST`s `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `{ secret, response: token, remoteip: cf-connecting-ip }` before any user lookup and before bcrypt. Tokens are single-use and expire in 5 minutes.

- Siteverify failure or `success !== true` → 403 `{ error: "Verification failed", code: "TURNSTILE_FAILED" }`. No session cookie change. No user lookup.
- Network failure talking to siteverify → 503 retryable. Do not treat it as a bad password.
- On success, the rest of the handler is unchanged, including the dummy hash.

Refresh, logout, and table routes do not use Turnstile.

### 10.7 Account security

Design: the account-security blueprint (routes in section 5.2, types in `packages/shared/src/account.ts`). Code: `apps/edge/src/auth/*` and `http/{auth,auth-passkey,auth-recovery,auth-reauth,auth-step-up,account,session-issue}.ts`, mail in `src/mail/*`.

- **Sign-in.** Username or email plus password (one PBKDF2 per request, lockout unchanged), then, when TOTP is on, a signed 5-minute MFA ticket (`AUTH_HMAC_SECRET` subkey; bound to the `poker_device` cookie and to `User.credentialsVersion`; single use through `AuthNonce`) and a TOTP or backup code with its own lock (`mfaFailedCount` / `mfaLockedUntil`, or a per-device counter on a known device). Each attempt is counted before its code is checked (a compare-and-set on `mfaFailedCount`), so parallel guesses are held to the lock schedule, and a ticket whose wrong codes start a lock is spent: the next try needs the password and Turnstile again. A passkey with user verification signs in alone. Every sign-in writes `Session.authMethods`, opens the step-up window and records `SIGN_IN` or `SIGN_IN_NEW_DEVICE`.
- **TOTP.** RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step), in house on Web Crypto. A code is accepted only for a step above `UserTotp.lastUsedStep` (one conditional UPDATE), so a code works once and the enrolment code cannot sign in. The secret is sealed with the auth key ring (section 7). 10 backup codes, stored as HMACs.
- **Passkeys.** `@simplewebauthn/server` 14.0.3 (exact pin, imported lazily), discoverable credentials, user verification required, attestation `none`, ES256/RS256. The challenge travels in a signed 5-minute token; an options request writes nothing. RP ID is the `CLIENT_ORIGIN` host (or `WEBAUTHN_RP_ID`); an IP-address origin turns passkeys off. The edge test suite registers and signs in with a software authenticator inside workerd.
- **Step-up.** Account changes need `Session.reauthAt` within 5 minutes (`/api/auth/reauth/*`); a password change needs the password in it, and a TOTP account always needs a second factor in it. A refresh never renews it. Money needs more: a single-use `StepUpGrant` (5 minutes) bound to the session, the purpose (`withdrawal`, `payout_destination`, `admin_payments`) and `bind`, the SHA-256 of the canonical action. Proofs: a passkey assertion whose challenge was issued for that purpose and bind; the password plus a TOTP or backup code; or, only for an account with neither, the password plus a 6-digit emailed code (10 minutes, 5 tries counted before the compare, HMAC at rest). `PASSWORD` alone never authorises money, and `admin_payments` needs a passkey (the database enforces both). The payments Worker consumes the grant. `requireMoneyAuth` (`auth/step-up.ts`) is the session-level check payments routes add: verified email, fresh second-factor step-up, no security hold.
- **Email links.** 32 random bytes in the URL fragment (`#t=`), SHA-256 at rest, single use: verify (24 h, `/verify-email`), reset (30 min, `/reset-password`), email change (1 h, `/email-change`), "This wasn't me" (7 days, `/auth/not-me`). Reset revokes every session and signs nobody in. Mail goes through Resend with an idempotency key per message, sent after the response (`waitUntil`); without `RESEND_API_KEY` it is logged on an http origin and dropped on https (`/api/auth/config` says `emailEnabled: false`).
- **Notices and lockdown.** Every credential or factor change, and a sign-in from a new device, emails a verified address with a "This wasn't me" link. Redeeming it revokes every session (`SECURITY_LOCKDOWN`), requires a password reset (password sign-in answers 403 `PASSWORD_RESET_REQUIRED` only after the right password), removes passkeys, TOTP and devices added since the incident, restores passkeys and TOTP removed since, puts the email back to the (verified) address the link was sent to whichever notice it came from, voids outstanding links and codes and every other "This wasn't me" link sent since the incident (those may have gone to an address the attacker set), holds withdrawals, and returns a fresh reset token. Links sent before the incident stay usable. `onAccountLockdown` (`auth/lockdown.ts`) is the hook the payments phase wires to `env.PAYMENTS.securityLockdown(userId)`; it is a no-op until then.
- **Security hold.** Password reset or change, email change, TOTP off, a lockdown, and a new TOTP or passkey enrolled by a session whose step-up had no second factor (so the password alone cannot swap the emailed-code money proof for a factor of its own) set `User.securityHoldUntil` (`SECURITY_HOLD_HOURS`, default 24): withdrawals and payout-destination changes answer 403 `SECURITY_HOLD` until it passes.
- **Breached passwords.** Have I Been Pwned range API (first 5 hex characters of SHA-1, `Add-Padding`), at register, reset and change; fail-open with a 1.5 s timeout (`BREACH_CHECK_UNAVAILABLE` warning); `PASSWORD_BREACH_CHECK=false` turns it off (tests). A password may not contain the username.
- **Housekeeping.** A daily cron (`23 3 * * *`, `src/maintenance/sweep.ts`) deletes expired single-use marks, email links 30 days after expiry, TOTP setups never confirmed, passkeys removed over 30 days ago and old emailed step-up codes. Security events are append-only and are not swept.

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

Existing `apps/web` Playwright. Point it at `next dev` (or `opennextjs-cloudflare preview`) plus `wrangler dev`. Cover: two accounts signed up through `/signup` with the Turnstile test key, create table, seat two players (two browser contexts), action, reconnect mid-hand, refresh cookie rotation while seated (`SESSION_RENEW` does not reset the table).

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

1. `prisma migrate deploy` from `apps/server` with secret `SUPABASE_DIRECT_URL` as `DIRECT_URL` / `DATABASE_URL` for that step only. The job must not load the repo-root `.env`. Accept only the Supabase admin session pooler (`*.pooler.supabase.com:5432`, user `postgres.<ref>`) or the direct host (`db.<ref>.supabase.co:5432`, user `postgres`). Refuse port 6543, loopback, and a runtime login.
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
- The vitest pool does not load `.dev.vars` or Hyperdrive's local URL, and it cannot evaluate `pg`'s CommonJS. `vitest.config.ts` injects the Hyperdrive URL plus test secrets and keys generated at random for each run (no fixed value is committed; `lobby.test.ts` reads them back from the bindings), and aliases `pg` to an esbuild ESM bundle (`scripts/bundle-pg.mjs`). That bundle is test-only; `wrangler deploy` still bundles `pg` itself. WP3 fixtures are `isPrivate`, so they stay out of the lobby's newest-50 public list.
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

Acceptance: the PR job does not receive `SUPABASE_DIRECT_URL` and cannot reach a database. The default-branch job's migrate step accepts only the Supabase admin session-pooler URL on port 5432 (or the direct `db.<ref>.supabase.co` host) and rejects port 6543 and loopback. Workflow does not run `migrate dev`, `db push`, `db seed`, or `npm run dev`.

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
