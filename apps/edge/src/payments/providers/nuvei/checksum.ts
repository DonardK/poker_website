/**
 * Nuvei checksums and timestamps (pure functions, no I/O).
 *
 * - REST: `checksum` = lowercase hex SHA-256 (UTF-8) of the values of a
 *   method-specific list joined with no separator, ending with the merchant
 *   secret key; optional fields that are not sent are left out
 *   (https://docs.nuvei.com/api/main/indexMain_v1_0.html?json, verified
 *   2026-10-29). `timeStamp` is YYYYMMDDHHmmss; its time zone is not stated
 *   (UNVERIFIED), we send UTC.
 * - Payment Page: `checksum` = SHA-256 of the secret followed by the values
 *   of every parameter, unencoded, in the order sent; `time_stamp` is
 *   YYYY-MM-DD.HH:MM:SS in GMT
 *   (https://docs.nuvei.com/documentation/accept-payment/payment-page/quick-start-for-payment-page/).
 * - Payment DMN: `advanceResponseChecksum` = SHA-256 of secret + totalAmount
 *   + currency + responseTimeStamp + PPP_TransactionID + Status + productId,
 *   with "+" read as a space; the site can be set to MD5 instead, which we
 *   refuse (https://docs.nuvei.com/documentation/integration/webhooks/payment-dmns/).
 * - Control Panel event DMN (chargebacks): header `checksum` = SHA-256 of
 *   the secret followed by the raw JSON text, as the page's worked example
 *   hashes it (https://docs.nuvei.com/documentation/integration/webhooks/control-panel/).
 *   The page's prose also describes a "values in order" form; that form is
 *   NOT accepted: it hashes the secret plus values with no keys, which is
 *   exactly how the Payment Page checksum a player receives in their redirect
 *   URL is built, so a player could re-split their own page values into a
 *   JSON chargeback of someone else's deposit (wallet review PCD-1). A raw
 *   body starts with "{", which no Payment Page or DMN preimage does. If a
 *   sandbox event shows Nuvei signs only the values form, chargebacks are
 *   refused (Nuvei retries; staff work them from the Nuvei portal) until a
 *   key-bound check is designed.
 */
import { sha256HexOf } from "../wire";

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** REST timeStamp: YYYYMMDDHHmmss (UTC). */
export function restTimestamp(now: Date): string {
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** Payment Page time_stamp: YYYY-MM-DD.HH:MM:SS (GMT). */
export function pageTimestamp(now: Date): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}.${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}

/** A DMN responseTimeStamp ("2020-11-13.13:22:34", GMT) as a Date, or null. A date that does not exist is null, not the next month. */
export function parsePageTimestamp(value: string | null | undefined): Date | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})\.([0-9]{2}):([0-9]{2}):([0-9]{2})$/.exec(value ?? "");
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])));
  return !Number.isNaN(date.getTime()) && pageTimestamp(date) === value ? date : null;
}

/** REST checksum over the values that are sent, in the method's order, then the secret. */
export function restChecksum(values: readonly (string | undefined)[], secret: string): Promise<string> {
  return sha256HexOf(values.filter((value): value is string => value !== undefined).join("") + secret);
}

/** Payment Page checksum: the secret, then every value in the order sent. */
export function pageChecksum(params: readonly (readonly [string, string])[], secret: string): Promise<string> {
  return sha256HexOf(secret + params.map(([, value]) => value).join(""));
}

/**
 * The shape of each value the DMN checksum covers. Those values are hashed with
 * no keys or separators, the same way as the Payment Page values a player sees
 * in their own redirect, so any split of the page values gives the right hash.
 * These shapes are what stop that: a split has to put three capital letters, a
 * real timestamp, a transaction number and a status word exactly where they go,
 * and the page values hold no such run.
 */
export const DMN_FIELD_FORMAT = Object.freeze({
  totalAmount: /^[0-9]{1,12}(\.[0-9]{1,4})?$/,
  currency: /^[A-Z]{3}$/,
  pppTransactionId: /^[0-9]{1,20}$/,
  status: /^(APPROVED|SUCCESS|DECLINED|ERROR|PENDING|UPDATE)$/,
  productId: /^[\x20-\x7E]{0,255}$/,
});

/** The six DMN values the advanceResponseChecksum covers (productId may be absent: empty). */
export interface DmnSignedFields {
  totalAmount: string;
  currency: string;
  responseTimeStamp: string;
  pppTransactionId: string;
  status: string;
  productId: string;
}

export function dmnChecksum(fields: DmnSignedFields, secret: string): Promise<string> {
  return sha256HexOf(secret + fields.totalAmount + fields.currency + fields.responseTimeStamp + fields.pppTransactionId + fields.status + fields.productId);
}

/** Control Panel event, raw form: secret + the JSON body text exactly as received. */
export function eventChecksumRaw(rawBody: string, secret: string): Promise<string> {
  return sha256HexOf(secret + rawBody);
}
