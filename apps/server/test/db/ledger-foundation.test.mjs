/**
 * Real-PostgreSQL tests for the money ledger foundation
 * (migration 20261002200000_ledger_foundation, src/money/*, docs/money/LEDGER.md).
 *
 * Uses the embedded cluster from test/support/pg.mjs (127.0.0.1 only, every
 * migration applied with `prisma migrate deploy`). When started through
 * `node test/support/pg.mjs --exec ...` the cluster URLs come from
 * POKER_TEST_ADMIN_DATABASE_URL / POKER_TEST_DATABASE_URL; otherwise this file
 * starts (and stops) its own cluster.
 * Run (from apps/server): node test/support/run-tests.mjs --import tsx test/db/ledger-foundation.test.mjs
 *
 * Each database login is used exactly as production uses it: the runtime
 * (poker_app, inheriting poker_server) posts PLAY_GRANT, BUY_IN, CASH_OUT and
 * RAKE through ledger_post; the payments Worker's login (poker_payments_app)
 * posts the deposit and withdrawal types through ledger_post_payments, always
 * with the payment row they are bound to (wallet-fixtures.mjs); the
 * back-office login (poker_backoffice_app) posts ADJUSTMENT through
 * ledger_post_backoffice. The superuser only creates fixtures and inspects
 * privileges.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertLoopbackUrl, migrationNames, migrationsDir, startTestDatabase, withDatabase } from "../support/pg.mjs";
import { raceBehindRowLock } from "./support.mjs";
import {
  ENTRY_POINT, LedgerError, adjustment, buyIn, cashOut, ensureAccount, getBalances, grantPlay, post,
  providerFee, rake, reconstructBalance,
} from "../../src/money/ledger.ts";
import {
  creditBoundDeposit, holdBoundWithdrawal, inPoolTx, insertDeposit, recoverBoundChargeback, releaseBoundWithdrawal, returnBoundWithdrawal,
  reverseBoundDeposit, settleBoundWithdrawal,
} from "./wallet-fixtures.mjs";

const MIGRATION = "20261002200000_ledger_foundation";
let cluster = null;
let adminUrl;
let runtimeUrl;
let paymentsUrl;
let backofficeUrl;
let admin;
let runtime;
let payments;
let backoffice;

before(async () => {
  if (process.env.POKER_TEST_ADMIN_DATABASE_URL && process.env.POKER_TEST_DATABASE_URL) {
    adminUrl = process.env.POKER_TEST_ADMIN_DATABASE_URL;
    runtimeUrl = process.env.POKER_TEST_DATABASE_URL;
    paymentsUrl = process.env.POKER_TEST_PAYMENTS_DATABASE_URL;
    backofficeUrl = process.env.POKER_TEST_BACKOFFICE_DATABASE_URL;
  } else {
    cluster = await startTestDatabase({ log: (line) => console.error(line) });
    ({ adminUrl, runtimeUrl, paymentsUrl, backofficeUrl } = cluster);
  }
  assertLoopbackUrl(adminUrl, "admin URL");
  assertLoopbackUrl(runtimeUrl, "runtime URL");
  assertLoopbackUrl(paymentsUrl, "payments URL");
  assertLoopbackUrl(backofficeUrl, "back-office URL");
  admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  runtime = new pg.Pool({ connectionString: runtimeUrl, max: 70 });
  payments = new pg.Pool({ connectionString: paymentsUrl, max: 20 });
  backoffice = new pg.Pool({ connectionString: backofficeUrl, max: 4 });
});

after(async () => {
  await backoffice?.end();
  await payments?.end();
  await runtime?.end();
  await admin?.end();
  await cluster?.stop();
});

/** A credited EUR or TEST_EUR deposit (payments login, bound row); returns { depositId, txId }. */
const deposit = (input) => inPoolTx(payments, (client) => creditBoundDeposit(client, input));
/** A back-office adjustment: a ticket, the author and a different approver. */
const adjust = (db, input) => adjustment(db, { ticket: "OPS-1", createdBy: "staff:author", approvedBy: "staff:approver", ...input });
/**
 * What the payments Worker records when two administrators approve a money
 * adjustment (each with a passkey step-up): one APPROVE row per admin, bound
 * to the user, asset, signed amount and idempotency key. Written here by the
 * administrator connection; the back-office login cannot write them.
 */
async function approveAdjustment(approvers, { key, asset, userId, amount }) {
  for (const actor of approvers) {
    await admin.query(`INSERT INTO public."PaymentReviewAction" ("subjectType", "subjectId", "subjectUserId", "actorKind", "actorUserId",
        "actorStepUpMethod", "verb", "reasonCode", "metadata")
      VALUES ('USER', $1, $1, 'ADMIN', $2, 'PASSKEY', 'APPROVE', $3, $4::jsonb)`,
    [userId, actor, `ADJUSTMENT:${key}`, JSON.stringify({ asset, amountMinor: amount.toString() })]);
  }
}

/** The $queryRaw tagged-template interface of a Prisma client, over a pg client. */
function sqlDb(client) {
  return {
    $queryRaw(strings, ...values) {
      let text = strings[0];
      values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
      return client.query(text, values).then((result) => result.rows);
    },
  };
}

/** Runs fn(db) in one READ COMMITTED transaction on its own runtime connection. */
async function inTx(fn, pool = runtime) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(sqlDb(client), client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let fixtureSeq = 0;
async function makeUser(prefix = "u") {
  const id = `${prefix}${Date.now().toString(36)}${(fixtureSeq++).toString(36)}`;
  await admin.query(`INSERT INTO public."User" ("id", "username", "updatedAt") VALUES ($1, $1, now())`, [id]);
  return id;
}
async function makeTable() {
  const id = `t${Date.now().toString(36)}${(fixtureSeq++).toString(36)}`;
  await admin.query(`INSERT INTO public."Table" ("id", "name", "smallBlind", "bigBlind", "minBuyIn", "maxBuyIn", "updatedAt")
    VALUES ($1, $1, 1, 2, 40, 400, now())`, [id]);
  return id;
}

const rawPost = (client, key, type, reference, entries, createdBy = null) =>
  client.query("SELECT public.ledger_post($1, $2, $3::jsonb, $4::jsonb, $5)::text AS id",
    [key, type, typeof reference === "string" ? reference : JSON.stringify(reference), typeof entries === "string" ? entries : JSON.stringify(entries), createdBy])
    .then((r) => r.rows[0].id);

/** Like rawPost, through a named entry point (the role of `client` must be allowed to execute it). */
const rawPostVia = (client, fn, key, type, reference, entries, createdBy = null) => {
  if (!/^ledger_post(?:_payments|_backoffice)?$/.test(fn)) throw new Error(`not an entry point: ${fn}`);
  return client.query(`SELECT public.${fn}($1, $2, $3::jsonb, $4::jsonb, $5)::text AS id`,
    [key, type, typeof reference === "string" ? reference : JSON.stringify(reference), typeof entries === "string" ? entries : JSON.stringify(entries), createdBy])
    .then((r) => r.rows[0].id);
};

async function refused(promise, sqlstate, prefix) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, sqlstate, `expected SQLSTATE ${sqlstate}, got ${error.code}: ${error.message}`);
    if (prefix) assert.ok(error.message.startsWith(prefix), `expected ${prefix}, got: ${error.message}`);
    return true;
  });
}

async function balanceOf(accountId) {
  const { rows } = await admin.query(`SELECT "balance"::text AS b FROM public."LedgerAccount" WHERE "id" = $1`, [accountId.toString()]);
  return BigInt(rows[0].b);
}

const e = (accountId, asset, amount) => ({ accountId: String(accountId), asset, amount: String(amount) });

/** Wraps a promise so a test can check, without awaiting, whether it has settled. */
function track(promise) {
  const tracked = { settled: false, promise };
  promise.then(() => { tracked.settled = true; }, () => { tracked.settled = true; });
  return tracked;
}

