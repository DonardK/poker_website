# Auth, ledger, legal pages, and release tooling

**Recorded:** 2026-10-01 to 2026-10-06, committed on 2026-10-07.

This work had no progress entry of its own. It was committed unchanged on branch `fix-now-2026-10-07` and merged to `main` on 2026-10-10 (`cb1c303`). The 7 October review is the description of what that tree contained, including defects it introduced. Those defects and the same-day fixes are in [the recheck](11-october-7-review-recheck.md), [socket contract and startup](12-october-7-socket-contract-and-startup.md), and [house rules and lockout](13-october-7-house-rules-and-lockout.md).

## What landed

Four commits, split by area:

| Commit | Area |
| --- | --- |
| `8a5c89e` | Engine and shared package: turn clock, table lifecycle, audit and pot changes, RNG suite updates. |
| `cd65192` | Server and database: migrations `auth_hardening`, `ledger_foundation`, and `game_reliability`; auth, money, and security modules; readiness and tests. |
| `0c55df1` | Web: draft legal pages, age and terms gate, buy-in dialog, turn clock, turn announcer, connection status, chip formatting, browser tests. |
| `d6e1151` | CI, deploy configs, [deployment](../DEPLOYMENT.md), [testing](../TESTING.md), [ledger](../money/LEDGER.md), security policy, third-party notices. |

The ledger is a schema and a TypeScript module. Gameplay still writes `User.bankroll`. See [docs/money/LEDGER.md](../money/LEDGER.md).

## What the 7 October review said this tree got wrong

The recheck found nine new defects (NEW-1–NEW-9), including a stop-ship: the web client sent `turnId` and `commandId`, and the server's strict socket schemas rejected both, so nobody could act or buy in. That was fixed the same evening. The engine suite and the database privilege test were also red until the night of 7 October.

Do not describe this block of work as a finished security pass. The finding status after the night of 7 October is in [the recheck](11-october-7-review-recheck.md), updated by the two fix logs that follow it.
