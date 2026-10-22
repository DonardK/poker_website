import type { AuthClientConfig, MfaChallenge } from "@poker/shared";
import { LOGIN_IDENTIFIER_MAX_LENGTH, PASSWORD_MIN_LENGTH, REFRESH_COOKIE_NAME, STEP_UP_WINDOW_MS } from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { randomBelow } from "../auth/bytes";
import { findKnownDevice, mintDevice, readDevice, readOrMintDevice } from "../auth/devices";
import { issueEmailToken } from "../auth/email-tokens";
import { AuthError, isAuthError, uniqueViolation } from "../auth/errors";
import { readFactors } from "../auth/factors";
import { coarseIp } from "../auth/ip";
import { addressHistory, familiarScope } from "../auth/lockout";
import { checkPassword } from "../auth/password-check";
import { recordSecurityEvent } from "../auth/security-events";
import { newPasswordSchema, passwordProblem, presentedPasswordSchema } from "../auth/password-policy";
import { passwords } from "../auth/password";
import { clearSecondFactorFailures, recordSecondFactorFailure, secondFactorRetryAfter, verifySecondFactor } from "../auth/second-factor";
import { hashRefresh, idleTtlMs, REFRESH_GRACE_MS, revokeSession, revokeUserSessions, sessionExpiry } from "../auth/sessions";
import { consumeNonce, nonceExpiry, signMfaTicket, verifyMfaTicket } from "../auth/tickets";
import { signRefreshToken, verifyRefreshToken } from "../auth/tokens";
import { canonicalUsername, checkChosenUsername } from "../auth/usernames";
import { emailLink, linkMail, prepareNotice } from "../mail/notify";
import { verifyEmail } from "../mail/templates";
import { hintCookie, readCookie, requestIsSecure } from "./cookies";
import type { AppDb } from "./db";
import { authRoute, authed, requestFacts, serviceUnavailable, turnstileGate, type Ctx } from "./guard";
import { errBrief, logInfo, logWarn } from "./log";
import { fanoutRevoke } from "./realtime";
import {
  appendCookie, clearSessionCookies, completeSignIn, issueAccessToken, securityExtras, setDeviceCookie, setSessionCookies,
  toPublicUser, type AccountUser,
} from "./session-issue";

const USERNAME_UNAVAILABLE = "Username unavailable";
const REGISTRATION_CONFLICT = "Registration could not be completed with these details";
const INVALID_CREDENTIALS = "Invalid credentials";

const termsSchema = z.object({
  acceptTerms: z.literal(true),
  confirmAge: z.literal(true),
  termsVersion: z.string().min(1).max(64),
});

function rejectTerms(c: Ctx, body: unknown, termsVersion: string): Response | null {
  const parsed = termsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "Please accept the terms and confirm you are 18 or older", code: "TERMS_REQUIRED" }, 400);
  }
  if (parsed.data.termsVersion !== termsVersion) {
    return c.json({
      error: "The terms have been updated; please review and accept the current version",
      code: "TERMS_OUTDATED",
      currentVersion: termsVersion,
    }, 409);
  }
  return null;
}

function termsAcceptance(termsVersion: string, now: number) {
  return { termsVersion, termsAcceptedAt: new Date(now), ageConfirmedAt: new Date(now) };
}

/** User columns every sign-in writes: last seen, and the second-factor counter reset. */
export function signedInData(now: Date): Record<string, unknown> {
  return { lastSeenAt: now, mfaFailedCount: 0, mfaLockedUntil: null };
}

/** 400 PASSWORD_WEAK / PASSWORD_BREACHED, or null (also when the breach check could not answer). */
export async function rejectPassword(c: Ctx, password: string, username: string): Promise<Response | null> {
  const problem = await passwordProblem(password, username, {
    breachCheck: c.get("config")!.passwordBreachCheck,
    unavailable: () => logWarn({ security: "BREACH_CHECK_UNAVAILABLE" }, "breached-password check unavailable; password allowed"),
  });
  return problem ? c.json({ error: problem.error, code: problem.code }, 400) : null;
}

export function securityNotConfigured(c: Ctx): Response {
  return c.json({ error: "Two-step sign-in is temporarily unavailable. Please try again later.", code: "SECURITY_NOT_CONFIGURED", retryable: false }, 503);
}

export function mfaLocked(c: Ctx, retryAfterS: number): Response {
  c.header("Retry-After", String(retryAfterS));
  return c.json({ error: "Too many wrong codes. Try again later.", code: "MFA_LOCKED" }, 429);
}

