# Supabase inventory (AI source of truth)

Read this folder before creating tables, migrations, Edge Functions, Auth, Storage, or a Supabase client in this repo.

**Snapshot date:** 2026-09-20  
**This poker app does not use Supabase yet.** Local play uses Docker Postgres (`DATABASE_URL` in `.env.example`).

## What to open

| File | What it answers |
| --- | --- |
| [ACCESS.md](ACCESS.md) | Configured project vs authenticated project |
| [mcp.md](mcp.md) | Cursor MCP setup |
| [authenticated-account/PROJECT.md](authenticated-account/PROJECT.md) | The only project this MCP login can currently see |

## Configured for this repo

- MCP URL project ref: `tgfudufxslhrxbdxcnyl` (from the dashboard snippet in `.cursor/mcp.json`)
- Status on 2026-09-20: **not accessible** with the current MCP OAuth token (`You do not have permission to perform this action`; public host also 404s)

Until that project is reachable, there is **no poker schema on Supabase** for this repo to consume.

## What MCP can actually see

The Cursor Supabase plugin is logged into org **ConstrctionCompany** (`revgjxjuggzodkfuvghl`, free plan). That org has **one** project:

- Name: **DonardK's Project**
- Ref: `gwnaqmbbxfzhgzcfxsvm`
- Region: `eu-west-1`
- Postgres 17.6
- App: construction ERP (employees, attendance, vehicles, diesel, …)

That project is documented under [authenticated-account/](authenticated-account/PROJECT.md). It is **not** the poker platform. Do not add poker tables there.

## Skills

Installed for agents in this repo:

- `.agents/skills/supabase/`
- `.agents/skills/supabase-postgres-best-practices/`
