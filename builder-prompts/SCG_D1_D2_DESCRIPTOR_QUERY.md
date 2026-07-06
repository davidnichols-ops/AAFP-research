# Builder Prompt: Semantic Capability Graphs Phase D1-D2
## Extended CapabilityDescriptor + Query Builder

**Track:** U — Semantic Capability Graphs
**Phases:** D1 (Extended CapabilityDescriptor) + D2 (Query Builder)
**Design Doc:** `SEMANTIC_CAPABILITY_GRAPHS.md` §3 (Data Model), §4 (Query Language)
**Target Crates:** `aafp-identity`, `aafp-discovery`

---

## Objective

Implement the first two phases of the Semantic Capability Graphs roadmap:

1. **D1 — Extended CapabilityDescriptor**: Add a `SemanticCapability` struct with multi-dimensional capability metadata (category, attributes, performance, quality, cost, dependencies, version, geo), plus CBOR encoding/decoding that extends the existing `CapabilityDescriptor.metadata` field. Old agents without semantic metadata must remain fully discoverable.

2. **D2 — Query Builder**: Implement a `CapabilityQuery` builder pattern with a `QueryFilter` enum (Equality, Range, In, Exists, SemanticMatch) and a local query evaluation engine that filters candidate records retrieved from the DHT.

---

## Context: Existing Code You Must Build On

### CapabilityDescriptor (`aafp-identity/src/identity_v1.rs`, lines 417-549)

The existing `CapabilityDescriptor` is minimal:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityDescriptor {
    pub name: String,
    pub metadata: Vec<(String, MetadataValue)>,
}
```

It encodes to CBOR as an int-keyed map `{1: name, 2: metadata_map}` where `metadata` uses **string keys** (the one RFC-0002 §8.1 exception). `MetadataValue` is an enum: `Bool(bool)`, `Int(i64)`, `Text(String)`, `Bytes(Vec<u8>)`.

The `from_cbor` decoder already handles missing metadata gracefully (`None => Vec::new()`), so adding new metadata keys is backward compatible — old decoders simply ignore unknown keys.

### CapabilityDht (`aafp-discovery/src/capability_dht.rs`)

The DHT is keyed by `SHA-256(capability_string)`. `get(capability)` returns `Vec<&AgentRecord>`. The DHT itself does NOT understand semantic metadata — it only does exact string matching on capability names. Semantic filtering happens **locally** after DHT retrieval (§4.3).

### CBOR Helpers (`aafp-cbor`)

- `aafp_cbor::int_map(vec![(k, v), ...])` → `Value::IntMap`
- `aafp_cbor::str_map(vec![(k, v), ...])` → `Value::StrMap`
- `aafp_cbor::int_map_get(&val, k)` → `Option<&Value>`
- `aafp_cbor::encode(&val)` → `Result<Vec<u8>, CborError>`
- `aafp_cbor::decode(&bytes)` → `Result<(Value, usize), CborError>`

All maps use length-first canonical byte ordering (RFC 8949 §4.2.3).

---

## D1: SemanticCapability Struct

### File: `aafp-identity/src/semantic_capability.rs` (new module)

Create a new module `semantic_capability` in `aafp-identity`. Export it from `lib.rs`.

### Required Structs and Enums

Implement all structs from `SEMANTIC_CAPABILITY_GRAPHS.md` §3.1:

```rust
use aafp_cbor::{int_map, str_map, Value};
use aafp_identity::MetadataValue;
use std::collections::HashMap;

/// A semantic category for a capability.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum CapabilityCategory {
    Inference,
    Translation,
    Ocr,
    InformationRetrieval,
    Navigation,
    Parsing,
    Integration,
    Computation,
    Perception,
    Streaming,
    Custom(String),
}

/// Supported modalities.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Modality {
    Text,
    Image,
    Audio,
    Video,
}

/// Hardware specification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HardwareSpec {
    pub kind: String,       // "gpu", "cpu", "tpu", "npu"
    pub model: Option<String>, // e.g. "RTX5090"
    pub vram_mb: Option<u32>,
}

/// Structured attributes for multi-dimensional queries.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct CapabilityAttributes {
    pub languages: Vec<String>,
    pub modalities: Vec<Modality>,
    pub hardware: Vec<HardwareSpec>,
    pub frameworks: Vec<String>,
    pub precision: Vec<String>,
    pub custom: HashMap<String, MetadataValue>,
}

/// Performance characteristics.
#[derive(Clone, Debug, PartialEq)]
pub struct PerformanceProfile {
    pub avg_latency_ms: f64,
    pub p99_latency_ms: f64,
    pub throughput_rps: f64,
    pub max_batch_size: Option<u32>,
}

