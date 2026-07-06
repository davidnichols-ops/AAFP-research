# AgentRecord Extensions — Design Document

**Status:** Design Document
**Track:** Identity (Phase E research, feeds Phase D)
**Date:** 2025-01-15
**Depends on:** `SEMANTIC_CAPABILITY_GRAPHS.md` (Track U), `ADAPTATION_ROADMAP.md`
**Affects:** `crates/aafp-identity/src/identity_v1.rs`, `crates/aafp-discovery/src/capability_dht.rs`

---

## 1. Executive Summary

The AAFP `AgentRecord` (RFC-0003 §3) is the self-signed identity document
published to the DHT. It currently carries the minimum information needed
for discovery: AgentId, public key, capability names, endpoints, timestamps,
and a monotonic version. To support the adaptation roadmap — Semantic
Capability Graphs (Track U), Adaptive Routing (Track T), geo-aware routing,
cost-aware selection, and reputation systems — the record must be extended
with richer metadata *without* breaking backward compatibility or inflating
wire size for agents that don't need the extensions.

This document proposes an **extension map** pattern: a single optional CBOR
field (key 11) containing a versioned map of extension namespaces. Each
namespace is independently versioned, self-describing, and signed as part
of the parent record. Attested metrics (reputation, performance) are carried
in a separate **attestation** structure signed by third parties, decoupled
from the self-signed record to prevent agents from lying about their own
quality.

---

## 2. Current AgentRecord Structure

### 2.1 Fields

**File**: `crates/aafp-identity/src/identity_v1.rs` (lines 103-144)

```rust
pub struct AgentRecord {
    pub record_type: String,      // "aafp-record-v1"
    pub agent_id: AgentId,        // 32-byte SHA-256(pubkey)
    pub public_key: Vec<u8>,      // ML-DSA-65 (1952 bytes)
    pub capabilities: Vec<CapabilityDescriptor>,
    pub endpoints: Vec<String>,   // multiaddr strings
    pub created_at: u64,          // unix seconds
    pub expires_at: u64,          // unix seconds
    pub signature: Vec<u8>,       // ML-DSA-65 over record (excl. sig)
    pub key_algorithm: u64,       // 1 = ML-DSA-65
    pub record_version: u64,      // monotonic (A-3 replay protection)
}
```

### 2.2 CBOR Encoding (Integer Keys)

```
AgentRecord = {
    1: tstr,          // record_type
    2: bstr,          // agent_id (32 bytes)
    3: bstr,          // public_key
    4: [ *CapabilityDescriptor ],  // capabilities
    5: [ *tstr ],     // endpoints
    6: uint,          // created_at
    7: uint,          // expires_at
    8: bstr,          // signature
    9: uint,          // key_algorithm
    10: uint,         // record_version
}
```

`CapabilityDescriptor` (lines 417-503) has:
```
CapabilityDescriptor = {
    1: tstr,                          // name
    2: { *tstr => MetadataValue },    // metadata (string keys!)
}
```

`MetadataValue` supports `Bool`, `Int(i64)`, `Text(String)`, `Bytes(Vec<u8>)`.

### 2.3 Signature Model

The record is self-signed: `sign()` computes
`ML-DSA-65(RECORD_DOMAIN_SEPARATOR || CBOR(record_without_sig))`.
Verification (`verify()`) checks AgentId derivation, record_type, key_algorithm,
signature validity, and expiry. The signature covers *all* fields except key 8.

### 2.4 Expiry and Refresh

- `MAX_RECORD_EXPIRY` = 30 days (2,592,000s) — a *mitigation guideline*, not
  enforced by `verify()`.
- `RECOMMENDED_RENEWAL` = 7 days (604,800s).
- `DhtRouter::republish_own_record()` re-announces to k=5 closest peers every
  30 minutes (before TTL expiry).
- `evict_expired()` removes records where `expires_at <= now`.
- `KeyDirectory::publish()` rate-limits to 1 publish per AgentId per hour.

### 2.5 Monotonic Version (A-3)

`record_version` starts at 1 and increases monotonically. Receivers MUST
reject older versions. Equal version accepted only if bytes are identical.
This prevents replay of stale records. `KeyDirectory::publish()` enforces
this (lines 93-99).

### 2.6 What's Missing

| Need | Current State | Required For |
|------|---------------|--------------|
| Reputation/trust scores | Not in record (WoT exists separately) | Track U quality metrics |
| Performance history | Not in record | Track T adaptive routing |
| Geographic location | Not in record | Geo-aware routing |
| Semantic capability descriptors | Flat `name` + freeform `metadata` | Track U semantic graphs |
| Cost models | Not in record | Cost-aware selection |
| Capability versioning | Only `record_version` (whole-record) | Semantic compatibility |
| Third-party attestation | Not in record | Trustworthy metrics |

---

## 3. Comparison with Other Service Discovery Systems

### 3.1 Consul (HashiCorp)

| Feature | Consul | AAFP Equivalent |
|---------|--------|-----------------|
| Service registration | `Service` struct with name, tags, address, port | `AgentRecord` with capabilities, endpoints |
| Health checks | TCP/HTTP/gRPC checks, TTL checks | `expires_at` + DHT eviction (passive) |
| Metadata | `Meta map[string]string` (max 64 pairs) | `CapabilityDescriptor.metadata` |
| Tags | `[]string` for simple filtering | Capability names (string array) |
| Prepared queries | SQL-like query with regex, near, failover | `CapabilityQuery` (Track U) |
| Connect (mTLS) | Auto-issued certs from CA | ML-DSA-65 self-signed + CA certs (RFC 0011) |
| Watch/long-poll | Blocking queries with `WaitIndex` | DHT refresh + PEX |

**Key lesson**: Consul separates *service definition* (static) from *health
status* (dynamic, checked continuously). AAFP should similarly separate
*static capability description* (in AgentRecord) from *dynamic performance
metrics* (in attestations or a separate metrics overlay).

### 3.2 Kubernetes Service + Endpoints

