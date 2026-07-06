# Builder Prompt: AgentRecord Extensions Phase E3-E4 — Cost/Semantic + Reputation

## Objective

Implement **Phase E3 (Attestation System)** and **Phase E4 (Cost/Semantic/Reputation
Extensions)** of the AgentRecord extension framework in the Rust `aafp-identity`
crate. This phase delivers the cost model, semantic capability, capability
versioning, and reputation extensions, plus the third-party attestation system
with trust-weighted scoring, Sybil resistance, and UCAN-based attestation
authorization.

This builds on the **Phase E1 extension framework** (the `AgentRecordExtension`
trait, key 11 in `AgentRecord`, `to_cbor_without_sig` / `from_cbor` updates)
and **Phase E2 core extensions** (`GeoExtension`, `PerformanceExtension`).
Those phases are assumed to already exist in
`crates/aafp-identity/src/extensions/`. This prompt covers the remaining
extensions and the attestation system.

---

## Reference Materials

- **`AGENT_RECORD_EXTENSIONS.md`** §5.3 (Cost Model), §5.4 (Semantic
  Capability Descriptors), §5.5 (Reputation / Trust Scores), §5.6
  (Capability Versioning), §7 (Security Model for Attested Metrics), §11
  (Implementation Roadmap — Phase E3, E4).
- **`SEMANTIC_CAPABILITY_GRAPHS.md`** §3.1 (SemanticCapability data model,
  `PerformanceProfile`, `QualityMetrics`, `CostModel`, `CapabilityEdge`,
  `SemanticVersion`, `EdgeType`), §7 (Semantic Versioning), §12 (Security
  Considerations) — the per-capability semantic descriptor types that
  `SemanticExtension` and `CapabilityVersionExtension` link to.
- **`implementations/rust/crates/aafp-identity/src/identity_v1.rs`** — the
  `AgentRecord` struct (lines 121-144), `CapabilityDescriptor` (lines
  427-503), `MetadataValue` enum (line 507), `IdentityError` enum (lines
  553-608), `RECORD_DOMAIN_SEPARATOR` (line 15), `KEY_ALG_ML_DSA_65`
  (line 24). The extension map (key 11) is added by Phase E1.
- **`implementations/rust/crates/aafp-identity/src/trust_manager.rs`** —
  `TrustManager` (line 89), `TrustResult` enum (line 51: `Trusted { source,
  level }`, `Untrusted { reason }`, `Revoked { reason }`, `Unknown {
  suggestion }`), `TrustSource` enum (line 23: `Direct`, `WebOfTrust`,
  `CertificateAuthority`, `Directory`, `Tofu`), `verify_peer()` (line 169).
  The `compute_reputation()` function must call `verify_peer()` to determine
  attester trust weight.
- **`implementations/rust/crates/aafp-identity/src/web_of_trust.rs`** —
  trust level constants: `TRUST_LEVEL_NONE` (0), `TRUST_LEVEL_MARGINAL` (1),
  `TRUST_LEVEL_FULL` (2), `TRUST_LEVEL_ULTIMATE` (3). `WebOfTrust` struct,
  `TrustSignature` struct.
- **`implementations/rust/crates/aafp-identity/src/ucan.rs`** — `UcanToken`
  (line 52), `UcanPayload` (line 35: `iss`, `aud`, `cap`, `exp`, `nbf`,
  `prf`), `Capability` struct (line 24: `resource`, `action`, `constraints`),
  `UcanToken::verify()` (line 155), `UcanToken::verify_chain()` (line 198).
  The `attest.reputation` capability uses `resource = "attest.reputation"`,
  `action = "invoke"`.
- **`implementations/rust/crates/aafp-identity/src/keypair.rs`** —
  `AgentKeypair` with `generate()`, `public_key`, `secret_key()`,
  `sign()`. Used for signing attestations.
- **`implementations/rust/crates/aafp-identity/src/agent_id.rs`** —
  `AgentId(pub [u8; 32])`, `AgentId::from_public_key()`,
  `agent_id_to_hex()`.
- **`implementations/rust/crates/aafp-cbor/`** — `Value` enum
  (`Unsigned`, `Negative`, `TextString`, `ByteString`, `Array`, `IntMap`,
  `StrMap`, `Null`, `Bool`), `int_map()`, `int_map_get()`, `str_map()`,
  `encode()`, `decode()`.
- **`implementations/rust/crates/aafp-crypto/`** — `MlDsa65`,
  `MlDsa65PublicKey`, `MlDsa65SecretKey`, `MlDsa65Signature`,
  `SignatureScheme` trait. Attestation signatures use the same
  ML-DSA-65 scheme as AgentRecords.

---

## Files to Create / Modify

```
crates/aafp-identity/src/
  extensions/
    mod.rs               — (Phase E1) AgentRecordExtension trait, re-exports
    geo.rs               — (Phase E2) GeoExtension
    perf.rs              — (Phase E2) PerformanceExtension
    cost.rs              — NEW: CostExtension
    semantic.rs          — NEW: SemanticExtension + SemanticCapabilityData
    capver.rs            — NEW: CapabilityVersionExtension + SemanticVersion
    reputation.rs        — NEW: ReputationExtension
  attestation.rs         — NEW: Attestation, AttestationData, verify(),
                           compute_reputation(), UCAN authorization
  lib.rs                 — MODIFIED: add `pub mod attestation;`,
                           re-export new types
```

If `extensions/mod.rs` already exists from Phase E1/E2, **add** the new
module declarations and re-exports — do not recreate it. If it does not
exist yet, create it with the `AgentRecordExtension` trait (see §1 below)
and all extension modules.

---

## 1. AgentRecordExtension Trait (Phase E1 prerequisite)

If not already present, implement the extension trait in
`extensions/mod.rs`. This is the foundation for all extensions.

```rust
use aafp_cbor::{int_map, int_map_get, Value};
use crate::identity_v1::IdentityError;

/// A versioned extension that can be encoded into the AgentRecord extension
/// map (key 11). Each extension has a namespace string (e.g.,
/// "aafp.cost.v1") and a version number.
pub trait AgentRecordExtension: Sized + Clone {
    /// Namespace string used as the key in the extension map.
    const NAMESPACE: &'static str;

    /// Current extension version (stored in the wrapper's key 1).
    const VERSION: u64;

    /// Encode the extension data to CBOR (the inner data map, not the
    /// version wrapper).
    fn to_cbor(&self) -> Value;

    /// Decode the extension data from CBOR.
    fn from_cbor(val: &Value) -> Result<Self, IdentityError>;

    /// Encode as a full Extension wrapper: `{ 1: version, 2: data }`.
    fn to_extension_cbor(&self) -> Value {
        int_map(vec![
            (1, Value::Unsigned(Self::VERSION)),
            (2, self.to_cbor()),
        ])
    }

    /// Decode from a full Extension wrapper, checking the version field.
    fn from_extension_cbor(val: &Value) -> Result<Self, IdentityError> {
        let version = expect_u64(int_map_get(val, 1), "extension_version")?;
        if version != Self::VERSION {
            return Err(IdentityError::InvalidField {
                field: "extension_version",
                message: format!("expected {}, got {}", Self::VERSION, version),
            });
        }
        let data = int_map_get(val, 2)
            .ok_or(IdentityError::MissingField("extension_data"))?;
        Self::from_cbor(data)
    }
}

fn expect_u64(val: Option<&Value>, field: &'static str) -> Result<u64, IdentityError> {
    match val {
        Some(Value::Unsigned(n)) => Ok(*n),
        Some(other) => Err(IdentityError::InvalidField {
            field,
            message: format!("expected uint, got {:?}", other),
        }),
        None => Err(IdentityError::MissingField(field)),
    }
}
```

The `AgentRecord` struct gains an `extensions: Vec<(String, Value)>` field
(key 11), with `get_extension::<T>()` and `set_extension::<T>(ext)` methods.
These are Phase E1 deliverables — ensure they exist before proceeding.

---

## 2. CostExtension (`extensions/cost.rs`)

Namespace: `"aafp.cost.v1"`. Pricing information for cost-aware agent
selection. All monetary values are in **micro-USD** (1 USD = 1,000,000
micro-USD) to avoid floating point on the wire.

### 2.1 Struct Definition

```rust
use aafp_cbor::{int_map, int_map_get, Value};
use crate::identity_v1::IdentityError;
use super::AgentRecordExtension;

/// Cost model extension (key 11, namespace "aafp.cost.v1").
///
/// CBOR encoding (integer keys inside the data map):
/// ```cbor
/// CostExtensionData = {
///     ? 1: uint,    // per_invocation_micro_usd
///     ? 2: uint,    // per_token_micro_usd
///     ? 3: uint,    // per_second_micro_usd
///     ? 4: bool,    // has_free_tier
///     ? 5: uint,    // free_tier_daily_limit
///     ? 6: tstr,    // currency (ISO 4217, default "USD")
///     7: uint,      // updated_at (unix seconds)
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CostExtension {
    /// Extension version (always 1 for v1).
    pub version: u64,
    /// Cost per invocation in micro-USD (1 USD = 1,000,000 micro-USD).
    /// None = pricing not applicable / not disclosed.
    pub per_invocation_micro_usd: Option<u64>,
    /// Cost per token in micro-USD (for LLM capabilities).
    pub per_token_micro_usd: Option<u64>,
    /// Cost per second of compute in micro-USD.
    pub per_second_micro_usd: Option<u64>,
    /// Whether a free tier is available.
    pub has_free_tier: bool,
    /// Free tier invocation limit per day (None = unlimited).
    pub free_tier_daily_limit: Option<u32>,
    /// Currency code (ISO 4217, default "USD").
    pub currency: String,
    /// When the pricing was last updated (unix seconds).
    pub updated_at: u64,
}
```

### 2.2 Trait Implementation

```rust
impl AgentRecordExtension for CostExtension {
    const NAMESPACE: &'static str = "aafp.cost.v1";
    const VERSION: u64 = 1;

