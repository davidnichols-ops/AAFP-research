# Phase 2: Standards Survey

```
Phase:          2 of 16
Title:          Standards Survey
Status:         In Progress
Date:           2026-07-01
Researchers:    Devin (autonomous)
Dimensions:     Transport, Identity, Delegation, Cryptography, Serialization
```

## 1. Objective

Systematically compare AAFP and all studied ecosystem protocols across
five foundational dimensions. Produce comparison matrices that will feed
Phases 3-16.

## 2. Dimension 1: Transport

| Protocol | Primary Transport | Streaming | Multiplexing | NAT Traversal | QUIC? |
|----------|------------------|-----------|--------------|---------------|-------|
| **AAFP** | **QUIC (quinn + rustls)** | **QUIC streams** | **QUIC native** | **AutoNAT, DCuTR, relay (planned)** | **Yes (native)** |
| MCP | stdio, HTTP/1.1 (Streamable HTTP) | SSE (request-scoped) | None (HTTP/1.1) | None | No |
| A2A | HTTP/1.1 (JSON-RPC), HTTP/2 (gRPC) | SSE | HTTP/2 (gRPC only) | None | No |
| ACP | HTTP/1.1 (REST) | Polling | None | None | No |
| ANP | HTTP, P2P | Not specified | Not specified | Not specified | No |
| SLIM | gRPC over HTTP/2, WebSocket | gRPC streaming | HTTP/2 (gRPC) | None (relies on infra) | No (HTTP/3 in IETF draft, not implemented) |
| AgentMesh | WebSocket, HTTP/REST, gRPC | WebSocket | None (WS is single-stream) | Relay (store-and-forward, 72h TTL) | No |

### 2.1 Key Observations

- **AAFP is the only QUIC-native protocol.** Every other protocol relies
  on HTTP/1.1 or HTTP/2. SLIM's IETF draft mentions HTTP/3 but the
  codebase has no QUIC implementation.
- **Streaming approaches diverge widely**: SSE (MCP, A2A), gRPC streaming
  (SLIM), WebSocket (AgentMesh), QUIC streams (AAFP). QUIC streams offer
  the cleanest multiplexing model - independent, ordered, backpressured
  streams within a single connection.
- **NAT traversal is underserved.** Only AAFP (AutoNAT, DCuTR, relay) and
  AgentMesh (relay with store-and-forward) address NAT traversal at all.
  All HTTP-based protocols assume reachable endpoints or reverse proxies.
- **0-RTT resumption** (a QUIC feature) is unavailable to any HTTP-based
  protocol. This is a latency advantage for AAFP in reconnection scenarios.

### 2.2 Transport Maturity

| Feature | AAFP | MCP | A2A | SLIM | AgentMesh |
|---------|------|-----|-----|------|-----------|
| Connection migration | Yes (QUIC) | No | No | No | No |
| 0-RTT resumption | Yes (QUIC) | No | No | No | No |
| Head-of-line blocking avoidance | Yes (QUIC streams) | No | Only gRPC | Only gRPC | No |
| Built-in flow control | Yes (QUIC) | No | No | No (gRPC-level) | No |
| Congestion control | Yes (QUIC) | TCP | TCP | TCP | TCP |

## 3. Dimension 2: Identity

| Protocol | Identity Format | Decentralized? | Key Type | Human Sponsor? | Key Rotation |
|----------|----------------|----------------|----------|----------------|--------------|
| **AAFP** | **AgentId (from ML-DSA-65 public key)** | **Yes (self-sovereign)** | **ML-DSA-65 (FIPS 204)** | **No** | **Via AgentRecord update** |
| MCP | None (OAuth client ID) | No | OAuth keys | No | OAuth flow |
| A2A | Agent Card (JSON metadata) | Partial (well-known URI) | JWS (ES256, RS256) | No (provider field optional) | Multi-sig support |
| ACP | Role-based + DIDs | Partial | Not specified | No | Not specified |
| ANP | W3C DID (`did:wba`) | Yes | Public key in DID document | No | DID document update |
| SLIM | Hierarchical name (`org/ns/service/client`) | No (org-assigned) | JWT/SPIFFE | No | JWT rotation |
| AgentMesh | `did:mesh:<hex>` -> `did:agentmesh:<fp>` | Yes | Ed25519 | **Yes (mandatory sponsor_email)** | Cryptographic proofs (old key signs new) |

