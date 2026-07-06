// RFC-0002 §3 frame header encoding/decoding tests — mirrors Rust
// `aafp-conformance/src/rfc0002.rs` (frame header tests R2-001 .. R2-0xx).
//
// 28-byte header layout:
//   offset 0  : protocol version (1 byte)
//   offset 1  : frame type (1 byte)
//   offset 2  : flags (1 byte)
//   offset 3  : reserved, MUST be 0 (1 byte)
//   offset 4  : stream id (8 bytes, big-endian)
//   offset 12 : payload length (8 bytes, big-endian)
//   offset 20 : extension length (8 bytes, big-endian)
//
// See TS_PHASE_8_TESTING.md §6.
//
// NOTE: This is a pre-build scaffold. Test bodies are TODO stubs.
import { describe, it } from "vitest";

describe("RFC-0002 §3 frame header", () => {
  // Header layout / field offsets.

  it.todo("R2-001: header is exactly 28 bytes (plus payload)");
  it.todo("R2-002: protocol version at offset 0 equals AAFP_VERSION");
  it.todo("R2-003: frame type at offset 1 matches FrameType enum");
  it.todo("R2-004: flags byte at offset 2 round-trips");
  it.todo("R2-005: reserved byte at offset 3 MUST be zero on encode");
  it.todo("R2-006: stream id is 8-byte big-endian at offset 4");
  it.todo("R2-007: payload length is 8-byte big-endian at offset 12");
  it.todo("R2-008: extension length is 8-byte big-endian at offset 20");

  // Round-trip.

  it.todo("round-trip: decode(encode(f)) deep-equals f for all frame types");
  it.todo("round-trip: DATA frame with empty payload");
  it.todo("round-trip: DATA frame with max-size payload");
  it.todo("round-trip: HANDSHAKE frame");
  it.todo("round-trip: RPC frame with extensions");

  // Rejection / negative cases.

  it.todo("rejects payload > MAX_PAYLOAD_SIZE on encode");
  it.todo("rejects non-zero reserved byte on decode");
  it.todo("rejects unknown frame type on decode");
  it.todo("rejects truncated header (< 28 bytes) on decode");
  it.todo("rejects mismatched protocol version on decode");
});
