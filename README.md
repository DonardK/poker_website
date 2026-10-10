# Texas Hold'em Platform

Play-chip multiplayer Texas Hold'em with a Next.js client, an authoritative Express/Socket.io server, and PostgreSQL transactions. New tables are for human players; legacy bot tables remain readable so seated players can finish or cash out. Supabase OnlinePoker stores the game data. Redis is optional for Socket.io fanout; it is not the source of game state.

## Run the configured project

The ignored root `.env` contains the limited database login and independent encryption/session secrets. Preserve it securely. Do not copy it into the web application.

```sh
npm ci
npm run dev
```

For development and testing on your own machine, prefer `npm run dev:local`: it runs the same web app and game server against a PostgreSQL database of its own in `.local-db/` (git-ignored, every migration applied), so changes under development never touch the shared database or real players' data. `npm run dev:local -- --db` starts only that database and prints its URLs; `-- --reset` deletes the local data. `npm run dev` uses the database configured in `.env`, and the game server warns at start-up when that database is not local.

On Windows PowerShell, use `npm.cmd run dev` if script execution blocks `npm.ps1`. Run the root `dev` command so the web app and API start together; starting only `dev:web` leaves login and tables unavailable.

If the lobby says **Game server unavailable**, the web app is running but nothing answers on port 4000: the game server has stopped or is still waiting for its database. `npm run dev` keeps showing both programs after the server exits, and `tsx watch` restarts it only when a server file changes. The reason is in the `[server]` lines of that terminal:

- "database unavailable: Cannot reach the database at …": check the connection, VPN or firewall, and `DATABASE_URL`. In development the server keeps retrying. Supabase's direct host (`db.<project-ref>.supabase.co`) has only an IPv6 address; on a network without working IPv6, use the Session pooler connection string from the Supabase dashboard (Connect, Session pooler), which works over IPv4.
- "rejected the login in DATABASE_URL": wrong user or password.
- "Database is missing migration(s) …": apply the named migrations (see below) before starting the server.

After changing `.env`, stop `npm run dev` (Ctrl+C) and start it again.

Open http://localhost:3000. The API and sockets use port 4000. One person opens a table, another joins it from the lobby or its link, and the hand starts when both are seated. For a fresh checkout, copy `.env.example` to `.env`, supply the database URL, generate three independent secrets, and configure only `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` in `apps/web/.env.local` if changing the defaults.

## Database and migrations

Canonical migrations are in `apps/server/prisma/migrations`. OnlinePoker has already been initialized and secured. `supabase/migrations` contains the security changes submitted through Supabase MCP; it is not an independent initial schema. See [Supabase setup](supabase/README.md).

For a new local database, start `docker compose up -d`, provide an administrator connection through `DIRECT_URL`, then run `npm run db:migrate`. Use a restricted `poker_server` login in `DATABASE_URL` for the application. The security migration creates that role without a password or LOGIN; an administrator must provision it separately. Never run a reset against OnlinePoker or a database containing real data.

## Automatic deploys

