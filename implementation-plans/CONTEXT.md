# AAFP Project Context

**Read this before executing any plan.** This document is a self-contained
reference for the AAFP project state as of 2026-07-04.

---

## 1. What AAFP Is

AAFP (Agent-Agent First Networking Protocol) is a **post-quantum, agent-native
peer-to-peer networking protocol**. It is a **secure session layer** — the
foundation upon which application protocols (MCP, A2A) run. It is NOT an
application protocol itself (ADR-0001).

**Architecture:**
```
Application Layer (MCP, A2A — JSON-RPC 2.0)
    ↓
AAFP Transport Binding Layer (aafp-transport-mcp, aafp-transport-a2a)
    ↓
AAFP Core Protocol Layer (framing, handshake, session, control frames)
    ↓
Transport Layer (QUIC via quinn + PQ TLS via rustls)
```

**Key differentiators (no competitor offers all five):**
1. Post-quantum by default (ML-DSA-65 signatures + X25519MLKEM768 hybrid KEX)
2. QUIC-native transport (stream multiplexing, 0-RTT, connection migration)
3. UCAN capability chains (cryptographic delegation, hierarchical)
4. CBOR deterministic framing (RFC 8949, 3-5x smaller than JSON)
5. Cross-connection replay protection (time-bounded nonce cache)

**Strategic position:** AAFP is the decentralized execution substrate for
autonomous software (see STRATEGIC_VISION.md). Adoption path = interop
with MCP/A2A, NOT replacement (ADR-0004). AAFP provides PQ security + QUIC
performance as enhancements to protocols agents already use.

---

## 2. Current Verified State (2026-07-04, all 19 tracks (A-S) complete)

| Metric | Value |
|--------|-------|
| Rust tests | 1597, 0 failures, 7 ignored |
| Go tests | 664, 0 failures |
| Rust crates | 17 (15 workspace + aafp-py + aafp-loadtest) |
| Go packages | 13 |
| RFCs | 8 (0001-0006 core, 0007 MCP binding, 0008 A2A binding) |
| ADRs | 4 (all Accepted) |
| Release criteria | 10/10 met |
| Rev 6 amendments | A-1 through A-10 all DONE |
| Golden wire traces | 17 (all verified by both impls) |
| Interop fixtures | 37 (all round-trip verified) |
| CI workflows | Fixed (A2), functional |
| Git history | Clean (12MB, C2 filter-repo completed) |
| Remote push | DONE (C3 pushed to GitHub) |

**Implementation status by area:**
- CBOR encoding: Stable
- Frame format: Stable
- Identity (AgentId, AgentRecord): Stable, v1 RFC-compliant
- Cryptography (ML-DSA-65): Stable (fips204 + aws-lc-rs)
- Handshake (v1): Implemented, state machine wired into SDK
- Transport (QUIC): Stable (ALPN aafp/1 enforced)
- Messaging (framing, RPC, ERROR/CLOSE): Implemented
- Messaging (PubSub): Implemented (networked floodsub over QUIC, RFC 0009)
- Discovery (DHT): Stable (in-memory + SQLite persistent + Kademlia DHT router)
- NAT traversal: Implemented (relay forwarding, AutoNAT, DCuTR, RFC 0010)
- SDK: Stable (authenticated sessions, graceful shutdown, NAT integration)
- MCP Transport (RFC 0007): **Implemented** (aafp-transport-mcp crate)
- A2A Transport (RFC 0008): **Implemented** (aafp-transport-a2a crate, B1)
- Python Adapter: **Implemented** (aafp-py crate, B2) — segfault fixed (C1)
- Shared Handshake: **Extracted** (establish_session in aafp-sdk, B3)
- Conformance testing: Stable
- CI/CD: Functional (A2 fixed workflows)
- PING/PONG keep-alive: **Implemented** (PingTracker, E1)
- Revocation: **Implemented** (CRL-based, F3)
- Persistent DHT: **Implemented** (SQLite backend, F4)
- Performance validation: **Done** (F1, 6x improvement, Tracks G-M)
- Rustdoc: **Complete** (F2)
- Identity & PKI: **Implemented** (Track P — KeyDirectory, WoT, CA, rotation, revocation, TrustManager)
- WAN testing: **Implemented** (Track O — simulated WAN, packet loss, BBR, migration)
- Security audit: **Implemented** (Track Q — fuzzing, adversarial, hardening)
- WAN discovery: **Implemented** (Track R — Kademlia DHT router, bootstrap, churn, 500-node scale)
- Load & operations: **Implemented** (Track S — 100-agent load test, stability, metrics, deployment)

