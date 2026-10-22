import type { AuthMethod, MfaChallenge, StepUpResult } from "@poker/shared";
import { STEP_UP_PURPOSES, STEP_UP_WINDOW_MS } from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { findKnownDevice, readDevice } from "../auth/devices";
import { readFactors } from "../auth/factors";
import { addressHistory, familiarScope } from "../auth/lockout";
import { checkPassword } from "../auth/password-check";
import { presentedPasswordSchema } from "../auth/password-policy";
import {
  clearSecondFactorFailures, recordSecondFactorFailure, reserveSecondFactorAttempt, secondFactorLockedFor, verifySecondFactor,
} from "../auth/second-factor";
import { recordSecurityEvent } from "../auth/security-events";
import { consumeNonce, nonceExpiry, nonceUsed, signMfaTicket, verifyMfaTicket } from "../auth/tickets";
import { authenticationOptions } from "../auth/webauthn";
import { prepareNotice, sendMail } from "../mail/notify";
import { mfaBody, mfaLocked, securityNotConfigured } from "./auth";
import { assertionBody, checkAssertion, issueChallenge, passkeySetup, passkeysUnavailable, recordPasskeyUse, type PasskeyRow } from "./auth-passkey";
import type { AppDb } from "./db";
import { authRoute, authed, requestFacts, type Ctx, type GateOk } from "./guard";

/**
 * Step-up for account changes: confirm it's you, then the session may make
 * sensitive changes for STEP_UP_WINDOW_MS (Session.reauthAt / reauthMethods).
 * For an account with TOTP, the password alone never opens the window: it
 * returns an MFA ticket and /reauth/mfa finishes it. A passkey with user
 * verification opens it on its own.
 */

export const BIND_HASH = /^[0-9a-f]{64}$/;

async function openWindow(c: Ctx, db: AppDb, gate: GateOk, methods: AuthMethod[], data: Record<string, unknown> = {}): Promise<StepUpResult> {
  const now = new Date();
  const { count } = await db.session.updateMany({ where: { id: gate.sessionId, revokedAt: null }, data: { reauthAt: now, reauthMethods: methods } });
  if (count !== 1) throw new Error("session ended during step-up");
  await recordSecurityEvent(db, { userId: gate.userId, type: "STEP_UP", sessionId: gate.sessionId, facts: requestFacts(c), data: { methods, ...data } });
  return { reauthenticatedUntil: new Date(now.getTime() + STEP_UP_WINDOW_MS).toISOString() };
}

const INVALID_CREDENTIALS = { error: "Invalid credentials" } as const;

/**
 * The password half of a step-up (also used by the money step-up): the same
 * lock, single PBKDF2 and failure counting as sign-in. Null when it failed.
 */
export async function verifyStepUpPassword(c: Ctx, db: AppDb, gate: GateOk, password: string): Promise<{ rehash: string | null } | null> {
  const now = Date.now();
  const facts = requestFacts(c);
  const device = await readDevice(c.req.header("cookie"));
  const known = await findKnownDevice(db, gate.userId, device?.hash ?? null);
  const history = await addressHistory(db, gate.userId, facts.ip, now);
  const check = await checkPassword(db, c.get("config")!, gate.user, password, {
    familiar: history.familiar || known !== null,
    scope: familiarScope(facts.ip, known && device ? device.hash : null),
    now,
    facts,
  });
  if (!check.ok) return null;
  const user = gate.user;
  if (user.failedLoginCount !== 0 || user.lockedUntil != null || check.rehash) {
    await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, ...(check.rehash ? { passwordHash: check.rehash } : {}) }, select: { id: true } });
  }
  return { rehash: check.rehash };
}

