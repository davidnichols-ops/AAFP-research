# Compatibility Layer Analysis

**Review date:** 2026-07-02
**Scope:** The design decision to carry MCP JSON-RPC messages as payloads of AAFP DATA frames
**Question:** Is this a deliberate compatibility layer (A) or an architectural shortcut (B)?

---

## 1. Verdict

**This is Option A: a deliberate compatibility layer.**

The use of AAFP DATA frames (frame type 0x01) to carry MCP JSON-RPC messages
is architecturally correct per RFC-0002 §4.1, which explicitly states:

> "DATA frames carry application-layer messages. The interpretation of the
> payload is determined by the application protocol running on the stream."

DATA frames are the AAFP protocol's mechanism for carrying opaque application
payloads. The MCP transport uses them exactly as intended. This is not a
shortcut that bypasses AAFP's framing model — it is the framing model's
intended use for application protocols.

---

## 2. Current Design

### 2.1 What the transport does

```
MCP JSON-RPC message (UTF-8 JSON)
    ↓ serde_json::to_vec()
JSON bytes
    ↓ Frame::data(stream_id, json_bytes)
AAFP DATA frame (frame type 0x01, payload = JSON bytes)
    ↓ encode_frame()
28-byte header + JSON payload
    ↓ QuicSendStream::write_all()
QUIC stream
```

### 2.2 What AAFP provides

AAFP defines two categories of frame types:

**Control frames** (CBOR-encoded, AAFP-defined payload format):
- HANDSHAKE (0x02): Connection handshake messages
- RPC_REQUEST (0x03): AAFP native RPC requests (CBOR, integer keys)
- RPC_RESPONSE (0x04): AAFP native RPC responses (CBOR, integer keys)
- CLOSE (0x05): Connection close
- ERROR (0x06): Protocol errors
- PING (0x07): Keepalive probes
- PONG (0x08): Keepalive responses

**Application frames** (opaque payload, application-defined format):
- DATA (0x01): Application-layer messages

The MCP transport uses DATA frames, which are the application frame type.
It does not use RPC_REQUEST/RPC_RESPONSE frames.

### 2.3 Why not use AAFP's native RPC frames?

AAFP provides a native CBOR-based RPC system using RPC_REQUEST (0x03) and
RPC_RESPONSE (0x04) frames. One might ask whether the MCP transport should
transcode JSON-RPC messages into AAFP's native CBOR RPC format.

**It should not, for three reasons:**

1. **MCP's wire format is JSON-RPC 2.0 with JSON serialization.** The MCP
   specification [1] defines the message format as JSON-RPC 2.0 with JSON
   encoding. Transcoding to CBOR would change the wire format, breaking
   compatibility with the MCP specification and all existing MCP SDKs.

2. **The rmcp SDK operates on JSON.** The `Transport<R>` trait's
   `TxJsonRpcMessage<R>` and `RxJsonRpcMessage<R>` types are JSON-serializable.
   The transport's contract is to carry these messages intact. Transcoding
   to CBOR would require a parallel CBOR encoding/decoding layer that
   duplicates rmcp's JSON model.

