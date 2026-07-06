# Builder Prompt: Adaptive Routing Plane Phase T3-T4 — Circuit Breaker + Request Hedging

## Objective

Implement the resilience layer of the Adaptive Routing Plane: a full
three-state circuit breaker with bulkhead concurrency limits, request
hedging with cancellation, adaptive hedging policy, and retry with
exponential backoff + jitter. This layer sits between candidate selection
(Phase T2) and the transport (ConnectionPool), ensuring that the routing
plane is not just *smart* but *fault-tolerant*.

## Context

Read these design documents before starting:
- `ADAPTIVE_ROUTING_PLANE.md` — Complete routing design (sections 5, 6, 10, 11)
- `AGENTS.md` (in `implementations/rust/`) — Build & test commands, conventions
- `implementations/rust/crates/aafp-sdk/src/connection_pool.rs` — Existing pool API
- `implementations/rust/crates/aafp-sdk/src/simple.rs` — `call_agent_with_pool()`, `DiscoveryBuilder`

This phase assumes Phase T1-T2 (metrics + scoring) has landed:
- `crates/aafp-sdk/src/routing/metrics.rs` — `PeerMetrics`, `PeerMetricsRegistry`, `Ewma`, `RollingWindow`
- `crates/aafp-sdk/src/routing/scoring.rs` — `dynamic_score()`, `DynamicScoreConfig`
- `crates/aafp-sdk/src/routing/selection.rs` — `select_power_of_two()`, etc.

If those modules do not yet exist, create them first per the T1-T2 spec
(sections 3, 4 of the design doc) before proceeding to T3-T4.

## What to Build

### Part 1: CircuitBreaker Struct (ADAPTIVE_ROUTING_PLANE.md §5.1)

Create `crates/aafp-sdk/src/routing/circuit.rs`. The circuit breaker is a
three-state machine: `Closed → Open → HalfOpen → Closed`. It is *per-peer*
(keyed by `AgentId`) and thread-safe.

