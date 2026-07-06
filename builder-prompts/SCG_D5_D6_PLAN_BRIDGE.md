# Builder Prompt: SCG D5-D6 — Planning + Internet Bridge Integration

## Objective

Implement the final two phases of the Semantic Capability Graphs (Track U) design:
- **Phase D5 (Planning):** A `CapabilityPlanner` that turns a goal query into an
  ordered `ExecutionPlan` by searching the capability graph, using a heuristic
  planner that combines greedy forward chaining with A* search.
- **Phase D6 (Internet Bridge Integration):** Semantic descriptors and capability
  schemas for all 11 well-known internet bridge capabilities, plus integration
  tests that drive real bridge agents through the planner.

This is the capstone of Track U: discovery becomes planning, and the planner is
exercised against the World Perception Layer from `INTERNET_BRIDGE_PLAN.md`.

## Prerequisites

- D1-D4 must be complete: `SemanticCapability`, `CapabilityQuery`, `CapabilityIndex`,
  and `CapabilityGraph` (with `PipelineAssembler`) are all implemented and tested.
- The internet bridge crate (`aafp-bridge`) must exist with at least stub
  providers for the 11 well-known capabilities (see `INTERNET_BRIDGE_PLAN.md`
  Part 4). Stubs return canned `WebContent`/`DocumentContent` so tests can run
  without network access.
- `aafp-routing` (Track T) must expose `RoutingMetrics::health_score()` so the
  planner can blend static and dynamic scores.

## Context

Read these design documents before starting:
- `SEMANTIC_CAPABILITY_GRAPHS.md` — sections 10 (Discovery as Planning) and 11
  (Implementation Roadmap, Phases 5-6)
- `INTERNET_BRIDGE_PLAN.md` — Part 4 (Internet Bridge Capabilities) and the
  well-known capability list in the architecture diagram (lines 45-56)
- `ADAPTIVE_ROUTING_PLANE.md` — section 8 (Combined Scoring) for the
  static/dynamic score blend

## What to Build

### Part 1: CapabilityPlanner Trait (SCG §10)

Add the planner trait to `aafp-planning` (new crate, or a module inside
`aafp-discovery` if a separate crate is not warranted):

```rust
use aafp_identity::AgentId;
use aafp_routing::RoutingMetrics;

use crate::{CapabilityQuery, SemanticCapability, SemanticError};

/// A planner turns a goal query into an ordered execution plan by searching
/// the capability graph. Implementations may use different search strategies
/// (greedy, A*, symbolic). The trait is async-aware because graph traversal
/// may need to issue follow-up discovery queries for unsatisfied requirements.
#[async_trait::async_trait]
pub trait CapabilityPlanner: Send + Sync {
    /// Find an execution plan that achieves the goal.
    ///
    /// `available` is the set of capabilities the calling agent currently
    /// knows about (from local index + recent DHT discovery). The planner
    /// may return `PlanningError::MissingCapability` if a required
    /// precondition cannot be satisfied by any available capability.
    async fn plan(
        &self,
        goal: &CapabilityQuery,
        available: &[SemanticCapability],
    ) -> Result<ExecutionPlan, PlanningError>;

    /// Same as `plan` but with live routing metrics so the planner can
    /// prefer healthy providers. Default impl falls back to `plan`.
    async fn plan_with_metrics(
        &self,
        goal: &CapabilityQuery,
        available: &[SemanticCapability],
        metrics: &[(AgentId, RoutingMetrics)],
    ) -> Result<ExecutionPlan, PlanningError> {
        let _ = metrics;
        self.plan(goal, available).await
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PlanningError {
    #[error("no capability satisfies goal: {0}")]
    NoSolution(String),
    #[error("required capability not available: {0}")]
    MissingCapability(String),
    #[error("plan exceeds complexity budget (max {max_steps} steps)")]
    ComplexityExceeded { max_steps: usize },
    #[error("plan exceeds cost budget ({budget_micro_usd} micro-USD)")]
    CostExceeded { budget_micro_usd: u64 },
    #[error("cycle detected in capability graph at {node}")]
    CycleDetected { node: String },
    #[error("index error: {0}")]
    Index(#[from] SemanticError),
}
```

### Part 2: ExecutionPlan + PlannedStep (SCG §10.2)

