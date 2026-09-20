# RLS

Every `public` table has RLS enabled. `anon` has no policies. All policies are `PERMISSIVE` for role `authenticated`.

Helpers live in schema `private` (not exposed as tables):

- `private.current_user_email()` — JWT `email`, lowercased
- `private.is_app_user()` — email allowlist (staff)
- `private.is_management()` — narrower email allowlist (`SECURITY DEFINER`)

Exact emails are not copied into this repo. Read them from the live functions if you are working on the construction app.

| Table | SELECT/INSERT/UPDATE/DELETE |
| --- | --- |
| `employees`, `attendance`, `daily_reports` | `private.is_app_user()` |
| `vehicles`, `diesel`, `vehicle_services`, `worker_payments`, `stock_items`, `office_expenses` | `private.is_management()` |

Event trigger `ensure_rls` (`ddl_command_end`) plus `public.rls_auto_enable()` turns RLS on for new `public` tables.
