# Track G: Zero-Copy Data Path

**Priority:** CRITICAL
**Duration:** Q1 (4-6 weeks)
**Blocked by:** nothing
**Blocks:** H (Lock-Free), K (Serialization)

---

## Problem

The current MCP transport hot path has **3 allocations per message**:

1. `serde_json::to_vec(&item)` → allocates `Vec<u8>` for JSON bytes
2. `Frame::data(MCP_STREAM_ID, json_bytes)` → moves bytes into Frame struct
3. `encode_frame(&frame)` → allocates new `Vec<u8>` with `Vec::with_capacity(header + ext + payload)`
4. `send_stream.write_all(&frame_bytes)` → copies into quinn's internal buffer

That's **3 heap allocations + 2 memcpy** per message. At 160K msg/s, that's 480K allocations/s and 320K copies/s — the allocator and memory bandwidth are the bottleneck.

**Current round-trip: 250µs. Target: <50µs.**

---

## Architecture: The "Write Path" Pipeline

```
CURRENT:
  JSON value → serde_json::to_vec() → Vec<u8> → Frame::data() → encode_frame() → Vec<u8> → write_all() → quinn buffer
  [3 allocations, 2 copies]

TARGET:
  JSON value → serialize directly into pre-allocated buffer → prepend frame header in-place → write buffer to quinn
  [0 allocations, 0 copies (buffer reused from pool)]
```

---

## Steps

### G1: Benchmark allocation profile
- Add `--features alloc-profile` to benchmarks that counts allocations per iteration
- Use `std::alloc::System` with a counting wrapper
- Measure: allocations/msg, bytes allocated/msg, allocator time/msg
- Write results to `test-results/performance/alloc-profile-baseline.json`
- **VERIFY:** Baseline shows 3 allocs/msg, ~1.2KB allocated/msg

### G2: Implement `BytesMut` buffer pool
- Create `crates/aafp-transport-quic/src/buffer_pool.rs`
- Pool of `bytes::BytesMut` buffers (default 4KB, grows up to 1MB)
- `acquire()` → returns a buffer from pool (or allocates if pool empty)
- `release()` → returns buffer to pool (clears but keeps capacity)
- Thread-local pool (no lock contention)
- Configurable pool size (default 256 buffers)
- **VERIFY:** Pool test shows 0 allocations after warmup for repeated send/recv cycles

### G3: Zero-copy frame encoding
- Add `encode_frame_into(buf: &mut BytesMut, frame: &Frame) -> Result<(), Error>`
- Writes 28-byte header directly into buffer, then appends payload via `buf.extend_from_slice()`
- No new Vec allocation — uses the provided buffer's capacity
- If buffer is too small, `reserve()` grows it in-place
- Keep existing `encode_frame()` for backward compat (delegates to `encode_frame_into` with a fresh Vec)
- **VERIFY:** `encode_frame_into` with pre-allocated buffer shows 0 allocations

### G4: Zero-copy frame decoding
- Add `decode_frame_from(buf: &[u8]) -> Result<(Frame, usize), Error>` returning frame + bytes consumed
- `read_data_frame_into(recv: &mut QuicRecvStream, buf: &mut BytesMut) -> Result<Option<()>, Error>`
- Reads header into stack array, then reads payload directly into `buf` (pre-sized)
- Returns payload as `buf.split_to(payload_len)` → `Bytes` (zero-copy slice)
- No `vec![0u8; payload_len]` allocation
- **VERIFY:** Decode with pre-allocated buffer shows 0 allocations for payload

### G5: Zero-copy MCP transport send path
- Refactor `AafpMcpTransport::send()` to:
  1. Acquire buffer from pool (`BytesMut::with_capacity(1024)` typical)
  2. Write 28-byte frame header directly into buffer (reserve space for payload length)
  3. Serialize JSON directly into buffer after header using `serde_json::to_writer(&mut buf, &item)`
  4. Backpatch payload length in header
  5. `send_stream.write_all(&buf)` — single write, no intermediate Vec
  6. Release buffer to pool
- **Result: 0 allocations, 1 write syscall per message**
- **VERIFY:** Send path benchmark shows 0 allocations/msg

### G6: Zero-copy MCP transport receive path
- Refactor `AafpMcpTransport::receive()` to:
  1. Acquire buffer from pool
  2. Read 28-byte header into stack array
  3. `buf.resize(payload_len)` (reuses capacity, no new alloc if pool buffer is large enough)
  4. `recv.read_exact(&mut buf)` — read payload directly into buffer
  5. `serde_json::from_slice(&buf)` — deserialize from buffer (no copy)
  6. Release buffer to pool
- **Result: 0 allocations for payload, 1 deserialization**
- **VERIFY:** Receive path benchmark shows 0 allocations/msg (after pool warmup)

### G7: Zero-copy raw JSON send/receive
- Apply the same buffer pool pattern to `send_raw_json()` and `recv_raw_json()`
- The PyO3 Python binding benefits from this too (Python ↔ Rust boundary)
- **VERIFY:** Python cross-SDK test still passes, `test_cross_sdk.py` shows no regression

### G8: End-to-end zero-copy benchmark + verification
- Run `cargo bench --bench mcp_transport` with the zero-copy path
- Compare against baseline (G1 numbers)
- Write results to `test-results/performance/zerocopy-results.json`
- Update `PERFORMANCE_REPORT.md` with before/after comparison
- **VERIFY:** Round-trip ping <150µs (from 250µs baseline), allocations/msg = 0

---

## Expected Outcomes

| Metric | Before | After | Method |
|--------|--------|-------|--------|
| Allocations per message | 3 | 0 | Buffer pool |
| Memory copies per message | 2 | 0 | In-place encoding |
| Round-trip ping | 250 µs | <150 µs | Eliminate allocator pressure |
| One-way throughput | 160K msg/s | >300K msg/s | No allocation overhead |
| Write syscalls per message | 1 | 1 | (unchanged — already optimal) |

---

## Risks & Mitigations

1. **Buffer pool memory growth:** Pool retains buffers even when idle. **Mitigation:** Add idle eviction (buffers unused for 60s are freed). Configurable max pool size.

2. **`serde_json::to_writer` into `BytesMut`:** Need to verify serde_json supports writing into a `BufMut`-like type. **Mitigation:** Implement a thin wrapper impl `io::Write` for `BytesMut` (trivial — `BytesMut` already implements `BufMut`).

3. **Buffer pool thread-local complexity:** Thread-local pools can cause memory imbalance across threads. **Mitigation:** Add a global fallback pool that thread-local pools can donate to / borrow from.

4. **Backward compatibility:** Existing `encode_frame()` / `decode_frame()` APIs must continue to work. **Mitigation:** Keep old APIs, new zero-copy APIs are additive.
