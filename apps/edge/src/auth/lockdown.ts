import type { Env } from "../env";
import type { AppDb } from "../http/db";
import { logWarn } from "../http/log";
import { issueEmailToken, tokenData, voidEmailTokens, type EmailTokenRow, type IssuedEmailToken } from "./email-tokens";
import { recordSecurityEvent, type RequestFacts } from "./security-events";
import { revokeUserSessions } from "./sessions";

/**
 * "This wasn't me": the owner redeemed the lockdown link of a security notice
 * or a new-sign-in alert. Everything that happened at or after the incident
 * instant (the token's data.incidentAt) is undone, and the account can only
 * be used again after a password reset:
 *
 * 1. every session is revoked (SECURITY_LOCKDOWN);
 * 2. passwordResetRequired is set, credentialsVersion bumps (old MFA tickets
 *    and links die) and withdrawals are held;
 * 3. passkeys removed since the incident come back, then passkeys created
 *    since are soft-removed (this order: one created and removed since ends removed);
 * 4. TOTP enabled since is deleted with its backup codes; TOTP disabled since
 *    is re-enabled; backup codes created since (a regeneration) are deleted;
 * 5. the email goes back to the address this link was mailed to (verified),
 *    when that address is still free: it was the account's verified address
 *    at the incident instant (for an email-change notice, the address it
 *    replaced), so an email change since is undone whichever notice was used;
 * 6. devices first seen since are forgotten, so the next sign-in there alerts again;
 * 7. outstanding reset, email-change and verification links and emailed
 *    step-up codes are voided, and so is every other "This wasn't me" link
 *    sent at or after the incident: those may have gone to an address the
 *    attacker set, and must not undo the owner's recovery later;
 * 8. a fresh 30-minute reset token is issued and returned, so the same page
 *    can set the new password.
 *
 * Passkeys left after this predate the incident, so passkey sign-in stays open.
 * Links sent before the incident stay usable (an earlier change, such as a
 * passkey added before an email change, can still be undone from its own notice).
 */

export interface LockdownOutcome {
  userId: string;
  kind: string;
  revokedSessionIds: string[];
  reset: IssuedEmailToken;
  passkeysRemoved: number;
  passkeysRestored: number;
  totp: "removed" | "restored" | null;
  emailReverted: boolean;
}

interface LockdownUser {
  id: string;
  email: string | null;
  credentialsVersion: number;
}

function incidentInstant(token: EmailTokenRow): Date {
  const raw = tokenData(token).incidentAt;
  const parsed = typeof raw === "string" ? new Date(raw) : new Date(NaN);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(token.createdAt);
}

