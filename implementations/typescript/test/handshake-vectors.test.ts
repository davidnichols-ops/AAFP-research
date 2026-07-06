// v1 handshake transcript vector replay — mirrors Rust
// `aafp-conformance/src/handshake_vectors.rs`.
//
// Source of truth: test/vectors/handshake_vectors.json. Each
// HandshakeVector records fixed nonces, TLS binding, serialized public
// keys, transcript checkpoints (after ClientHello / ServerHello /
// ClientFinished), CBOR encodings, signature inputs, signatures, and the
// derived session_id.
//
// See TS_PHASE_8_TESTING.md §5.
//
// NOTE: This is a pre-build scaffold. Test bodies are TODO stubs.
import { describe, it } from "vitest";

describe("v1 handshake transcript (RFC-0002 §5)", () => {
  // Transcript + CBOR byte-equality.

  it.todo("ClientHello CBOR matches Rust byte-for-byte");
  it.todo("ServerHello CBOR matches Rust byte-for-byte");
  it.todo("ClientFinished CBOR matches Rust byte-for-byte");

  // Transcript hash checkpoints.

  it.todo("transcript hash after ClientHello matches Rust");
  it.todo("transcript hash after ServerHello matches Rust");
  it.todo("transcript hash after ClientFinished matches Rust");

  // session_id derivation.

  it.todo("session_id derivation matches Rust");

  // Signature verification against recorded public keys.

  it.todo("ClientHello signature verifies with recorded client public key");
  it.todo("ServerHello signature verifies with recorded server public key");
  it.todo("ClientFinished signature verifies with recorded client public key");
});

describe("v1 handshake state machine (RFC-0002 §5.10)", () => {
  // Port of Rust handshake_state_machine.rs tests, each tagged with the
  // RFC-0002 §5.10 sub-state it covers.

  it.todo("§5.10: rejects invalid state transitions");
  it.todo("§5.10: rejects duplicate ClientHello");
  it.todo("§5.10: rejects unexpected frame type in handshake phase");
  it.todo("§5.10: handshake timeout behavior");
  it.todo("§5.10: ClientHello before ServerHello ordering enforced");
  it.todo("§5.10: ServerHello before ClientFinished ordering enforced");
});
