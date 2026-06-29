# AAFP — Agent-Agent First Networking Protocol
## Production Architecture Deliverable

**Date:** 2026-06-25
**Status:** Architecture complete. Ready for implementation.
**Predecessor:** `AAFP_Research_Report.md` (feasibility study, 794 lines)
**This document:** Actionable architecture for a small engineering team to begin implementing immediately.

**Methodology:** Architecture extraction performed via DeepWiki queries against `libp2p/rust-libp2p`, `n0-computer/iroh`, `rustls/rustls`, `ruvnet/QuDAG`; web research on `saorsa-labs/ant-quic`; and synthesis with the prior 6-subagent research report. All claims are tagged with confidence: **[Proven]** (deployed/measured), **[Likely]** (designed but untested at target scale), **[Speculative]** (extrapolated).

---

# Phase 1: Architecture Extraction

Each candidate repository is decomposed into 7 layers. For each we document what it does, strengths, weaknesses, and reuse potential for AAFP.

---

## 1.1 rust-libp2p (`libp2p/rust-libp2p`)

The dominant modular P2P stack in Rust. MIT/Apache-2.0. ~4.5K crates.io dependents. Architecture extracted via DeepWiki.

### Layer Decomposition

| Layer | Implementation | Key Files / Types |
|-------|---------------|-------------------|
| **Transport** | `Transport` trait with `listen_on`, `dial`, `poll`, `boxed`. Composed via upgrade pipeline. TCP, QUIC (quinn), WebSocket, WebRTC, Memory. | `core/src/transport.rs`, `transports/quic/src/{lib,config,connection}.rs`, `transports/tcp/src/lib.rs` |
| **Security** | Noise (XX, IK) via `noise::Config`. TLS 1.3 via `tls::Config`. Plaintext for testing. Security is an *upgrade* applied after raw transport. | `protocols/noise/src/io/handshake.rs`, `protocols/tls/src/lib.rs` |
| **Identity** | `PeerId` = SHA-256 multihash of protobuf-encoded public key. Ed25519 default; RSA, Secp256k1, ECDSA supported. `Keypair` enum. | `core/src/peer_id.rs`, `identity/src/{keypair,ed25519,rsa}.rs` |
| **Discovery** | Kademlia DHT as `NetworkBehaviour`. `KBucketsTable<TKey,TVal>` with 256 buckets, `K_VALUE=20`, `ALPHA_VALUE=3`. Iterative FIND_NODE/FIND_VALUE via `QueryPool`. `MemoryStore` for records. | `protocols/kad/src/{behaviour,kbucket,query,store}.rs` |
| **Routing** | Kademlia XOR routing. `KBucketsTable::closest_keys` for initial peers. Periodic bootstrap via `Behaviour::bootstrap()`. | `protocols/kad/src/kbucket.rs` |
| **Session** | `Swarm` orchestrates `Transport` + `NetworkBehaviour` + `ConnectionHandler`. Event model: `FromBehaviour`/`ToBehaviour`/`SwarmEvent`. Task-per-connection via `Executor` (tokio). | `swarm/src/lib.rs`, `swarm/src/connection/pool.rs` |
| **Multiplexing** | Yamux (12-byte frames, backpressure) and `StreamMuxer` trait. `poll_inbound`/`poll_outbound`/`poll_close`. QUIC has native multiplexing (no upgrade needed). | `muxers/yamux/src/lib.rs`, `core/src/muxing.rs` |

### Connection Upgrade Pipeline [Proven]

```
Raw Transport (TCP/WS)
  → upgrade(Version::V1Lazy)        // multistream-select negotiation
  → authenticate(security_upgrade)  // Noise/TLS → produces PeerId
  → multiplex(muxer_upgrade)        // Yamux → produces StreamMuxerBox
  → map((PeerId, StreamMuxerBox))
```

`SwarmBuilder::with_tcp(tcp_config, security, muxer)` composes this. QUIC bundles transport+security+muxing, so `with_quic()` skips upgrades.

### Strengths [Proven]
- **Modular trait abstractions** — Transport, StreamMuxer, NetworkBehaviour, ConnectionHandler are clean and composable
- **DCUtR + Relay v2 + AutoNAT** — 70% hole-punch success across 85K networks (arXiv 2604.12484)
- **Yamux** — lightweight multiplexer with backpressure
- **Swarm event model** — hierarchical state machine, well-tested
- **ConnectionLimits, allow_block_list** — production-grade connection governance
- **Identify protocol** — peer metadata exchange
- **Large ecosystem** — IPFS, Ethereum, Filecoin, Polkadot depend on it