export const mfaBody = z.object({
  mfaTicket: z.string().min(1).max(2048),
  method: z.enum(["totp", "backup_code"]),
  code: z.string().min(1).max(16),
  remember: z.boolean().optional(),
});

function withinGrace(session: { previousTokenHash?: string | null; rotatedAt?: Date | string | null }, presented: string, now: number): boolean {
  if (session.previousTokenHash !== presented || session.rotatedAt == null) return false;
  const rotatedAt = new Date(session.rotatedAt).getTime();
  return now - rotatedAt >= 0 && now - rotatedAt <= REFRESH_GRACE_MS;
}

interface Refreshed {
  user: AccountUser;
  sessionId: string;
  rotated: { token: string; expiresAt: Date } | null;
  expiresAt: Date;
  persistent: boolean;
}

async function refreshSession(c: Ctx, token: string, now: number): Promise<Refreshed> {
  const config = c.get("config")!;
  const db = c.get("db")!;
  const claims = await verifyRefreshToken(config.jwtRefreshSecret, token);
  const presented = await hashRefresh(token);
  const row = await db.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!row || row.userId !== claims.sub || !row.user) throw new AuthError("REVOKED", "Unknown session");
  if (row.revokedAt) throw new AuthError("REVOKED", "Session revoked");
  if (new Date(row.expiresAt).getTime() <= now || new Date(row.absoluteExpiresAt).getTime() <= now) throw new AuthError("EXPIRED", "Session expired");
  const { user, ...session } = row as { user: AccountUser } & Record<string, any>;
  if (user.kind !== "HUMAN") throw new AuthError("USER_BLOCKED", "Account cannot sign in");
  if (user.isGuest) {
    await revokeSession(db, session.id, "GUEST_RETIRED");
    await fanoutRevoke(c.env, user.id, [session.id], "GUEST_RETIRED");
    throw new AuthError("USER_BLOCKED", "Guest accounts were retired", "GUEST_RETIRED");
  }
  const persistent = session.persistent !== false;
  if (presented === session.refreshToken) {
    const expiresAt = sessionExpiry(now, new Date(session.absoluteExpiresAt), idleTtlMs(config.sessionIdleTtlMs, persistent));
    const next = await signRefreshToken(config.jwtRefreshSecret, user.id, session.id, expiresAt);
    const { count } = await db.session.updateMany({
      where: { id: session.id, refreshToken: presented, revokedAt: null },
      data: { refreshToken: await hashRefresh(next), previousTokenHash: presented, rotatedAt: new Date(now), lastUsedAt: new Date(now), expiresAt },
    });
    if (count === 1) return { user, sessionId: session.id, rotated: { token: next, expiresAt }, expiresAt, persistent };
    const current = await db.session.findUnique({ where: { id: session.id }, select: { previousTokenHash: true, rotatedAt: true, revokedAt: true, expiresAt: true } });
    if (current && !current.revokedAt && withinGrace(current, presented, now)) {
      return { user, sessionId: session.id, rotated: null, expiresAt: new Date(current.expiresAt), persistent };
    }
    throw new AuthError("REVOKED", "Session already refreshed");
  }
  if (withinGrace(session, presented, now)) return { user, sessionId: session.id, rotated: null, expiresAt: new Date(session.expiresAt), persistent };
  await revokeSession(db, session.id, "REFRESH_REUSE");
  await recordSecurityEvent(db, { userId: user.id, type: "REFRESH_REUSE", sessionId: session.id, facts: requestFacts(c) });
  await fanoutRevoke(c.env, user.id, [session.id], "REFRESH_REUSE");
  logWarn({ security: "REFRESH_REUSE", userId: user.id, sessionId: session.id, ip: coarseIp(session.ip) },
    "SECURITY EVENT: a replaced refresh token was presented again; the session was revoked");
  throw new AuthError("REVOKED", "Refresh token reuse");
}

/** Look up a sign-in identifier: an email when it contains "@" (usernames cannot), otherwise a username. */
async function findByIdentifier(db: AppDb, identifier: string): Promise<AccountUser | null> {
  const trimmed = identifier.trim();
  if (trimmed.includes("@")) return db.user.findUnique({ where: { email: trimmed.toLowerCase() } }) as Promise<AccountUser | null>;
  return db.user.findUnique({ where: { usernameCanonical: canonicalUsername(trimmed) } }) as Promise<AccountUser | null>;
}

