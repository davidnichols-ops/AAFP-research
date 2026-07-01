# Phase 1: Ecosystem Reconnaissance

```
Phase:          1 of 16
Title:          Ecosystem Reconnaissance
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
Sources:        Cloned repositories + web surveys + academic papers
```

## 1. Objective

Clone, study, and characterize every significant agent communication
protocol that competes with, complements, or contextualizes AAFP. The
goal is to build a complete map of the ecosystem before deeper
comparative analysis in Phases 2–16.

## 2. Protocols Studied

| # | Protocol | Origin | Governance | License | Cloned |
|---|----------|--------|------------|---------|--------|
| 1 | MCP | Anthropic (Nov 2024) | Agentic AI Foundation / Linux Foundation | Other | Yes (`/tmp/aafp-research/mcp`) |
| 2 | A2A | Google (Apr 2025) | Linux Foundation (8-company TSC) | Apache 2.0 | Yes (`/tmp/aafp-research/a2a`) |
| 3 | ACP | IBM/BeeAI (2025) | IBM Research → merged into A2A | Apache 2.0 | Yes (`/tmp/aafp-research/acp`) |
| 4 | ANP | ANP Working Group (2024) | W3C standardization track | MIT | Yes (`/tmp/aafp-research/anp`) |
| 5 | SLIM | AGNTCY/Cisco (2025) | IETF individual submission | Apache 2.0 | Yes (`/tmp/aafp-research/slim`) |
| 6 | AgentMesh | Microsoft (2026) | Microsoft (Public Preview) | MIT | Yes (`/tmp/aafp-research/agentmesh`) |
| 7 | OASF | AGNTCY (2025) | AGNTCY | Apache 2.0 | Yes (`/tmp/aafp-research/oasf`) |
| 8 | AG-UI | CopilotKit (2025) | (referenced in surveys) | — | Not cloned (out of scope: agent-to-frontend) |
| 9 | Pilot Protocol | Vulture Labs (2025) | (referenced in surveys) | AGPL-3.0 | Not cloned (L3/L4 network infra) |
| 10 | OSSA | Open Standard Agents (2026) | OSSA | — | Not cloned (contract layer, not transport) |

**Note**: ACP has been formally merged into A2A's roadmap (April 2026).
It is studied for historical context and to understand the design space
it explored (REST-based, MIME-typed multipart).

## 3. Protocol Summaries

### 3.1 MCP — Model Context Protocol

- **Scope**: Client-server tool invocation between LLMs and external
  tools/data sources. Inspired by LSP (Language Server Protocol).
- **Transport**: stdio (newline-delimited JSON-RPC) and Streamable HTTP
  (POST + optional SSE). Custom transports explicitly allowed.
- **Encoding**: JSON-RPC 2.0 (UTF-8 JSON).
- **Session**: Currently stateful (3-phase init handshake). Draft
  (2026-07-28, SEP-2575) moves to **stateless** model — every request
  carries protocol version + capabilities in `_meta`.
- **Security**: OAuth 2.1 for HTTP transport. No built-in crypto. Relies
  entirely on TLS. stdio has no protocol-level security (trust boundary
  = OS process isolation).
- **Extensions**: Formal framework (SEP-2133). URI-identified
  (`{vendor-prefix}/{name}`). Two-tier: Official + Experimental.
- **PQ readiness**: None. No PQ algorithms in spec. Relies on TLS for
  future PQ cipher suites.
- **Maturity**: 8,505 spec stars, 87,795 servers stars, 350+ contributors.
  Multiple official SDKs (Python, TS, Go, Swift, Kotlin, PHP). Enterprise
  deployments at millions of daily requests.
- **Key files**: `docs/specification/2025-11-25/`, `seps/2133-extensions.md`,
  `seps/2575-stateless-mcp.md`

### 3.2 A2A — Agent-to-Agent Protocol

- **Scope**: Peer-to-peer task delegation between opaque agents. The
  "horizontal" layer above MCP's "vertical" tool integration.
- **Architecture**: 3 layers — Canonical Data Model (protobuf), Abstract
  Operations (binding-independent), Protocol Bindings (JSON-RPC, gRPC,
  REST).
- **Transport**: HTTP/HTTPS (JSON-RPC 2.0 primary, gRPC, REST). SSE for
  streaming. No QUIC, no WebSockets in core spec.