/// Quality/trust metrics.
#[derive(Clone, Debug, PartialEq)]
pub struct QualityMetrics {
    pub trust_score: u8,        // 0-100
    pub accuracy: Option<f64>,  // 0.0-1.0
    pub uptime_pct: f64,        // 0.0-100.0
    pub success_count: u64,
}

/// Cost model (micro-dollars = 1e-6 USD).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CostModel {
    pub per_invocation_micro_usd: u64,
    pub per_token_micro_usd: Option<u64>,
    pub has_free_tier: bool,
}

/// Semantic version.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SemanticVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

/// Geographic constraint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeoConstraint {
    pub region: String,         // e.g. "na", "eu", "apac"
    pub countries: Vec<String>, // ISO 3166-1 alpha-2
    pub latency_optimized: bool,
}

/// Edge type for capability dependency graph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EdgeType {
    Requires,
    Enables,
    Precedes,
    Alternative,
    Specializes,
}

/// A dependency edge to another capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityEdge {
    pub target: String,
    pub edge_type: EdgeType,
    pub constraint: Option<String>,
}

/// The full semantic capability descriptor.
#[derive(Clone, Debug, PartialEq)]
pub struct SemanticCapability {
    pub name: String,
    pub category: CapabilityCategory,
    pub attributes: CapabilityAttributes,
    pub performance: PerformanceProfile,
    pub quality: QualityMetrics,
    pub cost: CostModel,
    pub dependencies: Vec<CapabilityEdge>,
    pub version: SemanticVersion,
    pub geo: Option<GeoConstraint>,
}
```

### CBOR Encoding Strategy

Encode `SemanticCapability` as a CBOR IntMap with integer keys, then embed it in `CapabilityDescriptor.metadata` under the reserved key `"semantic"`. This maintains backward compatibility: old agents see an unknown metadata key and ignore it; new agents extract and decode the semantic sub-structure.

**CBOR key assignment for SemanticCapability IntMap:**

| Key | Field | Type |
|-----|-------|------|
| 1 | name | tstr |
| 2 | category | uint (enum discriminant) + tstr for Custom |
| 3 | attributes | IntMap (see below) |
| 4 | performance | IntMap |
| 5 | quality | IntMap |
| 6 | cost | IntMap |
| 7 | dependencies | Array of IntMaps |
| 8 | version | IntMap {1: major, 2: minor, 3: patch} |
| 9 | geo | IntMap (optional) |

**Attributes IntMap keys:** 1: languages (array of tstr), 2: modalities (array of uint), 3: hardware (array of intmaps), 4: frameworks (array of tstr), 5: precision (array of tstr), 6: custom (StrMap of MetadataValue).

**Performance IntMap keys:** 1: avg_latency_ms (float as u64 * 1000), 2: p99_latency_ms, 3: throughput_rps, 4: max_batch_size (optional uint).

**NOTE on floats:** The existing `aafp_cbor::Value` enum does NOT have a Float variant. Encode all `f64` fields as scaled `u64` integers (e.g., milliseconds as `u64`, throughput as `u64` rounded). Document the scaling factor in doc comments. This keeps canonical CBOR deterministic (no float ambiguity).

### Required Methods

```rust
impl SemanticCapability {
    /// Encode to CBOR Value (IntMap).
    pub fn to_cbor(&self) -> Value;

    /// Decode from CBOR Value.
    pub fn from_cbor(val: &Value) -> Result<Self, SemanticError>;

    /// Wrap into a CapabilityDescriptor by embedding under "semantic" metadata key.
    pub fn to_descriptor(&self) -> CapabilityDescriptor;

    /// Extract from a CapabilityDescriptor's metadata, if present.
    pub fn from_descriptor(desc: &CapabilityDescriptor) -> Option<Self>;
}

impl CapabilityDescriptor {
    /// Check if this descriptor has embedded semantic metadata.
    pub fn has_semantic(&self) -> bool;

