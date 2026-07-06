/**
 * @aafp/cbor — Canonical CBOR decoder (RFC 8949 §4.2.3).
 *
 * @packageDocumentation
 */

import type { CborValue, CborMapEntry } from "./types.js";
import { CborError } from "./types.js";

const MT_UINT = 0;
const MT_INT = 1;
const MT_BYTES = 2;
const MT_TEXT = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_TAG = 6;
const MT_SIMPLE = 7;

const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;
const SIMPLE_UNDEFINED = 23;

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
    const pos = { value: 0 };
    const val = this.decodeValue(data, pos, 0);
    return { value: val, bytesConsumed: pos.value };
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
    const { value, bytesConsumed } = this.decode(data);
    if (bytesConsumed !== data.length) {
      throw new CborError(
        bytesConsumed,
        `trailing bytes: consumed ${bytesConsumed} of ${data.length}`,
      );
    }
    return value;
  }

  /**
   * Check that a byte buffer is valid canonical CBOR without returning
   * the decoded value.
   *
   * @param data - The CBOR byte stream to validate.
   * @throws {CborError} If the encoding is not canonical.
   */
  checkCanonical(data: Uint8Array): void {
    this.decodeExact(data);
  }

  private decodeValue(data: Uint8Array, pos: { value: number }, depth: number): CborValue {
    if (pos.value >= data.length) {
      throw new CborError(pos.value, "unexpected end of input");
    }
    if (depth >= this.maxDepth) {
      throw new CborError(pos.value, `nesting depth exceeded limit ${this.maxDepth}`);
    }

    const initialByte = data[pos.value++]!;
    const major = initialByte >> 5;
    const ai = initialByte & 0x1f;
    const arg = this.readArgument(data, pos, ai);

    switch (major) {
      case MT_UINT:
        return { type: "uint", value: Number(arg) };
      case MT_INT:
        return { type: "int", value: -1 - Number(arg) };
      case MT_BYTES: {
        const len = Number(arg);
        const start = pos.value;
        const end = start + len;
        if (end > data.length) {
          throw new CborError(pos.value, "byte string truncated");
        }
        const bytes = data.slice(start, end);
        pos.value = end;
        return { type: "bytes", value: bytes };
      }
      case MT_TEXT: {
        const len = Number(arg);
        const start = pos.value;
        const end = start + len;
        if (end > data.length) {
          throw new CborError(pos.value, "text string truncated");
        }
        const bytes = data.slice(start, end);
        pos.value = end;
        return { type: "text", value: new TextDecoder().decode(bytes) };
      }
      case MT_ARRAY: {
        const len = Number(arg);
        const items: CborValue[] = [];
        for (let i = 0; i < len; i++) {
          items.push(this.decodeValue(data, pos, depth + 1));
        }
        return { type: "array", items };
      }
      case MT_MAP: {
        const len = Number(arg);
        const entries: [CborValue, CborValue][] = [];
        for (let i = 0; i < len; i++) {
          const key = this.decodeValue(data, pos, depth + 1);
          const val = this.decodeValue(data, pos, depth + 1);
          // Check for duplicate keys
          if (entries.some(([k]) => cborEqual(k, key))) {
            throw new CborError(pos.value, "duplicate map key");
          }
          entries.push([key, val]);
        }
        // Convert to int-map or text-map based on key types
        const allInt = entries.every(
          ([k]) => k.type === "uint" || k.type === "int",
        );
        const allText = entries.every(([k]) => k.type === "text");
        if (allInt) {
          return {
            type: "int-map",
            entries: entries.map(([k, v]) => {
              const numKey = k.type === "int" ? k.value : (k as { type: "uint"; value: number }).value;
              return [numKey, v] as [number, CborValue];
            }),
          };
        } else if (allText) {
          return {
            type: "text-map",
            entries: entries.map(([k, v]) => [
              (k as { type: "text"; value: string }).value,
              v,
            ]) as [string, CborValue][],
          };
        } else {
          // Mixed keys — return as generic map
          return {
            type: "map",
            entries: entries.map(
              ([key, value]) => ({ key, value }) as CborMapEntry,
            ),
          };
        }
      }
      case MT_TAG: {
        // Skip tag value, decode the tagged item
        return this.decodeValue(data, pos, depth + 1);
      }
      case MT_SIMPLE: {
        // For ai <= 23, the simple value is ai itself (arg === BigInt(ai))
        if (ai <= 23) {
          if (ai === SIMPLE_FALSE) return { type: "bool", value: false };
          if (ai === SIMPLE_TRUE) return { type: "bool", value: true };
          if (ai === SIMPLE_NULL) return { type: "null" };
          if (ai === SIMPLE_UNDEFINED) return { type: "undefined" };
          // Simple values 0-19 are reserved/undefined — reject
          throw new CborError(pos.value, `unsupported simple value ${ai}`);
        }
        // Check for float encoding (AI 25=half, 26=single, 27=double)
        if (ai === 25) {
          // Half-precision float (2 bytes)
          const half = Number(arg);
          const sign = (half >> 15) & 1;
          const exp = (half >> 10) & 0x1f;
          const mant = half & 0x3ff;
          let value: number;
          if (exp === 0) {
            value = mant * Math.pow(2, -24);
          } else if (exp === 31) {
            value = mant === 0 ? (sign ? -Infinity : Infinity) : NaN;
          } else {
            value = (1024 + mant) * Math.pow(2, exp - 25);
          }
          return { type: "float", value: sign ? -value : value };
        }
        if (ai === 26) {
          // Single-precision float (4 bytes)
          const buf = new ArrayBuffer(4);
          const view = new DataView(buf);
          view.setUint32(0, Number(arg), false);
          return { type: "float", value: view.getFloat32(0, false) };
        }
        if (ai === 27) {
          // Double-precision float (8 bytes)
          const buf = new ArrayBuffer(8);
          const view = new DataView(buf);
          view.setBigUint64(0, arg, false);
          return { type: "float", value: view.getFloat64(0, false) };
        }
        // Simple values > 23 encoded with AI 24
        if (ai === 24) {
          const sv = Number(arg);
          if (sv === SIMPLE_FALSE) return { type: "bool", value: false };
          if (sv === SIMPLE_TRUE) return { type: "bool", value: true };
          if (sv === SIMPLE_NULL) return { type: "null" };
          if (sv === SIMPLE_UNDEFINED) return { type: "undefined" };
          throw new CborError(pos.value, `unsupported simple value ${sv}`);
        }
        throw new CborError(pos.value, `unsupported major type 7 AI ${ai}`);
      }
      default:
        throw new CborError(pos.value, `unsupported major type ${major}`);
    }
  }

  private readArgument(
    data: Uint8Array,
    pos: { value: number },
    ai: number,
  ): bigint {
    if (ai <= 23) return BigInt(ai);
    if (ai === 24) {
      if (pos.value >= data.length) {
        throw new CborError(pos.value, "unexpected end of input");
      }
      const val = data[pos.value++]!;
      if (val <= 23) {
        throw new CborError(
          pos.value,
          `non-canonical: value ${val} should use immediate encoding`,
        );
      }
      return BigInt(val);
    }
    if (ai === 25) {
      if (pos.value + 2 > data.length) {
        throw new CborError(pos.value, "unexpected end of input");
      }
      const val = (data[pos.value]! << 8) | data[pos.value + 1]!;
      pos.value += 2;
      if (val <= 0xff) {
        throw new CborError(
          pos.value,
          `non-canonical: value ${val} should use 1-byte encoding`,
        );
      }
      return BigInt(val);
    }
    if (ai === 26) {
      if (pos.value + 4 > data.length) {
        throw new CborError(pos.value, "unexpected end of input");
      }
      const val =
        (data[pos.value]! * 0x1000000) +
        (data[pos.value + 1]! << 16) +
        (data[pos.value + 2]! << 8) +
        data[pos.value + 3]!;
      pos.value += 4;
      if (val <= 0xffff) {
        throw new CborError(
          pos.value,
          `non-canonical: value ${val} should use 2-byte encoding`,
        );
      }
      return BigInt(val);
    }
    if (ai === 27) {
      if (pos.value + 8 > data.length) {
        throw new CborError(pos.value, "unexpected end of input");
      }
      let val = 0n;
      for (let i = 0; i < 8; i++) {
        val = (val << 8n) | BigInt(data[pos.value + i]!);
      }
      pos.value += 8;
      if (val <= 0xffffffffn) {
        throw new CborError(
          pos.value,
          "non-canonical: value should use 4-byte encoding",
        );
      }
      return val;
    }
    if (ai === 31) {
      throw new CborError(pos.value, "indefinite-length not allowed");
    }
    throw new CborError(pos.value, `unsupported additional info ${ai}`);
  }
}

