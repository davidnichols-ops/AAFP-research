# Builder Prompt: ARE-E1-E2 — Extension Map + Geo/Performance Extensions

## Objective

Implement Phases E1 and E2 of the AgentRecord Extensions design
(`AGENT_RECORD_EXTENSIONS.md` §4, §5, §9): a versioned extension map at
CBOR key 11 inside `AgentRecord`, plus two concrete extensions —
`GeoExtension` and `PerformanceExtension`. The extension map lives
inside the signed envelope so any tampering with extensions invalidates
the record signature. Old agents that do not understand key 11 continue
to verify and use the base record unchanged.

## Context

Read these before starting:
- `AGENT_RECORD_EXTENSIONS.md` — sections 4 (extension architecture),
  5 (proposed extension fields), 9 (concrete Rust implementation)
- `implementations/rust/crates/aafp-identity/src/identity_v1.rs` —
  existing `AgentRecord` (lines 103-415), `CapabilityDescriptor`
  (lines 417-503), `IdentityError` (lines 551-608), helper functions
  `expect_u64` / `expect_bstr` (lines 612-632)
- `implementations/rust/crates/aafp-cbor/src/lib.rs` — `Value` enum
  (lines 45-64), `int_map`, `str_map`, `int_map_get` helpers

## Files to Create / Modify

| File | Action |
|------|--------|
| `crates/aafp-identity/src/extensions/mod.rs` | **Create** — trait + GeoExtension + PerformanceExtension |
| `crates/aafp-identity/src/lib.rs` | **Modify** — add `pub mod extensions;` and re-exports |
| `crates/aafp-identity/src/identity_v1.rs` | **Modify** — add `extensions` field, update CBOR encode/decode, add `get_extension`/`set_extension` |

## Part 1: AgentRecordExtension Trait (E1)

Create `crates/aafp-identity/src/extensions/mod.rs`. Define a trait that
every extension implements. The trait provides the namespace string,
the extension version, and encode/decode methods. It also provides
default methods that wrap the inner data in the `{1: version, 2: data}`
envelope defined in §4.2 of the design document.

```rust
//! AgentRecord extensions: versioned extension map at CBOR key 11.
//!
//! See AGENT_RECORD_EXTENSIONS.md §4 (architecture), §5 (fields),
//! §9 (concrete implementation).

use aafp_cbor::{int_map, int_map_get, Value};
use crate::identity_v1::IdentityError;

/// A versioned extension that can be encoded into the AgentRecord
/// extension map (CBOR key 11).
///
/// Each extension has:
/// - A unique namespace string (e.g., `"aafp.geo.v1"`) used as the
///   outer map key.
/// - A semantic version number (independent per namespace).
/// - A CBOR encoding of its inner data.
///
/// The wire format for a single extension is:
/// ```cbor
/// Extension = {
///     1: uint,   // extension_version
///     2: any,    // extension_data (namespace-specific)
/// }
/// ```
pub trait AgentRecordExtension: Sized + Clone {
    /// Namespace string (e.g., `"aafp.geo.v1"`).
    const NAMESPACE: &'static str;

    /// Current extension version.
    const VERSION: u64;

    /// Encode the inner data to CBOR (NOT including the version wrapper).
    fn to_cbor(&self) -> Value;

    /// Decode the inner data from CBOR.
    fn from_cbor(val: &Value) -> Result<Self, IdentityError>;

    /// Encode as a full Extension wrapper `{1: version, 2: data}`.
    fn to_extension_cbor(&self) -> Value {
        int_map(vec![
            (1, Value::Unsigned(Self::VERSION)),
            (2, self.to_cbor()),
        ])
    }

