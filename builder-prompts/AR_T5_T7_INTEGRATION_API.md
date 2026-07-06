# Builder Prompt: Adaptive Routing Plane — Phase T5-T7 (Track U Integration + API + Testing)

**Track:** T — Adaptive Routing (Phase 2, final integration)
**Phases:** T5 (API Surface & Config), T6 (Track U Integration), T7 (Testing & Conformance)
**Source documents:**
- `ADAPTIVE_ROUTING_PLANE.md` §7 (Metric Staleness), §8 (Track U Integration), §10 (API Surface), §12 (Module Structure)
- `SEMANTIC_CAPABILITY_GRAPHS.md` §8 (Integration with Adaptive Routing Plane)
**Depends on:** T1-T4 complete (`PeerMetricsRegistry`, `dynamic_score()`, selection strategies, `call_with_hedging()`); Track U `SemanticCapability` + `CapabilityQuery` landed.
**Feature flag:** `adaptive-routing` (enabled by default)

---

## Objective

Wire the dynamic routing plane (Track T) into the static semantic capability graph (Track U), expose a clean configuration and per-call override API, make every routing decision observable, and prove correctness with integration, performance, and conformance test suites. After this phase, `agent.discover("ocr").call(req)` routes to the *best* agent — not `candidates[0]` — with zero required configuration and full opt-in tunability.

The deliverable is three crates of work:
1. `crates/aafp-sdk/src/routing/combined.rs` — the `score_candidate()` function that fuses static + dynamic scores and applies hard-constraint filtering.
2. `crates/aafp-sdk/src/routing/config.rs` + `simple.rs` changes — `RoutingConfig` builder, `RoutingOptions` per-call overrides, `ConnectBuilder::with_routing()`, `DiscoveryBuilder` methods.
3. `crates/aafp-sdk/src/routing/observability.rs` + `prometheus.rs` changes — `RoutingDecision` logging, Prometheus metric export, `peer_metrics_snapshot()`.
4. `tests/routing/` — integration, performance, and conformance test suites.

---

## 1. Combined Scoring: Static + Dynamic

### 1.1 The Fusion Function

Track U produces a `static_score ∈ [0, 1]` from `CapabilityQuery::match_score(&SemanticCapability)`. Track T produces a `dynamic_score ∈ [0, 1]` from `dynamic_score(&PeerMetrics, &DynamicScoreConfig, ...)`. The combined score is a weighted sum:

```
total_score = w_static * static_score + w_dynamic * dynamic_score
```

where `w_static + w_dynamic = 1`. Defaults: `w_static = 0.5, w_dynamic = 0.5`. The static score captures *capability fit* (does this agent do what I need, well?); the dynamic score captures *current health* (is it performing right now?). Equal weighting is the neutral prior — neither dimension dominates until the caller opts into a different mix.

Implement `score_candidate()` in `crates/aafp-sdk/src/routing/combined.rs`:

```rust
use aafp_identity::AgentId;
use aafp_discovery::semantic::{SemanticCapability, CapabilityQuery};
use crate::routing::metrics::{PeerMetrics, PeerMetricsRegistry, CircuitState};
use crate::routing::scoring::{dynamic_score, DynamicScoreConfig};
use std::time::{Duration, Instant};

/// A single scored candidate, carrying both sub-scores for observability.
#[derive(Clone, Debug)]
pub struct ScoredCandidate {
    pub agent_id: AgentId,
    pub static_score: f64,
    pub dynamic_score: f64,
    pub total_score: f64,
    pub circuit: CircuitState,
}

/// Fuse static (Track U) and dynamic (Track T) scores for one candidate.
///
/// Pre-conditions:
/// - `static_score` is already computed by `CapabilityQuery::match_score()`.
/// - The candidate has already passed all hard-constraint filters (see §3).
/// - The caller holds no lock on `registry`; this function acquires it internally.
pub fn score_candidate(
    capability: &SemanticCapability,
    metrics: &PeerMetrics,
    query: &CapabilityQuery,
    dyn_config: &DynamicScoreConfig,
    static_weight: f64,
    dynamic_weight: f64,
    now: Instant,
    staleness_threshold: Duration,
) -> ScoredCandidate {
    let static_score = query.match_score(capability); // [0, 1]
    let dynamic_score_val = dynamic_score(
        metrics, dyn_config, now, staleness_threshold,
    );

    let total = (static_weight * static_score + dynamic_weight * dynamic_score_val)
        .clamp(0.0, 1.0);

    ScoredCandidate {
        agent_id: metrics.agent_id,
        static_score,
        dynamic_score: dynamic_score_val,
        total_score: total,
        circuit: metrics.circuit,
    }
}
```

### 1.2 Why Equal Weighting by Default

