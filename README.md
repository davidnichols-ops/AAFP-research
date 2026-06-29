# AAFP

**AAFP** (Agent-to-Agent Framing Protocol) is a QUIC-native, post-quantum,
agent-to-agent networking protocol. It preserves the architectural abstractions
of libp2p while replacing its implementation with a simplified, AI-native
protocol stack.

- **Transport:** QUIC (via `quinn`) with hybrid post-quantum TLS 1.3
  (X25519MLKEM768)
- **Identity:** ML-DSA-65 (FIPS 204) signatures; `AgentId = SHA-256(public_key)`
- **Authorization:** UCAN capability chains
- **Discovery:** Capability-based DHT, regional grouping, bootstrap
- **Wire format:** CBOR (RFC 8949 deterministic encoding) over framed QUIC streams

This repository is the **protocol umbrella**: it owns the specification (RFCs),
architecture, cross-implementation documentation, and conformance artifacts.
Implementations live under `implementations/` as git submodules.

---

## Repository Layout

```
AAFP-research/
├── README.md                  This file
├── ROADMAP.md                 Phase 2 prioritized roadmap
├── RFCs/                      Protocol specification (canonical home)
│   ├── 0001-protocol-overview.md
│   ├── 0002-transport-framing.md
│   ├── 0003-identity-authentication.md
│   ├── 0004-discovery.md
│   ├── 0005-error-model.md
│   ├── 0006-versioning-compatibility.md
│   ├── RFC_CHANGELOG.md
│   ├── AMENDMENT_STATUS.md
│   ├── AMENDMENTS-0001.md
│   ├── AMENDMENTS-0002.md
│   └── REVIEW-0001 … REVIEW-0004.md   Architectural review records
├── architecture/              Research and architecture deliverables
│   ├── AAFP_Research_Report.md
│   ├── AAFP_Architecture_Deliverable.md
│   └── AAFP_Implementation_Prompt.md
├── docs/
│   └── status/
│       └── PHASE2_STATUS_REPORT.md   Objective status assessment & roadmap
├── implementations/
│   ├── rust/   (submodule → github.com/davidnichols-ops/aafp)
│   └── go/     (submodule → github.com/davidnichols-ops/aafp-go)
└── examples/                  Usage examples (placeholder)
```

### Repository responsibilities

| Repository | Owns |
|------------|------|
| **Umbrella (this repo)** | RFCs, architecture, roadmaps, cross-implementation docs, conformance criteria |
| **Rust (`implementations/rust`)** | Rust reference implementation, Rust CI, Rust releases |
| **Go (`implementations/go`)** | Go independent implementation, Go CI, Go-specific docs |

The protocol — not any single implementation — is the primary artifact. RFCs
define the protocol; implementations are references that prove the RFCs are
implementable and interoperable.

---

## Current Status

**Baseline tag:** `v0.1-mvp-freeze` — frozen MVP snapshot before architectural
evolution begins.

The full objective status assessment is in
[`docs/status/PHASE2_STATUS_REPORT.md`](docs/status/PHASE2_STATUS_REPORT.md).
Summary of readiness:

| Area | Rating |
|------|--------|
| CBOR encoding | Stable MVP |
| Frame format | Stable MVP |
| Error codes | Stable MVP |
| Identity (AgentId, AgentRecord) | Stable MVP |
| Identity (UCAN) | Functional Prototype |
| Cryptography (ML-DSA-65) | Functional Prototype (release blocker: unmaintained dep) |
| Cryptography (AEAD) | Stable MVP |
| Handshake | Functional Prototype (state machine not wired into transport) |
| Transport (QUIC) | Functional Prototype |
| Messaging (framing) | Stable MVP |
| Messaging (RPC) | Functional Prototype |
| Messaging (PubSub) | Not Started |
| Discovery (DHT) | Functional Prototype (in-memory only) |
| NAT traversal | Not Started (stubs) |
| SDK | Functional Prototype |
| CLI | Functional Prototype |
| Conformance testing | Stable MVP |
| Interoperability (wire-format) | Stable MVP |
| RFCs | Stable MVP (6 RFCs, Rev 5, all ambiguities resolved) |
| CI/CD | Not Started |

**Test suite (verified at freeze):** 461 Rust tests + 7 Go test packages, all
passing. 0 failures.

**Release criteria:** 7 of 10 met. Remaining: cross-signature verification
(Go lacks ML-DSA-65), security (unmaintained `pqcrypto-mldsa`), performance
validation (network-level benchmarks pending).

---

## RFCs

Six RFCs (Revision 5) define the protocol:

| RFC | Title |
|-----|-------|
| 0001 | Protocol Overview, Goals, and Layer Architecture |
| 0002 | Transport, Framing, Stream Multiplexing, and Wire Format |
| 0003 | Agent Identity, AgentRecord, Capability Descriptors, Authorization, and Session Lifecycle |
| 0004 | Discovery: Identity, Capability, Service, and Resource |
| 0005 | Protocol Error Codes, Error Frames, and Error Handling |
| 0006 | Versioning and Compatibility |

The RFCs were validated by an independent Go implementation written strictly
from the specifications, proving they are unambiguous enough to implement from
without reference to the Rust source.

---

## Implementations

### Rust reference (`implementations/rust`)

13-crate Cargo workspace covering the full protocol stack: CBOR, crypto,
identity, core traits, QUIC transport, discovery, NAT (stubs), messaging, SDK,
CLI, conformance tests, benchmarks, and integration tests.

```bash
cd implementations/rust
cargo test --workspace        # 461 tests
cargo run --bin aafp -- init  # generate an agent identity
```

### Go independent (`implementations/go`)

Wire-format interoperability validation harness (7 packages: cbor, errors,
frame, frameext, handshake, identity, plus test packages). Written strictly
from the RFCs to validate specification clarity and canonical encoding.

```bash
cd implementations/go
go test ./...                 # all packages pass
```

---

## Development Phase

The MVP is frozen at `v0.1-mvp-freeze`. The next phase is defined in
[`ROADMAP.md`](ROADMAP.md) and detailed in
[`docs/status/PHASE2_STATUS_REPORT.md`](docs/status/PHASE2_STATUS_REPORT.md).

Protocol development is RFC-driven: specification changes precede implementation
changes. Interoperability is prioritized over convenience. Backward
compatibility is preserved whenever possible.

---

## License

MIT OR Apache-2.0 (per workspace `Cargo.toml`).
