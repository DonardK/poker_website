import { b64urlDecode, b64urlEncode } from "../../src/auth/bytes";
import { cborEncode, type CborMap } from "./cbor";

/**
 * A software passkey (WebAuthn L3, ES256 / P-256 through Web Crypto) that
 * produces the RegistrationResponseJSON and AuthenticationResponseJSON a
 * browser would send. Every field a check depends on can be overridden, so
 * tests can forge a wrong origin, RP ID, challenge, missing user
 * verification or a counter regression.
 */

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const AAGUID = new Uint8Array(16);

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

/** Web Crypto ECDSA gives r || s; WebAuthn carries an ASN.1 DER SEQUENCE of two INTEGERs. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body: Uint8Array = bytes.slice(start);
    if ((body[0] ?? 0) & 0x80) body = concat(new Uint8Array([0]), body);
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32, 64));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string, extra: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
}

export interface CeremonyOverrides {
  /** clientDataJSON.origin (default: the authenticator's origin). */
  origin?: string;
  /** The RP ID hashed into authenticatorData (default: the authenticator's RP ID). */
  rpId?: string;
  /** User verification flag (default true). */
  uv?: boolean;
  /** Extra clientDataJSON members, e.g. { crossOrigin: true }. */
  clientData?: Record<string, unknown>;
  /** clientDataJSON.type (default the right one for the ceremony). */
  type?: "webauthn.create" | "webauthn.get";
}

export class SoftAuthenticator {
  readonly credentialId: Uint8Array;
  private keys: CryptoKeyPair | null = null;
  /** The user handle stored at registration (base64url), returned by discoverable sign-in. */
  userHandle: string | null = null;
  counter = 0;
  /** Backup eligible and backed up (a synced passkey): multiDevice. */
  backedUp = true;

  constructor(readonly rpId: string, readonly origin: string, credentialId?: Uint8Array) {
    this.credentialId = credentialId ?? crypto.getRandomValues(new Uint8Array(32));
  }

  get id(): string {
    return b64urlEncode(this.credentialId);
  }

  private async keyPair(): Promise<CryptoKeyPair> {
    this.keys ??= await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return this.keys;
  }

  private flags(uv: boolean, attested: boolean): number {
    return FLAG_UP | (uv ? FLAG_UV : 0) | (this.backedUp ? FLAG_BE | FLAG_BS : 0) | (attested ? FLAG_AT : 0);
  }

  /** navigator.credentials.create(): options are the server's PublicKeyCredentialCreationOptionsJSON. */
  async create(options: { challenge: string; user: { id: string } }, overrides: CeremonyOverrides = {}): Promise<Record<string, unknown>> {
    const pair = await this.keyPair();
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
    const cose = cborEncode(new Map<number | string, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, b64urlDecode(jwk.x!)!], [-3, b64urlDecode(jwk.y!)!],
    ]));
    this.userHandle = options.user.id;
    const authData = concat(
      await sha256(new TextEncoder().encode(overrides.rpId ?? this.rpId)),
      new Uint8Array([this.flags(overrides.uv ?? true, true)]),
      u32(this.counter),
      AAGUID,
      new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]),
      this.credentialId,
      cose,
    );
    const attestationObject = cborEncode(new Map<number | string, string | Uint8Array | CborMap>([
      ["fmt", "none"], ["attStmt", new Map()], ["authData", authData],
    ]));
    const data = clientData(overrides.type ?? "webauthn.create", options.challenge, overrides.origin ?? this.origin, overrides.clientData ?? {});
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64urlEncode(data),
        attestationObject: b64urlEncode(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get(): options are the server's PublicKeyCredentialRequestOptionsJSON. */
  async get(options: { challenge: string }, overrides: CeremonyOverrides & { counter?: number; userHandle?: string | null } = {}): Promise<Record<string, unknown>> {
    const pair = await this.keyPair();
    this.counter = overrides.counter ?? this.counter + 1;
    const authData = concat(
      await sha256(new TextEncoder().encode(overrides.rpId ?? this.rpId)),
      new Uint8Array([this.flags(overrides.uv ?? true, false)]),
      u32(this.counter),
    );
    const data = clientData(overrides.type ?? "webauthn.get", options.challenge, overrides.origin ?? this.origin, overrides.clientData ?? {});
    const signed = concat(authData, await sha256(data));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed as Uint8Array<ArrayBuffer>));
    const handle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64urlEncode(data),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(rawToDer(raw)),
        ...(handle ? { userHandle: handle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
