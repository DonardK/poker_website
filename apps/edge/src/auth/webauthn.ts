import { z } from "zod";
import type { WebAuthnConfig } from "../env";
import { b64urlDecode, b64urlEncode } from "./bytes";

/**
 * Passkeys (WebAuthn L3) through @simplewebauthn/server, imported lazily so
 * routes that never touch a passkey never evaluate it (the same pattern
 * password.ts uses for bcryptjs). Discoverable credentials, user
 * verification required, attestation "none", ES256 and RS256 only.
 *
 * Checks added on top of the library:
 * - clientDataJSON.crossOrigin must not be true and topOrigin must be absent
 *   (no embedding in another site's frame);
 * - the response id must equal the id inside the authenticator data;
 * - the signature counter is compared here, after the signature is
 *   verified, so a regression is a genuine signal (logged by the caller);
 * - stored values respect the database CHECKs (lengths, base64url).
 */

/** ES256 and RS256. Ed25519 and post-quantum keys are left out on purpose. */
const ALGORITHMS = [-7, -257];
const TIMEOUT_MS = 120_000;
const B64URL = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const ZERO_AAGUID = "00000000-0000-0000-0000-000000000000";

type SimpleWebAuthn = typeof import("@simplewebauthn/server");
let library: Promise<SimpleWebAuthn> | null = null;

function lib(): Promise<SimpleWebAuthn> {
  library ??= import("@simplewebauthn/server").catch((err: unknown) => {
    library = null;
    throw err;
  });
  return library;
}

const credentialId = z.string().min(16).max(1366).regex(B64URL);
const credentialSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal("public-key"),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).nullish(),
}).refine((value) => value.id === value.rawId);

type CredentialJson = z.infer<typeof credentialSchema>;

function parseCredential(credential: unknown): CredentialJson | null {
  const parsed = credentialSchema.safeParse(credential);
  return parsed.success ? parsed.data : null;
}

/** The validated credential id (base64url, 16-1366 characters), or null. */
export function credentialIdOf(credential: unknown): string | null {
  return parseCredential(credential)?.id ?? null;
}

/** The user handle a discoverable credential returned, or null. */
export function userHandleOf(credential: unknown): string | null {
  const handle = parseCredential(credential)?.response.userHandle;
  return typeof handle === "string" && handle.length > 0 && handle.length <= 128 && B64URL.test(handle) ? handle : null;
}

/** Refuse a response produced inside another site's frame. */
function sameOriginCeremony(credential: CredentialJson): boolean {
  const raw = credential.response.clientDataJSON;
  if (typeof raw !== "string" || raw.length > 8192) return false;
  const bytes = b64urlDecode(raw);
  if (!bytes) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { crossOrigin?: unknown; topOrigin?: unknown };
    return data.crossOrigin !== true && data.topOrigin === undefined;
  } catch {
    return false;
  }
}

function cleanTransports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && TRANSPORTS.has(entry)))].slice(0, 8);
}

export interface PasskeyDescriptor {
  credentialId: string;
  transports: string[];
}

export async function registrationOptions(
  config: WebAuthnConfig,
  user: { username: string; webauthnUserId: string },
  exclude: PasskeyDescriptor[],
): Promise<{ options: unknown; challenge: string }> {
  const sw = await lib();
  const userID = b64urlDecode(user.webauthnUserId);
  if (!userID || userID.length !== 32) throw new Error("Invalid WebAuthn user handle");
  const options = await sw.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: user.username,
    userID: userID as Uint8Array<ArrayBuffer>,
    userDisplayName: user.username,
    attestationType: "none",
    excludeCredentials: exclude.map((entry) => ({ id: entry.credentialId, transports: entry.transports })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
    timeout: TIMEOUT_MS,
  });
  return { options, challenge: options.challenge };
}

export interface RegisteredPasskey {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  aaguid: string | null;
  rpId: string;
}

/** Null for anything that does not verify (the caller answers PASSKEY_INVALID). */
export async function verifyRegistration(config: WebAuthnConfig, credential: unknown, challenge: string): Promise<RegisteredPasskey | null> {
  const parsed = parseCredential(credential);
  if (!parsed || !sameOriginCeremony(parsed)) return null;
  const sw = await lib();
  try {
    const result = await sw.verifyRegistrationResponse({
      response: parsed as unknown as Parameters<SimpleWebAuthn["verifyRegistrationResponse"]>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!result.verified) return null;
    const info = result.registrationInfo;
    if (info.credential.id !== parsed.id || !info.userVerified) return null;
    const publicKey = b64urlEncode(info.credential.publicKey);
    if (publicKey.length < 16 || publicKey.length > 2048) return null;
    const counter = info.credential.counter;
    if (!Number.isSafeInteger(counter) || counter < 0 || counter > 0xffff_ffff) return null;
    return {
      credentialId: info.credential.id,
      publicKey,
      counter,
      transports: cleanTransports(info.credential.transports),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.aaguid) && info.aaguid !== ZERO_AAGUID ? info.aaguid.toLowerCase() : null,
      rpId: info.rpID ?? config.rpId,
    };
  } catch {
    return null;
  }
}

export async function authenticationOptions(config: WebAuthnConfig, allow: PasskeyDescriptor[]): Promise<{ options: unknown; challenge: string }> {
  const sw = await lib();
  const options = await sw.generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: allow.map((entry) => ({ id: entry.credentialId, transports: entry.transports })),
    userVerification: "required",
    timeout: TIMEOUT_MS,
  });
  return { options, challenge: options.challenge };
}

export interface StoredPasskey {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  rpId: string;
}

export type AssertionResult =
  | { ok: true; newCounter: number; deviceType: "singleDevice" | "multiDevice"; backedUp: boolean }
  /** counterRegression: the signature was valid but the counter did not increase (a possible cloned authenticator). */
  | { ok: false; counterRegression: boolean };

export async function verifyAuthentication(
  config: WebAuthnConfig,
  credential: unknown,
  challenge: string,
  stored: StoredPasskey,
): Promise<AssertionResult> {
  const parsed = parseCredential(credential);
  if (!parsed || parsed.id !== stored.credentialId || !sameOriginCeremony(parsed)) return { ok: false, counterRegression: false };
  const publicKey = b64urlDecode(stored.publicKey);
  if (!publicKey) return { ok: false, counterRegression: false };
  const sw = await lib();
  try {
    const result = await sw.verifyAuthenticationResponse({
      response: parsed as unknown as Parameters<SimpleWebAuthn["verifyAuthenticationResponse"]>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: stored.rpId,
      // Counter 0 turns the library's own counter check off; it is done below, after the signature.
      credential: { id: stored.credentialId, publicKey: publicKey as Uint8Array<ArrayBuffer>, counter: 0, transports: stored.transports },
      requireUserVerification: true,
    });
    if (!result.verified || !result.authenticationInfo.userVerified) return { ok: false, counterRegression: false };
    const { newCounter, credentialDeviceType, credentialBackedUp } = result.authenticationInfo;
    if ((newCounter > 0 || stored.counter > 0) && newCounter <= stored.counter) return { ok: false, counterRegression: true };
    return { ok: true, newCounter, deviceType: credentialDeviceType, backedUp: credentialBackedUp };
  } catch {
    return { ok: false, counterRegression: false };
  }
}
