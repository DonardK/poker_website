/**
 * Payments wallet schema (migration 20261019120000_payments_wallet) on the
 * disposable cluster (test/support/pg.mjs; never `.env`).
 *
 * A private database gets every migration (as pg.mjs applies them), so this
 * suite can enable EUR without racing the suites that share the harness
 * database. Payment rows are written by the payments Worker's own login,
 * poker_payments_app; the superuser only builds fixtures. Proves:
 * - the TypeScript state machines (apps/edge/src/payments/state.ts) equal the
 *   guard triggers' transition arrays and the status enums, as parsed from
 *   the migration and as read from the catalog;
 * - an exhaustive N x N matrix per machine (Deposit, Withdrawal,
 *   PayoutDispatch, PaymentInstrument), attempted as poker_payments_app:
 *   every pair outside the documented table is refused (PM003), and no
 *   documented pair is;
 * - rows start in their initial state; identity, amounts and ledger links are
 *   write-once (PM002); a PaymentEvent changes only its processing state,
 *   once; the email outbox keeps its content; payments can delete nothing and
 *   nobody can without poker.break_glass (PM001);
 * - payment binding (LG023, surfaced by SET CONSTRAINTS ALL IMMEDIATE): a
 *   deposit or withdrawal posting without its row, with a different amount,
 *   or a second credit of one deposit is refused; never release and settle;
 * - TEST_EUR isolation: sandbox provider accounts, deposits, quotes, refunds
 *   and cards are TEST_EUR only, real providers never touch it;
 * - step-up and security hold: a player's payout destination and a player
 *   withdrawal need a consumed grant of the right purpose (and bind hash,
 *   session), the 24 h cooling-off floor holds, and User.securityHoldUntil
 *   blocks both (PM008).
 *
 * Run: npm run test:db -w @poker/server  (or, inside pg.mjs --exec,
 *      node test/db/run-all.mjs payments-schema)
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrationNames, migrationsDir, withDatabase } from "../support/pg.mjs";
import { createSession, createUser, requireTestDatabase, tag } from "./support.mjs";
import { creditDeposit, holdWithdrawal } from "../../src/money/ledger.ts";
import { creditBoundDeposit, ensureCard, insertDeposit, sqlDb } from "./wallet-fixtures.mjs";
import * as machines from "../../../edge/src/payments/state.ts";

const { adminUrl, paymentsUrl } = requireTestDatabase();
const MIGRATION = "20261019120000_payments_wallet";
const MIGRATION_SQL = readFileSync(join(migrationsDir, MIGRATION, "migration.sql"), "utf8");
const database = `poker_payschema_${tag()}`;
const SANDBOX = "sandbox-card";
const REAL = "psp-real";
const WALLET_TABLES = ["PlayerCompliance", "ResponsibleGamingLimit", "SelfExclusion", "PaymentInstrument", "Deposit",
  "DepositReversal", "WithdrawalQuote", "Withdrawal", "PayoutDispatch", "PayoutAttempt", "PaymentEvent",
  "PaymentReviewAction", "PaymentSwitch", "ReconciliationRun", "ReconciliationIssue", "EmailOutbox"];

/** Superuser on the private database (fixtures only), session time zone UTC like the Workers. */
let admin;
/** poker_payments_app on the private database (time zone UTC by role default). */
let payments;
let userId;
let sessionId;

const hex = (text) => createHash("sha256").update(text).digest("hex");
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

