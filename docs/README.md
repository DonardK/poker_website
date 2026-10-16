# Documentation

Start here if you are changing this repository. The product is play-chip multiplayer Texas Hold'em: a Next.js client, an authoritative game server, and a PostgreSQL database. A Cloudflare Workers port lives in `apps/edge`. It is **not** certified, and it is **not** cleared to take deposits, hold customer crypto, or make chips redeemable.

## Read this first

1. [Development progress](progress/README.md) — what has been built, in feature order, and what was still open at the last full status pass (7 October 2026).
2. [README](../README.md) — how to run the app. Prefer `npm run dev:local`. The root `.env` points at the live production database.
3. [Testing](TESTING.md) — which command is safe. Server tests go through `apps/server/test/support/run-tests.mjs` so they cannot reach production.
4. [Decisions](product/DECISIONS.md) — product choices the code already cites. Recommendations in old reviews are not owner decisions.
5. [Technical compliance dossier](../COMPLIANCE.md) and [fairness model](reviews/2026-09-24-fairness-model.md) — what the shuffle, isolation, and audit actually guarantee.

## Repository map

| Path | What it is |
| --- | --- |
| `packages/engine` | Pure poker state machine. No network, database, or UI imports. |
| `packages/shared` | Types, audit verifiers, and the edge WebSocket protocol. Runs in Node and in the browser. |
| `apps/server` | Express and Socket.io game server. Authoritative for the Node deployment. |
| `apps/web` | Next.js client. Sends intents only. |
| `apps/edge` | Cloudflare Workers and Durable Objects port. Specs are under [docs/cloudflare](cloudflare/ARCHITECTURE.md). |
| `apps/server/prisma` | Canonical migrations. Runtime role: [RUNTIME_ROLE.md](../apps/server/prisma/RUNTIME_ROLE.md). |
| `supabase/` | Inventory of the OnlinePoker Supabase project. Read [supabase/README.md](../supabase/README.md) before any Supabase work. `supabase/authenticated-account/` is an unrelated snapshot. Do not use it. |

## Guides

| Document | Use it for |
| --- | --- |
| [Testing](TESTING.md) | Suites, durations, and the live-database rules. |
| [Deployment runbook](DEPLOYMENT.md) | Node deployment, secrets, backups, readiness. |
| [Cloudflare architecture](cloudflare/ARCHITECTURE.md) | Authoritative spec for the Workers port. The free-plan demo section wins where it disagrees with the earlier paid-plan text. |
| [Cloudflare protocol](cloudflare/PROTOCOL.md) | WebSocket wire format for `apps/edge` and `apps/web`. |
| [Cloudflare deploy](cloudflare/DEPLOY.md) | Operator path for the Workers demo. Automatic deploys are also summarized in the root README. |
| [Supabase migration plan](cloudflare/SUPABASE_MIGRATION_PLAN.md) | Which migrations were applied to the live project, and the rules for applying more. |
| [Ledger](money/LEDGER.md) | Append-only money schema. **Nothing in gameplay calls it yet.** `User.bankroll` is still the live wallet. |
| [Edge deploy configs](../deploy/README.md) | Caddy and nginx examples for a Node deployment. |
| [Security policy](../SECURITY.md) | How to report a vulnerability. Placeholders are still unfilled. |
| [Third-party notices](../THIRD_PARTY_NOTICES.md) | Dependency licence notices. |
| [Runtime role](../apps/server/prisma/RUNTIME_ROLE.md) | `poker_server` on Supabase, `poker_app` on local Docker. |

## History, reviews, and opinions

| Document | What it is |
| --- | --- |
| [Progress index](progress/README.md) | Development log, one file per feature. |
| [Original specification](product/ORIGINAL_SPECIFICATION.md) | The brief the first build followed. Several of its choices were later reversed. |
| [Decisions](product/DECISIONS.md) | D1–D12, with what the code does today and what is still open. |
| [QA handoff, 24 September 2026](handoff/2026-09-24-qa.md) | Test list written after the compliance rebuild. |
| [Reviews](reviews/README.md) | Dated defect reports. A finding's status inside an older report is not the current status. |
| [Roadmaps](roadmaps/README.md) | Model opinions from 28 September 2026. Not a plan of record. |

## Former filenames

These files used to sit in the repository root. Reviews and scripts written on those dates still mention the old names.

| Old path | Current path |
| --- | --- |
| `progress.md` | [docs/progress/README.md](progress/README.md) (root `progress.md` is a pointer) |
| `plan.md` | [docs/product/ORIGINAL_SPECIFICATION.md](product/ORIGINAL_SPECIFICATION.md) |
| `SECURITY-REVIEW.md` | [docs/reviews/2026-09-24-fairness-model.md](reviews/2026-09-24-fairness-model.md) |
| `BACKEND-SECURITY-AUDIT.md` | [docs/reviews/2026-09-29-backend-security-audit.md](reviews/2026-09-29-backend-security-audit.md) |
| `CLAUDE-REVIEW.md` | [docs/reviews/2026-09-30-claude-review.md](reviews/2026-09-30-claude-review.md) |
| `GPT-6.1-SOL-REVIEW.md` | [docs/reviews/2026-09-30-gpt-review.md](reviews/2026-09-30-gpt-review.md) |
| `GPT-6.1-SOL-REVIEW-PROMPT.md` | [docs/reviews/2026-09-29-gpt-review-brief.md](reviews/2026-09-29-gpt-review-brief.md) |
| `opuswork.md` | [docs/reviews/2026-10-07-session-log.md](reviews/2026-10-07-session-log.md) |
| `chatgpt-6-sol.md` | [docs/roadmaps/2026-09-28-sol.md](roadmaps/2026-09-28-sol.md) |
| `chatgpt-6-codex.md` | [docs/roadmaps/2026-09-28-codex.md](roadmaps/2026-09-28-codex.md) |
| `CLAUDE_HANDOFF.md` | [docs/handoff/2026-09-24-qa.md](handoff/2026-09-24-qa.md) |

`review/claude/` and `review/gpt-6.1-sol/` are the repro scripts and notes from those reviews. Leave them next to the scripts. `review/gpt-6.1-sol/sections.md` is a working fragment of the GPT report, not a second report.

## Rules for later edits

- Record new development in a new file under [docs/progress](progress/README.md), and add a row to that index. Do not append a model-named note to the repository root.
- A new opinion or proposed order of work goes in [docs/roadmaps](roadmaps/README.md). Say what evidence it rests on, and do not present it as a decision.
- Do not rewrite a dated review so that old findings look as if they were never filed. Add a later progress entry that says what changed.
- The root `.env` is production. Do not run migrations, seeds, resets, or `npm run dev` against it. See [Testing](TESTING.md) and `supabase/README.md`.
