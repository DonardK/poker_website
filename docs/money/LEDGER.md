# Money ledger

Status: foundation only. Migration `20261002200000_ledger_foundation` adds the
schema, the two database functions and the grants; `apps/server/src/money/`
holds the TypeScript side. Nothing in the game server calls it yet: the legacy
`User.bankroll` (signed 32-bit, mutated in place) stays authoritative until the
integration step moves buy-ins, cash-outs, guest/registration grants and rake
onto the ledger. No existing balance is backfilled by this migration.

## 1. Why

`User.bankroll` is a mutable `INT` with no history: a lost update, a double
cash-out or a direct `UPDATE` by anyone holding the runtime credential leaves
no trace and cannot be reconstructed. Registration and guest creation mint
10,000 chips into the same balance that pays buy-ins. There is no notion of
asset, reservation, idempotent retry or reconciliation. A real-money platform
needs every unit of value to be traceable to a balanced, append-only journal
entry, and the database (not the application) to refuse anything that would
create or destroy value.

## 2. Assets and precision

Amounts are integers of the asset's *minor unit* (`BIGINT` in Postgres,
`bigint` in TypeScript). Floats never touch money.

| Code | Kind | Decimals (ledger minor unit) | Chain decimals | Network | Enabled |
|---|---|---|---|---|---|
| `PLAY` | PLAY | 0 (1 = one play chip) | - | - | yes |
| `EUR` | FIAT | 2 (cent) | - | - | no |
| `BTC` | CRYPTO | 8 (satoshi) | 8 | bitcoin | no |
| `ETH` | CRYPTO | 9 (gwei) | 18 (wei) | ethereum | no |
| `USDT_ERC20` | CRYPTO | 6 | 6 | ethereum | no |
| `USDT_TRC20` | CRYPTO | 6 | 6 | tron | no |
| `USDC_ERC20` | CRYPTO | 6 | 6 | ethereum | no |

- ETH is booked in gwei: wei precision (18) is far below any amount a poker
  table moves and would waste 9 of the 19 digits a `BIGINT` holds. A deposit
  of a wei amount that is not a whole number of gwei is a payment-integration
  concern (the remainder is reported, never rounded silently into a balance).
- `PLAY` chips are a separate, non-redeemable asset. There is no posting rule
  that converts between assets, and the database checks the sum of every
  transaction *per asset*, so no transaction can turn one asset into another.
  `PLAY` can never be withdrawn: withdrawal, deposit, fee and chargeback
  accounts cannot exist for it (`ledger_ensure_account` refuses them).
- Real assets ship disabled (`Asset.enabled = false`). Both database
  functions refuse a disabled asset (`LEDGER_ASSET_DISABLED`). Enabling one is
  an administrator `UPDATE` after legal, payments and the integration step are
  done. Disabling an asset freezes every account in it (no posting at all,
  including cash-outs), which is the intended emergency stop. The stop is
  exact: `ledger_post` reads each asset row `FOR SHARE`, so the
  administrator's `UPDATE` waits for postings already in flight, and a
  posting that arrives while the disable is uncommitted waits for it and is
  then refused. Once the disable has committed, no posting that saw the asset
  enabled can still commit. (Disable one asset per statement: an `UPDATE`
  of several asset rows can deadlock with a posting that holds one of them;
  Postgres then aborts one side.)
- `Asset.maxAmount` bounds the magnitude of a single entry (see section 8).

### Table chip unit

A table plays in integer *chips* (JS safe integers, as the engine requires)
and has an `assetCode` and a `chipUnit`: the number of minor units one chip is
worth (decimal string on the wire, `bigint` in the server). For `PLAY`,
`chipUnit = 1`. `chipsToMinor(chips, chipUnit)` multiplies exactly;
`minorToChips(minor, chipUnit)` refuses any remainder, so no fraction of a
chip can be created or lost when crossing between the table and the ledger.

## 3. Accounts

`LedgerAccount(assetCode, type, userId?, tableId?, providerKey?)` is unique
(one account per owner, type and asset). `balance` is a cached `BIGINT`;
`version` counts the entries ever posted to it.

