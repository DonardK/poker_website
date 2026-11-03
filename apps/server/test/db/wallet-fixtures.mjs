/**
 * Payment rows for real-database suites that post deposit and withdrawal
 * types (migration 20261019120000_payments_wallet). Every payment-type ledger
 * transaction must be matched, at commit, by exactly one payment row with the
 * same user, provider, asset and amounts (the deferred trigger
 * LedgerTransaction_payment_binding, LG023), so each helper posts through the
 * ledger client (src/money/ledger.ts) AND writes that row in the caller's
 * transaction, exactly as the payments Worker will.
 *
 * Every helper takes a node-postgres client connected as poker_payments_app
 * with a transaction already open (BEGIN ... COMMIT is the caller's). The
 * state machines are the database's: a deposit goes CREATED -> CONFIRMED ->
 * CREDITED; a refund withdrawal REQUESTED -> HELD -> CANCELLED, or
 * HELD -> APPROVED (one SYSTEM approval) -> SUBMITTED (with its PayoutDispatch)
 * -> SETTLED -> RETURNED.
 */
import { randomUUID } from "node:crypto";
import {
  creditDeposit, holdWithdrawal, recoverChargeback, releaseWithdrawal, returnWithdrawal, reverseDeposit, settleWithdrawal,
} from "../../src/money/ledger.ts";

/** The $queryRaw tagged-template interface of a Prisma client, over a pg client. */
export function sqlDb(client) {
  return {
    $queryRaw(strings, ...values) {
      let text = strings[0];
      values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
      return client.query(text, values).then((result) => result.rows);
    },
  };
}

/** The database's sandbox test (asset kind TEST exactly for these provider keys). */
export const isSandboxProvider = (providerKey) => /^sandbox([-_.:]|$)/.test(providerKey);

/** A CREATED card deposit row; returns its id. */
export async function insertDeposit(client, { userId, providerKey, asset, amount }) {
  const { rows: [row] } = await client.query(`INSERT INTO public."Deposit" ("userId", "method", "providerKey", "assetCode", "requestedMinor", "expiresAt")
    VALUES ($1, 'CARD', $2, $3, $4, now() + interval '30 minutes') RETURNING "id"::text AS id`, [userId, providerKey, asset, amount.toString()]);
  return row.id;
}

/** Credit a deposit (a new one unless depositId is given): DEPOSIT_CREDIT plus CONFIRMED -> CREDITED. */
export async function creditBoundDeposit(client, { userId, providerKey, asset, amount, depositId }) {
  const id = depositId ?? await insertDeposit(client, { userId, providerKey, asset, amount });
  const txId = await creditDeposit(sqlDb(client), {
    key: `deposit-credit:${id}`, depositId: id, asset, userId, providerKey, amount, providerReference: id,
  });
  // insertDeposit makes card deposits, and a credited card deposit names its card.
  const card = await ensureCard(client, { userId, providerKey, asset });
  await client.query(`UPDATE public."Deposit" SET "status" = 'CONFIRMED', "creditedMinor" = $2, "confirmedAt" = now(), "instrumentId" = COALESCE("instrumentId", $3::uuid) WHERE "id" = $1`, [id, amount.toString(), card]);
  await client.query(`UPDATE public."Deposit" SET "status" = 'CREDITED', "ledgerCreditTxId" = $2, "creditedAt" = now() WHERE "id" = $1`, [id, txId]);
  return { depositId: id, txId };
}

/**
 * One UPDATE that moves the reversed (or recovered) total and the status the
 * Deposit CHECK derives from it (the totals and the status must change together).
 */
const moveTotals = (column) => `UPDATE public."Deposit" SET "${column}" = "${column}" + $2::bigint,
  "status" = (CASE "reversedMinor" - "recoveredMinor" + (CASE WHEN '${column}' = 'reversedMinor' THEN $2::bigint ELSE -$2::bigint END)
    WHEN 0 THEN 'CREDITED' WHEN "creditedMinor" THEN 'REVERSED' ELSE 'PARTIALLY_REVERSED' END)::"DepositStatus"
  WHERE "id" = $1`;

