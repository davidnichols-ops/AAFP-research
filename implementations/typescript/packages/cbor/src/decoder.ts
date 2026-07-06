/**
 * @aafp/cbor — Canonical CBOR decoder (RFC 8949 §4.2.3).
 *
 * @packageDocumentation
 */

import type { CborValue } from "./types.js";
import { CborError } from "./types.js";

/**
 * Default maximum CBOR nesting depth (security limit).
 *
 * Prevents stack overflow and OOM from adversarial deeply-nested CBOR
 * structures. AAFP messages are shallow (handshake maps, RPC maps, arrays
 * of capabilities) — 100 levels is far more than any legitimate use.
 */
export const DEFAULT_MAX_DECODE_DEPTH = 100;

/**
 * Options controlling {@link CborDecoder} behavior.
 */
export interface CborDecoderOptions {
  /**
   * Maximum nesting depth allowed during decoding. Defaults to
   * {@link DEFAULT_MAX_DECODE_DEPTH} (100). Decoding structures deeper
   * than this limit throws a {@link CborError}.
   */
  maxDepth?: number;
}

/**
 * Result of a CBOR decode operation.
 */
export interface CborDecodeResult {
  /** The decoded CBOR value. */
  value: CborValue;
  /** Number of bytes consumed from the input. */
  bytesConsumed: number;
}

/**
 * Canonical CBOR decoder.
 *
 * Decodes CBOR bytes and rejects non-canonical encodings (matching the
 * behavior of the Rust `aafp_cbor::decode` function):
 * - Values 0–23 encoded with additional-info 24 (one-byte) → error.
 * - Indefinite-length arrays/maps (break code `0xFF`) → error.
 * - Duplicate map keys → error.
 * - Trailing bytes after the top-level value (in {@link checkCanonical}) → error.
 * - Nesting depth exceeding the limit → {@link CborError}.
 *
 * @example
 * ```typescript
 * const decoder = new CborDecoder();
 * const { value } = decoder.decode(bytes);
 * ```
 */
export class CborDecoder {
  /** Maximum allowed nesting depth. */
  public readonly maxDepth: number;

  /**
   * @param options - Decoder configuration. Defaults to a 100-level depth limit.
   */
  constructor(options: CborDecoderOptions = {}) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DECODE_DEPTH;
  }

  /**
   * Decode a CBOR value from the given bytes.
   *
   * @param data - The CBOR byte stream to decode.
   * @returns The decoded value and number of bytes consumed.
   * @throws {CborError} If the input is invalid, non-canonical, or exceeds
   *   the nesting depth limit.
   */
  decode(data: Uint8Array): CborDecodeResult {
    throw new Error("Not implemented");
  }

  /**
   * Decode a CBOR value and verify there are no trailing bytes.
   *
   * This is the strict canonical check — the entire input must be consumed
   * by exactly one CBOR value.
   *
   * @param data - The CBOR byte stream to decode and check.
   * @returns The decoded CBOR value.
   * @throws {CborError} If decoding fails or trailing bytes are present.
   */
  decodeExact(data: Uint8Array): CborValue {
    throw new Error("Not implemented");
  }

  /**
   * Check that a byte buffer is valid canonical CBOR without returning
   * the decoded value.
   *
   * @param data - The CBOR byte stream to validate.
   * @throws {CborError} If the encoding is not canonical.
   */
  checkCanonical(data: Uint8Array): void {
    throw new Error("Not implemented");
  }
}

/**
 * Convenience function: decode a {@link CborValue} using a default
 * {@link CborDecoder} and return only the value (no bytes-consumed info).
 *
 * @param data - The CBOR byte stream to decode.
 * @returns The decoded CBOR value.
 * @throws {CborError} If decoding fails.
 */
export function decodeCbor(data: Uint8Array): CborValue {
  throw new Error("Not implemented");
}
