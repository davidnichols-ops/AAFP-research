# Track P: Identity & PKI — Trust Bootstrap for Production

**Priority:** CRITICAL
**Duration:** 2-3 weeks
**Blocked by:** nothing (can start immediately)
**Blocks:** Track Q (security audit needs trust model to audit)

---

## Problem

AAFP agents authenticate each other via ML-DSA-65 signatures in the
AAFP v1 handshake. The handshake verifies that `agent_id == SHA-256(public_key)`
and that the peer holds the private key (signature verification). This
proves *who* you're talking to — but not *whether you should trust them*.

The current trust model is TOFU (Trust On First Use): the first time
you connect to an agent, you trust their public key. There is no:
- Certificate Authority (CA) to vouch for agent identity
- Web of Trust (WoT) where peers vouch for each other
- Key directory where agents can look up trusted public keys
- Key rotation mechanism (what happens when an agent generates a new keypair?)
- Key revocation that's actually distributed (RevocationStore exists but
  is local-only, not networked)

This is fine for a research protocol. For production, an agent needs to
answer: "I've never connected to agent X before. Should I trust their
public key? Is it really agent X, or is this a MITM?"

---

## Steps

### P1: Design the trust model

Decide and document the trust model for AAFP.

- Evaluate three options:
  1. **CA-based PKI:** A central CA signs agent certificates. Agents
     verify the CA signature before trusting a peer. Simple, but
     centralized (the CA is a trust root and a single point of failure).
  2. **Web of Trust (WoT):** Agents sign each other's keys. Trust is
     transitive: if I trust A, and A trusts B, I can trust B (with
     some confidence threshold). Decentralized, but complex and slow.
  3. **Key directory (like Keybase/Signal Safety Numbers):** A
     directory service maps agent_id → public_key. Agents verify
     the directory's signature on the mapping. Centralized directory
     but decentralized trust (anyone can run a directory).

- Recommended: **Hybrid model** — Key directory (P3) for bootstrap,
  WoT (P4) for decentralized trust, CA (P5) for enterprise deployments.
  Agents can use any or all of these.

- Write RFC 0011 (Trust Bootstrap) documenting the chosen model:
  - Key directory protocol (query, publish, verify)
  - WoT signature format (who signs whom, trust depth, expiry)
  - CA certificate format (X.509-like but with ML-DSA-65)
  - How these integrate with the existing AAFP handshake
  - Security considerations (replay, MITM, key compromise)

- **VERIFY:** RFC 0011 is written and covers all three trust models

KEY FILES:
  RFCs/0003-identity-authentication.md
    - Current identity spec (AgentId, AgentRecord, UCAN)
  RFCs/0011-trust-bootstrap.md (NEW)
    - The new trust model spec

### P2: Key directory client and server

Implement a key directory that maps agent_id → public_key + metadata.

- Design the directory protocol:
  - `aafp.directory.lookup(agent_id) → AgentRecord` (query)
  - `aafp.directory.publish(record)` (publish your own record)
  - `aafp.directory.verify(agent_id, record) → bool` (verify signature)

- Implement `KeyDirectory` type:
  - In-memory HashMap<AgentId, AgentRecord> (for testing)
  - Persistent backend (SQLite, like PersistentDht)
  - Records are self-signed (AgentRecord already has signatures)
  - Optional: directory signs records with its own key (adds trust)

- Implement `KeyDirectoryClient`:
  - Connect to a directory server
  - Lookup agent records by agent_id
  - Publish own record
  - Verify record signatures

- Implement `KeyDirectoryServer`:
  - Accept lookup and publish RPC requests
  - Store records in SQLite
  - Rate-limit publish (1 per agent per hour)
  - Return signed responses (if directory has its own key)

- Add to AgentBuilder:
  - `.with_directory("quic://directory.example.com:4433")`
  - On connect: if peer is unknown, query directory for their record
  - Verify the record's signature and agent_id match

- **VERIFY:** Agent A publishes to directory, Agent B looks up A's
  record and verifies it before connecting

