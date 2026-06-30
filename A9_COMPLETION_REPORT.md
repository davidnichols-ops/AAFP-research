# A-9 Completion Report: Nonce Reuse Detection

## Summary

A-9 implements normative nonce replay detection for AAFP handshakes, as specified in RFC-0002 §6.7 (Rev 6 A-9). The `ReplayCache` is a time-bounded set of observed `(agent_id, nonce)` pairs that rejects replayed handshakes **before** signature verification, conserving CPU and preventing session-ID collisions.

## RFC Changes

### RFC-0002 §6.7 — Normative Nonce Replay Detection (NEW)

Added a complete normative section with 11 subsections:

| Section | Title | Content |
|---------|-------|---------|
| §6.7.1 | Threat Model | Defines in-scope/out-of-scope attacks |
| §6.7.2 | ReplayCache Structure | Entry fields, cache key = `(agent_id, nonce)` |
| §6.7.3 | Cache Parameters | retention (300s default), max_entries (100K default), eviction_policy |
| §6.7.4 | Normative Invariants | 7 invariants (check-before-verify, insert-after-verify, atomicity, etc.) |
| §6.7.5 | Server-Side Replay Check | 6-step procedure for ClientHello replay detection |
| §6.7.6 | Client-Side Replay Check | 6-step procedure for ServerHello replay detection |
| §6.7.7 | Eviction and Resource Management | Lazy eviction, background sweep, LRU fallback, memory budget |
| §6.7.8 | Concurrency Requirements | Thread safety, atomic check-and-insert |
| §6.7.9 | ReplayCache API Summary | Normative API specification |
| §6.7.10 | Sequence Diagrams | Normal, replay, concurrent replay scenarios |
| §6.7.11 | Security Considerations | 7 considerations (CPU amplification, cache poisoning, false positives, etc.) |

### RFC-0002 §5.10.6 — Updated

Changed from `SHOULD` to `MUST` for replay cache maintenance. Updated to reference §6.7 for full specification. Added client-side replay check requirement.

### RFC-0002 §5.10.8 — Updated

Added §6.7 cross-reference to nonce reuse cache retention row.

### RFC-0002 §5.9 — Updated

Updated error code 2008 reference from §5.10.6 to §6.7.

## Rust Implementation

### `aafp-crypto/src/replay_cache.rs` (NEW)

- **ReplayCache** struct with `Mutex<HashMap<CacheKey, Entry>>`
- **CacheKey**: 64-byte fixed array `(agent_id || nonce)` — zero heap allocation per lookup
- **API**: `new()`, `with_params()`, `with_params_unchecked()`, `check()`, `check_and_insert()`, `insert()`, `evict_expired()`, `clear()`, `len()`, `is_empty()`, `retention()`, `max_entries()`
- **Thread-safe**: Internal `Mutex`, atomic `check_and_insert`
- **Eviction**: Lazy eviction (batch of 64 on access), full sweep via `evict_expired()`, LRU fallback
- **Parameter validation**: Enforces RFC ranges (retention 60-3600s, max_entries 1K-10M)
- **29 unit tests**: All pass, 0 clippy warnings

### `aafp-sdk/src/handshake_driver.rs` (MODIFIED)

- `drive_client_handshake`: Added `replay_cache: Option<&ReplayCache>` parameter
  - Checks ServerHello nonce before signature verification (§6.7.6)
  - Inserts ServerHello nonce after verification succeeds (§6.7.4 Invariant 3)
- `drive_server_handshake`: Added `replay_cache: Option<&ReplayCache>` parameter
  - Checks ClientHello nonce before signature verification (§6.7.5)
  - Inserts ClientHello nonce after verification succeeds (§6.7.4 Invariant 2)
- Callers in `client.rs` and `server.rs` updated with `None` (replay checking opt-in)

### `aafp-crypto/src/lib.rs` (MODIFIED)

Added `replay_cache` module and exports: `ReplayCache`, `ReplayCacheError`, `NonceReuseError`, and all parameter constants.

## Go Implementation

### `replaycache/replaycache.go` (NEW)

- **ReplayCache** struct with `sync.Mutex` + `map[cacheKey]*entry`
- **cacheKey**: 64-byte fixed array `(agent_id || nonce)`
- **API**: Mirrors Rust — `New()`, `NewWithParams()`, `NewWithParamsUnchecked()`, `Check()`, `CheckAndInsert()`, `Insert()`, `EvictExpired()`, `Clear()`, `Len()`, `IsEmpty()`, `Retention()`, `MaxEntries()`
- **Thread-safe**: Internal `sync.Mutex`, atomic `CheckAndInsert`
- **29 unit tests**: All pass, `go vet` clean

### `replaycache/handshake_integration.go` (NEW)

- **HandshakeReplayChecker**: Wraps ReplayCache for handshake integration
- `CheckClientHello()`, `InsertClientHello()`, `CheckAndInsertClientHello()`
- `CheckServerHello()`, `InsertServerHello()`, `CheckAndInsertServerHello()`
- Enforces check-before-verify, insert-after-verify invariants
- 7 integration tests: All pass

## Test Results

### Rust

| Test Category | File | Tests | Status |
|---------------|------|-------|--------|
| Unit tests | `aafp-crypto/src/replay_cache.rs` | 29 | PASS |
| Conformance | `aafp-conformance/src/replay_conformance.rs` | 32 | PASS |
| Stress | `aafp-conformance/src/replay_stress.rs` | 9 | PASS |
| Differential | `aafp-conformance/src/replay_differential.rs` | 2 (15 vectors) | PASS |
| **Total Rust new** | | **72** | **PASS** |
| Full workspace | | **898** | **PASS** |

