import { PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { enforceRuntimeRole } from "./runtime-role.js";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/**
 * Columns this version reads, by the migration that adds them. Prisma selects
 * every column of a model, so without them every sign-in, lobby and table
 * request fails while the server itself looks healthy.
 */
const REQUIRED_SCHEMA: { migration: string; probe: () => Promise<unknown> }[] = [
  { migration: "20260924120000_compliance_audit_trail", probe: () => prisma.$queryRaw`SELECT "handUuid", "deckCommitment", "finalStateHash", "auditRecord", "auditSealed" FROM public."Hand" LIMIT 0` },
  { migration: "20261001100000_auth_hardening", probe: () => prisma.$queryRaw`SELECT "usernameCanonical", "failedLoginCount", "lockedUntil", "termsVersion", "termsAcceptedAt", "ageConfirmedAt" FROM public."User" LIMIT 0` },
  { migration: "20261001100000_auth_hardening", probe: () => prisma.$queryRaw`SELECT "lastUsedAt", "absoluteExpiresAt", "previousTokenHash", "rotatedAt", "revokedAt", "revokeReason" FROM public."Session" LIMIT 0` },
  { migration: "20261003100000_game_reliability", probe: () => prisma.$queryRaw`SELECT "pausedAt", "pausedReason" FROM public."Table" LIMIT 0` },
];

/** Postgres "undefined column" or "undefined table", however Prisma reports it. */
function isMissingSchema(cause: unknown): boolean {
  const error = cause as { code?: string; meta?: { code?: string } };
  return error.code === "P2021" || error.code === "P2022" || error.meta?.code === "42703" || error.meta?.code === "42P01";
}

/** Refuse to start when the database is missing migrations this version needs, and name them. */
export async function assertGameSchemaReady(): Promise<void> {
  const missing = new Set<string>();
  let firstCause: unknown;
  for (const { migration, probe } of REQUIRED_SCHEMA) {
    try {
      await probe();
    } catch (cause) {
      if (!isMissingSchema(cause)) throw cause;
      missing.add(migration);
      firstCause ??= cause;
    }
  }
  if (missing.size > 0) {
    throw new Error(`Database is missing migration(s) ${[...missing].join(", ")}. Apply the pending migrations (README, "Database and migrations") before starting the game server.`, { cause: firstCause });
  }
  // After the schema probes: a missing "Hand" is reported as a migration,
  // and an administrator URL is refused only once the table exists to check.
  await enforceRuntimeRole(env.NODE_ENV, async (sql) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql));
}
