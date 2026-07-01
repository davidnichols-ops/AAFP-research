# Deliverable 3: AAFP Positioning Statement

```
Deliverable:    3 of 12
Title:          AAFP Positioning Statement
Status:         Complete
Date:           2026-07-01
Source:         Phase 4 (Where AAFP Fits)
```

## One-Sentence Positioning

**AAFP is a post-quantum secure session layer for agent communication,
providing ML-DSA-65 authenticated connections, UCAN capability
delegation, and QUIC-native transport.**

## What AAFP Is

AAFP is a **secure transport and session protocol** (OSI layers 2-6)
for agent-to-agent communication. It provides:

1. **Post-quantum security by default**: ML-DSA-65 signatures +
   X25519MLKEM768 hybrid key exchange. No classical-only mode.
2. **QUIC-native transport**: Stream multiplexing, 0-RTT resumption,
   connection migration, no head-of-line blocking.
3. **CBOR deterministic framing**: Binary, compact, self-describing,
   RFC 8949 compliant.
4. **UCAN capability delegation**: Cryptographic delegation chains with
   capability narrowing and chain verification.
5. **Cross-connection replay protection**: Time-bounded nonce cache
   with LRU eviction.

## What AAFP Is Not

- **Not an application protocol**: No task lifecycle, tool invocation,
  or workflow orchestration (that's A2A/MCP)
- **Not a governance platform**: No trust scoring, policy engine, or
  audit logging (that's AgentMesh)
- **Not a group messaging protocol**: No MLS group encryption (that's
  SLIM)
- **Not an identity standard**: No DID, no OAuth, no registry (though
  `did:aafp` is proposed for interop)

## Target Use Cases

1. **Defense/intelligence**: PQ security is mandated; agent
   communication involves long-lived sensitive data
2. **Financial services**: HNDL threat for long-retained financial
   data; agent-to-agent trading and risk analysis
3. **Healthcare**: Long-term PHI confidentiality; clinical decision
   support agents
4. **Edge/mobile agents**: QUIC migration and efficiency for agents on
   unstable networks

## Competitive Differentiation

| Differentiator | AAFP | Closest Competitor | Gap |
|----------------|------|-------------------|-----|
| PQ by default | Yes | SLIM (flag, not enabled) | Large |
| QUIC native | Yes | SLIM (HTTP/3 in draft only) | Large |
| UCAN chains | Yes | AgentMesh (IATP, no chains) | Medium |
| CBOR framing | Yes | SLIM (Protobuf) | Small |
| Replay cache | Yes | AgentMesh (single-use keys) | Small |

## Recommended Positioning

**Primary**: "Post-Quantum Secure Session Layer for Agents"
**Secondary**: "Interop-Ready Transport for A2A and MCP"

AAFP should be positioned as the secure foundation upon which
application-layer protocols (A2A, MCP) can run, with adapters for
ecosystem interoperability.
