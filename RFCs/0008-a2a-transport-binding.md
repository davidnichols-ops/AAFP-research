# RFC 0008: AAFP Transport Binding for A2A

## Status

Proposed

## Summary

This RFC defines a custom protocol binding for the Agent2Agent (A2A) Protocol
over the Agent Agent Federation Protocol (AAFP) transport. AAFP provides
post-quantum secure QUIC transport with ML-DSA-65 agent identity verification,
making it suitable for A2A deployments that require strong cryptographic
identity guarantees without relying on HTTP/TLS PKI.

## Motivation

The A2A Protocol [1] defines three standard protocol bindings (JSON-RPC, gRPC,
HTTP+JSON/REST), all of which operate over HTTP(S). This creates several
limitations for agent-to-agent communication in decentralized and
high-security environments:

1. **PKI dependency**: HTTP(S) relies on X.509 PKI for server identity, which
   is not suitable for peer-to-peer agent networks where agents may not have
   domain-validated certificates.

2. **No post-quantum security**: TLS 1.3 does not mandate post-quantum key
   exchange, leaving agent communications vulnerable to future quantum attacks.

3. **HTTP overhead**: HTTP adds header overhead and connection management
   complexity that is unnecessary for direct agent-to-agent communication.

4. **No native streaming**: HTTP streaming (SSE, chunked encoding) is
   workable but not as clean as QUIC's native bidirectional streams.

AAFP addresses these issues by providing:
- **Post-quantum TLS**: X25519MLKEM768 hybrid key exchange via quinn/rustls
- **ML-DSA-65 identity**: Agent identity verified during the AAFP handshake,
  not dependent on external PKI
- **QUIC transport**: Low-latency, multiplexed, head-of-line-blocking-free
- **Bidirectional streams**: Native support for streaming operations

The A2A specification explicitly supports custom protocol bindings [2]:

> "The A2A protocol ships with three standard bindings (JSON-RPC, gRPC, and
> HTTP+JSON/REST) that cover the majority of deployment scenarios. Custom
> protocol bindings let implementers expose A2A operations over additional
> transport mechanisms not covered by the standard set."

Custom bindings must satisfy two key requirements [2]:

> "All core operations must be supported. The binding must expose every
> operation defined in the abstract operations layer."

> "The data model must be preserved. All data structures must be
> functionally equivalent to the canonical Protocol Buffer definitions. JSON
> serializations must use camelCase field names, and timestamps must be ISO
> 8601 strings in UTC."

This binding satisfies those requirements: it exposes all 11 core operations
and preserves the JSON data model byte-for-byte within AAFP DATA frames.

## Design

### Layer Mapping

A2A's three-layer architecture maps to AAFP as follows:

| A2A Layer | AAFP Mapping |
|-----------|-------------|
| Layer 1: Canonical Data Model | JSON serialization (camelCase, ISO 8601 timestamps) per A2A convention |
| Layer 2: Abstract Operations | JSON-RPC 2.0 method calls over AAFP DATA frames |
| Layer 3: Protocol Binding | AAFP QUIC transport with v1 handshake |

### Transport Architecture

```
┌──────────────────────────────────────────┐
│         A2A Application Layer            │
│   (Agent logic, task management)         │
├──────────────────────────────────────────┤
│         A2A JSON-RPC Binding             │
│   (method dispatch, error mapping)       │
├──────────────────────────────────────────┤
│         AAFP Framing Layer               │
│   (DATA frames, stream multiplexing)     │
├──────────────────────────────────────────┤
│         AAFP v1 Handshake                │
│   (ML-DSA-65 identity, PQ KEX)           │
├──────────────────────────────────────────┤
│         QUIC Transport                   │
│   (quinn + rustls, X25519MLKEM768)       │
└──────────────────────────────────────────┘
```

### Binding Identification

- **URI**: `https://a2a-protocol.org/bindings/aafp`
- **Protocol version**: A2A 1.0
- **AAFP version**: 1.0

### Agent Card Declaration

