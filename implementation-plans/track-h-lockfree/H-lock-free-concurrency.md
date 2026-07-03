# Track H: Lock-Free Concurrency

**Priority:** CRITICAL
**Duration:** Q1-Q2 (4-6 weeks)
**Blocked by:** G (Zero-Copy — needs buffer pool for lock-free buffer management)
**Blocks:** I (Connection Lifecycle)

---

## Problem

The current send path uses `Arc<Mutex<Option<QuicSendStream>>>` — every send acquires a tokio mutex. Under concurrent load (multiple tasks sending on the same connection), this serializes all sends and creates contention.

**Current throughput: 160K msg/s (single sender). With 4 concurrent senders, throughput stays ~160K msg/s (serialized by mutex). Target: linear scaling to >1M msg/s with 8 senders.**

Additionally, the DHT uses a single `RwLock` for all operations — reads block during writes, and eviction holds the write lock for the entire scan.

---

## Architecture: Channel-Based Send + Sharded DHT

```
CURRENT (send path):
  Task A ──→ lock(mutex) ──→ write ──→ unlock
  Task B ──→ lock(mutex) ──→ write ──→ unlock  (blocked while A holds lock)
  Task C ──→ lock(mutex) ──→ write ──→ unlock  (blocked)

TARGET (send path):
  Task A ──→ mpsc.send() ──┐
  Task B ──→ mpsc.send() ──┼──→ dedicated writer task ──→ quinn write
  Task C ──→ mpsc.send() ──┘
  (no blocking — mpsc is lock-free for single-consumer)

CURRENT (DHT):
  All operations ──→ lock(RwLock) ──→ HashMap op ──→ unlock

TARGET (DHT):
  Shard 0 (key hash & 0xFF == 0) ──→ RwLock<Shard>
  Shard 1 (key hash & 0xFF == 1) ──→ RwLock<Shard>
  ...
  Shard 255 ──→ RwLock<Shard>
  (256-way sharding — contention reduced 256x)
```

---

## Steps

### H1: Benchmark lock contention profile
- Add concurrent sender benchmark (1, 2, 4, 8 concurrent senders)
- Measure throughput vs concurrency level
- Use `tokio::task::yield_now()` instrumentation to count mutex wait cycles
- Write results to `test-results/performance/lock-contention-baseline.json`
- **VERIFY:** Baseline shows throughput plateau at ~160K msg/s regardless of sender count

### H2: Replace send Mutex with mpsc channel
- Create `AafpMcpTransport::spawn_writer() -> Sender<BytesMut>`
- The transport holds a `mpsc::Sender<BytesMut>` instead of `Arc<Mutex<Option<QuicSendStream>>>`
- A dedicated writer task owns the `QuicSendStream` and drains the channel:
  ```rust
  while let Some(buf) = rx.recv().await {
      send_stream.write_all(&buf).await?;
      buf_pool.release(buf);
  }
  ```
- `send()` becomes: serialize into pooled buffer → `tx.send(buf).await` (no lock!)
- Channel capacity: 1024 (configurable). Backpressure via bounded channel.
- **VERIFY:** Concurrent sender benchmark shows linear scaling (4 senders → ~600K msg/s)

### H3: Lock-free receive path
- The receive path is already lock-free (single `QuicRecvStream`, no Mutex)
- Verify this with a concurrent receiver benchmark
- Add `recv_handle()` method that returns a `oneshot::Receiver` for the next message
- This allows multiple tasks to await messages without contending on the transport
- **VERIFY:** Concurrent receiver benchmark shows no contention

### H4: Sharded DHT (256-way)
- Create `crates/aafp-discovery/src/sharded_dht.rs`
- `ShardedDht` contains 256 `RwLock<Shard>` instances
- Each shard is a `HashMap<[u8; 32], AgentRecord>` + `HashMap<String, HashSet<[u8; 32]>>`
- Shard selection: `sha256(key)[0]` (first byte of hash → shard index)
- `get(key)`: read-lock shard[hash[0]], lookup
- `put(key, record)`: write-lock shard[hash[0]], insert
- `remove_agent(agent_id)`: iterate all 256 shards (write-lock each briefly)
- `evict_expired()`: iterate shards in round-robin (only lock 1 shard at a time)
- **VERIFY:** Concurrent DHT benchmark shows 100x+ improvement under read-heavy workload

### H5: Lock-free DHT reads via `ArcSwap`
- Replace `RwLock<Shard>` with `arc_swap::ArcSwap<Shard>` for read-heavy shards
- Reads: `shard.load()` → `Arc<Shard>` (lock-free, atomic load)
- Writes: `shard.store(Arc::new(new_shard))` (copy-on-write)
- Only use this for shards with >95% read ratio (detected via profiling)
- Other shards keep `RwLock` (copy-on-write is expensive for write-heavy workloads)
- **VERIFY:** Read-heavy DHT benchmark shows 10x improvement, write-heavy shows no regression

### H6: Connection-level concurrency model
- Document the concurrency model: 1 writer task per connection, N reader tasks
- Add `ConnectionHandle` that manages the writer task lifecycle
- When connection closes, writer task drains remaining messages and exits
- Add `ConnectionPool` that tracks active connections and their writer tasks
- **VERIFY:** Connection lifecycle test (open, send 1000 msgs, close) shows no leaks, no panics

### H7: End-to-end lock-free benchmark + verification
- Run concurrent sender/receiver benchmark with 1, 2, 4, 8, 16 concurrent tasks
- Compare against H1 baseline
- Write results to `test-results/performance/lockfree-results.json`
- Update `PERFORMANCE_REPORT.md`
- **VERIFY:** 
  - 8 concurrent senders: >800K msg/s (from 160K baseline)
  - DHT 100K concurrent reads: <10ms (from ~100ms baseline)
  - No deadlocks under stress test (1000 concurrent operations)

---

## Expected Outcomes

| Metric | Before | After | Method |
|--------|--------|-------|--------|
| Concurrent send throughput (8 senders) | 160K msg/s | >800K msg/s | mpsc channel |
| DHT read throughput (100K reads) | ~100ms | <10ms | Sharding + ArcSwap |
| Mutex acquisitions per send | 1 | 0 | Channel-based writer |
| DHT lock contention (concurrent reads) | High | Negligible | 256-way sharding |

---

## Risks & Mitigations

1. **mpsc channel backpressure:** If writer task is slower than producers, channel fills up. **Mitigation:** Bounded channel (1024 capacity). Producers await when full — natural backpressure. Configurable capacity.

2. **Sharded DHT memory overhead:** 256 shards × HashMap overhead. **Mitigation:** Shards use `HashMap` with `Default` hasher (no per-shard allocation until first insert). Empty shards cost ~0 bytes.

3. **ArcSwap copy-on-write cost:** For write-heavy shards, copying the entire shard on every write is expensive. **Mitigation:** Only use ArcSwap for read-heavy shards (detected via runtime profiling). Write-heavy shards keep RwLock.

4. **Writer task lifecycle complexity:** If the writer task panics, sends will hang. **Mitigation:** Writer task has error handling + graceful shutdown. Channel send returns error when writer is gone.
