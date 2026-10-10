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
 * The runtime role (poker_server) is used exactly as production uses it; the
 * superuser only creates fixtures and inspects privileges.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertLoopbackUrl, migrationNames, migrationsDir, startTestDatabase, withDatabase } from "../support/pg.mjs";
import { raceBehindRowLock } from "./support.mjs";
import {
  LedgerError, adjustment, buyIn, cashOut, creditDeposit, ensureAccount, getBalances, grantPlay, holdWithdrawal, post,
  providerFee, rake, reconstructBalance, releaseWithdrawal, reverseDeposit, settleWithdrawal,
} from "../../src/money/ledger.ts";

const MIGRATION = "20261002200000_ledger_foundation";
let cluster = null;
let adminUrl;
let runtimeUrl;
let admin;
let runtime;

before(async () => {
  if (process.env.POKER_TEST_ADMIN_DATABASE_URL && process.env.POKER_TEST_DATABASE_URL) {
    adminUrl = process.env.POKER_TEST_ADMIN_DATABASE_URL;
    runtimeUrl = process.env.POKER_TEST_DATABASE_URL;
  } else {
    cluster = await startTestDatabase({ log: (line) => console.error(line) });
    ({ adminUrl, runtimeUrl } = cluster);
  }
  assertLoopbackUrl(adminUrl, "admin URL");
  assertLoopbackUrl(runtimeUrl, "runtime URL");
  admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  runtime = new pg.Pool({ connectionString: runtimeUrl, max: 70 });
});

after(async () => {
  await runtime?.end();
  await admin?.end();
  await cluster?.stop();
});

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