| Feature | K8s | AAFP Equivalent |
|---------|-----|-----------------|
| Service | Stable virtual IP + DNS name | AgentId (stable identity) |
| Endpoints | Pod IPs backing a Service | `endpoints` array |
| Labels | Key-value for selection | Capability names + metadata |
| Selectors | Equality + set-based | `CapabilityQuery` filters |
| Readiness probes | Is the pod ready to serve? | Not yet (passive expiry only) |
| Liveness probes | Is the pod alive? | DHT heartbeat / republish |
| Annotations | Arbitrary metadata (non-filtering) | Extension map (proposed) |

**Key lesson**: K8s uses *annotations* for non-selecting metadata (freeform,
versioned by convention) and *labels* for selecting metadata (constrained
value types). AAFP should distinguish between *queryable* attributes (in
`SemanticCapability`) and *non-queryable* annotations (in the extension map).

### 3.3 mDNS / DNS-SD (Service Discovery over Multicast DNS)

| Feature | DNS-SD | AAFP Equivalent |
|---------|--------|-----------------|
| Service type | `_http._tcp.local` | Capability name |
| TXT records | Key-value metadata (`key=value`) | `CapabilityDescriptor.metadata` |
| Instance name | Human-readable service name | Not in record (AgentId only) |
| TTL | DNS TTL for cache expiry | `expires_at` |
| Subtypes | `_printer._sub._http._tcp` | Capability edges (Specializes) |

**Key lesson**: DNS-SD TXT records are kept small (typically <400 bytes total)
because they're multicast. AAFP records travel over unicast DHT, so size is
less constrained, but bloated records increase DHT storage and replication
cost. Extensions should be optional and minimal by default.

### 3.4 Ethereum ENS (Ethereum Name Service)

| Feature | ENS | AAFP Equivalent |
|---------|-----|-----------------|
| Name resolution | `name.eth` → address | AgentId → AgentRecord (KeyDirectory) |
| Text records | `key-value` (avatar, email, URL, etc.) | Extension map (proposed) |
| Resolver | Smart contract per name | DHT node storing the record |
| TTL | Resolver-set TTL | `expires_at` |
| Multi-chain | `addr(bytes32 coinType)` | Multiple endpoint types |

**Key lesson**: ENS uses a *resolver contract* indirection — the name points
to a resolver, which can implement custom resolution logic. AAFP could
support a similar pattern: an extension that points to an external "capability
resolver" endpoint for agents with very large or dynamic capability sets,
keeping the DHT record small.

### 3.5 Summary Table

| Property | Consul | K8s | DNS-SD | ENS | AAFP (proposed) |
|----------|--------|-----|--------|-----|-----------------|
| Static desc. | Service + Meta | Service + Labels | SRV + TXT | Text records | AgentRecord + extensions |
| Dynamic health | Checks (active) | Probes (active) | TTL (passive) | TTL (passive) | Attestations + DHT TTL |
| Query language | Prepared queries | Label selectors | Exact match | Exact match | CapabilityQuery |
| Extensibility | Meta (64 pairs) | Annotations | TXT (freeform) | Text records | Versioned extension map |
| Security | ACL tokens | RBAC | None | Ethereum keys | ML-DSA-65 + UCAN |
| Decentralized | No (cluster) | No (cluster) | Yes (P2P) | Yes (blockchain) | Yes (DHT) |

---

## 4. Proposed Extension Architecture

### 4.1 Design Principles

1. **Backward compatible**: Agents that don't understand extensions MUST
   still verify and use the base record. Extensions are optional.
2. **Signed as part of the record**: Extensions live inside the signed
   envelope, so they cannot be tampered with without invalidating the
   signature.
3. **Versioned namespaces**: Each extension namespace has its own version,
   allowing independent evolution.
4. **Attested metrics are separate**: Self-reported metrics (latency, cost)
   are in the record; *trusted* metrics (reputation, verified performance)
   are in third-party attestations stored alongside the record.
5. **Minimal by default**: Agents that don't need extensions produce records
   identical to the current format (no key 11).

### 4.2 Extension Map (Key 11)

Add a single optional field to `AgentRecord`:

```
AgentRecord-v1 = {
    1: tstr,          // record_type
    2: bstr,          // agent_id
    3: bstr,          // public_key
    4: [ *CapabilityDescriptor ],
    5: [ *tstr ],     // endpoints
    6: uint,          // created_at
    7: uint,          // expires_at
    8: bstr,          // signature
    9: uint,          // key_algorithm
    10: uint,         // record_version
    ? 11: { *tstr => Extension },  // extensions (optional, string keys)
}
```

Each extension is a CBOR map with a mandatory version field:

```
Extension = {
    1: uint,          // extension_version (semantic, per-namespace)
    2: any,           // extension_data (namespace-specific CBOR)
}
```

Using string keys for the outer extension map (like `CapabilityDescriptor`
metadata) allows open, collision-resistant namespacing (e.g.,
`"aafp.geo.v1"`, `"aafp.reputation.v1"`).

### 4.3 Why Not Top-Level Integer Keys?

Adding top-level integer keys (12, 13, 14...) has drawbacks:
- **Key exhaustion**: We'd consume the integer key space rapidly.
- **No namespacing**: No way to group related fields or version them together.
- **All-or-nothing**: Every new field is either always present or always
  absent; no way to bundle optional groups.
- **Signature coupling**: Adding a field changes the signature input,
  requiring all agents to re-sign. (This is true for key 11 as well, but
  only for agents that use it.)

### 4.4 Why Not Just CapabilityDescriptor.metadata?

`CapabilityDescriptor.metadata` is already extensible, but:
- It's per-capability, not per-agent. Geographic location and reputation
  are agent-level, not capability-level.
- It uses string keys with no versioning — no way to evolve a schema.
- It's already used for ad-hoc metadata; overloading it for structured
  extensions would break existing consumers.

The extension map complements `metadata`: agent-level extensions go in key 11;
capability-level semantic descriptors go in enhanced `CapabilityDescriptor`
(see §5.4).

---

## 5. Proposed Extension Fields

### 5.1 Geographic Location (`"aafp.geo.v1"`)

For geo-aware routing: route requests to nearby agents to reduce latency
and respect data sovereignty constraints.

