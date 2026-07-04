# AAFP North Star — Path to Internet-Ready Agent Networking

**Last updated:** 2026-07-04
**Purpose:** Single source of truth for strategic direction, current state, and
remaining work to make AAFP carry real agent traffic over the public internet.
**Read this first** before any planning or execution.

---

## 1. The Mission

**AAFP's objective is not to replace HTTP. Its objective is to become the
decentralized execution substrate for autonomous software. Transport is only
the foundation. The long-term value lies in creating an adaptive,
capability-aware, self-optimizing network where agents discover, trust,
schedule, migrate, and coordinate work without dependence on centralized
orchestration. Every feature should move the protocol toward a network that
becomes more efficient, resilient, and intelligent as more agents join.**

The competitor is not HTTPS. The competitor is cloud silos — OpenAI APIs,
Anthropic APIs, proprietary agent buses, closed orchestration systems. Those
systems own the agent graph. AAFP should own the **open graph**.

**Success looks like:** A developer writes `Agent::new().discover("python").execute(code)`
and AAFP handles discovery, trust, NAT traversal, routing, and execution —
invisibly. The developer never learns QUIC, UCAN, DHT, or relay reservations.
Every new agent that joins makes the network more capable.

**Full strategic vision:** [`STRATEGIC_VISION.md`](STRATEGIC_VISION.md)

---

## 1.5 The Architecture

```
Applications (MCP, A2A, custom agents)
    ↓
Execution Fabric (scheduling, routing, checkpointing, migration)    ← Future
    ↓
Adaptive Routing Plane (capability graphs, reputation, learning)     ← Future
    ↓
Discovery (semantic capability graphs, not string lookups)           ← Future
    ↓
Trust & Identity (cryptographic + reputation + performance)          ← Partial (Track P)
    ↓
Transport (QUIC + PQ-TLS + CBOR framing + NAT traversal)             ← COMPLETE (Tracks A-N)
    ↓
UDP → IP → the same internet everyone uses
```

**The immutable boundary:**
- **STABLE (barely changes):** Wire format, identity, handshake, frame encoding, QUIC transport
- **EVOLVING (changes constantly):** Routing, scheduling, trust scoring, discovery, prediction, optimization

Never bake algorithms into the protocol. Bake **interfaces**. The wire protocol
is frozen (Rev 6). Everything above it is where the innovation happens.

**The acid test for every RFC:** Does this make the network more intelligent,
or merely more complicated? If "more complicated," it belongs in an
implementation, not the protocol.

---

## 2. Current State (2026-07-04)

### Hard numbers

| Metric | Value |
|--------|-------|
| Rust tests | 1390 passing, 0 failures, 7 ignored |
| Rust crates | 17 (15 workspace + aafp-py + aafp-loadtest) |
| Rust code | ~62,740 lines |
| RFCs | 11 (0001-0011) + 3 amendment sets + 4 reviews |
| Go interop | 664 tests, wire-format library |
| Python adapter | PyO3, MCP SDK 1.28.1 interop verified |
| Round-trip latency | 41.47µs (localhost, 6x improvement from 250µs) |
| Throughput | 776K msg/s (localhost), 1.25M msg/s (lock-free path) |
| Connection pool | 17x faster repeated RPCs |
| Git history | Clean (12MB after filter-repo), pushed to GitHub |

### What's complete and verified

