# Hold'em Live — Implementation Progress

Handoff doc. Spec: `plan.md`. Do not restart from Phase 1.

| Phase | Code status | Verified? | Completed |
|---|---|---|---|
| 1. Architecture & data layer | **Done** | Typecheck + lobby/login browser | 2026-09-19 |
| 2. Core deterministic engine | **Done** | Jest: deck, evaluate, 2000-iter pot fuzz | 2026-09-19 |
| 3. State machine & game loop | **Done** | Jest table tests + 6-max play | 2026-09-19 |
| 4. Quantitative bot engine | **Done** | Jest profile legality + live bots | 2026-09-19 |
| 5. Socket integration & masking | **Done** | Live 6-max, rehydrate, cash-out | 2026-09-19 |
| 6. Frontend UI / UX / animations | **Done** | Lobby + table play in browser | 2026-09-19 |
| 7. Verification + bugfix pass | **Done** | Jest 43 + browser (guest, table, sit-out, cash-out) | 2026-09-20 |

**Overall:** The local 6-max vs bots game is playable end-to-end. Engine tests: **43 passed**. Typecheck: shared, engine, server, web green.

---

## 2026-09-20 — verification bugfixes

Full-flow check found playable core plus several bugs. Fixed:

1. Side-pot labels during unmatched blinds/bets (SB/BB looked like two pots). `refreshPots()` now keeps a single pot unless someone is all-in; unmatched bets use `returnUncalledBets` first.
2. Sit-in button lied mid-hand: public `sittingOut` was `flag || status === SIT_OUT`. Now it follows the sit-out flag only.
3. Sign-out left the table list on screen. Lobby clears tables, hides the list when logged out, and uses a grid header so the bankroll card does not cover the copy.
4. Abandoned tables after restart: cold-load from Redis/DB re-arms timers (and queues the next hand from SHOWDOWN). `TABLE_JOIN` / `REHYDRATE` emit a snapshot **before** `tryStart`. Corrupt Redis JSON falls back to DB. Client join watchdog after 8s.
5. Busted players no longer occupy seats forever: `completeHand` cashes them out (stack 0) and frees the seat. `persistSeats` writes EMPTY seats too.
6. Listen `EADDRINUSE` is retried instead of an unhandled crash. Keep a **single** `npm run dev:server`.
7. Fold is not legal when a check is free. Login has ← Lobby and clears errors when switching Login/Register. Board cards are compact and sit above the seats.

Verified in browser: guest login, sign-out hides tables, login back-link, new 6-max, **Pot $25** with no fake side pots, Fold/Call/Raise while facing a bet.

---

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