A pure-static router would pick the *best-advertised* agent, ignoring that it may be overloaded right now. A pure-dynamic router would pick the *fastest* agent, ignoring that it may not actually support the requested language or precision mode. Equal weighting means a peer must be *both* a good capability match *and* currently healthy to win — which is the behavior the Strategic Vision's "living map" demands. Callers who know their workload is latency-critical can shift weight via `RoutingConfig` (see §4).

---

## 2. Hard Constraints vs Soft Scoring

### 2.1 The Distinction

Track U queries express two kinds of requirements:

- **Hard constraints** — *must* be satisfied. A candidate that fails is **eliminated**, not penalized. Examples: `max_avg_latency_ms: Some(40.0)`, `hardware.gpu` exists, `language = "en"`. These are filters applied *before* scoring.
- **Soft preferences** — *should* be satisfied. A candidate that fails is **penalized** but not eliminated. Examples: `min_trust_score: 95` (a trust-90 peer is still usable, just less preferred), `cost < $0.0001` (a slightly pricier peer is acceptable if it's much faster).

The rule: **anything expressed as a `QueryFilter::Range` with `LessThan`/`LessThanOrEqual` on a performance or cost field is a hard constraint; anything in `QualityFilter` with a `min_*` is soft unless the caller marks it `hard: true`.**

### 2.2 Static Hard Constraints (Track U)

These run first, on *advertised* `SemanticCapability` data:

```rust
/// Returns true if the capability satisfies all hard constraints in the query.
pub fn passes_static_constraints(
    capability: &SemanticCapability,
    query: &CapabilityQuery,
) -> bool {
    // Performance: advertised latency/throughput.
    if let Some(perf_filter) = &query.performance {
        if let Some(max_lat) = perf_filter.max_avg_latency_ms {
            if capability.performance.avg_latency_ms > max_lat {
                return false; // advertises > 40ms → eliminated
            }
        }
        if let Some(min_tput) = perf_filter.min_throughput_rps {
            if capability.performance.throughput_rps < min_tput {
                return false;
            }
        }
    }
    // Cost: advertised per-invocation cost.
    if let Some(cost_filter) = &query.cost {
        if let Some(max_cost) = cost_filter.max_per_invocation_micro_usd {
            if capability.cost.per_invocation_micro_usd > max_cost {
                return false;
            }
        }
    }
    // Attribute filters (Equality, In, Exists) are always hard.
    for filter in &query.filters {
        if !filter.matches(capability) {
            return false;
        }
    }
    true
}
```

### 2.3 Soft Scoring (Quality, Trust)

Quality filters contribute to the *static score* via `match_score()`, not to filtering. A peer with `trust_score: 90` against a query asking for `min_trust_score: 95` is *not* eliminated — it receives a lower static score. This is critical because trust is a reputation signal (Track W), not a binary gate; starving a slightly-lower-trust peer prevents it from ever building reputation.

---

## 3. Dynamic Constraint Filtering

### 3.1 The Problem

A peer may *advertise* 14ms latency but *currently deliver* 200ms because it's overloaded. The static filter passes (14 < 40), but routing to it would violate the caller's SLA. We need a **dynamic hard-constraint filter** that prunes candidates based on *observed* metrics before scoring.

### 3.2 Implementation

```rust
/// Dynamic hard-constraint filter: reject peers whose *observed* metrics
/// violate the query's hard constraints by a configurable margin.
///
/// The margin is 2x for latency: a peer advertising "<40ms" is pruned only
/// if its observed EWMA exceeds 80ms. This avoids flapping under transient
/// latency spikes while catching sustained degradation.
pub fn passes_dynamic_constraints(
    metrics: &PeerMetrics,
    query: &CapabilityQuery,
    registry: &PeerMetricsRegistry,
) -> bool {
    // Circuit-open is always a hard reject.
    if metrics.circuit == CircuitState::Open {
        return false;
    }

    // Observed latency vs. query's max_avg_latency_ms (2x margin).
    if let Some(perf) = &query.performance {
        if let Some(max_lat) = perf.max_avg_latency_ms {
            if metrics.latency_ewma_ms.is_initialized() {
                if metrics.latency_ewma_ms.value() > max_lat * 2.0 {
                    return false;
                }
            }
        }
    }

    // Staleness: if metrics are stale AND the query has hard performance
    // constraints, we cannot trust the peer to meet them. Prune.
    if registry.is_stale(&metrics.agent_id) {
        if let Some(perf) = &query.performance {
            if perf.max_avg_latency_ms.is_some()
                || perf.min_throughput_rps.is_some()
            {
                return false;
            }
        }
    }

    true
}
```

### 3.3 The Full Pipeline

The routing pipeline is a three-stage funnel: **static filter → dynamic filter → score**. Implement it as `route_candidates()`:

```rust
/// The complete routing pipeline: filter then score.
///
/// Returns scored survivors, best-first. Empty vec = no viable candidate.
pub fn route_candidates(
    candidates: &[(SemanticCapability, AgentId)], // from Track U discovery
    query: &CapabilityQuery,
    registry: &PeerMetricsRegistry,
    config: &RoutingConfig,
    now: Instant,
) -> Vec<ScoredCandidate> {
    // Stage 1: static hard constraints (advertised data).
    let static_survivors: Vec<_> = candidates
        .iter()
        .filter(|(cap, _)| passes_static_constraints(cap, query))
        .collect();

    // Stage 2: dynamic hard constraints (observed data).
    let dynamic_survivors: Vec<_> = static_survivors
        .iter()
        .filter_map(|(cap, agent_id)| {
            let metrics = registry.get_or_create(agent_id);
            if passes_dynamic_constraints(&metrics, query, registry) {
                Some((cap, agent_id, metrics))
            } else {
                None
            }
        })
        .collect();

    // Stage 3: score the survivors.
    let mut scored: Vec<ScoredCandidate> = dynamic_survivors
        .iter()
        .map(|(cap, agent_id, metrics)| {
            score_candidate(
                cap,
                metrics,
                query,
                &config.dynamic_score,
                config.static_weight,
                config.dynamic_weight,
                now,
                config.staleness_threshold,
            )
        })
        .collect();

    // Sort descending by total_score.
    scored.sort_by(|a, b| {
        b.total_score
            .partial_cmp(&a.total_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
}
```

**Key invariant:** if `route_candidates()` returns an empty vec, *no* candidate can meet the query's hard constraints — neither advertised nor observed. The caller surfaces `SdkError::NoViableCandidate` rather than falling back to `candidates[0]`.

---

## 4. RoutingConfig Builder

### 4.1 The Config Struct

`RoutingConfig` is the single entry point for tuning the routing plane. It lives in `crates/aafp-sdk/src/routing/config.rs`:

```rust
use std::time::Duration;
use crate::routing::scoring::DynamicScoreConfig;

/// Routing strategy selector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoutingStrategy {
    PowerOfTwo,                       // default
    WeightedRandom,
    LeastConnections,
    LowestLatency,
    EpsilonGreedy { epsilon: f64 },
}

/// Circuit breaker configuration.
#[derive(Clone, Debug)]
pub struct CircuitBreakerConfig {
    pub failure_threshold: u32,       // consecutive failures to trip
    pub cooldown: Duration,            // Open → HalfOpen wait
    pub half_open_max_trials: u32,    // concurrent trial requests in HalfOpen
}

/// Hedging policy.
#[derive(Clone, Debug)]
pub struct HedgePolicy {
    pub enabled: bool,
    pub delay: Duration,              // wait this long before sending secondary
    pub adaptive: bool,               // only hedge if primary predicted to miss deadline
    pub max_concurrent_hedges: u32,   // bound duplicate load
}

/// Top-level routing configuration.
#[derive(Clone, Debug)]
pub struct RoutingConfig {
    pub strategy: RoutingStrategy,
    pub dynamic_score: DynamicScoreConfig,
    pub static_weight: f64,
    pub dynamic_weight: f64,
    pub circuit: CircuitBreakerConfig,
    pub hedge: HedgePolicy,
    pub staleness_threshold: Duration,
    pub probe_interval: Duration,
    pub concurrency_limit: u32,       // per-peer max in-flight
    pub dynamic_constraint_margin: f64, // e.g., 2.0 for 2x latency margin
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            strategy: RoutingStrategy::PowerOfTwo,
            dynamic_score: DynamicScoreConfig::default(),
            static_weight: 0.5,
            dynamic_weight: 0.5,
            circuit: CircuitBreakerConfig {
                failure_threshold: 5,
                cooldown: Duration::from_secs(10),
                half_open_max_trials: 1,
            },
            hedge: HedgePolicy {
                enabled: false,
                delay: Duration::from_millis(50),
                adaptive: true,
                max_concurrent_hedges: 4,
            },
            staleness_threshold: Duration::from_secs(60),
            probe_interval: Duration::from_secs(10),
            concurrency_limit: 16,
            dynamic_constraint_margin: 2.0,
        }
    }
}
```

### 4.2 Builder Integration

`ConnectBuilder` gains `.with_routing()`. Without it, `RoutingConfig::default()` applies:

```rust
impl ConnectBuilder {
    /// Install a custom routing configuration. Without this call, sensible
    /// defaults are used (P2C strategy, equal static/dynamic weighting,
    /// circuit breaker with 5-failure threshold, hedging off).
    pub fn with_routing(mut self, config: RoutingConfig) -> Self {
        self.routing_config = Some(config);
        self
    }
}
```

Usage:

```rust
// Default — adaptive routing on, no tuning needed.
let agent = Agent::connect().connect().await?;

// Latency-critical workload: favor dynamic score, hedge aggressively.
let agent = Agent::connect()
    .with_routing(RoutingConfig {
        strategy: RoutingStrategy::LowestLatency,
        static_weight: 0.3,
        dynamic_weight: 0.7,
        hedge: HedgePolicy {
            enabled: true,
            delay: Duration::from_millis(30),
            adaptive: true,
            max_concurrent_hedges: 2,
        },
        ..Default::default()
    })
    .connect()
    .await?;
```

---

## 5. Per-Call Overrides (RoutingOptions)

### 5.1 The Override Struct

Some calls need different routing than the agent-wide default — e.g., hedging on a user-facing translation but not on a background batch job. `RoutingOptions` is a lightweight per-call overlay:

```rust
/// Per-call routing overrides. Fields that are `None` inherit the
/// agent-wide `RoutingConfig` value.
#[derive(Clone, Debug, Default)]
pub struct RoutingOptions {
    pub strategy: Option<RoutingStrategy>,
    pub hedge: Option<bool>,
    pub hedge_delay: Option<Duration>,
    pub static_weight: Option<f64>,
    pub dynamic_weight: Option<f64>,
    pub deadline_ms: Option<f64>,    // per-call deadline for adaptive hedging
    pub skip_circuit: Option<bool>,  // bypass circuit breaker (dangerous; for admin calls)
}

impl RoutingOptions {
    /// Merge per-call overrides into an agent-wide config, producing the
    /// effective config for this one call.
    pub fn resolve(&self, base: &RoutingConfig) -> RoutingConfig {
        let mut effective = base.clone();
        if let Some(s) = self.strategy { effective.strategy = s; }
        if let Some(true) = self.hedge { effective.hedge.enabled = true; }
        if let Some(false) = self.hedge { effective.hedge.enabled = false; }
        if let Some(d) = self.hedge_delay { effective.hedge.delay = d; }
        if let Some(w) = self.static_weight { effective.static_weight = w; }
        if let Some(w) = self.dynamic_weight { effective.dynamic_weight = w; }
        effective
    }
}
```

### 5.2 DiscoveryBuilder Methods

`DiscoveryBuilder` gains builder methods that populate `RoutingOptions`:

```rust
impl<'a> DiscoveryBuilder<'a> {
    /// Override the routing strategy for this call only.
    pub fn strategy(mut self, s: RoutingStrategy) -> Self {
        self.options.strategy = Some(s);
        self
    }

    /// Enable or disable hedging for this call only.
    pub fn hedge(mut self, enabled: bool) -> Self {
        self.options.hedge = Some(enabled);
        self
    }

    /// Set a per-call deadline (ms) used for adaptive hedging decisions.
    pub fn deadline(mut self, ms: f64) -> Self {
        self.options.deadline_ms = Some(ms);
        self
    }

    /// Bias this call toward dynamic score (e.g., 0.3 static / 0.7 dynamic).
    pub fn bias_dynamic(mut self, dynamic_weight: f64) -> Self {
        self.options.dynamic_weight = Some(dynamic_weight);
        self.options.static_weight = Some(1.0 - dynamic_weight);
        self
    }
}
```

Usage:

```rust
// User-facing call: hedge, latency-biased, 100ms deadline.
let result = agent.discover("translation")
    .hedge(true)
    .bias_dynamic(0.7)
    .deadline(100.0)
    .call(Request::text("translate this"))
    .await?;

// Background batch: no hedging, strategy that spreads load.
let result = agent.discover("inference")
    .strategy(RoutingStrategy::LeastConnections)
    .hedge(false)
    .call(Request::text("batch inference"))
    .await?;
```

---

## 6. Observability

### 6.1 RoutingDecision Log Record

Every routing decision produces a `RoutingDecision` record, stored in a ring buffer (last 1024 decisions) and emitted to the `tracing` span:

```rust
use aafp_identity::AgentId;
use crate::routing::config::RoutingStrategy;

/// A routing decision record, for logging and debugging.
#[derive(Clone, Debug)]
pub struct RoutingDecision {
    pub capability: String,
    pub query_summary: String,           // human-readable query digest
    pub candidates_total: usize,
    pub candidates_passed_static: usize,
    pub candidates_passed_dynamic: usize,
    pub candidates_filtered_circuit: usize,
    pub selected: Option<AgentId>,
    pub selected_static_score: Option<f64>,
    pub selected_dynamic_score: Option<f64>,
    pub selected_total_score: Option<f64>,
    pub selected_latency_ewma_ms: Option<f64>,
    pub selected_success_rate: Option<f64>,
    pub strategy: RoutingStrategy,
    pub hedged: bool,
    pub elapsed_us: u64,                  // routing decision time
}

/// Thread-safe ring buffer of recent routing decisions.
pub struct DecisionLog {
    buffer: Mutex<std::collections::VecDeque<RoutingDecision>>,
    capacity: usize,
}

impl DecisionLog {
    pub fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            buffer: Mutex::new(std::collections::VecDeque::with_capacity(capacity)),
            capacity,
        })
    }

    pub fn record(&self, decision: RoutingDecision) {
        let mut buf = self.buffer.lock().unwrap();
        if buf.len() >= self.capacity {
            buf.pop_front();
        }
        buf.push_back(decision);
        // Also emit to tracing for structured log consumers.
        tracing::debug!(
            capability = %decision.capability,
            selected = ?decision.selected,
            score = ?decision.selected_total_score,
            "routing decision"
        );
    }

    pub fn snapshot(&self) -> Vec<RoutingDecision> {
        self.buffer.lock().unwrap().iter().cloned().collect()
    }
}
```

### 6.2 Prometheus Metrics

Extend `crates/aafp-sdk/src/prometheus.rs` with routing-specific metrics. Use the existing exporter infrastructure (Track S4):

```rust
use prometheus::{IntCounter, Histogram, GaugeVec, Opts, HistogramOpts};

pub struct RoutingMetrics {
    pub decisions_total: IntCounter,
    pub circuit_open_total: IntCounter,
    pub hedge_total: IntCounter,
    pub hedge_won_total: IntCounter,        // primary lost the race
    pub no_viable_candidate_total: IntCounter,
    pub decision_latency_us: Histogram,     // routing decision time
    pub peer_latency_ewma_ms: GaugeVec,     // labels: agent_id
    pub peer_success_rate: GaugeVec,        // labels: agent_id
    pub peer_in_flight: GaugeVec,           // labels: agent_id
    pub peer_circuit_state: GaugeVec,       // labels: agent_id; 0=closed,1=open,2=half
}

impl RoutingMetrics {
    pub fn register(registry: &prometheus::Registry) -> Result<Self, prometheus::Error> {
        let metrics = Self {
            decisions_total: IntCounter::new("aafp_routing_decisions_total", "Total routing decisions made")?,
            circuit_open_total: IntCounter::new("aafp_routing_circuit_open_total", "Total calls rejected due to open circuit")?,
            hedge_total: IntCounter::new("aafp_routing_hedge_total", "Total hedged requests sent")?,
            hedge_won_total: IntCounter::new("aafp_routing_hedge_won_total", "Hedge requests that won the race")?,
            no_viable_candidate_total: IntCounter::new("aafp_routing_no_viable_total", "Calls with zero viable candidates")?,
            decision_latency_us: Histogram::with_opts(HistogramOpts::new(
                "aafp_routing_decision_us",
                "Routing decision latency in microseconds",
            ).buckets(vec![1.0, 5.0, 10.0, 50.0, 100.0, 500.0, 1000.0]))?,
            peer_latency_ewma_ms: GaugeVec::new(Opts::new("aafp_peer_latency_ewma_ms", "Peer EWMA latency ms"), &["agent_id"])?,
            peer_success_rate: GaugeVec::new(Opts::new("aafp_peer_success_rate", "Peer rolling success rate"), &["agent_id"])?,
            peer_in_flight: GaugeVec::new(Opts::new("aafp_peer_in_flight", "Peer in-flight requests"), &["agent_id"])?,
            peer_circuit_state: GaugeVec::new(Opts::new("aafp_peer_circuit_state", "Peer circuit state 0=closed 1=open 2=half"), &["agent_id"])?,
        };
        registry.register(Box::new(metrics.decisions_total.clone()))?;
        registry.register(Box::new(metrics.circuit_open_total.clone()))?;
        registry.register(Box::new(metrics.hedge_total.clone()))?;
        registry.register(Box::new(metrics.hedge_won_total.clone()))?;
        registry.register(Box::new(metrics.no_viable_candidate_total.clone()))?;
        registry.register(Box::new(metrics.decision_latency_us.clone()))?;
        registry.register(Box::new(metrics.peer_latency_ewma_ms.clone()))?;
        registry.register(Box::new(metrics.peer_success_rate.clone()))?;
        registry.register(Box::new(metrics.peer_in_flight.clone()))?;
        registry.register(Box::new(metrics.peer_circuit_state.clone()))?;
        Ok(metrics)
    }
}
```

A background task (spawned on `connect()`) scrapes `PeerMetricsRegistry` every 5s and updates the per-peer gauges. The `DecisionLog` is updated synchronously on every `discover().call()`.

### 6.3 API Access

```rust
impl ConnectedAgent {
    /// Access the last N routing decisions (for debugging UIs).
    pub fn recent_routing_decisions(&self, n: usize) -> Vec<RoutingDecision> {
        self.routing.decision_log.snapshot().into_iter().take(n).collect()
    }

    /// Snapshot all peer metrics (for monitoring dashboards).
    pub fn peer_metrics_snapshot(&self) -> Vec<PeerMetrics> {
        self.routing.registry.snapshot_all()
    }
}
```

---

## 7. Integration Tests

Location: `crates/aafp-sdk/tests/routing/integration.rs`

### 7.1 Multi-Agent Routing with Latency Skew

Start 5 agents advertising `"ocr"`. Inject artificial latency into 3 of them (200ms) and keep 2 fast (5ms). Issue 1000 calls via `discover("ocr").call(...)`. Assert that >80% of calls route to the 2 fast agents after metrics warm up.

```rust
#[tokio::test]
async fn routing_skews_toward_fast_agents() {
    let fast_agents = spawn_agents_with_latency(2, "ocr", Duration::from_millis(5)).await;
    let slow_agents = spawn_agents_with_latency(3, "ocr", Duration::from_millis(200)).await;
    let caller = Agent::connect().connect().await.unwrap();

    // Warm up: first few calls populate metrics.
    for _ in 0..20 {
        let _ = caller.discover("ocr").call(Request::text("warmup")).await;
    }

    // Measure distribution over 1000 calls.
    let mut fast_hits = 0;
    for _ in 0..1000 {
        let result = caller.discover("ocr").call(Request::text("test")).await.unwrap();
        if fast_agents.contains(&result.served_by) {
            fast_hits += 1;
        }
    }
    assert!(fast_hits > 800, "expected >80% fast hits, got {fast_hits}");
}
```

### 7.2 Circuit Breaker Failover

Start 3 agents. Make one return errors after 10 successful calls. Assert that after `failure_threshold` (5) consecutive failures, the circuit opens and all calls route to the other 2. Then heal the failing agent and assert the circuit transitions HalfOpen → Closed and traffic resumes.

```rust
#[tokio::test]
async fn circuit_breaker_failover_and_recovery() {
    let agents = spawn_agents(3, "inference").await;
    let failing_agent = &agents[1];
    let caller = Agent::connect()
        .with_routing(RoutingConfig {
            circuit: CircuitBreakerConfig {
                failure_threshold: 5,
                cooldown: Duration::from_millis(500),
                ..Default::default()
            },
            ..Default::default()
        })
        .connect().await.unwrap();

    // Phase 1: all healthy, calls distribute.
    for _ in 0..10 {
        caller.discover("inference").call(Request::text("ok")).await.unwrap();
    }

    // Phase 2: agent[1] starts failing.
    failing_agent.set_error_mode(ErrorMode::AlwaysFail).await;
    for _ in 0..10 {
        let _ = caller.discover("inference").call(Request::text("failing")).await;
    }
    // Circuit should be open for agent[1].
    let snapshot = caller.peer_metrics_snapshot();
    let failing_metrics = snapshot.iter().find(|m| m.agent_id == failing_agent.id()).unwrap();
    assert_eq!(failing_metrics.circuit, CircuitState::Open);

    // Phase 3: heal agent[1], wait for cooldown.
    failing_agent.set_error_mode(ErrorMode::Healthy).await;
    sleep(Duration::from_millis(600)).await;
    // Trial request should succeed and close the circuit.
    for _ in 0..10 {
        caller.discover("inference").call(Request::text("healed")).await.unwrap();
    }
    let snapshot = caller.peer_metrics_snapshot();
    let healed = snapshot.iter().find(|m| m.agent_id == failing_agent.id()).unwrap();
    assert_eq!(healed.circuit, CircuitState::Closed);
}
```

### 7.3 Hard Constraint Elimination

Start 4 agents advertising `"translation"` with different advertised latencies: 10ms, 30ms, 50ms, 100ms. Issue a query with `max_avg_latency_ms: Some(40.0)`. Assert that only the 10ms and 30ms agents are ever selected.

```rust
#[tokio::test]
async fn hard_constraint_eliminates_slow_advertisers() {
    let agents = spawn_agents_with_advertised_latency(
        vec![("translation", 10.0), ("translation", 30.0),
             ("translation", 50.0), ("translation", 100.0)],
    ).await;
    let caller = Agent::connect().connect().await.unwrap();

    let query = CapabilityQuery::new("translation")
        .with_performance(PerformanceFilter {
            max_avg_latency_ms: Some(40.0),
            min_throughput_rps: None,
        })
        .build();

    for _ in 0..100 {
        let result = caller.discover_semantic(query.clone())
            .call(Request::text("test"))
            .await
            .unwrap();
        let served_latency = agents.iter()
            .find(|a| a.id() == result.served_by)
            .unwrap()
            .advertised_latency;
        assert!(served_latency <= 40.0, "selected agent advertises {served_latency}ms");
    }
}
```

### 7.4 Dynamic Constraint Pruning

A peer advertises 14ms but currently delivers 200ms (overloaded). Query has `max_avg_latency_ms: 40`. Static filter passes (14 < 40), but dynamic filter prunes (200 > 80 = 40 * 2.0 margin). Assert the peer is never selected after metrics warm up.

### 7.5 Hedging Race

Start 2 agents (5ms and 200ms). Enable hedging with 20ms delay. Assert that the fast agent's response is always used and the slow call is cancelled (verify via the slow agent's `cancelled_count` metric).

