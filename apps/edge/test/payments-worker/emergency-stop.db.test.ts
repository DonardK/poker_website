/**
 * The emergency stop on the real database (docs/money/PAYMENTS_RUNBOOK.md
 * section 4): UPDATE "Asset" SET enabled = false, and PAYOUT_DISPATCH off.
 * Nothing leaves, nothing is lost, what the provider already has is still
 * followed, and protection does not wait for the ledger: a lockdown, a freeze
 * and a chargeback commit their protective state during a stop and settle the
 * money after it.
 *
 * These tests flip cluster-wide state, so they live in the payments project,
 * which runs after the API project and one file at a time. Without the
 * database they skip, unless POKER_REQUIRE_DB_TESTS=1 (CI).
 */
import { adminPaymentsAction, stepUpBind } from "@poker/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decideWithdrawal, setRestriction, setSwitch } from "../../src/payments/admin";
import type { PaymentsContext } from "../../src/payments/context";
import { createDeposit, retryConfirmedCredits } from "../../src/payments/deposits";
import { dispatchOne, sendsStopped } from "../../src/payments/dispatch";
import { MAX_EVENT_ATTEMPTS, processDueEvents, processEvent } from "../../src/payments/inbox";
import { applySandboxOutcome } from "../../src/payments/providers/sandbox";
import type { ProviderPayout, ProviderResult } from "../../src/payments/providers/types";
import { applyPendingLockdowns, onScreeningHit, securityLockdown } from "../../src/payments/security";
import { addCryptoDestination, prepareCryptoDestination } from "../../src/payments/instruments";
import { quoteWithdrawal, settleRequestedCancels } from "../../src/payments/withdrawals";
import { moneyTx } from "../../src/money/tx";
import { ageInstrument, balances, deliver, mintGrant, newPlayer, openFixture, type Fixture, type Player } from "../payments/support/fixture";
import {
  adminGrantFor, approvedWithdrawal, asAdmin, asSuperuser, cardDeposit, cardOf, cryptoDeposit, dispatchUntilMoved, newAdmin, quoteAndGrant, refusal, requestTo, sandboxOptions, user,
} from "../payments/support/flows";

let f: Fixture | null = null;

beforeAll(async () => {
  f = await openFixture();
}, 60_000);

afterAll(async () => {
  if (f) {
    await setAsset("TEST_EUR", true);
    await f.close();
  }
});

const setAsset = (code: string, enabled: boolean) => asSuperuser((db) => db.$executeRaw`UPDATE public."Asset" SET "enabled" = ${enabled} WHERE "code" = ${code}`);
const setDispatch = (enabled: boolean) => asSuperuser((db) => db.$executeRaw`UPDATE public."PaymentSwitch" SET "enabled" = ${enabled} WHERE "key" = 'PAYOUT_DISPATCH'`);

afterEach(async () => {
  if (!f) return;
  await setAsset("TEST_EUR", true);
  await setDispatch(true);
  f.clock.offsetMs = 0;
});

function dbTest(name: string, run: (fx: Fixture) => Promise<void>): void {
  it(name, async (context) => {
    if (!f) return context.skip();
    await run(f);
  }, 120_000);
}

const created = (fx: Fixture, key: string) => fx.store.get<number>(`count:create:${key}`).then((n) => n ?? 0);
const dispatchRow = (fx: Fixture, id: string) => fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: id } });
const withdrawalRow = (fx: Fixture, id: string) => fx.payments.withdrawal.findUniqueOrThrow({ where: { id } });
const compliance = (fx: Fixture, userId: string) => fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId } });

async function drain(fx: Fixture, ctx: PaymentsContext = fx.ctx(), rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await dispatchOne(ctx).catch(() => undefined);
}

/** A ctx whose provider counts status reads of one payout and answers as told; other rows left by earlier tests get the sandbox's answer. */
function withPayoutRead(fx: Fixture, key: string, read: () => ProviderResult<ProviderPayout | null>): { ctx: PaymentsContext; reads: () => number } {
  const ctx = fx.ctx();
  const sandbox = ctx.providers.card!;
  let reads = 0;
  const card = {
    ...sandbox,
    getPayout: async (ref: Parameters<typeof sandbox.getPayout>[0]) => {
      if (ref.idempotencyKey !== key) return sandbox.getPayout(ref);
      reads += 1;
      return read();
    },
  };
  return { ctx: { ...ctx, providers: { ...ctx.providers, card } }, reads: () => reads };
}

