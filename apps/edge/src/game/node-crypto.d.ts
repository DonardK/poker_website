/** The slice of node:crypto this Worker uses. workerd provides it under nodejs_compat. */
declare module "node:crypto" {
  interface Bytes extends Uint8Array {
    toString(encoding?: string): string;
    equals(other: Uint8Array): boolean;
  }
  interface Cipher {
    setAAD(aad: Uint8Array): void;
    update(data: string, encoding: "utf8"): Bytes;
    final(): Bytes;
    getAuthTag(): Bytes;
  }
  interface Decipher {
    setAAD(aad: Uint8Array): void;
    setAuthTag(tag: Uint8Array): void;
    update(data: Uint8Array): Bytes;
    final(): Bytes;
  }
  export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Cipher;
  export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Decipher;
  export function randomBytes(size: number): Bytes;
  export function pbkdf2(
    password: Uint8Array | string,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (err: Error | null, derivedKey: Bytes) => void,
  ): void;
  export function pbkdf2Sync(
    password: Uint8Array | string,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
  ): Bytes;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
