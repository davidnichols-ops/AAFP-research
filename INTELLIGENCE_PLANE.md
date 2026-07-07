# The Intelligence Plane — The 85% Above Transport

**Created:** 2026-07-05
**Last updated:** 2026-07-06
**Status:** COMPLETE ✅ — All 6 tracks (T, U, V, W, X, Y) implemented. 2857 Rust tests, 0 failures.
**Depends on:** Transport layer (COMPLETE), SDK layer (COMPLETE in 3 languages)

---

## 1. The Thesis

Protocols don't win because they're technically better. They win because they
become the easiest way to build things. TCP wasn't fastest. HTTP wasn't most
efficient. JSON wasn't smallest. Linux wasn't prettiest. They became ecosystems.

AAFP's transport is done — post-quantum, QUIC-native, 2857 tests, 3 SDKs.
Transport is 15% of the system. The other 85% is the **Intelligence Plane**:
the layer where network effects actually happen.

**The shift:** From "build a better protocol" to "build the operating system
that every autonomous AI naturally runs on." AAFP should disappear, the way
Linux disappears.

---

## 2. The Stack

```
Applications
────────────────────────────────────────────
Agent Runtime                          ← SDK (Rust, Python, TypeScript) — COMPLETE
────────────────────────────────────────────
Execution Fabric                       ← Phase 4 (fluid execution)
────────────────────────────────────────────
Global Memory                          ← Phase 4 (shared state, checkpoints)
────────────────────────────────────────────
Adaptive Routing (predictive)          ← Phase 4 (temporal routing engine)
────────────────────────────────────────────
Semantic Discovery (planning)          ← Phase 4 (intent routing, marketplace)
────────────────────────────────────────────
Trust / Identity (cryptographic)       ← COMPLETE (Track P)
────────────────────────────────────────────
AAFP Transport (QUIC + PQ-TLS + CBOR)  ← COMPLETE (Tracks A-S)
────────────────────────────────────────────
QUIC
```

Everything below "Agent Runtime" is the Intelligence Plane. Transport is the
foundation — frozen, stable, boring. The Intelligence Plane is where innovation
happens, where every new agent makes every other agent more useful.

---

## 3. The Five Inventions

### 3.1 Predictive Routing (Track T)

**Today:** Route to least busy node. Reactive.
**Tomorrow:** Route to node predicted to finish first. Predictive.

Every node continuously gossips:
- CPU, GPU, memory utilization
- Latency map (to other nodes)
- Queue depth
- Failure probability
- Expected queue delay
- Bandwidth
- Confidence in predictions

Routers don't react — they **predict**. Instead of "who is fastest?" it becomes
"who will be fastest 200ms from now?" That's a fundamentally different routing
philosophy. It resembles how biological nervous systems work.

**Components:**
- `PeerMetricsRegistry` — EWMA, rolling windows, gossip protocol
- `TemporalRoutingEngine` — predicts future state from current + historical
- `CircuitBreaker` — 3-state (closed, open, half-open), 5 failures → open, 30s → half-open
- `Bulkhead` — limit concurrent requests per peer
- `RequestHedging` — send to 2 agents, use first response (reduces p99)
- `RetryWithBackoff` — exponential backoff with jitter

**Builder prompts ready:** `builder-prompts/AR_T1_T2_METRICS_ROUTING.md`,
`AR_T3_T4_BREAKER_HEDGING.md`, `AR_T5_T7_INTEGRATION_API.md`

### 3.2 Intent Routing (Track U)

**Today:** `lookup("python")` — Google 1998.
**Tomorrow:** `goal("build an iOS app")` — a living marketplace.

Discovery becomes planning:

```
I need someone that:
  - speaks German
  - costs under $0.03
  - has GPU
  - averages under 80ms
  - understands robotics
  - is trusted by OpenAI and Anthropic
  - recently solved similar problems
```

That is no longer discovery. That's a **living marketplace**.

