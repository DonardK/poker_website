# Supabase migration plan

Read this before the first `prisma migrate deploy` against project `tgfudufxslhrxbdxcnyl`. This file is reasoning from the repo only. It did not connect to Supabase.

Prisma history (`_prisma_migrations`) is the only list `prisma migrate deploy` trusts. The copies in `supabase/migrations/` are the SQL that was prepared for Supabase. They are byte-identical to the Prisma files with the same purpose, including the compliance audit (Prisma name `20260924120000_compliance_audit_trail`, Supabase filename `20260927224842_compliance_audit_trail.sql`). `supabase/README.md` says both compliance ids are already marked applied in Prisma's history. Do not apply that SQL twice.

There is no `lifecycle` migration and no separate `terms` migration. Terms and age columns are inside `20261001100000_auth_hardening`.

## Migrations in `apps/server/prisma/migrations`

| Prisma folder | Started | In `supabase/migrations/` | Likely state on Supabase |
| --- | --- | --- | --- |
| `20240919190000_init` | 2024-09-19 | no copy | Applied earlier as the initial schema. Confirm the row. If the tables exist and this row is missing, baseline it. Do not re-run it. |
| `20260920140611_poker_security` | 2026-09-20 | identical copy | Likely applied (creates `poker_server`, RLS). |
| `20260920141323_restrict_rls_event_trigger` | 2026-09-20 | identical copy | Likely applied (revokes `EXECUTE` on `public.rls_auto_enable()` when that function exists). |
| `20260920165155_poker_history_integrity` | 2026-09-20 | identical copy | Likely applied. |
| `20260924120000_compliance_audit_trail` | 2026-09-24 | identical body, recorded as `20260927224842` | README: both ids marked applied. Confirm the Prisma name, not the Supabase filename. |
| `20261001100000_auth_hardening` | 2026-10-01 | identical copy | Likely applied (usernames, lockout, terms/age columns, session columns). |
| `20261002200000_ledger_foundation` | 2026-10-02 | identical copy | Likely applied. |
| `20261003100000_game_reliability` | 2026-10-03 | identical copy | Likely applied (`TableIncident`). |
| `20261007200000_table_incident_column_grants` | 2026-10-07 | identical copy | Likely applied. |
| `20261010120000_runtime_hardening` | 2026-10-10 | no copy | **Pending.** Edited in this repo so a `LOGIN` `poker_server` does not fail the migration. |
| `20261010130000_game_command` | 2026-10-10 | no copy | **Pending.** Depends on `poker_refuse_history_mutation()` from the row above. |

Expected pending set, if the history check matches the table above: `20261010120000_runtime_hardening`, then `20261010130000_game_command`. Anything else in the `SELECT` below that is not finished is also pending. Stop and reconcile before deploy if that list is longer.

## What would have failed, and what the pending SQL does instead

`poker_server` on this project is already `LOGIN` (`supabase/README.md`, `supabase/ACCESS.md`). The old `runtime_hardening` text required it to be `NOLOGIN` and created `poker_app` as the runtime login. That `RAISE` would abort the migration.

The demo keeps `poker_server` as the Hyperdrive login. Creating `poker_app` is not needed and is not done when `poker_server` can log in. Policies and grants already name `poker_server`. A role is a member of itself, so the updated guards (`pg_has_role(..., 'poker_server', 'MEMBER')`) match a session whose `current_user` is `poker_server`.

Local docker is unchanged: `poker_security` creates `poker_server` `NOLOGIN`, and `runtime_hardening` still creates `poker_app` `LOGIN` `INHERIT` and grants `poker_server` to it (`GRANT ... WITH INHERIT TRUE, SET TRUE` is PostgreSQL 16, which is what `docker-compose.yml` runs).

Other Supabase facts:

- The `postgres` role is not a true superuser. The pending files do not `CREATE EVENT TRIGGER`, `CREATE EXTENSION`, or a tablespace.
- `public.rls_auto_enable()` is Supabase's event trigger for new tables in `public`. The applied restrict migration revoked `EXECUTE` from `PUBLIC`. `game_command` tries to grant it back to the current role and continues if that grant is refused. A security-definer trigger still runs as its owner. If `CREATE TABLE "GameCommand"` then fails with `permission denied for function rls_auto_enable`, stop. Do not disable the event trigger. The next change is a reviewed grant from a role that owns the function.
- The RLS repair loop in `runtime_hardening` enables and forces row-level security on every ordinary table in `public` that lacks a `poker_server` policy. That is correct when `public` contains only the poker tables. It is wrong if Supabase has another table there: `FORCE ROW LEVEL SECURITY` would apply to the table owner, and the `postgres` role is not a superuser. The pre-check below lists those tables. If the list is not exactly the expected names, do not apply.
- Foreign keys `Hand.tableId` and `HandPlayer.userId` are dropped by column and recreated `ON DELETE RESTRICT`, so a different constraint name still migrates. Orphan rows fail the `ADD CONSTRAINT` and roll the migration back.
- Chip `CHECK` constraints fail closed if any stored amount is above the cap. The pre-check counts those rows.
- Indexes are created inside the migration transaction (not `CONCURRENTLY`). They take a lock. That is acceptable on this database; it is not a rewrite of existing rows.

`runtime_hardening` and `game_command` had not been applied on Supabase, so editing them does not desynchronize that history. A local docker volume that already applied the previous text will report a checksum mismatch. That volume is `127.0.0.1:5432` only (`docker-compose.yml`). Recreate it with `docker compose --env-file .env.compose down -v` and apply again. Do not point that command at any other host.

