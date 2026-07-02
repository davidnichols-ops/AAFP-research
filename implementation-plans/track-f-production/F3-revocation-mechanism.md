# Plan F3: Revocation Mechanism (CRL-Based, RFC-0003 Amendment)

**Priority:** MEDIUM (outstanding item from PROTOCOL_CANDIDATE_CHECKLIST.md)
**Track:** F (Production Readiness)
**Estimated effort:** 6-8 hours
**Blocked by:** nothing
**Blocks:** nothing

---

## Objective

Implement a revocation mechanism for AAFP agent identities. Currently, if
an agent's ML-DSA-65 private key is compromised, there is no way to revoke
the associated AgentId. A compromised key can be used indefinitely.

This plan implements a CRL (Certificate Revocation List) approach: a signed
list of revoked AgentIds that peers check before accepting a connection.

**Current state:** No revocation mechanism exists. RFC-0003 §5 and
AMENDMENTS-0001 §C3 document the gap and propose future designs including
CRLs and delegation-based revocation.

**Source:** PROTOCOL_CANDIDATE_CHECKLIST.md outstanding items, RFC-0003 §5,
AMENDMENTS-0001 §C3

---

## Design: CRL-Based Revocation

### How it works

1. **Revocation List:** A CRL is a CBOR-encoded signed list of revoked
   AgentIds. It's signed by the agent that owns the revoked key (self-
   revocation) or by a trusted revocation authority (future).

2. **Self-Revocation (v1):** An agent whose key is compromised can sign a
   revocation statement with the compromised key (if they still have it)
   or with a new key that references the old AgentId.

3. **Distribution:** CRLs are distributed via:
   - Discovery (published as a capability: `aafp.revocation.crl`)
   - Direct exchange during handshake (optional extension)
   - Out-of-band (published to a known location)

4. **Checking:** During the AAFP handshake, after identity verification,
   the peer checks the connecting agent's AgentId against known CRLs.
   If the AgentId is revoked, the connection is rejected with ERROR 2002
   (Expired or revoked identity).

### Wire format

CRL entry (CBOR map):
```
{
    1: agent_id,           // bstr, 32 bytes — the revoked AgentId
    2: revoked_at,         // uint, Unix timestamp
    3: reason,             // tstr, optional — "compromised", "rotated", etc.
    4: revoking_key_id,    // bstr, 32 bytes — AgentId of the revoking key
    5: signature,          // bstr — ML-DSA-65 signature over fields 1-4
}
```

CRL (CBOR array of entries):
```
[
    entry1,
    entry2,
    ...
]
```

---

## Prerequisites

- Read `RFCs/0003-identity-authentication.md` §5 (revocation discussion)
- Read `RFCs/AMENDMENTS-0001.md` §C3 (revocation design proposals)
- Read `crates/aafp-identity/src/identity_v1.rs` (AgentId, AgentRecord)
- Read `crates/aafp-core/src/session.rs` (where identity verification happens)

---

## Steps

### F3.1: Write RFC amendment for revocation

Create `RFCs/AMENDMENTS-0003.md` (or add to existing amendments):

```markdown
# Amendment to RFC-0003: Revocation Mechanism

## Status
Proposed

## Summary
Adds a CRL-based revocation mechanism for AAFP agent identities.

## Design
<copy the design section from above>

## Wire Format
<copy the CBOR format from above>

## Distribution
- CRLs published via discovery as capability "aafp.revocation.crl"
- Peers fetch CRLs from known peers during discovery
- CRLs cached locally with TTL

## Verification
- During handshake, after identity verification, check AgentId against CRLs
- If revoked: send ERROR 2002, close connection
- CRL signature verified with the revoking key (self-revocation or authority)
```

### F3.2: Implement CRL types

Create `crates/aafp-identity/src/revocation.rs`:

```rust
//! Revocation: CRL-based identity revocation (RFC-0003 amendment).
//!
//! Allows revoking compromised agent identities via signed revocation lists.

use aafp_identity::{AgentId, AgentKeypair};
use serde::{Serialize, Deserialize};

/// A single revocation entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevocationEntry {
    pub agent_id: AgentId,       // The revoked AgentId
    pub revoked_at: u64,          // Unix timestamp
    pub reason: Option<String>,   // "compromised", "rotated", etc.
    pub revoking_key_id: AgentId, // Who signed the revocation
    pub signature: Vec<u8>,       // ML-DSA-65 signature
}

/// A Certificate Revocation List.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevocationList {
    pub entries: Vec<RevocationEntry>,
    pub generated_at: u64,  // When this CRL was generated
    pub expires_at: u64,    // When this CRL expires
}

impl RevocationList {
    /// Create an empty CRL.
    pub fn new(ttl_seconds: u64) -> Self { ... }

    /// Add a revocation entry (signed by the revoking key).
    pub fn revoke(&mut self, keypair: &AgentKeypair, agent_id: AgentId, reason: Option<String>) { ... }

    /// Check if an AgentId is revoked.
    pub fn is_revoked(&self, agent_id: &AgentId) -> bool { ... }

    /// Verify all signatures in the CRL.
    pub fn verify(&self) -> Result<(), RevocationError> { ... }

    /// Encode to CBOR.
    pub fn to_cbor(&self) -> Vec<u8> { ... }

    /// Decode from CBOR.
    pub fn from_cbor(data: &[u8]) -> Result<Self, RevocationError> { ... }

    /// Remove expired entries.
    pub fn evict_expired(&mut self) { ... }
}
```

