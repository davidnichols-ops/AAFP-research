# Phase 5: Authentication Architecture

```
Phase:          5 of 16
Title:          Authentication Architecture
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Deep-dive into authentication across AAFP and all ecosystem protocols.
Compare handshake mechanisms, mutual authentication, channel binding,
and resistance to attacks. Identify AAFP's authentication strengths and
gaps.

## 2. Authentication Mechanisms Compared

| Protocol | Mechanism | Mutual Auth? | Channel Binding? | PQ? | Signature Ops | Round Trips |
|----------|-----------|-------------|-----------------|-----|---------------|-------------|
| **AAFP** | **3-way handshake (CH->SH->CF) + TLS PQ KEX** | **Yes** | **Yes (TLS binding in transcript)** | **Yes** | **3 ML-DSA-65** | **1.5** |
| MCP | OAuth 2.1 token | No (server-only) | No | No | 0 (token validation) | 2-3+ (OAuth flow) |
| A2A | TLS + optional JWS | Optional (mTLS) | No | No | 0-1 (JWS) | 1-2 |
| ANP | DID mutual auth | Yes | No | No | 2 (DID sigs) | 2 |
| SLIM | MLS Welcome + JWT/SPIFFE | Yes | MLS group state | No | MLS sigs | 1-2 |
| AgentMesh | IATP challenge-response | Yes | No | No | 2 Ed25519 | 2 |

## 3. AAFP Handshake Deep Dive

### 3.1 Message Flow

```
Client                              Server
  |                                    |
  |  TLS handshake (X25519MLKEM768)    |
  |  <------------------------------>  |
  |  ALPN: aafp/1                      |
  |                                    |
  |  ClientHello                       |
  |  (agent_id, pubkey, nonce, caps,   |
  |   signature, expires_at, DoS MAC)  |
  |  ------------------------------>   |
  |                                    |
  |              ServerHello           |
  |  (agent_id, pubkey, nonce, caps,   |
  |   session_id, signature, expires)  |
  |  <------------------------------   |
  |                                    |
  |  ClientFinished                    |
  |  (session_id, signature)           |
  |  ------------------------------>   |
  |                                    |
  |  ====== MessagingEnabled ======    |