### Weaknesses [Proven/Likely]
- **Noise XX = 2.5 RTT** (TCP 1 + Noise 1.5) before app data; no 0-RTT
- **Ed25519 PeerId** — quantum-vulnerable; no PQ support (issue #2168)
- **Task-per-connection** — ~10–50KB/connection; millions of connections = GBs of RAM
- **Flat Kademlia** — 256 buckets × k=20 = 5120 peers max routing; churn-fragile at second-scale sessions
- **Gossipsub D=6 default** — p99 propagation ~178ms; bandwidth 61% above optimal for large messages
- **QUIC 0-RTT not exposed** in public API
- **Relay v2 limits** — MaxReservations=128, MaxCircuits=16 per peer

### Reuse Potential: **HIGH (selective)**
Retain: Transport trait, Swarm/NetworkBehaviour/ConnectionHandler model, Yamux, DCUtR, Relay v2, AutoNAT, Identify, ConnectionLimits, multistream-select.
Replace: Noise → PQ handshake, PeerId → AgentID, Kademlia → hierarchical capability DHT, task-per-connection → io_uring.

---

## 1.2 Iroh (`n0-computer/iroh`)

QUIC-first P2P platform by n0. Apache-2.0. v1.0 (Jun 2026). Architecture extracted via DeepWiki.

### Layer Decomposition

| Layer | Implementation | Key Types |
|-------|---------------|-----------|
| **Transport** | QUIC via `noq` library. `Endpoint` struct with `connect()`, `accept()`, `Incoming`, `Connecting`, `Connection`. ALPN-based protocol negotiation. | `iroh-net/src/endpoint.rs` |
| **Security** | TLS 1.3 inside QUIC. Mutual authentication via Ed25519 public keys as TLS identity. | (quinn/quiche TLS layer) |
| **Identity** | `EndpointId` = Ed25519 `PublicKey`. `SecretKey` for private component. `EndpointAddr` = EndpointId + reachability paths (direct IPs + RelayUrl). | `iroh-net/src/endpoint.rs`, `iroh-net/src/addr.rs` |
| **Discovery** | `AddressLookup` trait. `DnsAddressLookup` publishes/resolves via DNS TXT records. Dial-by-key abstraction. | `iroh-net/src/discovery.rs` |
| **Routing** | Direct QUIC + relay fallback. `PathSelector` (default `BiasedRttPathSelector`) prioritizes lowest-latency direct path. Multipath-aware. | `iroh-net/src/path.rs` |
| **Session** | QUIC connection = session. Streams/datagrams within connection. | (quinn) |
| **Multiplexing** | QUIC native streams (no separate muxer needed) | (quinn) |

### NAT Traversal: QNT (QUIC NAT Traversal) [Proven/Likely]
- **QAD (QUIC Address Discovery)** — ALPN `/iroh-qad/0`, endpoints discover public IPs via relay
- **Direct hole punching** — coordinated via relay, `MAX_QNT_ADDRESSES=32`
- **DERP relay fallback** — revised Tailscale DERP; relays forward encrypted packets only (can't decrypt)
- **Home relay** — each endpoint connects to one; used when direct fails
- **Path selection** — multipath: Relay, IPv4, IPv6; RTT-biased selector with hysteresis

### Strengths [Proven]
- **Dial-by-key** — connect using only `EndpointId`; Iroh resolves addresses
- **QNT** — QUIC-native NAT traversal, cleaner than DCUtR (extension frames vs. relay-coordinated)
- **DERP relay pattern** — proven by Tailscale at million-node scale
- **DNS-based discovery** — simple, no DHT needed for small networks
- **Production v1.0** — stable, well-documented

### Weaknesses [Proven]
- **No PQ support** — Ed25519 only, classical TLS
- **Not agent-native** — designed for content-addressed blob sync, not agent communication
- **DNS discovery doesn't scale** to billion agents (DNS TXT records per-node)
- **No capability discovery** — no way to find agents by what they can do
- **No DHT** — relies on DNS or direct address sharing

### Reuse Potential: **MEDIUM**
Borrow: QNT NAT traversal design, DERP relay pattern, dial-by-key abstraction, `PathSelector`/multipath model.
Don't reuse: DNS discovery (doesn't scale), blob/doc layers (irrelevant to agents).

---

## 1.3 ant-quic (`saorsa-labs/ant-quic`)

Pure post-quantum QUIC. MIT/Apache-2.0. v0.27 (pre-1.0). 15 stars, 57K crates.io downloads. From-scratch QUIC (not quinn fork).

### Layer Decomposition

| Layer | Implementation | Key Modules |
|-------|---------------|-------------|
| **Transport** | From-scratch QUIC in Rust. `P2pEndpoint`, `P2pConfig`. Symmetric P2P (every node connects + accepts). | `ant_quic::p2p_endpoint`, `ant_quic::packet` |
| **Security** | **Pure PQ**: ML-KEM-768 KEX + ML-DSA-65 signatures. No classical fallback. Fail-closed. | `ant_quic::crypto`, saorsa-pqc crate |
| **Identity** | `PeerId` = SHA-256(ML-DSA-65 public key) = 32 bytes. TOFU trust model. Key rotation signed by old key. | `ant_quic::node` |
| **Discovery** | mDNS (default-on, first-party scoped). Relay/bootstrap/coordinator capability hints advertised by nodes. | `ant_quic::mdns`, `ant_quic::node_status` |
| **Routing** | Direct P2P + relay fallback. RTT-based path selection with hysteresis. | `ant_quic::path_selection` |
| **Session** | QUIC connection = session. Connection IDs (CID) for migration. | (QUIC spec) |
| **Multiplexing** | QUIC native streams | (QUIC spec) |

### NAT Traversal [Proven/Likely]
- **QUIC extension frames**: `OBSERVED_ADDRESS`, `ADD_ADDRESS`, `PUNCH_ME_NOW` — built into QUIC, not STUN/TURN
- **UPnP IGD** — best-effort local router port mapping (enabled by default)
- **MASQUE relay fallback** — TURN-style relay for NAT traversal
- **Token v2** — AEAD-protected address validation tokens bound to `(PeerId || CID || nonce)`

### Trust Model [Proven]
- **TOFU** (Trust On First Use) — first contact stores ML-DSA-65 fingerprint
- **Key rotation** — new keys signed by old key (continuity)
- **Channel binding** — TLS exporter signed with ML-DSA-65
- **NAT/path changes** — token binding uses `(PeerId || CID || nonce)`

### Performance [Likely]
- ML-KEM-768 keygen ~50µs, encap ~55µs, decap ~65µs (saorsa-pqc with AVX2/AVX-512/NEON)
- ML-DSA-65 sign ~350µs, verify ~130µs
- Sub-ms handshake overhead

### Strengths [Proven]
- **Pure PQ by design** — no hybrid complexity, strongest quantum resistance
- **QUIC-native NAT traversal** — extension frames, not external STUN/TURN
- **Symmetric P2P** — every node identical, no client/server asymmetry
- **Hardware-accelerated PQ** — saorsa-pqc with AVX2/AVX-512/NEON
- **Token binding** — address validation tied to peer identity

### Weaknesses [Proven]
- **Pre-1.0** — v0.27, small community (15 stars)
- **No classical compatibility** — greenfield only, can't interop with existing QUIC/TLS
- **No DHT/discovery** — only mDNS + relay hints, no large-scale discovery
- **Not agent-native** — no capability advertisement, no UCAN, no MCP
- **Single implementation** — no interoperability validation
- **Rust 1.88+ required** — Edition 2024

### Reuse Potential: **HIGH (as reference)**
Borrow: pure-PQ QUIC handshake design, NAT traversal extension frames, saorsa-pqc acceleration patterns, token binding model, symmetric P2P pattern.
Don't reuse: the actual QUIC implementation (use quinn + PQ overlay instead for ecosystem compatibility).

---

## 1.4 QuDAG (`ruvnet/QuDAG`)

Quantum-resistant DAG for AI agent swarms. MIT. v1.4 (Jun 2025). 2 contributors. Architecture extracted via DeepWiki.

### Layer Decomposition

| Layer | Implementation | Key Modules |
|-------|---------------|-------------|
| **Transport** | libp2p (Kademlia + Gossipsub + Noise + NAT traversal via STUN/TURN/UPnP) | `qudag-network` |
| **Security** | ML-KEM-768 + ML-DSA (Dilithium-3) + HQC + BLAKE3. ChaCha20Poly1305 for symmetric. | `qudag-crypto` |
| **Identity** | ML-DSA keypairs. `.dark` domain system with quantum fingerprints (64-byte hashes). Shadow addresses for ephemeral communication. | `qudag-network::DarkResolver` |
| **Discovery** | Kademlia DHT (via libp2p) + `.dark` domain resolution | `qudag-network` |
| **Routing** | **ML-KEM onion routing** (3–7 hops). `MLKEMOnionRouter`. Circuit rotation, dummy traffic, size normalization, timing obfuscation. | `qudag-network::onion` |
| **Session** | DAG-based. `Dag` + `Vertex` structures. QR-Avalanche BFT consensus. `QRAvalanche` struct manages voting records + confidence levels. | `qudag-dag` |
| **Multiplexing** | libp2p Yamux (inherited) | (libp2p) |

### Agent-Native Features [Proven]
- **MCP-first architecture** — `qudag-mcp` module provides MCP server (stdio, HTTP, WebSocket). Tool suite for vault, DAG, network, crypto, system, config operations.
- **rUv tokens** (Resource Utilization Vouchers) — `qudag-exchange-core`. Agents trade CPU, storage, bandwidth. Dynamic fee models. `rUv`, `AccountId`, `Transaction`, `FeeRouter`.
- **Agent swarm model** — role specialization (Coordinator, Test, Implementation agents), parallel task assignment, shared context coordination.

### Strengths [Proven]
- **Explicitly agent-native** — designed for autonomous AI agent swarms
- **Fully PQ** — ML-KEM, ML-DSA, HQC, BLAKE3
- **MCP integration** — real-time agent communication and task distribution
- **Onion routing** — ML-KEM-based, 3–7 hops, with traffic analysis resistance
- **`.dark` domains** — decentralized, human-readable, quantum-resistant
- **Resource economy** — rUv tokens for self-regulating resource exchange
- **DAG consensus** — parallel message processing, higher throughput than blockchain

### Weaknesses [Proven]
- **Very new** — created June 2025, immature
- **Integration pending** — Network-DAG bridge, state persistence incomplete
- **2 contributors** — bus factor risk
- **No security audit**
- **10K TPS claim** is theoretical [Highly Speculative]
- **Built on libp2p** — inherits libp2p's scaling limits (task-per-connection, flat Kademlia)
- **Noise handshakes** — uses libp2p's Noise, not PQ handshakes at transport layer (PQ is at application/DAG layer)

### Reuse Potential: **MEDIUM (patterns, not code)**
Borrow: MCP integration pattern, onion routing design, rUv resource exchange pattern, `.dark` domain concept, DAG consensus concept (optional), modular crate architecture.
Don't reuse: actual code (immature, untested), libp2p Noise (we're replacing it).

---

## 1.5 Citadel Protocol

PQ client-server/P2P. MIT/Apache-2.0. 5yr dev, 9.8K downloads. Single developer.

### Layer Decomposition

| Layer | Implementation |
|-------|---------------|
| **Transport** | TCP + WebSocket. Central-server broker + P2P fallback. |
| **Security** | Kyber/NTRU KEMs, Falcon-1024 signatures, AES-256-GCM/ChaCha20-Poly1305/Ascon-80pq AEAD. Patent-pending 3D matrix ratcheting. |
| **Identity** | PQ keypairs. Citadel Agent daemon (multiplexing IPC). |
| **Discovery** | Central server broker. |
| **Routing** | Central server → P2P fallback. |
| **Session** | Daemon-based. RE-VFS encrypted filesystem. |
| **Multiplexing** | Citadel Agent daemon (IPC multiplexing). |

### Strengths [Proven]
- Strong PQ foundation (Kyber, NTRU, Falcon)
- Novel 3D matrix ratcheting algorithm
- Built-in NAT traversal (STUN×3 + TURN fallback)
- Daemon pattern suits agents (persistent, multiplexed)
- Security-mode configuration (best-effort vs PFS)

### Weaknesses [Proven]
- **Central server dependency** — single point of failure/privacy
- **No security audit**
- **Single developer** — bus factor
- **Low adoption** (9,816 downloads)
- **Patent uncertainty** — 3D matrix ratcheting is patent-pending
- **Not libp2p-compatible**

### Reuse Potential: **LOW (concepts only)**
Borrow: ratcheting algorithm concept, daemon multiplexing pattern, security-mode configuration pattern.
Don't reuse: code (centralized, patent-encumbered, single-developer).

---

## 1.6 rustls / liboqs / pqcrypto

Cryptography libraries, not networking stacks.

### rustls (`rustls/rustls`) [Proven]
- **PQ via aws-lc-rs backend**: `aws_lc_rs::default_provider()` includes `X25519MLKEM768` as default KX group
- **`prefer-post-quantum` feature** (0.23.22+): controls ML-KEM preference
- **ML-DSA experimental**: `rustls-post-quantum` crate with `aws-lc-rs-unstable` feature → `ML_DSA_44`, `ML_DSA_65`, `ML_DSA_87`
- **0-RTT**: TLS 1.3 session resumption supported
- **Custom providers**: implement `SupportedCipherSuite` + `SupportedKxGroup` traits → custom `CryptoProvider`
- **ring backend**: NO PQ support (closed as not_planned)
- **Hybrid optimization**: `hybrid_component()` method avoids HelloRetryRequest when client offers both hybrid + classical

```rust
// Enabling PQ in rustls
let provider = rustls::crypto::aws_lc_rs::default_provider();
let config = rustls::ClientConfig::builder_with_provider(provider.into())
    .with_safe_default_protocol_versions().unwrap()
    .with_root_certificates(root_store)
    .with_no_client_auth();
```

### liboqs-rust [Proven]
- Official OQS Rust bindings. `oqs-sys` (FFI) + `oqs` (safe wrapper). Apache-2.0.
- Broadest algorithm coverage: ML-KEM, ML-DSA, SLH-DSA, Falcon, HQC, Classic McEliece
- Best for non-TLS PQ operations (KEMTLS-style handshakes, standalone PQ signatures)

