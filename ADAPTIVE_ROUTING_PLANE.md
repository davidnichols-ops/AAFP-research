# Adaptive Routing Plane (Track T) — Design Document

**Status:** Design Document
**Track:** T — Adaptive Routing (Phase 2)
**Date:** 2025-01-15
**Depends on:** Track U (Semantic Capability Graphs), Phase A (Simple API v2), Phase C (Session Affinity)

---

## Executive Summary

AAFP's current discovery is **static**: it finds agents by exact capability-string
match and always calls the first candidate (`candidates[0]`). There is no
consideration of real-time latency, load, success rate, availability, or cost.
The Adaptive Routing Plane (Track T) overlays a **dynamic metrics layer** on top
of the static capability graph so that `discover("ocr").call(...)` routes to the
agent that is *currently* best — not merely the first one that registered.

This document specifies:

1. The metrics collection model (passive + active + hybrid).
2. A scoring function that combines a **static capability-match score** (from
   Track U) with a **dynamic health/performance score** (from Track T).
3. Routing algorithms: weighted random, power-of-two choices, least-connections,
   and EWMA-latency scoring — with guidance on when to use each.
4. Resilience patterns: circuit breakers, request hedging, and metric-staleness
   handling.
5. Integration with the Semantic Capability Graph (Track U) via a combined
   `score_candidate()` function.
6. A comparison with gRPC client-side LB, Envoy/xDS, Istio destination rules,
   Netflix Hystrix concurrency limits, and Finagle request hedging.
7. The API surface — transparent by default, configurable by opt-in.
8. An implementation roadmap with concrete Rust code.

The guiding principle, taken from `STRATEGIC_VISION.md`, is that **routing is
evolving intelligence, not immutable protocol**. The wire format (RFC 0002) does
not change. Everything in this document lives above the transport and is
implemented in the SDK and discovery crates.

---

## 1. What the Strategic Vision Says About Track T

`STRATEGIC_VISION.md` positions the Adaptive Routing Plane as a **first-class,
core RFC-track component**, not an optional add-on.

### 1.1 The Stack

The vision's stack diagram places the Adaptive Routing Plane directly above
Discovery and below the Execution Fabric:

```
Execution Fabric (scheduling, routing, checkpointing, migration)
    ↓
Adaptive Routing Plane (capability graphs, reputation, learning)   ← Track T
    ↓
Discovery (semantic capability graphs, not string lookups)         ← Track U
    ↓
Trust & Identity (cryptographic + reputation + performance)
    ↓
Transport (QUIC + PQ-TLS + CBOR framing + NAT traversal)
```

### 1.2 The Living Map

> Every node continuously shares: CPU, GPU, queue depth, latency, packet loss,
> memory, trust, uptime, energy, region, cost, carbon, historical reliability.
>
> Every node builds a living map. Routing becomes "which execution path is
> optimal?" instead of "who has capability X?"

This is the core requirement: routing must be an **optimization** problem, not a
**lookup** problem.

### 1.3 Performance as Identity

The vision's "Agent Reputation" section makes performance part of identity:

> Need: OCR → 99.97% success rate → 4ms median latency → 95th percentile 7ms
> → 1.3 million successful requests → Selected

Track T provides the *real-time* slice of this; Track W (Agent Reputation)
provides the *historical* slice. They compose.

### 1.4 The Protocol Should Learn

> Request → Outcome → Learning → Routing improves

Track T is the mechanism by which every call improves future routing. The
metrics collected passively from each call feed back into the routing table.

### 1.5 The Immutable Boundary

The vision is explicit that routing algorithms are **evolving**, not frozen:

```
WHAT STAYS STABLE (wire protocol):     WHAT EVOLVES (everything above):
- Frame format (RFC 0002)              - Routing algorithms
- Handshake (RFC 0003)                 - Discovery semantics
- Identity (AgentId, ML-DSA-65)        - Scheduling strategies
- CBOR encoding                        - Trust scoring
- QUIC transport                       - Reputation systems
```

Therefore Track T introduces **no wire-protocol changes**. Metrics are exchanged
via existing RPC mechanisms (`aafp.metrics` already exists per Track S4) and
passive client-side observation. New algorithms ship in the SDK.

### 1.6 Phase Placement

The roadmap places Track T in **Phase 2**, after the foundation (Phase 1: tracks
O/Q/S/R) and before Semantic Discovery (Phase 3: Track U). However, the
dependency graph in `ADAPTATION_ROADMAP.md` shows Track T depending on Track U
("Adaptive Routing — requires D (capability graph as base)"). In practice Track T
can ship a **v1 that works on top of string-based discovery** and a **v2 that
composes with semantic scores** once Track U lands. This document covers both.

---

## 2. Analysis of Current Static Discovery

### 2.1 The DHT Is a Flat Lookup

`crates/aafp-discovery/src/capability_dht.rs` implements an in-memory
`HashMap<DhtKey, Vec<DhtRecord>>` where `DhtKey = SHA-256(capability_string)`.
The `get()` method returns *all* agents advertising a capability, in insertion
order, with no ranking:

```rust
pub fn get(&self, capability: &str) -> Vec<&AgentRecord> {
    let key = Self::hash_capability(capability);
    self.store
        .get(&key)
        .map(|records| records.iter().map(|r| &r.agent_record).collect())
        .unwrap_or_default()
}
```

There is no notion of "better" or "worse" candidates — only "present" or
"absent".

### 2.2 The SDK Always Picks `candidates[0]`

`crates/aafp-sdk/src/simple.rs`, in `DiscoveryBuilder::call()`:

```rust
let candidates = self.agent.find_by_capability(&self.capability);
if candidates.is_empty() { /* error */ }
let peer = &candidates[0];   // ← always the first
let addr = peer.endpoints.first()...;
call_agent(self.agent, &addr, request).await
```

This is the single point of failure documented as Gap #10 in
`ADAPTATION_ROADMAP.md` ("discover() only tries [0] — no failover"). Phase A3 of
the Simple API v2 work adds basic failover (try all candidates in order), but
failover is *reactive* — it only kicks in after a failure. Track T makes
selection *proactive* — it picks the best candidate *before* failure occurs.

### 2.3 Existing Metrics Are Server-Side Only

`crates/aafp-sdk/src/metrics.rs` defines `AgentMetrics` with lock-free
`AtomicU64` counters (connections, messages, bytes, handshakes, failures,
uptime) and a `HealthStatus` enum (Healthy/Degraded/Unhealthy) derived from
those counters. There is also a `MetricsRpcResponse` serializable to CBOR for
the `aafp.metrics` RPC method (Track S4).

**What exists:**
- Server-side counters for *self*-monitoring.
- A health-check derivation from those counters.
- A CBOR/JSON serialization for exporting metrics.

**What is missing for Track T:**
- **Client-side** observation: the caller does not record per-peer latency,
  success rate, or error types from its own calls.
- **Per-peer** metrics store: `AgentMetrics` is per-agent (self), not a map of
  `AgentId → PeerMetrics`.
- **Routing decision**: nothing consumes metrics to choose among candidates.
- **EWMA / rolling windows**: only cumulative counters exist; no time-decayed
  estimates.
- **Circuit breaker**: `HealthStatus` is informational; nothing opens a circuit
  to *prevent* calls to a failing peer.

Track T fills all of these gaps.

---

## 3. Dynamic Metrics Collection Model

### 3.1 Three Collection Modes

