# Backend security and real-money readiness review

Review date: 29 September 2026. Target: Malta, real-money and crypto poker. Custody model and player countries remain undecided.

## Decision

**NO-GO for accepting deposits, holding customer crypto, or making game chips redeemable.** The project is a well-tested play-chip poker implementation with meaningful cryptographic protections. It does not yet implement the financial, player-protection, identity, fraud, or operational controls needed for the requested business. Several concrete security and reliability defects also remain.

This is an engineering review of the current working tree and read-only checks of the linked OnlinePoker database. It is not an MGA system audit, a penetration-test certificate, a laboratory RNG certification, or a legal determination of the proposed business. Passing the existing tests does not establish readiness for real money.

Severity below is assessed against the requested real-money use. An absent payment subsystem is a launch blocker, not evidence that an existing payment system was exploited. Conditional findings state the conditions explicitly. No production balances, accounts, game records, roles, or schema were changed. Application source was left unchanged; the additions are this report and two verification scripts. Pre-existing workspace edits were preserved.

The review records **22 findings and readiness gaps: 5 Critical, 11 High, 6 Medium**. These counts include missing capabilities and unverified operational controls, as well as reproduced defects; they are not a count of independently exploitable vulnerabilities.

## Verification performed

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

## Encryption: what is and is not protected

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

## Findings and required remediation

### F01 — Critical: free play chips must never become redeemable balances

Evidence: `apps/server/src/auth/routes.ts:76` and `:130`; `apps/server/src/config.ts:25`; `apps/server/prisma/schema.prisma:73`.

Registration and unauthenticated guest creation each credit `DEFAULT_STARTING_BANKROLL` into the same balance used for table buy-ins and cash-outs. The default is 10,000. The environment schema requires a positive starting bankroll, so setting it to zero does not even disable issuance cleanly. The probe received HTTP 201 and 10,000 chips from `/api/auth/guest`.

This is intentional play-chip behavior today. Connecting redemption to that balance would allow new accounts to create redeemable value, including value transferred through play. Rate limiting does not make issuance financially safe.

Required: independently separate demo, promotional and cash balances; use a zero cash opening balance; credit cash only through a verified, uniquely identified ledger event. Guest/demo identities must not access cash games. Reconcile and explicitly classify every pre-launch balance and test account before enabling money. Never convert this database's existing play balances to cash automatically.

### F02 — Critical: no financial ledger, asset model or reconciliation

Evidence: `schema.prisma:64`, `:125`, `:142`; `game/manager.ts:165`, `:221`; `routes/tables.ts:181`.

Money is represented by mutable `User.bankroll` and seat stacks. Transactions help avoid partial updates, but there is no immutable double-entry ledger, account hierarchy, currency/chain/asset identity, reserved balance, source transaction, reconciliation process or independently auditable wallet history. Buy-ins and cash-outs are outside the hand hash chain. Postgres `Int` is a signed 32-bit value; it is not a general representation of crypto atomic units. Currency units and conversion/rounding rules are undefined.

Required: model each supported asset explicitly and choose bounded exact integer/decimal units; never use floating-point money or cross a JavaScript safe-integer boundary. Establish immutable balanced journals, unique operation IDs, table escrow, available/reserved accounts, reversals, fee accounts and reconciliation against both player liabilities and external assets. Decide whether games settle in EUR or crypto units. Integrate escrow movements and hand settlement atomically, or through a rigorously idempotent protocol with durable recovery.

Acceptance: concurrent buys/withdrawals cannot overspend; every debit has an equal credit for the same asset; retries cannot post twice; crash/restart and external duplicate callbacks converge to one result. Reconstruct every balance from the ledger and explain every reconciliation difference.

### F03 — Critical: fiat/crypto deposit, withdrawal and custody controls are absent

Evidence: complete server route inventory in `app.ts`, schema and server dependencies. No deposit, withdrawal, provider webhook, blockchain observer, wallet or custody implementation exists.

