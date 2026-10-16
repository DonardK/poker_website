> **Moved.** This was GPT-6.1-SOL-REVIEW.md. Review of 30 September 2026 (SOL-001–SOL-052). Later status: [7 October recheck](../progress/11-october-7-review-recheck.md). Citations use the filenames of that day.

# GPT-6.1-SOL-REVIEW

## 1. Header

- **Date:** 2026-09-30 (Europe/Budapest); review began on 2026-09-29.
- **Reviewer:** GPT-6.1-Sol, the review label requested in the brief; prepared by the Codex agent in this session. This label is not an independently verified model-identity claim.
- **HEAD:** `38be8a79eb44d16be046c3ed9e45cae2cbaaa6a6`.
- **SHA-256 of exact UTF-8 git diff HEAD output:** `f4fc753872628c3fe5cb501f21f93096526f7b4c8df8b140f86ab6c2e5e05315` (unchanged at report generation).
- **Environment:** Windows 11, PowerShell 5.1, Node v24.19.0, npm 11.17.0, installed Chrome and existing workspace node_modules. API fixtures use loopback; existing owner ports 3000/4000 were untouched.
- **Untracked application/docs reviewed at baseline:** `BACKEND-SECURITY-AUDIT.md`, `GPT-6.1-SOL-REVIEW-PROMPT.md`, `apps/server/test/table-lifecycle.test.mjs`, `apps/web/src/components/table-idle-notice.tsx`, `apps/web/src/components/table/idle-close-dialog.tsx`, `apps/web/test/browser/table-lifecycle.spec.ts`, `chatgpt-6-codex.md`, `packages/engine/src/__tests__/table-lifecycle.test.ts`, `scripts/review-database.mjs`, `scripts/security-review.mjs`. `CLAUDE-REVIEW.md` and `review/claude/**` appeared independently during review and were preserved; only the former was partially consulted.
- **Preservation:** 199 pre-existing tracked/untracked file fingerprints match. The initial tree already had 23 tracked modifications; no additional tracked change remains. Next build/browser runs temporarily rewrote `apps/web/next-env.d.ts`; the existing browser teardown restored its original content. No state-changing Git command, live database write, dependency change or application fix was made.

**Scope:** Working-tree engine/shared/server/web production source, migrations/schema/grants, HTTP/socket auth and financial orchestration, browser behavior, docs/claims, configuration/dependencies and launch prerequisites. This is a review with isolated executable evidence and two explicitly read-only live database inspections. Test/helper/dependency and external-infrastructure review is partial as marked in section 12. The latest brief permits only this report and review-owned artifacts, so `progress.md` and existing model reports are preserved despite earlier requests to update them. No assurance of certification, legal compliance or absence of defects is made.

## 2. Executive summary

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

## 3. Findings index

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

## 4. Verification log

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

### Trimmed failure/skip output

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

## 5. Status of earlier findings

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

### September 27 fixes spot-check

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

## 6. Findings

Sorted by real-money severity, then suggested fix order. A missing cash capability is a launch blocker even where it is intentional in today’s demo. CONFIRMED names an executed observation; a related end-to-end impact may remain explicitly code-based. Code excerpts use ellipses for omitted intervening code.

### SOL-001: Cash-outs are discarded even when no recipient is credited

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

### SOL-002: Balances have no balanced, asset-specific financial ledger

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

### SOL-003: Instant chip grants have no hard boundary from future cash balances

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

### SOL-004: No deposit, withdrawal or crypto custody system exists

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

### SOL-005: Identity, age, geography and AML eligibility are not enforced

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

### SOL-006: No responsible-gaming exclusion or limit enforcement exists

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

### SOL-007: Player terms, house rules, privacy and complaints flows are absent

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

### SOL-008: Recovery applies expired turns immediately after downtime

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

### SOL-009: Missing or undecryptable table state blocks every exit path

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

### SOL-010: The next shuffle can roll back completed-hand clean-up and payouts

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

### SOL-011: Database outages are treated as invalid sessions and destroy recovery

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

### SOL-012: Access-token rotation resets the table during live play

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

### SOL-013: Refresh rotation is not coordinated across browser tabs

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

### SOL-014: Legacy bot scheduling can throw after commit and suppress delivery

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

### SOL-015: Restart grace for idle closure is process-local across workers

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

### SOL-016: An active idle warning is not replayed to reconnecting lobby users

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

### SOL-017: Optional sound/storage failures prevent a poker action from being sent

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

### SOL-018: The turn countdown trusts the player’s wall clock

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

### SOL-019: Absent players keep paying future blinds without an explicit policy

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

### SOL-020: Game-integrity controls stop at legal actions and hidden-card isolation

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

### SOL-021: Account security lacks uniform login work and privileged MFA

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

### SOL-022: Malformed request bodies bypass limits and enter error logs

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

### SOL-023: Encrypted state has one unversioned environment key and no rotation path

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

### SOL-024: Runtime database authority includes identity roles and credential hashes

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

### SOL-025: Encryption and operator-held hashes do not prevent valid snapshot replay

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

### SOL-026: Audit verification accepts a re-sealed illegal betting sequence

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