/** Waits until backend `pid` is blocked on a heavyweight lock (row, key or transaction). */
async function waitUntilBlocked(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

test("the ledger migration is applied after every earlier migration", async () => {
  const names = migrationNames();
  assert.ok(names.includes(MIGRATION));
  const { rows } = await admin.query(`SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations`);
  const applied = new Map(rows.map((row) => [row.migration_name, row]));
  for (const name of names.filter((n) => n <= MIGRATION)) {
    assert.ok(applied.get(name)?.finished_at, `${name} applied`);
    assert.equal(applied.get(name).rolled_back_at, null, `${name} not rolled back`);
  }
  const assets = await admin.query(`SELECT "code", "kind"::text AS kind, "decimals", "chainDecimals", "network", "enabled" FROM public."Asset" ORDER BY "code"`);
  assert.deepEqual(assets.rows.map((a) => [a.code, a.kind, a.decimals, a.chainDecimals, a.network, a.enabled]), [
    ["BTC", "CRYPTO", 8, 8, "bitcoin", false],
    ["ETH", "CRYPTO", 9, 18, "ethereum", false],
    ["EUR", "FIAT", 2, null, null, false],
    ["PLAY", "PLAY", 0, null, null, true],
    // Sandbox money (20261019120000_payments_wallet): enabled, booked only by the sandbox provider.
    ["TEST_EUR", "TEST", 2, null, null, true],
    ["USDC_ERC20", "CRYPTO", 6, 6, "ethereum", false],
    ["USDT_ERC20", "CRYPTO", 6, 6, "ethereum", false],
    ["USDT_TRC20", "CRYPTO", 6, 6, "tron", false],
  ]);
});

test("migration applies on a database with existing rows, leaves them untouched, and works without BYPASSRLS", async () => {
  // Earlier migrations by the superuser, then legacy rows, then the ledger
  // migration by a NOSUPERUSER NOBYPASSRLS owner (like a managed-Postgres
  // admin role): the SECURITY DEFINER functions must still work under FORCE RLS.
  const db = `poker_pre_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const preAdmin = new pg.Client({ connectionString: withDatabase(adminUrl, db) });
  await preAdmin.connect();
  const ownerPassword = `pw${Math.random().toString(36).slice(2)}`;
  try {
    for (const name of migrationNames().filter((n) => n < MIGRATION)) {
      await preAdmin.query(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
    }
    await preAdmin.query(`INSERT INTO public."User" ("id", "username", "bankroll", "updatedAt") VALUES ('legacy1', 'legacy1', 12345, now()), ('legacy2', 'legacy2', 0, now())`);
    await preAdmin.query(`INSERT INTO public."Table" ("id", "name", "smallBlind", "bigBlind", "minBuyIn", "maxBuyIn", "updatedAt") VALUES ('legacyT', 'Legacy', 5, 10, 200, 2000, now())`);
    await preAdmin.query(`INSERT INTO public."Hand" ("id", "tableId", "handNumber", "dealerSeat", "board") VALUES ('legacyH', 'legacyT', 1, 0, ARRAY['As','Kd','2c'])`);
    const snapshot = async (client) => (await client.query(`
      SELECT (SELECT json_agg(u ORDER BY u.id)::text FROM public."User" u) AS users,
             (SELECT json_agg(t ORDER BY t.id)::text FROM public."Table" t) AS tables,
             (SELECT json_agg(h ORDER BY h.id)::text FROM public."Hand" h) AS hands`)).rows[0];
    const before = await snapshot(preAdmin);

    const roleExists = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'ledger_migrator'`)).rowCount > 0;
    if (!roleExists) await admin.query(`CREATE ROLE ledger_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await admin.query(`ALTER ROLE ledger_migrator PASSWORD '${ownerPassword}'`);
    await preAdmin.query(`GRANT CREATE ON SCHEMA public TO ledger_migrator`);
    await preAdmin.query(`GRANT REFERENCES, TRIGGER ON public."User", public."Table", public."Hand" TO ledger_migrator`);
    const migratorUrl = new URL(withDatabase(adminUrl, db));
    migratorUrl.username = "ledger_migrator";
    migratorUrl.password = ownerPassword;
    const migrator = new pg.Client({ connectionString: migratorUrl.toString() });
    await migrator.connect();
    try {
      await migrator.query("BEGIN");
      await migrator.query(readFileSync(join(migrationsDir, MIGRATION, "migration.sql"), "utf8"));
      await migrator.query("COMMIT");
    } finally { await migrator.end(); }

    assert.deepEqual(await snapshot(preAdmin), before, "existing User/Table/Hand rows are untouched (no backfill)");
    const owner = await preAdmin.query(`SELECT rolbypassrls, rolsuper FROM pg_roles r JOIN pg_proc p ON p.proowner = r.oid WHERE p.proname = 'ledger_post'`);
    assert.deepEqual(owner.rows[0], { rolbypassrls: false, rolsuper: false });

    const preRuntime = new pg.Client({ connectionString: withDatabase(runtimeUrl, db) });
    await preRuntime.connect();
    try {
      // This database stops at the ledger migration, whose guards still compare
      // current_user to poker_server. poker_app inherits that role and can assume it.
      await preRuntime.query("SET ROLE poker_server");
      const db2 = sqlDb(preRuntime);
      await preRuntime.query("BEGIN");
      await grantPlay(db2, { key: "pre:grant", userId: "legacy1", amount: 500n, reason: "test" });
      await buyIn(db2, { key: "pre:buy", asset: "PLAY", userId: "legacy1", tableId: "legacyT", chips: 200, chipUnit: 1n });
      await preRuntime.query("COMMIT");
      const balances = await getBalances(db2, "legacy1");
      assert.deepEqual(balances.map((b) => [b.asset, b.type, b.balance]), [["PLAY", "USER_AVAILABLE", 300n]]);
      for (const b of balances) assert.equal((await reconstructBalance(db2, b.accountId)).consistent, true);
      await refused(preRuntime.query(`UPDATE public."User" SET "role" = 'ADMIN' WHERE "id" = 'legacy2'`), "LG020", "USER_PRIVILEGE_CHANGE_FORBIDDEN");
    } finally { await preRuntime.end(); }
  } finally {
    await preAdmin.end();
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  }
});

test("functions are SECURITY DEFINER with a pinned search_path and each role may execute only its own entry point", async () => {
  const ENTRY_POINTS = ["ledger_ensure_account", "ledger_post", "ledger_post_backoffice", "ledger_post_core", "ledger_post_payments"];
  const { rows } = await admin.query(`
    SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY($1) ORDER BY p.proname`, [ENTRY_POINTS]);
  assert.deepEqual(rows.map((row) => row.proname), ENTRY_POINTS);
  // The two functions that write timestamps also pin UTC (TIMESTAMP(3) columns hold UTC whichever login calls them).
  const writesTimestamps = new Set(["ledger_ensure_account", "ledger_post_core"]);
  for (const row of rows) {
    assert.equal(row.prosecdef, true, row.proname);
    assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public, pg_temp", ...(writesTimestamps.has(row.proname) ? ["TimeZone=UTC"] : [])], row.proname);
  }
  if ((await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'ledger_outsider'`)).rowCount === 0) {
    await admin.query(`CREATE ROLE ledger_outsider NOLOGIN`);
  }
  const signatures = {
    ledger_ensure_account: "public.ledger_ensure_account(text, text, text, text, text)",
    ledger_post: "public.ledger_post(text, text, jsonb, jsonb, text)",
    ledger_post_payments: "public.ledger_post_payments(text, text, jsonb, jsonb, text)",
    ledger_post_backoffice: "public.ledger_post_backoffice(text, text, jsonb, jsonb, text)",
    ledger_post_core: "public.ledger_post_core(text[], text[], text, text, jsonb, jsonb, text)",
  };
  const expected = {
    poker_server: ["ledger_ensure_account", "ledger_post"],
    poker_app: ["ledger_ensure_account", "ledger_post"],
    poker_payments: ["ledger_ensure_account", "ledger_post_payments"],
    poker_payments_app: ["ledger_ensure_account", "ledger_post_payments"],
    poker_backoffice: ["ledger_ensure_account", "ledger_post_backoffice"],
    poker_backoffice_app: ["ledger_ensure_account", "ledger_post_backoffice"],
    ledger_outsider: [],
  };
  for (const [role, allowed] of Object.entries(expected)) {
    const granted = [];
    for (const [name, signature] of Object.entries(signatures)) {
      if ((await admin.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, signature])).rows[0].ok) granted.push(name);
    }
    assert.deepEqual(granted.sort(), allowed, role);
  }
  const rls = await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relname IN ('Asset', 'LedgerAccount', 'LedgerTransaction', 'LedgerEntry') ORDER BY relname`);
  assert.equal(rls.rows.length, 4);
  for (const row of rls.rows) assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity], [true, true], row.relname);
});

test("the runtime role can read the ledger and call the functions, but cannot write any ledger table", async () => {
  const userId = await makeUser();
  const tableId = await makeTable();
  const accountId = await inTx((db) => grantPlay(db, { key: `perm:${userId}`, userId, amount: 100n, reason: "test" })
    .then(() => ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId })));
  const { rows } = await runtime.query(`SELECT "balance"::text AS b FROM public."LedgerAccount" WHERE "id" = $1`, [accountId.toString()]);
  assert.equal(rows[0].b, "100");
  const tx = (await runtime.query(`SELECT "id" FROM public."LedgerTransaction" WHERE "idempotencyKey" = $1`, [`perm:${userId}`])).rows[0].id;
  const denied = [
    [`INSERT INTO public."LedgerAccount" ("assetCode", "type", "userId", "balance") VALUES ('PLAY', 'USER_AVAILABLE', '${await makeUser()}', 1000000)`],
    [`UPDATE public."LedgerAccount" SET "balance" = "balance" + 1000000 WHERE "id" = ${accountId}`],
    [`DELETE FROM public."LedgerAccount" WHERE "id" = ${accountId}`],
    [`INSERT INTO public."LedgerTransaction" ("idempotencyKey", "type", "payloadHash") VALUES ('forged', 'PLAY_GRANT', repeat('a', 64))`],
    [`UPDATE public."LedgerTransaction" SET "reference" = '{}' WHERE "id" = '${tx}'`],
    [`DELETE FROM public."LedgerTransaction" WHERE "id" = '${tx}'`],
    [`INSERT INTO public."LedgerEntry" ("transactionId", "accountId", "assetCode", "amount", "balanceAfter", "accountVersion") VALUES ('${tx}', ${accountId}, 'PLAY', 5, 5, 99)`],
    [`UPDATE public."LedgerEntry" SET "amount" = 1000000 WHERE "transactionId" = '${tx}'`],
    [`DELETE FROM public."LedgerEntry" WHERE "transactionId" = '${tx}'`],
    [`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`],
    [`INSERT INTO public."Asset" ("code", "kind", "decimals", "maxAmount", "enabled") VALUES ('FAKE', 'FIAT', 2, 1, true)`],
    [`DELETE FROM public."Asset" WHERE "code" = 'EUR'`],
    [`TRUNCATE public."LedgerEntry"`],
    [`TRUNCATE public."LedgerAccount" CASCADE`],
    [`SELECT nextval('public."LedgerAccount_id_seq"')`],
  ];
  for (const [sql] of denied) await refused(runtime.query(sql), "42501");
  assert.equal(await balanceOf(accountId), 100n, "nothing changed");
  // Also refused for administrators: the journal is append-only.
  await refused(admin.query(`UPDATE public."LedgerEntry" SET "amount" = 7 WHERE "transactionId" = $1`, [tx]), "LG016", "LEDGER_IMMUTABLE");
  await refused(admin.query(`DELETE FROM public."LedgerTransaction" WHERE "id" = $1`, [tx]), "LG016", "LEDGER_IMMUTABLE");
  void tableId;
});

test("ledger_ensure_account is idempotent and validates owner, type and asset", async () => {
  const userId = await makeUser();
  const tableId = await makeTable();
  const db = sqlDb(runtime);
  const a = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId });
  assert.equal(await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId }), a);
  const ensure = (asset, type, user, table, provider) =>
    runtime.query("SELECT public.ledger_ensure_account($1, $2, $3, $4, $5)", [asset, type, user, table, provider]);
  await refused(ensure("PLAY", "USER_WITHDRAWAL_HOLD", userId, null, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "DEPOSIT_CLEARING", null, null, "psp"), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "ADJUSTMENTS", null, null, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "USER_AVAILABLE", userId, tableId, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "USER_AVAILABLE", null, null, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "USER_AVAILABLE", "", null, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "TABLE_ESCROW", userId, null, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "PLAY_ISSUANCE", userId, null, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "NOT_A_TYPE", userId, null, null), "LG014", "LEDGER_BAD_ACCOUNT");
  await refused(ensure("PLAY", "USER_AVAILABLE", "no-such-user", null, null), "LG019", "LEDGER_UNKNOWN_OWNER");
  await refused(ensure("PLAY", "TABLE_ESCROW", null, "no-such-table", null), "LG019", "LEDGER_UNKNOWN_OWNER");
  await refused(ensure("EUR", "USER_AVAILABLE", userId, null, null), "LG009", "LEDGER_ASSET_DISABLED");
  await refused(ensure("DOGE", "USER_AVAILABLE", userId, null, null), "LG010", "LEDGER_UNKNOWN_ASSET");
  // The TypeScript client maps the disabled-asset refusal.
  await assert.rejects(ensureAccount(db, { asset: "BTC", type: "USER_AVAILABLE", userId }),
    (error) => error instanceof LedgerError && error.code === "ASSET_DISABLED");
  // Concurrent first creation of the same account yields one row.
  const fresh = await makeUser();
  const ids = await Promise.all(Array.from({ length: 12 }, () => inTx((d) => ensureAccount(d, { asset: "PLAY", type: "USER_AVAILABLE", userId: fresh }))));
  assert.equal(new Set(ids.map(String)).size, 1);
});

test("the database itself refuses invalid postings when ledger_post is called directly", async () => {
  const userId = await makeUser();
  const other = await makeUser();
  const tableId = await makeTable();
  const db = sqlDb(runtime);
  await grantPlay(db, { key: `direct:${userId}`, userId, amount: 1000n, reason: "test" });
  const issuance = await ensureAccount(db, { asset: "PLAY", type: "PLAY_ISSUANCE" });
  const user = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId });
  const user2 = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId: other });
  const escrow = await ensureAccount(db, { asset: "PLAY", type: "TABLE_ESCROW", tableId });
  const c = runtime;
  let n = 0;
  const key = () => `direct-refusal:${userId}:${n++}`;
  const ok = [e(user, "PLAY", -10), e(escrow, "PLAY", 10)];

  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -10), e(escrow, "PLAY", 9)]), "LG008", "LEDGER_UNBALANCED");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -10), e(escrow, "EUR", 10)]), "LG008", "LEDGER_UNBALANCED");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "EUR", -10), e(escrow, "EUR", 10)]), "LG009", "LEDGER_ASSET_DISABLED");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "DOGE", -10), e(escrow, "DOGE", 10)]), "LG010", "LEDGER_UNKNOWN_ASSET");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -5000), e(escrow, "PLAY", 5000)]), "LG011", "LEDGER_INSUFFICIENT_FUNDS");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", "-9223372036854775808"), e(escrow, "PLAY", "9223372036854775808")]), "LG004", "LEDGER_AMOUNT_OVERFLOW");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", "-99999999999999999999999"), e(escrow, "PLAY", "99999999999999999999999")]), "LG004", "LEDGER_AMOUNT_OVERFLOW");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -1000000000001), e(escrow, "PLAY", 1000000000001)]), "LG005", "LEDGER_AMOUNT_LIMIT");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -10), e(999999999, "PLAY", 10)]), "LG006", "LEDGER_UNKNOWN_ACCOUNT");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", 0), e(escrow, "PLAY", 0)]), "LG017", "LEDGER_ZERO_AMOUNT");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", "-0"), e(escrow, "PLAY", "0")]), "LG017", "LEDGER_ZERO_AMOUNT");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -10)]), "LG003", "LEDGER_TOO_FEW_ENTRIES");
  await refused(rawPost(c, key(), "BUY_IN", {}, []), "LG003", "LEDGER_TOO_FEW_ENTRIES");
  await refused(rawPost(c, key(), "BUY_IN", {}, Array.from({ length: 17 }, (_, i) => e(i + 1, "PLAY", i % 2 ? 1 : -1))), "LG015", "LEDGER_TOO_MANY_ENTRIES");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -10), e(user, "PLAY", 10)]), "LG013", "LEDGER_DUPLICATE_ACCOUNT");
  // Malformed entries.
  const malformed = [
    "{}", '"x"', "null", "[1, 2]", '["a", "b"]',
    JSON.stringify([{ accountId: String(user), asset: "PLAY", amount: -10 }, { accountId: String(escrow), asset: "PLAY", amount: 10 }]),
    JSON.stringify([{ accountId: Number(user), asset: "PLAY", amount: "-10" }, { accountId: Number(escrow), asset: "PLAY", amount: "10" }]),
    JSON.stringify([{ ...ok[0], extra: 1 }, ok[1]]),
    JSON.stringify([{ accountId: String(user), amount: "-10" }, ok[1]]),
    JSON.stringify([e(user, "PLAY", "-10.0"), e(escrow, "PLAY", "10.0")]),
    JSON.stringify([e(user, "PLAY", "-1e1"), e(escrow, "PLAY", "1e1")]),
    JSON.stringify([e(user, "PLAY", " -10"), e(escrow, "PLAY", "10")]),
    JSON.stringify([e(user, "PLAY", "+10"), e(escrow, "PLAY", "-10")]),
    JSON.stringify([e("0", "PLAY", "-10"), e(escrow, "PLAY", "10")]),
    JSON.stringify([e("-3", "PLAY", "-10"), e(escrow, "PLAY", "10")]),
  ];
  for (const entries of malformed) await refused(rawPost(c, key(), "BUY_IN", {}, entries), "LG002", "LEDGER_MALFORMED_ENTRY");
  await refused(rawPost(c, key(), "BUY_IN", {}, JSON.stringify([e("99999999999999999999", "PLAY", "-10"), e(escrow, "PLAY", "10")])), "LG002");
  await refused(rawPost(c, key(), "BUY_IN", {}, JSON.stringify([e("9999999999999999999", "PLAY", "-10"), e(escrow, "PLAY", "10")])), "LG004", "LEDGER_AMOUNT_OVERFLOW");
  // Request.
  await refused(rawPost(c, "", "BUY_IN", {}, ok), "LG001", "LEDGER_BAD_REQUEST");
  await refused(rawPost(c, "bad key", "BUY_IN", {}, ok), "LG001", "LEDGER_BAD_REQUEST");
  await refused(rawPost(c, null, "BUY_IN", {}, ok), "LG001", "LEDGER_BAD_REQUEST");
  await refused(rawPost(c, key(), "MINT", {}, ok), "LG001", "LEDGER_BAD_REQUEST");
  await refused(rawPost(c, key(), "BUY_IN", "[]", ok), "LG001", "LEDGER_BAD_REQUEST");
  await refused(rawPost(c, key(), "BUY_IN", { blob: "x".repeat(5000) }, ok), "LG001", "LEDGER_BAD_REQUEST");
  await refused(rawPost(c, key(), "BUY_IN", {}, ok, ""), "LG001", "LEDGER_BAD_REQUEST");
  // Shapes: balanced and well-formed, but not a flow the type allows.
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(issuance, "PLAY", -10), e(escrow, "PLAY", 10)]), "LG018", "LEDGER_BAD_SHAPE");
  await refused(rawPost(c, key(), "BUY_IN", {}, [e(user, "PLAY", -10), e(user2, "PLAY", 10)]), "LG018", "LEDGER_BAD_SHAPE");
  await refused(rawPost(c, key(), "CASH_OUT", {}, ok), "LG018", "LEDGER_BAD_SHAPE");
  await refused(rawPost(c, key(), "PLAY_GRANT", {}, [e(escrow, "PLAY", -10), e(user, "PLAY", 10)]), "LG018", "LEDGER_BAD_SHAPE");
  await refused(rawPost(c, key(), "RAKE", {}, [e(escrow, "PLAY", -10), e(user, "PLAY", 10)]), "LG018", "LEDGER_BAD_SHAPE");
  // An adjustment is never the runtime's to post (and the back office needs a ticket, an author and another approver).
  await refused(rawPost(c, key(), "ADJUSTMENT", { reason: "x" }, [e(issuance, "PLAY", -10), e(user, "PLAY", 10)], "staff:1"), "LG022", "LEDGER_TYPE_FORBIDDEN");
  const office = { reason: "x", ticket: "OPS-7", approvedBy: "staff:2" };
  await refused(rawPostVia(backoffice, "ledger_post_backoffice", key(), "ADJUSTMENT", office, [e(issuance, "PLAY", -10), e(user, "PLAY", 10)]),
    "LG022", "LEDGER_TYPE_FORBIDDEN");
  await refused(rawPostVia(backoffice, "ledger_post_backoffice", key(), "ADJUSTMENT", { ...office, reason: " " }, [e(issuance, "PLAY", -10), e(user, "PLAY", 10)], "staff:1"),
    "LG018", "LEDGER_BAD_SHAPE");
  await refused(rawPostVia(backoffice, "ledger_post_backoffice", key(), "ADJUSTMENT", office, [e(issuance, "PLAY", -10), e(escrow, "PLAY", 10)], "staff:1"),
    "LG018", "LEDGER_BAD_SHAPE");
  // A valid one goes through; nothing above changed any balance.
  assert.equal(await balanceOf(user), 1000n);
  assert.equal(await balanceOf(escrow), 0n);
  await rawPost(c, key(), "BUY_IN", { tableId }, ok);
  assert.equal(await balanceOf(user), 990n);
  assert.equal(await balanceOf(escrow), 10n);
});

test("the database refuses an asset mismatch, a disabled asset and a balance overflow", async () => {
  const userId = await makeUser();
  const tableId = await makeTable();
  const db = sqlDb(runtime);
  const playUser = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId });
  const playEscrow = await ensureAccount(db, { asset: "PLAY", type: "TABLE_ESCROW", tableId });
  await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'ETH'`);
  let ethUser;
  try {
    ethUser = await ensureAccount(db, { asset: "ETH", type: "USER_AVAILABLE", userId });
    // Table accounts hold PLAY only (real-money tables are Phase 2).
    await refused(runtime.query("SELECT public.ledger_ensure_account('ETH', 'TABLE_ESCROW', NULL, $1, NULL)", [tableId]), "LG014", "LEDGER_BAD_ACCOUNT");
    // Entry claims PLAY on an ETH account (balanced per claimed asset).
    await refused(rawPost(runtime, `mismatch:${userId}`, "BUY_IN", {}, [e(playUser, "PLAY", -1), e(ethUser, "PLAY", 1)]), "LG007", "LEDGER_ASSET_MISMATCH");
    // The runtime may not move a non-PLAY asset at all: refused before any account is read.
    await refused(rawPost(runtime, `mismatch2:${userId}`, "BUY_IN", {}, [e(playUser, "ETH", -1), e(ethUser, "ETH", 1)]), "LG022", "LEDGER_TYPE_FORBIDDEN");
    await assert.rejects(post(db, { key: `mismatch3:${userId}`, type: "BUY_IN", reference: {}, entries: [{ accountId: ethUser, asset: "PLAY", amount: -1n }, { accountId: playEscrow, asset: "PLAY", amount: 1n }] }),
      (error) => error instanceof LedgerError && error.code === "INVARIANT" && error.dbCode === "LEDGER_ASSET_MISMATCH");
  } finally {
    await admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'ETH'`);
  }
  // The other way round, TEST_EUR claimed on a PLAY account, through the payments entry point.
  const testUser = await ensureAccount(sqlDb(payments), { asset: "TEST_EUR", type: "USER_AVAILABLE", userId });
  await refused(rawPostVia(payments, "ledger_post_payments", `mismatch4:${userId}`, "DEPOSIT_CREDIT", {}, [e(playUser, "TEST_EUR", -1), e(testUser, "TEST_EUR", 1)]),
    "LG007", "LEDGER_ASSET_MISMATCH");
  await refused(rawPost(runtime, `disabled:${userId}`, "BUY_IN", {}, [e(ethUser, "ETH", -1), e(playEscrow, "ETH", 1)]), "LG009", "LEDGER_ASSET_DISABLED");
  await assert.rejects(post(db, { key: `disabled2:${userId}`, type: "BUY_IN", reference: {}, entries: [{ accountId: ethUser, asset: "ETH", amount: -1n }, { accountId: playEscrow, asset: "ETH", amount: 1n }] }),
    (error) => error instanceof LedgerError && error.code === "ASSET_DISABLED");

  const MAX = 9_223_372_036_854_775_807n;
  const isOverflow = (account) => (error) => error instanceof LedgerError && error.code === "INVARIANT" && error.dbCode === "LEDGER_AMOUNT_OVERFLOW"
    && error.message.includes(`account ${account} balance`);

  // PLAY: every positive PLAY balance is backed by the single PLAY_ISSUANCE
  // account, which is already negative here; minting BIGINT_MAX more would
  // push issuance below BIGINT_MIN, so the database refuses it (and nothing moves).
  await admin.query(`UPDATE public."Asset" SET "maxAmount" = 9223372036854775807 WHERE "code" = 'PLAY'`);
  try {
    await grantPlay(db, { key: `overflow:seed:${userId}`, userId, amount: 1n, reason: "test" });
    const issuance = await ensureAccount(db, { asset: "PLAY", type: "PLAY_ISSUANCE" });
    const issuedBefore = await balanceOf(issuance);
    assert.ok(issuedBefore < 0n);
    const whale = await makeUser();
    await assert.rejects(grantPlay(db, { key: `overflow:play:${whale}`, userId: whale, amount: MAX, reason: "test" }), isOverflow(issuance));
    assert.equal(await balanceOf(issuance), issuedBefore);
    assert.equal(await balanceOf(await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId: whale })), 0n);
  } finally {
    await admin.query(`UPDATE public."Asset" SET "maxAmount" = 1000000000000 WHERE "code" = 'PLAY'`);
  }

  // Real asset: two providers' clearing accounts can each go to -BIGINT_MAX,
  // so a user balance can be pushed past +BIGINT_MAX, and one clearing account
  // past BIGINT_MIN. Both are refused as LEDGER_AMOUNT_OVERFLOW, never wrapped.
  // Deposits are booked by the payments login, each bound to its Deposit row.
  await admin.query(`UPDATE public."Asset" SET "enabled" = true, "maxAmount" = 9223372036854775807 WHERE "code" = 'EUR'`);
  try {
    const whale = await makeUser();
    const minnow = await makeUser();
    const credit = (user, providerKey, amount) => deposit({ userId: user, providerKey, asset: "EUR", amount });
    const whaleDeposit = await credit(whale, "psp-a", MAX);
    const whaleAccount = await ensureAccount(db, { asset: "EUR", type: "USER_AVAILABLE", userId: whale });
    const clearingA = await ensureAccount(db, { asset: "EUR", type: "DEPOSIT_CLEARING", providerKey: "psp-a" });
    assert.equal(await balanceOf(whaleAccount), MAX);
    // User balance above BIGINT_MAX.
    await assert.rejects(credit(whale, "psp-b", 1n), isOverflow(whaleAccount));
    assert.equal(await balanceOf(whaleAccount), MAX);
    // Clearing balance reaches exactly BIGINT_MIN (allowed), then one more unit is refused.
    const minnowDeposit = await credit(minnow, "psp-a", 1n);
    assert.equal(await balanceOf(clearingA), -MAX - 1n);
    await assert.rejects(credit(minnow, "psp-a", 1n), isOverflow(clearingA));
    assert.equal(await balanceOf(clearingA), -MAX - 1n);
    // A refused credit leaves no Deposit row behind (one transaction).
    const { rows: [rows] } = await admin.query(`SELECT count(*)::int AS n FROM public."Deposit" WHERE "userId" = ANY($1)`, [[whale, minnow]]);
    assert.equal(rows.n, 2);
    // Undo, so the accounts end at zero (asset sums stay zero throughout).
    await inPoolTx(payments, (client) => reverseBoundDeposit(client, { ...minnowDeposit, userId: minnow, providerKey: "psp-a", asset: "EUR", amount: 1n, userPortion: 1n }));
    await inPoolTx(payments, (client) => reverseBoundDeposit(client, { ...whaleDeposit, userId: whale, providerKey: "psp-a", asset: "EUR", amount: MAX, userPortion: MAX }));
    assert.equal(await balanceOf(clearingA), 0n);
    assert.equal(await balanceOf(whaleAccount), 0n);
    for (const id of [whaleAccount, clearingA]) assert.equal((await reconstructBalance(db, id)).consistent, true);
  } finally {
    await admin.query(`UPDATE public."Asset" SET "enabled" = false, "maxAmount" = 1000000000 WHERE "code" = 'EUR'`);
  }
});

test("each entry point refuses every type of another role (LG022) before it looks at anything else", async () => {
  const clients = { runtime: [runtime, "ledger_post"], payments: [payments, "ledger_post_payments"], backoffice: [backoffice, "ledger_post_backoffice"] };
  // A valid key and an office-shaped reference; the entries are deliberately invalid: LG022 comes first.
  const reference = { reason: "probe", ticket: "OPS-0", approvedBy: "staff:2" };
  let pairs = 0;
  for (const [point, [pool, fn]] of Object.entries(clients)) {
    for (const [type, owner] of Object.entries(ENTRY_POINT)) {
      if (owner === point) continue;
      await refused(rawPostVia(pool, fn, `lg022:${point}:${type}`, type, reference, "[]", "staff:1"), "LG022", "LEDGER_TYPE_FORBIDDEN");
      pairs++;
    }
  }
  assert.equal(pairs, 2 * 13, "every (entry point, foreign type) pair");
  // The same refusal through the TypeScript client is FORBIDDEN, and a role
  // calling a foreign entry point is refused by the database privilege (42501).
  await assert.rejects(post(sqlDb(runtime),
    { key: "lg022:ts", type: "DEPOSIT_CREDIT", reference: {}, entries: [{ accountId: 1n, asset: "EUR", amount: -1n }, { accountId: 2n, asset: "EUR", amount: 1n }] }),
  (error) => error instanceof LedgerError && error.code === "FORBIDDEN" && error.dbCode === "PERMISSION_DENIED");
  await refused(rawPostVia(payments, "ledger_post", "lg022:acl", "BUY_IN", {}, "[]"), "42501");
  await refused(rawPostVia(runtime, "ledger_post_payments", "lg022:acl2", "DEPOSIT_CREDIT", {}, "[]"), "42501");
});

test("the two new posting types have exactly their shapes: CHARGEBACK_RECOVERY inverts a reversal, WITHDRAWAL_RETURN brings a payout back", async () => {
  await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
  try {
    const userId = await makeUser();
    const db = sqlDb(runtime);
    const credited = await deposit({ userId, providerKey: "psp-shape", asset: "EUR", amount: 10_000n });
    const user = await ensureAccount(db, { asset: "EUR", type: "USER_AVAILABLE", userId });
    const clearing = await ensureAccount(db, { asset: "EUR", type: "DEPOSIT_CLEARING", providerKey: "psp-shape" });
    const losses = await ensureAccount(db, { asset: "EUR", type: "CHARGEBACK_LOSSES" });
    const wdClearing = await ensureAccount(db, { asset: "EUR", type: "WITHDRAWAL_CLEARING", providerKey: "psp-shape" });
    const lossesBefore = await balanceOf(losses);
    // Chargeback of 6000 with only 2000 of it still covered by the user; then the dispute is won.
    const reversal = await inPoolTx(payments, (client) => reverseBoundDeposit(client, {
      ...credited, userId, providerKey: "psp-shape", asset: "EUR", amount: 6000n, userPortion: 2000n,
    }));
    assert.equal(await balanceOf(user), 8000n);
    assert.equal(await balanceOf(losses), lossesBefore - 4000n);
    await inPoolTx(payments, (client) => recoverBoundChargeback(client, {
      recoversReversalId: reversal.reversalId, depositId: credited.depositId, userId, providerKey: "psp-shape", asset: "EUR", amount: 6000n, userPortion: 2000n,
    }));
    assert.equal(await balanceOf(user), 10_000n);
    assert.equal(await balanceOf(losses), lossesBefore);
    const { rows: [dep] } = await admin.query(`SELECT "status"::text AS status, "reversedMinor"::text AS r, "recoveredMinor"::text AS c FROM public."Deposit" WHERE "id" = $1`, [credited.depositId]);
    assert.deepEqual(dep, { status: "CREDITED", r: "6000", c: "6000" });
    // Pay out 3000 (fee 100), then the rail returns the 2900 it carried.
    const held = await inPoolTx(payments, (client) => holdBoundWithdrawal(client, { userId, asset: "EUR", amount: 3000n, fee: 100n, sourceDepositId: credited.depositId }));
    await inPoolTx(payments, (client) => settleBoundWithdrawal(client, { ...held, userId, asset: "EUR", amount: 3000n, fee: 100n, providerKey: "psp-shape" }));
    assert.equal(await balanceOf(user), 7000n);
    assert.equal(await balanceOf(wdClearing), 2900n);
    await inPoolTx(payments, (client) => returnBoundWithdrawal(client, { ...held, userId, asset: "EUR", amount: 2900n, providerKey: "psp-shape" }));
    assert.equal(await balanceOf(user), 9900n);
    assert.equal(await balanceOf(wdClearing), 0n);
    // Shapes the database refuses for the new types (raw, as the payments login).
    let n = 0;
    const raw = (type, entries) => rawPostVia(payments, "ledger_post_payments", `shape:${userId}:${n++}`, type, {}, entries);
    await refused(raw("CHARGEBACK_RECOVERY", [e(clearing, "EUR", 10), e(user, "EUR", -10)]), "LG018", "LEDGER_BAD_SHAPE");
    await refused(raw("CHARGEBACK_RECOVERY", [e(losses, "EUR", -10), e(user, "EUR", 10)]), "LG018", "LEDGER_BAD_SHAPE");
    await refused(raw("WITHDRAWAL_RETURN", [e(wdClearing, "EUR", 10), e(user, "EUR", -10)]), "LG018", "LEDGER_BAD_SHAPE");
    await refused(raw("WITHDRAWAL_RETURN", [e(clearing, "EUR", -10), e(user, "EUR", 10)]), "LG018", "LEDGER_BAD_SHAPE");
    for (const id of [user, clearing, losses, wdClearing]) assert.equal((await reconstructBalance(db, id)).consistent, true);
  } finally {
    await admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`);
  }
});

