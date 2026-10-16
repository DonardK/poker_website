# Play bugfixes

**Recorded:** 2026-09-20

Fixes found by playing a full flow: side pots, sit-in, sign-out, restart recovery, busted seats, and a few lobby and action-bar bugs.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

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
