/**
 * @aafp/cbor — Canonical CBOR encoder/decoder for AAFP (RFC 8949 §4.2.3).
 *
 * Public API surface for the `@aafp/cbor` package.
 *
 * @packageDocumentation
 */

// Types
export type {
  CborValue,
  CborMap,
  CborIntMap,
  CborStrMap,
  CborMapEntry,
} from "./types.js";
export { CborError } from "./types.js";

// Encoder
export type { CborEncoderOptions } from "./encoder.js";
export { CborEncoder, encodeCbor } from "./encoder.js";

// Decoder
export type { CborDecoderOptions, CborDecodeResult } from "./decoder.js";
export {
  CborDecoder,
  decodeCbor,
  checkCanonical,
  DEFAULT_MAX_DECODE_DEPTH,
} from "./decoder.js";

// Helpers
export {
  intMap,
  intMapGet,
  strMap,
  strMapGet,
} from "./helpers.js";
