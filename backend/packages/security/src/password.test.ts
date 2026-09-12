import { describe, expect, it } from "vitest";
import { DEFAULT_SCRYPT_PARAMS, TEST_SCRYPT_PARAMS, hashPassword, needsRehash, verifyPassword } from "./password.js";

/**
 * ADR-049. These run at TEST_SCRYPT_PARAMS so the suite stays fast; the algorithm, encoding
 * and verification path are identical to production, only the work factor differs — which is
 * exactly what the parameters-in-the-hash encoding exists to make possible.
 */
describe("password hashing", () => {
  it("produces a verifiable hash that never contains the password", async () => {
    const encoded = await hashPassword("correct horse battery staple", TEST_SCRYPT_PARAMS);
    expect(encoded).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(encoded).not.toContain("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const encoded = await hashPassword("correct horse battery staple", TEST_SCRYPT_PARAMS);
    expect(await verifyPassword("Correct horse battery staple", encoded)).toBe(false);
    expect(await verifyPassword("", encoded)).toBe(false);
  });

  it("salts, so identical passwords produce different hashes", async () => {
    const a = await hashPassword("same-password", TEST_SCRYPT_PARAMS);
    const b = await hashPassword("same-password", TEST_SCRYPT_PARAMS);
    expect(a).not.toEqual(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("normalizes unicode so the same typed password verifies across input methods", async () => {
    // U+00E9 vs U+0065 U+0301 — visually identical, different bytes.
    const composed = "café-password-1";
    const decomposed = "café-password-1";
    const encoded = await hashPassword(composed, TEST_SCRYPT_PARAMS);
    expect(await verifyPassword(decomposed, encoded)).toBe(true);
  });

  it("returns false rather than throwing on a malformed or truncated hash", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$1$2$3", "scrypt$a$b$c$d$e", "bcrypt$1$2$3$x$y"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("flags a hash created with weaker parameters for upgrade on next login", async () => {
    const weak = await hashPassword("pw", TEST_SCRYPT_PARAMS);
    expect(needsRehash(weak, DEFAULT_SCRYPT_PARAMS)).toBe(true);
    expect(needsRehash(weak, TEST_SCRYPT_PARAMS)).toBe(false);
    expect(needsRehash("garbage", DEFAULT_SCRYPT_PARAMS)).toBe(true);
  });
});