| Type | Owner | Assets | May go negative | Meaning |
|---|---|---|---|---|
| `USER_AVAILABLE` | user | any | no | Spendable balance of a player. |
| `USER_WITHDRAWAL_HOLD` | user | real only | no | Funds reserved for a pending withdrawal; not spendable. |
| `TABLE_ESCROW` | table | any | no | All chips at one table (stacks + current hand + unpaid cash-outs). |
| `PLAY_ISSUANCE` | system | PLAY only | yes | Source of play chips; its negative balance is the total play chips in circulation. |
| `RAKE_REVENUE` | system | any | no | Rake taken by the house. |
| `DEPOSIT_CLEARING` | provider | real only | yes | Mirror of value received through a payment provider (negative = received, not yet reversed). |
| `WITHDRAWAL_CLEARING` | provider | real only | no | Mirror of value paid out through a provider. |
| `PROVIDER_FEES` | provider | real only | no | Fees paid to a provider. |
| `ADJUSTMENTS` | system | real only | yes | House equity used as the counterparty of staff corrections and house-paid fees. |
| `CHARGEBACK_LOSSES` | system | real only | yes | Shortfall the house absorbs when a reversed deposit was already spent. |

Owner/type combinations, the asset rules and "may go negative" are enforced by
`ledger_ensure_account` and by table `CHECK`s (`allowNegative` is a function
of the type; `balance >= 0 OR allowNegative`).

Sign convention: an entry's `amount` is added to the account balance. Internal
accounts (user, escrow, rake) hold positive balances; the mirror accounts of
the outside world (issuance, deposit clearing, chargeback losses, adjustments)
go negative when value enters custody. Because every transaction sums to zero
per asset, the sum of all balances of an asset is always zero.

## 4. Posting rules

Every flow is one `LedgerTransaction` with balanced `LedgerEntry` rows.
`ledger_post` checks the *shape* of each transaction type (which account types
appear and with which sign); a shape that is not listed is refused
(`LEDGER_BAD_SHAPE`). Adding a flow therefore needs a reviewed migration.
`m` below is a positive minor amount.

| Type | Entries | Notes |
|---|---|---|
| `PLAY_GRANT` | `PLAY_ISSUANCE -m`, `USER_AVAILABLE(user) +m` | PLAY only (issuance exists only for PLAY). Guest/registration grants and top-ups. |
| `BUY_IN` | `USER_AVAILABLE(user) -m`, `TABLE_ESCROW(table) +m` | `m = chips x chipUnit`. Refused on insufficient funds. |
| `CASH_OUT` | `TABLE_ESCROW(table) -m`, `USER_AVAILABLE(user) +m` | Leaving the table / closing it. |
| `RAKE` | `TABLE_ESCROW(table) -m`, `RAKE_REVENUE +m` | Once per hand with rake > 0, keyed by the hand UUID. |
| `DEPOSIT_CREDIT` | `DEPOSIT_CLEARING(provider) -m`, `USER_AVAILABLE(user) +m` | After the provider confirms; keyed by the provider's payment id. |
| `DEPOSIT_REVERSAL` | `DEPOSIT_CLEARING(provider) +m`, `USER_AVAILABLE(user) -u`, `CHARGEBACK_LOSSES -(m-u)` | Refund/chargeback. `u` = the part still covered by the user's balance; either leg may be absent when zero. |
| `WITHDRAWAL_HOLD` | `USER_AVAILABLE(user) -m`, `USER_WITHDRAWAL_HOLD(user) +m` | Same user. Reserves funds before any payout request is sent. |
| `WITHDRAWAL_RELEASE` | `USER_WITHDRAWAL_HOLD(user) -m`, `USER_AVAILABLE(user) +m` | Same user. Rejected/cancelled/failed payout. |
| `WITHDRAWAL_SETTLE` | `USER_WITHDRAWAL_HOLD(user) -m`, `WITHDRAWAL_CLEARING(p) +(m-f)`, `PROVIDER_FEES(p) +f` | Same provider on both legs; fee leg absent when `f = 0`. Fee charged to the user out of the held amount. |
| `PROVIDER_FEE` | `ADJUSTMENTS -f`, `PROVIDER_FEES(provider) +f` | A fee the house absorbs (e.g. deposit processing). |
| `ADJUSTMENT` | `USER_AVAILABLE(user) ±m`, counterparty `∓m` | Counterparty is `ADJUSTMENTS` for real assets, `PLAY_ISSUANCE` for PLAY. Requires `createdBy` and a non-empty `reference.reason`. |

