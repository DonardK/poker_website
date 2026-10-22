import type { EmailChangedResponse, EmailVerifiedResponse, LockdownResponse } from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import {
  consumeEmailToken, emailCapReached, findEmailToken, issueEmailToken, tokenData, voidEmailTokens, type EmailTokenRow,
} from "../auth/email-tokens";
import { uniqueViolation } from "../auth/errors";
import { applyLockdown, onAccountLockdown } from "../auth/lockdown";
import { newPasswordSchema } from "../auth/password-policy";
import { passwords } from "../auth/password";
import { recordSecurityEvent, type RequestFacts } from "../auth/security-events";
import { revokeUserSessions } from "../auth/sessions";
import { emailLink, linkMail, prepareNotice, sendMail } from "../mail/notify";
import { passwordReset } from "../mail/templates";
import { mailer, mailUnavailable } from "../mail/transport";
import { rejectPassword } from "./auth";
import type { AppDb } from "./db";
import { defer } from "./defer";
import { authRoute, Refusal, requestFacts, turnstileGate, type Ctx } from "./guard";
import { logWarn } from "./log";
import { fanoutRevoke } from "./realtime";
import { withOwnDb } from "./request-db";
import { clearSessionCookies, type AccountUser } from "./session-issue";

/**
 * Recovery by email: forgot / reset password, email verification, email
 * change confirmation, and "This wasn't me" (lockdown). Every token arrives
 * in a POST body (the link puts it in the URL fragment), so a mail scanner
 * that fetches the link triggers nothing.
 */

const TOKEN_INVALID = { error: "This link is invalid or has expired.", code: "TOKEN_INVALID" } as const;
const tokenBody = z.object({ token: z.string().min(1).max(128) });

function invalidLink(): Refusal {
  return new Refusal(400, { ...TOKEN_INVALID });
}

function usableAccount(user: AccountUser | null): user is AccountUser {
  return user !== null && user.kind === "HUMAN" && !user.isGuest;
}

/** Forgot password, deferred part: cap, token, event and mail (the route already answered 202). */
async function sendResetLink(c: Ctx, db: AppDb, user: AccountUser, facts: RequestFacts, now: Date): Promise<void> {
  const config = c.get("config")!;
  if (await emailCapReached(db, user.id, "PASSWORD_RESET", now)) {
    logWarn({ security: "RESET_CAP_REACHED", userId: user.id }, "password reset not sent: hourly cap reached");
    return;
  }
  const mail = await db.$transaction(async (tx) => {
    await voidEmailTokens(tx, user.id, ["PASSWORD_RESET"], now);
    const issued = await issueEmailToken(tx, { userId: user.id, purpose: "PASSWORD_RESET", email: user.email!, credentialsVersion: user.credentialsVersion, now, ignoreCap: true });
    await recordSecurityEvent(tx, { userId: user.id, type: "PASSWORD_RESET_REQUESTED", facts });
    const link = emailLink(config, "PASSWORD_RESET", issued!.token);
    return linkMail("PASSWORD_RESET", user.email!, user.id, issued!, link, passwordReset({ username: user.username, link }));
  });
  if (mailUnavailable(c.env, config)) logWarn({ mail: "DISABLED", kind: "PASSWORD_RESET", userId: user.id }, "password reset requested but email is not configured");
  // Already deferred: send directly (a nested waitUntil is not needed).
  await mailer.send(c.env, config, mail);
}

