/**
 * Production boot check for the restricted runtime login.
 *
 * The game server must connect as a restricted login: `poker_app` on local
 * docker (a member of NOLOGIN `poker_server`), or `poker_server` itself on
 * the Supabase demo where that role is already LOGIN. An administrator URL
 * in DATABASE_URL would bypass row level security or be able to rewrite hand
 * history. This module does not
 * import Prisma and does not open a connection: pass any executor that runs
 * one SELECT and returns its rows (Prisma, node-postgres, or a Worker
 * Hyperdrive client).
 */

export interface QueryExecutor {
  (sql: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export interface RuntimeRoleFacts {
  currentUser: string;
  superuser: boolean;
  bypassRls: boolean;
  handUpdate: boolean;
  handDelete: boolean;
}

/** One round-trip. Identifiers are quoted so the mixed-case "Hand" table resolves. */
export const RUNTIME_ROLE_PROBE_SQL = `
SELECT
  current_user AS "currentUser",
  r.rolsuper AS "superuser",
  r.rolbypassrls AS "bypassRls",
  has_table_privilege(current_user, 'public."Hand"', 'UPDATE') AS "handUpdate",
  has_table_privilege(current_user, 'public."Hand"', 'DELETE') AS "handDelete"
FROM pg_catalog.pg_roles AS r
WHERE r.rolname = current_user
`.trim();

export class RuntimeRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRoleError";
  }
}

function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  const entries = Object.entries(row);
  for (const name of names) {
    const found = entries.find(([key]) => key === name || key.toLowerCase() === name.toLowerCase());
    if (found) return found[1];
  }
  return undefined;
}

function requireBool(row: Record<string, unknown>, label: string, ...names: string[]): boolean {
  const value = pick(row, ...names);
  if (typeof value === "boolean") return value;
  if (value === "t" || value === "true" || value === "on" || value === 1) return true;
  if (value === "f" || value === "false" || value === "off" || value === 0) return false;
  throw new RuntimeRoleError(`Refusing to start: the role probe did not return ${label}.`);
}

/** Map one probe row. Missing or unreadable fields refuse the boot (fail closed). */
export function runtimeRoleFacts(row: Record<string, unknown> | undefined): RuntimeRoleFacts {
  if (!row) throw new RuntimeRoleError("Refusing to start: the database did not return the current role.");
  const currentUser = pick(row, "currentUser", "current_user");
  if (typeof currentUser !== "string" || currentUser.length === 0) {
    throw new RuntimeRoleError("Refusing to start: the database did not return the current role.");
  }
  return {
    currentUser,
    superuser: requireBool(row, "superuser", "superuser"),
    bypassRls: requireBool(row, "bypassRls", "bypassRls", "bypassrls"),
    handUpdate: requireBool(row, "handUpdate", "handUpdate", "handupdate"),
    handDelete: requireBool(row, "handDelete", "handDelete", "handdelete"),
  };
}

/**
 * Throws unless this login is safe for the game server: not a superuser,
 * no BYPASSRLS, and no UPDATE or DELETE grant on "Hand" (direct or inherited).
 */
export function assertRestrictedRuntimeRole(row: Record<string, unknown> | undefined): void {
  const facts = runtimeRoleFacts(row);
  const problems: string[] = [];
  if (facts.superuser) problems.push("is a superuser");
  if (facts.bypassRls) problems.push("has BYPASSRLS");
  if (facts.handUpdate) problems.push('has UPDATE on "Hand"');
  if (facts.handDelete) problems.push('has DELETE on "Hand"');
  if (problems.length > 0) {
    throw new RuntimeRoleError(
      `Refusing to start: database login "${facts.currentUser}" ${problems.join(", ")}. `
      + "DATABASE_URL must be the runtime login (poker_app, or poker_server on the Supabase demo). Keep the administrator URL in DIRECT_URL for migrations only.",
    );
  }
}

export async function readRuntimeRole(query: QueryExecutor): Promise<Record<string, unknown> | undefined> {
  const rows = await query(RUNTIME_ROLE_PROBE_SQL);
  return rows[0];
}

/**
 * Call during process startup. Outside production this returns without
 * querying, so local docker can still use the volume's superuser.
 */
export async function enforceRuntimeRole(nodeEnv: string, query: QueryExecutor): Promise<void> {
  if (nodeEnv !== "production") return;
  assertRestrictedRuntimeRole(await readRuntimeRole(query));
}