A push to `main` runs the checks in [`.github/workflows/cloudflare.yml`](.github/workflows/cloudflare.yml), applies pending Prisma migrations, then deploys the `poker-api` and `poker-web` Workers. Secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_DIRECT_URL`) and the public site variables live on the GitHub environment `production`, not in the repo. Pull requests do not deploy while `CLOUDFLARE_PREVIEW_ENABLED` is unset. `wrangler deploy` keeps Worker secrets; this workflow never runs `wrangler secret put`.

Rollback restores the previous Worker version and does not undo a Supabase migration. From the repo root, with a Cloudflare login or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell:

```powershell
cd apps\edge
npx wrangler rollback --message "restore previous version" --env=""
cd ..\web
npx wrangler rollback --message "restore previous version"
```

The operator runbook is [docs/cloudflare/DEPLOY.md](docs/cloudflare/DEPLOY.md).

## Verification

```sh
npm run typecheck
npm test
npm run build
node scripts/verify-evaluator.mjs
npm run test:browser -w @poker/web
```

The browser suite uses Chrome, an isolated in-memory game server on port 4107, and a separate Next.js instance on port 3107. It does not connect to the configured database. Set `PLAYWRIGHT_CHANNEL=msedge` to use Edge instead. On Windows, run the browser suite outside a restricted sandbox so Playwright can shut down its test servers.

The opt-in integration test creates tagged play-chip fixtures. Use a disposable database with production role restrictions, set `POKER_INTEGRATION_TESTS=1` and a separate `DATABASE_TEST_ADMIN_URL` for cleanup, then run `npm run test:integration -w @poker/server`. The runtime role cannot erase hand histories. `POKER_KEEP_TEST_FIXTURES=1` permits testing without admin credentials but requires explicit administrator cleanup afterwards.

## Table lifecycle

A table is never deleted. Closing it sets its status to `CLOSED` and records `closedAt` in the same transaction that returns the chips of every player still seated to their bankroll (when a hand is in progress, it is settled first; see below). The lobby stops listing it, and its hand histories and audit records are kept. Once it has closed, a late join or any command that reaches it, including one that races the final commit, is refused with **This table has closed** (`TABLE_CLOSED`); an outsider to a private table still gets `TABLE_NOT_FOUND`, so its existence is not revealed. In the few seconds while a hand in progress is being settled for closure, taking a seat, sitting in and **I'm still here** are refused with **This table is closing** (`TABLE_CLOSING`), and the page shows **Closing the table…**.

- **Empty tables.** Any change that leaves a table with no seated players and no hand in progress closes it in that same transaction (reason `EMPTY`). A host who opens a table and leaves before anyone joins gets the buy-in back, and the table leaves the lobby at once.
- **The host leaving.** The host has no special role at the table. With others seated, the host leaves like any player (folded on their turn mid-hand, paid when the hand ends) and the game goes on without them. The table closes only when the last player leaves.
- **Inactivity.** After 5 minutes without activity from the players still at the table, no new hand is dealt and a 10-second countdown warning appears to everyone viewing the table. A seated player who is elsewhere in the app (the lobby, after keeping their seat) gets the same warning there, with **I'm still here** and **Go to table**. Unless a seated player acts or presses **I'm still here**, or someone takes a seat, before it ends, the table closes (reason `IDLE`), and the lobby tells its players why their chips came back.
- **What counts as activity.** Creating the table, taking a seat, a player's own fold, check, call, bet, raise or all-in, a sit-out or sit-in that changes something, and **I'm still here**. It is counted per player, and only players still seated (and not leaving) count: a player who acts or sits down and then leaves no longer keeps the table open, and when they leave the remaining absent players are warned again at once. Bots and time-outs never count, nor do dealing, blinds, leaving, spectators or reconnects, so a table of absent players whose hands keep timing out still closes.
- **Restarts.** Server downtime is not inactivity. After any restart every table gets a full 5 minutes before it can be warned, and a warning that was counting down when the server stopped is dropped, so dealing resumes.
- **The warning does not block play.** It floats near the top of the page with no backdrop and never covers the action bar: players can still act, and a spectator can take a seat, which also keeps the table open. The **Closing the table…** and **This table has closed** dialogs do block the page; the closed one offers **Verify hand** for the hands played there, starting with the last one (settled by the closure, even if the browser missed the final updates while reconnecting).
- **A hand in progress.** It is finished, not voided. Every dealt player is sat out and the hand settles under the ordinary sit-out rule: check when free, otherwise fold, and an all-in player keeps their claim on the pots. The hand is recorded and audited like any other, and its players are paid at Hand Clean-up a few seconds later. Players who were not dealt in are paid at once.

Server timers only prompt a check. The decision to warn or close is taken inside the table's locked transaction on fresh state, so a player who acts in time always wins the race, and a closure, once begun, cannot be undone. The lifecycle fields live in the encrypted table state, so no migration is needed; a table or player saved by an earlier version gets its idle clock from the row's last update. The limits are `TABLE_IDLE_TIMEOUT_MS` and `TABLE_IDLE_WARNING_MS` in `packages/shared/src/constants.ts`.

## Security and fairness

See [COMPLIANCE.md](COMPLIANCE.md) for the requirement-by-requirement dossier and measured test results, and [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for the threat model.

Every hand is shuffled with an unbiased Fisher-Yates (Durstenfeld) shuffle. Each swap index comes from the operating system's CSPRNG through Web Crypto (`crypto.getRandomValues`) with explicit rejection sampling, so there is no modulo bias. The code has no `Math.random` and no seeded generator. Before any blind is posted or card dealt, the engine assigns the hand a UUID v4 and computes a salted SHA-256 commitment to the complete deck order plus a salted Merkle root. Both are published in the first snapshot of the hand. Community cards leave the server-only deck only when their betting round starts. Each player receives only their own hole cards and a Merkle proof for every card they can see. A fail-closed guard, with an exact schema allow-list and a card-token check, refuses to send any snapshot that contains more. Every in-hand action and state transition, from hand start to settlement, is appended to a SHA-256 hash chain. The chain is sealed with a post-hand verification hash and linked to the previous hand at the table. Newcomers and players returning after missed blinds wait for the big blind. A player who leaves mid-hand has their hand folded on their turn.

After a hand, a participant can use **Verify hand**. It fetches a redacted audit (the hash chain, plus proofs for their own cards, the board and hands tabled at showdown) and recomputes every hash. It checks that the audit is for the hand and seat it asked about, and compares it with the commitments, chain head and hole-card digest the browser recorded during play. Mucked and undealt cards are never revealed to players. The full sealed record (deck order and salts) is available only to ADMIN users through `/api/admin/hands/:handUuid/audit`. That route replays each hand's outcome and checks the per-table chain.

Game state, sealed audits and hole cards are encrypted with AES-256-GCM and record-specific authenticated context. The database connection verifies TLS certificates. Transactions lock each table and atomically update chips, seats, encrypted state, completed history and the audit record. Revisions reject replayed or stale actions. The runtime database role cannot update or delete completed history, including its audit columns.

Back up `GAME_ENCRYPTION_KEY` in a secret manager: losing it makes saved games and sealed audits unreadable. Rotation needs a controlled decrypt/re-encrypt migration. Production refuses to start unless TLS is configured: either `TLS_CERT_FILE`/`TLS_KEY_FILE`, or `TRUST_PROXY_HOPS >= 1` behind a TLS-terminating proxy. It also requires strict database TLS, separate JWT secrets, and TLS for Redis when Redis is enabled. Apply migration `20260924120000_compliance_audit_trail` before deploying to a new database; the game server now refuses to start if its audit columns are missing. The migration was applied to OnlinePoker on 2026-09-28 and recorded in both Supabase and Prisma migration histories.

This is a play-chip application. The engine is built toward GLI-19/MGA technical expectations but is **not certified**. Laboratory RNG certification, external anchoring of audit hashes, KYC, responsible-gaming controls, anti-collusion operations and real-money accounting are not in place.