test("idempotency: same key and payload posts once; a different payload conflicts", async () => {
  const userId = await makeUser();
  const tableId = await makeTable();
  const db = sqlDb(runtime);
  await grantPlay(db, { key: `idem:grant:${userId}`, userId, amount: 100n, reason: "test" });
  const input = { key: `idem:buy:${userId}`, asset: "PLAY", userId, tableId, chips: 80, chipUnit: 1n };
  const first = await buyIn(db, input);
  // Replays return the original id even though the balance (20) no longer covers 80.
  assert.equal(await buyIn(db, input), first);
  assert.equal(await buyIn(db, input), first);
  const user = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId });
  assert.equal(await balanceOf(user), 20n);
  const count = await admin.query(`SELECT count(*)::int AS n FROM public."LedgerTransaction" WHERE "idempotencyKey" = $1`, [input.key]);
  assert.equal(count.rows[0].n, 1);
  for (const changed of [{ ...input, chips: 81 }, { ...input, tableId: await makeTable() }]) {
    await assert.rejects(buyIn(db, changed), (error) => error instanceof LedgerError && error.code === "IDEMPOTENCY_CONFLICT");
  }
  // Same entries, different reference: also a different payload.
  const escrow = await ensureAccount(db, { asset: "PLAY", type: "TABLE_ESCROW", tableId });
  await post(db, { key: `idem:ref:${userId}`, type: "BUY_IN", reference: { a: 1 }, entries: [{ accountId: user, asset: "PLAY", amount: -1n }, { accountId: escrow, asset: "PLAY", amount: 1n }] });
  await assert.rejects(post(db, { key: `idem:ref:${userId}`, type: "BUY_IN", reference: { a: 2 }, entries: [{ accountId: user, asset: "PLAY", amount: -1n }, { accountId: escrow, asset: "PLAY", amount: 1n }] }),
    (error) => error instanceof LedgerError && error.code === "IDEMPOTENCY_CONFLICT");
  // Key order inside the reference is irrelevant (JSONB normalises it).
  await post(db, { key: `idem:order:${userId}`, type: "BUY_IN", reference: { a: 1, b: 2 }, entries: [{ accountId: user, asset: "PLAY", amount: -1n }, { accountId: escrow, asset: "PLAY", amount: 1n }] });
  await post(db, { key: `idem:order:${userId}`, type: "BUY_IN", reference: { b: 2, a: 1 }, entries: [{ accountId: escrow, asset: "PLAY", amount: 1n }, { accountId: user, asset: "PLAY", amount: -1n }] });
  assert.equal(await balanceOf(user), 18n);
});

