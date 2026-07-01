# Deliverable 2: Protocol Comparison Matrix

```
Deliverable:    2 of 12
Title:          Protocol Comparison Matrix
Status:         Complete
Date:           2026-07-01
Source:         Phase 2 (Standards Survey) + Phase 3 (Protocol Layer Analysis)
```

## Full Comparison Matrix

| Dimension | AAFP | MCP | A2A | ANP | SLIM | AgentMesh |
|-----------|------|-----|-----|-----|------|-----------|
| **Transport** | QUIC | stdio/HTTP | HTTP/gRPC | HTTP/P2P | gRPC/WS | WS/HTTP |
| **Encoding** | CBOR | JSON | ProtoJSON | JSON-LD | Protobuf | JSON |
| **Binary wire** | Yes | No | No | No | Yes | No |
| **Identity** | SHA-256(PQ pubkey) | OAuth client ID | Agent Card | DID (did:wba) | Hierarchical name | DID + sponsor |
| **Self-sovereign** | Yes | No | Partial | Yes | No | Yes (registry-validated) |
| **PQ signatures** | ML-DSA-65 | No | No | No | No | No (planned) |
| **PQ KEX** | X25519MLKEM768 | No | No | No | No | No |
| **PQ by default** | Yes | No | No | No | No | No |
| **E2EE** | Yes | No | No | Yes | Yes (MLS) | Yes (Signal) |
| **Forward secrecy** | Yes (TLS) | TLS | TLS | Unknown | Yes (MLS) | Yes (ratchet) |
| **Post-compromise sec** | No | No | No | Unknown | Yes (MLS) | Yes (ratchet) |
| **Replay protection** | ReplayCache | None | None | Unknown | MLS | Single-use keys |
| **Delegation** | UCAN chains | OAuth scopes | Skill-based | Meta-proto | JWT claims | IATP + trust |
| **Discovery** | Capability DHT | Server URL | Well-known URI | DID resolution | Anycast/unicast | Registry API |
| **Session model** | 8-state + 5-state CLOSE | Stateful→Stateless | 8-state task | Meta-proto | P2P + Group | Circuit breaker |
| **Streaming** | QUIC streams | SSE | SSE | Unknown | gRPC stream | WebSocket |
| **Multiplexing** | QUIC native | None | HTTP/2 (gRPC) | Unknown | HTTP/2 (gRPC) | None |
| **0-RTT** | Yes (QUIC) | No | No | No | No | No |
| **Connection migration** | Yes (QUIC) | No | No | No | No | No |
| **NAT traversal** | AutoNAT/DCuTR (planned) | None | None | Unknown | None | Relay (72h TTL) |
| **Group messaging** | No | No | No | Unknown | Yes (MLS) | Planned (v2) |
| **Human sponsor** | No | No | No | No | No | Yes (mandatory) |
| **Policy engine** | No | No | No | No | No | OPA/Cedar |
| **Trust scoring** | No | No | No | No | No | 0-1000 scale |
| **Audit logging** | No | No | No | No | No | Merkle chain |
| **Extension model** | Frame extensions | SEP-2133 | URI governance | Meta-proto | MLS extensions | Adapter contract |
| **Standards body** | None | Linux Foundation | Linux Foundation | W3C | IETF (draft) | Microsoft |
| **License** | (TBD) | Other | Apache 2.0 | MIT | Apache 2.0 | MIT |
| **Maturity** | RC-1 | Production | v1.0.1 Production | Research | v1.4.0 | Public Preview |
| **SDKs** | Rust, Go | 6 languages | Multiple | — | 7 languages | Python, TS |
| **Production deployments** | None | Millions/day | Azure, Bedrock, Google | None | Early | Early |

## Standards Alignment

| Standard | AAFP | MCP | A2A | ANP | SLIM | AgentMesh |
|----------|------|-----|-----|-----|------|-----------|
| RFC 8949 (CBOR) | Yes | - | - | - | - | - |
| RFC 9000 (QUIC) | Yes | - | - | - | - | - |
| RFC 9420 (MLS) | - | - | - | - | Yes | - |
| RFC 8032 (Ed25519) | - | - | - | - | - | Yes |
| FIPS 204 (ML-DSA) | Yes | - | - | - | - | - |
| FIPS 203 (ML-KEM) | Yes | - | - | - | - | - |
| RFC 7515 (JWS) | - | - | Yes | - | - | - |
| RFC 8785 (JCS) | - | - | Yes | - | - | - |
| W3C DID | - | - | - | Yes | - | Yes |
| OAuth 2.1 | - | Yes | Yes | - | - | - |
| JSON-RPC 2.0 | - | Yes | Yes | - | - | - |
