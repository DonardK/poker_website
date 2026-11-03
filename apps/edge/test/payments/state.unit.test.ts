/**
 * The payments state machines (src/payments/state.ts, docs/money/WALLET.md
 * section 7) and the wire helpers that depend on them. The database copy of
 * these tables is proved equal, pair by pair, by
 * apps/server/test/db/payments-schema.test.mjs.
 */
import { describe, expect, it } from "vitest";
import { WALLET_ERROR_STATUS, WITHDRAWAL_DISPLAY_STATUS, adminPaymentsAction, payoutDestinationAction, stepUpBind, withdrawalAction } from "@poker/shared";
import {
  DEPOSIT_STATUSES,
  INSTRUMENT_STATUSES,
  PAYOUT_DISPATCH_STATUSES,
  TERMINAL,
  TRANSITIONS,
  WITHDRAWAL_STATUSES,
  canTransition,
  type StateMachine,
} from "../../src/payments/state";
import { rpcFail, rpcOk } from "../../src/payments/contract";

const STATUSES: Record<StateMachine, readonly string[]> = {
  deposit: DEPOSIT_STATUSES,
  withdrawal: WITHDRAWAL_STATUSES,
  payoutDispatch: PAYOUT_DISPATCH_STATUSES,
  instrument: INSTRUMENT_STATUSES,
};

describe("transition tables", () => {
  for (const machine of Object.keys(STATUSES) as StateMachine[]) {
    it(`${machine}: every listed pair is accepted, every other pair refused, terminal states have no way out`, () => {
      const statuses = STATUSES[machine];
      const allowed = new Set(TRANSITIONS[machine].map(([from, to]) => `${from}>${to}`));
      expect(allowed.size).toBe(TRANSITIONS[machine].length);
      const can = canTransition as (machine: StateMachine, from: string, to: string) => boolean;
      for (const from of statuses) {
        for (const to of statuses) {
          expect(can(machine, from, to), `${machine} ${from} -> ${to}`).toBe(from === to || allowed.has(`${from}>${to}`));
        }
      }
      for (const terminal of TERMINAL[machine]) {
        expect(statuses.filter((to) => to !== terminal && can(machine, terminal, to))).toEqual([]);
      }
      for (const [from, to] of TRANSITIONS[machine]) expect(statuses).toEqual(expect.arrayContaining([from, to]));
    });
  }

  it("the money rules the design fixes", () => {
    // SUBMITTED is the point of no return: only SETTLED or FAILED.
    expect(WITHDRAWAL_STATUSES.filter((to) => to !== "SUBMITTED" && canTransition("withdrawal", "SUBMITTED", to))).toEqual(["SETTLED", "FAILED"]);
    // A player never moves a withdrawal back to REQUESTED, and nothing reopens a REJECTED one.
    expect(WITHDRAWAL_STATUSES.some((from) => from !== "REQUESTED" && canTransition("withdrawal", from, "REQUESTED"))).toBe(false);
    // Deposits never go backwards to CREATED or PENDING.
    for (const target of ["CREATED", "PENDING"] as const) {
      expect(DEPOSIT_STATUSES.filter((from) => from !== target && canTransition("deposit", from, target))).toEqual(target === "PENDING" ? ["CREATED"] : []);
    }
    // A late verified success can still be credited.
    for (const from of ["FAILED", "EXPIRED", "CANCELLED"] as const) expect(canTransition("deposit", from, "CONFIRMED")).toBe(true);
    // An attempted dispatch can never be cancelled by the table (the database also checks attempts = 0).
    expect(canTransition("payoutDispatch", "IN_FLIGHT", "CANCELLED")).toBe(false);
    expect(canTransition("payoutDispatch", "UNCERTAIN", "PENDING")).toBe(false);
    expect(canTransition("instrument", "REVOKED", "ACTIVE")).toBe(false);
  });

  it("every withdrawal status has a player display status", () => {
    expect(Object.keys(WITHDRAWAL_DISPLAY_STATUS).sort()).toEqual([...WITHDRAWAL_STATUSES].sort());
    expect(WITHDRAWAL_DISPLAY_STATUS.UNDER_REVIEW).toBe("PENDING_REVIEW");
    expect(WITHDRAWAL_DISPLAY_STATUS.SUBMITTED).toBe("PROCESSING");
  });
});

describe("RPC results and step-up binds", () => {
  it("rpcFail takes the status of the code; rpcOk wraps the value", () => {
    expect(rpcOk({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(rpcFail("STEP_UP_REQUIRED", "Confirm", { stepUp: { purpose: "withdrawal", bind: "a".repeat(64), methods: ["PASSKEY"] } }))
      .toEqual({ ok: false, status: 403, code: "STEP_UP_REQUIRED", message: "Confirm", stepUp: { purpose: "withdrawal", bind: "a".repeat(64), methods: ["PASSKEY"] } });
    expect(rpcFail("INSUFFICIENT_FUNDS", "x").status).toBe(422);
    expect(rpcFail("PAYMENTS_UNAVAILABLE", "x", { retryable: true })).toMatchObject({ status: 503, retryable: true });
    // Never 401 for a step-up (the web client would try a token refresh).
    expect(WALLET_ERROR_STATUS.STEP_UP_REQUIRED).toBe(403);
    expect(Object.values(WALLET_ERROR_STATUS).every((status) => [400, 401, 403, 404, 409, 422, 429, 500, 503].includes(status))).toBe(true);
  });

  it("a bind is the hex SHA-256 of the canonical action: key order does not matter, every field does", async () => {
    const input = { userId: "u1", asset: "TEST_EUR" as const, instrumentId: "i1", amountMinor: "5000", feeMinor: "0", quoteId: "q1" };
    const bind = await stepUpBind(withdrawalAction(input));
    expect(bind).toMatch(/^[a-f0-9]{64}$/);
    const reordered = { quoteId: "q1", feeMinor: "0", amountMinor: "5000", instrumentId: "i1", asset: "TEST_EUR" as const, userId: "u1" };
    expect(await stepUpBind(withdrawalAction(reordered))).toBe(bind);
    expect(await stepUpBind(withdrawalAction({ ...input, amountMinor: "5001" }))).not.toBe(bind);
    expect(await stepUpBind(withdrawalAction({ ...input, asset: "EUR" }))).not.toBe(bind);
    // The canonical text is {"amountMinor":"5000","asset":"TEST_EUR","feeMinor":"0","instrumentId":"i1","purpose":"withdrawal","quoteId":"q1","userId":"u1","v":1}.
    const text = '{"amountMinor":"5000","asset":"TEST_EUR","feeMinor":"0","instrumentId":"i1","purpose":"withdrawal","quoteId":"q1","userId":"u1","v":1}';
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    expect(bind).toBe(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    const destination = await stepUpBind(payoutDestinationAction({ userId: "u1", asset: "BTC", addressNormalized: "bc1q", memo: null }));
    const admin = await stepUpBind(adminPaymentsAction({ subject: "withdrawal:w1", decision: "APPROVE" }));
    expect(new Set([bind, destination, admin]).size).toBe(3);
  });
});