    fn to_cbor(&self) -> Value {
        let mut entries = vec![];
        if let Some(c) = self.per_invocation_micro_usd {
            entries.push((1, Value::Unsigned(c)));
        }
        if let Some(c) = self.per_token_micro_usd {
            entries.push((2, Value::Unsigned(c)));
        }
        if let Some(c) = self.per_second_micro_usd {
            entries.push((3, Value::Unsigned(c)));
        }
        // has_free_tier is always encoded (it's a bool, not Option).
        entries.push((4, Value::Bool(self.has_free_tier)));
        if let Some(limit) = self.free_tier_daily_limit {
            entries.push((5, Value::Unsigned(limit as u64)));
        }
        if !self.currency.is_empty() && self.currency != "USD" {
            entries.push((6, Value::TextString(self.currency.clone())));
        }
        entries.push((7, Value::Unsigned(self.updated_at)));
        int_map(entries)
    }

    fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        Ok(Self {
            version: 1,
            per_invocation_micro_usd: match int_map_get(val, 1) {
                Some(Value::Unsigned(n)) => Some(*n),
                _ => None,
            },
            per_token_micro_usd: match int_map_get(val, 2) {
                Some(Value::Unsigned(n)) => Some(*n),
                _ => None,
            },
            per_second_micro_usd: match int_map_get(val, 3) {
                Some(Value::Unsigned(n)) => Some(*n),
                _ => None,
            },
            has_free_tier: matches!(int_map_get(val, 4), Some(Value::Bool(true))),
            free_tier_daily_limit: match int_map_get(val, 5) {
                Some(Value::Unsigned(n)) => Some(*n as u32),
                _ => None,
            },
            currency: match int_map_get(val, 6) {
                Some(Value::TextString(s)) => s.clone(),
                _ => "USD".to_string(),
            },
            updated_at: match int_map_get(val, 7) {
                Some(Value::Unsigned(n)) => *n,
                _ => 0,
            },
        })
    }
}

impl CostExtension {
    /// Compute the cost of a single invocation given a token count.
    /// Returns micro-USD. If per_invocation is None, only token cost applies.
    pub fn estimate_cost(&self, token_count: u64) -> Option<u64> {
        let inv = self.per_invocation_micro_usd.unwrap_or(0);
        let tok = self.per_token_micro_usd.unwrap_or(0)
            .saturating_mul(token_count);
        let sec = self.per_second_micro_usd.unwrap_or(0);
        if inv == 0 && tok == 0 && sec == 0 {
            return None;
        }
        Some(inv.saturating_add(tok).saturating_add(sec))
    }

    /// Check if a request would fall within the free tier.
    pub fn is_free_eligible(&self, daily_usage: u32) -> bool {
        if !self.has_free_tier {
            return false;
        }
        match self.free_tier_daily_limit {
            Some(limit) => daily_usage < limit,
            None => true, // unlimited free tier
        }
    }
}
```

### 2.3 Usage Example

```rust
use aafp_identity::extensions::cost::CostExtension;

let cost = CostExtension {
    version: 1,
    per_invocation_micro_usd: Some(50),      // $0.00005/invocation
    per_token_micro_usd: Some(2),            // $0.000002/token
    per_second_micro_usd: None,
    has_free_tier: true,
    free_tier_daily_limit: Some(1000),
    currency: "USD".into(),
    updated_at: now,
};

// Encode into a record.
record.set_extension(cost.clone());

// Decode from a record.
let decoded: Option<CostExtension> = record.get_extension();
assert_eq!(decoded, Some(cost));

// Cost estimation.
assert_eq!(cost.estimate_cost(500), Some(50 + 2 * 500)); // 1050 micro-USD
assert!(cost.is_free_eligible(500));   // within limit
assert!(!cost.is_free_eligible(1000)); // at limit
```

---

## 3. SemanticExtension (`extensions/semantic.rs`)

Namespace: `"aafp.semantic.v1"`. Carries agent-level semantic capability
attributes (languages, modalities, hardware, frameworks, precision) and
links to the Track U `SemanticCapability` structures. Per-capability
semantic details go in the enhanced `CapabilityDescriptor` (key 3 — see
§3.3 below).

### 3.1 Struct Definition

```rust
use aafp_cbor::{int_map, int_map_get, Value};
use crate::identity_v1::IdentityError;
use super::AgentRecordExtension;
use super::capver::SemanticVersion;

/// Agent-level semantic capability extension (key 11, namespace
/// "aafp.semantic.v1").
///
/// CBOR encoding:
/// ```cbor
/// SemanticExtensionData = {
///     ? 1: [ *tstr ],   // languages (BCP-47 tags)
///     ? 2: [ *tstr ],   // modalities (text, image, audio, video)
///     ? 3: [ *tstr ],   // hardware (e.g., "gpu:rtx5090")
///     ? 4: [ *tstr ],   // frameworks (e.g., "cuda", "tensorrt")
///     ? 5: [ *tstr ],   // precision (e.g., "fp32", "fp16", "fp8")
///     ? 6: SemanticVersion,  // agent_semver (agent-wide version)
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SemanticExtension {
    pub version: u64,
    /// Agent-wide supported languages (BCP-47 tags, e.g., "en", "fr").
    pub languages: Vec<String>,
    /// Supported modalities: "text", "image", "audio", "video".
    pub modalities: Vec<String>,
    /// Hardware available (e.g., "gpu:rtx5090", "npu:apple-m4").
    pub hardware: Vec<String>,
    /// Software frameworks (e.g., "cuda", "tensorrt", "coreml").
    pub frameworks: Vec<String>,
    /// Precision modes supported (e.g., "fp32", "fp16", "fp8").
    pub precision: Vec<String>,
    /// Agent-wide semantic version (not per-capability; see
    /// CapabilityVersionExtension for per-capability versions).
    pub agent_semver: Option<SemanticVersion>,
}
```

### 3.2 Trait Implementation

```rust
fn str_array(values: &[String]) -> Value {
    Value::Array(values.iter().map(|s| Value::TextString(s.clone())).collect())
}

fn parse_str_array(val: Option<&Value>) -> Vec<String> {
    match val {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| match v {
                Value::TextString(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

impl AgentRecordExtension for SemanticExtension {
    const NAMESPACE: &'static str = "aafp.semantic.v1";
    const VERSION: u64 = 1;

    fn to_cbor(&self) -> Value {
        let mut entries = vec![];
        if !self.languages.is_empty() {
            entries.push((1, str_array(&self.languages)));
        }
        if !self.modalities.is_empty() {
            entries.push((2, str_array(&self.modalities)));
        }
        if !self.hardware.is_empty() {
            entries.push((3, str_array(&self.hardware)));
        }
        if !self.frameworks.is_empty() {
            entries.push((4, str_array(&self.frameworks)));
        }
        if !self.precision.is_empty() {
            entries.push((5, str_array(&self.precision)));
        }
        if let Some(sv) = self.agent_semver {
            entries.push((6, sv.to_cbor()));
        }
        int_map(entries)
    }

    fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        Ok(Self {
            version: 1,
            languages: parse_str_array(int_map_get(val, 1)),
            modalities: parse_str_array(int_map_get(val, 2)),
            hardware: parse_str_array(int_map_get(val, 3)),
            frameworks: parse_str_array(int_map_get(val, 4)),
            precision: parse_str_array(int_map_get(val, 5)),
            agent_semver: match int_map_get(val, 6) {
                Some(v) => Some(SemanticVersion::from_cbor(v)?),
                None => None,
            },
        })
    }
}

impl SemanticExtension {
    /// Check if this agent supports a given language (BCP-47 prefix match).
    /// "en" matches "en-US"; "en-US" does not match "en-GB".
    pub fn supports_language(&self, tag: &str) -> bool {
        let tag_lower = tag.to_lowercase();
        self.languages.iter().any(|l| {
            let l_lower = l.to_lowercase();
            l_lower == tag_lower || tag_lower.starts_with(&format!("{}-", l_lower))
        })
    }

    /// Check if this agent supports a given modality.
    pub fn supports_modality(&self, modality: &str) -> bool {
        self.modalities.iter().any(|m| m == modality)
    }

    /// Check if this agent has a specific hardware resource.
    pub fn has_hardware(&self, hw: &str) -> bool {
        self.hardware.iter().any(|h| h == hw || h.starts_with(&format!("{}:", hw)))
    }
}
```

### 3.3 Per-Capability SemanticCapabilityData

The enhanced `CapabilityDescriptor` (Track U integration) carries an
optional key 3 with `SemanticCapabilityData`. This struct embeds the
`PerformanceProfile`, `QualityMetrics`, `CostModel`, `CapabilityEdge`, and
`SemanticVersion` from `SEMANTIC_CAPABILITY_GRAPHS.md` §3.1.

```rust
/// Per-capability semantic data (key 3 in CapabilityDescriptor-v2).
///
/// This links the AgentRecord extension system to the Track U Semantic
/// Capability Graphs. Agents that don't understand key 3 ignore it and
/// use the base name + metadata.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SemanticCapabilityData {
    /// Structured attributes for multi-dimensional queries.
    pub attributes: CapabilityAttributes,
    /// Performance characteristics (self-reported).
    pub performance: PerformanceProfile,
    /// Quality/trust metrics (self-reported — see Attestation for verified).
    pub quality: QualityMetrics,
    /// Cost model for this specific capability.
    pub cost: CapabilityCostModel,
    /// Dependencies on other capabilities (edges in the graph).
    pub dependencies: Vec<CapabilityEdge>,
    /// Semantic version for this capability.
    pub version: SemanticVersion,
}

/// Structured attributes (subset of SEMANTIC_CAPABILITY_GRAPHS.md §3.1).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityAttributes {
    pub languages: Vec<String>,
    pub modalities: Vec<String>,
    pub hardware: Vec<String>,
    pub frameworks: Vec<String>,
    pub precision: Vec<String>,
}

/// Self-reported performance profile.
/// Uses integer types to avoid floating point on the wire.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PerformanceProfile {
    /// Average latency in milliseconds.
    pub avg_latency_ms: Option<u16>,
    /// P99 latency in milliseconds.
    pub p99_latency_ms: Option<u16>,
    /// Throughput in requests per second.
    pub throughput_rps: Option<u32>,
    /// Maximum batch size supported.
    pub max_batch_size: Option<u32>,
}

