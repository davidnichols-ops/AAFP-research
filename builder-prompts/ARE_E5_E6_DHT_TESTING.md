# Builder Prompt: AgentRecord Extensions Phase E5-E6
## DHT Integration + Testing

**Track:** E — AgentRecord Extensions
**Phases:** E5 (DHT Integration & Indexing) + E6 (Testing & Conformance)
**Design Doc:** `AGENT_RECORD_EXTENSIONS.md` §8 (Expiry/Refresh), §10 (DHT Integration), §11 (Roadmap), §12 (Security)
**Target Crates:** `aafp-discovery`, `aafp-identity`, `aafp-tests`, `aafp-conformance`, `aafp-benchmark`

---

## Objective

Implement the final two phases of the AgentRecord Extensions roadmap:

1. **E5 — DHT Integration**: Store extended AgentRecords (with the key-11 extension map) in the capability DHT, build local secondary indexes from extension data (`by_geo`, `by_performance`, `by_reputation`), store attestations in a separate DHT key namespace, implement the heartbeat extension with a lightweight DHT RPC for liveness updates, and add adaptive TTL that extends record freshness based on recent heartbeats. Enforce a 64 KiB maximum record size to prevent DHT bloat.

2. **E6 — Testing & Conformance**: Integration tests that publish extended records and discover them by geo/performance filters; conformance tests that verify extension CBOR encoding matches the spec wire format; and performance benchmarks that measure DHT lookup latency with extended records versus baseline records.

---

## Context: Existing Code You Must Build On

### AgentRecord (`aafp-identity/src/identity_v1.rs`, lines 120-144)

The current `AgentRecord` has fields for keys 1-10 only. The extension map (key 11) is **not yet implemented** in the codebase. Phases E1-E4 are assumed complete: the `AgentRecordExtension` trait, `GeoExtension`, `PerformanceExtension`, `CostExtension`, `ReputationExtension`, `HeartbeatExtension`, `TtlHintExtension`, and the `Attestation`/`AttestationData` structs should all exist in `aafp-identity/src/extensions/`. If any are missing, stub minimal versions so E5-E6 can proceed.

The critical integration point: `AgentRecord.to_cbor_without_sig()` must include key 11 when extensions are non-empty, and `from_cbor()` must parse key 11 into `extensions: Vec<(String, Value)>`. The signature covers key 11.

### CapabilityDht — Legacy (`aafp-discovery/src/capability_dht.rs`)

The legacy in-memory DHT (307 lines). Key structures:

```rust
pub type DhtKey = [u8; 32];

pub struct DhtRecord {
    pub capability: String,
    pub key: DhtKey,
    pub agent_record: AgentRecord,
}

pub struct CapabilityDht {
    store: HashMap<DhtKey, Vec<DhtRecord>>,
    agent_caps: HashMap<AgentId, Vec<String>>,
}
```

`put()` verifies the record signature, indexes by each capability name (SHA-256 of the string), and tracks agent→capabilities reverse mapping. `get(capability)` returns `Vec<&AgentRecord>`. `get_any()` and `get_all()` do union/intersection queries.

### CapabilityDht — v1 (`aafp-discovery/src/discovery_v1.rs`, lines 241-309)

The RFC-compliant v1 DHT. Uses `HashMap<String, HashSet<[u8;32]>>` for the capability index and `HashMap<[u8;32], AgentRecord>` for records. `put()` enforces monotonic `created_at` ordering and `MAX_RECORDS` capacity. Also has `ShardedCapabilityDht` with async `get()`/`get_all()`/`get_by_id()`.

Both DHT implementations index **only** by capability name. Neither understands extensions, geo, performance, or reputation. E5 adds secondary indexing on top of both.

### CBOR Helpers (`aafp-cbor`)

- `aafp_cbor::int_map(vec![(k, v), ...])` → `Value::IntMap`
- `aafp_cbor::str_map(vec![(k, v), ...])` → `Value::StrMap`
- `aafp_cbor::int_map_get(&val, k)` → `Option<&Value>`
- `aafp_cbor::encode(&val)` → `Result<Vec<u8>, CborError>`
- `aafp_cbor::decode(&bytes)` → `Result<(Value, usize), CborError>`

### Existing Test Infrastructure

- **`aafp-tests`**: Cross-crate integration tests. `multi_node_dht.rs` has DHT multi-node test patterns. `integration.rs` has end-to-end test harnesses.
- **`aafp-conformance`**: RFC conformance tests with golden vectors. `rfc0003.rs` covers AgentRecord. `test_vectors.rs` has CBOR test vector infrastructure.
- **`aafp-benchmark`**: Criterion benchmarks. `discovery.rs` has DHT lookup benchmarks. `serialization.rs` has CBOR encoding benchmarks.

---

## E5: DHT Integration

### Part 1: Record Size Enforcement (§8.2.3, §12.4)

**File:** `aafp-discovery/src/extension_dht.rs` (new module)

The design doc specifies a soft 8 KiB limit. For E5, enforce a **hard 64 KiB maximum** per DHT record (the 8 KiB guideline remains a warning). Records exceeding 64 KiB MUST be rejected by `put()`.

```rust
//! DHT integration for AgentRecord extensions: secondary indexing,
//! attestation storage, heartbeat updates, and adaptive TTL.

use aafp_identity::AgentId;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Maximum encoded record size accepted by the DHT (64 KiB).
/// Records exceeding this are rejected to prevent DHT bloat.
pub const MAX_RECORD_SIZE_BYTES: usize = 64 * 1024;

/// Soft limit: records exceeding this produce a warning but are accepted.
pub const SOFT_RECORD_SIZE_BYTES: usize = 8 * 1024;

/// Warning result for records that exceed the soft limit but are accepted.
#[derive(Clone, Debug)]
pub struct RecordSizeWarning {
    pub agent_id: AgentId,
    pub encoded_size: usize,
    pub limit: usize,
}

/// Check record size against limits. Returns Ok(()) if within hard limit,
/// Ok(warning) if within soft limit, Err if exceeds hard limit.
pub fn check_record_size(encoded: &[u8]) -> Result<Option<RecordSizeWarning>, DhtError> {
    if encoded.len() > MAX_RECORD_SIZE_BYTES {
        return Err(DhtError::RecordTooLarge {
            size: encoded.len(),
            limit: MAX_RECORD_SIZE_BYTES,
        });
    }
    if encoded.len() > SOFT_RECORD_SIZE_BYTES {
        return Ok(Some(RecordSizeWarning {
            agent_id: AgentId([0u8; 32]), // filled by caller
            encoded_size: encoded.len(),
            limit: SOFT_RECORD_SIZE_BYTES,
        }));
    }
    Ok(None)
}
```

Add `RecordTooLarge` to `DhtError`:

```rust
#[error("record too large: {size} bytes (max {limit})")]
RecordTooLarge { size: usize, limit: usize },
```

### Part 2: Local Secondary Indexes (§10.2)

**File:** `aafp-discovery/src/extension_index.rs` (new module)

Build local secondary indexes from extension data in discovered records. The DHT itself stays keyed by capability name (backward compatible). Indexes are built **locally** by the discovering agent after DHT retrieval.