An agent that supports the AAFP binding declares it in `supportedInterfaces`:

```json
{
  "supportedInterfaces": [
    {
      "url": "quic://agent.example.com:443",
      "protocolBinding": "https://a2a-protocol.org/bindings/aafp",
      "protocolVersion": "1.0"
    }
  ]
}
```

The `url` field uses the `quic://` scheme with the agent's AAFP listen address.

### Connection Establishment

1. **QUIC connection**: The client dials the agent's QUIC endpoint. The TLS
   handshake negotiates X25519MLKEM768 for post-quantum key exchange and
   selects the `aafp/1` ALPN.

2. **AAFP v1 handshake**: ClientHello / ServerHello / ClientFinished exchange
   on QUIC stream 0. The client and server verify each other's ML-DSA-65
   identities. The TLS channel binding is mixed into the transcript hash.

3. **Authorization**: The server's `AuthorizationProvider` decides whether to
   accept the client's agent identity. AAFP's `TestingAuthProvider` allows all;
   production deployments use custom providers (e.g., UCAN capability checks).

4. **Application stream**: The client opens a bidirectional QUIC stream for
   JSON-RPC messages. All A2A operations are exchanged on this stream as
   AAFP DATA frames.

### Data Type Mappings

The AAFP binding uses JSON serialization consistent with the A2A JSON-RPC
binding:

| A2A Type | AAFP Representation |
|----------|-------------------|
| protobuf Message | JSON object (camelCase fields) |
| bytes | base64 string |
| Timestamp | ISO 8601 string in UTC |
| enum | string (as defined in A2A JSON schema) |
| int32/int64/uint32/uint64 | JSON number |
| bool | JSON boolean |
| string | JSON string |
| repeated T | JSON array |
| map<K,V> | JSON object |

### Service Parameters

A2A service parameters (tracing IDs, auth hints) are carried as a top-level
JSON field in the JSON-RPC request:

```json
{
  "jsonrpc": "2.0",
  "method": "SendMessage",
  "params": {
    "message": { ... },
    "configuration": { ... },
    "metadata": {
      "a2a-service-parameters": {
        "trace-id": "abc123",
        "auth-hint": "bearer"
      }
    }
  },
  "id": 1
}
```

### Method Mapping

All A2A core operations are mapped to JSON-RPC 2.0 method names, identical to
the A2A JSON-RPC binding. Per the A2A v1.0 specification, JSON-RPC method
names use PascalCase, matching the gRPC method names [1]:

| A2A Operation | JSON-RPC Method |
|---------------|----------------|
| Send Message | `SendMessage` |
| Send Streaming Message | `SendStreamingMessage` |
| Get Task | `GetTask` |
| List Tasks | `ListTasks` |
| Cancel Task | `CancelTask` |
| Subscribe to Task | `SubscribeToTask` |
| Create Push Notification Config | `CreateTaskPushNotificationConfig` |
| Get Push Notification Config | `GetTaskPushNotificationConfig` |
| List Push Notification Configs | `ListTaskPushNotificationConfigs` |
| Delete Push Notification Config | `DeleteTaskPushNotificationConfig` |
| Get Extended Agent Card | `GetExtendedAgentCard` |

> **Note:** A2A v0.3.0 used category/action method names (e.g.,
> `message/send`, `tasks/get`). A2A v1.0 renamed these to PascalCase to
> align with gRPC method names [1]. This binding targets A2A v1.0.

### Streaming

AAFP's QUIC transport provides native bidirectional streams, making streaming
natural and efficient:

- **Stream mechanism**: The `SendStreamingMessage` and `SubscribeToTask` operations
  use the same bidirectional QUIC stream as other operations. The server sends
  `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` as sequential JSON-RPC
  responses (with the same request ID) on the stream.

- **Ordering**: QUIC guarantees in-order delivery within a stream. Events are
  delivered in the order the server generates them.

