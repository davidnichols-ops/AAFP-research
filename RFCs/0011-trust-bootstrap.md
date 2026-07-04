# RFC 0011: Trust Bootstrap for Production

```
Status:         Experimental
Number:         0011
Title:          Hybrid Trust Model — Key Directory, Web of Trust,
                CA Certificates, Key Rotation, and Networked Revocation
Author:         AAFP Project
Created:        2026-07-03
Type:           Standards Track
Obsoletes:      —
Obsoleted by:   —
Depends on:     RFC 0003 (Identity & Authentication)
```

## 1. Introduction

AAFP agents authenticate each other via ML-DSA-65 signatures in the
AAFP v1 handshake (RFC-0002, RFC-0003). The handshake proves *who* you
are talking to (the peer holds the private key for the claimed AgentId),
but not *whether you should trust them*. The current trust model is TOFU
(Trust On First Use): the first time you connect, you accept the peer's
public key.

TOFU is vulnerable to man-in-the-middle (MITM) attacks on first
connection. For production deployments, agents need a way to verify a
peer's public key before trusting it.

This RFC specifies a **hybrid trust model** that combines three
complementary trust sources:

1. **Key Directory** (Section 3) — A directory service maps AgentId →
   AgentRecord. Agents query the directory to verify a peer's public key.
   Centralized directory, decentralized trust (anyone can run a directory).

2. **Web of Trust** (Section 4) — Peers sign each other's keys. Trust is
   transitive with decay: if I trust A, and A trusts B, I can trust B
   (with reduced confidence). Fully decentralized.

3. **CA Certificates** (Section 5) — A Certificate Authority signs agent
   certificates. Agents that trust the CA can verify any certificate it
   issues. For enterprise deployments.

These are supplemented by:

4. **Key Rotation** (Section 6) — Old key signs new key, preserving trust
   across key changes.

5. **Networked Revocation** (Section 7) — CRLs are distributed via gossip
   and directory queries, not just local storage.

6. **TrustManager** (Section 8) — A unified API that combines all trust
   sources and returns a `TrustResult`.

### 1.1 Normative Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

### 1.2 Design Principles

- **Additive, not replacement.** Trust layers are additive to the
  existing handshake. The handshake always runs first; trust
  verification happens after the handshake completes.
- **Cryptographically sound.** All trust assertions are signed with
  ML-DSA-65. No unsigned trust claims are accepted.
- **No single point of failure.** No single trust source is required.
  Agents can use any combination of directory, WoT, and CA. If all
  fail, TOFU remains as a fallback (with user confirmation).
- **Privacy-preserving.** Directory queries can be authenticated and
  rate-limited. WoT signatures are point-to-point. CA certificates
  are presented by the agent, not looked up centrally.

## 2. Trust Levels

Trust levels are integers 0–3, used by WoT signatures and the
TrustManager API:

| Level | Name      | Semantics |
|-------|-----------|-----------|
| 0     | None      | No trust. The key is not trusted. |
| 1     | Marginal  | Low confidence. Suitable for non-sensitive operations. Transitive trust decays to this level after one hop. |
| 2     | Full      | High confidence. The key is trusted for normal operations. Direct WoT signature or CA certificate grants this. |
| 3     | Ultimate  | The key is trusted unconditionally. Only the agent's own key and keys the agent has personally verified out-of-band receive this level. |

### 2.1 Trust Decay

Transitive trust decays by one level per hop in the WoT graph:

- Direct signature: trust_level as signed (max Full = 2)
- One hop transitive: Marginal (1)
- Two or more hops: None (0)

Ultimate trust (3) is never granted transitively. It can only be set
by the agent itself for its own key or keys verified out-of-band.

## 3. Key Directory

### 3.1 Overview

A key directory is a service that maps AgentId → AgentRecord. Agents
publish their self-signed AgentRecord to the directory, and other agents
query the directory to look up a peer's record before connecting.

The directory is **not a trust root**. It is a lookup service. Trust
comes from the AgentRecord's self-signature (which proves the peer
controls the key) and optionally from the directory's own signature on
the response (which proves the directory vouches for the record).

