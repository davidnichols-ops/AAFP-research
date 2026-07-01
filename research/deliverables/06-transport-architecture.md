# Deliverable 6: Transport Architecture Analysis

```
Deliverable:    6 of 12
Title:          Transport Architecture Analysis
Status:         Complete
Date:           2026-07-01
Source:         Phase 9 (Transport Study) + Phase 13 (Performance)
```

## AAFP Transport Stack

```
Application data
    ↓
AAFP Frame (28-byte header + extensions + CBOR payload)
    ↓
AEAD encryption (post-handshake)
    ↓
QUIC stream (multiplexed, ordered, backpressured)
    ↓
QUIC connection (PQ TLS 1.3, X25519MLKEM768)
    ↓
UDP
```

## QUIC vs. HTTP Comparison

| Feature | QUIC (AAFP) | HTTP/2 (ecosystem) | HTTP/1.1 (ecosystem) |
|---------|-------------|--------------------|-----------------------|
| Multiplexing | Native streams | Frames over TCP | None |
| HoL blocking | None | TCP-level | Connection-level |
| 0-RTT | Yes | No | No |
| Migration | Yes | No | No |
| Congestion control | BBR/CUBIC | TCP | TCP |
| Encryption | Built-in (TLS 1.3) | External TLS | External TLS |

## Performance Summary

| Metric | AAFP (QUIC+CBOR) | Ecosystem (HTTP+JSON) | Advantage |
|--------|------------------|-----------------------|-----------|
| Cold start | 2-3 RTT | 5 RTT | 2x faster |
| Warm start | 1-2 RTT (0-RTT) | 4 RTT | 2-4x faster |
| Wire size (first msg) | ~120 bytes | ~400-700 bytes | 3-5x smaller |
| Wire size (subsequent) | ~70 bytes | ~300-600 bytes | 4-8x smaller |
| Encode/decode | ~0.5 μs (CBOR) | ~2 μs (JSON) | 4x faster |
| Multiplexing (lossy) | No HoL | TCP HoL | Significant |

## The UDP Firewall Problem

**Barrier**: QUIC uses UDP, which many enterprise firewalls block.

**Solution**: TCP fallback transport (`aafp-transport-tcp`):
- Same session layer, same PQ crypto, same CBOR framing
- Loses: multiplexing, 0-RTT, migration
- Gains: firewall compatibility
- Frame-level multiplexing over single TCP (like HTTP/2)

## Transport Selection

AgentRecord contains both endpoints:
```cbor
endpoints: [
    "quic://agent.example.com:443",
    "tcp://agent.example.com:443"
]
```
Client tries QUIC first, falls back to TCP.
