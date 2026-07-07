# AAFP North Star — The Agent Operating System

**Last updated:** 2026-07-06
**Purpose:** Single source of truth for strategic direction, current state, and
remaining work. **Read this first** before any planning or execution.

---

## 1. The Mission

**Build the operating system that every autonomous AI naturally runs on.**

Protocols don't win because they're technically better. They win because they
become the easiest way to build things. TCP wasn't fastest. HTTP wasn't most
efficient. JSON wasn't smallest. Linux wasn't prettiest. They became ecosystems.

AAFP should disappear. Nobody thinks about Linux because Linux disappears.
When a developer starts an autonomous agent company tomorrow, they should
choose AAFP not because it's a "technically superior transport protocol" but
because it's the **easiest, most capable, and most adaptive way to build
distributed AI systems**.

**The reframing:** Transport is 15% of the system. The other 85% is the
Intelligence Plane — the layer where network effects actually happen. Every
new agent should make every other agent more useful. That is an exponential
network effect, and that is what makes AAFP impossible to replace.

**Success looks like:** A developer writes `Agent.goal("build an iOS app")`
and the network assembles the pipeline, estimates cost, reserves resources,
executes, recovers failures, and returns the answer. The developer never
learns QUIC, UCAN, DHT, or relay reservations. AAFP disappears.

**Full strategic vision:** [`STRATEGIC_VISION.md`](STRATEGIC_VISION.md)
**Intelligence Plane design:** [`INTELLIGENCE_PLANE.md`](INTELLIGENCE_PLANE.md)

---

## 1.5 The Architecture

```
Applications
────────────────────────────────────────────
Agent Runtime                          ← SDK (Rust, Python, TypeScript) ✅
────────────────────────────────────────────
Execution Fabric                       ← IMPLEMENTED ✅ (plan, scheduler, checkpoint, migration, aggregator, recovery)
────────────────────────────────────────────
Economic Layer                         ← IMPLEMENTED ✅ (accounts, pricing, priority, compensation, slashing)
────────────────────────────────────────────
World Perception Layer                 ← IMPLEMENTED ✅ (search, browse, document-read, API, code-exec, media, sessions)
────────────────────────────────────────────
Adaptive Routing (predictive)          ← IMPLEMENTED ✅ (metrics, scoring, circuit breaker, hedging, temporal prediction)
────────────────────────────────────────────
Semantic Discovery (planning)          ← IMPLEMENTED ✅ (capability graphs, A* planner, intent routing, DHT query)
────────────────────────────────────────────
PubSub + Back-Channeling               ← IMPLEMENTED ✅ (GossipSub, MQTT wildcards, UCAN ACLs)
────────────────────────────────────────────
Agent Reputation (extensions)          ← IMPLEMENTED ✅ (25+ fields, scoring engine, gossip propagation)
────────────────────────────────────────────
Trust / Identity (cryptographic)       ← Complete (Track P)
────────────────────────────────────────────
AAFP Transport (QUIC + PQ-TLS + CBOR)  ← Complete (Tracks A-S)
────────────────────────────────────────────
QUIC
```

**Transport is 15% of the system.** The other 85% is the Intelligence Plane —
where network effects happen. Every new agent should make every other agent
more useful. That is the exponential network effect that makes AAFP
impossible to replace.

**The immutable boundary:**
- **STABLE (barely changes):** Wire format, identity, handshake, frame encoding, QUIC transport
- **EVOLVING (changes constantly):** Routing, scheduling, trust scoring, discovery, prediction, optimization

Never bake algorithms into the protocol. Bake **interfaces**. The wire protocol
is frozen (Rev 6). Everything above it is where the innovation happens.

**The acid test for every RFC:** Does this make the network more intelligent,
or merely more complicated? If "more complicated," it belongs in an
implementation, not the protocol.