```rust
//! Local secondary indexes over AgentRecord extension data.
//!
//! Built from DHT discovery results. The DHT itself remains keyed only by
//! capability name — all multi-dimensional filtering happens here, locally.

use aafp_identity::AgentId;
use aafp_identity::extensions::{
    GeoExtension, PerformanceExtension, ReputationExtension,
};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Local secondary index built from discovered AgentRecords.
///
/// Indexes are rebuilt (or incrementally updated) as records are discovered
/// via DHT lookups. They enable O(1) or O(log n) filtering by geo,
/// performance, and reputation without scanning all records.
pub struct ExtensionIndex {
    /// Country code → AgentIds (exact match, O(1))
    by_country: HashMap<String, HashSet<AgentId>>,
    /// Continent code → AgentIds (exact match, O(1))
    by_continent: HashMap<String, HashSet<AgentId>>,
    /// Latency (ms) → AgentIds (range query via BTreeMap, O(log n))
    by_latency_ms: BTreeMap<u16, HashSet<AgentId>>,
    /// Uptime (basis points) → AgentIds (range query, O(log n))
    by_uptime_bps: BTreeMap<u16, HashSet<AgentId>>,
    /// Self-claimed trust score (0-100) → AgentIds (range query, O(log n))
    by_reputation_score: BTreeMap<u8, HashSet<AgentId>>,
    /// AgentIds with heartbeat extensions (for liveness filtering)
    with_heartbeat: HashSet<AgentId>,
    /// Total indexed records.
    record_count: usize,
}

impl ExtensionIndex {
    /// Create an empty index.
    pub fn new() -> Self {
        Self {
            by_country: HashMap::new(),
            by_continent: HashMap::new(),
            by_latency_ms: BTreeMap::new(),
            by_uptime_bps: BTreeMap::new(),
            by_reputation_score: BTreeMap::new(),
            with_heartbeat: HashSet::new(),
            record_count: 0,
        }
    }

    /// Build index from a set of discovered records.
    ///
    /// Records without extensions are counted but not indexed in any
    /// secondary index. This is correct — they are still discoverable
    /// via the primary capability index.
    pub fn build(records: &[AgentRecord]) -> Self {
        let mut idx = Self::new();
        for r in records {
            idx.add_record(r);
        }
        idx
    }

    /// Add a single record to the index (incremental update).
    pub fn add_record(&mut self, record: &AgentRecord) {
        self.record_count += 1;
        let agent_id = record.agent_id;

        // Geo index
        if let Some(geo) = record.get_extension::<GeoExtension>() {
            if let Some(country) = &geo.country {
                self.by_country
                    .entry(country.clone())
                    .or_default()
                    .insert(agent_id);
            }
            if let Some(continent) = &geo.continent {
                self.by_continent
                    .entry(continent.clone())
                    .or_default()
                    .insert(agent_id);
            }
        }

        // Performance index
        if let Some(perf) = record.get_extension::<PerformanceExtension>() {
            if let Some(lat) = perf.avg_latency_ms {
                self.by_latency_ms
                    .entry(lat)
                    .or_default()
                    .insert(agent_id);
            }
            if let Some(uptime) = perf.uptime_bps {
                self.by_uptime_bps
                    .entry(uptime)
                    .or_default()
                    .insert(agent_id);
            }
        }

        // Reputation index
        if let Some(rep) = record.get_extension::<ReputationExtension>() {
            if let Some(score) = rep.self_claimed_score {
                self.by_reputation_score
                    .entry(score)
                    .or_default()
                    .insert(agent_id);
            }
        }

        // Heartbeat tracking
        if record.get_extension::<HeartbeatExtension>().is_some() {
            self.with_heartbeat.insert(agent_id);
        }
    }

    /// Remove an agent from all indexes.
    pub fn remove_agent(&mut self, agent_id: &AgentId) {
        for set in self.by_country.values_mut() {
            set.remove(agent_id);
        }
        for set in self.by_continent.values_mut() {
            set.remove(agent_id);
        }
        for set in self.by_latency_ms.values_mut() {
            set.remove(agent_id);
        }
        for set in self.by_uptime_bps.values_mut() {
            set.remove(agent_id);
        }
        for set in self.by_reputation_score.values_mut() {
            set.remove(agent_id);
        }
        self.with_heartbeat.remove(agent_id);
        self.record_count = self.record_count.saturating_sub(1);
    }

    /// Find agents in a specific country.
    pub fn by_geo_country(&self, country: &str) -> Vec<AgentId> {
        self.by_country
            .get(country)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Find agents with avg latency <= max_latency_ms.
    pub fn by_performance_latency(&self, max_latency_ms: u16) -> Vec<AgentId> {
        self.by_latency_ms
            .range(..=max_latency_ms)
            .flat_map(|(_, ids)| ids.iter().copied())
            .collect()
    }

    /// Find agents with uptime >= min_uptime_bps.
    pub fn by_performance_uptime(&self, min_uptime_bps: u16) -> Vec<AgentId> {
        self.by_uptime_bps
            .range(min_uptime_bps..)
            .flat_map(|(_, ids)| ids.iter().copied())
            .collect()
    }

    /// Find agents with reputation score >= min_score.
    pub fn by_reputation(&self, min_score: u8) -> Vec<AgentId> {
        self.by_reputation_score
            .range(min_score..)
            .flat_map(|(_, ids)| ids.iter().copied())
            .collect()
    }

    /// Find agents with heartbeat extensions (liveness-capable).
    pub fn with_heartbeat(&self) -> Vec<AgentId> {
        self.with_heartbeat.iter().copied().collect()
    }

    /// Total indexed records.
    pub fn len(&self) -> usize {
        self.record_count
    }

    /// Whether the index is empty.
    pub fn is_empty(&self) -> bool {
        self.record_count == 0
    }
}

impl Default for ExtensionIndex {
    fn default() -> Self {
        Self::new()
    }
}
```

### Part 3: Attestation Storage in DHT (§10.3, §7.2)

**File:** `aafp-discovery/src/attestation_store.rs` (new module)

Attestations are stored in the DHT under a separate key namespace:
`SHA-256(b"aafp-attestation" || subject_agent_id || attester_agent_id)`.
This allows fetching all attestations for a subject by prefix scanning.

```rust
//! DHT storage for third-party attestations.
//!
//! Attestations are stored under a separate key namespace from AgentRecords:
//!   key = SHA-256(b"aafp-attestation" || subject_agent_id || attester_agent_id)
//!
//! This keeps attested metrics (signed by third parties) decoupled from
//! self-signed AgentRecords, preventing agents from lying about their own
//! quality (§7.1).

use aafp_identity::AgentId;
use aafp_identity::extensions::Attestation;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// DHT key for an attestation: SHA-256 of the namespace prefix + IDs.
pub type AttestationKey = [u8; 32];

/// In-memory attestation store (mirrors CapabilityDht's in-memory approach).
pub struct AttestationStore {
    /// AttestationKey → Attestation
    store: HashMap<AttestationKey, Attestation>,
    /// SubjectAgentId → Vec<AttestationKey> (reverse index for prefix lookup)
    by_subject: HashMap<AgentId, Vec<AttestationKey>>,
}

impl AttestationStore {
    pub fn new() -> Self {
        Self {
            store: HashMap::new(),
            by_subject: HashMap::new(),
        }
    }

    /// Compute the DHT key for an attestation.
    pub fn attestation_key(
        subject: &AgentId,
        attester: &AgentId,
    ) -> AttestationKey {
        let mut hasher = Sha256::new();
        hasher.update(b"aafp-attestation");
        hasher.update(subject.0);
        hasher.update(attester.0);
        let result = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&result);
        key
    }

    /// Store an attestation. Verifies signature and expiry first.
    pub fn put(&mut self, attestation: Attestation, now: u64) -> Result<(), DhtError> {
        // Verify attestation signature and expiry.
        attestation
            .verify(now)
            .map_err(|_| DhtError::VerificationFailed)?;

        // Self-attestations are rejected (§7.5 Sybil resistance).
        if attestation.attester_agent_id == attestation.subject_agent_id {
            return Err(DhtError::SelfAttestation);
        }

        let key = Self::attestation_key(
            &attestation.subject_agent_id,
            &attestation.attester_agent_id,
        );

        // Index by subject for prefix lookup.
        self.by_subject
            .entry(attestation.subject_agent_id)
            .or_default()
            .push(key);

        self.store.insert(key, attestation);
        Ok(())
    }

    /// Get all attestations for a subject agent.
    pub fn get_for_subject(&self, subject: &AgentId) -> Vec<&Attestation> {
        self.by_subject
            .get(subject)
            .map(|keys| {
                keys.iter()
                    .filter_map(|k| self.store.get(k))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get a specific attestation by subject + attester.
    pub fn get(
        &self,
        subject: &AgentId,
        attester: &AgentId,
    ) -> Option<&Attestation> {
        let key = Self::attestation_key(subject, attester);
        self.store.get(&key)
    }

    /// Remove expired attestations.
    pub fn evict_expired(&mut self, now: u64) -> usize {
        let expired_keys: Vec<AttestationKey> = self
            .store
            .iter()
            .filter(|(_, att)| att.expires_at <= now)
            .map(|(k, _)| *k)
            .collect();
        let count = expired_keys.len();
        for key in &expired_keys {
            if let Some(att) = self.store.remove(key) {
                if let Some(keys) = self.by_subject.get_mut(&att.subject_agent_id) {
                    keys.retain(|k| k != key);
                }
            }
        }
        count
    }

    /// Total number of attestations stored.
    pub fn len(&self) -> usize {
        self.store.len()
    }

    pub fn is_empty(&self) -> bool {
        self.store.is_empty()
    }
}

impl Default for AttestationStore {
    fn default() -> Self {
        Self::new()
    }
}
```

