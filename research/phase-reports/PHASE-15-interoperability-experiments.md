# Phase 15: Interoperability Experiments

```
Phase:          15 of 16
Title:          Interoperability Experiments
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Define concrete interoperability experiments for AAFP with the broader
agent ecosystem. Design the A2A-over-AAFP binding, MCP-over-AAFP
transport, and identity mapping specifications. These are not
implementations but architectural designs ready for implementation.

## 2. Experiment 1: A2A-over-AAFP Binding

### 2.1 Goal

Run A2A protocol (task delegation, Agent Cards) over AAFP's QUIC
transport with PQ security, instead of over HTTP/TLS.

### 2.2 Architecture

```
┌───────────────────────────────────────────────────┐
│  A2A Application Layer                             │
│  - Task lifecycle (8 states)                       │
│  - Agent Card discovery                            │
│  - Skills and capabilities                         │
├───────────────────────────────────────────────────┤
│  A2A-over-AAFP Binding                             │
│  - Maps A2A JSON-RPC to AAFP CBOR frames           │
│  - Maps A2A Agent Card to AAFP AgentRecord         │
│  - Maps A2A task states to AAFP session            │
├───────────────────────────────────────────────────┤
│  AAFP Session Layer                                │
│  - ML-DSA-65 handshake                             │
│  - UCAN authorization                              │
│  - Replay protection                               │
│  - CLOSE state machine                             │
├───────────────────────────────────────────────────┤
│  AAFP QUIC Transport                               │
│  - X25519MLKEM768 PQ KEX                           │
│  - QUIC stream multiplexing                        │
│  - 0-RTT resumption                                │
└───────────────────────────────────────────────────┘
```

### 2.3 Message Mapping

| A2A Operation | AAFP Frame | Mapping |
|---------------|-----------|---------|
| `message/send` (JSON-RPC) | RpcRequest (CBOR) | method="a2a.message/send", params=CBOR-encoded A2A Message |
| `message/streamSend` (SSE) | RpcRequest + QUIC stream | method="a2a.message/streamSend", response on separate QUIC stream |
| `tasks/get` | RpcRequest | method="a2a.tasks/get" |
| `tasks/cancel` | RpcRequest | method="a2a.tasks/cancel" |
| `tasks/subscribe` (SSE) | RpcRequest + QUIC stream | method="a2a.tasks/subscribe", events on separate stream |
| `tasks/pushNotification` | RpcRequest | method="a2a.tasks/pushNotification" |

### 2.4 Agent Card to AgentRecord Mapping

| A2A Agent Card Field | AAFP AgentRecord Field | Mapping |
|----------------------|----------------------|---------|
| `name` | (not in AgentRecord) | Add as extension or metadata |
| `description` | (not in AgentRecord) | Add as extension or metadata |
| `supportedInterfaces` | `endpoints` | AAFP endpoint = QUIC multiaddr |
| `provider` | (not in AgentRecord) | Add as extension |
| `version` | `record_version` | Different semantics (record version vs agent version) |
| `capabilities` | `capabilities` | Map A2A capabilities to AAFP CapabilityDescriptors |
| `skills` | `capabilities` | Map A2A skills to AAFP capabilities |
| `securitySchemes` | (not needed) | AAFP uses ML-DSA-65, not OAuth |
| `signatures` (JWS) | `signature` (ML-DSA-65) | Replace JWS with ML-DSA-65 |
| `defaultInputModes` | (not in AgentRecord) | Add as extension |
| `defaultOutputModes` | (not in AgentRecord) | Add as extension |

### 2.5 Identity Mapping

```
A2A Agent Card URL: https://agent.example.com/.well-known/agent-card.json
        ↓
AAFP AgentRecord: agent_id = SHA-256(ML-DSA-65 public key)
        ↓
Mapping: Agent Card contains AAFP endpoint + AgentId
         AgentRecord contains AAFP endpoint + capabilities