**The weekly question:** "If an engineer started an autonomous agent company
tomorrow, what would make them choose AAFP over simply exposing an HTTPS
endpoint?" If the answer is "because it's a technically superior transport
protocol," we're optimizing for the wrong victory condition. If the answer is
"because it's the easiest, most capable, and most adaptive way to build
distributed AI systems," we're on track.

---

## 2. Current State (2026-07-06)

### Hard numbers

| Metric | Value |
|--------|-------|
| Rust tests | **2857 passing**, 0 failures, 7 ignored |
| Rust crates | 19 (18 workspace + aafp-py standalone) |
| Rust code | **~140,000 lines** |
| TypeScript tests | **151 passing**, 0 errors, 12 test files |
| TypeScript packages | 7 (@aafp/cbor, crypto, sdk, sdk-native, transport-quic, transport-ws, examples) |
| TypeScript code | ~9,900 lines |
| Total tests | **3008** (2857 Rust + 151 TypeScript) |
| RFCs | 11 (0001-0011) + 3 amendment sets + 4 reviews |
| Go interop | 664 tests, wire-format library |
| Python adapter | PyO3, MCP SDK 1.28.1 interop verified |
| Round-trip latency | 41.47µs (localhost, 6x improvement from 250µs) |
| Throughput | 776K msg/s (localhost), 1.25M msg/s (lock-free path) |
| Connection pool | **50x faster** repeated RPCs (14µs vs 709µs) |
| DHT scale | 500 nodes, 100% lookup success, <100ms latency |
| Load test | 100 agents, 399K messages, 0% error rate |
| Stability | 4h continuous, 2.5% memory growth (no leaks) |
| Research docs | 8 design documents (~12,800 lines) |
| Builder prompts | 0 remaining (all 51 implemented: 21 transport + 15 IP foundation + 15 Phase 4) |
| Examples | 6 working examples |
| Deployment | Docker, K8s, systemd, Prometheus + Grafana |
| Tracks complete | 326/326 transport + 40/40 Intelligence Plane (ALL DONE) |
| Security review | 4 critical + 12 high (IP) + 2 high (Phase 4) findings fixed |
| Clippy warnings | 0 |
| Freeze tag | v0.5-phase4-complete |

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
| NAT traversal | N (8/8) | Complete | High — relay, AutoNAT, DCuTR, SDK integration |
| WAN testing | O (8/8) | Complete | Medium — localhost simulation, real-world deferred |
| Security audit | Q (8/8) | Complete | High — fuzzing, adversarial, DoS, timing, hardening |
| WAN discovery (DHT) | R (8/8) | Complete | High — Kademlia, bootstrap, replication, churn, partition |
| Load & operations | S (8/8) | Complete | High — 100 agents, stability, metrics, Docker, K8s, ops |
| **Semantic Capability Graphs** | SCG (D1-D6) | **Implemented** | Medium — capability graphs, A* planner, 11 bridge capabilities |
| **AgentRecord Extensions** | ARE (E1-E6) | **Implemented** | Medium — 25+ extension fields, DHT integration |
| **Adaptive Routing Plane** | AR (T1-T7) | **Implemented** | Medium — metrics, scoring, circuit breaker, hedging, retry |
| **PubSub + Back-Channeling** | PS (P1-P6) | **Implemented** | Medium — GossipSub, MQTT wildcards, UCAN ACLs, back-channels |
| **Security hardening** | Review | **Complete** | High — 4 critical + 12 high findings fixed |

---

## 3. The Gap: What "Internet-Ready" Requires — CLOSED

### Definition

"Internet-ready" means: **AAFP can carry real agent traffic between two
machines on different networks, behind different NATs, with acceptable
performance, security, and reliability.**

### Gap analysis — ALL CLOSED

