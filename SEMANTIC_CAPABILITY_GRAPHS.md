# Semantic Capability Graphs (Track U) — Design Document

**Status:** Design Document (Summary from research agent cfd11e7a)
**Track:** U — Future Strategic
**Date:** 2025-01-15

## Executive Summary

The current AAFP discovery system uses string-keyed DHT lookups where capabilities are simple strings like "inference" or "translation". This design proposes replacing flat string lookups with **semantic capability graphs** — structured, multi-dimensional descriptions of agent capabilities that support rich queries, composition, and planning. The goal is to enable queries like:

> Need: OCR + English + under 40ms + GPU + trust >95% + <$0.0001 + CoreML + North America + version >=4.1

---

## 1. Current State Analysis

### 1.1 String-Based Discovery

**File**: `crates/aafp-discovery/src/capability_dht.rs`

- **Data structure**: `HashMap<DhtKey, Vec<DhtRecord>>` where `DhtKey = SHA-256(capability_string)`
- **Lookup**: Exact string match only
- **Limitations**: No semantic metadata, no multi-dimensional queries, no composition support, no performance/quality attributes

### 1.2 Existing CapabilityDescriptor

**File**: `crates/aafp-identity/src/identity_v1.rs` (lines 417-549)

The `CapabilityDescriptor` already has a `name` and `metadata` field (key-value pairs with `MetadataValue` enum). This is **already extensible** but currently used minimally — not for semantic discovery.

### 1.3 Strategic Vision

**File**: `STRATEGIC_VISION.md` (lines 258-286)

The vision describes capability chains like:
```
RTX5090 -> CUDA -> TensorRT -> YOLO11 -> FP8 -> Batch=32 -> 8GB VRAM free -> 14ms avg latency
```

### 1.4 Internet Bridge Capabilities

**File**: `INTERNET_BRIDGE_PLAN.md` (lines 45-56)

Well-known capabilities: search, web-browse, document-read, api-call, api-discover, code-execute, image-ocr, audio-transcribe, crawl, real-time-subscribe, stealth-browse. Each has different parameters, performance characteristics, and requirements that need semantic description.

---

## 2. Research on Existing Systems

| System | Approach | Limitations |
|--------|----------|-------------|
| **Kubernetes Labels/Selectors** | Equality + set-based filtering | Flat key-value, no hierarchy |
| **Consul Service Discovery** | Tags + meta (max 64 pairs) + prepared queries | No semantic reasoning |
| **LDAP/X.500** | Attribute-value pairs with OIDs | Hierarchical but not graph-based |
| **UDDI** | XML registry with tModels | Deprecated, heavyweight |
| **SPARQL/RDF/OWL-S** | Rich semantic descriptions with ontology reasoning | Complex, heavyweight, not real-time |
| **Wunderland** | Capability discovery with semantic search + graph re-ranking | Modern but proprietary |
| **DALIA** | Declarative agentic layer with capability ontology | Research-stage |
| **Agent Capability Standard** | 9 cognitive layers, 7 edge types for dependencies | Emerging standard |
| **OntoProcap** | OWL ontology for process capabilities | Academic |

**Key Insight**: Full OWL/RDF is too heavyweight for real-time agent discovery. A lightweight ontology with structured CBOR encoding is the right approach.

---

## 3. Semantic Capability Data Model

### 3.1 Extended CapabilityDescriptor