Anyone can run a directory. Agents can configure multiple directories
for redundancy.

### 3.2 RPC Methods

Directory operations use AAFP RPC frames (RFC-0002 §4.4):

| Method | Direction | Description |
|--------|-----------|-------------|
| `aafp.directory.lookup` | Client→Directory | Query an AgentRecord by AgentId |
| `aafp.directory.publish` | Agent→Directory | Publish/update own AgentRecord |
| `aafp.directory.rotate` | Agent→Directory | Publish a key rotation record |
| `aafp.directory.crl` | Client→Directory | Query revocation list |

### 3.3 Lookup Request

```cbor
aafp.directory.lookup = {
    1: bstr,    // agent_id: 32-byte AgentId to look up
}
```

### 3.4 Lookup Response

```cbor
aafp.directory.lookup.response = {
    1: bstr / null,  // record: AgentRecord CBOR bytes, or null if not found
    2: bstr / null,  // directory_signature: ML-DSA-65 signature over
                     //   the record bytes (if directory has a key), or null
}
```

If the directory has its own keypair, it signs the record bytes with
its private key. The client can verify this signature using the
directory's public key (configured out-of-band). This proves the
directory vouches for the record and prevents a MITM from substituting
a different record in transit.

### 3.5 Publish Request

```cbor
aafp.directory.publish = {
    1: bstr,    // record: AgentRecord CBOR bytes (self-signed)
}
```

### 3.6 Publish Response

```cbor
aafp.directory.publish.response = {
    1: uint,    // status: 0 = success, 1 = rate_limited, 2 = invalid, 3 = error
    2: tstr,    // message: human-readable status message
}
```

### 3.7 Directory Server Behavior

The directory server MUST:

1. **Verify the AgentRecord signature** before storing it. Reject
   records with invalid signatures (status = 2).
2. **Verify that agent_id == SHA-256(public_key)**. Reject mismatches.
3. **Rate-limit publishes**: at most 1 publish per AgentId per hour.
   Reject excessive publishes (status = 1).
4. **Store records in a persistent backend** (SQLite recommended).
5. **Return the latest record** on lookup. If a newer record_version
   is published, replace the old one.

The directory server SHOULD:

1. Sign lookup responses with its own key (if configured).
2. Evict expired records (where expires_at < current_time).
3. Support multiple directories syncing records (future work).

### 3.8 Client Behavior

When connecting to an unknown peer:

1. Complete the AAFP v1 handshake (always — trust is additive).
2. Query the directory for the peer's AgentId.
3. If found: verify the AgentRecord signature and agent_id match.
4. If the directory signed the response: verify the directory signature.
5. If verification succeeds: trust the peer (TrustSource = Directory).
6. If the directory doesn't know the peer: fall back to WoT, CA, or TOFU.

## 4. Web of Trust

### 4.1 Overview

In the Web of Trust (WoT), agents sign each other's keys with a
`TrustSignature`. This creates a decentralized trust graph. Trust is
transitive with decay (Section 2.1).

### 4.2 TrustSignature Format

```cbor
TrustSignature = {
    1: tstr,    // type: "aafp-wot-sig-v1"
    2: bstr,    // signer_agent_id: 32 bytes
    3: bstr,    // signed_agent_id: 32 bytes
    4: bstr,    // signed_public_key: 1952 bytes (ML-DSA-65)
    5: uint,    // trust_level: 0-3 (see Section 2)
    6: uint,    // expiry: unix timestamp
    7: bstr,    // signature: ML-DSA-65 over fields 1-6
                 //   with domain separator "aafp-v1-wot"
}
```

### 4.3 Domain Separator

The WoT domain separator is `"aafp-v1-wot"`. The signature input is:

```
sig_input = "aafp-v1-wot" || canonical_CBOR(fields 1-6)
signature = ML-DSA-65.Sign(signer_secret_key, sig_input)
```

This domain separator prevents WoT signatures from being valid in any
other context (handshake, AgentRecord, UCAN, etc.), following the
domain separation rules in RFC-0003 §3.5.