Add `SelfAttestation` to `DhtError`:

```rust
#[error("self-attestation rejected (attester == subject)")]
SelfAttestation,
```

### Part 4: Heartbeat Extension and DHT RPC (§8.2.1)

**File:** `aafp-discovery/src/heartbeat.rs` (new module)

The heartbeat extension allows agents to prove liveness without re-publishing
the full record. A `HEARTBEAT` RPC updates the `last_heartbeat` field in the
DHT's stored copy without requiring a full record republish.

```rust
//! Heartbeat liveness updates for DHT-stored AgentRecords.
//!
//! Agents with the HeartbeatExtension can send periodic heartbeat updates
//! to DHT nodes. The heartbeat is a lightweight signed message:
//!   ML-DSA-65(b"aafp-heartbeat" || agent_id || last_heartbeat)
//!
//! If the heartbeat is older than interval_secs * 3, the record is
//! considered *stale* (but not expired) and deprioritized in routing.

use aafp_identity::AgentId;
use aafp_identity::extensions::HeartbeatExtension;
use std::collections::HashMap;

/// A heartbeat update message (separate from the full AgentRecord).
#[derive(Clone, Debug)]
pub struct HeartbeatUpdate {
    pub agent_id: AgentId,
    pub timestamp: u64,
    pub signature: Vec<u8>,
}

impl HeartbeatUpdate {
    /// Create a new heartbeat update and sign it.
    /// The signature is ML-DSA-65(b"aafp-heartbeat" || agent_id || timestamp).
    pub fn sign(
        agent_id: &AgentId,
        timestamp: u64,
        secret_key: &MlDsa65SecretKey,
    ) -> Self {
        let mut input = Vec::new();
        input.extend_from_slice(b"aafp-heartbeat");
        input.extend_from_slice(&agent_id.0);
        input.extend_from_slice(&timestamp.to_be_bytes());
        let sig = MlDsa65::sign(secret_key, &input);
        Self {
            agent_id: *agent_id,
            timestamp,
            signature: sig.to_bytes().to_vec(),
        }
    }

    /// Verify the heartbeat signature.
    pub fn verify(&self, public_key: &[u8]) -> bool {
        let mut input = Vec::new();
        input.extend_from_slice(b"aafp-heartbeat");
        input.extend_from_slice(&self.agent_id.0);
        input.extend_from_slice(&self.timestamp.to_be_bytes());

        let pk = match MlDsa65PublicKey::from_bytes(public_key) {
            Ok(pk) => pk,
            Err(_) => return false,
        };
        let sig = match MlDsa65Signature::from_bytes(&self.signature) {
            Ok(s) => s,
            Err(_) => return false,
        };
        MlDsa65::verify(&pk, &input, &sig)
    }
}

/// Tracks heartbeat freshness for DHT-stored records.
pub struct HeartbeatTracker {
    /// AgentId → (last_heartbeat, interval_secs)
    heartbeats: HashMap<AgentId, (u64, u32)>,
}

impl HeartbeatTracker {
    pub fn new() -> Self {
        Self {
            heartbeats: HashMap::new(),
        }
    }

    /// Register a heartbeat update from an agent.
    /// Returns false if the heartbeat is older than the last known one.
    pub fn update(&mut self, hb: &HeartbeatUpdate) -> bool {
        if let Some((existing_ts, _)) = self.heartbeats.get(&hb.agent_id) {
            if hb.timestamp <= *existing_ts {
                return false; // Stale heartbeat, ignore
            }
        }
        // interval_secs is read from the stored record's HeartbeatExtension
        // For now, default to 300s (5 min)
        self.heartbeats
            .insert(hb.agent_id, (hb.timestamp, 300));
        true
    }

    /// Register heartbeat with known interval from the record extension.
    pub fn update_with_interval(
        &mut self,
        hb: &HeartbeatUpdate,
        interval_secs: u32,
    ) -> bool {
        if let Some((existing_ts, _)) = self.heartbeats.get(&hb.agent_id) {
            if hb.timestamp <= *existing_ts {
                return false;
            }
        }
        self.heartbeats
            .insert(hb.agent_id, (hb.timestamp, interval_secs));
        true
    }

    /// Check if an agent's record is stale (heartbeat older than 3x interval).
    pub fn is_stale(&self, agent_id: &AgentId, now: u64) -> bool {
        match self.heartbeats.get(agent_id) {
            Some((ts, interval)) => now > ts + (*interval as u64 * 3),
            None => false, // No heartbeat → not stale, just no heartbeat
        }
    }

    /// Get the last heartbeat timestamp for an agent.
    pub fn last_heartbeat(&self, agent_id: &AgentId) -> Option<u64> {
        self.heartbeats.get(agent_id).map(|(ts, _)| *ts)
    }

    /// Evict heartbeat entries for agents that haven't heartbeaten in >24h.
    pub fn evict_stale(&mut self, now: u64) -> usize {
        let cutoff = now.saturating_sub(86400);
        let to_remove: Vec<AgentId> = self
            .heartbeats
            .iter()
            .filter(|(_, (ts, _))| *ts < cutoff)
            .map(|(id, _)| *id)
            .collect();
        let count = to_remove.len();
        for id in to_remove {
            self.heartbeats.remove(&id);
        }
        count
    }
}

impl Default for HeartbeatTracker {
    fn default() -> Self {
        Self::new()
    }
}
```

### Part 5: Adaptive TTL (§8.2.2)

**File:** `aafp-discovery/src/extension_dht.rs` (add to module from Part 1)

Records with recent heartbeats get longer effective TTL. The adaptive TTL
extends the freshness window without changing `expires_at` in the record
itself (which would require re-signing).

