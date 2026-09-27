# Texas Hold'em Platform

Play-chip multiplayer Texas Hold'em with a Next.js client, an authoritative Express/Socket.io server, and PostgreSQL transactions. New tables are for human players; legacy bot tables remain readable so seated players can finish or cash out. Supabase OnlinePoker stores the game data. Redis is optional for Socket.io fanout; it is not the source of game state.

## Run the configured project

The ignored root `.env` contains the limited database login and independent encryption/session secrets. Preserve it securely. Do not copy it into the web application.

```sh
npm ci
npm run dev
```

On Windows PowerShell, use `npm.cmd run dev` if script execution blocks `npm.ps1`. Run the root `dev` command so the web app and API start together; starting only `dev:web` leaves login and tables unavailable.

Open http://localhost:3000. The API and sockets use port 4000. One person opens a table, another joins it from the lobby or its link, and the hand starts when both are seated. For a fresh checkout, copy `.env.example` to `.env`, supply the database URL, generate three independent secrets, and configure only `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` in `apps/web/.env.local` if changing the defaults.

## Database and migrations

Canonical migrations are in `apps/server/prisma/migrations`. OnlinePoker has already been initialized and secured. `supabase/migrations` contains the security changes submitted through Supabase MCP; it is not an independent initial schema. See [Supabase setup](supabase/README.md).

For a new local database, start `docker compose up -d`, provide an administrator connection through `DIRECT_URL`, then run `npm run db:migrate`. Use a restricted `poker_server` login in `DATABASE_URL` for the application. The security migration creates that role without a password or LOGIN; an administrator must provision it separately. Never run a reset against OnlinePoker or a database containing real data.

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

## Security and fairness

See [COMPLIANCE.md](COMPLIANCE.md) for the requirement-by-requirement dossier and measured test results, and [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for the threat model.

Every hand is shuffled with an unbiased Fisher-Yates (Durstenfeld) shuffle. Each swap index comes from the operating system's CSPRNG (`crypto.randomFillSync`) with explicit rejection sampling, so there is no modulo bias. The code has no `Math.random` and no seeded generator. Before any blind is posted or card dealt, the engine assigns the hand a UUID v4 and computes a salted SHA-256 commitment to the complete deck order plus a salted Merkle root. Both are published in the first snapshot of the hand. Community cards leave the server-only deck only when their betting round starts. Each player receives only their own hole cards and a Merkle proof for every card they can see. A fail-closed guard, with an exact schema allow-list and a card-token check, refuses to send any snapshot that contains more. Every in-hand action and state transition, from hand start to settlement, is appended to a SHA-256 hash chain. The chain is sealed with a post-hand verification hash and linked to the previous hand at the table. Newcomers and players returning after missed blinds wait for the big blind. A player who leaves mid-hand has their hand folded on their turn.

After a hand, a participant can use **Verify hand**. It fetches a redacted audit (the hash chain, plus proofs for their own cards, the board and hands tabled at showdown) and recomputes every hash. It checks that the audit is for the hand and seat it asked about, and compares it with the commitments, chain head and hole-card digest the browser recorded during play. Mucked and undealt cards are never revealed to players. The full sealed record (deck order and salts) is available only to ADMIN users through `/api/admin/hands/:handUuid/audit`. That route replays each hand's outcome and checks the per-table chain.

Game state, sealed audits and hole cards are encrypted with AES-256-GCM and record-specific authenticated context. The database connection verifies TLS certificates. Transactions lock each table and atomically update chips, seats, encrypted state, completed history and the audit record. Revisions reject replayed or stale actions. The runtime database role cannot update or delete completed history, including its audit columns.

Back up `GAME_ENCRYPTION_KEY` in a secret manager: losing it makes saved games and sealed audits unreadable. Rotation needs a controlled decrypt/re-encrypt migration. Production refuses to start unless TLS is configured: either `TLS_CERT_FILE`/`TLS_KEY_FILE`, or `TRUST_PROXY_HOPS >= 1` behind a TLS-terminating proxy. It also requires strict database TLS, separate JWT secrets, and TLS for Redis when Redis is enabled. Apply migration `20260924120000_compliance_audit_trail` before deploying to a new database; the game server now refuses to start if its audit columns are missing. The migration was applied to OnlinePoker on 2026-09-28 and recorded in both Supabase and Prisma migration histories.

This is a play-chip application. The engine is built toward GLI-19/MGA technical expectations but is **not certified**. Laboratory RNG certification, external anchoring of audit hashes, KYC, responsible-gaming controls, anti-collusion operations and real-money accounting are not in place.
