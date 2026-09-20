# Cursor MCP

Project config lives at `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=tgfudufxslhrxbdxcnyl&features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cfunctions%2Cbranching"
    }
  }
}
```

This session also has the Cursor marketplace plugin `plugin-supabase-supabase` (ready). That plugin is what returned the live inventory. It is authenticated to ConstrctionCompany, not to `tgfudufxslhrxbdxcnyl`.

Official docs: https://supabase.com/docs/guides/getting-started/mcp

Do not put service-role keys in MCP config. OAuth is enough.
