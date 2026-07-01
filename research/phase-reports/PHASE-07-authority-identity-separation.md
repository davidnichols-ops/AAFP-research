# Phase 7: Authority vs. Identity Separation

```
Phase:          7 of 16
Title:          Authority vs. Identity Separation
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Examine the architectural distinction between identity ("who you are")
and authority ("what you can do"). Analyze how AAFP's UCAN model
separates these concerns, how OAuth conflates them, and why this
separation matters for the future of agent communication.

## 2. The Core Distinction

### 2.1 Identity

Identity answers: **"Who is this agent?"**

- AAFP: `AgentId = SHA-256(public_key)` — a cryptographic identifier
- ANP: `did:wba:...` — a W3C DID
- AgentMesh: `did:mesh:...` — a DID + sponsor
- A2A: Agent Card — a JSON document with name, description, provider
- MCP: OAuth client ID — a server-issued identifier

Identity is **stable** (doesn't change per interaction) and **self-
describing** (can be verified without external state).

### 2.2 Authority

Authority answers: **"What is this agent allowed to do?"**

- AAFP: UCAN capability chain — a cryptographically signed delegation
- A2A: Agent Card skills + OAuth scopes — what the agent claims it can do
- MCP: OAuth 2.1 scopes — what the token allows
- AgentMesh: IATP + capability scoping — `action:resource[:qualifier]`
- SLIM: JWT claims — what the JWT authorizes

Authority is **contextual** (depends on who's asking and what's being
requested) and **delegable** (can be granted by one agent to another).

## 3. The OAuth Conflation

In OAuth-based systems (MCP, A2A), the access token conflates identity
and authority:

```
OAuth Token = {
    client_id: "agent-123",        // identity
    scope: "tools:read tools:write", // authority
    exp: 1735689600,               // expiry
    aud: "https://server.example.com" // audience
}
```

The token IS both identity and authority. This has several consequences:

### 3.1 Problems with Conflation

1. **No separation of concerns**: Changing authority (adding a scope)
   requires re-issuing the token, which also changes the identity
   presentation. You can't delegate authority without involving the
   authorization server.

2. **Server-issued identity**: The OAuth server issues the token, which
   means identity is server-controlled. The agent doesn't own its
   identity; the server does. This is fundamentally at odds with
   autonomous agency.

3. **No delegation chains**: OAuth tokens are flat — they encode what
   the bearer can do, but not who delegated to them. There is no
   cryptographic proof of the delegation chain. (OAuth 2.0 token
   exchange RFC 8693 exists but is rarely used in agent contexts.)

4. **Time-bounded, not revocable**: OAuth tokens expire. There is no
   on-demand revocation (token introspection exists but requires
   server round-trip). For long-lived agent relationships, this is
   awkward.

5. **Bearer tokens**: Anyone who has the token can use it. There is no
   cryptographic binding between the token and the agent's key material.
   (DPoP RFC 9334 and mTLS-bound tokens address this, but are not
   universally deployed.)

### 3.2 Benefits of Conflation

1. **Simplicity**: One token, one concept. Developers understand it.
2. **Ecosystem**: OAuth is deployed everywhere. Tooling is mature.
3. **Enterprise fit**: Enterprises control authorization servers, which
   means they control agent identity. This is a feature for enterprises.
4. **Audience binding**: Tokens are bound to specific servers (RFC 8707),
   preventing token replay across services.

## 4. The AAFP Separation

AAFP cleanly separates identity from authority:

### 4.1 Identity (AgentId)

```
AgentId = SHA-256(ML-DSA-65 public key)
```

- **Self-generated**: The agent generates its own key pair and derives
  its AgentId. No server issues it.
- **Stable**: The AgentId doesn't change when authority changes.
- **Cryptographically verifiable**: Anyone can verify
  `agent_id == SHA-256(public_key)`.
- **Not delegable**: You cannot delegate your AgentId to another agent.
  Identity is unique to the key holder.

### 4.2 Authority (UCAN)

```
UcanToken = {
    issuer: AgentId,           // who granted this authority
    subject: AgentId,          // who received this authority
    capabilities: [Capability], // what they can do
    expires_at: uint,          // when it expires
    proof: Option<hash>,       // parent token (delegation chain)
    signature: ML-DSA-65 sig,  // cryptographic proof
}
```

- **Delegable**: Agent A can delegate a subset of its authority to
  Agent B via a UCAN token. Agent B can further delegate to Agent C.
- **Chain-verifiable**: The entire delegation chain can be verified
  cryptographically, from root to leaf.
- **Capability-narrowing**: Each delegation must be a subset of the
  parent's capabilities. No privilege escalation.
- **Cryptographically bound**: The UCAN is signed by the issuer's
  ML-DSA-65 key, which is bound to the issuer's AgentId.

### 4.3 The Separation in Practice

```
Agent A (identity: AgentId_A)
    |
    | "I delegate inference capability to Agent B"
    v