/** A chargeback / provider refund / reorg of a credited deposit: DEPOSIT_REVERSAL plus its DepositReversal row. */
export async function reverseBoundDeposit(client, { depositId, userId, providerKey, asset, amount, userPortion, kind = "CHARGEBACK" }) {
  const reversalId = randomUUID();
  const txId = await reverseDeposit(sqlDb(client), {
    key: `deposit-reversal:${providerKey}:${kind}:${reversalId}`, depositId, reversalId, kind, asset, userId, providerKey, amount, userPortion,
    providerReference: reversalId,
  });
  await client.query(`INSERT INTO public."DepositReversal" ("id", "depositId", "userId", "providerKey", "kind", "providerReversalId",
      "amountMinor", "userPortionMinor", "lossMinor", "ledgerTxId")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [reversalId, depositId, userId, providerKey, kind, reversalId, amount.toString(), userPortion.toString(), (amount - userPortion).toString(), txId]);
  await client.query(moveTotals("reversedMinor"), [depositId, amount.toString()]);
  return { reversalId, txId };
}

/** A won dispute: CHARGEBACK_RECOVERY plus its recovery DepositReversal row. */
export async function recoverBoundChargeback(client, { recoversReversalId, depositId, userId, providerKey, asset, amount, userPortion }) {
  const reversalId = randomUUID();
  const txId = await recoverChargeback(sqlDb(client), {
    key: `chargeback-recovery:${providerKey}:${reversalId}`, depositId, reversalId, recoversReversalId, asset, userId, providerKey, amount,
    userPortion, providerReference: reversalId,
  });
  await client.query(`INSERT INTO public."DepositReversal" ("id", "depositId", "userId", "providerKey", "kind", "providerReversalId",
      "recoversReversalId", "amountMinor", "userPortionMinor", "lossMinor", "ledgerTxId")
    VALUES ($1, $2, $3, $4, 'CHARGEBACK_RECOVERY', $5, $6, $7, $8, $9, $10)`,
  [reversalId, depositId, userId, providerKey, reversalId, recoversReversalId, amount.toString(), userPortion.toString(), (amount - userPortion).toString(), txId]);
  await client.query(moveTotals("recoveredMinor"), [depositId, amount.toString()]);
  return { reversalId, txId };
}

/**
 * The user's card with this provider (created once), payout-enabled and usable
 * now: OPERATOR origin, because a card a deposit saves cools off for 24 hours
 * and these suites are not about that.
 */
export async function ensureCard(client, { userId, providerKey, asset }) {
  const token = `tok_${userId}`;
  const { rows: [existing] } = await client.query(`SELECT "id"::text AS id FROM public."PaymentInstrument" WHERE "userId" = $1 AND "providerKey" = $2 AND "cardToken" = $3`, [userId, providerKey, token]);
  if (existing) return existing.id;
  const { rows: [row] } = await client.query(`INSERT INTO public."PaymentInstrument" ("userId", "kind", "origin", "providerKey", "assetCode", "cardToken",
      "cardBrand", "cardLast4", "depositEnabled", "payoutEnabled")
    VALUES ($1, 'CARD_TOKEN', 'OPERATOR', $2, $3, $4, 'visa', '4242', true, true) RETURNING "id"::text AS id`, [userId, providerKey, asset, token]);
  return row.id;
}

/**
 * A REFUND withdrawal of `amount` (fee fixed at creation) against one of the
 * user's deposits in `asset`: REQUESTED, then WITHDRAWAL_HOLD and HELD.
 */
export async function holdBoundWithdrawal(client, { userId, asset, amount, fee = 0n, sourceDepositId }) {
  const { rows: [row] } = await client.query(`INSERT INTO public."Withdrawal" ("userId", "kind", "sourceDepositId", "assetCode", "amountMinor", "feeMinor")
    VALUES ($1, 'REFUND', $2, $3, $4, $5) RETURNING "id"::text AS id`, [userId, sourceDepositId, asset, amount.toString(), fee.toString()]);
  const txId = await holdWithdrawal(sqlDb(client), { key: `withdrawal-hold:${row.id}`, asset, userId, withdrawalId: row.id, amount });
  await client.query(`UPDATE public."Withdrawal" SET "status" = 'HELD', "holdTxId" = $2, "heldAt" = now() WHERE "id" = $1`, [row.id, txId]);
  return { withdrawalId: row.id, txId };
}

/** Release a HELD withdrawal: WITHDRAWAL_RELEASE plus HELD -> CANCELLED (or REJECTED). */
export async function releaseBoundWithdrawal(client, { withdrawalId, userId, asset, amount, status = "CANCELLED" }) {
  const txId = await releaseWithdrawal(sqlDb(client), {
    key: `withdrawal-release:${withdrawalId}`, asset, userId, withdrawalId, amount, reason: status.toLowerCase(),
  });
  await client.query(`UPDATE public."Withdrawal" SET "status" = $3::"WithdrawalStatus", "releaseTxId" = $2, "closedAt" = now() WHERE "id" = $1`,
    [withdrawalId, txId, status]);
  return { txId };
}

/**
 * Pay a HELD refund withdrawal to the user's card: one SYSTEM approval, the
 * PayoutDispatch row, SUBMITTED, then WITHDRAWAL_SETTLE (fee to the
 * provider's fee account) and SETTLED.
 */
export async function settleBoundWithdrawal(client, { withdrawalId, userId, asset, amount, fee = 0n, providerKey }) {
  const instrumentId = await ensureCard(client, { userId, providerKey, asset });
  await client.query(`UPDATE public."Withdrawal" SET "instrumentId" = $2, "providerKey" = $3 WHERE "id" = $1`, [withdrawalId, instrumentId, providerKey]);
  await client.query(`INSERT INTO public."PaymentReviewAction" ("subjectType", "subjectId", "subjectUserId", "actorKind", "verb", "reasonCode")
    VALUES ('WITHDRAWAL', $1, $2, 'SYSTEM', 'APPROVE', 'AUTO_APPROVE')`, [withdrawalId, userId]);
  await client.query(`UPDATE public."Withdrawal" SET "status" = 'APPROVED', "decidedAt" = now() WHERE "id" = $1`, [withdrawalId]);
  await client.query(`INSERT INTO public."PayoutDispatch" ("withdrawalId", "userId", "providerKey", "operation", "providerIdempotencyKey")
    VALUES ($1, $2, $3, 'REFUND', $4)`, [withdrawalId, userId, providerKey, `rf_${withdrawalId}`]);
  await client.query(`UPDATE public."Withdrawal" SET "status" = 'SUBMITTED', "submittedAt" = now() WHERE "id" = $1`, [withdrawalId]);
  const txId = await settleWithdrawal(sqlDb(client), {
    key: `withdrawal-settle:${withdrawalId}`, asset, userId, withdrawalId, providerKey, amount, fee, providerReference: withdrawalId,
  });
  await client.query(`UPDATE public."Withdrawal" SET "status" = 'SETTLED', "settleTxId" = $2, "settledAt" = now() WHERE "id" = $1`, [withdrawalId, txId]);
  return { txId, instrumentId };
}

/** The rail sent a SETTLED payout back: WITHDRAWAL_RETURN plus SETTLED -> RETURNED. */
export async function returnBoundWithdrawal(client, { withdrawalId, userId, asset, amount, providerKey }) {
  const txId = await returnWithdrawal(sqlDb(client), {
    key: `withdrawal-return:${withdrawalId}`, asset, userId, withdrawalId, providerKey, amount, providerReference: withdrawalId,
  });
  await client.query(`UPDATE public."Withdrawal" SET "status" = 'RETURNED', "returnTxId" = $2 WHERE "id" = $1`, [withdrawalId, txId]);
  return { txId };
}

/** Runs fn(client) in one READ COMMITTED transaction on its own connection from `pool`. */
export async function inPoolTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
