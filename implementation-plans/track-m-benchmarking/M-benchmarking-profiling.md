# Track M: Benchmarking & Profiling Infrastructure

**Priority:** HIGH (continuous — runs alongside all other tracks)
**Duration:** Ongoing (Q1-Q4)
**Blocked by:** nothing
**Blocks:** nothing (enables all other tracks)

---

## Problem

Current benchmarking is ad-hoc: `cargo bench` with Criterion, manual result recording. For a year-long optimization effort, we need:

1. **Continuous benchmarking:** Run benchmarks on every commit, detect regressions automatically
2. **Flamegraph generation:** Profile any benchmark to see where time is spent
3. **Allocation tracking:** Count allocations per operation, detect allocation regressions
4. **Latency distribution:** p50/p90/p99/p99.9, not just mean
5. **Cross-platform benchmarks:** Run on both ARM64 (Apple Silicon) and x86_64 (Linux CI)
6. **Comparison reports:** Before/after for every optimization, with statistical significance

---

## Steps

### M1: Automated benchmark harness
- Create `crates/aafp-benchmark/src/harness.rs`:
  - `BenchmarkRunner`: runs a set of benchmarks, collects results, writes JSON
  - `BenchmarkResult`: name, p50, p90, p99, p99.9, mean, stddev, samples, duration
  - `compare_results(baseline, current) -> ComparisonReport`: statistical comparison
- Integrate with existing Criterion benchmarks (wrap Criterion output)
- **VERIFY:** `cargo bench --bench mcp_transport` produces JSON output in `test-results/performance/`

### M2: Flamegraph integration
- Add `flamegraph` as a dev-dependency (or use `cargo flamegraph`)
- Create `scripts/flamegraph.sh` that:
  1. Builds the benchmark in release mode with debug symbols
  2. Runs the benchmark under `perf record` (Linux) or `dtrace` (macOS)
  3. Generates a flamegraph SVG
  4. Saves to `test-results/flamegraphs/<benchmark-name>.svg`
- Add flamegraphs for: mcp_transport_ping, handshake, framing, discovery
- **VERIFY:** Flamegraph SVG is generated and shows the hot path

### M3: Allocation tracking
- Create `crates/aafp-benchmark/src/alloc_tracker.rs`:
  - `AllocTracker`: wraps global allocator, counts allocations/deallocations
  - `track_allocs<F>(f: F) -> AllocReport`: runs `f`, returns allocation count + bytes
  - Uses `std::alloc::set_alloc_hook` (nightly) or custom allocator (stable)
- Add allocation tracking to all benchmarks:
  - `bench_ping_round_trip_allocs`: allocations per round-trip
  - `bench_handshake_allocs`: allocations per handshake
  - `bench_frame_encode_allocs`: allocations per frame encode
- **VERIFY:** Each benchmark reports allocation count alongside timing

### M4: CI benchmark regression detection
- Create `.github/workflows/benchmark.yml`:
  - Runs on every push to master (not PRs — too slow for PRs)
  - Runs all benchmarks, stores results as artifacts
  - Compares against previous commit's results
  - If any benchmark regresses by >10%, marks the workflow as failed
  - Posts a comment on the commit with the regression details
- Use `critcmp` or custom comparison logic
- **VERIFY:** A deliberate 10% regression is detected by CI

### M5: Latency distribution reporting
- Enhance `BenchmarkRunner` to record all sample times (not just summary stats)
- Generate latency distribution plots:
  - Histogram (p50, p90, p99, p99.9 markers)
  - CDF (cumulative distribution function)
  - Time series (latency over time — detect drift)
- Save plots as SVG in `test-results/performance/plots/`
- **VERIFY:** Latency distribution plot is generated for mcp_transport_ping

### M6: Cross-platform benchmark runner
- Create `scripts/benchmark-matrix.sh` that runs benchmarks on:
  - macOS ARM64 (Apple Silicon) — local
  - Linux x86_64 — CI runner
  - (Optional: Linux ARM64 — if CI runner available)
- Store results in `test-results/performance/<platform>/`
- Generate cross-platform comparison report
- **VERIFY:** Benchmark results exist for both macOS ARM64 and Linux x86_64

### M7: Performance dashboard
- Create `test-results/generate_perf_dashboard.py`:
  - Reads all JSON results from `test-results/performance/`
  - Generates `test-results/dashboards/performance.html`
  - Shows: current vs baseline, trend over time, per-platform comparison
  - Includes: round-trip latency, throughput, allocations, handshake time, AEAD time
  - Auto-refreshes from JSON data (no manual updates needed)
- Add to `test-results/run_all_tests.py`
- **VERIFY:** Dashboard HTML is generated and shows all performance metrics with trends

---

## Expected Outcomes

| Capability | Before | After |
|------------|--------|-------|
| Benchmark regression detection | Manual | Automatic (CI) |
| Allocation tracking | None | Per-benchmark |
| Flamegraph generation | None | One command |
| Latency percentiles | p50 only | p50/p90/p99/p99.9 |
| Cross-platform comparison | None | macOS + Linux |
| Performance dashboard | Static | Interactive HTML |

---

## Integration with Other Tracks

Track M provides the measurement infrastructure for all other tracks:

- **G (Zero-Copy):** M3 (allocation tracking) verifies 0 allocations
- **H (Lock-Free):** M1 (benchmark harness) measures concurrent throughput
- **I (Connection Lifecycle):** M1 measures connect time for 0-RTT vs full
- **J (QUIC Tuning):** M5 (latency distribution) shows p99 improvement
- **K (Serialization):** M1 measures encode/decode time
- **L (Kernel/Hardware):** M2 (flamegraph) shows syscall overhead

Every step in every track should:
1. Run the relevant benchmark before the change (baseline)
2. Implement the change
3. Run the benchmark after the change
4. Compare before/after using M1's `compare_results()`
5. Write results to `test-results/performance/`
