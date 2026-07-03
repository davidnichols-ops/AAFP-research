# Builder Prompt: Performance Optimization ("Near-Instant" Networking)

## Mission

You are the Builder. Your mission is to execute the AAFP Performance Optimization Plan —
7 tracks, 52 steps, ~12 months of work — to reduce networking latency from 250µs to <30µs
round-trip and increase throughput from 160K msg/s to >1.5M msg/s.

## Context

The AAFP protocol implementation is feature-complete (218/218 roadmap steps done).
All 218 steps across Tracks A-F are complete. 1144 Rust tests pass. The codebase is
clean (clippy, fmt, no warnings). All repos are public on GitHub.

Now begins the performance optimization phase. The master plan is in
`implementation-plans/PERFORMANCE_OPTIMIZATION_PLAN.md`. The status tracker is in
`implementation-plans/PERFORMANCE_STATUS.md`.

## Current Baseline (Apple M4, release build)

- Round-trip ping: 250 µs
- One-way throughput: 160K msg/s
- PQ handshake: 709 µs
- Allocations per message: 3 (JSON → frame → QUIC)
- Lock acquisitions per send: 1 (Mutex)

## Target

- Round-trip ping: <30 µs (8x improvement)
- One-way throughput: >1.5M msg/s (9x improvement)
- PQ handshake: <100 µs (7x improvement)
- Allocations per message: 0 (zero-copy)
- Lock acquisitions per send: 0 (lock-free)

## Track Summary

| Track | Name | Steps | Focus |
|-------|------|-------|-------|
| G | Zero-Copy Data Path | 8 | Eliminate all allocations on the hot path |
| H | Lock-Free Concurrency | 7 | Remove all locks from send/receive paths |
| I | Connection Lifecycle | 8 | 0-RTT resumption, pooling, migration |
| J | QUIC Transport Tuning | 7 | Tune quinn for ultra-low latency |
| K | Serialization Optimization | 7 | Faster CBOR/JSON, SIMD, custom codecs |
| L | Kernel & Hardware | 8 | io_uring, SIMD crypto, DPDK/XDP |
| M | Benchmarking & Profiling | 7 | Continuous perf tracking, regression detection |

## Execution Order

```
Phase 1 (Q1): G (Zero-Copy) + M1-M3 (Benchmarking foundation)
Phase 2 (Q2): H (Lock-Free) + I1-I5 (0-RTT + Pooling) + M4-M5
Phase 3 (Q3): I6-I8 (Migration) + K (Serialization) + J1-J3 (QUIC Tuning) + M6-M7
Phase 4 (Q4): J4-J7 (QUIC Advanced) + L (Kernel/Hardware)
```

## Start Here (read these files before doing anything)

1. `implementation-plans/PERFORMANCE_OPTIMIZATION_PLAN.md` — Master plan with dependency graph
2. `implementation-plans/PERFORMANCE_STATUS.md` — Status tracker (update after every step)
3. `PERFORMANCE_REPORT.md` — Current benchmark results
4. `implementations/rust/PERFORMANCE_CRITERIA.md` — Original performance targets
5. `implementations/rust/AGENTS.md` — Build & test guide

Then read the plan files for the tracks you're executing:
6. `implementation-plans/track-g-zerocopy/G-zero-copy-data-path.md` — START HERE (Track G)
7. `implementation-plans/track-m-benchmarking/M-benchmarking-profiling.md` — Run M1-M3 in parallel with G

## How to Execute Each Step

1. **Read the step** in the track plan file
2. **Run the baseline benchmark** (before any changes)
3. **Implement the change** (code, tests)
4. **Run the benchmark again** (after the change)
5. **Compare before/after** — verify improvement is measurable
6. **Run full test suite** — `cargo test --workspace` (0 failures expected)
7. **Run clippy** — `cargo clippy --workspace -- -D warnings`
8. **Run fmt** — `cargo fmt --all -- --check`
9. **Update PERFORMANCE_STATUS.md** — mark step [x], update metrics
10. **Commit** — one commit per step, with before/after numbers in the message
11. **Push** — push to GitHub after each track completes (not every step)

## Commit Message Format