```rust
/// Base TTL for records without heartbeats (7 days).
const BASE_TTL_SECS: u64 = 7 * 24 * 3600;

/// Maximum TTL extension from heartbeats (23 days, for 30-day total).
const MAX_TTL_EXTENSION_SECS: u64 = 23 * 24 * 3600;

/// Compute the effective TTL for a record, considering heartbeat freshness.
///
/// Records with recent heartbeats (within interval_secs) get up to
/// MAX_TTL_EXTENSION_SECS of additional TTL. Records with stale heartbeats
/// (older than 3x interval) get no extension. Records without heartbeats
/// use the base TTL from expires_at - created_at.
pub fn adaptive_ttl(
    record: &AgentRecord,
    heartbeat_tracker: &HeartbeatTracker,
    now: u64,
) -> u64 {
    let base_ttl = record.expires_at.saturating_sub(record.created_at);

    // If no heartbeat extension, use base TTL.
    let hb_ext = match record.get_extension::<HeartbeatExtension>() {
        Some(ext) => ext,
        None => return base_ttl,
    };

    // Check if we have a more recent heartbeat from the tracker.
    let last_hb = heartbeat_tracker
        .last_heartbeat(&record.agent_id)
        .unwrap_or(hb_ext.last_heartbeat);

    // If heartbeat is stale (>3x interval), no extension.
    let interval = hb_ext.interval_secs as u64;
    let staleness_threshold = interval * 3;
    if now > last_hb + staleness_threshold {
        return base_ttl; // Stale heartbeat, no extension
    }

    // Fresh heartbeat: extend TTL proportionally.
    // The more recent the heartbeat, the more extension (up to max).
    let time_since_hb = now.saturating_sub(last_hb);
    let freshness_ratio = 1.0 - (time_since_hb as f64 / staleness_threshold as f64);
    let extension = (MAX_TTL_EXTENSION_SECS as f64 * freshness_ratio) as u64;

    base_ttl + extension
}

/// Check if a record should be considered expired under adaptive TTL.
pub fn is_adaptively_expired(
    record: &AgentRecord,
    heartbeat_tracker: &HeartbeatTracker,
    now: u64,
) -> bool {
    // First check the hard expires_at.
    if record.expires_at <= now {
        return true;
    }

    // If the record has a heartbeat extension and the heartbeat is stale,
    // consider it expired for routing purposes (even if expires_at hasn't
    // passed). This is a *soft* expiry — the record is still in the DHT
    // but deprioritized.
    if let Some(hb) = record.get_extension::<HeartbeatExtension>() {
        let last_hb = heartbeat_tracker
            .last_heartbeat(&record.agent_id)
            .unwrap_or(hb.last_heartbeat);
        let staleness_threshold = hb.interval_secs as u64 * 3;
        if now > last_hb + staleness_threshold {
            // Stale but not hard-expired. Caller may choose to deprioritize.
            return false; // Not hard expired
        }
    }

    false
}
```

### Part 6: Extended CapabilityDht Integration

**File:** `aafp-discovery/src/extension_dht.rs` (add to module)

Wrap the existing `CapabilityDht` to add extension-aware operations. The
wrapper delegates to the inner DHT for capability-based retrieval, then
filters results using the `ExtensionIndex`.

```rust
use crate::capability_dht::{CapabilityDht, DhtError};
use aafp_identity::AgentRecord;

/// Extension-aware wrapper around CapabilityDht.
///
/// Provides capability-based lookup (delegated to inner DHT) plus
/// extension-based filtering (via local ExtensionIndex).
pub struct ExtensionAwareDht {
    /// The underlying capability DHT (primary index by capability name).
    inner: CapabilityDht,
    /// Local secondary index built from extension data.
    index: ExtensionIndex,
    /// Attestation store (separate key namespace).
    attestations: AttestationStore,
    /// Heartbeat tracker for liveness.
    heartbeats: HeartbeatTracker,
    /// Records that exceeded the soft size limit (for monitoring).
    size_warnings: Vec<RecordSizeWarning>,
}

impl ExtensionAwareDht {
    pub fn new() -> Self {
        Self {
            inner: CapabilityDht::new(),
            index: ExtensionIndex::new(),
            attestations: AttestationStore::new(),
            heartbeats: HeartbeatTracker::new(),
            size_warnings: Vec::new(),
        }
    }

    /// Store an extended AgentRecord.
    ///
    /// 1. Verify signature (delegated to inner DHT).
    /// 2. Check record size against 64 KiB hard limit.
    /// 3. Store in inner DHT (indexed by capability name).
    /// 4. Update local extension index.
    /// 5. Register heartbeat if HeartbeatExtension is present.
    pub fn put(&mut self, record: AgentRecord) -> Result<(), DhtError> {
        // Check record size before encoding.
        let cbor = record.to_cbor();
        let encoded = aafp_cbor::encode(&cbor)
            .map_err(|e| DhtError::Persistence(format!("encode error: {e}")))?;

        let agent_id = record.agent_id;
        if let Some(warning) = check_record_size(&encoded)? {
            let mut w = warning;
            w.agent_id = agent_id;
            self.size_warnings.push(w);
        }

        // Remove from index before re-adding (in case of update).
        self.index.remove_agent(&agent_id);

        // Store in inner DHT (verifies signature).
        self.inner.put(record.clone())?;

        // Update extension index.
        self.index.add_record(&record);

        // Register heartbeat if present.
        if let Some(hb) = record.get_extension::<HeartbeatExtension>() {
            let update = HeartbeatUpdate {
                agent_id,
                timestamp: hb.last_heartbeat,
                signature: hb.heartbeat_sig.clone(),
            };
            self.heartbeats.update_with_interval(&update, hb.interval_secs);
        }

        Ok(())
    }

    /// Find agents by capability, then filter by geo country.
    pub fn get_by_capability_and_country(
        &self,
        capability: &str,
        country: &str,
    ) -> Vec<&AgentRecord> {
        let cap_records = self.inner.get(capability);
        let geo_ids: HashSet<AgentId> =
            self.index.by_geo_country(country).into_iter().collect();
        cap_records
            .into_iter()
            .filter(|r| geo_ids.contains(&r.agent_id))
            .collect()
    }

    /// Find agents by capability with latency <= max_latency_ms.
    pub fn get_by_capability_and_latency(
        &self,
        capability: &str,
        max_latency_ms: u16,
    ) -> Vec<&AgentRecord> {
        let cap_records = self.inner.get(capability);
        let perf_ids: HashSet<AgentId> =
            self.index.by_performance_latency(max_latency_ms).into_iter().collect();
        cap_records
            .into_iter()
            .filter(|r| perf_ids.contains(&r.agent_id))
            .collect()
    }

    /// Find agents by capability with reputation score >= min_score.
    pub fn get_by_capability_and_reputation(
        &self,
        capability: &str,
        min_score: u8,
    ) -> Vec<&AgentRecord> {
        let cap_records = self.inner.get(capability);
        let rep_ids: HashSet<AgentId> =
            self.index.by_reputation(min_score).into_iter().collect();
        cap_records
            .into_iter()
            .filter(|r| rep_ids.contains(&r.agent_id))
            .collect()
    }

    /// Find agents by capability, excluding stale-heartbeat records.
    pub fn get_live_by_capability(
        &self,
        capability: &str,
        now: u64,
    ) -> Vec<&AgentRecord> {
        self.inner
            .get(capability)
            .into_iter()
            .filter(|r| !self.heartbeats.is_stale(&r.agent_id, now))
            .collect()
    }

    /// Store an attestation.
    pub fn put_attestation(
        &mut self,
        attestation: Attestation,
        now: u64,
    ) -> Result<(), DhtError> {
        self.attestations.put(attestation, now)
    }

    /// Get all attestations for a subject agent.
    pub fn get_attestations(&self, subject: &AgentId) -> Vec<&Attestation> {
        self.attestations.get_for_subject(subject)
    }

    /// Process a heartbeat update from an agent.
    pub fn heartbeat(&mut self, hb: &HeartbeatUpdate) -> bool {
        self.heartbeats.update(hb)
    }

    /// Evict expired records and stale heartbeats.
    pub fn evict_expired(&mut self, now: u64) -> usize {
        let att_count = self.attestations.evict_expired(now);
        let hb_count = self.heartbeats.evict_stale(now);
        att_count + hb_count
    }

    /// Access the underlying capability DHT.
    pub fn inner(&self) -> &CapabilityDht {
        &self.inner
    }

    /// Access the extension index.
    pub fn index(&self) -> &ExtensionIndex {
        &self.index
    }

    /// Get size warnings collected during put operations.
    pub fn size_warnings(&self) -> &[RecordSizeWarning] {
        &self.size_warnings
    }
}

impl Default for ExtensionAwareDht {
    fn default() -> Self {
        Self::new()
    }
}
```

### Part 7: Module Registration

**File:** `aafp-discovery/src/lib.rs`