- **Encoding**: JSON (ProtoJSON serialization from protobuf definitions).
- **Session**: Stateful task lifecycle — 8 states (SUBMITTED, WORKING,
  COMPLETED, FAILED, CANCELED, INPUT_REQUIRED, REJECTED, AUTH_REQUIRED).
  `contextId` groups related tasks for conversation continuity.
- **Discovery**: Agent Cards (JSON metadata at `/.well-known/agent-card.json`).
  Optional JWS signing (RFC 7515) for authenticity.
- **Security**: Transport-layer (TLS) + standard web auth (OAuth2, OIDC,
  mTLS, API keys). No message-level crypto. No E2EE.
- **Extensions**: URI-based with 2-tier governance (Official `ext-*` /
  Experimental `experimental-ext-*`). TSC vote for graduation.
- **PQ readiness**: None in core. External implementations exist
  (qhermes-a2a adds ML-DSA-65 + ML-KEM-768; DCP-04 defines hybrid KEM).
  Spec mentions PQC cipher suites "as they become available."
- **Maturity**: v1.0.1 (May 2026). 150+ supporting organizations. Deployed
  in Azure AI Foundry, Amazon Bedrock AgentCore, Google Agent Engine.
- **Key files**: `docs/specification.md` (3610 lines), `specification/a2a.proto`

### 3.3 ACP — Agent Communication Protocol

- **Scope**: General-purpose REST-based agent invocation. Lightweight,
  runtime-independent.
- **Status**: ARCHIVED. Roadmap merged into A2A (April 2026).
- **Transport**: RESTful HTTP. 23 endpoints.
- **Encoding**: JSON with MIME-typed multipart messages.
- **Session**: Session management + message routing. Supports sync and
  async interactions.
- **Identity**: Role-based + DIDs.
- **Significance**: Explored the REST-based design space. Its merger into
  A2A signals ecosystem consolidation around JSON-RPC/HTTP.
- **Key files**: `/tmp/aafp-research/acp/` (specification)

### 3.4 ANP — Agent Network Protocol

- **Scope**: Decentralized agent networking for the open internet. Most
  ambitious architectural stance — any agent can discover and communicate
  with any other without pre-established trust.
- **Architecture**: 3 layers —
  1. **Identity/Crypto**: W3C DIDs (`did:wba`), public key material in DID
     documents at well-known HTTPS URLs.
  2. **Meta-Protocol Negotiation**: Agents negotiate which application-layer
     protocol to use for a given interaction. This is the extensibility layer.
  3. **Application**: Actual agent interactions (9 profiles for E2EE
     messaging, etc.).
- **Transport**: HTTP + P2P.
- **Encoding**: JSON-LD.
- **Discovery**: DID resolution (no central registry).
- **Security**: DID-based mutual authentication. No central authority.
- **PQ readiness**: Not specified in studied materials.
- **Maturity**: W3C standardization track. MIT license. Active community.
- **Key files**: `/tmp/aafp-research/anp/` (white papers, specs)

### 3.5 SLIM — Secure Low-Latency Interactive Messaging

- **Scope**: Transport/messaging layer for AI agent protocols (A2A, MCP).
  Combines gRPC performance with MLS-based E2EE and group communication.
- **Architecture**: 3 planes —
  1. **Data Plane**: Pure message routing by hierarchical names
     (`org/namespace/service/client`). No content inspection.
  2. **Session Layer**: Reliable delivery, MLS E2EE, group membership.
     Two session types: Point-to-Point and Group.
  3. **Control Plane**: Configuration, monitoring, orchestration via gRPC.
- **Transport**: gRPC over HTTP/2 (default), WebSocket (alternative).
  HTTP/3/QUIC mentioned in IETF draft but **not implemented**.
- **Encoding**: Protocol Buffers.
- **Security**: MLS (RFC 9420) via `mls-rs` crate (AWS Labs). AWS-LC
  crypto provider (FIPS-validated). Cipher suites 1,2,3,5,7. Auth via
  JWT, SPIRE/SPIFFE, mTLS, shared secrets.
- **Session**: Stateful. `ProcessingState` (Active, Draining). Drain for
  graceful shutdown. Configurable retry/MLS settings.
