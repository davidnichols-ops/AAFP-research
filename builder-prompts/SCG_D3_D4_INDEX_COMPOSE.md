# Builder Prompt: SCG D3-D4 — Local Indexing + Capability Composition

## Objective

Implement Phases D3 and D4 of the Semantic Capability Graphs (Track U) design:
**local secondary indexing** of discovered capabilities and **capability
composition** via graph traversal and pipeline assembly. These two phases
transform the flat string-keyed DHT into a queryable, composable capability
graph that supports rich multi-dimensional queries and automatic pipeline
assembly (e.g., `ocr → document-read → translation → document-write`).

## Context

Read these design documents before starting:
- `SEMANTIC_CAPABILITY_GRAPHS.md` — §5 (DHT Indexing Strategy), §6 (Capability
  Composition), §3 (Semantic Capability Data Model — the `SemanticCapability`,
  `CapabilityEdge`, `EdgeType` definitions referenced below)
- `implementations/rust/crates/aafp-discovery/src/capability_dht.rs` — the
  existing in-memory capability DHT (primary index: `SHA-256(capability_string)`)
- `implementations/rust/crates/aafp-discovery/src/discovery_v1.rs` — the
  RFC-compliant v1 discovery layer (source of `DhtRecord` / lookup results)
- `implementations/rust/crates/aafp-identity/src/identity_v1.rs` —
  `CapabilityDescriptor`, `MetadataValue` (lines 417-549)

Phases D1 (extended `SemanticCapability` struct) and D2 (query builder +
`CapabilityQuery`) are assumed complete. This prompt builds on the types they
introduced: `SemanticCapability`, `CapabilityAttributes`, `PerformanceProfile`,
`QualityMetrics`, `CapabilityQuery`, `QueryFilter`, `Modality`, and
`CapabilityCategory`. If any of those are not yet present, stub minimal versions
in a `semantic` module of `aafp-discovery` so D3-D4 can proceed independently.

## What to Build

### Part 1: CapabilityIndex with Secondary Indexes (§5.2)

Create `crates/aafp-discovery/src/capability_index.rs`. The index is built
**locally** by each discovering agent from DHT discovery results — the DHT
itself remains keyed only by capability name (backward compatible). The index
holds `SemanticCapability` records (which wrap an `AgentId` so the discovering
agent knows *who* provides each capability).

```rust
//! Local secondary indexes over discovered semantic capabilities.
//!
//! Built from DHT lookup results; the DHT itself stays simple (keyed by
//! capability name). All multi-dimensional filtering happens here.

use crate::semantic::{
    CapabilityCategory, CapabilityQuery, Modality, QueryFilter, SemanticCapability,
};
use aafp_identity::AgentId;
use ordered_float::OrderedFloat;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

/// A discovered capability record: the semantic descriptor plus the agent
/// that provides it and when the index entry was created (for TTL eviction).
#[derive(Clone, Debug)]
pub struct IndexedCapability {
    pub capability: SemanticCapability,
    pub agent_id: AgentId,
    pub inserted_at: Instant,
}

/// Local multi-dimensional index over discovered capabilities.
///
/// Primary index is by capability name (mirrors the DHT key). Secondary
/// indexes accelerate the common filter dimensions: language, modality,
/// latency (range queries via BTreeMap), and trust score (range queries
/// via BTreeMap). Each secondary index maps an attribute value to the set
/// of capability *names* that carry it; the names resolve back to records
/// in `by_name`, avoiding duplicated `SemanticCapability` storage.
pub struct CapabilityIndex {
    /// name → indexed records (one name may have multiple providers)
    by_name: HashMap<String, Vec<IndexedCapability>>,

    /// language → set of capability names that support it
    by_language: HashMap<String, HashSet<String>>,

    /// modality → set of capability names that support it
    by_modality: HashMap<Modality, HashSet<String>>,

    /// avg_latency_ms (ordered) → set of capability names
    by_latency: BTreeMap<OrderedFloat<f64>, HashSet<String>>,

    /// trust_score → set of capability names
    by_trust: BTreeMap<u8, HashSet<String>>,

    /// Total record count (sum of by_name vec lengths).
    len: usize,

    /// Eviction configuration.
    config: IndexConfig,
}

/// Eviction / sizing policy for the local index.
#[derive(Clone, Debug)]
pub struct IndexConfig {
    /// Records older than this are evicted on `evict_expired()`.
    pub ttl: Duration,
    /// Hard cap on total records; `insert()` evicts oldest when exceeded.
    pub max_size: usize,
}

impl Default for IndexConfig {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(300), // 5 minutes
            max_size: 10_000,
        }
    }
}
```

