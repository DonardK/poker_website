# Sumsub KYC adapter

`createSumsubAdapter(config: SumsubConfig, deps)` in `index.ts`; alpha-3 to alpha-2 countries in `countries.ts`. It never touches the database. Tests: `apps/edge/test/payments/providers/sumsub.unit.test.ts`.

## What it does

| Operation | Sumsub call | Notes |
|---|---|---|
| `createSession` | `GET /resources/applicants/-;externalUserId={id}/one`; on 404 `POST /resources/applicants?levelName=` `{externalUserId, email?}`; then `POST /resources/accessTokens/sdk` `{userId, levelName, ttlInSecs}` | Finds or creates the applicant for our opaque customer reference (never a user id), then returns the WebSDK token, the applicant id (`applicantRef`, which the core binds to the account) and the expiry (TTL clamped to 1 min - 1 h). A create race (409, or a 400 "already exists") is resolved by reading again. A token or applicant for another user is refused. No `fixedInfo` is sent, so Sumsub checks documents against nothing we guessed. |
| `getApplicant` | `GET /resources/applicants/{id}/one` (or by externalUserId) | Only a `completed` review decides: GREEN is VERIFIED with the identity (Latin-script `firstNameEn`/`lastNameEn` when present, `dob`, alpha-3 `country` as alpha-2) and `reviewDueAt` = the earliest document `validUntil` before 2099; RED + FINAL is a final rejection, RED + RETRY a resubmission request, RED without a type a non-final rejection. Reject labels become the reason; sanctions-type labels set the screening result. With `SUMSUB_SCREENING_INCLUDED=true`, a GREEN with no such label also sets screening CLEAR; without it nothing sets CLEAR. Any other status is PENDING. An incomplete identity returns VERIFIED without it (the core keeps the player pending and alerts). 404 answers `null`. |
| `verifyWebhook` | | `x-payload-digest` = hex HMAC of the raw body with the webhook secret; `x-payload-digest-alg` HMAC_SHA256_HEX (also the default when absent) or HMAC_SHA512_HEX; legacy HMAC_SHA1_HEX is refused. A webhook whose `sandboxMode` is not ours is refused. Company applicants are ignored. The event id is `d_` + SHA-256 of what identifies the notification (Sumsub sends none). Hints only (`authoritativeWebhooks = false`): the core re-reads the applicant. |

Request signing: `X-App-Token`, `X-App-Access-Ts` (unix seconds) and `X-App-Access-Sig` = lowercase hex HMAC-SHA256(secret key, ts + METHOD + path?query + raw body), over the path exactly as sent.

Ledger key (`PlayerCompliance.kycProvider`, webhook path): `sandbox-sumsub` for a sandbox app token, `sumsub` for production.

## Verified (docs.sumsub.com, 2026-10-29)

- Signing headers and string, unix-seconds timestamp within one minute, HTTPS only: [Authentication](https://docs.sumsub.com/reference/authentication).
- `POST /resources/accessTokens/sdk` with `userId`, `levelName`, `ttlInSecs` (default 600) and optional `applicantIdentifiers` → `{token, userId}`: [Generate access token](https://docs.sumsub.com/reference/generate-access-token).
- Create applicant `POST /resources/applicants?levelName=` (`externalUserId` up to 512, `email`, `fixedInfo`); read `GET /resources/applicants/{id}/one` and `GET /resources/applicants/-;externalUserId={id}/one`; review statuses init, pending, prechecked, queued, completed, onHold, awaitingService, awaitingUser; `reviewResult.{reviewAnswer GREEN|RED, reviewRejectType FINAL|RETRY, rejectLabels}`; `info.dob` `yyyy-MM-dd`, `info.country` alpha-3, `idDocs[].validUntil` (2099-01-01 for no expiry); error body `{code, correlationId, description}`: [Get applicant data](https://docs.sumsub.com/reference/get-applicant-data).
- Digest headers and algorithms; 401/403/404 replies are not retried; up to 5 resends; reply within 10 s: [Webhook manager](https://docs.sumsub.com/docs/webhook-manager).
- Webhook body fields (`applicantId`, `inspectionId`, `applicantType`, `correlationId`, `externalUserId`, `levelName`, `type`, `sandboxMode`, `reviewStatus`, `createdAtMs` as `yyyy-MM-dd HH:mm:ss.fff` UTC, `reviewResult`) and event types: [User verification webhooks](https://docs.sumsub.com/docs/user-verification-webhooks).

## UNVERIFIED

- The `sbx:` / `prd:` app token prefixes (not in the docs). The mode is `SumsubConfig.mode` (`PAYMENTS_MODE`); the prefix only refuses a token of the other environment, and a token with neither prefix is taken as the mode says.
- The answer to creating an applicant that already exists (handled as 409 or a 400 "already exists"), and 404 for an unknown applicant.
- Whether `info.country` is the residence or the document country (used as the residence).
- Reject label names for screening: SANCTIONS, COMPROMISED_PERSONS, CRIMINAL, BLACKLIST, BLOCKLIST (confirmed match); PEP, ADVERSE_MEDIA (potential match). A GREEN review sets "screened clear" only with `SUMSUB_SCREENING_INCLUDED=true`, and only without one of these labels, so the labels must be confirmed before that flag is set.
- That a GREEN answer on a level with AML screening means the screening also passed (rather than being a separate step). Confirm with Sumsub before setting the flag.
- `errorName` in error bodies (used as the code only when present).

## Operator checklist

- Contract; a level (`SUMSUB_LEVEL_NAME`) with ID document, liveness and AML screening; `SUMSUB_TOKEN_TTL`.
- `SUMSUB_SCREENING_INCLUDED=true` only for a level that includes AML and sanctions screening. Without it nothing sets a player's screening to CLEAR, so every withdrawal stays refused. An automatic CLEAR never lifts a match already on record: a person does that.
- Secrets via `wrangler secret`: `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`, `SUMSUB_WEBHOOK_SECRET` (sandbox and production tokens are separate).
- Webhook URL in the dashboard: `${PAYMENTS_PUBLIC_ORIGIN}/webhooks/sandbox-sumsub` or `/webhooks/sumsub`, digest HMAC_SHA256_HEX or HMAC_SHA512_HEX, with at least applicantReviewed, applicantPending, applicantOnHold and applicantReset.
- The web client needs Sumsub's WebSDK (script and frames from Sumsub's hosts in the CSP of the verification page) to use the token.
