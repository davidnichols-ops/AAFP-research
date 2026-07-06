# AAFP Performance & Scalability Plan

> Status: Research / Planning
> Scope: Production performance targets, tuning strategy, and scalability
> roadmap for the AAFP agent mesh protocol.
> Related: `PERFORMANCE_REPORT.md` (measured baseline), `aafp-benchmark/`
> (benchmark harness), `aafp-loadtest/` (load test framework).

---

## Table of Contents

1. [Current Performance Baseline](#1-current-performance-baseline)
2. [Target Performance for Production](#2-target-performance-for-production)
3. [QUIC Tuning for High Throughput](#3-quic-tuning-for-high-throughput)
4. [Connection Pool Sizing](#4-connection-pool-sizing)
5. [DHT Scaling](#5-dht-scaling)
6. [Memory Budget per Agent](#6-memory-budget-per-agent)
7. [CPU Profiling Strategy](#7-cpu-profiling-strategy)
8. [Zero-Copy Optimization Paths](#8-zero-copy-optimization-paths)
9. [Batch Processing Patterns](#9-batch-processing-patterns)
10. [Load Testing Plan](#10-load-testing-plan)
11. [Scalability Bottlenecks](#11-scalability-bottlenecks)
12. [Horizontal Scaling](#12-horizontal-scaling)
13. [Concrete Benchmark Plan](#13-concrete-benchmark-plan)

---

## 1. Current Performance Baseline

All measurements taken on Apple M4, macOS, Rust 1.96.0, release profile
(`opt-level=3`). Source: `PERFORMANCE_REPORT.md` and the Criterion benches
in `aafp-benchmark/benches/`.

### 1.1 Cryptography (ML-DSA-65, FIPS 204)

| Operation | Time | Target | Status |
|-----------|------|--------|--------|
| Keygen | 133 µs | <50 ms | PASS (376x margin) |
| Sign | 272 µs | <10 ms | PASS (37x margin) |
| Verify | 76 µs | <15 ms | PASS (197x margin) |
| PQ handshake (full, app layer) | 709 µs | — | Baseline |
| AEAD encrypt (1 KB) | 1.63 µs | — | Baseline |
| AEAD decrypt (1 KB) | 1.64 µs | — | Baseline |

The 709 µs application-layer handshake (ML-DSA-65 sign + verify + HKDF)
is the dominant cost for a *new* connection. Combined with the QUIC/TLS
handshake (~100–200 ms on a LAN, dominated by X25519MLKEM768 KEX), the
"time to first authenticated message" is well under the 500 ms target.

### 1.2 Framing (`aafp-messaging`)

| Operation | Payload | Time | Target | Status |
|-----------|---------|------|--------|--------|
| Encode | 64 B | 28 ns | — | Baseline |
| Encode | 1 KB | 66 ns | <10 µs | PASS (151x) |
| Encode | 64 KB | 1.81 µs | <10 µs | PASS |
| Decode | 64 B | 15 ns | — | Baseline |
| Decode | 1 KB | 35 ns | <10 µs | PASS (285x) |
| Decode | 64 KB | 1.60 µs | <10 µs | PASS |

Frame encode/decode is effectively zero-cost relative to crypto and I/O.

### 1.3 Session / Memory

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| `sizeof(Session)` | 168 bytes | <1 MB | PASS (6149x) |
| Session creation | 30 ns | — | Baseline |
| 1000 sessions creation | 19 µs | — | Baseline |

### 1.4 Connection Lifecycle (Track I1–I8)

Measured by `benches/connection_lifecycle.rs`:

| Scenario | Cost | Notes |
|----------|------|-------|
| Cold connect (full TLS + PQ KEX) | ~240 µs (localhost) | New `QuicTransport`, no session cache |
| Warm connect (TLS resumption) | <cold cost | `SessionCache` reuses TLS 1.3 ticket |
| Stream open on existing conn | ~14 µs | `open_bi()` on pooled connection |
| Pooled RPC (100 sequential) | 1 connection | Pool reuses single connection |

The connection pool (`aafp-sdk::connection_pool`) reduces repeated-RPC
cost from 240 µs (handshake) to 14 µs (stream open) — a 17x improvement.

### 1.5 QUIC Tuning (Track J1–J4)

`aafp-transport-quic::config::QuicConfig` ships two presets:

| Parameter | Default | `low_latency()` | `bulk_transfer()` |
|-----------|---------|-----------------|-------------------|
| Congestion | Cubic | BBR | Cubic |
| Initial RTT | 10 ms | 10 ms | 100 ms |
| Max ACK delay | 5 ms | 5 ms | 25 ms |
| Stream window | 1 MB | 1 MB | 10 MB |
| Crypto buffer | 8 KB | 8 KB | 64 KB |
| Max idle timeout | 30 s | 30 s | 300 s |
| Max concurrent streams | 100 | 100 | 100 |

Quinn defaults (333 ms RTT, 25 ms ACK, 100 KB window) are overridden in
all AAFP presets to reduce retransmission timers for LAN/localhost RPC.

### 1.6 Runtime Tuning (Track L5–L6)

| Preset | Flavor | Workers | Stack | Blocking |
|--------|--------|---------|-------|----------|
| `low_latency()` | current_thread | 1 | 2 MB | 512 |
| `high_throughput()` | multi_thread | auto (physical) | 2 MB | 512 |

L1 profiling showed 84% of time in `pthread_cond_signal/cvwait` with the
multi-thread runtime on localhost RPC. The `current_thread` runtime
eliminates cross-core scheduling overhead for single-peer workloads.

CPU affinity pinning (`aafp-sdk::cpu_affinity`, feature `cpu-affinity`)
reduces p99 variance by preventing core migration. Enforced on Linux via
`sched_setaffinity()`; advisory on macOS.

### 1.7 DHT Routing (Track R1)

`aafp-discovery::dht_router` constants:

| Parameter | Value | Source |
|-----------|-------|--------|
| K-bucket size (K) | 20 | `K_BUCKET_SIZE` |
| ID bits | 256 | `ID_BITS` |
| Lookup concurrency (α) | 3 | `ALPHA` |
| Replication factor (k) | 5 | `REPLICATION_FACTOR` |
| Bucket refresh | 15 min | `BUCKET_REFRESH_INTERVAL` |

Validated to 500 nodes with 100% lookup success in multi-node DHT tests.

---

## 2. Target Performance for Production

### 2.1 Scale Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Agents in mesh | 100,000 | Global agent population |
| Concurrent streams (per node) | 1,000,000 | Aggregate across all connections |
| RPC throughput (per node) | 10,000,000 RPC/s | Sustained, small messages |
| Concurrent connections (per node) | 50,000 | Active QUIC connections |
| DHT nodes | 100,000 | Full routing table participation |

### 2.2 Latency Targets

| Operation | p50 | p99 | p99.9 | Notes |
|-----------|-----|-----|-------|-------|
| Stream open (pooled) | 15 µs | 50 µs | 100 µs | Baseline 14 µs |
| 1 KB RPC round-trip (LAN) | 200 µs | 1 ms | 5 ms | Includes crypto |
| 1 KB RPC round-trip (WAN) | 5 ms | 20 ms | 50 ms | 1 RTT + processing |
| DHT lookup (100 K nodes) | 50 ms | 200 ms | 500 ms | log₂(100K) ≈ 17 hops |
| New connection (LAN) | 2 ms | 5 ms | 10 ms | TLS + AAFP handshake |
| New connection (WAN) | 150 ms | 300 ms | 500 ms | 1 RTT TLS + 0.7 ms AAFP |

### 2.3 Throughput Targets

| Workload | Target | Per-node |
|----------|--------|----------|
| Small RPC (64 B–1 KB) | 10M RPC/s | Single 32-core node |
| Medium messages (10 KB) | 1M msg/s | Single node |
| Bulk transfer (1 MB+) | 10 Gb/s | Single connection |
| DHT lookups | 100K lookups/s | Single node |

### 2.4 Resource Targets

| Resource | Idle | Active (peak) |
|----------|------|---------------|
| Memory per agent | <10 MB | <100 MB |
| CPU per agent | ~0% | <1 core (idle), scales with load |
| File descriptors | 1 (listener) | 50K (connections) + streams |
| Goroutine/task count | 1 | 2× concurrent streams |

---

## 3. QUIC Tuning for High Throughput

### 3.1 Flow Control

QUIC provides flow control at both stream and connection level. The
current defaults (1 MB stream window) are tuned for small RPC. For
high-throughput scenarios:

| Parameter | Small RPC | Bulk Transfer | 1M Streams |
|-----------|-----------|---------------|------------|
| `stream_initial_max_data` | 1 MB | 10 MB | 256 KB |
| Connection-level window | 10 MB | 100 MB | 4 MB |
| `max_concurrent_bidi_streams` | 100 | 100 | 10,000 |
| `max_concurrent_uni_streams` | 100 | 100 | 10,000 |

**Rationale:** At 1M concurrent streams, per-stream window must shrink to
keep aggregate buffer memory bounded: 1M × 256 KB = 256 GB (too much).
Use a tiered approach: small window per stream, larger connection-level
window, and rely on application-level backpressure.

**Action item:** Add a `high_concurrency()` preset to `QuicConfig` with
reduced per-stream windows and elevated stream limits. Current
`max_concurrent_streams` is capped at 100 — must be raised to 10,000+
for fan-out workloads.

### 3.2 Congestion Control

| Controller | Best for | AAFP preset |
|------------|----------|-------------|
| BBR | Low-latency RPC, no packet-loss dependence | `low_latency()` |
| Cubic | Bulk transfer, TCP-friendly | `bulk_transfer()`, default |
| NewReno | Conservative, standard | (available, not preset) |

**Production guidance:**
- Agent-to-agent RPC on LAN/datacenter: BBR (avoids window reduction on
  rare packet loss, faster ramp-up).
- Cross-internet bulk transfer: Cubic (coexistence with TCP traffic).
- Mixed workloads: BBR with per-stream override for bulk streams.

**Action item:** Evaluate BBRv2 (if/when available in quinn) for better
fairness. Current quinn BBR is experimental.

### 3.3 Stream Limits

The current `max_concurrent_streams = 100` is the primary bottleneck for
fan-out workloads (one agent calling 1000 capabilities). Quinn allows
up to `VarInt::MAX` but practical limits are bounded by:

- Memory: each stream has send/recv buffers (window-sized).
- FD/socket buffer pressure in the kernel.
- Tokio task overhead (~2 KB per spawned task).

**Recommendation:** Set `max_concurrent_bidi_streams` to 10,000 for
production agents. At 256 KB window per stream, 10K streams = 2.5 GB
buffer budget — acceptable for a 32 GB node.

### 3.4 ACK Frequency

`max_ack_delay = 5 ms` (down from quinn's 25 ms default) makes ACKs more
frequent, reducing retransmission latency. For pure throughput (bulk
transfer), a larger ACK delay (25 ms) reduces ACK packet overhead.

**Tuning matrix:**

| Workload | `max_ack_delay` | `initial_rtt` |
|----------|-----------------|---------------|
| LAN RPC | 1 ms | 5 ms |
| WAN RPC | 5 ms | 50 ms |
| Bulk transfer | 25 ms | 100 ms |

### 3.5 TLS Session Resumption (Track I1)

`QuicConfig::build_client_config_with_resumption()` uses a `SessionCache`
to store TLS 1.3 session tickets. The server sends 4 tickets per
connection (`send_tls13_tickets = 4`). 0-RTT early data is **disabled**
(replay attack risk).

**Impact:** Warm connect skips the full TLS KEX (X25519MLKEM768), saving
~100–200 ms on WAN. The AAFP application-layer handshake still runs.

**Production:** Share a single `SessionCache` across all `dial()` calls
on a `QuicTransport` to maximize ticket reuse. For 100K peers, the cache
should be bounded (LRU, 50K entries) to avoid unbounded memory growth.

---

## 4. Connection Pool Sizing

### 4.1 Current Implementation

`aafp-sdk::connection_pool::ConnectionPool`:
- Keyed by peer `AgentId`.
- `max_size = 100` (default), `idle_timeout = 60 s`.
- Health check via `open_bi()` if idle > 5 s.
- LRU eviction at capacity.

### 4.2 Sizing by Workload

| Workload | `max_size` | `idle_timeout` | Rationale |
|----------|-----------|----------------|-----------|
| Client (few peers) | 10 | 120 s | Long-lived, few connections |
| Hub agent (star) | 1,000 | 60 s | Many inbound, reuse aggressively |
| Mesh (K peers) | K | 300 s | Keep all neighbor connections warm |
| DHT node (routing) | 20 (K) | 600 s | K-bucket peers, long-lived |
| Relay node | 10,000 | 30 s | High churn, fast eviction |
| Capability fan-out | 1,000 | 60 s | One per capability provider |

### 4.3 Per-Agent vs Per-Capability vs Global

**Per-agent pool (current):** One pool per `Agent` instance. Simple,
no cross-agent contention. Good for most workloads.

**Per-capability pool:** Cache connections by `(agent_id, capability)`
pair. Useful when an agent uses different capabilities on the same peer
and wants stream isolation. Overhead: more connections, more memory.

**Global pool (shared):** A single pool shared across all agents in a
process. Reduces total connection count when multiple local agents talk
to the same remote agent. Requires `Arc<ConnectionPool>`. Trade-off:
mutex contention under high concurrency — consider `DashMap`-based pool
for >10K concurrent `get_or_connect` calls.

**Recommendation:** Default to per-agent. Add a `SharedConnectionPool`
variant for relay/hub nodes where connection deduplication matters.

### 4.4 Pool Memory Budget

Each pooled connection holds:
- `QuicConnection` (quinn handle, ~2 KB)
- `Session` state machine (168 bytes)
- Quinn internal connection state (~50 KB estimated)
- Per-stream buffers (on-demand)

At `max_size = 1000`: ~50 MB connection state + stream buffers.
At `max_size = 10,000`: ~500 MB — significant. Reduce `idle_timeout`
to 15 s for relay nodes to keep working set smaller.

---

## 5. DHT Scaling

### 5.1 Current Parameters

| Parameter | Value | Constant |
|-----------|-------|----------|
| K (bucket size) | 20 | `K_BUCKET_SIZE` |
| α (lookup concurrency) | 3 | `ALPHA` |
| k (replication) | 5 | `REPLICATION_FACTOR` |
| ID space | 256 bits | `ID_BITS` |
| Buckets | 256 | One per bit |
| Refresh interval | 15 min | `BUCKET_REFRESH_INTERVAL` |

### 5.2 K-Bucket Sizing at Scale

At 100K nodes, the routing table is sparse in distant buckets and full
in near buckets. Expected bucket occupancy:

| Bucket range | Expected nodes | Full? |
|--------------|---------------|-------|
| 0–8 (far) | ~100K / 2⁰..2⁸ | Yes (K=20) |
| 9–16 | ~100K / 2⁹..2¹⁶ | Mostly full |
| 17–256 (near) | <1 per bucket | Sparse |

**Total routing table entries:** ~K × log₂(N) = 20 × 17 ≈ 340 entries
at 100K nodes. Memory: 340 × ~200 bytes/entry ≈ 68 KB. Negligible.

### 5.3 Replication Factor

`k = 5` means each capability record is stored on the 5 closest nodes.
At 100K nodes with 10% churn/hour:

- Probability all 5 replicas are gone: `(churn_rate)⁵` — negligible.
- Read availability: 5/5 = 100% if any replica is up.

**Recommendation:** Increase to `k = 8` for internet-scale deployment
to tolerate higher churn. Cost: 60% more storage per record.

### 5.4 Lookup Latency at 100K Nodes

Iterative lookup with α=3 concurrency:
- Hops: log₂(100K) / log₂(α) ≈ 17 / 1.58 ≈ 11 rounds
- Per-round latency: 1 RTT (WAN ~50 ms)
- Total: 11 × 50 ms = 550 ms (worst case, serial)

With α=3 parallel queries per round:
- Total: 11 rounds × 50 ms = 550 ms (parallel within round)

**Target: <200 ms p99.** Strategies:
- Increase α to 5 (more parallelism, more bandwidth).
- Cache recent lookup results (TTL 60 s).
- Use PEX (peer exchange) to pre-populate routing table.
- Iterative deepening: start with cached close peers.

### 5.5 DHT Partitioning (see §12.3)

For >100K nodes, partition the DHT by capability namespace:
- `cap:compute:*` → shard 0
- `cap:storage:*` → shard 1
- Each shard is an independent DHT with its own routing table.
- Reduces per-node routing table size and lookup fan-out.

---

## 6. Memory Budget per Agent

### 6.1 Target: <10 MB Idle, <100 MB Active

### 6.2 Idle Agent Breakdown

| Component | Size | Notes |
|-----------|------|-------|
| `Agent` struct | ~1 KB | Keypair, config, handles |
| `Session` (none active) | 0 | No sessions until connected |
| QUIC endpoint | ~100 KB | Quinn `Endpoint` + config |
| DHT routing table (empty) | ~1 KB | 256 empty buckets |
| Tokio runtime | ~2 MB | 1 worker, 2 MB stack |
| Buffer pool (empty) | ~0 | Thread-local, grows on use |
| Metrics (AtomicU64 × N) | ~1 KB | `AgentMetrics` counters |
| **Total idle** | **~2.1 MB** | Well under 10 MB |

### 6.3 Active Agent Breakdown (1K connections, 10K streams)

| Component | Size | Notes |
|-----------|------|-------|
| Connection pool (1K conns) | ~50 MB | 50 KB × 1000 |
| Stream buffers (10K × 256 KB) | 0–2.5 GB | Bounded by flow control |
| DHT routing table (340 entries) | ~68 KB | At 100K nodes |
| ReplayCache (100K entries) | ~3.2 MB | 32 bytes × 100K |
| KeyDirectory cache | ~1 MB | LRU 10K records |
| Tokio tasks (20K) | ~40 MB | 2 KB × 20K |
| Buffer pool (warm) | ~16 MB | 256 × 64 KB |
| **Total active (moderate)** | **~60 MB** | Under 100 MB |
| **Total active (peak streams)** | **up to 2.5 GB** | Needs stream window tuning |

### 6.4 Keeping Peak Memory Bounded

The risk is per-stream buffer memory. At 1M streams × 256 KB = 256 GB —
infeasible. Solutions:

1. **Tiered stream windows:** 64 KB default, 1 MB for bulk streams
   (negotiated via a capability extension).
2. **Backpressure:** Application-level `ready()` check before accepting
   new streams. Reject with `STREAM_REFUSED` when at capacity.
3. **Stream pooling:** Reuse stream IDs (QUIC allows this within a
   connection's lifetime).
4. **Memory pressure callback:** Monitor RSS, start evicting idle
   pool connections when RSS > 80% of budget.

### 6.5 Measurement

Use `aafp-benchmark::alloc_tracker::CountingAllocator` to measure
allocations per operation. The `track_allocs()` helper provides
per-closure allocation reports. For production, integrate with `jemalloc`
or `mimalloc` and expose stats via `AgentMetrics::prometheus`.

---

## 7. CPU Profiling Strategy

### 7.1 Flamegraphs

**Tool:** `cargo flamegraph` (uses `perf` on Linux, `dtrace` on macOS).

```bash
# CPU flamegraph of the load test binary
cargo flamegraph --bin aafp-loadtest -- --agents 100 --topology star

# Focus on the hot path (handshake + RPC)
cargo flamegraph --bin aafp-loadtest -- --agents 100 --topology star \
  --messages 10000 --message-size 1024
```

**Targets:**
- Hot path should be dominated by `quinn` (crypto, packet processing)
  and `aafp-messaging` (frame encode/decode).
- No allocation in frame encode/decode (verify with alloc_tracker).
- <5% time in lock contention (verify with `lock_contention` bench).

### 7.2 Tokio Console

`tokio-console` provides a live task dashboard for async diagnostics:

```toml
# Cargo.toml
[dependencies]
tokio = { version = "1", features = ["tracing"] }
console-subscriber = "0.4"
```

```rust
// In main()
console_subscriber::init();
```

**What to look for:**
- Tasks stuck in `Awaiting` (blocking on I/O or locks).
- Waker churn (tasks repeatedly woken and re-parked).
- Long-running tasks blocking the runtime (should use `spawn_blocking`).
- Task count: should match expected concurrent streams × 2.

### 7.3 perf (Linux)

```bash
# CPU cycles, top functions
perf record -g -- cargo test --release -- --ignored stress_100_agents
perf report

# Cache misses
perf stat -e cache-misses,cache-references -- cargo test --release -- ...

# Scheduler events (context switches)
perf stat -e context-switches,cpu-migrations -- cargo test --release -- ...
```

**Key metrics:**
- `cache-misses / cache-references < 5%` (good cache locality).
- `cpu-migrations` should be near-zero with affinity pinning.
- `context-switches` should scale linearly with connections, not streams.

### 7.4 Allocation Profiling

`aafp-benchmark::alloc_tracker` provides per-operation allocation counts.
For continuous profiling, use `dhat` or `jemalloc` heap profiling:

```rust
// dhat: in-memory heap profiler
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

fn main() {
    let _profiler = dhat::Profiler::new_heap();
    // ... run workload ...
    // Drop profiler to print report
}
```

**Target:** 0 allocations on the steady-state RPC hot path (after warmup).
Frame encode/decode already achieves this (66 ns encode, no alloc).

### 7.5 Benchmark Harness

`aafp-benchmark::harness::BenchmarkRunner` provides a criterion-free
runner with p50/p90/p99/p99.9 statistics and JSON output. Use
`compare_results()` for regression detection (5% significance threshold).

The `env_report` module prints system info (CPU, OS, Rust version) for
reproducibility. Every benchmark run should include this.

---

## 8. Zero-Copy Optimization Paths

### 8.1 Current State

- **Frame encode/decode:** Operates on `&[u8]` and `BytesMut`. No
  allocation after warmup (buffer pool).
- **Buffer pool:** `aafp-transport-quic::buffer_pool` — thread-local
  `BytesMut` pool (256 buffers, 4 KB initial, 1 MB max, 60 s idle).
- **Session:** 168 bytes, stack-allocated, no heap.

### 8.2 `bytes::Bytes` for Reference-Counted Zero-Copy

`Bytes` is a reference-counted, immutable slice that enables zero-copy
slicing (no allocation when splitting a buffer). Use cases:

- **Frame payload:** After decoding, the payload region of the receive
  buffer can be returned as `Bytes::slice()` — no copy.
- **Multicast/fan-out:** One `Bytes` can be sent to N streams with
  refcount = N. No N copies.
- **DHT record caching:** Store `Bytes` in the cache; lookups return
  a clone (refcount bump, no copy).

**Action item:** Audit `aafp-messaging` frame decode to return `Bytes`
for the payload instead of `Vec<u8>`. This eliminates one allocation +
copy per inbound message.

### 8.3 Hot-Path Allocation Audit

Use `track_allocs()` to verify zero allocations on:

| Path | Target allocs | Status |
|------|---------------|--------|
| Frame encode (1 KB) | 0 | Verify |
| Frame decode (1 KB) | 0 | Verify |
| Session creation | 0 | 30 ns implies 0 |
| Stream open (pooled) | 0 | Verify |
| RPC send (pooled) | 0 | Verify |
| RPC receive | 0 | Verify |
| DHT lookup (local hit) | 0 | Verify |
| AEAD encrypt/decrypt | 0 | Verify |

### 8.4 Avoiding Allocation in Hot Paths

Patterns to enforce:

1. **Pre-allocate buffers:** Use the buffer pool, not `vec![0u8; n]` in
   the hot path.
2. **`SmallVec` for small variable-size data:** Frame headers (≤32 B)
   should use `SmallVec<[u8; 32]>` to avoid heap allocation.
3. **`Arc<str>` for capability strings:** Capability names are repeated;
   intern them in an `Arc<str>` pool.
4. **Avoid `format!()` in hot paths:** Use `itoa` / `ryu` for number
   formatting, or pre-format.
5. **`BytesMut::freeze()` → `Bytes`:** Convert mutable buffers to
   immutable `Bytes` for sending, enabling refcount sharing.

### 8.5 Kernel-Level Zero-Copy

For bulk transfer (file transfer capability):
- `sendfile()` / `splice()` on Linux for kernel-to-socket zero-copy.
- `MSG_ZEROCOPY` (Linux) for UDP send (QUIC runs over UDP).
- These require `quinn` support or a custom transport layer.

**Action item:** Evaluate `quinn`'s `zero_rtt` and send-side zero-copy
support. Currently not exposed; may require upstream contribution.

---

## 9. Batch Processing Patterns

### 9.1 Multiple RPCs per Stream

QUIC streams are cheap (14 µs to open) but not free. For high-throughput
workloads, batch multiple RPCs into a single stream:

```
┌─────────────────────────────────────────────┐
│ Stream (single bidirectional)               │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐       │
│  │ RPC1 │ │ RPC2 │ │ RPC3 │ │ RPC4 │  ...  │
│  └──────┘ └──────┘ └──────┘ └──────┘       │
│  ←──── responses (pipelined) ────→          │
└─────────────────────────────────────────────┘
```

**Protocol:** AAFP v1 RPC frames already support multiplexing within a
stream (each frame has a request ID). The client can send N requests
without waiting for responses (pipelining). The server processes them
in order and returns responses in order.

**Benefit:** Eliminates 14 µs × N stream-open cost. For 100 RPCs:
- Per-stream: 100 × 14 µs = 1.4 ms overhead
- Pipelined: 1 × 14 µs = 14 µs overhead (100x reduction)

### 9.2 Pipelining

```
Client                          Server
  │                               │
  ├─ RPC 1 ───────────────────────→
  ├─ RPC 2 ───────────────────────→  (processing RPC 1)
  ├─ RPC 3 ───────────────────────→  (processing RPC 2)
  ←─ Resp 1 ──────────────────────┤
  ←─ Resp 2 ──────────────────────┤
  ←─ Resp 3 ──────────────────────┤
  │                               │
```

**Requirements:**
- Server must handle out-of-order completion (responses can arrive
  out of order if processing is parallel). AAFP v1 RPC frames include
  a request ID for matching.
- Flow control: client must not exceed the stream window. With 1 MB
  window and 1 KB RPCs, up to 1024 RPCs can be in-flight.

### 9.3 Batch Announcement (DHT)

For publishing multiple capabilities at once:

```cbor
{
  "type": "aafp.discovery.batch_announce",
  "capabilities": ["cap:compute", "cap:storage", "cap:relay"],
  "ttl": 3600
}
```

Single DHT round-trip for N capabilities instead of N round-trips.
Implemented as a v1 RPC extension.

### 9.4 Batch Frame Encoding

For sending N small messages to the same peer:

```
┌──────────────────────────────────┐
│ Batch Frame                      │
│  count: N                        │
│  ┌──────┐ ┌──────┐ ┌──────┐    │
│  │ msg1 │ │ msg2 │ │ msgN │    │
│  └──────┘ └──────┘ └──────┘    │
└──────────────────────────────────┘
```

Single `send.write_all()` call for the entire batch, reducing syscall
count. The receiver decodes N frames from one buffer read.

**Action item:** Add a `BatchFrame` type to `aafp-messaging` that
encodes N frames into one buffer and decodes them in one pass.

### 9.5 Expected Throughput Improvement

| Pattern | RPCs/sec (est.) | vs. Baseline |
|---------|-----------------|--------------|
| 1 stream per RPC (current) | 100K | 1x |
| 10 RPCs per stream (pipelined) | 500K | 5x |
| 100 RPCs per stream (pipelined) | 2M | 20x |
| Batch frame (100 msgs/batch) | 5M | 50x |
| Batch + multiple streams (100 × 100) | 10M | 100x |

---

## 10. Load Testing Plan

### 10.1 Existing Framework

`aafp-loadtest` provides:
- `LoadTestConfig`: N agents, messages/agent, message size, topology
  (mesh/star/ring/random), concurrency.
- `LoadTestMetrics`: throughput (msg/s, bytes/s), latency percentiles
  (p50/p90/p99/p99.9), error rate, connection stats, RSS, FD count.
- `ResultsAccumulator`: thread-safe atomic counters + latency histogram.
- Presets: `smoke()` (10 agents), `agents_100()` (100 agents, star).

### 10.2 External Tools

| Tool | Use | Why |
|------|-----|-----|
| `vegeta` | HTTP-style load testing | Constant rate, p99 focus. Not QUIC-native. |
| `oha` | High-concurrency HTTP load | Rust-based, fast. Not QUIC-native. |
| `wrk2` | Sustained throughput, latency | C-based, mature. Not QUIC-native. |
| Custom AAFP load generator | QUIC-native, AAFP handshake | `aafp-loadtest` binary |

**Recommendation:** Use `aafp-loadtest` for all AAFP-native testing
(it does the full handshake + RPC). Use `vegeta`/`oha` only for
MCP-transport HTTP gateway benchmarks (if an HTTP gateway is built).

### 10.3 Load Test Matrix

| Test | Agents | Topology | Msgs/agent | Msg size | Duration | Target |
|------|--------|----------|------------|----------|----------|--------|
| Smoke | 10 | mesh | 10 | 256 B | 30 s | No errors |
| Small scale | 100 | star | 100 | 1 KB | 120 s | <1 ms p99 |
| Medium scale | 1,000 | random(5) | 1,000 | 1 KB | 300 s | <5 ms p99 |
| Large scale | 10,000 | random(10) | 100 | 1 KB | 600 s | <20 ms p99 |
| Throughput | 2 | star | 1M | 1 KB | 300 s | >1M msg/s |
| Fan-out | 1 → 1,000 | star | 10 | 64 B | 60 s | <10 ms p99 |
| Churn | 100 | random(5) | 100 | 1 KB | 600 s | 50% join/leave |
| Bulk | 2 | star | 1 | 100 MB | 120 s | >5 Gb/s |
| Long-running | 100 | mesh | ∞ | 1 KB | 24 h | No memory leak |

### 10.4 Custom AAFP Load Generator

The `aafp-loadtest` binary should support:

```bash
# Run a load test
aafp-loadtest \
  --agents 1000 \
  --topology random \
  --random-degree 10 \
  --messages 1000 \
  --message-size 1024 \
  --concurrency 32 \
  --duration 300s \
  --output metrics.json

# Ramp-up test (agents join over time)
aafp-loadtest \
  --agents 10000 \
  --ramp-up 60s \
  --messages 100 \
  --message-size 1024 \
  --duration 600s

# Churn test (agents leave and rejoin)
aafp-loadtest \
  --agents 1000 \
  --churn-rate 0.5 \
  --messages 100 \
  --duration 600s
```

**Metrics output:** JSON with `LoadTestMetrics` schema. Compare across
runs using `aafp-benchmark::harness::compare_results()`.

### 10.5 Continuous Benchmarking

Integrate into CI:
1. **Per-PR:** Smoke test (10 agents, 30 s). Must pass with no errors.
2. **Nightly:** Medium scale (1,000 agents, 5 min). Compare p99 against
   baseline; fail if regression > 5%.
3. **Weekly:** Large scale (10,000 agents, 10 min) on dedicated hardware.
4. **Release:** Full matrix + long-running (24 h) memory leak check.

Store results in `PERFORMANCE_REPORT.md` format with timestamps for
trend analysis.

---

## 11. Scalability Bottlenecks

### 11.1 What Breaks First at Each Scale

#### 1,000 Agents

**Bottleneck: Connection pool mutex contention.**

The `ConnectionPool` uses a single `tokio::sync::Mutex<HashMap>`. At
1,000 concurrent `get_or_connect()` calls, the mutex becomes a
serialization point.

**Fix:** Replace `HashMap` with `DashMap` for lock-free reads. Or shard
the pool by `AgentId` hash (16 shards).

**Current status:** `pool_100_rpcs_use_1_connection` test passes, but
this is sequential. Concurrent access is untested at scale.

#### 10,000 Agents

**Bottleneck: Tokio task scheduling.**

At 10,000 agents × 10 connections × 2 streams = 200,000 concurrent
tasks. The multi-thread runtime's work-stealing scheduler spends
significant time in cross-core task migration.

**Fix:**
- Pin worker threads to cores (`cpu_affinity` feature).
- Use `current_thread` runtime per agent group (shard agents across
  N single-thread runtimes, each on a pinned core).
- Reduce task count: batch RPCs per stream (§9).

**Current status:** `RuntimeConfig::low_latency()` uses
`current_thread`. `high_throughput()` uses multi-thread with auto
worker count. No per-agent runtime sharding yet.

#### 100,000 Agents

**Bottleneck: DHT routing table + lookup fan-out.**

At 100K nodes, iterative lookups require ~11 rounds × 50 ms RTT =
550 ms. The routing table has ~340 entries (manageable), but the
network fan-out (α=3 × 11 rounds = 33 RPCs per lookup) creates
significant cross-network traffic.

**Fix:**
- Increase α to 5 (more parallelism, fewer rounds).
- Cache lookup results (TTL 60 s).
- DHT partitioning by capability namespace (§12.3).
- Pre-fetch routing table entries via PEX on connection.

**Current status:** Validated to 500 nodes. 100K-node simulation
needed (can't run 100K real agents on one machine).

#### 1,000,000 Agents (1M)

**Bottleneck: Global state — KeyDirectory, ReplayCache, bootstrap.**

- `ReplayCache`: 100K entries × 32 bytes = 3.2 MB (OK). At 1M agents
  with high message rate, the cache must handle 1M+ nonces. LRU
  eviction at `max_entries = 100K` (default) may be too small.
- `KeyDirectory`: AgentId → AgentRecord mapping. At 1M agents, the
  in-memory backend is infeasible. Must use SQLite or distributed
  store.
- Bootstrap: All new agents must find the DHT. Bootstrap nodes become
  a bottleneck (connection limit, bandwidth).

**Fix:**
- Scale `ReplayCache.max_entries` to 1M (32 MB — acceptable).
- Use SQLite-backed `KeyDirectory` for >100K agents (already
  implemented: `aafp-identity::key_directory`).
- Federated bootstrap: multiple bootstrap nodes behind a load balancer
  (DNS round-robin or anycast).
- DHT partitioning (§12.3) — each shard has its own bootstrap.

### 11.2 Bottleneck Summary

| Scale | First Bottleneck | Fix |
|-------|-----------------|-----|
| 1K | Pool mutex | DashMap / sharded pool |
| 10K | Tokio scheduler | Runtime sharding, core pinning |
| 100K | DHT lookup latency | α=5, caching, partitioning |
| 1M | Global state (KeyDir, Replay) | SQLite, federated bootstrap |
| 10M | Network bandwidth, FD limits | Kernel tuning, relay federation |

---

## 12. Horizontal Scaling

### 12.1 Agent Sharding

For a single process that must handle >10K agents, shard agents across
multiple Tokio runtimes, each pinned to a core:

```
┌─────────────────────────────────────────────┐
│ Process (32 cores)                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐      │
│  │ Core 0  │ │ Core 1  │ │ Core 2  │ ...  │
│  │ RT[0]   │ │ RT[1]   │ │ RT[2]   │      │
│  │ Agents  │ │ Agents  │ │ Agents  │      │
│  │ 0-999   │ │ 1K-2K   │ │ 2K-3K   │      │
│  └─────────┘ └─────────┘ └─────────┘      │
│  Shared: DHT, KeyDirectory (SQLite)        │
└─────────────────────────────────────────────┘
```

- Each runtime is `current_thread` (no cross-core scheduling).
- Agents are assigned to runtimes by `AgentId % N`.
- Cross-runtime communication via channels (bounded, lock-free).
- Shared state (DHT, KeyDirectory) behind `Arc<RwLock<>>` or SQLite.

**Action item:** Add `ShardedAgentRuntime` to `aafp-sdk` that manages
N `current_thread` runtimes on pinned cores.

### 12.2 Relay Federation

For NAT traversal at scale, relay nodes federate:

```
  Agent (NAT)          Relay A          Relay B          Agent (NAT)
      │                   │                 │                │
      ├── connect ───────→│                 │                │
      │                   ├── federate ────→│                │
      │                   │                 ├── forward ────→│
      │                   │                 │                │
      ←─────── relayed stream ──────────────────────────────┤
```

- Relays peer with each other (DHT of relays).
- A relay forwards traffic to another relay if the destination is
  behind that relay.
- Load balancing: relays advertise their load (connections, bandwidth)
  via DHT records. Agents pick the least-loaded relay.

**Current status:** `aafp-nat` implements relay forwarding and DCuTR
hole punching. Federation (relay-to-relay forwarding) is not yet
implemented.

**Action item:** Add `RelayFederation` protocol: relays publish their
address + load to the DHT under `cap:relay`. Other relays discover and
peer with them. Forwarding uses a `relay_hop` header in the frame.

### 12.3 DHT Partitioning

Partition the DHT by capability namespace to reduce per-node state:

```
┌──────────────────────────────────────────────────┐
│ Global DHT (bootstrap + relay discovery)         │
│  cap:relay → relay nodes                         │
│  cap:bootstrap → bootstrap nodes                 │
├──────────────────────────────────────────────────┤
│ Shard 0: cap:compute:*                          │
│  Independent routing table, K=20, k=5           │
│  Nodes that provide compute capabilities         │
├──────────────────────────────────────────────────┤
│ Shard 1: cap:storage:*                          │
│  Independent routing table                       │
│  Nodes that provide storage capabilities         │
├──────────────────────────────────────────────────┤
│ Shard 2: cap:inference:*                        │
│  ...                                             │
└──────────────────────────────────────────────────┘
```

- Each shard is an independent DHT with its own k-buckets.
- A node joins all shards for which it has capabilities.
- Cross-shard lookups go through the global DHT (which maps capability
  prefix → shard bootstrap nodes).
- Reduces per-node routing table from ~340 entries (100K nodes) to
  ~340/N entries (N shards).

**Current status:** `aafp-discovery` has a single DHT. The
`regional.rs` module provides region-based partitioning (geographic).
Capability-namespace partitioning is not yet implemented.

**Action item:** Extend `DhtRouter` to support multiple routing tables
keyed by capability namespace prefix. The `find_peers(capability, k)`
call routes to the appropriate shard.

### 12.4 Process-Level Scaling

For >100K agents on a single machine, run multiple processes:

```
┌─────────────────────────────────────────────┐
│ Machine (64 cores, 128 GB RAM)              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Process 1│ │ Process 2│ │ Process N│   │
│  │ 25K agts │ │ 25K agts │ │ 25K agts │   │
│  │ Port 4433│ │ Port 4434│ │ Port 4435│   │
│  └──────────┘ └──────────┘ └──────────┘   │
│  Shared: SQLite KeyDirectory (on NVMe)     │
│  IPC: Unix domain sockets (loopback QUIC)  │
└─────────────────────────────────────────────┘
```

- Each process is independent (no shared memory).
- Cross-process communication via loopback QUIC (fast, no NAT).
- SQLite KeyDirectory on shared NVMe (WAL mode for concurrent reads).
- Load balancer (HAProxy or DNS) distributes incoming connections.

---

## 13. Concrete Benchmark Plan

### 13.1 Benchmark Suites

All benchmarks live in `aafp-benchmark/benches/` and use Criterion or
the custom `BenchmarkRunner` harness.

| Suite | File | What it measures |
|-------|------|-----------------|
| Crypto | `handshake.rs` | ML-DSA-65 keygen/sign/verify, AEAD, full handshake |
| Framing | `framing.rs` | Frame encode/decode at 64B/1KB/64KB |
| Session | `session.rs` | Session creation, state transitions |
| Messaging | `messaging.rs` | RPC send/receive, stream multiplexing |
| Connection lifecycle | `connection_lifecycle.rs` | Cold/warm/pooled connect |
| QUIC tuning | `quic_tuning.rs` | Config presets, RTT, throughput |
| Discovery | `discovery.rs` | DHT lookup, routing table ops |
| Replay cache | `replay_cache.rs` | Check/insert/evict performance |
| Close manager | `close_manager.rs` | CLOSE frame state transitions |
| Lock contention | `lock_contention.rs` | Mutex/RwLock under concurrency |
| Runtime tuning | `runtime_tuning.rs` | current_thread vs multi_thread |
| Alloc profile | `alloc_profile.rs` | Allocations per operation |
| Timing analysis | `timing_analysis.rs` | Clock resolution, timing overhead |
| MCP transport | `mcp_transport.rs` | MCP-over-AAFP ping/round-trip |

### 13.2 Target Numbers by Scale

#### Scale: Single-Node Microbenchmarks

| Benchmark | Current | Target | Notes |
|-----------|---------|--------|-------|
| PQ handshake | 709 µs | <500 µs | Optimize HKDF |
| Frame encode 1 KB | 66 ns | <50 ns | SmallVec header |
| Frame decode 1 KB | 35 ns | <30 ns | Branchless decode |
| Session creation | 30 ns | <30 ns | Already at target |
| Stream open (pooled) | 14 µs | <10 µs | Reduce quinn overhead |
| AEAD encrypt 1 KB | 1.63 µs | <1.5 µs | AES-NI / ARM-CE |
| AEAD decrypt 1 KB | 1.64 µs | <1.5 µs | AES-NI / ARM-CE |

#### Scale: 1K Agents (Single Process)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Connections | 1,000 | `aafp-loadtest --agents 1000 --topology star` |
| RPC p50 (1 KB) | <500 µs | Load test metrics |
| RPC p99 (1 KB) | <5 ms | Load test metrics |
| Throughput | >100K RPC/s | Aggregate |
| Memory | <500 MB | RSS at end |
| Error rate | <0.01% | Failed/sent |
| Pool mutex contention | <1% | `lock_contention` bench |

#### Scale: 10K Agents (Single Process, Sharded Runtime)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Connections | 10,000 | Sharded runtime, 16 cores |
| RPC p50 (1 KB) | <1 ms | Load test |
| RPC p99 (1 KB) | <20 ms | Load test |
| Throughput | >500K RPC/s | Aggregate |
| Memory | <5 GB | RSS |
| Task count | <200K | Tokio console |
| Core migration | <1% | `perf stat -e cpu-migrations` |

#### Scale: 100K Agents (Multi-Process, DHT Partitioned)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Processes | 4–8 | 64-core machine |
| Connections | 100,000 | Across all processes |
| RPC p50 (1 KB) | <5 ms | Load test |
| RPC p99 (1 KB) | <50 ms | Load test |
| Throughput | >1M RPC/s | Aggregate |
| DHT lookup p99 | <200 ms | Custom DHT bench |
| Memory | <50 GB | Total RSS |
| KeyDirectory ops | >10K/s | SQLite WAL benchmark |

#### Scale: 1M Agents (Cluster, Federated)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Machines | 10–100 | Cluster |
| Connections | 1,000,000 | Across cluster |
| RPC p50 (1 KB) | <10 ms | Load test (distributed) |
| RPC p99 (1 KB) | <100 ms | Load test |
| Throughput | >10M RPC/s | Aggregate |
| DHT lookup p99 | <500 ms | Partitioned DHT |
| Relay federation | <1 ms hop | Relay-to-relay forward |
| Bootstrap time | <5 s | New agent joining |

### 13.3 Benchmark Execution Plan

```bash
# 1. Microbenchmarks (every PR)
cargo bench --bench handshake --bench framing --bench session
cargo bench --bench messaging --bench close_manager --bench replay_cache

# 2. Connection lifecycle (every PR)
cargo bench --bench connection_lifecycle --bench quic_tuning

# 3. Allocation profile (nightly)
cargo bench --bench alloc_profile
cargo bench --bench lock_contention

# 4. Load tests (nightly)
cargo run --release --bin aafp-loadtest -- --agents 100 --topology star \
  --messages 100 --message-size 1024 --duration 120s --output nightly-100.json

# 5. Scale tests (weekly, dedicated hardware)
cargo run --release --bin aafp-loadtest -- --agents 1000 --topology random \
  --random-degree 10 --messages 1000 --message-size 1024 --duration 300s \
  --output weekly-1k.json

# 6. DHT simulation (weekly)
cargo test --release -- --ignored dht_500_nodes
# Future: dht_10k_nodes (simulation), dht_100k_nodes (simulation)

# 7. Flamegraph (on demand)
cargo flamegraph --bin aafp-loadtest -- --agents 100 --topology star \
  --messages 10000 --message-size 1024 --duration 60s

# 8. Long-running memory leak (release)
cargo run --release --bin aafp-loadtest -- --agents 100 --topology mesh \
  --messages 999999999 --message-size 1024 --duration 86400s \
  --output release-24h.json
```

### 13.4 Regression Detection

Use `aafp-benchmark::harness::compare_results()` to compare each run
against a stored baseline:

```rust
let baseline = BenchmarkResult::from_json_file("baseline.json");
let current = runner.finish();
let report = compare_results(&baseline, &current);
if report.is_regression && report.is_significant {
    panic!("Performance regression in {}: {:.2}x slower",
        report.name, 1.0 / report.improvement_factor);
}
```

**Threshold:** 5% regression is significant (per `compare_results`).
10% regression fails CI. Improvements are logged but don't fail.

### 13.5 Reporting

Each benchmark run produces:
1. **JSON output** (machine-readable): `BenchmarkResult::to_json()`.
2. **Human summary** (console): `env_report::print_env_summary()` +
   `LoadTestMetrics::print_summary()`.
3. **Trend data**: Append to `PERFORMANCE_REPORT.md` with timestamp,
   commit hash, and environment info.

Store trend data in a time-series database (or simple JSONL file) for
long-term regression tracking.

---

## Appendix A: Key File References

| Component | Path |
|-----------|------|
| Performance report | `PERFORMANCE_REPORT.md` |
| Benchmark harness | `aafp-benchmark/src/harness.rs` |
| Allocation tracker | `aafp-benchmark/src/alloc_tracker.rs` |
| Environment report | `aafp-benchmark/src/env_report.rs` |
| QUIC config | `aafp-transport-quic/src/config.rs` |
| Congestion control | `aafp-transport-quic/src/congestion.rs` |
| Buffer pool | `aafp-transport-quic/src/buffer_pool.rs` |
| Session cache | `aafp-transport-quic/src/session_cache.rs` |
| Connection pool | `aafp-sdk/src/connection_pool.rs` |
| Runtime config | `aafp-sdk/src/runtime_config.rs` |
| CPU affinity | `aafp-sdk/src/cpu_affinity.rs` |
| DHT router | `aafp-discovery/src/dht_router.rs` |
| Load test config | `aafp-loadtest/src/config.rs` |
| Load test metrics | `aafp-loadtest/src/metrics.rs` |
| Load test runner | `aafp-loadtest/src/runner.rs` |

## Appendix B: Tuning Parameter Quick Reference

| Parameter | File | Default | Production (100K) |
|-----------|------|---------|-------------------|
| `K_BUCKET_SIZE` | `dht_router.rs` | 20 | 20 |
| `ALPHA` | `dht_router.rs` | 3 | 5 |
| `REPLICATION_FACTOR` | `dht_router.rs` | 5 | 8 |
| `max_concurrent_streams` | `config.rs` | 100 | 10,000 |
| `stream_initial_max_data` | `config.rs` | 1 MB | 256 KB (tiered) |
| `initial_rtt` | `config.rs` | 10 ms | 10 ms (LAN) / 50 ms (WAN) |
| `max_ack_delay` | `config.rs` | 5 ms | 1 ms (LAN) / 5 ms (WAN) |
| `congestion` | `config.rs` | Cubic | BBR (RPC) / Cubic (bulk) |
| `max_idle_timeout` | `config.rs` | 30 s | 60 s |
| `keep_alive_interval` | `config.rs` | 30 s | 15 s |
| Pool `max_size` | `connection_pool.rs` | 100 | 1,000 (hub) / K (DHT) |
| Pool `idle_timeout` | `connection_pool.rs` | 60 s | 60–600 s |
| ReplayCache `max_entries` | `replay_cache.rs` | 100K | 1M |
| ReplayCache retention | `replay_cache.rs` | 300 s | 300 s |
| Runtime flavor | `runtime_config.rs` | MultiThread | CurrentThread (sharded) |
| Thread stack | `runtime_config.rs` | 2 MB | 2 MB |
| Buffer pool size | `buffer_pool.rs` | 256 | 256 |
| Buffer initial capacity | `buffer_pool.rs` | 4 KB | 4 KB |
| Buffer max capacity | `buffer_pool.rs` | 1 MB | 1 MB |

---

*This document is a living plan. Update with measured numbers as
benchmarks are run at each scale tier.*
