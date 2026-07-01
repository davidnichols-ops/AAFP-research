# Deliverable 9: Enterprise Integration Guide

```
Deliverable:    9 of 12
Title:          Enterprise Integration Guide
Status:         Complete
Date:           2026-07-01
Source:         Phase 8 (Enterprise Integration)
```

## Enterprise Barriers and Solutions

| Barrier | Solution | Priority |
|---------|----------|----------|
| UDP/QUIC blocked by firewall | TCP fallback transport | P0 |
| No identity federation | Sponsor field + OIDC bridge | P1 |
| No policy enforcement | OPA/Cedar AuthorizationProvider adapters | P1 |
| No audit logging | Session event log + SIEM export | P1 |
| No FIPS documentation | Document FIPS-validated crypto usage | P1 |
| No network observability | qlog + CBOR-to-JSON proxy | P2 |
| No human accountability | Optional sponsor field | P2 |
| No K8s deployment | Helm charts + operator | P2 |

## Deployment Patterns

### Pattern 1: Zero-Trust Internal Network
- Agents communicate via AAFP (QUIC + PQ)
- Policy engine (OPA/Cedar) authorizes every operation
- Audit service logs all session events
- Identity IdP (Okta/AD) maps to AgentId via sponsor field

### Pattern 2: AAFP Gateway for External Communication
- Internal agents use HTTP (existing infrastructure)
- AAFP gateway translates HTTP to AAFP for external PQ-secure communication
- Firewall allows QUIC outbound only

### Pattern 3: AAFP + AgentMesh Governance
- AgentMesh provides trust scoring, policy, audit
- AAFP provides PQ secure transport
- AgentMesh IATP runs over AAFP sessions
- Best of both worlds: governance + PQ security

## Identity Federation

```
Enterprise IdP (Okta/AD)
    ↓ OIDC token
AAFP Identity Bridge
    ↓ Verify OIDC + issue UCAN binding OIDC to AgentId
AAFP Agent (AgentId + UCAN with enterprise identity)
    ↓ AAFP session
AAFP Server (verifies UCAN + trusts bridge)
```

## Policy Integration

```rust
impl AuthorizationProvider for OpaAdapter {
    async fn authorize(&self, peer_id: &AgentId, cap: &Capability) -> Result<...> {
        self.opa_client.query(peer_id, cap, self.session_context)
    }
}
```

## FIPS Compliance

AAFP uses FIPS-validated crypto via `aws-lc-rs`:
- ML-DSA-65 (FIPS 204)
- X25519MLKEM768 (hybrid PQ KEX)
- AES-128-GCM (AEAD)
- SHA-256 (hashing)
- HKDF-SHA256 (key derivation)

**Action**: Document FIPS compliance status. Provide FIPS-mode
configuration that disables any non-FIPS algorithms.
