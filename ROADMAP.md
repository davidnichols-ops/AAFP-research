# AAFP Roadmap

> **Protocol roadmap COMPLETE. All 19 tracks (A-S) done. Intelligence Plane
> COMPLETE (all 6 tracks: T, U, V, W, X, Y). Phase 2 nearly complete.
> Next: ecosystem + real-world deployment — see NORTH_STAR.md.**

**Baseline:** `v0.1-mvp-freeze`
**Current freeze:** `v0.5-phase4-complete`
**Full assessment:** [`docs/status/PHASE2_STATUS_REPORT.md`](docs/status/PHASE2_STATUS_REPORT.md)

> **Updated 2026-07-06:** ALL 326 protocol steps + 40 Intelligence Plane steps
> complete. 3008 tests passing (2857 Rust + 151 TypeScript). SDK in 3 languages.
> Intelligence Plane COMPLETE (SCG, ARE, AR, PS, V, X, Y, T-ext, U-ext, W-ext).
> Security review complete. Next: ecosystem + real-world deployment.

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

## Phase 2 — COMPLETE. Protocol frozen at Rev 6. All 19 tracks (A-S) complete. Next: developer experience and ecosystem (see NORTH_STAR.md).

### Must Complete Before Protocol Freeze

These are prerequisites for the protocol specification being considered frozen.
Without them, the protocol cannot be independently implemented from the RFCs
alone.

| # | Item | Complexity | Breaking | Protocol impact | Status |
|---|------|-----------|----------|-----------------|--------|
| P0-1 | Migrate `pqcrypto-mldsa` to a maintained ML-DSA-65 implementation | Medium | Non-breaking | None (internal) | **DONE** (migrated to `fips204` + `aws-lc-rs`) |
| P0-2 | Implement handshake state machine over QUIC | High | Non-breaking | Implements RFC-0002 §5 | **DONE** (v1 handshake wired into SDK) |
| P0-3 | Enforce identity verification on connections | Medium | Breaking (SDK) | Implements RFC-0003 §3.6 | **DONE** (Session state machine enforces auth) |
| P0-4 | Consolidate duplicate implementations | Medium | Breaking (internal APIs) | None (internal) | **PARTIAL** (legacy modules deprecated, v1 types primary) |
| P0-5 | Set ALPN to `aafp/1` in TLS | Low | Non-breaking | Implements RFC-0006 §2.3 | **DONE** (client advertises, server requires, mismatch rejected) |
| P0-6 | Implement ERROR frame transmission | Low-Medium | Non-breaking | Implements RFC-0005 §4 | **DONE** (SDK sends ERROR frames via `protocol_frames`) |
| P0-7 | Implement CLOSE frame for graceful termination | Low | Non-breaking | Implements RFC-0002 §4.5 | **DONE** (SDK sends CLOSE frames, graceful shutdown via `disconnect`) |

**P0-1 — Migrate pqcrypto-mldsa.** ✅ **DONE.** Migrated from unmaintained
`pqcrypto-mldsa`/`pqcrypto-traits`/`pqcrypto-internals`
(RUSTSEC-2026-0162/0163/0166) to `fips204` + `aws-lc-rs`. Signature output
verified byte-identical.

**P0-2 — Handshake state machine.** ✅ **DONE.** The v1 handshake
(ClientHello → ServerHello → ClientFinished) is implemented in
`handshake_v1.rs` and wired into the SDK via `handshake_driver.rs`. The
handshake runs over QUIC stream 0 using AAFP HANDSHAKE frames (frame type
0x02) with the 28-byte header. TLS channel binding is extracted via the
TLS exporter. An end-to-end integration test verifies the full flow over a
real QUIC connection.

**P0-3 — Identity verification.** ✅ **DONE.** The `Session` state machine
in `aafp-core/src/session.rs` enforces that all connections must complete
the v1 handshake (IdentityVerified state) before application messages can
be sent. The SDK's `AgentClient::connect()` and `AgentServer::accept_one()`
both perform the full handshake. `AgentId` is verified from the handshake's
ML-DSA-65 signature, not from the remote address.