```rust
/// Geographic location extension (key 11, namespace "aafp.geo.v1").
#[derive(Clone, Debug, Default)]
pub struct GeoExtension {
    /// Extension version (always 1 for v1).
    pub version: u64,
    /// ISO 3166-1 alpha-2 country code (e.g., "US", "DE", "JP").
    pub country: Option<String>,
    /// ISO 3166-2 region code (e.g., "US-CA").
    pub region: Option<String>,
    /// Approximate latitude in micro-degrees (lat * 1,000,000).
    /// Precision is intentionally coarse for privacy.
    pub lat_micro_deg: Option<i32>,
    /// Approximate longitude in micro-degrees (lon * 1,000,000).
    pub lon_micro_deg: Option<i32>,
    /// Continent code (e.g., "NA", "EU", "AS").
    pub continent: Option<String>,
    /// Data residency constraints: jurisdictions where data MUST stay.
    /// e.g., ["EU", "US-CA"] means data cannot leave EU or US-CA.
    pub data_residency: Vec<String>,
}
```

**CBOR encoding:**
```
GeoExtension = {
    1: uint,              // version = 1
    2: {                  // data
        ? 1: tstr,        // country
        ? 2: tstr,        // region
        ? 3: int,         // lat_micro_deg
        ? 4: int,         // lon_micro_deg
        ? 5: tstr,        // continent
        ? 6: [ *tstr ],   // data_residency
    }
}
```

**Privacy**: Coordinates are coarse (micro-degree ≈ 0.1m, but agents SHOULD
round to ~1km precision). Agents MAY omit coordinates and provide only
country/continent. No agent is required to publish geo data.

### 5.2 Performance History (`"aafp.perf.v1"`)

Self-reported performance characteristics. These are *claims*, not verified
metrics — see §7 for attested metrics.

```rust
/// Self-reported performance profile (key 11, namespace "aafp.perf.v1").
#[derive(Clone, Debug, Default)]
pub struct PerformanceExtension {
    pub version: u64,
    /// Average latency in milliseconds (self-measured, EWMA).
    pub avg_latency_ms: Option<u16>,
    /// P99 latency in milliseconds.
    pub p99_latency_ms: Option<u16>,
    /// Throughput in requests per second.
    pub throughput_rps: Option<u32>,
    /// Max concurrent requests supported.
    pub max_concurrent: Option<u32>,
    /// Uptime percentage * 100 (e.g., 9999 = 99.99%).
    pub uptime_bps: Option<u16>,
    /// Measurement window in seconds (how long the stats cover).
    pub window_secs: u32,
    /// When the stats were last updated (unix seconds).
    pub updated_at: u64,
}
```

**Design note**: Using `u16` for latency (max 65.5s) and `u32` for throughput
keeps the encoding compact. `uptime_bps` uses basis points (10000 = 100%)
to avoid floating point on the wire.

### 5.3 Cost Model (`"aafp.cost.v1"`)

Pricing information for cost-aware agent selection.

```rust
/// Cost model extension (key 11, namespace "aafp.cost.v1").
#[derive(Clone, Debug, Default)]
pub struct CostExtension {
    pub version: u64,
    /// Cost per invocation in micro-USD (1 USD = 1,000,000 micro-USD).
    pub per_invocation_micro_usd: Option<u64>,
    /// Cost per token in micro-USD (for LLM capabilities).
    pub per_token_micro_usd: Option<u64>,
    /// Cost per second of compute in micro-USD.
    pub per_second_micro_usd: Option<u64>,
    /// Free tier available (boolean).
    pub has_free_tier: bool,
    /// Free tier invocation limit per day.
    pub free_tier_daily_limit: Option<u32>,
    /// Currency code (ISO 4217, default "USD").
    pub currency: String,
    /// Pricing last updated (unix seconds).
    pub updated_at: u64,
}
```

### 5.4 Semantic Capability Descriptors (`"aafp.semantic.v1"`)

This extension carries the `SemanticCapability` structures from Track U at
the *agent* level (agent-wide attributes like supported languages, hardware).
Per-capability semantic details go in enhanced `CapabilityDescriptor`.

```rust
/// Agent-level semantic capability extension.
#[derive(Clone, Debug, Default)]
pub struct SemanticExtension {
    pub version: u64,
    /// Agent-wide supported languages (BCP-47 tags).
    pub languages: Vec<String>,
    /// Supported modalities (text, image, audio, video).
    pub modalities: Vec<String>,
    /// Hardware available (e.g., ["gpu:rtx5090", "npu:apple-m4"]).
    pub hardware: Vec<String>,
    /// Software frameworks (e.g., ["cuda", "tensorrt", "coreml"]).
    pub frameworks: Vec<String>,
    /// Precision modes supported (e.g., ["fp32", "fp16", "fp8"]).
    pub precision: Vec<String>,
    /// Agent capability semantic version (agent-wide, not per-cap).
    pub agent_semver: Option<SemanticVersion>,
}
```

For per-capability semantic descriptors, extend `CapabilityDescriptor` with
an optional key 3:

```
CapabilityDescriptor-v2 = {
    1: tstr,                          // name
    2: { *tstr => MetadataValue },    // metadata (backward compat)
    ? 3: SemanticCapabilityData,      // semantic descriptor (optional)
}
```

`SemanticCapabilityData` carries `PerformanceProfile`, `QualityMetrics`,
`CostModel`, `CapabilityEdge`, and `SemanticVersion` as defined in
`SEMANTIC_CAPABILITY_GRAPHS.md` §3.1. Agents that don't understand key 3
ignore it and use the base `name` + `metadata`.

### 5.5 Reputation / Trust Scores (`"aafp.reputation.v1"`)

**Self-reported reputation is NOT trustworthy.** This extension carries only
*references* to third-party attestations. The actual attestations are stored
separately (see §7).

```rust
/// Reputation extension: references to third-party attestations.
#[derive(Clone, Debug, Default)]
pub struct ReputationExtension {
    pub version: u64,
    /// References to attestation records (hashes for lookup).
    /// Each entry is SHA-256(attestation_bytes), hex-encoded.
    pub attestation_refs: Vec<String>,
    /// Self-claimed trust score (0-100). Treated as unverified.
    pub self_claimed_score: Option<u8>,
    /// URLs or DHT keys where attestations can be fetched.
    pub attestation_sources: Vec<String>,
    /// Last time the agent updated its attestation references.
    pub updated_at: u64,
}
```

### 5.6 Capability Versioning (`"aafp.capver.v1"`)

