# Advisors (2026-09-20)

## Security

- **WARN** `public.rls_auto_enable()` is `SECURITY DEFINER` and executable by `anon` and `authenticated`. [Remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
- **WARN** Leaked password protection is disabled. [Remediation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)

## Performance

Unindexed FKs:

- `attendance.attendance_employee_id_fkey`
- `diesel.diesel_vehicle_id_fkey`
- `vehicle_services.vehicle_services_vehicle_id_fkey`
- `worker_payments.worker_payments_employee_id_fkey`

Unused indexes (INFO): `idx_vehicles_archived_at`, `idx_stock_items_category`, `idx_employees_archived_at`.