### Go

| Test Category | File | Tests | Status |
|---------------|------|-------|--------|
| Unit tests | `replaycache_test.go` | 29 | PASS |
| Conformance | `conformance_test.go` | 31 | PASS |
| Stress | `stress_test.go` | 9 | PASS |
| Differential | `differential_test.go` | 2 (15 vectors) | PASS |
| Integration | `handshake_integration_test.go` | 7 | PASS |
| **Total Go new** | | **78** | **PASS** |

### Differential Testing

15 shared JSON replay trace vectors (`replay_vectors.json`) executed identically in both Rust and Go:
- `fresh_nonce_accepted`
- `replay_detected`
- `different_agent_same_nonce_not_replay`
- `different_nonce_same_agent_not_replay`
- `check_returns_true_for_existing`
- `check_returns_false_for_missing`
- `insert_then_check`
- `clear_resets_cache`
- `all_zero_nonce`
- `all_ff_nonce`
- `multiple_nonces_same_agent`
- `multiple_agents_same_nonce`
- `replay_after_clear`
- `insert_idempotent`
- `short_agent_id_padded`

## Performance Benchmarks

### Rust (criterion, Apple M4)

| Benchmark | Time |
|-----------|------|
| check_and_insert_fresh | ~350 ns |
| check_and_insert_replay | ~40 ns |
| check_fresh | ~35 ns |
| check_existing | ~40 ns |
| check_and_insert_100k_cache | ~276 µs |
| evict_expired_10k | ~6.9 ms |

### Go (testing.B, Apple M4)

| Benchmark | Time | Allocs |
|-----------|------|--------|
| CheckAndInsertFresh | 338 ns/op | 2 allocs, 688 B |
| CheckAndInsertReplay | 39 ns/op | 0 allocs |
| CheckFresh | 36 ns/op | 0 allocs |
| CheckExisting | 39 ns/op | 0 allocs |
| CheckAndInsert100KCache | 1.28 ms/op | 1 alloc, 48 B |
| EvictExpired10K | 926 µs/op | 0 allocs |

## Key Design Decisions

1. **Cache key = `(agent_id, nonce)`**: Scoping by agent_id is defense-in-depth. A 32-byte random nonce has negligible collision probability, but per-agent scoping prevents false positives across agents and enables per-agent sharding.

2. **Check-before-verify**: The replay check is O(1) and precedes signature verification. This prevents CPU amplification attacks where an attacker replays many handshakes to consume ML-DSA-65 verification CPU (~1ms per verification).

3. **Insert-after-verify**: Nonces are inserted into the cache only after signature verification succeeds. This prevents cache poisoning — an attacker cannot block a legitimate client by sending forged handshakes with the client's agent_id.

4. **Atomic check-and-insert**: The `check_and_insert` operation is atomic under the lock, ensuring that concurrent handshakes with the same nonce result in exactly one success and one `NONCE_REUSE` error.

5. **LRU eviction with expire-first**: When the cache is full, expired entries are evicted first. If no expired entries exist, the least-recently-used entry is evicted. This bounds memory usage while maximizing replay detection coverage.

6. **Transport-agnostic**: The ReplayCache does not own timers, connections, or streams. The caller is responsible for periodic eviction and configuring parameters. This makes it trivially testable.

7. **Optional integration**: The handshake driver accepts `Option<&ReplayCache>`, allowing deployments to opt in to replay protection. Passing `None` disables replay checking (backward compatible).

## Files Created/Modified

### Created (Rust)
- `implementations/rust/crates/aafp-crypto/src/replay_cache.rs`
- `implementations/rust/crates/aafp-conformance/src/replay_conformance.rs`
- `implementations/rust/crates/aafp-conformance/src/replay_stress.rs`
- `implementations/rust/crates/aafp-conformance/src/replay_differential.rs`
- `implementations/rust/crates/aafp-conformance/src/replay_vectors.json`
- `implementations/rust/crates/aafp-benchmark/benches/replay_cache.rs`

### Modified (Rust)
- `implementations/rust/crates/aafp-crypto/src/lib.rs` (module + exports)
- `implementations/rust/crates/aafp-sdk/src/handshake_driver.rs` (integration)
- `implementations/rust/crates/aafp-sdk/src/client.rs` (caller update)
- `implementations/rust/crates/aafp-sdk/src/server.rs` (caller update)
- `implementations/rust/crates/aafp-conformance/src/lib.rs` (modules)
- `implementations/rust/crates/aafp-benchmark/Cargo.toml` (bench entry)

### Created (Go)
- `implementations/go/replaycache/replaycache.go`
- `implementations/go/replaycache/replaycache_test.go`
- `implementations/go/replaycache/handshake_integration.go`
- `implementations/go/replaycache/handshake_integration_test.go`
- `implementations/go/replaycache/conformance_test.go`
- `implementations/go/replaycache/stress_test.go`
- `implementations/go/replaycache/differential_test.go`
- `implementations/go/replaycache/benchmark_test.go`
- `implementations/go/replaycache/replay_vectors.json`

### Modified (RFC/Docs)
- `RFCs/0002-transport-framing.md` (§6.7 added, §5.10.6/§5.10.8/§5.9 updated)
- `ROADMAP.md` (A-9 → DONE)
- `implementations/rust/AGENTS.md` (test count, module docs)