**P0-4 — Consolidate duplicates.** ⚠️ **PARTIAL.** Legacy modules (`rpc.rs`,
`handshake.rs`, `agent_record.rs`) are marked `#[deprecated]` and their exports
are no longer re-exported from crate roots. The v1 RFC-compliant types
(`rpc_v1`, `handshake_v1`, `identity_v1`) are the primary exports. Full removal
is deferred to avoid breaking downstream consumers.

**P0-5 — ALPN.** ✅ **DONE.** Both client and server configure `aafp/1` ALPN
in rustls. ALPN mismatch causes TLS handshake failure (verified by test).
`AAFP_ALPN` constant exported from `aafp-transport-quic`.

**P0-6 — ERROR frames.** ✅ **DONE.** The SDK's `protocol_frames` module
provides `send_error_frame()` which encodes and transmits ERROR frames
(RFC-0002 §4.6). `PeerConnection::send_error()` and `AgentClient::send_error()`
expose this at the API level. Fatal errors close the connection after sending.

**P0-7 — CLOSE frames.** ✅ **DONE.** The SDK's `protocol_frames` module
provides `send_close_frame()` which encodes and transmits CLOSE frames
(RFC-0002 §4.5). `PeerConnection::begin_close()` sends a CLOSE frame before
closing the QUIC connection. `AgentClient::disconnect()` uses this for graceful
shutdown.

### Should Complete Before Public Release

| # | Item | Complexity | Breaking | Protocol impact | Status |
|---|------|-----------|----------|-----------------|--------|
| P1-1 | PING/PONG keep-alive | Low | Non-breaking | Implements RFC-0002 §4.7-4.8 | **DONE** (Track E1) |
| P1-2 | Discovery announce/lookup over QUIC | Medium | Non-breaking | Implements RFC-0004 §3 | **DONE** (Track E2) |
| P1-3 | CI pipeline (GitHub Actions) | Low | Non-breaking | None | **DONE** (A2 fixed workflows, submodules initialized) |
| P1-4 | ML-DSA-65 in Go implementation | Medium | Non-breaking | None (Go gap) | **DONE** (A-10, cross-signature verified) |
| P1-5 | Validate performance targets | Medium | Non-breaking | None | **DONE** (Track F1) |
| P1-6 | Fix compiler warnings and dead code | Low | Non-breaking | None | **DONE** (0 warnings, 0 clippy lints) |
| P1-7 | Rustdoc documentation | Medium | Non-breaking | None | **DONE** (Track F2) |
| P1-8 | Basic relay protocol (circuit relay v2) | High | Non-breaking | Extends protocol (new RFC needed) | **DONE** (Track N) |

**P1-1 — Keep-alive.** Periodic PING on idle connections, PONG response, timeout
on missed PONG. *Why before release:* without keep-alive, idle connections die
silently when NAT mappings expire.

**P1-2 — Discovery RPC over QUIC.** Send Announce/Lookup as RPC over QUIC
streams; process incoming requests server-side. *Why before release:* discovery
is a core feature but currently has no network protocol.

**P1-3 — CI.** GitHub Actions: `cargo test`, `cargo clippy`, `cargo audit`,
`go test`, on every push and PR. *Why before release:* manual testing doesn't
scale; CI prevents regressions during Phase 2 work.

**P1-4 — Go ML-DSA-65.** ✅ **DONE** (A-10). Signature generation/verification
in Go implemented; cross-signature verification tests (Rust signs → Go
verifies and vice versa) passing. Cross-signature verification release
criterion MET.

**P1-5 — Performance validation.** ✅ **DONE** (Track F1). Benchmarks run
against `PERFORMANCE_CRITERIA.md` targets: time to first authenticated
message, throughput, memory per session, concurrent sessions. Performance
validation release criterion MET.