Per-capability semantic versions, allowing queries like "version >= 4.1".

```rust
/// Per-capability semantic version extension.
#[derive(Clone, Debug, Default)]
pub struct CapabilityVersionExtension {
    pub version: u64,
    /// Map: capability_name → (major, minor, patch).
    pub versions: Vec<(String, SemanticVersion)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SemanticVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}
```

---

## 6. Backward Compatibility Strategy

### 6.1 Core Principle

**Old agents MUST continue to work.** An agent that only understands keys
1-10 MUST be able to verify the signature, extract capabilities/endpoints,
and use the record for discovery — even if the record contains key 11.

### 6.2 Signature Coverage

Key 11 (extensions) is included in the signature input
(`to_cbor_without_sig`). This means:
- If an agent adds extensions, it must re-sign.
- If an attacker strips key 11, the signature breaks.
- Old agents that don't read key 11 still verify the signature correctly
  because they verify *all* fields present in the CBOR map, including
  unknown keys (the signature is over the canonical CBOR bytes, not over
  parsed fields).

**Critical implementation note**: The current `from_cbor()` decoder ignores
unknown keys (it only reads keys 1-10). This is correct for backward
compatibility — unknown keys are preserved in the raw bytes but not parsed.
However, `to_cbor_without_sig()` must reproduce *all* keys including 11 for
signature verification to work. This requires storing the raw extension
bytes or parsing and re-encoding them.

### 6.3 Decoding Strategy

```rust
impl AgentRecord {
    pub fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        // ... existing parsing of keys 1-10 ...

        // Parse optional extension map (key 11).
        let extensions = match get(11) {
            Some(Value::StrMap(entries)) => {
                let mut exts = Vec::new();
                for (ns, v) in entries {
                    exts.push((ns.clone(), Extension::from_cbor(v)?));
                }
                exts
            }
            Some(Value::IntMap(_)) => Vec::new(), // empty map
            None => Vec::new(), // no extensions — fully backward compatible
            Some(other) => {
                return Err(IdentityError::InvalidField {
                    field: "extensions",
                    message: format!("expected map, got {:?}", other),
                });
            }
        };

        Ok(Self {
            // ... existing fields ...
            extensions,
        })
    }
}
```

### 6.4 Forward Compatibility

When a *new* agent encounters an *old* record (no key 11):
- `extensions` is empty `Vec::new()`.
- All extension lookups return `None`.
- The agent falls back to base capability discovery.
- No errors, no warnings — graceful degradation.

