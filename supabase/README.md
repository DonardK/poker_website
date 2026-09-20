# Supabase OnlinePoker

Project: `tgfudufxslhrxbdxcnyl` (OnlinePoker), region `eu-west-1`.
Dashboard: https://supabase.com/dashboard/project/tgfudufxslhrxbdxcnyl

Nine poker application tables enforce row-level security. Browser roles have no access; game requests go through the authenticated server. The limited `poker_server` login has no administrator, DDL, or RLS-bypass privileges. Completed hand records are append-only to this role. Table and user deletion is reserved for administrators to prevent cascading history removal.

SSL enforcement is enabled. The application uses the session pooler on port 5432 with strict certificate verification and the official public Supabase CA in `apps/server/certs`. The generated password and encryption/session keys live only in the ignored root `.env`.

Prisma migrations under `apps/server/prisma/migrations` are canonical. Supabase MCP applied the initial schema and security patches. The security patch copies in this folder record the submitted DDL; do not run `supabase db reset` expecting a complete initial schema here.

The `authenticated-account` directory is a historical snapshot of an unrelated construction project. It does not describe OnlinePoker and was not used or modified for the poker database.
