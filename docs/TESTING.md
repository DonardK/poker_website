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
| Engine (Jest) without RNG | `npm test -w @poker/engine -- --testPathIgnorePatterns /node_modules/ "rng\.test\.ts$"` | none | ~3.5-4.5 min, 439 tests, 15 files |
| RNG certification (Jest) | `node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/engine/jest.config.cjs --runInBand rng` | none | ~70-80 s, 47 tests (about +60 s per failed-then-repeated family) |
| Server (node:test) | `npm run build:core && npm test -w @poker/server` (with `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` set to random test values, as CI does; there is no `.env`) | none (dead loopback URL) | ~1 min incl. build, 139 tests |
| Ledger unit | `cd apps/server && node test/support/run-tests.mjs --import tsx test/money-amounts.test.mjs test/money-flows.test.mjs` | none | ~1 s, 24 tests |
| Real PostgreSQL (`test:db`) | `npm run test:db` | disposable embedded PostgreSQL 18 | ~2 min incl. build and cluster start, 94 tests (see below) |
| Browser (Playwright) | `npx playwright install chrome` once, then `npm run build:core && npm run test:browser -w @poker/web` | none (fixture server) | ~19 min, 316 tests (158 specs x desktop + mobile), plus ~1-2 min for next dev start-up |
| Edge API (Vitest in workerd) | `node apps/server/test/support/pg.mjs --exec "npm test -w @poker/edge"`; one file: `... --exec "npm test -w @poker/edge -- test/passkeys.test.ts"` | disposable embedded PostgreSQL (Durable Object and payments `*.db` suites); the HTTP suites use an in-memory database | ~6 min, two projects: poker-api 474 tests in 31 files, poker-payments 47 tests in 3 files |
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
server code connects as that role), `POKER_TEST_PAYMENTS_DATABASE_URL` and
`POKER_TEST_BACKOFFICE_DATABASE_URL` are the payments Worker's login
(`poker_payments_app`) and the back-office login (`poker_backoffice_app`), each
with a random password set by `pg.mjs`, and `POKER_TEST_ADMIN_DATABASE_URL` is
the cluster superuser (fixtures and catalog inspection only). The same run also
exports `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_PAYMENTS`,
which `apps/edge/vitest.config.ts` turns into a test-only `HYPERDRIVE_PAYMENTS`
binding (poker-api's `wrangler.jsonc` never has it).

| File | Proves |
| --- | --- |
| `migrations.test.mjs` | Every migration applies from scratch, in order, into a brand-new database with `prisma migrate deploy`; each is recorded finished, never rolled back, with the checksum of the file in the repository; `prisma migrate status` is clean; a second deploy is a no-op; `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --exit-code` finds **no drift** between `schema.prisma` and the migrated database (with a positive control showing the same command does detect an added column). |
| `privileges.test.mjs` | RLS enabled and forced on every table in `public` except `_prisma_migrations`, each with a policy; PUBLIC holds nothing on any table, sequence or SECURITY DEFINER function, and no CREATE on `public`; `poker_server`'s privileges equal an explicit matrix (a new table fails the test until it is added deliberately); it cannot UPDATE/DELETE/TRUNCATE `Hand`, `HandPlayer`, `HandAction`, `HandPot`, cannot DELETE `User`/`Table`, cannot write the ledger tables or their sequences, cannot read `_prisma_migrations`, cannot CREATE in `public` or ALTER/DROP policies and RLS; it is not superuser/BYPASSRLS/CREATEROLE/CREATEDB and is a member of no role; it may execute only `ledger_post` and `ledger_ensure_account` among SECURITY DEFINER functions; on the account-security tables it may UPDATE only the listed columns (never a secret, hash or binding), and it can mint a `StepUpGrant` but never consume, change or delete one. |
| `account-security.test.mjs` | The account-security schema (migration `20261019100000_account_security`) on a private database that gets every earlier migration, then live and ended human and guest sessions, then this migration: only guest sessions that had not ended are revoked (`GUEST_RETIRED`) and new columns take their defaults; a `StepUpGrant` refuses `PASSWORD` for money, `admin_payments` without a passkey and a lifetime over 5 minutes; a consumer holding only SELECT + UPDATE (`consumedAt`) (the wallet's planned grants) consumes a grant once, never after expiry, and can change nothing else (trigger `SU001`: the database clock decides expiry, `consumedAt` must be the time of use, and `poker.break_glass` is a hatch for an administrator only, not for a role that merely sets it); `StepUpEmailChallenge` limits; `AccountSecurityEvent` is append-only; the CHECKs on secrets, hashes and auth methods; forgetting a device keeps its sessions, removing a session removes its grants. |
| `concurrency.test.mjs` | Real races against the **built** `TableManager` (forced overlap: the contended row is held by a superuser transaction until every racer is seen blocked on it in `pg_stat_activity`): one user claiming seats at two tables at once gets exactly one seat and one bankroll debit (with money for both buy-ins, and for one); two users racing for one seat: one wins, the loser's bankroll is untouched; a double-submitted claim at one table; `standUp` racing the Hand Clean-up of a settled hand in both lock orders, and a pending leaver's repeated `standUp` racing the Clean-up that pays them: credited exactly once; the last player leaving racing a newcomer's claim (closure in the same commit as the cash-out, the refused newcomer charged nothing). Every test checks that Σ bankrolls + Σ seat stacks is conserved. Timers are off; the test calls what the timers would. |
| `ledger-foundation.test.mjs` | The money ledger (migrations `20261002200000_ledger_foundation` and the wallet's): double-entry posting rules, idempotency, append-only journal, balance reconstruction, overflow bounds and concurrent postings, each posting made by the role that owns its type (runtime, payments with its bound payment row, back office with a ticket and a second approver); `LEDGER_TYPE_FORBIDDEN` for every forbidden (role, type) pair; the `CHARGEBACK_RECOVERY` and `WITHDRAWAL_RETURN` shapes; 1,000+ random postings by all three roles that reconstruct, sum to zero per asset and are all bound (see `docs/money/LEDGER.md`). |
| `payments-schema.test.mjs` | The wallet schema (migration `20261019120000_payments_wallet`) on a private database: `apps/edge/src/payments/state.ts` equals the guard triggers' transition arrays and the status enums; an exhaustive N x N status matrix for Deposit, Withdrawal, PayoutDispatch and PaymentInstrument, as `poker_payments_app`, refuses exactly the undocumented pairs (PM003); initial states, write-once identity, amounts and ledger links (PM002); a `PaymentEvent` changes only its processing state, once; payments deletes nothing and the superuser only with `poker.break_glass` (never a dispatch); payment binding (`LEDGER_UNBOUND_PAYMENT` for a posting without its row, with another amount, or a second credit of one deposit; never release and settle); `TEST_EUR` isolation for provider accounts, deposits, cards, quotes and refunds; a player's payout destination and withdrawal need a consumed step-up grant of the right purpose, bind and session, the 24 h cooling-off floor holds and `User.securityHoldUntil` blocks both. |
| `supabase-shape.test.mjs` | Every migration on a cluster of its own shaped like the production Supabase project: a non-superuser migration role (CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS), `anon`/`authenticated`/`service_role` with Supabase's default privileges, and `poker_server` already a LOGIN role. `prisma migrate deploy` applies everything; the payments roles exist without a password and with time zone UTC; `poker_server` stays the LOGIN runtime (no `poker_app`); no Supabase role keeps a privilege on an application table, sequence or SECURITY DEFINER function; EUR stays disabled and every `PaymentSwitch` off; each login passes the wallet's role isolation check; a second deploy applies nothing. |

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

Accounts (there is no guest play): the fixture server emulates every auth and
account route of the edge API in memory (`test/support/auth-fixture.mjs`:
sign-up, sign-in by username or email, TOTP and backup codes with real RFC 6238
codes from `totp.mjs`, passkeys, step-up, email links, sessions, devices), sets
`poker_session_hint` like the API, and records every request for assertions
(`/__test/requests`). `test/support/fixtures.ts` stubs the Turnstile script
(`turnstile-stub.js`), resets the accounts before each test and signs the
browser in as `Player-0` unless a spec uses `session: "signed-out"`. Specs:
`auth-gate` (middleware and client redirects, `next=`, the updated-terms
prompt for an account on older or no terms), `login` (identifier, errors, rate
limits, Turnstile reset, a full page load after sign-in so the Turnstile
script stays behind), `signup` (18+/terms, strength, the
recommended-not-forced protection step), `mfa`, `passkeys` (a CDP virtual
authenticator on `localhost`), `account-switch` (remembered accounts, sign-out
across tabs, a refresh still in flight at sign-out is never handed to another
tab), `email-password` (verify, email change, reset and "This wasn't me" links
with the token in the fragment), `security-settings`.

Do not edit `apps/web/src` while the suite runs: `next dev` recompiles and a
test can load a half-written chunk (`ChunkLoadError`).

`test/e2e-live` (`playwright.live.config.ts`, only with `POKER_LIVE_E2E=1`) is a
two-browser hand against local `wrangler dev` and `next dev`; it signs two new
accounts up through `/signup`. It is not part of CI.

## Edge API: Vitest in workerd (`apps/edge/test`)

The tests run inside workerd (`@cloudflare/vitest-plugin`), so a library that
does not work on Workers fails here. The HTTP suites mount the real Hono app
over an in-memory database (`memory-db.ts`, Prisma filter semantics, unique
keys, transaction rollback) and a test mailbox (`attachTestMailbox`); they
never call Have I Been Pwned or Resend (`PASSWORD_BREACH_CHECK=false`, and
the suites that turn it on stub `breach.check` and `fetch`). The Durable
Object suites (`lobby`, `table-actor`) and the `*.db.test.ts` payments suites
need the embedded PostgreSQL.

`npm test -w @poker/edge` (`scripts/test-all.mjs`) runs two Vitest projects and
fails if either fails: `vitest.config.ts` (the poker-api Worker,
`wrangler.jsonc`; no `PAYMENTS` binding, so the wallet is off unless a test
mocks it) and `vitest.payments.config.ts` (the poker-payments Worker,
`wrangler.payments.jsonc`, `PAYMENTS_MODE=sandbox`, fresh random sandbox and
link secrets per run; tests in `test/payments-worker/`). `pg.mjs` exports the
payments login as `HYPERDRIVE_PAYMENTS`; the runtime and superuser bindings
the payments fixtures need (`HYPERDRIVE_TEST_RUNTIME`, `HYPERDRIVE_TEST_ADMIN`:
users, sessions, step-up grants, an ADMIN role) exist only in the test configs
and only for loopback URLs. With `POKER_REQUIRE_DB_TESTS=1` (CI) a database
suite fails instead of skipping when the database is absent. One project:
`... --exec "npm run test:payments-worker -w @poker/edge"`.

| File | Proves |
| --- | --- |
| `auth.test.ts` | Refresh rotation, grace and reuse; one PBKDF2 per login and the same 401 for unknown, guest, bot and wrong; lockout and the familiar-address exemption; registration rules; an existing account accepting a newer terms version (`/auth/terms/accept`); the guest route is a 404. |
| `guest-removal.test.ts` | A surviving guest session is refused at refresh (cookies cleared, `GUEST_RETIRED`, sockets told), at `/me`, at the lobby socket and at the table socket; the new end reasons round-trip in every edge list. |
| `totp.test.ts` | The six RFC 6238 vectors, the ±1 step window, base32, the otpauth URI, sealing under the auth ring (bound to the user), backup-code format, normalisation and per-user HMAC. |
| `mfa-login.test.ts` | Enrolment (setup needs a fresh step-up; wrong and stale codes); the ticket step (no refresh cookie, a device cookie, one PBKDF2); codes and tickets work once; tickets bound to the browser and the credentials version; the second-factor lock (a ticket whose wrong codes start it is spent) and the known-device exemption; backup codes; 503 without the auth secrets; the first step unchanged. |
| `passkeys.test.ts` | A software authenticator through `@simplewebauthn/server`: registration (step-up, stored fields, rename), wrong origin / RP ID / user verification / ceremony type / cross-origin refused, single-use challenges, discoverable sign-in (also for a TOTP account), one 401 body for every credential problem, counter regression, removal and re-adding, the 20-passkey limit, passkey step-up, passkeys off on an IP origin. |
| `recovery.test.ts` | Verification links; forgot (same 202 for unknown, guest, bot and real accounts; hourly cap; Turnstile; the link is issued only after the 202); reset (weak or breached keeps the link, revokes every session, signs nobody in, expiry, TOTP still required); email change (step-up, a taken address leaves the same pending state and notice, confirm, superseded and raced links); "This wasn't me" after a new-sign-in alert (sessions, passkeys, TOTP, devices, reset required, single use, works after an attacker's password change), TOTP restored and email reverted from any notice; the owner's lockdown voids the links mailed to the attacker's address during the incident. |
| `devices.test.ts` | New-sign-in alerts (no storm after rollout, verified email only, details in the email); the device, hint and refresh cookie flags; "keep me signed in" off; a known device bypasses the account lock; sign-in revokes an old refresh cookie's session; listing and forgetting devices. |
| `step-up.test.ts` | The 5-minute window on every step-up route; password and TOTP step-up; password change needs the password; `requireMoneyAuth`; failed step-ups count toward the lock; money grants by TOTP, emailed code (bound, capped, 5 tries, expiry, single use) and passkey (challenge bound to purpose and bind); a first factor enrolled with only the password holds withdrawals; the account overview and paged history; turning TOTP off. |
| `security-races.test.ts` | Parallel guesses (the in-memory database's `hold()` makes every request read before any writes): the emailed step-up code gets at most its 5 tries, a TOTP sign-in ticket at most 5 before the lock, and step-up TOTP and `reauth/mfa` share the account-wide cap. |
| `mail.test.ts` | The Resend request and retry policy; the sink on http and https; HTML escaping; no token, code, password or address in any log line. |
| `breached.test.ts` | The range request (prefix only, padding), breached / ok / unknown, fail-open at registration, the username rule. |
| `rate-limits.test.ts` | `RL_CREDENTIALS` and `RL_EMAIL` cover their routes, with the right keys. |
| `sweep.test.ts` | The daily housekeeping deletes only rows that can no longer matter. |
| `config.test.ts` | The account-security settings parse; a partial, malformed, placeholder or reused value (or `RESEND_API_KEY` without `MAIL_FROM`) never throws, turns only its feature off and is reported by name; safety switches fall back to their strict value; the settings play needs stay fatal only for what was refused before (plus the `test-only` marker); weak production secrets are reported, random hex secrets accepted. |
| `tables-http.test.ts`, `health.test.ts`, `lobby.test.ts`, `table-actor.test.ts` | Tables over HTTP, health, and the Durable Objects against PostgreSQL. |
| `payments/money-port.unit.test.ts` | The edge ledger port (`src/money/*`): every posting type has one entry point and `post()` calls exactly that SQL function; the `CHARGEBACK_RECOVERY` and `WITHDRAWAL_RETURN` plans balance, drop zero legs and refuse PLAY; accounts resolve in one global order; idempotency keys (`keys.ts`) are deterministic, under 200 characters and in the database's format even for hostile provider ids. |
| `payments/money-errors.unit.test.ts` | `toLedgerError` reads the SQLSTATE from every driver shape (adapter-pg raw and model errors, Prisma's library engine, node-postgres); `moneyTx` runs READ COMMITTED with its timeouts first and `SET CONSTRAINTS ALL IMMEDIATE` last, retries serialization, deadlock, write-conflict and unique races, retries a timeout once, turns domain refusals into `PaymentsRefusal` and bugs into a logged `PaymentsInvariant` (alert `PAYMENTS_INVARIANT`, no message text). |
| `payments/money-errors.db.test.ts` | The same through the Workers' Prisma client and `@prisma/adapter-pg` on the embedded PostgreSQL, as the runtime login and the payments login (test-only `HYPERDRIVE_PAYMENTS`): `LEDGER_TYPE_FORBIDDEN`, 42501 both ways, `LEDGER_INSUFFICIENT_FUNDS`, 40001 and 40P01; a credit without its Deposit refused at `SET CONSTRAINTS` and rolled back; a bound `TEST_EUR` credit commits after a retried serialization failure; a guard refusal from a model query is an invariant. Skips without the database unless `POKER_REQUIRE_DB_TESTS=1`. |
| `payments/state.unit.test.ts` | The payments state machines (`src/payments/state.ts`) pair by pair, the money rules they fix (no way back from SUBMITTED, late successes creditable), the player display status, `rpcFail` statuses (a step-up is 403, never 401) and step-up binds (`stepUpBind`: SHA-256 of the canonical action). |
| `payments/config.unit.test.ts` | `readPaymentsConfig`: `off` needs nothing and never throws; sandbox in production, live without Cloudflare Access, outside production, with the sandbox, without countries or on http, and a contradicting `SETTLEMENT_ASSET` are refused; a provider without usable secrets (missing, short, placeholder, reused) closes only its rail; sandbox mode books real providers under `sandbox-<name>` keys in their test environments; USDT is never offered to EEA residents and prepaid cards never allowed. |
| `payments/core.unit.test.ts` | The withdrawal rules (`rules.ts`: auto-approval only without a reason; two approvals at the dual threshold, for high risk, a shared destination and in live mode; `LOW_PLAY` always present in Phase 1); keccak-256 and payout addresses (EVM EIP-55, BTC P2PKH/P2SH/bech32/bech32m, TRON base58check, broken checksums refused); `remainingCapacity`; the sandbox provider's signatures (wrong secret, tampered body, stale timestamp refused before anything is read), payout scenarios by the cents and dedupe on our key, signed page links and KYC tokens; the gate order (the settlement asset, then the flow's switch, a missing switch row being off, then the rail) and the region rule (live only in `REAL_MONEY_COUNTRIES`, never Tor or an unknown country). |
| `payments/flows.db.test.ts` | The payments flows on the embedded PostgreSQL through both production logins (`poker_payments_app`, `poker_app`) with the built-in sandbox provider and a movable clock; Σ balance = 0 per asset at the end. Deposits: credited once under 12 concurrent replays and re-sent events, out-of-order and forged or stale webhooks change nothing, prepaid refund hold, chargeback freezes, crypto underpayment waits for review, a credit over the daily limit keeps only the part within it, a payment after self-exclusion is refunded in full to the card, concurrent deposits cannot pass a daily limit, a limit raise waits 24 h while a cut is immediate and cancels it, Idempotency-Key replay and conflict. Withdrawals: no double spend (concurrent requests, one quote and grant replayed), a grant for another quote, session or purpose, expired or used is `STEP_UP_REQUIRED`, the security hold. Admin and dispatch: no self-approval, settle with the fee; a timed-out payout is queried, never re-sent; a lost payout is re-sent with the same key only after two NOT_FOUND answers 10 minutes apart; 24 h of uncertainty is MANUAL with a CRITICAL issue and two admins resolve it; a declined payout releases the hold; a returned payout comes back once; three concurrent dispatch units make one provider call. Disputes: a chargeback after a payout cancels the open withdrawal first, books the shortfall to `CHARGEBACK_LOSSES`, and a won dispute gives the player's part back pro rata. `TEST_EUR` and real providers never mix; destinations need a bound `payout_destination` grant and cool off 24 h; `securityLockdown`; limit and exclusion times are UTC whatever the session's time zone. A crypto refund to an address an administrator named is stopped like a payout (a lockdown, a freeze, a hold, a revoked address; the database refuses to submit to an inactive destination, `PM010`), and no address is named while the account could not withdraw; an administrator cannot loosen their own restriction; screening decided by a person (a match is one admin and closes deposits, `CLEAR` is two after the last change, never one's own); a deposit paid with another card than the saved one it named goes to review as `CARD_MISMATCH` and cannot be credited. |
| `wallet-http.test.ts` | poker-api's wallet and payments admin routes over the memory database with a mocked `PAYMENTS` binding: without the binding the wallet shows play chips only and every money route is 403 `REAL_MONEY_DISABLED`; the forwarded caller (session, address, Cloudflare country); Idempotency-Key required (UUID v4), 201 new / 200 replay; refusals keep their documented status and body (`STEP_UP_REQUIRED` 403 with purpose, bind and methods); security hold and unverified email stop grant actions before payments is asked; a dropped binding or malformed answer is 503 with Retry-After; `RL_CREDENTIALS` by account for state-changing routes and by IP for the not-me link; the cross-site check; deposit limits; admin routes (403 for non-admins, the Access JWT forwarded, 401 without it when Access is configured); "This wasn't me" from a payments email ends every session, sets the hold and records `NOT_ME_REPORTED`, works once (a replay, even concurrent, changes nothing) and is void when sent at or after the incident of a later account lockdown; the screening decision route; the account lockdown hook calls `securityLockdown` and never throws. |
| `payments-worker/emergency-stop.db.test.ts`, `reconcile.db.test.ts` (payments project) | Suites that flip cluster-wide state (the emergency stop, a seeded ledger mismatch), so they run in this project: after the API project, one file at a time. Among them: a named crypto refund marked by a lockdown during a stop is cancelled, never sent, after it. |
| `payments-worker/worker.test.ts` (payments project) | The poker-payments Worker itself: `/health` without secrets; 404, 401, 405 and 413 on the public routes; the RPC surface is exactly the `PaymentsApi` methods (the helpers holding the database client are `#private`); `PAYMENTS_MODE=off` answers an off summary and `REAL_MONEY_DISABLED`; a refused configuration moves nothing; a dead session is FORBIDDEN; a full sandbox journey through the pages (KYC, limits, a switch turned on through the admin RPC, a hosted card payment credited once); the `PayoutDispatcher` alarm re-arms. |

Known on this Windows laptop: 4 to 5 `table-actor` tests time out at Vitest's
5 s default when the whole suite runs in parallel; they pass with a longer
timeout. They are speed limits of the machine, not functional failures. The
cold-start `health` request has its own 30 s timeout for the same reason.

## Deploy configuration

`node --test deploy/test/deploy-config.test.mjs` statically checks the edge
configs (Caddy, nginx), the Dockerfiles, `.dockerignore` and
`docker-compose.yml` for the security properties described in
`deploy/README.md`.

## Continuous integration (`.github/workflows/cloudflare.yml`)

Node 24, `npm ci`, on every push to `main`, every pull request, nightly and on
demand. Check jobs set `DATABASE_URL` and `DIRECT_URL` to a loopback port with
nothing listening, and they do not receive `SUPABASE_DIRECT_URL`. Jobs: **typecheck**
(`npm run typecheck`, including `apps/edge` source and tests); **engine** (Jest
without `rng.test.ts`); **server** (`npm test -w @poker/server` plus the ledger
unit tests, with random throwaway secrets because there is no `.env` in CI);
**test-db** (`npm run test:db`); **edge** (both Vitest projects with
`POKER_REQUIRE_DB_TESTS=1`, schema parity, money parity (`npm run check:money -w @poker/edge`),
a Wrangler dry-run of poker-api, `assert-payments-config.mjs` and dry-runs of
poker-payments for production and preview; CI never deploys poker-payments);
**web** (Next.js production build and the OpenNext build);
**playwright**; **audit** (`npm audit --omit=dev
--audit-level=high`); **secrets** (gitleaks over the full history); **rng-nightly**
(the full RNG suite, scheduled and manual runs only). The default-branch deploy
job is the only one that reads `SUPABASE_DIRECT_URL`, and only for `prisma migrate`
deploy`. The workflow does not run `prisma migrate dev`, `prisma db push`,
`prisma db seed`, or `npm run dev`.

Known CI gap: `package-lock.json` was generated on Windows and lacks the
linux-x64 native packages of lightningcss, `@tailwindcss/oxide`, esbuild and
sharp (npm/cli#4828). Each job runs
`.github/workflows/support/platform-binaries.mjs`, which installs exactly the
missing versions with `npm install --no-save`. Regenerate the lockfile so it
lists every platform, then delete that step. The same gap affects the Linux
Docker images (`npm ci` in the Dockerfiles).
