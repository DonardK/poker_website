# Review brief for GPT-6.1-Sol: find every defect in the Hold'em Live poker platform

Prepared by Claude (Anthropic) on 29 September 2026 at the project owner's request. Claude will implement the fixes after you finish, working from your report.

You are **GPT-6.1-Sol**, the lead reviewer for this repository. Review it the way a combined team would: a principal engineer, an application-security tester, a poker game-integrity specialist, a payments and ledger engineer, an SRE, a QA lead, an accessibility specialist and a compliance-risk analyst (not a lawyer).

**Your deliverable is one Markdown file, `GPT-6.1-SOL-REVIEW.md`, in the repository root.** It must list every defect you find, precisely enough that Claude can locate, reproduce and fix each one without repeating your investigation. You are reviewing, not fixing: do not change the application.

---

## 1. Why this matters

The owner intends to run this as an online poker site for real players around the world, and later with real money (fiat and crypto; Malta/MGA Type 3 licensing is planned). A defect here can take a player's money, reveal their cards, let someone cheat, lose a hand's result, lock a player out of their funds, leak personal data, or put a claim on screen the site can't back up. Any of those can mean player losses, regulatory action or lawsuits. The owner wants the highest standard: hunt for everything, from the poker rules to the database, sockets, browser, deployment and the words on the screen.

Assume adversarial users: modified clients, scripted sockets, many accounts, colluding players, hostile websites in the same browser, and network attackers. Also assume honest users with slow or flaky connections, several tabs, phones, screen readers and high latency from other continents.

Be realistic in the report. No review can prove the absence of defects, and real-money operation also needs licensing, independent certification (RNG/game, penetration test) and legal advice. State the residual risk. Never call the product "safe", "compliant" or "certified".

## 2. The system

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

## 3. Hard rules

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

## 4. Baseline checks

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

## 5. What to review: everything

Cover every area below. The questions are starting points, not limits.

### 5.1 Poker rules and engine correctness (`packages/engine`, `packages/shared`)

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

### 5.2 Server orchestration (`apps/server/src/game`, `apps/server/src/index.ts`)

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

### 5.3 Realtime layer (`apps/server/src/socket`, `apps/web/src/lib/socket.ts`, `apps/web/src/hooks`)

- **Commands:** handshake authentication, per-packet re-authentication, rate limits (per socket, and per user across tabs), payload schemas, acknowledgements (which commands have none?), error scoping, rooms, private-table access and spectators.
- **Long sessions:** the socket keeps its handshake access token, which lasts 15 minutes, while the client refreshes every 10 minutes. Trace what the server does when that token expires and what the client does on each refresh (a new socket, a reset of the table store). Look for lost actions, flicker, missed turns and duplicate joins.
- **Session revocation:** revoked or expired sessions and private notifications (F17), and transient database errors during re-authentication.
- **Multiple connections:** multi-tab and multi-device use of one account, reconnect and rehydrate, and snapshots that arrive out of order or twice.
- **Players worldwide:** high latency and packet loss against a 15-second clock, how the client countdown relates to the server deadline, and time zones and number formatting in anything displayed.

### 5.4 HTTP API, authentication and sessions (`apps/server/src/app.ts`, `auth/*`, `routes/*`)

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

### 5.5 Data layer (`apps/server/prisma`, `supabase/`)

- Compare the Prisma schema, the Prisma migrations and the Supabase copies. Look for drift, missing constraints, 32-bit integer limits, indexes, cascade deletes that conflict with append-only history, RLS and role grants (F12), and seed data.
- Which invariants should the database enforce that it does not?
- Optional read-only live checks (section 3 applies): look for seats at CLOSED tables, stacks with no table state, negative or implausible balances, tables stuck `IN_HAND`, and hands without audits after the cutover.

### 5.6 Cryptography, fairness claims and privacy

- AES-GCM usage, AAD contexts, key handling and validation (F11), refresh-token hashing and JWT options.
- Try to break the leak guard (`public.ts`, `isolation.ts`) with log text, usernames or table names that look like cards, error messages, audit payloads and bot views.
- Check browser-side storage. Hole-card digests in `sessionStorage` are recoverable by design; what else is stored?
- Check every fairness and security claim in `README.md`, `COMPLIANCE.md`, `SECURITY-REVIEW.md`, UI copy and code comments. Is each true, overstated or false?

### 5.7 Web client (`apps/web`)

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

### 5.8 Configuration, deployment and operations

- Production guards in `config.ts`, TLS and proxy handling (F15), Redis, logging and redaction (F08), health versus readiness (F21), and graceful shutdown.
- Database connection-pool limits against 20-second table transactions, and the CPU cost of Monte Carlo bots.
- `apps/web/next.config.ts`, `docker-compose.yml` and `.env.example`.
- Secrets in tracked files and in git history (read-only search), dependency vulnerabilities and licenses, and reproducible builds.

### 5.9 Tests and tooling

- Do the tests assert the right things? Look for tests that encode a bug as expected behavior, are tautological, depend on timing, or would still pass with the feature broken.
- Missing coverage: real-Postgres concurrency, several server processes, a restart mid-hand, token expiry mid-session, and mobile and accessibility automation.

### 5.10 Legal, regulatory and consumer-protection exposure

Flag items for counsel; give no legal conclusions.

- **Missing player-facing documents and flows:** terms of service, house rules, a privacy notice, a cookie and storage notice, a complaints and dispute process, responsible-gaming information and age confirmation (guests play instantly). Real money would also need identity and age verification and geographic restriction.
- **GDPR and Maltese data protection:** the data collected (email, IP, user agent, gameplay), retention, lawful basis, data-subject rights and logs.
- **Misleading or unverifiable claims:** fairness, security, encryption, certification, references to MGA or GLI, currency symbols on play chips, and disclosure of bots or AI.
- **Fairness to players:** forced closures, time-outs, interrupted hands and the disconnection policy. Are the rules published, and applied consistently?
- **Other obligations:** accessibility (for example the European Accessibility Act) and open-source licenses.
- **Real money:** confirm the status of F01–F05 and add anything they miss. Cite the sources you checked, with dates, and mark each item "verify with counsel".

## 6. Invariants to test

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

## 7. How to work

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

## 8. Report format: `GPT-6.1-SOL-REVIEW.md`

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

## 9. Quality bar

- **Locations:** every finding cites an exact `file:line` in the current working tree, as a path relative to the repository root with forward slashes. A missing-capability item cites where the control would have to be enforced.
- **Precision:** merge duplicates and give each finding one root cause. Do not under-report either: a hundred real small defects are worth listing.
- **Separation:** keep bugs, rule choices and missing features apart.
- **Protections:** never propose weakening an existing protection: the leak guard, audit sealing, row locks, revision checks, TLS guards or append-only history.
- **IDs:** keep them stable (`SOL-001`, `SOL-002`, …). Claude will reference them in commits.
- **Audience:** write for an engineer who has the repository but not your context: self-contained and specific.
- **Running out of time:** if you run out of time or context, finish the report with what you have, mark unreviewed areas NOT REVIEWED in the ledger, and say so in the executive summary. An honest partial report beats a padded complete one.

## 10. Leads from Claude's pre-read: verify or refute each

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

## 11. When you finish

- `git status --porcelain` must show no modified tracked files, only your new ones (apart from any side effects you recorded under rule 1). Include that output in the report.
- Reply with the report path, counts by severity, the top five issues in one line each, and anything you could not verify.
