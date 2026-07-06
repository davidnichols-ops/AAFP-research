# Performance Optimization Status

**Master plan:** [`PERFORMANCE_OPTIMIZATION_PLAN.md`](PERFORMANCE_OPTIMIZATION_PLAN.md)
**Created:** 2026-07-03
**Goal:** Sub-100µs round-trip, >1M msg/s throughput, 0 allocations per message

---

## Current Performance (2026-07-03, Apple M4, release build, post-Phase 4)

| Metric | Value | Source |
|--------|-------|--------|
| Round-trip ping (localhost) | 41.47 µs | `mcp_transport` benchmark |
| One-way throughput (1KB) | 776K msg/s | `mcp_transport` benchmark |
| PQ handshake (crypto) | 709 µs | `handshake` benchmark |
| Frame encode 1KB | 66 ns | `framing` benchmark |
| Frame decode 1KB | 35 ns | `framing` benchmark |
| AEAD encrypt 1KB (ChaCha20) | 1.64 µs | `handshake` benchmark |
| AEAD decrypt 1KB (ChaCha20) | 1.64 µs | `handshake` benchmark |
| AEAD encrypt 1KB (AES-256-GCM HW) | 1.10 µs | `handshake` benchmark (L3) |
| AEAD decrypt 1KB (AES-256-GCM HW) | 1.10 µs | `handshake` benchmark (L3) |
| AEAD encrypt 64B (ChaCha20) | 228 ns | `handshake` benchmark (L3) |
| ML-DSA-65 keygen | 133 µs | crypto benchmark |
| ML-DSA-65 sign | 272 µs | crypto benchmark |
| ML-DSA-65 verify | 76 µs | crypto benchmark |
| sizeof(Session) | 168 bytes | `session` benchmark |
| Allocations per message | 0 (send, zero-copy), 7 (recv, JSON deser) | `alloc_profile` benchmark |
| Lock acquisitions per send | 0 | Code analysis (Track H) |
| Cold connect time | 240 µs | `connection_lifecycle` benchmark |
| Pooled connect (stream open) | 1.34 µs | `connection_lifecycle` benchmark |
| Pooled RPC (100 RPCs) | 0.39 µs/RPC | `connection_lifecycle` benchmark |
| CBOR encode (RPC request) | 138 ns | `serialization` benchmark |
| CBOR decode (RPC request) | 94 ns | `serialization` benchmark |
| JSON decode (simd-json) | 399 ns | `serialization` benchmark |
| Task scheduling (yield_now) | 24 ns | `runtime_tuning` benchmark (L5) |
| Syscall dominant cost | 84% condvar wait | `sample` profiling (L1) |

---

## Track Status

| Track | Name | Status | Steps | Duration |
|-------|------|--------|-------|----------|
| G | Zero-Copy Data Path | COMPLETE | 8/8 | Q1 |
| H | Lock-Free Concurrency | COMPLETE | 7/7 | Q1-Q2 |
| I | Connection Lifecycle | COMPLETE | 5/5 (I2-I4 skipped) | Q2 |
| J | QUIC Transport Tuning | COMPLETE | 6/6 (J6 skipped) | Q2-Q3 |
| K | Serialization Optimization | COMPLETE | 3/7 (K3-K6 not needed) | Q3 |
| L | Kernel & Hardware | COMPLETE | 8/8 (L2/L4/L7 documented) | Q3-Q4 |
| M | Benchmarking & Profiling | COMPLETE | 7/7 | Ongoing |
| N | NAT Traversal | COMPLETE | 8/8 | 2026-07-04 |
| O | WAN Testing | COMPLETE | 8/8 | 2026-07-04 |
| P | Identity & PKI | COMPLETE | 8/8 | 2026-07-04 |
| Q | Security Audit | COMPLETE | 8/8 | 2026-07-04 |
| R | WAN Discovery | COMPLETE | 8/8 | 2026-07-04 |
| S | Load & Operations | COMPLETE | 8/8 | 2026-07-04 |

**Total steps:** 52 (+ 8 WAN + 48 tracks N-S) = 108
**Completed:** 108
**In progress:** 0
**Blocked:** 0

---

## Target Outcomes (cumulative)