When an *old* agent encounters a *new* record (has key 11):
- `from_cbor()` ignores key 11 (it's not in the parsing code).
- `verify()` succeeds because the signature is over the raw CBOR bytes.
- The agent uses capabilities/endpoints as before.

### 6.5 Extension Version Negotiation

Each extension namespace has its own version. If an agent encounters an
extension namespace it recognizes but with a higher version than it supports:
- It SHOULD ignore that extension (not fail).
- It MAY log a warning.
- It MUST NOT use partial data from an unsupported version.

This follows the "be conservative in what you accept" principle.

---

## 7. Security Model for Attested Metrics

### 7.1 The Self-Reporting Problem

An agent can claim any latency, uptime, or trust score in its own record.
Without verification, these claims are worthless for routing decisions.
A malicious agent could advertise 5ms latency and 99.99% uptime to attract
traffic, then degrade.

### 7.2 Attestation Structure

Third-party attestations are separate signed documents, stored in the DHT
under a different key namespace. They are NOT part of the AgentRecord
signature.

```rust
/// A third-party attestation about an agent's performance/reputation.
///
/// CBOR structure (integer keys):
/// Attestation = {
///     1: tstr,      // type: "aafp-attestation-v1"
///     2: bstr,      // subject_agent_id (32 bytes)
///     3: bstr,      // attester_agent_id (32 bytes)
///     4: bstr,      // attester_public_key
///     5: uint,      // attested_at (unix seconds)
///     6: uint,      // expires_at (unix seconds)
///     7: AttestationData,  // the metrics being attested
///     8: bstr,      // attester_signature
/// }
#[derive(Clone, Debug)]
pub struct Attestation {
    pub record_type: String,
    pub subject_agent_id: AgentId,
    pub attester_agent_id: AgentId,
    pub attester_public_key: Vec<u8>,
    pub attested_at: u64,
    pub expires_at: u64,
    pub data: AttestationData,
    pub signature: Vec<u8>,
}

/// The metrics being attested.
#[derive(Clone, Debug)]
pub struct AttestationData {
    /// Observed average latency (ms).
    pub observed_avg_latency_ms: Option<u16>,
    /// Observed success rate (basis points, 10000 = 100%).
    pub observed_success_rate_bps: Option<u16>,
    /// Number of interactions observed.
    pub sample_count: u32,
    /// Trust score assigned by attester (0-100).
    pub trust_score: u8,
    /// Free-text assessment (max 256 bytes).
    pub notes: Option<String>,
}
```

### 7.3 Attestation Verification

```rust
impl Attestation {
    /// Verify the attestation signature and validity.
    pub fn verify(&self, now: u64) -> Result<(), IdentityError> {
        // 1. Verify attester_agent_id == SHA-256(attester_public_key)
        let computed = AgentId::from_public_key(&self.attester_public_key);
        if self.attester_agent_id != computed {
            return Err(IdentityError::InvalidAgentId);
        }

        // 2. Verify signature over (domain_sep || cbor_without_sig)
        let cbor = self.to_cbor_without_sig();
        let bytes = aafp_cbor::encode(&cbor).unwrap();
        let mut input = Vec::new();
        input.extend_from_slice(b"aafp-v1-attestation");
        input.extend_from_slice(&bytes);

        let pk = MlDsa65PublicKey::from_bytes(&self.attester_public_key)?;
        let sig = MlDsa65Signature::from_bytes(&self.signature)?;
        if !MlDsa65::verify(&pk, &input, &sig) {
            return Err(IdentityError::SignatureVerificationFailed);
        }

        // 3. Check expiry
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

### 7.4 Trust Weighting

Not all attestations are equal. The discovering agent should weight
attestations based on its trust relationship with the attester:

```rust
/// Compute a weighted reputation score from multiple attestations.
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

        // Determine trust level for the attester.
        let trust = trust_manager.verify(&att.attester_agent_id, now);
        let weight = match trust {
            TrustResult::Trusted { level, .. } => match level {
                3 => 1.0,  // Ultimate (self — should be excluded)
                2 => 1.0,  // Full trust
                1 => 0.5,  // Marginal trust
                _ => 0.0,  // None
            },
            TrustResult::Unknown { .. } => 0.1, // TOFU: small weight
            _ => 0.0,
        };

        // Self-attestations (attester == subject) get zero weight.
        if att.attester_agent_id == att.subject_agent_id {
            continue;
        }

        weighted_sum += weight * att.data.trust_score as f64;
        total_weight += weight;
    }

    if total_weight > 0.0 {
        Some(weighted_sum / total_weight)
    } else {
        None
    }
}
```

### 7.5 Sybil Resistance

A malicious agent could create many identities and attest to each other.
Mitigations:
1. **Web of Trust**: Require transitive trust from known anchors. Sybil
   identities have no WoT path from real agents.
2. **CA attestation**: A CA-signed agent's attestations carry more weight.
3. **Stake-based weighting**: Future — agents stake tokens; attestations
   from higher-stake agents carry more weight.
4. **Sample count**: `AttestationData.sample_count` indicates how many
   interactions the attester observed. Low-sample attestations are
   discounted.
5. **Rate limiting**: `KeyDirectory` already rate-limits publishing to
   1/AgentId/hour. Attestation publishing should have similar limits.

### 7.6 Interaction with UCAN Capability Chains

UCAN tokens (in `ucan.rs`) delegate *capabilities* (resource + action),
not *reputation*. However, UCAN and attestations compose:

- An agent with a UCAN delegation for `attest.reputation` on a target
  AgentId is authorized to issue attestations about that agent.
- The attestation's `attester_agent_id` must match the UCAN token's
  `aud` (the delegatee), and the UCAN's `iss` must be the subject or
  an authorized attester.
- This allows *delegated attestation*: "Agent A delegates to Agent B
  the right to attest to A's performance."

```rust
/// Verify that an attestation is backed by a UCAN delegation.
pub fn verify_attestation_authorization(
    attestation: &Attestation,
    ucan_chain: &[&UcanToken],
    root_pubkey: &[u8],
) -> Result<(), IdentityError> {
    // 1. Verify the UCAN chain.
    UcanToken::verify_chain(ucan_chain, root_pubkey)?;

    // 2. Check that the chain delegates "attest.reputation" to the attester.
    let leaf = ucan_chain.last().unwrap();
    let has_attest_cap = leaf.payload.cap.iter().any(|c| {
        c.resource == "attest.reputation" && c.action == "invoke"
    });
    if !has_attest_cap {
        return Err(IdentityError::Ucan(
            "no attest.reputation capability in chain".into(),
        ));
    }

    // 3. Check that the leaf's audience matches the attester.
    let attester_id_hex = agent_id_to_hex(&attestation.attester_agent_id);
    if leaf.payload.aud != attester_id_hex {
        return Err(IdentityError::Ucan(
            "UCAN audience does not match attester".into(),
        ));
    }

    Ok(())
}
```

---

## 8. AgentRecord Expiry and Refresh

### 8.1 Current Mechanism

- `expires_at` field (unix seconds). `verify()` rejects expired records.
- `DhtRouter::republish_own_record()` re-announces every 30 minutes.
- `evict_expired()` removes expired records from local DHT.
- `KeyDirectory` rate-limits publishing to 1/AgentId/hour.
- `MAX_RECORD_EXPIRY` = 30 days (guideline, not enforced).

### 8.2 Proposed Enhancements

#### 8.2.1 Heartbeat Extension (`"aafp.heartbeat.v1"`)

For agents with long-lived records (e.g., 30-day expiry), a lightweight
heartbeat proves liveness without re-publishing the full record:

```rust
/// Heartbeat extension: proves the agent is alive without full republish.
#[derive(Clone, Debug, Default)]
pub struct HeartbeatExtension {
    pub version: u64,
    /// Heartbeat interval in seconds (how often the agent sends heartbeats).
    pub interval_secs: u32,
    /// Last heartbeat timestamp (unix seconds).
    pub last_heartbeat: u64,
    /// Heartbeat signature (separate from record signature, same key).
    pub heartbeat_sig: Vec<u8>,
}
```

The heartbeat signature is `ML-DSA-65(b"aafp-heartbeat" || agent_id || last_heartbeat)`.
This is much smaller than re-signing the full record. DHT nodes can update
the `last_heartbeat` field without requiring a full record republish,
keeping the record fresh.

**DHT integration**: A new DHT RPC `HEARTBEAT(agent_id, timestamp, sig)`
allows nodes to update the heartbeat without storing a new record. If the
heartbeat is older than `interval_secs * 3`, the record is considered
*stale* (but not expired) and deprioritized in routing.

#### 8.2.2 Adaptive TTL

Instead of a fixed `expires_at`, agents with dynamic capabilities (e.g.,
auto-scaling inference servers) can use shorter TTLs (1-7 days) while
stable agents use longer TTLs (7-30 days). The extension map can carry
TTL hints:

```rust
/// TTL hints for DHT nodes.
pub struct TtlHintExtension {
    pub version: u64,
    /// Suggested refresh interval for DHT nodes (seconds).
    pub suggested_refresh_secs: u32,
    /// Whether the agent supports heartbeat updates.
    pub supports_heartbeat: bool,
}
```

#### 8.2.3 Record Size Limits

To prevent DHT bloat, propose a soft limit of 8 KiB for the encoded
AgentRecord (including extensions). The base record is ~2 KiB (dominated
by the 1952-byte public key + 4627-byte ML-DSA-65 signature). Extensions
should budget ~4 KiB. Agents exceeding 8 KiB SHOULD use an external
capability resolver (see §3.4 ENS lesson).

---

## 9. Concrete Rust Implementation

### 9.1 Extension Trait

```rust
use aafp_cbor::{int_map, int_map_get, Value};
use crate::identity_v1::IdentityError;

/// A versioned extension that can be encoded into the extension map.
pub trait AgentRecordExtension: Sized + Clone {
    /// Namespace string (e.g., "aafp.geo.v1").
    const NAMESPACE: &'static str;

