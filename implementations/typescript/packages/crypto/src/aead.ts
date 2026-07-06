/**
 * Authenticated Encryption with Associated Data (AEAD).
 *
 * Mirrors `aafp-crypto/src/aead.rs`. Default algorithm: ChaCha20-Poly1305
 * (constant-time, no hardware dependency). Optional: AES-256-GCM
 * (hardware-accelerated on x86_64/aarch64 with AES-NI).
 *
 * Both algorithms use a 32-byte key and a 12-byte nonce. Ciphertext output
 * includes the authentication tag appended.
 *
 * Uses the Web Crypto API (`crypto.subtle`) — available in Node 18+, all
 * browsers, Deno, and Bun — to avoid native dependencies.
 */

import { CryptoError } from "./types.js";

/** Nonce length in bytes (standard for both ChaCha20-Poly1305 and AES-256-GCM). */
export const NONCE_LEN = 12;

/** Required key length in bytes. */
export const AEAD_KEY_LEN = 32;

/**
 * AEAD algorithm selection.
 *
 * Mirrors Rust `AeadAlgorithm` enum (`aead.rs` lines 11-17).
 */
export enum AeadAlgorithm {
  /** ChaCha20-Poly1305 (default, constant-time, no hardware dependency). */
  ChaCha20Poly1305 = "ChaCha20-Poly1305",
  /** AES-256-GCM (hardware-accelerated on x86_64/aarch64 with AES-NI). */
  Aes256Gcm = "AES-256-GCM",
}

/**
 * AEAD cipher wrapping a 32-byte key.
 *
 * Mirrors Rust `Aead` struct (`aead.rs` lines 20-111). Instances are
 * immutable after construction; the key is held privately.
 */
export class Aead {
  /** The 32-byte key (held privately). */
  private readonly key: Uint8Array;
  /** The algorithm in use. */
  private readonly algorithm: AeadAlgorithm;

  /**
   * Create a new AEAD instance from a 32-byte key.
   *
   * @param key - 32-byte symmetric key.
   * @param algorithm - AEAD algorithm to use; defaults to
   *   {@link AeadAlgorithm.ChaCha20Poly1305}.
   * @throws {CryptoError} if `key` is not 32 bytes.
   */
  constructor(
    key: Uint8Array,
    algorithm: AeadAlgorithm = AeadAlgorithm.ChaCha20Poly1305,
  ) {
    if (key.length !== AEAD_KEY_LEN) {
      throw new CryptoError(
        "InvalidKeyLength",
        `AEAD key must be ${AEAD_KEY_LEN} bytes, got ${key.length}`,
      );
    }
    this.key = key;
    this.algorithm = algorithm;
  }

  /**
   * Encrypt `plaintext` with associated data. Returns ciphertext + tag
   * (tag appended, as per Web Crypto convention).
   *
   * @param nonce - 12-byte nonce (must be unique per key; never reuse).
   * @param aad - Additional authenticated data (integrity-protected but not
   *   encrypted).
   * @param plaintext - Bytes to encrypt.
   * @returns Ciphertext with Poly1305/GCM tag appended.
   */
  async encrypt(
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    throw new Error("Not implemented");
  }

  /**
   * Decrypt `ciphertext` (with appended tag) with associated data. Returns
   * the plaintext or throws on authentication failure.
   *
   * @param nonce - 12-byte nonce used during encryption.
   * @param aad - Additional authenticated data (must match encryption).
   * @param ciphertext - Ciphertext with appended authentication tag.
   * @returns The decrypted plaintext.
   * @throws {CryptoError} if decryption fails (authentication tag mismatch,
   *   wrong nonce, or wrong AAD).
   */
  async decrypt(
    nonce: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    throw new Error("Not implemented");
  }

  /**
   * @returns The AEAD algorithm in use.
   */
  getAlgorithm(): AeadAlgorithm {
    throw new Error("Not implemented");
  }
}