### 3.1 Key Observations

- **AAFP and ANP are the only fully decentralized identity systems.**
  AAFP derives identity from the agent's own PQ key pair. ANP uses W3C
  DIDs resolvable at well-known URLs. AgentMesh uses DIDs but requires
  registry membership for trust validation.
- **AgentMesh is unique in requiring human sponsorship.** Every agent
  MUST have a `sponsor_email`. This is an enterprise governance decision
  - "AI agents cannot be held legally or organizationally accountable."
  AAFP has no such requirement (by design - agents are autonomous peers).
- **Key rotation** is handled differently: AgentMesh uses cryptographic
  proofs (old key signs rotation proof), AAFP uses AgentRecord updates,
  ANP uses DID document updates, A2A supports multi-signature for
  rotation.
- **No protocol uses post-quantum identity keys** except AAFP (ML-DSA-65).
  AgentMesh plans ML-DSA-65 in its roadmap but currently uses Ed25519.

### 3.2 Identity Resolution

| Protocol | How to discover an agent's identity | Central registry? |
|----------|-------------------------------------|-------------------|
| AAFP | Capability DHT -> AgentRecord (contains public key) | No (DHT) |
| MCP | Server URL (configured) | No (direct) |
| A2A | `/.well-known/agent-card.json` or registry | Optional (curated registries) |
| ANP | DID resolution (HTTPS well-known URL) | No |
| SLIM | Hierarchical name lookup | No (anycast/unicast) |
| AgentMesh | Registry API (`POST /v1/agents`) | **Yes (central registry)** |

## 4. Dimension 3: Delegation & Authorization

| Protocol | Delegation Model | Capability Scoping | Revocation | Trust Propagation |
|----------|-----------------|-------------------|------------|-------------------|
| **AAFP** | **UCAN capability chains** | **String-keyed capabilities** | **Chain invalidation** | **Delegated authority** |
| MCP | OAuth 2.1 scopes | Scope-based | Token expiry | None |
| A2A | Agent-defined | Skill-based (OAuth scopes) | Token expiry | None |
| ACP | Role-based | Roles | Role revocation | None |
| ANP | Meta-protocol negotiation | Protocol-level | Not specified | Not specified |
| SLIM | JWT claims | JWT scopes | Token expiry | None |
| AgentMesh | IATP + capability scoping | `action:resource[:qualifier]` | Deny lists + revocation | Trust score network contagion (2 hops) |

### 4.1 Key Observations

- **AAFP's UCAN capability chains are the most sophisticated delegation
  model.** UCAN (User Controlled Authorization Networks) allows agents to
  delegate subsets of their authority to other agents, with cryptographic
  proof of the delegation chain. No other protocol has equivalent
  capability-chain cryptography.
- **AgentMesh's trust scoring system is the most operationally rich.**
  It combines IATP (Inter-Agent Trust Protocol) with a 0-1000 trust score,
  temporal decay, network contagion, and 5 reward dimensions. This is a
  governance/operational layer that AAFP's cryptographic delegation does
  not address.
- **OAuth scopes (MCP, A2A) are the simplest but least expressive.** They
  encode "what you can do" but not "who delegated to you" or "how much
  authority you have." They also expire (time-bounded) rather than being
  revocable on-demand.
- **No protocol separates identity from authority** as cleanly as AAFP's
  UCAN model. In OAuth-based systems, the token IS both identity and
  authority. In AAFP, the AgentId is identity; the UCAN chain is
  authority. This separation is architecturally significant (see Phase 7).

## 5. Dimension 4: Cryptography

| Protocol | Signatures | Key Exchange | Encryption | PQ-Ready? | E2EE? | Replay Protection |
|----------|-----------|-------------|------------|-----------|-------|-------------------|
| **AAFP** | **ML-DSA-65 (FIPS 204)** | **X25519MLKEM768 (hybrid PQ)** | **AEAD (post-handshake)** | **Yes (by default)** | **Yes** | **ReplayCache (cross-connection nonce)** |
| MCP | None (OAuth JWT) | TLS | TLS | No | No (TLS only) | None |
| A2A | JWS (optional, Agent Card) | TLS | TLS | No | No | None (mentioned for push notifications) |
| ACP | Not specified | TLS | TLS | No | No | Not specified |
| ANP | DID public key | Not specified | Not specified | No | Yes (9 E2EE profiles) | Not specified |
| SLIM | MLS signatures | MLS KEX (P-256, X25519) | MLS AEAD (RFC 9420) | No (feature flag exists, not enabled) | Yes (MLS) | MLS replay protection |
| AgentMesh | Ed25519 | X25519 (X3DH) | ChaCha20-Poly1305 (Double Ratchet) | No (ML-DSA-65 planned) | Yes (Signal Protocol) | Single-use keys + UUID dedup |

