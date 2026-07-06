# AAFP Benchmarking & Load Testing Plan

**Status:** Research / Planning Document
**Date:** 2026-07-05
**Scope:** Comprehensive benchmarking strategy, load testing framework, performance budgets, profiling guides, and CI integration for the AAFP protocol stack.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Benchmark Inventory](#2-current-benchmark-inventory)
3. [New Benchmarks Needed](#3-new-benchmarks-needed)
4. [Load Testing Framework](#4-load-testing-framework)
5. [Load Test Scenarios](#5-load-test-scenarios)
6. [Sustained Throughput (Soak) Testing](#6-sustained-throughput-soak-testing)
7. [Spike Testing](#7-spike-testing)
8. [Network Condition Testing](#8-network-condition-testing)
9. [Cross-Language Performance Comparison](#9-cross-language-performance-comparison)
10. [Benchmark CI Integration](#10-benchmark-ci-integration)
11. [Profiling Guide](#11-profiling-guide)
12. [Performance Budget](#12-performance-budget)
13. [Concrete Load Test Scripts](#13-concrete-load-test-scripts)
14. [Expected Results & Acceptance Criteria](#14-expected-results--acceptance-criteria)

---

## 1. Executive Summary

The AAFP Rust implementation already includes a substantial benchmark suite
(16 Criterion benchmarks) and a load test harness (`aafp-loadtest` crate with
topology generation, metrics collection, and a stability/soak-test binary).
The current `PERFORMANCE_REPORT.md` shows all crypto and framing targets are
met with large margins on Apple M4 hardware.

This document plans the **next phase**: scaling benchmarks to production-grade
workloads (1K–100K agents), adding missing micro-benchmarks (handshake
throughput, RPC tail latency, streaming, DHT-at-scale, PubSub fan-out),
establishing a formal performance budget, integrating regression detection
into CI, and providing profiling runbooks for production incidents.

**Key gaps addressed:**
- No percentile-latency benchmarks for the full RPC round-trip path
- No connection-pool hit-rate measurement under realistic churn
- DHT benchmarks stop at 100 nodes (need 1K–10K)
- No PubSub/streaming throughput benchmarks
- No spike-recovery or network-condition (latency/loss) test scenarios
- No cross-language performance comparison (Rust vs Go vs TypeScript)
- No automated performance regression gate in CI
- No formal per-operation performance budget with enforcement

---

## 2. Current Benchmark Inventory

The `aafp-benchmark` crate (`implementations/rust/crates/aafp-benchmark/`)
contains 16 Criterion benchmark binaries, all using `harness = false` with
Criterion 0.5.1. Methodology: warmup 1–3s, measurement 3–5s, sample size
10–100 depending on the benchmark.

### 2.1 Cryptography (`benches/handshake.rs`)

| Benchmark | What it measures | Current result |
|-----------|-----------------|----------------|
| `mldsa65_keypair` | ML-DSA-65 key generation | 133 µs |
| `mldsa65_sign` | ML-DSA-65 signature | 272 µs |
| `mldsa65_verify` | ML-DSA-65 verification | 76 µs |
| `pq_handshake_full` | Full PQ handshake (client_init + server_handle + client_finish) | 709 µs |
| `aead_encrypt_1kb_chacha20` | ChaCha20-Poly1305 encrypt 1KB | 1.63 µs |
| `aead_decrypt_1kb_chacha20` | ChaCha20-Poly1305 decrypt 1KB | 1.64 µs |
| `aead_encrypt_1kb_aes256gcm` | AES-256-GCM encrypt 1KB (SIMD) | — |
| `aead_decrypt_1kb_aes256gcm` | AES-256-GCM decrypt 1KB (SIMD) | — |
| `aead_encrypt_64b_chacha20` | Small-message encrypt (64B) | — |
| `aead_encrypt_64b_aes256gcm` | Small-message encrypt (64B) | — |

**File:** `benches/handshake.rs` (119 lines). Uses the legacy
`PqHandshake` (marked `#![allow(deprecated)]`) for the full handshake
benchmark. The v1 handshake state machine in `aafp-core::handshake_state`
is not yet benchmarked directly.

### 2.2 Discovery / DHT (`benches/discovery.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `dht_put` | Single DHT record insertion (CapabilityDht) |
| `dht_get_100_agents` | DHT lookup with 100 records |
| `agent_record_create` | AgentRecord creation + signing |
| `agent_record_verify` | AgentRecord signature verification |
| `dht_routing_10_nodes` | DhtRouter iterative lookup, 10-node mesh |
| `dht_routing_50_nodes` | DhtRouter iterative lookup, 50-node mesh |
| `dht_routing_100_nodes` | DhtRouter iterative lookup, 100-node mesh |

**File:** `benches/discovery.rs` (201 lines). Uses
`InMemoryDhtNetwork` with full mesh peer injection. Each node announces
its record; lookup is performed with cache invalidated per iteration.
**Gap:** Stops at 100 nodes. Needs 1K, 5K, 10K node scenarios.

### 2.3 Messaging / Framing (`benches/messaging.rs`, `benches/framing.rs`)

| Benchmark | What it measures | Current result |
|-----------|-----------------|----------------|
| `frame_serialize_1kb` | Frame encode 1KB | 66 ns |
| `frame_deserialize_1kb` | Frame decode 1KB | 35 ns |
| `frame_encode/{64,256,1024,4096,16384,65536}` | Encode at various sizes | 28 ns – 1.81 µs |
| `frame_decode/{64,256,1024,4096,16384,65536}` | Decode at various sizes | 15 ns – 1.60 µs |

**Files:** `benches/messaging.rs` (24 lines), `benches/framing.rs` (32 lines).
Framing benchmark covers 6 payload sizes from 64B to 64KB.

### 2.4 MCP Transport (`benches/mcp_transport.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `mcp_transport_ping/round_trip` | Full JSON-RPC ping round-trip over QUIC |
| `mcp_transport_one_way/send_{10,100,1000}` | One-way throughput (10/100/1000 messages) |

**File:** `benches/mcp_transport.rs` (165 lines). Sets up a real
client-server pair with `AafpMcpTransport` over QUIC (quinn + rustls,
X25519MLKEM768). Prints environment summary via `env_report`.

### 2.5 Connection Lifecycle (`benches/connection_lifecycle.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `cold_connect` | First connection (full TLS handshake, no session cache) |
| `warm_connect` | Second connection (TLS session resumption) |
| `pooled_connect` | Open new bidi stream on existing connection |
| `100_rpcs_no_pool` | 100 sequential connections (no pooling) |
| `100_rpcs_with_pool` | 1 connection + 100 stream opens (pooled) |
| `rebind_endpoint` | QUIC connection migration (rebind UDP socket) |

**File:** `benches/connection_lifecycle.rs` (377 lines). Uses
`iter_custom` for precise wall-clock measurement. Demonstrates the
connection pool value proposition (Track I5/I8).

### 2.6 Lock Contention (`benches/lock_contention.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `lock_contention_concurrent_senders/{1,2,4,8}` | Mutex send path, N concurrent senders |
| `lock_contention_raw/{1,2,4,8}` | Raw throughput (no criterion wrapper) |
| `lockfree_channel_senders/{1,2,4,8}` | Channel-based send (Track H2) |
| `connection_handle_lockfree/{1,2,4,8}` | Full lock-free path (ConnectionHandle, Track H7) |

**File:** `benches/lock_contention.rs` (504 lines). Compares the
`Arc<Mutex<Option<QuicSendStream>>>` path against the mpsc channel path
and the full `ConnectionHandle` lock-free path. Each sender sends 1000
messages; server receives all.

### 2.7 QUIC Tuning (`benches/quic_tuning.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `quic_tuning_small_message/default_config` | 100B round-trip, Cubic |
| `quic_tuning_small_message/low_latency_bbr` | 100B round-trip, BBR |
| `quic_tuning_small_message/newreno_config` | 100B round-trip, NewReno |
| `quic_tuning_stream_open/low_latency_bbr` | Stream open latency (BBR) |

**File:** `benches/quic_tuning.rs` (242 lines). Tests congestion
controller impact on small-message RPC latency.

### 2.8 Serialization (`benches/serialization.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `serialization_json/serde_json/{encode,decode}_{initialize,tools_list}` | serde_json encode/decode |
| `serialization_json/simd_json/{encode,decode}_{initialize,tools_list}` | simd-json encode/decode |
| `serialization_cbor/aafp_cbor/{encode,decode}_rpc_request` | CBOR encode/decode |

**File:** `benches/serialization.rs` (232 lines). Compares serde_json
vs simd-json for MCP messages and aafp_cbor for AAFP protocol messages.

### 2.9 Runtime Tuning (`benches/runtime_tuning.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `runtime_tuning_multi_thread/round_trip` | Multi-thread Tokio runtime RPC |
| `runtime_tuning_current_thread/round_trip` | Current-thread Tokio runtime RPC |
| `runtime_tuning_scheduling/yield_{multi,current}_thread` | Task scheduling overhead |

**File:** `benches/runtime_tuning.rs` (180 lines). L5 profiling showed
84% of time in condvar wait with multi-thread runtime; current-thread
eliminates cross-thread scheduling overhead.

### 2.10 Allocation Profiling (`benches/alloc_profile.rs`)

| Benchmark | What it measures |
|-----------|-----------------|
| `alloc_profile_send_path` | Allocations per send (JSON ser + frame + encode) |
| `alloc_profile_recv_path` | Allocations per recv (decode + JSON deser) |
| `alloc_profile_round_trip` | Total allocations for send + recv |
| `alloc_profile_large_msg` | Allocations for tools/list (larger message) |
| `alloc_profile_preallocated` | Allocations with pre-allocated buffer |
| `alloc_profile_zerocopy_send` | Zero-copy send (buffer pool + to_writer) |
| `alloc_profile_zerocopy_recv` | Zero-copy recv (buffer pool + freeze) |

**File:** `benches/alloc_profile.rs` (268 lines). Uses the
`CountingAllocator` global allocator wrapper from `alloc_tracker.rs`.

### 2.11 Timing Analysis (`benches/timing_analysis.rs`)

Side-channel analysis (Track Q5): measures timing differences in
signature verification (valid vs invalid), AgentId comparison (matching
vs first-byte-diff vs last-byte-diff), ReplayCache (hit vs miss), and
CBOR decode (valid vs truncated vs random).

### 2.12 Close Manager (`benches/close_manager.rs`)

9 benchmarks covering all CloseManager state transitions: initiate,
graceful full, forced abort, flood (1000 frames during close), frame
disposition, can_send, respond, crossed close, timeout.

### 2.13 Replay Cache (`benches/replay_cache.rs`)

6 benchmarks: check_and_insert (fresh, replay), check (fresh, existing),
100K-entry cache insert, and eviction of 10K expired entries.

### 2.14 Session (`benches/session.rs`)

`memory_per_session` (sizeof = 168 bytes) and
`create_1000_sessions` (19 µs for 1000 sessions).

### 2.15 Supporting Infrastructure

- **`harness.rs`** (352 lines): Criterion-free `BenchmarkRunner` with
  p50/p90/p99/p99.9, mean, stddev, and `compare_results()` for baseline
  comparison with 5% significance threshold.
- **`alloc_tracker.rs`** (239 lines): `CountingAllocator` global
  allocator wrapper with `track_allocs()` / `track_allocs_with_result()`.
- **`env_report.rs`** (288 lines): `SystemInfo` collection (CPU, OS,
  Rust version, arch) and structured environment summary printing.

### 2.16 Load Test Harness (`aafp-loadtest` crate)

- **`config.rs`**: `LoadTestConfig` (num_agents, messages_per_agent,
  message_size, duration, topology, max_connections, concurrency).
  Presets: `smoke()`, `agents_100()`.
- **`topology.rs`**: Mesh, Star, Ring, Random topologies with
  deterministic edge generation (LCG-seeded random).
- **`runner.rs`** (459 lines): `run_load_test()` — creates N agents,
  starts server echo loops, connects per topology, sends messages with
  bounded concurrency, collects metrics.
- **`metrics.rs`** (355 lines): `LoadTestMetrics` with p50/p90/p99/p99.9
  latency, throughput (msg/s, bytes/s), error rate, connection counts,
  resource usage (RSS via `/proc` or mach `task_info`).
- **`bin/loadtest.rs`** (109 lines): CLI with `--agents`, `--messages`,
  `--size`, `--topology`, `--duration`, `--output` flags.
- **`bin/stability.rs`** (463 lines): Long-running stability test with
  periodic metrics logging, memory growth analysis, leak detection
  (>10% growth = FAIL).

---

## 3. New Benchmarks Needed

### 3.1 Handshake Throughput

**Goal:** Measure handshakes/second under sustained load, not just
single-handshake latency.

**Benchmark:** `handshake_throughput`

```
handshake_throughput/serial_1000       — 1000 sequential handshakes
handshake_throughput/concurrent_10     — 10 parallel handshakes
handshake_throughput/concurrent_100    — 100 parallel handshakes
handshake_throughput/concurrent_1000   — 1000 parallel handshakes
```

**Methodology:** Pre-generate N keypairs. For each handshake, create a
fresh `PqHandshake::client_init()`, `server_handle()`, `client_finish()`
triple. For concurrent variants, use `tokio::spawn` + `JoinSet` with a
semaphore for bounded concurrency. Measure total wall-clock time and
compute handshakes/sec.

**Expected:** Serial ≥ 1,400/s (based on 709 µs/handshake). Concurrent
should scale near-linearly until CPU-bound (~10K/s on 8-core).

### 3.2 RPC Latency Percentiles (p50/p95/p99)

**Goal:** Full round-trip RPC latency distribution, not just mean.

**Benchmark:** `rpc_latency_percentiles`

```
rpc_latency/ping_1kb/p50
rpc_latency/ping_1kb/p95
rpc_latency/ping_1kb/p99
rpc_latency/tools_call_10kb/p50
rpc_latency/tools_call_10kb/p95
rpc_latency/tools_call_10kb/p99
rpc_latency/streaming_chunk_64kb/p50
rpc_latency/streaming_chunk_64kb/p95
rpc_latency/streaming_chunk_64kb/p99
```

**Methodology:** Use the custom `BenchmarkRunner` from `harness.rs`
(which records per-iteration times and computes percentiles) rather than
Criterion's statistical model. Run 10,000 iterations per scenario on a
pre-established connection (no handshake per iteration). Report p50, p95,
p99, p99.9, max.

**Why not Criterion:** Criterion reports mean and slope, not tail
percentiles. For latency SLAs, p99 and p99.9 are the critical metrics.

### 3.3 Streaming Throughput

**Goal:** Sustained throughput for bidirectional streams (not
request-response).

**Benchmark:** `streaming_throughput`

```
streaming/unidirectional_1mb
streaming/unidirectional_10mb
streaming/unidirectional_100mb
streaming/bidirectional_1mb
streaming/bidirectional_10mb
```

**Methodology:** Open a single bidirectional QUIC stream. Sender writes
chunks of 64KB in a tight loop; receiver reads and discards. Measure
bytes/sec. For bidirectional, both sides send simultaneously. Use
`Throughput::Bytes(total_bytes)` in Criterion.

**Expected:** ≥ 5 Gbps on localhost (limited by QUIC flow control and
memcpy, not crypto). ≥ 1 Gbps over 1Gbps LAN.

### 3.4 Connection Pool Hit Rate

**Goal:** Measure pool effectiveness under realistic connection patterns
(open/close/reopen cycles).

**Benchmark:** `connection_pool_hit_rate`

```
pool/hit_rate_100_rpcs
pool/hit_rate_1000_rpcs
pool/hit_rate_churn_10pct     — 10% connection churn
pool/hit_rate_churn_50pct     — 50% connection churn
pool/hit_rate_churn_100pct    — 100% connection churn (worst case)
```

**Methodology:** Simulate a workload where an agent makes N RPC calls to
M peers. With a connection pool, the first call to each peer is a "miss"
(full handshake); subsequent calls are "hits" (stream open on existing
connection). Inject churn by randomly closing connections at the
configured rate. Track hit/miss counters and report hit rate percentage.

**Expected:** 0% churn → >99% hit rate. 50% churn → ~75% hit rate.
100% churn → 0% hit rate (every call is a full handshake).

### 3.5 DHT Lookup at Scale

**Goal:** DhtRouter lookup latency and success rate at 1K–10K nodes.

**Benchmark:** `dht_lookup_scale`

```
dht_lookup/500_nodes
dht_lookup/1000_nodes
dht_lookup/5000_nodes
dht_lookup/10000_nodes
```

**Methodology:** Extend the existing `setup_dht_network()` in
`discovery.rs` to larger N. For 10K nodes, use a partial mesh (not full
N² peer injection — each node knows only its K closest peers per
Kademlia k-bucket). Measure `find_peers()` latency with cache
invalidated. Track lookup success rate (did we find the target?).

**Memory consideration:** 10K nodes × ~1KB/record = ~10MB. 10K
DhtRouters × ~168 bytes = ~1.7MB. Feasible in-process.

**Expected:** Lookup latency should be O(log N) — 10 nodes: ~1ms, 100
nodes: ~2ms, 1000 nodes: ~3ms, 10000 nodes: ~4ms (plus network RTT in
real deployment).

### 3.6 PubSub Fan-Out

**Goal:** Message delivery throughput when one publisher sends to N
subscribers.

**Benchmark:** `pubsub_fanout`

```
pubsub/fanout_10
pubsub/fanout_100
pubsub/fanout_1000
pubsub/fanout_10000
```

**Methodology:** One publisher agent, N subscriber agents. Publisher
sends M messages; each message must be delivered to all N subscribers.
Measure: (a) time-to-first-delivery, (b) time-to-last-delivery,
(c) messages/sec aggregate, (d) delivery success rate.

**Note:** AAFP does not yet have a dedicated PubSub layer. This
benchmark assumes a future `aafp-pubsub` crate or uses the existing
multicast-via-multiple-streams approach. If PubSub is not implemented,
this benchmark serves as the design driver.

**Expected:** Fan-out 10 → <1ms delivery. Fan-out 1000 → <10ms (if
using shared-connection multiplexing). Aggregate throughput should scale
linearly with subscriber count until network/CPU bound.

---

## 4. Load Testing Framework

### 4.1 Existing Framework (`aafp-loadtest`)

The existing `aafp-loadtest` crate provides:
- **Agent spawning:** Creates N `Agent` instances, each binding to
  `127.0.0.1:0` (ephemeral port).
- **Topology generation:** Mesh, Star, Ring, Random (deterministic).
- **Message flow:** Client connects to peer, completes AAFP v1
  handshake, sends M messages of S bytes with C concurrency, server
  echoes back.
- **Metrics:** Throughput (msg/s, bytes/s), latency percentiles
  (p50/p90/p99/p99.9), error rate, connection counts, RSS memory.
- **CLI:** `cargo run -p aafp-loadtest --features cli --bin loadtest --
  --agents N --messages M --topology star`
- **Stability binary:** `--bin stability` for long-running soak tests
  with periodic metrics logging and leak detection.

### 4.2 Enhancements Needed

#### 4.2.1 Simulated Agent Scaling (1K–100K)

The current harness creates real QUIC endpoints per agent. At 100K
agents, this requires 100K UDP sockets — infeasible on a single machine.

**Solution: Hybrid real+simulated agents.**

- **Real agents (≤ 1K):** Full QUIC endpoints, real handshakes, real
  message exchange. This is what the current harness does.
- **Simulated agents (> 1K):** Lightweight structs that model the
  connection state machine, DHT routing table, and message queue without
  actual network I/O. A single "real" agent proxies for many simulated
  agents, multiplexing their traffic over shared QUIC connections.

**New module:** `aafp-loadtest/src/simulated_agent.rs`

```rust
pub struct SimulatedAgent {
    agent_id: AgentId,
    capabilities: Vec<String>,
    connections: HashMap<AgentId, ConnectionState>,
    message_queue: VecDeque<Message>,
    dht_routing_table: KBucketTable,
}
```

The load generator spawns N simulated agents, each generating traffic at
a configured rate (M RPC/s). A pool of R real agents (R << N) acts as
the network backbone, carrying the multiplexed traffic.

#### 4.2.2 Traffic Pattern Generator

**New module:** `aafp-loadtest/src/traffic.rs`

```rust
pub enum TrafficPattern {
    /// Constant rate: M messages/second per agent.
    Constant { rate_per_agent: f64 },
    /// Poisson process: exponential inter-arrival.
    Poisson { lambda: f64 },
    /// Burst: M messages in a short window, then idle.
    Burst { messages: usize, interval: Duration },
    /// Ramp: linearly increase rate from 0 to max over duration.
    Ramp { max_rate: f64 },
    /// Diurnal: sinusoidal rate (simulates day/night cycle).
    Diurnal { peak_rate: f64, period: Duration },
}
```

#### 4.2.3 Metrics Export

Add Prometheus-compatible metrics export (in addition to JSON):

```rust
pub struct MetricsExporter {
    prometheus_endpoint: Option<String>,  // e.g., ":9090"
    json_output: Option<PathBuf>,
    csv_timeseries: Option<PathBuf>,  // for plotting
}
```

---

## 5. Load Test Scenarios

### 5.1 Scenario: 1K Agents

| Parameter | Value |
|-----------|-------|
| Agents | 1,000 (real) |
| Topology | Random (degree 10) |
| Messages/agent | 100 |
| Message size | 1 KB |
| Concurrency | 16 |
| Duration | 5 minutes |
| Expected throughput | ≥ 50,000 msg/s |
| Expected p99 latency | < 10 ms |
| Expected error rate | < 1% |

**Command:**
```bash
cargo run -p aafp-loadtest --features cli --bin loadtest -- \
  --agents 1000 --messages 100 --size 1024 \
  --topology random --degree 10 --concurrency 16 \
  --duration 300 --output results/1k_agents.json
```

### 5.2 Scenario: 10K Agents

| Parameter | Value |
|-----------|-------|
| Agents | 10,000 (1,000 real + 9,000 simulated) |
| Topology | Random (degree 5) |
| Messages/agent | 50 |
| Message size | 1 KB |
| Concurrency | 32 (per real agent) |
| Duration | 10 minutes |
| Expected throughput | ≥ 100,000 msg/s aggregate |
| Expected p99 latency | < 50 ms |
| Expected error rate | < 2% |

**Note:** With 10K agents and degree-5 random topology, there are 50K
edges. With 1K real agents proxying, each real agent handles ~50
connections. This tests connection pool effectiveness and stream
multiplexing.

### 5.3 Scenario: 100K Agents (Simulated)

| Parameter | Value |
|-----------|-------|
| Agents | 100,000 (100 real + 99,900 simulated) |
| Topology | Random (degree 3) |
| Messages/agent | 10 |
| Message size | 512 bytes |
| Concurrency | 64 (per real agent) |
| Duration | 15 minutes |
| Expected throughput | ≥ 500,000 msg/s aggregate |
| Expected p99 latency | < 200 ms |
| Expected error rate | < 5% |

**Note:** This is primarily a simulation test. The 100 real agents form
the backbone; simulated agents generate traffic that is multiplexed
through them. This tests: (a) DHT routing at 100K scale, (b) connection
pool under extreme multiplexing, (c) memory footprint per simulated
agent (target: < 1 KB), (d) scheduler fairness under 100K tasks.

### 5.4 Scenario Matrix

| Scenario | Agents | Real/Sim | Topology | Msgs/Agent | Size | Duration |
|----------|--------|----------|----------|------------|------|----------|
| Smoke | 10 | 10/0 | Mesh | 10 | 256B | 30s |
| Small | 100 | 100/0 | Star | 100 | 1KB | 2min |
| Medium | 1K | 1K/0 | Random(10) | 100 | 1KB | 5min |
| Large | 10K | 1K/9K | Random(5) | 50 | 1KB | 10min |
| XLarge | 100K | 100/99.9K | Random(3) | 10 | 512B | 15min |
| Star Hub | 1K | 1K/0 | Star | 1000 | 1KB | 5min |
| Ring | 1K | 1K/0 | Ring | 100 | 1KB | 5min |

---

## 6. Sustained Throughput (Soak) Testing

### 6.1 24-Hour Soak Test

The existing `stability` binary (`aafp-loadtest/src/bin/stability.rs`)
already supports long-running tests with periodic metrics logging and
memory leak detection. The 24-hour configuration:

```bash
cargo run -p aafp-loadtest --features cli --bin stability -- \
  --duration 86400 \
  --clients 50 \
  --rate 10 \
  --size 1024 \
  --interval 300 \
  --output results/soak_24h.json
```

| Parameter | Value |
|-----------|-------|
| Duration | 86,400 seconds (24 hours) |
| Clients | 50 persistent connections |
| Rate | 10 msg/s per client (500 msg/s total) |
| Message size | 1 KB |
| Metrics interval | 300 seconds (5 minutes) |

### 6.2 Memory Leak Detection

The stability binary already implements leak detection:
- **Baseline:** Second metrics sample (after warmup, all clients connected).
- **Threshold:** < 10% memory growth over 24 hours.
- **Verdict:** `PASS` if growth < 10%, `FAIL` otherwise.

**Enhancement needed:** Add per-component memory tracking:
- Tokio task count (detect task leaks)
- Connection count (detect connection leaks)
- DHT routing table size (detect routing table bloat)
- ReplayCache entry count (detect cache leak)
- Buffer pool size (detect pool leak)

```rust
pub struct ComponentMemory {
    tokio_tasks: usize,
    active_connections: usize,
    dht_entries: usize,
    replay_cache_entries: usize,
    buffer_pool_size: usize,
    rss_bytes: u64,
}
```

### 6.3 Soak Test Acceptance Criteria

| Metric | Target | Hard Limit |
|--------|--------|------------|
| Memory growth (24h) | < 5% | < 10% |
| Error rate | < 0.1% | < 1% |
| p99 latency drift | < 2x initial | < 5x initial |
| Throughput drift | < 10% decrease | < 30% decrease |
| Connection leaks | 0 | 0 |
| File descriptor growth | < 100 | < 500 |

### 6.4 Shorter Soak Variants

| Variant | Duration | Rate | Purpose |
|---------|----------|------|---------|
| Quick soak | 1 hour | 100 msg/s | CI nightly |
| Standard soak | 4 hours | 50 msg/s | Pre-release |
| Full soak | 24 hours | 10 msg/s | Production certification |

---

## 7. Spike Testing

### 7.1 10x Traffic Spike

**Goal:** Measure recovery time when traffic suddenly increases 10x.

**Test design:**
1. **Baseline phase (5 min):** 100 agents, 100 msg/s aggregate.
2. **Spike phase (2 min):** Same agents, 1,000 msg/s aggregate (10x).
3. **Recovery phase (10 min):** Back to 100 msg/s. Measure time for
   p99 latency to return within 2x of baseline.

**Metrics collected:**
- p99 latency over time (per-second granularity)
- Throughput over time
- Error rate over time
- Connection establishment rate during spike
- Time-to-recovery (latency returns to < 2x baseline)

**Implementation:** New binary `aafp-loadtest/src/bin/spike.rs`:

```rust
// Phase 1: baseline
run_phase(config, Duration::from_secs(300), 100.0).await;
// Phase 2: spike
run_phase(config, Duration::from_secs(120), 1000.0).await;
// Phase 3: recovery
run_phase(config, Duration::from_secs(600), 100.0).await;
```

### 7.2 Connection Spike

**Goal:** 1,000 simultaneous new connections in 1 second.

**Test design:**
1. Server agent running with connection pool.
2. At T=0, spawn 1,000 client tasks that all connect simultaneously.
3. Measure: time for all connections to establish, handshake success
   rate, server CPU/memory during spike.

**Expected:** All 1,000 connections within 5 seconds. Handshake success
> 99%. Server memory increase < 50MB.

### 7.3 Spike Test Acceptance Criteria

| Metric | Target |
|--------|--------|
| Time-to-recovery (latency) | < 30 seconds |
| Error rate during spike | < 5% |
| Throughput during spike | ≥ 80% of requested rate |
| Post-spike latency | < 2x baseline within 1 minute |
| No crash/OOM | Server stays alive throughout |

---

## 8. Network Condition Testing

### 8.1 Simulated Latency

**Tool:** `tc` (Linux traffic control) or `Network Link Conditioner`
(macOS). For in-process simulation, add a `DelayLayer` to the transport
that injects `tokio::time::sleep` before each send/receive.

**Test matrix:**

| Latency | Scenarios |
|---------|-----------|
| 0 ms | Baseline (localhost) |
| 50 ms | Cross-region (e.g., US East ↔ US West) |
| 200 ms | Intercontinental (e.g., US ↔ Europe) |
| 500 ms | High-latency (e.g., US ↔ Asia Pacific) |

**Metrics per latency level:**
- RPC round-trip p50/p95/p99
- Handshake completion time
- Throughput (msg/s and bytes/s)
- QUIC congestion window behavior

**Expected:** RPC p50 ≈ 2× latency (round-trip). Throughput should
decrease with latency but not collapse (QUIC's BBR should maintain
reasonable window sizes).

### 8.2 Simulated Packet Loss

**Tool:** `tc netem loss` (Linux) or `Network Link Conditioner` (macOS).

**Test matrix:**

| Packet loss | Scenarios |
|-------------|-----------|
| 0% | Baseline |
| 1% | Mild loss (mobile/congested WiFi) |
| 5% | Severe loss (degraded network) |

**Metrics per loss level:**
- Message delivery success rate
- Retransmission count
- Effective throughput vs theoretical
- Handshake success rate
- Time to detect and recover from loss

**Expected:** At 1% loss, throughput should be ≥ 70% of baseline (QUIC's
loss recovery is efficient). At 5% loss, throughput ≥ 30% of baseline.
Handshake success should remain > 95% even at 5% loss (handshake is
small, retransmittable).

### 8.3 Combined Latency + Loss Matrix

| | 0% loss | 1% loss | 5% loss |
|---|---------|---------|---------|
| 0ms | baseline | mild | severe |
| 50ms | cross-region | realistic WAN | degraded WAN |
| 200ms | intercontinental | high-latency + loss | poor |
| 500ms | high-latency | very poor | worst case |

Each cell runs a 5-minute load test with 100 agents, 100 msg/s, 1KB
messages. Total: 12 test runs × 5 min = 60 minutes.

### 8.4 Implementation: Network Condition Simulator

**New module:** `aafp-loadtest/src/net_condition.rs`

```rust
pub struct NetworkCondition {
    pub latency: Duration,
    pub jitter: Duration,
    pub packet_loss: f64,  // 0.0 to 1.0
    pub bandwidth_limit: Option<u64>,  // bytes/sec
}

impl NetworkCondition {
    /// Apply via `tc netem` on Linux.
    pub fn apply_tc(&self, interface: &str) -> Result<()>;

    /// In-process simulation (cross-platform, no root needed).
    pub fn apply_in_process(&self, transport: &mut QuicTransport);
}
```

For CI (where `tc` may not be available), use the in-process simulator
that wraps send/receive with `tokio::time::sleep` and probabilistic
packet dropping.

---

## 9. Cross-Language Performance Comparison

### 9.1 Implementations Available

| Language | Location | Status |
|----------|----------|--------|
| Rust | `implementations/rust/` | Full implementation (reference) |
| Go | `implementations/go/` | Partial (CBOR, frame, close manager, ML-DSA interop) |
| TypeScript | `implementations/typescript/` | Partial (packages, tests) |

**Note:** No Python implementation exists in the repository. The
`aafp-py` crate is a PyO3 adapter wrapping the Rust implementation, not
a native Python implementation. For cross-language comparison, we
compare Rust vs Go vs TypeScript.

### 9.2 Comparison Benchmarks

Each implementation runs the same workload and reports identical metrics
(JSON output). A comparison script aggregates results.

**Workload:** "Standard AAFP Microbenchmark"
1. ML-DSA-65 keygen, sign, verify (1,000 iterations)
2. CBOR encode/decode 1KB (10,000 iterations)
3. Frame encode/decode 1KB (10,000 iterations)
4. AEAD encrypt/decrypt 1KB (10,000 iterations)
5. Full PQ handshake (1,000 iterations)

**Script:** `benchmarks/cross_lang_compare.sh`

```bash
#!/bin/bash
# Run cross-language performance comparison
set -e

RESULTS_DIR="results/cross_lang_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

# Rust
echo "=== Rust ==="
cargo bench --bench handshake --bench framing -- --output-format bencher \
  > "$RESULTS_DIR/rust.txt" 2>&1

# Go
echo "=== Go ==="
cd implementations/go
go test -bench=. -benchmem -count=10 ./... > "$RESULTS_DIR/go.txt" 2>&1
cd ../..

# TypeScript
echo "=== TypeScript ==="
cd implementations/typescript
npx vitest bench > "$RESULTS_DIR/typescript.txt" 2>&1
cd ../..

# Compare
python3 benchmarks/compare_results.py "$RESULTS_DIR"
```

### 9.3 Expected Performance Ratios

Based on typical language performance characteristics:

| Operation | Rust | Go | TypeScript (Node) |
|-----------|------|-----|-------------------|
| ML-DSA-65 keygen | 1.0x | ~1.5x slower | ~5x slower |
| ML-DSA-65 sign | 1.0x | ~1.5x slower | ~5x slower |
| CBOR encode 1KB | 1.0x | ~2x slower | ~3x slower |
| Frame encode 1KB | 1.0x | ~2x slower | ~3x slower |
| AEAD encrypt 1KB | 1.0x | ~1.2x slower | ~2x slower |
| PQ handshake | 1.0x | ~1.5x slower | ~5x slower |

**Note:** Go's ML-DSA library (`KarpelesLab/mldsa`) is a pure Go
implementation; Rust uses C FFI to a optimized library. Node's
`crypto.subtle` and WebCrypto APIs are native but have higher per-call
overhead. These ratios are estimates; actual measurements will replace
them.

### 9.4 Comparison Output Format

```json
{
  "comparison_date": "2026-07-05",
  "workload": "standard_aafp_microbenchmark",
  "results": {
    "rust": { "mldsa65_keygen_us": 133, "cbor_encode_1kb_ns": 850, ... },
    "go": { "mldsa65_keygen_us": 200, "cbor_encode_1kb_ns": 1700, ... },
    "typescript": { "mldsa65_keygen_us": 665, "cbor_encode_1kb_ns": 2550, ... }
  },
  "ratios": {
    "go_vs_rust": { "mldsa65_keygen": 1.50, ... },
    "typescript_vs_rust": { "mldsa65_keygen": 5.00, ... }
  }
}
```

---

## 10. Benchmark CI Integration

### 10.1 Performance Regression Detection

**Goal:** Automatically detect performance regressions on every PR and
nightly build.

**Approach:** Use Criterion's built-in baseline comparison + a custom
regression gate.

#### 10.1.1 Criterion Baselines

Criterion stores baselines in `target/criterion/`. On the main branch,
save a baseline:

```bash
cargo bench -- --save-baseline main
```

On a PR, compare against the baseline:

```bash
cargo bench -- --baseline main
```

Criterion outputs regression/improvement percentages. A regression >
5% on any benchmark triggers a warning; > 10% fails the CI check.

#### 10.1.2 Custom Regression Gate

**Script:** `ci/check_perf_regression.sh`

```bash
#!/bin/bash
# Check for performance regressions against the main baseline.
# Exits 1 if any benchmark regressed by more than the threshold.

THRESHOLD=10  # percent
BASELINE="main"
FAIL=0

# Run benchmarks and capture output
OUTPUT=$(cargo bench -- --baseline "$BASELINE" 2>&1)

# Parse Criterion output for regressions
while IFS= read -r line; do
    if echo "$line" | grep -q "regressed:"; then
        change=$(echo "$line" | grep -oP 'regressed: \K[0-9.]+')
        if (( $(echo "$change > $THRESHOLD" | bc -l) )); then
            echo "PERF REGRESSION: $line"
            FAIL=1
        fi
    fi
done <<< "$OUTPUT"

if [ $FAIL -eq 1 ]; then
    echo "Performance regression detected (threshold: ${THRESHOLD}%)"
    exit 1
fi
echo "No performance regressions detected."
exit 0
```

### 10.2 CI Pipeline Stages

| Stage | Trigger | Benchmarks | Threshold |
|-------|---------|------------|-----------|
| PR fast check | Every push | handshake, framing, session | 15% |
| PR full check | PR ready for review | All 16 benchmarks | 10% |
| Nightly | Schedule | All benchmarks + load tests | 5% |
| Weekly | Schedule | Cross-language + soak (4h) | 5% |
| Release | Tag | Full suite + 24h soak | 5% |

### 10.3 GitHub Actions Workflow

```yaml
name: Performance Regression Check
on:
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 2 * * *"  # Nightly at 2 AM UTC

jobs:
  benchmark:
    runs-on: [self-hosted, linux, x64, benchmark]
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - name: Restore baseline
        uses: actions/cache/restore@v4
        with:
          path: target/criterion
          key: criterion-baseline-${{ github.base_ref }}
      - name: Run benchmarks
        run: |
          cargo bench -p aafp-benchmark -- --baseline main
      - name: Check regressions
        run: bash ci/check_perf_regression.sh
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results
          path: target/criterion/

  nightly-load-test:
    if: github.event_name == 'schedule'
    runs-on: [self-hosted, linux, x64, benchmark]
    steps:
      - uses: actions/checkout@v4
      - name: Run 1K agent load test
        run: |
          cargo run -p aafp-loadtest --features cli --bin loadtest -- \
            --agents 1000 --messages 100 --size 1024 \
            --topology random --degree 10 --concurrency 16 \
            --duration 300 --output results/nightly_1k.json
      - name: Run 1-hour soak test
        run: |
          cargo run -p aafp-loadtest --features cli --bin stability -- \
            --duration 3600 --clients 50 --rate 100 \
            --size 1024 --interval 60 \
            --output results/nightly_soak_1h.json
```

### 10.4 Benchmark Machine Requirements

- **Dedicated hardware:** Performance benchmarks require a stable
  environment. Use a dedicated self-hosted runner (not shared CI).
- **CPU pinning:** Run benchmarks with `taskset` to pin to specific
  cores and avoid frequency scaling.
- **No other workloads:** Ensure no other CPU-intensive processes run
  during benchmarking.
- **Consistent environment:** Same OS, same kernel, same Rust version
  for all runs. The `env_report` module captures and logs this.

```bash
# Pin to cores 2-7, disable turbo boost
sudo cpupower frequency-set -g performance
taskset -c 2-7 cargo bench -- --baseline main
```

---

## 11. Profiling Guide

### 11.1 perf (Linux)

`perf` is the standard Linux profiler. Works at the kernel level with
minimal overhead.

```bash
# Build with debug symbols
cargo build --release

# Record a benchmark run
perf record -F 99 -g -- \
  cargo bench --bench mcp_transport -- --warm-up-time 1 --measurement-time 5

# Report (interactive)
perf report

# Flamegraph via perf
perf script | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg
```

**Key flags:**
- `-F 99`: Sample at 99 Hz (low overhead, sufficient resolution).
- `-g`: Record call graphs (stack traces).
- `--call-graph dwarf`: Use DWARF for stack unwinding (more accurate on
  Rust with heavy inlining).

```bash
perf record -F 99 --call-graph dwarf -- cargo bench --bench lock_contention
perf report --call-graph dwarf
```

### 11.2 flamegraph (Rust)

The `flamegraph` crate provides one-command profiling for Rust programs.

```bash
# Install
cargo install flamegraph

# Profile a benchmark
cargo flamegraph --bench mcp_transport -- --warm-up-time 1 --measurement-time 5

# Profile a specific binary
cargo flamegraph --bin loadtest -- --agents 100 --messages 1000
```

**Prerequisites:** `perf` (Linux) or `dtrace` (macOS) must be
installed. On macOS:

```bash
# Install dtrace (comes with Xcode)
sudo cargo flamegraph --bench mcp_transport
```

**Reading flamegraphs:**
- Width = time spent in function (including callees).
- Stack grows upward (root at bottom).
- Look for wide bars in unexpected places (e.g., `memcpy`, `malloc`,
  `mutex_lock`).
- Compare before/after optimization flamegraphs side by side.

### 11.3 tokio-console

`tokio-console` is the async task debugger for Tokio. It shows live task
states, polling durations, and waker statistics.

```bash
# Enable the tracing feature in Cargo.toml
# tokio = { version = "1", features = ["tracing"] }

# Run with console enabled
RUSTFLAGS="--cfg tokio_unstable" cargo run --features cli --bin loadtest -- \
  --agents 100 --messages 100 --duration 30 &

# Connect console
tokio-console http://localhost:6669
```

**What to look for:**
- **Long-running tasks:** Tasks that are polled for > 100 µs without
  yielding. These block the runtime.
- **High wake counts:** Tasks woken thousands of times per second
  indicate busy-looping.
- **Stuck tasks:** Tasks in `Pending` state for the entire duration
  (potential deadlock).
- **Task count growth:** Increasing task count indicates a task leak.

**Integration with load test:**

```rust
// In loadtest runner, enable console subscriber
#[cfg(feature = "console")]
console_subscriber::init();
```

### 11.4 heaptrack (Linux)

`heaptrack` is a heap profiler that tracks all allocations, their
call sites, and lifetimes.

```bash
# Install
sudo apt install heaptrack

# Profile a benchmark
heaptrack cargo bench --bench alloc_profile -- --warm-up-time 1 --measurement-time 5

# Analyze
heaptrack_gui heaptrack.cargo_bench.*.gz
```

**What to look for:**
- **Top allocators:** Functions that allocate the most bytes.
- **Leak suspects:** Allocations with no corresponding free at program
  exit.
- **Allocation hotspots:** Functions called millions of times, each
  allocating a small amount (death by a thousand cuts).
- **Temporary allocations:** Allocations with very short lifetimes
  (candidates for stack allocation or object pools).

**For the AAFP send path,** the `alloc_profile` benchmark already
identifies allocations per message. `heaptrack` provides the full
call-graph context.

### 11.5 Profiling Decision Matrix

| Symptom | Tool | Why |
|---------|------|-----|
| High CPU, don't know where | flamegraph | Visual hot path identification |
| High CPU, know the function | perf report | Detailed instruction-level analysis |
| Latency spikes | tokio-console | Async task scheduling issues |
| Memory growth | heaptrack | Allocation tracking + leak detection |
| Lock contention | perf + tokio-console | Mutex wait time + task blocking |
| Slow startup | perf stat | High-level counters (cache misses, branches) |

### 11.6 Profiling Checklist (Production Incident)

1. **Reproduce:** Run the failing load test scenario in a controlled
   environment.
2. **Flamegraph:** `cargo flamegraph` to identify the hot path.
3. **tokio-console:** Check for stuck tasks, long polls, high wake
   counts.
4. **heaptrack:** If memory-related, track allocations.
5. **perf stat:** Get hardware counters (cache misses, branch
   mispredictions).
6. **Compare:** Run the same scenario on the last known-good version.
   Diff the flamegraphs.
7. **Bisect:** `git bisect` with the benchmark as the test to find the
   regressing commit.

---

## 12. Performance Budget

### 12.1 Per-Operation Time Limits

| Operation | Budget | Current | Status | Enforcement |
|-----------|--------|---------|--------|-------------|
| ML-DSA-65 keygen | < 50 ms | 133 µs | PASS | CI benchmark |
| ML-DSA-65 sign | < 10 ms | 272 µs | PASS | CI benchmark |
| ML-DSA-65 verify | < 15 ms | 76 µs | PASS | CI benchmark |
| PQ handshake (crypto only) | < 1 ms | 709 µs | PASS | CI benchmark |
| Full handshake (QUIC + crypto) | < 500 ms | — | TBD | Load test |
| Frame encode 1KB | < 10 µs | 66 ns | PASS | CI benchmark |
| Frame decode 1KB | < 10 µs | 35 ns | PASS | CI benchmark |
| AEAD encrypt 1KB | < 5 µs | 1.63 µs | PASS | CI benchmark |
| AEAD decrypt 1KB | < 5 µs | 1.64 µs | PASS | CI benchmark |
| Session creation | < 1 µs | 30 ns | PASS | CI benchmark |
| sizeof(Session) | < 1 KB | 168 B | PASS | Static assert |
| RPC round-trip (localhost) | < 100 µs | — | TBD | New benchmark |
| RPC round-trip p99 (localhost) | < 1 ms | — | TBD | New benchmark |
| DHT lookup (100 nodes) | < 10 ms | — | TBD | CI benchmark |
| DHT lookup (10K nodes) | < 50 ms | — | TBD | New benchmark |
| Stream open (pooled) | < 100 µs | — | TBD | CI benchmark |
| Cold connect | < 500 ms | — | TBD | CI benchmark |
| Connection pool hit rate | > 90% | — | TBD | New benchmark |

### 12.2 Throughput Budgets

| Metric | Budget | Enforcement |
|--------|--------|-------------|
| Single-connection RPC throughput | > 10,000 msg/s | Load test |
| Aggregate throughput (1K agents) | > 50,000 msg/s | Load test |
| Streaming throughput (1 stream) | > 5 Gbps (localhost) | New benchmark |
| Handshake throughput | > 1,000/s (serial) | New benchmark |
| Handshake throughput (concurrent) | > 10,000/s | New benchmark |

### 12.3 Resource Budgets

| Resource | Budget | Per | Enforcement |
|----------|--------|-----|-------------|
| Memory (per connection) | < 100 KB | connection | Soak test |
| Memory (per session) | < 1 KB | session | Static assert |
| Memory (per DHT record) | < 2 KB | record | DHT benchmark |
| Memory growth (24h) | < 10% | process | Soak test |
| File descriptors | < 1,000 | process | Soak test |
| CPU (idle) | < 1% | process | Soak test |

### 12.4 Budget Enforcement

**Compile-time:** Static assertions for struct sizes.

```rust
const _: () = assert!(
    std::mem::size_of::<Session>() <= 1024,
    "Session must be < 1KB"
);
```

**CI-time:** Benchmark results compared against budget thresholds.

```bash
# In CI: fail if any benchmark exceeds its budget
python3 ci/check_budget.py results/latest.json budgets.yaml
```

**budgets.yaml:**
```yaml
mldsa65_keygen:
  max_us: 50000
  current_us: 133
frame_encode_1kb:
  max_ns: 10000
  current_ns: 66
rpc_roundtrip_localhost:
  max_us: 100
  current_us: null  # TBD
```

---

## 13. Concrete Load Test Scripts

### 13.1 Script: 1K Agent Load Test

**File:** `scripts/loadtest_1k.sh`

```bash
#!/bin/bash
set -euo pipefail

RESULTS_DIR="results/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "=== AAFP 1K Agent Load Test ==="
echo "Results: $RESULTS_DIR"

# Build
cargo build --release -p aafp-loadtest --features cli

# Run 1K agent test
./target/release/loadtest \
  --agents 1000 \
  --messages 100 \
  --size 1024 \
  --topology random \
  --degree 10 \
  --concurrency 16 \
  --duration 300 \
  --output "$RESULTS_DIR/1k_agents.json"

# Parse and check thresholds
python3 scripts/check_loadtest_thresholds.py \
  "$RESULTS_DIR/1k_agents.json" \
  --min-throughput 50000 \
  --max-p99-us 10000 \
  --max-error-rate 0.01

echo "=== 1K Agent Load Test Complete ==="
```

### 13.2 Script: 24-Hour Soak Test

**File:** `scripts/soak_24h.sh`

```bash
#!/bin/bash
set -euo pipefail

RESULTS_DIR="results/soak_$(date +%Y%m%d)"
mkdir -p "$RESULTS_DIR"

echo "=== AAFP 24-Hour Soak Test ==="
echo "Results: $RESULTS_DIR"

cargo build --release -p aafp-loadtest --features cli

# 24-hour soak: 50 clients, 10 msg/s each, 1KB messages
./target/release/stability \
  --duration 86400 \
  --clients 50 \
  --rate 10 \
  --size 1024 \
  --interval 300 \
  --output "$RESULTS_DIR/soak_24h.json"

# Analyze
python3 scripts/analyze_soak.py "$RESULTS_DIR/soak_24h.json" \
  --max-memory-growth-pct 10 \
  --max-error-rate 0.01 \
  --max-latency-drift 5.0

echo "=== 24-Hour Soak Test Complete ==="
```

### 13.3 Script: Spike Test

**File:** `scripts/spike_test.sh`

```bash
#!/bin/bash
set -euo pipefail

RESULTS_DIR="results/spike_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "=== AAFP Spike Test ==="

cargo build --release -p aafp-loadtest --features cli

# Phase 1: Baseline (5 min, 100 msg/s)
echo "Phase 1: Baseline (5 min, 100 msg/s)"
./target/release/loadtest \
  --agents 100 --messages 300 --size 1024 \
  --topology star --duration 300 --concurrency 8 \
  --output "$RESULTS_DIR/baseline.json"

# Phase 2: Spike (2 min, 1000 msg/s = 10x)
echo "Phase 2: Spike (2 min, 1000 msg/s)"
./target/release/loadtest \
  --agents 100 --messages 1200 --size 1024 \
  --topology star --duration 120 --concurrency 64 \
  --output "$RESULTS_DIR/spike.json"

# Phase 3: Recovery (10 min, 100 msg/s)
echo "Phase 3: Recovery (10 min, 100 msg/s)"
./target/release/loadtest \
  --agents 100 --messages 600 --size 1024 \
  --topology star --duration 600 --concurrency 8 \
  --output "$RESULTS_DIR/recovery.json"

# Analyze recovery time
python3 scripts/analyze_spike.py \
  "$RESULTS_DIR/baseline.json" \
  "$RESULTS_DIR/spike.json" \
  "$RESULTS_DIR/recovery.json" \
  --max-recovery-time-secs 30

echo "=== Spike Test Complete ==="
```

### 13.4 Script: Network Condition Matrix

**File:** `scripts/net_condition_matrix.sh`

```bash
#!/bin/bash
set -euo pipefail

RESULTS_DIR="results/netcond_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

cargo build --release -p aafp-loadtest --features cli

for latency in 0 50 200 500; do
  for loss in 0 1 5; do
    LABEL="latency_${latency}ms_loss_${loss}pct"
    echo "=== Running: $LABEL ==="

    # Apply network conditions (Linux tc)
    if [ "$latency" != "0" ] || [ "$loss" != "0" ]; then
      sudo tc qdisc add dev lo root netem \
        delay "${latency}ms" \
        loss "${loss}%" 2>/dev/null || true
    fi

    # Run 5-minute test
    ./target/release/loadtest \
      --agents 100 --messages 100 --size 1024 \
      --topology star --duration 300 --concurrency 8 \
      --output "$RESULTS_DIR/${LABEL}.json"

    # Remove network conditions
    sudo tc qdisc del dev lo root 2>/dev/null || true

    sleep 5  # cooldown between runs
  done
done

# Aggregate results
python3 scripts/aggregate_netcond.py "$RESULTS_DIR"
echo "=== Network Condition Matrix Complete ==="
```

### 13.5 Script: Full Benchmark Suite

**File:** `scripts/run_all_benchmarks.sh`

```bash
#!/bin/bash
set -euo pipefail

RESULTS_DIR="results/bench_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "=== AAFP Full Benchmark Suite ==="
echo "Results: $RESULTS_DIR"

# Run all 16 Criterion benchmarks
BENCHMARKS=(
  handshake discovery messaging mcp_transport
  framing session alloc_profile lock_contention
  connection_lifecycle quic_tuning serialization
  runtime_tuning timing_analysis close_manager replay_cache
)

for bench in "${BENCHMARKS[@]}"; do
  echo "=== Benchmark: $bench ==="
  cargo bench -p aafp-benchmark --bench "$bench" \
    -- --warm-up-time 3 --measurement-time 5 \
    2>&1 | tee "$RESULTS_DIR/${bench}.txt"
done

# Aggregate into JSON
python3 scripts/aggregate_benchmarks.py "$RESULTS_DIR"

echo "=== Full Benchmark Suite Complete ==="
```

---

## 14. Expected Results & Acceptance Criteria

### 14.1 Microbenchmark Expected Results

| Benchmark | Expected (Apple M4) | Expected (x86_64 server) |
|-----------|---------------------|--------------------------|
| ML-DSA-65 keygen | < 200 µs | < 500 µs |
| ML-DSA-65 sign | < 300 µs | < 800 µs |
| ML-DSA-65 verify | < 100 µs | < 200 µs |
| PQ handshake full | < 1 ms | < 2 ms |
| Frame encode 1KB | < 100 ns | < 200 ns |
| Frame decode 1KB | < 50 ns | < 100 ns |
| AEAD encrypt 1KB | < 2 µs | < 5 µs |
| RPC round-trip (localhost) | < 100 µs | < 200 µs |
| RPC round-trip p99 | < 500 µs | < 1 ms |
| Stream open (pooled) | < 50 µs | < 100 µs |
| Cold connect | < 300 ms | < 500 ms |

### 14.2 Load Test Expected Results

| Scenario | Throughput | p50 Latency | p99 Latency | Error Rate |
|----------|------------|-------------|-------------|------------|
| 100 agents | > 20K msg/s | < 1 ms | < 5 ms | < 0.1% |
| 1K agents | > 50K msg/s | < 2 ms | < 10 ms | < 1% |
| 10K agents | > 100K msg/s | < 10 ms | < 50 ms | < 2% |
| 100K agents | > 500K msg/s | < 50 ms | < 200 ms | < 5% |

### 14.3 Soak Test Expected Results

| Duration | Memory Growth | Error Rate | Latency Drift | Verdict |
|----------|--------------|------------|---------------|---------|
| 1 hour | < 2% | < 0.1% | < 1.5x | PASS |
| 4 hours | < 5% | < 0.1% | < 1.5x | PASS |
| 24 hours | < 10% | < 0.1% | < 2x | PASS |

### 14.4 Spike Test Expected Results

| Phase | Duration | Throughput | p99 Latency | Error Rate |
|-------|----------|------------|-------------|------------|
| Baseline | 5 min | 100 msg/s | < 5 ms | < 0.1% |
| Spike | 2 min | ≥ 800 msg/s | < 50 ms | < 5% |
| Recovery | 10 min | 100 msg/s | < 10 ms within 30s | < 0.5% |

### 14.5 Network Condition Expected Results

| Latency | Loss | Throughput (% of baseline) | p99 Latency |
|---------|------|---------------------------|-------------|
| 0 ms | 0% | 100% | < 5 ms |
| 0 ms | 1% | > 70% | < 20 ms |
| 0 ms | 5% | > 30% | < 100 ms |
| 50 ms | 0% | > 80% | < 120 ms |
| 50 ms | 1% | > 60% | < 150 ms |
| 200 ms | 0% | > 50% | < 450 ms |
| 200 ms | 1% | > 40% | < 500 ms |
| 500 ms | 0% | > 30% | < 1100 ms |

### 14.6 CI Regression Thresholds

| Benchmark Category | Warning | Failure |
|--------------------|---------|---------|
| Crypto (handshake) | > 5% | > 15% |
| Framing (messaging) | > 5% | > 15% |
| Transport (mcp_transport) | > 5% | > 10% |
| DHT (discovery) | > 5% | > 10% |
| Load test throughput | > 5% | > 10% |
| Load test p99 latency | > 10% | > 25% |

---

## Appendix A: Benchmark File Reference

| File | Lines | Benchmarks |
|------|-------|------------|
| `aafp-benchmark/benches/handshake.rs` | 119 | 10 crypto benchmarks |
| `aafp-benchmark/benches/discovery.rs` | 201 | 7 DHT/discovery benchmarks |
| `aafp-benchmark/benches/messaging.rs` | 24 | 2 frame benchmarks |
| `aafp-benchmark/benches/framing.rs` | 32 | 12 frame benchmarks (6 sizes × 2) |
| `aafp-benchmark/benches/mcp_transport.rs` | 165 | 4 MCP transport benchmarks |
| `aafp-benchmark/benches/connection_lifecycle.rs` | 377 | 6 connection lifecycle benchmarks |
| `aafp-benchmark/benches/lock_contention.rs` | 504 | 16 lock contention benchmarks |
| `aafp-benchmark/benches/quic_tuning.rs` | 242 | 4 QUIC tuning benchmarks |
| `aafp-benchmark/benches/serialization.rs` | 232 | 10 serialization benchmarks |
| `aafp-benchmark/benches/runtime_tuning.rs` | 180 | 4 runtime tuning benchmarks |
| `aafp-benchmark/benches/alloc_profile.rs` | 268 | 7 allocation profiling benchmarks |
| `aafp-benchmark/benches/timing_analysis.rs` | 228 | 5 timing side-channel benchmarks |
| `aafp-benchmark/benches/close_manager.rs` | 111 | 9 close manager benchmarks |
| `aafp-benchmark/benches/replay_cache.rs` | 103 | 6 replay cache benchmarks |
| `aafp-benchmark/benches/session.rs` | 35 | 2 session benchmarks |
| `aafp-benchmark/src/harness.rs` | 352 | BenchmarkRunner + ComparisonReport |
| `aafp-benchmark/src/alloc_tracker.rs` | 239 | CountingAllocator |
| `aafp-benchmark/src/env_report.rs` | 288 | SystemInfo + env summary |
| `aafp-loadtest/src/runner.rs` | 459 | Load test runner |
| `aafp-loadtest/src/metrics.rs` | 355 | LoadTestMetrics + ResultsAccumulator |
| `aafp-loadtest/src/topology.rs` | 189 | Topology edge generation |
| `aafp-loadtest/src/config.rs` | 98 | LoadTestConfig |
| `aafp-loadtest/src/bin/loadtest.rs` | 109 | Load test CLI |
| `aafp-loadtest/src/bin/stability.rs` | 463 | Stability/soak test binary |

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| **Criterion** | Rust benchmarking framework with statistical analysis |
| **Soak test** | Long-duration test to detect memory leaks and degradation |
| **Spike test** | Test that suddenly increases load to measure recovery |
| **p99** | 99th percentile latency (99% of requests are faster) |
| **Connection pool** | Reuse of existing QUIC connections for multiple RPCs |
| **DHT** | Distributed Hash Table for capability-based agent discovery |
| **PQ handshake** | Post-quantum cryptographic handshake (ML-DSA-65 + KEM) |
| **AEAD** | Authenticated Encryption with Associated Data |
| **BBR** | Bottleneck Bandwidth and Round-trip propagation time (congestion control) |
| **Fan-out** | One message delivered to many subscribers |
| **Hit rate** | Percentage of requests served from the connection pool |
| **Churn** | Rate at which connections are established and torn down |