Required before launch: select the legal entity, provider/custody contract, supported assets/chains and settlement currency. Implement authenticated provider callbacks, replay protection, unique provider-event identities, out-of-order processing and a durable inbox/outbox. Define confirmation/finality and chain-reorganisation policies, address attribution, unsupported token/chain handling, fees, conversion quotes and reconciliation. A deposit seen in a mempool must not automatically become withdrawable value.

Withdrawals require reservation before dispatch, transaction-specific authorization, AML/risk holds, address verification, limits, approval rules, idempotent dispatch and recovery from an uncertain provider response. A timeout must not cause a second payout. Card chargebacks, refunds and rejected transfers need explicit states and ledger entries. Use hosted payment collection if taking cards; do not add card-number storage to this backend.

For self-custody, isolate signing from gameplay, use an appropriate HSM/MPC/multisignature design, hot-wallet exposure limits, dual control, recovery ceremonies and independently tested incident procedures. No crypto signing secret should share this game's `.env` or server process.

### F04 — Critical: identity, eligibility and AML gates are missing

Evidence: `schema.prisma:64`; `auth/routes.ts`; `auth/middleware.ts:6`; `routes/tables.ts`; `socket/index.ts`.

A session and `kind === HUMAN` establish gameplay access. There is no verified identity, age, residence/market eligibility, email-verification state, sanctions/PEP screening, source-of-funds workflow, restricted-account state or compliance case record. Guests can play. There is no authoritative account suspension/exclusion gate at seat claim or hand start.

Required: a backend-enforced eligibility state machine integrated with identity and screening providers, reviewer decisions, revocation, restricted-market rules, AML monitoring and auditable case handling. Gate deposits, cash games and withdrawals according to the approved policy. Restrictions must affect existing sockets and concurrent transactions, while preserving lawful access to funds. An MGA licence must not be assumed to authorize every country where a player may connect. Malta is confirmed as the intended base/market; the complete target-market list is unresolved.

MGA describes risk-based AML/CFT controls for B2C Type 1, 2 and 3 licensees. Exact obligations and timing need the licensed operator's compliance policy. [MGA AML guidance](https://www.mga.org.mt/licensee-hub/compliance/anti-money-laundering/)

### F05 — Critical: responsible-gaming enforcement is absent

Evidence: no self-exclusion, deposit/wagering-limit, reality-check or responsible-gaming models/routes in the backend; `auth/middleware.ts`, table creation and seat/action paths do not check them.

Required: persist self-exclusion and applicable brand/identity scope; prevent circumvention by a replacement account; enforce the approved limits atomically across sessions and workers; support cooling-off rules, history, notices and monitoring. Recheck eligibility at the points where new exposure is taken. A five-minute idle table closure is not a responsible-gaming limit. Excluded players still need an appropriate route to withdraw their funds.

