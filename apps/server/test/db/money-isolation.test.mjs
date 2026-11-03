/**
 * Who may move which money (migration 20261019120000_payments_wallet), on the
 * disposable embedded cluster of test/support/pg.mjs; never `.env`.
 * Regression tests for the wallet review (docs/money/LEDGER.md section 10):
 * - the game API's login (poker_app, inheriting poker_server; assumed
 *   compromisable) cannot move sandbox (TEST_EUR) or real (EUR) money with its
 *   table types (BUY_IN, CASH_OUT, RAKE), even once EUR is enabled;
 * - the back-office login cannot write review actions (which count towards
 *   four-eyes rules), and cannot post a money adjustment without two
 *   administrators' recorded approvals of exactly that adjustment;
 * - a deposit under review is credited at most what the provider reported
 *   (a card at most what was asked), and that amount cannot be rewritten;
 * - a card a deposit saves cools off for 24 hours, like a payout address;
 * - the step-up single-use trigger judges expiry in UTC whatever the session
 *   time zone of the login that consumes the grant.
 *
 * Run: npm run test:db -w @poker/server (or node test/db/run-all.mjs money-isolation inside pg.mjs)
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { connect, createSession, createTable, createUser, requireTestDatabase, tag } from "./support.mjs";
import { creditBoundDeposit, ensureCard, holdBoundWithdrawal, sqlDb } from "./wallet-fixtures.mjs";
import { adjustment, ensureAccount, LedgerError, post } from "../../src/money/ledger.ts";

const { adminUrl, runtimeUrl, paymentsUrl, backofficeUrl } = requireTestDatabase();

async function balanceOf(admin, asset, type, userId) {
  const { rows } = await admin.query(`SELECT "balance"::text AS b FROM public."LedgerAccount" WHERE "assetCode" = $1 AND "type" = $2 AND "userId" = $3`, [asset, type, userId]);
  return rows[0] ? BigInt(rows[0].b) : 0n;
}

async function makeAdmin(admin, name) {
  const id = await createUser(admin, name, 0);
  await admin.query(`UPDATE public."User" SET "role" = 'ADMIN' WHERE "id" = $1`, [id]);
  return id;
}

/** A raw pg query refused with exactly this SQLSTATE. */
async function rejectsWith(promise, sqlstate) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, sqlstate, `expected SQLSTATE ${sqlstate}, got ${error.code}: ${error.message}`);
    return true;
  });
}

const entry = (accountId, asset, amount) => ({ accountId: String(accountId), asset, amount: String(amount) });
const rawPost = (client, key, type, entries) => client.query("SELECT public.ledger_post($1, $2, '{}'::jsonb, $3::jsonb, NULL)", [key, type, JSON.stringify(entries)]);

for (const asset of ["TEST_EUR", "EUR"]) {
  test(`the runtime login cannot move a player's ${asset} with table postings (no escrow, no BUY_IN, no CASH_OUT)`, async (t) => {
    const admin = await connect(t, adminUrl);
    const runtime = await connect(t, runtimeUrl);
    const payments = await connect(t, paymentsUrl);
    if (asset === "EUR") {
      // Going live enables EUR; this cluster is disposable and the flag is restored.
      await admin.query(`UPDATE public."Asset" SET "enabled" = true WHERE "code" = 'EUR'`);
      t.after(() => admin.query(`UPDATE public."Asset" SET "enabled" = false WHERE "code" = 'EUR'`).catch(() => {}));
    }
    const victim = await createUser(admin, `victim_${tag()}`, 0);
    const attacker = await createUser(admin, `attacker_${tag()}`, 0);
    const tableId = await createTable(admin, `t_${tag()}`);
    await payments.query("BEGIN");
    await creditBoundDeposit(payments, { userId: victim, providerKey: asset === "EUR" ? `psp-${tag()}` : "sandbox", asset, amount: 500n });
    await payments.query("COMMIT");
    assert.equal(await balanceOf(admin, asset, "USER_AVAILABLE", victim), 500n);
    assert.equal((await runtime.query("SELECT current_user AS u")).rows[0].u, "poker_app");

    // A table account in a money asset cannot be created by anyone.
    await rejectsWith(runtime.query("SELECT public.ledger_ensure_account($1, 'TABLE_ESCROW', NULL, $2, NULL)", [asset, tableId]), "LG014");
    await rejectsWith(runtime.query("SELECT public.ledger_ensure_account($1, 'RAKE_REVENUE', NULL, NULL, NULL)", [asset]), "LG014");
    // With any two accounts of that asset, the runtime's types are refused before an account is read.
    const db = sqlDb(runtime);
    const victimAccount = await ensureAccount(db, { asset, type: "USER_AVAILABLE", userId: victim });
    const attackerAccount = await ensureAccount(db, { asset, type: "USER_AVAILABLE", userId: attacker });
    for (const type of ["BUY_IN", "CASH_OUT", "RAKE", "PLAY_GRANT"]) {
      await rejectsWith(rawPost(runtime, `steal:${type}:${tag()}`, type, [entry(victimAccount, asset, -500), entry(attackerAccount, asset, 500)]), "LG022");
    }
    await assert.rejects(post(db, { key: `steal:ts:${tag()}`, type: "BUY_IN", reference: {}, entries: [
      { accountId: victimAccount, asset, amount: -500n }, { accountId: attackerAccount, asset, amount: 500n }] }), LedgerError);
    assert.equal(await balanceOf(admin, asset, "USER_AVAILABLE", victim), 500n, "the victim keeps the money");
    assert.equal(await balanceOf(admin, asset, "USER_AVAILABLE", attacker), 0n);
  });
}