/** POST /api/auth/email/change/confirm: the link sent to the new address. */
async function confirmEmailChange(c: Ctx, token: string): Promise<Response> {
  const db = c.get("db")!;
  const config = c.get("config")!;
  const facts = requestFacts(c);
  const now = new Date();
  try {
    const done = await db.$transaction(async (tx) => {
      const row = await consumeEmailToken(tx, token, "EMAIL_CHANGE", now);
      if (!row) throw invalidLink();
      const user = await tx.user.findUnique({ where: { id: row.userId } }) as AccountUser | null;
      const previousEmail = tokenData(row).previousEmail ?? null;
      if (!usableAccount(user) || user.credentialsVersion !== row.credentialsVersion || (user.email ?? null) !== previousEmail) throw invalidLink();
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { email: row.email, emailVerifiedAt: now, credentialsVersion: { increment: 1 }, securityHoldUntil: new Date(now.getTime() + config.securityHoldMs) },
      }) as AccountUser;
      await voidEmailTokens(tx, user.id, ["EMAIL_CHANGE", "VERIFY_EMAIL"], now);
      await recordSecurityEvent(tx, { userId: user.id, type: "EMAIL_CHANGED", facts, data: { hadPrevious: previousEmail !== null } });
      // The old address (if it was verified) learns of the change and can revert it.
      const notice = user.email
        ? await prepareNotice(tx, config, user, "EMAIL_CHANGE_NOTICE", {
          now, to: user.email, data: { revertEmail: user.email }, details: { newEmail: row.email, stage: "changed" },
        })
        : null;
      return { email: updated.email!, notice };
    });
    await sendMail(c, done.notice);
    const body: EmailChangedResponse = { email: done.email };
    return c.json(body);
  } catch (err) {
    if (uniqueViolation(err)) return c.json({ error: "This email can't be used.", code: "EMAIL_UNAVAILABLE" }, 409);
    throw err;
  }
}