| Capability | Have it? | Evidence | Track |
|-----------|----------|----------|-------|
| Protocol works on localhost | YES | 2857 tests, 41.47µs RTT | A-M |
| Protocol works over WAN | YES | 26 WAN simulation tests, packet loss/BBR validated | O |
| NAT traversal (relay) | YES | Relay forwarding, AutoNAT, DCuTR, SDK integration | N |
| NAT traversal (hole punch) | YES | DCuTR hole punching for cone NATs | N3 |
| NAT detection | YES | AutoNAT dial-back | N2 |
| Multi-node DHT | YES | 500 nodes, 100% lookup, churn, partition recovery | R |
| Security audit | YES | Fuzzing, adversarial, DoS, timing, hardening | Q |
| 100+ agent load test | YES | 100 agents, 399K msgs, 0% error, 4h stability | S |
| Deployment (Docker/K8s) | YES | Dockerfile, docker-compose, K8s, systemd | S5 |
| Monitoring | YES | AgentMetrics, health check, RPC metrics endpoint | S4 |
| Circuit breaker / resilience | NO | Not yet — Phase 4 (Adaptive Routing) | Future |
| Gateway/Router separation | NO | All agents do everything | v2 world-scale |
| Kernel bypass (XDP/DPDK) | NO | Standard sockets only | v2 world-scale |
| Message persistence | NO | DHT records persist (SQLite), messages don't | v2 world-scale |

### The phases to "internet-ready" and beyond

**Phase 1: Make it work over the internet — COMPLETE ✅**
- ~~Track O (O1-O8): WAN testing~~ ✅
- ~~Track Q (Q1-Q8): Security audit~~ ✅
- ~~Track S (S1-S8): Load testing~~ ✅
- ~~Track R (R1-R8): WAN discovery~~ ✅

**Milestone ACHIEVED:** "100 agents run for 4 hours without crashes. Fuzzing
finds no panics. DHT scales to 500 nodes. AAFP survives 5% packet loss."

**Phase 2: Make it deployable and invisible — NEARLY COMPLETE**
- [x] P2.1: 3-line developer API — `Agent::serve().capability("echo").handler(...).start()`
- [x] P2.2: CLI polish — `aafp serve`, `aafp call`, `aafp peers`, `aafp metrics`, `aafp health`, `aafp quickstart`
- [x] P2.3: Quickstart tutorial (5 minutes, no jargon) — docs/QUICKSTART.md
- [x] P2.4: Python SDK high-level API — `from aafp import Agent, Request, Response`
- [x] P2.5: 6 working examples — echo, translation pipeline, python weather, relay setup, multi-agent chat, streaming
- [x] P2.6: Prometheus + Grafana dashboard — 11-panel dashboard, auto-provisioned, docker compose up
- [x] P2.7: Simple API v2 Foundation — Params, metadata, typed errors, per-capability handlers, connection pool, failover
- [x] P2.8: Server-Streaming + Cancellation — streaming handlers, CancellationToken, QUIC stream reset
- [x] P2.TS: **TypeScript SDK — ALL 9 PHASES COMPLETE** (151 tests, 7 packages, 0 errors)
  - CBOR + Crypto (43 tests), Transport (20), Server+Client (60), Streaming+Metrics+Session (30), Browser+MCP (17), Packaging (11)
  - @aafp/cbor, @aafp/crypto, @aafp/sdk, @aafp/sdk-native, @aafp/transport-quic, @aafp/transport-ws, @aafp/examples
- [ ] P2.9: Documentation site (mdbook)
- [ ] P2.10: Install script + Homebrew
- [ ] P2.11: Phase 2 completion report

**Milestone:** "Anyone can `docker compose up` and have a working AAFP relay + agent. Developers can build agents in Rust, Python, or TypeScript without understanding the protocol."

**Phase 2.5: Simple API Adaptation — COMPLETE ✅**

Based on 8 parallel sandbox gap analyses testing the Simple API against mainstream
agentic patterns (MCP, CrewAI/AutoGen, LangChain, browser automation, RAG, code
execution, event-driven webhooks, streaming + HITL), 10 critical gaps were
confirmed. All 10 gaps are now addressed in Rust (P2.7+P2.8) and TypeScript (all 9 phases).

