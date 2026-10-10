import type { PublicUser } from "@poker/shared";
import { REFRESH_COOKIE_NAME } from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { EdgeConfig, Env } from "../env";
import { AuthError, isAuthError, uniqueViolation } from "../auth/errors";
import { coarseIp } from "../auth/ip";
import { clearFamiliarFailures, familiarLockedUntil, isFamiliarAddress, loginLockMs, recordFamiliarFailure } from "../auth/lockout";
import { BCRYPT_COST, DUMMY_PASSWORD_HASH, passwords } from "../auth/password";
import { hashRefresh, newSessionLifetime, REFRESH_GRACE_MS, revokeSession, revokeUserSessions, sessionExpiry } from "../auth/sessions";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../auth/tokens";
import { canonicalUsername, checkChosenUsername } from "../auth/usernames";
import { clearRefreshCookie, readCookie, refreshCookie, requestIsSecure } from "./cookies";
import type { AppDb } from "./db";
import { authRoute, authed, clientIp, serviceUnavailable, turnstileGate, type Ctx } from "./guard";
import { errBrief, logInfo, logWarn } from "./log";
import { fanoutRevoke } from "./realtime";

const USERNAME_UNAVAILABLE = "Username unavailable";
const REGISTRATION_CONFLICT = "Registration could not be completed with these details";
const INVALID_CREDENTIALS = "Invalid credentials";
const GUEST_NAME_ATTEMPTS = 5;

const passwordSchema = z.string().min(12).max(72).refine((value) => new TextEncoder().encode(value).byteLength <= 72);
const termsSchema = z.object({
  acceptTerms: z.literal(true),
  confirmAge: z.literal(true),
  termsVersion: z.string().min(1).max(64),
});

interface AccountUser {
  id: string;
  username: string;
  email: string | null;
  isGuest: boolean;
  role: PublicUser["role"];
  kind: PublicUser["kind"];
  botProfile: PublicUser["botProfile"];
  bankroll: number;
  avatarHue: number;
  passwordHash: string | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

function toPublicUser(user: AccountUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    isGuest: user.isGuest,
    role: user.role,
    kind: user.kind,
    botProfile: user.botProfile,
    bankroll: user.bankroll,
    avatarHue: user.avatarHue,
  };
}

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

interface IssuedSession { sessionId: string; refreshToken: string; expiresAt: Date }

async function createSession(c: Ctx, db: AppDb, config: EdgeConfig, userId: string, now: number): Promise<IssuedSession> {
  const sessionId = crypto.randomUUID();
  const { absoluteExpiresAt, expiresAt } = newSessionLifetime(now, config.sessionIdleTtlMs, config.sessionAbsoluteTtlMs);
  const refreshToken = await signRefreshToken(config.jwtRefreshSecret, userId, sessionId, expiresAt);
  await db.session.create({
    data: {
      id: sessionId,
      userId,
      refreshToken: await hashRefresh(refreshToken),
      expiresAt,
      absoluteExpiresAt,
      lastUsedAt: new Date(now),
      userAgent: c.req.header("user-agent")?.slice(0, 256),
      ip: clientIp(c),
    },
  });
  return { sessionId, refreshToken, expiresAt };
}

async function sendSession(c: Ctx, config: EdgeConfig, status: 200 | 201, user: AccountUser, session: IssuedSession): Promise<Response> {
  c.header("Set-Cookie", refreshCookie(session.refreshToken, session.expiresAt, requestIsSecure(c.req.url)));
  const accessToken = await signAccessToken(
    config.jwtAccessSecret,
    user.id,
    user.username,
    session.sessionId,
    Math.floor(config.jwtAccessTtlMs / 1000),
  );
  return c.json({ user: toPublicUser(user), accessToken }, status);
}

async function recordFailedLogin(db: AppDb, userId: string, now: number): Promise<void> {
  const { failedLoginCount } = await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  const lockMs = loginLockMs(failedLoginCount);
  if (!lockMs) return;
  await db.user.updateMany({ where: { id: userId }, data: { lockedUntil: new Date(now + lockMs) } });
  logWarn({ security: "LOGIN_LOCKOUT", userId, failures: failedLoginCount, lockMs }, "account locked after repeated failed logins");
}

function withinGrace(session: { previousTokenHash?: string | null; rotatedAt?: Date | string | null }, presented: string, now: number): boolean {
  if (session.previousTokenHash !== presented || session.rotatedAt == null) return false;
  const rotatedAt = new Date(session.rotatedAt).getTime();
  return now - rotatedAt >= 0 && now - rotatedAt <= REFRESH_GRACE_MS;
}

