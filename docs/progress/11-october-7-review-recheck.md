# Review recheck

**Recorded:** 2026-10-07

Status of CR-001–CR-041, F01–F22, and NEW-1–NEW-9 against the 1–6 October working tree. The same-day fixes are [socket contract and startup](12-october-7-socket-contract-and-startup.md) and [house rules and lockout](13-october-7-house-rules-and-lockout.md). The session log is [the 7 October session log](../reviews/2026-10-07-session-log.md). The decisions this entry says were missing are now in [DECISIONS.md](../product/DECISIONS.md). The preserved text below still says that file did not exist, which was true on this date.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-10-07 - Claude's full review (41 findings), what GPT-6.1-Sol missed, and a re-check of the Oct 1–6 fixes

**Status: review finished on 2026-09-30 and re-checked today against the current working tree, including the uncommitted Oct 1–6 fixes.**
- **Stop-ship (fixed the same evening, see [socket contract and startup](12-october-7-socket-contract-and-startup.md)):** the current working tree must not be deployed, even for play chips. The real server refuses every action and every buy-in that today's web client sends (NEW-1 below).
- **Claude's 41 findings:** 16 fixed, 14 partly fixed, 8 open, 2 regressed (made worse), 1 waiting on an owner decision.
- **The 22 findings of the 2026-09-29 review:** 3 fixed, 10 partly fixed, 7 open, 2 waiting on a decision.
- **Re-check:** found 9 new defects in the Oct 1–6 changes.
- **Real money:** still NO-GO.

No application code, tests or databases were changed by this review or the re-check. Only new files were added: [30 September review](../reviews/2026-09-30-claude-review.md), `review/claude/**`, and this entry.

### Who reviewed what

- **Claude (Anthropic)** reviewed every production file of the engine, shared package, server, web app, schema and migrations (159 files) on 2026-09-29/30.
  - It ran the existing suites, a 28,273-hand lifecycle fuzz and its own repro scripts.
  - Full report: [30 September review](../reviews/2026-09-30-claude-review.md), with findings CR-001 to CR-041, decisions D1–D12 and legal register L1–L10. Repro scripts: `review/claude/repro/`.
- **GPT-6.1-Sol** reviewed the same tree at the same time, from the brief in [GPT review brief](../reviews/2026-09-29-gpt-review-brief.md).
  - Its report: [30 September GPT review](../reviews/2026-09-30-gpt-review.md) (SOL-001 to SOL-052). Its scripts: `review/gpt-6.1-sol/repro/`.
  - Claude re-ran GPT's scripts. All 10 of its findings that Claude had not found reproduced, and they were adopted as CR-032 to CR-041.
- **Between 2026-10-01 and 2026-10-06, another session fixed many findings.** That work is uncommitted and has no progress.md entry of its own. It includes:
  - three migrations (`auth_hardening`, `ledger_foundation`, `game_reliability`);
  - new auth, money and security modules;
  - draft legal pages and an age and terms gate;
  - a buy-in dialog, turn clock, turn announcer and connection status;
  - CI, deploy configs and docs.
- **Today's re-check** went through every CR and F item against that code, using four independent checkers. Each re-ran or adapted the original repro, and I re-checked their evidence. The most serious result (NEW-1) I reproduced myself.

### Stop-ship: defects introduced by the Oct 1–6 changes

