# Product decisions

The server comments in `apps/server/src/auth/routes.ts` and `apps/server/src/auth/usernames.ts` cite this file.

Each row is a choice the 30 September review asked the owner to make. **Recommendation** is the reviewer's recommendation, not an owner sign-off. **In the code** is what the repository does as of the 10 October 2026 commits. Where those differ, the code is not a decision.

Source of the options: [30 September review, section 6](../reviews/2026-09-30-claude-review.md). Status notes from [the 7 October recheck](../progress/11-october-7-review-recheck.md) and the [10 October logs](../progress/README.md).

| ID | Decision | Recommendation (not a sign-off) | In the code |
| --- | --- | --- | --- |
| D1 | Absence and disconnection | Sit out after the first time-out, and sit out on disconnect after a 60 s grace. Publish it. | A timed-out player is sat out (reason `TIMEOUT`). Sit-out after a disconnect grace period was still optional on 7 October. |
| D2 | Showdown mucking | Auto-muck losing hands unless shown. | **Open.** House Rules promise auto-muck. The engine still tables every live hand (NEW-3). |
| D3 | Idle closure | 5 min idle, then a 30 s warning. | 5 min, then a 10 s warning. Restart drops a warning in progress and gives every table a fresh 5 min. See the root README, "Table lifecycle". |
| D4 | Time bank | 20 s base plus a 30–60 s bank. | Wired on 7 October night: new tables get the configured bank (30 s, +5 s per 10 hands, max 60 s). Recovery gives the player to act a fresh base time. |
| D5 | Chip unit | Say "chips", not dollars. | The UI uses one chip formatter and does not show "$". Real-money currency is not chosen. |
| D6 | Hosting topology | One origin, web and API behind a proxy. | The Cloudflare demo is one `workers.dev` origin: `poker-web` forwards `/api` and `/ws` to `poker-api`. That is an implementation of same-origin hosting, not a recorded owner choice of vendor. The Node deploy docs still describe a separate proxy. |
| D7 | Usernames | Case-insensitive unique, reserved words, a limited script. | Implemented. Case-insensitive unique index. `guest_` / `bot_` prefixes and staff words are refused. See `apps/server/src/auth/usernames.ts`. |
| D8 | Buy-in default | A dialog, default `min(100 BB, bankroll)`. | "Sit here" opens a buy-in dialog. On 7 October the lobby's "Open 6-seat table" still took 1,000 chips in one click, and the default could be the whole bankroll. |
| D9 | Guests | Keep for play chips, age-gated, with an upgrade path. Remove before real money. | New guests must accept terms and confirm 18+. They are warned the account cannot be recovered. **No upgrade path.** Accounts created before 1 October were not asked. |
| D10 | Legal documents and markets | Counsel. | Six draft legal pages exist, with placeholders. There is no server check that real-money mode matches an approved terms version, because there is no real-money mode. Target countries are not decided. Malta is the intended base named in the reviews. |
| D11 | Bots | Retire from production. Keep legacy tables only so seated players can finish. | New tables reject bots. `ENABLE_LEGACY_BOTS` defaults off: a bot's turn times out. Legacy bot tables stay visible to players still seated. |
| D12 | Unrecoverable hands | Void and refund, dual approval, an audit record. | **Open.** `pausedAt`, `TableIncident`, and `PAUSED` exist in the schema. On 7 October no server code used them to pause a broken table and refund it (CR-004). |

## Rake

The engine accepts `rakeBps` and `rakeCapChips`. The default is 0, and nothing in table creation sets a rake. Charging commission is an owner decision and is not recorded as taken. Zero rake must not be described as a commission system.

## Real money

No decision here authorizes deposits, custody, or redeemable chips. F01–F05 in the [29 September audit](../reviews/2026-09-29-backend-security-audit.md) are the prerequisites. The [ledger](../money/LEDGER.md) is unused by gameplay.