| After Track | Round-trip | Throughput | Allocations/msg | Handshake |
|-------------|------------|------------|-----------------|-----------|
| Baseline | 250 µs | 160K/s | 3 | 709 µs |
| G (Zero-Copy) | <150 µs | >300K/s | 0 | 709 µs |
| H (Lock-Free) | <100 µs | >800K/s | 0 | 709 µs |
| I (0-RTT + Pool) | <50 µs (pooled) | >800K/s | 0 | <200µs (0-RTT) |
| J (QUIC Tuning) | <50 µs | >1M/s | 0 | <200µs |
| K (Serialization) | <40 µs | >1.2M/s | 0 | <100µs |
| L (Kernel/HW) | <30 µs | >1.5M/s | 0 | <100µs |

---

## Execution Order

```
Phase 1 (Q1): G (Zero-Copy) + M1-M3 (Benchmarking foundation)
Phase 2 (Q2): H (Lock-Free) + I1-I5 (0-RTT + Pooling) + M4-M5
Phase 3 (Q3): I6-I8 (Migration) + K (Serialization) + J1-J3 (QUIC Tuning) + M6-M7
Phase 4 (Q4): J4-J7 (QUIC Advanced) + L (Kernel/Hardware)
```

---

## Verification Checkpoints

After each track, the following must pass:

1. **All existing tests pass** (1864 Rust tests, 0 failures, 7 ignored)
2. **Clippy clean** (`cargo clippy --workspace -- -D warnings`)
3. **Fmt clean** (`cargo fmt --all -- --check`)
4. **No wire protocol changes** (golden traces still pass)
5. **No security regressions** (PQ handshake still enforced, identity still verified)
6. **Benchmark improvement** (measured improvement vs baseline, statistically significant)
7. **No new allocations** (allocation count same or lower than before)

---

## WAN Testing Results (Track O, 2026-07-04)

Full report: [`test-results/performance/WAN_REPORT.md`](../test-results/performance/WAN_REPORT.md)

| Metric | Localhost | Simulated 50ms WAN | Simulated 200ms RTT |
|--------|-----------|--------------------|---------------------|
| Round-trip p50 | 41.47 µs | 52,092 µs | 203,088 µs |
| 1KB throughput | 776K msg/s | 167K msg/s | N/A |
| Handshake | 240 µs | N/A | 31.2 ms |

### Adverse Conditions

| Condition | Success Rate | Status |
|-----------|-------------|--------|
| 1% packet loss | 99.5% | PASS |
| 5% packet loss | 96.5% | PASS |
| 500ms RTT (satellite) | 100% (5/5 pings) | PASS |
| 1% loss + 100ms RTT | 96% | PASS |

### Congestion Control (1% loss, p50)

| Controller | p50 (µs) |
|------------|----------|
| BBR | 236 |
| Cubic | 313 |
| NewReno | 128 |

**Note:** WAN conditions simulated in userspace (QUIC uses UDP, toxiproxy
only supports TCP). Real-world validation with second machine or tc/dnctl
(root) recommended for final production sign-off.

---

## DHT Scale (Track R8, 2026-07-04)

Full report: [`test-results/performance/dht-scale-report.md`](../test-results/performance/dht-scale-report.md)

| Nodes | Lookup Latency | Announce Latency | RT Size | Success Rate |
|-------|---------------|-----------------|---------|-------------|
| 10 | 451 ms | 51 ms | 9 | 100% |
| 50 | 5.56 s | 129 ms | 47 | 100% |
| 100 | 1.32 s | 188 ms | 67 | 100% |
| 500 | 1.86 s | 116 ms | 54 | 100% |

### Churn Tolerance (100 nodes)

| Churn Rate | Lookup Success | Latency |
|-----------|---------------|---------|
| 0% | 100% | 1.32 s |
| 10% | 100% | 1.36 s |
| 20% | 95% | 1.27 s |
| 30% | 70% | 1.54 s |

**Note:** Latency is dominated by in-process async overhead (RwLock contention,
signature verification). Real-world latency will be dominated by network RTT.
DHT scales to 500 nodes with 100% lookup success. Churn tolerance is excellent
up to 20%, degrades at 30% due to record loss.
