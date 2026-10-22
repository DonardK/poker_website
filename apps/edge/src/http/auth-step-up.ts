import type { StepUpEmailCodeResponse, StepUpGrantResponse, StepUpPurpose } from "@poker/shared";
import { STEP_UP_EMAIL_CODE_MAX_ATTEMPTS, STEP_UP_EMAIL_CODE_TTL_MS, STEP_UP_PURPOSES } from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { readFactors } from "../auth/factors";
import { presentedPasswordSchema } from "../auth/password-policy";
import { recordSecondFactorFailure, secondFactorRetryAfter, clearSecondFactorFailures, verifySecondFactor } from "../auth/second-factor";
import { recordSecurityEvent } from "../auth/security-events";
import { assertNoSecurityHold } from "../auth/step-up";
import {
  createGrant, EMAIL_CODE_HOURLY_CAP, emailCodeExpiry, emailCodeMatches, hashEmailCode, methodRefusal, newEmailCode, PROOF_METHOD,
  PURPOSE_LABEL, type ProofKind,
} from "../auth/step-up-grants";
import { prepareNotice, sendMail } from "../mail/notify";
import { stepUpCode } from "../mail/templates";
import { mailUnavailable, type MailMessage } from "../mail/transport";
import { mfaLocked, securityNotConfigured } from "./auth";
import { checkAssertion, recordPasskeyUse } from "./auth-passkey";
import { BIND_HASH, verifyStepUpPassword } from "./auth-reauth";
import { authRoute, authed, Refusal, requestFacts, type Ctx } from "./guard";

/**
 * POST /api/auth/step-up and /api/auth/step-up/email-code: single-use,
 * action-bound grants for money (step-up-grants.ts). The session-level
 * window (auth-reauth.ts) never authorises money on its own.
 */

const CHALLENGE_INVALID = { error: "This confirmation expired. Request a new code.", code: "CHALLENGE_INVALID" } as const;

const target = {
  purpose: z.enum(STEP_UP_PURPOSES),
  bind: z.string().regex(BIND_HASH),
};

const grantBody = z.object({
  ...target,
  proof: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("passkey"), challengeToken: z.string().min(1).max(2048), credential: z.unknown() }),
    z.object({ kind: z.literal("totp"), password: presentedPasswordSchema, code: z.string().min(1).max(16) }),
    z.object({
      kind: z.literal("password_email"),
      password: presentedPasswordSchema,
      emailCode: z.string().regex(/^\d{6}$/),
      emailChallengeToken: z.string().min(1).max(128),
    }),
  ]),
});

function methodNotAllowed(c: Ctx, message: string): Response {
  return c.json({ error: message, code: "STEP_UP_METHOD_NOT_ALLOWED" }, 403);
}

/** Withdrawals and payout-destination changes stay held after a credential change; admin decisions are not held. */
function holdFor(c: Ctx, purpose: StepUpPurpose, user: { securityHoldUntil: Date | string | null }): Response | null {
  return purpose === "admin_payments" ? null : assertNoSecurityHold(c, user);
}

interface ChallengeRow {
  id: string;
  userId: string;
  sessionId: string;
  purpose: string;
  bindHash: string;
  codeHash: string;
  email: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

export function registerStepUp(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/auth/step-up/email-code", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = z.object(target).safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const config = c.get("config")!;
    if (!config.security) return securityNotConfigured(c);
    const db = c.get("db")!;
    const { purpose, bind } = parsed.data;
    const refusal = methodRefusal(purpose, "password_email", await readFactors(db, gate.userId));
    if (refusal) return methodNotAllowed(c, refusal);
    const user = gate.user;
    if (!user.email) return c.json({ error: "Add an email address first.", code: "EMAIL_MISSING" }, 409);
    if (user.emailVerifiedAt == null) return c.json({ error: "Confirm your email address first.", code: "EMAIL_NOT_VERIFIED" }, 403);
    const held = holdFor(c, purpose, user);
    if (held) return held;
    if (mailUnavailable(c.env, config)) return c.json({ error: "Email is not available right now.", code: "MAIL_UNAVAILABLE", retryable: false }, 503);
    const now = new Date();
    const recent = await db.stepUpEmailChallenge.count({ where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
    if (recent >= EMAIL_CODE_HOURLY_CAP) {
      c.header("Retry-After", "900");
      return c.json({ error: "Too many codes requested. Try again later." }, 429);
    }
    const id = crypto.randomUUID();
    const code = newEmailCode();
    const expiresAt = emailCodeExpiry(now);
    await db.$transaction(async (tx) => {
      // One live code per session: requesting a new one voids the old.
      await tx.stepUpEmailChallenge.updateMany({ where: { sessionId: gate.sessionId, consumedAt: null }, data: { consumedAt: now } });
      await tx.stepUpEmailChallenge.create({
        data: {
          id,
          userId: user.id,
          sessionId: gate.sessionId,
          purpose,
          bindHash: bind,
          codeHash: await hashEmailCode(config.security!.hmacSecret, id, code),
          email: user.email!,
          attempts: 0,
          createdAt: now,
          expiresAt,
        },
      });
    });
    const message: MailMessage = {
      kind: "STEP_UP_CODE",
      to: user.email,
      userId: user.id,
      idempotencyKey: `STEP_UP_CODE:${id}`,
      devSecret: code,
      ...stepUpCode({ username: user.username, code, purpose: PURPOSE_LABEL[purpose], minutes: Math.round(STEP_UP_EMAIL_CODE_TTL_MS / 60_000) }),
    };
    await sendMail(c, message);
    const body: StepUpEmailCodeResponse = { emailChallengeToken: id, expiresAt: expiresAt.toISOString() };
    return c.json(body, 202);
  }));