- **Reconnection**: If the QUIC connection is lost, the client must re-establish
  the AAFP connection and re-send any in-flight requests. AAFP's replay cache
  prevents nonce reuse across connections.

- **Stream completion**: The server signals completion by sending a final
  response with `final: true` in the event metadata, then closing the stream
  via an AAFP CLOSE frame.

### Error Mapping

A2A errors are mapped to JSON-RPC 2.0 error responses per the A2A v1.0
specification [1]:

| A2A Error Type | JSON-RPC Code | Meaning |
|----------------|--------------|---------|
| `TaskNotFoundError` | -32001 | Task not found |
| `TaskNotCancelableError` | -32002 | Task cannot be canceled |
| `PushNotificationNotSupportedError` | -32003 | Push notifications not supported |
| `UnsupportedOperationError` | -32004 | Operation not supported |
| `ContentTypeNotSupportedError` | -32005 | Content type not supported |
| `InvalidAgentResponseError` | -32006 | Invalid agent response |
| `ExtendedAgentCardNotConfiguredError` | -32007 | Extended agent card not configured |
| `ExtensionSupportRequiredError` | -32008 | Extension support required |
| `VersionNotSupportedError` | -32009 | Protocol version not supported |
| `ParseError` | -32700 | JSON parse error |
| `InvalidRequest` | -32600 | Invalid JSON-RPC request |
| `MethodNotFound` | -32601 | Method not found |
| `InvalidParams` | -32602 | Invalid method parameters |
| `InternalError` | -32603 | Internal server error |

### Authentication and Authorization

The AAFP binding replaces HTTP-based authentication with AAFP's built-in
identity verification:

1. **Server identity**: Verified during the AAFP v1 handshake via ML-DSA-65
   signature on the ServerHello. No X.509 certificate validation needed.

2. **Client identity**: Verified during the AAFP v1 handshake via ML-DSA-65
   signature on the ClientFinished message.

3. **Authorization**: The server's `AuthorizationProvider` receives the
   client's `AgentId` and public key, and can apply any policy (UCAN
   capability checks, allowlists, etc.).

4. **In-task authorization**: A2A's `SecurityScheme` objects in the Agent Card
  are not used for the AAFP binding. Instead, authorization is enforced at the
  AAFP layer. The Agent Card should declare `mutualTls` as the security scheme
  to indicate that mutual authentication is required.

### Framing

Each JSON-RPC message is encoded as exactly one AAFP DATA frame:

```
[AAFP Frame Header (28 bytes)] [JSON-RPC message payload]
```

The frame header includes:
- Version: 1
- Frame type: DATA (0x01)
- Flags: 0
- Stream ID: The QUIC stream ID
- Extensions: Empty (reserved for future use)
- Payload length: Length of the JSON-RPC message

### Comparison with MCP-over-AAFP

The AAFP transport binding for A2A is structurally similar to the MCP-over-AAFP
binding (RFC 0007), with key differences:

| Aspect | MCP-over-AAFP | A2A-over-AAFP |
|--------|---------------|---------------|
| Protocol | MCP (JSON-RPC 2.0) | A2A (JSON-RPC 2.0) |
| Methods | `tools/list`, `tools/call`, etc. | `SendMessage`, `GetTask`, etc. |
| Streaming | Not in MCP spec | Native via bidirectional streams |
| Identity | AAFP agent identity | AAFP agent identity |
| Framing | AAFP DATA frames | AAFP DATA frames |
| Transport | AAFP QUIC + PQ TLS | AAFP QUIC + PQ TLS |

Both bindings share the same `AafpMcpTransport` infrastructure (QUIC connection,
handshake, framing). An A2A transport implementation can reuse the same
transport code with different JSON-RPC method dispatch.

### Implementation Plan

1. **`aafp-transport-a2a` crate**: New crate modeled after `aafp-transport-mcp`.
   Reuses the AAFP QUIC transport and handshake but defines A2A-specific
   JSON-RPC types.

