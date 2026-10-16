# Reviews

Dated engineering reviews. They are evidence of what was found on that date. They are not a certification, a legal opinion, or the current defect list.

The last line-by-line status of these findings is [the 7 October recheck](../progress/11-october-7-review-recheck.md). Work after that night is listed in the [progress index](../progress/README.md) and was not re-scored here.

| Date | Document | Ids |
| --- | --- | --- |
| 2026-09-24 | [Fairness model](2026-09-24-fairness-model.md) | Shuffle, isolation, and audit. Residual risks are listed at the end. |
| 2026-09-29 | [Backend security and real-money readiness](2026-09-29-backend-security-audit.md) | F01–F22. Decision that day: NO-GO for deposits, custody, and redeemable chips. |
| 2026-09-29 | [GPT review brief](2026-09-29-gpt-review-brief.md) | Instructions given to the GPT review. Historical. Do not treat them as instructions for a new session. |
| 2026-09-30 | [Independent review](2026-09-30-claude-review.md) | CR-001–CR-041, decisions D1–D12, legal register L1–L10. |
| 2026-09-30 | [GPT review](2026-09-30-gpt-review.md) | SOL-001–SOL-052. |
| 2026-10-07 | [Session log](2026-10-07-session-log.md) | Full working log of the recheck and the same-day fixes, including command history. |

Repro scripts stay in `review/claude/` and `review/gpt-6.1-sol/`. `review/gpt-6.1-sol/sections.md` is a working fragment that was copied into the GPT report.

Citations inside a review use the filenames and line numbers of the tree on that date (`progress.md`, `COMPLIANCE.md`, `SECURITY-REVIEW.md`, and the rest). The [documentation index](../README.md) maps those names to the current paths. Do not edit a review to make an old finding look fixed. Record the fix in `docs/progress/`.