| ID | Sev | What happens | Where | Evidence |
| --- | --- | --- | --- | --- |
| NEW-1 | **S0** (fixed the same evening) | **Nobody can act or buy in on the real server.** The web client now adds `turnId` to every action and `commandId` to every seat claim. The server's socket schemas are `.strict()` and do not list either field, so both are refused with "Request could not be completed". A player's every click fails, their turn times out and they are sat out. The buy-in dialog always fails. Sit out and sit in still work. | `apps/server/src/socket/index.ts:24`, `:38`, `:216-217` vs `apps/web/src/components/table/action-bar.tsx:98-100`, `buy-in-dialog.tsx:123` | `review/claude/recheck/game-server/socket-contract.test.mjs` against the real socket server (re-run by me, 4/4). With the web payload: `{ok:false, code:"INVALID_REQUEST"}` and the manager is never called. Without the new field: accepted. The browser suite (156/156) misses it because its fixture server (`apps/web/test/support/game-server.mjs`) does not validate payloads. |
| NEW-2 | S1 | **The published House Rules promise turn time the server does not give.** They promise a personal time bank of 30–60 s after the 20 s base, and a fresh base time after an outage. In fact no server module reads `gameConfig`, though its comment says `manager.ts` and `tables.ts` do. `createTable` gets no `extraTimeBank`, and `rebaseTurnClock` is never called. So players are folded and sat out after 20 s instead of up to 50 s, and after a restart the player to act is folded at once (F10). If the bank is wired up later, the server timer and `applyTimeout` must use the bank deadline too. Otherwise the server folds at 20 s while the clock still shows bank time. | `apps/server/src/config.ts:140-175`; `game/manager.ts:81`, `:109-127`, `:361`; `apps/web/src/app/rules/page.tsx:95-101`, `:165`; `terms/page.tsx:107` | grep shows 0 readers of `gameConfig` in `apps/server/src`. `manager-recheck.mjs`: `TIMEOUT_FOLD` 8 ms after `recover()`. `timebank-mismatch.mjs`: the client is shown 45 s while the timeout fires at 15 s. |
| NEW-3 | S2 | **The House Rules say losing hands are mucked automatically, but every live hand is still shown to everyone, spectators included.** See CR-022 and decision D2. | `rules/page.tsx:110-117` vs `packages/engine/src/table.ts:1229-1234`, `public.ts:234` | `showdown-reveal.mjs`: 50 of 50 three-way showdowns showed the losing hands to a spectator. |
| NEW-4 | S2 | **The new per-account login lockout lets anyone lock any player out indefinitely.** After 5 wrong guesses the account locks, and one guess each time the lock lapses re-locks it, up to 15 min. Usernames are public at every table, so a small, steady trickle of wrong guesses keeps an account locked. During the lock, the owner's correct password gets "Invalid credentials". There is no unlock or reset path, and the owner is not told. | `apps/server/src/auth/routes.ts:27-42`, `:198-224` | `review/claude/recheck/auth-security/login-lockout.mjs`. `auth-http.test.mjs:276-297` asserts the identical 401. |
| NEW-5 | S3 | **The `ENABLE_LEGACY_BOTS` switch does nothing.** It is documented as "off by default: a bot's turn times out" (D11), but legacy bots keep playing when it is false. | `config.ts:148`, `:157-162`; `manager.ts:362-365` | The test "AFK human and a bot" still passes with `ENABLE_LEGACY_BOTS=false` and asserts that the bot acted. |
| NEW-6 | S3 | **Signing out while offline is silently undone when the network returns.** The hydrator's pending retry still runs, and `clearSession` leaves `apiOffline` set, so the still-valid cookie signs the device back in without a click. On a shared device, the next person gets the account. | `apps/web/src/components/auth-hydrator.tsx:129-157`, `:199`; `stores/session.ts:111-112` | `signout-offline-recheck.mjs` mounts the real AuthHydrator: the user is signed out, then signed back in 4 s after reconnecting. |
| NEW-7 | S3 | **The new `TableIncident` table was not added to the database privilege test, so `test:db` fails (41/43).** The runtime role can also UPDATE every column, including `kind`, `reason` and `createdAt`, so incident records can be rewritten after the fact. | `prisma/migrations/20261003100000_game_reliability/migration.sql:44`; `apps/server/test/db/privileges.test.mjs:36-51`, `:104-107` | `npm run test:db` (embedded PostgreSQL): the two privilege-matrix tests fail on `TableIncident`. |
| NEW-8 | S3 | **The engine suite fails (458/477).** `review-fixes.test.ts` section 3 still asserts that the card-integrity verifier accepts pure outcome forgeries. Since Oct 6, `verifySealedAudit` also runs `settlementMoneyProblem` and rejects them. The stronger check looks intended, so the 19 assertions need updating. CI's engine job fails until then. | `packages/engine/src/__tests__/review-fixes.test.ts:939`; `packages/shared/src/audit.ts:864-890` | Engine Jest: 19 failures, all at line 939. |
| NEW-9 | S4 | **The compliance text claims controls that do not exist.** | `apps/web/src/lib/legal.ts:12-14`; `responsible-gaming/page.tsx:102`; `auth/routes.ts:53` | Two claims are untrue:<ul><li>"Real-money mode refuses to start until the approved terms version matches": no such server code exists.</li><li>"Every account confirms its holder is 18 or older": accounts created before Oct 1 were never asked.</li></ul>The code also cites `DECISIONS.md` for D9 and D10, but the file does not exist. |

