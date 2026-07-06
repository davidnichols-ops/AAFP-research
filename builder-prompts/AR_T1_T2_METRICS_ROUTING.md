# Builder Prompt: Adaptive Routing Plane — Phase T1-T2 (Dynamic Metrics + Routing Algorithm)

## Objective

Implement the per-peer dynamic metrics infrastructure (T1) and the composite
scoring + selection algorithm (T2) for the Adaptive Routing Plane. This
eliminates the `candidates[0]` single-point-of-failure and replaces it with
quality-aware, circuit-breaker-protected routing. No wire-protocol changes —
everything lives in the SDK.

## Context

Read these design documents before starting:
- `ADAPTIVE_ROUTING_PLANE.md` — Full design (sections 3, 4, 5, 7, 10, 11, 12)
- `implementations/rust/crates/aafp-sdk/src/metrics.rs` — Existing server-side
  `AgentMetrics`, `HealthStatus`, `MetricsRpcResponse` (Track S4)
- `implementations/rust/crates/aafp-sdk/src/simple.rs` — Current
  `DiscoveryBuilder::call()` that iterates candidates with failover (lines
  1037-1074) and `call_agent_with_pool()` (line 1376+)

The existing `metrics.rs` is **server-side only**: it tracks self-counters via
`AtomicU64` and derives `HealthStatus`. Track T adds **client-side per-peer**
observation: latency, success rate, circuit breaker state, and a scoring
function that the routing layer consumes.

## What to Build

### Part 1: Module Structure (ADAPTIVE_ROUTING_PLANE.md §12)

Create a new `routing` module under `aafp-sdk`:

```
crates/aafp-sdk/src/routing/
├── mod.rs           // Public exports, RoutingConfig, RoutingStrategy
├── metrics.rs       // Ewma, RollingWindow, PeerMetrics, PeerMetricsRegistry
├── circuit.rs       // CircuitState, circuit breaker transitions
├── scoring.rs       // dynamic_score(), DynamicScoreConfig, score_candidates()
└── selection.rs     // P2C, weighted random, least-conn, lowest-latency
```

Gate behind feature flag `adaptive-routing` (enabled by default in
`Cargo.toml`). Add `rand` dependency (already a workspace dep — check
`Cargo.toml` for the `rand` crate; if not present, add it).

`mod.rs` re-exports all public types:

```rust
//! Adaptive Routing Plane — dynamic metrics and quality-aware routing.
//!
//! Implements Track T (Phases T1-T2): per-peer metrics collection,
//! circuit breaker, composite scoring, and selection strategies.

pub mod metrics;
pub mod circuit;
pub mod scoring;
pub mod selection;

pub use metrics::{Ewma, RollingWindow, PeerMetrics, PeerMetricsRegistry, HealthProbeResult};
pub use circuit::CircuitState;
pub use scoring::{dynamic_score, DynamicScoreConfig, score_candidates};
pub use selection::{
    select_power_of_two, select_weighted_random,
    select_least_connections, select_lowest_latency,
    select_epsilon_greedy, SelectionCandidate,
};
```

### Part 2: Ewma Struct (ADAPTIVE_ROUTING_PLANE.md §3.2)

File: `crates/aafp-sdk/src/routing/metrics.rs`

An exponentially weighted moving average estimator for latency. The first
sample initializes the value directly; subsequent samples blend via
`alpha * sample + (1 - alpha) * value`.

```rust
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
    /// Create a new EWMA with the given alpha (must be in [0.0, 1.0]).
    pub fn new(alpha: f64) -> Self {
        assert!((0.0..=1.0).contains(&alpha), "alpha must be in [0,1]");
        Self { value: 0.0, alpha, initialized: false }
    }

    /// Update with a new sample and return the updated estimate.
    /// The first sample sets the value directly (no blending).
    pub fn update(&mut self, sample: f64) -> f64 {
        if !self.initialized {
            self.value = sample;
            self.initialized = true;
        } else {
            self.value = self.alpha * sample + (1.0 - self.alpha) * self.value;
        }
        self.value
    }

    /// Current EWMA estimate. Returns 0.0 if never updated.
    pub fn value(&self) -> f64 { self.value }

    /// Whether at least one sample has been recorded.
    pub fn is_initialized(&self) -> bool { self.initialized }

    /// Reset to uninitialized state (e.g., after long disconnection).
    pub fn reset(&mut self) {
        self.value = 0.0;
        self.initialized = false;
    }
}
```

### Part 3: RollingWindow Struct (ADAPTIVE_ROUTING_PLANE.md §3.2)

File: `crates/aafp-sdk/src/routing/metrics.rs`

A fixed-capacity bitset for success/failure tracking. Capacity ≤ 64 (uses a
single `u64`). Default capacity: 64 samples. Success = 1 bit, failure = 0 bit.
Wraps around via modulo indexing.

```rust
/// A fixed-capacity rolling window for success/failure tracking.
///
/// Uses a bitset: 1 = success, 0 = failure. Capacity is at most 64
/// (one u64). Default capacity: 64 samples. Wraps around via modulo.
#[derive(Clone, Debug)]
pub struct RollingWindow {
    bits: u64,
    index: u8,
    capacity: u8,
    count: u8,
}

impl RollingWindow {
    /// Create a new window with the given capacity (must be ≤ 64).
    pub fn new(capacity: u8) -> Self {
        assert!(capacity <= 64, "capacity must be <= 64");
        assert!(capacity > 0, "capacity must be > 0");
        Self { bits: 0, index: 0, capacity, count: 0 }
    }

    /// Record a success (true) or failure (false) in the window.
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
    /// Returns 1.0 for an empty window (optimistic default).
    pub fn success_rate(&self) -> f64 {
        if self.count == 0 { return 1.0; }
        let ones = self.bits.count_ones() as f64;
        ones / self.count as f64
    }

    /// Number of samples currently in the window.
    pub fn sample_count(&self) -> u8 { self.count }

    /// Reset the window (clear all samples).
    pub fn reset(&mut self) {
        self.bits = 0;
        self.index = 0;
        self.count = 0;
    }
}
```