for (const [name, stop, resume] of [
  ["the asset disabled", () => setAsset("TEST_EUR", false), () => setAsset("TEST_EUR", true)],
  ["PAYOUT_DISPATCH off", () => setDispatch(false), () => setDispatch(true)],
] as const) {
  describe(`stopped by ${name}`, () => {
    dbTest("a first send does not leave: no provider call, the row and the hold unchanged, and it goes when the stop lifts", async (fx) => {
      const player = await newPlayer(fx);
      await cardDeposit(fx, player, "60.00");
      const { id, key } = await approvedWithdrawal(fx, player, "20.00");
      const before = await dispatchRow(fx, id);
      await stop();
      await drain(fx);
      expect(await created(fx, key)).toBe(0);
      expect(await dispatchRow(fx, id)).toEqual(before);
      expect((await withdrawalRow(fx, id)).status).toBe("APPROVED");
      expect(await balances(fx, player.userId)).toEqual({ available: 4000n, held: 2000n });
      await resume();
      expect(await dispatchUntilMoved(fx, id, ["PENDING", "IN_FLIGHT"], 40)).toBe("COMPLETED");
      expect(await created(fx, key)).toBe(1);
      expect((await withdrawalRow(fx, id)).status).toBe("SETTLED");
    });

    dbTest("the stop is read again under the lock: a stop that lands after the row was picked still stops it", async (fx) => {
      const player = await newPlayer(fx);
      await cardDeposit(fx, player, "60.00");
      const { id, key } = await approvedWithdrawal(fx, player, "20.00");
      const before = await dispatchRow(fx, id);
      await stop();
      // The first look, before the row is picked, sees no stop; the transaction that would send sees the real one.
      const ctx = fx.ctx();
      const stale: PaymentsContext = {
        ...ctx,
        db: new Proxy(ctx.db, {
          get(target, prop, receiver) {
            if (prop === "paymentSwitch") return { findMany: async () => [{ key: "PAYOUT_DISPATCH", enabled: true }] };
            if (prop === "asset") return { findUnique: async () => ({ enabled: true }) };
            return Reflect.get(target, prop, receiver);
          },
        }),
      };
      await drain(fx, stale, 20);
      expect(await created(fx, key)).toBe(0);
      expect(await dispatchRow(fx, id)).toEqual(before);
    });

    dbTest("a retry does not go out again either", async (fx) => {
      const player = await newPlayer(fx);
      await cardDeposit(fx, player, "60.00");
      // Cents .03: lost on the way, and due to be sent again after two NOT_FOUND answers ten minutes apart.
      const { id, key } = await approvedWithdrawal(fx, player, "20.03");
      for (const [offset, status] of [[0, "UNCERTAIN"], [2 * 60_000, null], [8 * 60_000, null], [24 * 60_000, "RETRY_WAIT"]] as const) {
        fx.clock.offsetMs = offset;
        for (let i = 0; i < 40 && (await fx.payments.payoutAttempt.count({ where: { withdrawalId: id } })) < (offset === 0 ? 1 : offset === 2 * 60_000 ? 2 : offset === 8 * 60_000 ? 3 : 4); i += 1) await dispatchOne(fx.ctx());
        if (status) expect((await dispatchRow(fx, id)).status).toBe(status);
      }
      expect(await created(fx, key)).toBe(1);
      const before = await dispatchRow(fx, id);
      await stop();
      await drain(fx);
      expect(await created(fx, key)).toBe(1);
      expect(await dispatchRow(fx, id)).toEqual(before);
      await resume();
      expect(await dispatchUntilMoved(fx, id, ["RETRY_WAIT", "IN_FLIGHT", "UNCERTAIN"], 40)).toBe("COMPLETED");
      expect(await created(fx, key)).toBe(2);
    });

    dbTest("a card refund does not leave", async (fx) => {
      const player = await newPlayer(fx);
      await cardDeposit(fx, player, "25.00", "approve_prepaid");
      const refund = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: player.userId, kind: "REFUND" } });
      expect(refund.status).toBe("APPROVED");
      const { providerIdempotencyKey: key } = await dispatchRow(fx, refund.id);
      await stop();
      await drain(fx);
      expect(await created(fx, key)).toBe(0);
      expect((await dispatchRow(fx, refund.id)).status).toBe("PENDING");
      await resume();
      expect(await dispatchUntilMoved(fx, refund.id, ["PENDING", "IN_FLIGHT"], 40)).toBe("COMPLETED");
    });

    dbTest("an unsent row at the head of the queue does not hide a payout the provider already has: status reads go on", async (fx) => {
      const player = await newPlayer(fx);
      await cardDeposit(fx, player, "60.00");
      // Cents .07 stays pending at the sandbox's provider; a second, unsent one is older in the queue order.
      const inFlight = await approvedWithdrawal(fx, player, "20.00");
      await fx.payments.$executeRaw`UPDATE public."PayoutDispatch" SET "status" = 'IN_FLIGHT', "leaseUntil" = ${new Date(Date.now() + 60_000).toISOString()}::timestamp, "attempts" = 1 WHERE "withdrawalId" = ${inFlight.id}::uuid`;
      await fx.payments.$executeRaw`UPDATE public."Withdrawal" SET "status" = 'SUBMITTED', "submittedAt" = ${new Date().toISOString()}::timestamp WHERE "id" = ${inFlight.id}::uuid`;
      await fx.payments.$executeRaw`UPDATE public."PayoutDispatch" SET "status" = 'SENT', "leaseUntil" = NULL, "nextAttemptAt" = ${new Date(Date.now() - 1_000).toISOString()}::timestamp WHERE "withdrawalId" = ${inFlight.id}::uuid`;
      const unsent = await approvedWithdrawal(fx, player, "20.00");
      await fx.payments.$executeRaw`UPDATE public."PayoutDispatch" SET "nextAttemptAt" = ${new Date(Date.now() - 3_600_000).toISOString()}::timestamp WHERE "withdrawalId" = ${unsent.id}::uuid`;
      const { ctx, reads } = withPayoutRead(fx, inFlight.key, () => ({ kind: "ok", value: { providerPayoutId: `po_${inFlight.id}`, merchantRef: inFlight.key, state: "PROCESSING", final: false, rawState: "PENDING", occurredAt: fx.now() } }));
      await stop();
      await drain(fx, ctx, 12);
      expect(reads()).toBeGreaterThan(0);
      expect(await created(fx, unsent.key)).toBe(0);
    });
  });
}

