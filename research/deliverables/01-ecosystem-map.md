# Deliverable 1: Ecosystem Map

```
Deliverable:    1 of 12
Title:          Agent Communication Ecosystem Map
Status:         Complete
Date:           2026-07-01
Source:         Phase 1 (Ecosystem Reconnaissance)
```

## The 2026 Agent Communication Stack

```
┌─────────────────────────────────────────────────────────────┐
│  Application / Workflow Layer                                 │
│  A2A (task delegation) · MCP (tool invocation)               │
│  AG-UI (agent-to-frontend) · OSSA (contract layer)           │
├─────────────────────────────────────────────────────────────┤
│  Messaging / Session Layer                                    │
│  SLIM (MLS E2EE, group) · AgentMesh (governance + Signal)    │
├─────────────────────────────────────────────────────────────┤
│  Identity / Discovery Layer                                   │
│  ANP (DIDs, meta-protocol) · AgentMesh (DIDs + trust)        │
├─────────────────────────────────────────────────────────────┤
│  Transport Layer                                              │
│  HTTP/1.1 · HTTP/2 (gRPC) · WebSocket · stdio                │
│  QUIC (only AAFP)                                             │
└─────────────────────────────────────────────────────────────┘
```

## Protocol Summary Table

| Protocol | Origin | Layer | Transport | Encoding | PQ? | E2EE? | Governance |
|----------|--------|-------|-----------|----------|-----|-------|------------|
| MCP | Anthropic | Application | stdio/HTTP | JSON | No | No | Linux Foundation |
| A2A | Google | Application | HTTP/gRPC | JSON/Proto | No | No | Linux Foundation |
| ACP | IBM | Application | HTTP/REST | JSON | No | No | Merged into A2A |
| ANP | ANP WG | Identity/Network | HTTP/P2P | JSON-LD | No | Yes | W3C track |
| SLIM | AGNTCY | Messaging | gRPC/HTTP2 | Protobuf | No (flag) | Yes (MLS) | IETF draft |
| AgentMesh | Microsoft | Governance | WS/HTTP | JSON | No (planned) | Yes (Signal) | Microsoft |
| **AAFP** | **Independent** | **Transport+Session** | **QUIC** | **CBOR** | **Yes** | **Yes** | **Independent** |

## Key Findings

1. **No major protocol uses QUIC** — AAFP is unique
2. **No major protocol has PQ crypto** — AAFP is unique
3. **No major protocol uses CBOR** — AAFP and SLIM (Protobuf) are the only binary protocols
4. **The ecosystem is converging on HTTP/JSON/OAuth** — AAFP is architecturally orthogonal
5. **Protocols are largely complementary** — A2A + MCP is the dominant stack
6. **SLIM is AAFP's closest competitor** — both target L2-L6 with deep stacks

## AAFP's Unique Position

AAFP is the only protocol that combines:
- Post-quantum cryptography (ML-DSA-65 + X25519MLKEM768)
- QUIC-native transport
- CBOR deterministic framing
- UCAN cryptographic capability chains
- Cross-connection replay protection

No other protocol in the ecosystem offers any two of these five features.