| Mode | Source | Freshness | Overhead | Trust |
|------|--------|-----------|----------|-------|
| **Passive** | Client measures its own calls (latency, success, errors) | Real-time for called peers; none for uncalled | Zero extra traffic | High (self-observed) |
| **Active** | Server reports via `aafp.metrics` RPC or gossip | Fresh for all peers | Periodic probing traffic | Medium (self-reported, spoofable) |
| **Hybrid** | Passive + periodic health probes + optional gossip | Best coverage | Moderate | Highest |

**Recommendation: Hybrid, passive-first.** Passive metrics are free, accurate,
and require no protocol support. Active probing fills in data for peers the
client hasn't recently called. Gossip (sharing peer observations with other
agents) is a Phase-3+ enhancement and is *not* required for v1.

### 3.2 The Per-Peer Metrics Store

The core data structure is a `PeerMetricsRegistry`: a map from `AgentId` to a
`PeerMetrics` record that holds EWMA estimates, a rolling success window, and
circuit-breaker state.

```rust
use aafp_identity::AgentId;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// EWMA (exponentially weighted moving average) estimator.
///
/// `alpha` controls how quickly the estimate adapts to new samples.
/// A common choice is `alpha = 2 / (N + 1)` where N is the effective
/// window size in samples. For N=20, alpha ≈ 0.095.
#[derive(Clone, Debug)]
pub struct Ewma {
    value: f64,
    alpha: f64,
    initialized: bool,
}

impl Ewma {
    pub fn new(alpha: f64) -> Self {
        assert!((0.0..=1.0).contains(&alpha), "alpha must be in [0,1]");
        Self { value: 0.0, alpha, initialized: false }
    }

    /// Update with a new sample and return the updated estimate.
    pub fn update(&mut self, sample: f64) -> f64 {
        if !self.initialized {
            self.value = sample;
            self.initialized = true;
        } else {
            self.value = self.alpha * sample + (1.0 - self.alpha) * self.value;
        }
        self.value
    }

    pub fn value(&self) -> f64 { self.value }
    pub fn is_initialized(&self) -> bool { self.initialized }
}

/// A fixed-capacity rolling window for success/failure tracking.
///
/// Uses a bitset: 1 = success, 0 = failure. Capacity is a power of two
/// for cheap modulo indexing. Default capacity: 64 samples.
#[derive(Clone, Debug)]
pub struct RollingWindow {
    bits: u64,
    index: u8,
    capacity: u8,
    count: u8,
}

impl RollingWindow {
    pub fn new(capacity: u8) -> Self {
        assert!(capacity <= 64, "capacity must be <= 64");
        Self { bits: 0, index: 0, capacity, count: 0 }
    }

    pub fn record(&mut self, success: bool) {
        let mask = 1u64 << self.index;
        if success {
            self.bits |= mask;
        } else {
            self.bits &= !mask;
        }
        self.index = (self.index + 1) % self.capacity;
        if self.count < self.capacity { self.count += 1; }
    }

    /// Success rate over the window in [0.0, 1.0].
    pub fn success_rate(&self) -> f64 {
        if self.count == 0 { return 1.0; } // optimistic default
        let ones = self.bits.count_ones() as f64;
        ones / self.count as f64
    }

    pub fn sample_count(&self) -> u8 { self.count }
}

/// Dynamic metrics tracked per remote agent (peer).
#[derive(Clone, Debug)]
pub struct PeerMetrics {
    pub agent_id: AgentId,

    // ── Latency ──────────────────────────────────────────────
    /// EWMA of round-trip latency in milliseconds.
    pub latency_ewma_ms: Ewma,
    /// Minimum observed latency (cold-cache lower bound).
    pub latency_min_ms: f64,

    // ── Success / Failure ────────────────────────────────────
    /// Rolling success/failure window.
    pub success_window: RollingWindow,
    /// Consecutive failures (for circuit breaker).
    pub consecutive_failures: u32,
    /// Consecutive successes (for half-open recovery).
    pub consecutive_successes: u32,

    // ── Load ─────────────────────────────────────────────────
    /// Active in-flight requests to this peer (incremented on send,
    /// decremented on response/error).
    pub in_flight: u32,
    /// Last reported queue depth (from active probe or gossip).
    pub queue_depth: Option<u32>,
    /// Last reported active connections (from `aafp.metrics` RPC).
    pub reported_active_conns: Option<u64>,

    // ── Cost ─────────────────────────────────────────────────
    /// Last reported cost per invocation in micro-USD.
    pub cost_micro_usd: Option<u64>,

    // ── Availability ─────────────────────────────────────────
    /// Last time we successfully communicated with this peer.
    pub last_seen: Instant,
    /// Last active health-probe result.
    pub last_health: Option<HealthProbeResult>,

    // ── Circuit Breaker ──────────────────────────────────────
    pub circuit: CircuitState,
}

/// Result of an active health probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HealthProbeResult {
    Healthy,
    Degraded,
    Unhealthy,
    Unreachable,
}

/// Circuit breaker state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CircuitState {
    /// Normal operation. Requests flow.
    Closed,
    /// Tripped. Requests are short-circuited (rejected immediately).
    Open,
    /// Trial period after cooldown. One request is allowed through;
    /// success → Closed, failure → Open.
    HalfOpen,
}

/// Thread-safe registry of per-peer metrics.
pub struct PeerMetricsRegistry {
    peers: Mutex<HashMap<AgentId, PeerMetrics>>,
    /// Config: EWMA alpha for latency.
    pub latency_alpha: f64,
    /// Config: rolling window capacity.
    pub window_capacity: u8,
    /// Config: consecutive failures to trip the circuit.
    pub failure_threshold: u32,
    /// Config: cooldown before half-open attempt.
    pub cooldown: Duration,
    /// Config: how long before metrics are considered "stale".
    pub staleness_threshold: Duration,
}

impl PeerMetricsRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            peers: Mutex::new(HashMap::new()),
            latency_alpha: 0.1,          // ~20-sample effective window
            window_capacity: 64,
            failure_threshold: 5,
            cooldown: Duration::from_secs(10),
            staleness_threshold: Duration::from_secs(60),
        })
    }

    /// Get or create metrics for a peer.
    pub fn get_or_create(&self, agent_id: &AgentId) -> PeerMetrics {
        let mut peers = self.peers.lock().unwrap();
        peers.entry(*agent_id).or_insert_with(|| PeerMetrics {
            agent_id: *agent_id,
            latency_ewma_ms: Ewma::new(self.latency_alpha),
            latency_min_ms: f64::MAX,
            success_window: RollingWindow::new(self.window_capacity),
            consecutive_failures: 0,
            consecutive_successes: 0,
            in_flight: 0,
            queue_depth: None,
            reported_active_conns: None,
            cost_micro_usd: None,
            last_seen: Instant::now(),
            last_health: None,
            circuit: CircuitState::Closed,
        }).clone()
    }

    /// Record the outcome of a call to a peer (passive observation).
    pub fn record_outcome(
        &self,
        agent_id: &AgentId,
        latency_ms: f64,
        success: bool,
    ) {
        let mut peers = self.peers.lock().unwrap();
        let m = peers.entry(*agent_id).or_insert_with(|| {
            PeerMetrics {
                agent_id: *agent_id,
                latency_ewma_ms: Ewma::new(self.latency_alpha),
                latency_min_ms: f64::MAX,
                success_window: RollingWindow::new(self.window_capacity),
                consecutive_failures: 0,
                consecutive_successes: 0,
                in_flight: 0,
                queue_depth: None,
                reported_active_conns: None,
                cost_micro_usd: None,
                last_seen: Instant::now(),
                last_health: None,
                circuit: CircuitState::Closed,
            }
        });

        // Latency
        m.latency_ewma_ms.update(latency_ms);
        if latency_ms < m.latency_min_ms {
            m.latency_min_ms = latency_ms;
        }

        // Success window
        m.success_window.record(success);
        m.last_seen = Instant::now();

        // Circuit breaker transitions
        if success {
            m.consecutive_failures = 0;
            m.consecutive_successes += 1;
            match m.circuit {
                CircuitState::HalfOpen => {
                    // Trial succeeded → close the circuit.
                    m.circuit = CircuitState::Closed;
                }
                _ => {}
            }
        } else {
            m.consecutive_successes = 0;
            m.consecutive_failures += 1;
            if m.consecutive_failures >= self.failure_threshold {
                m.circuit = CircuitState::Open;
            }
        }
    }

    /// Increment in-flight count when sending a request.
    pub fn inflight_inc(&self, agent_id: &AgentId) {
        let mut peers = self.peers.lock().unwrap();
        if let Some(m) = peers.get_mut(agent_id) {
            m.in_flight = m.in_flight.saturating_add(1);
        }
    }

    /// Decrement in-flight count when a response or error arrives.
    pub fn inflight_dec(&self, agent_id: &AgentId) {
        let mut peers = self.peers.lock().unwrap();
        if let Some(m) = peers.get_mut(agent_id) {
            m.in_flight = m.in_flight.saturating_sub(1);
        }
    }

    /// Check whether a peer's circuit allows a request.
    /// If `Open` and cooldown has elapsed, transitions to `HalfOpen`.
    pub fn check_circuit(&self, agent_id: &AgentId) -> CircuitState {
        let mut peers = self.peers.lock().unwrap();
        if let Some(m) = peers.get_mut(agent_id) {
            if m.circuit == CircuitState::Open {
                if m.last_seen.elapsed() >= self.cooldown {
                    m.circuit = CircuitState::HalfOpen;
                }
            }
            return m.circuit;
        }
        CircuitState::Closed // unknown peer: optimistic
    }

    /// Whether metrics are stale (no observation within threshold).
    pub fn is_stale(&self, agent_id: &AgentId) -> bool {
        let peers = self.peers.lock().unwrap();
        match peers.get(agent_id) {
            Some(m) => m.last_seen.elapsed() >= self.staleness_threshold,
            None => true, // no data at all → stale
        }
    }
}
```

