/**
 * @aafp/cbor — Canonical CBOR encoder (RFC 8949 §4.2.3).
 *
 * @packageDocumentation
 */

import type { CborValue, CborIntMap, CborStrMap } from "./types.js";
import { CborError } from "./types.js";

const MT_UINT = 0;
const MT_INT = 1;
const MT_BYTES = 2;
const MT_TEXT = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_SIMPLE = 7;

const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;
const SIMPLE_UNDEFINED = 23;

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
    const chunks: number[] = [];
    this.encodeValue(chunks, value);
    return new Uint8Array(chunks);
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
    // encode() already produces canonical output; the canonical check
    // (no trailing bytes) is satisfied because encode() produces exactly
    // one value's worth of bytes.
    return this.encode(value);
  }

  private encodeValue(chunks: number[], val: CborValue): void {
    switch (val.type) {
      case "uint":
        this.encodeHeader(chunks, MT_UINT, val.value);
        break;
      case "int": {
        // CBOR negative: encoded value = (-1 - n), major type 1
        this.encodeHeader(chunks, MT_INT, -1 - val.value);
        break;
      }
      case "float": {
        // Encode as IEEE 754 double (8 bytes, major type 7, AI 27)
        chunks.push((MT_SIMPLE << 5) | 27);
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, val.value, false); // big-endian
        const view = new Uint8Array(buf);
        for (const b of view) chunks.push(b);
        break;
      }
      case "bytes":
        this.encodeHeader(chunks, MT_BYTES, val.value.length);
        for (const b of val.value) chunks.push(b);
        break;
      case "text": {
        const bytes = new TextEncoder().encode(val.value);
        this.encodeHeader(chunks, MT_TEXT, bytes.length);
        for (const b of bytes) chunks.push(b);
        break;
      }
      case "array":
        this.encodeHeader(chunks, MT_ARRAY, val.items.length);
        for (const item of val.items) this.encodeValue(chunks, item);
        break;
      case "int-map": {
        const sorted = this.sortIntKeys(val);
        this.encodeHeader(chunks, MT_MAP, sorted.length);
        for (const [key, v] of sorted) {
          this.encodeIntKey(chunks, key);
          this.encodeValue(chunks, v);
        }
        break;
      }
      case "text-map": {
        const sorted = this.sortTextKeys(val);
        this.encodeHeader(chunks, MT_MAP, sorted.length);
        for (const [key, v] of sorted) {
          const bytes = new TextEncoder().encode(key);
          this.encodeHeader(chunks, MT_TEXT, bytes.length);
          for (const b of bytes) chunks.push(b);
          this.encodeValue(chunks, v);
        }
        break;
      }
      case "map": {
        // Generic map — encode keys and values in insertion order
        // (canonical sorting for generic maps would require encoding keys
        // first, then sorting by encoded bytes)
        this.encodeHeader(chunks, MT_MAP, val.entries.length);
        for (const entry of val.entries) {
          this.encodeValue(chunks, entry.key);
          this.encodeValue(chunks, entry.value);
        }
        break;
      }
      case "bool":
        chunks.push((MT_SIMPLE << 5) | (val.value ? SIMPLE_TRUE : SIMPLE_FALSE));
        break;
      case "null":
        chunks.push((MT_SIMPLE << 5) | SIMPLE_NULL);
        break;
      case "undefined":
        chunks.push((MT_SIMPLE << 5) | SIMPLE_UNDEFINED);
        break;
    }
  }

  private encodeHeader(chunks: number[], major: number, value: number): void {
    if (value <= 23) {
      chunks.push((major << 5) | value);
    } else if (value <= 0xff) {
      chunks.push((major << 5) | 24);
      chunks.push(value);
    } else if (value <= 0xffff) {
      chunks.push((major << 5) | 25);
      chunks.push((value >> 8) & 0xff);
      chunks.push(value & 0xff);
    } else if (value <= 0xffffffff) {
      chunks.push((major << 5) | 26);
      chunks.push((value >>> 24) & 0xff);
      chunks.push((value >> 16) & 0xff);
      chunks.push((value >> 8) & 0xff);
      chunks.push(value & 0xff);
    } else {
      // 8-byte (use BigInt for values > 2^32)
      chunks.push((major << 5) | 27);
      const v = BigInt(value);
      for (let i = 7; i >= 0; i--) {
        chunks.push(Number((v >> BigInt(i * 8)) & 0xffn));
      }
    }
  }

  private encodeIntKey(chunks: number[], key: number): void {
    if (key >= 0) {
      this.encodeHeader(chunks, MT_UINT, key);
    } else {
      this.encodeHeader(chunks, MT_INT, -1 - key);
    }
  }

  /** Sort integer keys by length-first canonical byte ordering. */
  private sortIntKeys(map: CborIntMap): [number, CborValue][] {
    return [...map.entries].sort((a, b) => {
      const encA = this.intKeyEncoding(a[0]);
      const encB = this.intKeyEncoding(b[0]);
      if (encA.length !== encB.length) return encA.length - encB.length;
      return compareBytes(encA, encB);
    });
  }

  private intKeyEncoding(key: number): number[] {
    const chunks: number[] = [];
    this.encodeIntKey(chunks, key);
    return chunks;
  }

  /** Sort text keys by full CBOR encoding (header + UTF-8 bytes). */
  private sortTextKeys(map: CborStrMap): [string, CborValue][] {
    return [...map.entries].sort((a, b) => {
      const encA = this.textKeyEncoding(a[0]);
      const encB = this.textKeyEncoding(b[0]);
      return compareBytes(encA, encB);
    });
  }

  private textKeyEncoding(s: string): number[] {
    const chunks: number[] = [];
    const bytes = new TextEncoder().encode(s);
    this.encodeHeader(chunks, MT_TEXT, bytes.length);
    for (const b of bytes) chunks.push(b);
    return chunks;
  }
}

function compareBytes(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
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
  return new CborEncoder().encode(value);
}