test("functions are SECURITY DEFINER with a pinned search_path and only poker_server may execute them", async () => {
  const { rows } = await admin.query(`
    SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('ledger_post', 'ledger_ensure_account') ORDER BY p.proname`);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.prosecdef, true, row.proname);
    assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public, pg_temp"], row.proname);
  }
  if ((await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'ledger_outsider'`)).rowCount === 0) {
    await admin.query(`CREATE ROLE ledger_outsider NOLOGIN`);
  }
  const priv = await admin.query(`SELECT
      has_function_privilege('poker_server', 'public.ledger_post(text, text, jsonb, jsonb, text)', 'EXECUTE') AS rt_post,
      has_function_privilege('poker_server', 'public.ledger_ensure_account(text, text, text, text, text)', 'EXECUTE') AS rt_ensure,
      has_function_privilege('ledger_outsider', 'public.ledger_post(text, text, jsonb, jsonb, text)', 'EXECUTE') AS other_post,
      has_function_privilege('ledger_outsider', 'public.ledger_ensure_account(text, text, text, text, text)', 'EXECUTE') AS other_ensure`);
  assert.deepEqual(priv.rows[0], { rt_post: true, rt_ensure: true, other_post: false, other_ensure: false });
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
  await refused(rawPost(c, key(), "ADJUSTMENT", { reason: "x" }, [e(issuance, "PLAY", -10), e(user, "PLAY", 10)]), "LG018", "LEDGER_BAD_SHAPE");
  await refused(rawPost(c, key(), "ADJUSTMENT", { reason: " " }, [e(issuance, "PLAY", -10), e(user, "PLAY", 10)], "staff:1"), "LG018", "LEDGER_BAD_SHAPE");
  await refused(rawPost(c, key(), "RAKE", {}, [e(escrow, "PLAY", -10), e(user, "PLAY", 10)]), "LG018", "LEDGER_BAD_SHAPE");
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
  await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'ETH'`);
  let ethUser;
  let ethEscrow;
  try {
    ethUser = await ensureAccount(db, { asset: "ETH", type: "USER_AVAILABLE", userId });
    ethEscrow = await ensureAccount(db, { asset: "ETH", type: "TABLE_ESCROW", tableId });
    // Entry claims PLAY on an ETH account (balanced per claimed asset), and
    // the other way round: ETH on a PLAY account.
    await refused(rawPost(runtime, `mismatch:${userId}`, "BUY_IN", {}, [e(playUser, "PLAY", -1), e(ethEscrow, "PLAY", 1)]), "LG007", "LEDGER_ASSET_MISMATCH");
    await refused(rawPost(runtime, `mismatch2:${userId}`, "BUY_IN", {}, [e(playUser, "ETH", -1), e(ethEscrow, "ETH", 1)]), "LG007", "LEDGER_ASSET_MISMATCH");
    await assert.rejects(post(db, { key: `mismatch3:${userId}`, type: "BUY_IN", reference: {}, entries: [{ accountId: ethUser, asset: "PLAY", amount: -1n }, { accountId: ethEscrow, asset: "PLAY", amount: 1n }] }),
      (error) => error instanceof LedgerError && error.code === "INVARIANT" && error.dbCode === "LEDGER_ASSET_MISMATCH");
  } finally {
    await admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'ETH'`);
  }
  await refused(rawPost(runtime, `disabled:${userId}`, "BUY_IN", {}, [e(ethUser, "ETH", -1), e(ethEscrow, "ETH", 1)]), "LG009", "LEDGER_ASSET_DISABLED");
  await assert.rejects(post(db, { key: `disabled2:${userId}`, type: "BUY_IN", reference: {}, entries: [{ accountId: ethUser, asset: "ETH", amount: -1n }, { accountId: ethEscrow, asset: "ETH", amount: 1n }] }),
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
  await admin.query(`UPDATE public."Asset" SET "enabled" = true, "maxAmount" = 9223372036854775807 WHERE "code" = 'ETH'`);
  try {
    const whale = await makeUser();
    const minnow = await makeUser();
    const deposit = (key, user, providerKey, amount) => creditDeposit(db, { key, asset: "ETH", userId: user, providerKey, amount, providerReference: key });
    await deposit(`overflow:eth:1:${whale}`, whale, "psp-a", MAX);
    const whaleAccount = await ensureAccount(db, { asset: "ETH", type: "USER_AVAILABLE", userId: whale });
    const clearingA = await ensureAccount(db, { asset: "ETH", type: "DEPOSIT_CLEARING", providerKey: "psp-a" });
    assert.equal(await balanceOf(whaleAccount), MAX);
    // User balance above BIGINT_MAX.
    await assert.rejects(deposit(`overflow:eth:2:${whale}`, whale, "psp-b", 1n), isOverflow(whaleAccount));
    assert.equal(await balanceOf(whaleAccount), MAX);
    // Clearing balance reaches exactly BIGINT_MIN (allowed), then one more unit is refused.
    await deposit(`overflow:eth:3:${minnow}`, minnow, "psp-a", 1n);
    assert.equal(await balanceOf(clearingA), -MAX - 1n);
    await assert.rejects(deposit(`overflow:eth:4:${minnow}`, minnow, "psp-a", 1n), isOverflow(clearingA));
    assert.equal(await balanceOf(clearingA), -MAX - 1n);
    // Undo, so the accounts end at zero (asset sums stay zero throughout).
    await reverseDeposit(db, { key: `overflow:eth:undo1:${minnow}`, asset: "ETH", userId: minnow, providerKey: "psp-a", amount: 1n, userPortion: 1n, providerReference: "undo1" });
    await reverseDeposit(db, { key: `overflow:eth:undo2:${whale}`, asset: "ETH", userId: whale, providerKey: "psp-a", amount: MAX, userPortion: MAX, providerReference: "undo2" });
    assert.equal(await balanceOf(clearingA), 0n);
    assert.equal(await balanceOf(whaleAccount), 0n);
    for (const id of [whaleAccount, clearingA]) assert.equal((await reconstructBalance(db, id)).consistent, true);
  } finally {
    await admin.query(`UPDATE public."Asset" SET "enabled" = false, "maxAmount" = 10000000000000 WHERE "code" = 'ETH'`);
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
  await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
  const holder = await admin.connect();
  try {
    const userId = await makeUser();
    const tableId = await makeTable();
    const db = sqlDb(runtime);
    await creditDeposit(db, { key: `stop:dep:${userId}`, asset: "EUR", userId, providerKey: "psp-stop", amount: 1000n, providerReference: "stop" });
    const user = await ensureAccount(db, { asset: "EUR", type: "USER_AVAILABLE", userId });
    await ensureAccount(db, { asset: "EUR", type: "TABLE_ESCROW", tableId });
    const input = { asset: "EUR", userId, tableId, chips: 10, chipUnit: 1n };

    // 1. A disable is in progress (uncommitted) when a posting arrives: the
    //    posting waits for it and is then refused, instead of reading the old
    //    committed "enabled" and committing after the disable.
    await holder.query("BEGIN");
    await holder.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`);
    const client = await runtime.connect();
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let attempt;
    try {
      await client.query("BEGIN");
      attempt = track(buyIn(sqlDb(client), { ...input, key: `stop:buy1:${userId}` }));
      await waitUntilBlocked(pid);
      assert.equal(attempt.settled, false, "the posting waits for the pending disable");
      await holder.query("COMMIT");
      await assert.rejects(attempt.promise, (error) => error instanceof LedgerError && error.code === "ASSET_DISABLED");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal(await balanceOf(user), 1000n);

    // 2. A posting is in flight (uncommitted) when the administrator disables
    //    the asset: the disable waits for it, and every later posting is refused.
    await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
    const inflight = await runtime.connect();
    try {
      await inflight.query("BEGIN");
      await buyIn(sqlDb(inflight), { ...input, key: `stop:buy2:${userId}` });
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const disable = track(holder.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`));
      await waitUntilBlocked(holderPid);
      assert.equal(disable.settled, false, "the disable waits for the posting in flight");
      await inflight.query("COMMIT");
      await disable.promise;
    } finally {
      inflight.release();
    }
    assert.equal(await balanceOf(user), 990n, "the posting that was in flight before the disable committed");
    await assert.rejects(buyIn(db, { ...input, key: `stop:buy3:${userId}` }), (error) => error instanceof LedgerError && error.code === "ASSET_DISABLED");
    assert.equal(await balanceOf(user), 990n);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    await admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`);
  }
});