/** Structural equality check for CBOR values (used for duplicate key detection). */
function cborEqual(a: CborValue, b: CborValue): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "uint":
    case "int":
    case "float":
      return a.value === (b as typeof a).value;
    case "bytes":
      return bytesEqual(a.value, (b as { type: "bytes"; value: Uint8Array }).value);
    case "text":
      return a.value === (b as { type: "text"; value: string }).value;
    case "bool":
      return a.value === (b as { type: "bool"; value: boolean }).value;
    case "null":
    case "undefined":
      return true;
    case "array": {
      const ba = b as { type: "array"; items: CborValue[] };
      if (a.items.length !== ba.items.length) return false;
      return a.items.every((item, i) => cborEqual(item, ba.items[i]!));
    }
    case "int-map": {
      const bb = b as { type: "int-map"; entries: [number, CborValue][] };
      if (a.entries.length !== bb.entries.length) return false;
      return a.entries.every(
        ([k, v]) =>
          bb.entries.some(([k2, v2]) => k === k2 && cborEqual(v, v2)),
      );
    }
    case "text-map": {
      const bb = b as { type: "text-map"; entries: [string, CborValue][] };
      if (a.entries.length !== bb.entries.length) return false;
      return a.entries.every(
        ([k, v]) =>
          bb.entries.some(([k2, v2]) => k === k2 && cborEqual(v, v2)),
      );
    }
    case "map": {
      const bb = b as { type: "map"; entries: CborMapEntry[] };
      if (a.entries.length !== bb.entries.length) return false;
      return a.entries.every(
        (e) =>
          bb.entries.some(
            (e2) => cborEqual(e.key, e2.key) && cborEqual(e.value, e2.value),
          ),
      );
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
  return new CborDecoder().decode(data).value;
}

/**
 * Convenience function: check that a byte buffer is valid canonical CBOR
 * (no trailing bytes, no non-canonical encodings).
 *
 * @param data - The CBOR byte stream to validate.
 * @throws {CborError} If the encoding is not canonical.
 */
export function checkCanonical(data: Uint8Array): void {
  new CborDecoder().checkCanonical(data);
}
