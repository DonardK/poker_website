# Technical compliance dossier: poker engine

This document is an engineering self-assessment. It is written against the GLI-19 (interactive gaming systems) RNG and game-integrity expectations and the technical-compliance expectations of the Malta Gaming Authority (MGA). **It is not a certification.** Certification requires an accredited test laboratory, such as GLI, eCOGRA or BMM, to review the source, test the RNG output and inspect the production deployment. This dossier is organised to support that submission. For each requirement it names the code that implements it and the tests that demonstrate it.

- Language/runtime: TypeScript on Node.js ≥ 20 (measured on Node 24.19, OpenSSL 3.5.7).
- Engine: `packages/engine` is a pure state machine with no network, database or UI imports (`ENGINE_ISOLATION_BOUNDARY`).
- Shared verifiers: `packages/shared` runs unchanged in Node and in browsers (WebCrypto).
- Server: `apps/server` provides authoritative gameplay, persistence and transport security.

## 1. Cryptographic entropy and randomness

| Requirement | Implementation | Evidence |
|---|---|---|
| OS-level CSPRNG only | `packages/engine/src/rng.ts`, `CsprngWordStream`: 32-bit words from Web Crypto `crypto.getRandomValues`. On Node this is OpenSSL's NIST SP 800-90A DRBG, seeded and reseeded by the OS (getrandom / BCryptGenRandom). On workerd it is the Workers CSPRNG. There is no seeding API and no replay mode. | `rng.test.ts` static scan: no `Math.random` in engine/shared code; no `deckFromSeed`, `seededShuffledDeck` or `createHmac` in the engine; `rng.ts` calls `getRandomValues` and does not call `randomFillSync` or `randomBytes`. `apps/server/test/compliance.test.mjs` runs the Math.random and removed-protocol scan on the server. |
| Reject standard PRNGs | `Math.random` was removed from the whole server (avatar colours now use `crypto.randomInt`). Bots use CSPRNG floats for pacing only, never for cards. | Static scans above. |
| Unbiased Fisher–Yates (Durstenfeld) | `packages/engine/src/deck.ts`, `durstenfeldShuffle`: for i = n−1…1, j is drawn uniformly from [0, i]. | `rng.test.ts`: for n = 1…8, all ∏(i+1) draw sequences are enumerated, and exactly n! distinct permutations appear, each once. The algorithm is therefore a bijection, so uniform draws give a uniform permutation over all 52! orders. |
| Explicit rejection sampling | `uniformFromWords`: accept a word only if `word < 2^32 − (2^32 mod range)`, then return `word mod range`. Every residue has exactly `limit/range` preimages, so there is zero modulo bias. | `rng.test.ts`: the exact limit invariants for every range 1…52 and edge ranges; the acceptance boundary (limit−1 accepted, limit rejected); malformed words raise `RngFailure`. |
| RNG failure handling | Continuous health test on every 256-byte OS block: an all-zero block, or one identical to the previous block (compared by SHA-256 digest), raises `RngFailure`. 128 consecutive rejections also raise it. Because every transition is pure, a failed shuffle leaves the table unchanged and no hand starts. Consumed words are zeroed immediately, and each stream is wiped after its shuffle. | `rng.test.ts` health and hygiene tests. |

**Statistical results.** From `packages/engine/src/__tests__/rng.test.ts`, run on 2026-09-24: 1,000,000 production `shuffledDeck()` calls plus 1,000,000 five-item `shuffle()` calls. Every test is two-sided. The whole file's false-failure budget is ≤ 1×10⁻³.

| Test | Statistic | df | Two-sided p | Threshold |
|---|---|---|---|---|
| (a) each of 52 positions uniform over cards | X² min 32.0, max 85.7, mean 52.2 | 51 each | min 0.0034 (Bonferroni 0.18) | 3.1×10⁻⁶ each |
| (b) each of 52 cards uniform over positions | X² min 34.9, max 73.9, mean 52.2 | 51 each | min 0.039 (Bonferroni 1.0) | 3.1×10⁻⁶ each |
| (c) global 52×52 matrix, S·51/52 | 2663.9 | 2601 | 0.38 | 1.6×10⁻⁴ |
| (d) successive-shuffle independence (2 disjoint tables) | 2530.3 / 2644.9 | 2703 | 0.017 / 0.43 | 8×10⁻⁵ each |
| (e) all 120 permutations of 5 items | 134.5 | 119 | 0.31 | 1.6×10⁻⁴ |

