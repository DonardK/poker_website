# Nuvei card adapter

`createNuveiAdapter(config: NuveiConfig, deps)` in `index.ts`; checksums and timestamps in `checksum.ts`. It never touches the database; the payments core books what it reports. Shared wire helpers (lossless JSON, timeouts, constant-time compare) are in `../wire.ts`. Tests: `apps/edge/test/payments/providers/nuvei.unit.test.ts`.

## What it does

| Operation | Nuvei call | Notes |
|---|---|---|
| `createDepositSession` | none: a signed Payment Page URL built locally | Full-page redirect (PCI SAQ-A). `merchant_unique_id` = our deposit id, `user_token_id` = the player's pseudonymous ref, `user_token=auto` (registers the card so payouts can use its `userPaymentOptionId`), `readonlyupo` + `userPaymentOptionId` for a saved card, cards only (`payment_method=cc_card`, `payment_method_mode=filter`), `encoding=utf-8`, per-request success/error/pending/back URLs. The redirect confirms nothing. |
| `getPayment` | `/getTransactionDetails` by `transactionId`, else by `clientUniqueId` (our deposit id); then `/getUserUPOs` for a successful card | The authoritative re-read. Credits only an approved, non-voided `sale`/`sale3D` in EUR whose amount it can read. `merchantRef` and `channelRef` are Nuvei's own `clientUniqueId` and `userTokenId`, never the DMN's. The card fingerprint is `upoData.uniqueCC` of the matching `userPaymentOptionId`; a failed read leaves it null and the deposit goes on. |
| `createPayout` (`PAYOUT`) | `/payout` to `userPaymentOption.userPaymentOptionId` | `clientRequestId` = `clientUniqueId` = our key (`wd_<id>`, at most 45 characters). Needs the player's IP (`deviceDetails.ipAddress`). APPROVED is final; DECLINED is final (method-ineligible for credit filters 1106/1124/1126 and "not supported" texts); ERROR or a refused request is "uncertain" (query first). |
| `createPayout` (`REFUND`) | `/refundTransaction` against the sale | `relatedTransactionId` = the sale; `authCode`, `comment`, `urlDetails` are never sent (their checksum position is unclear). |
| `getPayout` | `/getPayoutStatus` (payouts), `/getTransactionDetails` by `clientUniqueId` (refunds) | A gateway ERROR on a status read is final. "Not found" answers `null`. |
| `verifyWebhook` | payment DMN (form body or query string) and Control Panel events (JSON) | See below. `authoritativeWebhooks = false`: every event is a hint and the core re-reads. |
| `quotePayout` | none | No fee to the player; the card receives the EUR amount. |

Ledger key: `sandbox-nuvei` with `NUVEI_ENV=int` (books `TEST_EUR`), `nuvei` with `prod` (books `EUR`). The wire currency is EUR in both environments. `dedupesOnOurKey` follows `NUVEI_IDEMPOTENCY_CONFIRMED`.

## Signatures

- **REST** `checksum`: lowercase hex SHA-256 over the method's fields joined without separators, secret last; fields not sent are left out. `timeStamp` is `YYYYMMDDHHmmss`, sent in UTC.
  - getTransactionDetails: merchantId, merchantSiteId, transactionId?, clientUniqueId?, timeStamp, secret.
  - payout: merchantId, merchantSiteId, clientRequestId, amount, currency, timeStamp, secret.
  - getPayoutStatus: merchantId, merchantSiteId, clientRequestId, timeStamp, secret.
  - getUserUPOs: merchantId, merchantSiteId, userTokenId, clientRequestId, timeStamp, secret.
  - refundTransaction: merchantId, merchantSiteId, clientRequestId, clientUniqueId, amount, currency, relatedTransactionId, timeStamp, secret.
- **Payment Page** `checksum`: SHA-256 of the secret followed by every parameter value, unencoded, in the order sent. `time_stamp` is `YYYY-MM-DD.HH:MM:SS` in GMT.
- **Payment DMN** `advanceResponseChecksum`: SHA-256 of secret + totalAmount + currency + responseTimeStamp + PPP_TransactionID + Status + productId (`+` read as a space). Only these six fields are signed, so the DMN is a hint: the transaction id, our deposit id and the card come from the re-read. The six values are hashed with no keys, like the Payment Page values a player sees in their own redirect, so every field must have its exact shape before the hash is checked (`DMN_FIELD_FORMAT`): an amount, three capitals, a real timestamp, a transaction number, a documented status word, plain text. A timestamp that does not parse is refused, one older than 7 days too, and the event id comes from the parsed fields, so one DMN has one id. A 32-hex (MD5) checksum is refused: set the site to SHA-256. A repeated signed field is refused. Current and previous secret are both tried, compared in constant time.
- **Control Panel event** header `checksum`: SHA-256 of the secret prefixed to the payload. Both readings of the docs are computed (the raw JSON text, and the values in order); the scheme name records which one matched.

## Verified (docs.nuvei.com, 2026-10-29)