| Area | Tracks | Status | Confidence |
|------|--------|--------|------------|
| Protocol design | RFCs 0001-0011 | Frozen (Rev 6) | High — 3 red-team reviews, 4 review cycles |
| CBOR framing | A, E | Stable | High — cross-verified with Go |
| Post-quantum crypto | A, P | Production-grade | High — FIPS 204, cross-language vectors |
| Handshake (v1) | A, E | Complete | High — state machine, replay cache, close manager |
| QUIC transport | A, I, J | Tuned | High — BBR/Cubic, RTT, ACK, stream window, GSO |
| Identity/PKI | P (8/8) | Complete | High — WoT, CA, rotation, revocation, TrustManager |
| MCP transport binding | B, D | Verified | High — Python MCP SDK 1.28.1 interop |
| A2A transport binding | B, D | Verified | High — v1.0 spec conformance, 40 tests |
| Go wire-format interop | D | Verified | High — 39 fixtures byte-for-byte |
| Zero-copy data path | G | Complete | High — no allocations on send path |
| Lock-free concurrency | H | Complete | High — 1.25M msg/s |
| Connection lifecycle | I | Complete | High — pool, migration, keep-alive, resumption |
| Serialization | K | Complete | Medium — simd-json for MCP decode |
| Kernel/hardware tuning | L | Complete | Medium — kqueue, UDP buffers, CPU pinning |
| Benchmarking | M | Complete | High — regression detection, cross-platform CI |
| Performance optimization | G-M (52/52) | Complete | High — 6.0x cumulative improvement |

### What's partially done (uncommitted, needs review + commit)

| Area | Track | Lines | Status |
|------|-------|-------|--------|
| Relay data forwarding | N1 | 1007 | Uncommitted — `relay_forwarding.rs`, 6 tests, compiles |
| WAN test harness | O1 | 902 | Uncommitted — `wan_test.rs`, examples, scripts |
| Key directory | P2 | 755 | Uncommitted — `key_directory.rs` (P2 may be in beb6201) |
| DHT router | R1 | 1698 | Uncommitted — `dht_router.rs`, Kademlia k-buckets |
| Load test harness | S1 | 1371 | Uncommitted — `aafp-loadtest/` crate, 14 tests |

### What's not started

| Area | Track | Steps | Blocks |
|------|-------|-------|--------|
| AutoNAT dial-back | N2 | 1 | — |
| DCuTR hole punching | N3 | 1 | — |
| Relay discovery | N4 | 1 | — |
| SDK NAT integration | N5 | 1 | N1-N4 |
| NAT test harness | N6 | 1 | N5 |
| Two-machine relay test | N7 | 1 | N6 |
| Relay performance | N8 | 1 | N6 |
| WAN latency/throughput | O2-O8 | 7 | N (NAT traversal) |
| Security audit | Q1-Q8 | 8 | P (COMPLETE) |
| DHT bootstrap/replication | R2-R8 | 7 | O (WAN testing) |
| Load testing at scale | S2-S8 | 7 | N (NAT traversal) |

---

## 3. The Gap: What "Internet-Ready" Requires

### Definition

"Internet-ready" means: **AAFP can carry real agent traffic between two
machines on different networks, behind different NATs, with acceptable
performance, security, and reliability.**

### Gap analysis

| Capability | Have it? | Evidence | Gap |
|-----------|----------|----------|-----|
| Protocol works on localhost | YES | 1390 tests, 41.47µs RTT | — |
| Protocol works over WAN | NO | Zero WAN tests run | Need Track O |
| NAT traversal (relay) | PARTIAL | 1007 lines uncommitted, never tested over real NAT | Need Track N |
| NAT traversal (hole punch) | NO | DCuTR is a stub | Need N3 |
| NAT detection | NO | AutoNAT is a stub | Need N2 |
| Multi-node DHT | PARTIAL | 1698 lines uncommitted, never tested with real nodes | Need Track R |
| Security audit | NO | 5 fuzz targets, never run; no DoS testing | Need Track Q |
| 100+ agent load test | NO | Harness exists, never run above 10 agents | Need Track S |
| Deployment (Docker/K8s) | NO | Zero Dockerfiles, zero K8s manifests | Need S5 |
| Monitoring | NO | No Prometheus, no Grafana, no health endpoint | Need S4 |
| Circuit breaker / resilience | NO | No circuit breaker, no bulkhead, no retry | Future track |
| Gateway/Router separation | NO | All agents do everything | Future track (world-scale) |
| Kernel bypass (XDP/DPDK) | NO | Standard sockets only | Future track (world-scale) |
| Message persistence | NO | DHT records persist (SQLite), messages don't | Future track |

