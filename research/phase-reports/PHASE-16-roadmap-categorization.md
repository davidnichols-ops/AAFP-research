# Phase 16: Roadmap Categorization

```
Phase:          16 of 16
Title:          Roadmap Categorization
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Consolidate all recommendations from Phases 4-15 into a prioritized,
categorized roadmap for AAFP's future development. Each item includes
priority, effort, dependencies, and the phase that recommended it.

## 2. Categorization

### Category A: Security Enhancements
### Category B: Transport & Performance
### Category C: Identity & Interop
### Category D: Enterprise Readiness
### Category E: Ecosystem & Adoption
### Category F: Protocol Extensions

## 3. Priority Levels

- **P0 (Critical)**: Blocks adoption or has security risk
- **P1 (High)**: Significant value, needed within 12 months
- **P2 (Medium)**: Valuable, needed within 24 months
- **P3 (Low)**: Nice to have, future consideration

## 4. Roadmap

### Category A: Security Enhancements

| # | Item | Priority | Effort | Phase | Dependencies |
|---|------|----------|--------|-------|-------------|
| A1 | Post-compromise security (ratchet) | P0 | Medium | 10, 12 | Extension framework |
| A2 | Key rotation proof | P0 | Medium | 6, 12 | — |
| A3 | UCAN key binding (DPoP-like) | P1 | Low | 12 | — |
| A4 | UCAN max chain depth | P1 | Low | 12 | — |
| A5 | UCAN cycle detection | P1 | Low | 12 | — |
| A6 | Revocation list (AgentRecord) | P1 | Medium | 6, 12 | DHT extension |
| A7 | Revocation list (UCAN) | P2 | Medium | 7, 12 | — |
| A8 | Traffic analysis padding | P2 | Low | 12 | Extension framework |
| A9 | Group encryption (MLS) | P3 | High | 10 | MLS crate integration |

### Category B: Transport & Performance

| # | Item | Priority | Effort | Phase | Dependencies |
|---|------|----------|--------|-------|-------------|
| B1 | TCP fallback transport | P0 | Medium | 8, 9 | — |
| B2 | Session resumption (SessionTicket) | P1 | Medium | 10 | Extension framework |
| B3 | Transport negotiation (QUIC + TCP) | P1 | Low | 9 | B1 |
| B4 | QUIC BBR congestion control | P2 | Low | 9 | — |
| B5 | qlog support | P2 | Low | 8 | — |
| B6 | Streaming RPC extension | P2 | Medium | 3, 11 | Extension framework |
| B7 | Connection pooling | P2 | Medium | 13 | — |
| B8 | Zero-copy CBOR | P3 | Medium | 13 | — |

### Category C: Identity & Interop

| # | Item | Priority | Effort | Phase | Dependencies |
|---|------|----------|--------|-------|-------------|
| C1 | `did:aafp` DID method | P1 | Medium | 6 | — |
| C2 | A2A-over-AAFP binding | P1 | High | 4, 15 | Extension framework |
| C3 | MCP-over-AAFP transport | P1 | High | 4, 15 | Extension framework |
| C4 | Agent Card from AgentRecord | P1 | Low | 6, 15 | C2 |
| C5 | SPIFFE/SVID integration | P2 | Medium | 8 | — |
| C6 | OIDC-to-UCAN bridge | P2 | High | 8, 15 | — |
| C7 | AgentMesh integration | P2 | High | 15 | AgentMesh cooperation |
| C8 | Formal capability hierarchies | P2 | Low | 7 | — |

### Category D: Enterprise Readiness

| # | Item | Priority | Effort | Phase | Dependencies |
|---|------|----------|--------|-------|-------------|
| D1 | OPA/Cedar policy adapters | P1 | Medium | 8 | — |
| D2 | Session event audit logging | P1 | Medium | 8 | — |
| D3 | FIPS documentation & mode | P1 | Low | 8 | — |
| D4 | Optional sponsor field | P2 | Low | 6, 8 | — |
| D5 | Kubernetes Helm charts | P2 | Low | 8 | — |
| D6 | Merkle chain audit | P3 | Medium | 8 | D2 |
| D7 | Compliance documentation | P3 | Low | 8 | D1, D2, D3 |

### Category E: Ecosystem & Adoption

| # | Item | Priority | Effort | Phase | Dependencies |
|---|------|----------|--------|-------|-------------|
| E1 | Python SDK | P1 | High | 8, 14 | — |
| E2 | TypeScript SDK | P2 | High | 8, 14 | — |
| E3 | Linux Foundation submission | P1 | Low | 14 | — |
| E4 | Conference presentations | P2 | Low | 14 | — |
| E5 | Example applications | P1 | Medium | 14 | E1 |
| E6 | Documentation overhaul | P1 | Medium | 14 | — |
| E7 | IETF Individual Draft | P3 | Medium | 14 | E3 |

### Category F: Protocol Extensions

| # | Item | Priority | Effort | Phase | Dependencies |
|---|------|----------|--------|-------|-------------|
| F1 | Extension framework RFC | P0 | Medium | 11 | — |
| F2 | Extension registry | P1 | Low | 11 | F1 |
| F3 | Extension governance model | P1 | Low | 11 | F1 |

## 5. Timeline

### Q1-Q2 2026 (Immediate)

**Focus**: Security gaps + transport barrier + extension framework

| Item | Category |
|------|----------|
| F1: Extension framework RFC | F |
| A1: Ratchet (PCS) | A |
| A2: Key rotation proof | A |
| B1: TCP fallback transport | B |
| E6: Documentation overhaul | E |

### Q3-Q4 2026 (Short-term)

**Focus**: Interop + enterprise basics + SDKs

| Item | Category |
|------|----------|
| C1: did:aafp DID method | C |
| C2: A2A-over-AAFP binding | C |
| C3: MCP-over-AAFP transport | C |
| D1: OPA/Cedar adapters | D |
| D2: Audit logging | D |
| D3: FIPS documentation | D |
| E1: Python SDK | E |
| E5: Example applications | E |
| E3: Linux Foundation submission | E |
| B2: Session resumption | B |
| A3-A5: UCAN security fixes | A |

### 2027 (Medium-term)

**Focus**: Enterprise maturity + ecosystem growth

| Item | Category |
|------|----------|
| C5: SPIFFE integration | C |
| C6: OIDC-to-UCAN bridge | C |
| C7: AgentMesh integration | C |
| D4-D5: Enterprise features | D |
| E2: TypeScript SDK | E |
| E4: Conference presentations | E |
| A6-A7: Revocation lists | A |
| B3-B5: Transport improvements | B |
| B6: Streaming RPC | B |

### 2028+ (Long-term)

**Focus**: Standards + group messaging + advanced features

| Item | Category |
|------|----------|
| A9: Group encryption (MLS) | A |
| D6-D7: Advanced compliance | D |
| E7: IETF draft | E |
| C8: Capability hierarchies | C |
| B7-B8: Performance optimizations | B |

## 6. Dependency Graph

```
F1 (Extension Framework) ──┬── A1 (Ratchet)
                            ├── B2 (Session Resumption)
                            ├── B6 (Streaming RPC)
                            ├── C2 (A2A Binding)
                            └── C3 (MCP Transport)

