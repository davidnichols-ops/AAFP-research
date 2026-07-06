/**
 * @aafp/cbor — Helper functions for constructing and querying CBOR maps.
 *
 * @packageDocumentation
 */

import type { CborValue, CborIntMap, CborStrMap } from "./types.js";

/**
 * Construct an integer-keyed CBOR map ({@link CborIntMap}) from a list of
 * `[key, value]` entries.
 *
 * The entries need not be pre-sorted — canonical ordering is applied at
 * encode time by {@link CborEncoder}.
 *
 * @param entries - Array of `[number, CborValue]` pairs.
 * @returns A `CborValue` of type `"int-map"`.
 *
 * @example
 * ```typescript
 * const map = intMap([
 *   [1, { type: "uint", value: 10 }],
 *   [2, { type: "uint", value: 20 }],
 * ]);
 * ```
 */
export function intMap(entries: [number, CborValue][]): CborIntMap {
  throw new Error("Not implemented");
}

/**
 * Look up a value by integer key in a CBOR map.
 *
 * @param map - The CBOR value to query. If not an `int-map`, returns `undefined`.
 * @param key - The integer key to search for.
 * @returns The matching value, or `undefined` if not found or `map` is not
 *   an integer-keyed map.
 */
export function intMapGet(map: CborValue, key: number): CborValue | undefined {
  throw new Error("Not implemented");
}

/**
 * Construct a string-keyed CBOR map ({@link CborStrMap}) from a list of
 * `[key, value]` entries.
 *
 * The entries need not be pre-sorted — canonical ordering is applied at
 * encode time by {@link CborEncoder}.
 *
 * @param entries - Array of `[string, CborValue]` pairs.
 * @returns A `CborValue` of type `"text-map"`.
 *
 * @example
 * ```typescript
 * const map = strMap([
 *   ["name", { type: "text", value: "agent-1" }],
 *   ["version", { type: "uint", value: 1 }],
 * ]);
 * ```
 */
export function strMap(entries: [string, CborValue][]): CborStrMap {
  throw new Error("Not implemented");
}

/**
 * Look up a value by string key in a CBOR map.
 *
 * @param map - The CBOR value to query. If not a `text-map`, returns `undefined`.
 * @param key - The string key to search for.
 * @returns The matching value, or `undefined` if not found or `map` is not
 *   a string-keyed map.
 */
export function strMapGet(map: CborValue, key: string): CborValue | undefined {
  throw new Error("Not implemented");
}
