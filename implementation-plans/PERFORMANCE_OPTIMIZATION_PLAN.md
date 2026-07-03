# Performance Optimization Master Plan: "Near-Instant" Networking

**Created:** 2026-07-03
**Goal:** Reduce AAFP networking latency to near-instant (sub-100µs round-trip, >1M msg/s throughput)
**Duration:** ~12 months (7 tracks, 52 steps)
**Prerequisite:** All 218 roadmap steps complete (Tracks A-F)

---

## Current Baseline (Apple M4, release build)

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| Round-trip ping (localhost) | 250 µs | <50 µs | 5x |
| One-way throughput (1KB msgs) | 160K msg/s | >1M msg/s | 6x |
| PQ handshake (crypto only) | 709 µs | <200 µs | 3.5x |
| Time to first authenticated msg | ~1ms (TLS+AAFP) | <500µs (0-RTT) | 2x |
| Frame encode 1KB | 66 ns | <30 ns | 2x |
| Frame decode 1KB | 35 ns | <20 ns | 1.75x |
| AEAD encrypt 1KB | 1.63 µs | <0.5 µs | 3x |
| Memory per session | 168 bytes | <128 bytes | 1.3x |
| Allocations per message | 3 (JSON→frame→QUIC) | 0 (zero-copy) | ∞ |
| Lock acquisitions per send | 1 (Mutex) | 0 (lock-free) | ∞ |

---

## Track Overview

| Track | Name | Steps | Duration | Focus |
|-------|------|-------|----------|-------|
| G | Zero-Copy Data Path | 8 | Q1 | Eliminate all allocations on the hot path |
| H | Lock-Free Concurrency | 7 | Q1-Q2 | Remove all locks from send/receive paths |
| I | Connection Lifecycle | 8 | Q2 | 0-RTT resumption, pooling, migration |
| J | QUIC Transport Tuning | 7 | Q2-Q3 | Tune quinn for ultra-low latency |
| K | Serialization Optimization | 7 | Q3 | Faster CBOR/JSON, SIMD, custom codecs |
| L | Kernel & Hardware | 8 | Q3-Q4 | io_uring, SIMD crypto, DPDK/XDP |
| M | Benchmarking & Profiling | 7 | Ongoing | Continuous perf tracking, flamegraphs, regression detection |

**Total: 52 steps across 7 tracks**

---

## Dependency Graph

```
G (Zero-Copy) ──→ H (Lock-Free) ──→ I (Connection Lifecycle)
                                          ↓
M (Benchmarking) ←── K (Serialization) ←──┘
        ↑                   ↓
        └── L (Kernel/HW) ←─┘
                ↓
        J (QUIC Tuning)
```

- G and M can start immediately (no prerequisites)
- H depends on G (lock-free requires zero-copy buffer management)
- I depends on H (connection pooling requires lock-free streams)
- J depends on I (QUIC tuning needs connection lifecycle)
- K depends on G (serialization optimization needs zero-copy framework)
- L depends on K (kernel bypass needs optimized serialization)
- M runs continuously, measuring every track's progress

---

## Execution Order

```
Q1:  G1-G8 (Zero-Copy) + M1-M3 (Benchmarking foundation)
Q2:  H1-H7 (Lock-Free) + I1-I4 (0-RTT + Pooling)
Q3:  I5-I8 (Migration) + K1-K7 (Serialization) + J1-J3 (QUIC Tuning)
Q4:  J4-J7 (QUIC Advanced) + L1-L8 (Kernel/Hardware) + M4-M7 (Regression)
```

---

## Golden Rules

1. **Measure before optimizing.** Every track starts with a benchmark.
2. **Never sacrifice security for speed.** PQ handshake and identity verification are non-negotiable.
3. **Never break the wire protocol.** All optimizations must be wire-compatible with existing peers.
4. **Profile, don't guess.** Use flamegraphs and perf counters, not intuition.
5. **One optimization per commit.** Each step is independently measurable.
6. **Regression detection.** If a benchmark regresses, revert and investigate.
7. **Platform-aware.** Optimize for both ARM64 (Apple Silicon) and x86_64.
8. **No unsafe without justification.** Every `unsafe` block needs a SAFETY comment and review.