**Key finding:** The gap is in the SDK, not the protocol. All 10 gaps can be
addressed without wire protocol changes. QUIC bi-streams, the MORE flag, stream
reset, and CBOR Maps all exist but weren't exposed through the Simple API.

**Adaptation status:**
- **Phase A:** Simple API v2 — Params, per-capability handlers, streaming, pooling, typed errors — **COMPLETE (Rust P2.7+P2.8, TS all phases)**
- **Phase B:** Streaming RPC — Server-streaming, client-streaming, bidirectional, cancellation — **COMPLETE (Rust P2.8, TS Phase 5)**
- **Phase C:** Session Affinity — ConnectionPool, session state, UCAN delegation — **COMPLETE (Rust P2.7, TS Phase 4)**
- **Phase D:** Semantic Capability Graphs — Multi-dimensional discovery, pipeline assembly — **IMPLEMENTED (SCG D1-D6)**
- **Phase E:** Adaptive Routing + PubSub + AgentRecord Extensions — **IMPLEMENTED (AR T1-T7, PS P1-P6, ARE E1-E6)**

**All 8 research documents complete** (~12,800 lines total):
- `SIMPLE_API_V2_DESIGN.md` (1,528 lines) — v2 API addressing all 10 gaps
- `STREAMING_RPC_DESIGN.md` (1,511 lines) — Streaming RPC over QUIC, no wire changes
- `SESSION_AFFINITY_DESIGN.md` (1,018 lines) — Connection pooling, 50x perf
- `TYPESCRIPT_SDK_DESIGN.md` (2,449 lines) — Hybrid pure-TS + native addon, v2-targeted
- `SEMANTIC_CAPABILITY_GRAPHS.md` (520 lines) — Track U semantic discovery
- `AGENT_RECORD_EXTENSIONS.md` (1,382 lines) — Extension map, attested metrics
- `PUBSUB_BACKCHANNEL_DESIGN.md` (1,004 lines) — PubSub API, back-channeling, MQTT wildcards
- `ADAPTIVE_ROUTING_PLANE.md` (1,647 lines) — Dynamic routing, circuit breaker, hedging

**Builder prompts (ALL IMPLEMENTED):**
- `builder-prompts/` — 15 prompts for SCG (3) + AR (3) + PS (3) + ARE (3) + TS integration — **ALL BUILT**
- TS SDK builder prompts (9) — **ALL COMPLETE** (151 tests passing)
- All 15 Intelligence Plane prompts — **ALL COMPLETE** (84 new tests, security hardened)

**Phase 3: Build the ecosystem (next — this is where network effects happen)**
- [x] SDK in Rust, Python, TypeScript — **3 languages COMPLETE**
- [x] CLI for agent management
- [x] 6 working examples
- [ ] Tutorials that don't mention QUIC, UCAN, or DHT
- [ ] Reference apps (a working multi-agent system people can clone)
- [ ] Plugin system for custom capability providers
- [ ] Public network with independent operators
- [ ] Applications that people actually use (applications drive protocol adoption)

**Milestone:** "Developers are building agents on AAFP without us asking them to."

**Phase 4: The Intelligence Plane — COMPLETE ✅**

This is the shift from "better protocol" to "agent operating system." Transport
is done. The Intelligence Plane is implemented. See [`INTELLIGENCE_PLANE.md`](INTELLIGENCE_PLANE.md).

- Track T: **Predictive Routing** — ✅ **COMPLETE** (AR T1-T7 + T8-T9)
  - PeerMetricsRegistry with EWMA latency/success/load tracking
  - 4 selection strategies (weighted random, P2C, least-connections, lowest-latency)
  - Circuit breaker (3-state: closed/open/half-open), bulkhead, request hedging, retry+backoff
  - AdaptiveRouter integrating all components, observability snapshots + Prometheus export
  - TemporalPredictionEngine: linear regression + EWMA for "who will be fastest 200ms from now?"
  - PredictivePrefetcher: Markov chain for next-capability prediction + connection pre-warming