async function expectCode(run, codes, pattern) {
  const allowed = Array.isArray(codes) ? codes : [codes];
  try {
    await run();
    assert.fail(`expected SQLSTATE ${allowed.join(" or ")}`);
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    assert.ok(allowed.includes(error.code), `${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
  }
}

/** A failing statement aborts the open transaction; a savepoint lets the test continue. */
async function expectInTx(client, run, codes, pattern) {
  await client.query("SAVEPOINT expect_code");
  await expectCode(run, codes, pattern);
  await client.query("ROLLBACK TO SAVEPOINT expect_code");
}

/** Runs fn(client) in a transaction that is rolled back unless commit is set. */
async function inTx(client, fn, { commit = false } = {}) {
  await client.query("BEGIN");
  try {
    const result = await fn(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function insertRow(client, table, values) {
  const columns = Object.keys(values);
  const result = await client.query(`INSERT INTO public."${table}" (${columns.map((column) => `"${column}"`).join(", ")})
    VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(values));
  return result.rows[0];
}

/** A step-up grant as the API mints it (createdAt and expiresAt from one database clock reading). */
async function insertGrant({ purpose, bindHash, method = "TOTP", user = userId, session = sessionId }) {
  const id = `g_${tag()}${tag()}`;
  await admin.query(`INSERT INTO public."StepUpGrant" (id, "userId", "sessionId", purpose, "bindHash", method, "createdAt", "expiresAt")
    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '5 minutes')`, [id, user, session, purpose, bindHash, method]);
  return id;
}

/** The consume statement of docs/money/WALLET.md section 10.5, as the payments login. */
async function consumeGrant(client, { id, purpose, bindHash, user = userId, session = sessionId }) {
  const { rows } = await client.query(`UPDATE public."StepUpGrant" SET "consumedAt" = CURRENT_TIMESTAMP
     WHERE id = $1 AND "userId" = $2 AND "sessionId" = $3 AND purpose = $4 AND "bindHash" = $5
       AND "consumedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP AND method = ANY ('{PASSKEY,TOTP,PASSWORD_EMAIL}')
     RETURNING method`, [id, user, session, purpose, bindHash]);
  return rows;
}

before(async () => {
  const maintenance = new pg.Client({ connectionString: withDatabase(adminUrl, "postgres") });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE ${database}`); } finally { await maintenance.end(); }
  admin = new pg.Client({ connectionString: withDatabase(adminUrl, database) });
  await admin.connect();
  await admin.query("SET TIME ZONE 'UTC'");
  for (const name of migrationNames()) await admin.query(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
  payments = new pg.Client({ connectionString: withDatabase(paymentsUrl, database) });
  await payments.connect();
  userId = await createUser(admin, `pay_${tag()}`, 0);
  sessionId = await createSession(admin, userId);
});

after(async () => {
  await payments?.end();
  await admin?.end();
  const maintenance = new pg.Client({ connectionString: withDatabase(adminUrl, "postgres") });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await maintenance.end(); }
});

// ---------------------------------------------------------------------------
// State machines: TypeScript = SQL
// ---------------------------------------------------------------------------

const MACHINES = [
  { machine: "deposit", label: "deposit", table: "Deposit", key: "id", guard: "payment_deposit_guard", type: "DepositStatus",
    statuses: machines.DEPOSIT_STATUSES, pairs: machines.DEPOSIT_TRANSITIONS },
  { machine: "withdrawal", label: "withdrawal", table: "Withdrawal", key: "id", guard: "payment_withdrawal_guard", type: "WithdrawalStatus",
    statuses: machines.WITHDRAWAL_STATUSES, pairs: machines.WITHDRAWAL_TRANSITIONS },
  { machine: "payoutDispatch", label: "dispatch", table: "PayoutDispatch", key: "withdrawalId", guard: "payout_dispatch_guard",
    type: "PayoutDispatchStatus", statuses: machines.PAYOUT_DISPATCH_STATUSES, pairs: machines.PAYOUT_DISPATCH_TRANSITIONS },
  { machine: "instrument", label: "instrument", table: "PaymentInstrument", key: "id", guard: "payment_instrument_guard",
    type: "InstrumentStatus", statuses: machines.INSTRUMENT_STATUSES, pairs: machines.INSTRUMENT_TRANSITIONS },
];

/** The 'FROM>TO' literals of a guard trigger's transition array, as written in the migration. */
function sqlTransitions(guard) {
  const start = MIGRATION_SQL.indexOf(`CREATE FUNCTION public.${guard}()`);
  assert.ok(start >= 0, `${guard} is defined in ${MIGRATION}`);
  const body = MIGRATION_SQL.slice(start, MIGRATION_SQL.indexOf("END $fn$;", start));
  const arrays = [...body.matchAll(/= ANY \(ARRAY\[([^\]]*)\]\)/g)];
  assert.equal(arrays.length, 1, `${guard} has exactly one transition array`);
  return [...arrays[0][1].matchAll(/'([A-Z_]+)>([A-Z_]+)'/g)].map((match) => `${match[1]}>${match[2]}`);
}

function sqlEnum(type) {
  const match = new RegExp(`CREATE TYPE "${type}" AS ENUM \\(([^)]*)\\)`).exec(MIGRATION_SQL);
  assert.ok(match, `${type} is created in ${MIGRATION}`);
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((value) => value[1]);
}

test("state.ts equals the migration: every status list is its enum and every transition table its guard's array", async () => {
  for (const { machine, guard, type, statuses, pairs } of MACHINES) {
    assert.deepEqual([...statuses], sqlEnum(type), `${machine}: status list = CREATE TYPE "${type}"`);
    const { rows } = await admin.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = $1::regtype ORDER BY enumsortorder`, [`"${type}"`]);
    assert.deepEqual(rows.map((row) => row.enumlabel), [...statuses], `${machine}: status list = catalog enum`);
    const ts = pairs.map(([from, to]) => `${from}>${to}`);
    assert.equal(new Set(ts).size, ts.length, `${machine}: no duplicate pair`);
    assert.deepEqual([...ts].sort(), sqlTransitions(guard).sort(), `${machine}: TypeScript pairs = ${guard} array`);
    for (const [from, to] of pairs) {
      assert.ok(statuses.includes(from) && statuses.includes(to) && from !== to, `${machine}: ${from} -> ${to} names two different statuses`);
      assert.ok(machines.canTransition(machine, from, to), `${machine}: canTransition(${from}, ${to})`);
      assert.ok(!machines.TERMINAL[machine].includes(from), `${machine}: terminal ${from} has no way out`);
    }
    for (const status of statuses) assert.ok(machines.canTransition(machine, status, status), `${machine}: staying ${status} is no transition`);
  }
});

// ---------------------------------------------------------------------------
// N x N, as the payments login
// ---------------------------------------------------------------------------

/**
 * One row per status, valid under the table's CHECKs. Written with triggers
 * and foreign keys off (session_replication_role = replica, superuser only)
 * and committed: a row in any state, without walking the machine to it. The
 * ledger and instrument ids are placeholders; a later UPDATE that leaves a
 * foreign key unchanged does not re-check it (for rows of an earlier
 * transaction), and the rows are deleted again after the matrix.
 */
function fixtureRow(machine, status) {
  const id = randomUUID();
  switch (machine) {
    case "deposit": {
      const credited = ["CONFIRMED", "CREDITED", "PARTIALLY_REVERSED", "REVERSED"].includes(status);
      const linked = ["CREDITED", "PARTIALLY_REVERSED", "REVERSED"].includes(status);
      return { id, userId, method: "CARD", providerKey: REAL, status, assetCode: "EUR", requestedMinor: "1000",
        creditedMinor: credited ? "1000" : null, confirmedAt: credited ? isoIn(0) : null,
        reversedMinor: status === "REVERSED" ? "1000" : status === "PARTIALLY_REVERSED" ? "400" : "0",
        ledgerCreditTxId: linked ? randomUUID() : null, instrumentId: linked ? randomUUID() : null, expiresAt: isoIn(1_800_000) };
    }
    case "withdrawal": {
      const routed = ["APPROVED", "SUBMITTED", "SETTLED", "RETURNED"].includes(status);
      return { id, userId, kind: "REFUND", sourceDepositId: randomUUID(), status, assetCode: "EUR", amountMinor: "1000", feeMinor: "0",
        holdTxId: status === "REQUESTED" ? null : randomUUID(),
        instrumentId: routed ? randomUUID() : null, providerKey: routed ? REAL : null,
        settleTxId: ["SETTLED", "RETURNED"].includes(status) ? randomUUID() : null,
        releaseTxId: ["FAILED", "REJECTED", "CANCELLED"].includes(status) ? randomUUID() : null,
        returnTxId: status === "RETURNED" ? randomUUID() : null };
    }
    case "payoutDispatch":
      return { withdrawalId: id, userId, providerKey: REAL, operation: "PAYOUT", providerIdempotencyKey: `wd_${id}`, status,
        attempts: status === "PENDING" ? 0 : 1, leaseUntil: isoIn(90_000) };
    case "instrument":
      return { id, userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: REAL, assetCode: "EUR", cardToken: `tok_${id}`, status,
        revokedAt: status === "REVOKED" ? isoIn(0) : null };
    default:
      throw new Error(machine);
  }
}