### 4.4 Signing

Agent A signs agent B's key:

1. A knows B's AgentId and public key (from the handshake or directory).
2. A creates a TrustSignature with:
   - signer_agent_id = A's AgentId
   - signed_agent_id = B's AgentId
   - signed_public_key = B's public key
   - trust_level = chosen level (1-2; 3 only for self)
   - expiry = now + signature_validity (recommended: 90 days)
3. A signs with its own secret key.
4. A gives the TrustSignature to B (or stores it locally).

### 4.5 Verification

To verify a TrustSignature:

1. Check type == "aafp-wot-sig-v1".
2. Check signed_agent_id == SHA-256(signed_public_key).
3. Check signer_agent_id matches the signer's known public key.
4. Verify the ML-DSA-65 signature using the signer's public key.
5. Check expiry > current_time.
6. Check trust_level is in range [0, 3].

### 4.6 Transitive Trust Computation

`WebOfTrust::trust_level(target_agent_id) → u8`:

1. If the agent has directly signed the target: return the signed
   trust_level (capped at Full = 2; Ultimate = 3 only for self).
2. BFS from the agent's own AgentId through the trust graph:
   - Direct signatures: trust_level as signed (max 2).
   - One hop: Marginal (1).
   - Two+ hops: None (0).
3. Return the maximum trust level found across all paths.
4. Expired signatures are ignored.
5. Invalid signatures are ignored.

### 4.7 RPC Method: aafp.wot.sign

Agent A requests B to sign A's key:

```cbor
aafp.wot.sign = {
    1: bstr,    // requester_agent_id: 32 bytes
    2: bstr,    // requester_public_key: 1952 bytes
}
```

```cbor
aafp.wot.sign.response = {
    1: bstr / null,  // trust_signature: TrustSignature CBOR bytes, or null
                     //   if B declines to sign
}
```

B reviews the request (possibly with user confirmation), decides a
trust level, signs A's key, and returns the TrustSignature.

### 4.8 Handshake Integration

After the AAFP v1 handshake completes, agents MAY exchange trust
signatures:

1. Each agent sends its TrustSignatures for the peer (if any).
2. Each agent stores received TrustSignatures in its WebOfTrust.
3. The WebOfTrust is used to compute trust level for future connections.

This exchange is optional and does not affect the handshake itself.

## 5. CA Certificates

### 5.1 Overview

A Certificate Authority (CA) signs agent certificates, binding an
AgentId and public key to a set of capabilities with a validity period.
Agents that trust the CA can verify any certificate it issues.

CA certificates use ML-DSA-65 signatures, NOT X.509. This keeps the
cryptographic primitives consistent with the rest of AAFP and provides
post-quantum security.

### 5.2 CaCertificate Format

```cbor
CaCertificate = {
    1: tstr,         // type: "aafp-ca-cert-v1"
    2: bstr,         // agent_id: 32 bytes
    3: bstr,         // public_key: 1952 bytes (ML-DSA-65)
    4: tstr,         // issuer: CA name (human-readable)
    5: bstr,         // issuer_public_key: 1952 bytes (CA's ML-DSA-65 key)
    6: uint,         // serial_number: unique per CA
    7: uint,         // not_before: unix timestamp
    8: uint,         // not_after: unix timestamp
    9: [ *tstr ],    // capabilities: capabilities allowed by this cert
    10: bstr,        // ca_signature: ML-DSA-65 over fields 1-9
                     //   with domain separator "aafp-v1-ca"
}
```

### 5.3 Domain Separator

The CA domain separator is `"aafp-v1-ca"`. The signature input is:

```
sig_input = "aafp-v1-ca" || canonical_CBOR(fields 1-9)
ca_signature = ML-DSA-65.Sign(ca_secret_key, sig_input)
```

### 5.4 Certificate Issuance

1. The CA generates a keypair (or uses an existing one).
2. The agent provides its AgentId and public key to the CA.
3. The CA creates a CaCertificate with:
   - agent_id, public_key from the agent
   - issuer, issuer_public_key from the CA
   - serial_number: unique, monotonically increasing
   - not_before, not_after: validity period
   - capabilities: capabilities the CA authorizes