### 5.1 Key Observations

- **AAFP is the only protocol with post-quantum cryptography by default.**
  ML-DSA-65 for signatures, X25519MLKEM768 for key exchange. No
  classical-only mode. This protects against harvest-now-decrypt-later
  attacks.
- **SLIM has PQ infrastructure but doesn't use it.** The `mls-rs-crypto-awslc`
  crate has a `post-quantum` feature flag, but SLIM's Cargo.toml doesn't
  enable it. The IETF draft `draft-ietf-mls-pq-ciphersuites-04` exists
  but is not implemented.
- **AgentMesh uses the Signal Protocol** (X3DH + Double Ratchet), which
  provides excellent forward secrecy and post-compromise security - but
  with classical crypto only. Adding PQ would require redesigning the
  X3DH handshake.
- **E2EE is available in AAFP, ANP, SLIM, and AgentMesh** but not in MCP,
  A2A, or ACP (which rely on transport-layer TLS).
- **Replay protection** is strongest in AgentMesh (single-use message keys
  + UUID dedup + 100 skipped-key limit) and AAFP (cross-connection nonce
  cache with LRU eviction). SLIM relies on MLS's built-in replay
  protection. MCP and A2A have none in the core protocol.

### 5.2 Cryptographic Agility

| Protocol | Can add new algorithms? | How? | Backward compatibility |
|----------|------------------------|------|------------------------|
| AAFP | Yes | Version negotiation + extension pipeline | Versioned handshake |
| MCP | No (relies on TLS) | TLS cipher suite negotiation | TLS handles it |
| A2A | Limited | JWS `alg` header | Per-signature |
| SLIM | Yes | MLS cipher suite negotiation | MLS handles it |
| AgentMesh | Limited | Would require protocol revision | Hard (Ed25519 baked in) |

## 6. Dimension 5: Serialization

| Protocol | Format | Schema | Binary? | Compactness | Schema Evolution |
|----------|--------|--------|---------|-------------|-----------------|
| **AAFP** | **CBOR (RFC 8949 deterministic)** | **CDDL schemas** | **Yes** | **High** | **Versioned + extensible** |
| MCP | JSON (UTF-8) | TypeScript schema | No | Low | Date-based versioning |
| A2A | JSON (ProtoJSON) | Protocol Buffers | No | Medium | Proto field numbers |
| ACP | JSON | OpenAPI | No | Low | OpenAPI versioning |
| ANP | JSON-LD | JSON-LD contexts | No | Low | Context versioning |
| SLIM | Protocol Buffers | .proto files | Yes | High | Proto field numbers |
| AgentMesh | JSON | JSON Schema | No | Low | Not specified |

### 6.1 Key Observations

- **AAFP and SLIM are the only protocols using binary serialization.**
  AAFP uses CBOR (deterministic, per RFC 8949); SLIM uses Protocol
  Buffers. All others use JSON variants.
- **CBOR vs Protobuf**: CBOR is self-describing (can be decoded without a
  schema), while Protobuf requires the `.proto` file to decode. CBOR is
  better for debugging and introspection; Protobuf is slightly more
  compact for known schemas. Both are dramatically more efficient than
  JSON.
