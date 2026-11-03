import type { Hono } from "hono";
import { z } from "zod";
import { DEPOSIT_STATUSES, WITHDRAWAL_STATUSES } from "../payments/state";
import type { Env } from "../env";
import type { AdminCaller, PageQuery } from "../payments/contract";
import { requireAccess, signedInWithPasskey } from "./admin";
import { authRoute, authed, type Ctx, type GateOk } from "./guard";
import { logWarn } from "./log";
import { callerOf, callPayments, failureResponse } from "./wallet";

/**
 * Payments back office (/api/admin/payments/*, /api/admin/users/:id/*;
 * docs/money/WALLET.md section 11.2). The usual admin guard runs first
 * (Cloudflare Access when configured, a session, User.role = ADMIN, a
 * passkey sign-in when ADMIN_REQUIRE_PASSKEY), plus RL_ADMIN and the admin
 * access log from app.ts. The request then goes to poker-payments as an
 * AdminCaller with the Access JWT, and payments checks all of it again. Every
 * change carries a passkey step-up grant for purpose admin_payments, bound to
 * adminPaymentsAction({ subject, decision }); without one the answer is 403
 * STEP_UP_REQUIRED with the bind to step up for.
 */

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GRANT = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const AMOUNT = z.string().regex(/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/);

const approveBody = z.object({ note: z.string().max(500).optional(), refundInstrumentId: z.string().regex(OBJECT_ID).optional(), stepUpGrantId: GRANT }).strict();
const rejectBody = z.object({ reasonCode: z.string().regex(/^[A-Z0-9_]{2,64}$/), note: z.string().max(500).optional(), stepUpGrantId: GRANT }).strict();
const resolveUncertainBody = z.object({
  outcome: z.enum(["SETTLED", "FAILED"]),
  evidence: z.object({ providerPayoutId: z.string().max(200).optional(), txHash: z.string().max(200).optional(), statementLine: z.string().max(200).optional() }).strict(),
  stepUpGrantId: GRANT,
}).strict();
const resolveDepositBody = z.object({ action: z.enum(["CREDIT", "FAIL"]), creditAmount: AMOUNT.optional(), note: z.string().min(1).max(500), stepUpGrantId: GRANT }).strict();
const restrictionBody = z.object({ restriction: z.enum(["NONE", "DEPOSITS_BLOCKED", "WITHDRAWALS_MANUAL", "FROZEN"]), reason: z.string().min(1).max(200), stepUpGrantId: GRANT }).strict();
const switchBody = z.object({
  key: z.enum(["DEPOSIT_CARD", "DEPOSIT_CRYPTO", "WITHDRAW_CARD", "WITHDRAW_CRYPTO", "PAYOUT_DISPATCH", "AUTO_APPROVE", "NEW_INSTRUMENTS"]),
  enabled: z.boolean(), reason: z.string().min(1).max(200), stepUpGrantId: GRANT,
}).strict();
const screeningBody = z.object({ status: z.enum(["CLEAR", "POTENTIAL_MATCH", "CONFIRMED_MATCH"]), reason: z.string().min(1).max(500), stepUpGrantId: GRANT }).strict();
const restoreBody = z.object({ reason: z.string().min(1).max(200), stepUpGrantId: GRANT }).strict();
const acceptReactivationBody = z.object({ note: z.string().min(1).max(500), stepUpGrantId: GRANT }).strict();
const issueBody = z.object({ status: z.enum(["ACKNOWLEDGED", "RESOLVED"]), resolution: z.string().min(1).max(500), stepUpGrantId: GRANT }).strict();
const requeueBody = z.object({ stepUpGrantId: GRANT }).strict();
const custodyBody = z.object({ asOf: z.string().max(40), segregatedBalance: AMOUNT, source: z.string().min(1).max(200), stepUpGrantId: GRANT }).strict();

type AdminGate = { ok: true; gate: GateOk; admin: AdminCaller } | { ok: false; response: Response };

/** The existing admin guard (admin.ts), then the AdminCaller payments re-verifies. */
async function adminGate(c: Ctx): Promise<AdminGate> {
  const access = await requireAccess(c);
  if (access) return { ok: false, response: access };
  const gate = await authed(c);
  if (!gate.ok) return gate;
  const user = await c.get("db")!.user.findUnique({ where: { id: gate.userId }, select: { role: true } }) as { role: string } | null;
  if (user?.role !== "ADMIN") {
    logWarn({ security: "ADMIN_DENIED", userId: gate.userId, method: c.req.method, path: new URL(c.req.url).pathname.slice(0, 200) }, "admin route denied");
    return { ok: false, response: c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403) };
  }
  if (c.get("config")!.adminRequirePasskey && !signedInWithPasskey(gate)) {
    return { ok: false, response: c.json({ error: "Sign in with a passkey to use admin tools.", code: "ADMIN_PASSKEY_REQUIRED" }, 403) };
  }
  const jwt = c.req.header("Cf-Access-Jwt-Assertion");
  return { ok: true, gate, admin: { ...callerOf(c, gate), accessJwt: jwt && jwt.length <= 8192 ? jwt : null } };
}