    /// Decode from a full Extension wrapper, checking the version field.
    fn from_extension_cbor(val: &Value) -> Result<Self, IdentityError> {
        let version = match int_map_get(val, 1) {
            Some(Value::Unsigned(n)) => *n,
            Some(other) => {
                return Err(IdentityError::InvalidField {
                    field: "extension_version",
                    message: format!("expected uint, got {:?}", other),
                });
            }
            None => return Err(IdentityError::MissingField("extension_version")),
        };
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
```

**Key design decisions:**
- The trait is generic over `Sized + Clone` so extensions can be stored
  as typed values and retrieved via `get_extension::<T>()`.
- `to_extension_cbor` / `from_extension_cbor` are default methods so
  every extension gets the version-wrapper logic for free. Extensions
  only implement `to_cbor` (inner data) and `from_cbor` (inner data).
- Version mismatch returns an error, NOT a silent skip. Callers that
  want forward-compatible behavior (ignore unknown versions) should
  catch the error and treat the extension as absent (see §6.5).

## Part 2: GeoExtension (E2)

Geographic location for geo-aware routing. Namespace: `"aafp.geo.v1"`.
All fields are optional for privacy — an agent may publish only
country/continent and omit coordinates.

```rust
/// Geographic location extension (key 11, namespace `"aafp.geo.v1"`).
///
/// CBOR encoding (inner data):
/// ```cbor
/// GeoData = {
///     ? 1: tstr,        // country (ISO 3166-1 alpha-2)
///     ? 2: tstr,        // region (ISO 3166-2)
///     ? 3: int,         // lat_micro_deg (latitude * 1,000,000)
///     ? 4: int,         // lon_micro_deg (longitude * 1,000,000)
///     ? 5: tstr,        // continent
///     ? 6: [ *tstr ],   // data_residency
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
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
    /// e.g., `["EU", "US-CA"]` means data cannot leave EU or US-CA.
    pub data_residency: Vec<String>,
}

impl AgentRecordExtension for GeoExtension {
    const NAMESPACE: &'static str = "aafp.geo.v1";
    const VERSION: u64 = 1;

