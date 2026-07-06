# Phase 4 Builder Script — The Remaining Intelligence Plane

**Created:** 2026-07-06
**Status:** Ready to build
**Prerequisite:** v0.4-intelligence-plane freeze tag (all foundation tracks T, U, W + PubSub implemented)
**Codebase:** /Users/david/Projects/AAFP-research/implementations/rust/

---

## Mission

Build the remaining Phase 4 tracks to complete the Intelligence Plane:

| Track | Name | Design Status | Complexity | Dependencies |
|-------|------|---------------|------------|--------------|
| V | Execution Fabric | Needs design | High | SCG ✅, AR ✅, ARE ✅ |
| X | Economic Layer | Needs design | Medium | ARE ✅, V (partial) |
| Y | World Perception Layer | Designed (941 lines) | High | SCG ✅, PubSub ✅, DHT ✅ |
| T-ext | Temporal Prediction | Partial design | Medium | AR ✅ |
| U-ext | Live DHT Integration | Partial design | Low | SCG ✅, DHT ✅ |
| W-ext | Reputation Scoring | Partial design | Medium | ARE ✅ |

**Total estimated effort:** ~20K lines of new code, ~300 new tests

---

## Current State (Starting Point)

- **1864 Rust tests passing**, 0 failures, 7 ignored
- **151 TypeScript tests passing**, 0 errors
- **2015 total tests**, 0 failures
- **17 Rust crates**, ~115K lines
- **0 clippy warnings**
- **Freeze tag:** v0.4-intelligence-plane

### Already Implemented (Foundation)

| Component | Crate | Module | What It Provides |
|-----------|-------|--------|------------------|
| SemanticCapability | aafp-discovery | semantic/ | Multi-dimensional capability descriptors |
| CapabilityQuery | aafp-discovery | semantic/ | Pattern matching, geo filtering, semantic match |
| CapabilityGraph | aafp-discovery | semantic/ | DAG of capabilities, composition edges |
| HeuristicPlanner | aafp-discovery | semantic/ | A* search for multi-step pipeline assembly |
| 11 Bridge Capabilities | aafp-discovery | semantic/ | search, web-browse, code-execute, etc. (stubs) |
| PeerMetricsRegistry | aafp-sdk | routing/ | EWMA latency/success/load tracking |
| 4 Selection Strategies | aafp-sdk | routing/ | Weighted random, P2C, least-connections, lowest-latency |
| CircuitBreaker | aafp-sdk | routing/ | 3-state: closed/open/half-open |
| BulkheadRegistry | aafp-sdk | routing/ | Concurrency limiting per peer |
| HedgeConfig | aafp-sdk | routing/ | Request hedging with EWMA delay prediction |
| RetryConfig | aafp-sdk | routing/ | Retry with exponential backoff + jitter |
| AdaptiveRouter | aafp-sdk | routing/ | Integrates all routing components |
| RoutingObserver | aafp-sdk | routing/ | Snapshot metrics, Prometheus export |
| AgentRecord Extensions | aafp-identity | extensions/ | 25+ fields: geo, perf, cost, semantic, version, reputation, attestation, heartbeat |
| PubSub API | aafp-sdk | pubsub/ | Event, SubscriptionStream, propagation |
| BackChannel | aafp-sdk | pubsub/ | Back-channel topics, MQTT wildcards, TopicMatcher |
| GossipSub | aafp-sdk | pubsub/ | GossipSub v1.1, peer scoring, seen cache |
| UCAN ACLs | aafp-sdk | pubsub/ | Default-deny, capability-based publish/subscribe |

### Key Conventions

- **v1 types are primary**: `rpc_v1`, `handshake_v1`, `identity_v1` are RFC-compliant
- **CBOR helpers**: `aafp_cbor::int_map()`, `aafp_cbor::str_map()`, `aafp_cbor::int_map_get()`
- **All maps use canonical CBOR** (RFC 8949 §4.2.3, length-first byte ordering)
- **No wire protocol changes** — everything is SDK-layer
- **Test convention**: `#[cfg(test)] mod tests` with comprehensive unit tests
- **Security**: No `unwrap()` on Mutex (use `expect()`), validate all CBOR decode, guard against NaN/infinity in floats, default-deny on all ACLs

---

## Build Order

```
Wave 1 (parallel, no inter-dependencies):
  V1-V2: ExecutionPlan + TaskScheduler     ← Track V foundation
  Y1-Y2: Search + Web-Browse capabilities  ← Track Y foundation
  T8:   Temporal Prediction Engine         ← Track T extension
  U7:   Live DHT Integration               ← Track U extension
  W7:   Reputation Scoring Engine          ← Track W extension

Wave 2 (after Wave 1, parallel):
  V3-V4: CheckpointManager + MigrationManager  ← needs V1-V2
  Y3:   Document-Read capability               ← needs Y1-Y2 (schema)
  X1-X2: ResourceAccount + PricingEngine       ← needs V1 (task model)

Wave 3 (after Wave 2, parallel):
  V5-V6: ResultAggregator + FailureRecovery    ← needs V3-V4
  Y4-Y5: API-Call + API-Discover               ← needs Y1-Y2
  X3-X4: PriorityQueue + CompensationProtocol  ← needs X1-X2

Wave 4 (after Wave 3, parallel):
  Y6-Y7: Code-Execute + Media (OCR/transcribe) ← needs Y4-Y5
  X5:    SlashingConditions                     ← needs X3-X4
  U8:    Intent-to-Plan SDK Resolution         ← needs U7, V1-V2

Wave 5 (after Wave 4):
  Y8-Y9: Stateful Browsing Sessions + UCAN     ← needs Y1-Y7
  W8:    Reputation Propagation (gossip)        ← needs W7
  T9:    Predictive Prefetching                 ← needs T8, Y1-Y2
```

---

## Track V: Execution Fabric

**Design doc:** INTELLIGENCE_PLANE.md §3.3 (needs elaboration)
**Target crate:** `aafp-sdk` (new module: `execution/`)
**Design status:** Components listed but not detailed. You must design the data structures and APIs.

### V1: ExecutionPlan

**File:** `aafp-sdk/src/execution/plan.rs`

```rust
/// A DAG of tasks to be executed by the network.
/// Produced by the CapabilityPlanner (SCG D5-D6) and enriched
/// with scheduling metadata.
#[derive(Clone, Debug)]
pub struct ExecutionPlan {
    /// Unique plan ID (SHA-256 of serialized plan)
    pub id: PlanId,
    /// Original goal that produced this plan
    pub goal: String,
    /// Tasks in topological order
    pub tasks: Vec<TaskNode>,
    /// Edges: (from_task_idx, to_task_idx, edge_type)
    pub edges: Vec<(usize, usize, DependencyType)>,
    /// Estimated total cost (in credits, Track X)
    pub estimated_cost: u64,
    /// Estimated critical-path latency (ms)
    pub estimated_latency_ms: u64,
    /// Resource requirements (total across all tasks)
    pub resource_requirements: ResourceRequirements,
    /// Creation timestamp
    pub created_at: u64,
    /// Plan version (for checkpointing)
    pub version: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PlanId(pub [u8; 32]);

#[derive(Clone, Debug)]
pub struct TaskNode {
    /// Task ID within the plan
    pub id: TaskId,
    /// Capability required (e.g., "translation", "code-execute")
    pub capability: String,
    /// Input parameters (CBOR-encoded)
    pub input: Vec<u8>,
    /// Estimated duration (ms)
    pub estimated_duration_ms: u64,
    /// Resource requirements for this task
    pub resources: ResourceRequirements,
    /// Assigned agent (None = unassigned)
    pub assigned_agent: Option<AgentId>,
    /// Task status
    pub status: TaskStatus,
    /// Number of retries
    pub retry_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Assigned,
    Running,
    Completed(Vec<u8>),  // Output bytes
    Failed(String),       // Error message
    Cancelled,
}

#[derive(Clone, Debug)]
pub enum DependencyType {
    /// to_task needs from_task's output as input
    DataDependency,
    /// to_task can only start after from_task completes (ordering)
    ControlDependency,
    /// to_task can run in parallel with from_task but shares resources
    ResourceDependency,
}

#[derive(Clone, Debug, Default)]
pub struct ResourceRequirements {
    pub cpu_cores: Option<u32>,
    pub memory_mb: Option<u32>,
    pub gpu: Option<GpuRequirement>,
    pub disk_mb: Option<u64>,
    pub network: bool,
}

#[derive(Clone, Debug)]
pub struct GpuRequirement {
    pub min_vram_mb: u32,
    pub compute_capability: Option<String>,
}
```

