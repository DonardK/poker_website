# Cloudflare Workers port

**Recorded:** 2026-10-10.

The play-chip game can run as two Cloudflare Workers: `poker-web` (public Next.js) and `poker-api` (private API, Durable Objects). The browser talks to one `*.workers.dev` origin. `poker-web` forwards `/api` and `/ws` to `poker-api`.

The specs are authoritative for this port. Implement those documents; do not redesign them from this summary.

| Spec | Role |
| --- | --- |
| [Architecture](../cloudflare/ARCHITECTURE.md) | Workers, Durable Objects, free-plan demo, auth, database. The demo section wins over the earlier paid-plan text. |
| [Protocol](../cloudflare/PROTOCOL.md) | WebSocket frames. `packages/shared/src/protocol.ts` is the shared copy. |
| [Deploy](../cloudflare/DEPLOY.md) | Operator runbook. A push to `main` runs [`.github/workflows/cloudflare.yml`](../../.github/workflows/cloudflare.yml). |
| [Supabase migration plan](../cloudflare/SUPABASE_MIGRATION_PLAN.md) | Live-project migration record. Applying a migration to production is an operator task. |

`User.bankroll` is still the live wallet. The architecture spec says this port does not change poker rules, chip amounts, session lifetimes, or the ledger's foundation-only status.

## What the commits did

| Commit | What changed |
| --- | --- |
| `98a2e79` | Architecture and protocol specs. |
| `03ddb47` | `GameCommand` rows (durable command ids for retries) and protocol types. |
| `8a6dd54` | Edge Worker skeleton: health, per-request Prisma, hibernating Durable Object stubs. |
| `7842f0a` | Guests can sign in and open tables on the Worker. |
| `72962aa` | Hands run in the table Durable Object. Sockets close when a session is revoked. |
| `26ebaf6` | Lobby updates without waiting for the poll. |
| `27e0ebb` | The client speaks the edge WebSocket protocol. |
| `8b83035` | Next.js is served from a Worker. Local API cookies stay on one origin. Turnstile widget. |
| `260372a` | CI moves to `cloudflare.yml`. Edge bindings are listed and checked. |
| `b894c94` | `GameCommand` privileges, and a two-browser hand test against the local edge. |
| `1f9aaa6` | Edge passwords are versioned PBKDF2-SHA256. bcrypt cost 12 does not fit the Workers Free 10 ms CPU limit. Legacy bcrypt is off unless an old hash must be accepted. |
| `9b1b122` | One `workers.dev` origin. Empty public URLs mean "this page's origin". |
| `1307f17` | Prisma client is imported when the Worker starts. Each request still builds its own client. |
| `d76b3a5` | Deploy target is Supabase, not Neon. Hyperdrive caching stays off. |
| `709b9d3` | Records the six Supabase migrations applied on 2026-10-10. |
| `7efaf33` | Migration SQL stays LF so Prisma checksums match on Windows. |
| `cb3b801` | Demo Workers point at Hyperdrive, Turnstile, and `poker-demo.workers.dev`. |
| `c48ea1f` | Live browser test can target a deployed origin. |
| `7534219`, `51ca224`, `ac1334c` | Production deploy gets the pooler CA and site origin; CI fixes; Prisma client is generated before the API Worker deploy. |
| `4baff8c` | Root README describes the automatic deploy and rollback. |
| `24eb1fd` | Table sockets and alarms are drained before the edge worker pool exits, so Vitest does not fail after a passing run. |

## Boundaries

- The root `.env` is still the live database. The deploy runbook says the migration URL and the runtime URL do not go in that file or in a Worker secret by accident. Read [DEPLOY.md](../cloudflare/DEPLOY.md) before operating it.
- Free-plan CPU is 10 ms per request. PBKDF2 iteration count and the CPU limit are set together. See the architecture spec.
- This is still play chips. It is not a licence, a payment integration, or a certification.