4. The CA signs the certificate with its secret key.
5. The CA gives the certificate to the agent.

### 5.5 Certificate Verification

To verify a CaCertificate:

1. Check type == "aafp-ca-cert-v1".
2. Check agent_id == SHA-256(public_key).
3. Check not_before <= current_time < not_after.
4. Verify the ca_signature using issuer_public_key.
5. Check that issuer_public_key is a trusted CA key (in CaVerifier's
   trusted roots).
6. Check that the certificate is not revoked (query RevocationStore).

### 5.6 Certificate Chains

A CA may itself have a certificate from a root CA. Chain verification:

1. Verify the leaf certificate (agent's cert) against the intermediate
   CA's public key.
2. Verify the intermediate CA's certificate against the root CA's
   public key.
3. The root CA's public key must be in the trusted roots set.

Self-signed certificates (where issuer == agent) are rejected unless
the CA's public key is in the trusted roots set. This prevents an
agent from creating its own "CA" and self-certifying.

### 5.7 Handshake Integration

An agent MAY present a CA certificate alongside its AgentRecord:

1. After the handshake, the peer checks for a CA certificate.
2. If present: verify the certificate chain using trusted CA keys.
3. If verification succeeds: trust the peer (TrustSource = CA,
   level = Full).
4. If no CA certificate: fall back to WoT, directory, or TOFU.

### 5.8 AgentBuilder Configuration

- `.with_ca_cert(path)` — Load the agent's own CA certificate (to
  present to peers).
- `.with_trusted_ca(path)` — Load trusted root CA public keys (to
  verify peer certificates).

## 6. Key Rotation

### 6.1 Overview

When an agent needs to generate a new keypair (e.g., key compromise
concern, algorithm upgrade), it creates a KeyRotationRecord signed by
both the old and new keys. This proves continuity of identity.

### 6.2 KeyRotationRecord Format

```cbor
KeyRotationRecord = {
    1: tstr,    // type: "aafp-rotation-v1"
    2: bstr,    // old_agent_id: 32 bytes
    3: bstr,    // new_agent_id: 32 bytes
    4: bstr,    // new_public_key: 1952 bytes
    5: uint,    // timestamp: unix timestamp
    6: bstr,    // old_signature: ML-DSA-65 over fields 1-5
                //   with domain separator "aafp-v1-rotation"
                //   signed by old key
    7: bstr,    // new_signature: ML-DSA-65 over fields 1-5
                //   with domain separator "aafp-v1-rotation"
                //   signed by new key
}
```

### 6.3 Domain Separator

The rotation domain separator is `"aafp-v1-rotation"`. Both signatures
cover the same input:

```
sig_input = "aafp-v1-rotation" || canonical_CBOR(fields 1-5)
old_signature = ML-DSA-65.Sign(old_secret_key, sig_input)
new_signature = ML-DSA-65.Sign(new_secret_key, sig_input)
```

### 6.4 Rotation Verification

To verify a KeyRotationRecord:

1. Check type == "aafp-rotation-v1".
2. Check old_agent_id == SHA-256(old_public_key). The old public key
   must be known from the directory, WoT, or prior connection.
3. Check new_agent_id == SHA-256(new_public_key).
4. Verify old_signature using the old public key. This proves the old
   key authorized the rotation.
5. Verify new_signature using the new public key. This proves the new
   key is controlled by the same entity.
6. Both signatures MUST verify. A rotation with only one signature is
   invalid.

### 6.5 Rotation Process

1. Agent generates a new keypair.
2. Agent creates a KeyRotationRecord with old and new key info.
3. Agent signs with both old and new secret keys.
4. Agent publishes the rotation record to the directory
   (`aafp.directory.rotate`).
5. Agent publishes the new AgentRecord to the directory.
6. Agent revokes the old key (creates a RevocationEntry for old_agent_id).
7. Agent notifies peers (gossip the rotation record and revocation).

### 6.6 Directory Integration

`aafp.directory.rotate`:

