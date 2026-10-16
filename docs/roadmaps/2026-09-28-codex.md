# Codex (GPT-6): recommended work to finish the poker website

**Written:** 29 September 2026. **Author:** Codex, GPT-6. **Status:** engineering recommendations; implementation and external approvals remain outstanding.

This is my own roadmap, separate from [ChatGPT-6-Sol's opinion](chatgpt-6-sol.md). It builds on the findings and executed checks in [BACKEND-SECURITY-AUDIT.md](BACKEND-SECURITY-AUDIT.md), also recorded in [progress.md](progress.md). It incorporates the current README, compliance dossier and earlier security review. Regulatory sources linked below were checked when writing this document. Existing test results are evidence from the earlier review; writing this roadmap did not rerun those tests or fix application code.

The intended product is human multiplayer poker with real money and crypto, planned for Malta. The operating entity, countries from which players will be accepted, settlement currency, payment providers and custody model still need decisions. Recommendations below are proposals for the owner and implementation team to evaluate, not approved business decisions or a certification.

## 1. My recommendation

**Keep the current game as a play-chip product while completing the work below. Real-money launch remains NO-GO.** Fix the reproduced defects first, establish a dependable multiplayer release, and build the financial and eligibility systems against an agreed operating model. Begin regulatory and provider work alongside the engineering fixes because those decisions affect the design.

The existing engine is worth retaining. The review confirmed substantial evaluator, shuffle, pot and privacy testing; authenticated encryption of hidden game state; restricted browser database access; and protections on completed hand history. Replacing that foundation without evidence would add risk. Extend it with explicit financial, security and operational boundaries.

“Highest standard” needs measurable acceptance criteria and continuing operational work. My proposed standard is:

- Every accepted action has a recoverable result; an outage cannot silently lose a player's stake or change an approved interruption policy.
- Every unit of customer money is attributable, reserved correctly, reconciled and recoverable from durable records.
- Players can see their account, transactions, game results, restrictions and withdrawal status accurately.
- Hidden cards stay private; complete legal game transitions can be independently checked; privileged activity leaves evidence outside the actor's control.
- Eligibility, self-exclusion, limits and anti-abuse controls work across devices, tables and server instances.
- Deployment, capacity, backup recovery and incident response are exercised under failure conditions.
- Applicable licensing, technical assessment and independent security work are completed for the actual deployed product.

There are **22 open review findings: 5 Critical, 11 High and 6 Medium**. Some are reproduced bugs; others are absent systems or controls whose operation has not been demonstrated. Closing them requires evidence specific to each finding. A passing test suite or a new encryption setting cannot close all of them.

## 2. The next implementation work, in order

### First: repair the defects already reproduced

These fixes can proceed using disposable fixtures without waiting for a payment-provider decision.

| Work package | What to change | Evidence required before calling it fixed |
| --- | --- | --- |
| Safe request handling and logs — F08 | Apply abuse controls before body parsing; return safe 400/413 responses; log allowlisted error metadata. Strip sensitive headers, cookies, body content and query values from logs. Error messages and stacks can contain input too. | Synthetic password/token markers never appear in captured logs for malformed, oversized or rejected requests. Malformed requests consume the applicable rate allowance. Investigate existing log exposure through a restricted incident process; the review did not establish that real passwords were already leaked. |
| Cash-out integrity — F09 | Require exactly one intended human recipient to be credited. If crediting fails, retain a recoverable payment obligation and roll back seat/state changes. Keep bot accounting explicitly separate. | A zero-row update, changed recipient classification, DB error or retry cannot remove the seat/payment instruction without a corresponding credit. Verify against real Postgres in a disposable environment as well as fault-injected tests. |
| Fair restart behavior — F10 | Implement an explicit interruption policy for active betting clocks, recovery, reconnect and unresolved hands. Reconcile inactivity clocks with action clocks. | A restart with an expired saved deadline cannot immediately fold a player before the approved recovery window. Test rolling restarts, a single stalled table, whole-service downtime and repeated recovery. Disconnections must not grant unlimited extra thinking time. |
| Session and private-event protection — F16/F17 | Give sessions absolute and idle limits, coordinated refresh lifetimes, reuse handling and remote revocation. Enforce revocation/expiry for every private outgoing event and across workers. | Old-token reuse produces the chosen security response; normal tab races are handled deliberately; a year-old fixture cannot outlive the configured absolute limit; revoked sockets receive no further private balances or notices. |
| Browser request and cache boundaries — F18/F19 | Enforce the chosen Origin/CSRF policy on cookie mutations, including guest creation, refresh and logout. Reject unsuitable media types. Add no-store to sensitive responses. | Actual browser tests cover hostile origins and same-site subdomains. Deployed API/CDN responses do not cache tokens or account data. Preserve deliberate, authenticated non-browser integrations. |
| Recoverable commands and readiness — F21 | Persist command identifiers, request binding and outcomes for transfers and other consequential mutations. Separate process liveness from dependency/table readiness. | Retrying an accepted command after losing the acknowledgement returns the original result. Reusing an ID with a different payload is rejected. A broken database or failed table recovery is visible to routing, monitoring and support. |

Use [scripts/security-review.mjs](scripts/security-review.mjs) as reproduction evidence. Its current assertions intentionally demonstrate unsafe behavior; convert the relevant cases into regressions that require safe behavior after each fix. Do not add the unchanged probe as a green security gate.

### Alongside those fixes: make the operating decisions concrete

Produce short, reviewed decisions covering:

1. **Who operates the service:** the B2C operator, any licensed partner, supplier responsibilities, support, finance, security and compliance owners.
2. **Who may play:** approved countries, age rules, verification policy and geographic restrictions. Malta being the planned base does not establish permission in every player market.
3. **What is offered:** initial cash-game rules, stakes, buy-in bounds, table sizes, rake or zero rake, interruptions, complaints and dispute resolution. Treat tournaments as a separate future game system unless deliberately included in scope.
4. **How value is represented:** approved game settlement units, deposit/withdrawal assets and networks, precision, fees, rounding and any permitted conversion arrangements.
5. **Who holds assets:** named contracting entities, banking/payment/custody arrangements, safeguarding, reconciliation, incident and exit responsibilities.
6. **What capacity is promised:** launch regions, simultaneous players/tables/spectators, acceptable latency, maintenance policy and recovery objectives.

MGA lists peer-to-peer poker under Type 3 and publishes B2C application and system-documentation requirements. Obtain the specific licence and responsibility analysis for this business before committing to a production payment architecture. [MGA remote gaming services](https://www.mga.org.mt/licensee-hub/applications/b2c-licences/remote-gaming-services/)

## 3. What “fully playable” should mean for this website

The September 28 progress entry records a successful live two-human hand and cash-out. That establishes a useful scenario, but a finished poker product needs a wider acceptance set. The following are proposed requirements or verification tasks; the review did not reproduce a new bug in every row.

| Player journey | Required behavior and tests |
| --- | --- |
| Register, sign in and recover access | Verified account contact where required; usable recovery; protection against account enumeration and automated attempts; password/passkey changes invalidate the appropriate sessions. Guest/demo identities stay outside money play. |
| Browse and join | Accurate occupancy, stakes, buy-in range, currency and rake. Explain waiting for a second player or the big blind. Concurrent users taking the last seat cannot both succeed. Private tables remain private in errors and listings. |
| Fund a seat | Show available funds separately from money already on tables or reserved for withdrawal. Reject concurrent overspending. Give an explicit accepted, rejected or pending outcome. |
| Act during a hand | Legal buttons and exact call/raise amounts; accessible controls; no double-click duplicate effects; timers synchronized to the server. Client animation cannot determine whether an action was accepted. |
| Disconnect and reconnect | Restore the correct seat, own cards, action result, pot and remaining time. Clearly distinguish reconnecting, waiting, sitting out and a server incident. Never replay an obsolete action automatically. |
| Use multiple devices/tabs | Enforce a defined control policy. A second connection cannot create duplicate seats, duplicate transactions or inconsistent limits. Revoke access consistently. |
| Leave, sit out and close tables | Distinguish leaving the screen from leaving the seat. Explain pending cash-out during a hand. Show the eventual credit and hand result even if the user is in the lobby. Confirm idle closure and all-in eligibility follow the published rules. |
| Rebuy or top up, if offered | Apply only at permitted hand boundaries, reserve funds atomically, respect table maximums and limits, and expose the pending state. Do not let a UI balance directly change a live stack. |
| Read history and raise a dispute | Human-readable hand IDs, stakes, actions, pots, fees and outcomes; private hand replay/export that does not reveal mucked opponents' cards; support reports linked to durable records. Existing cryptographic audit views alone are not the entire support experience. |
| Deposit and withdraw, once approved | Explain asset/network, address or memo, minimums, fees, confirmation status and risk review. Show pending, reserved, paid, rejected and refunded outcomes from the ledger/provider state, with references for support. |
| Use safety controls | Easily find limits, reality checks, breaks, self-exclusion and account history. Successful exclusion immediately prevents new prohibited exposure across sessions. Provide the lawful route to recover remaining funds. |
| Play on mobile and assistive technology | Verify iOS Safari and Android Chrome as well as desktop browsers, touch targets, keyboard navigation, readable cards/amounts, color-independent status, zoom and reduced motion. Test background-tab throttling, orientation changes and poor connections. |
| Understand the business | Accurate rules, fees, currency, privacy, complaints and withdrawal explanations. Publish licence/certification claims only when obtained and applicable to this product. |

For the initial release, I recommend a narrowly defined human cash-game product, with a small approved set of stakes and settlement arrangements. Add tournaments, jackpots, bonus schemes, affiliates or additional variants after the foundations have been accepted; each adds accounting and abuse cases.

### Proposed performance and reliability targets

First collect measurements in the intended deployment region. As an initial engineering proposal, target p95 action acknowledgement within 500 ms and p99 within 1 second for healthy supported regional connections at the declared launch load, measured from submission to durable acceptance. Report network delay separately from server processing. These are proposed targets, not measured current performance or MGA requirements.

Run a documented soak at launch capacity and a burst/reconnect test above it. Include slow clients and spectators. Define an acceptable recovery window before testing. Across all runs, require zero unexplained balance differences, duplicate settlements or unauthorized card disclosures, and no silently stranded tables. Averages alone are insufficient: record worst cases, error rates, queue growth and database lock/pool pressure.

## 4. Build a financial system before enabling redemption

This addresses F01–F03 and the financial parts of F09, F12, F13 and F21.

### Separate demo value from customer liabilities

The current guest and registration paths grant 10,000 play chips by default. Preserve demo play only with an explicit separation that cannot be converted into redeemable value through play, account changes or an admin action. Real-money accounts open with zero cash. Classify existing users and balances before any migration; never silently promote them to cash accounts.

### Establish accounting invariants

- Use an immutable, balanced journal with exact amounts and explicit asset identity. Define available funds, withdrawal reservations, table escrow, operator fees and external settlement/clearing obligations.
- Choose amount limits and precision end to end, including API serialization and UI formatting. Postgres 32-bit integers and JavaScript floating-point arithmetic are insufficient as a general crypto money model.
- Give every deposit, seat funding, settlement, cash-out, withdrawal, fee and reversal a unique durable identity. Bind idempotency to the actor, operation and original request.
- Commit a money movement and its game consequence atomically where possible. Where systems are separate, use durable reservations and messages with explicit recovery; no successful response before its required durable state exists.
- Rebuild balances from the journal and reconcile internal liabilities with external accounts by asset. An entry balancing internally does not prove the external money exists.
- Preserve corrections as attributable reversals/adjustments with appropriate approval. Do not let ordinary support or gameplay credentials edit a wallet total directly.

For example, a buy-in moves value from a player's available account into table escrow; settlement redistributes that escrow under the approved rules; cash-out moves the remaining entitlement back. It creates no new customer value. Payment-provider calls and blockchain confirmations must stay outside a locked poker-hand transaction.

An append-only hash chain may strengthen tamper evidence, but it cannot replace balanced accounting, authorization, reconciliation or protection against deleting the entire tail.

### Implement complete payment lifecycles

Deposits need authenticated callbacks, event deduplication, durable processing, amount/asset/recipient matching, confirmation/finality rules and handling of out-of-order events. Crypto support must explicitly cover reorgs, replacement transactions, wrong networks, unsupported tokens and address/memo attribution. Card/fiat support needs chargebacks, refunds and rejected settlements.

Withdrawals should progress through explicit states such as requested, reserved, under review, approved, dispatched, confirmed and failed/released. Define a separate uncertain state when a provider may have paid but its acknowledgement was lost. Query and reconcile that operation before retrying; blindly releasing its reservation or sending a second payout is unsafe.

Authorize the particular amount, asset and destination, with step-up authentication and policy checks. Protect destination changes and account recovery, enforce limits atomically, and log reviewer decisions. Provide controlled handling of disputed deposits without automatically clawing money out of unrelated players' balances.

### Prefer a qualified custody/provider arrangement for the first release

My recommendation is to evaluate regulated providers that contractually accept the proposed licensed poker business. This reduces the scope of key and payment infrastructure you must operate. It does not eliminate your ledger, reconciliation, eligibility, withdrawal controls or responsibility to players. A familiar brand and easy API are insufficient selection criteria.

Verify the contracting entity, applicable authorization, supported markets/assets/networks, segregation arrangements, subcontractors, security evidence, signed-event and idempotency behavior, withdrawal controls, support, outage handling, insurance exclusions and exit/recovery terms. No provider has been selected by this review. MFSA describes its supervision of crypto-asset service providers under the MiCA framework; obtain advice on the permissions needed for both the provider and the proposed operator activities. [MFSA crypto-assets framework](https://www.mfsa.mt/our-work/crypto-assets/)

Self-custody would additionally require isolated signing, suitable HSM/MPC/multisignature controls, hot-wallet limits, independent approvals, secured backups, recovery exercises and specialist monitoring. Gameplay servers should never hold unrestricted production signing keys.

MGA describes player funds as requiring segregation and separate identification. The application must reconcile those external arrangements to individual liabilities. MGA also requires an approval application for acceptance of DLT assets; confirm the proposed assets and any conversion flow before building them. [MGA player funds](https://www.mga.org.mt/faqs/how-are-player-funds-protected/), [MGA DLT approval](https://www.mga.org.mt/faqs/how-can-licensees-obtain-an-approval-in-order-to-make-use-of-distributed-ledger-technology-dlt/)

## 5. Player eligibility, account security and poker integrity

### Eligibility and responsible gambling — F04/F05

Build a centralized eligibility decision used at registration progression, deposits, seat funding, play and withdrawals as appropriate. It must account for identity/age verification, approved markets, account status, self-exclusion, limits and risk restrictions. Enforce the decision on the server and in the transaction that creates exposure, not only in a frontend check or an old JWT.

Maintain a documented policy for restrictions arriving mid-hand or during a payment. Prevent new prohibited exposure while settling existing obligations under approved rules. Do not implement self-exclusion by locking the player out of all information and remaining-funds access.

MGA's published minimum tools include accessible self-exclusion for a definite or indefinite period, deposit or wagering limits, and reality checks. I recommend both types of limits plus optional loss/session controls where suitable, with approved effective times, cooling-off rules and cross-device enforcement. [MGA responsible-gambling tools](https://www.mga.org.mt/faqs/remote-gaming-are-there-any-mandatory-responsible-gambling-tools-which-must-be-offered-to-players/)

Identity verification needs an operational process for exceptions, false matches and provider failure. Build risk-based AML/CFT monitoring, escalation and recordkeeping with the responsible compliance team; evaluate sanctions/PEP screening, source-of-funds checks and transaction investigations for the agreed policy. MGA describes risk-based obligations for B2C Type 1, 2 and 3 licensees, including an MLRO function. Software alone does not staff that function. [MGA AML/CFT guidance](https://www.mga.org.mt/licensee-hub/compliance/anti-money-laundering/)

### Strong account and privileged access — F07/F12/F16/F17

Add player MFA/passkeys and transaction-specific step-up where appropriate. Require phishing-resistant authentication for privileged access, separate staff identities and granular roles. Account recovery and MFA replacement need controls as strong as login. Add secure password changes, breached-password screening, login abuse detection, active-session views and remote sign-out.

The runtime database login currently has broad access to password hashes, roles and bankrolls despite its useful RLS and history restrictions. Reduce the impact of one compromised credential through separate privileges and invariant-enforcing interfaces for identity, financial and administrative changes. Inspect effective permissions in deployment gates. Adding RLS without restricting what the runtime role can do would not close F12.

Separate support, finance, fraud investigation, deployment and audit export powers. Require attributable reasons and independent approval for sensitive adjustments and exports. Investigators do not need unrestricted live hidden-card access.

### Anti-collusion and automation operations — F06

Detect and investigate multi-accounting, soft play, chip dumping, coordinated play and prohibited automation or real-time assistance. Combine hand patterns with proportionate identity, device and payment linkage. A shared IP or statistical anomaly is a signal for review, not proof sufficient by itself to confiscate money.

Provide reporting, case management, preserved evidence, reviewer access controls and an appeal process. Document false-positive handling and restricted-funds decisions. Keep legacy/demo bots outside cash games and enforce that boundary server-side; the current prohibition on creating new bot tables does not remove all legacy bot paths.

## 6. Complete the game rules and audit guarantees

This addresses F10/F13/F14 and the additional audit, rake, clock and legacy observations.

1. **Publish and version the house rules.** Specify heads-up transitions, blinds/dead button, missed blinds, short all-ins and reopening, uncalled bets, side pots, odd chips, ties, showing/mucking, sit-out, leave, time banks, interruption/voiding and rake. Preserve the version that governed each hand. Implement a rake policy only after deciding its caps, rounding and accounting.
2. **Expand semantic replay.** The current audit verifies important cards and outcomes, but the review resealed a CALL as an illegal CHECK with the same contribution and both verifiers accepted it. Implement complete transition validation: actor, turn, street, legal action, amount, effective stack, raise reopening, status, clocks and result. This finding required altering/rebuilding the record; it did not demonstrate that a normal player could submit that illegal action to the live engine.
3. **Keep independent references.** Outcome validation that shares the engine's evaluator/pot code can share its mistakes. Retain independent reference comparisons and add independent legal-transition verification with adversarial records.
4. **Make incomplete hands durable and explainable.** Record starts, commands, interruption/void decisions and settlement identities. Encrypted table snapshots and process logs alone do not provide an independent financial recovery history.
5. **Protect history against privileged rewriting and rollback.** Retain verifiable checkpoints with an independent witness or suitably controlled immutable storage. Detect missing tails and old valid table ciphertext being restored to the same row. Coordinate game, ledger and provider recovery so a restored backup cannot replay a paid withdrawal or settled hand.
6. **Define the legacy cutover.** The review found 54 older hands without the new audit format. Preserve that provenance and require the new format for the applicable new records. Do not create retrospective claims of pre-deal commitments.
7. **Test clock changes.** Wall-clock jumps, synchronization failure, process suspension and delayed jobs must respect the interruption policy. Use monotonic elapsed timing where appropriate while retaining durable, auditable time information across restarts.

The server knows the deck. A commitment created before dealing can prove consistency with a published value; it does not prove that an insider did not choose a biased deck before publishing it. External anchoring also needs an explicit frequency, availability policy and treatment of hands awaiting a checkpoint. Restrict live access, separate duties and obtain an independent assessment of the actual RNG and deployment.

Update earlier documentation that implies a complete legality replay or unconditional detection of all history deletion. State the actual evidence and trust assumptions, including the need for a retained external chain head. Preserve player privacy: full deck disclosure after a hand would expose mucked cards.

## 7. Encryption, infrastructure and operating the service

### Key management and data protection — F11/F22

Retain authenticated encryption for hidden game data. Add managed key custody, key identifiers, versioned envelopes, controlled rotation, independently protected backup/recovery and an emergency compromise procedure. Separate authentication keys, game/audit encryption and any custody signing. Reject known default/invalid key material, but do not mistake a string-format check for proof of entropy.

Passwords should remain securely hashed. JWT signing is not encryption. Email, IP addresses, user agents and balances are ordinary application database fields today. Document which threats disk encryption, selective field encryption, authorization and retention address; verify provider settings and backups independently. Keys and decrypted cards remain accessible to the authorized runtime, so encryption at rest alone cannot defend against a fully compromised game process.

Create a data inventory and retention schedule covering identity material, payments, sessions, security telemetry, hand histories and backups. Keep unnecessary personal data out of immutable records. Support lawful access, deletion/pseudonymisation and regulated retention through a reviewed policy.

### Deploy reproducibly and close the network boundary — F15

Maintain distinct development, staging and production environments, separate credentials and controlled migrations. Validate schema compatibility and effective database privileges before accepting affected traffic. Rehearse rollback or forward recovery; restoring an old database is not a safe generic rollback for money.

Inspect the real production URL, DNS, certificates, HTTPS/WSS paths, cookie behavior, frontend CSP/framing policy and proxy-to-application transport. API Helmet configuration does not establish browser-page CSP. The trusted proxy must overwrite forwarding headers and be the only permitted origin caller. Reject attempts to reach the app directly with forged forwarded headers. Restrict database/Redis reachability and test certificate validation and rotation.

The repository's development Compose services and a passing direct-TLS unit test do not establish those deployment properties.

### Handle capacity and dependency failures — F20/F21

Use shared rate/admission limits with account, session and network dimensions, bounded expensive work and per-session connection ceilings. Avoid multiplying database authentication work without bounds when broadcasting to many viewers. If caching authorization, define and test the maximum revocation delay.

Prove table ownership and ordering under multiple workers: competing timers, duplicate jobs, delayed messages and an old worker resuming must not settle twice. A Redis adapter distributes socket messages; it is not financial consensus or durable game ownership. Exercise Redis loss, database failover, reconnect storms, slow clients and pool exhaustion.

Separate health, readiness and table integrity. Add graceful drain, visible isolated-table recovery and alerts for aged pending operations. Stopping new deposits or hands during an incident must be distinct from deciding the policy for safe settlement and access to remaining funds.

### Staff and exercise operations — F22

Provide monitored dashboards for action latency, rejected/stale commands, stalled hands, settlement failures, balance differences, withdrawal backlog, authentication abuse, key access and provider failures. Alerts need an owner, response expectation and runbook; no live deck, password or token data belongs in ordinary monitoring.

Set recovery-time and recovery-point objectives by data class. For acknowledged financial operations, design durable records and external reconciliation to prevent silent loss even after restoring an older backup. Run restore exercises including keys, immutable checkpoints and provider state. Explicitly test region loss, unavailable custody, compromised staff access and an uncertain payout.

Use controlled production access, reviewed releases, dependency/secret scanning, an SBOM and artifact provenance. Arrange continuing security review and penetration testing. Map controls to an agreed [OWASP ASVS](https://owasp.org/projects/asvs) scope; a checklist is an engineering verification framework, not automatic certification.

## 8. Complete finding-to-work mapping

All items below remain open at the time of this roadmap. The detailed evidence, source locations and conditional limitations are in the backend audit.

| ID | Severity | Required next work | Closure evidence |
| --- | --- | --- | --- |
| F01 | Critical | Separate demo/promotional/cash balances and identities. | Zero opening cash; demo cannot fund cash seats or redemption; existing balances classified. |
| F02 | Critical | Exact asset model, balanced ledger, escrow and reconciliation. | Reconstructed balances and real-database concurrency/crash tests; no unexplained external reconciliation differences. |
| F03 | Critical | Provider/custody selection and complete deposit/withdrawal state machines. | Approved arrangements plus signed-event, duplicate, reorg, reversal and uncertain-payout tests. |
| F04 | Critical | Identity, age, market and AML eligibility. | Denied users cannot create prohibited exposure through any endpoint/session; exceptions and investigations are operational. |
| F05 | Critical | Self-exclusion, limits, reality checks and restriction propagation. | Concurrent, multi-device and mid-operation tests match approved policies; remaining-funds handling works. |
| F06 | High | Collusion, multi-account and automation detection/investigation. | Documented detection coverage, analyst exercises, evidence access and appeal workflow; legacy bots excluded from cash. |
| F07 | High | Strong account recovery, privileged identity and abuse controls. | MFA/step-up and recovery bypass tests; staff-role separation; login enumeration and abuse mitigated. |
| F08 | High | Safe parser errors, secret-free logs and limiter ordering. | No synthetic secret in logs; malformed/oversized traffic is limited and safely rejected. |
| F09 | High | Enforce cash-out recipient and credit invariants. | Zero-row/failing credit cannot erase payment obligation; retries pay once. |
| F10 | High | Approved interrupted-hand and betting-clock recovery. | Restart and clock-failure scenarios preserve approved player opportunity and settlement. |
| F11 | High | Managed, separated, versioned keys and recovery. | Rotation and restore drills; role/key separation; invalid/default configurations rejected. |
| F12 | High | Narrow runtime identity, finance and administration privileges. | Effective-permission tests prove prohibited role/balance/credential operations fail. |
| F13 | High | Durable lifecycle evidence and rollback/tail protection. | Tampered, missing-tail and old-snapshot restores are detected and safely reconciled. |
| F14 | High | Complete, versioned legal hand replay. | Resealed illegal actions fail; independent reference agrees on legal hands and boundary rules. |
| F15 | High | Validate actual production transport, ingress and browser headers. | External HTTPS/WSS/cookie/header tests and direct-origin spoof tests on the intended deployment. |
| F16 | Medium | Session lifetime, refresh consistency and reuse response. | Absolute/idle expiry and replay handling work without uncontrolled multi-tab failures. |
| F17 | Medium | Revocation of all private socket output across workers. | Revoked/expired sessions receive neither user notifications nor private table data. |
| F18 | Medium | Explicit Origin/CSRF enforcement for cookie mutations. | Cross-origin and same-site browser tests fail safely; legitimate integrations still work. |
| F19 | Medium | No-store for private responses and correct CDN behavior. | Deployed authentication/account/financial responses cannot be served from an inappropriate cache. |
| F20 | Medium | Distributed abuse limits, admission and bounded workloads. | Replica, spectator, slow-client and dependency-failure load tests satisfy declared limits. |
| F21 | Medium | Durable operation receipts and actionable readiness. | Lost acknowledgements recover the original outcome; bad dependencies/tables stop affected admissions and alert. |
| F22 | High | Privacy, retention, incident, access, release and restoration controls. | Owned policies plus completed drills and retained evidence, including database/key/provider recovery together. |

The additional review observations are covered above: legacy audit coverage, private-table authorization, approved game rules, rake, integer overflow, browser token/XSS exposure, commitment timing, bot compatibility, clocks and release provenance. Preserve the protections already verified while adding new features.

## 9. Delivery milestones and launch gates

| Milestone | Deliverable | Proposed accountable roles | Gate to proceed |
| --- | --- | --- | --- |
| A. Immediate repair | Small reviewed changes for logging/parsing, cash-out and restart fairness, followed by session/request/cache defects. | Backend/security lead and game engineer. | Each reproduced defect has a failing-before/passing-after regression and applicable real-database or browser evidence. |
| B. Stable play-chip release | Complete player-journey matrix, durable command behavior, production-like staging, load/recovery measurements and release/migration checks. | Game/frontend leads, QA and operations. | Repeatable multi-human, multi-device and failure tests; known remaining limitations stated. This gate does not authorize money. |
| C. Agreed operating design | Entity/market/game/currency/custody decisions and threat/accounting model. Begin this alongside A. | Owner, legal/compliance, finance and security. | Written responsibility split and approved design inputs for monetary systems. |
| D. Money and eligibility in staging | Ledger, providers in test mode, withdrawals, KYC/AML, responsible-gambling and privileged tools. | Finance/backend, compliance and security. | Financial invariants, restriction races and external-event failures pass with synthetic funds. |
| E. Deployment and recovery assurance | Key lifecycle, restricted privileges, audit witness, production network, monitoring and restoration exercises. | Security/operations and independent reviewers. | Restorable, reconciled state; measured capacity; operational owners demonstrate incident procedures. |
| F. Independent launch assessment | External penetration test; required game/RNG and regulatory system assessments; licensing and provider approvals. | Operator/compliance and qualified external assessors. | Findings closed or formally resolved within applicable requirements; the assessed build/configuration matches the release. |
| G. Controlled launch and continuing review | Approved limits, monitored rollout, staffed support and emergency controls. | Operator, finance, compliance and operations. | Recorded authorization to launch, ongoing reconciliation and escalation; repeat assessment after material changes. |

Agree the exact applicable lab standards and versions with the auditor/regulator. [GLI publishes interactive-gaming standards](https://gaminglabs.com/gli-standards/), and [MGA publishes system documentation/audit materials](https://www.mga.org.mt/licensee-hub/applications/b2c-licences/remote-gaming-services/). Neither reference establishes that this repository or its eventual deployment is certified.

Do not assign a credible launch date from test counts alone. Estimate after milestone C establishes scope and the responsible teams/providers have supplied their dependencies. Existing licensed systems could shorten parts of this work, but their integration and responsibility boundaries still need verification.

## 10. How this compares with the Sol proposal

I agree with Sol's broad sequence: dependable gameplay, deliberate rules, controlled accounting, player protection and external evidence. The new review makes several priorities more concrete:

- **Move the reproduced bugs to the front.** Passwords in parser logs, losing a cash-out obligation on a zero-row credit, and immediate timeout folds after restart need focused fixes before expanding exposure.
- **Start commercial/regulatory decisions in parallel with gameplay repair.** The provider, currency and licence scope materially affect financial design, so they should not wait until all gameplay polish is finished.
- **Treat the existing audit replay as partial.** The reproduced illegal-CHECK record demonstrates a specific missing guarantee; positive outcome tests alone do not close it.
- **Protect recovery beyond completed hashes.** Starts, voids, command receipts, old snapshots and missing tails need a coordinated design with the ledger and external provider records.
- **Use provider custody as a candidate starting point.** Self-custody adds a substantial, separate key-security and operating obligation. Choose only after entity-specific due diligence; no brand is endorsed here.
- **Make acceptance explicit.** Each work package needs evidence, an owner and a launch consequence. “Done,” “encrypted” and “MGA-style” are too broad to establish readiness.

These differences reflect the additional evidence, not a claim that one model's document overrides another. Reassess the recommendations when implementation or operating facts change.

## 11. Practical handoff

My recommended next coding task is **F08: safe parser errors, log redaction and rate-limit ordering**, followed by **F09: cash-out recipient invariants** and **F10: interrupted-hand recovery**. Build each as a reviewable change with meaningful regression evidence. Session revocation/lifetimes, CSRF, private caching and durable command outcomes follow in the same repair programme.

In parallel, create the operating/custody decisions and a disposable staging database with production-equivalent restrictions. Then complete the player-journey acceptance matrix before inviting broad play-chip traffic. Build and assess money features behind explicit disabled-by-default boundaries until all financial, eligibility and launch gates are met.

For each finding, record the implementing revision, tests, staging/deployment evidence, remaining limitations and reviewer. Update [progress.md](progress.md) as work is actually completed. Keep the dated audit as historical evidence and link to its remediation status rather than rewriting reproduced findings as though they never existed.

**Present status:** this document adds a detailed plan. All 22 audit findings remain open; no real-money readiness or certification is claimed.