### F3.3: Implement CRL store

Create `crates/aafp-identity/src/revocation_store.rs`:

```rust
//! Local store of revocation lists.
//!
//! Maintains a merged view of all known CRLs for fast lookup.

pub struct RevocationStore {
    /// Merged set of all revoked AgentIds
    revoked: HashSet<AgentId>,
    /// Known CRLs with their expiration times
    crls: Vec<RevocationList>,
}

impl RevocationStore {
    pub fn new() -> Self { ... }

    /// Add a CRL to the store. Verifies signatures first.
    pub fn add_crl(&mut self, crl: RevocationList) -> Result<(), RevocationError> { ... }

    /// Check if an AgentId is revoked.
    pub fn is_revoked(&self, agent_id: &AgentId) -> bool { ... }

    /// Evict expired CRLs.
    pub fn evict_expired(&mut self) { ... }
}
```

### F3.4: Integrate with handshake

Edit `crates/aafp-sdk/src/transport_binding.rs` (or the handshake driver)
to check the revocation store after identity verification:

```rust
// After identity verification, before authorization:
if let Some(store) = revocation_store {
    if store.is_revoked(&peer_info.agent_id) {
        return Err(SdkError::IdentityRevoked);
    }
}
```

Add `revocation_store: Option<&RevocationStore>` parameter to
`establish_session()`.

### F3.5: Integrate with discovery

Allow CRLs to be distributed via discovery:
- Publish CRL as a capability: `aafp.revocation.crl`
- Peers can fetch CRLs during discovery lookup
- Add a `aafp.discovery.get_crl` RPC method (or use existing data exchange)

### F3.6: Write tests

```rust
#[test]
fn test_revoke_and_check() {
    let keypair = MlDsa65::keypair();
    let mut crl = RevocationList::new(3600);
    let target_id = [0xAA; 32];
    crl.revoke(&keypair, target_id, Some("compromised".to_string()));
    assert!(crl.is_revoked(&target_id));
    assert!(crl.verify().is_ok());
}

#[test]
fn test_crl_cbor_roundtrip() {
    let crl = RevocationList::new(3600);
    let encoded = crl.to_cbor();
    let decoded = RevocationList::from_cbor(&encoded).unwrap();
    assert_eq!(crl.entries, decoded.entries);
}

#[tokio::test]
async fn test_revoked_connection_rejected() {
    // 1. Agent A's key is compromised
    // 2. Agent A revokes their own AgentId
    // 3. Agent B has the CRL
    // 4. Agent A (or attacker with A's key) tries to connect to B
    // 5. B rejects with ERROR 2002
}
```

### F3.7: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
feat: implement CRL-based identity revocation (RFC-0003 amendment)

Adds a revocation mechanism for compromised agent identities:
- RevocationEntry: signed statement revoking an AgentId
- RevocationList: CRL with TTL-based expiration
- RevocationStore: local merged view of all known CRLs
- Integrated into handshake: revoked AgentIds rejected with ERROR 2002
- CRL distribution via discovery (capability: aafp.revocation.crl)
- Self-revocation: agent signs revocation with their own key

Closes PROTOCOL_CANDIDATE_CHECKLIST.md outstanding item: "Revocation mechanism".

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Commit RFC amendment in umbrella:
```bash
cd /Users/david/projects/AAFP-research
git add RFCs/ implementations/rust
git commit -m "feat: CRL-based revocation mechanism (RFC-0003 amendment)"
```

---

## Verification

### F3.8: Tests pass

```bash
cargo test -p aafp-identity revocation -v
cargo test --workspace
```

### F3.9: Clippy clean

```bash
cargo clippy --workspace -- -D warnings
```

---

## Risks & Mitigations

1. **Self-revocation paradox:** If the key is compromised, the attacker can
   also sign revocations. **Mitigation:** Self-revocation is still valuable
   because it lets the legitimate owner revoke the key. A future delegation-
   based revocation (with a trusted authority) would be more secure.

2. **CRL distribution scaling:** In a large network, CRLs could be large.
   **Mitigation:** Use delta-CRLs (only new revocations since last CRL).
   Document as future work.

3. **CRL freshness:** Stale CRLs mean revoked agents can still connect.
   **Mitigation:** Short TTL (default 1 hour), periodic refresh via
   discovery.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark F3.1 through F3.9 as `[x]`
- Set F3 status to `COMPLETE`