```rust
use aafp_identity::AgentId;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Circuit breaker state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CircuitState {
    /// Normal operation. Requests flow. Failures increment the counter.
    Closed,
    /// Tripped. Requests are short-circuited (rejected immediately).
    /// After `open_duration` elapses, transitions to HalfOpen.
    Open,
    /// Trial period after cooldown. A limited number of probe requests
    /// are allowed through. If enough succeed → Closed. If any fail → Open.
    HalfOpen,
}

/// Configuration for a single circuit breaker.
#[derive(Clone, Debug)]
pub struct CircuitBreakerConfig {
    /// Consecutive failures required to trip Closed → Open.
    pub failure_threshold: u32,
    /// How long the circuit stays Open before transitioning to HalfOpen.
    pub open_duration: Duration,
    /// Maximum number of trial (probe) requests allowed in HalfOpen state.
    /// Defaults to 3. Once this many probes have been sent, no more are
    /// admitted until the probes resolve (success → Closed, failure → Open).
    pub half_open_max_probes: u32,
    /// Number of consecutive probe successes required to close the circuit.
    /// Defaults to 1 (any single success closes). Set higher for stricter
    /// recovery validation.
    pub half_open_success_threshold: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            open_duration: Duration::from_secs(30),
            half_open_max_probes: 3,
            half_open_success_threshold: 1,
        }
    }
}

/// Per-peer circuit breaker state.
#[derive(Clone, Debug)]
struct PeerCircuit {
    state: CircuitState,
    consecutive_failures: u32,
    consecutive_successes: u32,
    /// When the circuit entered the Open state (for cooldown timing).
    opened_at: Instant,
    /// Number of probes currently admitted in HalfOpen (in-flight trials).
    half_open_probes_in_flight: u32,
    /// Total probes admitted since entering HalfOpen (reset on each Open).
    half_open_probes_admitted: u32,
}

impl PeerCircuit {
    fn new() -> Self {
        Self {
            state: CircuitState::Closed,
            consecutive_failures: 0,
            consecutive_successes: 0,
            opened_at: Instant::now(),
            half_open_probes_in_flight: 0,
            half_open_probes_admitted: 0,
        }
    }
}

/// Thread-safe registry of per-peer circuit breakers.
pub struct CircuitBreakerRegistry {
    circuits: Mutex<HashMap<AgentId, PeerCircuit>>,
    config: CircuitBreakerConfig,
}

impl CircuitBreakerRegistry {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            circuits: Mutex::new(HashMap::new()),
            config,
        }
    }

    /// Check whether a request to `agent_id` is allowed. Returns the
    /// current state. If Open and cooldown has elapsed, atomically
    /// transitions to HalfOpen and returns HalfOpen.
    ///
    /// In HalfOpen, this admits a probe request only if
    /// `half_open_probes_in_flight < half_open_max_probes` and
    /// `half_open_probes_admitted < half_open_max_probes`. Each admitted
    /// probe increments both counters. Call `record_outcome()` to
    /// decrement `in_flight` and possibly transition state.
    pub fn check_and_admit(&self, agent_id: &AgentId) -> CircuitState {
        let mut circuits = self.circuits.lock().unwrap();
        let circuit = circuits.entry(*agent_id).or_insert_with(PeerCircuit::new);

        match circuit.state {
            CircuitState::Closed => CircuitState::Closed,
            CircuitState::Open => {
                if circuit.opened_at.elapsed() >= self.config.open_duration {
                    circuit.state = CircuitState::HalfOpen;
                    circuit.half_open_probes_in_flight = 0;
                    circuit.half_open_probes_admitted = 0;
                    circuit.consecutive_successes = 0;
                    // Fall through to HalfOpen admission logic.
                } else {
                    return CircuitState::Open;
                }
                // Re-check after transition (fallthrough from above).
                CircuitState::HalfOpen
            }
            CircuitState::HalfOpen => {
                if circuit.half_open_probes_in_flight < self.config.half_open_max_probes
                    && circuit.half_open_probes_admitted < self.config.half_open_max_probes
                {
                    circuit.half_open_probes_in_flight += 1;
                    circuit.half_open_probes_admitted += 1;
                    CircuitState::HalfOpen
                } else {
                    // At probe capacity — reject (treat as Open for routing).
                    CircuitState::Open
                }
            }
        }
    }

    /// Record the outcome of a call. Drives all state transitions.
    pub fn record_outcome(&self, agent_id: &AgentId, success: bool) {
        let mut circuits = self.circuits.lock().unwrap();
        let circuit = circuits.entry(*agent_id).or_insert_with(PeerCircuit::new);

        // Decrement in-flight probe if we were in HalfOpen.
        if circuit.state == CircuitState::HalfOpen && circuit.half_open_probes_in_flight > 0 {
            circuit.half_open_probes_in_flight -= 1;
        }

        if success {
            circuit.consecutive_failures = 0;
            circuit.consecutive_successes += 1;
            match circuit.state {
                CircuitState::HalfOpen => {
                    if circuit.consecutive_successes >= self.config.half_open_success_threshold {
                        circuit.state = CircuitState::Closed;
                        circuit.consecutive_successes = 0;
                    }
                }
                _ => {}
            }
        } else {
            circuit.consecutive_successes = 0;
            circuit.consecutive_failures += 1;
            match circuit.state {
                CircuitState::HalfOpen => {
                    // Probe failed — re-open and restart cooldown.
                    circuit.state = CircuitState::Open;
                    circuit.opened_at = Instant::now();
                    circuit.half_open_probes_in_flight = 0;
                    circuit.half_open_probes_admitted = 0;
                }
                CircuitState::Closed => {
                    if circuit.consecutive_failures >= self.config.failure_threshold {
                        circuit.state = CircuitState::Open;
                        circuit.opened_at = Instant::now();
                    }
                }
                CircuitState::Open => {} // already open
            }
        }
    }

    /// Read-only state check (does not admit or transition).
    pub fn state(&self, agent_id: &AgentId) -> CircuitState {
        let circuits = self.circuits.lock().unwrap();
        circuits.get(agent_id).map(|c| c.state).unwrap_or(CircuitState::Closed)
    }

    /// Manually force a peer's circuit open (e.g., on transport-level
    /// connection refusal). Resets failure counters.
    pub fn force_open(&self, agent_id: &AgentId) {
        let mut circuits = self.circuits.lock().unwrap();
        let circuit = circuits.entry(*agent_id).or_insert_with(PeerCircuit::new);
        circuit.state = CircuitState::Open;
        circuit.opened_at = Instant::now();
        circuit.consecutive_failures = self.config.failure_threshold;
        circuit.half_open_probes_in_flight = 0;
        circuit.half_open_probes_admitted = 0;
    }

    /// Reset a peer's circuit to Closed (e.g., after manual intervention).
    pub fn reset(&self, agent_id: &AgentId) {
        let mut circuits = self.circuits.lock().unwrap();
        if let Some(c) = circuits.get_mut(agent_id) {
            *c = PeerCircuit::new();
        }
    }

    pub fn config(&self) -> &CircuitBreakerConfig { &self.config }
}
```

**State transition diagram:**

```
        consecutive_failures >= failure_threshold (5)
   Closed ─────────────────────────────────────────────► Open
     ▲                                                    │
     │ half_open_success_threshold consecutive             │ open_duration (30s) elapsed
     │ probe successes                                     ▼
     └───────────────────────────────────────────────── HalfOpen
                          probe fails ──► Open (restart cooldown)
```

### Part 2: Concurrency Limits / Bulkhead (ADAPTIVE_ROUTING_PLANE.md §5.4)

Add a bulkhead pattern that caps the number of concurrent in-flight
requests per peer. This prevents a single slow peer from exhausting the
client's connection pool or tokio task budget.