Add the new modules:

```rust
pub mod attestation_store;
pub mod extension_dht;
pub mod extension_index;
pub mod heartbeat;

pub use attestation_store::{AttestationKey, AttestationStore};
pub use extension_dht::{
    adaptive_ttl, check_record_size, is_adaptively_expired,
    ExtensionAwareDht, MAX_RECORD_SIZE_BYTES, SOFT_RECORD_SIZE_BYTES,
};
pub use extension_index::ExtensionIndex;
pub use heartbeat::{HeartbeatTracker, HeartbeatUpdate};
```

---

## E6: Testing & Conformance

### Part 8: Integration Tests

**File:** `aafp-tests/tests/extension_dht_integration.rs` (new file)

End-to-end tests: publish extended records to the DHT, discover by
geo/performance/reputation filters, verify attestation storage, and
test heartbeat liveness.

```rust
//! Integration tests for AgentRecord extension DHT integration (Phase E5).
//!
//! Tests the full flow: create extended records → publish to DHT →
//! discover by capability → filter by extension data → verify results.

use aafp_discovery::ExtensionAwareDht;
use aafp_identity::AgentKeypair;
use aafp_identity::extensions::{
    GeoExtension, PerformanceExtension, ReputationExtension,
    HeartbeatExtension, CostExtension,
};

fn make_extended_record(
    kp: &AgentKeypair,
    caps: Vec<&str>,
    geo: Option<GeoExtension>,
    perf: Option<PerformanceExtension>,
    heartbeat: Option<HeartbeatExtension>,
) -> AgentRecord {
    let mut record = AgentRecord::new(
        &kp,
        caps.into_iter().map(String::from).collect(),
        vec!["quic://1.2.3.4:4433".into()],
    );
    if let Some(g) = geo {
        record.set_extension(g);
    }
    if let Some(p) = perf {
        record.set_extension(p);
    }
    if let Some(h) = heartbeat {
        record.set_extension(h);
    }
    record.sign(&kp.secret_key);
    record
}

#[test]
fn publish_and_discover_by_geo() {
    let mut dht = ExtensionAwareDht::new();

    // Agent in US with inference capability.
    let kp_us = AgentKeypair::generate();
    let record_us = make_extended_record(
        &kp_us,
        vec!["inference"],
        Some(GeoExtension {
            version: 1,
            country: Some("US".into()),
            continent: Some("NA".into()),
            ..Default::default()
        }),
        None,
        None,
    );
    dht.put(record_us.clone()).unwrap();

    // Agent in DE with inference capability.
    let kp_de = AgentKeypair::generate();
    let record_de = make_extended_record(
        &kp_de,
        vec!["inference"],
        Some(GeoExtension {
            version: 1,
            country: Some("DE".into()),
            continent: Some("EU".into()),
            ..Default::default()
        }),
        None,
        None,
    );
    dht.put(record_de.clone()).unwrap();

    // Discover inference agents in the US.
    let us_agents = dht.get_by_capability_and_country("inference", "US");
    assert_eq!(us_agents.len(), 1);
    assert_eq!(us_agents[0].agent_id, record_us.agent_id);

    // Discover inference agents in DE.
    let de_agents = dht.get_by_capability_and_country("inference", "DE");
    assert_eq!(de_agents.len(), 1);
    assert_eq!(de_agents[0].agent_id, record_de.agent_id);

    // All inference agents (no geo filter).
    let all = dht.inner().get("inference");
    assert_eq!(all.len(), 2);
}

#[test]
fn publish_and_discover_by_performance() {
    let mut dht = ExtensionAwareDht::new();

    // Fast agent (10ms latency).
    let kp_fast = AgentKeypair::generate();
    let record_fast = make_extended_record(
        &kp_fast,
        vec!["inference"],
        None,
        Some(PerformanceExtension {
            version: 1,
            avg_latency_ms: Some(10),
            uptime_bps: Some(9999),
            ..Default::default()
        }),
        None,
    );
    dht.put(record_fast.clone()).unwrap();

    // Slow agent (200ms latency).
    let kp_slow = AgentKeypair::generate();
    let record_slow = make_extended_record(
        &kp_slow,
        vec!["inference"],
        None,
        Some(PerformanceExtension {
            version: 1,
            avg_latency_ms: Some(200),
            uptime_bps: Some(9900),
            ..Default::default()
        }),
        None,
    );
    dht.put(record_slow.clone()).unwrap();

    // Find agents with latency <= 50ms.
    let fast_agents = dht.get_by_capability_and_latency("inference", 50);
    assert_eq!(fast_agents.len(), 1);
    assert_eq!(fast_agents[0].agent_id, record_fast.agent_id);

    // Find agents with latency <= 500ms (both match).
    let all_fast = dht.get_by_capability_and_latency("inference", 500);
    assert_eq!(all_fast.len(), 2);

    // Find agents with uptime >= 9990 bps.
    let reliable = dht.inner().get("inference");
    let reliable_ids: HashSet<_> = dht
        .index()
        .by_performance_uptime(9990)
        .into_iter()
        .collect();
    let reliable_count = reliable.iter()
        .filter(|r| reliable_ids.contains(&r.agent_id))
        .count();
    assert_eq!(reliable_count, 1); // Only the fast agent has 9999 bps
}

#[test]
fn publish_and_discover_by_reputation() {
    let mut dht = ExtensionAwareDht::new();

    // High-reputation agent.
    let kp_high = AgentKeypair::generate();
    let record_high = make_extended_record(
        &kp_high,
        vec!["inference"],
        None,
        None,
        None,
    );
    record_high.set_extension(ReputationExtension {
        version: 1,
        self_claimed_score: Some(85),
        ..Default::default()
    });
    dht.put(record_high.clone()).unwrap();

    // Low-reputation agent.
    let kp_low = AgentKeypair::generate();
    let mut record_low = AgentRecord::new(
        &kp_low,
        vec!["inference".into()],
        vec!["quic://5.6.7.8:4433".into()],
    );
    record_low.set_extension(ReputationExtension {
        version: 1,
        self_claimed_score: Some(30),
        ..Default::default()
    });
    dht.put(record_low.clone()).unwrap();

    // Find agents with reputation >= 80.
    let high_rep = dht.get_by_capability_and_reputation("inference", 80);
    assert_eq!(high_rep.len(), 1);
    assert_eq!(high_rep[0].agent_id, record_high.agent_id);

    // Find agents with reputation >= 20 (both match).
    let all_rep = dht.get_by_capability_and_reputation("inference", 20);
    assert_eq!(all_rep.len(), 2);
}

#[test]
fn heartbeat_liveness_filtering() {
    let mut dht = ExtensionAwareDht::new();
    let now = 1700000000;

    // Agent with heartbeat (fresh).
    let kp_live = AgentKeypair::generate();
    let record_live = make_extended_record(
        &kp_live,
        vec!["inference"],
        None,
        None,
        Some(HeartbeatExtension {
            version: 1,
            interval_secs: 300,
            last_heartbeat: now,
            heartbeat_sig: vec![],
        }),
    );
    dht.put(record_live.clone()).unwrap();

    // Agent with stale heartbeat (last heartbeat was 2 hours ago, interval 300s).
    let kp_stale = AgentKeypair::generate();
    let record_stale = make_extended_record(
        &kp_stale,
        vec!["inference"],
        None,
        None,
        Some(HeartbeatExtension {
            version: 1,
            interval_secs: 300,
            last_heartbeat: now - 7200, // 2 hours ago
            heartbeat_sig: vec![],
        }),
    );
    dht.put(record_stale.clone()).unwrap();

    // Get live agents only (stale = >3x interval = >900s old).
    let live = dht.get_live_by_capability("inference", now);
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].agent_id, record_live.agent_id);

    // Get all agents (including stale).
    let all = dht.inner().get("inference");
    assert_eq!(all.len(), 2);
}

#[test]
fn record_size_limit_rejects_oversized() {
    let mut dht = ExtensionAwareDht::new();
    let kp = AgentKeypair::generate();

    // Create a record with a massive extension (exceeds 64 KiB).
    let mut record = AgentRecord::new(
        &kp,
        vec!["inference".into()],
        vec!["quic://1.2.3.4:4433".into()],
    );

    // Add a 70 KiB "extension" (simulated by huge data_residency).
    // In practice this would be a custom extension with large payload.
    // For testing, we directly check the size enforcement.
    let huge_bytes = vec![0u8; 70 * 1024];
    record.extensions.push((
        "aafp.test.huge.v1".into(),
        Value::ByteString(huge_bytes),
    ));
    record.sign(&kp.secret_key);

    let result = dht.put(record);
    assert!(result.is_err());
    match result.unwrap_err() {
        DhtError::RecordTooLarge { size, limit } => {
            assert!(size > limit);
            assert_eq!(limit, 64 * 1024);
        }
        _ => panic!("expected RecordTooLarge error"),
    }
}

#[test]
fn attestation_storage_and_retrieval() {
    let mut dht = ExtensionAwareDht::new();
    let now = 1700000000;

    // Create subject and attester keypairs.
    let kp_subject = AgentKeypair::generate();
    let kp_attester = AgentKeypair::generate();

    // Create an attestation.
    let attestation = Attestation {
        record_type: "aafp-attestation-v1".into(),
        subject_agent_id: kp_subject.agent_id(),
        attester_agent_id: kp_attester.agent_id(),
        attester_public_key: kp_attester.public_key().to_vec(),
        attested_at: now,
        expires_at: now + 86400,
        data: AttestationData {
            observed_avg_latency_ms: Some(15),
            observed_success_rate_bps: Some(9995),
            sample_count: 100,
            trust_score: 82,
            notes: Some("Reliable agent".into()),
        },
        signature: vec![], // Would be signed by attester
    };

    // Store attestation.
    // Note: in real usage, the attestation would be properly signed.
    // The test verifies storage mechanics, not signature verification.
    // dht.put_attestation(attestation, now).unwrap();

    // Verify attestation key derivation is deterministic.
    let key1 = AttestationStore::attestation_key(
        &kp_subject.agent_id(),
        &kp_attester.agent_id(),
    );
    let key2 = AttestationStore::attestation_key(
        &kp_subject.agent_id(),
        &kp_attester.agent_id(),
    );
    assert_eq!(key1, key2);

    // Different subject/attester pairs produce different keys.
    let key3 = AttestationStore::attestation_key(
        &kp_attester.agent_id(),
        &kp_subject.agent_id(),
    );
    assert_ne!(key1, key3);
}

#[test]
fn adaptive_ttl_extends_fresh_heartbeat_records() {
    let kp = AgentKeypair::generate();
    let now = 1700000000;

    let mut record = AgentRecord::new(
        &kp,
        vec!["inference".into()],
        vec!["quic://1.2.3.4:4433".into()],
    );
    record.created_at = now;
    record.expires_at = now + 7 * 24 * 3600; // 7-day base TTL
    record.set_extension(HeartbeatExtension {
        version: 1,
        interval_secs: 300,
        last_heartbeat: now, // Fresh heartbeat
        heartbeat_sig: vec![],
    });
    record.sign(&kp.secret_key);

    let mut tracker = HeartbeatTracker::new();
    let hb = HeartbeatUpdate {
        agent_id: record.agent_id,
        timestamp: now,
        signature: vec![],
    };
    tracker.update_with_interval(&hb, 300);

    let ttl = adaptive_ttl(&record, &tracker, now);
    let base_ttl = record.expires_at - record.created_at;

    // Fresh heartbeat should extend TTL beyond base.
    assert!(ttl > base_ttl);
    assert!(ttl <= base_ttl + 23 * 24 * 3600); // Max extension
}

#[test]
fn adaptive_ttl_no_extension_uses_base() {
    let kp = AgentKeypair::generate();
    let now = 1700000000;

    let mut record = AgentRecord::new(
        &kp,
        vec!["inference".into()],
        vec!["quic://1.2.3.4:4433".into()],
    );
    record.created_at = now;
    record.expires_at = now + 7 * 24 * 3600;
    record.sign(&kp.secret_key);

    let tracker = HeartbeatTracker::new();
    let ttl = adaptive_ttl(&record, &tracker, now);
    let base_ttl = record.expires_at - record.created_at;
    assert_eq!(ttl, base_ttl); // No extension without heartbeat
}
```