### pqcrypto (rustpq) [Proven]
- Rust bindings to PQClean. Modular crates (`pqcrypto-mlkem`, `pqcrypto-mldsa`, etc.). MIT/Apache.
- 257 commits, 392 stars. Easier build than liboqs (no C dependency chain).

### Reuse Potential: **CRITICAL**
- **rustls + aws-lc-rs**: PQ in TLS path (X25519MLKEM768 hybrid, ML-DSA experimental)
- **liboqs-rust**: standalone PQ primitives for custom handshakes, broadest algorithm coverage
- **pqcrypto**: alternative if liboqs build complexity is problematic

---

## 1.7 Summary Reuse Matrix

| Repository | Transport | Security | Identity | Discovery | Routing | Session | Mux | Overall Reuse |
|-----------|-----------|----------|----------|-----------|---------|---------|-----|---------------|
| **rust-libp2p** | ✅ Fork | ❌ Replace | ❌ Replace | ❌ Replace | ❌ Replace | ✅ Modify | ✅ Keep | **HIGH** |
| **Iroh** | — | — | — | 📋 Pattern | 📋 Pattern | — | — | **MEDIUM** |
| **ant-quic** | 📋 Reference | 📋 Reference | 📋 Reference | — | 📋 Pattern | — | — | **HIGH (ref)** |
| **QuDAG** | — | — | — | — | 📋 Pattern | 📋 Pattern | — | **MEDIUM** |
| **Citadel** | — | 📋 Concept | — | — | — | 📋 Concept | — | **LOW** |
| **rustls** | — | ✅ Use | — | — | — | — | — | **CRITICAL** |
| **liboqs** | — | ✅ Use | — | — | — | — | — | **CRITICAL** |

Legend: ✅ = use directly, ❌ = replace, 📋 = borrow pattern/concept, — = not relevant

---

# Phase 2: Component Selection Matrix

For each subsystem, we select one option and justify with the weighted scoring matrix from the research report (Security 25%, Latency 25%, Simplicity 15%, Scalability 15%, Implementability 10%, PQ readiness 10%).

---

## 2.1 Transport

| Option | Sec | Lat | Sim | Sca | Imp | PQ | Weighted |
|--------|-----|-----|-----|-----|-----|-----|----------|
| QUIC (quinn) | 8 | 9 | 8 | 8 | 9 | 7 | **8.15** |
| Modified QUIC (quinn + 0-RTT + migration) | 8 | 10 | 7 | 9 | 7 | 7 | **8.30** |
| ant-quic (pure-PQ QUIC) | 9 | 8 | 6 | 7 | 4 | 10 | **7.55** |
| Custom transport | 7 | 8 | 3 | 8 | 2 | 8 | **6.10** |

### Selection: **Modified QUIC (quinn-based, with 0-RTT + connection migration)**

**Why:**
- QUIC provides native multiplexing, 0-RTT, connection migration, and ECN — all critical for agents [Proven]
- quinn is the most mature Rust QUIC library, already used by rust-libp2p and Iroh [Proven]
- Modifying quinn to expose 0-RTT and enable migration is lower-risk than ant-quic's from-scratch implementation [Likely]
- ant-quic's pure-PQ approach is architecturally cleaner but loses ecosystem compatibility (no interop with existing QUIC/TLS) and is pre-1.0 with 15 stars [Proven]
- Custom transport is rejected — reimplementing QUIC's congestion control, loss recovery, and packet pacing is 12+ months of work for no benefit [Proven]

**What "Modified" means:**
1. Expose quinn's 0-RTT API (currently internal) for HQRT-style PQ resumption
2. Enable QUIC connection migration (CID-based, allows IP changes without reconnect)
3. Add ant-quic-style NAT traversal extension frames (`OBSERVED_ADDRESS`, `ADD_ADDRESS`, `PUNCH_ME_NOW`)
4. Integrate rustls+aws-lc-rs for PQ KEX inside QUIC's TLS layer
5. Optional pure-PQ mode (ML-KEM-768 only) for greenfield deployments

---

## 2.2 Security

| Option | Sec | Lat | Sim | Sca | Imp | PQ | Weighted |
|--------|-----|-----|-----|-----|-----|-----|----------|
| Noise (current libp2p) | 5 | 5 | 8 | 8 | 9 | 2 | **5.85** |
| TLS 1.3 (classical) | 6 | 7 | 7 | 8 | 9 | 2 | **6.40** |
| Hybrid TLS (X25519MLKEM768) | 9 | 8 | 6 | 8 | 7 | 9 | **7.95** |
| PQ-only handshake (ML-KEM + ML-DSA) | 10 | 7 | 5 | 8 | 5 | 10 | **7.75** |

### Selection: **Hybrid TLS (X25519MLKEM768 + ML-DSA-65) with HQRT-style PQ 0-RTT**

**Why:**
- Hybrid X25519MLKEM768 is already default in Cloudflare, Chrome 131+, AWS [Proven] — battle-tested
- Hedging: if ML-KEM is broken, X25519 still provides classical security; if quantum computer arrives, ML-KEM provides PQ security [Proven strategy]
- rustls+aws-lc-rs supports it natively via `prefer-post-quantum` feature [Proven]
- HQRT-style PQ 0-RTT adds only 4–9% latency overhead vs classical 0-RTT [Proven]
- ML-DSA-65 for signatures: L3 security, 3.3KB sig, ~500µs sign — NIST-recommended minimum [Proven]
- Pure-PQ mode is configurable for environments requiring no classical algorithms (algorithm agility)

**Handshake flow:**
```
Client                              Server
  |---- ClientHello ------------------>|
  |     (X25519MLKEM768 key share,     |
  |      ML-DSA-65 cert request)       |
  |                                    |
  |<--- ServerHello -------------------|
  |     (X25519MLKEM768 key share,     |
  |      ML-DSA-65 cert, signature)    |
  |                                    |
  |==== 0-RTT app data (if resuming) ==>|  ← 0-RTT if session ticket cached
  |                                    |
  |---- 1-RTT app data --------------->|  ← 1-RTT for new connections
  |==== app data (bidirectional) ======|
```

**0-RTT replay protection:** Single-use tickets + nonces + freshness window + idempotency taxonomy for agent operations [Proven pattern from TLS 1.3].

---

## 2.3 Identity

| Option | Sec | Lat | Sim | Sca | Imp | PQ | Weighted |
|--------|-----|-----|-----|-----|-----|-----|----------|
| libp2p PeerId (Ed25519) | 3 | 9 | 9 | 8 | 10 | 1 | **5.80** |
| PQ identity (ML-DSA-65) | 9 | 7 | 7 | 8 | 7 | 10 | **7.90** |
| DID (did:key) | 7 | 6 | 6 | 7 | 6 | 7 | **6.55** |
| Custom capability identity | 9 | 7 | 5 | 9 | 4 | 9 | **7.45** |

### Selection: **PQ Identity (ML-DSA-65) + UCAN Capability Chains**

**Why:**
- ML-DSA-65 keypair as root identity: L3 PQ security, NIST FIPS 204 standardized [Proven]
- `AgentID = SHA-256(ML-DSA-65 pubkey)` = 32 bytes — compact for DHT/routing, collision-resistant [Likely]
- Full 1952-byte pubkey exchanged once during handshake, then cached — prevents key-substitution attacks via hash verification [Likely]
- UCAN (User Controlled Authorization Networks) capability chains for delegation: offline-first, JWT-based, proven by Fission [Proven]
- PQ-signed UCAN chains: each delegation link signed with ML-DSA-65 — quantum-resistant delegation [Likely]
- DID rejected: adds complexity without benefit for agent-to-agent (DID is for human-centric identity with registries)
- Pure custom capability identity rejected: too much implementation risk for marginal benefit

**Identity structure:**
```rust
struct AgentKeypair {
    signing_key: MLDSA65SecretKey,    // root identity
    // optional: SLH-DSA-128s for long-term trust anchor (hedge vs lattice breaks)
}

type AgentID = [u8; 32];  // SHA-256(ML-DSA-65 public key)

struct AgentRecord {
    agent_id: AgentID,
    pubkey: MLDSA65PublicKey,         // 1952 bytes, exchanged once
    capabilities: Vec<Capability>,     // OASF-format capability claims
    vendor_attestations: Vec<VC>,      // optional vendor-signed verifiable credentials
    endpoints: Vec<EndpointAddr>,      // how to reach this agent
    version: u64,
    signature: MLDSA65Signature,       // self-signed
}
```

**UCAN delegation chain:**
```
Root Agent (ML-DSA-65 keypair)
  └─ delegates "compute.inference" to Agent B (UCAN token, signed by Root)
       └─ delegates "compute.inference" with 50% quota to Agent C (UCAN token, signed by B)
            └─ Agent C presents chain to Agent D when invoking capability
```

---

## 2.4 Discovery

| Option | Sec | Lat | Sim | Sca | Imp | PQ | Weighted |
|--------|-----|-----|-----|-----|-----|-----|----------|
| Kademlia (flat) | 6 | 5 | 8 | 4 | 9 | 5 | **5.65** |
| Modified Kademlia (hierarchical) | 7 | 7 | 6 | 8 | 7 | 5 | **6.95** |
| DHT alternative (Iroh DNS) | 5 | 8 | 9 | 3 | 8 | 5 | **6.10** |
| Hybrid (hierarchical + capability + gossip) | 8 | 7 | 4 | 9 | 5 | 7 | **7.05** |

### Selection: **Hybrid Discovery (5-Layer Architecture)**

