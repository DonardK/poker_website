/**
 * The payments Worker's database access (docs/money/WALLET.md sections 3
 * and 9.1). One Prisma client per event over HYPERDRIVE_PAYMENTS (the
 * poker_payments_app login), never cached on globalThis, disconnected after
 * use. Before the first money operation of an isolate the login's role shape
 * is checked: it must be a member of poker_payments, of neither poker_server
 * nor poker_backoffice, unable to call the runtime's ledger entry point, and
 * neither superuser nor BYPASSRLS. A failed check refuses every money call.
 */
import type { PrismaClient } from "../generated/prisma/client";
import { createPrisma } from "../db/client";
import { logError } from "../http/log";
import { PaymentsUnavailable } from "../money/tx";
import type { PaymentsEnv } from "./env";

export class RoleIsolationError extends Error {
  constructor(readonly facts: Record<string, string | boolean>) {
    super("the payments database login is not isolated");
    this.name = "RoleIsolationError";
  }
}

interface RoleRow {
  role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  payments: boolean;
  runtime: boolean;
  backoffice: boolean;
  can_runtime_post: boolean;
  can_payments_post: boolean;
}

let isolationChecked = false;

/** Test hook: forget the per-isolate result. */
export function resetRoleIsolationCache(): void {
  isolationChecked = false;
}

/** The checked facts (also served by GET /health, without secrets). */
export async function readRoleIsolation(db: Pick<PrismaClient, "$queryRaw">): Promise<{ ok: boolean; facts: Record<string, string | boolean> }> {
  const rows = await db.$queryRaw<RoleRow[]>`
    SELECT current_user::text AS role, r.rolsuper, r.rolbypassrls,
           pg_has_role(current_user, 'poker_payments', 'MEMBER') AS payments,
           pg_has_role(current_user, 'poker_server', 'MEMBER') AS runtime,
           pg_has_role(current_user, 'poker_backoffice', 'MEMBER') AS backoffice,
           has_function_privilege(current_user, 'public.ledger_post(text,text,jsonb,jsonb,text)', 'EXECUTE') AS can_runtime_post,
           has_function_privilege(current_user, 'public.ledger_post_payments(text,text,jsonb,jsonb,text)', 'EXECUTE') AS can_payments_post
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
  const row = rows[0];
  if (!row) return { ok: false, facts: { role: "unknown" } };
  const facts = {
    role: row.role, superuser: row.rolsuper, bypassRls: row.rolbypassrls, payments: row.payments, runtime: row.runtime,
    backoffice: row.backoffice, canRuntimePost: row.can_runtime_post, canPaymentsPost: row.can_payments_post,
  };
  const ok = row.payments && row.can_payments_post && !row.runtime && !row.backoffice && !row.can_runtime_post && !row.rolsuper && !row.rolbypassrls;
  return { ok, facts };
}

/** Once per isolate (section 9.1). Throws RoleIsolationError, logged CRITICAL, when the login could reach runtime money. */
export async function assertRoleIsolation(db: Pick<PrismaClient, "$queryRaw">): Promise<void> {
  if (isolationChecked) return;
  const { ok, facts } = await readRoleIsolation(db);
  if (!ok) {
    logError({ alert: "PAYMENTS_ROLE_ISOLATION", severity: "CRITICAL", ...facts }, "payments database login is not isolated; money calls refused");
    throw new RoleIsolationError(facts);
  }
  isolationChecked = true;
}

/** A fresh client for one request, RPC call or alarm. */
export function openPaymentsDb(env: PaymentsEnv): PrismaClient {
  const connectionString = env.HYPERDRIVE_PAYMENTS?.connectionString;
  if (!connectionString) throw new PaymentsUnavailable("db.open", "connection", null);
  return createPrisma(connectionString);
}

/** Run `work` with a client of its own, disconnected afterwards (errors of the disconnect are ignored). */
export async function withPaymentsDb<T>(env: PaymentsEnv, work: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = openPaymentsDb(env);
  try {
    return await work(db);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}