Notes on the statistics:

- Because every shuffle is a permutation matrix, the global statistic satisfies S·(n−1)/n ~ χ²((n−1)²), not χ²(n²−1). The covariance claim this relies on is checked by exact enumeration for n = 2…6.
- Test (d) uses disjoint pairs. A single table of overlapping pairs is not χ²(2703).
- The χ² p-values come from the regularized incomplete gamma function. It is checked against mpmath references (worst relative error 3×10⁻¹²) and against an independent exact finite-sum oracle.
- Negative controls prove the pipeline can fail. Sattolo's algorithm, a classic biased shuffle, fails (a), (b) and (c), and over-regular output fails the lower tails.

## 2. Server-side state isolation and leakage prevention

| Requirement | Implementation | Evidence |
|---|---|---|
| Deck encapsulated in server memory | The deck, burns, salts, Merkle tree and hole cards live only in `EngineTable` on the server. At rest it is AES-256-GCM encrypted with a per-table context. Bots see `botInformationView`: own cards and public data only. Hand Clean-up (`completeHand`) purges the deck, burns, hole cards, commitments and log from live state. | `leakage.test.ts` (Hand Clean-up purge; bot isolation) and `audit.test.ts`. |
| Hole cards only to the owner's authenticated connection | `toPublicTableState` projects an allow-list of fields for each viewer. The server builds a separate projection for each authenticated socket and emits only to that socket (`TableManager.broadcast`), after re-authenticating the session. | `leakage.test.ts` sweep: 2,000+ random hands, every transition, every viewer (each seated player, a spectator, an unseated user). |
| Fail-closed guard | `projectTableState` runs `assertViewerStateSafe`, which re-derives from the engine state what the viewer may see. It blocks (`LEAK_BLOCKED`) the emission when the payload has: a key outside the exact client schema, at any level; a board that differs from the dealt board or is too large for the street; hole cards the viewer may not see; a proof for an unauthorized position; or a card code, as a whole token in any string other than user-chosen names, that the viewer may not see. The server then logs a security event and sends nothing. Limits: a card glued to other letters, or a card encoded as a number in an allowed numeric field, would not be recognized. The allow-list projection has no such field. | Negative tests for each leak class, including unknown keys at every level; adversarial card-like usernames produce no false positives. |
| Community cards unexposed until their round | `dealStreet` is the only place board cards leave the deck. It runs only when that betting round begins, or during an all-in runout when no betting remains. Until then, future board cards stay in the server-only `deck`. | Sweep asserts the board size per phase and that the deck is the untouched committed tail. |
| TLS | In production the server terminates TLS itself (`TLS_CERT_FILE`/`TLS_KEY_FILE`, TLS ≥ 1.2) or requires `TRUST_PROXY_HOPS ≥ 1` behind a TLS proxy. Otherwise it refuses to start. Plaintext HTTP gets 426 (except the health probe). Every Socket.io/engine.io request must arrive over TLS: the handshake, polling requests that carry a session id, WebSocket upgrades and CORS preflights. This is enforced by an engine.io middleware that runs before any session lookup. HSTS is on. In proxy mode, `X-Forwarded-Proto` is trusted from whoever connects. The application port must therefore be reachable only through the proxy, and the proxy must overwrite that header. | `compliance.test.mjs`: in-process production tests over real `node:https` and behind a simulated proxy. |

## 3. Audit trail and SHA-256 immutability logging

Each hand produces a `HandAuditRecord` (`packages/shared/src/audit.ts`, built by `packages/engine/src/audit.ts`):

