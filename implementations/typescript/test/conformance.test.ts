// Conformance test suite — mirrors the Rust `aafp-conformance` crate
// module-for-module, preserving RFC normative requirement IDs
// (R2-001, R3-002, R5-003, ...) as test names for side-by-side audit.
//
// Rust module -> TS coverage mapping (TS_PHASE_8_TESTING.md §8):
//   rfc0002.rs            -> framing, CBOR, handshake transcript
//   rfc0003.rs            -> identity, ML-DSA-65, AgentId derivation
//   rfc0005.rs            -> error model, HandlerError categories
//   close_conformance.rs  -> CLOSE frame state machine (§6.6)
//   replay_conformance.rs -> ReplayCache (§6.7)
//   version_negotiation.rs-> protocol version negotiation
//   pipeline_order.rs     -> RPC pipeline ordering rules
//   negative.rs           -> malformed input rejection
//
// NOTE: This is a pre-build scaffold. Test bodies are TODO stubs.
import { describe, it } from "vitest";

describe("RFC-0002 conformance (framing, CBOR, handshake transcript)", () => {
  it.todo("R2-001: frame header is 28 bytes");
  it.todo("R2-002: protocol version at offset 0");
  it.todo("R2-003: frame type at offset 1");
  it.todo("R2-005: reserved byte MUST be zero");
  it.todo("R2-006: stream id 8-byte big-endian at offset 4");
  it.todo("R2-007: payload length 8-byte big-endian at offset 12");
  it.todo("R2-008: extension length 8-byte big-endian at offset 20");
  it.todo("R2-0xx: handshake transcript hash checkpoints match Rust");
  it.todo("R2-0xx: session_id derivation matches Rust");
});

describe("RFC-0003 conformance (identity, ML-DSA-65, AgentId)", () => {
  it.todo("R3-001: AgentId is derived from ML-DSA-65 public key");
  it.todo("R3-002: AgentId encoding is canonical");
  it.todo("R3-003: keygen determinism from 32-byte seed");
  it.todo("R3-0xx: signature verification matches reference vectors");
});

describe("RFC-0005 conformance (error model)", () => {
  it.todo("R5-001: 8 error categories defined");
  it.todo("R5-002: each category has stable u8 code");
  it.todo("R5-003: category encodes as u8 on wire");
  it.todo("R5-004: unknown category code rejected on decode");
  it.todo("R5-0xx: error message round-trips through CBOR");
});

describe("CLOSE frame state machine (RFC-0002 §6.6)", () => {
  it.todo("CLOSE frame transitions connection to closing state");
  it.todo("CLOSE frame carries optional diagnostic");
  it.todo("post-CLOSE frames are rejected");
});

describe("ReplayCache (RFC-0002 §6.7)", () => {
  it.todo("replayed frame within window is rejected");
  it.todo("non-replayed frame is accepted");
  it.todo("cache eviction respects window size");
});

describe("protocol version negotiation", () => {
  it.todo("server rejects unsupported protocol version");
  it.todo("version negotiation selects highest mutually supported version");
});

describe("RPC pipeline ordering rules", () => {
  it.todo("requests on same stream are processed in order");
  it.todo("responses match request order on a stream");
});

describe("malformed input rejection (negative)", () => {
  it.todo("truncated frame header rejected");
  it.todo("oversized payload rejected");
  it.todo("invalid CBOR rejected");
  it.todo("non-zero reserved byte rejected");
});