**Why:**
- Flat Kademlia works at 10⁷ (BitTorrent) but fails at second-scale agent churn [Proven]
- Iroh DNS discovery doesn't scale beyond ~10⁵ nodes [Proven]
- No single discovery mechanism handles: billion scale + high churn + capability lookup + low latency
- Hybrid approach combines strengths of each layer

**5-Layer Discovery Architecture:**

```
Layer 5: Semantic Vector Index (optional)
  ↕ (capability embeddings)
Layer 4: Gossipsub Liveness (D=22, capability topics)
  ↕ (heartbeat, presence, capability updates)
Layer 3: Capability-Keyed DHT (key=H(cap||ver||region), value=Bloom filter of AgentIDs)
  ↕ (capability lookup)
Layer 2: Hierarchical Regional Clusters (10⁴–10⁵ agents per cluster)
  ↕ (regional routing)
Layer 1: Bootstrap (seed nodes, DNS, mDNS for local)
```

**Layer 2 — Hierarchical Regional Clusters:**
- Agents assigned to regions by network topology (RTT-based clustering, not geographic)
- Each cluster: 10⁴–10⁵ agents
- Super-peers (high-reputation, high-uptime agents) form inter-cluster DHT
- Cluster size adapts to churn rate

**Layer 3 — Capability-Keyed DHT:**
- Key: `H(capability_id || version || region_id)` — SHA-256, 32 bytes
- Value: Bloom filter of AgentIDs that have this capability in this region
- Bloom filter sizing: m=10000 bits, k=7 → 1% FPR for ~1000 agents per capability per region [Likely]
- Adaptive refresh: 1–15min intervals based on observed churn (Bamboo-style) [Proven pattern]

**Layer 4 — Gossipsub Liveness:**
- D=22 (mesh degree, tuned for billion scale) [Likely]
- Capability topics: `cap.{capability_id}.{region_id}` — agents subscribe to their capabilities
- Heartbeat interval: 1s (agent liveness is second-scale, not minute-scale like files)
- Score-based mesh management (gossipsub v1.1 pattern) [Proven]

**Layer 5 — Semantic Vector Index (optional, v1.1+):**
- Embedding-based capability matching (e.g., "find agents that can do NLP on Japanese text")
- Federated embedding providers (not centralized)
- Approximate nearest neighbor search over capability embeddings
- [Speculative — research gap]

---

## 2.5 Messaging

| Option | Sec | Lat | Sim | Sca | Imp | PQ | Weighted |
|--------|-----|-----|-----|-----|-----|-----|----------|
| Streams (QUIC/Yamux) | 8 | 9 | 8 | 8 | 9 | 7 | **8.10** |
| RPC (request-response) | 7 | 8 | 7 | 7 | 8 | 7 | **7.30** |
| PubSub (gossipsub) | 7 | 7 | 7 | 9 | 7 | 7 | **7.40** |
| Event bus | 6 | 7 | 6 | 8 | 6 | 7 | **6.75** |
| **Hybrid** | 8 | 9 | 6 | 9 | 6 | 7 | **7.75** |

### Selection: **Hybrid Messaging (Streams + RPC + PubSub)**

**Why:**
- Agents need all three patterns:
  - **Streams** for large data transfer (model weights, datasets, logs) — QUIC streams with backpressure
  - **RPC** for request-response (inference calls, capability queries, contracting) — over QUIC streams with framing
  - **PubSub** for broadcast (capability updates, liveness, swarm coordination) — gossipsub
- Single-pattern approaches force awkward mappings (e.g., RPC-over-PubSub is anti-pattern)
- QUIC provides native streams; RPC is a thin framing layer on top; PubSub is gossipsub (already in libp2p)

**Messaging API:**
```rust
enum MessagePattern {
    Stream,        // bidirectional, backpressured, long-lived
    Rpc,           // request-response, timeout-bounded
    PubSub(topic), // broadcast to subscribers
}

trait AgentMessaging {
    async fn open_stream(&mut self, peer: AgentID) -> Stream;
    async fn rpc(&mut self, peer: AgentID, request: Request) -> Response;
    async fn publish(&mut self, topic: TopicHash, msg: Message);
    async fn subscribe(&mut self, topic: TopicHash) -> Subscription;
}
```

---

## 2.6 Component Selection Summary

| Subsystem | Selection | Source | Key Dependency |
|-----------|-----------|--------|----------------|
| **Transport** | Modified QUIC (quinn + 0-RTT + migration + NAT frames) | quinn + ant-quic patterns | quinn, rustls |
| **Security** | Hybrid TLS (X25519MLKEM768 + ML-DSA-65) + HQRT 0-RTT | rustls + aws-lc-rs | rustls, aws-lc-rs, liboqs-rust |
| **Identity** | ML-DSA-65 keypair → 32B AgentID + UCAN chains | FIPS 204 + Fission UCAN | liboqs-rust, pqcrypto-mldsa |
| **Discovery** | 5-layer hybrid (bootstrap → regional → capability DHT → gossip → semantic) | libp2p Kademlia (modified) + gossipsub | rust-libp2p (forked) |
| **Messaging** | Hybrid (streams + RPC + pubsub) | QUIC streams + gossipsub | quinn, libp2p gossipsub |
| **Multiplexing** | QUIC native streams (primary) + Yamux (TCP fallback) | quinn + libp2p yamux | quinn, yamux |
| **NAT Traversal** | DCUtR + QNT + hierarchical relays | libp2p DCUtR + Iroh QNT | rust-libp2p (forked) |
| **Connection Mgmt** | io_uring (Linux) / kqueue (macOS) thread-per-core | custom | tokio-uring, mio |

---

# Phase 3: First-Principles Design

*If no code existed today, what would the protocol look like?*

This phase ignores all existing systems and designs from scratch, then compares against libp2p.

---

## 3.1 Transport (From Scratch)

**Design:** UDP-based, QUIC-like protocol with:
- **Native 0-RTT** — first packet carries encrypted application data if session ticket is cached
- **Connection migration** — CID-based, agents move between networks without reconnect
- **Native multiplexing** — streams within connection, no separate muxer
- **PQ-native handshake** — ML-KEM-768 KEX inside the transport, not bolted on
- **NAT traversal extension frames** — `OBSERVED_ADDRESS`, `ADD_ADDRESS`, `PUNCH_ME_NOW` in the wire protocol
- **Datagram support** — unreliable, unordered messages for latency-sensitive agent telemetry
- **ECN** — explicit congestion notification for low-latency agent traffic

**Comparison with libp2p:**
- libp2p's transport is a *trait* that abstracts over TCP/QUIC/WebSocket/WebRTC. This is elegant but means the security layer is an *upgrade* applied after the raw transport, adding RTTs.
- From-scratch design bakes security into the transport (like QUIC does), eliminating the upgrade pipeline overhead.
- **Verdict:** QUIC already does this. We don't need from-scratch — we need *modified QUIC*. The from-scratch design converges to QUIC + PQ + NAT frames, which is exactly Phase 2's selection.

## 3.2 Discovery (From Scratch)

**Design:** Three-tier discovery:
1. **Local** — mDNS for LAN agents (zero-config, sub-second)
2. **Regional** — capability-keyed DHT with Bloom filter values, 10⁴–10⁵ agents per region
3. **Global** — super-peer DHT connecting regional clusters, gossipsub for liveness

**Key innovation:** Discovery by *capability*, not by *key*. Agents ask "who can do X in region Y?" not "where is agent Z?"

**Comparison with libp2p:**
- libp2p's Kademlia discovers by PeerId (XOR distance). You can only find a peer if you know its ID.
- From-scratch design discovers by capability — agents find each other by what they can do.
- This is a fundamental semantic shift. libp2p's Kademlia cannot be patched to do this; it requires a new DHT schema.
- **Verdict:** Must replace Kademlia. The from-scratch design becomes the 5-layer architecture from Phase 2.

## 3.3 Identity (From Scratch)

**Design:**
- **Root identity:** PQ keypair (ML-DSA-65) — no central registry, no DID, no X.509
- **Compact ID:** `SHA-256(pubkey)` = 32 bytes for routing/DHT
- **Full key:** exchanged once during handshake, cached, verified against compact ID
- **Delegation:** UCAN-style capability chains — "Agent A delegates capability X to Agent B"
- **Reputation:** EigenTrust-style distributed reputation (probabilistic, not absolute)
- **Attestation:** Optional vendor-signed verifiable credentials for capability claims

**Comparison with libp2p:**
- libp2p's PeerId is `SHA-256(protobuf(pubkey))` — structurally similar but Ed25519 (quantum-vulnerable).
- From-scratch design is identical in structure but PQ in cryptography.
- The real innovation is the *UCAN capability layer* on top — libp2p has no notion of capabilities or delegation.
- **Verdict:** Replace Ed25519 with ML-DSA-65, add UCAN layer. Structure is the same; cryptography and semantics differ.

## 3.4 Handshake (From Scratch)

**Design:** PQ-hybrid 1-RTT handshake with 0-RTT resumption:

```
Round 0 (0-RTT, resumption only):
  Client → Server: ClientHello + X25519MLKEM768 key share + 0-RTT data
  Server validates session ticket, processes 0-RTT data (idempotent only)

Round 1 (1-RTT, new connections):
  Client → Server: ClientHello + X25519MLKEM768 key share + ML-DSA-65 cert
  Server → Client: ServerHello + X25519MLKEM768 key share + ML-DSA-65 cert + signature
  Client → Server: Finished + 1-RTT data
```

**DoS protection:** WireGuard-style cookie mechanism — server issues cookies to unauthenticated clients before expensive KEM operations.

