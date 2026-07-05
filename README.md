# AAFP

**AAFP** (Agent-to-Agent Framing Protocol) is the decentralized execution
substrate for autonomous software. It is not just a transport protocol — it
is the foundation of an agent operating system where agents discover, trust,
schedule, migrate, and coordinate work without centralized orchestration.

- **Transport:** QUIC (via `quinn`) with hybrid post-quantum TLS 1.3
  (X25519MLKEM768)
- **Identity:** ML-DSA-65 (FIPS 204) signatures; `AgentId = SHA-256(public_key)`
- **Authorization:** UCAN capability chains
- **Discovery:** Kademlia DHT with capability-based routing, bootstrap, replication
- **NAT traversal:** Relay forwarding, AutoNAT dial-back, DCuTR hole punching
- **Wire format:** CBOR (RFC 8949 deterministic encoding) over framed QUIC streams

The competitor is not HTTP. The competitor is cloud silos — OpenAI APIs,
Anthropic APIs, proprietary agent buses. Those systems own the agent graph.
AAFP owns the **open graph**.

This repository is the **protocol umbrella**: it owns the specification (RFCs),
architecture, cross-implementation documentation, and conformance artifacts.
Implementations live under `implementations/` as git submodules.

---

## Current Status: v1 Internet-Ready — ACHIEVED

**All 326 steps complete across 19 tracks (A-S). 1597 tests, 0 failures.**

| Metric | Value |
|--------|-------|
| Tests | 1597 passing, 0 failures, 7 ignored |
| Crates | 17 Rust crates, ~75K lines |
| RFCs | 11 (0001-0011), frozen at Rev 6 |
| DHT scale | 500 nodes, 100% lookup success |
| Load test | 100 agents, 399K messages, 0% error |
| Stability | 4h continuous, 2.5% memory growth |
| Security | Fuzzed, adversarial tested, hardened |
| Deployment | Docker, K8s, systemd, ops runbook |

### What's complete

| Area | Tracks | Status |
|------|--------|--------|
| Protocol design | RFCs 0001-0011 | Frozen (Rev 6) |
| Post-quantum crypto | A, P | Production-grade (FIPS 204) |
| Transport (QUIC) | A, I, J | Tuned (BBR, connection pool, migration) |
| Identity/PKI | P | Complete (WoT, CA, rotation, revocation) |
| NAT traversal | N | Complete (relay, AutoNAT, DCuTR) |
| WAN testing | O | Complete (packet loss, BBR, migration) |
| Security audit | Q | Complete (fuzzing, DoS, timing, hardening) |
| DHT at scale | R | Complete (Kademlia, 500 nodes, churn, partition) |
| Load & ops | S | Complete (100 agents, Docker, K8s, metrics) |
| MCP/A2A bindings | B, D | Verified (Python interop, Go wire-format) |
| Performance | G-M | 6.0x cumulative improvement |

### What's next

- **Phase 2:** Developer experience — 3-line API, CLI, tutorials (1-2 weeks)
- **Phase 3:** Ecosystem — SDK in 3 languages, reference apps, plugins
- **Phase 4:** Adaptive routing — capability graphs, execution fabric, reputation

See [`NORTH_STAR.md`](NORTH_STAR.md) for strategic direction.
See [`STRATEGIC_VISION.md`](STRATEGIC_VISION.md) for the full vision.
See [`COMPLETION_SUMMARY.md`](COMPLETION_SUMMARY.md) for what was built.

---

## Repository Layout