/** Run inside the transaction that consumed the SECURITY_LOCKDOWN token. */
export async function applyLockdown(tx: AppDb, input: {
  token: EmailTokenRow;
  user: LockdownUser;
  now: Date;
  holdMs: number;
  facts: RequestFacts | null;
}): Promise<LockdownOutcome> {
  const { token, user, now } = input;
  const data = tokenData(token);
  const kind = typeof data.kind === "string" ? data.kind.slice(0, 64) : "UNKNOWN";
  const incidentAt = incidentInstant(token);

  const revokedSessionIds = await revokeUserSessions(tx, user.id, "SECURITY_LOCKDOWN");
  const updated = await tx.user.update({
    where: { id: user.id },
    data: {
      passwordResetRequired: true,
      credentialsVersion: { increment: 1 },
      securityHoldUntil: new Date(now.getTime() + input.holdMs),
      mfaFailedCount: 0,
      mfaLockedUntil: null,
    },
    select: { credentialsVersion: true, email: true },
  }) as { credentialsVersion: number; email: string | null };

  const restored = await tx.webAuthnCredential.updateMany({
    where: { userId: user.id, createdAt: { lt: incidentAt }, removedAt: { gte: incidentAt } },
    data: { removedAt: null },
  });
  const removed = await tx.webAuthnCredential.updateMany({
    where: { userId: user.id, createdAt: { gte: incidentAt }, removedAt: null },
    data: { removedAt: now },
  });

  let totp: LockdownOutcome["totp"] = null;
  const totpRow = await tx.userTotp.findUnique({ where: { userId: user.id } }) as { enabledAt: Date | null; disabledAt: Date | null; createdAt: Date } | null;
  if (totpRow) {
    const enabledAt = totpRow.enabledAt ? new Date(totpRow.enabledAt).getTime() : null;
    const disabledAt = totpRow.disabledAt ? new Date(totpRow.disabledAt).getTime() : null;
    if (enabledAt !== null && enabledAt >= incidentAt.getTime()) {
      await tx.userTotp.deleteMany({ where: { userId: user.id } });
      await tx.userBackupCode.deleteMany({ where: { userId: user.id } });
      totp = "removed";
    } else if (enabledAt === null && new Date(totpRow.createdAt).getTime() >= incidentAt.getTime()) {
      await tx.userTotp.deleteMany({ where: { userId: user.id } });
    } else if (disabledAt !== null && disabledAt >= incidentAt.getTime()) {
      await tx.userTotp.updateMany({ where: { userId: user.id }, data: { disabledAt: null } });
      totp = "restored";
    }
    if (totp !== "removed") await tx.userBackupCode.deleteMany({ where: { userId: user.id, createdAt: { gte: incidentAt } } });
  }

  // The address this link was mailed to, not data.revertEmail: a new-sign-in
  // alert redeemed after an email change must restore the address too.
  let email = updated.email;
  let emailReverted = false;
  const restoreTo = token.email.trim().toLowerCase();
  if (restoreTo && restoreTo !== updated.email) {
    const holder = await tx.user.findUnique({ where: { email: restoreTo }, select: { id: true } }) as { id: string } | null;
    if (!holder) {
      await tx.user.update({ where: { id: user.id }, data: { email: restoreTo, emailVerifiedAt: now }, select: { id: true } });
      email = restoreTo;
      emailReverted = true;
      await recordSecurityEvent(tx, { userId: user.id, type: "EMAIL_CHANGED", facts: input.facts, data: { reverted: true, by: "lockdown" } });
    } else {
      logWarn({ security: "LOCKDOWN_EMAIL_NOT_REVERTED", userId: user.id }, "lockdown could not restore the previous email: another account uses it");
    }
  }

  await tx.knownDevice.deleteMany({ where: { userId: user.id, firstSeenAt: { gte: incidentAt } } });
  await voidEmailTokens(tx, user.id, ["PASSWORD_RESET", "EMAIL_CHANGE", "VERIFY_EMAIL"], now);
  await tx.emailToken.updateMany({
    where: { userId: user.id, purpose: "SECURITY_LOCKDOWN", consumedAt: null, expiresAt: { gt: now }, createdAt: { gte: incidentAt } },
    data: { consumedAt: now },
  });
  await tx.stepUpEmailChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: now } });

  const reset = await issueEmailToken(tx, {
    userId: user.id,
    purpose: "PASSWORD_RESET",
    email: email ?? token.email,
    credentialsVersion: updated.credentialsVersion,
    data: { issuedBy: "lockdown" },
    now,
    ignoreCap: true,
  });
  if (!reset) throw new Error("lockdown reset token was not issued");

  if (totp) await recordSecurityEvent(tx, { userId: user.id, type: "TOTP_CHANGED", facts: input.facts, data: { change: totp, by: "lockdown" } });
  await recordSecurityEvent(tx, {
    userId: user.id,
    type: "NOT_ME_REPORTED",
    facts: input.facts,
    data: {
      kind,
      incidentAt: incidentAt.toISOString(),
      revokedSessions: revokedSessionIds.length,
      passkeysRemoved: removed.count,
      passkeysRestored: restored.count,
      ...(totp ? { totp } : {}),
      ...(emailReverted ? { emailReverted: true } : {}),
    },
  });
  return { userId: user.id, kind, revokedSessionIds, reset, passkeysRemoved: removed.count, passkeysRestored: restored.count, totp, emailReverted };
}

/**
 * Wallet hook: called after every lockdown commits. A no-op until the
 * payments phase wires it to `env.PAYMENTS?.securityLockdown(userId)` (freeze
 * pending withdrawals, invalidate unconsumed step-up grants on their side).
 * Runs after the response; it must not throw and must not use the request's
 * database client.
 */
export async function onAccountLockdown(env: Env, userId: string): Promise<void> {
  void env;
  void userId;
}
