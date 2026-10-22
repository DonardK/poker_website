# Cloudflare deploy runbook

This is the operator path for the Workers Free-plan demo: one `*.workers.dev` origin, the existing Supabase project, and the two Workers (`poker-web` public, `poker-api` private). The workflow that checks pull requests and deploys the default branch is [`.github/workflows/cloudflare.yml`](../../.github/workflows/cloudflare.yml). Product behavior is in [ARCHITECTURE.md](ARCHITECTURE.md) (section "Demo on the Workers Free plan"). Pending SQL is in [SUPABASE_MIGRATION_PLAN.md](./SUPABASE_MIGRATION_PLAN.md). Roles are in [apps/server/prisma/RUNTIME_ROLE.md](../../apps/server/prisma/RUNTIME_ROLE.md).

The repo-root `.env` is the live Supabase database. Leave it there. The migration URL goes in the shell for a one-off migrate and in the GitHub environment secret `SUPABASE_DIRECT_URL`. The runtime URL goes only into Hyperdrive. Neither goes in `.env`, `wrangler.jsonc`, or a Worker secret.

The demo runs on the Free plan. Password hashing is PBKDF2 at `PASSWORD_PBKDF2_ITERATIONS=10000`. A later paid plan sets that var to `600000` and can add a custom domain; the service binding and Supabase settings stay.

Use these commands:

| Step | Command |
| --- | --- |
| Migrations | `npm run prisma:migrate -w @poker/server` (`prisma migrate deploy`) |
| Hyperdrive | `npx wrangler hyperdrive create … --caching-disabled` |
| Worker secrets | `npx wrangler secret put <NAME>` from `apps/edge` |
| Production deploy | push to the default branch, or re-run that workflow |
| Rollback | `npx wrangler rollback --message "restore previous version"` |

Do not run `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, `prisma db seed`, `npm run db:seed`, `npm run db:reset`, or `npm run dev` against Supabase or while the root `.env` is the database you are touching. The dev server deals hands and moves chips. Seed writes fake users.

## 1. Accounts

Use one Cloudflare account for both Workers, Hyperdrive, Turnstile, and (later) Access. There is no custom domain on this demo, so there is no zone. The database is the existing Supabase project `tgfudufxslhrxbdxcnyl` in `eu-west-1`. Create two GitHub environments named `production` and `preview` (Settings → Environments) before the first deploy. The workflow looks up those names exactly.

On `production`, turn on required reviewers if a push should wait for a person before it migrates.

## 2. Supabase connection

The database already exists: project ref `tgfudufxslhrxbdxcnyl`, region `eu-west-1`. Do not create a second database and do not run SQL from this step until [SUPABASE_MIGRATION_PLAN.md](./SUPABASE_MIGRATION_PLAN.md) says the history check passed.

Two URLs:

| Use | User | Host | Port |
| --- | --- | --- | --- |
| Migrations (`SUPABASE_DIRECT_URL`) | `postgres.<ref>` | `aws-1-eu-west-1.pooler.supabase.com` (session pooler) | 5432 |
| Migrations, alternative | `postgres` | `db.<ref>.supabase.co` | 5432 |
| Hyperdrive runtime | `poker_server.<ref>` | the same session pooler | 5432 |

Port **6543** is transaction mode. The workflow rejects it. Interactive transactions and migrations need session mode or the direct host.

`placement.region` is `aws:eu-west-1`. `TABLE_DO_LOCATION_HINT` is `weur`. A later region change is those two vars plus a new Hyperdrive config. The allowed hints are listed in `apps/edge/src/index.ts`.

## 3. Apply migrations

Run the read-only checks in [SUPABASE_MIGRATION_PLAN.md](./SUPABASE_MIGRATION_PLAN.md) first. Then apply as the Supabase admin on port 5432. `apps/server/prisma.config.ts` loads the repo-root `.env` and does not override variables that are already set, so set both URLs in the shell first. Do not print the URL.

PowerShell, from the repo root, after the history check:

```powershell
$env:SUPABASE_DIRECT_URL = "postgresql://postgres.<ref>:PASSWORD@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require"
$env:DIRECT_URL = $env:SUPABASE_DIRECT_URL
$env:DATABASE_URL = $env:SUPABASE_DIRECT_URL
node .github/workflows/support/assert-supabase-direct-url.mjs
npm run prisma:migrate -w @poker/server
Remove-Item Env:SUPABASE_DIRECT_URL
Remove-Item Env:DIRECT_URL
Remove-Item Env:DATABASE_URL
```

The assert script prints only the host and port. It refuses loopback, port 6543, a non-admin user, and a checkout that still contains `.env` (move that file aside for the command, then put it back). GitHub's production job is the only workflow job that reads `SUPABASE_DIRECT_URL`, and only on this step.

That npm script is `prisma migrate deploy`. It applies pending SQL files and does not seed. On Supabase, `poker_server` stays the runtime login. The migration does not create `poker_app` when `poker_server` can already log in.

## 4. Runtime password

The demo Hyperdrive user is the existing `poker_server` login. Do not create `poker_app` on this project and do not put a new password in a migration. If that login's password is already the one in the ignored root `.env`, reuse it only inside the Hyperdrive create command below. Local docker still uses `poker_app`; that password is not the Supabase password.

The API refuses a login that is a superuser, has `BYPASSRLS`, or can `UPDATE` or `DELETE` `"Hand"`. `poker_server` on this project is outside those three.

## 5. Create Hyperdrive

From `apps/edge`, logged into this Cloudflare account (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell for this command only):

```powershell
npx wrangler hyperdrive create poker-supabase --connection-string="postgresql://poker_server.<ref>:PASSWORD@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require" --caching-disabled
```

The user is `poker_server.<ref>`. The port is 5432. `--caching-disabled` is required: chip moves and seats are read-after-write. Do not point Hyperdrive at the `postgres` admin user or at port 6543.

The connection string contains the database password, so it will land in your PowerShell history. After the command succeeds, remove that line from `(Get-PSReadLineOption).HistorySavePath`. Do not commit the transcript.

The command prints a Hyperdrive `id` (32 hex characters). There is no `DATABASE_URL` Worker secret. The password lives only in this Hyperdrive config.

## 6. Put the id in Wrangler

In `apps/edge/wrangler.jsonc`, replace `<HYPERDRIVE_ID_CACHE_DISABLED>` with that id. Leave `localConnectionString` as the localhost placeholder. Do not put a database URL in the file. Replace `<subdomain>` in `CLIENT_ORIGIN` with the account's `workers.dev` subdomain (`https://poker-web.<subdomain>.workers.dev`).