```rust
/// An ordered execution plan produced by a `CapabilityPlanner`.
#[derive(Debug, Clone)]
pub struct ExecutionPlan {
    /// Ordered steps. Step i may depend on steps 0..i (see `depends_on`).
    pub steps: Vec<PlannedStep>,
    /// Sum of `avg_latency_ms` across all steps (serial estimate).
    /// Parallel branches are maxed, not summed.
    pub estimated_total_latency_ms: f64,
    /// Sum of `per_invocation_micro_usd` across all steps.
    pub estimated_total_cost_micro_usd: u64,
    /// Number of distinct agents involved (for fan-out analysis).
    pub agent_count: usize,
    /// Whether the plan is fully satisfied (all preconditions met) or
    /// partial (some preconditions open, requiring further discovery).
    pub complete: bool,
}

/// One step in an execution plan. Maps to a single capability invocation
/// against a specific agent, with explicit preconditions and effects drawn
/// from the `SemanticCapability` requirements/provides fields.
#[derive(Debug, Clone)]
pub struct PlannedStep {
    /// Index into the plan's `steps` vector (also the topological order).
    pub index: usize,
    /// The capability to invoke.
    pub capability: SemanticCapability,
    /// The agent that provides this capability (chosen by the planner).
    pub agent_id: AgentId,
    /// Indices of prior steps whose outputs feed into this step.
    pub depends_on: Vec<usize>,
    /// Preconditions that must hold before this step runs. Each is derived
    /// from a `Requirement` on the capability and is either satisfied by a
    /// prior step's effect or by the initial state.
    pub preconditions: Vec<Precondition>,
    /// Effects produced by this step (outputs that become available to
    /// later steps). Derived from `SemanticCapability.provides`.
    pub effects: Vec<Effect>,
    /// Estimated latency for this step alone (ms).
    pub estimated_latency_ms: f64,
    /// Estimated cost for this step alone (micro-USD).
    pub estimated_cost_micro_usd: u64,
}

/// A precondition is a symbolic predicate over the execution state.
/// The planner matches preconditions against effects of prior steps.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Precondition {
    /// The kind of thing required (e.g., "document-text", "image-bytes").
    pub kind: String,
    /// Optional attribute constraints (e.g., language=en, format=pdf).
    pub attributes: Vec<(String, String)>,
}

/// An effect is a symbolic assertion of what a step produces.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Effect {
    pub kind: String,
    pub attributes: Vec<(String, String)>,
}
```

### Part 3: Heuristic Planner (Greedy + A*)

Implement `HeuristicPlanner`, the default planner. It runs in two phases:

1. **Greedy forward chaining** — starting from the goal, find capabilities
   whose `provides` match the goal. For each unsatisfied `Requirement`, recurse
   to find a capability that produces the required effect. This builds a
   dependency DAG quickly.
2. **A\* refinement** — if greedy finds a plan, run A* over the graph to
   optimize total latency/cost, using a heuristic of `remaining_steps *
   min_step_latency`. A* prunes plans that exceed the complexity or cost
   budget.

