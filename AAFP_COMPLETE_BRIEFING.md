# AAFP Complete Briefing for Collaborative AI

**Purpose:** Give another AI assistant everything it needs to understand AAFP
and help make it internet-ready. This document is self-contained — no other
context required.

**Date:** 2026-07-04
**Author:** Devin (GLM-5.2 High), working with David (project owner)

---

## 1. What AAFP Is

**AAFP** (Agent-Agent First Networking Protocol) is a **post-quantum, agent-native
peer-to-peer networking protocol**. It's a secure session layer that sits between
QUIC (transport) and application protocols like MCP (Model Context Protocol) and
A2A (Agent-to-Agent). Think of it as "TCP for AI agents."

**Architecture:**
```
Application Layer (MCP, A2A — JSON-RPC 2.0)
    ↓
AAFP Transport Binding Layer (aafp-transport-mcp, aafp-transport-a2a)
    ↓
AAFP Core Protocol Layer (framing, handshake, session, control frames)
    ↓
Transport Layer (QUIC via quinn + PQ TLS via rustls)
    ↓
UDP → IP → same internet infrastructure everyone uses
```

**Five key differentiators (no competitor offers all five):**
1. Post-quantum by default (ML-DSA-65 signatures + X25519MLKEM768 hybrid KEX)
2. QUIC-native transport (stream multiplexing, 0-RTT, connection migration)
3. UCAN capability chains (cryptographic delegation, hierarchical)
4. CBOR deterministic framing (RFC 8949, 3-5x smaller than JSON)
5. Cross-connection replay protection (time-bounded nonce cache)

**Strategic position:** AAFP is NOT a replacement for MCP or A2A. It's a
transport layer that carries MCP/A2A traffic with post-quantum security and
peer-to-peer connectivity. Adoption path = interop, not replacement.

---

## 2. Technical Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Language | Rust | 2021 edition |
| Async runtime | tokio | 1.x (full features) |
| QUIC | quinn | 0.11 |
| TLS | rustls | 0.23 (prefer-post-quantum, aws-lc-rs) |
| PQ crypto | aws-lc-rs (ML-DSA-65, X25519MLKEM768) | 1.x |
| Serialization | serde + serde_json (app layer), CBOR (framing) | 1.x |
| SQLite | rusqlite (bundled) | 0.31 |
| Fuzzing | cargo-fuzz (libfuzzer) | nightly |
| Python interop | pyo3 + maturin | 0.28 |
| Go interop | Separate Go module (wire-format library) | — |

**17 Rust crates:**
```
aafp-cbor           — Canonical CBOR encoder/decoder (RFC 8949 deterministic)
aafp-crypto         — ML-DSA-65 signatures, AEAD, HKDF, v1 handshake, ReplayCache
aafp-identity       — AgentId, AgentRecord, UCAN capability chains, KeyDirectory, WoT, CA, TrustManager
aafp-core           — Core traits, Session state machine, AuthorizationProvider, handshake state
aafp-transport-quic — QUIC transport via quinn + rustls (PQ TLS)
aafp-messaging      — Frame encoding/decoding, RPC, stream multiplexing, PubSub, PingTracker, CloseManager
aafp-discovery      — Capability-based DHT (in-memory + SQLite persistent), DHT router (Kademlia)
aafp-nat            — NAT traversal (relay v1, AutoNAT, DCuTR, relay forwarding)
aafp-sdk            — High-level Agent SDK (AgentBuilder, AgentClient, AgentServer, handshake driver)
aafp-transport-mcp  — AAFP secure transport binding for MCP Rust SDK (rmcp)
aafp-transport-a2a  — AAFP secure transport binding for A2A protocol (RFC 0008)
aafp-py             — Python PyO3 adapter (standalone, not in workspace)
aafp-cli            — Command-line tool for agent management
aafp-conformance    — RFC conformance test suite + golden trace generation
aafp-benchmark      — Criterion benchmarks for crypto/discovery/messaging/MCP transport
aafp-tests          — Cross-crate integration tests
aafp-loadtest       — Load testing harness (N agents, topologies, metrics)
```

