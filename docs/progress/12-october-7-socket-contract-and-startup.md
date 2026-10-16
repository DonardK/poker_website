# Socket contract and startup

**Recorded:** 2026-10-07 (evening)

The lobby message "Game server unavailable", and the stop-ship where the real server refused every buy-in and action the web client sent (NEW-1).

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-10-07 (evening) - "Game server unavailable" in the lobby; joining tables fixed (NEW-1)

**Status: the code fixes are made and verified on disposable databases. The owner's dev game server still has to be restarted, and the live database's migration state was not checked (see below).** Full details, including every file changed in this session: [7 October session log](../reviews/2026-10-07-session-log.md).

**What happened.** The lobby showed "Game server unavailable. Start both services with npm run dev, then retry." The web app (port 3000) was running, but nothing answered on port 4000.
- `npm run dev` started at 16:42, 2½ minutes after the PC booted. Its game server exited shortly after, and `tsx watch` then waits for a file change without restarting it.
- The old start-up log showed only "fatal startup error" with the error's name. The safe-log serializer drops every Prisma error message, and Prisma prints nothing of its own for a failed connect, so the reason was invisible (NEW-10).
- Most likely the database connection failed at start-up. On this network IPv6 does not work, and Supabase's direct host (`db.<ref>.supabase.co`) is IPv6-only, while the IPv4 pooler is reachable.
- Not caused by the review's own build: the shared packages were last rebuilt by `npm run dev` itself at 16:42.
- A second blocker would have followed even with the server up: NEW-1 refused every buy-in and action.

**Fixed (uncommitted):**
- **NEW-1, CR-008, CR-017** (`apps/server/src/socket/index.ts`, `apps/server/src/game/manager.ts`):
  - the socket schemas accept the web client's `turnId` and `commandId`;
  - an action is stale only when its turn is over;
  - seat and sit commands are acknowledged;
  - a failure to deal, or a failed balance notification, after a committed seat claim is logged instead of being reported as a failed claim.
- **NEW-10 and NEW-11** (new `apps/server/src/db/connect.ts`, `apps/server/src/index.ts`): a failed database connection is explained in plain words, naming only host:port. In development it is retried with back-off instead of ending the game server.
- **NEW-12** (`apps/server/src/db/prisma.ts`): the start-up schema check covers the October migrations and names each one that is missing. Previously, a database without them let the server start while every sign-in failed.
- **The lobby message** (`apps/web/src/lib/api.ts`, development only): says the game server stopped and that the reason is in the `[server]` lines.
- **Docs:** README troubleshooting paragraph; `.env.example` note on the IPv6-only direct host.
- **NEW-13:** the local Prisma client was older than `schema.prisma` (no `pausedAt`, `pausedReason` or `TableIncident`); regenerated.
- **Tests:** `apps/server/test/socket-contract.test.mjs` and `apps/server/test/startup.test.mjs` (15 tests), added to `npm test`.

**Verification:**

| Check | Result |
| --- | --- |
| Typecheck, server and web | Pass |
| Server suite (12 files) | 130/130 |
| Ledger unit tests | 21/21 |
| Browser suite | 156/156 |
| Real game server on embedded PostgreSQL | All passed:<ul><li>a database at the September schema is refused, naming the two missing migrations;</li><li>a database that is down at start-up is waited for and used as soon as it answers;</li><li>three guests create a table, two sit down exactly as the buy-in dialog does (acknowledged), and a hand is played;</li><li>an action still counts after a bystander sits out mid-turn, and an action for a finished turn is refused.</li></ul> |

**Still open from this work:**
- The owner must restart `npm run dev` and read the `[server]` lines.
- If they say "Database is missing migration(s)", the three October migrations must be applied to the Supabase database. That is a schema change to the live database, and needs an administrator connection that `.env` does not have.
- Development runs against the shared live database (NEW-14): every restart runs table recovery on live data. A local development database is recommended.
- The live database was not read: a read-only probe was refused as a production read and was not worked around. The owner can run `node review/claude/recheck/dev-server/live-connect-probe.mjs`.
