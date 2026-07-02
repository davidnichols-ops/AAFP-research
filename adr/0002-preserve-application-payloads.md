# ADR-0002: Transport bindings preserve application payloads

## Status

Accepted

## Context

When building a transport binding for an application protocol (MCP, A2A)
over AAFP, a key design decision is how to handle the application payload:

1. **Preserve payloads byte-for-byte**: Carry the application protocol's
   native encoding (JSON for MCP/A2A) as the opaque payload of AAFP DATA
   frames. No transcoding, no interpretation, no modification.

2. **Transcode to AAFP's native encoding**: Convert application messages
   to AAFP's CBOR-based encoding for efficiency. This would require
   understanding the application message structure.

3. **Use AAFP's native RPC frames**: Map application protocol methods to
   AAFP RPC_REQUEST/RPC_RESPONSE frames with CBOR encoding.

The choice affects compatibility, performance, and maintenance burden.

## Decision

**Transport bindings preserve application payloads byte-for-byte.**

The AAFP transport binding for MCP carries JSON-RPC messages as the opaque
payload of AAFP DATA frames. The binding does not:

- Transcode JSON to CBOR
- Interpret or modify JSON content
- Map MCP methods to AAFP RPC methods
- Coalesce or split messages

Each application message becomes exactly one AAFP DATA frame. The frame
header provides length-delimited boundaries; the payload is the untouched
application message.

This is the intended use of DATA frames per RFC-0002 §4.1:

> "DATA frames carry application-layer messages. The interpretation of the
> payload is determined by the application protocol running on the stream."

## Consequences

**What becomes easier:**
- The binding is compatible with any application SDK that produces the
  expected message format (JSON-RPC for MCP/A2A)
- Application protocol evolution (new methods, new fields, new versions)
  requires no changes to the transport binding
- The binding has no dependency on application protocol specifics
- Testing is simpler: verify that bytes in equal bytes out

**What becomes harder:**
- No opportunity for cross-layer optimization (e.g., AAFP cannot compress
  JSON payloads because it treats them as opaque)
- Wire format is less compact than CBOR would be
- The binding cannot provide application-level features (e.g., method
  routing, error mapping) — those belong to the application SDK

**Risks:**
- JSON is verbose compared to CBOR; bandwidth-sensitive deployments may
  want compression. This can be addressed at the QUIC layer (QUIC supports
  connection-level compression) or via AAFP frame extensions in the future.

**Why not transcoding?**
Transcoding JSON to CBOR would:
- Break compatibility with the application SDK (rmcp expects JSON)
- Require the transport to understand the application message structure
- Create a maintenance burden: every application protocol change requires
  a transport change
- Violate the layering principle (ADR-0001)

**Why not native RPC frames?**
AAFP's RPC_REQUEST/RPC_RESPONSE frames use CBOR with integer keys. Mapping
MCP's JSON-RPC methods to these frames would:
- Change the wire format, breaking MCP specification compliance
- Require a parallel encoding/decoding layer that duplicates the
  application SDK's model
- Make the binding incompatible with MCP conformance tests
