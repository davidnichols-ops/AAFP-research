# Performance Optimization Status

**Master plan:** [`PERFORMANCE_OPTIMIZATION_PLAN.md`](PERFORMANCE_OPTIMIZATION_PLAN.md)
**Created:** 2026-07-03
**Goal:** Sub-100µs round-trip, >1M msg/s throughput, 0 allocations per message

---

## Current Baseline (2026-07-03, Apple M4, release build)

| Metric | Value | Source |
|--------|-------|--------|
| Round-trip ping (localhost) | 250 µs | `mcp_transport` benchmark |
| One-way throughput (1KB) | 160K msg/s | `mcp_transport` benchmark |
| PQ handshake (crypto) | 709 µs | `handshake` benchmark |
| Frame encode 1KB | 66 ns | `framing` benchmark |
| Frame decode 1KB | 35 ns | `framing` benchmark |
| AEAD encrypt 1KB | 1.63 µs | crypto benchmark |
| AEAD decrypt 1KB | 1.64 µs | crypto benchmark |
| ML-DSA-65 keygen | 133 µs | crypto benchmark |
| ML-DSA-65 sign | 272 µs | crypto benchmark |
| ML-DSA-65 verify | 76 µs | crypto benchmark |
| sizeof(Session) | 168 bytes | `session` benchmark |
| Allocations per message | 2 (send), 7 (recv), 9 (round-trip) | `alloc_profile` benchmark |
| Lock acquisitions per send | 1 | Code analysis |

---

## Track Status

| Track | Name | Status | Steps | Duration |
|-------|------|--------|-------|----------|
| G | Zero-Copy Data Path | IN PROGRESS | 1/8 | Q1 |
| H | Lock-Free Concurrency | NOT STARTED | 0/7 | Q1-Q2 |
| I | Connection Lifecycle | NOT STARTED | 0/8 | Q2 |
| J | QUIC Transport Tuning | NOT STARTED | 0/7 | Q2-Q3 |
| K | Serialization Optimization | NOT STARTED | 0/7 | Q3 |
| L | Kernel & Hardware | NOT STARTED | 0/8 | Q3-Q4 |
| M | Benchmarking & Profiling | IN PROGRESS | 2/7 | Ongoing |

**Total steps:** 52
**Completed:** 3
**In progress:** 2
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

1. **All existing tests pass** (1144+ Rust tests, 0 failures)
2. **Clippy clean** (`cargo clippy --workspace -- -D warnings`)
3. **Fmt clean** (`cargo fmt --all -- --check`)
4. **No wire protocol changes** (golden traces still pass)
5. **No security regressions** (PQ handshake still enforced, identity still verified)
6. **Benchmark improvement** (measured improvement vs baseline, statistically significant)
7. **No new allocations** (allocation count same or lower than before)