- Track U: **Semantic Discovery → Intent Routing** — ✅ **COMPLETE** (SCG D1-D6 + U7-U8)
  - SemanticCapability with multi-dimensional metadata (language, cost, GPU, latency, trust, hardware)
  - CapabilityQuery with pattern matching, geo filtering, semantic match
  - CapabilityGraph + HeuristicPlanner (A* search for multi-step pipeline assembly)
  - 11 internet bridge capabilities (search, web-browse, code-execute, etc.)
  - DhtSemanticQuery: hybrid local index + live DHT discovery
  - IntentResolver: "build an iOS app" → ExecutionPlan (goal → plan → execute)
- Track V: **Execution Fabric** — ✅ **COMPLETE** (V1-V6)
  - ExecutionPlan: DAG of tasks with dependencies, resource requirements, cost estimates
  - TaskScheduler: assigns tasks to agents using AdaptiveRouter + reputation + load + cost
  - CheckpointManager: periodic state snapshots for resume-after-failure
  - MigrationManager: move running tasks for load balancing
  - ResultAggregator: merge partial results from parallel workers
  - FailureRecovery: detect failure, re-plan, resume from checkpoint
- Track W: **Agent Reputation** — ✅ **COMPLETE** (ARE E1-E6 + W7-W8)
  - 25+ AgentRecord extension fields (geo, performance, cost, semantic versioning, reputation, attestation, heartbeat)
  - Extension trait system with CBOR encoding/decoding
  - DHT integration for extension-indexed lookups
  - ReputationScoreEngine: weighted scoring (success, latency, cost, availability, attestation)
  - ReputationPropagation: gossip protocol for reputation distribution via PubSub
- Track X: **Economic Layer** — ✅ **COMPLETE** (X1-X5)
  - ResourceAccount: per-agent credit balances with transaction ledger
  - PricingEngine: dynamic pricing based on supply/demand + reputation
  - PriorityQueue: weighted fair queuing for task scheduling
  - CompensationProtocol: escrow-based micropayments (lock → release/refund/slash)
  - SlashingConditions: penalties for failed/malicious work
- Track Y: **World Perception Layer** — ✅ **COMPLETE** (Y1-Y9)
  - Agent-native content schema (WebContent, DocumentContent with CBOR encoding)
  - search: federated web search with mock/real providers
  - web-browse: fetch pages → agent-native content, robots.txt compliance, content cache
  - document-read: parse PDFs/Office docs → structured content
  - api-call: REST API calls with encrypted credential store
  - api-discover: OpenAPI spec parsing → dynamic capability registration
  - code-execute: sandboxed code execution (WASM/Firecracker mock)
  - image-ocr + audio-transcribe: media processing with provider abstraction
  - Stateful browsing sessions with UCAN delegation (create/navigate/click/type/scroll/extract/submit)
  - **Full plan:** [`INTERNET_BRIDGE_PLAN.md`](INTERNET_BRIDGE_PLAN.md)

**Milestone:** "The network becomes more intelligent as more agents join. Routing optimizes for speed, cost, trust, and reliability automatically. Agents perceive and act on the real world through shared capability providers."

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

### "Internet-Ready" (v1 — Phases 1-2) — ACHIEVED

- [x] Two agents on different networks connect via relay (Track N7)
- [x] AutoNAT correctly detects NAT status (Track N2)
- [x] DCuTR upgrades relayed to direct for cone NATs (Track N3)
- [x] WAN test passes with <100ms RTT, <1% packet loss (Track O2)
- [x] BBR vs Cubic tested over WAN, fairness documented (Track O4)
- [x] Fuzz testing runs, no crashes (Track Q2)
- [x] DoS testing: handshake flood, connection flood, large message (Track Q4)
- [x] 100-agent load test passes with <1% error rate (Track S2)
- [x] 4-hour stability test: 2.5% memory growth, no crashes (Track S3)
- [x] AgentMetrics + health check works (Track S4)
- [x] Dockerfile + docker-compose for relay and agent (Track S5)
- [x] Deployment runbook published (Track S6)
- [x] Multi-node DHT: 500 nodes, churn, partition recovery (Track R7)
- [x] Developer can build an agent in 3 lines of code (P2.1 — DONE)
- [x] SDK available in at least 2 languages (Rust + Python — P2.4 DONE)

