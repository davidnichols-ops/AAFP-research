# Phase 3: Protocol Layer Analysis

```
Phase:          3 of 16
Title:          Protocol Layer Analysis
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
Approach:       Layer-by-layer comparison using OSI-like model
```

## 1. Objective

Decompose each protocol into functional layers and produce comparison
tables at each layer. This reveals where protocols overlap, complement,
or conflict, and identifies the precise architectural niche AAFP occupies.

## 2. Layer Model

We use a 7-layer agent communication model adapted from OSI:

```
Layer 7: Application / Workflow     (task delegation, tool invocation)
Layer 6: Session / State            (session lifecycle, state machines)
Layer 5: Messaging / RPC            (framing, request-response, streaming)
Layer 4: Security / Crypto          (encryption, signatures, auth)
Layer 3: Identity / Discovery       (agent identity, capability lookup)
Layer 2: Transport                  (connection, multiplexing, flow control)
Layer 1: Physical / Network         (TCP, UDP, QUIC packets)
```

Layer 1 is out of scope (all protocols run over IP). We analyze layers 2-7.

## 3. Layer 2: Transport

| Protocol | Connection Oriented? | Multiplexing | Flow Control | Congestion Control | 0-RTT | Migration |
|----------|---------------------|-------------|--------------|-------------------|-------|-----------|
| **AAFP** | **Yes (QUIC)** | **Native (QUIC streams)** | **QUIC BBR/CUBIC** | **Yes** | **Yes** | **Yes** |
| MCP | Yes (TCP via HTTP) | None (HTTP/1.1) | TCP | TCP | No | No |
| A2A | Yes (TCP via HTTP) | HTTP/2 (gRPC only) | TCP | TCP | No | No |
| ACP | Yes (TCP via HTTP) | None | TCP | TCP | No | No |
| ANP | Yes (TCP via HTTP) | Not specified | TCP | TCP | No | No |
| SLIM | Yes (TCP via HTTP/2) | HTTP/2 (gRPC) | TCP | TCP | No | No |
| AgentMesh | Yes (TCP via WS) | None (single WS stream) | TCP | TCP | No | No |

### 3.1 Analysis

**AAFP is the only protocol operating at Layer 2 with QUIC.** All others
delegate transport to HTTP, which delegates to TCP. This gives AAFP:

- **Stream multiplexing without head-of-line blocking** (QUIC's key
  advantage over HTTP/2/TCP)
- **Connection migration** (survives IP address changes — critical for
  mobile agents)
- **0-RTT resumption** (sub-millisecond reconnection for known peers)
- **Built-in flow and congestion control** at the transport layer

**Trade-off**: QUIC requires UDP, which some enterprise firewalls block.
HTTP-based protocols work everywhere HTTP works. This is a deployment
advantage for the ecosystem and a potential barrier for AAFP (see Phase 8:
Enterprise Integration).

### 3.2 Transport Layer Interoperability

| Pair | Can share transport? | How? |
|------|---------------------|------|
| AAFP + A2A | Theoretical | A2A custom binding over AAFP QUIC streams |
| AAFP + MCP | Theoretical | MCP custom transport over AAFP session |
| AAFP + SLIM | Unlikely | Both define their own session/messaging; would conflict |
| SLIM + A2A | Yes (existing) | SLIM is designed as transport for A2A |
| MCP + A2A | Yes (existing) | Both use HTTP; complementary layers |

## 4. Layer 3: Identity & Discovery

| Protocol | Identity Primitive | Self-Sovereign? | Discovery Method | Registry Required? |
|----------|-------------------|-----------------|-----------------|-------------------|
| **AAFP** | **AgentId = SHA-256(PQ_pubkey)** | **Yes** | **Capability DHT** | **No** |
| MCP | OAuth client ID | No | Server URL (configured) | No |
| A2A | Agent Card (JSON) | Partial | Well-known URI / registry | Optional |
| ACP | Role + DID | Partial | Agent descriptors | No |
| ANP | W3C DID (`did:wba`) | Yes | DID resolution | No |
| SLIM | Hierarchical name | No | Anycast/unicast name | No |
| AgentMesh | DID + Ed25519 | Yes (but registry-validated) | Registry API | **Yes** |

### 4.1 Identity Layer Analysis

**Two paradigms emerge:**

1. **Cryptographic self-sovereignty** (AAFP, ANP): Identity is derived
   from the agent's own key material. No central authority needed. Any
   agent can verify any other agent's identity by recomputing the hash
   or resolving the DID.

2. **Registry-validated identity** (AgentMesh, SLIM, A2A): Identity is
   asserted by a registry or organization. Verification requires querying
   the registry. AgentMesh is the strongest here — it requires both a DID
   AND registry membership AND a human sponsor.

