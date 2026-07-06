/**
 * Isomorphic runtime detection utilities.
 *
 * The AAFP SDK is designed to run unchanged across Node.js, browsers, Deno,
 * and Bun. Transport selection and crypto backend selection are performed via
 * runtime feature detection — never build-time flags. This module centralizes
 * the detection logic so that the rest of the SDK can branch on runtime
 * characteristics without referencing Node-only globals at module top level.
 *
 * @module @aafp/sdk/isomorphic
 */

/**
 * The set of runtimes the SDK explicitly recognizes.
 *
 * - `"node"`    — Node.js (any version)
 * - `"browser"` — a web browser (Chrome, Edge, Firefox, Safari, …)
 * - `"deno"`    — Deno
 * - `"bun"`     — Bun
 * - `"unknown"` — an unrecognized runtime; the SDK falls back to the most
 *   universally available transport (WebSocket gateway) and WebCrypto.
 */
export type Runtime = "node" | "browser" | "deno" | "bun" | "unknown";

/**
 * Returns `true` when the current code is running in a web browser.
 *
 * Detection is based on the presence of a `window` global with a `document`
 * property — the canonical browser signature. This is more reliable than
 * checking for `process` absence, since some bundlers shim `process`.
 *
 * @returns `true` in a browser environment, `false` otherwise.
 */
export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as { window?: unknown }).window !==
      "undefined" &&
    typeof (globalThis as unknown as { document?: unknown }).document !==
      "undefined"
  );
}

/**
 * Returns `true` when the current code is running in Node.js.
 *
 * Detection checks for a `process` global with a `versions.node` property.
 * Bun also exposes `process.versions.node`, so callers that need to
 * distinguish Node from Bun should use {@link detectRuntime} or {@link isBun}.
 *
 * @returns `true` in a Node.js environment, `false` otherwise.
 */
export function isNode(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as { process?: { versions?: { node?: string } } })
      .process !== "undefined" &&
    typeof (globalThis as unknown as { process: { versions: { node?: string } } })
      .process.versions.node === "string"
  );
}

/**
 * Returns `true` when the current code is running in Deno.
 *
 * Detection is based on the presence of the `Deno` global namespace, which is
 * unique to the Deno runtime.
 *
 * @returns `true` in a Deno environment, `false` otherwise.
 */
export function isDeno(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as { Deno?: unknown }).Deno !== "undefined"
  );
}

/**
 * Returns `true` when the current code is running in Bun.
 *
 * Detection is based on the presence of the `Bun` global namespace. Bun also
 * shims `process.versions.node`, so this check takes precedence over
 * {@link isNode} in {@link detectRuntime}.
 *
 * @returns `true` in a Bun environment, `false` otherwise.
 */
export function isBun(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined"
  );
}

/**
 * Detects the current runtime by applying detection checks in precedence order.
 *
 * The order matters: Bun shims `process.versions.node`, so Bun is checked
 * before Node. Browsers are checked before Node as well, since some bundlers
 * inject a `process` shim into browser bundles.
 *
 * Resolution order:
 *   1. Deno  (`Deno` global)
 *   2. Bun   (`Bun` global)
 *   3. Browser (`window` + `document`)
 *   4. Node  (`process.versions.node`)
 *   5. Unknown
 *
 * @returns The detected {@link Runtime}; `"unknown"` if no signature matches.
 */
export function detectRuntime(): Runtime {
  if (isDeno()) return "deno";
  if (isBun()) return "bun";
  if (isBrowser()) return "browser";
  if (isNode()) return "node";
  return "unknown";
}
