import type { Env } from "../env";
import { createPrisma } from "../db/client";
import { errBrief, logError, logInfo } from "../http/log";

/**
 * Daily housekeeping for the account-security tables (cron in wrangler.jsonc).
 * Only rows that can no longer matter are deleted:
 * - AuthNonce: single-use marks an hour after their ticket expired;
 * - EmailToken: links 30 days after they expired (lockdown links live 7 days);
 * - UserTotp: authenticator setups never confirmed within a day;
 * - WebAuthnCredential: passkeys removed more than 30 days ago (a lockdown
 *   can only restore removals from the last 7 days);
 * - StepUpEmailChallenge: emailed step-up codes a day after they expired.
 *
 * AccountSecurityEvent is append-only for every role; its retention is an
 * operator job (poker.break_glass), not this sweep.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type DeleteMany = (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;

export interface SweepDb {
  authNonce: { deleteMany: DeleteMany };
  emailToken: { deleteMany: DeleteMany };
  userTotp: { deleteMany: DeleteMany };
  webAuthnCredential: { deleteMany: DeleteMany };
  stepUpEmailChallenge: { deleteMany: DeleteMany };
}

export async function sweep(db: SweepDb, now: Date): Promise<Record<string, number>> {
  const at = (ms: number) => new Date(now.getTime() - ms);
  return {
    authNonces: (await db.authNonce.deleteMany({ where: { expiresAt: { lt: at(HOUR) } } })).count,
    emailTokens: (await db.emailToken.deleteMany({ where: { expiresAt: { lt: at(30 * DAY) } } })).count,
    pendingTotp: (await db.userTotp.deleteMany({ where: { enabledAt: null, createdAt: { lt: at(DAY) } } })).count,
    removedPasskeys: (await db.webAuthnCredential.deleteMany({ where: { removedAt: { lt: at(30 * DAY) } } })).count,
    stepUpEmailCodes: (await db.stepUpEmailChallenge.deleteMany({ where: { expiresAt: { lt: at(DAY) } } })).count,
  };
}

/** The scheduled handler's work: one Prisma client, disconnected afterwards. Never throws. */
export async function runSweep(env: Env, now = new Date()): Promise<void> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    logError({ job: "SWEEP" }, "account-security sweep skipped: no database binding");
    return;
  }
  const prisma = createPrisma(connectionString);
  try {
    const deleted = await sweep(prisma as unknown as SweepDb, now);
    logInfo({ job: "SWEEP", ...deleted }, "account-security sweep finished");
  } catch (err) {
    logError({ job: "SWEEP", ...errBrief(err) }, "account-security sweep failed");
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
