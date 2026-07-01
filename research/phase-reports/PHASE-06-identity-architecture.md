# Phase 6: Identity Architecture

```
Phase:          6 of 16
Title:          Identity Architecture
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Examine how agent identity is constructed, verified, discovered, and
managed across all protocols. Analyze the tension between AAFP's self-
sovereign PQ identity and the ecosystem's registry/DID/OAuth models.
Recommend an identity architecture for AAFP's future.

## 2. Identity Models in the Ecosystem

### 2.1 The Four Identity Paradigms

| Paradigm | Protocols | Identity Source | Verification |
|----------|-----------|----------------|--------------|
| **Cryptographic self-sovereignty** | AAFP, ANP | Agent's own key pair | Recompute hash / resolve DID |
| **Registry-validated** | AgentMesh, SLIM | Central/hierarchical registry | Query registry |
| **Certificate-based** | A2A (mTLS), MCP (OAuth) | CA / authorization server | Validate cert / token |
| **Metadata-based** | A2A (Agent Card) | Published JSON document | Fetch + verify (optional JWS) |

### 2.2 AAFP's Model: Cryptographic Self-Sovereignty

```
Agent generates ML-DSA-65 keypair
    |
    v
AgentId = SHA-256(public_key)     // 32 bytes, deterministic
    |
    v
AgentRecord = {
    agent_id, public_key, capabilities, endpoints,
    created_at, expires_at, signature, key_algorithm, record_version
}
    |
    v
AgentRecord signed by agent's private key
    |
    v
Published to capability DHT
    |
    v
Other agents discover by capability, verify signature,
    check agent_id == SHA-256(public_key)
```

**Properties**:
- No central authority
- No registry
- No human sponsor
- Identity is mathematically bound to key material
- Anyone can verify anyone
- Key rotation = new AgentId (old identity is abandoned)

## 3. Identity Comparison Matrix

| Property | AAFP | ANP | AgentMesh | A2A | MCP | SLIM |
|----------|------|-----|-----------|-----|-----|------|
| **Format** | SHA-256(pubkey) | did:wba | did:mesh | Agent Card JSON | OAuth client ID | org/ns/svc/client |
| **Crypto** | ML-DSA-65 | DID pubkey | Ed25519 | JWS (optional) | OAuth | JWT/SPIFFE |
| **PQ?** | **Yes** | No | No (planned) | No | No | No |
| **Self-sovereign?** | **Yes** | Yes | Yes (but registry-validated) | No | No | No |
| **Human sponsor?** | No | No | **Yes** | No | No | No |
| **Key rotation** | New AgentId | DID doc update | Crypto proof | Multi-sig | OAuth flow | JWT rotation |
| **Revocation** | Record expiry | DID doc update | Registry status | Token expiry | Token expiry | Token expiry |
| **Discovery** | Capability DHT | DID resolution | Registry API | Well-known URI | Configured URL | Name lookup |
| **Federation** | No | W3C DID interop | SPIFFE/SVID | OAuth interop | OAuth interop | SPIFFE interop |

## 4. Deep Dive: Key Rotation

Key rotation is one of the hardest identity problems. Every protocol
handles it differently:

### 4.1 AAFP: New Identity

- Rotate keys = generate new ML-DSA-65 keypair = new AgentId
- Old AgentId is abandoned; old AgentRecord expires
- No continuity between old and new identity
- Other agents must re-discover the agent under its new AgentId

**Problem**: No way to prove that new AgentId is the same agent as old
AgentId. This breaks trust continuity.

**Recommendation**: Add a key rotation proof — old private key signs a
statement binding the new public key to the old AgentId. This is what
AgentMesh does (old key signs rotation proof containing both old and new
public keys).

### 4.2 ANP: DID Document Update

- Rotate keys = update DID document with new public key
- DID identifier stays the same
- DID document is published at the same well-known URL
- Anyone resolving the DID gets the new key

**Advantage**: Identity continuity. The DID never changes; only the key
material updates.

### 4.3 AgentMesh: Cryptographic Rotation Proof

- Old private key signs: `{old_pubkey, new_pubkey, timestamp}`
- Rotation proof is published to registry
- Anyone can verify the rotation chain

**Advantage**: Both continuity and cryptographic proof.

### 4.4 A2A: Multi-Signature Agent Card

- Agent Card can have multiple signatures (for key rotation)
- New key signs the card; old key also signs to authorize the transition
- Consumers verify both signatures

**Advantage**: Gradual transition period where both keys are valid.

## 5. Deep Dive: Identity Discovery

### 5.1 AAFP's Capability DHT

```
Agent A wants to find agents with "compute.inference" capability
    |
    v
Query DHT: get("compute.inference")
    |
    v
DHT returns: [AgentRecord_B, AgentRecord_C, AgentRecord_D]
    |
    v
Agent A verifies each record's signature + expiry + agent_id hash
    |
    v
Agent A connects to chosen agent via QUIC
```

**Strengths**:
- Capability-based (find by what you can do, not who you are)
- Distributed (no central registry)
- Self-verifying (records are signed)

**Weaknesses**:
- In-memory only (current implementation is not actually distributed)
- No reputation/trust scoring (any agent can announce any capability)
- No geographic awareness beyond regional buckets

### 5.2 A2A's Agent Card

```
Agent A wants to find Agent B
    |
    v
Fetch: https://agent-b.example.com/.well-known/agent-card.json
    |
    v
Parse Agent Card: name, description, capabilities, skills, endpoints
    |
    v
Optionally verify JWS signature
    |
    v