describe("what is already out, during a stop", () => {
  dbTest("a payout outcome that has to post waits for the ledger, then settles: nothing lost, the hold kept", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const { id, key } = await approvedWithdrawal(fx, player, "20.00");
    await fx.payments.$executeRaw`UPDATE public."PayoutDispatch" SET "status" = 'IN_FLIGHT', "attempts" = 1, "leaseUntil" = ${new Date(Date.now() + 60_000).toISOString()}::timestamp WHERE "withdrawalId" = ${id}::uuid`;
    await fx.payments.$executeRaw`UPDATE public."Withdrawal" SET "status" = 'SUBMITTED', "submittedAt" = ${new Date().toISOString()}::timestamp WHERE "id" = ${id}::uuid`;
    await fx.payments.$executeRaw`UPDATE public."PayoutDispatch" SET "status" = 'SENT', "leaseUntil" = NULL, "nextAttemptAt" = ${new Date(Date.now() - 1_000).toISOString()}::timestamp WHERE "withdrawalId" = ${id}::uuid`;
    const { ctx, reads } = withPayoutRead(fx, key, () => ({ kind: "ok", value: { providerPayoutId: `po_${id}`, merchantRef: key, state: "SUCCEEDED", final: true, rawState: "APPROVED", occurredAt: fx.now() } }));
    await setAsset("TEST_EUR", false);
    for (let i = 0; i < 20 && reads() === 0; i += 1) await dispatchOne(ctx);
    expect(reads()).toBeGreaterThan(0);
    expect((await withdrawalRow(fx, id)).status).toBe("SUBMITTED");
    expect(await balances(fx, player.userId)).toEqual({ available: 4000n, held: 2000n });
    await setAsset("TEST_EUR", true);
    fx.clock.offsetMs = 120_000;
    for (let i = 0; i < 20 && (await withdrawalRow(fx, id)).status !== "SETTLED"; i += 1) await dispatchOne(ctx);
    expect((await withdrawalRow(fx, id)).status).toBe("SETTLED");
    expect(await balances(fx, player.userId)).toEqual({ available: 4000n, held: 0n });
  });

  dbTest("a confirmed deposit is parked, not lost, and credited once when the stop lifts", async (fx) => {
    const player = await newPlayer(fx);
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CARD", amount: "30.00", saveCard: true, clientRequestId: crypto.randomUUID() });
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    const envelope = await applySandboxOutcome(sandboxOptions(fx), row.providerPaymentId!, "approve");
    await setAsset("TEST_EUR", false);
    expect((await deliver(fx, ctx, "sandbox-card", envelope!)).status).toBe(200);
    await fx.flush();
    const parked = await fx.payments.deposit.findUniqueOrThrow({ where: { id: row.id } });
    expect([parked.status, parked.ledgerCreditTxId]).toEqual(["CONFIRMED", null]);
    expect(parked.instrumentId).not.toBeNull();
    expect((await balances(fx, player.userId)).available).toBe(0n);
    fx.clock.offsetMs = 120_000;
    expect(await retryConfirmedCredits(fx.ctx())).toBe(0);
    await setAsset("TEST_EUR", true);
    for (let i = 0; i < 10 && (await fx.payments.deposit.findUniqueOrThrow({ where: { id: row.id } })).status === "CONFIRMED"; i += 1) await retryConfirmedCredits(fx.ctx());
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("CREDITED");
    expect((await balances(fx, player.userId)).available).toBe(3000n);
    await retryConfirmedCredits(fx.ctx());
    expect((await balances(fx, player.userId)).available).toBe(3000n);
  });

  dbTest("a chargeback during a stop freezes the account now, spends no attempt, and reverses the deposit after", async (fx) => {
    const player = await newPlayer(fx);
    const depositId = await cardDeposit(fx, player, "40.00");
    const card = await cardOf(fx, player.userId);
    await ageInstrument(fx, card, 80 * 3_600_000);
    const open = await requestTo(fx, player, card, "20.00");
    const ctx = fx.ctx();
    const paymentId = (await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).providerPaymentId!;
    const envelope = await applySandboxOutcome(sandboxOptions(fx), paymentId, "chargeback");
    await setAsset("TEST_EUR", false);
    expect((await deliver(fx, ctx, "sandbox-card", envelope!)).status).toBe(200);
    await fx.flush();
    expect((await compliance(fx, player.userId)).restriction).toBe("FROZEN");
    expect((await withdrawalRow(fx, open)).cancelCode).toBe("CHARGEBACK_HOLD");
    const event = await fx.payments.paymentEvent.findFirstOrThrow({ where: { provider: "sandbox-card", objectRef: paymentId, objectType: "DISPUTE" } });
    expect([event.processedAt, event.attempts, event.lastError]).toEqual([null, 0, "PAYMENTS_PAUSED"]);
    expect(event.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // However long the stop lasts: it never runs out of attempts.
    for (let i = 0; i < MAX_EVENT_ATTEMPTS + 2; i += 1) await processEvent(fx.ctx(), event.id);
    expect((await fx.payments.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).outcome).toBeNull();
    await setAsset("TEST_EUR", true);
    fx.clock.offsetMs = 6 * 60_000;
    await processDueEvents(fx.ctx(), 50);
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).status).toBe("REVERSED");
    expect((await withdrawalRow(fx, open)).status).toBe("CANCELLED");
    expect((await balances(fx, player.userId))).toEqual({ available: 0n, held: 0n });
  });
});