### 3.3 Active Probing

Active probing uses the existing `aafp.metrics` RPC (Track S4) to pull
`MetricsRpcResponse` from a peer. This gives us `reported_active_conns`,
`queue_depth` (if the server exposes it), and a `HealthStatus` that can be
mapped to `HealthProbeResult`.

```rust
use aafp_sdk::metrics::{MetricsRpcResponse, HealthStatus};

fn map_health(h: HealthStatus) -> HealthProbeResult {
    match h {
        HealthStatus::Healthy => HealthProbeResult::Healthy,
        HealthStatus::Degraded => HealthProbeResult::Degraded,
        HealthStatus::Unhealthy => HealthProbeResult::Unhealthy,
    }
}

/// Probe a peer by calling its `aafp.metrics` RPC.
pub async fn probe_peer(
    agent: &SdkAgent,
    addr: &str,
    registry: &PeerMetricsRegistry,
    agent_id: &AgentId,
) -> Result<HealthProbeResult, SdkError> {
    // Reuse the existing call_agent path with a metrics RPC request.
    let rpc = RpcRequest::new(1, "aafp.metrics");
    let resp = call_metrics_rpc(agent, addr, rpc).await?;
    let metrics_resp = MetricsRpcResponse::from_cbor(&resp)
        .map_err(|e| SdkError::Messaging(e.to_string()))?;

    let result = map_health(metrics_resp.health);

    // Update registry with reported load.
    {
        let mut peers = registry.peers.lock().unwrap();
        if let Some(m) = peers.get_mut(agent_id) {
            m.reported_active_conns = Some(metrics_resp.metrics.connections_active);
            m.last_health = Some(result);
            m.last_seen = Instant::now();
        }
    }
    Ok(result)
}
```

**Probe cadence:** Probes run on a jittered interval (e.g., 10s ± 2s) *only* for
peers the client is actively considering. Probing every peer in the DHT would be
wasteful. The probe target set = candidates returned by the last discovery query
for a capability the client uses.

### 3.4 Gossip (Phase 3+)

In a dense network, passive + active probing gives each client good data about
peers it talks to. Gossip — periodically sharing `PeerMetrics` summaries with
neighbors — lets a client learn about peers it has *never* called. This is
valuable but introduces trust questions (a peer could gossip false data about a
competitor). Gossip is deferred to Phase 3 and requires reputation-weighted
merging (Track W).

---

## 4. Routing Algorithm Design

### 4.1 The Scoring Function

Every candidate agent receives a composite score:

```
total_score = w_static * static_score + w_dynamic * dynamic_score
```

- `static_score ∈ [0, 1]` — how well the capability matches the query (Track U).
  For string-based discovery (pre-Track-U), this is `1.0` for any match.
- `dynamic_score ∈ [0, 1]` — current health/performance (Track T).
- `w_static + w_dynamic = 1`. Default: `w_static = 0.5, w_dynamic = 0.5`.
  When the query has hard constraints (e.g., "latency < 40ms"), static filtering
  happens *first* and only survivors are scored dynamically.

### 4.2 Dynamic Score Components

The dynamic score is a weighted product of normalized sub-scores:

```rust
/// Configuration for dynamic scoring weights.
#[derive(Clone, Debug)]
pub struct DynamicScoreConfig {
    pub weight_latency: f64,
    pub weight_success: f64,
    pub weight_load: f64,
    pub weight_availability: f64,
    pub weight_cost: f64,
    /// Reference latency (ms) for normalization. Latency at or below this
    /// scores 1.0; latency at 5x scores ~0.
    pub latency_ref_ms: f64,
    /// Cost reference (micro-USD) for normalization.
    pub cost_ref_micro_usd: f64,
}

impl Default for DynamicScoreConfig {
    fn default() -> Self {
        Self {
            weight_latency: 0.35,
            weight_success: 0.30,
            weight_load: 0.15,
            weight_availability: 0.15,
            weight_cost: 0.05,
            latency_ref_ms: 50.0,
            cost_ref_micro_usd: 100, // $0.0001
        }
    }
}

/// Compute the dynamic score for a peer.
///
/// Returns a value in [0.0, 1.0]. Higher is better.
pub fn dynamic_score(
    metrics: &PeerMetrics,
    config: &DynamicScoreConfig,
    now: Instant,
    staleness_threshold: Duration,
) -> f64 {
    // ── Circuit breaker: hard gate ───────────────────────────
    if metrics.circuit == CircuitState::Open {
        return 0.0;
    }
    if metrics.circuit == CircuitState::HalfOpen {
        // Allow but penalize — we're not sure yet.
        return 0.1;
    }

    // ── Staleness penalty ────────────────────────────────────
    let age = now.duration_since(metrics.last_seen);
    let stale = age > staleness_threshold;
    if stale {
        // No recent data: return a neutral-default rather than 0,
        // so unknown peers aren't permanently starved.
        return 0.5;
    }

    // ── Latency score: inverse, normalized ───────────────────
    // score = max(0, 1 - (latency / (5 * ref)))
    let latency = metrics.latency_ewma_ms.value();
    let latency_score = if metrics.latency_ewma_ms.is_initialized() {
        (1.0 - (latency / (5.0 * config.latency_ref_ms))).max(0.0)
    } else {
        0.5 // no latency data yet
    };

    // ── Success score: directly from rolling window ──────────
    let success_score = metrics.success_window.success_rate();

    // ── Load score: penalize high in-flight / queue depth ────
    let inflight = metrics.in_flight as f64;
    let queue = metrics.queue_depth.unwrap_or(0) as f64;
    let load_raw = inflight + queue;
    // score = 1 / (1 + load_raw)  — smooth decay
    let load_score = 1.0 / (1.0 + load_raw);

    // ── Availability score: from health probe ────────────────
    let availability_score = match metrics.last_health {
        Some(HealthProbeResult::Healthy) => 1.0,
        Some(HealthProbeResult::Degraded) => 0.5,
        Some(HealthProbeResult::Unhealthy) => 0.1,
        Some(HealthProbeResult::Unreachable) => 0.0,
        None => 0.7, // no probe data: mildly optimistic
    };

    // ── Cost score: inverse, normalized ──────────────────────
    let cost_score = match metrics.cost_micro_usd {
        Some(c) => {
            (1.0 - (c as f64 / (5.0 * config.cost_ref_micro_usd as f64))).max(0.0)
        }
        None => 0.8, // no cost data: assume moderate
    };

    // ── Weighted combination ─────────────────────────────────
    let total_weight = config.weight_latency
        + config.weight_success
        + config.weight_load
        + config.weight_availability
        + config.weight_cost;

    let score = (config.weight_latency * latency_score
        + config.weight_success * success_score
        + config.weight_load * load_score
        + config.weight_availability * availability_score
        + config.weight_cost * cost_score)
        / total_weight;

    score.clamp(0.0, 1.0)
}
```