KEY FILES:
  implementations/rust/crates/aafp-identity/src/identity_v1.rs
    - AgentRecord (self-signed, has verify() method)
  implementations/rust/crates/aafp-discovery/src/persistent_dht.rs
    - Pattern for SQLite backend
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs
    - Pattern for RPC handlers
  implementations/rust/crates/aafp-identity/src/keypair.rs
    - AgentKeypair (used for signing records)

### P3: Web of Trust (peer key signing)

Implement peer-to-peer key signing for decentralized trust.

- Design the WoT signature format:
  ```cbor
  {
    1: bstr,    // signer_agent_id (32 bytes)
    2: bstr,    // signed_agent_id (32 bytes)
    3: bstr,    // signed_public_key (1952 bytes)
    4: uint,    // trust_level (0-3: none, marginal, full, ultimate)
    5: uint,    // expiry (unix timestamp)
    6: bstr,    // signature (ML-DSA-65 over the above fields)
  }
  ```

- Implement `TrustSignature` type:
  - Sign: agent A signs agent B's key with a trust level
  - Verify: check A's signature, check not expired, check B's key matches
  - CBOR encode/decode

- Implement `WebOfTrust` type:
  - Store trust signatures received from peers
  - `trust_level(agent_id) → u8`: compute trust level via transitive trust
    - Direct signature: trust_level from the signature
    - Transitive: if I trust A (full), and A trusts B (full), I trust B (marginal)
    - Use a simple graph algorithm (BFS with trust decay)
  - `add_trust_signature(sig)`: add a signature to the WoT
  - `export_trust()` / `import_trust()`: serialize/deserialize the WoT

- Add WoT to the handshake:
  - After AAFP handshake completes, exchange trust signatures
  - "I trust agent X with level Y" — signed by me
  - Store received signatures in WebOfTrust
  - Use WoT to compute trust level for unknown peers

- Add `aafp.wot.sign` RPC method:
  - Agent A requests B to sign A's key
  - B signs A's key with its trust level
  - B returns the TrustSignature to A
  - A stores it and can show it to others

- **VERIFY:** Agent A signs B's key, B signs C's key, A can compute
  transitive trust for C

KEY FILES:
  implementations/rust/crates/aafp-identity/src/identity_v1.rs
    - AgentRecord signing pattern
  implementations/rust/crates/aafp-identity/src/ucan.rs
    - UcanToken (similar signing pattern — learn from this)
  implementations/rust/crates/aafp-identity/src/revocation.rs
    - RevocationEntry (similar signature pattern)
  implementations/rust/crates/aafp-identity/src/lib.rs
    - Add web_of_trust module

### P4: CA-based certificate support

Implement optional CA-signed certificates for enterprise deployments.

- Design the CA certificate format:
  ```cbor
  {
    1: tstr,         // type: "aafp-ca-cert-v1"
    2: bstr,         // agent_id (32 bytes)
    3: bstr,         // public_key (1952 bytes)
    4: tstr,         // issuer (CA name)
    5: bstr,         // issuer_public_key (1952 bytes)
    6: uint,         // serial_number
    7: uint,         // not_before (unix timestamp)
    8: uint,         // not_after (unix timestamp)
    9: [tstr],       // capabilities allowed by this cert
    10: bstr,        // ca_signature (ML-DSA-65 over fields 1-9)
  }
  ```

- Implement `CaCertificate` type:
  - Sign: CA signs an agent's key with validity period and capabilities
  - Verify: check CA signature, check validity period, check capabilities
  - CBOR encode/decode
  - Chain verification: if the CA itself has a certificate from a root CA

- Implement `CaVerifier`:
  - Store trusted root CA public keys
  - Verify certificate chains: agent → intermediate CA → root CA
  - Check revocation (using existing RevocationStore)
  - Check expiry

- Integrate with handshake:
  - Agent presents CA certificate alongside AgentRecord
  - Peer verifies the CA certificate (if it trusts the CA)
  - If CA verification succeeds, skip TOFU prompt
  - If no CA certificate, fall back to TOFU or WoT

