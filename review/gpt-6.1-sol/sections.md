> **Working fragment.** Notes that were copied into the published report, now [docs/reviews/2026-09-30-gpt-review.md](../../docs/reviews/2026-09-30-gpt-review.md). This file is not a second review.

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

<!-- FINDINGS -->

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

<!-- COVERAGE -->

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

<!-- ENDSTATUS -->
