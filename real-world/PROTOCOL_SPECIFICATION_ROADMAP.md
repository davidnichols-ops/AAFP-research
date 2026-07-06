# AAFP Protocol Specification Roadmap

> **Research document** — maps the current state of the AAFP RFC series
> (0001–0010) onto a forward roadmap of proposed RFCs (0011–0024). For each
> existing RFC we record its status, scope, and dependencies; for each proposed
> RFC we record a title, status, summary, key sections, and dependencies. The
> document closes with the formal RFC lifecycle process used by the AAFP
> project.
>
> **Primary sources**: `/Users/david/Projects/AAFP-research/RFCs/0001` through
> `0010`, plus the real-world research documents in
> `/Users/david/Projects/AAFP-research/real-world/`.

---

## Table of Contents

1. [Purpose of this Roadmap](#1-purpose-of-this-roadmap)
2. [RFC Process Overview](#2-rfc-process-overview)
3. [Current RFCs (0001–0010)](#3-current-rfcs-00010010)
   - 3.1 [RFC-0001: Protocol Overview](#31-rfc-0001-protocol-overview)
   - 3.2 [RFC-0002: Transport & Framing](#32-rfc-0002-transport--framing)
   - 3.3 [RFC-0003: Identity & Authentication](#33-rfc-0003-identity--authentication)
   - 3.4 [RFC-0004: Discovery](#34-rfc-0004-discovery)
   - 3.5 [RFC-0005: Error Model](#35-rfc-0005-error-model)
   - 3.6 [RFC-0006: Versioning & Compatibility](#36-rfc-0006-versioning--compatibility)
   - 3.7 [RFC-0007: MCP Transport Binding](#37-rfc-0007-mcp-transport-binding)
   - 3.8 [RFC-0008: A2A Transport Binding](#38-rfc-0008-a2a-transport-binding)
   - 3.9 [RFC-0009: PubSub](#39-rfc-0009-pubsub)
   - 3.10 [RFC-0010: Circuit Relay](#310-rfc-0010-circuit-relay)
4. [Proposed New RFCs (0011–0024)](#4-proposed-new-rfcs-00110024)
   - 4.1 [RFC-0011: Streaming RPC](#41-rfc-0011-streaming-rpc)
   - 4.2 [RFC-0012: AgentRecord Extensions](#42-rfc-0012-agentrecord-extensions)
   - 4.3 [RFC-0013: Semantic Capability Graphs](#43-rfc-0013-semantic-capability-graphs)
   - 4.4 [RFC-0014: Adaptive Routing](#44-rfc-0014-adaptive-routing)
   - 4.5 [RFC-0015: Rate Limiting & Resource Management](#45-rfc-0015-rate-limiting--resource-management)
   - 4.6 [RFC-0016: Agent Lifecycle](#46-rfc-0016-agent-lifecycle)
   - 4.7 [RFC-0017: Federation & Cross-Organization Trust](#47-rfc-0017-federation--cross-organization-trust)
   - 4.8 [RFC-0018: Back-Channeling & Progress Events](#48-rfc-0018-back-channeling--progress-events)
   - 4.9 [RFC-0019: GossipSub v1.1](#49-rfc-0019-gossipsub-v11)
   - 4.10 [RFC-0020: WebSocket Transport Binding](#410-rfc-0020-websocket-transport-binding)
   - 4.11 [RFC-0021: WebTransport Transport Binding](#411-rfc-0021-webtransport-transport-binding)
   - 4.12 [RFC-0022: Agent Registry API](#412-rfc-0022-agent-registry-api)
   - 4.13 [RFC-0023: Cost & Payment Protocol](#413-rfc-0023-cost--payment-protocol)
   - 4.14 [RFC-0024: Heartbeat & Liveness](#414-rfc-0024-heartbeat--liveness)
5. [Dependency Graph](#5-dependency-graph)
6. [RFC Status Legend](#6-rfc-status-legend)
7. [Open Questions](#7-open-questions)

---

## 1. Purpose of this Roadmap

The AAFP protocol is specified through a series of numbered RFCs. RFCs 0001
through 0010 define the v1 base protocol: transport, framing, identity,
discovery, errors, versioning, two application bindings (MCP and A2A), pubsub,
and circuit relay. These are sufficient for a working, post-quantum,
peer-to-peer agent network.

However, the v1 base protocol intentionally defers a number of capabilities
that real-world deployments will need. RFC-0001 §1.3 (Non-Goals) explicitly
lists resource exchange, distributed scheduling, semantic capability routing,
payment and settlement, and swarm intelligence as out of scope for v1. The
real-world research documents under `real-world/` expand on these gaps:
agent lifecycle management, federation and trust, observability, mobile and
edge deployment, production deployment, and more.

This roadmap:

- Catalogs every existing RFC with its current status, scope, and the
  dependencies it creates for later work.
- Proposes fourteen new RFCs (0011–0024) that close the most important gaps
  identified by the real-world research.
- For each proposed RFC, records a title, status, summary, key sections, and
  dependencies on other RFCs (existing or proposed).
- Defines the formal RFC lifecycle that all AAFP RFCs follow, from draft
  through implemented.
- Provides a dependency graph so that implementation and review effort can be
  sequenced.

The roadmap is a living document. As RFCs are drafted, reviewed, and
finalized, their status in this document is updated. New proposed RFCs may be
added; proposed RFCs may be merged or split before they reach draft status.

---

## 2. RFC Process Overview

Every AAFP RFC progresses through a defined lifecycle. The lifecycle is
modeled on the IETF RFC process but simplified for a single-project context.

### 2.1 Lifecycle Stages

```
draft  →  review  →  last call  →  final  →  implemented
  │         │          │            │            │
  │         │          │            │            └─ Reference implementation
  │         │          │            │               exists and conforms.
  │         │          │            └─ No further substantive changes.
  │         │          └─ Final comment window (typically 14 days).
  │         └─ Community review, amendments filed.
  └─ Initial text circulated; structure may change significantly.
```

| Stage | Description | Allowed Changes |
|-------|-------------|-----------------|
| **Draft** | Initial text exists. The RFC is circulated for discussion. Structure, sections, and normative requirements may change substantially. | Any change. |
| **Review** | The RFC is considered stable enough for detailed review. Amendments are filed as separate documents (`AMENDMENTS-NNNN.md`) and reviewed individually. | Amendments only; no direct edits to the RFC body without an amendment. |
| **Last Call** | The RFC is considered complete. A final comment window (default 14 days) is announced. Only editorial or clarifying changes are accepted. | Editorial and clarifying only. |
| **Final** | The last call window has closed with no blocking objections. The RFC is normative. Substantive changes require a new revision or a successor RFC. | None (new revision or successor RFC required). |
| **Implemented** | A reference implementation exists and is verified to conform to the RFC. The RFC is normative and backed by working code. | None (new revision or successor RFC required). |

### 2.2 Additional States

| State | Meaning |
|-------|---------|
| **Experimental** | The RFC describes a protocol that is not yet on the standards track. Implementations exist for research but conformance is not required. Used by RFC-0009 and RFC-0010. |
| **Informational** | The RFC documents architecture or guidance without defining normative wire format. Used by RFC-0001. |
| **Standards Track** | The RFC defines normative wire format or behavior. Implementations claiming conformance MUST comply. Used by RFC-0002 through RFC-0006. |
| **Obsolete** | The RFC has been superseded by a successor. The successor RFC lists it in the `Obsoletes` header. |

### 2.3 Amendment Process

Once an RFC reaches **Review** status, substantive changes are made through
formal amendments rather than direct edits:

1. An amendment is filed as `AMENDMENTS-NNNN.md` with a unique identifier
   (e.g., `SA-0001` for the first amendment to RFC-0001).
2. Each amendment has its own status (proposed, accepted, rejected).
3. Accepted amendments are folded into the next revision of the RFC.
4. The RFC's `Revised` header records the revision history.

This process preserves the auditability of the specification. Every normative
change can be traced to a reviewed and accepted amendment.

### 2.4 Numbering

- RFCs are numbered sequentially starting at 0001.
- Once assigned, a number is never reused.
- An RFC that obsoletes another carries a new number and lists the obsoleted
  RFC in its `Obsoletes` header.
- Proposed RFCs that have not yet been drafted reserve a number in this
  roadmap. The number may change before the draft is circulated.

---

## 3. Current RFCs (0001–0010)

The following ten RFCs constitute the current AAFP specification series. They
are stored under `/Users/david/Projects/AAFP-research/RFCs/`.

### 3.1 RFC-0001: Protocol Overview

| Field | Value |
|-------|-------|
| **File** | `0001-protocol-overview.md` |
| **Title** | Protocol Overview, Goals, and Layer Architecture |
| **Status** | Release Candidate (Revision 6) |
| **Type** | Informational |
| **Obsoletes** | — |
| **Dependencies** | None (foundational) |

**Scope**: RFC-0001 is the foundational document of the AAFP series. It
defines the protocol's motivation, design philosophy, non-goals, layer
architecture, and the trust model. It introduces the core concepts that all
other RFCs build upon: AgentId, AgentRecord, capability-based discovery,
QUIC transport with post-quantum TLS, and the framing/RPC/pubsub messaging
primitives.

**Key sections**:
1. Introduction and motivation (why existing P2P stacks are insufficient for
   AI agents).
2. Design philosophy (preserve abstractions, post-quantum by default, specify
   before implementing).
3. Non-goals (resource exchange, scheduling, semantic routing, payment,
   swarm intelligence).
4. Layer architecture (QUIC → TLS → transport → core → identity/discovery/
   messaging → SDK → application).
5. Agent identity overview (AgentId, AgentRecord, authorization).
6. Discovery overview (identity, capability, service, resource).
7. Transport overview (QUIC, PQ KEX, TLS certificates).
8. Messaging overview (framing, stream multiplexing, RPC, pubsub).
9. Compatibility guarantees (wire format stability, extension mechanism).
10. Security considerations (trust model, PQ security, harvest-now-decrypt-
    later, identity binding, TOFU limitations, explicit security limitations
    of v1).
11. IANA considerations.

**Notes**: RFC-0001 explicitly defers several capabilities that the proposed
RFCs in Section 4 address: semantic capability routing (RFC-0013), resource
discovery (RFC-0015), payment (RFC-0023), NAT traversal (partially addressed
by RFC-0010, future DCuTR), session resumption, revocation, key rotation,
and Sybil resistance. The non-goals list in §1.3 is the primary input to
this roadmap.

---

### 3.2 RFC-0002: Transport & Framing

| Field | Value |
|-------|-------|
| **File** | `0002-transport-framing.md` |
| **Title** | Transport, Framing, Stream Multiplexing, and Wire Format |
| **Status** | Release Candidate (Revision 6) |
| **Type** | Standards Track |
| **Obsoletes** | — |
| **Dependencies** | RFC-0001 (concepts) |

**Scope**: RFC-0002 is the most critical RFC in the series. It defines the
AAFP wire format: the frame header, frame types, the application-layer
handshake, stream multiplexing, and the CBOR encoding rules. Every other
standards-track RFC depends on this document for the frame format.

**Key sections**:
1. Transport (QUIC version, TLS ALPN `aafp/1`, PQ key exchange
   `X25519MLKEM768`, self-signed TLS certificates, connection lifecycle,
   channel binding).
2. Frame format (fixed 32-byte header: version, frame type, flags, reserved,
   64-bit stream ID, 64-bit payload length, 64-bit extension length; body
   with extensions and payload; 1 MiB max payload, 64 KiB max extensions).
3. Frame types: DATA (0x01, with MORE and COMPRESSED flags), HANDSHAKE
   (0x02), RPC_REQUEST (0x03), RPC_RESPONSE (0x04), CLOSE (0x05), ERROR
   (0x06), PING (0x07), PONG (0x08), reserved types with critical-bit
   handling.
4. Handshake (three-message ClientHello/ServerHello/ClientFinished on stream
   0, transcript hash with TLS channel binding, ML-DSA-65 signatures with
   domain separator `aafp-v1-handshake`).
5. Stream multiplexing (logical streams map to QUIC bidirectional streams;
   stream 0 reserved for handshake and connection-level control).
6. Extensions (extension blocks in the frame header, negotiation via
   handshake).
7. Canonical CBOR encoding rules (deterministic map ordering, integer keys).
8. Conformance requirements.

**Notes for future RFCs**: The DATA frame's MORE flag (§4.1) is the basis
for RFC-0011 (Streaming RPC). The extension block mechanism (§6) is the
basis for RFC-0012 (AgentRecord Extensions). The PING/PONG frames (§4.7–
§4.8) are relevant to RFC-0024 (Heartbeat & Liveness). The reserved frame
types (0x09–0xFF) provide space for new frame types needed by proposed
RFCs (e.g., back-channel frames for RFC-0018).

---

### 3.3 RFC-0003: Identity & Authentication

| Field | Value |
|-------|-------|
| **File** | `0003-identity-authentication.md` |
| **Title** | Agent Identity, AgentRecord, Capability Descriptors, Authorization, and Session Lifecycle |
| **Status** | Release Candidate (Revision 6) |
| **Type** | Standards Track |
| **Obsoletes** | — |
| **Dependencies** | RFC-0001, RFC-0002 (CBOR encoding, handshake) |

**Scope**: RFC-0003 defines the AAFP identity model: AgentId derivation,
the key algorithm registry, AgentRecord schema and signature computation,
CapabilityDescriptor schema, the AuthorizationProvider trait, the UCAN
implementation, and session lifecycle.

**Key sections**:
1. Agent identity (AgentId = SHA-256(public_key), 32 bytes; hex and
   fingerprint encodings; hash agility as future work; key algorithm
   registry with ML-DSA-65/44/87 and SLH-DSA-128s; key rotation as
   out-of-band; AgentId fingerprint for TOFU verification).
2. AgentRecord (CBOR schema with integer keys 1–9: record_type, agent_id,
   public_key, capabilities, endpoints, created_at, expires_at, signature,
   key_algorithm; signature computation with domain separator
   `aafp-v1-record`; verification procedure; forward compatibility for keys
   ≥ 10).
3. CapabilityDescriptor (name + metadata map; typed MetadataValue enum;
   deterministic BTreeMap ordering for signature compatibility; capability
   naming conventions).
4. Authorization (AuthorizationProvider trait; Authorization result;
   Capability struct; UCAN implementation with CBOR-encoded tokens and
   domain separator `aafp-v1-ucan`; delegation chains; future providers
   OIDC and PQ capability tokens).

**Notes for future RFCs**: The AgentRecord forward-compatibility clause
(§3.7, keys ≥ 10) is the basis for RFC-0012 (AgentRecord Extensions), which
formalizes CBOR key 11 as the extension map. The key rotation gap (§2.5)
is relevant to RFC-0016 (Agent Lifecycle) and RFC-0017 (Federation). The
absence of revocation (noted in RFC-0001 §9.6 item 8) is relevant to
RFC-0017. The CapabilityDescriptor metadata map is the foundation for
RFC-0013 (Semantic Capability Graphs).

---

### 3.4 RFC-0004: Discovery

| Field | Value |
|-------|-------|
| **File** | `0004-discovery.md` |
| **Title** | Discovery: Identity, Capability, Service, and Resource |
| **Status** | Release Candidate (Revision 6) |
| **Type** | Standards Track |
| **Obsoletes** | — |
| **Dependencies** | RFC-0001, RFC-0002 (RPC frames), RFC-0003 (AgentRecord) |

**Scope**: RFC-0004 specifies the AAFP discovery system. It defines four
discovery classes (identity, capability, service, resource), the bootstrap
protocol, the in-memory capability-keyed DHT, and the RPC methods for
announcement and lookup.

**Key sections**:
1. Discovery classes (identity discovery via bootstrap and peer exchange;
   capability discovery via in-memory DHT; service and resource discovery
   named but not implemented in v1).
2. Bootstrap discovery (bootstrap node configuration, bootstrap protocol
   with `aafp.discovery.announce` and `aafp.discovery.lookup` RPC methods,
   peer exchange).
3. Capability DHT (indexing AgentRecords by capability name, lookup
   semantics).
4. Security considerations (eclipse attacks, Sybil resistance, bootstrap
   node trust).

**Notes for future RFCs**: The service and resource discovery classes
(§2.3–§2.4) are explicitly deferred. RFC-0013 (Semantic Capability Graphs)
extends capability discovery with multi-dimensional queries. RFC-0015
(Rate Limiting & Resource Management) addresses resource discovery.
RFC-0022 (Agent Registry API) provides a higher-level registry interface
on top of the DHT. The absence of Sybil resistance (§8.3) is relevant to
RFC-0017 (Federation).

---

### 3.5 RFC-0005: Error Model

| Field | Value |
|-------|-------|
| **File** | `0005-error-model.md` |
| **Title** | Protocol Error Codes, Error Frames, and Error Handling |
| **Status** | Release Candidate (Revision 6) |
| **Type** | Standards Track |
| **Obsoletes** | — |
| **Dependencies** | RFC-0002 (ERROR frame, CBOR encoding) |

**Scope**: RFC-0005 defines the AAFP error model: error code format,
categorized error code registry, the ERROR frame, and error handling rules
for implementations.

**Key sections**:
1. Error code format (32-bit unsigned integers, categorized by thousands
   digit: 0xxx success, 1xxx transport, 2xxx authentication, 3xxx
   authorization, 4xxx discovery, 5xxx messaging, 6xxx capability, 7xxx
   resource reserved, 8xxx protocol, 9xxx application reserved).
2. Error code registry (stable, unique, categorized, extensible).
3. Error frame (CBOR-encoded ErrorMessage with code, message, data, fatal
   flag; fatal errors require connection close).
4. Error handling rules (per-category handling, fatal vs. non-fatal,
   stream-level vs. connection-level errors).

**Notes for future RFCs**: The 7xxx (resource) category is reserved but
unused in v1. RFC-0015 (Rate Limiting & Resource Management) will allocate
codes in this range. The 9xxx (application) category is reserved for
applications; RFC-0023 (Cost & Payment Protocol) may allocate codes there.
New error codes for streaming (RFC-0011), lifecycle (RFC-0016), and
federation (RFC-0017) will be allocated in the appropriate categories.

---

### 3.6 RFC-0006: Versioning & Compatibility

| Field | Value |
|-------|-------|
| **File** | `0006-versioning-compatibility.md` |
| **Title** | Protocol Versioning, Extension Registry, and Compatibility Rules |
| **Status** | Release Candidate (Revision 6) |
| **Type** | Standards Track |
| **Obsoletes** | — |
| **Dependencies** | RFC-0001, RFC-0002 (version field, extension blocks) |

**Scope**: RFC-0006 is the governance RFC. It defines protocol version
numbering, version negotiation via TLS ALPN, compatibility rules (same
version, forward, backward), the extension registry, and the conformance
requirements for AAFP v1.

**Key sections**:
1. Protocol versioning (8-bit version field; version 0 = pre-RFC MVP,
   incompatible; version 1 = first standardized; version negotiation via
   ALPN `aafp/1`, `aafp/2`, etc.; no in-band downgrade).
2. Compatibility rules (same version full compatibility; forward
   compatibility via extensions not version skipping; backward compatibility
   via unknown-field ignoring and critical-bit handling).
3. Extension registry (extension types, critical bit semantics, registration
   process).
4. Conformance requirements (normative MUST/SHOULD/MAY requirements for v1
   implementations).

**Notes for future RFCs**: RFC-0006 is the governance framework under which
all proposed RFCs operate. Every proposed RFC that defines a new extension
type, frame type, or error code must follow the registration process in
RFC-0006 §3. RFC-0012 (AgentRecord Extensions) directly extends the
extension registry. A future v2 of the protocol would follow the versioning
rules in RFC-0006 §2.

---

### 3.7 RFC-0007: MCP Transport Binding

| Field | Value |
|-------|-------|
| **File** | `0007-mcp-transport-binding.md` |
| **Title** | AAFP Transport Binding for MCP |
| **Status** | Implemented |
| **Type** | Standards Track (binding) |
| **Obsoletes** | — |
| **Dependencies** | RFC-0002 (frames, streams), RFC-0003 (identity) |

**Scope**: RFC-0007 defines a transport binding for the Model Context
Protocol (MCP) over AAFP. MCP is a JSON-RPC 2.0 protocol for agent-to-tool
communication. This binding replaces MCP's default stdio and Streamable HTTP
transports with AAFP's post-quantum QUIC transport, providing ML-DSA-65
agent identity and PQ-secure channels.

**Key sections**:
1. Motivation (no identity verification in stdio/HTTP; no PQ security; no
   P2P connectivity; MCP spec permits custom transports).
2. Transport architecture (MCP application layer → rmcp service layer →
   AAFP transport layer → QUIC).
3. Message mapping (JSON-RPC 2.0 messages carried as AAFP DATA frames;
   bidirectional streams for tool calls and responses).
4. Capability advertisement (MCP tools/resources/prompts mapped to
   CapabilityDescriptors).
5. Security considerations (PQ identity, channel binding, authorization via
   UCAN).

**Notes for future RFCs**: RFC-0007 demonstrates the binding pattern that
RFC-0020 (WebSocket) and RFC-0021 (WebTransport) will follow for additional
transport bindings. RFC-0011 (Streaming RPC) may affect how MCP streaming
responses are carried. RFC-0018 (Back-Channeling) may affect how MCP
progress notifications are delivered.

---

### 3.8 RFC-0008: A2A Transport Binding

| Field | Value |
|-------|-------|
| **File** | `0008-a2a-transport-binding.md` |
| **Title** | AAFP Transport Binding for A2A |
| **Status** | Implemented |
| **Type** | Standards Track (binding) |
| **Obsoletes** | — |
| **Dependencies** | RFC-0002 (frames, streams), RFC-0003 (identity) |

**Scope**: RFC-0008 defines a custom protocol binding for the Agent2Agent
(A2A) Protocol over AAFP. A2A defines three standard bindings (JSON-RPC,
gRPC, HTTP+JSON/REST), all over HTTP(S). This binding replaces HTTP(S) with
AAFP's QUIC transport, eliminating PKI dependency and adding post-quantum
security.

**Key sections**:
1. Motivation (PKI dependency of HTTP(S); no PQ security; HTTP overhead; no
   native streaming; A2A spec supports custom bindings).
2. Transport architecture (A2A application layer → AAFP transport layer →
   QUIC).
3. Operation mapping (all 11 A2A core operations mapped to AAFP RPC methods
   or DATA frames; JSON data model preserved byte-for-byte).
4. Streaming support (A2A streaming operations mapped to QUIC bidirectional
   streams).
5. Security considerations (PQ identity, channel binding, authorization).

**Notes for future RFCs**: RFC-0008's streaming support is informal; RFC-0011
(Streaming RPC) will formalize the underlying streaming primitives. RFC-0014
(Adaptive Routing) is relevant to A2A's task routing. RFC-0023 (Cost &
Payment) is relevant to A2A's task assignment semantics.

---

### 3.9 RFC-0009: PubSub

| Field | Value |
|-------|-------|
| **File** | `0009-pubsub.md` |
| **Title** | Networked PubSub Protocol |
| **Status** | Experimental |
| **Type** | Experimental |
| **Obsoletes** | — |
| **Dependencies** | RFC-0002 (RPC frames), RFC-0003 (identity) |

**Scope**: RFC-0009 specifies a networked publish/subscribe protocol for
AAFP. Version 1 implements **floodsub** — published messages are forwarded
to all known peers subscribed to the same topic. A gossipsub upgrade is
documented as future work.

**Key sections**:
1. Introduction (extends in-memory pubsub from RFC-0001 §6.4 to the network
   layer).
2. Wire format (RPC methods: `aafp.pubsub.subscribe`, `aafp.pubsub.unsubscribe`,
   `aafp.pubsub.publish`; CBOR-encoded request/response structures).
3. Floodsub propagation (message forwarding to all subscribed peers).
4. Topic-based routing (topic strings, subscription management).
5. Future work (gossipsub mesh-based propagation).

**Notes for future RFCs**: RFC-0009 explicitly names gossipsub as future
work. RFC-0019 (GossipSub v1.1) is the direct successor, upgrading from
floodsub to mesh-based propagation with peer scoring, PX (peer exchange),
and topic authentication. RFC-0019 will obsolete or extend RFC-0009
depending on whether the wire format changes.

---

### 3.10 RFC-0010: Circuit Relay

| Field | Value |
|-------|-------|
| **File** | `0010-circuit-relay.md` |
| **Title** | Circuit Relay Protocol |
| **Status** | Experimental |
| **Type** | Experimental |
| **Obsoletes** | — |
| **Dependencies** | RFC-0002 (RPC frames), RFC-0003 (identity), RFC-0004 (discovery) |

**Scope**: RFC-0010 specifies a circuit relay protocol for AAFP that allows
agents behind NAT to communicate through relay nodes. Agents behind NAT
request reservations from relay nodes; third-party agents connect to the
relay and request relayed connections to the NAT'd agent.

**Key sections**:
1. Introduction (NAT problem; relay as intermediary; DCuTR upgrade path).
2. Wire format (RPC methods: `aafp.relay.reserve`, `aafp.relay.renew`,
   `aafp.relay.cancel`, `aafp.relay.connect`; CBOR-encoded structures).
3. Reservation model (time-limited reservations, TTL-based expiration,
   renewal).
4. Capacity limits (max concurrent connections, max duration).
5. DCuTR upgrade (after relayed connection, peers attempt direct connection).

**Notes for future RFCs**: RFC-0010 is the first step toward full NAT
traversal. A future DCuTR (Direct Connection Upgrade through Relay) RFC
would build on RFC-0010. RFC-0024 (Heartbeat & Liveness) is relevant to
reservation TTL management. RFC-0016 (Agent Lifecycle) is relevant to
relay reservation lifecycle. RFC-0015 (Rate Limiting) is relevant to relay
capacity limits.

---

## 4. Proposed New RFCs (0011–0024)

The following fourteen RFCs are proposed to close the gaps identified by the
v1 non-goals (RFC-0001 §1.3) and the real-world research documents. Each is
listed with a reserved number, title, status, summary, key sections, and
dependencies. None have been drafted yet; their numbers are reserved in this
roadmap and may be adjusted before drafting.

### 4.1 RFC-0011: Streaming RPC

| Field | Value |
|-------|-------|
| **Number** | 0011 |
| **Title** | Streaming RPC: MORE Flag, Cancellation, and End-of-Stream |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0002 (DATA frame MORE flag, RPC frames), RFC-0005 (error codes) |

**Summary**: RFC-0011 formalizes the streaming RPC behavior that is
partially specified in RFC-0002 §4.1 (the MORE flag on DATA frames) and
used informally by RFC-0007 and RFC-0008. The current specification defines
the MORE flag for message fragmentation but does not define a complete
streaming RPC semantics: how a request initiates a stream of responses, how
the client cancels a stream, how the server signals end-of-stream, and how
errors mid-stream are handled.

This RFC defines a streaming RPC pattern where a single RPC_REQUEST frame
initiates a stream of RPC_RESPONSE frames (or DATA frames) on the same
QUIC stream. The MORE flag indicates that more responses follow; a frame
without the MORE flag signals end-of-stream. A new CANCEL control frame
allows the client to cancel an in-flight stream. Error handling specifies
that a mid-stream ERROR frame terminates the stream with an error status.

**Key sections**:
1. Overview and relationship to RFC-0002 §4.1 (MORE flag) and §4.3–§4.4
   (RPC_REQUEST/RPC_RESPONSE).
2. Stream initiation (RPC_REQUEST with a streaming flag; server responds
   with a sequence of frames on the same QUIC stream).
3. MORE flag semantics for streaming (MORE set = more responses follow; MORE
   unset = end-of-stream; final frame may carry a terminal status).
4. Cancellation (new CANCEL frame type or RPC method; client-initiated
   cancellation; server cleanup; resources released).
5. End-of-stream signaling (explicit end-of-stream frame vs. MORE-unset;
   successful completion vs. error termination).
6. Error handling mid-stream (ERROR frame terminates stream; stream-level
   vs. connection-level errors; partial results).
7. Backpressure and flow control (QUIC stream flow control; application-
   level backpressure signals).
8. Interaction with MCP and A2A bindings (how RFC-0007 and RFC-0008 use
   streaming RPC).
9. New error codes (in the 5xxx messaging category) for streaming-specific
   errors (stream cancelled, stream invalid, stream timeout).
10. Security considerations (stream resource exhaustion, DoS via
    long-running streams, limits on concurrent streams).

**Dependencies**: RFC-0002 (frame format, MORE flag, RPC frames), RFC-0005
(error codes for streaming errors), RFC-0006 (extension registration for
the CANCEL frame type if a new frame type is used). RFC-0007 and RFC-0008
should be updated to reference RFC-0011 once finalized.

---

### 4.2 RFC-0012: AgentRecord Extensions

| Field | Value |
|-------|-------|
| **Number** | 0012 |
| **Title** | AgentRecord Extensions: CBOR Key 11, Extension Map, and Namespaces |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0003 (AgentRecord schema, forward compatibility), RFC-0006 (extension registry) |

**Summary**: RFC-0003 §3.7 states that future versions of AgentRecord MAY
add new fields with integer keys ≥ 10, and that implementations MUST ignore
unknown fields. This provides forward compatibility but does not define a
structured extension mechanism. Without one, each new AgentRecord field is
ad-hoc, risking key collisions and making it impossible for implementations
to negotiate which extensions they understand.

RFC-0012 formalizes CBOR key 11 as the AgentRecord extension map. The
extension map is a CBOR map keyed by extension type identifiers (registered
per RFC-0006 §3). Each extension type defines its own value schema. This
creates a structured, collision-free namespace for AgentRecord extensions
while preserving backward compatibility (implementations that do not
understand an extension type ignore its entry in the map).

The RFC also defines extension namespaces: a mechanism for organization-
specific or application-specific extensions that are not globally registered,
using reverse-DNS or URN-style identifiers to avoid collisions with
registered extension types.

**Key sections**:
1. Overview and relationship to RFC-0003 §3.7 (forward compatibility) and
   RFC-0006 §3 (extension registry).
2. CBOR key 11: the extension map (schema: `11: { *uint => any }`; keyed by
   registered extension type; value schema per extension type).
3. Extension type registry (extension types for AgentRecord, registered per
   RFC-0006; initial allocations for known needs: pricing metadata, resource
   metrics, reputation, semantic capability references).
4. Namespaces for unregistered extensions (reverse-DNS or URN-style keys for
   organization-specific extensions; collision avoidance; interoperability
   implications).
5. Signature coverage (the extension map at key 11 is included in the
   AgentRecord signature; verification procedure update).
6. Forward and backward compatibility (old implementations ignore key 11;
   new implementations handle known extension types; unknown extension types
   within the map are ignored).
7. CapabilityDescriptor extensions (parallel mechanism for
   CapabilityDescriptor fields ≥ 3; relationship to semantic capabilities
   in RFC-0013).
8. Security considerations (extension injection, signature integrity,
  namespace squatting).

**Dependencies**: RFC-0003 (AgentRecord schema and signature computation),
RFC-0006 (extension registry). RFC-0013 (Semantic Capability Graphs) and
RFC-0014 (Adaptive Routing) will likely define extension types registered
under this RFC. RFC-0017 (Federation) may define federation-specific
extensions.

---

### 4.3 RFC-0013: Semantic Capability Graphs

| Field | Value |
|-------|-------|
| **Number** | 0013 |
| **Title** | Semantic Capability Graphs: SemanticCapability, Query Syntax, and Multi-Dimensional Lookup |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0003 (CapabilityDescriptor), RFC-0004 (capability DHT), RFC-0012 (AgentRecord extensions) |

**Summary**: RFC-0001 §1.3 explicitly defers semantic capability routing:
"Multi-dimensional capability queries (cost, latency, trust score, hardware)
are deferred until usage patterns emerge. v1 supports string-keyed capability
lookup only." RFC-0004 §2.2 reiterates this: "Future: Semantic capability
routing supporting multi-dimensional queries."

RFC-0013 closes this gap by defining a SemanticCapability model that
extends the flat CapabilityDescriptor (name + metadata map) into a
structured, queryable capability graph. Each capability can carry typed
attributes (cost per token, average latency, GPU type, model name, trust
score, availability) that are indexed and queryable. The RFC defines a
query syntax for multi-dimensional capability lookup: "find agents with
capability 'inference' where cost_per_token < 0.001 and latency_p99 < 200ms
and gpu_type = 'H100'."

The capability graph is distributed: each agent advertises its
SemanticCapabilities via AgentRecord extensions (RFC-0012), and the
discovery DHT (RFC-0004) indexes capabilities by both name and attribute
ranges. The query syntax supports filtering, ranking, and aggregation.

**Key sections**:
1. Overview and relationship to RFC-0001 §1.3 (non-goal) and RFC-0004 §2.2
   (future capability routing).
2. SemanticCapability model (structured capability with typed attributes;
   CBOR schema; relationship to CapabilityDescriptor metadata map).
3. Attribute schema (well-known attribute names: cost_per_token, latency_p50,
   latency_p99, gpu_type, model_name, trust_score, availability,
   max_concurrent_requests; typed values; units).
4. Query syntax (filter expressions: attribute comparisons, logical AND/OR;
   ranking expressions: sort by attribute; aggregation: count, min, max,
   avg; CBOR-encoded query structures).
5. DHT indexing (indexing by capability name + attribute ranges; range
   queries; trade-offs between index size and query expressiveness).
6. Query propagation (how queries are routed through the DHT; results
   aggregation; caching).
7. AgentRecord extension type (registration under RFC-0012 key 11 for
   semantic capability data).
8. Capability graph relationships (capability composition: "agent A
   provides inference using tool B"; dependency edges; graph traversal
   queries).
9. Security considerations (attribute spoofing, sybil attacks on capability
   claims, trust score manipulation, query privacy).
10. Performance considerations (index size, query latency, caching
    strategies, staleness).

**Dependencies**: RFC-0003 (CapabilityDescriptor), RFC-0004 (capability
DHT), RFC-0012 (AgentRecord extensions for carrying semantic capability
data). RFC-0014 (Adaptive Routing) consumes the query results for routing
decisions. RFC-0022 (Agent Registry API) may expose the query syntax as a
higher-level API.

---

### 4.4 RFC-0014: Adaptive Routing

| Field | Value |
|-------|-------|
| **Number** | 0014 |
| **Title** | Adaptive Routing: Routing Metrics, Circuit Breaker, and Hedging |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0004 (discovery), RFC-0013 (semantic capability graphs), RFC-0010 (circuit relay) |

**Summary**: AAFP v1 provides capability-based discovery (find agents by
capability name) but does not define how a caller chooses among multiple
agents that match a query. In a production deployment with many agents
providing the same capability, the caller needs routing logic: which agent
to call, when to retry, when to give up, and when to try multiple agents in
parallel.

RFC-0014 defines an adaptive routing layer that sits between discovery
(RFC-0004) and messaging (RFC-0002). It consumes semantic capability query
results (RFC-0013) and produces routing decisions based on metrics:
observed latency, success rate, cost, load, and trust score. The RFC
defines three routing patterns:

1. **Metric-based selection**: Choose the agent with the best score
   according to a weighted combination of metrics.
2. **Circuit breaker**: Track failure rates per agent; open a circuit
   (stop sending requests) when the failure rate exceeds a threshold;
   half-open (probe with a single request) after a cooldown period; close
   the circuit when the probe succeeds.
3. **Hedged requests**: Send the same request to multiple agents
   simultaneously; accept the first successful response; cancel the others
   (using RFC-0011 cancellation). This reduces tail latency at the cost of
   redundant work.

**Key sections**:
1. Overview and relationship to RFC-0004 (discovery) and RFC-0013 (semantic
   capability graphs).
2. Routing metrics (observed latency, success rate, cost, load, trust score;
   metric collection; metric aggregation; metric staleness and TTL).
3. Metric-based selection (weighted scoring; configurable weights;
   stickiness vs. load balancing; session affinity).
4. Circuit breaker (states: closed, open, half-open; thresholds: failure
   rate, consecutive failures, latency threshold; cooldown; probe;
   per-agent and per-capability circuits).
5. Hedged requests (fan-out factor; cancellation via RFC-0011; first-
   response-wins; cost accounting for redundant work; when to hedge: tail
   latency threshold).
6. Routing table (per-agent, per-capability routing state; persistence;
   sharing routing state across agents).
7. Integration with discovery (how routing metrics feed back into discovery
   ranking; how circuit breaker state affects DHT query results).
8. Integration with circuit relay (RFC-0010): routing through relays when
   direct connection fails; relay-aware routing metrics.
9. Security considerations (metric poisoning, circuit breaker abuse,
   hedged request amplification as DoS).
10. Configuration (default thresholds; per-capability overrides; runtime
    tuning).

**Dependencies**: RFC-0004 (discovery), RFC-0013 (semantic capability
graphs for query results), RFC-0011 (cancellation for hedged requests),
RFC-0010 (circuit relay for fallback routing). RFC-0015 (Rate Limiting)
interacts with circuit breaker and hedging. RFC-0024 (Heartbeat & Liveness)
provides liveness signals for circuit breaker state.

---

### 4.5 RFC-0015: Rate Limiting & Resource Management

| Field | Value |
|-------|-------|
| **Number** | 0015 |
| **Title** | Rate Limiting & Resource Management |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0002 (frames), RFC-0005 (error codes, 7xxx resource category), RFC-0006 (extensions) |

**Summary**: AAFP v1 does not define any resource management: there is no
rate limiting, no quota system, no resource advertisement, and no mechanism
to prevent a single agent from exhausting another agent's resources. The
7xxx error code category (resource) is reserved in RFC-0005 but unused.

RFC-0015 defines a resource management layer for AAFP. It covers three
concerns:

1. **Rate limiting**: Per-agent, per-capability, and per-connection rate
   limits. Limits are advertised and enforced. Exceeding a limit returns a
   resource error (7xxx) with retry-after information.
2. **Resource advertisement**: Agents advertise their available resources
   (CPU, GPU, memory, bandwidth, concurrent request capacity) via
   AgentRecord extensions (RFC-0012). This implements the "Resource
   Discovery" class from RFC-0004 §2.4.
3. **Resource negotiation**: Before sending a resource-intensive request,
   a client may negotiate resource allocation with the server (reserve
   capacity, get a quota token, then send the request). This prevents
   wasted work on requests that would be rejected for insufficient
   resources.

**Key sections**:
1. Overview and relationship to RFC-0004 §2.4 (resource discovery) and
   RFC-0005 §3 (7xxx resource error category).
2. Rate limiting model (token bucket per agent/capability/connection;
   limit advertisement; enforcement; retry-after; 429-equivalent error
   code in 7xxx).
3. Resource advertisement (AgentRecord extension type under RFC-0012 key
   11; resource descriptors: CPU cores, GPU type and count, memory, 
   bandwidth, max concurrent requests; availability windows).
4. Resource negotiation protocol (RPC methods: `aafp.resource.reserve`,
   `aafp.resource.release`; quota tokens; reservation TTL; over-commit
   handling).
5. Backpressure (how rate limiting and resource exhaustion propagate as
   backpressure to upstream callers; relationship to QUIC flow control).
6. Error codes (allocations in the 7xxx resource category: rate limited,
   quota exceeded, resource unavailable, reservation expired, reservation
   rejected).
7. Integration with adaptive routing (RFC-0014): routing metrics include
   resource availability; circuit breaker opens on resource exhaustion.
8. Security considerations (rate limit evasion via multiple AgentIds,
   resource exhaustion attacks, reservation hoarding).
9. Fairness (per-agent fairness, weighted fair queuing, priority classes).

**Dependencies**: RFC-0002 (frames for rate limit and reservation RPC),
RFC-0005 (7xxx error codes), RFC-0006 (extension registration for resource
advertisement), RFC-0012 (AgentRecord extensions for resource data).
RFC-0014 (Adaptive Routing) consumes resource availability for routing.
RFC-0023 (Cost & Payment) builds on resource negotiation for paid
resources.

---

### 4.6 RFC-0016: Agent Lifecycle

| Field | Value |
|-------|-------|
| **Number** | 0016 |
| **Title** | Agent Lifecycle: Registration, Deregistration, Hibernation, and Migration |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0003 (AgentRecord, identity), RFC-0004 (discovery, announcement), RFC-0010 (circuit relay) |

**Summary**: AAFP v1 defines AgentRecord creation and announcement (RFC-0003,
RFC-0004) but does not define a complete agent lifecycle. Agents can
register (announce their AgentRecord) and their records expire (via
`expires_at`), but there is no formal deregistration, hibernation,
migration, or restart protocol. The real-world research document
`AGENT_LIFECYCLE.md` maps the implementation's APIs onto the full lifecycle
but this is not yet specified as a protocol.

RFC-0016 formalizes the agent lifecycle as a state machine with protocol-
level transitions:

1. **Registration**: An agent announces its AgentRecord to the discovery
   network (extends RFC-0004's `aafp.discovery.announce`).
2. **Active**: The agent is reachable and accepting requests.
3. **Hibernation**: The agent is temporarily unavailable (e.g., sleeping to
   save resources) but intends to return. The agent publishes a hibernation
   notice with an expected return time. Other agents do not remove the
   AgentRecord from their cache but mark it as hibernating.
4. **Migration**: The agent is moving to a new endpoint (new multiaddr,
   possibly new host). The agent publishes a migration notice with the new
   endpoint and a migration window. Connections are drained and re-
   established at the new endpoint.
5. **Deregistration**: The agent is permanently leaving the network. It
   publishes a deregistration notice (signed) that instructs other agents
   to remove its AgentRecord from their caches and DHT entries.
6. **Restart/Crash recovery**: After a crash, the agent re-registers with
   the same AgentId (same key pair) or a new AgentId (new key pair, with
   optional rotation statement).

**Key sections**:
1. Overview and lifecycle state machine (states: unregistered, registering,
   active, hibernating, migrating, deregistering, deregistered; transitions
   and triggers).
2. Registration protocol (extends `aafp.discovery.announce`; record
   validation; TTL and renewal; multi-bootstrap registration).
3. Deregistration protocol (signed deregistration notice; propagation;
   cache invalidation; DHT removal; graceful connection draining).
4. Hibernation protocol (hibernation notice with expected return time;
   hibernation duration limits; wake-up and re-registration; handling of
   in-flight requests).
5. Migration protocol (migration notice with new endpoint; migration
   window; connection draining and re-establishment; AgentRecord update;
   relay-aware migration for NAT'd agents).
6. Restart and crash recovery (re-registration with same or new AgentId;
   key rotation statement; stale record detection and cleanup).
7. Lifecycle events (event types: registered, active, hibernating,
   migrating, deregistered, crashed; event propagation via pubsub
   RFC-0009; subscription by other agents).
8. Integration with discovery (DHT entry lifecycle; record expiry vs.
   explicit deregistration; stale record cleanup).
9. Integration with circuit relay (RFC-0010): relay reservation lifecycle
   aligned with agent lifecycle; reservation cancellation on deregistration.
10. Security considerations (deregistration spoofing, migration MITM,
    hibernation hijacking, stale record attacks).

**Dependencies**: RFC-0003 (AgentRecord, identity, key rotation),
RFC-0004 (discovery, announcement), RFC-0009 (pubsub for lifecycle events),
RFC-0010 (circuit relay for NAT'd agent migration). RFC-0024 (Heartbeat &
Liveness) provides liveness signals that trigger lifecycle transitions
(crash detection). RFC-0017 (Federation) extends lifecycle across
organizational boundaries.

---

### 4.7 RFC-0017: Federation & Cross-Organization Trust

| Field | Value |
|-------|-------|
| **Number** | 0017 |
| **Title** | Federation & Cross-Organization Trust |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0003 (identity, UCAN, revocation), RFC-0004 (discovery, Sybil resistance), RFC-0016 (agent lifecycle) |

**Summary**: AAFP v1 uses a fully decentralized trust model with no trusted
third parties (RFC-0001 §9.0). All identity is self-attested; there is no
CA, no PKI, no revocation authority, and no reputation system. This is
appropriate for a v1 MVP but insufficient for production deployments across
organizational boundaries, where agents from different organizations need
to establish trust, verify each other's identity, and revoke compromised
identities.

RFC-0017 defines a federation layer for AAFP. A federation is a group of
agents that share a trust framework: a set of trust anchors (organization
root keys), a delegation model (how organizations delegate authority to
agents), and a revocation mechanism (how compromised identities are
revoked). Federations are optional: agents can participate in the open
AAFP network without joining any federation, and agents can join multiple
federations.

The RFC defines:

1. **Federation trust anchors**: Organization root keys (ML-DSA-65) that
   sign federation membership certificates. An agent's federation
   membership is attested by a certificate chain from the organization root
   to the agent's key.
2. **Cross-organization delegation**: UCAN (RFC-0003 §5.4) extended with
   federation-aware capability delegation. An agent in federation A can
   delegate a capability to an agent in federation B, with the delegation
   chain verifying membership in both federations.
3. **Revocation**: A revocation mechanism for AgentRecords and UCAN tokens.
   Revocation is published via a revocation list (distributed via pubsub
   RFC-0009 or a dedicated revocation DHT). Revocation can be issued by
   the agent itself (self-revocation) or by a federation authority.
4. **Reputation**: An optional reputation system where agents rate each
   other after interactions. Reputation scores are carried as AgentRecord
   extensions (RFC-0012) and aggregated by reputation services.
5. **Sybil resistance**: Federation membership requirements (proof of
   organization membership, invite-only federations) as a Sybil resistance
   mechanism for federated deployments.

**Key sections**:
1. Overview and relationship to RFC-0001 §9.0 (decentralized trust model)
   and §9.6 (security limitations: no revocation, no reputation, no Sybil
   resistance).
2. Federation model (federation definition; trust anchors; membership
   certificates; certificate chains; multi-federation membership).
3. Federation trust anchor schema (CBOR; signed by organization root key;
   includes federation ID, root public key, policies).
4. Membership certificates (chain from root to agent; UCAN-style
   delegation; expiry; revocation).
5. Cross-organization delegation (UCAN extension for federation-aware
   capabilities; verification across federation boundaries).
6. Revocation (revocation lists; revocation DHT; self-revocation;
   authority revocation; propagation via pubsub; revocation checking
   procedure).
7. Reputation (reputation model; score aggregation; reputation as
   AgentRecord extension; reputation services; Sybil resistance of
   reputation).
8. Sybil resistance mechanisms (federation membership; invite-only;
   proof-of-stake variants; trade-offs).
9. Federation discovery (how agents discover federation trust anchors;
   bootstrap nodes per federation; federation-aware DHT).
10. Security considerations (trust anchor compromise, revocation
    propagation delays, reputation gaming, federation exit attacks).

**Dependencies**: RFC-0003 (identity, UCAN, key rotation, revocation gap),
RFC-0004 (discovery, Sybil resistance gap), RFC-0009 (pubsub for
revocation propagation), RFC-0012 (AgentRecord extensions for reputation
and federation membership), RFC-0016 (agent lifecycle for membership
lifecycle). This is one of the most complex proposed RFCs and has the
most dependencies.

---

### 4.8 RFC-0018: Back-Channeling & Progress Events

| Field | Value |
|-------|-------|
| **Number** | 0018 |
| **Title** | Back-Channeling & Progress Events |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0002 (frames, streams), RFC-0011 (streaming RPC, cancellation) |

**Summary**: AAFP v1 supports request/response RPC (RFC-0002 §4.3–§4.4)
and will support streaming RPC (RFC-0011). However, neither pattern
provides a general back-channel mechanism: a way for the server to send
unsolicited messages to the client during a long-running request, outside
of the response stream. This is needed for:

- **Progress events**: The server reports progress (e.g., "50% done,
  ETA 30s") without sending a partial response.
- **Status updates**: The server reports status changes (e.g., "queued
  behind 3 requests", "resource reservation granted", "model loading").
- **Interactive prompts**: The server asks the client a question mid-
  request (e.g., "this operation costs 0.05 AAFP, approve?").
- **Cancellation from the server**: The server decides it cannot complete
  the request and cancels it (distinct from an error: the server may
  offer to redirect the client to another agent).

RFC-0018 defines a back-channel mechanism that uses the bidirectional
nature of QUIC streams. After a client sends an RPC_REQUEST on a stream,
the server may send PROGRESS frames (a new frame type or an extension of
the RPC_RESPONSE frame) on the same stream before the final response. The
client may also send messages back on the same stream (e.g., to answer an
interactive prompt or to acknowledge a progress event).

**Key sections**:
1. Overview and relationship to RFC-0002 (bidirectional streams) and
   RFC-0011 (streaming RPC).
2. Back-channel frame type (PROGRESS frame: CBOR-encoded progress event
   with type, message, data, and optional completion percentage; or
   extension of RPC_RESPONSE with a progress flag).
3. Progress event types (progress, status, prompt, redirect, cancellation).
4. Interactive prompts (server-to-client question; client response on the
   same stream; timeout and default behavior; approval/denial semantics).
5. Server-initiated cancellation (distinct from error; server offers
   redirect to another agent; client decides whether to follow redirect).
6. Back-channel multiplexing (multiple concurrent back-channels on
   different streams; correlation via stream ID and request ID).
7. Integration with streaming RPC (RFC-0011): progress events interleaved
   with streaming responses; ordering guarantees.
8. Integration with MCP and A2A bindings: how MCP progress notifications
   and A2A task status updates map to back-channel events.
9. Error handling (back-channel errors vs. request errors; back-channel
   frame on a non-existent stream).
10. Security considerations (back-channel injection, prompt spoofing,
    redirect to malicious agent).

**Dependencies**: RFC-0002 (bidirectional streams, frame types), RFC-0011
(streaming RPC, cancellation), RFC-0005 (error codes for back-channel
errors), RFC-0006 (frame type registration). RFC-0007 (MCP) and RFC-0008
(A2A) should be updated to reference RFC-0018 for progress notifications.

---

### 4.9 RFC-0019: GossipSub v1.1

| Field | Value |
|-------|-------|
| **Number** | 0019 |
| **Title** | GossipSub v1.1: Mesh-Based PubSub with Peer Scoring |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0009 (floodsub), RFC-0002 (RPC frames), RFC-0003 (identity) |

**Summary**: RFC-0009 implements floodsub, where published messages are
forwarded to all known peers subscribed to the same topic. Floodsub is
simple and sufficient for small networks (<100 peers) but does not scale:
message overhead is O(N) per publish, and the protocol is vulnerable to
amplification attacks.

RFC-0019 upgrades the pubsub protocol to GossipSub v1.1, a mesh-based
propagation protocol inspired by libp2p's gossipsub. In GossipSub, each
peer maintains a small mesh (a subset of subscribed peers) for each topic.
Messages are forwarded only to mesh peers. A control plane (IHAVE/IWANT
gossip) propagates message metadata so that peers can request missing
messages. This reduces per-publish overhead to O(mesh_size) with high
probability of full dissemination.

GossipSub v1.1 adds:

- **Peer scoring**: Each peer is scored based on its behavior (valid
  messages, invalid messages, app-specific scores, IP colocation, behavioral
  penalties). Low-scoring peers are ignored or disconnected.
- **PX (peer exchange)**: When a peer is disconnected (graft/prune),
  peers exchange lists of other peers to help maintain the mesh.
- **Topic authentication**: Optional topic authentication via signed
  messages or a topic authority, preventing unauthorized publishes.
- **Adaptive gossip**: Gossip is enabled when the mesh is healthy and
  disabled when the mesh is too small, falling back to floodsub behavior
  for resilience.

**Key sections**:
1. Overview and relationship to RFC-0009 (floodsub) and libp2p gossipsub
   v1.1.
2. Mesh management (mesh degree D; D_low, D_high; graft and prune
   operations; mesh maintenance heartbeat; peer selection).
3. Message propagation (forward to mesh peers; seen cache; message ID
   computation; deduplication).
4. Gossip control plane (IHAVE/IWANT messages; gossip interval; gossip
   fanout; piggybacking on other RPC messages).
5. Peer scoring (score components: P1 valid messages, P2 invalid messages,
   P3 app-specific, P4 IP colocation, P5 behavioral penalties; score
   thresholds: gossip_threshold, publish_threshold, graylist_threshold,
   accept_px_threshold; opportunistic grafting).
6. PX (peer exchange) (peer lists in prune messages; bootstrap via PX;
   PX throttling).
7. Topic authentication (signed topics; topic authority; message
   verification; subscription filtering).
8. Adaptive gossip (gossip enable/disable based on mesh health; floodsub
   fallback).
9. Wire format (CBOR-encoded control messages; relationship to RFC-0009
   wire format; backward compatibility with floodsub peers).
10. Security considerations (eclipse attacks on the mesh, peer score
    manipulation, sybil attacks, message injection, amplification).

**Dependencies**: RFC-0009 (floodsub, which this upgrades/obsoletes),
RFC-0002 (RPC frames), RFC-0003 (identity for peer scoring and topic
authentication). RFC-0017 (Federation) may define app-specific peer score
components. RFC-0016 (Agent Lifecycle) uses pubsub for lifecycle events
and benefits from gossipsub's scalability.

---

### 4.10 RFC-0020: WebSocket Transport Binding

| Field | Value |
|-------|-------|
| **Number** | 0020 |
| **Title** | WebSocket Transport Binding for Browser Compatibility |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track (binding) |
| **Dependencies** | RFC-0002 (framing, handshake), RFC-0003 (identity) |

**Summary**: AAFP v1 uses QUIC as its sole transport (RFC-0002 §2.1).
QUIC is not available in all environments — most notably, web browsers do
not expose raw QUIC sockets to JavaScript applications. Agents running in
a browser (e.g., a web-based agent UI, a browser extension agent) cannot
participate in the AAFP network without an alternative transport.

RFC-0020 defines a WebSocket transport binding for AAFP. AAFP frames
(RFC-0002 §3) are carried as WebSocket binary messages. The AAFP
handshake (RFC-0002 §5) is performed over the WebSocket connection after
the WebSocket upgrade. TLS is provided by the WebSocket's underlying TLS
(wss://), not by QUIC. Post-quantum key exchange is not available in
standard browser TLS implementations; the binding documents this
limitation and recommends that browser agents connect through a PQ-secure
gateway (an agent that terminates the WebSocket and proxies to QUIC with
X25519MLKEM768).

The binding preserves the AAFP frame format byte-for-byte: the same frame
header, frame types, and CBOR payloads are used. Only the transport
changes (WebSocket vs. QUIC). This ensures that all AAFP protocols (RPC,
pubsub, streaming, back-channeling) work identically over both transports.

**Key sections**:
1. Overview and motivation (browser compatibility; no QUIC in browsers;
   WebSocket as the universal browser transport).
2. Transport architecture (browser agent → WebSocket (wss://) → gateway
   agent → QUIC → AAFP network).
3. WebSocket upgrade (HTTP upgrade to WebSocket; ALPN not applicable;
   custom subprotocol `aafp/1`).
4. Frame carriage (AAFP frames as WebSocket binary messages; text messages
   unused; frame ordering within a WebSocket message stream).
5. Handshake over WebSocket (AAFP handshake on the WebSocket after
   upgrade; TLS channel binding via WebSocket TLS exporter; identity
   verification).
6. Stream multiplexing over WebSocket (QUIC streams do not exist over
   WebSocket; logical stream multiplexing via stream ID in the AAFP frame
   header; one WebSocket connection carries all streams).
7. Post-quantum limitations (browser TLS does not support
   X25519MLKEM768; gateway-based PQ security; hybrid mode; security
   trade-offs).
8. Gateway protocol (how a gateway agent bridges WebSocket to QUIC;
   gateway discovery; gateway authentication; trust model for the
   gateway).
9. Connection lifecycle (WebSocket close codes mapped to AAFP close
   codes; reconnection; idle timeout).
10. Security considerations (TLS downgrade attacks, gateway trust, CORS
    for browser agents, origin validation).

**Dependencies**: RFC-0002 (framing, handshake, stream multiplexing),
RFC-0003 (identity, handshake signatures). RFC-0010 (circuit relay) is
relevant to the gateway pattern. RFC-0021 (WebTransport) is a related
binding that may eventually supersede this one in browsers that support
WebTransport.

---

### 4.11 RFC-0021: WebTransport Transport Binding

| Field | Value |
|-------|-------|
| **Number** | 0021 |
| **Title** | WebTransport Transport Binding |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track (binding) |
| **Dependencies** | RFC-0002 (framing, handshake), RFC-0003 (identity) |

**Summary**: WebTransport (W3C WebTransport, IETF RFC 9220) is a modern
web API that provides bidirectional, multiplexed, low-latency communication
between web applications and servers. Unlike WebSocket, WebTransport is
built on HTTP/3, which is built on QUIC. This means WebTransport provides
native QUIC streams to the browser, making it a more natural fit for AAFP
than the WebSocket binding (RFC-0020).

RFC-0021 defines a WebTransport transport binding for AAFP. AAFP frames
are carried over WebTransport streams, with each AAFP logical stream
mapped to a WebTransport bidirectional stream. This preserves the stream
multiplexing semantics of the QUIC transport (RFC-0002) more faithfully
than the WebSocket binding (which multiplexes streams over a single
WebSocket message stream).

Because WebTransport uses HTTP/3 over QUIC, the TLS layer can support
post-quantum key exchange (X25519MLKEM768) if the browser and server
support it. This eliminates the PQ limitation of the WebSocket binding
(RFC-0020), though browser support for PQ TLS is still evolving.

**Key sections**:
1. Overview and motivation (WebTransport as a QUIC-native browser
   transport; comparison with WebSocket binding RFC-0020).
2. Transport architecture (browser agent → WebTransport (HTTP/3) →
   AAFP server; no gateway needed if the server supports WebTransport
   directly).
3. WebTransport session establishment (HTTP/3 CONNECT; session
   negotiation; AAFP ALPN over WebTransport).
4. Frame carriage (AAFP frames over WebTransport bidirectional streams;
   one AAFP stream per WebTransport stream; unidirectional streams for
   server-to-client or client-to-server only).
5. Handshake over WebTransport (AAFP handshake on the first
   bidirectional stream; TLS channel binding via WebTransport TLS
   exporter; identity verification).
6. Stream multiplexing (native WebTransport streams; stream ID mapping;
   flow control).
7. Post-quantum security (PQ TLS via HTTP/3; browser support status;
   fallback to classical TLS with gateway-based PQ).
8. Connection lifecycle (WebTransport session close; draining; idle
   timeout; reconnection).
9. Comparison with WebSocket binding (RFC-0020): when to use each;
   migration path from WebSocket to WebTransport.
10. Security considerations (WebTransport origin validation, session
    isolation, PQ TLS availability).

**Dependencies**: RFC-0002 (framing, handshake, stream multiplexing),
RFC-0003 (identity). RFC-0020 (WebSocket binding) is a related binding;
the two share design patterns. RFC-0010 (circuit relay) is relevant if
WebTransport agents are behind NAT.

---

### 4.12 RFC-0022: Agent Registry API

| Field | Value |
|-------|-------|
| **Number** | 0022 |
| **Title** | Agent Registry API |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0004 (discovery, DHT), RFC-0003 (AgentRecord), RFC-0012 (extensions), RFC-0013 (semantic capabilities) |

**Summary**: RFC-0004 defines the discovery protocol (bootstrap, peer
exchange, capability DHT) but does not define a higher-level registry API.
Agents interact with discovery via low-level RPC methods
(`aafp.discovery.announce`, `aafp.discovery.lookup`). There is no unified
API for registering, querying, updating, and managing agent records that
also incorporates semantic capability queries (RFC-0013), resource
advertisements (RFC-0015), and lifecycle events (RFC-0016).

RFC-0022 defines an Agent Registry API: a higher-level interface that
unifies discovery, semantic capability query, resource advertisement, and
lifecycle management into a coherent API. The registry API is exposed both
as a programmatic API (for SDK consumers) and as a set of RPC methods (for
networked access). The registry can be local (each agent maintains its own
registry view) or delegated (a registry service agent maintains the
registry on behalf of other agents).

**Key sections**:
1. Overview and relationship to RFC-0004 (discovery), RFC-0013 (semantic
   capabilities), RFC-0015 (resource advertisement), and RFC-0016 (agent
   lifecycle).
2. Registry API surface (register, deregister, query, update, watch,
   get-by-id, get-by-capability, get-by-semantic-query).
3. RPC methods (`aafp.registry.register`, `aafp.registry.deregister`,
   `aafp.registry.query`, `aafp.registry.update`, `aafp.registry.watch`,
   `aafp.registry.get`).
4. Query language (relationship to RFC-0013 semantic capability query
   syntax; registry query as a superset including lifecycle state,
   resource availability, and federation membership).
5. Watch API (subscribe to registry changes: registration, deregistration,
   capability update, lifecycle transition; via pubsub RFC-0009 or
   streaming RPC RFC-0011).
6. Caching and consistency (local cache; cache invalidation; staleness
   bounds; eventual consistency; strong consistency for delegated
   registries).
7. Delegated registry (registry service agent; trust model; replication;
   failover; relationship to federation RFC-0017).
8. Registry access control (who can register, query, watch; UCAN-based
   authorization; federation-restricted registries).
9. Performance (query latency; cache hit rate; indexing strategies;
   sharding for large registries).
10. Security considerations (registry poisoning, unauthorized registration,
    query surveillance, delegated registry compromise).

**Dependencies**: RFC-0004 (discovery, DHT), RFC-0003 (AgentRecord),
RFC-0009 (pubsub for watch API), RFC-0011 (streaming RPC for watch API),
RFC-0012 (AgentRecord extensions), RFC-0013 (semantic capability queries),
RFC-0015 (resource advertisement), RFC-0016 (agent lifecycle events),
RFC-0017 (federation for access control). This RFC unifies several
proposed RFCs into a coherent API and therefore depends on most of them.

---

### 4.13 RFC-0023: Cost & Payment Protocol

| Field | Value |
|-------|-------|
| **Number** | 0023 |
| **Title** | Cost & Payment Protocol |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0003 (identity, UCAN), RFC-0012 (AgentRecord extensions), RFC-0015 (resource management), RFC-0018 (back-channeling) |

**Summary**: RFC-0001 §1.3 explicitly lists payment and settlement as out
of scope for v1: "Financial transactions between agents are out of scope."
However, real-world agent networks will require a cost and payment
mechanism: agents that provide valuable capabilities (inference, tool use,
data access) will want to charge for their services, and agents that
consume those capabilities will need to pay.

RFC-0023 defines a cost and payment protocol for AAFP. It covers:

1. **Cost advertisement**: Agents advertise their pricing (per-request,
   per-token, per-second, per-byte) via AgentRecord extensions (RFC-0012)
   and semantic capability attributes (RFC-0013).
2. **Cost negotiation**: Before a request, the client and server negotiate
   cost. The server quotes a price (via a back-channel prompt, RFC-0018);
   the client approves or rejects. This supports both fixed pricing and
   dynamic pricing (auction-based, negotiation-based).
3. **Payment protocol**: A protocol for transferring payment between
   agents. The RFC does not mandate a specific payment system; it defines
   a payment interface that can be backed by cryptocurrency (e.g., a
   payment channel), fiat (e.g., an invoice and settlement service), or
   credit (e.g., a prepaid balance managed by a registry service).
4. **Payment verification**: The server verifies that payment was received
   before or after providing the service. The RFC defines pre-paid (payment
   before service) and post-paid (payment after service, with escrow)
   models.
5. **Dispute resolution**: A mechanism for disputing payments (e.g.,
   service not rendered, quality not as advertised). Disputes are
   resolved by a dispute resolution service (which may be a federation
   authority, RFC-0017).

**Key sections**:
1. Overview and relationship to RFC-0001 §1.3 (payment as a non-goal for
   v1) and the real-world research on cost and payment.
2. Cost model (pricing dimensions: per-request, per-token, per-second,
   per-byte; pricing units; dynamic pricing; tiered pricing; subscription
   models).
3. Cost advertisement (AgentRecord extension type under RFC-0012;
   semantic capability attribute under RFC-0013; pricing update
   frequency).
4. Cost negotiation protocol (quote request via back-channel RFC-0018;
   quote response; approval/rejection; timeout; binding vs. non-binding
   quotes).
5. Payment interface (abstract payment provider trait; payment methods:
   cryptocurrency payment channel, fiat invoice, prepaid credit;
   payment token format; payment verification).
6. Pre-paid model (client pays before service; payment token included in
   RPC request; server verifies token before processing).
7. Post-paid model with escrow (client commits payment to escrow before
   service; server provides service; escrow releases payment on
   confirmation; dispute window).
8. Payment channels (for cryptocurrency: off-chain payment channels;
   channel establishment; channel state; channel close; relationship to
   AAFP connections).
9. Dispute resolution (dispute filing; evidence; resolution service;
   refund; penalty; relationship to federation RFC-0017).
10. Error codes (allocations in the 9xxx application category for payment
    errors: insufficient funds, payment rejected, escrow dispute,
    payment expired).
11. Security considerations (payment fraud, double spending, escrow
    compromise, cost advertisement spoofing, payment channel disputes).

**Dependencies**: RFC-0003 (identity, UCAN for payment authorization),
RFC-0012 (AgentRecord extensions for cost advertisement), RFC-0013
(semantic capability attributes for pricing), RFC-0015 (resource
management for resource-backed pricing), RFC-0018 (back-channeling for
cost negotiation). RFC-0017 (Federation) for dispute resolution
authorities. RFC-0014 (Adaptive Routing) for cost-aware routing. This is
the most application-layer of the proposed RFCs and has the most complex
dependencies.

---

### 4.14 RFC-0024: Heartbeat & Liveness

| Field | Value |
|-------|-------|
| **Number** | 0024 |
| **Title** | Heartbeat & Liveness |
| **Status** | Proposed (not yet drafted) |
| **Type** | Standards Track |
| **Dependencies** | RFC-0002 (PING/PONG frames), RFC-0005 (error codes), RFC-0016 (agent lifecycle) |

**Summary**: RFC-0002 §4.7–§4.8 define PING and PONG frames for
application-layer keepalive. However, the specification is minimal: it
defines the frame format and the requirement that a PONG must be sent in
response to a PING, but it does not define a complete liveness protocol:
heartbeat intervals, timeout thresholds, liveness state machine, failure
detection, and integration with agent lifecycle (RFC-0016) and circuit
breaker (RFC-0014).

RFC-0024 formalizes the heartbeat and liveness protocol. It defines:

1. **Heartbeat protocol**: Configurable heartbeat interval and timeout.
   The client sends PING frames at the configured interval; if a PONG is
   not received within the timeout, the connection is considered dead.
2. **Liveness state machine**: Each connection has a liveness state
   (alive, suspected, dead). Transitions are triggered by heartbeat
   results.
3. **Failure detection**: When a connection is detected as dead, the
   implementation closes the QUIC connection, notifies the agent
   lifecycle (RFC-0016) that the peer may have crashed, and triggers
   circuit breaker state (RFC-0014).
4. **Adaptive heartbeats**: The heartbeat interval may be adaptive based
   on network conditions (RTT, jitter) and application requirements (idle
   timeout, session resumption).
5. **Liveness probes**: A higher-level liveness probe that checks not
   just transport connectivity but also application-level responsiveness
   (the agent is connected and responding to RPC requests, not just
   PONG frames).
6. **Liveness advertisement**: Agents advertise their heartbeat policy
   (expected interval, timeout) in the handshake or via AgentRecord
   extensions, so peers know when to expect heartbeats and when to
   declare the connection dead.

**Key sections**:
1. Overview and relationship to RFC-0002 §4.7–§4.8 (PING/PONG) and
   RFC-0001 §9.6 item 6 (session resumption deferred).
2. Heartbeat protocol (interval, timeout, jitter; PING on stream 0;
   PONG response; missed PONG handling; configurable parameters).
3. Liveness state machine (alive → suspected → dead; transitions;
   timers; recovery from suspected to alive).
4. Failure detection (dead connection handling; QUIC connection close;
   notification to agent lifecycle RFC-0016; circuit breaker trigger
   RFC-0014).
5. Adaptive heartbeats (RTT-based interval adjustment; idle detection;
   application-driven heartbeat frequency; minimum and maximum bounds).
6. Application-level liveness probes (RPC-based probe: send a lightweight
   RPC request and expect a response; distinguish transport liveness
   from application liveness; probe method `aafp.liveness.probe`).
7. Liveness advertisement (heartbeat policy in handshake or AgentRecord
   extension; peer expectations; policy negotiation).
8. Integration with QUIC keepalive (QUIC's own keepalive vs. AAFP
   heartbeat; when to use each; interaction with idle timeout).
9. Integration with circuit relay (RFC-0010): heartbeat over relayed
   connections; relay liveness vs. end-to-end liveness.
10. Error codes (allocations in the 1xxx transport category for liveness
    errors: heartbeat timeout, liveness probe failed, connection
    declared dead).
11. Security considerations (heartbeat amplification, liveness spoofing,
    false dead declaration, heartbeat-based traffic analysis).

**Dependencies**: RFC-0002 (PING/PONG frames, stream 0), RFC-0005 (error
codes), RFC-0014 (circuit breaker integration), RFC-0016 (agent lifecycle
integration), RFC-0010 (circuit relay liveness). RFC-0024 is relatively
self-contained but integrates with several other proposed RFCs.

---

## 5. Dependency Graph

The following graph shows the dependencies between existing RFCs (0001–0010)
and proposed RFCs (0011–0024). An arrow from A to B means "A depends on B"
(B must be finalized before A, or B provides primitives that A uses).

```
Existing RFCs (foundational):

  RFC-0001 (Overview)
    ├── RFC-0002 (Framing)
    │     ├── RFC-0003 (Identity)
    │     │     ├── RFC-0004 (Discovery)
    │     │     ├── RFC-0005 (Errors)
    │     │     └── RFC-0006 (Versioning)
    │     ├── RFC-0007 (MCP Binding) [Implemented]
    │     ├── RFC-0008 (A2A Binding) [Implemented]
    │     ├── RFC-0009 (PubSub) [Experimental]
    │     │     └── RFC-0010 (Circuit Relay) [Experimental]
    │     └── RFC-0011 (Streaming RPC) ← proposed
    │           └── RFC-0018 (Back-Channeling) ← proposed
    ├── RFC-0012 (AgentRecord Extensions) ← proposed
    │     ├── RFC-0013 (Semantic Capability Graphs) ← proposed
    │     │     └── RFC-0014 (Adaptive Routing) ← proposed
    │     ├── RFC-0015 (Rate Limiting & Resources) ← proposed
    │     │     └── RFC-0023 (Cost & Payment) ← proposed
    │     └── RFC-0017 (Federation & Trust) ← proposed
    ├── RFC-0016 (Agent Lifecycle) ← proposed
    │     └── RFC-0017 (Federation & Trust) ← proposed
    ├── RFC-0019 (GossipSub v1.1) ← proposed
    ├── RFC-0020 (WebSocket Binding) ← proposed
    ├── RFC-0021 (WebTransport Binding) ← proposed
    ├── RFC-0022 (Agent Registry API) ← proposed
    │     (depends on 0004, 0009, 0011, 0012, 0013, 0015, 0016, 0017)
    └── RFC-0024 (Heartbeat & Liveness) ← proposed
          (depends on 0002, 0010, 0014, 0016)
```

### 5.1 Implementation Priority

Based on the dependency graph, the following implementation priority is
recommended:

**Tier 1 (no dependencies on proposed RFCs; can start immediately)**:
- RFC-0011 (Streaming RPC) — depends only on existing RFC-0002, RFC-0005.
- RFC-0012 (AgentRecord Extensions) — depends only on existing RFC-0003,
  RFC-0006.
- RFC-0019 (GossipSub v1.1) — depends only on existing RFC-0009.
- RFC-0020 (WebSocket Binding) — depends only on existing RFC-0002,
  RFC-0003.
- RFC-0021 (WebTransport Binding) — depends only on existing RFC-0002,
  RFC-0003.
- RFC-0024 (Heartbeat & Liveness) — depends on RFC-0002 (existing) and
  RFC-0014, RFC-0016 (proposed), but the core heartbeat protocol can be
  specified independently.

**Tier 2 (depends on Tier 1)**:
- RFC-0013 (Semantic Capability Graphs) — depends on RFC-0012.
- RFC-0016 (Agent Lifecycle) — depends on existing RFCs; core lifecycle
  can proceed without federation.
- RFC-0018 (Back-Channeling) — depends on RFC-0011.

**Tier 3 (depends on Tier 2)**:
- RFC-0014 (Adaptive Routing) — depends on RFC-0013.
- RFC-0015 (Rate Limiting & Resources) — depends on RFC-0012.
- RFC-0017 (Federation & Trust) — depends on RFC-0012, RFC-0016.

**Tier 4 (depends on Tier 3)**:
- RFC-0022 (Agent Registry API) — depends on RFC-0011, RFC-0012, RFC-0013,
  RFC-0015, RFC-0016, RFC-0017.
- RFC-0023 (Cost & Payment) — depends on RFC-0012, RFC-0013, RFC-0015,
  RFC-0018.

---

## 6. RFC Status Legend

| Status | Meaning |
|--------|---------|
| **Proposed** | Reserved in this roadmap; not yet drafted. Number may change. |
| **Draft** | Initial text circulated; structure may change significantly. |
| **Review** | Stable enough for detailed review; amendments filed separately. |
| **Last Call** | Final comment window (default 14 days); editorial changes only. |
| **Final** | Normative; no further substantive changes without a new revision. |
| **Implemented** | Reference implementation exists and conforms. |
| **Experimental** | Not on standards track; for research; conformance not required. |
| **Informational** | Documents architecture or guidance; no normative wire format. |
| **Obsolete** | Superseded by a successor RFC. |

Current status of all RFCs in the AAFP series:

| RFC | Title | Status |
|-----|-------|--------|
| 0001 | Protocol Overview | Release Candidate (Rev 6) |
| 0002 | Transport & Framing | Release Candidate (Rev 6) |
| 0003 | Identity & Authentication | Release Candidate (Rev 6) |
| 0004 | Discovery | Release Candidate (Rev 6) |
| 0005 | Error Model | Release Candidate (Rev 6) |
| 0006 | Versioning & Compatibility | Release Candidate (Rev 6) |
| 0007 | MCP Transport Binding | Implemented |
| 0008 | A2A Transport Binding | Implemented |
| 0009 | PubSub | Experimental |
| 0010 | Circuit Relay | Experimental |
| 0011 | Streaming RPC | Proposed |
| 0012 | AgentRecord Extensions | Proposed |
| 0013 | Semantic Capability Graphs | Proposed |
| 0014 | Adaptive Routing | Proposed |
| 0015 | Rate Limiting & Resource Management | Proposed |
| 0016 | Agent Lifecycle | Proposed |
| 0017 | Federation & Cross-Organization Trust | Proposed |
| 0018 | Back-Channeling & Progress Events | Proposed |
| 0019 | GossipSub v1.1 | Proposed |
| 0020 | WebSocket Transport Binding | Proposed |
| 0021 | WebTransport Transport Binding | Proposed |
| 0022 | Agent Registry API | Proposed |
| 0023 | Cost & Payment Protocol | Proposed |
| 0024 | Heartbeat & Liveness | Proposed |

---

## 7. Open Questions

The following open questions should be resolved before the proposed RFCs
are drafted:

1. **RFC-0011 (Streaming RPC)**: Should cancellation use a new CANCEL
   frame type (requiring a frame type allocation in RFC-0006) or an RPC
   method on the same stream? A new frame type is cleaner but requires
   updating RFC-0006's frame type registry. An RPC method is simpler but
   overloads the RPC semantics.

2. **RFC-0012 (AgentRecord Extensions)**: Should the extension map at key
   11 use integer keys (registered per RFC-0006) or string keys (with
   reverse-DNS namespaces)? Integer keys are more compact and consistent
   with the rest of the AgentRecord schema; string keys provide
   namespace isolation without a registry. A hybrid approach (integer
   keys for registered extensions, string keys for private extensions)
   is possible but adds complexity.

3. **RFC-0013 (Semantic Capability Graphs)**: Should the query syntax be
   CBOR-encoded (consistent with the wire format) or use a string-based
   query language (easier for humans and debugging)? CBOR is more
   structured but harder to author; a string query language is more
   ergonomic but requires parsing and is harder to validate.

4. **RFC-0015 (Rate Limiting)**: Should rate limits be enforced at the
   transport layer (QUIC-level, per-connection) or the application layer
   (per-agent, per-capability)? Transport-layer enforcement is simpler
   but coarser; application-layer enforcement is more flexible but
   requires protocol-level support.

5. **RFC-0017 (Federation)**: Should federation trust anchors be
   hardcoded into agent configurations or discovered dynamically? Hard-
   coding is simpler and more secure but does not scale; dynamic
   discovery enables organic federation growth but is vulnerable to
   trust anchor spoofing.

6. **RFC-0019 (GossipSub v1.1)**: Should RFC-0019 obsolete RFC-0009
   (floodsub) or extend it? Obsoleting is cleaner but breaks existing
   floodsub implementations; extending preserves backward compatibility
   but requires both protocols to be supported.

7. **RFC-0020 vs. RFC-0021 (WebSocket vs. WebTransport)**: Should both
   bindings be specified, or should the project focus on WebTransport
   (which is QUIC-native and more future-proof)? WebSocket has broader
   browser support today; WebTransport is better aligned with AAFP's
   QUIC architecture but has limited browser support.

8. **RFC-0023 (Cost & Payment)**: Should the payment protocol mandate a
   specific payment system (e.g., a specific cryptocurrency) or define
   only the abstract interface? Mandating a specific system provides
   interoperability but reduces flexibility; an abstract interface allows
   multiple backends but risks fragmentation.

9. **Versioning**: Do any of the proposed RFCs require a new protocol
   version (v2), or can they all be accommodated within v1 via the
   extension mechanism (RFC-0006)? Most proposed RFCs use extensions and
   new frame types that fit within v1. However, RFC-0012 (AgentRecord
   Extensions) adds a new field to AgentRecord (key 11), which is within
   the v1 forward-compatibility clause (RFC-0003 §3.7). A v2 may be
   needed if any proposed RFC changes the frame header or handshake
   format.

10. **Sequencing**: Should the proposed RFCs be drafted and finalized in
    the tier order suggested in §5.1, or should they be prioritized by
    deployment demand? Tier ordering respects dependencies but may not
    match real-world urgency (e.g., federation and payment may be more
    urgent for production deployments than semantic capability graphs).

---

*End of document.*
