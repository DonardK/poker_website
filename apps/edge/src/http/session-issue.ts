import type { AuthMethod, PublicUser } from "@poker/shared";
import { REFRESH_COOKIE_NAME } from "@poker/shared";
import type { EdgeConfig } from "../env";
import type { DeviceCookie } from "../auth/devices";
import { deviceLabel, touchDevice } from "../auth/devices";
import { readFactors } from "../auth/factors";
import { coarseIp } from "../auth/ip";
import type { AddressHistory } from "../auth/lockout";
import { recordSecurityEvent } from "../auth/security-events";
import { hashRefresh, newSessionLifetime } from "../auth/sessions";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../auth/tokens";
import { prepareNotice, sendMail } from "../mail/notify";
import type { MailMessage } from "../mail/transport";
import { clearHintCookie, clearRefreshCookie, deviceCookie, hintCookie, readCookie, refreshCookie, requestIsSecure } from "./cookies";
import type { AppDb } from "./db";
import { requestFacts, type Ctx } from "./guard";
import { fanoutRevoke } from "./realtime";

/**
 * Issuing a session: the one path every sign-in takes (register, password,
 * password + second factor, passkey). It writes the device, the session (with
 * the step-up window opened by the sign-in itself), the sign-in event and,
 * when due, a new-sign-in alert, all in one transaction; then sets the
 * refresh, hint and device cookies and answers { user, accessToken }.
 */

/** The user columns the auth routes read. */
export interface AccountUser {
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
  emailVerifiedAt: Date | null;
  credentialsVersion: number;
  passwordChangedAt: Date | null;
  passwordResetRequired: boolean;
  mfaFailedCount: number;
  mfaLockedUntil: Date | null;
  securityHoldUntil: Date | null;
  webauthnUserId: string | null;
  termsVersion: string | null;
}

export interface SecurityExtras {
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  passkeyCount: number;
}

export function toPublicUser(user: AccountUser, extras?: SecurityExtras): PublicUser {
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
    termsVersion: user.termsVersion ?? null,
    ...(extras ?? {}),
  };
}

/** The optional PublicUser fields sent by sign-in and /me (not by refresh). */
export async function securityExtras(db: AppDb, user: AccountUser, known: Partial<SecurityExtras> = {}): Promise<SecurityExtras> {
  const needFactors = known.twoFactorEnabled === undefined || known.passkeyCount === undefined;
  const factors = needFactors ? await readFactors(db, user.id) : null;
  return {
    emailVerified: user.emailVerifiedAt != null,
    twoFactorEnabled: known.twoFactorEnabled ?? factors!.totpEnabled,
    passkeyCount: known.passkeyCount ?? factors!.passkeys,
  };
}

export function appendCookie(c: Ctx, value: string): void {
  c.header("Set-Cookie", value, { append: true });
}

/** The refresh cookie and, with the same lifetime, the poker_session_hint redirect hint. */
export function setSessionCookies(c: Ctx, refreshToken: string, expiresAt: Date, persistent: boolean): void {
  const secure = requestIsSecure(c.req.url);
  appendCookie(c, refreshCookie(refreshToken, expiresAt, secure, persistent));
  appendCookie(c, hintCookie(expiresAt, secure, persistent));
}

/** Every path that clears the refresh cookie clears the hint too. */
export function clearSessionCookies(c: Ctx): void {
  const secure = requestIsSecure(c.req.url);
  appendCookie(c, clearRefreshCookie(secure));
  appendCookie(c, clearHintCookie(secure));
}

export function setDeviceCookie(c: Ctx, device: DeviceCookie): void {
  if (device.minted) appendCookie(c, deviceCookie(device.value, requestIsSecure(c.req.url)));
}

export function issueAccessToken(config: EdgeConfig, user: { id: string; username: string }, sessionId: string): Promise<string> {
  return signAccessToken(config.jwtAccessSecret, user.id, user.username, sessionId, Math.floor(config.jwtAccessTtlMs / 1000));
}

/** The session named by a still-valid refresh cookie sent with this request (no database read). */
async function presentedSession(c: Ctx): Promise<{ sid: string; sub: string } | null> {
  const token = readCookie(c.req.header("cookie"), REFRESH_COOKIE_NAME);
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
  try {
    const claims = await verifyRefreshToken(c.get("config")!.jwtRefreshSecret, token);
    return { sid: claims.sid, sub: claims.sub };
  } catch {
    return null;
  }
}

