# RFC 0007: AAFP Transport Binding for MCP

## Status

Implemented

## Summary

This RFC defines a transport binding for the Model Context Protocol (MCP) over
the Agent Agent Federation Protocol (AAFP). MCP is a JSON-RPC 2.0 protocol for
agent-to-tool communication. This binding allows MCP clients and servers to
communicate over AAFP's post-quantum secure QUIC transport, replacing the
default stdio and HTTP+SSE transports with a cryptographically authenticated,
post-quantum secure channel.

## Motivation

MCP [1] defines several transport mechanisms (stdio, HTTP+SSE, Streamable
HTTP) that are suitable for local and cloud deployments. However, these
transports have limitations for distributed agent-to-tool communication:

1. **No identity verification**: stdio relies on process isolation; HTTP
   relies on TLS PKI. Neither provides cryptographic agent identity.

2. **No post-quantum security**: HTTP+TLS does not mandate post-quantum key
   exchange.

3. **No P2P connectivity**: stdio requires co-location; HTTP requires a
   publicly addressable endpoint.

AAFP addresses these by providing:
- **ML-DSA-65 agent identity**: Verified during the AAFP handshake
- **Post-quantum TLS**: X25519MLKEM768 hybrid key exchange
- **P2P transport**: QUIC with NAT traversal support (future)

## Design

### Transport Architecture

```
┌──────────────────────────────────────────┐
│         MCP Application Layer            │
│   (tools, resources, prompts)            │
├──────────────────────────────────────────┤
│         rmcp Service Layer               │
│   (ServerHandler, ServiceExt)            │
├──────────────────────────────────────────┤
│         AafpMcpTransport                 │
│   (Transport<R> trait impl)              │
├──────────────────────────────────────────┤
│         AAFP Framing Layer               │
│   (DATA frames, 28-byte header)          │
├──────────────────────────────────────────┤
│         AAFP v1 Handshake                │
│   (ML-DSA-65 identity, PQ KEX)           │
├──────────────────────────────────────────┤
│         QUIC Transport                   │
│   (quinn + rustls, X25519MLKEM768)       │
└──────────────────────────────────────────┘
```

### Connection Establishment

1. **QUIC connection**: The client dials the server's QUIC endpoint. TLS
   negotiates X25519MLKEM768 and the `aafp/1` ALPN.

2. **AAFP v1 handshake**: ClientHello / ServerHello / ClientFinished on QUIC
   stream 0. Both parties verify ML-DSA-65 identities.

3. **Authorization**: The server's `AuthorizationProvider` decides whether to
   accept the client.

4. **MCP stream**: The client opens a bidirectional QUIC stream. All MCP
   JSON-RPC messages are exchanged on this stream as AAFP DATA frames.

### Message Framing

Each MCP JSON-RPC message is serialized as JSON and encoded as exactly one
AAFP DATA frame:

```
[AAFP Frame Header (28 bytes)] [JSON-RPC message (UTF-8 JSON)]
```

The frame header includes:
- Version: 1
- Frame type: DATA (0x01)
- Stream ID: The QUIC stream ID
- Payload length: Length of the JSON-RPC message

### Transport Trait Implementation

`AafpMcpTransport` implements the rmcp `Transport<R>` trait for both
`RoleClient` and `RoleServer`:

- **`send(message)`**: Serialize the JSON-RPC message to JSON, encode as an
  AAFP DATA frame, write to the QUIC send stream.

- **`receive()`**: Read an AAFP frame from the QUIC receive stream, decode the
  JSON payload, deserialize as a JSON-RPC message. Returns `None` when the
  peer closes the stream.

- **`close()`**: Send an AAFP CLOSE frame, close the QUIC stream, and close
  the QUIC connection.

### Address Scheme

MCP-over-AAFP uses the `quic://` address scheme:

```
quic://<host>:<port>
```

The host and port identify the AAFP agent's QUIC listening endpoint.

### API

The crate provides two constructors:

- `AafpMcpTransport::connect(agent, addr)`: Client-side. Dials the server,
  performs the AAFP handshake, opens a bidirectional stream.

- `AafpMcpTransport::accept(agent)`: Server-side. Accepts a QUIC connection,
  performs the AAFP handshake, accepts the bidirectional stream.

Both use `TestingAuthProvider` (allows all). For production, use
`connect_with_auth` / `accept_with_auth` with a custom `AuthorizationProvider`.

### Integration with rmcp

The transport integrates with the rmcp SDK via the `Transport<R>` trait:

```rust
// Server side
let transport = AafpMcpTransport::accept(&agent).await?;
let running = MyServer.serve(transport).await?;
running.waiting().await;

// Client side
let transport = AafpMcpTransport::connect(&agent, &addr).await?;
let client = ().serve(transport).await?;
let tools = client.list_all_tools().await?;
```

## Implementation

The `aafp-transport-mcp` crate implements this binding:

- **Crate**: `aafp-transport-mcp` (in `implementations/rust/crates/`)
- **Dependencies**: `aafp-sdk`, `aafp-messaging`, `aafp-transport-quic`, `rmcp`
- **Tests**: 16 tests (2 unit, 4 integration, 8 conformance, 2 doc)
- **Examples**: `mcp_over_aafp.rs` (full client-server), `simple_transport.rs`
  (raw JSON-RPC)
- **Benchmarks**: `mcp_transport.rs` (round-trip latency, one-way throughput)

### Benchmark Results (baseline, no optimization)

| Benchmark | Time | Throughput |
|-----------|------|------------|
| Round-trip ping | 256 µs | 3,900 msg/s |
| One-way 10 msgs | 136 µs/batch | 73K msg/s |
| One-way 100 msgs | 665 µs/batch | 150K msg/s |
| One-way 1000 msgs | 6.24 ms/batch | 160K msg/s |

## Security Considerations

- **Identity binding**: The MCP client and server verify each other's
  ML-DSA-65 identities during the AAFP handshake. The TLS channel binding
  is mixed into the transcript hash, preventing MITM attacks.
- **Post-quantum security**: X25519MLKEM768 hybrid KEX provides protection
  against future quantum attacks.
- **No PKI dependency**: Agent identity is based on ML-DSA-65 keys, not X.509
  certificates.
- **Replay protection**: AAFP's replay cache prevents nonce reuse.

## Compatibility Guarantees

### Supported MCP Protocol Versions

This binding supports MCP protocol versions supported by the rmcp SDK
(version 1.7+). At the time of writing, this includes:

- **2025-11-25** (current stable)
- **2025-06-18** (legacy, supported by rmcp)

The binding does not participate in MCP protocol version negotiation. The
`initialize` request (which carries the protocol version) is handled by
the rmcp service layer. The transport carries whatever JSON-RPC messages
the service layer produces.

When the 2026-07-28 MCP version ships (stateless protocol, no initialize
handshake), the binding will support it as long as rmcp's `Transport<R>`
trait contract remains stable.

### Supported AAFP Protocol Versions

This binding requires AAFP protocol version 1 (AAFP_VERSION = 1) as defined
in RFC-0002. The AAFP v1 handshake is mandatory — no fallback to v0.

### Wire Format Compatibility

The binding preserves MCP JSON-RPC messages byte-for-byte. The AAFP frame
header (28 bytes) is prepended to each message, but the JSON payload is not
modified, transcoded, or reordered. A receiver that strips the AAFP frame
header obtains the exact JSON-RPC message that was sent.

### Compatibility with Standard MCP Transports

This binding is **not wire-compatible** with stdio or HTTP+SSE transports.
An MCP client using stdio cannot connect to an MCP server using AAFP, and
vice versa. The transports use different framing and connection mechanisms.

However, the binding is **protocol-compatible** at the JSON-RPC level. The
same MCP messages (initialize, tools/list, tools/call, etc.) are exchanged
regardless of transport. An MCP application built on rmcp can switch from
stdio to AAFP by changing only the transport constructor.

## Negotiation Behavior

### Transport Selection

MCP does not define a dynamic transport negotiation protocol. Clients
select a transport based on static information (e.g., Agent Card for A2A,
configuration for MCP). This binding does not add transport negotiation.

### AAFP Handshake Negotiation

The AAFP v1 handshake negotiates:
- **Protocol version**: Both parties must agree on AAFP version 1.
- **ALPN**: Both parties must agree on `aafp/1` ALPN.
- **TLS cipher suite**: Negotiated by rustls (X25519MLKEM768 required).
- **Features**: Negotiated via handshake extensions (currently none).

If any negotiation step fails, the connection is terminated with a TLS
error or AAFP ERROR frame. No fallback to a different transport is provided.

### MCP Capability Negotiation

MCP capability negotiation (announcing tools, resources, prompts) is
handled by the rmcp service layer during the `initialize` exchange. The
transport is not involved.

## Failure Behavior

### Connection Failures

| Failure | Behavior |
|---------|----------|
| QUIC connection refused | `connect()` returns `AafpMcpError::Sdk` |
| TLS handshake failure | `connect()` returns `AafpMcpError::Sdk` |
| ALPN mismatch | TLS handshake fails (no fallback) |
| AAFP handshake failure | `connect()` returns `AafpMcpError::Sdk` |
| Authorization denied | `connect()` returns `AafpMcpError::Session` |
| Stream open failure | `connect()` returns `AafpMcpError::Io` |

### Runtime Failures

| Failure | Behavior |
|---------|----------|
| Peer closes stream | `receive()` returns `None` |
| Peer resets stream | `receive()` returns `None` |
| Peer closes connection | `receive()` returns `None` |
| Frame parse error | `receive()` logs error, returns `None` |
| JSON parse error | `receive()` logs warning, skips frame, continues |
| Send after close | `send()` returns `AafpMcpError::Closed` |

### Error Recovery

