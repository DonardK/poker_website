# DonardK's Project (NOT the poker app)

**Do not use this project for poker_website.** It is the construction-company ERP behind Etna Group / Dervisholli.

| Field | Value |
| --- | --- |
| Name | DonardK's Project |
| Project id / ref | `gwnaqmbbxfzhgzcfxsvm` |
| Status | `ACTIVE_HEALTHY` |
| Created | 2026-03-17 |
| Org | ConstrctionCompany (`revgjxjuggzodkfuvghl`) |
| Plan | free |
| Region | `eu-west-1` |
| Database host | `db.gwnaqmbbxfzhgzcfxsvm.supabase.co` |
| Postgres | 17.6.1.084 (engine 17, channel `ga`) |
| API URL | `https://gwnaqmbbxfzhgzcfxsvm.supabase.co` |
| PostgREST | 14.5 |
| Edge Functions | none |
| Branches | none |
| Storage buckets | 0 |
| Storage objects | 0 |
| Vault secrets | 0 |
| Realtime subscriptions | 0 |

Publishable/anon keys exist on the project. They are **not** copied here. Fetch them with MCP `get_publishable_keys` when needed; never commit the service-role key.

## Public tables (row counts, not row data)

| Table | Rows | RLS | Notes |
| --- | --- | --- | --- |
| `employees` | 28 | on | Hourly/fixed pay, bank fields, archive |
| `attendance` | 2573 | on | Hours by date/location/company |
| `vehicles` | 8 | on | Name, plate, registration expiry |
| `diesel` | 81 | on | Liters/price; optional `photo_base64` |
| `vehicle_services` | 5 | on | JSON `items`, optional photo |
| `worker_payments` | 28 | on | Amount + description |
| `stock_items` | 9 | on | Inventory |
| `daily_reports` | 140 | on | Unique `(date, company)` |
| `office_expenses` | 0 | on | Amount + optional photo |

## Auth (counts only)

- 3 email users, all confirmed, none anonymous
- 3 email identities
- 21 sessions, 121 refresh tokens
- No MFA, SSO, OAuth clients, or SCIM rows

## More detail

- [schema.md](schema.md)
- [rls.md](rls.md)
- [functions.md](functions.md)
- [migrations.md](migrations.md)
- [extensions.md](extensions.md)
- [advisors.md](advisors.md)
- [database.types.ts](database.types.ts) — generated `public` types
