/**
 * AgentKeypair — ML-DSA-65 keypair management for agent identity.
 *
 * Mirrors `aafp-identity/src/keypair.rs`. Wraps ML-DSA-65 keys with
 * convenience methods for signing, verification, serialization, and
 * AgentId derivation.
 */

import type { AgentId } from "./agent-id.js";
import {
  MlDsa65,
  MlDsa65PublicKey,
  MlDsa65SecretKey,
  MlDsa65Signature,
  ML_DSA_65_PUBKEY_LEN,
  ML_DSA_65_SECRETKEY_LEN,
} from "./dsa.js";
import { CryptoError } from "./types.js";

/**
 * An agent's ML-DSA-65 keypair (root identity).
 *
 * Mirrors Rust `AgentKeypair` struct (`keypair.rs` lines 33-39). The public
 * key is 1952 bytes and the secret key is 4032 bytes.
 */
export interface AgentKeypair {
  /** ML-DSA-65 public key (1952 bytes). */
  readonly publicKey: Uint8Array;
  /** ML-DSA-65 secret key (4032 bytes). */
  readonly secretKey: Uint8Array;

  /**
   * Derive the AgentId (hex of SHA-256(publicKey)) for this keypair.
   *
   * @returns 64-character lowercase hex AgentId.
   */
  agentId(): AgentId;

  /**
   * Sign a message with ML-DSA-65 using this keypair's secret key.
   *
   * @param msg - Message bytes to sign.
   * @returns 3309-byte detached signature.
   */
  sign(msg: Uint8Array): Uint8Array;

  /**
   * Verify a signature against this keypair's public key.
   *
   * @param msg - Original message bytes.
   * @param sig - Signature bytes to verify.
   * @returns `true` if valid, `false` otherwise.
   */
  verify(msg: Uint8Array, sig: Uint8Array): boolean;
}

/**
 * Concrete ML-DSA-65 keypair class with sign/verify helpers.
 *
 * Provides the same surface as the {@link AgentKeypair} interface plus
 * serialization (`toBytes`/`fromBytesFull`) and typed key accessors.
 */
export class MlDsa65Keypair implements AgentKeypair {
  /** ML-DSA-65 public key (1952 bytes). */
  public readonly publicKey: Uint8Array;
  /** ML-DSA-65 secret key (4032 bytes). */
  public readonly secretKey: Uint8Array;

  /**
   * Generate a fresh ML-DSA-65 keypair using secure randomness.
   *
   * @returns A new {@link MlDsa65Keypair}.
   */
  static generate(): MlDsa65Keypair {
    throw new Error("Not implemented");
  }

  /**
   * Generate a deterministic keypair from a 32-byte seed (FIPS 204
   * Algorithm 1). Used for cross-language test vectors (A-10).
   *
   * @param seed - 32-byte seed.
   * @returns A deterministic {@link MlDsa65Keypair}.
   */
  static fromSeed(seed: Uint8Array): MlDsa65Keypair {
    throw new Error("Not implemented");
  }

  /**
   * Reconstruct a keypair from both secret and public key bytes.
   *
   * Validates lengths via {@link MlDsa65SecretKey} / {@link MlDsa65PublicKey}
   * constructors. ML-DSA-65 cannot derive the public key from the secret
   * key, so both are required.
   *
   * @param secret - Raw secret key bytes (4032 bytes).
   * @param publicKey - Raw public key bytes (1952 bytes).
   * @throws {CryptoError} if either key has an invalid length.
   */
  static fromSecretAndPublic(
    secret: Uint8Array,
    publicKey: Uint8Array,
  ): MlDsa65Keypair {
    throw new Error("Not implemented");
  }

  /**
   * Deserialize a keypair from the wire format:
   * `[4-byte BE secret_len][secret][public]`.
   *
   * @param data - Serialized keypair bytes.
   * @returns The reconstructed keypair.
   * @throws {CryptoError} if the data is truncated or keys are invalid.
   */
  static fromBytesFull(data: Uint8Array): MlDsa65Keypair {
    throw new Error("Not implemented");
  }

  private constructor(publicKey: Uint8Array, secretKey: Uint8Array) {
    this.publicKey = publicKey;
    this.secretKey = secretKey;
  }

  /** Derive the AgentId (hex of SHA-256(publicKey)). */
  agentId(): AgentId {
    throw new Error("Not implemented");
  }

  /** Sign a message with ML-DSA-65. Returns 3309-byte signature. */
  sign(msg: Uint8Array): Uint8Array {
    throw new Error("Not implemented");
  }

  /** Verify a signature against this keypair's public key. */
  verify(msg: Uint8Array, sig: Uint8Array): boolean {
    throw new Error("Not implemented");
  }

  /**
   * Serialize the keypair to bytes: `[4-byte BE secret_len][secret][public]`.
   *
   * Matches `to_bytes` in `keypair.rs` (lines 72-78).
   *
   * @returns Serialized keypair bytes.
   */
  toBytes(): Uint8Array {
    throw new Error("Not implemented");
  }

  /**
   * Get the public key as a typed {@link MlDsa65PublicKey} wrapper.
   *
   * @throws {CryptoError} if the public key length is invalid.
   */
  publicKeyTyped(): MlDsa65PublicKey {
    throw new Error("Not implemented");
  }

  /**
   * Get the secret key as a typed {@link MlDsa65SecretKey} wrapper.
   *
   * @throws {CryptoError} if the secret key length is invalid.
   */
  secretKeyTyped(): MlDsa65SecretKey {
    throw new Error("Not implemented");
  }
}

/**
 * Generate a fresh ML-DSA-65 keypair.
 *
 * @param seed - Optional 32-byte seed for deterministic keygen.
 * @returns A new {@link AgentKeypair}.
 */
export function generateKeypair(seed?: Uint8Array): AgentKeypair {
  throw new Error("Not implemented");
}

/**
 * Reconstruct a keypair from both secret and public key bytes.
 *
 * @param secret - Raw secret key bytes (4032 bytes).
 * @param publicKey - Raw public key bytes (1952 bytes).
 * @throws {CryptoError} if either key has an invalid length.
 */
export function fromSecretAndPublic(
  secret: Uint8Array,
  publicKey: Uint8Array,
): AgentKeypair {
  throw new Error("Not implemented");
}

/**
 * Serialize a keypair to bytes: `[4-byte BE secret_len][secret][public]`.
 *
 * @param kp - The keypair to serialize.
 * @returns Serialized keypair bytes.
 */
export function keypairToBytes(kp: AgentKeypair): Uint8Array {
  throw new Error("Not implemented");
}

/**
 * Deserialize a keypair from bytes (`[4-byte BE secret_len][secret][public]`).
 *
 * @param data - Serialized keypair bytes.
 * @returns The reconstructed keypair.
 * @throws {CryptoError} if the data is truncated or keys are invalid.
 */
export function keypairFromBytes(data: Uint8Array): AgentKeypair {
  throw new Error("Not implemented");
}