```

**Resolution flow**:
1. A2A client fetches Agent Card from well-known URI
2. Agent Card contains `supportedInterfaces` with AAFP binding
3. Client extracts AAFP endpoint and AgentId from Agent Card
4. Client connects via AAFP QUIC transport
5. AAFP handshake verifies AgentId == SHA-256(public_key)
6. A2A messages flow over AAFP session

### 2.6 Streaming Mapping

A2A uses SSE for streaming. AAFP uses QUIC streams.

| A2A SSE | AAFP QUIC Stream |
|---------|-----------------|
| HTTP response with `Content-Type: text/event-stream` | QUIC bidirectional stream |
| `data: {json}\n\n` events | RpcResponse frames on stream |
| Client closes by closing HTTP connection | Client closes by CLOSE frame |
| Server-side push | Server sends frames on stream |

**Advantage**: QUIC streams provide bidirectional streaming (client can
send messages while receiving events), while SSE is server-to-client
only.

### 2.7 Extension Declaration

The A2A-over-AAFP binding is declared as an AAFP extension:

```cbor
ClientHello.extensions = [
    {1: "aafp:a2a-bridge:1", 2: {1: "1.0.1"}}  // A2A version
]
```

If server supports the binding, it includes it in ServerHello. If not,
client falls back to A2A-over-HTTP.

## 3. Experiment 2: MCP-over-AAFP Transport

### 3.1 Goal

Run MCP protocol (tool invocation, resources, prompts) over AAFP's
QUIC transport with PQ security, instead of over stdio or HTTP.

### 3.2 Architecture

```
┌───────────────────────────────────────────────────┐
│  MCP Application Layer                             │
│  - Tools, Resources, Prompts                       │
│  - Sampling, Roots, Elicitation                    │
│  - Capability negotiation                          │
├───────────────────────────────────────────────────┤
│  MCP-over-AAFP Transport                           │
│  - Maps MCP JSON-RPC to AAFP CBOR frames           │
│  - Maps MCP capabilities to AAFP extensions        │
│  - Maps MCP session to AAFP session                │
├───────────────────────────────────────────────────┤
│  AAFP Session Layer                                │
│  - ML-DSA-65 handshake                             │
│  - UCAN authorization (replaces OAuth)             │
│  - Replay protection                               │
├───────────────────────────────────────────────────┤
│  AAFP QUIC Transport                               │
│  - X25519MLKEM768 PQ KEX                           │
│  - QUIC stream multiplexing                        │
└───────────────────────────────────────────────────┘
```

### 3.3 Message Mapping

| MCP Operation | AAFP Frame | Mapping |
|---------------|-----------|---------|
| `initialize` | RpcRequest | method="mcp.initialize", params=CBOR MCP init params |
| `tools/list` | RpcRequest | method="mcp.tools/list" |
| `tools/call` | RpcRequest | method="mcp.tools/call", params=CBOR tool call |
| `resources/read` | RpcRequest | method="mcp.resources/read" |
| `prompts/get` | RpcRequest | method="mcp.prompts/get" |
| `sampling/createMessage` | RpcRequest | method="mcp.sampling/createMessage" |
| Notifications | AAFP notification (no response) | One-way frame |

### 3.4 Authorization Mapping

MCP uses OAuth 2.1. AAFP uses UCAN. The mapping:

| MCP OAuth | AAFP UCAN |
|-----------|-----------|
| OAuth access token | UCAN capability chain |
| `scope: "tools:read"` | `Capability {resource: "mcp.tools", action: "read"}` |
| `scope: "tools:write"` | `Capability {resource: "mcp.tools", action: "write"}` |
| Token expiry | UCAN `expires_at` |
| Token introspection | UCAN chain verification |
| Resource indicator (RFC 8707) | AgentId (target agent) |

**Flow**:
1. MCP client connects via AAFP
2. AAFP handshake authenticates both parties (ML-DSA-65)
3. Client presents UCAN token with MCP capabilities
4. Server verifies UCAN chain
5. MCP operations are authorized against UCAN capabilities

### 3.5 Stateless MCP over Stateful AAFP

MCP is moving toward stateless (SEP-2575). AAFP is stateful. The
mapping:

| MCP Stateless | AAFP Stateful |
|---------------|---------------|
| Per-request metadata (`_meta`) | Session state (negotiated once) |
| Per-request capabilities | Session capabilities |
| Per-request protocol version | Session protocol version |
| No session ID | AAFP session ID |

**Approach**: AAFP session replaces MCP's per-request metadata. The
session is established once; MCP operations flow within it. This is
more efficient (no repeated metadata) but requires the server to
maintain session state.

**For serverless MCP**: AAFP session is short-lived (handshake, one
operation, close). This approximates stateless behavior while still
getting PQ security.

## 4. Experiment 3: AAFP + AgentMesh Integration

### 4.1 Goal

Use AAFP as the transport layer for AgentMesh's governance platform.
AgentMesh provides trust scoring, policy enforcement, and audit logging;
AAFP provides PQ secure transport.

### 4.2 Architecture

```
┌───────────────────────────────────────────────────┐
│  AgentMesh Governance Layer                        │
│  - Trust scoring (0-1000)                          │
│  - Policy enforcement (OPA/Cedar)                  │
│  - Human sponsor management                        │
│  - Audit logging (Merkle chain)                    │
│  - Circuit breakers                                │
├───────────────────────────────────────────────────┤
│  AgentMesh IATP over AAFP                          │
│  - IATP challenge-response over AAFP session       │
│  - Trust score checked during AAFP authorization   │
│  - Policy decisions enforced by AAFP AuthorizationProvider │
├───────────────────────────────────────────────────┤
│  AAFP Session Layer                                │
│  - ML-DSA-65 handshake                             │
│  - UCAN authorization + trust score check          │
│  - Replay protection                               │
├───────────────────────────────────────────────────┤
│  AAFP QUIC Transport                               │
│  - PQ KEX, QUIC streams                            │
└───────────────────────────────────────────────────┘
```

### 4.3 Integration Points

1. **Identity**: AgentMesh DID (`did:mesh:...`) mapped to AAFP AgentId
   via `did:aafp` DID method (Phase 6 recommendation)

2. **Authorization**: AAFP's `AuthorizationProvider` trait implemented
   by AgentMesh adapter:
   ```rust
   impl AuthorizationProvider for AgentMeshAdapter {
       async fn authorize(&self, peer_id: &AgentId, ...) -> Result<...> {
           let trust_score = self.registry.get_trust_score(peer_id)?;
           if trust_score < 700 { return Err(InsufficientTrust); }
           self.policy_engine.evaluate(peer_id, requested_capability)
       }
   }
   ```

3. **Transport**: AgentMesh's WebSocket relay replaced by AAFP QUIC
   transport. Messages are end-to-end encrypted with PQ crypto.

4. **Audit**: AAFP session events exported to AgentMesh's Merkle chain
   audit log.

## 5. Experiment 4: AAFP Identity Federation

### 5.1 Goal

Enable AAFP agents to be authenticated by enterprise identity providers
(Okta, Active Directory, Keycloak) while maintaining AAFP's self-
sovereign identity model.

### 5.2 Design

```
Enterprise IdP (Okta/AD)
    |
    | OIDC token
    v
