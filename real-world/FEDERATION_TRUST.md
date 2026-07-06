# AAFP Federation & Multi-Organization Trust

> **Scope**: How independent organizations run their own AAFP networks and
> interconnect them through federation — trust anchors, UCAN delegation
> chains across organizational boundaries, Web of Trust scoring, gateway
> agents, reputation portability, and dispute resolution.
>
> **Source code references**:
> - `aafp-identity/src/trust_manager.rs` — unified trust decision API (RFC 0011 §8)
> - `aafp-identity/src/web_of_trust.rs` — peer-to-peer trust signatures and transitive trust (RFC 0011 §4)
> - `aafp-identity/src/ucan.rs` — UCAN capability delegation chains
> - `aafp-identity/src/ca_certificate.rs` — CA-signed certificates (RFC 0011 §5)
> - `aafp-identity/src/key_directory.rs` — AgentId → AgentRecord directory (RFC 0011 §3)

---

## Table of Contents

1. [Federation Model Overview](#1-federation-model-overview)
2. [Trust Anchors](#2-trust-anchors)
3. [UCAN Delegation Chains Across Organizations](#3-ucan-delegation-chains-across-organizations)
4. [Trust Scoring: Web of Trust Metrics](#4-trust-scoring-web-of-trust-metrics)
5. [Organizational Boundaries](#5-organizational-boundaries)
6. [Federation Gateways](#6-federation-gateways)
7. [Identity Verification](#7-identity-verification)
8. [Reputation Portability](#8-reputation-portability)
9. [Dispute Resolution](#9-dispute-resolution)
10. [Federation Topology](#10-federation-topology)
11. [Concrete Example: Three-Company Federation](#11-concrete-example-three-company-federation)
12. [Public vs Private Capabilities](#12-public-vs-private-capabilities)
13. [Implementation Reference](#13-implementation-reference)

---

## 1. Federation Model Overview

AAFP federation is the practice of multiple independent organizations each
operating their own AAFP network — their own agents, their own trust
anchors, their own capability policies — while selectively interconnecting
to allow cross-organization agent communication.

### 1.1 Why Federation?

A single global AAFP network has the same problems as a single global
anything: no single party wants to operate it, no one agrees on policy,
and trust is binary (you either trust the global root or you don't).
Federation solves this by letting each organization be sovereign:

- **Sovereign trust**: Each org chooses its own root CAs, its own WoT
  participants, its own directory servers. No external party can override
  an org's trust decisions.
- **Sovereign policy**: Each org defines which capabilities are exposed
  externally, which agents can act as gateways, and what trust level is
  required for inbound connections.
- **Selective interconnection**: Orgs federate only with partners they
  choose. There is no global "join the AAFP network" operation. Federation
  is a bilateral or multilateral agreement, enforced cryptographically.

### 1.2 What Federation Is Not

Federation is **not** a single trust root that all orgs share. It is **not**
a global key directory that everyone publishes to. It is **not** a
reputation system where scores are globally computed. Each of these would
require a central authority, which defeats the purpose.

Federation **is** a set of bilateral trust relationships between
organizations, implemented through:

1. **Cross-org UCAN delegation** — Org A delegates capabilities to Org B's
   agents, who can further delegate to Org C's agents.
2. **Cross-org WoT signatures** — Agents in Org A sign the keys of agents
   in Org B, creating transitive trust paths.
3. **Shared CA roots** — Orgs may agree to trust each other's CA, or may
   use a third-party CA they both trust.
4. **Federation gateways** — Designated agents that bridge between private
   and public networks, translating between internal and external trust
   contexts.

### 1.3 The TrustManager as Federation Boundary

The `TrustManager` (defined in `trust_manager.rs`, RFC 0011 §8) is the
federation boundary. Each agent has one, and it encodes that agent's
organization's trust policy:

```rust
// From trust_manager.rs lines 88-104
pub struct TrustManager {
    own_agent_id: AgentId,
    direct_cache: Mutex<HashMap<AgentId, Vec<u8>>>,  // peers we've met
    wot: Mutex<WebOfTrust>,                           // transitive trust
    ca_verifier: Mutex<CaVerifier>,                   // trusted CA roots
    directory: Mutex<Option<KeyDirectory>>,           // org directory
    revocation_store: Arc<Mutex<RevocationStore>>,    // revocation
    policy: TrustPolicy,                              // strict/cautious/permissive
}
```

When an agent in Org A connects to an agent in Org B, the TrustManager in
Org A's agent evaluates Org B's agent through all available trust sources.
The decision is local — Org A's agent never asks Org B "should I trust
you?" It consults its own configured trust anchors.

---

## 2. Trust Anchors

Trust anchors are the cryptographic roots from which all trust derives.
AAFP supports four classes of trust anchor, and federation combines them.

### 2.1 Root CAs (Certificate Authority Trust)

An organization operates its own CA using ML-DSA-65 (not X.509). The CA
signs `CaCertificate` objects that bind an AgentId + public key +
capabilities + validity period:

```rust
// From ca_certificate.rs lines 88-110
pub struct CaCertificate {
    pub cert_type: String,           // "aafp-ca-cert-v1"
    pub agent_id: AgentId,           // 32-byte AgentId
    pub public_key: Vec<u8>,         // 1952 bytes (ML-DSA-65)
    pub issuer: String,              // CA name (human-readable)
    pub issuer_public_key: Vec<u8>,  // CA's ML-DSA-65 key
    pub serial_number: u64,
    pub not_before: u64,
    pub not_after: u64,
    pub capabilities: Vec<String>,   // capabilities allowed by this cert
    pub ca_signature: Vec<u8>,       // CA's signature over fields 1-9
}
```

In a federation, each org has its own CA. Org A's agents trust Org A's CA
root key. When Org A and Org B federate, they have three options:

1. **Cross-sign**: Org A's CA issues a certificate for Org B's CA key,
   making Org B's CA a subordinate. Org A's agents now transitively trust
   certificates issued by Org B's CA.
2. **Mutual root trust**: Org A adds Org B's CA root key to its trusted
   roots set (`TrustManager::add_trusted_ca`), and vice versa. Both CAs
   remain independent but each org trusts the other's certificates
   directly.
3. **Third-party CA**: Both orgs trust a shared third-party CA (e.g., an
   industry consortium CA). This is the federation equivalent of a
   public CA.

The `TrustManager` verification order (lines 169-257) checks CA
certificates at step 3, after revocation and direct trust but before WoT:

```rust
// Step 3: CA certificate (trust_manager.rs lines 198-216)
if let Some(cert) = ca_cert {
    match verifier.verify_certificate(cert, now, Some(&revocation_store)) {
        Ok(()) => return TrustResult::Trusted {
            source: TrustSource::CertificateAuthority,
            level: TRUST_LEVEL_FULL,
        },
        Err(e) => { /* fall through to WoT */ }
    }
}
```

A CA-verified peer receives `TRUST_LEVEL_FULL` (2), which is sufficient
for most operations. This is the strongest trust available transitively —
`TRUST_LEVEL_ULTIMATE` (3) is reserved for the agent's own key and is
never granted through any external source.

### 2.2 Organizational Identity

An organization's identity in AAFP is not a single key — it is a set of
cryptographic artifacts:

| Artifact | Purpose | How It's Established |
|----------|---------|---------------------|
| **CA root key** | Signs agent certificates | Generated by the org, kept offline |
| **Directory signing key** | Signs directory responses | Configured via `KeyDirectory::with_directory_key` |
| **Gateway agent keys** | Bridge between private/public networks | CA-certified, with gateway capabilities |
| **WoT anchor agents** | Sign external agents' keys | Designated by org policy, CA-certified |

There is no "Org A" AgentId. Instead, Org A is identified by the
collection of its CA root key hash, its directory endpoint, and its
gateway agents' AgentIds. Federation agreements reference these
artifacts directly.

### 2.3 Agent Identity Hierarchy

Within an organization, agent identity forms a hierarchy enforced by
UCAN delegation chains (see §3). The hierarchy is:

```
Org CA Root Key
  └── CA Certificate (binds root agent's key + capabilities)
        └── UCAN Token 1 (root agent → department lead agent)
              └── UCAN Token 2 (department lead → team agent)
                    └── UCAN Token 3 (team agent → task agent)
```

Each level narrows capabilities — a task agent can do strictly less than
its parent. The `caps_compatible` function in `ucan.rs` (lines 306-313)
enforces this:

```rust
fn caps_compatible(parent: &Capability, child: &Capability) -> bool {
    let resource_ok = child.resource == parent.resource
        || child.resource.starts_with(&format!("{}.", parent.resource));
    let action_ok = child.action == parent.action;
    resource_ok && action_ok
}
```

A child can have the same resource ("compute.inference") or a
sub-resource ("compute.inference.model-gpt4"), but never a broader
resource. Actions must match exactly. This ensures that delegation
chains can only narrow authority, never expand it.

---

## 3. UCAN Delegation Chains Across Organizations

UCAN (User Controlled Authorization Networks) tokens are the primary
mechanism for cross-organization capability delegation. A UCAN token is
a JWT-style object signed with ML-DSA-65 that delegates capabilities from
an issuer to an audience.

### 3.1 Token Structure

```rust
// From ucan.rs lines 33-59
pub struct UcanPayload {
    pub iss: String,              // Issuer AgentId (hex)
    pub aud: String,              // Audience AgentId (hex)
    pub cap: Vec<Capability>,     // Capabilities delegated
    pub exp: u64,                 // Expiration timestamp
    pub nbf: u64,                 // Not-before timestamp
    pub prf: Option<String>,      // Parent token hash (for chain linking)
}

pub struct Capability {
    pub resource: String,                    // e.g., "compute.inference"
    pub action: String,                      // e.g., "invoke"
    pub constraints: Option<serde_json::Value>, // e.g., {"max_tokens": 1000}
}
```

The `prf` (proof) field links a child token to its parent by containing
the SHA-256 hash of the parent token's signing input. This creates a
cryptographic chain that cannot be broken without detection.

### 3.2 Cross-Org Delegation: A → B → C

Consider three organizations where Org A delegates to Org B, which
delegates to Org C:

```
Org A (AI Lab)                Org B (Cloud Provider)         Org C (Enterprise)
─────────────                 ────────────────────           ────────────────
Root Agent A_R                Gateway Agent B_G              Task Agent C_T
    │                             │                             │
    │  UCAN Token 1               │                             │
    │  iss: A_R                   │                             │
    │  aud: B_G                   │                             │
    │  cap: [compute.inference]   │                             │
    │  prf: None                  │                             │
    ├────────────────────────────►│                             │
    │                             │  UCAN Token 2               │
    │                             │  iss: B_G                   │
    │                             │  aud: C_T                   │
    │                             │  cap: [compute.inference]   │
    │                             │  prf: SHA256(Token 1)       │
    │                             ├────────────────────────────►│
    │                             │                             │
    │                             │     C_T presents chain:     │
    │                             │     [Token 1, Token 2]      │
    │                             │     to prove authority      │
```

When Agent C_T wants to invoke `compute.inference` on Org A's
infrastructure, it presents the chain `[Token 1, Token 2]`. Org A
verifies the chain using `UcanToken::verify_chain` (ucan.rs lines
198-271):

```rust
pub fn verify_chain(chain: &[&UcanToken], root_public_key: &[u8]) -> Result<(), IdentityError>
```

The verification checks:
1. **First token** is signed by `root_public_key` (Org A's root agent key).
2. **Each subsequent token** is signed by the previous token's audience
   (Token 2's issuer must be Token 1's audience).
3. **Capabilities do not expand** — each link's capabilities must be a
   subset of (or equal to) the parent's.
4. **No token is expired** — `exp` must be in the future, `nbf` in the past.
5. **Chain links are connected** via the `prf` field — each token's `prf`
   must equal SHA-256 of the previous token's signing input.

### 3.3 Constraints as Federation Policy

The `constraints` field in `Capability` is where federation policy lives.
Org A can delegate `compute.inference` to Org B but constrain it:

```json
{
  "resource": "compute.inference",
  "action": "invoke",
  "constraints": {
    "max_tokens_per_request": 4096,
    "max_requests_per_hour": 10000,
    "allowed_models": ["gpt-4", "claude-3"],
    "allowed_orgs": ["org-b.example.com", "org-c.example.com"],
    "require_audit_log": true
  }
}
```

When Org B delegates to Org C, it can only narrow these constraints, not
relax them. The `caps_compatible` check ensures the resource/action
don't expand, but constraint narrowing is enforced at the application
layer (the capability enforcement point checks constraints at invocation
time).

### 3.4 Chain Expiry and Rotation

UCAN tokens have explicit `exp` (expiration) timestamps. In a federation,
chains should use short-lived tokens (hours, not months) to limit the
blast radius of key compromise. When a token expires, the delegatee must
request a new token from the delegator.

For long-running federation relationships, orgs typically establish a
token refresh protocol:
1. Org B's gateway periodically requests new tokens from Org A's root
   agent before the current token expires.
2. The old token is allowed to expire naturally (no revocation needed).
3. If the relationship is severed, Org A simply stops issuing new tokens,
   and the old token expires within hours.

---

## 4. Trust Scoring: Web of Trust Metrics

The Web of Trust (`web_of_trust.rs`, RFC 0011 §4) provides decentralized,
peer-to-peer trust scoring that complements the hierarchical CA model.

### 4.1 Trust Levels

AAFP defines four trust levels (web_of_trust.rs lines 30-37):

| Level | Name | Meaning | How Granted |
|-------|------|---------|-------------|
| 0 | None | No trust | Default for unknown agents |
| 1 | Marginal | Transitive trust after one hop | Computed: one WoT hop from a trusted agent |
| 2 | Full | Direct trust from a trusted source | Direct WoT signature, CA cert, or directory record |
| 3 | Ultimate | Only the agent's own key | Never granted transitively |

### 4.2 Transitive Trust and Decay

Trust decays with distance. The `WebOfTrust::trust_level` method
(lines 423-489) implements BFS from the agent's own identity:

```
Direct signature (0 hops):   trust_level as signed (max Full = 2)
One hop (A → B → C):         Marginal (1)
Two+ hops (A → B → C → D):   None (0)
Ultimate (3):                Only for own key, never transitively
```

This is deliberately conservative. The rationale (RFC 0011 §2.1) is that
transitive trust is fragile — if A trusts B and B trusts C, A's trust in
C should be weak. Two hops is considered too unreliable for any trust at
all.

The implementation (lines 454-485):

```rust
// Level 1: one-hop transitive trust (Marginal)
if let Some(direct_sigs) = self.signatures.get(own) {
    for sig in direct_sigs {
        if sig.is_expired(now) { continue; }
        if sig.trust_level < TRUST_LEVEL_MARGINAL { continue; }
        let intermediary = &sig.signed_agent_id;
        if let Some(inter_sigs) = self.signatures.get(intermediary) {
            for inter_sig in inter_sigs {
                if inter_sig.is_expired(now) { continue; }
                if &inter_sig.signed_agent_id == target {
                    if TRUST_LEVEL_MARGINAL > best {
                        best = TRUST_LEVEL_MARGINAL;
                    }
                }
            }
        }
    }
}
// Two+ hops: None (0) — no further BFS needed
```

### 4.3 Time Decay

WoT signatures have explicit expiry timestamps. The recommended validity
is 90 days (web_of_trust.rs line 40):

```rust
pub const RECOMMENDED_WOT_VALIDITY_SECS: u64 = 90 * 24 * 60 * 60;
```

Expired signatures are silently ignored during trust computation
(`sig.is_expired(now)` checks). The `evict_expired` method (lines
537-547) can be called periodically to remove expired signatures from
storage:

```rust
pub fn evict_expired(&mut self, now: u64) -> usize {
    let mut removed = 0;
    for sigs in self.signatures.values_mut() {
        let before = sigs.len();
        sigs.retain(|s| !s.is_expired(now));
        removed += before - sigs.len();
    }
    self.signatures.retain(|_, v| !v.is_empty());
    removed
}
```

In a federation context, this means trust relationships must be actively
maintained. If Org A's WoT anchor stops re-signing Org B's agents every
90 days, trust decays to zero. This prevents stale trust from persisting
after a federation relationship ends.

### 4.4 TrustSignature Structure

A WoT trust signature (web_of_trust.rs lines 98-114) is a signed
statement that one agent vouches for another's key:

```rust
pub struct TrustSignature {
    pub sig_type: String,              // "aafp-wot-sig-v1"
    pub signer_agent_id: AgentId,      // Who is vouching
    pub signed_agent_id: AgentId,      // Who is being vouched for
    pub signed_public_key: Vec<u8>,    // The key being vouched for
    pub trust_level: u8,               // 0-3
    pub expiry: u64,                   // When this signature expires
    pub signature: Vec<u8>,            // ML-DSA-65 signature
}
```

Verification (lines 294-334) checks five things:
1. Type string is `"aafp-wot-sig-v1"`.
2. `signed_agent_id == SHA-256(signed_public_key)` — the AgentId must be
   derived from the public key being vouched for.
3. `trust_level` is in range [0, 3].
4. The ML-DSA-65 signature verifies against the signer's public key.
5. The signature has not expired (if `now` is provided).

### 4.5 WoT in Federation: Cross-Org Signatures

In a federation, WoT signatures cross organizational boundaries. Org A's
designated WoT anchor agents sign the keys of Org B's gateway agents.
This creates a trust path:

```
Org A's agent (own_agent_id = A_self)
  │
  ├── WoT sig: A_self → A_anchor (Full, 90 days)
  │     └── A_anchor is Org A's designated WoT signer
  │
  └── WoT sig: A_anchor → B_gateway (Full, 90 days)
        └── B_gateway is Org B's federation gateway
              │
              └── [One hop] A_self trusts B_gateway at Marginal (1)
```

Org A's internal agents can now connect to Org B's gateway with
`TRUST_LEVEL_MARGINAL`, which is sufficient for `TrustPolicy::Cautious`
(the default) to accept the connection. For higher-trust operations, Org
A's admin can directly sign B_gateway's key at `TRUST_LEVEL_FULL`, or B
can present a CA certificate from a CA that Org A trusts.

### 4.6 Combining Trust Sources

The `TrustManager::verify_peer` method (lines 169-257) checks trust
sources in a specific priority order:

```
1. Revocation check     → if revoked, return Revoked (highest priority)
2. Direct trust         → if key matches cache, return Trusted (Ultimate)
3. CA certificate       → if cert verifies, return Trusted (Full)
4. Web of Trust         → if level >= Marginal, return Trusted (level)
5. Directory            → if record matches, return Trusted (Full)
6. Unknown              → return Unknown with suggestion
```

This means a revoked agent is always rejected, even if they have a valid
CA certificate. Direct trust (TOFU cache) overrides everything except
revocation. CA certificates are checked before WoT, so an org's
hierarchical trust takes precedence over peer-to-peer trust. The
directory is a fallback when no other source is available.

---

## 5. Organizational Boundaries

### 5.1 Which Capabilities Are Exposed to External Orgs

Organizations must decide which of their internal capabilities are
visible to federated partners. AAFP does not have a built-in capability
visibility flag — instead, capability exposure is controlled through
three mechanisms:

**1. UCAN delegation scope**: Org A only delegates the capabilities it
wants Org B to access. If Org A has internal capabilities like
`internal.metrics.read` or `internal.deploy.push`, it simply does not
include them in UCAN tokens issued to Org B.

**2. CA certificate capability lists**: When Org A's CA issues a
certificate for a gateway agent, the certificate includes a capability
list (ca_certificate.rs line 107):

```rust
pub capabilities: Vec<String>,  // capabilities allowed by this certificate
```

A gateway agent's certificate might include only
`["compute.inference", "discovery.lookup"]`, excluding all internal
capabilities. The CA verifier checks that the presented certificate's
capabilities match the requested operation.

**3. Gateway agent filtering**: Federation gateway agents (see §6) are
the network-level boundary. They only expose a subset of the org's agents
and capabilities to the external network. Internal agents that should
never be reachable from outside simply don't connect to the gateway.

### 5.2 Boundary Enforcement Points

| Boundary | Mechanism | Enforced By |
|----------|-----------|-------------|
| Network | Gateway agent (only external-facing agent) | Network topology |
| Transport | QUIC connection requires completed handshake | `aafp-core` Session state machine |
| Trust | `TrustManager::verify_peer` with org policy | `aafp-identity` |
| Capability | UCAN chain verification + constraint checking | `aafp-core` AuthorizationProvider |
| Revocation | CRL check before any trust decision | `aafp-identity` RevocationStore |

### 5.3 Trust Policy Per Boundary

The `TrustPolicy` enum (trust_manager.rs lines 77-86) controls how
strict the trust boundary is:

```rust
pub enum TrustPolicy {
    Strict,      // Reject Unknown and Untrusted. Only accept Trusted.
    Cautious,    // Accept Trusted, reject Untrusted/Revoked, prompt for Unknown.
    Permissive,  // Accept Trusted and Unknown (TOFU), reject Revoked.
}
```

Organizations should use different policies for different boundaries:

| Boundary | Recommended Policy | Rationale |
|----------|-------------------|-----------|
| Internal agent-to-agent | `Permissive` | TOFU is safe within org network |
| Gateway to external agent | `Cautious` | Prompt admin for unknown external agents |
| External agent to gateway | `Strict` | Only accept pre-established trust |
| Agent to critical infrastructure | `Strict` | No unknown agents near sensitive systems |

---

## 6. Federation Gateways

### 6.1 Role of Gateway Agents

A federation gateway is a designated agent that bridges between an
organization's private network and the federated public network. It
serves three functions:

1. **Inbound bridge**: Accepts connections from external federated
   agents, verifies their trust, and routes them to appropriate internal
   agents.
2. **Outbound bridge**: Allows internal agents to reach external
   federated agents by forwarding requests through the gateway.
3. **Capability translator**: Maps internal capability names to external
   capability names and vice versa (e.g., `internal.model.serve` →
   `compute.inference` for external consumption).

### 6.2 Gateway Identity

A gateway agent has a special identity profile:

- **CA-certified**: The gateway's key is signed by the org's CA, with a
  certificate that includes gateway-specific capabilities (e.g.,
  `federation.gateway`, `discovery.lookup`).
- **WoT-anchored**: The gateway's key is signed by WoT anchor agents in
  federated partner orgs, creating cross-org trust paths.
- **Directory-published**: The gateway's AgentRecord is published to both
  the org's internal directory and any shared federation directories.

### 6.3 Gateway Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           Org A (Private Network)        │
                    │                                         │
   External ────────┤  Gateway Agent A_G                      │
   Agents           │  ├── CA cert: [federation.gateway,      │
   from Org B       │  │              compute.inference]      │
                    │  ├── WoT: signed by B's anchor (Full)   │
                    │  └── Routes to:                         │
                    │      ├── Inference Agent A_I            │
                    │      ├── Discovery Agent A_D            │
                    │      └── (NOT: Internal Deploy Agent)   │
                    │                                         │
                    └─────────────────────────────────────────┘
```

The gateway does not expose all internal agents. It maintains a routing
table that maps external capabilities to specific internal agents. An
external agent requesting `compute.inference` is routed to A_I; an
external agent requesting `internal.deploy.push` is rejected because no
internal agent is mapped to that capability for external access.

### 6.4 Gateway as UCAN Delegation Point

Gateways are natural UCAN delegation points. When Org B's agent wants to
use Org A's inference service:

1. Org B's gateway (B_G) holds a UCAN token from Org A's gateway (A_G)
   delegating `compute.inference`.
2. B_G delegates a narrower token to Org B's internal agent (B_I),
   constraining it (e.g., `max_tokens: 4096`).
3. B_I connects to A_G and presents the chain `[A_G → B_G, B_G → B_I]`.
4. A_G verifies the chain, checks that B_I's capabilities are within the
   delegated scope, and routes the request to A_I.

This keeps the UCAN chain entirely within the federation trust
framework — no out-of-band authentication is needed.

---

## 7. Identity Verification

### 7.1 Proving an Agent Belongs to an Organization

There are three ways to prove organizational membership, each with
different trust assumptions:

**Method 1: CA Certificate (strongest)**

The org's CA signs the agent's key. The verifier checks:
1. The certificate's `ca_signature` verifies against a trusted CA root.
2. The certificate is not expired (`not_before ≤ now ≤ not_after`).
3. The certificate is not revoked (checked against RevocationStore).
4. The certificate's `capabilities` include the requested operation.

```rust
// From ca_certificate.rs — certificate issuance
let cert = CaCertificate::issue(
    agent_id,
    &agent.public_key,
    "Org A CA",
    &ca.public_key,
    &ca.secret_key().unwrap(),
    serial_number,
    not_before,
    not_after,
    vec!["compute.inference", "federation.gateway"],
);
```

**Method 2: Directory Record**

The agent's `AgentRecord` is published to a trusted key directory. The
verifier looks up the AgentId, checks that the recorded public key
matches, and verifies the record's self-signature:

```rust
// From trust_manager.rs lines 228-245
if let Some(record) = dir.lookup(agent_id) {
    if record.public_key == public_key {
        if record.verify(now).is_ok() {
            return TrustResult::Trusted {
                source: TrustSource::Directory,
                level: TRUST_LEVEL_FULL,
            };
        }
    }
}
```

The directory itself must be trusted — either it's the org's internal
directory (trusted by configuration) or a federation-shared directory
(trusted by agreement). The `KeyDirectory` can sign responses with its
own key (`with_directory_key`), providing directory authenticity.

**Method 3: WoT Signature from Org's Anchor**

An agent is signed by the org's designated WoT anchor agent. The
verifier must already trust the anchor (directly or transitively) for
this to work. This is the weakest method — it provides `TRUST_LEVEL_FULL`
if the verifier directly trusts the anchor, or `TRUST_LEVEL_MARGINAL` if
the trust is one hop removed.

### 7.2 AgentRecord Structure

An `AgentRecord` (identity_v1.rs) is the self-signed identity document
that agents publish to directories. It contains:

- **AgentId**: SHA-256 of the public key (32 bytes).
- **Public key**: ML-DSA-65 key (1952 bytes).
- **Endpoints**: Network addresses where the agent can be reached.
- **Capabilities**: What the agent can do (for discovery).
- **Validity period**: `not_before` / `not_after`.
- **Key algorithm**: `KEY_ALG_ML_DSA_65`.
- **Self-signature**: Signed by the agent's own private key.

The record is self-signed — the agent proves it controls the key by
signing the record with that key. Organizational membership is proven
separately (via CA cert, directory trust, or WoT signature).

### 7.3 Verification Flow for a Cross-Org Connection

When Agent B_I (in Org B) connects to Gateway A_G (in Org A):

```
1. QUIC handshake completes (PQ TLS, mutual authentication)
2. A_G calls TrustManager::verify_peer(B_I_id, B_I_pubkey, ca_cert, now)
3. TrustManager checks:
   a. Is B_I revoked? → Check RevocationStore
   b. Have we met B_I before? → Check direct_cache
   c. Does B_I have a CA cert? → Verify against trusted CA roots
   d. Do we have a WoT path to B_I? → BFS through WebOfTrust
   e. Is B_I in our directory? → Lookup + verify record
   f. None of the above? → Return Unknown with suggestion
4. If Trusted: check UCAN chain for requested capability
5. If UCAN chain valid: route request to internal agent
6. If any step fails: close connection with error
```

---

## 8. Reputation Portability

### 8.1 The Problem

When an agent moves from Org A to Org B, or when an agent participates in
multiple federations, can its reputation (trust score, interaction
history, reliability metrics) follow it?

### 8.2 What Is Portable

| Artifact | Portable? | Mechanism |
|----------|-----------|-----------|
| AgentId + key pair | Yes (if agent controls key) | Agent brings its key pair |
| WoT signatures | Partially | Other agents can re-sign the new key |
| CA certificate | No | Bound to org's CA; new org issues new cert |
| UCAN tokens | No | Bound to specific delegation chain |
| Directory record | Yes (if agent republishes) | Agent publishes to new org's directory |
| Interaction history | No (by default) | Not stored in AAFP protocol |
| Reliability metrics | Not in protocol | Application-layer concern |

### 8.3 Key Rotation and Reputation Transfer

When an agent rotates its key (e.g., moving orgs or recovering from
compromise), the old key can sign a statement delegating trust to the new
key. This is similar to PGP key transition certificates. AAFP's
`key_rotation.rs` module handles this:

1. Agent generates new key pair.
2. Old key signs a rotation statement: "AgentId_old is now AgentId_new,
   signed by old_key."
3. Agents who trusted the old key can verify the rotation statement and
   transfer their trust to the new key.
4. WoT signatures on the old key do not automatically transfer — each
   signer must decide whether to re-sign the new key.

### 8.4 Reputation as WoT Signatures

In the AAFP model, "reputation" is primarily encoded as WoT signatures.
If Agent X has been reliable in Org A's federation, multiple agents in
Org A have signed X's key at `TRUST_LEVEL_FULL`. When X joins Org B's
federation:

1. X presents its old key and the WoT signatures from Org A.
2. Org B's WoT anchor can verify these signatures (they're
   self-contained cryptographic objects).
3. Org B's anchor can sign X's new key at a level it chooses (possibly
   `Marginal` initially, upgrading to `Full` after observation).
4. X's reputation from Org A serves as evidence but does not
   automatically grant trust in Org B — each org's trust policy decides
   how much weight to give external signatures.

### 8.5 Why Reputation Is Not Automatically Portable

Automatic reputation portability would create a global reputation
system, which has known problems:

- **Sybil attacks**: An attacker creates many fake agents that all sign
  each other, inflating reputation.
- **Collusion**: A malicious org signs all its agents at `Full`, then
  those agents enter another federation with inflated trust.
- **Context mismatch**: An agent reliable for `compute.inference` may not
  be reliable for `data.storage`.

AAFP's conservative transitive trust decay (one hop = Marginal, two hops
= None) is specifically designed to prevent reputation inflation across
organizational boundaries.

---

## 9. Dispute Resolution

### 9.1 Types of Cross-Org Disputes

| Dispute Type | Example | Resolution Mechanism |
|-------------|---------|---------------------|
| Capability abuse | Org B's agent exceeds delegated constraints | UCAN chain audit + revocation |
| Key compromise | Org A's agent key is stolen | Revocation list (CRL) + key rotation |
| Misattribution | Org B claims Org A's agent misbehaved | Audit logs + UCAN chain proof |
| Trust disagreement | Org A trusts an agent that Org B doesn't | No resolution needed — trust is sovereign |
| Gateway abuse | Org B's gateway routes to unauthorized internal agents | Gateway capability revocation |

### 9.2 Revocation as the Primary Tool

When an agent misbehaves, the response is revocation. The
`RevocationStore` (trust_manager.rs line 101) holds Certificate
Revocation Lists (CRLs) that mark AgentIds as revoked:

```rust
// From trust_manager.rs lines 176-181 — revocation is checked first
if self.revocation_store.lock().unwrap().is_revoked(agent_id) {
    return TrustResult::Revoked {
        reason: "agent_id is in revocation store".into(),
    };
}
```

Revocation overrides all other trust sources. Even if an agent has a
valid CA certificate, direct trust, and WoT signatures, a revocation
entry means the connection is rejected. This is tested explicitly
(trust_manager.rs lines 548-571):

```rust
#[test]
fn test_revocation_overrides_direct_trust() {
    // Agent has direct trust, then gets revoked → Revoked wins
    tm.add_direct_trust(b_id, b.public_key.clone());
    // ... revoke B ...
    let result = tm.verify_peer(&b_id, &b.public_key, None, 1_000_000);
    assert!(matches!(result, TrustResult::Revoked { .. }));
}
```

### 9.3 Cross-Org Revocation

When Org A discovers that Org B's agent B_I is malicious:

1. **Org A revokes B_I locally**: Org A adds B_I's AgentId to its
   RevocationStore. All Org A agents that share the revocation store
   will now reject B_I.

2. **Org A notifies Org B**: Out-of-band, Org A informs Org B that B_I
   is revoked and why. This is a policy/federation agreement matter, not
   a protocol operation.

3. **Org B revokes B_I's certificate**: Org B's CA adds B_I's
   certificate serial number to its CRL. All orgs that trust Org B's CA
   will now reject B_I's certificate.

4. **Org B rotates B_I's key**: If B_I was compromised (not malicious),
   Org B issues a new key and new certificate, and the old key is
   permanently revoked.

### 9.4 UCAN Chain Auditing

When a capability abuse dispute arises, the UCAN chain provides
cryptographic evidence. The chain `[A_G → B_G → B_I]` proves:

- Who delegated the capability (A_G).
- Who received and re-delegated it (B_G).
- Who ultimately exercised it (B_I).
- What constraints were in place at each level.

This chain is non-repudiable — each token is signed, and signatures
cannot be forged without the private key. An auditor can reconstruct
exactly who authorized what.

### 9.5 Trust Disagreements

If Org A trusts an agent that Org B doesn't, no resolution is needed.
Trust is sovereign — each org's `TrustManager` makes independent
decisions. Org A's agents will accept the agent; Org B's agents won't.
This is by design. There is no global consensus on trust.

---

## 10. Federation Topology

### 10.1 Hub-and-Spoke

```
         ┌──────────────┐
         │  Hub Org (H)  │
         │  CA: H_CA     │
         │  Directory: H │
         └──┬───┬───┬───┘
            │   │   │
    ┌───────┘   │   └───────┐
    │           │           │
┌───▼───┐  ┌───▼───┐  ┌───▼───┐
│ Org A  │  │ Org B  │  │ Org C  │
│ CA: A  │  │ CA: B  │  │ CA: C  │
└────────┘  └────────┘  └────────┘
```

- Hub org acts as a trusted intermediary.
- Spoke orgs trust the hub's CA but not necessarily each other's CAs.
- All cross-org traffic flows through the hub's gateway.
- **Advantage**: Simple trust model — only one cross-org trust
  relationship per spoke.
- **Disadvantage**: Hub is a bottleneck and single point of failure.

**Implementation**: Each spoke adds the hub's CA root to its
`TrustManager::add_trusted_ca`. The hub's gateway holds UCAN tokens
from each spoke, delegating the capabilities each spoke exposes.

### 10.2 Mesh

```
┌──────────┐         ┌──────────┐
│  Org A    │◄───────►│  Org B    │
│  CA: A    │         │  CA: B    │
└─────┬─────┘         └─────┬─────┘
      │                      │
      │                      │
      │    ┌──────────┐      │
      └───►│  Org C    │◄─────┘
           │  CA: C    │
           └──────────┘
```

- Every org directly federates with every other org.
- Each pair establishes bilateral trust (cross-signed CAs or mutual WoT
  signatures).
- **Advantage**: No single point of failure. Maximum autonomy.
- **Disadvantage**: O(n²) trust relationships. Complex to manage at
  scale.

**Implementation**: Each org's `TrustManager` has every other org's CA
root added. WoT anchor agents in each org sign gateway agents in every
other org. UCAN delegation chains are bilateral.

### 10.3 Hierarchical

```
              ┌────────────────┐
              │  Consortium CA  │
              │  (Industry CA)  │
              └──┬───┬───┬─────┘
                 │   │   │
          ┌──────┘   │   └──────┐
          │          │          │
     ┌────▼───┐ ┌───▼────┐ ┌───▼────┐
     │Region A│ │Region B│ │Region C│
     │  CA    │ │  CA    │ │  CA    │
     └──┬──┬──┘ └──┬──┬──┘ └──┬─────┘
        │  │       │  │       │
     ┌──▼┐│      ┌─▼──┐    ┌──▼──┐
     │A1 ││      │B1  │    │C1   │
     └───┘│      └────┘    └─────┘
     ┌────▼┐
     │A2   │
     └─────┘
```

- A top-level consortium CA signs regional CAs.
- Regional CAs sign individual org CAs.
- Org CAs sign agent certificates.
- **Advantage**: Scales well. New orgs only need one trust relationship
  (with their regional CA).
- **Disadvantage**: Hierarchy creates power asymmetry. The consortium CA
  is a trusted third party.

**Implementation**: Each org's `TrustManager` trusts its regional CA
root. The regional CA's certificate is signed by the consortium CA.
`CaVerifier::verify_certificate` walks the chain from the agent's
certificate up through intermediate CAs to the trusted root.

### 10.4 Hybrid (Most Common in Practice)

Most real-world federations are hybrid:

- Core partners use mesh topology (direct bilateral trust).
- Smaller participants use hub-and-spoke through a core partner.
- An industry consortium CA provides a fallback trust anchor.

```
         ┌──────────────────────────────────────┐
         │  Consortium CA (fallback trust)      │
         └────────┬───────────┬─────────────────┘
                  │           │
     ┌────────────▼──┐   ┌───▼────────────┐
     │  Org A (Core)  │◄─►│  Org B (Core)  │
     │  Mesh partner  │   │  Mesh partner  │
     └───────┬───────┘   └───────┬────────┘
             │                   │
        ┌────▼────┐         ┌────▼────┐
        │ Org A1  │         │ Org B1  │
        │ (Spoke) │         │ (Spoke) │
        └─────────┘         └─────────┘
```

---

## 11. Concrete Example: Three-Company Federation

### 11.1 Participants

| Company | Role | Internal Agents | External Capabilities |
|---------|------|-----------------|----------------------|
| **NeuroLab** | AI Lab (model provider) | Model-serving agents, training agents | `compute.inference`, `compute.train` |
| **CloudScale** | Cloud Provider (infrastructure) | Compute nodes, storage nodes, gateway | `compute.inference` (resold), `data.storage` |
| **FortuneCorp** | Enterprise (consumer) | Employee assistant agents, data agents | `data.query` (internal only) |

### 11.2 Trust Setup

**NeuroLab** (AI Lab):
- CA root key: `NL_CA` (offline, in HSM)
- WoT anchor: `NL_anchor` (CA-certified, signs external partners)
- Gateway: `NL_gateway` (CA-certified with `[federation.gateway, compute.inference, compute.train]`)
- Directory: `dir.neurolab.internal` (internal only)

**CloudScale** (Cloud Provider):
- CA root key: `CS_CA`
- WoT anchor: `CS_anchor`
- Gateway: `CS_gateway` (CA-certified with `[federation.gateway, compute.inference, data.storage]`)
- Directory: `dir.cloudscale.com` (publicly accessible, signed responses)

**FortuneCorp** (Enterprise):
- CA root key: `FC_CA`
- WoT anchor: `FC_anchor`
- Gateway: `FC_gateway` (CA-certified with `[federation.gateway]`)
- Directory: `dir.fortunecorp.internal` (internal only)

### 11.3 Federation Agreements

**NeuroLab ↔ CloudScale** (mesh, bilateral):
- NeuroLab adds `CS_CA` to its trusted roots.
- CloudScale adds `NL_CA` to its trusted roots.
- `NL_anchor` signs `CS_gateway` at `TRUST_LEVEL_FULL` (90 days).
- `CS_anchor` signs `NL_gateway` at `TRUST_LEVEL_FULL` (90 days).
- NeuroLab issues UCAN token to CloudScale: `compute.inference` with
  constraints `{max_concurrent: 1000, allowed_models: ["nl-7b", "nl-70b"]}`.

**CloudScale ↔ FortuneCorp** (hub-and-spoke, CloudScale is hub):
- FortuneCorp adds `CS_CA` to its trusted roots.
- `CS_anchor` signs `FC_gateway` at `TRUST_LEVEL_FULL` (90 days).
- CloudScale issues UCAN token to FortuneCorp: `compute.inference` with
  constraints `{max_concurrent: 50, allowed_models: ["nl-7b"]}` (narrower
  than what CloudScale itself received from NeuroLab).

**NeuroLab ↔ FortuneCorp** (indirect, through CloudScale):
- No direct trust relationship.
- FortuneCorp does NOT add `NL_CA` to its trusted roots.
- FortuneCorp reaches NeuroLab's models through CloudScale's gateway,
  which holds the delegation chain.

### 11.4 Delegation Chain in Action

When an employee assistant agent in FortuneCorp (`FC_assistant`) wants
to run inference on NeuroLab's `nl-7b` model:

```
Chain: [NL_gateway → CS_gateway, CS_gateway → FC_gateway, FC_gateway → FC_assistant]

Token 1: NL_gateway → CS_gateway
  iss: NL_gateway_id
  aud: CS_gateway_id
  cap: [{resource: "compute.inference", action: "invoke",
         constraints: {max_concurrent: 1000, allowed_models: ["nl-7b", "nl-70b"]}}]
  prf: None (root of chain)

Token 2: CS_gateway → FC_gateway
  iss: CS_gateway_id
  aud: FC_gateway_id
  cap: [{resource: "compute.inference", action: "invoke",
         constraints: {max_concurrent: 50, allowed_models: ["nl-7b"]}}]
  prf: SHA256(Token 1 signing input)
  // Note: max_concurrent narrowed from 1000 → 50, models narrowed from 2 → 1

Token 3: FC_gateway → FC_assistant
  iss: FC_gateway_id
  aud: FC_assistant_id
  cap: [{resource: "compute.inference", action: "invoke",
         constraints: {max_concurrent: 1, allowed_models: ["nl-7b"]}}]
  prf: SHA256(Token 2 signing input)
  // Note: max_concurrent narrowed from 50 → 1 (single employee)
```

`FC_assistant` presents this chain to `NL_gateway`. NL_gateway calls
`UcanToken::verify_chain`:

1. Token 1 signature verifies against `NL_gateway`'s public key. ✓
2. Token 2's `iss` matches Token 1's `aud` (both are `CS_gateway_id`). ✓
3. Token 2's `prf` matches SHA-256 of Token 1's signing input. ✓
4. Token 2's capabilities are compatible with Token 1's (same resource,
   same action, narrower constraints). ✓
5. Token 3's `iss` matches Token 2's `aud` (both are `FC_gateway_id`). ✓
6. Token 3's `prf` matches SHA-256 of Token 2's signing input. ✓
7. Token 3's capabilities are compatible with Token 2's. ✓
8. No token is expired. ✓

Chain verified. `NL_gateway` routes the request to the `nl-7b`
model-serving agent, enforcing the constraints from Token 3
(`max_concurrent: 1`).

### 11.5 Trust Verification

When `FC_assistant` connects to `NL_gateway`, `NL_gateway`'s
TrustManager verifies `FC_assistant`:

1. **Revocation check**: Is `FC_assistant` in the revocation store? No.
2. **Direct trust**: Has `NL_gateway` met `FC_assistant` before? No
   (first connection).
3. **CA certificate**: `FC_assistant` presents a certificate from
   `FC_CA`. Does `NL_gateway` trust `FC_CA`? No — NeuroLab doesn't have
   a direct federation agreement with FortuneCorp. Fall through.
4. **Web of Trust**: Is there a WoT path from `NL_gateway` to
   `FC_assistant`? `NL_anchor` signed `CS_gateway` (Full). `CS_anchor`
   signed `FC_gateway` (Full). But `FC_assistant` is signed only by
   `FC_gateway` — that's two hops from `NL_gateway`'s perspective
   (NL_gateway → CS_gateway → FC_gateway → FC_assistant), which is
   beyond the one-hop limit. Result: None. Fall through.
5. **Directory**: Is `FC_assistant` in `NL_gateway`'s directory?
   No — FortuneCorp's directory is internal only. Fall through.
6. **Unknown**: Return `TrustResult::Unknown` with suggestion
   `TrustSuggestion::RequestCaCert`.

**This means `FC_assistant` cannot directly connect to `NL_gateway`.**
The connection must go through `CS_gateway`, which CAN verify
`FC_assistant` (it has a WoT path through `CS_anchor → FC_gateway`).
`CS_gateway` forwards the inference request to `NL_gateway` on
`FC_assistant`'s behalf, presenting its own credentials (which
`NL_gateway` CAN verify through the bilateral trust agreement).

This is the hub-and-spoke pattern working as intended: FortuneCorp
doesn't have direct trust with NeuroLab, but CloudScale bridges the gap.

### 11.6 Revocation Scenario

Three months later, `FC_assistant`'s key is compromised.

1. FortuneCorp's security team discovers the compromise.
2. `FC_CA` revokes `FC_assistant`'s certificate (adds serial to CRL).
3. FortuneCorp publishes the CRL to `FC_gateway`.
4. `FC_gateway`'s RevocationStore now contains `FC_assistant`.
5. `FC_gateway` stops forwarding requests from `FC_assistant`.
6. FortuneCorp issues a new key for the employee, gets a new certificate
   from `FC_CA`, and the employee's new agent begins operating.
7. The old UCAN tokens (Token 3) expire naturally (they were short-lived,
   e.g., 1 hour). The new agent gets a fresh token from `FC_gateway`.

CloudScale and NeuroLab are unaffected — they never directly trusted
`FC_assistant`. The compromise is contained within FortuneCorp's
boundary.

---

## 12. Public vs Private Capabilities

### 12.1 Capability Visibility Model

AAFP capabilities exist in three visibility tiers:

| Tier | Visible To | Example | How Controlled |
|------|-----------|---------|----------------|
| **Private** | Only agents within the org | `internal.deploy.push`, `internal.metrics.read` | Not included in UCAN tokens to external agents; gateway doesn't route to them |
| **Federated** | Trusted federated partners | `compute.inference`, `data.storage` | Included in UCAN tokens with constraints; CA cert lists them |
| **Public** | Any agent that can connect | `discovery.lookup`, `federation.ping` | Gateway accepts connections with any trust level for these |

### 12.2 Enforcement

**Private capabilities** are enforced by network topology and gateway
routing. The gateway agent simply does not have a route for
`internal.deploy.push` — no external agent can reach the internal deploy
agent because the gateway won't forward the request. Additionally, the
internal deploy agent's CA certificate does not include
`internal.deploy.push` in its capability list if it's ever exposed
externally (it shouldn't be).

**Federated capabilities** are enforced by UCAN chain verification. The
chain must include the capability, and constraints must be satisfied.
The `caps_compatible` check ensures the capability hasn't been expanded
or substituted.

**Public capabilities** are enforced by the gateway's trust policy. The
gateway may use `TrustPolicy::Permissive` for public capabilities
(accepting TOFU for `discovery.lookup`) while using `TrustPolicy::Strict`
for federated capabilities. This dual-policy approach requires the
gateway to maintain two TrustManager instances or to check the capability
type before applying the trust policy.

### 12.3 Capability Naming Convention

AAFP recommends a naming convention that encodes visibility:

```
internal.*          → Private (never exposed externally)
compute.*           → Federated (delegated to partners)
data.*              → Federated (with strict constraints)
discovery.*         → Public (anyone can query)
federation.*        → Public (gateway management)
```

This is a convention, not a protocol enforcement. The `caps_compatible`
function checks resource hierarchy (`compute.inference` is a child of
`compute`), but it does not enforce the `internal.*` prefix as private.
Organizations must configure their gateways to reject any request for
`internal.*` capabilities from external agents.

### 12.4 Example Capability Matrix

For the three-company federation (§11):

| Capability | NeuroLab | CloudScale | FortuneCorp |
|-----------|----------|------------|-------------|
| `compute.inference` | Exposes (provider) | Resells (delegated) | Consumes |
| `compute.train` | Exposes (provider) | Not delegated | Not accessible |
| `data.storage` | Not applicable | Exposes | Consumes |
| `data.query` | Not accessible | Not accessible | Private (internal only) |
| `internal.deploy.push` | Private | Private | Private |
| `internal.metrics.read` | Private | Private | Private |
| `discovery.lookup` | Public | Public | Public |
| `federation.gateway` | Gateway only | Gateway only | Gateway only |

---

## 13. Implementation Reference

### 13.1 Key Types and Their Roles

| Type | File | Role in Federation |
|------|------|-------------------|
| `TrustManager` | `trust_manager.rs` | Per-agent trust boundary; combines all trust sources |
| `TrustPolicy` | `trust_manager.rs` | Strict/Cautious/Permissive policy for boundary |
| `TrustResult` | `trust_manager.rs` | Trusted/Untrusted/Revoked/Unknown decision |
| `TrustSource` | `trust_manager.rs` | Which source provided trust (Direct/WoT/CA/Directory/TOFU) |
| `WebOfTrust` | `web_of_trust.rs` | Stores WoT signatures; computes transitive trust levels |
| `TrustSignature` | `web_of_trust.rs` | Signed trust assertion between two agents |
| `UcanToken` | `ucan.rs` | Capability delegation token |
| `Capability` | `ucan.rs` | Resource + action + constraints |
| `CaCertificate` | `ca_certificate.rs` | CA-signed agent identity + capabilities |
| `KeyDirectory` | `key_directory.rs` | AgentId → AgentRecord lookup |
| `RevocationStore` | `revocation.rs` | CRL storage for revoked agents |

### 13.2 Trust Level Constants

```rust
// From web_of_trust.rs lines 30-37
pub const TRUST_LEVEL_NONE: u8 = 0;      // No trust
pub const TRUST_LEVEL_MARGINAL: u8 = 1;  // One-hop transitive
pub const TRUST_LEVEL_FULL: u8 = 2;      // Direct WoT, CA cert, or directory
pub const TRUST_LEVEL_ULTIMATE: u8 = 3;  // Only self, never transitively
```

### 13.3 Trust Verification Order

```
1. Revocation (highest priority)     → Revoked
2. Direct trust (TOFU cache)         → Trusted(Ultimate) or Untrusted(key mismatch)
3. CA certificate                    → Trusted(Full) or fall-through
4. Web of Trust (BFS, ≤1 hop)        → Trusted(level) or fall-through
5. Directory lookup                  → Trusted(Full) or fall-through
6. Unknown                           → Unknown(suggestion)
```

### 13.4 UCAN Chain Verification Checks

```
1. First token signed by root_public_key
2. Each token's iss == previous token's aud
3. Each token's prf == SHA-256(previous token's signing input)
4. Capabilities don't expand (child ⊆ parent)
5. No token expired (exp > now, nbf ≤ now)
```

### 13.5 WoT Transitive Trust Decay

```
0 hops (direct):  trust_level as signed (max Full = 2)
1 hop:            Marginal (1)
2+ hops:          None (0)
Ultimate (3):     Only for own key, never transitively
```

### 13.6 Federation Setup Checklist

For an organization joining a federation:

- [ ] Generate CA root key (ML-DSA-65, store in HSM)
- [ ] Issue CA certificates for gateway agents with appropriate capabilities
- [ ] Configure `TrustManager` with org's CA root (`add_trusted_ca`)
- [ ] Configure `TrustManager` with org's directory (`with_directory`)
- [ ] Set `TrustPolicy` appropriate for each boundary (Strict for external)
- [ ] Designate WoT anchor agents (CA-certified, authorized to sign external keys)
- [ ] Publish gateway AgentRecords to federation directories
- [ ] Exchange CA root keys with federation partners (bilateral or via consortium)
- [ ] Establish UCAN delegation tokens with appropriate constraints
- [ ] Configure revocation distribution (CRL endpoints, polling interval)
- [ ] Set up gateway routing table (external capability → internal agent)
- [ ] Define capability naming convention (internal.* / compute.* / discovery.*)
- [ ] Establish dispute resolution process with federation partners
- [ ] Configure WoT signature refresh schedule (re-sign every 90 days)

---

## Summary

AAFP federation is built on the principle that trust is sovereign and
local. Each organization controls its own trust anchors, policies, and
capability boundaries. Cross-organization trust is established through
bilateral cryptographic agreements — CA root sharing, WoT signatures,
and UCAN delegation chains — not through a global authority.

The `TrustManager` is the federation boundary, combining five trust
sources (direct, WoT, CA, directory, TOFU) with three policies (strict,
cautious, permissive). UCAN chains provide non-repudiable capability
delegation that can span multiple organizations, with cryptographic
guarantees that capabilities only narrow. The Web of Trust provides
decentralized transitive trust with conservative decay (one hop =
Marginal, two hops = None) to prevent trust inflation across
organizational boundaries.

Federation gateways bridge private and public networks, exposing only
sanctioned capabilities to external agents. Revocation overrides all
trust sources, providing a hard stop for compromised or malicious
agents. Disputes are resolved through UCAN chain auditing (for
capability abuse) and revocation (for key compromise), with trust
disagreements left unresolved by design — each org's trust decisions are
final within its own boundary.