---

## 3. Repository Layout

```
/Users/david/Projects/AAFP-research/          (umbrella repo, master branch)
├── RFCs/                                       8 RFCs + amendments + reviews
│   ├── 0001-protocol-overview.md
│   ├── 0002-transport-framing.md               (102KB — the wire format spec)
│   ├── 0003-identity-authentication.md
│   ├── 0004-discovery.md
│   ├── 0005-error-model.md
│   ├── 0006-versioning-compatibility.md
│   ├── 0007-mcp-transport-binding.md           (Implemented)
│   ├── 0008-a2a-transport-binding.md           (Proposed — Plan B1 implements this)
│   ├── AMENDMENTS-0001.md, AMENDMENTS-0002.md
│   ├── REVIEW-0001.md through REVIEW-0004.md
│   └── RFC_CHANGELOG.md
├── adr/                                        Architectural Decision Records
│   ├── 0001-aafp-is-session-layer.md
│   ├── 0002-preserve-application-payloads.md
│   ├── 0003-mcp-uses-data-frames.md
│   └── 0004-interoperability-over-replacement.md
├── implementations/
│   ├── rust/                                   (submodule → davidnichols-ops/aafp)
│   │   ├── Cargo.toml                          (workspace manifest, 17 crates)
│   │   ├── crates/
│   │   │   ├── aafp-cbor/                      Canonical CBOR
│   │   │   ├── aafp-crypto/                    ML-DSA-65, AEAD, HKDF, handshake_v1, ReplayCache
│   │   │   ├── aafp-identity/                  AgentId, AgentRecord, UCAN
│   │   │   ├── aafp-core/                      Traits, Session state machine, AuthorizationProvider
│   │   │   ├── aafp-transport-quic/            quinn + rustls PQ transport
│   │   │   ├── aafp-discovery/                 Capability DHT (in-memory)
│   │   │   ├── aafp-nat/                       NAT traversal stubs
│   │   │   ├── aafp-messaging/                 Frame encode/decode, RPC, CloseManager, PubSub
│   │   │   ├── aafp-sdk/                       High-level Agent API + handshake driver + establish_session
│   │   │   ├── aafp-transport-mcp/             MCP transport binding (RFC 0007)
│   │   │   ├── aafp-transport-a2a/             A2A transport binding (RFC 0008) [B1]
│   │   │   ├── aafp-py/                        Python PyO3 adapter (standalone, not in workspace) [B2]
│   │   │   ├── aafp-cli/                       CLI binary
│   │   │   ├── aafp-conformance/               RFC conformance tests
│   │   │   ├── aafp-benchmark/                 Criterion benchmarks
│   │   │   └── aafp-tests/                     Cross-crate integration tests
│   │   └── golden_traces/                      17 canonical wire traces
│   └── go/                                     (submodule → davidnichols-ops/aafp-go)
│       ├── cbor/, frame/, frameext/, handshake/, identity/, errors/
│       ├── mldsa/                              ML-DSA-65 Go impl (A-10)
│       ├── interop/, goldentrace/, testvectors/, versionneg/, racestress/
│       └── cmd/generate_interop_fixtures/
├── docs/
│   ├── KNOWLEDGE_TRANSFER.md
│   ├── REV6_IMPLEMENTATION_PLAN.md
│   └── status/                                 PHASE2, STABILIZATION, PHASE_E, A7 reports
├── research/                                   Strategic architecture research (informative)
│   ├── CONCLUDING-PAPER.md                     5-year vision, ecosystem analysis
│   ├── phase-reports/                          16 phase reports
│   ├── deliverables/                           12 architectural deliverables
│   └── reference/
├── test-vectors/mldsa65/                       Published ML-DSA-65 test vectors
├── .github/workflows/                          rust-ci.yml, go-ci.yml (BROKEN — see Plan A2)
├── ROADMAP.md
├── README.md
├── POST_PUSH_AUDIT.md                          Audit findings (source of Track A plans)
├── REV6_RC1_READINESS_REPORT.md
├── TRANSPORT_ARCHITECTURE_REVIEW.md            Review of aafp-transport-mcp
├── COMPATIBILITY_LAYER_ANALYSIS.md             Why DATA frames are correct
├── INTEROPERABILITY_PLAN.md                    Cross-SDK interop roadmap
└── implementation-plans/                       THIS DIRECTORY
```