### Part 4: CircuitState Enum (ADAPTIVE_ROUTING_PLANE.md §3.2, §5)

File: `crates/aafp-sdk/src/routing/circuit.rs`

Three-state circuit breaker: Closed (normal), Open (tripped, reject),
HalfOpen (trial period after cooldown).

```rust
/// Circuit breaker state machine.
///
/// Transitions:
/// - Closed → Open: when consecutive_failures >= failure_threshold
/// - Open → HalfOpen: when cooldown elapses (checked in check_circuit)
/// - HalfOpen → Closed: when a trial request succeeds
/// - HalfOpen → Open: when a trial request fails
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

impl CircuitState {
    /// Whether requests should be allowed through (not short-circuited).
    pub fn allows_request(&self) -> bool {
        matches!(self, CircuitState::Closed | CircuitState::HalfOpen)
    }
}

impl Default for CircuitState {
    fn default() -> Self { CircuitState::Closed }
}
```

### Part 5: PeerMetrics and PeerMetricsRegistry (ADAPTIVE_ROUTING_PLANE.md §3.2)

File: `crates/aafp-sdk/src/routing/metrics.rs`

`PeerMetrics` holds all dynamic data for one remote agent. The
`PeerMetricsRegistry` is a thread-safe `Mutex<HashMap<AgentId, PeerMetrics>>`
with configurable EWMA alpha, window capacity, failure threshold, cooldown,
and staleness threshold.

```rust
use aafp_identity::AgentId;
use crate::routing::circuit::CircuitState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Result of an active health probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HealthProbeResult {
    Healthy,
    Degraded,
    Unhealthy,
    Unreachable,
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
    /// Active in-flight requests to this peer.
    pub in_flight: u32,
    /// Last reported queue depth (from active probe or gossip).
    pub queue_depth: Option<u32>,
    /// Last reported active connections (from aafp.metrics RPC).
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
```

Implement these methods on `PeerMetricsRegistry`:

- `new() -> Arc<Self>` — defaults: alpha=0.1, capacity=64, threshold=5,
  cooldown=10s, staleness=60s.
- `get_or_create(&self, agent_id: &AgentId) -> PeerMetrics` — returns a clone
  of existing or creates a fresh entry.
- `record_outcome(&self, agent_id: &AgentId, latency_ms: f64, success: bool)`
  — updates EWMA latency, min latency, success window, last_seen, and drives
  circuit breaker transitions (success resets consecutive_failures and
  increments consecutive_successes; HalfOpen→Closed on success; failure
  increments consecutive_failures; Open when threshold reached).
- `inflight_inc(&self, agent_id: &AgentId)` — saturating add.
- `inflight_dec(&self, agent_id: &AgentId)` — saturating sub.
- `check_circuit(&self, agent_id: &AgentId) -> CircuitState` — if Open and
  cooldown elapsed, transition to HalfOpen; return current state. Unknown
  peers return `Closed` (optimistic).
- `is_stale(&self, agent_id: &AgentId) -> bool` — true if last_seen elapsed
  >= staleness_threshold, or peer unknown.
- `snapshot_all(&self) -> Vec<PeerMetrics>` — clone all peer metrics for
  observability/debugging.

**Key detail:** `record_outcome` must create the peer entry if it doesn't
exist (same initialization as `get_or_create`). Use
`peers.entry(*agent_id).or_insert_with(...)`.

### Part 6: Metrics Collection — Passive (ADAPTIVE_ROUTING_PLANE.md §3.1)

Passive collection instruments `call_agent_with_pool()` in `simple.rs`. The
caller measures its own calls: record start time before the call, measure
elapsed on response, and call `registry.record_outcome()`.

Modify `call_agent_with_pool()` to accept an optional
`Option<&Arc<PeerMetricsRegistry>>`. When provided:

```rust
async fn call_agent_with_pool(
    agent: &SdkAgent,
    pool: &ConnectionPool,
    addr: &str,
    request: Request,
    registry: Option<&Arc<PeerMetricsRegistry>>,
    agent_id: Option<&AgentId>,
) -> Result<Response, SdkError> {
    // Increment in-flight before the call
    if let (Some(reg), Some(id)) = (&registry, &agent_id) {
        reg.inflight_inc(id);
    }

    let start = Instant::now();
    let result = call_agent_inner(agent, pool, addr, request).await;
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

    // Record outcome and decrement in-flight
    if let (Some(reg), Some(id)) = (&registry, &agent_id) {
        let success = result.is_ok();
        reg.record_outcome(id, elapsed_ms, success);
        reg.inflight_dec(id);
    }

    result
}
```

**Important:** The `agent_id` must be resolved from the `AgentRecord` in the
`DiscoveryBuilder::call()` method before calling. If the existing
`call_agent_with_pool` signature is used in multiple places, add a wrapper
that passes `None` for backward compatibility, or make the registry parameter
part of a `RoutingContext` struct.

### Part 7: Metrics Collection — Active (ADAPTIVE_ROUTING_PLANE.md §3.3)

Active probing uses the existing `aafp.metrics` RPC (Track S4) to pull
`MetricsRpcResponse` from a peer. This fills in `reported_active_conns`,
`queue_depth`, and `last_health` for peers the client hasn't recently called.

Add a `probe_peer()` function to `metrics.rs`:

```rust
use crate::metrics::{MetricsRpcResponse, HealthStatus};

fn map_health(h: HealthStatus) -> HealthProbeResult {
    match h {
        HealthStatus::Healthy => HealthProbeResult::Healthy,
        HealthStatus::Degraded => HealthProbeResult::Degraded,
        HealthStatus::Unhealthy => HealthProbeResult::Unhealthy,
    }
}

/// Probe a peer by calling its aafp.metrics RPC.
/// Updates the registry with reported load and health.
pub async fn probe_peer(
    agent: &crate::simple::SdkAgent,
    addr: &str,
    registry: &PeerMetricsRegistry,
    agent_id: &AgentId,
) -> Result<HealthProbeResult, crate::simple::SdkError> {
    // Build a metrics RPC request and call the peer.
    // On success, update registry with reported_active_conns,
    // last_health, and last_seen.
    // On failure, set last_health = Unreachable.
    // (Full implementation uses the existing RPC call path.)
    todo!("implement using existing call_agent path with aafp.metrics method")
}
```

