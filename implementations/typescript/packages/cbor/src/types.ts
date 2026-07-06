/**
 * @aafp/cbor — Canonical CBOR type definitions (RFC 8949 §4.2.3).
 *
 * These types mirror the Rust `aafp_cbor::Value` enum and extend it with
 * the full variant set required by the TypeScript SDK (Float, Undefined).
 *
 * @packageDocumentation
 */

/**
 * Error thrown during CBOR encoding or decoding.
 *
 * Carries the byte offset where the error was detected so callers can
 * pinpoint the problematic location in the input stream.
 */
export class CborError extends Error {
  /** Byte offset in the input where the error was detected. */
  public readonly offset: number;

  /**
   * @param offset - Byte offset where the error occurred.
   * @param message - Human-readable description of the error.
   */
  constructor(offset: number, message: string) {
    super(`CBOR error at offset ${offset}: ${message}`);
    this.name = "CborError";
    this.offset = offset;
  }
}

/**
 * A single entry in a CBOR map.
 *
 * The key may be any CBOR value, though canonical AAFP maps use either
 * integer keys (for protocol structures) or string keys (for metadata).
 */
export interface CborMapEntry {
  /** The map key (typically an int or text value). */
  key: CborValue;
  /** The value associated with the key. */
  value: CborValue;
}

/**
 * A CBOR map with integer keys (canonical AAFP map representation).
 *
 * This is the primary map type used in AAFP protocol structures. Keys are
 * `number` (i64) values. When encoded, keys are sorted by length-first
 * canonical byte ordering per RFC 8949 §4.2.3.
 */
export interface CborIntMap {
  /** Discriminant: always `"int-map"`. */
  type: "int-map";
  /** Ordered list of `[key, value]` pairs. Order is canonicalized on encode. */
  entries: [number, CborValue][];
}

/**
 * A CBOR map with string keys (used for CapabilityDescriptor metadata).
 *
 * String-keyed maps are only used in the metadata map; all other AAFP
 * structures use {@link CborIntMap}.
 */
export interface CborStrMap {
  /** Discriminant: always `"text-map"`. */
  type: "text-map";
  /** Ordered list of `[key, value]` pairs. Order is canonicalized on encode. */
  entries: [string, CborValue][];
}

/**
 * Discriminated union of all CBOR value variants.
 *
 * Variants:
 * - `int`     — negative integer (i64 range)
 * - `uint`    — unsigned integer (u64 range; use BigInt-safe values)
 * - `float`   — IEEE 754 floating point number
 * - `bytes`   — byte string (`Uint8Array`)
 * - `text`    — UTF-8 text string
 * - `array`   — ordered array of CBOR values
 * - `map`     — generic map with mixed-type keys ({@link CborMapEntry}[])
 * - `bool`    — boolean
 * - `null`    — null (CBOR simple value 22)
 * - `undefined` — undefined (CBOR simple value 23)
 *
 * For canonical AAFP maps, prefer {@link CborIntMap} or {@link CborStrMap}
 * (which are also members of this union) over the generic `map` variant.
 */
export type CborValue =
  /** A negative integer value (CBOR major type 1). */
  | { type: "int"; value: number }
  /** An unsigned integer value (CBOR major type 0). */
  | { type: "uint"; value: number }
  /** A floating-point value (CBOR major type 7, simple/float). */
  | { type: "float"; value: number }
  /** A byte string value (CBOR major type 2). */
  | { type: "bytes"; value: Uint8Array }
  /** A UTF-8 text string value (CBOR major type 3). */
  | { type: "text"; value: string }
  /** An array of CBOR values (CBOR major type 4). */
  | { type: "array"; items: CborValue[] }
  /** A generic map with arbitrary CBOR keys (CBOR major type 5). */
  | { type: "map"; entries: CborMapEntry[] }
  /** A boolean value (CBOR simple values 20/21). */
  | { type: "bool"; value: boolean }
  /** A null value (CBOR simple value 22). */
  | { type: "null" }
  /** An undefined value (CBOR simple value 23). */
  | { type: "undefined" }
  /** An integer-keyed map (canonical AAFP map). */
  | CborIntMap
  /** A string-keyed map (metadata map). */
  | CborStrMap;

/**
 * Union of the two map variants supported by canonical AAFP CBOR.
 *
 * The decoder produces one of these depending on the key types present;
 * mixed-key maps are rejected as non-canonical.
 */
export type CborMap = CborIntMap | CborStrMap;
