/**
 * AES-GCM-256 at-rest encryption for the user's settle signature in Redis.
 *
 * The key comes from ROW_ENCRYPTION_KEY_BASE64 — provisioned per-env by your
 * secret manager and injected at deploy time; the process never calls a
 * secrets manager at runtime. Node's
 * built-in crypto only; no external dependency. The stored sig is auto-purged
 * once settle confirms, so exposure is bounded to the in-flight window.
 *
 * Wire: base64( iv(12) || authTag(16) || ciphertext ).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

export function generateRowKeyBase64(): string {
  return randomBytes(32).toString("base64");
}

export class RowCipher {
  private key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) {
      throw new Error(`ROW_ENCRYPTION_KEY_BASE64 must decode to 32 bytes (AES-256), got ${key.length}`);
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString("base64");
  }

  decrypt(encBase64: string): string {
    const buf = Buffer.from(encBase64, "base64");
    if (buf.length < IV_LEN + TAG_LEN) throw new Error("row-crypto: ciphertext too short");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

/** Build a cipher from env, or null when unset (v1-only deployments). */
export function rowCipherFromEnv(): RowCipher | null {
  const k = process.env.ROW_ENCRYPTION_KEY_BASE64;
  return k ? new RowCipher(k) : null;
}