```rust
use std::collections::{HashMap, HashSet, BinaryHeap};

pub struct HeuristicPlanner {
    /// Maximum steps in any plan (complexity budget).
    pub max_steps: usize,
    /// Maximum total cost in micro-USD (cost budget).
    pub max_cost_micro_usd: u64,
    /// Weight for latency vs cost in the A* objective.
    /// 0.0 = cost-only, 1.0 = latency-only.
    pub latency_weight: f64,
}

impl Default for HeuristicPlanner {
    fn default() -> Self {
        Self {
            max_steps: 16,
            max_cost_micro_usd: 1_000_000, // $1.00
            latency_weight: 0.7,
        }
    }
}

/// A* search node. Ordering is by `f = g + h` (min-heap via Reverse).
#[derive(Clone, Debug, PartialEq)]
struct SearchNode {
    /// Steps committed so far.
    steps: Vec<PlannedStep>,
    /// Set of effects currently satisfied (the "state").
    satisfied: HashSet<Effect>,
    /// g: cost so far (weighted latency + cost).
    g: f64,
    /// h: heuristic estimate to goal.
    h: f64,
}

impl Eq for SearchNode {}
impl Ord for SearchNode {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Min-heap: lower f = higher priority.
        (other.g + other.h)
            .partial_cmp(&(self.g + self.h))
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}
impl PartialOrd for SearchNode {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[async_trait::async_trait]
impl CapabilityPlanner for HeuristicPlanner {
    async fn plan(
        &self,
        goal: &CapabilityQuery,
        available: &[SemanticCapability],
    ) -> Result<ExecutionPlan, PlanningError> {
        // Phase 1: greedy forward chaining to find a feasible plan.
        let greedy = self.greedy_plan(goal, available)?;
        if greedy.steps.len() > self.max_steps {
            return Err(PlanningError::ComplexityExceeded { max_steps: self.max_steps });
        }
        if greedy.estimated_total_cost_micro_usd > self.max_cost_micro_usd {
            return Err(PlanningError::CostExceeded {
                budget_micro_usd: self.max_cost_micro_usd,
            });
        }

        // Phase 2: A* refinement to optimize latency/cost.
        let refined = self.astar_refine(goal, available, greedy)?;
        Ok(refined)
    }
}

impl HeuristicPlanner {
    /// Greedy: pick the cheapest capability that satisfies each open
    /// precondition, recursing on its requirements. Detects cycles.
    fn greedy_plan(
        &self,
        goal: &CapabilityQuery,
        available: &[SemanticCapability],
    ) -> Result<ExecutionPlan, PlanningError> {
        let mut steps = Vec::new();
        let mut satisfied: HashSet<Effect> = HashSet::new();
        let mut visiting: HashSet<String> = HashSet::new();
        let goal_effects = goal_to_effects(goal);

        for eff in &goal_effects {
            self.satisfy(eff, available, &mut steps, &mut satisfied, &mut visiting)?;
        }
        Ok(self.finalize(steps))
    }

    fn satisfy(
        &self,
        effect: &Effect,
        available: &[SemanticCapability],
        steps: &mut Vec<PlannedStep>,
        satisfied: &mut HashSet<Effect>,
        visiting: &mut HashSet<String>,
    ) -> Result<(), PlanningError> {
        if satisfied.contains(effect) {
            return Ok(());
        }
        // Find candidates whose provides match this effect.
        let candidates: Vec<_> = available
            .iter()
            .filter(|c| c.provides.iter().any(|o| effect_matches(o, effect)))
            .collect();
        let cap = candidates
            .into_iter()
            .min_by_key(|c| c.cost.per_invocation_micro_usd)
            .ok_or_else(|| PlanningError::MissingCapability(effect.kind.clone()))?;

        if visiting.contains(&cap.name) {
            return Err(PlanningError::CycleDetected { node: cap.name.clone() });
        }
        visiting.insert(cap.name.clone());

        // Recurse on requirements (preconditions).
        let mut depends = Vec::new();
        for req in &cap.requirements {
            let pre = requirement_to_precondition(req);
            let prev_len = steps.len();
            self.satisfy(&pre.effect, available, steps, satisfied, visiting)?;
            // Depend on the last step(s) added for this requirement.
            for i in prev_len..steps.len() {
                depends.push(i);
            }
        }

        let idx = steps.len();
        let step = PlannedStep {
            index: idx,
            capability: cap.clone(),
            agent_id: AgentId::default(), // filled by routing layer
            depends_on: depends,
            preconditions: cap.requirements.iter().map(requirement_to_precondition).collect(),
            effects: cap.provides.iter().map(output_to_effect).collect(),
            estimated_latency_ms: cap.performance.avg_latency_ms,
            estimated_cost_micro_usd: cap.cost.per_invocation_micro_usd,
        };
        for e in &step.effects {
            satisfied.insert(e.clone());
        }
        steps.push(step);
        visiting.remove(&cap.name);
        Ok(())
    }

    /// A* over the graph to optimize the greedy plan. Explores alternative
    /// orderings and alternative capabilities for each step.
    fn astar_refine(
        &self,
        goal: &CapabilityQuery,
        available: &[SemanticCapability],
        greedy: ExecutionPlan,
    ) -> Result<ExecutionPlan, PlanningError> {
        let goal_effects = goal_to_effects(goal);
        let mut open: BinaryHeap<SearchNode> = BinaryHeap::new();
        let mut best = greedy;
        open.push(SearchNode {
            steps: Vec::new(),
            satisfied: HashSet::new(),
            g: 0.0,
            h: self.heuristic(&goal_effects, available),
        });

        while let Some(node) = open.pop() {
            if node.steps.len() > self.max_steps {
                continue;
            }
            if goal_effects.iter().all(|e| node.satisfied.contains(e)) {
                let plan = self.finalize(node.steps);
                if self.objective(&plan) < self.objective(&best) {
                    best = plan;
                }
                continue;
            }
            // Expand: for each open goal effect, try each candidate capability.
            for eff in goal_effects.iter().filter(|e| !node.satisfied.contains(e)) {
                for cap in available.iter().filter(|c| {
                    c.provides.iter().any(|o| effect_matches(o, eff))
                }) {
                    let mut new_steps = node.steps.clone();
                    let mut new_sat = node.satisfied.clone();
                    let idx = new_steps.len();
                    for e in cap.provides.iter().map(output_to_effect) {
                        new_sat.insert(e);
                    }
                    new_steps.push(PlannedStep {
                        index: idx,
                        capability: cap.clone(),
                        agent_id: AgentId::default(),
                        depends_on: (0..idx).collect(),
                        preconditions: cap.requirements.iter().map(requirement_to_precondition).collect(),
                        effects: cap.provides.iter().map(output_to_effect).collect(),
                        estimated_latency_ms: cap.performance.avg_latency_ms,
                        estimated_cost_micro_usd: cap.cost.per_invocation_micro_usd,
                    });
                    let g = self.objective(&self.finalize(new_steps.clone()));
                    open.push(SearchNode {
                        steps: new_steps,
                        satisfied: new_sat,
                        g,
                        h: self.heuristic(&goal_effects, available),
                    });
                }
            }
        }
        Ok(best)
    }

    fn heuristic(&self, goal: &[Effect], available: &[SemanticCapability]) -> f64 {
        let min_lat = available
            .iter()
            .map(|c| c.performance.avg_latency_ms)
            .fold(f64::INFINITY, f64::min);
        goal.len() as f64 * min_lat
    }

    fn objective(&self, plan: &ExecutionPlan) -> f64 {
        let lat = plan.estimated_total_latency_ms;
        let cost = plan.estimated_total_cost_micro_usd as f64;
        self.latency_weight * lat + (1.0 - self.latency_weight) * cost
    }

    fn finalize(&self, steps: Vec<PlannedStep>) -> ExecutionPlan {
        let total_lat: f64 = steps.iter().map(|s| s.estimated_latency_ms).sum();
        let total_cost: u64 = steps.iter().map(|s| s.estimated_cost_micro_usd).sum();
        let agents: HashSet<_> = steps.iter().map(|s| &s.agent_id).collect();
        ExecutionPlan {
            steps,
            estimated_total_latency_ms: total_lat,
            estimated_total_cost_micro_usd: total_cost,
            agent_count: agents.len(),
            complete: true,
        }
    }
}
```