test("idempotency under concurrency: a second attempt waits for the first and replays or conflicts", async () => {
  const userId = await makeUser();
  const tableId = await makeTable();
  await grantPlay(sqlDb(runtime), { key: `idemc:grant:${userId}`, userId, amount: 100n, reason: "test" });
  const input = { key: `idemc:buy:${userId}`, asset: "PLAY", userId, tableId, chips: 30, chipUnit: 1n };
  await buyIn(sqlDb(runtime), { ...input, key: `idemc:warm:${userId}`, chips: 1 }); // accounts exist
  const a = await runtime.connect();
  const b = await runtime.connect();
  const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    const first = await buyIn(sqlDb(a), input);
    const second = track(buyIn(sqlDb(b), input)); // blocks on the key until A ends
    await waitUntilBlocked(bPid);
    assert.equal(second.settled, false, "B waits while A's posting is uncommitted");
    await a.query("COMMIT");
    assert.equal(await second.promise, first, "B replays A's transaction id");
    await b.query("COMMIT");

    await a.query("BEGIN");
    await b.query("BEGIN");
    const key2 = `idemc:buy2:${userId}`;
    await buyIn(sqlDb(a), { ...input, key: key2 }); // 30 more, committed below
    const conflicting = track(buyIn(sqlDb(b), { ...input, key: key2, chips: 31 }));
    await waitUntilBlocked(bPid);
    assert.equal(conflicting.settled, false);
    await a.query("COMMIT");
    await assert.rejects(conflicting.promise, (error) => error instanceof LedgerError && error.code === "IDEMPOTENCY_CONFLICT");
    await b.query("ROLLBACK");

    // If the first attempt rolls back, the waiting one posts.
    await a.query("BEGIN");
    await b.query("BEGIN");
    const key3 = `idemc:buy3:${userId}`;
    await buyIn(sqlDb(a), { ...input, key: key3, chips: 5 });
    const waiting = track(buyIn(sqlDb(b), { ...input, key: key3, chips: 5 }));
    await waitUntilBlocked(bPid);
    assert.equal(waiting.settled, false);
    await a.query("ROLLBACK");
    const posted = await waiting.promise;
    await b.query("COMMIT");
    const row = await admin.query(`SELECT "id"::text FROM public."LedgerTransaction" WHERE "idempotencyKey" = $1`, [key3]);
    assert.equal(row.rows[0].id, posted);
  } finally {
    a.release();
    b.release();
  }
  const user = await ensureAccount(sqlDb(runtime), { asset: "PLAY", type: "USER_AVAILABLE", userId });
  // grant 100 - warm-up 1 - key1 30 (once, though attempted twice) - key2 30 (A's committed posting) - key3 5 (B's posting).
  assert.equal(await balanceOf(user), 100n - 1n - 30n - 30n - 5n);
  const counts = await admin.query(`SELECT "idempotencyKey" AS k, count(*)::int AS n FROM public."LedgerTransaction" WHERE "idempotencyKey" LIKE $1 GROUP BY 1`, [`idemc:%:${userId}`]);
  assert.deepEqual(Object.fromEntries(counts.rows.map((r) => [r.k, r.n])), {
    [`idemc:grant:${userId}`]: 1, [`idemc:warm:${userId}`]: 1, [`idemc:buy:${userId}`]: 1, [`idemc:buy2:${userId}`]: 1, [`idemc:buy3:${userId}`]: 1,
  });
});