export function registerAuth(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/auth/config", (c) => {
    const config = c.get("config")!;
    const body: AuthClientConfig = {
      termsVersion: config.termsVersion,
      emailEnabled: config.mail.transport === "resend",
      passkeysEnabled: config.webauthn !== null,
      totpEnabled: config.security !== null,
      stepUpWindowMs: STEP_UP_WINDOW_MS,
      passwordMinLength: PASSWORD_MIN_LENGTH,
      breachCheck: config.passwordBreachCheck,
    };
    return c.json(body);
  });

  app.post("/api/auth/register", authRoute(async (c) => {
    const turned = await turnstileGate(c);
    if (turned) return turned;
    const config = c.get("config")!;
    const body = c.get("jsonBody");
    const terms = rejectTerms(c, body, config.termsVersion);
    if (terms) return terms;
    const parsed = z.object({
      username: z.string(),
      email: z.string().email().max(254).transform((value) => value.toLowerCase()),
      password: newPasswordSchema,
      remember: z.boolean().optional(),
    }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid registration payload" }, 400);
    const name = checkChosenUsername(parsed.data.username);
    if (!name.ok) return c.json({ error: name.error }, name.error === USERNAME_UNAVAILABLE ? 409 : 400);
    const weak = await rejectPassword(c, parsed.data.password, name.username);
    if (weak) return weak;
    const passwordHash = await passwords.hash(parsed.data.password, config.passwordPbkdf2Iterations);
    const db = c.get("db")!;
    try {
      return await completeSignIn(c, db, {
        user: (tx, now) => tx.user.create({
          data: {
            username: name.username,
            email: parsed.data.email,
            passwordHash,
            passwordChangedAt: now,
            bankroll: config.defaultStartingBankroll,
            avatarHue: randomBelow(360),
            lastSeenAt: now,
            ...termsAcceptance(config.termsVersion, now.getTime()),
          },
        }) as Promise<AccountUser>,
        amr: ["pwd"],
        remember: parsed.data.remember ?? true,
        device: await readOrMintDevice(c.req.header("cookie")),
        history: { familiar: true, recentSessions: false },
        registered: true,
        status: 201,
        extras: { twoFactorEnabled: false, passkeyCount: 0 },
        alsoInTransaction: async (tx, user, now) => {
          const issued = await issueEmailToken(tx, { userId: user.id, purpose: "VERIFY_EMAIL", email: user.email!, credentialsVersion: user.credentialsVersion, now });
          if (!issued) return null;
          const link = emailLink(config, "VERIFY_EMAIL", issued.token);
          return linkMail("VERIFY_EMAIL", user.email!, user.id, issued, link, verifyEmail({ username: user.username, link }));
        },
      });
    } catch (err) {
      const clash = uniqueViolation(err);
      if (clash && /email/i.test(clash.fields)) return c.json({ error: REGISTRATION_CONFLICT }, 409);
      if (clash && /username/i.test(clash.fields)) return c.json({ error: USERNAME_UNAVAILABLE }, 409);
      throw err;
    }
  }));

  app.post("/api/auth/login", authRoute(async (c) => {
    const turned = await turnstileGate(c);
    if (turned) return turned;
    const parsed = z.object({
      identifier: z.string().min(1).max(LOGIN_IDENTIFIER_MAX_LENGTH).optional(),
      /** @deprecated alias of identifier for old clients. */
      username: z.string().min(1).max(LOGIN_IDENTIFIER_MAX_LENGTH).optional(),
      password: presentedPasswordSchema,
      remember: z.boolean().optional(),
    }).safeParse(c.get("jsonBody"));
    const identifier = parsed.success ? parsed.data.identifier ?? parsed.data.username : undefined;
    if (!parsed.success || !identifier) return c.json({ error: "Invalid login payload" }, 400);
    const now = Date.now();
    const db = c.get("db")!;
    const config = c.get("config")!;
    const facts = requestFacts(c);
    const remember = parsed.data.remember ?? true;
    const found = await findByIdentifier(db, identifier);
    const usable = found && found.kind === "HUMAN" && !found.isGuest && found.passwordHash ? found : null;
    const device = await readDevice(c.req.header("cookie"));
    // Same queries for an unknown user ("no-such-user"), so timing does not reveal accounts.
    const known = await findKnownDevice(db, usable?.id ?? null, device?.hash ?? null);
    const history = await addressHistory(db, usable?.id ?? null, facts.ip, now);
    const familiar = history.familiar || known !== null;
    const scope = familiarScope(facts.ip, known && device ? device.hash : null);
    const check = await checkPassword(db, config, usable, parsed.data.password, { familiar, scope, now, facts });
    if (!usable || !check.ok) return c.json({ error: INVALID_CREDENTIALS }, 401);
    const cleared = { failedLoginCount: 0, lockedUntil: null, ...(check.rehash ? { passwordHash: check.rehash } : {}) };
    if (usable.passwordResetRequired) {
      await db.user.update({ where: { id: usable.id }, data: cleared, select: { id: true } });
      logWarn({ security: "LOGIN_BLOCKED_RESET_REQUIRED", userId: usable.id }, "correct password refused: a reset is required after a lockdown");
      return c.json({ error: "For your security, reset your password before signing in.", code: "PASSWORD_RESET_REQUIRED" }, 403);
    }
    const factors = await readFactors(db, usable.id);
    if (factors.totpEnabled) {
      if (!config.security) return securityNotConfigured(c);
      await db.user.update({ where: { id: usable.id }, data: cleared, select: { id: true } });
      const bound = device ?? await mintDevice();
      const ticket = await signMfaTicket(config.security.hmacSecret, {
        pur: "login", sub: usable.id, dev: bound.hash, cv: usable.credentialsVersion, rem: remember, amr: ["pwd"],
      });
      setDeviceCookie(c, bound);
      const challenge: MfaChallenge = { mfaRequired: true, mfaTicket: ticket.token, methods: ["totp", "backup_code"], expiresAt: ticket.expiresAt.toISOString() };
      return c.json(challenge);
    }
    return completeSignIn(c, db, {
      user: (tx, at) => tx.user.update({ where: { id: usable.id }, data: { ...cleared, ...signedInData(at) } }) as Promise<AccountUser>,
      amr: ["pwd"],
      remember,
      device: device ?? await mintDevice(),
      history,
      extras: { twoFactorEnabled: false, passkeyCount: factors.passkeys },
    });
  }));

  app.post("/api/auth/login/mfa", authRoute(async (c) => {
    const parsed = mfaBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid sign-in payload" }, 400);
    const config = c.get("config")!;
    if (!config.security) return securityNotConfigured(c);
    const db = c.get("db")!;
    const now = new Date();
    const facts = requestFacts(c);
    const expired = () => c.json({ error: "Sign-in expired. Start again.", code: "MFA_TICKET_INVALID" }, 401);
    const claims = await verifyMfaTicket(config.security.hmacSecret, parsed.data.mfaTicket, "login");
    if (!claims) return expired();
    const device = await readDevice(c.req.header("cookie"));
    if (!device || device.hash !== claims.dev) return expired();
    const user = await db.user.findUnique({ where: { id: claims.sub } }) as AccountUser | null;
    if (!user || user.kind !== "HUMAN" || user.isGuest || user.credentialsVersion !== claims.cv || user.passwordResetRequired) return expired();
    const known = await findKnownDevice(db, user.id, device.hash);
    const scope = { userId: user.id, knownDeviceHash: known ? device.hash : null };
    const retryAfter = secondFactorRetryAfter(user, scope, now.getTime());
    if (retryAfter > 0) return mfaLocked(c, retryAfter);
    const result = await verifySecondFactor(db, config, user.id, parsed.data.method, parsed.data.code, now);
    if (!result.ok) {
      await recordSecondFactorFailure(db, scope, now, facts);
      return c.json({ error: "Invalid code", code: "MFA_INVALID" }, 401);
    }
    if (!await consumeNonce(db, claims.jti, "mfa:login", nonceExpiry(claims))) return expired();
    if (scope.knownDeviceHash) await clearSecondFactorFailures(db, scope, { mfaFailedCount: 0, mfaLockedUntil: null });
    const history = await addressHistory(db, user.id, facts.ip, now.getTime());
    return completeSignIn(c, db, {
      user: (tx, at) => tx.user.update({ where: { id: user.id }, data: signedInData(at) }) as Promise<AccountUser>,
      amr: ["pwd", result.amr],
      remember: parsed.data.remember ?? claims.rem,
      device,
      history,
      extras: { twoFactorEnabled: true },
      alsoInTransaction: result.amr === "backup"
        ? (tx, signedIn, at) => prepareNotice(tx, config, signedIn, "BACKUP_CODE_USED", { now: at, details: { remaining: result.remainingBackupCodes ?? 0 } })
        : undefined,
    });
  }));

  app.post("/api/auth/refresh", async (c) => {
    const token = readCookie(c.req.header("cookie"), REFRESH_COOKIE_NAME);
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
      return c.json({ error: "No refresh session" }, 401);
    }
    try {
      const { user, sessionId, rotated, expiresAt, persistent } = await refreshSession(c, token, Date.now());
      if (rotated) setSessionCookies(c, rotated.token, rotated.expiresAt, persistent);
      else appendCookie(c, hintCookie(expiresAt, requestIsSecure(c.req.url), persistent));
      const accessToken = await issueAccessToken(c.get("config")!, user, sessionId);
      return c.json({ user: toPublicUser(user), accessToken });
    } catch (err) {
      if (isAuthError(err)) {
        clearSessionCookies(c);
        return c.json({ error: "Invalid refresh session" }, 401);
      }
      logWarn({ ...errBrief(err) }, "refresh unavailable; answered 503 and kept the refresh cookie");
      return serviceUnavailable(c);
    }
  });

  app.post("/api/auth/logout", async (c) => {
    const token = readCookie(c.req.header("cookie"), REFRESH_COOKIE_NAME);
    if (typeof token === "string" && token.length > 0 && token.length <= 4096) {
      try {
        const claims = await verifyRefreshToken(c.get("config")!.jwtRefreshSecret, token);
        try {
          await revokeSession(c.get("db")!, claims.sid, "LOGOUT");
        } catch (err) {
          logWarn({ ...errBrief(err) }, "logout could not revoke the session; answered 503");
          return serviceUnavailable(c);
        }
        await fanoutRevoke(c.env, claims.sub, [claims.sid], "LOGOUT");
      } catch (err) {
        if (!isAuthError(err)) {
          logWarn({ ...errBrief(err) }, "logout could not read the refresh token; answered 503");
          return serviceUnavailable(c);
        }
      }
    }
    clearSessionCookies(c);
    return c.body(null, 204);
  });

  app.get("/api/auth/sessions", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const now = new Date();
    const rows = await c.get("db")!.session.findMany({
      where: { userId: gate.userId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      orderBy: { lastUsedAt: "desc" },
      select: { id: true, createdAt: true, lastUsedAt: true, userAgent: true, ip: true },
    });
    return c.json({
      sessions: rows.map((row: { id: string; createdAt: Date; lastUsedAt: Date; userAgent: string | null; ip: string | null }) => ({
        id: row.id,
        createdAt: new Date(row.createdAt).toISOString(),
        lastUsedAt: new Date(row.lastUsedAt).toISOString(),
        userAgent: row.userAgent,
        ip: coarseIp(row.ip),
        current: row.id === gate.sessionId,
      })),
    });
  }));

  app.delete("/api/auth/sessions/:id", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = c.req.param("id") ?? "";
    const row = id.length > 0 && id.length <= 128
      ? await c.get("db")!.session.findUnique({ where: { id }, select: { userId: true } }) as { userId: string } | null
      : null;
    if (!row || row.userId !== gate.userId) return c.json({ error: "Session not found" }, 404);
    await revokeSession(c.get("db")!, id, "SESSION_REVOKED");
    await fanoutRevoke(c.env, gate.userId, [id], "SESSION_REVOKED");
    if (id === gate.sessionId) clearSessionCookies(c);
    return c.body(null, 204);
  }));

  app.post("/api/auth/logout-all", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const body = c.get("jsonBody") as { exceptCurrent?: unknown } | undefined;
    const exceptCurrent = body?.exceptCurrent === true;
    const db = c.get("db")!;
    const revoked = await revokeUserSessions(db, gate.userId, "LOGOUT_ALL", exceptCurrent ? { exceptSessionId: gate.sessionId } : {});
    await recordSecurityEvent(db, { userId: gate.userId, type: "LOGOUT_ALL", sessionId: gate.sessionId, facts: requestFacts(c), data: { revoked: revoked.length, exceptCurrent } });
    await fanoutRevoke(c.env, gate.userId, revoked, "LOGOUT_ALL");
    if (!exceptCurrent) clearSessionCookies(c);
    return c.json({ revoked: revoked.length });
  }));

  // An existing account accepts the current terms (TERMS_VERSION changed since it last did). Same
  // checks and columns as registration; the web shows the prompt while user.termsVersion is not current.
  app.post("/api/auth/terms/accept", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const config = c.get("config")!;
    const terms = rejectTerms(c, c.get("jsonBody"), config.termsVersion);
    if (terms) return terms;
    const db = c.get("db")!;
    const user = await db.user.update({ where: { id: gate.userId }, data: termsAcceptance(config.termsVersion, Date.now()) }) as AccountUser;
    logInfo({ audit: "TERMS_ACCEPTED", userId: user.id, termsVersion: config.termsVersion }, "account accepted the current terms");
    return c.json({ user: toPublicUser(user, await securityExtras(db, user)) });
  }));

  app.get("/api/auth/me", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const db = c.get("db")!;
    const user = await db.user.findUnique({ where: { id: gate.userId } }) as AccountUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ user: toPublicUser(user, await securityExtras(db, user)) });
  }));
}