```bash
git commit -m "$(cat <<'EOF'
perf(track-step): <description>

Before: <metric> = <value>
After:  <metric> = <value>
Improvement: <Nx>

<explanation of what changed and why>

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

## Golden Rules (non-negotiable)

1. **NEVER sacrifice security for speed.** PQ handshake and identity verification are non-negotiable.
2. **NEVER break the wire protocol.** All optimizations must be wire-compatible. Golden traces must pass.
3. **NEVER skip benchmarking.** Every step must have before/after numbers.
4. **NEVER mark a step complete unless benchmarks show improvement.**
5. **NEVER use `unsafe` without a SAFETY comment and justification.**
6. **ALWAYS run `cargo test --workspace` before committing.** 0 failures expected.
7. **ALWAYS run `cargo clippy --workspace -- -D warnings` before committing.**
8. **ALWAYS run `cargo fmt --all -- --check` before committing.**
9. **ALWAYS update `PERFORMANCE_STATUS.md` in the same commit as the work.**
10. **If a step doesn't improve performance, investigate why before moving on.**
11. **If a step regresses performance, revert and investigate.**
12. **One optimization per commit.** Each commit should be independently measurable.

## Quick Verification Commands

```bash
# Build
cd /Users/david/Projects/AAFP-research/implementations/rust
cargo build --workspace

# Test
cargo test --workspace

# Lint
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check

# Benchmark
cargo bench --bench mcp_transport -- --warm-up-time 3 --measurement-time 5
cargo bench --bench framing
cargo bench --bench handshake

# Flamegraph (requires cargo-flamegraph)
cargo flamegraph --bench mcp_transport -- --bench-only

# Python tests (aafp-py)
source implementations/rust/crates/aafp-py/.venv/bin/activate
cd implementations/rust/crates/aafp-py
python -m pytest tests/ -v
```

## Submodule Workflow

```
/Users/david/Projects/AAFP-research/              <- umbrella repo
├── implementations/rust/                         <- submodule (github.com/davidnichols-ops/aafp)
└── implementations/go/                           <- submodule (github.com/davidnichols-ops/aafp-go)
```

When you commit in the Rust submodule:
```bash
cd implementations/rust
git add -A
git commit -m "..."
# Then update the umbrella:
cd /Users/david/Projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule — <brief description>"
```

Push after each track completes:
```bash
cd implementations/rust && git push origin master
cd /Users/david/Projects/AAFP-research && git push origin master
```

## When to Stop and Ask the User

1. **If a proposed optimization would change the wire protocol** (requires RFC amendment)
2. **If a dependency needs to be added** (check it's maintained and published >7 days ago)
3. **If `unsafe` code is required** and you're unsure about the safety justification
4. **If a benchmark regresses and you can't figure out why**
5. **If a track is blocked by an external factor** (e.g., quinn doesn't support a feature)

For everything else, make a decision and proceed. You have full autonomy.

## What "Done" Looks Like

- [ ] G: Zero-copy data path — 0 allocations per message, round-trip <150µs
- [ ] H: Lock-free concurrency — 8 concurrent senders >800K msg/s, DHT sharded
- [ ] I: Connection lifecycle — 0-RTT resumption, connection pooling, migration
- [ ] J: QUIC tuning — BBR congestion control, tuned buffers, GSO, round-trip <50µs
- [ ] K: Serialization — simd-json, minicbor, custom codecs, encode <2µs
- [ ] L: Kernel/hardware — SIMD crypto, io_uring, runtime tuning, round-trip <30µs
- [ ] M: Benchmarking — CI regression detection, flamegraphs, allocation tracking, dashboard
- [ ] PERFORMANCE_STATUS.md shows all 52 steps [x]
- [ ] PERFORMANCE_REPORT.md updated with final results
- [ ] All 1144+ tests still pass, clippy clean, fmt clean
- [ ] All changes committed and pushed to GitHub

## Begin

Start now. Read `implementation-plans/PERFORMANCE_OPTIMIZATION_PLAN.md` to confirm the plan.
Then read `implementation-plans/track-g-zerocopy/G-zero-copy-data-path.md` and begin G1
(benchmark allocation profile). Run M1-M3 in parallel (benchmarking infrastructure).

The first thing G1 asks you to do is measure the current allocation profile. Do that before
writing any optimization code. You cannot optimize what you cannot measure.