```cbor
aafp.directory.rotate = {
    1: bstr,    // rotation_record: KeyRotationRecord CBOR bytes
}
```

```cbor
aafp.directory.rotate.response = {
    1: uint,    // status: 0 = success, 1 = invalid, 2 = error
    2: tstr,    // message
}
```

The directory verifies the rotation record signatures, then:
- Removes (or marks superseded) the old AgentRecord.
- Stores the new AgentRecord.
- Records the rotation mapping (old_agent_id → new_agent_id) for
  clients that look up the old AgentId.

### 6.7 WoT Integration

When a rotation is received:
- All TrustSignatures that referenced old_agent_id are updated to
  reference new_agent_id (with the new public key).
- The WoT graph replaces old_agent_id with new_agent_id.
- Trust signatures from the old key are no longer valid (the old key
  is revoked).

### 6.8 CA Integration

When a rotation is received:
- The old CA certificate MUST be revoked.
- A new CA certificate MUST be issued for the new key.
- The agent presents the new CA certificate to peers.

### 6.9 Security Considerations

- **Key theft:** If an attacker steals the old private key, they can
  create a valid rotation record. **Mitigation:** Agents SHOULD publish
  rotations with a delay (e.g., 24 hours) so the legitimate owner can
  detect theft by seeing an unexpected rotation in the directory.
  Critical deployments SHOULD use a multi-sig rotation (require
  signatures from multiple keys, not just the old key).
- **Replay:** A rotation record is not replayable (it references
  specific old and new AgentIds). But an attacker who steals the old
  key could create a rotation to a key they control. The delay
  mitigation above addresses this.
- **Old key revocation:** The old key MUST be revoked after rotation.
  Otherwise, an attacker who stole the old key can still use it.

## 7. Networked Revocation Distribution

### 7.1 Overview

The RevocationStore (RFC-0003 amendment) exists but is local-only.
This section specifies networked distribution of CRLs via gossip and
directory queries.

### 7.2 RPC Methods

| Method | Direction | Description |
|--------|-----------|-------------|
| `aafp.revocation.publish` | Agent→Peer/Directory | Publish a CRL |
| `aafp.revocation.query` | Agent→Peer/Directory | Check if an AgentId is revoked |
| `aafp.revocation.list` | Agent→Peer | Get all known revocations |

### 7.3 Publish

```cbor
aafp.revocation.publish = {
    1: bstr,    // crl: RevocationList CBOR bytes
}
```

```cbor
aafp.revocation.publish.response = {
    1: uint,    // status: 0 = accepted, 1 = rejected
    2: tstr,    // message
}
```

### 7.4 Query

```cbor
aafp.revocation.query = {
    1: bstr,    // agent_id: 32 bytes
}
```

```cbor
aafp.revocation.query.response = {
    1: bstr / null,  // entry: RevocationEntry CBOR bytes, or null if not revoked
}
```

### 7.5 List

```cbor
aafp.revocation.list = {}
```

```cbor
aafp.revocation.list.response = {
    1: bstr,    // crl: RevocationList CBOR bytes (all known revocations)
}
```

### 7.6 Gossip Protocol

1. **Periodic exchange:** Every 5 minutes, agents exchange their full
   CRL with connected peers via `aafp.revocation.list`.
2. **Merge:** Received CRLs are merged into the local RevocationStore.
   Duplicate entries are deduplicated.
3. **Push on new revocation:** When an agent creates a new
   RevocationEntry, it immediately pushes the CRL to all connected
   peers via `aafp.revocation.publish`.
4. **Directory integration:** CRLs are also published to the directory
   via `aafp.directory.crl`, making them queryable by any agent.

### 7.7 Handshake Integration

1. **Before accepting a peer:** Check the local RevocationStore. If
   the peer's AgentId is revoked, reject the connection.
2. **After handshake:** Exchange CRLs (gossip). Merge received CRLs
   into the local store.
3. **Directory query:** If the local store doesn't have revocation info
   for a peer, query the directory (`aafp.revocation.query`).

### 7.8 CRL Expiry

