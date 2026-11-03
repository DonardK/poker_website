# BVNK crypto adapter

`createBvnkAdapter(config: BvnkConfig, deps)` in `index.ts`; Hawk signing in `hawk.ts`; `../wire.ts` holds the helpers all three real adapters share (one outbound call with a timeout, no redirects and a 1 MB cap; lossless JSON; exact decimal to minor units; constant-time compare; redaction). It never touches the database. Tests: `apps/edge/test/payments/providers/bvnk.unit.test.ts` and `wire.unit.test.ts`.

## What it does

| Operation | BVNK call | Notes |
|---|---|---|
| `createDepositSession` | `GET /api/v2/channel?walletId&q=<reference>`, then `POST /api/v2/channel` if none | One channel per player and pay asset, settling into the EUR wallet. The reference is `cha_` + 32 hex of SHA-256(wallet, player ref, asset), so the player keeps one address per asset. If a race made two, the oldest is used. The channel is refused if BVNK opened it on another network or for a non-EUR wallet. `reusableAddress = true`. |
| `getPayment` | `GET /api/v2/channel/payment/{uuid}` | COMPLETE in EUR credits `walletAmount`, floored to the cent (the remainder is logged). DETECTED and PENDING are PROCESSING; HELD is PROCESSING with KYT_HOLD; UNDERPAID, a non-EUR wallet or an unreadable amount go to review. A deposit id alone answers `null`: channel payments name no deposit, and the core matches them by address. |
| `createPayout` | `POST /api/v1/pay/summary` (`twoStep: true`), then `PUT /api/v1/pay/{uuid}/confirm/summary` | `reference` = our key (`wd_<id>`), `X-Idempotency-Key` = a UUID derived from it. Any refusal except 401/403/429 first looks the payout up by reference: if it exists it is resumed (confirmed when still confirmable), so a retry never sends twice. `MER-PAY-2012` (merchant wallet short) is retry-later with an alert; `invalidPayout` is final. |
| `getPayout` | `GET /api/v1/pay/{uuid}/summary`, or `GET /api/v1/pay/summary?walletId&reference=` | COMPLETE is final success; CANCELLED and EXPIRED are final failures (funds stay in the merchant wallet). A payout is never failed on our clock. A created-but-unconfirmed payout answers `null` so the dispatcher re-dispatches with the same key and confirms it. |
| `validateAddress` | `PUT /api/v1/pay/validate` | 200 is valid, 400 invalid (with BVNK's code). |
| `answerInformationRequest` | `POST /compliance/v1/information-requests/{id}/actions` | Needs the originator's postal address, which `TravelRuleParty` does not carry yet: until it does, the answer is "retry later" (`ADDRESS_REQUIRED`). Birth date sent as `dd-MM-yyyy` as that endpoint documents. |
| `verifyWebhook` | | `x-signature` = base64 HMAC-SHA256 over the raw body; current and previous secret both computed, constant-time compare. Hints only (`authoritativeWebhooks = false`). |
| `quotePayout` | none | BVNK's estimate and dry run need the beneficiary's travel-rule details, which this call lacks; the player is debited the EUR amount and the network fee is the merchant's. Minimum 5 EUR. |

Ledger key: `sandbox-bvnk` with `BVNK_ENV=sandbox` (books `TEST_EUR`), `bvnk` with `production` (books `EUR`). `dedupesOnOurKey = true` (our key is the unique payout reference).

Webhook events applied: `bvnk:payment:channel:transaction-detected` / `-confirmed` / `-on-hold` (deposit hints), `bvnk:payment:crypto:status-change` and `bvnk:payment:crypto:transaction-on-hold` with `type: OUT` (payout hints keyed by our reference), `bvnk:compliance:v1:information-request`. Everything else (fiat `bvnk:payment:payout:status-change`, ledger reports, pay-ins through payment links) is acknowledged and ignored.

## Egress (`PAYMENTS_EGRESS_MODE`)

BVNK payouts need allow-listed source IPs. With `relay`, every call goes to the relay origin with the same path, query, headers and body; the Hawk MAC is computed for BVNK's host (`api.bvnk.com` / `api.sandbox.bvnk.com`, port 443), so the relay must forward unchanged to that host and holds no BVNK secret. The relay's own authentication of the Worker (an mTLS client certificate) belongs to the registry's egress-aware `fetch`.

## Verified (2026-10-29)

- Base URLs and every endpoint, request and response schema above: the OpenAPI document [bvnk-api-endpoints.json](https://docs.bvnk.com/bvnk-api-endpoints.json). `channelId` of a channel payment is the channel's `uuid` (the examples match). `GET /api/v2/channel` and `GET /api/v2/channel/payment` take `q` ("the reference provided during creation ... channel UUID, transaction hash"). Party details: `type`, `entityType`, `firstName`, `lastName`, `dateOfBirth` (example `1984-06-30`), `relationshipType`, `countryCode` (`regionCode` required for UA). `amount` is a JSON number, minimum 5. Two-step quotes lock for one hour. Payment status enum PENDING, PROCESSING, CANCELLED, COMPLETE, UNDERPAID, OVERPAID, EXPIRED; quote status TEMPLATE, ACCEPTED, EXPIRED. Error body `{requestId, errorList:[{code, parameter, message}]}`.
- Hawk: `hawk.1.header`, ts, nonce, METHOD, path?query, host, port, empty hash, empty ext; base64 HMAC-SHA256; payload validation not used. [Authentication](https://docs.bvnk.com/bvnk/api-explorer/api-overview/authentication/). The published Hawk test vector passes (`wire.unit.test.ts`).
- Idempotency: `X-Idempotency-Key` (v1) / `Idempotency-Key` (v2), UUID, only successes cached, a duplicate is a 400. [Idempotency](https://docs.bvnk.com/bvnk/api-explorer/api-overview/idempotency/). Payout `reference` must be unique ("Duplicate Reference").
- Webhooks: POST JSON, `x-signature` base64 HMAC-SHA256 of the raw body, envelope `{event, eventId, timestamp, data}`, answer within 10 s, up to 100 attempts; event names and `data` schemas from the webhook reference (the examples are used verbatim in the tests). One documented example sends `transactions[].dateConfirmed` as a string, so dates are accepted as numbers or strings. [Webhook listener](https://docs.bvnk.com/bvnk/get-started/create-webhook-listener/).

## UNVERIFIED (confirm in the BVNK sandbox)

- Which request field selects a channel's network: the OpenAPI request has none, yet "you specify the network when creating payment channels". We send `network` and check the answer's `network`.
- Whether `customerId` must be created at BVNK first, the accepted Hawk clock skew, confirmation counts per chain, and whether `walletAmount` is net of `feeAmount`.
- `dateOfBirth` format on channels and payouts (we send `YYYY-MM-DD`, as the examples do).
- The status of a confirmed two-step payout before it starts processing (we treat PENDING as not final either way).
- The legacy webhook signature scheme (refused).
- Whether Cloudflare dedicated egress IPs are available on our plan (otherwise run the relay).

## Operator checklist

- Contract and production API access; an EUR wallet with auto-convert; `BVNK_WALLET_ID_EUR`, `BVNK_ASSET_MAP` (our asset codes to BVNK `payCurrency` and `network`, from the currencies endpoint), `BVNK_ENV`.
- Secrets via `wrangler secret`: `BVNK_HAWK_AUTH_ID`, `BVNK_HAWK_AUTH_KEY`, `BVNK_WEBHOOK_SECRET` (+ `_PREVIOUS` while rotating).
- Webhook URL (new hook service, `x-signature`): `${PAYMENTS_PUBLIC_ORIGIN}/webhooks/sandbox-bvnk` or `/webhooks/bvnk`. Ask BVNK Solutions to enable the on-hold events.
- Allow-list the egress IPs (dedicated egress or the relay's fixed IP) for payouts.
- BVNK's documented wallet ids look like `a:24092328494070:G5i4XZ9:1`; `config.ts` currently accepts only `[A-Za-z0-9-]` for `BVNK_WALLET_ID_EUR` and must allow `:` first.