```rust
pub struct SemanticCapability {
    /// Base capability name (backward compat with string-based discovery)
    pub name: String,

    /// Semantic category (e.g., "inference", "translation", "ocr")
    pub category: CapabilityCategory,

    /// Structured attributes for multi-dimensional queries
    pub attributes: CapabilityAttributes,

    /// Performance characteristics
    pub performance: PerformanceProfile,

    /// Requirements (what this capability needs to function)
    pub requirements: Vec<Requirement>,

    /// What this capability provides (outputs)
    pub provides: Vec<OutputSpec>,

    /// Dependencies on other capabilities (edges in the graph)
    pub dependencies: Vec<CapabilityEdge>,

    /// Quality/trust metrics
    pub quality: QualityMetrics,

    /// Semantic version for compatibility
    pub version: SemanticVersion,

    /// Cost model
    pub cost: CostModel,

    /// Geographic constraints
    pub geo: Option<GeoConstraint>,
}

pub struct CapabilityAttributes {
    /// Supported languages (for translation, OCR, etc.)
    pub languages: Vec<String>,

    /// Supported modalities (text, image, audio, video)
    pub modalities: Vec<Modality>,

    /// Hardware requirements (GPU, CPU, TPU, NPU)
    pub hardware: Vec<HardwareSpec>,

    /// Software frameworks (CUDA, TensorRT, CoreML, ONNX)
    pub frameworks: Vec<String>,

    /// Precision modes (FP32, FP16, FP8, INT8)
    pub precision: Vec<String>,

    /// Custom key-value attributes
    pub custom: HashMap<String, MetadataValue>,
}

pub struct PerformanceProfile {
    /// Average latency in milliseconds
    pub avg_latency_ms: f64,

    /// P99 latency in milliseconds
    pub p99_latency_ms: f64,

    /// Throughput (requests per second)
    pub throughput_rps: f64,

    /// Batch size support
    pub max_batch_size: Option<u32>,
}

pub struct QualityMetrics {
    /// Trust score (0-100)
    pub trust_score: u8,

    /// Accuracy metric (0-1, task-dependent)
    pub accuracy: Option<f64>,

    /// Uptime percentage (0-100)
    pub uptime_pct: f64,

    /// Total successful invocations
    pub success_count: u64,
}

pub struct CostModel {
    /// Cost per invocation in micro-dollars
    pub per_invocation_micro_usd: u64,

    /// Cost per token (for LLM capabilities)
    pub per_token_micro_usd: Option<u64>,

    /// Free tier available
    pub has_free_tier: bool,
}

pub struct CapabilityEdge {
    /// Target capability name
    pub target: String,

    /// Edge type
    pub edge_type: EdgeType,

    /// Optional constraint on the edge
    pub constraint: Option<String>,
}

pub enum EdgeType {
    /// This capability requires the target to function
    Requires,
    /// This capability is enhanced by the target
    Enables,
    /// This capability should run before the target (pipeline ordering)
    Precedes,
    /// This capability is an alternative to the target
    Alternative,
    /// This capability is a specialization of the target
    Specializes,
}
```

### 3.2 Wire Format (CBOR)

The semantic capability is encoded as a CBOR IntMap for wire transmission, extending the existing `CapabilityDescriptor.metadata` field. This maintains backward compatibility — agents that don't understand semantic metadata simply ignore the extra fields.

---

## 4. Query Language

### 4.1 Structured Query Builder

Rather than a full query language like SPARQL, use a builder pattern (similar to Kubernetes selectors but extended):

```rust
pub struct CapabilityQuery {
    /// Base capability name (required, exact match)
    pub name: String,

    /// Attribute filters
    pub filters: Vec<QueryFilter>,

    /// Performance requirements
    pub performance: Option<PerformanceFilter>,

    /// Quality requirements
    pub quality: Option<QualityFilter>,

    /// Cost constraints
    pub cost: Option<CostFilter>,

    /// Geographic constraints
    pub geo: Option<GeoFilter>,

    /// Version requirements
    pub version: Option<VersionFilter>,
}

pub enum QueryFilter {
    /// Exact match: language = "en"
    Equality { key: String, value: MetadataValue },
    /// Range: latency < 40ms
    Range { key: String, op: RangeOp, value: f64 },
    /// Set membership: language in ["en", "fr"]
    In { key: String, values: Vec<MetadataValue> },
    /// Exists: has GPU attribute
    Exists { key: String },
    /// Semantic match: "translation" matches "translate", "translating"
    SemanticMatch { key: String, pattern: String },
}

pub enum RangeOp {
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
}
```

### 4.2 Query Builder API