---

## 8. Performance Tests

Location: `crates/aafp-sdk/tests/routing/performance.rs`

### 8.1 Routing Overhead Measurement

Measure the time spent in `route_candidates()` + selection, excluding the actual RPC. The routing decision must add < 100µs per call (P99) for candidate sets up to 50 agents.

```rust
#[tokio::test]
async fn routing_overhead_under_100us_p99() {
    let candidates = generate_synthetic_candidates(50, "ocr");
    let registry = PeerMetricsRegistry::new();
    let config = RoutingConfig::default();
    let query = CapabilityQuery::new("ocr").build();

    // Warm up.
    for _ in 0..1000 {
        let _ = route_candidates(&candidates, &query, &registry, &config, Instant::now());
    }

    // Measure 10,000 routing decisions.
    let mut latencies_us = Vec::with_capacity(10_000);
    for _ in 0..10_000 {
        let start = Instant::now();
        let scored = route_candidates(&candidates, &query, &registry, &config, Instant::now());
        let _ = select_power_of_two(
            &scored.iter().map(|s| (s.agent_id, s.total_score)).collect::<Vec<_>>(),
            &mut rand::thread_rng(),
        );
        latencies_us.push(start.elapsed().as_micros() as u64);
    }
    latencies_us.sort();
    let p99 = latencies_us[(latencies_us.len() as f64 * 0.99) as usize];
    assert!(p99 < 100, "routing P99 overhead {p99}µs exceeds 100µs budget");
}
```

