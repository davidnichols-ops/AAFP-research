# Track L: Kernel & Hardware Optimization

**Priority:** MEDIUM (advanced — for the last mile of performance)
**Duration:** Q3-Q4 (6-8 weeks)
**Blocked by:** K (Serialization — needs optimized data path before kernel bypass makes sense)
**Blocks:** nothing

---

## Problem

After eliminating allocations (G), locks (H), and serialization overhead (K), the remaining latency comes from:

1. **Syscall overhead:** Each `write()` / `read()` on a QUIC socket costs ~1-2µs (syscall + context switch)
2. **Crypto overhead:** AEAD encrypt/decrypt is 1.6µs per 1KB — SIMD can make this 5-10x faster
3. **Memory bandwidth:** Copying data between kernel and user space is the last remaining copy
4. **Scheduler latency:** Tokio task scheduling adds 1-10µs per wake/notify cycle

This track explores kernel-level and hardware-level optimizations for the absolute lowest latency.

---

## Steps

### L1: Profile syscall overhead
- Use `dtrace` (macOS) or `perf` (Linux) to count syscalls per message round-trip
- Expected: 2-4 syscalls per message (write, read, epoll_wait, epoll_ctl)
- Measure syscall time: `write()` ~1µs, `read()` ~1µs, `epoll_wait` ~0.5µs
- Write results to `test-results/performance/syscall-profile.json`
- **VERIFY:** Baseline syscall count and time per message

### L2: Enable `recvmmsg` / `sendmmsg` batching (Linux)
- Quinn uses `recvmmsg()` on Linux for batch packet reception (verify)
- If not enabled, configure `Endpoint` to use batch receive
- `sendmmsg()` allows sending multiple UDP packets in one syscall
- For high-throughput scenarios (1000+ msg/s), this reduces syscalls by 10-100x
- **VERIFY:** Syscall count per 1000 messages drops from ~4000 to ~40

### L3: SIMD-accelerated crypto
- Verify `aws-lc-rs` uses AES-NI / ARM Crypto Extensions
- Benchmark AEAD with SIMD vs without:
  - `aws-lc-rs` should already use hardware AES on Apple M4 (ARMv8 Crypto Extensions)
  - Verify by checking `aws-lc-rs` build features
- If SIMD is not being used, enable it:
  - ARM64: `AWS_LC_RS_ARM_CRYPTO_EXTENSIONS=1` at build time
  - x86_64: `AWS_LC_RS_AES_NI=1` at build time
- For SHA-256: verify `aws-lc-rs` uses SHA-NI / ARM SHA2 extensions
- **VERIFY:** AEAD encrypt 1KB: <0.3µs (from 1.6µs). SHA-256 1KB: <0.1µs

### L4: `io_uring` integration (Linux only)
- Evaluate `tokio-uring` for Linux io_uring support
- io_uring allows batched, asynchronous syscalls without context switches
- For the QUIC socket: `readv` / `writev` via io_uring submission queue
- Expected: 2-5x reduction in syscall overhead
- **Note:** This is Linux-only. macOS uses `kqueue` which is already efficient.
- **VERIFY:** Linux benchmark shows 2-5x lower syscall overhead vs standard tokio

### L5: Tokio runtime tuning
- Current: `tokio::runtime::Builder::new_multi_thread().enable_all()`
- Tuning options:
  - `worker_threads(n)`: Set to physical core count (not hyperthread count)
  - `disable_block_in_place()`: Prevent blocking the reactor
  - `thread_stack_size(2 * 1024 * 1024)`: Reduce from default 8MB (saves memory, better cache)
  - `max_blocking_threads(512)`: Limit blocking thread pool
- For ultra-low latency: consider `current_thread` runtime (no cross-core scheduling)
- **VERIFY:** Runtime benchmark shows lower task scheduling latency

### L6: Affinity and priority tuning
- Pin tokio worker threads to specific CPU cores (`core_affinity` crate)
- Set process priority to high (`nice -10` on Linux, `renice` on macOS)
- Disable CPU frequency scaling (governor = performance on Linux)
- These eliminate frequency scaling and core migration latency
- **VERIFY:** Benchmark variance is reduced (p99 closer to p50)

### L7: XDP / DPDK evaluation (research)
- Research whether XDP (eXpress Data Path) or DPDK can be used with QUIC
- XDP allows packet processing in the kernel's eBPF layer (before socket layer)
- DPDK allows packet processing entirely in userspace (kernel bypass)
- **Challenge:** QUIC requires UDP socket semantics. XDP/DPDK bypass the socket layer entirely.
- **Approach:** Evaluate `quiche` with XDP support, or implement a custom UDP stack via AF_XDP
- **Outcome:** This is a research step. If XDP/DPDK integration is feasible, create a detailed plan. If not, document why and skip.
- **VERIFY:** Research report with feasibility assessment and recommended approach (or "not feasible")

### L8: End-to-end kernel/hardware benchmark
- Benchmark with all optimizations enabled:
  1. Localhost round-trip (target: <30µs)
  2. AEAD encrypt/decrypt 1KB (target: <0.3µs)
  3. Syscall count per message (target: <2)
  4. Task scheduling latency (target: <1µs)
- Write results to `test-results/performance/kernel-hardware.json`
- Update `PERFORMANCE_REPORT.md`
- **VERIFY:** Localhost round-trip <30µs (from 250µs original baseline, 50µs post G+H+J)

---

## Expected Outcomes

| Metric | Before (post G+H+J+K) | After | Method |
|--------|------------------------|-------|--------|
| Localhost round-trip | ~50µs | <30µs | Syscall reduction + runtime tuning |
| AEAD encrypt 1KB | 1.6µs | <0.3µs | SIMD crypto |
| Syscalls per message | 2-4 | <2 | io_uring / batch |
| Task scheduling latency | 2-5µs | <1µs | Runtime tuning + core pinning |
| p99/p50 latency ratio | ~2.0 | <1.5 | Core affinity + priority |

---

## Risks & Mitigations

1. **io_uring is Linux-only:** macOS doesn't have io_uring. **Mitigation:** Use `kqueue` on macOS (already efficient). io_uring optimization is Linux-specific. Document platform differences.

2. **XDP/DPDK complexity:** Kernel bypass requires significant infrastructure. **Mitigation:** L7 is a research step. If it's too complex, skip it. The other steps (L1-L6, L8) provide the majority of the benefit.

3. **Core pinning reduces flexibility:** Pinned threads can't migrate to idle cores. **Mitigation:** Make pinning optional (config flag). Default: unpinned. Enable for latency-critical deployments.

4. **SIMD crypto may already be enabled:** `aws-lc-rs` may already use hardware crypto. **Mitigation:** L3 starts with verification. If SIMD is already on, this step is a no-op (document and move on).

5. **Reduced stack size may overflow:** 2MB stack may be too small for deep async call stacks. **Mitigation:** Test with realistic workloads. If stack overflow occurs, increase to 4MB.