---

## 3. Protocol Design (11 RFCs)

| RFC | Title | Status |
|-----|-------|--------|
| 0001 | Protocol Overview | Frozen (Rev 6) |
| 0002 | Transport & Framing | Frozen (Rev 6) |
| 0003 | Identity & Authentication | Frozen (Rev 6) |
| 0004 | Discovery | Frozen (Rev 6) |
| 0005 | Error Model | Frozen (Rev 6) |
| 0006 | Versioning & Compatibility | Frozen (Rev 6) |
| 0007 | Transport Binding for MCP | Implemented |
| 0008 | Transport Binding for A2A | Implemented |
| 0009 | Networked PubSub Protocol | Implemented |
| 0010 | Circuit Relay Protocol | Implemented (stub → real, in progress) |
| 0011 | Trust Bootstrap for Production | Implemented (Track P complete) |

### Protocol flow (connection lifecycle)

```
1. QUIC connection established (quinn + rustls with PQ TLS)
   - ALPN: "aafp/1"
   - TLS: X25519MLKEM768 hybrid key exchange (post-quantum)
   - TLS channel binding exported for AAFP handshake

2. AAFP v1 handshake (over QUIC stream 0)
   - Client → Server: ClientHello (agent_id, supported_versions, capabilities, nonce, signature)
   - Server → Client: ServerHello (agent_id, selected_version, nonce, signature)
   - Client → Server: ClientFinished (session_id, transcript_hash, signature)
   - Signatures: ML-DSA-65 (post-quantum, FIPS 204)
   - Replay protection: nonce cache (check-before-verify, insert-after-verify)
   - Session ID: derived from transcript hash + TLS channel binding

3. Session established (SessionState: MessagingEnabled)
   - All subsequent communication uses AAFP frames over QUIC streams
   - Multiple RPCs multiplexed over separate QUIC streams (no head-of-line blocking)

4. Messaging (DATA frames, RPC, PubSub)
   - Frame format: [28-byte header] [CBOR payload]
   - Frame types: DATA(0x01), HANDSHAKE(0x02), RPC(0x03), RPC_RESPONSE(0x04),
                  ERROR(0x05), CLOSE(0x06), PING(0x07), PONG(0x08),
                  SUBSCRIBE(0x09), UNSUBSCRIBE(0x0A), PUBLISH(0x0B)
   - RPC: JSON-RPC 2.0 over AAFP frames (method, params, result, error)
   - PubSub: floodsub (v1), gossipsub (future v2)

5. Graceful close (CLOSE frame)
   - CloseManager: 5-state machine (Open → LocalCloseSent → RemoteCloseReceived → CloseReceived → Closed)
   - RFC-0002 §6.6 compliant

6. Keep-alive (PING/PONG)
   - PingTracker: interval 30s, timeout 10s, max_missed 3
   - Background task sends PING on stream 0, expects PONG within timeout
```

### Identity & Trust (RFC 0003 + 0011)

```
AgentId: 32-byte BLAKE3 hash of ML-DSA-65 public key
AgentRecord: {agent_id, public_key, capabilities, endpoints, expires_at, signature}
UCAN: capability delegation chain (Agent A delegates "run-code" to Agent B, signed)
Trust levels: 0 (unknown), 1 (directory), 2 (WoT), 3 (CA-certified)
TrustManager: combines KeyDirectory + WebOfTrust + CACertificate + Revocation
TrustPolicy: Strict (reject unknown), Cautious (prompt), Permissive (TOFU)
Key rotation: old key signs new key, old key revoked after grace period
Revocation: CRL (Certificate Revocation List) distributed via gossip + DHT
```

### Discovery (RFC 0004)

```
Capability DHT: key = capability string (e.g., "code-execution"), value = list of AgentRecords
DHT operations: announce(agent_record), lookup(capability) → Vec<AgentRecord>
Persistent backend: SQLite (WAL mode, indexes on capabilities and expiry)
DHT router (Track R, in progress): Kademlia-style, 256 k-buckets, k=20, XOR distance
Bootstrap: seed nodes, DNS, mDNS (local)
RPC methods: aafp.discovery.announce, aafp.discovery.lookup, aafp.discovery.pex
Rate limits: announce 1/60s, lookup 10/60s per connection
```