**Comparison with libp2p:**
- libp2p Noise XX: 2.5 RTT (TCP 1 + Noise 1.5) before app data. No 0-RTT.
- From-scratch: 1-RTT for new, 0-RTT for resumption. **2.5× faster for new, ∞× faster for returning.**
- For agents that reconnect frequently (ephemeral instances), 0-RTT is transformative.
- **Verdict:** Must replace Noise. The from-scratch handshake is the Phase 2 selection.

## 3.5 Routing (From Scratch)

**Design:**
- **Intra-cluster:** Direct QUIC connections (agents in same region connect directly)
- **Inter-cluster:** Super-peer relay + DHT routing (super-peers route between clusters)
- **NAT traversal:** DCUtR + QNT + hierarchical relays (90%+ success rate target)
- **Connection migration:** Agents change IP/port without reconnecting (QUIC CID)

**Comparison with libp2p:**
- libp2p routes via Kademlia's XOR distance — semantically meaningless for agents.
- From-scratch routes via *capability proximity* and *network proximity* — agents connect to nearby agents with matching capabilities.
- libp2p's DCUtR is excellent (70% hole-punch) but flat. From-scratch adds hierarchical relays for the remaining 30%.
- **Verdict:** Replace Kademlia routing with capability+network-proximity routing. Keep and extend DCUtR.

## 3.6 First-Principles vs libp2p Comparison

| Dimension | From-Scratch Design | libp2p Today | Delta |
|-----------|-------------------|--------------|-------|
| Transport | Modified QUIC (PQ-native, 0-RTT, migration) | TCP+Noise or QUIC+Noise | 0-RTT, PQ, migration |
| Discovery | Capability-keyed, hierarchical, 5-layer | PeerId-keyed, flat Kademlia | Capability lookup, 10⁹ scale |
| Identity | ML-DSA-65 + UCAN + reputation | Ed25519 PeerId | PQ, capabilities, delegation |
| Handshake | 1-RTT new / 0-RTT resume, PQ hybrid | 2.5-RTT, classical | 2.5× faster, PQ |
| Routing | Capability + network proximity, hierarchical | XOR distance, flat | Semantic, scalable |
| NAT | DCUtR + QNT + hierarchical relays (>90%) | DCUtR (70%) | +20% success |
| Connections | io_uring, 100K+/agent | task-per-conn, ~20K/agent | 5× more connections |

**Conclusion:** The from-scratch design is *exactly* Architecture B (Aggressive Fork). We retain libp2p's Transport/Swarm/Yamux/DCUtR abstractions and replace everything else. The from-scratch exercise confirms that Architecture B is the right design — it's what you'd build if you started fresh, but with proven foundations.

---

# Phase 4: MVP Definition

*The smallest useful version of AAFP.*

## 4.1 MVP Requirements

- **1,000 agents** connected simultaneously
- **NAT traversal** (DCUtR + relay fallback)
- **PQ security** (X25519MLKEM768 hybrid handshake)
- **Discovery** (capability-keyed DHT, single region)
- **Messaging** (QUIC streams + RPC)

## 4.2 MVP Features

### Included

| Feature | Implementation | Effort |
|---------|---------------|--------|
| PQ hybrid handshake | X25519MLKEM768 + ML-DSA-65 via rustls+aws-lc-rs | 4 weeks |
| AgentID (ML-DSA-65 → SHA-256) | New PeerId variant in forked libp2p | 2 weeks |
| QUIC transport with 0-RTT | quinn + rustls, expose 0-RTT API | 3 weeks |
| Capability-keyed DHT (single region) | Modified Kademlia: key=H(cap), value=AgentID list | 4 weeks |
| QUIC streams messaging | quinn native streams + simple RPC framing | 2 weeks |
| DCUtR NAT traversal | Retain from libp2p (already works) | 1 week |
| Relay fallback | Retain libp2p Relay v2 (scale limits acceptable for 1K) | 1 week |
| Basic CLI | `agentnet init`, `agentnet connect`, `agentnet discover`, `agentnet send` | 2 weeks |
| Integration tests | 1000-agent testnet on local network | 3 weeks |
| **Total** | | **~22 weeks (5 months)** |

### Excluded from MVP

| Feature | Reason | Target |
|---------|--------|--------|
| 0-RTT resumption (HQRT) | Complex ticket management; 1-RTT is sufficient for MVP | Phase 3 (Month 12) |
| Hierarchical regional clustering | Single region sufficient for 1K agents | Phase 2 (Month 8) |
| Gossipsub liveness layer | DHT polling sufficient for 1K agents | Phase 2 (Month 10) |
| UCAN capability chains | MVP uses direct capability advertisement | Phase 2 (Month 9) |
| io_uring connection management | task-per-conn works fine for 1K agents | Phase 3 (Month 14) |
| Semantic vector index | Research-heavy, not needed for MVP | v1.1+ |
| MCP transport binding | Agent semantics layer, not networking | Phase 4 (Month 20) |
| Reputation system | Not needed for 1K trusted agents | Phase 4 (Month 19) |
| Onion routing | Privacy layer, not core networking | v1.1+ |
| Autonomous contracting | Agent semantics, not networking | v1.1+ |

## 4.3 MVP Engineering Effort

- **1-2 engineers** for 5 months
- **Dependencies:** rust-libp2p (forked), quinn, rustls, aws-lc-rs, liboqs-rust, tokio
- **Deliverable:** AAFP v0.1 — 1000 agents, PQ-secure, NAT-traversing, capability-discoverable, stream-messaging

## 4.4 MVP Success Criteria

1. 1000 agents connect and discover each other by capability in <5s
2. All connections use X25519MLKEM768 hybrid handshake (verified by packet capture)
3. Agents behind NAT connect via DCUtR (70%+) or relay fallback (100%)
4. Agents exchange messages via QUIC streams with <10ms p99 latency on LAN
5. CLI demonstrates: init → discover → connect → send → receive

---

# Phase 5: Repository Structure

## 5.1 Rust Workspace Design

