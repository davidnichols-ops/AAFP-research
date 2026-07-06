/**
 * ML-DSA-65 signature scheme (FIPS 204, L3 post-quantum security).
 *
 * Wraps `@noble/post-quantum` ML-DSA-65 to mirror the Rust `MlDsa65`
 * implementation in `aafp-crypto/src/dsa.rs`.
 *
 * Constants (FIPS 204):
 * - Public key:  **1952 bytes**
 * - Secret key:  **4032 bytes**
 * - Signature:   **3309 bytes**
 *
 * An empty context string (`""`) is used for signing and verification,
 * matching the previous PQClean behavior (see `dsa.rs` lines 9-10, 127-129).
 */

import { CryptoError } from "./types.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { randomBytes } from "@noble/post-quantum/utils";

/** ML-DSA-65 public key length in bytes (FIPS 204). */
export const ML_DSA_65_PUBKEY_LEN = 1952;

/** ML-DSA-65 secret key length in bytes (FIPS 204). */
export const ML_DSA_65_SECRETKEY_LEN = 4032;

/** ML-DSA-65 detached signature length in bytes (FIPS 204). */
export const ML_DSA_65_SIGNATURE_LEN = 3309;

/** Seed length for deterministic key generation (FIPS 204 Algorithm 1). */
export const ML_DSA_65_SEED_LEN = 32;

/**
 * Owned ML-DSA-65 public key bytes.
 *
 * Validates length on construction. Mirrors Rust `MlDsa65PublicKey`
 * (`dsa.rs` lines 28-73).
 */
export class MlDsa65PublicKey {
  /** Raw public key bytes (length = {@link ML_DSA_65_PUBKEY_LEN}). */
  public readonly bytes: Uint8Array;

  /**
   * @param bytes - Raw public key bytes; must be exactly
   *   {@link ML_DSA_65_PUBKEY_LEN} bytes.
   * @throws {CryptoError} if the length is incorrect.
   */
  constructor(bytes: Uint8Array) {
    if (bytes.length !== ML_DSA_65_PUBKEY_LEN) {
      throw CryptoError.invalidKeyLength(ML_DSA_65_PUBKEY_LEN, bytes.length);
    }
    this.bytes = bytes;
  }
}

/**
 * Owned ML-DSA-65 secret key bytes.
 *
 * Validates length on construction. Mirrors Rust `MlDsa65SecretKey`
 * (`dsa.rs` lines 33-92).
 */
export class MlDsa65SecretKey {
  /** Raw secret key bytes (length = {@link ML_DSA_65_SECRETKEY_LEN}). */
  public readonly bytes: Uint8Array;

  /**
   * @param bytes - Raw secret key bytes; must be exactly
   *   {@link ML_DSA_65_SECRETKEY_LEN} bytes.
   * @throws {CryptoError} if the length is incorrect.
   */
  constructor(bytes: Uint8Array) {
    if (bytes.length !== ML_DSA_65_SECRETKEY_LEN) {
      throw CryptoError.invalidKeyLength(ML_DSA_65_SECRETKEY_LEN, bytes.length);
    }
    this.bytes = bytes;
  }
}

/**
 * Owned ML-DSA-65 detached signature bytes.
 *
 * Validates length on construction. Mirrors Rust `MlDsa65Signature`
 * (`dsa.rs` lines 37-105).
 */
export class MlDsa65Signature {
  /** Raw signature bytes (length = {@link ML_DSA_65_SIGNATURE_LEN}). */
  public readonly bytes: Uint8Array;

  /**
   * @param bytes - Raw signature bytes; must be exactly
   *   {@link ML_DSA_65_SIGNATURE_LEN} bytes.
   * @throws {CryptoError} if the length is incorrect.
   */
  constructor(bytes: Uint8Array) {
    if (bytes.length !== ML_DSA_65_SIGNATURE_LEN) {
      throw CryptoError.invalidSignatureLength(
        ML_DSA_65_SIGNATURE_LEN,
        bytes.length,
      );
    }
    this.bytes = bytes;
  }
}

/**
 * An ML-DSA-65 keypair (public + secret key).
 */
export interface MlDsa65Keypair {
  /** Public key (1952 bytes). */
  readonly publicKey: MlDsa65PublicKey;
  /** Secret key (4032 bytes). */
  readonly secretKey: MlDsa65SecretKey;
}