**Note:** The full active probing scheduler (jittered interval, probe target
set) is Phase T3. For T1-T2, implement `probe_peer()` and the `map_health()`
mapping, but the scheduler is deferred. The function should be testable in
isolation.

### Part 8: Composite Scoring Function (ADAPTIVE_ROUTING_PLANE.md §4.1, §4.2)

File: `crates/aafp-sdk/src/routing/scoring.rs`

The total score is: `w_static * static_score + w_dynamic * dynamic_score`.
The dynamic score is a weighted product of five normalized sub-scores:
latency, success, load, availability, and cost.

```rust
use crate::routing::metrics::{PeerMetrics, HealthProbeResult};
use crate::routing::circuit::CircuitState;
use std::time::{Duration, Instant};

/// Configuration for dynamic scoring weights.
#[derive(Clone, Debug)]
pub struct DynamicScoreConfig {
    pub weight_latency: f64,
    pub weight_success: f64,
    pub weight_load: f64,
    pub weight_availability: f64,
    pub weight_cost: f64,
    /// Reference latency (ms) for normalization. Latency at or below
    /// this scores 1.0; latency at 5x scores ~0.
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
            cost_ref_micro_usd: 100,
        }
    }
}
```

Implement `dynamic_score()`:

- **Circuit Open → return 0.0** (hard gate).
- **Circuit HalfOpen → return 0.1** (allow trial but deprioritize).
- **Stale (>staleness_threshold since last_seen) → return 0.5** (neutral
  default, don't starve unknown peers).
- **Latency score:** `(1.0 - (latency / (5.0 * latency_ref_ms))).max(0.0)`.
  If EWMA not initialized, use 0.5.
- **Success score:** directly from `success_window.success_rate()`.
- **Load score:** `1.0 / (1.0 + in_flight + queue_depth)`.
- **Availability score:** Healthy=1.0, Degraded=0.5, Unhealthy=0.1,
  Unreachable=0.0, None=0.7.
- **Cost score:** `(1.0 - (cost / (5.0 * cost_ref))).max(0.0)`. If no cost
  data, use 0.8.
- **Weighted sum** divided by total weight, clamped to [0.0, 1.0].

Implement `score_candidates()` — the full pipeline:

```rust
use aafp_identity::{AgentId, AgentRecord};
use crate::routing::metrics::PeerMetricsRegistry;

/// Filter candidates by circuit state and compute composite scores.
///
/// Returns (AgentId, total_score) pairs. Circuit-Open peers are
/// hard-skipped (excluded entirely). HalfOpen peers are included
/// with a heavy penalty so the trial request can go through if no
/// better option exists.
pub fn score_candidates(
    candidates: &[AgentRecord],
    registry: &PeerMetricsRegistry,
    static_scores: &[f64],
    dyn_config: &DynamicScoreConfig,
    static_weight: f64,
    dynamic_weight: f64,
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
            let total = static_weight * static_score + dynamic_weight * dyn_score;
            Some((record.agent_id, total))
        })
        .collect()
}
```

For pre-Track-U (string-based discovery), `static_score = 1.0` for all
matches. The `static_weight` and `dynamic_weight` default to 0.5 each.

### Part 9: Selection Strategies (ADAPTIVE_ROUTING_PLANE.md §4.3)

File: `crates/aafp-sdk/src/routing/selection.rs`

Implement four selection strategies plus epsilon-greedy. Use a
`SelectionCandidate` struct to carry the data each strategy needs:

```rust
use aafp_identity::AgentId;
use rand::Rng;

/// A scored candidate ready for selection.
#[derive(Clone, Debug)]
pub struct SelectionCandidate {
    pub agent_id: AgentId,
    pub score: f64,
    pub in_flight: u32,
    pub latency_ewma_ms: f64,
    pub latency_initialized: bool,
    pub success_rate: f64,
}
```

**Strategy 1: Power-of-Two Choices (P2C) — Default**

Pick two candidates at random, return the one with the higher score. With
<4 candidates, fall back to weighted random (per §4.4 guidance).

```rust
pub fn select_power_of_two(
    candidates: &[SelectionCandidate],
    rng: &mut impl Rng,
) -> Option<AgentId> {
    if candidates.is_empty() { return None; }
    if candidates.len() == 1 { return Some(candidates[0].agent_id); }

    // With <4 candidates, P2C degenerates; fall back to weighted random.
    if candidates.len() < 4 {
        return select_weighted_random(candidates, rng);
    }

    let i = rng.gen_range(0..candidates.len());
    let mut j = rng.gen_range(0..candidates.len());
    if j == i { j = (j + 1) % candidates.len(); }

    let (a, b) = (&candidates[i], &candidates[j]);
    if a.score >= b.score { Some(a.agent_id) } else { Some(b.agent_id) }
}
```

**Strategy 2: Weighted Random**

Pick a candidate with probability proportional to its score. If all scores
are zero (e.g., all circuits open), fall back to uniform random.

```rust
pub fn select_weighted_random(
    candidates: &[SelectionCandidate],
    rng: &mut impl Rng,
) -> Option<AgentId> {
    if candidates.is_empty() { return None; }
    let total: f64 = candidates.iter().map(|c| c.score).sum();
    if total <= 0.0 {
        let idx = rng.gen_range(0..candidates.len());
        return Some(candidates[idx].agent_id);
    }
    let mut r = rng.gen_range(0.0..total);
    for c in candidates {
        r -= c.score;
        if r <= 0.0 {
            return Some(c.agent_id);
        }
    }
    Some(candidates.last().unwrap().agent_id)
}
```

**Strategy 3: Least-Connections**

Pick the candidate with the lowest `in_flight` count. Ties broken by score
(higher score wins).

```rust
pub fn select_least_connections(
    candidates: &[SelectionCandidate],
) -> Option<AgentId> {
    candidates
        .iter()
        .min_by(|a, b| {
            a.in_flight
                .cmp(&b.in_flight)
                .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
        })
        .map(|c| c.agent_id)
}
```

**Strategy 4: EWMA-Latency (Pick-Lowest-Latency)**

Pick the candidate with the lowest EWMA latency. Only consider candidates
with initialized latency. Ties broken by success rate (higher wins).

```rust
pub fn select_lowest_latency(
    candidates: &[SelectionCandidate],
) -> Option<AgentId> {
    candidates
        .iter()
        .filter(|c| c.latency_initialized)
        .min_by(|a, b| {
            a.latency_ewma_ms
                .partial_cmp(&b.latency_ewma_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.success_rate.partial_cmp(&a.success_rate).unwrap_or(std::cmp::Ordering::Equal))
        })
        .map(|c| c.agent_id)
        // If no candidate has initialized latency, fall back to highest score.
        .or_else(|| {
            candidates
                .iter()
                .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal))
                .map(|c| c.agent_id)
        })
}
```

**Strategy 5: Epsilon-Greedy (exploration variant)**

With probability epsilon, pick uniformly at random (explore); otherwise pick
the highest score (exploit). Default epsilon = 0.05.

```rust
pub fn select_epsilon_greedy(
    candidates: &[SelectionCandidate],
    epsilon: f64,
    rng: &mut impl Rng,
) -> Option<AgentId> {
    if candidates.is_empty() { return None; }
    if rng.gen_bool(epsilon) {
        let idx = rng.gen_range(0..candidates.len());
        Some(candidates[idx].agent_id)
    } else {
        candidates
            .iter()
            .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal))
            .map(|c| c.agent_id)
    }
}
```

### Part 10: RoutingStrategy Trait and Enum (ADAPTIVE_ROUTING_PLANE.md §10.2)

File: `crates/aafp-sdk/src/routing/mod.rs`

Define a `RoutingStrategy` enum that selects which selection function to use,
and a `RoutingConfig` struct that bundles all configuration:

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
    pub probe_interval: Duration,
    pub concurrency_limit: u32,
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
            probe_interval: Duration::from_secs(10),
            concurrency_limit: 16,
        }
    }
}
```

Add a `select()` method on `RoutingStrategy` that dispatches to the
appropriate selection function:

```rust
impl RoutingStrategy {
    pub fn select(
        &self,
        candidates: &[SelectionCandidate],
        rng: &mut impl Rng,
    ) -> Option<AgentId> {
        match self {
            RoutingStrategy::PowerOfTwo => select_power_of_two(candidates, rng),
            RoutingStrategy::WeightedRandom => select_weighted_random(candidates, rng),
            RoutingStrategy::LeastConnections => select_least_connections(candidates),
            RoutingStrategy::LowestLatency => select_lowest_latency(candidates),
            RoutingStrategy::EpsilonGreedy { epsilon } => {
                select_epsilon_greedy(candidates, *epsilon, rng)
            }
        }
    }
}
```

### Part 11: Integration with DiscoveryBuilder (ADAPTIVE_ROUTING_PLANE.md §10.3, §10.6)

File: `crates/aafp-sdk/src/simple.rs` (modified)

Replace the current failover loop in `DiscoveryBuilder::call()` (lines
1047-1074) with adaptive routing. The `DiscoveryBuilder` gains an
`Arc<PeerMetricsRegistry>` and `RoutingConfig`:

```rust
pub struct DiscoveryBuilder {
    agent: Arc<SdkAgent>,
    pool: Arc<ConnectionPool>,
    capability: String,
    // NEW: routing plane
    registry: Option<Arc<PeerMetricsRegistry>>,
    routing_config: RoutingConfig,
}
```

The new `call()` method:

1. Discover candidates via `find_by_capability()`.
2. If `registry` is `None`, fall back to the existing failover loop
   (backward compat for users who disabled adaptive-routing feature).
3. If `registry` is `Some`:
   a. Build `static_scores` — all `1.0` for pre-Track-U string discovery.
   b. Call `score_candidates()` to get `(AgentId, score)` pairs.
   c. Build `SelectionCandidate` vec by looking up `PeerMetrics` for each.
   d. Call `routing_config.strategy.select()` to pick one.
   e. Find the `AgentRecord` for the selected `AgentId`.
   f. Call `call_agent_with_pool()` with the registry for passive metrics.
   g. On failure, retry with the remaining candidates (failover within the
      scored set, skipping the failed one).

```rust
pub async fn call(&self, request: Request) -> Result<Response, SdkError> {
    let candidates = self.agent.find_by_capability(&self.capability);
    if candidates.is_empty() {
        return Err(SdkError::Discovery(format!(
            "no agents found for capability '{}'", self.capability
        )));
    }

    // No registry → legacy failover (backward compat).
    let registry = match &self.registry {
        None => return self.call_failover(&candidates, request).await,
        Some(r) => r.clone(),
    };

    // Score and select.
    let static_scores = vec![1.0; candidates.len()];
    let scored = score_candidates(
        &candidates, &registry, &static_scores,
        &self.routing_config.dynamic_score,
        self.routing_config.static_weight,
        self.routing_config.dynamic_weight,
    );

    if scored.is_empty() {
        return Err(SdkError::Discovery(
            "all candidates have open circuits".to_string()
        ));
    }

    // Build selection candidates from scored + metrics.
    let mut sel_candidates: Vec<SelectionCandidate> = scored.iter()
        .map(|(id, score)| {
            let m = registry.get_or_create(id);
            SelectionCandidate {
                agent_id: *id,
                score: *score,
                in_flight: m.in_flight,
                latency_ewma_ms: m.latency_ewma_ms.value(),
                latency_initialized: m.latency_ewma_ms.is_initialized(),
                success_rate: m.success_window.success_rate(),
            }
        })
        .collect();

    let mut rng = rand::thread_rng();
    let mut last_error: Option<SdkError> = None;

    // Try selected candidate, then failover through remaining.
    while !sel_candidates.is_empty() {
        let selected = self.routing_config.strategy
            .select(&sel_candidates, &mut rng);

        let selected_id = match selected {
            Some(id) => id,
            None => break,
        };

        // Find the AgentRecord for this id.
        let record = candidates.iter().find(|c| c.agent_id == selected_id);
        let addr = record.and_then(|r| r.endpoints.first());

        if let Some(addr) = addr {
            match call_agent_with_pool(
                &self.agent, &self.pool, addr, request.clone(),
                Some(&registry), Some(&selected_id),
            ).await {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    tracing::warn!("routing call to {addr} failed: {e:?}");
                    last_error = Some(e);
                    // Remove this candidate from the pool and retry.
                    sel_candidates.retain(|c| c.agent_id != selected_id);
                }
            }
        } else {
            sel_candidates.retain(|c| c.agent_id != selected_id);
        }
    }

    Err(last_error.unwrap_or_else(|| SdkError::Discovery(
        "all candidates exhausted".to_string()
    )))
}
```

**Backward compatibility:** The `ConnectedAgent` must construct the
`DiscoveryBuilder` with `registry: Some(...)` by default (when the
`adaptive-routing` feature is enabled). Users who disable the feature get
`registry: None` and the legacy failover path. The 3-line API
(`agent.discover("ocr").call(req)`) continues to work unchanged — it now
routes adaptively instead of picking `candidates[0]`.

Add `with_routing(RoutingConfig)` to `ConnectBuilder` for advanced
configuration. Without it, `RoutingConfig::default()` applies.

### Part 12: Unit Tests

File: `crates/aafp-sdk/src/routing/metrics.rs` (inline `#[cfg(test)]` module)

