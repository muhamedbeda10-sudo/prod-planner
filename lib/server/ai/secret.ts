import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// The Claude API key at rest: AES-256-GCM, under a key that is not in the
// database — AI_SECRET when the deployment sets one, else derived from the
// database's own connection string, which lives in the deployment's settings
// and never in a table. A database copy alone cannot read it. Changing that
// secret (or the database password, without AI_SECRET) makes the stored key
// unreadable — the owner enters it again.

function cipherKey(): Buffer {
  const base = process.env.AI_SECRET || process.env.DATABASE_URL;
  if (!base) throw new Error("No secret to encrypt the API key with (AI_SECRET / DATABASE_URL).");
  return createHash("sha256").update(`atc-ai-key:${base}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}

/** The plain text, or null when it cannot be read (no value, or a changed secret). */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith("v1:")) return null;
  try {
    const raw = Buffer.from(stored.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", cipherKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
