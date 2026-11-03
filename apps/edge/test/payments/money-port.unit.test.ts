/**
 * The edge ledger port (src/money/*, docs/money/WALLET.md section 8) without a
 * database: every posting type has exactly one entry point and post() calls
 * that function; the new plans balance, drop zero legs and refuse PLAY;
 * idempotency keys are deterministic, bounded and in the database's format.
 */
import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY,
  LEDGER_TRANSACTION_TYPES,
  planRecoverChargeback,
  planReturnWithdrawal,
  sumByAsset,
  type PostingPlan,
} from "../../src/money/flows";
import { ENTRY_POINT, LedgerError, ensureAccounts, execute, getAccountBalance, post } from "../../src/money/ledger";
import { KEY_PART_MAX, PROVIDER_IDEMPOTENCY_KEY, keyPart, ledgerKeys, providerIdempotency } from "../../src/money/keys";

/** A fake $queryRaw that records the SQL text of every call and answers from `reply`. */
function recordingDb(reply: (sql: string, values: unknown[]) => unknown[] = () => [{ id: "00000000-0000-4000-8000-000000000001" }]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  return {
    calls,
    $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
      const sql = strings.join("$?").replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      return Promise.resolve(reply(sql, values) as T);
    },
  };
}

const entries = [
  { accountId: 1n, asset: "EUR", amount: -500n },
  { accountId: 2n, asset: "EUR", amount: 500n },
];

