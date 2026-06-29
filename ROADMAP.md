# AAFP Roadmap

**Baseline:** `v0.1-mvp-freeze`
**Full assessment:** [`docs/status/PHASE2_STATUS_REPORT.md`](docs/status/PHASE2_STATUS_REPORT.md)

This roadmap orders work by **architectural value** (highest first), not feature
count. Each item states its objective, rationale, complexity, dependencies,
protocol impact, and breaking status.

The guiding constraints:
- Prefer stable abstractions over new features.
- Treat interoperability as more important than convenience.
- Distinguish protocol requirements from implementation choices.
- Preserve backward compatibility whenever possible.
- Favor RFC-driven development over implementation-driven design.

---

## Phase 2 — From functional MVP to stable, implementation-independent protocol

### Must Complete Before Protocol Freeze

These are prerequisites for the protocol specification being considered frozen.
Without them, the protocol cannot be independently implemented from the RFCs
alone.

| # | Item | Complexity | Breaking | Protocol impact |
|---|------|-----------|----------|-----------------|
| P0-1 | Migrate `pqcrypto-mldsa` to a maintained ML-DSA-65 implementation | Medium | Non-breaking | None (internal) |
| P0-2 | Implement handshake state machine over QUIC | High | Non-breaking | Implements RFC-0002 §5 |
| P0-3 | Enforce identity verification on connections | Medium | Breaking (SDK) | Implements RFC-0003 §3.6 |
| P0-4 | Consolidate duplicate implementations | Medium | Breaking (internal APIs) | None (internal) |
| P0-5 | Set ALPN to `aafp/1` in TLS | Low | Non-breaking | Implements RFC-0006 §2.3 |
| P0-6 | Implement ERROR frame transmission | Low-Medium | Non-breaking | Implements RFC-0005 §4 |
| P0-7 | Implement CLOSE frame for graceful termination | Low | Non-breaking | Implements RFC-0002 §4.5 |

**P0-1 — Migrate pqcrypto-mldsa.** `pqcrypto-mldsa`/`pqcrypto-traits`/
`pqcrypto-internals` are unmaintained (RUSTSEC-2026-0162/0163/0166, archived
repo). Replace with `aws-lc-rs` ML-DSA or the `fips204` crate. Verify
byte-identical signature output. *Why now:* unmaintained crypto is a security
risk and a release blocker; every other item depends on a trustworthy crypto
foundation.

**P0-2 — Handshake state machine.** Wire ClientHello → ServerHello →
ClientFinished into the QUIC transport: extract TLS channel binding from
rustls, drive the state machine on stream 0, derive AEAD keys from the
transcript, apply AEAD to application streams. *Why now:* without this there is
no authentication, no session keys, and no identity verification — the
difference between a spec and a working protocol.

**P0-3 — Identity verification.** Verify peer `AgentId` from the handshake, not
from the remote address. Reject invalid signatures, mismatched AgentIds, or
expired records. *Why now:* address-based identity is a security vulnerability;
any peer can claim any AgentId today.

**P0-4 — Consolidate duplicates.** Five concepts have duplicate implementations
(AgentId, AgentRecord, RPC, Handshake, DHT). Keep only the RFC-compliant version
of each; remove `agent_record.rs`, `rpc.rs`, `handshake.rs`,
`capability_dht.rs`; align the `AgentId` type. *Why now:* building new features
on duplicates compounds the debt; the SDK currently uses non-RFC-compliant code.

**P0-5 — ALPN.** Configure rustls to offer and require `aafp/1` ALPN; reject
non-matching connections. *Why now:* low effort, high security value; first
line of defense against version confusion.

**P0-6 — ERROR frames.** Send ERROR frames in response to protocol violations;
close connections on fatal errors. *Why now:* without error frames, violations
cause undefined behavior.

**P0-7 — CLOSE frames.** Send CLOSE before closing the QUIC connection; process
incoming CLOSE. *Why now:* without graceful close, peers can't distinguish
intentional termination from network failure.

### Should Complete Before Public Release

| # | Item | Complexity | Breaking | Protocol impact |
|---|------|-----------|----------|-----------------|
| P1-1 | PING/PONG keep-alive | Low | Non-breaking | Implements RFC-0002 §4.7-4.8 |
| P1-2 | Discovery announce/lookup over QUIC | Medium | Non-breaking | Implements RFC-0004 §3 |
| P1-3 | CI pipeline (GitHub Actions) | Low | Non-breaking | None |
| P1-4 | ML-DSA-65 in Go implementation | Medium | Non-breaking | None (Go gap) |
| P1-5 | Validate performance targets | Medium | Non-breaking | None |
| P1-6 | Fix compiler warnings and dead code | Low | Non-breaking | None |
| P1-7 | Rustdoc documentation | Medium | Non-breaking | None |
| P1-8 | Basic relay protocol (circuit relay v2) | High | Non-breaking | Extends protocol (new RFC needed) |

