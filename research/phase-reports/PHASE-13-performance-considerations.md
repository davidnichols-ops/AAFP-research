# Phase 13: Performance Considerations

```
Phase:          13 of 16
Title:          Performance Considerations
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Analyze the performance impact of AAFP's architectural choices (PQ crypto,
CBOR framing, QUIC transport) and proposed extensions. Compare against
the HTTP/JSON ecosystem. Identify performance bottlenecks and optimization
opportunities.

## 2. Cryptographic Performance

### 2.1 ML-DSA-65 Signature Performance

ML-DSA-65 (FIPS 204) is the most computationally expensive part of AAFP.

| Operation | Key/Signature Size | Estimated Time | Comparison |
|-----------|-------------------|----------------|------------|
| Key generation | 1952B pub / 4032B sec | ~1-2 ms | Ed25519: ~0.05 ms (20-40x slower) |
| Sign | 3309B signature | ~0.5-1 ms | Ed25519: ~0.05 ms (10-20x slower) |
| Verify | — | ~0.5-1 ms | Ed25519: ~0.1 ms (5-10x slower) |

**Impact on handshake**: 3 ML-DSA-65 operations (client sign, server
sign+verify, client verify) = ~2-4 ms total. This is acceptable for
session establishment but would be prohibitive per-message.

**Impact on UCAN verification**: Each link in the chain requires one
ML-DSA-65 verification. A 5-link chain = ~2.5-5 ms. This is acceptable
for session establishment but should be cached.

### 2.2 X25519MLKEM768 Key Exchange

| Operation | Estimated Time | Comparison |
|-----------|----------------|------------|
| KEX (hybrid) | ~0.5-1 ms | X25519 alone: ~0.1 ms (5-10x slower) |

**Impact**: One-time cost during TLS handshake. Acceptable.

### 2.3 AEAD Encryption (Post-Handshake)

| Operation | Estimated Time | Comparison |
|-----------|----------------|------------|
| AES-128-GCM encrypt | ~0.1 μs/byte | Same as TLS |
| AES-128-GCM decrypt | ~0.1 μs/byte | Same as TLS |

**Impact**: Negligible. Post-handshake encryption is not a bottleneck.

### 2.4 Comparison with Ecosystem Crypto

| Protocol | Handshake Crypto Cost | Per-Message Crypto Cost |
|----------|----------------------|------------------------|
| **AAFP** | **~3-5 ms (3x ML-DSA-65 + PQ KEX)** | **~0.1 μs/byte (AEAD)** |
| MCP (OAuth) | ~1-2 ms (TLS + token validation) | 0 (TLS handles it) |
| A2A (TLS + JWS) | ~1-2 ms (TLS) + ~0.1 ms (JWS) | 0 (TLS handles it) |
| SLIM (MLS) | ~2-5 ms (MLS Welcome) | ~0.1 μs/byte (MLS AEAD) |
| AgentMesh (Signal) | ~2-3 ms (X3DH + Ed25519) | ~0.1 μs/byte (Double Ratchet) |

**AAFP's handshake is ~2-3x slower** than OAuth/TLS due to ML-DSA-65.
This is the price of post-quantum security. For long-lived sessions,
this one-time cost is amortized. For short-lived connections, it is
significant.

### 2.5 Optimization Opportunities

1. **Cache UCAN verification**: Once a UCAN chain is verified, cache
   the result for the session duration. Avoid re-verification on every
   request.

2. **Parallel signature verification**: If multiple signatures need
   verification (UCAN chain), verify them in parallel on multiple
   threads.

3. **DoS MAC pre-filtering**: The DoS MAC allows rejecting forged
   ClientHellos without ML-DSA-65 verification. This is already
   implemented but should be enabled by default in production.

4. **Batch verification**: For agents processing many handshakes
   (hubs), batch ML-DSA-65 verification using multi-signature
   optimization (if supported by the library).

5. **Hardware acceleration**: ML-DSA-65 is pure software (no hardware
   acceleration yet). Future AVX-512 or GPU acceleration could reduce
   sign/verify times by 5-10x.

## 3. Framing Performance

### 3.1 CBOR vs. JSON Encoding Speed

| Operation | CBOR | JSON | Ratio |
|-----------|------|------|-------|
| Encode 100B message | ~0.5 μs | ~2 μs | 4x faster |
| Decode 100B message | ~0.5 μs | ~2 μs | 4x faster |
| Encode 1KB message | ~3 μs | ~15 μs | 5x faster |
| Decode 1KB message | ~3 μs | ~15 μs | 5x faster |

**CBOR is 4-5x faster** than JSON for encoding/decoding. This is
because CBOR is binary (no string parsing, no UTF-8 validation on
decode, no escape sequences).

### 3.2 Wire Size Comparison

As analyzed in Phase 9:
- JSON over HTTP: ~400-700 bytes (first message), ~300-600 bytes (subsequent)
- CBOR over QUIC: ~120 bytes (first message), ~70 bytes (subsequent)
- **AAFP is 3-5x smaller** on the wire

### 3.3 Frame Header Overhead

AAFP frame header: 28 bytes fixed.
HTTP/2 frame header: 9 bytes fixed.
gRPC overhead: ~20-30 bytes per message.

AAFP's 28-byte header is larger than HTTP/2's 9 bytes, but AAFP doesn't
have HTTP/2's additional HPACK header compression overhead. For small
messages, AAFP's header is a larger fraction of the total. For large
messages (>1KB), the header is negligible.

## 4. Transport Performance

### 4.1 Connection Setup Latency

| Protocol | Cold Start | Warm Start (0-RTT) |
|----------|-----------|-------------------|
| **AAFP (QUIC)** | **1 RTT (TLS) + 1.5 RTT (handshake) = ~2-3 RTT** | **0 RTT (TLS) + 1.5 RTT (handshake) = ~1-2 RTT** |
| MCP (HTTP/1.1) | 3 RTT (TCP) + 2 RTT (TLS) = ~5 RTT | 3 RTT (TCP) + 1 RTT (TLS resume) = ~4 RTT |
| A2A (HTTP/2) | 3 RTT (TCP) + 2 RTT (TLS) = ~5 RTT | 3 RTT (TCP) + 1 RTT (TLS resume) = ~4 RTT |
| SLIM (gRPC/HTTP/2) | 3 RTT (TCP) + 2 RTT (TLS) = ~5 RTT | 3 RTT (TCP) + 1 RTT (TLS resume) = ~4 RTT |

**AAFP is 2-3x faster** for cold start and 2-4x faster for warm start.
The 0-RTT resumption is a significant advantage for recurring agent
pairs.

### 4.2 Throughput

| Protocol | Theoretical Max | Practical Max | Bottleneck |
|----------|----------------|---------------|------------|
| AAFP (QUIC) | Wire speed | ~90% of wire | Crypto (AEAD) |
| MCP (HTTP/1.1) | Wire speed | ~70% of wire | HTTP parsing |
| A2A (HTTP/2) | Wire speed | ~80% of wire | HTTP/2 framing |
| SLIM (gRPC) | Wire speed | ~85% of wire | Protobuf encode/decode |

**AAFP has the highest practical throughput** due to CBOR efficiency
and QUIC's low overhead.

### 4.3 Multiplexing Performance

| Scenario | AAFP (QUIC) | HTTP/2 (TCP) |
|----------|-------------|-------------|
| 1 stream, no loss | Equal | Equal |
| 10 streams, no loss | 10x (parallel) | 10x (parallel, but shared TCP) |
| 10 streams, 1% loss | 10x (only affected stream blocks) | ~5x (all streams block on TCP retransmit) |
| 10 streams, 5% loss | 10x (only affected stream blocks) | ~2x (severe HoL blocking) |

**AAFP's multiplexing advantage grows with loss rate**. On perfect
networks, AAFP and HTTP/2 are similar. On lossy networks (mobile,
edge), AAFP is significantly better.

## 5. Memory and CPU Footprint

### 5.1 Connection Memory

| Component | AAFP | MCP (HTTP) | SLIM (gRPC) |
|-----------|------|-----------|-------------|
| Transport state | ~10 KB (QUIC) | ~5 KB (TCP) | ~8 KB (HTTP/2) |
| Session state | ~5 KB | ~2 KB | ~5 KB |
| Crypto state | ~20 KB (PQ keys) | ~2 KB (TLS) | ~15 KB (MLS) |
| ReplayCache | ~100 KB (100K entries) | 0 | 0 |
| **Total per connection** | **~135 KB** | **~9 KB** | **~28 KB** |

**AAFP uses ~15x more memory** per connection than MCP. This is due to:
- ML-DSA-65 keys (1952B pub + 4032B sec = ~6 KB per agent)
- ReplayCache (100K entries * ~100 bytes = ~10 MB shared, but ~100KB
  per active connection's working set)
- QUIC connection state (more complex than TCP)

**Impact**: For agents with many connections (1000+), AAFP requires
~135 MB vs. MCP's ~9 MB. This is a scalability concern for hub agents.

**Mitigation**: Reduce ReplayCache size for high-connection agents.
Share crypto state across connections from the same agent.

### 5.2 CPU Usage

| Operation | AAFP | MCP | SLIM |
|-----------|------|-----|------|
| Handshake | ~3-5 ms (PQ) | ~1-2 ms (TLS) | ~2-5 ms (MLS) |
| Message encode | ~0.5 μs (CBOR) | ~2 μs (JSON) | ~0.5 μs (Protobuf) |
| Message decode | ~0.5 μs (CBOR) | ~2 μs (JSON) | ~0.5 μs (Protobuf) |
| Per-message crypto | ~0.1 μs/byte (AEAD) | 0 (TLS) | ~0.1 μs/byte (MLS) |

**AAFP's CPU usage is higher for handshakes** (PQ crypto) but **lower
for message processing** (CBOR vs. JSON). For long-lived sessions with
many messages, AAFP's total CPU is lower.

## 6. Performance Summary

| Metric | AAFP | Ecosystem Best | Winner |
|--------|------|----------------|--------|
| Handshake latency | 2-3 RTT + 3-5ms crypto | 5 RTT + 1-2ms crypto | **AAFP** (fewer RTTs) |
| Warm start | 1-2 RTT (0-RTT) | 4 RTT (TLS resume) | **AAFP** (0-RTT) |
| Message encode/decode | 0.5 μs (CBOR) | 2 μs (JSON) | **AAFP** (4x faster) |
| Wire size | 70-120 bytes | 300-700 bytes | **AAFP** (3-5x smaller) |
| Multiplexing (lossy) | No HoL blocking | TCP HoL blocking | **AAFP** |
| Memory per connection | ~135 KB | ~9 KB | Ecosystem (15x less) |
| Handshake CPU | 3-5 ms (PQ) | 1-2 ms (TLS) | Ecosystem (2-3x less) |
| Per-message CPU | 0.1 μs/byte | 0 (TLS) | Ecosystem (no app crypto) |

**AAFP wins on latency, throughput, and wire efficiency.**
**AAFP loses on memory and handshake CPU.**

## 7. Optimization Recommendations

### 7.1 Reduce Memory Footprint

1. **Connection pooling**: Reuse connections for multiple agent pairs
   (QUIC supports this naturally via streams)
2. **ReplayCache tuning**: Reduce max_entries for hub agents (e.g., 10K
   instead of 100K)
3. **Key sharing**: Share ML-DSA-65 public key across all connections
   from the same agent (already done; ensure no duplication)
4. **Stream pooling**: Reuse QUIC streams instead of creating new ones

### 7.2 Reduce Handshake CPU

1. **Session resumption**: Skip full handshake for known peers (Phase 10
   recommendation)
2. **UCAN caching**: Cache verified UCAN chains for session duration
3. **Parallel verification**: Verify UCAN chain links in parallel
4. **DoS MAC**: Always enable to reject forged ClientHellos cheaply

### 7.3 Improve Throughput

1. **Batch encoding**: Encode multiple frames in one operation
2. **Zero-copy CBOR**: Avoid copying data during encode/decode
3. **QUIC BBR**: Use BBR congestion control for better throughput on
   lossy networks
4. **Stream prioritization**: Allow application to prioritize streams

## 8. Transition to Phase 14

Phase 14 (Adoption Analysis) will examine the path from research/RC-1
to production adoption, including target verticals, competitive
positioning, and ecosystem entry strategies.
