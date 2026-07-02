# Plan F1: Performance Validation + Benchmark Framework (P1-5)

**Priority:** HIGH (release criterion)
**Track:** F (Production Readiness)
**Estimated effort:** 8-10 hours
**Blocked by:** E1-E4 (need protocol features to benchmark them)
**Blocks:** nothing

---

## Objective

Build a proper benchmark framework and validate AAFP's performance against
the targets in PERFORMANCE_CRITERIA.md (if it exists) or reasonable targets
for a post-quantum agent protocol.

**Current state:** `aafp-benchmark` crate has `env_report.rs` (283 lines)
which reports CPU/OS/Rust version, and `lib.rs` (1 line). No actual
benchmarks are implemented.

**Source:** ROADMAP.md P1-5, release criterion #9

---

## Performance Targets (to validate)

Based on ROADMAP.md and architectural reasoning:

| Metric | Target | Notes |
|--------|--------|-------|
| Time to first authenticated message | < 500ms | QUIC handshake + AAFP handshake + first DATA frame |
| ML-DSA-65 key generation | < 50ms | fips204 keypair generation |
| ML-DSA-65 signature | < 10ms | fips204 sign |
| ML-DSA-65 verification | < 15ms | fips204 verify |
| Frame encode (1KB payload) | < 10µs | CBOR + frame header |
| Frame decode (1KB payload) | < 10µs | CBOR + frame header |
| Message throughput (single stream) | > 10,000 msg/s | 1KB messages |
| Message throughput (multi-stream) | > 50,000 msg/s | 10 streams, 1KB messages |
| Memory per session | < 1MB | Session state + buffers |
| Concurrent sessions | > 1,000 | Per agent |

---

## Prerequisites

- E1-E4 complete (all protocol features to benchmark)
- Read `crates/aafp-benchmark/src/env_report.rs` (283 lines)
- Read `crates/aafp-benchmark/Cargo.toml`

---

## Steps

### F1.1: Create benchmark framework

Edit `crates/aafp-benchmark/src/lib.rs` and create benchmark modules:

```rust
//! AAFP benchmark framework.
//!
//! Every benchmark reports:
//! - CPU model, OS, Rust version, compiler profile
//! - Message size, stream count, transport configuration
//! - Methodology (what is being measured)
//! - Results with confidence intervals

pub mod env_report;
pub mod crypto_bench;
pub mod framing_bench;
pub mod transport_bench;
pub mod session_bench;
```

### F1.2: Implement crypto benchmarks

Create `crates/aafp-benchmark/src/crypto_bench.rs`:

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use aafp_crypto::{MlDsa65, AgentKeypair};

pub fn bench_keygen(c: &mut Criterion) {
    c.bench_function("ml_dsa_65_keygen", |b| {
        b.iter(|| MlDsa65::keypair());
    });
}

pub fn bench_sign(c: &mut Criterion) {
    let keypair = MlDsa65::keypair();
    let msg = b"benchmark message for signing";
    c.bench_function("ml_dsa_65_sign", |b| {
        b.iter(|| MlDsa65::sign(&keypair.secret, black_box(msg)));
    });
}

pub fn bench_verify(c: &mut Criterion) {
    let keypair = MlDsa65::keypair();
    let msg = b"benchmark message for signing";
    let sig = MlDsa65::sign(&keypair.secret, msg);
    c.bench_function("ml_dsa_65_verify", |b| {
        b.iter(|| MlDsa65::verify(&keypair.public, msg, black_box(&sig)));
    });
}
```

### F1.3: Implement framing benchmarks

Create `crates/aafp-benchmark/src/framing_bench.rs`:

```rust
pub fn bench_frame_encode(c: &mut Criterion) {
    let mut group = c.benchmark_group("frame_encode");
    for size in [64, 256, 1024, 4096, 16384, 65536].iter() {
        let payload = vec![0u8; *size];
        group.bench_with_input(BenchmarkId::from_parameter(size), size, |b, _| {
            b.iter(|| Frame::data(4, black_box(&payload)));
        });
    }
    group.finish();
}

