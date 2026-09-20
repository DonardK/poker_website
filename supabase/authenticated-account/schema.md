# Public schema

Schemas present: `auth`, `extensions`, `graphql`, `graphql_public`, `private`, `public`, `realtime`, `storage`, `supabase_migrations`, `vault`.

No public views. No public table triggers. `private` has helper functions only (no tables).

## Relationships

```
employees 1—N attendance
employees 1—N worker_payments
vehicles  1—N diesel
vehicles  1—N vehicle_services
```

`daily_reports`, `stock_items`, `office_expenses` are standalone.

## Columns

### `employees`

| Column | Type | Default / checks |
| --- | --- | --- |
| `id` | bigint PK | sequence |
| `emri`, `mbiemri` | text | required |
| `payment_method` | text | `Cash` or `Bankë` |
| `cmimi_ore` | numeric | `0` |
| `salary_type` | text | `hourly` or `fixed` (default `hourly`) |
| `fixed_salary` | numeric | nullable |
| `emri_bankes`, `llogaria_bankes` | text | nullable |
| `archived_at` | timestamptz | nullable |
| `created_at` | timestamptz | `now()` |

### `attendance`

| Column | Type | Default / checks |
| --- | --- | --- |
| `id` | bigint PK | sequence |
| `employee_id` | bigint FK → employees | |
| `emri`, `mbiemri` | text | denormalized names |
| `date` | date | |
| `payment_method` | text | |
| `hours_worked` | numeric | |
| `location` | text | `Pr`, `Pz`, `M`, `R8`, `R10` (default `Pr`) |
| `company` | text | `Etna Group` or `Dervisholli` (default `Etna Group`) |
| `created_at` | timestamptz | `now()` |

### `vehicles`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK | |
| `emri_mjetit`, `targa` | text | |
| `registration_expires_at` | date | nullable |
| `archived_at` | timestamptz | nullable |
| `created_at` | timestamptz | `now()` |

### `diesel`

`vehicle_id` FK, denormalized `emri_mjetit`, `date`, `liters`, `total_price`, optional `photo_base64`.

### `vehicle_services`

Identity PK, `vehicle_id` FK, `date`, `notes`, `items jsonb` default `[]`, `total_price`, optional `photo_base64`.

### `worker_payments`

`employee_id` FK, denormalized names, `amount`, `pershkrim`, `date`.

### `stock_items`

Identity PK, `category`, `name`, `quantity` default `0`, `unit`, `notes`, timestamps.

### `office_expenses`

Identity PK, `date`, `category`, `title`, `amount`, `notes`, optional `photo_base64`.

### `daily_reports`

PK `id`, unique `(date, company)`, `title`, `content`, company check same as attendance.

## Indexes

PKs on every table, plus:

- `idx_employees_archived_at`
- `idx_vehicles_archived_at`
- `daily_reports_date_idx`, `daily_reports_date_company_idx`, unique `daily_reports_date_company_key`
- `idx_stock_items_category`
- `idx_office_expenses_date`
- `idx_vehicle_services_date`

Missing covering indexes on FKs: `attendance.employee_id`, `diesel.vehicle_id`, `vehicle_services.vehicle_id`, `worker_payments.employee_id` (see [advisors.md](advisors.md)).