export function registerReauth(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/auth/reauth/password", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = z.object({ password: presentedPasswordSchema }).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const db = c.get("db")!;
    const config = c.get("config")!;
    if (!await verifyStepUpPassword(c, db, gate, parsed.data.password)) return c.json(INVALID_CREDENTIALS, 401);
    const factors = await readFactors(db, gate.userId);
    if (factors.totpEnabled) {
      if (!config.security) return securityNotConfigured(c);
      const ticket = await signMfaTicket(config.security.hmacSecret, {
        pur: "reauth", sub: gate.userId, sid: gate.sessionId, cv: gate.user.credentialsVersion, rem: gate.session.persistent, amr: ["pwd"],
      });
      const challenge: MfaChallenge = { mfaRequired: true, mfaTicket: ticket.token, methods: ["totp", "backup_code"], expiresAt: ticket.expiresAt.toISOString() };
      return c.json(challenge);
    }
    return c.json(await openWindow(c, db, gate, ["pwd"]));
  }));

  app.post("/api/auth/reauth/mfa", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = mfaBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const config = c.get("config")!;
    if (!config.security) return securityNotConfigured(c);
    const db = c.get("db")!;
    const now = new Date();
    const expired = () => c.json({ error: "Confirmation expired. Start again.", code: "MFA_TICKET_INVALID" }, 401);
    const claims = await verifyMfaTicket(config.security.hmacSecret, parsed.data.mfaTicket, "reauth");
    if (!claims || claims.sub !== gate.userId || claims.sid !== gate.sessionId || claims.cv !== gate.user.credentialsVersion) return expired();
    // An authenticated session: the account-wide counter applies (a stolen session cannot brute-force codes per isolate).
    const scope = { userId: gate.userId, knownDeviceHash: null };
    const locked = secondFactorLockedFor(gate.user, scope, now);
    if (locked > 0) return mfaLocked(c, locked);
    if (await nonceUsed(db, claims.jti)) return expired();
    // Counted before the code is checked, so parallel guesses are held to the lock schedule.
    const attempt = await reserveSecondFactorAttempt(db, gate.user, scope, now);
    if (!attempt.ok) return mfaLocked(c, attempt.retryAfterS);
    const result = await verifySecondFactor(db, config, gate.userId, parsed.data.method, parsed.data.code, now);
    if (!result.ok) {
      await recordSecondFactorFailure(db, attempt, requestFacts(c));
      if (attempt.lockMs) await consumeNonce(db, claims.jti, "mfa:reauth", nonceExpiry(claims));
      return c.json({ error: "Invalid code", code: "MFA_INVALID" }, 401);
    }
    if (!await consumeNonce(db, claims.jti, "mfa:reauth", nonceExpiry(claims))) return expired();
    await clearSecondFactorFailures(db, attempt);
    const window = await openWindow(c, db, gate, ["pwd", result.amr]);
    if (result.amr === "backup") {
      await sendMail(c, await prepareNotice(db, config, gate.user, "BACKUP_CODE_USED", { now, details: { remaining: result.remainingBackupCodes ?? 0 } }));
    }
    return c.json(window);
  }));

  app.post("/api/auth/reauth/passkey/options", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const setup = passkeySetup(c.get("config")!);
    if (!setup) return passkeysUnavailable(c);
    // Optional money binding: the assertion is then tied to one StepUpGrant purpose and bind hash.
    const parsed = z.object({
      purpose: z.enum(STEP_UP_PURPOSES).optional(),
      bind: z.string().regex(BIND_HASH).optional(),
    }).refine((value) => (value.purpose === undefined) === (value.bind === undefined)).safeParse(c.get("jsonBody") ?? {});
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const passkeys = await c.get("db")!.webAuthnCredential.findMany({
      where: { userId: gate.userId, removedAt: null },
      select: { credentialId: true, transports: true },
    }) as Pick<PasskeyRow, "credentialId" | "transports">[];
    if (passkeys.length === 0) return c.json({ error: "This account has no passkeys.", code: "NO_PASSKEYS" }, 409);
    const options = await authenticationOptions(setup.webauthn, passkeys.map((row) => ({ credentialId: row.credentialId, transports: row.transports ?? [] })));
    return c.json(await issueChallenge(setup.secret, options, {
      pur: "reauth",
      sub: gate.userId,
      sid: gate.sessionId,
      ...(parsed.data.purpose ? { gp: parsed.data.purpose, gb: parsed.data.bind } : {}),
    }));
  }));

  app.post("/api/auth/reauth/passkey", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = assertionBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const db = c.get("db")!;
    const check = await checkAssertion(c, db, {
      challengeToken: parsed.data.challengeToken,
      credential: parsed.data.credential,
      purpose: "reauth",
      owner: { userId: gate.userId, sessionId: gate.sessionId },
    });
    if (!check.ok) return check.response;
    await recordPasskeyUse(db, check, new Date());
    return c.json(await openWindow(c, db, gate, ["passkey"], { passkeyId: check.passkey.id }));
  }));
}