```rust
use std::sync::atomic::{AtomicU32, Ordering};

/// Per-peer concurrency limit (bulkhead). Calls beyond `max_inflight`
/// are rejected with `SdkError::ConcurrencyLimit` so the router can
/// skip to the next candidate.
pub struct ConcurrencyLimit {
    max_inflight: u32,
    current: AtomicU32,
}

impl ConcurrencyLimit {
    pub fn new(max_inflight: u32) -> Self {
        Self { max_inflight, current: AtomicU32::new(0) }
    }

    /// Try to acquire a slot. Returns true if admitted, false if at capacity.
    pub fn try_acquire(&self) -> bool {
        loop {
            let current = self.current.load(Ordering::Relaxed);
            if current >= self.max_inflight {
                return false;
            }
            if self.current.compare_exchange(
                current, current + 1, Ordering::AcqRel, Ordering::Relaxed
            ).is_ok() {
                return true;
            }
        }
    }

    /// Release a slot. Called on response or error.
    pub fn release(&self) {
        self.current.fetch_sub(1, Ordering::AcqRel);
    }

    pub fn current_inflight(&self) -> u32 {
        self.current.load(Ordering::Relaxed)
    }

    pub fn max_inflight(&self) -> u32 { self.max_inflight }
}

/// Registry of per-peer concurrency limits.
pub struct BulkheadRegistry {
    limits: Mutex<HashMap<AgentId, ConcurrencyLimit>>,
    default_max: u32,
}

impl BulkheadRegistry {
    pub fn new(default_max: u32) -> Self {
        Self { limits: Mutex::new(HashMap::new()), default_max }
    }

    pub fn try_acquire(&self, agent_id: &AgentId) -> bool {
        let mut limits = self.limits.lock().unwrap();
        limits
            .entry(*agent_id)
            .or_insert_with(|| ConcurrencyLimit::new(self.default_max))
            .try_acquire()
    }

    pub fn release(&self, agent_id: &AgentId) {
        let limits = self.limits.lock().unwrap();
        if let Some(l) = limits.get(agent_id) {
            l.release();
        }
    }
}
```

Add a new `SdkError` variant: `ConcurrencyLimit(AgentId)` — returned when
the bulkhead rejects a call. The router catches this and moves to the next
candidate (it is *not* a circuit-breaker failure — it should not increment
`consecutive_failures`).

### Part 3: CircuitBreaker Integration with ConnectionPool

Modify `call_agent_with_pool()` in `simple.rs` (or create a new
`call_agent_with_resilience()` wrapper) to check the circuit breaker
*before* dialing and record the outcome *after* the call completes. The
integration points:

