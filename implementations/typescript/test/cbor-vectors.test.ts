// CBOR golden vector tests — mirrors Rust `aafp-conformance/src/test_vectors.rs::cbor_vectors()`.
//
// Source of truth: test/vectors/cbor_vectors.json (exported from Rust via
// `aafp-conformance`'s `export_vectors` binary). Each TestVector records
// { name, rfc_section, semantic_input, cbor_hex, expected_hash_hex }.
//
// See TS_PHASE_8_TESTING.md §3.
//
// NOTE: This is a pre-build scaffold. Test bodies are TODO stubs.
import { describe, it } from "vitest";

describe("CBOR golden vectors (Rust aafp-cbor)", () => {
  // The it.each loop below iterates the exported JSON so adding a Rust
  // vector automatically adds a TS test. Categories mirror the Rust
  // cbor_vectors() generator coverage.

  it.todo("unsigned integer vectors encode byte-for-byte identical to Rust");
  it.todo("negative integer vectors encode byte-for-byte identical to Rust");
  it.todo("byte string vectors encode byte-for-byte identical to Rust");
  it.todo("text string vectors encode byte-for-byte identical to Rust");
  it.todo("array vectors encode byte-for-byte identical to Rust");
  it.todo("nested map vectors encode byte-for-byte identical to Rust");
  it.todo("empty map vector encodes byte-for-byte identical to Rust");
  it.todo("large u64 requiring 8-byte additional info encodes identically to Rust");

  it.todo("each vector: SHA-256(encode(input)) matches expected_hash_hex");
  it.todo("each vector: decode(encode(input)) deep-equals semantic input");

  it.todo(
    "integer-keyed map uses canonical ordering (RFC 89449 §3.1): " +
      "key 23 (0x17) sorts before key 100 (0x18 0x64)",
  );
  it.todo("deterministic encoding: same value -> same bytes across calls");
  it.todo("round-trip stability: decode(encode(x)) === x for all vector categories");
});
