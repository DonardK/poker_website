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
| D9 | Guests | Keep for play chips, age-gated, with an upgrade path. Remove before real money. | **Removed (owner, 2026-10-18): everyone signs up or signs in.** `POST /api/auth/guest` is gone (404). The account-security migration revoked live guest sessions (`GUEST_RETIRED`), and the edge refuses a guest session at authenticate, refresh and both socket checks. Guest rows stay (hand history references them); the `guest_` username prefix stays reserved. |
| D10 | Legal documents and markets | Counsel. | Six draft legal pages exist, with placeholders. Sign-up records the accepted terms version; when `TERMS_VERSION` changes, an existing account accepts the new version before the web app lets it play (`POST /api/auth/terms/accept`; the API itself does not yet refuse play on older terms). There is no server check that real-money mode matches an approved terms version, because there is no real-money mode. Target countries are not decided. Malta is the intended base named in the reviews. |
| D11 | Bots | Retire from production. Keep legacy tables only so seated players can finish. | New tables reject bots. `ENABLE_LEGACY_BOTS` defaults off: a bot's turn times out. Legacy bot tables stay visible to players still seated. |
| D12 | Unrecoverable hands | Void and refund, dual approval, an audit record. | **Open.** `pausedAt`, `TableIncident`, and `PAUSED` exist in the schema. On 7 October no server code used them to pause a broken table and refund it (CR-004). |
| D13 | Second factor | Offer and recommend TOTP and passkeys from sign-up; never force them; require a second factor for withdrawals when the account has one. | **Owner, 2026-10-18; edge API implemented 2026-10-19.** TOTP (with 10 backup codes) and passkeys are optional. A TOTP account's password sign-in also needs a code; a passkey with user verification signs in alone. Money actions need a single-use `StepUpGrant`: a passkey, the password plus a TOTP or backup code, or (only without either) the password plus an emailed code. There is no self-service 2FA reset by email: a user who lost the authenticator and the backup codes signs in with a passkey or goes through manual support. |
| D14 | Session lifetime | "Keep me signed in" on by default: 14 days idle, 30 days absolute. Off: a browser-session cookie, 12 h idle, 24 h absolute. Sensitive actions use a 5-minute step-up, not short sessions. | **Owner ("stay signed in"), 2026-10-18; implemented.** `SESSION_IDLE_TTL=14d`. Switching account is sign out, then sign in (the browser remembers up to 5 usernames, never passwords or tokens); a sign-in revokes the session of any refresh cookie sent with it. |
| D15 | Security hold | Hold withdrawals and payout-destination changes for 24 h after a credential change. | **Implemented** (`SECURITY_HOLD_HOURS`, default 24): password reset or change, email change, turning TOTP off and a "This wasn't me" lockdown set `User.securityHoldUntil`. Nothing pays out today (real money is off). |

## Rake

The engine accepts `rakeBps` and `rakeCapChips`. The default is 0, and nothing in table creation sets a rake. Charging commission is an owner decision and is not recorded as taken. Zero rake must not be described as a commission system.

## Real money

No decision here authorizes deposits, custody, or redeemable chips. F01–F05 in the [29 September audit](../reviews/2026-09-29-backend-security-audit.md) are the prerequisites. The [ledger](../money/LEDGER.md) is unused by gameplay.
