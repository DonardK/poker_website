# Real-money wallet

Status: **built and off.** The `poker-payments` Worker, the wallet and admin
routes on `poker-api`, the built-in sandbox provider and the database layer
exist. Production runs `PAYMENTS_MODE=off`, `poker-payments` is not deployed,
`poker-api` has no `PAYMENTS` binding (which means off), `EUR` is disabled and
every `PaymentSwitch` row is off. Play chips (`User.bankroll`) are unchanged
and have no cash value. Turning money on is the operator's
[runbook](PAYMENTS_RUNBOOK.md), after licence and contracts.

This file keeps the section numbers that code comments cite. The ledger
itself is [LEDGER.md](LEDGER.md); product decisions are D16-D22 in
[DECISIONS.md](../product/DECISIONS.md).

## 3. Topology

```
browser -> poker-web (public) -> poker-api (private, HYPERDRIVE = poker_server)
                                    | PAYMENTS service binding, entrypoint PaymentsRpc (typed RPC)
                                    v
providers -> poker-payments (workers.dev: POST /webhooks/:providerKey, GET /health,
                             sandbox pages outside production)
             HYPERDRIVE_PAYMENTS (poker_payments_app), DOs PayoutDispatcher + SandboxPsp,
             cron "* * * * *", provider secrets
```

- `apps/edge/wrangler.payments.jsonc`, main `src/payments/worker.ts`, same
  workspace and Prisma client as `poker-api`.
- `poker-api` never holds the payments Hyperdrive binding or a provider
  secret (`.github/workflows/support/assert-payments-config.mjs`). A
  compromised `poker-api` can only ask payments for what a signed-in player
  could, under rules payments enforces itself.
- No Worker holds the back-office login `poker_backoffice_app`.
- One cron (Free plan: five per account; `poker-api` uses one). It only kicks
  the `PayoutDispatcher` singleton (`payouts`, location hint `weur`); the
  dispatcher's alarm does one unit of work per tick, in turn: due webhook
  events, payout dispatch, the confirmed-credit retry, stale deposits, the
  email outbox, and after 03:15 UTC the daily reconciliation.

## 4. Database roles

| Group (NOLOGIN) | Login | Entry point | Types |
|---|---|---|---|
| `poker_server` | Supabase: itself; local: `poker_app` | `ledger_post` | `PLAY_GRANT`, `BUY_IN`, `CASH_OUT`, `RAKE` |
| `poker_payments` | `poker_payments_app` | `ledger_post_payments` | deposit and withdrawal types, `PROVIDER_FEE` |
| `poker_backoffice` | `poker_backoffice_app` | `ledger_post_backoffice` | `ADJUSTMENT` with a ticket and a second approver; for money, two administrators' recorded approvals of exactly that adjustment |

`ledger_post` moves `PLAY` assets only, and `TABLE_ESCROW` and `RAKE_REVENUE`
accounts exist only in `PLAY` (`LG022`, `LG014`): a compromised game API
cannot touch `TEST_EUR` or `EUR`. Phase 2 lifts this deliberately. The
back-office login reads review actions and writes none: approvals count
towards four-eyes rules, so only `poker_payments` records them, after an
admin passkey step-up.

Details, passwords and the Supabase pooler names:
[RUNTIME_ROLE.md](../../apps/server/prisma/RUNTIME_ROLE.md). The payments
role reads only the `User` and `Session` columns it needs, `AccountSecurityEvent`
(`id`, `userId`, `type`, `createdAt`) and `StepUpGrant`, and may update only
`StepUpGrant.consumedAt`.

### 9.1 Role isolation

Before its first money operation each payments isolate checks its login
(`src/payments/db.ts`): a member of `poker_payments`, not of `poker_server`
or `poker_backoffice`, unable to execute `ledger_post`, able to execute
`ledger_post_payments`, neither superuser nor `BYPASSRLS`. A failed check
refuses every money call and logs `PAYMENTS_ROLE_ISOLATION` (CRITICAL).
`GET /health` reports it.

