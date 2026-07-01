# Phase 12: Threat Model V2

```
Phase:          12 of 16
Title:          Threat Model V2
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
Context:        Updated for ecosystem landscape and proposed extensions
```

## 1. Objective

Update AAFP's threat model to account for the ecosystem context, new
attack surfaces (interop bridges, enterprise deployments, proposed
extensions), and the security properties of competing protocols.

## 2. Threat Model Scope

### 2.1 Assets

| Asset | Location | Sensitivity |
|-------|----------|-------------|
| Agent private key (ML-DSA-65) | Agent's local storage | Critical |
| Session keys | Session memory | High |
| AgentRecord | DHT, local cache | Medium (public, signed) |
| UCAN tokens | Agent's token store | High (delegation chains) |
| Message payloads | QUIC streams | High (application data) |
| ReplayCache | Session memory | Medium (availability) |
| Transport metadata | QUIC headers | Low (not content) |

### 2.2 Actors

| Actor | Trust Level | Capabilities |
|-------|-------------|-------------|
| Legitimate agent | Trusted | Full protocol participation |
| Malicious agent | Untrusted | Can participate in protocol, attempt attacks |
| Network attacker | Untrusted | Can read/modify/drop/replay network traffic |
| Quantum adversary | Future threat | Can break classical crypto after quantum computer |
| Enterprise admin | Semi-trusted | Can deploy/configure agents, access infrastructure |
| Interop bridge | Semi-trusted | Translates between AAFP and other protocols |
| DHT participant | Untrusted | Can store/serve AgentRecords |

## 3. Threat Catalog

### 3.1 Network-Level Threats

| Threat | AAFP Defense | Residual Risk | Ecosystem Comparison |
|--------|-------------|---------------|---------------------|
| **Eavesdropping** | QUIC TLS 1.3 + AEAD | None (PQ KEX) | Better than all (PQ) |
| **Packet injection** | AEAD authentication | None | Equal to TLS-based |
| **Packet replay** | Nonce + ReplayCache | None | Better than MCP/A2A (no replay protection) |
| **Packet reordering** | QUIC stream ordering | None | Better than HTTP (no ordering) |
| **Traffic analysis** | Partial (QUIC padding) | Medium | Equal to TLS (same metadata) |
| **DoS (SYN flood)** | QUIC handshake + DoS MAC | Low | Better than TCP (DoS MAC) |
| **DoS (signature flood)** | DoS MAC before sig verify | Low | Unique (no one else has this) |
| **Harvest-now-decrypt-later** | PQ by default | None | **Unique** (only PQ protocol) |

### 3.2 Identity Threats

| Threat | AAFP Defense | Residual Risk | Recommendation |
|--------|-------------|---------------|----------------|
| **Identity spoofing** | `agent_id == SHA-256(pubkey)` | None | — |
| **AgentRecord forgery** | ML-DSA-65 signature | None (PQ) | — |
| **Key compromise** | AgentId changes | **High** (no continuity) | Add key rotation proof (Phase 6) |
| **Sybil attack** | None | **High** (cheap to create IDs) | Add reputation/stake mechanism |
| **AgentRecord replay** | record_version + expiry | Low | Add revocation list (Phase 6) |
| **DHT poisoning** | Signature verification | Low (records are signed) | Add DHT reputation |
| **Stale AgentRecord** | expires_at field | Low | Check expiry on every use |

### 3.3 Session Threats

| Threat | AAFP Defense | Residual Risk | Recommendation |
|--------|-------------|---------------|----------------|
| **Session hijacking** | TLS channel binding | None | — |
| **Session fixation** | Server-bound session ID (A-4) | None | — |
| **Cross-connection replay** | ReplayCache | None | — |
| **Session key compromise** | None (no ratchet) | **High** (all messages exposed) | Add ratchet (Phase 10) |
| **Long-lived session exposure** | None | **Medium** | Add session expiry + rotation |
| **Man-in-the-middle** | Mutual PQ signatures | None | — |

### 3.4 Authorization Threats

| Threat | AAFP Defense | Residual Risk | Recommendation |
|--------|-------------|---------------|----------------|
| **Privilege escalation** | UCAN capability narrowing | None | — |
| **Forged delegation** | UCAN signatures | None (PQ) | — |
| **Stale UCAN token** | expires_at field | Low | Add revocation list |
| **UCAN chain too long** | None | **Low-Medium** (DoS via long chain) | Add max chain depth |
| **Capability confusion** | String-based capabilities | **Low** (convention, not enforced) | Formalize hierarchy (Phase 7) |

