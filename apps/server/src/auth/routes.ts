import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { REFRESH_COOKIE_NAME, type PublicUser } from "@poker/shared";
import { z } from "zod";
import type { Prisma, Session, User } from "@prisma/client";
import { authConfig, env, isProd } from "../config.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../logger.js";
import { AuthError, isAuthError, uniqueViolation } from "./errors.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./jwt.js";
import { requireAuth, serviceUnavailable, type AuthedRequest } from "./middleware.js";
import { newSessionLifetime, REFRESH_GRACE_MS, revokeSession, revokeUserSessions, sessionExpiry } from "./sessions.js";
import { canonicalUsername, checkChosenUsername } from "./usernames.js";

export const authRouter = Router();

const BCRYPT_COST = 12;
/**
 * A real cost-12 bcrypt hash of a random secret nobody knows. Login compares
 * against it whenever there is no usable password hash (unknown username,
 * guest, bot, locked account), so every login does the same bcrypt work and
 * the response time does not reveal which case applied.
 */
const DUMMY_PASSWORD_HASH = "$2b$12$9dPEBGq4jOLGMdzdoLFWnuXMLJCYIKMfYQaluwVLqzSoxaT1NZ.ja";
/**
 * Per-account login throttling, independent of the client IP (the IP limiter
 * in app.ts does not stop a botnet guessing one account's password): after
 * LOCK_AFTER consecutive failures the account is locked for LOCK_BASE_MS,
 * doubling with each further failure up to LOCK_MAX_MS. A successful login
 * resets the count. While locked, the password is not checked at all and the
 * answer is the ordinary 401 "Invalid credentials" (same status, body and
 * bcrypt work), so the lock is neither a password oracle nor a signal an
 * attacker can probe; attempts during the lock do not extend it.
 */
export const LOGIN_LOCK_AFTER = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
export function loginLockMs(failures: number): number {
  return failures < LOGIN_LOCK_AFTER ? 0 : Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** Math.min(failures - LOGIN_LOCK_AFTER, 16));
}
const INVALID_CREDENTIALS = "Invalid credentials";
const USERNAME_UNAVAILABLE = "Username unavailable";
/** Deliberately says nothing about which detail clashed (no e-mail enumeration). */
const REGISTRATION_CONFLICT = "Registration could not be completed with these details";
/** Guest names are Guest_ + 10 hex characters (40 random bits); a clash is retried with a new name. */
const GUEST_NAME_ATTEMPTS = 5;

const passwordSchema = z.string().min(12).max(72).refine((v) => Buffer.byteLength(v, "utf8") <= 72);
/**
 * Sign-up (guest or registered) requires accepting the CURRENT terms version
 * and confirming 18+ (DECISIONS.md D9/D10); both are stored on the account.
 */
const termsSchema = z.object({ acceptTerms: z.literal(true), confirmAge: z.literal(true), termsVersion: z.string().min(1).max(64) });

type Db = Prisma.TransactionClient | typeof prisma;

function toPublicUser(user: User): PublicUser {
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

function hashRefresh(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The cookie lapses exactly when the session row and the refresh JWT do. */
function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "strict" : "lax",
    path: "/api/auth",
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
}

/**
 * Run a handler; anything it throws that is not a credential problem is an
 * infrastructure failure (database down, timeout): 503, retryable, and no
 * cookie is touched, so the client keeps its session and simply retries.
 */
function route(handler: (req: AuthedRequest, res: Response) => Promise<void>) {
  return async (req: AuthedRequest, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent) { logger.error({ err, path: req.path }, "auth request failed after responding"); return; }
      if (isAuthError(err)) { res.status(401).json({ error: "Unauthorized" }); return; }
      logger.warn({ err, path: req.path }, "auth request failed; answered 503");
      serviceUnavailable(res);
    }
  };
}

/** False (and the response sent) unless the body accepts the current terms and confirms 18+. */
function acceptsTerms(body: unknown, res: Response): boolean {
  const parsed = termsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Please accept the terms and confirm you are 18 or older", code: "TERMS_REQUIRED" });
    return false;
  }
  if (parsed.data.termsVersion !== authConfig.termsVersion) {
    res.status(409).json({ error: "The terms have been updated; please review and accept the current version", code: "TERMS_OUTDATED", currentVersion: authConfig.termsVersion });
    return false;
  }
  return true;
}
function termsAcceptance(now: number) {
  return { termsVersion: authConfig.termsVersion, termsAcceptedAt: new Date(now), ageConfirmedAt: new Date(now) };
}

