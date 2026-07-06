/**
 * AgentId — SHA-256(ML-DSA-65 public key), 32 bytes.
 *
 * Represented as a lowercase hex string (64 chars) for display and routing.
 * Matches `aafp-identity/src/agent_id.rs`.
 *
 * The full 1952-byte public key is exchanged once during the handshake and
 * cached; the 32-byte AgentId is used for all routing/discovery operations.
 */

import { sha256 } from "@noble/hashes/sha256";
import { CryptoError } from "./types.js";

/**
 * AgentId type — a 64-character lowercase hex string encoding the 32-byte
 * SHA-256 digest of an ML-DSA-65 public key.
 *
 * This is a branded nominal type to prevent accidental confusion with
 * arbitrary strings. Use {@link deriveAgentId} to construct one.
 */
export type AgentId = string & { readonly __agentIdBrand: unique symbol };

/** Expected length of an AgentId hex string (64 chars = 32 bytes). */
export const AGENT_ID_HEX_LEN = 64;

/** Expected byte length of an AgentId (SHA-256 digest). */
export const AGENT_ID_BYTE_LEN = 32;

/** Convert a Uint8Array to a lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Convert a hex string to a Uint8Array. Throws on invalid hex. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new CryptoError("Decode", `hex string has odd length: ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new CryptoError("Decode", `invalid hex char at position ${i}`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Derive an AgentId from an ML-DSA-65 public key.
 *
 * AgentId = lowercase hex(SHA-256(publicKey)). The public key MUST be 1952
 * bytes (ML-DSA-65 public key length).
 *
 * @param publicKey - Raw ML-DSA-65 public key bytes (1952 bytes).
 * @returns 64-character lowercase hex AgentId.
 *
 * @example
 * ```ts
 * const id = deriveAgentId(publicKeyBytes);
 * console.log(id); // "a1b2c3...64 chars"
 * ```
 */
export function deriveAgentId(publicKey: Uint8Array): AgentId {
  const hash = sha256(publicKey);
  return toHex(hash) as AgentId;
}

/**
 * Verify that a public key corresponds to an AgentId.
 *
 * Recomputes SHA-256(publicKey) and compares (constant-time in the reference
 * implementation) against the provided AgentId.
 *
 * @param agentId - Expected AgentId (64-char hex).
 * @param publicKey - Raw ML-DSA-65 public key bytes.
 * @returns `true` if `deriveAgentId(publicKey) === agentId`, `false` otherwise.
 */
export function verifyAgentId(agentId: AgentId, publicKey: Uint8Array): boolean {
  return deriveAgentId(publicKey) === agentId;
}

/**
 * Parse an AgentId from a hex string into raw 32 bytes.
 *
 * @param hex - 64-character lowercase hex string.
 * @returns 32-byte `Uint8Array`.
 * @throws {CryptoError} if the input is not valid hex or not exactly 32 bytes.
 */
export function agentIdFromHex(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== AGENT_ID_BYTE_LEN) {
    throw new CryptoError(
      "Decode",
      `agent ID must be ${AGENT_ID_BYTE_LEN} bytes (${AGENT_ID_HEX_LEN} hex chars), got ${bytes.length} bytes`,
    );
  }
  return bytes;
}

/**
 * Truncate an AgentId to a short prefix for display (first 8 hex chars).
 *
 * Matches `agent_id_short` in `agent_id.rs` (line 44-46).
 *
 * @param agentId - Full 64-char AgentId.
 * @returns First 8 hex characters (e.g. `"abababab"`).
 */
export function agentIdShort(agentId: AgentId): string {
  return agentId.slice(0, 8);
}