**Implementation requirements:**
- CBOR encoding/decoding for all structs (int-keyed maps)
- `ExecutionPlan::from_capability_graph(graph: &CapabilityGraph, goal: &str) -> Result<Self>` — convert a SCG plan to an execution plan
- `ExecutionPlan::topological_sort() -> Vec<usize>` — return task indices in execution order
- `ExecutionPlan::critical_path() -> Vec<usize>` — return the longest dependency chain
- `ExecutionPlan::parallel_groups() -> Vec<Vec<usize>>` — group tasks that can run in parallel
- Validation: no cycles, all edges reference valid task indices

**Tests (minimum 15):**
- CBOR round-trip for all types
- Topological sort correctness
- Cycle detection
- Critical path calculation
- Parallel group identification
- from_capability_graph conversion
- Empty plan handling
- Single-task plan
- Diamond dependency pattern
- Resource requirement aggregation

### V2: TaskScheduler

**File:** `aafp-sdk/src/execution/scheduler.rs`

```rust
/// Assigns tasks to agents based on capabilities, load, and reputation.
/// Uses the AdaptiveRouter (Track T) for agent selection.
pub struct TaskScheduler {
    /// Router for agent selection
    router: Arc<AdaptiveRouter>,
    /// Metrics registry for load tracking
    metrics: Arc<PeerMetricsRegistry>,
    /// Current assignments: TaskId -> AgentId
    assignments: RwLock<HashMap<TaskId, AgentId>>,
    /// Configuration
    config: SchedulerConfig,
}

pub struct SchedulerConfig {
    /// Maximum tasks per agent
    pub max_tasks_per_agent: u32,
    /// Prefer agents with higher reputation (Track W)
    pub reputation_weight: f64,
    /// Prefer agents with lower current load
    pub load_weight: f64,
    /// Prefer agents with lower cost (Track X)
    pub cost_weight: f64,
    /// Prefer agents with lower latency
    pub latency_weight: f64,
    /// Timeout for task assignment (ms)
    pub assignment_timeout_ms: u64,
}

impl TaskScheduler {
    /// Assign a single task to the best available agent
    pub async fn assign_task(&self, plan: &ExecutionPlan, task_idx: usize) -> Result<AgentId, SdkError>;
    
    /// Assign all ready tasks in a plan (tasks whose dependencies are met)
    pub async fn assign_ready_tasks(&self, plan: &ExecutionPlan) -> Result<Vec<(TaskId, AgentId)>, SdkError>;
    
    /// Reassign a failed task to a different agent
    pub async fn reassign_task(&self, plan: &mut ExecutionPlan, task_idx: usize) -> Result<AgentId, SdkError>;
    
    /// Get current load for an agent (pending tasks)
    pub fn agent_load(&self, agent_id: &AgentId) -> u32;
    
    /// Get all assignments
    pub fn assignments(&self) -> HashMap<TaskId, AgentId>;
}
```

**Implementation requirements:**
- Use `AdaptiveRouter::select_peer()` for agent selection, passing a weighted score combining reputation, load, cost, and latency
- Track assignments in a `RwLock<HashMap>`
- `assign_ready_tasks` should find all tasks where all `DataDependency` predecessors are `Completed`
- `reassign_task` should increment `retry_count`, exclude the failed agent from candidates, and use circuit breaker state
- Integrate with `BulkheadRegistry` to check concurrency limits