**EWMA tests:**

```rust
#[test]
fn test_ewma_first_sample_initializes() {
    let mut e = Ewma::new(0.1);
    assert!(!e.is_initialized());
    assert_eq!(e.value(), 0.0);
    e.update(100.0);
    assert!(e.is_initialized());
    assert_eq!(e.value(), 100.0); // first sample sets directly
}

#[test]
fn test_ewma_convergence() {
    let mut e = Ewma::new(0.3);
    e.update(100.0); // first = 100
    e.update(100.0); // 0.3*100 + 0.7*100 = 100
    e.update(50.0);  // 0.3*50 + 0.7*100 = 85
    assert!((e.value() - 85.0).abs() < 0.001);
}

#[test]
fn test_ewma_alpha_sensitivity() {
    // Higher alpha = faster adaptation
    let mut fast = Ewma::new(0.5);
    let mut slow = Ewma::new(0.05);
    for _ in 0..20 {
        fast.update(200.0);
        slow.update(200.0);
    }
    // Fast converges quicker to 200
    assert!(fast.value() > slow.value());
    assert!((fast.value() - 200.0).abs() < 1.0);
}

#[test]
fn test_ewma_reset() {
    let mut e = Ewma::new(0.1);
    e.update(100.0);
    assert!(e.is_initialized());
    e.reset();
    assert!(!e.is_initialized());
    assert_eq!(e.value(), 0.0);
}
```

