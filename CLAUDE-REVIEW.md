# Claude review: defects in the Hold'em Live poker platform

- **Date:** 30 September 2026 (started 29 September, 23:50 CEST)
- **Reviewer:** Claude (Anthropic), in Claude Code, following the brief in `GPT-6.1-SOL-REVIEW-PROMPT.md`
- **Code reviewed:** HEAD `38be8a79eb44d16be046c3ed9e45cae2cbaaa6a6` plus the uncommitted working tree
  - SHA-256 of `git diff HEAD`: `f4fc753872628c3fe5cb501f21f93096526f7b4c8df8b140f86ab6c2e5e05315`
  - Untracked source reviewed: `apps/server/test/table-lifecycle.test.mjs`, `apps/web/src/components/table-idle-notice.tsx`, `apps/web/src/components/table/idle-close-dialog.tsx`, `apps/web/test/browser/table-lifecycle.spec.ts`, `packages/engine/src/__tests__/table-lifecycle.test.ts`, `scripts/review-database.mjs`, `scripts/security-review.mjs`
  - No source file changed after `BACKEND-SECURITY-AUDIT.md` was written.
- **Environment:** Windows 11, Node 24.19.0, npm 11.17.0. Docker is not installed, so no disposable Postgres was available.
- **Scope:** every production file in the engine, the shared package, the server, the web app, the Prisma schema and migrations (and their Supabase copies), plus configuration, documentation claims, tests, dependencies and git history.

GPT-6.1-Sol reviewed the same repository at the same time, through Codex, writing under `review/gpt-6.1-sol/`. While it ran, I avoided rebuilding shared build output and using the fixed browser-test ports.

**Update, 30 September, after GPT-6.1-Sol finished:**
- I ran the checks I had skipped: the production build passes, and the browser suite passes 56 of 56.
- I read `GPT-6.1-SOL-REVIEW.md` in full and re-ran its repro scripts myself.
- The 10 of its findings that were new to me reproduced on my runs; they are CR-032 to CR-041. CR-007 was widened and raised to S1.
- Section 1b compares the two reviews.

This is an engineering review, not a certification, a penetration test or legal advice. No review can prove that defects are absent.

---

## 1. Executive summary

**The poker engine is in good shape.** A randomized lifecycle fuzz covered 28,273 hands and 277,666 events: joins, leaves, sit-outs, time-outs, idle warnings and closures. It ran through the server's own audit verification, the participant-audit redaction guard and the browser's card verification. There were zero failures: chips were always conserved, no hidden card leaked, and there were no false alarms. Existing checks pass:
- 450 of 451 engine tests (the one failure is a documented-rate statistical false alarm; three reruns passed);
- 65 of 65 server tests and 4 of 4 typechecks;
- 56 of 56 browser tests, on desktop and phone layouts;
- the production build;
- an evaluator check of all 2,598,960 five-card hands.

**The defects are around the engine: player fairness, sessions and connections, money UX, and legal and operational gaps.**

| Verdict | Decision |
| --- | --- |
| Public play-chip launch | **Not yet.** First fix the S1/S2 items that take chips or turns from players (CR-002 to CR-009, CR-032 to CR-035), the earlier F08, F09, F10 and F16–F19, and publish basic terms, privacy and rules with an age confirmation (CR-001). |
| Real money | **NO-GO, unchanged.** F01–F05 (ledger, payments, KYC/age/geo, AML, responsible gaming) are all still open, plus the items above. |

**New findings: 41.** 31 are from my review; 10 are from GPT-6.1-Sol, adopted only after I re-ran them. By severity: 1 S0, 4 S1, 14 S2, 18 S3, 4 S4. By confidence: 33 confirmed (an executed repro, or unambiguous code or inventory), 8 likely. All 22 earlier findings (F01–F22) are **still open**; eleven were re-reproduced today with the earlier probe script.

**Fix first:**

1. **CR-007:** a brief database hiccup deletes the player's login cookie, which is a permanent sign-out (a guest loses the account for good). It also drops every connected player with "Please sign in again", and the browser never reconnects.
2. **CR-003 and CR-035:** the turn countdown uses the player's own device clock (10 s slow shows 25 s while the server folds at 15 s). With the reduced-motion setting on, the clock shows empty as soon as the turn starts.
3. **CR-002:** a disconnected or absent player is dealt in, posts blinds and times out every hand, forever.
4. **CR-032:** if the browser blocks site storage, clicking any action freezes the action buttons and nothing is sent.
5. **F08** (earlier audit): passwords from malformed requests land in error logs.
6. **CR-004 and CR-033:** a table that cannot load or settle traps its players' chips, and a failed next deal rolls back the previous hand's payouts.
7. **CR-005 and CR-006:** every 10-minute token refresh blanks the table view mid-hand, and two tabs refreshing together sign one out.
8. **CR-008:** valid actions are refused as "The table changed" when anyone else sits in or out, joins or leaves.
9. **CR-009:** "Sit here" buys in immediately, up to the player's whole bankroll, with no amount shown or chosen.
10. **F10 and F09** (earlier audit): a restart folds the waiting player at once; a zero-row credit loses a cash-out.