CRLs have a TTL (default: 1 hour, see RFC-0003 amendment
`DEFAULT_CRL_TTL_SECS`). Expired CRLs are evicted from the
RevocationStore. This prevents stale revocation data from persisting
indefinitely.

Agents SHOULD re-publish their CRLs before expiry to ensure continuous
coverage.

## 8. TrustManager API

### 8.1 Overview

The TrustManager combines all trust sources into a single API. It is
called after the handshake completes, before the application begins
exchanging data.

### 8.2 TrustResult

```rust
pub enum TrustResult {
    /// The peer is trusted.
    Trusted { source: TrustSource, level: u8 },
    /// The peer is not trusted (verification failed).
    Untrusted { reason: String },
    /// The peer's key is revoked.
    Revoked { reason: String },
    /// No trust information available.
    Unknown { suggestion: TrustSuggestion },
}
```

### 8.3 TrustSource

```rust
pub enum TrustSource {
    /// Direct trust (connected before, key cached).
    Direct,
    /// Web of Trust (transitive trust from peers).
    WebOfTrust,
    /// CA certificate (verified against trusted CA).
    CertificateAuthority,
    /// Key directory (verified against directory record).
    Directory,
    /// Trust On First Use (no other source available).
    Tofu,
}
```

### 8.4 TrustSuggestion

```rust
pub enum TrustSuggestion {
    /// Trust on first use (show key fingerprint to user).
    Tofu,
    /// Look up in key directory.
    QueryDirectory,
    /// Ask a mutual contact to sign.
    RequestWotSignature,
    /// Ask peer to get a CA certificate.
    RequestCaCert,
}
```

### 8.5 Verification Order

`TrustManager::verify_peer(agent_id, public_key) → TrustResult`:

1. **Revocation check (highest priority):** If the AgentId is in the
   RevocationStore, return `Revoked`. This overrides all other sources.

2. **Direct trust:** If the AgentId is in the local trusted-peers cache
   (connected before, key matches), return `Trusted { Direct, level }`.

3. **CA certificate:** If the peer presented a CA certificate and it
   verifies against a trusted CA, return `Trusted { CA, Full }`.

4. **Web of Trust:** Compute the WoT trust level. If ≥ Marginal (1),
   return `Trusted { WoT, level }`.

5. **Directory:** Query the directory. If the record matches and
   verifies, return `Trusted { Directory, Full }`.

6. **Unknown:** If no trust source provides information, return
   `Unknown` with a suggestion:
   - If a directory is configured: suggest `QueryDirectory`.
   - If WoT is configured: suggest `RequestWotSignature`.
   - Otherwise: suggest `Tofu`.

7. **TOFU (application decision):** The application decides whether to
   accept TOFU. If accepted, the peer is added to the direct-trust
   cache for future connections.

### 8.6 Policy Configuration

The agent's trust policy determines what happens for each TrustResult:

- `Trusted`: proceed with the connection.
- `Untrusted`: log warning, optionally reject (configurable).
- `Revoked`: reject immediately (always).
- `Unknown`: trigger TOFU prompt or directory lookup (configurable).

Policies:
- `Strict`: reject Unknown and Untrusted. Only accept Trusted.
- `Cautious`: accept Trusted, reject Untrusted and Revoked, prompt for
  Unknown.
- `Permissive`: accept Trusted and Unknown (TOFU), reject Revoked.

## 9. Security Considerations

### 9.1 MITM Attack

**Threat:** An attacker intercepts the first connection and presents
their own key.

**Mitigation:**
- Directory: The peer's record is looked up in the directory. A MITM
  cannot substitute their key because the directory's record won't
  match.
- WoT: A mutual contact's signature vouches for the peer's key.
- CA: The CA's signature vouches for the peer's key.
- TOFU: The user compares fingerprints out-of-band (RFC-0003 §2.6).

### 9.2 Key Compromise

**Threat:** An attacker steals an agent's private key.

**Mitigation:**
- Revocation: The agent (or a trusted third party) revokes the
  compromised key. The revocation propagates via gossip and directory.