**AAFP's position**: Purest form of cryptographic self-sovereignty. The
AgentId IS the hash of the public key. No DID, no registry, no sponsor.
This is the most decentralized approach but also the most anarchic —
there is no notion of "trusted" vs "untrusted" agents at the identity
layer. Trust is entirely delegated to the authorization layer (UCAN).

### 4.2 Discovery Layer Analysis

| Feature | AAFP | A2A | ANP | SLIM | AgentMesh |
|---------|------|-----|-----|------|-----------|
| Capability-based lookup | Yes (DHT) | Yes (skills in Agent Card) | No | No | Yes (capability scoping) |
| Geographic awareness | Yes (regional) | No | No | No | No |
| Distributed (no central point) | Yes (DHT) | No (well-known URI) | Yes (DID) | No (hierarchical) | No (registry) |
| Peer exchange | Yes (PEX) | No | No | Yes (K8s/static) | No |

**AAFP's capability DHT is the most sophisticated discovery system** for
finding agents by what they can do. A2A's Agent Cards provide capability
metadata but require knowing the agent's URL first. AgentMesh has
capability scoping but within a central registry.

## 5. Layer 4: Security & Cryptography

| Protocol | Sig Algorithm | KEX | Encryption | Forward Secrecy | PQ-Ready | Replay Protection |
|----------|--------------|-----|------------|----------------|----------|-------------------|
| **AAFP** | **ML-DSA-65** | **X25519MLKEM768** | **AEAD** | **Yes (per-session keys)** | **Yes** | **ReplayCache** |
| MCP | None (OAuth) | TLS | TLS | TLS-dependent | No | None |
| A2A | JWS (optional) | TLS | TLS | TLS-dependent | No | None |
| ANP | DID pubkey | Unknown | Unknown (9 profiles) | Unknown | No | Unknown |
| SLIM | MLS sigs | MLS KEX | MLS AEAD | Yes (MLS) | No (flag exists) | MLS |
| AgentMesh | Ed25519 | X3DH | Double Ratchet | Yes (ratchet) | No (planned) | Single-use keys |

### 5.1 Security Layer Analysis

**Three cryptographic paradigms:**

1. **Post-quantum by default** (AAFP): ML-DSA-65 signatures +
   X25519MLKEM768 hybrid KEX. No classical-only mode. Protects against
   harvest-now-decrypt-later. This is the most forward-looking approach.

2. **MLS-based group crypto** (SLIM): Uses RFC 9420 MLS for group
   encryption with forward secrecy and post-compromise security. PQ
   infrastructure exists but is not enabled. Best for group messaging.

3. **Signal Protocol** (AgentMesh): X3DH + Double Ratchet for pairwise
   E2EE. Excellent forward secrecy but classical-only and pairwise-only.
   Group messaging planned for v2.

**AAFP's security model is unique in three ways:**
- Only protocol with PQ signatures (ML-DSA-65)
- Only protocol with PQ KEX (X25519MLKEM768)
- Only protocol with cross-connection replay cache (ReplayCache)

**Gap**: AAFP does not have group encryption (MLS). SLIM and AgentMesh
both support (or plan) group E2EE. This is a significant gap for
multi-agent collaboration scenarios (see Phase 10: Stateful Agents).

### 5.2 Authentication Flow Comparison

| Protocol | Messages | Round Trips | Crypto Operations |
|----------|----------|-------------|-------------------|
| **AAFP** | **3 (CH->SH->CF)** | **1.5** | **3 ML-DSA-65 sigs + HKDF + TLS PQ KEX** |
| MCP (HTTP) | OAuth flow | 2-3+ | TLS + OAuth token validation |
| A2A (HTTP) | TLS + optional JWS | 1-2 | TLS + JWS verification |
| SLIM | MLS Welcome | 1-2 | MLS group setup |
| AgentMesh | IATP challenge-response | 2 | Ed25519 sig + X3DH |

## 6. Layer 5: Messaging & RPC

| Protocol | Framing | RPC Pattern | Streaming | Max Message | Fragmentation |
|----------|---------|-------------|-----------|-------------|---------------|
| **AAFP** | **28-byte header + CBOR** | **Request/Response + Notifications** | **QUIC streams** | **1 MiB** | **MORE flag** |
| MCP | JSON-RPC over HTTP | Request/Response + Notifications | SSE | Unlimited (HTTP) | No |
| A2A | JSON-RPC / gRPC | Request/Response + Streaming | SSE / gRPC stream | Unlimited | No |
| SLIM | Protobuf over gRPC | All 4 gRPC patterns | gRPC streaming | Configurable | No |
| AgentMesh | JSON over WebSocket | Custom | WebSocket | Configurable | No |