### NAT Traversal (RFC 0010)

```
Relay protocol: reservation (reserve/renew/cancel), relayed connection (connect)
Relay forwarding: relay opens QUIC bi-stream to target, copies bytes bidirectionally
Wire format: data streams start with [0xFF magic + 8-byte connection_id] header
AutoNAT: agent asks peers to dial back, determines if behind NAT
DCuTR: both peers exchange observed addresses via relay, simultaneously dial each other
NAT types: cone NAT (DCuTR works, ~70% success), symmetric NAT (relay only, ~30%)
```

---

## 4. Current State (2026-07-04)

### Hard numbers

| Metric | Value |
|--------|-------|
| Rust tests | 1456 passing, 0 failures, 7 ignored |
| Rust crates | 17 (15 workspace + aafp-py + aafp-loadtest) |
| Rust code | ~66,170 lines |
| RFCs | 11 (frozen) + 3 amendment sets + 4 reviews |
| Go interop | 664 tests, wire-format library |
| Python adapter | PyO3, MCP SDK 1.28.1 interop verified |
| Round-trip latency | 41.47µs (localhost, 6x improvement from 250µs) |
| Throughput | 776K msg/s (localhost), 1.25M msg/s (lock-free path) |
| Connection pool | 17x faster repeated RPCs |
| Git commits | 82 (Rust submodule), clean history (12MB) |
| GitHub | Pushed to davidnichols-ops/aafp and davidnichols-ops/AAFP-research |

### What's COMPLETE and verified (270 steps across tracks A-M + P)

| Area | Tracks | Key achievement |
|------|--------|-----------------|
| Production hygiene | A | Build artifacts removed, CI fixed, tags created, RFCs bumped to Rev 6 |
| Strategic value | B | A2A transport binding, Python PyO3 adapter, shared handshake extraction |
| Fixes & push | C | PyO3 segfault fixed, git history cleaned (910MB→12MB), pushed to GitHub |
| External interop | D | Python MCP SDK 1.28.1, A2A v1.0 spec, Rust↔Go wire-format interop |
| Protocol features | E | PING/PONG keep-alive, discovery over QUIC, networked PubSub, relay protocol |
| Production readiness | F | Performance benchmarks, rustdoc, CRL revocation, persistent DHT (SQLite) |
| Zero-copy data path | G | No allocations on send path, BytesMut buffer pool |
| Lock-free concurrency | H | Lock-free DHT reads (ArcSwap), sharded DHT (256-way), lock-free receive path |
| Connection lifecycle | I | TLS session resumption, connection pool, migration (rebind), adaptive keep-alive |
| QUIC tuning | J | BBR/Cubic, RTT estimation, ACK delay, stream window, GSO |
| Serialization | K | Serialization baseline, simd-json for MCP decode |
| Kernel & hardware | L | kqueue tuning, UDP buffer sizing, CPU pinning, huge pages |
| Benchmarking | M | Regression detection, cross-platform CI matrix, performance dashboard |
| Identity & PKI | P | RFC 0011, KeyDirectory, Web of Trust, CA certificates, key rotation, revocation, TrustManager |

### What's PARTIALLY done (uncommitted, needs review + commit)

| Area | Track | Lines | What exists | What's missing |
|------|-------|-------|-------------|----------------|
| Relay data forwarding | N1 | 1007 | `relay_forwarding.rs`: RelayServer, RelayClient, forward_data(), 6 tests | Commit, verify over real network |
| WAN test harness | O1 | 902 | `wan_test.rs`, examples, shell scripts, docs | Commit, run against real remote server |
| DHT router | R1 | 1698 | `dht_router.rs`: RoutingTable (256 k-buckets), DhtRouter, DhtTransport trait, PEX | Commit, wire to QUIC transport, multi-node tests |
| Load test harness | S1 | 1371 | `aafp-loadtest/`: config, topology, runner, metrics, CLI, 14 tests | Commit, run 100-agent test |

