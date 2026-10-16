# Browser-nonce shuffle and verify hand

**Recorded:** 2026-09-24 (morning; superseded the same day)

**Superseded.** The seeded HMAC shuffle and browser-nonce protocol in this entry were removed on purpose during the [compliance rebuild](04-compliance-rebuild.md). Revealing the shuffle seed after a hand exposed mucked and undealt cards. Do not reintroduce that protocol.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-09-24 - responsiveness, reliability, and shuffle fairness

1. Polished the lobby and table layout for smaller screens, cleaned up card faces and seat displays, added smoother motion with reduced-motion support, and kept the existing play controls. Improved guest/login and session recovery, API error messages, socket reconnection feedback, and sound behavior.
2. Live hands now publish a commitment to a fresh 256-bit server seed before accepting player entropy. At least one seated human contributes a 256-bit browser nonce before the deal. A domain-separated HMAC-SHA-256 Fisher-Yates shuffle uses rejection sampling for unbiased index selection. Every seat receives cards from the same uniformly shuffled deck; seat position does not change starting-card odds.
3. Added a participant-only, post-hand audit endpoint and a **Verify hand** control that can check any completed hand number. The browser verifier reconstructs the shuffle and checks the seed commitment, player contributions, full deck, salted deck root, deal order, hole cards, and board. It compares the browser's own nonce and commitments when recorded during live play. A root first seen after settlement is explicitly treated as retrospective evidence.
4. Restricted bot decisions to public information and their own hole cards. Tests check hidden deck and opponent cards are absent from the bot view.
5. Verified `npm.cmd run typecheck`, `npm.cmd test` (**75 engine + 4 server passed**), `npm.cmd run build`, and `git diff --check`. Shuffle regression sampling covers 10,000 seeded deals across nine positions plus 5,200 first-card samples; these detect major bias but do not prove perfect randomness.
6. Live browser QA: a guest joined a bot table, a hand waited for browser entropy, completed-hand verification succeeded with the player's nonce and both live commitments, earlier hands #47 and #48 passed the history audit, and the temporary seat cashed out. After a server restart, the table reconnected and the audit still passed. The local dev site was left running at `http://localhost:3000`.

**Remaining high-assurance work:** An operator can still abandon a pending round after seeing a nonce; the server knows the deck during play, and the audit store is under server control. Add an independent append-only witness for commitments, contributions, cancellations, and settlement; commission external RNG and rules review; test two independent human browsers, rule boundaries, mobile/touch access, network faults, and anti-collusion controls. See `SECURITY-REVIEW.md` for the fairness model and `CLAUDE_HANDOFF.md` for Claude's test checklist. This implementation is not externally certified for real-money play.