### 6.1 Messaging Layer Analysis

**AAFP's framing is the most structured**: Fixed 28-byte header with
explicit frame type, flags, stream ID, and separate extension/payload
lengths. This enables:
- **Extension pipeline**: Up to 64 KiB of extension data per frame
- **Fragmentation**: MORE flag for splitting large payloads
- **Compression**: COMPRESSED flag
- **Critical flag**: For unknown frame types (forward compatibility)

**SLIM's SLIMRPC** is the most RPC-complete: supports all 4 gRPC patterns
(unary-unary, unary-stream, stream-unary, stream-stream). AAFP currently
defines only request/response and notifications.

**Gap**: AAFP does not define streaming RPC (server-streaming or
bidirectional-streaming). QUIC streams could support this naturally, but
the RPC protocol would need extension. This is relevant for long-running
agent tasks (see Phase 10).

## 7. Layer 6: Session & State

| Protocol | Session Model | States | State Machine | Timeout | Graceful Close |
|----------|--------------|--------|---------------|---------|----------------|
| **AAFP** | **8-state session + 5-state CLOSE** | **13 total** | **Strict transitions** | **5s CLOSE** | **Yes (CloseManager)** |
| MCP | Stateful -> Stateless (draft) | 3 (init/oper/shutdown) | Lifecycle | Server-defined | HTTP DELETE |
| A2A | Task lifecycle | 8 task states | Task state machine | Task-defined | Cancel task |
| SLIM | Session (P2P + Group) | Active/Draining | ProcessingState | Configurable | Drain |
| AgentMesh | Connection + trust | Circuit breaker (3) | CLOSED/OPEN/HALF_OPEN | Configurable | Relay disconnect |

### 7.1 Session Layer Analysis

**AAFP has the most complex session model** (13 states across two state
machines). The 8-state SessionState machine tracks the full lifecycle
from Connecting to Closed, with separate states for identity verification,
authorization verification, and messaging enablement. The 5-state CLOSE
state machine handles graceful shutdown with crossed-close detection.

**A2A's task state machine** is the most application-relevant: 8 states
tracking task lifecycle (SUBMITTED -> WORKING -> COMPLETED/FAILED/etc.).
This is a different concern from AAFP's session state — A2A tracks what
the agent is doing; AAFP tracks the connection state.

**Complementarity**: AAFP's session layer could host A2A's task state
machine as an application-layer concern. The session provides the secure
channel; the task state machine runs on top.

## 8. Layer 7: Application & Workflow

| Protocol | Application Primitive | Task Delegation | Tool Invocation | Multi-Agent Coordination |
|----------|----------------------|-----------------|-----------------|-------------------------|
| **AAFP** | **Capability-based messaging** | **UCAN delegation** | **Not specified** | **Not specified** |
| MCP | Tools, Resources, Prompts | No | **Yes (core feature)** | No |
| A2A | Tasks, Artifacts, Messages | **Yes (core feature)** | No | Yes (task handoff) |
| ACP | Agent invocation | Partial | No | Yes (multi-agent) |
| ANP | Meta-protocol negotiation | No | No | Yes (network-level) |
| SLIM | Messaging + SLIMRPC | No | No | Yes (group sessions) |
| AgentMesh | Governance + policy | Yes (IATP) | Yes (MCP bridge) | Yes (trust-based) |

### 8.1 Application Layer Analysis