- Key rotation: The agent rotates to a new key, signing the rotation
  with the old key (if still accessible) and the new key.
- Delay on rotation acceptance: A 24-hour delay on accepting rotations
  gives the legitimate owner time to detect theft.

### 9.3 Replay Attack

**Threat:** An attacker replays an old trust assertion (TrustSignature,
CA certificate, rotation record).

**Mitigation:**
- TrustSignatures have expiry timestamps. Expired signatures are
  ignored.
- CA certificates have not_before/not_after. Expired certificates are
  rejected.
- Rotation records are not replayable (they reference specific old and
  new AgentIds). But an attacker with the old key could create a new
  rotation — see Section 6.9.
- Revocation entries have timestamps. The RevocationStore evicts
  expired CRLs.

### 9.4 Directory Compromise

**Threat:** The directory server is compromised and serves wrong
records.

**Mitigation:**
- The directory signs responses with its own key. If the directory's
  key is compromised, all its records are suspect. Agents SHOULD
  configure multiple directories and cross-check.
- AgentRecords are self-signed. A compromised directory cannot forge
  records (it can't sign with the agent's key). It can only serve
  stale or missing records.
- WoT and CA provide decentralized alternatives that don't depend on
  the directory.

### 9.5 CA Compromise

**Threat:** The CA's private key is compromised and the attacker issues
fraudulent certificates.

**Mitigation:**
- The CA key is revoked. All certificates issued by the CA become
  untrusted.
- WoT and directory provide alternatives that don't depend on the CA.
- Multiple CAs can be configured for redundancy.

### 9.6 Sybil Attack

**Threat:** An attacker creates many agent identities to manipulate WoT
trust.

**Mitigation:**
- WoT trust decays with distance (Section 2.1). Two-hop trust is
  None (0). An attacker needs direct signatures from trusted agents
  to gain any trust.
- Ultimate trust (3) is never granted transitively.
- Agents SHOULD require out-of-band verification before granting Full
  trust (2) in WoT.

### 9.7 Privacy

**Threat:** A public directory reveals which agents exist and their
public keys.

**Mitigation:**
- Directories MAY require authentication to query (future work).
- AgentRecords contain endpoints (multiaddrs). Agents MAY omit
  endpoints from records published to public directories.
- WoT signatures are exchanged point-to-point, not published centrally.
- CA certificates are presented by the agent, not looked up centrally.

## 10. IANA Considerations

This RFC defines new RPC method names in the `aafp.*` namespace:

- `aafp.directory.lookup`
- `aafp.directory.publish`
- `aafp.directory.rotate`
- `aafp.directory.crl`
- `aafp.wot.sign`
- `aafp.revocation.publish`
- `aafp.revocation.query`
- `aafp.revocation.list`

No IANA registration is required (the `aafp.*` namespace is managed by
the AAFP project).

## 11. CBOR Type Registry

New CBOR type strings defined in this RFC:

| Type String | Structure |
|-------------|-----------|
| `"aafp-wot-sig-v1"` | TrustSignature (Section 4.2) |
| `"aafp-ca-cert-v1"` | CaCertificate (Section 5.2) |
| `"aafp-rotation-v1"` | KeyRotationRecord (Section 6.2) |

New domain separators:

| Separator | Context |
|-----------|---------|
| `"aafp-v1-wot"` | WoT signature (Section 4.3) |
| `"aafp-v1-ca"` | CA certificate signature (Section 5.3) |
| `"aafp-v1-rotation"` | Key rotation signatures (Section 6.3) |

These follow the prefix-free domain separation rule from RFC-0003 §3.5.

## 12. Forward Compatibility

Future versions of TrustSignature, CaCertificate, and
KeyRotationRecord MAY add new fields with integer keys ≥ 10 (for
TrustSignature and KeyRotationRecord) or ≥ 11 (for CaCertificate, which
uses key 10 for ca_signature). Implementations MUST ignore unknown
fields.

New trust sources MAY be added in future RFCs. The TrustManager API
(Section 8) is extensible: new TrustSource variants can be added
without breaking existing implementations.
