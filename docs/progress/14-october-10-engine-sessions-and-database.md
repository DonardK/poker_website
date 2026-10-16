# Engine, sessions, and database hardening

**Recorded:** 2026-10-10.

These commits are on `main` after the 7 October log. They were not run back through the F / CR / SOL / NEW tables. Where a commit clearly touches an open item, that is noted below. It is not a new audit.

| Commit | What changed |
| --- | --- |
| `4d84fe1` | Absolute session expiry is checked on every authenticated request. Refresh already rejected a session past its hard end; access tokens still worked while the idle expiry was in the future. Familiar-address lockout counters no longer restart when the in-memory map evicts the key being counted. Related: F16, and the lockout work in [house rules and lockout](13-october-7-house-rules-and-lockout.md). |
| `615b3ba` | The server test runner generates a throwaway `GAME_ENCRYPTION_KEY` only when the environment has none, so tests can boot. CI already supplies a key. |
| `be53280` | Next.js file tracing uses the repository root, so a lockfile above the web workspace is not chosen as the project root. |
| `cce2d6b` | Minimum raise after an undersized opening all-in. The shuffle draws from Web Crypto `crypto.getRandomValues` (the same OS CSPRNG; `COMPLIANCE.md` and the fairness model were updated in this commit). New tests: `packages/engine/src/__tests__/min-raise.test.ts`. |
| `ad95251` | Migration `20261010120000_runtime_hardening`: `poker_app` login on local Docker, append-only triggers, narrower cascades, caps, and indexes. The game server refuses to boot in production if its login is a superuser, has `BYPASSRLS`, or can update or delete `Hand`. Roles are documented in [RUNTIME_ROLE.md](../../apps/server/prisma/RUNTIME_ROLE.md). Related: F12. |

A later commit the same day (`d76b3a5`) adjusted that migration so an existing Supabase `poker_server` login stays the runtime role when it can already log in. Do not create `poker_app` on the OnlinePoker project. See the runtime-role doc and [the Supabase migration plan](../cloudflare/SUPABASE_MIGRATION_PLAN.md).
