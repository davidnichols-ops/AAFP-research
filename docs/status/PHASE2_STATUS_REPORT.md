# AAFP Phase 2 Status Assessment & Roadmap

**Date:** 2026-06-28
**Assessment baseline:** `v0.3-phase3-snapshot`
**Assessor:** Engineering review (Devin)
**Repository structure:**
- Umbrella: `github.com/davidnichols-ops/AAFP-research` (private)
- Rust reference: `github.com/davidnichols-ops/aafp` (private, submodule)
- Go independent: `github.com/davidnichols-ops/aafp-go` (private, submodule)

---

## 1. Current Functionality

### 1.1 Transport (QUIC + PQ TLS)

**Status:** Functional Prototype
**Maturity:** Works for localhost single-connection scenarios; not validated under load, NAT, or real networks.

**What works:**
- QUIC transport via `quinn` 0.11 with `rustls` 0.23 + `aws-lc-rs` backend
- X25519MLKEM768 hybrid post-quantum key exchange (prefer-post-quantum feature)
- Self-signed Ed25519 certificates (TOFU model) for TLS layer
- Bidirectional and unidirectional stream opening
- Connection accept/dial on bound socket
- Multiaddr format: `quic://IP:PORT`

**Current limitations:**
- No 0-RTT resumption (quinn's 0-RTT API not exposed)
- No connection migration (QUIC CID-based migration not utilized)
- No NAT traversal extension frames (OBSERVED_ADDRESS, ADD_ADDRESS, PUNCH_ME_NOW)
- TLS certificates use Ed25519, not ML-DSA-65 (rustls doesn't support ML-DSA-65 cert verification yet)
- Agent identity is verified at application layer, not TLS layer — meaning TLS auth and AAFP auth are decoupled
- No pure-PQ mode (ML-KEM-768 only); always hybrid
- `QuicSendStream::finish()` and `reset()` return values are silently dropped (compiler warnings)
- No connection pooling, keep-alive is configured but not validated
- Default config: `max_concurrent_streams=100`, `keep_alive_interval=30s`, `bind_addr=127.0.0.1:0`

### 1.2 Authentication (Post-Quantum Handshake)

**Status:** Functional Prototype
**Maturity:** Cryptographic primitives are production-grade; handshake state machine is not implemented.

**What works:**
- ML-DSA-65 (FIPS 204) signature generation and verification via `pqcrypto-mldsa`
  - Public key: 1952 bytes, Secret key: 4032 bytes, Signature: 3309 bytes
  - Sign: ~77.7µs, Verify: ~24.4µs (measured on ARM64)
- X25519 KEM (standalone, for testing) via `x25519-dalek`
- AEAD: ChaCha20-Poly1305 (default) and AES-256-GCM
  - 12-byte nonce, 32-byte key
- HKDF-SHA256 key derivation
- Application-layer handshake message structures (ClientHello, ServerHello, ClientFinished)
  - CBOR encoding/decoding of all handshake messages
  - Transcript hash computation (SHA-256 chain from TLS binding)
  - Session ID derivation (HKDF-SHA256)
  - Receiver MAC computation/verification (HMAC-SHA256 for DoS protection)
- Signature input construction (domain separator + transcript hash)

**Current limitations:**
- **No handshake state machine.** The `PqHandshake` struct provides `client_init()`, `server_handle()`, `client_finish()` methods, but these are not wired into the transport layer. The SDK's `AgentClient::connect()` derives the AgentId from the remote address, not from a handshake exchange.
- **No live handshake over QUIC.** The handshake exists as data structures and unit tests, but no connection actually performs the 3-way handshake over the wire.
- **Two parallel handshake implementations:** `handshake.rs` (X25519-based, standalone) and `handshake_v1.rs` (RFC-compliant, CBOR-based). Only `handshake_v1.rs` is RFC-compliant; `handshake.rs` appears to be an earlier prototype.
- `ClientState` and `ServerState` in `handshake.rs` have unused fields (dead code)
- No replay protection for 0-RTT (not implemented since 0-RTT doesn't exist)
- No downgrade detection (ALPN-based version negotiation not implemented)

### 1.3 Identity

**Status:** Stable MVP
**Maturity:** Core identity primitives are well-specified and tested. UCAN delegation works but is not integrated with the transport.

**What works:**
- AgentId: `SHA-256(ML-DSA-65 public_key)` = 32 bytes
  - Derivation, hex encoding/decoding, fingerprint format (`AAFP-<base32>-<crc32>`)
  - Constant-time comparison (Go impl)
- AgentKeypair: ML-DSA-65 keypair generation, serialization, signing, verification
  - Serialization format: `u32::BE(secret_len) || secret || public`
- AgentRecord (v1): self-signed CBOR record
  - Fields: record_type, agent_id, public_key, capabilities, endpoints, created_at, expires_at, signature, key_algorithm
  - CBOR encoding with integer keys (1-9)
  - Signature over `to_cbor_without_sig()` with domain separator `"aafp-v1-record"`
  - Verification: agent_id matches public_key, record_type correct, key_algorithm correct, not expired, signature valid
  - `exceeds_max_expiry_warning(now)` — deployment warning predicate (not verification rejection, per RFC Rev 5)
- CapabilityDescriptor: name + metadata map (string-keyed)
  - Metadata (key 2) always present, even when empty (per RFC Rev 4 / SA-0001)
- UCAN delegation tokens: JWT-style capability chains
  - `delegate()` for root tokens, `delegate_with_proof()` for chained tokens
  - `verify_chain()` validates: root signature, each link signed by previous audience, capabilities don't expand, no expired tokens, chain links via `prf` field
  - Capabilities: resource + action + optional constraints

**Current limitations:**
- Two `AgentRecord` implementations exist: `agent_record.rs` (simpler, uses `Vec<String>` for capabilities) and `identity_v1.rs` (RFC-compliant, uses `CapabilityDescriptor`). The simpler one is used by the SDK; the RFC-compliant one is used by conformance tests. This is a significant inconsistency.
- Two `AgentId` types exist: `agent_id.rs` defines `AgentId = [u8; 32]` (type alias), `identity_v1.rs` defines `AgentId(pub [u8; 32])` (newtype struct). Different modules use different definitions.
- UCAN tokens are not transmitted over the wire — no protocol message carries them
- No UCAN verification on incoming connections (authorization not enforced)
- No key rotation or key revocation mechanism
- No DID integration (design mentions it, not implemented)
- No reputation system

### 1.4 Messaging

**Status:** Functional Prototype
**Maturity:** Frame encoding/decoding is well-specified and hardened. RPC and PubSub are in-memory stubs.

**What works:**
- Frame encoding/decoding (RFC-0002 §3-4)
  - 28-byte header: version, type, flags, reserved, stream_id(8B), payload_len(8B), ext_len(8B)
  - Frame types: DATA=0x01, HANDSHAKE=0x02, RPC_REQUEST=0x03, RPC_RESPONSE=0x04, CLOSE=0x05, ERROR=0x06, PING=0x07, PONG=0x08
  - Unknown frame types: `FrameType::Unknown(u8)` — critical bit determines reject vs skip (IMPL-0001 fix)
  - Max payload: 1 MiB
  - `FrameCodec` implements `tokio_util::codec::Encoder/Decoder` for async I/O
  - Integer overflow protection (checked_add)
- Frame extensions (RFC-0002 §6.1)
  - 8-byte header per extension: type(2B), critical(1B), reserved(1B), data_len(4B)
  - `find_unknown_critical()` for extension validation
- RPC v1 messages (RFC-0002 §4.3-4.4)
  - `RpcRequest`: id, method, params (CBOR Value)
  - `RpcResponse`: id, result, error (with code, message, data)
  - `CloseMessage`, `ErrorMessage`
  - Canonical CBOR with integer keys
- Stream multiplexing
  - `MessageStream`: per-stream AEAD encryption
  - `StreamManager`: tracks active streams by ID

**Current limitations:**
- **PubSub is in-memory only.** `PubSub` struct uses `tokio::sync::broadcast` channels — no gossipsub, no network propagation. Production would need gossipsub over QUIC.
- **RPC dispatch not implemented.** `RpcServer` has a handler registry but it's not wired to incoming QUIC streams. `RpcClient` creates requests but has no transport to send them on.
- **No message routing.** Messages go directly peer-to-peer; no relay routing, no capability-based routing.
- **No backpressure mechanism** beyond QUIC's built-in flow control
- **No compression** (COMPRESSED flag defined but not implemented)
- Frame header comment says "24 bytes" but actual size is 28 bytes (misleading comment)
- `rpc.rs` (older, JSON-based) and `rpc_v1.rs` (RFC-compliant, CBOR-based) both exist — `rpc.rs` should be removed
- `stream.rs` has many unused imports (dead code)

### 1.5 Discovery

**Status:** Functional Prototype
**Maturity:** Data structures and local indexing work. No distributed DHT, no network discovery.

**What works:**
- CapabilityDht (in-memory)
  - Key: `SHA-256(capability_string)` = 32 bytes
  - Index: capability → list of AgentRecords
  - `put()`, `get()`, `get_any()`, `get_all()`, `remove_agent()`
  - Agent capability tracking
- Bootstrap discovery
  - Seed node configuration
  - `add_default_seeds()` adds 3 hardcoded seed nodes
  - `is_complete()` checks min_peers threshold
- Regional discovery
  - Latency-based region assignment (0-50ms: UsEast, 51-100ms: UsWest, etc.)
  - `find_closest()` returns nearest agents by region
- Discovery v1 RPC structures (RFC-0004)
  - `AnnounceParams`, `AnnounceResult`, `LookupParams`, `LookupResult`
  - Method names: `aafp.discovery.announce`, `aafp.discovery.lookup`
  - Rate limits: 60s for announce and lookup
  - Default limits: unauth=5, auth=10, max_records=100,000

**Current limitations:**
- **No distributed DHT.** The `CapabilityDht` is a local `HashMap`. No Kademlia RPCs, no network queries, no routing table, no k-buckets.
- **No gossipsub liveness layer.** No heartbeat, no presence, no capability update propagation.
- **No hierarchical regional clustering.** The `RegionalDiscovery` is a local map; no inter-cluster super-peer DHT.
- **No bootstrap network protocol.** `BootstrapDiscovery` tracks discovered records but doesn't actually connect to seed nodes or query them.
- **Discovery v1 has two DHT implementations:** `capability_dht.rs` (simpler) and `discovery_v1.rs` (RFC-compliant with `SharedCapabilityDht`). The SDK uses the simpler one.
- **No semantic vector index** (correctly deferred — this is a v1.1+ feature)

### 1.6 NAT Traversal

**Status:** Not Started (stub only)
**Maturity:** Data structures exist; no protocol implementation.

**What works:**
- AutoNAT: `NatStatus` enum (Public/Private/Unknown), `DialBackResult` tracking, `success_rate()` calculation
- DCuTR: `UpgradeResult` tracking, `success_rate()` calculation
- Relay: `RelayNode` configuration, `RelayService` with relay selection, relayed agent tracking
- Relay multiaddr format: `quic://relay_addr/p2p/relay_agent_id/p2p-circuit/target_agent_id`

**Current limitations:**
- **All three components are stubs.** No actual NAT probing, no hole punching, no relay protocol. They track state but don't perform network operations.
- No DCUtR protocol implementation
- No Relay v2 protocol implementation
- No AutoNAT dial-back protocol
- No Iroh-style QNT (QUIC NAT Traversal)
- No STUN/TURN integration
- This is the least mature subsystem in the project.

### 1.7 SDK

**Status:** Functional Prototype
**Maturity:** Provides a usable API for basic agent-to-agent communication. Not production-ready.

**What works:**
- `AgentBuilder`: fluent builder for agent configuration
  - `with_keypair()`, `with_capabilities()`, `bind()`, `with_seeds()`, `as_relay()`, `with_pq()`
  - `build()` creates an `Agent` with all subsystems initialized
- `Agent`: holds keypair, transport, discovery, NAT, pubsub, running state
  - Query methods: `id()`, `capabilities()`, `multiaddr()`, `nat_status()`, `discovered_agents()`, `find_by_capability()`
- `AgentClient`: connect to peers, send data, send-and-receive
  - `connect()`, `send()`, `send_and_receive()`, `disconnect()`
  - Connection tracking: `connection_count()`, `connected_peers()`, `is_connected()`
- `AgentServer`: accept incoming connections
  - `start()`, `stop()`, `accept_one()`
  - **Echo handler only** — reads a single framed message and echoes it back

**Current limitations:**
- **Server is echo-only.** No handshake, no capability negotiation, no RPC dispatch, no message routing.
- **Client derives AgentId from remote address**, not from handshake identity verification. This is explicitly noted as MVP behavior.
- **No connection lifecycle management.** No reconnection, no connection pooling, no keep-alive validation.
- **No event system.** No way to subscribe to incoming messages, capability updates, or peer events.
- Uses the simpler `AgentRecord` (from `agent_record.rs`), not the RFC-compliant one (from `identity_v1.rs`)

### 1.8 CLI

**Status:** Functional Prototype
**Maturity:** Commands work for basic operations. Not user-friendly, no persistent state.

**Commands:**
- `init`: Generate ML-DSA-65 keypair, save to file, print Agent ID
- `start`: Load keypair, build agent, start server, accept connections
- `discover`: Load keypair, search DHT for capability
- `connect`: Load keypair, connect to peer, print peer ID
- `send`: Load keypair, connect to peer, send message
- `status`: Load keypair, print Agent ID, key sizes, verify keypair
- `relay`: Generate keypair, build relay agent, start server

**Current limitations:**
- No persistent node state (DHT contents, connections, discovery results not persisted)
- No interactive mode
- No configuration file support
- No logging configuration
- Default identity file: `aafp-identity.bin`
- Default bind: `127.0.0.1:4433` (start), `127.0.0.1:4434` (relay)

### 1.9 Testing

**Status:** Stable MVP
**Maturity:** Comprehensive test coverage for protocol layers; limited end-to-end coverage.

**Test counts (verified):**
- **461 tests, 0 failures, 29 test suites** (Rust workspace)
- **138+ tests** (Go implementation)
- **Total: ~600 tests across both implementations**

**Test breakdown (Rust):**

| Crate | Tests | Type |
|-------|-------|------|
| aafp-cbor | ~20 | Unit (CBOR encoding/decoding) |
| aafp-core | 8 | Unit (error codes, traits) |
| aafp-crypto | 33 + 44 | Unit + comprehensive crypto tests |
| aafp-identity | 36 | Unit (AgentId, AgentRecord, UCAN) |
| aafp-messaging | 47 | Unit (framing, RPC, extensions) |
| aafp-discovery | 29 | Unit (DHT, regional, bootstrap) |
| aafp-nat | 13 | Unit (AutoNAT, DCuTR, relay) |
| aafp-transport-quic | 5 | Unit (QUIC transport) |
| aafp-sdk | 8 | Unit (builder, client, server) |
| aafp-conformance | ~200 | Conformance (RFC-0002 through RFC-0005, negative, version negotiation) |
| aafp-tests | 8 | Integration (multi-agent, QUIC, DHT, UCAN, regional, NAT) |

**Test breakdown (Go):**

| Category | Tests |
|----------|-------|
| Test vector reproduction | 48 |
| Interop decode (Rust fixtures) | 34 |
| Golden trace verification | 8 |
| Version negotiation | 33 |
| RFC Rev 4/5 conformance | 10 |
| Race stress | 7 |

**Test quality:**
- Conformance tests map directly to RFC normative requirements (315 total requirements tracked in COMPLIANCE_MATRIX.md)
- Negative conformance tests verify rejection of malformed/adversarial inputs (54 tests)
- Fuzzing: 5 targets, ~10.5M iterations, 0 crashes after fixes
  - Bugs found and fixed: CBOR OOM, CBOR integer overflow, frame integer overflow
- Golden wire traces: 9 scenarios (successful handshake, unknown critical/non-critical extension, version mismatch, invalid signature, oversized frame, RPC exchange, error exchange, discovery announce)
- Cross-implementation interop: 73 Rust→Go + 39 Go→Rust tests, byte-for-byte identical round-trips

**Current limitations:**
- No network-level integration tests (all QUIC tests are localhost)
- No performance regression tests (benchmarks exist but not run in CI)
- No multi-node testnet (integration tests use 10 agents, not 1000)
- No continuous fuzzing (one-time runs only)
- No Miri or UBSan runs (only AddressSanitizer in fuzzing)
- Go implementation lacks ML-DSA-65 signature tests (no PQ crypto in Go)

### 1.10 Interoperability

**Status:** Stable MVP (wire-format level)
**Maturity:** Bidirectional wire-format interop proven. No transport-level or signature-level interop.

**What's verified:**
- CBOR canonical encoding: 16 fixtures, byte-for-byte identical across implementations
- Frame encoding: 6 fixtures, byte-for-byte identical
- Handshake message CBOR: ClientHello, ServerHello, ClientFinished — decode and re-encode matches
- AgentRecord CBOR: 3 fixtures, byte-for-byte identical
- RPC message CBOR: 6 fixtures, byte-for-byte identical
- Transcript hash computation: matches at all 4 stages
- Session ID derivation: HKDF-SHA256 output matches
- AgentId derivation: SHA-256(public_key) matches

**What's NOT verified:**
- Cross-signature verification (Go has no ML-DSA-65 implementation)
- Live QUIC transport interop (no live connection between implementations)
- Discovery protocol interop (Go has no discovery implementation)
- Error handling interop (Go has error codes but no error frame exchange)

### 1.11 Cryptography

**Status:** Functional Prototype → Production (mixed)
**Maturity:** Primitives are production-grade; integration is prototype-level.

**What's production-grade:**
- ML-DSA-65 via `pqcrypto-mldsa` (FIPS 204 compliant, PQClean backend)
- AEAD: ChaCha20-Poly1305 and AES-256-GCM (RustCrypto implementations)
- HKDF-SHA256, HMAC-SHA256 (RustCrypto)
- X25519 via `x25519-dalek`
- TLS 1.3 with X25519MLKEM768 via `rustls` + `aws-lc-rs` (production path)

**What's prototype-level:**
- Application-layer handshake not wired into transport
- No 0-RTT resumption
- No replay protection

**Critical issue:**
- `pqcrypto-mldsa` is **unmaintained** (RUSTSEC-2026-0162/0163/0166, June 2026). The repository is archived. Migration to `aws-lc-rs` ML-DSA, `fips204` crate, or vendored PQClean is required before release. This is a **release blocker**.

---

## 2. Current Architecture

### 2.1 Crate Responsibilities

| Crate | Responsibility | LOC (approx) | Depends On |
|-------|---------------|-------------|------------|
| `aafp-cbor` | Canonical CBOR encoder/decoder | ~500 | thiserror |
| `aafp-core` | Transport/Connection/Stream/Swarm traits, error codes | ~400 | aafp-identity |
| `aafp-crypto` | ML-DSA-65, AEAD, HKDF, KEM, handshake structures | ~1500 | aafp-cbor, pqcrypto, rustls, RustCrypto |
| `aafp-identity` | AgentId, AgentKeypair, AgentRecord, UCAN | ~1200 | aafp-cbor, aafp-crypto |
| `aafp-messaging` | Framing, streams, RPC, pubsub, extensions | ~1500 | aafp-cbor, aafp-core, aafp-crypto, aafp-identity |
| `aafp-discovery` | Bootstrap, regional, capability DHT | ~800 | aafp-cbor, aafp-core, aafp-identity |
| `aafp-transport-quic` | QUIC transport with PQ TLS | ~600 | aafp-core, aafp-crypto, quinn, rustls |
| `aafp-nat` | AutoNAT, DCuTR, relay (stubs) | ~500 | aafp-core, aafp-identity |
| `aafp-sdk` | High-level agent API, builder, client, server | ~600 | all protocol crates |
| `aafp-cli` | Command-line interface | ~400 | aafp-sdk |
| `aafp-conformance` | RFC conformance tests, test vectors, golden traces | ~3000 | all protocol crates |
| `aafp-benchmark` | Criterion benchmarks | ~300 | aafp-crypto, aafp-discovery, aafp-messaging |
| `aafp-tests` | Integration tests | ~300 | aafp-sdk |

### 2.2 Dependency Graph

```
                    aafp-cli
                       |
                    aafp-sdk
                   /    |    \
     aafp-messaging  aafp-discovery  aafp-transport-quic
        /    |    \      /    \          |
  aafp-cbor aafp-core  aafp-identity  aafp-crypto
        \    |    /      /    \          |
         aafp-cbor  aafp-crypto      aafp-cbor
                       |
              pqcrypto-mldsa, rustls, aws-lc-rs,
              chacha20poly1305, aes-gcm, sha2, hkdf, hmac,
              x25519-dalek, rand
```

**Key observations:**
- `aafp-core` depends on `aafp-identity` (for `AgentId`) — this creates a coupling where the core networking traits depend on the identity layer. In libp2p, `PeerId` is in `libp2p-core` itself. This is a minor architectural concern.
- `aafp-cbor` is the foundation — everything depends on it.
- `aafp-conformance` depends on all protocol crates — it's the integration point for testing.
- No circular dependencies (verified: dependency graph is a DAG).

### 2.3 Layer Boundaries

```
Layer 9: CLI (aafp-cli)
    ↓
Layer 8: SDK (aafp-sdk) — AgentBuilder, AgentClient, AgentServer
    ↓
Layer 7: Messaging (aafp-messaging) — Framing, RPC, PubSub, Streams
Layer 6: Discovery (aafp-discovery) — DHT, Regional, Bootstrap
Layer 5: NAT (aafp-nat) — AutoNAT, DCuTR, Relay
    ↓
Layer 4: Transport (aafp-transport-quic) — QUIC + PQ TLS
    ↓
Layer 3: Identity (aafp-identity) — AgentId, AgentRecord, UCAN
Layer 2: Crypto (aafp-crypto) — ML-DSA-65, AEAD, HKDF, Handshake
    ↓
Layer 1: Core (aafp-core) — Transport/Connection/Stream/Swarm traits
Layer 0: CBOR (aafp-cbor) — Canonical CBOR encoding
```

### 2.4 Public API Summary

**aafp-cbor:** `Value` enum, `encode()`, `decode()`, `int_map()`, `int_map_get()`
**aafp-core:** `Transport`, `Connection`, `Stream` traits; `Swarm`, `NetworkBehaviour`, `ConnectionHandler` traits; `ProtocolError`, error codes
**aafp-crypto:** `MlDsa65`, `Aead`, `HybridKem`, `X25519Kem`, `PqHandshake`, `HandshakeResult`, `ClientHello`, `ServerHello`, `ClientFinished`, `TranscriptHash`
**aafp-identity:** `AgentId`, `AgentKeypair`, `AgentRecord`, `CapabilityDescriptor`, `UcanToken`, `Capability`
**aafp-messaging:** `Frame`, `FrameType`, `FrameCodec`, `encode_frame()`, `decode_frame()`, `Extension`, `RpcRequest`, `RpcResponse`, `MessageStream`, `StreamManager`, `PubSub`
**aafp-discovery:** `CapabilityDht`, `RegionalDiscovery`, `BootstrapDiscovery`, `AnnounceParams`, `LookupParams`
**aafp-transport-quic:** `QuicTransport`, `QuicConnection`, `QuicSendStream`, `QuicRecvStream`, `QuicConfig`
**aafp-nat:** `AutoNat`, `Dcutr`, `RelayService`, `NatStatus`
**aafp-sdk:** `Agent`, `AgentBuilder`, `AgentClient`, `AgentServer`
**aafp-cli:** Commands: `init`, `start`, `discover`, `connect`, `send`, `status`, `relay`

### 2.5 Protocol Flow (Current)

**Connection establishment (current MVP):**
```
1. Agent A calls AgentClient::connect(agent, addr)
2. QuicTransport::dial(addr) → QuicConnection
   (TLS 1.3 with X25519MLKEM768 happens here, transparent to AAFP)
3. AgentId derived from remote address (NOT from handshake)
4. Connection stored in AgentClient's connection map
5. Agent A can now send() data frames
```

**Connection acceptance (current MVP):**
```
1. Agent B calls AgentServer::start(agent)
2. QuicTransport::accept() → QuicConnection
3. AgentServer::accept_one(agent)
4. Opens bidirectional stream
5. Reads single framed message
6. Echoes message back
7. Closes stream
```

**What SHOULD happen (per RFCs, not yet implemented):**
```
1. QUIC connection established (TLS 1.3 with X25519MLKEM768)
2. Open stream 0 (handshake stream)
3. Client sends ClientHello frame (HANDSHAKE type, stream 0)
   - Contains: protocol_version, agent_id, public_key, nonce, capabilities, extensions, expires_at, key_algorithm
4. Server verifies ClientHello, sends ServerHello frame
   - Contains: protocol_version, agent_id, public_key, nonce, capabilities, extensions, session_id, expires_at, key_algorithm
5. Client verifies ServerHello, sends ClientFinished frame
   - Contains: session_id, signature over transcript
6. Both sides derive shared session keys from transcript hash
7. Application data flows on streams > 0 with AEAD encryption
```

### 2.6 Abstraction Quality

**Strong abstractions:**
- `aafp-cbor`: Clean, self-contained, no external dependencies beyond `thiserror`. Well-tested.
- Frame encoding/decoding: Clean separation of wire format from transport. `FrameCodec` integrates with tokio's codec framework.
- Error code system: Well-structured, RFC-mapped, category-based. `is_always_fatal()` logic is clear.
- CBOR Value type: Supports both int-keyed and string-keyed maps, matching the protocol's needs.

**Where implementation details leak:**
- **AgentId duality**: `[u8; 32]` (type alias in `agent_id.rs`) vs `AgentId(pub [u8; 32])` (newtype in `identity_v1.rs`). The SDK uses the alias; conformance tests use the newtype. Code that works with one doesn't work with the other without conversion.
- **AgentRecord duality**: `agent_record.rs` (simpler, `Vec<String>` capabilities) vs `identity_v1.rs` (RFC-compliant, `CapabilityDescriptor`). The SDK uses the simpler one, meaning SDK-produced records are NOT RFC-compliant.
- **RPC duality**: `rpc.rs` (JSON-based, older) vs `rpc_v1.rs` (CBOR-based, RFC-compliant). Both exported.
- **Handshake duality**: `handshake.rs` (X25519 standalone) vs `handshake_v1.rs` (RFC-compliant CBOR). Both exported.
- **Transport trait not used**: `aafp-core` defines `Transport`, `Connection`, `Stream` traits, but `aafp-transport-quic` doesn't implement them — it has its own `QuicTransport` struct with a different API. The `Swarm` and `NetworkBehaviour` traits are defined but unused.
- **Core crate's traits are aspirational**: The `Swarm`/`NetworkBehaviour`/`ConnectionHandler` model from libp2p is defined but nothing uses it. The SDK drives connections directly.

---

## 3. Protocol Maturity

### 3.1 What Is Specified (RFCs)

**6 RFCs, 3,968 total lines, Revision 5:**

| RFC | Lines | Title | Revision |
|-----|-------|-------|----------|
| 0001 | 427 | Protocol Overview, Goals, and Layer Architecture | Rev 5 |
| 0002 | 1,099 | Transport, Framing, Stream Multiplexing, and Wire Format | Rev 5 |
| 0003 | 990 | Agent Identity, AgentRecord, Capability Descriptors, Authorization, and Session Lifecycle | Rev 5 |
| 0004 | 458 | Discovery: Identity, Capability, Service, and Resource | Rev 5 |
| 0005 | 456 | Protocol Error Codes, Error Frames, and Error Handling | Rev 5 |
| 0006 | 538 | Versioning and Compatibility | Rev 5 |

**Plus 456 lines of RFC_CHANGELOG.md tracking all amendments.**

**What the RFCs well-specify:**
- Frame wire format (28-byte header, field offsets, types, flags)
- CBOR canonical encoding rules (length-first key ordering, shortest integers, no indefinite-length)
- Handshake message CBOR schemas (integer keys 1-10 for ClientHello/ServerHello, 1-2 for ClientFinished)
- Transcript hash algorithm (SHA-256 chain from TLS binding)
- Session ID derivation (HKDF-SHA256)
- AgentId derivation (SHA-256 of public key)
- AgentRecord CBOR schema (integer keys 1-9)
- CapabilityDescriptor format (metadata always present, SA-0001)
- Error code categories and specific codes
- Always-fatal error codes
- Version negotiation behavior (no in-band downgrade, all non-v1 rejected)
- Extension criticality (critical bit → reject, non-critical → skip)
- Frame type criticality (same rules)
- Discovery RPC method names and parameter schemas
- Rate limits and record limits
- 30-day expiry as deployment warning (SA-0003)

### 3.2 What Is Implemented But Not Specified

- **AgentKeypair serialization format**: `u32::BE(secret_len) || secret || public` — this is an implementation choice, not in any RFC. If a second implementation needs to read identity files, they'd have to reverse-engineer this format.
- **Frame codec integration with tokio**: `FrameCodec` implementing `Encoder/Decoder` is an implementation detail, not a protocol concern (correct).
- **`from_bytes()` / `to_bytes()` methods on AgentRecord**: These are convenience methods that delegate to CBOR encoding. The RFC specifies the CBOR schema but not these specific method signatures (correct — these are implementation choices).
- **QuicConfig defaults**: `max_concurrent_streams=100`, `keep_alive_interval=30s` — not specified in RFCs. These are reasonable defaults but should be documented as recommendations.
- **TLS certificate model**: Self-signed Ed25519 with TOFU is an implementation choice. The RFC mentions TLS but doesn't specify the certificate model. This is a gap — the trust model should be specified.

### 3.3 What Is Specified But Not Implemented

- **Handshake state machine**: RFC-0002 §5 specifies the 3-way handshake (ClientHello → ServerHello → ClientFinished), transcript hash, session ID derivation, and signature verification. The data structures exist but the state machine that drives them over a QUIC connection is not implemented.
- **Stream 0 as handshake stream**: RFC-0002 §5.1 specifies that the handshake occurs on stream 0. No implementation enforces this.
- **AEAD encryption of application data**: RFC-0002 specifies that application data on streams > 0 is AEAD-encrypted with session-derived keys. The `MessageStream` struct has AEAD methods but no code actually encrypts stream data after a handshake.
- **Session lifecycle**: RFC-0003 §7 specifies session establishment, session resumption, and session termination. None of these are implemented as protocol-level state machines.
- **UCAN authorization enforcement**: RFC-0003 §6 specifies UCAN capability verification for incoming requests. No implementation verifies UCAN tokens on incoming connections.
- **Discovery RPC over network**: RFC-0004 specifies announce and lookup RPCs. The message structures exist but no implementation sends or receives them over QUIC.
- **Error frame exchange**: RFC-0005 specifies ERROR frames with code, message, and data. The `ProtocolError` struct exists but no implementation sends ERROR frames in response to protocol violations.
- **Close handshake**: RFC-0002 §4.5 specifies CLOSE frames for graceful connection termination. No implementation sends CLOSE frames.
- **PING/PONG keep-alive**: Frame types defined but no implementation sends or responds to PING/PONG.
- **Extension negotiation in handshake**: RFC-0002 §6.4 specifies handshake extensions (ExtensionEntry). The CBOR structures exist but no implementation processes extensions during handshake.

### 3.4 Implicit Assumptions

- **Assumption: QUIC provides adequate stream multiplexing.** The protocol assumes QUIC bidirectional streams map directly to AAFP logical streams. No yamux fallback is implemented despite being mentioned in the architecture.
- **Assumption: TLS channel binding is available.** The transcript hash is seeded from a TLS channel binding value (`tls_binding`). The code uses a placeholder `[u8; 32]` in tests. The actual extraction of channel binding from rustls/quinn is not implemented.
- **Assumption: AgentId can be derived from remote address.** The SDK's `AgentClient::connect()` derives the peer's AgentId from the remote address, not from a handshake. This is explicitly noted as MVP behavior and is a security gap.
- **Assumption: All peers are honest.** No protocol-level verification of peer identity, capabilities, or authorization is performed on incoming connections.
- **Assumption: CBOR encoding is canonical.** The implementation enforces canonical encoding on encode but only partially validates it on decode (non-shortest integers are rejected, but map key ordering is not validated on decode).

### 3.5 Extension Points

**Well-defined extension points:**
- Frame extensions: 8-byte header with type/critical/data. New extension types can be added without protocol changes. Critical bit ensures backward compatibility.
- Handshake extensions: ExtensionEntry CBOR map with type/data/critical. Same criticality semantics.
- Frame types: `Unknown(u8)` variant allows future frame types. Critical bit determines reject vs skip.
- Error codes: Categorized by thousands digit. Application-specific codes (9xxx) are available.
- Capability descriptors: Metadata map allows arbitrary key-value pairs.

**Under-specified extension points:**
- No extension registry (RFC-0006 mentions a registry but doesn't define one)
- No algorithm agility for crypto (only ML-DSA-65 = 1 defined; no negotiation for alternatives)
- No capability versioning scheme (CapabilityDescriptor has optional `version` field but no negotiation rules)

---

## 4. Known Gaps

### 4.1 Core Protocol

- **No handshake state machine.** The 3-way handshake (ClientHello → ServerHello → ClientFinished) is specified in RFC-0002 §5 and the data structures exist, but no code performs the handshake over a QUIC connection. This is the single most critical gap.
- **No session key derivation from handshake.** The handshake produces a transcript hash and session ID, but no code derives AEAD keys from the handshake result and applies them to application streams.
- **No TLS channel binding extraction.** The transcript hash requires a TLS channel binding value, but extracting it from rustls/quinn is not implemented.
- **No CLOSE frame handling.** Graceful connection termination is specified but not implemented.
- **No PING/PONG keep-alive.** Frame types exist but no implementation sends or responds.
- **No ERROR frame transmission.** Error codes and ProtocolError struct exist but no implementation sends ERROR frames in response to violations.

### 4.2 Session Management

- **No session state machine.** No states (Idle, Handshaking, Established, Closing, Closed) are defined or implemented.
- **No session resumption.** No 0-RTT, no session tickets, no PSK caching.
- **No session timeout.** No mechanism to time out idle sessions.
- **No session migration.** QUIC connection migration is not utilized.

### 4.3 Authorization

- **No UCAN enforcement.** UCAN tokens can be created and verified in isolation but are never checked on incoming requests.
- **No capability negotiation.** Capabilities are advertised in AgentRecord and handshake but no protocol mechanism negotiates or enforces them.
- **No delegation chain transmission.** No protocol message carries UCAN tokens.
- **No token revocation.** No mechanism to revoke UCAN tokens.

### 4.4 Discovery

- **No distributed DHT.** Only in-memory local indexing. No Kademlia RPCs, no routing table, no network queries.
- **No gossipsub.** No liveness propagation, no capability update broadcasting.
- **No bootstrap protocol.** Seed node configuration exists but no code connects to seeds.
- **No hierarchical clustering.** Regional discovery is local only.

### 4.5 NAT Traversal

- **No NAT detection.** AutoNAT is a stub with no probing.
- **No hole punching.** DCuTR is a stub with no protocol.
- **No relay protocol.** Relay service is a stub with no circuit relay v2 implementation.

### 4.6 Error Handling

- **No error frame transmission.** Errors are represented as structs but never sent over the wire.
- **No error-driven connection closure.** Fatal errors should close connections; no implementation does this.
- **No error logging conventions.** No structured logging of protocol errors.

### 4.7 Versioning

- **No ALPN negotiation.** RFC-0006 specifies `aafp/1` ALPN but no implementation sets it.
- **No version field in QUIC transport.** Frame version byte is checked but ALPN-level negotiation is not performed.

### 4.8 Wire Compatibility

- **Map key ordering not validated on decode.** The encoder produces canonical ordering, but the decoder doesn't reject non-canonical ordering. This could allow subtle interop issues.
- **No wire compatibility tests between Rust and Go at the transport level.** Only CBOR/frame/handshake structure interop is tested.

### 4.9 Documentation

- **No protocol tutorial.** RFCs are specification documents, not guides.
- **No API documentation.** No rustdoc generated or published.
- **No deployment guide.** No instructions for running an agent in production.
- **No security guide.** Threat model exists in research report but not as a standalone document.

### 4.10 Testing

- **No CI pipeline.** Tests are run manually.
- **No performance regression tests.** Benchmarks exist but aren't run automatically.
- **No network-level integration tests.** All QUIC tests are localhost.
- **No multi-node testnet.** Integration tests use 10 agents, not 1000.
- **No cross-signature verification.** Go implementation lacks ML-DSA-65.

### 4.11 Performance

- **No validated performance targets.** Benchmarks exist but haven't been compared against PERFORMANCE_CRITERIA.md targets in a systematic way.
- **No memory profiling.** Per-session memory usage not measured.
- **No throughput benchmarks under load.** Only single-operation benchmarks.
- **No large-scale discovery benchmarks.** DHT benchmarks use 100 agents, not 100K.

### 4.12 Security

- **pqcrypto-mldsa is unmaintained.** RUSTSEC-2026-0162/0163/0166. Release blocker.
- **No signature verification on incoming connections.** AgentId is derived from address, not verified.
- **No replay protection.** No nonces tracked, no replay window.
- **No constant-time comparison in Rust.** Go impl has `constantTimeEq`; Rust impl uses `==` for AgentId comparison.
- **No security audit.** No external review.
- **No formal threat model validation.** Threat model exists in research report but hasn't been validated against implementation.

### 4.13 Tooling

- **No CI/CD.** No GitHub Actions, no automated testing.
- **No release packaging.** No published binaries, no crates.io publication.
- **No debugging tools.** No protocol sniffer, no frame inspector.
- **No configuration management.** No config file support, no environment variable support.

---

## 5. Technical Debt

### 5.1 Duplicated Logic (High cost, Medium risk)

| Item | Description | Cost to Fix | Risk |
|------|-------------|-------------|------|
| AgentId duality | `[u8; 32]` vs `AgentId(pub [u8; 32])` | Low — pick one, convert all usages | Medium — touches many files |
| AgentRecord duality | `agent_record.rs` vs `identity_v1.rs` | Medium — merge or deprecate one | High — SDK uses the wrong one |
| RPC duality | `rpc.rs` vs `rpc_v1.rs` | Low — delete `rpc.rs` | Low — `rpc_v1.rs` is strictly better |
| Handshake duality | `handshake.rs` vs `handshake_v1.rs` | Medium — delete `handshake.rs`, update dependents | Medium — `handshake.rs` has the only working state machine |
| DHT duality | `capability_dht.rs` vs `discovery_v1.rs` | Low — delete `capability_dht.rs` | Low — SDK uses the simpler one |

**Recommendation:** Consolidate to one implementation per concept. Use the RFC-compliant version in all cases. This should happen before Phase 2 feature work begins.

### 5.2 Unnecessary Coupling (Medium cost, Low risk)

| Item | Description | Cost to Fix | Risk |
|------|-------------|-------------|------|
| `aafp-core` depends on `aafp-identity` | Core networking traits shouldn't depend on identity | Medium — move `AgentId` to core or use a generic type parameter | Low |
| `aafp-sdk` depends on all protocol crates | SDK is a monolithic integration point | Low — acceptable for an SDK | Low |

### 5.3 Missing Abstractions (Medium cost, Medium risk)

| Item | Description | Cost to Fix | Risk |
|------|-------------|-------------|------|
| No session state machine | Connection lifecycle is ad-hoc | High — design and implement states | Medium |
| No event system | No way to subscribe to protocol events | Medium — add event channel | Low |
| No connection manager | No pooling, no reconnection, no limits | High — implement connection management | Medium |
| Transport traits unused | `aafp-core` traits don't match `QuicTransport` API | Medium — align or remove traits | Low |

### 5.4 Protocol Assumptions in Implementation (Low cost, High risk)

| Item | Description | Cost to Fix | Risk |
|------|-------------|-------------|------|
| AgentId from address | SDK derives identity from network address | High — implement handshake | High — security gap |
| No ALPN set | `aafp/1` ALPN not configured in rustls | Low — add ALPN protocol string | Medium |
| CBOR map ordering not validated on decode | Encoder is canonical, decoder is lenient | Low — add ordering check | Medium — interop risk |
| `Frame header comment says 24 bytes` | Actual size is 28 bytes | Trivial — fix comment | None |

### 5.5 Dead Code and Warnings (Low cost, Low risk)

The compiler produces ~30 warnings across the workspace:
- Unused imports (multiple crates)
- Unused variables (`client_kem_public`, `sk`, etc.)
- Dead code (`ClientState` fields, `ServerState` fields, `signature_input` function)
- Unused `Result` values (`finish()`, `reset()`, `stop()` in transport)

**Cost to fix:** Low — run `cargo fix` and manually address remaining warnings.
**Risk:** None.

---

## 6. Readiness Assessment

| Area | Rating | Justification |
|------|--------|---------------|
| **CBOR encoding** | Stable MVP | Canonical encoder/decoder, hardened via fuzzing, interop-verified, 10.5M fuzz iterations clean |
| **Frame format** | Stable MVP | 28-byte header, all types implemented, overflow protection, interop-verified, IMPL-0001 fixed |
| **Error codes** | Stable MVP | All RFC-0005 codes defined, categories correct, always-fatal logic correct, conformance tests pass |
| **Identity (AgentId)** | Stable MVP | SHA-256 derivation, hex encoding, fingerprint format, conformance tests pass |
| **Identity (AgentRecord)** | Stable MVP | CBOR schema, signature verification, expiry handling, SA-0001/SA-0003 resolved |
| **Identity (UCAN)** | Functional Prototype | Token creation and chain verification work, but not integrated with protocol |
| **Cryptography (ML-DSA-65)** | Functional Prototype | Primitives work and are fast, but pqcrypto is unmaintained (release blocker) |
| **Cryptography (AEAD)** | Stable MVP | ChaCha20-Poly1305 and AES-256-GCM work, tested, correct |
| **Cryptography (Handshake)** | Functional Prototype | Message structures and transcript hash correct, but no state machine |
| **Transport (QUIC)** | Functional Prototype | QUIC works for localhost, PQ TLS works, but no 0-RTT, no migration, no NAT |
| **Messaging (Framing)** | Stable MVP | Frame encode/decode, codec, extensions, all tested and interop-verified |
| **Messaging (RPC)** | Functional Prototype | Message structures correct, but no dispatch, no transport integration |
| **Messaging (PubSub)** | Not Started | In-memory broadcast only, no gossipsub, no network propagation |
| **Messaging (Streams)** | Functional Prototype | Stream manager exists, AEAD methods exist, but not used after handshake |
| **Discovery (DHT)** | Functional Prototype | In-memory indexing works, no distributed DHT, no network protocol |
| **Discovery (Regional)** | Functional Prototype | Latency-based grouping works, no inter-cluster routing |
| **Discovery (Bootstrap)** | Not Started | Configuration exists, no network bootstrap protocol |
| **NAT (AutoNAT)** | Not Started | Stub only, no probing |
| **NAT (DCuTR)** | Not Started | Stub only, no hole punching |
| **NAT (Relay)** | Not Started | Stub only, no relay protocol |
| **SDK** | Functional Prototype | Builder/client/server work for echo, no handshake, no real auth |
| **CLI** | Functional Prototype | Commands work for basic operations, no persistence, no config |
| **Conformance testing** | Stable MVP | 200+ conformance tests, 54 negative tests, 33 version negotiation tests |
| **Interoperability** | Stable MVP | Wire-format interop proven (Rust↔Go), no transport/sig interop |
| **RFCs** | Stable MVP | 6 RFCs, 3,968 lines, Revision 5, all ambiguities resolved |
| **Security** | Functional Prototype | PQ crypto works, but unmaintained dependency, no auth enforcement, no audit |
| **Performance** | Functional Prototype | Crypto benchmarks pass, no network perf validation |
| **CI/CD** | Not Started | No automated testing, no CI pipeline |
| **Documentation** | Functional Prototype | RFCs are thorough, no API docs, no deployment guide |

---

## 7. Phase 2 Goals

### 7.1 Must Complete Before Protocol Freeze

These items are prerequisites for the protocol specification being considered frozen. Without them, the protocol cannot be independently implemented from the RFCs alone.

1. **Implement handshake state machine over QUIC**
   - Wire the ClientHello/ServerHello/ClientFinished exchange into the transport layer
   - Extract TLS channel binding from rustls
   - Derive session AEAD keys from handshake result
   - Apply AEAD encryption to application streams
   - **Why now:** Without this, the protocol has no security model. This is the difference between a spec and a working protocol.

2. **Enforce identity verification on incoming connections**
   - Verify peer AgentId from handshake, not from address
   - Reject connections with invalid signatures or mismatched AgentIds
   - **Why now:** The current address-based identity is a security vulnerability. No deployment should happen without this.

3. **Implement ERROR frame transmission**
   - Send ERROR frames in response to protocol violations
   - Close connections on fatal errors
   - **Why now:** Error handling is specified but not implemented. Without it, protocol violations cause undefined behavior.

4. **Implement CLOSE frame for graceful termination**
   - Send CLOSE frame before closing QUIC connection
   - Process incoming CLOSE frames
   - **Why now:** Without graceful close, peers can't distinguish intentional termination from network failure.

5. **Migrate from pqcrypto-mldsa to maintained implementation**
   - Replace pqcrypto-mldsa/pqcrypto-traits/pqcrypto-internals with aws-lc-rs ML-DSA or fips204 crate
   - Verify signature compatibility (same byte output for same input)
   - **Why now:** pqcrypto is archived and unmaintained. Using unmaintained crypto software is a release blocker and a security risk.

6. **Set ALPN to `aafp/1` in TLS configuration**
   - Configure rustls to offer `aafp/1` ALPN
   - Reject connections without matching ALPN
   - **Why now:** ALPN is the first line of defense against version confusion attacks. It's specified in RFC-0006 but not implemented.

7. **Consolidate duplicate implementations**
   - Remove `agent_record.rs` (use `identity_v1.rs`)
   - Remove `rpc.rs` (use `rpc_v1.rs`)
   - Remove `handshake.rs` (use `handshake_v1.rs`)
   - Remove `capability_dht.rs` (use `discovery_v1.rs`)
   - Align AgentId type (pick newtype or alias, use everywhere)
   - **Why now:** Duplicates create confusion about which is canonical. The RFC-compliant versions must be the only versions before freeze.

### 7.2 Should Complete Before Public Release

These items are not protocol-freeze prerequisites but are needed before the project can be publicly released and used by third parties.

1. **Implement PING/PONG keep-alive**
   - Periodic PING on idle connections
   - PONG response
   - Connection timeout on missed PONG
   - **Why before release:** Without keep-alive, idle connections die silently.

2. **Implement discovery announce/lookup over QUIC**
   - Send AnnounceParams/LookupParams as RPC over QUIC
   - Process incoming announce/lookup requests
   - **Why before release:** Discovery is a core feature but currently has no network protocol.

3. **Implement basic relay protocol**
   - Circuit relay v2 for NAT traversal
   - At minimum: reservation request, relayed stream forwarding
   - **Why before release:** Without relay, agents behind NAT cannot communicate.

4. **Add CI pipeline**
   - GitHub Actions: cargo test, cargo clippy, cargo audit, go test
   - Automated on every push and PR
   - **Why before release:** Manual testing doesn't scale. CI is essential for maintaining quality.

5. **Add ML-DSA-65 to Go implementation**
   - Implement signature generation and verification
   - Cross-signature verification tests (Rust signs, Go verifies, and vice versa)
   - **Why before release:** Cross-signature verification is a release criterion (currently NOT MET).

6. **Validate performance targets**
   - Run benchmarks against PERFORMANCE_CRITERIA.md targets
   - Measure: time to first message, throughput, memory per session
   - **Why before release:** Performance criteria are a release criterion (currently NOT MET).

7. **Fix all compiler warnings**
   - Run `cargo fix`
   - Address remaining warnings manually
   - **Why before release:** Warnings indicate dead code and unused values that may hide bugs.

8. **Add rustdoc documentation**
   - Document all public APIs
   - Generate and publish documentation
   - **Why before release:** Without docs, third parties can't use the SDK.

### 7.3 Long-Term Extensions

These items are valuable but not needed for a stable v1.0 release. They can be added in v1.1+.

1. **0-RTT session resumption** (HQRT-style PQ 0-RTT)
2. **Distributed Kademlia DHT** (replacing in-memory DHT)
3. **Gossipsub for PubSub and liveness**
4. **Hierarchical regional clustering** (inter-cluster super-peer DHT)
5. **UCAN authorization enforcement** (checking tokens on incoming requests)
6. **Connection migration** (QUIC CID-based)
7. **Semantic vector index** for capability matching
8. **Reputation system** (EigenTrust-style)
9. **io_uring connection management** (Linux, for 100K+ connections)
10. **MCP transport binding** (AAFP as MCP transport)
11. **Onion routing** (privacy layer)
12. **Autonomous contracting protocol**

### 7.4 Explicit Non-Goals

These are explicitly out of scope for AAFP v1.0 and should not be pursued.

1. **Replacing QUIC.** QUIC via quinn is the transport. No custom transport protocol.
2. **libp2p compatibility.** AAFP is a separate protocol. No bridge or compatibility layer.
3. **X.509 certificate infrastructure.** TOFU with self-signed certs + application-layer ML-DSA-65 identity is the trust model.
4. **Blockchain integration.** No on-chain identity, no token-based reputation, no smart contracts.
5. **Centralized registry.** No central agent directory. Discovery is P2P.
6. **Human-friendly naming.** AgentIds are 32-byte hashes. No human-readable names, no DNS integration.
7. **WireGuard compatibility.** Different protocol, different goals.
8. **Custom crypto primitives.** Use NIST-standardized PQ algorithms only.
9. **Mobile platform support** (v1.0). Desktop/server first. Mobile can follow.
10. **Browser/WASM support** (v1.0). Native binaries first. WASM can follow.

---

## 8. Prioritized Roadmap

Items ordered by architectural value (highest first). Each item includes objective, rationale, complexity, dependencies, protocol impact, and breaking status.

### P0-1: Migrate pqcrypto-mldsa to maintained implementation

| Field | Value |
|-------|-------|
| **Objective** | Replace unmaintained `pqcrypto-mldsa`/`pqcrypto-traits`/`pqcrypto-internals` (RUSTSEC-2026-0162/0163/0166) with a maintained ML-DSA-65 implementation |
| **Rationale** | Using unmaintained cryptographic software is a security risk and a release blocker. This is the single highest-priority item because it affects the security foundation of the entire protocol. |
| **Complexity** | Medium. The `SignatureScheme` trait in `aafp-crypto/src/traits.rs` provides the abstraction boundary. The migration replaces the implementation behind the trait. Candidate: `aws-lc-rs` ML-DSA (already a dependency for TLS PQ), or `fips204` crate. Must verify byte-identical signature output. |
| **Dependencies** | None (can start immediately) |
| **Protocol impact** | None (internal implementation change; signature format unchanged) |
| **Breaking** | Non-breaking (if signature output is identical) |
| **Why now** | Unmaintained crypto is a security vulnerability. Every other item depends on a trustworthy crypto foundation. |

### P0-2: Implement handshake state machine over QUIC

| Field | Value |
|-------|-------|
| **Objective** | Wire the ClientHello → ServerHello → ClientFinished exchange into the QUIC transport layer, completing the AAFP application-layer handshake over a live connection |
| **Rationale** | Without the handshake, there is no authentication, no session key derivation, and no identity verification. This is the difference between a protocol specification and a working protocol. Every secure communication path depends on this. |
| **Complexity** | High. Requires: (1) extracting TLS channel binding from rustls, (2) implementing handshake state machine on both client and server, (3) sending handshake messages as HANDSHAKE frames on stream 0, (4) deriving AEAD keys from handshake result, (5) applying AEAD to application streams, (6) handling handshake errors. |
| **Dependencies** | P0-1 (crypto foundation must be trustworthy first) |
| **Protocol impact** | Implements RFC-0002 §5 (already specified, not yet implemented) |
| **Breaking** | Non-breaking (adds functionality that was specified but missing) |
| **Why now** | This is the core protocol gap. Nothing else matters without authenticated, encrypted sessions. |

### P0-3: Enforce identity verification on connections

| Field | Value |
|-------|-------|
| **Objective** | Verify peer AgentId from the handshake exchange, not from the remote address. Reject connections with invalid signatures, mismatched AgentIds, or expired records. |
| **Rationale** | The current SDK derives AgentId from the remote network address, which is a security vulnerability. Any peer can claim any AgentId. This must be fixed before any real deployment. |
| **Complexity** | Medium. Builds on P0-2. After handshake completes, verify: (1) AgentId in ClientHello matches SHA-256(public_key), (2) signature over transcript is valid, (3) AgentRecord is not expired, (4) key_algorithm is ML-DSA-65. |
| **Dependencies** | P0-2 (handshake must be implemented first) |
| **Protocol impact** | Implements RFC-0003 §3.6 (verification procedure, already specified) |
| **Breaking** | Breaking for the SDK (AgentClient::connect behavior changes), non-breaking for protocol |
| **Why now** | Address-based identity is a security vulnerability. No deployment should happen without verified identity. |

### P0-4: Consolidate duplicate implementations

| Field | Value |
|-------|-------|
| **Objective** | Remove all duplicate implementations, keeping only the RFC-compliant version of each concept |
| **Rationale** | Five concepts have duplicate implementations (AgentId, AgentRecord, RPC, Handshake, DHT). This creates confusion about which is canonical, makes maintenance harder, and means the SDK uses non-RFC-compliant code. |
| **Complexity** | Medium. Mechanical work: delete old files, update imports, update SDK to use RFC-compliant versions, fix test breakage. |
| **Dependencies** | None (can start immediately, but should be done before P0-2 to avoid building on wrong foundation) |
| **Protocol impact** | None (internal cleanup) |
| **Breaking** | Breaking for internal APIs (SDK behavior changes when using RFC-compliant AgentRecord), non-breaking for protocol |
| **Why now** | Building new features on top of duplicates compounds the debt. Clean foundation before new work. |

### P0-5: Set ALPN to `aafp/1` in TLS

| Field | Value |
|-------|-------|
| **Objective** | Configure rustls to offer and require `aafp/1` ALPN protocol. Reject connections that don't match. |
| **Rationale** | ALPN is the first line of defense against version confusion attacks. It's specified in RFC-0006 §2.3 but not implemented. Without it, an AAFP endpoint could accidentally connect to a non-AAFP service. |
| **Complexity** | Low. Add ALPN protocol string to rustls `ServerConfig` and `ClientConfig`. ~10 lines of code. |
| **Dependencies** | None |
| **Protocol impact** | Implements RFC-0006 §2.3 (already specified) |
| **Breaking** | Non-breaking for compliant implementations, breaking for non-ALPN connections (which shouldn't exist) |
| **Why now** | Low effort, high security value. Should be done immediately. |

### P0-6: Implement ERROR frame transmission

| Field | Value |
|-------|-------|
| **Objective** | Send ERROR frames (RFC-0002 §4.6, RFC-0005) in response to protocol violations. Close connections on fatal errors. |
| **Rationale** | Without error frames, protocol violations cause undefined behavior. The receiver doesn't know what went wrong. This is specified but not implemented. |
| **Complexity** | Low-Medium. Encode ProtocolError as ERROR frame payload, send on the connection's stream, close connection if fatal. |
| **Dependencies** | P0-2 (need a working connection with stream management) |
| **Protocol impact** | Implements RFC-0005 §4 (already specified) |
| **Breaking** | Non-breaking (adds specified behavior) |
| **Why now** | Error handling is a protocol freeze prerequisite. Without it, the protocol can't be reliably implemented. |

### P0-7: Implement CLOSE frame for graceful termination

| Field | Value |
|-------|-------|
| **Objective** | Send CLOSE frame before closing QUIC connection. Process incoming CLOSE frames. |
| **Rationale** | Without graceful close, peers can't distinguish intentional termination from network failure. This affects reconnection logic and session management. |
| **Complexity** | Low. Encode CloseMessage as CLOSE frame, send, then close QUIC connection. Process incoming CLOSE and propagate to application. |
| **Dependencies** | P0-2 (need a working connection) |
| **Protocol impact** | Implements RFC-0002 §4.5 (already specified) |
| **Breaking** | Non-breaking (adds specified behavior) |
| **Why now** | Protocol freeze prerequisite. Low effort. |

### P1-1: Implement PING/PONG keep-alive

| Field | Value |
|-------|-------|
| **Objective** | Send periodic PING frames on idle connections. Respond to PING with PONG. Timeout connections on missed PONG. |
| **Rationale** | Without keep-alive, idle connections die silently when NAT mappings expire or intermediate devices drop state. This is essential for real networks. |
| **Complexity** | Low. Timer-driven PING, PONG response, timeout tracking. |
| **Dependencies** | P0-2 (working connection) |
| **Protocol impact** | Implements RFC-0002 §4.7-4.8 (already specified) |
| **Breaking** | Non-breaking |
| **Why now** | Needed before public release. Without it, the protocol doesn't work reliably on real networks. |

### P1-2: Implement discovery RPC over QUIC

| Field | Value |
|-------|-------|
| **Objective** | Send AnnounceParams and LookupParams as RPC requests over QUIC streams. Process incoming announce/lookup requests on the server side. |
| **Rationale** | Discovery is a core feature but currently has no network protocol. The in-memory DHT works locally but can't share state across agents. |
| **Complexity** | Medium. Wire RPC messages over QUIC streams, implement server-side handler, integrate with local DHT. |
| **Dependencies** | P0-2 (working connections), P0-3 (identity verification for announce auth) |
| **Protocol impact** | Implements RFC-0004 §3 (already specified) |
| **Breaking** | Non-breaking (adds specified behavior) |
| **Why now** | Discovery without a network protocol is incomplete. Needed before public release. |

### P1-3: Add CI pipeline

| Field | Value |
|-------|-------|
| **Objective** | GitHub Actions workflow: cargo test, cargo clippy, cargo audit, go test, on every push and PR. |
| **Rationale** | Manual testing doesn't scale. CI catches regressions, warnings, and security advisories automatically. |
| **Complexity** | Low. Standard GitHub Actions configuration. |
| **Dependencies** | None |
| **Protocol impact** | None |
| **Breaking** | Non-breaking |
| **Why now** | Should be in place before any collaborative development. Prevents regressions during Phase 2 work. |

### P1-4: Add ML-DSA-65 to Go implementation

| Field | Value |
|-------|-------|
| **Objective** | Implement ML-DSA-65 signature generation and verification in Go. Add cross-signature verification tests (Rust signs → Go verifies, Go signs → Rust verifies). |
| **Rationale** | Cross-signature verification is a release criterion (currently NOT MET). Without it, the two implementations can't fully interoperate at the security layer. |
| **Complexity** | Medium. Use a Go ML-DSA-65 implementation (e.g., `crypto/fips204` when available, or a vetted third-party). Write cross-impl tests. |
| **Dependencies** | P0-1 (Rust must use a maintained implementation for fair comparison) |
| **Protocol impact** | None (Go impl gap, not protocol gap) |
| **Breaking** | Non-breaking |
| **Why now** | Release criterion. Can proceed in parallel with P0 work. |

### P1-5: Validate performance targets

| Field | Value |
|-------|-------|
| **Objective** | Run benchmarks against PERFORMANCE_CRITERIA.md targets. Measure: time to first authenticated message, message throughput, memory per session, concurrent sessions. |
| **Rationale** | Performance validation is a release criterion (currently NOT MET). The crypto benchmarks pass (64-205x faster than targets) but network-level performance is untested. |
| **Complexity** | Medium. Write benchmark scenarios, run on representative hardware, compare against targets. |
| **Dependencies** | P0-2 (need working handshake for end-to-end timing) |
| **Protocol impact** | None |
| **Breaking** | Non-breaking |
| **Why now** | Release criterion. Needed before public release to validate the protocol is practical. |

### P1-6: Fix compiler warnings and dead code

| Field | Value |
|-------|-------|
| **Objective** | Run `cargo fix`, address remaining warnings, remove dead code. |
| **Rationale** | ~30 warnings indicate dead code, unused imports, and silently dropped Result values. These may hide bugs and make the codebase harder to maintain. |
| **Complexity** | Low. Mechanical cleanup. |
| **Dependencies** | P0-4 (consolidation may remove some dead code naturally) |
| **Protocol impact** | None |
| **Breaking** | Non-breaking |
| **Why now** | Quick win that improves code quality. Should be done before public release. |

### P1-7: Add rustdoc documentation

| Field | Value |
|-------|-------|
| **Objective** | Document all public APIs with rustdoc comments. Generate and publish documentation. |
| **Rationale** | Without documentation, third parties can't use the SDK. API docs are a prerequisite for public release. |
| **Complexity** | Medium. Write doc comments for all public types, traits, and functions. |
| **Dependencies** | P0-4 (API surface should be stable after consolidation) |
| **Protocol impact** | None |
| **Breaking** | Non-breaking |
| **Why now** | Needed before public release. Best done after API consolidation. |

### P1-8: Implement basic relay protocol

| Field | Value |
|-------|-------|
| **Objective** | Implement circuit relay v2 for NAT traversal: reservation request, relayed stream forwarding, reservation management. |
| **Rationale** | Without relay, agents behind NAT cannot communicate. This is essential for real-world deployment where many agents are behind home or corporate NATs. |
| **Complexity** | High. Full relay protocol: reservation, circuit establishment, stream forwarding, capacity management. |
| **Dependencies** | P0-2 (working connections), P0-3 (identity verification) |
| **Protocol impact** | Extends protocol (relay protocol not fully specified in current RFCs) |
| **Breaking** | Non-breaking (new functionality) |
| **Why now** | Needed before public release. Without NAT traversal, the protocol only works on public networks. May require RFC-0004 extension or new RFC for relay protocol specification. |

### P2-1: Implement UCAN authorization enforcement

| Field | Value |
|-------|-------|
| **Objective** | Check UCAN capability tokens on incoming requests. Reject requests that exceed delegated capabilities. |
| **Rationale** | Authorization is specified in RFC-0003 §6 but not enforced. Without it, any connected peer can invoke any capability. |
| **Complexity** | Medium. Verify UCAN chain on incoming RPC requests, check capability match, enforce constraints. |
| **Dependencies** | P0-2 (handshake), P0-3 (identity), P1-2 (RPC over QUIC) |
| **Protocol impact** | Implements RFC-0003 §6 (already specified) |
| **Breaking** | Breaking for SDK (requests without UCAN tokens will be rejected) |
| **Why later** | Important but not a protocol freeze prerequisite. The protocol is secure without it (authenticated but not authorized). Can be added after core protocol is stable. |

### P2-2: Implement AutoNAT dial-back protocol

| Field | Value |
|-------|-------|
| **Objective** | Implement NAT status detection via dial-back probes. Determine if the agent is behind NAT and needs relay. |
| **Rationale** | Without NAT detection, the agent doesn't know whether to use direct connections or request relay. |
| **Complexity** | Medium. Ask peers to dial back to advertised address, track success/failure, determine status. |
| **Dependencies** | P0-2 (working connections), P1-8 (relay for fallback) |
| **Protocol impact** | New protocol messages (dial-back request/response) |
| **Breaking** | Non-breaking (new functionality) |
| **Why later** | Needed for real deployment but not for protocol freeze. Can follow relay implementation. |

### P2-3: CBOR map ordering validation on decode

| Field | Value |
|-------|-------|
| **Objective** | Validate that decoded CBOR maps have keys in canonical (length-first) ordering. Reject non-canonical maps. |
| **Rationale** | The encoder produces canonical ordering but the decoder is lenient. This could allow subtle interop issues where one implementation accepts what another rejects. |
| **Complexity** | Low. Add ordering check in `decode_int_map` and `decode_str_map`. |
| **Dependencies** | None |
| **Protocol impact** | Stricter conformance to RFC-0002 §8.1 |
| **Breaking** | Potentially breaking for implementations that produce non-canonical CBOR (they would now be rejected) |
| **Why later** | Important for strict conformance but not blocking. Current encoder is canonical so this only affects external inputs. |

### P2-4: Distributed Kademlia DHT

| Field | Value |
|-------|-------|
| **Objective** | Replace in-memory DHT with distributed Kademlia. Implement FIND_NODE, FIND_VALUE, PUT RPCs over QUIC. |
| **Rationale** | In-memory DHT doesn't scale beyond a single agent. Distributed DHT is needed for multi-agent discovery. |
| **Complexity** | High. Full Kademlia: routing table, k-buckets, iterative lookup, replication, churn handling. |
| **Dependencies** | P1-2 (discovery RPC over QUIC) |
| **Protocol impact** | Extends RFC-0004 (DHT protocol not fully specified) |
| **Breaking** | Non-breaking (new functionality) |
| **Why later** | In-memory DHT is sufficient for MVP. Distributed DHT is a scale feature that can follow core protocol stability. |

### P2-5: Gossipsub for PubSub and liveness

| Field | Value |
|-------|-------|
| **Objective** | Replace in-memory broadcast with gossipsub. Implement mesh management, score-based peer selection, heartbeat, topic subscription. |
| **Rationale** | In-memory PubSub doesn't propagate messages across the network. Gossipsub is needed for capability updates and liveness. |
| **Complexity** | High. Full gossipsub v1.1: mesh degree management, score-based mesh, gossip propagation, control messages. |
| **Dependencies** | P0-2 (working connections), P1-2 (RPC over QUIC) |
| **Protocol impact** | New protocol messages (gossipsub control messages) |
| **Breaking** | Non-breaking (new functionality) |
| **Why later** | PubSub is not needed for core protocol operation. Can follow discovery and NAT traversal. |

### P2-6: 0-RTT session resumption

| Field | Value |
|-------|-------|
| **Objective** | Implement HQRT-style PQ 0-RTT session resumption. Store session tickets, reuse on reconnection, protect against replay. |
| **Rationale** | 0-RTT reduces reconnection latency from 1 RTT to 0 RTT (+ propagation). Important for agent swarms with frequent reconnections. |
| **Complexity** | High. Ticket management, replay detection, PQ PSK derivation, quinn 0-RTT API integration. |
| **Dependencies** | P0-2 (handshake), quinn 0-RTT API exposure |
| **Protocol impact** | Extends RFC-0002 (0-RTT not currently specified in detail) |
| **Breaking** | Non-breaking (new functionality) |
| **Why later** | 1-RTT handshake is sufficient for v1.0. 0-RTT is a performance optimization for v1.1+. |

---

## Appendix A: Release Criteria Status

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Two independent implementations | MET | Rust (461 tests) + Go (138+ tests) |
| 2 | Bidirectional wire interop | MET | 73 + 39 tests, byte-for-byte identical |
| 3 | Cross-signature verification | NOT MET | Go lacks ML-DSA-65 |
| 4 | Published test vectors | MET | TEST_VECTORS.md, 31+ vectors, Go reproduces all |
| 5 | Published golden traces | MET | 9 traces, Go verifies all |
| 6 | No unresolved ambiguities | MET | SA-0001/SA-0002/SA-0003 resolved in Rev 4/5 |
| 7 | No security-critical issues | NOT MET | pqcrypto unmaintained, no auth enforcement, no audit |
| 8 | Conformance suite passing | MET | 461 Rust + 138+ Go, all pass |
| 9 | Performance targets | NOT MET | Crypto benchmarks pass, network perf untested |
| 10 | Supply-chain review | NOT MET | Review done, pqcrypto migration pending |

**7 of 10 met. 3 remaining: cross-signature (P1-4), security (P0-1 + P0-3), performance (P1-5).**

---

## Appendix B: File Inventory

### Umbrella repo (`AAFP-research`)
- `AAFP_Research_Report.md` — 794 lines, feasibility study
- `AAFP_Architecture_Deliverable.md` — 1249 lines, production architecture
- `AAFP_Implementation_Prompt.md` — implementation guidance
- `PHASE2_STATUS_REPORT.md` — this document

### Rust implementation (`aafp/` submodule)
- 13 crates, 461 tests
- 6 RFCs (3,968 lines, Revision 5)
- 14 supplementary docs (COMPLIANCE_MATRIX, FUZZING_REPORT, etc.)
- 9 golden wire traces
- Interop fixtures (Rust→Go and Go→Rust)
- Supply chain review (SBOM, license review, vulnerability scan)
- Fuzzing infrastructure (5 targets)

### Go implementation (`aafp-go/` submodule)
- 7 packages, 138+ tests
- Wire-format layer only (CBOR, frame, handshake, identity, errors)
- No QUIC transport, no ML-DSA-65, no discovery, no RPC dispatch
- Interop fixture generator

---

*Generated 2026-06-28 by engineering review. Baseline: `v0.3-phase3-snapshot`.*