### The phases to "internet-ready" and beyond

**Phase 1: Make it work over the internet (2-3 weeks) — NOW**
- Track O (O1-O8): WAN testing — real network validation
- Track Q (Q1-Q8): Security audit — fuzz, adversarial, DoS
- Track S (S1-S8): Load testing — 100 agents, stability, deployment
- Track R (R1-R8): WAN discovery — multi-node DHT (after O)

**Milestone:** "Two agents on different WiFi networks can connect via relay and exchange messages. 100 agents run for 4 hours without crashes. Fuzzing finds no panics."

**Phase 2: Make it deployable (1-2 weeks)**
- Dockerfile + docker-compose for relay nodes and agents
- Prometheus metrics endpoint + Grafana dashboard
- Deployment runbook (setup, key rotation, debugging, updates)
- 3-line developer API (`Agent::new().discover("python").execute(code)`)

**Milestone:** "Anyone can `docker compose up` and have a working AAFP relay + agent. Developers can build agents without understanding the protocol."

**Phase 3: Build the ecosystem (ongoing)**
- SDK in Rust, Python, TypeScript (3 languages minimum)
- CLI for agent management (`aafp discover`, `aafp connect`, `aafp serve`)
- Examples that work with 3 lines of code
- Tutorials that don't mention QUIC, UCAN, or DHT
- Reference apps (a working multi-agent system people can clone)
- Plugin system for custom capability providers

**Milestone:** "Developers are building agents on AAFP without us asking them to."

**Phase 4: Adaptive Routing Plane (future, after ecosystem forms)**
- Track T: Nodes share resource metrics (CPU, GPU, queue depth, latency, trust)
- Track U: Semantic capability graphs replace string lookups
- Track V: Execution Fabric — work scheduling, pipeline assembly, checkpointing
- Track W: Agent Reputation — performance history becomes part of identity
- Track X: Economic Layer — resource accounting, priority, compensation

**Milestone:** "The network becomes more intelligent as more agents join. Routing optimizes for speed, cost, trust, and reliability automatically."

**Total to internet-ready: ~6-8 weeks (Phases 1-2).**
**Total to ecosystem: ~3-6 months (Phase 3).**
**Total to agent operating system: ~12-18 months (Phases 4-5).**

---

## 4. What "Speed Up AI Agents" Requires

AAFP's protocol overhead is already negligible:
- AAFP RTT: 41.47µs
- LLM inference: 500-80,000ms (10,000-2,000,000x slower)
- HTTP API round-trip: 50-500ms (1,000-12,000x slower)
- WAN network RTT: 50-100ms (1,000-2,400x slower)

**The protocol is not the bottleneck.** Speeding up agents requires:

1. **Actually working over the internet** (Phase 1) — agents can't talk if they can't connect
2. **Smart routing** (future) — route requests to nearest capable agent (DHT + latency awareness)
3. **Connection reuse** (done) — connection pool, keep-alive, session resumption
4. **Streaming** (partial) — A2A streaming exists but is array-based, not true streaming
5. **Caching** (future) — cache LLM responses, tool results, capability lookups
6. **Parallel agent calls** (future) — multiplex multiple agent RPCs over one connection (QUIC streams)

The foundation is fast enough. The gap is in **reachability and reliability** — making the speed usable over real networks.

---

## 5. Architecture: Where We Are vs Where We Need to Go

### Current architecture (works for <100 agents on localhost/LAN)

```
Agent A ←──QUIC──→ Agent B
  (direct connection, both do everything)
```

