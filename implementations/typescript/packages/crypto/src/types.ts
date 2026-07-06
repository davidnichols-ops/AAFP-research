/**
 * @aafp/crypto — shared types and errors.
 *
 * Mirrors `aafp-crypto/src/traits.rs` (CryptoError enum) for the TypeScript
 * implementation. All crypto-layer errors flow through {@link CryptoError}.
 */

/**
 * Cryptographic error emitted by the `@aafp/crypto` package.
 *
 * Mirrors the Rust `CryptoError` enum (`aafp-crypto/src/traits.rs` lines
 * 47-85). Variants are flattened to a single class with a descriptive
 * message; the `kind` field preserves the discriminant for programmatic
 * handling.
 */
export class CryptoError extends Error {
  /** Discriminant identifying the error category. */
  public readonly kind: CryptoErrorKind;

  constructor(kind: CryptoErrorKind, message: string) {
    super(message);
    this.name = "CryptoError";
    this.kind = kind;
  }

  /** Convenience constructor for invalid key lengths. */
  static invalidKeyLength(expected: number, actual: number): CryptoError {
    return new CryptoError(
      "InvalidKeyLength",
      `invalid key length: expected ${expected}, got ${actual}`,
    );
  }

  /** Convenience constructor for invalid signature lengths. */
  static invalidSignatureLength(expected: number, actual: number): CryptoError {
    return new CryptoError(
      "InvalidSignatureLength",
      `invalid signature length: expected ${expected}, got ${actual}`,
    );
  }

  /** Convenience constructor for AEAD decryption failures. */
  static aeadDecryptionFailed(): CryptoError {
    return new CryptoError("AeadDecryptionFailed", "AEAD decryption failed");
  }

  /** Convenience constructor for decoding/deserialization errors. */
  static decode(message: string): CryptoError {
    return new CryptoError("Decode", `decoding error: ${message}`);
  }
}

/**
 * Discriminant for {@link CryptoError}.
 *
 * Matches the Rust `CryptoError` enum variants:
 * - `InvalidKeyLength`
 * - `InvalidSignatureLength`
 * - `InvalidCiphertextLength`
 * - `SignatureVerificationFailed`
 * - `AeadDecryptionFailed`
 * - `Handshake`
 * - `Decode`
 */
export type CryptoErrorKind =
  | "InvalidKeyLength"
  | "InvalidSignatureLength"
  | "InvalidCiphertextLength"
  | "SignatureVerificationFailed"
  | "AeadDecryptionFailed"
  | "Handshake"
  | "Decode";
