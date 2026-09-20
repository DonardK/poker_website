# Texas Hold'em Platform

Play-chip Texas Hold'em with a Next.js client, an authoritative Express/Socket.io server, PostgreSQL transactions, and bots. Supabase OnlinePoker now stores the game data. Redis is optional for Socket.io fanout; it is not the source of game state.

## Run the configured project

The ignored root `.env` contains the limited database login and independent encryption/session secrets. Preserve it securely. Do not copy it into the web application.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. The API and sockets use port 4000. New tables create their own bots; seeding is optional. For a fresh checkout, copy `.env.example` to `.env`, supply the database URL, generate three independent secrets, and configure only `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` in `apps/web/.env.local` if changing the defaults.

## Database and migrations

Canonical migrations are in `apps/server/prisma/migrations`. OnlinePoker has already been initialized and secured. `supabase/migrations` contains the security changes submitted through Supabase MCP; it is not an independent initial schema. See [Supabase setup](supabase/README.md).

For a new local database, start `docker compose up -d`, provide an administrator connection through `DIRECT_URL`, then run `npm run db:migrate`. Use a restricted `poker_server` login in `DATABASE_URL` for the application. The security migration creates that role without a password or LOGIN; an administrator must provision it separately. Never run a reset against OnlinePoker or a database containing real data.

## Verification

```sh
npm run typecheck
npm test
npm run build
node scripts/verify-evaluator.mjs
```

The opt-in integration test creates tagged play-chip fixtures. Use a disposable database with production role restrictions, set `POKER_INTEGRATION_TESTS=1` and a separate `DATABASE_TEST_ADMIN_URL` for cleanup, then run `npm run test:integration -w @poker/server`. The runtime role cannot erase hand histories. `POKER_KEEP_TEST_FIXTURES=1` permits testing without admin credentials but requires explicit administrator cleanup afterwards.

## Security and fairness

The deck uses an operating-system-backed cryptographic random source and unbiased Fisher-Yates shuffling. Salted SHA-256 Merkle commitments let the browser verify each visible card against the initial deck commitment without exposing hidden cards. A failed proof or changing commitment stops that client from playing. Independent randomness still produces streaks and repeated outcomes.

Game state, hidden cards, and audit decks are encrypted with AES-256-GCM and record-specific authenticated context. The database connection verifies TLS certificates. Transactions lock each table and atomically update chips, seats, encrypted state, and completed history. Revisions reject replayed or stale actions. Completed history cannot be updated or deleted by the runtime role, including through parent deletion.

Back up `GAME_ENCRYPTION_KEY` in a secret manager: losing it makes saved games and private audit records unreadable. Rotation needs a controlled decrypt/re-encrypt migration. Production requires HTTPS for web/API, strict database TLS, separate JWT secrets, and TLS for Redis when enabled. Configure trusted proxy hops only for the actual deployment topology.

This is a play-chip application. Commitments detect changes after the initial commitment; they do not prove that an operator did not select a deck beforehand, and the server still knows the deck. Email ownership verification, MFA, anti-collusion operations, independent RNG/security certification, and real-money accounting/compliance are not implemented. See [verification report](SECURITY-REVIEW.md).
