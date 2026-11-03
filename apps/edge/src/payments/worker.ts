/**
 * The poker-payments Worker (apps/edge/wrangler.payments.jsonc;
 * docs/money/WALLET.md section 3). It alone holds the poker_payments_app
 * database login (HYPERDRIVE_PAYMENTS) and the provider secrets:
 * - PaymentsRpc: the typed RPC entrypoint poker-api binds as PAYMENTS. Every
 *   method re-checks its caller (live session, or Access + session + ADMIN
 *   for admin calls) and answers RpcResult, never throws (contract.ts);
 * - fetch: provider webhooks, /health and the sandbox pages (public.ts);
 * - scheduled: the every-minute cron only kicks the PayoutDispatcher, whose
 *   alarm does the work one unit at a time.
 * With PAYMENTS_MODE=off (production today) nothing touches the database:
 * the summary is "off" and every money call is REAL_MONEY_DISABLED.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { prismaRuntime } from "../db/client";
import { errBrief, logWarn } from "../http/log";
import { moneyTx } from "../money/tx";
import * as adminOps from "./admin";
import { lockCompliance, readCompliance } from "./compliance";
import { PaymentsConfigError, type PaymentsActiveConfig } from "./config";
import {
  rpcFail,
  rpcOk,
  type AddCryptoDestinationInput,
  type AdminCaller,
  type AdminWithdrawalDecision,
  type Caller,
  type CreateDepositInput,
  type LockdownReason,
  type LockdownReportInput,
  type NotMeTokenClaims,
  type PageQuery,
  type PaymentsApi,
  type PaymentsHealth,
  type RealMoneyOverview,
  type Replayed,
  type RequestWithdrawalInput,
  type RpcResult,
  type SystemCaller,
} from "./contract";
import type { PaymentsContext } from "./context";
import { readRoleIsolation, withPaymentsDb } from "./db";
import * as deposits from "./deposits";
import type { PaymentsEnv } from "./env";
import { refuse, toRpcFailure } from "./errors";
import { realMoneySummary } from "./gate";
import { listTransactions } from "./history";
import * as instruments from "./instruments";
import { startKyc } from "./kyc";
import { handlePublic } from "./public";
import { kickDispatcher, openRuntime, paymentsConfig } from "./runtime";
import * as security from "./security";
import { verifyCaller, verifySystemTarget, type CallerUser } from "./session";
import * as withdrawals from "./withdrawals";
import type {
  AdminAcceptReactivationRequest,
  AdminAcceptReactivationResponse,
  AdminCustodySnapshotRequest,
  AdminCustodySnapshotResponse,
  AdminDepositResponse,
  AdminDepositsResponse,
  AdminPaymentEventsResponse,
  AdminReactivationsResponse,
  AdminReconciliationIssuesResponse,
  AdminReconciliationRunsResponse,
  AdminRequeueEventRequest,
  AdminResolveDepositRequest,
  AdminResolveIssueRequest,
  AdminResolveUncertainRequest,
  AdminRestoreInstrumentRequest,
  AdminRestoreInstrumentResponse,
  AdminRestrictionResponse,
  AdminScreeningResponse,
  AdminSetRestrictionRequest,
  AdminSetScreeningRequest,
  AdminSetSwitchRequest,
  AdminSetSwitchResponse,
  AdminSwitchesResponse,
  AdminUserLedgerResponse,
  AdminWithdrawalDecisionResponse,
  AdminWithdrawalDetail,
  AdminWithdrawalsResponse,
  DepositStart,
  DepositStatus,
  DepositView,
  InstrumentView,
  KycSessionResponse,
  Page,
  PrepareCryptoDestinationRequest,
  PrepareCryptoDestinationResponse,
  WalletTxView,
  WithdrawalQuoteRequest,
  WithdrawalQuoteResponse,
  WithdrawalStatus,
  WithdrawalView,
} from "@poker/shared";

void prismaRuntime;

export { PayoutDispatcher } from "./actors/payout-dispatcher";
export { SandboxPsp } from "./actors/sandbox-psp";

const OFF = () => rpcFail("REAL_MONEY_DISABLED", "Real-money play is not available yet.");

function lockdownReport(input: LockdownReportInput | undefined): security.LockdownReport | null {
  if (input === undefined) return null;
  const at = new Date(input?.at);
  if (typeof input?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || !Number.isFinite(at.getTime())) refuse("VALIDATION", "Unknown report.");
  const { notice } = input;
  return { id: input.id, at, notice: notice && typeof notice.k === "string" && typeof notice.s === "string" ? { k: notice.k, s: notice.s } : null };
}

export class PaymentsRpc extends WorkerEntrypoint<PaymentsEnv> implements PaymentsApi {
  // The helpers below are JavaScript #private on purpose: Workers RPC exposes
  // every other method of an entrypoint to the binder (TypeScript `private` is
  // compile-time only), and #run takes a callback that receives the payments
  // database client. poker-api may call only the PaymentsApi methods.

  /** The active config, or a failure for mode off / a refused config. */
  #active(label: string): PaymentsActiveConfig | RpcResult<never> {
    try {
      const config = paymentsConfig(this.env);
      return config.mode === "off" ? OFF() : config;
    } catch (error) {
      return toRpcFailure(error, label);
    }
  }

  /** One RPC body: config gate, a context of its own, then the deferred work and disconnect after the answer. */
  async #run<T>(label: string, work: (ctx: PaymentsContext) => Promise<T>): Promise<RpcResult<T>> {
    const config = this.#active(label);
    if ("ok" in config) return config;
    let runtime;
    try {
      runtime = await openRuntime(this.env, config);
    } catch (error) {
      return toRpcFailure(error, label);
    }
    try {
      return rpcOk(await work(runtime.ctx));
    } catch (error) {
      return toRpcFailure(error, label);
    } finally {
      this.ctx.waitUntil(runtime.close());
    }
  }

  #player<T>(label: string, caller: Caller, work: (ctx: PaymentsContext, user: CallerUser) => Promise<T>): Promise<RpcResult<T>> {
    return this.#run(label, async (ctx) => work(ctx, await verifyCaller(ctx.db, caller, ctx.now())));
  }

  #admin<T>(label: string, admin: AdminCaller, work: (ctx: PaymentsContext, user: CallerUser) => Promise<T>): Promise<RpcResult<T>> {
    return this.#run(label, async (ctx) => work(ctx, await adminOps.verifyAdmin(ctx, admin)));
  }

  async health(): Promise<PaymentsHealth> {
    let mode: PaymentsHealth["mode"] = "off";
    let settlementAsset: PaymentsHealth["settlementAsset"] = null;
    try {
      const config = paymentsConfig(this.env);
      mode = config.mode;
      settlementAsset = config.settlementAsset;
    } catch {
      return { ok: false, mode: "off", settlementAsset: null, roleIsolation: false };
    }
    let roleIsolation = false;
    if (this.env.HYPERDRIVE_PAYMENTS) {
      try {
        roleIsolation = (await withPaymentsDb(this.env, (db) => readRoleIsolation(db))).ok;
      } catch (error) {
        logWarn({ ...errBrief(error) }, "payments health could not reach the database");
      }
    }
    return { ok: mode === "off" || roleIsolation, mode, settlementAsset, roleIsolation };
  }

  // -------------------------------------------------------------------------
  // Player
  // -------------------------------------------------------------------------

  async realMoneySummary(caller: Caller): Promise<RpcResult<RealMoneyOverview>> {
    let mode;
    try {
      mode = paymentsConfig(this.env).mode;
    } catch (error) {
      return toRpcFailure(error, "summary");
    }
    if (mode === "off") return rpcOk({ mode: "off", realMoney: null });
    return this.#player("summary", caller, async (ctx, user) => ({ mode: ctx.config.mode, realMoney: await realMoneySummary(ctx, user, caller.ipCountry) }));
  }

  listTransactions(caller: Caller, query: PageQuery): Promise<RpcResult<Page<WalletTxView>>> {
    return this.#player("transactions", caller, (ctx, user) => listTransactions(ctx, user.id, query ?? {}));
  }

  createDeposit(caller: Caller, input: CreateDepositInput): Promise<RpcResult<Replayed<DepositStart>>> {
    return this.#player("deposit.create", caller, async (ctx, user) => {
      const { start, replay } = await deposits.createDeposit(ctx, caller, user, input);
      return { ...start, replay };
    });
  }

  getDeposit(caller: Caller, depositId: string): Promise<RpcResult<DepositView>> {
    return this.#player("deposit.get", caller, (ctx, user) => deposits.getDeposit(ctx, user.id, depositId));
  }

  cancelDeposit(caller: Caller, depositId: string): Promise<RpcResult<DepositView>> {
    return this.#player("deposit.cancel", caller, (ctx, user) => deposits.cancelDeposit(ctx, user.id, depositId));
  }

  listInstruments(caller: Caller): Promise<RpcResult<InstrumentView[]>> {
    return this.#player("instruments.list", caller, (ctx, user) => instruments.listInstruments(ctx, user.id));
  }

  prepareCryptoDestination(caller: Caller, input: PrepareCryptoDestinationRequest): Promise<RpcResult<PrepareCryptoDestinationResponse>> {
    return this.#player("instruments.prepare", caller, async (ctx, user) => {
      const residence = (await readCompliance(ctx.db, user.id)).residenceCountry ?? caller.ipCountry;
      return instruments.prepareCryptoDestination(ctx, user, residence, input);
    });
  }

  addCryptoDestination(caller: Caller, input: AddCryptoDestinationInput): Promise<RpcResult<Replayed<{ instrument: InstrumentView }>>> {
    return this.#player("instruments.add", caller, async (ctx, user) => {
      const residence = (await readCompliance(ctx.db, user.id)).residenceCountry ?? caller.ipCountry;
      const { view, replay } = await instruments.addCryptoDestination(ctx, caller, user, residence, input);
      return { instrument: view, replay };
    });
  }

  revokeInstrument(caller: Caller, instrumentId: string): Promise<RpcResult<null>> {
    return this.#player("instruments.revoke", caller, async (ctx, user) => {
      await instruments.revokeInstrument(ctx, user, instrumentId);
      return null;
    });
  }

  quoteWithdrawal(caller: Caller, input: WithdrawalQuoteRequest): Promise<RpcResult<WithdrawalQuoteResponse>> {
    return this.#player("withdrawal.quote", caller, (ctx, user) => withdrawals.quoteWithdrawal(ctx, user, input));
  }

  requestWithdrawal(caller: Caller, input: RequestWithdrawalInput): Promise<RpcResult<Replayed<{ withdrawal: WithdrawalView }>>> {
    return this.#player("withdrawal.request", caller, async (ctx, user) => {
      const { view, replay } = await withdrawals.requestWithdrawal(ctx, caller, user, input);
      return { withdrawal: view, replay };
    });
  }

  getWithdrawal(caller: Caller, withdrawalId: string): Promise<RpcResult<WithdrawalView>> {
    return this.#player("withdrawal.get", caller, (ctx, user) => withdrawals.getWithdrawal(ctx, user.id, withdrawalId));
  }

  listWithdrawals(caller: Caller, query: PageQuery): Promise<RpcResult<Page<WithdrawalView>>> {
    return this.#player("withdrawal.list", caller, (ctx, user) => withdrawals.listWithdrawals(ctx, user.id, query ?? {}));
  }

  cancelWithdrawal(caller: Caller, withdrawalId: string): Promise<RpcResult<WithdrawalView>> {
    return this.#player("withdrawal.cancel", caller, (ctx, user) => withdrawals.cancelWithdrawal(ctx, user, withdrawalId));
  }

  markLimitsPrompted(caller: Caller): Promise<RpcResult<null>> {
    return this.#player("limits.prompted", caller, async (ctx, user) => {
      await moneyTx(ctx.db, async (tx) => {
        const row = await lockCompliance(tx, user.id);
        if (row.rgLimitsPromptedAt === null) await tx.playerCompliance.update({ where: { userId: user.id }, data: { rgLimitsPromptedAt: ctx.now() } });
      }, { label: "limits.prompted" });
      return null;
    });
  }

  startKyc(caller: Caller): Promise<RpcResult<KycSessionResponse>> {
    return this.#player("kyc.start", caller, (ctx, user) => startKyc(ctx, user, caller.ipCountry));
  }

  onSelfExcluded(caller: Caller): Promise<RpcResult<null>> {
    return this.#player("self-excluded", caller, async (ctx, user) => {
      await security.onSelfExcluded(ctx, user.id);
      return null;
    });
  }

  async securityLockdown(target: SystemCaller, reason: LockdownReason, report?: LockdownReportInput): Promise<RpcResult<null>> {
    // Mode off: nothing can move, so there is nothing to lock down (the auth lockdown already held withdrawals).
    try {
      if (paymentsConfig(this.env).mode === "off") return rpcOk(null);
    } catch (error) {
      return toRpcFailure(error, "security.lockdown");
    }
    return this.#run("security.lockdown", async (ctx) => {
      const user = await verifySystemTarget(ctx.db, target);
      await security.securityLockdown(ctx, user.id, reason === "ADMIN" ? "ADMIN" : "NOT_ME", null, lockdownReport(report));
      return null;
    });
  }

  verifyNotMeToken(token: string): Promise<RpcResult<NotMeTokenClaims>> {
    return this.#run("security.not-me", async (ctx) => {
      const { u, k, s, e } = await security.verifyNotMeToken(ctx, token);
      return { u, k, s, e };
    });
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  adminListWithdrawals(admin: AdminCaller, query: PageQuery & { status?: WithdrawalStatus }): Promise<RpcResult<AdminWithdrawalsResponse>> {
    return this.#admin("admin.withdrawals", admin, (ctx) => adminOps.listWithdrawals(ctx, query ?? {}));
  }

  adminGetWithdrawal(admin: AdminCaller, withdrawalId: string): Promise<RpcResult<AdminWithdrawalDetail>> {
    return this.#admin("admin.withdrawal", admin, (ctx) => adminOps.getWithdrawal(ctx, withdrawalId));
  }

  adminDecideWithdrawal(admin: AdminCaller, withdrawalId: string, input: AdminWithdrawalDecision): Promise<RpcResult<AdminWithdrawalDecisionResponse>> {
    return this.#admin("admin.decide", admin, (ctx) => adminOps.decideWithdrawal(ctx, admin, withdrawalId, input));
  }

  adminResolveUncertain(admin: AdminCaller, withdrawalId: string, input: AdminResolveUncertainRequest): Promise<RpcResult<AdminWithdrawalDecisionResponse>> {
    return this.#admin("admin.resolve-uncertain", admin, (ctx) => adminOps.resolveUncertain(ctx, admin, withdrawalId, input));
  }

  adminListDeposits(admin: AdminCaller, query: PageQuery & { status?: DepositStatus }): Promise<RpcResult<AdminDepositsResponse>> {
    return this.#admin("admin.deposits", admin, (ctx) => adminOps.listDeposits(ctx, query ?? {}));
  }

  adminResolveDeposit(admin: AdminCaller, depositId: string, input: AdminResolveDepositRequest): Promise<RpcResult<AdminDepositResponse>> {
    return this.#admin("admin.deposit.resolve", admin, (ctx) => adminOps.resolveDeposit(ctx, admin, depositId, input));
  }

  adminUserLedger(admin: AdminCaller, userId: string, query: { asset?: string; before?: string; limit?: number }): Promise<RpcResult<AdminUserLedgerResponse>> {
    return this.#admin("admin.ledger", admin, (ctx) => adminOps.userLedger(ctx, userId, query ?? {}));
  }

  adminSetRestriction(admin: AdminCaller, userId: string, input: AdminSetRestrictionRequest): Promise<RpcResult<AdminRestrictionResponse>> {
    return this.#admin("admin.restriction", admin, (ctx) => adminOps.setRestriction(ctx, admin, userId, input));
  }

  adminSetScreening(admin: AdminCaller, userId: string, input: AdminSetScreeningRequest): Promise<RpcResult<AdminScreeningResponse>> {
    return this.#admin("admin.screening", admin, (ctx) => adminOps.setScreening(ctx, admin, userId, input));
  }

  adminRestoreInstrument(admin: AdminCaller, userId: string, instrumentId: string, input: AdminRestoreInstrumentRequest): Promise<RpcResult<AdminRestoreInstrumentResponse>> {
    return this.#admin("admin.instrument.restore", admin, (ctx) => adminOps.restoreInstrument(ctx, admin, userId, instrumentId, input));
  }

  adminListReactivations(admin: AdminCaller, query: PageQuery): Promise<RpcResult<AdminReactivationsResponse>> {
    return this.#admin("admin.reactivations", admin, (ctx) => adminOps.listReactivations(ctx, query ?? {}));
  }

  adminAcceptReactivation(admin: AdminCaller, exclusionId: string, input: AdminAcceptReactivationRequest): Promise<RpcResult<AdminAcceptReactivationResponse>> {
    return this.#admin("admin.reactivation.accept", admin, (ctx) => adminOps.acceptReactivation(ctx, admin, exclusionId, input));
  }

  adminListSwitches(admin: AdminCaller): Promise<RpcResult<AdminSwitchesResponse>> {
    return this.#admin("admin.switches", admin, (ctx) => adminOps.listSwitches(ctx));
  }

  adminSetSwitch(admin: AdminCaller, input: AdminSetSwitchRequest): Promise<RpcResult<AdminSetSwitchResponse>> {
    return this.#admin("admin.switch", admin, (ctx) => adminOps.setSwitch(ctx, admin, input));
  }

  adminListReconciliationRuns(admin: AdminCaller, query: PageQuery): Promise<RpcResult<AdminReconciliationRunsResponse>> {
    return this.#admin("admin.recon.runs", admin, (ctx) => adminOps.listRuns(ctx, query ?? {}));
  }

  adminListReconciliationIssues(admin: AdminCaller, query: PageQuery & { status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" }): Promise<RpcResult<AdminReconciliationIssuesResponse>> {
    return this.#admin("admin.recon.issues", admin, (ctx) => adminOps.listIssues(ctx, query ?? {}));
  }

  adminResolveReconciliationIssue(admin: AdminCaller, issueId: string, input: AdminResolveIssueRequest): Promise<RpcResult<null>> {
    return this.#admin("admin.recon.resolve", admin, (ctx) => adminOps.resolveIssue(ctx, admin, issueId, input));
  }

  adminListEvents(admin: AdminCaller, query: PageQuery & { outcome?: "DEAD" | "NEEDS_REVIEW" | "UNKNOWN_OBJECT" }): Promise<RpcResult<AdminPaymentEventsResponse>> {
    return this.#admin("admin.events", admin, (ctx) => adminOps.listEvents(ctx, query ?? {}));
  }

  adminRequeueEvent(admin: AdminCaller, eventId: string, input: AdminRequeueEventRequest): Promise<RpcResult<null>> {
    return this.#admin("admin.event.requeue", admin, (ctx) => adminOps.requeueEvent(ctx, admin, eventId, input));
  }

  adminCustodySnapshot(admin: AdminCaller, input: AdminCustodySnapshotRequest): Promise<RpcResult<AdminCustodySnapshotResponse>> {
    return this.#admin("admin.custody", admin, (ctx) => adminOps.custodySnapshot(ctx, admin, input));
  }
}

export default {
  fetch(request: Request, env: PaymentsEnv, ctx: ExecutionContext): Promise<Response> {
    return handlePublic(request, env, { waitUntil: (work) => ctx.waitUntil(work) });
  },
  /** "* * * * *": wake the dispatcher (it does the work); nothing at all with PAYMENTS_MODE=off. */
  scheduled(_controller: ScheduledController, env: PaymentsEnv, ctx: ExecutionContext): void {
    let mode;
    try {
      mode = paymentsConfig(env).mode;
    } catch (error) {
      if (error instanceof PaymentsConfigError) logWarn({ alert: "PAYMENTS_CONFIG", problems: error.problems.join("; ").slice(0, 500) }, "payments cron skipped: configuration refused");
      return;
    }
    if (mode === "off") return;
    ctx.waitUntil(kickDispatcher(env));
  },
};