---

## 4. Key Architectural Decisions (ADRs — all Accepted)

### ADR-0001: AAFP is a session layer, not an application protocol
AAFP handles identity, auth, framing, transport. Application protocols (MCP,
A2A) run on top and own their message semantics. AAFP does NOT define
application-level methods.

### ADR-0002: Transport bindings preserve application payloads byte-for-byte
JSON-RPC messages are carried as opaque payloads of AAFP DATA frames. No
transcoding to CBOR. No interpretation. No modification. Each application
message = exactly one DATA frame.

### ADR-0003: MCP uses DATA frames, not native AAFP RPC
MCP's JSON-RPC 2.0 wire format is preserved. AAFP's native RPC frames
(RPC_REQUEST/RPC_RESPONSE, CBOR) are for AAFP-internal operations only
(discovery, relay management). External application protocols use DATA frames.

### ADR-0004: Interoperability over replacement
AAFP does not compete with MCP/A2A. It provides secure transport that carries
MCP/A2A messages. Users adopt AAFP by adding a transport adapter — no
application-level migration required.

---

## 5. Wire Format Quick Reference

### Frame Header (28 bytes, big-endian)
```
Byte 0:    Version (8-bit, currently 1)
Byte 1:    FrameType (8-bit)
Byte 2:    Flags (8-bit)
Byte 3:    Reserved (8-bit, MUST be 0)
Bytes 4-11:   Stream ID (64-bit)
Bytes 12-19:  Payload Length (64-bit)
Bytes 20-27:  Extension Length (64-bit)
```

### Frame Types
| Type | Name | Critical | Description |
|------|------|----------|-------------|
| 0x01 | DATA | No | Application data (streams >= 4) |
| 0x02 | HANDSHAKE | Yes | Handshake messages (stream 0 only) |
| 0x03 | RPC_REQUEST | No | AAFP native RPC |
| 0x04 | RPC_RESPONSE | No | AAFP native RPC reply |
| 0x05 | CLOSE | Yes | Graceful close |
| 0x06 | ERROR | Yes | Protocol error |
| 0x07 | PING | No | Keepalive |
| 0x08 | PONG | No | Keepalive response |

### Stream ID Allocation (RFC-0002 §7.1)
- Stream 0: handshake + connection control (MUST stay open)
- Streams 1-2: reserved for future use
- Streams >= 4: client-initiated application streams
- Streams >= 5: server-initiated application streams
- **Application transports MUST use stream ID >= 4.** (aafp-transport-mcp uses 4)