**RollingWindow tests:**

```rust
#[test]
fn test_rolling_window_empty() {
    let w = RollingWindow::new(64);
    assert_eq!(w.sample_count(), 0);
    assert_eq!(w.success_rate(), 1.0); // optimistic default
}

#[test]
fn test_rolling_window_all_success() {
    let mut w = RollingWindow::new(8);
    for _ in 0..8 { w.record(true); }
    assert_eq!(w.sample_count(), 8);
    assert!((w.success_rate() - 1.0).abs() < 0.001);
}

#[test]
fn test_rolling_window_all_failure() {
    let mut w = RollingWindow::new(8);
    for _ in 0..8 { w.record(false); }
    assert_eq!(w.success_rate(), 0.0);
}

#[test]
fn test_rolling_window_mixed() {
    let mut w = RollingWindow::new(8);
    w.record(true);  w.record(true);  w.record(true);
    w.record(false); w.record(false);
    // 3 success / 5 total = 0.6
    assert!((w.success_rate() - 0.6).abs() < 0.001);
}

#[test]
fn test_rolling_window_wrap_around() {
    let mut w = RollingWindow::new(4);
    w.record(true);  w.record(true);  w.record(true);  w.record(true);
    // Window full: 4/4 = 1.0
    assert!((w.success_rate() - 1.0).abs() < 0.001);
    // Overwrite with failures
    w.record(false); w.record(false); w.record(false); w.record(false);
    // Now 0/4 = 0.0
    assert!((w.success_rate() - 0.0).abs() < 0.001);
}

#[test]
fn test_rolling_window_partial_wrap() {
    let mut w = RollingWindow::new(4);
    w.record(true); w.record(true); w.record(true); w.record(true);
    w.record(false); // overwrites index 0
    // 3 success / 4 total = 0.75
    assert!((w.success_rate() - 0.75).abs() < 0.001);
}

#[test]
fn test_rolling_window_reset() {
    let mut w = RollingWindow::new(8);
    w.record(true); w.record(false);
    w.reset();
    assert_eq!(w.sample_count(), 0);
    assert_eq!(w.success_rate(), 1.0);
}
```

**CircuitState tests:**

```rust
#[test]
fn test_circuit_allows_request() {
    assert!(CircuitState::Closed.allows_request());
    assert!(CircuitState::HalfOpen.allows_request());
    assert!(!CircuitState::Open.allows_request());
}

#[test]
fn test_circuit_default_is_closed() {
    assert_eq!(CircuitState::default(), CircuitState::Closed);
}
```

**PeerMetricsRegistry tests:**

