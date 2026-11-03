/**
 * Payout address validation (docs/money/WALLET.md section 9): every address
 * is checked offline before it can be saved, so a typo never becomes a
 * destination. The provider may validate again (validateAddress).
 *
 * - bitcoin: bech32 (segwit v0, BIP-173) and bech32m (v1+, BIP-350) on "bc",
 *   or base58check P2PKH (version 0x00) and P2SH (0x05). Mainnet only.
 * - ethereum (ETH, USDC_ERC20, USDT_ERC20): 0x + 40 hex. Mixed case must be
 *   a valid EIP-55 checksum; all-lower or all-upper is accepted. Stored
 *   lower-case, shown checksummed.
 * - tron (USDT_TRC20): base58check, 21 bytes, version 0x41 ("T...").
 *
 * None of these networks uses a memo or tag.
 */
import { createHash } from "node:crypto";

export type AddressCheck =
  | { ok: true; normalized: string; display: string }
  | { ok: false; code: "ADDRESS_INVALID" | "ASSET_UNSUPPORTED"; message: string };

// ---------------------------------------------------------------------------
// Keccak-256 (the original Keccak padding, as Ethereum uses; not SHA3-256)
// ---------------------------------------------------------------------------

const MASK = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets r[x + 5y]. */
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

const rotl = (value: bigint, shift: number): bigint => (shift === 0 ? value : ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK);

function keccakF(state: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) state[x + y] = state[x + y]! ^ d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y]!, ROTATIONS[x + 5 * y]!);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 25; y += 5) state[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK & b[((x + 2) % 5) + y]!);
    }
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** Keccak-256 of `input` as lower-case hex. */
export function keccak256Hex(input: Uint8Array): string {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(input.length / rate) * rate + rate);
  padded.set(input);
  padded[input.length] = padded[input.length]! ^ 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte--) word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      state[lane] = state[lane]! ^ word;
    }
    keccakF(state);
  }
  let hex = "";
  for (let lane = 0; lane < 4; lane++) {
    let word = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      hex += Number(word & 0xffn).toString(16).padStart(2, "0");
      word >>= 8n;
    }
  }
  return hex;
}

// ---------------------------------------------------------------------------
// EVM (EIP-55)
// ---------------------------------------------------------------------------

/** The EIP-55 checksummed form of 40 hex digits (any case). */
export function toChecksumAddress(hex40: string): string {
  const lower = hex40.toLowerCase();
  const hash = keccak256Hex(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

export function validateEvm(address: string): AddressCheck {
  const match = /^0x([0-9a-fA-F]{40})$/.exec(address);
  if (!match) return invalid("An Ethereum address is 0x followed by 40 hexadecimal digits.");
  const hex = match[1]!;
  const checksummed = toChecksumAddress(hex);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixed && `0x${hex}` !== checksummed) return invalid("This address has a typo (its checksum does not match).");
  if (/^0+$/.test(hex)) return invalid("This is not a usable address.");
  return { ok: true, normalized: `0x${hex.toLowerCase()}`, display: checksummed };
}

// ---------------------------------------------------------------------------
// Base58check (bitcoin legacy, tron)
// ---------------------------------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > 64) return null;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

/** The payload of a base58check string, or null when the checksum fails. */
export function base58CheckDecode(value: string): Uint8Array | null {
  const bytes = base58Decode(value);
  if (!bytes || bytes.length < 5) return null;
  const payload = bytes.slice(0, -4);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) if (checksum[i] !== bytes[bytes.length - 4 + i]) return null;
  return payload;
}

export function validateTron(address: string): AddressCheck {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return invalid("A Tron address starts with T and has 34 characters.");
  const payload = base58CheckDecode(address);
  if (!payload || payload.length !== 21 || payload[0] !== 0x41) return invalid("This address has a typo (its checksum does not match).");
  return { ok: true, normalized: address, display: address };
}

// ---------------------------------------------------------------------------
// Bitcoin
// ---------------------------------------------------------------------------

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generators[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const char of hrp) out.push(char.charCodeAt(0) >> 5);
  out.push(0);
  for (const char of hrp) out.push(char.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (bits >= from || ((acc << (to - bits)) & max) !== 0) return null;
  return out;
}

function validateSegwit(address: string): AddressCheck {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return invalid("A bitcoin address cannot mix upper and lower case.");
  const lower = address.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (lower.slice(0, separator) !== "bc" || lower.length > 90 || lower.length - separator - 1 < 6) return invalid("This is not a bitcoin mainnet address.");
  const data: number[] = [];
  for (const char of lower.slice(separator + 1)) {
    const value = BECH32_CHARSET.indexOf(char);
    if (value < 0) return invalid("This address contains a character bitcoin addresses never use.");
    data.push(value);
  }
  const check = polymod([...hrpExpand("bc"), ...data]);
  const version = data[0]!;
  const expected = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (check !== expected) return invalid("This address has a typo (its checksum does not match).");
  const program = convertBits(data.slice(1, -6), 5, 8);
  if (!program || version > 16 || program.length < 2 || program.length > 40 || (version === 0 && program.length !== 20 && program.length !== 32)) {
    return invalid("This is not a valid segwit address.");
  }
  return { ok: true, normalized: lower, display: lower };
}

export function validateBtc(address: string): AddressCheck {
  if (/^bc1/i.test(address)) return validateSegwit(address);
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) return invalid("A bitcoin address starts with bc1, 1 or 3.");
  const payload = base58CheckDecode(address);
  if (!payload || payload.length !== 21 || (payload[0] !== 0x00 && payload[0] !== 0x05)) return invalid("This address has a typo (its checksum does not match).");
  return { ok: true, normalized: address, display: address };
}

function invalid(message: string): AddressCheck {
  return { ok: false, code: "ADDRESS_INVALID", message };
}

/** Validate and normalise an address for an Asset's network. */
export function normalizeCryptoAddress(network: string, address: string, memo: string | null | undefined): AddressCheck {
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (trimmed.length < 14 || trimmed.length > 128) return invalid("This does not look like an address.");
  if (memo !== null && memo !== undefined && memo.trim() !== "") return invalid("This network does not use a memo or tag. Remove it.");
  switch (network) {
    case "bitcoin": return validateBtc(trimmed);
    case "ethereum": return validateEvm(trimmed);
    case "tron": return validateTron(trimmed);
    default: return { ok: false, code: "ASSET_UNSUPPORTED", message: "Payouts to this network are not supported." };
  }
}
