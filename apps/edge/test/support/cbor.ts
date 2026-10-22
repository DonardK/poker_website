/**
 * Minimal CBOR encoder (RFC 8949) for the software authenticator: unsigned
 * and negative integers, byte strings, text strings, arrays and maps with
 * integer or text keys. Definite lengths only, which is all WebAuthn uses.
 */

export type CborValue = number | string | Uint8Array | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue>;

function head(major: number, length: number): number[] {
  const type = major << 5;
  if (length < 24) return [type | length];
  if (length < 0x100) return [type | 24, length];
  if (length < 0x10000) return [type | 25, length >> 8, length & 0xff];
  return [type | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

function encodeInto(out: number[], value: CborValue): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("CBOR: integers only");
    if (value >= 0) out.push(...head(0, value));
    else out.push(...head(1, -1 - value));
  } else if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    out.push(...head(3, bytes.length), ...bytes);
  } else if (value instanceof Uint8Array) {
    out.push(...head(2, value.length), ...value);
  } else if (Array.isArray(value)) {
    out.push(...head(4, value.length));
    for (const item of value) encodeInto(out, item);
  } else {
    out.push(...head(5, value.size));
    for (const [key, item] of value) {
      encodeInto(out, key);
      encodeInto(out, item);
    }
  }
}

export function cborEncode(value: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(out, value);
  return new Uint8Array(out);
}