### 4.3 Selection Strategies

Once every candidate has a `total_score`, we must pick one. Four strategies are
provided; the default is **power-of-two choices**.

#### 4.3.1 Weighted Random

```rust
use rand::Rng;

/// Pick a candidate with probability proportional to its score.
pub fn select_weighted_random(
    candidates: &[(AgentId, f64)], // (id, score)
    rng: &mut impl Rng,
) -> Option<AgentId> {
    let total: f64 = candidates.iter().map(|(_, s)| s).sum();
    if total <= 0.0 {
        // All zero (e.g., all circuits open): fall back to uniform.
        return candidates.choose(rng).map(|(id, _)| *id);
    }
    let mut r = rng.gen_range(0.0..total);
    for (id, score) in candidates {
        r -= score;
        if r <= 0.0 {
            return Some(*id);
        }
    }
    candidates.last().map(|(id, _)| *id)
}
```

**Pros:** Simple, spreads load probabilistically.
**Cons:** Can pick a low-scoring candidate by chance; not great for small
candidate sets.

#### 4.3.2 Power-of-Two Choices (P2C) — Default

Pick two candidates at random, then choose the one with the higher score. This
is the strategy used by Finagle and Envoy's "least-request" LB. It gives
near-optimal load balancing with O(1) overhead and no global state.

```rust
/// Power-of-two choices: pick 2 random candidates, return the better one.
pub fn select_power_of_two(
    candidates: &[(AgentId, f64)],
    rng: &mut impl Rng,
) -> Option<AgentId> {
    if candidates.is_empty() { return None; }
    if candidates.len() == 1 { return Some(candidates[0].0); }

    let i = rng.gen_range(0..candidates.len());
    let j = {
        let mut j = rng.gen_range(0..candidates.len());
        if j == i { j = (j + 1) % candidates.len(); }
        j
    };

    let (id_a, score_a) = &candidates[i];
    let (id_b, score_b) = &candidates[j];

    if score_a >= score_b { Some(*id_a) } else { Some(*id_b) }
}
```

**Pros:** Excellent load distribution; avoids worst-case picks; no need to scan
all candidates.
**Cons:** Requires ≥2 candidates; with exactly 2 it's deterministic-best.

#### 4.3.3 Least-Connections

Pick the candidate with the lowest `in_flight` count. Ties broken by score.

```rust
/// Pick the candidate with the fewest in-flight requests.
pub fn select_least_connections(
    candidates: &[(AgentId, f64, u32)], // (id, score, in_flight)
) -> Option<AgentId> {
    candidates
        .iter()
        .min_by_key(|(_, _, inflight)| *inflight)
        .map(|(id, _, _)| *id)
}
```

**Pros:** Directly targets load; great for long-lived streaming calls.
**Cons:** Requires accurate in-flight tracking; doesn't account for latency.

#### 4.3.4 EWMA-Latency (Pick-Lowest-Latency)

Pick the candidate with the lowest EWMA latency. Ties broken by success rate.

```rust
/// Pick the candidate with the lowest EWMA latency.
pub fn select_lowest_latency(
    candidates: &[(AgentId, f64, f64, f64)], // (id, score, latency_ewma, success_rate)
) -> Option<AgentId> {
    candidates
        .iter()
        .min_by(|a, b| {
            a.2.partial_cmp(&b.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal))
        })
        .map(|(id, _, _, _)| *id)
}
```

**Pros:** Best for latency-sensitive workloads.
**Cons:** Can herd all traffic to one fast peer, causing overload.

### 4.4 Strategy Selection Guidance

| Workload | Recommended Strategy | Rationale |
|----------|---------------------|-----------|
| General RPC, many candidates | P2C | Best balance of quality and load distribution |
| Few candidates (1-3) | Weighted random | P2C degenerates with tiny sets |
| Long-lived streaming | Least-connections | In-flight is the dominant factor |
| Latency-critical (sub-50ms SLA) | EWMA-latency | Directly optimizes the SLA metric |
| Cost-sensitive | Weighted random with high cost weight | Spreads spend across cheap peers |

The default is P2C with fallback to weighted-random when `candidates.len() < 4`.

---

## 5. Circuit Breaker Pattern

### 5.1 State Machine

The circuit breaker has three states, as encoded in `CircuitState`:

```
        consecutive_failures >= threshold
   Closed ───────────────────────────────────────► Open
     ▲                                                │
     │ trial request succeeds                         │ cooldown elapsed
     │                                                ▼
     └─────────────────────────────────────────── HalfOpen
                          trial request fails ──► Open
```

- **Closed:** Normal operation. Every call goes through. Failures increment
  `consecutive_failures`; successes reset it. When failures reach the threshold,
  transition to **Open**.
- **Open:** Calls are short-circuited — the router returns an error *without*
  dialing. After `cooldown` elapses, transition to **HalfOpen**.
- **HalfOpen:** Exactly one trial request is allowed through. If it succeeds,
  transition to **Closed**. If it fails, transition back to **Open** and restart
  the cooldown timer.

### 5.2 Integration with Routing

The circuit breaker is checked *before* any scoring:

```rust
/// Filter candidates by circuit state and compute scores.
pub fn score_candidates(
    candidates: &[AgentRecord],
    registry: &PeerMetricsRegistry,
    static_scores: &[f64],          // from Track U query matching
    dyn_config: &DynamicScoreConfig,
) -> Vec<(AgentId, f64)> {
    let now = Instant::now();
    candidates
        .iter()
        .zip(static_scores.iter())
        .filter_map(|(record, &static_score)| {
            let circuit = registry.check_circuit(&record.agent_id);
            if circuit == CircuitState::Open {
                return None; // hard skip
            }
            let metrics = registry.get_or_create(&record.agent_id);
            let dyn_score = dynamic_score(
                &metrics, dyn_config, now, registry.staleness_threshold,
            );
            // HalfOpen peers get a heavy penalty but aren't skipped,
            // so the trial request can go through if no better option exists.
            let total = 0.5 * static_score + 0.5 * dyn_score;
            Some((record.agent_id, total))
        })
        .collect()
}
```

