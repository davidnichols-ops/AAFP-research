// Golden trace verification — replays Rust `aafp-conformance` golden
// trace files (test/vectors/golden/*.trace) and asserts byte-equality.
//
// Each trace: { name, rfc_section, frames[], transcript_hash_final,
//   session_id } where each frame is { type, hex, direction }.
//
// Rule (TS_PHASE_8_TESTING.md §9): if a TS test diverges from a golden
// trace, the TS code is wrong (Rust reference is source of truth). Never
// edit a golden trace to make a TS test pass; file a bug against the TS
// implementation.
//
// NOTE: This is a pre-build scaffold. Test bodies are TODO stubs.
import { describe, it } from "vitest";

describe("golden trace replay (Rust source of truth)", () => {
  // it.each over test/vectors/golden/*.trace files.

  it.todo("each golden trace: every frame decodes without error");
  it.todo("each golden trace: decode(encode(frame)) === frame bytes (re-encode identical)");
  it.todo("each golden trace: frame types match recorded type field");

  it.todo("handshake_full_v1 trace reproduces recorded session_id");
  it.todo("handshake_full_v1 trace: transcript_hash_final matches Rust");
  it.todo("handshake_full_v1 trace: all three handshake frames present in order (C->S, S->C, C->S)");

  it.todo("rpc_echo trace: request + response frames round-trip identically");
  it.todo("streaming trace: token frames decode identically");
  it.todo("close trace: CLOSE frame decodes identically");

  it.todo("divergence rule: TS never edits a golden trace to pass (file TS bug instead)");
});