```

### 3.2 Security Properties

1. **Mutual authentication**: Both parties sign the transcript hash with
   ML-DSA-65. Each verifies the other's `agent_id == SHA-256(public_key)`.

2. **Channel binding**: The transcript hash is seeded with `tls_binding`
   (the TLS exporter value), binding the AAFP handshake to the underlying
   TLS session. This prevents relay attacks — the handshake cannot be
   replayed over a different TLS channel.

3. **Post-quantum**: ML-DSA-65 signatures (FIPS 204) + X25519MLKEM768
   KEX. Both are quantum-resistant.

4. **Replay protection**: 32-byte nonces in both ClientHello and
   ServerHello. ReplayCache checks `(agent_id, nonce)` uniqueness across
   connections before signature verification (CPU conservation).

5. **DoS protection**: Optional `receiver_mac` field —
   `HMAC-SHA256(HKDF(agent_id, "aafp-v1-dos-mac-key"), ClientHello_cbor)`.
   Allows server to verify ClientHello authenticity before spending CPU
   on ML-DSA-65 verification (3309-byte signatures are expensive).

6. **Session ID binding**: Session ID is derived via HKDF with
   `server_agent_id` as part of the IKM (A-4 amendment), binding the
   session to the server's identity. This prevents session fixation.

7. **Forward secrecy**: TLS 1.3 with X25519MLKEM768 provides forward
   secrecy at the transport layer. Post-handshake AEAD encryption
   provides additional confidentiality.

8. **Domain separation**: All signature operations use prefix-free
   domain separators (`aafp-v1-record`, `aafp-v1-handshake`, `aafp-v1-ucan`),
   preventing cross-context signature reuse per IETF CFRG requirements.

### 3.3 Transcript Hash Construction

```
h0 = SHA-256(tls_binding)                          // Bind to TLS channel
h1 = SHA-256(h0 || canonical_CBOR(ClientHello))    // Add ClientHello
h2 = SHA-256(h1 || canonical_CBOR(ServerHello))    // Add ServerHello
h3 = SHA-256(h2 || canonical_CBOR(ClientFinished)) // Add ClientFinished
```

Each message is signed over `domain_separator || transcript_hash_so_far`:
- ClientHello signs over `h1`
- ServerHello signs over `h2`
- ClientFinished signs over `h3`

This ensures each signature covers all prior messages, providing
end-to-end integrity of the handshake.

## 4. Comparison with Ecosystem Handshakes

### 4.1 AAFP vs. OAuth 2.1 (MCP, A2A)

| Property | AAFP | OAuth 2.1 |
|----------|------|-----------|
| Mutual auth | Yes (both parties sign) | No (client proves identity to server) |
| Crypto | ML-DSA-65 (PQ) | RSA/ECDSA (classical) |
| Channel binding | Yes (TLS exporter) | No |
| Replay protection | Nonce + ReplayCache | PKCE + state parameter |
| Token lifetime | Session-bound | Time-bounded (expires) |
| Delegation | UCAN chains | OAuth scopes (no chain) |
| Complexity | 3 messages | 2-3 round trips + token endpoint |

**Key difference**: AAFP provides mutual authentication with
cryptographic proof on both sides. OAuth is one-directional — the client
proves its identity to the server, but the server's identity is only
verified by TLS. AAFP's mutual auth is important for agent-to-agent
communication where both parties are autonomous and need to verify each
other.

### 4.2 AAFP vs. IATP (AgentMesh)

| Property | AAFP | IATP |
|----------|------|------|
| Mechanism | Handshake (3 messages) | Challenge-response (2 messages) |
| Crypto | ML-DSA-65 (PQ) | Ed25519 (classical) |
| Challenge | Nonce (32 bytes) | Nonce (256-bit) + freshness_nonce (RFC 9334) |
| Trust validation | AgentRecord signature | Registry membership + trust score |
| Sponsor | No | Yes (human sponsor_email) |
| Expiry | expires_at in handshake | expires_in_seconds (default 30) |

**Key difference**: IATP incorporates operational trust (registry
membership, trust score threshold, capability attestation) into the
authentication flow. AAFP's authentication is purely cryptographic —
trust is a separate concern handled by UCAN. AgentMesh's approach is
more enterprise-friendly; AAFP's is more decentralized.

### 4.3 AAFP vs. MLS Welcome (SLIM)

| Property | AAFP | MLS Welcome |
|----------|------|-------------|
| Participants | 2 (pairwise) | 2+ (group) |
| Crypto | ML-DSA-65 + X25519MLKEM768 | MLS cipher suites (classical) |
| Group support | No | Yes |
| Forward secrecy | Yes (TLS PQ KEX) | Yes (MLS ratchet) |
| Post-compromise security | No | Yes (MLS ratchet) |

**Key difference**: MLS provides post-compromise security (PCS) via the
Double Ratchet — if a key is compromised, future messages are still
secure because the ratchet evolves. AAFP does not have PCS; if a session
key is compromised, all messages in that session are compromised. This
is a gap for long-lived agent sessions (see Phase 10).

## 5. Attack Resistance

| Attack | AAFP | MCP/OAuth | A2A | SLIM | AgentMesh |
|--------|------|-----------|-----|------|-----------|
| Replay | **Blocked** (nonce + ReplayCache) | Partial (PKCE) | Partial (TLS) | Blocked (MLS) | Blocked (single-use keys) |
| Relay | **Blocked** (TLS channel binding) | No | No | Blocked (MLS) | No |
| Man-in-the-middle | **Blocked** (mutual PQ sigs) | Partial (TLS) | Partial (TLS + JWS) | Blocked (MLS) | Blocked (Ed25519) |
| Harvest-now-decrypt-later | **Blocked** (PQ by default) | No | No | No | No |
| DoS (signature flooding) | **Mitigated** (DoS MAC) | No | No | No | No |
| Session fixation | **Blocked** (server-bound session ID) | No | No | Blocked (MLS) | No |
| Key compromise | Session exposed | Token expires | Token expires | PCS via ratchet | PCS via ratchet |

### 5.1 AAFP's Unique Strengths

1. **Harvest-now-decrypt-later resistance**: Only protocol with PQ by
   default. All others will be vulnerable when quantum computers arrive.

2. **DoS MAC**: Only protocol with an explicit DoS mitigation in the
   handshake. ML-DSA-65 signatures are ~3309 bytes and computationally
   expensive. The DoS MAC allows servers to reject forged ClientHellos
   without verifying the signature.

3. **TLS channel binding**: Only protocol that explicitly binds the
   application-layer handshake to the TLS channel via the TLS exporter
   value. This prevents relay attacks where an attacker forwards
   handshake messages over a different channel.

### 5.2 AAFP's Gaps

1. **No post-compromise security**: If a session key is compromised,
   all messages in that session are exposed. SLIM (MLS) and AgentMesh
   (Double Ratchet) both provide PCS. AAFP could add a ratchet mechanism
   (see Phase 10 recommendation).

2. **No group authentication**: AAFP is pairwise only. MLS (SLIM)
   supports group authentication where all members share group state.
   For multi-agent collaboration, this is a limitation.

3. **No token revocation**: UCAN chains can be invalidated, but there is
   no real-time revocation mechanism (no revocation list, no OCSP-like
   service). OAuth tokens expire; UCAN tokens must be checked against a
   revocation list (not yet implemented).

4. **No identity federation**: AAFP has no mechanism to bridge between
   AgentId and external identity systems (OAuth, DIDs, SPIFFE). For
   enterprise integration, this is a gap (see Phase 8).

## 6. Authentication Flow Recommendations

### 6.1 Short-Term (No Spec Changes)

- Document the DoS MAC as recommended for all production deployments
- Add ReplayCache eviction guidance (when to call `evict_expired()`)
- Document TLS channel binding security property for implementers

### 6.2 Medium-Term (Spec Extension)

- Add a ratchet mechanism for post-compromise security (optional
  extension, negotiated during handshake)
- Add a revocation service spec (AgentRecord revocation lists via DHT)
- Add identity federation extensions (OAuth-to-AgentId mapping,
  DID-to-AgentId mapping)

### 6.3 Long-Term (Future RFCs)

- Group authentication (MLS-like group state for multi-agent sessions)
- Adaptive authentication (step-up auth based on operation sensitivity)
- Delegated authentication (an agent authenticates on behalf of another
  via UCAN, with the handshake carrying the UCAN chain)

## 7. Transition to Phase 6

Phase 6 (Identity Architecture) will examine how agent identity is
constructed, verified, and managed across protocols — focusing on the
tension between AAFP's self-sovereign PQ identity and the ecosystem's
registry/DID/OAuth identity models.
