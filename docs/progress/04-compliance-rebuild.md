# Compliance rebuild

**Recorded:** 2026-09-24

OS CSPRNG shuffle, pre-deal commitments, hash-chained audits, and fail-closed state isolation. This is an engineering self-assessment, not a certification. The dossier is [COMPLIANCE.md](../../COMPLIANCE.md). The threat model is [the fairness model](../reviews/2026-09-24-fairness-model.md).

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

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