### SOL-027: Operational retention, restoration and financial incident procedures are unproved

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

### SOL-028: Independent RNG, rules, security and production assurance are absent

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

### SOL-029: Real database and multiple-process financial races remain unverified

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

### SOL-030: Proxy TLS trust depends on an unverified network boundary

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

### SOL-031: Refresh sessions have no absolute lifetime or replay-family revocation

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

### SOL-032: Revoked sockets still receive private wallet and idle notifications

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

### SOL-033: Cookie-authenticated mutations have no explicit origin/CSRF validation

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

### SOL-034: Sensitive auth responses have no explicit no-store policy

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

### SOL-035: Abuse limits and fan-out capacity are local and unmeasured

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

### SOL-036: Command IDs are not durable receipts and several commands lack acknowledgements

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

### SOL-037: Health reports success even when gameplay dependencies are unavailable

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

### SOL-038: Wallet updates can overwrite a newer balance with an older one

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

### SOL-039: The Next.js origin supplies no framing or content security policy

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

### SOL-040: Case-sensitive and reserved usernames enable identity confusion

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

### SOL-041: Reduced-motion styling collapses the meaningful turn clock

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

### SOL-042: Call-button text contrast is below WCAG AA for normal text

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

### SOL-043: Turn ownership and remaining time are not announced accessibly

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

### SOL-044: Joining a seat silently chooses the buy-in for the player

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

### SOL-045: A fresh closed-table visit cannot reach its participant audit in the UI

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

### SOL-046: Production cookie policy requires a same-site deployment that is not enforced

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

### SOL-047: Startup accepts unusable bankroll, timer and JWT lifetime settings

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

### SOL-048: Play chips are labeled as dollars without clear nonredeemable disclosure

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

### SOL-049: Decimal bet input remains enabled and sends a rejected amount

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

### SOL-050: Unique-account races and small guest suffix collisions surface as 500

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

### SOL-051: Metadata and tooling guidance advertise outdated product/deployment behavior

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

### SOL-052: Shared odd-chip contract comment names the wrong starting position

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


## 7. Decisions needed from the owner

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

## 8. Legal and regulatory exposure register

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
| Open-source obligations | 237 production lock entries; LGPL-bearing native package; 8 unknown manifests | Verify with counsel: distribution/linkage notices, source/relocation obligations where applicable and complete deployment SBOM. UNKNOWN does not mean unlicensed. | Local [license inventory](review/gpt-6.1-sol/production-licenses.json), installed package manifests/LICENSE evidence; no legal clearance performed. |

## 9. Claims check

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

### Encryption inventory

| Surface | What is implemented | Remaining limit |
|---|---|---|
| Live table state | AES-256-GCM, random 96-bit nonce, authenticated table context | One environment key/no key ID; valid snapshot replay and restoration controls unresolved. |
| Sealed deck/audit and hole-card storage | AES-GCM with row/hand-bound context; live card aggregates encrypted, no plaintext arrays | Keys/operator privileged paths still see plaintext; 54 legacy hands lack full new audit. |
| Passwords | bcrypt cost 12 and byte-length bounds | Hashing is appropriate, not reversible encryption; hash read scope/MFA/recovery gaps. |
| Refresh tokens | SHA-256 stored hash, rotating HttpOnly cookie, production Secure/Strict | Multi-tab/session-family/absolute TTL/origin issues. |
| Access JWT | Signed, explicit algorithm verification, in-memory browser state | Payload readable to holder; no refresh token in localStorage; rotation interrupts socket. |
| API/socket/DB/Redis transit | Production TLS guards; actual inspected DB TLS1.3; Redis rediss guard | Development HTTP; proxy network boundary/web edge and deployed Redis not verified. |
| Profile, balance, seats, session metadata, public audit | Ordinary database fields; public audit deliberately redacted | Provider disk encryption, backup encryption/access and retention not proved by application encryption. |

## 10. Verified correct (do not “fix”)

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

### Every pre-read lead disposition

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

### Named rules comparison and house variants

Compared the betting/position/settlement mechanisms with [Poker TDA 2026 rules v1.0, 7 September 2026](https://www.pokertda.com/view-poker-tda-rules/) (checked 2026-09-30): cumulative short all-ins reopening, heads-up order, dead button and odd chips left of button. TDA governs tournaments; this repository is cash-style no-limit play. This comparison does **not** assert complete 2026 TDA compliance, including newer seating-maximization/tournament procedures.

Owner-approved house decisions: wait-for-big-blind rather than optional posted entry, dead button/short-blind handling, automatic show of live showdown hands versus muck choices, retaining all-in and sole pot eligibility during leave/closure, no free fold when check is available, fixed time bank, no rake, and forced idle settlement. Publish these with disconnection/restart policy. A 15-second realtime turn is not automatically a WCAG timing violation; WCAG has realtime exceptions, while accessible status still matters. [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

## 11. Fix plan for Claude

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

## 12. Coverage ledger

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


## 13. Open questions and residual risk

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

## 14. Appendix

### Safe reproduction

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

### Artifacts

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

### Invariant outcomes

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

### End-of-review Git status and preservation

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

