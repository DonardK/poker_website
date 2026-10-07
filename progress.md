# Hold'em Live — Implementation Progress

Handoff doc. Spec: `plan.md`. Do not restart from Phase 1.

The completed phases below record the historical play-chip implementation. They do not mean that real-money, crypto, licensing or production-security requirements are complete.

| Phase | Code status | Verified? | Completed |
|---|---|---|---|
| 1. Architecture & data layer | **Done** | Typecheck + lobby/login browser | 2026-09-19 |
| 2. Core deterministic engine | **Done** | Jest: deck, evaluate, 2000-iter pot fuzz | 2026-09-19 |
| 3. State machine & game loop | **Done** | Jest table tests + 6-max play | 2026-09-19 |
| 4. Quantitative bot engine | **Done** | Jest profile legality + live bots | 2026-09-19 |
| 5. Socket integration & masking | **Done** | Live 6-max, rehydrate, cash-out | 2026-09-19 |
| 6. Frontend UI / UX / animations | **Done** | Lobby + table play in browser | 2026-09-19 |
| 7. Verification + bugfix pass | **Done** | Jest 43 + browser (guest, table, sit-out, cash-out) | 2026-09-20 |

**Overall (2026-10-07, evening): NO-GO for deposits, customer crypto custody, or redeemable game chips.** The stop-ship found earlier today (NEW-1: the real server refused every action and buy-in from the web client) is fixed and verified end to end against a real PostgreSQL. The working tree needs the three October migrations on whatever database it runs against; the game server now refuses to start and names them if they are missing. The backend has tested play-chip gameplay, authenticated encryption for hidden game state, audit mechanisms and production TLS guards. Uncommitted fixes from 1–7 October have closed or narrowed many findings. Remaining work:
- **Claude's review (2026-09-30), 41 findings:** 18 fixed, 14 partly fixed, 8 open, 1 awaiting a decision (CR-008 and CR-017 were fixed this evening).
- **The 2026-09-29 review, 22 findings and readiness gaps (5 Critical, 11 High, 6 Medium):** 3 fixed, 10 partly fixed, 7 open, 2 awaiting a decision. The real-money prerequisites F01–F05 (ledger in use, payments, identity/eligibility, AML, responsible gaming) are all still open or only partly done.
- **Today's re-check:** found 9 new defects in the October changes (NEW-1 now fixed). Fixing the lobby's "Game server unavailable" found 5 more (NEW-10 to NEW-14; 4 fixed). Full log: `opuswork.md`.

Not everything is encrypted, and the project has not been certified to MGA/GLI standards. Fixes, production validation and independent assurance remain outstanding. See the 2026-10-07 entry, `CLAUDE-REVIEW.md` and `GPT-6.1-SOL-REVIEW.md`.

---

## 2026-10-07 (evening) - "Game server unavailable" in the lobby; joining tables fixed (NEW-1)

**Status: the code fixes are made and verified on disposable databases. The owner's dev game server still has to be restarted, and the live database's migration state was not checked (see below).** Full details, including every file changed in this session: [opuswork.md](opuswork.md).

**What happened.** The lobby showed "Game server unavailable. Start both services with npm run dev, then retry." The web app (port 3000) was running, but nothing answered on port 4000.
- `npm run dev` started at 16:42, 2½ minutes after the PC booted. Its game server exited shortly after, and `tsx watch` then waits for a file change without restarting it.
- The old start-up log showed only "fatal startup error" with the error's name. The safe-log serializer drops every Prisma error message, and Prisma prints nothing of its own for a failed connect, so the reason was invisible (NEW-10).
- Most likely the database connection failed at start-up. On this network IPv6 does not work, and Supabase's direct host (`db.<ref>.supabase.co`) is IPv6-only, while the IPv4 pooler is reachable.
- Not caused by the review's own build: the shared packages were last rebuilt by `npm run dev` itself at 16:42.
- A second blocker would have followed even with the server up: NEW-1 refused every buy-in and action.

**Fixed (uncommitted):**
- **NEW-1, CR-008, CR-017** (`apps/server/src/socket/index.ts`, `apps/server/src/game/manager.ts`):
  - the socket schemas accept the web client's `turnId` and `commandId`;
  - an action is stale only when its turn is over;
  - seat and sit commands are acknowledged;
  - a failure to deal, or a failed balance notification, after a committed seat claim is logged instead of being reported as a failed claim.
- **NEW-10 and NEW-11** (new `apps/server/src/db/connect.ts`, `apps/server/src/index.ts`): a failed database connection is explained in plain words, naming only host:port. In development it is retried with back-off instead of ending the game server.
- **NEW-12** (`apps/server/src/db/prisma.ts`): the start-up schema check covers the October migrations and names each one that is missing. Previously, a database without them let the server start while every sign-in failed.
- **The lobby message** (`apps/web/src/lib/api.ts`, development only): says the game server stopped and that the reason is in the `[server]` lines.
- **Docs:** README troubleshooting paragraph; `.env.example` note on the IPv6-only direct host.
- **NEW-13:** the local Prisma client was older than `schema.prisma` (no `pausedAt`, `pausedReason` or `TableIncident`); regenerated.
- **Tests:** `apps/server/test/socket-contract.test.mjs` and `apps/server/test/startup.test.mjs` (15 tests), added to `npm test`.

**Verification:**

| Check | Result |
| --- | --- |
| Typecheck, server and web | Pass |
| Server suite (12 files) | 130/130 |
| Ledger unit tests | 21/21 |
| Browser suite | 156/156 |
| Real game server on embedded PostgreSQL | All passed:<ul><li>a database at the September schema is refused, naming the two missing migrations;</li><li>a database that is down at start-up is waited for and used as soon as it answers;</li><li>three guests create a table, two sit down exactly as the buy-in dialog does (acknowledged), and a hand is played;</li><li>an action still counts after a bystander sits out mid-turn, and an action for a finished turn is refused.</li></ul> |