### What's NOT started (43 steps across tracks N-S)

| Track | Steps | What | Blocker |
|-------|-------|------|---------|
| N2-N8 | 7 | AutoNAT dial-back, DCuTR hole punching, relay discovery, SDK integration, NAT tests, two-machine test, relay perf | — (start here) |
| O2-O8 | 7 | WAN latency/throughput, packet loss, BBR vs Cubic, cross-network interop, migration, multi-node DHT, WAN report | N |
| Q1-Q8 | 8 | Threat model, fuzz testing, adversarial handshake, resource exhaustion, timing side-channels, malformed input, hardening, security report | P (done) |
| R2-R8 | 7 | Bootstrap, replication, churn handling, query optimization, partition handling, multi-node test, DHT scale report | O |
| S2-S8 | 7 | 100-agent load test, stability test, metrics/observability, deployment docs, ops runbook, stress testing, production report | N |

---

## 5. The Problem We Need Help With

**AAFP has never carried a single packet over the real internet.**

All 1456 tests run on localhost. The 41.47µs RTT is a localhost number. The
protocol design is solid, the crypto is production-grade, the performance is
excellent — but we don't know if it actually works over a real WAN with:
- 50-100ms network RTT (vs <1ms on localhost)
- Packet loss (0.1-1% on real networks)
- NATs (home WiFi, corporate firewalls, cellular networks)
- BBR vs Cubic fairness issues with other internet traffic
- Connection migration (WiFi → cellular handoffs, 76% failure rate)
- Real adversarial conditions (DoS, malformed input, replay attacks)

### The 3 phases to "internet-ready"

**Phase 1: Make it work over the internet (2-3 weeks)**
- Track N (N1-N8): NAT traversal — relay forwarding, AutoNAT, DCuTR, SDK integration
- Track O (O1-O8): WAN testing — at least ONE real two-machine test

**Phase 2: Prove it's safe and scales (2-3 weeks)**
- Track Q (Q1-Q8): Security audit — fuzz all parsers, DoS testing, adversarial testing
- Track S (S2-S8): Load testing — 100-agent test, 4-hour stability, metrics, deployment

**Phase 3: Make it deployable (1-2 weeks)**
- Dockerfile + docker-compose for relay nodes and agents
- Prometheus metrics endpoint + Grafana dashboard
- Deployment runbook

### What we need from you (ChatGPT 5.5)

We need help with **any** of these areas:

1. **NAT traversal implementation** (Track N) — making relay forwarding, AutoNAT, and DCuTR actually work over real networks. The code exists but is stubs or uncommitted.

2. **WAN testing strategy** (Track O) — how to test over real networks, what to measure, how to simulate packet loss and high latency, BBR vs Cubic fairness testing.

3. **Security audit** (Track Q) — fuzzing strategy, adversarial test scenarios, DoS mitigation, timing side-channel analysis.

4. **Load testing at scale** (Track S) — how to simulate 100+ agents, what metrics matter, how to detect memory leaks, deployment packaging.

5. **Architecture review** — are we missing anything critical for internet-readiness? Are there design flaws that would only show up over real networks?

6. **World-scale architecture** — the `WORLD_SCALE_RESEARCH.md` document identifies 8 areas where AAFP needs augmentation for millions of agents (gateway/router separation, kernel bypass, global relay mesh, etc.). We need help prioritizing and implementing these.

---

## 6. Key Research Findings

These are the most important findings from our research that inform implementation:

### NAT traversal
- **DCUtR success rate:** 70% ± 7.1% for hole punching (from 4.4M attempts in IPFS production network). TCP and QUIC have comparable success rates. 97.6% of successes on first attempt.
- **NAT types:** 15-20% of consumer connections need relay. 40-60% of enterprise. Symmetric NAT (~20% of NATs) cannot be hole-punched — relay is the only option.
- **QUIC connection migration:** 76% failure rate on hard handoffs (Wi-Fi→cellular). Need active migration initialization, not passive.