    /// Extract the SemanticCapability, if present.
    pub fn semantic(&self) -> Option<SemanticCapability>;
}
```

### Error Type

```rust
#[derive(Debug, thiserror::Error)]
pub enum SemanticError {
    #[error("missing field: {0}")]
    MissingField(&'static str),
    #[error("invalid field '{field}': {message}")]
    InvalidField { field: &'static str, message: String },
    #[error("CBOR error: {0}")]
    Cbor(#[from] aafp_cbor::CborError),
}
```

### Concrete CBOR Encoding Example

```rust
impl SemanticCapability {
    pub fn to_cbor(&self) -> Value {
        int_map(vec![
            (1, Value::TextString(self.name.clone())),
            (2, self.category.to_cbor()),
            (3, self.attributes.to_cbor()),
            (4, self.performance.to_cbor()),
            (5, self.quality.to_cbor()),
            (6, self.cost.to_cbor()),
            (7, Value::Array(self.dependencies.iter().map(|e| e.to_cbor()).collect())),
            (8, self.version.to_cbor()),
            (9, self.geo.as_ref().map(|g| g.to_cbor()).unwrap_or(Value::Null)),
        ])
    }

    pub fn to_descriptor(&self) -> CapabilityDescriptor {
        let cbor = self.to_cbor();
        let encoded = aafp_cbor::encode(&cbor).unwrap();
        CapabilityDescriptor::new(&self.name)
            .with_metadata("semantic", MetadataValue::Bytes(encoded))
    }

    pub fn from_descriptor(desc: &CapabilityDescriptor) -> Option<Self> {
        for (key, val) in &desc.metadata {
            if key == "semantic" {
                if let MetadataValue::Bytes(bytes) = val {
                    let (cbor, _) = aafp_cbor::decode(bytes).ok()?;
                    return Self::from_cbor(&cbor).ok();
                }
            }
        }
        None
    }
}
```

---

## D2: Query Builder and Evaluation Engine

### File: `aafp-discovery/src/semantic_query.rs` (new module)

Create a new module `semantic_query` in `aafp-discovery`. Export it from `lib.rs`.

### QueryFilter Enum (from §4.1)

```rust
use aafp_identity::MetadataValue;

/// Comparison operator for range filters.
#[derive(Clone, Debug, PartialEq)]
pub enum RangeOp {
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
}

/// A single filter predicate applied to a capability's attributes/metadata.
#[derive(Clone, Debug, PartialEq)]
pub enum QueryFilter {
    /// Exact match: language = "en"
    Equality { key: String, value: MetadataValue },
    /// Range: latency < 40ms (value is compared as f64)
    Range { key: String, op: RangeOp, value: f64 },
    /// Set membership: language in ["en", "fr"]
    In { key: String, values: Vec<MetadataValue> },
    /// Exists: has GPU attribute
    Exists { key: String },
    /// Semantic match: "translation" matches "translate", "translating"
    /// Uses prefix/substring matching (lightweight, no full ontology).
    SemanticMatch { key: String, pattern: String },
}
```

### Filter Structs (from §4.1)

```rust
/// Performance requirements.
#[derive(Clone, Debug, Default)]
pub struct PerformanceFilter {
    pub max_avg_latency_ms: Option<f64>,
    pub max_p99_latency_ms: Option<f64>,
    pub min_throughput_rps: Option<f64>,
    pub min_batch_size: Option<u32>,
}

/// Quality requirements.
#[derive(Clone, Debug, Default)]
pub struct QualityFilter {
    pub min_trust_score: Option<u8>,
    pub min_accuracy: Option<f64>,
    pub min_uptime_pct: Option<f64>,
}

/// Cost constraints.
#[derive(Clone, Debug, Default)]
pub struct CostFilter {
    pub max_per_invocation_micro_usd: Option<u64>,
    pub max_per_token_micro_usd: Option<u64>,
    pub require_free_tier: bool,
}

/// Geographic constraints.
#[derive(Clone, Debug, Default)]
pub struct GeoFilter {
    pub region: Option<String>,
    pub country: Option<String>,
}

/// Version constraints (from §7.2).
#[derive(Clone, Debug)]
pub enum VersionFilter {
    Exact(SemanticVersion),
    Minimum(SemanticVersion),
    Range { min: SemanticVersion, max: SemanticVersion },
}
```

### CapabilityQuery with Builder Pattern

```rust
/// A structured capability query. The `name` field is required and used
/// for DHT lookup; all other fields are optional local filters.
#[derive(Clone, Debug)]
pub struct CapabilityQuery {
    pub name: String,
    pub filters: Vec<QueryFilter>,
    pub performance: Option<PerformanceFilter>,
    pub quality: Option<QualityFilter>,
    pub cost: Option<CostFilter>,
    pub geo: Option<GeoFilter>,
    pub version: Option<VersionFilter>,
}

impl CapabilityQuery {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            filters: Vec::new(),
            performance: None,
            quality: None,
            cost: None,
            geo: None,
            version: None,
        }
    }

    pub fn with_filter(mut self, filter: QueryFilter) -> Self {
        self.filters.push(filter);
        self
    }

    pub fn with_performance(mut self, perf: PerformanceFilter) -> Self {
        self.performance = Some(perf);
        self
    }

    pub fn with_quality(mut self, qual: QualityFilter) -> Self {
        self.quality = Some(qual);
        self
    }

    pub fn with_cost(mut self, cost: CostFilter) -> Self {
        self.cost = Some(cost);
        self
    }

    pub fn with_geo(mut self, geo: GeoFilter) -> Self {
        self.geo = Some(geo);
        self
    }

    pub fn with_version(mut self, ver: VersionFilter) -> Self {
        self.version = Some(ver);
        self
    }

    /// Build (no-op terminal — returns self, following the design doc pattern).
    pub fn build(self) -> Self { self }
}
```

### Example Usage (from §4.2)

```rust
let query = CapabilityQuery::new("ocr")
    .with_filter(QueryFilter::Equality {
        key: "language".into(),
        value: MetadataValue::Text("en".into()),
    })
    .with_performance(PerformanceFilter {
        max_avg_latency_ms: Some(40.0),
        ..Default::default()
    })
    .with_quality(QualityFilter {
        min_trust_score: Some(95),
        ..Default::default()
    })
    .with_cost(CostFilter {
        max_per_invocation_micro_usd: Some(100), // <$0.0001
        ..Default::default()
    })
    .with_filter(QueryFilter::Exists {
        key: "hardware.gpu".into(),
    })
    .build();
```

---

## Query Evaluation Engine

### Design (§4.3)

Queries are evaluated **locally** by the discovering agent after retrieving candidate records from the DHT. The DHT remains keyed by capability name (backward compatible). The evaluation engine:

1. Takes a `&SemanticCapability` and a `&CapabilityQuery`.
2. Checks the `name` matches (the DHT already filtered by name, but double-check).
3. Evaluates each `QueryFilter` against the capability's attributes and custom metadata.
4. Evaluates `performance`, `quality`, `cost`, `geo`, `version` filters.
5. Returns `true` only if ALL filters pass.

### Filter Key Resolution

The `key` in `QueryFilter` refers to a flattened attribute path. Resolve keys in this order:
1. **Built-in attribute keys**: `"language"`, `"modality"`, `"framework"`, `"precision"`, `"hardware.gpu"`, `"hardware.cpu"`, etc.
2. **Custom attributes**: looked up in `SemanticCapability.attributes.custom`.
3. **Top-level fields**: `"avg_latency_ms"`, `"trust_score"`, `"per_invocation_micro_usd"`, `"version"`, `"geo.region"`, etc.

For built-in keys that map to arrays (e.g., `"language"` → `languages: Vec<String>`), `Equality` matches if the value is present in the array; `In` matches if any value in the set is present; `Exists` matches if the array is non-empty.

### Required Methods

```rust
impl CapabilityQuery {
    /// Evaluate whether a SemanticCapability matches this query.
    pub fn matches(&self, cap: &SemanticCapability) -> bool;