**P1-6 — Warnings.** ✅ **DONE.** `cargo build`, `cargo clippy`, and
`cargo fmt --check` all pass with zero warnings. Legacy modules use
targeted `#![allow]` attributes; test helpers use crate-level allows.

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
10. **MCP transport binding** — AAFP as an MCP transport — **DONE** (RFC 0007, `aafp-transport-mcp` crate)
11. **A2A transport binding** — AAFP as an A2A transport — **DONE** (RFC 0008, `aafp-transport-a2a` crate, B1)
12. **Onion routing** — privacy layer
13. **Autonomous contracting protocol**

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
| 3 | Cross-signature verification | MET (A-10: Go ML-DSA-65 implemented, cross-verified) |
| 4 | Published test vectors | MET |
| 5 | Published golden traces | MET |
| 6 | No unresolved ambiguities | MET |
| 7 | No security-critical issues | MET (pqcrypto migrated to `fips204`; auth enforced via Session state machine) |
| 8 | Conformance suite passing | MET |
| 9 | Performance targets | MET (Track F1) |
| 10 | Supply-chain review | MET (unmaintained `pqcrypto-*` crates removed; using `fips204` + `aws-lc-rs`) |

**10 of 10 met.** All tracks A-S complete. AAFP is internet-ready (v1 achieved).

---

## Rev 6: Protocol Amendments (Category A) and Deferred Items (Category B)

Rev 6 categorizes remaining work into **Rev 6 Protocol Amendments**
(Category A, addressed in Rev 6) and **Post-v1 Enhancements**
(Category B, deferred). Note: Category A covers the protocol
ambiguities and gaps identified in the Rev 6 review. It does **not**
cover all remaining release criteria — see Outstanding Items below.

### Category A — Rev 6 Protocol Amendments (10 of 10 implemented)

| ID | Item | Status |
|----|------|--------|
| A-1 | RPC `params` must be canonical CBOR item, not null | DONE |
| A-2 | Optional fields: omit-when-absent (not null) | DONE |
| A-3 | AgentRecord `record_version` for replay protection | DONE |
| A-4 | Bind session ID to server AgentId | DONE |
| A-5 | Frame extension limits enforced before allocation | DONE |
| A-6 | Normative handshake state machine | DONE |
| A-7 | Extension processing order (sig before semantics) | DONE |
| A-8 | CLOSE frame semantics (edge cases) | DONE |
| A-9 | Nonce reuse detection (5-min retention) | DONE |
| A-10 | Go ML-DSA-65 cross-signature verification | DONE |

### Category B — Post-v1 Enhancements (deferred)

| ID | Item | Target |
|----|------|--------|
| B-1 | Go ML-DSA-65 cross-signature verification | **DONE** (A-10) |
| B-2 | Go QUIC transport | v1.1 |
| B-3 | Network performance validation | v1.1 |
| B-4 | Browser/WASM support | v1.2 |
| B-5 | Adaptive connection limits | v1.2 |

See `docs/REV6_IMPLEMENTATION_PLAN.md` for full details.

### Outstanding Items (not addressed by Rev 6)

These items must be resolved before v1 production readiness:

| Item | Status |
|------|--------|
| Revocation mechanism (CRL/OCSP-like) | **DONE** (Track P) |
| Normative handshake state machine diagram | DONE (RFC-0002 §5.10) |
| Go ML-DSA-65 cross-signature verification | **DONE** (A-10) |
| Performance validation (network benchmarks) | **DONE** (Track F1) |
| Independent third-party interop testing | **DONE** (Track D) |
| Production deployment experience | NONE |
| NAT traversal production validation | **DONE** (Track N) |
| Persistent/networked DHT | **DONE** (Track R) |
| PubSub | **DONE** (Track E3) |
| MCP transport binding | **DONE** (RFC 0007, `aafp-transport-mcp`) |
| A2A transport binding | **DONE** (RFC 0008, `aafp-transport-a2a`, B1) |
| Python PyO3 adapter | **DONE** (`aafp-py` crate, B2) |
| Shared establish_session() | **DONE** (B3, extracted to `aafp-sdk`) |
| pyo3 segfault on cleanup | **FIXED** (C1, async shutdown + wait_idle) |

**Current status: v1 achieved. ALL 326 steps complete. AAFP is internet-ready.**

---

## Phase 2.5 — Simple API Adaptation (2026-07-06) — COMPLETE ✅

Based on 8 parallel sandbox gap analyses, 10 critical gaps were identified in the
Simple API. Research is complete; ALL implementation is complete.