A reversal of any other posting is a new transaction with the opposite
entries (never an edit): journal rows are append-only (section 9).

## 5. Invariants

Enforced by the database on every posting (`ledger_post`):

1. At least 2 and at most 16 entries; each account at most once per
   transaction (net it first); every amount a non-zero integer.
2. For each asset in the transaction, the amounts sum to exactly zero.
3. Each entry's asset equals its account's asset (also a composite foreign key
   `LedgerEntry(accountId, assetCode) -> LedgerAccount(id, assetCode)`).
4. Every asset involved exists and is enabled; `|amount| <= Asset.maxAmount`.
5. No account without `allowNegative` ends below zero (also a `CHECK`).
6. No balance leaves the `BIGINT` range.
7. The transaction shape matches its type (section 4).
8. `LedgerEntry.balanceAfter` is the account balance after the entry and
   `accountVersion` its 1-based position in that account's history
   (`UNIQUE (accountId, accountVersion)`), so the cached balance can always be
   recomputed and checked (section 10).

Business invariants checked by reconciliation (integration step):

- **Table escrow**: for every table and its asset,
  `TABLE_ESCROW.balance = (Σ seat stacks + Σ chips committed in the current
  hand + Σ cash-outs not yet posted) x chipUnit`. Chips move between players
  only inside the engine; the ledger sees value enter the table (buy-in) and
  leave it (cash-out, rake). Any difference is a stop-the-table incident.
  `expectedEscrowMinor()` in `money/flows.ts` computes the right-hand side.
- Per asset: `-(PLAY_ISSUANCE)` = play chips in circulation; for real assets,
  custody = `Σ USER_* + Σ TABLE_ESCROW + RAKE_REVENUE` must match
  provider/bank/wallet statements after clearing.

## 6. Idempotency

Every posting carries a caller-supplied, deterministic idempotency key derived
from the business event, never random per attempt. Examples:
`play-grant:registration:<userId>`, `buy-in:<tableId>:<commandId>`,
`cash-out:<tableId>:<userId>:<leaveCommandId>`, `rake:<handUuid>`,
`deposit:<provider>:<providerPaymentId>`, `withdrawal-hold:<withdrawalId>`.
Format: `^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,199}$`.

`ledger_post` hashes a canonical payload: SHA-256 over the transaction type,
the `reference` JSONB in Postgres' normalised text form (sorted keys, no
whitespace variance) and the entries sorted by account id as
`accountId|asset|amount`. `createdBy` is metadata and not hashed.

- Key unseen: the transaction is posted.
- Key seen with the same hash: the original transaction id is returned and
  nothing is posted again (even if the balances would no longer allow it).
- Key seen with a different hash: `LEDGER_IDEMPOTENCY_CONFLICT`.
- Two concurrent first attempts: the second blocks on the unique index until
  the first commits, then replays (or conflicts). If the first rolls back, the
  second posts. Under REPEATABLE READ the second gets `LEDGER_RETRY`
  (SQLSTATE 40001) and must retry its transaction.

## 7. Locking and concurrency

- Lock order inside `ledger_post`, the same for every posting: the involved
  `Asset` rows `FOR SHARE` (bytewise code order; postings share them), then
  the idempotency key (the `LedgerTransaction` insert), then the involved
  accounts `SELECT ... FOR UPDATE` one by one in ascending id order. So
  crossing transfers (a buy-in names user then escrow, a cash-out escrow then
  user) cannot deadlock against each other.
