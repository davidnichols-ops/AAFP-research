# AAFP Trust Scoring & Reputation Systems

> **Scope**: How AAFP establishes, propagates, aggregates, and defends trust
> between autonomous agents — the hybrid trust model (TrustManager with five
> sources and three policies), the Web of Trust graph with transitive decay,
> the third-party attestation system with trust-weighted reputation scoring,
> Sybil resistance, gaming resistance, reputation attacks, reputation
> recovery, and cross-organization reputation portability.
>
> **Source code references**:
> - `aafp-identity/src/trust_manager.rs` — unified trust decision API (RFC 0011 §8)
> - `aafp-identity/src/web_of_trust.rs` — peer-to-peer trust signatures and transitive trust (RFC 0011 §4)
> - `aafp-identity/src/attestation.rs` — third-party attestations and `compute_reputation()` (ARE E3-E4)
> - `aafp-identity/src/extensions/reputation.rs` — `ReputationExtension` (attestation references)
> - `aafp-identity/src/ca_certificate.rs` — CA-signed certificates (RFC 0011 §5)
> - `aafp-identity/src/key_directory.rs` — AgentId → AgentRecord directory (RFC 0011 §3)
> - `aafp-identity/src/revocation.rs` — revocation lists and revocation store
> - `aafp-identity/src/ucan.rs` — UCAN capability delegation chains
> - `builder-prompts/ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` — attestation design specification

---

## Table of Contents