pub fn bench_frame_decode(c: &mut Criterion) {
    let mut group = c.benchmark_group("frame_decode");
    for size in [64, 256, 1024, 4096, 16384, 65536].iter() {
        let payload = vec![0u8; *size];
        let frame = Frame::data(4, &payload);
        let encoded = frame.encode();
        group.bench_with_input(BenchmarkId::from_parameter(size), size, |b, _| {
            b.iter(|| Frame::decode(black_box(&encoded)));
        });
    }
    group.finish();
}
```

### F1.4: Implement transport benchmarks

Create `crates/aafp-benchmark/src/transport_bench.rs`:

```rust
pub fn bench_handshake(c: &mut Criterion) {
    // Measure time for full AAFP handshake (QUIC + AAFP v1)
    // This is the "time to first authenticated message" metric
}

pub fn bench_throughput_single_stream(c: &mut Criterion) {
    // Measure message throughput on a single QUIC stream
    // 1KB messages, count messages per second
}

pub fn bench_throughput_multi_stream(c: &mut Criterion) {
    // Measure message throughput across multiple streams
    // 10 streams, 1KB messages
}
```

### F1.5: Implement session/memory benchmarks

Create `crates/aafp-benchmark/src/session_bench.rs`:

```rust
pub fn bench_memory_per_session(c: &mut Criterion) {
    // Measure memory usage per active session
    // Use jemalloc stats or /proc/self/status
}

pub fn bench_concurrent_sessions(c: &mut Criterion) {
    // Measure how many concurrent sessions can be maintained
    // Start with 10, scale to 1000+
}
```

### F1.6: Run benchmarks and collect results

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo bench --workspace
```

Save results to `crates/aafp-benchmark/results/` with timestamps.

### F1.7: Create performance report

Create `PERFORMANCE_REPORT.md` in the umbrella repo:

```markdown
# AAFP Performance Report

## Environment
- CPU: <model>
- OS: <os>
- Rust: <version>
- Compiler profile: release (opt-level=3)
- Date: 2026-07-XX

## Results

### Cryptography
| Operation | Time | Target | Status |
|-----------|------|--------|--------|
| ML-DSA-65 keygen | Xms | <50ms | PASS/FAIL |
| ML-DSA-65 sign | Xms | <10ms | PASS/FAIL |
| ML-DSA-65 verify | Xms | <15ms | PASS/FAIL |

### Framing
| Operation | Payload | Time | Target | Status |
|-----------|---------|------|--------|--------|
| Encode | 1KB | Xµs | <10µs | PASS/FAIL |
| Decode | 1KB | Xµs | <10µs | PASS/FAIL |

### Transport
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Time to first auth msg | Xms | <500ms | PASS/FAIL |
| Throughput (1 stream) | Xmsg/s | >10,000 | PASS/FAIL |
| Throughput (10 streams) | Xmsg/s | >50,000 | PASS/FAIL |

### Resources
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Memory per session | XKB | <1MB | PASS/FAIL |
| Concurrent sessions | X | >1,000 | PASS/FAIL |

## Methodology
<describe how each benchmark was run, warmup, iterations, etc.>

## Conclusion
<honest assessment — which targets are met, which are not, what needs optimization>
```

### F1.8: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
feat: benchmark framework + performance validation (P1-5)

Adds comprehensive benchmarks for crypto, framing, transport, and sessions.
Every benchmark reports CPU, OS, Rust version, message size, and methodology.

Closes ROADMAP.md P1-5 and release criterion #9.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Commit report in umbrella:
```bash
cd /Users/david/projects/AAFP-research
git add PERFORMANCE_REPORT.md implementations/rust
git commit -m "docs: performance validation report (P1-5)"
```

---

## Verification

### F1.9: Benchmarks run

```bash
cargo bench --workspace
```
**Expected:** All benchmarks run and produce results.

### F1.10: Report exists

```bash
test -f PERFORMANCE_REPORT.md && echo "PASS"
```

---

## Risks & Mitigations

1. **Performance targets not met:** Some targets may be too aggressive for
   ML-DSA-65 (post-quantum crypto is slower than classical). **Mitigation:**
   Document the actual numbers honestly. If targets aren't met, analyze
   why and propose optimizations, but don't fake results.

2. **Transport benchmarks need two processes:** QUIC transport benchmarks
   need a server and client. **Mitigation:** Use `criterion`'s async
   benchmarking with `tokio::runtime`, or spawn a server thread within
   the benchmark.

3. **Memory benchmarks are platform-dependent:** `jemalloc` stats only work
   with `jemalloc` allocator. **Mitigation:** Use `std::alloc::GlobalAlloc`
   wrapper or platform-specific APIs. Document the measurement method.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark F1.1 through F1.10 as `[x]`
- Set F1 status to `COMPLETE`
