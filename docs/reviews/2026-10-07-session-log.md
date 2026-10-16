> **Moved.** This was opuswork.md in the repository root. It is the working log of 7 October 2026, not a specification. Current status: [progress index](../progress/README.md). Citations inside this file use the filenames of that day.

# Opus work log: Hold'em Live poker platform

Everything Claude (Opus 5.5) did, changed and found in this session, from 29 September to 7 October 2026. All times are local (CEST, UTC+2).

- **Repository:** `poker_website`, branch `main` at `38be8a7`, plus a large uncommitted working tree. Nothing was committed or pushed in this session.
- **Live database:** nothing was ever written to the live Supabase database. Reads were limited to the 30 September checks in section 6.3 and one project-status call on 7 October; a later read-only probe was refused and not attempted again.
- **Companion files:**
  - [`CLAUDE-REVIEW.md`](2026-09-30-claude-review.md): the 30 September review, reproduced in full in Appendix A;
  - [`GPT-6.1-SOL-REVIEW.md`](2026-09-30-gpt-review.md): GPT-6.1-Sol's review;
  - [`progress.md`](../progress/README.md): the team log (entries dated 2026-10-07).

**Contents**

| Part | What it holds |
| --- | --- |
| 0 | Read this first |
| 1 | Today's "Game server unavailable": evidence, cause, fixes, verification, what you need to do |
| 2 | Log of everything I changed: files, outside changes, timeline |
| 3 | Everything wrong: NEW-1 to NEW-14; CR-001 to CR-041 and F01 to F22 with status now; the re-check agents' raw findings; GPT comparison |
| 4 | Everything right: verified correct, fixed since 30 Sep, every test run |
| 5 | Decisions, legal register, claims check |
| 6 | Session notes: requests, interruptions, rules kept, what this file cannot contain |
| 7 | Where we stand: a score out of 10 against the highest standard of online poker |
| 8 | My own opinion: what to fix, add and not do, in order |
| 9 | The night's "fix now" work: every change, the commits, final test results, what is left, how to commit |
| Appendix A | The 30 Sep review findings in full |
| Appendix B | Fix plan, open questions, repro scripts |
| Appendix C | Coverage ledger (every file reviewed) |
| Appendix D | 30 Sep verification log; the F-items as they were then |
| Appendix E | Every command I ran (descriptions) |
| Appendix F | My code and documentation changes, exactly (before and after) |
| Appendix G | The progress.md text I wrote, word for word |
| Appendix H | The GPT-6.1-Sol review brief I wrote, word for word |
| Appendix I | GPT-6.1-Sol's full review, word for word |
| Appendix J | The 29 September backend security audit (F01–F22 write-ups), word for word |
| Appendix K | Raw outputs from today's diagnosis and tests |
| Appendix L | What I told you about auto mode on 29 September |

---

## 0. Read this first

**Why the lobby says "Game server unavailable"**
- The web app on port 3000 is running, but nothing answers on port 4000, where the game server should be.
- `npm run dev` started at 16:42, 2½ minutes after this PC booted. Its game server stopped shortly afterwards. `tsx watch` restarts it only when a server file changes, so it stayed down while the web app kept running.
- The lobby cannot tell a stopped server from a dropped connection, so it showed its generic development message.
- The real reason is printed only in the `npm run dev` terminal, and the old start-up log made even that unreadable: it printed "fatal startup error" and an error name, with no reason.
- The most likely reason is that the database connection failed at start-up (details in 1.3).

**There was a second blocker behind it.** Even with the game server running, nobody could sit down or act: the server refused every buy-in and every action the current web client sends (NEW-1). That is now fixed.

**What I fixed this evening** (all uncommitted, all tested):
1. Joining a table and playing work again against the real server (NEW-1, CR-008, CR-017).
2. A failed database connection is now explained in plain words in the server terminal. In development the server keeps retrying instead of dying (NEW-10, NEW-11).
3. If the database is missing the October migrations, the server now refuses to start and names them. Before, it started and then failed every sign-in (NEW-12).
4. The lobby's development message now says the game server stopped and where to read why.
5. The local Prisma client was regenerated; it was older than the schema (NEW-13).
6. README troubleshooting paragraph and `.env.example` note.

**What you need to do** (details in 1.6):
1. In the terminal running `npm run dev`, press Ctrl+C and start it again.
2. Read the `[server]` lines; they now say exactly what is wrong.
3. If they say the database is missing migrations, those must be applied to the Supabase database. That changes the client's live database, so it is your call.

**Real money:** still NO-GO. See section 3 and `progress.md`.

---

## 1. Today's problem: "Game server unavailable" on the opening screen

### 1.1 What the message means

`apps/web/src/lib/api.ts` throws this message whenever a request to the game server cannot be made at all. That covers no answer, a refused connection, or a timeout of 12 s. It is not a reply from the server. In development it read: "Game server unavailable. Start both services with npm run dev, then retry." That was misleading here, because both services had been started.

### 1.2 What I checked

| Check | Result |
| --- | --- |
| Port 3000 (web app) | Listening (Next.js dev, started 16:42:30) |
| Port 4000 (game server) | **Nothing listening** |
| The game server's watcher (`tsx watch src/index.ts`, started 16:42:27) | Running, but **with no child process**: the server it runs had exited, and `tsx watch` waits for a file change before running it again |
| When the PC booted / when `npm run dev` started | 16:40:02 / 16:42:15 |
| Did my own work cause it? | No. The shared packages the server loads were last rebuilt at 16:42:22–24 by `npm run dev`'s own pre-build. My build at 16:54 rewrote `apps/server/dist` and the web production build `apps/web/.next`, and no shared package files. `npm run dev` uses neither: it runs the server from source and builds the web app into `.next-dev` |
| Supabase project | `ACTIVE_HEALTHY`, so not paused (project-status metadata only) |
| Supabase direct database host (`db.<ref>.supabase.co`) | **IPv6 address only**, no IPv4 address |
| This PC's IPv6 today | **Not working**: a control IPv6 host is unreachable too, although the PC has IPv6 addresses configured. IPv4 works |
| Supabase connection pooler (IPv4) | Reachable on ports 5432 and 6543 (both eu-west-1 pooler hosts) |
| The server code itself | Starts in 1.6 s against a real PostgreSQL with all 8 migrations. Guest sign-in 201, lobby 200, stays up |
| What the old code logged for a failed database connection | Only "fatal startup error" and the name `PrismaClientInitializationError`. The safe-log serializer drops every Prisma error message, and Prisma prints nothing of its own for a failed connect (checked directly) |
| After my server edits (which normally make `tsx watch` rerun the server) | Still no child process. With the new code, an unreachable database keeps the process alive and retrying, so the rerun most likely reached the database and stopped on a condition it now names: missing migrations or a rejected login. **Not confirmed** (see 1.7) |

### 1.3 Cause

- **Certain:**
  - the game server process stopped while the web app kept running;
  - the lobby turns any "can't connect" into this message;
  - the old logging hid the reason;
  - it was not caused by my build or tests.
- **Most likely:** the database connection failed when the server started at 16:42, about 2½ minutes after boot. Two possibilities:
  - the network was not ready yet; or
  - `DATABASE_URL` points at Supabase's direct host, which needs IPv6, and IPv6 does not work on this network today.

  The project ships a Supabase *pooler* certificate (`apps/server/certs/supabase-pooler-root.pem`), and `.env.example` describes that connection. That suggests `.env` uses the IPv4 pooler, which would rule IPv6 out and leave the first possibility.
- **Second blocker (certain, fixed):** NEW-1. The server refused every seat claim and every action from today's web client.
- **Possible third blocker:** if the live database does not have the three October migrations, every sign-in and table request fails. The server now says so at start-up instead of starting.
- **What I could not check:** your `.env` and the live database. A read-only probe I wrote, which connects and checks which October columns exist, was refused by the session's auto-mode safety check as a production read. I did not try to get around that.

### 1.4 What I changed to fix it

| Change | File | Why |
| --- | --- | --- |
| The socket schemas accept `turnId` on actions and `commandId` on seat, sit and stand-up commands. They stay strict: unknown keys and malformed values are still refused | `apps/server/src/socket/index.ts` | The web client sends these fields; the strict schemas refused every buy-in and action (NEW-1) |
| SEAT_CLAIM, SIT_OUT and SIT_IN answer the client's acknowledgement. A failure to deal after a committed seat or sit-in is logged, not reported as a failed command | `apps/server/src/socket/index.ts` | CR-017: success could be reported as failure; the buy-in dialog waits for this answer |
| An action is stale only when the turn it was chosen for is over (`turnIdOf(table) !== turnId`). Without a `turnId`, the old revision rule applies | `apps/server/src/game/manager.ts` | CR-008: actions were refused after unrelated changes (someone sitting out, joining or leaving) |
| A failed balance notification after a committed seat claim is logged, not thrown | `apps/server/src/game/manager.ts` | CR-017: a committed claim was reported as failed |
| New `connectDatabase()`: classifies a failed connection from Prisma's code and explains it in a sentence naming only host:port. Retries with back-off in development; fails at once in production as before | `apps/server/src/db/connect.ts` (new), `apps/server/src/index.ts` | NEW-10, NEW-11 |
| The start-up schema check covers the columns this version reads (auth hardening, game reliability) and names every missing migration | `apps/server/src/db/prisma.ts` | NEW-12 |
| Development message: "Game server unavailable: nothing answers at http://localhost:4000. If npm run dev is already running, its game server has stopped; the reason is in that terminal's [server] lines. Fix it, then restart npm run dev." Production text unchanged | `apps/web/src/lib/api.ts` | The old text sent people to start services that were already running |
| 15 new tests, added to the server's `npm test` list | `apps/server/test/socket-contract.test.mjs`, `apps/server/test/startup.test.mjs`, `apps/server/package.json` | Regression tests for all of the above, against the real socket server and the real table manager |
| Troubleshooting paragraph for "Game server unavailable"; note that the direct Supabase host is IPv6-only | `README.md`, `.env.example` | So the next person can fix it from the terminal output |
| Regenerated the Prisma client | `node_modules/.prisma/client` (generated) | NEW-13: it predated `pausedAt`, `pausedReason` and `TableIncident` in `schema.prisma` |

### 1.5 How it was verified

| Check | Result |
| --- | --- |
| Typecheck, server and web | Pass |
| Server test suite (12 files, including the 2 new ones), before and after `prisma generate` | **130/130** |
| Ledger unit tests | **21/21** |
| Browser suite (Playwright, Chrome desktop and Pixel 7, ports 3107/4107) | **156/156** |
| `review/claude/recheck/dev-server/e2e.mjs`: the real game-server source on a disposable embedded PostgreSQL, run twice (before and after `prisma generate`) | Each scenario below passed |

The end-to-end scenarios:

| Scenario | Result |
| --- | --- |
| Database at the September schema | Refused at start-up: "Database is missing migration(s) 20261001100000_auth_hardening, 20261003100000_game_reliability" |
| Database down at start-up (development) | Stayed alive, logging "database unavailable: Cannot reach the database at 127.0.0.1:… Retrying in 1 s.". Came up within a second of the database answering (0.4 s and 0.6 s in the two runs); `/api/ready` 200 |
| Join and play | Three guests; a table created; two players sat down exactly as the buy-in dialog does, both acknowledged `{ok:true}`. A hand started and the first action (with `turnId`) was accepted. A bystander sat out mid-turn: the revision changed, the turn did not, and the actor's action with the older revision was still accepted (CR-008). An action for a finished turn was refused with `STALE_ACTION`. No unexpected errors |

### 1.6 What you need to do now

1. In the terminal running `npm run dev`, press **Ctrl+C**, then start it again: `npm run dev`, or `npm.cmd run dev` in PowerShell.
2. Read the `[server]` lines:
   - **"Poker server listening on http://0.0.0.0:4000"**: refresh the browser. You can play.
   - **"database unavailable: Cannot reach the database at …"**: the database is unreachable from this network; it keeps retrying. If the host shown is `db.<project-ref>.supabase.co`, put the **Session pooler** connection string from the Supabase dashboard (Connect, Session pooler) into `DATABASE_URL` in `.env`:
     - user `poker_server.<project-ref>`, host `aws-…-eu-west-1.pooler.supabase.com`, port 5432;
     - keep the `poker_server` password, `sslmode=require` and the `sslcert` parameter.

     Then restart `npm run dev`.
   - **"rejected the login in DATABASE_URL"**: wrong user or password in `.env`.
   - **"Database is missing migration(s) …"**: the Supabase database lacks the October migrations (`20261001100000_auth_hardening`, `20261002200000_ledger_foundation`, `20261003100000_game_reliability`). Applying them changes the client's live database, so decide that yourself:
     - copies for Supabase are in `supabase/migrations/`;
     - the README's route is `npm run db:migrate` with an administrator `DIRECT_URL`, which `.env` does not have today;
     - I have not applied anything.
3. Open the site at **http://localhost:3000**, not http://127.0.0.1:3000. The game server accepts requests only from the configured `CLIENT_ORIGIN` (`http://localhost:3000`). Sign-in from `127.0.0.1:3000` is refused with "Cross-origin request refused", a different message from this one; checked on 7 October with the real server.
4. Optional, to settle the cause here: run `! node review/claude/recheck/dev-server/live-connect-probe.mjs` in this chat. It only connects, runs SELECTs on the catalog, and prints whether it connected and which October tables and columns exist. It never prints credentials.

### 1.7 What I did not do, and why

- **Did not read the live database or your `.env` credentials.** The read-only probe was refused as a "Production Reads" action. The refusal said to find a safer way or ask you; the probe is in the repo for you to run (step 3 above).
- **Did not apply migrations, change `.env`, or restart your `npm run dev`.** These are your decisions. My edits to server files make your `tsx watch` rerun the server, which is its normal behaviour.
- **Did not commit or push anything.**

---

## 2. Log of everything I changed

### 2.1 Files in the repository

New files created by me (or by the four re-check agents I ran on 7 October). The re-check agents could write only under `review/claude/recheck/`.

| File | Created | What it is |
| --- | --- | --- |
| `CLAUDE-REVIEW.md` | 30 Sep | Claude's full review: 41 findings, decisions, legal register, claims check, coverage ledger (Appendix A here) |
| `GPT-6.1-SOL-REVIEW-PROMPT.md` | 29 Sep | The review brief for GPT-6.1-Sol (scope, safety rules, report format) |
| `apps/server/prisma/migrations/20261007200000_table_incident_column_grants/migration.sql` | 7–8 Oct night | Migration: TableIncident UPDATE narrowed to the resolution columns (NEW-7) |
| `apps/server/src/auth/smart-lockout.ts` | 7–8 Oct night | Smart lockout: familiar-address detection and per-address counters (NEW-4) |
| `apps/server/src/db/connect.ts` | 7 Oct | Start-up database connection with a plain-language explanation and development retry (1.4) |
| `apps/server/test/hand-cleanup.test.mjs` | 7–8 Oct night | 3 tests: Hand Clean-up survives a failed deal (CR-033); cash-out row check (F09) |
| `apps/server/test/socket-contract.test.mjs` | 7 Oct | 9 tests: the web client's exact socket payloads against the real server; turn-identity staleness in the real table manager |
| `apps/server/test/startup.test.mjs` | 7 Oct | 6 tests: connection explanation, development retry, schema check |
| `opuswork.md` | 7 Oct | This file |
| `review/claude/recheck/dev-server/boot-smoke.mjs` | 7 Oct | Boots the real game-server source on a disposable database and makes the lobby's calls |
| `review/claude/recheck/dev-server/e2e.mjs` | 7 Oct | End-to-end check of this evening's fixes on a real PostgreSQL (scenarios B, C, D in 1.5) |
| `review/claude/recheck/dev-server/live-connect-probe.mjs` | 7 Oct | Read-only connect + catalog probe of the configured database, for you to run (I was not allowed to) |
| `review/claude/repro/engine-fuzz.mjs` | 30 Sep | Randomized table-lifecycle fuzz through the engine, the server's audit checks and the browser's card verification |
| `review/claude/repro/live-db-readonly.mjs` | 30 Sep | Read-only counts of the live database in a READ ONLY transaction (run once, 30 Sep) |
| `review/claude/repro/seat-timer-skew.mjs` | 30 Sep | Turn countdown vs device clock (CR-003), rendering the real seat component |
| `review/claude/repro/server-sessions.mjs` | 30 Sep | Sessions and sockets repro (CR-006, CR-007, socket token expiry, CR-016) |
| `review/claude/repro/table-behaviour.mjs` | 30 Sep | Absent players (CR-002) and stale actions (CR-008) repro |
| `review/claude/tsconfig.json` | 30 Sep | TypeScript settings for rendering real web components in repro scripts |
| `scripts/dev-local.mjs` | 7–8 Oct night | `npm run dev:local`: a local PostgreSQL for development (item 2) |
| `supabase/migrations/20261007200000_table_incident_column_grants.sql` | 7–8 Oct night | Supabase copy of the same migration (identical) |
| `review/claude/recheck/auth-security/` (18 files: `config-probes.mjs`, `config-recheck.mjs`, `config-recheck.out.json`, `lobby-revalidation.mjs`, `login-lockout.mjs`, `login-lockout.out.json`, `server-sessions-recheck.mjs`, `sessions-recheck.mjs`, `sessions-recheck.out.json`, `signout-offline-recheck.err.txt`, `signout-offline-recheck.mjs`, `signout-offline-recheck.out.json`, `signout-offline.mjs`, `table-create-race.mjs`, `table-create-race.out.json`, `web-headers-recheck.mjs`, `web-headers-recheck.out.json`, `web-headers.mjs`) | 7 Oct | Re-check agent (sessions, headers, config, lockout, sign-out, table-create race): scripts and outputs |
| `review/claude/recheck/game-server/` (11 files: `bot-latency.mjs`, `bot-latency.out.txt`, `chip-amount-check.mjs`, `f13-replay.mjs`, `manager-recheck.mjs`, `manager-recheck.out.txt`, `showdown-reveal.mjs`, `showdown-reveal.out.txt`, `sitout-return.mjs`, `socket-contract.out.txt`, `socket-contract.test.mjs`) | 7 Oct | Re-check agent (table manager, socket contract, showdown, bots, sit-out, chip amounts, F13): scripts and outputs |
| `review/claude/recheck/legal-compliance/` (4 files: `legal-http.test.mjs`, `showdown-muck.mjs`, `ssr-legal.mjs`, `wiring-and-migrations.mjs`) | 7 Oct | Re-check agent (legal pages, terms gate over HTTP, showdown muck, migrations and wiring): scripts |
| `review/claude/recheck/web-ui/` (17 files: `audio-unlock.mjs`, `avatar-contrast.mjs`, `client-harness.mjs`, `contrast-sanity.mjs`, `contrast.mjs`, `dollar-scan.mjs`, `fake-dom.mjs`, `probe-paths.mjs`, `seat-timer-skew-v2.mjs`, `stubs/framer-motion.ts`, `stubs/next-link.ts`, `stubs/next-navigation.ts`, `stubs/socket-io-client.ts`, `timebank-mismatch.mjs`, `tsconfig.json`, `tsconfig.realfm.json`, `tsconfig.ssr.json`) | 7 Oct | Re-check agent (rendering harness, contrast, audio unlock, time bank, "$" scan): scripts, stubs and outputs |

Existing files I modified (most were already modified by the 1–6 October session; my edits sit on top of theirs):

| File | When | What I changed |
| --- | --- | --- |
| `progress.md` | 7 Oct 19:50 | Added the 2026-10-07 entry (review results, what GPT-6.1-Sol missed, the re-check of F01–F22 and CR-001..041, NEW-1..NEW-9) and replaced the "Overall" paragraph |
| `progress.md` | 7 Oct ~21:00 | Added the 2026-10-07 (evening) entry; updated the "Overall" paragraph; marked NEW-1, CR-008 and CR-017 as fixed in the earlier entry |
| `apps/server/src/socket/index.ts` | 7 Oct 20:31 | `turnId`/`commandId` accepted; acknowledgements for SEAT_CLAIM/SIT_OUT/SIT_IN; post-commit deal failures logged (1.4) |
| `apps/server/src/game/manager.ts` | 7 Oct 20:31 | Turn-identity staleness in `intent()`; non-fatal balance notification after a seat claim (1.4) |
| `apps/server/src/index.ts` | 7 Oct 20:31 | Start-up uses `connectDatabase()` (1.4) |
| `apps/server/src/db/prisma.ts` | 7 Oct 20:32 | Schema check names every missing migration (1.4) |
| `apps/web/src/lib/api.ts` | 7 Oct 20:32 | Development text of the "Game server unavailable" message (1.4) |
| `apps/server/package.json` | 7 Oct 20:34 | The two new test files added to `npm test` |
| `README.md` | 7 Oct 20:43 | Troubleshooting paragraph for "Game server unavailable" |
| `.env.example` | 7 Oct 20:43 | One comment line: prefer the Session pooler; the direct host is IPv6-only |
| `apps/web/next-env.d.ts` | 30 Sep and 7 Oct | Rewritten by `next build` and Playwright's dev server each time, and **restored** to its previous content each time. Net change from me: none |

### 2.2 Changes outside the repository's source files

| What | When | Detail |
| --- | --- | --- |
| Removed the `autoMode` section from `%USERPROFILE%\.claude\settings.json` | 29 Sep 22:31 | At your request ("just remove Ill set it up when I feel like it"). It held notes about the client's project (repo name, Supabase database, `.env` variable names, two database safety rules). Every other setting was checked unchanged. Backup: `settings.before-automode-removal.json` in this session's scratchpad |
| Published a private web page with the GPT-6.1-Sol review brief | 29 Sep 22:13 | https://claude.ai/artifact/Y3dgUsoe1DFcqGhRQZ6fjW (private until you share it) |
| Rebuilt build output | 30 Sep; 7 Oct 16:54; 7 Oct ~20:35 | 30 Sep: the full production build. 7 Oct 16:54: `npm run build`; it rewrote `apps/server/dist` and `apps/web/.next`, while `packages/*/dist` were already up to date. 7 Oct ~20:35: `apps/server/dist` only, so the tests load the new code. Build artifacts only; `npm run dev` uses none of them |
| Regenerated the Prisma client (`node_modules/.prisma/client`) | 7 Oct ~20:50 | `prisma generate`, no database connection (NEW-13) |
| TypeScript incremental build info (`*.tsbuildinfo`) and Playwright's `apps/web/test-results/.last-run.json` | 7 Oct | Written by `tsc` and Playwright during test runs |
| Temporary files | whole session | Scratchpad and `%TEMP%\claude-review\` (test logs, extracted results); nothing in the repository |

### 2.3 Timeline

| Time | Event |
| --- | --- |
| 29 Sep 21:58 | **You:** I need you to make a prompt for gpt-6.1-sol the new openai model, I want you to ask him to review everything from start to finish on this website, review bugs, and defects, this website as you know ne… |
| 29 Sep 22:10 | Created `GPT-6.1-SOL-REVIEW-PROMPT.md` |
| 29 Sep 22:11 | Edited `GPT-6.1-SOL-REVIEW-PROMPT.md` |
| 29 Sep 22:11 | Edited `GPT-6.1-SOL-REVIEW-PROMPT.md` |
| 29 Sep 22:11 | Edited `GPT-6.1-SOL-REVIEW-PROMPT.md` |
| 29 Sep 22:11 | Edited `GPT-6.1-SOL-REVIEW-PROMPT.md` |
| 29 Sep 22:11 | Artifact quickstart |
| 29 Sep 22:13 | Created `(scratchpad) brief-template.html` |
| 29 Sep 22:13 | Created `(scratchpad) build-brief.mjs` |
| 29 Sep 22:13 | Artifact publish: the GPT-6.1-Sol brief page (https://claude.ai/artifact/Y3dgUsoe1DFcqGhRQZ6fjW) |
| 29 Sep 22:18 | **You:** why exactly are you getting this data again ? |
| 29 Sep 22:18 | WebSearch: Claude Code documentation about auto mode |
| 29 Sep 22:18 | WebFetch: Claude Code documentation about auto mode |
| 29 Sep 22:18 | WebFetch: Claude Code documentation about auto mode |
| 29 Sep 22:22 | **You:** I dont understand, is claude now gonna take this folder as all of my info or what, cause this is a project for someone else not myself |
| 29 Sep 22:27 | **You:** can I see the settings myself and if not, if I cant modify them myself then remove anything added today on the auto thing |
| 29 Sep 22:30 | **You:** just remove Ill set it up when I feel like it |
| 29 Sep 22:31 | Loaded the `update-config` skill |
| 29 Sep 22:31 | Created `(scratchpad) remove-automode.cjs` |
| 29 Sep 23:54 | **You:** now Id like you to do the task I gave gpt6.1sol |
| 30 Sep 00:04 | Created `review\claude\repro\engine-fuzz.mjs` |
| 30 Sep 00:06 | Created `review\claude\repro\server-sessions.mjs` |
| 30 Sep 00:09 | Created `review\claude\repro\table-behaviour.mjs` |
| 30 Sep 00:17 | Created `review\claude\repro\live-db-readonly.mjs` |
| 30 Sep 00:27 | Created `CLAUDE-REVIEW.md` |
| 30 Sep 01:52 | **You:** gpt6.1sol finished go ahead finish your testing and see what gpt6.1sol said |
| 30 Sep 01:54 | Edited `review\claude\repro\server-sessions.mjs` |
| 30 Sep 02:02 | Created `(scratchpad) update-report.cjs` |
| 30 Sep 02:03 | Created `(scratchpad) new-findings.md` |
| 30 Sep 02:06 | **You:** just add your foundings to the progress.md and let everyone know what you found, also add anything gpt6.1sol missed |
| 7 Oct 16:51 | **You:** continue |
| 7 Oct 16:59 | Started the 4-agent re-check workflow (`recheck-review-findings`) |
| 7 Oct 19:10 | **You:** continue |
| 7 Oct 19:49 | Created `(scratchpad) progress-entry.md` |
| 7 Oct 19:50 | Edited `progress.md` |
| 7 Oct 19:50 | Edited `progress.md` |
| 7 Oct 19:54 | **You:** [Image #2] why is this happening, and fix it also put everything you changed to a .md file and all your finding, every single details from this session put it on a claudeopus5and5.5.md file |
| 7 Oct 19:54 | (a reply of mine was stopped by a safety classifier; you re-sent the request) |
| 7 Oct 19:55 | **You:** [Image #2] why is this happening, and fix it also put everything you changed to a .md file and all your findings, also every single possible detail you think is bad or good, every single possible thin… |
| 7 Oct 19:56 | (a reply of mine was stopped by a safety classifier; you re-sent the request) |
| 7 Oct 19:56 | **You:** [Image #2] why is this happening, and fix it also put everything you changed to a .md file and all your findings, also every single possible detail you think is bad or good, every single possible thin… |
| 7 Oct 20:01 | **You:** [Image #2] why is this happening, and fix it also put a log of everything you changed to a .md file and all your findings, also every single possible detail you think is bad or good, every single poss… |
| 7 Oct 20:01 | (a reply of mine was stopped by a safety classifier; you re-sent the request) |
| 7 Oct 20:04 | **You:** [Image #2] why is this happening, and fix it also put a log of everything you changed to a .md file and all your findings, also every single possible detail you think is bad or good, every single poss… |
| 7 Oct 20:06 | (a reply of mine was stopped by a safety classifier; you re-sent the request) |
| 7 Oct 20:07 | Created `review\claude\recheck\dev-server\boot-smoke.mjs` |
| 7 Oct 20:12 | **You:** [Image #2] why is this happening, and fix it also put a log of everything you changed to a .md file and all your findings, also every single possible detail you think is bad or good, every single poss… |
| 7 Oct 20:13 | (a reply of mine was stopped by a safety classifier; you re-sent the request) |
| 7 Oct 20:18 | Supabase: listed projects (status metadata only) |
| 7 Oct 20:19 | Created `review\claude\recheck\dev-server\live-connect-probe.mjs` |
| 7 Oct 20:23 | **You:** " Game server unavailable. Start both services with npm run dev, then retry. " this is not letting me join the game, it pops out in the opening screen |
| 7 Oct 20:31 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 20:31 | Created `apps\server\src\db\connect.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\index.ts` |
| 7 Oct 20:31 | Edited `apps\server\src\index.ts` |
| 7 Oct 20:32 | Edited `apps\server\src\db\prisma.ts` |
| 7 Oct 20:32 | Edited `apps\web\src\lib\api.ts` |
| 7 Oct 20:33 | Created `apps\server\test\socket-contract.test.mjs` |
| 7 Oct 20:34 | Created `apps\server\test\startup.test.mjs` |
| 7 Oct 20:34 | Edited `apps\server\package.json` |
| 7 Oct 20:36 | Created `review\claude\recheck\dev-server\e2e.mjs` |
| 7 Oct 20:36 | Edited `review\claude\recheck\dev-server\e2e.mjs` |
| 7 Oct 20:36 | Edited `review\claude\recheck\dev-server\e2e.mjs` |
| 7 Oct 20:43 | Edited `README.md` |
| 7 Oct 20:43 | Edited `.env.example` |
| 7 Oct 20:52 | Created `(scratchpad) list-actions.cjs` |
| 7 Oct 20:54 | Edited `progress.md` |
| 7 Oct 20:55 | Edited `progress.md` |
| 7 Oct 20:55 | Edited `progress.md` |
| 7 Oct 20:55 | Edited `progress.md` |
| 7 Oct 20:55 | Edited `progress.md` |
| 7 Oct 20:55 | Edited `progress.md` |
| 7 Oct 20:55 | Edited `progress.md` |
| 7 Oct 20:55 | Edited `progress.md` |
| 7 Oct 20:57 | Created `(scratchpad) opuswork.template.md` |
| 7 Oct 20:59 | Created `(scratchpad) build-opuswork.cjs` |
| 7 Oct 21:00 | Started the 4-agent re-check workflow (`review-opuswork-and-fixes`) |
| 7 Oct 21:05 | **You:** continue |
| 7 Oct 21:05 | Created `(scratchpad) check-tables.cjs` |
| 7 Oct 21:11 | **You:** continue |
| 7 Oct 21:13 | Edited `progress.md` |
| 7 Oct 21:13 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 21:13 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:13 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:13 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:13 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:13 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:13 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:16 | **You:** did you put all of the info from this session on the opuswork.md file ? |
| 7 Oct 21:18 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:18 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:18 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:19 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 21:19 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 21:19 | Created `(scratchpad) check-fences.cjs` |
| 7 Oct 21:20 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 21:23 | **You:** I also need you to tell me where do we stand on the highest standard of online poker out of 10, for exampllle how close are we |
| 7 Oct 21:24 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:24 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:27 | **You:** Also let me know YOUR OWN OPINION or IDEA of what we need to add or fix on this project |
| 7 Oct 21:28 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:28 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 21:56 | **You:** I need you to complete all the fix now, until your usage is near the limit, prefict near when your usage gets near 5% to stop at that part and let the other ones for later |
| 7 Oct 21:59 | Created `(scratchpad) base-versions.cjs` |
| 7 Oct 22:02 | Created `(scratchpad) fix-forgery-test.cjs` |
| 7 Oct 22:03 | Created `apps\server\prisma\migrations\20261007200000_table_incident_column_grants\migration.sql` |
| 7 Oct 22:03 | Created `supabase\migrations\20261007200000_table_incident_column_grants.sql` |
| 7 Oct 22:03 | Edited `apps\server\test\db\privileges.test.mjs` |
| 7 Oct 22:03 | Edited `apps\server\test\db\privileges.test.mjs` |
| 7 Oct 22:04 | Edited `progress.md` |
| 7 Oct 22:05 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 22:05 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 22:05 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 22:05 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 22:05 | Edited `apps\server\src\socket\index.ts` |
| 7 Oct 22:06 | Created `(scratchpad) guard-check\guard.ts` |
| 7 Oct 22:06 | Edited `progress.md` |
| 7 Oct 22:08 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:08 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:08 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:09 | Created `apps\server\test\hand-cleanup.test.mjs` |
| 7 Oct 22:09 | Edited `apps\server\package.json` |
| 7 Oct 22:10 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:11 | Edited `apps\server\test\compliance.test.mjs` |
| 7 Oct 22:11 | Edited `progress.md` |
| 7 Oct 22:13 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:13 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:13 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:13 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:13 | Edited `apps\server\src\game\manager.ts` |
| 7 Oct 22:13 | Edited `apps\server\test\table-lifecycle.test.mjs` |
| 7 Oct 22:13 | Edited `apps\server\test\table-lifecycle.test.mjs` |
| 7 Oct 22:14 | Edited `apps\server\test\table-lifecycle.test.mjs` |
| 7 Oct 22:17 | Edited `apps\web\src\app\rules\page.tsx` |
| 7 Oct 22:17 | Edited `apps\web\test\browser\shell-legal.spec.ts` |
| 7 Oct 22:19 | Edited `apps\web\src\app\rules\page.tsx` |
| 7 Oct 22:19 | Edited `apps\web\test\browser\shell-legal.spec.ts` |
| 7 Oct 22:23 | Edited `progress.md` |
| 7 Oct 22:25 | Created `apps\server\src\auth\smart-lockout.ts` |
| 7 Oct 22:25 | Edited `apps\server\src\auth\routes.ts` |
| 7 Oct 22:25 | Edited `apps\server\src\auth\routes.ts` |
| 7 Oct 22:25 | Edited `apps\server\src\auth\routes.ts` |
| 7 Oct 22:25 | Edited `apps\server\test\auth-http.test.mjs` |
| 7 Oct 22:26 | Edited `progress.md` |
| 7 Oct 22:27 | Created `scripts\dev-local.mjs` |
| 7 Oct 22:28 | Edited `apps\server\src\index.ts` |
| 7 Oct 22:28 | Edited `apps\server\src\index.ts` |
| 7 Oct 22:28 | Edited `README.md` |
| 7 Oct 22:29 | Edited `progress.md` |
| 7 Oct 22:30 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 22:30 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 22:31 | Created `(scratchpad) extract-actions.cjs` |
| 7 Oct 22:31 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 22:31 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 22:31 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 22:31 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 22:48 | Edited `apps\web\test\browser\shell-legal.spec.ts` |
| 7 Oct 22:50 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 22:50 | Edited `(scratchpad) opuswork.template.md` |
| 7 Oct 22:50 | Edited `(scratchpad) build-opuswork.cjs` |
| 7 Oct 22:50 | Edited `progress.md` |
| 7 Oct 22:50 | Edited `progress.md` |
| 7 Oct 17:22 | Usage limit reached; two re-check agents restarted at 19:11 |
| 7 Oct ~20:50 | Regenerated the Prisma client; re-ran typecheck, server suite (130/130) and the end-to-end check |
| 7 Oct ~21:00 | Updated progress.md (evening entry); wrote this file |

### 2.4 Every command I ran

The full list (descriptions only) is in Appendix E. Commands that changed state are in 2.2: builds, `prisma generate`, the settings edit and the page publish. All other commands only read or ran tests. Every test run used a dead or disposable database: `run-tests.mjs` points DATABASE_URL at a dead loopback port, and `pg.mjs` starts an embedded PostgreSQL that is deleted afterwards.

---

## 3. Findings: what is wrong

Severity is judged for real money: S0 = launch blocker; S1 = harms players in normal use; S2 = significant; S3 = moderate; S4 = minor or cosmetic.

### 3.1 Found today while fixing "Game server unavailable" (NEW-10 to NEW-14)

| ID | Sev | Status | What happens | Where | Evidence / fix |
| --- | --- | --- | --- | --- | --- |
| NEW-10 | S2 | **FIXED for start-up; remaining: other Prisma initialization errors at runtime still lose their code in logs (suggestion: also read `errorCode` in `serializeError`)** | Start-up failures were logged without their reason. `security/safe-log.ts` drops the message of every error whose name starts with "PrismaClient" (such messages can carry query input), and a Prisma initialization error keeps its code in `errorCode`, which the serializer does not read. A failed `prisma.$connect()` therefore produced only "fatal startup error" and the error's name, and Prisma prints nothing of its own for a failed connect. | `apps/server/src/security/safe-log.ts:90-93`, `:101-117`; `apps/server/src/index.ts` (start-up) | Direct check: `$connect()` to a dead address with `log: ["warn","error"]` prints nothing. `apps/server/test/startup.test.mjs` asserts the serialized start-up error now carries the explanation while Prisma's own message is still withheld. |
| NEW-11 | S3 | **FIXED** | In development, a database that was unreachable for a moment at start-up ended the game server for good: `main()` exited, `tsx watch` reruns only on a file change, and `npm run dev` kept the web app running. The lobby then said "Start both services with npm run dev" although both had been started. | `apps/server/src/index.ts`; `apps/web/src/lib/api.ts`; root `package.json` `dev` script (`concurrently` + `tsx watch`) | Fixed by retrying the connection with back-off in development (1, 2, 4, 8, then every 15 s), logging the reason each time, and by the new development message. Production behaviour is unchanged: the first failure exits and the supervisor restarts. `e2e.mjs` scenario C: alive and retrying, then up 0.4 s after the database answered. |
| NEW-12 | S2 | **FIXED** | The start-up schema check covered only the 24 September migration. With the October migrations missing, the server started and reported ready, yet every sign-in, refresh, lobby list and table load failed (Prisma selects every column of a model). | `apps/server/src/db/prisma.ts` `assertGameSchemaReady()` | Now probes the columns this version reads and names every missing migration. `e2e.mjs` scenario B: a database at the September schema is refused with "Database is missing migration(s) 20261001100000_auth_hardening, 20261003100000_game_reliability"; a current database starts. `startup.test.mjs` and the existing `human-tables.test.mjs` check pass. |
| NEW-13 | S4 | **FIXED (locally)** | The generated Prisma client (`node_modules/.prisma/client`, 6 Oct 01:31) was older than `schema.prisma` (6 Oct 01:40): it lacked `Table.pausedAt`, `pausedReason`, the `incidents` relation and the `TableIncident` model. Nothing used them yet, so it caused no failure today. | `node_modules/.prisma/client/schema.prisma` vs `apps/server/prisma/schema.prisma` | Whitespace-insensitive comparison showed 14 differing lines; after `prisma generate`, 0. `npm ci` (CI) regenerates it through `postinstall`. |
| NEW-14 | S2 (process) | **OPEN (recommendation)** | Local development runs against the shared live Supabase database. Every development start runs table recovery, which can write, against live tables. The development code's migrations must already be applied there. And local development stops whenever the internet, IPv6 or Supabase does. | `.env` (`DATABASE_URL`); `apps/server/src/game/manager.ts` `recover()` | Recommendation: a local development database. The embedded PostgreSQL harness behind `test:db` (`apps/server/test/support/pg.mjs`) already creates one with every migration. |

Environment facts behind today's outage, not defects:
- the Supabase project is healthy;
- its direct database host has only an IPv6 address;
- IPv6 does not work on this PC's network today, while IPv4 does;
- the Supabase IPv4 pooler is reachable;
- the game server accepts browser requests only from `CLIENT_ORIGIN` (`http://localhost:3000`), so the site must be opened at that address and not at `127.0.0.1:3000`.

### 3.2 Defects introduced by the 1–6 October changes (NEW-1 to NEW-9), with status now

| ID | Sev | Status now | What happens | Where | Evidence |
| --- | --- | --- | --- | --- | --- |
| NEW-1 | **S0** | **FIXED (7 Oct evening)**: see 1.4 and CR-008/CR-017 | **Nobody can act or buy in on the real server.** The web client now adds `turnId` to every action and `commandId` to every seat claim. The server's socket schemas are `.strict()` and do not list either field, so both are refused with "Request could not be completed". A player's every click fails, their turn times out and they are sat out. The buy-in dialog always fails. Sit out and sit in still work. | `apps/server/src/socket/index.ts:24`, `:38`, `:216-217` vs `apps/web/src/components/table/action-bar.tsx:98-100`, `buy-in-dialog.tsx:123` | `review/claude/recheck/game-server/socket-contract.test.mjs` against the real socket server (re-run by me, 4/4). With the web payload: `{ok:false, code:"INVALID_REQUEST"}` and the manager is never called. Without the new field: accepted. The browser suite (156/156) misses it because its fixture server (`apps/web/test/support/game-server.mjs`) does not validate payloads. |
| NEW-2 | S1 | OPEN | **The published House Rules promise turn time the server does not give.** They promise a personal time bank of 30–60 s after the 20 s base, and a fresh base time after an outage. In fact no server module reads `gameConfig`, though its comment says `manager.ts` and `tables.ts` do. `createTable` gets no `extraTimeBank`, and `rebaseTurnClock` is never called. So players are folded and sat out after 20 s instead of up to 50 s, and after a restart the player to act is folded at once (F10). If the bank is wired up later, the server timer and `applyTimeout` must use the bank deadline too. Otherwise the server folds at 20 s while the clock still shows bank time. | `apps/server/src/config.ts:140-175`; `game/manager.ts:81`, `:109-127`, `:361`; `apps/web/src/app/rules/page.tsx:95-101`, `:165`; `terms/page.tsx:107` | grep shows 0 readers of `gameConfig` in `apps/server/src`. `manager-recheck.mjs`: `TIMEOUT_FOLD` 8 ms after `recover()`. `timebank-mismatch.mjs`: the client is shown 45 s while the timeout fires at 15 s. |
| NEW-3 | S2 | OPEN | **The House Rules say losing hands are mucked automatically, but every live hand is still shown to everyone, spectators included.** See CR-022 and decision D2. | `rules/page.tsx:110-117` vs `packages/engine/src/table.ts:1229-1234`, `public.ts:234` | `showdown-reveal.mjs`: 50 of 50 three-way showdowns showed the losing hands to a spectator. |
| NEW-4 | S2 | OPEN | **The new per-account login lockout lets anyone lock any player out indefinitely.** After 5 wrong guesses the account locks, and one guess each time the lock lapses re-locks it, up to 15 min. Usernames are public at every table, so a small, steady trickle of wrong guesses keeps an account locked. During the lock, the owner's correct password gets "Invalid credentials". There is no unlock or reset path, and the owner is not told. | `apps/server/src/auth/routes.ts:27-42`, `:198-224` | `review/claude/recheck/auth-security/login-lockout.mjs`. `auth-http.test.mjs:276-297` asserts the identical 401. |
| NEW-5 | S3 | OPEN | **The `ENABLE_LEGACY_BOTS` switch does nothing.** It is documented as "off by default: a bot's turn times out" (D11), but legacy bots keep playing when it is false. | `config.ts:148`, `:157-162`; `manager.ts:362-365` | The test "AFK human and a bot" still passes with `ENABLE_LEGACY_BOTS=false` and asserts that the bot acted. |
| NEW-6 | S3 | OPEN | **Signing out while offline is silently undone when the network returns.** The hydrator's pending retry still runs, and `clearSession` leaves `apiOffline` set, so the still-valid cookie signs the device back in without a click. On a shared device, the next person gets the account. | `apps/web/src/components/auth-hydrator.tsx:129-157`, `:199`; `stores/session.ts:111-112` | `signout-offline-recheck.mjs` mounts the real AuthHydrator: the user is signed out, then signed back in 4 s after reconnecting. |
| NEW-7 | S3 | OPEN | **The new `TableIncident` table was not added to the database privilege test, so `test:db` fails (41/43).** The runtime role can also UPDATE every column, including `kind`, `reason` and `createdAt`, so incident records can be rewritten after the fact. | `prisma/migrations/20261003100000_game_reliability/migration.sql:44`; `apps/server/test/db/privileges.test.mjs:36-51`, `:104-107` | `npm run test:db` (embedded PostgreSQL): the two privilege-matrix tests fail on `TableIncident`. |
| NEW-8 | S3 | OPEN | **The engine suite fails (458/477).** `review-fixes.test.ts` section 3 still asserts that the card-integrity verifier accepts pure outcome forgeries. Since Oct 6, `verifySealedAudit` also runs `settlementMoneyProblem` and rejects them. The stronger check looks intended, so the 19 assertions need updating. CI's engine job fails until then. | `packages/engine/src/__tests__/review-fixes.test.ts:939`; `packages/shared/src/audit.ts:864-890` | Engine Jest: 19 failures, all at line 939. |
| NEW-9 | S4 | OPEN | **The compliance text claims controls that do not exist.** | `apps/web/src/lib/legal.ts:12-14`; `responsible-gaming/page.tsx:102`; `auth/routes.ts:53` | Two claims are untrue:<ul><li>"Real-money mode refuses to start until the approved terms version matches": no such server code exists.</li><li>"Every account confirms its holder is 18 or older": accounts created before Oct 1 were never asked.</li></ul>The code also cites `DECISIONS.md` for D9 and D10, but the file does not exist. |

### 3.3 Claude's 41 review findings (CR-001 to CR-041): status now

Statuses are from the 7 October re-check: four independent checkers, each re-running or adapting the original repro. Overrides from this evening's fixes are marked. Columns: severity, the matching GPT-6.1-Sol finding, the status on 7 October, and the evidence, what was run and what remains. The original write-up of each finding is in Appendix A.

**Status counts now (41):** 18 fixed, 14 partly fixed, 8 open, 0 regressed, 1 waiting on an owner decision. Afternoon re-check: 16 / 14 / 8 / 2 / 1; CR-008 and CR-017 were fixed this evening. Severity at review time (30 Sep): 1 S0, 4 S1, 14 S2, 18 S3, 4 S4.

| ID | Sev | GPT | Finding (30 Sep) | Status now | Evidence now | Verified by | What remains |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CR-001 | S0 | SOL-007 | No terms, privacy notice, rules or age gate; guests play instantly | **PARTIAL** | Six legal pages exist (apps/web/src/app/{terms,privacy,rules,fairness,responsible-gaming,complaints}/page.tsx). Each renders through LegalDocument, which shows DraftBanner "Draft — pending legal review" (legal-document.tsx:20, draft-banner.tsx:12). layout.tsx:38 puts SiteFooter (links to all six) on every page. AgeTermsGate (age-terms-gate.tsx:26-50) starts unticked, and the lobby (page.tsx:151-160, 312-317) and login (login/page.tsx:32-37, 113-116) keep submit disabled until both boxes are ticked. The server enforces it: auth/routes.ts:55 and 111-125 refuse /guest (230) and /register (153) with 400 TERMS_REQUIRED or 409 TERMS_OUTDATED, and store termsVersion, termsAcceptedAt and ageConfirmedAt (184, 241; migration 20261001100000 lines 34-36). | Ran auth-http.test.mjs (terms, register and guest tests) through run-tests.mjs: 3/3 pass. Ran recheck/legal-compliance/legal-http.test.mjs: guest without acceptance gives 400 TERMS_REQUIRED, with acceptance 201 and the row stores termsVersion 2026-10-01. Same script: an account with termsVersion=null can still log in (200) and /auth/me answers 200. Ran ssr-legal.mjs: footer has all six hrefs; gate renders 2 unticked boxes; all six pages render the draft banner and version, with 0-8 placeholders and 4 counsel notes on privacy. | (1) EXTERNAL: counsel has not approved the texts. All pages are drafts with [placeholders] for operator entity, contacts, retention, ADR and helplines. (2) CODE: accounts created before 2026-10-01 have no recorded acceptance and are never asked for it. Nothing outside routes.ts checks termsVersion (login, refresh, socket, seat), and nothing asks for re-acceptance when TERMS_VERSION changes, although the DraftBanner promises it. So responsible-gaming/page.tsx:102 "Every account confirms its holder is 18 or older" is untrue for legacy accounts. (3) lib/legal.ts:12-14 says real-money mode refuses to start until the approved version matches; no such server code exists. |
| CR-002 | S1 | SOL-019 | Absent players are blinded off indefinitely | **FIXED** | packages/engine/src/table.ts:99 defaults sitOutOnTimeout to true. table.ts:460-466 and :507 sit out a human whose turn timed out, with reason TIMEOUT. manager.ts:81 builds tables without overriding this, so every server table gets the rule. The table page link now reads 'Back to lobby. You stay seated. If you miss a turn you are sat out automatically' (web table/[id]/page.tsx:134-135), and table-controls.tsx:135 explains a TIMEOUT sit-out. onDisconnect (manager.ts:49-53) still does nothing, so the optional sit-out after a disconnect grace period is not built; the published rules (rules/page.tsx:166) say the clock simply runs. | Re-ran table-behaviour part 1 (review/claude/recheck/game-server/manager-recheck.mjs). Heads-up: the absent stack goes 1000 to 990, then no further hand is dealt. Three-handed: 990 after 30 hands, with only 1 time-out. Through the TableManager timer: TIMEOUT_FOLD, sat out with reason TIMEOUT, not dealt the next hand. sitout-return.mjs: missedBlind is set while away and Sit in sets waitingForBigBlind. The server test 'AFK players are sat out by their first time-out' passes. | none for the acceptance criteria. Optional: sit out a disconnected player after a grace period; the DISCONNECTED reason exists but nothing sets it. |
| CR-003 | S1 | SOL-018 | Turn countdown uses the viewer's device clock | **FIXED** | turn-clock.tsx:68-85 builds the clock from relative turnRemainingMs/timeBankMsRemaining; :88-139 runs it on performance.now() anchored at arrival (use-table-socket.ts:79 receivedAt = performance.now()). It is passed through page.tsx:172,199 and poker-felt.tsx:31,106 to seat-hud.tsx:94. turnEndsAt and Date.now() are not read for any countdown in apps/web/src. The engine sends turnRemainingMs measured at projection (public.ts:67-98). | Ran seat-timer-skew-v2.mjs (real engine dist snapshot, real SeatHud and ActionBar via SSR, viewer Date.now skewed). For skews of 0, +5, +10, +14, -10, -60 and +1800 s the seat shows '15 s' and the action bar '15 s left', bar about 1.0, while the old formula gives 15/10/5/1/25/75/-1785 s. Harness 'announce' with the device clock 10 min fast shows 7 s against -594 s for the old formula. table-ui.spec.ts:50-68 asserts the same with Date.now 30 min fast. | none for the acceptance criteria. The optional half-RTT compensation is not done, so the client shows about one-way latency more time than the server gives. |
| CR-004 | S1 | SOL-009 | A table that cannot load or settle traps chips; no recovery; endless retries | **OPEN** | Migration 20261003100000_game_reliability and schema.prisma:145-148,165 add pausedAt, pausedReason and TableIncident, and engine voidHand exists (table.ts:576). Nothing in apps/server/src references any of them. manager.ts:66-77 still throws on load. recover() only logs the failure (:125). retryTimer (:464-477) retries every 1 s with no limit. routes/admin.ts:50 is still the only admin route (GET audit). The generated Prisma client has no tableIncident delegate. | manager-recheck.mjs: standUp on a table with missing state fails with RECOVERY_REQUIRED; on an undecryptable state it fails with 'Invalid encrypted state'. A due table with corrupt state logged 7 timer and retry failures in 6 s. No status write, no PAUSED, 0 incidents. | Back-off, PAUSED after N failures plus an alert, the admin void and force-cash-out flow (D12), and a 'paused' state in the UI. None is wired. |
| CR-007 | S1 | SOL-011 | A transient DB error is treated as sign-out: login cookie deleted, sockets dropped without reconnecting | **FIXED** | Only an AuthError (auth/errors.ts:20-29) is treated as a sign-out. /refresh answers 503 with Retry-After and keeps the cookie (routes.ts:306-323), and requireAuth answers 503 (middleware.ts:41-56). The socket handshake is refused as retryable SERVICE_UNAVAILABLE (socket/index.ts:91-99). Packets get a retryable refusal and the socket stays (index.ts:125-137). Broadcasts and notifications skip that viewer (notify.ts:32-45, manager.ts:318-329). The client treats 503/429/network as offline and retries (auth-hydrator.tsx:158-168), and reconnects after a server-initiated disconnect (auth-hydrator.tsx:186-191, 283-291; socket.ts:109-111). | sessions-recheck.mjs with an injected Prisma P2024 pool timeout: F /refresh returned 503 retryable, Retry-After 2, no Set-Cookie, and the same cookie gave 200 afterwards; /me during the outage returned 503. B: the packet got SERVICE_UNAVAILABLE retryable and stayed connected, with no SESSION_REVOKED. C: during a broadcast outage the viewer stayed connected and got the snapshot on the next broadcast. Revoked sessions still fail closed (A2, G). auth-http/auth-socket tests pass. | none |
| CR-005 | S2 | SOL-012 | Every token refresh tears down the socket and resets the table view | **FIXED** | The client keeps one socket per user (apps/web/src/lib/socket.ts:29-48) and passes each refreshed token to it with SESSION_RENEW (socket.ts:83-102; auth-hydrator.tsx:93-98, 116-127). useTableSocket is keyed on signedIn/userId/tableId, not on the token, so a refresh no longer runs resetTable (use-table-socket.ts:57-63, 167-177). The server checks the new token, refuses another user's token and closes the socket, and swaps socket.data.token/sessionId in place (apps/server/src/socket/index.ts:124, 147-173). | Ran apps/server/test/auth-socket.test.mjs via run-tests.mjs: 7/7 pass, including the SESSION_RENEW test. Adapted repro sessions-recheck.mjs section D (real server, 2 s handshake token): after a renew the socket id is unchanged, it stays connected past expiry and still gets a snapshot. Renewing with another user's token returns UNAUTHORIZED and disconnects. Browser test session.spec.ts:103-123 asserts the same socket and typed bet against the fixture server (not run here). | none (see CR-040: an access TTL below 10 min brings the teardown back) |
| CR-006 | S2 | SOL-013 | Two tabs refreshing together sign one tab out | **FIXED** | For REFRESH_GRACE_MS = 15 s (sessions.ts:14) the server accepts the token that the last rotation replaced, and does not rotate again (routes.ts:256-299). Any older token, or the previous one after the window, revokes the session as REFRESH_REUSE. The client lets one tab refresh at a time with Web Locks and shares the result over BroadcastChannel (apps/web/src/lib/api.ts:135-174). It re-checks a 401 once after 1 s before signing out (auth-hydrator.tsx:143-152). | sessions-recheck.mjs A: two concurrent refreshes return [200,200] both naturally and with forced interleaving (both read before either rotates). Exactly 1 rotation, both access tokens work on /auth/me, and the session is not revoked. A2: the previous token inside the grace window gets 200; after the window it gets 401 with REFRESH_REUSE. auth-http.test.mjs rotation/reuse tests pass. Browser tests session.spec.ts:38-75 exist (not run here). | none (grace-window nuance noted under F16) |
| CR-008 | S2 | — | Valid actions refused as stale after unrelated table changes | **FIXED (7 Oct evening)** | apps/server/src/game/manager.ts intent(): with the client's turnId, an action is refused as STALE_ACTION only when turnIdOf(table) differs (the turn it was chosen for is over); without turnId the old revision rule applies. apps/server/src/socket/index.ts accepts turnId ("<hand>:<seq>") on ACTION_INTENT. (Was REGRESSED in the afternoon re-check: the server refused the field, see NEW-1.) | apps/server/test/socket-contract.test.mjs (manager tests: accepted after a bystander sat out; refused for a finished turn; revision rule without turnId). review/claude/recheck/dev-server/e2e.mjs on a real PostgreSQL: after a bystander sat out mid-turn, the actor's action with the older revision and the same turnId was accepted ({ok:true}); an action for a finished turn got STALE_ACTION. | none |
| CR-009 | S2 | SOL-044 | One click buys in with an unchosen amount, up to the whole bankroll | **PARTIAL** | On the table page, 'Sit here' only opens the dialog (page.tsx:82-88, 200-212). BuyInDialog (buy-in-dialog.tsx:63-69, 101-133, 239-242) shows the range, the amount and the bankroll left, and sends SEAT_CLAIM only on Confirm, with a commandId and an ack. The default is still min(100 BB, bankroll, max) (:66), so with a bankroll under 100 BB the pre-filled amount is the whole bankroll. Sibling path: the lobby's 'Open 6-seat table' (app/page.tsx:337-343 calls createTable with buyIn 1000 at :206) takes 1,000 chips and seats the creator on one click (server routes/tables.ts:181-196). The button never shows the amount and there is no confirm. | Harness client-harness.mjs buyin (real table page in an in-memory DOM): Sit here opens the dialog with 0 SEAT_CLAIM; default 800 with 'Bankroll after buy-in 0 chips'; Escape sends nothing and returns focus; typing 300 shows 500 chips; Confirm sends exactly one {buyIn:300, commandId, ack}; with bankroll 150 seats are not claimable. table-ui.spec.ts:296-365 asserts the same. The lobby path was found by reading the code. | Lobby one-click 'Open 6-seat table' buys in for 1,000 without showing or confirming the amount. Owner decision D8 on the default is still open (today it can pre-fill the entire bankroll). |
| CR-010 | S2 | SOL-048 | Play chips shown as dollars | **FIXED** | lib/format.ts:37-45 is the single formatter (formatChips is en-US grouped with no symbol; formatChipsWithUnit adds 'chips'). It is used in seat-hud.tsx:75,103, action-bar.tsx:116,134,174,181, poker-felt.tsx:69,73,92,138, buy-in-dialog.tsx:203-245, page.tsx:141-143 and lobby page.tsx:248,350,375-415. Engine log and error text has no '$' (table.ts:165,1131,1285). | Ran dollar-scan.mjs over apps/web/src, packages/engine/src and packages/shared/src: the only hit is a regex anchor in lib/legal.ts:73. A grep of apps/server/src finds only a bcrypt hash and a Prisma type. Harness 'felt' finds no '$' in the rendered table page body, and the header shows 'Player-0 · 9,000 chips'. table-ui.spec.ts:283-293 asserts main has no '$'. | none for play chips. How real money will be shown per asset is a later decision. |
| CR-011 | S2 | SOL-039 | No CSP, framing or other security headers on the web app | **FIXED** | next.config.ts:10-23 and :30-32 send X-Frame-Options DENY, Referrer-Policy, nosniff, Permissions-Policy and COOP on /:path*, plus HSTS in production. middleware.ts:35-55 and :63-73 set a per-request nonce CSP: strict-dynamic, frame-ancestors 'none', object-src/base-uri 'none', connect-src limited to the API/WSS origins, and no 'unsafe-eval' in production. layout.tsx:28 calls connection() so no page is prerendered without a nonce. | web-headers-recheck.mjs (tsx, NODE_ENV=production) runs the real middleware for /, /login and /table/x: a different nonce each time, no unsafe-eval, and the expected directives. The next.config headers for PHASE_PRODUCTION_SERVER include HSTS. I also inspected today's production build: .next/routes-manifest.json carries all six headers, .next/server/src/middleware.js contains the CSP builder, and prerender-manifest lists 0 static routes. The browser header and CSP-violation test (shell-legal.spec.ts:400-447) runs against next dev only (not run here). | none (no browser run against next start yet) |
| CR-012 | S2 | SOL-046 | Sessions break unless web and API share a "site"; undocumented | **PARTIAL** | The constraint is documented in deploy/README.md:116-141 and docs/DEPLOYMENT.md:17-35 and :54-55, and the edge configs serve one origin. assertCookieSite (security/config-checks.ts:54-70, called at config.ts:107) refuses split sites, but only when PUBLIC_API_ORIGIN is set. It returns at once when that variable is unset (config-checks.ts:55). Shared hosts are detected with a 13-entry list (:34-37), not the Public Suffix List. | config-recheck.mjs (child processes): two *.vercel.app hosts are refused, and vercel.app + onrender.com is refused. But production with CLIENT_ORIGIN=https://poker.vercel.app and PUBLIC_API_ORIGIN unset starts (ok:true), and COOKIE_SITE=co.uk (a public suffix) with app./api.co.uk is accepted. platform-config cookie-site test passes. | The startup check only runs when the operator declares PUBLIC_API_ORIGIN, so a split-site deploy that leaves it unset still starts. The suffix list is a heuristic. The deployment smoke test (log in, reload, still signed in) needs the D6 hosting decision and a staging deploy. |
| CR-013 | S2 | SOL-040 | Usernames allow impersonation (case, reserved names) | **FIXED** | Migration 20261001100000_auth_hardening adds usernameCanonical as a STORED generated column lower(username) with a unique index, after refusing to run if case duplicates exist (schema.prisma:83). Login looks up the canonical name (routes.ts:215). checkChosenUsername refuses names that start with guest_ or bot_, and staff words as the whole name or a prefix (usernames.ts:9-43, routes.ts:165-169). | sessions-recheck.mjs E: after RaceName, both racename and RACENAME get 409 'Username unavailable'. Guest_abc123, guest_1a2b3c, Admin, Support, Dealer, System, Bot_Alice and AdminJoe all get 409. Al1ce_ok gets 201. auth-http register test passes. Note: the review expected 400 for Guest_ names, but it returns 409, a deliberately uniform refusal. | none in code. I could not check whether the migration is applied to the live DB (DB not touched). ASCII homoglyphs (I/l) remain possible. |
| CR-014 | S2 | SOL-043 | No accessible turn announcement or timer text | **FIXED** | turn-announcer.tsx:21-69 is a permanently mounted polite, atomic live region. It says 'Your turn — N seconds to act' once per turnId and once more at 5 s, with no per-second ticking. It is mounted at page.tsx:199. action-bar.tsx:125-131 shows a text countdown, and turn-clock.tsx:180-184 shows seconds on the seat. The 'Focus actions on my turn' setting is at table-controls.tsx:68-72 and is used by action-bar.tsx:69-73. | Harness 'announce' (6.5 s turn, device clock 10 min fast): region polite and atomic, announced 'Your turn — 7 seconds to act', not repeated for a newer snapshot of the same turn, then '5 seconds left to act', no further ticks, action bar '7 s left'. Harness 'storage' shows the focus setting toggling. Specs table-ui.spec.ts:179-195 and :212-220 assert the same. | none for the acceptance criteria. The suggested axe scan of the table page does not exist. |
| CR-015 | S2 | ≈SOL-035 | IP-only limits and 5-second lobby polling will lock out shared-IP players | **PARTIAL** | The general limiter keys requests with a valid bearer token by user and everything else by IP (/56 for IPv6) (security/rate-limits.ts:74-80, app.ts:79). Refresh has its own limiter keyed per cookie (rate-limits.ts:81-90, app.ts:83). The lobby polls only while visible, with back-off (app/page.tsx:103-140), and the list is private, no-cache with an ETag (app.ts:54). But the general limiter also runs on /api/auth/refresh, and the web sends refresh without a bearer (lib/api.ts:169), so refreshes still count against a 120/min per-IP bucket. | sessions-recheck.mjs K: 50 users on one IP made 150 lobby GETs plus 50 refreshes with zero 429s. The lobby revalidates with 304 (I). K2: 130 different sessions each refreshing once from one IP: 120 OK, then 429 from request 121 on (RateLimit-Policy 120;w=60). 20 guest creations from one IP: 15 created, 5 got 429 (credential limit, per IP by design). | Refresh is still capped per IP by the general limiter, for example during a reconnect storm behind CGNAT. Exempt it or key it by the verified cookie. Credential endpoints stay at 15/min/IP, which is a policy choice. |
| CR-032 | S2 | SOL-017 | Blocked browser storage or audio freezes the action buttons; nothing is sent | **FIXED** | action-bar.tsx:91-112: after the in-flight flag, everything is inside try/finally, so pending is always reset. The ACTION_INTENT emit comes first (:98-100), and sound plays after it through playSoundSafely (:14-20, :101). sounds.ts:19-56 and preferences.ts:13-33 wrap all storage and AudioContext access with in-memory fallbacks. table-controls.tsx:39-42 reads them in an effect. The sessionStorage evidence code catches its errors (use-table-socket.ts:221-304). | Harness 'storage' (localStorage and sessionStorage throw SecurityError, AudioContext constructor throws): ACTION_INTENT x1, buttons disabled while the ack is held, no second send, re-enabled after the ack, a later click sends again (x2), the sound and focus toggles work without storage, no console errors. table-ui.spec.ts:110-127 asserts the same in Chrome. | none |
| CR-033 | S2 | SOL-010 | A failed next deal rolls back the previous hand's clean-up and payouts | **OPEN** | manager.ts:346-353: the SHOWDOWN timer still runs completeHand and startHand in one mutate, so a throw in startHand rolls back the clean-up and its cash-outs. The timer then retries every 1 s (:371-379, :464-477). | manager-recheck.mjs: with crypto.randomFillSync faulted, the real SHOWDOWN timer left the ciphertext unchanged. The phase is still SHOWDOWN, the leaver is still seated with pendingLeave, 0 cash-out credits were written, and 3 timer failures were logged in 2.3 s. | Commit Hand Clean-up and its cash-outs in their own mutation, then deal in a separate one with bounded retry and an alert. |
| CR-034 | S2 | SOL-016 | An active idle warning is not re-sent after a reconnect or reload | **FIXED** | socket/index.ts:206-209: AUTH_OK now carries idleNotice from tableManager.currentIdleNotice (manager.ts:290-296). That lookup is read-only, skips stale warnings and leaving players, and swallows its own errors. The web applies it or clears a stale one (auth-hydrator.tsx:262-273). The token renewal no longer reconnects (SESSION_RENEW, socket/index.ts:147-173). | Ran 'AUTH_OK: carries the seated table's active idle warning' in auth-socket.test.mjs through run-tests.mjs: pass. It asserts closingInMs is between 15 and 20 s, with null for an unseated user. Playwright session.spec.ts:204 was not run. | none |
| CR-035 | S2 | SOL-041 | With reduced motion on, the turn clock shows empty immediately | **FIXED** | The bar is no longer a CSS animation. turn-clock.tsx:162-186 sets transform from the anchored clock every 250 ms; under reduced motion it uses steppedFraction (whole seconds) and the --stepped class. globals.css:230-235 exempts .turn-clock-fill from the blanket reduced-motion rule (*:not(.turn-clock-fill)). A text countdown is always shown (turn-clock.tsx:183, action-bar.tsx:126-131). | Harness 'reduced' run with the stubbed and with the real framer-motion (new tsconfig.realfm.json, matchMedia reporting reduce): fill has class turn-clock-fill--stepped, starts at scaleX 1 (not 0), and after about 1.3 s is 0.9333 (14/15) with text '14 s'. table-ui.spec.ts:88-106 asserts the same under emulated reduced motion. | none |
| CR-016 | S3 | SOL-050 | Unique-key races return HTTP 500 | **PARTIAL** | Auth paths are fixed. register maps P2002 to 409 'Username unavailable' or a non-enumerating message for e-mail (routes.ts:175-195). Guest creation uses Guest_ plus 10 hex and retries a clash up to 5 times (routes.ts:229-253). The sibling paths named in the review are unchanged. Table creation (routes/tables.ts:178-205, file dated Sep 28) has no P2002 handling, and app.ts:110-111 turns it into 500. A seat claim that hits TableSeat_userId_key surfaces as INVALID_REQUEST 'Request could not be completed' (manager.ts:211-224, socket/index.ts:175-180). | sessions-recheck.mjs E: concurrent registrations return [201,409] for the same username and [201,409] for the same e-mail. A forced guest name clash is retried and gives 201. table-create-race.mjs (the second create throws P2002 on TableSeat.userId): a double-submitted POST /api/tables returns [201, 500 'Request could not be completed']. | Map P2002 to 409 'already seated' for table creation and seat claims (HTTP and socket). |
| CR-017 | S3 | ≈SOL-036 | Seat and sit commands have no acknowledgement; success can report failure | **FIXED (7 Oct evening)** | apps/server/src/socket/index.ts: SEAT_CLAIM, SIT_OUT and SIT_IN accept commandId and answer the acknowledgement ({ok:true} or {ok:false, code, message}); a failure to start a hand after a committed claim or sit-in is logged, not reported as a failed command. apps/server/src/game/manager.ts: a failed balance notification after a committed seat claim is logged, not thrown. (Was REGRESSED in the afternoon re-check: every buy-in from the dialog was refused, see NEW-1.) | apps/server/test/socket-contract.test.mjs (5 socket tests: claim acknowledged, refusal acknowledged with its reason, deal failure not reported, legacy payload still works, sit toggles acknowledged); e2e.mjs: both seat claims acknowledged {ok:true} on a real PostgreSQL. | commandId is accepted but not yet used to replay the original outcome of a retried command (durable idempotency, F21). |
| CR-018 | S3 | — | Table names are unmoderated free text | **OPEN** | apps/server/src/routes/tables.ts was last modified 2026-09-28, before the review. tables.ts:22 is still z.string().trim().min(1).max(40), with no NFKC normalization, no stripping of bidi or zero-width characters, no allow-list and no reserved-word list. Neither server nor web code (grep for normalize/NFKC/U+202x) sanitizes anywhere. The name goes straight into tx.table.create (tables.ts:184-186) and is listed in the lobby (tables.ts:46). | Ran recheck/legal-compliance/legal-http.test.mjs (createApp on port 0, Prisma stubbed in memory) and POSTed /api/tables with name "‮OFFICIAL SUPPORT​ confirm password". Response 201; the stored name still contains U+202E and U+200B and is byte-identical to the input. | Everything in the recommended fix: a sanitizer (NFKC; strip control, bidi and zero-width characters; character allow-list), a reserved or abusive word list, an operator hide or report path, and unit tests for the sanitizer plus a server test that bidi controls are rejected. |
| CR-019 | S3 | SOL-049 | Decimal bet amounts give a generic error | **PARTIAL** | The client fix landed. chip-amount.ts floors typed amounts, action-bar.tsx:189-191 uses step=1 and normalises on change and blur, and table-ui.spec.ts:149-175 asserts that typing 150.5 shows 150 and sends 150. The server side did not change: socket/index.ts:38 still rejects a fractional amount through zod, and the failure path (:175-180) returns the generic 'Request could not be completed' instead of BAD_AMOUNT. | chip-amount-check.mjs run with tsx: normaliseChipDraft('150.5') returns '150', parseChipDraft('150.9') returns 150. socket-contract.test.mjs: amount 150.5 gets {code:INVALID_REQUEST, message:'Request could not be completed'}. Playwright not run, as instructed. | Map the amount ZodError to BAD_AMOUNT on the server. Real-server sends are blocked anyway by the turnId schema defect. |
| CR-020 | S3 | SOL-051 | Metadata still promises "autonomous AI opponents" | **FIXED** | apps/web/src/app/layout.tsx:19-22 metadata is now "Real-time multiplayer Texas Hold'em between human players. Play chips only: no cash value, not redeemable. 18+." Root package.json:6 says "Real-time multiplayer Texas Hold'em between human players, with play chips that have no cash value". README.md:3 says new tables are for human players. A grep of apps/web/src finds no "AI" or "autonomous" in user-facing text; only the lobby's "legacy bots" count label remains (page.tsx:415). | Grep across tsx, ts, json and md (excluding the review files and plan.md) finds no "autonomous AI" claim. apps/web/test/browser/shell-legal.spec.ts:151-157 checks that the meta description contains "human players" and "no cash value" and does not match /\bAI\b\|autonomous/. Playwright was not run here (forbidden). | none |
| CR-021 | S3 | — | "Cards verified" label overstates the check | **FIXED** | The status the table header shows comes from ConnectionStatus (table/[id]/page.tsx:142). connection-status.tsx:22-24 and 68-71 map every commitment spelling, including the legacy "cards verified", to the label "Cards match commitment". An info button opens a popover (89-91) saying it is a consistency check, not a fairness certification. use-table-socket.ts:28 and 89 set CARDS_MATCH_COMMITMENT when a snapshot's proofs verify. The table page no longer contains the literal "Cards verified". | Ran ssr-legal.mjs (renders the real component): status "cards match commitment" and status "cards verified" both render "Cards match commitment" with the info button; "live" renders "Live"; "verification failed" renders "Card check failed". table-ui.spec.ts:269-270 checks the text and that "Cards verified" appears 0 times (not run here). | none |
| CR-022 | S3 | decision only | Every live hand is shown at showdown; no mucking | **OPEN** | table.ts:1229-1233 still sets showedCards = true for every contender at showdown, and public.ts:234 reveals those cards to everyone. The draft rules page has picked D2(b), auto-muck in show order (rules/page.tsx:111-117). shared/audit.ts:51 calls auto-muck 'the next engine step', so the engine and verifiers are unchanged. | showdown-reveal.mjs: in 50 of 50 three-way showdowns, a spectator's projection contained the losing hands. | Implement the chosen muck rule in settle(), both verifiers, the redaction guards and the audit version, or change the published rule. |
| CR-023 | S3 | — | Sign-out fails if the server is unreachable | **PARTIAL** | The lobby's signOut now clears the socket, session and evidence first, then attempts the server logout and shows a notice if it fails (app/page.tsx:176-197). But it does not cancel AuthHydrator's offline retry, and clearSession does not reset apiOffline (stores/session.ts:111-112). So the pending retry or the 'online' handler (auth-hydrator.tsx:129-133, :199) runs refresh(). That call started with a null token, so current() is true and apply() restores the session (auth-hydrator.tsx:135-157). | signout-offline-recheck.mjs mounts the real AuthHydrator (react-dom/client, mocked fetch) and runs the exact statements of page.tsx signOut. Scenario 1 (a refresh had already failed): signed out locally (user null), then 4 s after connectivity returned the user is Guest_0011223344 again with an access token, and nobody reloaded. Scenario 2 (no prior failed refresh): stays signed out. | Cancel the hydrator retry and reset apiOffline on sign-out. Retry the server logout in the background as recommended, and test 'offline sign-out, then online' end to end. |
| CR-024 | S3 | — | Turn sounds can stay silent after a reload | **PARTIAL** | sounds.ts:63-69 resumes a suspended context, and playSound calls it every time (:95). installAudioUnlock (:75-88) adds capture listeners for pointerdown and keydown that stay installed, mounted on the table page by use-table-fx.ts:12. Every call is in try/catch. No listener exists for pointerup, touchend or click. The HTML standard does not count a touch pointerdown as a user-activating event, so on touch devices (iOS Safari in particular) a tap may not unlock audio until the player clicks an action. | Ran audio-unlock.mjs (real sounds.ts and useTableFx, fake AudioContext starting suspended). A turn sound from a snapshot calls resume; pointerdown and keydown each resume again after re-suspension; pointerup, touchend and click do not; with sound off nothing resumes. table-ui.spec.ts:129-146 checks only a desktop mouse click. The review's manual Chrome and Safari reload check was not possible here. | Add a pointerup/touchend/click unlock for touch input, and do the manual reload check in Chrome and Safari (iOS). |
| CR-025 | S3 | ≈SOL-042 | Text contrast fails WCAG AA (Call button measured 3.19:1) | **PARTIAL** | The listed items are fixed. Call is white on emerald-800 (action-bar.tsx:161). 'Open seat' is emerald-100 on opaque emerald-950 (seat-hud.tsx:36-39). Small texts moved from /50-/60 to emerald-50 or /90 (for example page.tsx:135, game-log.tsx:20-23). Not fixed: the seat avatar initials are text-xs bold black on hsl(avatarHue 70% 60%) (seat-hud.tsx:58-62), and avatarHue is randomInt(360) (auth/routes.ts:183,240). | contrast.mjs computes 39 table-page pairs from Tailwind oklch tokens and globals.css, composited over the lightest felt or page; all are at least 4.5:1 (lowest: felt phase 5.87, winners 5.47). contrast-sanity.mjs reproduces the review's measured 3.19:1 as 3.20. avatar-contrast.mjs: hues 230-266 (10.3% of users) fall below 4.5:1, worst 3.64:1 at hue 240. shell-legal.spec.ts:455-478 walks every text node on lobby, login and legal pages; the table page has only 4 controls checked (table-ui.spec.ts:251-265). | Avatar initials fail for blue hues. The table page has no whole-page contrast or axe scan (the review asked for an axe run on lobby, login and table at desktop and phone widths). |
| CR-026 | S3 | — | Guest accounts are unrecoverable and guests are not told | **PARTIAL** | Guests are now told plainly. The lobby shows that a guest account cannot be recovered and is lost on sign-out, cleared data or another device (app/page.tsx:250-252, :329-332). Guest creation requires terms and 18+ (routes.ts:229-230). No 'Save my account' upgrade exists: authRouter has only register, login, guest, refresh, logout, sessions, logout-all and me (routes.ts:152-406), and no web code offers an upgrade. | Read only for the warning text (static JSX in a client page). A route listing plus a grep for upgrade/claim in apps/server/src and apps/web/src found no upgrade path. | An upgrade endpoint and UI that set username, e-mail and password on the same user row, keeping its id and bankroll (D9 recommends keeping guests with an upgrade path; DECISIONS.md, which the code cites, does not exist in the repo). |
| CR-027 | S3 | — | Legacy bot decisions block the event loop | **OPEN** | manager.ts:362-365 still calls decideBotAction synchronously inside armTimers for any BOT actor. config.ts:148 and :157-162 define ENABLE_LEGACY_BOTS (default off: 'a bot's turn is then treated like an absent player's'), but nothing in apps/server/src reads gameConfig. New tables are still human-only (routes/tables.ts:159-162, unchanged). | bot-latency.mjs: one bot decision on the flop with 5 opponents blocks the event loop for a median of 28 ms (TAG, max 48 ms) and 60 ms (GTO, max 70 ms). | Wire the D11 flag (bots time out or are retired) or move decisions to a worker thread; add an event-loop-lag test. |
| CR-031 | S3 | — | The 1M-shuffle suite can fail on a healthy RNG; no procedure for it | **FIXED** | rng.test.ts:18-50 and helpers/stats.ts:264-279 implement the two-stage rule: a failing family is re-run on a fresh 1M sample and fails only if the repeat fails too. Both p-values and the offending row's counts are printed. The forced-p unit tests are at rng.test.ts:757-815. .github/workflows/ci.yml:167-179 runs the full suite nightly and on demand, and docs/TESTING.md:87-100 documents the procedure. | Ran the 'two-stage family decision' block of rng.test.ts in jest: 5 passed (pass without a repeat, repeat after a false alarm, fail only when both fail, p equal to alpha or NaN, a real bad sample fails both stages and prints counts). | none in code. Failure records live only in CI logs. Accredited lab certification is external. |
| CR-036 | S3 | SOL-014 | A bot-scheduling error after commit reports failure, skips notifications and stalls the table | **OPEN** | manager.ts:180-182 still calls armTimers(next) after the commit and outside any try. For a bot actor that runs decideBotAction synchronously (:362-365), so a throw rejects mutate before the deliveries at :186-192. | manager-recheck.mjs: with RNG faulted and a bot to act, mutate rejected with 'Synthetic bot RNG outage' while revision 1 was committed. 0 broadcasts were attempted and no turn timer was armed. | Isolate the post-commit scheduling, still deliver, and arm a fallback timeout (or retire bots under D11). |
| CR-037 | S3 | SOL-015 | Restart grace for idle closure is per process (inconsistent with several servers) | **NEEDS DECISION** | manager.ts:44 resumedAt and :384-390 idleFrom and staleWarning are still per-process. docs/DEPLOYMENT.md:250-257 now says to run exactly one API instance and to drain before starting the next (no cross-instance ownership). | manager-recheck.mjs: two managers on the same stored table. The freshly resumed one does not warn; the older one starts the warning. | The rolling-restart policy decision. Code side not done: no persisted recovery generation or grace deadline. Only the single-instance constraint is documented. |
| CR-038 | S3 | SOL-038 | Balance display can go backwards (wallet updates are unordered) | **PARTIAL** | The client half landed. The lobby's /auth/me patches are guarded by walletVersion (web app/page.tsx:67-70, :220-223), and the store drops a USER_PATCH whose walletVersion is not newer (stores/session.ts:115-123; contract at events.ts:236-239). The server never sends walletVersion: patchBankroll (manager.ts:244-248) emits only {bankroll}, and there is no revision column or field. | manager-recheck.mjs: with the first wallet read delayed, USER_PATCH payloads arrived as [10000, 9000] with keys [bankroll]. The client has no version to compare, so it applies both and the display goes backwards. | A monotonic wallet revision persisted with each balance change and sent in USER_PATCH and /auth/me. |
| CR-039 | S3 | SOL-045 | Opening a closed table fresh loses the "Verify hand" control | **OPEN** | idle-close-dialog.tsx:347 sets lastHand only when a snapshot exists, and :408-418 renders FairnessAudit only with a snapshot. A fresh page for a closed table gets only a TABLE_CLOSED refusal and no snapshot (use-table-socket.ts:118), so there is no 'Verify hand'. The server has no participant hand list: tables.ts routes are GET /, GET /:id, GET /:id/hands/:handNumber/audit and POST / (:30,59,117,152). | Harness 'closed' (fresh mount, server sends TABLE_CLOSED): the closed dialog shows with 'Verify hand' buttons = 0 (check failed). table-lifecycle.spec.ts:335-336 asserts this absence on purpose ('No snapshot of the table, so no hand to verify'). Only the mid-hand reconnect case (:342-369) can verify. | A participant-only list of hands (or at least a hand-number entry against the existing audit endpoint) that works without live state, plus the reload test. |
| CR-040 | S3 | SOL-047 | Startup accepts unusable bankroll, timer and token-lifetime values | **PARTIAL** | Server-side bounds are in. DEFAULT_STARTING_BANKROLL is capped at 1e9 and TURN_TIME_BANK_MS at 5,000-120,000 (config.ts:48-49). JWT TTLs are parsed and bounded, and normalised to '<n>s' (config.ts:56-57, config-checks.ts:17-28). The time bank is bounded at config.ts:145-155. But the client still refreshes on a fixed 10-minute timer (auth-hydrator.tsx:20) while JWT_ACCESS_TTL may be 1-60 min. An access token that lapses before the refresh makes the next broadcast drop the socket (notify.ts:37-40). | config-recheck.mjs: 2147483648 for the bankroll, the turn bank and TIME_BANK_INITIAL_MS is refused, as are 'not-a-duration', 61m and SESSION_IDLE_TTL=forever. JWT_ACCESS_TTL=60s and 9m are accepted. sessions-recheck.mjs D (without renew): a socket whose access token expired is disconnected on the next broadcast ('io server disconnect', no snapshot). platform-config tests pass. | Derive the client refresh interval from the token lifetime (for example, return expiresIn), or raise the minimum JWT_ACCESS_TTL above the client interval. |
| CR-028 | S4 | — | Dead socket contracts | **OPEN** | HAND_HISTORY_LOG is still defined (packages/shared/src/events.ts:16,252) and still listened for by the client (use-table-socket.ts:139,163, store appendLog in session.ts:179), but no emitter exists in apps/server/src or packages/engine/src. AUTH_OK.activeTableId is still sent (socket/index.ts:208, typed at events.ts:107) and never read in apps/web/src. The server now uses it internally to find idleNotice, but the client reads only idleNotice. | read only: a grep over apps/server/src, packages/engine/src, packages/shared/src and apps/web/src for HAND_HISTORY_LOG and activeTableId; nothing to run for a dead contract. | Remove the HAND_HISTORY_LOG listener and event (or emit it), and drop activeTableId from the payload or use it on the client. |
| CR-029 | S4 | — | UI polish bundle | **PARTIAL** | (a) Lobby listError is cleared on any successful load (page.tsx:57-60, shown at :298-302). (c) cardName uses rank names (playing-card.tsx:14-21,46). (d) The felt centre is not a live region; a single announcer speaks only a new hand, a new street or the result (poker-felt.tsx:56,126-153). (e) The watchdog says 'taking longer than usual. Still trying…' and re-joins (use-table-socket.ts:145-152). (f) Status labels at page.tsx:22-27,418. (b) Not fixed: GameLog renders raw engine text (game-log.tsx:24), and the engine writes ungrouped amounts (table.ts:1131 'raises to', :1285 'wins ${amount}'). | Harness scenarios: 'watchdog' shows the new message and TABLE_JOIN x2; 'felt' shows no announcement on load or on a call, 'Flop: Jack of clubs, Seven of clubs, King of clubs.', and cards 'Ace of diamonds \| Two of hearts'; 'loggroup' FAILS: the hand log says 'Player-0 raises to 1200' while the seat says 'Bet 1,200'. Specs shell-legal.spec.ts:289-298 and :300-370 assert (f) and (a). | (b) Hand-log amounts are not grouped like the rest of the UI. Minor sibling of (f): the felt centre still shows the raw phase enum, such as 'WAITING' or 'COMPLETE' (poker-felt.tsx:59). |
| CR-030 | S4 | ≈ licence list | Missing third-party notices and own licence statements | **PARTIAL** | THIRD_PARTY_NOTICES.md (2026-10-06) lists 218 production packages with their licence texts. It has dedicated sections on the LGPL-3.0-or-later obligations for libvips in @img/sharp-* and the CC-BY-4.0 attribution for caniuse-lite (lines 12-30). scripts/generate-third-party-notices.mjs produces it and has a --check mode. All five package.json files declare "license": "UNLICENSED". The file's lockfile SHA-256 matches the current package-lock.json. | Ran `node scripts/generate-third-party-notices.mjs --check` (read-only; runs a local npm ls): "THIRD_PARTY_NOTICES.md is up to date", exit 0. Grep of .github/workflows/ci.yml: no step runs the generator or --check. | (1) The file is generated by hand, not at build time, and the --check is not in CI, so it can drift without anyone noticing. (2) The Linux @img/sharp-libvips-* packages are not in package-lock.json (notices line 16), so a Linux image's LGPL texts are not reproduced. (3) The LGPL source offer and CC-BY handling for the actual deployment are still an open checklist item (docs/DEPLOYMENT.md:301-304) for the owner or counsel. |
| CR-041 | S4 | SOL-052 | Odd-chip type comment names the wrong starting seat | **FIXED** | packages/shared/src/poker.ts:33-37 now reads "Odd-chip rule: the first eligible winner clockwise from the seat left of the button…". This matches the engine (packages/engine/src/pots.ts:100-131, seatingOrderFromBlinds from dealer+1), the published House Rules (rules/page.tsx:132) and COMPLIANCE.md:87. The old wording "earliest position past the blinds" no longer appears. | Ran ssr-legal.mjs, which calls the built engine's splitOddChips on 6-max tables. Dealer 0 with winners {0,3}: odd chip to seat 3. Dealer 2 with winners {1,4}: seat 4. Dealer 5 with winners {0,5}: seat 0. Each time this is the first winner clockwise from the seat left of the button, as the comment says. | none |

### 3.4 The 29 September audit's findings (F01 to F22): status now

**Status counts now (22):** 3 fixed, 10 partly fixed, 7 open, 2 waiting on an owner decision or an external party. The original write-ups are in the 2026-09-29 entry of progress.md and in BACKEND-SECURITY-AUDIT.md.

| ID | Severity (29 Sep) | Finding | Status now | Evidence now | Verified by | What remains |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | Critical | free play chips must never become redeemable balances | **PARTIAL** | Guests and registrations still credit env.DEFAULT_STARTING_BANKROLL straight into the mutable User.bankroll that pays buy-ins (auth/routes.ts:182, 239). What changed: config.ts:48 now allows a value of 0, so issuance can be switched off. Sign-up requires 18+ and terms. Guests are warned their account cannot be recovered (page.tsx:250, 330). The unwired ledger design makes PLAY a separate asset that cannot be redeemed, and ledger_ensure_account refuses withdrawal, deposit and fee accounts for it (docs/money/LEDGER.md:40-44). | Ran legal-http.test.mjs with DEFAULT_STARTING_BANKROLL=10000 set explicitly (the code default): guest 201, bankroll 10000, isGuest true. With DEFAULT_STARTING_BANKROLL=0: guest 201, bankroll 0. Ran wiring-and-migrations.mjs: no server module outside src/money imports the ledger. | Separate play and cash balances exist only in the unwired ledger. Gameplay and grants still use User.bankroll (LEDGER.md:5-8). There is no gate keeping guest or demo identities out of cash games, because cash games do not exist yet. Classifying the existing pre-launch balances is still to be done. |
| F02 | Critical | no financial ledger, asset model or reconciliation | **PARTIAL** | Migration 20261002200000_ledger_foundation adds Asset, LedgerAccount, LedgerTransaction and LedgerEntry with BIGINT minor units. It also adds the SECURITY DEFINER functions ledger_post (balanced per asset, shape rules, idempotency hash, overdraft checks) and ledger_ensure_account, plus append-only triggers. money/{amounts,flows,ledger}.ts plan and execute the postings. But LEDGER.md:3-8 states that nothing in the game server calls it yet and that User.bankroll stays authoritative. Buy-ins and cash-outs still mutate User.bankroll directly (manager.ts:165, 219; tables.ts:181). | Ran money-amounts.test.mjs and money-flows.test.mjs through run-tests.mjs --import tsx: 21/21 pass. wiring-and-migrations.mjs: no module outside src/money imports money/*; it lists 5 direct bankroll writes. The real-Postgres tests (test/db/ledger-foundation.test.mjs, concurrency.test.mjs) were not run, because test:db is forbidden here. | Integration: post buy-ins, cash-outs, grants and rake through the ledger atomically with game state; table-escrow reconciliation; backfill or classification of existing balances; retiring User.bankroll as the source of truth. Acceptance ("reconstruct every balance from the ledger") is not met for any live balance. |
| F03 | Critical | fiat/crypto deposit, withdrawal and custody controls are absent | **NEEDS DECISION** | There is still no deposit, withdrawal, webhook, provider, wallet or custody code. The only traces are a reserved CSRF exemption prefix "/api/payments/webhooks/" (app.ts:87) and ledger posting plans for DEPOSIT_CREDIT, DEPOSIT_REVERSAL, WITHDRAWAL_HOLD, WITHDRAWAL_RELEASE, WITHDRAWAL_SETTLE and PROVIDER_FEE (money/flows.ts:224-309). Real assets ship disabled (LEDGER.md:45-49). docs/DEPLOYMENT.md:319-321 lists "Payment and custody providers under contract" as an external prerequisite. | Read only: route inventory (app.ts:92-95 mounts only health, auth, tables and admin) and a grep for webhook, provider, deposit and withdraw outside src/money. There is nothing to run. | Owner decision or external dependency first: legal entity, PSP or custody provider, supported assets and chains, settlement currency. The code side is NOT done beyond ledger posting shapes. Still missing: authenticated callbacks, a durable inbox and outbox, finality and reorg policy, withdrawal dispatch with reservation, approvals and idempotency, chargeback states, and segregated signing. |
| F04 | Critical | identity, eligibility and AML gates are missing | **OPEN** | Access is still decided by a valid session plus user.kind === HUMAN (auth/middleware.ts:30). The only new identity-related data is the self-declared 18+ and terms timestamps (schema.prisma:89-91; auth/routes.ts:123-125). Nothing verifies identity, age, residence or market eligibility, email, sanctions or PEP status, and there is no restricted or suspended account state or compliance case record. No suspension or exclusion gate exists at seat claim or hand start. Guests can still play. | Grep of apps/server/src and schema.prisma for eligibility, kyc, sanction, suspend, restrict and exclusion finds no such state or gate. ACCOUNT_RESTRICTED is raised only for non-HUMAN kinds. legal-http.test.mjs: a guest can still be created with a checkbox self-declaration. | A backend-enforced eligibility state machine (restricted, suspended or excluded states checked at sign-in, seat claim, hand start and on live sockets) can be built now. KYC and screening provider integration and the market list depend on the owner's decision (D10) and external providers. |
| F05 | Critical | responsible-gaming enforcement is absent | **OPEN** | responsible-gaming/page.tsx is information only. Its own comment (lines 12-18) and labels (lines 52-60) mark deposit and loss limits, session limits, reality checks, time-outs and self-exclusion as "Available with real-money play", so the page does not claim they are live. The backend has no self-exclusion, limit, reality-check or cooling-off models, routes or checks: schema.prisma has none, and middleware, seat and action paths check none. | Read and grep only (schema.prisma, apps/server/src). There is no RG code to exercise. | All of F05: persisted self-exclusion with identity scope, atomic limit enforcement across sessions and workers, reality checks, cooling-off, rechecks wherever new exposure is taken, and a withdrawal route for excluded players. Helpline details are placeholders (page.tsx:89-92). |
| F06 | High | no anti-collusion, multi-account or automation operations | **OPEN** | New tables still refuse bots (tables.ts:159-160), and the Terms now prohibit bots and real-time assistance (terms/page.tsx:94). The new ENABLE_LEGACY_BOTS flag (config.ts:148, 157-162, default false, documented as "a bot's turn is then treated like an absent player's (it times out)") is never read. Nothing in apps/server/src imports gameConfig, and manager.ts:362-365 still runs decideBotAction for every BOT seat. There is no device or account linkage, collusion, chip-dumping, RTA detection or investigation tooling. | Ran table-lifecycle.test.mjs "AFK human and a bot" through run-tests.mjs with ENABLE_LEGACY_BOTS=false: it passes, and it asserts "the bot acted" and "the bot never timed out" (table-lifecycle.test.mjs:926-927). wiring-and-migrations.mjs: zero readers of gameConfig or enableLegacyBots. | Wire the legacy-bot switch so bots actually stop (see new findings), or retire bots. Anti-collusion, multi-account and automation detection, review tooling and the appeal process are all still missing. |
| F07 | High | player and administrator authentication is below the target assurance | **PARTIAL** | Added: per-account lockout (routes.ts:37-42, 198-204), one bcrypt comparison on every path using a dummy hash (routes.ts:20-26, 219), e-mail clashes that do not reveal the e-mail (routes.ts:46, 192), a session inventory with remote and global sign-out (routes.ts:363-397), and security log events (LOGIN_LOCKOUT, REFRESH_REUSE). Unchanged: ADMIN is still the ordinary password session plus a database role check (routes/admin.ts:34-47), with no MFA, passkey, step-up or separate privileged identity. There is no password change, reset, recovery or e-mail verification route, and PASSWORD_CHANGED is defined but never used (sessions.ts:117). | auth-http.test.mjs login tests pass (equal bcrypt work, lockout). login-lockout.mjs shows the new lockout can be abused (see newFindings). | Phishing-resistant admin authentication and step-up, password change/recovery with session invalidation, compromised-password checks. These depend on owner and identity-provider decisions. |
| F08 | High, reproduced | malformed requests leak passwords to logs and bypass rate limits | **PARTIAL** | All limiters now run before express.json (app.ts:75-90). Body-parser errors are answered 400/413/415, and only their type and status are logged (app.ts:97-107). Errors go through an allow-list serializer, and pino redacts credential keys (security/safe-log.ts, logger.ts:13-17). The admin access log drops the query string (admin-access-log.ts:54). But requireAdmin's ADMIN_DENIED security log still writes req.originalUrl including the query (routes/admin.ts:40, unchanged since Sep 27). | sessions-recheck.mjs J with a capturing production-options logger: a malformed login carrying a synthetic password gives 400, an oversize body gives 413, and the marker is absent from the logs. Malformed requests hit 429 after the 15/min credential budget. GET /api/admin/...audit?token=RECHECK_QUERY_SECRET with a non-admin token gives 403, and the log line 'admin route denied' contains path '...audit?token=RECHECK_QUERY_SECRET'. platform-http tests pass. | Strip the query string in admin.ts:40, as admin-access-log.ts already does. |
| F09 | High, reproduced with an inconsistent recipient | cash-out can silently discard chips | **OPEN** | manager.ts:164-168 still ignores the affected-row count of the cash-out updateMany (where kind HUMAN), then clears cashOuts and saves the released seat. The ledger (money/flows.ts planCashOut, money/ledger.ts) is not used: docs/money/LEDGER.md:5 says 'Nothing in the game server calls it yet'. | manager-recheck.mjs: the credit returned count 0, standUp succeeded with no error, the seat was released and 0 cash-outs were left pending. | Verify exactly one wallet or ledger posting per cash-out, otherwise roll back and keep a recoverable obligation; wire the ledger. |
| F10 | High, reproduced | server downtime can immediately forfeit a player's turn | **OPEN** | The engine now has rebaseTurnClock (table.ts:411-419), but nothing in apps/server/src or dist calls it. recover() (manager.ts:109-127) still arms the old deadline, so an expired turn fires at once. Because of the CR-002 change, the actor is now also sat out. rules/page.tsx:101, :165 and terms/page.tsx:107 promise a fresh base time after an outage. | manager-recheck.mjs (the security-review outageRecovery probe, adapted): TIMEOUT_FOLD 8 ms after recover(). The actor was sat out with reason TIMEOUT and there is no TURN_CLOCK_RESET in the audit. | Call rebaseTurnClock for the pending actor in recover() and add a server test; coordinate across workers. |
| F11 | High | key lifecycle and separation are incomplete | **PARTIAL** | The key ring has key ids (v2.<kid>), a legacy k0 and an active id (security/key-ring.ts, config.ts:61). A compare-and-set rotation script (apps/server/scripts/rotate-game-key.mjs) runs as a dry run by default. In production, assertProductionSecrets refuses all-zero, low-entropy, placeholder and duplicate keys and keys reused as JWT secrets (config.ts:105-106). One ring still encrypts live table state, hole cards and sealed audits (encryption.ts:8-14; manager.ts:175, :509; audit.ts:146). | config-recheck.mjs (production child processes): an all-zero key reused as the access secret is refused ('repeats a single byte'), a random key reused as the access secret is refused ('reuses encryption key "k0"'), and independent strong secrets are accepted. platform-crypto.test.mjs: 9/9 pass (ring, rotation, secret checks). | Separate keys for live gameplay and retained audit data. Managed key custody (KMS/HSM) with audited use, backup and restore tests, and emergency revocation (operator/external). |
| F12 | High | one runtime role can alter both balances and administrator identity | **PARTIAL** | Migration 20261002200000 gives the runtime role only SELECT on the ledger tables, behind a SELECT-only policy, and EXECUTE on ledger_post and ledger_ensure_account (migration.sql:542-583). It adds trigger User_guard_privileged_columns, which stops poker_server UPDATEs to User.role and User.kind (500-519), and Hand_require_audit (521-540). test/db/privileges.test.mjs pins a privilege matrix. Still open: poker_server keeps SELECT, INSERT and UPDATE on User (privileges.test.mjs:37), so it can read passwordHash and directly rewrite User.bankroll, which is still the authoritative balance. It can also INSERT a user with role=ADMIN (LEDGER.md:255-259). The guard hard-codes current_user = 'poker_server' (migration.sql:511). No privilege check runs at startup. | Read only for the database part: test:db and the real-Postgres privilege and ledger tests are forbidden here. wiring-and-migrations.mjs compared the tables the migrations create with the privilege matrix: TableIncident (20261003100000_game_reliability) is missing from EXPECTED (see new findings). | Separate identity, admin and financial write capabilities: move balances onto the ledger and revoke UPDATE of bankroll, refuse role=ADMIN inserts from the runtime role, restrict passwordHash reads. Verify effective privileges at startup or deploy. Update the privilege matrix to cover TableIncident. |
| F13 | High | audit integrity is not independently anchored and live state is replayable | **OPEN** | Table state is still sealed with AAD `table:${tableId}` only (manager.ts:71, :175), with no revision or generation binding and no external checkpoint or witness. The new key ring adds key IDs (F11), not freshness. The ledger journal is append-only but not wired to games. | f13-replay.mjs: after the stored ciphertext was replaced with an older valid one (revision 1 instead of 2), TableManager.get loaded revision 1 without complaint. | Durable command, start, void and settlement records; freshness checks against independently protected history; external anchoring; a restore protocol. |
| F14 | High assurance gap, reproduced | audit replay does not validate betting legality | **OPEN** | engine audit.ts:166-169 says outright that the replay 'does not re-judge betting legality'. The new shared settlementMoneyProblem (shared/audit.ts:665-680) checks money flow only. | manager-recheck.mjs: replaced a 10-chip CALL with CHECK in a v2 record and rebuilt the hash chain. verifySealedAudit, verifyHandOutcome and verifyAuditRecord all returned ok, and settlementMoneyProblem returned null. | A versioned full-rules replay (turn order, legal actions, minimum raises, reopening) and an independent reference implementation. |
| F15 | High operational gap | transport and deployment hardening remain unverified | **NEEDS DECISION** | Code side done. Production refuses proxy mode without TRUSTED_PROXY_CIDRS and requires TLS directly or via a trusted proxy, plus database TLS and rediss (config.ts:89-108). HOST is configurable (config.ts:27-28). The compose file binds to 127.0.0.1 and has no default passwords (docker-compose.yml). The Caddy and nginx edge configs overwrite forwarded headers. The web sends CSP and framing headers (CR-011). DEPLOYMENT.md:10-13 states that the Dockerfiles and edge configs were never built or run, and HOST still defaults to 0.0.0.0 in production. | config-recheck.mjs: production proxy mode without TRUSTED_PROXY_CIDRS is refused, and production with HOST unset starts bound to 0.0.0.0. deploy/test/deploy-config.test.mjs: 15/15 pass (loopback ports, no default passwords, headers overwritten, TLS/HSTS/limits at the edge). platform-config proxy test passes. | External: choose hosting (D6), build and run the images and edge in staging, inspect the real production network (DB/Redis reachability, origin port exposure), and send forged-header tests directly to the origin. |
| F16 | Medium, reproduced | refresh replay and lifetime policies are incomplete | **PARTIAL** | Sessions now have an idle TTL (default 7 d) and an absolute TTL (default 30 d). The cookie, row and JWT share one expiry (sessions.ts:30-38, jwt.ts:21-24, routes.ts:78-86). Token-family reuse detection revokes the session and logs a security event (routes.ts:277-304). Concurrent tabs get a 15 s grace (sessions.ts:14). Session inventory and remote revocation exist. Within the window, though, the previous token is accepted any number of times and is not logged (routes.ts:296, 299), where the review advised 'allow it once, log it'. There are no shorter limits for ADMIN sessions, and no password change or recovery exists to trigger invalidation. | sessions-recheck.mjs A2/A3: a replay after the grace window gives 401, clears the cookie, records REFRESH_REUSE, and kills the current token and its access tokens. A session created 365 days ago (past its absolute expiry) gets 401. A refresh near the absolute end is capped at it. Cookie Max-Age and JWT exp match the row. auth-http lifetime/rotation/reuse tests pass, and its rotation test asserts that a third use of the previous token inside the window succeeds. | Limits for privileged (ADMIN) sessions. Single, logged grace reuse. Invalidation on password change and recovery once those flows exist. |
| F17 | Medium, reproduced | revoked sockets still receive user-room notifications | **FIXED** | Every socket joins session:<sid>. On revocation the listener emits SESSION_REVOKED and disconnects that room through the adapter, so it is cluster-wide with Redis (socket/index.ts:36-37, 76-83, 103). Before any private emit, USER_PATCH and TABLE_IDLE_NOTICE re-check each socket's session (notify.ts:32-66; manager.ts:243-248, 278-280), and so do snapshots (manager.ts:318-329). The only remaining delay is the documented 5 s positive cache for revocations made by another process (sessions.ts:15-24). | sessions-recheck.mjs G: a session revoked in process gets SESSION_REVOKED(LOGOUT) and is disconnected. A row revoked by 'another process' gets 0 USER_PATCH once the cache lapses, plus SESSION_REVOKED and a disconnect. Inside the 5 s cache window, 1 patch was still delivered after revocation (the documented bound). The valid session keeps receiving patches. auth-socket private-delivery/revocation tests pass. | none |
| F18 | Medium, reproduced at the handler | cookie routes lack explicit origin/CSRF enforcement | **FIXED** | requestGuard runs on every non-GET/HEAD/OPTIONS /api request, before body parsing (app.ts:84-89; security/request-guard.ts:53-78). Any Origin other than CLIENT_ORIGIN, including 'null', gets 403. Without an Origin, Sec-Fetch-Site: cross-site gets 403. A non-JSON body gets 415. The Socket.io handshake checks Origin too (socket/index.ts:49-54). | sessions-recheck.mjs H, guest creation: text/plain from a foreign origin 403, text/plain with no Origin 415, form-urlencoded from the same origin 415, Sec-Fetch-Site cross-site 403, Origin null 403, a sibling subdomain origin 403, JSON from the same origin 201. Refresh and logout from a foreign origin 403. A socket handshake from a foreign origin gets connect_error. platform-http CSRF test passes. | none |
| F19 | Medium, reproduced | sensitive account responses lack explicit cache prohibition | **FIXED** | Before any other /api middleware, every response gets Cache-Control: no-store plus Pragma: no-cache. That covers 426/403/415/429/400/401 refusals and 404s. The lobby list alone is 'private, no-cache' with Vary: Authorization and an ETag (app.ts:49-57). | sessions-recheck.mjs I: guest 201, me 200, refresh 200, logout 204, me 401, guard 403 and 415, and /api 404 are all no-store. The lobby list is 'private, no-cache', Vary Authorization, has an ETag, and revalidates with 304. platform-http Cache-Control test passes. | none (verification on the deployed edge/CDN still to be done) |
| F20 | Medium | admission, rate limiting and backpressure do not cover a distributed service | **PARTIAL** | Limits are now keyed by user or verified cookie, run before body parsing, and the 5 s auth cache bounds database load to one lookup per session per window (rate-limits.ts:72-96, sessions.ts:24). Still missing: counters remain per-process MemoryStore, which is documented (rate-limits.ts:22-26). There is no pre-auth connection limiter or per-session socket ceiling on the handshake (socket/index.ts:84-100). Broadcast checks are unbounded with Promise.all over all viewers (manager.ts:320). Deployment is one instance only (DEPLOYMENT.md, 'Several API instances'). | sessions-recheck.mjs K/K2: per-user keying holds (0 × 429 for 50 users on one IP), but the per-IP general bucket still caps unauthenticated traffic, refresh included (121st of 130 gets 429). platform-http limiter tests pass. Read only for the absent socket connection quotas. | A shared limiter store before multi-instance deployment, socket connection quotas and admission control, bounded concurrent authentication/projection work, and reconnect-storm and load testing. |
| F21 | Medium | command receipt and service-readiness contracts are incomplete | **PARTIAL** | GET /api/ready (routes/health.ts:29-33, security/readiness.ts) now checks the database probe, the schema check, recovery and draining, and index.ts:76-117 drains gracefully. But recover() swallows each table's failure (manager.ts:125), and markRecoveryFinished still runs (index.ts:61), so a stuck table never affects readiness and there is no table-health report. clientActionId is still validated but unused (socket/index.ts:38, :242). | Ran both readiness tests in platform-http.test.mjs through run-tests.mjs: pass (dead DB gives /api/ready 503 while /api/health stays 200; draining, timeout and cache). Also, CR-004's corrupt table was retried and logged with no readiness signal. | Durable idempotency and outcome queries keyed by clientActionId and commandId; per-table health and alerts. |
| F22 | High launch evidence gap | privacy, retention, incident response and restore controls | **PARTIAL** | docs/DEPLOYMENT.md:259-280 adds a backup, key-ring backup and restore-drill outline plus a pre-launch checklist (:283-330). The privacy page lists the data collected, but its retention periods are placeholders awaiting counsel (privacy/page.tsx:91-96). There is still no job that deletes expired sessions: no deleteMany or purge anywhere in apps/server/src, and the auth_hardening migration only adds columns. | Read only: grep for cleanup, purge, deleteMany and retention across server src and migrations found nothing. Nothing to run. | An expired-session and IP retention job, retention periods (owner and counsel), incident playbooks, and an executed restore drill with records. |

### 3.5 Every additional problem the four re-check agents reported (verbatim)

These are de-duplicated and numbered as NEW-1 to NEW-9 in 3.2. Severities here are each agent's own.

- **S2: Published House Rules promise a personal time bank that the server never gives any table**
  - Where: apps/server/src/config.ts:149-173 (gameConfig.extraTimeBank); apps/server/src/game/manager.ts:81; apps/web/src/app/rules/page.tsx:98
  - What happens: The House Rules (draft, linked from every page) say each player has a personal time bank that starts at 30 s, grows 5 s every 10 hands and caps at 60 s, used after the 20 s base time. config.ts builds gameConfig.extraTimeBank from TIME_BANK_* variables, but no server module reads gameConfig. The only engine createTable call (manager.ts:81) passes no extraTimeBank, so every table runs with extraTimeBank=null. Players are timed out and sat out after the base time alone, contrary to the published rule that decides time-outs. Browser tests only pass because the fixture server injects extraTimeMs (table-ui.spec.ts:73-78).
  - Evidence: review/claude/recheck/legal-compliance/wiring-and-migrations.mjs prints: gameConfig.extraTimeBank = {initialMs:30000, maxMs:60000, refillMs:5000, refillEveryHands:10}, but zero server modules read gameConfig or extraTimeBank. Also prints manager.ts:81 createTable({tableId, name, maxSeats, smallBlind, bigBlind, timeBankMs, createdAt}), and the engine table built from those arguments has extraTimeBank = null.
- **S3: Published House Rules describe automatic mucking of losing hands; the engine tables every live hand**
  - Where: apps/web/src/app/rules/page.tsx:110-116 versus packages/engine/src/table.ts:1229-1234 and packages/shared/src/audit.ts:51, 639
  - What happens: The rules page, new on 2026-10-05, says "Losing hands are mucked automatically; you never have to show a hand that cannot win", and that a later hand is shown only if it beats or ties. The engine still sets showedCards=true for every contender at showdown, and the audit verifier requires exactly that. shared/audit.ts:51 calls auto-muck "the next engine step". So players' losing hole cards are revealed to everyone, against the published rule (decision D2 / CR-022 is still open).
  - Evidence: review/claude/recheck/legal-compliance/showdown-muck.mjs (pure engine dist) played 40 decided heads-up check-down showdowns. In the 24 where the first player to show (left of the button) won, the loser's hole cards were still in a spectator's public snapshot all 24 times. Example: dealer 0, first to show 1, winner 1, revealed to spectator [0,1].
- **S3: ENABLE_LEGACY_BOTS flag is dead: legacy bots keep playing when it is false**
  - Where: apps/server/src/config.ts:148, 157-162; apps/server/src/game/manager.ts:362-365
  - What happens: config.ts documents ENABLE_LEGACY_BOTS as "Off by default: a bot's turn is then treated like an absent player's (it times out)" (decision D11). Nothing reads gameConfig.enableLegacyBots. armTimers still schedules decideBotAction for any BOT actor, so bots still play against humans on legacy tables whatever the flag says. An operator relying on the flag to retire bots (F06 / CR-027) gets no effect.
  - Evidence: Ran `ENABLE_LEGACY_BOTS=false node test/support/run-tests.mjs --test-name-pattern="AFK human and a bot" test/table-lifecycle.test.mjs`: it passes, with its assertions "the bot acted" and "the bot never timed out" (table-lifecycle.test.mjs:926-927). wiring-and-migrations.mjs finds zero readers of gameConfig or enableLegacyBots in apps/server/src.
- **S3: DB privilege-matrix test does not know the new TableIncident table, so test:db will fail and the table's grants are not covered**
  - Where: apps/server/test/db/privileges.test.mjs:36-51 and 104-107; apps/server/prisma/migrations/20261003100000_game_reliability/migration.sql
  - What happens: The 20261003100000_game_reliability migration (written 2026-10-06 01:40) creates public."TableIncident" and grants poker_server SELECT, INSERT and UPDATE. privileges.test.mjs was last edited at 00:58 that day. Its EXPECTED matrix lacks TableIncident, so the test "every table in schema public is in the expected privilege matrix" (assert.deepEqual of public table names against the EXPECTED keys) fails once all migrations are applied. The catalog check never examines TableIncident's privileges, so the CI privilege gate for F12 is broken or blind for that table.
  - Evidence: review/claude/recheck/legal-compliance/wiring-and-migrations.mjs (static parse of every migration.sql and of the EXPECTED block): tables missing from EXPECTED = ['TableIncident (20261003100000_game_reliability)']. Modification times: privileges.test.mjs 2026-10-05T22:58Z, migration 2026-10-05T23:40Z (UTC). test:db itself was not run (forbidden).
- **S4: Compliance text claims controls that do not exist (real-money terms lock, "every account confirms 18+")**
  - Where: apps/web/src/lib/legal.ts:12-14; apps/web/src/app/responsible-gaming/page.tsx:102; apps/server/src/auth/routes.ts:53 (cites DECISIONS.md)
  - What happens: lib/legal.ts says "real-money mode refuses to start until the approved version equals the current one (server-side, decision D10)". The server has no real-money mode and no approved-terms check. The Responsible Gaming page tells users "Every account confirms its holder is 18 or older", but accounts created before the auth_hardening migration have termsVersion and ageConfirmedAt NULL and keep signing in with no prompt. Code cites DECISIONS.md (routes.ts:53, usernames.ts) for D9 and D10, but no such file exists in the repository.
  - Evidence: Grep of apps/server/src for approved, realMoney and REAL_MONEY returns nothing. legal-http.test.mjs: a user row with termsVersion=null gets login 200 and /auth/me 200. `find . -iname DECISIONS*` (excluding node_modules) returns nothing.
- **S0: Real server refuses the web client's actions (turnId) and buy-ins (commandId)**
  - Where: apps/server/src/socket/index.ts:24, :38, :216-217 vs apps/web/src/components/table/action-bar.tsx:98-100, apps/web/src/components/table/buy-in-dialog.tsx:123, packages/shared/src/events.ts:32-57
  - What happens: The server's zod payloads are strict: tablePayload is .strict() and the action and seat payloads extend it. The Oct 5-6 web client adds turnId to every ACTION_INTENT when the snapshot has one, which is always while someone is to act, and adds commandId to every SEAT_CLAIM. The real server rejects both with INVALID_REQUEST 'Request could not be completed'. A player's every click is refused, so their turn times out and they are sat out with reason TIMEOUT. Nobody can buy in from the dialog. The browser suites miss this because the fixture server (apps/web/test/support/game-server.mjs:244-273) never validates payloads, and no server test sends these keys.
  - Evidence: review/claude/recheck/game-server/socket-contract.test.mjs, run against the real createSocketServer from dist through run-tests.mjs (output in socket-contract.out.txt). The snapshot had turnId '1:2'. The web ACTION_INTENT got ack {ok:false, code:INVALID_REQUEST} and manager.intent was not called; the same payload without turnId got {ok:true}. The web SEAT_CLAIM got SERVER_ERROR INVALID_REQUEST ('Unrecognized key: commandId') and seatClaim was not called. A standalone zod 4.6.5 check confirmed the same rejection.
- **S1: Published turn-clock rules (personal time bank, fresh clock after an outage) are not applied by the server**
  - Where: apps/web/src/app/rules/page.tsx:95-101, :165; apps/web/src/app/terms/page.tsx:107; apps/server/src/config.ts:148-175; apps/server/src/game/manager.ts:81, :109-127
  - What happens: The rules promise a 30-60 s personal time bank after the base time and a fresh base time after a service interruption. gameConfig.extraTimeBank, like ENABLE_LEGACY_BOTS, is never read anywhere in apps/server/src. manager.ts:81 calls createTable without extraTimeBank, and routes/tables.ts:193 stores only timeBankMs, so no table has a time bank. Players are timed out, and now also sat out, about 30 s earlier than published. After a restart the player to act is folded at once, because the engine's rebaseTurnClock is never called.
  - Evidence: grep: 'gameConfig' appears only in config.ts and its dist; no server src or dist file references rebaseTurnClock or TURN_CLOCK_RESET. manager-recheck.mjs F10 probe: TIMEOUT_FOLD 8 ms after recover(), the actor sat out with reason TIMEOUT, and no TURN_CLOCK_RESET in the audit.
- **S2: Draft house rules promise auto-muck of losing hands; the engine shows every live hand to the whole table**
  - Where: apps/web/src/app/rules/page.tsx:111-117 vs packages/engine/src/table.ts:1229-1233 and packages/engine/src/public.ts:234
  - What happens: The rules page says losing hands are mucked automatically and that hands are shown in order only if they can win. settle() still marks every contender showedCards = true, and the public projection shows those cards to every viewer, spectators included, and keeps them in the audit. The published rule and actual behaviour disagree on what other players get to see.
  - Evidence: review/claude/recheck/game-server/showdown-reveal.mjs (output in showdown-reveal.out.txt): in 50 of 50 three-way checked-down showdowns, a spectator's projectTableState contained the losing hands (example: winner seat 1, losers 0 and 2 shown). packages/shared/src/audit.ts:51 calls auto-muck 'the next engine step'.
- **S3: Personal time bank is shown to players but not timed by the server (time-bank config defaults on but is never used)**
  - Where: apps/server/src/config.ts:146-172 (gameConfig.extraTimeBank, default TIME_BANK_INITIAL_MS 30000; gameConfig is never imported); apps/server/src/game/manager.ts:81 (createTable passes no extraTimeBank) and :361 (turn timer = turnStartedAt + timeBankMs - now); packages/engine/src/public.ts:46-51,98,222-226; apps/web/src/components/table/turn-clock.tsx:92-109,182
  - What happens: The Oct 5-6 work added a per-player time bank. The engine includes it in turnDeadline/turnRemainingMs, and the client shows it ('+30 s bank', 'Time bank N s'). The server's turn timer still arms for the base time only, and applyTimeout does not check the deadline. Today this cannot happen, because the documented 'time bank for NEW tables (D4)' config is not read anywhere (the same is true of ENABLE_LEGACY_BOTS), so tables get no time bank and the client and server agree. If the setting is wired into createTable as its comment says, the server folds the player and sits them out at base expiry while their clock still shows 30 s of bank.
  - Evidence: review/claude/recheck/web-ui/timebank-mismatch.mjs (engine dist only): a table with extraTimeBank 30 s and a 15 s base projects turnRemainingMs 45 s with baseTimeMsRemaining 15 s, while the manager formula fires after 15 s. applyTimeout at 16 s returns status FOLDED, sittingOut true, reason TIMEOUT. A grep shows gameConfig and extraTimeBank are referenced only in config.ts within apps/server/src.
- **S3: Signing out offline is silently undone when connectivity returns**
  - Where: apps/web/src/components/auth-hydrator.tsx:129-133, :135-157, :199; apps/web/src/stores/session.ts:111-112; apps/web/src/app/page.tsx:176-197
  - What happens: Suppose the hydrator has already seen the API as unreachable (apiOffline true, retry scheduled) and the player then presses Sign out. The lobby clears the local session, but the hydrator's pending retry and its 'online' handler are not cancelled, and clearSession leaves apiOffline set. When the network returns, refresh() runs with the still-valid HttpOnly cookie. Its staleness check compares null with null and passes, so apply() signs the device back in without any reload or click. The notice the page shows says only that 'reloading' may sign the user back in. On a shared device the next person gets the account.
  - Evidence: review/claude/recheck/auth-security/signout-offline-recheck.mjs mounts the real AuthHydrator with mocked fetch. Scenario 1: userRightAfterSignOut null, userFourSecondsAfterReconnect 'Guest_0011223344', hasAccessToken true. The requests were online refresh, OFFLINE refresh, OFFLINE logout, online refresh. Scenario 2 (no prior failed refresh) stays signed out.
- **S3: Per-account login lockout lets anyone keep a player locked out indefinitely; the correct password gets 'Invalid credentials'**
  - Where: apps/server/src/auth/routes.ts:27-42 (loginLockMs), :198-204 (recordFailedLogin), :215-224 (login)
  - What happens: After 5 wrong guesses from any IP, the account is locked for 30 s, doubling up to 15 min. One more wrong guess each time a lock lapses re-locks it. Usernames are public (shown at every table), so a small, steady trickle of wrong guesses keeps a chosen account unable to sign in. During the lock the owner's correct password returns the same 401 'Invalid credentials'. There is no password reset or unlock path, and nothing tells the owner the account is locked. Sessions that already exist keep working.
  - Evidence: review/claude/recheck/auth-security/login-lockout.mjs: reproduces the escalating lock (capped at 15 minutes) and its renewal by one more wrong guess. ownerWithCorrectPassword is [401,'Invalid credentials'] at every step. auth-http.test.mjs:276-297 also asserts the identical 401 for the right password while locked.

### 3.6 Comparison with GPT-6.1-Sol: what it missed, what differed

GPT-6.1-Sol's report (`GPT-6.1-SOL-REVIEW.md`, 52 findings, SOL-001 to SOL-052) was read in full. Its repro scripts were re-run here:
- `browser-defects.spec.ts`: 10 of 10 reproduce;
- `server-faults.mjs` and `absence-and-config.mjs`: all observations reproduce.

**Both reviews agree on the big picture.** The engine is sound, real money is NO-GO, and a public play-chip launch should wait for the player-harm fixes.

**Counting differs.** GPT's 52 include about 20 items that restate the earlier audit's F01–F22 (for example SOL-001 = F09, SOL-022 = F08). This report tracks those in section 4 instead, so its 41 are all additions.

| Relationship | Items |
| --- | --- |
| Found by both | CR-001=SOL-007; CR-002=SOL-019; CR-003=SOL-018; CR-004=SOL-009; CR-005=SOL-012; CR-006=SOL-013; CR-007=SOL-011 (GPT's version is broader: the refresh cookie is deleted); CR-009=SOL-044; CR-010=SOL-048; CR-011=SOL-039; CR-012=SOL-046; CR-013=SOL-040; CR-014=SOL-043; CR-015≈SOL-035; CR-016=SOL-050; CR-017≈SOL-036; CR-019=SOL-049; CR-020=SOL-051; CR-025≈SOL-042; CR-030≈GPT's licence inventory |
| Found by GPT only; adopted after re-running | CR-032=SOL-017 (storage blocks actions); CR-033=SOL-010 (next deal rolls back payouts); CR-034=SOL-016 (warning not replayed); CR-035=SOL-041 (reduced-motion clock); CR-036=SOL-014 (bot post-commit throw); CR-037=SOL-015 (per-process restart grace); CR-038=SOL-038 (balance goes backwards); CR-039=SOL-045 (closed table loses Verify hand); CR-040=SOL-047 (unusable config accepted); CR-041=SOL-052 (odd-chip comment) |
| Found by this review only | CR-008 (valid actions refused as stale); CR-018 (table-name spoofing); CR-021 ("Cards verified" overclaim); CR-023 (offline sign-out); CR-024 (sounds never resume); CR-026 (guest recoverability); CR-027 (bot CPU); CR-028 (dead contracts); CR-029 (polish); CR-031 (RNG-suite false alarms: one of four runs here failed by chance) |
| GPT items this report keeps under the earlier audit | SOL-001–006, 008, 020–027, 030–034, 037 map to F01–F22 (section 4). SOL-028 (independent assurance) and SOL-029 (real-database/multi-process tests) are in section 12 |

**Where the two differ in judgement:**
- **Severity.** GPT rates 29 findings S0/S1 for real money. This report reserves S1 for defects that harm players in normal single-server use. For example, GPT's S1 for SOL-014 (legacy bot tables only) and SOL-015 (only with several servers) appear here as S3.
- **Showdown mucking.** GPT lists it as a house-rule decision; this report lists it as a finding (CR-022) with a decision attached. Either way, the owner decides.

What GPT-6.1-Sol did not report at all (searched in its report), with status now:

| ID | Sev | What GPT missed | Status today |
| --- | --- | --- | --- |
| CR-008 | S2 | Valid actions are refused as "The table changed" when anyone else sits in or out, joins or leaves | FIXED (7 Oct evening) |
| CR-018 | S3 | Table names accept bidi, zero-width and look-alike text, so tables can be spoofed | OPEN |
| CR-021 | S3 | The "Cards verified" label claims more than the check proves | FIXED |
| CR-023 | S3 | Signing out fails when the server is unreachable; the device stays signed in | PARTIAL (NEW-6) |
| CR-024 | S3 | The AudioContext is never resumed, so turn sounds can stay silent all session | PARTIAL |
| CR-026 | S3 | Guests cannot recover their account and are not told | PARTIAL |
| CR-027 | S3 | Legacy bot Monte-Carlo decisions block the server's event loop for every table. GPT mentioned bot CPU only in passing, inside other findings | OPEN |
| CR-031 | S3 | The 1M-shuffle suite can fail by chance on a healthy RNG (one of Claude's four runs did), and there was no procedure for that | FIXED |
| CR-028 | S4 | Socket events and fields that nothing sends or reads | OPEN |
| CR-029 | S4 | UI polish: a stuck lobby error, card names, watchdog wording, raw status labels | PARTIAL |

Also: GPT listed forced showdown (CR-022) only as a house-rule decision. It rated SOL-014, SOL-015 and SOL-017 S1, where this review rated them S3, S3 and S2. About 20 of its 52 findings restate F01–F22.

---

## 4. What is right (good)

### 4.1 Verified correct: do not "fix"

- **Shuffle and RNG.** OS CSPRNG words, exact rejection limit, Durstenfeld loop, health test (`rng.ts`, `deck.ts`); the statistical suite passes (CR-031 was a false alarm).
- **Evaluator.** Exhaustive suite and `verify-evaluator.mjs` pass.
- **Pots and payouts.** Side pots, merge by eligibility, uncalled-bet return, and odd chips left of the button (`pots.ts`), replayed by the server's audit verification for 28,273 fuzzed hands.
- **Chip conservation** across every lifecycle transition, including closures and payouts (fuzz: 0 failures over 277,666 events).
- **Leak guard and participant redaction guard.** No leaks and no false positives, including with card-like usernames (Ah_Kd, Kd2c, Js_Jh…).
- **Browser card verification.** No false alarms (680,212 checks).
- **`upgradeTableState` does nothing to current states**, so reloads don't mutate state (checked after every fuzz commit).
- **Heads-up order, dead button and forward-moving big blind.** Traced for the 3→2 and 2→3 transitions; no player posts the big blind twice in a row.
- **Incomplete all-in raise reopening.** It matches the TDA rule; cumulative short all-ins reopen (`legal.ts:17-18`).
- **Pot-fraction bet shortcuts** use the standard pot-raise formula (`action-bar.tsx:44`).
- **Seat-claim and table-creation money safety** under concurrency: rollback plus `TableSeat_userId_key` (reasoned; a real-Postgres test was not possible).
- **Prisma and Supabase migration copies are identical.**
- **No secrets** in files or history; `npm audit` clean; no XSS sinks.
- **Private-table membership checks, participant-audit authorization and timer revision guards** behave as designed.
- **Table closure pays each player exactly once** (fuzz plus code).

### 4.2 Fixed and verified since 30 September

| ID | What was fixed | Verified by |
| --- | --- | --- |
| CR-002 (S1) | Absent players are blinded off indefinitely: packages/engine/src/table.ts:99 defaults sitOutOnTimeout to true. | Re-ran table-behaviour part 1 (review/claude/recheck/game-server/manager-recheck.mjs). |
| CR-003 (S1) | Turn countdown uses the viewer's device clock: turn-clock.tsx:68-85 builds the clock from relative turnRemainingMs/timeBankMsRemaining; :88-139 runs it on performance.now() anchored at arrival (use-table-socket.ts:79 receivedAt = performance.now()). | Ran seat-timer-skew-v2.mjs (real engine dist snapshot, real SeatHud and ActionBar via SSR, viewer Date.now skewed). |
| CR-005 (S2) | Every token refresh tears down the socket and resets the table view: The client keeps one socket per user (apps/web/src/lib/socket.ts:29-48) and passes each refreshed token to it with SESSION_RENEW (socket.ts:83-102; auth-hydrator.tsx:93-98, 116-127). | Ran apps/server/test/auth-socket.test.mjs via run-tests.mjs: 7/7 pass, including the SESSION_RENEW test. |
| CR-006 (S2) | Two tabs refreshing together sign one tab out: For REFRESH_GRACE_MS = 15 s (sessions.ts:14) the server accepts the token that the last rotation replaced, and does not rotate again (routes.ts:256-299). | sessions-recheck.mjs A: two concurrent refreshes return [200,200] both naturally and with forced interleaving (both read before either rotates). |
| CR-007 (S1) | A transient DB error is treated as sign-out: login cookie deleted, sockets dropped without reconnecting: Only an AuthError (auth/errors.ts:20-29) is treated as a sign-out. | sessions-recheck.mjs with an injected Prisma P2024 pool timeout: F /refresh returned 503 retryable, Retry-After 2, no Set-Cookie, and the same cookie gave 200 afterwards; /me during the outage returned 503. |
| CR-008 (S2) | Valid actions refused as stale after unrelated table changes: apps/server/src/game/manager.ts intent(): with the client's turnId, an action is refused as STALE_ACTION only when turnIdOf(table) differs (the turn it was chosen for is over); without turnId the old revision rule applies. | apps/server/test/socket-contract.test.mjs (manager tests: accepted after a bystander sat out; refused for a finished turn; revision rule without turnId). |
| CR-010 (S2) | Play chips shown as dollars: lib/format.ts:37-45 is the single formatter (formatChips is en-US grouped with no symbol; formatChipsWithUnit adds 'chips'). | Ran dollar-scan.mjs over apps/web/src, packages/engine/src and packages/shared/src: the only hit is a regex anchor in lib/legal.ts:73. |
| CR-011 (S2) | No CSP, framing or other security headers on the web app: next.config.ts:10-23 and :30-32 send X-Frame-Options DENY, Referrer-Policy, nosniff, Permissions-Policy and COOP on /:path*, plus HSTS in production. | web-headers-recheck.mjs (tsx, NODE_ENV=production) runs the real middleware for /, /login and /table/x: a different nonce each time, no unsafe-eval, and the expected directives. |
| CR-013 (S2) | Usernames allow impersonation (case, reserved names): Migration 20261001100000_auth_hardening adds usernameCanonical as a STORED generated column lower(username) with a unique index, after refusing to run if case duplicates exist (schema.prisma:83). | sessions-recheck.mjs E: after RaceName, both racename and RACENAME get 409 'Username unavailable'. |
| CR-014 (S2) | No accessible turn announcement or timer text: turn-announcer.tsx:21-69 is a permanently mounted polite, atomic live region. | Harness 'announce' (6.5 s turn, device clock 10 min fast): region polite and atomic, announced 'Your turn — 7 seconds to act', not repeated for a newer snapshot of the same turn, then '5 seconds left to act', no further ticks, action bar '7 s left'. |
| CR-017 (S3) | Seat and sit commands have no acknowledgement; success can report failure: apps/server/src/socket/index.ts: SEAT_CLAIM, SIT_OUT and SIT_IN accept commandId and answer the acknowledgement ({ok:true} or {ok:false, code, message}); a failure to start a hand after a committed claim or sit-in is logged, not reported as a failed command. | apps/server/test/socket-contract.test.mjs (5 socket tests: claim acknowledged, refusal acknowledged with its reason, deal failure not reported, legacy payload still works, sit toggles acknowledged); e2e.mjs: both seat claims acknowledged {ok:true} on a real PostgreSQL. |
| CR-020 (S3) | Metadata still promises "autonomous AI opponents": apps/web/src/app/layout.tsx:19-22 metadata is now "Real-time multiplayer Texas Hold'em between human players. | Grep across tsx, ts, json and md (excluding the review files and plan.md) finds no "autonomous AI" claim. |
| CR-021 (S3) | "Cards verified" label overstates the check: The status the table header shows comes from ConnectionStatus (table/[id]/page.tsx:142). | Ran ssr-legal.mjs (renders the real component): status "cards match commitment" and status "cards verified" both render "Cards match commitment" with the info button; "live" renders "Live"; "verification failed" renders "Card check failed". |
| CR-031 (S3) | The 1M-shuffle suite can fail on a healthy RNG; no procedure for it: rng.test.ts:18-50 and helpers/stats.ts:264-279 implement the two-stage rule: a failing family is re-run on a fresh 1M sample and fails only if the repeat fails too. | Ran the 'two-stage family decision' block of rng.test.ts in jest: 5 passed (pass without a repeat, repeat after a false alarm, fail only when both fail, p equal to alpha or NaN, a real bad sample fails both stages and prints counts). |
| CR-032 (S2) | Blocked browser storage or audio freezes the action buttons; nothing is sent: action-bar.tsx:91-112: after the in-flight flag, everything is inside try/finally, so pending is always reset. | Harness 'storage' (localStorage and sessionStorage throw SecurityError, AudioContext constructor throws): ACTION_INTENT x1, buttons disabled while the ack is held, no second send, re-enabled after the ack, a later click sends again (x2), the sound and focus toggles work without storage, no console errors. |
| CR-034 (S2) | An active idle warning is not re-sent after a reconnect or reload: socket/index.ts:206-209: AUTH_OK now carries idleNotice from tableManager.currentIdleNotice (manager.ts:290-296). | Ran 'AUTH_OK: carries the seated table's active idle warning' in auth-socket.test.mjs through run-tests.mjs: pass. |
| CR-035 (S2) | With reduced motion on, the turn clock shows empty immediately: The bar is no longer a CSS animation. | Harness 'reduced' run with the stubbed and with the real framer-motion (new tsconfig.realfm.json, matchMedia reporting reduce): fill has class turn-clock-fill--stepped, starts at scaleX 1 (not 0), and after about 1.3 s is 0.9333 (14/15) with text '14 s'. |
| CR-041 (S4) | Odd-chip type comment names the wrong starting seat: packages/shared/src/poker.ts:33-37 now reads "Odd-chip rule: the first eligible winner clockwise from the seat left of the button…". | Ran ssr-legal.mjs, which calls the built engine's splitOddChips on 6-max tables. |
| F17 | revoked sockets still receive user-room notifications: Every socket joins session:<sid>. | sessions-recheck.mjs G: a session revoked in process gets SESSION_REVOKED(LOGOUT) and is disconnected. |
| F18 | cookie routes lack explicit origin/CSRF enforcement: requestGuard runs on every non-GET/HEAD/OPTIONS /api request, before body parsing (app.ts:84-89; security/request-guard.ts:53-78). | sessions-recheck.mjs H, guest creation: text/plain from a foreign origin 403, text/plain with no Origin 415, form-urlencoded from the same origin 415, Sec-Fetch-Site cross-site 403, Origin null 403, a sibling subdomain origin 403, JSON from the same origin 201. |
| F19 | sensitive account responses lack explicit cache prohibition: Before any other /api middleware, every response gets Cache-Control: no-store plus Pragma: no-cache. | sessions-recheck.mjs I: guest 201, me 200, refresh 200, logout 204, me 401, guard 403 and 415, and /api 404 are all no-store. |
| NEW-1 (S0) | The real server refused every buy-in and action from the web client: fixed this evening (1.4) | socket-contract tests; e2e on a real PostgreSQL |
| NEW-10, NEW-11, NEW-12, NEW-13 | Start-up explanation, development retry, schema check, Prisma client (3.1) | startup tests; e2e scenarios B and C; schema comparison |

### 4.3 Every test and verification run in this session

| When | Check | Result |
| --- | --- | --- |
| 30 Sep | Typecheck (shared, engine, server, web) | 4/4 |
| 30 Sep | Engine Jest (14 suites) | 450/451; the 1 failure was a statistical false alarm in the 1M-shuffle suite; 3 reruns passed (CR-031) |
| 30 Sep | Server `node --test` (5 files) | 65/65 |
| 30 Sep | Evaluator check (all 2,598,960 five-card hands) | Pass |
| 30 Sep | `npm audit` (production and all) | 0 known vulnerabilities |
| 30 Sep | Secret scan of tracked files and full git history | 0 hits |
| 30 Sep | `review/claude/repro/engine-fuzz.mjs`, seeds 1–5 | 28,273 hands; 277,666 events; 8,527 showdowns; 586 closures; 65,667 participant audits; 680,212 browser card verifications; **0 failures** |
| 30 Sep | Production build; browser suite | Pass; 56/56 |
| 30 Sep | GPT-6.1-Sol's repro scripts, re-run by me | All reproduced (10/10 browser defects; all server observations) |
| 30 Sep | Live database, read-only counts in a READ ONLY transaction | 6 tables (3 closed, 3 waiting); 0 stuck; 2 human users, both guests; 56 hands; 1 expired session |
| 7 Oct 16:55 | Rebuild + typecheck (4 workspaces) | Pass |
| 7 Oct | Engine Jest (15 suites, including the 1M-shuffle suite) | **458/477**. 19 failures, all in `review-fixes.test.ts` section 3: an outdated assertion (NEW-8). Everything else passes |
| 7 Oct | Server suite (10 files) | 115/115 |
| 7 Oct | Ledger unit tests (with `--import tsx`, as CI runs them) | 21/21 |
| 7 Oct | `npm run test:db` (embedded PostgreSQL 18) | **41/43**. 2 privilege-matrix failures on `TableIncident` (NEW-7) |
| 7 Oct | Browser suite | 156/156 |
| 7 Oct | Engine fuzz, seeds 1–3 (60 tables × 800 steps) | 6,248 hands; 73,611 events; 1,680 showdowns; 142 closures; 13,721 participant audits; 165,727 browser card verifications; **0 failures** |
| 7 Oct | Socket contract against the real server (`review/claude/recheck/game-server/socket-contract.test.mjs`) | 4/4 confirmed NEW-1 (before the fix) |
| 7 Oct 20:07 | Real server source on a disposable database (`boot-smoke.mjs`) | Listening in 1.6 s; ready; guest 201; lobby 200; up after 20 s |
| 7 Oct 20:3x | New tests (`socket-contract.test.mjs`, `startup.test.mjs`) | 15/15 |
| 7 Oct 20:3x–20:5x | Server suite (12 files); ledger; browser; end-to-end (twice) | 130/130; 21/21; 156/156; all scenarios pass |

Not re-run after this evening's fixes, because nothing they test changed:
- the engine Jest suite: no engine code was changed;
- `test:db`: no database code changed; it still has the 2 `TableIncident` failures.

---

## 5. Decisions needed, legal register, claims check

From `CLAUDE-REVIEW.md` §6–§8. Status notes from the 7 October re-check follow each table.

### Decisions needed from the owner

| # | Decision | Options | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| D1 | Absence and disconnection policy | (a) sit out after the first time-out; (b) after N time-outs; (c) sit out on disconnect after a grace period; (d) status quo | (a) plus (c) with a 60 s grace; publish it | CR-002 |
| D2 | Showdown mucking | (a) table every live hand (current); (b) auto-muck losing hands unless shown; (c) player option | (b) | CR-022 |
| D3 | Idle closure | 5 min + 10 s warning (current); a longer warning (30–60 s); treat all-sat-out tables as idle | 5 min + 30 s warning | brief lead 13 |
| D4 | Time bank | 15 s fixed (current); 20–30 s plus a per-player extendable bank; disconnect protection | 20 s plus a 30–60 s extendable bank | CR-002, CR-003 |
| D5 | Chip unit | "$" (current); chip icon or "chips"; per-asset currency for real money | Chips now | CR-010 |
| D6 | Hosting topology | same site (`app.` + `api.`); same origin through a proxy | Same origin through a reverse proxy | CR-012 |
| D7 | Username policy | case-insensitive unique; reserved words; allowed scripts | As in CR-013 | CR-013 |
| D8 | Buy-in UX and default | a dialog with a bounded default (100 BB or less) | A dialog, defaulting to min(100 BB, bankroll) | CR-009 |
| D9 | Guests | keep for play chips (age-gated); remove before real money | Keep, age-gated, with an upgrade path | CR-026, F01 |
| D10 | Legal documents and markets | counsel | – | CR-001, F04 |
| D11 | Bots | retire from production; keep legacy tables | Retire | CR-027, F06 |
| D12 | Unrecoverable hands | void and refund; settle from the last known stacks; who authorizes | Void and refund with dual approval and an audit record | CR-004 |

Status of the decisions on 7 October:
- **Implemented by the 1–6 October session, but the owner's choice is not recorded:**
  - D5: chips shown as "chips";
  - D7: username policy;
  - D8: a buy-in dialog;
  - D9: guests warned;
  - D11: a bot switch that does nothing (NEW-5).
- **Contradicted by the published House Rules:**
  - D2: the rules promise auto-muck, but every hand is still shown;
  - D4: the rules promise a time bank the server does not give.
- **Missing record:** the code cites `DECISIONS.md`, which does not exist.
- **New and unrecorded:** rake support at 0% (no table can set it).

### Legal and regulatory exposure register

Each item is flagged for counsel. This is not legal advice.

| # | Item | Evidence | Why it matters |
| --- | --- | --- | --- |
| L1 | Real-money prerequisites absent: licence, KYC/age/geo, AML, RG tools, player-fund segregation | F01–F05 | Launch blockers under an MGA Type 3 plan |
| L2 | No privacy notice or lawful-basis information while collecting email, IP, user agent and gameplay data | CR-001; `schema.prisma` User/Session; logs | GDPR information duties at collection. Verify with counsel |
| L3 | No age gate; instant guest play | CR-001 | Gambling-style games are age-restricted in many markets, some even without money. Verify per target market |
| L4 | Unpublished rules decide outcomes: time-outs, absence, idle closure, forced showdown, interrupted hands | CR-002, CR-022, F10 | Unfair-terms and consumer-protection exposure if applied without published terms |
| L5 | Currency symbols on play chips | CR-010 | Misleading presentation or advertising rules. Verify |
| L6 | Claims: "Cards verified", "AI opponents", "seat stays reserved" | CR-021, CR-020, CR-002 | Misrepresentation |
| L7 | Accessibility gaps | CR-014, CR-025 | The European Accessibility Act covers certain consumer e-commerce services from 28 June 2025. Verify whether it applies |
| L8 | Open-source notices | CR-030 | Licence compliance (LGPL, CC-BY) |
| L9 | Retention and data rights: expired sessions kept, IPs, indefinite hand history, no deletion or export | F22; live DB (1 expired session) | GDPR storage limitation and data-subject rights |
| L10 | No account recovery, so a locked-out player cannot reach their balance | F07 | Consumer protection once balances have value |

### Claims check

| Claim (source) | Rating | Evidence |
| --- | --- | --- |
| "Every hand is shuffled with an unbiased Fisher-Yates (Durstenfeld) shuffle … CSPRNG … rejection sampling" (README) | TRUE | `rng.ts`, `deck.ts`; suite passes (CR-031 is a false alarm) |
| Commitment and Merkle root computed before blinds or any deal, published in the first snapshot (README) | TRUE | `table.ts:272-290`, `public.ts:86-110` |
| A fail-closed guard refuses any snapshot with more than the viewer may see (README) | TRUE | `public.ts:225-278`; fuzz: 680,212 client verifications, no leaks, no false positives |
| Every in-hand transition is hash-chained, sealed and linked to the previous hand (README) | TRUE | `audit.ts`. The replay does not re-judge betting legality (F14); the README doesn't claim it does |
| Newcomers and returners wait for the big blind; a leaver is folded on their turn (README) | TRUE | `table.ts:131-155`, `:341-378`; fuzz |
| "Restarts. Server downtime is not inactivity" (README) | TRUE for the idle clock | Misleading if read to cover turn deadlines: a restart can time a player out at once (F10) |
| Production refuses to start without TLS, strict DB TLS or separate JWT secrets (README) | TRUE | `config.ts:39-50`. Encryption-key strength is not checked (F11) |
| "Cards verified" (table header) | OVERSTATED | CR-021 |
| "Real-time Texas Hold'em with autonomous AI opponents" (page metadata) | FALSE for new tables | CR-020 |
| "Lobby (keep seat)" / "the seat stays reserved" (UI, progress.md) | OVERSTATED | The player keeps being dealt in and blinded (CR-002) |
| "Any chips you had at this table are back in your bankroll" (closed dialog) | TRUE | Except the F09 zero-row edge |
| "Actions receive explicit success/error acknowledgements" (progress.md 28 Sep) | PARTIAL | True for actions, leave and keep-alive; not for seat claims or sit toggles (CR-017) |
| Verify-hand success and failure messages (`fairness-audit.tsx`) | TRUE | Carefully scoped to what is proven |
| "Bot strategy receives the same restricted view" (SECURITY-REVIEW) | TRUE | `decide.ts:30-43` |
| "Consumed randomness is zeroed" (COMPLIANCE, SECURITY-REVIEW) | TRUE (narrowly) | The word buffer is zeroed. The deck necessarily stays in memory and encrypted state until Clean-up |

---

## 6. Session notes

### 6.1 What you asked, in order

1. A prompt for GPT-6.1-Sol to review the whole site for a real-money, worldwide launch (29 Sep 21:58). Done: `GPT-6.1-SOL-REVIEW-PROMPT.md` and a private web page.
2. Questions about `/auto-mode-setup`, then "just remove". Done: the `autoMode` settings section removed (2.2).
3. "Do the task I gave gpt6.1sol" (29 Sep 23:54). Done: `CLAUDE-REVIEW.md`, 31 findings, repro scripts.
4. "gpt6.1sol finished, finish your testing and see what it said" (30 Sep 01:52). Done:
   - ran the skipped checks;
   - read and re-ran GPT's work;
   - adopted 10 of its findings that reproduced (CR-032 to CR-041), bringing the total to 41.
5. "Add your findings to progress.md, let everyone know, add anything GPT missed" (30 Sep 02:06), then "continue" (7 Oct). Done:
   - re-checked all 63 items against the 1–6 October code;
   - ran every suite;
   - wrote the progress.md entry.
6. The screenshot: "why is this happening, and fix it", plus this file (7 Oct 19:54 to 20:23). Done: this file and the evening fixes.

### 6.2 Interruptions

- **7 Oct 17:22:** the session hit its usage limit. Two of the four re-check agents (auth/security and web UI) died and restarted from scratch at 19:11, when the limit reset.
- **7 Oct 19:54–20:13:** several of my replies were stopped part-way by a safety classifier, and you re-sent the request each time. I don't know exactly what triggered it. Since then I have:
  - not read `.env` values or the live database;
  - described security problems as defects and fixes, not as how to exploit them.
- **7 Oct 20:19:** a read-only probe of the live database was refused as a production read and not attempted again (1.7).
- **7 Oct 21:03:** the usage limit was reached again, this time by four independent read-only reviewers I had started at 21:00:
  - their roles: bugs in this evening's code, accuracy of this file, completeness, and privacy/safety;
  - none had reported when the limit hit, and it resets at 00:10;
  - I stopped that run rather than leave it to restart unattended, and did the four checks myself.

  Corrections that came out of those checks:
  - the build facts in 1.2 and 2.2;
  - the 0.4 s / 0.6 s timing in 1.5;
  - the `localhost` tip in 1.6;
  - exact lockout rates removed from the lockout defect, which is still reported in full.

  An independent review of this evening's changes is still worth running once the limit resets.

### 6.3 Rules I kept

- **Live database:** never written. The only reads were the 30 September counts (READ ONLY transaction, counts only, as the review brief allowed) and the 7 October project-status call.
- **Secrets:** no values from `.env` printed or copied.
- **Your processes:** your dev servers on ports 3000/4000 were never stopped or bound. My tests used other ports (3107/4107, or random free ports) and throwaway databases.
- **Dependencies:** none installed. `prisma generate` only regenerates the client from the existing package.
- **Git:** no commit, push, checkout, reset, stash or clean.

### 6.4 What this file cannot contain

- **The replies stopped by the safety classifier** on 7 October (19:54–20:13). Their text was withheld and was never saved, so it cannot be recovered. The work in them was redone afterwards and is recorded here.
- **The partial work of the two re-check agents cut off at 17:22.** Both were re-run from scratch, and their final results are in 3.3 and 3.4.
- **The four reviewers stopped at 21:03.** They had produced no results (6.2).
- **Full command lines and raw test logs.**
  - Appendix E lists every command by its description. Several commands carried whole scripts, and the scripts are in `review/claude/`.
  - Raw test logs are in `%TEMP%\claude-review\recheck\`, which is temporary. Their results are in 4.3, and the key raw outputs are in Appendix K.
- **Anything about your live database beyond the 30 September counts and the 7 October project status.** I did not read it.

---

## 7. Where we stand: a score out of 10 (7 October 2026, evening)

**10** means what the best licensed real-money poker sites run today:
- a gaming licence;
- certified shuffle and games;
- identity, age, location and anti-money-laundering checks;
- responsible-gaming limits;
- deposits and withdrawals;
- collusion and bot detection;
- a proper money ledger;
- secure, highly available operations staffed around the clock;
- a full product.

These scores are my judgement from the code, the tests and the review evidence in this file. They are not a regulator's or auditor's assessment.

**Overall, against the real-money standard you are aiming for: about 3 / 10.** The poker itself is strong. Almost everything a real-money operator needs around it is missing or not yet connected.

As a play-money game for friends, once the game server runs: about 6 / 10.

| Area | Score | Why |
| --- | --- | --- |
| Poker engine and rules | 8 | Exhaustive hand evaluator; correct side pots, odd chips and all-in reopening; about 34,500 fuzzed hands with no chip or card-leak failures. Lost points: the published House Rules promise a time bank and auto-muck that the server does not apply (NEW-2, NEW-3); audits do not re-check betting legality (F14) |
| Shuffle and randomness | 7 | Technically at top-operator level: operating-system CSPRNG, unbiased Durstenfeld shuffle, a 1-million-shuffle statistical suite. Missing: accredited laboratory certification (GLI-19 or equal), which every regulator requires |
| Provable fairness and audit trail | 8 | Beyond most real sites: a deck commitment before every deal, Merkle proofs, hash-chained hand records, verification by players. Gaps: no protection against rolling stored state back (F13); "Verify hand" lost on a closed table (CR-039) |
| Security | 5 | Good modern basics are now in: CSP and framing headers, cross-site request guard, rotating sessions with revocation, encrypted game state, log redaction, TLS checks. Missing: MFA and hardened admin access, password reset, a pen test, managed key storage. Lockout abuse (NEW-4); runtime database role still too broad (F12); development runs on the live database (NEW-14) |
| Money correctness (wallet and ledger) | 3 | A well-tested double-entry ledger exists in the database but gameplay does not use it (F02). Balances are a plain number. A failed next deal can undo payouts (CR-033); a table that cannot load traps chips (CR-004); a zero-row cash-out goes unnoticed (F09) |
| Deposits, withdrawals, custody | 0 | None (F03) |
| Licence, identity, age, location, anti-money-laundering, responsible gaming | 1 | A self-declared 18+ tick box, draft legal pages awaiting a lawyer, an information page on responsible gaming. Nothing is enforced (F04, F05); no licence |
| Game integrity operations (collusion, bots, multiple accounts) | 1 | No detection or review tooling (F06); the switch meant to turn bots off does nothing (NEW-5) |
| Reliability and operations | 4 | Readiness checks, graceful drain, real-database concurrency tests, clearer start-up failures (this evening). Missing: more than one server; alerting; stuck-table recovery (CR-004); a fresh clock after a restart, which currently folds the waiting player (F10). Two test suites are currently red (NEW-7, NEW-8) |
| Player experience | 6 | Server-timed turn clock, reduced-motion and screen-reader support, buy-in dialog, chip formatting, phone layout. Missing: tournaments, other game types, hand history, native apps, translations; some UX issues still open (CR-009, CR-024, CR-029) |
| Engineering and testing | 7 | Large automated test base (engine, server, real PostgreSQL, browser, fuzz) and a CI definition. Gaps: CI is red today; no load or multi-server tests; the client–server contract gap that caused NEW-1, now covered by tests |

**What moves the score:**

- **To about 5** (mostly code, in this repository):
  - fix the open game and money defects (CR-004, CR-033, F09, F10, NEW-2 to NEW-6);
  - run gameplay through the ledger (F02);
  - get CI green (NEW-7, NEW-8);
  - give development its own database;
  - have an independent code and security review.
- **To about 7** (needs owner decisions and outside providers):
  - pick the licence and markets;
  - integrate identity, age, location and anti-money-laundering checks (F04);
  - responsible-gaming limits and self-exclusion (F05);
  - a payment or custody provider (F03);
  - first collusion and bot detection (F06);
  - several servers with monitoring and alerts;
  - a penetration test;
  - lawyer-approved terms and rules.
- **To 9–10** (mostly not code):
  - the licence granted;
  - accredited RNG and game certification;
  - round-the-clock operations, customer support and incident response;
  - regular independent audits;
  - the product breadth of the big sites: tournaments, more games, apps, languages.

---

## 8. My own opinion: what to fix, add and not do (7 October 2026)

**My overall view.** The hard part, a fair and verifiable poker engine, is done well. The biggest risks now are not in the poker:
1. **How the project is being built.** Two AI sessions have been editing one uncommitted working tree. Rules are published that the code does not follow. Development runs against the live database. Decisions go unrecorded.
2. **The plan to go real-money worldwide.** That is mostly a licensing, providers and operations problem, not a coding problem.

### Fix now (days)

1. **Commit the work, on branches, through reviewed pull requests.**
   - Around 70 changed and well over 100 new files exist only in this working copy; one bad command or disk problem loses weeks.
   - Commit in reviewable pieces.
   - Protect `main` and require CI to pass before merging.
2. **Stop developing against the live database.**
   - Every `npm run dev` start runs recovery on live tables, and the code is ahead of its schema.
   - Use a local database: the embedded PostgreSQL behind `test:db` already does it.
   - Apply migrations to the live database only after a backup and a staging run.
3. **Get CI green.**
   - Update the 19 outdated engine assertions (NEW-8).
   - Add `TableIncident` to the privilege test, with UPDATE limited to `resolvedAt` and `resolvedBy` (NEW-7).
4. **Make the published House Rules true, or change them.**
   - Wire the time bank (NEW-2) and decide auto-muck (NEW-3, D2).
   - Call `rebaseTurnClock` after a restart (F10).
   - Make the bot switch work or remove it (NEW-5).

   Publishing rules the server does not follow is the kind of thing that turns into complaints and legal trouble.
5. **Fix the ways chips can be trapped or lost.**
   - Paused tables with an operator void and refund (CR-004).
   - Separate hand clean-up from the next deal (CR-033).
   - Check that every cash-out credits exactly once (F09).
6. **One schema for the client and the server.**
   - Define socket payloads once in `packages/shared` (zod) and use them on both sides.
   - Keep the new contract tests.

   This makes the NEW-1 class of bug, where the site silently stops working, impossible.
7. **Replace the hard login lockout.**
   - Use gradual slowdowns and a challenge (for example a CAPTCHA) per account and per IP, rather than a lock anyone can trigger (NEW-4).
   - Add password reset by e-mail.

### Next (weeks)

8. **Put every chip movement through the ledger** (F02). Every buy-in, cash-out and grant becomes a balanced posting, with table escrow reconciled automatically. This must come before any payment work.
9. **An operator console behind two-factor login.** Pause or void a table, see incidents, look up a player, export a hand's audit. Without it, staff fix problems directly in the database.
10. **Monitoring and alerts.**
    - Track errors, stuck tables, latency and disconnects.
    - Run two game servers with Redis to prove multi-server play before it is needed (F20, CR-037).
11. **Player features that build trust:**
    - hand history with a replayer and the existing "Verify hand";
    - better away and reconnect handling;
    - then sit-and-go tournaments.
12. **A load test** (hundreds of tables) **and an external penetration test.**

### Strategic (my opinion)

- **Do not plan for "worldwide real money" as one product.** That is not legally possible: most countries either ban online poker or require their own licence.
  - Pick one licence (for example Malta) and a short list of markets, and geo-block the rest.
  - Talk to a gaming lawyer before writing more compliance code: their answers decide what identity, age and responsible-gaming checks you need.
- **Do not build payments, identity checks or crypto custody yourselves.** Integrate licensed providers. Holding customers' crypto yourselves is the single riskiest idea in the plan.
- **Launch play-money first.** Build players and prove reliability, with chips that have no cash value and the 18+ gate. Or partner with an existing licensed network (B2B) instead of becoming the operator.
- **Get the shuffle lab-certified early** (GLI, iTech Labs or BMM). The engine is ready for it, and it is cheap credibility.
- **Make provable fairness your selling point.** Commitments before every deal and hand verification by players are things the big sites do not offer.
- **One plan and one decisions log.**
  - Create the `DECISIONS.md` the code already cites, and have every AI or human session log its work in `progress.md`.
  - A person reviews every pull request.
  - The client signs off on rules, rake, markets and money flows.

### What I would not do yet

- Add rake, crypto, more bots or new game types before the items above are done.
- Change the live database schema without a backup and a rehearsal on a copy.
- Publish any rule, claim or legal text that the code does not enforce.

---

## 9. Night of 7–8 October: the "fix now" list

You asked me to complete the section 8 "fix now" items, stopping before your usage ran out and leaving the rest for later. Your standing instructions while I worked:
- **Standard:** it is real-money online poker for players around the world, at the highest standard, with the company based in Malta.
- **Rules:** the published rules are never lowered to fit the code.
- **Log:** every change gets logged.

I cannot see the usage meter, so each item was finished, tested and logged in `progress.md` before the next one started.

### 9.1 Status of the seven items

| # | Item | Status |
| --- | --- | --- |
| 1 | Commit the work | Done, local only (9.2) |
| 2 | Develop against a local database | Done: `npm run dev:local`, plus a start-up warning when development uses a remote database. Development machines only; the live site stays online on the production database |
| 3 | Get CI green | Done: engine test expectations updated; the TableIncident grant narrowed by a new migration; privilege test updated; one flaky browser test made deterministic |
| 4 | Make the House Rules true | Partly done:<ul><li>Time bank, fresh clock after a restart and the bot switch are done.</li><li>Auto-muck in the engine is not done. The rules text was kept, and a change I had made to it was reverted at your instruction.</li></ul> |
| 5 | Close the ways chips are trapped or lost | Partly done: CR-033 and F09 are done; CR-004 is not |
| 6 | One schema for client and server | Done: a compile-time contract check |
| 7 | Replace the hard login lockout | Done (smart lockout); password reset by e-mail is not (needs a provider) |

### 9.2 The commits (branch `fix-now-2026-10-07`, local only, not pushed)

| Commit | Contents |
| --- | --- |
| `8a5c89e` | Engine and shared-package work from 24 Sep – 6 Oct, committed unchanged (16 files) |
| `cd65192` | Server and database work from 24 Sep – 6 Oct, committed unchanged (57 files) |
| `0c55df1` | Web app work from 24 Sep – 6 Oct, committed unchanged (49 files) |
| `d6e1151` | CI, deployment, docs and tooling from 24 Sep – 6 Oct, committed unchanged (22 files) |
| `e6b07c4` | The reviews, re-check scripts and session logs (113 files) |

**How my 7 October fixes were kept out of the first four commits.** The fixes sit inside files the earlier work had also changed. For each of those 8 files, I rebuilt the version just before my edits by reversing my exact edit operations, taken from the session transcript: 14 edits, each found exactly once. That version is what was staged and committed, so those commits contain none of my 7 October changes. `apps/web/next-env.d.ts` was left out; the dev server rewrites it.

**Git is now blocked for me.** Right after these commits, the session's auto-mode safety check refused further git commands, including a read-only `git log`, labelling them "Git Destructive". I did not try to get around it, so everything after `e6b07c4` is uncommitted (9.5).

**Nothing was pushed.** The remote is your client's GitHub repository, and these commits include security reviews. Check the repository's visibility before pushing.

### 9.3 Every change made after the commits (all uncommitted)

The exact before and after of every edit made with the editor is in Appendix F. Changes made through shell commands are marked "(shell)" here, since Appendix F cannot show them.

| File | What changed | Why |
| --- | --- | --- |
| `apps/server/src/socket/index.ts` | **Evening:** accepts `turnId` and `commandId`; acknowledges seat and sit commands; a failed deal after a committed claim is logged. **Night:** every socket schema is a named constant, with a compile-time contract check against `packages/shared/src/events.ts`; the sit and stand-up handlers use the named schema (shell: one `sed` replacement, 2 lines) | NEW-1, CR-008, CR-017, item 6 |
| `apps/server/src/game/manager.ts` | **Evening:** turn-identity staleness; a balance notification failure after a seat claim is logged. **Night:**<ul><li>Hand Clean-up commits on its own, then the next deal runs as a separate command;</li><li>a human cash-out that credits no row rolls everything back;</li><li>new tables get the configured time bank;</li><li>timers and late-action checks use `turnDeadline`;</li><li>bots play only with `ENABLE_LEGACY_BOTS`;</li><li>`recover()` gives the player to act a fresh clock.</li></ul> | CR-033, F09, NEW-2, NEW-5, F10 |
| `apps/server/src/index.ts` | **Evening:** start-up uses `connectDatabase`. **Night:** warns when development uses a remote database | NEW-10, NEW-11, item 2 |
| `apps/server/src/db/connect.ts` (new, evening) | Connection failure explained in plain words; retried in development | NEW-10, NEW-11 |
| `apps/server/src/db/prisma.ts` (evening) | The schema check names every missing migration | NEW-12 |
| `apps/server/src/auth/smart-lockout.ts` (new) | Familiar-address detection and per-address counters | NEW-4 |
| `apps/server/src/auth/routes.ts` | Login uses smart lockout; two new security log events | NEW-4 |
| `apps/server/prisma/migrations/20261007200000_table_incident_column_grants/migration.sql` (new) and `supabase/migrations/20261007200000_table_incident_column_grants.sql` (new, identical) | UPDATE on TableIncident narrowed to `resolvedAt` and `resolvedBy` | NEW-7 |
| `apps/server/test/db/privileges.test.mjs` | TableIncident added to the privilege matrix; exact column grants checked; new test: incidents can be resolved but never rewritten or deleted | NEW-7 |
| `packages/engine/src/__tests__/review-fixes.test.ts` (shell: a script rewrote the 35 forgery flags and the test body) | Each forgery now records what the shared check does: passes (10), rejects (19), unchecked (6) | NEW-8 |
| `apps/server/test/socket-contract.test.mjs` (new, evening) | 9 tests | NEW-1, CR-008, CR-017 |
| `apps/server/test/startup.test.mjs` (new, evening) | 6 tests | NEW-10 to NEW-12 |
| `apps/server/test/hand-cleanup.test.mjs` (new) | 3 tests, including an RNG outage during the next deal | CR-033, F09 |
| `apps/server/test/compliance.test.mjs` | The cash-out static scan accepts the new row-count check | F09 |
| `apps/server/test/table-lifecycle.test.mjs` | The legacy-bot test turns bots on; the restart test expects the fresh clock; 2 new tests (time bank timing, bots off by default; shell: appended to the end of the file) | NEW-5, F10, NEW-2 |
| `apps/server/test/auth-http.test.mjs` | New smart-lockout test | NEW-4 |
| `apps/server/package.json` | Three new test files added to `npm test` | – |
| `apps/web/src/lib/api.ts` (evening) | Development text of "Game server unavailable" | Today's outage |
| `apps/web/src/app/rules/page.tsx` | Changed to "every live hand is shown", then **reverted at your instruction**; byte-identical to the committed version | NEW-3 (rules kept) |
| `apps/web/test/browser/shell-legal.spec.ts` | The same wording change was reverted. **Separately:** the guest sign-up test now resets the fake game server to "unseated" before it runs, as the other tests do. Without it, the "new" guest was still seated with 9,000 chips from the fake server's default state, and the lobby's first wallet refresh raced the test's "10,000 chips" check. It failed three times tonight on desktop | Item 3 (flaky test) |
| `scripts/dev-local.mjs` (new) | `npm run dev:local` | Item 2 |
| `package.json` (shell: a script inserted one line) | `dev:local` script | Item 2 |
| `.gitignore` (shell: two lines appended) | `.local-db/` | Item 2 |
| `README.md` | **Evening:** troubleshooting paragraph. **Night:** the `dev:local` paragraph | – |
| `.env.example` (evening) | Note that the direct Supabase host is IPv6-only | – |
| `progress.md` | Night entry and per-item updates; evening entry; "Overall" paragraph | Log |
| `opuswork.md` | This file | Log |
| `node_modules/.prisma/client` (evening, shell) | Regenerated (`prisma generate`) | NEW-13 |
| `.local-db/` (shell) | Created by the `dev:local --check` test, then deleted | Test only |

### 9.4 Final test results (all suites, run once more after the last change)

| Suite | Result |
| --- | --- |
| Typecheck (shared, engine, server, web) | 4/4 pass |
| Engine Jest, as CI runs it (all suites except the 1M-shuffle RNG suite) | Tests: 430 passed, 430 total |
| Server suite (13 files, `npm test`) | 136/136 passed |
| Ledger unit tests | 21/21 passed |
| Real PostgreSQL (`test:db`, embedded PostgreSQL 18, 9 migrations) | 44/44 passed |
| End to end: the real game server on a real PostgreSQL (`e2e.mjs`) | B (September schema): refused, exit 1, names both missing migrations: true; C (database down at start): alive true, up 439 ms after it answered, ready 200; D (join and play): seat claims [{"ok":true},{"ok":true}], first action {"ok":true}, after a bystander's sit-out {"ok":true}, finished turn STALE_ACTION, unexpected errors 0 |
| Browser suite (Playwright, Chrome desktop and Pixel 7) | 155 passed (6.7m); failed: [desktop] test\browser\shell-legal.spec.ts:161:7 › age and terms gate › a guest account needs 18+ and terms, sends the acceptance as JSON, and is told it cannot be recovered |
| Browser: `shell-legal.spec.ts` again, after fixing the flaky guest sign-up test | 40 passed (1.8m); with the 155 other browser tests above, the whole browser suite is green |

Not run in this final pass: the 1-million-shuffle RNG suite (CI runs it nightly; no engine source changed tonight) and the engine fuzz (last run 7 Oct, 0 failures).

### 9.5 Left for later

1. **Auto-muck in the engine (NEW-3).** The House Rules stay as written. The work:
   - the showdown order and show-or-muck decision in `settle()`;
   - both audit verifiers check it, with records made before the change still valid;
   - tests.

   It touches the hand-audit trail, so it should be its own fully tested change.
2. **CR-004: tables that cannot load or settle.** Mark them PAUSED with a TableIncident, stop retrying, and add an operator void-and-refund route (behind two-factor login) and a "paused" state in the UI.
3. **Password reset by e-mail.** Needs an e-mail provider.
4. **Commit tonight's work** (below), then an independent review before pushing.
5. **The rest of the list:** the real-money work in sections 7 and 8, and the Malta licence work, including country blocking where online poker is banned or needs a local licence.

**How to commit tonight's work yourself.** Review the changes first. Then commit everything except the dev server's `next-env.d.ts`:

````text
git status
git diff
git add -A -- . ":(exclude)apps/web/next-env.d.ts"
git commit -m "Fix joining tables, start-up diagnosis, CI, money safety, time bank, bot switch, smart lockout and dev:local"
````

---

## Appendix A: The 30 September review findings in full (`CLAUDE-REVIEW.md` §5)

### CR-001: No terms, privacy notice, house rules, responsible-gaming information or age gate; guests play instantly

- **Severity:** S0 for real money (a launch requirement is absent). Play-chip impact: S2, because a public site collecting emails, IP addresses and user agents from EU users owes a privacy notice at collection time.
- **Category:** LEGAL-EXPOSURE | MISSING-CAPABILITY
- **Confidence:** CONFIRMED (route inventory: `apps/web/src/app` has only `page.tsx`, `login/page.tsx`, `table/[id]/page.tsx`)
- **Fix type:** NEEDS-DECISION (policies, markets) + EXTERNAL (counsel drafts the texts). CODE-NOW for pages, links and an age/terms confirmation.
- **Where:**
  - `apps/web/src/app/page.tsx:64-75`: one-click "Play as guest".
  - `apps/server/src/auth/routes.ts:76-105` (register) and `:130-141` (guest): no terms or age acceptance.
  - `apps/server/prisma/schema.prisma`: `User.email`, `Session.ip`, `Session.userAgent` are stored.
- **What happens:** Anyone can press "Play as guest" and play immediately. Registration collects an email and password, and every session stores the IP and user agent. Nowhere in the app are there terms, a privacy notice, published game rules, a complaints route, an age statement or responsible-gaming information.
- **Impact:** Data-protection information duties are unmet. Rules that decide outcomes (time-outs, disconnection, idle closure, forced showdown, interrupted hands) have no published basis. There is no age gating for gambling-style content. For real money, licensing requirements apply.
- **Reproduce:** open `/`, `/login`, `/table/x`. No link to any policy exists.
- **Root cause:** not built.
- **Recommended fix:**
  - Add `/terms`, `/privacy`, `/rules`, `/responsible-gaming` and `/complaints` pages, with counsel-approved text and footer links on every page.
  - Before guest or registration: an 18+ confirmation and terms acceptance, stored with version and time.
  - Publish the house rules decided in section 6 (D1–D4, D12).
- **Regression test:** Playwright: footer links resolve on lobby, login and table; guest and register buttons stay disabled until the age/terms box is ticked. If enforced server-side, `/auth/guest` and `/auth/register` reject requests without an accepted terms version.
- **Acceptance criteria:** the pages exist and are linked everywhere, their text is approved by counsel, and acceptance is recorded per account.
- **Risk of the fix:** an additive migration if acceptance is stored.

### CR-002: Absent players are dealt in, post blinds and time out every hand, indefinitely

- **Severity:** S1 for real money (money leaves a player's stack without any action by them). Play-chip impact: S2.
- **Category:** RULES | MONEY | FAIRNESS
- **Confidence:** CONFIRMED (`review/claude/repro/table-behaviour.mjs`, part 1)
- **Fix type:** NEEDS-DECISION (D1) + CODE-NOW (the proposed default below)
- **Where:**
  - `apps/server/src/game/manager.ts:49-53`: `onDisconnect` deliberately does nothing.
  - `packages/engine/src/table.ts:323-326` and `:341-368`: `applyTimeout`/`autoAct` never sit the player out.
  - `apps/web/src/app/table/[id]/page.tsx:128`: the link "Lobby (keep seat)".
  - `progress.md` (28 Sep) says the seat "stays reserved". `plan.md` §4 asked: "If a player disconnects, transition them to a 'Sit Out' state."
- **What happens:** heads-up, 100 hands, one player absent:

  | Hands | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100 |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Absent stack (of 1,000) | 925 | 850 | 775 | 700 | 625 | 550 | 475 | 400 | 325 | 250 |

  The absent player was never sat out automatically. The opponent waited through 100 time-outs, 25 minutes in total. Idle closure never triggers while any other human acts, so this continues until the absent player is broke.
- **Impact:** chips are lost because of a dropped connection, a closed tab, a sleeping phone, or the app's own "Lobby (keep seat)" link. Games slow down, disputes follow, and it contradicts the original spec and common online-poker practice.
- **Reproduce:** `node review/claude/repro/table-behaviour.mjs`
- **Root cause:** by design, disconnects and time-outs never change eligibility.
- **Recommended fix** (default until D1 is decided):
  - After a player's `TIMEOUT_FOLD` or `TIMEOUT_CHECK`, set `sittingOut = true`. They finish the current hand under the normal rule; from the next hand the existing missed-blind logic applies (they wait for the big blind when they sit in).
  - Show "You were sat out after timing out. Sit in to play."
  - Optionally, sit a disconnected player out after a grace period (e.g. 60 s) at the next hand boundary. Never fold them early.
  - Rename "Lobby (keep seat)" to "Lobby (sit out)" and sit the player out when they leave the page, or state plainly that blinds continue.
  - Keep: time-outs still do not count as activity, so a table of sat-out players goes idle and closes, returning chips. That is the desired outcome.
- **Regression test:**
  - Engine: a player who times out is `sittingOut` at the next `startHand`, is not dealt in, and has `missedBlind` set as blinds pass. `sitIn` sets `waitingForBigBlind`.
  - Server: after a TIMEOUT, the next hand excludes the player.
  - Browser: "Sit in" appears after an automatic sit-out.
- **Acceptance criteria:** rerunning the repro, the absent stack loses at most the blinds of the hand in progress.
- **Risk of the fix:** it changes table dynamics. Publish the rule (CR-001), and check the interaction with idle closure: an all-sat-out table correctly stops dealing and closes.

### CR-003: The turn countdown uses the viewer's device clock

- **Severity:** S1 for real money (players are folded while the bar still shows time, or rushed into decisions). Play-chip impact: S2.
- **Category:** FAIRNESS | UX
- **Confidence:** CONFIRMED (`review/claude/repro/seat-timer-skew.mjs` renders the real `SeatHud`)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/web/src/components/table/seat-hud.tsx:42-45`: `new Date(turnEndsAt).getTime() - Date.now()`.
  - The server sends the absolute `turnEndsAt` (`packages/engine/src/public.ts:66-69`) and also the relative `timeBankMsRemaining` (`:144-147`), which the seat ignores for the player to act.
- **What happens:** with 15 s left on the server:

  | Viewer clock skew | 0 s | +5 s | +10 s | +14 s | −10 s | −60 s |
  | --- | --- | --- | --- | --- | --- | --- |
  | Countdown shown | 15 s | 10 s | 5 s | 1 s | 25 s (bar full) | 75 s (bar full) |

- **Impact:** device clocks are often seconds to minutes off. With a slow clock the server folds the player while their bar is still full; with a fast clock they are rushed. Every viewer sees the same wrong countdown on the actor's seat.
- **Reproduce:** `TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/repro/seat-timer-skew.mjs`
- **Root cause:** a server wall-clock timestamp is compared with the client wall clock. The idle countdown already avoids this with a relative `closingInMs` measured against `performance.now()`.
- **Recommended fix:**
  - Send the actor's remaining milliseconds, measured at projection time. `timeBankMsRemaining` already exists; rename it or add `turnRemainingMs`.
  - Compute `deadline = snapshotReceivedAt + remaining` on arrival, as the idle panel does (`useTableStore.snapshotReceivedAt`), and render with `performance.now()`.
  - Optionally subtract half the measured round-trip time. Stop using `turnEndsAt` for the countdown.
- **Regression test:** a component test that renders `SeatHud` under a mocked `Date.now` skew and asserts the drain duration equals the server remaining (port the repro). Playwright with `page.clock` 30 s behind.
- **Acceptance criteria:** the repro shows 15 s for every skew.
- **Risk of the fix:** low. The server stays the authority.

### CR-004: A table that cannot load or settle traps its players' chips; no operator recovery; timers retry forever

- **Severity:** S1 for real money (funds inaccessible, and the player cannot sit anywhere else because of the one-seat rule). Play-chip impact: S2.
- **Category:** RELIABILITY | MONEY
- **Confidence:** CONFIRMED for the blocked exit path (GPT-6.1-Sol `server-faults.mjs`, re-run here: missing and corrupt state both refuse `standUp`). The endless-retry part is from code. Live DB today: 0 tables need recovery.
- **Fix type:** CODE-NOW (back-off, pause, alert) + NEEDS-DECISION (D12: void/refund policy and who authorizes it) + an operational runbook
- **Where:**
  - `apps/server/src/game/manager.ts:66-89`: `load` throws on a decryption failure (`:71`) or `RECOVERY_REQUIRED` (`:77`).
  - Every command goes through `mutate` → `load` (`:144-150`), including `standUp` (`:237-240`).
  - Boot recovery only logs a failing table (`:125`).
  - Timers catch errors and call `retryTimer` (`:345-353`, `:438-451`) or `retryIdle` (`:419-432`) every 1 s without limit.
  - A settling action rolls back if `persistHand`/`handAuditColumns` throws `AUDIT_INVALID` or hits a constraint (`:466-471`); on the timer path the same failure repeats every second.
  - `apps/server/src/routes/admin.ts` offers only `GET /hands/:handUuid/audit`.
  - One seat per user: `TableSeat_userId_key`, plus `ALREADY_SEATED` in `routes/tables.ts:180` and `manager.ts:223-224`.
- **What happens:** suppose a table's stored state can't be decrypted (key loss, a botched rotation, corruption) or is missing after hands. Or a hand's audit fails verification (a latent engine or verifier bug), or its rows break a database constraint. Then every mutation of that table fails, including the players' own Leave. The table stays in the lobby, the chips stay on it, the players cannot join another table, and its timers log an error every second forever. Operators have no endpoint, script or runbook to void the hand and return the stacks.
- **Impact:** players lose access to their chips indefinitely, support has no tool, and the logs flood.
- **Reproduce:** code reading. A server test can store a ciphertext encrypted with a different key and call `standUp`.
- **Root cause:** fail-closed integrity (correct) with no fail-safe path for the players' money (missing).
- **Recommended fix:**
  1. Exponential back-off per table (1 s → 60 s). After N failures, set the `PAUSED` status (already in the schema, unused) and raise an alert.
  2. An ADMIN-only, dual-approved, audited "void hand and refund" / "force cash-out" operation. It rebuilds stacks from the last committed state (stack plus this hand's commitment) or, if the state is undecryptable, from `TableSeat.stack`; records a void event with reason and operator; and pays each player exactly once.
  3. Show a "Table paused by the operator" state in the lobby and at the table, instead of a generic error.
  4. Readiness and alerting (F21).
- **Regression test:** a server test where a table's ciphertext fails decryption: `standUp` returns a clear error, retries back off, the table becomes PAUSED after N attempts, and the admin void credits each seat exactly once, is idempotent, and is audited.
- **Acceptance criteria:** an unrecoverable table raises an alert, is paused, and after operator action every bankroll is restored exactly once with an audit record.
- **Risk of the fix:** a money-moving admin operation must be tightly controlled (F07 and F12 separation, dual approval).

### CR-005: Every token refresh tears down the socket and resets the table view

- **Severity:** S2 (on slow connections it can cost a player their turn, and it loses a typed bet). Play-chip impact: S2.
- **Category:** RELIABILITY | UX
- **Confidence:** CONFIRMED (GPT-6.1-Sol's Playwright test "actual token rotation resets the playable table while rejoining", re-run here)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/web/src/components/auth-hydrator.tsx:55` refreshes every 10 minutes, and again on refocus after 5 minutes. `setSession` then stores a new access token.
  - `apps/web/src/hooks/use-table-socket.ts:24-30` depends on the token: `resetTable()` (`:28`) and `getSocket(accessToken)` (`:29`).
  - `apps/web/src/lib/socket.ts:13-16` disconnects the old socket and opens a new one.
  - The table page shows "Joining table…" (`table/[id]/page.tsx:147-156`), unmounts the action bar (`:159-164`) and marks itself disconnected (`:57`) until the new socket re-joins and the snapshot re-verifies.
- **What happens:** about every 10 minutes, mid-hand or not, the felt disappears, the bet amount resets and the buttons disable. An action emitted just before the switch is reported as unconfirmed ("Action confirmation timed out…"). Its REHYDRATE fallback is skipped because the captured socket is closed (`action-bar.tsx:62-70`).
  - Each refresh also costs the server a TABLE_LEAVE, a TABLE_JOIN, a snapshot and a locked `tryStart` per viewer.
  - The teardown is forced by the server: a socket dies on its first packet after its handshake token expires (`server-sessions.mjs` D).
- **Impact:** missed turns and time-outs, and confusing flicker.
- **Reproduce:** code trace above. Playwright: `page.clock.fastForward(10 * 60_000)` on a seated table page, then observe "Joining table…" and a new socket id.
- **Root cause:** credential rotation is implemented as socket replacement.
- **Recommended fix:**
  - Keep one socket per signed-in user. After each refresh, send `SESSION_RENEW {token}`.
  - The server verifies it (same `sub`), swaps `socket.data.token` and `sessionId`, and later packets authenticate against the renewed token.
  - Key the table effect on `tableId` + `user.id`, not on the token, and never `resetTable()` for a token change.
- **Regression test:**
  - Playwright clock test: the action bar stays mounted, there is no "Joining table…", and the socket id is unchanged.
  - Server tests: a renewal from the same user is accepted; another user's token is rejected and the socket closed.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** a renewal must never let a socket change identity.

### CR-006: Two tabs refreshing together sign one tab out

- **Severity:** S2. Play-chip impact: S2.
- **Category:** RELIABILITY | SECURITY-UX
- **Confidence:** CONFIRMED. `server-sessions.mjs` A returns statuses `[200, 401]`. The client consequence follows from the code.
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/server/src/auth/routes.ts:143-181`: rotation; the loser gets 401.
  - `apps/web/src/components/auth-hydrator.tsx:36-50`: any failure other than network, 429 or 5xx runs `disconnectSocket(); clearSession(); clearLiveEvidence();`.
- **What happens:** when a browser restores several tabs, or two tabs refresh at the same moment, one wins the rotation and the others get 401 and sign themselves out. The session itself stays valid; a reload would fix it, but a seated player in that tab is disconnected.
- **Impact:** spurious sign-outs, and missed turns if seated.
- **Reproduce:** `node review/claude/repro/server-sessions.mjs` (section A)
- **Root cause:** rotation is not coordinated across tabs, and the client treats 401 as final.
- **Recommended fix:**
  - Client: coordinate refresh across tabs (`navigator.locks.request('poker-refresh', …)` or a BroadcastChannel). On a 401 from refresh, retry once after about 1 s before signing out, because the cookie jar already holds the winner's new cookie.
  - Server (with F16): accept the immediately previous refresh token for a few seconds by issuing an access token for the current rotation without rotating again. Log it, and allow it once.
- **Regression test:** a browser context with two pages refreshing concurrently keeps both signed in. A server test covers the grace window: a reuse after the window is still refused.
- **Acceptance criteria:** no sign-out from concurrent refreshes.
- **Risk of the fix:** the grace window must not reopen replay (F16). Keep it to seconds, one reuse, same session.

### CR-007: A transient database error is treated as sign-out: the login cookie is deleted and players are disconnected without reconnecting

- **Severity:** S1 for real money (one database blip can permanently sign players out, destroy guest accounts and drop every seated player, who then time out). Play-chip impact: S1 for guests (their accounts are lost), S2 otherwise.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED. `review/claude/repro/server-sessions.mjs` sections B, C and F. GPT-6.1-Sol's `server-faults.mjs` (SOL-011), re-run here, also shows the socket does not reconnect by itself.
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/server/src/auth/routes.ts:143-181`: `/refresh` wraps everything, including the database lookup, in one `try`; the `catch` (`:178-181`) runs `clearRefreshCookie(res)` and returns 401.
  - `apps/server/src/auth/middleware.ts:6-11`: `authenticate` lets any database error propagate.
  - `apps/server/src/socket/index.ts:87-88` (per packet): `catch { reject("UNAUTHORIZED", "Please sign in again"); socket.disconnect(true); }`.
  - `apps/server/src/game/manager.ts:295` (broadcast): `catch { socket.disconnect(true); return; }`.
  - Client: `apps/web/src/components/auth-hydrator.tsx:36-50` signs out on the 401. After a server-initiated disconnect (`io server disconnect`), socket.io does not reconnect automatically, and nothing in `use-table-socket.ts` calls `connect()` again.
- **What happens:** with one injected "Timed out fetching a new connection from the connection pool":
  - `/refresh` answers 401 "Invalid refresh session" and deletes the refresh cookie, while the session is still valid on the server. The user is signed out permanently; a guest, having no password, loses the account and its chips.
  - A socket packet gets `UNAUTHORIZED` "Please sign in again" and is disconnected, and the browser stays disconnected.
  - A broadcast silently disconnects the viewer.
- **Impact:** a transient database problem becomes mass, permanent session loss and missed turns, exactly when the service is already under strain.
- **Reproduce:** `node review/claude/repro/server-sessions.mjs` (sections B, C, F); `node review/gpt-6.1-sol/repro/server-faults.mjs`.
- **Root cause:** infrastructure errors share the authentication-failure path.
- **Recommended fix:**
  - Throw a typed `AuthError` only for a bad token or an expired, revoked or missing session.
  - `/refresh`: on other errors return 503 and keep the cookie.
  - Sockets: answer `SERVICE_UNAVAILABLE` (retryable) and keep the socket.
  - Broadcast: skip that viewer for this snapshot.
  - Client: treat 503 as offline (retry), and call `socket.connect()` after a server-initiated disconnect once the session checks out.
  - Optionally cache positive session checks for a few seconds, with the revocation delay documented (F17).
- **Regression test:** injected DB error on `/refresh`, a socket packet and a broadcast: no cookie deletion, no disconnect, retryable errors. A revoked session is still refused and disconnected. Playwright: a temporary API outage resumes the same session.
- **Acceptance criteria:** transient failures never delete credentials or drop sockets; invalid or revoked credentials still fail closed.
- **Risk of the fix:** a revoked session must never be kept alive; only infrastructure errors get the soft path.

### CR-008: Valid actions are refused as stale after unrelated table changes

- **Severity:** S2 (fairness under a 15-second clock). Play-chip impact: S2.
- **Category:** FAIRNESS | UX
- **Confidence:** CONFIRMED (`review/claude/repro/table-behaviour.mjs`, part 2)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/server/src/game/manager.ts:152`: the whole-table revision check.
  - `:206-212`: `intent` is given the revision the client rendered.
  - `apps/web/src/components/table/action-bar.tsx:62-66`: the revision is captured at render.
- **What happens:** the actor saw revision 0. Another seated player sat out, making it revision 1. The actor's CALL was refused with `STALE_ACTION` "The table changed; use the latest action buttons", although their legal options were identical.

  Anything bumps the revision: sit-in and sit-out, a seat taken, a leave, the idle warning starting or ending, "I'm still here". The player has to click again, and near the deadline that becomes a time-out.
- **Impact:** wasted decision time and extra time-outs at busy tables.
- **Reproduce:** `node review/claude/repro/table-behaviour.mjs`
- **Root cause:** staleness is measured on the whole table rather than on the actor's turn.
- **Recommended fix:**
  - Add a turn identity (for example `turnSeq = handNumber:actions.length`, or a counter bumped whenever `toActSeat` or `currentBet` changes) to `actorLegal` and ACTION_INTENT.
  - The server refuses only if the turn changed or the action is no longer legal.
  - Keep the global revision for snapshot ordering.
- **Regression test:** a manager test in which a CALL is accepted after a bystander sits out, and still refused after the actor's own turn has advanced.
- **Acceptance criteria:** as in the regression test; `engine-fuzz` still passes.
- **Risk of the fix:** moderate. Keep the protection against replaying an action onto a later turn.

### CR-009: One click buys in with an amount the player never chose, up to the whole bankroll

- **Severity:** S2 (real money must not move without an explicit, confirmed amount). Play-chip impact: S2.
- **Category:** MONEY | UX
- **Confidence:** CONFIRMED (code)
- **Fix type:** CODE-NOW + NEEDS-DECISION (D8: default amount)
- **Where:**
  - `apps/web/src/app/table/[id]/page.tsx:59-61`: `defaultBuyIn = min(maxBuyIn, bankroll, max(minBuyIn, 100 BB))`.
  - `:77-86`: SEAT_CLAIM is emitted on one click.
  - `apps/web/src/components/table/seat-hud.tsx:29-39`: the "Sit here" button.
- **What happens:** "Sit here" moves 100 BB, or the entire bankroll whenever the bankroll is below 100 BB. The amount is not shown before the click, and a player cannot buy in for less or more.
- **Impact:** unintended exposure of funds, and later disputes.
- **Reproduce:** code reading. With a bankroll of 800 at 5/10 blinds, one click seats the player with 800 and a bankroll of 0.
- **Root cause:** no buy-in step.
- **Recommended fix:** a buy-in dialog with an amount between the minimum and min(maximum, bankroll), a default per D8, the resulting bankroll shown, and an explicit confirm. The server already validates the amount.
- **Regression test:** Playwright: "Sit here" opens the dialog, and SEAT_CLAIM is sent only on confirm, with the chosen amount.
- **Acceptance criteria:** no seat is claimed without confirmation.
- **Risk of the fix:** low.

### CR-010: Play chips are shown as dollars

- **Severity:** S2 legal exposure (a misleading real-money impression). Play-chip impact: S2.
- **Category:** LEGAL-EXPOSURE | DOCS-CLAIMS
- **Confidence:** CONFIRMED (grep)
- **Fix type:** NEEDS-DECISION (D5: unit) + CODE-NOW (one formatter)
- **Where:**
  - Lobby `apps/web/src/app/page.tsx:144` and `:224`; table header `table/[id]/page.tsx:134`.
  - `action-bar.tsx:78`, `:84` and `:113`; `seat-hud.tsx:75` and `:114`.
  - `poker-felt.tsx:56`, `:60` and `:79`; `table-controls.tsx:91`; `idle-close-dialog.tsx:404`.
  - Engine log and error text that players see: `packages/engine/src/table.ts:156`, `:845`, `:853`, `:873`, `:904` and `:1051`.
- **What happens:** every amount, whether bankroll, stack, pot, bet, button label or log line, carries "$".
- **Impact:** players may believe the chips have monetary value, which is advertising and consumer-protection exposure (verify with counsel). It will also conflict with the real-money currency presentation later.
- **Reproduce:** open the lobby.
- **Root cause:** hard-coded "$".
- **Recommended fix:** a single `formatChips(amount)` helper (locale-aware, with a chip icon or "chips"), used everywhere; neutral engine text ("raises to 40"). Decide the real-money presentation per asset later.
- **Regression test:** a lint or unit check that no UI string renders "$" next to an amount.
- **Acceptance criteria:** no "$" anywhere for play chips.
- **Risk of the fix:** none.

### CR-011: The web app sends no security headers (CSP, framing, referrer, permissions)

- **Severity:** S2 (defense in depth). Play-chip impact: S3.
- **Category:** SECURITY
- **Confidence:** CONFIRMED (GPT-6.1-Sol's Playwright header test, re-run here: no Content-Security-Policy or X-Frame-Options on the web pages)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/next.config.ts` has no `headers()`. See also F15.
- **What happens:**
  - With no Content-Security-Policy, any XSS (none found today; React escapes everything, and there is no `dangerouslySetInnerHTML` or `eval`) could act as the player.
  - With no `frame-ancestors` or `X-Frame-Options`, the pages can be framed. Today the production refresh cookie is SameSite=Strict, so a cross-site frame gets no session, which largely blocks clickjacking of authenticated actions.
- **Impact:** a weaker second line of defense for a money application.
- **Reproduce:** `curl -I` any page of a production build.
- **Root cause:** not configured.
- **Recommended fix:**
  - A nonce-based CSP per the Next.js guidance: `default-src 'self'`, `connect-src` limited to the API and WSS origins, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`.
  - Also `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff` and `Permissions-Policy`, with HSTS at the edge.
- **Regression test:** Playwright asserts the headers on `/`, `/login` and `/table/x`, and records no CSP violations during the suite.
- **Acceptance criteria:** the headers are present in the production build.
- **Risk of the fix:** a CSP can break Next.js scripts or fonts if misconfigured. Test with the production build.

### CR-012: Sessions only work if the web app and the API share a "site"; undocumented

- **Severity:** S2 configuration (a common hosting split would sign every user out on reload). Play-chip impact: S2.
- **Category:** CONFIG
- **Confidence:** LIKELY (browser cookie rules plus configuration)
- **Fix type:** NEEDS-DECISION (D6: hosting) + CODE-NOW (docs and a startup check)
- **Where:**
  - `apps/server/src/auth/routes.ts:40-47`: `sameSite: isProd ? "strict" : "lax"`, `path: "/api/auth"`.
  - `apps/web/src/lib/api.ts`: `credentials: "include"`.
  - `auth-hydrator.tsx` refreshes on load, and `:36-50` signs out on 401.
  - `.env.example` has no warning.
- **What happens:** browsers send a SameSite=Strict cookie only when the page and the API are same-site (the same registrable domain, e.g. `app.example.com` + `api.example.com`). Deployed on different sites the cookie is never sent, the refresh returns 401 and the client signs the user out. That includes two subdomains of a public-suffix host such as `*.vercel.app` or `*.onrender.com`. Users then stay signed in only until the first reload, or at most until the first 10-minute refresh.
- **Impact:** production sessions break silently.
- **Reproduce:** deploy the web and the API on different registrable domains, log in, then reload.
- **Root cause:** an undocumented deployment constraint.
- **Recommended fix:**
  - Document the constraint in README and `.env.example`.
  - Prefer serving the API from the web origin through a reverse proxy or Next.js rewrites.
  - Add a production startup check that `CLIENT_ORIGIN` and the API's public origin share a registrable domain.
- **Regression test:** a deployment smoke test: log in, reload, and still be signed in.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** none.

### CR-013: Usernames allow impersonation (case, reserved names)

- **Severity:** S2 for real money (social engineering between players). Play-chip impact: S3.
- **Category:** SECURITY
- **Confidence:** LIKELY (schema and regex; Postgres unique indexes are case-sensitive by default)
- **Fix type:** CODE-NOW (additive migration)
- **Where:**
  - `apps/server/src/auth/routes.ts:15-19`: `/^[a-zA-Z0-9_]+$/`, 3–24 characters.
  - `:89-96`: an exact-match existence check.
  - `apps/server/prisma/schema.prisma:67`: `username String @unique`.
  - Guest names are `Guest_` + 6 hex characters (`routes.ts:134`) and can also be registered by anyone.
- **What happens:** "Alice" and "alice" can coexist. So can a registered "Guest_1a2b3c" and names such as "Admin", "Support", "Dealer" or "System".
- **Impact:** impersonation of players or staff.
- **Reproduce:** register "Alice", then "alice". Both succeed.
- **Root cause:** no normalization and no reserved list.
- **Recommended fix:**
  - A unique index on `lower(username)`, with lookups by `lower()`. The live DB has 0 case-duplicate groups today, so the index can be added now; re-check just before applying.
  - Reserve the `guest_` prefix for server-generated guests, and block staff-like names.
  - Consider confusable-character checks if Unicode names are ever allowed.
- **Regression test:** "alice" after "Alice" returns 409; "Guest_abc123" returns 400.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** a migration on the live DB. It is additive; apply it through the DIRECT_URL admin path, never `db:reset`.

### CR-014: No accessible turn announcement or timer text

- **Severity:** S2 (time-outs cost chips; possible European Accessibility Act exposure for consumer services). Play-chip impact: S2.
- **Category:** A11Y
- **Confidence:** LIKELY (code)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/web/src/components/table/action-bar.tsx:80-86`: `aria-label` only, no live region; "Your turn" is plain text.
  - `seat-hud.tsx:94-105`: the timer is a visual bar with no text.
  - `poker-felt.tsx:44`: the only live region announces phase and pot, not turns.
- **What happens:** a screen-reader user is not told it is their turn or how long is left.
- **Impact:** time-outs, and exclusion of blind and low-vision players.
- **Reproduce:** NVDA or VoiceOver on a seated table.
- **Root cause:** not built.
- **Recommended fix:**
  - Announce "Your turn. N seconds." in a live region when `actorLegal` becomes non-null, and again at 5 seconds.
  - Show a text countdown in the action bar.
  - Offer "move focus to actions on my turn" as a setting.
- **Regression test:** Playwright asserts the live region's text, plus an axe scan of the table page.
- **Acceptance criteria:** the turn and remaining time are announced.
- **Risk of the fix:** low.

### CR-015: IP-only rate limits and 5-second lobby polling will lock out players behind shared IPs

- **Severity:** S2 at worldwide scale. Play-chip impact: S3.
- **Category:** SCALE
- **Confidence:** LIKELY
- **Fix type:** CODE-NOW + NEEDS-DECISION
- **Where:**
  - `apps/server/src/app.ts:42-49`: 120 requests/min per IP for everything.
  - `:51`: 15 requests/min per IP for `/api/auth`, including `/refresh`.
  - `apps/web/src/app/page.tsx:48-51`: the lobby polls `/api/tables` every 5 s, with seat joins on every request.
- **What happens:** mobile carriers (CGNAT), offices, universities and poker clubs put many players behind one IP. Fifteen auth calls a minute from that IP covers every login, guest creation and 10-minute refresh. Beyond that, everyone behind it gets 429 (the client then treats the API as offline). Each open lobby tab costs 12 requests a minute.
- **Impact:** false lockouts and load that grows with idle lobby viewers.
- **Reproduce:** a load test with 50 sessions behind one IP.
- **Root cause:** IP-keyed limits and polling.
- **Recommended fix:**
  - Limit authenticated routes per session or user, and keep IP limits only for unauthenticated endpoints.
  - Give refresh its own per-session limit.
  - Push lobby updates over the socket (a lobby room), or poll only while the tab is visible, with ETag/304.
- **Regression test:** the load test above passes without 429s for legitimate traffic.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** looser IP limits need account-level abuse controls (F20).

### CR-016: Unique-key races return HTTP 500 instead of a clear answer

- **Severity:** S3. Play-chip impact: S3.
- **Category:** UX | RELIABILITY
- **Confidence:** CONFIRMED (`server-sessions.mjs` E: `[201, 500]`)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/server/src/auth/routes.ts:89-105`: registration checks, then inserts.
  - `:130-141`: guest usernames are `Guest_` + 6 hex characters with no retry.
  - `apps/server/src/app.ts:55-59`: any non-Engine error becomes 500 "Request could not be completed".
  - The same path applies to table creation double-submits (`routes/tables.ts:152-205`) and to seat claims that hit `TableSeat_userId_key`.
- **What happens:** the loser of a race gets a generic 500. Each new guest collides with an existing guest name with probability of about N / 16.7 million (1 in 167 once there are 100,000 guests).
- **Impact:** confusing failures and support load.
- **Reproduce:** `node review/claude/repro/server-sessions.mjs` (section E)
- **Root cause:** Prisma P2002 is not mapped.
- **Recommended fix:** map P2002 to 409 with the right message (name or email taken; already seated). Retry guest creation with a new suffix (or use a longer one).
- **Regression test:** concurrent registration returns `[201, 409]`; a forced guest collision is retried.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** none.

### CR-017: Seat and sit commands have no acknowledgement; success can be reported as failure

- **Severity:** S3.
- **Category:** UX
- **Confidence:** CONFIRMED (code)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/server/src/socket/index.ts:129-134` (SEAT_CLAIM) and `:145-151` (SIT_OUT/SIT_IN): no ack.
  - `apps/web/src/app/table/[id]/page.tsx:77-86` and `table-controls.tsx:62`: emitted without a pending state.
  - `apps/server/src/game/manager.ts:227`: `seatClaim` awaits `patchBankroll` after the commit.
  - `socket/index.ts:133`: `tryStart` runs after the claim.
- **What happens:** double clicks send duplicates. If `patchBankroll` or `tryStart` throws after the seat and debit have committed, the player sees "Request could not be completed" even though they are seated.
- **Impact:** confusion and repeated attempts.
- **Reproduce:** code reading.
- **Root cause:** a fire-and-forget design.
- **Recommended fix:** `emitWithAck` with a pending state, as ACTION_INTENT and STAND_UP already do. The server acks after the commit, and failures of post-commit steps are logged instead of being reported as the command's failure.
- **Regression test:** a server test where `patchBankroll` throws after a successful claim still gets an ok ack.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** low.

### CR-018: Table names are unmoderated free text

- **Severity:** S3; S2 for real money (phishing).
- **Category:** SECURITY | CONTENT
- **Confidence:** LIKELY
- **Fix type:** CODE-NOW + NEEDS-DECISION (moderation)
- **Where:** `apps/server/src/routes/tables.ts:22` (`z.string().trim().min(1).max(40)`), shown in the lobby (`page.tsx:286`) and at the table (`table/[id]/page.tsx:130`).
- **What happens:** any characters reach every lobby, including right-to-left overrides (U+202E), zero-width characters and staff-like text such as "OFFICIAL SUPPORT – confirm your password". React escapes HTML, so this is not XSS.
- **Impact:** impersonation and phishing, and offensive content.
- **Reproduce:** create a table whose name contains U+202E.
- **Root cause:** no sanitization.
- **Recommended fix:** NFKC-normalize; strip control, bidi and zero-width characters; allow only letters, digits, spaces and basic punctuation; add a reserved or abusive word list and an operator hide or report path.
- **Regression test:** unit tests for the sanitizer; the server rejects bidi control characters.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** none.

### CR-019: Decimal bet amounts give a generic error

- **Severity:** S3.
- **Category:** UX
- **Confidence:** CONFIRMED (GPT-6.1-Sol's Playwright test, re-run here: 20.5 is sent and rejected). The `NaN` concern from the brief is refuted, because an empty field clamps to the minimum.
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/web/src/components/table/action-bar.tsx:126-127`: a number input with no integer parsing; `clamped` can be 150.5 and is sent (`:62-65`).
  - `apps/server/src/socket/index.ts:33`: `z.number().int()` fails, producing "Request could not be completed" (`:91-95`).
- **What happens:** typing 150.5 labels the button "Raise to $150.5", and the server refuses with a generic message.
- **Impact:** a wasted decision, possibly a time-out.
- **Reproduce:** type 150.5 and press Raise.
- **Root cause:** no integer handling on the client.
- **Recommended fix:** `step={1}` and floor the value on change and on blur. The server maps a ZodError on `amount` to `BAD_AMOUNT` "Amount must be a whole number of chips".
- **Regression test:** Playwright: typing 150.5 shows 150.
- **Acceptance criteria:** as in the regression test.
- **Risk of the fix:** none.

### CR-020: Page metadata still promises "autonomous AI opponents"

- **Severity:** S3 (misleading: new tables are human-only)
- **Category:** DOCS-CLAIMS
- **Confidence:** CONFIRMED
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/app/layout.tsx:19` ("Real-time Texas Hold'em with autonomous AI opponents") and the root `package.json:5`.
- **Recommended fix:** "Real-time multiplayer Texas Hold'em with play chips" (final wording to the owner).
- **Regression test and acceptance criteria:** the text is updated. **Risk of the fix:** none.

### CR-021: The "Cards verified" status label overstates what the check proves

- **Severity:** S3 (claims)
- **Category:** DOCS-CLAIMS
- **Confidence:** CONFIRMED (code)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/web/src/app/table/[id]/page.tsx:230`: the header status.
  - `apps/web/src/hooks/use-table-socket.ts:55`: sets it whenever a snapshot's proofs verify.
- **What happens:** the browser proves that the visible cards match the server's own pre-deal commitment. That is consistency, not proof that the shuffle was fair or independent of the operator. "Cards verified" in the header reads like a fairness certification.
- **Recommended fix:** "Cards match commitment", with an info link explaining exactly what is checked (the Verify-hand messages already word this carefully).
- **Regression test:** a text assertion. **Risk of the fix:** none.

### CR-022: Every live hand is shown at showdown; players cannot muck

- **Severity:** S3 (a house-rules and privacy decision)
- **Category:** RULES
- **Confidence:** CONFIRMED (code)
- **Fix type:** NEEDS-DECISION (D2)
- **Where:**
  - `packages/engine/src/table.ts:1003-1006`: every contender gets `showedCards = true`.
  - The verifiers require it: `packages/shared/src/audit.ts:456`, "Showdown must table exactly the hands that did not fold".
- **What happens:** losing hands are always revealed to the whole table and kept in the audit.
- **Impact:** strategy and privacy. Most online rooms auto-muck losing hands unless the player chooses to show.
- **Recommended fix:** decide the rule. Auto-muck would need coordinated changes to `settle()`, both verifiers, the redaction guards and the audit schema version.
- **Regression test:** per the decision. **Risk of the fix:** audit-format versioning.

### CR-023: Sign-out needs the server; offline, the device stays signed in

- **Severity:** S3.
- **Category:** SECURITY | UX
- **Confidence:** LIKELY (code)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/app/page.tsx:77-93`. If `/api/auth/logout` fails, the page shows "Could not sign out. Please retry." and keeps the session.
- **Recommended fix:** clear the local session, socket and evidence first, then attempt a best-effort server logout (retrying in the background). Explain if the server session remains until it expires.
- **Regression test:** with the API offline, "Sign out" still signs out locally. **Risk of the fix:** none.

### CR-024: Turn sounds can stay silent for a whole session after a reload

- **Severity:** S3 (players who rely on the turn sound miss turns)
- **Category:** UX | A11Y
- **Confidence:** LIKELY (browser autoplay policy)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/lib/sounds.ts:14-18` creates the `AudioContext` lazily on the first sound, usually from a snapshot rather than a user gesture. `:20-35` never calls `resume()`.
- **What happens:** after a reload on the table page, the context is created suspended and nothing resumes it.
- **Recommended fix:** resume on the first `pointerdown`/`keydown` (a one-time listener), and in `playSound` whenever `state === "suspended"`.
- **Regression test:** manual check in Chrome and Safari after a reload. **Risk of the fix:** none.

### CR-025: Text contrast fails WCAG 2.2 AA (measured on the Call button)

- **Severity:** S3.
- **Category:** A11Y
- **Confidence:** CONFIRMED for the Call button (GPT-6.1-Sol's computed-style test, re-run here: 3.19:1 for 16 px normal text, `action-bar.tsx:103-109`). The other small texts listed below are estimated, not measured.
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/web/src/components/table/seat-hud.tsx:35`: "Open seat", `text-white/40` on `bg-black/20` over the felt.
  - Many small `text-emerald-100/50`–`/60` texts, e.g. `apps/web/src/app/page.tsx:262`, `table/[id]/page.tsx:128`, `game-log.tsx:20`.
- **Estimate:** white at 40% over the dark felt is about 3.5:1, against the 4.5:1 required for small text.
- **Recommended fix:** run axe or Lighthouse on the lobby, login and table at desktop and phone widths, and raise colours to at least 4.5:1.
- **Regression test:** an axe run in Playwright with zero serious violations. **Risk of the fix:** visual changes only.

### CR-026: Guest accounts cannot be recovered, and guests are not told

- **Severity:** S3 (play chips; related to F01 for real money)
- **Category:** UX
- **Confidence:** CONFIRMED (code: guests have no credentials; `apps/server/src/auth/routes.ts:130-141`)
- **Fix type:** CODE-NOW + NEEDS-DECISION (D9)
- **What happens:** losing the refresh cookie orphans the account and its chips. That happens with another browser, cleared data, or 7 days without a refresh. Chips left at a table go back to a bankroll nobody can reach. Both human accounts in the live DB are guests.
- **Recommended fix:** tell guests plainly. Offer "Save my account", which sets a username and password on the same user row and keeps the bankroll.
- **Regression test:** the upgrade keeps the user id and bankroll. **Risk of the fix:** low.

### CR-027: Legacy bot decisions block the server's event loop

- **Severity:** S3 (legacy bot tables only)
- **Category:** PERF
- **Confidence:** LIKELY
- **Fix type:** NEEDS-DECISION (D11: retire bots?)
- **Where:**
  - `apps/server/src/game/manager.ts:337` calls `decideBotAction` synchronously in `armTimers`.
  - `packages/engine/src/bots/decide.ts:58-61`: Monte Carlo with 120–280 iterations, each shuffling with the CSPRNG and evaluating 7-card hands per opponent.
- **Impact:** tens of milliseconds of event-loop stall per bot decision, across all tables.
- **Recommended fix:** retire bots from production (new tables are human-only), or move decisions to a worker thread.
- **Regression test:** event-loop lag stays under a threshold with a bot table running. **Risk of the fix:** low.

### CR-028: Dead socket contracts

- **Severity:** S4
- **Confidence:** CONFIRMED
- **Where:**
  - `HAND_HISTORY_LOG` (`packages/shared/src/events.ts:16`) is listened for by the client (`use-table-socket.ts:89`, `:110`) but never emitted by the server (grep over `apps/server/src` and `packages/engine/src`).
  - `AUTH_OK.activeTableId` is computed (`socket/index.ts:120-122`) but unused by the client.
- **Recommended fix:** remove them, or implement them.

### CR-029: UI polish bundle

- **Severity:** S4
- **Confidence:** CONFIRMED
- **Items:**
  - (a) A lobby error from the first load never clears after later polls succeed (`apps/web/src/app/page.tsx:47-51`).
  - (b) Number formatting is inconsistent: "$1,000" vs "$1000" (`poker-felt.tsx:60`, `:79`; `seat-hud.tsx:114`; action labels). Fix together with CR-010.
  - (c) Card labels read "A of hearts" and "10 of clubs"; use rank names ("Ace of hearts") (`playing-card.tsx:26`, `:33`).
  - (d) The felt's live region re-announces phase and pot on every snapshot (`poker-felt.tsx:44`).
  - (e) The 8-second watchdog says "It may have stalled — try another from the lobby" on merely slow networks (`use-table-socket.ts:98`).
  - (f) The lobby shows raw status enums, "WAITING" and "IN_HAND" (`page.tsx:292`).

### CR-030: Missing third-party notices and own licence statements

- **Severity:** S4 legal
- **Confidence:** CONFIRMED
- **What happens:** the production tree has 193 packages, mostly MIT, Apache, BSD and ISC. The exceptions:
  - `@img/sharp-*`: libvips under LGPL-3.0-or-later, pulled in by Next.js image optimization;
  - one CC-BY-4.0 data package (caniuse-lite).

  The project's own packages declare no `license`.
- **Recommended fix:** generate a THIRD_PARTY_NOTICES file at build time; set `"license": "UNLICENSED"` (or the client's terms) in private packages; confirm the LGPL notice obligations for the deployment.

### CR-031: The 1-million-shuffle suite can fail on a healthy RNG; there is no procedure for that

- **Severity:** S3
- **Category:** TEST-GAP | PROCESS
- **Confidence:** CONFIRMED
- **Fix type:** CODE-NOW
- **Where:** `packages/engine/src/__tests__/rng.test.ts:648`. The file documents a false-failure budget of at most 1e-3 per run (`:18-35`).
- **What happens:** in this review the card-column family failed once: 4♣ had X²=115.7, p=1.24e-6, below the Bonferroni α of 3.08e-6 (family-adjusted p 6.4e-5). Three fresh reruns passed with normal p-values. That is consistent with a false alarm; the shuffle code (`rng.ts`, `deck.ts`) is a correct rejection-sampled Durstenfeld shuffle.
- **Impact:** release pipelines will occasionally block. Worse, a "rerun until green" habit would also hide a real defect.
- **Recommended fix:**
  - On a failure, automatically repeat with a fresh sample and fail only if the repeat also fails, especially on the same card or position. The combined false-alarm rate is about 1e-6.
  - Print the offending row's cell counts.
  - Record every statistical failure.
  - Run the 1M suite nightly and before releases.
  - Accredited lab certification is still required.
- **Regression test:** the harness logic above is unit-tested with a forced p.
- **Acceptance criteria:** documented, and automated.

---

### Findings added after comparing with GPT-6.1-Sol (CR-032 to CR-041)

Each was found first by GPT-6.1-Sol and adopted only after its repro reproduced on my own run. Where it helps, the GPT ID is given.

### CR-032: Blocked browser storage or audio freezes the action buttons (SOL-017)

- **Severity:** S2. It affects players whose browser blocks site storage (privacy settings, some in-app browsers) or lacks audio. For them it can cost every turn.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (GPT's Playwright test "optional sound storage failure prevents sending", re-run here)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/web/src/components/table/action-bar.tsx:52-60`: `send()` sets `inFlight.current = true` and `setPending(true)`, then calls `playSound(...)` **before** its `try`.
  - `apps/web/src/lib/sounds.ts:6-8` and `:14-18`: `window.localStorage.getItem` and `new AudioContext()` can throw.
  - `apps/web/src/components/table/table-controls.tsx:34` also reads the preference on mount.
- **What happens:** if storage access throws (`SecurityError`), the click throws after marking the action pending. No `ACTION_INTENT` is sent, and `inFlight` and `pending` are never reset, so every later click is ignored. The player times out every hand.
- **Recommended fix:** wrap all sound and storage access in try/catch (best effort). Emit the action first and play the sound after. Put the pending reset in a `finally` that covers the whole function.
- **Regression test:** Playwright with `localStorage.getItem` throwing and `AudioContext` missing: actions are still sent once and the buttons re-enable.
- **Acceptance criteria:** poker actions never depend on sound or storage.
- **Risk of the fix:** none.

### CR-033: A failed next deal rolls back the previous hand's clean-up and payouts (SOL-010)

- **Severity:** S2 (trigger is rare, such as an RNG health failure or a hand that settles at once and fails to persist; when it happens, earned chips and seats are held hostage and the table loops)
- **Category:** RELIABILITY | MONEY
- **Confidence:** CONFIRMED (GPT's `server-faults.mjs`, which faults `crypto.randomFillSync`, re-run here)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/game/manager.ts:320-327`: one mutation runs `completeHand(current)` then `startHand(next)`. A throw in `startHand` rolls back both, and the timer retries about every second (`:345-353`, `:438-451`).
- **What happens:** a player who left during the hand stays seated with `pendingLeave`, and their cash-out is not paid, until a new deal succeeds.
- **Recommended fix:** commit Hand Clean-up and its cash-outs in their own mutation, then start the next hand in a separate revision-checked mutation with bounded retry and an alert (see CR-004).
- **Regression test:** fault the RNG after a settled hand; the cash-out is committed once, no cards are dealt, and one hand starts after recovery.
- **Acceptance criteria:** a failed deal never undoes a completed hand's payouts.
- **Risk of the fix:** an inter-hand orchestration change; rerun the fuzz and the lifecycle tests.

### CR-034: An active idle warning is not re-sent after a reconnect or reload (SOL-016)

- **Severity:** S2 (the player can miss the 10-second window and the table closes)
- **Category:** FAIRNESS
- **Confidence:** CONFIRMED (GPT's `server-faults.mjs` and its Playwright "warning started before lobby authentication is not shown", re-run here)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/server/src/game/manager.ts:261-276`: `TABLE_IDLE_NOTICE` is sent only when a warning starts or ends.
  - `apps/server/src/socket/index.ts:120-122`: `AUTH_OK` carries `activeTableId` but not the current warning.
- **What happens:** a seated player who reloads the lobby, or whose socket reconnects (every token refresh, CR-005), during a warning never sees it.
- **Recommended fix:** on connection, send the current warning state (remaining time) for the player's table. Make client updates idempotent.
- **Regression test:** authenticate during an active warning; the notice arrives and "I'm still here" works.
- **Acceptance criteria:** an active warning is visible right after any reconnect.
- **Risk of the fix:** low.

### CR-035: With reduced motion on, the turn clock shows empty immediately (SOL-041)

- **Severity:** S2 (players who use the reduced-motion accessibility setting lose all turn-time information)
- **Category:** A11Y | FAIRNESS
- **Confidence:** CONFIRMED (GPT's Playwright diagnostic, re-run here: `timebank-drain` duration 1e-05 s, transform `scaleX(0)` at once)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/app/globals.css:222-224` sets `* { animation-duration: .01ms !important }` under reduced motion. That includes the meaningful `timebank-drain` bar (`seat-hud.tsx:94-105`).
- **Recommended fix:** exempt the turn clock from the blanket rule, or render it as stepped (once a second) and as text under reduced motion. Combine with CR-003's relative clock.
- **Regression test:** Playwright with emulated reduced motion shows a positive remaining time during an active turn.
- **Acceptance criteria:** same deadline information with or without reduced motion.
- **Risk of the fix:** none.

### CR-036: A bot-scheduling error after commit reports failure, skips notifications and stalls the table (SOL-014)

- **Severity:** S3 (legacy bot tables only)
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (GPT's `server-faults.mjs`, re-run here: state committed, command rejected, no turn timer)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/game/manager.ts:180-195`: after the transaction commits, `armTimers(next)` runs `decideBotAction` synchronously (`:337`). A throw there escapes `mutate` before broadcasts and wallet patches, and after the old timer was cleared.
- **Recommended fix:** isolate everything that runs after the commit: catch scheduling errors, still deliver, and arm a safe fallback timeout. Retiring bots (D11) removes the path.
- **Regression test:** an injected bot failure after commit gives an ok result, notifications attempted and one fallback timer.
- **Acceptance criteria:** post-commit work can never turn a committed command into a failure.
- **Risk of the fix:** low.

### CR-037: Restart grace for idle closure is per process (SOL-015)

- **Severity:** S3 (matters only when running more than one game server)
- **Category:** CONCURRENCY
- **Confidence:** CONFIRMED in a two-manager model (GPT's `server-faults.mjs`, re-run here); not tested with real multiple processes
- **Fix type:** NEEDS-DECISION (the rolling-restart policy)
- **Where:** `apps/server/src/game/manager.ts:44` and `:357-365`: `resumedAt` is local process memory, so an older worker can start a warning that a freshly restarted worker would not.
- **Recommended fix:** persist a recovery generation and grace deadline with the table state under its lock. Document rolling-restart behaviour. Do this before enabling several servers (see F20/F21).
- **Regression test:** two processes against a disposable database agree on warning and closure times.
- **Risk of the fix:** requires a disposable Postgres and Redis to test.

### CR-038: The balance display can go backwards (SOL-038)

- **Severity:** S3 (display only; the stored balance is right)
- **Category:** UX
- **Confidence:** CONFIRMED (GPT's `server-faults.mjs` and Playwright "lobby refresh can overwrite a newer wallet patch", re-run here: patches arrive `[10000, 9000]`)
- **Fix type:** CODE-NOW
- **Where:**
  - `apps/server/src/game/manager.ts:245-248`: `patchBankroll` reads and emits outside any ordering.
  - `apps/web/src/app/page.tsx:34-36`: the lobby's `/auth/me` patch skips the `walletVersion` guard.
- **Recommended fix:** add a monotonic wallet revision (or `updatedAt`) to every balance payload and ignore older ones everywhere.
- **Regression test:** reversed delivery keeps the newest balance.
- **Risk of the fix:** a small contract change.

### CR-039: Opening a closed table fresh loses the "Verify hand" control (SOL-045)

- **Severity:** S3
- **Category:** UX
- **Confidence:** CONFIRMED (GPT's Playwright test, re-run here)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/components/table/idle-close-dialog.tsx:346` and `:407-416`: the audit control needs the last live snapshot, which a fresh page never has for a closed table.
- **Recommended fix:** a participant-only list of hands per table (or per player) that works without live state. This is also the start of a player hand history.
- **Regression test:** close a table, reload, and verify the last hand; an outsider sees nothing.
- **Risk of the fix:** a new read API; keep the participant-only authorization.

### CR-040: Startup accepts unusable bankroll, timer and token-lifetime values (SOL-047)

- **Severity:** S3
- **Category:** CONFIG
- **Confidence:** CONFIRMED (GPT's `absence-and-config.mjs`, re-run here: 2,147,483,648 for both the starting bankroll and the time bank, and `JWT_ACCESS_TTL=not-a-duration`, all accepted)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/config.ts:13-31` (no upper bounds; durations not parsed). Node clamps oversized `setTimeout` delays to 1 ms, so an oversized time bank would time every player out at once.
- **Recommended fix:** bound values to Postgres Int and Node timer limits, parse durations at startup, and derive the client refresh interval from the token lifetime.
- **Regression test:** child-process config tests reject each bad value.
- **Risk of the fix:** stricter startup may reject odd existing deployments; add release notes.

### CR-041: The odd-chip type comment names the wrong starting seat (SOL-052)

- **Severity:** S4 (documentation; the code is right)
- **Where:** `packages/shared/src/poker.ts:33-34` says "earliest position past the blinds". The implementation (`packages/engine/src/pots.ts:100-131`) starts left of the button.
- **Recommended fix:** correct the comment only; do not change the engine.

## Appendix B: Fix plan, open questions, repro scripts (`CLAUDE-REVIEW.md` §10, §12, §13)

### Fix plan for Claude

Work in small, reviewable batches. After every batch, run: the web and server typecheck, the engine Jest suite, the server `node --test` suite, `review/claude/repro/engine-fuzz.mjs 1 60 800`, and the browser suite once ports 3107/4107 are free. Convert each repro into a regression test that asserts the **fixed** behaviour.

| Batch | Contents | Needs a decision? | Tests |
| --- | --- | --- | --- |
| A: quick client fixes | CR-003, CR-035, CR-032, CR-019, CR-020, CR-021, CR-023, CR-024, CR-028, CR-029, CR-039, CR-041; the CR-010 formatter (symbol per D5) | CR-010 wording only | A `SeatHud` skew test (port of the repro); Playwright updates |
| B: sessions and sockets | CR-007 (first: refresh cookie and reconnect), CR-006, CR-005, CR-034, CR-038, CR-016, CR-017; earlier F08, F19, F17, F16 | – | `server-sessions.mjs` turned into `node:test`; a Playwright clock test for refresh |
| C: table fairness and money UX | CR-008, CR-009, CR-002, CR-033; earlier F10, F09 | D1, D4, D8 | `table-behaviour.mjs` as engine and server tests; rerun the fuzz |
| D: hardening and config | CR-011, CR-012, CR-013 (additive migration), CR-018, CR-015; earlier F18, F11 | D6, D7 | Header tests, sanitizer tests, a migration dry run |
| E: operability | CR-004 (back-off, PAUSED, admin void/refund), CR-036, CR-037, CR-040, CR-031, CR-027; earlier F21 | D11, D12 | Stuck-table tests, admin void idempotence |
| F: legal and product (external) | CR-001, CR-022, CR-026, CR-030; real-money F01–F07, F12–F15, F20, F22 | D2, D9, D10 | Per the decisions |

**Architecture rules for every fix:**

- The engine stays pure: new rules go in `packages/engine` with Jest tests.
- Server changes go through the locked, revision-checked `mutate`.
- Shared types change in `packages/shared` for both sides.
- Never weaken the leak guard, audit sealing, row locks, revision ordering, TLS guards or append-only history.

**Migrations that touch the live OnlinePoker database:** CR-013 (unique `lower(username)` index), CR-001 (terms-acceptance columns, if stored), CR-004 (a void/refund audit table, if added). All are additive. Apply them through the DIRECT_URL admin path described in the README, check existing data first, and never run `db:reset`.

### Open questions and residual risk

- **Run after GPT-6.1-Sol finished:** the production build and the Playwright browser suite (56/56) both pass.
- **Not tested at all:**
  - real-Postgres concurrency (no Docker): the seat, create and cash-out races are reasoned about only;
  - multi-instance deployment: timers are per process, and a restart of one instance clears idle warnings cluster-wide;
  - the real production deployment (F15).
- **Accessibility** was not measured with tools (CR-025). **Clock behaviour** under real clock jumps was not exercised (F10).
- **RNG:** a statistical test cannot prove randomness. Accredited lab evaluation of the deployed RNG and game is still required.
- **Legal questions for counsel:** L1–L10.

### Appendix: repro scripts

All scripts are in `review/claude/`. They import the built packages, use throwaway keys, and cannot reach a database, except `live-db-readonly.mjs`, which is read-only and prints counts only.

| Script | Proves | Run |
| --- | --- | --- |
| `repro/engine-fuzz.mjs` | Engine lifecycle invariants, the server's audit verification, redaction and browser verification (no failures expected) | `node review/claude/repro/engine-fuzz.mjs <seed> <tables> <steps>` |
| `repro/server-sessions.mjs` | CR-006, CR-007 (packet and broadcast), socket token expiry, CR-016 | `node review/claude/repro/server-sessions.mjs` |
| `repro/table-behaviour.mjs` | CR-002, CR-008 | `node review/claude/repro/table-behaviour.mjs` |
| `repro/seat-timer-skew.mjs` | CR-003 (renders the real `SeatHud`) | `TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/repro/seat-timer-skew.mjs` |
| `repro/live-db-readonly.mjs` | Live-data anomalies (read-only, counts only) | `node review/claude/repro/live-db-readonly.mjs`, using the repository `.env` |
| `tsconfig.json` | JSX settings for the component repro | – |

The earlier audit's probes: `node scripts/security-review.mjs`.

## Appendix C: Coverage ledger: every file reviewed on 30 September (`CLAUDE-REVIEW.md` §11)

FULL means read line by line. PARTIAL means skimmed, grepped, executed or secret-scanned. Excluded: `node_modules/`, build output, `*.log`, `.agents/`, and the concurrent reviewer's `review/gpt-6.1-sol/` working files, which are another reviewer's scratch data and not project code.

Totals: 159 files: 103 FULL, 56 PARTIAL, 0 NOT REVIEWED.

| File | Status | Findings |
| --- | --- | --- |
| `.cursor/mcp.json` | PARTIAL | – |
| `.cursor/rules/supabase.mdc` | PARTIAL | – |
| `.env.example` | FULL | CR-012 |
| `.gitignore` | FULL | – |
| `BACKEND-SECURITY-AUDIT.md` | FULL | F01–F22 |
| `CLAUDE_HANDOFF.md` | FULL | – |
| `COMPLIANCE.md` | PARTIAL | Claims check |
| `GPT-6.1-SOL-REVIEW-PROMPT.md` | FULL | – |
| `README.md` | FULL | Claims check |
| `SECURITY-REVIEW.md` | FULL | Claims check |
| `apps/server/certs/supabase-pooler-root.pem` | PARTIAL | – |
| `apps/server/package.json` | FULL | – |
| `apps/server/prisma.config.ts` | FULL | – |
| `apps/server/prisma/migrations/20240919190000_init/migration.sql` | FULL | – |
| `apps/server/prisma/migrations/20260920140611_poker_security/migration.sql` | FULL | F12 |
| `apps/server/prisma/migrations/20260920141323_restrict_rls_event_trigger/migration.sql` | FULL | – |
| `apps/server/prisma/migrations/20260920165155_poker_history_integrity/migration.sql` | FULL | – |
| `apps/server/prisma/migrations/20260924120000_compliance_audit_trail/migration.sql` | FULL | – |
| `apps/server/prisma/migrations/migration_lock.toml` | FULL | – |
| `apps/server/prisma/schema.prisma` | FULL | CR-001, CR-013, F02, F12, F22 |
| `apps/server/prisma/seed.ts` | FULL | – |
| `apps/server/src/app.ts` | FULL | CR-015, CR-016, F08, F15, F18, F20 |
| `apps/server/src/auth/jwt.ts` | FULL | F16 |
| `apps/server/src/auth/middleware.ts` | FULL | CR-007, F17 |
| `apps/server/src/auth/routes.ts` | FULL | CR-001, CR-006, CR-012, CR-013, CR-016, CR-026, F01, F07, F16, F18, F19 |
| `apps/server/src/config.ts` | FULL | F11, F15 |
| `apps/server/src/db/prisma.ts` | FULL | – |
| `apps/server/src/game/audit.ts` | FULL | CR-004, F14 |
| `apps/server/src/game/encryption.ts` | FULL | F11, F13 |
| `apps/server/src/game/legacy.ts` | FULL | – |
| `apps/server/src/game/manager.ts` | FULL | CR-002, CR-004, CR-007, CR-008, CR-017, CR-027, F09, F10, F21 |
| `apps/server/src/index.ts` | FULL | F10, F21 |
| `apps/server/src/logger.ts` | FULL | F08 |
| `apps/server/src/redis/client.ts` | FULL | – |
| `apps/server/src/redis/table-state.ts` | FULL | – |
| `apps/server/src/routes/admin-access-log.ts` | FULL | F08 |
| `apps/server/src/routes/admin.ts` | FULL | CR-004, F07, F12 |
| `apps/server/src/routes/health.ts` | FULL | F21 |
| `apps/server/src/routes/tables.ts` | FULL | CR-016, CR-018 |
| `apps/server/src/socket/index.ts` | FULL | CR-007, CR-017, CR-019, CR-028, F17, F20 |
| `apps/server/src/socket/mask.ts` | FULL | – |
| `apps/server/src/socket/rate-limit.ts` | FULL | F20 |
| `apps/server/src/socket/rooms.ts` | FULL | – |
| `apps/server/src/socket/types.ts` | FULL | – |
| `apps/server/src/transport.ts` | FULL | F15 |
| `apps/server/test/compliance.test.mjs` | PARTIAL | – |
| `apps/server/test/game-flow.test.mjs` | PARTIAL | – |
| `apps/server/test/human-tables.test.mjs` | PARTIAL | – |
| `apps/server/test/integration.test.mjs` | PARTIAL | CR-006 (server half asserted) |
| `apps/server/test/security.test.mjs` | PARTIAL | – |
| `apps/server/test/table-lifecycle.test.mjs` | PARTIAL | – |
| `apps/server/tsconfig.json` | PARTIAL | – |
| `apps/web/next-env.d.ts` | PARTIAL | – |
| `apps/web/next.config.ts` | FULL | CR-011, F15 |
| `apps/web/package.json` | FULL | – |
| `apps/web/playwright.config.ts` | FULL | – |
| `apps/web/postcss.config.mjs` | PARTIAL | – |
| `apps/web/src/app/globals.css` | PARTIAL | – |
| `apps/web/src/app/layout.tsx` | FULL | CR-020 |
| `apps/web/src/app/login/page.tsx` | FULL | CR-001, F07 |
| `apps/web/src/app/page.tsx` | FULL | CR-001, CR-010, CR-015, CR-023, CR-025, CR-029 |
| `apps/web/src/app/table/[id]/page.tsx` | FULL | CR-002, CR-005, CR-009, CR-010, CR-017, CR-021, CR-025 |
| `apps/web/src/components/auth-hydrator.tsx` | FULL | CR-005, CR-006 |
| `apps/web/src/components/table-idle-notice.tsx` | FULL | – |
| `apps/web/src/components/table/action-bar.tsx` | FULL | CR-005, CR-010, CR-014, CR-019 |
| `apps/web/src/components/table/fairness-audit.tsx` | FULL | – |
| `apps/web/src/components/table/game-log.tsx` | FULL | CR-025 |
| `apps/web/src/components/table/idle-close-dialog.tsx` | FULL | CR-010 |
| `apps/web/src/components/table/playing-card.tsx` | FULL | CR-029 |
| `apps/web/src/components/table/poker-felt.tsx` | FULL | CR-010, CR-014, CR-029 |
| `apps/web/src/components/table/seat-hud.tsx` | FULL | CR-003, CR-009, CR-010, CR-014, CR-025 |
| `apps/web/src/components/table/table-controls.tsx` | FULL | CR-010, CR-017 |
| `apps/web/src/hooks/use-table-fx.ts` | FULL | – |
| `apps/web/src/hooks/use-table-socket.ts` | FULL | CR-005, CR-021, CR-028, CR-029 |
| `apps/web/src/lib/api.ts` | FULL | CR-012 |
| `apps/web/src/lib/socket.ts` | FULL | CR-005 |
| `apps/web/src/lib/sounds.ts` | FULL | CR-024 |
| `apps/web/src/stores/session.ts` | FULL | – |
| `apps/web/test/browser/game-flow.spec.ts` | PARTIAL | CR-002 (encodes “keep seat”) |
| `apps/web/test/browser/table-lifecycle.spec.ts` | PARTIAL | CR-002 (encodes “keep seat”) |
| `apps/web/test/support/game-server.mjs` | PARTIAL | – |
| `apps/web/test/support/restore-next-env.ts` | PARTIAL | – |
| `apps/web/tsconfig.json` | PARTIAL | – |
| `chatgpt-6-codex.md` | FULL | – |
| `chatgpt-6-sol.md` | FULL | – |
| `docker-compose.yml` | FULL | F15 |
| `package-lock.json` | PARTIAL | – |
| `package.json` | FULL | CR-020, CR-030 |
| `packages/engine/jest.config.cjs` | PARTIAL | – |
| `packages/engine/package.json` | FULL | – |
| `packages/engine/src/__tests__/audit.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/bots.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/deck.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/evaluate-exhaustive.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/evaluate.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/helpers/drive.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/helpers/forge.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/helpers/simulate.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/helpers/stats.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/leakage.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/leave-flow.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/pots-reference.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/pots.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/review-fixes.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/rng.test.ts` | PARTIAL | CR-031 |
| `packages/engine/src/__tests__/security.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/table-lifecycle.test.ts` | PARTIAL | – |
| `packages/engine/src/__tests__/table.test.ts` | PARTIAL | – |
| `packages/engine/src/audit.ts` | FULL | F14 |
| `packages/engine/src/bots/chen.ts` | FULL | – |
| `packages/engine/src/bots/decide.ts` | FULL | CR-027, F06 |
| `packages/engine/src/bots/delay.ts` | FULL | – |
| `packages/engine/src/bots/montecarlo.ts` | FULL | CR-027 |
| `packages/engine/src/bots/texture.ts` | FULL | – |
| `packages/engine/src/cards.ts` | FULL | – |
| `packages/engine/src/deck.ts` | FULL | – |
| `packages/engine/src/evaluate.ts` | FULL | – |
| `packages/engine/src/fairness.ts` | FULL | – |
| `packages/engine/src/index.ts` | FULL | – |
| `packages/engine/src/isolation.ts` | FULL | – |
| `packages/engine/src/legal.ts` | FULL | – |
| `packages/engine/src/pots.ts` | FULL | – |
| `packages/engine/src/public.ts` | FULL | CR-003 |
| `packages/engine/src/rng.ts` | FULL | – |
| `packages/engine/src/seats.ts` | FULL | – |
| `packages/engine/src/table.ts` | FULL | CR-002, CR-010, CR-022 |
| `packages/engine/src/types.ts` | FULL | – |
| `packages/engine/tsconfig.json` | PARTIAL | – |
| `packages/shared/package.json` | FULL | – |
| `packages/shared/src/api.ts` | FULL | – |
| `packages/shared/src/audit.ts` | FULL | CR-022, F14 |
| `packages/shared/src/constants.ts` | FULL | D3 |
| `packages/shared/src/events.ts` | FULL | CR-028 |
| `packages/shared/src/fairness.ts` | FULL | – |
| `packages/shared/src/index.ts` | FULL | – |
| `packages/shared/src/poker.ts` | FULL | – |
| `packages/shared/tsconfig.json` | PARTIAL | – |
| `plan.md` | FULL | CR-002 (spec) |
| `progress.md` | PARTIAL | CR-002, CR-017 (claims) |
| `scripts/review-database.mjs` | FULL | – |
| `scripts/security-review.mjs` | FULL | F01–F22 (probes) |
| `scripts/verify-evaluator.mjs` | PARTIAL | – |
| `skills-lock.json` | PARTIAL | – |
| `supabase/ACCESS.md` | PARTIAL | – |
| `supabase/README.md` | PARTIAL | – |
| `supabase/authenticated-account/PROJECT.md` | PARTIAL | – |
| `supabase/authenticated-account/advisors.md` | PARTIAL | – |
| `supabase/authenticated-account/database.types.ts` | PARTIAL | – |
| `supabase/authenticated-account/extensions.md` | PARTIAL | – |
| `supabase/authenticated-account/functions.md` | PARTIAL | – |
| `supabase/authenticated-account/migrations.md` | PARTIAL | – |
| `supabase/authenticated-account/rls.md` | PARTIAL | – |
| `supabase/authenticated-account/schema.md` | PARTIAL | – |
| `supabase/mcp.md` | PARTIAL | – |
| `supabase/migrations/20260920140611_poker_security.sql` | FULL | – |
| `supabase/migrations/20260920141323_restrict_rls_event_trigger.sql` | FULL | – |
| `supabase/migrations/20260920165155_poker_history_integrity.sql` | FULL | – |
| `supabase/migrations/20260927224842_compliance_audit_trail.sql` | FULL | – |
| `tsconfig.base.json` | PARTIAL | – |

## Appendix D: 30 September verification log and the F-items as they were then (`CLAUDE-REVIEW.md` §3, §4)

### Verification log

| Command | Result | Counts | Duration | Notes |
| --- | --- | --- | --- | --- |
| `git rev-parse HEAD; git status; git diff HEAD \| sha256sum` | recorded | 34 status lines | – | see header |
| `tsc --noEmit` on shared, engine, server and web | pass | 4/4 | 6 s | Direct `tsc`, without `build:core`, so shared `dist/` was not rewritten while the other reviewer ran |
| Engine Jest, all 14 suites (`--runInBand`, no rebuild) | 1 fail | 450 pass, 1 fail | 230 s | `rng.test.ts` (b) card column: one card (4♣) had X²=115.7, p=1.24e-6 < α=3.08e-6 (family-adjusted p 6.4e-5). See CR-031 |
| `rng.test.ts` rerun ×3 | pass | 42/42 each | ~45 s each | Card-column min p 0.025 / 0.006 / 0.014; global p 0.92 / 0.67 / 0.058. The failure was a statistical false alarm |
| Server `node --test` (5 files), `DATABASE_URL` overridden to loopback:1 | pass | 65/65, 0 skipped | 33 s | The direct-TLS test ran (OpenSSL on PATH) |
| `node scripts/verify-evaluator.mjs` | pass | all category counts match | – | – |
| `npm audit --omit=dev` and `npm audit` | pass | 0 known vulnerabilities | – | – |
| Production dependency licence inventory | done | 193 packages | – | See CR-030 |
| Secret scan of tracked files and full git history | pass | 0 hits | – | Only a dummy test URL |
| `node scripts/security-review.mjs` (earlier probes) | reproduces | 11 of 11 observations unchanged | – | See section 4 |
| `review/claude/repro/engine-fuzz.mjs`, seeds 1–5 | pass | 28,273 hands; 277,666 events; 8,527 showdowns; 586 closures; 65,667 participant audits; 680,212 browser card verifications; 0 failures | ~13 min | – |
| `review/claude/repro/server-sessions.mjs` | confirms | 6/6 behaviours | ~5 s | CR-006, CR-007 (×3), socket token expiry, CR-016 |
| `review/claude/repro/table-behaviour.mjs` | confirms | 2/2 | <2 s | CR-002, CR-008 |
| `review/claude/repro/seat-timer-skew.mjs` (renders the real component) | confirms | – | <2 s | CR-003 |
| `review/claude/repro/live-db-readonly.mjs` (read-only transaction, counts only) | ran | – | ~3 s | 6 tables (3 closed, 3 waiting); 0 stuck; 0 needing recovery; 0 seats at closed tables; 2 human users, both guests; 0 case-duplicate usernames; 56 hands, 0 without audit since 28 Sep; 1 expired session still stored |
| `npm run build` (production) | pass | all workspaces; Next 15.5 build | 22 s | Run after GPT-6.1-Sol finished; `next-env.d.ts` unchanged |
| `npm run test:browser` (Playwright, Chrome desktop and Pixel 7) | pass | 56/56 | 122 s | Run after GPT-6.1-Sol finished |
| GPT-6.1-Sol `review/gpt-6.1-sol/repro/browser-defects.spec.ts` (its own config) | reproduces | 10/10 bad behaviours confirmed | 25 s | Confirms CR-003, CR-005, CR-011, CR-019, CR-025, CR-032, CR-034, CR-035, CR-038, CR-039 |
| GPT-6.1-Sol `server-faults.mjs` and `absence-and-config.mjs` (loopback DB) | reproduce | all observations | <5 s | Confirms CR-004, CR-006, CR-007, CR-016, CR-033, CR-034, CR-036, CR-037, CR-038, CR-040 |
| `review/claude/repro/server-sessions.mjs`, new section F | confirms | 401 and refresh cookie deleted on a DB error; session still valid | – | CR-007 |
| `npm run test:integration` / real-Postgres concurrency | **not run** | – | – | No disposable Postgres (Docker not installed). Seat and create races were reasoned about, not executed |
| Side effects on tracked files | none | – | – | New files only: `CLAUDE-REVIEW.md`, `review/claude/**` |

### Status of earlier findings (BACKEND-SECURITY-AUDIT.md, 29 September)

No source changed after that audit. "Reproduced" means `scripts/security-review.mjs` produced the same observation today.

| ID | Status | Evidence today | New detail only |
| --- | --- | --- | --- |
| F01 | OPEN | Reproduced: a guest gets 10,000 chips | Guests are unrecoverable and not warned (CR-026). The live DB's only two human accounts are guests |
| F02 | OPEN | No ledger in schema or code | – |
| F03 | OPEN | No payment or custody code | – |
| F04 | OPEN | No identity or eligibility state | Age confirmation is absent even for play chips (CR-001) |
| F05 | OPEN | No RG models or routes | – |
| F06 | OPEN | No anti-collusion | Legacy bots remain (CR-027) |
| F07 | OPEN | Unchanged | Username impersonation (CR-013). No email verification, password change or reset, or account deletion or export: a locked-out player cannot reach their balance |
| F08 | OPEN | Reproduced: synthetic password in the error log; 16 malformed requests → 500 | – |
| F09 | OPEN | Reproduced: a zero-row credit releases the seat and drops the cash-out | – |
| F10 | OPEN | Reproduced: `TIMEOUT_FOLD` 4 ms after recovery | CR-002 is a separate absent-player fairness gap |
| F11 | OPEN | Reproduced: an all-zero key reused as the access secret is accepted | – |
| F12 | OPEN | Migrations unchanged | – |
| F13 | OPEN | Unchanged | No operator recovery for stuck tables (CR-004) |
| F14 | OPEN | Reproduced: a resealed CHECK passes both verifiers | – |
| F15 | OPEN | Unchanged | Concrete items: web security headers (CR-011); SameSite=Strict hosting constraint (CR-012). The dev Compose file publishes Postgres (`poker`/`poker`) and Redis without auth on all interfaces |
| F16 | OPEN | Reproduced: a 365-day-old session refreshes; a replay leaves the session valid | Reuse detection must include a short grace window, or concurrent tabs are signed out (CR-006) |
| F17 | OPEN | Reproduced: a revoked socket still receives its bankroll | The inverse is also wrong: a transient DB error is treated as revocation (CR-007) |
| F18 | OPEN | Reproduced: cross-origin text/plain guest creation | – |
| F19 | OPEN | Reproduced: no `Cache-Control` on `/auth/guest` or `/auth/me` | – |
| F20 | OPEN | Unchanged | Shared-IP false positives and lobby polling load (CR-015) |
| F21 | OPEN | Reproduced: `/api/health` says ok with no database | Endless 1-second retry loops and no PAUSED handling (CR-004). `clientActionId` still unused |
| F22 | OPEN | Unchanged | Live DB keeps expired sessions (1 today); no cleanup job |

**The 27 September fixes (progress.md, 25 findings) still hold, as far as tested.** `review-fixes.test.ts` (94 tests) and the rest of the engine suite pass. The fuzz exercised the same rules (waiting for the big blind, dead button, leave-fold, all-in eligibility, closure payouts) without a failure.

## Appendix E: Every command I ran (descriptions only, local time)

| Time | Shell | What it did |
| --- | --- | --- |
| 29 Sep 21:58 | bash | List tracked files and working tree status |
| 29 Sep 21:58 | bash | List root directory and read previous GPT prompt file |
| 29 Sep 21:58 | bash | Read prior Sol doc, handoff notes and README |
| 29 Sep 21:58 | bash | Read the existing backend security audit |
| 29 Sep 22:00 | bash | Show uncommitted diff stats and source file sizes |
| 29 Sep 22:00 | bash | Inspect Claude settings dir and workspace package manifests |
| 29 Sep 22:00 | bash | List section headings in the progress log |
| 29 Sep 22:00 | bash | Read plan, security review and compliance outline |
| 29 Sep 22:00 | bash | Read the progress log header and recent entries |
| 29 Sep 22:00 | bash | Show what was added to the progress log since last commit |
| 29 Sep 22:00 | bash | Compare modification times of recent files |
| 29 Sep 22:00 | bash | Show commit history with changed files |
| 29 Sep 22:00 | bash | Read table routes and auth routes |
| 29 Sep 22:01 | bash | Read remaining server source files |
| 29 Sep 22:01 | bash | Read the Prisma database schema |
| 29 Sep 22:01 | bash | Read the web client socket hook, action bar and API/socket libs |
| 29 Sep 22:01 | bash | Read auth hydrator, session store, layout and Next config |
| 29 Sep 22:02 | bash | Check gitignore, MCP config, env keys, web routes and legal copy |
| 29 Sep 22:04 | bash | Check seed data, admin routes, buy-in handling and DB constraints |
| 29 Sep 22:05 | bash | Collect exact line numbers and code size totals |
| 29 Sep 22:08 | bash | Read seat helpers and legal-action logic in the engine |
| 29 Sep 22:09 | bash | Verify line numbers and look at server test harness pattern |
| 29 Sep 22:11 | bash | Check browser test harness and DB URL handling in tests |
| 29 Sep 22:12 | bash | Check the CDN library exists and read app theme tokens |
| 29 Sep 22:12 | bash | Read the web app's root style tokens |
| 29 Sep 22:13 | bash | Build the page from the brief and syntax-check its script |
| 29 Sep 22:23 | bash | Check personal settings for saved auto-mode entries |
| 29 Sep 22:23 | bash | Check Claude memory folder, project settings and git remote |
| 29 Sep 22:27 | bash | Check Claude Code version and settings backup files |
| 29 Sep 22:31 | bash | Remove auto-mode section and confirm defaults are back |
| 29 Sep 23:55 | bash | Record repo state and tool versions |
| 29 Sep 23:55 | bash | Check GPT review files and running node processes |
| 29 Sep 23:55 | bash | Read engine pots, types, cards and deck modules |
| 29 Sep 23:56 | bash | Read engine RNG, fairness, evaluator and index |
| 29 Sep 23:56 | bash | Read engine public projection and audit modules |
| 29 Sep 23:56 | bash | Read bot logic and shared contract modules |
| 29 Sep 23:57 | bash | Read shared audit verifier module |
| 29 Sep 23:57 | bash | Read server audit, transport and admin log modules |
| 29 Sep 23:57 | bash | Read DB migrations and compare Prisma and Supabase copies |
| 29 Sep 23:57 | bash | Read the lobby page |
| 29 Sep 23:58 | bash | Read the table page and login page |
| 29 Sep 23:58 | bash | Read table controls, idle notice and fairness audit UI |
| 29 Sep 23:58 | bash | Read the idle warning and closed-table dialog |
| 29 Sep 23:58 | bash | Read felt, seat, card, log, effects and sound components |
| 30 Sep 00:00 | bash | Check event emitters, build freshness, docker and tools |
| 30 Sep 00:00 | bash | Read the existing in-memory security probe script |
| 30 Sep 00:04 | bash | Fix buy-in ledger ordering and bot handling in fuzz script |
| 30 Sep 00:04 | bash | Run a small engine fuzz to validate the harness |
| 30 Sep 00:04 | bash | Fix comment and run a small engine fuzz |
| 30 Sep 00:05 | bash | Run large engine fuzz across four seeds in background [bg] |
| 30 Sep 00:05 | bash | Check available test libraries and web tsconfig |
| 30 Sep 00:06 | bash | Run the server session and socket-auth repro script |
| 30 Sep 00:07 | bash | Render the seat timer with skewed clocks to prove the bug |
| 30 Sep 00:07 | bash | Provide React global and rerun the timer skew proof |
| 30 Sep 00:07 | bash | Check interim output of the background fuzz run |
| 30 Sep 00:07 | bash | Scan repo and git history for secrets; find skipped tests |
| 30 Sep 00:08 | bash | Skim global CSS for accessibility-relevant rules |
| 30 Sep 00:09 | bash | Run absent-player and stale-action repro |
| 30 Sep 00:09 | bash | Re-run the prior audit's in-memory security probes |
| 30 Sep 00:10 | bash | Summarize fuzz results so far |
| 30 Sep 00:10 | bash | Check tests that encode suspected behaviours |
| 30 Sep 00:10 | bash | Confirm no code changed since audit; check cookie config |
| 30 Sep 00:11 | bash | Run npm audit and scan for unsafe HTML or eval usage |
| 30 Sep 00:11 | bash | Inventory licenses of production dependency tree |
| 30 Sep 00:14 | bash | Check whether GPT's Codex run is still active |
| 30 Sep 00:14 | bash | Read GPT's verification log to avoid conflicts |
| 30 Sep 00:14 | bash | Run typecheck, engine, server and evaluator checks in background [bg] |
| 30 Sep 00:15 | bash | Collect exact line numbers for report citations |
| 30 Sep 00:15 | bash | Collect exact line numbers (simpler searches) |
| 30 Sep 00:15 | bash | Find every place play chips are shown with a dollar sign |
| 30 Sep 00:15 | bash | Fix repro reference and check background run progress |
| 30 Sep 00:17 | bash | Read remaining config, compose file and DB review script |
| 30 Sep 00:17 | bash | Summarize the completed fuzz run |
| 30 Sep 00:17 | bash | Run read-only aggregate checks against the live database |
| 30 Sep 00:18 | bash | Check engine, server and evaluator test results |
| 30 Sep 00:18 | bash | Show details of the failing randomness test |
| 30 Sep 00:18 | bash | Check whether the engine test run has finished |
| 30 Sep 00:19 | bash | Re-run the randomness test suite three times [bg] |
| 30 Sep 00:19 | bash | Inspect randomness test thresholds and flake handling |
| 30 Sep 00:19 | bash | Read the randomness test's documented error budget |
| 30 Sep 00:19 | bash | Build the file coverage ledger data |
| 30 Sep 00:19 | bash | Read server test and evaluator results |
| 30 Sep 00:19 | bash | Show server test summary lines |
| 30 Sep 00:23 | bash | Collect remaining line numbers and check RNG reruns |
| 30 Sep 00:27 | bash | Insert the coverage ledger and confirm no tracked files changed |
| 30 Sep 00:27 | bash | Verify tracked files unchanged and list new review files |
| 30 Sep 00:28 | bash | Verify two line references and fix the confidence tally |
| 30 Sep 00:28 | bash | Fix config line reference in the claims check |
| 30 Sep 01:52 | bash | Confirm GPT stopped, code unchanged, and locate its report |
| 30 Sep 01:52 | bash | List the section headings of GPT's report |
| 30 Sep 01:54 | bash | Check whether GPT covered issues unique to my review |
| 30 Sep 01:54 | bash | Verify reduced-motion CSS and inspect GPT's rollback repro |
| 30 Sep 01:55 | bash | Re-run session repro including the refresh-cookie check |
| 30 Sep 01:55 | bash | Run the production build and check side effects |
| 30 Sep 01:55 | bash | Run the full Playwright browser test suite |
| 30 Sep 01:58 | bash | Inspect GPT's browser defect test configuration |
| 30 Sep 01:58 | bash | Confirm GPT's fixture server has no database access |
| 30 Sep 01:58 | bash | Run GPT's browser defect tests independently |
| 30 Sep 01:58 | bash | Check how GPT's server scripts set up their environment |
| 30 Sep 01:59 | bash | Run GPT's server fault and config probes |
| 30 Sep 02:00 | bash | Locate the report sections that need updating |
| 30 Sep 02:03 | bash | Apply report update and check the findings index |
| 30 Sep 02:03 | bash | Verify confidence counts and read the updated summary |
| 30 Sep 02:03 | bash | Document new repro section and verify code untouched |
| 30 Sep 02:07 | bash | Check GPT's report for mentions of my unique findings |
| 7 Oct 16:52 | bash | Check repo changes since the review was written |
| 7 Oct 16:53 | bash | Find docs describing the new fixes and review-ID references |
| 7 Oct 16:54 | bash | Check running processes and rebuild all packages |
| 7 Oct 16:54 | bash | Restore next-env.d.ts to its pre-build content |
| 7 Oct 16:55 | bash | Inspect the new server test runner |
| 7 Oct 16:55 | bash | Run typecheck, engine, server, real-DB and browser suites [bg] |
| 7 Oct 16:57 | bash | Check browser test ports and suite progress |
| 7 Oct 16:57 | bash | Locate finding sections and prior audit file |
| 7 Oct 16:57 | bash | List review sections and code referencing finding IDs |
| 7 Oct 16:58 | bash | See which finding IDs the fixes reference |
| 7 Oct 16:58 | bash | Read prior-audit status section and temp snapshots |
| 7 Oct 16:59 | bash | Read the top of progress.md |
| 7 Oct 16:59 | bash | Check engine and server suite results so far |
| 7 Oct 17:00 | bash | List failing engine tests |
| 7 Oct 17:00 | bash | Show first failing test details |
| 7 Oct 17:00 | bash | Inspect verifySealedAudit and the stale test |
| 7 Oct 17:00 | bash | Read verifySealedAudit's new checks |
| 7 Oct 17:01 | bash | Check what CI and test scripts run |
| 7 Oct 17:01 | bash | Check server suite tail |
| 7 Oct 17:01 | bash | Rerun ledger unit tests with tsx loader |
| 7 Oct 17:01 | bash | Count server tests without double counting |
| 7 Oct 17:01 | bash | Check whether rake was added to the game |
| 7 Oct 17:02 | bash | Check whether players can set rake |
| 7 Oct 17:07 | bash | Read real-DB and browser suite results |
| 7 Oct 17:07 | bash | Summarize real-DB suite results |
| 7 Oct 17:08 | bash | Inspect TableIncident grants in the migration |
| 7 Oct 19:10 | bash | Check workflow progress |
| 7 Oct 19:11 | bash | Show journal entries and agent labels |
| 7 Oct 19:11 | bash | See why two agents restarted |
| 7 Oct 19:11 | bash | Extract finished checker results |
| 7 Oct 19:11 | bash | Print new findings in full |
| 7 Oct 19:11 | bash | Read server schemas and client payloads |
| 7 Oct 19:11 | bash | Read the checker's socket contract test |
| 7 Oct 19:12 | bash | Re-run the socket contract check myself |
| 7 Oct 19:12 | bash | Compare every client emit with server schemas |
| 7 Oct 19:12 | bash | Find sit toggle emits and commandId usage |
| 7 Oct 19:12 | bash | Print evidence for fixed/partial/regressed verdicts |
| 7 Oct 19:12 | bash | Check whether TableIncident and PAUSED are used |
| 7 Oct 19:13 | bash | Compare configured turn time with published rules |
| 7 Oct 19:13 | bash | Confirm base turn time and gameConfig readers |
| 7 Oct 19:13 | bash | Check progress of restarted checkers |
| 7 Oct 19:13 | bash | Read more of progress.md for style |
| 7 Oct 19:44 | bash | Save all results and check coverage |
| 7 Oct 19:44 | bash | List all 63 statuses with remaining work |
| 7 Oct 19:44 | bash | Print new findings from remaining groups |
| 7 Oct 19:45 | bash | Read login lockout implementation |
| 7 Oct 19:45 | bash | Review evidence for selected verdicts |
| 7 Oct 19:45 | bash | Count statuses for CR and F items |
| 7 Oct 19:46 | bash | Review evidence for remaining items |
| 7 Oct 19:47 | bash | Check audit version bump for the new money replay |
| 7 Oct 19:47 | bash | Check fuzz script usage and DB safety |
| 7 Oct 19:47 | bash | Re-run engine lifecycle fuzz on today's code [bg] |
| 7 Oct 19:49 | bash | Fix two overstated lines; check fuzz output |
| 7 Oct 19:49 | bash | Wait for fuzz seed 3 result |
| 7 Oct 19:50 | bash | Insert entry into progress.md and update Overall |
| 7 Oct 19:50 | bash | Find damaged line and read fuzz totals |
| 7 Oct 19:50 | bash | Verify only my edits changed progress.md |
| 7 Oct 19:50 | bash | Check markdown table column consistency |
| 7 Oct 19:56 | PowerShell | Check which dev ports are listening |
| 7 Oct 19:56 | bash | Read dev scripts and server startup code |
| 7 Oct 19:56 | bash | Read the startup schema check |
| 7 Oct 19:56 | PowerShell | List node processes with command lines |
| 7 Oct 19:57 | bash | See how the server loads its .env |
| 7 Oct 19:57 | bash | Check whether the server config accepts the real .env |
| 7 Oct 20:02 | bash | Read startup recovery query and new schema columns |
| 7 Oct 20:02 | bash | Show which startup settings are set, without values |
| 7 Oct 20:02 | bash | Check origin normalization and datasource settings |
| 7 Oct 20:03 | bash | Read manager.intent and engine turnId |
| 7 Oct 20:06 | PowerShell | List node processes and every listening port |
| 7 Oct 20:06 | bash | Show API URLs (host only), recent source changes, logs |
| 7 Oct 20:06 | bash | List dev logs by time and read the embedded Postgres harness |
| 7 Oct 20:06 | bash | Read the --exec section of the disposable DB harness |
| 7 Oct 20:06 | bash | Read guest route and terms check |
| 7 Oct 20:07 | bash | Boot the real server source against the disposable database |
| 7 Oct 20:08 | bash | List migrations and read the harness migration step |
| 7 Oct 20:08 | bash | Read how the harness starts the cluster and migrates |
| 7 Oct 20:17 | PowerShell | Check watcher children, boot time and reserved ports |
| 7 Oct 20:17 | bash | Check build timestamps, Prisma setup and end of server entry |
| 7 Oct 20:17 | PowerShell | Retry: watcher children, boot time, reserved ports |
| 7 Oct 20:19 | bash | Test network reachability of the Supabase database host |
| 7 Oct 20:19 | bash | Read DB layer import and what the new migrations add |
| 7 Oct 20:19 | bash | Run the read-only connect and schema probe |
| 7 Oct 20:20 | bash | Control test: does this PC have IPv6 and IPv4 internet |
| 7 Oct 20:26 | bash | Test the IPv4 pooler and find message references |
| 7 Oct 20:26 | bash | Read mutate and socket handler structure |
| 7 Oct 20:26 | bash | Find how the buy-in dialog decides success |
| 7 Oct 20:26 | bash | Find the fixture server contract and shared ack types |
| 7 Oct 20:27 | bash | Check engine exports, tsx options and test helpers |
| 7 Oct 20:27 | bash | Read engine exports and game-flow test setup |
| 7 Oct 20:28 | bash | Read README setup, env template and message tests |
| 7 Oct 20:28 | bash | Read the in-memory auth database helper |
| 7 Oct 20:29 | bash | Read the env template and README run section |
| 7 Oct 20:29 | bash | Check whether today's build rewrote shared packages |
| 7 Oct 20:30 | bash | Read manager imports, patchBankroll and error serializer |
| 7 Oct 20:30 | bash | Check which error messages the serializer keeps |
| 7 Oct 20:32 | bash | Find tests tied to the schema check or raw query style |
| 7 Oct 20:32 | bash | Read the existing schema-check test |
| 7 Oct 20:34 | bash | Typecheck, rebuild server, run the new tests |
| 7 Oct 20:34 | bash | Read table-creation schema and legal action shape |
| 7 Oct 20:35 | bash | Read createTableSchema, create response and legal actions |
| 7 Oct 20:35 | bash | Check role creation guards and harness exports |
| 7 Oct 20:36 | bash | Run the end-to-end check on a throwaway Postgres |
| 7 Oct 20:42 | bash | Check what Prisma prints on a failed connect in dev |
| 7 Oct 20:42 | bash | Run the full server and ledger test suites |
| 7 Oct 20:42 | bash | Run the browser suite on ports 3107/4107 [bg] |
| 7 Oct 20:44 | PowerShell | Check whether the dev game server restarted |
| 7 Oct 20:44 | bash | Compare generated Prisma client schema with source schema |
| 7 Oct 20:44 | bash | Compare schemas ignoring whitespace and comments |
| 7 Oct 20:45 | bash | Regenerate the Prisma client and confirm it matches |
| 7 Oct 20:45 | bash | Re-run typecheck, server suite and end-to-end check |
| 7 Oct 20:51 | bash | Read browser suite result after the fix |
| 7 Oct 20:52 | bash | Extract the chronological action log from the transcript |
| 7 Oct 20:52 | bash | List user requests and every file write in order |
| 7 Oct 20:52 | bash | List user requests and every file write in order |
| 7 Oct 20:52 | bash | Print user requests and file writes in order |
| 7 Oct 20:52 | bash | Find the published page link and list files I created |
| 7 Oct 20:53 | bash | Show the artifact publish call and its result |
| 7 Oct 20:53 | bash | Recover what was changed in the Claude settings file |
| 7 Oct 20:54 | bash | Check Supabase migration copies and migrate connection |
| 7 Oct 20:54 | bash | Locate the progress.md lines to update |
| 7 Oct 20:59 | bash | Generate opuswork.md and list its headings |
| 7 Oct 20:59 | bash | Spot-check tables and scan for credentials |
| 7 Oct 20:59 | bash | Check table column consistency in opuswork.md |
| 7 Oct 20:59 | bash | Inspect the two rows with extra columns |
| 7 Oct 20:59 | bash | Confirm the extra columns are escaped pipes |
| 7 Oct 20:59 | bash | Show raw characters around the extra pipe |
| 7 Oct 21:05 | bash | Check the review workflow's progress |
| 7 Oct 21:05 | bash | Read where the engine starts a turn and bumps turnSeq |
| 7 Oct 21:05 | bash | Check every place the actor changes |
| 7 Oct 21:05 | bash | Check table shapes in the edited markdown files |
| 7 Oct 21:06 | bash | Check reviewer progress |
| 7 Oct 21:11 | bash | Check whether the reviewers have finished |
| 7 Oct 21:11 | bash | Show the last entries of each reviewer transcript |
| 7 Oct 21:13 | bash | Check dev build folder, e2e timing and lockout wording |
| 7 Oct 21:13 | bash | Show the exact lockout sentences to soften |
| 7 Oct 21:14 | bash | Re-read every changed server code block |
| 7 Oct 21:14 | bash | Regenerate opuswork.md and re-run all checks |
| 7 Oct 21:14 | bash | Confirm the localhost tip and list final changed files |
| 7 Oct 21:16 | bash | Measure the source documents not yet in the log |
| 7 Oct 21:17 | bash | Check heading depths and scan the documents to embed |
| 7 Oct 21:18 | bash | List today's command descriptions from the transcript |
| 7 Oct 21:19 | bash | Regenerate the full log and run all checks |
| 7 Oct 21:20 | bash | Spot-check Appendices F and L |
| 7 Oct 21:20 | bash | Regenerate with clean dates and re-check |
| 7 Oct 21:20 | bash | Confirm the stray date spaces are gone |
| 7 Oct 21:24 | bash | Regenerate the log with the scorecard and re-check |
| 7 Oct 21:28 | bash | Check change counts and regenerate the log with section 8 |
| 7 Oct 21:58 | bash | Check remote, branch, ignore rules and untracked groups |
| 7 Oct 21:58 | bash | Scan untracked files for secrets, tokens and size |
| 7 Oct 21:59 | bash | Rebuild pre-fix versions of my 8 edited files |
| 7 Oct 22:00 | bash | Verify pre-fix versions and list root-level changes |
| 7 Oct 22:00 | bash | Create branch and commit earlier work and reviews in groups |
| 7 Oct 22:00 | bash | Show the new commits and what remains uncommitted |
| 7 Oct 22:02 | bash | Update the stale engine test and run it |
| 7 Oct 22:02 | bash | Read the privilege test matrix and incident-table grants |
| 7 Oct 22:03 | bash | Read the refusal helper and check Supabase copy tests |
| 7 Oct 22:03 | bash | Read asRuntime helper and compare migration copies |
| 7 Oct 22:03 | bash | Run the real-database suite with the new migration |
| 7 Oct 22:05 | bash | List shared payload types and server imports |
| 7 Oct 22:05 | bash | Read rehydrate and renew payloads and their parsers |
| 7 Oct 22:05 | bash | Use the named sit/stand schema in both handlers |
| 7 Oct 22:06 | bash | Typecheck the server and prove the guard catches drift |
| 7 Oct 22:06 | bash | Rebuild server and run socket-related tests |
| 7 Oct 22:06 | bash | Read the table manager's timer and showdown code |
| 7 Oct 22:07 | bash | Read tryStart, cash-out type and the deal-fault technique |
| 7 Oct 22:07 | bash | Read manager lifecycle and engine clean-up exports |
| 7 Oct 22:08 | bash | Read the cash-out loop and hand-recording comment |
| 7 Oct 22:08 | bash | Read standUp and how a settled hand handles leavers |
| 7 Oct 22:09 | bash | Rebuild server and run the new money-safety tests |
| 7 Oct 22:09 | bash | Run the full server suite after the money fixes |
| 7 Oct 22:10 | bash | Show the three failures in detail |
| 7 Oct 22:10 | bash | Show the failure details from the summary |
| 7 Oct 22:10 | bash | Extract the assertion lines of the lifecycle failures |
| 7 Oct 22:10 | bash | Read the two failing lifecycle tests and their helpers |
| 7 Oct 22:10 | bash | Find the static-scan pattern line |
| 7 Oct 22:11 | bash | Rebuild and rerun the full server suite |
| 7 Oct 22:11 | bash | Read recover() and the engine's turn-clock helpers |
| 7 Oct 22:12 | bash | Find table creation, clock-reset support and muck text |
| 7 Oct 22:12 | bash | Read the rules-text browser test and the muck section |
| 7 Oct 22:13 | bash | Read turnDeadline, time-bank config and the legacy-bot test |
| 7 Oct 22:13 | bash | Read the legacy-bot test header and config import |
| 7 Oct 22:14 | bash | Rebuild and run the full server suite after item 4 changes |
| 7 Oct 22:14 | bash | Read the restart-after-outage test |
| 7 Oct 22:15 | bash | Run the table-lifecycle tests after the update |
| 7 Oct 22:15 | bash | Read lifecycle test helpers and the bot test setup |
| 7 Oct 22:15 | bash | Read seating and move-collection patterns in the tests |
| 7 Oct 22:16 | bash | Check the end of the lifecycle test file and its imports |
| 7 Oct 22:16 | bash | Add time-bank and bot-switch tests and run them |
| 7 Oct 22:17 | bash | Typecheck web and run the legal-pages browser test |
| 7 Oct 22:19 | bash | Confirm the revert and read why the browser run failed |
| 7 Oct 22:19 | bash | Show the failing browser test details |
| 7 Oct 22:20 | bash | Re-run the legal-pages browser spec after the revert |
| 7 Oct 22:22 | bash | Find which browser test failed on the re-run |
| 7 Oct 22:22 | bash | Measure where shown/mucked cards are handled |
| 7 Oct 22:23 | bash | Check session IP data, IP normalization and lockout tests |
| 7 Oct 22:24 | bash | Check test IP simulation and fake session queries |
| 7 Oct 22:24 | bash | Read the existing lockout test |
| 7 Oct 22:25 | bash | Rebuild and run the full server suite with smart lockout |
| 7 Oct 22:26 | bash | Check local-database dependencies and Prisma config |
| 7 Oct 22:27 | bash | Locate the embedded Postgres package and ignore rules |
| 7 Oct 22:27 | bash | Ignore .local-db and add the dev:local npm script |
| 7 Oct 22:27 | bash | Test dev:local check mode twice |
| 7 Oct 22:28 | bash | Remove the test database and locate the startup hook |
| 7 Oct 22:28 | bash | Rebuild server and run startup and config tests |
| 7 Oct 22:29 | bash | Run every suite once more as the final check [bg] |
| 7 Oct 22:31 | bash | Check how far the final run has got |
| 7 Oct 22:32 | bash | Test-run the log generator with partial results |
| 7 Oct 22:47 | bash | Read the final run results |
| 7 Oct 22:47 | bash | Show the failing browser test in the final run |
| 7 Oct 22:47 | bash | Read the page snapshot at the failure |
| 7 Oct 22:47 | bash | Check fixture server state, imports and wallet answers |
| 7 Oct 22:48 | bash | Read the flaky test start and fixture reset usage |
| 7 Oct 22:48 | bash | Typecheck web and rerun the legal-pages browser spec |
| 7 Oct 20:4x–21:0x | bash | (after the transcript snapshot) Regenerated the Prisma client; re-ran typecheck, the server suite and the end-to-end check; extracted this log; generated this file |

## Appendix F: My code and documentation changes, exactly (7 October, evening)

Every edit I made to the application, its tests, the README and `.env.example`, shown as before and after. These come straight from the edit operations in the session transcript, and new files are shown in full. Scripts under `review/claude/` are not repeated here; they are in the repository. My `progress.md` text is in Appendix G.

### `apps/server/src/socket/index.ts` (7 Oct 20:31, edit)

Before:

````ts
const id = z.string().min(1).max(128);
const tablePayload = z.object({ tableId: id }).strict();
````

After:

````ts
const id = z.string().min(1).max(128);
const tablePayload = z.object({ tableId: id }).strict();
/**
 * Optional client command id (UUID) on seat, sit and stand-up commands
 * (SeatClaimPayload.commandId). Accepted so the web client's commands are not
 * refused by the strict schemas; outcomes are not yet stored for replay (F21).
 */
const commandIdField = { commandId: z.string().uuid().optional() };
/** PublicTableState.turnId: "<handNumber>:<turnSeq>" (engine turnIdOf). */
const turnIdSchema = z.string().regex(/^\d{1,12}:\d{1,12}$/);
````

### `apps/server/src/socket/index.ts` (7 Oct 20:31, edit)

Before:

````ts
const actionPayload =tablePayload.extend({ revision: z.number().int().nonnegative(), action: z.enum(["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"]), amount: z.number().int().positive().max(2_000_000_000).optional(), clientActionId: z.string().uuid() });
````

After:

````ts
const actionPayload =tablePayload.extend({ revision: z.number().int().nonnegative(), action: z.enum(["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"]), amount: z.number().int().positive().max(2_000_000_000).optional(), clientActionId: z.string().uuid(), turnId: turnIdSchema.optional() });
````

### `apps/server/src/socket/index.ts` (7 Oct 20:31, edit)

Before:

````ts
    socket.on(SOCKET_EVENTS.SEAT_CLAIM, (raw) => { void (async () => {
      const p = tablePayload.extend({ seatIndex: z.number().int().min(0).max(8), buyIn: z.number().int().positive().max(40_000_000) }).parse(raw);
      await checkTable(p.tableId);
      await tableManager.seatClaim(p.tableId, userId, p.seatIndex, p.buyIn);
      await tableManager.tryStart(p.tableId);
    })().catch((err) => failure(err, undefined, raw)); });
    socket.on(SOCKET_EVENTS.STAND_UP, (raw, ack) => { void (async () => {
      const p = tablePayload.parse(raw); await checkTable(p.tableId);
````

After:

````ts
    socket.on(SOCKET_EVENTS.SEAT_CLAIM, (raw, ack) => { void (async () => {
      const p = tablePayload.extend({ seatIndex: z.number().int().min(0).max(8), buyIn: z.number().int().positive().max(40_000_000), ...commandIdField }).parse(raw);
      await checkTable(p.tableId);
      await tableManager.seatClaim(p.tableId, userId, p.seatIndex, p.buyIn);
      // The claim is committed: acknowledge it before trying to deal, so a
      // failure to start a hand is never reported as a failed claim (CR-017).
      if (typeof ack === "function") ack({ ok: true });
      await tableManager.tryStart(p.tableId).catch((err) => logger.warn({ err, tableId: p.tableId }, "could not start a hand after a seat claim"));
    })().catch((err) => failure(err, ack, raw)); });
    socket.on(SOCKET_EVENTS.STAND_UP, (raw, ack) => { void (async () => {
      const p = tablePayload.extend(commandIdField).parse(raw); await checkTable(p.tableId);
````

### `apps/server/src/socket/index.ts` (7 Oct 20:31, edit)

Before:

````ts
    for (const event of [SOCKET_EVENTS.SIT_OUT, SOCKET_EVENTS.SIT_IN] as const) {
      socket.on(event, (raw) => { void (async () => {
        const p = tablePayload.parse(raw); await checkTable(p.tableId);
        await tableManager.sitToggle(p.tableId, userId, event === SOCKET_EVENTS.SIT_OUT);
        if (event === SOCKET_EVENTS.SIT_IN) await tableManager.tryStart(p.tableId);
      })().catch((err) => failure(err, undefined, raw)); });
    }
    socket.on(SOCKET_EVENTS.ACTION_INTENT, (raw, ack) => { void (async () => {
      const p = actionPayload.parse(raw);
      await checkTable(p.tableId);
      await tableManager.intent(p.tableId, userId, { action: p.action, amount: p.amount }, p.revision);
````

After:

````ts
    for (const event of [SOCKET_EVENTS.SIT_OUT, SOCKET_EVENTS.SIT_IN] as const) {
      socket.on(event, (raw, ack) => { void (async () => {
        const p = tablePayload.extend(commandIdField).parse(raw); await checkTable(p.tableId);
        await tableManager.sitToggle(p.tableId, userId, event === SOCKET_EVENTS.SIT_OUT);
        if (typeof ack === "function") ack({ ok: true });
        if (event === SOCKET_EVENTS.SIT_IN) await tableManager.tryStart(p.tableId).catch((err) => logger.warn({ err, tableId: p.tableId }, "could not start a hand after sit-in"));
      })().catch((err) => failure(err, ack, raw)); });
    }
    socket.on(SOCKET_EVENTS.ACTION_INTENT, (raw, ack) => { void (async () => {
      const p = actionPayload.parse(raw);
      await checkTable(p.tableId);
      await tableManager.intent(p.tableId, userId, { action: p.action, amount: p.amount }, p.revision, p.turnId);
````

### `apps/server/src/game/manager.ts` (7 Oct 20:31, edit)

Before:

````ts
  idleSince, keepTableOpen, leaveSeat, recordActivity, sitDown, sitIn, sitOut, startHand,
  type EngineIntent, type EngineTable,
} from "@poker/engine";
````

After:

````ts
  idleSince, keepTableOpen, leaveSeat, recordActivity, sitDown, sitIn, sitOut, startHand, turnIdOf,
  type EngineIntent, type EngineTable,
} from "@poker/engine";
````

### `apps/server/src/game/manager.ts` (7 Oct 20:31, edit)

Before:

````ts
  async intent(tableId: string, userId: string, intent: EngineIntent, revision: number): Promise<void> {
    await this.mutate(tableId, (table) => {
      if (table.turnStartedAt != null && Date.now() >= table.turnStartedAt + table.timeBankMs) throw new EngineError("TURN_EXPIRED", "Your turn has expired");
      // A player's own action is activity; time-outs and bot actions (armTimers) are not.
      return recordActivity(applyAction(table, userId, intent), Date.now(), userId);
    }, revision);
  }
````

After:

````ts
  /**
   * Apply a player's action. With `turnId` (the PublicTableState.turnId the
   * client chose it for), the action is stale only when that turn is over:
   * unrelated changes (someone sitting out, joining or leaving) bump the
   * revision but are not a new decision for the actor (CR-008). Without it,
   * any change since `revision` makes the action stale, as before.
   */
  async intent(tableId: string, userId: string, intent: EngineIntent, revision: number, turnId?: string): Promise<void> {
    await this.mutate(tableId, (table) => {
      if (turnId !== undefined && turnIdOf(table) !== turnId) throw new EngineError("STALE_ACTION", "The table changed; use the latest action buttons");
      if (table.turnStartedAt != null && Date.now() >= table.turnStartedAt + table.timeBankMs) throw new EngineError("TURN_EXPIRED", "Your turn has expired");
      // A player's own action is activity; time-outs and bot actions (armTimers) are not.
      return recordActivity(applyAction(table, userId, intent), Date.now(), userId);
    }, turnId === undefined ? revision : undefined);
  }
````

### `apps/server/src/game/manager.ts` (7 Oct 20:31, edit)

Before:

````ts
      const occupied = await tx.tableSeat.findFirst({ where: { userId } });
      if (occupied) throw new EngineError("ALREADY_SEATED", "Leave your current table before joining another");
      return next;
    });
    await this.patchBankroll(userId);
  }
````

After:

````ts
      const occupied = await tx.tableSeat.findFirst({ where: { userId } });
      if (occupied) throw new EngineError("ALREADY_SEATED", "Leave your current table before joining another");
      return next;
    });
    // The seat and the debit are committed: a failed balance notification must
    // not turn the claim into a reported failure (CR-017).
    await this.patchBankroll(userId).catch((err) => logger.warn({ err, userId, tableId }, "bankroll update not delivered after a seat claim"));
  }
````

### `apps/server/src/db/connect.ts` (7 Oct 20:31, new file)

````ts
/**
 * Start-up database connection with a plain-language diagnosis.
 *
 * The safe-log serializer drops the message of every Prisma error (it can
 * carry query input), so a failed `prisma.$connect()` used to be logged as a
 * bare "PrismaClientInitializationError" with no reason. Here the failure is
 * classified from Prisma's error code and turned into a sentence that names
 * only the database host:port (never the user or password) and what to check.
 *
 * In development a reachability failure is retried with back-off instead of
 * exiting: `tsx watch` does not restart a crashed server until a file
 * changes, so a database that is briefly unreachable (`npm run dev` started
 * before the network was up) would otherwise leave the API down for good.
 * In production the first failure is fatal, as before; the supervisor restarts
 * the process.
 */

export interface DatabaseFailure {
  /** Prisma's error code (P1001, ...) or null. */
  code: string | null;
  /** host:port from the connection URL, or null. Never the credentials. */
  host: string | null;
  /** True when the same settings may work later (network, server starting). */
  retryable: boolean;
  /** What went wrong and what to check, for the operator. */
  hint: string;
}

/** host:port of a connection URL (never user or password), or null. */
export function databaseHost(url: string | undefined): string | null {
  try {
    const host = new URL(url ?? "").host;
    return host || null;
  } catch {
    return null;
  }
}

/** Supabase's direct connection host (db.<project ref>.supabase.co), which has only an IPv6 address. */
const SUPABASE_DIRECT = /^db\.[a-z0-9]+\.supabase\.co(:\d+)?$/i;
/** Codes and socket errors a retry can outlast; credentials, TLS and URL errors cannot. */
const RETRYABLE = new Set(["P1001", "P1002", "P1008", "P1017", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function errorCode(err: unknown): string | null {
  const record = (typeof err === "object" && err !== null ? err : {}) as { errorCode?: unknown; code?: unknown };
  if (typeof record.errorCode === "string" && record.errorCode) return record.errorCode;
  if (typeof record.code === "string" && record.code) return record.code;
  return null;
}

/** Classify a failed connection. Reads Prisma's message only to recognise it; never copies it. */
export function describeDatabaseFailure(err: unknown, url: string | undefined): DatabaseFailure {
  const host = databaseHost(url);
  const at = host ? `the database at ${host}` : "the database";
  const message = typeof (err as { message?: unknown })?.message === "string" ? (err as { message: string }).message : "";
  let code = errorCode(err);
  // Prisma names some failures only in the message.
  if (!code && /can't reach database server/i.test(message)) code = "P1001";
  if (!code && /authentication failed/i.test(message)) code = "P1000";
  const retryable = code !== null && RETRYABLE.has(code);
  let hint: string;
  switch (code) {
    case "P1000":
      hint = `${at} rejected the login in DATABASE_URL (wrong user or password).`;
      break;
    case "P1003":
      hint = `The database named in DATABASE_URL does not exist on ${host ?? "that server"}.`;
      break;
    case "P1010":
      hint = `The user in DATABASE_URL is not allowed to connect to ${at}.`;
      break;
    case "P1011":
      hint = `The TLS connection to ${at} failed: check sslmode and the sslcert path in DATABASE_URL.`;
      break;
    case "P1013":
      hint = "DATABASE_URL is not a valid connection string.";
      break;
    default:
      hint = retryable
        ? `Cannot reach ${at}. Check the internet connection, any VPN or firewall, and DATABASE_URL in .env.`
        : `Could not connect to ${at}${code ? ` (${code})` : ""}. Check DATABASE_URL in .env.`;
  }
  if (retryable && host && SUPABASE_DIRECT.test(host)) {
    hint += " This is Supabase's direct host, which has only an IPv6 address: on a network without working IPv6,"
      + " use the Session pooler connection string instead (Supabase dashboard, Connect, Session pooler), which works over IPv4.";
  }
  return { code, host, retryable, hint };
}

/** Thrown when the database cannot be used at start-up. Its message is the hint (safe to log). */
export class DatabaseConnectError extends Error {
  readonly code: string | null;
  constructor(failure: DatabaseFailure, options: { cause: unknown }) {
    super(failure.hint, options);
    this.name = "DatabaseConnectError";
    this.code = failure.code;
  }
}

export interface ConnectOptions {
  /** DATABASE_URL, used only for its host:port in messages. */
  url: string | undefined;
  /** Retry reachability failures with back-off (development) instead of failing at once. */
  retry: boolean;
  /** Called before each retry wait. */
  onRetry?: (failure: DatabaseFailure, attempt: number, delayMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Longest wait between attempts. */
  maxDelayMs?: number;
}

/** Connect, retrying reachability failures when `retry` is set. Throws DatabaseConnectError otherwise. */
export async function connectDatabase(client: { $connect(): Promise<void> }, options: ConnectOptions): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.$connect();
      return;
    } catch (err) {
      const failure = describeDatabaseFailure(err, options.url);
      if (!options.retry || !failure.retryable) throw new DatabaseConnectError(failure, { cause: err });
      const delayMs = Math.min(maxDelayMs, 1_000 * 2 ** Math.min(attempt - 1, 10));
      options.onRetry?.(failure, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
````

### `apps/server/src/index.ts` (7 Oct 20:31, edit)

Before:

````ts
async function main() {
  await connectRedis();
  await prisma.$connect();
  await assertGameSchemaReady();
````

After:

````ts
async function main() {
  await connectRedis();
  await connectDatabase(prisma, {
    url: env.DATABASE_URL,
    // tsx watch does not restart a crashed server, so in development wait for the database instead of exiting.
    retry: env.NODE_ENV === "development",
    onRetry: (failure, attempt, delayMs) => logger.warn({ code: failure.code, host: failure.host, attempt, retryInMs: delayMs },
      `database unavailable: ${failure.hint} Retrying in ${Math.round(delayMs / 1000)} s.`),
  });
  await assertGameSchemaReady();
````

### `apps/server/src/index.ts` (7 Oct 20:31, edit)

Before:

````ts
import { assertGameSchemaReady, prisma } from "./db/prisma.js";
````

After:

````ts
import { connectDatabase } from "./db/connect.js";
import { assertGameSchemaReady, prisma } from "./db/prisma.js";
````

### `apps/server/src/db/prisma.ts` (7 Oct 20:32, edit)

Before:

````ts
/** Refuse to accept games when code and hand-history storage are out of sync. */
export async function assertGameSchemaReady(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT "handUuid", "deckCommitment", "finalStateHash", "auditRecord", "auditSealed" FROM public."Hand" LIMIT 0`;
  } catch (cause) {
    const error = cause as { code?: string; meta?: { code?: string } };
    if (error.code !== "P2022" && error.meta?.code !== "42703") throw cause;
    throw new Error("Database is missing the compliance audit columns. Apply migration 20260924120000_compliance_audit_trail before starting the game server.", { cause });
  }
}
````

After:

````ts
/**
 * Columns this version reads, by the migration that adds them. Prisma selects
 * every column of a model, so without them every sign-in, lobby and table
 * request fails while the server itself looks healthy.
 */
const REQUIRED_SCHEMA: { migration: string; probe: () => Promise<unknown> }[] = [
  { migration: "20260924120000_compliance_audit_trail", probe: () => prisma.$queryRaw`SELECT "handUuid", "deckCommitment", "finalStateHash", "auditRecord", "auditSealed" FROM public."Hand" LIMIT 0` },
  { migration: "20261001100000_auth_hardening", probe: () => prisma.$queryRaw`SELECT "usernameCanonical", "failedLoginCount", "lockedUntil", "termsVersion", "termsAcceptedAt", "ageConfirmedAt" FROM public."User" LIMIT 0` },
  { migration: "20261001100000_auth_hardening", probe: () => prisma.$queryRaw`SELECT "lastUsedAt", "absoluteExpiresAt", "previousTokenHash", "rotatedAt", "revokedAt", "revokeReason" FROM public."Session" LIMIT 0` },
  { migration: "20261003100000_game_reliability", probe: () => prisma.$queryRaw`SELECT "pausedAt", "pausedReason" FROM public."Table" LIMIT 0` },
];

/** Postgres "undefined column" or "undefined table", however Prisma reports it. */
function isMissingSchema(cause: unknown): boolean {
  const error = cause as { code?: string; meta?: { code?: string } };
  return error.code === "P2021" || error.code === "P2022" || error.meta?.code === "42703" || error.meta?.code === "42P01";
}

/** Refuse to start when the database is missing migrations this version needs, and name them. */
export async function assertGameSchemaReady(): Promise<void> {
  const missing = new Set<string>();
  let firstCause: unknown;
  for (const { migration, probe } of REQUIRED_SCHEMA) {
    try {
      await probe();
    } catch (cause) {
      if (!isMissingSchema(cause)) throw cause;
      missing.add(migration);
      firstCause ??= cause;
    }
  }
  if (missing.size > 0) {
    throw new Error(`Database is missing migration(s) ${[...missing].join(", ")}. Apply the pending migrations (README, "Database and migrations") before starting the game server.`, { cause: firstCause });
  }
}
````

### `apps/web/src/lib/api.ts` (7 Oct 20:32, edit)

Before:

````ts
export const API_UNAVAILABLE_MESSAGE = process.env.NODE_ENV === "development"
  ? "Game server unavailable. Start both services with npm run dev, then retry."
  : "Game server unavailable. Check your connection and try again shortly.";
````

After:

````ts
// In development the usual cause is a game server that stopped while the web
// app kept running (npm run dev shows both); the reason is in its own output.
export const API_UNAVAILABLE_MESSAGE = process.env.NODE_ENV === "development"
  ? `Game server unavailable: nothing answers at ${API_URL}. If npm run dev is already running, its game server has stopped; the reason is in that terminal's [server] lines. Fix it, then restart npm run dev.`
  : "Game server unavailable. Check your connection and try again shortly.";
````

### `apps/server/test/socket-contract.test.mjs` (7 Oct 20:33, new file)

````js
/**
 * The real Socket.io server against the payloads today's web client sends
 * (apps/web/src/components/table/action-bar.tsx, buy-in-dialog.tsx,
 * table-controls.tsx), and the turn-identity staleness rule in the real
 * TableManager. The browser suite cannot catch a contract mismatch: its
 * fixture server (apps/web/test/support/game-server.mjs) does not validate
 * payloads. In-memory database only (run through test/support/run-tests.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createTable, EngineError, sitDown, startHand, turnIdOf } from '@poker/engine';
import { SOCKET_EVENTS } from '@poker/shared';
import { prisma } from '../dist/db/prisma.js';
import { TableManager, tableManager } from '../dist/game/manager.js';
import { decryptState, encryptState } from '../dist/game/encryption.js';
import { createSocketServer } from '../dist/socket/index.js';
import { env } from '../dist/config.js';
import { fakeAuthDb } from './support/auth-fake-db.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seatedTable = (tableId) => {
  let table = createTable({ tableId, name: 'Contract', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let seat = 0; seat < 3; seat++) table = sitDown(table, seat, { userId: `player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  return startHand(table);
};

/** The real socket server with the in-memory auth database, one table in a hand, and a connected user. */
async function socketServer(t) {
  const db = fakeAuthDb(t);
  const users = [0, 1, 2].map((i) => db.addUser({ username: `Seat_${i}` }));
  let table = createTable({ tableId: 'contract', name: 'Contract', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  users.forEach((u, i) => { table = sitDown(table, i, { userId: u.id, username: u.username, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 }); });
  table = startHand(table);
  const actor = users.find((u) => u.id === table.players[table.toActSeat].userId);
  db.table({ id: 'contract', name: 'Contract', status: 'IN_HAND', isPrivate: false, hostId: users[0].id, maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000,
    createdAt: new Date(), updatedAt: new Date(), stateCiphertext: encryptState(table, 'table:contract') });
  for (const u of users) db.seat(u.id, 'contract');
  const outsider = db.addUser({ username: 'Outsider' });
  const server = createServer();
  const io = createSocketServer(server); tableManager.stop();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => { for (const c of clients) c.disconnect(); tableManager.stop(); await new Promise((resolve) => io.close(resolve)); tableManager.io = null; });
  const open = async (user) => {
    const c = connect(url, { transports: ['websocket'], extraHeaders: { Origin: env.CLIENT_ORIGIN }, auth: { token: db.addSession(user.id).accessToken }, reconnection: false });
    clients.push(c);
    const errors = [];
    c.on(SOCKET_EVENTS.SERVER_ERROR, (e) => errors.push(e));
    await once(c, SOCKET_EVENTS.AUTH_OK);
    return { c, errors };
  };
  return { actor, outsider, open };
}

test('ACTION_INTENT exactly as the web client sends it (with turnId) reaches the table manager with that turn', async (t) => {
  const { actor, open } = await socketServer(t);
  const intent = t.mock.method(tableManager, 'intent', async () => {});
  const { c } = await open(actor);
  c.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId: 'contract' });
  const [snap] = await once(c, SOCKET_EVENTS.STATE_SNAPSHOT);
  assert.ok(snap.actorLegal, 'the connected user is the actor');
  assert.match(snap.turnId, /^\d+:\d+$/);
  // apps/web/src/components/table/action-bar.tsx
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, {
    tableId: 'contract', revision: snap.revision, action: 'CALL', amount: undefined, clientActionId: crypto.randomUUID(), turnId: snap.turnId,
  });
  assert.deepEqual(reply, { ok: true });
  assert.equal(intent.mock.calls.length, 1);
  const [tableId, , engineIntent, revision, turnId] = intent.mock.calls[0].arguments;
  assert.deepEqual([tableId, engineIntent.action, revision, turnId], ['contract', 'CALL', snap.revision, snap.turnId]);
});

test('the action schema stays strict: a malformed turnId or an unknown key is refused before the manager', async (t) => {
  const { actor, open } = await socketServer(t);
  const intent = t.mock.method(tableManager, 'intent', async () => {});
  const { c } = await open(actor);
  const base = { tableId: 'contract', revision: 0, action: 'CALL', clientActionId: crypto.randomUUID() };
  for (const payload of [{ ...base, turnId: 'not-a-turn' }, { ...base, turnId: '1:2', extra: true }]) {
    const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, payload);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'INVALID_REQUEST');
  }
  assert.equal(intent.mock.calls.length, 0);
});

test('SEAT_CLAIM exactly as the buy-in dialog sends it (commandId and ack) is claimed and acknowledged', async (t) => {
  const { outsider, open } = await socketServer(t);
  const claim = t.mock.method(tableManager, 'seatClaim', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c, errors } = await open(outsider);
  // apps/web/src/components/table/buy-in-dialog.tsx
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400, commandId: crypto.randomUUID() });
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(claim.mock.calls.map((call) => call.arguments.slice(2)), [[4, 400]]);
  assert.deepEqual(errors, []);
});

test('a refused SEAT_CLAIM is acknowledged with its reason, and SERVER_ERROR names the table', async (t) => {
  const { outsider, open } = await socketServer(t);
  t.mock.method(tableManager, 'seatClaim', async () => { throw new EngineError('BANKROLL', 'Not enough bankroll'); });
  const { c, errors } = await open(outsider);
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400, commandId: crypto.randomUUID() });
  assert.deepEqual(reply, { ok: false, code: 'BANKROLL', message: 'Not enough bankroll' });
  await pause(50);
  assert.deepEqual(errors, [{ code: 'BANKROLL', message: 'Not enough bankroll', tableId: 'contract' }]);
});

test('a hand that fails to start after a committed claim is not reported as a failed claim (CR-017)', async (t) => {
  const { outsider, open } = await socketServer(t);
  t.mock.method(tableManager, 'seatClaim', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => { throw new Error('deal failed'); });
  const { c, errors } = await open(outsider);
  const reply = await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400, commandId: crypto.randomUUID() });
  assert.deepEqual(reply, { ok: true });
  await pause(100);
  assert.deepEqual(errors, []);
});

test('SEAT_CLAIM without commandId or ack (older clients) still claims', async (t) => {
  const { outsider, open } = await socketServer(t);
  const claim = t.mock.method(tableManager, 'seatClaim', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c, errors } = await open(outsider);
  c.emit(SOCKET_EVENTS.SEAT_CLAIM, { tableId: 'contract', seatIndex: 4, buyIn: 400 });
  for (let i = 0; i < 40 && claim.mock.calls.length === 0; i++) await pause(25);
  assert.equal(claim.mock.calls.length, 1);
  assert.deepEqual(errors, []);
});

test('SIT_OUT and SIT_IN accept a commandId and are acknowledged', async (t) => {
  const { actor, open } = await socketServer(t);
  const toggle = t.mock.method(tableManager, 'sitToggle', async () => {});
  t.mock.method(tableManager, 'tryStart', async () => {});
  const { c } = await open(actor);
  assert.deepEqual(await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SIT_OUT, { tableId: 'contract', commandId: crypto.randomUUID() }), { ok: true });
  assert.deepEqual(await c.timeout(3000).emitWithAck(SOCKET_EVENTS.SIT_IN, { tableId: 'contract' }), { ok: true });
  assert.deepEqual(toggle.mock.calls.map((call) => call.arguments[2]), [true, false]);
});

// --- turn identity in the real TableManager (in-memory persistence, as in game-flow.test.mjs) ---

function database(t) {
  let row = { id: 'turn-test', status: 'IN_HAND', isPrivate: false, hostId: 'player-0', stateCiphertext: encryptState(seatedTable('turn-test'), 'table:turn-test') };
  const replace = (target, name, implementation) => { const original = target[name]; target[name] = implementation; t.after(() => { target[name] = original; }); };
  replace(prisma.table, 'findUnique', async () => structuredClone(row));
  replace(prisma, '$transaction', async (run) => {
    let nextRow = structuredClone(row);
    const tx = {
      $queryRaw: async () => [{ id: row.id }],
      table: { findUnique: async () => structuredClone(nextRow), update: async ({ data }) => { nextRow = { ...nextRow, ...data }; return nextRow; } },
      tableSeat: { update: async (args) => args.data },
      user: { updateMany: async () => ({ count: 1 }) },
      hand: { create: async ({ data }) => data },
      botStatistic: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await run(tx);
    row = nextRow;
    return result;
  });
  return { state: () => decryptState(row.stateCiphertext, 'table:turn-test') };
}

test('an action for the current turn is accepted after an unrelated change bumped the revision (CR-008)', async (t) => {
  const db = database(t);
  const manager = new TableManager(); manager.stop();
  const before = db.state();
  const actor = before.players[before.toActSeat].userId;
  const bystander = before.players.find((p) => p && p.userId !== actor).userId;
  await manager.sitToggle('turn-test', bystander, true);
  assert.notEqual(db.state().revision, before.revision, 'the sit-out changed the table');
  assert.equal(turnIdOf(db.state()), turnIdOf(before), 'but not the turn');
  await manager.intent('turn-test', actor, { action: 'CALL' }, before.revision, turnIdOf(before));
  assert.notEqual(db.state().toActSeat, before.toActSeat, 'the call was applied');
});

test('an action naming a turn that is over is refused as stale; without a turnId the revision rule still applies', async (t) => {
  const db = database(t);
  const manager = new TableManager(); manager.stop();
  const first = db.state();
  await manager.intent('turn-test', first.players[first.toActSeat].userId, { action: 'CALL' }, first.revision, turnIdOf(first));
  const second = db.state();
  const nextActor = second.players[second.toActSeat].userId;
  await assert.rejects(manager.intent('turn-test', nextActor, { action: 'CALL' }, second.revision, turnIdOf(first)), { code: 'STALE_ACTION' });
  await assert.rejects(manager.intent('turn-test', nextActor, { action: 'CALL' }, first.revision), { code: 'STALE_ACTION' });
  assert.equal(db.state().toActSeat, second.toActSeat, 'nothing was applied');
});
````

### `apps/server/test/startup.test.mjs` (7 Oct 20:34, new file)

````js
/**
 * Start-up: the database connection is explained in plain words (the safe-log
 * serializer drops Prisma's own messages), retried in development, and the
 * schema check names every migration this version still needs. No database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDatabase, DatabaseConnectError, describeDatabaseFailure } from '../dist/db/connect.js';
import { assertGameSchemaReady, prisma } from '../dist/db/prisma.js';
import { serializeError } from '../dist/security/safe-log.js';

const SUPABASE_DIRECT = 'postgresql://poker_server:s3cret-pass@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require';
const POOLER = 'postgresql://poker_server.abcdefghijklmnopqrst:s3cret-pass@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require';
const prismaInitError = (message, errorCode) => Object.assign(new Error(message), { name: 'PrismaClientInitializationError', errorCode });
const unreachable = (host) => prismaInitError(`Can't reach database server at \`${host}\``, 'P1001');

test('an unreachable Supabase direct host is explained with the IPv6 advice; credentials are never named', () => {
  const failure = describeDatabaseFailure(unreachable('db.abcdefghijklmnopqrst.supabase.co:5432'), SUPABASE_DIRECT);
  assert.equal(failure.code, 'P1001');
  assert.equal(failure.retryable, true);
  assert.equal(failure.host, 'db.abcdefghijklmnopqrst.supabase.co:5432');
  assert.match(failure.hint, /^Cannot reach the database at db\.abcdefghijklmnopqrst\.supabase\.co:5432\./);
  assert.match(failure.hint, /IPv6/);
  assert.match(failure.hint, /Session pooler/);
  assert.doesNotMatch(failure.hint, /s3cret|poker_server/);
});

test('a pooler host gets no IPv6 advice, and a rejected login is not treated as retryable', () => {
  const pooler = describeDatabaseFailure(unreachable('aws-0-eu-west-1.pooler.supabase.com:5432'), POOLER);
  assert.equal(pooler.retryable, true);
  assert.doesNotMatch(pooler.hint, /IPv6/);
  const login = describeDatabaseFailure(prismaInitError('Authentication failed against database server', 'P1000'), POOLER);
  assert.equal(login.retryable, false);
  assert.match(login.hint, /rejected the login in DATABASE_URL/);
  assert.doesNotMatch(login.hint, /s3cret/);
  // A message-only Prisma error is still recognised.
  assert.equal(describeDatabaseFailure(new Error("Can't reach database server at `h:1`"), 'postgresql://h:1/db').code, 'P1001');
});

test('in development an unreachable database is retried with back-off until it answers', async () => {
  let calls = 0;
  const client = { $connect: async () => { if (++calls < 5) throw unreachable('h:5432'); } };
  const waits = [];
  const retries = [];
  await connectDatabase(client, { url: 'postgresql://u:p@h:5432/db', retry: true, maxDelayMs: 5_000,
    sleep: async (ms) => { waits.push(ms); }, onRetry: (failure, attempt) => retries.push([failure.code, attempt]) });
  assert.equal(calls, 5);
  assert.deepEqual(waits, [1000, 2000, 4000, 5000]);
  assert.deepEqual(retries, [['P1001', 1], ['P1001', 2], ['P1001', 3], ['P1001', 4]]);
});

test('without retry the first failure is fatal, and the logged error keeps the explanation', async () => {
  const client = { $connect: async () => { throw unreachable('db.abcdefghijklmnopqrst.supabase.co:5432'); } };
  let thrown;
  await assert.rejects(connectDatabase(client, { url: SUPABASE_DIRECT, retry: false }), (err) => { thrown = err; return true; });
  assert.ok(thrown instanceof DatabaseConnectError);
  assert.equal(thrown.code, 'P1001');
  const logged = serializeError(thrown, false);
  assert.equal(logged.name, 'DatabaseConnectError');
  assert.match(logged.message, /Cannot reach the database at db\.abcdefghijklmnopqrst\.supabase\.co:5432/);
  // Prisma's own message is still withheld by the serializer; ours carries the reason.
  assert.equal(logged.cause.name, 'PrismaClientInitializationError');
  assert.equal(logged.cause.message, undefined);
  assert.doesNotMatch(JSON.stringify(logged), /s3cret/);
});

test('a rejected login is fatal at once, even in development', async () => {
  let calls = 0;
  const client = { $connect: async () => { calls++; throw prismaInitError('Authentication failed against database server', 'P1000'); } };
  await assert.rejects(connectDatabase(client, { url: POOLER, retry: true, sleep: async () => {} }), { name: 'DatabaseConnectError', code: 'P1000' });
  assert.equal(calls, 1);
});

test('the schema check names every missing migration, passes a current database, and rethrows other errors', async (t) => {
  const original = prisma.$queryRaw;
  t.after(() => { prisma.$queryRaw = original; });
  const missingColumn = () => Object.assign(new Error('column does not exist'), { code: 'P2010', meta: { code: '42703' } });
  // A database at the 2026-09-24 schema: the October columns are missing.
  prisma.$queryRaw = async (strings) => {
    const sql = strings.join('?');
    if (sql.includes('"usernameCanonical"') || sql.includes('"previousTokenHash"') || sql.includes('"pausedAt"')) throw missingColumn();
    return [];
  };
  await assert.rejects(assertGameSchemaReady(), (err) => {
    assert.match(err.message, /20261001100000_auth_hardening/);
    assert.match(err.message, /20261003100000_game_reliability/);
    assert.doesNotMatch(err.message, /compliance_audit_trail/);
    assert.equal((err.message.match(/auth_hardening/g) ?? []).length, 1, 'each migration is named once');
    return true;
  });
  prisma.$queryRaw = async () => [];
  await assertGameSchemaReady();
  prisma.$queryRaw = async () => { throw new Error('database offline'); };
  await assert.rejects(assertGameSchemaReady(), /database offline/);
});
````

### `apps/server/package.json` (7 Oct 20:34, edit)

Before:

````json
test/platform-crypto.test.mjs test/platform-http.test.mjs",
````

After:

````json
test/platform-crypto.test.mjs test/platform-http.test.mjs test/socket-contract.test.mjs test/startup.test.mjs",
````

### `README.md` (7 Oct 20:43, edit)

Before:

````markdown
Open http://localhost:3000. The API and sockets use port 4000.
````

After:

````markdown
If the lobby says **Game server unavailable**, the web app is running but nothing answers on port 4000: the game server has stopped or is still waiting for its database. `npm run dev` keeps showing both programs after the server exits, and `tsx watch` restarts it only when a server file changes. The reason is in the `[server]` lines of that terminal:

- "database unavailable: Cannot reach the database at …": check the connection, VPN or firewall, and `DATABASE_URL`. In development the server keeps retrying. Supabase's direct host (`db.<project-ref>.supabase.co`) has only an IPv6 address; on a network without working IPv6, use the Session pooler connection string from the Supabase dashboard (Connect, Session pooler), which works over IPv4.
- "rejected the login in DATABASE_URL": wrong user or password.
- "Database is missing migration(s) …": apply the named migrations (see below) before starting the server.

After changing `.env`, stop `npm run dev` (Ctrl+C) and start it again.

Open http://localhost:3000. The API and sockets use port 4000.
````

### `.env.example` (7 Oct 20:43, edit)

Before:

````text
# Append sslcert=<URL-encoded absolute path to apps/server/certs/supabase-pooler-root.pem>.
````

After:

````text
# Append sslcert=<URL-encoded absolute path to apps/server/certs/supabase-pooler-root.pem>.
# Prefer the Session pooler string (works over IPv4); the direct host db.<ref>.supabase.co is IPv6-only.
````

### `apps/server/prisma/migrations/20261007200000_table_incident_column_grants/migration.sql` (7 Oct 22:03, new file)

````text
-- TableIncident is an audit trail: once an incident is recorded, only its
-- resolution (resolvedAt and resolvedBy, set together by an operator) may
-- change. 20261003100000_game_reliability granted the runtime role UPDATE on
-- the whole table, so kind, reason and createdAt could be rewritten after the
-- fact. Narrow UPDATE to the two resolution columns. Privileges only: no
-- table, column, constraint or row changes, so this is safe on a live database.
REVOKE UPDATE ON TABLE public."TableIncident" FROM poker_server;
GRANT UPDATE ("resolvedAt", "resolvedBy") ON TABLE public."TableIncident" TO poker_server;
````

### `supabase/migrations/20261007200000_table_incident_column_grants.sql` (7 Oct 22:03, new file)

````text
-- TableIncident is an audit trail: once an incident is recorded, only its
-- resolution (resolvedAt and resolvedBy, set together by an operator) may
-- change. 20261003100000_game_reliability granted the runtime role UPDATE on
-- the whole table, so kind, reason and createdAt could be rewritten after the
-- fact. Narrow UPDATE to the two resolution columns. Privileges only: no
-- table, column, constraint or row changes, so this is safe on a live database.
REVOKE UPDATE ON TABLE public."TableIncident" FROM poker_server;
GRANT UPDATE ("resolvedAt", "resolvedBy") ON TABLE public."TableIncident" TO poker_server;
````

### `apps/server/test/db/privileges.test.mjs` (7 Oct 22:03, edit)

Before:

````js
  LedgerEntry: ["SELECT"],
  _prisma_migrations: [],
};
````

After:

````js
  LedgerEntry: ["SELECT"],
  // Incidents are recorded, never rewritten or deleted; only their resolution
  // columns may be updated (EXPECTED_COLUMNS).
  TableIncident: ["SELECT", "INSERT"],
  _prisma_migrations: [],
};
/** Column-level grants beyond the table matrix, exactly: table -> privilege -> columns. */
const EXPECTED_COLUMNS = {
  TableIncident: { UPDATE: ["resolvedAt", "resolvedBy"] },
};
````

### `apps/server/test/db/privileges.test.mjs` (7 Oct 22:03, edit)

Before:

````js
  const extra = columns.filter((c) => !(EXPECTED[c.table_name] ?? []).includes(c.privilege_type));
  assert.deepEqual(extra, [], "no column-level grant goes beyond the table matrix");
});
````

After:

````js
  const columnGrant = (c) => (EXPECTED_COLUMNS[c.table_name]?.[c.privilege_type] ?? []).includes(c.column_name);
  const extra = columns.filter((c) => !(EXPECTED[c.table_name] ?? []).includes(c.privilege_type) && !columnGrant(c));
  assert.deepEqual(extra, [], "no column-level grant goes beyond the table matrix and EXPECTED_COLUMNS");
  for (const [table, byPrivilege] of Object.entries(EXPECTED_COLUMNS)) {
    for (const [privilege, expected] of Object.entries(byPrivilege)) {
      const granted = columns.filter((c) => c.table_name === table && c.privilege_type === privilege).map((c) => c.column_name).sort();
      assert.deepEqual(granted, [...expected].sort(), `${privilege} columns of ${table}`);
    }
  }
});

test("poker_server can resolve a TableIncident but never rewrite or delete one", async () => {
  // Privileges are checked when the statement is planned, so WHERE false needs no fixture rows.
  assert.equal(await asRuntime(`UPDATE public."TableIncident" SET "resolvedAt" = now(), "resolvedBy" = 'operator' WHERE false`), null);
  for (const column of ["kind", "reason", "createdAt", "tableId", "id"]) {
    await refusedAsRuntime(`UPDATE public."TableIncident" SET "${column}" = "${column}" WHERE false`);
  }
  await refusedAsRuntime(`DELETE FROM public."TableIncident" WHERE false`);
  await refusedAsRuntime(`TRUNCATE public."TableIncident"`);
});
````

### `apps/server/src/socket/index.ts` (7 Oct 22:05, edit)

Before:

````ts
import { SOCKET_EVENTS, type CommandAck } from "@poker/shared";
````

After:

````ts
import {
  SOCKET_EVENTS, type ActionIntentPayload, type CommandAck, type RehydratePayload, type SeatClaimPayload, type SessionRenewPayload,
  type SitTogglePayload, type TableJoinPayload,
} from "@poker/shared";
````

### `apps/server/src/socket/index.ts` (7 Oct 22:05, edit)

Before:

````ts
const actionPayload =tablePayload.extend({ revision: z.number().int().nonnegative(), action: z.enum(["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"]), amount: z.number().int().positive().max(2_000_000_000).optional(), clientActionId: z.string().uuid(), turnId: turnIdSchema.optional() });
````

After:

````ts
const actionPayload =tablePayload.extend({ revision: z.number().int().nonnegative(), action: z.enum(["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"]), amount: z.number().int().positive().max(2_000_000_000).optional(), clientActionId: z.string().uuid(), turnId: turnIdSchema.optional() });
const seatClaimPayload = tablePayload.extend({ seatIndex: z.number().int().min(0).max(8), buyIn: z.number().int().positive().max(40_000_000), ...commandIdField });
const sitTogglePayload = tablePayload.extend(commandIdField);
const rehydratePayload = z.object({ tableId: id.optional() });
const sessionRenewPayload = z.object({ token: z.string().min(1).max(4096) }).strict();

/**
 * Compile-time contract check: each socket schema accepts exactly the payload
 * type the web client is typed against (packages/shared/src/events.ts). A field
 * added on one side only, as turnId and commandId were (NEW-1), fails the
 * typecheck. Keys are compared as well, so a one-sided optional field counts.
 */
type SameKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never] ? true : false;
type Same<A, B> = SameKeys<A, B> extends true ? ([A] extends [B] ? ([B] extends [A] ? true : false) : false) : false;
const socketContract: {
  tableJoin: Same<z.infer<typeof tablePayload>, TableJoinPayload>;
  seatClaim: Same<z.infer<typeof seatClaimPayload>, SeatClaimPayload>;
  sitToggle: Same<z.infer<typeof sitTogglePayload>, SitTogglePayload>;
  actionIntent: Same<z.infer<typeof actionPayload>, ActionIntentPayload>;
  rehydrate: Same<z.infer<typeof rehydratePayload>, RehydratePayload>;
  sessionRenew: Same<z.infer<typeof sessionRenewPayload>, SessionRenewPayload>;
} = { tableJoin: true, seatClaim: true, sitToggle: true, actionIntent: true, rehydrate: true, sessionRenew: true };
void socketContract;
````

### `apps/server/src/socket/index.ts` (7 Oct 22:05, edit)

Before:

````ts
      const { token } = z.object({ token: z.string().min(1).max(4096) }).strict().parse(raw);
````

After:

````ts
      const { token } = sessionRenewPayload.parse(raw);
````

### `apps/server/src/socket/index.ts` (7 Oct 22:05, edit)

Before:

````ts
      const p = z.object({ tableId: id.optional() }).parse(raw);
````

After:

````ts
      const p = rehydratePayload.parse(raw);
````

### `apps/server/src/socket/index.ts` (7 Oct 22:05, edit)

Before:

````ts
      const p = tablePayload.extend({ seatIndex: z.number().int().min(0).max(8), buyIn: z.number().int().positive().max(40_000_000), ...commandIdField }).parse(raw);
````

After:

````ts
      const p = seatClaimPayload.parse(raw);
````

### `apps/server/src/game/manager.ts` (7 Oct 22:08, edit)

Before:

````ts
      run = () => this.mutate(table.tableId, (current) => {
        // Hand Clean-up purges the settled hand's secrets before the next shuffle.
        let next = completeHand(current);
        if (readyToDeal(next)) next = startHand(next);
        return next;
      }, table.revision);
````

After:

````ts
      // Hand Clean-up commits on its own: it purges the settled hand's secrets
      // and pays leavers' cash-outs. The next deal is a separate command
      // (armTimers schedules tryStart once the clean-up is committed), so a deal
      // that fails, for example on an RNG health check, can never undo the
      // clean-up or its payouts (CR-033).
      run = () => this.mutate(table.tableId, (current) => completeHand(current), table.revision);
````

### `apps/server/src/game/manager.ts` (7 Oct 22:08, edit)

Before:

````ts
  // No hand is dealt during the idle warning or once closure has begun (startHand
  // refuses too, and would roll back the SHOWDOWN timer's Hand Clean-up with it).
````

After:

````ts
  // No hand is dealt during the idle warning or once closure has begun (startHand
  // refuses too).
````

### `apps/server/src/game/manager.ts` (7 Oct 22:08, edit)

Before:

````ts
      for (const cash of result.cashOuts) {
        await tx.user.updateMany({ where: { id: cash.userId, kind: "HUMAN" }, data: { bankroll: { increment: cash.stack } } });
        paidUsers.add(cash.userId);
      }
      result.cashOuts = [];
      await this.persistSeats(tx, result, loaded.upgraded ? undefined : current);
      // A hand is recorded once, when it settles. The SHOWDOWN timer cleans up one
      // hand and deals the next in a single step, and that hand can settle at once
      // (all-in on the blinds), so compare hand numbers as well as phases.
````

After:

````ts
      for (const cash of result.cashOuts) {
        const paid = await tx.user.updateMany({ where: { id: cash.userId, kind: "HUMAN" }, data: { bankroll: { increment: cash.stack } } });
        // A human's credit must land exactly once, or the whole commit is undone
        // and the seat keeps its chips (F09). Only a bot's cash-out credits
        // nothing, by design.
        if (paid.count !== 1) {
          const owner = await tx.user.findUnique({ where: { id: cash.userId }, select: { kind: true } });
          if (!owner || owner.kind === "HUMAN") throw new EngineError("CASHOUT_FAILED", "A cash-out could not be credited; nothing was changed");
        }
        paidUsers.add(cash.userId);
      }
      result.cashOuts = [];
      await this.persistSeats(tx, result, loaded.upgraded ? undefined : current);
      // A hand is recorded once, when it settles. A deal (tryStart) can settle at
      // once (all-in on the blinds), so compare hand numbers as well as phases.
````

### `apps/server/test/hand-cleanup.test.mjs` (7 Oct 22:09, new file)

````js
/**
 * Money safety in the real TableManager (in-memory persistence, as in
 * game-flow.test.mjs; run through test/support/run-tests.mjs):
 * - CR-033: Hand Clean-up commits on its own, so a next deal that fails (here
 *   an RNG outage) cannot undo a leaver's cash-out;
 * - F09: a human's cash-out that credits no row rolls the whole commit back
 *   (the seat keeps its chips); a bot's cash-out credits nothing by design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { applyAction, createTable, leaveSeat, legalActions, sitDown, startHand } from '@poker/engine';
import { prisma } from '../dist/db/prisma.js';
import { TableManager } from '../dist/game/manager.js';
import { decryptState, encryptState } from '../dist/game/encryption.js';

const ID = 'cleanup-test';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seated = (count) => {
  let table = createTable({ tableId: ID, name: 'Clean-up', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let seat = 0; seat < count; seat++) table = sitDown(table, seat, { userId: `player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  return table;
};

/** In-memory Table row and wallet; `credit(userId)` is the row count a bankroll update reports. */
function database(t, initial, { credit = () => 1, kindOf = () => 'HUMAN' } = {}) {
  let row = { id: ID, status: 'IN_HAND', isPrivate: false, hostId: 'player-0', stateCiphertext: encryptState(initial, `table:${ID}`) };
  const credits = [];
  const replace = (target, name, implementation) => { const original = target[name]; target[name] = implementation; t.after(() => { target[name] = original; }); };
  replace(prisma.table, 'findUnique', async () => structuredClone(row));
  replace(prisma, '$transaction', async (run) => {
    let nextRow = structuredClone(row);
    const pending = [];
    const tx = {
      $queryRaw: async () => [{ id: row.id }],
      table: { findUnique: async () => structuredClone(nextRow), update: async ({ data }) => { nextRow = { ...nextRow, ...data }; return nextRow; } },
      tableSeat: { update: async (args) => args.data },
      user: {
        updateMany: async ({ where, data }) => { const count = credit(where.id); if (count) pending.push({ userId: where.id, amount: data.bankroll.increment }); return { count }; },
        findUnique: async ({ where }) => ({ kind: kindOf(where.id) }),
      },
      hand: { create: async ({ data }) => data },
      botStatistic: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await run(tx);
    row = nextRow; credits.push(...pending);
    return result;
  });
  return { credits, state: () => decryptState(row.stateCiphertext, `table:${ID}`) };
}

test('a failed next deal cannot undo Hand Clean-up: the leaver is paid once, then dealing resumes (CR-033)', async (t) => {
  // Three players; the first to act leaves (folded on their turn, cash-out pending), the next folds: the hand settles.
  let table = startHand(seated(3));
  const leaver = table.players[table.toActSeat].userId;
  table = leaveSeat(table, leaver);
  while (table.phase !== 'SHOWDOWN') {
    const actor = table.players[table.toActSeat];
    table = applyAction(table, actor.userId, { action: legalActions(table, actor.seatIndex).actions.includes('CHECK') ? 'CHECK' : 'FOLD' });
  }
  const owed = table.players.find((p) => p?.userId === leaver).stack;
  assert.ok(table.players.find((p) => p?.userId === leaver).pendingLeave, 'the leaver waits for Hand Clean-up');
  table.settledAt = Date.now() - 60_000; // the hand break is over: the SHOWDOWN timer fires at once
  const db = database(t, table);
  const manager = new TableManager();
  t.after(() => manager.stop());

  const realRandom = crypto.randomFillSync;
  crypto.randomFillSync = () => { throw new Error('Synthetic RNG outage'); };
  syncBuiltinESMExports();
  try {
    manager['armTimers'](table);
    for (let i = 0; i < 40 && db.state().phase === 'SHOWDOWN'; i++) await pause(25);
    await pause(400); // the next deal (tryStart) is attempted and fails on the RNG
    const after = db.state();
    assert.notEqual(after.phase, 'SHOWDOWN', 'Hand Clean-up committed');
    assert.equal(after.handNumber, table.handNumber, 'no hand was dealt during the outage');
    assert.equal(after.players.some((p) => p?.userId === leaver), false, 'the leaver\'s seat is released');
    assert.deepEqual(db.credits, [{ userId: leaver, amount: owed }], 'the leaver is paid exactly once');
  } finally {
    crypto.randomFillSync = realRandom;
    syncBuiltinESMExports();
  }
  await manager.tryStart(ID);
  assert.equal(db.state().handNumber, table.handNumber + 1, 'dealing resumes once the RNG is healthy');
  assert.deepEqual(db.credits, [{ userId: leaver, amount: owed }], 'and nobody is paid twice');
});

test('a human cash-out that credits no row rolls the whole commit back (F09)', async (t) => {
  const table = seated(2);
  const db = database(t, table, { credit: () => 0, kindOf: () => 'HUMAN' });
  const manager = new TableManager(); manager.stop();
  await assert.rejects(manager.standUp(ID, 'player-1'), { code: 'CASHOUT_FAILED' });
  assert.equal(db.state().players[1]?.userId, 'player-1', 'the seat keeps the player and the chips');
  assert.deepEqual(db.credits, []);
});

test('a bot cash-out credits nothing, by design, and still commits', async (t) => {
  const table = seated(2);
  const db = database(t, table, { credit: () => 0, kindOf: () => 'BOT' });
  const manager = new TableManager(); manager.stop();
  await manager.standUp(ID, 'player-1');
  assert.equal(db.state().players.some((p) => p?.userId === 'player-1'), false);
});
````

### `apps/server/package.json` (7 Oct 22:09, edit)

Before:

````json
test/socket-contract.test.mjs test/startup.test.mjs",
````

After:

````json
test/socket-contract.test.mjs test/startup.test.mjs test/hand-cleanup.test.mjs",
````

### `apps/server/src/game/manager.ts` (7 Oct 22:10, edit)

Before:

````ts
      // Hand Clean-up commits on its own: it purges the settled hand's secrets
      // and pays leavers' cash-outs. The next deal is a separate command
      // (armTimers schedules tryStart once the clean-up is committed), so a deal
      // that fails, for example on an RNG health check, can never undo the
      // clean-up or its payouts (CR-033).
      run = () => this.mutate(table.tableId, (current) => completeHand(current), table.revision);
````

After:

````ts
      // Hand Clean-up commits on its own: it purges the settled hand's secrets
      // and pays leavers' cash-outs. The next deal follows at once as a separate
      // command (tryStart), so a deal that fails, for example on an RNG health
      // check, can never undo the clean-up or its payouts (CR-033); it is retried.
      run = async () => {
        await this.mutate(table.tableId, (current) => completeHand(current), table.revision);
        await this.tryStart(table.tableId);
      };
````

### `apps/server/test/compliance.test.mjs` (7 Oct 22:11, edit)

Before:

````js
for \(const cash of result\.cashOuts\) \{\s*await tx\.user\.updateMany\(
````

After:

````js
for \(const cash of result\.cashOuts\) \{\s*(?:const paid = )?await tx\.user\.updateMany\(
````

### `apps/server/src/game/manager.ts` (7 Oct 22:13, edit)

Before:

````ts
  idleSince, keepTableOpen, leaveSeat, recordActivity, sitDown, sitIn, sitOut, startHand, turnIdOf,
  type EngineIntent, type EngineTable,
} from "@poker/engine";
````

After:

````ts
  idleSince, keepTableOpen, leaveSeat, rebaseTurnClock, recordActivity, sitDown, sitIn, sitOut, startHand, turnDeadline, turnIdOf,
  type EngineIntent, type EngineTable,
} from "@poker/engine";
import { gameConfig } from "../config.js";
````

### `apps/server/src/game/manager.ts` (7 Oct 22:13, edit)

Before:

````ts
    let table = createTable({ tableId: row.id, name: row.name, maxSeats: row.maxSeats, smallBlind: row.smallBlind, bigBlind: row.bigBlind, timeBankMs: row.timeBankMs, createdAt });
````

After:

````ts
    // A new table gets the personal time bank configured now (TIME_BANK_* in
    // config.ts, published in the House Rules); it is stored in the table's
    // state, so a later configuration change never alters a running table.
    let table = createTable({ tableId: row.id, name: row.name, maxSeats: row.maxSeats, smallBlind: row.smallBlind, bigBlind: row.bigBlind, timeBankMs: row.timeBankMs, createdAt, extraTimeBank: gameConfig.extraTimeBank });
````

### `apps/server/src/game/manager.ts` (7 Oct 22:13, edit)

Before:

````ts
        if (loaded.upgraded || this.staleWarning(loaded.table) || closeIfEmpty(loaded.table) !== loaded.table) {
          await this.mutate(row.id, (current) => this.staleWarning(current) ? clearIdleWarning(current) : current);
        } else this.armTimers(loaded.table);
````

After:

````ts
        // The player to act could not act while the server was down: their turn
        // restarts with a fresh base clock and no time bank charged (F10; the
        // House Rules promise it). rebaseTurnClock changes nothing when no
        // betting round is waiting on anyone.
        const resumed = rebaseTurnClock(loaded.table, Date.now(), "SERVER_RESUME") !== loaded.table;
        if (loaded.upgraded || resumed || this.staleWarning(loaded.table) || closeIfEmpty(loaded.table) !== loaded.table) {
          await this.mutate(row.id, (current) => rebaseTurnClock(this.staleWarning(current) ? clearIdleWarning(current) : current, Date.now(), "SERVER_RESUME"));
        } else this.armTimers(loaded.table);
````

### `apps/server/src/game/manager.ts` (7 Oct 22:13, edit)

Before:

````ts
      const actor = table.players[table.toActSeat]!;
      const remaining = Math.max(0, (table.turnStartedAt ?? Date.now()) + table.timeBankMs - Date.now());
      if (actor.kind === "BOT" && remaining > 0) {
        const decision = decideBotAction(table);
        delay = Math.max(0, Math.min(remaining, table.turnStartedAt! + decision.delayMs - Date.now()));
        run = () => this.mutate(table.tableId, (current) => Date.now() >= current.turnStartedAt! + current.timeBankMs ? applyTimeout(current) : applyAction(current, actor.userId, decision.intent), table.revision);
````

After:

````ts
      const actor = table.players[table.toActSeat]!;
      // The deadline includes the actor's personal time bank when the table has one.
      const remaining = Math.max(0, (turnDeadline(table) ?? Date.now()) - Date.now());
      // Legacy bots play only when ENABLE_LEGACY_BOTS is on (D11); otherwise a
      // bot's turn is treated like an absent player's and times out.
      if (actor.kind === "BOT" && gameConfig.enableLegacyBots && remaining > 0) {
        const decision = decideBotAction(table);
        delay = Math.max(0, Math.min(remaining, table.turnStartedAt! + decision.delayMs - Date.now()));
        run = () => this.mutate(table.tableId, (current) => Date.now() >= (turnDeadline(current) ?? 0) ? applyTimeout(current) : applyAction(current, actor.userId, decision.intent), table.revision);
````

### `apps/server/src/game/manager.ts` (7 Oct 22:13, edit)

Before:

````ts
      if (table.turnStartedAt != null && Date.now() >= table.turnStartedAt + table.timeBankMs) throw new EngineError("TURN_EXPIRED", "Your turn has expired");
````

After:

````ts
      const deadline = turnDeadline(table);
      if (deadline != null && Date.now() >= deadline) throw new EngineError("TURN_EXPIRED", "Your turn has expired");
````

### `apps/server/test/table-lifecycle.test.mjs` (7 Oct 22:13, edit)

Before:

````js
import { env } from '../dist/config.js';
````

After:

````js
import { env, gameConfig } from '../dist/config.js';

/** Legacy bots play only with ENABLE_LEGACY_BOTS on (off by default, D11); a test about their play turns them on. */
function legacyBotsOn(t) {
  const before = gameConfig.enableLegacyBots;
  gameConfig.enableLegacyBots = true;
  t.after(() => { gameConfig.enableLegacyBots = before; });
}
````

### `apps/server/test/table-lifecycle.test.mjs` (7 Oct 22:13, edit)

Before:

````js
test('idle: an AFK human and a bot on a legacy table: the bot\'s actions are not activity; the human is sat out by the time-out, warned at 5 minutes, closed, the human paid exactly once', async (t) => {
  mockClock(t);
````

After:

````js
test('idle: an AFK human and a bot on a legacy table: the bot\'s actions are not activity; the human is sat out by the time-out, warned at 5 minutes, closed, the human paid exactly once', async (t) => {
  mockClock(t);
  legacyBotsOn(t);
````

### `apps/server/test/table-lifecycle.test.mjs` (7 Oct 22:14, edit)

Before:

````js
  await manager.recover();
  assert.equal(db.log.tableUpdates.length, 0, 'current state: nothing to write at boot');
  assert.equal(manager.idleArmed.get(T).deadline, NOW + IDLE, 'timed from the restart, not from the hour-old activity');
````

After:

````js
  await manager.recover();
  // F10: the player to act could not act while the server was down, so their
  // turn restarts with a fresh base clock (one write, a TURN_CLOCK_RESET audit
  // event; the recorded hand is verified below).
  assert.equal(db.log.tableUpdates.length, 1, 'one write at boot: the fresh turn clock');
  assert.equal(db.state().turnStartedAt, NOW, 'the turn restarts at the restart, not an hour ago');
  assert.equal(db.state().toActSeat, hand.toActSeat, 'for the same player');
  assert.equal(manager.idleArmed.get(T).deadline, NOW + IDLE, 'timed from the restart, not from the hour-old activity');
````

### `apps/web/src/app/rules/page.tsx` (7 Oct 22:17, edit)

Before:

````tsx
          When the betting on the river is complete and two or more players remain, there is a showdown. Losing hands are
          mucked automatically; you never have to show a hand that cannot win.
        </p>
        <Bullets items={[
          "The first hand shown is that of the last player to bet or raise in the final betting round. If nobody bet in that round, the first player still in the hand to the left of the button shows first.",
          "Then, going clockwise, each remaining player's hand is shown only if it beats or ties the best hand already shown in at least one pot that player can win; otherwise it is mucked.",
          "Winning hands are always shown.",
          "All-in showdown: when players are all-in and the remaining community cards are dealt with no further betting possible, every live hand is shown.",
          "Mucked cards are never shown to other players. They remain in the sealed hand record available only to the operator and the regulator.",
        ]} />
````

After:

````tsx
          When the betting on the river is complete and two or more players remain, there is a showdown. Every hand still
          in play is shown to everyone at the table, spectators included, and the best hand wins. Hands cannot be mucked at
          the showdown.
        </p>
        <Bullets items={[
          "Losing hands that reach the showdown are shown as well as winning ones.",
          "Winning hands are always shown.",
          "All-in showdown: when players are all-in and the remaining community cards are dealt with no further betting possible, every live hand is shown.",
          "A hand folded before the showdown is never shown to other players. Every dealt card remains in the sealed hand record available only to the operator and the regulator.",
        ]} />
````

### `apps/web/test/browser/shell-legal.spec.ts` (7 Oct 22:17, edit)

Before:

````ts
"you are sat out automatically", "Losing hands are mucked automatically", "every live hand is shown",
````

After:

````ts
"you are sat out automatically", "Every hand still in play is shown", "every live hand is shown",
````

### `apps/web/src/app/rules/page.tsx` (7 Oct 22:19, edit)

Before:

````tsx
          When the betting on the river is complete and two or more players remain, there is a showdown. Every hand still
          in play is shown to everyone at the table, spectators included, and the best hand wins. Hands cannot be mucked at
          the showdown.
        </p>
        <Bullets items={[
          "Losing hands that reach the showdown are shown as well as winning ones.",
          "Winning hands are always shown.",
          "All-in showdown: when players are all-in and the remaining community cards are dealt with no further betting possible, every live hand is shown.",
          "A hand folded before the showdown is never shown to other players. Every dealt card remains in the sealed hand record available only to the operator and the regulator.",
        ]} />
````

After:

````tsx
          When the betting on the river is complete and two or more players remain, there is a showdown. Losing hands are
          mucked automatically; you never have to show a hand that cannot win.
        </p>
        <Bullets items={[
          "The first hand shown is that of the last player to bet or raise in the final betting round. If nobody bet in that round, the first player still in the hand to the left of the button shows first.",
          "Then, going clockwise, each remaining player's hand is shown only if it beats or ties the best hand already shown in at least one pot that player can win; otherwise it is mucked.",
          "Winning hands are always shown.",
          "All-in showdown: when players are all-in and the remaining community cards are dealt with no further betting possible, every live hand is shown.",
          "Mucked cards are never shown to other players. They remain in the sealed hand record available only to the operator and the regulator.",
        ]} />
````

### `apps/web/test/browser/shell-legal.spec.ts` (7 Oct 22:19, edit)

Before:

````ts
"you are sat out automatically", "Every hand still in play is shown", "every live hand is shown",
````

After:

````ts
"you are sat out automatically", "Losing hands are mucked automatically", "every live hand is shown",
````

### `apps/server/src/auth/smart-lockout.ts` (7 Oct 22:25, new file)

````ts
/**
 * Smart lockout for password sign-in (NEW-4).
 *
 * The per-account lock (failedLoginCount / lockedUntil on User, see
 * routes.ts) stops password guessing, but on its own anyone who knows a
 * username, and usernames are shown at every table, could keep its owner
 * locked out indefinitely. So the account lock applies to addresses the
 * account has never signed in from. An address one of the account's sessions
 * used in the last FAMILIAR_WINDOW_MS (IPv6 grouped by /56, as the rate
 * limiter does) is "familiar": the owner signing in from home is not locked
 * out by someone else's guesses. Failures from a familiar address are counted
 * here instead, per account and address, with the same escalating lock, so a
 * guesser sharing the owner's address is still slowed down (and the per-IP
 * credential limit in security/rate-limits.ts still applies).
 *
 * The familiar-address counters live in process memory: they reset on
 * restart and are per instance, like the other limiters (F20).
 */
import { ipKeyGenerator } from "express-rate-limit";

export const FAMILIAR_WINDOW_MS = 90 * 86_400_000;
/** Bounds the familiar-address counters; entries untouched for a day are dropped first. */
const MAX_ENTRIES = 10_000;
const STALE_MS = 86_400_000;
/** Queried for a sign-in that names no usable account, so every attempt does the same work. */
const NO_USER = "no-such-user";

interface SessionReader {
  session: { findMany(args: { where: object; select: { ip: true } }): Promise<{ ip: string | null }[]> };
}

/** The address key the rate limiter uses (IPv6 masked to /56), or null. */
export function addressKey(ip: string | null | undefined): string | null {
  return ip ? ipKeyGenerator(ip) : null;
}

/** True when one of the account's sessions from the last FAMILIAR_WINDOW_MS signed in from this address. */
export async function isFamiliarAddress(db: SessionReader, userId: string | null, ip: string | null | undefined, now: number): Promise<boolean> {
  const key = addressKey(ip);
  const rows = await db.session.findMany({
    where: { userId: userId ?? NO_USER, createdAt: { gte: new Date(now - FAMILIAR_WINDOW_MS) }, ip: { not: null } },
    select: { ip: true },
  });
  return key !== null && rows.some((row) => addressKey(row.ip) === key);
}

const familiar = new Map<string, { failures: number; lockedUntil: number; touchedAt: number }>();
const entryKey = (userId: string, ip: string | null | undefined) => `${userId}|${addressKey(ip) ?? "unknown"}`;

/** When the lock on this account from this familiar address ends (ms epoch; 0 when none). */
export function familiarLockedUntil(userId: string, ip: string | null | undefined): number {
  return familiar.get(entryKey(userId, ip))?.lockedUntil ?? 0;
}

/** Count a failed sign-in from a familiar address; returns the lock length started, if any (0 otherwise). */
export function recordFamiliarFailure(userId: string, ip: string | null | undefined, now: number, lockMs: (failures: number) => number): number {
  if (familiar.size >= MAX_ENTRIES) {
    for (const [key, entry] of familiar) if (now - entry.touchedAt > STALE_MS) familiar.delete(key);
    if (familiar.size >= MAX_ENTRIES) familiar.delete(familiar.keys().next().value!);
  }
  const key = entryKey(userId, ip);
  const entry = familiar.get(key) ?? { failures: 0, lockedUntil: 0, touchedAt: now };
  entry.failures += 1;
  entry.touchedAt = now;
  const lock = lockMs(entry.failures);
  if (lock) entry.lockedUntil = now + lock;
  familiar.set(key, entry);
  return lock;
}

/** A successful sign-in from this address clears its counter. */
export function clearFamiliarFailures(userId: string, ip: string | null | undefined): void {
  familiar.delete(entryKey(userId, ip));
}
````

### `apps/server/src/auth/routes.ts` (7 Oct 22:25, edit)

Before:

````ts
import { canonicalUsername, checkChosenUsername } from "./usernames.js";
````

After:

````ts
import { clearFamiliarFailures, familiarLockedUntil, isFamiliarAddress, recordFamiliarFailure } from "./smart-lockout.js";
import { canonicalUsername, checkChosenUsername } from "./usernames.js";
````

### `apps/server/src/auth/routes.ts` (7 Oct 22:25, edit)

Before:

````ts
 * bcrypt work), so the lock is neither a password oracle nor a signal an
 * attacker can probe; attempts during the lock do not extend it.
 */
````

After:

````ts
 * bcrypt work), so the lock is neither a password oracle nor a signal an
 * attacker can probe; attempts during the lock do not extend it.
 * Smart lockout (auth/smart-lockout.ts): this account lock applies to
 * addresses the account has never signed in from. From a familiar address the
 * owner is not locked out by others' guesses; failures there are counted per
 * account and address instead, with the same schedule.
 */
````

### `apps/server/src/auth/routes.ts` (7 Oct 22:25, edit)

Before:

````ts
  const now = Date.now();
  const user = await prisma.user.findUnique({ where: { usernameCanonical: canonicalUsername(parsed.data.username) } });
  const usable = user && user.kind === "HUMAN" && user.passwordHash ? user : null;
  const locked = usable?.lockedUntil != null && usable.lockedUntil.getTime() > now;
  // Exactly one bcrypt comparison on every path (see DUMMY_PASSWORD_HASH).
  const matches = await bcrypt.compare(parsed.data.password, usable && !locked ? usable.passwordHash! : DUMMY_PASSWORD_HASH);
  if (!usable || locked || !matches) {
    if (usable && !locked) await recordFailedLogin(usable.id, now);
    res.status(401).json({ error: INVALID_CREDENTIALS });
    return;
  }
  const fresh = await prisma.user.update({ where: { id: usable.id }, data: { lastSeenAt: new Date(now), failedLoginCount: 0, lockedUntil: null } });
````

After:

````ts
  const now = Date.now();
  const user = await prisma.user.findUnique({ where: { usernameCanonical: canonicalUsername(parsed.data.username) } });
  const usable = user && user.kind === "HUMAN" && user.passwordHash ? user : null;
  // Asked on every path, for a missing account too, so the work done does not reveal which case applied.
  const familiar = await isFamiliarAddress(prisma, usable?.id ?? null, req.ip, now);
  const locked = usable != null && (familiar
    ? familiarLockedUntil(usable.id, req.ip) > now
    : usable.lockedUntil != null && usable.lockedUntil.getTime() > now);
  // Exactly one bcrypt comparison on every path (see DUMMY_PASSWORD_HASH).
  const matches = await bcrypt.compare(parsed.data.password, usable && !locked ? usable.passwordHash! : DUMMY_PASSWORD_HASH);
  if (!usable || locked || !matches) {
    if (usable && !locked) {
      if (!familiar) await recordFailedLogin(usable.id, now);
      else {
        const lockMs = recordFamiliarFailure(usable.id, req.ip, now, loginLockMs);
        if (lockMs) logger.warn({ security: "LOGIN_LOCKOUT", userId: usable.id, scope: "familiar-address", lockMs }, "account locked for one familiar address after repeated failed logins");
      }
    }
    res.status(401).json({ error: INVALID_CREDENTIALS });
    return;
  }
  if (familiar && usable.lockedUntil != null && usable.lockedUntil.getTime() > now) {
    logger.info({ security: "LOGIN_FROM_FAMILIAR_ADDRESS_DURING_LOCK", userId: usable.id }, "signed in from a familiar address while the account was locked for other addresses");
  }
  clearFamiliarFailures(usable.id, req.ip);
  const fresh = await prisma.user.update({ where: { id: usable.id }, data: { lastSeenAt: new Date(now), failedLoginCount: 0, lockedUntil: null } });
````

### `apps/server/test/auth-http.test.mjs` (7 Oct 22:25, edit)

Before:

````js
// ---------------------------------------------------------------------------
// Items 6-9: registration conflicts, usernames, P2002 races, terms/age
````

After:

````js
test('login, smart lockout: others\' guesses cannot lock the owner out of an address they signed in from; failures there lock only that address (NEW-4)', async (t) => {
  const db = fakeAuthDb(t);
  const user = db.addUser({ username: 'Owner', password: PASSWORD });
  const request = await api(t);
  // The owner signs in once from this address; their session records it, so it is now familiar.
  assert.equal((await request('/auth/login', { body: { username: 'owner', password: PASSWORD } })).status, 200);
  // Guesses from other addresses locked the account (for every address it has never signed in from).
  db.user(user.id).failedLoginCount = 5;
  db.user(user.id).lockedUntil = new Date(Date.now() + 30_000);
  const owner = await request('/auth/login', { body: { username: 'owner', password: PASSWORD } });
  assert.equal(owner.status, 200, 'the owner still signs in from a familiar address');
  assert.equal(db.user(user.id).lockedUntil, null, 'and a successful sign-in clears the lock, as before');
  // Wrong passwords from the familiar address lock that address, on the same schedule, with the identical answer.
  for (let i = 1; i <= 5; i++) {
    const r = await request('/auth/login', { body: { username: 'owner', password: `wrong guess ${i}!` } });
    assert.deepEqual([r.status, r.body], [401, { error: 'Invalid credentials' }]);
  }
  const right = await request('/auth/login', { body: { username: 'owner', password: PASSWORD } });
  assert.deepEqual([right.status, right.body, right.setCookie], [401, { error: 'Invalid credentials' }, null], 'locked for this address');
  assert.equal(db.user(user.id).failedLoginCount, 0, 'familiar-address failures do not feed the account-wide lock');
});

// ---------------------------------------------------------------------------
// Items 6-9: registration conflicts, usernames, P2002 races, terms/age
````

### `scripts/dev-local.mjs` (7 Oct 22:27, new file)

````js
#!/usr/bin/env node
/**
 * Local development database.
 *
 * `npm run dev` uses the database configured in `.env` (the shared Supabase
 * database): every start of the game server runs table recovery on its live
 * tables, and the code under development must already match its schema.
 * `npm run dev:local` instead keeps a PostgreSQL cluster of its own in
 * `.local-db/` (git-ignored; the same embedded PostgreSQL binaries as
 * `npm run test:db`), applies every migration to it, and runs `npm run dev`
 * against it. `.env` is not changed and the configured database is never
 * contacted: DATABASE_URL and DIRECT_URL are set for the child process, and
 * dotenv never overrides a variable that is already set.
 *
 *   npm run dev:local              local database, then the web app and game server
 *   npm run dev:local -- --db      local database only; prints the URLs to use
 *   npm run dev:local -- --check   start, migrate, check the runtime login, stop
 *   npm run dev:local -- --reset   delete .local-db first (all local data), then start
 *
 * Local passwords are random and kept in .local-db/settings.json.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, ".local-db");
const clusterDir = join(dataDir, "cluster");
const settingsFile = join(dataDir, "settings.json");
const harness = await import(pathToFileURL(join(root, "apps", "server", "test", "support", "pg.mjs")).href);
const LOOPBACK = "127.0.0.1";
const DATABASE = "poker_dev";
const PREFERRED_PORT = 54329;
const args = new Set(process.argv.slice(2));
const log = (line) => console.log(`[local-db] ${line}`);

const portIsFree = (port) => new Promise((resolvePort) => {
  const probe = createServer();
  probe.once("error", () => resolvePort(false));
  probe.listen(port, LOOPBACK, () => probe.close(() => resolvePort(true)));
});
const anyFreePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, LOOPBACK, () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
});

if (args.has("--reset") && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
  log("deleted .local-db (all local data)");
}
mkdirSync(dataDir, { recursive: true });
let settings;
if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf8"));
else {
  const port = (await portIsFree(PREFERRED_PORT)) ? PREFERRED_PORT : await anyFreePort();
  settings = { port, superPassword: randomBytes(24).toString("hex"), runtimePassword: randomBytes(24).toString("hex") };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}
if (!(await portIsFree(settings.port))) {
  console.error(`[local-db] port ${settings.port} on ${LOOPBACK} is in use (is another dev:local running?). Stop it, or delete .local-db/settings.json to pick a new port.`);
  process.exit(1);
}

const cluster = new EmbeddedPostgres({
  databaseDir: clusterDir, port: settings.port, user: "postgres", password: settings.superPassword,
  authMethod: "scram-sha-256", persistent: true, initdbFlags: ["--encoding=UTF8"],
  // Loopback only; io_method=sync leaves no PostgreSQL 18 I/O worker behind on a hard stop.
  postgresFlags: ["-c", `listen_addresses=${LOOPBACK}`, "-c", "io_method=sync"],
  onLog: () => {}, onError: (message) => console.error("[local-db]", message instanceof Error ? message.message : String(message)),
});
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  try { await cluster.stop(); log("stopped"); } catch (err) { console.error("[local-db] could not stop cleanly:", err?.message ?? err); }
};

try {
  if (!existsSync(join(clusterDir, "PG_VERSION"))) {
    log("first run: creating a local PostgreSQL cluster in .local-db/");
    await cluster.initialise();
  }
  await cluster.start();
  const base = `postgresql://postgres:${settings.superPassword}@${LOOPBACK}:${settings.port}`;
  const maintenance = new pg.Client({ connectionString: `${base}/postgres?sslmode=disable` });
  await maintenance.connect();
  try {
    const { rowCount } = await maintenance.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE]);
    if (!rowCount) await maintenance.query(`CREATE DATABASE ${DATABASE}`);
  } finally { await maintenance.end(); }
  const adminUrl = `${base}/${DATABASE}?sslmode=disable`;
  harness.migrateDeploy(adminUrl); // refuses anything but this loopback database
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // The migrations create poker_server without LOGIN (production provisions it); locally it gets a password.
    await admin.query(`ALTER ROLE poker_server WITH LOGIN PASSWORD ${admin.escapeLiteral(settings.runtimePassword)}`);
  } finally { await admin.end(); }
  const runtimeUrl = `postgresql://poker_server:${settings.runtimePassword}@${LOOPBACK}:${settings.port}/${DATABASE}?sslmode=disable`;
  harness.assertLoopbackUrl(runtimeUrl, "local runtime URL");
  log(`ready on ${LOOPBACK}:${settings.port}, database ${DATABASE}, ${harness.migrationNames().length} migrations applied`);

  if (args.has("--check")) {
    const runtime = new pg.Client({ connectionString: runtimeUrl });
    await runtime.connect();
    const { rows: [who] } = await runtime.query("SELECT current_user AS role");
    await runtime.end();
    log(`runtime login works as ${who.role}`);
    await stop();
    process.exit(who.role === "poker_server" ? 0 : 1);
  }
  if (args.has("--db")) {
    log("database only. Use these (local, throwaway) URLs to run the servers yourself:");
    console.log(`  DATABASE_URL=${runtimeUrl}`);
    console.log(`  DIRECT_URL=${adminUrl}`);
    log("press Ctrl+C to stop");
    await new Promise((resolveStop) => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
    await stop();
    process.exit(0);
  }
  log("starting the web app and game server against the local database (npm run dev)");
  const child = spawn("npm run dev", { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, DATABASE_URL: runtimeUrl, DIRECT_URL: adminUrl } });
  // Ctrl+C reaches the child directly (same console); keep running until it exits, then stop the database.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const code = await new Promise((resolveExit) => child.on("exit", (exitCode) => resolveExit(exitCode ?? 0)));
  await stop();
  process.exit(code);
} catch (err) {
  console.error("[local-db] failed:", err?.message ?? err);
  await stop();
  process.exit(1);
}
````

### `apps/server/src/index.ts` (7 Oct 22:28, edit)

Before:

````ts
import { connectDatabase } from "./db/connect.js";
````

After:

````ts
import { connectDatabase, databaseHost } from "./db/connect.js";
````

### `apps/server/src/index.ts` (7 Oct 22:28, edit)

Before:

````ts
  await assertGameSchemaReady();
````

After:

````ts
  // A developer's machine running against a shared database runs table
  // recovery on that database's live tables at every start; npm run dev:local
  // gives development a database of its own.
  const dbHost = databaseHost(env.DATABASE_URL);
  if (env.NODE_ENV === "development" && dbHost && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(dbHost)) {
    logger.warn({ host: dbHost }, "development is using a remote database: every start runs table recovery on its tables. Use npm run dev:local for a local one.");
  }
  await assertGameSchemaReady();
````

### `README.md` (7 Oct 22:28, edit)

Before:

````markdown
On Windows PowerShell, use `npm.cmd run dev` if script execution blocks `npm.ps1`.
````

After:

````markdown
For development and testing on your own machine, prefer `npm run dev:local`: it runs the same web app and game server against a PostgreSQL database of its own in `.local-db/` (git-ignored, every migration applied), so changes under development never touch the shared database or real players' data. `npm run dev:local -- --db` starts only that database and prints its URLs; `-- --reset` deletes the local data. `npm run dev` uses the database configured in `.env`, and the game server warns at start-up when that database is not local.

On Windows PowerShell, use `npm.cmd run dev` if script execution blocks `npm.ps1`.
````

### `apps/web/test/browser/shell-legal.spec.ts` (7 Oct 22:48, edit)

Before:

````ts
  test("a guest account needs 18+ and terms, sends the acceptance as JSON, and is told it cannot be recovered", async ({ page }) => {
    await signedOut(page);
````

After:

````ts
  test("a guest account needs 18+ and terms, sends the acceptance as JSON, and is told it cannot be recovered", async ({ page, request }) => {
    // A brand-new guest holds no seat and the full starting bankroll. Without this reset the fixture's
    // hero is still seated from its default state (9,000 chips), and the lobby's first wallet refresh
    // replaced the 10,000 shown at sign-up before the check below could see it (flaky on desktop).
    await request.post(`${fixture}/__test/reset`, { data: { mode: "unseated" } });
    await signedOut(page);
````

## Appendix G: The progress.md text I wrote (word for word, as it is now)

The "Overall" paragraph and the two entries dated 2026-10-07. Headings are moved down two levels to fit this file.

**Overall (2026-10-07, evening): NO-GO for deposits, customer crypto custody, or redeemable game chips.** The stop-ship found earlier today (NEW-1: the real server refused every action and buy-in from the web client) is fixed and verified end to end against a real PostgreSQL. The working tree needs the three October migrations on whatever database it runs against; the game server now refuses to start and names them if they are missing. The backend has tested play-chip gameplay, authenticated encryption for hidden game state, audit mechanisms and production TLS guards. Uncommitted fixes from 1–7 October have closed or narrowed many findings. Remaining work:
- **Claude's review (2026-09-30), 41 findings:** 18 fixed, 14 partly fixed, 8 open, 1 awaiting a decision (CR-008 and CR-017 were fixed this evening).
- **The 2026-09-29 review, 22 findings and readiness gaps (5 Critical, 11 High, 6 Medium):** 3 fixed, 10 partly fixed, 7 open, 2 awaiting a decision. The real-money prerequisites F01–F05 (ledger in use, payments, identity/eligibility, AML, responsible gaming) are all still open or only partly done.
- **Today's re-check:** found 9 new defects in the October changes (NEW-1 now fixed). Fixing the lobby's "Game server unavailable" found 5 more (NEW-10 to NEW-14; 4 fixed). Full log: `opuswork.md`.

Not everything is encrypted, and the project has not been certified to MGA/GLI standards. Fixes, production validation and independent assurance remain outstanding. See the 2026-10-07 entry, `CLAUDE-REVIEW.md` and `GPT-6.1-SOL-REVIEW.md`.

---

#### 2026-10-07 (night) - "Fix now" list from opuswork.md section 8

**Status: stopped here for this session.**
- **Done:** items 1, 2, 3, 6 and 7 (except password reset by e-mail), and most of 4 and 5.
- **Left for a dedicated session:**
  - auto-muck in the engine (NEW-3; the House Rules are kept);
  - CR-004 (pause a broken table; operator void and refund);
  - password reset (needs an e-mail provider).
- **Not committed:** everything after the item 1 commits. The auto-mode safety check began blocking git commands right after those commits; `opuswork.md` section 9 has the commit commands for the owner.
- **Standard:** this is real-money online poker for players worldwide, with the company in Malta, held to the highest standard. The code is made to meet the published rules; the rules are never lowered.

**Final check (all suites, after the last change):**

| Suite | Result |
| --- | --- |
| Typecheck | 4/4 |
| Engine, as CI runs it | 430/430 (was 458/477 with 19 failures) |
| Server | 136/136 |
| Ledger | 21/21 |
| `test:db` | 44/44, 9 migrations |
| End to end on a real PostgreSQL | Pass |
| Browser | 155/156, then 40/40 for the spec file after the flaky test was fixed |

Every change is listed in `opuswork.md` section 9.3.

| # | Item | Status | Verified by |
| --- | --- | --- | --- |
| 1 | Commit the work on a branch | **Done (local only, not pushed).** Branch `fix-now-2026-10-07` holds 5 commits: engine and shared, server and database, web, CI/deploy/docs/tooling (all the uncommitted work from 24 Sep – 6 Oct, committed unchanged and split by area), then the reviews and logs. The 7 Oct evening fixes and everything below are not committed yet. `apps/web/next-env.d.ts` is left out on purpose (the dev server rewrites it). Not pushed: it is the client's repository, and it now contains security reviews | Commit list in the tool output |
| 3 | Get CI green | **Done (uncommitted).** Engine: `review-fixes.test.ts` now records what the shared check does with each forgery (19 money forgeries rejected, 10 outcome forgeries still pass it, 6 unchecked), replacing the outdated "card integrity always passes" assertion. Database: new migration `20261007200000_table_incident_column_grants` (with its Supabase copy) narrows TableIncident UPDATE to `resolvedAt`/`resolvedBy`; the privilege test lists TableIncident and its column grant, and a new test proves incidents can be resolved but not rewritten or deleted | Engine `review-fixes.test.ts` 94/94; `test:db` 44/44 (was 41/43). **Also:** the browser guest sign-up test (`shell-legal.spec.ts`) now resets the fixture server to "unseated" first, like the other tests. Before, the fixture's default seated hero (9,000 chips) made the "10,000 chips" check race the lobby's wallet refresh, and it failed 3 times tonight on desktop. That spec file then passed 40/40 |
| 2 | Develop against a local database (development machines only; the live site stays online on the production database) | **Done (uncommitted).**<ul><li>New `npm run dev:local` (`scripts/dev-local.mjs`): keeps a PostgreSQL of its own in `.local-db/` (git-ignored), with the same embedded binaries as `test:db`, every migration applied and a local `poker_server` login, then runs `npm run dev` against it. `.env` and the shared database are never touched.</li><li>Options: `-- --db` (database only, prints its URLs), `-- --check` and `-- --reset`.</li><li>The game server now warns at start-up in development when `DATABASE_URL` is not local.</li><li>README updated.</li></ul> | `dev:local --check` run twice: the first run created the cluster and applied all 9 migrations; the second reused it. The runtime login works as `poker_server`. The test copy was deleted afterwards; startup and config tests 13/13 |
| 4 | Make the published House Rules true (the code must meet the rules; the rules are not lowered) | **Partly done (uncommitted).**<ul><li>**Personal time bank (NEW-2):** new tables get the configured bank (30 s, +5 s per 10 hands, max 60 s); the server times turns, bot moves and late actions by `turnDeadline` (base time + bank).</li><li>**Fresh clock after a restart (F10):** `recover()` applies `rebaseTurnClock`, so the player to act gets a fresh base time and the hand records a TURN_CLOCK_RESET audit event.</li><li>**Bot switch (NEW-5):** `ENABLE_LEGACY_BOTS` now works (off by default, as documented): with it off a bot's turn times out like an absent player's.</li><li>A rules-text change I made for auto-muck was **reverted** at the owner's instruction (the House Rules keep auto-muck, as top real-money sites do); `rules/page.tsx` and `shell-legal.spec.ts` are back to the committed text.</li></ul>**Not done:** auto-muck of losing hands in the engine (NEW-3). It changes the showdown in `settle()` and both audit verifiers (with old records kept valid), so it is planned as its own fully tested change | Lifecycle tests 31/31, including 2 new tests (time bank timing, bots off by default) and the restart test updated to expect the fresh clock (its recorded hand still verifies); server suite (below) |
| 5 | Fix the ways chips can be trapped or lost | **Partly done (uncommitted).**<ul><li>**CR-033:** the SHOWDOWN timer now commits Hand Clean-up (cash-outs, released seats) on its own, then deals the next hand as a separate command, so a failed deal can no longer undo payouts; timing is unchanged.</li><li>**F09:** a human's cash-out whose bankroll update touches no row now rolls back the whole commit (the seat keeps its chips); a bot's cash-out still credits nothing, by design.</li></ul>**Not done:** CR-004 (pause a table that cannot load or settle, plus an operator void and refund). It is the largest item and is left for later | New `apps/server/test/hand-cleanup.test.mjs` (3 tests, including an RNG outage during the next deal); the compliance static scan was updated for the new cash-out check; server suite 133/133 |
| 6 | One schema for client and server | **Done (uncommitted).** Every socket schema in `apps/server/src/socket/index.ts` is now a named constant, and a compile-time contract check requires each one to accept exactly the payload type the web client is typed against (`packages/shared/src/events.ts`): same keys (optional ones included) and mutually assignable. A field added on one side only, the NEW-1 shape, now fails the typecheck. Chosen over moving zod into the shared package, which would need a new dependency | Server typecheck passes with all six payloads matching; a scratch file with a one-sided optional field fails with TS2322 as intended; socket, auth-socket and game-flow tests 22/22 |
| 7 | Replace the hard login lockout | **Done except password reset (uncommitted).** Smart lockout (`apps/server/src/auth/smart-lockout.ts`, wired in `auth/routes.ts` login): the account-wide lock now applies only to addresses the account has never signed in from. An address one of its sessions used in the last 90 days (IPv6 by /56, like the rate limiter) is familiar, and the owner signing in from it is not locked out by others' guesses. Failures from a familiar address lock that address only, on the same 30 s to 15 min schedule; they are counted in memory, per instance, like the other limiters. Every attempt does the same work (one session lookup and one bcrypt comparison), and every refusal is the same 401. New security log events: familiar-address lockout, and sign-in from a familiar address during a lock. **Not done:** password reset by e-mail, which needs an e-mail provider (owner decision) | New test in `auth-http.test.mjs`; the existing lockout test passes unchanged; server suite 136/136 |

---

#### 2026-10-07 (evening) - "Game server unavailable" in the lobby; joining tables fixed (NEW-1)

**Status: the code fixes are made and verified on disposable databases. The owner's dev game server still has to be restarted, and the live database's migration state was not checked (see below).** Full details, including every file changed in this session: [opuswork.md](2026-10-07-session-log.md).

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

#### 2026-10-07 - Claude's full review (41 findings), what GPT-6.1-Sol missed, and a re-check of the Oct 1–6 fixes

**Status: review finished on 2026-09-30 and re-checked today against the current working tree, including the uncommitted Oct 1–6 fixes.**
- **Stop-ship (fixed the same evening, see the entry above):** the current working tree must not be deployed, even for play chips. The real server refuses every action and every buy-in that today's web client sends (NEW-1 below).
- **Claude's 41 findings:** 16 fixed, 14 partly fixed, 8 open, 2 regressed (made worse), 1 waiting on an owner decision.
- **The 22 findings of the 2026-09-29 review:** 3 fixed, 10 partly fixed, 7 open, 2 waiting on a decision.
- **Re-check:** found 9 new defects in the Oct 1–6 changes.
- **Real money:** still NO-GO.

No application code, tests or databases were changed by this review or the re-check. Only new files were added: `CLAUDE-REVIEW.md`, `review/claude/**`, and this entry.

##### Who reviewed what

- **Claude (Anthropic)** reviewed every production file of the engine, shared package, server, web app, schema and migrations (159 files) on 2026-09-29/30.
  - It ran the existing suites, a 28,273-hand lifecycle fuzz and its own repro scripts.
  - Full report: [CLAUDE-REVIEW.md](2026-09-30-claude-review.md), with findings CR-001 to CR-041, decisions D1–D12 and legal register L1–L10. Repro scripts: `review/claude/repro/`.
- **GPT-6.1-Sol** reviewed the same tree at the same time, from the brief in [GPT-6.1-SOL-REVIEW-PROMPT.md](2026-09-29-gpt-review-brief.md).
  - Its report: [GPT-6.1-SOL-REVIEW.md](2026-09-30-gpt-review.md) (SOL-001 to SOL-052). Its scripts: `review/gpt-6.1-sol/repro/`.
  - Claude re-ran GPT's scripts. All 10 of its findings that Claude had not found reproduced, and they were adopted as CR-032 to CR-041.
- **Between 2026-10-01 and 2026-10-06, another session fixed many findings.** That work is uncommitted and has no progress.md entry of its own. It includes:
  - three migrations (`auth_hardening`, `ledger_foundation`, `game_reliability`);
  - new auth, money and security modules;
  - draft legal pages and an age and terms gate;
  - a buy-in dialog, turn clock, turn announcer and connection status;
  - CI, deploy configs and docs.
- **Today's re-check** went through every CR and F item against that code, using four independent checkers. Each re-ran or adapted the original repro, and I re-checked their evidence. The most serious result (NEW-1) I reproduced myself.

##### Stop-ship: defects introduced by the Oct 1–6 changes

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

##### Claude's 41 findings and their status on 2026-10-07

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

##### What GPT-6.1-Sol missed

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

##### The 2026-09-29 findings (F01–F22) on 2026-10-07

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

##### Verification performed (2026-10-07, current working tree)

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

##### What to do next (in order)

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

## Appendix H: The GPT-6.1-Sol review brief I wrote (`GPT-6.1-SOL-REVIEW-PROMPT.md`, word for word)

Headings are moved down two levels to fit this file.

### Review brief for GPT-6.1-Sol: find every defect in the Hold'em Live poker platform

Prepared by Claude (Anthropic) on 29 September 2026 at the project owner's request. Claude will implement the fixes after you finish, working from your report.

You are **GPT-6.1-Sol**, the lead reviewer for this repository. Review it the way a combined team would: a principal engineer, an application-security tester, a poker game-integrity specialist, a payments and ledger engineer, an SRE, a QA lead, an accessibility specialist and a compliance-risk analyst (not a lawyer).

**Your deliverable is one Markdown file, `GPT-6.1-SOL-REVIEW.md`, in the repository root.** It must list every defect you find, precisely enough that Claude can locate, reproduce and fix each one without repeating your investigation. You are reviewing, not fixing: do not change the application.

---

#### 1. Why this matters

The owner intends to run this as an online poker site for real players around the world, and later with real money (fiat and crypto; Malta/MGA Type 3 licensing is planned). A defect here can take a player's money, reveal their cards, let someone cheat, lose a hand's result, lock a player out of their funds, leak personal data, or put a claim on screen the site can't back up. Any of those can mean player losses, regulatory action or lawsuits. The owner wants the highest standard: hunt for everything, from the poker rules to the database, sockets, browser, deployment and the words on the screen.

Assume adversarial users: modified clients, scripted sockets, many accounts, colluding players, hostile websites in the same browser, and network attackers. Also assume honest users with slow or flaky connections, several tabs, phones, screen readers and high latency from other continents.

Be realistic in the report. No review can prove the absence of defects, and real-money operation also needs licensing, independent certification (RNG/game, penetration test) and legal advice. State the residual risk. Never call the product "safe", "compliant" or "certified".

#### 2. The system

- **Monorepo** (npm workspaces), TypeScript throughout, Node 20.11 or later.
- **`packages/engine`**: a pure, deterministic Texas Hold'em state machine. It covers the OS-CSPRNG shuffle with rejection sampling, the hand evaluator, side pots and odd chips, legal actions, blinds, the button and dead button, time-outs, sit-out and leaving, the table lifecycle (idle warning, closure), deck commitments with Merkle proofs, a SHA-256 hash-chained audit, a per-viewer projection with a fail-closed leak guard, and legacy bots.
- **`packages/shared`**: types, socket event contracts, constants, and the participant-audit verifier used by both server and browser.
- **`apps/server`**: an authoritative Express 5 + Socket.io 4 server using Prisma 6 on PostgreSQL (the live Supabase project "OnlinePoker"). Redis is optional, for socket fan-out only. Authentication uses JWT access tokens (15 minutes) and a rotating HttpOnly refresh cookie. Every table mutation runs in a Postgres transaction under `SELECT … FOR UPDATE` with a revision check. Table state is stored AES-256-GCM-encrypted in `Table.stateCiphertext`. Completed hands are append-only for the runtime database role.
- **`apps/web`**: a Next.js 15 / React 19 client with Zustand stores and socket.io-client. It has three routes: lobby `/`, login `/login` and table `/table/[id]`. It verifies Merkle proofs for visible cards and offers a **Verify hand** participant audit.
- **Chips today:** play chips only. Guests get 10,000 chips instantly. New tables are human-only; legacy bot tables still load.
- **Size:** about 9,800 lines of production code in roughly 80 files, plus about 12,000 lines of tests. Read every production line.
- **Uncommitted work:** the working tree has large uncommitted and untracked changes, mainly the table-lifecycle feature (idle warning, idle and empty-table closure, host leaving); run `git status`. This is the newest and least-reviewed code. Review the working tree exactly as it is.

Read these first, then verify them rather than trusting them:

- `README.md`, `CLAUDE_HANDOFF.md`, `progress.md` (newest entries first) and `plan.md` (the original specification).
- `COMPLIANCE.md` and `SECURITY-REVIEW.md`: fairness and security claims. Check each claim against the code.
- `BACKEND-SECURITY-AUDIT.md`: 22 open findings, F01–F22, from 29 September 2026, with the probes `scripts/security-review.mjs` and `scripts/review-database.mjs`.
- `chatgpt-6-sol.md` and `chatgpt-6-codex.md`: earlier model opinions and roadmaps.

These documents, and the many `COMPLIANCE NOTE` comments in the code, describe **intended** behavior. Treat every one as a claim to test.

#### 3. Hard rules

1. **Do not modify, reformat, rename or delete any existing file.** This covers source, tests, docs, `progress.md`, lockfiles and configuration. You may create only `GPT-6.1-SOL-REVIEW.md` and files under `review/gpt-6.1-sol/` (repro scripts, test files, notes). Do not wire them into existing `package.json` scripts or test suites. If a build or test command changes a tracked file as a side effect (Next.js can rewrite `apps/web/next-env.d.ts`), record it in the report.
2. **No state-changing git commands.** Do not commit, push, pull, checkout, switch, reset, restore, stash, rebase, merge, clean or create branches. The owner's uncommitted work must survive intact.
3. **Never write to the live database.** The repository-root `.env` points at the live Supabase OnlinePoker database, and server modules load it when imported (`apps/server/src/config.ts`).
   - Do not run `npm run dev`, `npm run dev:server`, `npm start`, `db:migrate`, `db:seed`, `db:reset`, any `prisma migrate` or `prisma db push` command, or anything else that opens a connection with that `.env`. Starting the real server with it creates guest users and tables in production.
   - In any script that imports server code, set `DATABASE_URL` (and any other connection variable) in the environment **before** import to an unreachable address, as `scripts/security-review.mjs` does (loopback port 1). dotenv does not override existing variables. Replace Prisma with in-memory substitutes, as `apps/server/test/*.mjs` do.
   - Run the existing test suites with the same kind of override in that shell, for example `$env:DATABASE_URL = 'postgresql://review:unused@127.0.0.1:1/review'`. The suites stub Prisma and should not need a database. If one fails only because of the override, record that; do not rerun it against the live database. Remove the override (`Remove-Item Env:DATABASE_URL`) only for the explicitly read-only live checks below.
   - For real-database tests (concurrency, locking, constraints, crash recovery), use a disposable Postgres you start yourself, for example with the repository's `docker-compose.yml` on localhost, and a database created for the purpose. Pass its URL explicitly to that command only. `npm run test:integration` may run only against such a database, with `DATABASE_URL` and `DATABASE_TEST_ADMIN_URL` both set to it. If no disposable database is available, say so.
   - Read-only inspection of the live database is allowed: run `node scripts/review-database.mjs` (read it first to confirm it is read-only), or your own queries inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`. Print only counts, aggregates and table IDs. Never print emails, usernames, IPs, user IDs, password hashes, tokens, ciphertext or cards.
   - Do not use Supabase MCP or CLI operations that change anything (migrations, branches, SQL writes, settings). Reading advisors is fine.
4. **Secrets:** never print or copy values from `.env`, cookies, tokens, keys or passwords into output, logs or the report. Refer to them by variable name only. Use synthetic markers such as `SYNTHETIC-PW-7f3a` in probes.
5. **Leave the owner's processes alone.** A local dev site may be running on ports 3000 and 4000; do not stop, restart or bind them. The browser suite uses its own isolated in-memory game server on port 4107 and Next.js on port 3107. Use those, or other unused ports, for exploratory runs.
6. **Localhost only.** Do not probe or load anything except processes you started on localhost, and send no data to third-party services. Package-registry and documentation lookups are fine.
7. **No dependency changes.** Do not install or upgrade project dependencies; use the existing `node_modules`. If something is missing, report it.
8. **Environment:** Windows 11 and PowerShell 5.1. Use `npm.cmd`, and `;` instead of `&&`. Playwright must run outside a restricted sandbox so it can shut down its test servers. If a sandbox blocks a command, record that; do not work around it unsafely.
9. **Report only what you observed.** Never say a command passed unless you ran it. Label conclusions from code reading alone as such.

#### 4. Baseline checks

Run these and record the results:

```powershell
$env:DATABASE_URL = 'postgresql://review:unused@127.0.0.1:1/review'   # rule 3: nothing below may reach the live database
git rev-parse HEAD; git status --porcelain=v1; git diff HEAD --stat
npm.cmd run typecheck
npm.cmd test                          # engine Jest + server node:test; the RNG suite is slow by design
npm.cmd run build
node scripts/verify-evaluator.mjs
npm.cmd run test:browser -w @poker/web
npm.cmd audit --omit=dev --json       # plus a license inventory of production dependencies
node scripts/security-review.mjs      # after the build; its assertions describe known BAD behavior
```

For each command, record pass/fail counts, duration, failures (verbatim, trimmed) and anything skipped. A failing or flaky existing test is itself a finding. Record the SHA-256 of the `git diff HEAD` output and the list of untracked files, so every line number in your report refers to an exact tree.

#### 5. What to review: everything

Cover every area below. The questions are starting points, not limits.

##### 5.1 Poker rules and engine correctness (`packages/engine`, `packages/shared`)

- **Betting:** minimum bet and raise, "raise to" semantics, maximum raise, incomplete all-in raises and when betting reopens (`lastFullRaiseSize`, `actedThisStreet`, `lastActedBet` in `table.ts` and `legal.ts`), cumulative short all-ins, and integer and bound checks.
- **Blinds and positions:** heads-up play (button posts the small blind, acts first preflop and last postflop), switching between heads-up and three or more players, the dead button and dead small blind, the forward-moving big blind, short-stacked blinds (a big blind all-in for less than the full blind, and what others must call), missed blinds, newcomers waiting for the big blind, sitting out and back in, leaving mid-hand, and bust-outs.
- **Turn order and automation:** turn order, auto-act cascades (`autoAct`, `progressAfterAction`), time-outs (check when free, otherwise fold) and `foldKeepsEveryPotContested`. Can any sequence skip a player, give a player two turns, stall a hand or loop forever?
- **Pots and hand ranking:** uncalled-bet returns, side pots with several all-ins, folded dead money, merging pots by eligibility, split pots, odd-chip placement (which rule, and is it applied consistently?), board plays and kickers. Check evaluator ranking at the edges: the wheel, straight flushes, flush versus full house.
- **Chip conservation:** check it across every transition: hand start, actions, time-outs, settlement, `completeHand`, `leaveSeat`, `closeTable`, `closeIfEmpty`, the voiding path in `upgradeTableState`, and bust-outs.
- **Showdown and privacy:** who must show, mucking, and what gets logged. Can a hidden card reach any payload, log line, error message, audit entry or bot?
- **Determinism:** public transitions claim to clone their input and never mutate it. Check.
- **Randomness and commitments:** in `rng.ts`, `deck.ts` and `fairness.ts`, look for bias, reuse, the zeroization claims, commitment timing and the correctness of Merkle proofs.
- **Audit:** the engine's `audit.ts`, `packages/shared/src/audit.ts` and `apps/server/src/game/audit.ts`. What does verification actually prove? F14 shows it does not validate betting legality.
- **Bots:** can a bot ever act at a human table, see hidden data, or appear where players expect only humans?
- **Your own tests:** beyond reading the code, write property and fuzz tests in `review/gpt-6.1-sol/`. Drive random legal and illegal command sequences, including time-outs, sit-outs, leaves, closures and encrypt/decrypt round-trips standing in for restarts, and assert the invariants in section 6. The helpers in `packages/engine/src/__tests__/helpers/` show how to drive the engine. Import the built engine from `packages/engine/dist`.
- **Rule choices:** compare with a named standard, such as Robert's Rules of Poker or the Poker TDA rules. If a behavior is a legitimate variant, list it as a house-rule decision rather than a bug.

##### 5.2 Server orchestration (`apps/server/src/game`, `apps/server/src/index.ts`)

- **`TableManager.mutate`:** the transaction scope, the `FOR UPDATE` lock, the revision check, and every error path. Can network delivery after commit ever change money?
- **Every chip must move exactly once.** Check each money path:
  - the buy-in debit when a table is created (`routes/tables.ts`);
  - `seatClaim`;
  - the cash-out loop (F09);
  - payouts when a table closes for inactivity or because it emptied;
  - payouts from voided legacy hands;
  - bust-outs.
- **`persistHand`:** the rows it writes, the `startingStack` and `net` formulas versus the database CHECK constraint, players who left or were cashed out mid-hand, and bot statistics.
- **Timers:** `armTimers`, `retryTimer`, the idle timers, `idleCheck`, `staleWarning` and `resumedAt`. Race each timer against player commands, other timers and restarts. What happens when two server processes (Redis adapter on) share one database?
- **Recovery:** `recover()`, and `load()` throwing `RECOVERY_REQUIRED` or failing decryption. Can seated players still leave and get their chips? Is there any operator path to resolve a stuck table?
- **Shutdown and crashes:** in-flight transactions, timers and sockets; process-level error handling.
- **Clocks:** deadlines use wall-clock time, for example the `TURN_EXPIRED` check in `intent()`. Consider clock jumps and several hosts.

##### 5.3 Realtime layer (`apps/server/src/socket`, `apps/web/src/lib/socket.ts`, `apps/web/src/hooks`)

- **Commands:** handshake authentication, per-packet re-authentication, rate limits (per socket, and per user across tabs), payload schemas, acknowledgements (which commands have none?), error scoping, rooms, private-table access and spectators.
- **Long sessions:** the socket keeps its handshake access token, which lasts 15 minutes, while the client refreshes every 10 minutes. Trace what the server does when that token expires and what the client does on each refresh (a new socket, a reset of the table store). Look for lost actions, flicker, missed turns and duplicate joins.
- **Session revocation:** revoked or expired sessions and private notifications (F17), and transient database errors during re-authentication.
- **Multiple connections:** multi-tab and multi-device use of one account, reconnect and rehydrate, and snapshots that arrive out of order or twice.
- **Players worldwide:** high latency and packet loss against a 15-second clock, how the client countdown relates to the server deadline, and time zones and number formatting in anything displayed.

##### 5.4 HTTP API, authentication and sessions (`apps/server/src/app.ts`, `auth/*`, `routes/*`)

- **Middleware:** its order (parsing, limits and errors; F08), error mapping (unhandled Prisma errors such as unique violations on races become 500s), CORS, Helmet and `trust proxy`.
- **Account endpoints** (register, login, guest, refresh, logout, me):
  - enumeration and timing (F07);
  - username rules: case-sensitive uniqueness, look-alikes, reserved names, `Guest_` impersonation;
  - guest-name collisions and the password policy;
  - session lifetime, rotation and replay (F16);
  - CSRF and origin checks (F18) and caching (F19).
- **Table endpoints:**
  - listing, private tables (IDOR) and creation validation;
  - the participant audit route;
  - the admin audit route and its access log (F08, query strings);
  - health versus readiness (F21).

##### 5.5 Data layer (`apps/server/prisma`, `supabase/`)

- Compare the Prisma schema, the Prisma migrations and the Supabase copies. Look for drift, missing constraints, 32-bit integer limits, indexes, cascade deletes that conflict with append-only history, RLS and role grants (F12), and seed data.
- Which invariants should the database enforce that it does not?
- Optional read-only live checks (section 3 applies): look for seats at CLOSED tables, stacks with no table state, negative or implausible balances, tables stuck `IN_HAND`, and hands without audits after the cutover.

##### 5.6 Cryptography, fairness claims and privacy

- AES-GCM usage, AAD contexts, key handling and validation (F11), refresh-token hashing and JWT options.
- Try to break the leak guard (`public.ts`, `isolation.ts`) with log text, usernames or table names that look like cards, error messages, audit payloads and bot views.
- Check browser-side storage. Hole-card digests in `sessionStorage` are recoverable by design; what else is stored?
- Check every fairness and security claim in `README.md`, `COMPLIANCE.md`, `SECURITY-REVIEW.md`, UI copy and code comments. Is each true, overstated or false?

##### 5.7 Web client (`apps/web`)

- **Correctness:**
  - state sync, revision ordering, and the snapshot-verification queue and its failure path;
  - countdowns versus server deadlines (clock skew, background-tab throttling);
  - the idle notice and the closed dialog, leave and cash-out UX, and lobby accuracy.
- **Action bar:**
  - the amount input with empty, `NaN`, decimal and out-of-range values;
  - slider and shortcut math (1/2, 3/4, pot), "raise to" versus "raise by" labels and all-in labels;
  - double submits, stale revisions and disabled states.
- **Money display:** play chips are shown with `$`. Check number formatting and large values. Does anything imply real currency?
- **Security:** XSS surfaces (usernames and table names are user-controlled), missing CSP and security headers on the Next.js origin, token handling, and logout across tabs.
- **Accessibility (WCAG 2.2 AA):**
  - keyboard-only play and focus management in dialogs;
  - screen-reader names for cards, seats and actions, and live announcements for turns and timers;
  - contrast, reduced motion, zoom and reflow;
  - touch-target sizes, and phones in portrait and landscape.
- **Error and edge states:** API offline, rate-limited, table closed or closing, verification failed, session expired mid-hand, slow network.
- **Copy:** check every user-facing sentence for accuracy.

##### 5.8 Configuration, deployment and operations

- Production guards in `config.ts`, TLS and proxy handling (F15), Redis, logging and redaction (F08), health versus readiness (F21), and graceful shutdown.
- Database connection-pool limits against 20-second table transactions, and the CPU cost of Monte Carlo bots.
- `apps/web/next.config.ts`, `docker-compose.yml` and `.env.example`.
- Secrets in tracked files and in git history (read-only search), dependency vulnerabilities and licenses, and reproducible builds.

##### 5.9 Tests and tooling

- Do the tests assert the right things? Look for tests that encode a bug as expected behavior, are tautological, depend on timing, or would still pass with the feature broken.
- Missing coverage: real-Postgres concurrency, several server processes, a restart mid-hand, token expiry mid-session, and mobile and accessibility automation.

##### 5.10 Legal, regulatory and consumer-protection exposure

Flag items for counsel; give no legal conclusions.

- **Missing player-facing documents and flows:** terms of service, house rules, a privacy notice, a cookie and storage notice, a complaints and dispute process, responsible-gaming information and age confirmation (guests play instantly). Real money would also need identity and age verification and geographic restriction.
- **GDPR and Maltese data protection:** the data collected (email, IP, user agent, gameplay), retention, lawful basis, data-subject rights and logs.
- **Misleading or unverifiable claims:** fairness, security, encryption, certification, references to MGA or GLI, currency symbols on play chips, and disclosure of bots or AI.
- **Fairness to players:** forced closures, time-outs, interrupted hands and the disconnection policy. Are the rules published, and applied consistently?
- **Other obligations:** accessibility (for example the European Accessibility Act) and open-source licenses.
- **Real money:** confirm the status of F01–F05 and add anything they miss. Cite the sources you checked, with dates, and mark each item "verify with counsel".

#### 6. Invariants to test

State each invariant as a property and try to break it:

1. Chips are never created or destroyed except by explicit issuance (the registration and guest grants). Across any sequence of commands, time-outs, closures, restarts and errors, the sum of human bankrolls, stacks at open tables and unpaid cash-outs changes only by issuance.
2. Every cash-out is paid exactly once. Every settled hand is recorded exactly once, with an audit that verifies.
3. No player can learn another player's hole cards, or any undealt card, before it is legitimately shown. That includes snapshots, logs, errors, audits, notifications, timing, storage, other tabs and bots.
4. Only the player whose turn it is can act, once per turn, with a legal action and amount. The server never accepts an action against a stale state.
5. A player never loses a pot, a turn or chips because of server downtime, a deploy, a token refresh or another user's actions, except under a published rule.
6. Each user holds at most one seat across all tables. Bankrolls and stacks never go negative or exceed storage limits.
7. A closed table never reopens, deals, accepts chips or pays again.
8. Revoking or expiring a session stops all private data to it on every channel.
9. What the UI shows (stacks, pot, amount to call, timers, results) matches the server state.

#### 7. How to work

1. **Orient.** Map the architecture and list every source, test, configuration, migration and documentation file, tracked or untracked. Exclude `node_modules`, build output, `*.log` files and `.agents/`. This list becomes the coverage ledger.
2. **Baseline.** Run section 4.
3. **Trace these flows end to end** through engine, server, database, socket and browser, noting every assumption:
   1. Guest sign-up → lobby → create table (buy-in debit) → a second player joins → hand → showdown → settlement → history and audit → next hand.
   2. Leaving mid-hand (pending cash-out) and between hands; the last player leaving; the host leaving.
   3. Idle warning → **I'm still here** or closure → forced settlement → payouts → closed dialog, both in the lobby and at the table.
   4. Disconnect, refresh and reconnect mid-hand; the 10-minute token refresh; a background tab; a second tab; a second device.
   5. A server restart during a turn, during the showdown break and during an idle warning.
   6. Races: double clicks; two tabs acting; two users taking the last seat; one user claiming seats at two tables at once; table creation against a seat claim; a timer against an action; closure against a join.
   7. **Verify hand** (participant) and the admin audit route.
   8. Session life: register or log in, refresh rotation, logout, expiry and revocation.
   9. Legacy bot tables.
4. **Review each area in section 5 line by line.**
5. **Verify adversarially.** Try to prove each suspected defect with the smallest failing test or script, saved in `review/gpt-6.1-sol/repro/`:
   - engine: import from `packages/engine/dist`;
   - server: follow the in-memory Prisma pattern of `apps/server/test/*.mjs` against `apps/server/dist`, with the connection overrides from section 3;
   - browser: use the isolated harness in `apps/web/test/support/game-server.mjs`.

   Keep each repro self-contained, with a comment giving expected and actual behavior. Then try to refute your own findings, and drop any that do not survive.
6. **Write the report** (section 8). Spend effort on money movement, hidden information, turn and timer fairness, authentication and sessions, and concurrency and recovery first, but finish every area.

#### 8. Report format: `GPT-6.1-SOL-REVIEW.md`

Use these sections, in this order:

1. **Header:** date, reviewer (GPT-6.1-Sol), HEAD commit, SHA-256 of `git diff HEAD`, the untracked files reviewed, the environment, and a one-paragraph scope statement.
2. **Executive summary** (at most 20 lines): verdicts for (a) a public play-chip launch and (b) real money; counts by severity and category; the ten findings to fix first.
3. **Findings index:** one table row per finding, with ID, severity, category, confidence, fix type, primary location and title.
4. **Verification log:** a table of command, result, counts, duration and notes, including what you could not run and why.
5. **Status of earlier findings:** one row for each of F01–F22, with status (OPEN, FIXED, PARTIAL, REGRESSED or CANNOT-VERIFY), current evidence as `file:line`, and only **new** detail. Do not repeat the old write-ups. Also spot-check that the 25 fixes recorded for 27 September in `progress.md` still hold, and report any regression as a finding.
6. **Findings,** sorted by severity and then by suggested fix order. Use exactly this block for each finding:

   ```markdown
   ### SOL-001: <what is wrong, in one line>
   - **Severity:** S0–S4 for real-money use; current play-chip impact: <…>
   - **Category:** MONEY | FAIRNESS | PRIVACY | SECURITY | CONCURRENCY | RELIABILITY | RULES | UX | A11Y | DATA | CONFIG | TEST-GAP | DOCS-CLAIMS | LEGAL-EXPOSURE | MISSING-CAPABILITY
   - **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/…`) | LIKELY (code evidence, not executed) | SUSPECTED (say what would confirm it)
   - **Fix type:** CODE-NOW | NEEDS-DECISION (<the decision>) | EXTERNAL (<who>)
   - **Where:** `path/to/file.ts:123-140` (`functionName`), plus the smallest code excerpt that shows the problem
   - **Related:** F09, SOL-014
   - **What happens:** the concrete behavior, with inputs and state
   - **Impact:** who is harmed and how (money, fairness, privacy, availability, legal)
   - **Reproduce:** exact commands; expected versus actual
   - **Root cause:**
   - **Recommended fix:** the invariant to enforce and a concrete approach; alternatives and trade-offs; the existing protections the fix must keep
   - **Regression test:** where it goes and what it asserts (fails before the fix, passes after)
   - **Acceptance criteria:** checks Claude can run to call it fixed
   - **Risk of the fix:** migrations, data backfills, behavior changes players will notice
   ```

7. **Decisions needed from the owner:** a table of decision, options, your recommendation and the findings blocked by it. Examples: house rules, the idle and time-out policy, currency display, rake and the account model.
8. **Legal and regulatory exposure register:** each item with evidence, why it matters, and "verify with counsel".
9. **Claims check:** every material claim in the docs, code comments and UI copy, rated TRUE, OVERSTATED, FALSE or UNVERIFIABLE, with evidence.
10. **Verified correct (do not "fix"):** behavior you checked and found correct, including deliberate design choices, so the fixer doesn't regress it.
11. **Fix plan for Claude:** ordered batches of small, reviewable changes with their dependencies, the tests to run after each batch, and the items that must wait for a decision. Respect the architecture: the engine stays pure; server changes go through the locked, revision-checked transaction; shared types serve both sides; tests use Jest (engine), `node:test` (server) and Playwright (web). Flag anything that needs a migration against the live database.
12. **Coverage ledger:** every file from step 1 of section 7, marked FULL, PARTIAL or NOT REVIEWED, with its finding IDs. No blanks.
13. **Open questions and residual risk.**
14. **Appendix:** the repro scripts and how to run them.

**Severity scale.** Judge against real-money use, and also state the current play-chip impact:

- **S0 Critical:** chips or money can be created, lost, stolen or misallocated; hidden cards leak; authentication is bypassed or accounts taken over; cheating is possible; code or query injection is possible; or a legal requirement for launch is absent.
- **S1 High:** likely player harm or an unfair outcome under realistic conditions (races, restarts, disconnects); data exposure; or availability failures that strand chips or tables.
- **S2 Medium:** harm under narrower conditions, or a defense-in-depth gap on a sensitive path.
- **S3 Low:** minor incorrectness or UX problems with no monetary or fairness impact.
- **S4 Info:** polish, maintainability, clarity.

#### 9. Quality bar

- **Locations:** every finding cites an exact `file:line` in the current working tree, as a path relative to the repository root with forward slashes. A missing-capability item cites where the control would have to be enforced.
- **Precision:** merge duplicates and give each finding one root cause. Do not under-report either: a hundred real small defects are worth listing.
- **Separation:** keep bugs, rule choices and missing features apart.
- **Protections:** never propose weakening an existing protection: the leak guard, audit sealing, row locks, revision checks, TLS guards or append-only history.
- **IDs:** keep them stable (`SOL-001`, `SOL-002`, …). Claude will reference them in commits.
- **Audience:** write for an engineer who has the repository but not your context: self-contained and specific.
- **Running out of time:** if you run out of time or context, finish the report with what you have, mark unreviewed areas NOT REVIEWED in the ledger, and say so in the executive summary. An honest partial report beats a padded complete one.

#### 10. Leads from Claude's pre-read: verify or refute each

Claude skimmed the code while writing this brief and noted the items below without running anything. They are hypotheses, not findings. Report each one, either as a finding if it holds or under "Verified correct" if it does not, and do not limit your search to them.

1. **Access-token rotation versus live sockets.** Every 10 minutes the browser refreshes its access token (`apps/web/src/components/auth-hydrator.tsx:55`). Each new token makes `getSocket` disconnect and recreate the socket (`apps/web/src/lib/socket.ts:13-15`). `useTableSocket` then resets the table store and rejoins (`apps/web/src/hooks/use-table-socket.ts:28-29`). The server re-authenticates the handshake token on every packet (`apps/server/src/socket/index.ts:87-88`) and every broadcast (`apps/server/src/game/manager.ts:295`), and the token expires after 15 minutes (`JWT_ACCESS_TTL`, `apps/server/src/config.ts:23`). Look for:
   - actions that are lost, or reported as failed when they succeeded;
   - the table blanking mid-hand, and missed turns;
   - background tabs whose throttled timers let the token expire.
2. **Transient database errors look like sign-outs.** Any `authenticate()` failure, including a database timeout, disconnects the socket with "Please sign in again" (`apps/server/src/socket/index.ts:87-88`) or silently drops the viewer (`apps/server/src/game/manager.ts:295`).
3. **Seat-claim ordering.** `seatClaim` debits the bankroll before its `ALREADY_SEATED` check and relies on transaction rollback plus the unique `TableSeat.userId` (`apps/server/src/game/manager.ts:213-228`). Prove it under real-Postgres concurrency: one user at two tables, and two users for the last seat.
4. **Commands without acknowledgements.** `SEAT_CLAIM`, `SIT_IN` and `SIT_OUT` take no ack (`apps/server/src/socket/index.ts:129-151`). How does the UI learn the outcome, and what does it show on failure or time-out?
5. **Tables that cannot load.** If `load()` throws `RECOVERY_REQUIRED` (`apps/server/src/game/manager.ts:77`) or decryption fails (`:71`), every mutation of that table fails, including leaving. Can seated players' chips be stranded? Is there a recovery path?
6. **Showdown-timer failure loop.** Hand Clean-up and the next deal share one mutation (`apps/server/src/game/manager.ts:320-327`). If `startHand` throws there (blinds cannot be placed, RNG health failure), Clean-up rolls back and `retryTimer` retries about every second. Can `readyToDeal` (`manager.ts:507-513`) disagree with the preconditions of `startHand` and `assignButtonAndBlinds` (`packages/engine/src/table.ts:219-230` and `:709-747`)?
7. **Account names.** Registration races and guest-name collisions (`Guest_` plus 6 hex characters) surface as HTTP 500 (`apps/server/src/auth/routes.ts:76-105` and `:130-140`). `User.username` is unique only case-sensitively (`apps/server/prisma/schema.prisma:67`), so `Alice` and `alice`, or a registered `Guest_1a2b3c`, can coexist.
8. **Bet input.** `Number(e.target.value)` can yield `NaN`, `0` or decimals (`apps/web/src/components/table/action-bar.tsx:127` and `:137`). Check the clamping, the pot-fraction shortcuts (`:44`), the "All-in $stack" label against raise-to semantics, and `$` on play chips.
9. **Out-of-date copy.** The page metadata and package description still advertise AI opponents or bots (`apps/web/src/app/layout.tsx:19`, `package.json:5`), although new tables are human-only.
10. **No player-facing legal pages.** The only routes are `/`, `/login` and `/table/[id]`. There are no terms, privacy notice, house rules, responsible-gaming information or age confirmation, and guests play instantly.
11. **Process-level failures.** `apps/server/src/index.ts` registers no `unhandledRejection` or `uncaughtException` handler. What does a stray rejection do to tables in flight? Also check the shutdown order: `io.close()` runs before the HTTP server and Prisma close (`:56-57`).
12. **Fixed buy-in for joiners.** The table page always requests about 100 big blinds, with no choice (`apps/web/src/app/table/[id]/page.tsx:59-60`). Confirm this is intended, and that the lobby's minimum and maximum buy-ins match what the engine enforces (`packages/engine/src/table.ts:126-130`).
13. **Idle-closure policy.** After five minutes without activity comes a 10-second warning (`packages/shared/src/constants.ts:14-16`), then forced settlement under sit-out rules. Is 10 seconds enough for a player in another tab or on a phone? If the code matches the documented rule, treat this as a policy decision.

#### 11. When you finish

- `git status --porcelain` must show no modified tracked files, only your new ones (apart from any side effects you recorded under rule 1). Include that output in the report.
- Reply with the report path, counts by severity, the top five issues in one line each, and anything you could not verify.

## Appendix I: GPT-6.1-Sol's full review (`GPT-6.1-SOL-REVIEW.md`, word for word)

Written by GPT-6.1-Sol on 29–30 September, not by me. My comparison is in 3.6; the 10 findings I adopted are CR-032 to CR-041. Headings are moved down two levels to fit this file.

### GPT-6.1-SOL-REVIEW

#### 1. Header

- **Date:** 2026-09-30 (Europe/Budapest); review began on 2026-09-29.
- **Reviewer:** GPT-6.1-Sol, the review label requested in the brief; prepared by the Codex agent in this session. This label is not an independently verified model-identity claim.
- **HEAD:** `38be8a79eb44d16be046c3ed9e45cae2cbaaa6a6`.
- **SHA-256 of exact UTF-8 git diff HEAD output:** `f4fc753872628c3fe5cb501f21f93096526f7b4c8df8b140f86ab6c2e5e05315` (unchanged at report generation).
- **Environment:** Windows 11, PowerShell 5.1, Node v24.19.0, npm 11.17.0, installed Chrome and existing workspace node_modules. API fixtures use loopback; existing owner ports 3000/4000 were untouched.
- **Untracked application/docs reviewed at baseline:** `BACKEND-SECURITY-AUDIT.md`, `GPT-6.1-SOL-REVIEW-PROMPT.md`, `apps/server/test/table-lifecycle.test.mjs`, `apps/web/src/components/table-idle-notice.tsx`, `apps/web/src/components/table/idle-close-dialog.tsx`, `apps/web/test/browser/table-lifecycle.spec.ts`, `chatgpt-6-codex.md`, `packages/engine/src/__tests__/table-lifecycle.test.ts`, `scripts/review-database.mjs`, `scripts/security-review.mjs`. `CLAUDE-REVIEW.md` and `review/claude/**` appeared independently during review and were preserved; only the former was partially consulted.
- **Preservation:** 199 pre-existing tracked/untracked file fingerprints match. The initial tree already had 23 tracked modifications; no additional tracked change remains. Next build/browser runs temporarily rewrote `apps/web/next-env.d.ts`; the existing browser teardown restored its original content. No state-changing Git command, live database write, dependency change or application fix was made.

**Scope:** Working-tree engine/shared/server/web production source, migrations/schema/grants, HTTP/socket auth and financial orchestration, browser behavior, docs/claims, configuration/dependencies and launch prerequisites. This is a review with isolated executable evidence and two explicitly read-only live database inspections. Test/helper/dependency and external-infrastructure review is partial as marked in section 12. The latest brief permits only this report and review-owned artifacts, so `progress.md` and existing model reports are preserved despite earlier requests to update them. No assurance of certification, legal compliance or absence of defects is made.

#### 2. Executive summary

- **Public play-chip launch: NO-GO until player-harm, privacy and essential disclosure issues are resolved; private demo testing may continue with explicit nonredeemable chips.**
- **Real money/crypto: NO-GO.** Financial ledger/payments/custody, eligibility/AML, responsible gaming, published player policies and external approvals are not demonstrated.
- **52 distinct findings:** S0 7; S1 22; S2 19; S3 3; S4 1. 30 have executed repro/inspection evidence; 22 are code-based/externally unverified findings. Severity is for real-money use; current demo impact is stated per item.
- **Categories:** MONEY 3; MISSING-CAPABILITY 3; LEGAL-EXPOSURE 3; FAIRNESS 5; RELIABILITY 9; CONCURRENCY 3; SECURITY 7; PRIVACY 3; DATA 1; TEST-GAP 2; CONFIG 3; UX 4; A11Y 3; DOCS-CLAIMS 3.
- The 22 earlier F findings remain open; F21 is split into two fixes, with no duplicate counting. New findings include refresh races, post-commit bot failure, missed warnings and UI clock/sound defects.
- Core checks passed: typecheck, production build, 451 engine tests, 64 baseline server tests (one TLS skip later resolved), all 56 existing browser tests, exhaustive evaluator and production dependency audit (0 known advisories).
- The additional 1,000-run engine probe passed; targeted BAD-behavior probes confirmed defects. Passing those probes means the defects exist.
- Not everything is application-encrypted: game state/sealed audits/hole cards are AES-GCM; passwords/refresh tokens are hashes; profile/balance/seat/session metadata are readable DB fields. Live inspected DB transport used TLS1.3.
- **Ten findings to fix first:** SOL-001 cash-out loss; SOL-010 cleanup coupling; SOL-011 outage logout; SOL-014 post-commit failure; SOL-008 downtime turns; SOL-012 token rotation; SOL-013 tab race; SOL-016 missed warning; SOL-022 secret logging; SOL-032 revoked private fan-out.
- Cash prerequisites SOL-002–007 and independent gates SOL-028–029 block any monetary launch even after current code defects are repaired.
- Production source ledger: 71/71 FULL. Overall 162 files: PARTIAL 24; FULL 136; NOT REVIEWED 2. Complete manual test/a11y/external infrastructure review was not achieved.
- No disposable Postgres/Redis was available: actual locks/crash races and real multi-worker behavior remain unverified. No live money flow exists to certify.

#### 3. Findings index

| ID | Severity | Category | Confidence | Fix type | Primary location | Title |
|---|---|---|---|---|---|---|
| SOL-001 | S0 | MONEY | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:164-168` | Cash-outs are discarded even when no recipient is credited |
| SOL-002 | S0 | MONEY | LIKELY | NEEDS-DECISION (assets, custody and accounting model) | `apps/server/prisma/schema.prisma:63-83` | Balances have no balanced, asset-specific financial ledger |
| SOL-003 | S0 | MONEY | LIKELY | NEEDS-DECISION (strictly separate demo and cash modes) | `apps/server/src/auth/routes.ts:96-102` | Instant chip grants have no hard boundary from future cash balances |
| SOL-004 | S0 | MISSING-CAPABILITY | LIKELY | NEEDS-DECISION (licensed payments/custody provider and supported assets) | `apps/server/src/app.ts:50-53` | No deposit, withdrawal or crypto custody system exists |
| SOL-005 | S0 | LEGAL-EXPOSURE | LIKELY | EXTERNAL (Malta gaming counsel, MLRO and identity/geolocation providers) | `apps/server/src/auth/routes.ts:130-140` | Identity, age, geography and AML eligibility are not enforced |
| SOL-006 | S0 | LEGAL-EXPOSURE | LIKELY | EXTERNAL (gaming counsel and responsible-gaming lead) | `apps/server/src/game/manager.ts:206-228` | No responsible-gaming exclusion or limit enforcement exists |
| SOL-007 | S0 | LEGAL-EXPOSURE | LIKELY | EXTERNAL (gaming/data-protection counsel; owner approves house rules) | `apps/web/src/app/layout.tsx:21-32` | Player terms, house rules, privacy and complaints flows are absent |
| SOL-008 | S1 | FAIRNESS | CONFIRMED | NEEDS-DECISION (interrupted-hand clock and recovery policy) | `apps/server/src/game/manager.ts:109-126` | Recovery applies expired turns immediately after downtime |
| SOL-009 | S1 | RELIABILITY | CONFIRMED | NEEDS-DECISION (audited operator recovery and adjudication policy) | `apps/server/src/game/manager.ts:66-77` | Missing or undecryptable table state blocks every exit path |
| SOL-010 | S1 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:320-327` | The next shuffle can roll back completed-hand clean-up and payouts |
| SOL-011 | S1 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/server/src/auth/routes.ts:178-181` | Database outages are treated as invalid sessions and destroy recovery |
| SOL-012 | S1 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/web/src/lib/socket.ts:13-15` | Access-token rotation resets the table during live play |
| SOL-013 | S1 | CONCURRENCY | CONFIRMED | CODE-NOW | `apps/server/src/auth/routes.ts:150-173` | Refresh rotation is not coordinated across browser tabs |
| SOL-014 | S1 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:182-194` | Legacy bot scheduling can throw after commit and suppress delivery |
| SOL-015 | S1 | CONCURRENCY | CONFIRMED | NEEDS-DECISION (rolling restart versus full-outage grace policy) | `apps/server/src/game/manager.ts:357-365` | Restart grace for idle closure is process-local across workers |
| SOL-016 | S1 | FAIRNESS | CONFIRMED | CODE-NOW | `apps/server/src/socket/index.ts:115-121` | An active idle warning is not replayed to reconnecting lobby users |
| SOL-017 | S1 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/web/src/components/table/action-bar.tsx:57-61` | Optional sound/storage failures prevent a poker action from being sent |
| SOL-018 | S1 | FAIRNESS | CONFIRMED | CODE-NOW | `apps/web/src/components/table/seat-hud.tsx:42-45` | The turn countdown trusts the player’s wall clock |
| SOL-019 | S1 | FAIRNESS | CONFIRMED | NEEDS-DECISION (disconnect, timeout and seat-reservation policy) | `packages/engine/src/table.ts:323-329` | Absent players keep paying future blinds without an explicit policy |
| SOL-020 | S1 | MISSING-CAPABILITY | LIKELY | NEEDS-DECISION (game-integrity operations, staffing and vendor) | `apps/server/src/auth/routes.ts:130-140` | Game-integrity controls stop at legal actions and hidden-card isolation |
| SOL-021 | S1 | SECURITY | LIKELY | NEEDS-DECISION (account recovery and privileged-authentication model) | `apps/server/src/auth/routes.ts:116-121` | Account security lacks uniform login work and privileged MFA |
| SOL-022 | S1 | PRIVACY | CONFIRMED | CODE-NOW | `apps/server/src/app.ts:39-58` | Malformed request bodies bypass limits and enter error logs |
| SOL-023 | S1 | SECURITY | CONFIRMED | NEEDS-DECISION (KMS/HSM custody, rotation and recovery) | `apps/server/src/game/encryption.ts:3-20` | Encrypted state has one unversioned environment key and no rotation path |
| SOL-024 | S1 | SECURITY | CONFIRMED | CODE-NOW | `apps/server/prisma/migrations/20260920140611_poker_security/migration.sql:24-37` | Runtime database authority includes identity roles and credential hashes |
| SOL-025 | S1 | DATA | LIKELY | NEEDS-DECISION (independent audit/state anchoring) | `apps/server/src/game/encryption.ts:14-19` | Encryption and operator-held hashes do not prevent valid snapshot replay |
| SOL-026 | S1 | FAIRNESS | CONFIRMED | CODE-NOW | `packages/engine/src/audit.ts:186-203` | Audit verification accepts a re-sealed illegal betting sequence |
| SOL-027 | S1 | MISSING-CAPABILITY | LIKELY | EXTERNAL (operator, SRE and privacy lead) | `apps/server/src/index.ts:55-60` | Operational retention, restoration and financial incident procedures are unproved |
| SOL-028 | S1 | TEST-GAP | LIKELY | EXTERNAL (accredited testing laboratory and penetration-test provider) | `COMPLIANCE.md:105-112` | Independent RNG, rules, security and production assurance are absent |
| SOL-029 | S1 | TEST-GAP | LIKELY | EXTERNAL (CI/SRE provisioning a disposable Postgres and Redis test environment) | `apps/server/test/integration.test.mjs:1-24` | Real database and multiple-process financial races remain unverified |
| SOL-030 | S2 | CONFIG | LIKELY | NEEDS-DECISION (ingress topology and application-port isolation) | `apps/server/src/transport.ts:42-48` | Proxy TLS trust depends on an unverified network boundary |
| SOL-031 | S2 | SECURITY | CONFIRMED | NEEDS-DECISION (session lifetime and stolen-token response) | `apps/server/src/auth/routes.ts:150-173` | Refresh sessions have no absolute lifetime or replay-family revocation |
| SOL-032 | S2 | PRIVACY | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:245-247` | Revoked sockets still receive private wallet and idle notifications |
| SOL-033 | S2 | SECURITY | CONFIRMED | CODE-NOW | `apps/server/src/app.ts:33-40` | Cookie-authenticated mutations have no explicit origin/CSRF validation |
| SOL-034 | S2 | PRIVACY | CONFIRMED | CODE-NOW | `apps/server/src/auth/routes.ts:105-105` | Sensitive auth responses have no explicit no-store policy |
| SOL-035 | S2 | RELIABILITY | LIKELY | NEEDS-DECISION (capacity targets and distributed abuse control) | `apps/server/src/app.ts:42-51` | Abuse limits and fan-out capacity are local and unmeasured |
| SOL-036 | S2 | CONCURRENCY | LIKELY | CODE-NOW | `apps/server/src/socket/index.ts:129-158` | Command IDs are not durable receipts and several commands lack acknowledgements |
| SOL-037 | S2 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/server/src/routes/health.ts:6-12` | Health reports success even when gameplay dependencies are unavailable |
| SOL-038 | S2 | UX | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:245-247` | Wallet updates can overwrite a newer balance with an older one |
| SOL-039 | S2 | SECURITY | CONFIRMED | CODE-NOW | `apps/web/next.config.ts:4-14` | The Next.js origin supplies no framing or content security policy |
| SOL-040 | S2 | SECURITY | LIKELY | NEEDS-DECISION (canonical names and reserved/disclosed account identities) | `apps/server/src/auth/routes.ts:15-19` | Case-sensitive and reserved usernames enable identity confusion |
| SOL-041 | S2 | A11Y | CONFIRMED | CODE-NOW | `apps/web/src/app/globals.css:222-223` | Reduced-motion styling collapses the meaningful turn clock |
| SOL-042 | S2 | A11Y | CONFIRMED | CODE-NOW | `apps/web/src/components/table/action-bar.tsx:103-109` | Call-button text contrast is below WCAG AA for normal text |
| SOL-043 | S2 | A11Y | LIKELY | CODE-NOW | `apps/web/src/components/table/poker-felt.tsx:44-55` | Turn ownership and remaining time are not announced accessibly |
| SOL-044 | S2 | UX | LIKELY | NEEDS-DECISION (join buy-in selection and confirmation) | `apps/web/src/app/table/[id]/page.tsx:59-60` | Joining a seat silently chooses the buy-in for the player |
| SOL-045 | S2 | UX | CONFIRMED | CODE-NOW | `apps/web/src/components/table/idle-close-dialog.tsx:346-351` | A fresh closed-table visit cannot reach its participant audit in the UI |
| SOL-046 | S2 | CONFIG | LIKELY | NEEDS-DECISION (same-site web/API domains or a backend-for-frontend) | `apps/server/src/auth/routes.ts:40-46` | Production cookie policy requires a same-site deployment that is not enforced |
| SOL-047 | S2 | CONFIG | CONFIRMED | CODE-NOW | `apps/server/src/config.ts:23-26` | Startup accepts unusable bankroll, timer and JWT lifetime settings |
| SOL-048 | S2 | DOCS-CLAIMS | LIKELY | NEEDS-DECISION (demo units, currencies and redemption disclosure) | `apps/web/src/app/page.tsx:144-144` | Play chips are labeled as dollars without clear nonredeemable disclosure |
| SOL-049 | S3 | UX | CONFIRMED | CODE-NOW | `apps/web/src/components/table/action-bar.tsx:41-42` | Decimal bet input remains enabled and sends a rejected amount |
| SOL-050 | S3 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/server/src/auth/routes.ts:89-105` | Unique-account races and small guest suffix collisions surface as 500 |
| SOL-051 | S3 | DOCS-CLAIMS | LIKELY | CODE-NOW | `apps/web/src/app/layout.tsx:19-19` | Metadata and tooling guidance advertise outdated product/deployment behavior |
| SOL-052 | S4 | DOCS-CLAIMS | LIKELY | CODE-NOW | `packages/shared/src/poker.ts:33-34` | Shared odd-chip contract comment names the wrong starting position |

#### 4. Verification log

Exact underlying commands and measured child durations are below. Commands invoked through `node review/gpt-6.1-sol/run.mjs <label> <command...>` received loopback port-1 connection variables and synthetic keys before imports; appendix gives the runnable PowerShell forms. Browser runs were approved outside the restricted sandbox. Read-only live commands are the explicitly identified exceptions. Logs/NDJSON remain under the authorized review directory.

| Command / label | Result | Counts / observations | Duration | Notes / evidence |
|---|---|---|---|---|
| `git rev-parse HEAD`; `git status --porcelain=v1`; `git diff HEAD --stat`; SHA-256 via collect.mjs | CAPTURED | Initial/final diff identity above; 23 pre-existing tracked modifications. | Not individually timed | Read-only Git only. |
| `npm.cmd run typecheck` (`typecheck`) | PASS | 4 workspaces; 0 type errors | 18.356s | `review/gpt-6.1-sol/logs/typecheck.txt` |
| `npm.cmd test` (`tests`) | PASS | Engine 14 suites / 451 passed. Server 65 total / 64 passed / 1 skipped (OpenSSL absent from initial PATH). | 279.377s | `review/gpt-6.1-sol/logs/tests.txt` |
| `npm.cmd audit --omit=dev --json` (`audit`) | PASS | 0 known production advisories; metadata 234 prod, 298 dev, 16 optional, 543 total. Does not assess dev advisories or supply-chain compromise. | 2.858s | `review/gpt-6.1-sol/logs/audit.txt` |
| `npm.cmd run build` (`build`) | PASS | All workspaces; Next 15.5.25 build succeeded. Temporary next-env side effect restored. | 33.051s | `review/gpt-6.1-sol/logs/build.txt` |
| `node scripts/verify-evaluator.mjs` (`evaluator`) | PASS | All 2,598,960 five-card hands/category counts; independent of this report’s new probes. | 4.194s | `review/gpt-6.1-sol/logs/evaluator.txt` |
| `node scripts/security-review.mjs` (`known-backend`) | PASS (bad behavior confirmed) | 11 groups of known BAD observations, not a security pass. | 1.916s | `review/gpt-6.1-sol/logs/known-backend.txt` |
| `npm.cmd run test:browser -w @poker/web` (`browser`) | PASS | 56/56 Chrome desktop + Pixel7 tests, no skips/failures. Isolated fixture, not real DB. | 127.093s | `review/gpt-6.1-sol/logs/browser.txt` |
| `node review/gpt-6.1-sol/repro/engine-properties.mjs` (`engine-properties`) | PASS | Initial 100-run version: 2,101 transitions, 210 settlements, 41 round-trips, 886 rejects. Final file is expanded to 1,000. | 2.521s | `review/gpt-6.1-sol/logs/engine-properties.txt` |
| `node review/gpt-6.1-sol/repro/server-faults.mjs` (`server-faults`) | PASS (bad behavior confirmed) | Original version confirms 9 groups; final expanded file has 11 grouped observations. | 1.875s | `review/gpt-6.1-sol/logs/server-faults.txt` |
| `node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts` (`browser-defects`) | FAIL (review probes corrected) | 7 passed / 3 failed. New reviewer assertions only: wrong error wording, premature motion expectation, and wrong lobby-fetch trigger. Corrected below; not existing-suite regressions. | 38.725s | `review/gpt-6.1-sol/logs/browser-defects.txt` |
| `node review/gpt-6.1-sol/licenses.mjs` (`licenses`) | PASS inventory; clearance pending | 237 production entries: MIT192; Apache2 18; ISC8; UNKNOWN8; BSD3 6; BSD2 2; CC-BY4 1; 0BSD1; Apache2 AND LGPL3+ 1. Seven unknowns are uninstalled platform SWC variants; one xmlhttprequest-ssl manifest. | 0.262s | `review/gpt-6.1-sol/logs/licenses.txt` |
| `node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts` (`browser-defects-corrected`) | PASS (bad behavior confirmed) | 10/10, including one diagnostic-only reduced-motion case. Logs measure 3.1859 contrast and empty .01ms reduced-motion clock. Nine other assertions confirm bad behaviors. | 26.307s | `review/gpt-6.1-sol/logs/browser-defects-corrected.txt` |
| `node review/gpt-6.1-sol/secret-scan.mjs` (`secret-scan`) | PASS heuristic scan | 189 tracked files + 320 available history blobs, 509 contents; 9 synthetic DB-URL candidates, 0 suspicious heuristic matches. Ignored secrets/reflogs/unfetched remotes not scanned. | 88.143s | `review/gpt-6.1-sol/logs/secret-scan.txt` |
| `node --test --test-name-pattern=production with direct TLS apps/server/test/compliance.test.mjs` (`direct-tls`) | PASS | 1/1 selected TLS test passed, 0 skipped. Installed Git OpenSSL supplied in child PATH. | 1.689s | `review/gpt-6.1-sol/logs/direct-tls.txt` |
| `node review/gpt-6.1-sol/repro/engine-properties.mjs` (`engine-properties-extended`) | FAIL (review driver corrected) | Reviewer driver reused a late-player ID across hands; legitimate ALREADY_SEATED rejection. Corrected driver only; no application fix. | 3.859s | `review/gpt-6.1-sol/logs/engine-properties-extended.txt` |
| `node review/gpt-6.1-sol/repro/engine-properties.mjs` (`engine-properties-corrected`) | PASS | 1,000 runs; 21,814 transitions; 18,262 projections; 2,212 settlements; 431 encryption round-trips; 54,786 invalid requests rejected. OS deck randomness not seeded. | 23.228s | `review/gpt-6.1-sol/logs/engine-properties-corrected.txt` |
| `node review/gpt-6.1-sol/repro/server-faults.mjs` (`server-faults-extended`) | FAIL (review driver corrected) | Reviewer bot probe left manager stopped, so timers intentionally did not run. Corrected only the probe to enable timers. | 1.316s | `review/gpt-6.1-sol/logs/server-faults-extended.txt` |
| `node review/gpt-6.1-sol/repro/absence-and-config.mjs` (`absence-config`) | PASS (gap confirmed) | 30 hands / 75 timeouts: absent player stays in with 915/1,000 chips. Three unusable config values accepted. Policy/config observations. | 0.392s | `review/gpt-6.1-sol/logs/absence-config.txt` |
| `node review/gpt-6.1-sol/repro/server-faults.mjs` (`server-faults-corrected`) | PASS (bad behavior confirmed) | 11 groups: missing/corrupt state, cleanup rollback, committed bot failure, worker grace, wallet order, DB refresh/socket loss, tab rotation race, guest collision and missed warning. | 1.835s | `review/gpt-6.1-sol/logs/server-faults-corrected.txt` |
| `node review/gpt-6.1-sol/repro/known-backend.mjs` (`known-wrapper`) | PASS (bad behavior confirmed) | Repeated 11 original bad-observation groups; downtime fold observed in 7ms. | 1.702s | `review/gpt-6.1-sol/logs/known-wrapper.txt` |
| `node scripts/review-database.mjs` (restricted sandbox attempt) | FAIL | Prisma connection blocked/unavailable in sandbox. | 1.045s | No fallback write; explicitly rerun with approved network access. |
| `node scripts/review-database.mjs` (approved read-only live) | PASS | Role poker_server; TLS1.3 / TLS_AES_256_GCM_SHA384; 6 authenticated encrypted states; 241 encrypted hole-card pairs, empty plaintext arrays; 56 hands, 2 full new audits and 54 legacy. | 2.486s | READ ONLY transaction, rollback; aggregates only. |
| `node review/gpt-6.1-sol/repro/live-aggregates.mjs` (approved read-only live) | PASS | 6 tables / 3 closed; closed occupied seats0; missing active ciphertext0; negative balances/stacks0; expired sessions1; old IN_HAND0; audits missing after first audited hand0. User update/role update/hash select true, Hand UPDATE/DELETE and User DELETE false. | 1.744s | READ ONLY transaction, rollback; no private row values printed. |
| `npm.cmd run test:integration -w @poker/server` | NOT RUN | No disposable Postgres/Docker/psql; root live database must not be used. | — | Integration is excluded from the default command and was not opted in; no real-database test passed in this review. |
| Two actual server workers + Redis, load/kill/restore/drain/production ingress tests | NOT RUN | Only in-memory manager scheduling fault comparison was executed. | — | External staging/isolated CI required. |
| Manual NVDA/VoiceOver, Safari/Firefox, actual phone/landscape/400% zoom and whole-site WCAG audit | NOT RUN | Existing Chrome/mobile suite and selected computed-style tests only. | — | SOL-041–043 plus residual risk. |

##### Trimmed failure/skip output

Verbatim lines from the captured logs (trimmed to the relevant assertion):

```text
﹣ production with direct TLS (node:https): TLS requests pass, plaintext cannot connect (7.0882ms) # openssl unavailable: spawnSync openssl ENOENT
    Error: expect(locator).toBeVisible() failed
    Locator: getByText('Bet must be an integer')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

    Error: expect(received).toBe(expected) // Object.is equality
    Expected: "matrix(0, 0, 0, 1, 0, 0)"
    Received: "matrix(0.998578, 0, 0, 1, 0, 0)"

    Error: expect(received).toBeGreaterThan(expected)
    Expected: > 0
    Received:   0
    - Timeout 5000ms exceeded while waiting on the predicate

  3 failed
  7 passed (37.9s)

EngineError: Already seated at this table
  code: 'ALREADY_SEATED'

AssertionError [ERR_ASSERTION]: Missing expected rejection.
```

The read-only live attempt failed with PrismaClientInitializationError / inability to reach the database in the restricted sandbox; private connection details are omitted. It succeeded after approved escalation.

The three browser failures and two extended probe failures were reviewer assertion/driver errors, corrected in review-owned files. They are not failing existing application tests.
Raw verbatim assertion output is retained in the named review logs; the explanatory lines above trim private infrastructure information and distinguish reviewer probe mistakes from existing test failures. The initial read helper also rejected an incorrectly formatted file argument (ENOENT); no application defect was inferred. All corrected review probes then completed. Minor Git ignore permission/LF-to-CRLF warnings and the review helper’s trusted fixed-argument npm shell deprecation were tooling warnings, not application findings.

#### 5. Status of earlier findings

All 22 earlier findings remain OPEN in the reviewed tree. This table adds only evidence/limits from this pass; the complete remediation records are in section 6. F21 is split into command delivery and readiness because the fixes differ. Neither this review nor the concurrent Claude review changed the application.

| Earlier | Status | Current evidence | New detail / this report |
|---|---|---|---|
| F01 | OPEN | `apps/server/src/auth/routes.ts:101,136` | Demo issuance remains positive; no redeemable funds exist today. SOL-003. |
| F02 | OPEN | `apps/server/prisma/schema.prisma:73,135` | Config probe additionally accepts an amount outside Postgres Int; SOL-002, SOL-047. |
| F03 | OPEN | `apps/server/src/app.ts:50-53` | No payment/custody integration was added; provider scope must include the actual gambling/asset use. SOL-004. |
| F04 | OPEN | `apps/server/src/auth/routes.ts:130-140` | Current Malta primary guidance was checked; serving worldwide is a separate market decision. SOL-005. |
| F05 | OPEN | `apps/server/src/game/manager.ts:206-228` | Idle closure is not a responsible-gaming limit or exclusion. SOL-006. |
| F06 | OPEN | `apps/server/src/auth/routes.ts:130-140` | Human-only new tables do not prove human independent users. SOL-020. |
| F07 | OPEN | `apps/server/src/auth/routes.ts:116-121` | No login timing benchmark was executed; code shows different expensive-work paths. SOL-021. |
| F08 | OPEN | `apps/server/src/app.ts:39,56` | Existing bad-behavior probe reproduced synthetic password logging; admin every-request logging remains functional. SOL-022. |
| F09 | OPEN | `apps/server/src/game/manager.ts:164-168` | Zero-recipient cash-out reproduced; live aggregates did not show closed occupied seats. SOL-001. |
| F10 | OPEN | `apps/server/src/game/manager.ts:342-344` | Repeated wrapper observed TIMEOUT_FOLD in 7ms; idle restart grace is a different mechanism. SOL-008. |
| F11 | OPEN | `apps/server/src/game/encryption.ts:5-19` | Actual state authenticated under AAD; all-zero/reused synthetic production keys still accepted. SOL-023. |
| F12 | OPEN | `apps/server/prisma/migrations/20260920140611_poker_security/migration.sql:32-37` | Live read-only column privileges confirm role update/hash select; Hand UPDATE/DELETE and User DELETE remain denied. SOL-024. |
| F13 | OPEN | `apps/server/src/game/encryption.ts:14-19` | Freshness is not authenticated independently; no privileged live replay/deletion was attempted. SOL-025. |
| F14 | OPEN | `packages/engine/src/audit.ts:186-203` | Re-sealed CHECK paying 10 accepted again; ordinary engine legality still passes. SOL-026. |
| F15 | OPEN | `apps/server/src/transport.ts:42-48` | Direct TLS test skip was resolved using installed Git OpenSSL; rediss/strict DB guards are present. SOL-030. |
| F16 | OPEN | `apps/server/src/auth/routes.ts:150-173` | Two honest tab refresh requests additionally return [200,401]; replay must be distinguished from that race. SOL-031, SOL-013. |
| F17 | OPEN | `apps/server/src/game/manager.ts:247,275` | Revoked wallet delivery reproduced; current table/card broadcasts are reauthenticated. SOL-032. |
| F18 | OPEN | `apps/server/src/app.ts:33-40` | Foreign-origin guest 201 reproduced; Strict cookies mitigate authenticated cross-site risk. SOL-033. |
| F19 | OPEN | `apps/server/src/auth/routes.ts:105,140,174-177` | No-store remains absent on auth; present on audit routes. No intermediary data disclosure was tested. SOL-034. |
| F20 | OPEN | `apps/server/src/socket/rate-limit.ts:4-28` | Multiple-manager fault tests do not measure distributed quota or production load. SOL-035. |
| F21 | OPEN | `apps/server/src/socket/index.ts:33,129-158`; `apps/server/src/routes/health.ts:6-12` | Missing seat/toggle acks checked; health still succeeds without DB. SOL-036, SOL-037. |
| F22 | OPEN | `apps/server/src/index.ts:55-60`; `apps/server/prisma/schema.prisma:86-98` | One expired live session observed, but age/retention policy was not supplied. No restore/drain drill was performed. SOL-027. |

##### September 27 fixes spot-check

`progress.md:363-385` says 25 fixes but does not assign 25 stable issue IDs. The following 25 checks cover its listed behaviors, grouping related checks where needed. The executed full suite includes `review-fixes.test.ts` and `compliance.test.mjs`; their selected assertions and production implementations were inspected. This is a spot-check, not independent reimplementation of every old test.

| # | Recorded behavior | Current evidence | Result |
|---|---|---|---|
| 1 | Legacy WAITING state purges prior card secrets | `packages/engine/src/table.ts:656-704`; review-fixes legacy tests | HOLDS in executed suite. |
| 2 | Legacy running hand voids and returns commitments | Same upgrade function; server compliance legacy tests | HOLDS; cash-out recipient failure remains separate SOL-001. |
| 3 | Settled legacy SHOWDOWN clean-up preserves winnings | `packages/engine/src/table.ts:388-445,656-704` | HOLDS in executed suite. |
| 4 | Legacy upgrade is persisted at recovery | `apps/server/src/game/manager.ts:117-126` | HOLDS in in-memory tests; actual crash/lock execution unverified. |
| 5 | Duplicate visible cards rejected | `packages/shared/src/audit.ts:479-531`; review-fixes forgeries | HOLDS. |
| 6 | A folded hand cannot be passed off as tabled | `packages/shared/src/audit.ts:402-455` | HOLDS. |
| 7 | Doctored showdown rejected | Same shared semantic verification; `review-fixes.test.ts:393-506` | HOLDS for covered forgeries. |
| 8 | Unknown/unhashed schema fields rejected | `packages/shared/src/audit.ts:273-346` | HOLDS. |
| 9 | Wrong table, hand or user rejected | `packages/shared/src/audit.ts:479-531` | HOLDS. |
| 10 | Outcome arithmetic replays contributions/folds | `packages/engine/src/audit.ts:161-270` | HOLDS for arithmetic; full betting legality still absent SOL-026. |
| 11 | Outcome replays showdown ranks and side pots | Same outcome verifier; independent pot/evaluator tests | HOLDS. |
| 12 | Outcome replays odd chips, refunds, final stacks | Same outcome verifier; pots-reference/review-fixes tests | HOLDS. |
| 13 | Server rejects live outcome inconsistent with verified audit | `apps/server/src/game/audit.ts:75-149` | HOLDS in compliance tests. |
| 14 | Per-table prior-hand link checked | `packages/shared/src/audit.ts:357-372`; server regulatorVerification | HOLDS relative to supplied history; deletion of an entire tail is SOL-025. |
| 15 | Newcomers wait for big blind | `packages/engine/src/table.ts:116-159,709-749` | HOLDS in rule tests. |
| 16 | Returning missed-blind players wait | Same blind assignment; review-fixes blind ledger | HOLDS. |
| 17 | Dead button and heads-up transitions | `packages/engine/src/table.ts:709-749` | HOLDS for tested rules; publish actual house choice. |
| 18 | Leaver folds on their turn, with pot-eligibility safeguard | `packages/engine/src/table.ts:195-217,341-386` | HOLDS; preserve the all-in/stranded-pot exception. |
| 19 | Sit-in cancels pending leave | `packages/engine/src/table.ts:174-193` | HOLDS. |
| 20 | Automatic action reasons and no-op toggles accurate | `packages/engine/src/table.ts:161-193,341-373` | HOLDS. |
| 21 | Exact snapshot-schema leak guard | `packages/engine/src/public.ts:194-278` | HOLDS; leakage sweep passed. |
| 22 | TLS checked on every engine.io request | `apps/server/src/socket/index.ts:52-64`; transport guard | HOLDS including separately executed direct TLS test. |
| 23 | Every admin request logged with outcome | `apps/server/src/app.ts:21`; admin-access-log | HOLDS including denials; raw query/body sanitization remains SOL-022. |
| 24 | Participant redaction checks stored showedCards | `apps/server/src/game/audit.ts:233-292` | HOLDS. |
| 25 | Evidence is user-scoped, pruned and cleared; docs bound its guarantees | `apps/web/src/hooks/use-table-socket.ts:152-237`; `COMPLIANCE.md:65-76,106-107` | Evidence protection HOLDS; blanket change/deletion-detection wording is still OVERSTATED (SOL-025). |

No newly demonstrated regression of these core September 27 fixes was found. Existing F13/F14 limitations are still open; they are not proof that a fixed old bug was reintroduced. New UI/orchestration findings are separately reproduced.

#### 6. Findings

Sorted by real-money severity, then suggested fix order. A missing cash capability is a launch blocker even where it is intentional in today’s demo. CONFIRMED names an executed observation; a related end-to-end impact may remain explicitly code-based. Code excerpts use ellipses for omitted intervening code.

##### SOL-001: Cash-outs are discarded even when no recipient is credited

- **Severity:** S0 for real-money use; current play-chip impact: Play chips can be lost when the recipient row is missing or no longer HUMAN.
- **Category:** MONEY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/game/manager.ts:164-168` (`TableManager.mutate`); excerpt: `await tx.user.updateMany(...); result.cashOuts = [];`.
- **Related:** F09; SOL-002
- **What happens:** Inject updateMany returning count=0. The transaction releases the seat and persists no unpaid cash-out, but credits nobody.
- **Impact:** A player loses the complete remaining stack; an invariant violation becomes irreversible bookkeeping.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected rollback; actual released seat, zero credit, zero pending cash-outs.
- **Root cause:** The cash-out loop never checks affected-row count.
- **Recommended fix:** Require exactly one authorized recipient per HUMAN cash-out; fail and roll back otherwise. Add a uniquely identified durable payout/ledger entry in the same locked transaction. Preserve bot issuance rules, row locks, revision checks and terminal closure.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server node:test: missing, misclassified and duplicate recipients; then real Postgres rollback and concurrent retry.
- **Acceptance criteria:** Zero credited rows must leave the wallet, seat, state and payout obligation unchanged; valid cash-out and replay pay once.
- **Risk of the fix:** Existing inconsistent rows need quarantine and reconciliation, not a blind replay of old payouts.

##### SOL-002: Balances have no balanced, asset-specific financial ledger

- **Severity:** S0 for real-money use; current play-chip impact: The current single play-chip balance is unsuitable for redeemable value.
- **Category:** MONEY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (assets, custody and accounting model)
- **Where:** `apps/server/prisma/schema.prisma:63-83` (`User schema`); excerpt: `bankroll Int @default(10000)`.
- **Related:** F02; SOL-001; SOL-003; SOL-004
- **What happens:** Money is represented by mutable 32-bit bankroll/stack counters; no ledger accounts, posting pairs, asset identity, holds or reconciliation records exist.
- **Impact:** Fiat and crypto cannot be reconciled or independently reconstructed; overflow would reject settlements and strand play.
- **Reproduce:** rg -n 'bankroll|stack|model ' apps/server/prisma/schema.prisma; expected ledger/asset records; actual single Int counters.
- **Root cause:** A demonstration chip model is being considered for financial operation.
- **Recommended fix:** Design immutable double-entry postings per asset, integer minor units/atomic units, escrow table accounts and durable idempotency keys. Keep display amounts separate from database accounting and set explicit storage and aggregate limits.
- **Regression test:** `apps/server/test/financial-ledger.test.mjs (new) and disposable integration suite`: Disposable Postgres: deposits, buy-ins, pots, cash-outs, reversals and withdrawal holds; assert zero-sum postings and reconstruct balances after crashes.
- **Acceptance criteria:** Every change has balanced entries, a unique business reference and an independent reconciliation trail; demo balances cannot become money.
- **Risk of the fix:** Major schema and data migration; reconcile existing chips into a separate nonredeemable asset.

##### SOL-003: Instant chip grants have no hard boundary from future cash balances

- **Severity:** S0 for real-money use; current play-chip impact: 10,000-chip grants are intentional demo issuance, and are readily farmable.
- **Category:** MONEY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (strictly separate demo and cash modes)
- **Where:** `apps/server/src/auth/routes.ts:96-102` (`register`); excerpt: `bankroll: env.DEFAULT_STARTING_BANKROLL`.
- **Related:** F01; SOL-002; SOL-004
- **What happens:** Both registration and anonymous guest creation grant positive bankroll. Config accepts only a positive starting grant; there is no cash mode, asset namespace or redemption boundary.
- **Impact:** If these same chips become redeemable, account creation mints financial liabilities. This is conditional on a future cash launch, not a current cash exploit.
- **Reproduce:** rg -n 'DEFAULT_STARTING_BANKROLL|bankroll:' apps/server/src/auth/routes.ts apps/server/src/config.ts; both grant paths persist positive credit.
- **Root cause:** Account provisioning and economic issuance are coupled.
- **Recommended fix:** Separate demo and real accounts/assets. Real balance starts at zero and only an authorized funded ledger transaction credits it. Guest play must remain nonredeemable; bonuses need separate audited rules.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Auth plus ledger tests: zero real credit on register/guest, unlimited demo issuance cannot fund withdrawal or cash tables.
- **Acceptance criteria:** Cash APIs cannot consume demo balances; startup rejects an ambiguous money mode.
- **Risk of the fix:** Changing default grants affects new users; existing demo balances must stay nonredeemable.

##### SOL-004: No deposit, withdrawal or crypto custody system exists

- **Severity:** S0 for real-money use; current play-chip impact: Players can only acquire and play demonstration chips.
- **Category:** MISSING-CAPABILITY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (licensed payments/custody provider and supported assets)
- **Where:** `apps/server/src/app.ts:50-53` (`createApp`); excerpt: `app.use("/api/auth", ...); app.use("/api/tables", ...);`.
- **Related:** F03; SOL-002; SOL-005
- **What happens:** There are no money endpoints, signed webhook processing, chain confirmation/reorganisation handling, withdrawal approvals or custody key management.
- **Impact:** A real-money service cannot accept, protect or return player funds with this implementation.
- **Reproduce:** rg --files apps/server/src/routes apps/server/src/auth; inspect mounted endpoints above; expected financial workflow; none is implemented.
- **Root cause:** Payments and custody have not been implemented.
- **Recommended fix:** Use appropriately authorized providers with verified current scope for gambling and selected assets. Build signed/idempotent webhooks, confirmation and reorg policies, withdrawal holds, destination checks and reconciliation. Self-custody requires a separate reviewed security and operational programme.
- **Regression test:** `apps/server/test/payments.test.mjs (new) and provider sandbox`: Provider sandbox and disposable ledger: duplicate/reordered events, forged signatures, chargebacks, chain reorgs and failed withdrawals.
- **Acceptance criteria:** End-to-end funded deposit and withdrawal reconcile once; counsel and provider approve the actual market and custody arrangement.
- **Risk of the fix:** Provider lock-in, compliance scope, payment fees and custody liability; no live migration or integration is authorized by this review.

##### SOL-005: Identity, age, geography and AML eligibility are not enforced

- **Severity:** S0 for real-money use; current play-chip impact: Anonymous guests immediately play; public demo privacy and age policy also require review.
- **Category:** LEGAL-EXPOSURE
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** EXTERNAL (Malta gaming counsel, MLRO and identity/geolocation providers)
- **Where:** `apps/server/src/auth/routes.ts:130-140` (`guest / seatClaim`); excerpt: `res.status(201).json(await issueSession(user, req, res));`.
- **Related:** F04; SOL-004; SOL-007
- **What happens:** Guests obtain a session without age/identity confirmation; neither seating nor table creation evaluates verification, exclusions, market eligibility or AML state.
- **Impact:** A proposed cash launch lacks core admission controls. Malta location alone does not authorize players worldwide. Verify the exact obligations with counsel.
- **Reproduce:** rg -n 'isGuest|role|kind|bankroll' apps/server/prisma/schema.prisma; trace guest issuance and manager.seatClaim; no eligibility gate is present.
- **Root cause:** The account/session and gameplay contracts have no authoritative eligibility state.
- **Recommended fix:** Define permitted markets and onboarding with counsel/MLRO. Enforce an eligibility decision server-side at cash access, seating, deposits and withdrawals, including sanctions/PEP and ongoing risk controls as required. Do not rely on a checkbox or client flags.
- **Regression test:** `apps/server/test/eligibility.test.mjs (new)`: Server tests reject ineligible identities/markets even with valid JWTs; provider outages fail closed for cash access while preserving funds and due withdrawal handling.
- **Acceptance criteria:** Approved licence scope and market matrix, auditable decisions and independent bypass tests exist.
- **Risk of the fix:** New personal data, provider dependencies and account migration require a privacy assessment.

##### SOL-006: No responsible-gaming exclusion or limit enforcement exists

- **Severity:** S0 for real-money use; current play-chip impact: No self-exclusion, limit-setting or published responsible-gaming flow is available.
- **Category:** LEGAL-EXPOSURE
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** EXTERNAL (gaming counsel and responsible-gaming lead)
- **Where:** `apps/server/src/game/manager.ts:206-228` (`TableManager.seatClaim`); excerpt: `async seatClaim(...); await tx.user.updateMany(...);`.
- **Related:** F05; SOL-005; SOL-007
- **What happens:** A valid session can keep playing without any self-exclusion, deposit/wager-limit or reality-check state; guests can create replacement identities.
- **Impact:** Cash launch lacks required player-protection controls; verify applicable Malta requirements and timing with counsel.
- **Reproduce:** rg -n 'seatClaim|bankroll|requireAuth' apps/server/src/game/manager.ts apps/server/src/routes/tables.ts; no player-protection service or fields are used.
- **Root cause:** Gameplay checks seat and balance eligibility only.
- **Recommended fix:** Implement identity-bound exclusion and mandatory tools, with enforceable limit changes/cooling-off rules and cross-tab/server consistency. Keep withdrawals and verified funds accessible under the approved exclusion policy.
- **Regression test:** `apps/server/test/responsible-gaming.test.mjs (new)`: Server and browser: exclusion while seated, across tabs/devices, a racing deposit/action, provider outage and attempted replacement accounts.
- **Acceptance criteria:** Limits and exclusions are enforced atomically at the relevant server boundaries; required player tools and support processes are usable.
- **Risk of the fix:** House policy and new persistent compliance records are required.

##### SOL-007: Player terms, house rules, privacy and complaints flows are absent

- **Severity:** S0 for real-money use; current play-chip impact: The public demo collects personal/session data without a visible privacy notice or published game policies.
- **Category:** LEGAL-EXPOSURE
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** EXTERNAL (gaming/data-protection counsel; owner approves house rules)
- **Where:** `apps/web/src/app/layout.tsx:21-32` (`RootLayout`); excerpt: `<AuthHydrator>{children}</AuthHydrator>`.
- **Related:** Claude lead 10; SOL-005; SOL-006; SOL-019; SOL-048
- **What happens:** Only lobby, login and table routes exist. No terms/version acceptance, privacy/storage notice, age flow, complaints/dispute route or responsible-gaming information is linked.
- **Impact:** Players cannot understand data processing or forced closures/disconnect rules; cash obligations must be verified with counsel before launch.
- **Reproduce:** rg --files apps/web/src/app; expected policy routes and acceptance flow; actual three page routes only.
- **Root cause:** Legal and consumer-protection content was not integrated into onboarding or navigation.
- **Recommended fix:** Commission jurisdiction-specific documents and publish accessible links. Store required accepted document versions; disclose essential storage, retention, bots, timeouts and closure treatment. Add a usable complaints escalation flow.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright: links before guest/account creation, accessible policy pages, required acceptance persistence and complaints submission; no dark patterns.
- **Acceptance criteria:** Counsel approves the actual flows and claims; all relevant pages are reachable on mobile and keyboard.
- **Risk of the fix:** Legal content changes account flow and evidence retention; a cookie banner is not automatically necessary for strictly essential storage.

##### SOL-008: Recovery applies expired turns immediately after downtime

- **Severity:** S1 for real-money use; current play-chip impact: A reconnecting player can be folded within milliseconds of recovery.
- **Category:** FAIRNESS
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** NEEDS-DECISION (interrupted-hand clock and recovery policy)
- **Where:** `apps/server/src/game/manager.ts:109-126` (`TableManager.recover / armTimers`); excerpt: `this.armTimers(table);`.
- **Related:** F10; SOL-015; SOL-018
- **What happens:** The saved turn deadline is retained across downtime. An expired saved turn schedules applyTimeout immediately; the existing probe observed TIMEOUT_FOLD after approximately 5 ms.
- **Impact:** A restart/deploy can remove a player’s chance to act and change pot eligibility.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected a recoverable turn under a published policy; actual immediate TIMEOUT_FOLD.
- **Root cause:** Turn recovery has no durable interruption/grace policy; idle recovery grace does not cover turns.
- **Recommended fix:** Choose pause/resume or a defined reconnection grace, persisted under the lock and shared across workers. Keep authoritative deadlines and stale-revision rejection; never silently replay a different deal.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server fake-clock plus disposable Postgres crash/restart tests at each betting phase and showdown; browser reconnect sees the same new deadline.
- **Acceptance criteria:** A deploy cannot time out an interrupted turn before the documented grace; two workers agree on one deadline.
- **Risk of the fix:** Players will notice clock changes; downtime treatment requires house-rule approval.

##### SOL-009: Missing or undecryptable table state blocks every exit path

- **Severity:** S1 for real-money use; current play-chip impact: A seated player cannot leave or cash out an affected table.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** NEEDS-DECISION (audited operator recovery and adjudication policy)
- **Where:** `apps/server/src/game/manager.ts:66-77` (`TableManager.load / standUp`); excerpt: `if (...) throw new EngineError("RECOVERY_REQUIRED", ...);`.
- **Related:** Claude lead 5; SOL-023; SOL-027
- **What happens:** With missing encrypted state or invalid GCM data, manager.standUp fails; all mutations require load. Admin routes expose audits but no controlled repair/adjudication workflow.
- **Impact:** Chips and the unique seat can be stranded indefinitely. No ordinary live corruption was found.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs; expected a controlled resolution path; actual RECOVERY_REQUIRED/decryption rejection on leave.
- **Root cause:** Fail-closed loading is correct, but no recovery capability resolves a quarantined financial obligation.
- **Recommended fix:** Freeze the affected table with an incident ID. Recover from verified durable state/history or adjudicate under an approved operator procedure with dual control and ledger reconciliation. Keep decryption and audit failures closed; never refund arbitrary stacks from untrusted rows.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server corruption/missing-key tests plus disposable restoration exercise; unrelated tables remain playable and funds are accounted for exactly once.
- **Acceptance criteria:** A rehearsed, auditable recovery path exists for each corrupt/missing-state case without revealing hidden cards.
- **Risk of the fix:** Recovery can change results; key restoration, reconciliation and operator access need approval.

##### SOL-010: The next shuffle can roll back completed-hand clean-up and payouts

- **Severity:** S1 for real-money use; current play-chip impact: A departing player remains seated until the next deal can succeed.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/game/manager.ts:320-327` (`TableManager.armTimers`); excerpt: `let next = completeHand(current); if (readyToDeal(next)) next = startHand(next);`.
- **Related:** Claude lead 6; SOL-001; SOL-009
- **What happens:** Fault the RNG during the next start. The single transaction rolls back completeHand, retaining pendingLeave and its unpaid cash-out; the timer retries roughly every second.
- **Impact:** An unrelated next-hand failure blocks already earned funds/seat release and creates a retry loop.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs; expected completed-hand payout survives next shuffle failure; actual ciphertext unchanged and pending leaver retained.
- **Root cause:** Clean-up and a fresh RNG-dependent deal share one transaction.
- **Recommended fix:** Commit verified completed-hand clean-up and cash-outs first. Start the next hand in a separate locked/revision-checked mutation with a bounded retry/incident policy. Keep RNG failure closed and hand persistence exactly once.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server test faulting next-deal RNG/blind preconditions after a settled hand; assert cash-out committed once, no next-hand cards, then one new deal after recovery.
- **Acceptance criteria:** A failed fresh deal cannot undo a completed hand’s cash-outs; concurrent starts produce one hand.
- **Risk of the fix:** Changes inter-hand orchestration; requires real-database race tests.

##### SOL-011: Database outages are treated as invalid sessions and destroy recovery

- **Severity:** S1 for real-money use; current play-chip impact: A transient database timeout signs users out and disconnects sockets without automatic reconnection.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/auth/routes.ts:178-181` (`refresh`); excerpt: `catch { clearRefreshCookie(res); res.status(401)... }`.
- **Related:** Claude lead 2; apps/server/src/auth/middleware.ts:19; apps/server/src/socket/index.ts:87-88; SOL-012; SOL-037
- **What happens:** A fault in session lookup yields HTTP 401 and expires the refresh cookie. Per-packet authentication disconnects with io server disconnect; socket.io reports active=false. AuthHydrator clears valid local session on 401.
- **Impact:** An infrastructure hiccup becomes permanent session loss mid-hand and can cost a turn.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs; expected 503/preserved cookie/retry; actual 401, deleted cookie, server disconnect and active=false.
- **Root cause:** Credential invalidity, revocation and dependency failure share a catch path.
- **Recommended fix:** Use typed invalid/expired/revoked versus unavailable errors. Return retryable 503 without deleting a valid cookie; pause authenticated sensitive delivery during outages, then retry with backoff. Preserve revocation enforcement.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server fault injection for each auth endpoint/socket broadcast; Playwright resumes the same session after a temporary database outage.
- **Acceptance criteria:** Transient failures preserve credentials and recover; invalid/revoked tokens still fail closed.
- **Risk of the fix:** Requires coordinated shared error contracts and careful privacy handling while auth is unavailable.

##### SOL-012: Access-token rotation resets the table during live play

- **Severity:** S1 for real-money use; current play-chip impact: A genuine token change blanks legal controls while the socket rejoins.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/lib/socket.ts:13-15` (`getSocket / useTableSocket`); excerpt: `socket.disconnect(); ... io(...);`.
- **Related:** Claude lead 1; apps/web/src/hooks/use-table-socket.ts:28-29; SOL-008; SOL-011; SOL-036
- **What happens:** Change to a newly signed token and delay TABLE_JOIN by 1.5 seconds. Existing Call controls disappear until the new snapshot arrives. Ten-minute refreshes cause this during a 15-second turn.
- **Impact:** Refresh, background throttling or packet loss can consume the acting window and leave action outcome ambiguous. The probe did not prove a lost committed action.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'rotation'; expected continuous hand display; actual controls disappear during forced rejoin.
- **Root cause:** Token identity controls socket identity; the hook unconditionally resets trusted current table state.
- **Recommended fix:** Provide authenticated in-place reauthorization, or reconnect while retaining same-account verified state and an explicit reconnect overlay. Refresh based on expiry; recover action receipts before allowing resend. Clear private state on actual account switch/logout.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright with genuinely different tokens, 1.5s/longer joins, expiry in a background tab and lost action acknowledgements.
- **Acceptance criteria:** Normal refresh preserves the visible verified hand; controls reflect connectivity; expiry resumes through the approved clock policy.
- **Risk of the fix:** Security-sensitive lifecycle changes must not retain another account’s cards.

##### SOL-013: Refresh rotation is not coordinated across browser tabs

- **Severity:** S1 for real-money use; current play-chip impact: One tab can receive a fatal 401 even while another refreshes successfully.
- **Category:** CONCURRENCY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/auth/routes.ts:150-173` (`refresh / refreshSession`); excerpt: `if (rotated.count !== 1) { res.status(401)... }`.
- **Related:** apps/web/src/lib/api.ts:39-50; apps/web/src/components/auth-hydrator.tsx:36-48; SOL-011; SOL-031
- **What happens:** Two requests carrying the shared pre-rotation cookie return statuses [200,401]. The browser treats the loser’s 401 as terminal and clears that tab’s session. The refresh promise coordinates one JS realm only.
- **Impact:** Ordinary multi-tab use can interrupt a hand without any invalid credentials.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs; expected both honest tabs recover; actual refresh statuses 200 and 401. Client logout effect is traced in AuthHydrator.
- **Root cause:** Correct server CAS rotation has no cross-tab coordination or recoverable stale-rotation response.
- **Recommended fix:** Coordinate tabs with Web Locks/BroadcastChannel or an equivalent single-flight mechanism; distinguish stale rotation from revocation and retry once using the current cookie. Preserve single-use rotation and do not issue fresh tokens to arbitrary replay.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server CAS race test and two real browser pages refresh simultaneously, then both remain signed in; revoked/stolen old cookies remain rejected.
- **Acceptance criteria:** Only one rotation occurs and honest tabs recover without logout or infinite refresh loops.
- **Risk of the fix:** Browser support/fallbacks and replay semantics need deliberate design.

##### SOL-014: Legacy bot scheduling can throw after commit and suppress delivery

- **Severity:** S1 for real-money use; current play-chip impact: A committed state change can be reported as failed and left without a turn timer.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/game/manager.ts:182-194` (`TableManager.mutate / armTimers`); excerpt: `else this.armTimers(next); // before delivery Promise.allSettled`.
- **Related:** Claude lead 11; apps/server/src/game/manager.ts:337-340; SOL-036
- **What happens:** Inject a bot pacing RNG failure with manager timers enabled. mutate rejects after encrypted revision has committed; armTimers has removed the prior timer but has not installed the next one. Delivery code is never reached.
- **Impact:** A legacy bot table can stall; acknowledgements lie about committed changes and wallet notifications can be skipped. Human-only new tables avoid the bot path.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs; expected committed result and recovery; actual rejected mutation, incremented persisted revision, no turn timer.
- **Root cause:** Potentially throwing bot computation occurs synchronously outside post-commit error isolation.
- **Recommended fix:** Separate committed command outcome from scheduling/delivery. Catch and incident-report timer setup failures; retain a safe timeout/recovery timer. Consider worker offloading or retiring legacy bots; never substitute weak card randomness.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server inject bot RNG/decision failure after commit; assert successful committed receipt, wallet notifications attempted and one safe recovery timer.
- **Acceptance criteria:** Post-commit scheduling cannot turn a committed command into a failure or block payout delivery.
- **Risk of the fix:** Legacy behavior changes; worker offloading requires revision checks and bounded CPU.

##### SOL-015: Restart grace for idle closure is process-local across workers

- **Severity:** S1 for real-money use; current play-chip impact: A newly resumed worker’s five-minute grace can be overridden by an older worker.
- **Category:** CONCURRENCY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** NEEDS-DECISION (rolling restart versus full-outage grace policy)
- **Where:** `apps/server/src/game/manager.ts:357-365` (`TableManager.idleFrom / staleWarning`); excerpt: `return Math.max(idleSince(table), this.resumedAt);`.
- **Related:** apps/server/src/game/manager.ts:44; Claude lead 13; SOL-008
- **What happens:** For one persisted idle table at a fixed time, a fresh manager would not warn while an older manager starts the warning. Redis shares rooms, not resumedAt or recovery generations.
- **Impact:** Multi-worker deployments can close a table under inconsistent recovery promises; rolling starts can also cancel another worker’s warning.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs; expected one shared restart grace; actual old worker warns when fresh worker would not.
- **Root cause:** Clock origin and stale-warning decisions are local process state.
- **Recommended fix:** Persist a table/server recovery generation and shared grace deadline under row lock, with documented rolling-restart semantics. Schedule using the persisted deadline and revision. Preserve terminal closure and exactly-once payouts.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Disposable Postgres plus two server processes: rolling restart, full outage, old warning and racing keep-alive/closure.
- **Acceptance criteria:** Both workers derive the same warning/closure deadline; stale callbacks cannot cancel or close a newer generation.
- **Risk of the fix:** Requires migration and deployment coordination; the observed probe models two managers, not a real Redis cluster.

##### SOL-016: An active idle warning is not replayed to reconnecting lobby users

- **Severity:** S1 for real-money use; current play-chip impact: A lobby reload or token reconnect during a warning can hide the chance to keep the table.
- **Category:** FAIRNESS
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/socket/index.ts:115-121` (`socket connection AUTH_OK`); excerpt: `socket.emit(SOCKET_EVENTS.AUTH_OK, { userId, username, activeTableId });`.
- **Related:** apps/server/src/game/manager.ts:261-275; SOL-012; SOL-015
- **What happens:** Start a warning before the lobby connects. AUTH_OK gives the seated table ID but no current TABLE_IDLE_NOTICE; the browser has no warning dialog. The notice is emitted only on transitions.
- **Impact:** A seated player can miss the 10-second response window and be forced into closure/timeout treatment.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs and node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'warning'; expected current warning replay; actual activeTableId present, zero notices and no lobby alertdialog.
- **Root cause:** Authentication rehydrates the seat identity, not the current warning state.
- **Recommended fix:** On authenticated connection return the current authorized warning/closure status with generation and remaining deadline. Make client updates idempotent and clear obsolete generations; do not reintroduce lobby autojoin or unguarded table snapshots.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server auth during an active warning; Playwright reload lobby/reconnect/rotate token at 3 seconds remaining and exercise keep-alive.
- **Acceptance criteria:** An active warning is visible immediately after reauthentication and cannot be overwritten by an old notice.
- **Risk of the fix:** New shared payload contract; latency and expired notices require careful ordering.

##### SOL-017: Optional sound/storage failures prevent a poker action from being sent

- **Severity:** S1 for real-money use; current play-chip impact: A denied localStorage access leaves the action button permanently pending.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/components/table/action-bar.tsx:57-61` (`ActionBar.send / playSound`); excerpt: `setPending(true); playSound(...); try { ... }`.
- **Related:** apps/web/src/lib/sounds.ts:7-16
- **What happens:** Throw SecurityError from localStorage.getItem after the page loads and click Call. No ACTION_INTENT is emitted and the pending button stays disabled; audio construction can fail similarly.
- **Impact:** A cosmetic preference can cost a turn and strand controls.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'sound'; expected action sent despite sound failure; actual zero ACTION_INTENT and disabled Call.
- **Root cause:** Sound is executed before the action’s try/finally and optional browser I/O is not isolated.
- **Recommended fix:** Make audio and preference storage best-effort, catching denied storage/unsupported audio. Put pending lifecycle in a guaranteed finally; poker commands must not depend on audio success.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright with denied storage, absent AudioContext and throwing audio constructors; action still sent once and pending resets.
- **Acceptance criteria:** All legal actions remain usable with sound entirely unavailable; mount-time sound preference reads cannot crash controls.
- **Risk of the fix:** Minimal UI change; preserve deliberate user-gesture audio rules.

##### SOL-018: The turn countdown trusts the player’s wall clock

- **Severity:** S1 for real-money use; current play-chip impact: A device clock one hour ahead shows an empty clock while Call remains enabled.
- **Category:** FAIRNESS
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/components/table/seat-hud.tsx:42-45` (`SeatHUD`); excerpt: `snapshot.turnEndsAt - Date.now()`.
- **Related:** SOL-008; SOL-041; packages/shared/src/events.ts:146-150
- **What happens:** The turn bar derives its remaining time from an absolute server deadline minus the client wall clock instead of the snapshot’s relative remaining budget.
- **Impact:** Players misjudge their acting window; devices behind the server may show time after the server has expired it.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'clock'; expected positive countdown; actual transform scaleX(0) while an action is available.
- **Root cause:** Server and device epoch clocks are assumed equal.
- **Recommended fix:** Anchor remaining server time to performance.now(), adjusting for estimated delivery latency and resyncs. Show a textual deadline/remaining state and detect clock drift on servers. Keep server timeout authority.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright synthetic wall clock +/-1 hour and background-tab resume, delayed snapshots and clock jumps.
- **Acceptance criteria:** Countdown tracks the server’s remaining budget within a stated latency tolerance regardless of device date settings.
- **Risk of the fix:** Server clock discipline remains an operational requirement; no client countdown can guarantee network delivery time.

##### SOL-019: Absent players keep paying future blinds without an explicit policy

- **Severity:** S1 for real-money use; current play-chip impact: Repeated timeouts do not automatically sit an absent player out.
- **Category:** FAIRNESS
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/absence-and-config.mjs`)
- **Fix type:** NEEDS-DECISION (disconnect, timeout and seat-reservation policy)
- **Where:** `packages/engine/src/table.ts:323-329` (`applyTimeout / untrackSocket`); excerpt: `export function applyTimeout(...);`.
- **Related:** apps/server/src/game/manager.ts:48-49; Claude lead 13; SOL-007
- **What happens:** A two-player 30-hand probe times out one player 75 times; sittingOut remains false and their stack changes from 1,000 to 915. An active opponent keeps the table active, so table-wide idle closure does not protect the absent player.
- **Impact:** A disconnected/lobby/background user can keep exposing chips in future hands indefinitely. This is an unpublished policy gap, not a demonstrated arithmetic bug.
- **Reproduce:** node review/gpt-6.1-sol/repro/absence-and-config.mjs; expected defined absent-player protection; actual 30 hands, 75 timeouts, still sitting in and 915 chips remaining.
- **Root cause:** Presence is not tracked for gameplay and timeout affects only the current action.
- **Recommended fix:** Approve and publish automatic sit-out thresholds and reconnect behavior. Apply any sit-out between hands under the lock; keep all-in hands eligible and respect missed-blind rules. Avoid one tab disconnect removing an account still active elsewhere.
- **Regression test:** `packages/engine/src/__tests__/review-regressions.test.ts (new)`: Engine policy tests and multi-tab server/browser disconnect tests; live all-ins survive and future absent blinds stop at the published threshold.
- **Acceptance criteria:** Players can predict timeout/disconnection consequences; no unintended later deals occur after policy sit-out.
- **Risk of the fix:** Material house-rule change; league/tournament and cash policies may differ.

##### SOL-020: Game-integrity controls stop at legal actions and hidden-card isolation

- **Severity:** S1 for real-money use; current play-chip impact: Multiple accounts, collusion and external assistance are not detected.
- **Category:** MISSING-CAPABILITY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (game-integrity operations, staffing and vendor)
- **Where:** `apps/server/src/auth/routes.ts:130-140` (`guest / TableManager.intent`); excerpt: `username: `Guest_${suffix}``.
- **Related:** F06; SOL-005; SOL-027
- **What happens:** Any number of guests can play together. HUMAN is an account label, not evidence that a player is human or independent; no collusion, chip-dumping, RTA/bot or account-linking review system exists.
- **Impact:** Adversaries can exploit honest players without breaking betting validation or cryptography.
- **Reproduce:** rg --files apps/server/src; inspect guest issuance and hand persistence; no integrity detection/case service is present.
- **Root cause:** No game-integrity programme is implemented.
- **Recommended fix:** Add authorized identity/device/risk signals, hand-pattern review, anti-collusion and chip-dumping detection with human case handling. Publish rules and appeals; do not promise that CAPTCHA alone proves fair play.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Synthetic labeled collusion/chip-dumping cases, false-positive checks and enforcement/appeal audit tests.
- **Acceptance criteria:** A staffed, measured detection-and-response process exists before cash play; privacy lawful basis is documented.
- **Risk of the fix:** Detection errors can exclude honest users; thresholds and sanctions need policy and legal review.

##### SOL-021: Account security lacks uniform login work and privileged MFA

- **Severity:** S1 for real-money use; current play-chip impact: Login timing exposes account existence; no recovery or privileged step-up flow exists.
- **Category:** SECURITY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (account recovery and privileged-authentication model)
- **Where:** `apps/server/src/auth/routes.ts:116-121` (`login / adminRouter`); excerpt: `if (!user?.passwordHash || user.kind === "BOT") ...; await bcrypt.compare(...)`.
- **Related:** F07; apps/server/src/routes/admin.ts:41-44; SOL-024
- **What happens:** Unknown users return before bcrypt; known password users perform the expensive check. Admin access relies on password/JWT plus database role, with no MFA/step-up or managed recovery flow.
- **Impact:** Account enumeration and a stolen privileged session can expose full sealed decks; players cannot safely recover credentials. No ordinary auth bypass was found.
- **Reproduce:** rg -n 'bcrypt|passwordHash|ADMIN|authenticate' apps/server/src/auth/routes.ts apps/server/src/routes/admin.ts; code path shows differing work and no step-up.
- **Root cause:** Account hardening and privileged identity controls are incomplete.
- **Recommended fix:** Perform a dummy bcrypt check for nonexistent users, uniform errors and account-aware throttling. Require strong managed MFA/step-up for privileged audit/key actions; design email verification and recoverable accounts without weakening session revocation.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server timing/work-path tests and admin MFA expiry/revocation; recovery token single-use/rate-limit tests.
- **Acceptance criteria:** Unknown/known invalid logins follow equivalent expensive work; privileged operations require approved factors and logging.
- **Risk of the fix:** Existing admins and players need enrollment; uniform errors change registration/login UX.

##### SOL-022: Malformed request bodies bypass limits and enter error logs

- **Severity:** S1 for real-money use; current play-chip impact: An invalid JSON password marker is logged and requests return 500.
- **Category:** PRIVACY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/app.ts:39-58` (`createApp error middleware`); excerpt: `app.use(express.json(...)); ... logger.error({ err }, "request failed");`.
- **Related:** F08; apps/server/src/routes/admin-access-log.ts:19-23
- **What happens:** The parser runs before global/auth limits. Sixteen malformed requests bypass the auth limiter; parser errors log their body, including a synthetic password, and are incorrectly mapped to 500. Admin logs also retain arbitrary query strings via originalUrl.
- **Impact:** Passwords/tokens supplied in invalid bodies or URLs can reach durable logs; malformed traffic evades controls.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected 400 plus redaction and throttling; actual 500, synthetic password in log and parser-limit bypass.
- **Root cause:** Unfiltered error serialization and middleware ordering.
- **Recommended fix:** Apply appropriate pre-parser limits, map parser failures to 400/413, and log a safe error allow-list without body/credentials. Normalize admin route/path/query allow-lists; preserve every-request outcome logging.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server malformed JSON containing synthetic secrets and query credentials; inspect captured logs and 400/413/429 outcomes.
- **Acceptance criteria:** No secret marker appears in logs; parser abuse is limited; admin denials remain auditable.
- **Risk of the fix:** Logging schema changes affect incident tooling; redact before export, not only in a sink.

##### SOL-023: Encrypted state has one unversioned environment key and no rotation path

- **Severity:** S1 for real-money use; current play-chip impact: Loss of GAME_ENCRYPTION_KEY strands state and audits; rotation cannot be performed safely.
- **Category:** SECURITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** NEEDS-DECISION (KMS/HSM custody, rotation and recovery)
- **Where:** `apps/server/src/game/encryption.ts:3-20` (`encryptState / decryptState`); excerpt: `createCipheriv("aes-256-gcm", Buffer.from(env.GAME_ENCRYPTION_KEY, "hex"), iv)`.
- **Related:** F11; apps/server/src/config.ts:19-21,49; SOL-009
- **What happens:** AES-GCM uses one key for all live tables and sealed audits. The format has no key ID. Production checks accept an all-zero 32-byte AES key and reuse of that value as a JWT secret.
- **Impact:** Compromise has broad scope; replacement makes old data unreadable. Entropy cannot be established by checking string length.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected rejection of synthetic zero/reused keys; actual production config accepts them.
- **Root cause:** Key lifecycle, provenance and separation are not represented.
- **Recommended fix:** Use distinct managed encryption/signing keys and versioned envelope encryption with authenticated key IDs/contexts. Reject known placeholders/reuse, retain old decrypt keys through audited re-encryption and restoration drills. Keep random nonces and table/hand AAD.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Old/new key read/write, swapped key IDs, AAD mismatch, nonce uniqueness and staged rotation with disposable restored data.
- **Acceptance criteria:** A tested rotation/rollback/restore procedure exists; no production data becomes unreadable or plaintext.
- **Risk of the fix:** Requires ciphertext format migration and secure key-retention policy; never log key material.

##### SOL-024: Runtime database authority includes identity roles and credential hashes

- **Severity:** S1 for real-money use; current play-chip impact: A compromised game process can read hashes and change roles/balances.
- **Category:** SECURITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/live-aggregates.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/prisma/migrations/20260920140611_poker_security/migration.sql:24-37` (`role-grant migration`); excerpt: `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ... TO poker_server`.
- **Related:** F12; apps/server/prisma/schema.prisma:68-73; SOL-021
- **What happens:** Read-only live privilege checks return true for User UPDATE, role-column UPDATE and passwordHash SELECT. Hand UPDATE/DELETE and User DELETE are correctly denied.
- **Impact:** Compromise of a broadly privileged runtime expands into identity takeover, privileged deck access and arbitrary wallet changes. This is not a public RLS bypass.
- **Reproduce:** node review/gpt-6.1-sol/repro/live-aggregates.mjs (explicit READ ONLY; approved network access); actual privilege booleans above.
- **Root cause:** Table-level grants make identity and gameplay share one trust boundary.
- **Recommended fix:** Split identity/admin/wallet capabilities and restrict column grants or reviewed scoped procedures. Ordinary gameplay must not grant itself ADMIN or directly rewrite money. Keep server-only RLS and append-only hand restrictions.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Disposable roles: game role cannot change role/hash/ledger balance; permitted game operations still work, auth uses a narrower appropriate service.
- **Acceptance criteria:** Minimal grants are proved with actual role SQL, including all inherited privileges and deployment migrations.
- **Risk of the fix:** Grant/service separation is a migration and architectural change; avoid locking out legitimate auth during cutover.

##### SOL-025: Encryption and operator-held hashes do not prevent valid snapshot replay

- **Severity:** S1 for real-money use; current play-chip impact: A database/key insider can replay earlier valid encrypted state; complete deletion lacks an independent witness.
- **Category:** DATA
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (independent audit/state anchoring)
- **Where:** `apps/server/src/game/encryption.ts:14-19` (`decryptState / TableManager.load`); excerpt: `decipher.setAAD(Buffer.from(context)); return JSON.parse(...);`.
- **Related:** F13; apps/server/src/game/manager.ts:66-74; COMPLIANCE.md:106-107; SOL-026
- **What happens:** AAD binds a ciphertext to its table, not to an independently monotonic revision. Earlier valid ciphertext authenticates for that table. Operator-held chains cannot prove that the latest tail or every record was never deleted.
- **Impact:** Privileged rollback or wholesale rewriting may change history/state without independent detection. Existing client live evidence helps only observers who retained it.
- **Reproduce:** rg -n 'setAAD|decryptState|revision|previousHandHash' apps/server/src/game/encryption.ts apps/server/src/game/manager.ts packages/shared/src/audit.ts; no independent freshness authority exists.
- **Root cause:** No durable witness outside the writable/operator-controlled trust boundary.
- **Recommended fix:** Anchor commitments, settlement heads and wallet postings to independently controlled append-only/WORM evidence; verify state revision against an authenticated monotonic record. Document exact threat limits and avoid claiming all modifications/deletions are detectable.
- **Regression test:** `apps/server/test/audit-witness.test.mjs (new)`: Replay an earlier valid state and remove an audit tail in a disposable store; independent checkpoint must flag it without exposing hidden cards.
- **Acceptance criteria:** Rollback/deletion is detected relative to a retained independent checkpoint and procedures resolve mismatches fail closed.
- **Risk of the fix:** Anchoring incurs latency/cost and needs retention/availability design.

##### SOL-026: Audit verification accepts a re-sealed illegal betting sequence

- **Severity:** S1 for real-money use; current play-chip impact: Internal outcome verification is weaker than full rules replay; honest engine legality remains enforced.
- **Category:** FAIRNESS
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `packages/engine/src/audit.ts:186-203` (`verifyHandOutcome`); excerpt: `committed.set(seat, committed.get(seat)! + amount); if (FOLDS.has(event.data.action)) folded.add(seat);`.
- **Related:** F14; packages/shared/src/audit.ts:402-455; SOL-025
- **What happens:** Rewrite a CALL of 10 to CHECK of 10 and recompute hashes. Both card-integrity and outcome verification return success although a check cannot pay 10.
- **Impact:** A privileged forger can produce a self-consistent but illegal transcript accepted as an audited outcome. No ordinary client can bypass engine legality with this.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected illegal CHECK rejected; actual cardIntegrity=true, handOutcome=true.
- **Root cause:** Replay validates arithmetic and settlement rather than authoritative turn/minimum-raise/action legality.
- **Recommended fix:** Build an independent deterministic rules replay from a complete initial-state contract; validate actor, phase, amounts, reopening, statuses and timeout reasons. Version transcripts/rules; retain card redaction and current semantic checks.
- **Regression test:** `packages/engine/src/__tests__/review-regressions.test.ts (new)`: Jest/participant/server tests: re-sealed wrong actor, illegal check/call, undersized raise, reopening and phase-order forgeries; legitimate corpus still accepted.
- **Acceptance criteria:** All rule-invalid transcripts fail; all valid legacy/current audited versions behave under a documented compatibility policy.
- **Risk of the fix:** Audit schema/history versioning may require migration; do not expose sealed cards to participant replay.

##### SOL-027: Operational retention, restoration and financial incident procedures are unproved

- **Severity:** S1 for real-money use; current play-chip impact: Repository recovery cannot demonstrate deployment backup or support capability.
- **Category:** MISSING-CAPABILITY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** EXTERNAL (operator, SRE and privacy lead)
- **Where:** `apps/server/src/index.ts:55-60` (`shutdown / Session schema`); excerpt: `await prisma.$disconnect(); process.exit(0);`.
- **Related:** F22; apps/server/prisma/schema.prisma:86-98; SOL-009; SOL-023
- **What happens:** No repository evidence proves tested encrypted backup restoration, payout reconciliation, retention/deletion schedules, on-call game incidents or privileged key/deck access monitoring. One expired live session remains; this alone is not a retention violation.
- **Impact:** Failures can strand funds or personal data without a rehearsed resolution path. Actual external operations were not inspected.
- **Reproduce:** rg --files; inspect shutdown, schema and deployment docs. No executed production restore or operational controls were supplied.
- **Root cause:** Operational assurance and retention jobs/runbooks are outside the implemented application.
- **Recommended fix:** Publish runbooks and SLOs, validate draining and crash recovery, rehearse encrypted restores with required keys, and implement approved retention/data-rights workflows. Reconcile wallets and preserve required append-only evidence.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Disposable recovery drill with in-flight hands/payouts and restored keys; retention dry-run plus failure alerts.
- **Acceptance criteria:** Operator supplies executed drill, alert and retention evidence, with owners and escalation times.
- **Risk of the fix:** Retention changes need counsel approval and may conflict with audit/AML preservation; no blind history deletion.

##### SOL-028: Independent RNG, rules, security and production assurance are absent

- **Severity:** S1 for real-money use; current play-chip impact: In-repository tests are extensive, but do not constitute independent certification.
- **Category:** TEST-GAP
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** EXTERNAL (accredited testing laboratory and penetration-test provider)
- **Where:** `COMPLIANCE.md:105-112` (`known limitations`); excerpt: `Laboratory certification is still required.`.
- **Related:** SOL-005; SOL-026; SOL-027
- **What happens:** No laboratory report, scoped penetration-test report, production inspection or approved game rules certificate was provided. The docs acknowledge this.
- **Impact:** The highest online-poker assurance standard cannot be claimed from this code review or passing statistical samples.
- **Reproduce:** Inspect COMPLIANCE.md sections 6.1 and 6.8; no certification evidence is delivered with the repository.
- **Root cause:** Independent assurance/release approval has not been demonstrated.
- **Recommended fix:** After code/policy gates, commission the appropriate accredited assessment for the actual Malta/market deployment, RNG/game versions, custody boundaries and security configuration; track remediation to closure.
- **Regression test:** `external laboratory/penetration-test acceptance plan for exact build`: External test plans include game-rule corpus, hostile clients, insider/access boundary, financial fault tests and deployed infrastructure.
- **Acceptance criteria:** Evidence references the exact released build/config and all relevant critical/high issues are closed or formally resolved by the appropriate authority.
- **Risk of the fix:** Cost and lead time; code, infrastructure or rules changes may require reassessment.

##### SOL-029: Real database and multiple-process financial races remain unverified

- **Severity:** S1 for real-money use; current play-chip impact: In-memory tests cannot prove production locks, deadlocks and constraints.
- **Category:** TEST-GAP
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** EXTERNAL (CI/SRE provisioning a disposable Postgres and Redis test environment)
- **Where:** `apps/server/test/integration.test.mjs:1-24` (`integration test opt-in`); excerpt: `POKER_INTEGRATION_TESTS ... DATABASE_TEST_ADMIN_URL`.
- **Related:** Claude lead 3; SOL-001; SOL-010; SOL-015
- **What happens:** Docker/psql/disposable Postgres were unavailable. Existing integration tests require explicit opt-in; the normal passing server suite uses Prisma substitutes. No destructive live test was run.
- **Impact:** One-seat and payout concurrency invariants lack executed real-database evidence in this review. No actual seat-claim double debit was demonstrated.
- **Reproduce:** Get-Command docker,psql -ErrorAction SilentlyContinue; neither available; integration suite intentionally NOT RUN.
- **Root cause:** Required concurrency/fault CI gates are not part of the default evidence.
- **Recommended fix:** Provision an isolated database, apply both constraint/grant migrations, and run two independent server processes. Add real cross-table last-seat, create-versus-claim, timer-versus-action, restart and cash-out races. Keep the live database inaccessible to these tests.
- **Regression test:** `apps/server/test/integration.test.mjs and new two-worker race suite`: node:test integration with real rollback, constraints, lock waits/deadlocks and process kills; verify total ledger funds and seat uniqueness.
- **Acceptance criteria:** Documented CI run passes against a disposable instance; the same tests fail when a required lock/constraint is intentionally removed.
- **Risk of the fix:** Test fixtures must never reuse the repository-root live credentials.

##### SOL-030: Proxy TLS trust depends on an unverified network boundary

- **Severity:** S2 for real-money use; current play-chip impact: Development is allowed to use HTTP; production proxy security depends on ingress isolation.
- **Category:** CONFIG
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (ingress topology and application-port isolation)
- **Where:** `apps/server/src/transport.ts:42-48` (`isSecureTransport`); excerpt: `const raw = req.headers["x-forwarded-proto"]; ... return header.split(",")[0]!.trim().toLowerCase() === "https";`.
- **Related:** F15; apps/server/src/config.ts:40-48
- **What happens:** With proxy trust enabled the secure-transport decision accepts the forwarded-proto header from the connecting peer. Direct access to the app port would permit a client to assert HTTPS. Production rediss and strict database TLS guards do exist.
- **Impact:** A misconfigured deployment can bypass the intended transport gate. Actual public ingress was not probed.
- **Reproduce:** rg -n 'forwarded|proxy|secure' apps/server/src/transport.ts apps/server/src/config.ts; verify deployment firewall separately.
- **Root cause:** Proxy hop count is configuration, not proof that the peer is the trusted proxy.
- **Recommended fix:** Restrict app ingress to the proxy, overwrite forwarded headers there, validate trusted peer addresses/topology and test every engine.io request. Publish a hardened deployment configuration; keep TLS guards and HSTS.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Staging network test: untrusted direct peer/header rejected; trusted proxy HTTPS works; HTTP polling and upgrades fail.
- **Acceptance criteria:** The application port is unreachable to clients and header spoofing cannot satisfy the production transport gate.
- **Risk of the fix:** Topology changes affect health probes and rate-limit IP attribution.

##### SOL-031: Refresh sessions have no absolute lifetime or replay-family revocation

- **Severity:** S2 for real-money use; current play-chip impact: A very old rotating session remains valid; replay rejection does not revoke its descendants.
- **Category:** SECURITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** NEEDS-DECISION (session lifetime and stolen-token response)
- **Where:** `apps/server/src/auth/routes.ts:150-173` (`refresh`); excerpt: `expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)`.
- **Related:** F16; SOL-013
- **What happens:** The probe refreshes a session created 365 days earlier successfully. Reusing an old cookie returns 401, but the current access/session remains valid. Cookie/database expiry is hardcoded seven days while JWT_REFRESH_TTL is configurable.
- **Impact:** Stolen-session exposure can persist and lifetime settings disagree; ordinary concurrent tabs must not be misclassified as attackers.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected defined absolute cutoff; actual 365-day-old session refresh succeeds and replay leaves current access valid.
- **Root cause:** Only rolling expiry/current token hash is modeled, without family/absolute-age policy.
- **Recommended fix:** Define absolute session age, idle age, privileged sessions and replay response; store rotation/family evidence and distinguish legitimate concurrent refresh (SOL-013). Align cookie/JWT/database TTLs and support remote device revocation.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server old-created session, replay family and configured TTL tests plus multi-tab refresh regression.
- **Acceptance criteria:** Approved absolute/idle limits are enforced consistently; replay and honest races have distinct safe outcomes.
- **Risk of the fix:** Reauthentication affects long poker sessions; integrate the interrupted-turn policy.

##### SOL-032: Revoked sockets still receive private wallet and idle notifications

- **Severity:** S2 for real-money use; current play-chip impact: Wallet changes can reach a revoked session until another authentication-triggering event removes it.
- **Category:** PRIVACY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/game/manager.ts:245-247` (`TableManager.patchBankroll / idleNotices`); excerpt: `this.io?.to(`user:${userId}`).emit(SOCKET_EVENTS.USER_PATCH, ...);`.
- **Related:** F17; apps/server/src/game/manager.ts:275; SOL-011
- **What happens:** After the backing session is revoked, HTTP auth correctly rejects it but USER_PATCH still reaches the user room. TABLE_IDLE_NOTICE uses the same unconditional room delivery. Table/card broadcast does reauthenticate.
- **Impact:** A logged-out or revoked device can learn bankroll/seat information. No hidden-card leak was observed on guarded snapshots.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected revoked socket receives no wallet data; actual USER_PATCH contains the synthetic 10,000-chip balance.
- **Root cause:** Sensitive notification paths do not validate each receiving session or eagerly remove revoked sockets.
- **Recommended fix:** Route all private notifications through authorized per-socket delivery or reliable revocation-driven disconnection plus expiry checks. Preserve viewer-specific card projection and revalidate during dependency failures.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server session deletion/expiry before each notification type; all devices/tabs stop receiving sensitive payloads, unrelated valid sessions still receive them.
- **Acceptance criteria:** Revocation stops private data on every channel, including account-room fan-out.
- **Risk of the fix:** More auth checks may increase load; central revocation propagation must remain reliable across workers.

##### SOL-033: Cookie-authenticated mutations have no explicit origin/CSRF validation

- **Severity:** S2 for real-money use; current play-chip impact: A foreign-origin text/plain guest POST is accepted; no authenticated cross-site takeover was demonstrated.
- **Category:** SECURITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/app.ts:33-40` (`createApp / authRouter`); excerpt: `cors({ origin: env.CLIENT_ORIGIN, credentials: true })`.
- **Related:** F18; apps/server/src/auth/routes.ts:130-144; SOL-046
- **What happens:** CORS controls browser response access, not whether the route executes. The existing probe receives guest 201 from a foreign Origin with text/plain; production SameSite=Strict reduces cross-site authenticated cookie risk.
- **Impact:** Login/session state can be changed or resources abused by unintended origins, especially same-site sibling origins or alternate deployments.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected foreign-origin mutation rejected; actual text/plain guest POST returns 201.
- **Root cause:** State-changing routes rely on CORS/cookie policy without request-origin/type checks.
- **Recommended fix:** Enforce allowed Origin/Referer or a tested CSRF token for cookie-authenticated mutations; require expected media types. Define non-browser API exceptions explicitly; preserve Strict cookies and exact socket-origin rules.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server foreign/same-site sibling/null-Origin cases for guest/login/refresh/logout; legitimate first-party requests and approved API clients work.
- **Acceptance criteria:** Unapproved browser origins cannot perform session mutations even when cookies would be sent.
- **Risk of the fix:** Origin checks affect tools/native clients; do not accidentally break health probes.

##### SOL-034: Sensitive auth responses have no explicit no-store policy

- **Severity:** S2 for real-money use; current play-chip impact: Auth/me/session responses omit Cache-Control; no actual intermediary leak was tested.
- **Category:** PRIVACY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/auth/routes.ts:105-105` (`register / authRouter`); excerpt: `res.status(201).json(await issueSession(...));`.
- **Related:** F19; apps/server/src/auth/routes.ts:140,174-177,203-204
- **What happens:** Guest/session responses include an access token and user details; /me includes personal data. Probe headers show Cache-Control absent. Audit routes correctly use no-store.
- **Impact:** A future proxy/service worker/cache configuration may retain sensitive responses.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected Cache-Control no-store; actual auth/me and guest headers are null.
- **Root cause:** Auth router has no common response cache policy.
- **Recommended fix:** Set Cache-Control: no-store on all authenticated/token/session responses and appropriate Vary headers where needed. Verify CDN and service-worker rules do not override it. Retain existing audit-route policy.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server checks each auth endpoint including errors; staging proxy tests verify no reusable auth objects.
- **Acceptance criteria:** All sensitive responses explicitly prohibit storage; public assets retain normal caching.
- **Risk of the fix:** Small header change; may increase repeated auth network traffic.

##### SOL-035: Abuse limits and fan-out capacity are local and unmeasured

- **Severity:** S2 for real-money use; current play-chip impact: Several tabs/replicas can multiply expensive work; busy shared IPs can exhaust global limits.
- **Category:** RELIABILITY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (capacity targets and distributed abuse control)
- **Where:** `apps/server/src/app.ts:42-51` (`rateLimit / broadcast`); excerpt: `rateLimit({ windowMs: 60_000, limit: 120 });`.
- **Related:** F20; apps/server/src/socket/rate-limit.ts:4-28; apps/server/src/game/manager.ts:290-301
- **What happens:** HTTP limits are process-local IP counters; socket budgets are per socket/process. Each viewer broadcast reauthenticates via database. Lobby polling consumes shared IP budget: eleven 5-second polling clients use about 132 requests/minute before other requests.
- **Impact:** Load or adversarial connections can delay 15-second turns; replicas dilute limits while honest NAT users can receive 429. Actual production throughput is unmeasured.
- **Reproduce:** rg -n 'rateLimit|setInterval|authenticate|Promise.all' apps/server/src/app.ts apps/server/src/socket/rate-limit.ts apps/server/src/game/manager.ts apps/web/src/app/page.tsx; load tests not run.
- **Root cause:** No shared account/connection budget, fan-out backpressure or capacity evidence.
- **Recommended fix:** Use distributed per-account/IP/action controls with fair NAT allowances, connection/viewer caps, metrics and bounded fan-out. Benchmark real database latency, pool waits and bot CPU; keep authenticated private delivery.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Two-worker abuse tests, simulated shared NAT, spectator flood and sustained load with explicit latency/error SLOs.
- **Acceptance criteria:** Chosen load supports turn/payout deadlines; adding replicas does not multiply account limits or expose private data.
- **Risk of the fix:** Limits can block honest players; Redis outages need a defined fail-closed/fair degradation strategy.

##### SOL-036: Command IDs are not durable receipts and several commands lack acknowledgements

- **Severity:** S2 for real-money use; current play-chip impact: Lost replies leave outcomes ambiguous; stale revisions currently prevent ordinary double action.
- **Category:** CONCURRENCY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/socket/index.ts:129-158` (`Socket command handlers`); excerpt: `clientActionId: z.string().uuid(); ... socket.on(SEAT_CLAIM, (raw) => ...);`.
- **Related:** F21 (command delivery); Claude lead 4; packages/shared/src/events.ts:44,187-190; SOL-012; SOL-014
- **What happens:** ACTION_INTENT validates a clientActionId but never stores/looks it up. Retrying a successful action after a lost acknowledgement yields stale state, not its prior result. SEAT_CLAIM/SIT_IN/SIT_OUT have no ack contract.
- **Impact:** Players cannot reliably distinguish a failed request from committed action/seating; this is not a proved double debit because locks/revisions remain.
- **Reproduce:** rg -n 'clientActionId|ack|SEAT_CLAIM|SIT_IN|SIT_OUT' apps/server/src/socket/index.ts packages/shared/src/events.ts; ID is schema-only and these handlers omit acks.
- **Root cause:** Transport request identity is not persisted as transaction outcome.
- **Recommended fix:** Persist bounded, authenticated command receipts keyed by user/session and command ID in the locked transaction. Return the same outcome on replay; add acknowledgements and reconciliation for all state-changing commands.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: node:test and Playwright drop reply after commit, duplicate commands in two tabs and retry after reconnect; one mutation/credit and consistent outcome.
- **Acceptance criteria:** Every mutation has an unambiguous eventual result; receipts cannot be guessed/read across users or replayed as a different command.
- **Risk of the fix:** Requires schema/retention migration and shared contracts; do not weaken stale-revision checks.

##### SOL-037: Health reports success even when gameplay dependencies are unavailable

- **Severity:** S2 for real-money use; current play-chip impact: A load balancer cannot distinguish a live process from an unusable poker service.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/known-backend.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/routes/health.ts:6-12` (`healthRouter`); excerpt: `res.json({ ok: true, ... });`.
- **Related:** F21 (readiness); SOL-011; SOL-027
- **What happens:** The health route returns 200/ok with a database connection that cannot succeed. Startup checks do not provide ongoing readiness or drain state.
- **Impact:** Traffic can be routed to servers unable to authenticate, read or settle hands.
- **Reproduce:** node review/gpt-6.1-sol/repro/known-backend.mjs; expected separate unhealthy readiness; actual health always reports 200/true.
- **Root cause:** Liveness is exposed without a separate bounded readiness signal.
- **Recommended fix:** Keep lightweight liveness; add readiness for database/schema/key configuration and required fan-out dependencies, with timeout/cache and draining status. Never expose secrets or deep state in public health responses.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server tests dependency down/recovered and draining; deployment exercises remove/add the worker at the correct points.
- **Acceptance criteria:** Ready=false/503 during dependency failure or drain; healthy startup becomes ready only after required checks.
- **Risk of the fix:** Probe overload and flapping need hysteresis; maintain the permitted HTTP liveness exception.

##### SOL-038: Wallet updates can overwrite a newer balance with an older one

- **Severity:** S2 for real-money use; current play-chip impact: The screen can display 9,000 after 10,000 has already been delivered; database funds are unchanged.
- **Category:** UX
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/game/manager.ts:245-247` (`TableManager.patchBankroll / loadTables`); excerpt: `findUnique(... bankroll ...); ... emit(USER_PATCH, ...);`.
- **Related:** apps/web/src/app/page.tsx:30-35; packages/shared/src/events.ts:165-172; SOL-002
- **What happens:** Delay the first wallet read/delivery and finish a newer read first: payloads arrive [10000,9000]. The lobby’s auxiliary /me fetch also patches without a wallet-version guard. Both were reproduced.
- **Impact:** Bankroll display and affordable buy-in choices become stale after cash-out or another tab’s activity.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs and node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'wallet'; expected newest 10000 retained; actual final displayed 9000.
- **Root cause:** Wallet events have no persisted monotonic revision; some client fetch paths bypass the local anti-stale guard.
- **Recommended fix:** Add wallet revision to transaction/API/events and reject older revisions everywhere. Preserve existing refresh and on-connect walletVersion guards until the durable contract replaces them.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server reversed delivery order plus Playwright delayed lobby /me and cash-out; newest balance wins, no synthetic extra credit.
- **Acceptance criteria:** All wallet sources are monotonic within one account; account switching resets safely.
- **Risk of the fix:** Revision field/backfill is a migration; old clients need compatibility handling.

##### SOL-039: The Next.js origin supplies no framing or content security policy

- **Severity:** S2 for real-money use; current play-chip impact: Local web responses lack CSP and X-Frame-Options; a deployed proxy was not inspected.
- **Category:** SECURITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/next.config.ts:4-14` (`nextConfig`); excerpt: `const nextConfig: NextConfig = { ... };`.
- **Related:** apps/server/src/app.ts:23; SOL-007
- **What happens:** API Helmet runs on the API origin. The separate Next origin has no headers configuration; browser probes find neither Content-Security-Policy nor X-Frame-Options.
- **Impact:** Clickjacking is not prevented by app-provided web headers, and XSS lacks a policy containment layer. No working XSS injection was found.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'headers'; expected web-origin policy; actual both CSP and X-Frame-Options absent.
- **Root cause:** Security headers cover only the backend origin.
- **Recommended fix:** Add production framing denial/frame-ancestors and a measured CSP with per-response nonce or supported hashes, exact websocket/API/font sources and a staged report-only rollout. Keep development needs separate and verify the deployed edge.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright response/header and malicious-frame tests; test login, sockets, styles and hydration under the enforcing production CSP.
- **Acceptance criteria:** Actual web responses deny unauthorized framing and enforce the approved CSP without breaking gameplay.
- **Risk of the fix:** CSP can break Next hydration/fonts or websocket transport if configured carelessly.

##### SOL-040: Case-sensitive and reserved usernames enable identity confusion

- **Severity:** S2 for real-money use; current play-chip impact: Alice/alice and guest-like registered names can coexist; this is not password-account takeover.
- **Category:** SECURITY
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (canonical names and reserved/disclosed account identities)
- **Where:** `apps/server/src/auth/routes.ts:15-19` (`usernameSchema`); excerpt: `regex(/^[a-zA-Z0-9_]+$/); username String @unique`.
- **Related:** Claude lead 7; apps/server/prisma/schema.prisma:67; SOL-020; SOL-050
- **What happens:** Registration permits Guest_1a2b3c and case variants; PostgreSQL ordinary unique text compares case sensitively. Players see usernames without an immutable identity/verified-kind badge.
- **Impact:** Impersonation and confusion assist collusion, disputes and support errors.
- **Reproduce:** rg -n 'username|Guest_' apps/server/src/auth/routes.ts apps/server/prisma/schema.prisma; ordinary uniqueness is case-sensitive and no reserved-name check exists.
- **Root cause:** Display name, login identity and generated role naming share an unnormalized namespace.
- **Recommended fix:** Approve case-folding/reserved prefixes and stable identity display; store a canonical unique identifier and clearly distinguish guest/legacy bot/verified roles. Resolve existing collisions explicitly without merging accounts/funds.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server case-variant/reserved-name registration and migration collision fixtures; UI shows approved identity markers.
- **Acceptance criteria:** Names follow one documented policy and cannot impersonate system roles; login/recovery respects canonical identity.
- **Risk of the fix:** Requires a collision-aware migration and user rename notices.

##### SOL-041: Reduced-motion styling collapses the meaningful turn clock

- **Severity:** S2 for real-money use; current play-chip impact: The time bank immediately appears exhausted with reduced motion enabled.
- **Category:** A11Y
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/app/globals.css:222-223` (`reduced-motion CSS / SeatHUD`); excerpt: `* { animation-duration: .01ms !important; }`.
- **Related:** apps/web/src/components/table/seat-hud.tsx:95-101; SOL-018
- **What happens:** The semantic timebank-drain animation is included in the blanket .01ms rule. Corrected browser diagnostics observed a finished 0.01ms animation with scaleX(0) initially and 1.2 seconds later while a turn was active.
- **Impact:** Reduced-motion users lose visible time information, potentially misjudging a turn.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'reduced'; diagnostic duration 0.00001s and final scaleX(0). Source establishes the blanket rule; do not treat this diagnostic-only test as a comprehensive a11y assertion.
- **Root cause:** A timing indicator is treated as decorative motion.
- **Recommended fix:** Provide a nonanimated textual/stepped remaining-time indicator under reduced motion; separate decorative transitions from semantic deadlines. Keep server-authoritative time and accessible names.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright emulate reduced motion after styles settle; assert readable positive remaining budget during an active turn and correct expiry.
- **Acceptance criteria:** Reduced-motion users receive the same deadline information without unnecessary movement.
- **Risk of the fix:** CSS changes must preserve clock behavior for ordinary users; first exploratory sample raced media/style application.

##### SOL-042: Call-button text contrast is below WCAG AA for normal text

- **Severity:** S2 for real-money use; current play-chip impact: The enabled Call button measures approximately 3.19:1 instead of 4.5:1.
- **Category:** A11Y
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/components/table/action-bar.tsx:103-109` (`ActionBar`); excerpt: `bg-emerald-600 text-white`.
- **Related:** SOL-043; legal exposure register
- **What happens:** Browser computed colors yield contrast 3.1858692567863036 for 16px, font-weight 400 Call text. This is normal, not large text.
- **Impact:** Low-vision players have difficulty reading a consequential action.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'contrast'; expected >=4.5; actual 3.1858692567863036.
- **Root cause:** The button palette was not checked against its actual text size/background.
- **Recommended fix:** Choose colors giving at least 4.5:1 for normal action text; verify every state/background and focus indicator. Keep labels and button semantics.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright computed-color checks plus manual high-contrast/zoom review; include hover/disabled treatment without relying on color alone.
- **Acceptance criteria:** Enabled consequential controls meet WCAG 2.2 contrast criteria; document exemptions only where applicable.
- **Risk of the fix:** Minor visual palette change; legal applicability still requires counsel review.

##### SOL-043: Turn ownership and remaining time are not announced accessibly

- **Severity:** S2 for real-money use; current play-chip impact: A check can move the actor without an announced phase or pot change.
- **Category:** A11Y
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/components/table/poker-felt.tsx:44-55` (`PokerFelt / SeatHUD`); excerpt: `<div className="poker-table-center" aria-live="polite">`.
- **Related:** apps/web/src/components/table/action-bar.tsx:83; apps/web/src/components/table/seat-hud.tsx:95-101; SOL-018; SOL-042
- **What happens:** The live status covers phase/pot/result, but actor changes at constant phase/pot are primarily visual. The time bank has no accessible remaining-time value, and Your turn is not a dedicated announcement.
- **Impact:** Screen-reader users may miss a short acting opportunity. No assistive-technology session was executed.
- **Reproduce:** rg -n 'aria-live|Your turn|timebank' apps/web/src/components/table/poker-felt.tsx apps/web/src/components/table/action-bar.tsx apps/web/src/components/table/seat-hud.tsx; actor/deadline changes lack dedicated status.
- **Root cause:** Accessible status does not model the game’s turn/deadline state.
- **Recommended fix:** Add deduplicated, account-specific turn announcements with coarse remaining-time warnings and a readable timer. Avoid flooding live regions every frame; preserve card/seat/action names and dialog focus management.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright accessibility snapshots for actor-only CHECK transitions, then manual NVDA/VoiceOver keyboard play.
- **Acceptance criteria:** A user can identify whose turn it is and their deadline without sight, with no announcement storm.
- **Risk of the fix:** Announcement timing should be tested with real assistive technology.

##### SOL-044: Joining a seat silently chooses the buy-in for the player

- **Severity:** S2 for real-money use; current play-chip impact: Clicking Sit here can move the entire available bankroll up to approximately 100 big blinds.
- **Category:** UX
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (join buy-in selection and confirmation)
- **Where:** `apps/web/src/app/table/[id]/page.tsx:59-60` (`TablePage.claimSeat`); excerpt: `Math.min(snapshot.maxBuyIn, bankroll, Math.max(snapshot.minBuyIn, snapshot.bigBlind * 100))`.
- **Related:** Claude lead 12; apps/web/src/app/table/[id]/page.tsx:81-84; apps/web/src/components/table/seat-hud.tsx:37-39
- **What happens:** The joiner has no amount selector or disclosed amount on the seat button. Creation supports custom buy-in and both server/engine correctly enforce 20–200 BB.
- **Impact:** A player cannot choose how much to expose at the table and may commit more than intended.
- **Reproduce:** rg -n 'defaultBuyIn|buyIn:|Sit here' 'apps/web/src/app/table/[id]/page.tsx' apps/web/src/components/table/seat-hud.tsx; fixed derived amount is sent without a selector.
- **Root cause:** Seat claim derives an amount from default UI state without confirmation.
- **Recommended fix:** Show an explicit buy-in selector/confirmation with min/max, available balance and exact resulting wallet; default 100 BB only as an editable suggestion. Keep authoritative server bounds and atomic debit.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright low bankroll, custom blinds, decimal input and changing wallet; no debit until explicit amount confirmation.
- **Acceptance criteria:** The amount is visible and accepted before seating; server still rejects stale/invalid balances.
- **Risk of the fix:** Changes one-click joining; owner must approve the intended user flow.

##### SOL-045: A fresh closed-table visit cannot reach its participant audit in the UI

- **Severity:** S2 for real-money use; current play-chip impact: Reloading an already closed table removes the Verify hand entry point.
- **Category:** UX
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/components/table/idle-close-dialog.tsx:346-351` (`IdleCloseDialog`); excerpt: `const lastHand = closure.kind === "closed" && snapshot ? auditableHand(snapshot, true) : 0;`.
- **Related:** apps/web/src/components/table/idle-close-dialog.tsx:407-416; apps/web/src/hooks/use-table-socket.ts:28-29; SOL-007
- **What happens:** Load a closed table with finalHandNumber=1 in a fresh page. Join is correctly refused and no previous snapshot exists, so the closed dialog has no Verify hand control. The participant API remains available when the user was dealt in.
- **Impact:** Players lose convenient evidence/dispute access after navigation or refresh.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'closed'; expected audit entry point for prior participant; actual no Verify hand on fresh closed-table page.
- **Root cause:** Audit navigation depends on retaining the last live snapshot rather than a durable participant hand list.
- **Recommended fix:** Add authenticated participant-owned history/listing and route-independent audit navigation, including closed tables. Preserve participant authorization and do not reopen or publicly expose closed private tables.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright closure then fresh reload/new tab; participant can verify permitted final hand, outsider cannot discover private history.
- **Acceptance criteria:** Completed participant audits remain reachable through UI after closure/logout-login without live state.
- **Risk of the fix:** New read API/indexing and privacy boundary require tests.

##### SOL-046: Production cookie policy requires a same-site deployment that is not enforced

- **Severity:** S2 for real-money use; current play-chip impact: Default unrelated hosting domains can make session refresh fail in production.
- **Category:** CONFIG
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (same-site web/API domains or a backend-for-frontend)
- **Where:** `apps/server/src/auth/routes.ts:40-46` (`setRefreshCookie`); excerpt: `sameSite: isProd ? "strict" : "lax"`.
- **Related:** apps/server/src/config.ts:16; apps/web/src/lib/api.ts:22-27; SOL-033
- **What happens:** CLIENT_ORIGIN permits any HTTPS origin. A web domain and API on unrelated registrable domains are cross-site, so Strict refresh cookies are not sent by credentialed browser fetch. This topology was not executed.
- **Impact:** Login may initially work via access token, then refresh/sign-in restoration fails.
- **Reproduce:** rg -n 'sameSite|CLIENT_ORIGIN|credentials' apps/server/src/auth/routes.ts apps/server/src/config.ts apps/web/src/lib/api.ts; compare actual hostnames before deployment.
- **Root cause:** Allowed CORS origin and required cookie site topology are not validated/documented as one deployment contract.
- **Recommended fix:** Prefer HTTPS app/api under the same registrable domain or a same-origin BFF. Validate/document the chosen topology. If cross-site is essential, design CSRF defenses and third-party-cookie constraints before changing cookie policy.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Production-mode browser run on representative test hostnames/scheme; login, refresh, reload, logout and hostile origins.
- **Acceptance criteria:** Approved deployment supports cookies reliably and passes Origin/CSRF tests; Strict is not removed merely to make a default hosting URL work.
- **Risk of the fix:** Domain/TLS/proxy changes; third-party-cookie support varies by browser.

##### SOL-047: Startup accepts unusable bankroll, timer and JWT lifetime settings

- **Severity:** S2 for real-money use; current play-chip impact: An allowed configuration can make accounts fail or turns expire immediately.
- **Category:** CONFIG
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/absence-and-config.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/config.ts:23-26` (`envSchema`); excerpt: `JWT_ACCESS_TTL: z.string(); TURN_TIME_BANK_MS: ...positive();`.
- **Related:** apps/server/src/game/manager.ts:352; SOL-002; SOL-031
- **What happens:** The probe accepts starting bankroll and time bank of 2,147,483,648, beyond Postgres Int/Node timeout range, and JWT_ACCESS_TTL=not-a-duration. Node overlarge setTimeout delays clamp to a short delay; JWT issuance validates too late.
- **Impact:** Configuration errors can disable registration or cause premature timeouts; default settings do not exhibit the overflow.
- **Reproduce:** node review/gpt-6.1-sol/repro/absence-and-config.mjs; expected invalid configuration rejected; actual all three accepted. Delay-clamping consequence is platform semantics/code inference, not a live financial test.
- **Root cause:** Format/positivity validation lacks operational bounds and parsed duration constraints.
- **Recommended fix:** Bound port/time/money values to safe storage/Node scheduling limits, parse JWT durations at startup and derive refresh scheduling from expiry. For future large timers, schedule bounded chunks against authoritative deadlines.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: Server config child-process tests for boundaries and malformed TTLs; no DB connection required.
- **Acceptance criteria:** All unusable combinations fail startup with a safe message; valid expiry/clock settings match the client contract.
- **Risk of the fix:** Tightening settings may reject existing deployments; provide migration/release notes.

##### SOL-048: Play chips are labeled as dollars without clear nonredeemable disclosure

- **Severity:** S2 for real-money use; current play-chip impact: Bankroll, pots and actions display dollar symbols even though no money service exists.
- **Category:** DOCS-CLAIMS
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** NEEDS-DECISION (demo units, currencies and redemption disclosure)
- **Where:** `apps/web/src/app/page.tsx:144-144` (`Lobby`); excerpt: `${user.bankroll.toLocaleString()}`.
- **Related:** Claude lead 8; apps/web/src/components/table/action-bar.tsx:106; SOL-003; SOL-007
- **What happens:** The lobby shows $bankroll, Need at least $1,000, and table controls use dollar amounts; visible gameplay does not consistently identify nonredeemable play chips or an actual fiat/crypto asset.
- **Impact:** Players can infer a monetary balance or payout capability that the product does not provide. Verify consumer-facing claims with counsel.
- **Reproduce:** rg -n '\$|bankroll|chips' apps/web/src/app/page.tsx apps/web/src/components/table/action-bar.tsx; current copy uses dollars for demo balances.
- **Root cause:** Presentation units are hardcoded as money while accounting is demo chips.
- **Recommended fix:** Use explicit Play chips/nonredeemable wording and neutral chip units today. Later render the actual approved asset and precision from the ledger; disclose exchange/fee rules instead of silently substituting $.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright checks lobby, actions, closure notices and audit displays for approved demo/asset units.
- **Acceptance criteria:** A first-time user can identify the balance’s asset and redemption status everywhere.
- **Risk of the fix:** Copy/format change; multi-asset precision and locale formatting require shared display contracts.

##### SOL-049: Decimal bet input remains enabled and sends a rejected amount

- **Severity:** S3 for real-money use; current play-chip impact: Typing 20.5 produces an enabled action that the engine correctly rejects.
- **Category:** UX
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/browser-defects.spec.ts`)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/components/table/action-bar.tsx:41-42` (`ActionBar`); excerpt: `Math.min(max, Math.max(min, amount)); Number(e.target.value)`.
- **Related:** Claude lead 8; apps/web/src/components/table/action-bar.tsx:127-137
- **What happens:** The numeric input can hold a decimal; clamping preserves it while the slider rounds separately. Clicking sends 20.5 and returns Amount must be a positive whole number. Empty/non-numeric input is normalized/clamped and does not bypass server validation.
- **Impact:** A wasted click and confusing error; server funds remain protected.
- **Reproduce:** node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts --grep 'decimal'; expected invalid input cannot submit; actual 20.5 emitted and rejected.
- **Root cause:** Client amount state validates bounds but not integer finiteness consistently.
- **Recommended fix:** Validate one finite integer amount model for input, slider and shortcuts. Show the invalid state/disable submit or explicitly normalize before sending; preserve server integer and min/max checks.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Playwright decimal, empty, NaN/non-numeric, out-of-range and all-in/raise-to cases; no invalid intent emitted.
- **Acceptance criteria:** Input, slider label and sent amount agree; valid integer amounts still work.
- **Risk of the fix:** Small input behavior change; do not silently round a financial amount without clear feedback.

##### SOL-050: Unique-account races and small guest suffix collisions surface as 500

- **Severity:** S3 for real-money use; current play-chip impact: A legitimate registration race/guest collision receives a generic server failure.
- **Category:** RELIABILITY
- **Confidence:** CONFIRMED (repro: `review/gpt-6.1-sol/repro/server-faults.mjs`)
- **Fix type:** CODE-NOW
- **Where:** `apps/server/src/auth/routes.ts:89-105` (`register / guest`); excerpt: `const existing = await prisma.user.findFirst(...); ... user.create(...);`.
- **Related:** Claude lead 7; apps/server/src/auth/routes.ts:131-140; SOL-040
- **What happens:** Two registrations can pass the pre-check before the database unique constraint wins. Guest names use only six hex characters (24 bits) without retry; injected Prisma P2002 returns HTTP 500.
- **Impact:** Account creation fails intermittently as usage grows; no duplicate account or balance violation was shown.
- **Reproduce:** node review/gpt-6.1-sol/repro/server-faults.mjs; expected bounded retry/controlled conflict; actual guest P2002 becomes HTTP 500. Registration race follows the same uncaught code path.
- **Root cause:** Database uniqueness errors are neither classified nor recovered on the generated-name path.
- **Recommended fix:** Map known registration uniqueness conflicts to a controlled response, consistent with enumeration policy. Use a much larger guest namespace and bounded retry for that specific constraint. Leave other database failures retryable/observable.
- **Regression test:** `apps/server/test/review-regressions.test.mjs (new)`: node:test simultaneous register and forced guest P2002 collisions; no duplicate identity, bounded retries and sanitized logs.
- **Acceptance criteria:** Expected collisions return a stable user-facing result without 500; provider/database outages are not masked as collisions.
- **Risk of the fix:** Guest naming/display change; handle old names without renaming funds.

##### SOL-051: Metadata and tooling guidance advertise outdated product/deployment behavior

- **Severity:** S3 for real-money use; current play-chip impact: Search/social metadata advertises AI opponents although new tables are human-only.
- **Category:** DOCS-CLAIMS
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** CODE-NOW
- **Where:** `apps/web/src/app/layout.tsx:19-19` (`metadata`); excerpt: `description: "Real-time Texas Hold'em with autonomous AI opponents"`.
- **Related:** Claude lead 9; package.json:5; .cursor/rules/supabase.mdc:10; SOL-030
- **What happens:** Page/root-package descriptions advertise AI opponents. Cursor guidance describes the target as local Docker, while explicitly read-only inspection reaches live Supabase. Legacy bots are separately disclosed in the lobby and seed remains a local bot fixture.
- **Impact:** Players are misled about who they play; contributors can misunderstand the live-data boundary.
- **Reproduce:** rg -n 'AI|bots|local|Docker' apps/web/src/app/layout.tsx package.json .cursor/rules/supabase.mdc; compare human-tables tests and read-only live evidence.
- **Root cause:** Documentation/metadata were not updated with the human-only and live database changes.
- **Recommended fix:** Update current metadata and operational guidance to the actual human-only demo/live database setup. Label historical milestones and local seed behavior clearly; keep explicit live-data safeguards.
- **Regression test:** `apps/web/test/browser/review-regressions.spec.ts (new)`: Static copy inventory plus Playwright metadata/lobby comparison; documented local commands use an explicitly disposable database.
- **Acceptance criteria:** Current guidance matches implemented behavior and warns accurately that root .env targets live data.
- **Risk of the fix:** Copy-only change; keep historical dated records distinct from current requirements.

##### SOL-052: Shared odd-chip contract comment names the wrong starting position

- **Severity:** S4 for real-money use; current play-chip impact: The implementation is correct; the type comment can mislead a future fixer.
- **Category:** DOCS-CLAIMS
- **Confidence:** LIKELY (code evidence, not executed; deployed controls outside this repository are unverified)
- **Fix type:** CODE-NOW
- **Where:** `packages/shared/src/poker.ts:33-34` (`PotShare.oddChipSeatIndex`); excerpt: `/** Casino odd-chip rule: earliest position past the blinds. */`.
- **Related:** packages/engine/src/pots.ts:100-128; claims check
- **What happens:** PotShare documents odd chips as earliest position past the blinds, whereas splitOddChips starts clockwise left of the dealer/button and skips to eligible winners.
- **Impact:** A contributor following this contract literally could change a correct settlement rule. No wrong odd-chip payment was observed.
- **Reproduce:** rg -n 'earliest position|left of the dealer|seatingOrderFromBlinds' packages/shared/src/poker.ts packages/engine/src/pots.ts; expected agreement; actual comment says past the blinds.
- **Root cause:** The shared type comment does not match the implemented and tested house rule.
- **Recommended fix:** Correct the comment to first eligible winner clockwise left of the button. Keep actual pot ordering unchanged and publish the same rule in house rules.
- **Regression test:** `packages/engine/src/__tests__/pots-reference.test.ts (existing)`: Reuse the existing pot-reference and odd-chip tests; do not add a test that merely mirrors a comment.
- **Acceptance criteria:** Shared comment, actual settlement and published house rule describe the same position; existing odd-chip tests still pass.
- **Risk of the fix:** Documentation only; changing the engine ordering would introduce a regression.


#### 7. Decisions needed from the owner

| Decision | Options | Recommendation | Blocked findings |
|---|---|---|---|
| Public release scope | Private demo; public play chips; cash | Fix the current player-harm/security defects and publish nonredeemable demo rules before public play; keep cash disabled until all launch gates pass. | SOL-001–007, SOL-008–019 |
| Markets/licence | Malta only; named additional markets; worldwide | Counsel-approved explicit allowed-market matrix. A Malta licence is not blanket worldwide permission. | SOL-005–007, SOL-028 |
| Assets/custody | Single fiat provider; approved crypto provider; operator self-custody | Start with narrowly scoped authorized providers after due diligence; self-custody requires separate key security, staffing and regulatory assessment. No provider was selected or vetted in this pass. | SOL-002–005, SOL-023 |
| Accounting | Demo Int counters; single cash asset; multi-asset ledger | Separate demo asset permanently; immutable balanced financial ledger with escrow/holds, per-asset integer units and reconciliation. | SOL-001–004, SOL-038 |
| Rake/fees | No rake; capped pot rake; other approved schedule | Decide explicitly and publish exact rounding, caps, no-flop rules and fees before adding any real charges. Current pot settlement is zero rake. | SOL-002, SOL-007 |
| Account/identity | Anonymous demo; verified cash; guest conversion | Guests only for nonredeemable demo; durable verified cash identity with recovery/MFA and exclusions. | SOL-003, SOL-005–006, SOL-020–021, SOL-040 |
| Interrupted turns | Resume paused budget; reconnect grace; published timeout | Persisted pause/grace policy agreed with game-integrity/counsel and laboratory, consistent across workers. | SOL-008–009, SOL-012, SOL-015, SOL-018 |
| Absent players | Indefinite automatic check/fold; timeout threshold sit-out; presence-based policy | Explicit bounded automatic sit-out with multi-tab handling, applied between hands; all-in pot rights remain. | SOL-019, SOL-007 |
| Idle closure | Current 5min+10s; longer warning; move to safe inter-hand closure | Evaluate longer notice/last-hand completion against high latency, phones and background tabs; publish forced-settlement consequences and resolve missed/replayed notices first. | SOL-007–008, SOL-015–016 |
| House rules | Current cash variants; tournament variants; selected published standard | Publish no-limit cash rules, including dead button, wait-for-BB, odd chips left of button, all-in/auto-action treatment, show/muck and closure. TDA is a comparison, not automatic adoption. | SOL-007, SOL-019, SOL-026 |
| Join amount | Silent 100BB; visible editable amount; predefined stakes | Explicit amount selection/confirmation before any debit. | SOL-044 |
| Currency display | Dollar symbols; chips; specific currency/crypto asset | Nonredeemable play chips now; exact asset/precision when money is implemented. | SOL-048 |
| Session policy | Sliding only; absolute+idle TTL; privileged limits | Define absolute/idle limits and replay handling; coordinate honest tab refreshes and safe turn recovery. | SOL-013, SOL-021, SOL-031 |
| Hosting topology | Shared registrable domain; same-origin BFF; cross-site cookies | HTTPS same-site app/API or BFF with ingress isolation; verify actual staging topology. | SOL-030, SOL-033, SOL-039, SOL-046 |
| Legacy bots | Continue; quarantine/retire; isolate worker | Quarantine fragile legacy scheduling until fixed; retire or isolate bots with clear disclosure. Human-only new table validation stays. | SOL-014, SOL-020, SOL-035, SOL-051 |
| Recovery/keys/witness | Environment key only; managed keys; independent append-only evidence | Managed separated keys with tested restore/rotation; independent audit/wallet checkpoints and dual-control repair. | SOL-009, SOL-023–027 |

#### 8. Legal and regulatory exposure register

All entries below mean **verify with counsel**, not a legal conclusion or finding of a violation. Sources were checked on **2026-09-30**. Regulatory applicability depends on operator, players, actual contracts, assets and deployment; none of those approvals was established here. Repository comments saying “COMPLIANCE” are implementation labels.

| Item | Repository evidence | Why it matters / counsel question | Primary source checked |
|---|---|---|---|
| Licence and market access | Guest/session/seat flow; no licence/market eligibility fields (SOL-005) | Verify with counsel: Malta remote peer-to-peer poker licence/type and approvals for each served country. | [MGA B2C remote gaming services](https://www.mga.org.mt/licensee-hub/applications/b2c-licences/remote-gaming-services/) describes Type 3 peer-to-peer games including poker. |
| Age, identity, AML and sanctions | Instant guest; no admission/risk workflow (SOL-005) | Verify with counsel/MLRO: due-diligence timing, ongoing monitoring, source of funds/wealth, recordkeeping and reporting appropriate to this operator. | [MGA AML/CFT](https://www.mga.org.mt/licensee-hub/compliance/anti-money-laundering/). |
| Responsible gaming | No exclusion/limit/reality-check flow (SOL-006) | Verify with counsel: implement the mandatory tools and limit-change/exclusion rules; no replacement anonymous cash identities. | [MGA mandatory responsible-gaming tools](https://www.mga.org.mt/faqs/remote-gaming-are-there-any-mandatory-responsible-gambling-tools-which-must-be-offered-to-players/) lists exclusion, deposit or wagering limits and reality checks. |
| Protection of funds | Mutable counters, no assets/segregation/reconciliation (SOL-002–004) | Verify with counsel: segregation/identifiability and insolvency/custody arrangements, actual provider safeguarding and player disclosures. | [MGA player-funds protection](https://www.mga.org.mt/faqs/how-are-player-funds-protected/). |
| Crypto/DLT gambling approval | No chain/custody workflow (SOL-004) | Verify with counsel: required MGA approval and permitted technologies/assets; a payment provider does not automatically discharge operator obligations. | [MGA DLT approval](https://www.mga.org.mt/faqs/how-can-licensees-obtain-an-approval-in-order-to-make-use-of-distributed-ledger-technology-dlt/), [MGA DLT policy announcement](https://www.mga.org.mt/the-mga-publishes-its-policy-on-the-use-of-distributed-ledger-technology-by-authorised-persons/). |
| Crypto custody/service authorization | Owner has not chosen self-custody/provider | Verify with counsel/MFSA: whether the actual custody/service arrangement falls within MiCA or other financial-services requirements; verify provider authorization/scope independently. | [MFSA crypto-assets](https://www.mfsa.mt/our-work/crypto-assets/), [MFSA authorisations](https://www.mfsa.mt/our-work/authorisations/). |
| Terms, disputes and player information | Three routes; no published terms/rules/complaints (SOL-007) | Verify with counsel: understandable terms, fees, game/disconnect/closure rules, complaints/escalation and relevant protections before onboarding. | [MGA player protection](https://www.mga.org.mt/licensee-hub/compliance/player-protection/). |
| Personal data and retention | Email/password hash; Session IP/user agent; gameplay; raw parser logs; evidence storage (SOL-007,022,027,032,034) | Verify with counsel/DPO: privacy information, lawful basis, processor/transfers, security, rights and retention schedule. Essential storage does not automatically require a consent banner. | [GDPR official EUR-Lex text](https://eur-lex.europa.eu/legal-content/EN/ALL/?tid=121438634&uri=celex%3A32016R0679), especially information/security requirements. Search-indexed official text was available; direct ELI/PDF opens hit an anti-bot page. |
| Accessible service | Measured 3.19:1 button, reduced-motion clock, absent turn announcements (SOL-041–043) | Verify with counsel: European Accessibility Act/Maltese implementation scope and exemptions for the actual consumer service. WCAG observations are technical findings, not legal determinations. | [Directive (EU) 2019/882](https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1750773214845&uri=CELEX%3A32019L0882), [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Official directive search text available; direct PDF anti-bot blocked full retrieval. |
| Claims, bots and currency | Dollar demo labels; AI metadata; broad tamper wording (SOL-025,048,051) | Verify with counsel: advertise only the actual game/asset and measured assurances; no “certified”, “compliant” or guaranteed fairness/security claims without supporting approval. | [MGA player protection](https://www.mga.org.mt/licensee-hub/compliance/player-protection/); implementation claims compared in section 9. |
| Reporting/audit assurance | Two fully audited live hands; 54 legacy hands, no cutover gap seen | Verify with counsel/lab: required records, technical assessment, reporting and approval process for the actual cash service. | [MGA reporting requirements](https://www.mga.org.mt/licensee-hub/compliance/licensees-information-reporting-requirements/reporting-requirements/), [GLI standards](https://gaminglabs.com/gli-standards/). A standard document is not a certificate. |
| Open-source obligations | 237 production lock entries; LGPL-bearing native package; 8 unknown manifests | Verify with counsel: distribution/linkage notices, source/relocation obligations where applicable and complete deployment SBOM. UNKNOWN does not mean unlicensed. | Local [license inventory](../../review/gpt-6.1-sol/production-licenses.json), installed package manifests/LICENSE evidence; no legal clearance performed. |

#### 9. Claims check

Material claims are grouped by guarantee so repeated statements across documents/comments do not create duplicate defects. TRUE means true within the stated inspected/tested scope, never a blanket assurance. Historical dated descriptions in `progress.md`/`plan.md` are judged as current claims only where current guidance relies on them. External configuration and regulatory approval remain UNVERIFIABLE.

| Claim / source | Rating | Evidence and precise limit |
|---|---|---|
| Authoritative multiplayer play chips; new tables human-only (`README.md:3`) | TRUE | Server human-tables suite; create rejects botCount; current lobby labels legacy bots. HUMAN does not prove a biological human (SOL-020). |
| AI-opponent product metadata (`layout.tsx:19`, `package.json:5`) | FALSE | New tables cannot create bots; SOL-051. |
| Configured target is local Docker (`.cursor/rules/supabase.mdc:10`) | FALSE | Explicit read-only queries reached OnlinePoker; local Docker guidance must be scoped to new disposable databases. |
| Redis optional, not authoritative game state (`README.md:3`) | TRUE | Encrypted DB load/locked mutations; Redis module is socket adapter/fan-out. Cluster ordering/capacity not independently executed. |
| Fisher–Yates swap indexes use crypto.randomFillSync rejection sampling (`rng.ts`, `deck.ts`) | TRUE | Source, exact boundary tests and million production shuffles pass; secureRandomFloat is bot-only randomBytes, not card scaling. |
| No seeded generator/player-nonce/Math.random for production cards | TRUE | Static scan and full suite; the review’s seeded selection PRNG is not production deck entropy. |
| CSPRNG source is NIST SP 800-90A DRBG (`rng.ts:4-8`, SECURITY-REVIEW) | UNVERIFIABLE | Node/OpenSSL cryptographic API is used; the deployed provider, validated mode and reseeding behavior were not assessed. This code is not proof of a certified DRBG. |
| Zero modulo bias in swap scaling | TRUE | Integer rejection boundary plus bijection/exhaustive small permutation proof; finite empirical distributions are supporting evidence only. |
| “Perfect/unbiased RNG” from passing statistics | OVERSTATED | Mathematical scaling is correct conditional on uniform source; finite samples do not prove all runtime entropy properties. |
| Continuous health test rejects zero/repeated blocks | TRUE | Source checks the immediately preceding block digest; does not detect every possible entropy defect or replace lab evaluation. |
| Consumed RNG buffers zeroed (`rng.ts`) | TRUE | Explicit word wipe and dispose in shuffle finally; no proof of erasure of all VM/OpenSSL/OS copies. A total memory-erasure interpretation is OVERSTATED. |
| RNG failure leaves start input unchanged | TRUE | Clone/failure tests and review fault probe; combined server clean-up still rolls back (SOL-010), bot scheduling can fail after commit (SOL-014). |
| Uniform starting-card odds for all seats | TRUE | Consistent deal from the uniform permutation; position affects strategy, not permutation marginals. Certification still external. |
| UUID/deck commitment/Merkle root before blind/deal | TRUE | startHand event order and audit tests; published first snapshot contains own cards, not an independently witnessed pre-deal broadcast. |
| Deck/salts/undealt cards server-only; bots restricted | TRUE | botInformationView, projection/redaction, 2,000-hand sweep; privileged server memory/key access remains a separate threat. |
| Each viewer only own or legitimately shown cards | TRUE | Snapshot guards, proofs and participant-redaction tests; no leak found in tested paths. Privileged ADMIN receives full sealed deck by design. |
| Exact nested schema guard / card-token detection | TRUE | Unknown-key/adversarial-name tests. Glued/encoded tokens are documented limitations; numeric side channels and all timing channels are not proved absent. |
| All sensitive notifications require live session authorization | FALSE | Snapshots do; account-room wallet/idle notices do not (SOL-032). |
| Hand Clean-up purges card secrets | TRUE | Engine tests/property probes; stored encrypted audit is intentionally retained. Server failure can postpone clean-up (SOL-010). |
| Participant audit reveals no mucked/undealt cards | TRUE | Redaction/opening authorization checks, stored showedCards check and full tests; no full-seed release remains. |
| Participant verifies own requested table/hand/seat and live evidence | TRUE | Shared verifier and re-sealed forgery tests. Evidence is browser/user scoped and can be absent after navigation/session loss. |
| Hole-card digest is secret | FALSE | Docs correctly acknowledge 2,652 ordered pairs are enumerable; treat as integrity evidence, not secrecy. |
| Participant proves complete deck/outcome without sealed data | FALSE | Browser verifies redacted commitments/openings/internal consistency; does not receive full salts/deck for complete recomputation. Current docs largely bound this correctly. |
| ADMIN-only sealed audit, DB role rechecked, access log | TRUE | Route authorization/rate limits/server tests; privileged MFA and log sanitization still gaps. |
| Complete hand “replay” means full betting legality | OVERSTATED | Contributions/ranks/pots/stacks verified; re-sealed CHECK paying 10 passes (SOL-026). Outcome code explicitly acknowledges the limit. |
| Audit before persistence; live settlement must equal record | TRUE | handAuditColumns plus compliance forgery tests; invalid data rolls back. |
| Per-table previous-hand link detects edits/interior deletion relative to retained history | TRUE | verifyTableChainLink; not proof of no tail deletion/rewrite. |
| Operator-held commitments/hashes make any later change/deletion detectable (`COMPLIANCE.md:106-107`) | OVERSTATED | No independent anchor/freshness authority; SOL-025. |
| Audit covers all money movement | FALSE | Only in-hand transitions; docs explicitly exclude buy-ins/cash-outs. Ledger absent SOL-002. |
| Runtime completed hand records cannot UPDATE/DELETE | TRUE | Migration plus live privilege booleans denied; administrators/owners remain higher trust. |
| Every public engine command is “pure, deterministic” (`table.ts:6`) | OVERSTATED | Input immutability holds; startHand draws OS entropy/UUID and optional arguments use Date.now. Do not replace secure RNG with seeded production randomness to satisfy wording. |
| Betting minimums, raise-to, cumulative incomplete all-ins | TRUE | Legal/actions code plus boundary/reference suites; no fresh engine rule defect found. |
| Dead button, forward BB, short blinds and heads-up | TRUE | Rule tests; publish selected cash-house behavior, not a promise to implement every 2026 TDA tournament procedure. |
| Newcomers/missed-blind returners cannot dodge BB | TRUE | Independent blind-ledger tests; wait-for-BB is deliberate house behavior. |
| Every leaving player always folds and never shows | OVERSTATED | Deferred fold and all-in/stranded-pot safeguard are deliberate exceptions disclosed in COMPLIANCE. Retain pot eligibility. |
| Odd chip “earliest position past the blinds” (`packages/shared/src/poker.ts:33`) | FALSE | Actual rule is first eligible winner clockwise left of button (`pots.ts`); update misleading comment, retain correct implementation. |
| Exact five-card category counts / independent seven-card comparison | TRUE | All 451 engine tests and standalone 2,598,960-hand enumeration passed; exhaustive applies to five cards, not all seven-card states. |
| Side pots merge equal eligibility, refund uncalled bets, preserve chips | TRUE | Independent chip-reference suite and 1,000 review sequences; cashier integration gap SOL-001 remains. |
| Buy-ins/cash-outs/history/state commit atomically | TRUE | Transaction scope and rollback substitutes; actual Postgres lock/fault verification unavailable (SOL-029). Atomicity alone does not prevent discarded obligations. |
| Every cash-out is paid once | OVERSTATED | No repeat on ordinary terminal replay, but missing recipient can pay zero and discard it (SOL-001). |
| No double seat / nonnegative bankrolls | TRUE within code/test scope | Unique userId plus conditional debit/check constraints; real cross-table contention not executed. |
| Network failure after commit cannot reverse money | TRUE | Delivery is after transaction; post-commit bot setup can prevent delivery or lie about outcome (SOL-014). |
| Action acknowledgements remove all ambiguity | OVERSTATED | No durable receipts; claim/toggle acks absent (SOL-036). |
| Temporary refresh failures preserve valid sessions (`progress.md:357`) | OVERSTATED | Browser handles 503/network errors; server maps DB timeout to destructive 401 (SOL-011). |
| Socket long-session recovery is seamless | FALSE | Genuine token rotation resets view; concurrent tab refresh 401 and server disconnect non-reconnect observed (SOL-011–013). |
| Wallet stale fetch guards keep latest value | OVERSTATED | Refresh/on-connect guards present; event order/lobby auxiliary path not protected (SOL-038). |
| Closed tables never reopen/accept chips/pay again | TRUE | Engine terminal guards, server unavailable checks and lifecycle tests; role insiders outside this promise. |
| Table closure retains history, settles live/all-in pots | TRUE | Engine/server tests and property probe; never propose unsafe blanket refund or kill all-in eligibility. |
| Host leaving does not close occupied table | TRUE | Human-table/lifecycle suites; host is not given privileged payout rights. |
| Five-minute idle plus ten-second warning | TRUE | Constants and single-worker tests; warning length/forced settlement is an owner policy. |
| Only still-seated nonleaving humans count as activity | TRUE | Per-player idleSince, engine/lifecycle tests; spectators/bots/timeouts/reconnects do not reset it. |
| Every seated lobby player receives same warning | OVERSTATED | Connected transition works; warning not replayed during auth/reload (SOL-016). |
| Every restart grants full five minutes | OVERSTATED | Holds for one fresh worker, not shared older/newer managers (SOL-015); normal turn downtime is SOL-008. |
| Warning never blocks action; closing/closed modal traps focus | TRUE for tested viewports | Existing 56 browser checks include desktop/Pixel7 and lifecycle layout; all browsers/zoom/manual AT not covered. |
| Closed dialog offers Verify hand even after missed updates | OVERSTATED | Existing snapshot case works, fresh closed-table visit has no audit control (SOL-045). |
| “Chips are back in your bankroll” closure copy | OVERSTATED | Normal transaction path does it; SOL-001 can make it false and SOL-038 can show stale wallet. Tie copy to verified settlement receipt. |
| Act in time always wins closure race (`README.md:58`) | OVERSTATED | Locked/revision-consistent ordering works; packet received before deadline but waiting behind DB work can still miss it. No global latency/clock guarantee was executed. |
| “Everything is encrypted” | FALSE | State/sealed audits/hole-card columns use AES-GCM; identity/balance/seat/session metadata are readable columns. Passwords and refresh tokens are hashes; JWTs are signed, not encrypted. Provider disk/backups unknown. |
| Live DB link verifies TLS certificates | TRUE for inspected connection | TLSv1.3/TLS_AES_256_GCM_SHA384; strict params/CA configuration. Does not establish every future deployment/backup link. |
| Production API and all engine.io refuse plaintext | TRUE subject to topology | Tests/direct TLS pass; proxy mode must isolate app port (SOL-030). Development HTTP is intentionally allowed. |
| HTTPS web frontend and complete edge header policy | UNVERIFIABLE | Deployment not inspected; app Next responses lack CSP/framing policy (SOL-039). |
| Production Redis requires TLS | TRUE | config.ts requires rediss:// when enabled; actual Redis deployment/auth not inspected. |
| Three independent strong keys validated at startup | OVERSTATED | JWT equality/placeholders checked, but zero AES/JWT reuse accepted (SOL-023); secret generation/custody unknown. |
| Migration applied before deployment / schema guard | TRUE within observed scope | Startup migration guard tested; live audit columns/2 current audited hands exist. Complete all-history migration equivalence not re-executed on disposable DB. |
| “Not certified”; cash controls absent (`README.md`, COMPLIANCE, SECURITY-REVIEW, earlier roadmaps) | TRUE | No independent approval evidence and code lacks the financial/player-protection systems. |
| Progress historical player-entropy/seed-reveal model | FALSE if treated as current | Dated historical implementation was superseded by CSPRNG/redacted audit; preserve dated record, label current guidance. |
| Earlier model opinions establish highest-standard readiness | FALSE | Opinion/roadmaps are not executed production assurance; this review supplies tests with stated limits. |

##### Encryption inventory

| Surface | What is implemented | Remaining limit |
|---|---|---|
| Live table state | AES-256-GCM, random 96-bit nonce, authenticated table context | One environment key/no key ID; valid snapshot replay and restoration controls unresolved. |
| Sealed deck/audit and hole-card storage | AES-GCM with row/hand-bound context; live card aggregates encrypted, no plaintext arrays | Keys/operator privileged paths still see plaintext; 54 legacy hands lack full new audit. |
| Passwords | bcrypt cost 12 and byte-length bounds | Hashing is appropriate, not reversible encryption; hash read scope/MFA/recovery gaps. |
| Refresh tokens | SHA-256 stored hash, rotating HttpOnly cookie, production Secure/Strict | Multi-tab/session-family/absolute TTL/origin issues. |
| Access JWT | Signed, explicit algorithm verification, in-memory browser state | Payload readable to holder; no refresh token in localStorage; rotation interrupts socket. |
| API/socket/DB/Redis transit | Production TLS guards; actual inspected DB TLS1.3; Redis rediss guard | Development HTTP; proxy network boundary/web edge and deployed Redis not verified. |
| Profile, balance, seats, session metadata, public audit | Ordinary database fields; public audit deliberately redacted | Provider disk encryption, backup encryption/access and retention not proved by application encryption. |

#### 10. Verified correct (do not “fix”)

Keep row locks, revision guards, atomic persistence, input immutability, RNG failure refusal, leak guard, audit sealing, participant redaction, TLS startup/request guards and append-only completed history. Passing tests do not justify removing any of them.

| Property | Executed/read evidence | Practical limit |
|---|---|---|
| Input immutability and engine chip conservation | 1,000 fresh review runs: 21,814 transitions, 2,212 settlements, 431 encrypted round-trips, 54,786 rejected requests | Random selections are seeded; OS deck shuffles are not. Samples do not cover every state or cashier DB behavior. |
| Viewer authorization and visible-card proofs | 18,262 review projections plus existing 182,377 swept snapshots over 2,000 hands | Timing, compromised infrastructure, logs from arbitrary future code and all side channels not proved absent. |
| Valid action bounds/actor/raise reopening | Existing 451 engine tests; malformed amount rejection and illegal actors leave input unchanged | Missing audit legality replay is separate from authoritative acceptance. |
| Evaluator and pots | 2,598,960 five-card enumeration; independent 7-card/pot-reference suites pass | Finite seven-card/side-pot simulations and build-specific evidence. |
| Terminal closure | Review engine probe and engine/server/browser lifecycle suite | Caller privileges and external storage tampering remain outside engine guards. |
| Cash debit rollback intent/unique seat | Conditional debit and global seat userId constraint; in-memory rollback tests pass | Actual real-Postgres concurrency not executed; no double-debit bug claimed. |
| Privacy and bot view | Exact allow-list, no opponent/deck in botInformationView, participant request-binding/redaction | Retain all-in shown-card rules and privileged audit disclosure controls. |
| Private-table IDOR handling | Authorized membership checks; closed private outsiders get TABLE_NOT_FOUND in lifecycle tests | Do not reveal closed private existence through new history APIs. |
| Migration/grant intent | Prisma canonical migrations and Supabase security copies reviewed; live role restrictions on completed history checked | Initial schema only in Prisma; differing migration IDs for same change are documented, not inherently drift. |
| React escaping/card/seat labels | No dangerouslySetInnerHTML/eval rendering of user input found; card/seat controls have usable names | No whole-browser penetration test, manual AT or complete WCAG audit. |
| UI ordering guards | Serialized proof verification/revision filtering; refresh and on-connect wallet guards exist | Do not remove them when fixing SOL-012/SOL-038. |
| Idle timing | Client idle warning uses performance.now; spectators/bots/timeouts do not count; locked closure uses fresh state | Normal turn timer does use Date.now; warning replay/shared restart remain defects. |
| Sound/offline policies | General API timeout and refresh exemption; retryable HTTP errors supported by browser | Sound exceptions and server 401 outage classification remain defective. |

##### Every pre-read lead disposition

| Lead | Disposition |
|---|---|
| 1 Token rotation/live sockets | CONFIRMED view reset SOL-012. Lost committed action not independently shown; durable receipt gap SOL-036. Background expiry not fully executed. |
| 2 Transient auth database failure | CONFIRMED SOL-011. |
| 3 Seat-claim ordering | No bug proved: rollback/unique constraint are correct protections. Real Postgres race remains UNVERIFIED, SOL-029; do not reorder away conditional debit protection casually. |
| 4 No-ack seat/toggles | Code CONFIRMED absence; effect and durable result gap SOL-036 (code-based confidence). |
| 5 Unloadable table | CONFIRMED SOL-009. |
| 6 Showdown cleanup/deal loop | CONFIRMED RNG coupling SOL-010. A normal fresh readyToDeal/blind-precondition mismatch was not produced; malformed/legacy states require separate evidence. |
| 7 Names and races | CONFIRMED guest unique-error response SOL-050; case/reserved-name issue code-based SOL-040. Registration concurrency was not executed on Postgres. |
| 8 Amount/shortcut/all-in/currency | CONFIRMED decimal UX SOL-049 and dollar claim SOL-048. Empty/invalid field does not bypass server bounds. Current pot-fraction formula includes call and adds current bet for raise-to; all-in label describes remaining chips, no over-debit reproduced. |
| 9 Stale AI copy | CONFIRMED source mismatch SOL-051. |
| 10 Legal pages | Missing in reviewed route tree, SOL-007; legal scope needs counsel. |
| 11 Process errors/shutdown | No explicit drain/in-flight tracking; bot arm failure CONFIRMED SOL-014. No uncaught handler alone is not evidence of lost money. SIGTERM/kill during real transactions UNVERIFIED; require SOL-027/SOL-029 drill. |
| 12 Fixed buy-in | Code CONFIRMED fixed derived amount/no selector SOL-044. Min/max engine/lobby 20–200 BB align. |
| 13 Idle policy | Single-worker implementation matches 5min+10s; duration/forced settlement are owner decisions, not themselves rule bugs. Shared restart/missed replay defects SOL-015/SOL-016; absent-player exposure SOL-019. |

##### Named rules comparison and house variants

Compared the betting/position/settlement mechanisms with [Poker TDA 2026 rules v1.0, 7 September 2026](https://www.pokertda.com/view-poker-tda-rules/) (checked 2026-09-30): cumulative short all-ins reopening, heads-up order, dead button and odd chips left of button. TDA governs tournaments; this repository is cash-style no-limit play. This comparison does **not** assert complete 2026 TDA compliance, including newer seating-maximization/tournament procedures.

Owner-approved house decisions: wait-for-big-blind rather than optional posted entry, dead button/short-blind handling, automatic show of live showdown hands versus muck choices, retaining all-in and sole pot eligibility during leave/closure, no free fold when check is available, fixed time bank, no rake, and forced idle settlement. Publish these with disconnection/restart policy. A 15-second realtime turn is not automatically a WCAG timing violation; WCAG has realtime exceptions, while accessible status still matters. [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

#### 11. Fix plan for Claude

Make small reviewable batches and convert the BAD-behavior probes into acceptance tests that fail before and pass after fixes. Keep the engine independent of database/network I/O; time/policy inputs belong in explicit transitions. Secure RNG/UUID generation stays cryptographic. Server changes use locked, revision-checked transactions; shared contracts serve both server and browser. No live migration is authorized by this review.

| Batch / dependency | Work | Required tests and gate | Migration / decision |
|---|---|---|---|
| 0 Evidence and isolated CI | Preserve this tree and findings; provision disposable Postgres/Redis, deterministic fault injection and two workers (SOL-029). | Existing typecheck/tests/build/browser plus real role/constraint/lock negative controls. Default tests cannot load live URLs. | CI/SRE; no live writes. |
| 1 Current money correctness | SOL-001 affected-row cash-out assertion; SOL-010 split completed cleanup/new deal; SOL-014 isolate post-commit timer failure. | node:test payout/rollback/failure injection; real concurrent payouts and kills; engine chip conservation; Playwright cash-out receipt. | No ledger migration for immediate guard; durable receipt/ledger follows. |
| 2 Session reliability/privacy | SOL-011 typed errors; SOL-013 cross-tab coordination; SOL-032 authorized notifications; SOL-022 safe parser/logging; SOL-033/034 Origin/media/cache controls. | HTTP/socket outage/revocation/races, malformed secrets in spy logs, two-tab Playwright. | Policy-dependent replay/lifetime SOL-031 later; keep CAS and Strict cookies. |
| 3 Turn and idle continuity | SOL-012 preserve verified view; SOL-016 replay current warning; SOL-017 optional audio; SOL-018 clock; SOL-008/015 durable recovery policy; SOL-019 absence policy. | Jest fake-time/policy transitions; node:test two workers and stale callbacks; Playwright rotate/expire/reconnect/background/clock skew. | Shared restart/deadline migration likely; owner approves house policy first. |
| 4 Reliable command/wallet contract | SOL-036 durable command receipts/acks; SOL-038 wallet revisions. | Real concurrent requests/reordered replies; lost-ack retry; newer wallet wins every API/event path. | Receipt and wallet-revision migration/backfill; retention policy. |
| 5 Usable and truthful demo | SOL-041–045,048–052; correct the shared comment while preserving odd-chip behavior. Terms/privacy/house-rule UI SOL-007. | Playwright decimal/amount confirmation, closed history, reduced motion/contrast; manual keyboard/NVDA, zoom and phone landscape. | Owner chooses units/buy-in; counsel approves documents. History read API privacy tests. |
| 6 Defense and deploy | SOL-021/023/024/030/035/037/039/040/046/047: IAM/MFA, managed separated keys, least privilege, readiness, CSP, origin topology, distributed limits and safe config. | Config/TLS/privilege tests; actual same-site production browser; staging ingress/header/load/drain and restore drills. | Key-format/grant/canonical-name migrations; provider/topology decisions. |
| 7 Audit assurance | SOL-025 independent checkpoints; SOL-026 complete versioned legal replay. | Jest re-sealed forgeries + valid corpus; server stored/live agreement; browser redacted audit; deletion/replay with witness. | Audit/version/witness migration; keep old versions/readability and concealed cards. |
| 8 Cash capability behind a disabled flag | SOL-002–006/020: ledger/assets/payments/custody/eligibility/RG/game-integrity. | Provider sandbox, balanced postings and reorg/chargeback/withdrawal faults; exclusion/limit races; independent reconciliation. | Large reviewed migrations; owner/counsel/MLRO/provider choices. Demo asset cannot convert. |
| 9 Operational and external release gate | SOL-027/028 and legal register; documented release build/config, restore/key drill, penetration/rules/RNG testing and required approvals. | Execute incident/recovery/load tests; all S0/S1 resolved; lab/counsel/operator sign-off within their actual scope. | External approvals, reporting/retention and asset/custody scope. |

After each code batch run targeted meaningful regressions, then `npm.cmd run typecheck`, affected Jest/node:test suites, and appropriate Playwright tests against isolated fixtures. Full exhaustive/RNG suites are a release gate after engine/audit changes, not a reason to skip real financial races. Every schema/key/grant change needs disposable migration rehearsal, rollback/read-compatibility and reconciled backfill before a separately approved production deployment.

#### 12. Coverage ledger

Inventory: 162 source/test/config/migration/doc/artifact files, including tracked and untracked work. PARTIAL 24; FULL 136; NOT REVIEWED 2. Every production application source file (71) is FULL. FULL means the file content/implementation was read for this scope; not independent formal verification. PARTIAL records explicit limits; no blank entry means “implicitly covered”.

Excluded from application inventory: node_modules, build/dist/.next output, .git, .agents/.codex/.aws, npm caches, .env secret files, log files, test results and review-generated artifacts. Existing tsbuildinfo/platform metadata are also generated output. .cursor connector structure is partial to avoid secrets. The complete review artifact list is in section 14; concurrently generated review/claude artifacts are preserved, not audited application source.

| File | Coverage | Findings / result | Scope note |
|---|---|---|---|
| `.audit.json` | PARTIAL | — (no distinct finding; see note) | Generated prior advisory result; inspected metadata only, replaced by newly executed audit evidence. |
| `.cursor/mcp.json` | PARTIAL | — (no distinct finding; see note) | Only configuration structure inspected (one server); secret-bearing values deliberately not printed/copied. |
| `.cursor/rules/supabase.mdc` | FULL | SOL-051 | Read current source/config/document; see section 9 for grouped claim checks. |
| `.env.example` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `.gitignore` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `BACKEND-SECURITY-AUDIT.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `CLAUDE-REVIEW.md` | PARTIAL | — (no distinct finding; see note) | Independent concurrent report added after baseline; inspected index/some claims, not relied upon as executed evidence for this report. |
| `CLAUDE_HANDOFF.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `COMPLIANCE.md` | FULL | SOL-025, SOL-028, SOL-002, SOL-023, SOL-026 | Read current source/config/document; see section 9 for grouped claim checks. |
| `GPT-6.1-SOL-REVIEW-PROMPT.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `README.md` | FULL | SOL-002, SOL-023, SOL-025, SOL-026, SOL-028 | Read current source/config/document; see section 9 for grouped claim checks. |
| `SECURITY-REVIEW.md` | FULL | SOL-002, SOL-023, SOL-025, SOL-026, SOL-028 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/certs/supabase-pooler-root.pem` | PARTIAL | — (no distinct finding; see note) | Public CA/config use inspected; actual DB TLS was verified, not an independent CA provenance/certificate-chain audit. |
| `apps/server/package.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma.config.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/migrations/20240919190000_init/migration.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/migrations/20260920140611_poker_security/migration.sql` | FULL | SOL-024 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/migrations/20260920141323_restrict_rls_event_trigger/migration.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/migrations/20260920165155_poker_history_integrity/migration.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/migrations/20260924120000_compliance_audit_trail/migration.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/migrations/migration_lock.toml` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/schema.prisma` | FULL | SOL-002, SOL-024, SOL-027, SOL-040, SOL-004, SOL-005, SOL-006, SOL-036, SOL-038 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/prisma/seed.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/app.ts` | FULL | SOL-004, SOL-022, SOL-033, SOL-035, SOL-039 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/auth/jwt.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/auth/middleware.ts` | FULL | SOL-011 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/auth/routes.ts` | FULL | SOL-003, SOL-005, SOL-011, SOL-013, SOL-020, SOL-021, SOL-031, SOL-033, SOL-034, SOL-040, SOL-046, SOL-050 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/config.ts` | FULL | SOL-023, SOL-030, SOL-046, SOL-047 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/db/prisma.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/game/audit.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/game/encryption.ts` | FULL | SOL-023, SOL-025 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/game/legacy.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/game/manager.ts` | FULL | SOL-001, SOL-006, SOL-008, SOL-009, SOL-010, SOL-014, SOL-015, SOL-016, SOL-019, SOL-025, SOL-032, SOL-035, SOL-038, SOL-047, SOL-005, SOL-018, SOL-029, SOL-036 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/index.ts` | FULL | SOL-027 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/logger.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/redis/client.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/redis/table-state.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/routes/admin-access-log.ts` | FULL | SOL-022 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/routes/admin.ts` | FULL | SOL-021 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/routes/health.ts` | FULL | SOL-037 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/routes/tables.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/socket/index.ts` | FULL | SOL-011, SOL-016, SOL-036, SOL-013, SOL-032 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/socket/mask.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/socket/rate-limit.ts` | FULL | SOL-035 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/socket/rooms.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/socket/types.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/src/transport.ts` | FULL | SOL-030 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/server/test/compliance.test.mjs` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `apps/server/test/game-flow.test.mjs` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `apps/server/test/human-tables.test.mjs` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `apps/server/test/integration.test.mjs` | FULL | SOL-029 | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `apps/server/test/security.test.mjs` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `apps/server/test/table-lifecycle.test.mjs` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `apps/server/tsconfig.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/next-env.d.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/next.config.ts` | FULL | SOL-039 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/package.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/playwright.config.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/postcss.config.mjs` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/app/globals.css` | FULL | SOL-041 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/app/layout.tsx` | FULL | SOL-007, SOL-051 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/app/login/page.tsx` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/app/page.tsx` | FULL | SOL-038, SOL-048 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/app/table/[id]/page.tsx` | FULL | SOL-044 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/auth-hydrator.tsx` | FULL | SOL-013, SOL-011, SOL-012, SOL-016, SOL-031, SOL-038 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table-idle-notice.tsx` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/action-bar.tsx` | FULL | SOL-017, SOL-042, SOL-043, SOL-048, SOL-049 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/fairness-audit.tsx` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/game-log.tsx` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/idle-close-dialog.tsx` | FULL | SOL-045 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/playing-card.tsx` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/poker-felt.tsx` | FULL | SOL-043 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/seat-hud.tsx` | FULL | SOL-018, SOL-041, SOL-043, SOL-044 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/components/table/table-controls.tsx` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/hooks/use-table-fx.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/hooks/use-table-socket.ts` | FULL | SOL-012, SOL-045, SOL-036 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/lib/api.ts` | FULL | SOL-013, SOL-046 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/lib/socket.ts` | FULL | SOL-012 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/lib/sounds.ts` | FULL | SOL-017 | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/src/stores/session.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `apps/web/test/browser/game-flow.spec.ts` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `apps/web/test/browser/table-lifecycle.spec.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `apps/web/test/support/game-server.mjs` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `apps/web/test/support/restore-next-env.ts` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `apps/web/tsconfig.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `chatgpt-6-codex.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `chatgpt-6-sol.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `docker-compose.yml` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `package-lock.json` | PARTIAL | — (no distinct finding; see note) | Parsed complete lock inventory, production audit/license scan and workspace/version/dependency structure; not every dependency implementation reviewed. |
| `package.json` | FULL | SOL-051 | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/jest.config.cjs` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/package.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/__tests__/audit.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/bots.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/deck.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/evaluate-exhaustive.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/evaluate.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/helpers/drive.ts` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `packages/engine/src/__tests__/helpers/forge.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/helpers/simulate.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/helpers/stats.ts` | FULL | — (no distinct finding; see note) | Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed. |
| `packages/engine/src/__tests__/leakage.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/leave-flow.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/pots-reference.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/pots.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/review-fixes.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/rng.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/security.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/table-lifecycle.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/__tests__/table.test.ts` | PARTIAL | — (no distinct finding; see note) | Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently. |
| `packages/engine/src/audit.ts` | FULL | SOL-026 | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/bots/chen.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/bots/decide.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/bots/delay.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/bots/montecarlo.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/bots/texture.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/cards.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/deck.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/evaluate.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/fairness.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/index.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/isolation.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/legal.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/pots.ts` | FULL | SOL-052 | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/public.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/rng.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/seats.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/table.ts` | FULL | SOL-019 | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/src/types.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/engine/tsconfig.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/package.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/src/api.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/src/audit.ts` | FULL | SOL-026, SOL-025 | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/src/constants.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/src/events.ts` | FULL | SOL-018, SOL-036, SOL-038, SOL-016 | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/src/fairness.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/src/index.ts` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `packages/shared/src/poker.ts` | FULL | SOL-052 | Production types FULL; odd-chip comment is false (actual left of button), see section 9; correct algorithm must remain. |
| `packages/shared/tsconfig.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `plan.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `progress.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `scripts/review-database.mjs` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `scripts/security-review.mjs` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `scripts/verify-evaluator.mjs` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `skills-lock.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `supabase/.temp/cli-latest` | NOT REVIEWED | — (no distinct finding; see note) | Generated CLI-version cache; no application behavior. |
| `supabase/ACCESS.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `supabase/README.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `supabase/authenticated-account/PROJECT.md` | FULL | — (no distinct finding; see note) | Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security. |
| `supabase/authenticated-account/advisors.md` | FULL | — (no distinct finding; see note) | Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security. |
| `supabase/authenticated-account/database.types.ts` | NOT REVIEWED | — (no distinct finding; see note) | Generated types for the documented other/historical account; not a runtime dependency of the poker application. |
| `supabase/authenticated-account/extensions.md` | FULL | — (no distinct finding; see note) | Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security. |
| `supabase/authenticated-account/functions.md` | FULL | — (no distinct finding; see note) | Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security. |
| `supabase/authenticated-account/migrations.md` | FULL | — (no distinct finding; see note) | Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security. |
| `supabase/authenticated-account/rls.md` | FULL | — (no distinct finding; see note) | Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security. |
| `supabase/authenticated-account/schema.md` | FULL | — (no distinct finding; see note) | Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security. |
| `supabase/mcp.md` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `supabase/migrations/20260920140611_poker_security.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `supabase/migrations/20260920141323_restrict_rls_event_trigger.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `supabase/migrations/20260920165155_poker_history_integrity.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `supabase/migrations/20260927224842_compliance_audit_trail.sql` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |
| `tsconfig.base.json` | FULL | — (no distinct finding; see note) | Read current source/config/document; see section 9 for grouped claim checks. |


#### 13. Open questions and residual risk

- Which exact countries, currencies and crypto assets, operator entity, licence stage, custody/provider, rake and cash limits are intended? Malta is an operating/licensing plan, not an answer for every player market.
- No disposable Postgres/Redis was available, so actual lock waits/deadlocks, cross-table races, worker kill during settlement, key-restored backup and mixed-version rolling deploy were not executed. In-memory transaction substitutes validate control flow, not database isolation.
- No production/public host was probed. Firewall/ingress, deployed frontend headers/TLS, Redis authentication/TLS, provider disk/backups, secret manager/KMS, build provenance, DDoS defenses, regional latency and infrastructure access controls remain unknown.
- Browser evidence is Chrome desktop plus the existing Pixel7 project, using a fixture rather than a real server/Postgres browser stack. Safari/Firefox, actual devices, screen-reader users, 200–400% zoom/reflow, landscape and prolonged background throttling remain incomplete.
- No complete timing/traffic side-channel proof, insider memory assessment, compromised runtime test or full external penetration test. No hidden-card leak was found in the executed projection/audit corpus; this is not proof that none is possible.
- Dependency audit covered production advisory data at the observed time only. SBOM/license scan has eight unresolved entries; native runtime code, dependency supply-chain compromise and dev/build tooling were not fully audited.
- Secret scan is heuristic and covers the available checkout/history blobs. Ignored local files were deliberately not dumped; unfetched branches, reflogs, external CI/logs/backups and credentials previously exposed elsewhere remain unknown.
- Live database aggregates describe one moment. Six tables and only two new fully audited hands are a small sample. Legacy audit absence is documented; zero present negative balances/stuck rows does not prove cashier invariants under faults.
- Clock jumps/NTP failure across real hosts, pool saturation, bot event-loop CPU, connection floods and shutdown/drain behavior need measured fault/load evidence. An unhandled exception may terminate Node, but no cash-loss claim was inferred from handler absence alone.
- The coverage ledger honestly marks partial test/helper/document/artifact review. Production application source was read; test execution does not mean every test line was independently reviewed. The 1,000-run selection seed does not reproduce OS deck permutations exactly.
- Requirements for self-exclusion, recovery, private audit retention and data rights need an approved policy balancing funds preservation, privacy and mandatory recordkeeping.
- This report cannot prove the absence of defects, certification, legal compliance or production suitability. Reassess the implemented fixes and the exact released infrastructure with independent specialists before real-money operation.

#### 14. Appendix

##### Safe reproduction

Run from the repository root with existing dependencies. Review fixtures use only localhost and synthetic credentials. Builds must precede probes that import `dist`. **Never substitute the root live URL into test commands.** The helper overrides `DATABASE_URL`, `DIRECT_URL`, `DATABASE_TEST_ADMIN_URL`, Redis and keys before child import. No npm scripts or existing tests were altered.

```powershell
node review/gpt-6.1-sol/run.mjs typecheck npm.cmd run typecheck
node review/gpt-6.1-sol/run.mjs tests npm.cmd test
node review/gpt-6.1-sol/run.mjs build npm.cmd run build
node review/gpt-6.1-sol/run.mjs evaluator node scripts/verify-evaluator.mjs
node review/gpt-6.1-sol/run.mjs known-wrapper node review/gpt-6.1-sol/repro/known-backend.mjs
node review/gpt-6.1-sol/run.mjs server-faults-corrected node review/gpt-6.1-sol/repro/server-faults.mjs
node review/gpt-6.1-sol/run.mjs absence-config node review/gpt-6.1-sol/repro/absence-and-config.mjs
node review/gpt-6.1-sol/run.mjs engine-properties-corrected node review/gpt-6.1-sol/repro/engine-properties.mjs
```

Outside the restricted Windows sandbox (approval is necessary there), with ports **3107 and 4107 free**:

```powershell
node review/gpt-6.1-sol/run.mjs browser npm.cmd run test:browser -w @poker/web
node review/gpt-6.1-sol/run.mjs browser-defects-corrected node node_modules/@playwright/test/cli.js test -c review/gpt-6.1-sol/repro/playwright.config.ts
```

The BAD-behavior tests intentionally pass when defects exist. After remediation, invert the relevant assertions and move approved acceptance tests into normal Jest/node:test/Playwright suites. The reduced-motion test is diagnostic; its logged computed animation establishes the observation, not a complete automated accessibility gate. The review Playwright config uses its own server-fixture copy; it does not modify the existing game-server fixture or owner ports 3000/4000.

For direct-TLS verification, `run.mjs` adds the installed `C:\Program Files\Git\usr\bin` to the child PATH when label is `direct-tls`:

```powershell
node review/gpt-6.1-sol/run.mjs direct-tls node --test '--test-name-pattern=production with direct TLS' apps/server/test/compliance.test.mjs
```

Explicit read-only live checks are separate from this helper. `scripts/review-database.mjs` and `repro/live-aggregates.mjs` were inspected to start READ ONLY and roll back. They may load the live root `.env` and require the approved network context. They print only sanitized aggregate/privilege information. Do not repurpose them for mutations.

```powershell
node scripts/review-database.mjs
node review/gpt-6.1-sol/repro/live-aggregates.mjs
```

##### Artifacts

| File | Purpose |
|---|---|
| `repro/engine-properties.mjs` | Immutable random legal/illegal sequences, conservation, proof/audit checks, encryption restart/AAD and terminal closure. |
| `repro/server-faults.mjs` | Unloadable state, cleanup RNG, post-commit bot failure, manager grace conflict, wallet order, DB-auth failure, tab refresh race, unique guest and missed warning. |
| `repro/absence-and-config.mjs` | Repeated absent-player timeouts and invalid config acceptance. |
| `repro/known-backend.mjs` | Safe wrapper for existing known-bad probes (F08–F21). |
| `repro/browser-defects.spec.ts`, `repro/playwright.config.ts`, `repro/browser-fixture.mjs` | Isolated Chrome probes and delayed/faulted fixture behaviors. |
| `repro/live-aggregates.mjs` | Explicitly READ ONLY live aggregates/privilege booleans. |
| `logs/*.txt`, `verification.ndjson` | Captured command output, duration, status and child environment isolation marker. Logs contain synthetic markers only, not live secret values. |
| `baseline-tree.json`, `final-tree.json` | Hash fingerprints, git tree identity and initial/final status; ignored .env contents omitted. |
| `coverage.json`, `reads.ndjson` | Final coverage ledger and read history; an entry in read history alone does not imply FULL if output was truncated. |
| `production-licenses.json`, `licenses.mjs`, `secret-scan.mjs` | Local dependency inventory and secret-scan method. |
| `findings.mjs`, `sections.md`, `report.mjs`, `validate-report.mjs` | Review data, rendering and structural/path/count verification only. |

##### Invariant outcomes

| Requested invariant | Outcome |
|---|---|
| 1 Total funds change only on issuance | Engine conservation passed; cashier zero-recipient defect SOL-001 violates integration invariant. Demo issuance lacks cash boundary. |
| 2 Cash-out and recorded settlement exactly once | Normal replay/terminal tests pass; zero payment and cleanup blockage fail; actual DB crash race not run. |
| 3 No unauthorized hidden/undealt cards | Passed tested projection/redaction/bot corpus; privileged insider and timing boundaries remain unknown. |
| 4 Only legal current actor/stale-state refusal | Engine/socket tests pass; durable reply reconciliation and audit full-legality replay missing. |
| 5 No unfair turn/chip loss from downtime/refresh | Fails documented recovery/rotation/clock paths unless an approved policy resolves them. |
| 6 One seat, nonnegative and bounded storage | Constraints/conditional debit and tests support it; actual concurrency unverified, config accepts storage overflow. |
| 7 Closed never reopens/deals/pays again | Passed lifecycle/property tests; keep terminal guards. |
| 8 Revocation stops all private channels | Fails wallet/account-room notification probe SOL-032. |
| 9 UI agrees with server | Fails wallet ordering, wall-clock/reduced-motion and join/recovery observations. |

##### End-of-review Git status and preservation

The brief’s “no modified tracked files” instruction cannot literally describe a tree that began with 23 modified tracked files. The enforceable preservation check is **no additional tracked modification**: all 199 pre-existing file fingerprints are unchanged and the exact diff hash still equals `f4fc753872628c3fe5cb501f21f93096526f7b4c8df8b140f86ab6c2e5e05315`. No existing source/test/doc/config was edited by this review. The two review helpers present when the baseline was captured were excluded from owner-file comparison.

The following status was captured at report generation (the new report line is included). The modified paths were present initially, and CLAUDE-REVIEW.md/review/claude are independent concurrent additions.

```text
 M CLAUDE_HANDOFF.md
 M README.md
 M apps/server/package.json
 M apps/server/src/game/legacy.ts
 M apps/server/src/game/manager.ts
 M apps/server/src/routes/tables.ts
 M apps/server/src/socket/index.ts
 M apps/web/src/app/globals.css
 M apps/web/src/app/layout.tsx
 M apps/web/src/app/page.tsx
 M apps/web/src/app/table/[id]/page.tsx
 M apps/web/src/components/auth-hydrator.tsx
 M apps/web/src/components/table/fairness-audit.tsx
 M apps/web/src/components/table/table-controls.tsx
 M apps/web/src/hooks/use-table-socket.ts
 M apps/web/src/stores/session.ts
 M apps/web/test/support/game-server.mjs
 M packages/engine/src/public.ts
 M packages/engine/src/table.ts
 M packages/engine/src/types.ts
 M packages/shared/src/constants.ts
 M packages/shared/src/events.ts
 M progress.md
?? BACKEND-SECURITY-AUDIT.md
?? CLAUDE-REVIEW.md
?? GPT-6.1-SOL-REVIEW-PROMPT.md
?? GPT-6.1-SOL-REVIEW.md
?? apps/server/test/table-lifecycle.test.mjs
?? apps/web/src/components/table-idle-notice.tsx
?? apps/web/src/components/table/idle-close-dialog.tsx
?? apps/web/test/browser/table-lifecycle.spec.ts
?? chatgpt-6-codex.md
?? packages/engine/src/__tests__/table-lifecycle.test.ts
?? review/
?? scripts/review-database.mjs
?? scripts/security-review.mjs
```

No live SQL mutation, migration, seeded production fixture, dependency installation, Git mutation or owner-process termination was performed. No commit or deployment is part of this deliverable.

## Appendix J: The 29 September backend security audit (`BACKEND-SECURITY-AUDIT.md`, word for word)

Written before this session. It is the source of F01–F22, whose current status is in 3.4. Headings are moved down two levels to fit this file.

### Backend security and real-money readiness review

Review date: 29 September 2026. Target: Malta, real-money and crypto poker. Custody model and player countries remain undecided.

#### Decision

**NO-GO for accepting deposits, holding customer crypto, or making game chips redeemable.** The project is a well-tested play-chip poker implementation with meaningful cryptographic protections. It does not yet implement the financial, player-protection, identity, fraud, or operational controls needed for the requested business. Several concrete security and reliability defects also remain.

This is an engineering review of the current working tree and read-only checks of the linked OnlinePoker database. It is not an MGA system audit, a penetration-test certificate, a laboratory RNG certification, or a legal determination of the proposed business. Passing the existing tests does not establish readiness for real money.

Severity below is assessed against the requested real-money use. An absent payment subsystem is a launch blocker, not evidence that an existing payment system was exploited. Conditional findings state the conditions explicitly. No production balances, accounts, game records, roles, or schema were changed. Application source was left unchanged; the additions are this report and two verification scripts. Pre-existing workspace edits were preserved.

The review records **22 findings and readiness gaps: 5 Critical, 11 High, 6 Medium**. These counts include missing capabilities and unverified operational controls, as well as reproduced defects; they are not a count of independently exploitable vulnerabilities.

#### Verification performed

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

#### Encryption: what is and is not protected

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

#### Findings and required remediation

##### F01 — Critical: free play chips must never become redeemable balances

Evidence: `apps/server/src/auth/routes.ts:76` and `:130`; `apps/server/src/config.ts:25`; `apps/server/prisma/schema.prisma:73`.

Registration and unauthenticated guest creation each credit `DEFAULT_STARTING_BANKROLL` into the same balance used for table buy-ins and cash-outs. The default is 10,000. The environment schema requires a positive starting bankroll, so setting it to zero does not even disable issuance cleanly. The probe received HTTP 201 and 10,000 chips from `/api/auth/guest`.

This is intentional play-chip behavior today. Connecting redemption to that balance would allow new accounts to create redeemable value, including value transferred through play. Rate limiting does not make issuance financially safe.

Required: independently separate demo, promotional and cash balances; use a zero cash opening balance; credit cash only through a verified, uniquely identified ledger event. Guest/demo identities must not access cash games. Reconcile and explicitly classify every pre-launch balance and test account before enabling money. Never convert this database's existing play balances to cash automatically.

##### F02 — Critical: no financial ledger, asset model or reconciliation

Evidence: `schema.prisma:64`, `:125`, `:142`; `game/manager.ts:165`, `:221`; `routes/tables.ts:181`.

Money is represented by mutable `User.bankroll` and seat stacks. Transactions help avoid partial updates, but there is no immutable double-entry ledger, account hierarchy, currency/chain/asset identity, reserved balance, source transaction, reconciliation process or independently auditable wallet history. Buy-ins and cash-outs are outside the hand hash chain. Postgres `Int` is a signed 32-bit value; it is not a general representation of crypto atomic units. Currency units and conversion/rounding rules are undefined.

Required: model each supported asset explicitly and choose bounded exact integer/decimal units; never use floating-point money or cross a JavaScript safe-integer boundary. Establish immutable balanced journals, unique operation IDs, table escrow, available/reserved accounts, reversals, fee accounts and reconciliation against both player liabilities and external assets. Decide whether games settle in EUR or crypto units. Integrate escrow movements and hand settlement atomically, or through a rigorously idempotent protocol with durable recovery.

Acceptance: concurrent buys/withdrawals cannot overspend; every debit has an equal credit for the same asset; retries cannot post twice; crash/restart and external duplicate callbacks converge to one result. Reconstruct every balance from the ledger and explain every reconciliation difference.

##### F03 — Critical: fiat/crypto deposit, withdrawal and custody controls are absent

Evidence: complete server route inventory in `app.ts`, schema and server dependencies. No deposit, withdrawal, provider webhook, blockchain observer, wallet or custody implementation exists.

Required before launch: select the legal entity, provider/custody contract, supported assets/chains and settlement currency. Implement authenticated provider callbacks, replay protection, unique provider-event identities, out-of-order processing and a durable inbox/outbox. Define confirmation/finality and chain-reorganisation policies, address attribution, unsupported token/chain handling, fees, conversion quotes and reconciliation. A deposit seen in a mempool must not automatically become withdrawable value.

Withdrawals require reservation before dispatch, transaction-specific authorization, AML/risk holds, address verification, limits, approval rules, idempotent dispatch and recovery from an uncertain provider response. A timeout must not cause a second payout. Card chargebacks, refunds and rejected transfers need explicit states and ledger entries. Use hosted payment collection if taking cards; do not add card-number storage to this backend.

For self-custody, isolate signing from gameplay, use an appropriate HSM/MPC/multisignature design, hot-wallet exposure limits, dual control, recovery ceremonies and independently tested incident procedures. No crypto signing secret should share this game's `.env` or server process.

##### F04 — Critical: identity, eligibility and AML gates are missing

Evidence: `schema.prisma:64`; `auth/routes.ts`; `auth/middleware.ts:6`; `routes/tables.ts`; `socket/index.ts`.

A session and `kind === HUMAN` establish gameplay access. There is no verified identity, age, residence/market eligibility, email-verification state, sanctions/PEP screening, source-of-funds workflow, restricted-account state or compliance case record. Guests can play. There is no authoritative account suspension/exclusion gate at seat claim or hand start.

Required: a backend-enforced eligibility state machine integrated with identity and screening providers, reviewer decisions, revocation, restricted-market rules, AML monitoring and auditable case handling. Gate deposits, cash games and withdrawals according to the approved policy. Restrictions must affect existing sockets and concurrent transactions, while preserving lawful access to funds. An MGA licence must not be assumed to authorize every country where a player may connect. Malta is confirmed as the intended base/market; the complete target-market list is unresolved.

MGA describes risk-based AML/CFT controls for B2C Type 1, 2 and 3 licensees. Exact obligations and timing need the licensed operator's compliance policy. [MGA AML guidance](https://www.mga.org.mt/licensee-hub/compliance/anti-money-laundering/)

##### F05 — Critical: responsible-gaming enforcement is absent

Evidence: no self-exclusion, deposit/wagering-limit, reality-check or responsible-gaming models/routes in the backend; `auth/middleware.ts`, table creation and seat/action paths do not check them.

Required: persist self-exclusion and applicable brand/identity scope; prevent circumvention by a replacement account; enforce the approved limits atomically across sessions and workers; support cooling-off rules, history, notices and monitoring. Recheck eligibility at the points where new exposure is taken. A five-minute idle table closure is not a responsible-gaming limit. Excluded players still need an appropriate route to withdraw their funds.

MGA guidance calls for self-exclusion, deposit or wagering limits and reality checks. Its 2026 thematic review also identifies implementation failures such as delayed exclusions and duplicate-identity gaps. [Required tools](https://www.mga.org.mt/faqs/remote-gaming-are-there-any-mandatory-responsible-gambling-tools-which-must-be-offered-to-players/), [player protection](https://www.mga.org.mt/licensee-hub/compliance/player-protection/), [2026 thematic review](https://www.mga.org.mt/the-mga-publishes-findings-from-thematic-review-on-self-exclusion-practices-in-the-online-gaming-sector/)

##### F06 — High: no anti-collusion, multi-account or automation operations

Evidence: the server authenticates accounts individually; no device/account relationship, collusion, chip-dumping, real-time assistance or investigation subsystem was found. New tables reject built-in bots, but legacy bots still run through `game/manager.ts:336`.

Correct shuffling cannot prevent coordinated players from sharing cards externally, chip dumping, controlled opposing accounts or automated play. The one-seat-per-user constraint does not identify one-person-with-many-users behavior.

Required: identity/device/payment linkage appropriate to privacy law, table-sharing and transfer-pattern analysis, behavioral alerts, review tooling, investigation evidence and an appeal process. Separate all legacy/demo bots and test accounts from the licensed cash environment; require explicit rules for any automated participant. Avoid presenting probabilistic fraud signals as proof on their own.

##### F07 — High: player and administrator authentication is below the target assurance

Evidence: `auth/routes.ts:108`; `routes/admin.ts:37`; `schema.prisma:64`.

ADMIN access is the ordinary password/session flow plus a database role check. There is no MFA/passkey requirement, recent reauthentication, dedicated privileged identity, password-change/recovery workflow, session inventory or remote sign-out control. Failed login checks are IP-limited only; missing accounts skip bcrypt comparison, exposing a timing difference. Registration explicitly reports an existing username/email.

Required: phishing-resistant administrator authentication, separate privileged access and least privilege, step-up for sensitive player operations, safe recovery, compromised-password checks and account/device/IP risk controls. Add uniform credential-check behavior and auditable success/failure/revocation events. Test support recovery as an account-takeover surface. bcrypt cost 12 is not itself the defect. [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

##### F08 — High, reproduced: malformed requests leak passwords to logs and bypass rate limits

Evidence: `app.ts:39`, `:56`; `logger.ts:4`; `scripts/security-review.mjs` observation `malformedJson`.

`express.json` runs before both rate limiters. Its parse error includes the original request body. The catch-all error logger serializes the error with Pino's default error serializer and no redaction. A malformed login containing a synthetic password produced a log representation containing that password. Sixteen malformed auth requests all returned 500, bypassing the 15/minute auth limiter entirely. Parser limits still bound a single body, but do not stop repeated error/log work.

Required: apply appropriate limits before body parsing; handle parser and oversized-body errors as 400/413; log an allow-list of error metadata. Removing only `err.body` is insufficient if a parser's message or stack embeds input. Redact credentials/cookies/authorization and other sensitive fields across all logging paths. Admin access logs also currently preserve query strings through `originalUrl`; log the path without query parameters. Test with synthetic secrets, never actual credentials. [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

##### F09 — High, reproduced with an inconsistent recipient: cash-out can silently discard chips

Evidence: `game/manager.ts:165`; observation `missingCashoutRecipient`.

The cash-out loop calls `updateMany` with `kind: HUMAN` but ignores its affected-row count. It then empties `cashOuts` and persists the released seat. A fixture returning `{count: 0}` committed with the seat released and no remaining payment instruction. An absent/mismatched identity or administrative kind change can therefore discard a human payout without failing the transaction. Ordinary valid-user cash-outs do pass existing tests; this reproduction is a fault case, not an unauthenticated exploitation claim.

Required: verify the expected recipient and exactly one matching wallet mutation/ledger posting; otherwise roll back and preserve a recoverable obligation. Explicitly distinguish demo bot balances from human money instead of silently skipping unmatched rows. Acceptance must include removed/restricted/reclassified recipients, DB failures, retries and restore recovery.

##### F10 — High, reproduced: server downtime can immediately forfeit a player's turn

Evidence: `index.ts:48`; `game/manager.ts:109`, `:335`; observation `outageRecovery`.

Recovery resets the inactivity baseline but preserves the old betting deadline. If that deadline expired during an outage, the timer is scheduled immediately. Recovery runs before the HTTP listener starts. A three-player fixture started 60 seconds earlier produced `TIMEOUT_FOLD` about 4 ms after recovery, without any reconnection opportunity.

Required: define and audit the interrupted-game policy; pause or fairly rebase affected deadlines, provide an appropriate reconnect window and distinguish system outage from player inactivity. Coordinate this across workers so a rolling restart cannot arbitrarily reset or expire turns. Test partial outages, long startup, DB stalls, clock jumps, repeated restarts and mixed connected/disconnected players. Do not allow a restart to act as an operator-selectable advantage.

##### F11 — High: key lifecycle and separation are incomplete

Evidence: `game/encryption.ts:5`; `config.ts:19`; observation `productionSecretValidation`; local sanitized configuration check.

One environment key encrypts live states, historical hole cards and all sealed audits. The envelope has a format version but no key ID, keyring, envelope encryption, rotation job or recovery workflow. The production validator accepts an all-zero encryption key reused as the access-token secret, provided the refresh secret differs. The current local secrets are distinct; this probe demonstrates a missing guard, not weak keys found in use.

Required: managed key custody with narrowly scoped access, auditable use and separation of authentication, current gameplay, retained audit data and any financial signing keys. Add versioned key identifiers, online/offline rotation and retention procedures, backup/recovery tests and emergency revocation. Reject obvious placeholders/reuse, but do not pretend a regex proves randomness. Plan the encryption volume and nonce/key lifetime. JavaScript data cleanup is not a guarantee of memory zeroization.

##### F12 — High: one runtime role can alter both balances and administrator identity

Evidence: live `has_column_privilege` queries; `prisma/migrations/20260920140611_poker_security/migration.sql`; `schema.prisma:64`.

The restricted role correctly lacks DDL and history mutation privileges. However, it can read password hashes and UPDATE both `User.role` and `User.bankroll`; server RLS policies allow all rows to that role. A compromise of this credential or backend process has an unnecessarily broad impact across identity, gameplay and funds. This does not mean a browser can directly exercise those privileges.

Required: separate privileged administration, identity and financial write capabilities. Remove role-management permissions from routine gameplay paths; use narrowly scoped operations with validated accounting invariants and audit trails. Verify effective privileges at startup/CI and after migrations. Field encryption alone cannot stop a process that holds both the database privileges and decryption keys.

##### F13 — High: audit integrity is not independently anchored and live state is replayable

Evidence: `game/encryption.ts`; `game/manager.ts:146`; `engine/src/audit.ts`; `COMPLIANCE.md` section 6.

Completed hand rows are append-only to the runtime role, an important protection. In-flight events live inside a replaceable encrypted table snapshot until settlement. AAD identifies the table but does not prove that a ciphertext is the newest state of that table. GCM authenticates an older valid ciphertext too. An actor able to restore database state can replay old snapshots; a sufficiently privileged database/operator can also replace a complete unanchored history or remove its tail. A local hash chain alone cannot prove completeness against that actor.

Required: durable uniquely identified commands and start/void/settlement records; freshness/reconciliation checks against independently protected ledger/history; externally witnessed commitments/checkpoints or appropriately controlled immutable storage. Anchor enough information to detect missing final hands as well as edits. Preserve a durable record of interrupted/voided games, not only a process log. Define and test the authorized backup-restore protocol so old game state cannot reissue a financial settlement.

##### F14 — High assurance gap, reproduced: audit replay does not validate betting legality

Evidence: `packages/engine/src/audit.ts:158`; observation `auditBettingLegality`.

The verifier explicitly recomputes contributions and outcomes without re-judging action legality, minimum raises or turn order. Replacing a recorded 10-chip CALL with CHECK, leaving the amount unchanged and rebuilding the hash chain, passed both sealed-card and outcome verification. A legitimate CHECK cannot contribute 10 chips. This requires access to construct a new/resealed record; it is not a way for a normal player to bypass the live action validator, and changing previously witnessed hashes would be detectable.

Required: a versioned replay that validates the complete rules and transition sequence, including acting seat, street, effective stack, call amounts, reopening, blinds, status changes and timestamps. Maintain an independent reference implementation for outcome tests; the runtime verifier currently shares evaluator/pot code with the engine. Have the final rules and deployed RNG implementation evaluated by the appropriate independent audit/lab process.

##### F15 — High operational gap: transport and deployment hardening remain unverified

Evidence: `config.ts`, `transport.ts:42`, `index.ts:24`, `.env.example`, `docker-compose.yml`, `apps/web/next.config.ts`.

Production guards correctly refuse insecure requests and direct-TLS tests pass. Proxy mode trusts the first `X-Forwarded-Proto` value from any connecting peer; the documentation correctly requires the app port to be reachable only through a proxy that overwrites it. The listener binds without a specific interface. A public origin port would make forged forwarded headers dangerous and could undermine IP rate limits. This exposure was not established because no production deployment was inspected.

Local configuration is development/HTTP. The included Compose file publishes Postgres and Redis with development defaults and is not production infrastructure. No reviewed deployment enforces secret injection, network segmentation, an authenticated/encrypted proxy-to-app hop where needed, production mode, ingress/DDoS controls, or browser security headers. Helmet on the API does not configure the separate Next.js page origin's CSP.

Required: review the exact production manifest and external URLs, restrict origin/network access, configure trusted peers/header replacement, secure every sensitive network hop, enforce HTTPS/WSS and secure cookies, configure frontend CSP/framing policies, and inspect database/Redis reachability. Include negative tests with forged headers sent directly to the origin.

##### F16 — Medium, reproduced: refresh replay and lifetime policies are incomplete

Evidence: `auth/routes.ts:143`; `schema.prisma:86`; observations `refreshReplay` and `absoluteSessionAge`.

Rotation uses a conditional update, correctly allowing only one concurrent winner. Reusing an older signed refresh token returns 401, but leaves the current session valid with no replay alert or token-family response. Refresh continuously extends expiry by seven days; `createdAt` is not used to cap absolute session age. A session fixture created 365 days earlier still refreshed successfully. Cookie and database durations are hard-coded to seven days even though JWT refresh lifetime is configurable.

Required: define absolute, idle and privileged-session limits; add token-family/reuse handling and telemetry with a bounded concurrency policy so normal multi-tab races do not cause arbitrary lockouts. Bind cookie, database and token lifetimes to one validated policy. Add active session inventory, remote revocation and password/recovery-triggered invalidation. [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

##### F17 — Medium, reproduced: revoked sockets still receive user-room notifications

Evidence: `socket/index.ts:77`; `game/manager.ts:245`, `:261`; observation `revokedSocket`.

Commands and table snapshots reauthenticate the socket, which protects gameplay and hidden cards. `USER_PATCH` and `TABLE_IDLE_NOTICE` are sent directly to a user room without the same check. After deleting the fixture's session, HTTP authentication correctly failed but its otherwise idle socket still received a bankroll update.

Required: disconnect sockets for a revoked session across workers and enforce expiry/revocation for every private outgoing event. Session-scoped rooms or an authorization-aware notification service can support this. Do not describe this reproduction as a hole-card leak; the verified leak was a balance notification.

##### F18 — Medium, reproduced at the handler: cookie routes lack explicit origin/CSRF enforcement

Evidence: `app.ts:33`; `auth/routes.ts:130`, `:143`, `:184`; observation `crossOriginGuest`.

CORS controls whether browser JavaScript can read responses; it is not a general server-side CSRF check. A simple text/plain POST with an untrusted Origin reached `/auth/guest`, created a user and issued a session. Refresh/logout do not validate Origin or an anti-CSRF token. Production SameSite=Strict helps against cross-site cookies but does not distinguish trusted and untrusted same-site subdomains. The local HTTP probe proves handler behavior; browser cookie effects depend on origin/site and deployment policy.

Required: validate the expected Origin/Fetch Metadata and/or a properly bound CSRF token on cookie-authenticated mutations; reject inappropriate media types. Define deliberate exceptions for non-browser clients rather than treating CORS as authorization. Cover login/guest session replacement and logout as well as money operations.

##### F19 — Medium, reproduced: sensitive account responses lack explicit cache prohibition

Evidence: `auth/routes.ts`; `app.ts`; observation `authCaching`.

Successful `/auth/guest` and `/auth/me` responses had no Cache-Control header, despite containing tokens or personal/account data. Audit routes already use `no-store`. This is not proof that a shared proxy is currently caching authenticated content; it is an avoidable browser/proxy configuration risk.

Required: `Cache-Control: no-store` for authentication, private account and financial responses, with correct cache keys/behavior at the CDN and browser boundaries. Verify login, refresh, logout, personal API data and error responses on the deployed system.

##### F20 — Medium: admission, rate limiting and backpressure do not cover a distributed service

Evidence: `app.ts:41`, `:52`; `socket/rate-limit.ts`; `socket/index.ts:64`, `:81`; `game/manager.ts:293`.

HTTP and per-user action limits are held in process memory. Multiple replicas multiply the allowance; guest accounts evade per-user limits. The socket transport has a useful 8 KiB message cap, but no application connection quota or pre-authentication connection limiter was found. Every broadcast fetches sockets and reauthenticates each viewer through Postgres; unbounded concurrent authentication/projection work can amplify load. The earlier body-parser bypass is separate and reproduced in F08.

Required: shared abuse limits and account/IP/device admission rules, bounded concurrent work, per-session connection ceilings, edge limits and measured load shedding. Exercise websocket reconnect storms, large spectator audiences, slow clients, Redis loss and DB pool exhaustion. Rate limiting must remain correct during failover; do not cache revoked authorization beyond its explicitly accepted delay.

##### F21 — Medium: command receipt and service-readiness contracts are incomplete

Evidence: `socket/index.ts:33` and ACTION_INTENT handler; `game/manager.ts:139`; `routes/health.ts`; observation `healthWithoutDatabase`.

`clientActionId` is validated but never persisted or used to return the original outcome. Revisions prevent repeating an action against the same state, but an accepted action whose acknowledgement is lost returns a stale error on retry; there is no durable receipt/query contract. New-table creation has the same uncertain-response problem, although the unique seat constraint limits duplicate seating. Do not treat this as evidence that a replay currently debits twice.

`/api/health` always returns `ok:true`, even with an intentionally unreachable database. That is a usable liveness check but insufficient as readiness. Startup verifies only the presence of some audit columns, not effective permissions, financial reconciliation or the ability to recover every table; individual recovery errors are logged while startup continues.

Required: durable idempotency and operation-outcome queries for financial/escrow commands, plus readiness and table-health reporting that reflect dependency/integrity failures. Healthy tables may continue under an approved isolation policy, but failed ones need a visible recovery state and alert. Add graceful draining, bounded shutdown and durable delivery/recovery for financial effects.

##### F22 — High launch evidence gap: privacy, retention, incident response and restore controls

Evidence: plaintext personal fields in `schema.prisma`; raw logger configuration; repository infrastructure inventory and existing `COMPLIANCE.md` limitations. These controls may exist outside the repo, but none were supplied or verified.

Required evidence: data inventory/classification; minimal retention including sessions, IPs, logs and immutable history; lawful erasure/pseudonymisation handling consistent with regulated retention; access/export records; production access review; independently held backup/key recovery; recovery objectives and restore drills; clock discipline; on-call alerts and incident playbooks; change approvals, CI security gates, dependency update policy and release provenance.

Test recovery of database and keys together without duplicating paid withdrawals or hands. Test loss of a region, unavailable custody provider, compromised signing capability, rogue administrator and missing audit tail. Define custody and player-fund shortfall escalation. Immutable history should preserve what is required without accidentally making unnecessary personal data impossible to manage.

#### Additional correctness and hardening observations

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

#### Malta and custody decisions

Player-versus-player poker charging commission is described by MGA as Type 3. The exact licence scope depends on the business and supplied services; do not reuse claims about house-banked poker or bots to classify this project. [MGA game types](https://www.mga.org.mt/faqs/what-are-the-different-types-of-games-that-are-licensable-by-the-authority/)

MGA has a DLT approval process and publishes distinct system-audit checklists for B2C and B2C with DLT. Integrating a crypto API does not supply those approvals or an independent audit. The old sandbox guidance is not a sufficient current implementation specification; the later DLT policy replaced it. Confirm the applicable policy and proposed architecture with the operator's Malta adviser and approved auditor. [DLT applications](https://www.mga.org.mt/faqs/how-can-licensees-obtain-an-approval-in-order-to-make-use-of-distributed-ledger-technology-dlt/), [DLT policy publication](https://www.mga.org.mt/the-mga-publishes-its-policy-on-the-use-of-distributed-ledger-technology-by-authorised-persons/), [system-audit process](https://www.mga.org.mt/mga-issues-revised-system-audit-checklist-and-new-system-review-checklist/)

Player funds must be segregated and separately identifiable under MGA's explanation of player-fund protection. That requires both appropriate external accounts and accurate internal liabilities; encrypting `bankroll` would provide neither. [MGA player funds](https://www.mga.org.mt/faqs/how-are-player-funds-protected/)

**Engineering recommendation: start by evaluating appropriately regulated payment and custody providers that explicitly accept licensed poker.** This is a recommendation to reduce operational scope, not a claim that any provider makes the site safe automatically. The gambling and financial-services approvals are separate questions. For EU crypto providers, verify the actual legal entity, permitted services and authorization with MFSA/ESMA and obtain advice on whether the proposed operator activities also fall within MiCA. [MFSA crypto-assets framework](https://www.mfsa.mt/our-work/crypto-assets/), [MiCA authorization](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-59-authorisation)

| Model | Responsibilities retained by this application | Additional custody responsibilities |
| --- | --- | --- |
| Regulated provider holds assets | Eligibility, limits, wallet/escrow ledger, authenticated callbacks, withdrawal approvals, provider reconciliation, player statements and incident handling | Provider manages keys under contract; independently verify asset segregation, subcustodians, incident support and exit/asset recovery |
| Operator self-custody | All of the above | Signing infrastructure, hot/cold balances, multi-party control, key backup/rotation/recovery, chain operation, wallet security monitoring and financial-services legal analysis |

Provider selection criteria: contractual support for MGA poker; verified authorization for the relevant services; supported countries/assets/chains; segregation and reconciliation reports; idempotency and signed webhook specifications; withdrawal controls; security audit evidence; liability/insurance limitations; service availability and recoverability. A brand name or quick integration is not a substitute for these checks. No provider has been approved or selected by this review.

#### Order of work and acceptance gates

1. **Keep the money boundary closed.** No deposits/redemption against current balances. Decide entity, target markets, licence scope, approved game rules, settlement currency, provider/custody model and accounting policy.
2. **Fix reproduced code defects.** Safe logging and parser limits; cash-out recipient invariants; outage recovery; session lifetime/replay/revocation; private notifications; origin/CSRF checks; private response cache control. Turn the review probes into normal regression tests that assert rejection or safe behavior after remediation.
3. **Build the financial and eligibility foundations.** Ledger/escrow, exact asset amounts, segregated funds/reconciliation, provider events, withdrawal lifecycle, identity/AML, self-exclusion/limits, privileged identity and anti-collusion operations. Every financial endpoint needs explicit threat modeling and failure tests.
4. **Close operational and integrity gaps.** Managed keys, tested rotation/restores, least-privilege services, durable idempotency and audit witnesses, readiness/alerts, distributed limits and production TLS/network validation.
5. **Verify a disposable production-like staging environment.** Real Postgres concurrency/rollback; restart during every financial step; duplicate/delayed callbacks; reorgs; provider timeout after payout; account exclusion during a transaction; worker/Redis/region loss; restoration from older backups; sustained load and reconnection storms. Use synthetic funds and fixtures.
6. **Obtain external evidence before launch.** Independent penetration test, required game/RNG and MGA system review, reviewed custody/financial procedures, signed operational acceptance and a controlled rollout with limits and emergency stop capability. The report uses OWASP ASVS 5.0 as an engineering reference, not as a certification assertion. [OWASP ASVS](https://github.com/OWASP/ASVS)

#### Reproducing this review's probes

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

## Appendix K: Raw outputs from today's diagnosis and tests (7 October)

The exact output of the key checks, copied from the session transcript, in the order they ran. Very long outputs are cut where marked. Left out on purpose:
- the listing of your PC's processes with their command lines;
- the checks that read which `.env` settings exist.

### 7 Oct 16:59: Check engine and server suite results so far

````
total 41
drwxr-xr-x 1 rronp 197609     0 Oct  7 16:59 .
drwxr-xr-x 1 rronp 197609     0 Oct  7 16:55 ..
-rw-r--r-- 1 rronp 197609 27851 Oct  7 16:59 engine.txt
-rw-r--r-- 1 rronp 197609  5145 Oct  7 17:00 server.txt
-rw-r--r-- 1 rronp 197609    94 Oct  7 16:55 typecheck.txt
      [rng] (e) permutations stage 1: min p 0.4696 vs alpha 1.600e-4 -> pass
            (e) permutations of 5: X2 107.56 ~ chi2(119) over 1000000 shuffles in 8.4 s (min count 8122, max 8541); two-sided p 0.4696
            cell counts (E = 8333.33): 8387 8216 8383 8394 8320 8291 8452 8456 8134 8202 8435 8357 8313 8202 8291 8319 8512 8318 8257 8408 8345 8292 8486 8294 8403 8541 8481 8310 8206 8372 8365 8303 8122 8506 8417 8358 8373 8381 8270 8269 8170 8334 8189 8361 8424 8327 8418 8334 8423 8188 8251 8388 8327 8229 8330 8451 8297 8449 8473 8386 8423 8357 8365 8319 8463 8270 8231 8260 8317 8395 8269 8301 8222 8321 8329 8277 8235 8336 8432 8297 8349 8352 8252 8198 8497 8300 8254 8270 8316 8227 8236 8393 8417 8296 8408 8290 8328 8277 8358 8521 8274 8323 8313 8316 8338 8270 8335 8321 8422 8174 8363 8342 8331 8452 8370 8308 8247 8244 8495 8314

      at expectFamilyPasses (src/__tests__/rng.test.ts:752:11)

    console.info
      [rng] static scan: 26 source files, Math.random in code: 0; mentioned only in comments: packages/engine/src/rng.ts

      at Object.<anonymous> (src/__tests__/rng.test.ts:1235:13)

PASS src/__tests__/pots.test.ts
PASS src/__tests__/bots.test.ts
PASS src/__tests__/deck.test.ts
PASS src/__tests__/turn-clock.test.ts
PASS src/__tests__/table.test.ts
PASS src/__tests__/leave-flow.test.ts
PASS src/__tests__/evaluate.test.ts

Test Suites: 1 failed, 14 passed, 15 total
Tests:       19 failed, 458 passed, 477 total
Snapshots:   0 total
Time:        257.145 s
Ran all test suites.
engine exit 1 263s
----
    security: "REFRESH_REUSE"
    userId: "user-741d7e38-d150-405c-b67b-12b7392d62ff"
    sessionId: "5e725267-afb8-4a00-998c-5737e8de32cc"
    ip: null
[2026-10-07 16:59:59.825 +0200] WARN (18916): SECURITY EVENT: a replaced refresh token was presented again; the session was revoked
    security: "REFRESH_REUSE"
    userId: "user-741d7e38-d150-405c-b67b-12b7392d62ff"
    sessionId: "6f499ec4-a78b-4db3-84a2-cf085f2e6566"
    ip: null
✔ login: unknown users, guests and bots do the same bcrypt work and get the same 401 as a wrong password (797.3154ms)
[2026-10-07 17:00:00.820 +0200] WARN (18916): account locked after repeated failed logins
    security: "LOGIN_LOCKOUT"
    userId: "user-019da258-d1c0-496c-9820-0dd284ffe23b"
    failures: 5
    lockMs: 30000
````

### 7 Oct 17:00: List failing engine tests

````
3:FAIL src/__tests__/review-fixes.test.ts (19.703 s)
4:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects one chip of payout moved between players (stacks moved to match)
21:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects a side pot paid to a player not eligible for it
38:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects the odd chip moved to the other winner
55:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects an uncalled-bet refund reduced by one chip, added to the pot
72:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects an uncalled-bet refund removed, added to the pot
89:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects final stacks changed (total kept)
106:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects HAND_SETTLED chipTotal changed
123:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects HAND_STARTED chipTotal changed
140:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects both chipTotals changed together
157:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects a big blind amount changed
174:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects a call amount changed
191:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects a call amount and every later stackAfter of that seat changed consistently
208:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects an action amount larger than the player's stack
225:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects a starting stack raised with chipTotal (settled stacks unchanged)
242:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects POTS_AWARDED missing
259:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects POTS_AWARDED missing from a fold win
276:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects POTS_AWARDED moved before SHOWDOWN
293:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects POTS_AWARDED moved before the river is dealt
310:  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects POTS_AWARDED duplicated
327:PASS src/__tests__/leakage.test.ts (96.138 s)
328:  ● Console
335:PASS src/__tests__/evaluate-exhaustive.test.ts (55.812 s)
336:PASS src/__tests__/pots-reference.test.ts (16.317 s)
337:PASS src/__tests__/table-lifecycle.test.ts (5.668 s)
338:PASS src/__tests__/security.test.ts
339:PASS src/__tests__/audit.test.ts
340:PASS src/__tests__/rng.test.ts (51.387 s)
341:  ● Console
419:PASS src/__tests__/pots.test.ts
420:PASS src/__tests__/bots.test.ts
421:PASS src/__tests__/deck.test.ts
422:PASS src/__tests__/turn-clock.test.ts
423:PASS src/__tests__/table.test.ts
424:PASS src/__tests__/leave-flow.test.ts
425:PASS src/__tests__/evaluate.test.ts
````

### 7 Oct 17:00: Show first failing test details

````
  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects one chip of payout moved between players (stacks moved to match)

    expect(received).toBe(expected) // Object.is equality

    Expected: true
    Received: false

      937 |       await expectChainIntact(forged);
      938 |       // Card integrity alone cannot see a pure outcome forgery; the replay must.
    > 939 |       if (cardIntegrityPasses) expect((await verifySealedAudit(forged, hand.sealed)).ok).toBe(true);
          |                                                                                          ^
      940 |       expectRejected(verifyHandOutcome(forged, hand.sealed), reason);
      941 |     });
      942 |

      at src/__tests__/review-fixes.test.ts:939:90

  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects a side pot paid to a player not eligible for it

    expect(received).toBe(expected) // Object.is equality

    Expected: true
    Received: false

      937 |       await expectChainIntact(forged);
      938 |       // Card integrity alone cannot see a pure outcome forgery; the replay must.
    > 939 |       if (cardIntegrityPasses) expect((await verifySealedAudit(forged, hand.sealed)).ok).toBe(true);
          |                                                                                          ^
      940 |       expectRejected(verifyHandOutcome(forged, hand.sealed), reason);
      941 |     });
      942 |

      at src/__tests__/review-fixes.test.ts:939:90

  ● 3. verifyHandOutcome: regulator replay of the hand result › rejects re-sealed forgeries that keep every hash valid › rejects the odd chip moved to the other winner

    expect(received).toBe(expected) // Object.is equality
````

### 7 Oct 17:01: Rerun ledger unit tests with tsx loader

````
exit 0
ℹ tests 21
ℹ pass 21
ℹ fail 0
````

### 7 Oct 17:01: Count server tests without double counting

````
123
21
money tests also in first run: 8
````

### 7 Oct 17:07: Read real-DB and browser suite results

````
  +     column_name: 'resolvedBy',
  +     privilege_type: 'UPDATE',
  +     table_name: 'TableIncident'
  +   },
  +   {
  +     column_name: 'tableId',
  +     privilege_type: 'INSERT',
  +     table_name: 'TableIncident'
  +   },
  +   {
  +     column_name: 'tableId',
  +     privilege_type: 'UPDATE',
  +     table_name: 'TableIncident'
  +   }
  + ]
  - []
  
      at TestContext.<anonymous> (file:///C:/Users/rronp/Documents/GitHub/Poker/poker_website/apps/server/test/db/privileges.test.mjs:135:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ { table_name: 'TableIncident', column_name: 'createdAt', privilege_type: 'INSERT' }, { table_name: 'TableIncident', column_name: 'createdAt', privilege_type: 'UPDATE' }, { table_name: 'TableIncident', column_name: 'id', privilege_type: 'INSERT' }, { table_name: 'TableIncident', column_name: 'id', privilege_type: 'UPDATE' }, { table_name: 'TableIncident', column_name: 'kind', privilege_type: 'INSERT' }, { table_name: 'TableIncident', column_name: 'kind', privilege_type: 'UPDATE' }, { table_name: 'TableIncident', column_name: 'reason', privilege_type: 'INSERT' }, { table_name: 'TableIncident', column_name: 'reason', privilege_type: 'UPDATE' }, { table_name: 'TableIncident', column_name: 'resolvedAt', privilege_type: 'INSERT' }, { table_name: 'TableIncident', column_name: 'resolvedAt', privilege_type: 'UPDATE' }, { table_name: 'TableIncident', column_name: 'resolvedBy', privilege_type: 'INSERT' }, { table_name: 'TableIncident', column_name: 'resolvedBy', privilege_type: 'UPDATE' }, { table_name: 'TableIncident', column_name: 'tableId', privilege_type: 'INSERT' }, { table_name: 'TableIncident', column_name: 'tableId', privilege_type: 'UPDATE' } ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
[pg] command finished with exit code 1 after 34534 ms; stopping PostgreSQL
db exit 1 56s
----
  ok 120 [mobile] › test\browser\table-lifecycle.spec.ts:95:5 › during the warning the action bar stays usable, and acting ends the warning (1.4s)
  ok 121 [mobile] › test\browser\table-lifecycle.spec.ts:118:5 › on a short landscape phone the table warning shows its focused action above the action dock (1.5s)
  ok 122 [mobile] › test\browser\table-lifecycle.spec.ts:149:5 › a spectator can take a seat during the warning, which keeps the table open (1.4s)
  ok 123 [mobile] › test\browser\table-lifecycle.spec.ts:173:5 › a newer snapshot restarts the countdown, which reads "Closing the table…" at zero (3.1s)
  ok 124 [mobile] › test\browser\table-lifecycle.spec.ts:188:5 › the countdown ignores a device clock that is far off the server's (3.1s)
  ok 125 [mobile] › test\browser\table-lifecycle.spec.ts:201:5 › keeping the table open shows pending and error states and can be retried (1.7s)
  ok 126 [mobile] › test\browser\table-lifecycle.spec.ts:228:5 › a session refresh while "I'm still here" is pending leaves the table and the app live (7.0s)
  ok 127 [mobile] › test\browser\table-lifecycle.spec.ts:277:5 › an idle closure settles the hand, then the closed dialog returns the player to the lobby (1.8s)
  ok 128 [mobile] › test\browser\table-lifecycle.spec.ts:309:5 › the lobby explains an idle closure that happened while the player was away (1.4s)
  ok 129 [mobile] › test\browser\table-lifecycle.spec.ts:326:5 › joining a table that has closed shows the closed dialog (1.5s)
  ok 130 [mobile] › test\browser\table-lifecycle.spec.ts:342:5 › back from a dropped connection to a table that closed mid-hand, the closed dialog verifies that hand (2.2s)
  ok 131 [mobile] › test\browser\table-lifecycle.spec.ts:371:5 › a host who leaves a table nobody joined closes it (1.6s)
  ok 132 [mobile] › test\browser\table-lifecycle.spec.ts:386:5 › a player who kept their seat gets the warning in the lobby and can keep the table open from there (3.4s)
  ok 133 [mobile] › test\browser\table-lifecycle.spec.ts:415:5 › on a phone held in landscape the lobby warning's actions are on screen and work (2.1s)
  ok 134 [mobile] › test\browser\table-lifecycle.spec.ts:438:5 › the lobby warning ends when another player keeps the table open, and "Go to table" opens the table's own warning (2.6s)
  ok 135 [mobile] › test\browser\table-lifecycle.spec.ts:459:5 › the lobby warning gives way to the closed notice when the table closes (1.6s)
  ok 136 [mobile] › test\browser\table-lifecycle.spec.ts:472:5 › opening another table's page clears the lobby's closed-table notice (1.7s)
  ok 137 [mobile] › test\browser\table-lifecycle.spec.ts:485:5 › opening a new table clears the lobby's closed-table notice (1.7s)
  ok 138 [mobile] › test\browser\table-lifecycle.spec.ts:495:5 › a refusal about another table does not close this one (1.2s)
  ok 139 [mobile] › test\browser\table-lifecycle.spec.ts:512:5 › leaving as the table closes takes the player to the lobby with their chips back (1.4s)
  ok 140 [mobile] › test\browser\table-ui.spec.ts:50:7 › turn clock › counts from the server's relative remaining time, never the device's wall clock (1.3s)
  ok 141 [mobile] › test\browser\table-ui.spec.ts:70:7 › turn clock › shows the time-bank phase distinctly when the server splits base and bank time (1.3s)
  ok 142 [mobile] › test\browser\table-ui.spec.ts:88:7 › turn clock › under reduced motion the bar is not drained at once: it steps each second, with a text countdown (3.6s)
  ok 143 [mobile] › test\browser\table-ui.spec.ts:110:7 › actions never wait on sound or storage › blocked storage and a broken AudioContext do not freeze the action buttons (1.3s)
  ok 144 [mobile] › test\browser\table-ui.spec.ts:129:7 › actions never wait on sound or storage › a suspended AudioContext is resumed on the first gesture (1.3s)
  ok 145 [mobile] › test\browser\table-ui.sp
[output cut here: 1836 more characters]
````

### 7 Oct 17:07: Summarize real-DB suite results

````
3:✔ one user claims seats at two different tables at once: exactly one seat, exactly one bankroll debit (2293.4561ms)
4:✔ two users race for the same seat: one wins, the loser's bankroll is unchanged (522.8977ms)
5:✔ one user double-submits two seats at the same table: one seat, one debit (678.1654ms)
6:✔ standUp racing the Hand Clean-up of a settled hand (standUp first): the leaver is paid exactly once (294.7643ms)
7:✔ standUp racing the Hand Clean-up of a settled hand (Clean-up first): the leaver is paid exactly once (461.9988ms)
8:✔ a pending leaver's repeated standUp racing the Clean-up that pays them: credited exactly once (1150.5906ms)
9:✔ the last player leaving closes the table in the same commit as their cash-out; a racing claim (after the leave) is refused and charged nothing, or keeps the table open (310.8347ms)
10:✔ the last player leaving closes the table in the same commit as their cash-out; a racing claim (before the leave) is refused and charged nothing, or keeps the table open (401.1311ms)
11:✔ the ledger migration is applied after every earlier migration (184.5189ms)
12:✔ migration applies on a database with existing rows, leaves them untouched, and works without BYPASSRLS (1672.9038ms)
13:✔ functions are SECURITY DEFINER with a pinned search_path and only poker_server may execute them (4.9098ms)
14:✔ the runtime role can read the ledger and call the functions, but cannot write any ledger table (4628.7704ms)
15:✔ ledger_ensure_account is idempotent and validates owner, type and asset (4533.2288ms)
16:✔ the database itself refuses invalid postings when ledger_post is called directly (6878.5186ms)
17:✔ the database refuses an asset mismatch, a disabled asset and a balance overflow (1692.1321ms)
18:✔ idempotency: same key and payload posts once; a different payload conflicts (511.8245ms)
19:✔ idempotency under concurrency: a second attempt waits for the first and replays or conflicts (272.4334ms)
20:✔ many concurrent attempts with one idempotency key have exactly one effect (2965.3655ms)
21:✔ 50 concurrent buy-ins on one balance never overdraw and conserve the total (4517.6073ms)
22:✔ many concurrent crossing transfers complete without deadlock (3261.4702ms)
23:✔ first postings that create the same new accounts from opposite plan orders do not deadlock (1542.7164ms)
24:✔ disabling an asset is an exact stop: no posting validated before the disable commits after it (16.4704ms)
25:✔ after 1,000+ random postings every account reconstructs from the journal and every asset sums to zero (948.8083ms)
26:✔ a tampered cached balance is detected by reconstructBalance (3.7893ms)
27:✔ the runtime role cannot change User.role or User.kind but can update other columns (7.16ms)
28:✔ the runtime role cannot record a hand without the audit trail; an audited hand is accepted (3.1301ms)
29:✔ every migration applies from scratch into an empty database, in order, finished, never rolled back, with the repository checksum (4456.7854ms)
30:✔ the harness database (the one every other suite uses) has the same migrations applied (397.9338ms)
31:✔ prisma migrate status: the database schema is up to date (6715.208ms)
32:✔ prisma migrate deploy on an up-to-date database applies nothing (3142.9391ms)
33:✔ schema.prisma matches the migrated database (prisma migrate diff --exit-code reports no drift) (5898.6936ms)
34:✔ the runtime connection really is poker_server, a plain role (502.0966ms)
35:✔ RLS is enabled AND forced on every table in schema public except _prisma_migrations, and each has a policy (4.1106ms)
36:✖ every table in schema public is in the expected privilege matrix (a new table must be added here deliberately) (1.8691ms)
37:✔ PUBLIC has no privilege on any table, sequence or SECURITY DEFINER function in schema public (3.3532ms)
38:✖ poker_server's table privileges are exactly the expected matrix (catalog check) (34.3447ms)
39:✔ poker_server cannot UPDATE or DELETE hand history (Hand, HandPlayer, HandAction, HandPot) (9.1709ms)
40:✔ poker_server cannot DELETE (or TRUNCATE) User or Table rows (3.6064ms)
41:✔ poker_server cannot write the ledger tables directly (only through ledger_post / ledger_ensure_account) (13.5681ms)
42:✔ poker_server cannot touch Prisma's migration history (1.9706ms)
43:✔ poker_server has no CREATE on schema public (no tables, views, functions or types of its own) (2.9611ms)
44:✔ poker_server cannot change table structure, policies or RLS settings (1.9659ms)
45:✔ among SECURITY DEFINER functions poker_server may execute only ledger_post and ledger_ensure_account (1.0986ms)
46:ℹ tests 43
47:ℹ suites 0
48:ℹ pass 41
49:ℹ fail 2
50:ℹ cancelled 0
51:ℹ skipped 0
52:ℹ todo 0
53:ℹ duration_ms 34089.6916
55:✖ failing tests:
58:✖ every table in schema public is in the expected privilege matrix (a new table must be added here deliberately) (1.8691ms)
79:      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
98:✖ poker_server's table privileges are exactly the expected matrix (catalog check) (34.3447ms)
179:      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
````

### 7 Oct 17:08: Inspect TableIncident grants in the migration

````
test at test\db\privileges.test.mjs:104:1
✖ every table in schema public is in the expected privilege matrix (a new table must be added here deliberately) (1.8691ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  ... Skipped lines
  
    [
      'Asset',
      'BotStatistic',
      'Hand',
      'HandAction',
  ...
      'Table',
  +   'TableIncident',
      'TableSeat',
      'User',
      '_prisma_migrations'
    ]
  
      at TestContext.<anonymous> (file:///C:/Users/rronp/Documents/GitHub/Poker/poker_website/apps/server/test/db/privileges.test.mjs:106:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
12:CREATE TABLE public."TableIncident" (
38:  REVOKE ALL ON TABLE public."TableIncident" FROM PUBLIC;
41:    REVOKE ALL ON TABLE public."TableIncident" FROM anon, authenticated, service_role;
43:  REVOKE ALL ON TABLE public."TableIncident" FROM poker_server;
44:  GRANT SELECT, INSERT, UPDATE ON TABLE public."TableIncident" TO poker_server;
45:  CREATE POLICY server_only ON public."TableIncident" TO poker_server USING (true) WITH CHECK (true);
38:  REVOKE ALL ON TABLE public."TableIncident" FROM PUBLIC;
41:    REVOKE ALL ON TABLE public."TableIncident" FROM anon, authenticated, service_role;
43:  REVOKE ALL ON TABLE public."TableIncident" FROM poker_server;
44:  GRANT SELECT, INSERT, UPDATE ON TABLE public."TableIncident" TO poker_server;
45:  CREATE POLICY server_only ON public."TableIncident" TO poker_server USING (true) WITH CHECK (true);
````

### 7 Oct 19:12: Re-run the socket contract check myself

````
snapshot turnId: 1:2 revision: 0
ack for the web payload (with turnId): {"ok":false,"code":"INVALID_REQUEST","message":"Request could not be completed"}
ack without turnId: {"ok":true}
manager.intent calls: 1
✔ ACTION_INTENT exactly as action-bar.tsx sends it (with turnId) is refused before it reaches the manager (65.6805ms)
ack for amount 150.5: {"ok":false,"code":"INVALID_REQUEST","message":"Request could not be completed"}
✔ CR-019 server side: a fractional amount gets the generic INVALID_REQUEST, not BAD_AMOUNT (14.8538ms)
SERVER_ERROR after web SEAT_CLAIM: [{"code":"INVALID_REQUEST","message":"Request could not be completed","tableId":"contract"}] ack: null seatClaim calls: 0
payload without commandId: seatClaim calls: 1 ack: null
✔ SEAT_CLAIM exactly as buy-in-dialog.tsx sends it (with commandId) is refused; no ack in either case (CR-017) (839.7863ms)
SIT_OUT: sitToggle calls 1 ack null
✔ CR-017: SIT_OUT / SIT_IN have no acknowledgement (310.9169ms)
ℹ pass 4
ℹ fail 0
````

### 7 Oct 19:12: Check whether TableIncident and PAUSED are used

````
apps/server/src/game/manager.ts:77:    if (row.status === "IN_HAND" || lastHand) throw new EngineError("RECOVERY_REQUIRED", "Saved game state is missing; table paused for recovery");
---
-- Game reliability (findings CR-004 / D12): a table the server can no longer
-- run is PAUSED for the operator instead of being retried forever.
-- Additive only, safe on a live database: two nullable columns on "Table"
-- (no default, so no table rewrite; every existing row stays NULL) and one new
-- table. No existing row is read, changed or backfilled.

ALTER TABLE public."Table" ADD COLUMN "pausedAt" TIMESTAMP(3), ADD COLUMN "pausedReason" TEXT;
ALTER TABLE public."Table" ADD CONSTRAINT "Table_pausedReason_length" CHECK ("pausedReason" IS NULL OR length("pausedReason") BETWEEN 1 AND 1000);

-- One row per incident; resolvedAt/resolvedBy are set together when an
-- operator closes it. The runtime role can never delete one (audit trail).
CREATE TABLE public."TableIncident" (
30:  PAUSED
145:  /// Set with status PAUSED when the server stops running the table after
146:  /// repeated failures (migration 20261003100000_game_reliability); see TableIncident.
156:  incidents      TableIncident[]
165:model TableIncident {
````

### 7 Oct 19:13: Confirm base turn time and gameConfig readers

````
49:  TURN_TIME_BANK_MS: z.coerce.number().int().min(5_000).max(120_000).default(20_000),
readers: 0
````

### 7 Oct 19:50: Find damaged line and read fuzz totals

````
22:Not everything is encrypted, and the project has not been certified to MGA/GLI standards. Fixes, production validation and independent assurance remain outstanding. See the 2026-10-07 entry,  and .
== seed 1
    "steps": 25120,
    "hands": 2118,
    "showdowns": 536,
    "closedIdle": 22,
    "closedEmpty": 26,
    "verifiedParticipantAudits": 4628,
    "clientVerifications": 55777
  "failureCount": 0,
== seed 2
    "steps": 25133,
    "hands": 2160,
    "showdowns": 600,
    "closedIdle": 20,
    "closedEmpty": 24,
    "verifiedParticipantAudits": 4774,
    "clientVerifications": 60042
  "failureCount": 0,
== seed 3
    "steps": 23358,
    "hands": 1970,
    "showdowns": 544,
    "closedIdle": 27,
    "closedEmpty": 23,
    "verifiedParticipantAudits": 4319,
    "clientVerifications": 49908
  "failureCount": 0,
````

### 7 Oct 19:56: Check which dev ports are listening

````
LocalAddress LocalPort OwningProcess
------------ --------- -------------
::                3000         35012



   Id ProcessName StartTime           
   -- ----------- ---------           
35012 node        07-Oct-26 4:42:30 PM
````

### 7 Oct 20:06: List node processes and every listening port

````
--- node processes: 8

ProcessId ParentProcessId Started 
--------- --------------- ------- 
    24176           33120 16:42:15
    29000           35028 16:42:25
    34868           33820 16:42:27
    35448           27776 16:42:27
    35676           32424 16:42:27
    35184           31200 16:42:27
    35012           35184 16:42:30
    11876           35012 16:42:57


--- every TCP listener owned by a node process

LocalAddress LocalPort OwningProcess
------------ --------- -------------
::                3000         35012
127.0.0.1        17626         35012


--- anything on 4000-4010
````

### 7 Oct 20:07: Boot the real server source against the disposable database

````
[pg] PostgreSQL 18.4 on 127.0.0.1:12608, 8 migrations applied, ready in 9792 ms
{
  "startedListening": true,
  "steps": {
    "ready": {
      "status": 200,
      "body": {
        "ready": true
      }
    },
    "guestFromDevOrigin": {
      "status": 201,
      "gotToken": true,
      "username": "Guest_327f85e0ef"
    },
    "lobbyList": {
      "status": 200,
      "count": 0
    },
    "me": {
      "status": 200
    },
    "preflightFrom_http://localhost:3000": {
      "status": 204,
      "allowOrigin": "http://localhost:3000"
    },
    "guestFrom_http://localhost:3000": {
      "status": 201
    },
    "preflightFrom_http://127.0.0.1:3000": {
      "status": 204,
      "allowOrigin": "http://localhost:3000"
    },
    "guestFrom_http://127.0.0.1:3000": {
      "status": 403,
      "error": "Cross-origin request refused"
    }
  },
  "secondsToListen": 1.6,
  "stillRunningAfter20s": true,
  "exited": null
}
--- last server output (10 of 10 lines) ---
[2026-10-07 20:07:35.164 +0200] WARN (65348): REDIS_URL unset — using one Socket.io process; game state is durable in Postgres
[2026-10-07 20:07:35.367 +0200] INFO (65348): Poker server listening on http://127.0.0.1:4010
    tls: "none"
    host: "127.0.0.1"
    port: 4010
[2026-10-07 20:07:35.585 +0200] WARN (65348): refused state-changing request
    security: "CROSS_ORIGIN_REFUSED"
    reason: "origin"
    method: "POST"
    path: "/api/auth/guest"
[pg] command finished with exit code 0 after 22466 ms; stopping PostgreSQL
````

### 7 Oct 20:17: Check build timestamps, Prisma setup and end of server entry

````
--- build output and Prisma client modification times
09-29 17:32:49  packages/shared/dist/index.js
09-29 17:32:53  packages/engine/dist/index.js
10-07 16:54:13  apps/server/dist/index.js
10-07 16:54:13  apps/server/dist/db/prisma.js
10-05 00:18:20  apps/server/src/index.ts
10-06 01:40:21  apps/server/prisma/schema.prisma
node_modules/.prisma/client
node_modules/@prisma/client
10-06 01:31:19  node_modules/.prisma/client/index.js
10-06 01:31:19  node_modules/.prisma/client/schema.prisma
--- generator block
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  PLAYER
  ADMIN
}

enum PlayerKind {
  HUMAN
--- server scripts
8:    "dev": "tsx watch src/index.ts",
9:    "build": "tsc -p tsconfig.json",
12:    "prisma:generate": "prisma generate",
13:    "prisma:migrate": "prisma migrate deploy",
14:    "prisma:migrate:dev": "prisma migrate dev",
15:    "prisma:reset": "prisma migrate reset --force",
16:    "prisma:seed": "tsx prisma/seed.ts",
49:    "prisma": "^6.16.1",
--- end of index.ts
  let draining = false;
  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    readiness.startDraining();
    logger.info({ signal }, "draining before shutdown");
    try {
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeIdleConnections();
      // io.close() disconnects every socket and closes the engine (and calls
      // httpServer.close again, which is harmless).
      io.close();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        closed.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), DRAIN_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        logger.warn({ timeoutMs: DRAIN_TIMEOUT_MS }, "drain timed out; closing remaining connections");
        httpServer.closeAllConnections();
      }
      tableManager.stop();
      await prisma.$disconnect();
      await disconnectRedis();
      logger.info({ signal }, "shutdown complete");
      process.exit(0);
    } catch (err) {
      fatal("shutdown")(err);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: serializeError(err, env.NODE_ENV !== "production") }, "fatal startup error");
  process.exit(1);
});
````

### 7 Oct 20:17: Retry: watcher children, boot time, reserved ports

````
children of the server watcher (pid 35676): 0
last boot: 2026-10-07 16:40:02
now:       2026-10-07 20:18:03
--- reserved TCP port ranges covering 4000 or 3000:
(end of list)
````

### 7 Oct 20:19: Test network reachability of the Supabase database host

````
DNS A: none (ENODATA)
DNS AAAA: 1 record(s)
TCP 5432 over IPv4: ENOTFOUND
TCP 5432 over IPv6: ENOENT
TCP 6543 over IPv4: ENOTFOUND
TCP 6543 over IPv6: ENOENT
````

### 7 Oct 20:19: Run the read-only connect and schema probe

````
Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Reads]. If you have other tasks that don't depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed. To allow this type of action in the future, the user can add a permission rule for Bash to their settings.
````

### 7 Oct 20:20: Control test: does this PC have IPv6 and IPv4 internet

````
global IPv6 addresses on this PC: 2
ipv6.google.com:443 IPv6 -> ENOENT
www.google.com:443 IPv4 -> connected in 26 ms
jeyjkqbmatctucfuhohs.supabase.co:443 IPv4 -> connected in 57 ms
````

### 7 Oct 20:26: Test the IPv4 pooler and find message references

````
aws-0-eu-west-1.pooler.supabase.com:5432 IPv4 -> reachable (194 ms)
aws-0-eu-west-1.pooler.supabase.com:6543 IPv4 -> reachable (72 ms)
aws-1-eu-west-1.pooler.supabase.com:5432 IPv4 -> reachable (122 ms)
aws-1-eu-west-1.pooler.supabase.com:6543 IPv4 -> reachable (79 ms)
--- tests or docs that quote the lobby message
apps/web/src/app/page.tsx:11:import { api, API_UNAVAILABLE_MESSAGE } from "@/lib/api";
apps/web/src/app/page.tsx:305:          {API_UNAVAILABLE_MESSAGE} This page will reconnect automatically.
apps/web/src/app/table/[id]/page.tsx:20:import { API_UNAVAILABLE_MESSAGE } from "@/lib/api";
apps/web/src/app/table/[id]/page.tsx:53:        <p className="mt-3 text-emerald-50">{apiOffline ? API_UNAVAILABLE_MESSAGE : "You need a session before joining a
apps/web/src/lib/api.ts:5:export const API_UNAVAILABLE_MESSAGE = process.env.NODE_ENV === "development"
apps/web/src/lib/api.ts:6:  ? "Game server unavailable. Start both services with npm run dev, then retry."
apps/web/src/lib/api.ts:53:    throw new ApiError(API_UNAVAILABLE_MESSAGE, 0);
--- .env example files
.env
.env.example
next-env.d.ts
````

### 7 Oct 20:29: Check whether today's build rewrote shared packages

````
packages/shared/dist: newest file 10-07 16:42:22 ; files written today: 2
packages/engine/dist: newest file 10-07 16:42:24 ; files written today: 5
16:    "build": "npm run build -w @poker/shared && npm run build -w @poker/engine && npm run build -w @poker/server && npm run build -w @poker/web",
25:    "build:core": "npm run build -w @poker/shared && npm run build -w @poker/engine",
````

### 7 Oct 20:30: Check which error messages the serializer keeps

````
90:function messageMayCarryInput(err: Record<string, unknown>, name: string): boolean {
91-  if (isBodyParserError(err)) return true;
92-  if (name.startsWith("PrismaClient") || name === "SyntaxError") return true;
93-  return "body" in err || "rawBody" in err;
94-}
95-
96-/**
97- * Allow-list serializer for errors (used as pino's `err` serializer and by
98- * the HTTP catch-all). `includeStack` is false in production: stacks are for
99- * debugging, and a production log should carry only what operations needs.
100- */
101-export function serializeError(err: unknown, includeStack: boolean, depth = 0): SafeError {
102-  if (typeof err !== "object" || err === null) return { name: typeof err === "string" ? "ThrownString" : `Thrown${typeof err}` };
103-  const record = err as Record<string, unknown>;
104-  const name = typeof record.name === "string" && record.name.length <= 80 ? record.name : (err.constructor?.name ?? "Error").slice(0, 80);
83:function scrub(message: string): string {
84-  let out = message.slice(0, MAX_MESSAGE * 2);
85-  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
86-  return out.slice(0, MAX_MESSAGE);
87-}
88-
89-/** Errors whose message is built from request or query data and so is never kept. */
90-function messageMayCarryInput(err: Record<string, unknown>, name: string): boolean {
91-  if (isBodyParserError(err)) return true;
````

### 7 Oct 20:34: Typecheck, rebuild server, run the new tests

````
tsc server OK
tsc web OK
server dist rebuilt
✔ ACTION_INTENT exactly as the web client sends it (with turnId) reaches the table manager with that turn (57.358ms)
✔ the action schema stays strict: a malformed turnId or an unknown key is refused before the manager (16.3285ms)
✔ SEAT_CLAIM exactly as the buy-in dialog sends it (commandId and ack) is claimed and acknowledged (9.3638ms)
✔ a refused SEAT_CLAIM is acknowledged with its reason, and SERVER_ERROR names the table (67.3026ms)
          ZodError: [
          ZodError: [
          EngineError: Not enough bankroll
          Error: deal failed
✔ a hand that fails to start after a committed claim is not reported as a failed claim (CR-017) (122.2823ms)
✔ SEAT_CLAIM without commandId or ack (older clients) still claims (46.5672ms)
✔ SIT_OUT and SIT_IN accept a commandId and are acknowledged (9.4341ms)
✔ an action for the current turn is accepted after an unrelated change bumped the revision (CR-008) (5.479ms)
✔ an action naming a turn that is over is refused as stale; without a turnId the revision rule still applies (3.7994ms)
✔ an unreachable Supabase direct host is explained with the IPv6 advice; credentials are never named (1.8866ms)
✔ a pooler host gets no IPv6 advice, and a rejected login is not treated as retryable (6.0081ms)
✔ in development an unreachable database is retried with back-off until it answers (1.0698ms)
✔ without retry the first failure is fatal, and the logged error keeps the explanation (0.8681ms)
✔ a rejected login is fatal at once, even in development (0.2684ms)
✔ the schema check names every missing migration, passes a current database, and rethrows other errors (1.0581ms)
ℹ tests 15
ℹ pass 15
ℹ fail 0
````

### 7 Oct 20:36: Run the end-to-end check on a throwaway Postgres

````
      "code": 1,
      "signal": null
    },
    "refusalLine": "      \"message\": \"Database is missing migration(s) 20261001100000_auth_hardening, 20261003100000_game_reliability. Apply the pending migrations (README, \\\"Database and migrations\\\") before starting the game server.\",",
    "namesAuthHardening": true,
    "namesGameReliability": true,
    "namesLedger": false
  },
  "C_unreachableAtStart": {
    "aliveAfter6s": true,
    "retryLogLines": 2,
    "firstRetryLine": "[2026-10-07 20:37:05.573 +0200] WARN (63952): database unavailable: Cannot reach the database at 127.0.0.1:38611. Check the internet connection, any VPN or firewall, and DATABASE_URL in .env. Retrying in 1 s.",
    "healthWhileWaiting": 0,
    "cameUpAfterDatabaseMs": 438,
    "ready": 200
  },
  "D_join": {
    "seatClaimAcks": [
      {
        "ok": true
      },
      {
        "ok": true
      }
    ]
  },
  "D_play": {
    "handStarted": {
      "phase": "PREFLOP",
      "turnId": "1:2"
    },
    "firstActionAck": {
      "ok": true
    },
    "sitOutAck": {
      "ok": true
    },
    "revisionBumpedButTurnUnchanged": true,
    "actionWithOldRevisionSameTurnAck": {
      "ok": true
    },
    "actionForFinishedTurnAck": {
      "ok": false,
      "code": "STALE_ACTION",
      "message": "The table changed; use the latest action buttons"
    },
    "unexpectedServerErrors": []
  }
}
--- server output (last 30 lines) ---
              at ei.handleRequestError (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\RequestHandler.ts:228:13)
              at ei.handleAndLogRequestError (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\RequestHandler.ts:174:12)
              at ei.request (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\RequestHandler.ts:143:12)
              at async a (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\getPrismaClient.ts:833:24)
              at async TableManager.load (C:\Users\rronp\Documents\GitHub\Poker\poker_website\apps\server\src\game\manager.ts:67:17)
              at async TableManager.get (C:\Users\rronp\Documents\GitHub\Poker\poker_website\apps\server\src\game\manager.ts:91:69)
    }
prisma:error 
Invalid `tx.table.findUnique()` invocation in
C:\Users\rronp\Documents\GitHub\Poker\poker_website\apps\server\src\game\manager.ts:67:32
  64  * see the upgraded state; `mutate` persists it and pays its cash-outs.
  65  */
  66 private async load(tx: Tx, tableId: string): Promise<Loaded | null> {
→ 67   const row = await tx.table.findUnique(
Can't reach database server at `127.0.0.1:38611`
Please make sure your database server is running at `127.0.0.1:38611`.
[2026-10-07 20:42:15.960 +0200] ERROR (63952): idle timer retry failed
    tableId: "cmuyg94ov0004iicgva0jt7te"
    err: {
      "name": "PrismaClientKnownRequestError",
      "code": "P1001",
      "stack":
          PrismaClientKnownRequestError
              at ei.handleRequestError (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\RequestHandler.ts:228:13)
              at ei.handleAndLogRequestError (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\RequestHandler.ts:174:12)
              at ei.request (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\RequestHandler.ts:143:12)
              at async a (C:\Users\rronp\Documents\GitHub\Poker\poker_website\node_modules\@prisma\client\src\runtime\getPrismaClient.ts:833:24)
              at async TableManager.load (C:\Users\rronp\Documents\GitHub\Poker\poker_website\apps\server\src\game\manager.ts:67:17)
              at async TableManager.get (C:\Users\rronp\Documents\GitHub\Poker\poker_website\apps\server\src\game\manager.ts:91:69)
    }
````

### 7 Oct 20:42: Check what Prisma prints on a failed connect in dev

````
--- caught: PrismaClientInitializationError P1001 | message first line: Can't reach database server at `127.0.0.1:1`
````

### 7 Oct 20:42: Run the full server and ledger test suites

````
server suite exit 0
ℹ tests 130
ℹ pass 130
ℹ fail 0
ledger exit 0
ℹ tests 21
ℹ pass 21
ℹ fail 0
````

### 7 Oct 20:44: Check whether the dev game server restarted

````
server watcher children now: 0
listening on 4000: 0
````

### 7 Oct 20:44: Compare schemas ignoring whitespace and comments

````
114a115,116
> pausedAt DateTime?
> pausedReason String?
118a121
> incidents TableIncident[]
120a124,134
> }
> model TableIncident {
> id String @id @default(cuid())
> tableId String
> table Table @relation(fields: [tableId], references: [id], onDelete: Restrict)
> kind String
> reason String
> createdAt DateTime @default(now())
> resolvedAt DateTime?
> resolvedBy String?
> @@index([tableId, createdAt])
semantic diff lines (excluding doc comments): 14
````

### 7 Oct 20:45: Regenerate the Prisma client and confirm it matches

````
Loaded Prisma config from prisma.config.ts.
Prisma config detected, skipping environment variable loading.
Prisma schema loaded from prisma\schema.prisma
✔ Generated Prisma Client (v6.19.3) to .\..\..\node_modules\@prisma\client in 630ms
Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)
Tip: Want to turn off tips and other hints? https://pris.ly/tip-4-nohints
semantic diff after generate: 0
````

### 7 Oct 20:45: Re-run typecheck, server suite and end-to-end check

````
tsc server OK
server suite exit 0
ℹ tests 130
ℹ pass 130
ℹ fail 0
e2e exit 0
{"B":{"exit":{"code":1,"signal":null},"auth":true,"rel":true},"C":{"alive":true,"retries":2,"ready":200},"D":{"claims":[{"ok":true},{"ok":true}],"first":{"ok":true},"cr008":{"ok":true},"stale":"STALE_ACTION","errors":0},"error":null}
````

### 7 Oct 20:51: Read browser suite result after the fix

````
  ok 156 [mobile] › test\browser\table-ui.spec.ts:376:7 › absence copy › a player sat out by the server is told why next to "Sit in" (1.2s)

  156 passed (6.2m)
browser exit 0 374s
57
next-env.d.ts unchanged
````

## Appendix L: What I told you about auto mode (29 September)

Your questions and my answers, word for word, from the session transcript.

**You (29 Sep 22:18):**

why exactly are you getting this data again ?

**Claude (29 Sep 22:19):**

That isn't me gathering anything. `/auto-mode-setup` is a built-in Claude Code command, and the "Gathering data…" message comes from it. It's separate from what I did earlier: I read your repo files only to write the GPT-6.1-Sol prompt, and I haven't read anything since.

**What it's for:** in auto mode, Claude Code skips most permission prompts and a second model checks each action instead. That checker blocks anything risky or anything that goes outside "your environment". By default it trusts only this folder and this repo's git remote. `/auto-mode-setup` drafts a description of your environment (your repos, services, domains) so the checker stops blocking routine work. Claude Code also offers it on its own ("Teach auto mode about your environment?") after auto mode has blocked several actions, which may be why you've seen it before.

**What it reads, according to the docs:**
- **Always:** this project's `CLAUDE.md`, `README.md`, config files and git remotes; your existing auto-mode settings and permission allow-rules; and the hosts, buckets and command names from commands Claude ran in your recent sessions in this project. It never reads your messages.
- **Only if you say yes when it asks:** the first word of each command in your shell history, and the remote hosts and names of the git repos in your home folder.

**What it changes:** nothing unless you approve. It shows you a draft. If you accept, it saves it to `~/.claude/settings.json`, your personal settings file, not the project. If you discard it, nothing is written.

The docs don't say which "config files" it reads. They also don't say where the draft is produced. I assume the model writes it, so what it collects would be processed like the rest of your Claude Code session.

**If you don't want it:**
- Decline the optional scans, or discard the draft.
- To switch off the command and the automatic offer, add `"skillOverrides": { "auto-mode-setup": "off" }` to `~/.claude/settings.json`.
- If you accepted a draft in the past, `claude auto-mode reset` removes it.
- If you do accept one, check it first. If it mentions your live Supabase database, that should be listed as sensitive, so auto mode stays careful with it.

Sources:
- [Configure auto mode – Claude Code Docs](https://code.claude.com/docs/en/auto-mode-config)
- [Choose a permission mode – Claude Code Docs](https://code.claude.com/docs/en/permission-modes)

**You (29 Sep 22:22):**

I dont understand, is claude now gonna take this folder as all of my info or what, cause this is a project for someone else not myself

**Claude (29 Sep 22:23):**

I'll check whether anything from that command has been saved to your personal Claude settings yet, printing only the auto-mode part and none of the file's other values.

**Claude (29 Sep 22:24):**

No, it hasn't collected your personal information. But it did save notes about your client's project into your own settings, and those apply everywhere, which you'll probably want to undo.

I checked your personal Claude settings file (`~/.claude/settings.json`). It now has an auto-mode section written by `/auto-mode-setup`. It's about 25 short notes describing **this project**, for example:
- the trusted code repository is the client's GitHub repository, your client's GitHub;
- the database is the client's Supabase project "OnlinePoker", marked as sensitive;
- the names of the secret settings in `.env`, but not the passwords or keys themselves;
- two extra "be careful" rules: don't reset the database, and don't run the integration tests without a throwaway database.

There's nothing in it about you personally, and no code or passwords. The notes make sense for this project. The problem is where they're saved.

**Why it matters:** that file holds your personal settings, which Claude Code uses in every project you open, not just this folder. In your other projects, auto mode would treat your client's repo as your trusted repo and this poker site as your main work. That can:
- block normal actions in your own projects;
- treat the client's repo as a safe place to send code from any project;
- carry notes about your client's project into all your other work.

**What stays with this folder only:** Claude's memory for this folder is empty, and I haven't saved anything about you or the project there. The prompt file I wrote is inside this project folder.

**What I suggest:**
1. Remove the auto-mode section from your personal settings. I can do it, deleting only that section and leaving the rest of your settings alone, or you can run `claude auto-mode reset` yourself.
2. If `/auto-mode-setup` shows you a new draft, choose **Discard**.
3. If you want to keep the two safety rules, I can put them in a settings file for this folder only, so Claude asks before resetting the database or running the integration tests. That file won't be pushed to your client's GitHub.

Do you want me to do 1 and 3?

**You (29 Sep 22:27):**

can I see the settings myself and if not, if I cant modify them myself then remove anything added today on the auto thing

**Claude (29 Sep 22:27):**

I'll check your Claude Code version, to confirm the in-app settings screen is available, and look for any settings backups that would show what was added today.

**Claude (29 Sep 22:28):**

Yes, you can see and change these settings yourself, so I haven't removed anything.

**To look at them:**
- **Inside Claude Code:** type `/permissions` and open the **Auto mode** tab. Your version (2.1.285) has it. It lists everything auto mode was told.
- **As a file:** press **Win+R**, paste `notepad %USERPROFILE%\.claude\settings.json` and press Enter. Everything inside the `"autoMode": { … }` block came from auto-mode setup. The rest of the file (model, voice and so on) is your normal settings; leave it as it is.

**To remove the auto-mode part:** open a normal PowerShell window (not the Claude Code prompt) and run:

```
claude auto-mode reset
```

It shows what it will remove and asks you to confirm. It deletes only the auto-mode section and leaves your other settings alone. This is safer than editing the file in Notepad, where one missing comma can break the whole file.

**What was added today:** the settings file was last changed today at 22:16, just after you ran `/auto-mode-setup`, so the auto-mode section was almost certainly saved then. The file keeps no history, so I can't prove every line dates from today. Either way, all of it is about this poker project, so removing the whole section is the right fix.

If a "Teach auto mode about your environment?" pop-up or a new draft appears, choose **Don't show again** or **Discard**. If you'd rather I do the removal, just say so and I'll delete only that section.

**You (29 Sep 22:30):**

just remove Ill set it up when I feel like it

**Claude (29 Sep 22:32):**

I've removed the auto-mode section from your personal settings.

- **Removed:** the notes about your client's project, meaning the the client's GitHub repository repo, their Supabase database, the names of the `.env` settings, and the two database safety rules.
- **Not touched:** your other settings (model, effort, voice, notifications and so on). I checked that each one is exactly as it was.
- **Auto mode now:** it's back to its built-in defaults, and I confirmed that with Claude Code's own config check. It still works; it just has no project-specific notes.

If the `/auto-mode-setup` you ran earlier still pops up with a draft, choose **Discard**, or it will write the notes back. When you want to set it up later, run `/auto-mode-setup` again or use the **Auto mode** tab in `/permissions`.

I kept a backup of the old settings file in my temporary folder in case anything needed restoring. It still contains the client's project notes, so tell me if you want it deleted.