describe("ENTRY_POINT", () => {
  it("names exactly one entry point for every LedgerTransactionType", () => {
    expect(Object.keys(ENTRY_POINT).sort()).toEqual([...LEDGER_TRANSACTION_TYPES].sort());
    expect(LEDGER_TRANSACTION_TYPES).toContain("CHARGEBACK_RECOVERY");
    expect(LEDGER_TRANSACTION_TYPES).toContain("WITHDRAWAL_RETURN");
    const byEntryPoint = (entryPoint: string) => Object.entries(ENTRY_POINT).filter(([, value]) => value === entryPoint).map(([type]) => type).sort();
    expect(byEntryPoint("runtime")).toEqual(["BUY_IN", "CASH_OUT", "PLAY_GRANT", "RAKE"]);
    expect(byEntryPoint("payments")).toEqual([
      "CHARGEBACK_RECOVERY", "DEPOSIT_CREDIT", "DEPOSIT_REVERSAL", "PROVIDER_FEE",
      "WITHDRAWAL_HOLD", "WITHDRAWAL_RELEASE", "WITHDRAWAL_RETURN", "WITHDRAWAL_SETTLE",
    ]);
    expect(byEntryPoint("backoffice")).toEqual(["ADJUSTMENT"]);
  });

  it("post() calls the SQL function of the type's entry point, with amounts and ids as strings", async () => {
    const expected = { runtime: "public.ledger_post(", payments: "public.ledger_post_payments(", backoffice: "public.ledger_post_backoffice(" };
    for (const type of LEDGER_TRANSACTION_TYPES) {
      const db = recordingDb();
      const id = await post(db, { key: `k:${type}`, type, reference: { test: true }, entries });
      expect(id).toBe("00000000-0000-4000-8000-000000000001");
      expect(db.calls).toHaveLength(1);
      const { sql, values } = db.calls[0]!;
      expect(sql).toContain(`SELECT ${expected[ENTRY_POINT[type]]}`);
      for (const other of Object.values(expected).filter((name) => name !== expected[ENTRY_POINT[type]])) expect(sql).not.toContain(` ${other}`);
      expect(values[1]).toBe(type);
      expect(JSON.parse(values[3] as string)).toEqual([
        { accountId: "1", asset: "EUR", amount: "-500" },
        { accountId: "2", asset: "EUR", amount: "500" },
      ]);
    }
  });

  it("post() refuses an unknown type, an unbalanced request and a bad key before calling the database", async () => {
    const db = recordingDb();
    await expect(post(db, { key: "k1", type: "MINT" as never, reference: {}, entries })).rejects.toMatchObject({ code: "INVARIANT", dbCode: "LEDGER_BAD_REQUEST" });
    await expect(post(db, { key: "k1", type: "DEPOSIT_CREDIT", reference: {}, entries: [entries[0]!, { ...entries[1]!, amount: 499n }] }))
      .rejects.toMatchObject({ code: "INVARIANT", dbCode: "LEDGER_UNBALANCED" });
    await expect(post(db, { key: "bad key", type: "DEPOSIT_CREDIT", reference: {}, entries })).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  it("an entry point that returns no id is an invariant, and getAccountBalance reads a bigint", async () => {
    await expect(post(recordingDb(() => []), { key: "k1", type: "BUY_IN", reference: {}, entries })).rejects.toBeInstanceOf(LedgerError);
    const db = recordingDb(() => [{ balance: "-9223372036854775808" }]);
    expect(await getAccountBalance(db, 7n)).toBe(-9_223_372_036_854_775_808n);
    expect(db.calls[0]!.values).toEqual(["7"]);
    await expect(getAccountBalance(recordingDb(() => []), 7n)).rejects.toMatchObject({ dbCode: "LEDGER_UNKNOWN_ACCOUNT" });
  });

  it("ensureAccounts resolves each account once, in one global order, and answers in input order", async () => {
    let next = 10;
    const db = recordingDb(() => [{ id: String(next++) }]);
    const user = { asset: "EUR", type: "USER_AVAILABLE" as const, userId: "u1" };
    const clearing = { asset: "EUR", type: "DEPOSIT_CLEARING" as const, providerKey: "nuvei" };
    const ids = await ensureAccounts(db, [user, clearing, user]);
    expect(db.calls).toHaveLength(2);
    // Sorted by (asset, type, ...): DEPOSIT_CLEARING before USER_AVAILABLE, whatever the plan's order.
    expect(db.calls.map((call) => call.values[1])).toEqual(["DEPOSIT_CLEARING", "USER_AVAILABLE"]);
    expect(ids).toEqual([11n, 10n, 11n]);
  });
});

describe("the two new plans", () => {
  const legsOf = (plan: PostingPlan) => plan.legs.map((leg) => [leg.account.type, leg.account.userId ?? leg.account.providerKey ?? null, leg.amount]);
  const base = { asset: "EUR", userId: "u1", providerKey: "nuvei", providerReference: "ref-1" };

  it("CHARGEBACK_RECOVERY inverts a reversal: clearing pays, the user gets their portion, the house the rest", () => {
    const plan = planRecoverChargeback({ ...base, key: "chargeback-recovery:nuvei:r2", depositId: "d1", reversalId: "r2", recoversReversalId: "r1", amount: 1_000n, userPortion: 600n });
    expect(plan.type).toBe("CHARGEBACK_RECOVERY");
    expect(legsOf(plan)).toEqual([
      ["DEPOSIT_CLEARING", "nuvei", -1_000n],
      ["USER_AVAILABLE", "u1", 600n],
      ["CHARGEBACK_LOSSES", null, 400n],
    ]);
    expect([...sumByAsset(plan.legs).values()]).toEqual([0n]);
    expect(plan.reference).toMatchObject({ depositId: "d1", reversalId: "r2", recoversReversalId: "r1" });
    // The whole amount back to the user: the zero house leg is dropped.
    expect(legsOf(planRecoverChargeback({ ...base, key: "k", depositId: "d1", reversalId: "r2", recoversReversalId: "r1", amount: 500n, userPortion: 500n })))
      .toEqual([["DEPOSIT_CLEARING", "nuvei", -500n], ["USER_AVAILABLE", "u1", 500n]]);
  });

  it("WITHDRAWAL_RETURN brings a settled payout back to the available balance", () => {
    const plan = planReturnWithdrawal({ key: "withdrawal-return:w1", asset: "EUR", userId: "u1", withdrawalId: "w1", amount: 2_000n, providerKey: "bvnk", providerReference: "p1" });
    expect(plan.type).toBe("WITHDRAWAL_RETURN");
    expect(legsOf(plan)).toEqual([["WITHDRAWAL_CLEARING", "bvnk", -2_000n], ["USER_AVAILABLE", "u1", 2_000n]]);
  });

  it("both refuse PLAY, a non-positive amount and an impossible user portion", () => {
    expect(() => planReturnWithdrawal({ key: "k", asset: "PLAY", userId: "u1", withdrawalId: "w1", amount: 1n, providerKey: "bvnk", providerReference: "p" })).toThrow();
    expect(() => planReturnWithdrawal({ key: "k", asset: "EUR", userId: "u1", withdrawalId: "w1", amount: 0n, providerKey: "bvnk", providerReference: "p" })).toThrow();
    expect(() => planRecoverChargeback({ ...base, asset: "PLAY", key: "k", depositId: "d", reversalId: "r", recoversReversalId: "o", amount: 1n, userPortion: 0n })).toThrow();
    expect(() => planRecoverChargeback({ ...base, key: "k", depositId: "d", reversalId: "r", recoversReversalId: "o", amount: 10n, userPortion: 11n })).toThrow();
    expect(() => planRecoverChargeback({ ...base, key: "k", depositId: "d", reversalId: "r", recoversReversalId: "o", amount: 10n, userPortion: -1n })).toThrow();
  });

  it("execute() resolves the plan's accounts, then posts through the payments entry point", async () => {
    let next = 1;
    const db = recordingDb((sql) => (sql.includes("ledger_ensure_account") ? [{ id: String(next++) }] : [{ id: "tx-1" }]));
    const plan = planReturnWithdrawal({ key: "withdrawal-return:w1", asset: "EUR", userId: "u1", withdrawalId: "w1", amount: 2_000n, providerKey: "bvnk", providerReference: "p1" });
    expect(await execute(db, plan)).toBe("tx-1");
    expect(db.calls.at(-1)!.sql).toContain("public.ledger_post_payments(");
  });
});

describe("idempotency keys", () => {
  const uuid = "3f2b8e9c-1d4a-4b6e-9f00-0123456789ab";

  it("keyPart keeps short safe ids, hashes everything else into 48 characters, deterministically", () => {
    expect(keyPart("ch_3NqV2aLkdIwH")).toBe("ch_3NqV2aLkdIwH");
    expect(keyPart("a".repeat(KEY_PART_MAX))).toBe("a".repeat(KEY_PART_MAX));
    for (const unsafe of ["a".repeat(KEY_PART_MAX + 1), "has:colon", "has/slash", "spaced id", "", "-leading", "ünïcode", `h${"0".repeat(47)}`]) {
      const part = keyPart(unsafe);
      expect(part).toMatch(/^h[0-9a-f]{47}$/);
      expect(keyPart(unsafe)).toBe(part);
    }
    expect(keyPart("has:colon")).not.toBe(keyPart("has/colon"));
    // A verbatim value can never look like a hash, so the two spaces never collide.
    expect(keyPart(`h${"0".repeat(47)}`)).not.toBe(`h${"0".repeat(47)}`);
  });

  it("every ledger key is in the database's format and under 200 characters, even for hostile provider ids", () => {
    const providerKey = `sandbox-${"x".repeat(56)}`;
    const hostile = `${"z".repeat(500)}:/\u0000 `;
    const keys = [
      ledgerKeys.depositCredit(uuid),
      ledgerKeys.depositReversal(providerKey, hostile, "CHARGEBACK"),
      ledgerKeys.depositReversal("nuvei", "cb_123", "PROVIDER_REFUND"),
      ledgerKeys.chargebackRecovery(providerKey, hostile),
      ledgerKeys.depositFee(uuid),
      ledgerKeys.statementFee(providerKey, hostile),
      ledgerKeys.withdrawalHold(uuid),
      ledgerKeys.withdrawalRelease(uuid),
      ledgerKeys.withdrawalSettle(uuid),
      ledgerKeys.withdrawalReturn(uuid),
      ledgerKeys.adjustment("OPS-1234"),
      ledgerKeys.adjustment(hostile),
    ];
    for (const key of keys) {
      expect(key).toMatch(IDEMPOTENCY_KEY);
      expect(key.length).toBeLessThan(200);
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(ledgerKeys.depositReversal("nuvei", "cb_123", "CHARGEBACK")).toBe("deposit-reversal:nuvei:CHARGEBACK:cb_123");
    expect(ledgerKeys.depositReversal("nuvei", "cb_123", "CHARGEBACK")).not.toBe(ledgerKeys.depositReversal("nuvei", "cb_123", "CHAIN_REORG"));
  });

  it("provider idempotency keys fit PayoutDispatch.providerIdempotencyKey and differ per operation", () => {
    for (const key of [providerIdempotency.depositSession(uuid), providerIdempotency.payout(uuid), providerIdempotency.refund(uuid)]) {
      expect(key).toMatch(PROVIDER_IDEMPOTENCY_KEY);
    }
    expect(providerIdempotency.payout(uuid)).toBe(`wd_${uuid}`);
    expect(providerIdempotency.refund(uuid)).toBe(`rf_${uuid}`);
  });
});
