"use client";

/**
 * Passkeys in the browser, through @simplewebauthn/browser (pinned 14.0.0),
 * loaded with import() on first use so pages that never touch a passkey do
 * not ship it. The options and credentials are the library's JSON shapes; the
 * API verifies everything (origin, RP ID, user verification, signature).
 */
type Library = typeof import("@simplewebauthn/browser");
type RequestOptionsJSON = Parameters<Library["startAuthentication"]>[0]["optionsJSON"];
type CreationOptionsJSON = Parameters<Library["startRegistration"]>[0]["optionsJSON"];

let library: Promise<Library> | null = null;

function lib(): Promise<Library> {
  library ??= import("@simplewebauthn/browser");
  return library;
}

export interface PasskeySupport {
  /** WebAuthn exists in this browser. */
  supported: boolean;
  /** Passkeys can be offered in the username field's autofill (conditional mediation). */
  autofill: boolean;
  /** A built-in authenticator (fingerprint, face, screen lock) is available. */
  platform: boolean;
}

const NONE: PasskeySupport = { supported: false, autofill: false, platform: false };

export async function passkeySupport(): Promise<PasskeySupport> {
  if (typeof window === "undefined" || typeof window.PublicKeyCredential !== "function") return NONE;
  try {
    const { browserSupportsWebAuthnAutofill, platformAuthenticatorIsAvailable } = await lib();
    const [autofill, platform] = await Promise.all([
      browserSupportsWebAuthnAutofill().catch(() => false),
      platformAuthenticatorIsAvailable().catch(() => false),
    ]);
    return { supported: true, autofill, platform };
  } catch {
    return NONE;
  }
}

/** Sign in or confirm with a passkey. `autofill` waits for the user to pick one from the username field. */
export async function getPasskeyAssertion(options: unknown, opts: { autofill?: boolean } = {}): Promise<unknown> {
  const { startAuthentication } = await lib();
  return startAuthentication({ optionsJSON: options as RequestOptionsJSON, useBrowserAutofill: opts.autofill === true });
}

export async function createPasskey(options: unknown): Promise<unknown> {
  const { startRegistration } = await lib();
  return startRegistration({ optionsJSON: options as CreationOptionsJSON });
}

/** Cancel a waiting ceremony (the autofill one when the page moves on). */
export function cancelPasskeyCeremony(): void {
  if (!library) return;
  void library.then(({ WebAuthnAbortService }) => WebAuthnAbortService.cancelCeremony()).catch(() => undefined);
}

export type PasskeyFailure = "cancelled" | "duplicate" | "insecure" | "unsupported" | "other";

/** What went wrong in the browser, for the message to show (none when the user cancelled). */
export function passkeyFailure(err: unknown): PasskeyFailure {
  if (!(err instanceof Error)) return "other";
  const code = (err as Error & { code?: string }).code;
  if (code === "ERROR_CEREMONY_ABORTED" || err.name === "NotAllowedError" || err.name === "AbortError") return "cancelled";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || err.name === "InvalidStateError") return "duplicate";
  if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID" || err.name === "SecurityError") return "insecure";
  if (/not supported/i.test(err.message) || err.name === "NotSupportedError") return "unsupported";
  return "other";
}

export function passkeyFailureMessage(kind: PasskeyFailure): string | null {
  switch (kind) {
    case "cancelled": return null;
    case "duplicate": return "This passkey is already on your account.";
    case "insecure": return "Passkeys aren't available on this address.";
    case "unsupported": return "This browser doesn't support passkeys.";
    default: return "The passkey didn't work. Try again.";
  }
}
