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

**Overall (2026-09-24, compliance rebuild):** The engine now follows a strict GLI-19/MGA-style model. Shuffles draw from the OS CSPRNG with rejection sampling. Each hand has a pre-deal SHA-256 commitment and a hash-chained audit trail. Snapshots pass a fail-closed leak guard, and players get a redacted post-hand audit while regulators use an ADMIN-only sealed audit. TLS is enforced in production. See `COMPLIANCE.md`. Earlier dated entries below describe the retired player-nonce shuffle.

---

## 2026-09-28 - restore live games and switch new tables to human multiplayer

- **Root cause:** The running server used a Prisma schema with five hand-audit columns that OnlinePoker did not have. At settlement, `Hand.handUuid` caused a `P2022` database error, so turns retried and games looked frozen. Applied the existing additive compliance migration to OnlinePoker, recorded it in both Supabase and Prisma migration histories, and aligned the Supabase migration filename with its recorded version. A previously stalled table then recorded its next two hands and returned to WAITING. Startup now checks the required columns and fails with a migration instruction instead of accepting games that cannot settle.
- **Human tables:** New standard and custom tables contain only human seats. The server rejects bot creation requests and keeps legacy bot tables visible only to players still seated at them. The lobby explains that two people must sit before a hand starts; the table has a clear waiting message and a copy-link control. Custom tables can be named. Creation returns to the table immediately after the server confirms it, even if the separate bankroll refresh is slow.
- **Verification:** A live, two-account game on the connected server created a custom two-seat table, appeared in the other player's lobby, dealt private cards correctly, advanced through a complete hand, served a participant audit, and cashed both players out with chip totals conserved. The exact temporary table and accounts were removed afterwards. Server tests passed (35, one existing OpenSSL-dependent skip), all 14 desktop/mobile browser checks passed, typecheck and the full production build passed, and localhost web/API both returned HTTP 200.
- **Further validation:** Multiplayer under concurrent load, cross-device disconnects, and deployed-domain socket/TLS behavior still need dedicated testing. The live test used localhost and play chips.

---

## 2026-09-28 - localhost startup 500 after a production build

- Reproduced `Internal Server Error` from `http://localhost:3000` while the API health endpoint remained healthy. The running Next.js development server and a later production build had written to the same `.next` directory.
- Next.js development now writes to `.next-dev`; production builds keep `.next`, and isolated browser tests keep `.next-browser-test`. The new dev output is ignored by Git and included in web typechecking.
- Verified the running localhost page recovered to HTTP 200 after the config reload and stayed HTTP 200 during a successful production web build. Web typechecking passed.

---

## 2026-09-28 - leave flow, action responsiveness, and regression coverage

- **Leaving:** Both table leave controls now wait for a server acknowledgement and return to the lobby. A separate lobby link always remains available when disconnected and clearly says the seat stays reserved. A player still in a hand sees a clear pending cash-out; a player not dealt into that hand can cash out immediately. Repeated requests cannot pay twice. The lobby keeps a pending notice until settlement and receives the updated bankroll even after leaving the table room. The lobby also includes the player's own seat when its table falls outside the newest 50 public tables.
- **Actions and recovery:** Actions receive explicit success/error acknowledgements, can be retried after rejection, and cannot silently queue while disconnected. Ordinary API requests have a timeout; session refresh is exempt so a timed-out cookie rotation cannot invalidate the next attempt. Temporary refresh failures no longer clear a valid session. The table timer cannot be overwritten by stale recovery and retries transient recovery-read failures.
- **Latency:** The server skips seat writes for unchanged seats (one changed seat instead of all six in the call regression), avoids seat/user relation loading for encrypted table states, checks private-table membership only when needed, stops autojoining a table socket from the lobby, and broadcasts viewer-specific snapshots concurrently. Bot think times remain intentionally paced; measure end-to-end latency against the deployment database before claiming a production millisecond improvement.
- **Verification:** New engine, server, and isolated desktop/mobile browser regressions cover pending leave, immediate un-dealt cash-out, wallet settlement, stale-wallet fetches and refreshes, idempotence, rollback, action retry, disconnect behavior, and timer recovery. Typecheck, production build, and the full test suite (408 engine tests; server tests pass with one existing OpenSSL-dependent skip) passed. All 12 Chrome browser checks passed; the disconnected-lobby scenario also passed again on desktop and mobile after the fallback link was added. The browser suite runs outside the restricted Windows sandbox so it can shut down its test servers cleanly.
- **Still to validate:** A two-human live play session, production database latency under load, long disconnects and expiry across multiple devices, and a deploy smoke test. No production tables or balances were modified in this pass.

---

## 2026-09-27 - adversarial review round (25 findings fixed)

Four independent reviewers attacked the compliance rebuild and confirmed 25 defects with executed repros: 1 high, 9 medium, 15 low. All are fixed:

- **Legacy state (high):** tables saved by the previous version are upgraded on load by `upgradeTableState`. Leftover cards are purged, settled hands are cleaned up, and hands still in progress are voided with every bet returned. Upgraded state is persisted at startup.
- **Verifiers:**
  - Participant audits reject duplicate cards and a folded (mucked) hand presented as tabled. Folds are derived from the chained actions.
  - They also reject a doctored showdown, fields outside the schema, and an audit for a different table, hand or user.
  - New `verifyHandOutcome` replays bets, ranks, side pots, odd chips, payouts and stacks. It runs before a hand is recorded and in the regulator report, which also checks the per-table chain link.