/** Writes or deletes fixture rows with triggers and foreign keys off, in a transaction of its own. */
async function withTriggersOff(fn) {
  await inTx(admin, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    return fn(client);
  }, { commit: true });
}

/**
 * Every ordered pair of different statuses, as poker_payments_app (SET ROLE,
 * so the attempts stay one rolled-back transaction): a status-only UPDATE.
 * "refused" = the guard's transition check (PM003 with its exact message);
 * anything else means the check let the pair through (the UPDATE went
 * through, or a later rule such as a CHECK or the approval count stopped it).
 */
async function transitionOutcomes({ machine, label, table, key, statuses }) {
  const ids = new Map();
  await withTriggersOff(async (client) => {
    for (const status of statuses) {
      const row = fixtureRow(machine, status);
      await insertRow(client, table, row);
      ids.set(status, row[key]);
    }
  });
  const outcomes = new Map();
  try {
    await inTx(admin, async (client) => {
      await client.query("SET LOCAL ROLE poker_payments_app");
      for (const from of statuses) {
        for (const to of statuses) {
          if (from === to) continue;
          await client.query("SAVEPOINT pair");
          try {
            const result = await client.query(`UPDATE public."${table}" SET "status" = $2 WHERE "${key}" = $1`, [ids.get(from), to]);
            outcomes.set(`${from}>${to}`, result.rowCount === 1 ? "passed" : `rows:${result.rowCount}`);
          } catch (error) {
            const refused = error.code === "PM003" && error.message === `PAYMENT_BAD_TRANSITION: ${label} ${from} -> ${to}`;
            outcomes.set(`${from}>${to}`, refused ? "refused" : `other:${error.code}`);
          }
          await client.query("ROLLBACK TO SAVEPOINT pair");
        }
      }
    });
  } finally {
    await withTriggersOff((client) => client.query(`DELETE FROM public."${table}" WHERE "${key}" = ANY ($1::uuid[])`, [[...ids.values()]]));
  }
  return outcomes;
}

for (const spec of MACHINES) {
  test(`${spec.machine}: of all ${spec.statuses.length} x ${spec.statuses.length - 1} status changes, exactly the documented ones pass the guard (as poker_payments_app)`, async () => {
    const allowed = new Set(spec.pairs.map(([from, to]) => `${from}>${to}`));
    const outcomes = await transitionOutcomes(spec);
    assert.equal(outcomes.size, spec.statuses.length * (spec.statuses.length - 1));
    let passed = 0;
    for (const [pair, outcome] of outcomes) {
      if (allowed.has(pair)) {
        // Through the transition check; only the row's own rules (a CHECK on the
        // companion columns, the approval count, the dispatch row) may stop it.
        assert.ok(["passed", "other:23514", "other:PM004", "other:PM003"].includes(outcome), `${spec.machine} ${pair} is documented but got ${outcome}`);
        if (outcome === "passed") passed++;
      } else {
        assert.equal(outcome, "refused", `${spec.machine} ${pair} is not documented but got ${outcome}`);
      }
    }
    assert.ok(passed > 0, `${spec.machine}: some documented change committed with a status-only update`);
  });
}

// ---------------------------------------------------------------------------
// Initial states, write-once columns, append-only rows
// ---------------------------------------------------------------------------