### Flags
| Bit | Name | Meaning |
|-----|------|---------|
| 0x80 | CRITICAL | Unknown frame type with this bit → ERROR + close |
| 0x01 | MORE | More fragments follow |
| 0x02 | COMPRESSED | Payload is compressed |
| 0x04 | ENCRYPTED | Application-layer encrypted |
| 0x08 | ACK | Acknowledgment |

### Limits
- Max payload: 1 MiB (1,048,576 bytes)
- Max extensions: 64 KiB
- ERROR frame data field: max 4096 bytes

---

## 6. Cryptographic Stack

| Purpose | Algorithm | Standard |
|---------|-----------|----------|
| TLS KEX | X25519MLKEM768 (hybrid) | IETF draft |
| Agent signatures | ML-DSA-65 | FIPS 204 |
| AgentId | SHA-256(public_key), 32 bytes | — |
| AEAD | ChaCha20-Poly1305 (default), AES-256-GCM | RFC 8439 / RFC 5116 |
| KDF | HKDF-SHA256 | RFC 5869 |
| Transcript | SHA-256 (running) | RFC 8446 |
| DoS MAC | HMAC-SHA256 | RFC 2104 |

### ML-DSA-65 Key Sizes
- Public key: 1952 bytes
- Secret key: 4032 bytes
- Signature: 3309 bytes
- Algorithm ID: 1

### Domain Separators (one-way doors — do not change)
| Constant | Value | Used For |
|----------|-------|----------|
| DOMAIN_SEPARATOR | "aafp-v1-handshake" (17 bytes) | Handshake signatures |
| SESSION_ID_INFO | "aafp-session-id-v1" | Session ID HKDF info |
| DOS_MAC_KEY_INFO | "aafp-v1-dos-mac-key" | DoS MAC key HKDF info |
| TLS_EXPORTER_LABEL | "EXPORTER-AAFP-Channel-Binding" | TLS exporter label |
| Record domain | "aafp-v1-record" | AgentRecord signatures |
| UCAN domain | "aafp-v1-ucan" | UCAN token signatures |

### Rust crypto dependencies
- `fips204 v0.4` (features: ml-dsa-65, default-rng) — ML-DSA-65
- `rustls v0.23` (features: prefer-post-quantum, aws-lc-rs) — TLS
- `aws-lc-rs v1` — crypto backend
- `chacha20poly1305 v0.10`, `aes-gcm v0.10` — AEAD
- `sha2 v0.10`, `hkdf v0.12`, `hmac v0.12` — hashing/KDF/MAC

### Go crypto dependency
- `github.com/KarpelesLab/mldsa v0.2.0` — ML-DSA-65

---

## 7. Handshake (RFC-0002 §5)

Three-way on stream 0: ClientHello → ServerHello → ClientFinished.

**Transcript hash** (running SHA-256, initialized from TLS binding):
```
h = SHA-256(tls_binding)
h = SHA-256(h || canonical_CBOR(ClientHello_without_sig_and_mac))
h = SHA-256(h || canonical_CBOR(ServerHello_without_sig))
h = SHA-256(h || canonical_CBOR(ClientFinished_without_sig))
```

**Session ID:**
```
HKDF-Expand(HKDF-Extract(salt=client_nonce||server_nonce, IKM=h_after_clienthello),
            info="aafp-session-id-v1", L=32)
```

**Session state machine (aafp-core):**
```
Connecting → TransportEstablished → IdentityVerified
    → AuthorizationVerified → Authenticated → MessagingEnabled
    → Closing → Closed
```
No unauthenticated code path exists. All messaging requires MessagingEnabled.

---

## 8. Conventions

### Rust
- **Workspace:** 15 crates, edition 2021, MIT OR Apache-2.0
- **v1 types are primary:** `rpc_v1`, `handshake_v1`, `identity_v1` are RFC-compliant.
  Legacy modules (`rpc`, `handshake`, `agent_record`) are `#[deprecated]`.
