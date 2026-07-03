# Track J: QUIC Transport Tuning

**Priority:** HIGH
**Duration:** Q2-Q3 (4-6 weeks)
**Blocked by:** I (Connection Lifecycle — needs pooling for realistic benchmarks)
**Blocks:** nothing

---

## Problem

The current QUIC configuration uses quinn's defaults, which are tuned for general-purpose use (web traffic, file transfer). For ultra-low-latency agent-to-agent RPC, we need to tune:

1. **Congestion control:** Default is cubic (good for bulk transfer, bad for low-latency RPC)
2. **Initial RTT:** Default is 333ms (way too high for LAN/localhost)
3. **Stream buffering:** Default buffering adds latency for small messages
4. **Packet size:** Default MTU is 1200 (safe but suboptimal for jumbo frames)
5. **ACK frequency:** Default ACKs every packet (can be batched for throughput)

---

## Steps

### J1: Switch to BBR congestion control
- Add `quinn-proto` feature for BBR (or implement custom `CongestionController`)
- BBR is better for low-latency RPC: it estimates bandwidth and RTT, doesn't rely on packet loss
- Create `crates/aafp-transport-quic/src/congestion.rs` with BBR config
- Configure `ServerConfig::congestion_controller_factory()` and `ClientConfig::congestion_controller_factory()`
- **VERIFY:** BBR benchmark shows lower latency than cubic under simulated packet loss

### J2: Tune initial RTT and timeouts
- Set `TransportConfig::initial_rtt()` to 10ms (realistic for LAN/localhost, not 333ms)
- Set `TransportConfig::max_idle_timeout()` to 30s (from default 30s — verify)
- Set `TransportConfig::keep_alive_interval()` to 10s (from 30s — faster detection)
- Set `TransportConfig::crypto_buffer_size()` to 8192 (from default — tuned for small RPC messages)
- **VERIFY:** Connection establishment is faster (initial RTT affects retransmission timer)

### J3: Disable Nagle's algorithm equivalent
- QUIC doesn't have Nagle's, but quinn has `TransportConfig::stream_recv_buffer_max`
- Set small initial window: `TransportConfig::stream_initial_max_data()` to 1MB (from default 100KB)
- This allows the first message to be sent immediately without waiting for window updates
- **VERIFY:** Small message latency is reduced (no window-related delays)

### J4: Tune ACK frequency
- Set `TransportConfig::max_ack_delay()` to 5ms (from default 25ms)
- This makes ACKs more frequent, reducing retransmission latency
- Set `TransportConfig::ack_delay_exponent()` to 3 (from default 3 — verify)
- **VERIFY:** ACK delay benchmark shows faster feedback loop

### J5: GSO (Generic Segmentation Offload) support
- Enable `quinn::Endpoint::enable_gso()` on platforms that support it (Linux, macOS)
- GSO allows the kernel to segment a large UDP write into multiple packets, reducing syscall overhead
- For large messages (>1KB), this reduces write syscalls by 10-100x
- **VERIFY:** Large message throughput improves with GSO enabled

### J6: Multi-path QUIC (experimental)
- Research `quinn-multipath` or implement multi-path support
- Multi-path allows a connection to use multiple network paths simultaneously (WiFi + cellular)
- Benefits: higher throughput, seamless failover, lower latency via path selection
- If quinn doesn't support multi-path natively, evaluate `quiche` or `s2n-quic` as alternatives
- **VERIFY:** Multi-path benchmark shows aggregate throughput > single-path

### J7: End-to-end QUIC tuning benchmark
- Benchmark scenarios:
  1. Localhost: round-trip ping (target: <50µs)
  2. LAN (1ms RTT): round-trip ping (target: <3ms)
  3. Simulated WAN (50ms RTT via `tc netem`): round-trip ping (target: <55ms)
  4. Packet loss (1%): throughput (target: >90% of no-loss throughput)
  5. Concurrent connections (1000): memory usage (target: <50MB)
- Write results to `test-results/performance/quic-tuning.json`
- Update `PERFORMANCE_REPORT.md`
- **VERIFY:** Localhost round-trip <50µs (from 250µs baseline after G+H)

---

## Expected Outcomes

| Metric | Before (post G+H) | After | Method |
|--------|-------------------|-------|--------|
| Localhost round-trip | ~150µs | <50µs | BBR + tuned RTT + small buffers |
| LAN round-trip (1ms RTT) | ~3ms | <2ms | BBR + ACK tuning |
| Large message throughput | ~1 Gbps | >5 Gbps | GSO |
| Connection memory (1000 conns) | ~50MB | <30MB | Tuned buffers |

---

## Risks & Mitigations

1. **BBR may not be available in quinn:** Quinn's BBR support may be experimental. **Mitigation:** Check quinn 0.11 features. If unavailable, implement a custom `CongestionController` or use `quinn-proto` directly.

2. **GSO not available on all platforms:** macOS has limited GSO support. **Mitigation:** Feature-detect at runtime, fall back to regular writes.

3. **Multi-path QUIC complexity:** May require switching QUIC implementations. **Mitigation:** This is the last step (J6). If it proves too complex, skip it and document why. The other tuning steps (J1-J5) provide the majority of the benefit.

4. **Tuned parameters may hurt bulk transfer:** Small buffers help RPC but hurt file transfer. **Mitigation:** Make all parameters configurable via `QuicConfig`. Provide presets: `low_latency()` and `bulk_transfer()`.