### 8.2 Scoring Scalability

Benchmark `score_candidate()` at candidate set sizes of 10, 100, 1000. Assert linear scaling (O(n)) and that 1000 candidates score in < 1ms.

### 8.3 Registry Contention

With 16 concurrent callers hitting `record_outcome()` and `get_or_create()` simultaneously, assert no deadlock and P99 lock-wait < 10µs. This validates the `Mutex<HashMap>` choice; if contention is too high, document the migration to `DashMap` as a follow-up.

---

## 9. Conformance Tests

Location: `crates/aafp-sdk/tests/routing/conformance.rs`

These tests verify that the circuit breaker state machine matches the spec in `ADAPTIVE_ROUTING_PLANE.md` §5.1 *exactly*. Each transition is tested in isolation.

### 9.1 Closed → Open (failure threshold)

```rust
#[test]
fn circuit_transitions_closed_to_open_at_threshold() {
    let registry = PeerMetricsRegistry::new();
    let agent_id = AgentId::generate();
    let config = RoutingConfig {
        circuit: CircuitBreakerConfig {
            failure_threshold: 5,
            ..Default::default()
        },
        ..Default::default()
    };

    // 4 failures: still closed.
    for _ in 0..4 {
        registry.record_outcome(&agent_id, 10.0, false);
    }
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Closed);

    // 5th failure: open.
    registry.record_outcome(&agent_id, 10.0, false);
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Open);
}
```

