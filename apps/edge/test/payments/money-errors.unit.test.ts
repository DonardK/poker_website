/**
 * Error mapping of the ledger port and moneyTx (docs/money/WALLET.md section
 * 8.3) without a database. The error objects reproduce exactly what the
 * drivers throw (recorded against the embedded PostgreSQL through
 * @prisma/adapter-pg 6.19.3; money-errors.db.test.ts proves it live):
 * - a raw query (and a mapped constraint error): PrismaClientKnownRequestError
 *   P2010 / P2002 with the SQLSTATE in meta.driverAdapterError.cause.originalCode;
 * - a model query refused by a trigger: the DriverAdapterError itself, with
 *   cause.originalCode;
 * - Prisma's library engine (apps/server): meta.code; node-postgres: code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { toLedgerError } from "../../src/money/ledger";
import {
  MONEY_TX_DEFAULTS,
  PaymentsInvariant,
  PaymentsRefusal,
  PaymentsUnavailable,
  classifyMoneyError,
  moneyTx,
  type MoneyTxClient,
} from "../../src/money/tx";

const KIND: Record<string, string> = { "40001": "TransactionWriteConflict", "23505": "UniqueConstraintViolation" };

function adapterRaw(code: string, message: string, prismaCode = "P2010"): Error {
  const cause = { originalCode: code, originalMessage: message, ...(KIND[code] ? { kind: KIND[code] } : { kind: "postgres", code, severity: "ERROR", message }) };
  return Object.assign(new Error(`\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\nRaw query failed. Code: \`${code}\`. Message: \`${message}\``), {
    name: "PrismaClientKnownRequestError",
    code: prismaCode,
    meta: { driverAdapterError: { name: "DriverAdapterError", cause } },
    clientVersion: "6.19.3",
  });
}

function adapterModel(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "DriverAdapterError",
    cause: { originalCode: code, originalMessage: message, kind: "postgres", code, severity: "ERROR", message },
  });
}

const library = (code: string, message: string) => Object.assign(new Error(`Raw query failed. Code: \`${code}\`. Message: \`${message}\``), { code: "P2010", meta: { code, message } });
const nodePg = (code: string, message: string) => Object.assign(new Error(message), { code, severity: "ERROR" });

const SHAPES = { adapterRaw, adapterModel, library, nodePg } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toLedgerError reads the SQLSTATE wherever the driver puts it", () => {
  const cases: [sqlstate: string, message: string, code: string, dbCode: string][] = [
    ["LG011", "LEDGER_INSUFFICIENT_FUNDS: account 7 would go negative", "INSUFFICIENT_FUNDS", "LEDGER_INSUFFICIENT_FUNDS"],
    ["LG022", "LEDGER_TYPE_FORBIDDEN: DEPOSIT_CREDIT is not allowed through this entry point", "FORBIDDEN", "LEDGER_TYPE_FORBIDDEN"],
    ["LG023", "LEDGER_UNBOUND_PAYMENT: DEPOSIT_CREDIT transaction t has no matching payment record", "UNBOUND", "LEDGER_UNBOUND_PAYMENT"],
    ["LG009", "LEDGER_ASSET_DISABLED: asset EUR is disabled", "ASSET_DISABLED", "LEDGER_ASSET_DISABLED"],
    ["LG012", "LEDGER_IDEMPOTENCY_CONFLICT: key reused", "IDEMPOTENCY_CONFLICT", "LEDGER_IDEMPOTENCY_CONFLICT"],
    ["40001", "could not serialize access due to concurrent update", "RETRY", "SERIALIZATION_FAILURE"],
    ["40001", "LEDGER_RETRY: concurrent account creation is not visible in this snapshot", "RETRY", "LEDGER_RETRY"],
    ["40P01", "deadlock detected", "RETRY", "DEADLOCK_DETECTED"],
    ["42501", "permission denied for function ledger_post_payments", "FORBIDDEN", "PERMISSION_DENIED"],
  ];
  for (const [shape, make] of Object.entries(SHAPES)) {
    it(`${shape}: LG011, LG022, LG023, LG009, LG012, 40001, 40P01 and 42501`, () => {
      for (const [sqlstate, message, code, dbCode] of cases) {
        const mapped = toLedgerError(make(sqlstate, message));
        expect(mapped, `${shape} ${sqlstate}`).toMatchObject({ code, dbCode });
        expect(mapped!.message.length).toBeLessThanOrEqual(500);
        if (dbCode.startsWith("LEDGER_")) expect(mapped!.message).toContain(dbCode);
      }
    });
  }

  it("anything that is not a ledger refusal is not mapped (the caller propagates it)", () => {
    expect(toLedgerError(adapterRaw("PM003", "PAYMENT_BAD_TRANSITION: deposit A -> B"))).toBeNull();
    expect(toLedgerError(adapterModel("23514", "new row violates check constraint"))).toBeNull();
    expect(toLedgerError(new Error("Connection terminated unexpectedly"))).toBeNull();
    expect(toLedgerError(Object.assign(new Error("Transaction already closed"), { code: "P2028" }))).toBeNull();
    expect(toLedgerError(null)).toBeNull();
    // Without any SQLSTATE a known LEDGER_* prefix still maps.
    expect(toLedgerError(new Error("LEDGER_INSUFFICIENT_FUNDS: x"))).toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  });
});

describe("classifyMoneyError", () => {
  const label = "test.classify";
  const decide = (error: unknown, retryOn?: Parameters<typeof classifyMoneyError>[1]["retryOn"]) => classifyMoneyError(error, { label, retryOn });

  it("domain refusals become PaymentsRefusal with the wallet code", () => {
    const refusals: [Error, string][] = [
      [adapterRaw("LG011", "LEDGER_INSUFFICIENT_FUNDS: x"), "INSUFFICIENT_FUNDS"],
      [adapterRaw("LG009", "LEDGER_ASSET_DISABLED: asset EUR is disabled"), "PAYMENTS_PAUSED"],
      [adapterModel("PM005", "PAYMENT_DUPLICATE_INSTRUMENT: this address is already saved"), "DESTINATION_EXISTS"],
      [adapterModel("PM007", "RG_RULE: x"), "RG_RULE"],
      [adapterModel("PM008", "PAYMENT_SECURITY_HOLD: x"), "SECURITY_HOLD"],
      [adapterModel("PM009", "PAYMENT_STEP_UP_REQUIRED: x"), "STEP_UP_REQUIRED"],
      [adapterModel("PM010", "PAYMENT_INSTRUMENT_UNAVAILABLE: x"), "DESTINATION_UNAVAILABLE"],
    ];
    for (const [error, code] of refusals) {
      const decision = decide(error);
      expect(decision.action).toBe("throw");
      if (decision.action !== "throw") continue;
      expect(decision.error).toBeInstanceOf(PaymentsRefusal);
      expect(decision.error.code).toBe(code);
      expect(decision.error.message).not.toMatch(/PAYMENT_|LEDGER_|SQL/);
    }
  });

  it("bugs become PaymentsInvariant: conflicts, invariants, forbidden, unbound, PM001-PM004, PM006, CHECKs", () => {
    for (const error of [
      adapterRaw("LG012", "LEDGER_IDEMPOTENCY_CONFLICT: x"), adapterRaw("LG018", "LEDGER_BAD_SHAPE: x"), adapterRaw("LG022", "LEDGER_TYPE_FORBIDDEN: x"),
      adapterRaw("LG023", "LEDGER_UNBOUND_PAYMENT: x"), adapterRaw("42501", "permission denied for table Deposit"),
      adapterModel("PM001", "PAYMENT_IMMUTABLE: x"), adapterModel("PM002", "PAYMENT_IMMUTABLE_FIELD: x"), adapterModel("PM003", "PAYMENT_BAD_TRANSITION: x"),
      adapterModel("PM004", "PAYMENT_APPROVAL_REQUIRED: x"), adapterModel("PM006", "PAYMENT_MISMATCH: x"), adapterModel("23514", "check constraint"),
      adapterRaw("23503", "foreign key"),
    ]) {
      const decision = decide(error);
      expect(decision.action, error.message).toBe("throw");
      if (decision.action === "throw") expect(decision.error).toBeInstanceOf(PaymentsInvariant);
    }
    const pm = decide(adapterModel("PM003", "PAYMENT_BAD_TRANSITION: x"));
    expect(pm.action === "throw" && pm.error.dbCode).toBe("PAYMENT_BAD_TRANSITION");
  });

  it("serialization, deadlock, write conflict and unique races retry; timeouts retry once; no SQLSTATE is unavailable", () => {
    expect(decide(adapterRaw("40001", "could not serialize access")).action).toBe("retry");
    expect(decide(adapterModel("40P01", "deadlock detected")).action).toBe("retry");
    expect(decide(Object.assign(new Error("write conflict"), { code: "P2034" })).action).toBe("retry");
    expect(decide(adapterRaw("23505", "duplicate key", "P2002")).action).toBe("retry");
    expect(decide(adapterRaw("55P03", "canceling statement due to lock timeout")).action).toBe("retry-once");
    expect(decide(adapterRaw("57014", "canceling statement due to statement timeout")).action).toBe("retry-once");
    const lost = decide(new Error("Connection terminated unexpectedly"));
    expect(lost.action === "throw" && lost.error).toBeInstanceOf(PaymentsUnavailable);
  });

  it("retryOn opts a ledger refusal into a retry", () => {
    const short = adapterRaw("LG011", "LEDGER_INSUFFICIENT_FUNDS: x");
    expect(decide(short, (error) => error.code === "INSUFFICIENT_FUNDS").action).toBe("retry");
    expect(decide(short, (error) => error.code === "RETRY").action).toBe("throw");
  });
});

/**
 * A Prisma client whose interactive transaction records every statement and
 * runs `fn`; `fail` decides per attempt and statement whether it throws.
 */