2. **A2A data model**: Rust types for `Task`, `Message`, `Part`, `Artifact`,
   `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, etc. Generated from
   the A2A protobuf schema or hand-written with serde.

3. **A2A server trait**: `A2aServerHandler` trait (similar to MCP's
   `ServerHandler`) that agents implement to handle A2A operations.

4. **A2A client**: High-level client API for sending messages, managing tasks,
   and subscribing to streaming updates.

5. **Conformance tests**: Verify that the AAFP binding produces semantically
   equivalent results to the standard JSON-RPC binding.

6. **Example**: A complete agent-to-agent example showing task creation,
   streaming updates, and cancellation over AAFP.

## Security Considerations

- **Post-quantum security**: The binding uses X25519MLKEM768 hybrid KEX,
  providing protection against future quantum attacks.
- **Identity binding**: Agent identity is cryptographically bound to the TLS
  session via the transcript hash, preventing man-in-the-middle attacks.
- **Replay protection**: AAFP's replay cache prevents nonce reuse across
  connections.
- **No PKI dependency**: Agent identity is based on ML-DSA-65 keys, not X.509
  certificates, enabling decentralized deployment.

## Compatibility Guarantees

### Supported A2A Protocol Versions

This binding targets A2A Protocol version 1.0. The A2A specification is
organized in three layers (Canonical Data Model, Abstract Operations,
Protocol Bindings). This binding implements Layer 3 (Protocol Binding)
for AAFP.

The binding preserves A2A's JSON serialization (camelCase fields, ISO 8601
timestamps, base64 binary) byte-for-byte within AAFP DATA frames.

### Supported AAFP Protocol Versions

This binding requires AAFP protocol version 1 (AAFP_VERSION = 1) as defined
in RFC-0002. The AAFP v1 handshake is mandatory.

### Wire Format Compatibility

The binding is **not wire-compatible** with the standard A2A JSON-RPC, gRPC,
or HTTP+JSON/REST bindings. Those bindings operate over HTTP(S); this
binding operates over QUIC with AAFP framing.

However, the binding is **protocol-compatible** at the JSON-RPC level. The
same A2A operations (SendMessage, GetTask, etc.) are exchanged with
identical JSON-RPC method names and parameter structures.

### Compatibility with Standard A2A Bindings

An A2A client using the JSON-RPC binding cannot connect to an A2A server
using the AAFP binding, and vice versa. The Agent Card's
`supportedInterfaces` list declares which bindings an agent supports.
Clients select a binding from this list.

## Negotiation Behavior

### Transport Selection

A2A does not define dynamic transport negotiation. Clients select a
transport from the Agent Card's `supportedInterfaces` list. The AAFP
binding is declared as:

```json
{
  "url": "quic://agent.example.com:443",
  "protocolBinding": "https://a2a-protocol.org/bindings/aafp",
  "protocolVersion": "1.0"
}
```

Clients that support the AAFP binding connect using AAFP; clients that do
not fall back to other declared bindings.

### AAFP Handshake Negotiation

Same as RFC-0007 (MCP binding): AAFP v1 handshake negotiates protocol
version, ALPN, TLS cipher suite, and features. No fallback.

### A2A Version Negotiation

A2A version negotiation is handled by the A2A protocol layer (via the
`protocolVersion` field in requests). The transport is not involved.

## Failure Behavior

### Connection Failures

Same as RFC-0007: QUIC/TLS/handshake/authorization failures result in
connection termination with appropriate error codes.

### Runtime Failures

| Failure | Behavior |
|---------|----------|
| Peer closes stream | Streaming operations terminate; client receives final event or connection close |
| Peer resets stream | Streaming operations terminate with error |
| Frame parse error | Connection terminated with AAFP ERROR frame |
| JSON parse error | Request-level JSON-RPC error response (A2A error mapping) |
| Task not found | JSON-RPC error -32001 (TaskNotFoundError) |
| Operation not supported | JSON-RPC error -32004 (UnsupportedOperationError) |

### Error Recovery

For non-streaming operations: the client can retry the request on a new
connection.

For streaming operations: if the connection is lost mid-stream, the client
must re-establish the connection and re-subscribe. A2A's `GetTask` can
be used to retrieve the current task state after reconnection.

## Extension Policy

### AAFP Frame Extensions

Same as RFC-0007: no frame extensions used. Future versions MAY use
extensions for message metadata.

### A2A Extensions

A2A supports protocol extensions via the `extensions` field in the Agent
Card. This binding does not define any A2A extensions. A2A extensions are
handled by the A2A protocol layer.

### AAFP Handshake Extensions

Same as RFC-0007: no handshake extensions declared. Future versions MAY
declare an extension to negotiate A2A-specific parameters.

## Forward Compatibility

### AAFP Protocol Evolution

Same as RFC-0007: forward-compatible as long as the frame header format
and DATA frame semantics remain stable.

### A2A Protocol Evolution

This binding is forward-compatible with future A2A protocol versions as
long as:
- A2A continues to use JSON-RPC 2.0 as the wire format
- The `supportedInterfaces` mechanism for declaring custom bindings remains

If A2A adds a binary encoding (e.g., protobuf), the binding can carry it
in DATA frames without changes to the AAFP layer.

## Implementation Requirements

> **Scope:** The requirements in this section apply to implementations of
> the A2A-over-AAFP transport binding. They do not impose new requirements
> on AAFP Core, which is defined by RFC-0002 and related core RFCs.
> Where a requirement references an AAFP Core behavior (e.g., handshake,
> session states, stream IDs), the requirement is that the binding must
> correctly use the existing AAFP Core mechanism, not that AAFP Core must
> change to accommodate the binding.

### Mandatory

1. **AAFP v1 handshake**: Same as RFC-0007.

2. **ML-DSA-65 identity verification**: Same as RFC-0007.

3. **Session state enforcement**: Same as RFC-0007.

4. **DATA frame usage**: Same as RFC-0007 — AAFP DATA frames for all A2A
   JSON-RPC messages.

5. **JSON preservation**: The implementation MUST preserve A2A JSON-RPC
   messages byte-for-byte, including camelCase field names and ISO 8601
   timestamps.

6. **Stream ID compliance**: Same as RFC-0007 — stream IDs ≥ 4.

7. **All core operations**: The binding MUST expose every A2A core operation
   (send message, get task, cancel task, streaming, push notifications,
   etc.) per the A2A custom binding requirements [2].

8. **Error mapping**: The binding MUST map all A2A error types to JSON-RPC
   error codes per the error mapping table above.

9. **Agent Card declaration**: Agents supporting this binding MUST declare
   it in `supportedInterfaces` with the correct `protocolBinding` URI.

### Recommended

1. **Single stream per connection**: Same as RFC-0007.

2. **Streaming via bidirectional streams**: The implementation SHOULD use
   QUIC's bidirectional streams for streaming operations
   (`SendStreamingMessage`, `SubscribeToTask`).

3. **Push notification support**: The implementation SHOULD support A2A's
   push notification mechanism, using a separate QUIC stream or a callback
   connection.

### Prohibited

1. **No HTTP fallback**: Same as RFC-0007.

2. **No message modification**: Same as RFC-0007.

3. **No A2A SecurityScheme bypass**: The binding MUST NOT bypass A2A's
   security model. AAFP's ML-DSA-65 identity verification replaces HTTP-based
   authentication, but A2A's in-task authorization (if declared) MUST still
   be enforced by the A2A protocol layer.

## References

- [1] A2A Protocol Specification, v1.0.0: https://a2a-protocol.org/v1.0.0/specification/
- [2] A2A Custom Protocol Bindings: https://github.com/a2aproject/A2A/blob/main/docs/topics/custom-protocol-bindings.md
- [3] AAFP Protocol, RFC 0002: Transport Framing
- [4] AAFP MCP Transport, RFC 0007: MCP Transport Binding
- [5] JSON-RPC 2.0 Specification: https://www.jsonrpc.org/specification