AAFP Identity Bridge
    |
    | 1. Verify OIDC token with IdP
    | 2. Issue UCAN token binding OIDC identity to AgentId
    v
AAFP Agent (with AgentId + UCAN token)
    |
    | AAFP session with UCAN
    v
AAFP Server (verifies UCAN + trusts bridge)
```

### 5.3 UCAN with Enterprise Identity

```cbor
UcanToken = {
    1: agent_id_of_bridge,      // issuer = bridge service
    2: agent_id_of_agent,       // subject = agent
    3: [{resource: "enterprise", action: "act-as", constraints: {oidc_sub: "user123"}}],
    4: expires_at,
    5: null,                    // no parent (bridge is root)
    6: bridge_signature,        // ML-DSA-65
}
```

The UCAN token binds the enterprise identity (OIDC subject) to the
AAFP AgentId. The server trusts the bridge service (which has its own
UCAN chain from the enterprise root).

## 6. Implementation Priority

| Experiment | Priority | Effort | Dependencies |
|-----------|----------|--------|-------------|
| A2A-over-AAFP | High | Medium | AAFP extension framework |
| MCP-over-AAFP | High | Medium | AAFP extension framework |
| AgentMesh integration | Medium | High | AgentMesh cooperation |
| Identity federation | Medium | Medium | OIDC bridge service |

## 7. Test Plan

For each interop experiment:

1. **Conformance**: Verify that A2A/MCP conformance tests pass over
   AAFP transport
2. **Performance**: Benchmark A2A/MCP over AAFP vs. over HTTP
3. **Security**: Verify PQ security properties are maintained
4. **Identity**: Verify identity mapping is correct and secure
5. **Streaming**: Verify streaming works over QUIC streams
6. **Error handling**: Verify error mapping between protocols

## 8. Transition to Phase 16

Phase 16 (Roadmap Categorization) will consolidate all recommendations
from Phases 4-15 into a prioritized, categorized roadmap for AAFP's
future development.