### 9.2 Open → HalfOpen (cooldown)

```rust
#[test]
fn circuit_transitions_open_to_halfopen_after_cooldown() {
    let registry = PeerMetricsRegistry::new_with_config(
        0.1, 64, 5, Duration::from_millis(100), Duration::from_secs(60),
    );
    let agent_id = AgentId::generate();

    // Trip the circuit.
    for _ in 0..5 {
        registry.record_outcome(&agent_id, 10.0, false);
    }
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Open);

    // Before cooldown: still open.
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Open);

    // After cooldown: half-open.
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::HalfOpen);
}
```

### 9.3 HalfOpen → Closed (trial success)

```rust
#[test]
fn circuit_transitions_halfopen_to_closed_on_success() {
    let registry = PeerMetricsRegistry::new_with_config(
        0.1, 64, 5, Duration::from_millis(100), Duration::from_secs(60),
    );
    let agent_id = AgentId::generate();

    // Trip and wait for half-open.
    for _ in 0..5 { registry.record_outcome(&agent_id, 10.0, false); }
    std::thread::sleep(Duration::from_millis(110));
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::HalfOpen);

    // Trial success → closed.
    registry.record_outcome(&agent_id, 10.0, true);
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Closed);
}
```

### 9.4 HalfOpen → Open (trial failure)

