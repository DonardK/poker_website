# Deployment runbook

How this platform is deployed and operated: topology, configuration,
secrets, database roles, migrations, health and readiness, draining, Redis,
backups, and the pre-launch checklist. The edge configuration itself is in
[deploy/README.md](../deploy/README.md); how every test suite works is in
[TESTING.md](TESTING.md); vulnerability reporting is in
[SECURITY.md](../SECURITY.md).

> **Status.** The Dockerfiles and edge configs were written and reviewed by
> reading; they have not been built or run (see their headers). Build and
> smoke-test them in staging before relying on them. The CI workflow builds
> the code but not the images.

## 1. Topology

One public origin behind a reverse proxy (deploy/README.md has the diagram
and the edge guarantees):

- **Edge** (Caddy `deploy/Caddyfile` or nginx `deploy/nginx.conf`): the only
  host with a public address. TLS 1.2+, HSTS, request-size and rate limits,
  forwarded headers overwritten (never appended). Routes `/api/*` and
  `/socket.io/*` (with WebSocket upgrade) to the API, everything else to the
  web app, and answers `/api/ready` with 404.
- **Web** (`apps/web/Dockerfile`, Next.js on :3000, private).
- **API / game server** (`apps/server/Dockerfile`, Express + Socket.io on
  :4000, private, `HOST` bound to its private interface). Exactly **one**
  instance (section 9).
- **PostgreSQL** (managed, TLS with certificate validation; currently
  Supabase), reached by the API as the least-privileged role `poker_server`.
- **Redis** (optional, private, `rediss://`), only for Socket.io fan-out.

Build the web image per environment with `NEXT_PUBLIC_API_URL` and
`NEXT_PUBLIC_SOCKET_URL` both set to the public origin
(`https://<PUBLIC_HOST>`), and set the API's `CLIENT_ORIGIN` to the same
origin. `docker-compose.yml` is a local development stack only.

## 2. Environment variables

Every variable the code reads today. The API validates its configuration at
import time (`apps/server/src/config.ts`) and refuses to start on a bad or
missing value; with `NODE_ENV=production` it additionally enforces the
production rules noted below. Error messages name the variable, never a
secret value.

### API (game server)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | yes in prod | `development` | `production` turns on every production check below. |
| `PORT` | no | `4000` | |
| `HOST` | no | `0.0.0.0` | Set to the private interface address behind the edge. |
| `CLIENT_ORIGIN` | yes in prod | `http://localhost:3000` | The public origin. Production requires `https://`. CORS and Socket.io origin check. |
| `PUBLIC_API_ORIGIN` | no | unset | Only if the API is on a sibling subdomain; leave unset for one origin (deploy/README.md). |
| `COOKIE_SITE` | no | unset | Registrable domain when `PUBLIC_API_ORIGIN` is set; checked at start-up. |
| `DATABASE_URL` | **yes** | | Runtime role `poker_server`. Production requires `sslmode=require&sslaccept=strict` (and `sslcert=<URL-encoded path to the CA bundle>`, e.g. `apps/server/certs/supabase-pooler-root.pem`). |
| `DIRECT_URL` | migrations only | | **Administrator** URL, read only by `prisma.config.ts` for `prisma migrate deploy`. Never set in the API container. |
| `REDIS_URL` | no | empty (disabled) | Production requires `rediss://`. |
| `GAME_ENCRYPTION_KEYS` | yes (or the legacy key) | | Key ring `kid:hex64,kid2:hex64` (AES-256-GCM keys for table state and hole cards). |
| `GAME_ENCRYPTION_ACTIVE_KEY_ID` | with a multi-key ring | the only key / `k0` | Key that encrypts new writes. |
| `GAME_ENCRYPTION_KEY` | legacy | | Single 64-hex key, ring id `k0` (every `v1.` ciphertext). Keep it in the ring while data written under it is retained. |
| `JWT_ACCESS_SECRET` | **yes** | | >= 32 chars; production rejects placeholders, low entropy and reuse. |
| `JWT_REFRESH_SECRET` | **yes** | | >= 32 chars, independent of the access secret. |
| `JWT_ACCESS_TTL` | no | `15m` | 1-60 minutes. |
| `JWT_REFRESH_TTL` | no | `7d` | 1 hour - 30 days. |
| `SESSION_IDLE_TTL` | no | `JWT_REFRESH_TTL` | Session expires when not refreshed for this long. |
| `SESSION_ABSOLUTE_TTL` | no | `30d` | Hard session end; must be >= the idle TTL. |
| `TERMS_VERSION` | no | `2026-10-01` | Must equal the web app's `TERMS_VERSION` (`apps/web/src/lib/legal.ts`). |
| `TRUST_PROXY_HOPS` | yes behind the edge | `0` | `1` behind the edge. Production without direct TLS requires >= 1. |
| `TRUSTED_PROXY_CIDRS` | yes when hops >= 1 in prod | | The edge's private address(es); only these peers' forwarded headers are believed. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | both or neither | | Direct TLS on the API (no edge). |
| `DEFAULT_STARTING_BANKROLL` | no | `10000` | Play-chip grant for new accounts. |
| `TURN_TIME_BANK_MS` | no | `20000` | 5,000-120,000. |