test("many concurrent attempts with one idempotency key have exactly one effect", async (t) => {
  const userId = await makeUser();
  const tableId = await makeTable();
  const db = sqlDb(runtime);
  await grantPlay(db, { key: `idemm:grant:${userId}`, userId, amount: 1000n, reason: "test" });
  await buyIn(db, { key: `idemm:warm:${userId}`, asset: "PLAY", userId, tableId, chips: 1, chipUnit: 1n }); // accounts exist
  const user = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId });
  const escrow = await ensureAccount(db, { asset: "PLAY", type: "TABLE_ESCROW", tableId });
  for (const [round, payloads] of [["same", [40]], ["mixed", [40, 41]]]) {
    const key = `idemm:${round}:${userId}`;
    const before = await balanceOf(user);
    // Hold the user's account row so every racer is inside ledger_post at the
    // same time: the first claims the key and waits for the row, the others
    // wait on the key's unique index. Then release them all at once.
    const racers = Array.from({ length: 16 }, (_, i) => () =>
      inTx((d) => buyIn(d, { key, asset: "PLAY", userId, tableId, chips: payloads[i % payloads.length], chipUnit: 1n })));
    const results = await raceBehindRowLock(t, adminUrl, `SELECT 1 FROM public."LedgerAccount" WHERE "id" = $1 FOR UPDATE`, [user.toString()], racers.length, racers);
    const tx = (await admin.query(`SELECT "id"::text AS id, "reference"->>'chips' AS chips FROM public."LedgerTransaction" WHERE "idempotencyKey" = $1`, [key])).rows;
    assert.equal(tx.length, 1, `${round}: one transaction for the key`);
    const winner = Number(tx[0].chips);
    for (const [i, result] of results.entries()) {
      if (payloads[i % payloads.length] === winner) {
        assert.equal(result.status, "fulfilled", `${round} racer ${i}: ${result.reason?.message ?? ""}`);
        assert.equal(result.value, tx[0].id, `${round} racer ${i} returns the one transaction id`);
      } else {
        assert.ok(result.status === "rejected" && result.reason instanceof LedgerError && result.reason.code === "IDEMPOTENCY_CONFLICT",
          `${round} racer ${i}: ${result.reason?.message ?? result.status}`);
      }
    }
    assert.equal(await balanceOf(user), before - BigInt(winner), `${round}: debited exactly once`);
    const entries = await admin.query(`SELECT count(*)::int AS n FROM public."LedgerEntry" WHERE "transactionId" = $1`, [tx[0].id]);
    assert.equal(entries.rows[0].n, 2);
  }
  for (const id of [user, escrow]) assert.equal((await reconstructBalance(db, id)).consistent, true);
});