interface IssuedSession { sessionId: string; refreshToken: string; expiresAt: Date }
/** One insert: the id is chosen here so the refresh token (and its hash) exist before the row is written. */
async function createSession(db: Db, user: User, req: Request, now: number): Promise<IssuedSession> {
  const sessionId = randomUUID();
  const { absoluteExpiresAt, expiresAt } = newSessionLifetime(now);
  const refreshToken = signRefreshToken(user.id, sessionId, expiresAt);
  await db.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      refreshToken: hashRefresh(refreshToken),
      expiresAt,
      absoluteExpiresAt,
      lastUsedAt: new Date(now),
      userAgent: req.headers["user-agent"]?.slice(0, 256),
      ip: req.ip,
    },
  });
  return { sessionId, refreshToken, expiresAt };
}
function sendSession(res: Response, status: number, user: User, session: IssuedSession): void {
  setRefreshCookie(res, session.refreshToken, session.expiresAt);
  res.status(status).json({ user: toPublicUser(user), accessToken: signAccessToken(user.id, user.username, session.sessionId) });
}

authRouter.post("/register", route(async (req, res) => {
  if (!acceptsTerms(req.body, res)) return;
  const parsed = z
    .object({
      username: z.string(),
      email: z.string().email().max(254).transform((v) => v.toLowerCase()),
      password: passwordSchema,
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration payload" });
    return;
  }
  const name = checkChosenUsername(parsed.data.username);
  if (!name.ok) {
    res.status(name.error === USERNAME_UNAVAILABLE ? 409 : 400).json({ error: name.error });
    return;
  }
  // Hashed before anything is looked up, so the time taken does not depend on
  // whether the username or e-mail exists. The unique indexes decide clashes
  // atomically (no check-then-insert race).
  const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
  const now = Date.now();
  try {
    const { user, session } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: name.username,
          email: parsed.data.email,
          passwordHash,
          bankroll: env.DEFAULT_STARTING_BANKROLL,
          avatarHue: randomInt(360),
          ...termsAcceptance(now),
        },
      });
      return { user, session: await createSession(tx, user, req, now) };
    });
    sendSession(res, 201, user, session);
  } catch (err) {
    const clash = uniqueViolation(err);
    if (clash && /email/i.test(clash.fields)) { res.status(409).json({ error: REGISTRATION_CONFLICT }); return; }
    if (clash && /username/i.test(clash.fields)) { res.status(409).json({ error: USERNAME_UNAVAILABLE }); return; }
    throw err;
  }
}));

async function recordFailedLogin(userId: string, now: number): Promise<void> {
  const { failedLoginCount } = await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } }, select: { failedLoginCount: true } });
  const lockMs = loginLockMs(failedLoginCount);
  if (!lockMs) return;
  await prisma.user.updateMany({ where: { id: userId }, data: { lockedUntil: new Date(now + lockMs) } });
  logger.warn({ security: "LOGIN_LOCKOUT", userId, failures: failedLoginCount, lockMs }, "account locked after repeated failed logins");
}

