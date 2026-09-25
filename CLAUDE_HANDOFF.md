# Poker QA handoff

## Current model (2026-09-24 compliance rebuild)

- **Shuffle:** OS CSPRNG only (`crypto.randomFillSync`), an explicit rejection-sampled Durstenfeld shuffle, and a continuous health test. The earlier browser-nonce / seeded-HMAC "provably fair" shuffle was removed on purpose. Its post-hand seed reveal exposed mucked and undealt cards to every participant.
- **Commitments and audit:** each hand has a UUID v4. A salted SHA-256 deck commitment and a Merkle root are computed before blinds or dealing. Every transition is appended to a SHA-256 hash chain, which links to the previous hand's `finalStateHash` and is sealed with a post-hand verification hash.
- **Isolation:** every emitted snapshot goes through `projectTableState`, the allow-list projection plus the fail-closed leak guard. Hand Clean-up purges all card secrets. TLS is enforced in production.
- **Audit access:** players get a redacted, verified audit of hands they were dealt into, through the **Verify hand** control. Regulators use the ADMIN-only `/api/admin/hands/:handUuid/audit`.
- **Details and evidence:** `COMPLIANCE.md` (requirement matrix, measured χ² results) and `SECURITY-REVIEW.md`.

## Before running against a real database

Apply `apps/server/prisma/migrations/20260924120000_compliance_audit_trail` with an administrator connection **before** starting this server version. The Supabase copy is in `supabase/migrations/`. Deploy while tables are idle.

## Suggested next tests

1. **Two human browsers:** join, bet, fold, and disconnect and reconnect mid-hand. Complete hands, then run **Verify hand** in both browsers and check that each sees only its own cards, the board and tabled hands.
2. **Opt-in integration test:** run `npm run test:integration -w @poker/server` against a disposable database with production role restrictions (see README). It now covers the audit columns and both audit routes.
3. **Browser matrix:** phone, tablet, desktop, touch, keyboard, reduced motion and slow network.
4. **Fault injection:** failed requests, dropped sockets, a server restart mid-hand, and expired authentication. Confirm there is no double action, duplicate deal, lost chip or stuck table.
5. **Leak-guard monitoring:** watch the logs for `LEAK_BLOCKED`, `AUDIT_INTEGRITY`, `ADMIN_DENIED` and `INSECURE_TRANSPORT` security events.

## Remaining assurance work

- Accredited laboratory RNG and game certification.
- External anchoring of `finalStateHash` values (WORM or timestamping service).
- KMS/HSM custody of `GAME_ENCRYPTION_KEY`.
- Anti-collusion analytics, KYC and responsible-gaming controls.

A passing test suite cannot certify these.