```rust
#[test]
fn circuit_transitions_halfopen_to_open_on_failure() {
    let registry = PeerMetricsRegistry::new_with_config(
        0.1, 64, 5, Duration::from_millis(100), Duration::from_secs(60),
    );
    let agent_id = AgentId::generate();

    // Trip and wait for half-open.
    for _ in 0..5 { registry.record_outcome(&agent_id, 10.0, false); }
    std::thread::sleep(Duration::from_millis(110));
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::HalfOpen);

    // Trial failure → back to open, cooldown restarts.
    registry.record_outcome(&agent_id, 10.0, false);
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Open);
    // Immediately after: still open (cooldown not elapsed).
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Open);
}
```

### 9.5 Success Resets Failure Counter

```rust
#[test]
fn success_resets_consecutive_failure_counter() {
    let registry = PeerMetricsRegistry::new();
    let agent_id = AgentId::generate();

    // 4 failures (one short of threshold).
    for _ in 0..4 { registry.record_outcome(&agent_id, 10.0, false); }
    // One success resets the counter.
    registry.record_outcome(&agent_id, 10.0, true);
    // 4 more failures: should NOT trip (counter restarted).
    for _ in 0..4 { registry.record_outcome(&agent_id, 10.0, false); }
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Closed);
    // 5th failure trips.
    registry.record_outcome(&agent_id, 10.0, false);
    assert_eq!(registry.check_circuit(&agent_id), CircuitState::Open);
}
```