test("after 1,000+ random postings every account reconstructs from the journal and every asset sums to zero", async () => {
  await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" IN ('EUR', 'BTC')`);
  try {
    const users = await Promise.all(Array.from({ length: 6 }, () => makeUser("r")));
    const tables = await Promise.all(Array.from({ length: 3 }, () => makeTable()));
    let seed = 0x2f6b9d1;
    const rand = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
    const pick = (list) => list[rand(list.length)];
    const run = `r${Date.now().toString(36)}`;
    let posted = 0;
    let refusedFunds = 0;
    let i = 0;
    const real = () => pick(["EUR", "BTC"]);
    const psp = () => pick(["psp-a", "psp-b"]);
    // Each flow builds its whole input (random parameters drawn up front, so
    // the sequence is reproducible) and returns a function of the db.
    const flows = [
      (key) => { const input = { key, userId: pick(users), amount: BigInt(1 + rand(5000)), reason: "random" }; return (db) => grantPlay(db, input); },
      (key) => { const input = { key, asset: "PLAY", userId: pick(users), tableId: pick(tables), chips: 1 + rand(2000), chipUnit: 1n }; return (db) => buyIn(db, input); },
      (key) => { const input = { key, asset: "PLAY", userId: pick(users), tableId: pick(tables), chips: 1 + rand(2000), chipUnit: 1n }; return (db) => cashOut(db, input); },
      (key) => { const input = { key, asset: "PLAY", tableId: pick(tables), handUuid: key, chips: 1 + rand(30), chipUnit: 1n }; return (db) => rake(db, input); },
      (key) => { const input = { key, asset: "EUR", userId: pick(users), tableId: pick(tables), chips: 1 + rand(500), chipUnit: 5n }; return (db) => buyIn(db, input); },
      (key) => { const input = { key, asset: "EUR", userId: pick(users), tableId: pick(tables), chips: 1 + rand(500), chipUnit: 5n }; return (db) => cashOut(db, input); },
      (key) => { const input = { key, asset: "EUR", tableId: pick(tables), handUuid: key, chips: 1 + rand(10), chipUnit: 5n }; return (db) => rake(db, input); },
      (key) => { const input = { key, asset: real(), userId: pick(users), providerKey: psp(), amount: BigInt(1 + rand(100000)), providerReference: key }; return (db) => creditDeposit(db, input); },
      (key) => {
        const amount = BigInt(1 + rand(5000));
        const input = { key, asset: real(), userId: pick(users), providerKey: psp(), amount, userPortion: BigInt(rand(Number(amount) + 1)), providerReference: key };
        return (db) => reverseDeposit(db, input);
      },
      (key) => { const input = { key, asset: real(), userId: pick(users), withdrawalId: key, amount: BigInt(1 + rand(20000)) }; return (db) => holdWithdrawal(db, input); },
      (key) => { const input = { key, asset: real(), userId: pick(users), withdrawalId: key, amount: BigInt(1 + rand(5000)), reason: "cancelled" }; return (db) => releaseWithdrawal(db, input); },
      (key) => {
        const amount = BigInt(2 + rand(20000));
        const input = { key, asset: real(), userId: pick(users), withdrawalId: key, providerKey: psp(), amount, fee: BigInt(rand(Number(amount))), providerReference: key };
        return (db) => settleWithdrawal(db, input);
      },
      (key) => { const input = { key, asset: real(), providerKey: psp(), amount: BigInt(1 + rand(500)), providerReference: key }; return (db) => providerFee(db, input); },
      (key) => {
        const input = { key, asset: pick(["EUR", "BTC", "PLAY"]), userId: pick(users), amount: BigInt(rand(2) ? 1 + rand(1000) : -(1 + rand(1000))), reason: "random correction", createdBy: "staff:test" };
        return (db) => adjustment(db, input);
      },
    ];
    const step = async () => {
      const key = `${run}:${i++}`;
      const perform = pick(flows)(key);
      try {
        await inTx((db) => perform(db));
        posted++;
      } catch (error) {
        // Only a refusal for funds is an expected outcome of a random flow;
        // anything else (deadlock, invariant, shape) fails the test.
        if (error instanceof LedgerError && error.code === "INSUFFICIENT_FUNDS") refusedFunds++;
        else throw error;
      }
    };
    while (posted < 1000) await Promise.all(Array.from({ length: 8 }, step));
    assert.ok(posted >= 1000);
    assert.ok(refusedFunds > 0, "some random postings were correctly refused for insufficient funds");
    const postedTx = await admin.query(`SELECT count(*)::int AS n FROM public."LedgerTransaction" WHERE "idempotencyKey" LIKE $1`, [`${run}:%`]);
    assert.equal(postedTx.rows[0].n, posted, "exactly one transaction per successful posting");

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
    await admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" IN ('EUR', 'BTC')`);
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
