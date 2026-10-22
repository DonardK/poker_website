import { STEP_UP_WINDOW_MS, type ReauthMethod } from "@poker/shared";
import type { Ctx, GateOk } from "../http/guard";
import { includesSecondFactor, readFactors, type Factors } from "./factors";

/**
 * Step-up for account changes: Session.reauthAt / reauthMethods, written by
 * every sign-in and by the /api/auth/reauth/* routes. "Fresh" means within
 * STEP_UP_WINDOW_MS (5 minutes). A refresh never renews it.
 *
 * Money uses a stronger, single-use, action-bound StepUpGrant instead
 * (step-up-grants.ts); requireMoneyAuth below is the session-level check the
 * payments routes add on top.
 */

type SessionWindow = { reauthAt: Date | string | null; reauthMethods?: readonly string[] | null };

/** End of the step-up window, or null when it has passed. */
export function stepUpUntil(session: SessionWindow, now = Date.now()): Date | null {
  if (session.reauthAt == null) return null;
  const until = new Date(session.reauthAt).getTime() + STEP_UP_WINDOW_MS;
  return until > now ? new Date(until) : null;
}

export interface StepUpOptions {
  /** The step-up must have verified the password (password change). */
  needPassword?: boolean;
  /** The step-up must have included a second factor (money, admin). Implied when the account has TOTP. */
  needSecondFactor?: boolean;
  /** Already read by the caller. */
  factors?: Factors;
}

/**
 * Null when the session stepped up recently enough (and with the right
 * methods); otherwise the 403 REAUTH_REQUIRED body. Never 401: the session
 * itself is fine and the client must not mistake this for a dead session.
 *
 * An account with TOTP needs a second factor in the step-up. The reauth
 * routes never write one without it, and this also covers a session that
 * signed in with only a password before TOTP was enabled elsewhere.
 */
export async function requireStepUp(c: Ctx, gate: GateOk, opts: StepUpOptions = {}): Promise<Response | null> {
  const methods = gate.session.reauthMethods ?? [];
  const fresh = stepUpUntil(gate.session) !== null;
  const factors = opts.factors ?? await readFactors(c.get("db")!, gate.userId);
  const needSecond = opts.needSecondFactor === true || factors.totpEnabled;
  let needs: "password" | "second_factor" | undefined;
  if (opts.needPassword && !methods.includes("pwd")) needs = "password";
  else if (needSecond && !includesSecondFactor(methods)) needs = "second_factor";
  if (fresh && needs === undefined) return null;
  const offered: ReauthMethod[] = [];
  if (gate.user.passwordHash) offered.push("password");
  if (factors.passkeys > 0 && c.get("config")!.webauthn && !opts.needPassword) offered.push("passkey");
  return c.json({
    error: "Please confirm it's you",
    code: "REAUTH_REQUIRED",
    methods: offered,
    ...(needs ? { needs } : {}),
  }, 403);
}

/** 403 SECURITY_HOLD while withdrawals and payout-destination changes are held after a credential change. */
export function assertNoSecurityHold(c: Ctx, user: { securityHoldUntil: Date | string | null }, now = Date.now()): Response | null {
  if (user.securityHoldUntil == null) return null;
  const until = new Date(user.securityHoldUntil);
  if (until.getTime() <= now) return null;
  return c.json({
    error: "For your security, withdrawals are paused for a while after a recent account change.",
    code: "SECURITY_HOLD",
    until: until.toISOString(),
  }, 403);
}

/**
 * The session-level checks for a money route (payments work), in order:
 * a verified email (403 EMAIL_NOT_VERIFIED), a fresh step-up that included a
 * second factor when the account has one (or when asked), and no security
 * hold. The money action itself must also consume a StepUpGrant.
 */
export async function requireMoneyAuth(c: Ctx, gate: GateOk, opts: { needSecondFactor: boolean }): Promise<Response | null> {
  if (gate.user.emailVerifiedAt == null) {
    return c.json({ error: "Confirm your email address first.", code: "EMAIL_NOT_VERIFIED" }, 403);
  }
  const factors = await readFactors(c.get("db")!, gate.userId);
  const stepUp = await requireStepUp(c, gate, { factors, needSecondFactor: opts.needSecondFactor || factors.totpEnabled || factors.passkeys > 0 });
  if (stepUp) return stepUp;
  return assertNoSecurityHold(c, gate.user);
}