```rust
let query = CapabilityQuery::new("ocr")
    .with_filter(QueryFilter::Equality {
        key: "language".into(),
        value: MetadataValue::Text("en".into()),
    })
    .with_performance(PerformanceFilter {
        max_avg_latency_ms: Some(40.0),
        min_throughput_rps: None,
    })
    .with_quality(QualityFilter {
        min_trust_score: Some(95),
        min_accuracy: None,
    })
    .with_cost(CostFilter {
        max_per_invocation_micro_usd: Some(100), // <$0.0001
    })
    .with_filter(QueryFilter::Exists {
        key: "hardware.gpu".into(),
    })
    .build();
```

### 4.3 Query Evaluation

Queries are evaluated locally by the discovering agent after retrieving candidate records from the DHT. This keeps the DHT simple (still keyed by capability name) while enabling rich filtering.

---

## 5. DHT Indexing Strategy

### 5.1 Hybrid Approach

- **Primary index**: SHA-256(capability_name) — backward compatible with existing DHT
- **Secondary indexes**: Built locally by each agent from discovered records
  - Inverted index for categorical attributes (language, modality, framework)
  - Locality-sensitive hashing (LSH) for numeric attributes (latency, cost, trust)
  - B-tree for range queries on performance metrics

### 5.2 Index Construction

When an agent discovers capability records, it builds local secondary indexes:

```rust
pub struct CapabilityIndex {
    /// Primary: name -> records
    by_name: HashMap<String, Vec<SemanticCapability>>,

    /// Secondary: language -> records
    by_language: HashMap<String, Vec<SemanticCapability>>,

    /// Secondary: modality -> records
    by_modality: HashMap<Modality, Vec<SemanticCapability>>,

    /// Secondary: sorted by latency
    by_latency: BTreeMap<OrderedFloat<f64>, Vec<SemanticCapability>>,

    /// Secondary: sorted by trust score
    by_trust: BTreeMap<u8, Vec<SemanticCapability>>,
}
```

---

## 6. Capability Composition

### 6.1 Graph Traversal for Pipeline Assembly

Capabilities form a directed graph via `CapabilityEdge`. The discovery system can traverse this graph to assemble pipelines:

```rust
pub struct PipelineAssembler {
    /// All known capabilities (the graph)
    graph: CapabilityGraph,
}

impl PipelineAssembler {
    /// Find a pipeline that satisfies the goal
    pub fn find_pipeline(&self, goal: CapabilityQuery) -> Vec<PipelineStep> {
        // 1. Find capabilities matching the goal
        let candidates = self.graph.query(&goal);

        // 2. For each candidate, check if requirements are met
        //    If not, recursively find capabilities for the requirements
        // 3. Use topological sort based on Precedes edges
        // 4. Return ordered pipeline
    }
}

pub struct PipelineStep {
    pub capability: SemanticCapability,
    pub agent_id: AgentId,
    pub depends_on: Vec<usize>, // Indices of prior steps
}
```

### 6.2 Example: Document Translation Pipeline

```
Goal: Translate English document to French

Graph traversal:
1. Find "translation" capability (en->fr)
   - Requires: "document-read" (to read the document)
   - Requires: "document-write" (to write the output)

2. Find "document-read" capability
   - Requires: "ocr" (if document is image)

3. Pipeline: ocr -> document-read -> translation -> document-write
```

---

## 7. Versioning

### 7.1 Semantic Versioning

```rust
pub struct SemanticVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}
```

### 7.2 Compatibility Matrix

- **Major version**: Breaking changes (different capability semantics)
- **Minor version**: Backward-compatible additions (new attributes)
- **Patch version**: Bug fixes, performance improvements

Queries can specify version constraints:
```rust
pub enum VersionFilter {
    Exact(SemanticVersion),
    Minimum(SemanticVersion),
    Range { min: SemanticVersion, max: SemanticVersion },
}
```

---

## 8. Integration with Adaptive Routing Plane (Track T)

### 8.1 Static vs Dynamic

- **Capability Graph (Track U)**: Static descriptions — what an agent *can* do
- **Adaptive Routing Plane (Track T)**: Dynamic metrics — how an agent is *performing* right now

### 8.2 Combined Scoring

```rust
pub fn score_candidate(
    capability: &SemanticCapability,
    routing_metrics: &RoutingMetrics,
    query: &CapabilityQuery,
) -> f64 {
    // Static score: how well the capability matches the query
    let static_score = query.match_score(capability);

    // Dynamic score: current load, latency, availability
    let dynamic_score = routing_metrics.health_score();

    // Weighted combination
    0.7 * static_score + 0.3 * dynamic_score
}
```