authRouter.post("/login", route(async (req, res) => {
  const parsed = z
    .object({ username: z.string().min(1).max(24), password: z.string().min(1).max(128).refine((v) => Buffer.byteLength(v, "utf8") <= 72) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload" });
    return;
  }
  const now = Date.now();
  const user = await prisma.user.findUnique({ where: { usernameCanonical: canonicalUsername(parsed.data.username) } });
  const usable = user && user.kind === "HUMAN" && user.passwordHash ? user : null;
  const locked = usable?.lockedUntil != null && usable.lockedUntil.getTime() > now;
  // Exactly one bcrypt comparison on every path (see DUMMY_PASSWORD_HASH).
  const matches = await bcrypt.compare(parsed.data.password, usable && !locked ? usable.passwordHash! : DUMMY_PASSWORD_HASH);
  if (!usable || locked || !matches) {
    if (usable && !locked) await recordFailedLogin(usable.id, now);
    res.status(401).json({ error: INVALID_CREDENTIALS });
    return;
  }
  const fresh = await prisma.user.update({ where: { id: usable.id }, data: { lastSeenAt: new Date(now), failedLoginCount: 0, lockedUntil: null } });
  sendSession(res, 200, fresh, await createSession(prisma, fresh, req, now));
}));

authRouter.post("/guest", route(async (req, res) => {
  if (!acceptsTerms(req.body, res)) return;
  const now = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const { user, session } = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username: `Guest_${randomBytes(5).toString("hex")}`,
            isGuest: true,
            bankroll: env.DEFAULT_STARTING_BANKROLL,
            avatarHue: randomInt(360),
            ...termsAcceptance(now),
          },
        });
        return { user, session: await createSession(tx, user, req, now) };
      });
      sendSession(res, 201, user, session);
      return;
    } catch (err) {
      // A name clash is retried with a fresh name; anything else (or a fifth clash) is a 503.
      if (!uniqueViolation(err) || attempt >= GUEST_NAME_ATTEMPTS) throw err;
      logger.warn({ attempt }, "guest username clash; retrying with a new name");
    }
  }
}));

/** The previous token, presented within the grace window after the rotation that replaced it. */
function withinGrace(session: Pick<Session, "previousTokenHash" | "rotatedAt">, presented: string, now: number): boolean {
  return session.previousTokenHash === presented && session.rotatedAt != null
    && now - session.rotatedAt.getTime() >= 0 && now - session.rotatedAt.getTime() <= REFRESH_GRACE_MS;
}

/**
 * COMPLIANCE NOTE (refresh rotation): every refresh rotates the token and
 * stores the hash of the one it replaced. Presenting:
 * - the current token: rotate (conditional on the stored hash, so of two
 *   concurrent refreshes exactly one rotates) and extend the session to
 *   min(now + idle TTL, absolute expiry);
 * - the token replaced by the last rotation, within REFRESH_GRACE_MS of it
 *   (the other tab of a concurrent pair, or a retry whose response was lost):
 *   a fresh access token only, no rotation and no new cookie (the browser
 *   already holds the winner's cookie);
 * - any other token of this session (older, or the previous one after the
 *   window): someone replayed a refresh token. The session is revoked
 *   (REFRESH_REUSE, a security log line) and every tab must sign in again.
 * Throws AuthError for credential problems; database errors propagate.
 */
async function refreshSession(token: string, now: number): Promise<{ user: User; sessionId: string; rotated: { token: string; expiresAt: Date } | null }> {
  const claims = verifyRefreshToken(token);
  const presented = hashRefresh(token);
  const row = await prisma.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!row || row.userId !== claims.sub) throw new AuthError("REVOKED", "Unknown session");
  if (row.revokedAt) throw new AuthError("REVOKED", "Session revoked");
  if (row.expiresAt.getTime() <= now || row.absoluteExpiresAt.getTime() <= now) throw new AuthError("EXPIRED", "Session expired");
  const { user, ...session } = row;
  if (user.kind !== "HUMAN") throw new AuthError("USER_BLOCKED", "Account cannot sign in");
  if (presented === session.refreshToken) {
    const expiresAt = sessionExpiry(now, session.absoluteExpiresAt);
    const next = signRefreshToken(user.id, session.id, expiresAt);
    const { count } = await prisma.session.updateMany({
      where: { id: session.id, refreshToken: presented, revokedAt: null },
      data: { refreshToken: hashRefresh(next), previousTokenHash: presented, rotatedAt: new Date(now), lastUsedAt: new Date(now), expiresAt },
    });
    if (count === 1) return { user, sessionId: session.id, rotated: { token: next, expiresAt } };
    // A concurrent refresh with the same token rotated first: judge this one against that rotation.
    const current = await prisma.session.findUnique({ where: { id: session.id }, select: { previousTokenHash: true, rotatedAt: true, revokedAt: true } });
    if (current && !current.revokedAt && withinGrace(current, presented, now)) return { user, sessionId: session.id, rotated: null };
    throw new AuthError("REVOKED", "Session already refreshed");
  }
  if (withinGrace(session, presented, now)) return { user, sessionId: session.id, rotated: null };
  await revokeSession(session.id, "REFRESH_REUSE");
  logger.warn({ security: "REFRESH_REUSE", userId: user.id, sessionId: session.id, ip: coarseIp(session.ip) },
    "SECURITY EVENT: a replaced refresh token was presented again; the session was revoked");
  throw new AuthError("REVOKED", "Refresh token reuse");
}

