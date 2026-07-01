# Deliverable 10: Interoperability Design

```
Deliverable:    10 of 12
Title:          Interoperability Design
Status:         Complete
Date:           2026-07-01
Source:         Phase 15 (Interoperability Experiments)
```

## Interop Experiment 1: A2A-over-AAFP

**Goal**: Run A2A task delegation over AAFP's PQ QUIC transport.

**Architecture**:
```
A2A Application Layer (tasks, Agent Cards)
    ↓
A2A-over-AAFP Binding (JSON-RPC → CBOR frames)
    ↓
AAFP Session (ML-DSA-65, UCAN, ReplayCache)
    ↓
AAFP QUIC Transport (X25519MLKEM768, QUIC streams)
```

**Message Mapping**:
- `message/send` → AAFP RpcRequest with method="a2a.message/send"
- `message/streamSend` (SSE) → RpcRequest + QUIC stream for events
- `tasks/get`, `tasks/cancel` → AAFP RpcRequest
- `tasks/subscribe` (SSE) → RpcRequest + QUIC stream

**Identity Mapping**:
- A2A Agent Card → AAFP AgentRecord (capabilities, endpoints)
- A2A JWS signature → AAFP ML-DSA-65 signature
- A2A OAuth scopes → AAFP UCAN capabilities

**Extension**: `aafp:a2a-bridge:1`

## Interop Experiment 2: MCP-over-AAFP

**Goal**: Run MCP tool invocation over AAFP's PQ QUIC transport.

**Architecture**:
```
MCP Application Layer (tools, resources, prompts)
    ↓
MCP-over-AAFP Transport (JSON-RPC → CBOR frames)
    ↓
AAFP Session (ML-DSA-65, UCAN replaces OAuth)
    ↓
AAFP QUIC Transport
```

**Authorization Mapping**:
- OAuth `scope: "tools:read"` → UCAN `Capability {resource: "mcp.tools", action: "read"}`
- OAuth token → UCAN capability chain
- Token introspection → UCAN chain verification

**Stateless MCP over Stateful AAFP**:
- AAFP session replaces per-request metadata
- Session established once; MCP operations flow within it
- For serverless: short-lived sessions (handshake, one op, close)

**Extension**: `aafp:mcp-transport:1`

## Interop Experiment 3: AAFP + AgentMesh

**Goal**: AAFP as transport for AgentMesh governance platform.

**Integration Points**:
1. Identity: `did:mesh` → `did:aafp` mapping
2. Authorization: AgentMeshAdapter implements AAFP's AuthorizationProvider
3. Transport: WebSocket relay → AAFP QUIC
4. Audit: AAFP session events → AgentMesh Merkle chain

## Interop Experiment 4: Identity Federation

**Goal**: Enterprise IdP (Okta/AD) integration via OIDC-to-UCAN bridge.

**Flow**:
1. Agent gets OIDC token from enterprise IdP
2. AAFP Identity Bridge verifies OIDC token
3. Bridge issues UCAN binding OIDC identity to AgentId
4. Agent presents UCAN in AAFP session
5. Server verifies UCAN + trusts bridge

## Implementation Priority

| Experiment | Priority | Effort |
|-----------|----------|--------|
| A2A-over-AAFP | P1 | High |
| MCP-over-AAFP | P1 | High |
| AgentMesh integration | P2 | High |
| Identity federation | P2 | Medium |