**AgentRecord expanded** (25+ fields):
Identity, capabilities, latency map, geographic location, hardware (GPU/CPU/
memory), price, energy cost, reliability score, historical uptime, current load,
queue depth, predicted completion time, model family, input/output limits,
streaming support, languages, trust graph, recent performance, failure history,
availability window, preferred peers, data locality, bandwidth, version history,
reputation.

**Discovery → Planning:**
```
Goal: Build an iOS app.
Network:
  1. Find everyone required (design, frontend, backend, testing)
  2. Assemble pipeline (topological sort of capabilities)
  3. Estimate cost (sum of per-agent prices × estimated time)
  4. Estimate latency (critical path through pipeline)
  5. Choose execution order (parallelize where possible)
  6. Reserve resources (UCAN capability delegation)
  7. Execute (streaming, checkpointing)
  8. Recover failures (circuit breaker, retry, re-plan)
```

Now the network begins acting like one distributed computer.

**Components:**
- `SemanticCapability` — multi-dimensional descriptor (not just a string)
- `CapabilityQuery` — filter by any combination of dimensions
- `CapabilityIndex` — inverted index for fast multi-dimensional queries
- `CapabilityGraph` — DAG of capabilities, edges = "can compose with"
- `PipelineAssembler` — topological sort + cost/latency estimation
- `CapabilityPlanner` — heuristic + A* search to find optimal pipeline

**Builder prompts ready:** `builder-prompts/SCG_D1_D2_DESCRIPTOR_QUERY.md`,
`SCG_D3_D4_INDEX_COMPOSE.md`, `SCG_D5_D6_PLAN_BRIDGE.md`

### 3.3 Fluid Execution (Track V)

**Today:**
```
Agent A → Agent B → Agent C
```
Static pipeline. Application orchestrates.

**Tomorrow:**
```
Goal
  ↓
Network decides
  ↓
Spawn 83 workers
  ↓
Merge
  ↓
Recover failures
  ↓
Continue
  ↓
Return answer
```
Fluid execution. The network orchestrates.

The application shouldn't orchestrate. The network should. This is the shift
from "agent-to-agent messaging" to "distributed computation."

**Components:**
- `ExecutionPlan` — DAG of tasks, dependencies, resource requirements
- `TaskScheduler` — assigns tasks to agents based on capabilities + load
- `CheckpointManager` — periodic state snapshots, resume after failure
- `MigrationManager` — move running task to different agent (load balancing)
- `ResultAggregator` — merge partial results from parallel workers
- `FailureRecovery` — detect failure, re-plan, resume from checkpoint

**Status:** Not yet designed in detail. Future track.

### 3.4 Agent Reputation (Track W)

Performance history becomes part of identity. Not just "who are you?" but
"how good are you?"

**Components:**
- `ReputationScore` — weighted average of: success rate, latency, cost, availability
- `PerformanceHistory` — rolling window of past N interactions
- `AttestationChain` — UCAN-signed attestations from other agents
- `ReputationPropagation` — gossip protocol for reputation distribution
- `TrustIntegration` — reputation feeds into TrustManager scoring

**Status:** Partially designed in `AGENT_RECORD_EXTENSIONS.md`. Builder prompts ready.

### 3.5 The Economic Layer (Track X)

Resource accounting, priority, compensation. Agents that contribute resources
earn credit. Agents that consume resources spend credit.

**Components:**
- `ResourceAccount` — per-agent balance of credits
- `PricingEngine` — dynamic pricing based on supply/demand
- `PriorityQueue` — higher-paying requests get priority
- `CompensationProtocol` — micropayments for completed work
- `SlashingConditions` — penalties for failed/malicious work

**Status:** Not yet designed. Future track. May integrate with existing
cryptocurrency infrastructure or use a simple credit system.

---

## 4. The Network Effect

**The key insight:** Every new agent should make every other agent more useful.

Today, adding an agent to the network adds one more node to the DHT. That's
linear value. The Intelligence Plane makes it exponential:

1. **More agents → better routing predictions** (more data for the temporal model)
2. **More agents → more pipeline options** (the planner has more choices)
3. **More agents → more specialized capabilities** (niche skills become available)
4. **More agents → better reputation signal** (more attestations, more history)
5. **More agents → more economic liquidity** (more buyers and sellers)

This is the network effect that makes AAFP impossible to replace. No competitor
can bootstrap it. It has to grow organically, and it grows faster as it gets
bigger.

---

## 5. The Protocol Boundary

**Freeze the transport layer aggressively. Resist feature creep.**

Internet protocols that last tend to have:
- Very small cores
- Extremely stable wire formats
- Extensibility around the edges

The wire protocol is frozen (Rev 6). All Intelligence Plane innovation happens
in the SDK and routing layers — no new frame types, no new handshake fields,
no new wire format changes.

**What stays frozen:**
- Frame format (28-byte header + CBOR payload)
- Handshake (ClientHello, ServerHello, ClientFinished)
- Identity (AgentId, AgentRecord, UCAN)
- Transport (QUIC, PQ-TLS, CBOR)

**What evolves constantly:**
- Routing algorithms (predictive, temporal, intent-based)
- Discovery semantics (multi-dimensional, planning)
- Execution policies (scheduling, checkpointing, migration)
- Trust scoring (reputation, performance history)
- Economic models (pricing, compensation)

**The acid test for every new feature:** Does this make the network more
intelligent, or merely more complicated? If "more complicated," it belongs
in an implementation, not the protocol.

---

## 6. Implementation Priority (Next 2 Years)

1. **Make the transport layer effectively "finished"** — resist feature creep ✅
2. **Complete first-class Rust, Python, TypeScript, and Go SDKs** — 3/4 done ✅
3. **Build applications that people actually use** — applications drive adoption
4. **Develop adaptive routing into predictive scheduling** — not reactive
5. **Expand discovery from lookup into semantic planning** — intent routing
6. **Add distributed execution primitives** — fluid execution, spawning
7. **Treat observability as a core feature** — operators need to understand why
8. **Build a public network with independent operators** — infrastructure needs operators

---

## 7. The Weekly Question

Not: "Did we make AAFP faster?"
Not: "Did we add another feature?"

Instead:

> "If an engineer started an autonomous agent company tomorrow, what would
> make them choose AAFP over simply exposing an HTTPS endpoint?"

If the answer becomes "because it's the easiest, most capable, and most
adaptive way to build distributed AI systems," then the project is on a
trajectory toward becoming foundational infrastructure.

If the answer remains "because it's a technically superior transport protocol,"
adoption will likely be much harder, regardless of the protocol's engineering
quality.

---

## 8. Relationship to Existing Research

| Existing Document | Intelligence Plane Track | Status |
|-------------------|-------------------------|--------|
| `ADAPTIVE_ROUTING_PLANE.md` (1,647 lines) | Track T (Predictive Routing) | ✅ COMPLETE |
| `SEMANTIC_CAPABILITY_GRAPHS.md` (520 lines) | Track U (Intent Routing) | ✅ COMPLETE |
| `AGENT_RECORD_EXTENSIONS.md` (1,382 lines) | Track W (Reputation) | ✅ COMPLETE |
| `PUBSUB_BACKCHANNEL_DESIGN.md` (1,004 lines) | Track T (gossip metrics) | ✅ COMPLETE |
| `INTERNET_BRIDGE_PLAN.md` (941 lines) | Track Y (World Perception) | ✅ COMPLETE |
| `PHASE4_BUILDER_SCRIPT.md` (1,787 lines) | Track V (Fluid Execution) | ✅ COMPLETE |
| `PHASE4_BUILDER_SCRIPT.md` (1,787 lines) | Track X (Economic Layer) | ✅ COMPLETE |

All research documents have been implemented. The Intelligence Plane is
complete — the strategic frame is now a working system: the agent operating system.