Production also requires: `CLIENT_ORIGIN` on https; TLS either direct or via
a trusted proxy; database TLS with certificate validation; independent,
strong JWT secrets and encryption keys (`assertProductionSecrets`); a
consistent cookie site.

### Web (build arguments; public)

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOCKET_URL` | Inlined into the browser bundle at build time: never secrets. The public origin for the one-origin edge. |
| `ALLOW_INSECURE_PUBLIC_URLS` | Docker build arg, `0` by default; `1` only for a local smoke test over http. |

### Edge

Caddy: `PUBLIC_HOST`, `ACME_EMAIL`, `API_UPSTREAM`, `WEB_UPSTREAM` (see the
Caddyfile header). nginx: edit the placeholders named in the file header
(`poker.example.com`, upstream addresses, certificate paths).

### Operational scripts and tests (never in the API container)

`apps/server/scripts/rotate-game-key.mjs` takes `--database-url` (an
administrator URL) on the command line plus the key-ring variables above; it
never reads `.env`. Test-only: `POKER_TEST_DATABASE_URL`,
`POKER_TEST_ADMIN_DATABASE_URL`, `POKER_TEST_REDIS_URL`, `POKER_TEST_ISOLATED`
(set by the test harness), `POKER_TEST_DIST_DIR` (Playwright). Local Compose:
`POSTGRES_PASSWORD`, `REDIS_PASSWORD` (`POSTGRES_USER`, `POSTGRES_DB`).

## 3. Secrets management

- **Source of truth: a secret manager** (AWS Secrets Manager / GCP Secret
  Manager / Azure Key Vault / Vault / Doppler), with encryption at rest under
  a KMS key you control and access limited to the deploy pipeline and the API
  runtime identity. The orchestrator injects secrets as environment variables
  at container start. Nothing secret is baked into an image
  (`.dockerignore` excludes every `.env*` and key file) or passed as a build
  argument.
- **Secrets:** `DATABASE_URL` (runtime credentials), `DIRECT_URL`
  (administrator; only the migration job may read it), `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `GAME_ENCRYPTION_KEYS` / `GAME_ENCRYPTION_KEY`,
  `REDIS_URL` (contains the password), TLS private keys.
- **Generate** each independently:
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
- **The repository `.env` must not exist on any server** and must never hold
  production credentials on a developer machine either; it is the reason for
  the safety rules in TESTING.md. Rotate the credentials it currently holds
  once deployment moves to the secret manager.
- **Encryption key rotation** (`GAME_ENCRYPTION_KEYS` ring,
  `apps/server/scripts/rotate-game-key.mjs`):
  1. Generate a new key; add it to `GAME_ENCRYPTION_KEYS` on every API
     instance and make it `GAME_ENCRYPTION_ACTIVE_KEY_ID`; keep the old keys.
     Deploy. New writes use the new key; old ciphertexts still decrypt.
  2. `npm run build -w @poker/server`, then
     `node apps/server/scripts/rotate-game-key.mjs --database-url "<admin URL>"`
     (dry run), then again with `--apply`. Rows are rewritten with a
     compare-and-set, so a live save is never overwritten.
  3. Keep old keys in the ring for as long as retained hand history (sealed
     audits, encrypted hole cards, which are append-only and never rewritten)
     was written under them.
- **JWT secret rotation** signs everyone out (access tokens within 15
  minutes, refresh at once); schedule it.

## 4. Database roles

- **Administrator** (the managed database's owner role, e.g. Supabase
  `postgres`): `DIRECT_URL`, used **only** by the migration job. It owns the
  schema, the SECURITY DEFINER ledger functions and the RLS policies.
- **Runtime role `poker_server`** (created `NOLOGIN` by migration
  `20260920140611_poker_security`; give it a login and a strong password, or
  create a separate login role that is a member of it, out of band): what the
  API's `DATABASE_URL` uses. It is not superuser, cannot bypass RLS, create
  roles or databases, and has no CREATE on `public`. Hand history is
  append-only to it, `User` and `Table` rows cannot be deleted, the ledger
  tables are read-only (balances change only through `ledger_post`), and it
  cannot read `_prisma_migrations`. Every table in `public` has RLS enabled
  and forced. `npm run test:db` (`test/db/privileges.test.mjs`) pins all of
  this against the migrations.
