import type { PasskeyOptionsResponse } from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { EdgeConfig, Env, WebAuthnConfig } from "../env";
import { readOrMintDevice } from "../auth/devices";
import { addressHistory } from "../auth/lockout";
import { consumeNonce, nonceExpiry, signChallenge, verifyChallenge, type ChallengeClaims, type ChallengePurpose } from "../auth/tickets";
import { authenticationOptions, credentialIdOf, userHandleOf, verifyAuthentication } from "../auth/webauthn";
import { signedInData } from "./auth";
import type { AppDb } from "./db";
import { authRoute, requestFacts, type Ctx } from "./guard";
import { logWarn } from "./log";
import { completeSignIn, type AccountUser } from "./session-issue";

/**
 * Passkey sign-in (discoverable credentials, user verification required).
 * A passkey with user verification counts as two factors on its own, so it
 * also signs in an account with TOTP, and it stays open while a lockdown
 * requires a password reset (any passkey left then predates the incident).
 */

export interface PasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: bigint | number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  rpId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  removedAt: Date | null;
}

export const PASSKEY_INVALID = { error: "Passkey not recognised", code: "PASSKEY_INVALID" } as const;
export const CHALLENGE_INVALID = { error: "Passkey request expired. Try again.", code: "CHALLENGE_INVALID" } as const;

export function passkeysUnavailable(c: Ctx): Response {
  return c.json({ error: "Passkeys are not available right now.", code: "PASSKEYS_UNAVAILABLE", retryable: false }, 503);
}

export const assertionBody = z.object({
  challengeToken: z.string().min(1).max(2048),
  credential: z.unknown(),
  remember: z.boolean().optional(),
});

/** Passkey config and the challenge secret, or null when passkeys are off. */
export function passkeySetup(config: EdgeConfig): { webauthn: WebAuthnConfig; secret: string } | null {
  return config.webauthn && config.security ? { webauthn: config.webauthn, secret: config.security.hmacSecret } : null;
}

export async function issueChallenge(
  secret: string,
  options: { options: unknown; challenge: string },
  claims: Omit<ChallengeClaims, "typ" | "jti" | "exp" | "chal">,
): Promise<PasskeyOptionsResponse> {
  return { options: options.options, challengeToken: await signChallenge(secret, { ...claims, chal: options.challenge }) };
}

export type AssertionCheck =
  | { ok: true; passkey: PasskeyRow; user: AccountUser; claims: ChallengeClaims; newCounter: number; deviceType: string; backedUp: boolean }
  | { ok: false; response: Response };

/**
 * Verify a passkey assertion against a signed challenge. Every failure about
 * the credential gives the same PASSKEY_INVALID body: unknown, removed,
 * someone else's, a bot or guest account, a user-handle mismatch or a bad
 * signature. `owner` limits it to one account (step-up). The challenge
 * nonce is consumed last, after the signature verified.
 */
export async function checkAssertion(c: Ctx, db: AppDb, input: {
  challengeToken: string;
  credential: unknown;
  purpose: ChallengePurpose;
  owner?: { userId: string; sessionId: string };
  /** Money step-up: the challenge must have been issued for this purpose and bind hash (reauth/passkey/options with both). */
  binding?: { purpose: string; bind: string };
}): Promise<AssertionCheck> {
  const setup = passkeySetup(c.get("config")!);
  if (!setup) return { ok: false, response: passkeysUnavailable(c) };
  const claims = await verifyChallenge(setup.secret, input.challengeToken, input.purpose);
  // A money grant needs a challenge issued for exactly its purpose and bind hash; a bound
  // challenge is good for nothing else (it cannot open the account-change window).
  const misbound = input.binding === undefined
    ? claims?.gp !== undefined || claims?.gb !== undefined
    : claims?.gp !== input.binding.purpose || claims?.gb !== input.binding.bind;
  if (!claims || misbound || (input.owner && (claims.sub !== input.owner.userId || claims.sid !== input.owner.sessionId))) {
    return { ok: false, response: c.json(CHALLENGE_INVALID, 400) };
  }
  const invalid = (): AssertionCheck => ({ ok: false, response: c.json(PASSKEY_INVALID, 401) });
  const credentialId = credentialIdOf(input.credential);
  if (!credentialId) return invalid();
  const passkey = await db.webAuthnCredential.findUnique({ where: { credentialId } }) as PasskeyRow | null;
  if (!passkey || passkey.removedAt != null || (input.owner && passkey.userId !== input.owner.userId)) return invalid();
  const user = await db.user.findUnique({ where: { id: passkey.userId } }) as AccountUser | null;
  if (!user || user.kind !== "HUMAN" || user.isGuest) return invalid();
  const handle = userHandleOf(input.credential);
  if (handle !== null && handle !== user.webauthnUserId) return invalid();
  const result = await verifyAuthentication(setup.webauthn, input.credential, claims.chal, {
    credentialId: passkey.credentialId,
    publicKey: passkey.publicKey,
    counter: Number(passkey.counter),
    transports: passkey.transports ?? [],
    rpId: passkey.rpId,
  });
  if (!result.ok) {
    if (result.counterRegression) {
      logWarn({ security: "PASSKEY_COUNTER_REGRESSION", userId: user.id, passkeyId: passkey.id }, "SECURITY EVENT: a passkey signature counter did not increase (possible cloned authenticator)");
    }
    return invalid();
  }
  if (!await consumeNonce(db, claims.jti, `webauthn:${input.purpose}`, nonceExpiry(claims))) {
    return { ok: false, response: c.json(CHALLENGE_INVALID, 400) };
  }
  return { ok: true, passkey, user, claims, newCounter: result.newCounter, deviceType: result.deviceType, backedUp: result.backedUp };
}

/** After a verified assertion: the counter, the last use and the backup state. */
export async function recordPasskeyUse(db: AppDb, check: Extract<AssertionCheck, { ok: true }>, now: Date): Promise<void> {
  await db.webAuthnCredential.updateMany({
    where: { id: check.passkey.id },
    data: { counter: check.newCounter, lastUsedAt: now, backedUp: check.backedUp, deviceType: check.deviceType },
  });
}

export function registerPasskeyAuth(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/auth/passkey/options", authRoute(async (c) => {
    const setup = passkeySetup(c.get("config")!);
    if (!setup) return passkeysUnavailable(c);
    // Discoverable: no allowCredentials, the browser offers the user's passkeys. Nothing is stored.
    return c.json(await issueChallenge(setup.secret, await authenticationOptions(setup.webauthn, []), { pur: "login" }));
  }));

  app.post("/api/auth/passkey/login", authRoute(async (c) => {
    const parsed = assertionBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "Invalid sign-in payload" }, 400);
    const db = c.get("db")!;
    const check = await checkAssertion(c, db, { challengeToken: parsed.data.challengeToken, credential: parsed.data.credential, purpose: "login" });
    if (!check.ok) return check.response;
    const now = new Date();
    await recordPasskeyUse(db, check, now);
    const history = await addressHistory(db, check.user.id, requestFacts(c).ip, now.getTime());
    return completeSignIn(c, db, {
      user: (tx, at) => tx.user.update({ where: { id: check.user.id }, data: signedInData(at) }) as Promise<AccountUser>,
      amr: ["passkey"],
      remember: parsed.data.remember ?? true,
      device: await readOrMintDevice(c.req.header("cookie")),
      history,
    });
  }));
}