### 9.6 Dynamic Constraint Margin Conformance

Assert that the 2x margin is applied exactly: a peer with observed EWMA of 79ms passes a 40ms hard constraint (79 < 80), but 81ms fails (81 > 80).

---

## 10. Module Structure (Final)

After T5-T7, the `routing/` module is complete:

```
crates/aafp-sdk/src/routing/
├── mod.rs              // Public exports
├── metrics.rs          // Ewma, RollingWindow, PeerMetrics, PeerMetricsRegistry  (T1)
├── circuit.rs          // CircuitState transitions                          (T1)
├── scoring.rs          // dynamic_score(), DynamicScoreConfig               (T2)
├── selection.rs        // P2C, weighted random, least-conn, lowest-latency  (T2)
├── probe.rs            // Active health probing                             (T3)
├── hedging.rs          // call_with_hedging(), adaptive hedging             (T4)
├── config.rs           // RoutingConfig, RoutingOptions, builder methods    (T5) ← NEW
├── combined.rs         // score_candidate(), route_candidates(), filters   (T6) ← NEW
└── observability.rs    // RoutingDecision, DecisionLog, Prometheus metrics  (T5) ← NEW
```

`mod.rs` re-exports the public API:

```rust
pub mod metrics;
pub mod circuit;
pub mod scoring;
pub mod selection;
pub mod probe;
pub mod hedging;
pub mod config;
pub mod combined;
pub mod observability;

pub use config::{RoutingConfig, RoutingOptions, RoutingStrategy, HedgePolicy, CircuitBreakerConfig};
pub use combined::{score_candidate, route_candidates, ScoredCandidate,
                   passes_static_constraints, passes_dynamic_constraints};
pub use observability::{RoutingDecision, DecisionLog, RoutingMetrics};
pub use metrics::{PeerMetrics, PeerMetricsRegistry, CircuitState};
```

