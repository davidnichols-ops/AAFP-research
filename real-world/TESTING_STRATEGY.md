# AAFP Testing Strategy & Conformance Certification

**Status:** Living document
**Scope:** All AAFP implementations (Rust reference, Go wire-format library,
TypeScript SDK, Python adapter)
**Last updated:** 2026-07-05

---

## Table of Contents

1. [Testing Philosophy](#1-testing-philosophy)
2. [The AAFP Testing Pyramid](#2-the-aafp-testing-pyramid)
3. [Layer 1 — Unit Testing](#3-layer-1--unit-testing)
4. [Layer 2 — Integration Testing](#4-layer-2--integration-testing)
5. [Layer 3 — Conformance Testing](#5-layer-3--conformance-testing)
6. [Golden Trace Testing](#6-golden-trace-testing)
7. [Cross-Language Interop: The A-10 Matrix](#7-cross-language-interop-the-a-10-matrix)
8. [Layer 4 — Load Testing](#8-layer-4--load-testing)
9. [Layer 5 — Chaos Testing](#9-layer-5--chaos-testing)
10. [Property-Based Testing](#10-property-based-testing)
11. [Fuzzing](#11-fuzzing)
12. [Mutation Testing](#12-mutation-testing)
13. [Test Infrastructure & CI](#13-test-infrastructure--ci)
14. [Conformance Certification Program](#14-conformance-certification-program)
15. [Test Inventory & Coverage Matrix](#15-test-inventory--coverage-matrix)
16. [Appendix A: Conformance Test Module Reference](#appendix-a-conformance-test-module-reference)

---

## 1. Testing Philosophy

AAFP is a post-quantum agent-to-agent protocol where a single byte-level
discrepancy between implementations can break interoperability across an
entire fleet of AI agents. The testing strategy is therefore built on three
first principles:

1. **The wire is the contract.** Every test that touches encoding, framing,
   CBOR, or handshake messages must assert byte-exact output. "Close enough"
   is not acceptable — two implementations that produce semantically
   equivalent but byte-different CBOR are not interoperable.

2. **RFC normative requirements are testable.** Every MUST, MUST NOT, and
   SHOULD in RFCs 0001–0011 has a conformance test with a traceable
   requirement ID (e.g., `R2-001`, `R3-015`, `R5-003`). If a requirement
   has no test, it is a gap, not a design choice.

3. **Adversarial inputs are first-class citizens.** Protocol parsers are
   attack surfaces. The test suite includes dedicated negative tests,
   adversarial tests, fuzz targets, and property-based tests that feed
   malformed, truncated, oversized, and maliciously crafted inputs into
   every parser and state machine.

### Current Test Counts

| Implementation | Test count | Status |
|---------------|-----------|--------|
| Rust workspace | 1,755 | Passing (7 ignored) |
| Go wire-format | 664 | Passing |
| TypeScript SDK | Scaffold (TODO stubs) | In progress |
| Python adapter | 4 test files | Passing |
| Conformance crate | 568 `#[test]` functions | Passing |
| Fuzz targets | 8 | Build-verified |

The Rust workspace has grown from ~50 tests in the MVP to 1,755 tests across
17 crates. The conformance crate alone contains 568 test functions spanning
11,790 lines of test code, organized by RFC section and normative requirement.

---

## 2. The AAFP Testing Pyramid

```
                    ┌─────────┐
                    │  Chaos  │  Network partitions, agent crashes,
                    │         │  relay failures, Byzantine agents
                    ├─────────┤
                    │  Load   │  10K concurrent connections,
                    │         │  100K RPC/s, sustained throughput
                    ├─────────┤
                    │ Conform │  RFC compliance, golden traces,
                    │         │  cross-language interop (A-10)
                    ├─────────┤
                    │ Integr. │  Cross-crate, cross-language,
                    │         │  WAN simulation, multi-node DHT
                    ├─────────┤
                    │  Unit   │  Each crate in isolation
                    │         │  (1,755 tests, fast feedback)
                    └─────────┘
```

The pyramid is intentionally bottom-heavy. Unit tests provide the fastest
feedback loop (seconds) and catch the majority of regressions. Each
successive layer up is slower, more expensive, and tests broader system
properties. The layers are complementary, not redundant — a unit test that
verifies CBOR encoding correctness and a conformance test that verifies
RFC-0002 §8 compliance are testing the same code from different angles.

| Layer | Count | Runtime | Feedback | Purpose |
|-------|-------|---------|----------|---------|
| Unit | ~1,200 | <30s | Seconds | Per-function correctness |
| Integration | ~200 | <2 min | Minutes | Cross-crate, cross-language |
| Conformance | 568 | <1 min | Minutes | RFC normative compliance |
| Load | Configurable | Minutes–hours | Hours | Scale, throughput, stability |
| Chaos | Configurable | Minutes–hours | Hours | Resilience, fault tolerance |

---

## 3. Layer 1 — Unit Testing

### 3.1 Principles

Each of the 17 Rust crates is tested in isolation. Unit tests live in the
same file as the code they test (`#[cfg(test)] mod tests`) or in a
`tests/` directory for black-box integration tests. The key rules:

- **No network I/O in unit tests.** Tests that require a QUIC connection,
  socket, or external process belong in integration tests.
- **No cross-crate dependencies in unit tests** (except workspace crates).
  A unit test for `aafp-cbor` should not import `aafp-crypto`.
- **Deterministic inputs.** Unit tests use fixed seeds, fixed nonces, and
  fixed keypairs. No `thread_rng()` in test code — use a deterministic PRNG.
- **Fast.** The full unit test suite runs in under 30 seconds on an M3 Pro.
  ML-DSA-65 key generation is ~133µs, so even 1,000 keygen tests complete
  in ~133ms.

### 3.2 Crate-Level Test Organization

| Crate | Test location | Focus |
|-------|--------------|-------|
| `aafp-cbor` | `src/lib.rs` inline | Canonical encoding, decode, round-trip |
| `aafp-crypto` | `src/*.rs` inline | ML-DSA-65, AEAD, HKDF, handshake, replay |
| `aafp-identity` | `src/*.rs` inline | AgentId, AgentRecord, UCAN, TrustManager |
| `aafp-core` | `src/*.rs` inline | Session state machine, authorization traits |
| `aafp-messaging` | `src/*.rs` inline | Frame encode/decode, CloseManager, pipeline |
| `aafp-discovery` | `src/*.rs` inline | DHT routing, bootstrap, replication |
| `aafp-nat` | `src/*.rs` inline | Relay, AutoNAT, DCuTR hole punching |
| `aafp-sdk` | `src/*.rs` inline | AgentBuilder, server, client, metrics |
| `aafp-transport-quic` | `src/*.rs` inline | QUIC config, connection, TLS binding |
| `aafp-transport-mcp` | `src/*.rs` + `tests/` | MCP transport binding, rmcp trait |
| `aafp-transport-a2a` | `src/*.rs` inline | A2A transport binding |
| `aafp-conformance` | `src/*.rs` (all tests) | RFC conformance (see §5) |
| `aafp-benchmark` | `benches/*.rs` | Criterion benchmarks (not tests) |
| `aafp-tests` | `tests/*.rs` | Cross-crate integration (see §4) |
| `aafp-loadtest` | `src/*.rs` + `bin/` | Load test harness (see §8) |
| `aafp-cli` | `src/*.rs` inline | CLI argument parsing, commands |
| `aafp-py` | `tests/test_*.py` | Python interop (standalone crate) |

### 3.3 Running Unit Tests

```bash
# All workspace crates
cargo test --workspace

# Single crate
cargo test -p aafp-cbor
cargo test -p aafp-crypto
cargo test -p aafp-conformance

# Single test
cargo test -p aafp-cbor -- test_r2_080_deterministic_encoding

# With output visible
cargo test --workspace -- --nocapture

# Parallel execution (default: all cores)
cargo test --workspace -- --test-threads=8
```

### 3.4 Test Conventions

- **Test naming:** `test_<requirement_id>_<description>` for conformance
  tests (e.g., `test_r2_001_header_size_is_28_bytes`). For unit tests,
  `test_<function>_<scenario>` (e.g., `test_encode_small_integer`).
- **Assertions:** Use `assert!`, `assert_eq!`, and `assert_ne!` with
  descriptive failure messages. Every assertion includes the RFC section
  in its message for traceability.
- **Async tests:** Use `#[tokio::test]` for async functions. The runtime
  is single-threaded by default (`current_thread`) to avoid flaky tests.
- **Ignored tests:** 7 tests are `#[ignore]` — these are long-running
  tests (e.g., 100K-iteration property tests) that run explicitly via
  `cargo test -- --ignored`.

---

## 4. Layer 2 — Integration Testing

### 4.1 Cross-Crate Integration (`aafp-tests`)

The `aafp-tests` crate contains black-box integration tests that exercise
multiple crates together. These tests live in `tests/` as separate files,
each focusing on a specific integration scenario:

| Test file | What it tests |
|-----------|---------------|
| `integration.rs` | End-to-end: AgentBuilder → QUIC → handshake → RPC |
| `go_interop.rs` | Spawns Go fixture generator, verifies in Rust |
| `wan_simulation.rs` | Simulated latency, packet loss, congestion control |
| `wan_test.rs` | Multi-hop WAN routing, connection migration |
| `multi_node_dht.rs` | 3+ agent DHT discovery, announce/lookup |
| `nat_traversal.rs` | Relay forwarding, AutoNAT dial-back, DCuTR |
| `nat_performance.rs` | NAT traversal under load |
| `stress_tests.rs` | Burst traffic, large messages, connection churn |
| `resource_exhaustion.rs` | DoS: connection flood, stream exhaustion, slow loris |
| `timing_analysis.rs` | Timing side-channel measurement |
| `malformed_input.rs` | Malformed frames, CBOR injection, truncated data |
| `adversarial_handshake.rs` | Handshake attacks: downgrade, replay, MITM |
| `trust_scenarios.rs` | TrustManager: TOFU, CA-signed, key rotation |
| `gap_*.rs` | Feature gap tests (browser, chains, code exec, etc.) |

### 4.2 Cross-Language Integration

AAFP has four implementations that must interoperate:

```
Rust (reference) ←→ Go (wire-format library)
Rust (reference) ←→ TypeScript (SDK)
Rust (reference) ←→ Python (PyO3 adapter)
Go (wire-format)  ←→ TypeScript (via shared test vectors)
```

**Rust ↔ Go interop** is the most mature. The `go_interop.rs` test spawns
the Go fixture generator as a subprocess:

```
go run ./cmd/generate_interop_fixtures <output_dir>
```

The Go generator produces binary fixtures using fixed (non-random) inputs
that both implementations can reproduce from the RFCs alone. The Rust test
then:
1. Reads each binary fixture
2. Decodes it using Rust's CBOR/frame/handshake decoders
3. Re-encodes the decoded value
4. Asserts byte-for-byte equality with the original fixture

This proves bidirectional wire-format compatibility at Level 2 (frame-level).
Level 1 (live QUIC interop) is not yet possible because the Go implementation
does not have a QUIC transport layer — it is a wire-format library focused
on protocol correctness.

**Rust ↔ Python interop** is tested via the `aafp-py` crate's Python test
suite (`tests/test_*.py`). These tests exercise the PyO3 adapter that
exposes AAFP's Rust core to Python, including MCP SDK interop.

**Rust ↔ TypeScript interop** is scaffolded but not yet fully implemented.
The TypeScript test suite (`implementations/typescript/test/`) includes
conformance test stubs that mirror the Rust conformance crate
module-for-module, preserving RFC requirement IDs for side-by-side audit.

### 4.3 WAN Simulation

Since QUIC runs over UDP and tools like toxiproxy only support TCP, the
WAN simulation tests inject artificial delays and simulated packet loss
in the echo server loop. This provides a controlled, reproducible
environment for measuring AAFP behavior under adverse network conditions:

- **O2:** Latency and throughput across message sizes (64B–64KB)
- **O3:** Packet loss (1%, 5%) and high-latency (200ms, 500ms RTT)
- **O4:** BBR vs Cubic vs NewReno congestion control
- **O5:** Cross-network interop (A2A over simulated WAN)
- **O6:** Connection migration (multiple localhost addresses)
- **O7:** Multi-node DHT discovery (3 agents on different ports)

### 4.4 Running Integration Tests

```bash
# All integration tests
cargo test -p aafp-tests

# Go interop (requires Go installed)
cargo test -p aafp-tests --test go_interop

# WAN simulation
cargo test -p aafp-tests --test wan_simulation

# Stress tests (longer running)
cargo test -p aafp-tests --test stress_tests -- --nocapture
```

---

## 5. Layer 3 — Conformance Testing

### 5.1 The `aafp-conformance` Crate

The conformance crate is the heart of AAFP's RFC compliance verification.
It contains 568 test functions across 11,790 lines of code, organized by
RFC section and normative requirement. Every test is tagged with its
source RFC section and requirement ID.

The crate's module organization maps directly to the RFCs:

| Module | RFC | Coverage |
|--------|-----|----------|
| `rfc0002.rs` | RFC-0002: Transport & Framing | Frame header, frame types, handshake, CBOR |
| `rfc0003.rs` | RFC-0003: Identity & Authentication | AgentId, AgentRecord, capabilities |
| `rfc0004.rs` | RFC-0004: Discovery | Bootstrap, DHT, announce/lookup |
| `rfc0005.rs` | RFC-0005: Error Model | Error codes, categories, fatal errors |
| `handshake_state_machine.rs` | RFC-0002 §5.10 (A-6) | Client/server handshake sub-states |
| `close_conformance.rs` | RFC-0002 §6.6 (A-8) | CLOSE frame state machine |
| `replay_conformance.rs` | RFC-0002 §6.7 (A-9) | Nonce replay detection |
| `pipeline_order.rs` | RFC-0002 §6.5 (A-7) | 20-phase frame processing pipeline |
| `version_negotiation.rs` | Version negotiation matrix | Version rejection, downgrade prevention |
| `protocol_compliance.rs` | Cross-cutting | Identity, handshake, session, authorization |
| `negative.rs` | All RFCs | Malformed/adversarial input rejection |
| `adversarial.rs` | All RFCs | Parser edge cases, state machine attacks |
| `test_vectors.rs` | All RFCs | Deterministic wire-format test vectors |
| `handshake_vectors.rs` | RFC-0002 §5 | Canonical handshake transcript vectors |
| `mldsa_cross_matrix.rs` | A-10 | ML-DSA-65 cross-verification matrix |
| `mldsa_cross_verify.rs` | A-10 | Go-produced vectors verified in Rust |
| `mldsa_differential.rs` | A-10 | Differential testing (Rust vs Go signatures) |
| `mldsa_property.rs` | A-10 | Property-based ML-DSA-65 testing |
| `mldsa_rfc_verify.rs` | A-10 | RFC/FIPS 204 test vector verification |
| `mldsa_negative.rs` | A-10 | Negative ML-DSA-65 tests |
| `close_differential.rs` | A-8 | Differential close state machine testing |
| `close_adversarial.rs` | A-8 | Adversarial close scenarios |
| `close_property.rs` | A-8 | Property-based close testing |
| `close_resources.rs` | A-8 | Close resource cleanup verification |
| `replay_differential.rs` | A-9 | Differential replay cache testing |
| `replay_stress.rs` | A-9 | Replay cache under heavy load (100K nonces) |
| `pipeline_adversarial.rs` | A-7 | Adversarial pipeline attacks |

### 5.2 Requirement ID Convention

Every conformance test is named with a traceable requirement ID:

- **`R2-001`** — RFC-0002, requirement 001
- **`R3-015`** — RFC-0003, requirement 015
- **`R5-003`** — RFC-0005, requirement 003
- **`R4-010`** — Revision 4 amendment (SA-0002), requirement 010
- **`R5-001`** — Revision 5 amendment (SA-0003), requirement 001

This convention allows any test failure to be traced directly to the RFC
section and normative requirement that was violated. The requirement IDs
are stable across implementations — the Go and TypeScript conformance
suites use the same IDs.

### 5.3 Conformance Test Categories

#### 5.3.1 Positive Conformance Tests

Verify that valid inputs produce correct outputs. Example from
`rfc0002.rs`:

```rust
/// R2-001: Frame header MUST be 28 bytes.
#[test]
fn test_r2_001_header_size_is_28_bytes() {
    assert_eq!(FRAME_HEADER_SIZE, 28, "RFC-0002 §3: header must be 28 bytes");
}
```

#### 5.3.2 Negative Conformance Tests

Verify that invalid inputs are correctly rejected. The `negative.rs` module
contains 710 lines of tests covering:

- Non-canonical CBOR encoding (non-shortest integers, duplicate keys,
  indefinite-length)
- Invalid frame headers (truncated, oversized, wrong version)
- Invalid signatures (tampered, wrong key, expired)
- Invalid handshake messages (bad version, expired identity, wrong algorithm)
- Invalid AgentRecords (bad agent_id, wrong record_type, expired)

Example:

```rust
/// N-CBOR-001: Non-shortest integer encoding (value 5 as 0x18 0x05)
/// MUST be rejected.
#[test]
fn test_ncbor_001_reject_non_shortest_uint_one_byte() {
    let bad = vec![0x18, 0x05];
    assert!(decode(&bad).is_err(),
        "non-canonical uint 5 as 0x1805 must be rejected");
}
```

#### 5.3.3 Adversarial Tests

The `adversarial.rs` module (700 lines) targets parser and state-machine
edge cases:

- Truncated frames (0 to 27 bytes)
- Oversized length prefixes (claiming 1GB payload)
- Duplicate extension fields
- Invalid state transitions
- Replayed handshake messages
- Unknown mandatory extensions
- Version downgrade attempts

#### 5.3.4 State Machine Conformance

The `handshake_state_machine.rs` module (994 lines) verifies the normative
handshake state machine from RFC-0002 §5.10 (Rev 6 A-6):

- Client state enumeration (9 states: C_IDLE through C_CLOSED)
- Server state enumeration (9 states: S_LISTENING through S_CLOSED)
- Forward transition tables (client and server)
- Illegal transition rejection
- Graceful shutdown from any active state
- Abort from any non-terminal state
- Unexpected frame handling (§5.10.7)
- Duplicate handshake message detection (§5.10.6)
- Timeout enforcement (§5.10.8)
- Close behavior (§5.10.9)
- State-to-session mapping (§5.10.11)

#### 5.3.5 Pipeline Order Conformance

The `pipeline_order.rs` module (824 lines) verifies the 20-phase frame
processing pipeline from RFC-0002 §6.5 (A-7):

- Each phase is executed in order
- Failure at any phase produces the correct error code
- Extension callbacks are NEVER invoked before Phase 18
- The callback count is zero for all failures in Phases 1–17

This is a critical security invariant: extension processing must not occur
before authentication is complete.

### 5.4 Running Conformance Tests

```bash
# All conformance tests
cargo test -p aafp-conformance

# By RFC
cargo test -p aafp-conformance -- rfc0002
cargo test -p aafp-conformance -- rfc0003
cargo test -p aafp-conformance -- rfc0005

# By feature (A-6 through A-10)
cargo test -p aafp-conformance -- handshake_state_machine
cargo test -p aafp-conformance -- close_conformance
cargo test -p aafp-conformance -- replay_conformance
cargo test -p aafp-conformance -- pipeline_order
cargo test -p aafp-conformance -- mldsa

# Generate golden traces
cargo run -p aafp-conformance --bin generate_golden_traces
cargo run -p aafp-conformance --bin generate_vectors
cargo run -p aafp-conformance --bin generate_traces
cargo run -p aafp-conformance --bin generate_interop_fixtures
cargo run -p aafp-conformance --bin generate_pipeline_vectors
```

---

## 6. Golden Trace Testing

### 6.1 Concept

Golden traces are canonical byte sequences for AAFP v1 protocol messages.
They are **normative conformance vectors** — an independent implementation
must produce and accept these exact byte sequences. If an implementation
produces different bytes, it is non-conformant.

The golden trace generation binary (`generate_golden_traces.rs`) produces
traces using:

- Fixed ML-DSA-65 keypairs (deterministic, generated from fixed seeds)
- Fixed TLS channel binding (`[0x42; 32]`)
- Fixed client nonce (`[0xAA; 32]`) and server nonce (`[0xBB; 32]`)
- Fixed timestamp (`1700000000`)

This ensures traces are fully reproducible from the RFCs alone, without
access to the Rust implementation's source code.

### 6.2 Trace Format

Each trace is a JSON file with:

```json
{
  "name": "handshake_full_v1",
  "rfc_section": "RFC-0002 §5",
  "frames": [
    { "type": "ClientHello", "hex": "...", "direction": "C→S" },
    { "type": "ServerHello", "hex": "...", "direction": "S→C" },
    { "type": "ClientFinished", "hex": "...", "direction": "C→S" }
  ],
  "transcript_hash_final": "...",
  "session_id": "..."
}
```

### 6.3 Byte-Exact Wire Compatibility

The golden trace verification rule is strict:

> **If a TS/Go/Python test diverges from a golden trace, the non-Rust
> implementation is wrong. The Rust reference is the source of truth.
> Never edit a golden trace to make a test pass; file a bug against the
> diverging implementation instead.**

This rule ensures that all implementations converge on a single canonical
wire format. The verification process is:

1. Read the golden trace file
2. Decode each frame using the implementation's decoder
3. Re-encode the decoded frame
4. Assert byte-for-byte equality with the original trace bytes
5. Verify transcript hash checkpoints match
6. Verify session_id derivation matches

### 6.4 Trace Coverage

| Trace | RFC | What it covers |
|-------|-----|----------------|
| `handshake_full_v1` | RFC-0002 §5 | Full 3-way handshake (ClientHello, ServerHello, ClientFinished) |
| `rpc_echo` | RFC-0002 §4 | RPC request + response round-trip |
| `streaming` | RFC-0002 §4 | Multi-frame streaming with tokens |
| `close` | RFC-0002 §6.6 | CLOSE frame encoding |
| `error` | RFC-0005 | ERROR frame with code and message |
| `agent_record` | RFC-0003 §3 | Signed AgentRecord CBOR |
| `discovery_announce` | RFC-0004 §3 | Announce RPC with AgentRecord |
| `discovery_lookup` | RFC-0004 §4 | Lookup RPC with capability filter |

### 6.5 Cross-Implementation Trace Verification

The Go implementation includes a `goldentrace` package that reads the
Rust-generated golden traces and verifies them using Go's CBOR/frame
decoders. The TypeScript SDK includes test stubs
(`test/golden-trace.test.ts`) that will perform the same verification
once the SDK is fully implemented.

The `verify_go_fixtures.rs` binary in the conformance crate performs the
reverse check: it reads Go-produced fixtures and verifies them in Rust.

---

## 7. Cross-Language Interop: The A-10 Matrix

### 7.1 The Four-Language Matrix

AAFP's interop goal is a full cross-verification matrix across four
implementations:

| | Rust verifies | Go verifies | TS verifies | Python verifies |
|---|---|---|---|---|
| **Rust signs** | ✅ Baseline | ✅ 19/19 | TODO | TODO |
| **Go signs** | ✅ 15/15 | ✅ Baseline | TODO | TODO |
| **TS signs** | TODO | TODO | TODO | TODO |
| **Python signs** | TODO | TODO | TODO | TODO |

Currently, the Rust ↔ Go matrix is complete for ML-DSA-65:

- **Rust→Rust:** Sign in Rust, verify in Rust (baseline)
- **Rust→Go:** Sign in Rust, export to JSON, verify in Go (19/19 vectors)
- **Go→Rust:** Sign in Go, export to JSON, verify in Rust (15/15 vectors)
- **Go→Go:** Sign in Go, verify in Go (baseline, in Go tests)
- **Differential traces:** 100/100 diff traces cross-verify

### 7.2 ML-DSA-65 Cross-Verification

The `mldsa_cross_matrix.rs` module implements the 4-combination matrix
using shared JSON test vectors as the cross-language bridge. Test vectors
are stored in `test-vectors/mldsa65/`:

- `vectors.json` — Rust-generated vectors (19 vectors)
- `go_vectors.json` — Go-generated vectors (15 vectors)
- `diff_traces.json` — Rust differential traces (100 traces)
- `go_diff_traces.json` — Go differential traces (100 traces)

Each vector contains: `id`, `seed`, `message_hex`, `public_key_hex`,
`secret_key_hex`, `signature_hex`, `expected_verify`, `description`.

The Rust implementation provides `MlDsa65::keypair_from_seed()` and
`MlDsa65::sign_deterministic()` for FIPS 204 deterministic test vector
generation. The Go implementation uses
`github.com/KarpelesLab/mldsa` v0.2.0. Both produce identical keys from
the same seed and identical deterministic signatures.

### 7.3 Property-Based ML-DSA-65 Testing

The `mldsa_property.rs` module (221 lines) verifies the core property:
`sign(message) → verify(message)` always succeeds, and mutating any
component causes verification to fail. Uses a deterministic PRNG
(xorshift64*) for reproducibility with 1,000 iterations (100K would be
too slow for ML-DSA-65).

### 7.4 Interop Levels

AAFP defines three interop levels:

| Level | Description | Status (Rust↔Go) |
|-------|-------------|-------------------|
| Level 1 | Full live QUIC interop | Not yet (Go lacks QUIC transport) |
| Level 2 | Frame-level interop (encode/decode) | ✅ 39 fixtures, 48 vector tests |
| Level 3 | CBOR-level interop | ✅ 16 type fixtures, 134 cross-verifications |

Level 1 requires both implementations to have a QUIC transport layer.
The Go implementation is currently a wire-format library; adding QUIC
transport is a roadmap item (v1.1, B-2).

---

## 8. Layer 4 — Load Testing

### 8.1 The `aafp-loadtest` Crate

The load test harness creates N agents, starts a server task on each,
connects them according to a configured topology, sends messages, and
collects metrics. The architecture:

```
For each agent i:
  ┌─ Server task: accept connections, handshake, echo DATA frames
  └─ Client tasks (per edge): connect to peer, handshake, send M messages

Metrics collected via ResultsAccumulator (lock-free atomics + Mutex<Vec>)
```

### 8.2 Configuration

`LoadTestConfig` controls:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `num_agents` | 10 | Number of agents to create |
| `messages_per_agent` | 100 | Messages per edge |
| `message_size` | 1024 | Payload size in bytes |
| `duration` | 60s | Maximum test duration |
| `topology` | Mesh | Network topology |
| `max_connections_per_agent` | 10 | Cap for mesh topology |
| `random_degree` | 5 | Peers per agent (Random topology) |
| `concurrency` | 8 | In-flight messages per agent |

Preset configurations:
- **`smoke()`**: 10 agents, 10 messages, 256B, 30s — quick verification
- **`default()`**: 10 agents, 100 messages, 1KB, 60s — standard test
- **`large()`**: 100 agents, 1000 messages, 4KB, 5min — stress test

### 8.3 Topologies

| Topology | Edges | Description |
|----------|-------|-------------|
| Mesh | N × min(max, N-1) | Every agent connects to every other (capped) |
| Star | N-1 | All agents connect to a single hub |
| Ring | N | Each agent connects to its neighbor |
| Random | N × degree | Each agent connects to K random peers |

### 8.4 Load Test Targets

The production load test targets are:

| Metric | Target | Current |
|--------|--------|---------|
| Concurrent connections | 10,000 | 100 (tested) |
| RPC throughput | 100,000 RPC/s | 1.25M msg/s (echo, localhost) |
| Round-trip latency (P50) | <10ms | 41.47µs (localhost) |
| Round-trip latency (P99) | <50ms | TBD (WAN simulation) |
| Connection setup time | <500ms | <1ms (handshake: 709µs) |
| Memory per connection | <100KB | 168 bytes (Session struct) |
| Sustained throughput (1hr) | No degradation | TBD |

The 10K concurrent connections target requires kernel tuning (ulimit,
SO_REUSEPORT) and is tested on Linux with elevated file descriptor
limits. The 100K RPC/s target is achievable on a single machine with
the current 1.25M msg/s echo throughput.

### 8.5 Metrics Collection

`LoadTestMetrics` captures:

- Total messages sent/received/dropped
- Throughput (messages/sec, bytes/sec)
- Latency histogram (P50, P90, P99, P99.9, max)
- Error rate and error breakdown
- Connection setup time
- Handshake success/failure count
- Memory usage (peak, per-connection)
- CPU usage

### 8.6 Running Load Tests

```bash
# Smoke test (10 agents, 10 messages, ~30s)
cargo run -p aafp-loadtest --bin loadtest -- --agents 10 --messages 10

# Standard test (10 agents, 100 messages, 1KB, 60s)
cargo run -p aafp-loadtest --bin loadtest

# Large test (100 agents, 1000 messages, 4KB, 5min)
cargo run -p aafp-loadtest --bin loadtest -- --agents 100 --messages 1000 --size 4096 --duration 300

# Star topology
cargo run -p aafp-loadtest --bin loadtest -- --topology star --agents 50
```

---

## 9. Layer 5 — Chaos Testing

### 9.1 Philosophy

Chaos testing verifies that the system maintains correctness and eventually
recovers from realistic failure modes. Unlike load testing (which tests
the happy path under stress), chaos testing actively injects failures:

- Network partitions (split-brain, partial connectivity)
- Agent crashes (process kill, OOM kill)
- Relay failures (relay node goes down mid-session)
- Byzantine agents (malicious protocol behavior)
- Clock skew (agents with divergent clocks)
- Disk failures (KeyDirectory SQLite corruption)
- TLS certificate expiry mid-session

### 9.2 Chaos Test Scenarios

#### 9.2.1 Network Partition

```
Agents A, B, C connected in a mesh.
Partition: A ←✕→ B (A and B cannot reach each other)
Expected: A and B maintain sessions with C. DHT routes around partition.
           A's lookup for B's capability returns results from C's cache.
Recovery: Partition heals. A and B re-establish direct connection.
```

#### 9.2.2 Agent Crash

```
Agents A, B, C in a DHT ring.
Crash: Kill agent B (process kill -9).
Expected: A and C detect B's departure via DHT churn protocol.
           B's records are re-replicated to other nodes (k=5).
           No data loss; lookups still succeed.
Recovery: B restarts, re-announces, rejoins DHT.
```

#### 9.2.3 Relay Failure

```
Agent A behind NAT, relayed through relay R to agent B.
Failure: Relay R crashes.
Expected: A detects relay failure, initiates AutoNAT dial-back or
           DCuTR hole punching. Session with B is re-established
           through a new relay or direct connection.
Recovery: R restarts (or backup relay R' is used).
```

#### 9.2.4 Byzantine Agent

```
Agent A sends malformed frames, replayed nonces, and invalid signatures.
Expected: Server rejects all malicious frames with correct error codes.
           Replay cache detects nonce reuse. Rate limiting kicks in.
           A is eventually banned (per-IP handshake rate limit: 10/sec).
```

### 9.3 Chaos Test Infrastructure

Chaos tests require a multi-process test harness that can:

1. Spawn and kill agent processes
2. Inject network partitions (via iptables or network namespaces)
3. Simulate clock skew (via `libfaketime` or process-level clock injection)
4. Monitor system state and verify invariants
5. Drive recovery and verify convergence

The `aafp-tests` crate's `nat_traversal.rs` and `wan_simulation.rs` are
stepping stones toward full chaos testing. The complete chaos harness is
a roadmap item that will use Docker containers for process isolation and
network namespace manipulation for partition injection.

### 9.4 Chaos Invariants

During and after any chaos event, these invariants must hold:

1. **No data corruption:** Messages that are delivered must be intact
   (AEAD authentication guarantees this at the protocol level).
2. **No nonce reuse:** The ReplayCache must never accept a replayed nonce,
   even under partition or crash.
3. **Eventual consistency:** The DHT must converge to a consistent state
   after any number of agent departures, as long as k=5 replicas remain.
4. **No authentication bypass:** The handshake state machine must never
   reach Messaging state without a valid signature verification.
5. **Resource cleanup:** Crashed agents must not leak resources on
   peers (connections must timeout, sessions must close).

---

## 10. Property-Based Testing

### 10.1 Approach

Property-based testing verifies that certain invariants hold for all
inputs in a given input space, rather than testing specific examples.
AAFP uses property-based testing for:

- **CBOR encoding:** `encode(decode(x)) == x` for all valid CBOR
- **Crypto:** `verify(sign(msg, sk), pk, msg) == true` for all keys/messages
- **Frame encoding:** `decode(encode(f)) == f` for all valid frames
- **Replay cache:** `check_and_insert(aid, n)` succeeds exactly once per
  `(aid, n)` pair
- **Close state machine:** All reachable states satisfy the invariants
  (no backward transitions, Closed is terminal)

### 10.2 Implementation

AAFP uses a custom deterministic PRNG (xorshift64*) rather than an
external proptest framework, to avoid adding dependencies and to ensure
full reproducibility. The `mldsa_property.rs` module demonstrates this
approach:

```rust
struct Prng { state: u64 }

impl Prng {
    fn new(seed: u64) -> Self { Self { state: seed } }
    fn next_u64(&mut self) -> u64 { /* xorshift64* */ }
    fn fill_bytes(&mut self, buf: &mut [u8]) { /* ... */ }
    fn next_vec(&mut self, len: usize) -> Vec<u8> { /* ... */ }
}

#[test]
fn test_property_sign_verify_always_succeeds() {
    let mut prng = Prng::new(0x1234567890ABCDEF);
    let iterations = 1000;
    for i in 0..iterations {
        let mut seed = [0u8; 32];
        prng.fill_bytes(&mut seed);
        let (pk, sk) = MlDsa65::keypair_from_seed(&seed);
        let msg = prng.next_vec((prng.next_u64() % 256) as usize);
        let sig = MlDsa65::sign_deterministic(&sk, &msg);
        assert!(MlDsa65::verify(&pk, &msg, &sig),
            "sign→verify must always succeed (iteration {})", i);
    }
}
```

### 10.3 Property Test Coverage

| Property | Module | Iterations | What it verifies |
|----------|--------|------------|------------------|
| sign→verify | `mldsa_property.rs` | 1,000 | ML-DSA-65 correctness |
| Mutate signature → verify fails | `mldsa_property.rs` | 1,000 | Tamper detection |
| Mutate message → verify fails | `mldsa_property.rs` | 1,000 | Message integrity |
| Mutate public key → verify fails | `mldsa_property.rs` | 1,000 | Key binding |
| CBOR round-trip | `aafp-cbor` unit tests | N/A | encode(decode(x)) == x |
| Frame round-trip | `aafp-messaging` unit tests | N/A | decode(encode(f)) == f |
| Close state invariants | `close_property.rs` | N/A | State machine properties |

### 10.4 Future: proptest Integration

The project should add `proptest` as a dev-dependency for more
sophisticated property-based testing, including shrinking (finding the
minimal failing case). The current custom PRNG approach works but does
not shrink failures automatically. Recommended proptest targets:

- CBOR encoder: arbitrary `Value` → encode → decode → compare
- Frame encoder: arbitrary `Frame` → encode → decode → compare
- Handshake transcript: arbitrary message orderings → transcript hash
- Replay cache: concurrent insertions from multiple threads

---

## 11. Fuzzing

### 11.1 Fuzz Targets

AAFP has 8 fuzz targets in `implementations/rust/fuzz/fuzz_targets/`,
using `cargo-fuzz` with `libfuzzer-sys`:

| Target | What it fuzzes | Invariant |
|--------|---------------|-----------|
| `fuzz_cbor_decode.rs` | CBOR decoder | Never panics on any input |
| `fuzz_frame_decode.rs` | Frame decoder | Never panics on any input |
| `fuzz_handshake_cbor.rs` | Handshake CBOR decoder | Never panics, rejects invalid |
| `fuzz_rpc_decode.rs` | RPC message decoder | Never panics on any input |
| `fuzz_agent_record_cbor.rs` | AgentRecord CBOR decoder | Never panics, rejects invalid |
| `fuzz_relay_request.rs` | Relay request decoder | Never panics on any input |
| `fuzz_discovery_request.rs` | Discovery request decoder | Never panics on any input |
| `fuzz_dht_router.rs` | DHT routing logic | Never panics on any input |

### 11.2 Fuzz Target Structure

Each fuzz target is minimal — it feeds arbitrary bytes into a decoder
and asserts that the decoder returns an error rather than panicking:

```rust
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // The CBOR decoder must never panic on any input.
    let _ = aafp_cbor::decode(data);
});
```

The invariant is simple but powerful: **no untrusted input should ever
cause a panic, crash, or undefined behavior.** Every parse error must be
a `Result::Err`, not a panic.

### 11.3 Running Fuzz Tests

```bash
# Install cargo-fuzz (requires nightly)
cargo install cargo-fuzz

# Run a fuzz target (default: until crash or Ctrl-C)
cargo +nightly fuzz run fuzz_cbor_decode

# Run with a time limit
cargo +nightly fuzz run fuzz_cbor_decode -- -max_total_time=300

# Run with a corpus directory
cargo +nightly fuzz run fuzz_cbor_decode -- -max_total_time=60 corpus/

# Minimize a crashing input
cargo +nightly fuzz run fuzz_cbor_decode -- -minimize_crash=1
```

### 11.4 Fuzz Strategy

The fuzzing strategy is layered:

1. **Smoke fuzzing** (CI): Run each target for 60 seconds on every PR.
   Catches obvious panics introduced by recent changes.
2. **Extended fuzzing** (Nightly): Run each target for 1 hour. Catches
   deeper bugs that require more exploration.
3. **Directed fuzzing** (Release): Run for 24+ hours before each release.
   Uses seed corpus from conformance test vectors to guide exploration.
4. **Differential fuzzing** (A-10): Feed the same input into Rust and Go
   decoders, compare outputs. Catches semantic divergences.

### 11.5 Seed Corpus

Each fuzz target should have a seed corpus derived from:

- Conformance test vectors (valid inputs)
- Negative test cases (invalid inputs that should be rejected)
- Golden trace bytes (known-good wire format)
- Edge cases from property tests (empty maps, max-length strings, etc.)

A seed corpus dramatically improves fuzzing efficiency by guiding the
fuzzer toward interesting input regions.

---

## 12. Mutation Testing

### 12.1 Purpose

Mutation testing verifies test quality by injecting small changes
(mutations) into the source code and checking whether the test suite
catches them. If a mutation is not caught, either the test suite has a
gap or the mutated code path is not exercised.

AAFP uses `cargo-mutants` for mutation testing of the Rust workspace.

### 12.2 Mutation Operators

`cargo-mutants` applies several mutation operators:

| Operator | Example | What it tests |
|----------|---------|---------------|
| Replace `==` with `!=` | `if a == b` → `if a != b` | Equality test coverage |
| Replace `>` with `<` | `if a > b` → `if a < b` | Comparison test coverage |
| Replace `+` with `-` | `a + b` → `a - b` | Arithmetic test coverage |
| Replace `true` with `false` | `return true` → `return false` | Boolean logic coverage |
| Delete statement | `assert!(check())` → removed | Assertion coverage |
| Replace `Ok(x)` with `Err` | `Ok(val)` → `Err(...)` | Error path coverage |

### 12.3 Running Mutation Tests

```bash
# Install cargo-mutants
cargo install cargo-mutants

# Run mutation testing on a single crate
cargo mutants -p aafp-cbor

# Run on the conformance crate (most important)
cargo mutants -p aafp-conformance

# Run on the crypto crate (security-critical)
cargo mutants -p aafp-crypto

# Run on the entire workspace (slow — hours)
cargo mutants --workspace

# Run with a timeout per mutant
cargo mutants -p aafp-cbor --timeout 30
```

### 12.4 Mutation Testing Goals

| Crate | Priority | Rationale |
|-------|----------|-----------|
| `aafp-cbor` | High | Canonical encoding is wire-format critical |
| `aafp-crypto` | Critical | Signature verification, AEAD, replay detection |
| `aafp-messaging` | High | Frame encoding, close state machine, pipeline |
| `aafp-identity` | High | AgentId derivation, AgentRecord verification |
| `aafp-core` | Medium | Session state machine, authorization |
| `aafp-discovery` | Medium | DHT routing, record replication |
| `aafp-conformance` | Low | Tests testing tests (meta) |
| `aafp-sdk` | Medium | High-level API, connection management |

### 12.5 Interpreting Results

A mutation is either:
- **Caught:** The test suite fails after the mutation (good — tests are
  effective).
- **Survived:** The test suite still passes after the mutation (bad —
  either the code path is untested or the tests are insufficient).
- **Timeout:** The mutation causes an infinite loop or hang (investigate).

Survived mutations indicate test gaps. For each survived mutation:

1. Determine which code path was mutated
2. Identify which test should have caught it
3. Add a test that exercises the mutated code path
4. Re-run mutation testing to confirm the new test catches the mutation

### 12.6 CI Integration

Mutation testing is too slow for per-PR execution (it runs the full test
suite once per mutation, and there are hundreds of mutations). Instead:

- **Nightly CI:** Run `cargo mutants` on the high-priority crates
  (`aafp-cbor`, `aafp-crypto`, `aafp-messaging`) with a 30s timeout per
  mutant.
- **Release gate:** Run `cargo mutants --workspace` before each release.
  No survived mutations in critical crates.
- **On-demand:** Developers can run mutation testing locally when adding
  new security-critical code.

---

## 13. Test Infrastructure & CI

### 13.1 CI Workflows

AAFP has four GitHub Actions workflows:

| Workflow | File | Trigger | What it does |
|----------|------|---------|--------------|
| Rust CI | `.github/workflows/rust-ci.yml` | Push/PR | fmt, clippy, build, test (matrix: ubuntu + macos) |
| Go CI | `.github/workflows/go-ci.yml` | Push/PR | gofmt, go vet, go test |
| TS CI | `.github/workflows/ts-ci.yml` | Push/PR | tsc, vitest |
| Benchmark | `.github/workflows/benchmark.yml` | Push to master | Criterion benchmarks, regression detection |

### 13.2 Rust CI Matrix

The Rust CI workflow runs on a matrix of `ubuntu-latest` and
`macos-latest`, executing:

1. **Formatting:** `cargo fmt --all -- --check` (0 diffs expected)
2. **Clippy:** `cargo clippy --workspace -- -D warnings` (0 warnings)
3. **Build:** `cargo build --workspace --verbose`
4. **Test:** `cargo test --workspace --verbose` (timeout: 15 minutes)

Cargo cache is keyed on `Cargo.lock` hash to speed up subsequent runs.

### 13.3 Parallel Test Execution

Rust's test runner parallelizes tests by default across all CPU cores.
The conformance crate's 568 tests complete in under 60 seconds on an
M3 Pro (12 cores). Tests that share state (e.g., port binding) use
`#[serial]` or unique ports to avoid flakiness.

For CI, tests run on 2-core GitHub Actions runners, which is sufficient
for the current test count. For the 10K-connection load test, a
self-hosted runner with more cores and higher file descriptor limits
is required.

### 13.4 Test Result History

The `test-results/` directory stores structured JSON results from all
test suites, organized by category:

```
test-results/
├── README.md
├── run_all_tests.py          # Test runner that writes JSON results
├── generate_dashboard.py     # HTML dashboard generator
├── compare_benchmarks.py     # Benchmark regression detection
├── dashboards/
│   └── index.html            # Auto-generated dashboard
├── interop/                  # Interoperability results
│   ├── python-mcp-sdk.json
│   ├── a2a-reference.json
│   ├── rust-go-cross.json
│   └── mcp-conformance.json
├── performance/              # Benchmark results (Criterion)
│   ├── crypto.json
│   ├── framing.json
│   ├── transport.json
│   └── session.json
├── conformance/              # RFC conformance results
│   ├── rust-conformance.json
│   └── go-conformance.json
└── security/                 # Security test results
    └── timing-analysis.json
```

Every result file follows a standard JSON schema with:
- `test_name`, `test_category`, `timestamp`
- `environment` (OS, CPU, Rust/Go version, commit hash)
- `status` (pass/fail), `duration_ms`
- `details[]` with per-step status and timing

The `run_all_tests.py` script runs all test suites and writes results:

```bash
python3 test-results/run_all_tests.py              # run everything
python3 test-results/run_all_tests.py --rust-only   # only Rust tests
python3 test-results/run_all_tests.py --go-only     # only Go tests
python3 test-results/run_all_tests.py --interop     # only interop tests
python3 test-results/run_all_tests.py --perf        # only benchmarks

# Generate HTML dashboard
python3 test-results/generate_dashboard.py
```

### 13.5 Benchmark Regression Detection

The benchmark workflow runs Criterion benchmarks on every push to master,
uploads results as artifacts, and compares against the previous commit's
baseline using `compare_benchmarks.py`. A regression >10% triggers a
warning in the CI output.

Benchmarks cover:

| Benchmark | File | What it measures |
|-----------|------|------------------|
| `serialization` | `benches/serialization.rs` | CBOR encode/decode |
| `framing` | `benches/framing.rs` | Frame encode/decode |
| `handshake` | `benches/handshake.rs` | PQ handshake |
| `messaging` | `benches/messaging.rs` | RPC, streams |
| `discovery` | `benches/discovery.rs` | DHT operations |
| `session` | `benches/session.rs` | Session creation, memory |
| `mcp_transport` | `benches/mcp_transport.rs` | MCP round-trip |
| `close_manager` | `benches/close_manager.rs` | CLOSE state machine |
| `replay_cache` | `benches/replay_cache.rs` | Replay detection |
| `connection_lifecycle` | `benches/connection_lifecycle.rs` | Connect/disconnect |
| `lock_contention` | `benches/lock_contention.rs` | Concurrent access |
| `alloc_profile` | `benches/alloc_profile.rs` | Heap allocations |
| `quic_tuning` | `benches/quic_tuning.rs` | QUIC parameter tuning |
| `runtime_tuning` | `benches/runtime_tuning.rs` | Tokio runtime tuning |
| `timing_analysis` | `benches/timing_analysis.rs` | Side-channel analysis |

---

## 14. Conformance Certification Program

### 14.1 Overview

The "Certified AAFP Implementation" program provides a verifiable
attestation that an implementation conforms to the AAFP RFCs. Certification
is granted by running the official conformance test suite against the
implementation and achieving a passing result.

### 14.2 Certification Levels

| Level | Name | Requirements |
|-------|------|--------------|
| Level 1 | Wire-Format Conformant | All RFC-0002 (framing, CBOR, handshake) conformance tests pass |
| Level 2 | Protocol Conformant | All RFC-0002 through RFC-0005 conformance tests pass |
| Level 3 | Fully Conformant | All RFC-0001 through RFC-0011 conformance tests pass |
| Level 4 | Interop Certified | Level 3 + cross-language interop matrix (A-10) passes |
| Level 5 | Production Certified | Level 4 + load test (10K connections) + chaos test survival |

### 14.3 Certification Process

```
┌─────────────────────────────────────────────────────────┐
│  1. Implementation declares AAFP version (v1)           │
│  2. Run conformance test suite against implementation   │
│     (a) RFC-0002: Transport & Framing                   │
│     (b) RFC-0003: Identity & Authentication             │
│     (c) RFC-0004: Discovery                             │
│     (d) RFC-0005: Error Model                           │
│     (e) RFC-0006: Capability Negotiation                │
│     (f) RFC-0007–0011: Transport bindings, trust        │
│  3. Generate golden traces and verify byte-exact match  │
│  4. Run cross-language interop matrix (A-10)            │
│  5. Run load test (10K connections, 100K RPC/s)         │
│  6. Run chaos test suite (partitions, crashes, relays)  │
│  7. Submit results to AAFP conformance registry         │
│  8. Receive certification badge with version + date     │
└─────────────────────────────────────────────────────────┘
```

### 14.4 Conformance Test Suite Distribution

The official conformance test suite is the `aafp-conformance` crate.
Implementations can run it in two ways:

**Option A: Rust integration (for Rust-based implementations)**
Add `aafp-conformance` as a dev-dependency and run the tests directly:
```toml
[dev-dependencies]
aafp-conformance = { path = "../aafp-conformance" }
```

**Option B: Golden trace verification (for non-Rust implementations)**
Generate golden traces using the Rust reference implementation, then
verify that the candidate implementation produces and accepts the same
byte sequences:
```bash
# Generate traces from Rust reference
cargo run -p aafp-conformance --bin generate_golden_traces > traces.json

# Verify traces in candidate implementation
# (implementation-specific: Go, TypeScript, Python)
```

### 14.5 Certification Requirements by RFC

| RFC | Level | Tests | Key Requirements |
|-----|-------|-------|------------------|
| RFC-0002 §3 | 1 | R2-001 to R2-010 | Frame header: 28 bytes, field offsets, max payload |
| RFC-0002 §4 | 1 | R2-015 to R2-026 | Frame types: DATA(0x01) through PONG(0x08), critical bit |
| RFC-0002 §5 | 1 | R2-040 to R2-065 | Handshake: transcript hash, signatures, domain separator |
| RFC-0002 §5.10 | 2 | R2-100+ | Handshake state machine (A-6): 9+9 states, transitions |
| RFC-0002 §6.5 | 2 | Pipeline tests | 20-phase processing pipeline (A-7): extension order |
| RFC-0002 §6.6 | 2 | R2-300+ | CLOSE state machine (A-8): 5 states, timeout, disposition |
| RFC-0002 §6.7 | 2 | R2-400+ | Replay cache (A-9): (agent_id, nonce) key, eviction |
| RFC-0002 §8 | 1 | R2-080 to R2-084 | Canonical CBOR: deterministic, shortest, no indefinite |
| RFC-0003 §2 | 1 | R3-001 to R3-004 | AgentId: SHA-256(pubkey), 32 bytes, fingerprint format |
| RFC-0003 §3 | 1 | R3-010 to R3-020 | AgentRecord: CBOR schema, signature, expiry, domain sep |
| RFC-0003 §4 | 1 | R3-025 to R3-026 | CapabilityDescriptor: integer keys, string-keyed metadata |
| RFC-0004 §3 | 2 | R4-001+ | Discovery: announce/lookup methods, rate limits |
| RFC-0004 §4 | 2 | R4-010+ | DHT: routing, replication, churn |
| RFC-0005 §2 | 2 | R5-001 to R5-010 | Error model: 8 categories, code ranges |
| RFC-0005 §4 | 2 | R5-020+ | Error frame: wire format, fatal error rules |

### 14.6 Certification Registry

Certified implementations are listed in a public registry with:

- Implementation name and version
- Language and runtime
- Certification level (1–5)
- Conformance test version (AAFP RFC revision)
- Date certified
- Test results (JSON, link to CI run)
- Golden trace verification results

The Rust reference implementation is self-certified at Level 4 (Interop
Certified with Go). Level 5 (Production Certified) requires the 10K
connection load test and chaos test suite, which are roadmap items.

### 14.7 Recertification

Certification must be renewed when:
- A new AAFP RFC revision is released (e.g., Rev 6 → Rev 7)
- The implementation adds support for a new RFC (e.g., adding pubsub)
- A security vulnerability is found and fixed in the implementation

Recertification runs the same conformance suite with the updated test
vectors. Implementations that fail recertification are marked as
"certification expired" in the registry.

---

## 15. Test Inventory & Coverage Matrix

### 15.1 Test Count by Crate

| Crate | Tests | Type | Notes |
|-------|-------|------|-------|
| `aafp-cbor` | ~150 | Unit | CBOR encode/decode, canonical form |
| `aafp-crypto` | ~300 | Unit | ML-DSA-65, AEAD, HKDF, handshake, replay |
| `aafp-identity` | ~150 | Unit | AgentId, AgentRecord, UCAN, trust |
| `aafp-core` | ~100 | Unit | Session, authorization, error codes |
| `aafp-messaging` | ~200 | Unit | Frames, CloseManager, pipeline, RPC |
| `aafp-discovery` | ~100 | Unit | DHT routing, bootstrap, replication |
| `aafp-nat` | ~50 | Unit | Relay, AutoNAT, DCuTR |
| `aafp-sdk` | ~80 | Unit | AgentBuilder, server, client, metrics |
| `aafp-transport-quic` | ~50 | Unit | QUIC config, connection, TLS |
| `aafp-transport-mcp` | ~16 | Unit+Integration | MCP binding, rmcp trait |
| `aafp-transport-a2a` | ~20 | Unit | A2A binding |
| `aafp-conformance` | 568 | Conformance | RFC compliance (all RFCs) |
| `aafp-tests` | ~100 | Integration | Cross-crate, interop, WAN, stress |
| `aafp-loadtest` | ~10 | Load | Load test harness |
| `aafp-cli` | ~20 | Unit | CLI commands |
| `aafp-py` | ~15 | Integration | Python interop |
| **Total** | **~1,755** | | |

### 15.2 Coverage by Testing Layer

| Layer | Tests | % of total | Focus |
|-------|-------|-----------|-------|
| Unit | ~1,200 | 68% | Per-function correctness |
| Conformance | 568 | 32% | RFC normative compliance |
| Integration | ~100 | (overlap) | Cross-crate, interop |
| Load | Configurable | N/A | Scale, throughput |
| Chaos | Configurable | N/A | Resilience |
| Fuzz | 8 targets | N/A | Crash/panic detection |
| Mutation | N/A | N/A | Test quality verification |

### 15.3 RFC Coverage Matrix

| RFC | Conformance tests | Golden traces | Interop | Fuzz |
|-----|-------------------|---------------|---------|------|
| RFC-0001 (Overview) | N/A (non-normative) | — | — | — |
| RFC-0002 (Transport) | ✅ R2-001 through R2-400+ | ✅ handshake, frames | ✅ Rust↔Go | ✅ frame, CBOR |
| RFC-0003 (Identity) | ✅ R3-001 through R3-030 | ✅ agent_record | ✅ Rust↔Go | ✅ agent_record |
| RFC-0004 (Discovery) | ✅ R4-001+ | ✅ discovery | Partial | ✅ discovery |
| RFC-0005 (Errors) | ✅ R5-001 through R5-020+ | ✅ error | ✅ Rust↔Go | — |
| RFC-0006 (Versioning) | ✅ version_negotiation | — | Partial | — |
| RFC-0007 (MCP) | ✅ transport-mcp tests | — | ✅ Rust↔Python | — |
| RFC-0008 (A2A) | ✅ transport-a2a tests | — | Partial | — |
| RFC-0009 (PubSub) | Scaffold | — | — | — |
| RFC-0010 (Relay) | ✅ nat tests | — | — | ✅ relay |
| RFC-0011 (Trust) | ✅ trust_scenarios | — | — | — |

---

## 16. Appendix A: Conformance Test Module Reference

### 16.1 `rfc0002.rs` — Transport and Framing (637 lines)

Tests organized by RFC section:

- **§3 Frame Header (R2-001 to R2-010):** Header size (28 bytes), field
  offsets (version@0, type@1, flags@2, reserved@3, stream_id@4,
  payload_len@12, ext_len@20), max payload (1 MiB), oversized rejection.
- **§4 Frame Types (R2-015 to R2-026):** DATA(0x01), HANDSHAKE(0x02),
  RPC_REQUEST(0x03), RPC_RESPONSE(0x04), CLOSE(0x05), ERROR(0x06),
  PING(0x07), PONG(0x08), roundtrip, unknown critical rejection.
- **§5 Handshake (R2-040 to R2-065):** Transcript hash from TLS binding,
  CBOR folding, domain separator ("aafp-v1-handshake"), protocol version
  (1), nonce size (32), session ID size (32), key algorithm (1),
  ClientHello/ServerHello/ClientFinished integer keys, signature input
  format, full handshake transcript consistency, DoS receiver MAC.
- **§8 Canonical CBOR (R2-080 to R2-084):** Deterministic encoding,
  length-first key sorting, no indefinite-length, shortest integer
  encoding, string-keyed maps.
- **Revision 4 (R4-010+):** Empty map encoding (SA-0002).

### 16.2 `rfc0003.rs` — Identity and Authentication (473 lines)

- **§2 AgentId (R3-001 to R3-004):** SHA-256(public_key), 32 bytes, hex
  encoding (64 lowercase chars), fingerprint format (AAFP-base32-CRC32).
- **§3 AgentRecord (R3-010 to R3-020):** Record type string
  ("aafp-record-v1"), integer keys 1-9, signature excludes field 8,
  includes field 9, domain separator ("aafp-v1-record"), verification
  rejects bad agent_id/expired/bad signature/wrong record type, key
  algorithm value (1), max expiry (30 days).
- **§4 CapabilityDescriptor (R3-025 to R3-026):** Integer keys 1-2,
  string-keyed metadata.
- **§3.6 CBOR Roundtrip (R3-030):** Full AgentRecord encode/decode/verify.
- **Revision 4 (R4-001 to R4-006):** Metadata always present (SA-0001),
  empty map encoding (SA-0002).
- **Revision 5 (R5-001 to R5-004):** 30-day expiry is a warning, not
  rejection (SA-0003).

### 16.3 `rfc0004.rs` — Discovery (238 lines)

- **§3 Bootstrap (R4-001 to R4-010+):** Method names
  ("aafp.discovery.announce", "aafp.discovery.lookup"), AnnounceParams/
  AnnounceResult/LookupParams integer keys, rate limits, max records.

### 16.4 `rfc0005.rs` — Error Model (210 lines)

- **§2 Categories (R5-001):** 8 categories by thousands digit (Success,
  Transport, Authentication, Authorization, Discovery, Messaging,
  Capability, Protocol, Application).
- **§3 Code Registry (R5-002 to R5-010+):** All error codes in each
  category range, fatal error rules.

### 16.5 `handshake_state_machine.rs` — Normative State Machine (994 lines)

- **§5.10.1–§5.10.2:** Client (9 states) and server (9 states) enumeration.
- **§5.10.4–§5.10.5:** Client and server forward transition tables.
- **Illegal transitions:** Cannot skip states, cannot go backward.
- **§5.10.6:** Duplicate handshake message detection.
- **§5.10.7:** Unexpected frame handling.
- **§5.10.8:** Timeout enforcement (min, default, configurable).
- **§5.10.9:** Close behavior from any state.
- **§5.10.11:** State-to-session mapping.

### 16.6 `close_conformance.rs` — CLOSE Frame Semantics (525 lines)

- **§6.6.1:** State machine transition table (5 states: Open,
  LocalCloseSent, RemoteCloseReceived, CloseReceived, Closed).
- **§6.6.1 Invariants:** 5 invariants (no backward, Closed is terminal,
  timer rules).
- **§6.6.2–§6.6.4:** Close initiation, reception, crossed close.
- **§6.6.5:** Close timeout (min, default, max).
- **§6.6.6:** Frame disposition (post-close frames rejected).
- **§6.6.8:** Fatal ERROR vs CLOSE.
- **§6.6.9:** Transport reset.
- **§6.6.12:** Security (no data after close).

### 16.7 `replay_conformance.rs` — Nonce Replay Detection (479 lines)

- **§6.7.2:** Cache key is (agent_id, nonce).
- **§6.7.3:** Cache parameters (retention, max_entries, bounds).
- **§6.7.4:** 7 normative invariants.
- **§6.7.5:** Server-side replay check (check-before-verify,
  insert-after-verify).
- **§6.7.6:** Client-side replay check.
- **§6.7.7:** Eviction and resource management (LRU, memory bounds).
- **§6.7.8:** Concurrency (thread-safe via Mutex).
- **§6.7.11:** Security considerations.

### 16.8 `pipeline_order.rs` — Extension Processing Order (824 lines)

- 32 test cases covering all 20 phases of the frame processing pipeline.
- Verifies that extension callbacks are NEVER invoked before Phase 18
  (authentication).
- Verifies correct error codes for each phase failure.

### 16.9 `version_negotiation.rs` — Version & Downgrade (622 lines)

- Version rejection (wrong version → error).
- Extension handling (known vs unknown, critical vs non-critical).
- Frame type criticality.
- Transcript behavior across versions.
- Must pass identically in Rust and Go.

### 16.10 `negative.rs` — Malformed Input Rejection (710 lines)

- Non-canonical CBOR (non-shortest integers, duplicate keys, indefinite-
  length).
- Invalid frame headers (truncated, oversized, wrong version).
- Invalid signatures (tampered, wrong key).
- Expired/tampered AgentRecords.
- Invalid handshake messages.

### 16.11 `adversarial.rs` — Parser Edge Cases (700 lines)

- Truncated frames (0–27 bytes).
- Oversized length prefixes.
- Duplicate extension fields.
- Invalid state transitions.
- Replayed handshake messages.
- Unknown mandatory extensions.
- Version downgrade attempts.

### 16.12 `mldsa_cross_matrix.rs` — ML-DSA-65 Cross-Verification (253 lines)

- Rust→Rust baseline (19 vectors).
- Go→Rust verification (15 vectors).
- 100/100 differential traces cross-verify.

### 16.13 `mldsa_property.rs` — ML-DSA-65 Property Testing (221 lines)

- sign→verify always succeeds (1,000 iterations).
- Mutate signature → verify fails.
- Mutate message → verify fails.
- Mutate public key → verify fails.

### 16.14 `replay_stress.rs` — Replay Cache Under Load

- 100K nonces insertion and detection (single agent).
- Concurrent access from many threads.
- Eviction under pressure.
- Memory bounds verification.

### 16.15 `close_resources.rs` — Close Resource Verification

- Timer started/stopped correctly, no leaks.
- Internal state tracked and cleaned up.
- No resources held after Closed.
- CloseManager is reusable after drop.

### 16.16 `pipeline_adversarial.rs` — Pipeline Attack Resistance

- Frame truncation (incomplete header, payload, extensions).
- Extension injection (critical extension after auth bypass).
- Extension reordering (processing before auth).
- Duplicate extensions.
- Oversized frame injection (memory exhaustion).
- CBOR injection (non-canonical, duplicate keys, indefinite-length).
- Reserved and version field manipulation.

---

*This document is maintained alongside the AAFP RFCs and conformance test
suite. When new RFCs are added or existing RFCs are amended, the testing
strategy and conformance test inventory must be updated accordingly.*