The transport does not implement automatic reconnection. If the connection
is lost, the application must create a new `AafpMcpTransport` via
`connect()` or `accept()`. The AAFP replay cache prevents nonce reuse
across reconnections.

## Extension Policy

### AAFP Frame Extensions

AAFP frames support an extension section (RFC-0002 §3.1). This binding
does not use frame extensions. Future versions MAY use extensions for:

- Message metadata (tracing IDs, authentication hints)
- Compression indicators
- Priority flags

Extensions are skipped by receivers that do not understand them (per
RFC-0002 §3.1: "Unknown extensions MUST be ignored by receivers").

### AAFP Handshake Extensions

The AAFP v1 handshake supports feature negotiation via extensions. This
binding does not declare any handshake extensions. Future versions MAY
declare an extension to negotiate:

- Application protocol identification (MCP version)
- Stream multiplexing policy
- Maximum message size

### MCP Extensions

MCP supports protocol extensions via the `capabilities` field in the
`initialize` exchange. This binding does not define any MCP extensions.
MCP extensions are handled entirely by the rmcp service layer.

## Forward Compatibility

### AAFP Protocol Evolution

This binding is forward-compatible with future AAFP protocol versions
as long as:
- The frame header format (28 bytes) remains stable
- The DATA frame type (0x01) remains semantically "opaque application payload"
- The handshake driver API remains stable

If AAFP adds a v2 handshake, the binding can support it by updating the
handshake driver call without changing the transport logic.

### MCP Protocol Evolution

This binding is forward-compatible with future MCP protocol versions
as long as:
- MCP continues to use JSON-RPC 2.0 as the wire format
- The rmcp `Transport<R>` trait contract remains stable

If MCP adds a binary encoding (e.g., protobuf), the binding can carry it
in DATA frames without changes to the AAFP layer.

### rmcp SDK Evolution

This binding depends on the rmcp `Transport<R>` trait. If rmcp changes
the trait signature (e.g., adds new methods), the binding must be updated.
The `Transport<R>` trait has been stable since rmcp 1.0.

## Implementation Requirements

### Mandatory

1. **AAFP v1 handshake**: The implementation MUST perform the full AAFP
   v1 handshake (ClientHello/ServerHello/ClientFinished) before exchanging
   MCP messages. No unauthenticated connections are allowed.

2. **ML-DSA-65 identity verification**: The implementation MUST verify the
   peer's ML-DSA-65 signature during the handshake. The peer's AgentId
   MUST be derived from the verified public key.

3. **Session state enforcement**: The implementation MUST transition the
   Session to `MessagingEnabled` state before opening application streams.

4. **DATA frame usage**: The implementation MUST use AAFP DATA frames
   (frame type 0x01) for MCP messages. It MUST NOT use RPC_REQUEST or
   RPC_RESPONSE frames.

5. **JSON preservation**: The implementation MUST preserve MCP JSON-RPC
   messages byte-for-byte. It MUST NOT transcode to CBOR or modify the
   JSON content.

6. **Stream ID compliance**: The implementation MUST use stream IDs ≥ 4
   for application data, per RFC-0002 §7.1. Stream 0 is reserved for the
   handshake. Streams 1-2 are reserved for future protocol use.

7. **Authorization**: The implementation MUST call the `AuthorizationProvider`
   before transitioning to `MessagingEnabled`. The default
   `TestingAuthProvider` allows all connections — production deployments
   MUST use a custom provider.

### Recommended

1. **Single long-lived stream**: The implementation SHOULD use a single
   bidirectional QUIC stream for all MCP messages on a connection, rather
   than opening a new stream per message. This reduces per-message latency.

2. **Graceful close**: The implementation SHOULD send an AAFP CLOSE frame
   before closing the QUIC connection, allowing the peer to drain in-flight
   messages.

3. **Error logging**: The implementation SHOULD log frame parse errors and
   JSON parse errors at `warn` or `debug` level, not `error` level, to
   avoid log spam during normal operation.

### Prohibited

1. **No X.509 certificates**: The implementation MUST NOT require X.509
   certificates for agent identity. Agent identity is based on ML-DSA-65
   keys, not PKI.

2. **No HTTP fallback**: The implementation MUST NOT fall back to HTTP if
   the AAFP handshake fails. AAFP is the only transport for this binding.

3. **No message modification**: The implementation MUST NOT modify, reorder,
   or coalesce MCP JSON-RPC messages. Each message MUST be carried as
   exactly one AAFP DATA frame.

## References

- [1] Model Context Protocol: https://modelcontextprotocol.io
- [2] rmcp (Rust MCP SDK): https://crates.io/crates/rmcp
- [3] AAFP Protocol, RFC 0002: Transport Framing
- [4] MCP Specification, Transports: https://modelcontextprotocol.io/specification/draft/basic/transports
- [5] MCP Specification, Versioning: https://modelcontextprotocol.io/specification/draft/basic/versioning
- [6] JSON-RPC 2.0 Specification: https://www.jsonrpc.org/specification