Leave `<PREVIEW_HYPERDRIVE_ID_CACHE_DISABLED>` until section 17. Preview must not use the production id.

Commit the id. It is an account identifier, not a password.

## 7. Turnstile

In the Cloudflare dashboard, open Turnstile and add a widget.

1. Hostname: `poker-web.<subdomain>.workers.dev` (the web Worker, after the first deploy shows the real host).
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

`k1` is a new ring for tables this Worker will encrypt. Existing Supabase rows that were sealed with the current game key must keep that key; do not invent a second ring for rows that are already encrypted. Names come from `apps/edge/src/env.ts`. `secret put` creates a Worker version. On a brand-new script, run section 14's first deploy, then these six commands, then the smoke test. Later deploys keep the secrets.

Preview uses the same six names with `--env preview` and different values (section 17).

Account security (optional; until they are set, TOTP, passkeys, MFA sign-in and money step-up stay off and answer 503, and play is unaffected). Each `secret put` deploys a new Worker version at once, so put the three `AUTH_*` secrets in one version with `secret bulk`, before or after the deploy. Write the JSON file outside the repository and delete it afterwards:

```powershell
# auth-secrets.json (outside the repo): {"AUTH_HMAC_SECRET": "...", "AUTH_ENCRYPTION_KEYS": "a1:...", "AUTH_ENCRYPTION_ACTIVE_KEY_ID": "a1"}
npx wrangler secret bulk C:\path\outside\repo\auth-secrets.json
```

| Secret | Value |
| --- | --- |
| `AUTH_HMAC_SECRET` | a fourth random string (`randomBytes(48).toString('base64url')`), different from the three above |
| `AUTH_ENCRYPTION_KEYS` | `a1:` plus a new 64-character hex string, never a game key |
| `AUTH_ENCRYPTION_ACTIVE_KEY_ID` | `a1` |

Email: first deploy the `MAIL_FROM` var (an address on a domain verified in Resend, with click and open tracking off) through `wrangler.jsonc`, then `npx wrangler secret put RESEND_API_KEY`.