describe("protection does not wait for the ledger", () => {
  dbTest("a lockdown commits its protective state during a stop; the releases follow it", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    await ageInstrument(fx, card, 80 * 3_600_000);
    const open = await requestTo(fx, player, card, "20.00");
    const approved = await approvedWithdrawal(fx, player, "20.00");
    const spare = await quoteAndGrant(fx, player, card, "20.00");
    await setAsset("TEST_EUR", false);
    const result = await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    expect(result).toEqual({ revoked: 0, cancelled: 0 });
    expect((await compliance(fx, player.userId)).restriction).toBe("WITHDRAWALS_MANUAL");
    expect((await fx.payments.stepUpGrant.findUniqueOrThrow({ where: { id: spare.grant } })).consumedAt).not.toBeNull();
    for (const id of [open, approved.id]) expect((await withdrawalRow(fx, id)).cancelCode).toBe("SECURITY_LOCKDOWN");
    expect(await settleRequestedCancels(fx.ctx())).toBe(0);
    expect(await balances(fx, player.userId)).toEqual({ available: 2000n, held: 4000n });
    await setAsset("TEST_EUR", true);
    // Picked up by the dispatcher's task, or by the send itself: either way it never leaves.
    expect(await settleRequestedCancels(fx.ctx(), { userId: player.userId })).toBe(2);
    expect((await withdrawalRow(fx, open)).status).toBe("CANCELLED");
    expect((await withdrawalRow(fx, approved.id)).status).toBe("CANCELLED");
    expect((await dispatchRow(fx, approved.id)).status).toBe("CANCELLED");
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
    expect(await created(fx, approved.key)).toBe(0);
    expect(await settleRequestedCancels(fx.ctx(), { userId: player.userId })).toBe(0);
  });

  dbTest("the sweep applies a report during a stop too", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    await fx.runtime.accountSecurityEvent.create({ data: { userId: player.userId, type: "NOT_ME_REPORTED" } });
    await setAsset("TEST_EUR", false);
    expect(await applyPendingLockdowns(fx.ctx(), 50)).toBeGreaterThan(0);
    expect((await compliance(fx, player.userId)).restriction).toBe("WITHDRAWALS_MANUAL");
  });

  dbTest("a marked withdrawal the dispatcher reaches first is cancelled, not sent", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const { id, key } = await approvedWithdrawal(fx, player, "20.00");
    await setAsset("TEST_EUR", false);
    await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    await setAsset("TEST_EUR", true);
    expect(await dispatchUntilMoved(fx, id, ["PENDING"], 40)).toBe("CANCELLED");
    const row = await withdrawalRow(fx, id);
    expect([row.status, row.failureCode]).toEqual(["CANCELLED", "SECURITY_LOCKDOWN"]);
    expect(await created(fx, key)).toBe(0);
  });

  dbTest("a crypto refund approved to a named address: a lockdown during a stop marks it, and after the stop it is cancelled, never sent", async (fx) => {
    const player = await newPlayer(fx);
    await fx.runtime.responsibleGamingLimit.create({ data: { userId: player.userId, kind: "DEPOSIT", period: "DAY", assetCode: "EUR", amountMinor: 2500n, source: "PLAYER", createdBy: player.userId } });
    await cryptoDeposit(fx, player, "20.00", "overpay");
    const refund = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: player.userId, kind: "REFUND" } });
    const u = await user(fx, player.caller);
    const value = "0x52908400098527886e0f7030069857d2e4169ee7";
    const prepared = await prepareCryptoDestination(fx.ctx(), u, "MT", { asset: "USDC_ERC20", address: value });
    const { view } = await addCryptoDestination(fx.ctx(), player.caller, u, "MT", {
      asset: "USDC_ERC20", address: value, stepUpGrantId: await mintGrant(fx, player, { purpose: "payout_destination", bind: prepared.bind }), clientRequestId: crypto.randomUUID(),
    });
    await ageInstrument(fx, view.id, 2_000);
    const staff = await newAdmin(fx);
    await decideWithdrawal(fx.ctx(), asAdmin(staff), refund.id, {
      decision: "APPROVE", refundInstrumentId: view.id, stepUpGrantId: await adminGrantFor(fx, staff, `withdrawal:${refund.id}`, `APPROVE:${view.id}`),
    });
    const { providerIdempotencyKey: key } = await dispatchRow(fx, refund.id);
    await setAsset("TEST_EUR", false);
    await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    expect((await withdrawalRow(fx, refund.id)).cancelCode).toBe("SECURITY_LOCKDOWN");
    await drain(fx);
    expect((await dispatchRow(fx, refund.id)).status).toBe("PENDING");
    await setAsset("TEST_EUR", true);
    expect(await dispatchUntilMoved(fx, refund.id, ["PENDING"], 40)).toBe("CANCELLED");
    expect((await withdrawalRow(fx, refund.id)).status).toBe("CANCELLED");
    expect(await created(fx, key)).toBe(0);
  });

  dbTest("the database refuses to take a marked withdrawal forward", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    await ageInstrument(fx, card, 80 * 3_600_000);
    const id = await requestTo(fx, player, card, "20.00");
    await setAsset("TEST_EUR", false);
    await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    await expect(fx.payments.withdrawal.update({ where: { id }, data: { status: "APPROVED", decidedAt: new Date() } })).rejects.toThrow(/PM003|BAD_TRANSITION/);
    await expect(fx.payments.withdrawal.update({ where: { id }, data: { cancelCode: "SOMETHING_ELSE" } })).rejects.toThrow(/PM002|IMMUTABLE_FIELD/);
    const staff = await newAdmin(fx);
    const refused = await refusal(decideWithdrawal(fx.ctx(), asAdmin(staff), id, { decision: "APPROVE", stepUpGrantId: await adminGrantFor(fx, staff, `withdrawal:${id}`, "APPROVE") }));
    expect(refused.code).toBe("INVALID_STATE");
  });

  dbTest("a freeze commits during a stop", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const { id } = await approvedWithdrawal(fx, player, "20.00");
    const staff = await newAdmin(fx);
    const grant = await adminGrantFor(fx, staff, `user:${player.userId}`, "RESTRICT:FROZEN");
    await setAsset("TEST_EUR", false);
    await setRestriction(fx.ctx(), asAdmin(staff), player.userId, { restriction: "FROZEN", reason: "fraud report", stepUpGrantId: grant });
    expect((await compliance(fx, player.userId)).restriction).toBe("FROZEN");
    expect((await withdrawalRow(fx, id)).cancelCode).toBe("ACCOUNT_FROZEN");
    await setAsset("TEST_EUR", true);
    expect(await settleRequestedCancels(fx.ctx(), { userId: player.userId })).toBe(1);
    expect((await withdrawalRow(fx, id)).status).toBe("CANCELLED");
  });

  dbTest("a screening hit commits during a stop, refunds included", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const { id } = await approvedWithdrawal(fx, player, "20.00");
    await setAsset("TEST_EUR", false);
    const ctx = fx.ctx();
    await moneyTx(ctx.db, (tx) => onScreeningHit(tx, ctx, player.userId, "CONFIRMED_MATCH"), { label: "test" });
    expect((await compliance(fx, player.userId)).restriction).toBe("FROZEN");
    expect((await withdrawalRow(fx, id)).cancelCode).toBe("SCREENING_HIT");
  });

  dbTest("a self-exclusion does not depend on the ledger: it is a row of its own, and open deposits close", async (fx) => {
    const player = await newPlayer(fx);
    const { start } = await createDeposit(fx.ctx(), player.caller, await user(fx, player.caller), { method: "CARD", amount: "30.00", saveCard: true, clientRequestId: crypto.randomUUID() });
    await setAsset("TEST_EUR", false);
    await fx.runtime.selfExclusion.create({ data: { userId: player.userId, kind: "INDEFINITE", source: "PLAYER", createdBy: player.userId } });
    const { onSelfExcluded } = await import("../../src/payments/security");
    expect(await onSelfExcluded(fx.ctx(), player.userId)).toBe(1);
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } })).status).toBe("CANCELLED");
  });
});