```rust
#[test]
fn test_registry_record_outcome_updates_latency() {
    let registry = PeerMetricsRegistry::new();
    let id = AgentId::from_bytes([1; 32]);
    registry.record_outcome(&id, 50.0, true);
    let m = registry.get_or_create(&id);
    assert!(m.latency_ewma_ms.is_initialized());
    assert_eq!(m.latency_ewma_ms.value(), 50.0);
    assert_eq!(m.latency_min_ms, 50.0);
}

#[test]
fn test_registry_circuit_opens_on_failures() {
    let registry = PeerMetricsRegistry::new();
    let id = AgentId::from_bytes([2; 32]);
    // threshold = 5
    for _ in 0..5 {
        registry.record_outcome(&id, 100.0, false);
    }
    let m = registry.get_or_create(&id);
    assert_eq!(m.circuit, CircuitState::Open);
}

#[test]
fn test_registry_circuit_stays_closed_below_threshold() {
    let registry = PeerMetricsRegistry::new();
    let id = AgentId::from_bytes([3; 32]);
    for _ in 0..4 {
        registry.record_outcome(&id, 100.0, false);
    }
    let m = registry.get_or_create(&id);
    assert_eq!(m.circuit, CircuitState::Closed);
}

#[test]
fn test_registry_success_resets_failures() {
    let registry = PeerMetricsRegistry::new();
    let id = AgentId::from_bytes([4; 32]);
    for _ in 0..4 { registry.record_outcome(&id, 100.0, false); }
    registry.record_outcome(&id, 100.0, true); // resets
    let m = registry.get_or_create(&id);
    assert_eq!(m.consecutive_failures, 0);
    assert_eq!(m.circuit, CircuitState::Closed);
}

#[test]
fn test_registry_inflight_inc_dec() {
    let registry = PeerMetricsRegistry::new();
    let id = AgentId::from_bytes([5; 32]);
    registry.get_or_create(&id); // create entry
    registry.inflight_inc(&id);
    registry.inflight_inc(&id);
    let m = registry.get_or_create(&id);
    assert_eq!(m.in_flight, 2);
    registry.inflight_dec(&id);
    let m = registry.get_or_create(&id);
    assert_eq!(m.in_flight, 1);
}

#[test]
fn test_registry_check_circuit_unknown_peer() {
    let registry = PeerMetricsRegistry::new();
    let id = AgentId::from_bytes([6; 32]);
    // Unknown peer → optimistic Closed
    assert_eq!(registry.check_circuit(&id), CircuitState::Closed);
}
```

File: `crates/aafp-sdk/src/routing/scoring.rs` (inline test module)

**Scoring tests:**

```rust
#[test]
fn test_dynamic_score_circuit_open_is_zero() {
    let mut m = make_test_metrics();
    m.circuit = CircuitState::Open;
    let score = dynamic_score(&m, &DynamicScoreConfig::default(),
        Instant::now(), Duration::from_secs(60));
    assert_eq!(score, 0.0);
}

#[test]
fn test_dynamic_score_circuit_half_open_is_low() {
    let mut m = make_test_metrics();
    m.circuit = CircuitState::HalfOpen;
    let score = dynamic_score(&m, &DynamicScoreConfig::default(),
        Instant::now(), Duration::from_secs(60));
    assert_eq!(score, 0.1);
}

#[test]
fn test_dynamic_score_stale_returns_neutral() {
    let mut m = make_test_metrics();
    m.last_seen = Instant::now() - Duration::from_secs(120);
    let score = dynamic_score(&m, &DynamicScoreConfig::default(),
        Instant::now(), Duration::from_secs(60));
    assert_eq!(score, 0.5);
}

#[test]
fn test_dynamic_score_healthy_peer() {
    let mut m = make_test_metrics();
    m.circuit = CircuitState::Closed;
    m.last_seen = Instant::now();
    m.latency_ewma_ms = Ewma::new(0.1);
    m.latency_ewma_ms.update(10.0); // well below ref of 50
    for _ in 0..20 { m.success_window.record(true); }
    m.in_flight = 0;
    m.last_health = Some(HealthProbeResult::Healthy);
    let score = dynamic_score(&m, &DynamicScoreConfig::default(),
        Instant::now(), Duration::from_secs(60));
    assert!(score > 0.8, "healthy peer should score > 0.8, got {score}");
}

#[test]
fn test_dynamic_score_high_latency_penalized() {
    let mut m = make_test_metrics();
    m.latency_ewma_ms = Ewma::new(0.1);
    m.latency_ewma_ms.update(250.0); // 5x ref of 50 → score ~0
    for _ in 0..20 { m.success_window.record(true); }
    m.last_health = Some(HealthProbeResult::Healthy);
    let score = dynamic_score(&m, &DynamicScoreConfig::default(),
        Instant::now(), Duration::from_secs(60));
    // Latency score is 0, but other components pull it up.
    assert!(score < 0.8, "high latency should reduce score, got {score}");
}

#[test]
fn test_dynamic_score_no_latency_data() {
    let mut m = make_test_metrics();
    // latency_ewma_ms not initialized
    for _ in 0..10 { m.success_window.record(true); }
    m.last_health = Some(HealthProbeResult::Healthy);
    let score = dynamic_score(&m, &DynamicScoreConfig::default(),
        Instant::now(), Duration::from_secs(60));
    // Should use 0.5 for latency component
    assert!(score > 0.5 && score < 0.9);
}

#[test]
fn test_dynamic_score_clamped_to_unit_range() {
    let config = DynamicScoreConfig {
        weight_latency: 1.0, weight_success: 0.0, weight_load: 0.0,
        weight_availability: 0.0, weight_cost: 0.0,
        latency_ref_ms: 1.0, cost_ref_micro_usd: 1,
    };
    let mut m = make_test_metrics();
    m.latency_ewma_ms = Ewma::new(0.1);
    m.latency_ewma_ms.update(0.1); // very fast → score near 1.0
    let score = dynamic_score(&m, &config, Instant::now(), Duration::from_secs(60));
    assert!(score <= 1.0 && score >= 0.0);
}
```

File: `crates/aafp-sdk/src/routing/selection.rs` (inline test module)

**Selection strategy tests:**

