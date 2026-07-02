# AAFP Examples

Working examples for the AAFP ecosystem. Each example is self-contained and
can be run directly with `cargo run`.

## Rust SDK Examples

Located in `implementations/rust/crates/aafp-sdk/examples/`:

### `basic_agent.rs`
Creates two AAFP agents (server + client), performs the full v1 handshake,
and exchanges a message over a QUIC stream.

```bash
cd implementations/rust
cargo run --example basic_agent -p aafp-sdk
```

## MCP Transport Examples

Located in `implementations/rust/crates/aafp-transport-mcp/examples/`:

### `mcp_over_aafp.rs`
A complete MCP client-server example over AAFP. The server hosts an "echo"
tool using the rmcp `ServerHandler` trait. The client connects, lists tools,
and calls the echo tool — all over AAFP's post-quantum secure channel.

```bash
cd implementations/rust
cargo run --example mcp_over_aafp -p aafp-transport-mcp
```

**What it demonstrates:**
- QUIC transport with post-quantum TLS (X25519MLKEM768)
- ML-DSA-65 identity verification during AAFP handshake
- MCP `initialize` / `tools/list` / `tools/call` over AAFP DATA frames
- Full rmcp `ServerHandler` + `ServiceExt` integration

### `simple_transport.rs`
A low-level example showing raw JSON-RPC message exchange over the AAFP
transport, without the rmcp service layer. The client sends a `ping` request
and the server responds with an empty result.

```bash
cd implementations/rust
cargo run --example simple_transport -p aafp-transport-mcp
```

**What it demonstrates:**
- Direct `Transport<R>` trait usage (`send`, `receive`, `close`)
- AAFP DATA frame framing of JSON-RPC messages
- Bidirectional communication on a single QUIC stream

## Planned Examples

- Agent identity generation and verification
- Discovery: announce and lookup by capability
- Relay: relayed connections for NAT traversal
- Streaming: multiple concurrent streams
- Reconnect: automatic reconnection after connection loss
- Concurrent streams: multiplexed messages
