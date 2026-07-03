# Track K: Serialization Optimization

**Priority:** MEDIUM-HIGH
**Duration:** Q3 (3-4 weeks)
**Blocked by:** G (Zero-Copy — needs buffer pool for in-place serialization)
**Blocks:** L (Kernel/Hardware — needs optimized serialization for kernel bypass)

---

## Problem

The current serialization stack has two paths:
1. **CBOR** (for AAFP protocol messages): `ciborium` crate — correct but not optimized for speed
2. **JSON** (for MCP/A2A transport): `serde_json` — general-purpose, allocates intermediate structures

For sub-100µs round-trip, serialization must be <10µs per message (both encode + decode). Current:
- JSON encode 1KB: ~5-10µs (estimated from 250µs round-trip minus QUIC + framing)
- JSON decode 1KB: ~5-10µs
- CBOR encode ClientHello: ~2-5µs
- CBOR decode ClientHello: ~2-5µs

---

## Steps

### K1: Benchmark serialization baseline
- Add `criterion` benchmarks for:
  - `serde_json::to_vec()` and `serde_json::from_slice()` for typical MCP messages (initialize, tools/list, tools/call)
  - `ciborium::ser::into_writer()` and `ciborium::de::from_reader()` for AAFP handshake messages
  - Compare against `simd-json` (Rust port of simdjson)
  - Compare against `minicbor` (minimal CBOR codec)
- Write results to `test-results/performance/serialization-baseline.json`
- **VERIFY:** Baseline shows current serialization cost per message type

### K2: Switch to `simd-json` for MCP transport
- Add `simd-json` dependency (SIMD-accelerated JSON parser, 2-4x faster than serde_json)
- `simd-json` is API-compatible with `serde_json` (uses serde derives)
- Replace `serde_json::to_vec()` with `simd_json::to_vec()` in MCP transport send path
- Replace `serde_json::from_slice()` with `simd_json::from_slice()` in MCP transport receive path
- Note: `simd-json` requires mutable input for deserialization (use `BytesMut` from buffer pool)
- **VERIFY:** JSON encode/decode benchmark shows 2-4x improvement

### K3: Switch to `minicbor` for AAFP protocol messages
- Add `minicbor` dependency (zero-allocation CBOR codec, 3-10x faster than ciborium for small messages)
- `minicbor` uses derive macros: `#[derive(Encode, Decode)]`
- Migrate `handshake_v1.rs` types from `ciborium` to `minicbor`
- Migrate `rpc_v1.rs` types from `ciborium` to `minicbor`
- Keep `ciborium` for golden trace compatibility (conformance tests verify byte-identical output)
- **VERIFY:** CBOR encode/decode benchmark shows 3-10x improvement. Golden traces still pass.

### K4: Pre-allocated serialization buffers
- For handshake messages (fixed maximum size), use stack-allocated arrays:
  - `ClientHello`: max ~4KB → `heapless::Vec<u8, 4096>`
  - `ServerHello`: max ~6KB → `heapless::Vec<u8, 6144>`
  - `ClientFinished`: max ~4KB → `heapless::Vec<u8, 4096>`
- This eliminates heap allocation for handshake messages entirely
- For MCP messages (variable size), use the buffer pool from Track G
- **VERIFY:** Handshake serialization shows 0 heap allocations

### K5: Custom codec for hot path messages
- For the most common messages (PING, tools/list, initialize), implement hand-optimized codecs:
  - `encode_ping(buf: &mut BytesMut, id: i64)` — 40 bytes, no serde overhead
  - `decode_ping(buf: &[u8]) -> (i64,)` — direct byte parsing, no serde
  - `encode_tools_list(buf: &mut BytesMut, id: i64)` — 50 bytes
  - `decode_tools_list_response(buf: &[u8]) -> Vec<Tool>` — custom parser
- These bypass serde entirely for the hottest message types
- **VERIFY:** Hot path message encode/decode is <100ns per message

### K6: Zero-copy string handling
- Use `bytes::Bytes` for string fields in deserialized messages (zero-copy slice of receive buffer)
- Instead of `String` (which copies), use `Bytes` (which is a reference-counted slice)
- This eliminates string allocation for JSON field values
- Requires custom serde deserializer or `bytes::Bytes` serde support
- **VERIFY:** Deserialization of a tools/list response shows 0 string allocations

### K7: End-to-end serialization benchmark
- Benchmark full message round-trip with optimized serialization:
  - MCP ping: encode + frame + QUIC + QUIC + frame + decode
  - MCP tools/list: encode + frame + QUIC + QUIC + frame + decode
  - AAFP handshake: ClientHello encode + frame + QUIC + frame + ServerHello decode
- Write results to `test-results/performance/serialization-optimized.json`
- Update `PERFORMANCE_REPORT.md`
- **VERIFY:**
  - JSON encode 1KB: <2µs (from ~5-10µs)
  - JSON decode 1KB: <2µs (from ~5-10µs)
  - CBOR encode ClientHello: <500ns (from ~2-5µs)
  - CBOR decode ClientHello: <500ns (from ~2-5µs)
  - PING encode+decode: <200ns

---

## Expected Outcomes

| Metric | Before | After | Method |
|--------|--------|-------|--------|
| JSON encode 1KB | ~5-10µs | <2µs | simd-json |
| JSON decode 1KB | ~5-10µs | <2µs | simd-json |
| CBOR encode ClientHello | ~2-5µs | <500ns | minicbor + stack alloc |
| CBOR decode ClientHello | ~2-5µs | <500ns | minicbor + stack alloc |
| PING encode+decode | ~1µs | <200ns | Custom codec |
| String allocations per message | 5-20 | 0 | Bytes zero-copy |

---

## Risks & Mitigations

1. **`simd-json` requires mutable input:** `simd_json::from_slice()` needs `&mut [u8]`. **Mitigation:** Buffer pool (Track G) provides `BytesMut` which is mutable. The receive path already reads into a mutable buffer.

2. **`minicbor` byte compatibility:** Golden traces were generated with `ciborium`. `minicbor` must produce identical bytes. **Mitigation:** Keep `ciborium` for golden trace generation and conformance tests. Use `minicbor` only for the hot path. Add a cross-check test that verifies both produce identical output.

3. **Custom codec maintenance burden:** Hand-written codecs for PING/tools-list must be kept in sync with the protocol. **Mitigation:** Only optimize the 3-5 hottest message types. Use serde for the rest. Add a test that verifies custom codec output matches serde output.

4. **`heapless` stack overflow risk:** Large stack-allocated buffers (>8KB) can overflow the stack. **Mitigation:** Use `heapless::Vec` with capacity 4096-6144 (safe for default 8MB stack). For larger messages, fall back to buffer pool.