```rust
use rand::SeedableRng;
use rand::rngs::StdRng;

fn make_candidates() -> Vec<SelectionCandidate> {
    vec![
        SelectionCandidate { agent_id: AgentId::from_bytes([1; 32]),
            score: 0.9, in_flight: 2, latency_ewma_ms: 10.0,
            latency_initialized: true, success_rate: 0.99 },
        SelectionCandidate { agent_id: AgentId::from_bytes([2; 32]),
            score: 0.5, in_flight: 10, latency_ewma_ms: 80.0,
            latency_initialized: true, success_rate: 0.80 },
        SelectionCandidate { agent_id: AgentId::from_bytes([3; 32]),
            score: 0.3, in_flight: 0, latency_ewma_ms: 200.0,
            latency_initialized: true, success_rate: 0.60 },
    ]
}

#[test]
fn test_p2c_returns_valid_candidate() {
    let cands = make_candidates();
    let mut rng = StdRng::seed_from_u64(42);
    let selected = select_power_of_two(&cands, &mut rng);
    assert!(selected.is_some());
    let id = selected.unwrap();
    assert!(cands.iter().any(|c| c.agent_id == id));
}

#[test]
fn test_p2c_single_candidate() {
    let cands = vec![make_candidates()[0].clone()];
    let mut rng = StdRng::seed_from_u64(42);
    let selected = select_power_of_two(&cands, &mut rng);
    assert_eq!(selected, Some(cands[0].agent_id));
}

#[test]
fn test_p2c_empty_returns_none() {
    let cands: Vec<SelectionCandidate> = vec![];
    let mut rng = StdRng::seed_from_u64(42);
    assert_eq!(select_power_of_two(&cands, &mut rng), None);
}

#[test]
fn test_weighted_random_favors_high_score() {
    let cands = make_candidates();
    let mut rng = StdRng::seed_from_u64(42);
    let mut counts = [0u32; 3];
    for _ in 0..10000 {
        let id = select_weighted_random(&cands, &mut rng).unwrap();
        for (i, c) in cands.iter().enumerate() {
            if c.agent_id == id { counts[i] += 1; }
        }
    }
    // Highest score (0.9) should be picked most often.
    assert!(counts[0] > counts[1], "score 0.9 should beat 0.5: {:?}", counts);
    assert!(counts[1] > counts[2], "score 0.5 should beat 0.3: {:?}", counts);
}

#[test]
fn test_weighted_random_all_zero_falls_back_uniform() {
    let mut cands = make_candidates();
    for c in &mut cands { c.score = 0.0; }
    let mut rng = StdRng::seed_from_u64(42);
    // Should not panic and should return something.
    let selected = select_weighted_random(&cands, &mut rng);
    assert!(selected.is_some());
}

#[test]
fn test_least_connections_picks_lowest_inflight() {
    let cands = make_candidates();
    let selected = select_least_connections(&cands);
    assert_eq!(selected, Some(cands[2].agent_id)); // in_flight=0
}

#[test]
fn test_lowest_latency_picks_fastest() {
    let cands = make_candidates();
    let selected = select_lowest_latency(&cands);
    assert_eq!(selected, Some(cands[0].agent_id)); // 10ms
}

#[test]
fn test_lowest_latency_no_initialized_falls_back_to_score() {
    let mut cands = make_candidates();
    for c in &mut cands { c.latency_initialized = false; }
    let selected = select_lowest_latency(&cands);
    // Falls back to highest score = cands[0] (score 0.9)
    assert_eq!(selected, Some(cands[0].agent_id));
}

#[test]
fn test_epsilon_greedy_explores() {
    let cands = make_candidates();
    let mut rng = StdRng::seed_from_u64(42);
    let mut non_best = 0;
    for _ in 0..1000 {
        let id = select_epsilon_greedy(&cands, 0.3, &mut rng).unwrap();
        if id != cands[0].agent_id { non_best += 1; }
    }
    // With epsilon=0.3, we expect ~30% non-best picks.
    assert!(non_best > 100, "expected exploration, got {non_best} non-best out of 1000");
}

#[test]
fn test_epsilon_greedy_zero_always_exploits() {
    let cands = make_candidates();
    let mut rng = StdRng::seed_from_u64(42);
    for _ in 0..100 {
        let id = select_epsilon_greedy(&cands, 0.0, &mut rng).unwrap();
        assert_eq!(id, cands[0].agent_id); // always best
    }
}

#[test]
fn test_selection_empty_returns_none() {
    let cands: Vec<SelectionCandidate> = vec![];
    let mut rng = StdRng::seed_from_u64(42);
    assert_eq!(select_weighted_random(&cands, &mut rng), None);
    assert_eq!(select_least_connections(&cands), None);
    assert_eq!(select_lowest_latency(&cands), None);
}
```

**score_candidates integration test:**

```rust
#[test]
fn test_score_candidates_filters_open_circuits() {
    let registry = PeerMetricsRegistry::new();
    let id1 = AgentId::from_bytes([1; 32]);
    let id2 = AgentId::from_bytes([2; 32]);

    // Trip circuit on id1
    for _ in 0..5 { registry.record_outcome(&id1, 100.0, false); }

    let candidates = vec![
        make_agent_record(id1),
        make_agent_record(id2),
    ];
    let static_scores = vec![1.0, 1.0];
    let scored = score_candidates(
        &candidates, &registry, &static_scores,
        &DynamicScoreConfig::default(), 0.5, 0.5,
    );
    // id1 should be filtered out (circuit open)
    assert_eq!(scored.len(), 1);
    assert_eq!(scored[0].0, id2);
}
```

## Constraints

1. **No wire-protocol changes.** Everything lives in the SDK. Metrics are
   collected passively (client-side observation) and via the existing
   `aafp.metrics` RPC. No new frame types, no new RPC methods.

2. **Backward compatibility is critical.** The 3-line API
   (`agent.discover("cap").call(req)`) must continue to work. The only
   behavioral change is that `discover()` no longer picks `candidates[0]` —
   it picks the best-scored candidate. This is a strict improvement.

