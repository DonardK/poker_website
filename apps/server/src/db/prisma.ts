import "../config.js";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/** Refuse to accept games when code and hand-history storage are out of sync. */
export async function assertGameSchemaReady(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT "handUuid", "deckCommitment", "finalStateHash", "auditRecord", "auditSealed" FROM public."Hand" LIMIT 0`;
  } catch (cause) {
    const error = cause as { code?: string; meta?: { code?: string } };
    if (error.code !== "P2022" && error.meta?.code !== "42703") throw cause;
    throw new Error("Database is missing the compliance audit columns. Apply migration 20260924120000_compliance_audit_trail before starting the game server.", { cause });
  }
}