/// Self-reported quality metrics. Verified metrics come from attestations.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QualityMetrics {
    /// Trust score (0-100). Self-reported — treat as unverified.
    pub trust_score: u8,
    /// Accuracy metric (0-10000 basis points, 10000 = 100%).
    pub accuracy_bps: Option<u16>,
    /// Uptime percentage (0-10000 basis points).
    pub uptime_bps: Option<u16>,
    /// Total successful invocations.
    pub success_count: u64,
}

/// Per-capability cost model (mirrors CostExtension but scoped to one cap).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityCostModel {
    pub per_invocation_micro_usd: Option<u64>,
    pub per_token_micro_usd: Option<u64>,
    pub has_free_tier: bool,
}

/// A dependency edge to another capability.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityEdge {
    /// Target capability name.
    pub target: String,
    /// Edge type (see EdgeType constants below).
    pub edge_type: u8,
    /// Optional constraint description.
    pub constraint: Option<String>,
}

// Edge type constants (from SEMANTIC_CAPABILITY_GRAPHS.md §3.1).
pub const EDGE_REQUIRES: u8 = 0;
pub const EDGE_ENABLES: u8 = 1;
pub const EDGE_PRECEDES: u8 = 2;
pub const EDGE_ALTERNATIVE: u8 = 3;
pub const EDGE_SPECIALIZES: u8 = 4;
```

The `SemanticCapabilityData` must implement `to_cbor()` / `from_cbor()`
using integer keys within the key-3 sub-map. The `CapabilityDescriptor`
must be updated to carry an `Option<SemanticCapabilityData>` field and
encode it as key 3 when present (backward compatible — old decoders
ignore key 3).

---

## 4. CapabilityVersionExtension (`extensions/capver.rs`)

Namespace: `"aafp.capver.v1"`. Per-capability semantic versions, enabling
queries like "version >= 4.1".

### 4.1 SemanticVersion

```rust
use aafp_cbor::{int_map, int_map_get, Value};
use crate::identity_v1::IdentityError;

/// Semantic version (major.minor.patch).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct SemanticVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl SemanticVersion {
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// Encode as CBOR: `{ 1: major, 2: minor, 3: patch }`.
    pub fn to_cbor(&self) -> Value {
        int_map(vec![
            (1, Value::Unsigned(self.major as u64)),
            (2, Value::Unsigned(self.minor as u64)),
            (3, Value::Unsigned(self.patch as u64)),
        ])
    }

    /// Decode from CBOR.
    pub fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        let major = match int_map_get(val, 1) {
            Some(Value::Unsigned(n)) => *n as u32,
            _ => 0,
        };
        let minor = match int_map_get(val, 2) {
            Some(Value::Unsigned(n)) => *n as u32,
            _ => 0,
        };
        let patch = match int_map_get(val, 3) {
            Some(Value::Unsigned(n)) => *n as u32,
            _ => 0,
        };
        Ok(Self { major, minor, patch })
    }

    /// Check if this version satisfies a minimum requirement.
    pub fn satisfies_min(&self, min: &SemanticVersion) -> bool {
        self >= min
    }

    /// Check if this version is within a range [min, max].
    pub fn satisfies_range(&self, min: &SemanticVersion, max: &SemanticVersion) -> bool {
        self >= min && self <= max
    }

    /// Format as "major.minor.patch" string.
    pub fn to_string(&self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl std::fmt::Display for SemanticVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}
```

### 4.2 CapabilityVersionExtension

```rust
use super::AgentRecordExtension;

/// Per-capability semantic version extension (key 11, namespace
/// "aafp.capver.v1").
///
/// CBOR encoding:
/// ```cbor
/// CapabilityVersionData = {
///     1: [ *{ 1: tstr, 2: SemanticVersion } ],  // versions
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityVersionExtension {
    pub version: u64,
    /// Map: capability_name → SemanticVersion.
    pub versions: Vec<(String, SemanticVersion)>,
}

impl AgentRecordExtension for CapabilityVersionExtension {
    const NAMESPACE: &'static str = "aafp.capver.v1";
    const VERSION: u64 = 1;

    fn to_cbor(&self) -> Value {
        let entries: Vec<Value> = self.versions.iter().map(|(name, sv)| {
            int_map(vec![
                (1, Value::TextString(name.clone())),
                (2, sv.to_cbor()),
            ])
        }).collect();
        int_map(vec![(1, Value::Array(entries))])
    }

    fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        let mut versions = Vec::new();
        if let Some(Value::Array(arr)) = int_map_get(val, 1) {
            for entry in arr {
                let name = match int_map_get(entry, 1) {
                    Some(Value::TextString(s)) => s.clone(),
                    _ => continue,
                };
                let sv = match int_map_get(entry, 2) {
                    Some(v) => SemanticVersion::from_cbor(v)?,
                    None => continue,
                };
                versions.push((name, sv));
            }
        }
        Ok(Self { version: 1, versions })
    }
}

impl CapabilityVersionExtension {
    /// Get the version for a specific capability.
    pub fn get(&self, capability_name: &str) -> Option<&SemanticVersion> {
        self.versions.iter()
            .find(|(name, _)| name == capability_name)
            .map(|(_, sv)| sv)
    }

    /// Set or update the version for a capability.
    pub fn set(&mut self, capability_name: impl Into<String>, sv: SemanticVersion) {
        let name = capability_name.into();
        if let Some(pos) = self.versions.iter().position(|(n, _)| n == &name) {
            self.versions[pos] = (name, sv);
        } else {
            self.versions.push((name, sv));
        }
    }
}
```

---

## 5. ReputationExtension (`extensions/reputation.rs`)

Namespace: `"aafp.reputation.v1"`. **Self-reported reputation is NOT
trustworthy.** This extension carries only *references* to third-party
attestations. The actual attestation documents are stored separately in
the DHT (see §6).

### 5.1 Struct Definition

```rust
use aafp_cbor::{int_map, int_map_get, Value};
use crate::identity_v1::IdentityError;
use super::AgentRecordExtension;

/// Reputation extension: references to third-party attestations.
///
/// The actual trust score is computed by the *discovering* agent from
/// the referenced attestations, weighted by the discovering agent's trust
/// relationship with each attester (see `compute_reputation()` in
/// `attestation.rs`).
///
/// CBOR encoding:
/// ```cbor
/// ReputationExtensionData = {
///     ? 1: [ *tstr ],   // attestation_refs (SHA-256 hashes, hex)
///     ? 2: uint,        // self_claimed_score (0-100, unverified)
///     ? 3: [ *tstr ],   // attestation_sources (DHT keys / URLs)
///     4: uint,          // updated_at (unix seconds)
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReputationExtension {
    pub version: u64,
    /// References to attestation records. Each entry is
    /// SHA-256(attestation_bytes), hex-encoded.
    pub attestation_refs: Vec<String>,
    /// Self-claimed trust score (0-100). Treated as unverified by
    /// consumers. Useful only as a hint, never for ranking.
    pub self_claimed_score: Option<u8>,
    /// URLs or DHT keys where attestations can be fetched.
    pub attestation_sources: Vec<String>,
    /// Last time the agent updated its attestation references.
    pub updated_at: u64,
}

impl AgentRecordExtension for ReputationExtension {
    const NAMESPACE: &'static str = "aafp.reputation.v1";
    const VERSION: u64 = 1;

    fn to_cbor(&self) -> Value {
        let mut entries = vec![];
        if !self.attestation_refs.is_empty() {
            entries.push((1, Value::Array(
                self.attestation_refs.iter()
                    .map(|s| Value::TextString(s.clone()))
                    .collect(),
            )));
        }
        if let Some(score) = self.self_claimed_score {
            entries.push((2, Value::Unsigned(score as u64)));
        }
        if !self.attestation_sources.is_empty() {
            entries.push((3, Value::Array(
                self.attestation_sources.iter()
                    .map(|s| Value::TextString(s.clone()))
                    .collect(),
            )));
        }
        entries.push((4, Value::Unsigned(self.updated_at)));
        int_map(entries)
    }

    fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        let parse_str_arr = |key: usize| -> Vec<String> {
            match int_map_get(val, key) {
                Some(Value::Array(arr)) => arr.iter()
                    .filter_map(|v| match v {
                        Value::TextString(s) => Some(s.clone()),
                        _ => None,
                    }).collect(),
                _ => Vec::new(),
            }
        };
        Ok(Self {
            version: 1,
            attestation_refs: parse_str_arr(1),
            self_claimed_score: match int_map_get(val, 2) {
                Some(Value::Unsigned(n)) => Some(*n as u8),
                _ => None,
            },
            attestation_sources: parse_str_arr(3),
            updated_at: match int_map_get(val, 4) {
                Some(Value::Unsigned(n)) => *n,
                _ => 0,
            },
        })
    }
}
```

---

## 6. Attestation System (`attestation.rs`)

This is the **Phase E3** core deliverable. Third-party attestations are
separate signed documents, stored in the DHT under a different key
namespace. They are **NOT** part of the AgentRecord signature — they are
signed by the attester, not the subject.

### 6.1 Attestation Struct

```rust
use crate::identity_v1::{AgentId, IdentityError, RECORD_DOMAIN_SEPARATOR};
use crate::agent_id::agent_id_to_hex;
use crate::keypair::AgentKeypair;
use aafp_cbor::{encode, int_map, int_map_get, Value};
use aafp_crypto::{MlDsa65, MlDsa65PublicKey, MlDsa65Signature, SignatureScheme};
use sha2::{Digest, Sha256};

/// Domain separator for attestation signatures.
pub const ATTESTATION_DOMAIN_SEPARATOR: &[u8] = b"aafp-v1-attestation";

/// Record type string for attestations.
pub const ATTESTATION_TYPE_V1: &str = "aafp-attestation-v1";

/// A third-party attestation about an agent's performance/reputation.
///
/// CBOR structure (integer keys):
/// ```cbor
/// Attestation = {
///     1: tstr,      // record_type: "aafp-attestation-v1"
///     2: bstr,      // subject_agent_id (32 bytes)
///     3: bstr,      // attester_agent_id (32 bytes)
///     4: bstr,      // attester_public_key (ML-DSA-65, 1952 bytes)
///     5: uint,      // attested_at (unix seconds)
///     6: uint,      // expires_at (unix seconds)
///     7: AttestationData,  // the metrics being attested
///     8: bstr,      // attester_signature
/// }
/// ```
#[derive(Clone, Debug)]
pub struct Attestation {
    pub record_type: String,
    /// The agent being attested about.
    pub subject_agent_id: AgentId,
    /// The agent issuing the attestation.
    pub attester_agent_id: AgentId,
    /// The attester's ML-DSA-65 public key (for signature verification).
    pub attester_public_key: Vec<u8>,
    /// When the attestation was created (unix seconds).
    pub attested_at: u64,
    /// When the attestation expires (unix seconds).
    pub expires_at: u64,
    /// The metrics being attested.
    pub data: AttestationData,
    /// ML-DSA-65 signature over (domain_sep || cbor_without_sig).
    pub signature: Vec<u8>,
}

/// The metrics being attested by a third party.
///
/// CBOR encoding:
/// ```cbor
/// AttestationData = {
///     ? 1: uint,    // observed_avg_latency_ms
///     ? 2: uint,    // observed_success_rate_bps (10000 = 100%)
///     3: uint,      // sample_count
///     4: uint,      // trust_score (0-100)
///     ? 5: tstr,    // notes (max 256 bytes)
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttestationData {
    /// Observed average latency (ms).
    pub observed_avg_latency_ms: Option<u16>,
    /// Observed success rate (basis points, 10000 = 100%).
    pub observed_success_rate_bps: Option<u16>,
    /// Number of interactions the attester observed.
    pub sample_count: u32,
    /// Trust score assigned by the attester (0-100).
    pub trust_score: u8,
    /// Free-text assessment (max 256 bytes).
    pub notes: Option<String>,
}
```

### 6.2 CBOR Encoding

```rust
impl Attestation {
    /// Encode to CBOR, excluding the signature (key 8).
    /// This is the signature input.
    pub fn to_cbor_without_sig(&self) -> Value {
        int_map(vec![
            (1, Value::TextString(self.record_type.clone())),
            (2, Value::ByteString(self.subject_agent_id.0.to_vec())),
            (3, Value::ByteString(self.attester_agent_id.0.to_vec())),
            (4, Value::ByteString(self.attester_public_key.clone())),
            (5, Value::Unsigned(self.attested_at)),
            (6, Value::Unsigned(self.expires_at)),
            (7, self.data.to_cbor()),
        ])
    }

    /// Encode to CBOR with all fields (including signature).
    pub fn to_cbor(&self) -> Value {
        let mut entries = match self.to_cbor_without_sig() {
            Value::IntMap(e) => e,
            _ => unreachable!(),
        };
        entries.push((8, Value::ByteString(self.signature.clone())));
        Value::IntMap(entries)
    }

    /// Decode from CBOR.
    pub fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        let record_type = match int_map_get(val, 1) {
            Some(Value::TextString(s)) => s.clone(),
            _ => return Err(IdentityError::MissingField("record_type")),
        };
        if record_type != ATTESTATION_TYPE_V1 {
            return Err(IdentityError::InvalidRecordType { got: record_type });
        }
        let subject = match int_map_get(val, 2) {
            Some(Value::ByteString(b)) if b.len() == 32 => {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(b);
                AgentId(arr)
            }
            _ => return Err(IdentityError::MissingField("subject_agent_id")),
        };
        let attester = match int_map_get(val, 3) {
            Some(Value::ByteString(b)) if b.len() == 32 => {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(b);
                AgentId(arr)
            }
            _ => return Err(IdentityError::MissingField("attester_agent_id")),
        };
        let attester_pk = match int_map_get(val, 4) {
            Some(Value::ByteString(b)) => b.clone(),
            _ => return Err(IdentityError::MissingField("attester_public_key")),
        };
        let attested_at = match int_map_get(val, 5) {
            Some(Value::Unsigned(n)) => *n,
            _ => return Err(IdentityError::MissingField("attested_at")),
        };
        let expires_at = match int_map_get(val, 6) {
            Some(Value::Unsigned(n)) => *n,
            _ => return Err(IdentityError::MissingField("expires_at")),
        };
        let data = match int_map_get(val, 7) {
            Some(v) => AttestationData::from_cbor(v)?,
            None => return Err(IdentityError::MissingField("data")),
        };
        let signature = match int_map_get(val, 8) {
            Some(Value::ByteString(b)) => b.clone(),
            _ => Vec::new(),
        };
        Ok(Self {
            record_type,
            subject_agent_id: subject,
            attester_agent_id: attester,
            attester_public_key: attester_pk,
            attested_at,
            expires_at,
            data,
            signature,
        })
    }

    /// Compute the DHT storage key for this attestation.
    /// Key = SHA-256(b"aafp-attestation" || subject || attester)
    pub fn dht_key(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"aafp-attestation");
        h.update(self.subject_agent_id.0);
        h.update(self.attester_agent_id.0);
        let result = h.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&result);
        key
    }
}

impl AttestationData {
    pub fn to_cbor(&self) -> Value {
        let mut entries = vec![];
        if let Some(lat) = self.observed_avg_latency_ms {
            entries.push((1, Value::Unsigned(lat as u64)));
        }
        if let Some(bps) = self.observed_success_rate_bps {
            entries.push((2, Value::Unsigned(bps as u64)));
        }
        entries.push((3, Value::Unsigned(self.sample_count as u64)));
        entries.push((4, Value::Unsigned(self.trust_score as u64)));
        if let Some(notes) = &self.notes {
            entries.push((5, Value::TextString(notes.clone())));
        }
        int_map(entries)
    }

    pub fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        Ok(Self {
            observed_avg_latency_ms: match int_map_get(val, 1) {
                Some(Value::Unsigned(n)) => Some(*n as u16),
                _ => None,
            },
            observed_success_rate_bps: match int_map_get(val, 2) {
                Some(Value::Unsigned(n)) => Some(*n as u16),
                _ => None,
            },
            sample_count: match int_map_get(val, 3) {
                Some(Value::Unsigned(n)) => *n as u32,
                _ => 0,
            },
            trust_score: match int_map_get(val, 4) {
                Some(Value::Unsigned(n)) => *n as u8,
                _ => 0,
            },
            notes: match int_map_get(val, 5) {
                Some(Value::TextString(s)) => Some(s.clone()),
                _ => None,
            },
        })
    }
}
```

### 6.3 Signing and Verification

```rust
impl Attestation {
    /// Create a new attestation and sign it with the attester's key.
    /// The attester signs over (domain_sep || cbor_without_sig).
    pub fn create_and_sign(
        attester: &AgentKeypair,
        subject_agent_id: AgentId,
        expires_at: u64,
        data: AttestationData,
        now: u64,
    ) -> Result<Self, IdentityError> {
        let attester_id = AgentId::from_public_key(&attester.public_key);
        let mut att = Self {
            record_type: ATTESTATION_TYPE_V1.to_string(),
            subject_agent_id,
            attester_agent_id: attester_id,
            attester_public_key: attester.public_key.clone(),
            attested_at: now,
            expires_at,
            data,
            signature: Vec::new(),
        };
        att.sign(attester.secret_key()?)?;
        Ok(att)
    }