3. **AAFP's RPC frames are optional.** RFC-0002 defines RPC_REQUEST and
   RPC_RESPONSE as part of AAFP's built-in RPC system, but applications are
   not required to use them. DATA frames exist precisely for application
   protocols that have their own message format (like MCP's JSON-RPC).

---

## 3. Long-Term Target Architecture

### 3.1 The layered model

```
┌─────────────────────────────────────────────────────┐
│  Application Protocol Layer                          │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │ MCP (JSON-RPC)   │  │ A2A (JSON-RPC)           │ │
│  │ JSON encoding    │  │ JSON encoding            │ │
│  │ rmcp dispatch    │  │ A2A dispatch             │ │
│  └────────┬─────────┘  └──────────┬───────────────┘ │
│           │                       │                  │
│  ┌────────┴───────────────────────┴───────────────┐ │
│  │  AAFP Transport Binding Layer                   │ │
│  │  - Stream management (long-lived or per-msg)    │ │
│  │  - Frame I/O (DATA frames)                      │ │
│  │  - Handshake + authorization                    │ │
│  └────────┬───────────────────────────────────────┘ │
├───────────┼─────────────────────────────────────────┤
│           │  AAFP Core Protocol Layer                │
│  ┌────────┴───────────────────────────────────────┐ │
│  │  Framing (28-byte header, 8 frame types)        │ │
│  │  Handshake (ML-DSA-65, PQ TLS)                  │ │
│  │  Session state machine                          │ │
│  │  Control frames (CLOSE, ERROR, PING/PONG)       │ │
│  │  Native RPC (RPC_REQUEST/RESPONSE, CBOR)        │ │
│  └────────┬───────────────────────────────────────┘ │
├───────────┼─────────────────────────────────────────┤
│           │  Transport Layer                         │
│  ┌────────┴───────────────────────────────────────┐ │
│  │  QUIC (quinn) + PQ TLS (rustls)                 │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 3.2 The key architectural boundary

The boundary between "AAFP Core" and "Transport Binding" is the DATA frame.
AAFP Core provides:
- The frame format (28-byte header)
- The handshake (ML-DSA-65 identity verification)
- The session state machine
- Control frames (CLOSE, ERROR, PING/PONG)
- Optional native RPC (CBOR)

Transport bindings provide:
- Application protocol message encoding (JSON, protobuf, etc.)
- Stream management strategy (long-lived vs per-message)
- Application-level dispatch (JSON-RPC method routing)

This boundary is clean and intentional. The MCP transport sits on the
correct side of it.

### 3.3 Future evolution

The current design has a clear evolution path:

1. **Today**: MCP and A2A use DATA frames with JSON payloads
2. **Future**: AAFP could add a negotiation mechanism (via handshake
   extensions) to declare which application protocol runs on a stream
3. **Future**: Applications that want AAFP's native CBOR RPC can use
   RPC_REQUEST/RPC_RESPONSE frames instead of DATA frames

No migration is needed. The DATA frame approach is the terminal state for
JSON-RPC protocols, not a transitional state.

---

## 4. Compatibility Guarantees

### 4.1 What is guaranteed

| Guarantee | Scope |
|-----------|-------|
| MCP JSON-RPC messages are preserved byte-for-byte | The transport does not modify JSON content |
| AAFP frame format is RFC-0002 compliant | 28-byte header, version 1, frame type 0x01 |
| AAFP handshake is performed before application data | ML-DSA-65 identity verification |
| Session state machine is enforced | MessagingEnabled required before DATA frames |
| Stream ordering is preserved | QUIC provides in-order delivery within a stream |

### 4.2 What is not guaranteed

| Non-guarantee | Reason |
|---------------|--------|
| Stream ID value | Currently 1 (should be 4 — see architecture review) |
| Single stream for all messages | Application protocol choice; could change |
| JSON encoding efficiency | JSON is MCP's format; CBOR would be more compact but non-conformant |
| Interoperability with AAFP native RPC | DATA frames and RPC frames are independent |

### 4.3 Forward compatibility

The design is forward-compatible with:

1. **Multiple application protocols per connection**: Future transport
   bindings (A2A, etc.) can use different streams on the same AAFP
   connection, each carrying a different application protocol.

2. **Protocol negotiation**: If AAFP adds a negotiation mechanism in the
   handshake (via extensions), the transport can declare which application
   protocol it speaks without changing the DATA frame format.

3. **Alternative encodings**: If MCP adds a binary encoding in the future,
   the transport can carry it in DATA frames without changes to the AAFP
   layer.

---

## 5. Migration Strategy

**No migration is needed.** The DATA frame approach is the correct
long-term design, not a transitional state.

If, in the future, there is a desire to use AAFP's native CBOR RPC for
AAFP-internal operations (e.g., discovery, relay management), those
operations would use RPC_REQUEST/RPC_RESPONSE frames on separate streams.
The MCP transport's DATA frames would continue unchanged.

The only scenario that would require migration is if AAFP deprecated DATA
frames entirely, which would be a major protocol breaking change with
no architectural justification.

---

## 6. Why This Is the Correct Initial Strategy

1. **Minimal adoption friction**: Developers familiar with MCP can use the
   AAFP transport without learning a new wire format. The JSON-RPC messages
   they see are identical to those on stdio or HTTP transports.

2. **Protocol compliance**: MCP's specification defines JSON-RPC 2.0 as the
   wire format. Preserving this ensures compatibility with all MCP SDKs,
   conformance test suites, and tooling.

3. **Separation of concerns**: AAFP handles transport security (PQ TLS,
   identity verification, framing). MCP handles application semantics
   (tools, resources, prompts). The DATA frame is the clean boundary
   between these layers.

4. **No unnecessary transcoding**: Converting JSON to CBOR and back would
   add CPU cost and complexity for no benefit. The AAFP frame header
   already provides length-delimited message boundaries, which is the
   only framing service MCP needs from the transport.

5. **Ecosystem compatibility**: The rmcp SDK's `Transport<R>` trait expects
   to send and receive `TxJsonRpcMessage<R>` / `RxJsonRpcMessage<R>` types,
   which are JSON-serializable. The transport's job is to carry these
   intact, not to transform them.

---

## References

- [1] MCP Specification, Transports: https://modelcontextprotocol.io/specification/draft/basic/transports
- [2] AAFP Protocol, RFC-0002 §4.1: DATA Frame
- [3] AAFP Protocol, RFC-0002 §7.1: Stream ID Allocation
- [4] rmcp Transport trait: https://docs.rs/rmcp/
- [5] JSON-RPC 2.0 Specification: https://www.jsonrpc.org/specification