A partial, mistyped or reused value never stops sign-in, refresh or play: the API leaves that feature off (503 on its routes) and logs `CONFIG_SETTING_IGNORED` with the variable name, once per isolate. Check the Worker logs for it after every secret change. Keep the auth key with the game keys, separately labelled: losing it disables every enrolled authenticator app. On the https origin a placeholder, published, low-entropy or reused auth key or `AUTH_HMAC_SECRET` keeps account security off. For the secrets play depends on, the API still refuses what it always refused (missing or short values, equal JWT and ticket secrets, `change`/`replace`/`development` in them) plus the repository's own `test-only` test secrets; a weak or published game key or a low-entropy JWT secret is accepted so players are not locked out, and logged as `WEAK_PRODUCTION_SECRET`: rotate it.

Local `wrangler dev` reads the same six names from `apps/edge/.dev.vars` (gitignored). Copy `apps/edge/.dev.vars.example`. The Turnstile test secret `1x0000000000000000000000000000000AA` always passes. Do not use it in production.

### Everything the API Worker reads

`apps/edge/src/env.ts` is the list. Bindings come from `wrangler.jsonc`. Vars are the `vars` object (placeholders, safe to commit). Secrets are `wrangler secret put` or `.dev.vars` only.

| Name | Kind |
| --- | --- |
| `HYPERDRIVE` | binding. Local URL is `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in `.dev.vars`, host `127.0.0.1`, user `poker_app` |
| `TABLES`, `LOBBY`, `USER_SESSIONS` | Durable Object bindings |
| `RL_GENERAL`, `RL_CREDENTIALS`, `RL_REFRESH`, `RL_ADMIN`, `RL_WS`, `RL_EMAIL` | rate-limit bindings |
| `CLIENT_ORIGIN` | var. Demo `https://poker-web.<subdomain>.workers.dev`. Local `http://127.0.0.1:3000` when using the Next dev proxy |
| `TERMS_VERSION` | var |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | vars |
| `SESSION_IDLE_TTL`, `SESSION_ABSOLUTE_TTL` | vars |
| `DEFAULT_STARTING_BANKROLL` | var |
| `TURN_TIME_BANK_MS` | var |
| `TIME_BANK_INITIAL_MS`, `TIME_BANK_MAX_MS`, `TIME_BANK_REFILL_MS`, `TIME_BANK_REFILL_EVERY_HANDS` | vars |
| `ENABLE_LEGACY_BOTS` | var (`true` or `false`) |
| `PASSWORD_PBKDF2_ITERATIONS` | var. `10000` on Free. `600000` on Paid |
| `ENABLE_LEGACY_BCRYPT` | var. `false` on the demo. `true` only to accept old bcrypt hashes and rehash them |
| `ADMIN_REQUIRE_CF_ACCESS` | var. `false` on the demo (skip the Access JWT when `CF_ACCESS_*` are unset). `true` for the strict check |
| `TURNSTILE_SITE_KEY` | var. Not a secret. Local test site key `1x00000000000000000000AA` |
| `TABLE_DO_LOCATION_HINT` | var. Demo `weur` |
| `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN` | vars. See section 12. With `ADMIN_REQUIRE_CF_ACCESS=false`, both empty does not 500 |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `WS_TICKET_SECRET` | secrets. At least 32 characters, all different |
| `GAME_ENCRYPTION_KEYS`, `GAME_ENCRYPTION_ACTIVE_KEY_ID` | secrets |
| `TURNSTILE_SECRET_KEY` | secret |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_EXTRA_ORIGINS`, `TOTP_ISSUER`, `MAIL_FROM`, `MAIL_REPLY_TO`, `PASSWORD_BREACH_CHECK`, `SECURITY_HOLD_HOURS`, `ADMIN_REQUIRE_PASSKEY` | optional vars (account security). An unusable value is ignored and logged (`CONFIG_SETTING_IGNORED`); passkeys or email then stay off, and `ADMIN_REQUIRE_PASSKEY` falls back to `true` |
| `AUTH_HMAC_SECRET`, `AUTH_ENCRYPTION_KEYS`, `AUTH_ENCRYPTION_ACTIVE_KEY_ID`, `RESEND_API_KEY` | optional secrets (account security, above) |

`next dev` proxies `/api` and `/ws` to `http://127.0.0.1:8787` (`POKER_EDGE_ORIGIN` overrides the target). Leave `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` empty so the browser calls the Next origin. Cookies stay host-only (`Path=/api/auth` and `Path=/ws`). Set both to `http://localhost:4000` only for the legacy `npm run dev` server.

Local multi-config, after an OpenNext build, from the repo root:

```powershell
npx wrangler dev -c apps/web/wrangler.jsonc -c apps/edge/wrangler.jsonc
```

The first config is the web Worker. Its `API` binding calls `poker-api` in the same dev session. If that command cannot start because `.open-next/worker.js` is missing, run `npx opennextjs-cloudflare build` in `apps/web` first. `next dev` plus `wrangler dev` in `apps/edge` is the fallback and does not exercise the service binding.

## 9. Web environment variables

Leave `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` empty in `apps/web/wrangler.jsonc` and in the GitHub `production` environment. The client uses the page origin, so the `workers.dev` subdomain is not baked in at build time. `'self'` in the CSP covers that host, including `wss`.

| Name | Production value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | empty |
| `NEXT_PUBLIC_SOCKET_URL` | empty |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the Turnstile site key |

`CLIENT_ORIGIN` on `poker-api` is `https://poker-web.<subdomain>.workers.dev`. `poker-web` has `workers_dev: true` and a service binding `API` → `poker-api`. `poker-api` has `workers_dev: false` and no routes. There is no zone.

The deploy job checks that an empty public URL stays empty, and that a non-empty one is https and matches `CLIENT_ORIGIN`. It rejects `example.com` and a host that still contains `<`.

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

## 11. Hostname

There is no custom domain. After the first deploy, the public URL is `https://poker-web.<subdomain>.workers.dev`. Find `<subdomain>` in the Cloudflare dashboard (Workers & Pages → your workers.dev subdomain) and put it in `CLIENT_ORIGIN` before that deploy if the placeholder is still in the file.

`poker-web` forwards `/api/*`, `/ws`, and `/ws/*` to `poker-api`. The API Worker is not on `workers.dev`. A later paid plan can add zone routes and set `workers_dev` back to false on the web Worker; until then, leave the routes out.

Zone WAF, bot fight mode, and cache rules need a domain. They are not part of this demo.

## 12. Cloudflare Access for `/api/admin`

Access is the outer gate. The Worker still requires a player session and `User.role === ADMIN` on every admin request. Either check alone is not enough.

1. Open **Zero Trust → Access controls → Applications → Create application → Self-hosted**.
2. Name it `poker admin`.
3. Public hostname: `poker-web.<subdomain>.workers.dev`. Path: `/api/admin`. If the form does not include subpaths, add `/api/admin/*` as well. Access on a `workers.dev` host may be unavailable on the Free plan; leave it off for the demo.
4. Add an Allow policy whose Include rule is the operator emails, or a service token for a non-browser client. One-time PIN works when you have no other identity provider.
5. Confirm `/`, `/api/auth/*`, `/api/health`, and `/ws/*` are outside this application.
6. Do not enable "protect this Worker" on `poker-api` or `poker-web`. That would put a login wall in front of the whole site.
7. Copy the application's AUD tag into the Wrangler var `CF_ACCESS_AUD`. Put the team name (the subdomain of `https://<team>.cloudflareaccess.com`, not the full host) into `CF_ACCESS_TEAM_DOMAIN`. Both are vars in `apps/edge/wrangler.jsonc`, not secrets. For the demo, leave both empty and leave `ADMIN_REQUIRE_CF_ACCESS` as `false`. The admin route then skips the Access JWT and still requires `User.role === ADMIN`. Set `ADMIN_REQUIRE_CF_ACCESS` to `true` only when both Access vars are set. With that flag, an `https://` origin and either var missing makes `GET /api/admin/*` return 500.

Hostname-based Access is the path protection described in Cloudflare's Workers Access docs. A policy with no Allow rule denies every request.

## 13. GitHub secrets and variables

Create the API token under My Profile → API Tokens. The GitHub token needs:

- Account / Workers Scripts / Edit
- Account / Account Settings / Read
- Zone / Workers Routes / Edit is needed only after a custom domain is added. The workers.dev demo does not use it.

The token you use on your machine for `wrangler hyperdrive create` also needs Account / Hyperdrive / Edit. The GitHub token does not. Continuous integration does not create Hyperdrive configs or change secrets.

Store the account id from the dashboard overview. Treat it as a secret in GitHub because the workflow reads `CLOUDFLARE_ACCOUNT_ID` from the environment secrets.