test("rows start in their initial state, and identity, amounts and ledger links are write-once (PM002)", async () => {
  await inTx(payments, async (client) => {
    const base = { userId, method: "CARD", providerKey: SANDBOX, assetCode: "TEST_EUR", requestedMinor: "500", expiresAt: isoIn(1_800_000) };
    await expectInTx(client, () => insertRow(client, "Deposit", { ...base, status: "CONFIRMED", creditedMinor: "500", confirmedAt: isoIn(0) }), "PM003", /starts CREATED or NEEDS_REVIEW/);
    const { depositId } = await creditBoundDeposit(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR", amount: 500n });
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [column, value] of [["requestedMinor", "501"], ["providerKey", "sandbox-other"], ["creditedMinor", "499"],
      ["ledgerCreditTxId", randomUUID()], ["userId", userId.toUpperCase()], ["createdAt", isoIn(-60_000)]]) {
      await expectInTx(client, () => client.query(`UPDATE public."Deposit" SET "${column}" = $2 WHERE id = $1`, [depositId, value]), "PM002", /write-once/);
    }

    await expectInTx(client, () => insertRow(client, "Withdrawal", { userId, kind: "REFUND", sourceDepositId: depositId, status: "HELD",
      assetCode: "TEST_EUR", amountMinor: "100" }), "PM003", /starts REQUESTED/);
    const refund = await insertRow(client, "Withdrawal", { userId, kind: "REFUND", sourceDepositId: depositId, assetCode: "TEST_EUR", amountMinor: "100" });
    await expectInTx(client, () => client.query(`UPDATE public."Withdrawal" SET "amountMinor" = 99 WHERE id = $1`, [refund.id]), "PM002");
    // A dispatch follows an APPROVED withdrawal only, and starts PENDING.
    await expectInTx(client, () => insertRow(client, "PayoutDispatch", { withdrawalId: refund.id, userId, providerKey: SANDBOX, operation: "REFUND",
      providerIdempotencyKey: `rf_${refund.id}` }), "PM006", /approved withdrawal/);
    await expectInTx(client, () => insertRow(client, "PayoutDispatch", { withdrawalId: refund.id, userId, providerKey: SANDBOX, operation: "REFUND",
      providerIdempotencyKey: `rf_${refund.id}`, status: "IN_FLIGHT", leaseUntil: isoIn(90_000) }), "PM003", /starts PENDING/);

    const cardId = await ensureCard(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR" });
    await expectInTx(client, () => insertRow(client, "PaymentInstrument", { userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: SANDBOX,
      assetCode: "TEST_EUR", cardToken: `tok_${tag()}`, status: "BLOCKED" }), "PM003", /starts ACTIVE/);
    // Identity columns are not even granted; granted ones only move forward.
    await expectInTx(client, () => client.query(`UPDATE public."PaymentInstrument" SET "cardToken" = 'tok_x' WHERE id = $1`, [cardId]), "42501");
    await expectInTx(client, () => client.query(`UPDATE public."PaymentInstrument" SET "usableAfter" = "usableAfter" - interval '1 day' WHERE id = $1`, [cardId]), "PM002");
    await expectInTx(client, () => client.query(`UPDATE public."PaymentInstrument" SET "successfulPayouts" = -1 WHERE id = $1`, [cardId]), "PM002");

    // The email outbox: content fixed, SENT final.
    await expectInTx(client, () => insertRow(client, "EmailOutbox", { userId, template: "deposit-credited", scope: "TEST_EUR", dedupeKey: `d:${tag()}`, status: "SENT", sentAt: isoIn(0) }), "PM003");
    await expectInTx(client, () => insertRow(client, "EmailOutbox", { userId, template: "deposit-credited", dedupeKey: `d:${tag()}` }), "23502");
    await expectInTx(client, () => insertRow(client, "EmailOutbox", { userId, template: "deposit-credited", scope: "PLAY", dedupeKey: `d:${tag()}` }), "23514");
    const mail = await insertRow(client, "EmailOutbox", { userId, template: "deposit-credited", scope: "TEST_EUR", dedupeKey: `deposit-credited:${depositId}`, payload: { amount: "5.00" } });
    await expectInTx(client, () => client.query(`UPDATE public."EmailOutbox" SET "template" = 'chargeback' WHERE id = $1`, [mail.id]), "42501");
    await client.query(`UPDATE public."EmailOutbox" SET "status" = 'SENT', "sentAt" = CURRENT_TIMESTAMP, "attempts" = 1 WHERE id = $1`, [mail.id]);
    await expectInTx(client, () => client.query(`UPDATE public."EmailOutbox" SET "status" = 'PENDING', "sentAt" = NULL WHERE id = $1`, [mail.id]), "PM002", /final/);
    await expectInTx(client, () => insertRow(client, "EmailOutbox", { userId, template: "deposit-credited", scope: "TEST_EUR", dedupeKey: `deposit-credited:${depositId}` }), "23505");
  });
});

test("a card has one live row per player; a revoked row stays revoked and a new one takes its place", async () => {
  await inTx(payments, async (client) => {
    const token = `tok_${tag()}`;
    const card = { userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: SANDBOX, assetCode: "TEST_EUR", cardToken: token };
    const first = await insertRow(client, "PaymentInstrument", card);
    await expectInTx(client, () => insertRow(client, "PaymentInstrument", card), "PM005", /already saved/);
    await client.query(`UPDATE public."PaymentInstrument" SET "status" = 'REVOKED', "revokedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [first.id]);
    await expectInTx(client, () => client.query(`UPDATE public."PaymentInstrument" SET "status" = 'ACTIVE', "revokedAt" = NULL WHERE id = $1`, [first.id]), "PM003", /instrument REVOKED -> ACTIVE/);
    const second = await insertRow(client, "PaymentInstrument", { ...card, payoutEnabled: true });
    assert.notEqual(second.id, first.id);
    const { rows: [{ cooling }] } = await client.query(`SELECT "usableAfter" >= CURRENT_TIMESTAMP + interval '23 hours' AS cooling FROM public."PaymentInstrument" WHERE id = $1`, [second.id]);
    assert.equal(cooling, true, "the new row cools off");
  });
});

test("a credited card deposit names its card (the Deposit CHECK), a crypto one does not need to", async () => {
  const row = fixtureRow("deposit", "CREDITED");
  await assert.rejects(withTriggersOff((client) => insertRow(client, "Deposit", { ...row, instrumentId: null, userId })), (error) => error.code === "23514");
  await withTriggersOff((client) => insertRow(client, "Deposit", { ...row, payAssetCode: "USDC_ERC20", method: "CRYPTO", instrumentId: null, userId }));
  await withTriggersOff((client) => client.query(`DELETE FROM public."Deposit" WHERE id = $1`, [row.id]));
});

test("a withdrawal marked for cancelling can only be released (write-once, never approved or submitted)", async () => {
  const ids = {};
  await withTriggersOff(async (client) => {
    for (const status of ["HELD", "UNDER_REVIEW", "APPROVED", "SUBMITTED"]) {
      const row = fixtureRow("withdrawal", status);
      await insertRow(client, "Withdrawal", row);
      ids[status] = row.id;
    }
  });
  try {
    await inTx(admin, async (client) => {
      await client.query("SET LOCAL ROLE poker_payments_app");
      const mark = (id) => client.query(`UPDATE public."Withdrawal" SET "cancelRequestedAt" = now(), "cancelCode" = 'SECURITY_LOCKDOWN' WHERE id = $1`, [id]);
      await expectInTx(client, () => mark(ids.SUBMITTED), "PM003", /has not been sent/);
      await expectInTx(client, () => client.query(`UPDATE public."Withdrawal" SET "cancelRequestedAt" = now() WHERE id = $1`, [ids.HELD]), "23514");
      await mark(ids.HELD);
      await mark(ids.UNDER_REVIEW);
      await expectInTx(client, () => client.query(`UPDATE public."Withdrawal" SET "cancelCode" = 'OTHER' WHERE id = $1`, [ids.HELD]), "PM002");
      await expectInTx(client, () => client.query(`UPDATE public."Withdrawal" SET "cancelRequestedAt" = NULL, "cancelCode" = NULL WHERE id = $1`, [ids.HELD]), "PM002");
      await expectInTx(client, () => client.query(`UPDATE public."Withdrawal" SET "status" = 'APPROVED' WHERE id = $1`, [ids.UNDER_REVIEW]), "PM003", /cannot go forward/);
      await mark(ids.APPROVED);
      await expectInTx(client, () => client.query(`UPDATE public."Withdrawal" SET "status" = 'SUBMITTED' WHERE id = $1`, [ids.APPROVED]), "PM003", /cannot go forward/);
    });
  } finally {
    await withTriggersOff(async (client) => client.query(`DELETE FROM public."Withdrawal" WHERE id = ANY($1::uuid[])`, [Object.values(ids)]));
  }
});

test("a timed self-exclusion ends only on the player's request plus 24 hours; an indefinite one on an administrator's acceptance plus 7 days", async () => {
  const ended = { id: randomUUID(), kind: "DEFINITE", startsAt: isoIn(-7 * 86_400_000), endsAt: isoIn(-3_600_000) };
  const running = { id: randomUUID(), kind: "DEFINITE", startsAt: isoIn(-3_600_000), endsAt: isoIn(86_400_000) };
  const open = { id: randomUUID(), kind: "INDEFINITE", startsAt: isoIn(-3_600_000), endsAt: null };
  await withTriggersOff(async (client) => {
    for (const row of [ended, running, open]) await insertRow(client, "SelfExclusion", { ...row, userId, source: "PLAYER", createdBy: userId });
  });
  const runtimeRole = "poker_app";
  const request = (client, id) => client.query(`UPDATE public."SelfExclusion" SET "reactivationRequestedAt" = now() WHERE id = $1 RETURNING *`, [id]);
  const accept = (client, id) => client.query(`UPDATE public."SelfExclusion" SET "reactivationAcceptedAt" = now(), "reactivationAcceptedBy" = 'admin_1' WHERE id = $1 RETURNING *`, [id]);
  try {
    await inTx(admin, async (client) => {
      await client.query(`SET LOCAL ROLE ${runtimeRole}`);
      await expectInTx(client, () => request(client, running.id), "PM007", /before it ends/);
      const { rows: [row] } = await request(client, ended.id);
      assert.equal(row.reactivationAcceptedBy, "PLAYER_REQUEST");
      const wait = new Date(row.accessRestoredAt).getTime() - new Date(row.reactivationRequestedAt).getTime();
      assert.equal(wait, 24 * 3_600_000);
      const { rows: [asked] } = await request(client, open.id);
      assert.equal(asked.accessRestoredAt, null);
      // The runtime login cannot accept, or restore access itself.
      await expectInTx(client, () => accept(client, open.id), "42501");
      await expectInTx(client, () => client.query(`UPDATE public."SelfExclusion" SET "accessRestoredAt" = now() WHERE id = $1`, [open.id]), "42501");
      await client.query("RESET ROLE");
      await client.query("SET LOCAL ROLE poker_payments_app");
      const { rows: [accepted] } = await accept(client, open.id);
      assert.equal(new Date(accepted.accessRestoredAt).getTime() - new Date(accepted.reactivationAcceptedAt).getTime(), 7 * 86_400_000);
      await expectInTx(client, () => accept(client, running.id), "PM007");
    });
  } finally {
    await withTriggersOff(async (client) => client.query(`DELETE FROM public."SelfExclusion" WHERE id = ANY($1::uuid[])`, [[ended.id, running.id, open.id]]));
  }
});

test("a PaymentEvent is stored verified and changes only its processing state, once (a DEAD event may be requeued)", async () => {
  await inTx(payments, async (client) => {
    const event = await insertRow(client, "PaymentEvent", { provider: SANDBOX, providerEventId: `evt_${tag()}`, eventType: "payment.succeeded",
      objectType: "PAYMENT", payloadSha256: hex("body"), payload: { id: "p_1" }, signatureScheme: "hmac-sha256", signatureVerified: true });
    await expectInTx(client, () => insertRow(client, "PaymentEvent", { provider: SANDBOX, providerEventId: `evt_${tag()}`, eventType: "x",
      objectType: "PAYMENT", payloadSha256: hex("x"), payload: {}, signatureScheme: "none", signatureVerified: false }), "23514");
    await expectInTx(client, () => insertRow(client, "PaymentEvent", { provider: SANDBOX, providerEventId: event.providerEventId, eventType: "x",
      objectType: "PAYMENT", payloadSha256: hex("x"), payload: {}, signatureScheme: "hmac-sha256", signatureVerified: true }), "23505");
    await expectInTx(client, () => client.query(`UPDATE public."PaymentEvent" SET "payload" = '{}' WHERE id = $1`, [event.id]), "42501");
    await client.query(`UPDATE public."PaymentEvent" SET "attempts" = 1, "lastError" = 'timeout', "nextAttemptAt" = CURRENT_TIMESTAMP + interval '2 minutes' WHERE id = $1`, [event.id]);
    await expectInTx(client, () => client.query(`UPDATE public."PaymentEvent" SET "attempts" = 0 WHERE id = $1`, [event.id]), "PM002");
    await client.query(`UPDATE public."PaymentEvent" SET "outcome" = 'DEAD', "processedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [event.id]);
    await client.query(`UPDATE public."PaymentEvent" SET "outcome" = 'APPLIED', "processedAt" = CURRENT_TIMESTAMP + interval '1 second' WHERE id = $1`, [event.id]);
    await expectInTx(client, () => client.query(`UPDATE public."PaymentEvent" SET "outcome" = 'DUPLICATE' WHERE id = $1`, [event.id]), "PM002", /only processing state changes once/);
    await expectInTx(client, () => client.query(`UPDATE public."PaymentEvent" SET "outcome" = NULL, "processedAt" = NULL WHERE id = $1`, [event.id]), "PM002");
  });
  // Not even the superuser rewrites what the provider sent.
  await inTx(admin, async (client) => {
    const event = await insertRow(client, "PaymentEvent", { provider: SANDBOX, providerEventId: `evt_${tag()}`, eventType: "payment.succeeded",
      objectType: "PAYMENT", payloadSha256: hex("body2"), payload: { id: "p_2" }, signatureScheme: "hmac-sha256", signatureVerified: true });
    await expectInTx(client, () => client.query(`UPDATE public."PaymentEvent" SET "payload" = '{"id":"forged"}' WHERE id = $1`, [event.id]), "PM002");
  });
});

test("payments can delete no wallet row; the superuser only with poker.break_glass, and never a dispatch", async () => {
  await inTx(payments, async (client) => {
    for (const table of WALLET_TABLES) {
      await expectInTx(client, () => client.query(`DELETE FROM public."${table}"`), "42501");
    }
  });
  await inTx(admin, async (client) => {
    const depositId = await insertDeposit(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR", amount: 100n });
    await expectInTx(client, () => client.query(`DELETE FROM public."Deposit" WHERE id = $1`, [depositId]), "PM001");
    await expectInTx(client, () => client.query(`DELETE FROM public."PaymentSwitch" WHERE "key" = 'AUTO_APPROVE'`), "PM001");
    // A payout outbox row (fixture written with triggers off) has no hatch at all:
    // its provider idempotency key lives as long as the withdrawal.
    await client.query("SET LOCAL session_replication_role = replica");
    const dispatch = await insertRow(client, "PayoutDispatch", fixtureRow("payoutDispatch", "COMPLETED"));
    await client.query("SET LOCAL session_replication_role = origin");
    await client.query("SELECT set_config('poker.break_glass', 'on', true)");
    const deleted = await client.query(`DELETE FROM public."Deposit" WHERE id = $1`, [depositId]);
    assert.equal(deleted.rowCount, 1, "break_glass is the administrator's maintenance hatch");
    await expectInTx(client, () => client.query(`DELETE FROM public."PayoutDispatch" WHERE "withdrawalId" = $1`, [dispatch.withdrawalId]), "PM001");
  });
});

// ---------------------------------------------------------------------------
// Payment binding (D-W4)
// ---------------------------------------------------------------------------

test("payment binding: a deposit or withdrawal posting without exactly its row and amounts is refused at SET CONSTRAINTS (LG023)", async () => {
  const db = (client) => sqlDb(client);
  await inTx(payments, async (client) => {
    // A credit with no Deposit row at all.
    await client.query("SAVEPOINT unbound");
    await creditDeposit(db(client), { key: `deposit-credit:${randomUUID()}`, depositId: randomUUID(), asset: "TEST_EUR", userId,
      providerKey: SANDBOX, amount: 700n, providerReference: "nothing" });
    await expectCode(() => client.query("SET CONSTRAINTS ALL IMMEDIATE"), "LG023", /LEDGER_UNBOUND_PAYMENT/);
    await client.query("ROLLBACK TO SAVEPOINT unbound");

    // A Deposit row whose credited amount differs from the posting.
    await client.query("SAVEPOINT mismatch");
    const short = await insertDeposit(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR", amount: 700n });
    const txId = await creditDeposit(db(client), { key: `deposit-credit:${short}`, depositId: short, asset: "TEST_EUR", userId,
      providerKey: SANDBOX, amount: 700n, providerReference: short });
    const shortCard = await ensureCard(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR" });
    await client.query(`UPDATE public."Deposit" SET "status" = 'CONFIRMED', "creditedMinor" = 699, "confirmedAt" = CURRENT_TIMESTAMP, "instrumentId" = $2 WHERE id = $1`, [short, shortCard]);
    await client.query(`UPDATE public."Deposit" SET "status" = 'CREDITED', "ledgerCreditTxId" = $2, "creditedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [short, txId]);
    await expectCode(() => client.query("SET CONSTRAINTS ALL IMMEDIATE"), "LG023");
    await client.query("ROLLBACK TO SAVEPOINT mismatch");

    // A correct credit commits; a second credit of the same deposit (another key) can bind to nothing.
    const { depositId } = await creditBoundDeposit(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR", amount: 700n });
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    // IMMEDIATE lasts for the rest of the transaction (moneyTx issues it last); defer again to go on.
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SAVEPOINT twice");
    const again = await creditDeposit(db(client), { key: `deposit-credit:${depositId}:again`, depositId, asset: "TEST_EUR", userId,
      providerKey: SANDBOX, amount: 700n, providerReference: depositId });
    await expectInTx(client, () => client.query(`UPDATE public."Deposit" SET "ledgerCreditTxId" = $2 WHERE id = $1`, [depositId, again]), "PM002");
    await expectCode(() => client.query("SET CONSTRAINTS ALL IMMEDIATE"), "LG023");
    await client.query("ROLLBACK TO SAVEPOINT twice");

    // A hold with no Withdrawal row.
    await client.query("SAVEPOINT hold");
    await holdWithdrawal(db(client), { key: `withdrawal-hold:${randomUUID()}`, asset: "TEST_EUR", userId, withdrawalId: randomUUID(), amount: 100n });
    await expectCode(() => client.query("SET CONSTRAINTS ALL IMMEDIATE"), "LG023");
    await client.query("ROLLBACK TO SAVEPOINT hold");

    // A reversal must name a credited deposit of the same user and provider.
    const uncredited = await insertDeposit(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR", amount: 100n });
    await expectInTx(client, () => insertRow(client, "DepositReversal", { depositId: uncredited, userId, providerKey: SANDBOX, kind: "CHARGEBACK",
      providerReversalId: `cb_${tag()}`, amountMinor: "100", userPortionMinor: "100", lossMinor: "0", ledgerTxId: randomUUID() }), "PM006");
  });
  // Never both a release and a settlement (a CHECK, whatever wrote the row).
  await inTx(admin, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await expectCode(() => insertRow(client, "Withdrawal", { ...fixtureRow("withdrawal", "SETTLED"), releaseTxId: randomUUID() }), "23514", /Withdrawal_valid/);
  });
});

// ---------------------------------------------------------------------------
// TEST_EUR isolation (INTEGRATION.md override 14)
// ---------------------------------------------------------------------------

test("TEST_EUR is seeded enabled, EUR stays disabled and every PaymentSwitch is off after the migration", async () => {
  const { rows } = await admin.query(`SELECT "code", "kind"::text AS kind, "decimals", "enabled" FROM public."Asset" WHERE "code" IN ('EUR', 'TEST_EUR') ORDER BY "code"`);
  assert.deepEqual(rows, [{ code: "EUR", kind: "FIAT", decimals: 2, enabled: false }, { code: "TEST_EUR", kind: "TEST", decimals: 2, enabled: true }]);
  const { rows: switches } = await admin.query(`SELECT "key", "enabled" FROM public."PaymentSwitch" ORDER BY "key"`);
  assert.deepEqual(switches.map((row) => row.key), ["AUTO_APPROVE", "DEPOSIT_CARD", "DEPOSIT_CRYPTO", "NEW_INSTRUMENTS", "PAYOUT_DISPATCH", "WITHDRAW_CARD", "WITHDRAW_CRYPTO"]);
  assert.ok(switches.every((row) => row.enabled === false), "every switch starts off");
});

test("TEST_EUR isolation: the sandbox moves only TEST_EUR and a real provider never does (accounts, deposits, cards, quotes, refunds)", async () => {
  await inTx(admin, async (client) => {
    // EUR on for this rolled-back transaction only, so the sandbox rule (not "disabled") is what refuses.
    await client.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
    await client.query("SET LOCAL ROLE poker_payments_app");
    const ensure = (asset, type, providerKey) => client.query(`SELECT public.ledger_ensure_account($1, $2, NULL, NULL, $3)`, [asset, type, providerKey]);
    for (const type of ["DEPOSIT_CLEARING", "WITHDRAWAL_CLEARING", "PROVIDER_FEES"]) {
      await expectInTx(client, () => ensure("TEST_EUR", type, REAL), "LG014", /test assets only with the sandbox/);
      await expectInTx(client, () => ensure("TEST_EUR", type, "sandboxed"), "LG014");
      await expectInTx(client, () => ensure("EUR", type, SANDBOX), "LG014");
      await expectInTx(client, () => ensure("EUR", type, "sandbox"), "LG014");
      await ensure("TEST_EUR", type, SANDBOX);
      await ensure("TEST_EUR", type, "sandbox:preview");
      await ensure("EUR", type, REAL);
    }
    const deposit = (asset, providerKey) => insertRow(client, "Deposit", { userId, method: "CARD", providerKey, assetCode: asset, requestedMinor: "100", expiresAt: isoIn(600_000) });
    await expectInTx(client, () => deposit("TEST_EUR", REAL), "PM006", /test asset with the sandbox/);
    await expectInTx(client, () => deposit("EUR", SANDBOX), "PM006");
    await expectInTx(client, () => deposit("PLAY", REAL), "PM006");
    const testDeposit = await deposit("TEST_EUR", SANDBOX);
    await deposit("EUR", REAL);

    // usableAfter in the past: TIMESTAMP(3) rounds CURRENT_TIMESTAMP, so "now" can sit a fraction of a millisecond ahead.
    const card = (asset, providerKey) => insertRow(client, "PaymentInstrument", { userId, kind: "CARD_TOKEN", origin: "OPERATOR", providerKey,
      assetCode: asset, cardToken: `tok_${tag()}`, payoutEnabled: true, usableAfter: isoIn(-60_000) });
    await expectInTx(client, () => card("TEST_EUR", REAL), "PM006", /test asset with the sandbox/);
    await expectInTx(client, () => card("EUR", SANDBOX), "PM006");
    const realCard = await card("EUR", REAL);
    const sandboxCard = await card("TEST_EUR", SANDBOX);

    const quote = (asset, instrument) => insertRow(client, "WithdrawalQuote", { userId, instrumentId: instrument.id, providerKey: instrument.providerKey,
      assetCode: asset, amountMinor: "100", feeMinor: "0", receiveAssetCode: asset, bindHash: hex(tag()), expiresAt: isoIn(120_000) });
    await expectInTx(client, () => quote("TEST_EUR", realCard), "PM006");
    await expectInTx(client, () => quote("EUR", sandboxCard), "PM006");
    await quote("TEST_EUR", sandboxCard);
    await quote("EUR", realCard);

    // A refund of the sandbox deposit can be routed to the sandbox only.
    const refund = await insertRow(client, "Withdrawal", { userId, kind: "REFUND", sourceDepositId: testDeposit.id, assetCode: "TEST_EUR", amountMinor: "100" });
    await expectInTx(client, () => client.query(`UPDATE public."Withdrawal" SET "providerKey" = $2, "instrumentId" = $3 WHERE id = $1`, [refund.id, REAL, realCard.id]), "PM006");
    await client.query(`UPDATE public."Withdrawal" SET "providerKey" = $2, "instrumentId" = $3 WHERE id = $1`, [refund.id, SANDBOX, sandboxCard.id]);
  });
});

// ---------------------------------------------------------------------------
// Step-up grants and the security hold (INTEGRATION.md overrides 8 and 9)
// ---------------------------------------------------------------------------

test("a player's payout destination needs a consumed payout_destination grant of its session, cools off 24 h, and waits out a security hold", async () => {
  const { rows: [asset] } = await admin.query(`SELECT "code", "network" FROM public."Asset" WHERE "code" = 'USDC_ERC20'`);
  const address = `0x${"ab".repeat(20)}`;
  const destination = (grantId, overrides = {}) => insertRow(payments, "PaymentInstrument", { userId, kind: "CRYPTO_ADDRESS", origin: "PLAYER",
    providerKey: "crypto-psp", assetCode: asset.code, network: asset.network, address, addressNormalized: address, payoutEnabled: true,
    createdBySessionId: sessionId, stepUpGrantId: grantId, usableAfter: isoIn(0), ...overrides });
  const bindHash = hex(`destination:${tag()}`);
  const otherSession = await createSession(admin, userId);
  await inTx(payments, async (client) => {
    await expectInTx(client, () => destination(null), "PM009");
    const unconsumed = await insertGrant({ purpose: "payout_destination", bindHash });
    await expectInTx(client, () => destination(unconsumed), "PM009", /PAYMENT_STEP_UP_REQUIRED/);
    const wrongPurpose = await insertGrant({ purpose: "withdrawal", bindHash });
    assert.equal((await consumeGrant(client, { id: wrongPurpose, purpose: "withdrawal", bindHash })).length, 1);
    await expectInTx(client, () => destination(wrongPurpose), "PM009");

    const good = await insertGrant({ purpose: "payout_destination", bindHash });
    assert.deepEqual(await consumeGrant(client, { id: good, purpose: "payout_destination", bindHash: hex("another action") }), [], "another bind hash matches nothing");
    assert.deepEqual(await consumeGrant(client, { id: good, purpose: "payout_destination", bindHash }), [{ method: "TOTP" }]);
    assert.deepEqual(await consumeGrant(client, { id: good, purpose: "payout_destination", bindHash }), [], "a grant works once");
    await expectInTx(client, () => destination(good, { createdBySessionId: otherSession }), "PM009");
    const saved = await destination(good);
    const { rows: [cooling] } = await client.query(`SELECT "usableAfter" >= CURRENT_TIMESTAMP + interval '24 hours' - interval '1 second' AS floor FROM public."PaymentInstrument" WHERE id = $1`, [saved.id]);
    assert.equal(cooling.floor, true, "the database cooling-off floor overrides usableAfter = now");
    await expectInTx(client, () => destination(good), ["PM005", "23505"]);
  });

  // During a security hold no destination can be added, even with a fresh grant.
  await admin.query(`UPDATE public."User" SET "securityHoldUntil" = CURRENT_TIMESTAMP + interval '1 hour' WHERE id = $1`, [userId]);
  try {
    await inTx(payments, async (client) => {
      const grantId = await insertGrant({ purpose: "payout_destination", bindHash });
      assert.equal((await consumeGrant(client, { id: grantId, purpose: "payout_destination", bindHash })).length, 1);
      await expectInTx(client, () => destination(grantId), "PM008", /PAYMENT_SECURITY_HOLD/);
    });
  } finally {
    await admin.query(`UPDATE public."User" SET "securityHoldUntil" = NULL WHERE id = $1`, [userId]);
  }
});

test("a player withdrawal is exactly its consumed quote, authorised by a consumed withdrawal grant bound to that quote, and waits out a security hold", async () => {
  const cardId = await inTx(payments, (client) => ensureCard(client, { userId, providerKey: SANDBOX, asset: "TEST_EUR" }), { commit: true });
  const bindHash = hex(`withdrawal:${tag()}`);
  const newQuote = (client) => insertRow(client, "WithdrawalQuote", { userId, instrumentId: cardId, providerKey: SANDBOX, assetCode: "TEST_EUR",
    amountMinor: "1000", feeMinor: "0", receiveAssetCode: "TEST_EUR", bindHash, expiresAt: isoIn(120_000) });
  const request = (client, quote, grantId, overrides = {}) => insertRow(client, "Withdrawal", { userId, kind: "PLAYER", clientRequestId: randomUUID(),
    requestHash: hex(tag()), quoteId: quote.id, instrumentId: cardId, providerKey: SANDBOX, assetCode: "TEST_EUR", amountMinor: "1000",
    feeMinor: "0", sessionId, stepUpGrantId: grantId, ...overrides });

  const otherSession = await createSession(admin, userId);
  await inTx(payments, async (client) => {
    const quote = await newQuote(client);
    const grantId = await insertGrant({ purpose: "withdrawal", bindHash });
    await expectInTx(client, () => request(client, quote, grantId), "PM006", /consumed quote/);
    await client.query(`UPDATE public."WithdrawalQuote" SET "consumedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [quote.id]);
    await expectInTx(client, () => client.query(`UPDATE public."WithdrawalQuote" SET "consumedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [quote.id]), "PM002", /consumed once/);
    await expectInTx(client, () => request(client, quote, grantId, { amountMinor: "999" }), "PM006");
    await expectInTx(client, () => request(client, quote, grantId), "PM009", /consumed withdrawal grant/);
    const otherBind = await insertGrant({ purpose: "withdrawal", bindHash: hex("another quote") });
    assert.equal((await consumeGrant(client, { id: otherBind, purpose: "withdrawal", bindHash: hex("another quote") })).length, 1);
    await expectInTx(client, () => request(client, quote, otherBind), "PM009");
    assert.equal((await consumeGrant(client, { id: grantId, purpose: "withdrawal", bindHash })).length, 1);
    await expectInTx(client, () => request(client, quote, grantId, { sessionId: otherSession }), "PM009");
    const row = await request(client, quote, grantId);
    assert.equal(row.status, "REQUESTED");
    await expectInTx(client, () => request(client, quote, grantId), "23505");
  });

  // An expired quote cannot be consumed (fixture written with triggers off, then the payments login tries).
  await inTx(admin, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const expired = await insertRow(client, "WithdrawalQuote", { userId, instrumentId: cardId, providerKey: SANDBOX, assetCode: "TEST_EUR",
      amountMinor: "1000", feeMinor: "0", receiveAssetCode: "TEST_EUR", bindHash, createdAt: isoIn(-300_000), expiresAt: isoIn(-60_000) });
    await client.query("SET LOCAL session_replication_role = origin");
    await client.query("SET LOCAL ROLE poker_payments_app");
    await expectCode(() => client.query(`UPDATE public."WithdrawalQuote" SET "consumedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [expired.id]), "PM002", /before it expires/);
  });

  await admin.query(`UPDATE public."User" SET "securityHoldUntil" = CURRENT_TIMESTAMP + interval '1 hour' WHERE id = $1`, [userId]);
  try {
    await inTx(payments, async (client) => {
      const quote = await newQuote(client);
      await client.query(`UPDATE public."WithdrawalQuote" SET "consumedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [quote.id]);
      const grantId = await insertGrant({ purpose: "withdrawal", bindHash });
      assert.equal((await consumeGrant(client, { id: grantId, purpose: "withdrawal", bindHash })).length, 1);
      await expectInTx(client, () => request(client, quote, grantId), "PM008", /PAYMENT_SECURITY_HOLD/);
    });
  } finally {
    await admin.query(`UPDATE public."User" SET "securityHoldUntil" = NULL WHERE id = $1`, [userId]);
  }
});
