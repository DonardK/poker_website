# Development progress

What has been built in this repository, one file per feature. The last full pass over open defects was the night of **7 October 2026**. Commits on **10 October 2026** added database hardening, web polish, and a Cloudflare Workers port. Those commits were not re-scored against the F / CR / SOL / NEW tables.

Play-chip poker is implemented and tested. **Deposits, customer crypto custody, and redeemable chips are not.** That NO-GO was recorded on 29 September and again on 7 October. Nothing in the 10 October commits adds payments, identity checks, AML, or responsible-gaming enforcement.

## Standing rules

- The client sends intents. The engine decides outcomes.
- Chip amounts are integers.
- `packages/engine` does not import network, database, or UI code (`ENGINE_ISOLATION_BOUNDARY` in `isolation.ts`).
- The root `.env` is the live production database. Local work uses `npm run dev:local`.
- [COMPLIANCE.md](../../COMPLIANCE.md) is a self-assessment, not a laboratory certificate.

## Feature log

| | Feature | Recorded | File |
| --- | --- | --- | --- |
| 01 | Initial platform (phases 1–7, playable table) | 2026-09-19 | [01-initial-platform.md](01-initial-platform.md) |
| 02 | Play bugfixes (pots, sit-in, restart, busted seats) | 2026-09-20 | [02-play-bugfixes.md](02-play-bugfixes.md) |
| 03 | Browser-nonce shuffle — **removed the same day** | 2026-09-24 | [03-provable-shuffle.md](03-provable-shuffle.md) |
| 04 | Compliance rebuild (CSPRNG, commitments, audit, isolation) | 2026-09-24 | [04-compliance-rebuild.md](04-compliance-rebuild.md) |
| 05 | Twenty-five adversarial findings fixed | 2026-09-27 | [05-adversarial-review-fixes.md](05-adversarial-review-fixes.md) |
| 06 | Leave flow, action acks, latency | 2026-09-28 | [06-leave-flow-and-responsiveness.md](06-leave-flow-and-responsiveness.md) |
| 07 | Separate Next.js dev and production output | 2026-09-28 | [07-local-dev-build.md](07-local-dev-build.md) |
| 08 | Human-only tables; startup refuses a database that cannot settle | 2026-09-28 | [08-human-multiplayer.md](08-human-multiplayer.md) |
| 09 | Security and real-money readiness review (no code changes) | 2026-09-29 | [09-security-readiness-review.md](09-security-readiness-review.md) |
| 10 | Auth, ledger foundation, legal pages, CI, deploy docs | 2026-10-01 – 06 | [10-october-1-6-hardening.md](10-october-1-6-hardening.md) |
| 11 | Recheck of every open finding; NEW-1–NEW-9 | 2026-10-07 | [11-october-7-review-recheck.md](11-october-7-review-recheck.md) |
| 12 | Socket contract, buy-ins, and startup errors | 2026-10-07 evening | [12-october-7-socket-contract-and-startup.md](12-october-7-socket-contract-and-startup.md) |
| 13 | Time bank, local database, schema contract, login lockout | 2026-10-07 night | [13-october-7-house-rules-and-lockout.md](13-october-7-house-rules-and-lockout.md) |
| 14 | Min-raise, session expiry, Postgres runtime hardening | 2026-10-10 | [14-october-10-engine-sessions-and-database.md](14-october-10-engine-sessions-and-database.md) |
| 15 | Play-chip copy, error pages, metadata | 2026-10-10 | [15-october-10-web-polish.md](15-october-10-web-polish.md) |
| 16 | Cloudflare Workers and Durable Objects | 2026-10-10 | [16-october-10-cloudflare-edge.md](16-october-10-cloudflare-edge.md) |

## Still open after 7 October 2026

Left explicitly for a later session that night:

- Auto-muck of losing hands (NEW-3). The House Rules promise it. The engine still shows live hands at showdown.
- Pause a table that cannot load or settle, with an operator void and refund (CR-004).
- Password reset by email. It needs an email provider.

Real-money prerequisites F01–F05 (ledger used by gameplay, payments, identity, AML, responsible gaming) were still open or only partly done. The ledger schema exists and is unused by the game. See [docs/money/LEDGER.md](../money/LEDGER.md).

The finding tables in [the 7 October recheck](11-october-7-review-recheck.md) are the last line-by-line status. Read that file before treating a 29 or 30 September "OPEN" as current. Read [the 10 October notes](14-october-10-engine-sessions-and-database.md) before assuming none of those rows moved.

## Finding ids

| Prefix | Source | Range |
| --- | --- | --- |
| F | [29 September audit](../reviews/2026-09-29-backend-security-audit.md) | F01–F22 |
| CR | [30 September review](../reviews/2026-09-30-claude-review.md) | CR-001–CR-041 |
| SOL | [30 September GPT review](../reviews/2026-09-30-gpt-review.md) | SOL-001–SOL-052 |
| NEW | [7 October recheck](11-october-7-review-recheck.md) | NEW-1–NEW-14 |
| D | [Decisions](../product/DECISIONS.md) | D1–D12 |

## How to add an entry

Add `docs/progress/NN-short-name.md` with the date, what changed, what was verified, and what is still open. Link it from the table above. Do not put the note in the repository root.