- Base URLs: REST `https://ppp-test.nuvei.com/ppp/api/v1/<method>.do` (test) and `https://secure.safecharge.com/ppp/api/v1/<method>.do` (live); Payment Page `https://ppp-test.safecharge.com/ppp/purchase.do` and `https://secure.safecharge.com/ppp/purchase.do`. [API reference](https://docs.nuvei.com/api/main/indexMain_v1_0.html?json), [Payment Page quick start](https://docs.nuvei.com/documentation/accept-payment/payment-page/quick-start-for-payment-page/).
- Checksum field orders, `clientRequestId` String(255) (repeats refused only when enabled for the merchant), `clientUniqueId` String(45) on payout, `relatedTransactionId` max 19, `deviceDetails.ipAddress` String(15), payout and refund outputs, getPayoutStatus outputs. [API reference](https://docs.nuvei.com/api/main/indexMain_v1_0.html?json).
- getTransactionDetails outputs: `transactionDetails.{transactionStatus, transactionType, clientUniqueId, transactionId, isVoided, gwErrorCode}`, `userDetails.userTokenId`, `paymentOption.{userPaymentOptionId, card.*}`, `partialApproval.{requestedAmount, requestedCurrency, processedAmount, processedCurrency}`. It has no plain transaction amount field and no `uniqueCC`.
- `uniqueCC`: "a unique value assigned to every credit card number" in payment DMNs (unsigned there); String(28) on `/getPaymentStatus` (session calls only) and `/addUPOCreditCard`; in `upoData` of `/getUserUPOs`, whose checksum order and `paymentMethods[].userPaymentOptionId` are documented. [Advanced API](https://docs.nuvei.com/api/advanced/indexAdvanced.html?json).
- Payment Page parameters: `merchant_unique_id` Char(64), `user_token` values, `item_quantity_N`, per-request `success_url`/`error_url`/`pending_url`/`back_url`/`notify_url`, `encoding` (default ISO-8859-1), `payment_method` + `payment_method_mode=filter`. [Input parameters](https://docs.nuvei.com/documentation/accept-payment/payment-page/input-parameters/).
- Payment DMN checksum, Status values (APPROVED, SUCCESS, DECLINED, ERROR, PENDING, UPDATE), transactionType values. [Payment DMNs](https://docs.nuvei.com/documentation/integration/webhooks/payment-dmns/).
- Control Panel event fields and source IPs (31.207.2.1-31.207.3.254, 52.16.211.57). [Control Panel events](https://docs.nuvei.com/documentation/integration/webhooks/control-panel/).

## UNVERIFIED (confirm in the Nuvei sandbox before go-live)

- Time zone of the REST `timeStamp` (we send UTC).
- The DMN HTTP method and retry schedule (form POST and query-string GET are both accepted; the poker-payments route only takes POST).
- That `/getUserUPOs` really returns `upoData.uniqueCC` for a card saved through the Payment Page: it is in the documented example response, not in the method's output table. Until a sandbox call shows it, treat the fingerprint as possibly null: DESTINATION_SHARED then does not see a card shared between accounts, and the closed loop identifies a card by its token only.
- That `paymentOption.userPaymentOptionId` is always returned for a Payment Page sale. Without it a successful card deposit goes to review as CARD_UNKNOWN and can only be failed and refunded at Nuvei.
- Which amount field getTransactionDetails fills for a plain sale. We credit `partialApproval.processedAmount` (or `requestedAmount`) only when it is EUR and both agree; otherwise the deposit goes to review.
- Whether the cardholder name may go with a saved `userPaymentOption` on `/payout` (Mastercard gaming payouts need it). We send `userDetails.firstName/lastName/country`.
- Decline codes and texts that mean "method ineligible", and the exact "not found" wording of lookups.
- Whether an IPv6 address is accepted in `deviceDetails.ipAddress` (documented as 15 characters; IPv4-mapped IPv6 is sent as IPv4).
- The Control Panel checksum input, and the won and lost `Chargeback.Status` values. Retrievals, soft chargebacks, duplicates and cancellations are informational; payment-DMN chargebacks are informational too (their link to the sale is unsigned).
- Payment Page 3-D Secure 2 behaviour (test with 3-D Secure test cards).
- Whether our server-to-server calls need IP allow-listing (the BVNK relay could serve Nuvei too).

## Operator checklist

- Contract with gaming (MCC 7995) acceptance and card payouts (OCT) enabled by Nuvei Support; ask Nuvei to enable `clientRequestId` duplicate refusal, then set `NUVEI_IDEMPOTENCY_CONFIRMED=true`.
- Site in sale mode (not auth), checksum algorithm SHA-256, pre-deposit DMNs off.
- Secrets: `NUVEI_SECRET_KEY` (and `NUVEI_SECRET_KEY_PREVIOUS` while rotating) via `wrangler secret`; vars `NUVEI_ENV`, `NUVEI_MERCHANT_ID`, `NUVEI_MERCHANT_SITE_ID`.
- DMN and Control Panel event URL: `${PAYMENTS_PUBLIC_ORIGIN}/webhooks/sandbox-nuvei` (sandbox) or `/webhooks/nuvei` (live). The adapter tells payment DMNs (form) from events (JSON).