- Supabase's `anon`, `authenticated` and `service_role` have every privilege
  on these tables revoked by the migrations; the browser never talks to the
  database.

## 5. Applying migrations to the live database

Migrations are applied **only** with `prisma migrate deploy` (never `migrate
dev`, `db push` or `db:reset`, which can drop data), by an operator or a
gated pipeline step, through `DIRECT_URL`. They are written to be additive.

Procedure:

1. **Review.** Every migration is code-reviewed, and `npm run test:db` passes
   (it applies all migrations from scratch, checks `migrate status`, the
   absence of schema drift and the privilege matrix).
2. **Back up** (section 10): take an on-demand snapshot and note the PITR
   timestamp.
3. **Pre-checks** (read-only), e.g. for auth_hardening:
   `SELECT lower(username), count(*) FROM public."User" GROUP BY 1 HAVING count(*) > 1;`
   must return no rows.
4. **Quiesce.** Put the site in maintenance at the edge, wait until no hand is
   running (or close tables), then stop the API (SIGTERM drains it, section
   8). Do not run old code against the new schema (see below).
5. **Apply**, from a trusted machine or the migration image, with only the
   administrator URL in the environment and no `.env` present:
   `docker run --rm -e DIRECT_URL poker-migrate` (`apps/server/Dockerfile`
   target `migrate`), or from a clean checkout of the release:
   `cd apps/server && DIRECT_URL='<admin url>' DATABASE_URL='<admin url>' npx prisma migrate deploy`.
   Then `npx prisma migrate status` must say the schema is up to date.
6. **Deploy the matching API and web**, wait for `/api/ready`, smoke-test,
   leave maintenance.
7. **Roll back** by restoring the snapshot (migrations have no down
   scripts), never by editing `_prisma_migrations`.

`supabase/migrations/` mirrors the Prisma migrations as plain SQL for the
Supabase tooling; the Prisma directory is authoritative.

### Pending migrations

- **`20261001100000_auth_hardening`**: case-insensitive unique usernames
  (stored generated column `usernameCanonical` + unique index; the migration
  aborts, changing nothing, if usernames differing only by case exist),
  per-account login lockout (`failedLoginCount`, `lockedUntil`), terms and age
  acceptance columns, and session lifetime, rotation and revocation columns
  on `Session` (`lastUsedAt`, `absoluteExpiresAt` backfilled to at least 7
  days from now and then `NOT NULL`, `previousTokenHash`, `rotatedAt`,
  `revokedAt`/`revokeReason` with a consistency check). No new tables.
  **Compatible with the previous server build during a rolling deploy:**
  `absoluteExpiresAt` is `NOT NULL` with a database default of
  `CURRENT_TIMESTAMP + 30 days`, so an old build that does not set it keeps
  creating sessions (bounded to the absolute lifetime); the new code always
  sets it explicitly. Still deploy the new code promptly after migrating.
- **`20261002200000_ledger_foundation`**: the double-entry money ledger
  (`docs/money/LEDGER.md`): enums, `Asset`, `LedgerAccount`,
  `LedgerTransaction`, `LedgerEntry`, the SECURITY DEFINER functions
  `ledger_post` and `ledger_ensure_account` (the only write path; executable
  by `poker_server`), append-only triggers on the journal, read-only grants
  and RLS for `poker_server`, plus two guards on existing tables:
  `User_guard_privileged_columns` (the runtime role cannot change a user's
  `role` or `kind`) and `Hand_require_audit` (the runtime role cannot insert a
  hand without its audit columns). Additive: no existing row is read or
  changed, and `User.bankroll` stays authoritative until the money flows move
  onto the ledger.

Apply them in that order (Prisma does, lexicographically) in one maintenance
window.

## 6. Health and readiness

- `GET /api/health` (liveness): always 200 `{ok:true,...}` while the process
  runs; no database access, so a database outage does not get healthy
  processes restarted. Used by the Docker `HEALTHCHECK`
  (`deploy/healthcheck.mjs`) and safe for public uptime monitors.
- `GET /api/ready` (readiness): 200 `{ready:true}` only when the database
  answers, the schema check passed (the audit columns exist) and table
  recovery finished; otherwise 503 with `reasons` (`database`, `schema`,
  `recovery`, `draining`). Probe it from the orchestrator over the private
  network; the edge answers it 404 publicly.

## 7. Start-up

`connectRedis()` (if configured), connect to Postgres, `assertGameSchemaReady`
(refuses to serve if the compliance audit columns are missing), create the
HTTP(S) and Socket.io servers, `tableManager.recover()` (reloads every live
table from Postgres, pays any pending cash-outs, closes tables left empty, and
gives every table a full idle timeout after the restart), then listen.

## 8. Graceful drain