    /// Evaluate filters against a raw CapabilityDescriptor (for backward compat).
    /// If the descriptor has embedded semantic metadata, extract and evaluate.
    /// If not, only the name and any Equality/Exists filters on plain metadata match.
    pub fn matches_descriptor(&self, desc: &CapabilityDescriptor) -> bool;
}

impl QueryFilter {
    /// Evaluate this single filter against a SemanticCapability.
    pub fn evaluate(&self, cap: &SemanticCapability) -> bool;
}
```

### Concrete Evaluation Code

```rust
impl QueryFilter {
    pub fn evaluate(&self, cap: &SemanticCapability) -> bool {
        match self {
            QueryFilter::Equality { key, value } => {
                Self::resolve_value(cap, key)
                    .map(|v| &v == value)
                    .unwrap_or(false)
            }
            QueryFilter::Range { key, op, value } => {
                Self::resolve_numeric(cap, key)
                    .map(|v| match op {
                        RangeOp::LessThan => v < *value,
                        RangeOp::LessThanOrEqual => v <= *value,
                        RangeOp::GreaterThan => v > *value,
                        RangeOp::GreaterThanOrEqual => v >= *value,
                    })
                    .unwrap_or(false)
            }
            QueryFilter::In { key, values } => {
                Self::resolve_value(cap, key)
                    .map(|v| values.contains(&v))
                    .unwrap_or(false)
            }
            QueryFilter::Exists { key } => {
                Self::resolve_value(cap, key).is_some()
            }
            QueryFilter::SemanticMatch { key, pattern } => {
                Self::resolve_text(cap, key)
                    .map(|v| {
                        let pat = pattern.to_lowercase();
                        v.to_lowercase().contains(&pat)
                    })
                    .unwrap_or(false)
            }
        }
    }