- **Discovery**: Anycast (3-component name) + Unicast (4-component).
  Static + Kubernetes API peer discovery.
- **RPC**: SLIMRPC — protobuf-based RPC over SLIM sessions. All 4 gRPC
  patterns (unary-unary, unary-stream, stream-unary, stream-stream).
- **PQ readiness**: **Not implemented.** `mls-rs-crypto-awslc` has a
  `post-quantum` feature flag but it is NOT enabled. IETF draft
  `draft-ietf-mls-pq-ciphersuites-04` exists but not implemented.
- **Maturity**: 192 stars, 30 contributors, v1.4.0 (May 2026), 447
  releases. IETF individual submission (`draft-mpsb-agntcy-slim-01`).
  Rust (95.5%) with Go, Python, TS, Kotlin, Java, C# bindings.
- **Key files**: `crates/datapath/`, `crates/session/`, `crates/mls/`,
  `docs/content/slim/`

### 3.6 AgentMesh — Microsoft Agent Governance Toolkit

- **Scope**: Agent governance platform — policy enforcement, identity/trust
  management, secure messaging. Not just a protocol; a full platform.
- **Architecture**: 4-layer trust stack —
  1. **Identity & Zero-Trust Core**: Ed25519, DIDs, human sponsors.
  2. **Trust & Protocol Bridge**: A2A, MCP, IATP, capability scoping.
  3. **Governance & Compliance Plane**: Policy engine (OPA/Cedar), audit.
  4. **Reward & Learning Engine**: Trust scores, behavioral rewards.
- **Transport**: WebSocket (relay), HTTP/REST (registry), gRPC (alt).
- **Encoding**: JSON for all protocol frames.
- **Security**: Signal Protocol (X3DH + Double Ratchet) for E2EE.
  Ed25519 signatures, X25519 key agreement, ChaCha20-Poly1305 AEAD,
  HKDF-SHA256. Replay protection via single-use message keys + UUID
  deduplication. Skipped message keys limited to 100.
- **Identity**: `did:mesh:<hex>` (current) → `did:agentmesh:<fingerprint>`
  (planned). Every agent MUST have a human sponsor (sponsor_email).
  SPIFFE/SVID integration for enterprise. Key rotation with cryptographic
  proofs.
- **Trust**: 0-1000 integer scale, 5 tiers. Temporal decay (2.0/hr).
  Network contagion within 2 hops. 5 reward dimensions.
- **Governance**: YAML/JSON policy documents. OPA/Rego + Cedar backends.
  Fail-closed. Circuit breakers (CLOSED/OPEN/HALF_OPEN). Merkle chain
  audit logging. Approval workflows.
- **Extensions**: Framework Adapter Contract (10+ adapters: LangChain,
  CrewAI, AutoGen, OpenAI, Anthropic, Google ADK, etc.). Protocol bridges
  for A2A, MCP, IATP.
- **PQ readiness**: **Planned, not implemented.** Ed25519 in v1.0.
  ML-DSA-65 in roadmap (Near-Term). "No post-quantum key exchange in v1
  — X25519 only."
- **Maturity**: 4,539 stars, 120 contributors, v4.1.0 (June 2026), 19
  releases. Public Preview. 13,000+ tests, 992 conformance tests. Python
  (73.5%), TypeScript, Rust, C#, Go.
- **Key files**: `docs/specs/AGENTMESH-WIRE-1.0.md`,
  `docs/specs/AGENTMESH-IDENTITY-TRUST-1.0.md`

### 3.7 OASF — Open Agent Schema Framework

- **Scope**: Schema framework for agent description (complements AGNTCY
  ecosystem with SLIM).
- **Status**: Cloned but not deeply analyzed in Phase 1. Deferred to
  Phase 2 if relevant.

## 4. Ecosystem Topology

The 2026 agent communication landscape forms a **layered stack** where
protocols are largely complementary rather than competing:

```
┌─────────────────────────────────────────────────────────────┐
│  Application / Workflow Layer                                 │
│  (agent logic, orchestration, task delegation)                │
├──────────┬──────────┬──────────┬──────────────────────────────┤
│   A2A    │   ACP    │  AG-UI   │  OSSA (contract layer)       │
│ (task)   │ (merged) │ (UI)     │                              │
├──────────┴──────────┴──────────┴──────────────────────────────┤
│  Tool / Context Layer                                         │
│  MCP (tool invocation, resources, prompts)                    │
├──────────────────────────────────────────────────────────────┤
│  Messaging / Session Layer                                    │
│  SLIM (MLS E2EE, group), AgentMesh (governance + Signal)      │
├──────────────────────────────────────────────────────────────┤
│  Identity / Discovery Layer                                   │
│  ANP (DIDs, meta-protocol), AgentMesh (DIDs + trust)          │
├──────────────────────────────────────────────────────────────┤
│  Transport Layer                                              │
│  HTTP/2, WebSocket, stdio, (QUIC — only AAFP)                 │
└──────────────────────────────────────────────────────────────┘
```

**Key insight**: No major protocol in the ecosystem uses QUIC as its
transport. All rely on HTTP/1.1 or HTTP/2 (via gRPC, JSON-RPC, REST,
SSE, WebSocket). AAFP's QUIC-native design is **unique** in the ecosystem.

**Key insight**: No major protocol has post-quantum cryptography enabled
by default. SLIM has the infrastructure (mls-rs PQ feature flag) but
doesn't enable it. AgentMesh has ML-DSA-65 in its roadmap. A2A mentions
PQC "as available." AAFP's PQ-by-default stance is **unique**.

## 5. Where AAFP Sits — Initial Assessment

AAFP does not fit cleanly into any single layer of the ecosystem stack:

| AAFP Feature | Ecosystem Equivalent | Uniqueness |
|--------------|---------------------|------------|
| QUIC transport | None (all HTTP/WS) | **Unique** |
| ML-DSA-65 signatures | None active (planned in AgentMesh) | **Unique** |
| CBOR framing | None (all JSON/Protobuf) | **Unique** |
| PQ-by-default | None | **Unique** |
| Capability-based DHT discovery | ANP (DID resolution), A2A (Agent Cards) | Distinct approach |
| Session layer with CLOSE state machine | SLIM (session), A2A (task lifecycle) | Similar layer, different design |
| Replay protection (ReplayCache) | AgentMesh (single-use keys), SLIM (MLS) | Similar concept |
| Extension pipeline | A2A (URI extensions), MCP (SEP-2133) | Similar governance model |

**Initial positioning**: AAFP occupies the **transport + session + identity**
layers with a post-quantum, QUIC-native, CBOR-framed design. It is
architecturally closer to SLIM (secure messaging layer) than to A2A/MCP
(application/task layers). Its differentiators are PQ-by-default and
QUIC-native transport — neither of which any competitor currently offers.

## 6. Confidence Assessment

| Protocol | Depth of Study | Confidence |
|----------|---------------|------------|
| MCP | Full spec + SEPs + draft | High |
| A2A | Full spec + proto + governance | High |
| ACP | Spec overview | Medium (archived, less critical) |
| ANP | White papers + architecture | Medium |
| SLIM | Full codebase + docs + IETF draft | High |
| AgentMesh | Full specs + codebase | High |
| OASF | Cloned only | Low (deferred) |

## 7. Artifacts Produced

- This report: `research/phase-reports/PHASE-01-ecosystem-reconnaissance.md`
- Cloned repositories: `/tmp/aafp-research/{anp,a2a,acp,slim,agentmesh,mcp,oasf}`
- Subagent reports (in-context, consolidated into this report):
  - A2A deep study (agent `851b76d1`)
  - AgentMesh deep study (agent `e3e7e201`)
  - SLIM deep study (agent `35cb54cc`)
  - MCP deep study (agent `dc94b9db`)
- ANP/ACP studied directly by lead researcher

## 8. Transition to Phase 2

Phase 2 (Standards Survey) will systematically compare all protocols
across five dimensions:
1. **Transport** — what wire protocols, what streaming, what multiplexing
2. **Identity** — DIDs, Agent Cards, certificates, key material
3. **Delegation** — capability chains, OAuth scopes, trust propagation
4. **Cryptography** — signatures, encryption, KEX, PQ readiness
5. **Serialization** — JSON, CBOR, Protobuf, JSON-LD

The Phase 1 findings provide the raw material; Phase 2 will structure it
into comparison matrices.
