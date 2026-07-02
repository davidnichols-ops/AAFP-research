# ADR-0003: MCP uses DATA frames rather than native AAFP RPC

## Status

Accepted

## Context

AAFP defines two mechanisms for carrying application messages:

1. **DATA frames** (frame type 0x01): Opaque payload, application-defined
   encoding. The frame header provides length-delimited boundaries.

2. **RPC frames** (frame types 0x03/0x04): AAFP's native RPC system with
   CBOR encoding, integer method IDs, and canonical CBOR serialization
   (RFC 8949 deterministic).

When building the MCP transport binding, the question was: which mechanism
should carry MCP's JSON-RPC messages?

**Arguments for RPC frames:**
- AAFP's RPC system is purpose-built for request/response communication
- CBOR is more compact than JSON
- Integer method IDs are more efficient than string method names
- AAFP's RPC layer provides built-in request/response correlation

**Arguments for DATA frames:**
- MCP's wire format is JSON-RPC 2.0 with JSON encoding (per the MCP
  specification)
- The rmcp SDK's `Transport<R>` trait expects JSON-serializable messages
- Transcoding to CBOR would break MCP specification compliance
- DATA frames are designed for exactly this purpose: carrying opaque
  application payloads

## Decision

**MCP messages are carried as DATA frames, not RPC frames.**

The MCP transport binding uses `Frame::data(stream_id, json_bytes)` to
carry each JSON-RPC message. It does not use `Frame::rpc_request()` or
`Frame::rpc_response()`.

This decision is a direct consequence of ADR-0002 (preserve application
payloads) and ADR-0001 (AAFP is a session layer). MCP owns its message
format; AAFP provides the transport.

## Consequences

**What becomes easier:**
- The binding is MCP specification-compliant (JSON-RPC 2.0 wire format
  preserved)
- The binding works with the rmcp SDK without modification
- The binding can be tested against MCP conformance test suites
- No need to maintain a JSON-to-CBOR transcoding layer

**What becomes harder:**
- The wire format is JSON (verbose) rather than CBOR (compact)
- AAFP's native RPC correlation (request IDs, response matching) is not
  used; MCP's JSON-RPC `id` field provides correlation instead
- The binding cannot leverage AAFP's RPC-specific features (e.g., RPC
  error codes, RPC timeouts)

**When RPC frames would be appropriate:**
AAFP's RPC frames are appropriate for AAFP-internal operations —
operations that are defined by AAFP itself, not by an external application
protocol. For example, if AAFP adds a discovery query protocol or a relay
management protocol, those operations could use RPC frames with CBOR
encoding. External application protocols (MCP, A2A) use DATA frames.

**Relationship to ADR-0001:**
This ADR is a specific application of ADR-0001. AAFP is a session layer;
it does not define application methods. MCP's methods (`tools/list`,
`tools/call`) are application-level, so they travel as opaque DATA payloads,
not as AAFP RPC calls.