    fn resolve_value(cap: &SemanticCapability, key: &str) -> Option<MetadataValue> {
        match key {
            "language" => cap.attributes.languages.first()
                .map(|s| MetadataValue::Text(s.clone())),
            "framework" => cap.attributes.frameworks.first()
                .map(|s| MetadataValue::Text(s.clone())),
            "precision" => cap.attributes.precision.first()
                .map(|s| MetadataValue::Text(s.clone())),
            _ => cap.attributes.custom.get(key).cloned(),
        }
    }

    fn resolve_numeric(cap: &SemanticCapability, key: &str) -> Option<f64> {
        match key {
            "avg_latency_ms" => Some(cap.performance.avg_latency_ms),
            "p99_latency_ms" => Some(cap.performance.p99_latency_ms),
            "throughput_rps" => Some(cap.performance.throughput_rps),
            "trust_score" => Some(cap.quality.trust_score as f64),
            "uptime_pct" => Some(cap.quality.uptime_pct),
            "per_invocation_micro_usd" => Some(cap.cost.per_invocation_micro_usd as f64),
            _ => cap.attributes.custom.get(key).and_then(|v| match v {
                MetadataValue::Int(n) => Some(*n as f64),
                _ => None,
            }),
        }
    }

    fn resolve_text(cap: &SemanticCapability, key: &str) -> Option<String> {
        Self::resolve_value(cap, key).and_then(|v| match v {
            MetadataValue::Text(s) => Some(s),
            _ => None,
        })
    }
}

impl CapabilityQuery {
    pub fn matches(&self, cap: &SemanticCapability) -> bool {
        if cap.name != self.name {
            return false;
        }
        // Attribute filters
        for filter in &self.filters {
            if !filter.evaluate(cap) {
                return false;
            }
        }
        // Performance
        if let Some(ref perf) = self.performance {
            if let Some(max) = perf.max_avg_latency_ms {
                if cap.performance.avg_latency_ms > max { return false; }
            }
            if let Some(max) = perf.max_p99_latency_ms {
                if cap.performance.p99_latency_ms > max { return false; }
            }
            if let Some(min) = perf.min_throughput_rps {
                if cap.performance.throughput_rps < min { return false; }
            }
            if let Some(min_bs) = perf.min_batch_size {
                if cap.performance.max_batch_size.unwrap_or(0) < min_bs { return false; }
            }
        }
        // Quality
        if let Some(ref qual) = self.quality {
            if let Some(min) = qual.min_trust_score {
                if cap.quality.trust_score < min { return false; }
            }
            if let Some(min) = qual.min_accuracy {
                if cap.quality.accuracy.unwrap_or(0.0) < min { return false; }
            }
            if let Some(min) = qual.min_uptime_pct {
                if cap.quality.uptime_pct < min { return false; }
            }
        }
        // Cost
        if let Some(ref cost) = self.cost {
            if let Some(max) = cost.max_per_invocation_micro_usd {
                if cap.cost.per_invocation_micro_usd > max { return false; }
            }
            if let Some(max) = cost.max_per_token_micro_usd {
                if cap.cost.per_token_micro_usd.unwrap_or(u64::MAX) > max { return false; }
            }
            if cost.require_free_tier && !cap.cost.has_free_tier {
                return false;
            }
        }
        // Version
        if let Some(ref vf) = self.version {
            if !vf.matches(&cap.version) { return false; }
        }
        // Geo
        if let Some(ref gf) = self.geo {
            if let Some(ref gc) = cap.geo {
                if let Some(ref region) = gf.region {
                    if &gc.region != region { return false; }
                }
                if let Some(ref country) = gf.country {
                    if !gc.countries.contains(country) { return false; }
                }
            } else {
                return false; // Query requires geo but capability has none
            }
        }
        true
    }