async function refreshSession(c: Ctx, token: string, now: number): Promise<{ user: AccountUser; sessionId: string; rotated: { token: string; expiresAt: Date } | null }> {
  const config = c.get("config")!;
  const db = c.get("db")!;
  const claims = await verifyRefreshToken(config.jwtRefreshSecret, token);
  const presented = await hashRefresh(token);
  const row = await db.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!row || row.userId !== claims.sub || !row.user) throw new AuthError("REVOKED", "Unknown session");
  if (row.revokedAt) throw new AuthError("REVOKED", "Session revoked");
  if (new Date(row.expiresAt).getTime() <= now || new Date(row.absoluteExpiresAt).getTime() <= now) throw new AuthError("EXPIRED", "Session expired");
  const { user, ...session } = row;
  if (user.kind !== "HUMAN") throw new AuthError("USER_BLOCKED", "Account cannot sign in");
  if (presented === session.refreshToken) {
    const expiresAt = sessionExpiry(now, new Date(session.absoluteExpiresAt), config.sessionIdleTtlMs);
    const next = await signRefreshToken(config.jwtRefreshSecret, user.id, session.id, expiresAt);
    const { count } = await db.session.updateMany({
      where: { id: session.id, refreshToken: presented, revokedAt: null },
      data: { refreshToken: await hashRefresh(next), previousTokenHash: presented, rotatedAt: new Date(now), lastUsedAt: new Date(now), expiresAt },
    });
    if (count === 1) return { user, sessionId: session.id, rotated: { token: next, expiresAt } };
    const current = await db.session.findUnique({ where: { id: session.id }, select: { previousTokenHash: true, rotatedAt: true, revokedAt: true } });
    if (current && !current.revokedAt && withinGrace(current, presented, now)) return { user, sessionId: session.id, rotated: null };
    throw new AuthError("REVOKED", "Session already refreshed");
  }
  if (withinGrace(session, presented, now)) return { user, sessionId: session.id, rotated: null };
  await revokeSession(db, session.id, "REFRESH_REUSE");
  await fanoutRevoke(c.env, user.id, [session.id], "REFRESH_REUSE");
  logWarn({ security: "REFRESH_REUSE", userId: user.id, sessionId: session.id, ip: coarseIp(session.ip) },
    "SECURITY EVENT: a replaced refresh token was presented again; the session was revoked");
  throw new AuthError("REVOKED", "Refresh token reuse");
}