**AAFP is conspicuously thin at Layer 7.** It defines capability-based
messaging and UCAN delegation but does not specify:
- Task lifecycle (A2A's core contribution)
- Tool invocation (MCP's core contribution)
- Multi-agent group coordination (SLIM/AgentMesh)
- Policy enforcement (AgentMesh)

This is by design — AAFP's non-goals (RFC-0001 section 1.3) explicitly
exclude resource exchange, distributed scheduling, semantic capability
routing, payment, and swarm intelligence. AAFP is a **secure transport
and session layer**, not an application protocol.

**Strategic implication**: AAFP's value proposition is being the secure
foundation upon which application-layer protocols (A2A, MCP) can run.
This is the "TCP for agents" positioning (see Phase 4).

## 9. Layer Coverage Matrix

Which layers does each protocol cover?

| Protocol | L2 Transport | L3 Identity | L3 Discovery | L4 Crypto | L5 Messaging | L6 Session | L7 Application |
|----------|-------------|-------------|--------------|-----------|-------------|------------|----------------|
| **AAFP** | **QUIC** | **PQ DID** | **DHT** | **PQ** | **CBOR** | **13-state** | **Thin** |
| MCP | HTTP | OAuth | URL | TLS | JSON-RPC | Stateful | **Rich** |
| A2A | HTTP | Agent Card | Well-known | TLS+JWS | JSON-RPC | Task | **Rich** |
| ANP | HTTP | DID | DID resolution | DID | JSON-LD | Meta-proto | Network |
| SLIM | gRPC | Hierarchical | Anycast | MLS | Protobuf | Session | RPC |
| AgentMesh | WS | DID+sponsor | Registry | Signal | JSON | Circuit | **Governance** |

### 9.1 Coverage Patterns

- **AAFP**: Deep at L2-L6, thin at L7. "Secure pipe" architecture.
- **MCP**: Thin at L2-L6, rich at L7. "Application tool" architecture.
- **A2A**: Thin at L2-L4, moderate at L5-L6, rich at L7. "Task delegation" architecture.
- **SLIM**: Strong at L2-L6, thin at L7. "Messaging backbone" architecture.
- **AgentMesh**: Moderate at L2-L4, strong at L6-L7. "Governance platform" architecture.

**AAFP and SLIM are architectural cousins** — both build deep stacks from
transport through session, but neither defines application-layer
semantics. The key difference: SLIM uses MLS + gRPC; AAFP uses PQ crypto +
QUIC + CBOR.

## 10. Interoperability Opportunities

Based on the layer analysis, these interop paths are most promising:

| Path | AAFP Layer | Other Protocol Layer | Feasibility |
|------|-----------|---------------------|-------------|
| AAFP transport for A2A | L2-L6 (AAFP) | L7 (A2A) | High — A2A supports custom bindings |
| AAFP transport for MCP | L2-L6 (AAFP) | L7 (MCP) | High — MCP supports custom transports |
| AAFP identity for AgentMesh | L3 (AAFP) | L3 (AgentMesh) | Medium — different DID models |
| AAFP + SLIM (parallel) | L2-L6 (both) | — | Low — overlapping layers, would conflict |
| AAFP UCAN + A2A tasks | L4 (AAFP) | L7 (A2A) | High — complementary concerns |

### 10.1 Most Promising: AAFP as Transport for A2A/MCP

A2A and MCP both explicitly support custom transport bindings. AAFP
could serve as a QUIC-based, post-quantum transport for either:

```
┌───────────────────────────────────────────┐
│  A2A Task Layer (L7)                       │
├───────────────────────────────────────────┤
│  AAFP Session + Security (L4-L6)           │
│  (ML-DSA-65, ReplayCache, CLOSE)           │
├───────────────────────────────────────────┤
│  AAFP QUIC Transport (L2)                  │
│  (X25519MLKEM768, QUIC streams)            │
└───────────────────────────────────────────┘
```

This would give A2A/MCP:
- Post-quantum security (vs. TLS-only)
- QUIC performance (vs. HTTP/1.1)
- CBOR efficiency (vs. JSON)
- Built-in replay protection (vs. none)

**Challenge**: Mapping JSON-RPC messages to CBOR frames, and mapping A2A's
task state machine to AAFP's session state machine (see Phase 15).

## 11. Key Architectural Tensions

### 11.1 Deep Stack vs. Thin Layer

AAFP builds a deep stack (L2-L6) but is thin at L7. The ecosystem is
moving toward **thin transport + rich application** (HTTP + A2A/MCP).
AAFP's approach is the opposite: **rich transport + thin application**.

- **Advantage**: Deep integration, better performance, stronger security
- **Disadvantage**: Harder to adopt (requires QUIC, CBOR, ML-DSA-65),
  smaller ecosystem, fewer application-level features

### 11.2 Post-Quantum vs. Classical

AAFP is PQ-by-default; everything else is classical. The ecosystem is
not yet demanding PQ (no major protocol has enabled it). AAFP is betting
that PQ will become necessary before the ecosystem converges.

- **If PQ becomes urgent**: AAFP is uniquely positioned
- **If PQ remains "nice to have"**: AAFP's PQ is a cost without immediate benefit

### 11.3 Decentralized vs. Governed

AAFP is fully decentralized (no registry, no sponsor). AgentMesh requires
a human sponsor and registry membership. The enterprise world favors
governance; the open-internet world favors decentralization.

- **For enterprise**: AgentMesh's governance model is more attractive
- **For open internet**: AAFP's decentralization is more aligned

## 12. Transition to Phase 4

Phase 4 (Where AAFP Fits) will use this layer analysis to define AAFP's
precise positioning in the ecosystem — whether it should be a "TCP for
agents" (transport layer), a "secure session layer" (L4-L6), or
something else entirely.
