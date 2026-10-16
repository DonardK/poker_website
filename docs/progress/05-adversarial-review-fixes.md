# Adversarial review fixes

**Recorded:** 2026-09-27

Twenty-five defects from four reviewers of the compliance rebuild, all fixed in this pass. The 29 September audit did not treat these as closing its own findings.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-09-27 - adversarial review round (25 findings fixed)

Four independent reviewers attacked the compliance rebuild and confirmed 25 defects with executed repros: 1 high, 9 medium, 15 low. All are fixed:

- **Legacy state (high):** tables saved by the previous version are upgraded on load by `upgradeTableState`. Leftover cards are purged, settled hands are cleaned up, and hands still in progress are voided with every bet returned. Upgraded state is persisted at startup.
- **Verifiers:**
  - Participant audits reject duplicate cards and a folded (mucked) hand presented as tabled. Folds are derived from the chained actions.
  - They also reject a doctored showdown, fields outside the schema, and an audit for a different table, hand or user.
  - New `verifyHandOutcome` replays bets, ranks, side pots, odd chips, payouts and stacks. It runs before a hand is recorded and in the regulator report, which also checks the per-table chain link.
- **Rules:**
  - Newcomers and players returning after missed blinds wait for the big blind, so blinds cannot be dodged.
  - The button moves to the previous small-blind position (dead button).
  - A leaving player's hand is folded on their turn and never tabled, and sitting back in cancels the leave.
  - Auto-actions record their true reason, and no-op sit toggles change nothing.
- **Isolation and transport:**
  - The leak guard enforces an exact client-schema allow-list.
  - TLS is enforced on every engine.io request, not only the handshake.
  - Every admin request is logged with its outcome.
  - The participant redaction guard checks the stored `showedCards`.
  - Live evidence in the browser is user-scoped, pruned and cleared at sign-out.
- **Docs** no longer overclaim. They state what the guard, the hash chain (in-hand transitions only) and the hole-card digest actually guarantee.
- **Tests:** `review-fixes.test.ts` has 94 tests, including 35 re-sealed forgeries that keep every hash valid and are caught by the semantic checks. The server `compliance.test.mjs` has 28 tests.