test("50 concurrent buy-ins on one balance never overdraw and conserve the total", async () => {
  const userId = await makeUser();
  const tableId = await makeTable(); // escrow account is created concurrently by the buy-ins
  await grantPlay(sqlDb(runtime), { key: `conc:grant:${userId}`, userId, amount: 1000n, reason: "test" });
  const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) =>
    inTx((db) => buyIn(db, { key: `conc:buy:${userId}:${i}`, asset: "PLAY", userId, tableId, chips: 30, chipUnit: 1n }))));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  for (const failure of failures) assert.ok(failure instanceof LedgerError && failure.code === "INSUFFICIENT_FUNDS", String(failure));
  assert.equal(ok, 33, "floor(1000 / 30) buy-ins fit");
  const db = sqlDb(runtime);
  const user = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId });
  const escrow = await ensureAccount(db, { asset: "PLAY", type: "TABLE_ESCROW", tableId });
  assert.equal(await balanceOf(user), 10n);
  assert.equal(await balanceOf(escrow), 990n);
  for (const id of [user, escrow]) assert.equal((await reconstructBalance(db, id)).consistent, true);
});

test("many concurrent crossing transfers complete without deadlock", async () => {
  const users = await Promise.all(Array.from({ length: 4 }, () => makeUser("x")));
  const tables = await Promise.all(Array.from({ length: 3 }, () => makeTable()));
  const db = sqlDb(runtime);
  for (const userId of users) await grantPlay(db, { key: `cross:grant:${userId}`, userId, amount: 20_000n, reason: "test" });
  // Seed every escrow, so cash-outs are possible from the start: users keep
  // 14,000, every escrow holds 8,000.
  for (const tableId of tables) for (const userId of users) {
    await buyIn(db, { key: `cross:seed:${tableId}:${userId}`, asset: "PLAY", userId, tableId, chips: 2000, chipUnit: 1n });
  }
  // 400 transfers in both directions over the same 7 accounts. A buy-in names
  // its accounts (user, escrow), a cash-out (escrow, user): without one global
  // lock order these cross. The workload is sized so that every transfer fits
  // in ANY interleaving (per user, all its buy-ins together stay below 14,000;
  // per table, all its cash-outs below 8,000), so every single one must commit:
  // a deadlock, a retry or any refusal is a failure.
  let seed = 0x5eed1;
  const rand = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const ops = [];
  const buys = new Map(users.map((u) => [u, 0]));
  const outs = new Map(tables.map((t) => [t, 0]));
  const expected = new Map([...users.map((u) => [u, 14_000n]), ...tables.map((t) => [t, 8_000n])]);
  for (let i = 0; i < 400; i++) {
    const userId = users[rand(users.length)];
    const tableId = tables[rand(tables.length)];
    const buy = rand(2) === 1;
    const chips = 1 + rand(200);
    if (buy) buys.set(userId, buys.get(userId) + chips); else outs.set(tableId, outs.get(tableId) + chips);
    const toTable = buy ? BigInt(chips) : -BigInt(chips);
    expected.set(userId, expected.get(userId) - toTable);
    expected.set(tableId, expected.get(tableId) + toTable);
    ops.push(buy
      ? () => inTx((d) => buyIn(d, { key: `cross:buy:${i}:${userId}`, asset: "PLAY", userId, tableId, chips, chipUnit: 1n }))
      : () => inTx((d) => cashOut(d, { key: `cross:out:${i}:${userId}`, asset: "PLAY", userId, tableId, chips, chipUnit: 1n })));
  }
  for (const total of buys.values()) assert.ok(total < 14_000, "workload sizing: buy-ins fit any order");
  for (const total of outs.values()) assert.ok(total < 8_000, "workload sizing: cash-outs fit any order");
  assert.ok([...buys.values()].every((n) => n > 0) && [...outs.values()].every((n) => n > 0), "both directions on every account");
  const results = await Promise.allSettled(ops.map((op) => op()));
  const failures = results.filter((r) => r.status === "rejected").map((r) => `${r.reason?.code ?? ""} ${r.reason?.dbCode ?? ""} ${r.reason?.message ?? r.reason}`);
  assert.deepEqual(failures, [], "every crossing transfer commits");
  const accounts = await admin.query(`SELECT "id"::text, "balance"::text, "userId", "tableId" FROM public."LedgerAccount"
    WHERE "assetCode" = 'PLAY' AND ("userId" = ANY($1) OR "tableId" = ANY($2))`, [users, tables]);
  const total = accounts.rows.reduce((sum, row) => sum + BigInt(row.balance), 0n);
  assert.equal(total, 4n * 20_000n, "chips are only moved between these users and tables");
  // Every transfer applied exactly once: final balances = seed + net flow.
  for (const row of accounts.rows) assert.equal(BigInt(row.balance), expected.get(row.userId ?? row.tableId), `account ${row.id}`);
  for (const row of accounts.rows) assert.equal((await reconstructBalance(db, BigInt(row.id))).consistent, true);
});

test("first postings that create the same new accounts from opposite plan orders do not deadlock", async () => {
  // A buy-in plans (user, escrow) and a cash-out (escrow, user). Creating an
  // account leaves an uncommitted row that a concurrent creator of the same
  // account must wait for, so resolving accounts in plan order lets T1 create
  // the user account, T2 the escrow, and each then wait for the other.
  // The gate below forces exactly that interleaving if it is possible: each
  // transaction pauses after resolving its first account until the other has
  // resolved one too (or 500 ms passed, when the other is already waiting).
  for (let round = 0; round < 3; round++) {
    const userId = await makeUser("d");
    const tableId = await makeTable();
    let arrived = 0;
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const gated = (db) => {
      let first = true;
      return {
        $queryRaw(strings, ...values) {
          const result = db.$queryRaw(strings, ...values);
          if (!first || !strings.join("").includes("ledger_ensure_account")) return result;
          first = false;
          return result.then(async (rows) => {
            if (++arrived === 2) open();
            await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 500))]);
            return rows;
          });
        },
      };
    };
    const input = { asset: "PLAY", userId, tableId, chips: 10, chipUnit: 1n };
    const results = await Promise.allSettled([
      inTx((db) => buyIn(gated(db), { ...input, key: `dl:buy:${round}:${userId}` })),
      inTx((db) => cashOut(gated(db), { ...input, key: `dl:out:${round}:${userId}` })),
    ]);
    // Both accounts are new and empty: each posting is refused for funds,
    // never aborted as a deadlock.
    for (const result of results) {
      assert.ok(result.status === "rejected" && result.reason instanceof LedgerError && result.reason.code === "INSUFFICIENT_FUNDS",
        `round ${round}: ${result.reason?.code ?? ""} ${result.reason?.dbCode ?? ""} ${result.reason?.message ?? result.status}`);
    }
  }
});