export interface SignInInput {
  /** Runs first inside the transaction and returns the signing-in user: create (register) or update (sign-in). */
  user(tx: AppDb, now: Date): Promise<AccountUser>;
  amr: AuthMethod[];
  /** "Keep me signed in". */
  remember: boolean;
  device: DeviceCookie;
  /** For the new-sign-in alert rule. */
  history: AddressHistory;
  /** Registration: no alert, and the event says so. */
  registered?: boolean;
  status?: 200 | 201;
  /** Known PublicUser extras (saves queries). */
  extras?: Partial<SecurityExtras>;
  /** More work in the same transaction (register: the verification token). Returns mail to send after commit. */
  alsoInTransaction?(tx: AppDb, user: AccountUser, now: Date): Promise<MailMessage | null>;
}

export async function completeSignIn(c: Ctx, db: AppDb, input: SignInInput): Promise<Response> {
  const config = c.get("config")!;
  const facts = requestFacts(c);
  const now = new Date();
  const previous = await presentedSession(c);
  const sessionId = crypto.randomUUID();
  const { absoluteExpiresAt, expiresAt } = newSessionLifetime(now.getTime(), config.sessionIdleTtlMs, config.sessionAbsoluteTtlMs, input.remember);
  const result = await db.$transaction(async (tx) => {
    const user = await input.user(tx, now);
    const refreshToken = await signRefreshToken(config.jwtRefreshSecret, user.id, sessionId, expiresAt);
    // "Sign out, then sign in": a refresh cookie that came with this sign-in ends its session.
    const revokedPrevious = previous
      ? (await tx.session.updateMany({ where: { id: previous.sid, userId: previous.sub, revokedAt: null }, data: { revokedAt: now, revokeReason: "LOGOUT" } })).count === 1
      : false;
    const device = await touchDevice(tx, { userId: user.id, hash: input.device.hash, userAgent: facts.userAgent, ip: facts.ip, country: facts.country, now });
    await tx.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshToken: await hashRefresh(refreshToken),
        expiresAt,
        absoluteExpiresAt,
        lastUsedAt: now,
        userAgent: facts.userAgent,
        ip: facts.ip,
        deviceId: device.id,
        persistent: input.remember,
        authMethods: input.amr,
        reauthAt: now,
        reauthMethods: input.amr,
      },
    });
    const newDevice = device.created && !input.registered;
    await recordSecurityEvent(tx, {
      userId: user.id,
      type: newDevice ? "SIGN_IN_NEW_DEVICE" : "SIGN_IN",
      sessionId,
      facts,
      data: { methods: input.amr, ...(input.registered ? { registered: true } : {}), ...(input.remember ? {} : { persistent: false }) },
    });
    // Alert rule: a new device, a verified email, and either another known
    // device already exists or (sessions in the last 90 days and the address
    // is unfamiliar). The second part avoids an alert storm right after rollout.
    const alertDue = newDevice && (device.otherDevices > 0 || (input.history.recentSessions && !input.history.familiar));
    const alert = alertDue
      ? await prepareNotice(tx, config, user, "NEW_SIGN_IN", {
        now,
        data: { sessionId },
        details: { when: now.toISOString().replace("T", " ").slice(0, 16), device: deviceLabel(facts.userAgent), country: facts.country, ip: coarseIp(facts.ip) },
      })
      : null;
    const extra = input.alsoInTransaction ? await input.alsoInTransaction(tx, user, now) : null;
    return { user, refreshToken, alert, extra, revokedPrevious };
  });
  if (result.revokedPrevious && previous) await fanoutRevoke(c.env, previous.sub, [previous.sid], "LOGOUT");
  setSessionCookies(c, result.refreshToken, expiresAt, input.remember);
  setDeviceCookie(c, input.device);
  const accessToken = await issueAccessToken(config, result.user, sessionId);
  const extras = await securityExtras(db, result.user, input.extras);
  const response = c.json({ user: toPublicUser(result.user, extras), accessToken }, input.status ?? 200);
  await sendMail(c, result.alert, result.extra);
  return response;
}