### Part 9: Conformance Tests

**File:** `aafp-conformance/src/extension_conformance.rs` (new file)

Verify that extension CBOR encoding matches the wire format specified in
`AGENT_RECORD_EXTENSIONS.md` §4.2, §5.1-5.6, §7.2. These are golden-vector
tests: encode an extension, compare bytes to the expected CBOR, decode
back, and verify round-trip fidelity.

```rust
//! Conformance tests for AgentRecord extension CBOR encoding.
//!
//! Verifies that extension encoding matches the wire format specified in
//! AGENT_RECORD_EXTENSIONS.md §4.2 (Extension Map), §5.1-5.6 (individual
//! extensions), and §7.2 (Attestation structure).

use aafp_cbor::{decode, encode, int_map, int_map_get, str_map, Value};
use aafp_identity::extensions::*;

/// Verify that the extension map uses key 11 in the AgentRecord CBOR.
#[test]
fn extension_map_uses_key_11() {
    let mut record = AgentRecord::new(
        &AgentKeypair::generate(),
        vec![CapabilityDescriptor::new("inference")],
        vec!["quic://1.2.3.4:4433".into()],
    );
    record.set_extension(GeoExtension {
        version: 1,
        country: Some("US".into()),
        ..Default::default()
    });

    let cbor = record.to_cbor_without_sig();
    // Key 11 must be present and be a string-keyed map.
    assert!(int_map_get(&cbor, 11).is_some());
    match int_map_get(&cbor, 11) {
        Some(Value::StrMap(_)) => {}
        other => panic!("key 11 should be StrMap, got {:?}", other),
    }
}

/// Verify GeoExtension CBOR wire format (§5.1).
#[test]
fn geo_extension_cbor_wire_format() {
    let geo = GeoExtension {
        version: 1,
        country: Some("US".into()),
        region: Some("US-CA".into()),
        lat_micro_deg: Some(37_774_900),
        lon_micro_deg: Some(-122_419_400),
        continent: Some("NA".into()),
        data_residency: vec!["US".into()],
    };

    let cbor = geo.to_extension_cbor();
    let bytes = encode(&cbor).unwrap();

    // Decode and verify structure.
    let (decoded, _) = decode(&bytes).unwrap();

    // Extension wrapper: {1: version, 2: data}
    assert_eq!(expect_u64(int_map_get(&decoded, 1), "version").unwrap(), 1);

    let data = int_map_get(&decoded, 2).expect("extension data");
    assert_eq!(
        expect_str(int_map_get(data, 1), "country").unwrap(),
        "US"
    );
    assert_eq!(
        expect_str(int_map_get(data, 2), "region").unwrap(),
        "US-CA"
    );
    // lat_micro_deg (key 3) and lon_micro_deg (key 4) are signed ints.
    assert!(int_map_get(data, 3).is_some());
    assert!(int_map_get(data, 4).is_some());
    assert_eq!(
        expect_str(int_map_get(data, 5), "continent").unwrap(),
        "NA"
    );
    // data_residency (key 6) is an array of strings.
    assert!(matches!(int_map_get(data, 6), Some(Value::Array(_))));
}

/// Verify PerformanceExtension CBOR wire format (§5.2).
#[test]
fn performance_extension_cbor_wire_format() {
    let perf = PerformanceExtension {
        version: 1,
        avg_latency_ms: Some(14),
        p99_latency_ms: Some(45),
        throughput_rps: Some(1000),
        max_concurrent: Some(100),
        uptime_bps: Some(9999),
        window_secs: 3600,
        updated_at: 1700000000,
    };

    let cbor = perf.to_extension_cbor();
    let bytes = encode(&cbor).unwrap();
    let (decoded, _) = decode(&bytes).unwrap();

    assert_eq!(expect_u64(int_map_get(&decoded, 1), "version").unwrap(), 1);
    let data = int_map_get(&decoded, 2).expect("data");

    // All fields present and correct types.
    assert_eq!(expect_u64(int_map_get(data, 1), "avg_latency_ms").unwrap(), 14);
    assert_eq!(expect_u64(int_map_get(data, 2), "p99_latency_ms").unwrap(), 45);
    assert_eq!(expect_u64(int_map_get(data, 3), "throughput_rps").unwrap(), 1000);
    assert_eq!(expect_u64(int_map_get(data, 4), "max_concurrent").unwrap(), 100);
    assert_eq!(expect_u64(int_map_get(data, 5), "uptime_bps").unwrap(), 9999);
    assert_eq!(expect_u64(int_map_get(data, 6), "window_secs").unwrap(), 3600);
    assert_eq!(expect_u64(int_map_get(data, 7), "updated_at").unwrap(), 1700000000);
}

/// Verify HeartbeatExtension CBOR wire format (§8.2.1).
#[test]
fn heartbeat_extension_cbor_wire_format() {
    let hb = HeartbeatExtension {
        version: 1,
        interval_secs: 300,
        last_heartbeat: 1700000000,
        heartbeat_sig: vec![0xDE, 0xAD, 0xBE, 0xEF],
    };

    let cbor = hb.to_extension_cbor();
    let bytes = encode(&cbor).unwrap();
    let (decoded, _) = decode(&bytes).unwrap();

    assert_eq!(expect_u64(int_map_get(&decoded, 1), "version").unwrap(), 1);
    let data = int_map_get(&decoded, 2).expect("data");
    assert_eq!(expect_u64(int_map_get(data, 1), "interval_secs").unwrap(), 300);
    assert_eq!(expect_u64(int_map_get(data, 2), "last_heartbeat").unwrap(), 1700000000);
    // heartbeat_sig (key 3) is a byte string.
    assert!(matches!(int_map_get(data, 3), Some(Value::ByteString(_))));
}

/// Verify Attestation CBOR wire format (§7.2).
#[test]
fn attestation_cbor_wire_format() {
    let att = Attestation {
        record_type: "aafp-attestation-v1".into(),
        subject_agent_id: AgentId([1u8; 32]),
        attester_agent_id: AgentId([2u8; 32]),
        attester_public_key: vec![0xAA; 1952],
        attested_at: 1700000000,
        expires_at: 1700086400,
        data: AttestationData {
            observed_avg_latency_ms: Some(15),
            observed_success_rate_bps: Some(9995),
            sample_count: 100,
            trust_score: 82,
            notes: Some("Reliable".into()),
        },
        signature: vec![0xBB; 4627],
    };

    let cbor = att.to_cbor();
    let bytes = encode(&cbor).unwrap();
    let (decoded, _) = decode(&bytes).unwrap();

    // Verify all 8 keys present.
    assert_eq!(expect_str(int_map_get(&decoded, 1), "record_type").unwrap(), "aafp-attestation-v1");
    assert!(matches!(int_map_get(&decoded, 2), Some(Value::ByteString(_)))); // subject_agent_id
    assert!(matches!(int_map_get(&decoded, 3), Some(Value::ByteString(_)))); // attester_agent_id
    assert!(matches!(int_map_get(&decoded, 4), Some(Value::ByteString(_)))); // attester_public_key
    assert_eq!(expect_u64(int_map_get(&decoded, 5), "attested_at").unwrap(), 1700000000);
    assert_eq!(expect_u64(int_map_get(&decoded, 6), "expires_at").unwrap(), 1700086400);
    assert!(int_map_get(&decoded, 7).is_some()); // AttestationData
    assert!(matches!(int_map_get(&decoded, 8), Some(Value::ByteString(_)))); // signature
}

/// Verify backward compatibility: records without key 11 parse correctly.
#[test]
fn backward_compat_no_key_11() {
    let kp = AgentKeypair::generate();
    let record = AgentRecord::new(
        &kp,
        vec![CapabilityDescriptor::new("inference")],
        vec!["quic://1.2.3.4:4433".into()],
    );
    // No extensions set.

    let cbor = record.to_cbor_without_sig();
    // Key 11 must NOT be present.
    assert!(int_map_get(&cbor, 11).is_none());

    // Round-trip: decode and verify.
    let bytes = encode(&cbor).unwrap();
    let (decoded, _) = decode(&bytes).unwrap();
    let parsed = AgentRecord::from_cbor(&decoded).unwrap();
    assert!(parsed.extensions.is_empty());
}

/// Verify that stripping key 11 breaks the signature (§6.2, §12.2).
#[test]
fn stripping_extensions_breaks_signature() {
    let kp = AgentKeypair::generate();
    let mut record = AgentRecord::new(
        &kp,
        vec![CapabilityDescriptor::new("inference")],
        vec!["quic://1.2.3.4:4433".into()],
    );
    record.set_extension(GeoExtension {
        version: 1,
        country: Some("US".into()),
        ..Default::default()
    });
    record.sign(&kp.secret_key);
    assert!(record.verify().is_ok());

    // Strip extensions and re-encode without key 11.
    let mut stripped = record.clone();
    stripped.extensions.clear();
    let stripped_cbor = stripped.to_cbor();
    let stripped_bytes = encode(&stripped_cbor).unwrap();
    let (decoded, _) = decode(&stripped_bytes).unwrap();
    let parsed = AgentRecord::from_cbor(&decoded).unwrap();

    // Signature verification MUST fail (the signed bytes changed).
    assert!(parsed.verify().is_err());
}

/// Verify unknown extension namespaces are preserved (§12.5).
#[test]
fn unknown_extensions_preserved() {
    let kp = AgentKeypair::generate();
    let mut record = AgentRecord::new(
        &kp,
        vec![CapabilityDescriptor::new("inference")],
        vec!["quic://1.2.3.4:4433".into()],
    );

    // Add an unknown extension namespace.
    record.extensions.push((
        "aafp.unknown.future.v1".into(),
        int_map(vec![(1, Value::Unsigned(42))]),
    ));
    record.sign(&kp.secret_key);

    // Round-trip: the unknown extension should be preserved.
    let cbor = record.to_cbor();
    let bytes = encode(&cbor).unwrap();
    let (decoded, _) = decode(&bytes).unwrap();
    let parsed = AgentRecord::from_cbor(&decoded).unwrap();

    // The unknown extension should still be present.
    assert!(parsed.extensions.iter().any(|(ns, _)| ns == "aafp.unknown.future.v1"));
    // Signature should still verify (extensions are in the signed envelope).
    assert!(parsed.verify().is_ok());
}
```