describe("the safety actions during an administrator's own security hold", () => {
  const hold = (fx: Fixture, player: Player) => fx.runtime.user.update({ where: { id: player.userId }, data: { securityHoldUntil: new Date(Date.now() + 3_600_000) } });

  dbTest("one held administrator can switch a flow off and freeze an account, and it is audited", async (fx) => {
    const staff = await newAdmin(fx);
    await hold(fx, staff);
    await setSwitch(fx.ctx(), asAdmin(staff), { key: "PAYOUT_DISPATCH", enabled: false, reason: "suspected theft", stepUpGrantId: await adminGrantFor(fx, staff, "switch:PAYOUT_DISPATCH", "OFF") });
    expect(await sendsStopped(fx.payments, "TEST_EUR")).toBe(true);
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectType: "SWITCH", subjectId: "PAYOUT_DISPATCH", verb: "SWITCH_OFF", actorUserId: staff.userId } })).toBe(1);
    const player = await newPlayer(fx);
    await setRestriction(fx.ctx(), asAdmin(staff), player.userId, { restriction: "FROZEN", reason: "suspected theft", stepUpGrantId: await adminGrantFor(fx, staff, `user:${player.userId}`, "RESTRICT:FROZEN") });
    expect((await compliance(fx, player.userId)).restriction).toBe("FROZEN");
  });

  dbTest("it still takes a grant, and everything that adds risk stays held", async (fx) => {
    const staff = await newAdmin(fx);
    await hold(fx, staff);
    expect((await refusal(setSwitch(fx.ctx(), asAdmin(staff), { key: "PAYOUT_DISPATCH", enabled: false, reason: "no grant", stepUpGrantId: "none" }))).code).toBe("STEP_UP_REQUIRED");
    expect((await refusal(setSwitch(fx.ctx(), asAdmin(staff), { key: "DEPOSIT_CARD", enabled: true, reason: "turn it on", stepUpGrantId: await adminGrantFor(fx, staff, "switch:DEPOSIT_CARD", "ON") }))).code).toBe("SECURITY_HOLD");
    const player = await newPlayer(fx);
    expect((await refusal(setRestriction(fx.ctx(), asAdmin(staff), player.userId, { restriction: "NONE", reason: "lift it", stepUpGrantId: await adminGrantFor(fx, staff, `user:${player.userId}`, "RESTRICT:NONE") }))).code).toBe("SECURITY_HOLD");
    expect((await refusal(setRestriction(fx.ctx(), asAdmin(staff), player.userId, { restriction: "WITHDRAWALS_MANUAL", reason: "not a stop", stepUpGrantId: await adminGrantFor(fx, staff, `user:${player.userId}`, "RESTRICT:WITHDRAWALS_MANUAL") }))).code).toBe("SECURITY_HOLD");
    // A grant for one action is not a grant for another.
    const other = await mintGrant(fx, staff, { purpose: "admin_payments", bind: await stepUpBind(adminPaymentsAction({ subject: "switch:AUTO_APPROVE", decision: "OFF" })), method: "PASSKEY" });
    expect((await refusal(setSwitch(fx.ctx(), asAdmin(staff), { key: "PAYOUT_DISPATCH", enabled: false, reason: "wrong grant", stepUpGrantId: other }))).code).toBe("STEP_UP_REQUIRED");
  });
});

describe("cross-environment", () => {
  dbTest("a Worker releases only the withdrawals of its own asset, and refuses nothing of the protection", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const { id } = await approvedWithdrawal(fx, player, "20.00");
    await setAsset("TEST_EUR", false);
    await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    await setAsset("TEST_EUR", true);
    await setAsset("EUR", true);
    try {
      const live = fx.ctx();
      const ctx: PaymentsContext = { ...live, config: { ...live.config, settlementAsset: "EUR" } };
      expect(await settleRequestedCancels(ctx)).toBe(0);
      expect((await withdrawalRow(fx, id)).status).toBe("APPROVED");
    } finally {
      await setAsset("EUR", false);
    }
    expect(await settleRequestedCancels(fx.ctx(), { userId: player.userId })).toBe(1);
  });
});

describe("the quote during a stop", () => {
  dbTest("the player is told the payments are paused", async (fx) => {
    const player = await newPlayer(fx);
    await cryptoDeposit(fx, player, "60.00");
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    await setAsset("TEST_EUR", false);
    expect((await refusal(quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: card, amount: "20.00" }))).code).toBe("PAYMENTS_PAUSED");
  });
});
