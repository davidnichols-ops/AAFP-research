# Deliverable 12: Prioritized Roadmap

```
Deliverable:    12 of 12
Title:          Prioritized Roadmap
Status:         Complete
Date:           2026-07-01
Source:         Phase 16 (Roadmap Categorization)
```

## P0 — Critical (Blocks Adoption / Security Risk)

| # | Item | Category | Effort | Dependencies |
|---|------|----------|--------|-------------|
| 1 | Extension framework RFC | Protocol | Medium | — |
| 2 | Post-compromise security (ratchet) | Security | Medium | #1 |
| 3 | Key rotation proof | Security | Medium | — |
| 4 | TCP fallback transport | Transport | Medium | — |

## P1 — High (Needed Within 12 Months)

| # | Item | Category | Effort | Dependencies |
|---|------|----------|--------|-------------|
| 5 | Session resumption (SessionTicket) | Transport | Medium | #1 |
| 6 | UCAN key binding (DPoP-like) | Security | Low | — |
| 7 | UCAN max chain depth | Security | Low | — |
| 8 | UCAN cycle detection | Security | Low | — |
| 9 | Revocation list (AgentRecord) | Security | Medium | — |
| 10 | Transport negotiation (QUIC + TCP) | Transport | Low | #4 |
| 11 | `did:aafp` DID method | Identity | Medium | — |
| 12 | A2A-over-AAFP binding | Interop | High | #1 |
| 13 | MCP-over-AAFP transport | Interop | High | #1 |
| 14 | Agent Card from AgentRecord | Identity | Low | #12 |
| 15 | OPA/Cedar policy adapters | Enterprise | Medium | — |
| 16 | Session event audit logging | Enterprise | Medium | — |
| 17 | FIPS documentation & mode | Enterprise | Low | — |
| 18 | Python SDK | Ecosystem | High | — |
| 19 | Example applications | Ecosystem | Medium | #18 |
| 20 | Documentation overhaul | Ecosystem | Medium | — |
| 21 | Linux Foundation submission | Ecosystem | Low | — |
| 22 | Extension registry | Protocol | Low | #1 |
| 23 | Extension governance model | Protocol | Low | #1 |

## P2 — Medium (Needed Within 24 Months)

| # | Item | Category | Effort | Dependencies |
|---|------|----------|--------|-------------|
| 24 | Revocation list (UCAN) | Security | Medium | — |
| 25 | Traffic analysis padding | Security | Low | #1 |
| 26 | QUIC BBR congestion control | Transport | Low | — |
| 27 | qlog support | Transport | Low | — |
| 28 | Streaming RPC extension | Transport | Medium | #1 |
| 29 | Connection pooling | Transport | Medium | — |
| 30 | SPIFFE/SVID integration | Identity | Medium | — |
| 31 | OIDC-to-UCAN bridge | Identity | High | — |
| 32 | AgentMesh integration | Interop | High | — |
| 33 | Formal capability hierarchies | Identity | Low | — |
| 34 | Optional sponsor field | Enterprise | Low | — |
| 35 | Kubernetes Helm charts | Enterprise | Low | — |
| 36 | TypeScript SDK | Ecosystem | High | — |
| 37 | Conference presentations | Ecosystem | Low | — |

## P3 — Low (Future Consideration)

| # | Item | Category | Effort | Dependencies |
|---|------|----------|--------|-------------|
| 38 | Group encryption (MLS) | Security | High | — |
| 39 | Merkle chain audit | Enterprise | Medium | #16 |
| 40 | Compliance documentation | Enterprise | Low | #15,16,17 |
| 41 | IETF Individual Draft | Ecosystem | Medium | #21 |
| 42 | Zero-copy CBOR | Transport | Medium | — |

## Timeline

### Q1-Q2 2026 (Immediate)
- #1: Extension framework RFC
- #2: Ratchet (PCS)
- #3: Key rotation proof
- #4: TCP fallback transport
- #20: Documentation overhaul

### Q3-Q4 2026 (Short-term)
- #5: Session resumption
- #6-8: UCAN security fixes
- #9: Revocation list
- #11: did:aafp
- #12-13: A2A/MCP interop
- #15-17: Enterprise basics
- #18-19: Python SDK + examples
- #21: Linux Foundation

### 2027 (Medium-term)
- #24-29: Security + transport improvements
- #30-33: Identity + interop
- #34-37: Enterprise + ecosystem

### 2028+ (Long-term)
- #38-42: Advanced features

## Dependency Graph

```
#1 (Extension Framework) ──┬── #2 (Ratchet)
                            ├── #5 (Session Resumption)
                            ├── #12 (A2A Binding)
                            └── #13 (MCP Transport)

#4 (TCP Fallback) ── #10 (Transport Negotiation)

#3 (Key Rotation) ──┬── #9 (Revocation List)
                    └── #11 (did:aafp)

#18 (Python SDK) ── #19 (Example Apps)
```

## Success Criteria

The roadmap is complete when:
1. All P0 items are implemented (no critical gaps)
2. At least 10 P1 items are implemented (production-ready)
3. At least one production deployment (real-world validation)
4. Linux Foundation membership (ecosystem credibility)
5. A2A/MCP interop demonstrated (ecosystem integration)
6. Python SDK available (broad developer accessibility)
