# Runtime login

Two shapes. The migration `20261010120000_runtime_hardening` picks from the role that already exists. Nothing in a migration sets a password.

## Supabase demo

Project `tgfudufxslhrxbdxcnyl` (eu-west-1). `poker_server` is already a `LOGIN` role there (`poker_server.tgfudufxslhrxbdxcnyl` on the session pooler). It is `NOSUPERUSER` and `NOBYPASSRLS`, and it holds the table grants and the row-level security policies. The demo Hyperdrive connection uses that login. Do not create `poker_app` for this database and do not remove `LOGIN` from `poker_server`.

The migration sees `rolcanlogin` and leaves `poker_server` as the runtime role. Policies written `TO poker_server` apply to that session. A role is a member of itself, so the privilege guards match `current_user = poker_server`.

Migrations use a different URL: the Supabase admin role `postgres` (session pooler user `postgres.<ref>` on port 5432, or direct `db.<ref>.supabase.co:5432`). Port 6543 is transaction mode and cannot run these migrations. The admin URL is `SUPABASE_DIRECT_URL` / `DIRECT_URL` only. Hyperdrive never receives it.

`supabase/README.md` and `supabase/ACCESS.md` record that this login was already provisioned and that no administrator password lives in the application. The Cloudflare demo does not change that.

## Local docker and a NOLOGIN `poker_server`

The game server connects as `poker_app`. That role is `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, and `INHERIT`, and it is a member of `poker_server`. `poker_server` stays `NOLOGIN`; it holds the grants and the row-level security policies. `poker_app` uses them by inheritance.

`DATABASE_URL` is this login (the API, and Cloudflare Hyperdrive in production). `DIRECT_URL` is the administrator, used only by `prisma migrate`. The process refuses to boot in production if the login is a superuser, has `BYPASSRLS`, or can `UPDATE` or `DELETE` `"Hand"`.

## One-time password

Run this once, as the same administrator that applies migrations (Neon: `neondb_owner`). Pick the password on the machine; do not commit it and do not paste it into a migration.

```sql
ALTER ROLE poker_app PASSWORD 'choose-a-long-random-password';
```

Generate one with:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

If `CREATE ROLE poker_app` failed because the migration role cannot create roles, create `poker_app` in the Neon console (`LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `INHERIT`, no password in git) and apply migrations again. The migration sees the role and only grants `poker_server` to it. Then run the `ALTER ROLE` above.

## Connection strings

Local docker, after the password is set. These belong in `apps/server/.env` only when the repo-root `.env` does not already set them (dotenv does not override). The root `.env` may point at the live database; do not put these values there.

```text
DATABASE_URL=postgresql://poker_app:PASSWORD@127.0.0.1:5432/poker?schema=public
DIRECT_URL=postgresql://poker:POSTGRES_PASSWORD@127.0.0.1:5432/poker?schema=public
```

`DIRECT_URL` is the docker superuser (`POSTGRES_USER`, default `poker`). Use it only for `prisma migrate`. The API uses `DATABASE_URL`.

Neon (placeholders). The pooled host is for the app; the direct host is for migrations. Both need `sslmode=require`.

```text
DATABASE_URL=postgresql://poker_app:PASSWORD@ep-example-pooler.region.aws.neon.tech/neondb?sslmode=require
DIRECT_URL=postgresql://neondb_owner:PASSWORD@ep-example.region.aws.neon.tech/neondb?sslmode=require
```

Hyperdrive on Cloudflare should use the pooled Neon host and the `poker_app` password. The Worker still has to pass the startup check: that login must not be a superuser, must not have `BYPASSRLS`, and must not be able to update or delete `"Hand"`.

## Local docker

`docker-compose.yml` publishes Postgres and Redis on `127.0.0.1` only. On a new data volume, `apps/server/prisma/docker-init/01-poker-app-role.sh` creates `poker_app` when `POKER_APP_PASSWORD` is set (letters and digits, at least 16). Put that variable in `.env.compose`, not in the root `.env`:

```text
docker compose --env-file .env.compose up -d
```

The script runs only when the volume is first created, and it runs before migrations. Apply migrations as the docker superuser (`DIRECT_URL`); they grant `poker_server` to `poker_app`. An existing volume does not re-run the script: use the `ALTER ROLE` statement above instead.

## Rewriting hand history

`Hand`, `HandPlayer`, `HandAction`, and `HandPot` reject `UPDATE` and `DELETE` for every role unless the transaction sets `poker.break_glass`. Deleting a table or a user does not cascade into that history (`ON DELETE RESTRICT`). The ledger journal (`LedgerTransaction`, `LedgerEntry`) has no such hatch; drop its trigger only as its own reviewed migration.

```sql
BEGIN;
SELECT set_config('poker.break_glass', 'on', true);
-- delete or correct the hand rows, then the table or user
COMMIT;
```

Use the third argument `true` (transaction-local). Do not `ALTER ROLE poker_app SET poker.break_glass = 'on'`. Setting the variable may log `unrecognized configuration parameter "poker.break_glass"` once; that warning is harmless. Reading it when unset does not warn.

## Supabase, Neon, and the older RLS migration

On Supabase, `public.rls_auto_enable()` is the platform event trigger that enables row-level security when a table is created in `public`. `20260920141323_restrict_rls_event_trigger` revokes `EXECUTE` from `PUBLIC` when that function exists. `20261010130000_game_command` grants it back to the migration role when the role is allowed to, and continues if the grant is refused. A security-definer trigger still runs. Local docker and Neon do not have the function, so both statements are no-ops.

The Supabase `postgres` role is not a true superuser. Pending migrations do not create event triggers, extensions, or tablespaces. See `docs/cloudflare/SUPABASE_MIGRATION_PLAN.md` before applying them.

## Neon and the older RLS migration

`20260920141323_restrict_rls_event_trigger` does not create an event trigger. It revokes `EXECUTE` on `public.rls_auto_enable()` only when that function exists, which is a Supabase helper. On Neon the function is absent, so the migration is a no-op. Applied migrations are not edited; a later migration cannot change how that file already ran.

This repo does not add an event trigger to force RLS on future tables. Neon rejected event triggers for non-superusers for a long time, and a migration role that is not `neon_superuser` still cannot create one. Every new table instead repeats the boilerplate at the bottom of `20261010120000_runtime_hardening` and ends with `SELECT public.poker_assert_rls();`. That function fails the migration if any application table in `public` lacks enabled and forced row level security or a policy for `poker_server`.