Connect to endpoint
```

**Strengths**:
- Simple (HTTP GET)
- Human-readable (JSON)
- Optional cryptographic verification (JWS)
- Well-known URI convention (RFC 8615)

**Weaknesses**:
- Must know the agent's domain (not capability-based discovery)
- No distributed discovery (each agent publishes its own card)
- Optional signing means cards can be tampered with

### 5.3 AgentMesh's Registry

```
Agent A wants to find agents
    |
    v
Query registry: GET /v1/agents?capability=inference
    |
    v
Registry returns: [AgentIdentity_B, AgentIdentity_C]
    |
    v
Each identity includes: did, public_key, sponsor_email, trust_score, status
    |
    v
Agent A filters by trust_score >= 700
    |
    v
Connect via WebSocket relay
```

**Strengths**:
- Rich metadata (trust score, sponsor, status)
- Centralized consistency
- Real-time status (active/suspended/revoked)

**Weaknesses**:
- Central registry (single point of failure/control)
- No cryptographic self-sovereignty (registry is authoritative)
- Must trust the registry

## 6. The Identity Interop Challenge

AAFP's AgentId is fundamentally different from all other identity
formats. Mapping between them is non-trivial:

| From | To | Mapping | Feasibility |
|------|-----|---------|-------------|
| AgentId | DID | AgentId is not a DID; would need `did:aafp:<agent_id>` scheme | Medium |
| AgentId | Agent Card | AgentId could be a field in Agent Card; AAFP record -> Agent Card | High |
| AgentId | OAuth | No natural mapping; OAuth is server-issued, AgentId is self-generated | Low |
| AgentId | SPIFFE | AgentId could be a SPIFFE ID: `spiffe://aafp/<agent_id>` | Medium |
| AgentId | SLIM name | AgentId could be the `client` component: `org/aafp/agent/<agent_id>` | Medium |

### 6.1 Recommended Identity Interop Strategy

1. **Define `did:aafp` DID method**: Map AgentId to W3C DID format.
   `did:aafp:<hex(agent_id)>` resolves to a DID document containing the
   ML-DSA-65 public key and endpoints. This enables interop with ANP and
   AgentMesh (both use DIDs).

2. **Generate A2A Agent Cards from AgentRecords**: An AAFP agent can
   publish an A2A Agent Card at `/.well-known/agent-card.json` with:
   - `name`: agent's display name
   - `supportedInterfaces`: AAFP endpoint
   - `skills`: derived from AgentRecord capabilities
   - `signatures`: JWS over the card, signed by ML-DSA-65 key
   - This enables A2A agents to discover AAFP agents.

3. **Support SPIFFE for enterprise**: In enterprise deployments, AAFP
   agents can use SPIFFE IDs alongside AgentIds. The SPIFFE ID is the
   enterprise identity; the AgentId is the cryptographic identity. Both
   are verified during handshake.

4. **OAuth bridge for MCP**: For MCP interop, an AAFP agent can expose
   an OAuth-protected HTTP endpoint that translates MCP requests into
   AAFP session messages. The OAuth token maps to a UCAN capability
   chain.

## 7. Identity Architecture Recommendations

### 7.1 Keep AgentId as the Core

AgentId = SHA-256(ML-DSA-65 public key) is the right primitive. It is:
- Simple (32 bytes)
- Self-verifying (recompute the hash)
- Post-quantum (SHA-256 + ML-DSA-65)
- Algorithm-independent (works with any future signature scheme)

### 7.2 Add Key Rotation Proofs

Current gap: rotating keys creates a new AgentId with no continuity.

**Recommendation**: Add a `KeyRotationProof` structure:
```cbor
KeyRotationProof = {
    1: bstr(32),    // old_agent_id
    2: bstr,        // old_public_key
    3: bstr(32),    // new_agent_id
    4: bstr,        // new_public_key
    5: uint,        // timestamp
    6: bstr,        // old_signature (ML-DSA-65 over fields 1-5)
    7: bstr,        // new_signature (ML-DSA-65 over fields 1-5)
}
```

This proves that the holder of the old key authorized the transition to
the new key. Agents that trusted the old AgentId can transitively trust
the new one.

### 7.3 Add DID Method

Define `did:aafp` as a W3C DID method:
- DID: `did:aafp:<hex(agent_id)>`
- DID document: contains ML-DSA-65 public key, endpoints, capabilities
- Resolution: query AAFP DHT or HTTP gateway

This enables interop with ANP, AgentMesh, and any DID-resolving system.

### 7.4 Add Revocation Mechanism

Current gap: AgentRecords expire but cannot be actively revoked.

**Recommendation**: Add a `RevocationList` distributed via the DHT:
```cbor
RevocationList = {
    1: bstr(32),    // agent_id
    2: uint,        // revoked_at (timestamp)
    3: bstr,        // signature by revoked agent's key
    4: tstr,        // reason
}
```

Agents check the revocation list before establishing sessions. A revoked
AgentRecord is refused even if it hasn't expired.

### 7.5 Consider Human Sponsor (Optional)

AgentMesh's human sponsor model is valuable for enterprise deployments.
AAFP could make this optional:
- AgentRecord has an optional `sponsor` field (DID or email)
- If present, the sponsor's identity is verified out-of-band
- Enterprise deployments can require sponsors; open-internet deployments
  can omit them

This preserves AAFP's decentralized philosophy while enabling enterprise
governance.

## 8. Transition to Phase 7

Phase 7 (Authority vs. Identity Separation) will examine how AAFP's
UCAN model separates "who you are" (identity) from "what you can do"
(authority), and why this separation is architecturally significant
compared to OAuth's conflated model.