**Index construction** — `insert()` updates every secondary index atomically.
`insert_batch()` ingests a `Vec<IndexedCapability>` (typically the result of a
DHT lookup round) and rebuilds secondary indexes in bulk for efficiency:

```rust
impl CapabilityIndex {
    pub fn new() -> Self { /* empty indexes, default config */ }
    pub fn with_config(config: IndexConfig) -> Self { /* ... */ }

    /// Insert a single discovered capability, updating all secondary indexes.
    /// If `max_size` is exceeded after insert, evict the oldest records.
    pub fn insert(&mut self, record: IndexedCapability) { /* ... */ }

    /// Bulk-insert from a DHT discovery round. More efficient than repeated
    /// `insert()` because secondary indexes are rebuilt once at the end.
    pub fn insert_batch(&mut self, records: Vec<IndexedCapability>) { /* ... */ }

    /// Look up all records for a capability name.
    pub fn get_by_name(&self, name: &str) -> &[IndexedCapability] { /* ... */ }

    /// All records supporting a given language.
    pub fn get_by_language(&self, lang: &str) -> Vec<&IndexedCapability> { /* ... */ }

    /// All records supporting a given modality.
    pub fn get_by_modality(&self, m: &Modality) -> Vec<&IndexedCapability> { /* ... */ }

    /// Records with avg_latency_ms <= `max_ms` (BTreeMap range scan).
    pub fn get_by_latency_max(&self, max_ms: f64) -> Vec<&IndexedCapability> { /* ... */ }

    /// Records with trust_score >= `min` (BTreeMap range scan).
    pub fn get_by_trust_min(&self, min: u8) -> Vec<&IndexedCapability> { /* ... */ }

    /// Evaluate a `CapabilityQuery` against the index, using secondary indexes
    /// to prune candidates before applying full per-record filter evaluation.
    /// Returns matching records ranked by match score (descending).
    pub fn query(&self, q: &CapabilityQuery) -> Vec<&IndexedCapability> { /* ... */ }

    /// Remove records older than `config.ttl`. Returns count evicted.
    pub fn evict_expired(&mut self) -> usize { /* ... */ }

    /// Evict oldest records until `len <= config.max_size`.
    fn evict_oldest(&mut self) { /* ... */ }

    /// Remove a specific (agent_id, capability name) entry and update indexes.
    pub fn remove(&mut self, agent_id: &AgentId, name: &str) { /* ... */ }

    pub fn len(&self) -> usize { self.len }
    pub fn is_empty(&self) -> bool { self.len == 0 }
}
```

**Eviction policies** — two complementary mechanisms:
1. **TTL**: `evict_expired()` walks `by_name` and drops entries whose
   `inserted_at + config.ttl < now`. Call this on a periodic timer (e.g.,
   every 60s) in the discovering agent's runtime. After removing a record,
   prune its name from every secondary index set; drop the name from a
   secondary index entirely when its set becomes empty.
2. **Max size**: when `insert()` would push `len` above `max_size`, call
   `evict_oldest()` which removes the globally-oldest `IndexedCapability`
   (track insertion order via the `inserted_at` timestamp; ties broken by
   agent_id for determinism). This bounds memory regardless of DHT churn.