    /// Sign the attestation with the given secret key.
    /// The attester's AgentId must match the key.
    pub fn sign(&mut self, secret_key: &aafp_crypto::MlDsa65SecretKey) -> Result<(), IdentityError> {
        let cbor = self.to_cbor_without_sig();
        let bytes = encode(&cbor).map_err(|e| IdentityError::InvalidField {
            field: "attestation",
            message: e.to_string(),
        })?;
        let mut input = Vec::new();
        input.extend_from_slice(ATTESTATION_DOMAIN_SEPARATOR);
        input.extend_from_slice(&bytes);
        self.signature = aafp_crypto::MlDsa65::sign(secret_key, &input)
            .map_err(|_| IdentityError::SignatureVerificationFailed)?
            .to_bytes()
            .to_vec();
        Ok(())
    }

    /// Verify the attestation's signature and validity.
    ///
    /// Checks:
    /// 1. attester_agent_id == SHA-256(attester_public_key)
    /// 2. Signature is valid over (domain_sep || cbor_without_sig)
    /// 3. Not expired (expires_at > now)
    /// 4. record_type == "aafp-attestation-v1"
    pub fn verify(&self, now: u64) -> Result<(), IdentityError> {
        // 1. Verify attester_agent_id derivation.
        let computed = AgentId::from_public_key(&self.attester_public_key);
        if self.attester_agent_id != computed {
            return Err(IdentityError::InvalidAgentId);
        }

        // 2. Verify record_type.
        if self.record_type != ATTESTATION_TYPE_V1 {
            return Err(IdentityError::InvalidRecordType {
                got: self.record_type.clone(),
            });
        }

        // 3. Verify signature.
        let cbor = self.to_cbor_without_sig();
        let bytes = encode(&cbor).map_err(|e| IdentityError::InvalidField {
            field: "attestation",
            message: e.to_string(),
        })?;
        let mut input = Vec::new();
        input.extend_from_slice(ATTESTATION_DOMAIN_SEPARATOR);
        input.extend_from_slice(&bytes);

        let pk = MlDsa65PublicKey::from_bytes(&self.attester_public_key)?;
        let sig = MlDsa65Signature::from_bytes(&self.signature)?;
        if !MlDsa65::verify(&pk, &input, &sig) {
            return Err(IdentityError::SignatureVerificationFailed);
        }

        // 4. Check expiry.
        if self.expires_at <= now {
            return Err(IdentityError::Expired {
                expires_at: self.expires_at,
                now,
            });
        }

        Ok(())
    }
}
```

### 6.4 Trust-Weighted Reputation Scoring

The `compute_reputation()` function aggregates attestations weighted by
the discovering agent's trust level with each attester. This uses the
existing `TrustManager` from `trust_manager.rs`.

```rust
use crate::trust_manager::{TrustManager, TrustResult, TrustSource};
use crate::web_of_trust::{
    TRUST_LEVEL_FULL, TRUST_LEVEL_MARGINAL, TRUST_LEVEL_NONE, TRUST_LEVEL_ULTIMATE,
};

/// Compute a weighted reputation score from multiple attestations.
///
/// Each attestation's `trust_score` is weighted by the discovering agent's
/// trust level with the attester (via `TrustManager::verify_peer()`).
/// Self-attestations (attester == subject) are excluded entirely.
/// Expired or invalid attestations are skipped.
///
/// Returns a weighted average trust score (0.0–100.0), or None if no
/// valid weighted attestations exist.
///
/// Weight mapping:
/// - Ultimate (level 3): 1.0 (but self-attestations excluded)
/// - Full (level 2): 1.0
/// - Marginal (level 1): 0.5
/// - None (level 0): 0.0
/// - Unknown (TOFU): 0.1 (small weight, not zero — allows bootstrapping)
/// - Untrusted / Revoked: 0.0
///
/// Additionally, attestations with low `sample_count` are discounted:
/// - sample_count < 10: weight *= 0.3
/// - sample_count < 100: weight *= 0.7
/// - sample_count >= 100: weight *= 1.0
pub fn compute_reputation(
    attestations: &[Attestation],
    trust_manager: &TrustManager,
    now: u64,
) -> Option<f64> {
    let mut weighted_sum = 0.0;
    let mut total_weight = 0.0;

    for att in attestations {
        // Skip invalid or expired attestations.
        if att.verify(now).is_err() {
            continue;
        }

        // Self-attestations (attester == subject) get zero weight.
        if att.attester_agent_id == att.subject_agent_id {
            continue;
        }

        // Determine trust level for the attester.
        let trust = trust_manager.verify_peer(
            &att.attester_agent_id,
            &att.attester_public_key,
            None, // No CA cert for attester in this context
            now,
        );
        let weight = match trust {
            TrustResult::Trusted { level, .. } => match level {
                TRUST_LEVEL_ULTIMATE => 1.0,
                TRUST_LEVEL_FULL => 1.0,
                TRUST_LEVEL_MARGINAL => 0.5,
                _ => 0.0,
            },
            TrustResult::Unknown { .. } => 0.1, // TOFU: small weight
            _ => 0.0, // Untrusted or Revoked
        };

        if weight == 0.0 {
            continue;
        }

        // Discount low-sample attestations (Sybil resistance).
        let sample_factor = if att.data.sample_count < 10 {
            0.3
        } else if att.data.sample_count < 100 {
            0.7
        } else {
            1.0
        };

        let final_weight = weight * sample_factor;
        weighted_sum += final_weight * att.data.trust_score as f64;
        total_weight += final_weight;
    }

    if total_weight > 0.0 {
        Some(weighted_sum / total_weight)
    } else {
        None
    }
}
```

### 6.5 Sybil Resistance

Sybil attacks (creating many identities to attest each other) are
mitigated by:

1. **Web of Trust**: `TrustManager::verify_peer()` requires transitive
   trust from known anchors. Sybil identities have no WoT path from real
   agents, so they get `TrustResult::Unknown` (weight 0.1) or
   `TrustResult::Untrusted` (weight 0.0).
2. **Self-attestation exclusion**: `compute_reputation()` skips
   attestations where `attester_agent_id == subject_agent_id`.
3. **Sample count discounting**: Low-sample attestations
   (`sample_count < 10`) get a 0.3× weight multiplier. An attacker must
   observe real interactions to produce high-weight attestations.
4. **CA attestation**: Agents with CA-signed certificates get
   `TrustResult::Trusted { level: Full }`, giving their attestations
   weight 1.0. Sybil identities cannot obtain CA certs without
   out-of-band verification.
5. **Rate limiting**: `KeyDirectory` already rate-limits publishing to
   1/AgentId/hour. Attestation publishing should have similar limits
   (future work).

### 6.6 UCAN Integration: `attest.reputation` Capability Delegation

UCAN tokens delegate *capabilities*, not reputation directly. However,
UCAN and attestations compose: an agent with a UCAN delegation for
`attest.reputation` on a target AgentId is authorized to issue
attestations about that agent.

```rust
use crate::ucan::{UcanToken, Capability};

/// Verify that an attestation is backed by a valid UCAN delegation chain
/// granting the `attest.reputation` capability to the attester.
///
/// Checks:
/// 1. The UCAN chain is valid (signatures, linkage, no capability expansion).
/// 2. The leaf token delegates `attest.reputation` with `invoke` action.
/// 3. The leaf token's audience (`aud`) matches the attester's AgentId.
/// 4. The chain is not expired.
///
/// This allows *delegated attestation*: "Agent A delegates to Agent B the
/// right to attest to A's performance."
pub fn verify_attestation_authorization(
    attestation: &Attestation,
    ucan_chain: &[&UcanToken],
    root_public_key: &[u8],
) -> Result<(), IdentityError> {
    // 1. Verify the UCAN chain.
    UcanToken::verify_chain(ucan_chain, root_public_key)?;

    // 2. Check that the leaf delegates "attest.reputation" with "invoke".
    let leaf = ucan_chain.last().ok_or(IdentityError::InvalidField {
        field: "ucan_chain",
        message: "empty chain".into(),
    })?;
    let has_attest_cap = leaf.payload.cap.iter().any(|c| {
        c.resource == "attest.reputation" && c.action == "invoke"
    });
    if !has_attest_cap {
        return Err(IdentityError::InvalidField {
            field: "ucan_chain",
            message: "no attest.reputation capability in chain".into(),
        });
    }

    // 3. Check that the leaf's audience matches the attester.
    let attester_id_hex = agent_id_to_hex(&attestation.attester_agent_id);
    if leaf.payload.aud != attester_id_hex {
        return Err(IdentityError::InvalidField {
            field: "ucan_chain",
            message: format!(
                "UCAN audience {} does not match attester {}",
                leaf.payload.aud, attester_id_hex
            ),
        });
    }

    Ok(())
}