On SIGTERM/SIGINT the API: answers `/api/ready` 503 at once; stops accepting
connections; disconnects every Socket.io client (they reconnect, and the table
is reloaded from Postgres); gives in-flight HTTP requests up to 15 s; stops
table timers; closes Postgres and Redis; exits 0. Both images run `tini` as
PID 1 so the signal reaches Node. Give the container a stop grace period of
at least 20 s. Every chip movement is a single database transaction, so a
hard kill loses no money, only the in-memory timers (recovered at the next
start).

## 9. Redis and multiple instances

Run **exactly one API instance**. `REDIS_URL` (production: `rediss://`, private
network, password) lets Socket.io fan events out across processes, but table
processing has no cross-instance ownership (lease or advisory lock) yet: two
processes would both run every table's timers. Deploy by stopping the old
process (drain) before starting the new one, not with an overlapping rolling
update. Multi-instance support needs table ownership first, then sticky
sessions at the edge for Socket.io long-polling.

## 10. Backups and restore drills (outline)

- **Backups:** managed point-in-time recovery (WAL archiving) with at least 7
  days' retention (longer as the regulator requires for financial and game
  records), plus daily logical dumps (`pg_dump -Fc` as the administrator) to
  separate, encrypted, access-controlled storage in another region/account.
  Hand history and the ledger are append-only; retention must cover the
  regulatory period.
- **Keys are part of the backup:** without the `GAME_ENCRYPTION_KEYS` that
  wrote them, stored table states and hole cards cannot be read. Back up the
  key ring in the secret manager (versioned, separate from the data).
- **Restore drill (quarterly and before launch):** restore the latest dump and
  a PITR timestamp into an isolated database; run
  `prisma migrate status` against it; verify row counts and that Σ
  bankrolls + Σ seat stacks matches the source at that time; run the ledger
  reconstruction check (`docs/money/LEDGER.md`); start an API against it in
  an isolated network and load a table; record the time to restore (RTO) and
  the data-loss window (RPO); file the drill report.
- **Incident restore:** stop the API, restore, apply any missing migrations,
  rotate credentials if compromise is suspected, start, reconcile against
  payment/custody provider records.

## 11. Pre-launch checklist

### What the code provides (verify in staging)

- [ ] `npm run typecheck`, all suites in TESTING.md, `npm audit --omit=dev`
      and the gitleaks scan green in CI; the nightly RNG suite green.
- [ ] Images built and smoke-tested; `caddy validate` / `nginx -t` pass; the
      smoke tests at the end of deploy/README.md pass.
- [ ] Production configuration accepted by the start-up checks (TLS,
      `TRUSTED_PROXY_CIDRS`, database TLS, secret strength, cookie site).
- [ ] Runtime role `poker_server` used by the API; administrator URL only in
      the migration job; pending migrations applied (section 5).
- [ ] One API instance; drain verified (SIGTERM during play, then reconnect).
- [ ] Encryption key ring in the secret manager; rotation rehearsed in
      staging.
- [ ] Backups configured and one restore drill done (section 10).
- [ ] Monitoring and alerting: `/api/health` externally, `/api/ready` and the
      logs (`LEAK_BLOCKED`, `table timer failed`, fatal errors) internally.
- [ ] `SECURITY.md` contact placeholders and `/.well-known/security.txt`
      filled in.
- [ ] `THIRD_PARTY_NOTICES.md` regenerated
      (`node scripts/generate-third-party-notices.mjs`) and shipped; LGPL
      (libvips via sharp) source offer and CC-BY attribution (caniuse-lite)
      handled as described there.
- [ ] `package-lock.json` regenerated to include the Linux native packages
      (TESTING.md, "Known CI gap"); without it the Linux images lack the
      lightningcss/Tailwind bindings and sharp.

### What remains external (not provided by this repository)

- [ ] **Licence:** a Malta Gaming Authority (MGA) licence (or the licence of
      each market served) before any real-money play; until then only play
      chips without cash value.
- [ ] **Legal texts approved by counsel:** terms, privacy policy, responsible
      gaming, complaints and game rules (the pages in `apps/web` carry draft
      banners until approved).
- [ ] **KYC / AML provider** (identity, age, sanctions/PEP, source of funds)
      integrated and its policies approved.
- [ ] **Payment and custody providers** (fiat PSP, crypto custody) under
      contract; the ledger integration (`docs/money/LEDGER.md`) completed and
      reconciled against them.
- [ ] **Accredited RNG and game certification** by an approved test lab
      (e.g. GLI-19 or the regulator's equivalent): the RNG suite and audit
      trail here are evidence, not certification.
- [ ] **Independent penetration test** of the deployed platform, with
      findings fixed and retested.
- [ ] Responsible-gambling tooling and policies required by the licence
      (limits, self-exclusion registers), DPO/GDPR obligations, incident and
      complaint procedures, and the regulator's reporting interfaces.