### 5.3 Comparison with Netflix Hystrix

Netflix Hystrix popularized the circuit breaker for service-to-service calls.
Key parallels and differences:

| Aspect | Hystrix | AAFP Track T |
|--------|---------|--------------|
| Trip condition | Error % over threshold in a time window | Consecutive failures ≥ threshold (simpler, no time-window bookkeeping) |
| Half-open | Single trial request | Single trial request (identical) |
| Fallback | User-provided fallback function | Caller gets `SdkError::CircuitOpen`; fallback is caller's responsibility |
| Concurrency limit | Semaphore-based bulkhead | `in_flight` tracking + least-connections routing (soft limit) |
| Isolation | Thread-per-dependency | QUIC stream-per-call (natural isolation via transport) |
| Timeout | Per-call timeout | Per-call deadline (from RequestMetadata, Phase A) |

**Why consecutive failures instead of error-rate window:** AAFP agents may have
low call volume (a few calls per minute). A time-window error rate is noisy with
small samples. Consecutive failures is a simpler, more robust signal for
low-traffic peers. For high-traffic peers, the rolling `success_window` provides
the rate-based view and can be used as an *additional* trip condition in v2.

### 5.4 Concurrency Limits (Hystrix-style Bulkhead)

Beyond the circuit breaker, a concurrency limit prevents a single slow peer from
exhausting the client's connection pool. This is configured per-peer:

```rust
/// Per-peer concurrency limit. Calls beyond this are queued or rejected.
pub struct ConcurrencyLimit {
    pub max_inflight: u32,
    pub max_queue_depth: u32,
}

/// Check whether a peer can accept another in-flight request.
pub fn can_admit(
    metrics: &PeerMetrics,
    limit: &ConcurrencyLimit,
) -> bool {
    metrics.in_flight < limit.max_inflight
}
```

When a peer is at capacity, the router skips it and tries the next candidate.
This is the AAFP analog of Hystrix's semaphore bulkhead, but applied at the
*routing* layer rather than the *thread* layer (AAFP is async, so there are no
thread pools to isolate).

---

## 6. Request Hedging

### 6.1 Pattern

Request hedging sends the same request to *two* agents simultaneously and uses
the first response. The second is cancelled (QUIC stream reset). This
dramatically reduces tail latency at the cost of ~2x load on the fast path.

Finagle uses this extensively. It is most valuable when:
- Latency variance is high (some peers are occasionally slow).
- The workload is read-only or idempotent.
- The cost of duplicate work is low relative to the latency savings.

### 6.2 Implementation

```rust
use tokio::select;
use tokio::time::timeout;

/// Send a request to two agents and return the first response.
/// The loser is cancelled via QUIC stream reset.
pub async fn call_with_hedging(
    agent: &SdkAgent,
    primary: &str,    // addr
    secondary: &str,  // addr
    request: Request,
    hedge_delay: Duration,
) -> Result<Response, SdkError> {
    let primary_fut = call_agent(agent, primary, request.clone());
    let secondary_fut = call_agent(agent, secondary, request);

    // Start primary immediately; delay secondary by hedge_delay.
    // If primary responds within hedge_delay, secondary never fires.
    tokio::pin!(primary_fut);

    match timeout(hedge_delay, &mut primary_fut).await {
        Ok(result) => return result, // primary won
        Err(_) => {}                 // primary is slow; hedge
    }

    // Now race primary (still running) vs secondary.
    select! {
        result = &mut primary_fut => result,
        result = secondary_fut => result,
    }
}
```

**Important:** `Request` must implement `Clone` for hedging. The current
`Request` in `simple.rs` already derives `Clone`.

### 6.3 When to Hedge

Hedging is **opt-in**, not default. It doubles load, which is antisocial in a
shared network. The recommended policy:

- **Off by default.** Most calls should use single-target routing.
- **On for latency-critical, idempotent calls** when the caller explicitly sets
  `.hedge(true)` on the discovery builder.
- **Adaptive hedging (v2):** Only hedge when the primary's EWMA latency is above
  the caller's deadline *and* a low-latency secondary is available. This avoids
  hedging when the primary is already fast.

```rust
/// Adaptive hedging: only hedge if primary is likely to miss the deadline.
pub fn should_hedge_adaptive(
    primary_metrics: &PeerMetrics,
    deadline_ms: f64,
) -> bool {
    if !primary_metrics.latency_ewma_ms.is_initialized() {
        return false; // no data, don't hedge
    }
    let p99_estimate = primary_metrics.latency_ewma_ms.value() * 2.5;
    p99_estimate > deadline_ms
}
```

---

## 7. Metric Staleness and Default Scores

### 7.1 The Problem

A newly discovered peer has *no* metrics. A peer not called in 10 minutes has
*stale* metrics. If we score these as 0.0, we starve new peers and never
rediscover recovered peers. If we score them as 1.0, we route to dead peers.

### 7.2 Solution: Optimistic Default with Decay

| Condition | Default dynamic score | Rationale |
|-----------|----------------------|-----------|
| No data at all (new peer) | `0.5` | Neutral — neither rewarded nor punished |
| Stale (>60s since last contact) | `0.5` | Reset to neutral; don't trust old data |
| Circuit Open | `0.0` | Hard skip |
| Circuit HalfOpen | `0.1` | Allow trial but deprioritize |

The `dynamic_score()` function above already implements this. The key insight:
**0.5 is the "no information" prior**, not 0.0 or 1.0. This lets new peers
compete fairly with known-good peers (score ~0.7-0.9) without being instantly
preferred over them.

### 7.3 Exploration vs. Exploitation

To avoid starvation of untried peers, the P2C strategy naturally provides
exploration: with two random picks, a new peer (score 0.5) will sometimes be
picked over a known peer (score 0.8) when the other random pick is worse. For
more deliberate exploration, an epsilon-greedy variant can be added:

```rust
/// Epsilon-greedy: with probability epsilon, pick a random candidate
/// (exploration); otherwise pick the best (exploitation).
pub fn select_epsilon_greedy(
    candidates: &[(AgentId, f64)],
    epsilon: f64,
    rng: &mut impl Rng,
) -> Option<AgentId> {
    if rng.gen_bool(epsilon) {
        // Explore: uniform random.
        candidates.choose(rng).map(|(id, _)| *id)
    } else {
        // Exploit: best score.
        candidates
            .iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(id, _)| *id)
    }
}
```

Default `epsilon = 0.05` — 5% of calls explore. This ensures every peer
eventually gets sampled and its metrics refreshed.

---

## 8. Integration with Semantic Capability Graphs (Track U)

### 8.1 Static vs Dynamic

- **Track U (Semantic Capability Graphs):** *Static* descriptions — what an
  agent *can* do. `SemanticCapability` includes `PerformanceProfile` with
  advertised `avg_latency_ms`, `p99_latency_ms`, `throughput_rps`. These are
  *self-reported* and *static*.
- **Track T (Adaptive Routing):** *Dynamic* metrics — how an agent is
  *performing right now*. `PeerMetrics` includes EWMA latency, rolling success
  rate, in-flight count, circuit state. These are *observed* and *live*.

### 8.2 Combined Scoring

The `SEMANTIC_CAPABILITY_GRAPHS.md` document (§8.2) already sketches the
combination:

```rust
pub fn score_candidate(
    capability: &SemanticCapability,
    routing_metrics: &PeerMetrics,
    query: &CapabilityQuery,
    dyn_config: &DynamicScoreConfig,
) -> f64 {
    // Static score: how well the capability matches the query.
    let static_score = query.match_score(capability); // [0, 1]

    // Dynamic score: current load, latency, availability.
    let dynamic_score_val = dynamic_score(
        routing_metrics, dyn_config, Instant::now(),
        Duration::from_secs(60),
    );

    // Weighted combination.
    0.5 * static_score + 0.5 * dynamic_score_val
}
```