### Post-quantum crypto at scale
- **ML-DSA-65 performance:** keygen 133µs, sign 272µs, verify 76µs (9.7K-13K verifies/sec per core).
- **At scale:** 500K verifications/sec needs 150 CPU cores. With 90% cache hit rate: 15 cores (90% reduction).
- **Key insight:** "Post-quantum crypto is 3-4 orders of magnitude faster than the LLM call it's protecting." The performance overhead argument is no longer valid.

### DHT at scale
- **IPFS Kademlia:** k=20 bucket size, 256-bit keyspace, client/server mode. 24x speedup from undialable peer diagnosis (v0.5.0).
- **Bamboo DHT:** handles median node session times of 1.4 minutes. Periodic recovery (not reactive) is better under churn. Adaptive refresh intervals based on observed churn rate.
- **Key insight:** Flat DHT fails at second-scale agent churn. Need hierarchical clustering for billion-scale.

### Congestion control
- **BBRv3 unfairness:** can grab 99% bandwidth vs Cubic flows. Use Cubic for agent-to-agent RPC (small messages, fair). Use BBR for relay forwarding (bulk transfer).
- **QUIC implementation differences:** 11 QUIC stacks show significant variation. "Speciation risk" — implementations no longer resemble kernel TCP.

### Kernel bypass
- **XDP/AF_XDP:** 2-3x throughput improvement (s2n-quic, Solana Afterburner: 4.7M TPS). More practical than DPDK (doesn't need dedicated NIC).
- **DPDK:** 21.6x latency improvement but requires dedicated hardware, 100% CPU on polling cores.
- **io_uring zero-copy RX:** 41% improvement over epoll (kernel 6.11+).

### Resilience patterns
- **tower-resilience crate (v0.10):** 16 production-ready patterns (circuit breaker, bulkhead, retry, rate limiter, health check, hedge, coalesce, fallback, reconnect, outlier detection, adaptive concurrency, time limiter, router, cache, executor, chaos).
- **Recommendation:** Implement directly in aafp-sdk (simpler than adopting Tower's Service trait).

### World-scale architecture
- **WhatsApp:** 2M connections per server (Erlang, lightweight processes, vertical scaling first).
- **Discord:** 5M concurrent users (gateway servers → guild processes → ScyllaDB, 15K sessions per relay).
- **Key pattern:** Separate connection plane (gateway) from coordination plane (router) from storage plane (persistence).
- **Current AAFP:** All agents do everything. Works for hundreds, breaks at thousands. Need gateway/router separation for 100K+.

---

## 7. Repository Structure

```
/Users/david/Projects/AAFP-research/          ← umbrella repo
├── NORTH_STAR.md                              ← strategic direction (NEW)
├── ROADMAP.md                                 ← protocol freeze roadmap (complete)
├── README.md                                  ← project overview
├── BUILD.md                                   ← build from scratch guide
├── PERFORMANCE_REPORT.md                      ← performance results
├── RELEASE_READINESS.md                       ← pre-release assessment
├── RFCs/                                      ← 11 protocol specs + amendments + reviews
│   ├── 0001-protocol-overview.md
│   ├── 0002-transport-framing.md
│   ├── 0003-identity-authentication.md
│   ├── 0004-discovery.md
│   ├── 0005-error-model.md
│   ├── 0006-versioning-compatibility.md
│   ├── 0007-mcp-transport-binding.md
│   ├── 0008-a2a-transport-binding.md
│   ├── 0009-pubsub.md
│   ├── 0010-circuit-relay.md
│   └── 0011-trust-bootstrap.md
├── implementation-plans/
│   ├── STATUS.md                              ← step-by-step tracking (current)
│   ├── CONTEXT.md                             ← project background
│   ├── WORLD_SCALE_RESEARCH.md                ← research on world-scale gaps
│   ├── BUILDER_PROMPT_TRACK_N.txt             ← NAT traversal builder prompt
│   ├── track-n-nat-traversal/N-nat-traversal.md
│   ├── track-o-wan-testing/O-wan-testing.md
│   ├── track-p-identity-pki/P-identity-pki.md
│   ├── track-q-security-audit/Q-security-audit.md
│   ├── track-r-wan-discovery/R-wan-discovery.md
│   └── track-s-load-operations/S-load-operations.md
├── implementations/
│   ├── rust/                                  ← Rust submodule (github.com/davidnichols-ops/aafp)
│   │   ├── crates/                            ← 17 crates (see section 2)
│   │   ├── fuzz/                              ← 5 fuzz targets
│   │   ├── AGENTS.md                          ← build & test guide
│   │   └── Cargo.toml                         ← workspace manifest
│   └── go/                                    ← Go submodule (wire-format interop)
└── test-results/                              ← JSON test results + HTML dashboard
```

### Build & test commands
```bash
cd /Users/david/Projects/AAFP-research/implementations/rust
cargo fmt --all -- --check    # formatting (0 diffs expected)
cargo build --workspace        # build (0 warnings expected)
cargo clippy --workspace -- -D warnings  # lints (0 warnings expected)
cargo test --workspace         # 1456 tests, 0 failures expected
```

---

## 8. How AAFP Works in Real Life

### The scenario
You have an AI agent on your laptop ("Research Agent") that needs to talk to an agent on another machine ("Code Agent") that can run Python code.

### Without AAFP (today)
```
Research Agent → HTTPS → Cloud API (OpenAI/Anthropic/etc.) → HTTPS → Code Agent
```
- Centralized (cloud sees all data, can go down, can rate-limit)
- No cryptographic agent identity (trust the cloud)
- Classical TLS (breakable by quantum computer)
- HTTP overhead (new connection per request, or HTTP/2 over TCP)

### With AAFP
```
Research Agent (laptop, behind home WiFi NAT)
    ↓ QUIC (UDP, post-quantum TLS)
    ↓ AutoNAT: "I'm behind NAT" (peers tried to dial back, failed)
    ↓ DHT lookup: "who has capability aafp.relay?" → finds relays
    ↓ Reserves slot on nearest relay
    ↓ DHT lookup: "who has capability code-execution?" → finds Code Agent
    ↓ Connects to Code Agent via relay (relay forwards QUIC stream)
    ↓ AAFP handshake (ML-DSA-65 identity, PQ key exchange, UCAN capability check)
    ↓ DCuTR: exchange addresses, simultaneously dial each other (hole punch)
    ↓ Direct connection (70% success) or stay on relay (30%)
    ↓ MCP/A2A messages flow over QUIC streams (multiplexed, no head-of-line blocking)
Code Agent (other machine, behind different NAT)
```

### What's different
- **No mandatory middleman:** relay only needed for NAT, can't read traffic (end-to-end TLS), replaceable
- **Post-quantum security:** ML-DSA-65 + X25519MLKEM768, quantum computer can't break it
- **Capability discovery:** DHT "who can run code?" instead of hardcoded URLs
- **QUIC not TCP:** no head-of-line blocking, connection migration, 0-RTT resumption
- **UCAN not API keys:** cryptographic delegation chains, expire, revocable
- **Same internet:** same cables, routers, ISPs, DNS — just QUIC+PQ-TLS+CBOR instead of TCP+TLS+JSON

---

## 9. What's NOT Better (Honest Limitations)

1. **More complex than HTTPS.** QUIC + PQ-TLS + DHT + NAT traversal + UCAN is a lot of moving parts.
2. **Not faster for single requests.** Advantage is in persistent multi-agent communication, not one-shot API calls.
3. **Requires agents to be online.** P2P — if the other agent is offline, you can't talk. (Message persistence is v2.)
4. **NAT traversal isn't 100%.** ~70% hole punch success, 30% need relay (adds latency).
5. **It's early.** 1456 tests pass on localhost. Zero tests over real internet. Protocol design is solid but unproven over WAN.

---

## 10. Success Criteria for "Internet-Ready"

13-item checklist — when all checked, AAFP is internet-ready:

- [ ] Two agents on different networks connect via relay (Track N7)
- [ ] AutoNAT correctly detects NAT status (Track N2)
- [ ] DCuTR upgrades relayed to direct for cone NATs (Track N3)
- [ ] WAN test passes with <100ms RTT, <1% packet loss (Track O2)
- [ ] BBR vs Cubic tested over WAN, fairness documented (Track O4)
- [ ] Fuzz testing runs 1+ hour per target, no crashes (Track Q2)
- [ ] DoS testing: handshake flood, connection flood, large message (Track Q4)
- [ ] 100-agent load test passes with <5% error rate (Track S2)
- [ ] 4-hour stability test: no memory leaks, no crashes (Track S3)
- [ ] Prometheus metrics endpoint works (Track S4)
- [ ] Dockerfile + docker-compose for relay and agent (Track S5)
- [ ] Deployment runbook published (Track S6)
- [ ] Multi-node DHT: 10 nodes, churn, partition recovery (Track R7)

**Currently 0/13 checked.** All work is in tracks N-S (43 steps remaining).

---

## 11. What We Need From You

We need help with any of these:

1. **Implement Track N (NAT Traversal)** — The builder prompt is at `implementation-plans/BUILDER_PROMPT_TRACK_N.txt`. Key tasks: make relay forwarding work over real networks, implement AutoNAT dial-back, implement DCuTR hole punching, integrate into SDK.

2. **Design WAN testing strategy** — How to test over real networks with realistic conditions (packet loss, latency, NAT types). What metrics to collect. How to run BBR vs Cubic fairness tests.

3. **Security audit plan** — Which fuzz targets to prioritize, what adversarial scenarios to test, how to mitigate DoS, timing side-channel analysis.

4. **Scale architecture** — How to get from 100 agents to 100K+ agents. Gateway/router separation, connection sharding, relay mesh, monitoring.

5. **Code review** — Review the uncommitted work (relay_forwarding.rs, dht_router.rs, key_directory.rs, aafp-loadtest/) for correctness and quality.

6. **Anything else you see** — Are we missing something critical? Is there a design flaw? Is there a simpler path to internet-ready?

---

## 12. Key Files to Read

If you want to dive into the code:

| File | What |
|------|------|
| `NORTH_STAR.md` | Strategic direction and gap analysis |
| `implementation-plans/STATUS.md` | Current step-by-step status (all tracks) |
| `implementation-plans/WORLD_SCALE_RESEARCH.md` | Research on world-scale gaps (14 findings) |
| `implementation-plans/CONTEXT.md` | Full project background |
| `RFCs/0001-protocol-overview.md` | Start here for protocol understanding |
| `RFCs/0002-transport-framing.md` | Frame format, handshake, close, PING/PONG |
| `RFCs/0010-circuit-relay.md` | Relay protocol (NAT traversal) |
| `RFCs/0011-trust-bootstrap.md` | Trust model (WoT, CA, rotation, revocation) |
| `implementations/rust/AGENTS.md` | Build & test guide |
| `implementations/rust/crates/aafp-sdk/src/lib.rs` | Agent struct (main entry point) |
| `implementations/rust/crates/aafp-nat/src/relay_v1.rs` | Relay service (reservations) |
| `implementations/rust/crates/aafp-nat/src/relay_forwarding.rs` | Relay data forwarding (uncommitted) |
| `implementations/rust/crates/aafp-discovery/src/dht_router.rs` | Kademlia DHT router (uncommitted) |
| `implementations/rust/crates/aafp-identity/src/key_directory.rs` | Key directory (uncommitted) |
| `implementations/rust/crates/aafp-loadtest/src/runner.rs` | Load test runner (uncommitted) |

---

## 13. Contact & Collaboration

- **Project owner:** David
- **Current AI assistant:** Devin (GLM-5.2 High)
- **Repository:** github.com/davidnichols-ops/AAFP-research (umbrella)
- **Rust submodule:** github.com/davidnichols-ops/aafp
- **Go submodule:** github.com/davidnichols-ops/aafp-go

If you (ChatGPT 5.5) have suggestions, code changes, or architectural recommendations, communicate them clearly and we'll integrate. If you see something wrong, say so — we value honest technical assessment over agreement.

**The goal is simple:** Make AAFP carry real agent traffic over the real internet with post-quantum security. Everything else is secondary.
