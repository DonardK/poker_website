import type { EdgeConfig } from "../env";
import { AUTH_KEY_RING_NAMES, decryptWithRing, encryptWithRing, parseKeyRing, type KeyRing } from "./key-ring";

/** Ring for one event. New ciphertexts are v2 under the active key; v1 still decrypts. */
export function ringFromConfig(config: EdgeConfig): KeyRing {
  return parseKeyRing({
    keys: config.gameEncryptionKeys,
    activeKeyId: config.gameEncryptionActiveKeyId,
  });
}

/**
 * The account-security ring (AUTH_ENCRYPTION_KEYS, e.g. TOTP secrets under context
 * "user-totp:<userId>"); null when those secrets are not configured. Never the game ring.
 */
export function authRingFromConfig(config: EdgeConfig): KeyRing | null {
  if (!config.security) return null;
  return parseKeyRing({ keys: config.security.authKeys, activeKeyId: config.security.authActiveKeyId }, AUTH_KEY_RING_NAMES);
}

export function encryptState(ring: KeyRing, value: unknown, context: string): string {
  return encryptWithRing(ring, value, context);
}

export function decryptState<T>(ring: KeyRing, value: string, context: string): T {
  return decryptWithRing<T>(ring, value, context);
}