test("disabling an asset is an exact stop: no posting validated before the disable commits after it", async () => {
  // Real money moves only through the payments login (the runtime is PLAY only), so the stop is shown on its postings.
  await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
  const holder = await admin.connect();
  try {
    const providerKey = `psp-stop-${Date.now().toString(36)}${(fixtureSeq++).toString(36)}`;
    const db = sqlDb(payments);
    const fees = await ensureAccount(db, { asset: "EUR", type: "PROVIDER_FEES", providerKey });
    await ensureAccount(db, { asset: "EUR", type: "ADJUSTMENTS" });
    const fee = (client, key) => providerFee(sqlDb(client), { key, asset: "EUR", providerKey, amount: 10n, providerReference: key });

    // 1. A disable is in progress (uncommitted) when a posting arrives: the
    //    posting waits for it and is then refused, instead of reading the old
    //    committed "enabled" and committing after the disable.
    await holder.query("BEGIN");
    await holder.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`);
    const client = await payments.connect();
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let attempt;
    try {
      await client.query("BEGIN");
      attempt = track(fee(client, `stop:fee1:${providerKey}`));
      await waitUntilBlocked(pid);
      assert.equal(attempt.settled, false, "the posting waits for the pending disable");
      await holder.query("COMMIT");
      await assert.rejects(attempt.promise, (error) => error instanceof LedgerError && error.code === "ASSET_DISABLED");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal(await balanceOf(fees), 0n);

    // 2. A posting is in flight (uncommitted) when the administrator disables
    //    the asset: the disable waits for it, and every later posting is refused.
    await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
    const inflight = await payments.connect();
    try {
      await inflight.query("BEGIN");
      await fee(inflight, `stop:fee2:${providerKey}`);
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const disable = track(holder.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`));
      await waitUntilBlocked(holderPid);
      assert.equal(disable.settled, false, "the disable waits for the posting in flight");
      await inflight.query("COMMIT");
      await disable.promise;
    } finally {
      inflight.release();
    }
    assert.equal(await balanceOf(fees), 10n, "the posting that was in flight before the disable committed");
    await assert.rejects(fee(payments, `stop:fee3:${providerKey}`), (error) => error instanceof LedgerError && error.code === "ASSET_DISABLED");
    assert.equal(await balanceOf(fees), 10n);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    await admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`);
  }
});

test("after 1,000+ random postings by all three roles every account reconstructs, every asset sums to zero and every payment posting is bound", async () => {
  await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
  try {
    const users = await Promise.all(Array.from({ length: 6 }, () => makeUser("r")));
    const tables = await Promise.all(Array.from({ length: 3 }, () => makeTable()));
    // Two administrators approve each back-office money adjustment (as the payments Worker records it).
    const approvers = await Promise.all(Array.from({ length: 2 }, () => makeUser("adm")));
    await admin.query(`UPDATE public."User" SET "role" = 'ADMIN' WHERE "id" = ANY($1)`, [approvers]);
    let seed = 0x2f6b9d1;
    // The high bits of the LCG state: its low bits repeat with short periods,
    // which would let a few flows (each drawing a fixed number of values) cycle.
    const rand = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return Math.floor((seed / 4294967296) * n); };
    const pick = (list) => list[rand(list.length)];
    const run = `r${Date.now().toString(36)}`;
    // Real money moves with a real provider, sandbox money with the sandbox,
    // never the other way round (the database refuses it). Providers are this
    // run's own, so their clearing accounts can be checked exactly below.
    const realProviders = [`psp-${run}-a`, `psp-${run}-b`];
    const sandboxProviders = [`sandbox-${run}-a`, `sandbox-${run}-b`];
    const providersOf = (asset) => (asset === "TEST_EUR" ? sandboxProviders : realProviders);
    const rail = () => { const asset = pick(["EUR", "TEST_EUR"]); return { asset, providerKey: pick(providersOf(asset)) }; };
    const { rows: [{ seq: seqBefore }] } = await admin.query(`SELECT COALESCE(max("seq"), 0)::text AS seq FROM public."LedgerTransaction"`);
    let posted = 0;
    let postings = 0;
    let refusedFunds = 0;
    let retried = 0;
    let i = 0;

    const sourceDeposit = async (client, userId, asset, providerKey) => {
      const { rows } = await client.query(`SELECT "id"::text AS id FROM public."Deposit" WHERE "userId" = $1 AND "assetCode" = $2 LIMIT 1`, [userId, asset]);
      return rows[0]?.id ?? insertDeposit(client, { userId, providerKey, asset, amount: 1n });
    };
    const lockHeld = (client) => client.query(`SELECT "id"::text AS id, "userId", "assetCode" AS asset, "amountMinor"::text AS amount, "feeMinor"::text AS fee
      FROM public."Withdrawal" WHERE "status" = 'HELD' AND "userId" = ANY($1) LIMIT 1 FOR UPDATE SKIP LOCKED`, [users]).then((r) => r.rows[0]);
    const newHeld = async (client, draw) => {
      const { asset, providerKey } = rail();
      const userId = pick(users);
      const amount = BigInt(2 + (draw % 20_000));
      const fee = BigInt(draw % Number(amount));
      const held = await holdBoundWithdrawal(client, { userId, asset, amount, fee, sourceDepositId: await sourceDeposit(client, userId, asset, providerKey) });
      return { id: held.withdrawalId, userId, asset, amount: amount.toString(), fee: fee.toString() };
    };

    // Each flow draws its random parameters up front and returns the login it
    // runs as and the number of postings it made (in one transaction).
    const runtimeFlow = (perform) => ({ pool: runtime, perform: async (client) => { await perform(sqlDb(client)); return 1; } });
    const flows = [
      (key) => { const input = { key, userId: pick(users), amount: BigInt(1 + rand(5000)), reason: "random" }; return runtimeFlow((db) => grantPlay(db, input)); },
      (key) => { const input = { key, asset: "PLAY", userId: pick(users), tableId: pick(tables), chips: 1 + rand(2000), chipUnit: 1n }; return runtimeFlow((db) => buyIn(db, input)); },
      (key) => { const input = { key, asset: "PLAY", userId: pick(users), tableId: pick(tables), chips: 1 + rand(2000), chipUnit: 1n }; return runtimeFlow((db) => cashOut(db, input)); },
      (key) => { const input = { key, asset: "PLAY", tableId: pick(tables), handUuid: key, chips: 1 + rand(30), chipUnit: 1n }; return runtimeFlow((db) => rake(db, input)); },
      (key) => { const input = { key, asset: "PLAY", userId: pick(users), tableId: pick(tables), chips: 1 + rand(500), chipUnit: 5n }; return runtimeFlow((db) => buyIn(db, input)); },
      (key) => { const input = { key, asset: "PLAY", userId: pick(users), tableId: pick(tables), chips: 1 + rand(500), chipUnit: 5n }; return runtimeFlow((db) => cashOut(db, input)); },
      // Deposit credit.
      () => {
        const input = { ...rail(), userId: pick(users), amount: BigInt(1 + rand(100_000)) };
        return { pool: payments, perform: async (client) => { await creditBoundDeposit(client, input); return 1; } };
      },
      // Reversal of a credited deposit (a fresh one when none is free); the user may no longer cover the portion asked.
      () => {
        const draw = rand(1_000_000);
        const portion = rand(1_000_001);
        const fresh = { ...rail(), userId: pick(users), amount: BigInt(1 + rand(100_000)) };
        return {
          pool: payments,
          perform: async (client) => {
            let count = 0;
            let { rows: [target] } = await client.query(`SELECT "id"::text AS id, "userId", "providerKey", "assetCode" AS asset,
                ("creditedMinor" - ("reversedMinor" - "recoveredMinor"))::text AS remaining
              FROM public."Deposit" WHERE "status" IN ('CREDITED', 'PARTIALLY_REVERSED') AND "userId" = ANY($1) LIMIT 1 FOR UPDATE SKIP LOCKED`, [users]);
            if (!target) {
              const credited = await creditBoundDeposit(client, fresh);
              target = { id: credited.depositId, userId: fresh.userId, providerKey: fresh.providerKey, asset: fresh.asset, remaining: fresh.amount.toString() };
              count++;
            }
            const amount = 1n + BigInt(draw) % BigInt(target.remaining);
            const userPortion = (amount * BigInt(portion)) / 1_000_000n;
            await reverseBoundDeposit(client, {
              depositId: target.id, userId: target.userId, providerKey: target.providerKey, asset: target.asset, amount, userPortion,
              kind: pick(["CHARGEBACK", "PROVIDER_REFUND", "CHAIN_REORG"]),
            });
            return count + 1;
          },
        };
      },
      // A won dispute: recover an unrecovered reversal (lock its deposit first, then re-read).
      () => {
        const draw = rand(1_000_000);
        return {
          pool: payments,
          perform: async (client) => {
            const { rows: [locked] } = await client.query(`SELECT d."id"::text AS id FROM public."Deposit" d
              WHERE d."userId" = ANY($1) AND EXISTS (SELECT 1 FROM public."DepositReversal" r WHERE r."depositId" = d."id" AND r."kind" <> 'CHARGEBACK_RECOVERY'
                AND NOT EXISTS (SELECT 1 FROM public."DepositReversal" x WHERE x."recoversReversalId" = r."id"))
              LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [users]);
            if (!locked) return 0;
            const { rows: [original] } = await client.query(`SELECT r."id"::text AS id, r."userId", r."providerKey", d."assetCode" AS asset,
                r."amountMinor"::text AS amount, r."userPortionMinor"::text AS portion
              FROM public."DepositReversal" r JOIN public."Deposit" d ON d."id" = r."depositId"
              WHERE r."depositId" = $1 AND r."kind" <> 'CHARGEBACK_RECOVERY'
                AND NOT EXISTS (SELECT 1 FROM public."DepositReversal" x WHERE x."recoversReversalId" = r."id") LIMIT 1`, [locked.id]);
            if (!original) return 0;
            const amount = 1n + BigInt(draw) % BigInt(original.amount);
            const userPortion = (BigInt(original.portion) * amount) / BigInt(original.amount);
            await recoverBoundChargeback(client, {
              recoversReversalId: original.id, depositId: locked.id, userId: original.userId, providerKey: original.providerKey, asset: original.asset,
              amount, userPortion,
            });
            return 1;
          },
        };
      },
      // Hold (a refund withdrawal against one of the user's deposits).
      () => {
        const draw = rand(1_000_000);
        return { pool: payments, perform: async (client) => { await newHeld(client, draw); return 1; } };
      },
      // Release a held withdrawal (hold one first when none is free).
      () => {
        const draw = rand(1_000_000);
        const status = pick(["CANCELLED", "REJECTED"]);
        return {
          pool: payments,
          perform: async (client) => {
            const existing = await lockHeld(client);
            const target = existing ?? await newHeld(client, draw);
            await releaseBoundWithdrawal(client, { withdrawalId: target.id, userId: target.userId, asset: target.asset, amount: BigInt(target.amount), status });
            return existing ? 1 : 2;
          },
        };
      },
      // Settle a held withdrawal to the user's card (fee to the provider's fees).
      () => {
        const draw = rand(1_000_000);
        const which = rand(2);
        return {
          pool: payments,
          perform: async (client) => {
            const existing = await lockHeld(client);
            const target = existing ?? await newHeld(client, draw);
            await settleBoundWithdrawal(client, {
              withdrawalId: target.id, userId: target.userId, asset: target.asset, amount: BigInt(target.amount), fee: BigInt(target.fee),
              providerKey: providersOf(target.asset)[which],
            });
            return existing ? 1 : 2;
          },
        };
      },
      // The rail returns (part of) a settled payout.
      () => {
        const draw = rand(1_000_000);
        return {
          pool: payments,
          perform: async (client) => {
            const { rows: [target] } = await client.query(`SELECT "id"::text AS id, "userId", "assetCode" AS asset, "providerKey",
                ("amountMinor" - "feeMinor")::text AS paid
              FROM public."Withdrawal" WHERE "status" = 'SETTLED' AND "userId" = ANY($1) LIMIT 1 FOR UPDATE SKIP LOCKED`, [users]);
            if (!target) return 0;
            await returnBoundWithdrawal(client, {
              withdrawalId: target.id, userId: target.userId, asset: target.asset, providerKey: target.providerKey, amount: 1n + BigInt(draw) % BigInt(target.paid),
            });
            return 1;
          },
        };
      },
      // A provider fee the house absorbs (not bound to a payment row).
      (key) => {
        const input = { key, ...rail(), amount: BigInt(1 + rand(500)), providerReference: key };
        return { pool: payments, perform: async (client) => { await providerFee(sqlDb(client), input); return 1; } };
      },
      // A back-office correction (ticket, author, second approver; for money also two recorded administrator approvals).
      (key) => {
        const input = { key, asset: pick(["EUR", "TEST_EUR", "PLAY"]), userId: pick(users), amount: BigInt(rand(2) ? 1 + rand(1000) : -(1 + rand(1000))), reason: "random correction" };
        return {
          pool: backoffice,
          perform: async (client) => {
            if (input.asset !== "PLAY") await approveAdjustment(approvers, input);
            await adjust(sqlDb(client), input);
            return 1;
          },
        };
      },
    ];
    // These helpers take no per-user lock and some flows post twice in one
    // transaction (a fresh credit, then its reversal), so two concurrent flows
    // can lock shared house accounts in opposite orders across postings; the
    // database then aborts one with a deadlock (or a serialization failure),
    // which moneyTx retries in production. The test retries the same way, a
    // bounded number of times; every other error fails it (docs/money/LEDGER.md).
    const RETRYABLE = new Set(["40P01", "40001"]);
    const retryable = (error) => (error instanceof LedgerError && error.code === "RETRY") || RETRYABLE.has(error?.code);
    const step = async () => {
      const key = `${run}:${i++}`;
      const flow = pick(flows)(key);
      for (let attempt = 1; ; attempt++) {
        try {
          const made = await inPoolTx(flow.pool, flow.perform);
          if (made > 0) { posted++; postings += made; }
          return;
        } catch (error) {
          // Only a refusal for funds is an expected outcome of a random flow.
          if (error instanceof LedgerError && error.code === "INSUFFICIENT_FUNDS") { refusedFunds++; return; }
          if (retryable(error) && attempt < 5) { retried++; continue; }
          throw error;
        }
      }
    };
    while (posted < 1000) await Promise.all(Array.from({ length: 8 }, step));
    assert.ok(posted >= 1000);
    assert.ok(refusedFunds > 0, "some random postings were correctly refused for insufficient funds");
    assert.ok(retried < 50, `deadlock retries stay rare (${retried})`);
    const postedTx = await admin.query(`SELECT "type"::text AS type, count(*)::int AS n FROM public."LedgerTransaction" WHERE "seq" > $1::bigint GROUP BY 1`, [seqBefore]);
    const byType = Object.fromEntries(postedTx.rows.map((row) => [row.type, row.n]));
    assert.equal(Object.values(byType).reduce((a, b) => a + b, 0), postings, "exactly one ledger transaction per posting of a committed flow");
    for (const type of Object.keys(ENTRY_POINT)) assert.ok(byType[type] > 0, `${type} was posted (${JSON.stringify(byType)})`);

    // Every payment posting of the run is bound to exactly its payment row (what the deferred trigger enforced at each commit).
    const { rows: [unbound] } = await admin.query(`
      SELECT count(*) FILTER (WHERE t."type" = 'DEPOSIT_CREDIT' AND NOT EXISTS (SELECT 1 FROM public."Deposit" d WHERE d."ledgerCreditTxId" = t."id"))::int AS credits,
             count(*) FILTER (WHERE t."type" IN ('DEPOSIT_REVERSAL', 'CHARGEBACK_RECOVERY')
               AND NOT EXISTS (SELECT 1 FROM public."DepositReversal" r WHERE r."ledgerTxId" = t."id"))::int AS reversals,
             count(*) FILTER (WHERE t."type" = 'WITHDRAWAL_HOLD' AND NOT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."holdTxId" = t."id"))::int AS holds,
             count(*) FILTER (WHERE t."type" = 'WITHDRAWAL_RELEASE' AND NOT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."releaseTxId" = t."id"))::int AS releases,
             count(*) FILTER (WHERE t."type" = 'WITHDRAWAL_SETTLE' AND NOT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."settleTxId" = t."id"))::int AS settles,
             count(*) FILTER (WHERE t."type" = 'WITHDRAWAL_RETURN' AND NOT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."returnTxId" = t."id"))::int AS returns
        FROM public."LedgerTransaction" t WHERE t."seq" > $1::bigint`, [seqBefore]);
    assert.deepEqual(unbound, { credits: 0, reversals: 0, holds: 0, releases: 0, settles: 0, returns: 0 });
    // Each user's hold account holds exactly their open (HELD) withdrawals, per asset.
    const { rows: holdMismatch } = await admin.query(`
      WITH h AS (SELECT "userId", "assetCode", "balance" FROM public."LedgerAccount" WHERE "type" = 'USER_WITHDRAWAL_HOLD' AND "userId" = ANY($1)),
           o AS (SELECT "userId", "assetCode", sum("amountMinor") AS open FROM public."Withdrawal"
                  WHERE "status" IN ('HELD', 'UNDER_REVIEW', 'APPROVED', 'SUBMITTED') AND "userId" = ANY($1) GROUP BY 1, 2)
      SELECT COALESCE(h."userId", o."userId") AS "userId" FROM h FULL JOIN o ON o."userId" = h."userId" AND o."assetCode" = h."assetCode"
       WHERE COALESCE(h."balance", 0) <> COALESCE(o.open, 0)`, [users]);
    assert.deepEqual(holdMismatch, []);
    // Each provider's deposit clearing is minus its net credited deposits; sandbox accounts hold only TEST_EUR, real ones never.
    const { rows: clearing } = await admin.query(`
      SELECT a."providerKey", a."assetCode", a."balance"::text AS balance,
             (-(SELECT COALESCE(sum(d."creditedMinor" - (d."reversedMinor" - d."recoveredMinor")), 0) FROM public."Deposit" d
                 WHERE d."providerKey" = a."providerKey" AND d."assetCode" = a."assetCode" AND d."ledgerCreditTxId" IS NOT NULL))::text AS expected
        FROM public."LedgerAccount" a WHERE a."type" = 'DEPOSIT_CLEARING' AND a."providerKey" = ANY($1)`, [[...realProviders, ...sandboxProviders]]);
    assert.ok(clearing.length >= 2);
    for (const row of clearing) {
      assert.equal(row.balance, row.expected, `${row.providerKey} ${row.assetCode} clearing`);
      assert.equal(row.assetCode, row.providerKey.startsWith("sandbox-") ? "TEST_EUR" : "EUR", row.providerKey);
    }

    const db = sqlDb(runtime);
    const accounts = (await admin.query(`SELECT "id"::text FROM public."LedgerAccount"`)).rows;
    for (const { id } of accounts) {
      const check = await reconstructBalance(db, BigInt(id));
      assert.equal(check.consistent, true, `account ${id}: ${JSON.stringify(check, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    }
    const sums = await admin.query(`SELECT "assetCode", SUM("balance")::text AS total FROM public."LedgerAccount" GROUP BY "assetCode"`);
    for (const row of sums.rows) assert.equal(row.total, "0", `asset ${row.assetCode} sums to zero`);
    const unbalanced = await admin.query(`SELECT "transactionId" FROM public."LedgerEntry" GROUP BY "transactionId", "assetCode" HAVING SUM("amount") <> 0`);
    assert.equal(unbalanced.rowCount, 0);
    const negatives = await admin.query(`SELECT "id" FROM public."LedgerAccount" WHERE "balance" < 0 AND NOT "allowNegative"`);
    assert.equal(negatives.rowCount, 0);
    const playOnlyRules = await admin.query(`SELECT "id" FROM public."LedgerAccount" WHERE "assetCode" = 'PLAY'
      AND "type" IN ('USER_WITHDRAWAL_HOLD', 'DEPOSIT_CLEARING', 'WITHDRAWAL_CLEARING', 'PROVIDER_FEES', 'ADJUSTMENTS', 'CHARGEBACK_LOSSES')`);
    assert.equal(playOnlyRules.rowCount, 0, "PLAY never touches a redeemable account");
  } finally {
    await admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`);
  }
});