MGA guidance calls for self-exclusion, deposit or wagering limits and reality checks. Its 2026 thematic review also identifies implementation failures such as delayed exclusions and duplicate-identity gaps. [Required tools](https://www.mga.org.mt/faqs/remote-gaming-are-there-any-mandatory-responsible-gambling-tools-which-must-be-offered-to-players/), [player protection](https://www.mga.org.mt/licensee-hub/compliance/player-protection/), [2026 thematic review](https://www.mga.org.mt/the-mga-publishes-findings-from-thematic-review-on-self-exclusion-practices-in-the-online-gaming-sector/)

### F06 — High: no anti-collusion, multi-account or automation operations

Evidence: the server authenticates accounts individually; no device/account relationship, collusion, chip-dumping, real-time assistance or investigation subsystem was found. New tables reject built-in bots, but legacy bots still run through `game/manager.ts:336`.

Correct shuffling cannot prevent coordinated players from sharing cards externally, chip dumping, controlled opposing accounts or automated play. The one-seat-per-user constraint does not identify one-person-with-many-users behavior.

Required: identity/device/payment linkage appropriate to privacy law, table-sharing and transfer-pattern analysis, behavioral alerts, review tooling, investigation evidence and an appeal process. Separate all legacy/demo bots and test accounts from the licensed cash environment; require explicit rules for any automated participant. Avoid presenting probabilistic fraud signals as proof on their own.

### F07 — High: player and administrator authentication is below the target assurance

Evidence: `auth/routes.ts:108`; `routes/admin.ts:37`; `schema.prisma:64`.

ADMIN access is the ordinary password/session flow plus a database role check. There is no MFA/passkey requirement, recent reauthentication, dedicated privileged identity, password-change/recovery workflow, session inventory or remote sign-out control. Failed login checks are IP-limited only; missing accounts skip bcrypt comparison, exposing a timing difference. Registration explicitly reports an existing username/email.

Required: phishing-resistant administrator authentication, separate privileged access and least privilege, step-up for sensitive player operations, safe recovery, compromised-password checks and account/device/IP risk controls. Add uniform credential-check behavior and auditable success/failure/revocation events. Test support recovery as an account-takeover surface. bcrypt cost 12 is not itself the defect. [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

### F08 — High, reproduced: malformed requests leak passwords to logs and bypass rate limits

Evidence: `app.ts:39`, `:56`; `logger.ts:4`; `scripts/security-review.mjs` observation `malformedJson`.

`express.json` runs before both rate limiters. Its parse error includes the original request body. The catch-all error logger serializes the error with Pino's default error serializer and no redaction. A malformed login containing a synthetic password produced a log representation containing that password. Sixteen malformed auth requests all returned 500, bypassing the 15/minute auth limiter entirely. Parser limits still bound a single body, but do not stop repeated error/log work.

Required: apply appropriate limits before body parsing; handle parser and oversized-body errors as 400/413; log an allow-list of error metadata. Removing only `err.body` is insufficient if a parser's message or stack embeds input. Redact credentials/cookies/authorization and other sensitive fields across all logging paths. Admin access logs also currently preserve query strings through `originalUrl`; log the path without query parameters. Test with synthetic secrets, never actual credentials. [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

### F09 — High, reproduced with an inconsistent recipient: cash-out can silently discard chips

Evidence: `game/manager.ts:165`; observation `missingCashoutRecipient`.

The cash-out loop calls `updateMany` with `kind: HUMAN` but ignores its affected-row count. It then empties `cashOuts` and persists the released seat. A fixture returning `{count: 0}` committed with the seat released and no remaining payment instruction. An absent/mismatched identity or administrative kind change can therefore discard a human payout without failing the transaction. Ordinary valid-user cash-outs do pass existing tests; this reproduction is a fault case, not an unauthenticated exploitation claim.

Required: verify the expected recipient and exactly one matching wallet mutation/ledger posting; otherwise roll back and preserve a recoverable obligation. Explicitly distinguish demo bot balances from human money instead of silently skipping unmatched rows. Acceptance must include removed/restricted/reclassified recipients, DB failures, retries and restore recovery.

### F10 — High, reproduced: server downtime can immediately forfeit a player's turn

Evidence: `index.ts:48`; `game/manager.ts:109`, `:335`; observation `outageRecovery`.

Recovery resets the inactivity baseline but preserves the old betting deadline. If that deadline expired during an outage, the timer is scheduled immediately. Recovery runs before the HTTP listener starts. A three-player fixture started 60 seconds earlier produced `TIMEOUT_FOLD` about 4 ms after recovery, without any reconnection opportunity.

Required: define and audit the interrupted-game policy; pause or fairly rebase affected deadlines, provide an appropriate reconnect window and distinguish system outage from player inactivity. Coordinate this across workers so a rolling restart cannot arbitrarily reset or expire turns. Test partial outages, long startup, DB stalls, clock jumps, repeated restarts and mixed connected/disconnected players. Do not allow a restart to act as an operator-selectable advantage.

### F11 — High: key lifecycle and separation are incomplete

Evidence: `game/encryption.ts:5`; `config.ts:19`; observation `productionSecretValidation`; local sanitized configuration check.

One environment key encrypts live states, historical hole cards and all sealed audits. The envelope has a format version but no key ID, keyring, envelope encryption, rotation job or recovery workflow. The production validator accepts an all-zero encryption key reused as the access-token secret, provided the refresh secret differs. The current local secrets are distinct; this probe demonstrates a missing guard, not weak keys found in use.

Required: managed key custody with narrowly scoped access, auditable use and separation of authentication, current gameplay, retained audit data and any financial signing keys. Add versioned key identifiers, online/offline rotation and retention procedures, backup/recovery tests and emergency revocation. Reject obvious placeholders/reuse, but do not pretend a regex proves randomness. Plan the encryption volume and nonce/key lifetime. JavaScript data cleanup is not a guarantee of memory zeroization.

### F12 — High: one runtime role can alter both balances and administrator identity

Evidence: live `has_column_privilege` queries; `prisma/migrations/20260920140611_poker_security/migration.sql`; `schema.prisma:64`.

The restricted role correctly lacks DDL and history mutation privileges. However, it can read password hashes and UPDATE both `User.role` and `User.bankroll`; server RLS policies allow all rows to that role. A compromise of this credential or backend process has an unnecessarily broad impact across identity, gameplay and funds. This does not mean a browser can directly exercise those privileges.

Required: separate privileged administration, identity and financial write capabilities. Remove role-management permissions from routine gameplay paths; use narrowly scoped operations with validated accounting invariants and audit trails. Verify effective privileges at startup/CI and after migrations. Field encryption alone cannot stop a process that holds both the database privileges and decryption keys.

### F13 — High: audit integrity is not independently anchored and live state is replayable

Evidence: `game/encryption.ts`; `game/manager.ts:146`; `engine/src/audit.ts`; `COMPLIANCE.md` section 6.

Completed hand rows are append-only to the runtime role, an important protection. In-flight events live inside a replaceable encrypted table snapshot until settlement. AAD identifies the table but does not prove that a ciphertext is the newest state of that table. GCM authenticates an older valid ciphertext too. An actor able to restore database state can replay old snapshots; a sufficiently privileged database/operator can also replace a complete unanchored history or remove its tail. A local hash chain alone cannot prove completeness against that actor.

Required: durable uniquely identified commands and start/void/settlement records; freshness/reconciliation checks against independently protected ledger/history; externally witnessed commitments/checkpoints or appropriately controlled immutable storage. Anchor enough information to detect missing final hands as well as edits. Preserve a durable record of interrupted/voided games, not only a process log. Define and test the authorized backup-restore protocol so old game state cannot reissue a financial settlement.

### F14 — High assurance gap, reproduced: audit replay does not validate betting legality

Evidence: `packages/engine/src/audit.ts:158`; observation `auditBettingLegality`.

The verifier explicitly recomputes contributions and outcomes without re-judging action legality, minimum raises or turn order. Replacing a recorded 10-chip CALL with CHECK, leaving the amount unchanged and rebuilding the hash chain, passed both sealed-card and outcome verification. A legitimate CHECK cannot contribute 10 chips. This requires access to construct a new/resealed record; it is not a way for a normal player to bypass the live action validator, and changing previously witnessed hashes would be detectable.

Required: a versioned replay that validates the complete rules and transition sequence, including acting seat, street, effective stack, call amounts, reopening, blinds, status changes and timestamps. Maintain an independent reference implementation for outcome tests; the runtime verifier currently shares evaluator/pot code with the engine. Have the final rules and deployed RNG implementation evaluated by the appropriate independent audit/lab process.

### F15 — High operational gap: transport and deployment hardening remain unverified

Evidence: `config.ts`, `transport.ts:42`, `index.ts:24`, `.env.example`, `docker-compose.yml`, `apps/web/next.config.ts`.

Production guards correctly refuse insecure requests and direct-TLS tests pass. Proxy mode trusts the first `X-Forwarded-Proto` value from any connecting peer; the documentation correctly requires the app port to be reachable only through a proxy that overwrites it. The listener binds without a specific interface. A public origin port would make forged forwarded headers dangerous and could undermine IP rate limits. This exposure was not established because no production deployment was inspected.

Local configuration is development/HTTP. The included Compose file publishes Postgres and Redis with development defaults and is not production infrastructure. No reviewed deployment enforces secret injection, network segmentation, an authenticated/encrypted proxy-to-app hop where needed, production mode, ingress/DDoS controls, or browser security headers. Helmet on the API does not configure the separate Next.js page origin's CSP.

Required: review the exact production manifest and external URLs, restrict origin/network access, configure trusted peers/header replacement, secure every sensitive network hop, enforce HTTPS/WSS and secure cookies, configure frontend CSP/framing policies, and inspect database/Redis reachability. Include negative tests with forged headers sent directly to the origin.

### F16 — Medium, reproduced: refresh replay and lifetime policies are incomplete

Evidence: `auth/routes.ts:143`; `schema.prisma:86`; observations `refreshReplay` and `absoluteSessionAge`.

Rotation uses a conditional update, correctly allowing only one concurrent winner. Reusing an older signed refresh token returns 401, but leaves the current session valid with no replay alert or token-family response. Refresh continuously extends expiry by seven days; `createdAt` is not used to cap absolute session age. A session fixture created 365 days earlier still refreshed successfully. Cookie and database durations are hard-coded to seven days even though JWT refresh lifetime is configurable.

Required: define absolute, idle and privileged-session limits; add token-family/reuse handling and telemetry with a bounded concurrency policy so normal multi-tab races do not cause arbitrary lockouts. Bind cookie, database and token lifetimes to one validated policy. Add active session inventory, remote revocation and password/recovery-triggered invalidation. [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

### F17 — Medium, reproduced: revoked sockets still receive user-room notifications

Evidence: `socket/index.ts:77`; `game/manager.ts:245`, `:261`; observation `revokedSocket`.

Commands and table snapshots reauthenticate the socket, which protects gameplay and hidden cards. `USER_PATCH` and `TABLE_IDLE_NOTICE` are sent directly to a user room without the same check. After deleting the fixture's session, HTTP authentication correctly failed but its otherwise idle socket still received a bankroll update.

Required: disconnect sockets for a revoked session across workers and enforce expiry/revocation for every private outgoing event. Session-scoped rooms or an authorization-aware notification service can support this. Do not describe this reproduction as a hole-card leak; the verified leak was a balance notification.

### F18 — Medium, reproduced at the handler: cookie routes lack explicit origin/CSRF enforcement

Evidence: `app.ts:33`; `auth/routes.ts:130`, `:143`, `:184`; observation `crossOriginGuest`.

CORS controls whether browser JavaScript can read responses; it is not a general server-side CSRF check. A simple text/plain POST with an untrusted Origin reached `/auth/guest`, created a user and issued a session. Refresh/logout do not validate Origin or an anti-CSRF token. Production SameSite=Strict helps against cross-site cookies but does not distinguish trusted and untrusted same-site subdomains. The local HTTP probe proves handler behavior; browser cookie effects depend on origin/site and deployment policy.

Required: validate the expected Origin/Fetch Metadata and/or a properly bound CSRF token on cookie-authenticated mutations; reject inappropriate media types. Define deliberate exceptions for non-browser clients rather than treating CORS as authorization. Cover login/guest session replacement and logout as well as money operations.

### F19 — Medium, reproduced: sensitive account responses lack explicit cache prohibition

Evidence: `auth/routes.ts`; `app.ts`; observation `authCaching`.

Successful `/auth/guest` and `/auth/me` responses had no Cache-Control header, despite containing tokens or personal/account data. Audit routes already use `no-store`. This is not proof that a shared proxy is currently caching authenticated content; it is an avoidable browser/proxy configuration risk.

Required: `Cache-Control: no-store` for authentication, private account and financial responses, with correct cache keys/behavior at the CDN and browser boundaries. Verify login, refresh, logout, personal API data and error responses on the deployed system.

### F20 — Medium: admission, rate limiting and backpressure do not cover a distributed service

Evidence: `app.ts:41`, `:52`; `socket/rate-limit.ts`; `socket/index.ts:64`, `:81`; `game/manager.ts:293`.

HTTP and per-user action limits are held in process memory. Multiple replicas multiply the allowance; guest accounts evade per-user limits. The socket transport has a useful 8 KiB message cap, but no application connection quota or pre-authentication connection limiter was found. Every broadcast fetches sockets and reauthenticates each viewer through Postgres; unbounded concurrent authentication/projection work can amplify load. The earlier body-parser bypass is separate and reproduced in F08.

Required: shared abuse limits and account/IP/device admission rules, bounded concurrent work, per-session connection ceilings, edge limits and measured load shedding. Exercise websocket reconnect storms, large spectator audiences, slow clients, Redis loss and DB pool exhaustion. Rate limiting must remain correct during failover; do not cache revoked authorization beyond its explicitly accepted delay.

### F21 — Medium: command receipt and service-readiness contracts are incomplete

Evidence: `socket/index.ts:33` and ACTION_INTENT handler; `game/manager.ts:139`; `routes/health.ts`; observation `healthWithoutDatabase`.

`clientActionId` is validated but never persisted or used to return the original outcome. Revisions prevent repeating an action against the same state, but an accepted action whose acknowledgement is lost returns a stale error on retry; there is no durable receipt/query contract. New-table creation has the same uncertain-response problem, although the unique seat constraint limits duplicate seating. Do not treat this as evidence that a replay currently debits twice.

`/api/health` always returns `ok:true`, even with an intentionally unreachable database. That is a usable liveness check but insufficient as readiness. Startup verifies only the presence of some audit columns, not effective permissions, financial reconciliation or the ability to recover every table; individual recovery errors are logged while startup continues.

Required: durable idempotency and operation-outcome queries for financial/escrow commands, plus readiness and table-health reporting that reflect dependency/integrity failures. Healthy tables may continue under an approved isolation policy, but failed ones need a visible recovery state and alert. Add graceful draining, bounded shutdown and durable delivery/recovery for financial effects.

### F22 — High launch evidence gap: privacy, retention, incident response and restore controls

Evidence: plaintext personal fields in `schema.prisma`; raw logger configuration; repository infrastructure inventory and existing `COMPLIANCE.md` limitations. These controls may exist outside the repo, but none were supplied or verified.

Required evidence: data inventory/classification; minimal retention including sessions, IPs, logs and immutable history; lawful erasure/pseudonymisation handling consistent with regulated retention; access/export records; production access review; independently held backup/key recovery; recovery objectives and restore drills; clock discipline; on-call alerts and incident playbooks; change approvals, CI security gates, dependency update policy and release provenance.

Test recovery of database and keys together without duplicating paid withdrawals or hands. Test loss of a region, unavailable custody provider, compromised signing capability, rogue administrator and missing audit tail. Define custody and player-fund shortfall escalation. Immutable history should preserve what is required without accidentally making unnecessary personal data impossible to manage.

## Additional correctness and hardening observations

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

## Malta and custody decisions

Player-versus-player poker charging commission is described by MGA as Type 3. The exact licence scope depends on the business and supplied services; do not reuse claims about house-banked poker or bots to classify this project. [MGA game types](https://www.mga.org.mt/faqs/what-are-the-different-types-of-games-that-are-licensable-by-the-authority/)

MGA has a DLT approval process and publishes distinct system-audit checklists for B2C and B2C with DLT. Integrating a crypto API does not supply those approvals or an independent audit. The old sandbox guidance is not a sufficient current implementation specification; the later DLT policy replaced it. Confirm the applicable policy and proposed architecture with the operator's Malta adviser and approved auditor. [DLT applications](https://www.mga.org.mt/faqs/how-can-licensees-obtain-an-approval-in-order-to-make-use-of-distributed-ledger-technology-dlt/), [DLT policy publication](https://www.mga.org.mt/the-mga-publishes-its-policy-on-the-use-of-distributed-ledger-technology-by-authorised-persons/), [system-audit process](https://www.mga.org.mt/mga-issues-revised-system-audit-checklist-and-new-system-review-checklist/)

Player funds must be segregated and separately identifiable under MGA's explanation of player-fund protection. That requires both appropriate external accounts and accurate internal liabilities; encrypting `bankroll` would provide neither. [MGA player funds](https://www.mga.org.mt/faqs/how-are-player-funds-protected/)

**Engineering recommendation: start by evaluating appropriately regulated payment and custody providers that explicitly accept licensed poker.** This is a recommendation to reduce operational scope, not a claim that any provider makes the site safe automatically. The gambling and financial-services approvals are separate questions. For EU crypto providers, verify the actual legal entity, permitted services and authorization with MFSA/ESMA and obtain advice on whether the proposed operator activities also fall within MiCA. [MFSA crypto-assets framework](https://www.mfsa.mt/our-work/crypto-assets/), [MiCA authorization](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-59-authorisation)

| Model | Responsibilities retained by this application | Additional custody responsibilities |
| --- | --- | --- |
| Regulated provider holds assets | Eligibility, limits, wallet/escrow ledger, authenticated callbacks, withdrawal approvals, provider reconciliation, player statements and incident handling | Provider manages keys under contract; independently verify asset segregation, subcustodians, incident support and exit/asset recovery |
| Operator self-custody | All of the above | Signing infrastructure, hot/cold balances, multi-party control, key backup/rotation/recovery, chain operation, wallet security monitoring and financial-services legal analysis |

Provider selection criteria: contractual support for MGA poker; verified authorization for the relevant services; supported countries/assets/chains; segregation and reconciliation reports; idempotency and signed webhook specifications; withdrawal controls; security audit evidence; liability/insurance limitations; service availability and recoverability. A brand name or quick integration is not a substitute for these checks. No provider has been approved or selected by this review.

## Order of work and acceptance gates

1. **Keep the money boundary closed.** No deposits/redemption against current balances. Decide entity, target markets, licence scope, approved game rules, settlement currency, provider/custody model and accounting policy.
2. **Fix reproduced code defects.** Safe logging and parser limits; cash-out recipient invariants; outage recovery; session lifetime/replay/revocation; private notifications; origin/CSRF checks; private response cache control. Turn the review probes into normal regression tests that assert rejection or safe behavior after remediation.
3. **Build the financial and eligibility foundations.** Ledger/escrow, exact asset amounts, segregated funds/reconciliation, provider events, withdrawal lifecycle, identity/AML, self-exclusion/limits, privileged identity and anti-collusion operations. Every financial endpoint needs explicit threat modeling and failure tests.
4. **Close operational and integrity gaps.** Managed keys, tested rotation/restores, least-privilege services, durable idempotency and audit witnesses, readiness/alerts, distributed limits and production TLS/network validation.
5. **Verify a disposable production-like staging environment.** Real Postgres concurrency/rollback; restart during every financial step; duplicate/delayed callbacks; reorgs; provider timeout after payout; account exclusion during a transaction; worker/Redis/region loss; restoration from older backups; sustained load and reconnection storms. Use synthetic funds and fixtures.
6. **Obtain external evidence before launch.** Independent penetration test, required game/RNG and MGA system review, reviewed custody/financial procedures, signed operational acceptance and a controlled rollout with limits and emergency stop capability. The report uses OWASP ASVS 5.0 as an engineering reference, not as a certification assertion. [OWASP ASVS](https://github.com/OWASP/ASVS)

## Reproducing this review's probes

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
