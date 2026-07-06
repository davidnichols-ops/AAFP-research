# AAFP Versioning & Compatibility Strategy

**Status:** Research Document
**Date:** 2025-07-06
**Scope:** Protocol versioning, SDK versioning, capability versioning, AgentRecord
versioning, CBOR schema versioning, backward/forward compatibility, deprecation
process, migration tooling, cross-language version matrix, breaking change policy,
and concrete version evolution examples.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Protocol Versioning](#2-protocol-versioning)
3. [SDK Versioning](#3-sdk-versioning)
4. [Capability Versioning](#4-capability-versioning)
5. [AgentRecord Versioning](#5-agentrecord-versioning)
6. [CBOR Schema Versioning](#6-cbor-schema-versioning)
7. [Backward Compatibility Guarantees](#7-backward-compatibility-guarantees)
8. [Forward Compatibility](#8-forward-compatibility)
9. [Deprecation Process](#9-deprecation-process)
10. [Migration Tooling](#10-migration-tooling)
11. [Cross-Language Version Matrix](#11-cross-language-version-matrix)
12. [Breaking Change Policy](#12-breaking-change-policy)
13. [Concrete Version Evolution Example](#13-concrete-version-evolution-example)
14. [Reference: Key Source Files](#14-reference-key-source-files)

---

## 1. Overview

AAFP has a multi-layered versioning strategy. Each layer evolves independently
but follows shared compatibility principles. The layers are:

| Layer | Version Type | Mechanism | Bump Trigger |
|-------|-------------|----------|--------------|
| Wire protocol | Integer (u8) | Frame header byte 0 | Incompatible frame format change |
| Handshake | Integer (u64) | `protocol_version` in ClientHello/ServerHello | Incompatible handshake message change |
| SDK (Rust/Python/TS) | Semantic (MAJOR.MINOR.PATCH) | Cargo.toml / package.json / pyproject.toml | API change per semver |
| AgentRecord | String + monotonic int | `record_type` ("aafp-record-v1") + `record_version` | CBOR schema change |
| Extensions | Namespaced semver | `"aafp.<name>.v<N>"` in key 11 map | Extension schema change |
| Capability versioning | Per-capability semver | `"aafp.capver.v1"` extension | Capability implementation change |
| CBOR schema | Implicit (integer keys) | New keys added, old keys preserved | New field in any CBOR structure |
| Error codes | Immutable registry | RFC-0005 §3, never reused | N/A (codes are permanent) |

The core principle: **old agents must continue to work, new agents must
tolerate old data, and the wire protocol never silently downgrades.**

---

## 2. Protocol Versioning

### 2.1 v1 Wire Protocol

The v1 wire protocol is defined in RFC-0002 §3-4. Every frame begins with a
28-byte header whose first byte is the protocol version:

```
[Version:1B][FrameType:1B][Flags:1B][Reserved:1B][StreamID:8B][PayloadLen:8B][ExtLen:8B]
```

**Source:** `aafp-messaging/src/framing.rs:23`
```rust
pub const AAFP_VERSION: u8 = 1;
```

The encoder always writes `AAFP_VERSION` (1) at byte offset 0. The decoder
rejects any frame whose version byte does not match:

**Source:** `aafp-messaging/src/framing.rs:294-296`
```rust
if version != AAFP_VERSION {
    return Err(FrameError::InvalidVersion(version, AAFP_VERSION));
}
```

This is a hard equality check — there is no version range, no "minimum
version" negotiation, and no in-band fallback. The version byte is either 1
(accepted) or not-1 (rejected with `FrameError::InvalidVersion`).

### 2.2 Handshake-Level Version Negotiation

The handshake messages (`ClientHello`, `ServerHello`) carry a
`protocol_version` field (CBOR key 1, type u64):

**Source:** `aafp-crypto/src/handshake_v1.rs:54`
```rust
pub const PROTOCOL_VERSION: u64 = 1;
```

**Source:** `aafp-crypto/src/handshake_v1.rs:113-114`
```rust
pub struct ClientHello {
    pub protocol_version: u64,
```

The `protocol_version` in `ClientHello` and `ServerHello` must equal
`PROTOCOL_VERSION` (1). A mismatch triggers error code 8006
(`INVALID_VERSION`), which is always fatal:

**Source:** `aafp-core/src/error.rs:183`
```rust
pub const INVALID_VERSION: u32 = 8006;
```

**Source:** `aafp-core/src/error.rs:200-215`
```rust
pub fn is_always_fatal(code: u32) -> bool {
    let cat = ErrorCategory::from_code(code);
    match cat {
        ErrorCategory::Authentication => true,
        ErrorCategory::Protocol => {
            matches!(
                code,
                codes::UNKNOWN_CRITICAL_FRAME_TYPE
                    | codes::UNKNOWN_CRITICAL_EXTENSION
                    | codes::INVALID_VERSION
                    | codes::PROTOCOL_VIOLATION
            )
        }
        _ => false,
    }
}
```

### 2.3 Version Negotiation Behavior Matrix

The conformance test suite in
`aafp-conformance/src/version_negotiation.rs` implements the behavior matrix
defined in `VERSION_NEGOTIATION_MATRIX.md`. Key scenarios:

| Test ID | Scenario | Expected Behavior |
|---------|----------|-------------------|
| VN-0001 | Both sides v1 | Frame decodes successfully |
| VN-0002 | Client sends v2, server is v1 | Rejected (FrameError::InvalidVersion) |
| VN-0003 | Client sends v1, server is v1 | Accepted |
| VN-0004 | Client sends v3 | Rejected |
| VN-0005 | Client sends v255 | Rejected |
| VN-0006 | Versions 0,2-5,10,50,100,200,255 | All rejected (no in-band downgrade) |
| VN-0007 | Version 0 (pre-RFC) | Rejected (not compatible with v1) |

**Source:** `aafp-conformance/src/version_negotiation.rs:119-129`
```rust
#[test]
fn test_vn0006_downgrade_no_in_band_fallback() {
    for v in [0u8, 2, 3, 4, 5, 10, 50, 100, 200, 255] {
        let data = make_frame_with_version(v, 0x01, 0, 0, vec![0x01]);
        assert!(
            decode_frame(&data).is_err(),
            "version {} should be rejected (no in-band downgrade)",
            v
        );
    }
}
```

### 2.4 How v2 Would Work

A future v2 protocol would require:

1. **New ALPN identifier**: `aafp/2` alongside `aafp/1`. ALPN is authoritative
   for version selection (RFC-0006 §9.1). TLS integrity protection prevents
   downgrade attacks.

2. **Frame version byte = 2**: The v2 decoder would accept version=2 frames.
   A v2-capable implementation that also supports v1 would accept both 1 and
   2, selecting the appropriate decoder based on the version byte.

3. **Handshake `protocol_version = 2`**: `ClientHello` and `ServerHello`
   would carry `protocol_version: 2`. A v1-only server receiving a v2
   `ClientHello` would reject with error 8006.

4. **No in-band version negotiation**: There is no "I support versions 1
   and 2, pick one" message. The client offers `aafp/1` or `aafp/2` via
   ALPN; the server selects one. If no overlap, the TLS handshake fails
   before any AAFP frame is exchanged.

5. **Extension-based forward compatibility within v1**: New features that
   don't change the frame format are added as extensions (§8 below), not as
   protocol version bumps. This keeps v1 extensible without requiring v2.

### 2.5 No Silent Downgrade

The implementation explicitly does not support in-band version downgrade.
A v1 server never "falls back" to v0. A v2 client never "falls back" to v1
within the same connection. If ALPN selects `aafp/1`, both sides use v1 for
the entire connection lifetime.

**Source:** `aafp-conformance/src/version_negotiation.rs:87-91`
```rust
#[test]
fn test_vn0002_client_newer_version() {
    let data = make_frame_with_version(2, 0x01, 0, 0, vec![0x01]);
    assert!(decode_frame(&data).is_err(), "v2 frame should be rejected");
}
```

---

## 3. SDK Versioning

### 3.1 Current Versions

All three SDKs are at version `0.1.0`:

| SDK | Version Source | Version |
|-----|---------------|---------|
| Rust | `implementations/rust/Cargo.toml` (workspace) | `0.1.0` |
| TypeScript | `implementations/typescript/package.json` | `0.1.0` |
| Python | `implementations/rust/crates/aafp-py/pyproject.toml` | `0.1.0` |

The Rust workspace uses `version.workspace = true`, so all 15 crates share
the same version. The `aafp-py` crate (standalone, not in the workspace) also
uses `0.1.0`.

**Source:** `implementations/rust/Cargo.toml`
```toml
[workspace.package]
version = "0.1.0"
```

**Source:** `implementations/rust/crates/aafp-cli/src/main.rs:12`
```rust
#[command(version = "0.1.0")]
struct Cli { ... }
```

### 3.2 Semver Policy

SDK versions follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (0.x → 1.0): Breaking API changes, wire protocol changes,
  incompatible CBOR schema changes.
- **MINOR** (0.1 → 0.2): New features, new extensions, new frame types
  (non-critical). Backward compatible.
- **PATCH** (0.1.0 → 0.1.1): Bug fixes, performance improvements, docs.
  No new features.

During 0.x development, MINOR bumps may include breaking changes (per semver
convention: "Major version zero (0.y.z) is for initial development. Anything
MAY change at any time."). The 1.0 release marks the first stability
guarantee.

### 3.3 Lockstep vs Independent

**Current policy: lockstep.** All three SDKs are released at the same version
number. A change to the Rust SDK from 0.1.0 to 0.2.0 is accompanied by
TypeScript 0.2.0 and Python 0.2.0 releases.

Rationale:
- The Python SDK (`aafp-py`) is a PyO3 wrapper around the Rust crate. Its
  version is inherently tied to the Rust version.
- The TypeScript SDK implements the same wire protocol and CBOR encoding.
  Cross-language interop tests require matching versions.
- The conformance test suite validates behavior across implementations.

**Future policy (post-1.0):** SDKs may drift on PATCH versions (bug fixes
land independently), but MINOR and MAJOR versions remain synchronized. This
ensures that "AAFP 1.2" means the same feature set regardless of language.

### 3.4 Version Discovery at Runtime

The CLI exposes its version via `--version`:

```bash
$ aafp --version
aafp 0.1.0
```

The Rust SDK exposes the protocol version as a constant:

**Source:** `aafp-messaging/src/framing.rs:23`
```rust
pub const AAFP_VERSION: u8 = 1;
```

**Source:** `aafp-crypto/src/handshake_v1.rs:54`
```rust
pub const PROTOCOL_VERSION: u64 = 1;
```

The TypeScript SDK mirrors this:

**Source:** `implementations/typescript/packages/transport-quic/src/frame.ts:29`
```typescript
export const AAFP_VERSION = 1;
```

**Source:** `implementations/typescript/packages/sdk/src/client-handshake.ts:41`
```typescript
export const PROTOCOL_VERSION = 1;
```

---

## 4. Capability Versioning

### 4.1 SemanticVersion Type

Per-capability semantic versioning is implemented via the
`"aafp.capver.v1"` extension namespace. Each capability advertised by an
agent can carry a `SemanticVersion` (major.minor.patch):

**Source:** `aafp-identity/src/extensions/version.rs:13-18`
```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct SemanticVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}
```

### 4.2 Min/Max Version Negotiation

The `SemanticVersion` type provides range-checking methods for capability
compatibility queries:

**Source:** `aafp-identity/src/extensions/version.rs:20-34`
```rust
impl SemanticVersion {
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// Check if this version satisfies a minimum requirement.
    pub fn satisfies_min(&self, _min: &SemanticVersion) -> bool {
        todo!()
    }

    /// Check if this version is within a range [min, max].
    pub fn satisfies_range(&self, _min: &SemanticVersion, _max: &SemanticVersion) -> bool {
        todo!()
    }
}
```

The `PartialOrd` and `Ord` derives enable direct comparison:
`version >= SemanticVersion::new(4, 1, 0)` works out of the box. The
`satisfies_min` and `satisfies_range` methods (currently stubs) will provide
semantic-aware range checking that respects semver compatibility rules
(major version must match for `satisfies_range`).

### 4.3 CapabilityVersionExtension

The extension stores a map of capability name → SemanticVersion:

**Source:** `aafp-identity/src/extensions/version.rs:36-49`
```rust
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
    /// Map: capability_name → SemanticVersion.
    pub versions: HashMap<String, SemanticVersion>,
}
```

This enables DHT queries like "find agents with `inference` capability
version >= 4.1" without downloading the full AgentRecord.

### 4.4 Version Negotiation Flow

1. Agent A publishes its `AgentRecord` to the DHT with
   `CapabilityVersionExtension { versions: {"inference": (4, 1, 0)} }`.
2. Agent B queries the DHT for `inference` capability with min version 4.0.
3. The DHT returns Agent A's record (4.1.0 >= 4.0.0).
4. Agent B connects to Agent A. During handshake, both exchange
   `CapabilityDescriptor` lists. The capability version is in the
   extension map (key 11), not in the handshake capabilities array.
5. Agent B checks `satisfies_min` against its requirement. If satisfied,
   the connection proceeds. If not, Agent B sends `ERROR 6002`
   (`INCOMPATIBLE`) and closes.

### 4.5 Semantic Extension

The `"aafp.semantic.v1"` extension carries agent-level semantic attributes
(languages, modalities, hardware, frameworks, precision) and per-capability
semantic descriptors:

**Source:** `aafp-identity/src/extensions/semantic.rs:14-31`
```rust
pub struct SemanticExtension {
    pub capabilities: Vec<SemanticCapabilityData>,
}

impl AgentRecordExtension for SemanticExtension {
    const NAMESPACE: &'static str = "aafp.semantic.v1";
    const VERSION: u64 = 1;
}
```

The `CapabilityDescriptor` itself is extended with an optional key 3 for
semantic data:

```
CapabilityDescriptor-v2 = {
    1: tstr,                          // name
    2: { *tstr => MetadataValue },    // metadata (backward compat)
    ? 3: SemanticCapabilityData,      // semantic descriptor (optional)
}
```

Agents that don't understand key 3 ignore it and use the base `name` +
`metadata` — this is forward compatibility in action (§8).

---

## 5. AgentRecord Versioning

### 5.1 Record Type String

Every `AgentRecord` carries a `record_type` string field (CBOR key 1).
For v1 records, this is always `"aafp-record-v1"`:

**Source:** `aafp-identity/src/identity_v1.rs:21`
```rust
pub const RECORD_TYPE_V1: &str = "aafp-record-v1";
```

The `verify()` method rejects records with a different `record_type`:

**Source:** `aafp-identity/src/identity_v1.rs:357-361`
```rust
if self.record_type != RECORD_TYPE_V1 {
    return Err(IdentityError::InvalidRecordType {
        got: self.record_type.clone(),
    });
}
```

A future v2 record would use `"aafp-record-v2"` with a different CBOR schema.
Receivers can distinguish record versions by this string without parsing the
full structure.

### 5.2 Monotonic Record Version (A-3 Replay Protection)

The `record_version` field (CBOR key 10) is a monotonically increasing
integer that prevents replay of stale records:

**Source:** `aafp-identity/src/identity_v1.rs:140-143`
```rust
/// Monotonic version number for replay protection (A-3, Rev 6).
/// Receivers MUST reject older versions. Equal version: accept only
/// if bytes are identical; otherwise reject.
pub record_version: u64,
```

New records start at version 1:

**Source:** `aafp-identity/src/identity_v1.rs:168`
```rust
record_version: 1, // A-3: starts at 1, monotonically increasing
```

The decoder defaults to 0 for pre-Rev 6 records (backward compatibility):

**Source:** `aafp-identity/src/identity_v1.rs:310-321`
```rust
// A-3 (Rev 6): record_version is required for replay protection.
// Default to 0 for backward compatibility with pre-Rev 6 records.
let record_version = match get(10) {
    Some(Value::Unsigned(n)) => *n,
    None => 0, // Pre-Rev 6 record without version
    Some(other) => {
        return Err(IdentityError::InvalidField {
            field: "record_version",
            message: format!("expected uint, got {:?}", other),
        })
    }
};
```

### 5.3 Extension Map (Key 11)

The primary versioning mechanism for AgentRecord is the extension map at
CBOR key 11. This is an optional field containing a string-keyed map of
extension namespaces:

```
AgentRecord-v1 = {
    1: tstr,          // record_type: "aafp-record-v1"
    2: bstr,          // agent_id (32 bytes)
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
    1: uint,          // extension_version (per-namespace)
    2: any,           // extension_data (namespace-specific CBOR)
}
```

### 5.4 Versioned Namespaces

Each extension namespace follows the pattern `"aafp.<name>.v<N>"`:

| Namespace | Purpose | Source File |
|-----------|---------|------------|
| `aafp.geo.v1` | Geographic location | `extensions/geo.rs` |
| `aafp.perf.v1` | Self-reported performance | `extensions/performance.rs` |
| `aafp.cost.v1` | Cost model | `extensions/cost.rs` |
| `aafp.semantic.v1` | Semantic capabilities | `extensions/semantic.rs` |
| `aafp.reputation.v1` | Reputation references | `extensions/reputation.rs` |
| `aafp.capver.v1` | Per-capability versions | `extensions/version.rs` |
| `aafp.heartbeat.v1` | Liveness heartbeat | `extensions/heartbeat.rs` |

Each extension implements the `AgentRecordExtension` trait:

**Source:** `AGENT_RECORD_EXTENSIONS.md §9.1`
```rust
pub trait AgentRecordExtension: Sized + Clone {
    const NAMESPACE: &'static str;
    const VERSION: u64;
    fn to_cbor(&self) -> Value;
    fn from_cbor(val: &Value) -> Result<Self, IdentityError>;
}
```

For example, the geo extension:

**Source:** `aafp-identity/src/extensions/geo.rs:32-34`
```rust
impl AgentRecordExtension for GeoExtension {
    const NAMESPACE: &'static str = "aafp.geo.v1";
    const VERSION: u64 = 1;
```

When a namespace evolves from v1 to v2, the namespace string changes:
`"aafp.geo.v1"` → `"aafp.geo.v2"`. Old agents that only know v1 ignore the
v2 namespace. New agents that know both can read either.

### 5.5 Legacy Record Migration

The legacy `AgentRecord` (serde-based, string keys) can be converted to the
v1 format:

**Source:** `aafp-identity/src/agent_record.rs:162-184`
```rust
pub fn to_v1(&self) -> crate::identity_v1::AgentRecord {
    // Converts legacy string-keyed record to v1 integer-keyed record.
    // The signature is NOT recomputed — caller must call sign() to re-sign.
}

pub fn to_v1_signed(
    &self,
    keypair: &AgentKeypair,
) -> Result<crate::identity_v1::AgentRecord, IdentityError> {
    // Converts AND re-signs with the v1 domain separator format.
    // Sign input: "aafp-v1-record" || canonical_CBOR(fields 1-7,9)
}
```

The legacy module is marked `#[deprecated]`:

**Source:** `aafp-identity/src/lib.rs:7-11`
```rust
/// Legacy MVP AgentRecord module. Uses serde with string keys — NOT RFC-compliant.
/// Use [`identity_v1`] instead for wire serialization.
#[deprecated = "Use identity_v1 instead. Legacy agent_record uses serde/string keys, not RFC-compliant."]
#[allow(deprecated)]
pub mod agent_record;
```

---

## 6. CBOR Schema Versioning

### 6.1 Canonical CBOR

AAFP uses RFC 8949 §4.2.3 length-first core deterministic encoding. The
canonical CBOR encoder/decoder is in `aafp-cbor`:

**Source:** `aafp-cbor/src/lib.rs:1-16`
```rust
//! Canonical CBOR encoding for AAFP (RFC-0002 §8, RFC 8949 §4.2.3).
//!
//! Key Rules (RFC-0002 §8.1):
//! 1. Map keys sorted by length-first canonical byte ordering
//! 2. Integers use shortest encoding
//! 3. No indefinite-length arrays or maps
//! 4. Text strings use definite-length UTF-8
//! 5. All CBOR maps use integer keys (exception: metadata map uses string keys)
```

The TypeScript implementation mirrors this exactly:

**Source:** `implementations/typescript/packages/cbor/src/encoder.ts:30-39`
```typescript
/// Produces byte-identical output to the Rust `aafp_cbor::encode` function
/// when deterministic is true (the default).
///
/// Key rules (RFC 8949 §4.2.3, RFC-0002 §8.1):
/// 1. Map keys sorted by length-first canonical byte ordering
/// 2. Integers use shortest encoding
/// 3. No indefinite-length arrays or maps
/// 4. Text strings use definite-length UTF-8
/// 5. Negative integers: -1 encodes as 0x20, -n as 0x20 + (n-1).
```

### 6.2 Evolving Encoded Structures

CBOR schema evolution follows these rules:

1. **New fields = new integer keys**: Adding a field to a structure uses the
   next available integer key. For example, `AgentRecord` v1 uses keys 1-10;
   the extension map is key 11. A future field might use key 12.

2. **Old keys are never reused or repurposed**: Key 1 in `AgentRecord` is
   always `record_type`. It will never become something else in a future
   version. If a field is deprecated, its key is retired, not reassigned.

3. **Optional fields use `?` in the schema**: The CBOR map may or may not
   contain the key. Decoders handle absence gracefully (return default or
   `None`). Example: `record_version` (key 10) defaults to 0 when absent.

4. **Unknown keys are ignored on decode**: The `from_cbor()` decoders only
   read the keys they know. Unknown keys (e.g., key 12 in a future version)
   are preserved in the raw bytes but not parsed. This is critical for
   signature verification — the signature covers all bytes, including
   unknown keys.

5. **String-keyed maps for open extensibility**: The extension map (key 11)
   and `CapabilityDescriptor.metadata` (key 2) use string keys. This allows
   collision-resistant namespacing without consuming integer key space.

### 6.3 Signature Stability

The signature is computed over the canonical CBOR bytes of the record
(excluding the signature field). This means:

- Adding an extension (key 11) changes the signature input → the record
  must be re-signed.
- An attacker stripping key 11 breaks the signature.
- An old agent that doesn't parse key 11 still verifies the signature
  correctly because verification is over the raw bytes, not parsed fields.

**Source:** `aafp-identity/src/identity_v1.rs:338-346`
```rust
pub fn sign(&mut self, secret_key: &MlDsa65SecretKey) {
    let cbor = self.to_cbor_without_sig();
    let cbor_bytes = aafp_cbor::encode(&cbor).unwrap();
    let mut sig_input = Vec::with_capacity(RECORD_DOMAIN_SEPARATOR.len() + cbor_bytes.len());
    sig_input.extend_from_slice(RECORD_DOMAIN_SEPARATOR);
    sig_input.extend_from_slice(&cbor_bytes);
    let sig = MlDsa65::sign(secret_key, &sig_input);
    self.signature = sig.0;
}
```

The domain separator `"aafp-v1-record"` is versioned. A v2 record would use
`"aafp-v2-record"`, preventing cross-version signature confusion.

### 6.4 CBOR Value Types

The `Value` enum supports the types needed for AAFP structures:

**Source:** `aafp-cbor/src/lib.rs:44-64`
```rust
pub enum Value {
    Unsigned(u64),
    Negative(i64),
    ByteString(Vec<u8>),
    TextString(String),
    Array(Vec<Value>),
    IntMap(Vec<(i64, Value)>),
    StrMap(Vec<(String, Value)>),
    Bool(bool),
    Null,
}
```

Notably, there is no `Float` variant. AAFP avoids floating point on the wire
to maintain deterministic cross-language encoding. Where fractional values
are needed (e.g., uptime percentage), basis points or micro-units are used
instead.

---

## 7. Backward Compatibility Guarantees

### 7.1 N-1 Policy

AAFP guarantees that version N of the SDK interoperates with version N-1.
Specifically:

- A **new agent** (N) can **connect to** an **old agent** (N-1) using the
  v1 wire protocol. New features are carried as non-critical extensions
  that the old agent silently ignores.
- An **old agent** (N-1) can **connect to** a **new agent** (N) using the
  v1 wire protocol. The old agent's `ClientHello` lacks new extensions;
  the new agent accepts it and operates in compatibility mode.
- An **old AgentRecord** (without key 11) is fully verifiable and usable
  by a new agent. Extensions default to empty.
- A **new AgentRecord** (with key 11) is fully verifiable by an old agent.
  The old agent ignores key 11; the signature still verifies because it
  covers the raw CBOR bytes.

### 7.2 What N-1 Means in Practice

| Component | N-1 Guarantee |
|-----------|---------------|
| Wire protocol | v1 frames always parse (version byte = 1) |
| Handshake | `protocol_version = 1` always accepted |
| AgentRecord | Keys 1-10 always parsed; key 11 optional |
| Extensions | Unknown namespaces ignored; unknown versions ignored |
| Frame types | Unknown non-critical types skipped (RFC-0006 §4.2) |
| Error codes | All assigned codes are permanent (RFC-0005 §2.1) |
| CBOR encoding | Canonical rules fixed by RFC 8949 §4.2.3 |

### 7.3 Record Version Enforcement

The `KeyDirectory::publish()` method enforces monotonic version:

- Receivers MUST reject older `record_version` values.
- Equal `record_version` is accepted only if bytes are identical.
- This prevents replay of stale records even if the signature is still valid.

**Source:** `aafp-identity/src/identity_v1.rs:140-143`
```rust
/// Monotonic version number for replay protection (A-3, Rev 6).
/// Receivers MUST reject older versions. Equal version: accept only
/// if bytes are identical; otherwise reject.
pub record_version: u64,
```

### 7.4 Expiry as a Compatibility Safety Net

AgentRecords have a maximum expiry of 30 days (`MAX_RECORD_EXPIRY`).
This ensures that stale records (including those with deprecated extension
versions) naturally expire from the DHT without requiring explicit cleanup:

**Source:** `aafp-identity/src/identity_v1.rs:29-33`
```rust
pub const MAX_RECORD_EXPIRY: u64 = 30 * 24 * 60 * 60; // 2,592,000
pub const RECOMMENDED_RENEWAL: u64 = 7 * 24 * 60 * 60; // 604,800
```

---

## 8. Forward Compatibility

### 8.1 Unknown Fields Ignored

Forward compatibility is achieved through systematic ignoring of unknown
data at every layer:

**CBOR decode level**: `from_cbor()` methods only read known integer keys.
Unknown keys are silently skipped. The raw bytes are preserved for signature
verification.

**Source:** `aafp-identity/src/identity_v1.rs:227-335` — `AgentRecord::from_cbor()`
reads keys 1-10 and ignores any others present in the map.

**Extension map level**: When encountering an unknown extension namespace
(e.g., `"aafp.newfeature.v1"` that the agent doesn't know), the agent:

1. SHOULD ignore that extension (not fail).
2. MAY log a warning.
3. MUST NOT use partial data from an unknown extension.
4. MUST preserve the extension in the raw bytes for signature verification
   and for re-publishing.

**Source:** `AGENT_RECORD_EXTENSIONS.md §6.5`
> When a new agent encounters an old record (no key 11):
> - `extensions` is empty `Vec::new()`.
> - All extension lookups return `None`.
> - The agent falls back to base capability discovery.
> - No errors, no warnings — graceful degradation.
>
> When an old agent encounters a new record (has key 11):
> - `from_cbor()` ignores key 11 (it's not in the parsing code).
> - `verify()` succeeds because the signature is over the raw CBOR bytes.
> - The agent uses capabilities/endpoints as before.

### 8.2 Unknown Extensions Preserved

When an agent receives an AgentRecord with extensions it doesn't understand,
it preserves them in the `extensions: Vec<(String, Value)>` field. This
allows:

- **Re-publishing**: A DHT node can store and serve records with unknown
  extensions without parsing them.
- **Signature verification**: The raw CBOR bytes (including unknown
  extensions) are used for signature verification.
- **Forward propagation**: When a newer agent later retrieves the record,
  it can parse the extensions it understands.

### 8.3 Extension Version Negotiation

Each extension namespace has its own version. If an agent encounters an
extension namespace it recognizes but with a higher version than it supports:

- It SHOULD ignore that extension (not fail).
- It MAY log a warning.
- It MUST NOT use partial data from an unsupported version.

**Source:** `AGENT_RECORD_EXTENSIONS.md §6.5`
> This follows the "be conservative in what you accept" principle.

### 8.4 Frame Type Forward Compatibility

Unknown frame types are handled based on the critical bit (0x80) in the
flags field:

- **Unknown + critical bit set**: Reject with error 8004
  (`UNKNOWN_CRITICAL_FRAME_TYPE`), always fatal.
- **Unknown + critical bit clear**: Skip the frame and continue.

**Source:** `aafp-messaging/src/framing.rs:321-326`
```rust
// Per RFC-0006 §4.2:
// - Unknown + critical bit set: reject with error (caller sends ERROR 8004)
// - Unknown + critical bit clear: decode succeeds, caller MUST skip
if frame_type.is_unknown() && (flags & flags::CRITICAL) != 0 {
    return Err(FrameError::UnknownFrameType(frame_type_raw));
}
```

### 8.5 Extension Criticality in Handshake

Frame-level extensions (in the extension section of the frame body) use a
critical flag:

**Source:** `aafp-messaging/src/extensions.rs:20-28`
```rust
pub struct Extension {
    pub ext_type: u16,
    pub critical: bool,
    pub data: Vec<u8>,
}
```

- **Unknown critical extension**: Error 2005 (`UNSUPPORTED_EXTENSIONS`),
  always fatal.
- **Unknown non-critical extension**: Silently dropped.

**Source:** `aafp-conformance/src/version_negotiation.rs:141-152`
```rust
#[test]
fn test_ex0001_unknown_critical_extension() {
    let exts = vec![Extension {
        ext_type: 0xBEEF,
        critical: true,
        data: vec![0x01],
    }];
    let unknown = find_unknown_critical(&exts, KNOWN_EXTENSION_TYPES);
    assert_eq!(unknown, Some(0xBEEF));
    assert!(is_always_fatal(codes::UNSUPPORTED_EXTENSIONS));
}
```

---

## 9. Deprecation Process

### 9.1 Four-Phase Deprecation Cycle

Deprecation follows a 3-release cycle with four phases:

| Phase | Release | Behavior | User Action |
|-------|---------|----------|-------------|
| 1. Announce | R(n) | Feature marked `#[deprecated]` in Rust, `@deprecated` in TypeScript. Docs updated. No runtime change. | Read deprecation notice. Plan migration. |
| 2. Warn | R(n+1) | Runtime warning emitted when feature is used. Warning includes migration instructions. | Begin migration. |
| 3. Error | R(n+2) | Runtime error when feature is used. Feature still present but non-functional. | Migration required. |
| 4. Remove | R(n+3) | Feature removed from codebase. No longer compiles/exists. | Migration mandatory. |

### 9.2 Current Deprecations

The legacy `agent_record` module is in Phase 1 (Announce):

**Source:** `aafp-identity/src/lib.rs:7-11`
```rust
/// Legacy MVP AgentRecord module. Uses serde with string keys — NOT RFC-compliant.
/// Use [`identity_v1`] instead for wire serialization.
#[deprecated = "Use identity_v1 instead. Legacy agent_record uses serde/string keys, not RFC-compliant."]
#[allow(deprecated)]
pub mod agent_record;
```

The legacy `rpc` module is similarly deprecated:

**Source:** `aafp-messaging/src/lib.rs:17-21`
```rust
/// Legacy MVP RPC module. Uses serde with string keys — NOT RFC-compliant.
/// Use [`rpc_v1`] instead for wire serialization.
#[deprecated = "Use rpc_v1 instead. Legacy rpc uses serde/string keys, not RFC-compliant."]
#[allow(deprecated)]
pub mod rpc;
```

The legacy `handshake` module is kept for benchmarks only:

**Source:** `AGENTS.md`
> Legacy v0 handshake (`handshake.rs`): Marked `#![allow(dead_code)]` —
> kept for benchmarks only, NOT RFC-compliant.

### 9.3 Extension Namespace Deprecation

When an extension namespace is deprecated (e.g., `"aafp.geo.v1"` →
`"aafp.geo.v2"`):

1. **Announce**: v2 namespace defined. v1 namespace marked deprecated in docs.
2. **Warn**: Agents encountering v1 namespace log a deprecation warning.
3. **Error**: Agents reject v1 namespace with a descriptive error.
4. **Remove**: v1 namespace support removed. Old records with v1 namespace
   are treated as "unknown extension" (ignored).

Because records expire within 30 days, deprecated extension namespaces
naturally disappear from the DHT as agents republish with the new namespace.

### 9.4 Error Code Permanence

Error codes are never deprecated or reused. Once assigned, a code's meaning
is permanent:

**Source:** `aafp-core/src/error.rs:70-71`
```rust
/// Once assigned, error code meanings MUST NOT change (RFC-0005 §2.1).
```

If an error condition becomes obsolete, the code is retired (not reused).
This prevents old clients from misinterpreting a reused code.

---

## 10. Migration Tooling

### 10.1 aafp migrate Command (Proposed)

The `aafp` CLI currently has commands for init, start, discover, connect,
send, status, relay, serve, call, peers, metrics, health, and quickstart.
A `migrate` command is proposed for automatic schema upgrades:

**Source:** `aafp-cli/src/main.rs:18-106` — current CLI command set.

Proposed `migrate` subcommands:

```
aafp migrate record <input.bin> <output.bin>
    Upgrade a legacy AgentRecord (string-keyed serde) to v1 format
    (integer-keyed canonical CBOR with domain-separated signature).

aafp migrate extensions <input.bin> <output.bin>
    Upgrade extension namespaces from deprecated versions to current.
    E.g., aafp.geo.v1 → aafp.geo.v2 (if a migration path exists).

aafp migrate identity <input.bin> <output.bin>
    Upgrade an identity file to the current format, re-signing with
    the v1 domain separator.

aafp migrate check <input.bin>
    Dry-run: report what would be migrated without writing output.
    Reports: record_type, record_version, extension namespaces, any
    deprecated features detected.
```

### 10.2 Automatic Schema Upgrades

The `to_v1()` and `to_v1_signed()` methods on the legacy `AgentRecord`
provide programmatic migration:

**Source:** `aafp-identity/src/agent_record.rs:162-217`
```rust
pub fn to_v1(&self) -> crate::identity_v1::AgentRecord {
    // Converts legacy record to v1 format.
    // Signature is NOT recomputed — caller must re-sign.
}

pub fn to_v1_signed(
    &self,
    keypair: &AgentKeypair,
) -> Result<crate::identity_v1::AgentRecord, IdentityError> {
    // Converts AND re-signs with v1 domain separator.
    // Sign input: "aafp-v1-record" || canonical_CBOR(fields 1-7,9)
}
```

The migration process:
1. Read legacy record bytes.
2. Deserialize with `AgentRecord::from_bytes()` (legacy serde format).
3. Convert with `to_v1_signed(&keypair)` (re-signs with v1 format).
4. Write v1 record bytes with `AgentRecordV1::to_cbor()` → `aafp_cbor::encode()`.

### 10.3 Extension Migration

Extension namespace migration (e.g., v1 → v2) is namespace-specific. Each
extension that undergoes a breaking change must provide a `migrate_from_v1`
function:

```rust
impl GeoExtension {
    /// Migrate from v1 to v2 format.
    pub fn migrate_from_v1(v1: GeoExtensionV1) -> GeoExtensionV2 {
        // Namespace-specific conversion logic.
    }
}
```

The `migrate extensions` CLI command would:
1. Parse the record's extension map.
2. For each deprecated namespace, call the migration function.
3. Replace the old namespace entry with the new one.
4. Re-sign the record.

### 10.4 DHT-Aware Migration

During a namespace migration, agents republish their records with the new
extension namespace. The DHT's 30-minute republish interval ensures that
within ~30 minutes, all k=5 closest peers have the updated record. Old
records with deprecated namespaces expire within 30 days maximum.

---

## 11. Cross-Language Version Matrix

### 11.1 Current State

| Language | SDK Version | Protocol Version | CBOR Encoder | Frame Codec | Handshake |
|----------|------------|-----------------|-------------|-------------|-----------|
| Rust | 0.1.0 | 1 (AAFP_VERSION=1) | `aafp-cbor` | `aafp-messaging` | `aafp-crypto` |
| TypeScript | 0.1.0 | 1 (AAFP_VERSION=1) | `@aafp/cbor` | `@aafp/transport-quic` | `@aafp/sdk` |
| Python | 0.1.0 | 1 (via Rust PyO3) | Rust `aafp-cbor` | Rust `aafp-messaging` | Rust `aafp-crypto` |

### 11.2 Interoperability Matrix

| Client ↓ \ Server → | Rust 0.1 | TS 0.1 | Python 0.1 |
|---------------------|----------|--------|------------|
| Rust 0.1 | Full interop | Full interop | Full interop |
| TS 0.1 | Full interop | Full interop | Full interop |
| Python 0.1 | Full interop | Full interop | Full interop |

All three implementations at version 0.1.0 produce byte-identical:
- Canonical CBOR encoding (verified by cross-language test vectors)
- Frame headers (28-byte big-endian format)
- Handshake messages (ClientHello, ServerHello, ClientFinished)
- ML-DSA-65 signatures (verified by cross-verification: 19/19 Rust vectors
  verify in Go, 15/15 Go vectors verify in Rust)

### 11.3 Version Compatibility Rules

| Client Version | Server Version | Behavior |
|---------------|---------------|----------|
| 0.1.x | 0.1.x | Full interop (same protocol version, same extensions) |
| 0.2.x | 0.1.x | Connects at v1 protocol. New extensions in 0.2 are non-critical → old server ignores them. |
| 0.1.x | 0.2.x | Connects at v1 protocol. Old client's ClientHello lacks new extensions → new server accepts in compatibility mode. |
| 1.0.x | 0.1.x | Connects at v1 protocol. 1.0 features are extensions → 0.1 server ignores unknown non-critical extensions. |
| 0.1.x | 1.0.x | Connects at v1 protocol. Old client accepted; new server operates in compatibility mode. |
| 2.0.x | 1.0.x | If 2.0 uses protocol v2: ALPN mismatch → no connection. If 2.0 still uses v1: connects at v1. |

### 11.4 Python SDK Architecture

The Python SDK is a PyO3 wrapper around the Rust crates, so it inherits the
Rust implementation's behavior exactly:

**Source:** `implementations/rust/crates/aafp-py/pyproject.toml`
```toml
[project]
name = "aafp"
version = "0.1.0"
description = "AAFP — high-level Python API for agent-to-agent networking"
requires-python = ">=3.10"

[tool.maturin]
features = ["pyo3/extension-module"]
python-source = "python"
module-name = "aafp_py"
```

This means Python SDK versioning is inherently tied to Rust versioning. A
Rust 0.2.0 release produces a Python 0.2.0 release with identical behavior.

### 11.5 TypeScript SDK Architecture

The TypeScript SDK is a native reimplementation (not a WASM wrapper). It
must maintain byte-level compatibility with the Rust implementation through
conformance tests:

**Source:** `implementations/typescript/test/conformance.test.ts`
**Source:** `implementations/typescript/test/interop.test.ts`
**Source:** `implementations/typescript/test/golden-trace.test.ts`

These tests verify:
- CBOR encoding bytes match Rust output
- Frame encoding bytes match Rust output
- Handshake vectors match Rust output
- ML-DSA-65 cross-verification works

---

## 12. Breaking Change Policy

### 12.1 What Requires a Major Version Bump

The following changes require a MAJOR version bump (0.x → 1.0, or 1.x → 2.0):

| Change | Reason |
|--------|--------|
| Wire protocol version change (v1 → v2) | Old implementations cannot parse new frames |
| CBOR key reassignment (e.g., key 1 changes meaning) | Old decoders misinterpret data |
| Signature domain separator change | Old signatures won't verify with new separator |
| Removal of a required field | Old encoders produce records that new decoders reject |
| Change to canonical CBOR rules | All signatures break |
| Change to error code meanings | Violates RFC-0005 §2.1 permanence |
| Change to ML-DSA-65 signature algorithm | All existing signatures and keys become invalid |
| Change to frame header layout (28-byte format) | All frame decoders break |
| Change to handshake message CBOR schema | All handshakes fail |

### 12.2 What Does NOT Require a Major Version Bump

| Change | Why It's Safe |
|--------|--------------|
| New optional CBOR field (new integer key) | Old decoders ignore unknown keys |
| New extension namespace | Old agents ignore unknown namespaces |
| New extension version (v1 → v2 within a namespace) | Old agents ignore unknown versions |
| New non-critical frame type | Old agents skip unknown non-critical frames |
| New non-critical frame extension | Old agents drop unknown non-critical extensions |
| New error code in an existing category | Old agents treat unknown codes per category |
| New RPC method | Old agents return `UNKNOWN_METHOD` (5002) |
| New `CapabilityDescriptor` metadata key | Old agents ignore unknown metadata keys |
| New `CapabilityDescriptor` key (e.g., key 3) | Old agents ignore unknown keys |

### 12.3 Critical Bit as Breaking Change Signal

The critical bit mechanism allows new features to declare whether they are
"must understand" (critical) or "nice to have" (non-critical):

- **Critical = true**: If the receiver doesn't understand this, the
  connection/frame MUST be rejected. This is effectively a breaking change
  for receivers that don't support it. Used sparingly for security-critical
  features.
- **Critical = false**: If the receiver doesn't understand this, it's
  silently skipped. This is the default for new features and preserves
  backward compatibility.

**Source:** `aafp-messaging/src/framing.rs:129-131`
```rust
pub mod flags {
    pub const MORE: u8 = 0x01;
    pub const COMPRESSED: u8 = 0x02;
    /// Critical bit for unknown frame types (RFC-0006 §4.2).
    pub const CRITICAL: u8 = 0x80;
}
```

### 12.4 Semver During 0.x

During 0.x development, breaking changes may occur at any MINOR bump. The
0.x phase is explicitly "initial development" per semver. Users of 0.x
SDKs should expect breaking changes between minor versions (0.1 → 0.2)
and pin their dependencies accordingly.

The 1.0 release marks the first commitment to semver stability: breaking
changes only in 2.0, new features in 1.x, bug fixes in 1.x.y.

---

## 13. Concrete Version Evolution Example

### 13.1 v0.1 → v0.2 → v1.0

This example traces the evolution of the AAFP SDK through three releases,
showing how each layer handles versioning.

#### v0.1.0 (Current State)

- **Protocol**: v1 (AAFP_VERSION = 1)
- **SDK**: Rust 0.1.0, TypeScript 0.1.0, Python 0.1.0
- **AgentRecord**: `record_type = "aafp-record-v1"`, keys 1-10
- **Extensions**: Design documented in `AGENT_RECORD_EXTENSIONS.md`,
  stub implementations in `extensions/` directory (not yet compiled into
  the build — `mod.rs` only includes `attestation_store` and `heartbeat`)
- **Known extension types**: `0x0001` (dos-mitigation) only

**Source:** `aafp-conformance/src/version_negotiation.rs:19-20`
```rust
/// Known extension types for a v1 implementation (RFC-0002 §6.4).
/// Currently only 0x0001 (dos-mitigation) is defined.
const KNOWN_EXTENSION_TYPES: &[u16] = &[0x0001];
```

#### v0.2.0 (First Feature Release)

Changes:
- **Protocol**: Still v1 (no wire format change)
- **SDK**: Rust 0.2.0, TypeScript 0.2.0, Python 0.2.0
- **AgentRecord**: Still `"aafp-record-v1"`, keys 1-10 + optional key 11
  (extension map now fully implemented)
- **New extensions**: `aafp.geo.v1`, `aafp.perf.v1`, `aafp.cost.v1`,
  `aafp.semantic.v1`, `aafp.capver.v1`, `aafp.reputation.v1` — all
  non-critical, all version 1
- **New frame extension type**: `0x0002` (e.g., compression negotiation),
  non-critical
- **New RPC methods**: `HEARTBEAT`, `ATTST_PUBLISH` — old agents return
  `UNKNOWN_METHOD` (5002), which is non-fatal

Compatibility:
- A 0.1 agent connecting to a 0.2 agent: handshake succeeds at v1. The 0.2
  agent's `ServerHello` may include extension type `0x0002` (non-critical).
  The 0.1 agent doesn't know `0x0002` but it's non-critical → silently
  dropped. Connection proceeds.
- A 0.2 agent connecting to a 0.1 agent: handshake succeeds at v1. The 0.2
  agent's `ClientHello` may include extension type `0x0002` (non-critical).
  The 0.1 agent doesn't know `0x0002` but it's non-critical → silently
  dropped. Connection proceeds.
- A 0.2 agent publishing an AgentRecord with key 11 (extensions): A 0.1
  agent receiving this record ignores key 11, verifies the signature (which
  covers all bytes including key 11), and uses the base fields. Full
  backward compatibility.
- A 0.1 agent publishing an AgentRecord without key 11: A 0.2 agent
  receiving this record parses keys 1-10, finds no key 11, sets
  `extensions = Vec::new()`. Full forward compatibility.

No breaking changes. No major version bump. Semver: 0.1 → 0.2 (minor).

#### v1.0.0 (First Stable Release)

Changes:
- **Protocol**: Still v1 (no wire format change)
- **SDK**: Rust 1.0.0, TypeScript 1.0.0, Python 1.0.0
- **AgentRecord**: Still `"aafp-record-v1"`, keys 1-11
- **Legacy modules removed**: `agent_record` (serde), `rpc` (serde),
  `handshake` (v0) — all deprecated in 0.1, warned in 0.2, errored in
  0.3 (hypothetical), removed in 1.0
- **Extension namespaces**: All v1 namespaces stable. No v2 namespaces yet.
- **Conformance**: Full conformance test suite passing in all three
  languages. Golden traces published.
- **API stability**: 1.0 marks the first semver stability guarantee.

Compatibility:
- A 0.2 agent connecting to a 1.0 agent: full interop at v1 protocol.
  1.0 agent may have new non-critical extensions → 0.2 agent ignores them.
- A 1.0 agent connecting to a 0.2 agent: full interop at v1 protocol.
  0.2 agent may lack features the 1.0 agent wants to use → 1.0 agent
  falls back to base behavior.
- A 0.1 agent connecting to a 1.0 agent: full interop at v1 protocol.
  0.1 agent's records (no key 11) are accepted by 1.0 agent. 1.0 agent's
  records (with key 11) are accepted by 0.1 agent (key 11 ignored,
  signature verifies).

No breaking changes from 0.2 to 1.0. The major version bump (0.x → 1.0)
signals API stability commitment, not a wire protocol change.

#### v2.0.0 (Hypothetical Future)

Changes:
- **Protocol**: v2 (AAFP_VERSION = 2)
- **SDK**: Rust 2.0.0, TypeScript 2.0.0, Python 2.0.0
- **ALPN**: `aafp/2` offered alongside `aafp/1`
- **Frame header**: May change layout (e.g., add fields, change sizes)
- **Handshake**: `protocol_version = 2` in ClientHello/ServerHello
- **AgentRecord**: `"aafp-record-v2"` with new CBOR schema
- **Signature domain separator**: `"aafp-v2-record"`

Compatibility:
- A 2.0 agent can still support v1 by accepting `aafp/1` via ALPN and
  using the v1 decoder for version=1 frames.
- A 1.0 agent cannot connect to a 2.0-only server (ALPN mismatch).
- A 2.0 agent can connect to a 1.0 server by offering `aafp/1` via ALPN.
- v1 and v2 records coexist in the DHT, distinguished by `record_type`.

### 13.2 Extension Namespace Evolution Example

The `"aafp.geo.v1"` extension evolves to `"aafp.geo.v2"`:

| Phase | Release | Agent Behavior |
|-------|---------|---------------|
| v2 defined | 0.3.0 | Agents that know v2 can read both v1 and v2. Agents that only know v1 ignore v2. |
| v1 deprecated | 0.4.0 | Agents encountering v1 log a deprecation warning. `aafp migrate extensions` upgrades v1 → v2. |
| v1 errors | 0.5.0 | Agents encountering v1 return an error. Migration is required. |
| v1 removed | 1.0.0 | v1 namespace support removed. Records with v1 are treated as unknown extension (ignored). |

Because records expire within 30 days and agents republish every 30 minutes,
the v1 → v2 migration completes organically as agents update their software
and republish with v2 extensions.

---

## 14. Reference: Key Source Files

| File | Purpose |
|------|---------|
| `aafp-messaging/src/framing.rs` | Frame format, `AAFP_VERSION`, encode/decode |
| `aafp-crypto/src/handshake_v1.rs` | Handshake messages, `PROTOCOL_VERSION`, transcript hash |
| `aafp-core/src/error.rs` | Error codes, `is_always_fatal()`, `INVALID_VERSION` |
| `aafp-identity/src/identity_v1.rs` | AgentRecord v1, `RECORD_TYPE_V1`, `record_version` |
| `aafp-identity/src/agent_record.rs` | Legacy AgentRecord, `to_v1()`, `to_v1_signed()` |
| `aafp-identity/src/extensions/version.rs` | `SemanticVersion`, `CapabilityVersionExtension` |
| `aafp-identity/src/extensions/semantic.rs` | `SemanticExtension`, `aafp.semantic.v1` |
| `aafp-identity/src/extensions/geo.rs` | `GeoExtension`, `aafp.geo.v1` |
| `aafp-identity/src/extensions/cost.rs` | `CostExtension`, `aafp.cost.v1` |
| `aafp-identity/src/extensions/performance.rs` | `PerformanceExtension`, `aafp.perf.v1` |
| `aafp-identity/src/extensions/reputation.rs` | `ReputationExtension`, `aafp.reputation.v1` |
| `aafp-identity/src/extensions/heartbeat.rs` | `HeartbeatUpdate`, heartbeat liveness |
| `aafp-identity/src/extensions/attestation.rs` | `Attestation`, `aafp-v1-attestation` domain separator |
| `aafp-identity/src/extensions/attestation_store.rs` | DHT attestation storage |
| `aafp-identity/src/lib.rs` | Module exports, `#[deprecated]` legacy modules |
| `aafp-messaging/src/lib.rs` | Messaging exports, `#[deprecated]` legacy rpc |
| `aafp-messaging/src/extensions.rs` | Frame-level extensions, `Extension` struct, critical flag |
| `aafp-messaging/src/rpc_v1.rs` | RPC v1, integer-keyed canonical CBOR |
| `aafp-cbor/src/lib.rs` | Canonical CBOR encoder/decoder, `Value` enum |
| `aafp-conformance/src/version_negotiation.rs` | Version negotiation conformance tests |
| `aafp-cli/src/main.rs` | CLI commands, version `0.1.0` |
| `implementations/rust/Cargo.toml` | Workspace version `0.1.0` |
| `implementations/rust/crates/aafp-py/pyproject.toml` | Python SDK version `0.1.0` |
| `implementations/typescript/package.json` | TypeScript SDK version `0.1.0` |
| `implementations/typescript/packages/transport-quic/src/frame.ts` | TS `AAFP_VERSION = 1` |
| `implementations/typescript/packages/sdk/src/client-handshake.ts` | TS `PROTOCOL_VERSION = 1` |
| `implementations/typescript/packages/cbor/src/encoder.ts` | TS canonical CBOR encoder |
| `implementations/rust/VERSION_NEGOTIATION_MATRIX.md` | Version negotiation behavior matrix |
| `AGENT_RECORD_EXTENSIONS.md` | Extension map design, `AgentRecordExtension` trait |

---

## Summary

AAFP's versioning strategy is built on five pillars:

1. **Strict protocol versioning**: The wire protocol version (u8 = 1) is
   hard-checked on every frame. No silent downgrade, no in-band fallback.
   Version negotiation happens via ALPN, not via application-layer messages.

2. **Extension-based forward compatibility**: New features are added as
   non-critical extensions (frame extensions, AgentRecord extensions, new
   CBOR keys). Old agents ignore what they don't understand. The critical
   bit mechanism allows features to declare "must understand" when needed.

3. **Versioned namespaces**: AgentRecord extensions use string-keyed
   namespaces (`aafp.<name>.v<N>`) that evolve independently. Each
   namespace has its own version, allowing targeted evolution without
   affecting other extensions or the base record.

4. **Semver for SDKs**: All three SDKs (Rust, Python, TypeScript) follow
   semantic versioning in lockstep. The 1.0 release marks the first
   stability guarantee. During 0.x, breaking changes may occur at minor
   bumps.

5. **Controlled deprecation**: Features follow a 4-phase deprecation cycle
   (announce → warn → error → remove) across 3 releases. The 30-day
   AgentRecord expiry ensures deprecated data structures naturally
   disappear from the DHT. Error codes are permanent and never reused.

The net result: an agent running SDK 0.1.0 can interoperate with an agent
running SDK 1.0.0, as long as both use the v1 wire protocol. New features
are opt-in via extensions. Breaking changes require a protocol version bump
(v1 → v2) and are gated by ALPN negotiation.