test("every way the runtime login could dress up a move of real or sandbox money is refused, and its PLAY postings still work", async (t) => {
  const admin = await connect(t, adminUrl);
  const runtime = await connect(t, runtimeUrl);
  const payments = await connect(t, paymentsUrl);
  const victim = await createUser(admin, `victim_${tag()}`, 0);
  const attacker = await createUser(admin, `attacker_${tag()}`, 0);
  const tableId = await createTable(admin, `t_${tag()}`);
  await payments.query("BEGIN");
  await creditBoundDeposit(payments, { userId: victim, providerKey: "sandbox", asset: "TEST_EUR", amount: 500n });
  await payments.query("COMMIT");
  const account = async (asset, type, userId) => (await runtime.query("SELECT public.ledger_ensure_account($1, $2, $3, NULL, NULL) AS id", [asset, type, userId])).rows[0].id;
  const house = async (type) => (await runtime.query("SELECT public.ledger_ensure_account('PLAY', $1, NULL, NULL, NULL) AS id", [type])).rows[0].id;
  const victimAccount = await account("TEST_EUR", "USER_AVAILABLE", victim);
  const attackerAccount = await account("TEST_EUR", "USER_AVAILABLE", attacker);
  const refusedWith = async (codes, work) => {
    await assert.rejects(work(), (error) => {
      assert.ok(codes.includes(error.code), `expected one of ${codes}, got ${error.code}: ${error.message}`);
      return true;
    });
  };
  // Real accounts declared as PLAY.
  await refusedWith(["LG007", "LG018", "LG022"], () => rawPost(runtime, `a1:${tag()}`, "BUY_IN", [entry(victimAccount, "PLAY", -500), entry(attackerAccount, "PLAY", 500)]));
  // A PLAY pair with a TEST_EUR pair hidden in it.
  const playVictim = await account("PLAY", "USER_AVAILABLE", victim);
  const playAttacker = await account("PLAY", "USER_AVAILABLE", attacker);
  await refusedWith(["LG018", "LG022"], () => rawPost(runtime, `a2:${tag()}`, "BUY_IN", [entry(playVictim, "PLAY", -1), entry(playAttacker, "PLAY", 1), entry(victimAccount, "TEST_EUR", -500), entry(attackerAccount, "TEST_EUR", 500)]));
  // A money escrow row that somehow exists already (nothing can create one now).
  const { rows: [{ id: planted }] } = await admin.query(`INSERT INTO public."LedgerAccount" ("assetCode", "type", "tableId", "allowNegative") VALUES ('TEST_EUR', 'TABLE_ESCROW', $1, false) RETURNING "id"`, [tableId]);
  await refusedWith(["LG022"], () => rawPost(runtime, `a3:${tag()}`, "BUY_IN", [entry(victimAccount, "TEST_EUR", -500), entry(planted, "TEST_EUR", 500)]));
  await refusedWith(["LG022"], () => rawPost(runtime, `a4:${tag()}`, "CASH_OUT", [entry(planted, "TEST_EUR", -500), entry(attackerAccount, "TEST_EUR", 500)]));
  // Other entry points, a role change, direct writes, identities.
  await refusedWith(["42501"], () => runtime.query(`SELECT public.ledger_post_core(ARRAY['BUY_IN'], ARRAY['TEST'], $1, 'BUY_IN', '{}'::jsonb, '[]'::jsonb, 'x')`, [`a5:${tag()}`]));
  await refusedWith(["42501"], () => runtime.query(`SELECT public.ledger_post_payments($1, 'WITHDRAWAL_HOLD', '{}'::jsonb, '[]'::jsonb, 'x')`, [`a6:${tag()}`]));
  await refusedWith(["42501"], () => runtime.query(`SELECT public.ledger_post_backoffice($1, 'ADJUSTMENT', '{}'::jsonb, '[]'::jsonb, 'x')`, [`a7:${tag()}`]));
  await refusedWith(["42501"], () => runtime.query("SET ROLE poker_payments"));
  await refusedWith(["42501"], () => runtime.query(`UPDATE public."LedgerAccount" SET "balance" = 0 WHERE "id" = $1`, [victimAccount]));
  await refusedWith(["42501"], () => runtime.query(`SELECT "legalLastName" FROM public."PlayerCompliance" LIMIT 1`));
  assert.equal(await balanceOf(admin, "TEST_EUR", "USER_AVAILABLE", victim), 500n);
  // The game's own postings are untouched.
  const issuance = await house("PLAY_ISSUANCE");
  const { rows: [{ id: escrow }] } = await runtime.query("SELECT public.ledger_ensure_account('PLAY', 'TABLE_ESCROW', NULL, $1, NULL) AS id", [tableId]);
  const rake = await house("RAKE_REVENUE");
  await rawPost(runtime, `g1:${tag()}`, "PLAY_GRANT", [entry(issuance, "PLAY", -1000), entry(playVictim, "PLAY", 1000)]);
  await rawPost(runtime, `g2:${tag()}`, "BUY_IN", [entry(playVictim, "PLAY", -600), entry(escrow, "PLAY", 600)]);
  await rawPost(runtime, `g3:${tag()}`, "RAKE", [entry(escrow, "PLAY", -10), entry(rake, "PLAY", 10)]);
  await rawPost(runtime, `g4:${tag()}`, "CASH_OUT", [entry(escrow, "PLAY", -590), entry(playAttacker, "PLAY", 590)]);
  assert.equal(await balanceOf(admin, "PLAY", "USER_AVAILABLE", attacker), 590n);
});