    /// Current extension version.
    const VERSION: u64;

    /// Encode to CBOR (the inner data map, not including version wrapper).
    fn to_cbor(&self) -> Value;

    /// Decode from CBOR.
    fn from_cbor(val: &Value) -> Result<Self, IdentityError>;

    /// Encode as a full Extension wrapper {1: version, 2: data}.
    fn to_extension_cbor(&self) -> Value {
        int_map(vec![
            (1, Value::Unsigned(Self::VERSION)),
            (2, self.to_cbor()),
        ])
    }

    /// Decode from a full Extension wrapper.
    fn from_extension_cbor(val: &Value) -> Result<Self, IdentityError> {
        let version = expect_u64(int_map_get(val, 1), "extension_version")?;
        if version != Self::VERSION {
            return Err(IdentityError::InvalidField {
                field: "extension_version",
                message: format!(
                    "expected {}, got {}",
                    Self::VERSION, version
                ),
            });
        }
        let data = int_map_get(val, 2)
            .ok_or(IdentityError::MissingField("extension_data"))?;
        Self::from_cbor(data)
    }
}
```

### 9.2 GeoExtension Implementation

```rust
impl AgentRecordExtension for GeoExtension {
    const NAMESPACE: &'static str = "aafp.geo.v1";
    const VERSION: u64 = 1;

    fn to_cbor(&self) -> Value {
        let mut entries = vec![];
        if let Some(c) = &self.country {
            entries.push((1, Value::TextString(c.clone())));
        }
        if let Some(r) = &self.region {
            entries.push((2, Value::TextString(r.clone())));
        }
        if let Some(lat) = self.lat_micro_deg {
            entries.push((3, Value::Negative(lat)));
        }
        if let Some(lon) = self.lon_micro_deg {
            entries.push((4, Value::Negative(lon)));
        }
        if let Some(cont) = &self.continent {
            entries.push((5, Value::TextString(cont.clone())));
        }
        if !self.data_residency.is_empty() {
            entries.push((
                6,
                Value::Array(
                    self.data_residency
                        .iter()
                        .map(|s| Value::TextString(s.clone()))
                        .collect(),
                ),
            ));
        }
        int_map(entries)
    }

    fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        Ok(Self {
            version: 1,
            country: match int_map_get(val, 1) {
                Some(Value::TextString(s)) => Some(s.clone()),
                _ => None,
            },
            region: match int_map_get(val, 2) {
                Some(Value::TextString(s)) => Some(s.clone()),
                _ => None,
            },
            lat_micro_deg: match int_map_get(val, 3) {
                Some(Value::Negative(n)) => Some(*n),
                Some(Value::Unsigned(n)) => Some(*n as i32),
                _ => None,
            },
            lon_micro_deg: match int_map_get(val, 4) {
                Some(Value::Negative(n)) => Some(*n),
                Some(Value::Unsigned(n)) => Some(*n as i32),
                _ => None,
            },
            continent: match int_map_get(val, 5) {
                Some(Value::TextString(s)) => Some(s.clone()),
                _ => None,
            },
            data_residency: match int_map_get(val, 6) {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|v| match v {
                        Value::TextString(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
        })
    }
}
```

### 9.3 Updated AgentRecord

```rust
#[derive(Clone, Debug)]
pub struct AgentRecord {
    // ... existing fields (1-10) unchanged ...
    pub record_type: String,
    pub agent_id: AgentId,
    pub public_key: Vec<u8>,
    pub capabilities: Vec<CapabilityDescriptor>,
    pub endpoints: Vec<String>,
    pub created_at: u64,
    pub expires_at: u64,
    pub signature: Vec<u8>,
    pub key_algorithm: u64,
    pub record_version: u64,

    /// Extension map (key 11). Optional — empty for backward compat.
    /// Stored as (namespace, raw CBOR) pairs to preserve unknown extensions.
    pub extensions: Vec<(String, Value)>,
}

impl AgentRecord {
    /// Encode to canonical CBOR, excluding the signature (key 8).
    pub fn to_cbor_without_sig(&self) -> Value {
        let mut entries = vec![
            (1, Value::TextString(self.record_type.clone())),
            (2, Value::ByteString(self.agent_id.0.to_vec())),
            (3, Value::ByteString(self.public_key.clone())),
            (
                4,
                Value::Array(
                    self.capabilities.iter().map(|c| c.to_cbor()).collect(),
                ),
            ),
            (
                5,
                Value::Array(
                    self.endpoints
                        .iter()
                        .map(|s| Value::TextString(s.clone()))
                        .collect(),
                ),
            ),
            (6, Value::Unsigned(self.created_at)),
            (7, Value::Unsigned(self.expires_at)),
            (9, Value::Unsigned(self.key_algorithm)),
            (10, Value::Unsigned(self.record_version)),
        ];

        // Add extension map (key 11) only if non-empty.
        if !self.extensions.is_empty() {
            let ext_map = aafp_cbor::str_map(
                self.extensions
                    .iter()
                    .map(|(ns, v)| (ns.clone(), v.clone()))
                    .collect(),
            );
            entries.push((11, ext_map));
        }

        int_map(entries)
    }

    /// Get a typed extension by namespace.
    pub fn get_extension<T: AgentRecordExtension>(&self) -> Option<T> {
        let entry = self.extensions.iter().find(|(ns, _)| ns == T::NAMESPACE)?;
        T::from_extension_cbor(&entry.1).ok()
    }

    /// Set a typed extension (replaces existing with same namespace).
    pub fn set_extension<T: AgentRecordExtension>(&mut self, ext: T) {
        let cbor = ext.to_extension_cbor();
        if let Some(pos) = self.extensions.iter().position(|(ns, _)| ns == T::NAMESPACE) {
            self.extensions[pos] = (T::NAMESPACE.to_string(), cbor);
        } else {
            self.extensions.push((T::NAMESPACE.to_string(), cbor));
        }
    }
}
```

### 9.4 Usage Example

```rust
use aafp_identity::identity_v1::*;
use aafp_identity::extensions::*;

// Create a record with extensions.
let mut record = AgentRecord::new(
    &public_key,
    vec![CapabilityDescriptor::new("inference")],
    vec!["quic://1.2.3.4:4433".into()],
    now,
    now + 7 * 24 * 3600,
    KEY_ALG_ML_DSA_65,
);

// Add geographic location.
record.set_extension(GeoExtension {
    version: 1,
    country: Some("US".into()),
    region: Some("US-CA".into()),
    lat_micro_deg: Some(37_774_900),  // 37.7749° N
    lon_micro_deg: Some(-122_419_400), // -122.4194° W
    continent: Some("NA".into()),
    data_residency: vec!["US".into()],
});

// Add performance profile.
record.set_extension(PerformanceExtension {
    version: 1,
    avg_latency_ms: Some(14),
    p99_latency_ms: Some(45),
    throughput_rps: Some(1000),
    max_concurrent: Some(100),
    uptime_bps: Some(9999),
    window_secs: 3600,
    updated_at: now,
});

// Add cost model.
record.set_extension(CostExtension {
    version: 1,
    per_invocation_micro_usd: Some(50), // $0.00005
    per_token_micro_usd: Some(2),       // $0.000002/token
    has_free_tier: true,
    free_tier_daily_limit: Some(1000),
    currency: "USD".into(),
    updated_at: now,
    ..Default::default()
});

// Sign the record (extensions are included in the signature).
record.sign(&secret_key);

// --- On the receiving side ---

// Old agent: ignores key 11, uses base fields.
let old_agent_view = AgentRecord::from_cbor(&cbor)?;
assert!(old_agent_view.verify(now).is_ok()); // signature still valid
// old_agent_view.extensions is empty (ignored) or parsed but unused.

// New agent: reads extensions.
let geo: Option<GeoExtension> = record.get_extension();
let perf: Option<PerformanceExtension> = record.get_extension();
let cost: Option<CostExtension> = record.get_extension();

// Query: find inference agents in the US with <50ms latency and <$0.0001/invocation.
let matches = candidates.iter().filter(|r| {
    let geo = r.get_extension::<GeoExtension>();
    let perf = r.get_extension::<PerformanceExtension>();
    let cost = r.get_extension::<CostExtension>();

    geo.as_ref().and_then(|g| g.country.as_deref()) == Some("US")
        && perf.as_ref().and_then(|p| p.avg_latency_ms).map_or(false, |l| l < 50)
        && cost.as_ref().and_then(|c| c.per_invocation_micro_usd).map_or(false, |c| c < 100)
});
```

### 9.5 Enhanced CapabilityDescriptor

```rust
/// Extended CapabilityDescriptor with optional semantic data (key 3).
#[derive(Clone, Debug)]
pub struct CapabilityDescriptor {
    pub name: String,
    pub metadata: Vec<(String, MetadataValue)>,
    /// Optional semantic capability data (key 3, v2 extension).
    pub semantic: Option<SemanticCapabilityData>,
}

impl CapabilityDescriptor {
    pub fn to_cbor(&self) -> Value {
        let mut entries = vec![
            (1, Value::TextString(self.name.clone())),
            (
                2,
                if self.metadata.is_empty() {
                    Value::StrMap(vec![])
                } else {
                    aafp_cbor::str_map(
                        self.metadata
                            .iter()
                            .map(|(k, v)| (k.clone(), v.to_cbor()))
                            .collect(),
                    )
                },
            ),
        ];

        if let Some(sem) = &self.semantic {
            entries.push((3, sem.to_cbor()));
        }

        int_map(entries)
    }

    pub fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        // ... parse keys 1 and 2 as before ...

        // Parse optional semantic data (key 3).
        let semantic = match int_map_get(val, 3) {
            Some(v) => Some(SemanticCapabilityData::from_cbor(v)?),
            None => None, // Backward compatible: no key 3
        };

        Ok(Self {
            name,
            metadata,
            semantic,
        })
    }
}
```

---

## 10. DHT Integration

### 10.1 Storage

The extension map is part of the AgentRecord, so it's stored and replicated
identically to the current record. No DHT protocol changes are needed.

### 10.2 Indexing

The `CapabilityDht` currently indexes by `SHA-256(capability_name)`. With
extensions, secondary indexes can be built *locally* by the discovering
agent (as proposed in `SEMANTIC_CAPABILITY_GRAPHS.md` §5):

```rust
/// Local secondary index built from discovered records.
pub struct ExtensionIndex {
    /// Country → AgentIds
    by_country: HashMap<String, Vec<AgentId>>,
    /// Latency bucket → AgentIds (for range queries)
    by_latency: BTreeMap<u16, Vec<AgentId>>,
    /// Cost bucket → AgentIds
    by_cost: BTreeMap<u64, Vec<AgentId>>,
}

impl ExtensionIndex {
    /// Rebuild index from a set of discovered records.
    pub fn build(records: &[AgentRecord]) -> Self {
        let mut by_country = HashMap::new();
        let mut by_latency = BTreeMap::new();
        let mut by_cost = BTreeMap::new();

        for r in records {
            if let Some(geo) = r.get_extension::<GeoExtension>() {
                if let Some(country) = geo.country {
                    by_country.entry(country).or_default().push(r.agent_id);
                }
            }
            if let Some(perf) = r.get_extension::<PerformanceExtension>() {
                if let Some(lat) = perf.avg_latency_ms {
                    by_latency.entry(lat).or_default().push(r.agent_id);
                }
            }
            if let Some(cost) = r.get_extension::<CostExtension>() {
                if let Some(c) = cost.per_invocation_micro_usd {
                    by_cost.entry(c).or_default().push(r.agent_id);
                }
            }
        }

        Self { by_country, by_latency, by_cost }
    }
}
```

### 10.3 Attestation Storage

Attestations are stored in the DHT under a separate key namespace:
`SHA-256(b"aafp-attestation" || subject_agent_id || attester_agent_id)`.
This allows fetching all attestations for a given subject by iterating
keys with the subject prefix. Alternatively, the `ReputationExtension`
in the AgentRecord carries explicit attestation references (hashes) for
direct lookup.

---

## 11. Implementation Roadmap

### Phase E1: Extension Framework (Week 1-2)

| Deliverable | Description |
|-------------|-------------|
| `AgentRecordExtension` trait | In `aafp-identity/src/extensions/mod.rs` |
| Key 11 in AgentRecord | Add `extensions: Vec<(String, Value)>` field |
| Updated `to_cbor_without_sig` / `from_cbor` | Include key 11 in encoding/decoding |
| Backward compatibility tests | Old records (no key 11) parse correctly; new records verify on old parsers |
| Signature round-trip tests | Extensions are covered by signature; stripping breaks verification |

### Phase E2: Core Extensions (Week 3-4)

| Deliverable | Description |
|-------------|-------------|
| `GeoExtension` | Country, region, coordinates, data residency |
| `PerformanceExtension` | Latency, throughput, uptime (self-reported) |
| `CostExtension` | Per-invocation, per-token, per-second pricing |
| `CapabilityVersionExtension` | Per-capability semver |
| `SemanticExtension` | Agent-level languages, modalities, hardware |
| Enhanced `CapabilityDescriptor` | Optional key 3 for per-capability semantic data |
| CBOR round-trip tests | All extensions encode/decode correctly |

### Phase E3: Attestation System (Week 5-6)

| Deliverable | Description |
|-------------|-------------|
| `Attestation` struct | Third-party signed attestation with CBOR encoding |
| `AttestationData` | Observed latency, success rate, trust score |
| `Attestation::verify()` | Signature + expiry verification |
| `compute_reputation()` | Trust-weighted aggregation using `TrustManager` |
| UCAN authorization check | `verify_attestation_authorization()` |
| DHT storage for attestations | Separate key namespace, replication |
| Sybil resistance tests | Self-attestations excluded, low-trust weighted down |

### Phase E4: Heartbeat and TTL (Week 7)

| Deliverable | Description |
|-------------|-------------|
| `HeartbeatExtension` | Lightweight liveness proof |
| `TtlHintExtension` | Adaptive refresh intervals |
| DHT `HEARTBEAT` RPC | Update heartbeat without full republish |
| Stale record detection | Deprioritize records with stale heartbeats |
| Record size limit enforcement | Soft 8 KiB limit with warning |

### Phase E5: Integration with Track U (Week 8-9)

| Deliverable | Description |
|-------------|-------------|
| `SemanticCapabilityData` in `CapabilityDescriptor` | Per-capability performance, quality, cost, edges |
| `CapabilityQuery` evaluation | Filter by extension fields + semantic capability data |
| `ExtensionIndex` | Local secondary indexes for fast filtering |
| Integration tests | End-to-end: publish with extensions → discover by extension query |
| Benchmark | Extension parsing overhead, record size impact |

### Phase E6: Integration with Track T (Week 10, future)

| Deliverable | Description |
|-------------|-------------|
| Dynamic metrics overlay | Combine static extensions with live routing metrics |
| `score_candidate()` | Weighted static + dynamic scoring |
| Adaptive routing integration | Feed extension data into routing decisions |

---

## 12. Security Considerations

### 12.1 Self-Reported Metrics

All data in the extension map is self-reported and self-signed. It can be
used for *filtering* (e.g., "agents that claim GPU support") but NOT for
*ranking* (e.g., "fastest agent") without attestation. Consumers MUST treat
self-reported performance as upper bounds, not verified facts.

### 12.2 Extension Tampering

Extensions are inside the signed envelope. Modifying any extension field
invalidates the record signature. This is enforced by including key 11 in
`to_cbor_without_sig()`.

### 12.3 Privacy

Geographic location and performance data are metadata that could be used
for surveillance. Mitigations:
- Geo coordinates are coarse (agent SHOULD round to ~1km).
- All extensions are optional; agents MAY omit any or all.
- Agents serving sensitive populations MAY publish only country-level geo.
- Performance data reveals capacity, which could be commercially sensitive.
  Agents MAY omit performance extensions in public DHT and share them only
  with trusted peers via direct connection.

### 12.4 Extension Poisoning

A malicious agent could include a very large extension map to bloat the DHT.
Mitigations:
- Soft 8 KiB record size limit (DHT nodes SHOULD reject larger records).
- Per-namespace size limits (e.g., geo extension ≤ 100 bytes).
- Rate limiting on `KeyDirectory::publish()` (already 1/AgentId/hour).

### 12.5 Unknown Extensions

Agents MUST NOT fail when encountering unknown extension namespaces. They
SHOULD preserve unknown extensions when re-broadcasting records (store and
forward the raw CBOR). This ensures forward compatibility.

---

## 13. Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Should attestations be stored in the same DHT or a separate overlay? | **Open** — same DHT with different key prefix is simpler |
| 2 | Should the extension map use string keys or integer keys with a registry? | **Decided** — string keys for open namespacing |
| 3 | How to handle extension conflicts when merging records from multiple DHT nodes? | **Open** — latest `record_version` wins, extensions come with it |
| 4 | Should there be a standard "capability resolver" protocol for large capability sets? | **Future** — ENS-style external resolver |
| 5 | How to handle revocation of attestations? | **Open** — attester issues revocation attestation with `trust_score=0` |
| 6 | Should extensions be compressible (e.g., CBOR + zstd)? | **Future** — if record size becomes a problem |
| 7 | How does key rotation (RFC 0011 §6) interact with extensions? | **Resolved** — extensions are part of the record; rotation re-signs everything |
| 8 | Should the heartbeat mechanism use a separate signature or reuse the record key? | **Decided** — same key, different domain separator |

---

## 14. Conclusion

The extension map pattern (key 11 with versioned namespaces) provides a
backward-compatible, forward-compatible, and secure way to enrich
AgentRecords with geographic, performance, cost, semantic, and reputation
metadata. The design:

- **Preserves the existing wire format** for agents that don't need extensions.
- **Covers extensions in the signature**, preventing tampering.
- **Separates self-reported claims from attested metrics**, addressing the
  trust problem.
- **Leverages existing infrastructure**: `TrustManager`, `WebOfTrust`,
  `KeyDirectory`, UCAN chains.
- **Aligns with Track U** (Semantic Capability Graphs) and **feeds Track T**
  (Adaptive Routing).

The implementation roadmap (6 phases, ~10 weeks) can proceed in parallel
with Phase D (Semantic Capability Graphs), with Phase E1 (extension
framework) as the critical first step that unblocks all subsequent work.
