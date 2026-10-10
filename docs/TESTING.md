# Testing

Every automated suite in this repository: what it proves, how to run it, how
long it takes, and the rules that keep tests away from the live database.
Continuous integration runs all of them (`.github/workflows/cloudflare.yml`, table at
the end).

## Live-database safety rules (read first)

The repository `.env` points at the **live production database**. Server code
(`apps/server/src/config.ts`) and `apps/server/prisma.config.ts` load it with
dotenv, which fills in any variable that is not already set. So:

1. **Never run Prisma against `.env`.** No `prisma migrate dev|deploy|reset`,
   `prisma db push|pull|seed`, `npm run db:migrate|db:seed|db:reset` or
   `prisma studio` from a shell where `.env` is in effect. Migrations reach the
   live database only through the procedure in [DEPLOYMENT.md](DEPLOYMENT.md#5-applying-migrations-to-the-live-database).
2. **Server tests run only through `apps/server/test/support/run-tests.mjs`.**
   It sets `DATABASE_URL`/`DIRECT_URL` before any test module loads, to a dead
   loopback port (`127.0.0.1:1`), or to `POKER_TEST_DATABASE_URL` when that is
   a loopback URL (it refuses any other host), and empties `REDIS_URL`. Never
   run `node --test test/...` directly.
3. **Real-database tests run only inside `apps/server/test/support/pg.mjs`.**
   It starts a disposable embedded PostgreSQL 18 on `127.0.0.1` (free port,
   temporary data directory, random passwords), applies every migration with
   the project's own `prisma migrate deploy`, and refuses to run Prisma unless
   it has proved (by evaluating `prisma.config.ts` with the exact environment)
   that every URL Prisma would use is that cluster. The cluster and its files
   are deleted on exit, on Ctrl-C and on a crash.
4. **Never start the server against `.env`** (`npm run dev`, `npm start`,
   `node apps/server/dist/index.js`): it connects at once and `recover()`
   writes to live tables. For local development use `docker-compose.yml` with
   its own env file (see its header), never the repository `.env`.
5. The browser suite needs no database: it runs the web app against a fixture
   game server (`apps/web/test/support/game-server.mjs`) that imports no
   configuration.

## Suites at a glance

| Suite | Command (from the repository root) | Database | Time (Windows dev laptop) |
| --- | --- | --- | --- |
| Engine (Jest) without RNG | `npm test -w @poker/engine -- --testPathIgnorePatterns /node_modules/ "rng\.test\.ts$"` | none | ~4.5 min, 430 tests, 14 files |
| RNG certification (Jest) | `node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/engine/jest.config.cjs --runInBand rng` | none | ~70-80 s, 47 tests (about +60 s per failed-then-repeated family) |
| Server (node:test) | `npm run build:core && npm test -w @poker/server` | none (dead loopback URL) | ~55 s incl. build, 115 tests |
| Ledger unit | `cd apps/server && node test/support/run-tests.mjs --import tsx test/money-amounts.test.mjs test/money-flows.test.mjs` | none | ~1 s, 21 tests |
| Real PostgreSQL (`test:db`) | `npm run test:db` | disposable embedded PostgreSQL 18 | ~1.5-2 min incl. build and cluster start (see below) |
| Browser (Playwright) | `npx playwright install chrome` once, then `npm run build:core && npm run test:browser -w @poker/web` | none (fixture server) | ~9 min, 156 tests (78 specs x desktop + mobile), plus ~1-2 min for next dev start-up |
| Deploy configuration | `node --test deploy/test/deploy-config.test.mjs` | none | seconds |

`npm test` at the root runs `build:core` and then every workspace's `test`
script (engine Jest **including** the RNG suite, and the server suite).

## Engine: Jest (`packages/engine/src/__tests__`)

Pure TypeScript, no I/O beyond reading the engine's own sources. Run from the
root with `npm test -w @poker/engine` (all files) or a pattern:
`npm test -w @poker/engine -- leakage`.

What it proves, by file:

- `table.test.ts`, `leave-flow.test.ts`, `table-lifecycle.test.ts`,
  `turn-clock.test.ts`, `review-fixes.test.ts`: the table state machine
  (seating, blinds, betting rounds, all-ins, leaving mid-hand, sit-out, idle
  warning and closure, turn clock), with chip conservation on every path.
- `pots.test.ts`, `pots-reference.test.ts`: side pots and odd chips against an
  independent reference implementation over random hands.
- `evaluate.test.ts`, `evaluate-exhaustive.test.ts`: hand evaluation; all
  2,598,960 five-card hands classified with the exact category counts.
- `leakage.test.ts`: no projection sent to a player ever contains another
  player's hole cards, the deck or the seed (thousands of complete hands).
- `audit.test.ts`, `security.test.ts`: the hash-chained audit trail and deck
  commitment verify, and tampering is detected.
- `bots.test.ts`, `deck.test.ts`: bot decisions are legal; the deck is valid.
- `rng.test.ts`: see below.

### RNG certification suite (`rng.test.ts`)

GLI-19-style evidence for the shuffle: zero-bias rejection sampling (proved
exhaustively), the Durstenfeld shuffle as a bijection (exhaustive for n <= 8),
chi-square tests over 1,000,000 production `shuffledDeck()` calls (positions,
cards, the global 52x52 statistic, successive-shuffle independence) and
1,000,000 `shuffle()` calls on 5 items (all 120 permutations), the continuous
health test of the CSPRNG stream (fault injection), negative controls that
prove the analysis rejects bad shuffles, and a static scan (no `Math.random`,
no seeded or HMAC shuffle). It prints every statistic and p-value.

**Two-stage families.** Each of the five statistical families is tested at
1.6e-4 per stage. A family that fails is re-run on a fresh, independent
sample (another 1,000,000 production calls) and the suite fails only if the
repeat fails too; both p-values and the offending row's cell counts are
printed. A healthy RNG therefore fails a family with probability about
alpha^2 (< 4e-8), and the whole file with probability < 1e-6 per run (the
header of `rng.test.ts` has the derivation). The retry decision itself is
unit-tested with forced p-values. Real defects (bias, Sattolo, repeated or
too-regular output) fail with p < 1e-50 on every sample, so they still fail.
If CI reports `two-stage FAIL (failed on two independent samples)`, treat it
as a real finding.

CI runs the engine suite without `rng.test.ts` on every push and the full RNG
suite nightly (and on demand via "Run workflow").

## Server: node:test (`apps/server/test`)

`npm test -w @poker/server` builds the server (`tsc`) and runs the listed
files through `run-tests.mjs`; the tests import the **built** `dist/` code.
Persistence is an in-memory stand-in for Prisma with the same transaction
boundary, so no database is involved.

- `security.test.mjs`, `compliance.test.mjs`: encryption, leak guard, the
  audit record written with every hand, compliance invariants over many hands.
- `game-flow.test.mjs`, `human-tables.test.mjs`, `table-lifecycle.test.mjs`:
  full games over real Socket.io; seat claims, leaving, idle warning and
  closure, restart recovery; every player paid exactly once.
- `auth-http.test.mjs`, `auth-socket.test.mjs`: session lifetime, refresh
  rotation and reuse detection, revocation, login lockout, socket
  re-validation.
- `platform-config.test.mjs`, `platform-crypto.test.mjs`,
  `platform-http.test.mjs`: start-up configuration refusals, the encryption key
  ring and `scripts/rotate-game-key.mjs`, HTTP hardening (TLS gate, proxy
  trust, limits, health vs readiness).

`test/integration.test.mjs` (`npm run test:integration -w @poker/server`) is a
legacy end-to-end test that expects a running server; it is not part of CI.

### Ledger unit tests

`money-amounts.test.mjs` (exact decimal/minor-unit arithmetic) and
`money-flows.test.mjs` (posting plans and the ledger client against a fake
`$queryRaw`). They import TypeScript sources, hence `--import tsx`. Not in the
`test` script; CI runs them in the server job.

## Real PostgreSQL: `npm run test:db`

`npm run test:db` (root: builds the shared and engine packages, then
`npm run test:db -w @poker/server`: builds the server, then
`node test/support/pg.mjs --exec "node test/db/run-all.mjs"`). `run-all.mjs`
runs every `test/db/*.test.mjs` through `run-tests.mjs --import tsx` and
refuses to start without the cluster URLs. To run one suite:
`cd apps/server && node test/support/pg.mjs --exec "node test/db/run-all.mjs privileges"`.

Inside a run, `POKER_TEST_DATABASE_URL` is the runtime role `poker_server`
(what production uses; `run-tests.mjs` makes it `DATABASE_URL`, so the built
server code connects as that role) and `POKER_TEST_ADMIN_DATABASE_URL` is the
cluster superuser (fixtures and catalog inspection only).

| File | Proves |
| --- | --- |
| `migrations.test.mjs` | Every migration applies from scratch, in order, into a brand-new database with `prisma migrate deploy`; each is recorded finished, never rolled back, with the checksum of the file in the repository; `prisma migrate status` is clean; a second deploy is a no-op; `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --exit-code` finds **no drift** between `schema.prisma` and the migrated database (with a positive control showing the same command does detect an added column). |
| `privileges.test.mjs` | RLS enabled and forced on every table in `public` except `_prisma_migrations`, each with a policy; PUBLIC holds nothing on any table, sequence or SECURITY DEFINER function, and no CREATE on `public`; `poker_server`'s privileges equal an explicit matrix (a new table fails the test until it is added deliberately); it cannot UPDATE/DELETE/TRUNCATE `Hand`, `HandPlayer`, `HandAction`, `HandPot`, cannot DELETE `User`/`Table`, cannot write the ledger tables or their sequences, cannot read `_prisma_migrations`, cannot CREATE in `public` or ALTER/DROP policies and RLS; it is not superuser/BYPASSRLS/CREATEROLE/CREATEDB and is a member of no role; it may execute only `ledger_post` and `ledger_ensure_account` among SECURITY DEFINER functions. |
| `concurrency.test.mjs` | Real races against the **built** `TableManager` (forced overlap: the contended row is held by a superuser transaction until every racer is seen blocked on it in `pg_stat_activity`): one user claiming seats at two tables at once gets exactly one seat and one bankroll debit (with money for both buy-ins, and for one); two users racing for one seat: one wins, the loser's bankroll is untouched; a double-submitted claim at one table; `standUp` racing the Hand Clean-up of a settled hand in both lock orders, and a pending leaver's repeated `standUp` racing the Clean-up that pays them: credited exactly once; the last player leaving racing a newcomer's claim (closure in the same commit as the cash-out, the refused newcomer charged nothing). Every test checks that Σ bankrolls + Σ seat stacks is conserved. Timers are off; the test calls what the timers would. |
| `ledger-foundation.test.mjs` | The money ledger (migration `20261002200000_ledger_foundation`): double-entry posting rules, idempotency, append-only journal, balance reconstruction, overflow bounds, privileges and concurrent postings (see `docs/money/LEDGER.md`). |

Typical run on the development laptop: PostgreSQL start plus 7 migrations
~25-37 s, then the four suites in parallel ~20-40 s; with the builds, 1.5-2
minutes. The first run on a machine also extracts the PostgreSQL binaries.

CI runs it on `ubuntu-latest` with the `@embedded-postgres/linux-x64` package
(listed in `package-lock.json`, installed by `npm ci`); no Docker or service
container is needed.

## Browser: Playwright (`apps/web/test/browser`)

`npm run test:browser -w @poker/web` (after `npm run build:core`, and
`npx playwright install chrome` once; CI uses `--with-deps`). Playwright starts
the fixture game server on `127.0.0.1:4107` and `next dev` on
`127.0.0.1:3107` (output in `.next-browser-test`), then runs every spec on a
desktop and a mobile (Pixel 7) Chrome profile, one worker.

Proves the user-facing flows against the real engine through real HTTP and
sockets: the table UI (actions, turn clock, buy-in dialog, connection state),
table lifecycle (leaving, idle warning and closure notices), session handling,
and the legal pages and age/terms gate (`game-flow`, `table-ui`,
`table-lifecycle`, `session`, `shell-legal` specs).

## Deploy configuration

`node --test deploy/test/deploy-config.test.mjs` statically checks the edge
configs (Caddy, nginx), the Dockerfiles, `.dockerignore` and
`docker-compose.yml` for the security properties described in
`deploy/README.md`.

## Continuous integration (`.github/workflows/cloudflare.yml`)

Node 24, `npm ci`, on every push to `main`, every pull request, nightly and on
demand. Check jobs set `DATABASE_URL` and `DIRECT_URL` to a loopback port with
nothing listening, and they do not receive `NEON_DIRECT_URL`. Jobs: **typecheck**
(`npm run typecheck`, including `apps/edge` source and tests); **engine** (Jest
without `rng.test.ts`); **server** (`npm test -w @poker/server` plus the ledger
unit tests, with random throwaway secrets because there is no `.env` in CI);
**test-db** (`npm run test:db`); **edge** (Vitest, schema parity, and a Wrangler
dry-run); **web** (Next.js production build and the OpenNext build);
**playwright**; **audit** (`npm audit --omit=dev
--audit-level=high`); **secrets** (gitleaks over the full history); **rng-nightly**
(the full RNG suite, scheduled and manual runs only). The default-branch deploy
job is the only one that reads `NEON_DIRECT_URL`, and only for `prisma migrate
deploy`. The workflow does not run `prisma migrate dev`, `prisma db push`,
`prisma db seed`, or `npm run dev`.

Known CI gap: `package-lock.json` was generated on Windows and lacks the
linux-x64 native packages of lightningcss, `@tailwindcss/oxide`, esbuild and
sharp (npm/cli#4828). Each job runs
`.github/workflows/support/platform-binaries.mjs`, which installs exactly the
missing versions with `npm install --no-save`. Regenerate the lockfile so it
lists every platform, then delete that step. The same gap affects the Linux
Docker images (`npm ci` in the Dockerfiles).