---

## 11. Acceptance Criteria

- [ ] `agent.discover("ocr").call(req)` routes via `route_candidates()` + P2C, not `candidates[0]`.
- [ ] `Agent::connect().with_routing(RoutingConfig { ... }).connect()` applies custom config.
- [ ] `discover("cap").hedge(true).deadline(100.0).call(...)` applies per-call overrides.
- [ ] Hard constraints (`max_avg_latency_ms`) eliminate candidates before scoring.
- [ ] Dynamic constraints prune candidates whose observed latency exceeds 2x the advertised limit.
- [ ] Soft scoring (trust, cost) penalizes but does not eliminate.
- [ ] `RoutingDecision` is logged for every call and accessible via `recent_routing_decisions()`.
- [ ] Prometheus exports `aafp_routing_decisions_total`, `aafp_routing_circuit_open_total`, `aafp_peer_latency_ewma_ms`, etc.
- [ ] Integration test: 5 agents with latency skew → >80% traffic to fast agents.
- [ ] Integration test: circuit breaker failover + recovery.
- [ ] Integration test: hard constraint eliminates slow advertisers.
- [ ] Performance test: routing P99 overhead < 100µs for 50 candidates.
- [ ] Conformance: all 6 circuit breaker state transitions match spec exactly.
- [ ] `cargo test -p aafp-sdk --features adaptive-routing` passes.
- [ ] No wire-protocol changes (all routing is SDK-side).

---

## 12. References

- `ADAPTIVE_ROUTING_PLANE.md` §7 (Metric Staleness), §8 (Track U Integration), §10 (API Surface), §12 (Module Structure)
- `SEMANTIC_CAPABILITY_GRAPHS.md` §8 (Combined Scoring)
- `STRATEGIC_VISION.md` — "routing is evolving intelligence, not immutable protocol"
- `ADAPTATION_ROADMAP.md` — Track T depends on Track U