1. [Trust System Architecture](#1-trust-system-architecture)
2. [TrustManager: Five Sources, Three Policies](#2-trustmanager-five-sources-three-policies)
3. [Web of Trust: BFS and Transitive Decay](#3-web-of-trust-bfs-and-transitive-decay)
4. [Trust Levels: None, Marginal, Full, Ultimate](#4-trust-levels-none-marginal-full-ultimate)
5. [Trust Propagation Through the Network](#5-trust-propagation-through-the-network)
6. [Attestation System: Third-Party Verified Metrics](#6-attestation-system-third-party-verified-metrics)
7. [Reputation Scoring Algorithms](#7-reputation-scoring-algorithms)
8. [Sybil Resistance](#8-sybil-resistance)
9. [Gaming Resistance](#9-gaming-resistance)
10. [Reputation Attacks and Defenses](#10-reputation-attacks-and-defenses)
11. [Reputation Recovery](#11-reputation-recovery)
12. [Cross-Organization Reputation](#12-cross-organization-reputation)
13. [Concrete Reputation Scoring Implementation in Rust](#13-concrete-reputation-scoring-implementation-in-rust)
14. [Implementation Reference](#14-implementation-reference)

---

## 1. Trust System Architecture

AAFP's trust system is a **hybrid model** — it does not rely on a single
trust mechanism. Instead, it combines five independent trust sources into a
unified API, with three policy levels governing how the results are
enforced. This hybrid approach is necessary because no single trust model
works in all deployment scenarios:

- **Web of Trust** works well in decentralized, peer-to-peer settings where
  agents have met each other before. It fails for cold-start: a new agent
  with no signatures has no trust path.
- **Certificate Authorities** work well in enterprise settings where an
  organization can issue certs to its own agents. They fail in open
  networks where no one agrees on which CA to trust.
- **Key directories** work well when a trusted third party maintains a
  registry. They introduce a centralization point and a trust-on-first-use
  bootstrapping problem for the directory itself.
- **Direct trust (TOFU)** works well for repeat connections. It is
  vulnerable to first-contact attacks but is the pragmatic fallback when
  nothing else is available.
- **Revocation** is not a trust source but a trust override — a revoked
  key is rejected regardless of what other sources say.

The architecture layers these sources in priority order, with revocation
checking first (highest priority) and unknown/TOFU last (lowest priority).
The `TrustManager` struct in `trust_manager.rs` (line 89) is the single
entry point for all trust decisions. It is called after the cryptographic
handshake completes but before the application begins exchanging data —
this ensures that the peer's identity has been cryptographically verified
before the trust decision is made.

### 1.1 Design Principles

1. **Trust is local, not global.** Each agent maintains its own trust
   state. There is no global trust score. Agent A's trust in Agent B may
   differ from Agent C's trust in Agent B, because A and C have different
   WoT signatures, different CA roots, and different direct-trust caches.

2. **Trust is multi-dimensional.** A trust decision is not just "trusted
   or not" — it includes the *source* (how trust was established) and the
   *level* (how much trust). The `TrustResult` enum (line 51) carries
   both: `Trusted { source, level }`, `Untrusted { reason }`,
   `Revoked { reason }`, `Unknown { suggestion }`.

3. **Trust is policy-gated.** The same trust result can be accepted or
   rejected depending on the configured policy. A `Strict` policy rejects
   unknown peers; a `Permissive` policy accepts them via TOFU. This lets
   different agents in the same network operate at different trust
   thresholds.

4. **Self-reported data is unverified.** An agent's own claims about its
   performance, cost, and reputation are treated as claims, not facts.
   Only third-party attestations (signed by a different agent) carry
   verified metrics. This is the foundation of the reputation system's
   Sybil resistance.

5. **Revocation overrides everything.** A revoked key is rejected before
   any other trust source is consulted. This ensures that a compromised
   key cannot maintain trust through cached direct-trust entries or
   unexpired WoT signatures.

### 1.2 System Flow

```
Peer connects → Handshake completes (cryptographic key verification)
             → TrustManager::verify_peer(agent_id, public_key, ca_cert, now)
             → TrustResult returned
             → TrustManager::should_accept(result) applies policy
             → If accepted: session proceeds
             → If rejected: session terminated
             → If TOFU accepted: key added to direct-trust cache
```

The trust decision is made *after* the handshake, not during it. The
handshake verifies that the peer controls the private key corresponding to
the public key in their AgentRecord. The trust decision verifies whether
the local agent *should* trust that key. These are separate concerns:
cryptography answers "who is this?", trust answers "should I talk to
them?"

---

## 2. TrustManager: Five Sources, Three Policies

The `TrustManager` struct (`trust_manager.rs`, line 89) is the unified API
for all trust decisions. It holds:

```rust
pub struct TrustManager {
    own_agent_id: AgentId,
    direct_cache: Mutex<HashMap<AgentId, Vec<u8>>>,      // Source 1: Direct
    wot: Mutex<WebOfTrust>,                              // Source 2: WoT
    ca_verifier: Mutex<CaVerifier>,                      // Source 3: CA
    directory: Mutex<Option<KeyDirectory>>,              // Source 4: Directory
    revocation_store: Arc<Mutex<RevocationStore>>,       // Override: Revocation
    policy: TrustPolicy,                                 // Policy: Strict/Cautious/Permissive
}
```

### 2.1 The Five Trust Sources

The `TrustSource` enum (line 23) enumerates the five sources, in the order
they are consulted by `verify_peer()` (line 169):

| Priority | Source | Enum Variant | Trust Level | Description |
|----------|--------|-------------|-------------|-------------|
| 0 | Revocation | (override) | — | Checked first; if revoked, return immediately |
| 1 | Direct | `TrustSource::Direct` | Ultimate (3) | Previously connected peer, key cached |
| 2 | CA | `TrustSource::CertificateAuthority` | Full (2) | CA-signed certificate verified against trusted roots |
| 3 | WoT | `TrustSource::WebOfTrust` | Marginal–Full (1–2) | Transitive trust from WoT signatures |
| 4 | Directory | `TrustSource::Directory` | Full (2) | Record from a trusted key directory |
| 5 | Unknown | `TrustSource::Tofu` | — | No trust info; suggestion provided |

**Source 1: Direct Trust (TOFU cache).** When an agent successfully
connects to a peer and accepts it via TOFU (trust on first use), the
peer's public key is cached in `direct_cache`. On subsequent connections,
if the cached key matches the presented key, the peer is trusted at
**Ultimate** level (3) — the highest level, reserved for keys the agent
has directly verified. If the key does *not* match, the result is
`Untrusted` with reason "public key mismatch with cached direct trust" —
this is a key-change event, which may indicate compromise.

**Source 2: CA Certificate.** If the peer presents a `CaCertificate`
(`ca_certificate.rs`), it is verified against the agent's trusted root
CAs (added via `add_trusted_ca()`). If the certificate is valid (signature
verifies, not expired, not revoked), the peer is trusted at **Full** level
(2). CA verification failure does not immediately reject the peer — it
falls through to other sources. This allows a peer with an expired CA
cert to still be trusted via WoT or direct trust.

**Source 3: Web of Trust.** The `WebOfTrust` graph is queried for the
peer's trust level via `trust_level()` (line 423 of `web_of_trust.rs`).
If the level is **Marginal** (1) or above, the peer is trusted. The WoT
can return Full (2) for direct signatures or Marginal (1) for one-hop
transitive trust. See §3 for details.

**Source 4: Key Directory.** If a `KeyDirectory` is configured (via
`with_directory()`), it is queried for the peer's AgentRecord. If the
record exists, its public key must match the presented key, and the
record's signature must verify. If both checks pass, the peer is trusted
at **Full** level (2). A key mismatch returns `Untrusted` immediately.

**Source 5: Unknown.** If none of the above sources produce a trust
decision, the result is `Unknown` with a suggestion for how to establish
trust. The suggestion depends on what infrastructure is available:
- If a directory is configured: `QueryDirectory` (look up the key)
- If the WoT has signatures: `RequestWotSignature` (ask a mutual contact)
- Otherwise: `Tofu` (trust on first use, show fingerprint to user)

### 2.2 The Three Trust Policies

The `TrustPolicy` enum (line 77) governs how `should_accept()` (line 260)
interprets the trust result:

| Policy | Trusted | Untrusted | Revoked | Unknown |
|--------|---------|-----------|---------|---------|
| **Strict** | Accept | Reject | Reject | Reject |
| **Cautious** (default) | Accept | Reject | Reject | Reject (would prompt in interactive mode) |
| **Permissive** | Accept | Reject | Reject | Accept (TOFU) |

```rust
pub fn should_accept(&self, result: &TrustResult) -> bool {
    match (&self.policy, result) {
        (_, TrustResult::Trusted { .. }) => true,
        (_, TrustResult::Revoked { .. }) => false,
        (TrustPolicy::Strict, TrustResult::Untrusted { .. }) => false,
        (TrustPolicy::Strict, TrustResult::Unknown { .. }) => false,
        (TrustPolicy::Cautious, TrustResult::Untrusted { .. }) => false,
        (TrustPolicy::Cautious, TrustResult::Unknown { .. }) => false,
        (TrustPolicy::Permissive, TrustResult::Untrusted { .. }) => false,
        (TrustPolicy::Permissive, TrustResult::Unknown { .. }) => true, // TOFU
    }
}
```

Key observations:

- **All policies accept `Trusted` and reject `Revoked`.** Revocation is
  absolute — no policy can override it.
- **All policies reject `Untrusted`.** An `Untrusted` result means a trust
  source was found but verification failed (e.g., key mismatch, bad
  signature). This is different from `Unknown`, which means no trust
  information was found at all.
- **The only difference between policies is how `Unknown` is handled.**
  `Strict` and `Cautious` reject unknown peers. `Permissive` accepts them
  via TOFU. The `Cautious` policy is the default because it is the safest
  non-interactive policy — in interactive mode, it would prompt the user.

### 2.3 Revocation Override

Revocation is checked first, before any other source (line 177):

```rust
if self.revocation_store.lock().unwrap().is_revoked(agent_id) {
    return TrustResult::Revoked {
        reason: "agent_id is in revocation store".into(),
    };
}
```

This means a revoked key is rejected even if it has a valid direct-trust
cache entry, a valid CA certificate, and a valid WoT signature. The test
`test_revocation_overrides_direct_trust` (line 548) verifies this: an
agent with direct trust is revoked, and the revocation takes precedence.

Revocation lists (`RevocationList`) are signed documents that enumerate
revoked AgentIds. They are added to the `RevocationStore` via
`add_crl()`. Each revocation entry includes a reason string (e.g.,
"compromised") and a timestamp.

---

## 3. Web of Trust: BFS and Transitive Decay

The `WebOfTrust` struct (`web_of_trust.rs`, line 352) implements the
peer-to-peer trust graph. It stores `TrustSignature` objects — signed
statements where one agent asserts trust in another agent's key — and
computes transitive trust levels using breadth-first search (BFS).

### 3.1 TrustSignature

A `TrustSignature` (line 98) is a signed statement: "Agent `signer`
trusts agent `signed`'s key at `trust_level` until `expiry`." It is signed
with ML-DSA-65 (post-quantum signatures) over a domain-separated CBOR
encoding:

```rust
pub struct TrustSignature {
    pub sig_type: String,           // "aafp-wot-sig-v1"
    pub signer_agent_id: AgentId,   // 32-byte ID of signer
    pub signed_agent_id: AgentId,   // 32-byte ID of signed agent
    pub signed_public_key: Vec<u8>, // 1952-byte ML-DSA-65 key
    pub trust_level: u8,            // 0-3
    pub expiry: u64,                // unix timestamp
    pub signature: Vec<u8>,         // ML-DSA-65 over fields 1-6
}
```

The signature input is `WOT_DOMAIN_SEPARATOR ("aafp-v1-wot") || CBOR(fields 1-6)`.
Domain separation prevents signature reuse across different AAFP protocols
(an attestation signature cannot be replayed as a WoT signature, and vice
versa).

Verification (`verify()`, line 294) checks five conditions:
1. `sig_type == "aafp-wot-sig-v1"`
2. `signed_agent_id == SHA-256(signed_public_key)` (the ID must be
   derived from the key being signed)
3. `trust_level` is in range [0, 3]
4. Signature verifies using the signer's public key
5. `expiry > now` (if `now` is provided)

The recommended validity period is 90 days
(`RECOMMENDED_WOT_VALIDITY_SECS`, line 40). This forces periodic
re-signing, which keeps the WoT graph fresh and ensures that stale trust
relationships expire.

### 3.2 WebOfTrust Graph Structure

The `WebOfTrust` stores signatures in a `HashMap<AgentId, Vec<TrustSignature>>`
keyed by signer. This allows efficient lookup of all agents trusted by a
given signer — the primary operation for BFS traversal.

```rust
pub struct WebOfTrust {
    own_agent_id: Option<AgentId>,                          // trust root
    signatures: HashMap<AgentId, Vec<TrustSignature>>,      // signer → sigs
    known_public_keys: HashMap<AgentId, Vec<u8>>,           // for verification
}
```

The `own_agent_id` is the trust root — the BFS starts here. All trust
paths are computed relative to this agent's position in the graph.

### 3.3 BFS Trust Computation

The `trust_level()` method (line 423) computes the trust level for a
target agent using a bounded BFS from `own_agent_id`:

```
trust_level(target, now):
  1. If target == own_agent_id: return Ultimate (3)
  2. Check direct signatures from own_agent_id → target
     - If found and not expired: return signed level (capped at Full=2)
  3. Check one-hop transitive trust:
     - For each agent X that own_agent_id trusts (≥ Marginal):
       - Check if X directly trusts target
       - If yes: return Marginal (1)
  4. Two+ hops: return None (0) — no further BFS
```

The BFS is **bounded to two levels** (direct + one hop). This is a
deliberate design choice from RFC 0011 §2.1: transitive trust decays
rapidly, and trust beyond one hop is considered unreliable. The decay
schedule is:

| Hop Distance | Trust Level | Rationale |
|-------------|-------------|-----------|
| 0 (self) | Ultimate (3) | Only for own key |
| 1 (direct) | As signed (max Full=2) | Directly verified |
| 2 (one hop) | Marginal (1) | Transitive, reduced |
| 3+ (two+ hops) | None (0) | Too far, unreliable |

The BFS implementation (lines 434-489) is straightforward:

```rust
// Level 0: direct signatures
if let Some(direct_sigs) = self.signatures.get(own) {
    for sig in direct_sigs {
        if sig.is_expired(now) { continue; }
        if &sig.signed_agent_id == target {
            let level = sig.trust_level.min(TRUST_LEVEL_FULL);
            if level > best { best = level; }
        }
    }
}
if best >= TRUST_LEVEL_MARGINAL { return best; }

// Level 1: one-hop transitive trust
if let Some(direct_sigs) = self.signatures.get(own) {
    for sig in direct_sigs {
        if sig.is_expired(now) { continue; }
        if sig.trust_level < TRUST_LEVEL_MARGINAL { continue; }
        let intermediary = &sig.signed_agent_id;
        if intermediary == target { continue; }
        if let Some(inter_sigs) = self.signatures.get(intermediary) {
            for inter_sig in inter_sigs {
                if inter_sig.is_expired(now) { continue; }
                if &inter_sig.signed_agent_id == target {
                    if TRUST_LEVEL_MARGINAL > best { best = TRUST_LEVEL_MARGINAL; }
                }
            }
        }
}
```

Expired signatures are silently skipped at every level. The
`evict_expired()` method (line 537) can be called periodically to remove
expired signatures from storage, keeping the graph compact.

### 3.4 Why Bounded BFS?

An unbounded BFS (computing trust paths of arbitrary length) has several
problems:

1. **Computational cost.** In a large WoT graph, BFS to depth N is
   O(branching^N). With 90-day signature validity and agents signing
   dozens of peers, the graph can be dense.

2. **Trust decay.** Trust attenuates with distance. If A trusts B, and B
   trusts C, and C trusts D, and D trusts E — does A really trust E? At
   four hops, the trust signal is noise. RFC 0011 caps this at one hop
   (Marginal) and drops everything beyond.

3. **Attack surface.** Longer trust paths are easier to manipulate. An
   attacker who compromises one key can sign many others, who sign many
   others, creating long trust chains. Bounding the BFS to one hop limits
   the blast radius of a single compromise.

4. **Predictability.** A bounded BFS produces deterministic, reproducible
   trust levels. An unbounded BFS with path-finding heuristics would be
   harder to reason about and test.

---

## 4. Trust Levels: None, Marginal, Full, Ultimate

AAFP defines four trust levels (RFC 0011 §2), encoded as `u8` constants
in `web_of_trust.rs`:

| Level | Constant | Value | Meaning |
|-------|----------|-------|---------|
| None | `TRUST_LEVEL_NONE` | 0 | No trust — do not rely on this agent |
| Marginal | `TRUST_LEVEL_MARGINAL` | 1 | Minimal trust — suitable for low-stakes interactions |
| Full | `TRUST_LEVEL_FULL` | 2 | Strong trust — suitable for most interactions |
| Ultimate | `TRUST_LEVEL_ULTIMATE` | 3 | Absolute trust — only for the agent's own key |

### 4.1 None (0)

**None** means no trust path exists. The agent is unknown, or all trust
paths have expired, or the only paths go through agents trusted at None
level. In practice:

- `verify_peer()` returns `Unknown` (if no other source matches) or
  `Untrusted` (if a source matched but failed verification).
- Under `Strict` and `Cautious` policies, the connection is rejected.
- Under `Permissive` policy, the connection may be accepted via TOFU.
- In reputation scoring, an attester at None level gets weight 0.0 —
  their attestations are ignored entirely.

### 4.2 Marginal (1)

**Marginal** means minimal trust, typically established through one-hop
transitive WoT trust. The agent is vouched for by someone you trust, but
you have not directly verified them. In practice:

- Suitable for low-stakes interactions: read-only queries, idempotent
  operations, non-sensitive data exchange.
- Not suitable for high-stakes interactions: financial transactions,
  data writes, operations with side effects.
- In reputation scoring, an attester at Marginal level gets weight 0.5 —
  their attestations count, but at half the weight of a Full-trust
  attester.
- The `is_trusted()` method (line 492) can check for a minimum level:
  `wot.is_trusted(&target, TRUST_LEVEL_MARGINAL, now)` returns true if
  the target is trusted at Marginal or above.

### 4.3 Full (2)

**Full** means strong trust, established through:
- A direct WoT signature at Full level (you personally signed their key)
- A valid CA certificate (a trusted CA vouches for them)
- A verified key directory record (a trusted directory vouches for them)

In practice:
- Suitable for most interactions, including data writes and operations
  with side effects.
- The maximum level that can be granted transitively — one-hop trust
  never exceeds Marginal, and direct WoT signatures are capped at Full.
- In reputation scoring, an attester at Full level gets weight 1.0 —
  their attestations count at full strength.

### 4.4 Ultimate (3)

**Ultimate** means absolute trust, reserved exclusively for the agent's
own key. It is never granted transitively, never granted via CA, and
never granted via directory. The only way to get Ultimate trust is to
*be* the agent. In practice:

- `trust_level()` returns Ultimate when `target == own_agent_id` (line 430).
- Direct-trust cache entries return Ultimate (line 188 of
  `trust_manager.rs`) — because if you cached the key, you have directly
  verified it, which is the strongest form of trust.
- In reputation scoring, Ultimate gets weight 1.0 (same as Full). The
  distinction between Ultimate and Full is semantic: Ultimate means "this
  is me" or "I have personally verified this key and cached it," while
  Full means "a trusted intermediary vouches for this key."

### 4.5 Level Capping

Direct WoT signatures can be signed at any level 0-3, but
`trust_level()` caps the result at Full (2) for direct signatures (line
443):

```rust
let level = sig.trust_level.min(TRUST_LEVEL_FULL);
```

This means even if someone signs another agent's key at Ultimate (3),
the trust computation treats it as Full (2). Ultimate is reserved for
self. This prevents an agent from delegating Ultimate trust to another
agent, which would break the invariant that Ultimate means "self."

---

## 5. Trust Propagation Through the Network

Trust propagation is the process by which trust flows through the WoT
graph. The core question: if A trusts B, and B trusts C, does A trust C?

### 5.1 Direct Trust (Hop 0)

If A has directly signed B's key at Full trust, A trusts B at Full (2).
This is the strongest form of WoT trust — A has personally verified B's
key (ideally through an out-of-band channel like in-person key exchange
or verified fingerprint comparison).

```
A --[Full]--> B
```

A's trust level for B: **Full (2)**

### 5.2 One-Hop Transitive Trust (Hop 1)

If A trusts B (at Marginal or above), and B trusts C (at any level ≥
Marginal), then A marginally trusts C:

```
A --[Full]--> B --[Full]--> C
```

A's trust level for C: **Marginal (1)**

The intermediary (B) must be trusted at Marginal or above — if A trusts
B at None, B's signatures are not followed. The signed level of B's
signature on C does not matter for the result — one-hop trust is always
Marginal, regardless of whether B signed C at Marginal or Full. This is
the decay rule: transitive trust drops to Marginal after one hop.

### 5.3 Two+ Hops (No Trust)

If A trusts B, B trusts C, and C trusts D, A does not trust D:

```
A --[Full]--> B --[Full]--> C --[Full]--> D
```

A's trust level for D: **None (0)**

The BFS does not traverse beyond one hop. This is a hard limit, not a
gradual decay to zero. The rationale is that trust beyond one hop is too
attenuated to be meaningful — if you don't know someone who knows them,
you don't trust them.

### 5.4 Multiple Paths

If there are multiple trust paths to a target, the highest level wins.
For example, if A directly trusts C at Full (direct signature) and also
has a one-hop path through B, the direct Full trust takes precedence:

```
A --[Full]--> C          (direct, Full)
A --[Full]--> B --[Full]--> C  (one-hop, Marginal)
```

A's trust level for C: **Full (2)** (the maximum of direct and
transitive)

The implementation handles this by checking direct signatures first
(line 436) and returning early if `best >= TRUST_LEVEL_MARGINAL` (line
450). If direct trust is found at Full, it returns immediately without
checking transitive paths. If direct trust is found at Marginal, it
returns Marginal (since one-hop can only produce Marginal, there's no
point checking further).

### 5.5 Expired Signatures

Expired signatures are silently skipped during trust computation. If A
signed B at Full but the signature has expired, it's as if the signature
doesn't exist. This means:

- Trust relationships must be actively maintained (re-signed every 90
  days).
- Stale trust automatically decays — if A stops signing B, B's trust
  from A fades after the signature expires.
- The `evict_expired()` method can remove expired signatures from
  storage to keep the graph compact.

### 5.6 Trust Propagation Example

Consider this WoT graph:

```
        Alice
       /    \
    [Full]  [Marginal]
     /        \
   Bob       Carol
    |           \
  [Full]      [Full]
    |            \
  Dave          Eve
```

Alice's trust levels:
- **Alice → Alice**: Ultimate (3) — self
- **Alice → Bob**: Full (2) — direct signature at Full
- **Alice → Carol**: Marginal (1) — direct signature at Marginal
- **Alice → Dave**: Marginal (1) — one-hop through Bob (Alice trusts Bob
  at Full, Bob trusts Dave at Full → Alice trusts Dave at Marginal)
- **Alice → Eve**: Marginal (1) — one-hop through Carol (Alice trusts
  Carol at Marginal, Carol trusts Eve at Full → Alice trusts Eve at
  Marginal)
- **Alice → (anyone else)**: None (0) — no trust path within two hops

Note that even though Bob signed Dave at Full, Alice's trust in Dave is
only Marginal — transitive trust always decays to Marginal after one
hop, regardless of the signed level.

---

## 6. Attestation System: Third-Party Verified Metrics

The attestation system (ARE E3-E4, `attestation.rs`) is the mechanism for
third-party verified reputation. It addresses a fundamental problem:
**self-reported metrics are not trustworthy.** An agent can claim "I have
99.9% uptime" or "my trust score is 95" in its AgentRecord extensions,
but these are just claims. Attestations are signed statements from *other*
agents that verify these claims based on observed interactions.

### 6.1 Attestation Structure

An `Attestation` is a separate signed document, stored in the DHT under a
different key namespace from AgentRecords. It is **not** part of the
AgentRecord signature — it is signed by the attester, not the subject.

```rust
pub struct Attestation {
    pub record_type: String,           // "aafp-attestation-v1"
    pub subject_agent_id: AgentId,     // agent being attested about
    pub attester_agent_id: AgentId,    // agent issuing the attestation
    pub attester_public_key: Vec<u8>,  // attester's ML-DSA-65 key
    pub attested_at: u64,              // when created
    pub expires_at: u64,               // when it expires
    pub data: AttestationData,         // the metrics
    pub signature: Vec<u8>,            // ML-DSA-65 over domain_sep || cbor
}
```

The `AttestationData` carries the verified metrics:

```rust
pub struct AttestationData {
    pub observed_avg_latency_ms: Option<u16>,    // observed latency
    pub observed_success_rate_bps: Option<u16>,  // 10000 = 100%
    pub sample_count: u32,                       // interactions observed
    pub trust_score: u8,                         // 0-100
    pub notes: Option<String>,                   // free-text (max 256 bytes)
}
```

The `sample_count` field is critical for Sybil resistance — it indicates
how many interactions the attester observed before issuing the
attestation. A high sample count means the attester has real experience
with the subject; a low sample count means the attestation is based on
few data points and should be discounted.

### 6.2 Domain Separation

Attestations use a separate domain separator:
`ATTESTATION_DOMAIN_SEPARATOR = "aafp-v1-attestation"`. This is distinct
from the WoT domain separator (`"aafp-v1-wot"`) and the AgentRecord
domain separator. Domain separation prevents cross-protocol signature
replay: an attestation signature cannot be reused as a WoT signature or
vice versa.

### 6.3 Signing and Verification

Attestations are created with `create_and_sign()` (line 1052), which
signs the attestation with the attester's ML-DSA-65 secret key. The
signature is over `domain_sep || CBOR(fields 1-7)` — all fields except
the signature itself.

Verification (`verify()`, line 1099) checks four conditions:
1. `attester_agent_id == SHA-256(attester_public_key)` — the attester's
   ID must match their key
2. `record_type == "aafp-attestation-v1"` — type check
3. Signature is valid over the domain-separated CBOR
4. `expires_at > now` — not expired

### 6.4 DHT Storage

Attestations are stored in the DHT under a deterministic key:
`SHA-256("aafp-attestation" || subject || attester)`. This means:
- The same (subject, attester) pair always maps to the same DHT key.
- A new attestation from the same attester about the same subject
  overwrites the previous one — only the latest attestation from each
  attester about each subject is stored.
- Anyone can look up all attestations about a subject by scanning the
  attestation key namespace.

### 6.5 ReputationExtension: References, Not Scores

The `ReputationExtension` (namespace `"aafp.reputation.v1"`) in an
agent's AgentRecord carries *references* to attestations, not the
attestations themselves and not a computed score:

```rust
pub struct ReputationExtension {
    pub attestation_refs: Vec<String>,      // SHA-256 hashes, hex
    pub self_claimed_score: Option<u8>,     // 0-100, UNVERIFIED
    pub attestation_sources: Vec<String>,   // DHT keys / URLs
    pub updated_at: u64,
}
```

The `self_claimed_score` is explicitly labeled as unverified. It is
useful only as a hint — consumers MUST NOT use it for ranking or trust
decisions. The actual reputation score is computed by the *discovering*
agent from the referenced attestations, weighted by the discovering
agent's trust relationship with each attester (see §7).

This design ensures that:
1. Agents cannot self-boost their reputation by lying about their score.
2. The reputation score is computed from the *consumer's* perspective,
   not the subject's — different consumers may compute different scores
   for the same agent based on their different trust relationships.
3. Attestations are stored separately and can be independently verified,
   not just trusted on the subject's say-so.

### 6.6 UCAN Authorization for Attestations

Attestations can be authorized via UCAN capability delegation. An agent
can delegate the `attest.reputation` capability to another agent,
authorizing them to issue attestations about the delegating agent's
performance:

```rust
pub fn delegate_attest_capability(
    issuer: &AgentKeypair,
    audience: &AgentId,
    expires_at: u64,
) -> Result<UcanToken, IdentityError>
```

The `verify_attestation_authorization()` function (line 1282) checks:
1. The UCAN chain is valid (signatures, linkage, no capability expansion)
2. The leaf token delegates `attest.reputation` with `invoke` action
3. The leaf token's audience matches the attester's AgentId
4. The chain is not expired

This enables **delegated attestation**: "Agent A delegates to Agent B the
right to attest to A's performance." This is useful for monitoring
agents, auditors, or reputation services that observe interactions on
behalf of the subject.

---

## 7. Reputation Scoring Algorithms

The `compute_reputation()` function (line 1176) aggregates attestations
into a single reputation score. This section documents the algorithm and
several alternatives.

### 7.1 Simple Average (Baseline)

The simplest reputation score is the unweighted average of all
attestation trust scores:

```
score = sum(trust_score_i) / count(attestations)
```

This is the baseline. It is simple but has critical weaknesses:
- Every attestation counts equally, regardless of attester trustworthiness.
- A Sybil attacker can create many identities, each issuing a high-score
  attestation, inflating the average.
- A single bad attestation from an untrusted source drags down the score
  of a reputable agent.

AAFP does **not** use simple average. It is documented here only as the
baseline against which the weighted algorithm is compared.

### 7.2 Weighted by Trust Level (AAFP's Algorithm)

AAFP's `compute_reputation()` weights each attestation by the discovering
agent's trust level with the attester. The weight mapping:

| Trust Result | Trust Level | Weight | Rationale |
|-------------|-------------|--------|-----------|
| Trusted | Ultimate (3) | 1.0 | Self or directly verified |
| Trusted | Full (2) | 1.0 | Strong trust, full weight |
| Trusted | Marginal (1) | 0.5 | Transitive trust, half weight |
| Trusted | None (0) | 0.0 | No trust, ignored |
| Unknown | — | 0.1 | TOFU: small weight, allows bootstrapping |
| Untrusted | — | 0.0 | Verification failed, ignored |
| Revoked | — | 0.0 | Revoked, ignored |

The formula:

```
score = sum(weight_i * trust_score_i) / sum(weight_i)
```

The implementation (lines 1184-1236):

```rust
for att in attestations {
    if att.verify(now).is_err() { continue; }       // skip invalid
    if att.attester_agent_id == att.subject_agent_id { continue; }  // no self-attest

    let trust = trust_manager.verify_peer(
        &att.attester_agent_id, &att.attester_public_key, None, now,
    );
    let weight = match trust {
        TrustResult::Trusted { level, .. } => match level {
            TRUST_LEVEL_ULTIMATE => 1.0,
            TRUST_LEVEL_FULL => 1.0,
            TRUST_LEVEL_MARGINAL => 0.5,
            _ => 0.0,
        },
        TrustResult::Unknown { .. } => 0.1,  // TOFU
        _ => 0.0,  // Untrusted or Revoked
    };

    if weight == 0.0 { continue; }

    // Sample count discount (Sybil resistance)
    let sample_factor = if att.data.sample_count < 10 { 0.3 }
        else if att.data.sample_count < 100 { 0.7 }
        else { 1.0 };

    let final_weight = weight * sample_factor;
    weighted_sum += final_weight * att.data.trust_score as f64;
    total_weight += final_weight;
}

if total_weight > 0.0 { Some(weighted_sum / total_weight) } else { None }
```

**Why TOFU gets 0.1, not 0.0:** A weight of 0.0 would mean unknown
attesters are completely ignored, which prevents reputation
bootstrapping. A new agent with no WoT signatures would have no
attestations that count, creating a chicken-and-egg problem: no
reputation → no one uses them → no one attests → no reputation. The 0.1
weight allows unknown attesters to contribute a small amount, enough to
bootstrap but not enough to dominate. A single Full-trust attester
(weight 1.0) outweighs ten unknown attesters (weight 0.1 each).

**Worked example:** Two attestations about subject S:
- Attester A1: Full trust, sample_count=200, trust_score=90
  - weight = 1.0 * 1.0 = 1.0, contribution = 1.0 * 90 = 90
- Attester A2: Unknown (TOFU), sample_count=200, trust_score=50
  - weight = 0.1 * 1.0 = 0.1, contribution = 0.1 * 50 = 5
- Score = (90 + 5) / (1.0 + 0.1) = 95 / 1.1 ≈ **86.36**

This is verified by the test `compute_reputation_with_trusted_attesters`
(line 1789).

### 7.3 Bayesian Average (For Few Ratings)

A problem with weighted average is that with few attestations, the score
is volatile. A single attestation with trust_score=100 gives a score of
100, which may be misleading. The **Bayesian average** addresses this by
pulling the score toward a prior (typically the global average) when
there are few ratings:

```
bayesian_score = (C * prior + sum(weight_i * score_i)) / (C + sum(weight_i))
```

Where:
- `C` is a confidence constant (e.g., 10 — the equivalent of 10
  "prior" attestations)
- `prior` is the prior mean (e.g., 50 — the midpoint of the 0-100 scale,
  or the global average across all agents)

With one attestation (trust_score=100, weight=1.0):
```
bayesian_score = (10 * 50 + 1.0 * 100) / (10 + 1.0) = 600 / 11 ≈ 54.5
```

With ten attestations (all trust_score=100, total weight=10.0):
```
bayesian_score = (10 * 50 + 10.0 * 100) / (10 + 10.0) = 1500 / 20 = 75.0
```

With 100 attestations (all trust_score=100, total weight=100.0):
```
bayesian_score = (10 * 50 + 100.0 * 100) / (10 + 100.0) = 10500 / 110 ≈ 95.5
```

The Bayesian average starts at the prior (50) and converges to the
weighted average as more attestations accumulate. This prevents a single
attestation from creating an extreme score. AAFP's current implementation
does not use Bayesian averaging — it is documented here as a recommended
enhancement for scenarios with sparse attestation data.

### 7.4 Decay Over Time (Recent Attestations Weighted Higher)

Attestations have an `expires_at` field, and expired attestations are
skipped entirely. But within the valid window, older attestations could
be weighted lower than recent ones, reflecting the fact that agent
performance changes over time.

A time-decay weight can be applied as a multiplier on top of the trust
weight:

```
time_weight = exp(-lambda * (now - attested_at))
final_weight = trust_weight * sample_factor * time_weight
```

Where `lambda` is the decay rate. For example, with a half-life of 30
days:
```
lambda = ln(2) / (30 * 86400) ≈ 2.67e-7 per second
```

An attestation from 30 days ago gets weight 0.5, from 60 days ago gets
0.25, from 90 days ago gets 0.125. This ensures that recent performance
matters more than historical performance, which is important for
reputation recovery (see §11) — an agent that had problems in the past
but has been reliable recently should have a recovering score, not one
permanently anchored to old data.

AAFP's current implementation uses binary expiry (valid or expired) but
not continuous decay. Continuous decay is a recommended enhancement.

### 7.5 Sybil Resistance (Weight by Attester's Own Trust)

The primary Sybil resistance mechanism in AAFP's reputation system is
that attester weight is determined by the *discovering agent's trust
relationship with the attester*, not by the attester's self-proclaimed
reputation. This means:

1. **Sybil identities get low weight.** A newly created Sybil identity
   has no WoT path from the discovering agent, no CA cert, and no
   directory entry. It gets `TrustResult::Unknown` → weight 0.1 (TOFU).
   Even if an attacker creates 100 Sybil identities, each issuing a
   trust_score=100 attestation, their combined weight is 100 * 0.1 = 10,
   which is equivalent to 10 Full-trust attestations. A single
   Full-trust attester with trust_score=0 can offset this: (1.0 * 0 +
   10.0 * 100) / 11 ≈ 90.9 — still high, but the point is that Sybil
   identities cannot dominate without establishing real trust.

2. **Self-attestations are excluded.** `compute_reputation()` skips any
   attestation where `attester_agent_id == subject_agent_id` (line 1191).
   An agent cannot boost its own score.

3. **Sample count discounting.** Low-sample attestations are discounted:
   - `sample_count < 10`: weight *= 0.3 (70% discount)
   - `sample_count < 100`: weight *= 0.7 (30% discount)
   - `sample_count >= 100`: weight *= 1.0 (no discount)

   This forces an attacker to observe real interactions (at least 100)
   to produce full-weight attestations. Creating Sybil identities is
   cheap; observing 100 real interactions with a target is not.

4. **CA-signed attesters get Full weight.** Agents with CA-signed
   certificates get `TrustResult::Trusted { level: Full }` → weight 1.0.
   Sybil identities cannot obtain CA certs without out-of-band
   verification, so their attestations are limited to TOFU weight (0.1).

5. **Rate limiting.** The `KeyDirectory` already rate-limits publishing
   to 1/AgentId/hour. Attestation publishing should have similar limits
   to prevent flooding the DHT with Sybil attestations.

See §8 for a detailed analysis of Sybil resistance.

---

## 8. Sybil Resistance

A **Sybil attack** is when an adversary creates multiple fake identities
to gain disproportionate influence in a network. In a reputation system,
the goal is to inflate a target's reputation (self-Sybil) or deflate a
victim's reputation (bad-mouthing Sybil).

### 8.1 Attack Model

The attacker creates N Sybil identities: S1, S2, ..., SN. Each Sybil
identity:
1. Generates an ML-DSA-65 keypair (free, no cost)
2. Creates an AgentRecord (free, just a signature)
3. Publishes to the DHT (rate-limited to 1/AgentId/hour)
4. Issues an attestation about the target with trust_score=100

The attacker's goal: make the target's reputation score appear high (if
target is the attacker) or low (if bad-mouthing a victim).

### 8.2 Defense: Trust-Weighted Scoring

The core defense is that `compute_reputation()` weights attestations by
the discovering agent's trust level with the attester. Sybil identities
have no trust relationship with the discovering agent, so they get:

- `TrustResult::Unknown` → weight 0.1 (TOFU)

To get higher weight, a Sybil identity would need:
- A WoT signature from a trusted agent (requires social engineering or
  key compromise)
- A CA certificate (requires out-of-band verification with a CA the
  discovering agent trusts)
- A key directory entry (requires publishing to a directory the
  discovering agent trusts, and the directory must accept the record)

All of these require establishing real-world trust, which is expensive
and cannot be done at scale.

### 8.3 Quantitative Analysis

Suppose the discovering agent has one Full-trust attester (weight 1.0)
who gives the target a trust_score of 50. The attacker creates N Sybil
identities, each giving trust_score=100:

```
score = (1.0 * 50 + N * 0.1 * 100) / (1.0 + N * 0.1)
      = (50 + 10N) / (1 + 0.1N)
```

| N (Sybils) | Score | Effect |
|-----------|-------|--------|
| 0 | 50.0 | Baseline |
| 1 | 54.5 | Small boost |
| 10 | 59.1 | Moderate boost |
| 100 | 91.7 | Large boost |
| 1000 | 99.0 | Near-total inflation |

With 1000 Sybils, the attacker can inflate the score to 99.0 despite the
trusted attester giving 50. This is a vulnerability — but it requires
creating 1000 identities, each publishing to the DHT (rate-limited to
1/hour), and each issuing an attestation. The cost is:
- 1000 key generations (fast, free)
- 1000 DHT publishes (rate-limited: 1000 hours = 41.7 days minimum)
- 1000 attestations (each must be stored in the DHT)

The rate limiting makes large-scale Sybil attacks slow. Additionally,
the sample_count discounting further reduces Sybil impact: if each Sybil
claims sample_count < 10, their weight is 0.1 * 0.3 = 0.03, requiring
~3300 Sybils to achieve the same effect as 1000 undiscounted Sybils.

### 8.4 Enhanced Defenses (Future Work)

Stronger Sybil resistance could be achieved with:

1. **Proof of work** for attestation publishing: each attestation must
   include a hashcash-style proof, making mass creation computationally
   expensive.

2. **Staking/slashing**: attesters must stake tokens to issue
   attestations; fraudulent attestations result in slashing. This adds
   economic cost to Sybil attacks.

3. **Social graph analysis**: detect dense clusters of mutually-attesting
   identities (Sybil rings) and discount their attestations.

4. **Reputation of the attester**: weight attestations by the attester's
   own reputation score (recursive). This creates a "reputation of
   reputation" system where high-reputation attesters have more
   influence. The challenge is bootstrapping: new attesters have no
   reputation, so their attestations get low weight.

5. **Minimum trust threshold**: ignore attestations from attesters below
   a minimum trust level (e.g., ignore all Unknown/TOFU attestations).
   This eliminates Sybil influence entirely but also prevents
   bootstrapping.

---

## 9. Gaming Resistance

**Gaming** is when an agent manipulates the reputation system to its
advantage without creating Sybil identities. This includes fake
attestations, collusion, and strategic behavior.

### 9.1 Fake Attestations

An attester signs an attestation with metrics that don't reflect reality
— e.g., claiming trust_score=100 for a poor-performing agent.

**Defense:** Attestations are signed by the attester, so they are
non-repudiable. If an attester is caught issuing fake attestations, their
own reputation should suffer (through other agents downgrading their WoT
trust or issuing negative attestations about the attester). The
trust-weighted scoring means that if the discovering agent doesn't trust
the fake attester, the fake attestation gets low weight.

### 9.2 Collusion

Multiple attesters cooperate to boost each other's reputation: A
attests B is great, B attests A is great, creating a mutual admiration
ring.

**Defense:** The trust-weighted scoring limits this. If A and B are both
unknown to the discovering agent, their attestations about each other
get TOFU weight (0.1). If A and B are both Full-trust, their mutual
attestations get weight 1.0 — but this means the discovering agent
already trusts both of them, so the collusion doesn't change the outcome
much. The real risk is when one colluder has high trust and boosts
another: a Full-trust A attests B is great, giving B a high score. This
is not really an attack — if the discovering agent trusts A, they should
weight A's assessment of B. The defense is diversity: the score
aggregates multiple attestations, so one colluder's influence is diluted
by other, independent attestations.

### 9.3 Strategic Attestation

An attester issues attestations strategically: positive for allies,
negative for competitors, to manipulate market dynamics.

**Defense:** This is fundamentally a social problem, not a cryptographic
one. The system can detect patterns (e.g., an attester whose scores
correlate strongly with a specific group) but cannot prevent biased
attestation. The trust-weighted scoring means that if the discovering
agent trusts the biased attester, they accept the bias. The defense is
for the discovering agent to maintain a diverse set of trusted attesters,
so no single biased attester dominates.

### 9.4 Attestation Flooding

An attacker floods the DHT with attestations about many subjects,
polluting the reputation data.

**Defense:** Rate limiting on attestation publishing (1/AgentId/hour,
matching the KeyDirectory limit) would prevent flooding. Additionally,
the DHT key derivation (`SHA-256("aafp-attestation" || subject ||
attester)`) means each (subject, attester) pair maps to one key — an
attacker can only have one active attestation per subject, limiting
flooding to one attestation per subject per attester.

---

## 10. Reputation Attacks and Defenses

### 10.1 Bad-Mouthing

**Attack:** An attacker issues negative attestations (low trust_score)
about a victim to damage their reputation.

**Defense:** The trust-weighted scoring limits the damage. If the
attacker is unknown to the discovering agent, their negative attestation
gets weight 0.1 — minimal impact. If the attacker is trusted, their
negative attestation carries weight, but this is legitimate: if the
discovering agent trusts the attacker, they should consider the
attacker's negative assessment. The defense is diversity: a single
negative attestation is diluted by multiple positive ones from other
trusted attesters.

**Additional defense:** The `sample_count` field helps detect
bad-mouthing. A negative attestation with `sample_count=1` (one
interaction) is less credible than one with `sample_count=500`. The
sample count discounting (0.3x for <10, 0.7x for <100) reduces the
weight of low-sample negative attestations.

### 10.2 Ballot-Stuffing

**Attack:** An attacker issues many positive attestations about an ally
(or themselves via Sybils) to inflate their reputation.

**Defense:** Same as Sybil resistance (§8): trust-weighted scoring,
self-attestation exclusion, sample count discounting, rate limiting. The
attacker cannot create high-weight attestations without establishing
real trust with the discovering agent.

### 10.3 Whitewashing

**Attack:** An agent with poor reputation abandons their identity and
creates a new one to start fresh.

**Defense:** This is fundamentally difficult in decentralized systems
without identity binding. AAFP's defense is indirect:
- A new identity has no WoT signatures, no CA cert, no directory entry →
  `TrustResult::Unknown` → TOFU weight 0.1 for their attestations.
- A new identity has no attestations about them → `compute_reputation()`
  returns `None` → no reputation score.
- The discovering agent must build trust from scratch (TOFU, WoT
  signatures, CA cert).

The cost of whitewashing is that the new identity starts with zero
reputation and zero trust. For agents that have invested in building WoT
signatures and CA certs, abandoning the identity means losing that
investment. For agents with no investment (Sybils), whitewashing is free
— but they also have no reputation to lose.

**Enhanced defense (future work):** Link identity to a resource that is
expensive to create (proof of work, proof of stake, domain verification,
organizational email). This makes creating new identities costly,
raising the bar for whitewashing.

### 10.4 Orbiting

**Attack:** An attacker gradually builds trust with a target agent over
time (establishing WoT signatures, getting CA certs), then exploits that
trust to issue damaging attestations or to manipulate the target's
reputation.

**Defense:** This is a long-term social engineering attack. The
trust-weighted scoring means that once the attacker has established
trust, their attestations carry weight — which is the intended behavior.
The defense is monitoring: agents should periodically review their WoT
signatures and revoke trust from agents whose behavior has changed. The
90-day WoT signature validity forces periodic re-evaluation, which helps
detect orbiting attacks (the attacker must get re-signed every 90 days,
giving the target an opportunity to decline).

### 10.5 Replay Attacks

**Attack:** An attacker captures a valid attestation and replays it
later, perhaps after the subject's key has been compromised.

**Defense:** Attestations have an `expires_at` field, and expired
attestations are rejected by `verify()`. The 90-day recommended validity
(for WoT signatures) and attestation expiry ensure that old attestations
cannot be replayed indefinitely. Additionally, the DHT key derivation
means a new attestation from the same attester about the same subject
overwrites the old one — the latest attestation is always the one that's
stored.

### 10.6 Collusion Detection (Future Work)

Detecting collusion (mutual attestation rings) requires graph analysis:
- Build a graph of attester → subject relationships.
- Detect dense subgraphs where a small set of agents mutually attest
  each other with high scores.
- Discount attestations within detected collusion rings.

This is not implemented in the current system but is a known area for
enhancement.

---

## 11. Reputation Recovery

When an agent has a reputation incident (poor performance, downtime,
compromised key), their reputation score drops. **Reputation recovery**
is the process of rebuilding trust over time.

### 11.1 Natural Recovery Through New Attestations

The primary recovery mechanism is natural: as the agent performs well
after the incident, new attestations with high trust_scores are issued.
The weighted average naturally shifts toward the new, positive
attestations. The speed of recovery depends on:
- **Rate of new attestations:** How quickly attesters observe and attest
  to the improved performance.
- **Weight of new attesters:** High-trust attesters (Full weight 1.0)
  accelerate recovery faster than low-trust attesters (TOFU weight 0.1).
- **Sample count of new attestations:** High-sample-count attestations
  (≥100) get full weight, accelerating recovery.

### 11.2 Expiry of Old Negative Attestations

Attestations expire (`expires_at` field). Old negative attestations
eventually expire and are removed from the computation. This creates a
natural "forgetting" mechanism: the agent's reputation is based on
recent attestations, not the full history. The recommended attestation
validity period should be short enough that past incidents fade (e.g.,
30-90 days) but long enough to provide stable scores.

### 11.3 Time-Decay Weighting (Recommended Enhancement)

As described in §7.4, continuous time-decay weighting would accelerate
recovery by reducing the influence of old negative attestations even
before they expire. An attestation from 60 days ago gets half the weight
of one from today (with a 30-day half-life), so the score naturally
shifts toward recent performance.

### 11.4 Key Rotation

If the agent's key was compromised, recovery requires **key rotation**:
generating a new keypair, creating a new AgentRecord, and re-establishing
trust. The old key should be revoked (added to a revocation list). The
new key starts with no trust — the agent must rebuild WoT signatures,
get a new CA cert, and have attesters re-issue attestations about the
new identity.

Key rotation is expensive but necessary for security. The 90-day WoT
signature validity helps: signers must re-sign every 90 days anyway, so
rotating to a new key just means the next re-signing cycle uses the new
key.

### 11.5 Negative Attestations as Recovery Signals

An agent can issue a negative attestation about itself (self-attestation)
— but these are excluded by `compute_reputation()` (line 1191). However,
an agent can ask a trusted third party to issue an attestation
acknowledging the incident and the recovery: "Agent X had an incident on
[date] but has been reliable since." This is a positive attestation with
a high sample_count (reflecting post-incident observations) that
naturally dilutes older negative attestations.

### 11.6 Recovery Timeline

A typical recovery timeline:
1. **Incident (day 0):** Agent performs poorly or key is compromised.
2. **Immediate (day 0-1):** Negative attestations are issued by affected
   parties. Score drops.
3. **Short-term (day 1-30):** Agent fixes the issue. New positive
   attestations begin to arrive. Score starts recovering.
4. **Medium-term (day 30-90):** Old negative attestations approach
   expiry. More positive attestations accumulate. Score continues
   recovering.
5. **Long-term (day 90+):** Old negative attestations expire. Score is
   based primarily on post-incident attestations. Recovery complete.

With continuous time-decay weighting (§7.4), recovery would be faster:
old negative attestations lose influence continuously, not just at
expiry.

---

## 12. Cross-Organization Reputation

### 12.1 The Problem

Can reputation transfer between federations? If Agent A has a high
reputation in Federation F1 (attested by F1's agents), and F1 federates
with F2, does A have a high reputation in F2?

### 12.2 AAFP's Answer: Yes, But Through Trust Paths

AAFP's reputation is computed from the *discovering agent's* perspective.
When an agent in F2 discovers Agent A (from F1), it calls
`compute_reputation()` with its own `TrustManager`. The computation:

1. Fetches all attestations about A from the DHT (which may include
   attestations from F1's agents).
2. For each attestation, calls `TrustManager::verify_peer()` on the
   attester.
3. Weights the attestation by the trust level with the attester.

The key question is: does the F2 agent trust F1's attesters? This
depends on the trust infrastructure between F1 and F2:

- **If F1 and F2 share a CA:** Agents in F2 trust F1's CA, so F1's
  CA-signed attesters get Full trust → weight 1.0. Reputation transfers
  fully.
- **If F1 and F2 have WoT overlap:** An F2 agent has WoT signatures
  from F1 agents (or vice versa), creating transitive trust paths. F1's
  attesters get Marginal trust → weight 0.5. Reputation transfers
  partially.
- **If F1 and F2 have no trust infrastructure:** F1's attesters are
  unknown to F2 agents → TOFU weight 0.1. Reputation transfers minimally.

### 12.3 Federation Gateways

Federation gateways (see `FEDERATION_TRUST.md`) are agents that bridge
two federations. They are trusted in both federations (e.g., they have
CA certs from both F1 and F2). A gateway can:
- Issue attestations about F1 agents (which F2 agents will weight highly
  because they trust the gateway).
- Issue WoT signatures for F1 agents (creating trust paths from F2 to
  F1).

This creates a **reputation bridge**: the gateway's attestations about
F1 agents are weighted at Full (1.0) by F2 agents, effectively
transferring reputation across the federation boundary.

### 12.4 Reputation Portability

Reputation is **portable** in the sense that attestations are stored in
the global DHT and accessible from any federation. But reputation is
**not automatically transferable** — it depends on the discovering
agent's trust relationships with the attesters. An agent with high
reputation in F1 does not automatically have high reputation in F2
unless F2 has trust paths to F1's attesters.

This is by design: reputation is a local computation, not a global
property. It prevents a compromised or colluding federation from
inflating reputations globally. Each federation maintains sovereignty
over its trust decisions.

### 12.5 Cross-Federation Attestation Aggregation

An agent operating across multiple federations accumulates attestations
from attesters in different federations. The `compute_reputation()`
function aggregates all of them, weighted by the discovering agent's
trust in each attester. This means:
- An agent with attestations from both F1 and F2 has a reputation that
  reflects both federations' assessments.
- An F1-only discovering agent weights F1 attesters highly and F2
  attesters lowly (or vice versa), so the score is biased toward the
  federation the discovering agent is more connected to.
- A well-connected discovering agent (with trust paths to both F1 and
  F2) gets a balanced view.

### 12.6 No Global Reputation Score

There is no global reputation score in AAFP. Each agent computes
reputation locally, based on its own trust relationships. This means:
- Agent A may have reputation 90 according to F1 agents and 60 according
  to F2 agents, because F1 and F2 trust different sets of attesters.
- There is no "true" reputation — only perspectives.
- This is resistant to manipulation: compromising one federation's
  attesters does not affect the reputation computation in other
  federations.

---

## 13. Concrete Reputation Scoring Implementation in Rust

This section provides a complete, compilable reputation scoring
implementation that extends the baseline `compute_reputation()` with
Bayesian averaging, time-decay weighting, and enhanced Sybil detection.
It is designed to be added to `attestation.rs` as an enhanced scoring
function.

```rust
use crate::attestation::{Attestation, AttestationData};
use crate::trust_manager::{TrustManager, TrustResult};
use crate::web_of_trust::{
    TRUST_LEVEL_FULL, TRUST_LEVEL_MARGINAL, TRUST_LEVEL_NONE,
    TRUST_LEVEL_ULTIMATE,
};

/// Configuration for enhanced reputation scoring.
#[derive(Clone, Debug)]
pub struct ReputationConfig {
    /// Bayesian prior mean (0-100). Default: 50 (midpoint).
    pub bayesian_prior: f64,
    /// Bayesian confidence constant (equivalent number of prior
    /// attestations). Default: 10. Higher = more conservative (score
    /// stays closer to prior with few attestations).
    pub bayesian_c: f64,
    /// Time-decay half-life in seconds. Default: 30 days.
    /// Attestations older than this get half weight.
    pub decay_half_life_secs: f64,
    /// Minimum trust weight for an attestation to be included.
    /// Default: 0.01 (excludes only near-zero-weight attestations).
    pub min_weight: f64,
    /// Whether to exclude TOFU (Unknown) attestations entirely.
    /// Default: false (include with 0.1 weight for bootstrapping).
    pub exclude_tofu: bool,
}

impl Default for ReputationConfig {
    fn default() -> Self {
        Self {
            bayesian_prior: 50.0,
            bayesian_c: 10.0,
            decay_half_life_secs: 30.0 * 24.0 * 60.0 * 60.0, // 30 days
            min_weight: 0.01,
            exclude_tofu: false,
        }
    }
}

/// Result of enhanced reputation computation.
#[derive(Clone, Debug)]
pub struct ReputationScore {
    /// The Bayesian-weighted reputation score (0-100).
    pub score: f64,
    /// Number of valid attestations used in the computation.
    pub attestation_count: usize,
    /// Total weight of all attestations (sum of individual weights).
    pub total_weight: f64,
    /// Whether the score is reliable (total_weight >= 1.0).
    pub is_reliable: bool,
    /// Individual attester contributions (for debugging / transparency).
    pub contributions: Vec<AttesterContribution>,
}

/// A single attester's contribution to the reputation score.
#[derive(Clone, Debug)]
pub struct AttesterContribution {
    pub attester_agent_id: [u8; 32],
    pub trust_weight: f64,
    pub sample_factor: f64,
    pub time_factor: f64,
    pub final_weight: f64,
    pub trust_score: u8,
}

/// Compute an enhanced reputation score with Bayesian averaging,
/// time-decay weighting, and sample-count discounting.
///
/// This extends the baseline `compute_reputation()` with:
/// 1. Bayesian averaging (pulls score toward prior with few attestations)
/// 2. Continuous time-decay (recent attestations weighted higher)
/// 3. Configurable TOFU exclusion
/// 4. Transparency (returns individual contributions)
pub fn compute_reputation_enhanced(
    attestations: &[Attestation],
    trust_manager: &TrustManager,
    now: u64,
    config: &ReputationConfig,
) -> Option<ReputationScore> {
    let mut weighted_sum = 0.0;
    let mut total_weight = 0.0;
    let mut contributions = Vec::new();
    let mut valid_count = 0;

    for att in attestations {
        // Skip invalid or expired attestations.
        if att.verify(now).is_err() {
            continue;
        }

        // Skip self-attestations (Sybil resistance).
        if att.attester_agent_id == att.subject_agent_id {
            continue;
        }

        // Determine trust level for the attester.
        let trust = trust_manager.verify_peer(
            &att.attester_agent_id,
            &att.attester_public_key,
            None,
            now,
        );

        let trust_weight = match trust {
            TrustResult::Trusted { level, .. } => match level {
                TRUST_LEVEL_ULTIMATE => 1.0,
                TRUST_LEVEL_FULL => 1.0,
                TRUST_LEVEL_MARGINAL => 0.5,
                _ => 0.0, // TRUST_LEVEL_NONE
            },
            TrustResult::Unknown { .. } => {
                if config.exclude_tofu {
                    0.0
                } else {
                    0.1 // TOFU: small weight for bootstrapping
                }
            }
            _ => 0.0, // Untrusted or Revoked
        };

        if trust_weight == 0.0 {
            continue;
        }

        // Sample count discount (Sybil resistance).
        let sample_factor = if att.data.sample_count < 10 {
            0.3
        } else if att.data.sample_count < 100 {
            0.7
        } else {
            1.0
        };

        // Time-decay factor: exp(-lambda * age)
        // lambda = ln(2) / half_life
        let age_secs = now.saturating_sub(att.attested_at) as f64;
        let lambda = (2.0_f64).ln() / config.decay_half_life_secs;
        let time_factor = (-lambda * age_secs).exp();

        let final_weight = trust_weight * sample_factor * time_factor;

        if final_weight < config.min_weight {
            continue;
        }

        weighted_sum += final_weight * att.data.trust_score as f64;
        total_weight += final_weight;
        valid_count += 1;

        contributions.push(AttesterContribution {
            attester_agent_id: att.attester_agent_id.0,
            trust_weight,
            sample_factor,
            time_factor,
            final_weight,
            trust_score: att.data.trust_score,
        });
    }

    if total_weight == 0.0 && config.bayesian_c == 0.0 {
        return None;
    }

    // Bayesian average: (C * prior + weighted_sum) / (C + total_weight)
    let bayesian_score = if config.bayesian_c > 0.0 {
        (config.bayesian_c * config.bayesian_prior + weighted_sum)
            / (config.bayesian_c + total_weight)
    } else {
        if total_weight > 0.0 {
            weighted_sum / total_weight
        } else {
            return None;
        }
    };

    Some(ReputationScore {
        score: bayesian_score,
        attestation_count: valid_count,
        total_weight,
        is_reliable: total_weight >= 1.0,
        contributions,
    })
}

/// Simple average reputation (baseline, not Sybil-resistant).
///
/// Included for comparison only. Do not use in production.
pub fn compute_reputation_simple(
    attestations: &[Attestation],
    now: u64,
) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0;

    for att in attestations {
        if att.verify(now).is_err() {
            continue;
        }
        if att.attester_agent_id == att.subject_agent_id {
            continue;
        }
        sum += att.data.trust_score as f64;
        count += 1;
    }

    if count > 0 {
        Some(sum / count as f64)
    } else {
        None
    }
}

/// Detect potential Sybil rings: groups of agents that mutually attest
/// each other with high scores and low sample counts.
///
/// Returns a list of (agent_id, sybil_suspicion_score) pairs where
/// suspicion > 0.5 indicates a likely Sybil ring member.
pub fn detect_sybil_rings(
    attestations: &[Attestation],
    now: u64,
) -> Vec<([u8; 32], f64)> {
    use std::collections::HashMap;

    // Build attestation graph: attester -> [(subject, score, sample_count)]
    let mut graph: HashMap<[u8; 32], Vec<([u8; 32], u8, u32)>> =
        HashMap::new();

    for att in attestations {
        if att.verify(now).is_err() {
            continue;
        }
        graph
            .entry(att.attester_agent_id.0)
            .or_default()
            .push((
                att.subject_agent_id.0,
                att.data.trust_score,
                att.data.sample_count,
            ));
    }

    // For each agent, check if they are part of a mutual attestation ring.
    let mut suspicions: Vec<([u8; 32], f64)> = Vec::new();

    for (attester, subjects) in &graph {
        let mut mutual_high_score = 0;
        let mut mutual_low_sample = 0;
        let mut total_mutual = 0;

        for (subject, score, sample_count) in subjects {
            // Check if subject also attests about attester.
            if let Some(reverse_atts) = graph.get(subject) {
                for (rev_subject, rev_score, rev_sample) in reverse_atts {
                    if rev_subject == attester {
                        total_mutual += 1;
                        if *score >= 90 && *rev_score >= 90 {
                            mutual_high_score += 1;
                        }
                        if *sample_count < 10 && *rev_sample < 10 {
                            mutual_low_sample += 1;
                        }
                    }
                }
            }
        }

        if total_mutual > 0 {
            // Suspicion = weighted combination of high-score and low-sample
            // mutual attestations.
            let high_score_ratio =
                mutual_high_score as f64 / total_mutual as f64;
            let low_sample_ratio =
                mutual_low_sample as f64 / total_mutual as f64;
            let suspicion =
                0.5 * high_score_ratio + 0.5 * low_sample_ratio;
            if suspicion > 0.3 {
                suspicions.push((*attester, suspicion));
            }
        }
    }

    suspicions.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    suspicions
}

/// Compute reputation with Sybil ring detection: attestations from
/// suspected Sybil ring members get reduced weight.
pub fn compute_reputation_sybil_aware(
    attestations: &[Attestation],
    trust_manager: &TrustManager,
    now: u64,
    config: &ReputationConfig,
) -> Option<ReputationScore> {
    // First, detect Sybil rings.
    let sybil_suspects = detect_sybil_rings(attestations, now);
    let suspect_map: HashMap<[u8; 32], f64> = sybil_suspects
        .iter()
        .cloned()
        .collect();

    let mut weighted_sum = 0.0;
    let mut total_weight = 0.0;
    let mut contributions = Vec::new();
    let mut valid_count = 0;

    for att in attestations {
        if att.verify(now).is_err() {
            continue;
        }
        if att.attester_agent_id == att.subject_agent_id {
            continue;
        }

        let trust = trust_manager.verify_peer(
            &att.attester_agent_id,
            &att.attester_public_key,
            None,
            now,
        );

        let trust_weight = match trust {
            TrustResult::Trusted { level, .. } => match level {
                TRUST_LEVEL_ULTIMATE => 1.0,
                TRUST_LEVEL_FULL => 1.0,
                TRUST_LEVEL_MARGINAL => 0.5,
                _ => 0.0,
            },
            TrustResult::Unknown { .. } => {
                if config.exclude_tofu { 0.0 } else { 0.1 }
            }
            _ => 0.0,
        };

        if trust_weight == 0.0 {
            continue;
        }

        // Sybil ring suspicion discount.
        let sybil_discount = suspect_map
            .get(&att.attester_agent_id.0)
            .map(|suspicion| 1.0 - *suspicion)
            .unwrap_or(1.0);

        let sample_factor = if att.data.sample_count < 10 {
            0.3
        } else if att.data.sample_count < 100 {
            0.7
        } else {
            1.0
        };

        let age_secs = now.saturating_sub(att.attested_at) as f64;
        let lambda = (2.0_f64).ln() / config.decay_half_life_secs;
        let time_factor = (-lambda * age_secs).exp();

        let final_weight =
            trust_weight * sample_factor * time_factor * sybil_discount;

        if final_weight < config.min_weight {
            continue;
        }

        weighted_sum += final_weight * att.data.trust_score as f64;
        total_weight += final_weight;
        valid_count += 1;

        contributions.push(AttesterContribution {
            attester_agent_id: att.attester_agent_id.0,
            trust_weight,
            sample_factor,
            time_factor,
            final_weight,
            trust_score: att.data.trust_score,
        });
    }

    if total_weight == 0.0 && config.bayesian_c == 0.0 {
        return None;
    }

    let bayesian_score = if config.bayesian_c > 0.0 {
        (config.bayesian_c * config.bayesian_prior + weighted_sum)
            / (config.bayesian_c + total_weight)
    } else if total_weight > 0.0 {
        weighted_sum / total_weight
    } else {
        return None;
    };

    Some(ReputationScore {
        score: bayesian_score,
        attestation_count: valid_count,
        total_weight,
        is_reliable: total_weight >= 1.0,
        contributions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attestation::{Attestation, AttestationData};
    use crate::keypair::AgentKeypair;
    use crate::trust_manager::TrustManager;
    use crate::web_of_trust::{TrustSignature, TRUST_LEVEL_FULL};
    use crate::identity_v1::AgentId;

    fn now() -> u64 { 1_000_000 }
    fn future() -> u64 { now() + 86400 * 90 } // 90 days

    fn make_keypair() -> AgentKeypair {
        AgentKeypair::generate()
    }

    #[test]
    fn test_bayesian_with_few_attestations() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let attester = make_keypair();
        let attester_id = AgentId::from_public_key(&attester.public_key);
        let subject = make_keypair();
        let subject_id = AgentId::from_public_key(&subject.public_key);

        let tm = TrustManager::new(discovering_id);
        tm.add_direct_trust(attester_id, attester.public_key.clone());

        // One attestation with trust_score=100.
        let att = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 200, trust_score: 100, ..Default::default() },
            now(),
        ).unwrap();

        let config = ReputationConfig::default();
        let result = compute_reputation_enhanced(
            &[att], &tm, now(), &config,
        ).unwrap();

        // Bayesian: (10*50 + 1.0*100) / (10 + 1.0) = 600/11 ≈ 54.5
        assert!(result.score > 53.0 && result.score < 56.0);
        assert!(!result.is_reliable); // total_weight = 1.0, threshold is >= 1.0
    }

    #[test]
    fn test_bayesian_with_many_attestations() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let attester = make_keypair();
        let attester_id = AgentId::from_public_key(&attester.public_key);
        let subject = make_keypair();
        let subject_id = AgentId::from_public_key(&subject.public_key);

        let tm = TrustManager::new(discovering_id);
        tm.add_direct_trust(attester_id, attester.public_key.clone());

        // 20 attestations with trust_score=100.
        let mut atts = Vec::new();
        for _ in 0..20 {
            atts.push(Attestation::create_and_sign(
                &attester, subject_id, future(),
                AttestationData { sample_count: 200, trust_score: 100, ..Default::default() },
                now(),
            ).unwrap());
        }

        let config = ReputationConfig::default();
        let result = compute_reputation_enhanced(
            &atts, &tm, now(), &config,
        ).unwrap();

        // Bayesian: (10*50 + 20*100) / (10 + 20) = 2500/30 ≈ 83.3
        assert!(result.score > 82.0 && result.score < 85.0);
        assert!(result.is_reliable); // total_weight = 20.0
    }

    #[test]
    fn test_time_decay_weighting() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let attester = make_keypair();
        let attester_id = AgentId::from_public_key(&attester.public_key);
        let subject = make_keypair();
        let subject_id = AgentId::from_public_key(&subject.public_key);

        let tm = TrustManager::new(discovering_id);
        tm.add_direct_trust(attester_id, attester.public_key.clone());

        // Old attestation (60 days ago = 2 half-lives → 0.25 weight).
        let old_att = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 200, trust_score: 100, ..Default::default() },
            now() - 60 * 86400, // 60 days ago
        ).unwrap();

        // Recent attestation (today → ~1.0 time factor).
        let new_att = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 200, trust_score: 50, ..Default::default() },
            now(),
        ).unwrap();

        let config = ReputationConfig::default();
        let result = compute_reputation_enhanced(
            &[old_att, new_att], &tm, now(), &config,
        ).unwrap();

        // Old weight = 1.0 * 1.0 * 0.25 = 0.25, score=100
        // New weight = 1.0 * 1.0 * ~1.0 = 1.0, score=50
        // Weighted avg ≈ (0.25*100 + 1.0*50) / 1.25 = 75/1.25 = 60
        // Bayesian: (10*50 + 75) / (10 + 1.25) = 575/11.25 ≈ 51.1
        assert!(result.score > 49.0 && result.score < 53.0);
    }

    #[test]
    fn test_sybil_ring_detection() {
        let a = make_keypair();
        let b = make_keypair();
        let a_id = AgentId::from_public_key(&a.public_key);
        let b_id = AgentId::from_public_key(&b.public_key);

        // A and B mutually attest each other with high scores, low samples.
        let att1 = Attestation::create_and_sign(
            &a, b_id, future(),
            AttestationData { sample_count: 5, trust_score: 100, ..Default::default() },
            now(),
        ).unwrap();
        let att2 = Attestation::create_and_sign(
            &b, a_id, future(),
            AttestationData { sample_count: 5, trust_score: 100, ..Default::default() },
            now(),
        ).unwrap();

        let suspicions = detect_sybil_rings(&[att1, att2], now());
        // Both should be flagged with high suspicion.
        assert!(suspicions.len() >= 2);
        assert!(suspicions[0].1 > 0.5);
    }

    #[test]
    fn test_exclude_tofu() {
        let discovering = make_keypair();
        let discovering_id = AgentId::from_public_key(&discovering.public_key);
        let attester = make_keypair(); // Unknown to discovering agent
        let subject = make_keypair();
        let subject_id = AgentId::from_public_key(&subject.public_key);

        let tm = TrustManager::new(discovering_id);

        let att = Attestation::create_and_sign(
            &attester, subject_id, future(),
            AttestationData { sample_count: 200, trust_score: 100, ..Default::default() },
            now(),
        ).unwrap();

        let config = ReputationConfig {
            exclude_tofu: true,
            ..Default::default()
        };
        let result = compute_reputation_enhanced(
            &[att], &tm, now(), &config,
        );

        // With TOFU excluded, no valid attestations → score is just the prior.
        // Bayesian: (10*50 + 0) / (10 + 0) = 50.0
        assert!(result.is_some());
        assert!(result.unwrap().score == 50.0); // prior
    }
}
```

### 13.1 Algorithm Comparison

| Algorithm | Sybil Resistance | Cold Start | Complexity | Use Case |
|-----------|-----------------|------------|------------|----------|
| Simple average | None | Good (any rating counts) | O(n) | Baseline, not recommended |
| Trust-weighted (AAFP baseline) | Good | Moderate (TOFU 0.1) | O(n) | Default, production |
| Bayesian + trust-weighted | Good | Excellent (prior prevents extremes) | O(n) | Sparse attestation data |
| Bayesian + time-decay | Good | Excellent | O(n) | Dynamic performance |
| Sybil-aware (ring detection) | Excellent | Good | O(n + m²) | High-security deployments |

Where n = number of attestations, m = number of unique attesters.

### 13.2 Choosing the Right Algorithm

- **Default production:** `compute_reputation_enhanced()` with
  `ReputationConfig::default()`. This provides Bayesian averaging (prevents
  extreme scores with few attestations), time-decay (favors recent
  performance), and TOFU inclusion (allows bootstrapping).

- **High-security:** `compute_reputation_sybil_aware()` with
  `exclude_tofu: true`. This excludes unknown attesters entirely and
  discounts suspected Sybil ring members. Use when the network has
  established trust infrastructure and bootstrapping is not needed.

- **Bootstrapping phase:** `compute_reputation_enhanced()` with
  `bayesian_c: 5.0` (less conservative prior) and `exclude_tofu: false`.
  This allows new agents to build reputation more quickly.

- **Mature network:** `compute_reputation_enhanced()` with
  `bayesian_c: 20.0` (more conservative) and `decay_half_life_secs:
  14 days` (faster decay). This makes scores more stable and responsive
  to recent performance.

---

## 14. Implementation Reference

### 14.1 Source Files

| File | Purpose | Key Types |
|------|---------|-----------|
| `trust_manager.rs` | Unified trust decision API | `TrustManager`, `TrustResult`, `TrustSource`, `TrustPolicy` |
| `web_of_trust.rs` | P2P trust graph and BFS | `WebOfTrust`, `TrustSignature`, trust level constants |
| `attestation.rs` | Third-party attestations and scoring | `Attestation`, `AttestationData`, `compute_reputation()` |
| `extensions/reputation.rs` | Reputation extension (attestation refs) | `ReputationExtension` |
| `ca_certificate.rs` | CA-signed certificates | `CaCertificate`, `CaVerifier` |
| `key_directory.rs` | AgentId → AgentRecord directory | `KeyDirectory` |
| `revocation.rs` | Revocation lists and store | `RevocationList`, `RevocationStore` |
| `ucan.rs` | UCAN capability delegation | `UcanToken`, `Capability` |

### 14.2 Key Constants

| Constant | Value | Location |
|----------|-------|----------|
| `TRUST_LEVEL_NONE` | 0 | `web_of_trust.rs:31` |
| `TRUST_LEVEL_MARGINAL` | 1 | `web_of_trust.rs:33` |
| `TRUST_LEVEL_FULL` | 2 | `web_of_trust.rs:35` |
| `TRUST_LEVEL_ULTIMATE` | 3 | `web_of_trust.rs:37` |
| `RECOMMENDED_WOT_VALIDITY_SECS` | 7,776,000 (90 days) | `web_of_trust.rs:40` |
| `WOT_DOMAIN_SEPARATOR` | `"aafp-v1-wot"` | `web_of_trust.rs:25` |
| `ATTESTATION_DOMAIN_SEPARATOR` | `"aafp-v1-attestation"` | `attestation.rs` |
| `ATTESTATION_TYPE_V1` | `"aafp-attestation-v1"` | `attestation.rs` |

### 14.3 Key Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `TrustManager::verify_peer()` | `trust_manager.rs:169` | Unified trust decision (5 sources) |
| `TrustManager::should_accept()` | `trust_manager.rs:260` | Apply policy to trust result |
| `WebOfTrust::trust_level()` | `web_of_trust.rs:423` | BFS trust computation |
| `WebOfTrust::is_trusted()` | `web_of_trust.rs:492` | Check minimum trust level |
| `TrustSignature::new()` | `web_of_trust.rs:122` | Create and sign a WoT signature |
| `TrustSignature::verify()` | `web_of_trust.rs:294` | Verify a WoT signature |
| `Attestation::create_and_sign()` | `attestation.rs:1052` | Create and sign an attestation |
| `Attestation::verify()` | `attestation.rs:1099` | Verify an attestation |
| `compute_reputation()` | `attestation.rs:1176` | Trust-weighted reputation score |
| `verify_attestation_authorization()` | `attestation.rs:1282` | UCAN authorization for attestations |
| `delegate_attest_capability()` | `attestation.rs:1324` | Delegate `attest.reputation` UCAN capability |

### 14.4 Trust Weight Summary

| Trust Result | Level | Reputation Weight | WoT Propagation |
|-------------|-------|------------------|-----------------|
| Trusted (Direct) | Ultimate (3) | 1.0 | N/A (direct cache) |
| Trusted (CA) | Full (2) | 1.0 | N/A (CA chain) |
| Trusted (WoT direct) | Full (2) | 1.0 | Direct signature |
| Trusted (WoT one-hop) | Marginal (1) | 0.5 | Transitive (one hop) |
| Trusted (Directory) | Full (2) | 1.0 | N/A (directory lookup) |
| Unknown (TOFU) | — | 0.1 | No path found |
| Untrusted | — | 0.0 | Verification failed |
| Revoked | — | 0.0 | In revocation store |

### 14.5 Sample Count Discount Tiers

| Sample Count | Discount Factor | Rationale |
|-------------|----------------|-----------|
| < 10 | 0.3 (70% discount) | Very few interactions; likely unreliable |
| 10–99 | 0.7 (30% discount) | Some interactions; moderately reliable |
| ≥ 100 | 1.0 (no discount) | Many interactions; reliable |

---

*This document covers the AAFP trust scoring and reputation system as
implemented in the Rust `aafp-identity` crate, with design references to
RFC 0011 (Trust Model) and ARE E3-E4 (Attestation System). The concrete
Rust implementation in §13 is designed as an enhancement to the baseline
`compute_reputation()` function, adding Bayesian averaging, time-decay
weighting, and Sybil ring detection.*