```
aafp/
├── Cargo.toml                    # workspace root
├── README.md
├── ARCHITECTURE.md
├── CHANGELOG.md
├── docs/
│   ├── spec/
│   │   ├── aafp-transport.md       # Modified QUIC spec
│   │   ├── aafp-handshake.md       # PQ hybrid handshake spec
│   │   ├── aafp-identity.md        # AgentID + UCAN spec
│   │   ├── aafp-discovery.md       # 5-layer discovery spec
│   │   ├── aafp-messaging.md       # Streams + RPC + PubSub spec
│   │   ├── aafp-nat.md             # NAT traversal spec
│   │   └── aafp-agent-semantics.md # Capability, reputation, contracting
│   ├── rfc/                        # IETF-style drafts
│   └── diagrams/
│
├── crates/
│   ├── aafp-core/                  # Core traits: Transport, Swarm, AgentID
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── transport.rs        # Transport trait (forked from libp2p)
│   │   │   ├── swarm.rs            # Swarm + NetworkBehaviour (forked)
│   │   │   ├── agent_id.rs         # AgentID = SHA-256(ML-DSA-65 pubkey)
│   │   │   ├── connection.rs       # ConnectionHandler (modified)
│   │   │   └── error.rs
│   │   └── Cargo.toml
│   │
│   ├── aafp-transport-quic/        # Modified QUIC transport
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── config.rs           # QuinnConfig with PQ + 0-RTT
│   │   │   ├── connection.rs       # QUIC connection wrapper
│   │   │   ├── nat_frames.rs       # OBSERVED_ADDRESS, ADD_ADDRESS, PUNCH_ME_NOW
│   │   │   └── migration.rs        # Connection migration (CID-based)
│   │   └── Cargo.toml
│   │   (depends on: quinn, rustls, aafp-crypto)
│   │
│   ├── aafp-crypto/                # PQ cryptography layer
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── kem.rs              # ML-KEM-768 + X25519MLKEM768 hybrid
│   │   │   ├── dsa.rs              # ML-DSA-65 signatures
│   │   │   ├── aead.rs             # ChaCha20-Poly1305 / AES-256-GCM
│   │   │   ├── handshake.rs        # PQ hybrid handshake implementation
│   │   │   ├── resumption.rs       # HQRT-style 0-RTT ticket management
│   │   │   ├── kdf.rs              # HKDF key derivation
│   │   │   └── traits.rs           # CryptoProvider abstraction
│   │   └── Cargo.toml
│   │   (depends on: rustls, aws-lc-rs, liboqs-rust)
│   │
│   ├── aafp-identity/              # Agent identity + UCAN
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── keypair.rs          # ML-DSA-65 keypair management
│   │   │   ├── agent_id.rs         # AgentID derivation + verification
│   │   │   ├── agent_record.rs     # AgentRecord (pubkey, capabilities, endpoints)
│   │   │   ├── ucan.rs             # UCAN capability delegation chains
│   │   │   ├── attestation.rs      # Vendor-signed verifiable credentials
│   │   │   └── reputation.rs       # EigenTrust reputation (Phase 4)
│   │   └── Cargo.toml
│   │   (depends on: aafp-crypto)
│   │
│   ├── aafp-discovery/             # 5-layer discovery
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── bootstrap.rs        # Layer 1: seed nodes, DNS, mDNS
│   │   │   ├── regional.rs         # Layer 2: hierarchical regional clusters
│   │   │   ├── capability_dht.rs   # Layer 3: capability-keyed DHT + Bloom filters
│   │   │   ├── liveness.rs         # Layer 4: gossipsub liveness (D=22)
│   │   │   ├── semantic.rs         # Layer 5: vector index (v1.1+, stub in v1)
│   │   │   └── churn.rs            # Adaptive churn handling (Bamboo-style)
│   │   └── Cargo.toml
│   │   (depends on: aafp-core, aafp-identity, libp2p-gossipsub forked)
│   │
│   ├── aafp-routing/               # Routing layer
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── intra_cluster.rs    # Direct QUIC routing within region
│   │   │   ├── inter_cluster.rs    # Super-peer DHT routing between regions
│   │   │   └── path_selector.rs    # RTT-based multipath selection (Iroh pattern)
│   │   └── Cargo.toml
│   │   (depends on: aafp-core, aafp-discovery)
│   │
│   ├── aafp-nat/                   # NAT traversal
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── dcutr.rs            # DCUtR (forked from libp2p, retained)
│   │   │   ├── qnt.rs              # QNT (Iroh-style QUIC NAT traversal)
│   │   │   ├── relay.rs            # Hierarchical relay infrastructure
│   │   │   ├── upnp.rs             # UPnP IGD (best-effort)
│   │   │   └── auto_nat.rs         # AutoNAT (forked from libp2p)
│   │   └── Cargo.toml
│   │   (depends on: aafp-transport-quic, aafp-core)
│   │
│   ├── aafp-messaging/             # Messaging layer
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── stream.rs           # QUIC stream messaging (backpressured)
│   │   │   ├── rpc.rs              # RPC framing over QUIC streams
│   │   │   ├── pubsub.rs           # Gossipsub integration
│   │   │   ├── datagram.rs         # QUIC datagram (unreliable, low-latency)
│   │   │   └── framing.rs          # Message framing (length-prefixed)
│   │   └── Cargo.toml
│   │   (depends on: aafp-core, aafp-transport-quic, aafp-discovery)
│   │
│   ├── aafp-agent/                 # Agent semantics layer (Phase 4)
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── capability.rs       # Capability advertisement (OASF schema)
│   │   │   ├── metadata.rs         # Model metadata exchange
│   │   │   ├── contracting.rs      # Autonomous offer/accept/settle
│   │   │   ├── mcp.rs              # MCP transport binding
│   │   │   ├── swarm.rs            # Swarm formation + coordination
│   │   │   └── onion.rs            # Optional onion routing (v1.1+)
│   │   └── Cargo.toml
│   │   (depends on: aafp-messaging, aafp-identity)
│   │
│   ├── aafp-sdk/                   # High-level SDK for agent developers
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── client.rs           # AAFP client (connect, discover, message)
│   │   │   ├── server.rs           # AAFP server (listen, accept, serve)
│   │   │   ├── builder.rs          # Builder pattern for configuration
│   │   │   └── errors.rs
│   │   └── Cargo.toml
│   │   (depends on: all aafp-* crates)
│   │
│   ├── aafp-cli/                   # Command-line interface
│   │   ├── src/
│   │   │   ├── main.rs
│   │   │   ├── commands/
│   │   │   │   ├── init.rs         # Generate keypair, create config
│   │   │   │   ├── start.rs        # Start AAFP node
│   │   │   │   ├── discover.rs     # Discover agents by capability
│   │   │   │   ├── connect.rs      # Connect to agent
│   │   │   │   ├── send.rs         # Send message
│   │   │   │   ├── status.rs       # Show node status
│   │   │   │   └── relay.rs        # Run relay node
│   │   │   └── config.rs
│   │   └── Cargo.toml
│   │   (depends on: aafp-sdk, clap)
│   │
│   └── aafp-benchmark/             # Benchmarking suite
│       ├── src/
│       │   ├── lib.rs
│       │   ├── handshake.rs        # Handshake throughput (PQ vs classical)
│       │   ├── discovery.rs        # Discovery latency at scale
│       │   ├── messaging.rs        # Message throughput + latency
│       │   ├── nat.rs              # NAT traversal success rate
│       │   └── scale.rs            # 1K → 10K → 100K → 1M agent tests
│       ├── benches/                # Criterion benchmarks
│       └── Cargo.toml
│       (depends on: aafp-sdk, criterion)
│
├── examples/
│   ├── basic_connect.rs            # Two agents connect + message
│   ├── capability_discovery.rs     # Discover agents by capability
│   ├── nat_traversal.rs            # Agents behind NAT connect
│   ├── pubsub_chat.rs              # PubSub-based agent chat
│   ├── ucan_delegation.rs          # UCAN capability delegation
│   └── swarm_coordination.rs       # Multi-agent swarm coordination
│
├── tests/
│   ├── integration/                # Multi-node integration tests
│   ├── e2e/                        # End-to-end testnet tests
│   └── fuzz/                       # Fuzzing targets
│
├── scripts/
│   ├── testnet.sh                  # Spin up local testnet
│   ├── benchmark.sh                # Run benchmark suite
│   └── release.sh                  # Release packaging
│
└── .github/
    └── workflows/
        ├── ci.yml                  # Build + test + lint
        ├── benchmark.yml           # Performance regression
        └── release.yml             # Crate publishing
```

## 5.2 Crate Dependency Graph

```
                    aafp-sdk
                   /    |    \
          aafp-agent  aafp-messaging  aafp-cli
              |       /    |    \
         aafp-identity  aafp-discovery  aafp-nat
              |       /    |        |
          aafp-crypto  aafp-routing  aafp-transport-quic
              |       /              |        |
         aws-lc-rs  aafp-core    quinn    rustls
         liboqs-rust  (forked from libp2p core)
```

## 5.3 Key Design Principles

1. **Crate separation by layer** — each layer is independently compilable and testable
2. **Trait-based abstraction** — `aafp-core` defines traits; other crates implement them
3. **Feature flags for optional components** — `--features semantic, onion, mcp`
4. **No circular dependencies** — dependency graph is a DAG (ironic, given QuDAG)
5. **`aafp-sdk` is the only crate agent developers import** — everything else is internal
6. **`aafp-benchmark` is a first-class crate** — performance is a feature

---

# Phase 6: Build Strategy

## 6.1 Options Analysis

| Option | Description | Effort | Risk | Timeline | Score |
|--------|-------------|--------|------|----------|-------|
| **A: Fork rust-libp2p** | Fork, modify in-place | 12mo | Low | 12mo | 6.15 |
| **B: Build atop rust-libp2p** | Use as dependency, extend | 18mo | Low-Med | 18mo | 6.50 |
| **C: Compatibility layer** | Build AAFP, bridge to libp2p | 24mo | Medium | 24mo | 6.80 |
| **D: Build from scratch** | No libp2p dependency | 30-48mo | High | 30-48mo | 7.35 |

## 6.2 Recommended: **Hybrid B+ (Fork core, build new layers)**

**Strategy:** Fork `libp2p-core` (Transport, Swarm, NetworkBehaviour, ConnectionHandler traits) and `libp2p-yamux`, `libp2p-dcutr`, `libp2p-relay`, `libp2p-identify`, `libp2p-gossipsub` (retain with modifications). Build all new layers (crypto, identity, discovery, messaging, agent semantics) as new crates in the AAFP workspace.

### Why Hybrid B+ (not pure A, B, C, or D)

| Against | Reason |
|---------|--------|
| **Pure A (Fork)** | Inherits task-per-connection, flat Kademlia — can't fix without deep changes |
| **Pure B (Atop)** | Can't replace Noise, PeerId, or connection model as a dependency |
| **C (Compat layer)** | Adds complexity without benefit; AAFP doesn't need libp2p compat |
| **D (From scratch)** | Reimplements DCUtR, Yamux, Swarm — 12+ months wasted on solved problems |

### What We Fork (Retain + Modify)

| Crate | Action | Modifications |
|-------|--------|---------------|
| `libp2p-core` | Fork → `aafp-core` | Replace PeerId with AgentID; modify ConnectionHandler for io_uring |
| `libp2p-yamux` | Fork → use as-is | No changes (TCP fallback only) |
| `libp2p-dcutr` | Fork → `aafp-nat/dcutr` | Scale MaxReservations/MaxCircuits |
| `libp2p-relay` | Fork → `aafp-nat/relay` | Hierarchical relay support |
| `libp2p-identify` | Fork → extend | Add agent metadata (capabilities, model info) |
| `libp2p-gossipsub` | Fork → `aafp-discovery/liveness` | Tune D=22, add capability topics |
| `libp2p-kad` | Fork → **gut and rebuild** | Replace with capability-keyed DHT (keep KBucketsTable) |

### What We Build New

| Crate | Built From Scratch |
|-------|-------------------|
| `aafp-crypto` | PQ handshake, HQRT resumption (new) |
| `aafp-identity` | AgentID, UCAN chains (new) |
| `aafp-transport-quic` | Modified quinn integration (new, but uses quinn) |
| `aafp-discovery` | 5-layer discovery (new, uses KBucketsTable from libp2p) |
| `aafp-routing` | Capability + network proximity routing (new) |
| `aafp-messaging` | RPC framing, datagram support (new, uses QUIC streams) |
| `aafp-agent` | Agent semantics layer (new) |
| `aafp-sdk` | High-level API (new) |
| `aafp-cli` | CLI (new) |
| `aafp-benchmark` | Benchmarking (new) |

### Effort Estimate