**Still open from this work:**
- The owner must restart `npm run dev` and read the `[server]` lines.
- If they say "Database is missing migration(s)", the three October migrations must be applied to the Supabase database. That is a schema change to the live database, and needs an administrator connection that `.env` does not have.
- Development runs against the shared live database (NEW-14): every restart runs table recovery on live data. A local development database is recommended.
- The live database was not read: a read-only probe was refused as a production read and was not worked around. The owner can run `node review/claude/recheck/dev-server/live-connect-probe.mjs`.

---

## 2026-10-07 - Claude's full review (41 findings), what GPT-6.1-Sol missed, and a re-check of the Oct 1–6 fixes

**Status: review finished on 2026-09-30 and re-checked today against the current working tree, including the uncommitted Oct 1–6 fixes.**
- **Stop-ship (fixed the same evening, see the entry above):** the current working tree must not be deployed, even for play chips. The real server refuses every action and every buy-in that today's web client sends (NEW-1 below).
- **Claude's 41 findings:** 16 fixed, 14 partly fixed, 8 open, 2 regressed (made worse), 1 waiting on an owner decision.
- **The 22 findings of the 2026-09-29 review:** 3 fixed, 10 partly fixed, 7 open, 2 waiting on a decision.
- **Re-check:** found 9 new defects in the Oct 1–6 changes.
- **Real money:** still NO-GO.

No application code, tests or databases were changed by this review or the re-check. Only new files were added: `CLAUDE-REVIEW.md`, `review/claude/**`, and this entry.

### Who reviewed what

- **Claude (Anthropic)** reviewed every production file of the engine, shared package, server, web app, schema and migrations (159 files) on 2026-09-29/30.
  - It ran the existing suites, a 28,273-hand lifecycle fuzz and its own repro scripts.
  - Full report: [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md), with findings CR-001 to CR-041, decisions D1–D12 and legal register L1–L10. Repro scripts: `review/claude/repro/`.
- **GPT-6.1-Sol** reviewed the same tree at the same time, from the brief in [GPT-6.1-SOL-REVIEW-PROMPT.md](GPT-6.1-SOL-REVIEW-PROMPT.md).
  - Its report: [GPT-6.1-SOL-REVIEW.md](GPT-6.1-SOL-REVIEW.md) (SOL-001 to SOL-052). Its scripts: `review/gpt-6.1-sol/repro/`.
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
| CR-031 | S3 | — | The 1M-shuffle RNG suite can fail on a healthy RNG | FIXED | Two-stage rule (repeat on a fresh sample), nightly CI job, procedure in `docs/TESTING.md` |
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
| F22 | PARTIAL | Backup and restore-drill outline in `docs/DEPLOYMENT.md`. No expired-session or IP clean-up job; retention periods are placeholders |

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

1. **Fix NEW-1 before anything else (done the same evening, see the entry above):**
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

**Decisions still needed from the owner** (details in `CLAUDE-REVIEW.md` §6):
- D1 absence policy; D2 showdown mucking; D3 idle closure; D4 time bank (now published but not applied);
- D5 chip unit (implemented as "chips"; confirm); D6 hosting topology; D7 username policy (implemented; confirm);
- D8 buy-in default; D9 guests (warned; upgrade path missing); D10 legal documents and markets (counsel);
- D11 bots; D12 void/refund of unrecoverable hands;
- and the rake terms.

The code cites a `DECISIONS.md` that does not exist. Record the decisions there or here.

---


## 2026-09-29 - complete backend security and real-money readiness review

**Status: review completed; all 22 findings and readiness gaps remain OPEN. No application fixes or production database changes were made during this review.** The complete review is recorded below so this progress log includes the defects, missing capabilities, verified protections, evidence, limitations and required follow-up. The standalone copy is [BACKEND-SECURITY-AUDIT.md](BACKEND-SECURITY-AUDIT.md); supporting scripts are [security-review.mjs](scripts/security-review.mjs) and [review-database.mjs](scripts/review-database.mjs).

The September 27 entry's 25 fixed findings belong to an earlier review. They do not close any of the 22 findings below. Earlier implementation and compliance-model summaries describe the state at those dates and do not establish certification or readiness to handle money.

Review date: 29 September 2026. Target: Malta, real-money and crypto poker. Custody model and player countries remain undecided.

### Decision

**NO-GO for accepting deposits, holding customer crypto, or making game chips redeemable.** The project is a well-tested play-chip poker implementation with meaningful cryptographic protections. It does not yet implement the financial, player-protection, identity, fraud, or operational controls needed for the requested business. Several concrete security and reliability defects also remain.

This is an engineering review of the current working tree and read-only checks of the linked OnlinePoker database. It is not an MGA system audit, a penetration-test certificate, a laboratory RNG certification, or a legal determination of the proposed business. Passing the existing tests does not establish readiness for real money.

Severity below is assessed against the requested real-money use. An absent payment subsystem is a launch blocker, not evidence that an existing payment system was exploited. Conditional findings state the conditions explicitly. No production balances, accounts, game records, roles, or schema were changed. Application source was left unchanged; the additions are this report and two verification scripts. Pre-existing workspace edits were preserved.

The review records **22 findings and readiness gaps: 5 Critical, 11 High, 6 Medium**. These counts include missing capabilities and unverified operational controls, as well as reproduced defects; they are not a count of independently exploitable vulnerabilities.

### Verification performed