**Query evaluation strategy** — `query()` should:
1. Start from `by_name[q.name]` (the primary index — always required).
2. For each `QueryFilter`, intersect with the relevant secondary index where
   applicable (`Equality` on language → `by_language`; `In` on language →
   union of `by_language` entries; `Range` on latency → `by_latency` range
   scan; quality filter → `by_trust` range scan). For filters with no
   secondary index (e.g., `Exists`, `SemanticMatch`, custom attributes),
   fall through to per-record evaluation.
3. Apply remaining filters (performance, quality, cost, geo, version) as
   per-record predicates on the pruned candidate set.
4. Score survivors with `query.match_score()` (from D2) and sort descending.

### Part 2: CapabilityGraph Data Structure (§6.1)

Create `crates/aafp-discovery/src/capability_graph.rs`. The graph is the
substrate for pipeline assembly: nodes are `SemanticCapability` records and
edges are `CapabilityEdge` (defined in §3.1, re-exported from the `semantic`
module). Edges are **directed** and typed.

```rust
//! Directed graph of capabilities and their composition edges.

use crate::semantic::{CapabilityEdge, EdgeType, SemanticCapability};
use aafp_identity::AgentId;
use std::collections::{HashMap, HashSet};

/// A node in the capability graph: a capability offered by a specific agent.
#[derive(Clone, Debug)]
pub struct CapabilityNode {
    pub capability: SemanticCapability,
    pub agent_id: AgentId,
}

/// The capability graph. Nodes are keyed by capability name (multiple agents
/// may offer the same capability → multiple nodes per name). Edges are stored
/// as an adjacency list keyed by source capability name.
pub struct CapabilityGraph {
    /// capability name → nodes (one per provider)
    nodes: HashMap<String, Vec<CapabilityNode>>,
    /// source capability name → outgoing edges
    edges: HashMap<String, Vec<CapabilityEdge>>,
    /// Reverse adjacency for traversal: target name → incoming source names
    /// (used for requirement resolution and topological sort).
    reverse_edges: HashMap<String, Vec<String>>,
}

impl CapabilityGraph {
    pub fn new() -> Self { /* ... */ }

    /// Add a capability node (a provider of `name`).
    pub fn add_node(&mut self, node: CapabilityNode) { /* ... */ }

    /// Add an outgoing edge from `source` capability. Updates `reverse_edges`.
    pub fn add_edge(&mut self, source: &str, edge: CapabilityEdge) { /* ... */ }

    /// All nodes for a capability name.
    pub fn get_nodes(&self, name: &str) -> &[CapabilityNode] { /* ... */ }

    /// Outgoing edges of a capability.
    pub fn get_edges(&self, name: &str) -> &[CapabilityEdge] { /* ... */ }

    /// Edges of a specific type from a capability (e.g., all `Requires`).
    pub fn edges_of_type(&self, name: &str, et: EdgeType) -> Vec<&CapabilityEdge> { /* ... */ }

    /// Query the graph for nodes matching a `CapabilityQuery` (delegates to
    /// an injected `CapabilityIndex` or does per-node evaluation).
    pub fn query<'a>(&'a self, q: &CapabilityQuery, index: &'a CapabilityIndex)
        -> Vec<&'a CapabilityNode> { /* ... */ }

    /// Total node count.
    pub fn node_count(&self) -> usize { /* ... */ }
    /// Total edge count.
    pub fn edge_count(&self) -> usize { /* ... */ }
}
```