**Owner, please note:** the engine and audit now support rake (`rakeBps`, `rakeCapChips`). It is 0 by default and nothing lets a table set it, but it is a product decision that is not recorded anywhere.

### Claude's 41 findings and their status on 2026-10-07

Severity is for real-money use (S0 = launch blocker … S4 = cosmetic). "GPT" gives the matching GPT-6.1-Sol finding; "—" means GPT did not report it.

| ID | Sev | GPT | Finding (2026-09-30) | Status today | What remains / evidence |
| --- | --- | --- | --- | --- | --- |
| CR-001 | S0 | SOL-007 | No terms, privacy notice, rules, responsible-gaming info or age gate; guests play at once | PARTIAL | Six draft legal pages, a footer on every page, and an 18+/terms gate the server enforces for new guests and sign-ups. Still needed: counsel approval (texts have `[placeholders]`); accounts created before Oct 1 are never asked to accept; no re-acceptance when the terms version changes |
| CR-002 | S1 | SOL-019 | Absent players are dealt in and blinded off forever | FIXED | A timed-out player is sat out (reason TIMEOUT). Optional: sit out after a disconnect grace period |
| CR-003 | S1 | SOL-018 | The turn countdown uses the device clock | FIXED | Counts from the server's relative remaining time. Correct with the device clock up to 30 min off (repro and browser test) |
| CR-004 | S1 | SOL-009 | A table that cannot load or settle traps chips; retries forever | OPEN | `pausedAt`, `TableIncident` and `PAUSED` were added to the schema, but no server code uses them. Retries are still every 1 s with no limit; there is no alert and no void/refund flow (D12) |
| CR-007 | S1 | SOL-011 | A DB hiccup signs players out, deletes the cookie, drops sockets | FIXED | 503 with Retry-After and the cookie kept; sockets stay up and reconnect |
| CR-005 | S2 | SOL-012 | Every token refresh resets the table view | FIXED | The socket is renewed in place (`SESSION_RENEW`). It returns only if `JWT_ACCESS_TTL` is under 10 min (CR-040) |
| CR-006 | S2 | SOL-013 | Two tabs refreshing together sign one out | FIXED | 15 s grace for the replaced token, and one tab refreshes at a time |
| CR-008 | S2 | — | Valid actions refused as "stale" after unrelated table changes | **REGRESSED**; FIXED the same evening | The client sends `turnId`, the server rejects the field, so every action is refused (NEW-1). Server still judges staleness by whole-table revision |
| CR-009 | S2 | SOL-044 | One click buys in with an unchosen amount | PARTIAL | "Sit here" opens a buy-in dialog (but it fails, NEW-1). Lobby "Open 6-seat table" still takes 1,000 chips in one click. The default can be the whole bankroll (D8) |
| CR-010 | S2 | SOL-048 | Play chips shown with "$" | FIXED | One formatter; no "$" in the UI |
| CR-011 | S2 | SOL-039 | No CSP or framing headers | FIXED | Per-request nonce CSP, `frame-ancestors 'none'`, HSTS in production. Not yet checked in a browser against `next start` |
| CR-012 | S2 | SOL-046 | Sessions break unless web and API share a "site" | PARTIAL | Documented. The startup check runs only when `PUBLIC_API_ORIGIN` is set. Needs D6 and a staging log-in/reload test |
| CR-013 | S2 | SOL-040 | Usernames allow impersonation | FIXED | Case-insensitive unique index; `guest_`/`bot_` prefixes and staff words refused. Whether the migration is applied to the live DB was not checked |
| CR-014 | S2 | SOL-043 | No accessible turn announcement | FIXED | A live region announces the turn and the 5 s mark; text countdown; "focus actions on my turn" |
| CR-015 | S2 | ≈SOL-035 | IP-only limits and 5 s lobby polling | PARTIAL | Limits per user, polling only while visible, with ETag. Refresh still counts against 120/min per IP (the 121st refresh behind one IP gets 429) |
| CR-032 | S2 | SOL-017 | Blocked storage or audio freezes the action buttons | FIXED | The action is sent first, sound is best-effort, and the buttons are always released |
| CR-033 | S2 | SOL-010 | A failed next deal rolls back the previous hand's payouts | OPEN | Unchanged (`manager.ts:346-353`) |
| CR-034 | S2 | SOL-016 | Idle warning not re-sent after reconnect | FIXED | `AUTH_OK` carries the current warning |
| CR-035 | S2 | SOL-041 | Reduced motion empties the turn clock | FIXED | Stepped bar plus text countdown |
| CR-016 | S3 | SOL-050 | Unique-key races return 500 | PARTIAL | Fixed for sign-up and guests. A double-submitted table creation still gets 500, and seat races a generic error |
| CR-017 | S3 | ≈SOL-036 | Seat and sit commands have no acknowledgement | **REGRESSED**; FIXED the same evening | The client sends `commandId` and waits for an ack. The server rejects the field, so every buy-in fails (NEW-1). Sit out/in still unacknowledged |
| CR-018 | S3 | — | Table names are unmoderated free text | OPEN | Unchanged |
| CR-019 | S3 | SOL-049 | Decimal bet amount gives a generic error | PARTIAL | The client now rounds to whole chips; the server still answers a generic error |
| CR-020 | S3 | SOL-051 | Metadata promises "autonomous AI opponents" | FIXED | – |
| CR-021 | S3 | — | "Cards verified" overstates the check | FIXED | Now "Cards match commitment", with an explanation |
| CR-022 | S3 | decision only | Every live hand is shown at showdown | OPEN | Now contradicts the published rules (NEW-3). Decide D2, then implement it or correct the text |
| CR-023 | S3 | — | Sign-out needs the server | PARTIAL | Signs out locally first, but is silently undone when the network returns (NEW-6) |
| CR-024 | S3 | — | Turn sounds stay silent after a reload | PARTIAL | Resumed on mouse/keyboard gestures. Missing: a touch unlock (`pointerup`/`touchend`) and a manual iOS Safari check |
| CR-025 | S3 | ≈SOL-042 | Text contrast fails WCAG AA | PARTIAL | Action buttons and the open-seat label pass. Avatar initials fail on blue hues. No whole-page axe scan |
| CR-026 | S3 | — | Guest accounts unrecoverable; guests not told | PARTIAL | Guests are now warned. No upgrade path (D9) |
| CR-027 | S3 | — | Legacy bot decisions block the event loop | OPEN | The new off-switch does nothing (NEW-5) |
| CR-031 | S3 | — | The 1M-shuffle RNG suite can fail on a healthy RNG | FIXED | Two-stage rule (repeat on a fresh sample), nightly CI job, procedure in [docs/TESTING.md](../TESTING.md) |
| CR-036 | S3 | SOL-014 | A bot-scheduling error after commit stalls the table | OPEN | Unchanged |
| CR-037 | S3 | SOL-015 | Restart grace for idle closure is per process | NEEDS DECISION | Single-instance constraint documented; no persisted grace deadline |
| CR-038 | S3 | SOL-038 | Balance display can go backwards | PARTIAL | The client ignores older wallet versions, but the server never sends one |
| CR-039 | S3 | SOL-045 | A closed table, opened fresh, loses "Verify hand" | OPEN | Unchanged |
| CR-040 | S3 | SOL-047 | Startup accepts unusable config values | PARTIAL | Bounds and duration parsing added. The client still refreshes every 10 min while `JWT_ACCESS_TTL` may be 1 min |
| CR-028 | S4 | — | Dead socket contracts (`HAND_HISTORY_LOG`, `activeTableId`) | OPEN | Unchanged |
| CR-029 | S4 | — | UI polish bundle | PARTIAL | Hand-log amounts not grouped; the felt shows raw phase names (`WAITING`, `COMPLETE`) |
| CR-030 | S4 | ≈ licence list | Missing third-party notices | PARTIAL | `THIRD_PARTY_NOTICES.md` (218 packages, up to date). Its `--check` is not in CI. Linux sharp/libvips licence texts missing. The LGPL source offer is still to do |
| CR-041 | S4 | SOL-052 | Odd-chip comment names the wrong seat | FIXED | – |