- Add `AgentBuilder::with_ca_cert(path)` and `with_trusted_ca(path)`:
  - Load CA certificate from file
  - Load trusted root CA keys from file

- **VERIFY:** CA signs agent A's key, agent B trusts the CA, B verifies
  A's certificate and connects without TOFU

KEY FILES:
  implementations/rust/crates/aafp-identity/src/identity_v1.rs
    - AgentRecord (pattern for self-signed records)
  implementations/rust/crates/aafp-identity/src/revocation.rs
    - RevocationStore (CA cert verification uses this)
  implementations/rust/crates/aafp-crypto/src/dsa.rs
    - MlDsa65::sign(), verify() (used for CA signatures)

### P5: Key rotation

Implement key rotation for when an agent needs to generate a new keypair.

- Design key rotation protocol:
  1. Agent generates new keypair
  2. Agent signs the new public key with the OLD private key
  3. Agent publishes the rotation record to directory and peers
  4. Peers verify the old key's signature and update their trust

- Implement `KeyRotationRecord`:
  ```cbor
  {
    1: bstr,    // old_agent_id (32 bytes)
    2: bstr,    // new_agent_id (32 bytes)
    3: bstr,    // new_public_key (1952 bytes)
    4: uint,    // timestamp (unix)
    5: bstr,    // old_signature (ML-DSA-65 over fields 1-4)
    6: bstr,    // new_signature (ML-DSA-65 over fields 1-4, proves new key)
  }
  ```

- Implement rotation verification:
  - Verify old_signature with old public key (proves old key authorized rotation)
  - Verify new_signature with new public key (proves new key is controlled)
  - Check that old_agent_id == SHA-256(old_public_key)
  - Check that new_agent_id == SHA-256(new_public_key)

- Integrate with directory:
  - `aafp.directory.rotate(rotation_record)`: update directory mapping
  - Old agent_id → new agent_id, old public_key → new public_key
  - Directory verifies the rotation record signatures

- Integrate with WoT:
  - Trust signatures for old key carry over to new key
  - WoT graph updates: old_agent_id replaced with new_agent_id

- Integrate with CA:
  - CA must issue a new certificate for the new key
  - Old certificate is revoked

- **VERIFY:** Agent A rotates key, agent B receives rotation record,
  updates trust, and can connect to A's new identity

KEY FILES:
  implementations/rust/crates/aafp-identity/src/keypair.rs
    - AgentKeypair::generate() — used for new key generation
  implementations/rust/crates/aafp-identity/src/identity_v1.rs
    - AgentRecord — rotation produces a new record

### P6: Networked revocation distribution

The RevocationStore (F3) exists but is local-only. Make it networked.

- Design revocation distribution protocol:
  - `aafp.revocation.publish(crl)`: Publish a CRL to peers/directory
  - `aafp.revocation.query(agent_id) → Option<RevocationEntry>`: Check if revoked
  - `aafp.revocation.list() → RevocationList`: Get all known revocations

- Implement `RevocationDistribution`:
  - Periodic gossip: every 5 minutes, exchange CRLs with connected peers
  - Directory integration: CRLs published to directory, queryable by anyone
  - Push notifications: when a revocation is received, push to all connected peers

- Integrate with handshake:
  - Before accepting a peer, check RevocationStore
  - If peer's agent_id is revoked, reject the connection
  - After handshake, exchange CRLs (gossip)

- Integrate with key rotation:
  - When a key is rotated, the old key should be revoked
  - Publish revocation for old agent_id

- **VERIFY:** Agent A is revoked, revocation propagates to B via gossip,
  B rejects A's connection attempt

KEY FILES:
  implementations/rust/crates/aafp-identity/src/revocation.rs
    - RevocationStore, RevocationList, RevocationEntry (existing)
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs
    - Pattern for RPC handlers

### P7: Trust UI and verification API

Provide a clean API for agents to make trust decisions.