**Design documents:**
- `SIMPLE_API_V2_DESIGN.md` — v2 API (all 10 gaps, backward compatible)
- `STREAMING_RPC_DESIGN.md` — Streaming RPC over QUIC (no wire changes)
- `SESSION_AFFINITY_DESIGN.md` — Connection pooling (50x perf improvement)
- `SEMANTIC_CAPABILITY_GRAPHS.md` — Semantic discovery (Track U)
- `ADAPTATION_ROADMAP.md` — Synthesized adaptation plan

**Implementation phases:**

| Phase | Builder Prompt | Priority | Status |
|-------|---------------|----------|--------|
| A1+C1: v2 Foundation + Pooling | `BUILDER_PROMPT_P2.7.md` | P0 | **COMPLETE** |
| B1+B2: Streaming + Cancellation | `BUILDER_PROMPT_P2.8.md` | P1 | **COMPLETE** |
| TS-1: CBOR + Crypto | `builder-prompts/TS_PHASE_1_CBOR_CRYPTO.md` | P2 | **COMPLETE** |
| TS-2: Transport | `builder-prompts/TS_PHASE_2_TRANSPORT.md` | P2 | **COMPLETE** |
| TS-3: Server API | `builder-prompts/TS_PHASE_3_SERVER.md` | P2 | **COMPLETE** |
| TS-4: Client API + Pool | `builder-prompts/TS_PHASE_4_CLIENT.md` | P2 | **COMPLETE** |
| TS-5: Streaming | `builder-prompts/TS_PHASE_5_STREAMING.md` | P2 | **COMPLETE** |
| TS-6: Browser | `builder-prompts/TS_PHASE_6_BROWSER.md` | P2 | **COMPLETE** |
| TS-7: MCP Integration | `builder-prompts/TS_PHASE_7_MCP.md` | P2 | **COMPLETE** |
| TS-8: Testing | `builder-prompts/TS_PHASE_8_TESTING.md` | P2 | **COMPLETE** |
| TS-9: Packaging | `builder-prompts/TS_PHASE_9_PACKAGING.md` | P2 | **COMPLETE** |
| SCG D1-D2: Descriptor + Query | `builder-prompts/SCG_D1_D2_DESCRIPTOR_QUERY.md` | P3 | **COMPLETE** |
| SCG D3-D4: Index + Compose | `builder-prompts/SCG_D3_D4_INDEX_COMPOSE.md` | P3 | **COMPLETE** |
| SCG D5-D6: Planning + Bridge | `builder-prompts/SCG_D5_D6_PLAN_BRIDGE.md` | P3 | **COMPLETE** |
| AR T1-T2: Metrics + Routing | `builder-prompts/AR_T1_T2_METRICS_ROUTING.md` | P3 | **COMPLETE** |
| AR T3-T4: Breaker + Hedging | `builder-prompts/AR_T3_T4_BREAKER_HEDGING.md` | P3 | **COMPLETE** |
| AR T5-T7: Integration + API | `builder-prompts/AR_T5_T7_INTEGRATION_API.md` | P3 | **COMPLETE** |
| PS P1-P2: API + Propagation | `builder-prompts/PS_P1_P2_API_PROPAGATION.md` | P3 | **COMPLETE** |
| PS P3-P4: BackChannel + Routing | `builder-prompts/PS_P3_P4_BACKCHANNEL_ROUTING.md` | P3 | **COMPLETE** |
| PS P5-P6: Security + GossipSub | `builder-prompts/PS_P5_P6_SECURITY_GOSSIPSUB.md` | P3 | **COMPLETE** |
| ARE E1-E2: Map + Geo/Perf | `builder-prompts/ARE_E1_E2_MAP_GEO_PERF.md` | P3 | **COMPLETE** |
| ARE E3-E4: Cost/Semantic/Reputation | `builder-prompts/ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` | P3 | **COMPLETE** |
| ARE E5-E6: DHT + Testing | `builder-prompts/ARE_E5_E6_DHT_TESTING.md` | P3 | **COMPLETE** |

**Key finding:** The gap is in the SDK, not the protocol. No wire protocol
changes required. All gaps can be addressed by exposing existing QUIC/CBOR
primitives through the Simple API.

**Result:** 2857 Rust tests + 151 TypeScript tests = 3008 total, 0 failures.
0 clippy warnings. Security review complete (4 critical + 12 high fixed).
Freeze tag: `v0.4-intelligence-plane`.