### Environment `production`

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SUPABASE_DIRECT_URL` | `postgresql://postgres.<ref>:…@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require` (session pooler, port 5432, admin user, not `poker_server`, not port 6543). Direct `db.<ref>.supabase.co:5432` with user `postgres` is also accepted. |
| Secret | `CLOUDFLARE_API_TOKEN` | the deploy token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | this account |
| Variable | `NEXT_PUBLIC_API_URL` | empty |
| Variable | `NEXT_PUBLIC_SOCKET_URL` | empty |
| Variable | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the site key |

### Environment `preview`

Create this before enabling previews. Do not add `SUPABASE_DIRECT_URL` to it.

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

1. Finish sections 2–13. The top-level Wrangler files no longer contain `<HYPERDRIVE_ID_CACHE_DISABLED>`, `<subdomain>`, or a Turnstile test key.
2. Commit the Wrangler edits. Do not commit `.env`, `.dev.vars`, passwords, or `SUPABASE_DIRECT_URL`.
3. Push to `main` (the repository default branch). The workflow runs the checks, then the production job.
4. The production job checks the Wrangler files and the GitHub variables, refuses a bad `SUPABASE_DIRECT_URL`, runs `prisma migrate deploy`, deploys `poker-api` with `--env=""` (the top-level Worker, not `preview`), then runs `npm run deploy -w @poker/web`. Empty `NEXT_PUBLIC_*` URLs stay empty so the browser uses the workers.dev origin.
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
- It does not roll back Supabase. Migrations stay applied. Ship a new forward migration if the schema has to change again.
- It does not roll back Durable Object storage or Hyperdrive's database.
- It cannot cross a Durable Object `exports` lifecycle change.
- Bindings to a resource that was deleted since that version cannot be rolled back onto.

Roll the API and the web Worker back as a pair when a release changed both.

## 17. Optional pull request previews

[ARCHITECTURE.md](ARCHITECTURE.md) allows `wrangler versions upload` or `wrangler deploy --env preview`. This workflow uses `wrangler deploy --env preview`.

`wrangler versions upload` is the wrong tool here. The API config uses Durable Object `exports`, and that command fails on those configs and does not apply Durable Object lifecycle changes. A Version URL also runs with the production resources of that Worker, including the production Hyperdrive, and Version URLs are not issued for Workers that export Durable Objects. Preview has to be a separate Worker and a separate Hyperdrive id.

The preview job runs on pull requests from this repository only when the repository variable `CLOUDFLARE_PREVIEW_ENABLED` is `true`. It uses the GitHub environment `preview`. It does not read `SUPABASE_DIRECT_URL`. It deploys `poker-api-preview` (not public) and `poker-web-preview` (`workers.dev`), then comments the web URL on the pull request. The web Worker's preview service binding is `API` → `poker-api-preview`.

Set it up in this order:

1. Use a Supabase branch, or a second project, that is not the demo database. Apply migrations with that database's admin URL on port 5432, using the shell method in section 3. Do not store that URL in GitHub.
2. Point preview Hyperdrive at that database's `poker_server` session-pooler URL (port 5432), caching disabled. If that database still has `poker_server` as `NOLOGIN`, use `poker_app` instead, the same rule as local docker.
3. Create a second Hyperdrive config:

```powershell
npx wrangler hyperdrive create poker-supabase-preview --connection-string="postgresql://poker_server.<ref>:PASSWORD@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require" --caching-disabled
```

4. Put that id in `apps/edge/wrangler.jsonc` under `env.preview.hyperdrive`. It must differ from the production id. `routes` stays `[]` and `workers_dev` stays `false` (the API is only reached through the binding).
5. `apps/web/wrangler.jsonc` `env.preview` is `poker-web-preview`, `workers_dev: true`, `routes: []`, service `API` → `poker-api-preview`.
6. Find the account's `workers.dev` subdomain in the dashboard. Set the edge preview var `CLIENT_ORIGIN` to `https://poker-web-preview.<subdomain>.workers.dev`.
7. Leave the preview GitHub API and socket variables empty, same as production. Set the Turnstile site key to a real key whose widget allows the preview hostname:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | empty |
| `NEXT_PUBLIC_SOCKET_URL` | empty |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | a real site key whose widget allows the preview hostname |

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

Check jobs set `DATABASE_URL` and `DIRECT_URL` to `127.0.0.1:1` and a script fails the job if `SUPABASE_DIRECT_URL` or the Cloudflare deploy token is present. Nothing there can open a socket to Supabase. `test:db` replaces that stub inside its own child process with the embedded cluster, then deletes the cluster.

The production job is the only job that reads `SUPABASE_DIRECT_URL`.
