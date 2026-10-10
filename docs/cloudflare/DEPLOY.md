# Cloudflare deploy runbook

This is the operator path for Neon and the two Cloudflare Workers (`poker-api`, `poker-web`). The workflow that checks pull requests and deploys the default branch is [`.github/workflows/cloudflare.yml`](../../.github/workflows/cloudflare.yml). Product behavior and the Wrangler shape are in [ARCHITECTURE.md](ARCHITECTURE.md). The `poker_app` role is in [apps/server/prisma/RUNTIME_ROLE.md](../../apps/server/prisma/RUNTIME_ROLE.md).

The repo-root `.env` is the live Supabase database. Leave it there. Neon URLs go in the shell for a one-off migrate, in the Hyperdrive config, and in the GitHub environment secret `NEON_DIRECT_URL`. They do not go in `.env`, `wrangler.jsonc`, or a Worker secret.

Workers Paid is required. Free-plan CPU is too small for password hashing.

Use these commands:

| Step | Command |
| --- | --- |
| Migrations | `npm run prisma:migrate -w @poker/server` (`prisma migrate deploy`) |
| Hyperdrive | `npx wrangler hyperdrive create … --caching-disabled` |
| Worker secrets | `npx wrangler secret put <NAME>` from `apps/edge` |
| Production deploy | push to the default branch, or re-run that workflow |
| Rollback | `npx wrangler rollback --message "restore previous version"` |

Do not run `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, `prisma db seed`, `npm run db:seed`, `npm run db:reset`, or `npm run dev` against Neon or while the root `.env` is the database you are touching. The dev server deals hands and moves chips. Seed writes fake users.

## 1. Accounts

Use one Cloudflare account for the zone, both Workers, Hyperdrive, Turnstile, and Access. Create a Neon account separate from the Supabase project. Create two GitHub environments named `production` and `preview` (Settings → Environments) before the first deploy. The workflow looks up those names exactly.

On `production`, turn on required reviewers if a push should wait for a person before it migrates.

## 2. Create the Neon project

Create a new Neon project in the region closest to the players. For a European audience that is **AWS eu-central-1** (Frankfurt). Do not reuse the Supabase instance.

In the Neon SQL editor, create a database named `poker` so the name matches local Docker:

```sql
CREATE DATABASE poker;
```

Copy the **direct** connection string (the host has no `-pooler`). It looks like:

```text
postgresql://neondb_owner:PASSWORD@ep-example.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Change the database name to `poker`, keep `sslmode=require`, and keep the user `neondb_owner` for migrations. URL-encode the password if it contains reserved characters. A hex password from the command below does not need encoding.

Hyperdrive is the pooler. The origin hostname is this direct host. A second pooler (`-pooler` in the host, or `pooler.supabase.com`) breaks interactive transactions. [ARCHITECTURE.md](ARCHITECTURE.md) section 4.4 is the rule for this deploy. `RUNTIME_ROLE.md` shows a pooled app URL for the old process that pooled for itself.