UCAN_Token_1 = {
    issuer: AgentId_A,
    subject: AgentId_B,
    capabilities: [{resource: "compute.inference", action: "invoke"}],
    proof: null,
    signature: sign(A's key, ...)
}
    |
    | Agent B presents UCAN_Token_1 to Agent C
    v
Agent C verifies:
    1. AgentId_A == SHA-256(A's public_key)  // identity
    2. UCAN_Token_1 signature is valid       // authority
    3. Capabilities are within scope          // narrowing
    4. Token hasn't expired                   // validity
```

The verification process treats identity and authority as separate
checks. Agent C learns WHO Agent A is (identity) and WHAT Agent B is
authorized to do (authority), independently.

## 5. Why the Separation Matters

### 5.1 Autonomous Agency

For truly autonomous agents, identity must be self-sovereign. An agent
that depends on an OAuth server for its identity is not fully autonomous
— it depends on the server's availability and policies. AAFP's
self-generated AgentId enables true autonomy.

### 5.2 Delegation Without Trust Reset

In OAuth, if Agent A wants Agent B to act on its behalf, Agent B needs
its own OAuth token from the authorization server. The delegation
relationship is not cryptographically visible — the server knows about
it, but the verifier doesn't see the chain.

With UCAN, the delegation chain is self-contained. Agent B presents
the UCAN chain proving "Agent A delegated to me." The verifier can
verify the entire chain without contacting any server. This enables
offline delegation and reduces trust in third parties.

### 5.3 Composable Authority

UCAN capabilities are composable:
- Agent A has `{compute.inference, invoke}`
- Agent A delegates `{compute.inference, invoke}` to Agent B (full)
- Agent B delegates `{compute.inference.gpu, invoke}` to Agent C
  (narrowed to GPU inference)

The narrowing is enforced by `caps_compatible()`:
```rust
child.resource == parent.resource
    || child.resource.starts_with(parent.resource + ".")
```

This enables fine-grained, hierarchical authority that OAuth scopes
cannot express. OAuth scopes are flat strings with no hierarchical
relationship.

### 5.4 Revocable Authority Without Identity Change

If an agent's authority needs to be revoked (e.g., it misbehaved), only
the UCAN chain needs to be invalidated. The agent's identity (AgentId)
remains valid — it can still authenticate, just not exercise the
revoked authority.

In OAuth, revoking a token effectively revokes the agent's ability to
act at all (until it gets a new token). There is no notion of "revoke
one capability but keep others."

## 6. Comparison with AgentMesh's IATP

AgentMesh's IATP (Inter-Agent Trust Protocol) is the closest competitor
to AAFP's UCAN in terms of sophistication:

| Property | AAFP UCAN | AgentMesh IATP |
|----------|-----------|----------------|
| Identity | AgentId (PQ hash) | DID + Ed25519 |
| Authority | UCAN capability chain | IATP challenge-response + capability scoping |
| Delegation | Cryptographic chain | Trust score propagation (2 hops) |
| Revocation | Chain invalidation | Deny lists + registry status |
| Trust model | Cryptographic proof | Operational trust score |
| PQ? | Yes | No (planned) |

**Key difference**: UCAN is a **cryptographic** delegation model — the
authority is proven by signatures. IATP is an **operational** trust
model — authority is determined by trust scores, registry membership,
and challenge-response. They operate at different layers:

- UCAN answers: "Can you cryptographically prove you're authorized?"
- IATP answers: "Should I trust you based on your behavior and reputation?"

**These are complementary.** An ideal system would use UCAN for
cryptographic authorization and IATP-like trust scoring for operational
decisions. AAFP + AgentMesh could provide this combination.

## 7. The Authority Architecture Recommendation

### 7.1 Keep UCAN as the Authority Primitive

UCAN is the right model for agent-to-agent delegation. It provides:
- Cryptographic proof of delegation
- Capability narrowing (no privilege escalation)
- Offline verification (no server needed)
- Chain-based trust (verifiable from root to leaf)

### 7.2 Add Operational Trust Layer (Optional)

UCAN proves WHAT you're authorized to do, but not WHETHER you should be
trusted to do it. An operational trust layer (like AgentMesh's trust
score) would complement UCAN:

```
Authorization decision = UCAN_valid(agent, capability)
                      AND trust_score(agent) >= threshold(capability)
```

This is a policy decision, not a protocol decision. AAFP should define
the hook (an `AuthorizationProvider` trait that can check trust scores)
but not mandate the trust model.

### 7.3 Add Capability Hierarchies

Current UCAN capabilities are flat strings (`compute.inference`).
The narrowing rule uses `.` as a hierarchy separator, but this is
convention, not enforced by the type system.

**Recommendation**: Formalize capability hierarchies:
```cbor
Capability = {
    1: tstr,              // resource (dotted hierarchy)
    2: tstr,              // action
    3: { *tstr => Value } // constraints (optional)
}
```

With formal hierarchy rules:
- `compute.inference` is a sub-capability of `compute`
- `compute.inference.gpu` is a sub-capability of `compute.inference`
- Constraints can limit: `max_tokens`, `max_duration`, `max_cost`, etc.

### 7.4 Add Capability Revocation

Current gap: UCAN tokens can expire but cannot be actively revoked.

**Recommendation**: Add a `RevocationNotice`:
```cbor
RevocationNotice = {
    1: bstr(32),    // revoker_agent_id
    2: bstr(32),    // revoked_agent_id
    3: tstr,        // revoked_capability
    4: uint,        // revoked_at (timestamp)
    5: bstr,        // signature by revoker's key
}
```

Revocation notices are distributed via the DHT. Agents check before
honoring UCAN tokens.

## 8. The Big Picture

```
┌─────────────────────────────────────────────────────┐
│  Operational Trust Layer (optional, e.g. AgentMesh) │
│  "Should I trust this agent based on behavior?"      │
├─────────────────────────────────────────────────────┤
│  Authority Layer (UCAN)                              │
│  "What is this agent cryptographically authorized    │
│   to do, and who delegated it?"                      │
├─────────────────────────────────────────────────────┤
│  Identity Layer (AgentId)                            │
│  "Who is this agent? (SHA-256 of PQ public key)"     │
├─────────────────────────────────────────────────────┤
│  Transport Layer (QUIC + PQ TLS)                     │
│  "Secure, multiplexed, post-quantum connection"      │
└─────────────────────────────────────────────────────┘
```

Each layer is independent:
- Identity doesn't change when authority changes
- Authority doesn't change when trust score changes
- Transport doesn't change when identity changes (new key = new session)

This separation is AAFP's architectural contribution. No other protocol
in the ecosystem achieves this level of layer independence.

## 9. Transition to Phase 8

Phase 8 (Enterprise Integration) will examine how AAFP's self-sovereign,
decentralized architecture can be adapted for enterprise environments
that require governance, compliance, firewall compatibility, and
integration with existing identity systems (Active Directory, Okta,
SPIFFE).