- `handId`: UUID v4 from `crypto.randomUUID`. `startedAt`, `settledAt` and every event's `at` are UTC ISO-8601 with milliseconds.
- `deckCommitment` = SHA-256(canonical(`"poker-deck-commitment-v1"`, handId, tableId, handNumber, 52 cards in order, 256-bit salt)). `merkleRoot` is a salted SHA-256 Merkle root over the same positions. Both are computed in `startHand` **before any blind is posted or card dealt**. The event order in the chained record proves this. They are first published in the hand's first snapshot, together with the viewer's hole cards and before any community card.
- `events`: HAND_STARTED → BLIND_POSTED → HOLE_CARDS_DEALT → PLAYER_ACTION / PLAYER_STATUS / STREET_DEALT … → SHOWDOWN → POTS_AWARDED → HAND_SETTLED. Each event's hash is `hash = SHA-256(canonical("poker-audit-event-v1", handId, seq, type, phase, at, data, prevHash))`. The first event links to a genesis hash of the header. That header includes `previousHandHash`, the prior hand's final hash at the same table, so deleting or reordering whole hands is also detectable.
- `finalStateHash` = SHA-256(canonical(`"poker-audit-final-v1"`, handId, headHash, eventCount, settledAt)). This is the post-hand verification hash.
- Events contain only information that was public when it happened. Hidden hole cards appear only as deck positions, so a player can receive the record without learning mucked or undealt cards.
- The per-hand record covers the hand from HAND_STARTED to HAND_SETTLED. Buy-ins and cash-outs between hands are recorded in the seat and bankroll tables, not in the hash chain; see section 6.
- Players can call `GET /api/tables/:id/hands/:n/audit` for hands they were dealt into. It returns the redacted record plus Merkle openings for their own hole cards, the board and hands tabled at showdown. The server verifies the response. Its redaction guard also checks the stored `showedCards` flags, so it never opens a hand that was not tabled.
- The browser re-verifies the record. It checks the exact schema and the hash chain. It derives folds from the chained actions, so a folded (mucked) hand can never be presented as tabled. It checks that no card appears twice, and that the record is the table, hand number and seat the user asked for. It compares the pre-deal commitments, the chain head and a digest of the hole cards with what it recorded live. The browser keeps this evidence in session storage, scoped to the signed-in user, pruned, and cleared when the session ends. The hole-card digest is an integrity check, not a secret: with only 2,652 possible card pairs it can be reversed. Without live evidence it can prove only that the record is internally consistent: participants never receive the deck or salts, so they cannot recompute the SHA-256 deck commitment.
- Regulators can call `GET /api/admin/hands/:handUuid/audit`. It requires ADMIN, rechecked against the database, and is rate-limited. Every request is logged with its outcome (including 401 and 429). The response has the record, the sealed deck and salts, and three recomputations:
  - card integrity (`verifySealedAudit`): chain, commitments, and every dealt, burned and shown card at its committed position;
  - the hand outcome (`verifyHandOutcome`): contributions, folds, showdown ranks, side pots, refunds, odd chips, payouts, final stacks and chip conservation, all rebuilt from the events and required to equal the stored result exactly;
  - the table chain link (`verifyTableChainLink`): `previousHandHash` must equal the final hash of the table's preceding audited hand.
- Storage: `Hand.handUuid`, `deckCommitment`, `finalStateHash`, `auditRecord` (JSONB) and `auditSealed` (AES-256-GCM with a row-bound context) are written in the same transaction that settles the hand. The runtime database role has no UPDATE or DELETE on hand tables, so the columns are immutable after insert. Before recording, the server runs the card-integrity check and the outcome replay. It also checks that the settlement it is about to write (pots, refunds, payouts, starting and final stacks) equals the verified record. A hand that fails any of these is not recorded; the transaction rolls back.

Evidence:

- `audit.test.ts`: commitment made before the deal and bound to the dealt cards; chain recomputed independently with node:crypto; 18 distinct tamper types all detected; per-table chaining; regulator recomputation; participant redaction and request binding.
- `review-fixes.test.ts`: re-sealed forgeries that pass the hash chain are rejected by the semantic checks. These include a duplicated card, a folded hand presented as tabled, a doctored showdown, reassigned winners, a moved odd chip and changed stacks. The outcome replay also accepts large samples of real hands.
- `compliance.test.mjs` (28 tests) covers:
  - 30 chained hands persisted and verified through the server code path;
  - persistence failing closed on a re-sealed forged outcome and on live-settlement tampering;
  - the regulator report (row binding, card integrity, outcome, table chain);
  - the participant redaction guard checked against the stored `showedCards`;
  - admin access logging of 401, 403, 426 and 429;
  - legacy-state upgrade and voiding;
  - TLS on every engine.io request.

