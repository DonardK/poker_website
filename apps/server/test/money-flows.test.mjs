/**
 * Unit tests for the posting plans and the ledger client (src/money/flows.ts,
 * src/money/ledger.ts). No database: the client is exercised against a fake
 * $queryRaw that records what would be sent.
 * Run: node test/support/run-tests.mjs --import tsx test/money-flows.test.mjs (from apps/server)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AmountError } from "../src/money/amounts.ts";
import {
  assertBalanced, expectedEscrowMinor, planAdjustment, planBuyIn, planCashOut, planCreditDeposit, planGrantPlay,
  planHoldWithdrawal, planProviderFee, planRake, planReleaseWithdrawal, planReverseDeposit, planSettleWithdrawal, sumByAsset,
} from "../src/money/flows.ts";
import { LEDGER_SQLSTATES, LedgerError, accountSortKey, ensureAccounts, execute, post, toLedgerError } from "../src/money/ledger.ts";

const shape = (plan) => plan.legs.map((leg) => `${leg.account.type}${leg.amount > 0n ? "+" : "-"}`).sort().join(",");

const flows = {
  grantPlay: () => planGrantPlay({ key: "play-grant:registration:u1", userId: "u1", amount: 10_000n, reason: "registration" }),
  buyIn: () => planBuyIn({ key: "buy-in:t1:c1", asset: "PLAY", userId: "u1", tableId: "t1", chips: 400, chipUnit: 1n }),
  buyInEur: () => planBuyIn({ key: "buy-in:t2:c1", asset: "EUR", userId: "u1", tableId: "t2", chips: 400, chipUnit: 5n }),
  cashOut: () => planCashOut({ key: "cash-out:t1:u1:c2", asset: "PLAY", userId: "u1", tableId: "t1", chips: 523, chipUnit: 1n }),
  rake: () => planRake({ key: "rake:h1", asset: "EUR", tableId: "t2", handUuid: "h1", chips: 3, chipUnit: 5n }),
  creditDeposit: () => planCreditDeposit({ key: "deposit:psp:p1", asset: "EUR", userId: "u1", providerKey: "psp", amount: 5000n, providerReference: "p1" }),
  reverseDepositFull: () => planReverseDeposit({ key: "chargeback:psp:p1", asset: "EUR", userId: "u1", providerKey: "psp", amount: 5000n, userPortion: 5000n, providerReference: "p1" }),
  reverseDepositPartial: () => planReverseDeposit({ key: "chargeback:psp:p2", asset: "EUR", userId: "u1", providerKey: "psp", amount: 5000n, userPortion: 1200n, providerReference: "p2" }),
  reverseDepositLoss: () => planReverseDeposit({ key: "chargeback:psp:p3", asset: "EUR", userId: "u1", providerKey: "psp", amount: 5000n, userPortion: 0n, providerReference: "p3" }),
  holdWithdrawal: () => planHoldWithdrawal({ key: "withdrawal-hold:w1", asset: "BTC", userId: "u1", withdrawalId: "w1", amount: 150_000n }),
  releaseWithdrawal: () => planReleaseWithdrawal({ key: "withdrawal-release:w1", asset: "BTC", userId: "u1", withdrawalId: "w1", amount: 150_000n, reason: "rejected" }),
  settleWithdrawal: () => planSettleWithdrawal({ key: "withdrawal-settle:w1", asset: "BTC", userId: "u1", withdrawalId: "w1", providerKey: "node-1", amount: 150_000n, fee: 2_000n, providerReference: "txid" }),
  settleWithdrawalNoFee: () => planSettleWithdrawal({ key: "withdrawal-settle:w2", asset: "BTC", userId: "u1", withdrawalId: "w2", providerKey: "node-1", amount: 150_000n, fee: 0n, providerReference: "txid2" }),
  providerFee: () => planProviderFee({ key: "fee:psp:f1", asset: "EUR", providerKey: "psp", amount: 35n, providerReference: "f1" }),
  adjustmentCredit: () => planAdjustment({ key: "adjust:a1", asset: "EUR", userId: "u1", amount: 250n, reason: "goodwill", createdBy: "staff:s1" }),
  adjustmentDebit: () => planAdjustment({ key: "adjust:a2", asset: "EUR", userId: "u1", amount: -250n, reason: "correction", createdBy: "staff:s1" }),
  adjustmentPlay: () => planAdjustment({ key: "adjust:a3", asset: "PLAY", userId: "u1", amount: -100n, reason: "abuse", createdBy: "staff:s1" }),
};

// Must match the shapes ledger_post accepts (migration 20261002200000_ledger_foundation).
const expectedShapes = {
  grantPlay: ["PLAY_GRANT", "PLAY_ISSUANCE-,USER_AVAILABLE+"],
  buyIn: ["BUY_IN", "TABLE_ESCROW+,USER_AVAILABLE-"],
  buyInEur: ["BUY_IN", "TABLE_ESCROW+,USER_AVAILABLE-"],
  cashOut: ["CASH_OUT", "TABLE_ESCROW-,USER_AVAILABLE+"],
  rake: ["RAKE", "RAKE_REVENUE+,TABLE_ESCROW-"],
  creditDeposit: ["DEPOSIT_CREDIT", "DEPOSIT_CLEARING-,USER_AVAILABLE+"],
  reverseDepositFull: ["DEPOSIT_REVERSAL", "DEPOSIT_CLEARING+,USER_AVAILABLE-"],
  reverseDepositPartial: ["DEPOSIT_REVERSAL", "CHARGEBACK_LOSSES-,DEPOSIT_CLEARING+,USER_AVAILABLE-"],
  reverseDepositLoss: ["DEPOSIT_REVERSAL", "CHARGEBACK_LOSSES-,DEPOSIT_CLEARING+"],
  holdWithdrawal: ["WITHDRAWAL_HOLD", "USER_AVAILABLE-,USER_WITHDRAWAL_HOLD+"],
  releaseWithdrawal: ["WITHDRAWAL_RELEASE", "USER_AVAILABLE+,USER_WITHDRAWAL_HOLD-"],
  settleWithdrawal: ["WITHDRAWAL_SETTLE", "PROVIDER_FEES+,USER_WITHDRAWAL_HOLD-,WITHDRAWAL_CLEARING+"],
  settleWithdrawalNoFee: ["WITHDRAWAL_SETTLE", "USER_WITHDRAWAL_HOLD-,WITHDRAWAL_CLEARING+"],
  providerFee: ["PROVIDER_FEE", "ADJUSTMENTS-,PROVIDER_FEES+"],
  adjustmentCredit: ["ADJUSTMENT", "ADJUSTMENTS-,USER_AVAILABLE+"],
  adjustmentDebit: ["ADJUSTMENT", "ADJUSTMENTS+,USER_AVAILABLE-"],
  adjustmentPlay: ["ADJUSTMENT", "PLAY_ISSUANCE+,USER_AVAILABLE-"],
};

test("every flow's entries sum to zero per asset, are non-zero and single-asset", () => {
  for (const [name, build] of Object.entries(flows)) {
    const plan = build();
    assert.ok(plan.legs.length >= 2, name);
    for (const leg of plan.legs) {
      assert.equal(typeof leg.amount, "bigint", name);
      assert.notEqual(leg.amount, 0n, name);
    }
    const sums = sumByAsset(plan.legs);
    assert.equal(sums.size, 1, `${name}: no flow mixes assets`);
    for (const sum of sums.values()) assert.equal(sum, 0n, name);
    assert.equal(new Set(plan.legs.map((leg) => JSON.stringify(leg.account))).size, plan.legs.length, `${name}: each account once`);
    assert.doesNotThrow(() => JSON.stringify(plan.reference), `${name}: reference is JSON (no bigint)`);
  }
});

test("every flow has the transaction type and shape the database accepts", () => {
  for (const [name, build] of Object.entries(flows)) {
    const plan = build();
    const [type, expected] = expectedShapes[name];
    assert.equal(plan.type, type, name);
    assert.equal(shape(plan), expected, name);
  }
});

test("flows compute amounts exactly from chips x chipUnit", () => {
  const legs = flows.buyInEur().legs;
  assert.deepEqual(legs.map((leg) => leg.amount), [-2000n, 2000n]);
  assert.equal(flows.rake().legs[1].amount, 15n);
  const settle = flows.settleWithdrawal();
  assert.deepEqual(settle.legs.map((leg) => [leg.account.type, leg.amount]), [
    ["USER_WITHDRAWAL_HOLD", -150_000n], ["WITHDRAWAL_CLEARING", 148_000n], ["PROVIDER_FEES", 2_000n],
  ]);
  const partial = flows.reverseDepositPartial();
  assert.deepEqual(partial.legs.map((leg) => [leg.account.type, leg.amount]), [
    ["DEPOSIT_CLEARING", 5000n], ["USER_AVAILABLE", -1200n], ["CHARGEBACK_LOSSES", -3800n],
  ]);
});

test("PLAY chips have no deposit, withdrawal, fee or chargeback flow", () => {
  const common = { userId: "u1", providerKey: "psp", amount: 1n, providerReference: "x", withdrawalId: "w", reason: "r", fee: 0n, userPortion: 1n };
  assert.throws(() => planCreditDeposit({ ...common, key: "k1", asset: "PLAY" }), AmountError);
  assert.throws(() => planReverseDeposit({ ...common, key: "k2", asset: "PLAY" }), AmountError);
  assert.throws(() => planHoldWithdrawal({ ...common, key: "k3", asset: "PLAY" }), AmountError);
  assert.throws(() => planReleaseWithdrawal({ ...common, key: "k4", asset: "PLAY" }), AmountError);
  assert.throws(() => planSettleWithdrawal({ ...common, key: "k5", asset: "PLAY", amount: 2n }), AmountError);
  assert.throws(() => planProviderFee({ ...common, key: "k6", asset: "PLAY" }), AmountError);
});

test("flows refuse invalid amounts, keys and owners", () => {
  const base = { key: "buy-in:t1:c1", asset: "PLAY", userId: "u1", tableId: "t1", chips: 400, chipUnit: 1n };
  assert.throws(() => planBuyIn({ ...base, chips: 0 }), AmountError);
  assert.throws(() => planBuyIn({ ...base, chips: -5 }), AmountError);
  assert.throws(() => planBuyIn({ ...base, chips: 1.5 }), AmountError);
  assert.throws(() => planBuyIn({ ...base, chipUnit: 0n }), AmountError);
  assert.throws(() => planBuyIn({ ...base, key: "" }), AmountError);
  assert.throws(() => planBuyIn({ ...base, key: "has space" }), AmountError);
  assert.throws(() => planBuyIn({ ...base, key: "x".repeat(201) }), AmountError);
  assert.throws(() => planBuyIn({ ...base, userId: "" }), AmountError);
  assert.throws(() => planBuyIn({ ...base, asset: "play" }), AmountError);
  assert.throws(() => planGrantPlay({ key: "g", userId: "u1", amount: 0n, reason: "r" }), AmountError);
  assert.throws(() => planGrantPlay({ key: "g", userId: "u1", amount: 5, reason: "r" }), AmountError);
  assert.throws(() => planGrantPlay({ key: "g", userId: "u1", amount: 9_223_372_036_854_775_808n, reason: "r" }), AmountError);
  assert.throws(() => planAdjustment({ key: "a", asset: "EUR", userId: "u1", amount: 0n, reason: "r", createdBy: "s" }), AmountError);
  assert.throws(() => planAdjustment({ key: "a", asset: "EUR", userId: "u1", amount: 5n, reason: "  ", createdBy: "s" }), AmountError);
  assert.throws(() => planAdjustment({ key: "a", asset: "EUR", userId: "u1", amount: 5n, reason: "r", createdBy: "" }), AmountError);
  assert.throws(() => planAdjustment({ key: "a", asset: "EUR", userId: "u1", amount: -9_223_372_036_854_775_808n, reason: "r", createdBy: "s" }), AmountError);
  const deposit = { key: "r", asset: "EUR", userId: "u1", providerKey: "psp", amount: 100n, providerReference: "p" };
  assert.throws(() => planReverseDeposit({ ...deposit, userPortion: 101n }), AmountError);
  assert.throws(() => planReverseDeposit({ ...deposit, userPortion: -1n }), AmountError);
  assert.throws(() => planCreditDeposit({ ...deposit, providerKey: "Bad Key" }), AmountError);
  const withdrawal = { key: "s", asset: "BTC", userId: "u1", withdrawalId: "w", providerKey: "node", amount: 100n, providerReference: "t" };
  assert.throws(() => planSettleWithdrawal({ ...withdrawal, fee: 100n }), AmountError);
  assert.throws(() => planSettleWithdrawal({ ...withdrawal, fee: -1n }), AmountError);
});

test("assertBalanced refuses unbalanced, single, zero and cross-asset entries", () => {
  const leg = (asset, amount) => ({ asset, amount });
  assert.doesNotThrow(() => assertBalanced([leg("PLAY", -5n), leg("PLAY", 5n)]));
  assert.throws(() => assertBalanced([leg("PLAY", -5n), leg("PLAY", 4n)]), AmountError);
  assert.throws(() => assertBalanced([leg("PLAY", 0n), leg("PLAY", 0n)]), AmountError);
  assert.throws(() => assertBalanced([leg("PLAY", 5n)]), AmountError);
  // Conversion attempt: balanced in total, not per asset.
  assert.throws(() => assertBalanced([leg("PLAY", -5n), leg("EUR", 5n)]), AmountError);
});

test("expectedEscrowMinor implements the table escrow invariant", () => {
  assert.equal(expectedEscrowMinor({ stacks: [100, 250], committed: [20, 20], unpaidCashOuts: [500] }, 1n), 890n);
  assert.equal(expectedEscrowMinor({ stacks: [100], committed: [], unpaidCashOuts: [] }, 10_000n), 1_000_000n);
  assert.equal(expectedEscrowMinor({ stacks: [], committed: [], unpaidCashOuts: [] }, 3n), 0n);
  const big = Number.MAX_SAFE_INTEGER;
  assert.equal(expectedEscrowMinor({ stacks: [big, big], committed: [], unpaidCashOuts: [] }, 1n), 2n * BigInt(big));
  assert.throws(() => expectedEscrowMinor({ stacks: [-1], committed: [], unpaidCashOuts: [] }, 1n), AmountError);
  assert.throws(() => expectedEscrowMinor({ stacks: [], committed: [], unpaidCashOuts: [] }, 0n), AmountError);
});

function fakeDb(responder) {
  const calls = [];
  return {
    calls,
    $queryRaw(strings, ...values) {
      const sql = strings.join("?");
      calls.push({ sql, values });
      return Promise.resolve(responder(sql, values, calls.length));
    },
  };
}

test("post sends amounts and ids as decimal strings, never JSON numbers", async () => {
  const db = fakeDb(() => [{ id: "00000000-0000-4000-8000-000000000001" }]);
  const id = await post(db, {
    key: "k:1", type: "BUY_IN", reference: { tableId: "t1" },
    entries: [{ accountId: 9_007_199_254_740_993n, asset: "PLAY", amount: -9_007_199_254_740_993n }, { accountId: 2n, asset: "PLAY", amount: 9_007_199_254_740_993n }],
  });
  assert.equal(id, "00000000-0000-4000-8000-000000000001");
  const [{ sql, values }] = db.calls;
  assert.match(sql, /public\.ledger_post\(/);
  assert.equal(values[0], "k:1");
  assert.equal(values[1], "BUY_IN");
  assert.equal(values[2], '{"tableId":"t1"}');
  assert.equal(values[3], '[{"accountId":"9007199254740993","asset":"PLAY","amount":"-9007199254740993"},{"accountId":"2","asset":"PLAY","amount":"9007199254740993"}]');
  assert.equal(values[4], null);
});

test("post refuses an unbalanced request before it reaches the database", async () => {
  const db = fakeDb(() => [{ id: "x" }]);
  await assert.rejects(post(db, { key: "k", type: "BUY_IN", reference: {}, entries: [{ accountId: 1n, asset: "PLAY", amount: -5n }, { accountId: 2n, asset: "PLAY", amount: 4n }] }),
    (error) => error instanceof LedgerError && error.code === "INVARIANT");
  await assert.rejects(post(db, { key: "bad key", type: "BUY_IN", reference: {}, entries: [] }), AmountError);
  assert.equal(db.calls.length, 0);
});

test("execute resolves each account in the global account order then posts the plan", async () => {
  const db = fakeDb((sql, values, n) => (sql.includes("ledger_ensure_account") ? [{ id: String(n * 10) }] : [{ id: "tx-1" }]));
  const id = await execute(db, flows.buyIn());
  assert.equal(id, "tx-1");
  assert.equal(db.calls.length, 3);
  // accountSortKey order (TABLE_ESCROW < USER_AVAILABLE), not the plan's leg order.
  assert.deepEqual(db.calls[0].values, ["PLAY", "TABLE_ESCROW", null, "t1", null]);
  assert.deepEqual(db.calls[1].values, ["PLAY", "USER_AVAILABLE", "u1", null, null]);
  // Each leg keeps its own account id.
  assert.deepEqual(JSON.parse(db.calls[2].values[3]), [
    { accountId: "20", asset: "PLAY", amount: "-400" }, { accountId: "10", asset: "PLAY", amount: "400" },
  ]);
});

test("every plan resolves shared accounts in the same order (no account-creation deadlock)", async () => {
  // A buy-in plans [user, escrow], a cash-out [escrow, user]: resolving in plan
  // order would let two first postings each create one account and then wait
  // for the other's uncommitted insert.
  const order = async (plan) => {
    const db = fakeDb((sql, values, n) => (sql.includes("ledger_ensure_account") ? [{ id: String(n) }] : [{ id: "tx" }]));
    await execute(db, plan);
    return db.calls.filter((call) => call.sql.includes("ledger_ensure_account")).map((call) => call.values.join("|"));
  };
  assert.deepEqual(await order(flows.buyIn()), await order(flows.cashOut()));
  assert.deepEqual(await order(flows.holdWithdrawal()), await order(flows.releaseWithdrawal()));
  for (const make of Object.values(flows)) {
    const plan = make();
    const resolved = await order(plan);
    assert.deepEqual(resolved, [...resolved].sort((a, b) => {
      const key = (s) => { const [asset, type, user, table, provider] = s.split("|"); return accountSortKey({ asset, type, userId: user || null, tableId: table || null, providerKey: provider || null }); };
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    }), plan.key);
    assert.equal(new Set(resolved).size, resolved.length, `${plan.key}: each account resolved once`);
  }
});

test("ensureAccounts dedupes, resolves in global order and returns ids in input order", async () => {
  const db = fakeDb((sql, values) => [{ id: values[1] === "USER_AVAILABLE" ? "7" : "3" }]);
  const ids = await ensureAccounts(db, [
    { asset: "PLAY", type: "USER_AVAILABLE", userId: "u1" },
    { asset: "PLAY", type: "TABLE_ESCROW", tableId: "t1" },
    { asset: "PLAY", type: "USER_AVAILABLE", userId: "u1" },
  ]);
  assert.deepEqual(ids, [7n, 3n, 7n]);
  assert.deepEqual(db.calls.map((call) => call.values[1]), ["TABLE_ESCROW", "USER_AVAILABLE"]);
});

test("database refusals map to LedgerError codes; other errors propagate", async () => {
  const prismaError = (code, message) => Object.assign(new Error(`Invalid \`prisma.$queryRaw()\` invocation:\n\nRaw query failed. Code: \`${code}\`. Message: \`${message}\``), {
    code: "P2010", meta: { code, message },
  });
  const cases = [
    ["LG011", "LEDGER_INSUFFICIENT_FUNDS: account 5", "INSUFFICIENT_FUNDS"],
    ["LG012", "LEDGER_IDEMPOTENCY_CONFLICT: key already used with a different payload", "IDEMPOTENCY_CONFLICT"],
    ["LG009", "LEDGER_ASSET_DISABLED: asset EUR is disabled", "ASSET_DISABLED"],
    ["40001", "LEDGER_RETRY: concurrent posting", "RETRY"],
    ["LG008", "LEDGER_UNBALANCED: entries must sum to zero for each asset", "INVARIANT"],
    ["LG018", "LEDGER_BAD_SHAPE: BUY_IN does not allow entries", "INVARIANT"],
  ];
  for (const [code, message, expected] of cases) {
    const mapped = toLedgerError(prismaError(code, message));
    assert.ok(mapped instanceof LedgerError, message);
    assert.equal(mapped.code, expected);
    assert.equal(mapped.dbCode, message.split(":")[0]);
  }
  assert.equal(toLedgerError(new Error("Can't reach database server at 127.0.0.1:1")), null);
  assert.equal(toLedgerError(null), null);

  // Every refusal the SQL can raise (one SQLSTATE per LEDGER_* prefix), both
  // as Prisma P2010 (meta.code) and as node-postgres (code) report it.
  const migration = readFileSync(new URL("../prisma/migrations/20261002200000_ledger_foundation/migration.sql", import.meta.url), "utf8");
  const raised = new Map();
  for (const match of migration.matchAll(/ERRCODE = '([0-9A-Z]{5})',\s*MESSAGE = (?:format\()?'(LEDGER_[A-Z_]+):/g)) {
    assert.ok(!raised.has(match[2]) || raised.get(match[2]) === match[1], `${match[2]} has one SQLSTATE`);
    raised.set(match[2], match[1]);
  }
  assert.ok(raised.size >= 19, `found ${raised.size} refusals in the migration`);
  const special = { LEDGER_INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS", LEDGER_IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT", LEDGER_ASSET_DISABLED: "ASSET_DISABLED", LEDGER_RETRY: "RETRY" };
  for (const [dbCode, sqlstate] of raised) {
    if (sqlstate !== "40001") assert.equal(LEDGER_SQLSTATES[sqlstate], dbCode, `${sqlstate} is mapped to ${dbCode}`);
    const message = `${dbCode}: detail`;
    for (const error of [prismaError(sqlstate, message), Object.assign(new Error(message), { code: sqlstate })]) {
      const mapped = toLedgerError(error);
      assert.ok(mapped instanceof LedgerError, dbCode);
      assert.equal(mapped.dbCode, dbCode);
      assert.equal(mapped.code, special[dbCode] ?? "INVARIANT", dbCode);
    }
  }
  // Postgres' own retry conditions inside a ledger call: roll back and retry.
  for (const [sqlstate, message, dbCode] of [["40P01", "deadlock detected", "DEADLOCK_DETECTED"], ["40001", "could not serialize access due to concurrent update", "SERIALIZATION_FAILURE"]]) {
    for (const error of [prismaError(sqlstate, message), Object.assign(new Error(message), { code: sqlstate })]) {
      const mapped = toLedgerError(error);
      assert.ok(mapped instanceof LedgerError, message);
      assert.deepEqual([mapped.code, mapped.dbCode], ["RETRY", dbCode]);
    }
  }
  // The SQLSTATE wins over text: a non-ledger error that merely mentions a
  // prefix, or an unrelated SQLSTATE, is not a refusal.
  assert.equal(toLedgerError(Object.assign(new Error("value LEDGER_INSUFFICIENT_FUNDS too long"), { code: "22001" })), null);
  assert.equal(toLedgerError(Object.assign(new Error("relation does not exist"), { code: "42P01" })), null);
  assert.equal(toLedgerError(new Error("LEDGER_SOMETHING_ELSE: unknown")), null);
  assert.equal(toLedgerError(prismaError("LG020", "USER_PRIVILEGE_CHANGE_FORBIDDEN: no")), null);

  const failing = fakeDb(() => { throw prismaError("LG011", "LEDGER_INSUFFICIENT_FUNDS: account 7"); });
  await assert.rejects(post(failing, { key: "k", type: "BUY_IN", reference: {}, entries: [{ accountId: 1n, asset: "PLAY", amount: -5n }, { accountId: 2n, asset: "PLAY", amount: 5n }] }),
    (error) => error instanceof LedgerError && error.code === "INSUFFICIENT_FUNDS");
  const outage = new Error("Can't reach database server");
  const down = fakeDb(() => { throw outage; });
  await assert.rejects(post(down, { key: "k", type: "BUY_IN", reference: {}, entries: [{ accountId: 1n, asset: "PLAY", amount: -5n }, { accountId: 2n, asset: "PLAY", amount: 5n }] }),
    (error) => error === outage);
});
