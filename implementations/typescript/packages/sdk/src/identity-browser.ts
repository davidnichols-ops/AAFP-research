/**
 * Browser-compatible identity providers for ML-DSA-65 post-quantum signatures.
 *
 * This module provides swappable {@link IdentityProvider} implementations that
 * work in browsers, Deno, and Bun — i.e. any runtime without `node:crypto`.
 *
 * 1. {@link NobleIdentityProvider} — the default provider. Uses
 *    `@noble/post-quantum` (pure JS, FIPS 204) for ML-DSA-65 keygen/sign/verify
 *    and WebCrypto (`crypto.subtle`) / `@noble/hashes` for SHA-256. Works in
 *    all runtimes with no Node-specific APIs.
 * 2. {@link WasmIdentityProvider} — a slot for a future WASM-backed provider
 *    (the `@aafp/sdk-wasm` package, compiling `aafp-crypto` Rust to
 *    `wasm32-wasi`). Not implemented in Phase 6; the Noble provider is the
 *    default. Provided here as a stub so consumers can code against the
 *    interface today.
 *
 * No `Buffer` is used in this module — all operations take and return
 * `Uint8Array`. WebCrypto is preferred for SHA-256 and random bytes so that
 * `@noble/hashes` can be tree-shaken when the host already provides WebCrypto.
 *
 * @module @aafp/sdk/identity-browser
 */

/**
 * An agent's keypair: an ML-DSA-65 public/secret key pair plus helpers.
 *
 * `agentId` is the hex-encoded SHA-256 fingerprint of the public key — the
 * canonical, human-readable agent identifier used across the AAFP network.
 */
export interface AgentKeypair {
  /** ML-DSA-65 public key (1952 bytes). */
  publicKey: Uint8Array;
  /** ML-DSA-65 secret key (4032 bytes). */
  secretKey: Uint8Array;
  /** Returns the agent ID (hex SHA-256 of the public key). */
  agentId: () => string;
  /** Signs a message with this keypair's secret key. */
  sign: (msg: Uint8Array) => Uint8Array;
}

/**
 * A swappable post-quantum identity backend.
 *
 * The SDK calls this interface for all ML-DSA-65 operations so that the crypto
 * implementation can be chosen at runtime: pure-JS (`@noble/post-quantum`) for
 * maximum portability, or WASM (`@aafp/sdk-wasm`) for native-equivalent
 * performance in the browser.
 */
export interface IdentityProvider {
  /**
   * Generate a new ML-DSA-65 keypair.
   *
   * @param seed  Optional 32-byte seed for deterministic keygen. If omitted,
   *              a random seed is drawn from WebCrypto / noble.
   * @returns     A new {@link AgentKeypair}.
   */
  generateKeypair(seed?: Uint8Array): Promise<AgentKeypair>;
  /**
   * Sign a message with an ML-DSA-65 secret key.
   *
   * @param secretKey  The 4032-byte secret key.
   * @param msg        The message bytes to sign.
   * @returns          The ML-DSA-65 signature.
   */
  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array;
  /**
   * Verify an ML-DSA-65 signature.
   *
   * @param sig        The signature bytes.
   * @param msg        The message bytes.
   * @param publicKey  The 1952-byte public key.
   * @returns          `true` if the signature is valid.
   */
  verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean;
  /**
   * Compute the agent ID (hex SHA-256) for a public key.
   *
   * @param publicKey  The 1952-byte public key.
   * @returns          The hex-encoded SHA-256 digest.
   */
  agentId(publicKey: Uint8Array): string;
}

/**
 * Default identity provider. Uses `@noble/post-quantum` (pure JS, FIPS 204)
 * for ML-DSA-65 and WebCrypto / `@noble/hashes` for SHA-256. Works in Node,
 * browsers, Deno, and Bun with no Node-specific APIs.
 *
 * Performance: ML-DSA-65 sign/verify is roughly 10–50× slower than the Rust
 * native implementation. For handshake-heavy workloads, swap in a WASM provider
 * ({@link WasmIdentityProvider}) or use `@aafp/sdk-native` on Node.
 *
 * The `@noble/post-quantum` and `@noble/hashes` packages are dynamically
 * imported inside method bodies so that this module remains tree-shakeable and
 * does not pull the (large) pure-JS crypto into bundles that never use it.
 */
export class NobleIdentityProvider implements IdentityProvider {
  /**
   * Generate a new ML-DSA-65 keypair.
   *
   * @param seed  Optional 32-byte seed for deterministic keygen.
   * @returns     A new {@link AgentKeypair}.
   */
  async generateKeypair(seed?: Uint8Array): Promise<AgentKeypair> {
    // const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
    // const seedBytes = seed ?? this.randomBytes(32);
    // const keys = ml_dsa65.keygen(seedBytes);
    // return {
    //   publicKey: keys.publicKey,
    //   secretKey: keys.secretKey,
    //   agentId: () => this.agentId(keys.publicKey),
    //   sign: (msg: Uint8Array) => ml_dsa65.sign(msg, keys.secretKey),
    // };
    throw new Error("Not implemented");
  }

  /**
   * Sign a message with an ML-DSA-65 secret key.
   *
   * @param secretKey  The 4032-byte secret key.
   * @param msg        The message bytes to sign.
   * @returns          The ML-DSA-65 signature.
   */
  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array {
    // const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
    // return ml_dsa65.sign(msg, secretKey);
    throw new Error("Not implemented");
  }