**EdgeType enum** — reuse the definition from §3.1 (D1). It must be `Clone,
Copy, Debug, PartialEq, Eq, Hash`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EdgeType {
    /// This capability requires the target to function (hard dependency).
    Requires,
    /// This capability is enhanced by the target (soft dependency).
    Enables,
    /// This capability should run before the target (pipeline ordering).
    Precedes,
    /// This capability is an alternative to the target (failover).
    Alternative,
    /// This capability is a specialization of the target.
    Specializes,
}
```

### Part 3: PipelineAssembler with Graph Traversal (§6.1)

Create `crates/aafp-discovery/src/pipeline_assembler.rs`. The assembler takes
a goal expressed as a `CapabilityQuery` and returns an ordered
`Vec<PipelineStep>` by traversing the `CapabilityGraph`:

1. **Find candidates** matching the goal (`graph.query(goal, index)`).
2. **Resolve requirements** — for each candidate, follow `Requires` edges
   recursively. Each required capability becomes an earlier pipeline step.
   Detect cycles (a `Requires` cycle is a malformed graph → return
   `PipelineError::CycleDetected`). Limit recursion depth (default 16) to
   bound traversal.
3. **Topological sort** — order steps using `Precedes` edges. A `Precedes`
   edge `A → B` means A must run before B. Combine with `Requires` edges
   (a requirement must run before the dependent). Use Kahn's algorithm;
   if the combined edge set has a cycle, return `CycleDetected`.
4. **Materialize** — assign each step an index and populate `depends_on`
   with the indices of steps it directly depends on (from `Requires` and
   `Precedes` edges).

```rust
//! Assemble execution pipelines from the capability graph.

use crate::capability_graph::{CapabilityGraph, CapabilityNode};
use crate::capability_index::CapabilityIndex;
use crate::semantic::{CapabilityQuery, EdgeType};
use aafp_identity::AgentId;
use std::collections::{HashMap, HashSet, VecDeque};
use thiserror::Error;

/// A single step in an assembled pipeline.
#[derive(Clone, Debug)]
pub struct PipelineStep {
    /// The capability to invoke at this step.
    pub capability_name: String,
    /// The agent that will execute this step.
    pub agent_id: AgentId,
    /// Indices of prior steps this step depends on (from Requires/Precedes).
    pub depends_on: Vec<usize>,
    /// Position in the pipeline (0-based, topologically ordered).
    pub order: usize,
}

/// An assembled pipeline: ordered steps with dependency links.
#[derive(Clone, Debug)]
pub struct Pipeline {
    pub steps: Vec<PipelineStep>,
    /// Sum of avg_latency_ms across steps (rough estimate).
    pub estimated_latency_ms: f64,
}

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error("no capability satisfies the goal: {0}")]
    NoCandidate(String),
    #[error("requirement not satisfiable: capability '{0}' has no providers")]
    UnresolvedRequirement(String),
    #[error("cycle detected in capability graph at '{0}'")]
    CycleDetected(String),
    #[error("recursion depth exceeded ({0})")]
    DepthExceeded(usize),
}

pub struct PipelineAssembler {
    graph: CapabilityGraph,
    index: CapabilityIndex,
    max_depth: usize,
}

impl PipelineAssembler {
    pub fn new(graph: CapabilityGraph, index: CapabilityIndex) -> Self {
        Self { graph, index, max_depth: 16 }
    }
    pub fn with_max_depth(mut self, d: usize) -> Self { self.max_depth = d; self }