- **Verification commands:**
  ```bash
  cd implementations/rust
  cargo fmt --all -- --check     # 0 diffs expected
  cargo build --workspace         # 0 warnings expected
  cargo clippy --workspace        # 0 warnings expected
  cargo test --workspace          # 1597 tests, 0 failures expected
  ```
- **Commit style:** Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `style:`)

### Go
- **Verification commands:**
  ```bash
  cd implementations/go
  gofmt -l .                     # 0 files expected (currently 15 fail — Plan A2 fixes)
  go vet ./...                   # clean
  go build ./...                 # success
  go test ./...                  # all 13 packages pass
  ```

### Submodules
When you commit in a submodule, you MUST also update the submodule pointer in
the umbrella repo:
```bash
cd implementations/rust
# ... make changes, commit ...
cd /Users/david/Projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule — <description>"
```

---

## 9. The aafp-transport-mcp Crate (Template for B1)

This is the existing, working MCP transport binding. Plan B1 (A2A binding)
mirrors this crate's structure. Key facts:

**Location:** `implementations/rust/crates/aafp-transport-mcp/`

**Files:**
- `src/lib.rs` (534 lines) — `AafpMcpTransport` struct, `Transport<R>` impl
- `tests/integration.rs` — 4 integration tests
- `tests/conformance.rs` — 8 conformance tests
- `examples/mcp_over_aafp.rs` — full demo
- `examples/simple_transport.rs` — minimal demo

**Public API:**
```rust
pub struct AafpMcpTransport { /* private fields */ }

impl AafpMcpTransport {
    pub async fn connect(agent: &Agent, addr: &str) -> Result<Self, AafpMcpError>
    pub async fn connect_with_auth(agent: &Agent, addr: &str, auth: Arc<dyn AuthorizationProvider>) -> Result<Self, AafpMcpError>
    pub async fn accept(agent: &Agent) -> Result<Self, AafpMcpError>
    pub async fn accept_with_auth(agent: &Agent, auth: Arc<dyn AuthorizationProvider>) -> Result<Self, AafpMcpError>
    pub fn from_streams(send: QuicSendStream, recv: QuicRecvStream, conn: Option<QuicConnection>) -> Self
    pub fn peer_agent_id(&self) -> Option<&AgentId>
}

impl<R: ServiceRole> Transport<R> for AafpMcpTransport { ... }

pub enum AafpMcpError { ... }
```

**Stream ID:** `const MCP_STREAM_ID: u64 = 4;` (first client-initiated app stream)

**Framing:** Each JSON-RPC message = one DATA frame (frame type 0x01). Payload
= JSON bytes, byte-for-byte preserved.

**Handshake flow (in connect_with_auth / accept_with_auth):**
1. Establish QUIC connection (dial/accept)
2. Extract TLS channel binding via `extract_tls_binding(&conn)` (calls `conn.raw().export_keying_material()`)
3. Drive AAFP v1 handshake (`drive_client_handshake` / `drive_server_handshake`)
4. Authorization (`auth_provider.authorize()`)
5. Session transitions: `on_authorization_verified` → `on_authenticated` → `on_messaging_enabled`
6. Open/accept bidirectional QUIC stream

**Known issue (Plan B3 addresses):** The handshake logic is duplicated between
`aafp-sdk` (AgentClient/AgentServer) and `aafp-transport-mcp`. After B1 adds a
third copy, Plan B3 extracts `establish_session()`.

**Known issue (Plan B3 addresses):** `QuicConnection::raw()` exposes quinn
internals. Plan B3 adds `QuicConnection::export_tls_binding()`.

---

## 10. RFC 0008 (A2A Binding) — Design Summary for Plan B1

**Status:** Proposed (Plan B1 implements it and changes status to Implemented)

**A2A Protocol:** Agent-to-agent communication via JSON-RPC 2.0. Methods use
PascalCase (e.g., `SendMessage`, `GetTask`, `CancelTask`). Targets A2A v1.0.