## 4. Game engine and pot logic

- State machine: `packages/engine/src/table.ts`. Every command is a pure transition that clones the state, validates and applies, so a rejected command leaves no partial state. It covers:
  - betting rules: minimum bet and raise, and short all-ins that do or do not reopen betting;
  - blinds: a forward-moving big blind, a dead small blind, and a dead button placed on the previous small-blind position; heads-up, the button posts the small blind;
  - entry: newcomers at a running table, and players returning after their blinds passed, wait for the big blind. Blinds cannot be dodged by sitting out;
  - time-outs, sit-out and leave. A leaving player's hand is folded on their turn and never tabled, unless folding would leave a pot with no eligible player. Automatic actions are recorded with their true reason;
  - all-in runouts;
  - a chip-conservation invariant that refuses to settle if chips would be created or destroyed.
- Side pots: `pots.ts`. An uncalled bet is returned, then pots are cut at commitment levels. Adjacent levels with the same eligible players are merged into one pot, so dead money from folded players never creates a separate pot with its own odd chip. Odd chips go one at a time to the first winners clockwise from the button.
- Evaluator: `evaluate.ts` takes the best 5 of 7 cards and encodes category plus kickers.
- Evidence:
  - `evaluate-exhaustive.test.ts`: all 2,598,960 five-card hands give exact category counts and exactly 7,462 equivalence classes. It also compares the evaluator against an independent 7-card reference on 300,000 random hands and on 200,000 multi-player showdowns, including splits.
  - `pots-reference.test.ts`: `awardPots` is compared with a chip-by-chip reference over 20,000 random scenarios and 1,300 real hands. Zero-eligible pots are proven unreachable, and corrupted state fails closed.
  - `table.test.ts` and `security.test.ts` cover the rule boundaries.

## 5. How to reproduce the evidence

```sh
npm run build:core
npm test -w @poker/engine        # full engine suite, including the 1,000,000-shuffle chi-square tests (~4-5 min)
npm test -w @poker/server        # server compliance suite (no database)
npm run typecheck
```

## 6. Known limitations and operator obligations

1. **Laboratory certification is still required.** Passing these tests shows the implementation behaves as designed. It does not replace an accredited lab's RNG evaluation, source review and production inspection.
2. **The server knows the deck during a hand.** This is inherent to server-dealt poker. The pre-deal commitment, the hash chain and the immutable storage make any change after the fact detectable, but insiders with access to production memory or keys remain a control-environment matter: access control, monitoring and separation of duties.
3. **External anchoring.** The per-table hash chain detects edits and deletions, but the hashes live in the operator's own database. For stronger tamper-evidence, publish the `finalStateHash` values periodically, for example as a daily Merkle root, to a system the operator does not control, such as WORM storage or a third-party timestamping service.
4. **Key management.** `GAME_ENCRYPTION_KEY` protects live state and sealed audits. Keep it in a KMS or HSM with rotation procedures. Losing it makes sealed audits unreadable.
5. **Clock discipline.** Timestamps are UTC from the host clock. Run NTP or chrony and monitor drift.
6. **Deployment order.** Apply migration `20260924120000_compliance_audit_trail` **before** deploying this server version. The server writes the new columns when a hand settles, and against an unmigrated database the settling transaction fails. When this version loads a table saved by the previous one, `upgradeTableState` handles it:
   - A hand still in progress has no pre-deal commitment, so it is **voided**: every bet is returned and the server logs a warning.
   - A settled hand is cleaned up.
   - Leftover cards from the previous hand are purged.
   Deploying while tables are idle avoids voided hands.
7. **Money movements outside a hand.** Buy-ins, cash-outs and seat changes update the seat and bankroll rows in the same database transaction as the table state. They are not part of the per-hand hash chain. A real-money deployment needs an append-only, hash-chained wallet ledger.
8. **Not in scope here:** KYC and age verification, responsible-gaming limits, anti-collusion and bot detection, geolocation, real-money wallet accounting and jurisdictional reporting. MGA licensing requires these, and they need separate systems.