/// Create a UCAN token delegating the `attest.reputation` capability.
///
/// This is used by an agent (the issuer) to authorize another agent (the
/// audience) to issue attestations about the issuer's performance.
pub fn delegate_attest_capability(
    issuer: &AgentKeypair,
    audience: &AgentId,
    expires_at: u64,
) -> Result<UcanToken, IdentityError> {
    UcanToken::delegate(
        issuer,
        audience,
        vec![Capability {
            resource: "attest.reputation".into(),
            action: "invoke".into(),
            constraints: None,
        }],
        expires_at,
    )
}
```

---

## 7. Module Registration (`lib.rs`)

Update `crates/aafp-identity/src/lib.rs` to register the new modules and
re-export the public types.

```rust
// Add after existing module declarations:
pub mod attestation;

// In the extensions submodule (if using a directory):
pub mod extensions {
    pub mod cost;
    pub mod semantic;
    pub mod capver;
    pub mod reputation;

    pub use cost::CostExtension;
    pub use semantic::{SemanticExtension, SemanticCapabilityData, CapabilityEdge};
    pub use capver::{CapabilityVersionExtension, SemanticVersion};
    pub use reputation::ReputationExtension;

    // Re-export the trait (from Phase E1).
    pub use super::extensions_mod::AgentRecordExtension;
}

// Re-export attestation types at crate root.
pub use attestation::{
    Attestation, AttestationData, ATTESTATION_DOMAIN_SEPARATOR, ATTESTATION_TYPE_V1,
    compute_reputation, verify_attestation_authorization, delegate_attest_capability,
};
```

If `extensions` is already a module from Phase E1/E2, **add** the new
submodule declarations and re-exports rather than recreating the module.

---

## 8. Testing Requirements

All tests go in the respective module files under `#[cfg(test)] mod tests`.