### "Ecosystem Forming" (v2 — Phase 3)

- [x] SDK available in 3 languages (Rust, Python, TypeScript) — **DONE**
- [x] CLI tool (`aafp serve`, `aafp call`, `aafp peers`, `aafp metrics`, `aafp health`)
- [x] 6 working examples that people can clone
- [ ] Tutorials that don't mention QUIC, UCAN, or DHT
- [ ] Plugin system for custom capability providers
- [ ] 100+ agents running on the network (not just our tests)
- [ ] At least 1 third-party developer building on AAFP
- [ ] Public network with independent operators
- [ ] Applications that people actually use

### "Agent Operating System" (v3 — Phases 4-5)

- [x] Predictive Routing Plane: metrics, scoring, circuit breaker, hedging, retry, temporal prediction — **COMPLETE**
- [x] Semantic Discovery → Intent Routing: capability graphs, A* planner, DHT query, intent resolver — **COMPLETE**
- [x] Agent Reputation: 25+ extension fields, scoring engine, gossip propagation — **COMPLETE**
- [x] PubSub + Back-Channeling: GossipSub, MQTT wildcards, UCAN ACLs — **COMPLETE**
- [x] Execution Fabric: plan, scheduler, checkpoint, migration, aggregator, recovery — **COMPLETE**
- [x] Temporal Routing Engine: "who will be fastest 200ms from now?" — **COMPLETE**
- [x] Economic Layer: resource accounting, pricing, priority, compensation, slashing — **COMPLETE**
- [x] World Perception Layer: search, browse, document-read, API, code-exec, media, sessions — **COMPLETE**
- [ ] Network becomes more efficient as more agents join (exponential network effect) — needs real deployment
- [ ] 10K+ agents, self-organizing, self-healing — needs real deployment

---

## 11. Key Files

| File | Purpose |
|------|---------|
| `NORTH_STAR.md` (this file) | Strategic direction and current state |
| `STRATEGIC_VISION.md` | Full strategic vision (the agent operating system) |
| `INTELLIGENCE_PLANE.md` | The 85% above transport — predictive routing, intent routing, fluid execution |
| `INTERNET_BRIDGE_PLAN.md` | World Perception Layer blueprint (Phase 4) |
| `AAFP_COMPLETE_BRIEFING.md` | Complete briefing for collaborative AI |
| `ADAPTATION_ROADMAP.md` | Synthesized adaptation plan |
| `OVERNIGHT_BUILDER_HANDOFF.md` | Handoff for builder sessions |
| `builder-prompts/INDEX.md` | Build order and cross-track dependencies |
| `implementation-plans/STATUS.md` | Tactical step-by-step tracking |
| `implementation-plans/WORLD_SCALE_RESEARCH.md` | Research on world-scale gaps |
| `ROADMAP.md` | Protocol freeze roadmap + builder prompt index |
| `RFCs/0001-0011` | Protocol specifications (frozen, Rev 6) |
| `implementations/rust/AGENTS.md` | Build & test guide |
| `BUILD.md` | Build from scratch instructions |

---

## 12. Current Track Status (2026-07-06)

