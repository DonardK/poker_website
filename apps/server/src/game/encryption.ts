import { encryptionKeyRing } from "../config.js";
import { decryptWithRing, encryptWithRing } from "../security/key-ring.js";

// Separate from JWT keys; the context prevents moving ciphertext between rows.
// New ciphertexts are "v2.<kid>...." under GAME_ENCRYPTION_ACTIVE_KEY_ID; every
// key in the ring (including the legacy GAME_ENCRYPTION_KEY as "k0", which
// wrote all "v1." values) can still decrypt. See security/key-ring.ts.
export function encryptState(value: unknown, context: string): string {
  return encryptWithRing(encryptionKeyRing, value, context);
}

export function decryptState<T>(value: string, context: string): T {
  return decryptWithRing<T>(encryptionKeyRing, value, context);
}
