import type {
  AccountSecurity, BackupCodesResponse, ChangeEmailResponse, ChangePasswordResponse, KnownDeviceSummary, PasskeySummary,
  SecurityEventSummary, SecurityEventType, TotpSetupResponse,
} from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { randomToken } from "../auth/bytes";
import { deviceLabel, readDevice } from "../auth/devices";
import { emailCapReached, EMAIL_TOKEN_CAP, issueEmailToken, voidEmailTokens } from "../auth/email-tokens";
import { includesSecondFactor } from "../auth/factors";
import { remainingBackupCodes, replaceBackupCodes } from "../auth/backup-codes";
import { newPasswordSchema } from "../auth/password-policy";
import { passwords } from "../auth/password";
import { recordSecurityEvent } from "../auth/security-events";
import { revokeUserSessions } from "../auth/sessions";
import { requireStepUp, stepUpUntil } from "../auth/step-up";
import { consumeNonce, nonceExpiry, signChallenge, verifyChallenge } from "../auth/tickets";
import { matchTotp, newTotpSecret, openTotpSecret, otpauthUri, sealTotpSecret, totpActive, TOTP_PENDING_TTL_MS, type TotpRow } from "../auth/totp";
import { registrationOptions, verifyRegistration } from "../auth/webauthn";
import { emailLink, linkMail, prepareNotice, sendMail } from "../mail/notify";
import { emailChangeConfirm, emailInUse, verifyEmail } from "../mail/templates";
import { mailUnavailable, type MailMessage } from "../mail/transport";
import { rejectPassword, securityNotConfigured } from "./auth";
import { CHALLENGE_INVALID, passkeySetup, passkeysUnavailable, PASSKEY_INVALID, type PasskeyRow } from "./auth-passkey";
import type { AppDb } from "./db";
import { authRoute, authed, Refusal, requestFacts, type Ctx, type GateOk } from "./guard";
import { logWarn } from "./log";
import { fanoutRevoke } from "./realtime";
import { clearSessionCookies, type AccountUser } from "./session-issue";

/**
 * The signed-in account's security settings (/api/account/*): the security
 * overview and history, known devices, password and email change, TOTP and
 * backup codes, and passkeys.
 *
 * Every change to a credential or a factor needs a fresh step-up (the
 * session window, auth/step-up.ts), is written with its security event in
 * one transaction, and sends a notice with a "This wasn't me" link to a
 * verified address. Changes are written with the application clock `now`
 * that the notice also carries, so a lockdown undoes exactly what happened
 * at or after it.
 */

export const PASSKEY_LIMIT = 20;
const EVENTS_PAGE_DEFAULT = 20;
const EVENTS_PAGE_MAX = 50;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const passkeyName = z.string().trim().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

function iso(value: Date | string | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function toPasskeySummary(row: PasskeyRow): PasskeySummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.createdAt).toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    backedUp: row.backedUp,
    deviceType: row.deviceType === "multiDevice" ? "multiDevice" : "singleDevice",
    transports: row.transports ?? [],
  };
}

async function activePasskeys(db: AppDb, userId: string): Promise<PasskeyRow[]> {
  return db.webAuthnCredential.findMany({ where: { userId, removedAt: null }, orderBy: { createdAt: "asc" } }) as Promise<PasskeyRow[]>;
}

/** The current user row (the gate's copy may be a request old; changes re-read it inside their transaction). */
async function loadUser(db: AppDb, userId: string): Promise<AccountUser> {
  const user = await db.user.findUnique({ where: { id: userId } }) as AccountUser | null;
  if (!user) throw new Refusal(401, { error: "Unauthorized" });
  return user;
}

function holdUntil(now: Date, holdMs: number): Date {
  return new Date(now.getTime() + holdMs);
}

