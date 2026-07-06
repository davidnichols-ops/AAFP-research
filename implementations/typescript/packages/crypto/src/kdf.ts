/**
 * HKDF-SHA256 key derivation.
 *
 * Mirrors `aafp-crypto/src/kdf.rs`. Uses `@noble/hashes` for SHA-256 and
 * HKDF (RFC 5869).
 */

/**
 * HKDF-SHA256 extract-and-expand (RFC 5869).
 *
 * @param salt - Salt bytes (optional; may be empty).
 * @param ikm - Input key material.
 * @param info - Context/application-specific info string.
 * @param outputLen - Number of bytes of output key material to derive
 *   (must be ≤ 255 × 32 = 8160).
 * @returns `outputLen` bytes of derived key material.
 *
 * @example
 * ```ts
 * const okm = hkdfSha256(enc("salt"), enc("ikm"), enc("info"), 32);
 * ```
 */
export function hkdfSha256(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  outputLen: number,
): Uint8Array {
  throw new Error("Not implemented");
}

/**
 * Derive a 32-byte key from input key material using HKDF-SHA256 with an
 * empty salt.
 *
 * Convenience wrapper around {@link hkdfSha256} for the common case of
 * deriving a single 32-byte key. Matches `derive_key` in `kdf.rs`
 * (lines 18-23).
 *
 * @param ikm - Input key material.
 * @param info - Context/application-specific info string.
 * @returns 32 bytes of derived key material.
 */
export function deriveKey(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  throw new Error("Not implemented");
}