### 3.5 Interop Threats (New)

These threats arise from the proposed interop extensions (Phase 4):

| Threat | Source | AAFP Defense | Recommendation |
|--------|--------|-------------|----------------|
| **OAuth token theft** | MCP/A2A bridge | None (OAuth is bearer) | Use DPoP or mTLS-bound tokens |
| **Identity mapping attack** | AgentId <-> OAuth mapping | None | Sign the mapping with both keys |
| **Protocol downgrade** | A2A-over-AAFP binding | None | Require explicit binding version |
| **Bridge MITM** | Interop bridge service | None | Bridge must be PQ-authenticated |
| **JSON injection** | MCP JSON -> AAFP CBOR | None | Validate all converted data |
| **Semantic mismatch** | A2A task state -> AAFP session | None | Document all state mappings |

### 3.6 Enterprise Threats (New)

| Threat | Source | AAFP Defense | Recommendation |
|--------|--------|-------------|----------------|
| **Insider threat** | Enterprise admin | None | Audit logging + access controls |
| **Policy bypass** | Agent ignores policy | None (no policy engine) | OPA/Cedar adapter (Phase 8) |
| **Compliance violation** | Regulated data handling | None | FIPS mode + audit trail |
| **Firewall traversal** | QUIC over UDP | None | TCP fallback (Phase 8) |
| **Key escrow** | Enterprise wants key access | None (no escrow) | Document as non-goal or add escrow extension |

### 3.7 Quantum Threats

| Threat | Timeline | AAFP Defense | Ecosystem Status |
|--------|----------|-------------|-----------------|
| **Harvest-now-decrypt-later** | Now | **PQ KEX (X25519MLKEM768)** | None have this |
| **Signature forgery (quantum)** | 5-15 years | **PQ sigs (ML-DSA-65)** | None have this |
| **Quantum computer arrives** | 10-20 years | **Fully PQ** | All others vulnerable |
| **Quantum-resistant hash** | N/A | SHA-256 (quantum-resistant) | All use SHA-256 |

## 4. Attack Trees

### 4.1 Compromise Agent Session

```
Goal: Read agent A's session traffic
│
├── Break QUIC encryption
│   ├── Break X25519MLKEM768 (need quantum computer) [INFEASIBLE]
│   └── Break TLS 1.3 (classical) [INFEASIBLE with PQ KEX]
│
├── Steal session keys
│   ├── Compromise agent's memory [OUT OF SCOPE]
│   ├── Side-channel attack on crypto [MITIGATED by aws-lc-rs]
│   └── No ratchet -> all messages exposed [GAP: add ratchet]
│
├── Replay attack
│   ├── Replay handshake messages [BLOCKED by nonce + ReplayCache]
│   ├── Replay application messages [BLOCKED by AEAD nonce]
│   └── Cross-connection replay [BLOCKED by ReplayCache]
│
├── Man-in-the-middle
│   ├── Forge ClientHello signature [INFEASIBLE (ML-DSA-65)]
│   ├── Forge ServerHello signature [INFEASIBLE (ML-DSA-65)]
│   └── Relay attack [BLOCKED by TLS channel binding]
│
└── Downgrade attack
    ├── Force classical KEX [BLOCKED (no classical mode)]
    └── Force old protocol version [BLOCKED by version negotiation]
```

### 4.2 Forge Agent Identity

```
Goal: Impersonate agent A
│
├── Forge AgentRecord
│   ├── Forge ML-DSA-65 signature [INFEASIBLE (PQ)]
│   └── Reuse old AgentRecord [BLOCKED by expiry]
│
├── Forge AgentId
│   ├── Find collision for SHA-256 [INFEASIBLE]
│   └── Use different key with same hash [INFEASIBLE]
│
├── Steal agent's private key
│   ├── Compromise agent's storage [OUT OF SCOPE]
│   ├── Side-channel on ML-DSA-65 [MITIGATED by hedged signing]
│   └── Quantum computer [INFEASIBLE (PQ)]
│
└── Key rotation attack
    ├── Claim new key is same agent [GAP: no rotation proof]
    └── Expire old key, create new identity [POSSIBLE but no continuity]
```

### 4.3 Bypass Authorization