**P1-1 — Keep-alive.** Periodic PING on idle connections, PONG response, timeout
on missed PONG. *Why before release:* without keep-alive, idle connections die
silently when NAT mappings expire.

**P1-2 — Discovery RPC over QUIC.** Send Announce/Lookup as RPC over QUIC
streams; process incoming requests server-side. *Why before release:* discovery
is a core feature but currently has no network protocol.

**P1-3 — CI.** GitHub Actions: `cargo test`, `cargo clippy`, `cargo audit`,
`go test`, on every push and PR. *Why before release:* manual testing doesn't
scale; CI prevents regressions during Phase 2 work.

**P1-4 — Go ML-DSA-65.** Implement signature generation/verification in Go; add
cross-signature verification tests (Rust signs → Go verifies and vice versa).
*Why before release:* cross-signature verification is a release criterion
(currently NOT MET).

**P1-5 — Performance validation.** Run benchmarks against
`PERFORMANCE_CRITERIA.md` targets: time to first authenticated message,
throughput, memory per session, concurrent sessions. *Why before release:*
performance validation is a release criterion (currently NOT MET at the network
level).

**P1-6 — Warnings.** Run `cargo fix`; address remaining warnings; remove dead
code. *Why before release:* ~30 warnings indicate dead code and silently dropped
`Result` values that may hide bugs.

**P1-7 — Rustdoc.** Document all public APIs; generate and publish docs. *Why
before release:* without docs, third parties can't use the SDK.

**P1-8 — Relay.** Circuit relay v2 for NAT traversal: reservation request,
relayed stream forwarding, capacity management. *Why before release:* without
relay, agents behind NAT cannot communicate. Requires an RFC for the relay
protocol specification.

### Long-Term Extensions (v1.1+)

Valuable but not needed for a stable v1.0. Each should be driven by an RFC
before implementation.

1. **0-RTT session resumption** (HQRT-style PQ 0-RTT) — performance optimization
2. **Distributed Kademlia DHT** — replacing in-memory DHT for scale
3. **Gossipsub** for PubSub and liveness propagation
4. **Hierarchical regional clustering** — inter-cluster super-peer DHT
5. **UCAN authorization enforcement** — checking tokens on incoming requests
6. **Connection migration** — QUIC CID-based
7. **Semantic vector index** for capability matching
8. **Reputation system** (EigenTrust-style)
9. **io_uring connection management** (Linux, for 100K+ connections)
10. **MCP transport binding** — AAFP as an MCP transport
11. **Onion routing** — privacy layer
12. **Autonomous contracting protocol**

### Explicit Non-Goals (v1.0)

These are out of scope and should not be pursued.

1. **Replacing QUIC.** QUIC via `quinn` is the transport.
2. **libp2p compatibility.** AAFP is a separate protocol; no bridge layer.
3. **X.509 certificate infrastructure.** TOFU with self-signed certs +
   application-layer ML-DSA-65 identity is the trust model.
4. **Blockchain integration.** No on-chain identity, tokens, or smart contracts.
5. **Centralized registry.** Discovery is P2P.
6. **Human-friendly naming.** AgentIds are 32-byte hashes.
7. **WireGuard compatibility.** Different protocol, different goals.
8. **Custom crypto primitives.** NIST-standardized PQ algorithms only.
9. **Mobile platform support** (v1.0). Desktop/server first.
10. **Browser/WASM support** (v1.0). Native binaries first.

---

## Release Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Two independent implementations | MET |
| 2 | Bidirectional wire interop | MET |
| 3 | Cross-signature verification | NOT MET (Go lacks ML-DSA-65 → P1-4) |
| 4 | Published test vectors | MET |
| 5 | Published golden traces | MET |
| 6 | No unresolved ambiguities | MET |
| 7 | No security-critical issues | NOT MET (pqcrypto unmaintained, no auth enforcement → P0-1, P0-3) |
| 8 | Conformance suite passing | MET |
| 9 | Performance targets | NOT MET (network perf untested → P1-5) |
| 10 | Supply-chain review | NOT MET (pqcrypto migration pending → P0-1) |

**7 of 10 met.** The P0 and P1 work above closes the remaining three.