function invalid(c: Ctx, message: string): Response {
  return c.json({ error: message, code: "VALIDATION" }, 422);
}

function page(c: Ctx): PageQuery {
  const cursor = c.req.query("cursor");
  const limit = Number(c.req.query("limit"));
  return { ...(cursor && cursor.length <= 200 ? { cursor } : {}), ...(Number.isInteger(limit) && limit >= 1 ? { limit: Math.min(limit, 50) } : {}) };
}

/** One admin route: guard, RPC, the documented failure body, or `ok` with the value. */
function route<T>(handler: (c: Ctx, admin: AdminCaller) => Promise<{ label: string; call: Parameters<typeof callPayments<T>>[2] } | Response>, ok: (c: Ctx, value: T) => Response = (c, value) => c.json(value as object)) {
  return authRoute(async (c) => {
    const guard = await adminGate(c);
    if (!guard.ok) return guard.response;
    const plan = await handler(c, guard.admin);
    if (plan instanceof Response) return plan;
    const result = await callPayments<T>(c, plan.label, plan.call);
    return result.ok ? ok(c, result.value) : failureResponse(c, result);
  });
}

const id = (c: Ctx, name = "id") => c.req.param(name) ?? "";

export function registerAdminPayments(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/admin/payments/withdrawals", route(async (c, admin) => {
    const status = c.req.query("status");
    if (status && !(WITHDRAWAL_STATUSES as readonly string[]).includes(status)) return invalid(c, "Unknown status.");
    return { label: "admin.withdrawals", call: (p) => p.adminListWithdrawals(admin, { ...page(c), ...(status ? { status: status as (typeof WITHDRAWAL_STATUSES)[number] } : {}) }) };
  }));

  app.get("/api/admin/payments/withdrawals/:id", route(async (c, admin) => {
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    return { label: "admin.withdrawal", call: (p) => p.adminGetWithdrawal(admin, id(c)) };
  }));

  app.post("/api/admin/payments/withdrawals/:id/approve", route(async (c, admin) => {
    const parsed = approveBody.safeParse(c.get("jsonBody"));
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Confirm with your passkey.");
    return { label: "admin.approve", call: (p) => p.adminDecideWithdrawal(admin, id(c), { decision: "APPROVE", ...parsed.data }) };
  }));

  app.post("/api/admin/payments/withdrawals/:id/reject", route(async (c, admin) => {
    const parsed = rejectBody.safeParse(c.get("jsonBody"));
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Give a reason code such as AML_CONCERN and confirm with your passkey.");
    return { label: "admin.reject", call: (p) => p.adminDecideWithdrawal(admin, id(c), { decision: "REJECT", ...parsed.data }) };
  }));

  app.post("/api/admin/payments/withdrawals/:id/resolve-uncertain", route(async (c, admin) => {
    const parsed = resolveUncertainBody.safeParse(c.get("jsonBody"));
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Choose the outcome, attach the evidence and confirm with your passkey.");
    return { label: "admin.resolve-uncertain", call: (p) => p.adminResolveUncertain(admin, id(c), parsed.data) };
  }));

  app.get("/api/admin/payments/deposits", route(async (c, admin) => {
    const status = c.req.query("status");
    if (status && !(DEPOSIT_STATUSES as readonly string[]).includes(status)) return invalid(c, "Unknown status.");
    return { label: "admin.deposits", call: (p) => p.adminListDeposits(admin, { ...page(c), ...(status ? { status: status as (typeof DEPOSIT_STATUSES)[number] } : {}) }) };
  }));

  app.post("/api/admin/payments/deposits/:id/resolve", route(async (c, admin) => {
    const parsed = resolveDepositBody.safeParse(c.get("jsonBody"));
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Choose CREDIT (with the amount) or FAIL, explain why and confirm with your passkey.");
    return { label: "admin.deposit.resolve", call: (p) => p.adminResolveDeposit(admin, id(c), parsed.data) };
  }));

  app.get("/api/admin/users/:userId/ledger", route(async (c, admin) => {
    const userId = id(c, "userId");
    if (!USER_ID.test(userId)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    const asset = c.req.query("asset");
    const before = c.req.query("before");
    const limit = Number(c.req.query("limit"));
    return {
      label: "admin.ledger",
      call: (p) => p.adminUserLedger(admin, userId, {
        ...(asset && /^[A-Z0-9_]{2,20}$/.test(asset) ? { asset } : {}), ...(before && /^\d{1,19}$/.test(before) ? { before } : {}),
        ...(Number.isInteger(limit) && limit >= 1 ? { limit: Math.min(limit, 100) } : {}),
      }),
    };
  }));

  app.post("/api/admin/users/:userId/payments-restriction", route(async (c, admin) => {
    const userId = id(c, "userId");
    const parsed = restrictionBody.safeParse(c.get("jsonBody"));
    if (!USER_ID.test(userId)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Choose the restriction, give the reason and confirm with your passkey.");
    return { label: "admin.restriction", call: (p) => p.adminSetRestriction(admin, userId, parsed.data) };
  }));

  app.post("/api/admin/users/:userId/screening", route(async (c, admin) => {
    const userId = id(c, "userId");
    const parsed = screeningBody.safeParse(c.get("jsonBody"));
    if (!USER_ID.test(userId)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Choose CLEAR, POTENTIAL_MATCH or CONFIRMED_MATCH, give the reason and confirm with your passkey.");
    return { label: "admin.screening", call: (p) => p.adminSetScreening(admin, userId, parsed.data) };
  }));

  app.post("/api/admin/users/:userId/instruments/:id/restore", route(async (c, admin) => {
    const userId = id(c, "userId");
    const parsed = restoreBody.safeParse(c.get("jsonBody"));
    if (!USER_ID.test(userId) || !OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Give the reason and confirm with your passkey.");
    return { label: "admin.instrument.restore", call: (p) => p.adminRestoreInstrument(admin, userId, id(c), parsed.data) };
  }));

  app.get("/api/admin/payments/self-exclusions", route(async (c, admin) => ({ label: "admin.reactivations", call: (p) => p.adminListReactivations(admin, page(c)) })));

  app.post("/api/admin/payments/self-exclusions/:id/accept", route(async (c, admin) => {
    const parsed = acceptReactivationBody.safeParse(c.get("jsonBody"));
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Explain the decision and confirm with your passkey.");
    return { label: "admin.reactivation.accept", call: (p) => p.adminAcceptReactivation(admin, id(c), parsed.data) };
  }));

  app.get("/api/admin/payments/switches", route(async (_c, admin) => ({ label: "admin.switches", call: (p) => p.adminListSwitches(admin) })));

  app.post("/api/admin/payments/switches", route(async (c, admin) => {
    const parsed = switchBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Choose the switch and its state, give the reason and confirm with your passkey.");
    return { label: "admin.switch", call: (p) => p.adminSetSwitch(admin, parsed.data) };
  }));

  app.get("/api/admin/payments/reconciliation/runs", route(async (c, admin) => ({ label: "admin.recon.runs", call: (p) => p.adminListReconciliationRuns(admin, page(c)) })));

  app.get("/api/admin/payments/reconciliation/issues", route(async (c, admin) => {
    const status = c.req.query("status");
    if (status && !["OPEN", "ACKNOWLEDGED", "RESOLVED"].includes(status)) return invalid(c, "Unknown status.");
    return { label: "admin.recon.issues", call: (p) => p.adminListReconciliationIssues(admin, { ...page(c), ...(status ? { status: status as "OPEN" } : {}) }) };
  }));

  app.post("/api/admin/payments/reconciliation/issues/:id/resolve", route(async (c, admin) => {
    const parsed = issueBody.safeParse(c.get("jsonBody"));
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Choose the status, describe the resolution and confirm with your passkey.");
    return { label: "admin.recon.resolve", call: (p) => p.adminResolveReconciliationIssue(admin, id(c), parsed.data) };
  }, (c) => c.json({ ok: true })));

  app.get("/api/admin/payments/events", route(async (c, admin) => {
    const outcome = c.req.query("outcome");
    if (outcome && !["DEAD", "NEEDS_REVIEW", "UNKNOWN_OBJECT"].includes(outcome)) return invalid(c, "Unknown outcome.");
    return { label: "admin.events", call: (p) => p.adminListEvents(admin, { ...page(c), ...(outcome ? { outcome: outcome as "DEAD" } : {}) }) };
  }));

  app.post("/api/admin/payments/events/:id/requeue", route(async (c, admin) => {
    const parsed = requeueBody.safeParse(c.get("jsonBody"));
    if (!OBJECT_ID.test(id(c))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!parsed.success) return invalid(c, "Confirm with your passkey.");
    return { label: "admin.event.requeue", call: (p) => p.adminRequeueEvent(admin, id(c), parsed.data) };
  }, (c) => c.json({ ok: true })));

  app.post("/api/admin/payments/custody-snapshot", route(async (c, admin) => {
    const parsed = custodyBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Enter when the balance was read, the balance like 123456.78, its source, and confirm with your passkey.");
    return { label: "admin.custody", call: (p) => p.adminCustodySnapshot(admin, parsed.data) };
  }));
}