    pub fn matches_descriptor(&self, desc: &CapabilityDescriptor) -> bool {
        if let Some(sem) = SemanticCapability::from_descriptor(desc) {
            return self.matches(&sem);
        }
        // Backward compat: no semantic metadata. Only match name + plain metadata filters.
        if desc.name != self.name { return false; }
        for filter in &self.filters {
            match filter {
                QueryFilter::Equality { key, value } => {
                    let found = desc.metadata.iter().find(|(k, _)| k == key);
                    if !found.map(|(_, v)| v == value).unwrap_or(false) {
                        return false;
                    }
                }
                QueryFilter::Exists { key } => {
                    if !desc.metadata.iter().any(|(k, _)| k == key) {
                        return false;
                    }
                }
                _ => return false, // Range/In/SemanticMatch can't eval without semantic data
            }
        }
        // Performance/quality/cost/version/geo can't be checked without semantic data.
        // If the query has any of those, reject non-semantic descriptors.
        if self.performance.is_some() || self.quality.is_some()
            || self.cost.is_some() || self.version.is_some() || self.geo.is_some()
        {
            return false;
        }
        true
    }
}

impl VersionFilter {
    pub fn matches(&self, ver: &SemanticVersion) -> bool {
        match self {
            VersionFilter::Exact(v) => v == ver,
            VersionFilter::Minimum(v) => ver >= v,
            VersionFilter::Range { min, max } => ver >= min && ver <= max,
        }
    }
}
```

### Integration with CapabilityDht

Add a method to `CapabilityDht` (or a helper in `aafp-discovery`) that retrieves candidates by name and filters with a `CapabilityQuery`:

```rust
impl CapabilityDht {
    /// Find all agents whose SemanticCapability matches the query.
    /// Retrieves candidates by name from DHT, then filters locally.
    pub fn find_semantic(&self, query: &CapabilityQuery) -> Vec<&AgentRecord> {
        self.get(&query.name)
            .into_iter()
            .filter(|record| {
                record.capabilities.iter().any(|cap| {
                    cap.name == query.name && query.matches_descriptor(cap)
                })
            })
            .collect()
    }
}
```

---

## Backward Compatibility

This is a critical requirement. The design must satisfy these constraints:

1. **Old agents (no semantic metadata) remain discoverable**: A `CapabilityDescriptor` with only `name` and no `"semantic"` metadata key must still be found via `CapabilityDht::get(name)`. The `from_descriptor` method returns `None`, and `matches_descriptor` falls back to plain metadata matching.

2. **Old agents ignore semantic metadata**: When an old agent receives a `CapabilityDescriptor` with a `"semantic"` key in metadata, it simply sees an extra `MetadataValue::Bytes` entry it doesn't understand. The existing `from_cbor` decoder handles arbitrary metadata keys.

3. **DHT key unchanged**: The DHT remains keyed by `SHA-256(capability_name)`. No changes to `hash_capability`, `put`, or `get`. Semantic filtering is purely local post-retrieval.

4. **CBOR round-trip preserves old format**: A `CapabilityDescriptor` without semantic metadata must encode/decode identically to before. The `to_descriptor` method only adds the `"semantic"` key when called; `CapabilityDescriptor::new("ocr")` still produces the same CBOR as before.

---

## Unit Tests

### D1 Tests (in `semantic_capability.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semantic_capability_cbor_roundtrip() {
        let cap = SemanticCapability {
            name: "ocr".into(),
            category: CapabilityCategory::Ocr,
            attributes: CapabilityAttributes {
                languages: vec!["en".into(), "fr".into()],
                modalities: vec![Modality::Image],
                hardware: vec![HardwareSpec {
                    kind: "gpu".into(),
                    model: Some("RTX5090".into()),
                    vram_mb: Some(32768),
                }],
                frameworks: vec!["TensorRT".into()],
                precision: vec!["FP8".into()],
                custom: HashMap::new(),
            },
            performance: PerformanceProfile {
                avg_latency_ms: 14.0,
                p99_latency_ms: 35.0,
                throughput_rps: 500.0,
                max_batch_size: Some(32),
            },
            quality: QualityMetrics {
                trust_score: 97,
                accuracy: Some(0.98),
                uptime_pct: 99.9,
                success_count: 100_000,
            },
            cost: CostModel {
                per_invocation_micro_usd: 50,
                per_token_micro_usd: None,
                has_free_tier: true,
            },
            dependencies: vec![CapabilityEdge {
                target: "document-read".into(),
                edge_type: EdgeType::Requires,
                constraint: None,
            }],
            version: SemanticVersion { major: 4, minor: 1, patch: 0 },
            geo: Some(GeoConstraint {
                region: "na".into(),
                countries: vec!["US".into(), "CA".into()],
                latency_optimized: true,
            }),
        };
        let cbor = cap.to_cbor();
        let encoded = aafp_cbor::encode(&cbor).unwrap();
        let (decoded, _) = aafp_cbor::decode(&encoded).unwrap();
        let cap2 = SemanticCapability::from_cbor(&decoded).unwrap();
        assert_eq!(cap, cap2);
    }

    #[test]
    fn test_descriptor_embedding_roundtrip() {
        let cap = test_capability(); // helper
        let desc = cap.to_descriptor();
        assert_eq!(desc.name, "ocr");
        assert!(desc.has_semantic());
        let extracted = SemanticCapability::from_descriptor(&desc).unwrap();
        assert_eq!(cap, extracted);
    }

    #[test]
    fn test_old_descriptor_no_semantic() {
        let desc = CapabilityDescriptor::new("inference")
            .with_metadata("model", MetadataValue::Text("gpt-4".into()));
        assert!(!desc.has_semantic());
        assert!(SemanticCapability::from_descriptor(&desc).is_none());
    }