- **Rules:**
  - Newcomers and players returning after missed blinds wait for the big blind, so blinds cannot be dodged.
  - The button moves to the previous small-blind position (dead button).
  - A leaving player's hand is folded on their turn and never tabled, and sitting back in cancels the leave.
  - Auto-actions record their true reason, and no-op sit toggles change nothing.
- **Isolation and transport:**
  - The leak guard enforces an exact client-schema allow-list.
  - TLS is enforced on every engine.io request, not only the handshake.
  - Every admin request is logged with its outcome.
  - The participant redaction guard checks the stored `showedCards`.
  - Live evidence in the browser is user-scoped, pruned and cleared at sign-out.
- **Docs** no longer overclaim. They state what the guard, the hash chain (in-hand transitions only) and the hole-card digest actually guarantee.
- **Tests:** `review-fixes.test.ts` has 94 tests, including 35 re-sealed forgeries that keep every hash valid and are caught by the semantic checks. The server `compliance.test.mjs` has 28 tests.

---

## 2026-09-24 - compliance rebuild (GLI-19 / MGA technical spec)

1. **RNG:** the seeded HMAC shuffle and the browser-nonce protocol were removed. Every Fisher-Yates swap draws a 32-bit word from `crypto.randomFillSync` and uses explicit rejection sampling. A continuous health test runs on the source, and consumed randomness is zeroed.
2. **Commitment and audit:** each hand gets a UUID v4. A salted SHA-256 deck commitment and a Merkle root are computed before blinds and dealing. Every transition is recorded in a SHA-256 hash chain with a per-table link and a post-hand `finalStateHash`. Events hold only public data, with hidden cards as positions.
3. **Isolation:** `projectTableState` combines the allow-list projection with the fail-closed `assertViewerStateSafe` guard, and every server emission uses it. Hand Clean-up purges all card secrets. TLS is enforced in production for HTTP and Socket.io.
4. **Audit access:** `GET /api/tables/:id/hands/:n/audit` returns a redacted, verified participant audit. `GET /api/admin/hands/:handUuid/audit` is ADMIN-only and returns the sealed deck and salts with a recomputation report. Migration `20260924120000_compliance_audit_trail` adds immutable audit columns. **Apply it before deploying.**
5. **Bugs fixed on the way:**
   - Pots are now merged by eligibility, so folded dead money no longer splits one pot into pieces with their own odd chips (111/109 instead of 110/110).
   - `leaveSeat` logs before removing the player; previously a mislabelled log line could freeze a table through a leak-guard false positive.
   - A hand that settles immediately after the SHOWDOWN timer deals it is now persisted.
6. **Tests:** new engine suites:
   - `rng` (bijection proof, rejection exactness, and chi-square over 1,000,000 production shuffles);
   - `leakage` (2,000+ random hands, every transition, every viewer);
   - `audit` (tamper detection);
   - `evaluate-exhaustive` (all 2,598,960 hands, 7,462 classes, independent 7-card reference);
   - `pots-reference` (chip-level reference settlement).

   On the server, `compliance.test.mjs` covers TLS, guarded emission, audit persistence and redaction.

---

## 2026-09-24 - responsiveness, reliability, and shuffle fairness

1. Polished the lobby and table layout for smaller screens, cleaned up card faces and seat displays, added smoother motion with reduced-motion support, and kept the existing play controls. Improved guest/login and session recovery, API error messages, socket reconnection feedback, and sound behavior.
2. Live hands now publish a commitment to a fresh 256-bit server seed before accepting player entropy. At least one seated human contributes a 256-bit browser nonce before the deal. A domain-separated HMAC-SHA-256 Fisher-Yates shuffle uses rejection sampling for unbiased index selection. Every seat receives cards from the same uniformly shuffled deck; seat position does not change starting-card odds.
3. Added a participant-only, post-hand audit endpoint and a **Verify hand** control that can check any completed hand number. The browser verifier reconstructs the shuffle and checks the seed commitment, player contributions, full deck, salted deck root, deal order, hole cards, and board. It compares the browser's own nonce and commitments when recorded during live play. A root first seen after settlement is explicitly treated as retrospective evidence.
4. Restricted bot decisions to public information and their own hole cards. Tests check hidden deck and opponent cards are absent from the bot view.
5. Verified `npm.cmd run typecheck`, `npm.cmd test` (**75 engine + 4 server passed**), `npm.cmd run build`, and `git diff --check`. Shuffle regression sampling covers 10,000 seeded deals across nine positions plus 5,200 first-card samples; these detect major bias but do not prove perfect randomness.
6. Live browser QA: a guest joined a bot table, a hand waited for browser entropy, completed-hand verification succeeded with the player's nonce and both live commitments, earlier hands #47 and #48 passed the history audit, and the temporary seat cashed out. After a server restart, the table reconnected and the audit still passed. The local dev site was left running at `http://localhost:3000`.

**Remaining high-assurance work:** An operator can still abandon a pending round after seeing a nonce; the server knows the deck during play, and the audit store is under server control. Add an independent append-only witness for commitments, contributions, cancellations, and settlement; commission external RNG and rules review; test two independent human browsers, rule boundaries, mobile/touch access, network faults, and anti-collusion controls. See `SECURITY-REVIEW.md` for the fairness model and `CLAUDE_HANDOFF.md` for Claude's test checklist. This implementation is not externally certified for real-money play.

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
