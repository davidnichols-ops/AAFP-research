/**
 * @aafp/cbor — Canonical CBOR encoder (RFC 8949 §4.2.3).
 *
 * @packageDocumentation
 */

import type { CborValue } from "./types.js";
import { CborError } from "./types.js";

/**
 * Options controlling {@link CborEncoder} behavior.
 */
export interface CborEncoderOptions {
  /**
   * When `true` (default), produce deterministic / canonical encoding:
   * - Map keys sorted by length-first canonical byte ordering.
   * - Integers use shortest encoding.
   * - No indefinite-length arrays or maps.
   * - Text strings use definite-length UTF-8.
   *
   * When `false`, non-deterministic encoding is permitted (not recommended
   * for AAFP protocol structures — signatures require byte-exact output).
   */
  deterministic?: boolean;
}

/**
 * Canonical CBOR encoder.
 *
 * Produces byte-identical output to the Rust `aafp_cbor::encode` function
 * when {@link CborEncoderOptions.deterministic} is `true` (the default).
 *
 * Key rules (RFC 8949 §4.2.3, RFC-0002 §8.1):
 * 1. Map keys sorted by length-first canonical byte ordering — sort by
 *    `(encoding_length, bytewise_encoding)`.
 * 2. Integers use shortest encoding (0–23 immediate, 24–255 one byte, etc.).
 * 3. No indefinite-length arrays or maps — always definite-length.
 * 4. Text strings use definite-length UTF-8.
 * 5. Negative integers: -1 encodes as `0x20`, -n as `0x20 + (n-1)`.
 *
 * @example
 * ```typescript
 * const encoder = new CborEncoder();
 * const bytes = encoder.encode({ type: "uint", value: 1000 });
 * // bytes === Uint8Array [0x19, 0x03, 0xE8]
 * ```
 */
export class CborEncoder {
  /** Whether deterministic (canonical) encoding is enabled. */
  public readonly deterministic: boolean;

  /**
   * @param options - Encoder configuration. Defaults to deterministic mode.
   */
  constructor(options: CborEncoderOptions = {}) {
    this.deterministic = options.deterministic ?? true;
  }

  /**
   * Encode a {@link CborValue} to canonical CBOR bytes.
   *
   * @param value - The CBOR value to encode.
   * @returns A `Uint8Array` containing the deterministic CBOR encoding.
   * @throws {CborError} If the value cannot be canonically encoded.
   */
  encode(value: CborValue): Uint8Array {
    throw new Error("Not implemented");
  }

  /**
   * Encode a {@link CborValue} and verify the result is canonical by
   * re-decoding it and checking for trailing bytes.
   *
   * @param value - The CBOR value to encode.
   * @returns A canonical `Uint8Array`.
   * @throws {CborError} If encoding or the canonical check fails.
   */
  encodeCanonical(value: CborValue): Uint8Array {
    throw new Error("Not implemented");
  }
}

/**
 * Convenience function: encode a {@link CborValue} using a default
 * deterministic {@link CborEncoder}.
 *
 * @param value - The CBOR value to encode.
 * @returns Canonical CBOR bytes.
 * @throws {CborError} If encoding fails.
 */
export function encodeCbor(value: CborValue): Uint8Array {
  throw new Error("Not implemented");
}
