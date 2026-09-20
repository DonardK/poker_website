# Access notes

## Intended poker project (configured, not reachable)

| Field | Value |
| --- | --- |
| Project ref | `tgfudufxslhrxbdxcnyl` |
| MCP URL | `https://mcp.supabase.com/mcp?project_ref=tgfudufxslhrxbdxcnyl&features=docs,account,database,debugging,development,functions,branching` |
| `get_project` / `list_tables` | MCP error: no permission |
| `https://tgfudufxslhrxbdxcnyl.supabase.co` | HTTP 404 (same as an unprovisioned or non-existent host from this network) |

Possible causes: the dashboard snippet came from another Supabase account/org, the project is still provisioning, or it was paused/deleted.

To inventory that project later:

1. In Cursor, reconnect the Supabase MCP server and complete OAuth with the org that owns `tgfudufxslhrxbdxcnyl`.
2. Confirm `list_projects` includes that ref.
3. Refresh this folder (schema, functions, keys, advisors).

The `agent` CLI (`agent mcp enable supabase` / `agent mcp login supabase`) is not on PATH in this Windows environment. Use Cursor Settings → Tools & MCP, or `cursor agent` once the CLI is installed.

## Authenticated login (reachable)

| Field | Value |
| --- | --- |
| Org | ConstrctionCompany (`revgjxjuggzodkfuvghl`) |
| Plan | free |
| Projects | 1 — DonardK's Project (`gwnaqmbbxfzhgzcfxsvm`) |

Full dump: [authenticated-account/PROJECT.md](authenticated-account/PROJECT.md).