authRouter.post("/refresh", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as unknown;
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    res.status(401).json({ error: "No refresh session" });
    return;
  }
  try {
    const { user, sessionId, rotated } = await refreshSession(token, Date.now());
    if (rotated) setRefreshCookie(res, rotated.token, rotated.expiresAt);
    res.json({ user: toPublicUser(user), accessToken: signAccessToken(user.id, user.username, sessionId) });
  } catch (err) {
    // Only a credential problem ends the session on this device. A database
    // failure keeps the cookie: the client retries after Retry-After.
    if (isAuthError(err)) { clearRefreshCookie(res); res.status(401).json({ error: "Invalid refresh session" }); return; }
    logger.warn({ err }, "refresh unavailable; answered 503 and kept the refresh cookie");
    serviceUnavailable(res);
  }
});

/** Logout revokes the session (the row is kept, revokedAt set) and disconnects its sockets. */
authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as unknown;
  let sessionId: string | null = null;
  if (typeof token === "string" && token.length > 0 && token.length <= 4096) {
    try { sessionId = verifyRefreshToken(token).sid; } catch { /* invalid or expired: nothing left to revoke */ }
  }
  if (sessionId) {
    try {
      await revokeSession(sessionId, "LOGOUT");
    } catch (err) {
      // Not revoked: keep the cookie so the client can retry the logout.
      logger.warn({ err }, "logout could not revoke the session; answered 503");
      serviceUnavailable(res);
      return;
    }
  }
  clearRefreshCookie(res);
  res.status(204).end();
});

/**
 * Coarse network of an address for display (/24 for IPv4, /48 for IPv6): enough
 * to recognize "my home connection", without storing-and-showing the full address.
 */
export function coarseIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const bare = ip.split("%")[0]!;
  const v4 = bare.toLowerCase().startsWith("::ffff:") && isIP(bare.slice(7)) === 4 ? bare.slice(7) : bare;
  if (isIP(v4) === 4) { const [a, b, c] = v4.split("."); return `${a}.${b}.${c}.0/24`; }
  if (isIP(v4) !== 6) return null;
  const [head, tail] = v4.includes("::") ? v4.split("::") as [string, string] : [v4, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === null ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 3).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/48`;
}

authRouter.get("/sessions", requireAuth, route(async (req, res) => {
  const rows = await prisma.session.findMany({
    where: { userId: req.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, createdAt: true, lastUsedAt: true, userAgent: true, ip: true },
  });
  res.json({
    sessions: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      userAgent: row.userAgent,
      ip: coarseIp(row.ip),
      current: row.id === req.sessionId,
    })),
  });
}));

authRouter.delete("/sessions/:id", requireAuth, route(async (req, res) => {
  const id = String(req.params.id ?? "");
  // Another user's session id answers exactly like an unknown one.
  const row = id.length > 0 && id.length <= 128 ? await prisma.session.findUnique({ where: { id }, select: { userId: true } }) : null;
  if (!row || row.userId !== req.userId) { res.status(404).json({ error: "Session not found" }); return; }
  await revokeSession(id, "SESSION_REVOKED");
  if (id === req.sessionId) clearRefreshCookie(res);
  res.status(204).end();
}));

/** Sign out every session of the caller, or every OTHER one with { exceptCurrent: true }. */
authRouter.post("/logout-all", requireAuth, route(async (req, res) => {
  const exceptCurrent = (req.body as { exceptCurrent?: unknown } | undefined)?.exceptCurrent === true;
  const revoked = await revokeUserSessions(req.userId!, "LOGOUT_ALL", exceptCurrent ? { exceptSessionId: req.sessionId } : {});
  if (!exceptCurrent) clearRefreshCookie(res);
  res.json({ revoked });
}));

authRouter.get("/me", requireAuth, route(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ user: toPublicUser(user) });
}));