**11 core operations:**
| A2A Operation | JSON-RPC Method |
|---------------|-----------------|
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

**Error mapping (13 error types):**
| A2A Error Type | JSON-RPC Code |
|----------------|---------------|
| TaskNotFoundError | -32001 |
| TaskNotCancelableError | -32002 |
| PushNotificationNotSupportedError | -32003 |
| UnsupportedOperationError | -32004 |
| ContentTypeNotSupportedError | -32005 |
| InvalidAgentResponseError | -32006 |
| ExtendedAgentCardNotConfiguredError | -32007 |
| ExtensionSupportRequiredError | -32008 |
| VersionNotSupportedError | -32009 |
| ParseError | -32700 |
| InvalidRequest | -32600 |
| MethodNotFound | -32601 |
| InvalidParams | -32602 |
| InternalError | -32603 |

**Data type mappings:** protobuf Message → JSON object (camelCase), bytes →
base64 string, Timestamp → ISO 8601 UTC string, enum → string.

**Streaming:** `SendStreamingMessage` and `SubscribeToTask` use the same
bidirectional QUIC stream. Server sends `TaskStatusUpdateEvent` and
`TaskArtifactUpdateEvent` as sequential JSON-RPC responses. Server signals
completion with `final: true` in event metadata, then closes stream via AAFP
CLOSE frame.

**Full spec:** Read `RFCs/0008-a2a-transport-binding.md` (522 lines).

---

## 11. Known Issues (Source: POST_PUSH_AUDIT.md)

### CRITICAL: 910MB build artifacts in Rust git (Plan A1)
`fuzz/target/` is tracked in git — 4,782 files, 910MB. Every clone downloads
~1GB of useless files. Fix: `git rm -r --cached fuzz/target/` + update .gitignore.

### CRITICAL: CI workflows broken (Plan A2)
1. `actions/checkout@v4` doesn't init submodules → empty impl dirs → all jobs fail
2. `cargo clippy -- -D warnings` fails on 2 pre-existing warnings in `aafp-messaging/src/pipeline.rs`
3. `gofmt -l .` fails — 15 Go files need formatting

### MEDIUM: No release tags (Plan A3)
No immutable release point. `master` can change anytime.

### MEDIUM: RFC headers say "Revision 5" but content is Rev 6 (Plan A3)

### MEDIUM: Stale paragraph in PROTOCOL_CANDIDATE_CHECKLIST.md (Plan A3)
Lines ~137-141 still say "3 of 10 Category A items remain pending" but all 10
are done.

### LOW: Clippy warnings in pipeline.rs (Plan A2)
"this if has identical blocks" and "this if statement can be collapsed" at line ~551.

---

## 12. Build & Test Commands

### Rust
```bash
cd /Users/david/Projects/AAFP-research/implementations/rust
cargo fmt --all -- --check
cargo build --workspace
cargo clippy --workspace
cargo test --workspace
cargo bench --workspace
```

### Go
```bash
cd /Users/david/Projects/AAFP-research/implementations/go
gofmt -l .
go vet ./...
go build ./...
go test ./...
go test -race ./...
```

### Golden traces / interop fixtures
```bash
cd implementations/rust
cargo run --bin generate_golden_traces
cargo run --bin generate_traces
cargo run --bin generate_vectors
cargo run --bin generate_interop_fixtures
cargo run --bin verify_go_fixtures
```

---

## 13. Glossary