test("a tampered cached balance is detected by reconstructBalance", async () => {
  const userId = await makeUser();
  const db = sqlDb(runtime);
  await grantPlay(db, { key: `tamper:${userId}`, userId, amount: 70n, reason: "test" });
  const account = await ensureAccount(db, { asset: "PLAY", type: "USER_AVAILABLE", userId });
  assert.equal((await reconstructBalance(db, account)).consistent, true);
  await admin.query(`UPDATE public."LedgerAccount" SET "balance" = 1000000 WHERE "id" = $1`, [account.toString()]);
  const check = await reconstructBalance(db, account);
  assert.equal(check.consistent, false);
  assert.equal(check.journalBalance, 70n);
  assert.equal(check.cachedBalance, 1_000_000n);
  await admin.query(`UPDATE public."LedgerAccount" SET "balance" = 70 WHERE "id" = $1`, [account.toString()]);
});

test("the runtime role cannot change User.role or User.kind but can update other columns", async () => {
  const userId = await makeUser();
  await refused(runtime.query(`UPDATE public."User" SET "role" = 'ADMIN' WHERE "id" = $1`, [userId]), "LG020", "USER_PRIVILEGE_CHANGE_FORBIDDEN");
  await refused(runtime.query(`UPDATE public."User" SET "kind" = 'BOT' WHERE "id" = $1`, [userId]), "LG020", "USER_PRIVILEGE_CHANGE_FORBIDDEN");
  await refused(runtime.query(`UPDATE public."User" SET "lastSeenAt" = now(), "role" = 'ADMIN' WHERE "id" = $1`, [userId]), "LG020");
  await refused(runtime.query(`INSERT INTO public."User" ("id", "username", "updatedAt") VALUES ($1, $1, now())
    ON CONFLICT ("id") DO UPDATE SET "role" = 'ADMIN'`, [userId]), "LG020");
  const updated = await runtime.query(`UPDATE public."User" SET "lastSeenAt" = now(), "role" = "role" WHERE "id" = $1`, [userId]);
  assert.equal(updated.rowCount, 1, "unchanged role/kind and other columns are allowed");
  const { rows } = await admin.query(`SELECT "role"::text, "kind"::text FROM public."User" WHERE "id" = $1`, [userId]);
  assert.deepEqual(rows[0], { role: "PLAYER", kind: "HUMAN" });
  // Administrators still can.
  await admin.query(`UPDATE public."User" SET "role" = 'ADMIN' WHERE "id" = $1`, [userId]);
  await admin.query(`UPDATE public."User" SET "role" = 'PLAYER' WHERE "id" = $1`, [userId]);
});

test("the runtime role cannot record a hand without the audit trail; an audited hand is accepted", async () => {
  const tableId = await makeTable();
  const hex = (c) => c.repeat(64);
  await refused(runtime.query(`INSERT INTO public."Hand" ("id", "tableId", "handNumber", "dealerSeat", "board") VALUES ($1, $2, 1, 0, '{}')`,
    [`h-${tableId}-1`, tableId]), "LG021", "HAND_AUDIT_REQUIRED");
  const audited = await runtime.query(`INSERT INTO public."Hand" ("id", "tableId", "handNumber", "dealerSeat", "board",
      "handUuid", "deckCommitment", "finalStateHash", "auditRecord", "auditSealed")
    VALUES ($1, $2, 2, 0, '{}', gen_random_uuid(), $3, $4, '{"v":1}'::jsonb, 'sealed')`, [`h-${tableId}-2`, tableId, hex("a"), hex("b")]);
  assert.equal(audited.rowCount, 1);
  // Legacy-shaped rows remain possible only for administrators (restores).
  await admin.query(`INSERT INTO public."Hand" ("id", "tableId", "handNumber", "dealerSeat", "board") VALUES ($1, $2, 3, 0, '{}')`, [`h-${tableId}-3`, tableId]);
});