    /// Find a pipeline that satisfies `goal`.
    ///
    /// Algorithm:
    ///  1. Query the graph for goal candidates.
    ///  2. Recursively resolve `Requires` edges, collecting all needed
    ///     capabilities (visited set prevents cycles).
    ///  3. Build a combined precedence relation from `Requires` + `Precedes`
    ///     edges among the collected capabilities.
    ///  4. Topologically sort (Kahn's algorithm); detect cycles.
    ///  5. Pick a provider (node) for each capability (highest trust first).
    ///  6. Materialize `PipelineStep`s with `depends_on` indices.
    pub fn find_pipeline(&self, goal: &CapabilityQuery) -> Result<Pipeline, PipelineError> {
        // 1. Candidates for the goal.
        let candidates = self.graph.query(goal, &self.index);
        let goal_node = candidates.first().ok_or_else(|| {
            PipelineError::NoCandidate(goal.name.clone())
        })?;

        // 2. Recursively collect required capabilities (BFS over Requires).
        //    `collected` maps capability name → the chosen CapabilityNode.
        let mut collected: HashMap<String, &CapabilityNode> = HashMap::new();
        collected.insert(goal_node.capability.name.clone(), goal_node);
        let mut queue: VecDeque<(String, usize)> =
            VecDeque::from([(goal_node.capability.name.clone(), 0)]);
        let mut visited: HashSet<String> = HashSet::new();
        while let Some((name, depth)) = queue.pop_front() {
            if depth >= self.max_depth {
                return Err(PipelineError::DepthExceeded(self.max_depth));
            }
            if !visited.insert(name.clone()) {
                return Err(PipelineError::CycleDetected(name));
            }
            for edge in self.graph.edges_of_type(&name, EdgeType::Requires) {
                let target = &edge.target;
                if collected.contains_key(target) {
                    continue;
                }
                let nodes = self.graph.get_nodes(target);
                if nodes.is_empty() {
                    return Err(PipelineError::UnresolvedRequirement(target.clone()));
                }
                // Pick highest-trust provider.
                let best = nodes.iter()
                    .max_by_key(|n| n.capability.quality.trust_score)
                    .unwrap();
                collected.insert(target.clone(), best);
                queue.push_back((target.clone(), depth + 1));
            }
        }

        // 3. Build precedence relation: A must come before B if B Requires A,
        //    or A Precedes B. Represent as adjacency: before → set(afters).
        let mut before: HashMap<String, HashSet<String>> = HashMap::new();
        let mut in_degree: HashMap<String, usize> = HashMap::new();
        for name in collected.keys() {
            in_degree.entry(name.clone()).or_insert(0);
            for edge in self.graph.get_edges(name) {
                if !collected.contains_key(&edge.target) {
                    continue;
                }
                let must_precede = matches!(edge.edge_type, EdgeType::Requires | EdgeType::Precedes);
                if must_precede {
                    // `name` must run before `edge.target`.
                    before.entry(name.clone()).or_default().insert(edge.target.clone());
                    *in_degree.entry(edge.target.clone()).or_insert(0) += 1;
                }
            }
        }

        // 4. Kahn's topological sort.
        let mut order: Vec<String> = Vec::with_capacity(collected.len());
        let mut ready: VecDeque<String> = in_degree.iter()
            .filter(|(_, &d)| d == 0)
            .map(|(k, _)| k.clone())
            .collect();
        // Deterministic ordering: sort ready queue by capability name.
        let mut ready: Vec<String> = ready.drain(..).collect();
        ready.sort();
        let mut ready: VecDeque<String> = ready.into();
        while let Some(name) = ready.pop_front() {
            order.push(name.clone());
            if let Some(afters) = before.get(&name) {
                for after in afters {
                    let d = in_degree.get_mut(after).unwrap();
                    *d -= 1;
                    if *d == 0 { ready.push_back(after.clone()); }
                }
                // Keep deterministic.
                let mut v: Vec<String> = ready.drain(..).collect();
                v.sort();
                ready = v.into();
            }
        }
        if order.len() != collected.len() {
            return Err(PipelineError::CycleDetected(goal.name.clone()));
        }

        // 5. Materialize steps with depends_on.
        let mut steps: Vec<PipelineStep> = Vec::new();
        let mut name_to_index: HashMap<String, usize> = HashMap::new();
        let mut total_latency = 0.0f64;
        for (i, name) in order.iter().enumerate() {
            let node = collected[name];
            let mut deps: Vec<usize> = Vec::new();
            for edge in self.graph.get_edges(name) {
                if matches!(edge.edge_type, EdgeType::Requires | EdgeType::Precedes) {
                    if let Some(&idx) = name_to_index.get(&edge.target) {
                        // target is a *predecessor*? No — `name` precedes target.
                        // Actually depends_on should point to steps that must
                        // complete *before* this one. Re-derive from `before`.
                    }
                }
            }
            // depends_on = all capabilities that precede `name`.
            for (before_name, afters) in &before {
                if afters.contains(name) {
                    if let Some(&idx) = name_to_index.get(before_name) {
                        deps.push(idx);
                    }
                }
            }
            deps.sort();
            total_latency += node.capability.performance.avg_latency_ms;
            name_to_index.insert(name.clone(), i);
            steps.push(PipelineStep {
                capability_name: name.clone(),
                agent_id: node.agent_id,
                depends_on: deps,
                order: i,
            });
        }

        Ok(Pipeline { steps, estimated_latency_ms: total_latency })
    }
}
```

> **Note on `depends_on` semantics**: `depends_on[i]` lists step indices that
> must complete *before* step `i` runs. These are derived from the `before`
> relation built in step 3: if `A` precedes `B`, then `B.depends_on` includes
> A's index. The illustrative code above shows the intended structure; the
> builder should clean up the redundant inner loop and derive `depends_on`
> directly from `before` (iterate `before`, and for each `(predecessor, afters)`
> add predecessor's index to each after's `depends_on`).

### Part 4: Topological Sort Correctness

The topological sort must be **deterministic** (stable ordering for identical
inputs) — sort the ready queue by capability name on each iteration as shown.
This makes pipeline assembly reproducible across agents, which matters for
testing and for distributed consensus on pipeline structure.

Handle these edge cases explicitly:
- **Self-loop** (`A Requires A`): detected by the `visited` set in the
  requirement-resolution BFS → `CycleDetected`.
- **Mutual requirement** (`A Requires B`, `B Requires A`): the BFS `visited`
  set catches the second visit → `CycleDetected`.
- **Precedes-only cycle** (`A Precedes B`, `B Precedes A`): caught by Kahn's
  algorithm — `order.len() != collected.len()` → `CycleDetected`.
- **Diamond dependency** (`A Requires B`, `A Requires C`, `B Precedes C`):
  valid; sort yields `B, C, A` (or `C, B, A` depending on edges; ties broken
  by name). `A.depends_on = [B_idx, C_idx]`.
- **Disconnected components**: if the goal resolves to a single capability
  with no requirements, the pipeline is a single step with empty `depends_on`.

### Part 5: Module Wiring

In `crates/aafp-discovery/src/lib.rs`, add:

```rust
pub mod capability_index;
pub mod capability_graph;
pub mod pipeline_assembler;