3. **Feature-gated.** The `routing` module is behind `adaptive-routing`
   feature (enabled by default). Disabling it falls back to the existing
   failover loop. Use `#[cfg(feature = "adaptive-routing")]` on all routing
   code paths.

4. **Follow existing code conventions.** Check `AGENTS.md` for build/test
   commands. Use `cargo fmt`, `cargo clippy`, `cargo test --workspace`.
   The existing `metrics.rs` uses `AtomicU64` for lock-free counters; the
   new `PeerMetricsRegistry` uses `Mutex<HashMap>` because it needs
   compound updates (EWMA + window + circuit transition atomically).

5. **`AgentId` usage.** `AgentId` is `Copy` (it's `[u8; 32]`-based). Use
   `*agent_id` for HashMap keys. Check `aafp-identity` for the exact type
   and its `from_bytes()` / `From` impls.

6. **Thread safety.** `PeerMetricsRegistry` is wrapped in `Arc` and shared
   between the `DiscoveryBuilder` (call path) and the probe scheduler
   (future T3). All public methods take `&self` and use internal locking.

7. **Add tests for every new component.** Target: 1700+ tests (currently
   1597). Every struct, every scoring branch, every selection strategy
   must have coverage. Use `StdRng::seed_from_u64()` for deterministic
   selection tests.

## Verification

```bash
cargo fmt --all -- --check   # 0 diffs
cargo build --workspace       # 0 errors, 0 warnings
cargo clippy --workspace      # 0 warnings
cargo test --workspace        # 1700+ tests, 0 failures
```

Specifically run the routing module tests:
```bash
cargo test -p aafp-sdk routing::   # all routing tests pass
```

All existing examples must still work:
```bash
cargo run --example echo-agent
cargo run --example translation-pipeline
cargo run --example multi-agent-chat
```

## Files to Create/Modify

| File | Action | Changes |
|------|--------|---------|
| `crates/aafp-sdk/src/routing/mod.rs` | New | Module exports, `RoutingConfig`, `RoutingStrategy` enum + `select()` |
| `crates/aafp-sdk/src/routing/metrics.rs` | New | `Ewma`, `RollingWindow`, `PeerMetrics`, `PeerMetricsRegistry`, `HealthProbeResult`, `probe_peer()`, unit tests |
| `crates/aafp-sdk/src/routing/circuit.rs` | New | `CircuitState` enum, `allows_request()`, unit tests |
| `crates/aafp-sdk/src/routing/scoring.rs` | New | `DynamicScoreConfig`, `dynamic_score()`, `score_candidates()`, unit tests |
| `crates/aafp-sdk/src/routing/selection.rs` | New | `SelectionCandidate`, 5 selection functions, unit tests |
| `crates/aafp-sdk/src/lib.rs` | Modify | Add `#[cfg(feature = "adaptive-routing")] pub mod routing;` |
| `crates/aafp-sdk/Cargo.toml` | Modify | Add `adaptive-routing` feature (default), add `rand` dep if missing |
| `crates/aafp-sdk/src/simple.rs` | Modify | Add `registry` + `routing_config` to `DiscoveryBuilder`, replace failover loop with adaptive routing, instrument `call_agent_with_pool()` with passive metrics |

## Success Criteria

- [ ] `Ewma` struct with `new()`, `update()`, `value()`, `is_initialized()`, `reset()`
- [ ] `RollingWindow` struct with `new()`, `record()`, `success_rate()`, `sample_count()`, `reset()`
- [ ] `CircuitState` enum (Closed, Open, HalfOpen) with `allows_request()`
- [ ] `PeerMetrics` struct with latency, success, load, cost, availability, circuit fields
- [ ] `PeerMetricsRegistry` with `new()`, `get_or_create()`, `record_outcome()`, `inflight_inc/dec()`, `check_circuit()`, `is_stale()`, `snapshot_all()`
- [ ] Circuit breaker transitions: Closed→Open (threshold), Open→HalfOpen (cooldown), HalfOpen→Closed (success), HalfOpen→Open (failure)
- [ ] Passive metrics: `call_agent_with_pool()` records latency + success + in-flight
- [ ] Active probing: `probe_peer()` function using `aafp.metrics` RPC (scheduler deferred to T3)
- [ ] `DynamicScoreConfig` with 5 weights + 2 reference values, sensible defaults
- [ ] `dynamic_score()` with circuit gating, staleness penalty, 5 sub-scores, weighted combination
- [ ] `score_candidates()` pipeline: circuit filter + static + dynamic scoring
- [ ] 5 selection strategies: P2C (default), weighted random, least-connections, lowest-latency, epsilon-greedy
- [ ] `RoutingStrategy` enum with `select()` dispatch method
- [ ] `RoutingConfig` struct with all tunable parameters and `Default` impl
- [ ] `DiscoveryBuilder::call()` uses adaptive routing (score → select → call with metrics → failover)
- [ ] Backward compat: `adaptive-routing` feature off → legacy failover loop
- [ ] Unit tests for EWMA (initialization, convergence, alpha sensitivity, reset)
- [ ] Unit tests for RollingWindow (empty, all-success, all-failure, mixed, wrap-around, reset)
- [ ] Unit tests for CircuitState (allows_request, default)
- [ ] Unit tests for PeerMetricsRegistry (record_outcome, circuit opens, circuit stays closed, success resets, in-flight, unknown peer)
- [ ] Unit tests for dynamic_score (circuit open=0, half-open=0.1, stale=0.5, healthy>0.8, high latency penalized, no data, clamped)
- [ ] Unit tests for selection (P2C valid/single/empty, weighted random favors high score, all-zero fallback, least-connections, lowest-latency, no-init fallback, epsilon-greedy explores, epsilon=0 exploits, empty=none)
- [ ] Integration test: `score_candidates()` filters open circuits
- [ ] All existing tests pass (1597+)
- [ ] New tests for routing features (target 1700+ total)
- [ ] All examples still work
- [ ] `cargo clippy` clean
- [ ] `cargo fmt` clean