**Tests (minimum 15):**
- Single task assignment
- Multiple parallel task assignment
- Reassignment after failure
- Load balancing across agents
- Reputation-weighted selection
- Cost-weighted selection
- Assignment timeout
- Max tasks per agent enforcement
- Dependency-aware scheduling (won't assign task before deps complete)
- Circuit breaker integration (skip open circuits)
- Bulkhead integration (respect concurrency limits)

### V3: CheckpointManager

**File:** `aafp-sdk/src/execution/checkpoint.rs`

```rust
/// Periodic state snapshots for resume-after-failure.
/// Checkpoints are stored in-memory (future: SQLite/RocksDB).
pub struct CheckpointManager {
    /// Plan ID -> checkpoints
    checkpoints: RwLock<HashMap<PlanId, Vec<Checkpoint>>>,
    /// Configuration
    config: CheckpointConfig,
}

pub struct CheckpointConfig {
    /// Checkpoint interval (ms) — 0 = manual only
    pub interval_ms: u64,
    /// Maximum checkpoints per plan (ring buffer)
    pub max_checkpoints: usize,
    /// Checkpoint storage backend (future: enum for in-memory vs persistent)
}

#[derive(Clone, Debug)]
pub struct Checkpoint {
    /// Plan version at checkpoint time
    pub plan_version: u32,
    /// Completed task indices
    pub completed_tasks: Vec<usize>,
    /// Running task indices with partial output
    pub running_tasks: Vec<(usize, Vec<u8>)>,
    /// Timestamp
    pub timestamp: u64,
    /// Checkpoint hash (for verification)
    pub hash: [u8; 32],
}

impl CheckpointManager {
    /// Create a checkpoint of the current plan state
    pub fn checkpoint(&self, plan: &ExecutionPlan) -> Result<Checkpoint, SdkError>;
    
    /// Restore a plan from a checkpoint
    pub fn restore(&self, plan: &mut ExecutionPlan, checkpoint: &Checkpoint) -> Result<(), SdkError>;
    
    /// Get the latest checkpoint for a plan
    pub fn latest(&self, plan_id: &PlanId) -> Option<Checkpoint>;
    
    /// List all checkpoints for a plan
    pub fn list(&self, plan_id: &PlanId) -> Vec<&Checkpoint>;
    
    /// Clear checkpoints for a plan (after successful completion)
    pub fn clear(&self, plan_id: &PlanId);
    
    /// Start automatic checkpointing (background task)
    pub fn start_auto_checkpoint(&self, plan: Arc<RwLock<ExecutionPlan>>);
}
```

**Tests (minimum 10):**
- Checkpoint creation captures correct state
- Restore restores correct state
- Latest checkpoint selection
- Ring buffer eviction (max_checkpoints)
- Clear after completion
- Auto-checkpoint interval
- Checkpoint hash verification
- Restore after partial completion
- Restore with running tasks (partial output)
- Empty plan checkpoint

### V4: MigrationManager

**File:** `aafp-sdk/src/execution/migration.rs`

```rust
/// Move a running task to a different agent (load balancing, failure prevention).
pub struct MigrationManager {
    scheduler: Arc<TaskScheduler>,
    metrics: Arc<PeerMetricsRegistry>,
    config: MigrationConfig,
}

pub struct MigrationConfig {
    /// CPU threshold for migration (0.0-1.0)
    pub cpu_threshold: f64,
    /// Latency threshold for migration (ms)
    pub latency_threshold_ms: u64,
    /// Failure rate threshold for migration (0.0-1.0)
    pub failure_rate_threshold: f64,
    /// Minimum time before migration (ms) — don't migrate too quickly
    pub min_time_before_migration_ms: u64,
}

impl MigrationManager {
    /// Check if a task should be migrated
    pub fn should_migrate(&self, plan: &ExecutionPlan, task_idx: usize) -> Option<MigrationReason>;
    
    /// Migrate a task to a new agent
    pub async fn migrate(&self, plan: &mut ExecutionPlan, task_idx: usize) -> Result<AgentId, SdkError>;
    
    /// Find migration candidates (tasks that should be migrated)
    pub fn migration_candidates(&self, plan: &ExecutionPlan) -> Vec<(usize, MigrationReason)>;
}

#[derive(Clone, Debug)]
pub enum MigrationReason {
    HighCpuLoad(f64),
    HighLatency(u64),
    HighFailureRate(f64),
    AgentUnreachable,
    ManualRequest,
}
```

**Tests (minimum 10):**
- Migration triggered by high CPU
- Migration triggered by high latency
- Migration triggered by high failure rate
- Migration triggered by unreachable agent
- Min time before migration enforced
- Migration assigns to a different agent
- Migration candidates identification
- Migration with checkpoint restore
- No migration when no better agent available
- Migration reason reporting

### V5: ResultAggregator

**File:** `aafp-sdk/src/execution/aggregator.rs`

```rust
/// Merge partial results from parallel workers.
pub struct ResultAggregator;

impl ResultAggregator {
    /// Concatenate byte results in task order
    pub fn concatenate(results: &[(usize, Vec<u8>)]) -> Vec<u8>;
    
    /// Merge CBOR maps (later results override earlier)
    pub fn merge_maps(results: &[(usize, Value)]) -> Value;
    
    /// Collect results into a list
    pub fn collect(results: &[(usize, Vec<u8>)]) -> Vec<Vec<u8>>;
    
    /// Custom aggregation via callback
    pub fn custom<F>(results: &[(usize, Vec<u8>)], f: F) -> Vec<u8>
    where F: Fn(&[(usize, Vec<u8>)]) -> Vec<u8>;
    
    /// Aggregate based on dependency type
    pub fn aggregate(plan: &ExecutionPlan, results: &[(usize, Vec<u8>)]) -> Result<Vec<u8>, SdkError>;
}
```

**Tests (minimum 10):**
- Concatenation in order
- Map merge (override semantics)
- Collection into list
- Custom aggregation callback
- Aggregate with data dependencies (pass output to next task)
- Aggregate with parallel tasks (collect)
- Empty results handling
- Single result
- Partial results (some tasks failed)
- CBOR value merge

### V6: FailureRecovery

**File:** `aafp-sdk/src/execution/recovery.rs`

```rust
/// Detect failure, re-plan, resume from checkpoint.
pub struct FailureRecovery {
    scheduler: Arc<TaskScheduler>,
    checkpoint_mgr: Arc<CheckpointManager>,
    config: RecoveryConfig,
}

pub struct RecoveryConfig {
    /// Max retries per task
    pub max_retries: u32,
    /// Retry backoff base (ms)
    pub retry_backoff_ms: u64,
    /// Whether to re-plan on failure (find alternative pipeline)
    pub replan_on_failure: bool,
    /// Whether to checkpoint before retry
    pub checkpoint_before_retry: bool,
}

impl FailureRecovery {
    /// Handle a task failure
    pub async fn handle_failure(
        &self,
        plan: &mut ExecutionPlan,
        task_idx: usize,
        error: &str,
    ) -> Result<RecoveryAction, SdkError>;
    
    /// Re-plan from a failed state (find alternative pipeline)
    pub async fn replan(
        &self,
        plan: &ExecutionPlan,
        failed_task_idx: usize,
    ) -> Result<ExecutionPlan, SdkError>;
    
    /// Resume from last checkpoint
    pub async fn resume_from_checkpoint(
        &self,
        plan: &mut ExecutionPlan,
    ) -> Result<(), SdkError>;
}

#[derive(Clone, Debug)]
pub enum RecoveryAction {
    Retried { new_agent: AgentId, attempt: u32 },
    Replanned { new_plan: ExecutionPlan },
    RestoredFromCheckpoint { checkpoint_version: u32 },
    Failed { reason: String },
}
```

**Tests (minimum 12):**
- Retry with backoff
- Max retries exceeded → Failed
- Replan finds alternative pipeline
- Resume from checkpoint
- Checkpoint before retry
- Cascading failure (dependency fails → dependent tasks cancelled)
- Partial failure (some tasks succeed, some fail)
- Recovery with circuit breaker (skip open circuits)
- Recovery with bulkhead (respect limits)
- Replan with different capability provider
- Failure during migration
- Concurrent failure handling

### Track V Integration

**File:** `aafp-sdk/src/execution/mod.rs`

```rust
pub mod plan;
pub mod scheduler;
pub mod checkpoint;
pub mod migration;
pub mod aggregator;
pub mod recovery;

pub use plan::*;
pub use scheduler::*;
pub use checkpoint::*;
pub use migration::*;
pub use aggregator::*;
pub use recovery::*;

/// The full Execution Fabric — orchestrates fluid execution.
pub struct ExecutionFabric {
    pub scheduler: Arc<TaskScheduler>,
    pub checkpoints: Arc<CheckpointManager>,
    pub migrations: Arc<MigrationManager>,
    pub recovery: Arc<FailureRecovery>,
}

impl ExecutionFabric {
    /// Execute a plan to completion (or failure)
    pub async fn execute(&self, plan: &mut ExecutionPlan) -> Result<Vec<u8>, SdkError>;
    
    /// Execute with progress callback
    pub async fn execute_with_progress<F>(
        &self,
        plan: &mut ExecutionPlan,
        on_progress: F,
    ) -> Result<Vec<u8>, SdkError>
    where F: Fn(&ExecutionPlan);
}
```

**Integration tests (minimum 10):**
- Full execution of 3-task pipeline
- Execution with parallel tasks
- Execution with failure → retry → success
- Execution with failure → replan → success
- Execution with checkpoint → crash → resume
- Execution with migration (load balancing)
- Execution with cascading failure
- Progress callback invocation
- Cancel mid-execution
- Large plan (20 tasks) execution

---

## Track X: Economic Layer

**Design doc:** INTELLIGENCE_PLANE.md §3.5 (needs elaboration)
**Target crate:** `aafp-sdk` (new module: `economics/`)
**Design status:** Components listed but not detailed. Keep it simple — credit system, not cryptocurrency.

### X1: ResourceAccount

**File:** `aafp-sdk/src/economics/account.rs`

```rust
/// Per-agent balance of credits. Simple in-memory ledger.
/// Future: persistent (SQLite), replicated.
pub struct ResourceAccount {
    /// Agent ID -> balance
    balances: RwLock<HashMap<AgentId, u64>>,
    /// Transaction log
    ledger: RwLock<Vec<Transaction>>,
    /// Configuration
    config: AccountConfig,
}

pub struct AccountConfig {
    /// Starting balance for new agents
    pub starting_balance: u64,
    /// Minimum balance to accept work (negative = allow debt)
    pub min_balance: i64,
    /// Maximum balance (prevent hoarding)
    pub max_balance: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Transaction {
    pub id: [u8; 32],
    pub from: AgentId,
    pub to: AgentId,
    pub amount: u64,
    pub reason: TransactionReason,
    pub timestamp: u64,
    pub task_id: Option<TaskId>,
}

#[derive(Clone, Debug)]
pub enum TransactionReason {
    TaskPayment,
    ResourceRental,
    Penalty,
    Reward,
    InitialGrant,
}

impl ResourceAccount {
    pub fn balance(&self, agent: &AgentId) -> u64;
    pub fn transfer(&self, from: &AgentId, to: &AgentId, amount: u64, reason: TransactionReason) -> Result<Transaction, SdkError>;
    pub fn grant(&self, agent: &AgentId, amount: u64) -> Result<Transaction, SdkError>;
    pub fn can_afford(&self, agent: &AgentId, amount: u64) -> bool;
    pub fn ledger(&self) -> Vec<Transaction>;
    pub fn ledger_for(&self, agent: &AgentId) -> Vec<Transaction>;
}
```

**Tests (minimum 12):**
- Initial grant
- Transfer between agents
- Insufficient balance rejection
- Balance check
- Min balance enforcement
- Max balance enforcement (hoarding prevention)
- Ledger logging
- Per-agent ledger filter
- Concurrent transfers (thread safety)
- Transaction ID uniqueness
- Negative balance (debt) configuration
- Empty account handling

### X2: PricingEngine

**File:** `aafp-sdk/src/economics/pricing.rs`

```rust
/// Dynamic pricing based on supply, demand, and agent reputation.
pub struct PricingEngine {
    /// Capability -> current market price
    prices: RwLock<HashMap<String, MarketPrice>>,
    config: PricingConfig,
}

pub struct PricingConfig {
    /// Base price per capability (credits per ms)
    pub base_prices: HashMap<String, u64>,
    /// Demand multiplier (price increases when demand > supply)
    pub demand_multiplier: f64,
    /// Supply multiplier (price decreases when supply > demand)
    pub supply_multiplier: f64,
    /// Reputation discount (high-reputation agents get premium)
    pub reputation_factor: f64,
    /// Minimum price floor
    pub price_floor: u64,
    /// Maximum price ceiling
    pub price_ceiling: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct MarketPrice {
    pub capability: String,
    pub current_price: u64,
    pub supply: u32,    // number of available agents
    pub demand: u32,    // number of pending requests
    pub last_updated: u64,
}

impl PricingEngine {
    /// Get the current price for a capability
    pub fn price(&self, capability: &str) -> u64;
    
    /// Get market data for a capability
    pub fn market(&self, capability: &str) -> Option<MarketPrice>;
    
    /// Update supply/demand and recalculate price
    pub fn update_market(&self, capability: &str, supply: u32, demand: u32);
    
    /// Quote a price for a specific task
    pub fn quote(&self, capability: &str, estimated_duration_ms: u64, agent_reputation: u8) -> u64;
    
    /// Record a completed transaction (for price history)
    pub fn record_transaction(&self, capability: &str, price: u64, duration_ms: u64);
}
```

**Tests (minimum 12):**
- Base price lookup
- Demand-driven price increase
- Supply-driven price decrease
- Reputation discount
- Price floor enforcement
- Price ceiling enforcement
- Quote calculation (price × duration × reputation factor)
- Market update
- Transaction recording
- Unknown capability (default price)
- Price convergence (supply = demand → base price)
- NaN/infinity guards on multipliers

### X3: PriorityQueue

**File:** `aafp-sdk/src/economics/priority.rs`

```rust
/// Priority queue for task scheduling. Higher-paying requests get priority.
/// Uses weighted fair queuing (WFQ) for fairness.
pub struct PriorityQueue {
    queues: RwLock<HashMap<u8, VecDeque<QueuedTask>>>,
    config: PriorityConfig,
}

pub struct PriorityConfig {
    /// Number of priority levels (0 = highest)
    pub levels: u8,
    /// Weight per level (for WFQ)
    pub weights: Vec<f64>,
    /// Max queue size per level
    pub max_queue_size: usize,
}

#[derive(Clone, Debug)]
pub struct QueuedTask {
    pub task_id: TaskId,
    pub plan_id: PlanId,
    pub priority: u8,
    pub bid: u64,         // credits offered
    pub enqueued_at: u64,
}

impl PriorityQueue {
    pub fn enqueue(&self, task: QueuedTask) -> Result<(), SdkError>;
    pub fn dequeue(&self) -> Option<QueuedTask>;
    pub fn peek(&self) -> Option<QueuedTask>;
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;
    pub fn cancel(&self, task_id: &TaskId) -> Option<QueuedTask>;
    pub fn queue_size(&self, priority: u8) -> usize;
}
```

**Tests (minimum 10):**
- Enqueue/dequeue ordering (higher priority first)
- WFQ fairness (lower priority still gets service)
- Bid-based priority within same level
- Queue size limit enforcement
- Cancel a queued task
- Empty queue handling
- Multi-level queue
- Concurrent enqueue/dequeue (thread safety)
- Peek without dequeue
- Queue size per level

### X4: CompensationProtocol

**File:** `aafp-sdk/src/economics/compensation.rs`

```rust
/// Micropayments for completed work. Escrow-based: payment held until task completes.
pub struct CompensationProtocol {
    accounts: Arc<ResourceAccount>,
    escrow: RwLock<HashMap<TaskId, Escrow>>,
}

#[derive(Clone, Debug)]
pub struct Escrow {
    pub task_id: TaskId,
    pub payer: AgentId,
    pub payee: AgentId,
    pub amount: u64,
    pub status: EscrowStatus,
    pub created_at: u64,
    pub timeout_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EscrowStatus {
    Held,
    Released,
    Refunded,
    Slashed,
}

impl CompensationProtocol {
    /// Lock payment in escrow before task starts
    pub fn lock(&self, task_id: TaskId, payer: &AgentId, payee: &AgentId, amount: u64, timeout_ms: u64) -> Result<Escrow, SdkError>;
    
    /// Release payment to payee after successful completion
    pub fn release(&self, task_id: &TaskId) -> Result<Transaction, SdkError>;
    
    /// Refund to payer if task fails or times out
    pub fn refund(&self, task_id: &TaskId) -> Result<Transaction, SdkError>;
    
    /// Slash payment (penalty) if task was malicious
    pub fn slash(&self, task_id: &TaskId) -> Result<Transaction, SdkError>;
    
    /// Check for timed-out escrows and refund
    pub fn evict_timeouts(&self) -> Vec<Transaction>;
    
    /// Get escrow status
    pub fn status(&self, task_id: &TaskId) -> Option<EscrowStatus>;
}
```

**Tests (minimum 12):**
- Lock escrow (balance deducted from payer)
- Release escrow (balance credited to payee)
- Refund escrow (balance returned to payer)
- Slash escrow (balance burned/returned to network)
- Timeout eviction
- Insufficient balance for lock
- Double-lock prevention
- Release without lock (error)
- Refund after release (error)
- Concurrent lock/release (thread safety)
- Escrow status tracking
- Multiple escrows for same agent

### X5: SlashingConditions

**File:** `aafp-sdk/src/economics/slashing.rs`

```rust
/// Penalties for failed or malicious work.
pub struct SlashingConditions {
    config: SlashingConfig,
}

pub struct SlashingConfig {
    /// Penalty for task failure (fraction of task payment)
    pub failure_penalty: f64,
    /// Penalty for timeout (fraction of task payment)
    pub timeout_penalty: f64,
    /// Penalty for malicious behavior (flat amount)
    pub malicious_penalty: u64,
    /// Penalty for false attestation (flat amount)
    pub false_attestation_penalty: u64,
    /// Threshold for reputation impact
    pub reputation_impact_threshold: u32,
}

impl SlashingConditions {
    /// Calculate penalty for a failure
    pub fn failure_penalty(&self, task_payment: u64) -> u64;
    
    /// Calculate penalty for a timeout
    pub fn timeout_penalty(&self, task_payment: u64) -> u64;
    
    /// Calculate penalty for malicious behavior
    pub fn malicious_penalty(&self) -> u64;
    
    /// Calculate penalty for false attestation
    pub fn false_attestation_penalty(&self) -> u64;
    
    /// Determine if an agent should be slashed
    pub fn should_slash(&self, agent_history: &AgentHistory) -> Option<SlashReason>;
}

#[derive(Clone, Debug)]
pub struct AgentHistory {
    pub agent_id: AgentId,
    pub total_tasks: u64,
    pub failed_tasks: u64,
    pub timed_out_tasks: u64,
    pub malicious_flags: u32,
    pub false_attestations: u32,
}

#[derive(Clone, Debug)]
pub enum SlashReason {
    HighFailureRate(f64),
    HighTimeoutRate(f64),
    MaliciousBehavior,
    FalseAttestation,
}
```

**Tests (minimum 10):**
- Failure penalty calculation
- Timeout penalty calculation
- Malicious penalty
- False attestation penalty
- Should slash: high failure rate
- Should slash: high timeout rate
- Should slash: malicious behavior
- Should slash: false attestation
- No slash for good behavior
- Penalty within bounds (not negative, not exceeding payment)

### Track X Integration

**File:** `aafp-sdk/src/economics/mod.rs`

```rust
pub mod account;
pub mod pricing;
pub mod priority;
pub mod compensation;
pub mod slashing;

pub use account::*;
pub use pricing::*;
pub use priority::*;
pub use compensation::*;
pub use slashing::*;

/// The full Economic Layer.
pub struct EconomicLayer {
    pub accounts: Arc<ResourceAccount>,
    pub pricing: Arc<PricingEngine>,
    pub priority: Arc<PriorityQueue>,
    pub compensation: Arc<CompensationProtocol>,
    pub slashing: Arc<SlashingConditions>,
}
```

**Integration tests (minimum 8):**
- Full payment cycle: lock escrow → task completes → release payment
- Full failure cycle: lock escrow → task fails → refund → slash penalty
- Priority queue + pricing: high bid gets priority
- Pricing engine + reputation: high-reputation agent gets premium
- Slashing + accounts: penalty deducted from balance
- Concurrent task payments (thread safety)
- Economic layer + scheduler integration (cost-weighted scheduling)
- Account balance limits (min/max enforcement)

---

## Track Y: World Perception Layer

**Design doc:** INTERNET_BRIDGE_PLAN.md (941 lines, fully designed)
**Target crate:** `aafp-perception` (new crate)
**Design status:** Fully designed. Schema, sessions, capabilities, and roadmap all specified.

### Y1: Agent-Native Content Schema (RFC-0016)

**File:** `aafp-perception/src/schema.rs`

Implement the `WebContent` and `DocumentContent` CBOR schemas from INTERNET_BRIDGE_PLAN.md §1.2 and §1.5.

**Required structs:**
- `WebContent` (12 fields: url, title, metadata, nav, sections, elements, forms, media, links, structured, entities, hash)
- `ContentSection` (5 fields)
- `InteractiveElement` (7 fields, including `ActionSafety` enum)
- `Action` (3 fields)
- `FormDef` + `FormField`
- `MediaItem`
- `LinkDef`
- `StructuredData`
- `Entity`
- `ContentHash` (SHA-256 of normalized content)
- `PageMetadata` (7 fields)
- `NavigationState` (4 fields)
- `DocumentContent` (9 fields)
- `TableDef`

**All with CBOR encoding/decoding (int-keyed maps).**

**Tests (minimum 20):**
- CBOR round-trip for every struct
- Missing optional fields handled gracefully
- Action safety classification
- Content hash stability (same content → same hash)
- Ref-based targeting (@e0, @s1, etc.)
- Empty content handling
- Large content handling (100 sections)
- Document content with tables
- Navigation state tracking

### Y2: Search + Web-Browse Capabilities

**File:** `aafp-perception/src/capabilities/search.rs`
**File:** `aafp-perception/src/capabilities/web_browse.rs`

Implement the `search` and `web-browse` capability providers from INTERNET_BRIDGE_PLAN.md §4.2.

**search capability:**
- Input: query, num_results, sources, time_range, fetch_content
- Output: SearchResult with title, url, snippet, score, source
- Provider trait: `SearchProvider` (pluggable: Brave, SerpApi, SearXNG)
- Federation: query multiple providers, merge results, deduplicate
- Rate limiting: per-agent quota (100/hr default)

**web-browse capability:**
- Input: url, format (agent-native|markdown|html|accessibility), wait_for, screenshot
- Output: WebContent (Y1 schema) or markdown/HTML per format
- Provider trait: `BrowseProvider` (pluggable: Firecrawl, self-hosted Playwright)
- Content cache: LRU with TTL, respects HTTP Cache-Control
- Robots.txt: fetch and parse before browsing, enforce Disallow

**Note:** External API integration (Brave, Firecrawl) requires network access and API keys. For testing, use mock providers that return canned responses. The real providers are configured at deployment time.

**Tests (minimum 20):**
- Search with mock provider
- Search federation (multiple providers)
- Search result deduplication
- Search rate limiting
- Web-browse with mock provider
- Web-browse returns agent-native content
- Web-browse returns markdown
- Content cache hit
- Content cache miss
- Content cache TTL expiration
- Robots.txt disallow enforcement
- Robots.txt crawl-delay
- Empty search results
- Invalid URL handling
- Timeout handling
- Provider failover (primary down → fallback)
- Search with time range filter
- Web-browse with wait_for=networkidle
- Screenshot capture (mock)
- Federation result merging

### Y3: Document-Read Capability

**File:** `aafp-perception/src/capabilities/document_read.rs`

- Input: source (URL or path), type (auto|pdf|word|excel|powerpoint), ocr, extract_tables
- Output: DocumentContent (Y1 schema)
- Provider trait: `DocumentProvider` (pluggable: PyMuPDF, Tika, Tesseract)
- Auto-detection: sniff file type from magic bytes
- OCR integration: Tesseract for scanned PDFs/images
- Table extraction: structured table output

**Tests (minimum 12):**
- PDF parsing (mock)
- Word document parsing (mock)
- Excel parsing (mock)
- Auto-detection of file type
- OCR on scanned content (mock)
- Table extraction
- Large document handling (100 pages)
- Invalid document handling
- URL-based document fetch
- DocumentContent CBOR round-trip
- Empty document
- Mixed content (text + images + tables)

### Y4: API-Call Capability

**File:** `aafp-perception/src/capabilities/api_call.rs`

- Input: api_name, method, path, body
- Output: HTTP response (status, headers, body)
- Credential store: encrypted (AES-256-GCM), per-API allowlist
- Rate limiting: per-API, per-agent
- Network-wide API key pooling (future)

**Tests (minimum 10):**
- GET request (mock)
- POST request (mock)
- Credential retrieval
- Credential encryption/decryption
- API allowlist enforcement
- Rate limiting per API
- Rate limiting per agent
- Error handling (404, 500, timeout)
- Large response handling
- Concurrent API calls

### Y5: API-Discover Capability

**File:** `aafp-perception/src/capabilities/api_discover.rs`

- Input: domain or URL
- Flow: probe /openapi.json, /swagger.json, /api-docs → parse spec → generate tool definitions → register as dynamic capabilities
- Safeguards: domain allowlist, read-only by default (GET/HEAD only), explicit approval for POST/PUT/DELETE

**Tests (minimum 10):**
- OpenAPI spec parsing (mock)
- Swagger spec parsing (mock)
- Tool definition generation
- Dynamic capability registration
- Domain allowlist enforcement
- Read-only enforcement (block POST by default)
- Explicit approval for write operations
- Invalid spec handling
- No spec found (no /openapi.json)
- Multiple specs on same domain

### Y6: Code-Execute Capability

**File:** `aafp-perception/src/capabilities/code_execute.rs`

- Input: code, language, timeout, network (bool)
- Sandbox: WASM for trusted code (10ms startup), Firecracker for untrusted (125ms startup)
- Security: network disabled by default, hard timeout (30s), resource limits, code validation, audit logging
- Output: stdout, stderr, exit_code, duration_ms

**Note:** Actual sandbox integration (Firecracker/WASM) is deployment-specific. For testing, use a mock executor that returns canned output. The real sandbox is configured at deployment time.

**Tests (minimum 12):**
- Code execution (mock)
- Timeout enforcement
- Network disabled by default
- Resource limit enforcement (CPU, memory)
- Code validation (block dangerous operations)
- Audit logging
- Multiple languages (Python, JavaScript, Rust)
- stdout/stderr capture
- Exit code reporting
- Concurrent execution
- Failed execution (syntax error)
- Security: no filesystem access

### Y7: Media Capabilities (OCR + Transcribe)

**File:** `aafp-perception/src/capabilities/image_ocr.rs`
**File:** `aafp-perception/src/capabilities/audio_transcribe.rs`

**image-ocr:**
- Input: image bytes or URL
- Output: extracted text, bounding boxes, confidence scores
- Provider trait: `OcrProvider` (pluggable: Tesseract, Google Vision)

**audio-transcribe:**
- Input: audio bytes or URL
- Output: transcription text, timestamps, confidence scores
- Provider trait: `TranscribeProvider` (pluggable: Whisper, Deepgram)

**Tests (minimum 12):**
- OCR with mock provider
- OCR with bounding boxes
- OCR confidence scores
- Transcribe with mock provider
- Transcribe with timestamps
- Transcribe confidence scores
- Multiple languages
- Large image handling
- Long audio handling
- Invalid input handling
- Provider failover
- Empty result handling

### Y8: Stateful Browsing Sessions

**File:** `aafp-perception/src/sessions/mod.rs`
**File:** `aafp-perception/src/sessions/state.rs`
**File:** `aafp-perception/src/sessions/manager.rs`

Implement the session lifecycle, state schema, and RPC methods from INTERNET_BRIDGE_PLAN.md §2.

**SessionState schema (RFC-0017):**
- session_id, url, title, status, cookies, storage, scroll, forms, history, tabs, metadata
- All with CBOR encoding/decoding

**Session lifecycle:**
- Creating → Active → Idle → Resuming → Active → Destroyed
- Idle timeout: 30m → pause
- Session timeout: 24h → destroy
- Operation timeout: 30s per op

**RPC methods:**
- browse.create_session, browse.navigate, browse.click, browse.type
- browse.scroll, browse.screenshot, browse.extract, browse.submit
- browse.back, browse.forward, browse.get_state, browse.destroy_session

**Session lock manager:**
- Exclusive (mutating ops: click, type, submit)
- Shared (read-only: screenshot, extract)
- None (state queries: get_state)
- Lock timeout: 30s, queue timeout: 5m

**Tests (minimum 20):**
- Session lifecycle (create → active → idle → resume → destroy)
- Session state CBOR round-trip
- Navigate to URL
- Click element by ref
- Type text into field
- Scroll page
- Screenshot capture (mock)
- Extract content
- Submit form
- Back/forward navigation
- Get state
- Destroy session
- Lock: exclusive blocks exclusive
- Lock: shared allows shared
- Lock timeout
- Queue timeout
- Idle timeout → pause
- Session timeout → destroy
- Operation timeout
- Concurrent session access (multi-agent)

### Y9: UCAN Delegation for Sessions

**File:** `aafp-perception/src/sessions/ucan.rs`

Implement UCAN capability delegation for browsing sessions from INTERNET_BRIDGE_PLAN.md §2.5.

**Capability namespace:**
```
aafp://browse/
  ├─ create
  └─ session/{session_id}/
      ├─ navigate, click, type, scroll
      ├─ screenshot, extract, submit
      ├─ back, forward, get_state
      └─ destroy
```

**Delegation patterns:**
- Full session: `aafp://browse/session/123/*`
- Scoped: `aafp://browse/session/123/{navigate,click,type}`
- Read-only: `aafp://browse/session/123/{screenshot,extract,get_state}`
- Single-use: with nonce

**Validation on every operation:**
1. Verify UCAN signature (ML-DSA-65)
2. Check time bounds (nbf ≤ now ≤ exp)
3. Verify proof chain
4. Check audience matches calling agent
5. Check capability matches operation
6. Check session_id matches
7. Check additional constraints (allowed_urls, nonce)

**Tests (minimum 15):**
- Full session delegation
- Scoped delegation (specific operations)
- Read-only delegation
- Single-use delegation (nonce)
- Invalid signature rejection
- Expired delegation rejection
- Wrong audience rejection
- Wrong session_id rejection
- Proof chain verification
- Capability mismatch rejection
- allowed_urls constraint
- Nonce replay prevention
- Delegate from delegate (chain)
- Revoke delegation
- Complex proof chain (3 levels)

---

## Track T Extension: Temporal Prediction Engine

**Design doc:** ADAPTIVE_ROUTING_PLANE.md (partially designed)
**Target crate:** `aafp-sdk` (extend `routing/` module)
**Design status:** EWMA metrics exist. Need to add temporal prediction.

### T8: TemporalPredictionEngine

**File:** `aafp-sdk/src/routing/prediction.rs`

```rust
/// Predicts future agent performance based on historical metrics.
/// "Who will be fastest 200ms from now?" not "Who is fastest now?"
pub struct TemporalPredictionEngine {
    /// Agent ID -> prediction model
    models: RwLock<HashMap<AgentId, PredictionModel>>,
    config: PredictionConfig,
}

pub struct PredictionConfig {
    /// History window size (number of samples)
    pub window_size: usize,
    /// Prediction horizon (ms) — how far ahead to predict
    pub horizon_ms: u64,
    /// Model update interval (ms)
    pub update_interval_ms: u64,
    /// Confidence threshold (0.0-1.0)
    pub confidence_threshold: f64,
}

#[derive(Clone, Debug)]
pub struct PredictionModel {
    pub agent_id: AgentId,
    /// Linear regression: latency = slope * t + intercept
    pub latency_slope: f64,
    pub latency_intercept: f64,
    /// EWMA of latency
    pub latency_ewma: f64,
    /// EWMA of success rate
    pub success_ewma: f64,
    /// EWMA of load (0.0-1.0)
    pub load_ewma: f64,
    /// Prediction confidence (0.0-1.0)
    pub confidence: f64,
    /// Last N samples (timestamp, latency, success, load)
    pub samples: VecDeque<(u64, f64, bool, f64)>,
}

impl TemporalPredictionEngine {
    /// Record a new sample for an agent
    pub fn record(&self, agent: &AgentId, timestamp: u64, latency_ms: f64, success: bool, load: f64);
    
    /// Predict the latency of an agent `horizon_ms` from now
    pub fn predict_latency(&self, agent: &AgentId, horizon_ms: u64) -> Option<f64>;
    
    /// Predict the success probability of an agent
    pub fn predict_success(&self, agent: &AgentId) -> Option<f64>;
    
    /// Get the predicted-best agent for a capability
    pub fn predict_best(&self, candidates: &[AgentId], horizon_ms: u64) -> Option<AgentId>;
    
    /// Get prediction confidence for an agent
    pub fn confidence(&self, agent: &AgentId) -> f64;
    
    /// Update all models (called periodically)
    pub fn update_models(&self);
}
```

**Implementation requirements:**
- Linear regression for latency trend (slope, intercept)
- EWMA for smoothing (already exists in PeerMetricsRegistry, reuse)
- Confidence = function of sample count and variance (more samples + lower variance = higher confidence)
- `predict_best` selects the agent with lowest predicted latency above confidence threshold
- Guard against NaN/infinity in all calculations
- Use `saturating_add` for all counters

**Tests (minimum 15):**
- Single sample prediction
- Multi-sample prediction with trend
- Predicted latency increases with upward trend
- Predicted latency decreases with downward trend
- Confidence increases with more samples
- Confidence decreases with high variance
- predict_best selects lowest predicted latency
- predict_best with confidence threshold (skip low-confidence)
- EWMA smoothing
- NaN/infinity guards
- Empty model (no samples)
- Single agent prediction
- Multi-agent comparison
- Horizon effect (longer horizon = more uncertainty)
- Model update interval

### T9: Predictive Prefetching

**File:** `aafp-sdk/src/routing/prefetch.rs`

```rust
/// Predict which agents will be needed soon and pre-warm connections.
pub struct PredictivePrefetcher {
    prediction: Arc<TemporalPredictionEngine>,
    /// Connection pool for pre-warming
    pool: Arc<ConnectionPool>,
    /// Markov chain: (from_capability, to_capability) -> probability
    transitions: RwLock<HashMap<(String, String), f64>>,
    config: PrefetchConfig,
}

pub struct PrefetchConfig {
    /// Probability threshold for prefetching (0.0-1.0)
    pub prefetch_threshold: f64,
    /// Max concurrent prefetches
    max_prefetches: usize,
    /// Prefetch TTL (ms) — close if unused
    pub prefetch_ttl_ms: u64,
}

impl PredictivePrefetcher {
    /// Record a capability transition (A → B)
    pub fn record_transition(&self, from: &str, to: &str);
    
    /// Predict the next likely capability
    pub fn predict_next(&self, current: &str) -> Vec<(String, f64)>;
    
    /// Pre-warm connections to agents with the predicted next capability
    pub async fn prefetch(&self, current_capability: &str) -> Result<Vec<AgentId>, SdkError>;
    
    /// Get transition probabilities
    pub fn transitions(&self) -> HashMap<(String, String), f64>;
}
```

**Tests (minimum 10):**
- Transition recording
- Next capability prediction
- Prefetch triggers on high probability
- Prefetch respects threshold
- Prefetch respects max concurrent
- Prefetch TTL expiry
- No transitions (cold start)
- Markov chain convergence
- Multi-step prediction
- Prefetch with no available agents

---

## Track U Extension: Live DHT Integration

**Design doc:** SEMANTIC_CAPABILITY_GRAPHS.md (partially designed)
**Target crate:** `aafp-discovery` (extend `semantic/` module)
**Design status:** SCG exists but queries local index only. Need to query live DHT.

### U7: DHT-Backed Semantic Query

**File:** `aafp-discovery/src/semantic/dht_query.rs`

```rust
/// Query the live DHT for semantically matching agents.
/// Merges DHT results with local index for hybrid discovery.
pub struct DhtSemanticQuery {
    /// Local capability index (fast, cached)
    local_index: Arc<CapabilityIndex>,
    /// DHT for remote discovery
    dht: Arc<CapabilityDht>,
    /// Configuration
    config: DhtQueryConfig,
}

pub struct DhtQueryConfig {
    /// Whether to query local index first
    pub local_first: bool,
    /// Whether to fall back to DHT if local has no results
    pub dht_fallback: bool,
    /// Maximum DHT hops
    pub max_hops: u8,
    /// Query timeout (ms)
    pub timeout_ms: u64,
    /// Cache TTL for DHT results (ms)
    pub cache_ttl_ms: u64,
}

impl DhtSemanticQuery {
    /// Query for agents matching a CapabilityQuery
    pub async fn query(&self, query: &CapabilityQuery) -> Result<Vec<AgentRecord>, SemanticError>;
    
    /// Query local index only (fast, no network)
    pub fn query_local(&self, query: &CapabilityQuery) -> Vec<AgentRecord>;
    
    /// Query DHT only (slow, comprehensive)
    pub async fn query_dht(&self, query: &CapabilityQuery) -> Result<Vec<AgentRecord>, SemanticError>;
    
    /// Merge local and DHT results, deduplicate
    pub fn merge_results(local: Vec<AgentRecord>, dht: Vec<AgentRecord>) -> Vec<AgentRecord>;
}
```

**Tests (minimum 12):**
- Local-only query
- DHT-only query
- Hybrid query (local + DHT)
- DHT fallback when local empty
- Result deduplication (same agent in both)
- Query timeout
- Max hops enforcement
- Cache TTL
- Empty results
- Large result set
- Concurrent queries
- Query with geo filter (local filter after DHT retrieval)

### U8: Intent-to-Plan SDK Resolution

**File:** `aafp-sdk/src/intent.rs`

```rust
/// High-level intent resolution: "build an iOS app" → ExecutionPlan
/// Connects SCG planner + DHT query + ExecutionPlan.
pub struct IntentResolver {
    query: Arc<DhtSemanticQuery>,
    planner: Arc<HeuristicPlanner>,
    scheduler: Arc<TaskScheduler>,
}

impl IntentResolver {
    /// Resolve a natural language goal to an execution plan
    pub async fn resolve(&self, goal: &str) -> Result<ExecutionPlan, SdkError>;
    
    /// Resolve with constraints (max cost, max latency, required capabilities)
    pub async fn resolve_with_constraints(
        &self,
        goal: &str,
        constraints: &PlanConstraints,
    ) -> Result<ExecutionPlan, SdkError>;
    
    /// Execute a goal directly (resolve + execute)
    pub async fn execute_goal(&self, goal: &str) -> Result<Vec<u8>, SdkError>;
}

pub struct PlanConstraints {
    pub max_cost: Option<u64>,
    pub max_latency_ms: Option<u64>,
    pub required_capabilities: Vec<String>,
    pub excluded_agents: Vec<AgentId>,
    pub min_reputation: Option<u8>,
}
```

**Tests (minimum 10):**
- Simple goal resolution (single capability)
- Complex goal resolution (multi-step pipeline)
- Goal with cost constraint
- Goal with latency constraint
- Goal with required capabilities
- Goal with excluded agents
- Goal with reputation minimum
- Execute goal end-to-end
- No matching agents (error)
- Ambiguous goal (multiple valid plans)

---

## Track W Extension: Reputation Scoring

**Design doc:** AGENT_RECORD_EXTENSIONS.md (partially designed)
**Target crate:** `aafp-identity` (extend `extensions/` module)
**Design status:** Reputation extension field exists. Need scoring algorithms.

### W7: ReputationScoreEngine

**File:** `aafp-identity/src/extensions/reputation_scoring.rs`

```rust
/// Calculates reputation scores from performance history.
/// Uses weighted average of: success rate, latency, cost, availability.
pub struct ReputationScoreEngine {
    config: ReputationConfig,
}

pub struct ReputationConfig {
    /// Weight for success rate (0.0-1.0)
    pub success_weight: f64,
    /// Weight for latency (0.0-1.0)
    pub latency_weight: f64,
    /// Weight for cost (0.0-1.0)
    pub cost_weight: f64,
    /// Weight for availability (0.0-1.0)
    pub availability_weight: f64,
    /// Weight for attestation count (0.0-1.0)
    pub attestation_weight: f64,
    /// History window (number of interactions)
    pub history_window: usize,
    /// Decay factor for old interactions
    pub decay_factor: f64,
}

impl ReputationScoreEngine {
    /// Calculate reputation score for an agent
    pub fn score(&self, history: &PerformanceHistory, attestations: &[Attestation]) -> ReputationScore;
    
    /// Calculate score from AgentRecord extensions
    pub fn score_from_record(&self, record: &AgentRecord) -> ReputationScore;
    
    /// Update reputation extension in an AgentRecord
    pub fn update_record(&self, record: &mut AgentRecord, history: &PerformanceHistory, attestations: &[Attestation]);
}

#[derive(Clone, Debug)]
pub struct PerformanceHistory {
    pub agent_id: AgentId,
    pub interactions: VecDeque<Interaction>,
}

#[derive(Clone, Debug)]
pub struct Interaction {
    pub timestamp: u64,
    pub success: bool,
    pub latency_ms: u64,
    pub cost: u64,
    pub capability: String,
}

#[derive(Clone, Debug)]
pub struct ReputationScore {
    pub overall: u8,           // 0-100
    pub success_score: u8,     // 0-100
    pub latency_score: u8,     // 0-100
    pub cost_score: u8,        // 0-100
    pub availability_score: u8, // 0-100
    pub attestation_score: u8, // 0-100
    pub confidence: f64,       // 0.0-1.0
}
```

**Implementation requirements:**
- Weighted average with configurable weights (must sum to 1.0)
- Time decay: older interactions have less weight (exponential decay)
- Confidence: function of interaction count (more = higher confidence)
- All scores 0-100 (u8), guard against overflow
- NaN/infinity guards on all float calculations

**Tests (minimum 15):**
- Perfect agent (all 100s)
- Poor agent (low scores)
- Mixed performance
- Time decay (old interactions weighted less)
- Confidence increases with more interactions
- Weight configuration
- Score from AgentRecord
- Update AgentRecord with new score
- Empty history (default score)
- Single interaction
- Attestation boost
- No attestations
- NaN/infinity guards
- Score bounds (0-100)
- Weighted average correctness

### W8: Reputation Propagation (Gossip)

**File:** `aafp-identity/src/extensions/reputation_gossip.rs`

```rust
/// Gossip protocol for reputation distribution.
/// Uses PubSub (GossipSub) to propagate reputation updates.
pub struct ReputationPropagation {
    /// PubSub for gossip
    pubsub: Arc<PubSubManager>,
    /// Local reputation cache
    cache: RwLock<HashMap<AgentId, ReputationScore>>,
    /// Configuration
    config: GossipConfig,
}

pub struct GossipConfig {
    /// Topic for reputation updates
    pub topic: String,  // default: "aafp://reputation"
    /// Update interval (ms) — how often to gossip local scores
    pub gossip_interval_ms: u64,
    /// Maximum age of reputation data before refresh (ms)
    pub max_age_ms: u64,
    /// Minimum score change to trigger gossip
    pub min_change_threshold: u8,
}

impl ReputationPropagation {
    /// Publish a reputation update
    pub async fn publish(&self, agent: &AgentId, score: &ReputationScore) -> Result<(), SdkError>;
    
    /// Subscribe to reputation updates
    pub async fn subscribe(&self) -> Result<SubscriptionStream, SdkError>;
    
    /// Get cached reputation for an agent
    pub fn get(&self, agent: &AgentId) -> Option<ReputationScore>;
    
    /// Update local cache from gossip message
    pub fn update_cache(&self, agent: &AgentId, score: ReputationScore);
    
    /// Start background gossip (periodic publish of local scores)
    pub fn start_gossip(&self, local_scores: Arc<RwLock<HashMap<AgentId, ReputationScore>>>);
}
```

**Tests (minimum 12):**
- Publish reputation update
- Subscribe to updates
- Cache update from gossip
- Get cached reputation
- Gossip interval
- Max age expiry
- Min change threshold (don't gossip tiny changes)
- Background gossip task
- Multiple agents gossiping
- Reputation convergence (agents converge to same scores)
- UCAN ACL enforcement (only authorized agents can publish)
- GossipSub integration

---

## Verification Protocol

After each track, run:

```bash
cd /Users/david/Projects/AAFP-research/implementations/rust

# 1. Format check
cargo fmt --all -- --check

# 2. Build (0 warnings expected)
cargo build --workspace

# 3. Clippy (0 warnings expected)
cargo clippy --workspace

# 4. Full test suite (must not regress below 1864 tests)
cargo test --workspace

# 5. If all pass, commit
git add -A
git commit -m "feat: <track> <phase> — <description>

- <key changes>
- Tests: <new count> passing, 0 failures

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

After all tracks complete:

```bash
# 6. Security review checklist
# - No unwrap() on Mutex (use expect)
# - No unwrap() on channel sends (use expect or log+continue)
# - All CBOR decode validated (no silent truncation)
# - All float-to-int casts guarded with is_finite()
# - All counters use saturating_add/saturating_mul
# - All ACLs default-deny
# - No predictable IDs (use CSPRNG)

# 7. Create freeze tag
git tag -a v0.5-phase4-complete -m "Phase 4 complete — all Intelligence Plane tracks implemented"

# 8. Update docs
# - NORTH_STAR.md: update test count, track status
# - ROADMAP.md: update Phase 4 status
# - INTELLIGENCE_PLANE.md: update status to COMPLETE
# - AGENTS.md: update test count
```

---

## Summary: Test Count Targets

| Track | New Tests | Running Total |
|-------|-----------|---------------|
| Starting point | — | 1864 |
| V1-V2 (Plan + Scheduler) | +30 | 1894 |
| V3-V4 (Checkpoint + Migration) | +20 | 1914 |
| V5-V6 (Aggregator + Recovery) | +22 | 1936 |
| V integration | +10 | 1946 |
| X1-X2 (Account + Pricing) | +24 | 1970 |
| X3-X4 (Priority + Compensation) | +22 | 1992 |
| X5 (Slashing) | +10 | 2002 |
| X integration | +8 | 2010 |
| Y1 (Schema) | +20 | 2030 |
| Y2 (Search + Browse) | +20 | 2050 |
| Y3 (Document-Read) | +12 | 2062 |
| Y4-Y5 (API Call + Discover) | +20 | 2082 |
| Y6-Y7 (Code-Execute + Media) | +24 | 2106 |
| Y8-Y9 (Sessions + UCAN) | +35 | 2141 |
| T8-T9 (Temporal + Prefetch) | +25 | 2166 |
| U7-U8 (DHT Query + Intent) | +22 | 2188 |
| W7-W8 (Scoring + Gossip) | +27 | 2215 |

**Target: ~2215 tests (from 1864), ~350 new tests, ~20K new lines of code**

---

## Dependency Graph

```
Wave 1 (parallel):
  V1-V2 ──────┐
  Y1-Y2 ──────┤
  T8 ─────────┤
  U7 ─────────┤
  W7 ─────────┘
              
Wave 2 (after Wave 1):
  V3-V4 ←── V1-V2
  Y3 ←──── Y1-Y2
  X1-X2 ←── V1 (task model)

Wave 3 (after Wave 2):
  V5-V6 ←── V3-V4
  Y4-Y5 ←── Y1-Y2
  X3-X4 ←── X1-X2

Wave 4 (after Wave 3):
  Y6-Y7 ←── Y4-Y5
  X5 ←──── X3-X4
  U8 ←──── U7, V1-V2

Wave 5 (after Wave 4):
  Y8-Y9 ←── Y1-Y7
  W8 ←──── W7
  T9 ←──── T8, Y1-Y2
```