pub use capability_index::{CapabilityIndex, IndexedCapability, IndexConfig};
pub use capability_graph::{CapabilityGraph, CapabilityNode};
pub use pipeline_assembler::{Pipeline, PipelineAssembler, PipelineError, PipelineStep};
```

Add `ordered-float = "4"` to `crates/aafp-discovery/Cargo.toml` `[dependencies]`
(needed for `BTreeMap<OrderedFloat<f64>, _>` — `f64` is not `Ord`).

If the `semantic` module (D1/D2 types) does not yet exist in
`aafp-discovery`, create `crates/aafp-discovery/src/semantic.rs` with the
minimal type definitions from §3 (`SemanticCapability`, `CapabilityAttributes`,
`PerformanceProfile`, `QualityMetrics`, `CapabilityEdge`, `EdgeType`,
`CapabilityQuery`, `QueryFilter`, `Modality`, `CapabilityCategory`) and
`pub mod semantic;` in `lib.rs`. Mark this clearly so D1/D2 can later replace
the stub with the full implementation.

## Unit Tests

Add tests in each new module's `#[cfg(test)] mod tests`. Target ≥30 new tests.

### capability_index tests

- `insert_and_get_by_name` — insert one record, retrieve by name.
- `secondary_index_language` — insert records with different languages,
  verify `get_by_language` returns the right subset.
- `secondary_index_modality` — same for `Modality::Image` / `Text`.
- `secondary_index_latency_range` — insert records with latencies
  {10, 20, 30, 40} ms; `get_by_latency_max(25.0)` returns the 10 and 20.
- `secondary_index_trust_range` — trust scores {80, 90, 95, 99};
  `get_by_trust_min(95)` returns the 95 and 99.
- `query_uses_secondary_index` — construct a `CapabilityQuery` with a
  language filter + latency range + trust min; verify the result set is the
  intersection and is sorted by match score descending.
- `evict_expired` — insert records with `inserted_at` in the past, call
  `evict_expired()`, verify they are gone from `by_name` *and* from all
  secondary indexes (no dangling name entries).