### Part 4: Semantic Descriptors for All 11 Bridge Capabilities

Create a registry module that constructs `SemanticCapability` descriptors for
each well-known capability. These are the canonical descriptors that bridge
agents advertise and that the planner uses.

```rust
use aafp_identity::capability::*;

/// Returns the 11 canonical internet bridge capability descriptors.
/// Bridge agents advertise these (or specializations of them) so that any
/// AAFP agent can discover and plan against the World Perception Layer.
pub fn internet_bridge_capabilities() -> Vec<SemanticCapability> {
    vec![
        search_capability(),
        web_browse_capability(),
        document_read_capability(),
        api_call_capability(),
        api_discover_capability(),
        code_execute_capability(),
        image_ocr_capability(),
        audio_transcribe_capability(),
        crawl_capability(),
        real_time_subscribe_capability(),
        stealth_browse_capability(),
    ]
}

fn search_capability() -> SemanticCapability {
    SemanticCapability {
        name: "search".into(),
        category: CapabilityCategory::InformationRetrieval,
        attributes: CapabilityAttributes {
            languages: vec!["en".into(), "fr".into(), "de".into(), "ja".into()],
            modalities: vec![Modality::Text],
            hardware: vec![],
            frameworks: vec!["brave".into(), "serpapi".into(), "searxng".into()],
            precision: vec![],
            custom: HashMap::from([
                ("query_type".into(), MetadataValue::Text("web".into())),
                ("max_results".into(), MetadataValue::Integer(50)),
                ("freshness".into(), MetadataValue::Text("any|day|week|month|year".into())),
            ]),
        },
        performance: PerformanceProfile {
            avg_latency_ms: 800.0,
            p99_latency_ms: 2500.0,
            throughput_rps: 10.0,
            max_batch_size: Some(1),
        },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "search-results".into(), attributes: HashMap::new() }],
        dependencies: vec![],
        quality: QualityMetrics { trust_score: 90, accuracy: Some(0.95), uptime_pct: 99.5, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 500, per_token_micro_usd: None, has_free_tier: true },
        geo: None,
    }
}

fn web_browse_capability() -> SemanticCapability {
    SemanticCapability {
        name: "web-browse".into(),
        category: CapabilityCategory::Navigation,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text, Modality::Image],
            hardware: vec![],
            frameworks: vec!["firecrawl".into(), "playwright".into()],
            precision: vec![],
            custom: HashMap::from([
                ("javascript_support".into(), MetadataValue::Bool(true)),
                ("wait_strategy".into(), MetadataValue::Text("domcontentloaded|load|networkidle".into())),
                ("format".into(), MetadataValue::Text("agent-native|markdown|html|accessibility".into())),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 2000.0, p99_latency_ms: 8000.0, throughput_rps: 5.0, max_batch_size: Some(1) },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "web-content".into(), attributes: HashMap::new() }],
        dependencies: vec![],
        quality: QualityMetrics { trust_score: 85, accuracy: None, uptime_pct: 99.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 2000, per_token_micro_usd: None, has_free_tier: false },
        geo: None,
    }
}

fn document_read_capability() -> SemanticCapability {
    SemanticCapability {
        name: "document-read".into(),
        category: CapabilityCategory::Parsing,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text],
            hardware: vec![],
            frameworks: vec!["pymupdf".into(), "tika".into(), "python-docx".into()],
            precision: vec![],
            custom: HashMap::from([
                ("formats".into(), MetadataValue::Text("pdf|word|excel|powerpoint".into())),
                ("ocr_support".into(), MetadataValue::Bool(true)),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 3000.0, p99_latency_ms: 15000.0, throughput_rps: 3.0, max_batch_size: Some(1) },
        requirements: vec![
            Requirement { kind: "document-bytes".into(), optional: false },
        ],
        provides: vec![OutputSpec { kind: "document-content".into(), attributes: HashMap::new() }],
        dependencies: vec![
            CapabilityEdge { target: "image-ocr".into(), edge_type: EdgeType::Enables, constraint: Some("if-scanned".into()) },
        ],
        quality: QualityMetrics { trust_score: 88, accuracy: Some(0.92), uptime_pct: 99.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 1000, per_token_micro_usd: None, has_free_tier: true },
        geo: None,
    }
}

fn api_call_capability() -> SemanticCapability {
    SemanticCapability {
        name: "api-call".into(),
        category: CapabilityCategory::Integration,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text],
            hardware: vec![],
            frameworks: vec!["http".into()],
            precision: vec![],
            custom: HashMap::from([
                ("protocols".into(), MetadataValue::Text("rest|graphql|grpc".into())),
                ("auth_methods".into(), MetadataValue::Text("bearer|basic|oauth2|api-key".into())),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 500.0, p99_latency_ms: 5000.0, throughput_rps: 20.0, max_batch_size: Some(1) },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "api-response".into(), attributes: HashMap::new() }],
        dependencies: vec![],
        quality: QualityMetrics { trust_score: 92, accuracy: None, uptime_pct: 99.5, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 100, per_token_micro_usd: None, has_free_tier: true },
        geo: None,
    }
}

fn api_discover_capability() -> SemanticCapability {
    SemanticCapability {
        name: "api-discover".into(),
        category: CapabilityCategory::Integration,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text],
            hardware: vec![],
            frameworks: vec!["openapi".into(), "graphql-schema".into()],
            precision: vec![],
            custom: HashMap::from([
                ("spec_formats".into(), MetadataValue::Text("openapi|graphql-schema".into())),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 1500.0, p99_latency_ms: 6000.0, throughput_rps: 5.0, max_batch_size: Some(1) },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "api-spec".into(), attributes: HashMap::new() }],
        dependencies: vec![
            CapabilityEdge { target: "api-call".into(), edge_type: EdgeType::Precedes, constraint: None },
        ],
        quality: QualityMetrics { trust_score: 80, accuracy: Some(0.85), uptime_pct: 98.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 300, per_token_micro_usd: None, has_free_tier: true },
        geo: None,
    }
}

fn code_execute_capability() -> SemanticCapability {
    SemanticCapability {
        name: "code-execute".into(),
        category: CapabilityCategory::Computation,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text],
            hardware: vec![HardwareSpec::Cpu],
            frameworks: vec!["firecracker".into(), "wasm".into()],
            precision: vec![],
            custom: HashMap::from([
                ("sandbox_type".into(), MetadataValue::Text("firecracker|wasm".into())),
                ("timeout_s".into(), MetadataValue::Integer(30)),
                ("network".into(), MetadataValue::Bool(false)),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 300.0, p99_latency_ms: 30000.0, throughput_rps: 2.0, max_batch_size: Some(1) },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "execution-result".into(), attributes: HashMap::new() }],
        dependencies: vec![],
        quality: QualityMetrics { trust_score: 95, accuracy: None, uptime_pct: 99.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 5000, per_token_micro_usd: None, has_free_tier: false },
        geo: None,
    }
}

fn image_ocr_capability() -> SemanticCapability {
    SemanticCapability {
        name: "image-ocr".into(),
        category: CapabilityCategory::Perception,
        attributes: CapabilityAttributes {
            languages: vec!["en".into(), "fr".into(), "de".into(), "ja".into(), "zh".into()],
            modalities: vec![Modality::Image, Modality::Text],
            hardware: vec![HardwareSpec::Gpu],
            frameworks: vec!["tesseract".into(), "google-vision".into()],
            precision: vec!["FP16".into()],
            custom: HashMap::from([
                ("min_confidence".into(), MetadataValue::Float(0.8)),
                ("gpu_required".into(), MetadataValue::Bool(false)),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 200.0, p99_latency_ms: 2000.0, throughput_rps: 20.0, max_batch_size: Some(32) },
        requirements: vec![Requirement { kind: "image-bytes".into(), optional: false }],
        provides: vec![OutputSpec { kind: "ocr-text".into(), attributes: HashMap::new() }],
        dependencies: vec![],
        quality: QualityMetrics { trust_score: 87, accuracy: Some(0.90), uptime_pct: 99.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 100, per_token_micro_usd: None, has_free_tier: true },
        geo: None,
    }
}

fn audio_transcribe_capability() -> SemanticCapability {
    SemanticCapability {
        name: "audio-transcribe".into(),
        category: CapabilityCategory::Perception,
        attributes: CapabilityAttributes {
            languages: vec!["en".into(), "fr".into(), "de".into(), "ja".into(), "zh".into()],
            modalities: vec![Modality::Audio, Modality::Text],
            hardware: vec![HardwareSpec::Gpu],
            frameworks: vec!["whisper".into(), "deepgram".into()],
            precision: vec!["FP16".into()],
            custom: HashMap::from([
                ("formats".into(), MetadataValue::Text("wav|mp3|flac|ogg".into())),
                ("real_time".into(), MetadataValue::Bool(true)),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 1000.0, p99_latency_ms: 10000.0, throughput_rps: 5.0, max_batch_size: Some(1) },
        requirements: vec![Requirement { kind: "audio-bytes".into(), optional: false }],
        provides: vec![OutputSpec { kind: "transcript".into(), attributes: HashMap::new() }],
        dependencies: vec![],
        quality: QualityMetrics { trust_score: 89, accuracy: Some(0.93), uptime_pct: 99.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 2000, per_token_micro_usd: None, has_free_tier: false },
        geo: None,
    }
}

fn crawl_capability() -> SemanticCapability {
    SemanticCapability {
        name: "crawl".into(),
        category: CapabilityCategory::InformationRetrieval,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text],
            hardware: vec![],
            frameworks: vec!["dht-frontier".into()],
            precision: vec![],
            custom: HashMap::from([
                ("rate_limit_rps".into(), MetadataValue::Float(1.0)),
                ("max_depth".into(), MetadataValue::Integer(10)),
                ("robots_txt".into(), MetadataValue::Bool(true)),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 5000.0, p99_latency_ms: 60000.0, throughput_rps: 1.0, max_batch_size: Some(100) },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "crawled-pages".into(), attributes: HashMap::new() }],
        dependencies: vec![
            CapabilityEdge { target: "web-browse".into(), edge_type: EdgeType::Requires, constraint: None },
        ],
        quality: QualityMetrics { trust_score: 75, accuracy: None, uptime_pct: 95.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 100, per_token_micro_usd: None, has_free_tier: true },
        geo: None,
    }
}

fn real_time_subscribe_capability() -> SemanticCapability {
    SemanticCapability {
        name: "real-time-subscribe".into(),
        category: CapabilityCategory::Streaming,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text],
            hardware: vec![],
            frameworks: vec!["websocket".into(), "sse".into(), "grpc-stream".into()],
            precision: vec![],
            custom: HashMap::from([
                ("protocols".into(), MetadataValue::Text("websocket|sse|grpc-stream".into())),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 100.0, p99_latency_ms: 1000.0, throughput_rps: 100.0, max_batch_size: None },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "event-stream".into(), attributes: HashMap::new() }],
        dependencies: vec![],
        quality: QualityMetrics { trust_score: 85, accuracy: None, uptime_pct: 99.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 50, per_token_micro_usd: None, has_free_tier: true },
        geo: None,
    }
}

fn stealth_browse_capability() -> SemanticCapability {
    SemanticCapability {
        name: "stealth-browse".into(),
        category: CapabilityCategory::Navigation,
        attributes: CapabilityAttributes {
            languages: vec!["*".into()],
            modalities: vec![Modality::Text, Modality::Image],
            hardware: vec![],
            frameworks: vec!["browserless".into(), "bright-data".into()],
            precision: vec![],
            custom: HashMap::from([
                ("proxy_support".into(), MetadataValue::Bool(true)),
                ("captcha_solving".into(), MetadataValue::Bool(true)),
            ]),
        },
        performance: PerformanceProfile { avg_latency_ms: 4000.0, p99_latency_ms: 20000.0, throughput_rps: 2.0, max_batch_size: Some(1) },
        requirements: vec![],
        provides: vec![OutputSpec { kind: "web-content".into(), attributes: HashMap::new() }],
        dependencies: vec![
            CapabilityEdge { target: "web-browse".into(), edge_type: EdgeType::Alternative, constraint: Some("anti-bot".into()) },
        ],
        quality: QualityMetrics { trust_score: 70, accuracy: None, uptime_pct: 90.0, success_count: 0 },
        version: SemanticVersion::new(1, 0, 0),
        cost: CostModel { per_invocation_micro_usd: 10000, per_token_micro_usd: None, has_free_tier: false },
        geo: None,
    }
}
```