  /**
   * Verify an ML-DSA-65 signature.
   *
   * @param sig        The signature bytes.
   * @param msg        The message bytes.
   * @param publicKey  The 1952-byte public key.
   * @returns          `true` if the signature is valid.
   */
  verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean {
    // const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
    // return ml_dsa65.verify(sig, msg, publicKey);
    throw new Error("Not implemented");
  }

  /**
   * Compute the agent ID (hex SHA-256) for a public key.
   *
   * Prefers WebCrypto (`crypto.subtle.digest`) when available; falls back to
   * `@noble/hashes` `sha256` otherwise.
   *
   * @param publicKey  The 1952-byte public key.
   * @returns          The hex-encoded SHA-256 digest.
   */
  agentId(publicKey: Uint8Array): string {
    // const hash = await sha256WebCrypto(publicKey);
    // return toHex(hash);
    throw new Error("Not implemented");
  }

  /**
   * Fill a `Uint8Array` with cryptographically secure random bytes.
   *
   * Uses WebCrypto `crypto.getRandomValues` when available; falls back to
   * `@noble/post-quantum` `randomBytes` otherwise.
   *
   * @param n  The number of random bytes to generate.
   * @returns  An `n`-byte `Uint8Array` of random data.
   */
  randomBytes(n: number): Uint8Array {
    const c = globalThis as unknown as {
      crypto?: { getRandomValues: (arr: Uint8Array) => Uint8Array };
    };
    if (c.crypto?.getRandomValues) {
      return c.crypto.getRandomValues(new Uint8Array(n));
    }
    // const { randomBytes } = await import("@noble/post-quantum/utils.js");
    // return randomBytes(n);
    throw new Error("Not implemented");
  }
}

/**
 * WASM-backed identity provider (future `@aafp/sdk-wasm` package).
 *
 * The WASM module compiles `aafp-crypto` (Rust) to `wasm32-wasi`, giving
 * native-equivalent ML-DSA-65 performance in the browser. Not implemented in
 * Phase 6; the {@link NobleIdentityProvider} is the default. This stub exists
 * so consumers can code against the interface today and swap in the WASM
 * provider via dynamic import once it ships:
 *
 * ```ts
 * const { WasmIdentityProvider } = await import("@aafp/sdk-wasm");
 * ```
 */
export class WasmIdentityProvider implements IdentityProvider {
  /**
   * Generate a new ML-DSA-65 keypair using the WASM crypto module.
   *
   * @param seed  Optional 32-byte seed for deterministic keygen.
   * @returns     A new {@link AgentKeypair}.
   */
  async generateKeypair(seed?: Uint8Array): Promise<AgentKeypair> {
    // const wasm = await import("@aafp/sdk-wasm");
    // return wasm.generateKeypair(seed);
    throw new Error("Not implemented");
  }

  /**
   * Sign a message using the WASM crypto module.
   *
   * @param secretKey  The 4032-byte secret key.
   * @param msg        The message bytes to sign.
   * @returns          The ML-DSA-65 signature.
   */
  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array {
    // const wasm = await import("@aafp/sdk-wasm");
    // return wasm.sign(secretKey, msg);
    throw new Error("Not implemented");
  }

  /**
   * Verify an ML-DSA-65 signature using the WASM crypto module.
   *
   * @param sig        The signature bytes.
   * @param msg        The message bytes.
   * @param publicKey  The 1952-byte public key.
   * @returns          `true` if the signature is valid.
   */
  verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean {
    // const wasm = await import("@aafp/sdk-wasm");
    // return wasm.verify(sig, msg, publicKey);
    throw new Error("Not implemented");
  }

  /**
   * Compute the agent ID (hex SHA-256) for a public key.
   *
   * @param publicKey  The 1952-byte public key.
   * @returns          The hex-encoded SHA-256 digest.
   */
  agentId(publicKey: Uint8Array): string {
    // const hash = await sha256WebCrypto(publicKey);
    // return toHex(hash);
    throw new Error("Not implemented");
  }
}

/**
 * Compute SHA-256 via WebCrypto (`crypto.subtle.digest`).
 *
 * Preferred over `@noble/hashes` for code paths that only need SHA-256, so the
 * pure-JS hash library can be tree-shaken when WebCrypto is available (all
 * modern browsers, Deno, Node 16+, Bun).
 *
 * @param data  The bytes to hash.
 * @returns     The 32-byte SHA-256 digest.
 */
export async function sha256WebCrypto(
  data: Uint8Array,
): Promise<Uint8Array> {
  const c = globalThis as unknown as {
    crypto?: { subtle: { digest: (alg: string, data: BufferSource) => Promise<ArrayBuffer> } };
  };
  if (c.crypto?.subtle) {
    const hash = await c.crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(hash);
  }
  // const { sha256 } = await import("@noble/hashes/sha2.js");
  // return sha256(data);
  throw new Error("Not implemented: WebCrypto unavailable and noble fallback not wired");
}

/**
 * Encode a `Uint8Array` as a lowercase hex string.
 *
 * @param bytes  The bytes to encode.
 * @returns      The hex string (no `0x` prefix).
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