- Account creation has an order too. Creating an account inserts a row that
  stays uncommitted until the caller's transaction ends, and a concurrent
  creator of the same account waits for it; two first postings creating two
  new accounts in opposite orders would wait for each other. `execute()` /
  `ensureAccounts()` therefore resolve accounts in one global order
  (`accountSortKey`: asset, type, user, table, provider), never in the plan's
  leg order. A transaction that posts several times should resolve all its
  accounts with one `ensureAccounts` call before its first post.
- If Postgres still reports a deadlock (40P01) or a serialization failure
  (40001) inside a ledger call (e.g. a caller's own rows locked in an
  inconsistent order), it is mapped to `LedgerError` code `RETRY`: roll back
  and retry the whole transaction; nothing was posted.
- Callers must lock their own rows (table row in `TableManager.mutate`, a
  withdrawal request row, ...) *before* calling the ledger in the same
  transaction, never after: application rows first, ledger accounts last.
- The balance check happens after the lock, so 50 concurrent buy-ins against
  one balance serialise on the account row and the ones that do not fit fail
  with `LEDGER_INSUFFICIENT_FUNDS`.
- A refused posting raises; Postgres aborts the surrounding transaction, so
  the caller's game state change in the same transaction rolls back with it.
- `ledger_ensure_account` is idempotent and race-safe
  (`INSERT ... ON CONFLICT DO NOTHING`, then read).

## 8. Overflow bounds

- Ledger amounts: `BIGINT` (±9.22e18). Text amounts are parsed by the
  database (`^-?[0-9]+$`) and compared against the `BIGINT` range before the
  cast; JSON numbers are refused so no float can round an amount on the way.
- Per-entry cap `Asset.maxAmount`: PLAY 1e12 chips, EUR 1e9 cents
  (10,000,000.00), BTC 1e11 sat (1,000 BTC), ETH 1e13 gwei (10,000 ETH),
  stablecoins 1e13 (10,000,000.00). With at most 16 entries the sum of one
  transaction can never overflow; balance updates are range-checked and
  refused with `LEDGER_AMOUNT_OVERFLOW` rather than wrapping.
- Chips: engine chips are JS safe integers (< 2^53). `chipsToMinor` refuses
  non-safe-integer chips and results beyond the `BIGINT` range;
  `minorToChips` refuses a result beyond `Number.MAX_SAFE_INTEGER`.
- `bigint` never reaches `res.json` (it throws): `jsonSafe()` converts to
  decimal strings.

## 9. Append-only journal and reconstruction

`LedgerTransaction` and `LedgerEntry` rows are never updated or deleted: the
runtime role has no write privilege at all, and a trigger refuses `UPDATE` and
`DELETE` for every role (`LEDGER_IMMUTABLE`). Accounts, users and tables
referenced by the ledger cannot be deleted (`ON DELETE RESTRICT`), so a guest
clean-up job must skip users who own ledger accounts.

`reconstructBalance(accountId)` recomputes from the journal: the sum of the
entries equals the cached balance, the number of entries equals `version`,
and each entry's `balanceAfter` equals the running sum in version order. Any
mismatch means the cached row was altered outside `ledger_post`.

## 10. Threat model

Runtime credential (`poker_server`, used by the game server):

- Has `SELECT` on the four ledger tables and `EXECUTE` on `ledger_post` and
  `ledger_ensure_account` only. No `INSERT/UPDATE/DELETE/TRUNCATE` on any
  ledger table, no sequence privilege; `FORCE ROW LEVEL SECURITY` with a
  select-only policy backs that up if a grant is ever added by mistake.
- So a stolen runtime credential cannot write a balance, create an unbalanced
  or cross-asset posting, overdraw a non-negative account, post to a disabled
  asset, exceed the per-entry cap, rewrite or delete history, or create an
  account with a forged owner/type/negative flag.
- It *can* post any well-shaped transaction for an enabled asset: e.g. move
  chips between a user and a table escrow, or mint PLAY chips. PLAY has no
  monetary value, so this is acceptable for the play-money phase. **Before a
  real asset is enabled**, `DEPOSIT_CREDIT`, `ADJUSTMENT` and the
  withdrawal-settlement types must move to separate database roles used only
  by the payment worker and the staff back office (each with its own
  credential), leaving `poker_server` with `BUY_IN`, `CASH_OUT`, `RAKE`,
  `WITHDRAWAL_HOLD` and `PLAY_GRANT`.