### What GPT-6.1-Sol missed

GPT-6.1-Sol did not report these at all (checked by searching its report). All were re-confirmed on 2026-09-30.

| ID | Sev | What GPT missed | Status today |
| --- | --- | --- | --- |
| CR-008 | S2 | Valid actions are refused as "The table changed" when anyone else sits in or out, joins or leaves | REGRESSED (NEW-1); fixed the same evening |
| CR-018 | S3 | Table names accept bidi, zero-width and look-alike text, so tables can be spoofed | OPEN |
| CR-021 | S3 | The "Cards verified" label claims more than the check proves | FIXED |
| CR-023 | S3 | Signing out fails when the server is unreachable; the device stays signed in | PARTIAL (NEW-6) |
| CR-024 | S3 | The AudioContext is never resumed, so turn sounds can stay silent all session | PARTIAL |
| CR-026 | S3 | Guests cannot recover their account and are not told | PARTIAL |
| CR-027 | S3 | Legacy bot Monte-Carlo decisions block the server's event loop for every table. GPT mentioned bot CPU only in passing, inside other findings | OPEN |
| CR-031 | S3 | The 1M-shuffle suite can fail by chance on a healthy RNG (one of Claude's four runs did), and there was no procedure for that | FIXED |
| CR-028 | S4 | Socket events and fields that nothing sends or reads | OPEN |
| CR-029 | S4 | UI polish: a stuck lobby error, card names, watchdog wording, raw status labels | PARTIAL |

- **Treated differently:** GPT listed forced showdown only as a house-rule decision. Claude lists it as a finding (CR-022). The new House Rules now promise auto-muck while the engine still shows every hand (NEW-3).
- **Rated differently:** GPT rated SOL-014 (legacy-bot tables only), SOL-015 (only with several servers) and SOL-017 as S1. Claude rated them S3, S3 and S2 (CR-036, CR-037, CR-032), keeping S1 for harm in normal single-server play. GPT rates 29 findings S0/S1 in all.
- **Counted differently:** about 20 of GPT's 52 findings restate the 2026-09-29 findings F01–F22 (for example SOL-001 = F09, SOL-022 = F08). Claude tracks those in the next table.
- **Found by GPT, not Claude, and adopted after re-running:** CR-032 to CR-041 (SOL-017, 010, 016, 041, 014, 015, 038, 045, 047, 052).

### The 2026-09-29 findings (F01–F22) on 2026-10-07

| ID | Status | Change since 2026-09-29 / what remains |
| --- | --- | --- |
| F01 | PARTIAL | A starting bankroll of 0 is now allowed, and guests are warned. Grants still go into the mutable `User.bankroll` that pays buy-ins. Separate play and cash balances exist only in the unwired ledger |
| F02 | PARTIAL | The ledger database layer exists (balanced postings, idempotency, append-only, BIGINT; the real-Postgres tests pass). **Nothing in the game server uses it** (`docs/money/LEDGER.md:5`). Buy-ins and cash-outs still write `User.bankroll` |
| F03 | NEEDS DECISION | No payment or custody code; only ledger posting shapes. Needs entity, PSP/custody, assets and chains |
| F04 | OPEN | Only a self-declared 18+ tick. No identity, eligibility, sanctions or suspension state |
| F05 | OPEN | The responsible-gaming page is information only (correctly labelled); no limits or self-exclusion |
| F06 | OPEN | Terms now forbid bots and assistance. No detection; the bot switch is dead (NEW-5) |
| F07 | PARTIAL | Lockout, constant-time login, session list and sign-out-everywhere added. Admin is still a password plus role; no password change or reset. The lockout can be abused (NEW-4) |
| F08 | PARTIAL | Malformed bodies no longer reach logs. One path left: `routes/admin.ts:40` logs the full URL, including the query string |
| F09 | OPEN | A zero-row cash-out credit is still not detected (`manager.ts:164-168`) |
| F10 | OPEN | `rebaseTurnClock` exists but is never called. A restart still folds, and now also sits out, the waiting player (NEW-2) |
| F11 | PARTIAL | Key ring with key ids, rotation script, and production refuses weak or reused keys. One key still covers live state and retained audits; no KMS/HSM |
| F12 | PARTIAL | Ledger tables read-only to the runtime role, and a trigger stops it changing `User.role` and `User.kind`. It can still rewrite `User.bankroll`, read `passwordHash` and insert an ADMIN user. `TableIncident` was not added to the privilege test (NEW-7) |
| F13 | OPEN | Table state is still bound only to the table id, with no freshness or rollback protection |
| F14 | OPEN | In the re-check, a re-sealed record with a CALL swapped for a CHECK still passed all three verifiers. The new settlement-money replay checks money flow, not betting legality |
| F15 | NEEDS DECISION | Code side done: proxy CIDRs, TLS, compose on 127.0.0.1 without default passwords, Caddy/nginx configs. Needs hosting (D6) and staging inspection |
| F16 | PARTIAL | Idle and absolute session lifetimes, and reuse detection with a 15 s grace. Within the grace window the old token is accepted any number of times and not logged. No shorter admin sessions |
| F17 | FIXED | Revoked sessions are disconnected cluster-wide; private events re-check the session (5 s cache bound) |
| F18 | FIXED | Origin/Sec-Fetch-Site/JSON guard on every state-changing request |
| F19 | FIXED | `Cache-Control: no-store` on every API response (lobby: private, no-cache, ETag) |
| F20 | PARTIAL | Limits keyed per user. Counters are still per process; no socket connection quotas; no load test |
| F21 | PARTIAL | `/api/ready` checks DB, schema, recovery and draining; graceful drain. A stuck table still never affects readiness, and `clientActionId` is still unused |
| F22 | PARTIAL | Backup and restore-drill outline in [docs/DEPLOYMENT.md](../DEPLOYMENT.md). No expired-session or IP clean-up job; retention periods are placeholders |

### Verification performed (2026-10-07, current working tree)

| Check | Result |
| --- | --- |
| Rebuild of all packages (`npm run build`, DB URL pointed at a dead loopback port) | Passed |
| Typecheck (shared, engine, server, web) | 4/4 passed |
| Engine Jest, 15 suites (including the 1M-shuffle RNG suite) | **458/477; 19 failures, all in `review-fixes.test.ts` section 3 (NEW-8).** RNG, evaluator, leakage, pots, lifecycle and the new turn-clock suites pass |
| Server `npm test` file list (10 files) through `test/support/run-tests.mjs` | 115/115 passed |
| Ledger unit tests (`--import tsx test/money-amounts.test.mjs test/money-flows.test.mjs`) | 21/21 passed |
| Real-Postgres suite `npm run test:db` (embedded PostgreSQL, disposable) | **41/43**: migrations, ledger, concurrency (seat races, 50 concurrent buy-ins, 1,000+ postings), RLS and role checks pass; the 2 privilege-matrix tests fail on `TableIncident` (NEW-7) |
| Browser suite (Playwright, Chrome desktop and Pixel 7, ports 3107/4107) | 156/156 passed. It uses a fixture game server, so it cannot catch NEW-1 |
| Socket contract test against the real server (`review/claude/recheck/game-server/socket-contract.test.mjs`) | 4/4 confirmed NEW-1, CR-017 and CR-019 behaviour |
| Re-check repros (`review/claude/recheck/{auth-security,game-server,web-ui,legal-compliance}/`) | One adapted repro or harness per item; results summarised in the tables above |
| Engine lifecycle fuzz (`review/claude/repro/engine-fuzz.mjs`, seeds 1–3, 60 tables × 800 steps) | 0 failures: 6,248 hands, 73,611 events, 1,680 showdowns, 142 table closures, 13,721 participant audits and 165,727 browser card verifications. Chips conserved, no hidden card leaked, no false alarms |

Not done: Playwright against `next start`; anything multi-process; any check of whether the three Oct migrations are applied to the live OnlinePoker database. The live database was not touched today.

### What to do next (in order)

1. **Fix NEW-1 before anything else (done the same evening, see [socket contract and startup](12-october-7-socket-contract-and-startup.md)):**
   - accept `turnId` and `commandId` in the server schemas;
   - judge staleness by turn identity (CR-008);
   - acknowledge seat and sit commands (CR-017);
   - add a contract test that sends the web client's exact payloads to the real socket server, so the fixture server cannot hide this again.
2. **Make the House Rules true or change them:**
   - wire the time bank into table creation and the server timer, and call `rebaseTurnClock` on recovery (NEW-2, F10);
   - decide D2 and either auto-muck or remove the claim (NEW-3, CR-022);
   - wire or remove `ENABLE_LEGACY_BOTS` (NEW-5).
3. **Get CI green:** update the 19 stale engine assertions (NEW-8). Add `TableIncident` to the privilege matrix, and restrict its UPDATE to `resolvedAt`/`resolvedBy` (NEW-7).
4. **Remaining player-harm items:**
   - login lockout abuse (NEW-4) and offline sign-out (NEW-6);
   - CR-004 (wire PAUSED, back-off, alert and void/refund) and CR-033;
   - F09 and the lobby one-click table creation (CR-009);
   - CR-038 (server wallet version).
5. **Then the rest of the PARTIAL and OPEN rows above**, and the real-money prerequisites F01–F05 (wiring the ledger into gameplay comes first).

**Decisions still needed from the owner** (details in [30 September review](../reviews/2026-09-30-claude-review.md) §6):
- D1 absence policy; D2 showdown mucking; D3 idle closure; D4 time bank (now published but not applied);
- D5 chip unit (implemented as "chips"; confirm); D6 hosting topology; D7 username policy (implemented; confirm);
- D8 buy-in default; D9 guests (warned; upgrade path missing); D10 legal documents and markets (counsel);
- D11 bots; D12 void/refund of unrecoverable hands;
- and the rake terms.

The code cites a `DECISIONS.md` that does not exist. Record the decisions there or here.