export function registerAuth(app: Hono<{ Bindings: Env }>): void {
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
      password: passwordSchema,
    }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid registration payload" }, 400);
    const name = checkChosenUsername(parsed.data.username);
    if (!name.ok) return c.json({ error: name.error }, name.error === USERNAME_UNAVAILABLE ? 409 : 400);
    const passwordHash = await passwords.hash(parsed.data.password, BCRYPT_COST);
    const now = Date.now();
    const db = c.get("db")!;
    try {
      const created = await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username: name.username,
            email: parsed.data.email,
            passwordHash,
            bankroll: config.defaultStartingBankroll,
            avatarHue: randomBelow(360),
            ...termsAcceptance(config.termsVersion, now),
          },
        }) as AccountUser;
        return { user, session: await createSession(c, tx, config, user.id, now) };
      });
      return sendSession(c, config, 201, created.user, created.session);
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
      username: z.string().min(1).max(24),
      password: z.string().min(1).max(128).refine((value) => new TextEncoder().encode(value).byteLength <= 72),
    }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid login payload" }, 400);
    const now = Date.now();
    const db = c.get("db")!;
    const config = c.get("config")!;
    const ip = clientIp(c);
    const user = await db.user.findUnique({ where: { usernameCanonical: canonicalUsername(parsed.data.username) } }) as AccountUser | null;
    const usable = user && user.kind === "HUMAN" && user.passwordHash ? user : null;
    const familiar = await isFamiliarAddress(db, usable?.id ?? null, ip, now);
    const locked = usable != null && (familiar
      ? familiarLockedUntil(usable.id, ip) > now
      : usable.lockedUntil != null && new Date(usable.lockedUntil).getTime() > now);
    const matches = await passwords.compare(parsed.data.password, usable && !locked ? usable.passwordHash! : DUMMY_PASSWORD_HASH);
    if (!usable || locked || !matches) {
      if (usable && !locked) {
        if (!familiar) await recordFailedLogin(db, usable.id, now);
        else {
          const lockMs = recordFamiliarFailure(usable.id, ip, now, loginLockMs);
          if (lockMs) logWarn({ security: "LOGIN_LOCKOUT", userId: usable.id, scope: "familiar-address", lockMs }, "account locked for one familiar address after repeated failed logins");
        }
      }
      return c.json({ error: INVALID_CREDENTIALS }, 401);
    }
    if (familiar && usable.lockedUntil != null && new Date(usable.lockedUntil).getTime() > now) {
      logInfo({ security: "LOGIN_FROM_FAMILIAR_ADDRESS_DURING_LOCK", userId: usable.id }, "signed in from a familiar address while the account was locked for other addresses");
    }
    clearFamiliarFailures(usable.id, ip);
    const fresh = await db.user.update({
      where: { id: usable.id },
      data: { lastSeenAt: new Date(now), failedLoginCount: 0, lockedUntil: null },
    }) as AccountUser;
    return sendSession(c, config, 200, fresh, await createSession(c, db, config, fresh.id, now));
  }));

  app.post("/api/auth/guest", authRoute(async (c) => {
    const turned = await turnstileGate(c);
    if (turned) return turned;
    const config = c.get("config")!;
    const terms = rejectTerms(c, c.get("jsonBody"), config.termsVersion);
    if (terms) return terms;
    const now = Date.now();
    const db = c.get("db")!;
    for (let attempt = 1; ; attempt++) {
      try {
        const created = await db.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              username: `Guest_${randomHex(5)}`,
              isGuest: true,
              bankroll: config.defaultStartingBankroll,
              avatarHue: randomBelow(360),
              ...termsAcceptance(config.termsVersion, now),
            },
          }) as AccountUser;
          return { user, session: await createSession(c, tx, config, user.id, now) };
        });
        return sendSession(c, config, 201, created.user, created.session);
      } catch (err) {
        if (!uniqueViolation(err) || attempt >= GUEST_NAME_ATTEMPTS) throw err;
        logWarn({ attempt }, "guest username clash; retrying with a new name");
      }
    }
  }));

  app.post("/api/auth/refresh", async (c) => {
    const token = readCookie(c.req.header("cookie"), REFRESH_COOKIE_NAME);
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
      return c.json({ error: "No refresh session" }, 401);
    }
    const secure = requestIsSecure(c.req.url);
    try {
      const { user, sessionId, rotated } = await refreshSession(c, token, Date.now());
      if (rotated) c.header("Set-Cookie", refreshCookie(rotated.token, rotated.expiresAt, secure));
      const accessToken = await signAccessToken(
        c.get("config")!.jwtAccessSecret,
        user.id,
        user.username,
        sessionId,
        Math.floor(c.get("config")!.jwtAccessTtlMs / 1000),
      );
      return c.json({ user: toPublicUser(user), accessToken });
    } catch (err) {
      if (isAuthError(err)) {
        c.header("Set-Cookie", clearRefreshCookie(secure));
        return c.json({ error: "Invalid refresh session" }, 401);
      }
      logWarn({ ...errBrief(err) }, "refresh unavailable; answered 503 and kept the refresh cookie");
      return serviceUnavailable(c);
    }
  });

  app.post("/api/auth/logout", async (c) => {
    const secure = requestIsSecure(c.req.url);
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
    c.header("Set-Cookie", clearRefreshCookie(secure));
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
    if (id === gate.sessionId) c.header("Set-Cookie", clearRefreshCookie(requestIsSecure(c.req.url)));
    return c.body(null, 204);
  }));

  app.post("/api/auth/logout-all", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const body = c.get("jsonBody") as { exceptCurrent?: unknown } | undefined;
    const exceptCurrent = body?.exceptCurrent === true;
    const revoked = await revokeUserSessions(
      c.get("db")!,
      gate.userId,
      "LOGOUT_ALL",
      exceptCurrent ? { exceptSessionId: gate.sessionId } : {},
    );
    await fanoutRevoke(c.env, gate.userId, revoked, "LOGOUT_ALL");
    if (!exceptCurrent) c.header("Set-Cookie", clearRefreshCookie(requestIsSecure(c.req.url)));
    return c.json({ revoked: revoked.length });
  }));

  app.get("/api/auth/me", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const user = await c.get("db")!.user.findUnique({ where: { id: gate.userId } }) as AccountUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ user: toPublicUser(user) });
  }));
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Uniform integer in `[0, max)`. */
function randomBelow(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buf);
    value = buf[0] ?? 0;
  } while (value >= limit);
  return value % max;
}
