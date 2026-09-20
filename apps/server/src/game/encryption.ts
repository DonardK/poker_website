import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config.js";

// Separate from JWT keys; the context prevents moving ciphertext between rows.
export function encryptState(value: unknown, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(env.GAME_ENCRYPTION_KEY, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("base64")].join(".");
}

export function decryptState<T>(value: string, context: string): T {
  const [version, nonce, tag, data, extra] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !data || extra !== undefined || !/^[a-f0-9]{24}$/.test(nonce) || !/^[a-f0-9]{32}$/.test(tag)) throw new Error("Invalid encrypted state");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(env.GAME_ENCRYPTION_KEY, "hex"), Buffer.from(nonce, "hex"));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, "base64")), cipher.final()]).toString("utf8")) as T;
}