  app.post("/api/auth/step-up", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = grantBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid request payload" }, 400);
    const config = c.get("config")!;
    if (!config.security) return securityNotConfigured(c);
    const db = c.get("db")!;
    const facts = requestFacts(c);
    const { purpose, bind, proof } = parsed.data;
    const kind: ProofKind = proof.kind;
    const refusal = methodRefusal(purpose, kind, await readFactors(db, gate.userId));
    if (refusal) return methodNotAllowed(c, refusal);
    const held = holdFor(c, purpose, gate.user);
    if (held) return held;
    let notice: MailMessage | null = null;
    let challenge: ChallengeRow | null = null;

    if (proof.kind === "passkey") {
      const check = await checkAssertion(c, db, {
        challengeToken: proof.challengeToken,
        credential: proof.credential,
        purpose: "reauth",
        owner: { userId: gate.userId, sessionId: gate.sessionId },
        binding: { purpose, bind },
      });
      if (!check.ok) return check.response;
      await recordPasskeyUse(db, check, new Date());
    } else {
      if (!await verifyStepUpPassword(c, db, gate, proof.password)) return c.json({ error: "Invalid credentials" }, 401);
      if (proof.kind === "totp") {
        const now = new Date();
        const scope = { userId: gate.userId, knownDeviceHash: null };
        const retryAfter = secondFactorRetryAfter(gate.user, scope, now.getTime());
        if (retryAfter > 0) return mfaLocked(c, retryAfter);
        const code = proof.code.trim();
        const result = await verifySecondFactor(db, config, gate.userId, /^\d{6}$/.test(code) ? "totp" : "backup_code", code, now);
        if (!result.ok) {
          await recordSecondFactorFailure(db, scope, now, facts);
          return c.json({ error: "Invalid code", code: "MFA_INVALID" }, 401);
        }
        await clearSecondFactorFailures(db, scope, gate.user);
        if (result.amr === "backup") {
          notice = await prepareNotice(db, config, gate.user, "BACKUP_CODE_USED", { now, details: { remaining: result.remainingBackupCodes ?? 0 } });
        }
      } else {
        challenge = await db.stepUpEmailChallenge.findUnique({ where: { id: proof.emailChallengeToken } }) as ChallengeRow | null;
        const now = Date.now();
        const live = challenge !== null && challenge.userId === gate.userId && challenge.sessionId === gate.sessionId
          && challenge.purpose === purpose && challenge.bindHash === bind && challenge.consumedAt == null
          && new Date(challenge.expiresAt).getTime() > now && challenge.attempts < STEP_UP_EMAIL_CODE_MAX_ATTEMPTS
          && challenge.email === gate.user.email;
        if (!live) return c.json(CHALLENGE_INVALID, 400);
        if (!await emailCodeMatches(config.security.hmacSecret, challenge!.id, proof.emailCode, challenge!.codeHash)) {
          await db.stepUpEmailChallenge.updateMany({
            where: { id: challenge!.id, consumedAt: null, attempts: { lt: STEP_UP_EMAIL_CODE_MAX_ATTEMPTS } },
            data: { attempts: { increment: 1 } },
          });
          const left = Math.max(0, STEP_UP_EMAIL_CODE_MAX_ATTEMPTS - challenge!.attempts - 1);
          return c.json({ error: "That code is not right.", code: "EMAIL_CODE_INVALID", attemptsRemaining: left }, 401);
        }
      }
    }

    const now = new Date();
    const grant = await db.$transaction(async (tx) => {
      if (challenge) {
        const { count } = await tx.stepUpEmailChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null, attempts: { lt: STEP_UP_EMAIL_CODE_MAX_ATTEMPTS }, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (count !== 1) throw new Refusal(400, { ...CHALLENGE_INVALID });
      }
      const issued = await createGrant(tx, { userId: gate.userId, sessionId: gate.sessionId, purpose, bindHash: bind, method: PROOF_METHOD[kind], now });
      await recordSecurityEvent(tx, {
        userId: gate.userId,
        type: "STEP_UP",
        sessionId: gate.sessionId,
        facts,
        data: { purpose, method: PROOF_METHOD[kind], grantId: issued.id },
      });
      return issued;
    });
    await sendMail(c, notice);
    const body: StepUpGrantResponse = { stepUpGrantId: grant.id, expiresAt: grant.expiresAt.toISOString() };
    return c.json(body);
  }));
}