Each agent: accepts connections + routes messages + runs DHT + runs app logic.
Works for small networks. Breaks at scale because:
- No connection sharding (one agent can't accept 10K connections)
- No message routing separation (agent does both app logic and routing)
- No relay infrastructure (NAT'd agents can't connect)

### Target architecture (works for 100K+ agents over WAN)

```
                    ┌─────────────────────────────────────────────┐
                    │              Global AAFP Network             │
                    │                                              │
                    │  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
                    │  │ Region  │  │ Region  │  │ Region  │    │
                    │  │  US     │  │  EU     │  │  APAC   │    │
                    │  └────┬────┘  └────┬────┘  └────┬────┘    │
                    └───────┼────────────┼────────────┼──────────┘
                            │            │            │
                     ┌──────┴────┐  ┌────┴────┐  ┌────┴────┐
                     │  Gateways │  │ Gateways│  │ Gateways│
                     │  (10K conn│  │ (10K    │  │ (10K    │
                     │   each)   │  │  conn)  │  │  conn)  │
                     └──────┬────┘  └────┬────┘  └────┬────┘
                            │            │            │
                     ┌──────┴────────────┴────────────┴────┐
                     │       Relay Mesh (geo-routed)        │
                     └──────┬────────────┬────────────┬────┘
                            │            │            │
                     ┌──────┴────┐  ┌────┴────┐  ┌────┴────┐
                     │  Agents   │  │  Agents │  │  Agents │
                     │  (LLM,    │  │ (LLM,   │  │ (LLM,   │
                     │   tools)  │  │  tools) │  │  tools) │
                     └───────────┘  └─────────┘  └─────────┘
```

This is a **future** architecture (post-v1). For v1 "internet-ready," we need:
- Agents that can connect through relays (Track N)
- DHT that works over WAN (Track R)
- Basic monitoring and deployment (Track S)

The gateway/router separation is a v2 concern for 100K+ agents.

---

## 6. Track Dependency Graph

```
COMPLETE (270 steps):
  A (hygiene) → B (strategic) → C (fixes) → D (interop)
  → E (protocol) → F (production) → G-M (performance)

IN PROGRESS / NOT STARTED (48 steps):
                    N (NAT Traversal)     ← START HERE (no blockers)
                   / \
                  O   S                  ← Need N
                 /     \
                R       Q                ← R needs O, Q needs P (done)

  N: 8 steps (N1-N8) — relay, AutoNAT, DCuTR, SDK, tests, perf
  O: 8 steps (O1-O8) — WAN test harness, latency, loss, BBR, migration
  P: 8 steps (P1-P8) — COMPLETE ✓
  Q: 8 steps (Q1-Q8) — fuzz, adversarial, DoS, timing, hardening
  R: 8 steps (R1-R8) — multi-node DHT, bootstrap, replication, churn
  S: 8 steps (S1-S8) — load test, stability, metrics, deployment, ops
```

### Execution order

```
Now:     Track N (NAT traversal) — 8 steps, 2-3 weeks
Next:    Track O (WAN testing) + Track Q (security) + Track S (load/ops) — parallel, 2-3 weeks
Then:    Track R (WAN discovery) — 8 steps, 2 weeks
```

---

## 7. Key Research Findings (from WORLD_SCALE_RESEARCH.md)

These findings inform implementation decisions for tracks N-S:

1. **DCUtR success rate:** 70% ± 7.1% for hole punching (4.4M attempts in IPFS).
   TCP and QUIC have comparable rates. 97.6% succeed on first attempt.
   → Target: 70% hole-punch + 20% relay = 90% connection success

2. **QUIC connection migration:** 76% failure rate on hard handoffs (Wi-Fi→cellular).
   → Expect failures in Track O6. Document fallback (reconnect + session resumption).

3. **PQ crypto at scale:** ML-DSA-65 verify = 76-103µs (9.7K-13K/sec per core).
   Add signature verification cache (90% hit rate → 90% CPU reduction).
   → Add SignatureCache in future track, not blocking for v1.

4. **DHT at scale:** IPFS uses k=20, 256-bit keyspace, client/server mode.
   Undialable peer diagnosis is critical (IPFS v0.5.0 got 24x speedup from this).
   → Track R: implement undialable peer removal, adaptive refresh intervals.

5. **BBR fairness:** BBRv3 can grab 99% bandwidth vs Cubic flows.
   → Use Cubic for agent-to-agent RPC (small messages, fair).
   → Use BBR for relay forwarding (bulk transfer, maximize throughput).

6. **Relay capacity:** WebRTC TURN handles 50K-100K concurrent flows.
   coturn: 10K+ sessions on 4 vCPU/8GB RAM.
   → AAFP default max_connections=50 is very conservative. Increase to 1000+ for production.

7. **Resilience patterns:** Circuit breaker (5 failures → open, 30s → half-open).
   Bulkhead (limit concurrent requests per peer). Retry with backoff + jitter.
   → Add in future track, not blocking for v1 but needed for production.

8. **Kernel bypass:** XDP/AF_XDP gives 2-3x throughput (s2n-quic, Solana).
   → Not needed for v1. Plan for v2 when handling 10K+ connections per node.

9. **Message storage:** ScyllaDB (Discord: 72 nodes, trillions of messages, p99 15ms).
   → Not needed for v1 (real-time only). Add for v2 (offline agent support).

10. **GossipSub v1.1:** Peer scoring with 7 parameters prevents Sybil attacks.
    → AAFP's floodsub is fine for v1. Upgrade to gossipsub for v2.

---

## 8. What Does NOT Need to Be Done for "Internet-Ready"

These are explicitly OUT OF SCOPE for v1 "internet-ready" and belong to later phases:

**v2 "world-scale" (after ecosystem forms):**
- Gateway/Router/Agent separation (needed for 100K+ agents)
- Kernel bypass (XDP/DPDK) (needed for 10K+ connections per node)
- Kafka/NATS event bus (needed for decoupling at scale)
- Redis-backed connection state (needed for cross-gateway routing)
- Cross-gateway session migration (needed for gateway failover)
- ScyllaDB/FoundationDB message persistence (needed for offline agents)
- GossipSub peer scoring (needed for attack resistance at scale)
- DPDK for relay nodes (needed for maximum relay throughput)
- Signature verification cache (needed for 100K+ handshakes/sec)
- CCA negotiation (needed for fairness at scale)
- Hierarchical DHT (needed for billion-node scale)
- Global anycast relay network (needed for <30ms relay latency worldwide)

**v3 "agent operating system" (after world-scale):**
- Adaptive Routing Plane (nodes share resource metrics, routing optimizes)
- Semantic Capability Graphs (discovery becomes planning, not string lookup)
- Execution Fabric (work scheduling, pipeline assembly, checkpointing)
- Stateful Mobility (checkpoint, serialize, move, resume)
- Agent Reputation (performance history as part of identity)
- Economic Layer (resource accounting, priority, compensation)
- Autonomous Organizations (10K agents forming persistent self-healing groups)

**Never (stay focused, be the glue):**
- Storage systems (leave to ScyllaDB, FoundationDB, S3)
- Databases (leave to PostgreSQL, MongoDB, Redis)
- Inference engines (leave to vLLM, TGI, TensorRT-LLM)
- Model formats (leave to GGUF, SafeTensors, ONNX)
- Vector databases (leave to Pinecone, Weaviate, Qdrant)
- Blockchain/cryptocurrency (use resource accounting, not tokens)

**v1 = make it work over the internet. v2 = make it scale. v3 = make it intelligent.**

---

## 9. Decision Framework

When deciding what to work on next, use this priority order:

1. **Does it make AAFP work over the real internet?** (Tracks O, R) — HIGHEST
2. **Does it prove AAFP is safe?** (Track Q) — HIGH
3. **Does it prove AAFP scales to 100 agents?** (Track S) — HIGH
4. **Does it make AAFP deployable and invisible to developers?** (S5, S6, ecosystem) — HIGH
5. **Does it make the network more intelligent?** (future tracks T-X) — MEDIUM (after ecosystem)
6. **Does it make AAFP scale to 10K+ agents?** (future tracks) — LOW for v1
7. **Does it optimize performance further?** — LOW (already 6x optimized)

**The acid test for every feature:** Does this make the network more
intelligent, or merely more complicated? If "more complicated," it belongs
in an implementation, not the protocol.

**The adoption test:** Can a developer use this without understanding the
protocol? If no, simplify the API before adding more features.

**The moat test:** Will this feature be a commodity in 5 years? If yes, it's
table stakes, not a competitive advantage. The durable moat is network
effects — the number of interoperable agents and the quality of the
capability graph.

---

## 10. Success Criteria

### "Internet-Ready" (v1 — Phases 1-2)

- [x] Two agents on different networks connect via relay (Track N7 — documented)
- [x] AutoNAT correctly detects NAT status (Track N2)
- [x] DCuTR upgrades relayed to direct for cone NATs (Track N3)
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
- [ ] Developer can build an agent in 3 lines of code (ecosystem)
- [ ] SDK available in at least 2 languages (Rust + Python)

### "Ecosystem Forming" (v2 — Phase 3)

- [ ] SDK available in 3 languages (Rust, Python, TypeScript)
- [ ] CLI tool (`aafp discover`, `aafp connect`, `aafp serve`)
- [ ] 5+ reference applications that people can clone
- [ ] Tutorials that don't mention QUIC, UCAN, or DHT
- [ ] Plugin system for custom capability providers
- [ ] 100+ agents running on the network (not just our tests)
- [ ] At least 1 third-party developer building on AAFP

### "Agent Operating System" (v3 — Phases 4-5)

- [ ] Adaptive Routing Plane: nodes share resource metrics
- [ ] Semantic Capability Graphs: discovery becomes planning
- [ ] Execution Fabric: automatic pipeline assembly
- [ ] Stateful Mobility: checkpoint, move, resume
- [ ] Agent Reputation: performance history as identity
- [ ] Network becomes more efficient as more agents join
- [ ] 10K+ agents, self-organizing, self-healing

---

## 11. Key Files

| File | Purpose |
|------|---------|
| `NORTH_STAR.md` (this file) | Strategic direction and gap analysis |
| `STRATEGIC_VISION.md` | Full strategic vision (the agent operating system) |
| `AAFP_COMPLETE_BRIEFING.md` | Complete briefing for collaborative AI |
| `implementation-plans/STATUS.md` | Tactical step-by-step tracking |
| `implementation-plans/WORLD_SCALE_RESEARCH.md` | Research on world-scale gaps |
| `implementation-plans/CONTEXT.md` | Project background and architecture |
| `ROADMAP.md` | Protocol freeze roadmap (Phase 2, complete) |
| `RFCs/0001-0011` | Protocol specifications (frozen, Rev 6) |
| `implementations/rust/AGENTS.md` | Build & test guide |
| `BUILD.md` | Build from scratch instructions |

---

## 12. Current Track Status (2026-07-04)

| Track | Status | Steps | Blocker |
|-------|--------|-------|---------|
| A-M | COMPLETE | 270/270 | — |
| N | COMPLETE | 8/8 | — |
| O | NOT STARTED | ~1/8 (O1 uncommitted) | N (done) — **START NOW** |
| P | COMPLETE | 8/8 | — |
| Q | NOT STARTED | 0/8 | P (done) — **START NOW** |
| R | NOT STARTED | ~1/8 (R1 uncommitted) | O |
| S | NOT STARTED | ~1/8 (S1 uncommitted) | N (done) — **START NOW** |

**Tests:** 1461 passing, 0 failures, 7 ignored
**Completed:** 278/282 steps (270 A-M + 8 P + 8 N)

**Next action:** Tracks O, Q, S are ALL unblocked — run in parallel.
- Track O builder prompt: `implementation-plans/BUILDER_PROMPT_TRACK_O.txt`
- Track Q builder prompt: `implementation-plans/BUILDER_PROMPT_TRACK_Q.txt`
- Track S builder prompt: `implementation-plans/BUILDER_PROMPT_TRACK_S.txt`
- Track R starts after O completes: `implementation-plans/BUILDER_SCRIPT_TRACK_R.txt`