test("the back-office login cannot write review actions, so it cannot forge the approvals four-eyes rules count", async (t) => {
  const admin = await connect(t, adminUrl);
  const payments = await connect(t, paymentsUrl);
  const office = await connect(t, backofficeUrl);
  const player = await createUser(admin, `pl_${tag()}`, 0);
  const a1 = await makeAdmin(admin, `ad1_${tag()}`);
  await payments.query("BEGIN");
  const dep = await creditBoundDeposit(payments, { userId: player, providerKey: "sandbox", asset: "TEST_EUR", amount: 5000n });
  const { withdrawalId } = await holdBoundWithdrawal(payments, { userId: player, asset: "TEST_EUR", amount: 4000n, sourceDepositId: dep.depositId });
  const card = await ensureCard(payments, { userId: player, providerKey: "sandbox", asset: "TEST_EUR" });
  await payments.query(`UPDATE public."Withdrawal" SET "status" = 'UNDER_REVIEW', "reviewReasons" = '["REFUND_TO_SOURCE"]', "approvalsRequired" = 2,
    "instrumentId" = $2, "providerKey" = 'sandbox' WHERE "id" = $1`, [withdrawalId, card]);
  await payments.query("COMMIT");

  assert.equal((await office.query("SELECT current_user AS u")).rows[0].u, "poker_backoffice_app");
  await rejectsWith(office.query(`INSERT INTO public."PaymentReviewAction" ("subjectType", "subjectId", "subjectUserId", "actorKind", "actorUserId", "verb", "note")
    VALUES ('WITHDRAWAL', $1, $2, 'ADMIN', $3, 'APPROVE', 'forged')`, [withdrawalId, player, a1]), "42501");
  // Without two real approvals the withdrawal cannot be approved.
  await rejectsWith(payments.query(`UPDATE public."Withdrawal" SET "status" = 'APPROVED', "decidedAt" = now() WHERE "id" = $1`, [withdrawalId]), "PM004");
});

