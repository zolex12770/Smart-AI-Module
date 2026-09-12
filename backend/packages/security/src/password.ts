import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from Node's own crypto — docs/26_DECISIONS.md ADR-049.
 *
 * scrypt rather than bcrypt/argon2 because both of those are native addons: they add a
 * compile step, a prebuilt-binary supply chain, and a platform matrix to CI, for a primitive
 * Node already ships. scrypt is memory-hard, is what RFC 7914 standardises, and is on
 * OWASP's recommended list. The cost parameters below are OWASP's minimum for scrypt
 * (N=2^17, r=8, p=1 ≈ 128 MiB), tunable down only for tests.
 *
 * The encoded form carries its own parameters, so raising the cost later does not invalidate
 * existing hashes — `verifyPassword` reads N/r/p from the stored string, and
 * `needsRehash` tells the caller when to upgrade a hash on next successful login.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 1 << 17, r: 8, p: 1 };

/** Test-only: the same algorithm at a cost that does not dominate a test suite's runtime. */
export const TEST_SCRYPT_PARAMS: ScryptParams = { N: 1 << 12, r: 8, p: 1 };

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function maxmemFor(params: ScryptParams): number {
  // Node's default maxmem (32 MiB) is below what N=2^17 needs; derive a bound with headroom.
  return 256 * params.N * params.r * 2;
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params),
  });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), derived.toString("base64")].join("$");
}

/**
 * Constant-time verification. Returns false for a malformed hash rather than throwing, so a
 * corrupted row cannot become a 500 on the login path — it is simply a failed login.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: maxmemFor({ N, r, p }) });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/** True when a stored hash used weaker parameters than the current policy. */
export function needsRehash(encoded: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < params.N || Number(parts[2]) < params.r || Number(parts[3]) < params.p;
}
