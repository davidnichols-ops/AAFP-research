# AAFP Performance Report

## Environment
- CPU: Apple M4
- OS: Darwin (macOS)
- Rust: 1.96.0 (ac68faa20 2026-05-25)
- Compiler profile: release (opt-level=3)
- Date: 2026-07-02

## Results

### Cryptography
| Operation | Time | Target | Status |
|-----------|------|--------|--------|
| ML-DSA-65 keygen | 133 µs | <50ms | PASS |
| ML-DSA-65 sign | 272 µs | <10ms | PASS |
| ML-DSA-65 verify | 76 µs | <15ms | PASS |
| PQ handshake (full) | 709 µs | — | — |
| AEAD encrypt (1KB) | 1.63 µs | — | — |
| AEAD decrypt (1KB) | 1.64 µs | — | — |

### Framing
| Operation | Payload | Time | Target | Status |
|-----------|---------|------|--------|--------|
| Encode | 64B | 28 ns | — | — |
| Encode | 1KB | 66 ns | <10µs | PASS |
| Encode | 64KB | 1.81 µs | <10µs | PASS |
| Decode | 64B | 15 ns | — | — |
| Decode | 1KB | 35 ns | <10µs | PASS |
| Decode | 64KB | 1.60 µs | <10µs | PASS |

### Session/Memory
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| sizeof(Session) | 168 bytes | <1MB | PASS |
| Session creation | 30 ns | — | — |
| 1000 sessions creation | 19 µs | — | — |

## Methodology
All benchmarks use Criterion 0.5.1 with:
- Warmup: 1 second
- Measurement: 3 seconds
- Sample size: 10

Each benchmark measures wall-clock time for the operation. Crypto
benchmarks use ML-DSA-65 (FIPS 204) via the `aafp-crypto` crate.
Framing benchmarks use `aafp-messaging` frame encode/decode.

## Conclusion
All performance targets are met with significant margins:

- **ML-DSA-65 keygen** (133 µs) is 376x faster than the 50ms target.
- **ML-DSA-65 sign** (272 µs) is 37x faster than the 10ms target.
- **ML-DSA-65 verify** (76 µs) is 197x faster than the 15ms target.
- **Frame encode 1KB** (66 ns) is 151x faster than the 10µs target.
- **Frame decode 1KB** (35 ns) is 285x faster than the 10µs target.
- **Session memory** (168 bytes) is 6,149x smaller than the 1MB target.

The PQ handshake completes in under 1ms, which means the "time to first
authenticated message" target of <500ms is achievable (QUIC handshake
adds ~100-200ms on a LAN, plus the 0.7ms AAFP handshake).

The Apple M4's hardware acceleration for AES (used in AEAD) and efficient
memory management contribute to the excellent results. Performance on
other architectures may vary but the targets have large margins.