| Track | Status | Steps | Tests Added |
|-------|--------|-------|-------------|
| A-M | COMPLETE | 270/270 | ~1300 |
| N | COMPLETE | 8/8 | +105 |
| O | COMPLETE | 8/8 | +26 |
| P | COMPLETE | 8/8 | +66 |
| Q | COMPLETE | 8/8 | +99 |
| R | COMPLETE | 8/8 | +76 |
| S | COMPLETE | 8/8 | +many |
| P2.1-P2.8 | COMPLETE | 8/8 | +62 (Rust) |
| P2.TS | COMPLETE | 9/9 | +151 (TypeScript) |
| SCG (D1-D6) | COMPLETE | 6/6 | +32 |
| ARE (E1-E6) | COMPLETE | 6/6 | +12 |
| AR (T1-T7) | COMPLETE | 7/7 | +50 |
| PS (P1-P6) | COMPLETE | 6/6 | +40 |
| V (V1-V6) | COMPLETE | 6/6 | +92 |
| X (X1-X5) | COMPLETE | 5/5 | +76 |
| Y (Y1-Y9) | COMPLETE | 9/9 | +143 |
| T-ext (T8-T9) | COMPLETE | 2/2 | +25 |
| U-ext (U7-U8) | COMPLETE | 2/2 | +22 |
| W-ext (W7-W8) | COMPLETE | 2/2 | +27 |
| Security reviews | COMPLETE | — | 0 (fixes only) |

**Tests:** 2857 Rust + 151 TypeScript = **3008 total tests passing**, 0 failures
**Completed:** 326/326 transport + 40/40 Intelligence Plane — **ALL COMPLETE**
**Codebase:** 19 Rust crates (~140K lines) + 7 TS packages (~9.9K lines)
**SDKs:** Rust, Python, TypeScript — **3 languages COMPLETE**
**Phase 2:** P2.1-P2.8 + TypeScript SDK — **NEARLY COMPLETE** (docs + install remaining)
**Phase 2.5:** All 5 phases (A-E) — **COMPLETE**
**Phase 4:** All 6 tracks (T, U, V, W, X, Y) — **COMPLETE**
**Adaptation research:** ALL 8 design documents complete (~12,800 lines)
**Builder prompts:** 0 remaining (all 51 implemented)
**Security:** 4 critical + 14 high findings fixed, 0 clippy warnings
**Freeze tag:** v0.5-phase4-complete

### v1 "Internet-Ready" — ACHIEVED

All 19 tracks (A through S) are complete. AAFP is internet-ready:
- Post-quantum transport (ML-DSA-65, X25519MLKEM768, QUIC)
- NAT traversal (relay, AutoNAT, DCuTR hole punching)
- Identity/PKI (WoT, CA certs, key rotation, revocation, TrustManager)
- WAN-tested (packet loss, BBR validation, connection migration)
- Security audited (fuzzing, adversarial, DoS, timing, hardening)
- Load tested (100 agents, 399K messages, 0% error, 4h stability)
- DHT at scale (500 nodes, 100% lookup success, churn tolerance)
- Deployable (Dockerfile, docker-compose, K8s, systemd, ops runbook)
- SDK in 3 languages (Rust, Python, TypeScript)

### What's Next: Ecosystem + Real-World Deployment

The transport is done. The SDKs are done. The Intelligence Plane is COMPLETE
(all 6 tracks: T, U, V, W, X, Y). The remaining work is real-world deployment:

**Phase 3: Build the ecosystem (NOW)**
- Applications that people actually use (applications drive protocol adoption)
- Public network with independent operators
- Tutorials that don't mention QUIC, UCAN, or DHT
- Plugin system for custom capability providers
- Reference apps (multi-agent systems people can clone)

**Phase 5: Real-world validation (NEXT)**
- Deploy on a real network with independent operators
- Validate the Intelligence Plane with real agent workloads
- Wire mock providers to real services (Brave Search, Firecrawl, etc.)
- Test economic layer with real resource accounting
- Validate execution fabric with real distributed workloads
- 10K+ agents, self-organizing, self-healing

**The weekly question:** "If an engineer started an autonomous agent company
tomorrow, what would make them choose AAFP over simply exposing an HTTPS
endpoint?" If the answer is "because it's a technically superior transport
protocol," we're optimizing for the wrong victory condition. If the answer is
"because it's the easiest, most capable, and most adaptive way to build
distributed AI systems," we're on track.