### 8.1 CostExtension Tests (`extensions/cost.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use aafp_cbor::{decode, encode};

    #[test]
    fn cost_extension_roundtrip() {
        let cost = CostExtension {
            version: 1,
            per_invocation_micro_usd: Some(50),
            per_token_micro_usd: Some(2),
            per_second_micro_usd: None,
            has_free_tier: true,
            free_tier_daily_limit: Some(1000),
            currency: "USD".into(),
            updated_at: 1_000_000,
        };
        let cbor = cost.to_extension_cbor();
        let bytes = encode(&cbor).unwrap();
        let decoded_val = decode(&bytes).unwrap();
        let decoded = CostExtension::from_extension_cbor(&decoded_val).unwrap();
        assert_eq!(decoded, cost);
    }

    #[test]
    fn cost_extension_default_currency() {
        // When currency field (key 6) is absent, default to "USD".
        let cbor = int_map(vec![
            (1, Value::Unsigned(100)),
            (4, Value::Bool(true)),
            (7, Value::Unsigned(500)),
        ]);
        let cost = CostExtension::from_cbor(&cbor).unwrap();
        assert_eq!(cost.currency, "USD");
        assert_eq!(cost.per_invocation_micro_usd, Some(100));
        assert!(cost.has_free_tier);
    }

    #[test]
    fn cost_extension_estimate() {
        let cost = CostExtension {
            per_invocation_micro_usd: Some(50),
            per_token_micro_usd: Some(2),
            ..Default::default()
        };
        assert_eq!(cost.estimate_cost(500), Some(1050));
        assert_eq!(cost.estimate_cost(0), Some(50));
    }

    #[test]
    fn cost_extension_free_tier() {
        let cost = CostExtension {
            has_free_tier: true,
            free_tier_daily_limit: Some(100),
            ..Default::default()
        };
        assert!(cost.is_free_eligible(50));
        assert!(cost.is_free_eligible(99));
        assert!(!cost.is_free_eligible(100));
        assert!(!cost.is_free_eligible(101));
    }

    #[test]
    fn cost_extension_no_pricing() {
        let cost = CostExtension::default();
        assert_eq!(cost.estimate_cost(100), None);
        assert!(!cost.is_free_eligible(0));
    }
}
```

### 8.2 SemanticExtension Tests (`extensions/semantic.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use aafp_cbor::{decode, encode};

    #[test]
    fn semantic_extension_roundtrip() {
        let sem = SemanticExtension {
            version: 1,
            languages: vec!["en".into(), "fr".into()],
            modalities: vec!["text".into(), "image".into()],
            hardware: vec!["gpu:rtx5090".into()],
            frameworks: vec!["cuda".into(), "tensorrt".into()],
            precision: vec!["fp32".into(), "fp16".into(), "fp8".into()],
            agent_semver: Some(SemanticVersion::new(2, 0, 1)),
        };
        let cbor = sem.to_extension_cbor();
        let bytes = encode(&cbor).unwrap();
        let decoded_val = decode(&bytes).unwrap();
        let decoded = SemanticExtension::from_extension_cbor(&decoded_val).unwrap();
        assert_eq!(decoded, sem);
    }

    #[test]
    fn semantic_extension_empty_roundtrip() {
        let sem = SemanticExtension::default();
        let cbor = sem.to_extension_cbor();
        let bytes = encode(&cbor).unwrap();
        let decoded_val = decode(&bytes).unwrap();
        let decoded = SemanticExtension::from_extension_cbor(&decoded_val).unwrap();
        assert_eq!(decoded, sem);
    }

    #[test]
    fn semantic_extension_language_match() {
        let sem = SemanticExtension {
            languages: vec!["en".into()],
            ..Default::default()
        };
        assert!(sem.supports_language("en"));
        assert!(sem.supports_language("en-US"));
        assert!(sem.supports_language("EN-us")); // case-insensitive
        assert!(!sem.supports_language("fr"));
    }

    #[test]
    fn semantic_extension_modality_check() {
        let sem = SemanticExtension {
            modalities: vec!["text".into(), "audio".into()],
            ..Default::default()
        };
        assert!(sem.supports_modality("text"));
        assert!(sem.supports_modality("audio"));
        assert!(!sem.supports_modality("video"));
    }

    #[test]
    fn semantic_extension_hardware_check() {
        let sem = SemanticExtension {
            hardware: vec!["gpu:rtx5090".into(), "npu:apple-m4".into()],
            ..Default::default()
        };
        assert!(sem.has_hardware("gpu"));
        assert!(sem.has_hardware("npu"));
        assert!(!sem.has_hardware("tpu"));
    }
}
```

### 8.3 CapabilityVersionExtension Tests (`extensions/capver.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_ordering() {
        let v1 = SemanticVersion::new(1, 0, 0);
        let v2 = SemanticVersion::new(1, 0, 1);
        let v3 = SemanticVersion::new(1, 1, 0);
        let v4 = SemanticVersion::new(2, 0, 0);
        assert!(v1 < v2);
        assert!(v2 < v3);
        assert!(v3 < v4);
    }

    #[test]
    fn semver_satisfies_min() {
        let v = SemanticVersion::new(4, 1, 2);
        assert!(v.satisfies_min(&SemanticVersion::new(4, 1, 0)));
        assert!(v.satisfies_min(&SemanticVersion::new(4, 1, 2)));
        assert!(!v.satisfies_min(&SemanticVersion::new(4, 2, 0)));
        assert!(!v.satisfies_min(&SemanticVersion::new(5, 0, 0)));
    }

    #[test]
    fn semver_satisfies_range() {
        let v = SemanticVersion::new(3, 5, 0);
        assert!(v.satisfies_range(
            &SemanticVersion::new(3, 0, 0),
            &SemanticVersion::new(3, 9, 9),
        ));
        assert!(!v.satisfies_range(
            &SemanticVersion::new(3, 6, 0),
            &SemanticVersion::new(4, 0, 0),
        ));
    }

    #[test]
    fn semver_display() {
        let v = SemanticVersion::new(4, 1, 2);
        assert_eq!(v.to_string(), "4.1.2");
    }

    #[test]
    fn capver_extension_roundtrip() {
        let ext = CapabilityVersionExtension {
            version: 1,
            versions: vec![
                ("inference".into(), SemanticVersion::new(4, 1, 2)),
                ("translation".into(), SemanticVersion::new(2, 0, 0)),
            ],
        };
        let cbor = ext.to_extension_cbor();
        let decoded = CapabilityVersionExtension::from_extension_cbor(&cbor).unwrap();
        assert_eq!(decoded, ext);
    }

    #[test]
    fn capver_get_and_set() {
        let mut ext = CapabilityVersionExtension::default();
        ext.set("ocr", SemanticVersion::new(1, 0, 0));
        assert_eq!(ext.get("ocr"), Some(&SemanticVersion::new(1, 0, 0)));
        assert_eq!(ext.get("inference"), None);
        ext.set("ocr", SemanticVersion::new(1, 1, 0));
        assert_eq!(ext.get("ocr"), Some(&SemanticVersion::new(1, 1, 0)));
        assert_eq!(ext.versions.len(), 1); // updated, not added
    }
}
```

### 8.4 ReputationExtension Tests (`extensions/reputation.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reputation_extension_roundtrip() {
        let rep = ReputationExtension {
            version: 1,
            attestation_refs: vec![
                "a1b2c3d4e5f6".into(),
                "deadbeefcafe".into(),
            ],
            self_claimed_score: Some(85),
            attestation_sources: vec!["dht://attestation/agent123".into()],
            updated_at: 1_000_000,
        };
        let cbor = rep.to_extension_cbor();
        let decoded = ReputationExtension::from_extension_cbor(&cbor).unwrap();
        assert_eq!(decoded, rep);
    }

    #[test]
    fn reputation_extension_empty() {
        let rep = ReputationExtension {
            version: 1,
            updated_at: 500,
            ..Default::default()
        };
        let cbor = rep.to_extension_cbor();
        let decoded = ReputationExtension::from_extension_cbor(&cbor).unwrap();
        assert_eq!(decoded, rep);
        assert!(decoded.attestation_refs.is_empty());
        assert!(decoded.self_claimed_score.is_none());
    }
}
```

### 8.5 Attestation Tests (`attestation.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::keypair::AgentKeypair;
    use crate::trust_manager::TrustManager;
    use crate::web_of_trust::{TrustSignature, TRUST_LEVEL_FULL};
    use aafp_cbor::{decode, encode};

    fn now() -> u64 { 1_000_000 }
    fn future() -> u64 { now() + 86400 }

    fn make_keypair() -> AgentKeypair {
        AgentKeypair::generate()
    }

    #[test]
    fn attestation_sign_and_verify() {
        let attester = make_keypair();
        let subject_id = AgentId::from_public_key(&make_keypair().public_key);

        let att = Attestation::create_and_sign(
            &attester,
            subject_id,
            future(),
            AttestationData {
                observed_avg_latency_ms: Some(14),
                observed_success_rate_bps: Some(9999),
                sample_count: 500,
                trust_score: 92,
                notes: Some("reliable".into()),
            },
            now(),
        ).unwrap();

        // Valid attestation verifies.
        assert!(att.verify(now()).is_ok());
    }

    #[test]
    fn attestation_rejects_wrong_key() {
        let attester = make_keypair();
        let other = make_keypair();
        let subject_id = AgentId::from_public_key(&make_keypair().public_key);

        let mut att = Attestation::create_and_sign(
            &attester,
            subject_id,
            future(),
            AttestationData {
                sample_count: 10,
                trust_score: 80,
                ..Default::default()
            },
            now(),
        ).unwrap();

        // Tamper: replace attester_public_key with a different key.
        att.attester_public_key = other.public_key.clone();
        // Now attester_agent_id no longer matches the public key.
        assert!(att.verify(now()).is_err());
    }

    #[test]
    fn attestation_expired() {
        let attester = make_keypair();
        let subject_id = AgentId::from_public_key(&make_keypair().public_key);

        let att = Attestation::create_and_sign(
            &attester,
            subject_id,
            now() + 100, // expires soon
            AttestationData {
                sample_count: 50,
                trust_score: 70,
                ..Default::default()
            },
            now(),
        ).unwrap();

        // Not yet expired.
        assert!(att.verify(now()).is_ok());
        // Expired.
        assert!(att.verify(now() + 200).is_err());
    }

    #[test]
    fn attestation_cbor_roundtrip() {
        let attester = make_keypair();
        let subject_id = AgentId::from_public_key(&make_keypair().public_key);

        let att = Attestation::create_and_sign(
            &attester,
            subject_id,
            future(),
            AttestationData {
                observed_avg_latency_ms: Some(20),
                observed_success_rate_bps: Some(9500),
                sample_count: 100,
                trust_score: 85,
                notes: Some("good performance".into()),
            },
            now(),
        ).unwrap();

        let cbor = att.to_cbor();
        let bytes = encode(&cbor).unwrap();
        let decoded_val = decode(&bytes).unwrap();
        let decoded = Attestation::from_cbor(&decoded_val).unwrap();

        assert_eq!(decoded.record_type, att.record_type);
        assert_eq!(decoded.subject_agent_id, att.subject_agent_id);
        assert_eq!(decoded.attester_agent_id, att.attester_agent_id);
        assert_eq!(decoded.attester_public_key, att.attester_public_key);
        assert_eq!(decoded.attested_at, att.attested_at);
        assert_eq!(decoded.expires_at, att.expires_at);
        assert_eq!(decoded.data, att.data);
        assert_eq!(decoded.signature, att.signature);
        // Decoded attestation should also verify.
        assert!(decoded.verify(now()).is_ok());
    }

    #[test]
    fn attestation_dht_key_deterministic() {
        let attester = make_keypair();
        let subject_id = AgentId::from_public_key(&make_keypair().public_key);

        let att1 = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 1, trust_score: 50, ..Default::default() },
            now(),
        ).unwrap();
        let att2 = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 999, trust_score: 99, ..Default::default() },
            now(),
        ).unwrap();

        // Same subject + attester → same DHT key (overwrites previous).
        assert_eq!(att1.dht_key(), att2.dht_key());
    }

    #[test]
    fn compute_reputation_with_trusted_attesters() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let attester1 = make_keypair();
        let attester1_id = AgentId::from_public_key(&attester1.public_key);
        let attester2 = make_keypair();
        let attester2_id = AgentId::from_public_key(&attester2.public_key);
        let subject = make_keypair();
        let subject_id = AgentId::from_public_key(&subject.public_key);

        let tm = TrustManager::new(discovering_id);

        // Discovering agent trusts attester1 at Full level via WoT.
        let sig = TrustSignature::new(
            discovering_id,
            attester1_id,
            &attester1.public_key,
            TRUST_LEVEL_FULL,
            future(),
            &discovering.secret_key().unwrap(),
        ).unwrap();
        tm.wot().add_trust_signature(sig);

        // attester2 is unknown to the discovering agent (TOFU, weight 0.1).
        let att1 = Attestation::create_and_sign(
            &attester1, subject_id, future(),
            AttestationData { sample_count: 200, trust_score: 90, ..Default::default() },
            now(),
        ).unwrap();
        let att2 = Attestation::create_and_sign(
            &attester2, subject_id, future(),
            AttestationData { sample_count: 200, trust_score: 50, ..Default::default() },
            now(),
        ).unwrap();

        let score = compute_reputation(&[att1, att2], &tm, now());
        assert!(score.is_some());
        let s = score.unwrap();
        // attester1 weight=1.0, attester2 weight=0.1
        // weighted = (1.0*90 + 0.1*50) / (1.0 + 0.1) = 95/1.1 ≈ 86.36
        assert!(s > 85.0 && s < 87.0);
    }

    #[test]
    fn compute_reputation_excludes_self_attestation() {
        let agent = make_keypair();
        let agent_id = AgentId::from_public_key(&agent.public_key);
        let tm = TrustManager::new(agent_id);

        // Agent attests about itself.
        let self_att = Attestation::create_and_sign(
            &agent, agent_id, future(),
            AttestationData { sample_count: 100, trust_score: 100, ..Default::default() },
            now(),
        ).unwrap();

        let score = compute_reputation(&[self_att], &tm, now());
        assert!(score.is_none()); // self-attestation excluded
    }

    #[test]
    fn compute_reputation_skips_expired() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let attester = make_keypair();
        let attester_id = AgentId::from_public_key(&attester.public_key);
        let subject = make_keypair();
        let subject_id = AgentId::from_public_key(&subject.public_key);

        let tm = TrustManager::new(discovering_id);
        // Direct trust → weight 1.0.
        tm.add_direct_trust(attester_id, attester.public_key.clone());

        let expired_att = Attestation::create_and_sign(
            &attester, subject_id,
            now() + 50, // expires in 50s
            AttestationData { sample_count: 100, trust_score: 80, ..Default::default() },
            now(),
        ).unwrap();

        // At now()+100, the attestation is expired.
        let score = compute_reputation(&[expired_att], &tm, now() + 100);
        assert!(score.is_none());
    }

    #[test]
    fn compute_reputation_low_sample_discount() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let attester = make_keypair();
        let attester_id = AgentId::from_public_key(&attester.public_key);
        let subject = make_keypair();
        let subject_id = AgentId::from_public_key(&subject.public_key);

        let tm = TrustManager::new(discovering_id);
        tm.add_direct_trust(attester_id, attester.public_key.clone());

        // Low sample (5 < 10) → weight *= 0.3.
        let low_sample = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 5, trust_score: 100, ..Default::default() },
            now(),
        ).unwrap();
        // High sample (200 >= 100) → weight *= 1.0.
        let high_sample = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 200, trust_score: 50, ..Default::default() },
            now(),
        ).unwrap();

        let score = compute_reputation(&[low_sample, high_sample], &tm, now()).unwrap();
        // weighted = (0.3*100 + 1.0*50) / (0.3 + 1.0) = 80/1.3 ≈ 61.5
        assert!(score > 60.0 && score < 63.0);
    }

    #[test]
    fn compute_reputation_no_valid_attestations() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let tm = TrustManager::new(discovering_id);

        // No attestations at all.
        let score = compute_reputation(&[], &tm, now());
        assert!(score.is_none());
    }

    #[test]
    fn ucan_attestation_authorization() {
        let issuer = make_keypair();
        let attester = make_keypair();
        let attester_id = AgentId::from_public_key(&attester.public_key);

        // Issuer delegates attest.reputation to attester.
        let token = delegate_attest_capability(&issuer, &attester_id, future()).unwrap();

        // Create an attestation by the attester.
        let subject_id = AgentId::from_public_key(&make_keypair().public_key);
        let att = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 50, trust_score: 80, ..Default::default() },
            now(),
        ).unwrap();

        // Verify the UCAN chain authorizes this attestation.
        let chain = vec![&token];
        let result = verify_attestation_authorization(&att, &chain, &issuer.public_key);
        assert!(result.is_ok());
    }

    #[test]
    fn ucan_attestation_authorization_wrong_audience() {
        let issuer = make_keypair();
        let attester = make_keypair();
        let wrong_attester = make_keypair();
        let wrong_attester_id = AgentId::from_public_key(&wrong_attester.public_key);

        // Delegate to wrong_attester, but the attestation is from attester.
        let token = delegate_attest_capability(
            &issuer, &wrong_attester_id, future(),
        ).unwrap();

        let attester_id = AgentId::from_public_key(&attester.public_key);
        let subject_id = AgentId::from_public_key(&make_keypair().public_key);
        let att = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 50, trust_score: 80, ..Default::default() },
            now(),
        ).unwrap();

        let chain = vec![&token];
        let result = verify_attestation_authorization(&att, &chain, &issuer.public_key);
        assert!(result.is_err()); // audience mismatch
    }

    #[test]
    fn ucan_attestation_no_attest_capability() {
        let issuer = make_keypair();
        let attester = make_keypair();
        let attester_id = AgentId::from_public_key(&attester.public_key);

        // Delegate a different capability (not attest.reputation).
        use crate::ucan::Capability;
        let token = UcanToken::delegate(
            &issuer, &attester_id,
            vec![Capability {
                resource: "compute.inference".into(),
                action: "invoke".into(),
                constraints: None,
            }],
            future(),
        ).unwrap();

        let subject_id = AgentId::from_public_key(&make_keypair().public_key);
        let att = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 50, trust_score: 80, ..Default::default() },
            now(),
        ).unwrap();

        let chain = vec![&token];
        let result = verify_attestation_authorization(&att, &chain, &issuer.public_key);
        assert!(result.is_err()); // no attest.reputation capability
    }
}
```

### 8.6 Integration Test: Full Record with Extensions

```rust
#[test]
fn record_with_all_extensions() {
    use crate::identity_v1::{AgentRecord, CapabilityDescriptor, KEY_ALG_ML_DSA_65};
    use crate::extensions::{CostExtension, SemanticExtension,
        CapabilityVersionExtension, ReputationExtension, SemanticVersion};

    let kp = AgentKeypair::generate();
    let now = 1_000_000u64;

    let mut record = AgentRecord::new(
        &kp.public_key,
        vec![CapabilityDescriptor::new("inference")],
        vec!["quic://1.2.3.4:4433".into()],
        now,
        now + 7 * 86400,
        KEY_ALG_ML_DSA_65,
    );

    // Add all four extensions from this phase.
    record.set_extension(CostExtension {
        per_invocation_micro_usd: Some(50),
        per_token_micro_usd: Some(2),
        has_free_tier: true,
        free_tier_daily_limit: Some(1000),
        currency: "USD".into(),
        updated_at: now,
        ..Default::default()
    });

    record.set_extension(SemanticExtension {
        languages: vec!["en".into(), "fr".into()],
        modalities: vec!["text".into()],
        hardware: vec!["gpu:rtx5090".into()],
        frameworks: vec!["cuda".into()],
        precision: vec!["fp16".into()],
        agent_semver: Some(SemanticVersion::new(2, 0, 0)),
        ..Default::default()
    });

    record.set_extension(CapabilityVersionExtension {
        versions: vec![("inference".into(), SemanticVersion::new(4, 1, 2))],
        ..Default::default()
    });

    record.set_extension(ReputationExtension {
        attestation_refs: vec!["abc123".into()],
        self_claimed_score: Some(85),
        attestation_sources: vec!["dht://att/abc123".into()],
        updated_at: now,
        ..Default::default()
    });

    // Sign the record (extensions are included in the signature).
    record.sign(&kp.secret_key().unwrap());

    // Verify the record.
    assert!(record.verify(now).is_ok());

    // Retrieve all extensions.
    let cost: Option<CostExtension> = record.get_extension();
    assert!(cost.is_some());
    assert_eq!(cost.unwrap().per_invocation_micro_usd, Some(50));

    let sem: Option<SemanticExtension> = record.get_extension();
    assert!(sem.is_some());
    assert!(sem.unwrap().supports_language("en"));

    let capver: Option<CapabilityVersionExtension> = record.get_extension();
    assert!(capver.is_some());
    assert_eq!(
        capver.unwrap().get("inference"),
        Some(&SemanticVersion::new(4, 1, 2)),
    );

    let rep: Option<ReputationExtension> = record.get_extension();
    assert!(rep.is_some());
    assert_eq!(rep.unwrap().self_claimed_score, Some(85));
}
```

---

## 9. Key Constraints

1. **Self-reported metrics are unverified.** All data in the extension map
   (cost, semantic, reputation references) is self-signed by the agent.
   Consumers MUST treat self-reported performance/cost as claims, not
   verified facts. Only `Attestation` documents (signed by third parties)
   carry verified metrics. `ReputationExtension.self_claimed_score` is
   explicitly labeled as unverified.

2. **Extensions are inside the signature envelope.** Key 11 (the extension
   map) is included in `to_cbor_without_sig()`. Modifying any extension
   field invalidates the record signature. This is enforced by Phase E1.

3. **Attestations are NOT part of the AgentRecord signature.** They are
   separate signed documents with their own domain separator
   (`aafp-v1-attestation`), signed by the attester's key, not the
   subject's key. This prevents agents from lying about their own quality.

4. **Micro-USD for all monetary values.** 1 USD = 1,000,000 micro-USD.
   This avoids floating point on the wire. `CostExtension` and
   `CapabilityCostModel` both use `u64` micro-USD.

5. **Basis points for percentages.** Uptime, success rate, and accuracy
   use basis points (10000 = 100%) to avoid floating point. This is
   consistent with `PerformanceExtension.uptime_bps` from Phase E2.

6. **Trust weighting uses the existing `TrustManager`.** The
   `compute_reputation()` function calls `TrustManager::verify_peer()` to
   determine the attester's trust level. It does NOT implement a parallel
   trust system. The weight mapping (Ultimate=1.0, Full=1.0,
   Marginal=0.5, Unknown=0.1, Untrusted/Revoked=0.0) is defined in
   `compute_reputation()`, not in `TrustManager`.

7. **Self-attestations are excluded.** `compute_reputation()` skips any
   attestation where `attester_agent_id == subject_agent_id`. This is the
   primary Sybil resistance mechanism — an agent cannot boost its own
   score.

8. **UCAN `attest.reputation` capability.** The UCAN integration uses
   `resource = "attest.reputation"` and `action = "invoke"`. This follows
   the existing UCAN capability model in `ucan.rs`. The chain verification
   reuses `UcanToken::verify_chain()`.

9. **Backward compatibility is mandatory.** Agents that don't understand
   key 11 MUST still verify and use the base record. Agents that don't
   understand a specific extension namespace MUST ignore it (not fail).
   Unknown extension namespaces MUST be preserved when re-broadcasting
   records (store and forward raw CBOR).

10. **CBOR encoding uses integer keys.** All extension data maps use
    integer keys (1, 2, 3, ...) inside the CBOR structure, consistent with
    the existing `AgentRecord` and `CapabilityDescriptor` encoding. The
    outer extension map (key 11) uses string keys for namespacing
    (e.g., `"aafp.cost.v1"`).

11. **Soft 8 KiB record size limit.** The full AgentRecord (including
    extensions and the 1952-byte public key + 4627-byte signature) should
    stay under 8 KiB. Extensions should budget ~4 KiB. Agents exceeding
    this SHOULD use an external capability resolver (future work).

12. **`cargo fmt`, `cargo clippy`, `cargo test` must pass.** After
    implementation, run:
    ```bash
    cargo fmt --all -- --check
    cargo clippy --workspace
    cargo test -p aafp-identity
    ```
    All new tests must pass with 0 warnings.

---

## 10. Implementation Order

1. **`extensions/capver.rs`** — `SemanticVersion` first (it's used by
   `SemanticExtension`). Then `CapabilityVersionExtension`.
2. **`extensions/cost.rs`** — `CostExtension` (no dependencies on other
   new modules).
3. **`extensions/semantic.rs`** — `SemanticExtension` (depends on
   `SemanticVersion` from `capver.rs`). Then `SemanticCapabilityData`
   and the enhanced `CapabilityDescriptor` integration.
4. **`extensions/reputation.rs`** — `ReputationExtension` (no
   dependencies on other new modules).
5. **`attestation.rs`** — `Attestation`, `AttestationData`, signing,
   verification, `compute_reputation()`, UCAN authorization. This is
   the largest module and depends on `TrustManager` and `UcanToken`.
6. **`lib.rs`** — Register modules, re-export types.
7. **Tests** — Run `cargo test -p aafp-identity` and verify all new
   tests pass. Run `cargo clippy --workspace` for 0 warnings.

---

## 11. Summary

This phase adds four extensions (`CostExtension`, `SemanticExtension`,
`CapabilityVersionExtension`, `ReputationExtension`) and the complete
attestation system (`Attestation`, `AttestationData`, verification,
trust-weighted reputation scoring, UCAN authorization). The design:

- **Separates self-reported claims from attested metrics** — extensions
  are self-signed; attestations are third-party signed with a separate
  domain separator.
- **Leverages existing infrastructure** — `TrustManager`,
  `WebOfTrust`, `UcanToken`, `AgentKeypair`, `aafp_cbor`.
- **Provides Sybil resistance** — self-attestation exclusion, trust
  weighting, sample-count discounting, WoT transitive trust.
- **Integrates with Track U** — `SemanticExtension` and
  `SemanticCapabilityData` link to the Semantic Capability Graphs.
- **Maintains backward compatibility** — all extensions are optional;
  old agents ignore key 11 and key 3 in `CapabilityDescriptor`.