### 8.3 Hard Constraints vs Soft Scoring

Track U queries can express *hard* constraints (e.g., `max_avg_latency_ms:
Some(40.0)`). These are applied as **filters before scoring** — a candidate that
fails a hard constraint is eliminated, not merely penalized. Track T's dynamic
metrics then rank the survivors.

There is a subtlety: Track U's `PerformanceProfile.avg_latency_ms` is
*advertised* (static), while Track T's `latency_ewma_ms` is *observed* (dynamic).
A peer may advertise 14ms but currently be delivering 200ms. The combined
pipeline should:

1. Filter on *advertised* hard constraints (Track U) — eliminates peers that
   *can't* meet the SLA in principle.
2. Score on *observed* dynamic metrics (Track T) — ranks peers by *current*
   performance.

Optionally, a "dynamic hard constraint" can be added: if observed EWMA latency
exceeds the query's `max_avg_latency_ms` by more than 2x, the peer is
dynamically filtered out even if it passed the static filter. This catches
peers that have degraded since publishing their capability.

```rust
/// Dynamic hard-constraint filter: reject peers whose observed latency
/// is far worse than what the query allows.
pub fn passes_dynamic_constraints(
    metrics: &PeerMetrics,
    query: &CapabilityQuery,
) -> bool {
    if let Some(perf) = &query.performance {
        if let Some(max_lat) = perf.max_avg_latency_ms {
            if metrics.latency_ewma_ms.is_initialized() {
                // Reject if observed latency is > 2x the allowed max.
                if metrics.latency_ewma_ms.value() > max_lat * 2.0 {
                    return false;
                }
            }
        }
    }
    true
}
```

### 8.4 Dependency Ordering

Per `ADAPTATION_ROADMAP.md`, Track T depends on Track U. But Track T v1 can ship
on top of string-based discovery with `static_score = 1.0` for all matches. When
Track U lands, the `score_candidate()` function is plugged in and `static_score`
becomes meaningful. This keeps Track T unblocked.

---

## 9. Comparison with Industry Systems

### 9.1 gRPC Client-Side Load Balancing

gRPC supports several LB policies: `pick_first` (default), `round_robin`,
`least_request`, `weighted_round_robin`, `grpclb` (server-side), and `xDS`.

| gRPC Policy | AAFP Equivalent | Notes |
|-------------|-----------------|-------|
| `pick_first` | Current `candidates[0]` | What AAFP does today |
| `round_robin` | Not directly provided | P2C is strictly better for heterogeneous peers |
| `least_request` | `select_least_connections` | gRPC's version samples 3 random and picks least-loaded; AAFP's P2C samples 2 and picks highest-scored |
| `weighted_round_robin` | `select_weighted_random` | gRPC weights by backend-reported load; AAFP weights by composite score |
| `xDS` (Envoy) | Future: gossip-based metric distribution | xDS pushes cluster config from a control plane; AAFP is decentralized |

**Key difference:** gRPC's `least_request` (Envoy's variant) uses P2C on
*active request counts*. AAFP's P2C uses the *composite score*, which includes
but is not limited to load. This makes AAFP's routing quality-aware, not just
load-aware.

### 9.2 Envoy / xDS Dynamic Discovery

Envoy uses xDS (Discovery Service) to receive cluster configuration, endpoint
health, and load-balancing policy from a control plane. Endpoints report load
via LRS (Load Reporting Service).

| Envoy/xDS Concept | AAFP Equivalent |
|-------------------|-----------------|
| xDS control plane | Decentralized DHT + passive observation (no control plane) |
| LRS load reporting | `aafp.metrics` RPC (active probe) |
| Endpoint health check | `probe_peer()` |
| Circuit breaker | `CircuitState` (per-peer) |
| Outlier detection | Consecutive-failure trip + rolling-window success rate |
| Zone-aware routing | `GeoConstraint` (Track U) + region-aware scoring (future) |

**Key difference:** Envoy has a *control plane* (a centralized authority that
pushes config). AAFP is *decentralized* — each agent builds its own view from
DHT discovery and passive observation. This is more resilient (no single point
of control) but slower to propagate global state. Gossip (Phase 3) bridges this
gap.

### 9.3 Istio Destination Rules

Istio's `DestinationRule` configures LB policy, connection pool settings,
outlier detection, and subsets for Kubernetes services.

| Istio Concept | AAFP Equivalent |
|---------------|-----------------|
| `trafficPolicy.loadBalancer.simple` | `RoutingStrategy` enum |
| `trafficPolicy.loadBalancer.leastRequest` | `select_least_connections` / P2C |
| `outlierDetection.consecutiveErrors` | `failure_threshold` |
| `outlierDetection.interval` | `cooldown` |
| `outlierDetection.baseEjectionTime` | `cooldown` (same concept) |
| `connectionPool.tcp.maxConnections` | `ConcurrencyLimit.max_inflight` |
| `subsets` | Track U `CapabilityQuery` filters |

**Key difference:** Istio config is declarative YAML applied by a control plane.
AAFP config is programmatic (Rust builder) and per-agent. This is more flexible
but requires SDK support for common policies (hence the `RoutingConfig` builder
in §10).

### 9.4 Netflix Hystrix Concurrency Limits

Covered in §5.3. The key takeaway: Hystrix's thread-isolation model doesn't map
to AAFP's async runtime, but its *concurrency limit* and *circuit breaker*
concepts translate directly to `in_flight` tracking and `CircuitState`.

### 9.5 Finagle Request Hedging