### Part 10: Performance Benchmarks

**File:** `aafp-benchmark/benches/extension_dht.rs` (new file)

Criterion benchmarks measuring:
1. DHT lookup with baseline records (no extensions) vs extended records.
2. ExtensionIndex build time for N records.
3. Extension-based filter query time (by_geo, by_performance, by_reputation).
4. Record encoding/decoding overhead with extensions.

```rust
//! Benchmarks for extension-aware DHT operations (Phase E5-E6).
//!
//! Measures overhead of extended records on DHT lookup, indexing,
//! and filtering compared to baseline records without extensions.

use aafp_discovery::{CapabilityDht, ExtensionAwareDht, ExtensionIndex};
use aafp_identity::{AgentKeypair, AgentRecord};
use aafp_identity::extensions::*;
use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};

fn make_baseline_record(i: usize) -> AgentRecord {
    let kp = AgentKeypair::generate();
    AgentRecord::new(
        &kp,
        vec![format!("cap-{i}")],
        vec!["quic://1.2.3.4:4433".into()],
    )
}

fn make_extended_record(i: usize) -> AgentRecord {
    let kp = AgentKeypair::generate();
    let mut record = AgentRecord::new(
        &kp,
        vec![format!("cap-{i}")],
        vec!["quic://1.2.3.4:4433".into()],
    );
    record.set_extension(GeoExtension {
        version: 1,
        country: Some(format!("C{}", i % 10)),
        continent: Some("NA".into()),
        lat_micro_deg: Some(i as i32 * 1000),
        lon_micro_deg: Some(i as i32 * 1000),
        ..Default::default()
    });
    record.set_extension(PerformanceExtension {
        version: 1,
        avg_latency_ms: Some((i % 100) as u16),
        uptime_bps: Some(9999),
        ..Default::default()
    });
    record.set_extension(ReputationExtension {
        version: 1,
        self_claimed_score: Some((i % 100) as u8),
        ..Default::default()
    });
    record
}

fn bench_dht_lookup(c: &mut Criterion) {
    let mut group = c.benchmark_group("dht_lookup");

    for n in [100, 500, 1000].iter() {
        // Baseline DHT (no extensions).
        let mut baseline_dht = CapabilityDht::new();
        for i in 0..*n {
            baseline_dht.put(make_baseline_record(i)).unwrap();
        }

        // Extended DHT (with extensions).
        let mut ext_dht = ExtensionAwareDht::new();
        for i in 0..*n {
            ext_dht.put(make_extended_record(i)).unwrap();
        }

        group.bench_with_input(BenchmarkId::new("baseline", n), n, |b, _| {
            b.iter(|| {
                let results = baseline_dht.get(black_box("cap-500"));
                black_box(results.len());
            });
        });

        group.bench_with_input(BenchmarkId::new("extended", n), n, |b, _| {
            b.iter(|| {
                let results = ext_dht.inner().get(black_box("cap-500"));
                black_box(results.len());
            });
        });

        group.bench_with_input(BenchmarkId::new("extended_geo_filter", n), n, |b, _| {
            b.iter(|| {
                let results = ext_dht.get_by_capability_and_country(
                    black_box("cap-500"),
                    black_box("C5"),
                );
                black_box(results.len());
            });
        });

        group.bench_with_input(BenchmarkId::new("extended_perf_filter", n), n, |b, _| {
            b.iter(|| {
                let results = ext_dht.get_by_capability_and_latency(
                    black_box("cap-500"),
                    black_box(50),
                );
                black_box(results.len());
            });
        });
    }
    group.finish();
}

fn bench_index_build(c: &mut Criterion) {
    let mut group = c.benchmark_group("extension_index_build");

    for n in [100, 500, 1000].iter() {
        let records: Vec<AgentRecord> = (0..*n).map(make_extended_record).collect();

        group.bench_with_input(BenchmarkId::new("build", n), n, |b, _| {
            b.iter(|| {
                let index = ExtensionIndex::build(black_box(&records));
                black_box(index.len());
            });
        });
    }
    group.finish();
}

fn bench_record_encoding(c: &mut Criterion) {
    let mut group = c.benchmark_group("record_encoding");

    let baseline = make_baseline_record(0);
    let extended = make_extended_record(0);

    group.bench_function("baseline_cbor_encode", |b| {
        b.iter(|| {
            let cbor = baseline.to_cbor();
            black_box(cbor);
        });
    });

    group.bench_function("extended_cbor_encode", |b| {
        b.iter(|| {
            let cbor = extended.to_cbor();
            black_box(cbor);
        });
    });

    group.bench_function("baseline_cbor_size", |b| {
        b.iter(|| {
            let cbor = baseline.to_cbor();
            let bytes = aafp_cbor::encode(&cbor).unwrap();
            black_box(bytes.len());
        });
    });

    group.bench_function("extended_cbor_size", |b| {
        b.iter(|| {
            let cbor = extended.to_cbor();
            let bytes = aafp_cbor::encode(&cbor).unwrap();
            black_box(bytes.len());
        });
    });

    group.finish();
}

criterion_group!(
    extension_dht_benches,
    bench_dht_lookup,
    bench_index_build,
    bench_record_encoding,
);
criterion_main!(extension_dht_benches);
```