function fakeClient(fail: (attempt: number, sql: string) => Error | null = () => null) {
  const attempts: string[][] = [];
  const options: unknown[] = [];
  const client = {
    async $transaction<R>(fn: (tx: unknown) => Promise<R>, opts: unknown): Promise<R> {
      const statements: string[] = [];
      attempts.push(statements);
      options.push(opts);
      const attempt = attempts.length;
      const run = (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        statements.push(sql);
        const error = fail(attempt, sql);
        return error ? Promise.reject(error) : Promise.resolve(0);
      };
      return fn({ $executeRaw: run, $queryRaw: run });
    },
  };
  return { client: client as unknown as MoneyTxClient, attempts, options };
}

const work = async (tx: unknown) => {
  await (tx as { $executeRaw: (s: TemplateStringsArray) => Promise<number> }).$executeRaw`UPDATE "Deposit" SET x = 1`;
  return "done";
};
const fast = { backoffMs: () => 0 };

describe("moneyTx", () => {
  it("one READ COMMITTED transaction: timeouts first, the work, SET CONSTRAINTS ALL IMMEDIATE last", async () => {
    const { client, attempts, options } = fakeClient();
    expect(await moneyTx(client, work, { label: "test.ok" })).toBe("done");
    expect(attempts).toEqual([["SET LOCAL TIME ZONE 'UTC'", "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '10s'", 'UPDATE "Deposit" SET x = 1', "SET CONSTRAINTS ALL IMMEDIATE"]]);
    expect(options).toEqual([{ isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 15_000 }]);
    expect(MONEY_TX_DEFAULTS.attempts).toBe(4);
  });

  it("retries a serialization failure and succeeds; gives up after `attempts` as PaymentsUnavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const flaky = fakeClient((attempt, sql) => (attempt < 3 && sql.startsWith("UPDATE") ? adapterRaw("40001", "could not serialize access") : null));
    expect(await moneyTx(flaky.client, work, { label: "test.retry", ...fast })).toBe("done");
    expect(flaky.attempts).toHaveLength(3);
    const stuck = fakeClient((_, sql) => (sql.startsWith("UPDATE") ? adapterModel("40P01", "deadlock detected") : null));
    await expect(moneyTx(stuck.client, work, { label: "test.stuck", attempts: 4, ...fast })).rejects.toMatchObject({ name: "PaymentsUnavailable", reason: "retries_exhausted", retryable: true });
    expect(stuck.attempts).toHaveLength(4);
  });

  it("a lock or statement timeout is retried once, then PaymentsUnavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const once = fakeClient((attempt, sql) => (attempt === 1 && sql.startsWith("UPDATE") ? adapterRaw("55P03", "lock timeout") : null));
    expect(await moneyTx(once.client, work, { label: "test.timeout", ...fast })).toBe("done");
    const twice = fakeClient((_, sql) => (sql.startsWith("UPDATE") ? adapterRaw("57014", "statement timeout") : null));
    await expect(moneyTx(twice.client, work, { label: "test.timeout2", ...fast })).rejects.toMatchObject({ name: "PaymentsUnavailable", reason: "timeout" });
    expect(twice.attempts).toHaveLength(2);
  });

  it("an unbound payment surfacing at SET CONSTRAINTS is a PaymentsInvariant, logged with alert PAYMENTS_INVARIANT, never retried", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const unbound = fakeClient((_, sql) => (sql === "SET CONSTRAINTS ALL IMMEDIATE" ? adapterRaw("LG023", "LEDGER_UNBOUND_PAYMENT: x") : null));
    await expect(moneyTx(unbound.client, work, { label: "deposit.apply", ...fast })).rejects.toMatchObject({ name: "PaymentsInvariant", code: "INTERNAL", dbCode: "LEDGER_UNBOUND_PAYMENT" });
    expect(unbound.attempts).toHaveLength(1);
    const line = JSON.parse(String(errors.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ level: "error", alert: "PAYMENTS_INVARIANT", label: "deposit.apply", dbCode: "LEDGER_UNBOUND_PAYMENT", sqlstate: "LG023" });
    expect(JSON.stringify(line)).not.toContain("Raw query failed");
  });

  it("INSUFFICIENT_FUNDS is a refusal unless retryOn asks for a retry (a reversal recomputing its user portion)", async () => {
    const short = (attempts: number) => fakeClient((attempt, sql) => (attempt <= attempts && sql.startsWith("UPDATE") ? adapterRaw("LG011", "LEDGER_INSUFFICIENT_FUNDS: x") : null));
    const refused = short(1);
    await expect(moneyTx(refused.client, work, { label: "withdrawal.request", ...fast })).rejects.toMatchObject({ name: "PaymentsRefusal", code: "INSUFFICIENT_FUNDS" });
    expect(refused.attempts).toHaveLength(1);
    const recomputed = short(2);
    expect(await moneyTx(recomputed.client, work, { label: "dispute.apply", retryOn: (error) => error.code === "INSUFFICIENT_FUNDS", attempts: 5, ...fast })).toBe("done");
    expect(recomputed.attempts).toHaveLength(3);
  });

  it("a unique race retries (the retry finds the winner's row); a persistent one is a bug", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const race = fakeClient((attempt, sql) => (attempt === 1 && sql.startsWith("UPDATE") ? adapterRaw("23505", "duplicate key", "P2002") : null));
    expect(await moneyTx(race.client, work, { label: "deposit.create", ...fast })).toBe("done");
    const always = fakeClient((_, sql) => (sql.startsWith("UPDATE") ? adapterRaw("23505", "duplicate key", "P2002") : null));
    await expect(moneyTx(always.client, work, { label: "deposit.create", attempts: 2, ...fast })).rejects.toBeInstanceOf(PaymentsInvariant);
  });

  it("a lost connection is PaymentsUnavailable at once; a MoneyTxError thrown by fn passes through unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const lost = fakeClient((_, sql) => (sql.startsWith("UPDATE") ? new Error("Connection terminated unexpectedly") : null));
    await expect(moneyTx(lost.client, work, { label: "test.lost", ...fast })).rejects.toMatchObject({ name: "PaymentsUnavailable", reason: "connection" });
    expect(lost.attempts).toHaveLength(1);
    const own = new PaymentsRefusal("test.own", "QUOTE_EXPIRED", "The quote expired.", null);
    const { client } = fakeClient();
    await expect(moneyTx(client, async () => { throw own; }, { label: "test.own" })).rejects.toBe(own);
  });
});
