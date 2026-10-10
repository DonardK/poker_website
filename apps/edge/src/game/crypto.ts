import type { EdgeConfig } from "../env";
import { decryptWithRing, encryptWithRing, parseKeyRing, type KeyRing } from "./key-ring";

/** Ring for one event. New ciphertexts are v2 under the active key; v1 still decrypts. */
export function ringFromConfig(config: EdgeConfig): KeyRing {
  return parseKeyRing({
    keys: config.gameEncryptionKeys,
    activeKeyId: config.gameEncryptionActiveKeyId,
  });
}

export function encryptState(ring: KeyRing, value: unknown, context: string): string {
  return encryptWithRing(ring, value, context);
}

export function decryptState<T>(ring: KeyRing, value: string, context: string): T {
  return decryptWithRing<T>(ring, value, context);
}
