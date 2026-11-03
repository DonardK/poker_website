# Payments runbook (operator)

Real money is off: `PAYMENTS_MODE=off`, `poker-payments` not deployed, no
`PAYMENTS` binding on `poker-api`, `EUR` disabled, every `PaymentSwitch` off.
Nothing here is done by CI: a push to `main` deploys `poker-api` and
`poker-web` only, and only dry-runs `poker-payments`. Design: [WALLET.md](WALLET.md).

Commands run from `apps/edge`. Never put a password or secret in a
`wrangler*.jsonc` file or a migration.

The first deploy of the wallet migrations: pre-checks and what to do when one
fails are in [DEPLOY.md, "Deploying the wallet migration"](../cloudflare/DEPLOY.md#deploying-the-wallet-migration).

## 1. Preview (sandbox, `TEST_EUR` only)

1. Database login: `ALTER ROLE poker_payments_app WITH LOGIN PASSWORD '<new random>';`
   on the preview database (as the migration owner). It has no password
   until then and cannot log in.
2. Hyperdrive for it, caching disabled, through the session pooler
   (`poker_payments_app.<project-ref>`):
   `npx wrangler hyperdrive create poker-payments-preview --connection-string="postgres://..." --caching-disabled`.
   Put the id in `env.preview.hyperdrive` of `wrangler.payments.jsonc`
   (replacing `<PREVIEW_PAYMENTS_HYPERDRIVE_ID>`) and fill the two
   `<subdomain>` origins.
3. Secrets: `npx wrangler secret put SANDBOX_WEBHOOK_SECRET -c wrangler.payments.jsonc --env preview`
   (32+ random characters), the same for `NOTIFY_LINK_SECRET`; optionally
   `RESEND_API_KEY` with `MAIL_FROM`. Put the same `NOTIFY_LINK_SECRET` on
   `poker-api-preview` too (`npx wrangler secret put NOTIFY_LINK_SECRET --env preview`).
4. Deploy: `npx wrangler deploy -c wrangler.payments.jsonc --env preview`.
   Check `GET https://poker-payments-preview.<subdomain>.workers.dev/health`
   answers `{"ok":true,"mode":"sandbox","settlementAsset":"TEST_EUR","roleIsolation":true}`.
5. Bind it to `poker-api-preview`: add to `env.preview` of `wrangler.jsonc`
   `"services": [{ "binding": "PAYMENTS", "service": "poker-payments-preview", "entrypoint": "PaymentsRpc" }]`
   and redeploy the preview API.
6. Switches: as an admin with a passkey, `POST /api/admin/payments/switches`
   for each flow (one admin is enough in sandbox). `TEST_EUR` is enabled by
   the migration.

## 2. Production (live money)

Only after the licence (MGA B2C Type 3), the card acquirer, the crypto CASP
(on ESMA's MiCA register), the KYC vendor and a segregated player-funds
account exist. Counsel decides; engineering does not.

1. `ALTER ROLE poker_payments_app WITH LOGIN PASSWORD '<new random>';` on
   Supabase. Never reuse the runtime password.
2. A second Hyperdrive config, caching disabled, session pooler, user
   `poker_payments_app`; its id replaces `<PAYMENTS_HYPERDRIVE_ID_CACHE_DISABLED>`
   in `wrangler.payments.jsonc`. It must never be bound to `poker-api`
   (`assert-payments-config.mjs` refuses that).
3. Secrets (`npx wrangler secret put <NAME> -c wrangler.payments.jsonc`):
   `NOTIFY_LINK_SECRET`, `RESEND_API_KEY`; Nuvei `NUVEI_MERCHANT_ID`,
   `NUVEI_MERCHANT_SITE_ID`, `NUVEI_SECRET_KEY`; BVNK `BVNK_WALLET_ID_EUR`,
   `BVNK_HAWK_AUTH_ID`, `BVNK_HAWK_AUTH_KEY`,
   `BVNK_WEBHOOK_SECRET`; Sumsub `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`,
   `SUMSUB_WEBHOOK_SECRET`, `SUMSUB_LEVEL_NAME`. A rail with a missing, short
   or reused secret stays closed; the others work. Put the same
   `NOTIFY_LINK_SECRET` on `poker-api` (`npx wrangler secret put NOTIFY_LINK_SECRET`):
   with it, the "This wasn't me" link in a payments email secures the account
   even while `poker-payments` is down; without it that link depends on
   `poker-payments` answering. It only ever proves such a report.
4. Vars: `PAYMENTS_PUBLIC_ORIGIN` (this Worker's workers.dev origin),
   `REAL_MONEY_COUNTRIES`, `BVNK_ASSET_MAP` (our asset codes to BVNK's pay
   currencies and networks), `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`
   (`ADMIN_REQUIRE_CF_ACCESS` is already `true`), `NUVEI_IDEMPOTENCY_CONFIRMED`
   once Nuvei confirms `clientRequestId` dedupe, and
   `SUMSUB_SCREENING_INCLUDED=true` for a Sumsub level that includes AML and
   sanctions screening. In live mode the Sumsub rail stays closed without it
   (`PAYMENTS_PROVIDER_CLOSED`): a level without screening means nothing sets a
   player's screening to CLEAR, so players could deposit and never withdraw.
   Confirm with Sumsub that GREEN on that level means screening passed. Then
   `PAYMENTS_MODE=live`.
   The Worker refuses to run live without Access, with a sandbox provider,
   outside `ENVIRONMENT=production` or with an empty country list.
5. Deploy: `npx wrangler deploy -c wrangler.payments.jsonc --env=""`; check
   `/health` (`mode: "live"`, `roleIsolation: true`).
6. Register the webhook URLs with each provider:
   `https://<payments origin>/webhooks/nuvei`, `/webhooks/bvnk`,
   `/webhooks/sumsub`. Optionally restrict by source:
   `WEBHOOK_IP_ALLOWLIST={"nuvei":["31.207.2.0/23","52.16.211.57/32"]}`
   (check the provider's current list).
7. Bind it to `poker-api`: add to the top level of `wrangler.jsonc`
   `"services": [{ "binding": "PAYMENTS", "service": "poker-payments", "entrypoint": "PaymentsRpc" }]`
   and push (the production deploy then ships it). Without that binding the
   wallet shows "coming soon" whatever payments says.
8. Admins: every admin registers a passkey (admin decisions accept passkey
   grants only) and signs in through Cloudflare Access. A security hold
   applies to admins too: after a password or factor change that admin signs
   nothing that adds risk until it ends, so keep a second admin ready. Turning
   a switch off and freezing an account stay possible, with a grant, whatever
   the hold.
9. `UPDATE "Asset" SET "enabled" = true WHERE "code" = 'EUR';` (database admin).
10. Switches, two admins each in live mode: `WITHDRAW_CARD`,
    `WITHDRAW_CRYPTO`, `PAYOUT_DISPATCH`, then `NEW_INSTRUMENTS`,
    `DEPOSIT_CARD`, `DEPOSIT_CRYPTO`, and `AUTO_APPROVE` last (in Phase 1
    every withdrawal is reviewed anyway).

### Blockers before go-live

Open items a licence review must see, with why each is open:

- **Identity-wide self-exclusion.** An exclusion applies to the account, not to
  the person, so someone excluded can open a second account and pass KYC with
  the same identity. `PlayerCompliance` holds no stable identity key: names,
  birth date and country are not unique or stable, and `kycApplicantRef` differs
  per account. Do not match on those. Blocked until the KYC provider gives a
  stable identifier (a document or duplicate-applicant result) to store and check.
- **The self-exclusion form.** The API takes a self-exclusion
  (`POST /api/account/self-exclusion`), and the limits page shows one and the way
  back, but no page lets a player start one yet.
- **BVNK** needs a postal address in the KYC data for travel-rule answers; until
  then an information request becomes a `TRAVEL_RULE_UNANSWERED` issue for a person.
- **Nuvei card fingerprint.** `uniqueCC` comes from `/getUserUPOs` and must be
  confirmed in the sandbox. Where it is missing, `DESTINATION_SHARED` cannot see a
  card shared between accounts, and one card with two tokens counts as two cards
  (see `src/payments/providers/nuvei/README.md`).
- **Provider settlement reports.** No adapter has `listSettlement`, so the daily
  PROVIDER check does not run and raises `SETTLEMENT_CHECK_NOT_RUN`. Until an
  adapter has one, compare the provider's settlement file by hand.
- **Winnings on a card-only site.** A card receives at most what it deposited.
  Real-money tables are Phase 2, so there are no winnings yet; with tables, the
  rest needs an address, and so a crypto rail or a bank payout.

## 3. BVNK IP allow-listing

BVNK accepts payout calls only from allow-listed IPs; Workers egress is not a
fixed address. Options:

- `PAYMENTS_EGRESS_MODE=relay` with `PAYMENTS_EGRESS_RELAY_URL`: the adapter
  sends every BVNK call to the relay origin with the same path, Hawk-signed
  for BVNK's host (see `src/payments/providers/bvnk/README.md`). The relay is
  a small forwarder on a fixed IP (a VM or a static-egress proxy) that passes
  the request to `api.bvnk.com` unchanged; it holds no secret. Restrict it to
  that host and to requests from the Worker. Give BVNK the relay IP.
- `direct`, only if BVNK allow-lists Cloudflare's egress for the account.

Deposits and webhooks do not need the allow-list; payouts fail closed
(retryable rejection, the hold stays) until egress works.

## 4. Emergency stop

- Everything: `UPDATE "Asset" SET "enabled" = false WHERE "code" = 'EUR';`.
  Every EUR posting stops at once, no payout or refund is sent to a provider,
  and deposits and quotes answer `PAYMENTS_PAUSED`. A withdrawal that was about
  to be sent stays as it is, with its hold, and goes out when the stop lifts.
  Payouts a provider already has are still followed: status reads and webhooks
  go on, and an outcome that has to post waits and is read again. Webhooks keep
  landing in the inbox, without using up their attempts, and credits wait as
  CONFIRMED; re-enable and the sweeper applies them. Lockdowns, freezes and
  screening hits still take effect at once; the holds they release follow after
  re-enable.
- One flow: `POST /api/admin/payments/switches { key, enabled: false, reason, stepUpGrantId }`
  (OFF needs one admin, always, even during that admin's own security hold: send
  `safetyAction: { subject: "switch:<key>", decision: "OFF" }` with the step-up),
  for example `PAYOUT_DISPATCH` off while deposits continue. With it off nothing
  is sent, exactly as above, and in-flight payouts are still followed.
- One account: `POST /api/admin/users/:userId/payments-restriction` with
  `FROZEN` is the same: one admin, always (`safetyAction: { subject: "user:<id>",
  decision: "RESTRICT:FROZEN" }` during a hold).
- The Worker: set `PAYMENTS_MODE=off` and redeploy `poker-payments`; every
  money call answers `REAL_MONEY_DISABLED`, the cron and the dispatcher idle.
- A suspected key leak: rotate the provider secret at the provider and with
  `wrangler secret put` (Nuvei and BVNK accept a `_PREVIOUS` secret while
  webhooks rotate), then check `ReconciliationIssue` and the provider portal.

## 5. Uncertain payout

The dispatcher never re-sends blindly and never releases the hold on an
uncertain answer. It queries the provider at +1, +5, +15, +60 minutes, then
hourly; after 24 hours the dispatch is `MANUAL` with a CRITICAL
`PAYOUT_MANUAL` issue.

1. Find it: `GET /api/admin/payments/withdrawals/:id` (attempts, dispatch
   status, provider payout id).
2. Check the provider portal (and the chain for crypto) by our idempotency
   key `wd_<withdrawalId>` (`rf_` for a refund).
3. Two different admins each `POST .../withdrawals/:id/resolve-uncertain`
   with the same outcome and evidence (`providerPayoutId`, `txHash` or a
   statement line): `SETTLED` books the payout, `FAILED` releases the hold
   back to the player.
4. A payout the provider reports paid after it was released raises
   `PAYOUT_AFTER_RELEASE` (CRITICAL). Nothing is posted automatically: the
   back office recovers it with an `ADJUSTMENT` (ticket and a second
   approver, through the `poker_backoffice_app` login; the CLI for it is an
   open item), never through the Worker.

## 6. Chargeback

Automatic on the provider's dispute event: undispatched withdrawals are
cancelled first, the player's available balance covers what it can, the rest
is `CHARGEBACK_LOSSES`, the account is `FROZEN` and an email goes out.

1. Review the player: `GET /api/admin/users/:userId/ledger`, their deposits
   and the provider's case.
2. Contest at the provider if appropriate. A won dispute
   (`CHARGEBACK_RECOVERY`) restores the proportional part automatically.
3. Lift the restriction only after review:
   `POST /api/admin/users/:userId/payments-restriction { restriction: "NONE", reason, stepUpGrantId }`.

## 7. Refunds, restored cards, self-exclusion

- **A refund under review** (`GET .../withdrawals`, `REFUND_TO_SOURCE`). A card
  refund goes back to its own card: approve it. A crypto deposit's source address
  is not known and is never guessed: ask the player to add a payout address (the
  email asks them too), wait out its cooling-off, then approve with
  `refundInstrumentId`; in live mode both admins name the same one. Without one
  the answer is 409 `REFUND_DESTINATION_REQUIRED`. That refund goes where the
  player chose, so it is treated as a withdrawal: it cannot be approved while the
  account is frozen, on a security hold or not KYC and screening clear (409
  `ACCOUNT_RESTRICTED` / `SECURITY_HOLD`), and a lockdown, a freeze or a revoked
  address stops it before it is sent. For a frozen account, decide the freeze
  first; if the money must go back while it stays frozen, refund in the
  provider's portal and record it as a back-office `ADJUSTMENT` (two approvers,
  see section 5). If the player will not add one,
  reject the refund: the money goes to their balance, and withdrawals stay open
  during a self-exclusion. This is how "refunds anything that still arrives" stays
  true for crypto: a payout, or this step.
- **A card deposit `CARD_UNKNOWN`.** The provider named no card, so it cannot be
  credited. Fail it and refund it in the provider's portal.
- **A card deposit `CARD_MISMATCH`** (alert `PAYMENT_CARD_MISMATCH`). The deposit
  named one of the player's saved cards but was paid with another. It cannot be
  credited: crediting it would let the other card's money go out to the named
  card. Fail it, refund it in the provider's portal, and look at the account (a
  stolen card is the usual reason).
- **After a lockdown** the player may have money, a revoked card and no address.
  Lift the restriction after review, then two admins each
  `POST /api/admin/users/:userId/instruments/:id/restore { reason, stepUpGrantId }`
  (subject `instrument:<id>`, decision `RESTORE`) for the one card the player
  owns; check it with them first. It comes back as a new row with a 24-hour
  cooling-off and an email. Never restore a card you have not checked: nothing
  restores in bulk, and the attacker's card must stay revoked. A card that is
  also on another account is refused (409 `INVALID_STATE`): it never takes
  payouts here. A player can also simply pay with their card again, which adds
  it back with the same cooling-off.
- **Self-exclusion.** A timed one stays in force after it ends, until the player
  asks to come back on the limits page; deposits reopen 24 hours later and no one
  here is involved. An indefinite one: `GET /api/admin/payments/self-exclusions`,
  review, then `POST .../self-exclusions/:id/accept { note, stepUpGrantId }`
  (subject `self-exclusion:<id>`, decision `ACCEPT`); deposits reopen 7 days later.
- **Screening decisions.** A match is never lifted automatically, even by a
  later passed review. A person decides through
  `POST /api/admin/users/:userId/screening { status, reason, stepUpGrantId }`
  (subject `user:<id>`, decision `SCREENING:<status>`), audited like every other
  decision. `POTENTIAL_MATCH` or `CONFIRMED_MATCH` takes one admin and acts like a
  hit from the provider: unsent withdrawals and refunds stop, deposits close, and
  a confirmed match freezes the account. `CLEAR` takes two admins, both after the
  last screening change; it reopens withdrawals but does not lift a freeze (that
  is a separate restriction decision). Use `CLEAR` also for a player whose level
  did not screen, once screening was done another way. Never on your own account.
- **Your own account.** An admin can freeze their own account but not change its
  restriction otherwise (409 `SELF_APPROVAL`): another admin decides.

## 8. Daily checks

- `GET /api/admin/payments/reconciliation/issues?status=OPEN`: CRITICAL ones
  first (ledger mismatch, credited deposit missing at the provider, custody
  shortfall). `SETTLEMENT_CHECK_NOT_RUN` means that day's provider check did not
  run: no adapter has a settlement report yet, so compare by hand. A kind that
  stays `FAILED` after three tries in `GET .../reconciliation/runs` did not run
  that day either.
- `GET /api/admin/payments/events?outcome=DEAD`: requeue after fixing the
  cause (`POST .../events/:id/requeue` gives one more attempt).
- Weekly in live mode: `POST /api/admin/payments/custody-snapshot` with the
  segregated account's balance; a shortfall is CRITICAL (player-fund
  protection).
- Logs to alert on: `PAYMENTS_ROLE_ISOLATION`, `PAYMENTS_CONFIG`,
  `PAYMENTS_PROVIDER_CLOSED`, `PAYMENT_EVENT_DEAD`, `PAYOUT_MANUAL`,
  `WEBHOOK_REJECTED` bursts, `PAYMENTS_LOCKDOWN_FAILED`,
  `PAYMENTS_LOCKDOWN_RETRY_FAILED`, `WITHDRAWAL_CANCEL_RETRY_FAILED`,
  `CREDIT_RETRY_FAILED`, `RECONCILIATION_FAILED`, `PAYMENT_CARD_MISSING`,
  `PAYMENT_CARD_MISMATCH`, `NOTIFY_LINK_SECRET_MISSING`, `NOT_ME_LINK_VOID`.