test("a back-office money adjustment needs two administrators' recorded approvals of exactly that adjustment", async (t) => {
  const admin = await connect(t, adminUrl);
  const office = await connect(t, backofficeUrl);
  const player = await createUser(admin, `mint_${tag()}`, 0);
  const [a1, a2, a3] = [await makeAdmin(admin, `ad1_${tag()}`), await makeAdmin(admin, `ad2_${tag()}`), await makeAdmin(admin, `ad3_${tag()}`)];
  const key = `adj:${tag()}`;
  const input = { key, asset: "TEST_EUR", userId: player, amount: 100_000_000n, reason: "x", createdBy: a1, ticket: "T-1", approvedBy: a2 };
  const approve = (actor, overrides = {}) => admin.query(`INSERT INTO public."PaymentReviewAction" ("subjectType", "subjectId", "subjectUserId", "actorKind",
      "actorUserId", "actorStepUpMethod", "verb", "reasonCode", "metadata") VALUES ('USER', $1, $1, 'ADMIN', $2, 'PASSKEY', 'APPROVE', $3, $4::jsonb)`,
  [player, actor, overrides.reasonCode ?? `ADJUSTMENT:${key}`, JSON.stringify({ asset: "TEST_EUR", amountMinor: overrides.amount ?? "100000000" })]);
  const attempt = () => adjustment(sqlDb(office), input);

  // The typed names alone (the old rule) are refused.
  await assert.rejects(attempt(), (error) => error instanceof LedgerError && error.dbCode === "LEDGER_TYPE_FORBIDDEN");
  // One approval, plus a second admin's approval of another amount or of another key: still refused.
  await approve(a1);
  await approve(a3, { amount: "1" });
  await approve(a2, { reasonCode: `ADJUSTMENT:${key}x` });
  // The same administrator cannot approve the same adjustment twice (PM004), so one person never counts twice.
  await rejectsWith(approve(a1), "PM004");
  await assert.rejects(attempt(), (error) => error instanceof LedgerError && error.dbCode === "LEDGER_TYPE_FORBIDDEN");
  assert.equal(await balanceOf(admin, "TEST_EUR", "USER_AVAILABLE", player), 0n);
  // A second administrator approves exactly this adjustment: it posts.
  await approve(a2);
  await attempt();
  assert.equal(await balanceOf(admin, "TEST_EUR", "USER_AVAILABLE", player), 100_000_000n);

  // Play chips keep the ticket and second-approver rule (they are not redeemable).
  await adjustment(sqlDb(office), { key: `adj-play:${tag()}`, asset: "PLAY", userId: player, amount: 50n, reason: "x", createdBy: "staff:a", ticket: "T-2", approvedBy: "staff:b" });
  assert.equal(await balanceOf(admin, "PLAY", "USER_AVAILABLE", player), 50n);
});

test("a deposit under review is credited at most what the provider reported, and a card at most what was asked", async (t) => {
  const admin = await connect(t, adminUrl);
  const payments = await connect(t, paymentsUrl);
  const player = await createUser(admin, `rev_${tag()}`, 0);
  const insert = async (method, reported) => (await payments.query(`INSERT INTO public."Deposit" ("userId", "method", "providerKey", "assetCode", "requestedMinor", "reportedMinor",
      "payAssetCode", "status", "expiresAt", "statusReason")
    VALUES ($1, $2::"PaymentMethodKind", 'sandbox', 'TEST_EUR', 1000, $3, $4, 'NEEDS_REVIEW', now(), 'AMOUNT_MISMATCH') RETURNING "id"::text AS id`,
  [player, method, reported, method === "CRYPTO" ? "BTC" : null])).rows[0].id;
  const credit = (id, minor) => payments.query(`UPDATE public."Deposit" SET "status" = 'CONFIRMED', "creditedMinor" = $2, "confirmedAt" = now() WHERE "id" = $1`, [id, minor]);
  // No amount reported: the request is the ceiling.
  await rejectsWith(credit(await insert("CARD", null), 1_000_000), "PM006");
  await credit(await insert("CARD", null), 1000);
  await credit(await insert("CARD", null), 400);
  // A card is never credited above the request, whatever the provider reported, nor above the report.
  await rejectsWith(credit(await insert("CARD", 5000), 1001), "PM006");
  await credit(await insert("CARD", 5000), 1000);
  await rejectsWith(credit(await insert("CARD", 400), 401), "PM006");
  await credit(await insert("CARD", 400), 400);
  // Crypto: what arrived, even above the request, and never more.
  await credit(await insert("CRYPTO", 1500), 1500);
  await rejectsWith(credit(await insert("CRYPTO", 1500), 1501), "PM006");
  // Fixed while under review: the ceiling cannot be raised before the credit.
  const fixed = await insert("CRYPTO", 1500);
  await rejectsWith(payments.query(`UPDATE public."Deposit" SET "reportedMinor" = 9000 WHERE "id" = $1`, [fixed]), "PM002");
  const none = await insert("CRYPTO", null);
  await rejectsWith(payments.query(`UPDATE public."Deposit" SET "reportedMinor" = 9000 WHERE "id" = $1`, [none]), "PM002");
});