```
Goal: Perform unauthorized action
│
├── Forge UCAN token
│   ├── Forge ML-DSA-65 signature [INFEASIBLE (PQ)]
│   └── Tamper with capabilities [BLOCKED by signature]
│
├── Escalate privileges
│   ├── Add capabilities not in parent [BLOCKED by narrowing check]
│   └── Use expired token [BLOCKED by expiry check]
│
├── Chain manipulation
│   ├── Create circular chain [NOT CHECKED - GAP]
    ├── Create very long chain (DoS) [NOT CHECKED - GAP]
    └── Skip links in chain [BLOCKED by prf verification]
│
└── Token theft
    ├── Steal UCAN token (bearer) [POSSIBLE - GAP]
    └── Replay UCAN token [POSSIBLE if no nonce - GAP]
```

## 5. New Threats from Proposed Extensions

### 5.1 TCP Fallback Threats

| Threat | Risk | Mitigation |
|--------|------|------------|
| TCP interception | Higher than QUIC (TCP is more easily intercepted) | TLS 1.3 with PQ KEX still protects |
| No DoS MAC over TCP | DoS MAC is in ClientHello (works regardless of transport) | No change needed |
| No stream multiplexing | Multiple TCP connections needed | Frame-level multiplexing (Phase 9) |
| TCP state exhaustion | SYN flood attacks | Standard TCP protection (SYN cookies) |

### 5.2 Session Resumption Threats

| Threat | Risk | Mitigation |
|--------|------|------------|
| Session ticket theft | High (bearer token) | Bind ticket to agent's key (DPoP-like) |
| Session ticket replay | Medium | Include nonce in ticket; single-use |
| Stale session resumption | Low | Ticket expiry; verify AgentRecord still valid |
| Session state desync | Medium | Version the session state; reject if mismatch |

### 5.3 Ratchet Threats

| Threat | Risk | Mitigation |
|--------|------|------------|
| Ratchet state loss | Medium (lose ability to decrypt) | Persist ratchet state |
| Ratchet key compromise | Low (keys are ephemeral) | Delete old keys immediately |
| Ratchet manipulation | Low (keys derived from HKDF) | HKDF is one-way |

### 5.4 Interop Bridge Threats

| Threat | Risk | Mitigation |
|--------|------|------------|
| Bridge as MITM | High (bridge sees all traffic) | End-to-end encryption through bridge |
| Identity mapping forgery | Medium | Sign mapping with both keys |
| Protocol semantic loss | Medium | Document all mappings; reject unknown |
| Bridge compromise | High (single point of failure) | Distribute bridge; PQ-authenticate |

## 6. Threat Prioritization

| Priority | Threat | Gap | Action |
|----------|--------|-----|--------|
| **Critical** | Session key compromise (no PCS) | No ratchet | Add ratchet extension |
| **Critical** | Key rotation continuity | No rotation proof | Add KeyRotationProof |
| **High** | Sybil attack (cheap identities) | No reputation/stake | Add reputation extension |
| **High** | UCAN token theft (bearer) | No binding to key | Add key binding (DPoP-like) |
| **High** | UCAN chain DoS (long chains) | No max depth | Add max_chain_depth |
| **High** | Interop bridge MITM | No E2E through bridge | E2E encryption requirement |
| **Medium** | Revocation gap | No revocation list | Add RevocationList |
| **Medium** | Circular UCAN chains | No cycle detection | Add cycle check |
| **Medium** | Traffic analysis | Partial (QUIC padding) | Add padding extension |
| **Low** | Enterprise key escrow | Non-goal | Document as non-goal |

## 7. Updated Security Properties

After implementing recommended extensions, AAFP's security properties:

| Property | Current | After Extensions |
|----------|---------|-----------------|
| Post-quantum | Yes | Yes |
| Mutual authentication | Yes | Yes |
| Channel binding | Yes | Yes |
| Replay protection | Yes (cross-connection) | Yes (cross-connection + UCAN) |
| Forward secrecy | Yes (TLS) | Yes (TLS + ratchet) |
| Post-compromise security | **No** | **Yes (ratchet)** |
| Key rotation continuity | **No** | **Yes (rotation proof)** |
| Revocation | **No** | **Yes (revocation list)** |
| Sybil resistance | **No** | **Partial (reputation)** |
| UCAN key binding | **No** | **Yes (DPoP-like)** |
| DoS protection | Yes (DoS MAC) | Yes |
| Group encryption | **No** | **No (deferred)** |

## 8. Transition to Phase 13

Phase 13 (Performance Considerations) will analyze the performance
impact of AAFP's PQ crypto, CBOR framing, and proposed extensions,
comparing against the HTTP/JSON ecosystem.