- Implement `TrustManager` that combines all trust sources:
  1. Direct trust (I've connected before, key is cached)
  2. WoT trust (transitive trust from peers)
  3. CA trust (certificate from a trusted CA)
  4. Directory trust (record from a trusted directory)
  5. Revocation check (is the key revoked?)

- `TrustManager::verify_peer(agent_id, public_key) → TrustResult`:
  - `TrustResult::Trusted { source: TrustSource, level: u8 }`
  - `TrustResult::Untrusted { reason: String }`
  - `TrustResult::Revoked { entry: RevocationEntry }`
  - `TrustResult::Unknown { suggestion: TrustSuggestion }`

- `TrustSuggestion`:
  - `Tofu`: Trust on first use (show key fingerprint to user)
  - `QueryDirectory`: Look up in key directory
  - `RequestWotSignature`: Ask a mutual contact to sign
  - `RequestCaCert`: Ask peer to get a CA certificate

- Add `Agent::verify_peer(peer_id) → TrustResult`:
  - Called after handshake, before accepting the connection
  - If Trusted → proceed
  - If Untrusted → log warning, optionally reject
  - If Revoked → reject immediately
  - If Unknown → trigger TOFU or directory lookup

- Add CLI command `aafp trust list` / `aafp trust revoke`:
  - List trusted peers and their trust source
  - Manually revoke a peer

- **VERIFY:** Agent B connects to unknown agent A, TrustManager
  returns Unknown with suggestion QueryDirectory, B queries directory,
  gets Trusted result

KEY FILES:
  implementations/rust/crates/aafp-sdk/src/lib.rs
    - Agent struct — add trust_manager field
  implementations/rust/crates/aafp-sdk/src/builder.rs
    - AgentBuilder — add trust configuration
  implementations/rust/crates/aafp-cli/src/
    - CLI commands

### P8: End-to-end trust scenario testing

Test the complete trust lifecycle.

- Test scenarios:
  1. **TOFU:** A connects to B for the first time → trust on first use
  2. **Directory:** A publishes to directory, B looks up A → trusted
  3. **WoT:** A signs B, C trusts A → C trusts B (transitive)
  4. **CA:** CA signs A, B trusts CA → B trusts A
  5. **Key rotation:** A rotates key, B receives rotation → B trusts new key
  6. **Revocation:** A is revoked, B receives CRL → B rejects A
  7. **Revoked + rotated:** A's old key is revoked, A's new key is trusted
  8. **MITM detection:** Attacker presents wrong key → TrustManager rejects

- Write results to test-results/security/trust-scenarios.json
- **VERIFY:** All 8 trust scenarios produce correct behavior

---

## Expected Outcomes

| Capability | Before | After |
|-----------|--------|-------|
| Trust model | TOFU only | Hybrid (TOFU + WoT + CA + Directory) |
| Key directory | None | Working (lookup, publish, verify) |
| Web of Trust | None | Working (transitive trust, key signing) |
| CA certificates | None | Working (issue, verify, chain) |
| Key rotation | None | Working (old key signs new key) |
| Revocation distribution | Local only | Networked (gossip + directory) |
| Trust API | None | TrustManager with TrustResult |
| MITM detection | None | TrustManager rejects unknown keys |

---

## Risks & Mitigations

1. **CA is a central point of failure.** If the CA is compromised, all
   certificates are suspect. **Mitigation:** WoT and directory provide
   decentralized alternatives. CA is optional, not required.

2. **WoT trust is subjective.** Different agents may compute different
   trust levels for the same peer. **Mitigation:** Document that WoT is
   advisory, not authoritative. Agents make their own trust decisions.

3. **Key rotation can be abused.** If an attacker steals the old key,
   they can rotate to a new key they control. **Mitigation:** Require
   a delay between rotation and acceptance (e.g., 24 hours). Publish
   rotation to directory so the legitimate owner can detect theft.

4. **Revocation propagation is slow.** Gossip-based CRL distribution
   may take minutes to reach all peers. **Mitigation:** Directory-based
   revocation query provides immediate check. Critical revocations can
   use push notifications.

5. **Privacy concerns with key directory.** A public directory reveals
   which agents exist and their public keys. **Mitigation:** Directory
   can be private (require authentication to query). Document privacy
   implications in RFC 0011.