// Lazy import of @noble/post-quantum to avoid issues if not installed
// (Using static imports above for ESM compatibility)

/**
 * ML-DSA-65 signature scheme operations.
 *
 * Static methods mirror the Rust `MlDsa65` struct and its `SignatureScheme`
 * trait impl (`dsa.rs` lines 23-193).
 */
export class MlDsa65 {
  /** Algorithm name for negotiation/serialization. */
  static readonly algorithmName = "ML-DSA-65";

  /**
   * Generate a fresh ML-DSA-65 keypair using cryptographically secure random
   * bytes (FIPS 204 keygen).
   *
   * @returns A new {@link MlDsa65Keypair}.
   */
  static keypair(): MlDsa65Keypair {
    
    
    const keys = ml_dsa65.keygen(randomBytes(32));
    return {
      publicKey: new MlDsa65PublicKey(keys.publicKey),
      secretKey: new MlDsa65SecretKey(keys.secretKey),
    };
  }

  /**
   * Deterministic key generation from a 32-byte seed (FIPS 204 Algorithm 1).
   *
   * The same seed MUST produce the same keypair across all FIPS 204
   * implementations (Rust `fips204`, Go `KarpelesLab/mldsa`,
   * `@noble/post-quantum`). Used for cross-language test vector generation
   * (A-10).
   *
   * @param seed - 32-byte seed.
   * @returns A deterministic {@link MlDsa65Keypair}.
   * @throws {CryptoError} if `seed` is not 32 bytes.
   */
  static keypairFromSeed(seed: Uint8Array): MlDsa65Keypair {
    if (seed.length !== ML_DSA_65_SEED_LEN) {
      throw new CryptoError(
        "InvalidKeyLength",
        `seed must be ${ML_DSA_65_SEED_LEN} bytes, got ${seed.length}`,
      );
    }
    
    const keys = ml_dsa65.keygen(seed);
    return {
      publicKey: new MlDsa65PublicKey(keys.publicKey),
      secretKey: new MlDsa65SecretKey(keys.secretKey),
    };
  }

  /**
   * Sign a message with ML-DSA-65 using an empty context string (matches
   * PQClean's detached_sign behavior).
   *
   * @param secretKey - The secret key to sign with.
   * @param msg - Message bytes to sign.
   * @returns A 3309-byte detached signature.
   */
  static sign(secretKey: MlDsa65SecretKey, msg: Uint8Array): MlDsa65Signature {
    const sig = ml_dsa65.sign(secretKey.bytes, msg);
    return new MlDsa65Signature(sig);
  }

  /**
   * Deterministic signing using a 32-byte randomness seed (FIPS 204
   * deterministic signing variant).
   *
   * Produces reproducible signatures for test vector generation (A-10). Uses
   * `try_sign_with_seed` which sets the randomness to the seed value.
   *
   * @param secretKey - The secret key to sign with.
   * @param msg - Message bytes to sign.
   * @param seed - 32-byte randomness seed.
   * @returns A deterministic 3309-byte signature.
   * @throws {CryptoError} if `seed` is not 32 bytes.
   */
  static signDeterministic(
    secretKey: MlDsa65SecretKey,
    msg: Uint8Array,
    seed: Uint8Array,
  ): MlDsa65Signature {
    if (seed.length !== ML_DSA_65_SEED_LEN) {
      throw new CryptoError(
        "InvalidKeyLength",
        `sign seed must be ${ML_DSA_65_SEED_LEN} bytes, got ${seed.length}`,
      );
    }
    const sig = ml_dsa65.sign(secretKey.bytes, msg, undefined, seed);
    return new MlDsa65Signature(sig);
  }

  /**
   * Verify an ML-DSA-65 signature against a public key.
   *
   * Uses an empty context string (matches PQClean). Returns `false` (never
   * throws) for invalid keys, bad signature lengths, or failed verification.
   *
   * @param publicKey - The public key to verify against.
   * @param msg - Original message bytes.
   * @param sig - The signature to verify.
   * @returns `true` if the signature is valid, `false` otherwise.
   */
  static verify(
    publicKey: MlDsa65PublicKey,
    msg: Uint8Array,
    sig: MlDsa65Signature,
  ): boolean {
    try {
      return ml_dsa65.verify(publicKey.bytes, msg, sig.bytes);
    } catch {
      return false;
    }
  }
}
