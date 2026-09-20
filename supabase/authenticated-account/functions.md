# Functions and event triggers

## `public.rls_auto_enable()`

- Language: plpgsql
- `SECURITY DEFINER`, `search_path = pg_catalog`
- Event-trigger function: on `CREATE TABLE` in `public`, runs `ALTER TABLE … ENABLE ROW LEVEL SECURITY`
- Callable by `anon` and `authenticated` via `/rest/v1/rpc/rls_auto_enable` (security advisor; revoke `EXECUTE` if unused from the API)

## `private` helpers

Used only from RLS policies. `is_management` is `SECURITY DEFINER`; `is_app_user` and `current_user_email` are invoker.

## Event triggers (platform + project)

| Name | Event | Enabled |
| --- | --- | --- |
| `ensure_rls` | `ddl_command_end` | origin |
| `issue_graphql_placeholder` | `sql_drop` | origin |
| `issue_pg_cron_access` | `ddl_command_end` | origin |
| `issue_pg_graphql_access` | `ddl_command_end` | origin |
| `issue_pg_net_access` | `ddl_command_end` | origin |
| `pgrst_ddl_watch` | `ddl_command_end` | origin |
| `pgrst_drop_watch` | `sql_drop` | origin |

No custom Edge Functions. `pg_cron` / `pg_net` / `vector` are **not** installed.