- `evict_oldest_on_max_size` — set `max_size = 3`, insert 5 records,
  verify `len() == 3` and the 2 oldest are gone.
- `remove_updates_secondary_indexes` — insert a record, `remove()` it,
  verify its name is gone from `by_language` / `by_latency` / `by_trust`.
- `insert_batch` — bulk insert 100 records, verify `len()` and that
  secondary indexes are consistent with per-record `get_by_*`.
- `duplicate_provider` — two agents offering the same capability name;
  `get_by_name` returns both.

### capability_graph tests

- `add_node_and_retrieve` — add a node, `get_nodes` returns it.
- `add_edge_updates_reverse` — add edge `A → B`, verify `reverse_edges[B]`
  contains `A`.
- `edges_of_type` — add `Requires` and `Precedes` edges from A;
  `edges_of_type(A, Requires)` returns only the Requires edge.
- `multiple_providers_per_name` — two nodes for "ocr"; `get_nodes("ocr")`
  returns both; `node_count` counts both.
- `query_delegates_to_index` — add nodes, query, verify results match the
  index's `query()` output.

### pipeline_assembler tests

- `single_step_pipeline` — goal with no requirements → 1 step, empty
  `depends_on`, `order == 0`.
- `linear_pipeline` — graph `ocr Requires document-read Requires translation`;
  `find_pipeline(translation)` returns 3 steps in order
  `[ocr, document-read, translation]` with correct `depends_on`.
- `diamond_dependency` — `A Requires B`, `A Requires C`, `B Precedes C`;
  verify `A.depends_on == [B, C]` (by index) and order is `B, C, A`.
- `precedes_ordering` — `A Precedes B`, `B Precedes C`; pipeline for C
  yields `[A, B, C]`.
- `cycle_detected_requires` — `A Requires B`, `B Requires A` →
  `Err(CycleDetected)`.
- `cycle_detected_precedes` — `A Precedes B`, `B Precedes A` →
  `Err(CycleDetected)`.
- `unresolved_requirement` — goal requires "nonexistent" capability with no
  nodes → `Err(UnresolvedRequirement)`.
- `no_candidate_for_goal` — query for a capability not in the graph →
  `Err(NoCandidate)`.
- `depth_exceeded` — chain of 20 Requires with `max_depth = 16` →
  `Err(DepthExceeded)`.
- `highest_trust_provider_selected` — two providers for a required
  capability with trust 80 and 99; verify the chosen `agent_id` is the 99.
- `estimated_latency` — pipeline with 3 steps of latency {10, 20, 30};
  `estimated_latency_ms == 60.0`.
- `deterministic_ordering` — run `find_pipeline` twice on the same graph;
  assert the two `Pipeline`s are equal (same step order and depends_on).
- `alternative_edge_not_in_pipeline` — `A Alternative B` should *not*
  create a precedence constraint; pipeline for A does not include B unless
  B is separately required.

### Integration-style test

- `document_translation_pipeline` — build the example from §6.2:
  `translation` (en→fr) `Requires document-read` `Requires document-write`;
  `document-read` `Requires ocr`. Assemble pipeline for the translation
  goal. Assert the order is `[ocr, document-read, translation,
  document-write]` and each step's `depends_on` is correct (ocr has none;
  document-read depends on ocr; translation depends on document-read;
  document-write depends on translation).

## Constraints

1. **No DHT wire-protocol changes.** The DHT remains keyed by
   `SHA-256(capability_name)`. Secondary indexes are purely local to the
   discovering agent. This preserves backward compatibility with existing
   `capability_dht.rs` and `discovery_v1.rs`.

2. **Reuse D1/D2 types.** `SemanticCapability`, `CapabilityEdge`, `EdgeType`,
   `CapabilityQuery`, `QueryFilter`, `Modality`, `CapabilityCategory` come
   from the `semantic` module (D1/D2). Do not redefine them in the index or
   graph modules. If D1/D2 are not yet implemented, create a minimal `semantic`
   stub module and clearly mark it for replacement.