## 5. Migrations

- `20261019110000_ledger_payment_types`: `CHARGEBACK_RECOVERY`,
  `WITHDRAWAL_RETURN`, asset kind `TEST`.
- `20261019120000_payments_wallet`: the roles, 16 tables (`PlayerCompliance`,
  `ResponsibleGamingLimit`, `SelfExclusion`, `PaymentInstrument`, `Deposit`,
  `DepositReversal`, `WithdrawalQuote`, `Withdrawal`, `PayoutDispatch`,
  `PayoutAttempt`, `PaymentEvent`, `PaymentReviewAction`, `PaymentSwitch`,
  `ReconciliationRun`, `ReconciliationIssue`, `EmailOutbox`), their guard
  triggers, the entry points, the payment-binding trigger, RLS (enabled and
  forced, narrow column grants) and the `TEST_EUR` asset. It writes no
  existing row; it inserts only `TEST_EUR` and the seven switches (off).

## 7. State machines

`src/payments/state.ts` holds the transition tables; the guard triggers are
the authority (PM003) and `apps/server/test/db/payments-schema.test.mjs`
proves the two equal. A SUBMITTED withdrawal ends only SETTLED or FAILED; a
deposit never moves backwards; a late verified success is still credited.

## 8. Ledger port

`apps/edge/src/money/`: `amounts.ts`, `flows.ts`, `ledger.ts` are
byte-identical to `apps/server/src/money/` (`npm run check:money -w @poker/edge`);
`keys.ts` builds every idempotency key; `tx.ts` (`moneyTx`) runs a payments
transaction (READ COMMITTED, retries, `SET CONSTRAINTS ALL IMMEDIATE` last)
and maps database refusals (LEDGER.md section 11).

## 9. Payments modules (`apps/edge/src/payments/`)