```
AAFP-research/
├── README.md                  This file
├── NORTH_STAR.md              Strategic direction (read this first)
├── STRATEGIC_VISION.md        Full vision: agent operating system
├── COMPLETION_SUMMARY.md      What was built (326 steps, 19 tracks)
├── ROADMAP.md                 Protocol freeze roadmap (complete)
├── RFCs/                      Protocol specification (frozen, Rev 6)
│   ├── 0001-protocol-overview.md
│   ├── 0002-transport-framing.md
│   ├── 0003-identity-authentication.md
│   ├── 0004-discovery.md
│   ├── 0005-error-model.md
│   ├── 0006-versioning-compatibility.md
│   ├── 0007-mcp-transport-binding.md
│   ├── 0008-a2a-transport-binding.md
│   ├── 0009-… 0011-…          Extension RFCs
│   ├── AMENDMENTS-0001.md     Rev 6 amendments
│   ├── AMENDMENTS-0002.md
│   └── REVIEW-0001…0004.md    Architectural reviews
├── docs/
│   ├── DEPLOYMENT.md          Production deployment guide
│   ├── OPERATIONS.md          Operational runbook
│   ├── TROUBLESHOOTING.md     Common issues and solutions
│   ├── PRODUCTION_READINESS.md  Readiness assessment
│   ├── THREAT_MODEL.md        Security threat model
│   ├── WAN_TESTING.md         Two-machine test guide
│   └── NAT_TRAVERSAL_TESTING.md
├── implementations/
│   ├── rust/   (submodule → github.com/davidnichols-ops/aafp)
│   └── go/     (submodule → github.com/davidnichols-ops/aafp-go)
├── implementation-plans/      Track plans and status (326/326 complete)
├── Dockerfile                 Multi-stage container build
├── docker-compose.yml         3-agent test setup
├── deploy/                    systemd + Kubernetes manifests
└── examples/                  Usage examples
```

### Repository responsibilities

| Repository | Owns |
|------------|------|
| **Umbrella (this repo)** | RFCs, architecture, roadmaps, deployment, cross-implementation docs |
| **Rust (`implementations/rust`)** | Rust reference implementation (17 crates, 1597 tests) |
| **Go (`implementations/go`)** | Go wire-format interop validation (664 tests) |

The protocol — not any single implementation — is the primary artifact. RFCs
define the protocol; implementations are references that prove the RFCs are
implementable and interoperable.

---

## RFCs

Eleven RFCs (Revision 6) define the protocol:

| RFC | Title | Status |
|-----|-------|--------|
| 0001 | Protocol Overview, Goals, and Layer Architecture | Frozen |
| 0002 | Transport, Framing, Stream Multiplexing, and Wire Format | Frozen |
| 0003 | Agent Identity, AgentRecord, Capability Descriptors, Authorization | Frozen |
| 0004 | Discovery: Identity, Capability, Service, and Resource | Frozen |
| 0005 | Protocol Error Codes, Error Frames, and Error Handling | Frozen |
| 0006 | Versioning and Compatibility | Frozen |
| 0007 | AAFP Transport Binding for MCP | Implemented |
| 0008 | AAFP Transport Binding for A2A | Implemented |
| 0009-0011 | Extension RFCs (NAT, trust model) | Implemented |

The wire protocol is frozen. Future innovation happens in the layers above
transport (routing, scheduling, discovery semantics, reputation) — not in the
wire format. See `STRATEGIC_VISION.md` for the immutable boundary.

---

## Implementations

### Rust reference (`implementations/rust`)

17-crate Cargo workspace covering the full protocol stack: CBOR, crypto,
identity, core traits, QUIC transport, Kademlia DHT, NAT traversal (relay,
AutoNAT, DCuTR), messaging, SDK, MCP transport, A2A transport, Python PyO3
adapter, CLI, conformance tests, benchmarks, load testing, and integration
tests.

```bash
cd implementations/rust
cargo test --workspace        # 1597 tests, 0 failures, 7 ignored
cargo run --bin aafp -- init  # generate an agent identity
```

See [`implementations/rust/AGENTS.md`](implementations/rust/AGENTS.md) for
build conventions and architecture notes.

### Go independent (`implementations/go`)

Wire-format interoperability validation harness. Written strictly from the
RFCs to validate specification clarity and canonical encoding.

```bash
cd implementations/go
go test ./...                 # all packages pass
```

---

## Deployment

AAFP is deployable via Docker, Kubernetes, or systemd:

```bash
# Quick start with Docker
docker compose up             # starts 3-agent relay + NAT setup

# Or build from source
cd implementations/rust
cargo build --release
./target/release/aafp serve   # start an agent server
```

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for complete deployment guide.
See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for operational runbook.

---

## License

MIT OR Apache-2.0 (per workspace `Cargo.toml`).
