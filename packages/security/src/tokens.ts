import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque bearer credentials — session tokens and API keys (ADR-049).
 *
 * Both are 256 bits of CSPRNG output, and the database stores only a SHA-256 of the token.
 * A plain hash (rather than scrypt) is correct here and not a weakening: unlike a password,
 * the secret is full-entropy and not user-chosen, so there is no dictionary to attack and no
 * value in a slow KDF — while a fast hash keeps per-request authentication cheap.
 *
 * The lookup is by hash, which means the comparison is an indexed equality on a value the
 * attacker cannot grind, not a string compare against a secret.
 */

const TOKEN_BYTES = 32;

export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

/**
 * API keys carry a readable, non-secret prefix so a user can tell two keys apart in a list
 * without the platform ever storing or displaying the secret again.
 */
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const key = `aip_${secret}`;
  return { key, keyHash: hashToken(key), keyPrefix: key.slice(0, 12) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time compare for the rare path that compares two hashes in application code. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Cryptographically random id for a CSRF token, stored alongside the session cookie. */
export function generateCsrfToken(): string {
  return randomBytes(16).toString("base64url");
}