| Component | Engineer-Months | Team Size |
|-----------|----------------|-----------|
| Fork + core modifications | 4 | 2 eng × 2mo |
| PQ crypto + handshake | 6 | 1 crypto eng × 6mo |
| AgentID + UCAN | 3 | 1 eng × 3mo |
| QUIC transport + 0-RTT | 4 | 1 eng × 4mo |
| Discovery (5-layer) | 8 | 2 eng × 4mo |
| NAT traversal (DCUtR + QNT) | 4 | 1 eng × 4mo |
| Messaging (streams + RPC + pubsub) | 3 | 1 eng × 3mo |
| Agent semantics (Phase 4) | 6 | 1 eng × 6mo |
| SDK + CLI | 4 | 1 eng × 4mo |
| Benchmarks + tests | 4 | 1 eng × 4mo |
| Spec writing + docs | 4 | 1 eng × 4mo (parallel) |
| Security audit (external) | 2 | External |
| **Total** | **~52 eng-months** | **6-8 engineers × 8-10mo** (parallelized) |

### Risk Estimate

| Risk | Level | Mitigation |
|------|-------|------------|
| PQ handshake integration complexity | Medium | Use rustls+aws-lc-rs (proven PQ path); don't build crypto from scratch |
| libp2p fork divergence | Medium | Regular rebases; contribute generic improvements upstream |
| io_uring scalability unproven at 100K+ | Medium | Fallback to epoll+thread-pool; benchmark early |
| Discovery churn collapse | Medium | Hierarchical containment; CRDT gossip backup; adaptive refresh |
| Team too small | Medium | Prioritize: PQ + discovery + 0-RTT first; agent semantics in v1.1 |
| Security audit finds flaws | Medium | Engage auditor in Phase 3 (not Phase 4); fix-before-release |

### Timeline Estimate

- **MVP (v0.1):** 5 months (2 engineers)
- **Alpha (v0.5):** 12 months (6 engineers)
- **Beta (v0.9):** 18 months (8 engineers)
- **Production (v1.0):** 24 months (8 engineers + external audit)

---

# Phase 7: Critical Unknowns

Ranked by severity (1 = most critical).

## 7.1 Technical Risks

| # | Risk | Severity | Likelihood | Impact | Mitigation |
|---|------|----------|------------|--------|------------|
| 1 | **io_uring doesn't deliver 100K+ connections/agent** | Critical | Medium | High | Benchmark in Phase 3 Month 14; fallback to epoll+thread-pool (proven at 50K) |
| 2 | **PQ handshake integration with quinn is harder than expected** | High | Medium | High | Use rustls TLS path (quinn supports rustls); don't modify quinn internals |
| 3 | **Capability DHT Bloom filters have unacceptable FPR at scale** | High | Medium | Medium | Adaptive Bloom sizing; switch to Cuckoo filters if needed (better delete support) |
| 4 | **Gossipsub D=22 bandwidth explosion** | High | Medium | High | Bandwidth-aware degree selection; adaptive D; topic partitioning by region |
| 5 | **0-RTT replay attacks on non-idempotent agent operations** | High | Low | Critical | Idempotency taxonomy; single-use tickets; nonces; freshness window |

## 7.2 Research Gaps

| # | Gap | Severity | Status | Action |
|---|-----|----------|--------|--------|
| 1 | **Optimal hierarchical clustering topology** | High | Open | Simulation in Phase 2; compare geographic vs network-topological vs capability-based |
| 2 | **PQ 0-RTT replay safety for agent operations** | High | Open | Build idempotency taxonomy in Phase 1; test with agent operation patterns |
| 3 | **Semantic capability matching at scale** | Medium | Open | Research in Phase 4; federated embedding providers; defer to v1.1 if needed |
| 4 | **Reputation cold-start for new agents** | Medium | Open | Vendor attestation + peer sponsorship + proof-of-useful-work; research in Phase 4 |
| 5 | **PQ delegation chain compression** | Medium | Open | Merkle-based chain proofs; research in Phase 2 |

## 7.3 Scalability Concerns

| # | Concern | Severity | Target Scale | Action |
|---|---------|----------|--------------|--------|
| 1 | **DHT churn collapse at second-scale sessions** | Critical | 10⁹ agents | Hierarchical containment; CRDT gossip backup; Bamboo-style adaptive refresh |
| 2 | **Relay infrastructure cost at billion scale** | High | 10⁹ agents | Federated relay model; agents self-host relays; reputation-gated access |
| 3 | **Memory per agent at 100K connections** | High | 100K conn/agent | io_uring (2-5KB/conn) vs task-per-conn (10-50KB/conn); 5-10× reduction needed |
| 4 | **Gossipsub bandwidth at D=22 with 10⁹ agents** | Medium | 10⁹ agents | Topic partitioning; adaptive D; only subscribe to relevant capability topics |
| 5 | **Cross-region latency for inter-cluster DHT** | Medium | Global | Super-peer caching; predictive pre-fetch; regional capability replication |

## 7.4 Cryptographic Concerns

| # | Concern | Severity | Likelihood | Action |
|---|---------|----------|------------|--------|
| 1 | **ML-KEM or ML-DSA lattice break** | Critical | Low | Hybrid mode (X25519+ML-KEM); SLH-DSA-128s for trust anchors; algorithm agility |
| 2 | **PQ side-channel attacks (timing, power)** | High | Low | Constant-time implementations (aws-lc-rs is audited); side-channel testing |
| 3 | **NIST revises PQ parameters** | Medium | Low | Algorithm agility in handshake negotiation; support multiple param sets |
| 4 | **0-RTT forward secrecy compromise** | Medium | Medium | Puncturable PRFs; ticket rotation; limit 0-RTT data to idempotent operations |
| 5 | **PQ signature size (3.3KB ML-DSA-65) bandwidth overhead** | Low | Proven | Cache full pubkeys; use 32B AgentID for routing; exchange full key once |

---

# Phase 8: 24-Month Roadmap

## Phase 1: Architecture (Months 1–3)

| Month | Milestone | Deliverables |
|-------|-----------|--------------|
| 1 | **Foundation** | Fork rust-libp2p; set up CI, fuzzing, benchmarks; write AAFP spec drafts (transport, handshake, identity) |
| 2 | **PQ Crypto** | Implement `aafp-crypto`: X25519MLKEM768 hybrid KEX + ML-DSA-65 signatures via rustls+aws-lc-rs; benchmark vs Noise |
| 3 | **AgentID** | Implement `aafp-identity`: ML-DSA-65 keypair → 32B AgentID; replace PeerId in forked core; integration tests |

**Exit criteria:** PQ handshake works in isolation; AgentID replaces PeerId; benchmarks show <2× overhead vs Noise.

## Phase 2: Prototype (Months 4–6)

| Month | Milestone | Deliverables |
|-------|-----------|--------------|
| 4 | **QUIC Transport** | Implement `aafp-transport-quic`: quinn + rustls PQ config; expose 0-RTT API; connection migration |
| 5 | **Discovery v1** | Implement `aafp-discovery` Layers 1-3: bootstrap (mDNS + seeds), regional clustering, capability-keyed DHT (single region) |
| 6 | **MVP Integration** | Integrate transport + discovery + messaging; CLI (`init`, `start`, `discover`, `connect`, `send`); 100-agent testnet |

**Exit criteria:** 100 agents connect, discover by capability, exchange messages via QUIC streams. **This is AAFP v0.1 (MVP).**

## Phase 3: Alpha (Months 7–12)

| Month | Milestone | Deliverables |
|-------|-----------|--------------|
| 7 | **Gossipsub Liveness** | Implement Layer 4: gossipsub with D=22, capability topics, 1s heartbeat; integrate with discovery |
| 8 | **Hierarchical Clustering** | Implement Layer 2: multi-region clustering; super-peer DHT; RTT-based region assignment |
| 9 | **UCAN Delegation** | Implement UCAN PQ capability chains; delegation, verification, revocation; integration tests |
| 10 | **NAT Traversal v2** | Add QNT (Iroh-style); hierarchical relay infrastructure; UPnP IGD; benchmark NAT success rate |
| 11 | **0-RTT Resumption** | Implement HQRT-style PQ 0-RTT: persistent ticket storage; replay protection; idempotency taxonomy |
| 12 | **Alpha Release** | 10,000-agent testnet; full discovery stack; 0-RTT reconnection; >85% NAT traversal; security audit engagement |

**Exit criteria:** 10K agents, 5-layer discovery, 0-RTT, UCAN delegation, >85% NAT traversal. **This is AAFP v0.5 (Alpha).**

## Phase 4: Beta (Months 13–18)

| Month | Milestone | Deliverables |
|-------|-----------|--------------|
| 13 | **io_uring Integration** | Replace task-per-connection with io_uring (Linux) / kqueue (macOS); benchmark 100K connections |
| 14 | **Connection Scalability** | Optimize memory per connection; target 2-5KB/conn (io_uring) vs 10-50KB (task-per-conn); fallback path |
| 15 | **Capability Advertisement** | Implement OASF-format capability advertisement; vendor-signed VCs; peer attestation |
| 16 | **RPC + PubSub Messaging** | Complete messaging layer: RPC framing, gossipsub pubsub, QUIC datagrams; message validation |
| 17 | **SDK** | Implement `aafp-sdk`: high-level API; builder pattern; error handling; documentation |
| 18 | **Beta Release** | 100,000-agent testnet; io_uring at 100K connections/agent; full messaging; SDK; external security audit |

**Exit criteria:** 100K agents, 100K connections/agent, full messaging stack, SDK, security audit. **This is AAFP v0.9 (Beta).**

## Phase 5: Production Candidate (Months 19–24)