| Term | Definition |
|------|------------|
| AAFP | Agent-Agent First Networking Protocol |
| AgentId | SHA-256(ML-DSA-65 public key), 32 bytes |
| AgentRecord | Self-signed CBOR record advertising capabilities + endpoints |
| AEAD | Authenticated Encryption with Associated Data |
| ALPN | Application-Layer Protocol Negotiation (TLS extension) |
| A2A | Agent2Agent Protocol (application layer, JSON-RPC) |
| CBOR | Concise Binary Object Representation (RFC 8949) |
| DCUtR | Direct Connection Upgrade through Relay |
| HKDF | HMAC-based Key Derivation Function (RFC 5869) |
| KEX | Key Exchange |
| MCP | Model Context Protocol (application layer, JSON-RPC) |
| ML-DSA-65 | Module-Lattice Digital Signature Algorithm, level 3 (FIPS 204) |
| ML-KEM-768 | Module-Lattice Key Encapsulation Mechanism, level 3 (FIPS 203) |
| PQ | Post-Quantum |
| QUIC | Quick UDP Internet Connections (RFC 9000) |
| rmcp | Rust MCP SDK (crate) |
| TOFU | Trust On First Use |
| UCAN | User Controlled Authorization Networks (capability delegation) |
| X25519MLKEM768 | Hybrid PQ key exchange (classical X25519 + ML-KEM-768) |

---

## 14. Tracks C-F: 10-Week Execution Plan (2026-07-02)

Tracks A and B are complete (69/70 steps). The next 10 weeks of work
is structured into 4 tracks (16 plans, 148 steps). See `SCHEDULE.md`
for the full timeline.

### Track C — Fixes & Push (Week 1-2, 4 plans)
- **C1:** Fix pyo3 segfault on cleanup + write B2.11 interop test
- **C2:** Clean 910MB git history with filter-repo (**NEEDS USER APPROVAL**)
- **C3:** Push all 3 repos + tags to GitHub remote
- **C4:** Update stale documentation (ROADMAP.md, README.md, etc.)

### Track D — External Interop (Week 2-4, 4 plans)
- **D1:** Test against real Python MCP SDK (`@modelcontextprotocol/python-sdk`)
- **D2:** Test against A2A reference implementation or spec examples
- **D3:** Rust ↔ Go cross-language interop over QUIC (or frame-level)
- **D4:** MCP conformance suite integration

### Track E — Protocol Features (Week 4-7, 4 plans)
- **E1:** PING/PONG keep-alive (RFC-0002 §4.7-4.8, P1-1)
- **E2:** Discovery announce/lookup over QUIC (RFC-0004 §3, P1-2)
- **E3:** Networked PubSub — floodsub over QUIC (RFC 0009, new)
- **E4:** Circuit relay + NAT traversal (RFC 0010, new, P1-8)

### Track F — Production Readiness (Week 7-10, 4 plans)
- **F1:** Performance validation + benchmark framework (P1-5)
- **F2:** Rustdoc documentation for all public APIs (P1-7)
- **F3:** CRL-based revocation mechanism (RFC-0003 amendment)
- **F4:** Persistent DHT backend with SQLite

### Key dependencies
- C3 (push) blocks all of Track D (external testing needs public repos)
- E1 blocks E2 (discovery needs keep-alive for long-lived connections)
- E2 blocks E3, E4, F4 (PubSub/relay/DHT need discovery to find peers)
- E1-E4 block F1 (need features to benchmark them)
- F2, F3 are independent (can run in parallel with anything)

### New RFCs to write
- RFC 0009: PubSub Protocol (E3)
- RFC 0010: Circuit Relay Protocol (E4)
- Amendment to RFC-0003: Revocation Mechanism (F3)

### Items NOT in Tracks C-F (explicitly deferred)
- 0-RTT session resumption (v1.1+)
- Distributed Kademlia DHT (v1.1+, F4 adds persistence but not Kademlia)
- Gossipsub mesh maintenance (E3 implements floodsub, gossipsub is future)
- UCAN authorization enforcement (checking tokens on incoming requests)
- Connection migration (QUIC CID-based)
- Semantic vector index for capability matching
- Reputation system (EigenTrust-style)
- io_uring connection management (Linux)
- Onion routing (privacy layer)
- Autonomous contracting protocol
- Browser/WASM support (v1.2)
- Mobile platform support (v1.0 non-goal)
