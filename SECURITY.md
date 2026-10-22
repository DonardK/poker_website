# Security policy

This platform handles real-money balances, cryptocurrency, and private game
state (hole cards, deck seeds). We take reports seriously and want to hear
from you before anyone else does.

## Reporting a vulnerability

**Email: `security@REPLACE-WITH-YOUR-DOMAIN`** (PGP key: `REPLACE-WITH-KEY-URL-AND-FINGERPRINT`)

> Operators: replace both placeholders before launch, and publish the same
> contact at `https://<your-domain>/.well-known/security.txt` (RFC 9116).

Please **do not** open a public issue, pull request, discussion, or social
media post for a security problem.

Include, as far as you can:

- what the issue is and its impact (e.g. "a player can see another player's hole cards", "chips can be created or moved without a matching ledger entry");
- the affected URL, endpoint, socket event, or file and commit;
- step-by-step reproduction, with requests/responses or a minimal script;
- the account(s) you used, and whether any real player, balance, or funds were affected.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | within 2 business days |
| Initial assessment and severity | within 5 business days |
| Status updates | at least every 7 days until resolved |
| Fix for critical issues (funds, card privacy, authentication) | as fast as possible; mitigations within days |
| Public disclosure | coordinated with you, normally after the fix ships, at most 90 days from the report unless we agree otherwise |

We will credit you in the release notes if you wish.

## Scope

In scope: the web application, the game server API and Socket.io interface,
authentication and session handling, the chip ledger and any deposit or
withdrawal flow, shuffling/dealing and the fairness audit, and the deployment
configuration in this repository (`deploy/`, Dockerfiles).

Of particular interest:

- seeing or inferring hidden information (hole cards, the deck, a seed before it is revealed);
- creating, duplicating, or moving chips or funds, or breaking ledger integrity;
- acting as another player or an administrator, or bypassing session revocation;
- getting past a second factor (TOTP, backup code or passkey), reusing a one-time code, sign-in ticket, passkey challenge or email link, or minting or reusing a step-up grant for a money action it was not issued for;
- learning whether an email address or username has an account from the sign-in, password-reset or email-change answers;
- bypassing rate limits, responsible-gambling limits, or self-exclusion;
- injection, SSRF, request smuggling, or header spoofing at the edge.

Out of scope: denial of service by volume, findings that require a compromised
device or browser, social engineering of staff or players, physical attacks,
reports from automated scanners without a demonstrated impact, missing
best-practice headers without an exploit, and sign-up refusing a username or
email address that is already taken (it must; sign-up is behind Turnstile and
rate limits).

## Safe harbour

We will not pursue legal action or ask anyone else to, for research that:

- uses only accounts you own (or test accounts we provide) and **never** touches another player's account, balance, or data;
- does not move real money beyond the minimum needed to demonstrate the issue, and reports any such movement immediately so it can be reversed;
- stops and reports as soon as you reach non-public data, and does not keep, share, or use it;
- avoids degrading service for real players (no load testing, no spam);
- gives us reasonable time to fix the issue before any disclosure.

If in doubt, ask first at the address above.

## Supported versions

Only the currently deployed production version is supported. Fixes are made on
the main branch and deployed; there are no maintained older releases.