---

## 9. Internet Bridge Capability Mapping

Map well-known internet bridge capabilities to semantic descriptors:

| Capability | Category | Key Attributes |
|-----------|----------|----------------|
| search | information-retrieval | query_type, max_results, freshness |
| web-browse | navigation | javascript_support, wait_strategy |
| document-read | parsing | formats: [pdf, html, docx], ocr_support |
| api-call | integration | protocols: [rest, graphql, grpc], auth_methods |
| api-discover | integration | spec_formats: [openapi, graphql-schema] |
| code-execute | computation | languages, sandbox_type, timeout |
| image-ocr | perception | languages, min_confidence, gpu_required |
| audio-transcribe | perception | languages, formats, real_time |
| crawl | information-retrieval | rate_limit, depth, robots_txt |
| real-time-subscribe | streaming | protocols: [websocket, sse, grpc-stream] |
| stealth-browse | navigation | proxy_support, captcha_solving |

---

## 10. Discovery as Planning

### 10.1 Planning Domain

The capability graph serves as a planning domain where:
- **States**: Current set of available outputs/data
- **Actions**: Capability invocations (with preconditions and effects)
- **Goals**: Desired output specified by the query

### 10.2 Planner

```rust
pub trait CapabilityPlanner {
    /// Find an execution plan that achieves the goal
    fn plan(
        &self,
        goal: &CapabilityQuery,
        available: &[SemanticCapability],
    ) -> Result<ExecutionPlan, PlanningError>;
}

pub struct ExecutionPlan {
    pub steps: Vec<PlannedStep>,
    pub estimated_total_latency_ms: f64,
    pub estimated_total_cost_micro_usd: u64,
}
```

---

## 11. Implementation Roadmap

### Phase 1: Extended CapabilityDescriptor (Week 1-2)
- Add `SemanticCapability` struct to `aafp-identity`
- Extend `CapabilityDescriptor.metadata` with semantic fields
- Add CBOR encoding/decoding for semantic capabilities
- Backward compatibility tests

### Phase 2: Query Builder (Week 3-4)
- Implement `CapabilityQuery` and `QueryFilter` types
- Implement query evaluation engine
- Add `discover_semantic()` method to Simple API
- Integration tests with existing discovery

### Phase 3: Local Indexing (Week 5-6)
- Implement `CapabilityIndex` with secondary indexes
- Build indexes from DHT discovery results
- Benchmark query performance
- Add index eviction policies

### Phase 4: Capability Composition (Week 7-8)
- Implement `CapabilityGraph` data structure
- Implement `PipelineAssembler` with graph traversal
- Add pipeline assembly tests
- Document composition patterns

### Phase 5: Planning (Week 9-10)
- Implement `CapabilityPlanner` trait
- Add heuristic planner (greedy + A* search)
- Integration with Adaptive Routing Plane (Track T)
- End-to-end pipeline assembly tests

### Phase 6: Internet Bridge Integration (Week 11-12)
- Map all well-known capabilities to semantic descriptors
- Add capability schemas for internet bridge
- Integration tests with internet bridge agents
- Documentation for capability authors

---

## 12. Security Considerations

- **Capability spoofing**: Agents could claim capabilities they don't have. Mitigation: UCAN-based capability attestation, reputation system.
- **Query injection**: Malicious queries could exhaust resources. Mitigation: Query complexity limits, rate limiting.
- **Graph poisoning**: Malicious agents could inject false dependency edges. Mitigation: Trust-weighted edges, consensus on graph structure.

---

## 13. Conclusion

Semantic Capability Graphs transform AAFP discovery from flat string matching to rich, multi-dimensional, composable capability descriptions. The design leverages the existing `CapabilityDescriptor` infrastructure, uses CBOR for wire efficiency, and integrates with the Adaptive Routing Plane (Track T) for dynamic metrics. The lightweight ontology approach avoids the complexity of full OWL/RDF while enabling powerful queries and automatic pipeline assembly.
