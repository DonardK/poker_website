# Initial platform

**Recorded:** 2026-09-19

Phases 1–7 of the original build, then the pass that made a table playable end to end. This is play-chip poker. The shuffle described in the original brief was replaced on 2026-09-24; see [Compliance rebuild](04-compliance-rebuild.md).

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

| Phase | Code status | Verified? | Completed |
|---|---|---|---|
| 1. Architecture & data layer | **Done** | Typecheck + lobby/login browser | 2026-09-19 |
| 2. Core deterministic engine | **Done** | Jest: deck, evaluate, 2000-iter pot fuzz | 2026-09-19 |
| 3. State machine & game loop | **Done** | Jest table tests + 6-max play | 2026-09-19 |
| 4. Quantitative bot engine | **Done** | Jest profile legality + live bots | 2026-09-19 |
| 5. Socket integration & masking | **Done** | Live 6-max, rehydrate, cash-out | 2026-09-19 |
| 6. Frontend UI / UX / animations | **Done** | Lobby + table play in browser | 2026-09-19 |
| 7. Verification + bugfix pass | **Done** | Jest 43 + browser (guest, table, sit-out, cash-out) | 2026-09-20 |

## 2026-09-19 — finish the game

1. Persist `TableSeat.stack` (and sitting-out) after settled hands so a Redis-empty restart hydrates last stacks, not the original buy-in.
2. Cash-out / stand up: `leaveSeat` mid-hand folds and pays remaining chips after the hand; between hands cashes out immediately. Bankroll patched over the socket (`USER_PATCH`).
3. One Socket.io client per access token (`getSocket` reuses even while connecting).
4. Lobby “Phase 1” copy removed. Tables auto-refresh. Bankroll refreshes after opening a table.
5. Table UX: sit out / sit in / fold & leave, empty-seat “Sit here”, animated time bank, winner highlight, deal/win/turn sounds, log autoscroll, bet slider reset.
6. Showdown timer no longer cancelled by sit-out; next-hand queue is once per `handNumber`.
7. Bot usernames use a hex suffix so creating many tables does not collide on `User.username`.
8. `tryStart` on JOIN, REHYDRATE, table create, and sit-in (LockBusy ignored) so a hand actually starts when six are seated.

Not in this pass (optional later): full hand replayer UI, closing idle/orphan lobby tables, dedicated rebuy UI (empty seats can already “Sit here”).

Stack:

```bash
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Web `:3000`, API/sockets `:4000`. If port 3000 or 4000 is stuck from an old process, kill that PID then start again — only one web and one server.

---

## Architecture reminder

- Client sends **intents only**. Engine is authoritative.
- Chips are **integers**.
- `packages/engine` isolation boundary: `ENGINE_ISOLATION_BOUNDARY` in `isolation.ts`.
- PowerShell: do not use `&&`; use `;` or separate commands.

## Typecheck

```bash
npm run typecheck -w @poker/shared
npm run build -w @poker/shared
npm run typecheck -w @poker/engine
npm run build -w @poker/engine
npm run typecheck -w @poker/server
npm run typecheck -w @poker/web
```