- It cannot change `User.role` or `User.kind` (trigger
  `User_guard_privileged_columns`, `USER_PRIVILEGE_CHANGE_FORBIDDEN`), so it
  cannot promote an account to ADMIN or turn a human into a bot. It still
  inserts users; a follow-up should also refuse inserting `role = ADMIN` from
  this role once no runtime path needs it.
- It cannot insert a hand without the compliance audit columns
  (`HAND_AUDIT_REQUIRED`); legacy rows are untouched.

Function hardening: `SECURITY DEFINER`, `SET search_path = pg_catalog, public,
pg_temp` (temp schema last) and every object schema-qualified, no dynamic SQL,
`EXECUTE` revoked from `PUBLIC` (and the Supabase `anon`, `authenticated`,
`service_role` roles, which receive default privileges on new functions,
tables and sequences). The functions run as the migration role; a policy for
that role (`ledger_definer`) lets them work under `FORCE ROW LEVEL SECURITY`
even where it lacks `BYPASSRLS`.

Administrators (migration/owner role) can do anything, including disabling
the triggers; the journal and `reconstructBalance` make such changes evident,
and production administrator access must itself be audited.

## 11. Error codes

| SQLSTATE | Message prefix | TypeScript `LedgerError.code` |
|---|---|---|
| LG001 | `LEDGER_BAD_REQUEST` (key, type, reference, createdBy) | INVARIANT |
| LG002 | `LEDGER_MALFORMED_ENTRY` | INVARIANT |
| LG003 | `LEDGER_TOO_FEW_ENTRIES` | INVARIANT |
| LG004 | `LEDGER_AMOUNT_OVERFLOW` | INVARIANT |
| LG005 | `LEDGER_AMOUNT_LIMIT` | INVARIANT |
| LG006 | `LEDGER_UNKNOWN_ACCOUNT` | INVARIANT |
| LG007 | `LEDGER_ASSET_MISMATCH` | INVARIANT |
| LG008 | `LEDGER_UNBALANCED` | INVARIANT |
| LG009 | `LEDGER_ASSET_DISABLED` | ASSET_DISABLED |
| LG010 | `LEDGER_UNKNOWN_ASSET` | INVARIANT |
| LG011 | `LEDGER_INSUFFICIENT_FUNDS` | INSUFFICIENT_FUNDS |
| LG012 | `LEDGER_IDEMPOTENCY_CONFLICT` | IDEMPOTENCY_CONFLICT |
| LG013 | `LEDGER_DUPLICATE_ACCOUNT` | INVARIANT |
| LG014 | `LEDGER_BAD_ACCOUNT` | INVARIANT |
| LG015 | `LEDGER_TOO_MANY_ENTRIES` | INVARIANT |
| LG016 | `LEDGER_IMMUTABLE` | INVARIANT |
| LG017 | `LEDGER_ZERO_AMOUNT` | INVARIANT |
| LG018 | `LEDGER_BAD_SHAPE` | INVARIANT |
| LG019 | `LEDGER_UNKNOWN_OWNER` | INVARIANT |
| 40001 | `LEDGER_RETRY` | RETRY (retry the whole transaction) |
| 40001 | (Postgres serialization failure) | RETRY, `dbCode` `SERIALIZATION_FAILURE` |
| 40P01 | (Postgres deadlock detected) | RETRY, `dbCode` `DEADLOCK_DETECTED` |
| LG020 | `USER_PRIVILEGE_CHANGE_FORBIDDEN` | - |
| LG021 | `HAND_AUDIT_REQUIRED` | - |

`LedgerError.dbCode` keeps the precise database code for logs and tests.
`toLedgerError` decides by SQLSTATE whenever the driver reports one
(node-postgres `code`, Prisma P2010 `meta.code`); only without a SQLSTATE does
it fall back to a known `LEDGER_*` message prefix. Any other error (connection
loss, timeouts, unrelated SQLSTATEs) is not a refusal and propagates unchanged.