Finagle (Twitter's RPC framework) uses a "backup requests" strategy: send a
backup request after a delay if the primary hasn't responded. This is exactly
the `call_with_hedging()` pattern in §6. Finagle's default hedge delay is 90% of
the request's timeout. AAFP's adaptive hedging (§6.3) is more conservative — it
only hedges when the primary is predicted to miss the deadline, avoiding
unnecessary duplicate load.

### 9.6 Summary Table

| Feature | gRPC | Envoy/xDS | Istio | Hystrix | Finagle | AAFP Track T |
|---------|------|-----------|-------|---------|---------|--------------|
| Decentralized | Partial (xDS) | No (control plane) | No (control plane) | Yes (client-side) | Yes (client-side) | **Yes** |
| P2C / least-request | Yes | Yes | Yes | No | Yes | **Yes** |
| Circuit breaker | No (app-level) | Yes | Yes | **Yes** | Yes | **Yes** |
| Concurrency limit | No | Yes | Yes | **Yes** | No | **Yes** |
| Request hedging | No | No | No | No | **Yes** | **Yes** |
| Quality-aware scoring | No | No | No | No | No | **Yes** (via Track U) |
| Semantic capability match | No | No | No | No | No | **Yes** (via Track U) |
| No wire-protocol changes | N/A | N/A | N/A | N/A | N/A | **Yes** |

AAFP's distinguishing feature is **quality-aware routing** — combining semantic
capability matching (Track U) with dynamic performance metrics (Track T) in a
single scoring function. Industry systems route by load/health alone; AAFP
routes by *capability fit × current performance*.

---

## 10. API Surface Design

### 10.1 Design Principle: Transparent by Default, Configurable by Opt-In

Per `STRATEGIC_VISION.md` §3: "The protocol should disappear." Adaptive routing
should be **on by default** with sensible defaults, and **configurable** for
advanced users. The 3-line API should not mention EWMA, circuit breakers, or
P2C.

### 10.2 The Routing Config Builder

```rust
/// Routing strategy selector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoutingStrategy {
    /// Power-of-two choices (default). Best general-purpose strategy.
    PowerOfTwo,
    /// Weighted random by score.
    WeightedRandom,
    /// Least in-flight connections.
    LeastConnections,
    /// Lowest EWMA latency.
    LowestLatency,
    /// Epsilon-greedy exploration.
    EpsilonGreedy { epsilon: f64 },
}

/// Configuration for the adaptive routing plane.
#[derive(Clone, Debug)]
pub struct RoutingConfig {
    pub strategy: RoutingStrategy,
    pub dynamic_score: DynamicScoreConfig,
    pub static_weight: f64,
    pub dynamic_weight: f64,
    pub failure_threshold: u32,
    pub cooldown: Duration,
    pub staleness_threshold: Duration,
    pub hedge: HedgeConfig,
    pub probe_interval: Duration,
    pub concurrency_limit: u32,
}

#[derive(Clone, Debug)]
pub struct HedgeConfig {
    pub enabled: bool,
    pub delay: Duration,
    pub adaptive: bool,
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            strategy: RoutingStrategy::PowerOfTwo,
            dynamic_score: DynamicScoreConfig::default(),
            static_weight: 0.5,
            dynamic_weight: 0.5,
            failure_threshold: 5,
            cooldown: Duration::from_secs(10),
            staleness_threshold: Duration::from_secs(60),
            hedge: HedgeConfig {
                enabled: false,
                delay: Duration::from_millis(50),
                adaptive: true,
            },
            probe_interval: Duration::from_secs(10),
            concurrency_limit: 16,
        }
    }
}
```

### 10.3 Integration with the Simple API

The `ConnectBuilder` gains a `.with_routing()` method. Without it, defaults
apply.

```rust
// ── Default: adaptive routing on with sensible defaults ──────
let agent = Agent::connect()
    .connect()
    .await?;

// discover() now uses adaptive routing transparently.
let result = agent.discover("ocr")
    .call(Request::text("image.png"))
    .await?;

// ── Advanced: custom routing config ───────────────────────────
let agent = Agent::connect()
    .with_routing(RoutingConfig {
        strategy: RoutingStrategy::LowestLatency,
        hedge: HedgeConfig {
            enabled: true,
            delay: Duration::from_millis(30),
            adaptive: true,
        },
        ..Default::default()
    })
    .connect()
    .await?;
```

### 10.4 Per-Call Overrides

For cases where a specific call needs different routing (e.g., hedging on a
latency-critical call but not on a batch job):

```rust
// Per-call: enable hedging for this request only.
let result = agent.discover("translation")
    .hedge(true)
    .call(Request::text("translate this"))
    .await?;

// Per-call: force a specific strategy.
let result = agent.discover("inference")
    .strategy(RoutingStrategy::LeastConnections)
    .call(Request::text("run inference"))
    .await?;
```

### 10.5 Observability

The routing plane exposes its decisions for debugging:

```rust
/// A routing decision record, for logging/debugging.
#[derive(Clone, Debug)]
pub struct RoutingDecision {
    pub capability: String,
    pub candidates_considered: usize,
    pub candidates_filtered_circuit: usize,
    pub selected: AgentId,
    pub selected_score: f64,
    pub selected_latency_ewma_ms: Option<f64>,
    pub selected_success_rate: f64,
    pub strategy: RoutingStrategy,
    pub hedged: bool,
}

impl ConnectedAgent {
    /// Access the last routing decision (for debugging/observability).
    pub fn last_routing_decision(&self) -> Option<RoutingDecision> { /* ... */ }

    /// Get a snapshot of all peer metrics (for monitoring dashboards).
    pub fn peer_metrics_snapshot(&self) -> Vec<PeerMetrics> { /* ... */ }
}
```

This integrates with the existing Prometheus exporter (Track S4) via new
metrics: `aafp_routing_decisions_total`, `aafp_routing_circuit_open_total`,
`aafp_routing_hedge_total`, `aafp_peer_latency_ewma_ms`.

### 10.6 Backward Compatibility

The v1 Simple API (`Agent::connect().discover("cap").call(req)`) continues to
work. The only behavioral change is that `discover()` no longer picks
`candidates[0]` — it picks the best-scored candidate. This is a *strict
improvement*: in the common case (all peers healthy, no metrics), the default
score is 0.5 for all, P2C picks randomly among them, which is already better than
always picking the first.

---

## 11. Implementation Roadmap

### Phase T1: Peer Metrics Infrastructure (Weeks 1-3)

**Goal:** Build the per-peer metrics store and passive observation.

| Sub-phase | Duration | Deliverables |
|-----------|----------|--------------|
| T1.1 | W1 | `Ewma`, `RollingWindow`, `PeerMetrics`, `PeerMetricsRegistry` |
| T1.2 | W2 | Instrument `call_agent()` to record latency/success passively |
| T1.3 | W3 | `CircuitState` machine + `check_circuit()` integration |

**Files touched:**
- New: `crates/aafp-sdk/src/routing/metrics.rs`
- New: `crates/aafp-sdk/src/routing/circuit.rs`
- Modified: `crates/aafp-sdk/src/simple.rs` (instrument `call_agent`)

### Phase T2: Scoring and Selection (Weeks 4-6)

**Goal:** Implement the scoring function and selection strategies.

| Sub-phase | Duration | Deliverables |
|-----------|----------|--------------|
| T2.1 | W4 | `dynamic_score()`, `DynamicScoreConfig` |
| T2.2 | W5 | `select_power_of_two()`, `select_weighted_random()`, `select_least_connections()`, `select_lowest_latency()` |
| T2.3 | W6 | `score_candidates()` pipeline + integration with `DiscoveryBuilder::call()` |

**Files touched:**
- New: `crates/aafp-sdk/src/routing/scoring.rs`
- New: `crates/aafp-sdk/src/routing/selection.rs`
- Modified: `crates/aafp-sdk/src/simple.rs` (replace `candidates[0]` with routing)

### Phase T3: Active Probing (Weeks 7-8)

**Goal:** Periodic health probes via `aafp.metrics` RPC.

| Sub-phase | Duration | Deliverables |
|-----------|----------|--------------|
| T3.1 | W7 | `probe_peer()` using existing `aafp.metrics` RPC |
| T3.2 | W8 | Jittered probe scheduler, probe target set management |

**Files touched:**
- New: `crates/aafp-sdk/src/routing/probe.rs`

### Phase T4: Request Hedging (Weeks 9-10)

**Goal:** Hedging support with adaptive policy.

| Sub-phase | Duration | Deliverables |
|-----------|----------|--------------|
| T4.1 | W9 | `call_with_hedging()`, `HedgeConfig` |
| T4.2 | W10 | Adaptive hedging (`should_hedge_adaptive()`), per-call `.hedge(true)` |

**Files touched:**
- New: `crates/aafp-sdk/src/routing/hedging.rs`
- Modified: `crates/aafp-sdk/src/simple.rs` (add `.hedge()` to `DiscoveryBuilder`)

### Phase T5: API Surface and Config (Weeks 11-12)

**Goal:** `RoutingConfig`, `ConnectBuilder::with_routing()`, observability.

| Sub-phase | Duration | Deliverables |
|-----------|----------|--------------|
| T5.1 | W11 | `RoutingConfig`, `RoutingStrategy`, builder integration |
| T5.2 | W12 | `RoutingDecision` logging, Prometheus metrics, `peer_metrics_snapshot()` |

**Files touched:**
- New: `crates/aafp-sdk/src/routing/config.rs`
- Modified: `crates/aafp-sdk/src/simple.rs` (builder methods)
- Modified: `crates/aafp-sdk/src/prometheus.rs` (new routing metrics)

### Phase T6: Track U Integration (Weeks 13-14, after Track U ships)

**Goal:** Combined `score_candidate()` with semantic capability matching.

| Sub-phase | Duration | Deliverables |
|-----------|----------|--------------|
| T6.1 | W13 | `score_candidate()` combining static + dynamic scores |
| T6.2 | W14 | Dynamic hard-constraint filtering, end-to-end tests |

**Files touched:**
- New: `crates/aafp-sdk/src/routing/combined.rs`

### Phase T7: Gossip (Future, Phase 3+)

**Goal:** Share peer metrics across agents for network-wide visibility.

| Sub-phase | Duration | Deliverables |
|-----------|----------|--------------|
| T7.1 | TBD | Gossip protocol for `PeerMetrics` summaries |
| T7.2 | TBD | Reputation-weighted merge (requires Track W) |
| T7.3 | TBD | Anti-entropy sync for consistency |

---

## 12. Module Structure

```
crates/aafp-sdk/src/routing/
├── mod.rs           // Public exports: RoutingConfig, RoutingStrategy, etc.
├── metrics.rs       // Ewma, RollingWindow, PeerMetrics, PeerMetricsRegistry
├── circuit.rs       // CircuitState, circuit breaker logic
├── scoring.rs       // dynamic_score(), DynamicScoreConfig
├── selection.rs     // P2C, weighted random, least-conn, lowest-latency
├── probe.rs         // Active health probing via aafp.metrics RPC
├── hedging.rs       // call_with_hedging(), adaptive hedging
├── config.rs        // RoutingConfig, HedgeConfig, builder integration
└── combined.rs      // Track U integration: score_candidate()
```

The `routing` module is gated behind a feature flag `adaptive-routing` (enabled
by default) so that minimal builds can opt out.

---

## 13. Testing Strategy

### 13.1 Unit Tests

- `Ewma`: convergence, alpha sensitivity, first-sample initialization.
- `RollingWindow`: wrap-around, success rate calculation, empty window default.
- `CircuitState`: Closed→Open→HalfOpen→Closed transitions, cooldown timing.
- `dynamic_score()`: each sub-score in isolation, staleness penalty, circuit
  gating.
- Selection strategies: P2C distribution (statistical test over 10K samples),
  weighted-random probability, least-connections tie-breaking.

### 13.2 Integration Tests

- **Multi-agent routing:** Start 5 agents with the same capability. Inject
  artificial latency into 3 of them. Verify that routing skews toward the fast
  2 over time.
- **Circuit breaker:** Start 3 agents. Make one return errors. Verify circuit
  opens after `failure_threshold` and calls route to the other 2. Verify
  recovery (HalfOpen→Closed) after the failing agent heals.
- **Hedging:** Start 2 agents, one fast and one slow. Enable hedging. Verify
  that the fast agent's response is used and the slow call is cancelled.
- **Staleness:** Call an agent, then wait > `staleness_threshold`. Verify its
  score resets to 0.5 and it can be re-selected.

### 13.3 Load Tests

Extend `aafp-loadtest` with a "routing fairness" scenario: N agents with varying
performance profiles, M callers. Measure:
- Request distribution across agents (should correlate with score, not be
  uniform).
- P99 latency improvement vs. `candidates[0]` baseline.
- Circuit-open rate under partial failure.

---

## 14. Security Considerations

### 14.1 Metric Spoofing

Active probes rely on self-reported `aafp.metrics` responses. A malicious agent
could report artificially low latency or high health to attract traffic. This is
mitigated by:

1. **Passive metrics take priority:** The client's own observed latency/success
   overrides self-reported metrics in the scoring function. A peer can lie about
   being fast, but the client will *observe* the truth and adjust.
2. **Reputation weighting (Track W):** In Phase 5, self-reported metrics are
   weighted by the peer's reputation score. A new peer's self-reports are
   discounted.
3. **Cryptographic metrics (future):** Metrics responses could be signed and
   include a nonce/timestamp to prevent replay. This is a future enhancement,
   not required for v1.

### 14.2 Routing Manipulation

A malicious agent could try to manipulate routing by:
- **False capability advertisement:** Already mitigated by UCAN capability
  attestation (Track U §12).
- **Gossip poisoning (Phase 3):** A peer could gossip false negative metrics
  about a competitor. Mitigation: reputation-weighted gossip merging, and
  preferring self-observed metrics over gossip.

### 14.3 Resource Exhaustion

- **Probe storms:** Probes are jittered and limited to the active candidate set.
  A client probes at most N peers per capability per interval.
- **Metrics memory growth:** `PeerMetricsRegistry` should have an LRU eviction
  policy for peers not seen in >24h, to bound memory in large networks.
- **Hedging load:** Hedging is opt-in and adaptive; it does not double load by
  default.

---

## 15. Open Questions

1. **Should metrics be persisted?** Currently all metrics are in-memory and lost
   on restart. For long-running agents, persisting EWMA latency and success rate
   to SQLite (via the existing `aafp-identity` persistence layer) would preserve
   routing quality across restarts. Trade-off: stale persisted data may be
   misleading after a peer's behavior changes.

2. **Cross-capability metrics:** Should a peer's metrics be tracked per-capability
   or per-agent? A peer might be fast at "ocr" but slow at "translation". v1
   tracks per-agent (simpler). v2 could add per-capability sub-metrics.

3. **Federated routing:** In a multi-network scenario (AAFP agents bridging to
   MCP/A2A servers), should routing metrics cover the bridged endpoint? This
   requires the transport-mcp/transport-a2a crates to report metrics back to the
   routing plane.

4. **EWMA vs P² quantile estimation:** EWMA gives a mean estimate. For P99 tail
   latency, a P² algorithm (online quantile estimation) would be more accurate
   but more complex. v1 uses EWMA; P² is a v2 enhancement.

5. **Cost as a routing signal:** Real-time pricing (Track Y, Economic Layer) is
   far future. v1's `cost_micro_usd` is a static advertised value from Track U's
   `CostModel`. Dynamic pricing (spot pricing, surge pricing) is Phase 7.

---

## 16. Conclusion

The Adaptive Routing Plane transforms AAFP discovery from "who has capability X?"
into "which execution path is optimal right now?" — exactly as the Strategic
Vision demands. The design is:

- **Decentralized:** No control plane; each agent builds its own living map from
  passive observation and active probing.
- **Quality-aware:** Combines semantic capability matching (Track U) with dynamic
  performance metrics (Track T) in a single scoring function — a feature no
  industry system provides.
- **Resilient:** Circuit breakers prevent cascading failures; request hedging
  cuts tail latency; staleness handling avoids starving new or recovered peers.
- **Transparent:** On by default with sensible defaults; the 3-line API doesn't
  change. Advanced users can configure strategy, weights, hedging, and
  concurrency limits.
- **Protocol-stable:** No wire-protocol changes. Everything lives in the SDK,
  consistent with the immutable-boundary principle.

The implementation roadmap (Phases T1-T6, 14 weeks) is incremental: each phase
delivers independent value. T1-T2 (peer metrics + scoring) alone eliminate the
`candidates[0]` single-point-of-failure and add basic quality-aware routing.
T3-T4 add active probing and hedging. T5 completes the API surface. T6
integrates with Track U when it ships.

This is the mechanism by which, in the Strategic Vision's words, "every
execution improves future routing: Request → Outcome → Learning → Routing
improves."