/**
 * A new TOTP or passkey enrolled by a session whose step-up had no second
 * factor (a password-only account, or a passkey account signed in with its
 * password) holds withdrawals, as a password change does. Otherwise someone
 * with only the password could swap the emailed-code money proof for a
 * factor of their own and withdraw at once; the hold gives the owner time to
 * act on the notice ("This wasn't me" removes the factor).
 */
function enrolmentHold(gate: GateOk, now: Date, holdMs: number): { securityHoldUntil?: Date } {
  if (includesSecondFactor(gate.session.reauthMethods ?? [])) return {};
  return { securityHoldUntil: holdUntil(now, holdMs) };
}

function idParam(c: Ctx): string | null {
  const id = c.req.param("id") ?? "";
  return ID.test(id) ? id : null;
}

/** A step-up gate for the account routes: authenticated, then a fresh step-up (with the options given). */
async function steppedUp(c: Ctx, opts: { needPassword?: boolean } = {}): Promise<{ gate: GateOk } | { response: Response }> {
  const gate = await authed(c);
  if (!gate.ok) return { response: gate.response };
  const refused = await requireStepUp(c, gate, opts);
  return refused ? { response: refused } : { gate };
}

export function registerAccount(app: Hono<{ Bindings: Env }>): void {
  // ---------------------------------------------------------------------------
  // Overview, history and devices
  // ---------------------------------------------------------------------------

  app.get("/api/account/security", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const db = c.get("db")!;
    const config = c.get("config")!;
    const now = new Date();
    const user = await loadUser(db, gate.userId);
    const [totp, passkeys, backupCodes, pending] = await Promise.all([
      db.userTotp.findUnique({ where: { userId: user.id } }) as Promise<TotpRow | null>,
      activePasskeys(db, user.id),
      remainingBackupCodes(db, user.id),
      db.emailToken.findFirst({
        where: { userId: user.id, purpose: "EMAIL_CHANGE", consumedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        select: { email: true },
      }) as Promise<{ email: string } | null>,
    ]);
    const enabled = totpActive(totp);
    const hold = user.securityHoldUntil != null && new Date(user.securityHoldUntil).getTime() > now.getTime() ? user.securityHoldUntil : null;
    const body: AccountSecurity = {
      email: user.email,
      emailVerified: user.emailVerifiedAt != null,
      pendingEmail: pending?.email ?? null,
      passwordChangedAt: iso(user.passwordChangedAt),
      totp: { enabled, enabledAt: enabled ? iso(totp!.enabledAt) : null, backupCodesRemaining: enabled ? backupCodes : 0 },
      passkeys: passkeys.map(toPasskeySummary),
      stepUpUntil: iso(stepUpUntil(gate.session, now.getTime())),
      securityHoldUntil: iso(hold),
      capabilities: { email: config.mail.transport === "resend", passkeys: config.webauthn !== null, totp: config.security !== null },
    };
    return c.json(body);
  }));

  app.get("/api/account/events", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const query = z.object({
      before: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_MAX).optional(),
    }).safeParse({ before: c.req.query("before") || undefined, limit: c.req.query("limit") || undefined });
    if (!query.success) return c.json({ error: "Invalid query" }, 400);
    const limit = query.data.limit ?? EVENTS_PAGE_DEFAULT;
    const rows = await c.get("db")!.accountSecurityEvent.findMany({
      where: { userId: gate.userId, ...(query.data.before ? { createdAt: { lt: new Date(query.data.before) } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      select: { id: true, type: true, createdAt: true, ip: true, country: true, userAgent: true, data: true },
    }) as { id: string; type: SecurityEventType; createdAt: Date; ip: string | null; country: string | null; userAgent: string | null; data: unknown }[];
    const page = rows.slice(0, limit);
    const events: SecurityEventSummary[] = page.map((row) => ({
      id: row.id,
      type: row.type,
      createdAt: new Date(row.createdAt).toISOString(),
      ip: row.ip,
      country: row.country,
      userAgent: row.userAgent,
      data: row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Record<string, unknown> : {},
    }));
    return c.json({ events, next: rows.length > limit ? events[events.length - 1]!.createdAt : null });
  }));

  app.get("/api/account/devices", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    // The poker_device cookie is scoped to /api/auth, so "this browser" is the session's own device.
    const cookieDevice = await readDevice(c.req.header("cookie"));
    const rows = await c.get("db")!.knownDevice.findMany({
      where: { userId: gate.userId },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, deviceHash: true, label: true, country: true, lastIp: true, firstSeenAt: true, lastSeenAt: true },
    }) as { id: string; deviceHash: string; label: string | null; country: string | null; lastIp: string | null; firstSeenAt: Date; lastSeenAt: Date }[];
    const devices: KnownDeviceSummary[] = rows.map((row) => ({
      id: row.id,
      label: row.label,
      country: row.country,
      ip: row.lastIp,
      firstSeenAt: new Date(row.firstSeenAt).toISOString(),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      current: row.id === gate.session.deviceId || (cookieDevice !== null && row.deviceHash === cookieDevice.hash),
    }));
    return c.json({ devices });
  }));

  app.delete("/api/account/devices/:id", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = idParam(c);
    const db = c.get("db")!;
    const device = id ? await db.knownDevice.findFirst({ where: { id, userId: gate.userId }, select: { id: true, label: true } }) as { id: string; label: string | null } | null : null;
    if (!device) return c.json({ error: "Device not found" }, 404);
    const revoked = await db.$transaction(async (tx) => {
      const ended = await tx.session.updateManyAndReturn({
        where: { userId: gate.userId, deviceId: device.id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "SESSION_REVOKED" },
        select: { id: true },
      }) as { id: string }[];
      await tx.knownDevice.deleteMany({ where: { id: device.id, userId: gate.userId } });
      await recordSecurityEvent(tx, {
        userId: gate.userId,
        type: "DEVICE_FORGOTTEN",
        sessionId: gate.sessionId,
        facts: requestFacts(c),
        data: { label: device.label, revokedSessions: ended.length },
      });
      return ended.map((row) => row.id);
    });
    await fanoutRevoke(c.env, gate.userId, revoked, "SESSION_REVOKED");
    if (device.id === gate.session.deviceId || revoked.includes(gate.sessionId)) clearSessionCookies(c);
    return c.body(null, 204);
  }));

  // ---------------------------------------------------------------------------
  // Password and email
  // ---------------------------------------------------------------------------

  app.post("/api/account/password", authRoute(async (c) => {
    const stepped = await steppedUp(c, { needPassword: true });
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const parsed = z.object({ newPassword: newPasswordSchema }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid password payload" }, 400);
    const config = c.get("config")!;
    const weak = await rejectPassword(c, parsed.data.newPassword, gate.user.username);
    if (weak) return weak;
    // The one PBKDF2 of this request: the current password was verified by the step-up.
    const passwordHash = await passwords.hash(parsed.data.newPassword, config.passwordPbkdf2Iterations);
    const db = c.get("db")!;
    const now = new Date();
    const done = await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: gate.userId },
        data: {
          passwordHash,
          passwordChangedAt: now,
          passwordResetRequired: false,
          credentialsVersion: { increment: 1 },
          securityHoldUntil: holdUntil(now, config.securityHoldMs),
        },
      }) as AccountUser;
      const revoked = await revokeUserSessions(tx, gate.userId, "PASSWORD_CHANGED", { exceptSessionId: gate.sessionId });
      await voidEmailTokens(tx, gate.userId, ["PASSWORD_RESET"], now);
      await recordSecurityEvent(tx, { userId: gate.userId, type: "PASSWORD_CHANGED", sessionId: gate.sessionId, facts: requestFacts(c), data: { revokedSessions: revoked.length } });
      const notice = await prepareNotice(tx, config, updated, "PASSWORD_CHANGED", { now, details: { how: "change" } });
      return { revoked, notice };
    });
    await fanoutRevoke(c.env, gate.userId, done.revoked, "PASSWORD_CHANGED");
    await sendMail(c, done.notice);
    const body: ChangePasswordResponse = { revokedSessions: done.revoked.length };
    return c.json(body);
  }));

  app.post("/api/account/email/verification", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const db = c.get("db")!;
    const config = c.get("config")!;
    const user = await loadUser(db, gate.userId);
    if (!user.email) return c.json({ error: "Add an email address first.", code: "EMAIL_MISSING" }, 409);
    if (user.emailVerifiedAt != null) return c.json({ error: "Your email address is already confirmed.", code: "EMAIL_ALREADY_VERIFIED" }, 409);
    if (mailUnavailable(c.env, config)) return c.json({ error: "Email is not available right now.", code: "MAIL_UNAVAILABLE", retryable: false }, 503);
    const mail = await sendVerification(db, c, user);
    await sendMail(c, mail);
    return c.json({ ok: true }, 202);
  }));

  app.post("/api/account/email", authRoute(async (c) => {
    const stepped = await steppedUp(c);
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const parsed = z.object({ newEmail: emailSchema }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid email payload" }, 400);
    const db = c.get("db")!;
    const config = c.get("config")!;
    const newEmail = parsed.data.newEmail;
    const user = await loadUser(db, gate.userId);
    const accepted: ChangeEmailResponse = { ok: true, pendingEmail: newEmail };
    if (newEmail === user.email) {
      if (user.emailVerifiedAt != null) return c.json({ error: "Your email address is already confirmed.", code: "EMAIL_ALREADY_VERIFIED" }, 409);
      if (mailUnavailable(c.env, config)) return c.json({ error: "Email is not available right now.", code: "MAIL_UNAVAILABLE", retryable: false }, 503);
      await sendMail(c, await sendVerification(db, c, user));
      return c.json(accepted, 202);
    }
    if (mailUnavailable(c.env, config)) return c.json({ error: "Email is not available right now.", code: "MAIL_UNAVAILABLE", retryable: false }, 503);
    const now = new Date();
    const facts = requestFacts(c);
    // One cap for both outcomes below (requests in the last hour), so the answer never tells them apart.
    const recent = await db.accountSecurityEvent.count({
      where: { userId: user.id, type: "EMAIL_CHANGE_REQUESTED", createdAt: { gte: new Date(now.getTime() - EMAIL_TOKEN_CAP.EMAIL_CHANGE.windowMs) } },
    });
    if (recent >= EMAIL_TOKEN_CAP.EMAIL_CHANGE.count) {
      logWarn({ security: "EMAIL_CHANGE_CAP_REACHED", userId: user.id }, "email change not sent: hourly cap reached");
      return c.json(accepted, 202);
    }
    const holder = await db.user.findUnique({ where: { email: newEmail }, select: { id: true } }) as { id: string } | null;
    const mails = await db.$transaction(async (tx): Promise<(MailMessage | null)[]> => {
      await recordSecurityEvent(tx, { userId: user.id, type: "EMAIL_CHANGE_REQUESTED", sessionId: gate.sessionId, facts });
      // No enumeration: a taken address leaves the same state as a free one (a
      // pending change, so the overview's pendingEmail matches, and the same
      // notice to the current address). Only the mail to the new address differs.
      await voidEmailTokens(tx, user.id, ["EMAIL_CHANGE"], now);
      const issued = await issueEmailToken(tx, {
        userId: user.id,
        purpose: "EMAIL_CHANGE",
        email: newEmail,
        credentialsVersion: user.credentialsVersion,
        data: { previousEmail: user.email },
        now,
        ignoreCap: true,
      });
      const notice = user.email
        ? await prepareNotice(tx, config, user, "EMAIL_CHANGE_NOTICE", {
          now, to: user.email, data: { revertEmail: user.email }, details: { newEmail, stage: "requested" },
        })
        : null;
      if (holder) {
        // Its link is never sent (a confirm would fail on the unique email anyway); the address's owner learns someone tried.
        return [{ kind: "EMAIL_IN_USE", to: newEmail, userId: null, idempotencyKey: `EMAIL_IN_USE:${randomToken(16)}`, ...emailInUse() }, notice];
      }
      const link = emailLink(config, "EMAIL_CHANGE", issued!.token);
      const confirm = linkMail("EMAIL_CHANGE_CONFIRM", newEmail, user.id, issued!, link, emailChangeConfirm({ username: user.username, link, newEmail }));
      return [confirm, notice];
    });
    await sendMail(c, ...mails);
    return c.json(accepted, 202);
  }));

  // ---------------------------------------------------------------------------
  // TOTP and backup codes
  // ---------------------------------------------------------------------------

  app.post("/api/account/2fa/totp/setup", authRoute(async (c) => {
    const config = c.get("config")!;
    if (!config.security) {
      const gate = await authed(c);
      return gate.ok ? securityNotConfigured(c) : gate.response;
    }
    const stepped = await steppedUp(c);
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const db = c.get("db")!;
    const now = new Date();
    const secret = newTotpSecret();
    await db.$transaction(async (tx) => {
      const existing = await tx.userTotp.findUnique({ where: { userId: gate.userId } }) as TotpRow | null;
      if (totpActive(existing)) throw new Refusal(409, { error: "Two-step verification is already on.", code: "TOTP_ALREADY_ENABLED" });
      if (existing) {
        // A pending or switched-off authenticator is replaced (its backup codes go with it).
        await tx.userTotp.deleteMany({ where: { userId: gate.userId } });
        await tx.userBackupCode.deleteMany({ where: { userId: gate.userId } });
      }
      await tx.userTotp.create({ data: { userId: gate.userId, secretCiphertext: sealTotpSecret(config, gate.userId, secret), createdAt: now } });
    });
    const body: TotpSetupResponse = {
      secret,
      otpauthUri: otpauthUri(config.totpIssuer, gate.user.username, secret),
      expiresAt: new Date(now.getTime() + TOTP_PENDING_TTL_MS).toISOString(),
    };
    return c.json(body);
  }));

  app.post("/api/account/2fa/totp/enable", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const config = c.get("config")!;
    if (!config.security) return securityNotConfigured(c);
    const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid code payload" }, 400);
    const db = c.get("db")!;
    const now = new Date();
    const notPending = () => c.json({ error: "Start the setup again.", code: "TOTP_NOT_PENDING" }, 409);
    const row = await db.userTotp.findUnique({ where: { userId: gate.userId } }) as TotpRow | null;
    if (!row || row.enabledAt != null || now.getTime() - new Date(row.createdAt).getTime() > TOTP_PENDING_TTL_MS) return notPending();
    const step = await matchTotp(openTotpSecret(config, gate.userId, row.secretCiphertext), parsed.data.code, now.getTime());
    if (step === null) {
      return c.json({ error: "That code didn't match. Check your phone's time and try again.", code: "TOTP_INVALID" }, 400);
    }
    const done = await db.$transaction(async (tx) => {
      // The enrolment step is recorded, so this code cannot also sign in.
      const { count } = await tx.userTotp.updateMany({
        where: { userId: gate.userId, enabledAt: null, secretCiphertext: row.secretCiphertext },
        data: { enabledAt: now, lastUsedStep: step },
      });
      if (count !== 1) throw new Refusal(409, { error: "Start the setup again.", code: "TOTP_NOT_PENDING" });
      const codes = await replaceBackupCodes(tx, config.security!.hmacSecret, gate.userId, now);
      const updated = await tx.user.update({
        where: { id: gate.userId },
        data: { credentialsVersion: { increment: 1 }, ...enrolmentHold(gate, now, config.securityHoldMs) },
      }) as AccountUser;
      // This session just proved the new factor: it counts as a second-factor step-up.
      const methods = [...new Set([...gate.session.reauthMethods, "otp"])];
      await tx.session.updateMany({ where: { id: gate.sessionId, revokedAt: null }, data: { reauthMethods: methods } });
      await recordSecurityEvent(tx, { userId: gate.userId, type: "TOTP_ENABLED", sessionId: gate.sessionId, facts: requestFacts(c) });
      const notice = await prepareNotice(tx, config, updated, "TOTP_ENABLED", { now });
      return { codes, notice };
    });
    await sendMail(c, done.notice);
    const body: BackupCodesResponse = { backupCodes: done.codes };
    return c.json(body);
  }));

  app.delete("/api/account/2fa/totp", authRoute(async (c) => {
    const stepped = await steppedUp(c);
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const db = c.get("db")!;
    const config = c.get("config")!;
    const now = new Date();
    const notice = await db.$transaction(async (tx) => {
      // Backup codes are kept (they stop working with TOTP off), so a lockdown can restore both.
      const { count } = await tx.userTotp.updateMany({
        where: { userId: gate.userId, enabledAt: { not: null }, disabledAt: null },
        data: { disabledAt: now },
      });
      if (count !== 1) throw new Refusal(409, { error: "Two-step verification is not on.", code: "TOTP_NOT_ENABLED" });
      const updated = await tx.user.update({
        where: { id: gate.userId },
        data: { credentialsVersion: { increment: 1 }, securityHoldUntil: holdUntil(now, config.securityHoldMs) },
      }) as AccountUser;
      await recordSecurityEvent(tx, { userId: gate.userId, type: "TOTP_DISABLED", sessionId: gate.sessionId, facts: requestFacts(c) });
      return prepareNotice(tx, config, updated, "TOTP_DISABLED", { now });
    });
    await sendMail(c, notice);
    return c.body(null, 204);
  }));

  app.post("/api/account/2fa/backup-codes", authRoute(async (c) => {
    const config = c.get("config")!;
    if (!config.security) {
      const gate = await authed(c);
      return gate.ok ? securityNotConfigured(c) : gate.response;
    }
    const stepped = await steppedUp(c);
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const db = c.get("db")!;
    const now = new Date();
    const done = await db.$transaction(async (tx) => {
      const totp = await tx.userTotp.findUnique({ where: { userId: gate.userId } }) as TotpRow | null;
      if (!totpActive(totp)) throw new Refusal(409, { error: "Two-step verification is not on.", code: "TOTP_NOT_ENABLED" });
      const codes = await replaceBackupCodes(tx, config.security!.hmacSecret, gate.userId, now);
      await recordSecurityEvent(tx, { userId: gate.userId, type: "BACKUP_CODES_REGENERATED", sessionId: gate.sessionId, facts: requestFacts(c) });
      const user = await loadUser(tx, gate.userId);
      return { codes, notice: await prepareNotice(tx, config, user, "BACKUP_CODES_REGENERATED", { now }) };
    });
    await sendMail(c, done.notice);
    const body: BackupCodesResponse = { backupCodes: done.codes };
    return c.json(body);
  }));

  // ---------------------------------------------------------------------------
  // Passkeys
  // ---------------------------------------------------------------------------

  app.get("/api/account/passkeys", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    return c.json({ passkeys: (await activePasskeys(c.get("db")!, gate.userId)).map(toPasskeySummary) });
  }));

  app.post("/api/account/passkeys/options", authRoute(async (c) => {
    const setup = passkeySetup(c.get("config")!);
    if (!setup) {
      const gate = await authed(c);
      return gate.ok ? passkeysUnavailable(c) : gate.response;
    }
    const stepped = await steppedUp(c);
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const db = c.get("db")!;
    // Every credential, removed ones too: the browser then warns about a duplicate authenticator.
    const all = await db.webAuthnCredential.findMany({
      where: { userId: gate.userId },
      select: { credentialId: true, transports: true, removedAt: true },
    }) as { credentialId: string; transports: string[]; removedAt: Date | null }[];
    if (all.filter((row) => row.removedAt == null).length >= PASSKEY_LIMIT) {
      return c.json({ error: `An account can have at most ${PASSKEY_LIMIT} passkeys.`, code: "PASSKEY_LIMIT" }, 409);
    }
    let handle = gate.user.webauthnUserId;
    if (!handle) {
      // First passkey: a random user handle (never the account id). The conditional write settles a race.
      await db.user.updateMany({ where: { id: gate.userId, webauthnUserId: null }, data: { webauthnUserId: randomToken(32) } });
      handle = (await db.user.findUnique({ where: { id: gate.userId }, select: { webauthnUserId: true } }) as { webauthnUserId: string | null } | null)?.webauthnUserId ?? null;
      if (!handle) throw new Error("WebAuthn user handle was not stored");
    }
    const options = await registrationOptions(setup.webauthn, { username: gate.user.username, webauthnUserId: handle },
      all.map((row) => ({ credentialId: row.credentialId, transports: row.transports ?? [] })));
    return c.json({
      options: options.options,
      challengeToken: await signChallenge(setup.secret, { pur: "register", chal: options.challenge, sub: gate.userId, sid: gate.sessionId }),
    });
  }));

  app.post("/api/account/passkeys", authRoute(async (c) => {
    const setup = passkeySetup(c.get("config")!);
    if (!setup) {
      const gate = await authed(c);
      return gate.ok ? passkeysUnavailable(c) : gate.response;
    }
    // Re-checked here: the window may have closed while the browser prompt was open.
    const stepped = await steppedUp(c);
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const parsed = z.object({
      challengeToken: z.string().min(1).max(2048),
      credential: z.unknown(),
      name: passkeyName.optional(),
    }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid passkey payload" }, 400);
    const claims = await verifyChallenge(setup.secret, parsed.data.challengeToken, "register");
    if (!claims || claims.sub !== gate.userId || claims.sid !== gate.sessionId) return c.json(CHALLENGE_INVALID, 400);
    const registered = await verifyRegistration(setup.webauthn, parsed.data.credential, claims.chal);
    if (!registered) return c.json(PASSKEY_INVALID, 400);
    const db = c.get("db")!;
    if (!await consumeNonce(db, claims.jti, "webauthn:register", nonceExpiry(claims))) return c.json(CHALLENGE_INVALID, 400);
    const config = c.get("config")!;
    const now = new Date();
    const name = parsed.data.name ?? deviceLabel(c.req.header("user-agent")) ?? "Passkey";
    const done = await db.$transaction(async (tx) => {
      const existing = await tx.webAuthnCredential.findUnique({ where: { credentialId: registered.credentialId } }) as PasskeyRow | null;
      if (existing) {
        if (existing.userId !== gate.userId || existing.removedAt == null) {
          throw new Refusal(409, { error: "This passkey is already registered.", code: "PASSKEY_ALREADY_REGISTERED" });
        }
        // The same authenticator added again after removal: the old row goes.
        await tx.webAuthnCredential.deleteMany({ where: { id: existing.id, userId: gate.userId } });
      }
      const active = await tx.webAuthnCredential.count({ where: { userId: gate.userId, removedAt: null } });
      if (active >= PASSKEY_LIMIT) throw new Refusal(409, { error: `An account can have at most ${PASSKEY_LIMIT} passkeys.`, code: "PASSKEY_LIMIT" });
      const row = await tx.webAuthnCredential.create({
        data: {
          userId: gate.userId,
          credentialId: registered.credentialId,
          publicKey: registered.publicKey,
          counter: registered.counter,
          transports: registered.transports,
          deviceType: registered.deviceType,
          backedUp: registered.backedUp,
          aaguid: registered.aaguid,
          rpId: registered.rpId,
          name,
          // Application clock: a lockdown compares it with the notice's incident instant.
          createdAt: now,
        },
      }) as PasskeyRow;
      await recordSecurityEvent(tx, { userId: gate.userId, type: "PASSKEY_ADDED", sessionId: gate.sessionId, facts: requestFacts(c), data: { passkeyId: row.id, name } });
      const hold = enrolmentHold(gate, now, config.securityHoldMs);
      if (hold.securityHoldUntil) await tx.user.update({ where: { id: gate.userId }, data: hold, select: { id: true } });
      const user = await loadUser(tx, gate.userId);
      return { row, notice: await prepareNotice(tx, config, user, "PASSKEY_ADDED", { now, details: { passkeyName: name } }) };
    });
    await sendMail(c, done.notice);
    return c.json({ passkey: toPasskeySummary(done.row) }, 201);
  }));

  app.post("/api/account/passkeys/:id/rename", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = z.object({ name: passkeyName }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid passkey payload" }, 400);
    const id = idParam(c);
    const db = c.get("db")!;
    const { count } = id
      ? await db.webAuthnCredential.updateMany({ where: { id, userId: gate.userId, removedAt: null }, data: { name: parsed.data.name } })
      : { count: 0 };
    if (count !== 1) return c.json({ error: "Passkey not found" }, 404);
    const row = await db.webAuthnCredential.findFirst({ where: { id, userId: gate.userId } }) as PasskeyRow;
    return c.json({ passkey: toPasskeySummary(row) });
  }));

  app.delete("/api/account/passkeys/:id", authRoute(async (c) => {
    const stepped = await steppedUp(c);
    if ("response" in stepped) return stepped.response;
    const { gate } = stepped;
    const id = idParam(c);
    if (!id) return c.json({ error: "Passkey not found" }, 404);
    const db = c.get("db")!;
    const config = c.get("config")!;
    const now = new Date();
    const notice = await db.$transaction(async (tx) => {
      const row = await tx.webAuthnCredential.findFirst({ where: { id, userId: gate.userId, removedAt: null }, select: { id: true, name: true } }) as { id: string; name: string } | null;
      if (!row) throw new Refusal(404, { error: "Passkey not found" });
      // Soft delete: a lockdown can restore a passkey removed after its incident.
      await tx.webAuthnCredential.updateMany({ where: { id: row.id, userId: gate.userId, removedAt: null }, data: { removedAt: now } });
      await recordSecurityEvent(tx, { userId: gate.userId, type: "PASSKEY_REMOVED", sessionId: gate.sessionId, facts: requestFacts(c), data: { passkeyId: row.id, name: row.name } });
      const user = await loadUser(tx, gate.userId);
      return prepareNotice(tx, config, user, "PASSKEY_REMOVED", { now, details: { passkeyName: row.name } });
    });
    await sendMail(c, notice);
    return c.body(null, 204);
  }));
}

/** Issue a VERIFY_EMAIL token for the current address (null over the hourly cap: the caller still answers 202). */
async function sendVerification(db: AppDb, c: Ctx, user: AccountUser): Promise<MailMessage | null> {
  const now = new Date();
  if (await emailCapReached(db, user.id, "VERIFY_EMAIL", now)) {
    logWarn({ security: "VERIFY_CAP_REACHED", userId: user.id }, "verification email not sent: hourly cap reached");
    return null;
  }
  const issued = await issueEmailToken(db, { userId: user.id, purpose: "VERIFY_EMAIL", email: user.email!, credentialsVersion: user.credentialsVersion, now, ignoreCap: true });
  const link = emailLink(c.get("config")!, "VERIFY_EMAIL", issued!.token);
  return linkMail("VERIFY_EMAIL", user.email!, user.id, issued!, link, verifyEmail({ username: user.username, link }));
}