    #[test]
    fn test_backward_compat_cbor_unchanged() {
        // Old-style descriptor must produce identical CBOR to before.
        let desc = CapabilityDescriptor::new("translation");
        let cbor = desc.to_cbor();
        let encoded = aafp_cbor::encode(&cbor).unwrap();
        let (decoded, _) = aafp_cbor::decode(&encoded).unwrap();
        let desc2 = CapabilityDescriptor::from_cbor(&decoded).unwrap();
        assert_eq!(desc2.name, "translation");
        assert!(desc2.metadata.is_empty());
    }
}
```

### D2 Tests (in `semantic_query.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cap() -> SemanticCapability {
        SemanticCapability {
            name: "ocr".into(),
            category: CapabilityCategory::Ocr,
            attributes: CapabilityAttributes {
                languages: vec!["en".into(), "fr".into()],
                modalities: vec![Modality::Image],
                hardware: vec![HardwareSpec {
                    kind: "gpu".into(), model: None, vram_mb: None,
                }],
                frameworks: vec!["TensorRT".into()],
                precision: vec!["FP8".into()],
                custom: HashMap::new(),
            },
            performance: PerformanceProfile {
                avg_latency_ms: 14.0, p99_latency_ms: 35.0,
                throughput_rps: 500.0, max_batch_size: Some(32),
            },
            quality: QualityMetrics {
                trust_score: 97, accuracy: Some(0.98),
                uptime_pct: 99.9, success_count: 1000,
            },
            cost: CostModel {
                per_invocation_micro_usd: 50,
                per_token_micro_usd: None, has_free_tier: true,
            },
            dependencies: vec![],
            version: SemanticVersion { major: 4, minor: 1, patch: 0 },
            geo: Some(GeoConstraint {
                region: "na".into(), countries: vec!["US".into()],
                latency_optimized: true,
            }),
        }
    }

    #[test]
    fn test_equality_filter_match() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::Equality {
                key: "language".into(),
                value: MetadataValue::Text("en".into()),
            })
            .build();
        assert!(q.matches(&cap));
    }

    #[test]
    fn test_equality_filter_no_match() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::Equality {
                key: "language".into(),
                value: MetadataValue::Text("de".into()),
            })
            .build();
        assert!(!q.matches(&cap));
    }

    #[test]
    fn test_range_filter_latency() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::Range {
                key: "avg_latency_ms".into(),
                op: RangeOp::LessThan,
                value: 40.0,
            })
            .build();
        assert!(q.matches(&cap)); // 14ms < 40ms

        let q2 = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::Range {
                key: "avg_latency_ms".into(),
                op: RangeOp::LessThan,
                value: 10.0,
            })
            .build();
        assert!(!q2.matches(&cap)); // 14ms >= 10ms
    }

    #[test]
    fn test_in_filter() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::In {
                key: "language".into(),
                values: vec![
                    MetadataValue::Text("de".into()),
                    MetadataValue::Text("fr".into()),
                ],
            })
            .build();
        assert!(q.matches(&cap)); // fr is in languages
    }

    #[test]
    fn test_exists_filter() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::Exists { key: "framework".into() })
            .build();
        assert!(q.matches(&cap));

        let q2 = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::Exists { key: "nonexistent".into() })
            .build();
        assert!(!q2.matches(&cap));
    }

    #[test]
    fn test_semantic_match_filter() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_filter(QueryFilter::SemanticMatch {
                key: "framework".into(),
                pattern: "tensor".into(),
            })
            .build();
        assert!(q.matches(&cap)); // "TensorRT" contains "tensor"
    }

    #[test]
    fn test_combined_performance_quality_cost() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_performance(PerformanceFilter {
                max_avg_latency_ms: Some(40.0),
                ..Default::default()
            })
            .with_quality(QualityFilter {
                min_trust_score: Some(95),
                ..Default::default()
            })
            .with_cost(CostFilter {
                max_per_invocation_micro_usd: Some(100),
                ..Default::default()
            })
            .build();
        assert!(q.matches(&cap));
    }

    #[test]
    fn test_version_filter_minimum() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_version(VersionFilter::Minimum(
                SemanticVersion { major: 4, minor: 0, patch: 0 }
            ))
            .build();
        assert!(q.matches(&cap)); // 4.1.0 >= 4.0.0
    }

    #[test]
    fn test_geo_filter_match() {
        let cap = sample_cap();
        let q = CapabilityQuery::new("ocr")
            .with_geo(GeoFilter {
                region: Some("na".into()),
                country: None,
            })
            .build();
        assert!(q.matches(&cap));
    }

    #[test]
    fn test_geo_filter_no_geo_in_cap() {
        let mut cap = sample_cap();
        cap.geo = None;
        let q = CapabilityQuery::new("ocr")
            .with_geo(GeoFilter {
                region: Some("na".into()),
                country: None,
            })
            .build();
        assert!(!q.matches(&cap));
    }

    #[test]
    fn test_backward_compat_old_descriptor() {
        let desc = CapabilityDescriptor::new("inference")
            .with_metadata("model", MetadataValue::Text("gpt-4".into()));
        let q = CapabilityQuery::new("inference")
            .with_filter(QueryFilter::Equality {
                key: "model".into(),
                value: MetadataValue::Text("gpt-4".into()),
            })
            .build();
        assert!(q.matches_descriptor(&desc));
    }

    #[test]
    fn test_backward_compat_rejects_perf_query_on_old_desc() {
        let desc = CapabilityDescriptor::new("inference");
        let q = CapabilityQuery::new("inference")
            .with_performance(PerformanceFilter {
                max_avg_latency_ms: Some(40.0),
                ..Default::default()
            })
            .build();
        assert!(!q.matches_descriptor(&desc));
    }
}
```

---

## Implementation Checklist

### D1 — Extended CapabilityDescriptor
- [ ] Create `aafp-identity/src/semantic_capability.rs`
- [ ] Implement all structs: `SemanticCapability`, `CapabilityAttributes`, `PerformanceProfile`, `QualityMetrics`, `CostModel`, `CapabilityEdge`, `EdgeType`, `SemanticVersion`, `GeoConstraint`, `CapabilityCategory`, `Modality`, `HardwareSpec`
- [ ] Implement `to_cbor()` / `from_cbor()` for each struct (IntMap encoding with documented integer keys)
- [ ] Implement `SemanticCapability::to_descriptor()` / `from_descriptor()` (embed under `"semantic"` metadata key as `MetadataValue::Bytes`)
- [ ] Add `has_semantic()` and `semantic()` methods to `CapabilityDescriptor`
- [ ] Add `SemanticError` error enum
- [ ] Export module from `aafp-identity/src/lib.rs`
- [ ] Unit tests: CBOR roundtrip, descriptor embedding, backward compat (old descriptor unchanged)

### D2 — Query Builder
- [ ] Create `aafp-discovery/src/semantic_query.rs`
- [ ] Implement `QueryFilter`, `RangeOp`, `PerformanceFilter`, `QualityFilter`, `CostFilter`, `GeoFilter`, `VersionFilter`
- [ ] Implement `CapabilityQuery` with builder pattern (`new`, `with_filter`, `with_performance`, `with_quality`, `with_cost`, `with_geo`, `with_version`, `build`)
- [ ] Implement `QueryFilter::evaluate()` with key resolution for built-in attributes, custom attributes, and top-level fields
- [ ] Implement `CapabilityQuery::matches()` (full semantic evaluation)
- [ ] Implement `CapabilityQuery::matches_descriptor()` (backward compat fallback)
- [ ] Implement `VersionFilter::matches()`
- [ ] Add `CapabilityDht::find_semantic()` integration method
- [ ] Export module from `aafp-discovery/src/lib.rs`
- [ ] Unit tests: each filter type, combined filters, version, geo, backward compat

### Verification
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo build --workspace` (0 warnings)
- [ ] `cargo clippy --workspace` (0 warnings)
- [ ] `cargo test --workspace` (all existing tests still pass + new tests pass)

---

## Design Constraints

1. **No new crate dependencies** unless absolutely necessary. Use existing `aafp-cbor`, `thiserror`, `sha2`.
2. **Float encoding**: The `aafp_cbor::Value` enum has no Float variant. Encode all `f64` fields as scaled `u64` integers. Document the scaling (e.g., latency in microseconds as `u64`, accuracy as `u64` * 1_000_000).
3. **Canonical CBOR**: All maps must use length-first canonical byte ordering (the `int_map` / `str_map` helpers handle this).
4. **No serde**: Follow the existing pattern of manual `to_cbor()` / `from_cbor()` methods. Do not add serde derives for wire types.
5. **Error handling**: Use `thiserror` for error enums. All `from_cbor` methods return `Result<_, SemanticError>` (or `IdentityError` if extending existing types).
6. **Doc comments**: Every public struct, enum, and method must have a rustdoc comment explaining its purpose and CBOR key assignment where relevant.
7. **Test coverage**: Every `to_cbor`/`from_cbor` pair must have a roundtrip test. Every `QueryFilter` variant must have a match and no-match test.