## Read-only checks (run these first)

Use the Supabase **admin** session-pooler URL (port 5432, user `postgres.<ref>`) or the direct host. Do not use `poker_server` for this (it cannot read every catalog row the checks need) and do not use port 6543. Print results, not the URL.

```sql
SELECT version();

SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY started_at;

SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb, rolreplication
FROM pg_roles
WHERE rolname IN ('poker_server', 'poker_app', 'postgres', 'anon', 'authenticated', 'service_role');

SELECT n.nspname, c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;

SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;

SELECT p.proname, p.prosecdef
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable';

SELECT conrelid::regclass AS table_name, conname
FROM pg_constraint
WHERE conname IN ('Hand_tableId_fkey', 'HandPlayer_userId_fkey')
   OR (contype = 'f' AND conrelid IN ('public."Hand"'::regclass, 'public."HandPlayer"'::regclass));
```

Stop when any of these is true:

- `poker_server` is missing, `rolsuper`, or `rolbypassrls`.
- `poker_server.rolcanlogin` is false. The demo Hyperdrive user would not be able to connect, and the migration would take the `poker_app` branch (`GRANT ... WITH INHERIT` needs PostgreSQL 16).
- A `_prisma_migrations` row before `20261010120000_runtime_hardening` is missing or has `rolled_back_at` set, while the objects from that migration already exist. Baseline with `npx prisma migrate resolve --applied <folder_name>` for each finished migration that is missing. Do not re-execute its SQL.
- `public` contains a table that is not in this set: `User`, `Session`, `Table`, `TableSeat`, `Hand`, `HandPlayer`, `HandAction`, `HandPot`, `BotStatistic`, `TableIncident`, `Asset`, `LedgerAccount`, `LedgerTransaction`, `LedgerEntry`, `_prisma_migrations`. (`GameCommand` must not exist yet.)
- Any of the counts below is not zero.

```sql
SELECT count(*) AS user_bankroll FROM public."User" WHERE bankroll > 1000000000;
SELECT count(*) AS seat_stack FROM public."TableSeat" WHERE stack > 1000000000;
SELECT count(*) AS hand_amount FROM public."Hand" WHERE "potTotal" > 1000000000 OR rake > 1000000000;
SELECT count(*) AS hand_player FROM public."HandPlayer"
  WHERE "startingStack" > 1000000000 OR "endingStack" > 1000000000
     OR net < -1000000000 OR net > 1000000000;
SELECT count(*) AS hand_action FROM public."HandAction"
  WHERE amount > 1000000000 OR ("toAmount" IS NOT NULL AND "toAmount" > 1000000000);
SELECT count(*) AS chips_won FROM public."BotStatistic"
  WHERE "chipsWon" < -2000000000 OR "chipsWon" > 2000000000;
SELECT count(*) AS hand_orphans FROM public."Hand" h
  LEFT JOIN public."Table" t ON t.id = h."tableId" WHERE t.id IS NULL;
SELECT count(*) AS hand_player_orphans FROM public."HandPlayer" hp
  LEFT JOIN public."User" u ON u.id = hp."userId"
  WHERE hp."userId" IS NOT NULL AND u.id IS NULL;
```

`version()` is informational. Session-pooler port 5432 is required either way. The pending SQL does not use a PostgreSQL 16 grant on the `poker_server` `LOGIN` path.

## Apply

From the repo root, with the root `.env` moved aside so Prisma cannot load it (the guard script refuses while that file is present). Put the file back when the command finishes. Do not print the URL.

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

`npm run prisma:migrate -w @poker/server` is `prisma migrate deploy`. It does not seed. The GitHub production job runs the same command with secret `SUPABASE_DIRECT_URL`.

Hyperdrive stays on `poker_server.<ref>` at the same host and port, with caching disabled. It is not the URL above.

## Post-checks

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE migration_name IN (
  '20261010120000_runtime_hardening',
  '20261010130000_game_command'
);

SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN ('poker_server', 'poker_app');

SELECT public.poker_assert_rls();

SELECT to_regclass('public."GameCommand"') AS game_command;

SELECT privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'GameCommand' AND grantee = 'poker_server'
ORDER BY privilege_type;
```

Expect:

- Both new migration rows finished, `rolled_back_at` null.
- `poker_server` still `LOGIN`, not superuser, not `BYPASSRLS`. `poker_app` absent.
- `poker_assert_rls()` returns without error.
- `GameCommand` exists. `poker_server` has `INSERT` and `SELECT` only.

Then connect once as `poker_server` (the Hyperdrive user) and confirm `SELECT current_user` and that `has_table_privilege(current_user, 'public."Hand"', 'UPDATE')` and `DELETE` are false. Disconnect. Do not deal a hand.

## Rollback

`prisma migrate deploy` runs each file in one transaction. A failure rolls that file back and leaves earlier files applied. Do not `migrate reset` this database.

If both pending files committed and the demo must go back:

- `GameCommand` is a new empty table. Dropping it is a new forward migration (`DROP TABLE`), not a reset.
- `runtime_hardening` adds triggers, check constraints, indexes, and `ON DELETE RESTRICT`. Reversing that is a reviewed forward migration. Do not drop `poker_server`.
- Worker rollback (`wrangler rollback`) does not undo SQL. Schema and Workers are rolled back separately.
- The runtime password and Hyperdrive config are unchanged by these two files, because they do not `ALTER ROLE ... PASSWORD`.
