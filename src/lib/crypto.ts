import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "./env";

function walletKey() {
  const key = Buffer.from(env.walletEncryptionKey, "base64");
  if (key.length !== 32) throw new Error("WALLET_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

// The public key is bound as AAD, so a ciphertext can't be swapped onto another wallet row.
export function encryptSecret(secret: string, publicKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", walletKey(), iv);
  cipher.setAAD(Buffer.from(publicKey));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(payload: string, publicKey: string): string {
  const raw = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", walletKey(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(publicKey));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export function hmac(value: string): string {
  return createHmac("sha256", env.sessionSecret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function randomCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