- **Deterministic CBOR** (AAFP's choice) ensures that the same logical
  value always serializes to the same bytes - critical for cryptographic
  signatures over serialized data. JSON has this problem solved by RFC
  8785 (JSON Canonicalization), which A2A uses for Agent Card signing.
- **Wire efficiency**: For a typical agent message, CBOR is ~30-40%
  smaller than JSON and comparable to Protobuf. Over QUIC (which has its
  own header compression), this compounds with transport efficiency.

## 7. Cross-Dimensional Summary Matrix

| Dimension | AAFP | MCP | A2A | ANP | SLIM | AgentMesh |
|-----------|------|-----|-----|-----|------|-----------|
| Transport | QUIC | stdio/HTTP | HTTP/gRPC | HTTP/P2P | gRPC/WS | WS/HTTP |
| Identity | PQ self-sovereign | OAuth | Agent Card | DID | Hierarchical | DID + sponsor |
| Delegation | UCAN chains | OAuth scopes | Skill-based | Meta-proto | JWT claims | IATP + trust |
| Crypto | PQ-by-default | TLS only | TLS + JWS | DID-based | MLS (classical) | Signal (classical) |
| Serialization | CBOR | JSON | ProtoJSON | JSON-LD | Protobuf | JSON |
| **PQ-Ready** | **Yes** | No | No | No | No (infra exists) | No (planned) |
| **E2EE** | **Yes** | No | No | Yes | Yes | Yes |
| **Binary wire** | **Yes** | No | No | No | Yes | No |

## 8. Standards Alignment

| Standard | AAFP | MCP | A2A | ANP | SLIM | AgentMesh |
|----------|------|-----|-----|-----|------|-----------|
| RFC 8949 (CBOR) | Yes | - | - | - | - | - |
| RFC 9000 (QUIC) | Yes | - | - | - | - | - |
| RFC 9420 (MLS) | - | - | - | - | Yes | - |
| RFC 8032 (Ed25519) | - | - | - | - | - | Yes |
| FIPS 204 (ML-DSA) | Yes | - | - | - | - | - |
| FIPS 203 (ML-KEM) | Yes (hybrid) | - | - | - | - | - |
| RFC 7515 (JWS) | - | - | Yes | - | - | - |
| RFC 8785 (JCS) | - | - | Yes | - | - | - |
| W3C DID | - | - | - | Yes | - | Yes |
| OAuth 2.1 | - | Yes | Yes | - | - | - |
| JSON-RPC 2.0 | - | Yes | Yes | - | - | - |
| RFC 9334 (DPoP) | - | - | - | - | - | Yes (freshness_nonce) |

### 8.1 Key Observation

AAFP aligns with the **post-quantum + QUIC + CBOR** standards family,
which no other protocol uses. This is a coherent and forward-looking
standards choice, but it also means AAFP has **zero overlap** with the
HTTP/JSON/OAuth ecosystem that dominates agent communication today.
Bridging this gap will be a key interoperability challenge (Phase 15).

## 9. Gap Analysis

### 9.1 What AAFP Has That Others Don't

| Capability | AAFP | Closest Competitor | Gap Size |
|------------|------|-------------------|----------|
| Post-quantum by default | Yes | SLIM (infra, not enabled) | Large |
| QUIC native transport | Yes | SLIM (HTTP/3 in draft only) | Large |
| UCAN capability chains | Yes | AgentMesh (IATP, no chains) | Medium |
| CBOR deterministic framing | Yes | SLIM (Protobuf) | Small |
| Cross-connection replay cache | Yes | AgentMesh (single-use keys) | Small |

### 9.2 What Others Have That AAFP Doesn't

| Capability | Holder | AAFP Status | Gap Size |
|------------|--------|-------------|----------|
| Multi-agent group messaging | SLIM (MLS groups), AgentMesh (planned) | Not specified | Large |
| Task lifecycle state machine | A2A (8 states) | CLOSE state machine (different concern) | Medium |
| Trust scoring / governance | AgentMesh (0-1000 score, decay) | Not specified | Large |
| Human sponsor accountability | AgentMesh (mandatory) | Not specified | Medium |
| Policy engine (OPA/Cedar) | AgentMesh | Not specified | Large |
| Push notifications (webhook) | A2A | Not specified | Small |
| Production deployment at scale | A2A (Azure, Bedrock, Google) | Research/RC-1 | Large |
| Multi-language SDKs | MCP (6 SDKs), A2A (multiple) | Rust + Go only | Medium |
| Standards body governance | A2A (Linux Foundation), MCP (A2F) | Independent | Large |

## 10. Transition to Phase 3

Phase 3 (Protocol Layer Analysis) will use these comparison matrices to
produce detailed layer-by-layer analysis, identifying where AAFP's
architecture creates opportunities for interoperability, differentiation,
or convergence with the ecosystem.