1. **Before dial:** Call `circuit_registry.check_and_admit(&peer_id)`.
   - If `Open`, return `SdkError::CircuitOpen(peer_id)` immediately —
     no dial, no stream open. The router skips this candidate.
   - If `HalfOpen`, the call proceeds (it's a probe). The admit call
     already incremented the in-flight probe counter.
   - If `Closed`, proceed normally.

2. **Bulkhead:** Call `bulkhead.try_acquire(&peer_id)`. If false, return
   `SdkError::ConcurrencyLimit(peer_id)`. The router tries the next
   candidate. Release the slot in a deferred guard (RAII) so it's always
   freed on early return.

3. **After call:** Record `circuit_registry.record_outcome(&peer_id, success)`
   where `success = rpc_resp.is_success()`. Release the bulkhead slot.

```rust
use crate::routing::circuit::{CircuitBreakerRegistry, CircuitState};
use crate::routing::circuit::BulkheadRegistry;

/// RAII guard that releases a bulkhead slot on drop.
struct BulkheadGuard<'a> {
    registry: &'a BulkheadRegistry,
    peer_id: AgentId,
}
impl Drop for BulkheadGuard<'_> {
    fn drop(&mut self) {
        self.registry.release(&self.peer_id);
    }
}

/// Resilience-aware call: circuit breaker + bulkhead + pool.
pub async fn call_agent_with_resilience(
    agent: &SdkAgent,
    pool: &ConnectionPool,
    addr: &str,
    request: Request,
    circuit: &CircuitBreakerRegistry,
    bulkhead: &BulkheadRegistry,
) -> Result<Response, SdkError> {
    // 1. Dial via pool to get peer_id (we need the ID for circuit lookup).
    //    If the pool already has a connection, peer_id is known cheaply.
    let (peer_id, conn) = pool.get_or_connect(agent, addr).await?;

    // 2. Circuit breaker check.
    let state = circuit.check_and_admit(&peer_id);
    if state == CircuitState::Open {
        pool.release(&peer_id).await;
        return Err(SdkError::CircuitOpen(peer_id));
    }

    // 3. Bulkhead admission.
    if !bulkhead.try_acquire(&peer_id) {
        pool.release(&peer_id).await;
        return Err(SdkError::ConcurrencyLimit(peer_id));
    }
    let _guard = BulkheadGuard { registry: bulkhead, peer_id };

    // 4. Perform the RPC (reuse existing send/recv logic from call_agent_with_pool).
    let start = Instant::now();
    let result = perform_rpc(&conn, &request).await;
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

    // 5. Record outcome for circuit breaker + metrics.
    let success = result.is_ok();
    circuit.record_outcome(&peer_id, success);
    // Also feed PeerMetricsRegistry (Phase T1) for latency EWMA:
    // metrics_registry.record_outcome(&peer_id, elapsed_ms, success);

    pool.release(&peer_id).await;
    result
}
```

**Important:** `CircuitOpen` and `ConcurrencyLimit` errors must *not* be
treated as failures by the retry layer (Part 5) — they are routing signals,
not transient errors. The router should skip to the next candidate, not
retry the same peer.

### Part 4: Request Hedging (ADAPTIVE_ROUTING_PLANE.md §6.2)

Create `crates/aafp-sdk/src/routing/hedging.rs`. Hedging sends the same
request to two agents and uses the first response; the loser is cancelled.

```rust
use crate::{Request, Response, SdkError, SdkAgent, ConnectionPool};
use aafp_identity::AgentId;
use std::time::Duration;
use tokio::select;
use tokio::time::timeout;

/// Configuration for request hedging.
#[derive(Clone, Debug)]
pub struct HedgeConfig {
    /// Whether hedging is enabled at all.
    pub enabled: bool,
    /// Delay before sending the secondary (backup) request. If the
    /// primary responds within this delay, the secondary never fires.
    pub delay: Duration,
    /// If true, only hedge when the primary is predicted to miss the
    /// deadline (adaptive policy — see Part 4b).
    pub adaptive: bool,
}

impl Default for HedgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            delay: Duration::from_millis(50),
            adaptive: true,
        }
    }
}

/// Send a request to two agents and return the first response.
/// The slower call is cancelled (its QUIC stream is reset when the
/// future is dropped).
///
/// `primary` is tried first. After `hedge_delay`, `secondary` is also
/// started. Whichever responds first wins. If the primary responds
/// before the delay, the secondary never fires (zero overhead).
pub async fn call_with_hedging(
    agent: &SdkAgent,
    pool: &ConnectionPool,
    primary_addr: &str,
    secondary_addr: &str,
    request: Request,
    hedge_delay: Duration,
) -> Result<Response, SdkError> {
    let primary_fut = call_agent_with_pool(agent, pool, primary_addr, request.clone());
    tokio::pin!(primary_fut);

    // Phase 1: wait up to hedge_delay for the primary.
    match timeout(hedge_delay, &mut primary_fut).await {
        Ok(result) => return result, // primary won before hedge fired
        Err(_) => {}                 // primary is slow — launch hedge
    }

    // Phase 2: race primary (still running) vs secondary.
    let secondary_fut = call_agent_with_pool(agent, pool, secondary_addr, request);
    tokio::pin!(secondary_fut);

    // select! drops the losing future, which cancels the QUIC stream
    // (the stream is reset when the BiStream is dropped).
    select! {
        result = &mut primary_fut => result,
        result = &mut secondary_fut => result,
    }
}
```

**Cancellation semantics:** When `select!` resolves, the losing future is
dropped. Dropping a pending `call_agent_with_pool` future drops the
`QuicSendStream` / `QuicRecvStream`, which sends a QUIC `RESET_STREAM`
frame to the peer. The peer's server-side handler should observe the
cancelled stream and abort its work. This is the natural QUIC-level
cancellation — no application-level cancel frame is needed.

**Requirement:** `Request` must implement `Clone`. It already derives
`Clone` (see `simple.rs` line 307). Verify this is still the case.

### Part 4b: Adaptive Hedging Policy (ADAPTIVE_ROUTING_PLANE.md §6.3)

Hedging doubles load, so it should only fire when the primary is likely
to be slow. The adaptive policy uses the primary's EWMA latency and its
variance to decide.

```rust
use crate::routing::metrics::PeerMetrics;

/// Decide whether to hedge based on the primary's latency profile.
///
/// Hedges only when:
/// 1. We have latency data (EWMA is initialized).
/// 2. The estimated p99 (EWMA * 2.5) exceeds the caller's deadline.
/// 3. Latency variance is high (the peer is *sometimes* slow, not
///    consistently slow — consistently slow peers should be deprioritized
///    by the scorer, not hedged).
pub fn should_hedge_adaptive(
    primary_metrics: &PeerMetrics,
    deadline_ms: f64,
) -> bool {
    if !primary_metrics.latency_ewma_ms.is_initialized() {
        return false; // no data — don't hedge blindly
    }
    let ewma = primary_metrics.latency_ewma_ms.value();
    let p99_estimate = ewma * 2.5;

    // Condition 2: predicted to miss deadline.
    let likely_slow = p99_estimate > deadline_ms;

    // Condition 3: high variance. We approximate variance using the
    // gap between min and EWMA. If min << EWMA, the peer is sometimes
    // fast and sometimes slow → hedging helps. If min ≈ EWMA, the peer
    // is consistently slow → hedging won't help (both will be slow).
    let variance_ratio = if primary_metrics.latency_min_ms < f64::MAX {
        let spread = ewma - primary_metrics.latency_min_ms;
        spread / ewma.max(1.0)
    } else {
        0.0
    };
    let high_variance = variance_ratio > 0.5;

    likely_slow && high_variance
}
```

Integrate this into `DiscoveryBuilder::call()`: when `hedge.enabled &&
hedge.adaptive`, call `should_hedge_adaptive()` with the primary's metrics
and the request's deadline (from `RequestMetadata.deadline`, parsed to ms).
Only invoke `call_with_hedging()` if it returns `true`; otherwise do a
normal single-target call.

### Part 5: Retry with Exponential Backoff + Jitter

Create `crates/aafp-sdk/src/routing/retry.rs`. Retry handles *transient*
errors (transport timeouts, stream resets) but **not** `CircuitOpen` or
`ConcurrencyLimit` (those are routing signals — skip to next candidate,
don't retry the same peer) and **not** application-level errors (the
handler ran and returned an error — retrying would be a duplicate
side-effect for non-idempotent calls).

```rust
use crate::SdkError;
use std::time::Duration;
use rand::Rng;

/// Retry policy configuration.
#[derive(Clone, Debug)]
pub struct RetryConfig {
    /// Maximum number of retry attempts (not counting the initial call).
    pub max_attempts: u32,
    /// Base delay for the first retry.
    pub base_delay: Duration,
    /// Maximum delay cap (prevents absurd waits at high attempt counts).
    pub max_delay: Duration,
    /// Multiplier for exponential backoff (e.g., 2.0 doubles each time).
    pub multiplier: f64,
    /// Jitter factor in [0.0, 1.0]. Full jitter (1.0) randomizes the
    /// delay uniformly in [0, computed_delay]. "Equal jitter" (0.5)
    /// uses [computed_delay/2, computed_delay].
    pub jitter: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(50),
            max_delay: Duration::from_secs(5),
            multiplier: 2.0,
            jitter: 1.0, // full jitter
        }
    }
}

/// Compute the delay before the next retry attempt (0-indexed).
pub fn retry_delay(config: &RetryConfig, attempt: u32, rng: &mut impl Rng) -> Duration {
    // Exponential growth: base * multiplier^attempt
    let exp = config.base_delay.as_secs_f64() * config.multiplier.powi(attempt as i32);
    let capped = exp.min(config.max_delay.as_secs_f64());
    // Jitter: full jitter → uniform [0, capped].
    let jittered = if config.jitter >= 1.0 {
        rng.gen_range(0.0..=capped)
    } else {
        let low = capped * (1.0 - config.jitter);
        rng.gen_range(low..=capped)
    };
    Duration::from_secs_f64(jittered)
}

/// Determine whether an error is retryable. CircuitOpen and
/// ConcurrencyLimit are NOT retryable (they're routing signals).
/// Application errors (handler returned an error response) are NOT
/// retryable (the call succeeded at the transport level).
pub fn is_retryable(err: &SdkError) -> bool {
    match err {
        SdkError::CircuitOpen(_) => false,
        SdkError::ConcurrencyLimit(_) => false,
        SdkError::Messaging(_) => false,  // app-level error response
        SdkError::Discovery(_) => false,
        // Transport-level errors ARE retryable:
        SdkError::Transport(_) => true,
        SdkError::Connection(_) => true,
        SdkError::Timeout => true,
        _ => false,
    }
}

/// Execute a fallible async operation with retry + backoff.
///
/// `operation` is called up to `max_attempts + 1` times. Between retries,
/// sleeps for the computed backoff duration. Only retries if
/// `is_retryable()` returns true for the error.
pub async fn with_retry<F, Fut, T>(
    config: &RetryConfig,
    mut operation: F,
) -> Result<T, SdkError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, SdkError>>,
{
    let mut rng = rand::thread_rng();
    let mut last_err = None;

    for attempt in 0..=config.max_attempts {
        match operation().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                if !is_retryable(&e) {
                    return Err(e);
                }
                last_err = Some(e);
                if attempt < config.max_attempts {
                    let delay = retry_delay(config, attempt, &mut rng);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| SdkError::Transport("retry exhausted".into())))
}
```

### Part 6: Wire It All Into DiscoveryBuilder

Modify `DiscoveryBuilder` in `simple.rs` to thread the resilience layers
through `call()`. The call pipeline becomes:

```
1. Discover candidates (find_by_capability)
2. Score + select primary (Phase T2)
3. Check circuit breaker for primary → if Open, skip to next candidate
4. Check bulkhead for primary → if full, skip to next candidate
5. If hedging enabled + adaptive policy says hedge:
     a. Select a secondary candidate (next-best score)
     b. call_with_hedging(primary, secondary, hedge_delay)
   Else:
     call_agent_with_resilience(primary)
6. On retryable error: retry with backoff (same peer)
7. On CircuitOpen/ConcurrencyLimit: skip to next candidate (no retry)
8. On all candidates exhausted: return last error
```

Add fields to `DiscoveryBuilder`:
```rust
pub struct DiscoveryBuilder {
    agent: Arc<SdkAgent>,
    pool: Arc<ConnectionPool>,
    capability: String,
    // Resilience config (Phase T3-T4):
    circuit: Option<Arc<CircuitBreakerRegistry>>,
    bulkhead: Option<Arc<BulkheadRegistry>>,
    hedge: HedgeConfig,
    retry: RetryConfig,
    // Per-call overrides:
    hedge_override: Option<bool>,
}
```

Add builder methods: `.hedge(bool)`, `.with_retry(RetryConfig)`,
`.with_circuit(CircuitBreakerConfig)`, `.with_bulkhead(u32)`.

### Part 7: Module Structure

```
crates/aafp-sdk/src/routing/
├── mod.rs           // re-exports
├── metrics.rs       // (Phase T1) PeerMetrics, PeerMetricsRegistry, Ewma
├── circuit.rs       // NEW: CircuitBreakerRegistry, CircuitState, BulkheadRegistry
├── hedging.rs       // NEW: call_with_hedging(), should_hedge_adaptive(), HedgeConfig
├── retry.rs         // NEW: with_retry(), retry_delay(), is_retryable(), RetryConfig
├── scoring.rs       // (Phase T2)
└── selection.rs     // (Phase T2)
```

Gate the `routing` module behind a feature flag `adaptive-routing`
(enabled by default) in `crates/aafp-sdk/Cargo.toml`:
```toml
[features]
default = ["adaptive-routing"]
adaptive-routing = ["dep:rand"]
```

Add `rand` to dependencies (it's likely already present for selection
strategies; verify).

## Constraints

1. **No wire protocol changes.** All resilience logic is client-side.
   Cancellation uses QUIC stream reset (dropping the future), not a new
   frame type.

2. **Backward compatibility.** `DiscoveryBuilder::call()` must still work
   without any resilience config — default to no circuit breaker (all
   peers treated as Closed), no bulkhead, no hedging, no retry. This
   preserves the existing failover behavior as the baseline.

3. **CircuitOpen and ConcurrencyLimit are not failures.** They must not
   increment `consecutive_failures` in the circuit breaker or the rolling
   success window in `PeerMetrics`. They are routing decisions, not
   observed call outcomes.

4. **Hedging requires `Request: Clone`.** Verify this. If `Request`
   contains non-cloneable fields, wrap them in `Arc` or add a
   `clone_for_hedge()` method.

5. **Follow existing conventions.** Check `AGENTS.md` for build/test
   commands. Use `cargo fmt`, `cargo clippy`, `cargo test --workspace`.
   Target: 1700+ tests (currently 1597).

6. **Thread safety.** `CircuitBreakerRegistry` and `BulkheadRegistry`
   must be `Send + Sync`. Use `std::sync::Mutex` (not `tokio::sync::Mutex`)
   for the registries — the critical sections are tiny (HashMap lookup +
   counter update) and never hold across `.await` points. The bulkhead
   uses `AtomicU32` for the counter itself.

## Unit Tests

Add tests in each new module. Minimum coverage:

### Circuit Breaker Tests (`circuit.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circuit_starts_closed() {
        let reg = CircuitBreakerRegistry::new(CircuitBreakerConfig::default());
        let id = AgentId::from_bytes([1; 32]);
        assert_eq!(reg.state(&id), CircuitState::Closed);
    }

    #[test]
    fn circuit_opens_after_threshold_failures() {
        let reg = CircuitBreakerRegistry::new(CircuitBreakerConfig::default());
        let id = AgentId::from_bytes([1; 32]);
        // failure_threshold = 5
        for _ in 0..5 {
            reg.record_outcome(&id, false);
        }
        assert_eq!(reg.state(&id), CircuitState::Open);
    }

    #[test]
    fn circuit_stays_closed_below_threshold() {
        let reg = CircuitBreakerRegistry::new(CircuitBreakerConfig::default());
        let id = AgentId::from_bytes([1; 32]);
        for _ in 0..4 {
            reg.record_outcome(&id, false);
        }
        assert_eq!(reg.state(&id), CircuitState::Closed);
    }

    #[test]
    fn success_resets_failure_count() {
        let reg = CircuitBreakerRegistry::new(CircuitBreakerConfig::default());
        let id = AgentId::from_bytes([1; 32]);
        for _ in 0..4 { reg.record_outcome(&id, false); }
        reg.record_outcome(&id, true); // resets
        for _ in 0..4 { reg.record_outcome(&id, false); }
        assert_eq!(reg.state(&id), CircuitState::Closed); // only 4, not 5
    }

    #[test]
    fn open_circuit_rejects_admission() {
        let reg = CircuitBreakerRegistry::new(CircuitBreakerConfig::default());
        let id = AgentId::from_bytes([1; 32]);
        for _ in 0..5 { reg.record_outcome(&id, false); }
        assert_eq!(reg.check_and_admit(&id), CircuitState::Open);
    }

    #[test]
    fn half_open_admits_probes_up_to_max() {
        let cfg = CircuitBreakerConfig { open_duration: Duration::from_millis(0), ..Default::default() };
        let reg = CircuitBreakerRegistry::new(cfg);
        let id = AgentId::from_bytes([1; 32]);
        for _ in 0..5 { reg.record_outcome(&id, false); }
        std::thread::sleep(Duration::from_millis(1)); // cooldown elapsed
        // half_open_max_probes = 3
        assert_eq!(reg.check_and_admit(&id), CircuitState::HalfOpen);
        assert_eq!(reg.check_and_admit(&id), CircuitState::HalfOpen);
        assert_eq!(reg.check_and_admit(&id), CircuitState::HalfOpen);
        // 4th probe rejected (at capacity)
        assert_eq!(reg.check_and_admit(&id), CircuitState::Open);
    }

    #[test]
    fn half_open_success_closes_circuit() {
        let cfg = CircuitBreakerConfig { open_duration: Duration::from_millis(0), ..Default::default() };
        let reg = CircuitBreakerRegistry::new(cfg);
        let id = AgentId::from_bytes([1; 32]);
        for _ in 0..5 { reg.record_outcome(&id, false); }
        std::thread::sleep(Duration::from_millis(1));
        reg.check_and_admit(&id); // admit probe
        reg.record_outcome(&id, true); // probe succeeds
        assert_eq!(reg.state(&id), CircuitState::Closed);
    }

    #[test]
    fn half_open_failure_reopens_circuit() {
        let cfg = CircuitBreakerConfig { open_duration: Duration::from_millis(0), ..Default::default() };
        let reg = CircuitBreakerRegistry::new(cfg);
        let id = AgentId::from_bytes([1; 32]);
        for _ in 0..5 { reg.record_outcome(&id, false); }
        std::thread::sleep(Duration::from_millis(1));
        reg.check_and_admit(&id);
        reg.record_outcome(&id, false); // probe fails
        assert_eq!(reg.state(&id), CircuitState::Open);
    }

    #[test]
    fn force_open_immediately_trips() {
        let reg = CircuitBreakerRegistry::new(CircuitBreakerConfig::default());
        let id = AgentId::from_bytes([1; 32]);
        reg.force_open(&id);
        assert_eq!(reg.state(&id), CircuitState::Open);
    }

    #[test]
    fn reset_returns_to_closed() {
        let reg = CircuitBreakerRegistry::new(CircuitBreakerConfig::default());
        let id = AgentId::from_bytes([1; 32]);
        for _ in 0..5 { reg.record_outcome(&id, false); }
        reg.reset(&id);
        assert_eq!(reg.state(&id), CircuitState::Closed);
    }

    // ── Bulkhead tests ──────────────────────────────────

    #[test]
    fn bulkhead_admits_up_to_max() {
        let limit = ConcurrencyLimit::new(3);
        assert!(limit.try_acquire());
        assert!(limit.try_acquire());
        assert!(limit.try_acquire());
        assert!(!limit.try_acquire()); // at capacity
    }

    #[test]
    fn bulkhead_release_frees_slot() {
        let limit = ConcurrencyLimit::new(2);
        limit.try_acquire();
        limit.try_acquire();
        assert!(!limit.try_acquire());
        limit.release();
        assert!(limit.try_acquire());
    }

    #[test]
    fn bulkhead_registry_per_peer_isolation() {
        let reg = BulkheadRegistry::new(2);
        let a = AgentId::from_bytes([1; 32]);
        let b = AgentId::from_bytes([2; 32]);
        assert!(reg.try_acquire(&a));
        assert!(reg.try_acquire(&a));
        assert!(!reg.try_acquire(&a)); // a is full
        assert!(reg.try_acquire(&b));  // b is independent
    }
}
```

### Hedging Tests (`hedging.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::metrics::{PeerMetrics, Ewma, RollingWindow};
    use std::time::Instant;

    #[test]
    fn should_not_hedge_without_latency_data() {
        let mut metrics = PeerMetrics::new(AgentId::from_bytes([1; 32]));
        // EWMA not initialized
        assert!(!should_hedge_adaptive(&metrics, 100.0));
    }

    #[test]
    fn should_hedge_when_slow_and_high_variance() {
        let mut metrics = PeerMetrics::new(AgentId::from_bytes([1; 32]));
        metrics.latency_ewma_ms = Ewma::new(0.1);
        metrics.latency_ewma_ms.update(80.0); // EWMA = 80ms
        metrics.latency_min_ms = 10.0;        // min = 10ms → high variance
        // p99_estimate = 80 * 2.5 = 200ms > deadline 100ms
        // variance_ratio = (80 - 10) / 80 = 0.875 > 0.5
        assert!(should_hedge_adaptive(&metrics, 100.0));
    }

    #[test]
    fn should_not_hedge_when_fast_enough() {
        let mut metrics = PeerMetrics::new(AgentId::from_bytes([1; 32]));
        metrics.latency_ewma_ms = Ewma::new(0.1);
        metrics.latency_ewma_ms.update(20.0);
        metrics.latency_min_ms = 10.0;
        // p99_estimate = 50ms < deadline 100ms
        assert!(!should_hedge_adaptive(&metrics, 100.0));
    }

    #[test]
    fn should_not_hedge_when_consistently_slow() {
        let mut metrics = PeerMetrics::new(AgentId::from_bytes([1; 32]));
        metrics.latency_ewma_ms = Ewma::new(0.1);
        metrics.latency_ewma_ms.update(80.0);
        metrics.latency_min_ms = 75.0; // min ≈ EWMA → low variance
        // variance_ratio = (80 - 75) / 80 = 0.0625 < 0.5
        assert!(!should_hedge_adaptive(&metrics, 100.0));
    }

    // Integration test: hedging picks the faster agent.
    #[tokio::test]
    async fn hedging_uses_faster_response() {
        // Set up two server agents: one fast (10ms), one slow (200ms).
        // Call with hedging. Verify the response comes from the fast one
        // and the slow call is cancelled.
        // (Full integration test using AgentBuilder — see existing
        // pool tests in connection_pool.rs for the pattern.)
    }
}
```

### Retry Tests (`retry.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn retry_delay_grows_exponentially() {
        let config = RetryConfig {
            max_attempts: 5,
            base_delay: Duration::from_millis(10),
            max_delay: Duration::from_secs(10),
            multiplier: 2.0,
            jitter: 0.0, // no jitter for deterministic test
        };
        let mut rng = rand::thread_rng();
        let d0 = retry_delay(&config, 0, &mut rng);
        let d1 = retry_delay(&config, 1, &mut rng);
        let d2 = retry_delay(&config, 2, &mut rng);
        assert_eq!(d0, Duration::from_millis(10));
        assert_eq!(d1, Duration::from_millis(20));
        assert_eq!(d2, Duration::from_millis(40));
    }

    #[test]
    fn retry_delay_caps_at_max() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_millis(500),
            multiplier: 2.0,
            jitter: 0.0,
        };
        let mut rng = rand::thread_rng();
        // attempt 10: 100 * 2^10 = 102400ms, capped to 500ms
        let d = retry_delay(&config, 10, &mut rng);
        assert_eq!(d, Duration::from_millis(500));
    }

    #[tokio::test]
    async fn with_retry_succeeds_on_third_attempt() {
        let counter = Arc::new(AtomicU32::new(0));
        let counter_clone = counter.clone();
        let config = RetryConfig {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(10),
            multiplier: 2.0,
            jitter: 0.0,
        };
        let result: Result<u32, SdkError> = with_retry(&config, || {
            let c = counter_clone.clone();
            async move {
                let n = c.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    Err(SdkError::Timeout)
                } else {
                    Ok(42)
                }
            }
        }).await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn with_retry_does_not_retry_non_retryable() {
        let counter = Arc::new(AtomicU32::new(0));
        let counter_clone = counter.clone();
        let config = RetryConfig::default();
        let result: Result<u32, SdkError> = with_retry(&config, || {
            let c = counter_clone.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(SdkError::CircuitOpen(AgentId::from_bytes([1; 32])))
            }
        }).await;
        assert!(result.is_err());
        assert_eq!(counter.load(Ordering::SeqCst), 1); // no retry
    }

    #[tokio::test]
    async fn with_retry_exhausts_attempts() {
        let counter = Arc::new(AtomicU32::new(0));
        let counter_clone = counter.clone();
        let config = RetryConfig {
            max_attempts: 2,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(5),
            multiplier: 2.0,
            jitter: 0.0,
        };
        let result: Result<u32, SdkError> = with_retry(&config, || {
            let c = counter_clone.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(SdkError::Timeout)
            }
        }).await;
        assert!(matches!(result, Err(SdkError::Timeout)));
        assert_eq!(counter.load(Ordering::SeqCst), 3); // 1 initial + 2 retries
    }
}
```

## Verification

```bash
cargo fmt --all -- --check   # 0 diffs
cargo build --workspace       # 0 errors, 0 warnings
cargo clippy --workspace      # 0 warnings
cargo test --workspace        # 1700+ tests, 0 failures
```

Specifically run the new module tests:
```bash
cargo test -p aafp-sdk routing::circuit -- --nocapture
cargo test -p aafp-sdk routing::hedging -- --nocapture
cargo test -p aafp-sdk routing::retry -- --nocapture
```

All existing examples must still work:
```bash
cargo run --example echo-agent
cargo run --example translation-pipeline
cargo run --example multi-agent-chat
```

## Files to Create / Modify

| File | Action | Changes |
|------|--------|---------|
| `crates/aafp-sdk/src/routing/circuit.rs` | **New** | `CircuitState`, `CircuitBreakerConfig`, `CircuitBreakerRegistry`, `ConcurrencyLimit`, `BulkheadRegistry` |
| `crates/aafp-sdk/src/routing/hedging.rs` | **New** | `HedgeConfig`, `call_with_hedging()`, `should_hedge_adaptive()` |
| `crates/aafp-sdk/src/routing/retry.rs` | **New** | `RetryConfig`, `retry_delay()`, `is_retryable()`, `with_retry()` |
| `crates/aafp-sdk/src/routing/mod.rs` | **Modify** | Re-export new types |
| `crates/aafp-sdk/src/simple.rs` | **Modify** | `call_agent_with_resilience()`, `DiscoveryBuilder` fields + builder methods, pipeline integration |
| `crates/aafp-sdk/src/lib.rs` | **Modify** | Re-export `CircuitBreakerRegistry`, `HedgeConfig`, `RetryConfig` |
| `crates/aafp-sdk/Cargo.toml` | **Modify** | `adaptive-routing` feature flag, `rand` dep |
| `crates/aafp-sdk/tests/` | **New** | Integration tests for circuit recovery, hedging cancellation |

## Success Criteria

- [ ] `CircuitState` enum (Closed, Open, HalfOpen) with full transition logic
- [ ] `CircuitBreakerConfig` with failure_threshold=5, open_duration=30s, half_open_max_probes=3
- [ ] `CircuitBreakerRegistry` with `check_and_admit()`, `record_outcome()`, `force_open()`, `reset()`
- [ ] HalfOpen admits up to `half_open_max_probes` concurrent trial requests
- [ ] `ConcurrencyLimit` (bulkhead) with `try_acquire()` / `release()` using atomics
- [ ] `BulkheadRegistry` for per-peer isolation
- [ ] `call_agent_with_resilience()` integrating circuit + bulkhead + pool
- [ ] `CircuitOpen` and `ConcurrencyLimit` `SdkError` variants (not treated as failures)
- [ ] `call_with_hedging()` racing two calls, cancelling the loser via future drop
- [ ] `should_hedge_adaptive()` using EWMA + latency variance ratio
- [ ] `RetryConfig` with exponential backoff (base * multiplier^attempt) + full jitter
- [ ] `is_retryable()` excluding CircuitOpen, ConcurrencyLimit, and app-level errors
- [ ] `with_retry()` async helper with backoff sleep between attempts
- [ ] `DiscoveryBuilder` gains `.hedge()`, `.with_retry()`, `.with_circuit()`, `.with_bulkhead()`
- [ ] Call pipeline: discover → score → circuit check → bulkhead → hedge-or-call → retry
- [ ] Unit tests: 15+ for circuit breaker, 5+ for bulkhead, 5+ for hedging, 5+ for retry
- [ ] Integration test: circuit opens after 5 failures, recovers via HalfOpen
- [ ] Integration test: hedging picks faster agent, cancels slower
- [ ] All existing tests pass (1597+)
- [ ] `cargo clippy` clean
- [ ] `cargo fmt` clean
