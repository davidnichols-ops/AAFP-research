# A-8 Completion Report: Normative CLOSE Frame Semantics

## Summary

A-8 formalizes the CLOSE frame lifecycle in RFC-0002 §6.6 and implements
a normative `CloseManager` in both Rust and Go. The CloseManager is the
single authority for all close-related state transitions, enforcing five
invariants and handling all edge cases: graceful close, crossed close,
timeout, abort, fatal error, transport reset, and duplicate CLOSE frames.

## RFC Changes

### RFC-0002 §6.6 (New Section)

Added a comprehensive normative section with 12 subsections:

| Subsection | Content |
|------------|---------|
| §6.6.1 | CloseManager state machine (5 states, transition table, 5 invariants) |
| §6.6.2 | Close initiation (initiate_close API, close code semantics) |
| §6.6.3 | Close reception (4 cases: Open, LocalCloseSent, RemoteCloseReceived, Closed) |
| §6.6.4 | Crossed CLOSE (simultaneous close handling) |
| §6.6.5 | Close timeout (default 5s, min 1s, configurable) |
| §6.6.6 | Frame disposition during close (no ERROR sent during close) |
| §6.6.7 | Outstanding resources on close (RPCs, streams, timers, buffers, crypto) |
| §6.6.8 | Fatal ERROR vs CLOSE (comparison table) |
| §6.6.9 | Transport reset (ungraceful close) |
| §6.6.10 | CloseManager API summary (language-agnostic interface) |
| §6.6.11 | Sequence diagrams (normal, crossed, timeout) |
| §6.6.12 | Security considerations (amplification, truncation, DoS) |

### RFC-0002 §5.10.9 (Updated)

Added a note that §6.6 is the normative specification and §5.10.9 is
a summary. In case of conflict, §6.6 takes precedence.

## Implementation

### Rust (`aafp-messaging/src/close_manager.rs`)

- **CloseManager** struct with 5 states: `Open`, `LocalCloseSent`,
  `RemoteCloseReceived`, `CloseReceived`, `Closed`
- **CloseAction** enum: `SendCloseFrame`, `CloseQuic`, `None`
- **CloseFrameDisposition** enum: `Accept`, `DiscardSilently`
- Methods: `initiate_close`, `on_close_received`, `respond_close`,
  `on_fatal_error_received`, `on_transport_reset`, `on_timeout`,
  `abort`, `check_timer`, `can_send`, `frame_disposition`
- Configurable timeout (default 5s, min 1s)
- UTF-8-safe message truncation (max 256 bytes)
- Transport-agnostic and synchronous (caller manages timers/QUIC)

### Go (`closemanager/closemanager.go`)

- Mirrors the Rust implementation exactly
- Same 5 states, same API, same semantics
- `CloseManager`, `CloseAction`, `CloseFrameDisposition` types
- All methods match Rust counterparts

## Test Coverage

### Test Summary

| Category | Rust | Go | Total |
|----------|------|-----|-------|
| Unit tests | 46 | 46 | 92 |
| Conformance (§6.6) | 43 | 43 | 86 |
| Adversarial | 27 | 27 | 54 |
| Property (100K iter each) | 10 | 10 | 20 |
| Differential (JSON vectors) | 2 (19 vectors) | 2 (19 vectors) | 4 |
| Resource verification | 25 | 25 | 50 |
| **Total A-8 tests** | **153** | **153** | **306** |

### Property Tests (100,000 iterations each)

1. Closed state is always terminal
2. initiate_close sends at most one CLOSE frame
3. respond_close sends at most one CLOSE frame
4. No data frames sendable after CLOSE sent
5. Frame disposition never returns RejectWithError
6. Timer only active in LocalCloseSent or RemoteCloseReceived
7. Only 5 states are reachable
8. No CloseQuic action after already Closed
9. Message always truncated to ≤256 bytes
10. Crossed close always results in Closed