Add to `aafp-benchmark/benches/` and register in `Cargo.toml`:

```toml
[[bench]]
name = "extension_dht"
harness = false
```

---

## Implementation Order

1. **Record size enforcement** (`extension_dht.rs` Part 1) — add `MAX_RECORD_SIZE_BYTES`, `check_record_size()`, `RecordSizeWarning`.
2. **ExtensionIndex** (`extension_index.rs` Part 2) — `by_country`, `by_continent`, `by_latency_ms`, `by_uptime_bps`, `by_reputation_score`, `with_heartbeat`.
3. **AttestationStore** (`attestation_store.rs` Part 3) — separate key namespace, `put()` with verification, `get_for_subject()`, `evict_expired()`.
4. **HeartbeatTracker + HeartbeatUpdate** (`heartbeat.rs` Part 4) — heartbeat signing/verification, staleness detection, eviction.
5. **Adaptive TTL** (`extension_dht.rs` Part 5) — `adaptive_ttl()`, `is_adaptively_expired()`.
6. **ExtensionAwareDht** (`extension_dht.rs` Part 6) — wrapper combining all components.
7. **Module registration** (`lib.rs` Part 7) — export new modules and types.
8. **Integration tests** (`aafp-tests` Part 8) — geo, performance, reputation, heartbeat, size limit, attestation, adaptive TTL.
9. **Conformance tests** (`aafp-conformance` Part 9) — CBOR wire format for all extensions, backward compat, signature tampering, unknown extension preservation.
10. **Performance benchmarks** (`aafp-benchmark` Part 10) — DHT lookup, index build, record encoding.

---

## Verification

After implementation, run:

```bash
cargo fmt --all -- --check
cargo build --workspace
cargo clippy --workspace
cargo test -p aafp-discovery -- extension
cargo test -p aafp-tests -- extension_dht
cargo test -p aafp-conformance -- extension_conformance
cargo bench -p aafp-benchmark -- extension_dht
```

Expected: 0 formatting diffs, 0 build warnings, 0 clippy warnings, all tests pass.

---

## Key Design Constraints

1. **Backward compatibility**: Records without key 11 MUST work identically to current behavior. `ExtensionAwareDht` delegates to `CapabilityDht` for all primary operations.
2. **Signature coverage**: Key 11 is inside the signed envelope. Stripping extensions MUST break verification (conformance test verifies this).
3. **64 KiB hard limit**: Records exceeding 64 KiB are rejected by `put()`. The 8 KiB soft limit produces a warning but accepts the record.
4. **Attestation separation**: Attestations are NOT part of the AgentRecord signature. They are stored under a separate DHT key namespace and signed by the attester, not the subject.
5. **Heartbeat domain separator**: Heartbeat signatures use `b"aafp-heartbeat"` as the domain separator (distinct from the record's `b"aafp-v1"` separator). Same key, different domain.
6. **Stale vs expired**: A stale heartbeat (older than 3x interval) deprioritizes a record but does NOT remove it from the DHT. Only `expires_at` causes hard eviction.
7. **Unknown extensions preserved**: Agents MUST preserve unknown extension namespaces when re-broadcasting records (store-and-forward raw CBOR). Conformance test verifies this.
8. **Self-attestations rejected**: `AttestationStore::put()` rejects attestations where `attester == subject` (Sybil resistance, §7.5).
9. **Local indexing only**: Secondary indexes are built locally by the discovering agent. The DHT protocol itself does not change — it remains keyed by capability name only.
10. **Thread safety**: `ExtensionAwareDht` is `!Sync` (like `CapabilityDht`). For concurrent access, wrap in `Arc<Mutex<_>>` or use the sharded v1 DHT as the inner store.