export function registerAuthRecovery(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/auth/password/forgot", authRoute(async (c) => {
    const turned = await turnstileGate(c);
    if (turned) return turned;
    const parsed = z.object({ email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()) }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const db = c.get("db")!;
    const user = await db.user.findUnique({ where: { email: parsed.data.email } }) as AccountUser | null;
    if (usableAccount(user) && user.passwordHash && user.email) {
      // After the response, on a client of its own: before the 202 a real
      // account costs the same single lookup as an unknown address, so the
      // answer's timing does not tell them apart either.
      const facts = requestFacts(c);
      const now = new Date();
      await defer(c, withOwnDb(c.env, (own) => sendResetLink(c, own, user, facts, now)));
    }
    // Same answer whether or not the address has an account.
    return c.json({ ok: true }, 202);
  }));

  app.post("/api/auth/password/reset", authRoute(async (c) => {
    const parsed = z.object({ token: z.string().min(1).max(128), newPassword: newPasswordSchema }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const db = c.get("db")!;
    const config = c.get("config")!;
    const facts = requestFacts(c);
    const now = new Date();
    const peek = await findEmailToken(db, parsed.data.token);
    const live = (row: EmailTokenRow | null): row is EmailTokenRow =>
      row !== null && row.purpose === "PASSWORD_RESET" && row.consumedAt == null && new Date(row.expiresAt).getTime() > now.getTime();
    if (!live(peek)) return c.json(TOKEN_INVALID, 400);
    const owner = await db.user.findUnique({ where: { id: peek.userId } }) as AccountUser | null;
    const current = (user: AccountUser | null, row: EmailTokenRow): user is AccountUser =>
      usableAccount(user) && (row.credentialsVersion === user.credentialsVersion || tokenData(row).issuedBy === "lockdown");
    if (!current(owner, peek)) return c.json(TOKEN_INVALID, 400);
    // Checked before the token is consumed: a weak password does not burn the link.
    const weak = await rejectPassword(c, parsed.data.newPassword, owner.username);
    if (weak) return weak;
    const passwordHash = await passwords.hash(parsed.data.newPassword, config.passwordPbkdf2Iterations);
    const done = await db.$transaction(async (tx) => {
      const row = await consumeEmailToken(tx, parsed.data.token, "PASSWORD_RESET", now);
      if (!row) throw invalidLink();
      const user = await tx.user.findUnique({ where: { id: row.userId } }) as AccountUser | null;
      if (!current(user, row)) throw invalidLink();
      const updated = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          passwordResetRequired: false,
          credentialsVersion: { increment: 1 },
          failedLoginCount: 0,
          lockedUntil: null,
          mfaFailedCount: 0,
          mfaLockedUntil: null,
          securityHoldUntil: new Date(now.getTime() + config.securityHoldMs),
          ...(user.emailVerifiedAt == null && user.email === row.email ? { emailVerifiedAt: now } : {}),
        },
      }) as AccountUser;
      const revoked = await revokeUserSessions(tx, user.id, "PASSWORD_CHANGED");
      await voidEmailTokens(tx, user.id, ["PASSWORD_RESET"], now);
      await recordSecurityEvent(tx, { userId: user.id, type: "PASSWORD_RESET", facts, data: { revokedSessions: revoked.length } });
      const notice = await prepareNotice(tx, config, updated, "PASSWORD_CHANGED", { now, details: { how: "reset" } });
      return { userId: user.id, revoked, notice };
    });
    await fanoutRevoke(c.env, done.userId, done.revoked, "PASSWORD_CHANGED");
    clearSessionCookies(c);
    await sendMail(c, done.notice);
    // Nobody is signed in: the user signs in with the new password (and TOTP, if on).
    return c.body(null, 204);
  }));

  app.post("/api/auth/email/verify", authRoute(async (c) => {
    const parsed = tokenBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const db = c.get("db")!;
    const now = new Date();
    const facts = requestFacts(c);
    await db.$transaction(async (tx) => {
      const row = await consumeEmailToken(tx, parsed.data.token, "VERIFY_EMAIL", now);
      if (!row) throw invalidLink();
      const user = await tx.user.findUnique({ where: { id: row.userId } }) as AccountUser | null;
      if (!usableAccount(user) || user.email !== row.email) throw invalidLink();
      if (user.emailVerifiedAt == null) {
        await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now }, select: { id: true } });
        await recordSecurityEvent(tx, { userId: user.id, type: "EMAIL_VERIFIED", facts });
      }
    });
    const body: EmailVerifiedResponse = { emailVerified: true };
    return c.json(body);
  }));

  app.post("/api/auth/email/change/confirm", authRoute(async (c) => {
    const parsed = tokenBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    return confirmEmailChange(c, parsed.data.token);
  }));

  app.post("/api/auth/security/lockdown", authRoute(async (c) => {
    const parsed = tokenBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const db: AppDb = c.get("db")!;
    const config = c.get("config")!;
    const facts = requestFacts(c);
    const now = new Date();
    const outcome = await db.$transaction(async (tx) => {
      const token = await consumeEmailToken(tx, parsed.data.token, "SECURITY_LOCKDOWN", now);
      if (!token) throw invalidLink();
      const user = await tx.user.findUnique({ where: { id: token.userId } }) as AccountUser | null;
      if (!user || user.kind !== "HUMAN") throw invalidLink();
      return applyLockdown(tx, { token, user, now, holdMs: config.securityHoldMs, facts });
    });
    await fanoutRevoke(c.env, outcome.userId, outcome.revokedSessionIds, "SECURITY_LOCKDOWN");
    await defer(c, onAccountLockdown(c.env, outcome.userId));
    logWarn({
      security: "ACCOUNT_LOCKDOWN",
      userId: outcome.userId,
      kind: outcome.kind,
      revokedSessions: outcome.revokedSessionIds.length,
      passkeysRemoved: outcome.passkeysRemoved,
      passkeysRestored: outcome.passkeysRestored,
      totp: outcome.totp,
      emailReverted: outcome.emailReverted,
    }, "SECURITY EVENT: the owner reported unauthorised activity; the account was locked down");
    clearSessionCookies(c);
    const body: LockdownResponse = { secured: true, resetToken: outcome.reset.token, expiresAt: outcome.reset.expiresAt.toISOString() };
    return c.json(body);
  }));
}
