import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

// AES-256-GCM for sensitive columns (writers' PAN and bank account numbers).
// Stored as base64 "iv.tag.ciphertext".

function key() {
  return Buffer.from(env().FIELD_ENCRYPTION_KEY, "base64");
}

export function encryptField(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptField(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** "XXXXXX1234" — shown in lists so full numbers never leave the API by default. */
export function mask(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 4 ? "****" : `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}