B1 (TCP Fallback) ──┬── B3 (Transport Negotiation)
                    └── D5 (K8s Deployment)

A2 (Key Rotation) ──┬── A6 (Revocation List)
                    └── C1 (did:aafp)

E1 (Python SDK) ──┬── E5 (Example Apps)
                  └── C2 (A2A Binding testing)

D1 (OPA/Cedar) ──┬── D7 (Compliance Docs)
                 └── C7 (AgentMesh Integration)
```

## 7. Resource Estimates

| Category | P0 Items | P1 Items | P2 Items | Total Effort |
|----------|----------|----------|----------|-------------|
| A: Security | 2 | 4 | 2 | ~High |
| B: Transport | 1 | 2 | 3 | ~Medium-High |
| C: Identity/Interop | 0 | 4 | 3 | ~High |
| D: Enterprise | 0 | 3 | 2 | ~Medium |
| E: Ecosystem | 0 | 4 | 2 | ~Medium-High |
| F: Extensions | 1 | 2 | 0 | ~Medium |
| **Total** | **4** | **19** | **12** | **~Very High** |

**Note**: This is a multi-year roadmap. No single team can execute all
of this simultaneously. Prioritize P0 items first, then P1 items in
order of dependency.

## 8. Success Criteria

The roadmap is complete when:

1. **All P0 items are implemented**: No critical security gaps or
   adoption barriers
2. **At least 10 P1 items are implemented**: AAFP is production-ready
   for target verticals
3. **At least one production deployment**: Real-world validation
4. **Linux Foundation membership**: Ecosystem credibility
5. **A2A/MCP interop demonstrated**: Ecosystem integration
6. **Python SDK available**: Broad developer accessibility

## 9. Transition to Deliverables

Phases 1-16 are complete. The deliverables (12 documents + concluding
paper) will be produced from the phase reports.