| Check | Observed result |
| --- | --- |
| `npm.cmd run typecheck` | Passed across all workspaces |
| `npm.cmd test` | 451 engine tests passed across 14 suites; 64 server tests passed; one direct TLS test initially skipped because OpenSSL was absent from PATH |
| Direct TLS test with installed Git OpenSSL on PATH | Previously skipped test passed: HTTPS accepted, plaintext refused |
| Total existing tests confirmed passing across those runs | 516 |
| `npm.cmd audit --omit=dev --json` and `npm.cmd audit --json` | Zero reported known vulnerabilities at review time; does not establish absence of unknown or application vulnerabilities |
| RNG suite | 1,000,000 production deck shuffles plus rejection-sampling, distribution, independence, failure and source checks passed |
| Evaluator suite | All 2,598,960 five-card combinations; 7,462 equivalence classes; 300,000 seven-card comparisons; 200,000 multiplayer comparisons passed |
| Leakage sweep | 2,000 hands, 20,556 transitions, 173,389 projected snapshots, including 19,265 cryptographically verified snapshots; passed |
| Local adversarial probes | Reproduced the gaps described below using disposable keys and in-memory database replacements |
| Live database permissions | Nine poker tables enforce RLS and FORCE RLS; `anon` and `authenticated` have no table access |
| Runtime database role | `poker_server`, no superuser, role creation, database creation, RLS bypass, role memberships, or public schema CREATE privileges |
| Completed hand history | Runtime role cannot UPDATE or DELETE Hand, HandPlayer, HandAction or HandPot; cannot DELETE User or Table to cascade-delete history |
| Supabase security advisor | One informational notice: `_prisma_migrations` has RLS and no policy. Its browser and runtime access is denied; this is appropriate for this design. [Advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| Actual application DB connection | TLS 1.3, `TLS_AES_256_GCM_SHA384`, authenticated as `poker_server` |
| Saved table state | All 6 stored ciphertexts authenticated and their decrypted table identifiers matched their rows |
| Historical hole cards | All 241 stored pairs authenticated with their hand/seat context; zero plaintext `holeCards` arrays contained cards |
| New hand audits | Both new-format records passed card, outcome, row-binding and table-chain verification |
| Legacy hand audits | 54 of 56 hand records lack the new audit format. These records cannot be retrospectively represented as having pre-deal commitments under the new protocol |
| Refresh token storage | Existing session values had the expected SHA-256 hex format; no raw refresh JWTs found by the format check |

Database counts describe the review snapshot and can change. Read-only verification used `SET TRANSACTION READ ONLY` and printed aggregate results, never cards, passwords, ciphertext contents or credentials.

The opt-in database integration test was not executed against the populated database. Its creates/deletes require a disposable environment. Mocked transaction tests and permission checks do not replace concurrent transaction and crash tests against real Postgres. Redis failover, public deployment, browser security headers at a production URL, DDoS, backups, restore drills and payment providers were not exercised.

### Encryption: what is and is not protected

| Data or connection | Current protection | Boundary or remaining work |
| --- | --- | --- |
| Stored deck, hidden cards, live table state | AES-256-GCM, random 96-bit nonce, 128-bit authentication tag and row-specific associated data | Sound primitive and useful context binding. Key custody/rotation and replay resistance are separate problems; see F11/F13 |
| Stored sealed hand audit | Same authenticated encryption, bound to table and hand | Runtime process has the decryption key; ADMIN audit route deliberately decrypts completed hands |
| Stored passwords | bcrypt cost 12, with the 72-byte limit checked | Passwords are hashed, appropriately; they should not be reversibly encrypted. MFA, compromised-password checks and account recovery controls are missing |
| Refresh tokens | SHA-256 hash in Session; JWT delivered through HttpOnly cookie | Secure and Strict in production. Rotation exists, but replay/lifetime policy is incomplete |
| Access/refresh JWT contents | HS256 signature | Signed, not encrypted. Claims such as username, user ID and session ID are readable to a token holder; that is not itself a defect |
| Browser/API/WebSocket | Production TLS gates; direct HTTPS supports minimum TLS 1.2 | Local `.env` is development with HTTP and no direct TLS/proxy. No public deployment was supplied to verify. Proxy mode depends on network isolation and trusted headers |
| Application/Postgres | Strict TLS requested in config; TLS 1.3 verified on the actual application connection | Cloud network restrictions, provider disk/backups encryption settings and key administration were not independently inspected |
| Redis | `rediss://` required in production if enabled | Currently disabled locally. Redis would handle socket fanout and may contain sensitive socket metadata; network isolation and access control remain necessary |
| Email, IP, user agent, balances, seats, board, public hand actions | Stored as normal database values | No application field encryption for these. Apply data classification, access controls, retention and selective field encryption where justified; provider disk encryption has a different threat boundary |
| Logs | Ordinary Pino logs | Malformed request bodies can leak passwords into error logs; F08 |
| Process memory | Decrypted state and keys are available to the game process | Encryption at rest does not hide cards from a compromised application or an operator with memory/key access |

**“Everything is encrypted” would be inaccurate.** Encryption is one part of confidentiality; authorization, integrity, accounting and availability are separate properties. Increasing the AES key size would not solve the findings in this review. OWASP recommends authenticated encryption and separate key management, with password hashing used for passwords. [Cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

### Findings and required remediation

#### F01 — Critical: free play chips must never become redeemable balances

Evidence: `apps/server/src/auth/routes.ts:76` and `:130`; `apps/server/src/config.ts:25`; `apps/server/prisma/schema.prisma:73`.

Registration and unauthenticated guest creation each credit `DEFAULT_STARTING_BANKROLL` into the same balance used for table buy-ins and cash-outs. The default is 10,000. The environment schema requires a positive starting bankroll, so setting it to zero does not even disable issuance cleanly. The probe received HTTP 201 and 10,000 chips from `/api/auth/guest`.

This is intentional play-chip behavior today. Connecting redemption to that balance would allow new accounts to create redeemable value, including value transferred through play. Rate limiting does not make issuance financially safe.

Required: independently separate demo, promotional and cash balances; use a zero cash opening balance; credit cash only through a verified, uniquely identified ledger event. Guest/demo identities must not access cash games. Reconcile and explicitly classify every pre-launch balance and test account before enabling money. Never convert this database's existing play balances to cash automatically.

#### F02 — Critical: no financial ledger, asset model or reconciliation

Evidence: `schema.prisma:64`, `:125`, `:142`; `game/manager.ts:165`, `:221`; `routes/tables.ts:181`.

Money is represented by mutable `User.bankroll` and seat stacks. Transactions help avoid partial updates, but there is no immutable double-entry ledger, account hierarchy, currency/chain/asset identity, reserved balance, source transaction, reconciliation process or independently auditable wallet history. Buy-ins and cash-outs are outside the hand hash chain. Postgres `Int` is a signed 32-bit value; it is not a general representation of crypto atomic units. Currency units and conversion/rounding rules are undefined.

Required: model each supported asset explicitly and choose bounded exact integer/decimal units; never use floating-point money or cross a JavaScript safe-integer boundary. Establish immutable balanced journals, unique operation IDs, table escrow, available/reserved accounts, reversals, fee accounts and reconciliation against both player liabilities and external assets. Decide whether games settle in EUR or crypto units. Integrate escrow movements and hand settlement atomically, or through a rigorously idempotent protocol with durable recovery.

Acceptance: concurrent buys/withdrawals cannot overspend; every debit has an equal credit for the same asset; retries cannot post twice; crash/restart and external duplicate callbacks converge to one result. Reconstruct every balance from the ledger and explain every reconciliation difference.

#### F03 — Critical: fiat/crypto deposit, withdrawal and custody controls are absent

Evidence: complete server route inventory in `app.ts`, schema and server dependencies. No deposit, withdrawal, provider webhook, blockchain observer, wallet or custody implementation exists.

Required before launch: select the legal entity, provider/custody contract, supported assets/chains and settlement currency. Implement authenticated provider callbacks, replay protection, unique provider-event identities, out-of-order processing and a durable inbox/outbox. Define confirmation/finality and chain-reorganisation policies, address attribution, unsupported token/chain handling, fees, conversion quotes and reconciliation. A deposit seen in a mempool must not automatically become withdrawable value.

Withdrawals require reservation before dispatch, transaction-specific authorization, AML/risk holds, address verification, limits, approval rules, idempotent dispatch and recovery from an uncertain provider response. A timeout must not cause a second payout. Card chargebacks, refunds and rejected transfers need explicit states and ledger entries. Use hosted payment collection if taking cards; do not add card-number storage to this backend.

For self-custody, isolate signing from gameplay, use an appropriate HSM/MPC/multisignature design, hot-wallet exposure limits, dual control, recovery ceremonies and independently tested incident procedures. No crypto signing secret should share this game's `.env` or server process.

#### F04 — Critical: identity, eligibility and AML gates are missing

Evidence: `schema.prisma:64`; `auth/routes.ts`; `auth/middleware.ts:6`; `routes/tables.ts`; `socket/index.ts`.

A session and `kind === HUMAN` establish gameplay access. There is no verified identity, age, residence/market eligibility, email-verification state, sanctions/PEP screening, source-of-funds workflow, restricted-account state or compliance case record. Guests can play. There is no authoritative account suspension/exclusion gate at seat claim or hand start.

Required: a backend-enforced eligibility state machine integrated with identity and screening providers, reviewer decisions, revocation, restricted-market rules, AML monitoring and auditable case handling. Gate deposits, cash games and withdrawals according to the approved policy. Restrictions must affect existing sockets and concurrent transactions, while preserving lawful access to funds. An MGA licence must not be assumed to authorize every country where a player may connect. Malta is confirmed as the intended base/market; the complete target-market list is unresolved.

MGA describes risk-based AML/CFT controls for B2C Type 1, 2 and 3 licensees. Exact obligations and timing need the licensed operator's compliance policy. [MGA AML guidance](https://www.mga.org.mt/licensee-hub/compliance/anti-money-laundering/)

#### F05 — Critical: responsible-gaming enforcement is absent

Evidence: no self-exclusion, deposit/wagering-limit, reality-check or responsible-gaming models/routes in the backend; `auth/middleware.ts`, table creation and seat/action paths do not check them.

Required: persist self-exclusion and applicable brand/identity scope; prevent circumvention by a replacement account; enforce the approved limits atomically across sessions and workers; support cooling-off rules, history, notices and monitoring. Recheck eligibility at the points where new exposure is taken. A five-minute idle table closure is not a responsible-gaming limit. Excluded players still need an appropriate route to withdraw their funds.

MGA guidance calls for self-exclusion, deposit or wagering limits and reality checks. Its 2026 thematic review also identifies implementation failures such as delayed exclusions and duplicate-identity gaps. [Required tools](https://www.mga.org.mt/faqs/remote-gaming-are-there-any-mandatory-responsible-gambling-tools-which-must-be-offered-to-players/), [player protection](https://www.mga.org.mt/licensee-hub/compliance/player-protection/), [2026 thematic review](https://www.mga.org.mt/the-mga-publishes-findings-from-thematic-review-on-self-exclusion-practices-in-the-online-gaming-sector/)

#### F06 — High: no anti-collusion, multi-account or automation operations

Evidence: the server authenticates accounts individually; no device/account relationship, collusion, chip-dumping, real-time assistance or investigation subsystem was found. New tables reject built-in bots, but legacy bots still run through `game/manager.ts:336`.

Correct shuffling cannot prevent coordinated players from sharing cards externally, chip dumping, controlled opposing accounts or automated play. The one-seat-per-user constraint does not identify one-person-with-many-users behavior.

Required: identity/device/payment linkage appropriate to privacy law, table-sharing and transfer-pattern analysis, behavioral alerts, review tooling, investigation evidence and an appeal process. Separate all legacy/demo bots and test accounts from the licensed cash environment; require explicit rules for any automated participant. Avoid presenting probabilistic fraud signals as proof on their own.

#### F07 — High: player and administrator authentication is below the target assurance

Evidence: `auth/routes.ts:108`; `routes/admin.ts:37`; `schema.prisma:64`.

ADMIN access is the ordinary password/session flow plus a database role check. There is no MFA/passkey requirement, recent reauthentication, dedicated privileged identity, password-change/recovery workflow, session inventory or remote sign-out control. Failed login checks are IP-limited only; missing accounts skip bcrypt comparison, exposing a timing difference. Registration explicitly reports an existing username/email.

Required: phishing-resistant administrator authentication, separate privileged access and least privilege, step-up for sensitive player operations, safe recovery, compromised-password checks and account/device/IP risk controls. Add uniform credential-check behavior and auditable success/failure/revocation events. Test support recovery as an account-takeover surface. bcrypt cost 12 is not itself the defect. [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

#### F08 — High, reproduced: malformed requests leak passwords to logs and bypass rate limits

Evidence: `app.ts:39`, `:56`; `logger.ts:4`; `scripts/security-review.mjs` observation `malformedJson`.

`express.json` runs before both rate limiters. Its parse error includes the original request body. The catch-all error logger serializes the error with Pino's default error serializer and no redaction. A malformed login containing a synthetic password produced a log representation containing that password. Sixteen malformed auth requests all returned 500, bypassing the 15/minute auth limiter entirely. Parser limits still bound a single body, but do not stop repeated error/log work.

Required: apply appropriate limits before body parsing; handle parser and oversized-body errors as 400/413; log an allow-list of error metadata. Removing only `err.body` is insufficient if a parser's message or stack embeds input. Redact credentials/cookies/authorization and other sensitive fields across all logging paths. Admin access logs also currently preserve query strings through `originalUrl`; log the path without query parameters. Test with synthetic secrets, never actual credentials. [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

#### F09 — High, reproduced with an inconsistent recipient: cash-out can silently discard chips

Evidence: `game/manager.ts:165`; observation `missingCashoutRecipient`.

The cash-out loop calls `updateMany` with `kind: HUMAN` but ignores its affected-row count. It then empties `cashOuts` and persists the released seat. A fixture returning `{count: 0}` committed with the seat released and no remaining payment instruction. An absent/mismatched identity or administrative kind change can therefore discard a human payout without failing the transaction. Ordinary valid-user cash-outs do pass existing tests; this reproduction is a fault case, not an unauthenticated exploitation claim.

Required: verify the expected recipient and exactly one matching wallet mutation/ledger posting; otherwise roll back and preserve a recoverable obligation. Explicitly distinguish demo bot balances from human money instead of silently skipping unmatched rows. Acceptance must include removed/restricted/reclassified recipients, DB failures, retries and restore recovery.

#### F10 — High, reproduced: server downtime can immediately forfeit a player's turn

Evidence: `index.ts:48`; `game/manager.ts:109`, `:335`; observation `outageRecovery`.

Recovery resets the inactivity baseline but preserves the old betting deadline. If that deadline expired during an outage, the timer is scheduled immediately. Recovery runs before the HTTP listener starts. A three-player fixture started 60 seconds earlier produced `TIMEOUT_FOLD` about 4 ms after recovery, without any reconnection opportunity.

Required: define and audit the interrupted-game policy; pause or fairly rebase affected deadlines, provide an appropriate reconnect window and distinguish system outage from player inactivity. Coordinate this across workers so a rolling restart cannot arbitrarily reset or expire turns. Test partial outages, long startup, DB stalls, clock jumps, repeated restarts and mixed connected/disconnected players. Do not allow a restart to act as an operator-selectable advantage.

#### F11 — High: key lifecycle and separation are incomplete

Evidence: `game/encryption.ts:5`; `config.ts:19`; observation `productionSecretValidation`; local sanitized configuration check.

One environment key encrypts live states, historical hole cards and all sealed audits. The envelope has a format version but no key ID, keyring, envelope encryption, rotation job or recovery workflow. The production validator accepts an all-zero encryption key reused as the access-token secret, provided the refresh secret differs. The current local secrets are distinct; this probe demonstrates a missing guard, not weak keys found in use.

Required: managed key custody with narrowly scoped access, auditable use and separation of authentication, current gameplay, retained audit data and any financial signing keys. Add versioned key identifiers, online/offline rotation and retention procedures, backup/recovery tests and emergency revocation. Reject obvious placeholders/reuse, but do not pretend a regex proves randomness. Plan the encryption volume and nonce/key lifetime. JavaScript data cleanup is not a guarantee of memory zeroization.

#### F12 — High: one runtime role can alter both balances and administrator identity

Evidence: live `has_column_privilege` queries; `prisma/migrations/20260920140611_poker_security/migration.sql`; `schema.prisma:64`.

The restricted role correctly lacks DDL and history mutation privileges. However, it can read password hashes and UPDATE both `User.role` and `User.bankroll`; server RLS policies allow all rows to that role. A compromise of this credential or backend process has an unnecessarily broad impact across identity, gameplay and funds. This does not mean a browser can directly exercise those privileges.

Required: separate privileged administration, identity and financial write capabilities. Remove role-management permissions from routine gameplay paths; use narrowly scoped operations with validated accounting invariants and audit trails. Verify effective privileges at startup/CI and after migrations. Field encryption alone cannot stop a process that holds both the database privileges and decryption keys.

#### F13 — High: audit integrity is not independently anchored and live state is replayable

Evidence: `game/encryption.ts`; `game/manager.ts:146`; `engine/src/audit.ts`; `COMPLIANCE.md` section 6.

Completed hand rows are append-only to the runtime role, an important protection. In-flight events live inside a replaceable encrypted table snapshot until settlement. AAD identifies the table but does not prove that a ciphertext is the newest state of that table. GCM authenticates an older valid ciphertext too. An actor able to restore database state can replay old snapshots; a sufficiently privileged database/operator can also replace a complete unanchored history or remove its tail. A local hash chain alone cannot prove completeness against that actor.

Required: durable uniquely identified commands and start/void/settlement records; freshness/reconciliation checks against independently protected ledger/history; externally witnessed commitments/checkpoints or appropriately controlled immutable storage. Anchor enough information to detect missing final hands as well as edits. Preserve a durable record of interrupted/voided games, not only a process log. Define and test the authorized backup-restore protocol so old game state cannot reissue a financial settlement.

#### F14 — High assurance gap, reproduced: audit replay does not validate betting legality

Evidence: `packages/engine/src/audit.ts:158`; observation `auditBettingLegality`.

The verifier explicitly recomputes contributions and outcomes without re-judging action legality, minimum raises or turn order. Replacing a recorded 10-chip CALL with CHECK, leaving the amount unchanged and rebuilding the hash chain, passed both sealed-card and outcome verification. A legitimate CHECK cannot contribute 10 chips. This requires access to construct a new/resealed record; it is not a way for a normal player to bypass the live action validator, and changing previously witnessed hashes would be detectable.

Required: a versioned replay that validates the complete rules and transition sequence, including acting seat, street, effective stack, call amounts, reopening, blinds, status changes and timestamps. Maintain an independent reference implementation for outcome tests; the runtime verifier currently shares evaluator/pot code with the engine. Have the final rules and deployed RNG implementation evaluated by the appropriate independent audit/lab process.

#### F15 — High operational gap: transport and deployment hardening remain unverified

Evidence: `config.ts`, `transport.ts:42`, `index.ts:24`, `.env.example`, `docker-compose.yml`, `apps/web/next.config.ts`.

Production guards correctly refuse insecure requests and direct-TLS tests pass. Proxy mode trusts the first `X-Forwarded-Proto` value from any connecting peer; the documentation correctly requires the app port to be reachable only through a proxy that overwrites it. The listener binds without a specific interface. A public origin port would make forged forwarded headers dangerous and could undermine IP rate limits. This exposure was not established because no production deployment was inspected.

Local configuration is development/HTTP. The included Compose file publishes Postgres and Redis with development defaults and is not production infrastructure. No reviewed deployment enforces secret injection, network segmentation, an authenticated/encrypted proxy-to-app hop where needed, production mode, ingress/DDoS controls, or browser security headers. Helmet on the API does not configure the separate Next.js page origin's CSP.

Required: review the exact production manifest and external URLs, restrict origin/network access, configure trusted peers/header replacement, secure every sensitive network hop, enforce HTTPS/WSS and secure cookies, configure frontend CSP/framing policies, and inspect database/Redis reachability. Include negative tests with forged headers sent directly to the origin.

#### F16 — Medium, reproduced: refresh replay and lifetime policies are incomplete

Evidence: `auth/routes.ts:143`; `schema.prisma:86`; observations `refreshReplay` and `absoluteSessionAge`.

Rotation uses a conditional update, correctly allowing only one concurrent winner. Reusing an older signed refresh token returns 401, but leaves the current session valid with no replay alert or token-family response. Refresh continuously extends expiry by seven days; `createdAt` is not used to cap absolute session age. A session fixture created 365 days earlier still refreshed successfully. Cookie and database durations are hard-coded to seven days even though JWT refresh lifetime is configurable.

Required: define absolute, idle and privileged-session limits; add token-family/reuse handling and telemetry with a bounded concurrency policy so normal multi-tab races do not cause arbitrary lockouts. Bind cookie, database and token lifetimes to one validated policy. Add active session inventory, remote revocation and password/recovery-triggered invalidation. [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

#### F17 — Medium, reproduced: revoked sockets still receive user-room notifications

Evidence: `socket/index.ts:77`; `game/manager.ts:245`, `:261`; observation `revokedSocket`.

Commands and table snapshots reauthenticate the socket, which protects gameplay and hidden cards. `USER_PATCH` and `TABLE_IDLE_NOTICE` are sent directly to a user room without the same check. After deleting the fixture's session, HTTP authentication correctly failed but its otherwise idle socket still received a bankroll update.

Required: disconnect sockets for a revoked session across workers and enforce expiry/revocation for every private outgoing event. Session-scoped rooms or an authorization-aware notification service can support this. Do not describe this reproduction as a hole-card leak; the verified leak was a balance notification.

#### F18 — Medium, reproduced at the handler: cookie routes lack explicit origin/CSRF enforcement

Evidence: `app.ts:33`; `auth/routes.ts:130`, `:143`, `:184`; observation `crossOriginGuest`.

CORS controls whether browser JavaScript can read responses; it is not a general server-side CSRF check. A simple text/plain POST with an untrusted Origin reached `/auth/guest`, created a user and issued a session. Refresh/logout do not validate Origin or an anti-CSRF token. Production SameSite=Strict helps against cross-site cookies but does not distinguish trusted and untrusted same-site subdomains. The local HTTP probe proves handler behavior; browser cookie effects depend on origin/site and deployment policy.

Required: validate the expected Origin/Fetch Metadata and/or a properly bound CSRF token on cookie-authenticated mutations; reject inappropriate media types. Define deliberate exceptions for non-browser clients rather than treating CORS as authorization. Cover login/guest session replacement and logout as well as money operations.

#### F19 — Medium, reproduced: sensitive account responses lack explicit cache prohibition

Evidence: `auth/routes.ts`; `app.ts`; observation `authCaching`.

Successful `/auth/guest` and `/auth/me` responses had no Cache-Control header, despite containing tokens or personal/account data. Audit routes already use `no-store`. This is not proof that a shared proxy is currently caching authenticated content; it is an avoidable browser/proxy configuration risk.

Required: `Cache-Control: no-store` for authentication, private account and financial responses, with correct cache keys/behavior at the CDN and browser boundaries. Verify login, refresh, logout, personal API data and error responses on the deployed system.

#### F20 — Medium: admission, rate limiting and backpressure do not cover a distributed service

Evidence: `app.ts:41`, `:52`; `socket/rate-limit.ts`; `socket/index.ts:64`, `:81`; `game/manager.ts:293`.

HTTP and per-user action limits are held in process memory. Multiple replicas multiply the allowance; guest accounts evade per-user limits. The socket transport has a useful 8 KiB message cap, but no application connection quota or pre-authentication connection limiter was found. Every broadcast fetches sockets and reauthenticates each viewer through Postgres; unbounded concurrent authentication/projection work can amplify load. The earlier body-parser bypass is separate and reproduced in F08.

Required: shared abuse limits and account/IP/device admission rules, bounded concurrent work, per-session connection ceilings, edge limits and measured load shedding. Exercise websocket reconnect storms, large spectator audiences, slow clients, Redis loss and DB pool exhaustion. Rate limiting must remain correct during failover; do not cache revoked authorization beyond its explicitly accepted delay.

#### F21 — Medium: command receipt and service-readiness contracts are incomplete

Evidence: `socket/index.ts:33` and ACTION_INTENT handler; `game/manager.ts:139`; `routes/health.ts`; observation `healthWithoutDatabase`.

`clientActionId` is validated but never persisted or used to return the original outcome. Revisions prevent repeating an action against the same state, but an accepted action whose acknowledgement is lost returns a stale error on retry; there is no durable receipt/query contract. New-table creation has the same uncertain-response problem, although the unique seat constraint limits duplicate seating. Do not treat this as evidence that a replay currently debits twice.

`/api/health` always returns `ok:true`, even with an intentionally unreachable database. That is a usable liveness check but insufficient as readiness. Startup verifies only the presence of some audit columns, not effective permissions, financial reconciliation or the ability to recover every table; individual recovery errors are logged while startup continues.

Required: durable idempotency and operation-outcome queries for financial/escrow commands, plus readiness and table-health reporting that reflect dependency/integrity failures. Healthy tables may continue under an approved isolation policy, but failed ones need a visible recovery state and alert. Add graceful draining, bounded shutdown and durable delivery/recovery for financial effects.

#### F22 — High launch evidence gap: privacy, retention, incident response and restore controls

Evidence: plaintext personal fields in `schema.prisma`; raw logger configuration; repository infrastructure inventory and existing `COMPLIANCE.md` limitations. These controls may exist outside the repo, but none were supplied or verified.

Required evidence: data inventory/classification; minimal retention including sessions, IPs, logs and immutable history; lawful erasure/pseudonymisation handling consistent with regulated retention; access/export records; production access review; independently held backup/key recovery; recovery objectives and restore drills; clock discipline; on-call alerts and incident playbooks; change approvals, CI security gates, dependency update policy and release provenance.

Test recovery of database and keys together without duplicating paid withdrawals or hands. Test loss of a region, unavailable custody provider, compromised signing capability, rogue administrator and missing audit tail. Define custody and player-fund shortfall escalation. Immutable history should preserve what is required without accidentally making unnecessary personal data impossible to manage.

### Additional correctness and hardening observations

- **Per-hand audit coverage:** 54 legacy hands have no new audit, and current SQL permits an entirely null audit group for legacy compatibility. The application refuses to settle new hands without a valid record; a direct SQL writer still bypasses that policy. Define a cutover/version constraint and preserve legacy provenance. Do not fabricate retrospective commitments.
- **Private tables:** HTTP/socket membership checks and participant-only audit checks are present. Ordinary players are not authorized by a user-supplied role claim. New-table creation strips fields outside its schema. No direct arbitrary SQL/command execution route was found in the reviewed server paths; the raw table-lock query is parameterized.
- **Game rules:** current rules table all surviving showdown hands, restrict newcomers/returners through the big-blind wait, preserve all-in eligibility, and handle uncalled bets/side pots/odd chips. These policies need an approved, versioned player ruleset and dispute process. Fairness tests are evidence of implementation behavior, not proof that every jurisdiction/house rule has been selected correctly.
- **Rake:** the database has a default-zero rake field; the engine redistributes all chips and implements no production rake policy. If charging commission, define caps, no-flop policy, split-pot rounding and ledger/revenue reporting before adding it. Zero rake can be a deliberate business choice, but cannot be described as an implemented commission system.
- **Balance overflow:** repeated legitimate wins can grow a player's bankroll beyond a 32-bit field even if individual buy-ins are bounded. Test the chosen financial representation end-to-end rather than relying only on input maxima. Overflow must fail into a recoverable obligation, not strand a table.
- **Client token storage:** access tokens are held in memory; refresh cookies are HttpOnly. The client rejects older table revisions and verifies visible-card proofs. These are useful protections, but XSS on the app origin remains able to act as the user during a live session.
- **Commitment timing:** commitments are created before dealing in server code, then delivered together with the first snapshot; there is no external witness proving what the server did before publication. The server knows the full deck. The design does not prevent a malicious privileged operator from selecting a biased deck before making a commitment.
- **Bot compatibility:** new-table bot creation is refused, but existing bots and their timer strategy remain reachable for legacy games. Migration policy must explicitly keep these outside cash poker.
- **Operational clocks:** deadlines and audit times use host wall time. Test backward/forward clock changes and monitor synchronization; formatted UTC timestamps alone do not prove accurate or monotonic time.
- **Supply chain:** a lockfile is tracked and the known-vulnerability scans were clean. There is no reviewed CI/release configuration establishing repeatable production artifacts, approvals, SBOM/provenance or recurring scans.

### Malta and custody decisions

Player-versus-player poker charging commission is described by MGA as Type 3. The exact licence scope depends on the business and supplied services; do not reuse claims about house-banked poker or bots to classify this project. [MGA game types](https://www.mga.org.mt/faqs/what-are-the-different-types-of-games-that-are-licensable-by-the-authority/)

MGA has a DLT approval process and publishes distinct system-audit checklists for B2C and B2C with DLT. Integrating a crypto API does not supply those approvals or an independent audit. The old sandbox guidance is not a sufficient current implementation specification; the later DLT policy replaced it. Confirm the applicable policy and proposed architecture with the operator's Malta adviser and approved auditor. [DLT applications](https://www.mga.org.mt/faqs/how-can-licensees-obtain-an-approval-in-order-to-make-use-of-distributed-ledger-technology-dlt/), [DLT policy publication](https://www.mga.org.mt/the-mga-publishes-its-policy-on-the-use-of-distributed-ledger-technology-by-authorised-persons/), [system-audit process](https://www.mga.org.mt/mga-issues-revised-system-audit-checklist-and-new-system-review-checklist/)

Player funds must be segregated and separately identifiable under MGA's explanation of player-fund protection. That requires both appropriate external accounts and accurate internal liabilities; encrypting `bankroll` would provide neither. [MGA player funds](https://www.mga.org.mt/faqs/how-are-player-funds-protected/)

**Engineering recommendation: start by evaluating appropriately regulated payment and custody providers that explicitly accept licensed poker.** This is a recommendation to reduce operational scope, not a claim that any provider makes the site safe automatically. The gambling and financial-services approvals are separate questions. For EU crypto providers, verify the actual legal entity, permitted services and authorization with MFSA/ESMA and obtain advice on whether the proposed operator activities also fall within MiCA. [MFSA crypto-assets framework](https://www.mfsa.mt/our-work/crypto-assets/), [MiCA authorization](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-59-authorisation)

| Model | Responsibilities retained by this application | Additional custody responsibilities |
| --- | --- | --- |
| Regulated provider holds assets | Eligibility, limits, wallet/escrow ledger, authenticated callbacks, withdrawal approvals, provider reconciliation, player statements and incident handling | Provider manages keys under contract; independently verify asset segregation, subcustodians, incident support and exit/asset recovery |
| Operator self-custody | All of the above | Signing infrastructure, hot/cold balances, multi-party control, key backup/rotation/recovery, chain operation, wallet security monitoring and financial-services legal analysis |

Provider selection criteria: contractual support for MGA poker; verified authorization for the relevant services; supported countries/assets/chains; segregation and reconciliation reports; idempotency and signed webhook specifications; withdrawal controls; security audit evidence; liability/insurance limitations; service availability and recoverability. A brand name or quick integration is not a substitute for these checks. No provider has been approved or selected by this review.

### Order of work and acceptance gates

1. **Keep the money boundary closed.** No deposits/redemption against current balances. Decide entity, target markets, licence scope, approved game rules, settlement currency, provider/custody model and accounting policy.
2. **Fix reproduced code defects.** Safe logging and parser limits; cash-out recipient invariants; outage recovery; session lifetime/replay/revocation; private notifications; origin/CSRF checks; private response cache control. Turn the review probes into normal regression tests that assert rejection or safe behavior after remediation.
3. **Build the financial and eligibility foundations.** Ledger/escrow, exact asset amounts, segregated funds/reconciliation, provider events, withdrawal lifecycle, identity/AML, self-exclusion/limits, privileged identity and anti-collusion operations. Every financial endpoint needs explicit threat modeling and failure tests.
4. **Close operational and integrity gaps.** Managed keys, tested rotation/restores, least-privilege services, durable idempotency and audit witnesses, readiness/alerts, distributed limits and production TLS/network validation.
5. **Verify a disposable production-like staging environment.** Real Postgres concurrency/rollback; restart during every financial step; duplicate/delayed callbacks; reorgs; provider timeout after payout; account exclusion during a transaction; worker/Redis/region loss; restoration from older backups; sustained load and reconnection storms. Use synthetic funds and fixtures.
6. **Obtain external evidence before launch.** Independent penetration test, required game/RNG and MGA system review, reviewed custody/financial procedures, signed operational acceptance and a controlled rollout with limits and emergency stop capability. The report uses OWASP ASVS 5.0 as an engineering reference, not as a certification assertion. [OWASP ASVS](https://github.com/OWASP/ASVS)

### Reproducing this review's probes

`scripts/security-review.mjs` runs the real built HTTP/socket/auth/game code against in-memory Prisma substitutes. It explicitly overrides all connection settings and points the database URL to loopback port 1. It emits observations of the **current gaps**, not a successful security certification. It is intentionally separate from `npm test`; some assertions confirm vulnerable behavior and must be revised once fixes land.

```powershell
npm.cmd run build:core
npm.cmd run build -w @poker/server
node scripts/security-review.mjs
```

`scripts/review-database.mjs` uses the configured runtime login but starts a read-only database transaction. It validates state/hole-card authenticated decryption and the new audit records, printing transport details and counts. Run only with the intended environment configured. The review required execution outside the network sandbox for this connection; no production mutation was performed.

```powershell
node scripts/review-database.mjs
```

Expected observations at review time: password marker present in serialized parse error; 16 malformed requests bypass auth limit; guest issuance 10,000; missing auth cache headers; old refresh replay returns 401 while session remains usable; 365-day-old session refresh accepted; revoked socket receives bankroll; unconditional health success; zero/reused encryption key accepted by config; zero-row cash-out loses payment instruction; outage causes immediate timeout fold; resealed illegal CHECK passes the current outcome/card audit.

The report's launch blockers remain open. This review improves the available evidence and identifies the next implementation work; it does not turn the present play-chip backend into a certified financial system.

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