### Adversarial Tests

- CLOSE frame flooding (1000 frames)
- Mixed frame type flooding during close
- Oversized message truncation (100KB)
- Multibyte UTF-8 truncation safety
- Out-of-order events (timeout after close, fatal error after close)
- Late CLOSE frames (after abort/timeout/fatal error)
- Rapid initiate/abort cycles (1000 iterations)
- State corruption attempts (all 256 frame types, 10K random events)
- Timer manipulation (past/future times)
- Extreme close codes (0, u32::MAX)
- Concurrent close race simulation

### Differential Tests

19 JSON trace vectors shared between Rust and Go, verifying identical
behavior for:
- Graceful close (client/server initiated)
- Crossed close
- Timeout close
- Abort close
- Fatal error close
- Transport reset close
- Duplicate CLOSE handling
- Idempotent initiate_close
- Fatal error after local close
- Transport reset after remote close
- Timeout in remote close received
- Non-zero close codes
- Oversized message truncation
- Empty message
- Late close after abort
- Late timeout after close
- respond_close from Open (no-op)
- initiate after remote close (no-op)

## Performance (Go benchmarks, Apple M4)

| Benchmark | ns/op | B/op | allocs/op |
|-----------|-------|------|-----------|
| InitiateClose | 39 | 24 | 1 |
| GracefulCloseFull | 58 | 44 | 3 |
| ForcedCloseAbort | 0.2 | 0 | 0 |
| CloseUnderFlood1000 | 16,263 | 20,024 | 2,001 |
| FrameDispositionDuringClose | 124 | 0 | 0 |
| CanSendDuringClose | 123 | 0 | 0 |
| RespondClose | 59 | 44 | 3 |
| CrossedClose | 59 | 44 | 3 |
| TimeoutClose | 41 | 24 | 1 |

## Final Metrics

- **Rust**: 869 tests, 0 failures (was 716 before A-8, +153 new)
- **Go**: all packages pass, 0 failures (153 new in closemanager)
- **RFC**: §6.6 added (12 subsections), §5.10.9 updated
- **Differential**: 19 shared JSON vectors, both implementations pass
- **Formatting**: `cargo fmt --all -- --check` passes
- **Clippy**: 0 new warnings (2 pre-existing in pipeline.rs from A-7)

## Files Created

### Rust
- `crates/aafp-messaging/src/close_manager.rs` — CloseManager implementation
- `crates/aafp-conformance/src/close_conformance.rs` — 43 conformance tests
- `crates/aafp-conformance/src/close_adversarial.rs` — 27 adversarial tests
- `crates/aafp-conformance/src/close_property.rs` — 10 property tests
- `crates/aafp-conformance/src/close_differential.rs` — 2 differential tests
- `crates/aafp-conformance/src/close_resources.rs` — 25 resource tests
- `crates/aafp-benchmark/benches/close_manager.rs` — 9 benchmarks

### Go
- `closemanager/closemanager.go` — CloseManager implementation
- `closemanager/closemanager_test.go` — 46 unit tests
- `closemanager/conformance_test.go` — 43 conformance tests
- `closemanager/adversarial_test.go` — 27 adversarial tests
- `closemanager/property_test.go` — 10 property tests
- `closemanager/differential_test.go` — 2 differential tests
- `closemanager/resources_test.go` — 25 resource tests
- `closemanager/benchmark_test.go` — 10 benchmarks
- `closemanager/close_vectors.json` — 19 shared differential vectors

### RFC
- `RFCs/0002-transport-framing.md` — §6.6 added, §5.10.9 updated

## Files Modified

- `implementations/rust/crates/aafp-messaging/src/lib.rs` — added close_manager module
- `implementations/rust/crates/aafp-conformance/src/lib.rs` — added 5 test modules
- `implementations/rust/crates/aafp-benchmark/Cargo.toml` — added close_manager bench
- `ROADMAP.md` — A-8 marked DONE