3. **No `f64` as a BTreeMap key.** Use `OrderedFloat<f64>` from the
   `ordered-float` crate for `by_latency`. Add the dependency to `Cargo.toml`.

4. **Deterministic results.** Pipeline assembly and query ranking must be
   deterministic for identical inputs (sort tie-breakers by name / agent_id).
   This is required for test stability and distributed consensus.

5. **Bounded resource use.** The index must enforce `max_size` and TTL
   eviction. Pipeline traversal must enforce `max_depth`. No unbounded
   recursion or unbounded memory growth.

6. **Follow existing conventions.** Check `AGENTS.md` for build/test
   commands. Use `cargo fmt --all -- --check`, `cargo clippy --workspace`,
   `cargo test --workspace`. Zero warnings expected.

## Verification

```bash
cargo fmt --all -- --check   # 0 diffs
cargo build --workspace       # 0 errors, 0 warnings
cargo clippy --workspace      # 0 warnings
cargo test --workspace        # all pass, ≥30 new tests added
```

Specifically:
```bash
cargo test -p aafp-discovery capability_index
cargo test -p aafp-discovery capability_graph
cargo test -p aafp-discovery pipeline_assembler
```

## Files to Create / Modify

| File | Action | Changes |
|------|--------|---------|
| `crates/aafp-discovery/src/capability_index.rs` | Create | `CapabilityIndex`, `IndexedCapability`, `IndexConfig`, secondary indexes, eviction, `query()` |
| `crates/aafp-discovery/src/capability_graph.rs` | Create | `CapabilityGraph`, `CapabilityNode`, adjacency + reverse adjacency, `edges_of_type` |
| `crates/aafp-discovery/src/pipeline_assembler.rs` | Create | `PipelineAssembler`, `Pipeline`, `PipelineStep`, `PipelineError`, `find_pipeline()`, topological sort |
| `crates/aafp-discovery/src/semantic.rs` | Create (if D1/D2 absent) | Minimal stub types: `SemanticCapability`, `CapabilityEdge`, `EdgeType`, `CapabilityQuery`, etc. |
| `crates/aafp-discovery/src/lib.rs` | Modify | `pub mod` + `pub use` for new modules |
| `crates/aafp-discovery/Cargo.toml` | Modify | Add `ordered-float = "4"` |

## Success Criteria

- [ ] `CapabilityIndex` with `by_name`, `by_language`, `by_modality`,
      `by_latency` (BTreeMap), `by_trust` (BTreeMap) secondary indexes
- [ ] `insert()`, `insert_batch()`, `get_by_*` accessors for each index
- [ ] `query()` evaluates `CapabilityQuery` using secondary indexes for
      pruning, then per-record filters, ranked by match score
- [ ] TTL eviction (`evict_expired()`) removes expired records from primary
      *and* all secondary indexes
- [ ] Max-size eviction (`evict_oldest()`) triggered on `insert()` overflow
- [ ] `CapabilityGraph` with nodes (capability name → multiple providers),
      edges (adjacency list), and reverse adjacency
- [ ] `EdgeType` enum with `Requires`, `Enables`, `Precedes`, `Alternative`,
      `Specializes` (reused from D1 or stubbed)
- [ ] `PipelineAssembler::find_pipeline()` — graph traversal, recursive
      requirement resolution, cycle detection, depth limit
- [ ] Topological sort via Kahn's algorithm using `Requires` + `Precedes`
      edges, deterministic ordering (name-sorted ready queue)
- [ ] `PipelineStep` with `capability_name`, `agent_id`, `depends_on`
      (indices of predecessor steps), `order`
- [ ] `PipelineError` variants: `NoCandidate`, `UnresolvedRequirement`,
      `CycleDetected`, `DepthExceeded`
- [ ] Highest-trust provider selected for each required capability
- [ ] `estimated_latency_ms` summed across steps
- [ ] ≥30 unit tests covering indexing, graph traversal, pipeline assembly
- [ ] Document translation pipeline integration test (§6.2 example)
- [ ] `cargo fmt`, `cargo clippy`, `cargo test --workspace` all clean
