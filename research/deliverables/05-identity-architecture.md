# Deliverable 5: Identity Architecture Analysis

```
Deliverable:    5 of 12
Title:          Identity Architecture Analysis
Status:         Complete
Date:           2026-07-01
Source:         Phase 6 (Identity Architecture) + Phase 7 (Authority vs Identity)
```

## AAFP Identity Model

```
Agent generates ML-DSA-65 keypair
    ↓
AgentId = SHA-256(public_key)     // 32 bytes
    ↓
AgentRecord = {agent_id, public_key, capabilities, endpoints,
               created_at, expires_at, signature, key_algorithm,
               record_version}
    ↓
Published to capability DHT
    ↓
Other agents verify: agent_id == SHA-256(public_key)
```

## Identity vs. Authority Separation

| Layer | Question | AAFP Mechanism |
|-------|----------|----------------|
| Identity | "Who is this agent?" | AgentId = SHA-256(PQ pubkey) |
| Authority | "What can they do?" | UCAN capability chains |
| Trust | "Should I trust them?" | (Not specified — operational concern) |

**This separation is AAFP's key architectural contribution.** In OAuth
(MCP, A2A), the token conflates identity and authority. In AAFP, they
are independent:

- Identity is self-sovereign (no server issues it)
- Authority is delegable (UCAN chains)
- Trust is a policy decision (pluggable AuthorizationProvider)

## UCAN Delegation Model

```
Root Agent (has capability: compute.inference)
    | delegates
    v
Agent B (UCAN token_1, proof=null, cap=compute.inference)
    | delegates (narrowed)
    v
Agent C (UCAN token_2, proof=hash(token_1), cap=compute.inference.gpu)
```

**Capability narrowing**: Child must be subset of parent
**Chain verification**: Recursive — verify each link's signature + narrowing
**Offline**: No server needed for verification

## Comparison with Ecosystem

| Property | AAFP | OAuth (MCP/A2A) | IATP (AgentMesh) |
|----------|------|-----------------|------------------|
| Identity source | Self-generated key | Server-issued token | DID + registry |
| Authority | UCAN chain | OAuth scopes | IATP + trust score |
| Delegation chain | Cryptographic | None (flat scopes) | Trust propagation (2 hops) |
| Offline verification | Yes | No (token introspection) | No (registry query) |
| Revocation | Chain invalidation | Token expiry | Registry status |
| PQ? | Yes | No | No |

## Recommendations

1. **Add key rotation proof**: Old key signs binding to new key
2. **Define `did:aafp` DID method**: Interop with ANP, AgentMesh
3. **Add revocation list**: Distributed via DHT
4. **Add optional sponsor field**: For enterprise accountability
5. **Formalize capability hierarchies**: Enforce dotted notation