    fn to_cbor(&self) -> Value {
        let mut entries: Vec<(i64, Value)> = Vec::new();
        if let Some(c) = &self.country {
            entries.push((1, Value::TextString(c.clone())));
        }
        if let Some(r) = &self.region {
            entries.push((2, Value::TextString(r.clone())));
        }
        if let Some(lat) = self.lat_micro_deg {
            if lat >= 0 {
                entries.push((3, Value::Unsigned(lat as u64)));
            } else {
                entries.push((3, Value::Negative(lat as i64)));
            }
        }
        if let Some(lon) = self.lon_micro_deg {
            if lon >= 0 {
                entries.push((4, Value::Unsigned(lon as u64)));
            } else {
                entries.push((4, Value::Negative(lon as i64)));
            }
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
                Some(Value::Negative(n)) => Some(*n as i32),
                Some(Value::Unsigned(n)) => Some(*n as i32),
                _ => None,
            },
            lon_micro_deg: match int_map_get(val, 4) {
                Some(Value::Negative(n)) => Some(*n as i32),
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

**Notes:**
- Latitude/longitude use micro-degrees (`lat * 1_000_000`) as `i32` to
  avoid floating point on the wire. Negative values (southern/western
  hemisphere) encode as `Value::Negative`; positive as `Value::Unsigned`.
- All fields are optional — an agent can publish only `country` +
  `continent` and omit coordinates for privacy.
- `data_residency` is a list of jurisdiction codes. An empty list means
  no residency constraints.

## Part 3: PerformanceExtension (E2)

Self-reported performance characteristics. Namespace: `"aafp.perf.v1"`.
These are *claims*, not verified metrics — verified metrics come from
third-party attestations (Phase E3, not in this task).

```rust
/// Self-reported performance profile (key 11, namespace `"aafp.perf.v1"`).
///
/// CBOR encoding (inner data):
/// ```cbor
/// PerfData = {
///     ? 1: uint,   // avg_latency_ms
///     ? 2: uint,   // p99_latency_ms
///     ? 3: uint,   // throughput_rps
///     ? 4: uint,   // max_batch_size
///     ? 5: uint,   // uptime_bps (basis points, 10000 = 100%)
///     ? 6: uint,   // window_secs
///     ? 7: uint,   // updated_at
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PerformanceExtension {
    /// Extension version (always 1 for v1).
    pub version: u64,
    /// Average latency in milliseconds (self-measured, EWMA).
    pub avg_latency_ms: Option<u16>,
    /// P99 latency in milliseconds.
    pub p99_latency_ms: Option<u16>,
    /// Throughput in requests per second.
    pub throughput_rps: Option<u32>,
    /// Maximum batch size supported in a single request.
    pub max_batch_size: Option<u32>,
    /// Uptime percentage in basis points (10000 = 100%).
    pub uptime_bps: Option<u16>,
    /// Measurement window in seconds (how long the stats cover).
    pub window_secs: u32,
    /// When the stats were last updated (unix seconds).
    pub updated_at: u64,
}

impl AgentRecordExtension for PerformanceExtension {
    const NAMESPACE: &'static str = "aafp.perf.v1";
    const VERSION: u64 = 1;

    fn to_cbor(&self) -> Value {
        let mut entries: Vec<(i64, Value)> = Vec::new();
        if let Some(lat) = self.avg_latency_ms {
            entries.push((1, Value::Unsigned(lat as u64)));
        }
        if let Some(p99) = self.p99_latency_ms {
            entries.push((2, Value::Unsigned(p99 as u64)));
        }
        if let Some(rps) = self.throughput_rps {
            entries.push((3, Value::Unsigned(rps as u64)));
        }
        if let Some(bs) = self.max_batch_size {
            entries.push((4, Value::Unsigned(bs as u64)));
        }
        if let Some(upt) = self.uptime_bps {
            entries.push((5, Value::Unsigned(upt as u64)));
        }
        if self.window_secs > 0 {
            entries.push((6, Value::Unsigned(self.window_secs as u64)));
        }
        if self.updated_at > 0 {
            entries.push((7, Value::Unsigned(self.updated_at)));
        }
        int_map(entries)
    }

    fn from_cbor(val: &Value) -> Result<Self, IdentityError> {
        Ok(Self {
            version: 1,
            avg_latency_ms: match int_map_get(val, 1) {
                Some(Value::Unsigned(n)) => Some(*n as u16),
                _ => None,
            },
            p99_latency_ms: match int_map_get(val, 2) {
                Some(Value::Unsigned(n)) => Some(*n as u16),
                _ => None,
            },
            throughput_rps: match int_map_get(val, 3) {
                Some(Value::Unsigned(n)) => Some(*n as u32),
                _ => None,
            },
            max_batch_size: match int_map_get(val, 4) {
                Some(Value::Unsigned(n)) => Some(*n as u32),
                _ => None,
            },
            uptime_bps: match int_map_get(val, 5) {
                Some(Value::Unsigned(n)) => Some(*n as u16),
                _ => None,
            },
            window_secs: match int_map_get(val, 6) {
                Some(Value::Unsigned(n)) => *n as u32,
                _ => 0,
            },
            updated_at: match int_map_get(val, 7) {
                Some(Value::Unsigned(n)) => *n,
                _ => 0,
            },
        })
    }
}
```

**Notes:**
- `u16` for latency (max 65.5s) and `u32` for throughput/batch keep the
  encoding compact. `uptime_bps` uses basis points (10000 = 100%) to
  avoid floating point on the wire.
- `window_secs` and `updated_at` default to 0 when absent, allowing
  minimal performance claims (just latency + throughput).
- `max_batch_size` indicates the largest batch the agent can process in
  a single request — useful for batch inference routing.

## Part 4: Update AgentRecord (E1)

Modify `crates/aafp-identity/src/identity_v1.rs`:

### 4.1 Add `extensions` field to the struct

Add a new public field to `AgentRecord` (after `record_version`):

```rust
/// Extension map (CBOR key 11). Optional — empty for backward compat.
/// Stored as `(namespace, raw CBOR Value)` pairs to preserve unknown
/// extensions that this agent doesn't have typed decoders for.
pub extensions: Vec<(String, Value)>,
```

Initialize this to `Vec::new()` in `AgentRecord::new()`.

### 4.2 Update `to_cbor_without_sig()`

The signature input MUST include key 11 when extensions are present.
This is critical: if extensions are not in the signed bytes, an attacker
could strip or replace them without breaking the signature.

```rust
pub fn to_cbor_without_sig(&self) -> Value {
    let mut entries = vec![
        (1, Value::TextString(self.record_type.clone())),
        (2, Value::ByteString(self.agent_id.0.to_vec())),
        (3, Value::ByteString(self.public_key.clone())),
        (
            4,
            Value::Array(self.capabilities.iter().map(|c| c.to_cbor()).collect()),
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
    // This keeps records without extensions byte-identical to the
    // current format — critical for backward compatibility.
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
```

### 4.3 Update `to_cbor()`

Same change — add key 11 after key 10, before the closing of `int_map`.
The full record (with signature at key 8) must also include extensions
at key 11 so the wire format is self-consistent.

### 4.4 Update `from_cbor()`

Parse key 11 if present. Unknown extension namespaces are preserved as
raw `Value` so they round-trip correctly (important for DHT nodes that
relay records they don't understand).

```rust
// Parse optional extension map (key 11).
let extensions = match get(11) {
    Some(Value::StrMap(entries)) => {
        entries.iter().map(|(ns, v)| (ns.clone(), v.clone())).collect()
    }
    Some(Value::IntMap(_)) => Vec::new(), // empty map edge case
    None => Vec::new(), // no extensions — fully backward compatible
    Some(other) => {
        return Err(IdentityError::InvalidField {
            field: "extensions",
            message: format!("expected map, got {:?}", other),
        });
    }
};
```

Add `extensions` to the `Ok(Self { ... })` return.

### 4.5 Add `get_extension()` and `set_extension()` methods

These are the primary API for working with typed extensions. They use
the `AgentRecordExtension` trait to encode/decode automatically.

```rust
/// Get a typed extension by namespace.
///
/// Returns `None` if the extension is not present or if the version
/// doesn't match (forward compatibility: unknown versions are treated
/// as absent, not as errors).
pub fn get_extension<T: crate::extensions::AgentRecordExtension>(&self) -> Option<T> {
    let entry = self.extensions.iter().find(|(ns, _)| ns == T::NAMESPACE)?;
    T::from_extension_cbor(&entry.1).ok()
}

/// Set a typed extension (replaces existing entry with the same namespace).
///
/// After calling this, the record MUST be re-signed before publishing,
/// because the extension data is part of the signed envelope.
pub fn set_extension<T: crate::extensions::AgentRecordExtension>(&mut self, ext: T) {
    let cbor = ext.to_extension_cbor();
    if let Some(pos) = self.extensions.iter().position(|(ns, _)| ns == T::NAMESPACE) {
        self.extensions[pos] = (T::NAMESPACE.to_string(), cbor);
    } else {
        self.extensions.push((T::NAMESPACE.to_string(), cbor));
    }
}
```

### 4.6 Update `lib.rs`

Add the extensions module and re-export the trait and concrete extensions:

```rust
pub mod extensions;

pub use extensions::{
    AgentRecordExtension, GeoExtension, PerformanceExtension,
};
```

## Part 5: Signature Coverage (Critical)

The extension map at key 11 is inside the signed envelope. This means:

1. **Adding an extension requires re-signing.** `set_extension()` changes
   the record content; `sign()` must be called afterward.
2. **Stripping extensions breaks the signature.** If an attacker removes
   key 11 from the CBOR, `to_cbor_without_sig()` on the receiver side
   will produce different bytes than what was signed, and `verify()`
   will fail.
3. **Modifying extension data breaks the signature.** Any change to the
   extension map content changes the signed bytes.
4. **Old agents still verify correctly.** The signature is over the
   canonical CBOR bytes (including key 11 if present). Old agents that
   don't parse key 11 still verify the signature because `verify()`
   re-encodes the full record (including extensions) via
   `to_cbor_without_sig()` and checks against the stored signature.

**Implementation note**: The current `from_cbor()` preserves unknown
extension namespaces as raw `Value` pairs. This ensures that when a DHT
node re-encodes the record (e.g., for replication), it produces
byte-identical CBOR, preserving signature validity. Do NOT decode and
re-encode unknown extensions — store and re-emit the raw `Value`.

## Part 6: Backward Compatibility

### 6.1 Old agent, new record (has key 11)

An old agent's `from_cbor()` (without the key 11 parsing change) simply
ignores key 11 — it's not in the parsing code. The signature still
verifies because the old `verify()` re-encodes via
`to_cbor_without_sig()` which... **wait** — the old code doesn't
include key 11 in `to_cbor_without_sig()`. This is the critical issue
described in §6.2 of the design document.

**Resolution**: Once this change is deployed, ALL agents must use the
updated `to_cbor_without_sig()` that includes key 11. The signature is
over the canonical CBOR bytes, so as long as both signer and verifier
use the same `to_cbor_without_sig()`, verification works. Old agents
that haven't been updated will fail to verify new records that contain
extensions — this is acceptable because:
- Old agents can still use records WITHOUT extensions (no key 11 →
  identical to current format).
- New agents can use both old and new records.
- The transition is gradual: agents add extensions when they need them.

### 6.2 New agent, old record (no key 11)

`from_cbor()` sets `extensions = Vec::new()`. `get_extension()` returns
`None` for all namespaces. The agent falls back to base capability
discovery. No errors, no warnings.

### 6.3 Forward compatibility (unknown extension version)

If `get_extension::<T>()` encounters a namespace it recognizes but with
a higher version than `T::VERSION`, `from_extension_cbor()` returns an
`InvalidField` error. `get_extension()` catches this and returns
`None`. The caller treats the extension as absent — graceful
degradation per §6.5.

## Part 7: Unit Tests

Add tests in `crates/aafp-identity/src/extensions/mod.rs` (in a
`#[cfg(test)] mod tests` block) and in `identity_v1.rs` (append to the
existing `tests` module).

### 7.1 Extension encode/decode round-trip tests

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use aafp_cbor::{decode, encode};

    #[test]
    fn test_geo_extension_roundtrip_full() {
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
        let (decoded, _) = decode(&bytes).unwrap();
        let geo2 = GeoExtension::from_extension_cbor(&decoded).unwrap();
        assert_eq!(geo, geo2);
    }

    #[test]
    fn test_geo_extension_roundtrip_minimal() {
        // Only country — all other fields absent.
        let geo = GeoExtension {
            version: 1,
            country: Some("DE".into()),
            ..Default::default()
        };
        let cbor = geo.to_extension_cbor();
        let bytes = encode(&cbor).unwrap();
        let (decoded, _) = decode(&bytes).unwrap();
        let geo2 = GeoExtension::from_extension_cbor(&decoded).unwrap();
        assert_eq!(geo, geo2);
        assert!(geo2.lat_micro_deg.is_none());
        assert!(geo2.data_residency.is_empty());
    }

    #[test]
    fn test_geo_extension_negative_coords() {
        // Sydney: -33.8688, 151.2093
        let geo = GeoExtension {
            version: 1,
            lat_micro_deg: Some(-33_868_800),
            lon_micro_deg: Some(151_209_300),
            ..Default::default()
        };
        let cbor = geo.to_extension_cbor();
        let bytes = encode(&cbor).unwrap();
        let (decoded, _) = decode(&bytes).unwrap();
        let geo2 = GeoExtension::from_extension_cbor(&decoded).unwrap();
        assert_eq!(geo2.lat_micro_deg, Some(-33_868_800));
        assert_eq!(geo2.lon_micro_deg, Some(151_209_300));
    }

    #[test]
    fn test_perf_extension_roundtrip_full() {
        let perf = PerformanceExtension {
            version: 1,
            avg_latency_ms: Some(14),
            p99_latency_ms: Some(45),
            throughput_rps: Some(1000),
            max_batch_size: Some(32),
            uptime_bps: Some(9999),
            window_secs: 3600,
            updated_at: 1700000000,
        };
        let cbor = perf.to_extension_cbor();
        let bytes = encode(&cbor).unwrap();
        let (decoded, _) = decode(&bytes).unwrap();
        let perf2 = PerformanceExtension::from_extension_cbor(&decoded).unwrap();
        assert_eq!(perf, perf2);
    }

    #[test]
    fn test_perf_extension_roundtrip_minimal() {
        // Only latency + throughput.
        let perf = PerformanceExtension {
            version: 1,
            avg_latency_ms: Some(50),
            throughput_rps: Some(500),
            ..Default::default()
        };
        let cbor = perf.to_extension_cbor();
        let bytes = encode(&cbor).unwrap();
        let (decoded, _) = decode(&bytes).unwrap();
        let perf2 = PerformanceExtension::from_extension_cbor(&decoded).unwrap();
        assert_eq!(perf, perf2);
        assert!(perf2.p99_latency_ms.is_none());
        assert_eq!(perf2.window_secs, 0);
    }

    #[test]
    fn test_extension_version_mismatch() {
        // Manually construct an extension with wrong version.
        let cbor = int_map(vec![
            (1, Value::Unsigned(99)), // wrong version
            (2, int_map(vec![])),
        ]);
        let result = GeoExtension::from_extension_cbor(&cbor);
        assert!(result.is_err());
    }
}
```

### 7.2 AgentRecord integration + signature coverage tests

Add these to the existing `tests` module in `identity_v1.rs`:

```rust
#[test]
fn test_record_with_extensions_sign_verify() {
    let (pk, sk) = MlDsa65::keypair();
    let now = 1700000000u64;

    let mut record = AgentRecord::new(
        &pk.0,
        vec![CapabilityDescriptor::new("inference")],
        vec!["/ip4/127.0.0.1/tcp/4001".to_string()],
        now,
        now + 86400,
        KEY_ALG_ML_DSA_65,
    );

    // Set extensions BEFORE signing.
    record.set_extension(crate::extensions::GeoExtension {
        version: 1,
        country: Some("US".into()),
        region: Some("US-CA".into()),
        lat_micro_deg: Some(37_774_900),
        lon_micro_deg: Some(-122_419_400),
        continent: Some("NA".into()),
        data_residency: vec!["US".into()],
    });
    record.set_extension(crate::extensions::PerformanceExtension {
        version: 1,
        avg_latency_ms: Some(14),
        p99_latency_ms: Some(45),
        throughput_rps: Some(1000),
        max_batch_size: Some(32),
        uptime_bps: Some(9999),
        window_secs: 3600,
        updated_at: now,
    });

    // Sign (extensions are included in the signature).
    record.sign(&sk);

    // Verify — must succeed.
    assert!(record.verify(now).is_ok());

    // Retrieve extensions.
    let geo: Option<crate::extensions::GeoExtension> = record.get_extension();
    assert!(geo.is_some());
    assert_eq!(geo.unwrap().country, Some("US".into()));

    let perf: Option<crate::extensions::PerformanceExtension> = record.get_extension();
    assert!(perf.is_some());
    assert_eq!(perf.unwrap().avg_latency_ms, Some(14));
}

#[test]
fn test_record_with_extensions_cbor_roundtrip() {
    let (pk, sk) = MlDsa65::keypair();
    let now = 1700000000u64;

    let mut record = AgentRecord::new(
        &pk.0,
        vec![CapabilityDescriptor::new("inference")],
        vec!["/ip4/127.0.0.1/tcp/4001".to_string()],
        now,
        now + 86400,
        KEY_ALG_ML_DSA_65,
    );

    record.set_extension(crate::extensions::GeoExtension {
        version: 1,
        country: Some("JP".into()),
        continent: Some("AS".into()),
        ..Default::default()
    });

    record.sign(&sk);

    // Encode → decode → verify.
    let cbor = record.to_cbor();
    let encoded = aafp_cbor::encode(&cbor).unwrap();
    let (decoded, _) = aafp_cbor::decode(&encoded).unwrap();
    let record2 = AgentRecord::from_cbor(&decoded).unwrap();

    assert!(record2.verify(now).is_ok());
    assert_eq!(record2.extensions.len(), 1);

    let geo: Option<crate::extensions::GeoExtension> = record2.get_extension();
    assert_eq!(geo.unwrap().country, Some("JP".into()));
}

#[test]
fn test_record_without_extensions_backward_compat() {
    let (pk, sk) = MlDsa65::keypair();
    let now = 1700000000u64;

    let mut record = AgentRecord::new(
        &pk.0,
        vec![CapabilityDescriptor::new("inference")],
        vec!["/ip4/127.0.0.1/tcp/4001".to_string()],
        now,
        now + 86400,
        KEY_ALG_ML_DSA_65,
    );
    record.sign(&sk);

    // No extensions — record should be byte-identical to pre-extension format.
    assert!(record.extensions.is_empty());

    let cbor = record.to_cbor();
    let encoded = aafp_cbor::encode(&cbor).unwrap();

    // Decode and verify.
    let (decoded, _) = aafp_cbor::decode(&encoded).unwrap();
    let record2 = AgentRecord::from_cbor(&decoded).unwrap();
    assert!(record2.verify(now).is_ok());
    assert!(record2.extensions.is_empty());

    // get_extension returns None.
    let geo: Option<crate::extensions::GeoExtension> = record2.get_extension();
    assert!(geo.is_none());
}

#[test]
fn test_tamper_extension_breaks_signature() {
    let (pk, sk) = MlDsa65::keypair();
    let now = 1700000000u64;

    let mut record = AgentRecord::new(
        &pk.0,
        vec![CapabilityDescriptor::new("inference")],
        vec!["/ip4/127.0.0.1/tcp/4001".to_string()],
        now,
        now + 86400,
        KEY_ALG_ML_DSA_65,
    );

    record.set_extension(crate::extensions::GeoExtension {
        version: 1,
        country: Some("US".into()),
        ..Default::default()
    });
    record.sign(&sk);
    assert!(record.verify(now).is_ok());

    // Tamper: change the extension data without re-signing.
    record.set_extension(crate::extensions::GeoExtension {
        version: 1,
        country: Some("DE".into()), // changed!
        ..Default::default()
    });

    // Signature must now fail.
    let err = record.verify(now).unwrap_err();
    assert!(matches!(err, IdentityError::SignatureVerificationFailed));
}

#[test]
fn test_strip_extension_breaks_signature() {
    let (pk, sk) = MlDsa65::keypair();
    let now = 1700000000u64;

    let mut record = AgentRecord::new(
        &pk.0,
        vec![CapabilityDescriptor::new("inference")],
        vec!["/ip4/127.0.0.1/tcp/4001".to_string()],
        now,
        now + 86400,
        KEY_ALG_ML_DSA_65,
    );

    record.set_extension(crate::extensions::GeoExtension {
        version: 1,
        country: Some("US".into()),
        ..Default::default()
    });
    record.sign(&sk);
    assert!(record.verify(now).is_ok());

    // Strip extensions after signing.
    record.extensions.clear();

    // Signature must fail — the signed bytes included key 11.
    let err = record.verify(now).unwrap_err();
    assert!(matches!(err, IdentityError::SignatureVerificationFailed));
}

#[test]
fn test_set_extension_replaces_existing() {
    let (pk, _) = MlDsa65::keypair();
    let now = 1700000000u64;

    let mut record = AgentRecord::new(
        &pk.0,
        vec![],
        vec![],
        now,
        now + 86400,
        KEY_ALG_ML_DSA_65,
    );

    record.set_extension(crate::extensions::GeoExtension {
        version: 1,
        country: Some("US".into()),
        ..Default::default()
    });
    assert_eq!(record.extensions.len(), 1);

    // Set again — should replace, not add a second entry.
    record.set_extension(crate::extensions::GeoExtension {
        version: 1,
        country: Some("DE".into()),
        ..Default::default()
    });
    assert_eq!(record.extensions.len(), 1);

    let geo: Option<crate::extensions::GeoExtension> = record.get_extension();
    assert_eq!(geo.unwrap().country, Some("DE".into()));
}

#[test]
fn test_unknown_extension_preserved() {
    let (pk, sk) = MlDsa65::keypair();
    let now = 1700000000u64;

    let mut record = AgentRecord::new(
        &pk.0,
        vec![CapabilityDescriptor::new("inference")],
        vec!["/ip4/127.0.0.1/tcp/4001".to_string()],
        now,
        now + 86400,
        KEY_ALG_ML_DSA_65,
    );

    // Manually insert an unknown extension namespace.
    record.extensions.push((
        "aafp.unknown.v1".to_string(),
        aafp_cbor::int_map(vec![
            (1, aafp_cbor::Value::Unsigned(1)),
            (2, aafp_cbor::Value::TextString("mystery".into())),
        ]),
    ));
    record.sign(&sk);

    // Encode → decode round-trip.
    let cbor = record.to_cbor();
    let encoded = aafp_cbor::encode(&cbor).unwrap();
    let (decoded, _) = aafp_cbor::decode(&encoded).unwrap();
    let record2 = AgentRecord::from_cbor(&decoded).unwrap();

    // Unknown extension must be preserved (raw Value round-trips).
    assert!(record2.verify(now).is_ok());
    assert_eq!(record2.extensions.len(), 1);
    assert_eq!(record2.extensions[0].0, "aafp.unknown.v1");

    // Typed lookup for known extension returns None (not present).
    let geo: Option<crate::extensions::GeoExtension> = record2.get_extension();
    assert!(geo.is_none());
}
```

## Part 8: Verification Checklist

After implementation, run:

```bash
cargo fmt --all -- --check
cargo build --workspace
cargo clippy --workspace
cargo test -p aafp-identity
```

Verify:
- [ ] `AgentRecordExtension` trait defined with `NAMESPACE`, `VERSION`,
      `to_cbor`, `from_cbor`, `to_extension_cbor`, `from_extension_cbor`
- [ ] `GeoExtension` implements `AgentRecordExtension` with namespace
      `"aafp.geo.v1"`
- [ ] `PerformanceExtension` implements `AgentRecordExtension` with
      namespace `"aafp.perf.v1"`
- [ ] `AgentRecord` has `extensions: Vec<(String, Value)>` field
- [ ] `to_cbor_without_sig()` includes key 11 when extensions non-empty
- [ ] `to_cbor()` includes key 11 when extensions non-empty
- [ ] `from_cbor()` parses key 11 (optional, preserves raw `Value`)
- [ ] `get_extension::<T>()` returns `Option<T>`
- [ ] `set_extension::<T>(ext)` replaces same-namespace entries
- [ ] Records without extensions are byte-identical to current format
- [ ] Tampering with extension data breaks signature verification
- [ ] Stripping extensions after signing breaks signature verification
- [ ] Unknown extension namespaces round-trip through encode/decode
- [ ] Old records (no key 11) parse with empty `extensions` vec
- [ ] All existing tests still pass (no regressions)
- [ ] 0 clippy warnings, 0 formatting diffs

## Summary of Changes

| File | Lines Changed | Description |
|------|--------------|-------------|
| `extensions/mod.rs` | ~250 new | Trait + GeoExtension + PerformanceExtension + tests |
| `identity_v1.rs` | ~60 modified | `extensions` field, CBOR encode/decode, get/set methods, tests |
| `lib.rs` | ~5 modified | `pub mod extensions` + re-exports |