| Month | Milestone | Deliverables |
|-------|-----------|--------------|
| 19 | **Reputation System** | Implement EigenTrust-style distributed reputation; cold-start (vendor attestation + peer sponsorship) |
| 20 | **MCP Transport Binding** | AAFP as MCP transport; agent-to-agent MCP messages; integration with MCP ecosystem |
| 21 | **Autonomous Contracting** | Offer/accept/settle protocol; rUv-style resource exchange (optional); swarm formation |
| 22 | **Audit Fixes + Hardening** | Fix all audit findings; fuzzing campaign; DoS hardening; performance optimization |
| 23 | **1M-Agent Testnet** | Deploy 1M-agent testnet; validate discovery, routing, NAT at scale; benchmark everything |
| 24 | **Production Release** | AAFP v1.0; spec finalized; IETF-style drafts submitted; reference implementations; documentation |

**Exit criteria:** 1M agents, security audit passed, MCP integration, production-ready. **This is AAFP v1.0.**

## Parallel Tracks (Months 1–24)

| Track | Activities | Owner |
|-------|-----------|-------|
| **Spec Writing** | IETF-style drafts for AAFP handshake, discovery, identity, messaging | 1 eng (part-time) |
| **Testnet Operations** | Deploy at 10² → 10³ → 10⁴ → 10⁵ → 10⁶ agents | 1 eng (part-time) |
| **Cross-Language Bindings** | Go and Python bindings via FFI/WASM | 1 eng (Month 12+) |
| **Developer Docs** | API docs, tutorials, examples, architecture guide | 1 eng (part-time) |
| **Community** | Discord/Forum, RFC process, contributor onboarding | Tech lead |

## Roadmap Summary

```
Month  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24
       |--Architecture--|---Prototype---|------Alpha------|------Beta------|--Production--|
       |  PQ  | AgentID | QUIC | Discv | Gossip|Hier|UCAN| io_uring | SDK | Reput|MCP|Audit|1M|
                        v0.1              v0.5              v0.9              v1.0
                        MVP               Alpha             Beta              Production
```

---

# Final Deliverable Summary

## 1. Recommended Architecture

**Architecture B+ (Hybrid Fork):** Fork `libp2p-core` (Transport, Swarm, NetworkBehaviour, ConnectionHandler), `libp2p-yamux`, `libp2p-dcutr`, `libp2p-relay`, `libp2p-identify`, `libp2p-gossipsub`. Replace Noise with PQ hybrid handshake (X25519MLKEM768 + ML-DSA-65). Replace Ed25519 PeerId with ML-DSA-65 AgentID + UCAN chains. Replace flat Kademlia with 5-layer hierarchical capability discovery. Replace task-per-connection with io_uring. Add agent semantics layer (capabilities, MCP, reputation, contracting).

**Weighted score: 7.75/10** (vs 6.15 Conservative, 7.35 Clean-Slate).

## 2. Component Selection Matrix

| Subsystem | Selection | Key Dependency |
|-----------|-----------|----------------|
| Transport | Modified QUIC (quinn + 0-RTT + migration + NAT frames) | quinn, rustls |
| Security | Hybrid TLS (X25519MLKEM768 + ML-DSA-65) + HQRT 0-RTT | rustls, aws-lc-rs, liboqs-rust |
| Identity | ML-DSA-65 → 32B AgentID + UCAN capability chains | liboqs-rust, pqcrypto-mldsa |
| Discovery | 5-layer: bootstrap → regional → capability DHT → gossip → semantic | forked libp2p |
| Messaging | Hybrid: QUIC streams + RPC + gossipsub pubsub | quinn, forked gossipsub |
| NAT | DCUtR + QNT + hierarchical relays (>90% target) | forked libp2p |
| Conn Mgmt | io_uring (Linux) / kqueue (macOS) thread-per-core | tokio-uring, mio |

## 3. Repository Design

10-crate Rust workspace (`aafp-core`, `aafp-crypto`, `aafp-identity`, `aafp-transport-quic`, `aafp-discovery`, `aafp-routing`, `aafp-nat`, `aafp-messaging`, `aafp-agent`, `aafp-sdk`, `aafp-cli`, `aafp-benchmark`) with clean dependency DAG, feature flags, and first-class benchmarking. See Phase 5 for full structure.

## 4. Build Strategy

**Hybrid B+ (Fork core, build new layers).** Fork 6 libp2p crates (retain + modify), build 10 new crates. ~52 engineer-months total. 6-8 engineers × 8-10 months parallelized. MVP in 5 months, Alpha in 12, Beta in 18, Production in 24.

## 5. MVP Definition

**AAFP v0.1 (5 months, 2 engineers):** 1,000 agents, PQ hybrid handshake, capability-keyed DHT (single region), QUIC stream messaging, DCUtR + relay NAT traversal, basic CLI. Excludes: 0-RTT, hierarchical clustering, gossipsub, UCAN, io_uring, agent semantics.

## 6. Risk Analysis

Top 5 risks: (1) io_uring scalability at 100K+ connections [Critical], (2) PQ handshake integration complexity [High], (3) Capability DHT Bloom filter FPR at scale [High], (4) Gossipsub D=22 bandwidth [High], (5) 0-RTT replay safety [High]. All have identified mitigations. See Phase 7 for full analysis.

## 7. 24-Month Roadmap

- **Months 1-3:** Architecture (PQ crypto, AgentID, fork)
- **Months 4-6:** Prototype (QUIC transport, discovery v1, MVP v0.1)
- **Months 7-12:** Alpha (gossipsub, hierarchical clustering, UCAN, NAT v2, 0-RTT, v0.5)
- **Months 13-18:** Beta (io_uring, capability advertisement, messaging, SDK, v0.9)
- **Months 19-24:** Production (reputation, MCP, contracting, audit, 1M testnet, v1.0)

## 8. Implementation Order

1. `aafp-crypto` (PQ handshake) — everything depends on this
2. `aafp-identity` (AgentID + UCAN) — depends on crypto
3. `aafp-core` (fork libp2p-core, replace PeerId) — depends on identity
4. `aafp-transport-quic` (modified quinn) — depends on core + crypto
5. `aafp-discovery` (5-layer) — depends on core + identity
6. `aafp-nat` (DCUtR + QNT) — depends on transport
7. `aafp-messaging` (streams + RPC + pubsub) — depends on transport + discovery
8. `aafp-routing` (capability + proximity) — depends on discovery
9. `aafp-sdk` (high-level API) — depends on all above
10. `aafp-cli` (command-line) — depends on SDK
11. `aafp-agent` (semantics layer) — depends on messaging + identity (Phase 4)
12. `aafp-benchmark` (performance) — depends on SDK (parallel track)

---

## "What would I build on Monday morning if I were the technical founder?"

### Week 1: Prove the hardest unknown first.

**Monday:**
1. `git clone https://github.com/libp2p/rust-libp2p` and fork it.
2. `cargo add rustls --features prefer-post-quantum` and `cargo add aws-lc-rs`.
3. Write a 100-line proof-of-concept: two Rust binaries that establish a QUIC connection using `quinn` + `rustls` with `X25519MLKEM768` hybrid KEX. Verify with packet capture that PQ key exchange is happening.
4. Benchmark: measure handshake time (PQ hybrid vs. classical X25519) and bandwidth overhead.

**Tuesday:**
1. Generate an ML-DSA-65 keypair using `liboqs-rust`.
2. Compute `AgentID = SHA-256(ml_dsa_65_pubkey)`.
3. Write a test: AgentID derivation, verification, and serialization.
4. This proves the identity layer works in isolation.

**Wednesday:**
1. Take the forked `libp2p-core`. Replace the `PeerId` struct with `AgentId` (same structure, different key type).
2. Get the forked code to compile. This is the hardest integration step — it touches every crate in libp2p.
3. Run existing libp2p tests with the new AgentId. Fix breakages.

**Thursday:**
1. Implement the PQ handshake: replace `noise::Config` with a new `aafp_crypto::PqHandshake` that uses rustls's `X25519MLKEM768` KEX + ML-DSA-65 signatures.
2. Wire it into the `SwarmBuilder::with_tcp` / `with_quic` upgrade pipeline.
3. Two nodes connect with PQ handshake. Verify with packet capture.

**Friday:**
1. Write a simple capability-keyed DHT: `key = SHA-256("capability.inference")`, `value = [AgentID, AgentID, ...]`.
2. Two agents advertise capabilities, third discovers them by capability (not by ID).
3. This proves the core innovation: **discovery by capability, not by peer ID**.

### What you've proven by Friday:

| Proven | What it means |
|--------|---------------|
| PQ hybrid handshake works with quinn+rustls | The security layer is feasible |
| ML-DSA-65 AgentID works | The identity layer is feasible |
| Forked libp2p compiles with new AgentId | The fork strategy is feasible |
| PQ handshake integrates into SwarmBuilder | The transport+security integration works |
| Capability-keyed DHT works | The core innovation is feasible |

### What you build in Week 2:

1. Wrap the proof-of-concept into proper crates (`aafp-core`, `aafp-crypto`, `aafp-identity`).
2. Set up CI, fuzzing, benchmarks.
3. Write the first spec draft (`aafp-handshake.md`).
4. Recruit the team (if not already assembled).

### The single most important thing:

**Prove that capability-keyed discovery works.** This is the one thing that no existing system does. If you can discover agents by what they can do (not by who they are), you have a product. Everything else — PQ, 0-RTT, io_uring, UCAN — is important but derivative. Capability discovery is the wedge.

---

*End of AAFP Architecture Deliverable. Ready for implementation.*