Set `apps/edge/wrangler.jsonc` `placement.region` to that same region, for example `aws:eu-central-1`. Set `TABLE_DO_LOCATION_HINT` to the Durable Object hint closest to it. For eu-central-1 use `weur`. The allowed hints are listed in `apps/edge/src/index.ts` (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`, `afr`, `me`).

## 3. Apply migrations

Migrations live in `apps/server/prisma/migrations`. Apply them as `neondb_owner` on the direct host. `apps/server/prisma.config.ts` loads the repo-root `.env` and does not override variables that are already set, so set both URLs in the shell first.

PowerShell, from the repo root:

```powershell
$env:DIRECT_URL = "postgresql://neondb_owner:PASSWORD@ep-example.eu-central-1.aws.neon.tech/poker?sslmode=require"
$env:DATABASE_URL = $env:DIRECT_URL
node -e "const u = new URL(process.env.DIRECT_URL); if (!u.hostname.endsWith('.neon.tech') || u.hostname.includes('pooler') || u.hostname.includes('supabase')) { console.error(u.hostname); process.exit(1) } console.log(u.hostname)"
npm run prisma:migrate -w @poker/server
Remove-Item Env:DIRECT_URL
Remove-Item Env:DATABASE_URL
```

The `node` line prints only the host. Stop if it is not the Neon direct host.

That npm script is `prisma migrate deploy`. It applies pending SQL files and does not seed. Every later production deploy runs the same command from GitHub, with secret `NEON_DIRECT_URL` copied into `DIRECT_URL` and `DATABASE_URL` for that step only. The job refuses to start when the checkout contains `.env`, `apps/server/.env`, or `apps/edge/.dev.vars`, and it refuses a URL that is empty, not `postgresql://`, loopback, a Supabase host (`*.supabase.co`, `pooler.supabase.com`, or any host containing `supabase`), or a pooler host (any host containing `pooler`).

If a migration says it cannot create `poker_app`, create the role in the Neon console (`LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `INHERIT`, no password in git) and run the migrate command again. The migration then grants `poker_server`. Details are in `RUNTIME_ROLE.md`.

## 4. Set the `poker_app` password

The game connects as `poker_app`. Migrations do not set its password. In the Neon SQL editor, connected as `neondb_owner` to database `poker`:

```sql
ALTER ROLE poker_app PASSWORD 'choose-a-long-random-password';
```

Generate the password on your machine and do not commit it:

```powershell
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

`poker_app` is `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, and a member of `poker_server`. `poker_server` stays `NOLOGIN`. The API refuses to boot in production if the login is a superuser, has `BYPASSRLS`, or can `UPDATE` or `DELETE` `"Hand"`.

## 5. Create Hyperdrive

From `apps/edge`, logged into this Cloudflare account (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell for this command only):

```powershell
npx wrangler hyperdrive create poker-neon --connection-string="postgresql://poker_app:PASSWORD@ep-example.eu-central-1.aws.neon.tech/poker?sslmode=require" --caching-disabled
```

The user is `poker_app`. The host is the same direct Neon host as the migration URL, with no `-pooler`. `--caching-disabled` is required: chip moves and seats are read-after-write.

The connection string contains the database password, so it will land in your PowerShell history. After the command succeeds, remove that line from `(Get-PSReadLineOption).HistorySavePath`. Do not commit the transcript.

The command prints a Hyperdrive `id` (32 hex characters). There is no `DATABASE_URL` Worker secret. The password lives only in this Hyperdrive config.

## 6. Put the id in Wrangler

In `apps/edge/wrangler.jsonc`, replace `<HYPERDRIVE_ID_CACHE_DISABLED>` with that id. Leave `localConnectionString` as the localhost placeholder. Do not put a Neon or Supabase URL in the file.

Leave `<PREVIEW_HYPERDRIVE_ID_CACHE_DISABLED>` until section 17. Preview must not use the production id.

Commit the id. It is an account identifier, not a password.

## 7. Turnstile

In the Cloudflare dashboard, open Turnstile and add a widget.

1. Hostname: the production domain.
2. Widget mode: Managed.
3. Pre-clearance: off.

Put the site key in:

- `apps/edge/wrangler.jsonc` var `TURNSTILE_SITE_KEY`
- `apps/web/wrangler.jsonc` var `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
- GitHub production variable `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (section 13)

The secret key is Worker secret `TURNSTILE_SECRET_KEY` (section 8). Do not commit it.

The always-pass site key `1x00000000000000000000AA` and the always-block key `2x00000000000000000000AB` are for local `.dev.vars` and Playwright. The production config check rejects them.

## 8. Worker secrets

From `apps/edge`. Each command prompts. Paste the value. Do not pass it as an argument.

```powershell
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npx wrangler secret put WS_TICKET_SECRET
npx wrangler secret put GAME_ENCRYPTION_KEYS
npx wrangler secret put GAME_ENCRYPTION_ACTIVE_KEY_ID
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Generate three signing secrets, each at least 32 characters, and keep them distinct from each other:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

| Secret | Value |
| --- | --- |
| `JWT_ACCESS_SECRET` | first 32-byte hex string |
| `JWT_REFRESH_SECRET` | second, different |
| `WS_TICKET_SECRET` | third, different |
| `GAME_ENCRYPTION_KEYS` | `k1:` plus a new 64-character hex string (32 random bytes) |
| `GAME_ENCRYPTION_ACTIVE_KEY_ID` | `k1` |
| `TURNSTILE_SECRET_KEY` | the Turnstile secret key |

`k1` is a new ring for an empty Neon database. Names come from `apps/edge/src/env.ts` and [ARCHITECTURE.md](ARCHITECTURE.md) section 4.2. `secret put` creates a Worker version. On a brand-new script, run section 14's first deploy, then these six commands, then the smoke test. Later deploys keep the secrets.

Preview uses the same six names with `--env preview` and different values (section 17).

Local `wrangler dev` reads the same six names from `apps/edge/.dev.vars` (gitignored). Copy `apps/edge/.dev.vars.example`. The Turnstile test secret `1x0000000000000000000000000000000AA` always passes. Do not use it in production.

### Everything the API Worker reads

`apps/edge/src/env.ts` is the list. Bindings come from `wrangler.jsonc`. Vars are the `vars` object (placeholders, safe to commit). Secrets are `wrangler secret put` or `.dev.vars` only.

| Name | Kind |
| --- | --- |
| `HYPERDRIVE` | binding. Local URL is `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in `.dev.vars`, host `127.0.0.1`, user `poker_app` |
| `TABLES`, `LOBBY`, `USER_SESSIONS` | Durable Object bindings |
| `RL_GENERAL`, `RL_CREDENTIALS`, `RL_REFRESH`, `RL_ADMIN`, `RL_WS` | rate-limit bindings |
| `CLIENT_ORIGIN` | var. Production `https://<domain>`. Local `http://127.0.0.1:3000` when using the Next dev proxy |
| `TERMS_VERSION` | var |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | vars |
| `SESSION_IDLE_TTL`, `SESSION_ABSOLUTE_TTL` | vars |
| `DEFAULT_STARTING_BANKROLL` | var |
| `TURN_TIME_BANK_MS` | var |
| `TIME_BANK_INITIAL_MS`, `TIME_BANK_MAX_MS`, `TIME_BANK_REFILL_MS`, `TIME_BANK_REFILL_EVERY_HANDS` | vars |
| `ENABLE_LEGACY_BOTS` | var (`true` or `false`) |
| `TURNSTILE_SITE_KEY` | var. Not a secret. Local test site key `1x00000000000000000000AA` |
| `TABLE_DO_LOCATION_HINT` | var |
| `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN` | vars. See section 12. Empty together only when `CLIENT_ORIGIN` is `http://` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `WS_TICKET_SECRET` | secrets. At least 32 characters, all different |
| `GAME_ENCRYPTION_KEYS`, `GAME_ENCRYPTION_ACTIVE_KEY_ID` | secrets |
| `TURNSTILE_SECRET_KEY` | secret |

`next dev` proxies `/api` and `/ws` to `http://127.0.0.1:8787` (`POKER_EDGE_ORIGIN` overrides the target). Point `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` at the Next origin (`http://127.0.0.1:3000`) so the browser stays same-origin with the refresh cookie (`Path=/api/auth`) and the WebSocket ticket cookie (`Path=/ws`).

## 9. Web environment variables

`NEXT_PUBLIC_*` values are inlined when the web Worker is built. Production is one origin: the page, the API, and the WebSocket share `https://<domain>`. `example.com/api/*` and `example.com/ws/*` are more specific than `example.com/*`, so those requests reach `poker-api`.

Set the same three values in `apps/web/wrangler.jsonc` and in the GitHub `production` environment variables:

| Name | Production value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://<domain>` |
| `NEXT_PUBLIC_SOCKET_URL` | `https://<domain>` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the Turnstile site key |

Set `apps/edge/wrangler.jsonc` var `CLIENT_ORIGIN` to that same origin. Replace every `example.com` route pattern and `zone_name` in both Wrangler files with `<domain>`. Production `workers_dev` stays `false` on both Workers.

The deploy job checks that the file and the GitHub variables agree, use https, and are not `example.com`, `.invalid`, or `workers.dev`.

## 10. Rate-limit namespaces

The namespaces are the `ratelimits` array in `apps/edge/wrangler.jsonc`. They are account-wide integers, created when the Worker is deployed. You do not create them in the dashboard first.

| Binding | `namespace_id` | Limit |
| --- | --- | --- |
| `RL_GENERAL` | `1001` | 120 / 60 seconds |
| `RL_CREDENTIALS` | `1002` | 15 / 60 seconds |
| `RL_REFRESH` | `1003` | 30 / 60 seconds |
| `RL_ADMIN` | `1004` | 30 / 60 seconds |
| `RL_WS` | `1005` | 30 / 60 seconds |

If the first deploy reports that one of `1001`–`1005` is already used in this account, pick an unused positive integer, put it in the file, and keep it. Two bindings that share a namespace share counters. These limits are per Cloudflare location. Postgres lockout is the global control for passwords.

## 11. Domain, DNS, and routes

Add the domain to this Cloudflare account and finish the nameserver move.

Workers routes attach only when the hostname has a proxied DNS record. For an apex with no other origin, create a proxied AAAA record for `@` pointing at `100::`. Set SSL/TLS to Full.

| Worker | Route pattern | Zone |
| --- | --- | --- |
| `poker-api` | `<domain>/api/*` | `<domain>` |
| `poker-api` | `<domain>/ws/*` | `<domain>` |
| `poker-web` | `<domain>/*` | `<domain>` |

Deploy writes these routes from the Wrangler files. The more specific `/api` and `/ws` patterns win over the site catch-all.

Optional zone hardening from [ARCHITECTURE.md](ARCHITECTURE.md) section 10.4: a managed WAF ruleset, bot fight mode, a rate-limiting rule on `POST /api/auth/login`, `/api/auth/register`, and `/api/auth/guest`, and a cache bypass for `/api/*` and `/ws/*`.

## 12. Cloudflare Access for `/api/admin`

Access is the outer gate. The Worker still requires a player session and `User.role === ADMIN` on every admin request. Either check alone is not enough.

1. Open **Zero Trust → Access controls → Applications → Create application → Self-hosted**.
2. Name it `poker admin`.
3. Public hostname: the production domain. Path: `/api/admin`. If the form does not include subpaths, add `/api/admin/*` as well.
4. Add an Allow policy whose Include rule is the operator emails, or a service token for a non-browser client. One-time PIN works when you have no other identity provider.
5. Confirm `/`, `/api/auth/*`, `/api/health`, and `/ws/*` are outside this application.
6. Do not enable "protect this Worker" on `poker-api` or `poker-web`. That would put a login wall in front of the whole site.
7. Copy the application's AUD tag into the Wrangler var `CF_ACCESS_AUD`. Put the team name (the subdomain of `https://<team>.cloudflareaccess.com`, not the full host) into `CF_ACCESS_TEAM_DOMAIN`. Both are vars in `apps/edge/wrangler.jsonc`, not secrets. Set both, or leave both empty. An `https://` `CLIENT_ORIGIN` with either one missing makes `GET /api/admin/*` return 500. An `http://` origin with both empty skips the Access JWT; `User.role === ADMIN` is still required.

Hostname-based Access is the path protection described in Cloudflare's Workers Access docs. A policy with no Allow rule denies every request.

## 13. GitHub secrets and variables

Create the API token under My Profile → API Tokens. The GitHub token needs:

- Account / Workers Scripts / Edit
- Account / Account Settings / Read
- Zone / Workers Routes / Edit, limited to this zone

The token you use on your machine for `wrangler hyperdrive create` also needs Account / Hyperdrive / Edit. The GitHub token does not. Continuous integration does not create Hyperdrive configs or change secrets.

Store the account id from the dashboard overview. Treat it as a secret in GitHub because the workflow reads `CLOUDFLARE_ACCOUNT_ID` from the environment secrets.

### Environment `production`

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `NEON_DIRECT_URL` | `postgresql://neondb_owner:…@ep-….eu-central-1.aws.neon.tech/poker?sslmode=require` (direct host, not `poker_app`, not a pooler, not Supabase) |
| Secret | `CLOUDFLARE_API_TOKEN` | the deploy token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | this account |
| Variable | `NEXT_PUBLIC_API_URL` | `https://<domain>` |
| Variable | `NEXT_PUBLIC_SOCKET_URL` | `https://<domain>` |
| Variable | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the site key |

### Environment `preview`

Create this before enabling previews. Do not add `NEON_DIRECT_URL` to it.

| Kind | Name |
| --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` |
| Secret | `CLOUDFLARE_ACCOUNT_ID` |
| Variable | `NEXT_PUBLIC_API_URL` |
| Variable | `NEXT_PUBLIC_SOCKET_URL` |
| Variable | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` |

The preview URLs are the `workers.dev` origins from section 17, not the production domain.

### Repository

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `CLOUDFLARE_PREVIEW_ENABLED` | `true` only after section 17. Leave it unset until then. |
| Secret | `GITLEAKS_LICENSE` | only if the GitHub organization requires a license for the secret scan |

Suggested branch-protection checks. GitHub shows them as `Cloudflare / <job>`:

- `typecheck`
- `engine`
- `server`
- `test-db`
- `edge`
- `web`
- `playwright`

`audit` and `secrets` are optional required checks. `preview` stays off until you set the variable. `deploy` does not run on pull requests. `rng-nightly` runs on the nightly schedule and on manual runs.

## 14. First deploy

1. Finish sections 2–13. The top-level Wrangler files no longer contain `example.com`, `<HYPERDRIVE_ID_CACHE_DISABLED>`, or a Turnstile test key.
2. Commit the Wrangler edits. Do not commit `.env`, `.dev.vars`, passwords, or `NEON_DIRECT_URL`.
3. Push to `main` (the repository default branch). The workflow runs the checks, then the production job.
4. The production job checks the Wrangler files and the GitHub variables, refuses a bad `NEON_DIRECT_URL`, runs `prisma migrate deploy`, deploys `poker-api` with `--env=""` (the top-level Worker, not `preview`), then runs `npm run deploy -w @poker/web` so the public URLs are inlined from the GitHub variables.
5. A second push waits. The deploy concurrency group is `cloudflare-production-deploy`. In-progress production deploys are not cancelled.
6. If this is the first time the API Worker exists, run the six `wrangler secret put` commands from section 8 now.
7. Smoke-test (section 15).

Manual re-deploy: open that push in the Actions tab and re-run the workflow. `workflow_dispatch` runs the checks and does not deploy.

`npm run deploy -w @poker/web` runs `opennextjs-cloudflare build && opennextjs-cloudflare deploy` in `apps/web`. That deploys the top-level `poker-web` Worker. After `env.preview` exists on the web config, that script still has to deploy the top-level Worker. The API deploy passes `--env=""` for the same reason.

## 15. Smoke test

```powershell
curl.exe -fsS https://<domain>/api/health
curl.exe -fsS https://<domain>/api/ready
curl.exe -fsS -o NUL -w "%{http_code}`n" https://<domain>/
```

`/api/health` returns 200 and JSON with `"ok": true` and `"service": "poker-edge"`. It does not touch the database.

`/api/ready` returns 200 and `{"ready": true}` when Hyperdrive can run `SELECT 1`. A 503 body `{"ready": false, "reasons": ["database"]}` means the Hyperdrive id, the `poker_app` password, or the direct host is wrong. Fix the Hyperdrive config. There is no database URL on the Worker to edit.

The homepage returns 200. Open `/api/admin` in a browser and confirm the Access login appears. Login and register show the Turnstile widget. A player who is not `ADMIN` still gets the app's refusal after Access lets them through.

## 16. Rollback

From the repo root, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell (or an existing `wrangler login` for this account):

```powershell
cd apps\edge
npx wrangler rollback --message "restore previous version" --env=""
cd ..\web
npx wrangler rollback --message "restore previous version"
```

`--message` skips the interactive prompt. With no version id, Wrangler restores the version uploaded before the latest one. `npx wrangler versions list` shows ids; pass one as `npx wrangler rollback <version-id> --message "restore <id>"`.

Rollback limits, from the Workers rollback docs:

- It restores a Worker version (one of the 100 most recent) and sends traffic there.
- It does not roll back Neon. Migrations stay applied. Ship a new forward migration if the schema has to change again.
- It does not roll back Durable Object storage or Hyperdrive's database.
- It cannot cross a Durable Object `exports` lifecycle change.
- Bindings to a resource that was deleted since that version cannot be rolled back onto.

Roll the API and the web Worker back as a pair when a release changed both.

## 17. Optional pull request previews

[ARCHITECTURE.md](ARCHITECTURE.md) allows `wrangler versions upload` or `wrangler deploy --env preview`. This workflow uses `wrangler deploy --env preview`.

`wrangler versions upload` is the wrong tool here. The API config uses Durable Object `exports`, and that command fails on those configs and does not apply Durable Object lifecycle changes. A Version URL also runs with the production resources of that Worker, including the production Hyperdrive, and Version URLs are not issued for Workers that export Durable Objects. Preview has to be a separate Worker and a separate Hyperdrive id.

The preview job runs on pull requests from this repository only when the repository variable `CLOUDFLARE_PREVIEW_ENABLED` is `true`. It uses the GitHub environment `preview`. It does not read `NEON_DIRECT_URL`. It deploys `poker-api-preview` and `poker-web-preview`, then comments the `workers.dev` URLs on the pull request.

Set it up in this order:

1. Create a Neon branch (or a second project) that is not the production database. Apply migrations with that branch's direct `neondb_owner` URL, using the shell method in section 3. Do not store that URL in GitHub.
2. Set a `poker_app` password on that branch (section 4).
3. Create a second Hyperdrive config. Caching stays off. The connection string uses that branch's direct host and `poker_app`:

```powershell
npx wrangler hyperdrive create poker-neon-preview --connection-string="postgresql://poker_app:PASSWORD@ep-preview.eu-central-1.aws.neon.tech/poker?sslmode=require" --caching-disabled
```

4. Put that id in `apps/edge/wrangler.jsonc` under `env.preview.hyperdrive`. It must differ from the production id. `routes` stays `[]` and `workers_dev` stays `true`.
5. Add a preview environment to `apps/web/wrangler.jsonc` if it is not there yet. An omitted `routes` array inherits the production routes, so the array has to be present and empty:

```jsonc
"env": {
  "preview": {
    "name": "poker-web-preview",
    "workers_dev": true,
    "routes": []
  }
}
```

6. Find the account's `workers.dev` subdomain in the dashboard. Set the edge preview var `CLIENT_ORIGIN` to `https://poker-web-preview.<subdomain>.workers.dev`.
7. Set the preview GitHub variables to the API origin, not the production domain:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://poker-api-preview.<subdomain>.workers.dev` |
| `NEXT_PUBLIC_SOCKET_URL` | the same API origin |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | a real site key whose widget allows those hostnames |

8. Put the six secrets on the preview Worker, with different values from production:

```powershell
npx wrangler secret put JWT_ACCESS_SECRET --env preview
```

Repeat for `JWT_REFRESH_SECRET`, `WS_TICKET_SECRET`, `GAME_ENCRYPTION_KEYS`, `GAME_ENCRYPTION_ACTIVE_KEY_ID`, and `TURNSTILE_SECRET_KEY`.

9. Add the preview hostnames to the Turnstile widget.
10. Set the repository variable `CLOUDFLARE_PREVIEW_ENABLED` to `true`.

The preview job checks that the preview Hyperdrive id is real, different from production, and that preview routes are an explicit empty list. It also refuses preview public URLs that use the production host.

## 18. What CI runs

Node 24 (the root `package.json` engine is `>=20.11.0`). Every check job runs `npm ci` with the npm cache. `docs/TESTING.md` still names `.github/workflows/ci.yml`; that file was replaced by `cloudflare.yml`.

On pull requests, and again on a push to the default branch before deploy:

| Job | What it runs |
| --- | --- |
| `typecheck` | Prisma generate for server and edge, then `npm run typecheck` |
| `engine` | Jest for `@poker/engine` except `rng.test.ts` |
| `server` | `npm test -w @poker/server` and the ledger unit tests, with random secrets |
| `test-db` | `npm run test:db` (embedded Postgres 18 on `127.0.0.1`) |
| `edge` | edge Vitest, schema parity, `wrangler deploy --dry-run` |
| `web` | `next build`, then `opennextjs-cloudflare build`, with placeholder public URLs |
| `playwright` | `npx playwright install --with-deps chromium chrome`, then the browser suite |
| `audit` | `npm audit --omit=dev --audit-level=high` |
| `secrets` | gitleaks |

`rng-nightly` runs the full shuffle certification on the nightly schedule and on manual runs. It is not part of deploy.

Check jobs set `DATABASE_URL` and `DIRECT_URL` to `127.0.0.1:1` and a script fails the job if `NEON_DIRECT_URL` or the Cloudflare deploy token is present. Nothing there can open a socket to Neon or Supabase. `test:db` replaces that stub inside its own child process with the embedded cluster, then deletes the cluster.

The production job is the only job that reads `NEON_DIRECT_URL`.