test("a card that can take payouts cools off for 24 hours; one the operator added does not", async (t) => {
  const admin = await connect(t, adminUrl);
  const payments = await connect(t, paymentsUrl);
  const player = await createUser(admin, `cool_${tag()}`, 0);
  const insert = async (origin, payoutEnabled) => (await payments.query(`INSERT INTO public."PaymentInstrument" ("userId", "kind", "origin", "providerKey", "assetCode", "cardToken", "payoutEnabled")
    VALUES ($1, 'CARD_TOKEN', $2::"InstrumentOrigin", 'sandbox', 'TEST_EUR', $3, $4)
    RETURNING "id"::text AS id, EXTRACT(EPOCH FROM ("usableAfter" - (now() AT TIME ZONE 'UTC')))::int AS wait`, [player, origin, `tok_${tag()}`, payoutEnabled])).rows[0];
  const day = 24 * 3600;
  assert.ok((await insert("DEPOSIT", true)).wait >= day - 5, "a saved card cools off even though the application asked for nothing");
  assert.ok((await insert("DEPOSIT", false)).wait < 5, "a deposit-only card has nothing to cool");
  assert.ok((await insert("OPERATOR", true)).wait < 5);
  const later = await insert("DEPOSIT", false);
  const { rows: [row] } = await payments.query(`UPDATE public."PaymentInstrument" SET "payoutEnabled" = true WHERE "id" = $1
    RETURNING EXTRACT(EPOCH FROM ("usableAfter" - (now() AT TIME ZONE 'UTC')))::int AS wait`, [later.id]);
  assert.ok(row.wait >= day - 5, "switched on for payouts later, it cools off from then");
});

test("the step-up single-use trigger judges expiry in UTC whatever the consuming session's time zone", async (t) => {
  const admin = await connect(t, adminUrl);
  const payments = await connect(t, paymentsUrl);
  const user = await createUser(admin, `tz_${tag()}`, 0);
  const session = await createSession(admin, user);
  const utcWall = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const grant = async (expiresInMs) => {
    const id = `g_${tag()}${tag()}`;
    const now = Date.now();
    await admin.query(`INSERT INTO public."StepUpGrant" ("id", "userId", "sessionId", "purpose", "bindHash", "method", "createdAt", "expiresAt")
      VALUES ($1, $2, $3, 'withdrawal', $4, 'TOTP', $5::timestamp, $6::timestamp)`,
    [id, user, session, randomBytes(32).toString("hex"), utcWall(now + expiresInMs - 120_000), utcWall(now + expiresInMs)]);
    return id;
  };
  // consumeGrant's statement (apps/edge/src/payments/stepup.ts); moneyTx pins UTC, this session deliberately does not.
  const consume = (id) => payments.query(`UPDATE public."StepUpGrant" SET "consumedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "consumedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP RETURNING "method"`, [id]);
  await payments.query(`SET timezone = 'America/Los_Angeles'`);
  // West of UTC the WHERE clause matches a grant that expired 30 minutes ago; the trigger still refuses it.
  await rejectsWith(consume(await grant(-30 * 60_000)), "SU001");
  await payments.query("RESET timezone");
  assert.equal((await payments.query("SHOW timezone")).rows[0].TimeZone, "UTC", "the payments login defaults to UTC");
  assert.equal((await consume(await grant(4 * 60_000))).rowCount, 1, "a valid grant is consumed in UTC");
});