### Part 5: Capability Schemas for Bridge Capabilities

Each bridge capability has an input/output schema. Define these as Rust structs
that bridge agents validate against and that the planner can inspect to verify
parameter compatibility. Store them alongside the `SemanticCapability` in a
`BridgeCapabilitySchema`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeCapabilitySchema {
    pub capability_name: String,
    pub input: SchemaRef,
    pub output: SchemaRef,
}

/// A reference to a schema, either inline (CBOR map) or by well-known name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SchemaRef {
    Named(&'static str),       // e.g., "WebContent", "DocumentContent"
    Inline(serde_cbor::Value), // custom schema for niche capabilities
}

pub fn internet_bridge_schemas() -> Vec<BridgeCapabilitySchema> {
    vec![
        BridgeCapabilitySchema {
            capability_name: "search".into(),
            input: SchemaRef::Named("SearchInput"),
            output: SchemaRef::Named("SearchOutput"),
        },
        BridgeCapabilitySchema {
            capability_name: "web-browse".into(),
            input: SchemaRef::Named("BrowseInput"),
            output: SchemaRef::Named("WebContent"),
        },
        BridgeCapabilitySchema {
            capability_name: "document-read".into(),
            input: SchemaRef::Named("DocumentReadInput"),
            output: SchemaRef::Named("DocumentContent"),
        },
        BridgeCapabilitySchema {
            capability_name: "api-call".into(),
            input: SchemaRef::Named("ApiCallInput"),
            output: SchemaRef::Named("ApiResponse"),
        },
        BridgeCapabilitySchema {
            capability_name: "api-discover".into(),
            input: SchemaRef::Named("ApiDiscoverInput"),
            output: SchemaRef::Named("ApiSpec"),
        },
        BridgeCapabilitySchema {
            capability_name: "code-execute".into(),
            input: SchemaRef::Named("CodeExecuteInput"),
            output: SchemaRef::Named("ExecutionResult"),
        },
        BridgeCapabilitySchema {
            capability_name: "image-ocr".into(),
            input: SchemaRef::Named("ImageOcrInput"),
            output: SchemaRef::Named("OcrText"),
        },
        BridgeCapabilitySchema {
            capability_name: "audio-transcribe".into(),
            input: SchemaRef::Named("AudioTranscribeInput"),
            output: SchemaRef::Named("Transcript"),
        },
        BridgeCapabilitySchema {
            capability_name: "crawl".into(),
            input: SchemaRef::Named("CrawlInput"),
            output: SchemaRef::Named("CrawledPages"),
        },
        BridgeCapabilitySchema {
            capability_name: "real-time-subscribe".into(),
            input: SchemaRef::Named("SubscribeInput"),
            output: SchemaRef::Named("EventStream"),
        },
        BridgeCapabilitySchema {
            capability_name: "stealth-browse".into(),
            input: SchemaRef::Named("BrowseInput"),
            output: SchemaRef::Named("WebContent"),
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchInput {
    pub query: String,
    pub num_results: u32,
    pub sources: Vec<String>,
    pub time_range: TimeRange,
    pub fetch_content: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TimeRange { Any, Day, Week, Month, Year }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchOutput {
    pub query: String,
    pub results: Vec<SearchResult>,
    pub total: u32,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub score: f64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseInput {
    pub url: String,
    pub format: BrowseFormat,
    pub wait_for: WaitStrategy,
    pub screenshot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BrowseFormat { AgentNative, Markdown, Html, Accessibility }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WaitStrategy { DomContentLoaded, Load, NetworkIdle }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentReadInput {
    pub source: String,
    pub doc_type: DocType,
    pub ocr: bool,
    pub extract_tables: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DocType { Auto, Pdf, Word, Excel, PowerPoint }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiCallInput {
    pub api_name: String,
    pub method: HttpMethod,
    pub path: String,
    pub body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HttpMethod { Get, Post, Put, Delete, Patch }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeExecuteInput {
    pub code: String,
    pub language: String,
    pub timeout: u32,
    pub network: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageOcrInput {
    pub image_bytes: Vec<u8>,
    pub languages: Vec<String>,
    pub min_confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTranscribeInput {
    pub audio_bytes: Vec<u8>,
    pub format: String,
    pub language: Option<String>,
    pub real_time: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlInput {
    pub seed_urls: Vec<String>,
    pub max_depth: u32,
    pub rate_limit_rps: f64,
    pub respect_robots_txt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribeInput {
    pub url: String,
    pub protocol: StreamProtocol,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamProtocol { WebSocket, Sse, GrpcStream }
```

### Part 6: Integration Tests with Internet Bridge Agents

Create integration tests that spin up stub bridge agents, advertise the 11
canonical capabilities, and run the planner against representative goals.
Tests must run offline (no real network calls).

```rust
// tests/bridge_planning.rs
use aafp_planning::{CapabilityPlanner, HeuristicPlanner, ExecutionPlan};
use aafp_bridge::registry::internet_bridge_capabilities;
use aafp_identity::capability::CapabilityQuery;

#[tokio::test]
async fn plan_search_then_browse() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner::default();
    let goal = CapabilityQuery::new("web-content")
        .build();
    let plan = planner.plan(&goal, &caps).await.unwrap();
    // Expect: search -> web-browse (or just web-browse if URL known).
    assert!(plan.steps.iter().any(|s| s.capability.name == "web-browse"));
    assert!(plan.complete);
}

#[tokio::test]
async fn plan_document_read_with_ocr() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner::default();
    let goal = CapabilityQuery::new("document-content").build();
    let plan = planner.plan(&goal, &caps).await.unwrap();
    // document-read requires document-bytes; image-ocr may be pulled in
    // via the Enables edge for scanned PDFs.
    assert!(plan.steps.iter().any(|s| s.capability.name == "document-read"));
}

#[tokio::test]
async fn plan_api_discover_then_call() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner::default();
    let goal = CapabilityQuery::new("api-response").build();
    let plan = planner.plan(&goal, &caps).await.unwrap();
    // api-discover Precedes api-call.
    let names: Vec<_> = plan.steps.iter().map(|s| s.capability.name.as_str()).collect();
    if names.contains(&"api-discover") {
        let d = names.iter().position(|n| *n == "api-discover").unwrap();
        let c = names.iter().position(|n| *n == "api-call").unwrap();
        assert!(d < c, "api-discover must precede api-call");
    }
}

#[tokio::test]
async fn plan_crawl_includes_browse() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner::default();
    let goal = CapabilityQuery::new("crawled-pages").build();
    let plan = planner.plan(&goal, &caps).await.unwrap();
    // crawl Requires web-browse.
    assert!(plan.steps.iter().any(|s| s.capability.name == "web-browse"));
}

#[tokio::test]
async fn plan_stealth_as_alternative_to_browse() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner::default();
    let goal = CapabilityQuery::new("web-content")
        .with_filter(QueryFilter::Equality {
            key: "captcha_solving".into(),
            value: MetadataValue::Bool(true),
        })
        .build();
    let plan = planner.plan(&goal, &caps).await.unwrap();
    assert!(plan.steps.iter().any(|s| s.capability.name == "stealth-browse"));
}

#[tokio::test]
async fn plan_respects_cost_budget() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner {
        max_cost_micro_usd: 500,
        ..Default::default()
    };
    let goal = CapabilityQuery::new("web-content").build();
    let result = planner.plan(&goal, &caps).await;
    // stealth-browse costs 10000 micro-USD; should be excluded or error.
    assert!(result.is_err() || result.unwrap().estimated_total_cost_micro_usd <= 500);
}

#[tokio::test]
async fn plan_complexity_budget_exceeded() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner { max_steps: 1, ..Default::default() };
    let goal = CapabilityQuery::new("crawled-pages").build();
    let result = planner.plan(&goal, &caps).await;
    assert!(matches!(result, Err(PlanningError::ComplexityExceeded { .. })));
}

#[tokio::test]
async fn all_eleven_capabilities_have_descriptors() {
    let caps = internet_bridge_capabilities();
    assert_eq!(caps.len(), 11);
    for name in &[
        "search", "web-browse", "document-read", "api-call", "api-discover",
        "code-execute", "image-ocr", "audio-transcribe", "crawl",
        "real-time-subscribe", "stealth-browse",
    ] {
        assert!(caps.iter().any(|c| c.name == *name), "missing {}", name);
    }
}

#[tokio::test]
async fn plan_with_routing_metrics_prefers_healthy_agent() {
    let caps = internet_bridge_capabilities();
    let planner = HeuristicPlanner::default();
    // Two web-browse agents: one healthy, one degraded.
    let metrics = vec![
        (AgentId::random(), RoutingMetrics::healthy()),
        (AgentId::random(), RoutingMetrics::degraded()),
    ];
    let goal = CapabilityQuery::new("web-content").build();
    let plan = planner.plan_with_metrics(&goal, &caps, &metrics).await.unwrap();
    assert_eq!(plan.agent_count, 1); // picks the healthy one
}
```

### Part 7: Documentation

Add a module doc comment to the planning crate explaining the planning domain
(states = satisfied effects, actions = capability invocations, goals = desired
outputs) and how the heuristic planner works. Add a README section to the
bridge crate listing all 11 capabilities with their semantic descriptors and
pointing to the schema structs.

## Constraints

1. **No wire protocol changes.** The planner runs locally on the discovering
   agent. It consumes `SemanticCapability` records already retrieved from the
   DHT. No new RPC frame types.

2. **Offline-testable.** All integration tests must run without network
   access. Bridge agents in tests are stubs that return canned content.

3. **Backward compatible.** Agents that do not understand planning continue
   to use `PipelineAssembler` (D4) directly. The planner is an opt-in layer
   on top of the graph.

4. **Budget enforcement.** The planner must reject plans that exceed
   `max_steps` or `max_cost_micro_usd` with the appropriate
   `PlanningError` variant. Never silently produce an over-budget plan.

5. **Cycle detection.** The greedy phase must track the visiting set and
   return `PlanningError::CycleDetected` if a capability depends on itself
   transitively. Do not infinite-loop.

6. **Follow existing conventions.** Check `AGENTS.md`. Use `cargo fmt`,
   `cargo clippy`. No `unwrap()` in non-test code.

## Verification

```bash
cargo fmt --all -- --check
cargo build --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace                          # all existing + new tests pass
cargo test --test bridge_planning               # the 9 integration tests above
cargo run --example plan_demo                   # prints a plan for a sample goal
```

## Files to Modify

| File | Changes |
|------|---------|
| `crates/aafp-planning/src/lib.rs` (new crate or module) | `CapabilityPlanner` trait, `ExecutionPlan`, `PlannedStep`, `Precondition`, `Effect`, `PlanningError` |
| `crates/aafp-planning/src/heuristic.rs` | `HeuristicPlanner` with greedy + A* |
| `crates/aafp-bridge/src/registry.rs` | `internet_bridge_capabilities()`, 11 descriptor constructors |
| `crates/aafp-bridge/src/schemas.rs` | `BridgeCapabilitySchema`, input/output structs for all 11 capabilities |
| `crates/aafp-planning/tests/bridge_planning.rs` | 9 integration tests |
| `examples/plan_demo.rs` | Demo that prints an execution plan for a sample goal |

## Success Criteria

- [ ] `CapabilityPlanner` trait with `plan()` and `plan_with_metrics()`
- [ ] `ExecutionPlan` with steps, estimated latency, estimated cost, agent count, completeness flag
- [ ] `PlannedStep` with preconditions, effects, depends_on, per-step latency/cost
- [ ] `HeuristicPlanner` implementing greedy forward chaining + A* refinement
- [ ] Cycle detection returns `PlanningError::CycleDetected`
- [ ] Complexity and cost budgets enforced
- [ ] Semantic descriptors for all 11 internet bridge capabilities
- [ ] Capability schemas (input/output structs) for all 11 capabilities
- [ ] 9 integration tests pass (search+browse, doc+ocr, api discover+call, crawl+browse, stealth alternative, cost budget, complexity budget, all-11-present, routing metrics)
- [ ] `plan_demo` example prints a human-readable plan
- [ ] All existing tests pass (no regressions)
- [ ] `cargo clippy` clean, `cargo fmt` clean
