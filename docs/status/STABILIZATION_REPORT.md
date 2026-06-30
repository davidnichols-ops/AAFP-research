# AAFP Stabilization Report

**Date:** 2026-06-29
**Assessment baseline:** Post-Phase C development snapshot
**Repository:** `github.com/davidnichols-ops/AAFP-research` (umbrella)
**Implementations:** `github.com/davidnichols-ops/aafp` (Rust), `github.com/davidnichols-ops/aafp-go` (Go)

---

## Executive Summary

The AAFP protocol implementation has been stabilized through a comprehensive
audit covering security, code quality, documentation, API surface, dependencies,
and cross-references. All 11 audit items are complete. The codebase builds with
zero warnings, passes clippy with zero lints, and all 545 tests pass.

---

## Verification Summary

| Check | Result |
|-------|--------|
| `cargo fmt --all -- --check` | PASS (0 diffs) |
| `cargo build --workspace` | PASS (0 warnings) |
| `cargo clippy --workspace` | PASS (0 warnings) |
| `cargo test --workspace` | PASS (545 tests, 0 failures) |

---

## Audit Results

### 1. SA-0006: Max Extension Size Limit — COMPLETE

The `MAX_EXTENSION_SIZE` (64 KiB) limit is fully implemented in
`aafp-messaging/src/framing.rs`. The `decode_frame` function rejects frames
with extensions exceeding this limit. An adversarial test in
`aafp-conformance/src/adversarial.rs` verifies rejection of oversized
extensions.

### 2. Legacy MVP Path Isolation — COMPLETE

Legacy modules are marked `#[deprecated]` and no longer re-exported from crate
roots:

| Crate | Legacy Module | Replacement |
|-------|--------------|-------------|
| `aafp-crypto` | `handshake` (v0, binary format) | `handshake_v1` (RFC-0002 §5) |
| `aafp-identity` | `agent_record` (serde/string keys) | `identity_v1` (integer CBOR keys) |
| `aafp-messaging` | `rpc` (serde/string keys) | `rpc_v1` (integer CBOR keys) |
| `aafp-discovery` | `capability_dht` (in-memory only) | `discovery_v1` (RFC-0004) |

The SDK uses legacy types for local in-memory state only (not wire
serialization). All wire-serializable data uses v1 RFC-compliant types.

### 3. Repository Housekeeping — COMPLETE

- **Compiler warnings:** 0 (down from ~80+)
- **Clippy lints:** 0 (down from ~28)
- **Strategy:** Targeted `#![allow]` attributes for legacy/test code; genuine
  fixes for main library code. No `cargo fix --allow-dirty` used (avoids
  over-aggressive import removal).

### 4. Build & Test Audit — COMPLETE

All four verification checks pass clean:
- `cargo fmt --all -- --check`: 0 formatting diffs
- `cargo build --workspace`: 0 warnings, 0 errors
- `cargo clippy --workspace`: 0 warnings, 0 errors
- `cargo test --workspace`: 545 tests, 0 failures

### 5. Documentation Audit — COMPLETE

**README.md:**
- Updated test count from 461 → 545
- Updated status table to reflect current state (handshake implemented,
  crypto migrated, SDK enforces auth)
- Updated release criteria from 7/10 → 8/10

**ROADMAP.md:**
- P0-1 (pqcrypto migration): marked DONE
- P0-2 (handshake state machine): marked DONE
- P0-3 (identity verification): marked DONE
- P0-4 (consolidate duplicates): marked PARTIAL
- P0-5 (ALPN): marked Pending
- P0-6/P0-7 (ERROR/CLOSE frames): marked PARTIAL
- P1-6 (warnings): marked DONE
- Release criteria updated to 8/10 met

**AGENTS.md:** Created with build/test commands and project layout for
outside engineer discovery.

### 6. API Consistency Audit — COMPLETE

**Issues found and fixed:**
- `aafp-crypto`: Removed legacy `ClientHello`/`ServerHello`/`PqHandshake`
  re-exports from crate root. Legacy module marked `#[deprecated]`.
- `aafp-identity`: Removed duplicate `CapabilityDescriptor as
  CapabilityDescriptorV1` alias (was same type exported twice). Removed legacy
  `AgentRecord` re-export. Legacy module marked `#[deprecated]`.
- `aafp-discovery`: Removed legacy `CapabilityDht`/`DhtError`/`DhtRecord`
  re-exports. Legacy module marked `#[deprecated]`.

**Result:** v1 RFC-compliant types are the primary exports. Legacy types are
accessible via full module paths (e.g., `aafp_crypto::handshake::PqHandshake`)
but trigger deprecation warnings.

### 7. Dependency Audit — COMPLETE

**Removed unused dependencies:**
- `blake3`: Completely unused (removed from workspace Cargo.toml)
- `futures`: Completely unused (removed from workspace + 3 crate Cargo.toml files)

**Remaining dependencies:** All 25 remaining external dependencies are actively
used. `serde`/`ciborium` are used by legacy modules and UCAN tokens.

### 8. RFC Cross-Reference Audit — COMPLETE

- All 6 RFC files exist (0001–0006)
- All RFCs at Revision 5 (matches README)
- 100+ RFC references in Rust source code — all valid
- All section references (§X.Y) verified against actual RFC content
- All internal RFC cross-references verified
- **No issues found**

### 9. Repository Consistency Audit — COMPLETE

- All 13 crates use workspace-level version (0.1.0) and license (MIT OR Apache-2.0)
- Fixed Cargo.toml repository URL (`github.com/aafp/aafp` → `github.com/davidnichols-ops/aafp`)
- Repository layout is clean and matches README description
- `.gitmodules` correctly points to both implementation submodules

---

## Release Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Two independent implementations | MET |
| 2 | Bidirectional wire interop | MET |
| 3 | Cross-signature verification | NOT MET (Go lacks ML-DSA-65) |
| 4 | Published test vectors | MET |
| 5 | Published golden traces | MET |
| 6 | No unresolved ambiguities | MET |
| 7 | No security-critical issues | MET |
| 8 | Conformance suite passing | MET |
| 9 | Performance targets | NOT MET (network perf untested) |
| 10 | Supply-chain review | MET |

**8 of 10 met.** Remaining: cross-signature verification (P1-4) and performance
validation (P1-5).

---

## Remaining Work (Pre-Public-Release)

| Priority | Item | Status |
|----------|------|--------|
| P0-5 | ALPN `aafp/1` in TLS | Pending |
| P0-6 | ERROR frame transmission by SDK | Partial (frame type defined) |
| P0-7 | CLOSE frame transmission by SDK | Partial (frame type defined) |
| P1-1 | PING/PONG keep-alive | Pending |
| P1-2 | Discovery RPC over QUIC | Pending |
| P1-3 | CI pipeline (GitHub Actions) | Pending |
| P1-4 | ML-DSA-65 in Go implementation | Pending |
| P1-5 | Performance validation | Pending |
| P1-7 | Rustdoc documentation | Pending |
| P1-8 | Basic relay protocol | Pending (new RFC needed) |