---

## 1b. Comparison with GPT-6.1-Sol's review

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

## 2. Findings index

| ID | Sev (real money) | Category | Confidence | Fix type | Primary location | Title |
| --- | --- | --- | --- | --- | --- | --- |
| CR-001 | S0 | LEGAL-EXPOSURE | CONFIRMED | NEEDS-DECISION + EXTERNAL | `apps/web/src/app/` | No terms, privacy notice, rules or age gate; guests play instantly |
| CR-002 | S1 | RULES/MONEY | CONFIRMED | NEEDS-DECISION + CODE-NOW | `apps/server/src/game/manager.ts:49` | Absent players are blinded off indefinitely |
| CR-003 | S1 | FAIRNESS | CONFIRMED | CODE-NOW | `apps/web/src/components/table/seat-hud.tsx:42` | Turn countdown uses the viewer's device clock |
| CR-004 | S1 | RELIABILITY/MONEY | CONFIRMED | CODE-NOW + NEEDS-DECISION | `apps/server/src/game/manager.ts:66` | A table that cannot load or settle traps chips; no recovery; endless retries |
| CR-007 | S1 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/server/src/auth/routes.ts:178` | A transient DB error is treated as sign-out: login cookie deleted, sockets dropped without reconnecting |
| CR-005 | S2 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/web/src/hooks/use-table-socket.ts:28` | Every token refresh tears down the socket and resets the table view |
| CR-006 | S2 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/web/src/components/auth-hydrator.tsx:36` | Two tabs refreshing together sign one tab out |
| CR-008 | S2 | FAIRNESS | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:152` | Valid actions refused as stale after unrelated table changes |
| CR-009 | S2 | MONEY/UX | CONFIRMED | CODE-NOW + NEEDS-DECISION | `apps/web/src/app/table/[id]/page.tsx:59` | One click buys in with an unchosen amount, up to the whole bankroll |
| CR-010 | S2 | LEGAL-EXPOSURE | CONFIRMED | NEEDS-DECISION + CODE-NOW | ~20 UI and engine strings | Play chips shown as dollars |
| CR-011 | S2 | SECURITY | CONFIRMED | CODE-NOW | `apps/web/next.config.ts` | No CSP, framing or other security headers on the web app |
| CR-012 | S2 | CONFIG | LIKELY | NEEDS-DECISION + CODE-NOW | `apps/server/src/auth/routes.ts:40` | Sessions break unless web and API share a "site"; undocumented |
| CR-013 | S2 | SECURITY | LIKELY | CODE-NOW (migration) | `apps/server/prisma/schema.prisma:67` | Usernames allow impersonation (case, reserved names) |
| CR-014 | S2 | A11Y | LIKELY | CODE-NOW | `apps/web/src/components/table/action-bar.tsx:80` | No accessible turn announcement or timer text |
| CR-015 | S2 | SCALE | LIKELY | CODE-NOW + NEEDS-DECISION | `apps/server/src/app.ts:42` | IP-only limits and 5-second lobby polling will lock out shared-IP players |
| CR-032 | S2 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/web/src/components/table/action-bar.tsx:57` | Blocked browser storage or audio freezes the action buttons; nothing is sent |
| CR-033 | S2 | RELIABILITY/MONEY | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:320` | A failed next deal rolls back the previous hand's clean-up and payouts |
| CR-034 | S2 | FAIRNESS | CONFIRMED | CODE-NOW | `apps/server/src/socket/index.ts:120` | An active idle warning is not re-sent after a reconnect or reload |
| CR-035 | S2 | A11Y/FAIRNESS | CONFIRMED | CODE-NOW | `apps/web/src/app/globals.css:222` | With reduced motion on, the turn clock shows empty immediately |
| CR-016 | S3 | UX | CONFIRMED | CODE-NOW | `apps/server/src/auth/routes.ts:89` | Unique-key races return HTTP 500 |
| CR-017 | S3 | UX | CONFIRMED | CODE-NOW | `apps/server/src/socket/index.ts:129` | Seat and sit commands have no acknowledgement; success can report failure |
| CR-018 | S3 | SECURITY | LIKELY | CODE-NOW + NEEDS-DECISION | `apps/server/src/routes/tables.ts:22` | Table names are unmoderated free text |
| CR-019 | S3 | UX | CONFIRMED | CODE-NOW | `apps/web/src/components/table/action-bar.tsx:126` | Decimal bet amounts give a generic error |
| CR-020 | S3 | DOCS-CLAIMS | CONFIRMED | CODE-NOW | `apps/web/src/app/layout.tsx:19` | Metadata still promises "autonomous AI opponents" |
| CR-021 | S3 | DOCS-CLAIMS | CONFIRMED | CODE-NOW | `apps/web/src/app/table/[id]/page.tsx:230` | "Cards verified" label overstates the check |
| CR-022 | S3 | RULES | CONFIRMED | NEEDS-DECISION | `packages/engine/src/table.ts:1003` | Every live hand is shown at showdown; no mucking |
| CR-023 | S3 | SECURITY | LIKELY | CODE-NOW | `apps/web/src/app/page.tsx:77` | Sign-out fails if the server is unreachable |
| CR-024 | S3 | UX/A11Y | LIKELY | CODE-NOW | `apps/web/src/lib/sounds.ts:14` | Turn sounds can stay silent after a reload |
| CR-025 | S3 | A11Y | CONFIRMED | CODE-NOW | `apps/web/src/components/table/action-bar.tsx:103` | Text contrast fails WCAG AA (Call button measured 3.19:1) |
| CR-026 | S3 | UX | CONFIRMED | CODE-NOW + NEEDS-DECISION | `apps/server/src/auth/routes.ts:130` | Guest accounts are unrecoverable and guests are not told |
| CR-027 | S3 | PERF | LIKELY | NEEDS-DECISION | `apps/server/src/game/manager.ts:337` | Legacy bot decisions block the event loop |
| CR-031 | S3 | TEST-GAP | CONFIRMED | CODE-NOW | `packages/engine/src/__tests__/rng.test.ts:648` | The 1M-shuffle suite can fail on a healthy RNG; no procedure for it |
| CR-036 | S3 | RELIABILITY | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:182` | A bot-scheduling error after commit reports failure, skips notifications and stalls the table |
| CR-037 | S3 | CONCURRENCY | CONFIRMED | NEEDS-DECISION | `apps/server/src/game/manager.ts:357` | Restart grace for idle closure is per process (inconsistent with several servers) |
| CR-038 | S3 | UX | CONFIRMED | CODE-NOW | `apps/server/src/game/manager.ts:245` | Balance display can go backwards (wallet updates are unordered) |
| CR-039 | S3 | UX | CONFIRMED | CODE-NOW | `apps/web/src/components/table/idle-close-dialog.tsx:346` | Opening a closed table fresh loses the "Verify hand" control |
| CR-040 | S3 | CONFIG | CONFIRMED | CODE-NOW | `apps/server/src/config.ts:23` | Startup accepts unusable bankroll, timer and token-lifetime values |
| CR-028 | S4 | DOCS | CONFIRMED | CODE-NOW | `packages/shared/src/events.ts:16` | Dead socket contracts |
| CR-029 | S4 | UX | CONFIRMED | CODE-NOW | several | UI polish bundle |
| CR-030 | S4 | LEGAL-EXPOSURE | CONFIRMED | CODE-NOW | `package.json` files | Missing third-party notices and own licence statements |
| CR-041 | S4 | DOCS | CONFIRMED | CODE-NOW | `packages/shared/src/poker.ts:33` | Odd-chip type comment names the wrong starting seat |

---

## 3. Verification log

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

---

## 4. Status of earlier findings (BACKEND-SECURITY-AUDIT.md, 29 September)

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

---

## 5. Findings

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

---

## 6. Decisions needed from the owner

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

---

## 7. Legal and regulatory exposure register

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

---

## 8. Claims check

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

## 9. Verified correct (do not "fix")

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

---

## 10. Fix plan for Claude

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

---

## 11. Coverage ledger

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

---

## 12. Open questions and residual risk

- **Run after GPT-6.1-Sol finished:** the production build and the Playwright browser suite (56/56) both pass.
- **Not tested at all:**
  - real-Postgres concurrency (no Docker): the seat, create and cash-out races are reasoned about only;
  - multi-instance deployment: timers are per process, and a restart of one instance clears idle warnings cluster-wide;
  - the real production deployment (F15).
- **Accessibility** was not measured with tools (CR-025). **Clock behaviour** under real clock jumps was not exercised (F10).
- **RNG:** a statistical test cannot prove randomness. Accredited lab evaluation of the deployed RNG and game is still required.
- **Legal questions for counsel:** L1–L10.

---

## 13. Appendix: repro scripts

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