| Module | Role |
|---|---|
| `worker.ts` | `PaymentsRpc` (the RPC entrypoint), `fetch`, `scheduled`; exports both Durable Objects |
| `public.ts` | `/webhooks/:providerKey`, `/health`, sandbox pages |
| `runtime.ts`, `db.ts`, `context.ts` | one context per event: config, client, role isolation, providers, clock, `kick`, `defer` |
| `config.ts`, `env.ts` | vars and secrets, mode safety; a rail without usable secrets stays closed |
| `session.ts`, `stepup.ts` | re-check the caller's session; consume a grant inside the change's transaction |
| `gate.ts`, `compliance.ts`, `limits.ts` | switches, region, KYC, restrictions, deposit limits, self-exclusion |
| `deposits.ts`, `reversals.ts`, `inbox.ts` | 10.1-10.4 |
| `instruments.ts`, `crypto-address.ts` | 10.5 (BTC, EVM EIP-55, TRON) |
| `withdrawals.ts`, `rules.ts`, `dispatch.ts` | 10.6-10.9 |
| `admin.ts` | 10.8 and the back office (11.2) |
| `reconcile.ts`, `issues.ts` | 10.10 |
| `security.ts` | 10.11 |
| `notify.ts`, `emails.ts` | `EmailOutbox`, payment emails through `src/mail` |
| `kyc.ts`, `history.ts`, `views.ts`, `customer.ts`, `errors.ts` | KYC start, history, wire views, provider customer refs, refusals |
| `actors/payout-dispatcher.ts`, `actors/sandbox-psp.ts` | the two Durable Objects |
| `providers/registry.ts` | one adapter per rail from `CARD_PROVIDER_KEY` (`sandbox`/`nuvei`), `CRYPTO_PROVIDER_KEY` (`sandbox`/`bvnk`), `KYC_PROVIDER_KEY` (`sandbox`/`sumsub`) |
| `providers/sandbox.ts` | the built-in card, crypto and KYC simulator (`TEST_EUR` only) |
| `providers/{nuvei,bvnk,sumsub}` | the real adapters (each folder's README lists what is verified) |

### Sandbox provider

Keys `sandbox-card`, `sandbox-crypto`, `sandbox-kyc`; `TEST_EUR` only (the
database refuses anything else). State lives in the `SandboxPsp` Durable
Object, never in the payments database, and that object refuses to work
unless `PAYMENTS_MODE=sandbox` outside production. Webhooks carry ids only
(`X-Sandbox-Signature: t=<unix>,v1=<hex HMAC-SHA256(SANDBOX_WEBHOOK_SECRET, t + "." + body)>`,
300 s tolerance); the core re-reads the object, as for a real provider.

- Card: `GET|POST /sandbox/pay/:paymentId?sig=` shows outcome buttons, no
  card field: approve (debit, credit, prepaid), decline, abandon, and after
  approval chargeback or provider refund.
- Crypto: the same page for a fake address (`sbx:<asset>:<id>`): confirm,
  underpay by half (review), overpay by half (excess refund), expire, and
  after confirmation a chain reorganisation.
- KYC: `GET|POST /sandbox/kyc/:token` approves (with the identity typed in)
  or rejects; a sanctions match can be ticked.
- Payouts by the cents of the amount: `.01` declined, `.02` executed but the
  answer times out (the dispatcher queries and settles it), `.03` lost once
  (re-sent with the same key), `.04` processing for a minute, `.05` paid then
  returned after a minute, `.06` destination ineligible; anything else is paid.
- A sandbox payout address ending in `dead` screens SEVERE.

## 10. Flows

Lock order: PaymentEvent, PlayerCompliance, Deposit, DepositReversal,
Withdrawal (ascending id), PayoutDispatch, PaymentInstrument / quote /
StepUpGrant, then the ledger. No provider call inside a transaction.

- **10.1 Deposit:** gates, transaction A (compliance lock, limits, idempotency
  on `(userId, clientRequestId)`, INSERT CREATED), the provider session
  outside any transaction, transaction B (PENDING with the session, or
  FAILED). The redirect never confirms anything.
- **10.2 Webhook:** provider enabled for this mode, POST, at most 256 KB,
  `RL_WEBHOOK` by provider and IP, the optional CIDR allow-list, the
  signature on the raw bytes; every event is stored once (`UNIQUE (provider,
  providerEventId)`) and the answer is 200 only after that commit (503
  otherwise). Nothing unverified is stored.
- **10.3 Credit, exactly once:** the event is a hint; the provider's current
  state is re-read and applied under the event's row lock as a monotonic
  transition. The credit (`deposit-credit:<id>`) is bound to the Deposit row
  by the database; anything over a deposit limit, or all of it for a
  self-excluded or restricted player or a refused card type, is credited and
  held for refund at once. When a payment goes to review, what the provider
  reported is stored once (`Deposit.reportedMinor`): a person credits at most
  that, a card at most the requested amount, and the database holds the same
  line.
- **10.4 Disputes:** chargeback, provider refund or chain reorganisation
  cancel undispatched withdrawals first, then take what the balance covers
  (the rest is `CHARGEBACK_LOSSES`) and freeze the account; a won dispute
  restores the proportional part.
- **10.5 Payout address:** validated and normalised, then added only with a
  `payout_destination` grant bound to `stepUpBind(payoutDestinationAction)`;
  usable after a cooling-off (the database floor is 24 h); an email with a
  "This wasn't me" link. A card a deposit saves is a new payout destination
  too: same floor, same email (a small deposit with someone else's card is no
  shortcut). A card receives at most what it deposited, less refund holds,
  reversals and what already went back to it (`CARD_PAYOUT_LIMIT`, checked at
  the quote and again under the compliance lock); the rest needs a cooled-off
  address. The limit has no clock. A payout that failed, was cancelled or came
  back does not count, and neither does a refund that was not sent. A revoked
  instrument stays revoked: paying with that card again proves possession and
  adds a new row, with a fresh cooling-off and email, and every row of one card
  (same player and provider, same token or fingerprint) counts as one card.
  Refunds to source do not wait. A card token another player holds still names
  the deposit, on a row of this player that can neither deposit nor take a
  payout (`CARD_SHARED` note). A credited card deposit always names its card
  (the `Deposit_valid` CHECK): a payment the provider names no card for goes to
  review as `CARD_UNKNOWN` and can only be failed and refunded at the provider.
  A deposit that names a saved card must be paid with that card (same token, or
  same fingerprint when both are known): paid with another, it goes to review as
  `CARD_MISMATCH`, is never credited to the named card (whose payout room it
  would become) and can only be failed and refunded at the provider.
  After a lockdown, two administrators can bring back one named revoked card
  (`POST /api/admin/users/:userId/instruments/:id/restore`, a grant for
  `instrument:<id>` / `RESTORE`, the card's newest row only, not during the
  player's security hold, never a card another account also holds): a new row,
  a fresh 24 h cooling-off and the email. Nothing is restored in bulk, so an
  attacker's card stays revoked.
- **10.6 Withdrawal:** a quote (120 s) whose bind is
  `stepUpBind(withdrawalAction({ userId, asset, instrumentId, amountMinor, feeMinor, quoteId }))`,
  then the request consumes the quote and a `withdrawal` grant for that
  bind, holds the amount (`LG011` rolls everything back) and applies the
  rules. Limits: 5 requests per 24 h, 3 open.
- **10.7 Rules** (`rules.ts`, `wr-2026-10-21`): any reason means manual
  review; two approvals at `DUAL_APPROVAL_MIN`, for high risk, a shared
  destination, and for every manual withdrawal in live mode. In Phase 1
  `LOW_PLAY` is always present, so every withdrawal is reviewed.
- **10.8 Admin:** Access (required in live mode), a live session, `ADMIN`,
  and a passkey `admin_payments` grant bound to
  `adminPaymentsAction({ subject, decision })` for every change. A security
  hold stops admin grants too (poker-api refuses the grant, payments the
  decision). Crediting a deposit under review takes two admins naming the same
  amount in live mode. A freeze cancels what has not been sent, in its own
  transaction. On their own account an administrator can only freeze: any
  other restriction change there is 409 `SELF_APPROVAL` (it could loosen what
  a colleague or a lockdown set). A screening decision has a route of its own
  (`POST /api/admin/users/:userId/screening`, grant `user:<id>` /
  `SCREENING:<status>`): a match takes one administrator and acts like a hit
  from the KYC provider; `CLEAR` takes two, both after the last screening
  change, and lifts the match only, never a freeze. Never on one's own account.
- **10.9 Dispatch:** one provider idempotency key per withdrawal for life; an
  uncertain answer never releases the hold; it is queried first; two
  NOT_FOUND answers 10 minutes apart allow a re-send with the same key only
  for a provider that dedupes on it; after 24 h of uncertainty two admins
  resolve it with evidence. A "failed, then paid" payout raises a CRITICAL
  issue and is never posted automatically. Before every send the player is
  read again under lock: `FROZEN`, KYC or screening no longer good, an active
  security hold, or `WITHDRAWALS_MANUAL` without a staff approval after it. A
  first send is then cancelled with its release; one already attempted goes to
  `MANUAL`. A refund that returns a card deposit to its own card stops only for
  a screening hit. Every other refund (a crypto refund to the address an
  administrator named) went where someone chose, so it is a payout in all but
  name: it stops for all of the above, and also when its destination is no
  longer active. Money is sent only to an active destination, the source card
  of a card refund excepted; the database refuses to submit anything else
  (`PM010`). The queues take
  only rows of this Worker's providers, so a sandbox Worker that shared a
  database with the live one would not touch them.
- **10.10 Reconciliation:** daily LEDGER, PAYMENTS, PROVIDER and CUSTODY
  checks write `ReconciliationIssue` rows, each kind once a day after 03:15
  UTC, per Worker (`summary.scope`, the settlement asset: a sandbox Worker on a
  shared database neither uses up the live day's run nor reports on live rows).
  A check that failed or crashed gets three tries a day, 30 minutes apart. A
  check that could not run never reads as OK: a provider with no settlement
  report raises `SETTLEMENT_CHECK_NOT_RUN` (WARN), so the run is `ISSUES`.
- **10.11 "This wasn't me":** protection does not depend on whether money can
  move, so a lockdown has two steps. The first posts nothing and commits on its
  own: `WITHDRAWALS_MANUAL`, every destination added in the 72 h before the
  report (addresses and cards) or since is revoked, and the one the email named,
  whatever its age; unconsumed grants are voided, and every undispatched
  withdrawal is marked for cancelling (`Withdrawal.cancelRequestedAt`,
  `cancelCode`). From then on the database refuses to approve or submit it, and
  the dispatcher cancels it instead of sending. The second step releases those
  holds, one transaction each. It cannot post during an emergency stop; the
  dispatcher's `cancels` task retries it (`settleRequestedCancels`). A freeze, a
  sanctions or PEP hit and a chargeback use the same marker, and the restriction
  of a reversal commits before the reversal is tried. It runs after an account
  lockdown (`src/auth/lockdown.ts` `onAccountLockdown`) and from the links in the
  destination-added and withdrawal-requested emails. `POST /api/wallet/not-me`
  first checks the link (itself, when `poker-api` holds `NOTIFY_LINK_SECRET`, so
  a payments outage cannot stop it; otherwise it asks payments), then ends every
  session, sets the security hold and records `NOT_ME_REPORTED` in one
  transaction, and only then asks payments, after the response. Both paths are
  durable the same way: the event is the record, and the dispatcher applies any
  report with no lockdown recorded for it (`applyPendingLockdowns`,
  `metadata.reportId` on the review action), so a report is applied once and a
  payments outage cannot lose it. A link works once: the same notice reported
  again answers `{ secured: true }` and changes nothing, so a link mailed to an
  address an attacker set cannot sign the owner out and renew the hold over and
  over. And like the account lockdown's own links, a link sent at or after the
  incident of a later account lockdown is 400 `TOKEN_INVALID` (it may have gone
  to the attacker); one sent before it still works. Both checks run under the
  user's row lock. A lockdown and a freeze also stop a refund to an address an
  administrator named. It keeps what the notice named, and the 72 h
  run back from the report, not from the retry. A report that fails is tried
  again in random order with the others, so it holds no place in the queue, and
  logs `PAYMENTS_LOCKDOWN_RETRY_FAILED`. A sanctions or PEP hit stops what has
  not been sent, refunds included, and a confirmed match freezes the account.
  While a match is on record no deposit starts either (`ACCOUNT_RESTRICTED`):
  that money could not come out. In live mode the Sumsub rail stays closed
  unless `SUMSUB_SCREENING_INCLUDED=true`, because without screening nothing
  would set `CLEAR`, and verified players could deposit but never withdraw.
  Self-exclusion cancels open deposits; withdrawals stay open. It stays in force
  after `endsAt` until the player asks to come back: a timed one reopens 24 h
  after the request with no operator involved, an indefinite one 7 days after an
  administrator accepts. The database sets those times (`self_exclusion_guard`).
- **Refunds:** a card deposit's refund is bound to that deposit's card and
  provider when it is held, and goes back automatically unless the card was
  revoked, when a person approves it. A crypto deposit's source address is not
  known and is never guessed: approving needs one of the player's active payout
  addresses, past its cooling-off, named as `refundInstrumentId` (the grant's
  decision is `APPROVE:<id>`; a second administrator names the same one).
  Without it the answer is 409 `REFUND_DESTINATION_REQUIRED`. An address is not
  named while the account could not withdraw: frozen, KYC or screening not
  clear (409 `ACCOUNT_RESTRICTED`), or on a security hold (`SECURITY_HOLD`). The email asks the
  player to add an address; a rejection returns the money to their balance.
- **Emergency stop:** `Asset.enabled` false, or `PAYOUT_DISPATCH` off. Before
  any send (a first payout, a retry, a refund) the dispatcher reads both, under
  the row's locks. While stopped nothing is sent, the row and the hold stay
  exactly as they are, and it goes out when the stop lifts. Payouts the provider
  already has are still followed (status reads and webhooks); an outcome that has
  to post waits, and is read again. A confirmed deposit stays `CONFIRMED` and is
  credited after. An event that cannot post is parked and spends no attempt.

## 11. HTTP and RPC

Bodies and codes are `packages/shared/src/wallet.ts` (`WALLET_ERROR_STATUS`).
Errors are `{ error, code, details?, retryable? }`. A step-up failure is 403
`STEP_UP_REQUIRED` with `purpose`, `bind` and `methods`, never 401. Routes
marked "key" need `Idempotency-Key: <uuid v4>` (400
`IDEMPOTENCY_KEY_REQUIRED`); the same key with another body is 409. Adding a
crypto address is the exception: its single-use step-up grant is the
idempotency key of that route. The header is required but not stored; a replay
with the same grant and address answers the first result, and anything else
with that grant is 403 `STEP_UP_REQUIRED`, because the grant is spent.
A path with a percent escape is 400 before anything else, and rate limits,
the access log and the origin checks all read one canonical path (lower case,
no doubled or trailing slash).
Without the `PAYMENTS` binding every money route is 403 `REAL_MONEY_DISABLED`.

### 11.1 Player (`apps/edge/src/http/wallet.ts`)

| Route | Body -> response |
|---|---|
| `GET /api/wallet` | -> `WalletSummary` (`mode: "off"` and play chips only without the binding) |
| `GET /api/wallet/transactions?cursor&limit` | -> `{ items, next }` |
| `POST /api/wallet/deposits` (key) | `{ method: "CARD", amount, instrumentId?, saveCard? }` or `{ method: "CRYPTO", amount, payAsset }` -> 201 `{ deposit, next }` (200 on replay) |
| `GET /api/wallet/deposits/:id`, `POST .../cancel` | -> `{ deposit }` |
| `GET /api/wallet/instruments` | -> `{ instruments }` |
| `POST /api/wallet/instruments/crypto/prepare` | `{ asset, address, memo? }` -> `{ normalized, bind, ownershipChallenge }` |
| `POST /api/wallet/instruments/crypto` (key, grant) | `{ asset, address, memo?, label?, stepUpGrantId, ownership? }` -> 201 `{ instrument }` |
| `DELETE /api/wallet/instruments/:id` | -> 204 |
| `POST /api/wallet/withdrawals/quote` | `{ instrumentId, amount }` -> `{ quote, stepUp }` |
| `POST /api/wallet/withdrawals` (key, grant) | `{ quoteId, stepUpGrantId }` -> 201 `{ withdrawal }` |
| `GET /api/wallet/withdrawals?cursor`, `GET .../:id`, `POST .../:id/cancel` | -> `{ withdrawals, next }` / `{ withdrawal }` |
| `GET /api/wallet/limits`, `POST /api/wallet/limits` | `{ period, amount | null }` -> `{ deposit }` (written by poker-api; the database sets the timing) |
| `POST /api/wallet/kyc/session` | -> `{ provider, sdkToken, expiresAt, url? }` |
| `POST /api/wallet/not-me` (no session) | `{ token }` -> `{ secured: true }`; 400 `TOKEN_INVALID` |
| `POST /api/account/self-exclusion` | `{ period }` -> 201 `{ id, kind, startsAt, endsAt }` |
| `GET /api/account/self-exclusion` | -> `SelfExclusionStatus` (`active`, `kind`, `endsAt`, `canRequestReturn`, `requestedAt`, `accessRestoredAt`) |
| `POST /api/account/self-exclusion/reactivation` | -> `SelfExclusionStatus`; 409 `EXCLUSION_NOT_ENDED` (`details.endsAt`) or `INVALID_STATE` |

The two grant routes also answer 403 `EMAIL_NOT_VERIFIED` or `SECURITY_HOLD`
before payments is asked. Every POST and DELETE under `/api/wallet/` shares
`RL_CREDENTIALS` by account (`wallet:user:<id>`); `/api/wallet/not-me` by IP.

### 11.2 Admin (`apps/edge/src/http/admin-payments.ts`)

The existing admin guard (Access when configured, session, `ADMIN`,
`ADMIN_REQUIRE_PASSKEY`), `RL_ADMIN` and the admin access log, then an
`AdminCaller` with the `Cf-Access-Jwt-Assertion` header. Every POST carries
`stepUpGrantId` for subject/decision: `withdrawal:<id>` `APPROVE` / `REJECT`
/ `RESOLVE_SETTLED` / `RESOLVE_FAILED`; `deposit:<id>` `CREDIT:<minor>` /
`FAIL`; `user:<id>` `RESTRICT:<restriction>` / `SCREENING:<status>`; `switch:<key>` `ON` / `OFF`;
`issue:<id>` `ACKNOWLEDGED` / `RESOLVED`; `event:<id>` `REQUEUE`;
`custody:<asOf ISO>` `SNAPSHOT:<minor>`. Without one the answer is 403
`STEP_UP_REQUIRED` with the bind to step up for. A deposit `CREDIT` answers
`{ deposit, approvalsRemaining }`: in live mode the first administrator leaves
the deposit under review, and `creditAmount` above `reportedAmount` (for a
card, above the requested amount) is 422.

`GET|POST /api/admin/payments/withdrawals[/:id[/approve|/reject|/resolve-uncertain]]`,
`GET /api/admin/payments/deposits`, `POST .../deposits/:id/resolve`,
`GET /api/admin/users/:userId/ledger`, `POST /api/admin/users/:userId/payments-restriction`,
`POST /api/admin/users/:userId/screening` (`{ status, reason, stepUpGrantId }` -> `{ compliance, approvalsRemaining }`),
`GET|POST /api/admin/payments/switches`, `GET .../reconciliation/runs`,
`GET .../reconciliation/issues`, `POST .../reconciliation/issues/:id/resolve`,
`GET .../events`, `POST .../events/:id/requeue`, `POST .../custody-snapshot`,
`POST /api/admin/users/:userId/instruments/:id/restore`,
`GET /api/admin/payments/self-exclusions`, `POST .../self-exclusions/:id/accept`.

A security hold on an administrator stops every grant except for what can
only stop money (`isAdminSafetyAction`: a switch OFF, a freeze). For those,
`POST /api/auth/step-up` takes `safetyAction: { subject, decision }` and
recomputes the bind from it. They stay one administrator, always, with a
grant and an audit row.

### 11.3 poker-payments public routes

`POST /webhooks/:providerKey` (200, 401, 403, 404, 405, 413, 429, 503),
`GET /health` -> `{ ok, mode, settlementAsset, roleIsolation }`, the sandbox
pages (only `PAYMENTS_MODE=sandbox` outside production, CSP
`frame-ancestors 'none'`, same-origin form posts). Everything else is 404.

### 11.4 RPC

`src/payments/contract.ts` `PaymentsApi`: player methods take a `Caller`
(`userId`, `sessionId`, `requestId`, `ip`, `ipCountry` from `cf.country`,
`userAgent`), admin methods an `AdminCaller` (+ `accessJwt`), and
`securityLockdown` a `SystemCaller` (`userId`, `requestId`) and the report
(`{ id, at, notice }`, the security event poker-api committed first). Every
method answers `RpcResult` and never throws a refusal; creates add `replay`.
`verifyNotMeToken(token)` answers what a link names (`u`, `k`, `s` and its
expiry `e`) and changes nothing.

## 12. Gate

Money moves only when `PAYMENTS_MODE` is `sandbox` or `live`, the settlement
asset (`TEST_EUR` in sandbox, `EUR` live) is enabled, the flow's
`PaymentSwitch` is on, and the player passes the compliance gates. The
emergency stop is `UPDATE "Asset" SET "enabled" = false WHERE "code" = 'EUR';`
(nothing is sent; webhooks keep landing in the inbox; credits and outcomes wait
and apply after re-enable; see the emergency stop in section 10).

## 13. Real-money tables

Phase 2, not in this program (D18).

## 14. Tests

| Where | What |
|---|---|
| `apps/edge/test/payments/*.unit.test.ts` | rules (each reason alone, dual approval), crypto addresses, limits, sandbox signatures and payout scenarios, config, state tables, ledger port and error mapping |
| `apps/edge/test/payments/flows.db.test.ts` | real Postgres, both logins: exactly-once credit under concurrent webhook replays, forged and stale signatures, prepaid refund hold, chargeback, crypto underpayment, a credit over the limit (excess refund-held), a payment after self-exclusion (refunded in full), concurrent deposits against a daily limit, limit raise and cut timing, Idempotency-Key replay and conflict, `TEST_EUR` isolation, no double spend of a balance or a quote, grant mismatch / other session / expired / wrong purpose / reuse, security hold, admin approval and self-approval, settle, uncertain payout queried not re-sent, a lost payout re-sent with the same key only after two NOT_FOUND 10 minutes apart, 24 h MANUAL resolved by two admins, declined and returned payouts, concurrent dispatch units, a chargeback after a payout (house loss) and the won dispute, destination step-up and cooling-off, lockdown, the destination a report names, a lockdown payments never heard about, one report applied once, the 72 h from the report, a failing report holding no slot, a new card's cooling-off, email and closed-loop limit (no clock, one card across rows, failed payouts), a revoked card and a fresh deposit, a shared token, a payment with no card, restoring one named card, refunds to source, the way back from a self-exclusion, the ceiling and the second administrator on a reviewed credit, the player re-read before every send (freeze, hold, screening, manual restriction, an attempted send goes to a person, a refund still leaves), a refund to an address an administrator named stopped like a payout (lockdown, freeze, hold, revoked address, the database's `PM010`), an administrator's own restriction, screening decided by a person, a deposit paid with another card than the one it named, a screening hit from the KYC provider, provider redirect hosts, queues limited to this Worker's providers, unanswered travel-rule requests, UTC trigger clocks |
| `apps/edge/test/wallet-http.test.ts` | poker-api routes with a mocked `PAYMENTS` binding; a payments not-me link works once and is void after a later account lockdown |
| `apps/edge/test/payments-worker/worker.test.ts` | the poker-payments Worker (`vitest.payments.config.ts`): the RPC surface is exactly `PaymentsApi`, health, 404/401/405/413, mode off, refused config, a full sandbox journey through the pages, the dispatcher alarm |
| `apps/edge/test/payments-worker/emergency-stop.db.test.ts` | the stop on the real database (one file at a time, after the API project): nothing sent for a first send, a retry or a refund, by either switch, read again under the lock; status reads go on; outcomes, deposits and events wait; a lockdown, freeze, screening hit and chargeback commit during a stop; a named crypto refund marked during a stop is cancelled after it; a held administrator's safety actions |
| `apps/edge/test/payments-worker/reconcile.db.test.ts` | every kind once a day, retries, a check that did not run, a seeded mismatch per kind, rows of another environment |
| `apps/server/test/db/payments-schema.test.mjs`, `supabase-shape.test.mjs` | triggers, grants, Supabase-shaped migration rehearsal |

## 15.2 Enabling live money

See the [runbook](PAYMENTS_RUNBOOK.md). All must be true: licence and
contracts; the payments login, Hyperdrive and secrets; `poker-payments`
deployed in live mode with Access; the `PAYMENTS` binding on `poker-api`;
admin passkeys; `EUR` enabled; the switches on (two admins), `AUTO_APPROVE`
last.
