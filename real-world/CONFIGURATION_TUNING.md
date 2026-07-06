# AAFP Configuration & Runtime Tuning Guide

This document is a comprehensive reference for configuring and tuning AAFP
(Agent-to-Agent Federation Protocol) agents in production. It covers the full
configuration hierarchy, every tunable subsystem, and provides concrete TOML
config files for five deployment scenarios.

---

## Table of Contents

1. [Configuration Hierarchy](#1-configuration-hierarchy)
2. [Config File Format (TOML)](#2-config-file-format-toml)
3. [Transport Tuning (QUIC)](#3-transport-tuning-quic)
4. [Runtime Tuning (Tokio)](#4-runtime-tuning-tokio)
5. [Connection Pool Tuning](#5-connection-pool-tuning)
6. [DHT Tuning](#6-dht-tuning)
7. [Discovery Tuning](#7-discovery-tuning)
8. [Routing Tuning](#8-routing-tuning)
9. [PubSub Tuning](#9-pubsub-tuning)
10. [Memory Tuning](#10-memory-tuning)
11. [Logging Configuration](#11-logging-configuration)
12. [Metrics Configuration](#12-metrics-configuration)
13. [Deployment Scenarios](#13-deployment-scenarios)

---

## 1. Configuration Hierarchy

AAFP follows a strict four-layer precedence model. Each layer overrides the
one below it, with later (higher) layers winning on conflict.

```
┌─────────────────────────────────────────────────────┐
│  Layer 4: CLI flags          (--bind, --seeds, …)   │  highest priority
├─────────────────────────────────────────────────────┤
│  Layer 3: Environment vars   (AAFP_BIND, AAFP_…)    │
├─────────────────────────────────────────────────────┤
│  Layer 2: Config file        (aafp.toml)            │
├─────────────────────────────────────────────────────┤
│  Layer 1: Compiled defaults  (struct Default impls) │  lowest priority
└─────────────────────────────────────────────────────┘
```

### Layer 1 — Compiled Defaults

Every configuration struct in the AAFP Rust workspace implements `Default`.
These defaults are conservative and safe for general use. They are compiled
into the binary and require no external input.

| Struct | Source file | Key defaults |
|--------|-------------|--------------|
| `QuicConfig` | `aafp-transport-quic/src/config.rs` | Cubic congestion, 10ms initial RTT, 100 streams, 1MB stream window |
| `RuntimeConfig` | `aafp-sdk/src/runtime_config.rs` | Multi-thread, auto worker count, 2MB stack, 512 blocking threads |
| `PoolConfig` | `aafp-sdk/src/connection_pool.rs` | 100 max connections, 60s idle timeout |
| `DhtRouterConfig` | `aafp-discovery/src/dht_router.rs` | k=20, alpha=3, replication=5, 15min refresh |
| `BootstrapConfig` | `aafp-discovery/src/bootstrap.rs` | 30s timeout, min 3 peers |
| `RoutingConfig` | `aafp-sdk/src/routing/config.rs` | P2C strategy, 5-failure circuit breaker, hedging off |
| `GossipSubConfig` | `aafp-sdk/src/pubsub/gossipsub.rs` | D=6, 1s heartbeat, 1MB max message |
| `BufferPoolConfig` | `aafp-transport-quic/src/buffer_pool.rs` | 256 buffers, 4KB initial, 1MB max |
| `ServerConfig` | `aafp-sdk/src/server.rs` | 100 max connections, 10 handshakes/sec/IP |
| `KeepAliveConfig` | `aafp-messaging/src/keepalive.rs` | 30s interval, 10s timeout, 3 max missed |

### Layer 2 — Config File (`aafp.toml`)

A TOML file loaded at startup. The default search path is:

1. Path specified via `--config` CLI flag
2. `./aafp.toml` (current working directory)
3. `$XDG_CONFIG_HOME/aafp/aafp.toml` (Linux/macOS)
4. `$HOME/.config/aafp/aafp.toml` (fallback)

The file is divided into sections matching the major subsystems. See
[Section 2](#2-config-file-format-toml) for the full schema.

### Layer 3 — Environment Variables

Environment variables use the `AAFP_` prefix and map to config keys with
double-underscore (`__`) separators for nested fields:

```bash
# Top-level
AAFP_BIND="0.0.0.0:4433"
AAFP_CONFIG="/etc/aafp/aafp.toml"

# Transport
AAFP_TRANSPORT__MAX_CONCURRENT_STREAMS=256
AAFP_TRANSPORT__CONGESTION="bbr"
AAFP_TRANSPORT__INITIAL_RTT_MS=5

# Runtime
AAFP_RUNTIME__FLAVOR="multi_thread"
AAFP_RUNTIME__WORKER_THREADS=8

# Pool
AAFP_POOL__MAX_SIZE=500
AAFP_POOL__IDLE_TIMEOUT_SECS=120

# Discovery
AAFP_DISCOVERY__SEED_NODES="quic://seed1:4433,quic://seed2:4433"
AAFP_DISCOVERY__MIN_PEERS=20

# Logging
RUST_LOG="aafp_sdk=info,aafp_transport_quic=debug,warn"
AAFP_LOG_FORMAT="json"
```

Environment variables are parsed after the config file and override any
keys they specify. Unspecified keys retain their file or default values.

### Layer 4 — CLI Flags

CLI flags have the highest priority. They are typically used for
operational overrides (bind address, seeds, log level) without editing
files:

```bash
aafp agent start \
  --bind 0.0.0.0:4433 \
  --seeds quic://seed1.aafp.io:4433,quic://seed2.aafp.io:4433 \
  --runtime-flavor current_thread \
  --log-level debug \
  --metrics-addr 0.0.0.0:9090
```

### Resolution Algorithm

```
effective_value(key) =
    cli_flag(key)        if present
    else env_var(key)    if present
    else config_file(key) if present
    else compiled_default(key)
```

---

## 2. Config File Format (TOML)

The config file uses TOML with six top-level sections. Each section maps
to a configuration struct in the Rust source.

### Full Schema Reference

```toml
# ─── aafp.toml — full configuration reference ───

[agent]
# Agent identity and capabilities
capabilities = ["inference", "translation", "summarization"]
# Path to persistent keypair file (if omitted, a new keypair is generated)
keypair_file = "/var/lib/aafp/agent.key"
# Whether this agent acts as a circuit relay
is_relay = false
# Enable post-quantum key exchange (X25519MLKEM768)
enable_pq = true

[transport]
# QUIC bind address
bind_addr = "0.0.0.0:4433"
# Maximum concurrent bidirectional streams per connection
max_concurrent_streams = 100
# Keep-alive interval (seconds)
keep_alive_interval_secs = 30
# Congestion controller: "cubic" | "newreno" | "bbr"
congestion = "cubic"
# Initial RTT estimate (milliseconds) — quinn default is 333ms
initial_rtt_ms = 10
# Maximum idle timeout (seconds)
max_idle_timeout_secs = 30
# Maximum ACK delay (milliseconds) — quinn default is 25ms
max_ack_delay_ms = 5
# Stream initial max data (bytes) — quinn default is 100KB
stream_initial_max_data = 1048576
# Crypto buffer size (bytes)
crypto_buffer_size = 8192

[runtime]
# Runtime flavor: "current_thread" | "multi_thread"
flavor = "multi_thread"
# Number of worker threads (0 = auto-detect physical core count)
worker_threads = 0
# Thread stack size in bytes (default 2MB, Tokio default is 8MB)
thread_stack_size = 2097152
# Maximum blocking thread pool size
max_blocking_threads = 512

[discovery]
# Seed node multiaddrs for bootstrap
seed_nodes = [
    "quic://seed1.aafp.io:4433",
    "quic://seed2.aafp.io:4433",
]
# Minimum peers to discover before bootstrap is complete
min_peers = 10
# Bootstrap timeout (seconds)
bootstrap_timeout_secs = 30
# Routing table refresh interval (seconds)
refresh_interval_secs = 900
# K-bucket size (max peers per bucket)
k_bucket_size = 20
# Concurrency factor for iterative lookups
alpha = 3
# Replication factor (closest peers that store a record)
replication_factor = 5
# Maximum lookup iterations
max_lookup_iterations = 10
# Lookup cache TTL (seconds)
cache_ttl_secs = 300

[pool]
# Maximum number of pooled connections
max_size = 100
# Idle timeout before a connection is evicted (seconds)
idle_timeout_secs = 60

[routing]
# Selection strategy: "p2c" | "weighted_random" | "least_connections" |
#                     "lowest_latency" | "epsilon_greedy"
strategy = "p2c"
# Epsilon for epsilon-greedy (only used if strategy = "epsilon_greedy")
# epsilon = 0.1

# Circuit breaker
circuit_breaker_failure_threshold = 5
circuit_breaker_cooldown_secs = 10
circuit_breaker_half_open_max_trials = 1

# Hedging
hedge_enabled = false
hedge_delay_ms = 50
hedge_adaptive = true
hedge_max_concurrent = 4

# Score fusion weights (must sum to 1.0)
static_weight = 0.5
dynamic_weight = 0.5

# Dynamic scoring weights (need not sum to 1.0 — normalized internally)
score_weight_latency = 0.35
score_weight_success = 0.30
score_weight_load = 0.15
score_weight_availability = 0.15
score_weight_cost = 0.05
# Reference latency for normalization (ms)
latency_ref_ms = 50.0
# Reference cost for normalization (micro-USD)
cost_ref_micro_usd = 100

# Staleness threshold for pruning dynamic metrics (seconds)
staleness_threshold_secs = 60

# Retry
retry_max_retries = 3
retry_base_delay_ms = 50
retry_max_delay_secs = 5
retry_jitter = 1.0  # full jitter

[pubsub]
# GossipSub mesh parameters (libp2p v1.1 defaults)
mesh_degree = 6
mesh_low = 4
mesh_high = 12
mesh_lazy = 6
# Heartbeat interval for mesh maintenance (seconds)
heartbeat_interval_secs = 1
# Fanout TTL — how long to remember seen message IDs (seconds)
fanout_ttl_secs = 60
# Maximum message size (bytes)
max_message_size = 1048576

# Peer scoring (GossipSub v1.1 — 7 components)
peer_score_p1_weight = 10.0
peer_score_p1_cap = 100.0
peer_score_p2_weight = -10.0
peer_score_p2_colocation_threshold = 5
peer_score_p3_weight = -100.0
peer_score_p3_decay = 0.9
peer_score_p4_weight = 5.0
peer_score_p5_weight = -2.0
peer_score_p6_weight = 1.0
peer_score_p7_weight = 1.0
peer_score_graylist_threshold = -100.0
peer_score_prune_threshold = -1000.0
peer_score_decay_interval_secs = 10

[memory]
# Buffer pool
buffer_pool_size = 256
buffer_initial_capacity = 4096
buffer_max_capacity = 1048576
buffer_idle_timeout_secs = 60

# Replay cache (RFC-0002 §6.7)
replay_cache_retention_secs = 300
replay_cache_max_entries = 100000

# Server resource limits
max_connections = 100
handshake_rate_limit = 10

[keepalive]
# Application-layer PING/PONG (RFC-0002 §4.7-4.8)
interval_secs = 30
timeout_secs = 10
max_missed = 3

[logging]
# Log level: "error" | "warn" | "info" | "debug" | "trace"
level = "info"
# Output format: "text" | "json"
format = "text"
# Per-module overrides (RUST_LOG-style directives)
[logging.modules]
aafp_sdk = "info"
aafp_transport_quic = "info"
aafp_discovery = "debug"
aafp_crypto = "warn"

[metrics]
# Prometheus exporter
enabled = true
bind_addr = "0.0.0.0:9090"
# Collection interval for internal snapshots (seconds)
collection_interval_secs = 15
# Agent ID label (auto-set from keypair if omitted)
# agent_id = "abc123"
```

---

## 3. Transport Tuning (QUIC)

The QUIC transport is the foundation of AAFP's performance. All
agent-to-agent communication flows over QUIC connections established via
`quinn` + `rustls` with post-quantum key exchange (`X25519MLKEM768`).

**Source:** `aafp-transport-quic/src/config.rs` — `QuicConfig`

### Key Parameters

| Parameter | Default | Quinn Default | Purpose |
|-----------|---------|---------------|---------|
| `max_concurrent_streams` | 100 | — | Max bidirectional + unidirectional streams per connection |
| `keep_alive_interval` | 30s | — | QUIC-level keep-alive ping interval |
| `congestion` | `cubic` | `cubic` | Congestion controller (`cubic`, `newreno`, `bbr`) |
| `initial_rtt` | 10ms | 333ms | Initial RTT estimate — lower = faster retransmit timer |
| `max_idle_timeout` | 30s | 30s | Connection idle timeout before close |
| `max_ack_delay` | 5ms | 25ms | Max delay before receiver sends ACK — lower = faster feedback |
| `stream_initial_max_data` | 1MB | 100KB | Stream receive window — larger = first message without waiting |
| `crypto_buffer_size` | 8192 | — | TLS crypto buffer — tuned for small RPC messages |

### Congestion Controllers

AAFP supports three congestion controllers via `CongestionController` enum
(`aafp-transport-quic/src/congestion.rs`):

- **Cubic** (default): TCP-friendly, good for bulk transfer and shared
  networks. Uses loss-based window control. Best for production servers
  on the public internet.
- **NewReno**: Simple, conservative, standard. Use when interoperability
  with older QUIC stacks matters.
- **BBR** (experimental): Estimates bandwidth and RTT, doesn't rely on
  packet loss. Better for low-latency RPC because it doesn't wait for
  loss to reduce the window. Recommended for LAN/localhost agent meshes.

### Presets

The `QuicConfig` struct provides two presets:

```rust
// Low-latency: BBR, 10ms RTT, 5ms ACK, 1MB window, 8KB crypto buffer
let config = QuicConfig::low_latency();

// Bulk transfer: Cubic, 100ms RTT, 25ms ACK, 10MB window, 64KB crypto buffer
let config = QuicConfig::bulk_transfer();
```

### Tuning Guidelines

**For low-latency RPC (agent-to-agent on LAN/localhost):**
- Use `bbr` congestion control — avoids loss-based backoff
- Set `initial_rtt_ms = 5` for localhost, `10` for LAN
- Set `max_ack_delay_ms = 5` for faster feedback
- Set `stream_initial_max_data = 1048576` (1MB) so the first RPC
  message doesn't wait for flow control credit
- Set `crypto_buffer_size = 8192` — small RPC messages fit in one buffer

**For bulk transfer (file transfer, model weights):**
- Use `cubic` congestion control — TCP-friendly on shared networks
- Set `initial_rtt_ms = 100` — avoid premature retransmits on WAN
- Set `max_ack_delay_ms = 25` — reduce ACK overhead for large flows
- Set `stream_initial_max_data = 10485760` (10MB) — large window for
  sustained throughput
- Set `crypto_buffer_size = 65536` (64KB) — larger TLS records

**For high-concurrency servers:**
- Increase `max_concurrent_streams` to 256+ (each stream is a separate
  RPC channel on a single connection)
- Keep `max_idle_timeout` at 30s — idle connections should be reaped
- Enable `keep_alive_interval` at 15-30s to detect dead peers

### TOML Example

```toml
[transport]
bind_addr = "0.0.0.0:4433"
max_concurrent_streams = 256
keep_alive_interval_secs = 15
congestion = "bbr"
initial_rtt_ms = 10
max_idle_timeout_secs = 30
max_ack_delay_ms = 5
stream_initial_max_data = 1048576
crypto_buffer_size = 8192
```

---

## 4. Runtime Tuning (Tokio)

The Tokio runtime configuration controls how async tasks are scheduled.
This is critical for performance — the wrong runtime flavor can add
significant overhead.

**Source:** `aafp-sdk/src/runtime_config.rs` — `RuntimeConfig`

### Key Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `flavor` | `multi_thread` | Runtime type (`current_thread` or `multi_thread`) |
| `worker_threads` | 0 (auto) | Number of worker threads (0 = physical core count) |
| `thread_stack_size` | 2MB (2097152) | Stack size per thread (Tokio default is 8MB) |
| `max_blocking_threads` | 512 | Max threads in the blocking pool |

### Runtime Flavors

**`current_thread`** — Single-threaded runtime. All tasks run on one
thread with no work-stealing. L1 profiling showed that 84% of time in
the multi-thread runtime was spent in `pthread_cond_signal`/`cvwait`
(cross-core scheduling overhead). For localhost RPC where all peers are
on the same machine, `current_thread` eliminates this overhead entirely.

**`multi_thread`** — Work-stealing runtime. Tasks are distributed across
worker threads. Best for production servers handling many concurrent
connections from remote peers. Each worker thread can independently
process I/O and tasks.

### Presets

```rust
// Low-latency: current_thread, 1 worker, 2MB stack, 512 blocking threads
let config = RuntimeConfig::low_latency();

// High-throughput: multi_thread, auto workers, 2MB stack, 512 blocking threads
let config = RuntimeConfig::high_throughput();
```

### Tuning Guidelines

**For localhost / single-machine agent meshes:**
- Use `current_thread` — eliminates condvar overhead (84% reduction)
- Set `thread_stack_size = 2097152` (2MB) — better cache utilization
  than Tokio's 8MB default
- Keep `max_blocking_threads = 512` — sufficient for blocking I/O

**For production servers:**
- Use `multi_thread` — leverage all cores for concurrent connections
- Set `worker_threads = 0` (auto-detect) or pin to physical core count
- Set `thread_stack_size = 2097152` (2MB) — 4x memory savings vs 8MB
  with 1000+ connections
- Increase `max_blocking_threads` to 1024 if doing heavy blocking I/O
  (SQLite, file I/O)

**For edge / resource-constrained devices:**
- Use `current_thread` — minimal memory footprint
- Set `thread_stack_size = 524288` (512KB) — further reduce memory
- Set `max_blocking_threads = 64` — cap blocking pool

### TOML Example

```toml
[runtime]
flavor = "multi_thread"
worker_threads = 0          # auto-detect
thread_stack_size = 2097152 # 2MB
max_blocking_threads = 512
```

---

## 5. Connection Pool Tuning

The connection pool reuses QUIC connections to peers, eliminating the
240µs handshake cost for repeated RPCs. Instead of creating a new
connection (TLS + AAFP handshake) for each RPC, the pool reuses an
existing connection and opens a new bidirectional stream (14µs) — a
17x improvement.

**Source:** `aafp-sdk/src/connection_pool.rs` — `PoolConfig`

### Key Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `max_size` | 100 | Maximum pooled connections |
| `idle_timeout` | 60s | Time before an unused connection is evicted |

### Health Checking

Before returning a pooled connection, the pool opens a test stream
(`open_bi`). If this fails, the connection is stale (peer closed it)
and a new connection is created. To avoid overhead on every call,
connections reused within 5 seconds (`HEALTH_CHECK_THRESHOLD`) are
assumed healthy — the peer hasn't had time to close them.

### Tuning Guidelines

- **`max_size`**: Set to the expected number of unique peers you
  communicate with concurrently. Too small → connections are evicted
  and re-established (240µs cost). Too large → memory waste (each
  connection holds TLS state, crypto keys, stream buffers).
- **`idle_timeout`**: 60s is good for active workloads. For long-lived
  agents with sporadic communication, increase to 300s. For high-churn
  environments, decrease to 30s to free resources faster.

### TOML Example

```toml
[pool]
max_size = 200
idle_timeout_secs = 120
```

---

## 6. DHT Tuning

The capability DHT uses Kademlia-style routing with 256 k-buckets keyed
by XOR distance. It supports iterative lookup with α=3 concurrency,
PEX peer exchange, and record replication with k=5.

**Source:** `aafp-discovery/src/dht_router.rs` — `DhtRouterConfig`

### Key Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `k` (k_bucket_size) | 20 | Max peers per k-bucket (Kademlia standard) |
| `alpha` | 3 | Concurrency factor for iterative lookups |
| `replication` | 5 | Number of closest peers that store a record |
| `max_lookup_iterations` | 10 | Max iterations in an iterative lookup |
| `bucket_refresh_interval` | 900s (15min) | Interval for refreshing stale k-buckets |
| `cache_ttl` | 300s (5min) | TTL for lookup result cache |

### Constants

```rust
pub const K_BUCKET_SIZE: usize = 20;       // Kademlia default
pub const ID_BITS: usize = 256;            // AgentId is 256-bit (32 bytes)
pub const ALPHA: usize = 3;                // Lookup concurrency
pub const REPLICATION_FACTOR: usize = 5;   // Record replication
pub const BUCKET_REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);
```

### Tuning Guidelines

- **`k` (k-bucket size)**: 20 is the Kademlia standard. Increasing to
  40 improves routing table completeness in large networks (>500 nodes)
  at the cost of memory. Decreasing to 8 is fine for small networks
  (<50 nodes).
- **`alpha`**: 3 is standard. Increasing to 5-6 speeds up lookups in
  high-latency networks but increases query fan-out. Keep at 3 for
  most deployments.
- **`replication`**: 5 ensures records survive on 5 peers. For
  critical records, increase to 8-10. For ephemeral data, 3 is fine.
- **`bucket_refresh_interval`**: 15 minutes is standard. In
  high-churn networks, decrease to 5 minutes. In stable networks,
  increase to 30 minutes to reduce traffic.
- **`cache_ttl`**: 5 minutes balances freshness vs DHT query load.
  For frequently-queried capabilities, the cache eliminates repeated
  lookups. Decrease to 60s for dynamic environments.

### TOML Example

```toml
[discovery]
k_bucket_size = 20
alpha = 3
replication_factor = 5
max_lookup_iterations = 10
refresh_interval_secs = 900
cache_ttl_secs = 300
```

---

## 7. Discovery Tuning

Discovery combines bootstrap (connecting to seed nodes), PEX (peer
exchange), and DHT lookups to find agents with specific capabilities.

**Source:** `aafp-discovery/src/bootstrap.rs` — `BootstrapConfig`
and `aafp-discovery/src/dht_router.rs` — `BootstrapConfig` (router-level)

### Key Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `seed_nodes` | `[]` | Seed node multiaddrs for initial bootstrap |
| `min_peers` | 3-10 | Minimum peers before bootstrap is complete |
| `bootstrap_timeout` | 30s | Max time to wait for bootstrap |
| `refresh_interval` | 900s (15min) | Periodic routing table refresh |

### Bootstrap Process

1. Connect to each configured seed node
2. Send PEX (Peer Exchange) request to each seed
3. Add received peers to the routing table
4. Connect to k closest peers from the routing table
5. Announce own record to closest peers
6. Return when `min_peers` connected or `bootstrap_timeout` reached

### Tuning Guidelines

- **`seed_nodes`**: Always configure at least 2-3 seed nodes for
  redundancy. Seeds should be geographically distributed. Format:
  `quic://seed1.aafp.io:4433`.
- **`min_peers`**: 10 is good for production. For testing, 3 is fine.
  Higher values increase bootstrap time but improve routing table
  completeness.
- **`bootstrap_timeout`**: 30s is reasonable for most networks. For
  high-latency satellite links, increase to 120s. For LAN, 10s.
- **`refresh_interval`**: 15 minutes is standard. In high-churn
  networks (agents joining/leaving frequently), decrease to 5 minutes.

### Semantic Index (D3)

The local semantic index (`aafp-discovery/src/semantic/index.rs`)
provides secondary indexes over discovered capabilities:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `ttl` | 300s | Records older than this are evicted |
| `max_size` | 10,000 | Hard cap on total records |

### TOML Example

```toml
[discovery]
seed_nodes = [
    "quic://seed1.aafp.io:4433",
    "quic://seed2.aafp.io:4433",
    "quic://seed3.aafp.io:4433",
]
min_peers = 10
bootstrap_timeout_secs = 30
refresh_interval_secs = 900
```

---

## 8. Routing Tuning

The adaptive routing plane selects the best peer for each RPC call using
a composite scoring function that fuses static scores (capability match
quality) with dynamic scores (observed latency, success rate, load,
availability, cost).

**Source:** `aafp-sdk/src/routing/config.rs` — `RoutingConfig`,
`aafp-sdk/src/routing/scoring.rs` — `DynamicScoreConfig`,
`aafp-sdk/src/routing/retry.rs` — `RetryConfig`

### Selection Strategies

| Strategy | Description | When to use |
|----------|-------------|-------------|
| `p2c` (Power-of-Two) | Sample 2 random candidates, pick higher score | Default — good balance |
| `weighted_random` | Sample by combined score weight | When you want load spreading |
| `least_connections` | Route to peer with fewest in-flight calls | When load is the primary concern |
| `lowest_latency` | Route to peer with lowest EWMA latency | When latency is critical |
| `epsilon_greedy` | Explore with prob ε, exploit otherwise | When exploring new peers |

### Circuit Breaker

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `failure_threshold` | 5 | Consecutive failures to trip circuit open |
| `cooldown` | 10s | Open → HalfOpen wait duration |
| `half_open_max_trials` | 1 | Max trial requests in HalfOpen state |

When a peer fails `failure_threshold` times consecutively, the circuit
opens and no traffic is sent to that peer for `cooldown` seconds. After
cooldown, the circuit enters HalfOpen and allows `half_open_max_trials`
trial requests. If they succeed, the circuit closes; if they fail, it
reopens.

### Hedging

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `enabled` | false | Whether request hedging is active |
| `delay` | 50ms | Delay before sending a secondary (hedge) request |
| `adaptive` | true | Only hedge if primary is predicted to miss deadline |
| `max_concurrent_hedges` | 4 | Upper bound on concurrent hedge requests |

Hedging sends a duplicate request to a second peer after `delay` if the
primary hasn't responded. The first response wins; the other is
cancelled. This tail-latency mitigation is powerful but doubles load
when triggered — use `adaptive = true` to only hedge when the primary
is predicted to miss its deadline.

### Dynamic Scoring Weights

The five dynamic sub-scores are combined with these weights (they need
not sum to 1.0 — the final score is normalized by total weight):

| Weight | Default | Sub-score |
|--------|---------|-----------|
| `weight_latency` | 0.35 | EWMA latency (lower = better) |
| `weight_success` | 0.30 | Success rate from sliding window |
| `weight_load` | 0.15 | In-flight + queue depth (lower = better) |
| `weight_availability` | 0.15 | Health probe status |
| `weight_cost` | 0.05 | Cost in micro-USD (lower = better) |

### Score Fusion

The total score is: `static_weight * static_score + dynamic_weight *
dynamic_score`, where `static_weight + dynamic_weight == 1.0`. Default
is 0.5/0.5. Increase `static_weight` when capability match quality
matters more than observed performance. Increase `dynamic_weight` when
real-time health should drive selection.

### Retry

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `max_retries` | 3 | Max retry attempts (not counting initial call) |
| `base_delay` | 50ms | Base delay for first retry |
| `max_delay` | 5s | Cap on computed delay |
| `jitter` | 1.0 | Full jitter (randomizes delay in [0, computed]) |

Retry handles **transient** errors (transport timeouts, stream resets)
but NOT `CircuitOpen` or `ConcurrencyLimit` (those are routing signals
— skip to the next candidate) and NOT application-level errors (the
handler ran and returned an error — retrying would duplicate
side-effects for non-idempotent calls).

### TOML Example

```toml
[routing]
strategy = "p2c"

circuit_breaker_failure_threshold = 5
circuit_breaker_cooldown_secs = 10
circuit_breaker_half_open_max_trials = 1

hedge_enabled = true
hedge_delay_ms = 50
hedge_adaptive = true
hedge_max_concurrent = 4

static_weight = 0.5
dynamic_weight = 0.5

score_weight_latency = 0.35
score_weight_success = 0.30
score_weight_load = 0.15
score_weight_availability = 0.15
score_weight_cost = 0.05
latency_ref_ms = 50.0
cost_ref_micro_usd = 100

staleness_threshold_secs = 60

retry_max_retries = 3
retry_base_delay_ms = 50
retry_max_delay_secs = 5
retry_jitter = 1.0
```

---

## 9. PubSub Tuning

AAFP uses GossipSub v1.1 for pub/sub messaging. Each peer maintains a
partial mesh of `D` peers per topic (not all subscribers), with
IHAVE/IWANT gossip for message discovery and peer scoring for
misbehaving peers.

**Source:** `aafp-sdk/src/pubsub/gossipsub.rs` — `GossipSubConfig`,
`PeerScoringConfig`

### Mesh Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `d` (mesh_degree) | 6 | Target mesh degree per topic |
| `d_lo` (mesh_low) | 4 | Graft new peers if mesh drops below this |
| `d_hi` (mesh_high) | 12 | Prune excess if mesh exceeds this |
| `d_lazy` (mesh_lazy) | 6 | Peers to gossip IHAVE to per heartbeat |
| `heartbeat_interval` | 1s | Mesh maintenance interval |
| `fanout_ttl` | 60s | How long to remember seen message IDs |
| `max_message_size` | 1MB | Max message size (mirrors connection limits) |

### Peer Scoring (7 Components)

GossipSub v1.1 uses 7 weighted scoring components to evaluate peer
behavior:

| Component | Weight | Default | Purpose |
|-----------|--------|---------|---------|
| P1 (app-specific) | 10.0 | cap 100.0 | Topic-specific behavior |
| P2 (IP colocation) | -10.0 | threshold 5 | Penalty for many peers from same IP |
| P3 (behavioral) | -100.0 | decay 0.9 | Invalid messages, spam |
| P4 (app reward) | 5.0 | — | Application-specific reward |
| P5 (latency) | -2.0 | — | Message delivery latency penalty |
| P6 (mesh participation) | 1.0 | — | In-mesh vs not |
| P7 (first deliveries) | 1.0 | — | Reward for novel message delivery |

| Threshold | Default | Action |
|-----------|---------|--------|
| `graylist_threshold` | -100.0 | Peer not pruned but not gossiped to |
| `prune_threshold` | -1000.0 | Peer pruned from all meshes |
| `decay_interval` | 10s | Score decay interval |

### Tuning Guidelines

- **Mesh degree (`d`)**: 6 is the libp2p default. For high-throughput
  topics, increase to 8-12. For resource-constrained devices, decrease
  to 4.
- **`max_message_size`**: 1MB is the default. For large payloads
  (model weights, documents), increase to 10MB. Be aware that larger
  messages increase memory pressure and gossip overhead.
- **Peer scoring**: The defaults are tuned for public networks. For
  private/trusted networks, you can reduce P3 (behavioral) penalty
  weight since spam is less likely.
- **Heartbeat**: 1s is standard. For latency-sensitive topics,
  decrease to 500ms. For low-bandwidth environments, increase to 5s.

### TOML Example

```toml
[pubsub]
mesh_degree = 6
mesh_low = 4
mesh_high = 12
mesh_lazy = 6
heartbeat_interval_secs = 1
fanout_ttl_secs = 60
max_message_size = 1048576

peer_score_p1_weight = 10.0
peer_score_p1_cap = 100.0
peer_score_p2_weight = -10.0
peer_score_p2_colocation_threshold = 5
peer_score_p3_weight = -100.0
peer_score_p3_decay = 0.9
peer_score_p4_weight = 5.0
peer_score_p5_weight = -2.0
peer_score_p6_weight = 1.0
peer_score_p7_weight = 1.0
peer_score_graylist_threshold = -100.0
peer_score_prune_threshold = -1000.0
peer_score_decay_interval_secs = 10
```

---

## 10. Memory Tuning

### Buffer Pool

The thread-local buffer pool provides reusable `BytesMut` buffers to
eliminate heap allocations on the hot path. After warmup, `acquire()`
returns a pre-allocated buffer and `release()` returns it for reuse.

**Source:** `aafp-transport-quic/src/buffer_pool.rs` — `BufferPoolConfig`

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `pool_size` | 256 | Max buffers per thread |
| `initial_capacity` | 4096 (4KB) | Initial capacity for new buffers |
| `max_capacity` | 1048576 (1MB) | Buffers larger than this are not pooled |
| `idle_timeout_secs` | 60 | Buffers unused for this long are freed |

The pool is thread-local — each thread has its own pool with no lock
contention. Buffers grow as needed up to `max_capacity`; buffers that
exceed `max_capacity` on release are dropped (not pooled) to prevent
memory bloat from oversized messages.

### Replay Cache

The nonce replay cache (RFC-0002 §6.7) is a time-bounded set of
observed `(agent_id, nonce)` pairs. It rejects replayed handshakes
before signature verification, conserving CPU.

**Source:** `aafp-crypto/src/replay_cache.rs` — `ReplayCache`

| Parameter | Default | Range | Purpose |
|-----------|---------|-------|---------|
| `retention` | 300s | 60s–3600s | How long to keep entries |
| `max_entries` | 100,000 | 1,000–10,000,000 | Hard cap on entries |

The cache uses LRU eviction when `max_entries` is reached. Entries are
evicted lazily on `check`/`insert` and via explicit `evict_expired()`
calls.

### Server Resource Limits

**Source:** `aafp-sdk/src/server.rs` — `ServerConfig`

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `max_connections` | 100 | Max simultaneous authenticated connections |
| `handshake_rate_limit` | 10/sec/IP | Max handshake attempts per second per source IP |

The rate limiter uses a sliding window counter with periodic eviction
of expired entries (every 100 checks or when exceeding 10,000 tracked
IPs) to prevent unbounded memory growth from unique source IPs.

### OOM Handling

AAFP does not use a global OOM handler. Instead, each subsystem has
bounded data structures:

- Connection pool: `max_size` caps connections
- Buffer pool: `pool_size` caps buffers per thread
- Replay cache: `max_entries` caps entries
- Rate limiter: `max_entries` (10,000) caps tracked IPs
- Semantic index: `max_size` (10,000) caps records
- Decision log: ring buffer of 1024 entries

When these limits are reached, the oldest entries are evicted (LRU or
FIFO). This ensures predictable memory usage regardless of load.

### TOML Example

```toml
[memory]
buffer_pool_size = 256
buffer_initial_capacity = 4096
buffer_max_capacity = 1048576
buffer_idle_timeout_secs = 60

replay_cache_retention_secs = 300
replay_cache_max_entries = 100000

max_connections = 100
handshake_rate_limit = 10
```

---

## 11. Logging Configuration

AAFP uses the `tracing` crate for structured logging. Log output is
controlled via the `RUST_LOG` environment variable and the `[logging]`
config section.

### Log Levels

| Level | When to use |
|-------|-------------|
| `error` | Production — only failures that need action |
| `warn` | Production — failures + degraded states |
| `info` | Production — operational events (connections, handshakes) |
| `debug` | Staging — detailed flow tracing |
| `trace` | Development — every frame, every decision |

### Per-Module Overrides

The `RUST_LOG` directive supports per-module level overrides:

```bash
# Global info, but debug for transport, trace for discovery
RUST_LOG="info,aafp_transport_quic=debug,aafp_discovery=trace"
```

In the TOML config, this maps to the `[logging.modules]` table:

```toml
[logging]
level = "info"
format = "json"

[logging.modules]
aafp_sdk = "info"
aafp_transport_quic = "debug"
aafp_discovery = "trace"
aafp_crypto = "warn"
aafp_messaging = "info"
aafp_discovery = "debug"
```

### Output Format

- **`text`** (default): Human-readable formatted output. Best for
  development and terminal viewing.
- **`json`**: Structured JSON with fields. Best for production log
  aggregation (ELK, Loki, Datadog).

### File Rotation

AAFP does not include built-in log rotation. For production, pipe
output to a log rotator:

```bash
# Using logrotate
aafp agent start 2>&1 | rotatelogs /var/log/aafp/agent-%Y%m%d.log 86400

# Using systemd with journald (recommended)
# journald handles rotation automatically
systemctl start aafp-agent
journalctl -u aafp-agent -f
```

### Routing Decision Logging

The routing plane maintains a ring buffer of the last 1024 routing
decisions (`DecisionLog` in `aafp-sdk/src/routing/observability.rs`).
Each decision records: capability, candidates considered/filtered,
selected agent, scores, strategy, hedged, and elapsed microseconds.
This is emitted to the `tracing` span at `debug` level.

### TOML Example

```toml
[logging]
level = "info"
format = "json"

[logging.modules]
aafp_sdk = "info"
aafp_transport_quic = "info"
aafp_discovery = "debug"
aafp_crypto = "warn"
aafp_messaging = "info"
```

---

## 12. Metrics Configuration

AAFP exposes metrics in Prometheus text format via a built-in HTTP
endpoint. The `PrometheusExporter` serves `GET /metrics` on a
configurable port.

**Source:** `aafp-sdk/src/prometheus.rs` — `PrometheusExporter`,
`aafp-sdk/src/metrics.rs` — `AgentMetrics`

### Exported Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `aafp_connections_active` | gauge | Current active connections |
| `aafp_connections_total` | counter | Total connections established |
| `aafp_messages_sent_total` | counter | Total messages sent |
| `aafp_messages_received_total` | counter | Total messages received |
| `aafp_bytes_sent_total` | counter | Total bytes sent |
| `aafp_bytes_received_total` | counter | Total bytes received |
| `aafp_handshakes_completed_total` | counter | Successful handshakes |
| `aafp_handshakes_failed_total` | counter | Failed handshakes |
| `aafp_dht_records` | gauge | DHT records stored |
| `aafp_relay_connections` | gauge | Active relay connections |
| `aafp_messages_failed_total` | counter | Messages that failed |
| `aafp_uptime_seconds` | gauge | Agent uptime in seconds |

All metrics carry an `agent_id` label (hex string of the agent's
public key hash).

### Routing Metrics (10 additional)

The routing plane exposes 10 additional metrics (defined in
`aafp-sdk/src/routing/observability.rs`):

| Metric | Type | Description |
|--------|------|-------------|
| `aafp_routing_decisions_total` | counter | Total routing decisions |
| `aafp_routing_circuit_open_total` | counter | Circuit breaker opens |
| `aafp_routing_hedge_total` | counter | Hedged requests |
| `aafp_routing_hedge_won_total` | counter | Hedge won (faster than primary) |
| `aafp_routing_no_viable_total` | counter | No viable candidate found |
| `aafp_routing_decision_us` | histogram | Decision latency (microseconds) |
| `aafp_peer_latency_ewma_ms` | gauge | Per-peer EWMA latency |
| `aafp_peer_success_rate` | gauge | Per-peer success rate |
| `aafp_peer_in_flight` | gauge | Per-peer in-flight requests |
| `aafp_peer_circuit_state` | gauge | Per-peer circuit state (0=closed, 1=open, 2=half) |

### Health Status

`HealthStatus` is derived from metrics snapshots:

| Status | Condition |
|--------|-----------|
| **Unhealthy** | No active connections AND uptime > 60s, OR error rate > 50% |
| **Degraded** | Error rate > 10%, OR handshake failure rate > 30%, OR < 1 connection with uptime > 60s |
| **Healthy** | Everything else |

### Label Cardinality

The only label is `agent_id` — a single hex string per agent. This
keeps cardinality bounded (one series per agent). The routing metrics
add per-peer labels (`peer_id`), which scales with the number of
peers. For large networks (>1000 peers), consider scraping less
frequently or filtering peer-level metrics.

### Collection Interval

The Prometheus exporter serves metrics on-demand (pull model). The
`collection_interval_secs` parameter controls how often internal
snapshots are taken for the `MetricsRpcResponse` (used by the
`aafp.metrics` RPC method). Default: 15 seconds.

### TOML Example

```toml
[metrics]
enabled = true
bind_addr = "0.0.0.0:9090"
collection_interval_secs = 15
```

### Prometheus Scrape Config

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'aafp'
    scrape_interval: 15s
    static_configs:
      - targets: ['agent1:9090', 'agent2:9090', 'agent3:9090']
```

---

## 13. Deployment Scenarios

Below are complete, ready-to-use TOML config files for five deployment
scenarios. Each is tuned for the specific constraints of that
environment.

### 13.1 Development (`aafp-dev.toml`)

Optimized for local development: single-thread runtime, verbose
logging, minimal security overhead, fast bootstrap.

```toml
# ─── aafp-dev.toml — local development ───

[agent]
capabilities = ["inference", "debug"]
keypair_file = "./dev-agent.key"
is_relay = false
enable_pq = true

[transport]
bind_addr = "127.0.0.1:4433"
max_concurrent_streams = 32
keep_alive_interval_secs = 30
congestion = "bbr"
initial_rtt_ms = 5
max_idle_timeout_secs = 30
max_ack_delay_ms = 5
stream_initial_max_data = 1048576
crypto_buffer_size = 8192

[runtime]
# Single-thread: eliminates condvar overhead for localhost RPC
flavor = "current_thread"
worker_threads = 1
thread_stack_size = 2097152
max_blocking_threads = 128

[discovery]
seed_nodes = []
min_peers = 1
bootstrap_timeout_secs = 5
refresh_interval_secs = 300
k_bucket_size = 8
alpha = 3
replication_factor = 3
max_lookup_iterations = 5
cache_ttl_secs = 60

[pool]
max_size = 10
idle_timeout_secs = 30

[routing]
strategy = "p2c"

circuit_breaker_failure_threshold = 10
circuit_breaker_cooldown_secs = 5
circuit_breaker_half_open_max_trials = 1

hedge_enabled = false
hedge_delay_ms = 100
hedge_adaptive = true
hedge_max_concurrent = 2

static_weight = 0.5
dynamic_weight = 0.5

score_weight_latency = 0.35
score_weight_success = 0.30
score_weight_load = 0.15
score_weight_availability = 0.15
score_weight_cost = 0.05
latency_ref_ms = 50.0
cost_ref_micro_usd = 100

staleness_threshold_secs = 30

retry_max_retries = 2
retry_base_delay_ms = 25
retry_max_delay_secs = 2
retry_jitter = 1.0

[pubsub]
mesh_degree = 4
mesh_low = 2
mesh_high = 8
mesh_lazy = 4
heartbeat_interval_secs = 2
fanout_ttl_secs = 30
max_message_size = 1048576

peer_score_p1_weight = 10.0
peer_score_p1_cap = 100.0
peer_score_p2_weight = -10.0
peer_score_p2_colocation_threshold = 5
peer_score_p3_weight = -50.0
peer_score_p3_decay = 0.9
peer_score_p4_weight = 5.0
peer_score_p5_weight = -2.0
peer_score_p6_weight = 1.0
peer_score_p7_weight = 1.0
peer_score_graylist_threshold = -100.0
peer_score_prune_threshold = -1000.0
peer_score_decay_interval_secs = 10

[memory]
buffer_pool_size = 64
buffer_initial_capacity = 4096
buffer_max_capacity = 1048576
buffer_idle_timeout_secs = 60

replay_cache_retention_secs = 120
replay_cache_max_entries = 10000

max_connections = 20
handshake_rate_limit = 50

[keepalive]
interval_secs = 30
timeout_secs = 10
max_missed = 3

[logging]
level = "debug"
format = "text"

[logging.modules]
aafp_sdk = "debug"
aafp_transport_quic = "debug"
aafp_discovery = "trace"
aafp_crypto = "info"
aafp_messaging = "debug"

[metrics]
enabled = true
bind_addr = "127.0.0.1:9090"
collection_interval_secs = 5
```

### 13.2 Staging (`aafp-staging.toml`)

Tuned for pre-production testing: multi-thread runtime, moderate
logging, realistic pool sizes, hedging enabled for tail-latency
testing.

```toml
# ─── aafp-staging.toml — pre-production staging ───

[agent]
capabilities = ["inference", "translation", "summarization"]
keypair_file = "/var/lib/aafp/staging-agent.key"
is_relay = false
enable_pq = true

[transport]
bind_addr = "0.0.0.0:4433"
max_concurrent_streams = 128
keep_alive_interval_secs = 20
congestion = "bbr"
initial_rtt_ms = 10
max_idle_timeout_secs = 30
max_ack_delay_ms = 5
stream_initial_max_data = 1048576
crypto_buffer_size = 8192

[runtime]
flavor = "multi_thread"
worker_threads = 0
thread_stack_size = 2097152
max_blocking_threads = 256

[discovery]
seed_nodes = [
    "quic://staging-seed1.aafp.io:4433",
    "quic://staging-seed2.aafp.io:4433",
]
min_peers = 5
bootstrap_timeout_secs = 20
refresh_interval_secs = 600
k_bucket_size = 16
alpha = 3
replication_factor = 5
max_lookup_iterations = 10
cache_ttl_secs = 120

[pool]
max_size = 50
idle_timeout_secs = 60

[routing]
strategy = "p2c"

circuit_breaker_failure_threshold = 5
circuit_breaker_cooldown_secs = 10
circuit_breaker_half_open_max_trials = 1

hedge_enabled = true
hedge_delay_ms = 50
hedge_adaptive = true
hedge_max_concurrent = 4

static_weight = 0.5
dynamic_weight = 0.5

score_weight_latency = 0.35
score_weight_success = 0.30
score_weight_load = 0.15
score_weight_availability = 0.15
score_weight_cost = 0.05
latency_ref_ms = 50.0
cost_ref_micro_usd = 100

staleness_threshold_secs = 60

retry_max_retries = 3
retry_base_delay_ms = 50
retry_max_delay_secs = 5
retry_jitter = 1.0

[pubsub]
mesh_degree = 6
mesh_low = 4
mesh_high = 12
mesh_lazy = 6
heartbeat_interval_secs = 1
fanout_ttl_secs = 60
max_message_size = 1048576

peer_score_p1_weight = 10.0
peer_score_p1_cap = 100.0
peer_score_p2_weight = -10.0
peer_score_p2_colocation_threshold = 5
peer_score_p3_weight = -100.0
peer_score_p3_decay = 0.9
peer_score_p4_weight = 5.0
peer_score_p5_weight = -2.0
peer_score_p6_weight = 1.0
peer_score_p7_weight = 1.0
peer_score_graylist_threshold = -100.0
peer_score_prune_threshold = -1000.0
peer_score_decay_interval_secs = 10

[memory]
buffer_pool_size = 128
buffer_initial_capacity = 4096
buffer_max_capacity = 1048576
buffer_idle_timeout_secs = 60

replay_cache_retention_secs = 300
replay_cache_max_entries = 50000

max_connections = 50
handshake_rate_limit = 20

[keepalive]
interval_secs = 30
timeout_secs = 10
max_missed = 3

[logging]
level = "info"
format = "json"

[logging.modules]
aafp_sdk = "info"
aafp_transport_quic = "debug"
aafp_discovery = "debug"
aafp_crypto = "warn"
aafp_messaging = "info"

[metrics]
enabled = true
bind_addr = "0.0.0.0:9090"
collection_interval_secs = 10
```

### 13.3 Production (`aafp-prod.toml`)

Tuned for production servers: multi-thread runtime with auto workers,
TCP-friendly Cubic congestion, large pool, strict rate limiting,
structured JSON logging, full peer scoring.

```toml
# ─── aafp-prod.toml — production server ───

[agent]
capabilities = ["inference", "translation", "summarization", "code-review"]
keypair_file = "/var/lib/aafp/agent.key"
is_relay = false
enable_pq = true

[transport]
bind_addr = "0.0.0.0:4433"
max_concurrent_streams = 256
keep_alive_interval_secs = 15
congestion = "cubic"
initial_rtt_ms = 50
max_idle_timeout_secs = 60
max_ack_delay_ms = 10
stream_initial_max_data = 2097152
crypto_buffer_size = 16384

[runtime]
flavor = "multi_thread"
worker_threads = 0
thread_stack_size = 2097152
max_blocking_threads = 512

[discovery]
seed_nodes = [
    "quic://seed1.aafp.io:4433",
    "quic://seed2.aafp.io:4433",
    "quic://seed3.aafp.io:4433",
    "quic://seed4.aafp.io:4433",
]
min_peers = 20
bootstrap_timeout_secs = 60
refresh_interval_secs = 900
k_bucket_size = 20
alpha = 3
replication_factor = 5
max_lookup_iterations = 10
cache_ttl_secs = 300

[pool]
max_size = 200
idle_timeout_secs = 120

[routing]
strategy = "p2c"

circuit_breaker_failure_threshold = 5
circuit_breaker_cooldown_secs = 30
circuit_breaker_half_open_max_trials = 1

hedge_enabled = true
hedge_delay_ms = 75
hedge_adaptive = true
hedge_max_concurrent = 4

static_weight = 0.4
dynamic_weight = 0.6

score_weight_latency = 0.35
score_weight_success = 0.30
score_weight_load = 0.15
score_weight_availability = 0.15
score_weight_cost = 0.05
latency_ref_ms = 100.0
cost_ref_micro_usd = 100

staleness_threshold_secs = 60

retry_max_retries = 3
retry_base_delay_ms = 100
retry_max_delay_secs = 10
retry_jitter = 1.0

[pubsub]
mesh_degree = 6
mesh_low = 4
mesh_high = 12
mesh_lazy = 6
heartbeat_interval_secs = 1
fanout_ttl_secs = 60
max_message_size = 1048576

peer_score_p1_weight = 10.0
peer_score_p1_cap = 100.0
peer_score_p2_weight = -10.0
peer_score_p2_colocation_threshold = 5
peer_score_p3_weight = -100.0
peer_score_p3_decay = 0.9
peer_score_p4_weight = 5.0
peer_score_p5_weight = -2.0
peer_score_p6_weight = 1.0
peer_score_p7_weight = 1.0
peer_score_graylist_threshold = -100.0
peer_score_prune_threshold = -1000.0
peer_score_decay_interval_secs = 10

[memory]
buffer_pool_size = 256
buffer_initial_capacity = 8192
buffer_max_capacity = 1048576
buffer_idle_timeout_secs = 60

replay_cache_retention_secs = 300
replay_cache_max_entries = 100000

max_connections = 500
handshake_rate_limit = 10

[keepalive]
interval_secs = 30
timeout_secs = 10
max_missed = 3

[logging]
level = "info"
format = "json"

[logging.modules]
aafp_sdk = "info"
aafp_transport_quic = "warn"
aafp_discovery = "info"
aafp_crypto = "warn"
aafp_messaging = "info"

[metrics]
enabled = true
bind_addr = "0.0.0.0:9090"
collection_interval_secs = 15
```

### 13.4 Edge / IoT (`aafp-edge.toml`)

Tuned for resource-constrained edge devices (Raspberry Pi, ARM SBCs,
network appliances): single-thread runtime, small stack, minimal pool,
reduced k-bucket size, lower buffer counts.

```toml
# ─── aafp-edge.toml — edge / IoT device ───

[agent]
capabilities = ["sensor-ingest", "local-inference"]
keypair_file = "/etc/aafp/edge-agent.key"
is_relay = false
enable_pq = true

[transport]
bind_addr = "0.0.0.0:4433"
max_concurrent_streams = 16
keep_alive_interval_secs = 60
congestion = "cubic"
initial_rtt_ms = 50
max_idle_timeout_secs = 120
max_ack_delay_ms = 25
stream_initial_max_data = 65536
crypto_buffer_size = 4096

[runtime]
# Single-thread: minimal memory, no cross-core overhead
flavor = "current_thread"
worker_threads = 1
thread_stack_size = 524288
max_blocking_threads = 32

[discovery]
seed_nodes = [
    "quic://edge-gateway.aafp.io:4433",
]
min_peers = 3
bootstrap_timeout_secs = 60
refresh_interval_secs = 1800
k_bucket_size = 8
alpha = 2
replication_factor = 3
max_lookup_iterations = 5
cache_ttl_secs = 600

[pool]
max_size = 10
idle_timeout_secs = 300

[routing]
strategy = "least_connections"

circuit_breaker_failure_threshold = 3
circuit_breaker_cooldown_secs = 30
circuit_breaker_half_open_max_trials = 1

hedge_enabled = false
hedge_delay_ms = 200
hedge_adaptive = true
hedge_max_concurrent = 1

static_weight = 0.7
dynamic_weight = 0.3

score_weight_latency = 0.40
score_weight_success = 0.30
score_weight_load = 0.20
score_weight_availability = 0.10
score_weight_cost = 0.00
latency_ref_ms = 200.0
cost_ref_micro_usd = 100

staleness_threshold_secs = 120

retry_max_retries = 2
retry_base_delay_ms = 200
retry_max_delay_secs = 10
retry_jitter = 1.0

[pubsub]
mesh_degree = 4
mesh_low = 2
mesh_high = 6
mesh_lazy = 3
heartbeat_interval_secs = 5
fanout_ttl_secs = 120
max_message_size = 262144

peer_score_p1_weight = 5.0
peer_score_p1_cap = 50.0
peer_score_p2_weight = -5.0
peer_score_p2_colocation_threshold = 3
peer_score_p3_weight = -50.0
peer_score_p3_decay = 0.9
peer_score_p4_weight = 2.0
peer_score_p5_weight = -1.0
peer_score_p6_weight = 1.0
peer_score_p7_weight = 1.0
peer_score_graylist_threshold = -50.0
peer_score_prune_threshold = -500.0
peer_score_decay_interval_secs = 30

[memory]
buffer_pool_size = 32
buffer_initial_capacity = 2048
buffer_max_capacity = 262144
buffer_idle_timeout_secs = 120

replay_cache_retention_secs = 120
replay_cache_max_entries = 5000

max_connections = 20
handshake_rate_limit = 5

[keepalive]
interval_secs = 60
timeout_secs = 15
max_missed = 2

[logging]
level = "warn"
format = "json"

[logging.modules]
aafp_sdk = "warn"
aafp_transport_quic = "warn"
aafp_discovery = "info"
aafp_crypto = "error"
aafp_messaging = "warn"

[metrics]
enabled = true
bind_addr = "0.0.0.0:9090"
collection_interval_secs = 30
```

### 13.5 Mobile (`aafp-mobile.toml`)

Tuned for mobile devices (iOS/Android via PyO3 adapter): single-thread,
tiny stack, aggressive idle eviction, minimal buffer pool, long
keep-alive intervals to save battery, reduced peer scoring overhead.

```toml
# ─── aafp-mobile.toml — mobile device ───

[agent]
capabilities = ["voice-assistant", "image-classify"]
keypair_file = ""  # generated in app sandbox, persisted by the app
is_relay = false
enable_pq = true

[transport]
bind_addr = "0.0.0.0:0"
max_concurrent_streams = 8
keep_alive_interval_secs = 120
congestion = "cubic"
initial_rtt_ms = 100
max_idle_timeout_secs = 300
max_ack_delay_ms = 25
stream_initial_max_data = 65536
crypto_buffer_size = 4096

[runtime]
# Single-thread: minimal battery and memory impact
flavor = "current_thread"
worker_threads = 1
thread_stack_size = 262144
max_blocking_threads = 16

[discovery]
seed_nodes = [
    "quic://mobile-gateway.aafp.io:4433",
]
min_peers = 2
bootstrap_timeout_secs = 30
refresh_interval_secs = 3600
k_bucket_size = 4
alpha = 2
replication_factor = 2
max_lookup_iterations = 3
cache_ttl_secs = 600

[pool]
max_size = 5
idle_timeout_secs = 120

[routing]
strategy = "lowest_latency"

circuit_breaker_failure_threshold = 3
circuit_breaker_cooldown_secs = 60
circuit_breaker_half_open_max_trials = 1

hedge_enabled = false
hedge_delay_ms = 300
hedge_adaptive = true
hedge_max_concurrent = 1

static_weight = 0.8
dynamic_weight = 0.2

score_weight_latency = 0.50
score_weight_success = 0.30
score_weight_load = 0.10
score_weight_availability = 0.10
score_weight_cost = 0.00
latency_ref_ms = 150.0
cost_ref_micro_usd = 100

staleness_threshold_secs = 300

retry_max_retries = 1
retry_base_delay_ms = 500
retry_max_delay_secs = 5
retry_jitter = 1.0

[pubsub]
mesh_degree = 3
mesh_low = 2
mesh_high = 4
mesh_lazy = 2
heartbeat_interval_secs = 10
fanout_ttl_secs = 60
max_message_size = 131072

peer_score_p1_weight = 5.0
peer_score_p1_cap = 50.0
peer_score_p2_weight = -5.0
peer_score_p2_colocation_threshold = 3
peer_score_p3_weight = -50.0
peer_score_p3_decay = 0.9
peer_score_p4_weight = 2.0
peer_score_p5_weight = -1.0
peer_score_p6_weight = 1.0
peer_score_p7_weight = 1.0
peer_score_graylist_threshold = -50.0
peer_score_prune_threshold = -500.0
peer_score_decay_interval_secs = 60

[memory]
buffer_pool_size = 16
buffer_initial_capacity = 2048
buffer_max_capacity = 131072
buffer_idle_timeout_secs = 60

replay_cache_retention_secs = 120
replay_cache_max_entries = 2000

max_connections = 10
handshake_rate_limit = 5

[keepalive]
# Long interval to save battery; mobile connections are often suspended
interval_secs = 120
timeout_secs = 30
max_missed = 2

[logging]
level = "warn"
format = "json"

[logging.modules]
aafp_sdk = "warn"
aafp_transport_quic = "error"
aafp_discovery = "warn"
aafp_crypto = "error"
aafp_messaging = "warn"

[metrics]
enabled = false
bind_addr = "127.0.0.1:9090"
collection_interval_secs = 60
```

---

## Appendix: Quick Reference — Default Values Summary

| Subsystem | Parameter | Default | Source |
|-----------|-----------|---------|--------|
| Transport | max_concurrent_streams | 100 | `QuicConfig::default()` |
| Transport | congestion | cubic | `QuicConfig::default()` |
| Transport | initial_rtt | 10ms | `QuicConfig::default()` |
| Transport | max_idle_timeout | 30s | `QuicConfig::default()` |
| Transport | max_ack_delay | 5ms | `QuicConfig::default()` |
| Transport | stream_initial_max_data | 1MB | `QuicConfig::default()` |
| Transport | crypto_buffer_size | 8192 | `QuicConfig::default()` |
| Runtime | flavor | multi_thread | `RuntimeConfig::default()` |
| Runtime | worker_threads | 0 (auto) | `RuntimeConfig::default()` |
| Runtime | thread_stack_size | 2MB | `RuntimeConfig::default()` |
| Runtime | max_blocking_threads | 512 | `RuntimeConfig::default()` |
| Pool | max_size | 100 | `PoolConfig::default()` |
| Pool | idle_timeout | 60s | `PoolConfig::default()` |
| DHT | k_bucket_size | 20 | `K_BUCKET_SIZE` |
| DHT | alpha | 3 | `ALPHA` |
| DHT | replication | 5 | `REPLICATION_FACTOR` |
| DHT | bucket_refresh | 15min | `BUCKET_REFRESH_INTERVAL` |
| DHT | cache_ttl | 300s | `DhtRouter::with_cache_ttl` |
| Discovery | min_peers | 3 | `BootstrapConfig::default()` |
| Discovery | bootstrap_timeout | 30s | `BootstrapConfig::default()` |
| Routing | strategy | p2c | `RoutingConfig::default()` |
| Routing | circuit_breaker threshold | 5 | `CircuitBreakerConfig::default()` |
| Routing | circuit_breaker cooldown | 10s | `CircuitBreakerConfig::default()` |
| Routing | hedge_enabled | false | `HedgePolicy::default()` |
| Routing | hedge_delay | 50ms | `HedgePolicy::default()` |
| Routing | static_weight | 0.5 | `Weights::default()` |
| Routing | dynamic_weight | 0.5 | `Weights::default()` |
| Routing | staleness_threshold | 60s | `RoutingConfig::default()` |
| Retry | max_retries | 3 | `RetryConfig::default()` |
| Retry | base_delay | 50ms | `RetryConfig::default()` |
| Retry | max_delay | 5s | `RetryConfig::default()` |
| Retry | jitter | 1.0 | `RetryConfig::default()` |
| PubSub | mesh_degree (d) | 6 | `GossipSubConfig::default()` |
| PubSub | mesh_low (d_lo) | 4 | `GossipSubConfig::default()` |
| PubSub | mesh_high (d_hi) | 12 | `GossipSubConfig::default()` |
| PubSub | mesh_lazy (d_lazy) | 6 | `GossipSubConfig::default()` |
| PubSub | heartbeat | 1s | `GossipSubConfig::default()` |
| PubSub | max_message_size | 1MB | `GossipSubConfig::default()` |
| Buffer Pool | pool_size | 256 | `BufferPoolConfig::default()` |
| Buffer Pool | initial_capacity | 4KB | `BufferPoolConfig::default()` |
| Buffer Pool | max_capacity | 1MB | `BufferPoolConfig::default()` |
| Replay Cache | retention | 300s | `DEFAULT_RETENTION` |
| Replay Cache | max_entries | 100,000 | `DEFAULT_MAX_ENTRIES` |
| Server | max_connections | 100 | `ServerConfig::default()` |
| Server | handshake_rate_limit | 10/sec | `ServerConfig::default()` |
| KeepAlive | interval | 30s | `KeepAliveConfig::default()` |
| KeepAlive | timeout | 10s | `KeepAliveConfig::default()` |
| KeepAlive | max_missed | 3 | `KeepAliveConfig::default()` |
| Semantic Index | ttl | 300s | `IndexConfig::default()` |
| Semantic Index | max_size | 10,000 | `IndexConfig::default()` |
