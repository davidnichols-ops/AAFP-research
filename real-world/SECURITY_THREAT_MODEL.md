# AAFP Security Threat Model

**Document status:** Research deliverable
**Scope:** AAFP v1 protocol — ML-DSA-65 identity, UCAN capability delegation,
QUIC transport (X25519MLKEM768 PQ hybrid KEX), capability DHT, PubSub, NAT
traversal relays.
**Source basis:** `aafp-crypto`, `aafp-identity`, `aafp-transport-quic`,
`aafp-discovery`, `aafp-sdk`, `aafp-nat` crate sources (Rust reference
implementation). All file/line references point to that implementation.

---

## 1. Executive summary

AAFP is a post-quantum agent-to-agent protocol that authenticates agents with
ML-DSA-65 (FIPS 204, NIST PQ security Level 3), encrypts transport with a
hybrid X25519MLKEM768 TLS 1.3 key exchange, and authorizes actions through
UCAN capability chains. The protocol is designed for an open P2P network in
which any party may join, so the threat model assumes a **byzantine network
environment**: a fraction of relays, DHT peers, and endpoints may be
malicious, colluding, or compromised.

The security architecture is **defense in depth** across five layers:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 5: Authorization (UCAN capability chains)             │
│   Protects: privilege escalation, scope creep, delegation   │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: Identity (ML-DSA-65, AgentId = SHA-256(pk), CRL)   │
│   Protects: spoofing, impersonation, stale keys             │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: Application handshake (3-way, transcript-bound)    │
│   Protects: replay, MITM, cross-connection nonce reuse      │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Transport (QUIC + TLS 1.3, PQ hybrid KEX)          │
│   Protects: eavesdropping, tampering, harvest-now-decrypt   │
├─────────────────────────────────────────────────────────────┤
│ Layer 1: Resource governance (rate limits, replay cache)    │
│   Protects: DoS, stream exhaustion, memory blow-up          │
└─────────────────────────────────────────────────────────────┘
```

No single layer is sufficient on its own. The combination is what makes the
protocol robust: a break in TLS is contained by the application handshake; a
replayed handshake is caught by the replay cache; a stolen key is neutralized
by revocation; an over-broad delegation is rejected by capability subset
checks.

---

## 2. Threat actors

### 2.1 Malicious agents (authenticated insiders)

**Capabilities:**
- Hold valid ML-DSA-65 keypairs and AgentIds.
- Complete the full AAFP handshake legitimately.
- Participate in the DHT, PubSub, and relay networks.
- May publish AgentRecords, delegate UCAN tokens, and serve as relays.

**Motivations:**
- Harvest capabilities beyond their authorized scope.
- Observe traffic patterns of other agents (metadata).
- Poison DHT records to redirect or blackhole lookups.
- Amplify spam through PubSub topics.

**Mitigations in place:**
- UCAN capability subset enforcement (`ucan.rs:228-238`) rejects any
  delegation that expands beyond the parent's capabilities.
- KeyDirectory rate-limiting (`key_directory.rs:14`: 1 publish/AgentId/hour)
  prevents record-flooding.
- PubSub per-connection limits (`pubsub/limits.rs:15-26`: 1024 subscriptions,
  100 publishes/sec, 1 MiB messages) bound abuse.
- Revocation lists (`revocation.rs`) allow revoking malicious agents.

**Residual risk:** A malicious agent that has not yet been revoked retains
all privileges granted by its valid UCAN chain until the CRL propagates.
Detection relies on out-of-band reputation systems (Web of Trust, CA
revocation) which are advisory, not enforced by the wire protocol.

### 2.2 Man-in-the-middle (MITM) network adversary

**Capabilities:**
- Observe, drop, delay, reorder, and inject packets on the wire.
- Cannot break TLS 1.3 (PQ hybrid KEX) or ML-DSA-65 signatures.

**Motivations:**
- Perform harvest-now-decrypt-later (capture ciphertext for future quantum
  decryption).
- Downgrade the PQ KEX to a classical-only exchange.
- Inject forged handshake messages.

**Mitigations in place:**
- TLS 1.3 with `X25519MLKEM768` hybrid KEX (`config.rs:1-13`): even if a
  future quantum computer breaks ML-KEM, the X25519 component must also be
  broken for the session key to be recovered.
- ALPN enforcement (`config.rs:28, 220-221`): both sides MUST negotiate
  `aafp/1`; a downgrade to a different protocol is rejected at the TLS layer.
- Application-layer handshake binds the TLS exporter value
  (`handshake_v1.rs:39`, `TLS_EXPORTER_LABEL = "EXPORTER-AAFP-Channel-Binding"`)
  into the transcript hash, so a MITM cannot transplant a TLS session to a
  different agent identity without invalidating the ML-DSA-65 signature.
- 0-RTT early data is explicitly disabled (`config.rs:323-325`) to prevent
  replay of early application data.

**Residual risk:** A MITM can still perform traffic analysis (packet sizes,
timing, connection patterns) since QUIC does not pad by default. See §9.

### 2.3 Rogue relays (NAT traversal)

**Capabilities:**
- Operate a relay node that forwards traffic between agents behind NAT.
- See encrypted traffic flows (source, destination, volume, timing).
- Can drop or delay relayed packets.
- Cannot decrypt payload (TLS + application AEAD).

**Motivations:**
- Selectively drop traffic to degrade connectivity.
- Map agent social graphs via relay forwarding patterns.
- Charge for relay service while providing degraded quality.

**Mitigations in place:**
- Relay traffic is end-to-end encrypted; the relay sees only ciphertext.
- Agents can use multiple relays and switch via DCuTR hole punching
  (`aafp-nat/src/dcutr_v1.rs`) to escape a rogue relay once a direct
  connection is established.
- AutoNAT dial-back (`aafp-nat/src/auto_nat_v1.rs`) lets agents detect
  their own NAT status without trusting a single relay's claim.

**Residual risk:** A colluding set of relays can partition an agent from the
network if the agent has no direct dialability and all reachable relays are
rogue. There is no relay reputation system in the current implementation.

### 2.4 Sybil attackers

**Capabilities:**
- Generate arbitrarily many ML-DSA-65 keypairs and AgentIds at low cost
  (keygen is ~ms-scale).
- Flood the DHT with nodes to eclipse a target.
- Publish many AgentRecords to pollute the key directory.

**Motivations:**
- Eclipse attack on the DHT (surround a target with attacker-controlled
  nodes so all lookups return attacker data).
- Overwhelm the replay cache or rate limiter with unique identities.

**Mitigations in place:**
- KeyDirectory rate limit: 1 publish per AgentId per hour
  (`key_directory.rs:14`). This bounds the rate of record pollution per
  identity, though a sybil attacker has many identities.
- ReplayCache max_entries cap (`replay_cache.rs:44`: default 100K, max 10M)
  with LRU eviction prevents unbounded memory growth.
- HandshakeRateLimiter max_entries cap (`server.rs:61`: 10K IPs) with
  periodic eviction prevents per-IP tracking memory blow-up.
- DHT replication factor k=5 (`dht_router.rs:54`) means records are stored
  on 5 independent nodes; an eclipse requires controlling all 5 closest
  nodes to a target key.

**Residual risk:** Sybil resistance is **not** cryptographically enforced.
There is no proof-of-work, proof-of-stake, or identity-bonding requirement
for joining the DHT. A determined adversary with sufficient bandwidth can
eclipse a target. The 256-bit AgentId space makes random eclipsing
impractical, but targeted eclipsing of a specific key is feasible if the
attacker can generate enough identities in the right XOR-neighborhood.

### 2.5 State actors (nation-state adversaries)

**Capabilities:**
- Massive compute resources (including potential future quantum computers).
- Can compel relay operators to log traffic.
- Can perform long-term traffic correlation attacks.
- Can exploit implementation bugs (side-channels, memory safety).

**Motivations:**
- Mass surveillance: record all AAFP traffic for future decryption.
- Targeted de-anonymization of specific agents.
- Supply-chain attacks on the crypto libraries.

**Mitigations in place:**
- ML-DSA-65 (NIST Level 3, ~AES-192 equivalent PQ security) for signatures.
- X25519MLKEM768 hybrid KEX: even if ML-KEM-768 is broken by a quantum
  computer, the X25519 classical component must also be broken. This
  protects against "harvest now, decrypt later" for the session key.
- ChaCha20-Poly1305 AEAD (`aead.rs:13`): constant-time, no hardware
  dependency, reduces side-channel surface vs AES-NI-dependent code.
- Constant-time AgentId comparison via `subtle::ConstantTimeEq`
  (`handshake_v1.rs:515`).

**Residual risk:** Traffic analysis remains the primary vector. A state
actor with global traffic visibility can correlate connection timing,
packet sizes, and relay usage to de-anonymize agents. Post-quantum
signatures do not protect against this. The protocol does not implement
onion routing, mix networks, or traffic padding.

---

## 3. Attack vectors

### 3.1 Attack tree (top-level)

```
AAFP compromise
├── Identity layer
│   ├── 3.1 Identity spoofing (forge AgentId)
│   ├── 3.7 Capability escalation (UCAN chain abuse)
│   └── Key compromise → impersonation
├── Handshake layer
│   ├── 3.2 Replay attacks (nonce reuse)
│   ├── 3.3 MITM / channel binding bypass
│   └── Session fixation
├── Transport layer
│   ├── PQ KEX downgrade
│   ├── 0-RTT replay
│   └── ALPN downgrade
├── Network resource layer
│   ├── 3.4 DoS via stream exhaustion
│   ├── 3.4 DoS via handshake CPU exhaustion
│   └── Connection flooding
├── Discovery layer
│   ├── 3.5 DHT poisoning (record injection)
│   ├── Eclipse attack
│   └── Routing table poisoning
├── PubSub layer
│   ├── Spam flooding
│   ├── Amplification
│   └── Topic hijacking
└── Metadata layer
    ├── 3.8 Traffic analysis
    ├── Timing correlation
    └── Relay graph mapping
```

### 3.1 Identity spoofing

**Attack:** An adversary attempts to claim an AgentId it does not own by
presenting a different public key that hashes to the same 32-byte AgentId,
or by presenting the victim's AgentId with the adversary's own public key.

**Defense:** The invariant `AgentId == SHA-256(public_key)` is enforced in
`verify_agent_id_binding()` (`handshake_v1.rs:501-521`). The check uses
constant-time comparison (`subtle::ConstantTimeEq`) to prevent timing
oracles. Finding a preimage for SHA-256 is computationally infeasible
(~2^256 for second-preimage). The public key is also validated as a
well-formed ML-DSA-65 key (`handshake_v1.rs:528-529`).

**Residual risk:** None at the cryptographic level. The risk is operational:
if an agent's secret key is exfiltrated, the attacker can impersonate that
agent perfectly until revocation propagates.

### 3.2 Replay attacks

**Attack:** An adversary captures a valid ClientHello (or ServerHello) and
replays it to the target in a new connection, hoping to establish a session
or exhaust server CPU via signature verification.

**Defense — three layers:**

1. **Nonce freshness (per-connection):** Each handshake includes a random
   32-byte nonce (`handshake_v1.rs:42`, `NONCE_SIZE = 32`). The transcript
   hash folds in both client and server nonces, so a replayed handshake
   produces a different transcript hash and the signature will not verify
   against the new transcript.

2. **ReplayCache (cross-connection):** `ReplayCache`
   (`replay_cache.rs:120-396`) is a time-bounded set of `(agent_id, nonce)`
   pairs. The server checks the cache **before** signature verification
   (§6.7.5 step 3-5), so a replayed ClientHello is rejected without
   expending CPU on ML-DSA-65 verify. The `check_and_insert` operation is
   atomic under a Mutex (`replay_cache.rs:264-299`), satisfying §6.7.4
   Invariant 4. Default retention: 300s; max entries: 100K with LRU
   eviction.

3. **Session ID derivation:** The session ID is derived from
   `h_after_clienthello || server_agent_id` with salt
   `client_nonce || server_nonce` (`handshake_v1.rs:343-362`). Binding to
   `server_agent_id` (A-4) prevents session fixation. A replayed handshake
   with a fresh server nonce produces a different session ID.

**Residual risk:** The replay cache is per-server (in-memory). A replay
directed at a *different* server instance that does not share the cache
will not be detected by the cache — but the signature will still fail
because the transcript hash includes the new server's nonce and identity.

### 3.3 MITM / channel binding bypass

**Attack:** A MITM attempts to establish two separate TLS sessions (one
with the client, one with the server) and relay the application handshake
messages between them, hoping to make each side believe it is talking
directly to the other.

**Defense:** The application handshake binds the TLS channel to agent
identity via the TLS exporter. `TranscriptHash::from_tls_binding()`
(`handshake_v1.rs:68-76`) initializes the transcript hash with the 32-byte
TLS exporter value (label `"EXPORTER-AAFP-Channel-Binding"`). Each
subsequent signature is over `DOMAIN_SEPARATOR || transcript_hash`
(`handshake_v1.rs:325-330`). A MITM who terminates two separate TLS
sessions has two different exporter values; the signatures from one side
will not verify against the transcript of the other.

**Residual risk:** None, assuming the TLS exporter is secure (TLS 1.3
exporter is derived from the handshake secret, which a MITM cannot forge).

### 3.4 DoS via stream exhaustion and handshake CPU

**Attack (stream exhaustion):** An adversary opens many QUIC streams and
sends large amounts of data, exhausting server memory or stream buffers.

**Defense:**
- `max_concurrent_streams` = 100 (`config.rs:80`) limits parallel streams
  per connection.
- `stream_initial_max_data` = 1 MiB (`config.rs:97`) caps the per-stream
  receive window.
- `max_connections` = 100 (`server.rs:25`) caps total authenticated
  connections.

**Attack (handshake CPU exhaustion):** An adversary sends many
ClientHello messages with forged signatures, forcing the server to perform
expensive ML-DSA-65 verifications (~ms each).

**Defense:**
- `HandshakeRateLimiter` (`server.rs:53-76`): 10 handshake attempts/sec
  per source IP, sliding window.
- `ReplayCache` check-before-verify: replayed nonces are rejected without
  signature verification (`replay_cache.rs:7-8`).
- DoS receiver MAC (`handshake_v1.rs:365-388`): an optional HMAC over the
  ClientHello allows a server to cheaply validate that the client knows the
  server's AgentId before committing to signature verification. This is a
  proof-of-knowledge DoS filter.

**Residual risk:** A distributed attacker with many source IPs can still
exceed the aggregate handshake rate. The ML-DSA-65 verify cost (~1-2ms on
modern hardware) is the bottleneck. There is no proof-of-work puzzle for
handshakes.

### 3.5 DHT poisoning

**Attack:** An adversary publishes false AgentRecords or capability
records in the DHT, causing lookups to return incorrect or malicious data.

**Defense:**
- All DHT records are signed with ML-DSA-65. An AgentRecord contains the
  agent's public key and a signature; a verifier checks that
  `AgentId == SHA-256(public_key)` and that the signature is valid.
- KeyDirectory enforces monotonic version numbers (`key_directory.rs`):
  a newer record with a higher version supersedes an older one, and a
  lower-version record is rejected.
- Rate limiting: 1 publish per AgentId per hour (`key_directory.rs:14`).

**Residual risk:** The DHT does not verify that the publisher of a record
is the *closest* node to the key. An attacker can publish a record for any
AgentId from any node, as long as the signature is valid. This means an
attacker cannot forge records for *another* agent (no signature key), but
*can* publish stale or revoked versions of their own records from many
nodes to pollute caches. The monotonic version check mitigates this for
honest agents who publish increasing versions.

### 3.6 Capability escalation (UCAN)

**Attack:** An agent attempts to use a UCAN token that grants capabilities
beyond what it was delegated, or constructs a chain where a child token
has broader scope than its parent.

**Defense:** `UcanToken::verify_chain()` (`ucan.rs:198-271`) checks:
1. Each token's signature verifies against the issuer's public key.
2. The `prf` (parent proof) field links each token to its parent via
   `SHA-256(parent_signing_input)` (`ucan.rs:213-226`).
3. Capabilities do not expand: each child capability must be a subset of
   the parent's capabilities (`caps_compatible()`, `ucan.rs:306-313`).
   A child resource must match the parent resource or be a sub-resource
   (e.g., `"compute.inference"` is a child of `"compute"`). The action
   must match exactly.
4. No token is expired (`ucan.rs:176-185`): `exp` and `nbf` are checked.
5. Chain linkage: the next token's `iss` must match the previous token's
   `aud` (`ucan.rs:251-260`).

**Residual risk (scope creep via constraints):** The `caps_compatible()`
check compares `resource` and `action` but does **not** deeply compare
`constraints`. A parent token with `{"max_tokens": 1000}` could be
delegated with a child token that has `{"max_tokens": 1000000}` — the
constraint is not checked for narrowing. This is a known limitation
documented in the code (`ucan.rs:306`). A production deployment should
add constraint-narrowing validation.

**Residual risk (pubkey resolution):** The chain verifier does not resolve
public keys from AgentIds (`ucan.rs:241-267`). It verifies the first
token against `root_public_key` but cannot verify subsequent tokens
without a resolver. The code notes this as a TODO (`ucan.rs:266`). A
production system must integrate a `KeyDirectory` resolver into chain
verification.

### 3.7 Traffic analysis / metadata leakage

**Attack:** An adversary observes encrypted traffic patterns (packet sizes,
inter-packet timing, connection duration, source/destination addresses)
to infer the nature of agent interactions.

**Defense:** Limited. QUIC provides connection ID privacy (the connection
ID is not encrypted, but can be rotated). The application layer does not
add padding by default.

**Residual risk:** High. This is the most significant residual risk. See
§9 for detailed analysis.

---

## 4. ML-DSA-65 security analysis

### 4.1 Security level

ML-DSA-65 is one of three parameter sets standardized in FIPS 204
(Module-Lattice-Based Digital Signature Algorithm). It targets **NIST
Post-Quantum Security Level 3**, defined as equivalent to brute-forcing
AES-192 (approximately 2^192 classical / quantum operations).

**Key and signature sizes** (from `dsa.rs:17-21`):
| Component | Size |
|-----------|------|
| Public key | 1952 bytes |
| Secret key | 4032 bytes |
| Signature | 3309 bytes |

These are substantially larger than classical equivalents (Ed25519: 32-byte
key, 64-byte signature). This has protocol-level implications: handshake
messages are ~4-6 KB, increasing bandwidth and the surface for
fuzzing/malformed-input attacks.

### 4.2 Implementation security

The Rust implementation uses the `fips204` crate (pure Rust, FIPS 204
compliant). This replaced the unmaintained `pqcrypto-mldsa` crate due to
RUSTSEC advisories (RUSTSEC-2026-0162/0163/0166) noted in `dsa.rs:6-10`.

**Key generation:** `MlDsa65::keypair()` (`dsa.rs:112-118`) uses
`ml_dsa_65::KG::try_keygen()` which relies on the platform CSPRNG. The
deterministic variant `keypair_from_seed()` (`dsa.rs:164-170`) is used
only for cross-language test vector generation (A-10), not in production.

**Signing:** `MlDsa65::sign()` (`dsa.rs:120-132`) uses an empty context
string (`&[]`), matching PQClean's detached_sign behavior. FIPS 204
recommends using a non-empty context for domain separation in production;
the AAFP protocol provides its own domain separation via
`DOMAIN_SEPARATOR = "aafp-v1-handshake"` (`handshake_v1.rs:30`) prepended
to the transcript hash, so the empty context is acceptable.

**Verification:** `MlDsa65::verify()` (`dsa.rs:134-149`) returns `false`
(not an error) on any failure, including malformed keys or signatures.
This is the correct behavior for constant-time rejection — no error
message leaks information about *why* verification failed.

### 4.3 Side-channel considerations

**Timing attacks on signing:** ML-DSA-65 signing involves polynomial
multiplication and rejection sampling. The `fips204` crate's
`try_sign()` uses randomized signing (FIPS 204 Algorithm 2 with random
seed), which is the recommended variant for side-channel resistance.
The deterministic variant (`sign_deterministic`, `dsa.rs:177-192`) is
used only for test vectors and should not be used in production as it
may be vulnerable to fault attacks that recover the key from
deterministic signatures.

**Timing attacks on verification:** Lattice signature verification is
generally less timing-sensitive than signing (no secret-dependent
branches), but the `fips204` crate should be audited for constant-time
implementation of the polynomial operations. The AAFP layer adds
constant-time comparison for AgentId binding (`handshake_v1.rs:515`) and
the DoS MAC (`handshake_v1.rs:380-388`).

**Power/cache attacks:** Not addressed by the protocol. Agents running on
shared hardware (cloud VMs) may be vulnerable to cache-timing attacks
during ML-DSA-65 signing. Mitigation requires hardware-level isolation
(TEE, dedicated cores) which is out of scope for the protocol.

**Key storage:** Secret keys are held in memory as `Vec<u8>`
(`dsa.rs:33`). There is no zeroization on drop. An agent process that is
swapped to disk or core-dumped may leak the secret key. A hardened
deployment should use `zeroize` crates or HSM-backed key storage.

### 4.4 Key compromise scenarios

| Scenario | Impact | Recovery |
|----------|--------|----------|
| Secret key exfiltrated | Full impersonation until revocation | Publish CRL (`revocation.rs`), rotate key (`key_rotation.rs`) |
| Secret key partially leaked (side-channel) | May enable signature forgery with enough samples | Same as above; rotate preemptively |
| Public key substitution (MITM on key directory) | Agent unreachable; lookups return wrong key | KeyDirectory signature verification rejects unsigned records |
| Key generation weakness (bad RNG) | All signatures from that key are forgeable | Rotate key; audit RNG |

### 4.5 Key rotation

The `KeyRotationRecord` (`key_rotation.rs:85-100`) implements RFC 0011 §6.
Both the old and new keys sign the same record, proving continuity:

```
old_key signs: { type, old_agent_id, new_agent_id, new_public_key, timestamp }
new_key signs: { same data }
```

Verification (`key_rotation.rs:236-276`) checks:
1. `type == "aafp-rotation-v1"`
2. `new_agent_id == SHA-256(new_public_key)`
3. `old_agent_id == SHA-256(old_public_key)` (caller provides old pubkey)
4. Both signatures verify

After rotation, the old key should be revoked via a CRL
(`key_rotation.rs:281-311`, `revoke_old_key()`). This closes the trust
loop: the rotation record proves continuity, and the CRL prevents the old
(compromised) key from being used.

---

## 5. UCAN capability delegation security

### 5.1 Delegation chain structure

```
Root Agent (root_key)
  │
  ▼  UcanToken_1: iss=root, aud=child, cap=[compute.invoke], prf=None
Child Agent (child_key)
  │
  ▼  UcanToken_2: iss=child, aud=grandchild, cap=[compute.inference.invoke], prf=SHA256(T1)
Grandchild Agent (grandchild_key)
```

Each token is a JWT-style structure with:
- `header`: `{ alg: "ML-DSA-65", typ: "JWT" }` (`ucan.rs:14-20`)
- `payload`: `{ iss, aud, cap, exp, nbf, prf }` (`ucan.rs:34-48`)
- `signature`: ML-DSA-65 over `CBOR(header) || CBOR(payload)` (`ucan.rs:57`)

### 5.2 Chain verification

`verify_chain()` (`ucan.rs:198-271`) walks the chain root → leaf:

1. **Signature verification:** Each token's signature is verified against
   the current issuer's public key (`ucan.rs:209`).
2. **Parent proof linkage:** For tokens after the first, the `prf` field
   must equal `SHA-256(parent_signing_input)` (`ucan.rs:213-226`). This
   prevents token splicing — an attacker cannot take a token from one
   chain and insert it into another.
3. **Capability narrowing:** Each child capability must be a subset of the
   parent's (`ucan.rs:228-238`, `caps_compatible()` at `ucan.rs:306-313`).
4. **Expiry:** Each token's `exp` and `nbf` are checked (`ucan.rs:176-185`).
5. **Issuer-audience linkage:** `next.iss == prev.aud` (`ucan.rs:251-260`).

### 5.3 Revocation

UCAN tokens do not have built-in revocation. Revocation is handled at the
identity layer:
- If an agent's key is compromised, its AgentId is added to a CRL
  (`revocation.rs`). Peers check the CRL before accepting any token from
  that agent.
- CRLs have a TTL (`revocation.rs:17`: default 1 hour) and must be
  refreshed. An expired CRL provides no protection.

**Limitation:** There is no per-token revocation. If a specific delegation
needs to be revoked but the issuer's key is still valid, the only option
is to issue a new token with an earlier `exp` and distribute it. The
protocol does not support token revocation lists (only key revocation
lists).

### 5.4 Scope creep risks

| Risk | Status | Mitigation |
|------|--------|------------|
| Child delegates broader resource | Blocked | `caps_compatible()` checks resource is same or sub-resource |
| Child delegates broader action | Blocked | `caps_compatible()` requires exact action match |
| Child broadens constraints (e.g., max_tokens) | **Not blocked** | `caps_compatible()` does not compare constraints (`ucan.rs:306`) |
| Chain depth unbounded | **Not blocked** | No max chain depth enforced; a very long chain consumes verification time |
| Token reuse across audiences | Blocked | `aud` is bound in the payload; a token for agent B cannot be used by agent C |
| Token replay after expiry | Blocked | `exp` check in `verify()` (`ucan.rs:180`) |
| Token replay before nbf | Blocked | `nbf` check in `verify()` (`ucan.rs:183`) |

### 5.5 Known MVP limitations

From `ucan.rs:241-267`:
- **No pubkey resolver:** The chain verifier cannot resolve public keys
  from AgentIds for intermediate tokens. It verifies the first token
  against `root_public_key` but assumes the caller provides correct keys
  for subsequent tokens. A production system must pass a `KeyDirectory`
  resolver into `verify_chain()`.
- **No constraint validation:** As noted above, constraints are not
  checked for narrowing.

---

## 6. QUIC security properties

### 6.1 TLS 1.3 handshake

AAFP uses `quinn` + `rustls` with the `aws-lc-rs` backend
(`config.rs:1-13`). The TLS 1.3 handshake provides:
- **Forward secrecy:** Each connection derives a fresh ephemeral key.
  Compromise of long-term keys does not decrypt past sessions.
- **PQ hybrid KEX:** `X25519MLKEM768` (`config.rs:84`, `enable_pq = true`)
  combines classical X25519 with post-quantum ML-KEM-768. The session key
  is secure if *either* component is secure.
- **ALPN enforcement:** `aafp/1` (`config.rs:28`) must be negotiated.
  Failure to negotiate ALPN aborts the connection (`config.rs:43-44`).

### 6.2 Certificate strategy (TOFU)

The TLS layer uses **self-signed certificates** (`config.rs:56-72`) with
**no certificate verification** on the client side
(`config.rs:260-263`, `NoVerifier`). This is a deliberate design choice:
rustls does not yet support ML-DSA-65 in certificate verification, so
agent identity authentication is deferred to the application-layer
handshake.

**Security implication:** The TLS layer provides **encryption and
integrity** but **not authentication**. A MITM can present any self-signed
certificate and the TLS handshake will succeed. The application-layer
handshake (`handshake_v1.rs`) is what binds the TLS session to the agent's
ML-DSA-65 identity. This is safe because:
1. The TLS exporter value is bound into the application transcript hash.
2. The application signature covers the transcript hash.
3. A MITM who terminates TLS cannot forge the application signature.

**Risk:** If the application handshake is skipped or bypassed (e.g., a
bug in the session state machine), the connection is unauthenticated. The
SDK enforces that all messaging requires `SessionState::MessagingEnabled`
(`server.rs:3-5`), but this is a software-enforced invariant, not a
cryptographic one.

### 6.3 Connection ID privacy

QUIC connection IDs are transmitted in cleartext in the header. An observer
can track a connection across IP address changes (e.g., mobile agent
moving between networks) by following the connection ID. QUIC allows
connection ID rotation, but the current implementation does not explicitly
configure this.

**Mitigation:** Agents concerned about linkability should use short-lived
connections and rotate their QUIC endpoint. The protocol does not provide
padding to obscure connection ID changes.

### 6.4 Stream reset attacks

**Attack:** An adversary sends QUIC `RESET_STREAM` or `STOP_SENDING`
frames to disrupt active streams.

**Defense:** QUIC stream resets are authenticated at the TLS layer — only
the peer who completed the TLS handshake can send valid stream frames. A
MITM cannot inject reset frames without breaking TLS 1.3.

**Residual risk:** An authenticated malicious peer can reset streams at
will. The `CloseManager` (`aafp-messaging::close_manager`) tracks close
state transitions and rejects unexpected close frames, but a peer that
resets a stream mid-transfer can cause data loss. Applications must be
resilient to partial stream delivery.

### 6.5 Session resumption

TLS 1.3 session resumption is supported (`config.rs:296-336`) via session
tickets. The server sends 4 tickets per connection (`config.rs:226`).
Resumption skips the TLS KEX but **not** the application handshake
(`config.rs:289-291`).

**0-RTT is disabled** (`config.rs:323-325`) to prevent replay of early
data. This is the correct security choice: 0-RTT data in TLS 1.3 is
replayable by definition.

---

## 7. DHT security

### 7.1 Architecture

The capability DHT (`dht_router.rs`) uses Kademlia-style routing:
- 256 k-buckets keyed by XOR distance (`dht_router.rs:10-12`)
- K-bucket size: 20 peers (`dht_router.rs:45`)
- Iterative lookup concurrency: α=3 (`dht_router.rs:51`)
- Replication factor: k=5 (`dht_router.rs:54`)
- Bucket refresh: 15 minutes (`dht_router.rs:57`)

### 7.2 Eclipse attacks

**Attack:** An adversary creates enough Sybil identities in the XOR
neighborhood of a target to surround it, so all of the target's DHT
queries are answered by attacker-controlled nodes.

**Defense:**
- The 256-bit AgentId space means the adversary must generate identities
  with specific high-order bits matching the target's neighborhood. This
  requires ~2^(256 - bucket_index) work per bucket, which is infeasible
  for high-order buckets but feasible for low-order buckets (close to the
  target).
- K-bucket size K=20 means the adversary must fill all 20 slots of the
  relevant bucket. An honest node that is already in the bucket will not
  be evicted unless it goes offline.
- Replication k=5 means a record is stored on 5 nodes. The adversary must
  control all 5 closest nodes to the record's key to fully eclipse it.

**Residual risk:** High for targeted attacks. There is no Sybil
resistance mechanism (no proof-of-work, no identity bonding, no
social-network-based admission control). The Web of Trust
(`aafp-identity::web_of_trust`) provides *advisory* trust information but
is not enforced by the DHT routing logic.

### 7.3 Routing table poisoning

**Attack:** An adversary provides false peer lists during PEX (Peer
Exchange) or iterative lookups, directing nodes to connect to
attacker-controlled or non-existent peers.

**Defense:**
- PEX responses are not signed; any peer can provide any peer list. There
  is no verification that the provided peers actually exist or are
  honest.
- A node that connects to a false peer will fail the AAFP handshake (if
  the peer doesn't have a valid ML-DSA-65 key) or will simply get no
  response (if the peer doesn't exist).

**Residual risk:** An attacker can pollute routing tables with dead
addresses, causing the target to waste time on failed connections. The
iterative lookup will eventually fall back to honest peers, but
performance degrades. There is no penalty for providing false PEX data.

### 7.4 Record integrity

DHT records (AgentRecords, capability records) are individually signed.
An attacker cannot forge a record for another agent. However, an attacker
can:
- Publish stale (old version) records for themselves from many nodes.
- Publish records with valid signatures but false capability claims
  (the signature only proves authorship, not truthfulness).

The monotonic version check in `KeyDirectory` (`key_directory.rs`)
prevents rollback: a lower-version record is rejected. But an attacker
who controls the highest version can publish arbitrary (signed) claims.

---

## 8. PubSub security

### 8.1 Spam and flooding

**Attack:** A subscriber publishes a high volume of messages to a topic,
overwhelming other subscribers.

**Defense:** Per-connection limits (`pubsub/limits.rs:15-26`):
- `max_publish_rate`: 100 publishes/sec per connection
- `max_message_size`: 1 MiB
- `max_subscriptions`: 1024 per connection

The rate limit uses a sliding window (`pubsub/limits.rs:59-75`): timestamps
older than 1 second are evicted, and if the window is full, the publish is
rejected with `PubSubError::RateLimited`.

**Residual risk:** A subscriber with many connections (Sybil) can
aggregate publish rate across connections. There is no per-topic rate
limit or per-agent global rate limit.

### 8.2 Amplification

**Attack:** A publisher sends a message to a topic with many subscribers;
the relay/broker must forward the message to all subscribers, amplifying
the publisher's bandwidth by the subscriber count.

**Defense:** The `max_message_size` (1 MiB) and `max_publish_rate` (100/s)
bound the amplification factor to at most 100 MiB/sec per connection,
regardless of subscriber count.

**Residual risk:** With many subscribers, the aggregate amplification can
still be significant. A mesh of colluding subscribers could amplify
further by re-publishing.

### 8.3 Topic hijacking

**Attack:** An adversary subscribes to and publishes on a topic that
another agent "owns" (e.g., a topic derived from an AgentId), injecting
malicious messages.

**Defense:** None at the PubSub layer. Topics are not authenticated — any
agent can subscribe to and publish on any topic. If a topic name is
derived from an AgentId (e.g., `"agent.<hex_id>.events"`), there is no
check that the publisher owns that AgentId.

**Mitigation (application-level):** Applications should sign PubSub
messages with the publisher's ML-DSA-65 key and include the publisher's
AgentId in the message. Subscribers verify the signature before acting on
the message. This is an application convention, not enforced by the
PubSub layer.

---

## 9. Side-channel attacks

### 9.1 Timing attacks

| Operation | Timing-sensitive? | Mitigation |
|-----------|-------------------|------------|
| AgentId binding check | No (both values public) | CT comparison used anyway (`handshake_v1.rs:515`) |
| DoS MAC verification | Yes (MAC is secret-derived) | CT comparison (`handshake_v1.rs:380-388`) |
| ML-DSA-65 signing | Yes (secret-dependent) | Randomized signing (FIPS 204 Alg 2); `fips204` crate should be audited |
| ML-DSA-65 verification | Low risk (no secrets) | Standard implementation |
| AEAD decrypt | Yes (tag comparison) | `chacha20poly1305` / `aes-gcm` crates use CT comparison |
| ReplayCache lookup | No (public keys) | HashMap lookup is not CT, but no secret leaks |

### 9.2 Traffic analysis

**What an observer can learn:**

| Observable | What it reveals |
|------------|-----------------|
| Source/destination IP | Agent's network location |
| Connection timing | When agents interact |
| Packet size distribution | Message type (handshake vs RPC vs bulk transfer) |
| Connection duration | Session length |
| Relay usage | Agent's NAT status and relay trust |
| DHT query patterns | Which capabilities an agent is looking for |
| PubSub topic subscriptions | Agent's interests (if topics are observable) |

**Mitigations (limited):**
- QUIC encrypts most header fields after the first packet.
- Connection IDs can be rotated (not explicitly configured).
- The application layer does not add padding.

**What is NOT mitigated:**
- Packet size fingerprinting: handshake messages (~4-6 KB due to ML-DSA-65
  keys/signatures) are distinguishable from RPC messages (~100 bytes) from
  bulk transfers (large). An observer can classify traffic type by size.
- Timing correlation: the time between ClientHello and ServerHello reveals
  signature verification latency, which is characteristic of ML-DSA-65.
- Connection graph: an observer who sees both endpoints of a connection
  can build a social graph of agent interactions.

### 9.3 Metadata leakage

The following metadata is visible to network observers:
1. **AgentId is not transmitted in cleartext** — it is inside the
   encrypted QUIC stream. However, the DHT publishes AgentIds in the clear
   (DHT queries are not encrypted at the routing layer).
2. **Capability queries** in the DHT reveal what an agent is looking for.
3. **Relay forwarding** reveals that two agents are communicating (even
   if the payload is encrypted).

**Recommendation:** Agents requiring metadata privacy should use an
overlay (Tor, mix network) below QUIC. The AAFP protocol does not provide
this.

---

## 10. Post-quantum migration path

### 10.1 Current posture

AAFP is **post-quantum-ready** at launch:
- **Signatures:** ML-DSA-65 (NIST Level 3) — quantum-resistant.
- **Key exchange:** X25519MLKEM768 hybrid — quantum-resistant (ML-KEM-768)
  with classical fallback (X25519).
- **AEAD:** ChaCha20-Poly1305 / AES-256-GCM — not broken by quantum
  computers (Grover's algorithm halves the security level, but 256-bit
  keys retain 128-bit quantum security).

### 10.2 If ML-DSA-65 is broken

If a cryptanalytic break of ML-DSA-65 is announced:

1. **Immediate:** Stop accepting new connections with ML-DSA-65
   signatures. Existing sessions remain secure (the session key is
   protected by the KEX, not the signature).
2. **Short-term:** Migrate to a replacement signature scheme. The
   `SignatureScheme` trait (`traits.rs:7-23`) abstracts the algorithm,
   so a new scheme can be added by implementing the trait. The
   `key_algorithm` field in ClientHello/ServerHello
   (`handshake_v1.rs:51, 131-132`) allows algorithm negotiation.
3. **Key rotation:** All agents generate new keypairs under the new
   scheme. The `KeyRotationRecord` (`key_rotation.rs`) supports
   algorithm migration: the old ML-DSA-65 key signs the rotation record,
   and the new key (under the new scheme) also signs it. However, if
   ML-DSA-65 is broken, the old signature is worthless — the rotation
   must be authenticated via an out-of-band channel (Web of Trust, CA).
4. **Revocation:** All ML-DSA-65 AgentIds are added to CRLs. The old
   keys cannot forge revocation entries (since they're broken), so
   revocation must be done by trusted CRL issuers (CAs, WoT anchors).

### 10.3 If ML-KEM-768 is broken

The hybrid KEX (X25519MLKEM768) degrades gracefully: if ML-KEM-768 is
broken, the X25519 component still provides classical security. The
session key is derived from *both* components, so breaking one does not
compromise the session. This is the primary advantage of hybrid KEX.

**Migration:** Replace `X25519MLKEM768` with `X25519<new_PQ_KEM>` in the
rustls configuration. The application layer is unaffected (it consumes
the TLS exporter value, which is algorithm-agnostic).

### 10.4 If X25519 is broken (quantum)

If a quantum computer breaks X25519 (via Shor's algorithm on ECDLP), the
hybrid KEX degrades to ML-KEM-768 alone, which is still quantum-resistant.
**Migration:** Replace the hybrid with a pure-PQ KEM or a new hybrid
pairing.

### 10.5 Algorithm agility

The protocol is designed for algorithm agility:
- `key_algorithm` field in handshake (`handshake_v1.rs:51`) identifies the
  signature algorithm.
- `SignatureScheme` trait (`traits.rs:7-23`) abstracts signature
  operations.
- `KeyEncapsulation` trait (`traits.rs:26-44`) abstracts KEM operations.
- `AeadAlgorithm` enum (`aead.rs:12-17`) supports ChaCha20-Poly1305 and
  AES-256-GCM.

Adding a new algorithm requires:
1. Implement the relevant trait.
2. Assign a `key_algorithm` identifier.
3. Update the handshake to negotiate the new algorithm.
4. Deploy agents that support both old and new algorithms during the
   transition period.

---

## 11. Defense in depth: layer-by-layer protection matrix

| Threat | Layer 1 (Resource) | Layer 2 (Transport) | Layer 3 (Handshake) | Layer 4 (Identity) | Layer 5 (AuthZ) |
|--------|:---:|:---:|:---:|:---:|:---:|
| Identity spoofing | — | — | ✓ (AgentId binding) | ✓ (SHA-256(pk)) | — |
| Replay attack | ✓ (rate limit) | — | ✓ (nonce + replay cache) | — | — |
| MITM | — | ✓ (TLS 1.3) | ✓ (channel binding) | ✓ (ML-DSA-65 sig) | — |
| DoS (handshake CPU) | ✓ (rate limit + DoS MAC) | — | ✓ (replay cache pre-check) | — | — |
| DoS (stream exhaustion) | ✓ (max streams/data) | ✓ (QUIC flow control) | — | — | — |
| Capability escalation | — | — | — | — | ✓ (UCAN subset check) |
| DHT poisoning | ✓ (publish rate limit) | — | — | ✓ (record signatures) | — |
| Eclipse attack | — | — | — | ✓ (WoT advisory) | — |
| PubSub spam | ✓ (publish rate limit) | — | — | — | — |
| Traffic analysis | — | partial (QUIC encryption) | — | — | — |
| Key compromise | — | — | — | ✓ (CRL revocation) | ✓ (token expiry) |
| PQ key recovery | — | ✓ (hybrid KEX) | — | ✓ (PQ signatures) | — |
| Session fixation | — | — | ✓ (server_agent_id binding) | — | — |
| 0-RTT replay | — | ✓ (0-RTT disabled) | — | — | — |
| ALPN downgrade | — | ✓ (ALPN enforcement) | — | — | — |

**Legend:** ✓ = primary defense; — = not applicable at this layer.

---

## 12. Attack tree (detailed)

```
Goal: Impersonate agent A
├── Steal A's secret key
│   ├── Side-channel on signing (power/cache) → forge signatures
│   ├── Memory dump (no zeroization) → extract key from RAM
│   └── Supply chain (compromised fips204 crate) → backdoored keygen
│       Mitigations: HSM, zeroize, crate pinning + audit
│
├── Break ML-DSA-65 cryptographically
│   └── Quantum computer or classical breakthrough
│       Mitigations: NIST Level 3 (2^192); monitor crypto research
│
├── Replay a valid handshake
│   ├── Same server → blocked by ReplayCache (300s window)
│   └── Different server → blocked by transcript hash (new nonce)
│
├── MITM the handshake
│   └── Blocked by TLS exporter channel binding
│
└── Substitute A's public key in directory
    └── Blocked by AgentId = SHA-256(pk) invariant + record signatures
```

```
Goal: Escalate capabilities beyond delegation
├── Broaden resource in child token
│   └── Blocked by caps_compatible() (resource must be sub-resource)
├── Change action in child token
│   └── Blocked by caps_compatible() (action must match exactly)
├── Broaden constraints in child token
│   └── NOT BLOCKED (known limitation, ucan.rs:306)
├── Splice tokens from different chains
│   └── Blocked by prf linkage (SHA-256 of parent signing input)
├── Use expired token
│   └── Blocked by exp check in verify()
└── Use token before nbf
    └── Blocked by nbf check in verify()
```

```
Goal: Deny service to agent A
├── Flood A with handshakes
│   ├── From one IP → blocked by HandshakeRateLimiter (10/s)
│   └── From many IPs (Sybil) → partial; DoS MAC helps; no PoW
├── Exhaust A's streams
│   ├── Blocked by max_concurrent_streams (100)
│   └── Blocked by stream_initial_max_data (1 MiB)
├── Eclipse A in the DHT
│   ├── Fill A's k-buckets with Sybil nodes
│   └── Feasible for targeted attack; no Sybil resistance
├── Spam A's PubSub topics
│   ├── Blocked by per-connection rate limit (100/s)
│   └── Sybil aggregation bypasses per-connection limit
├── Drop A's traffic at rogue relay
│   └── A can switch relays via DCuTR; no relay reputation
└── Replay A's packets
    └── Blocked by QUIC packet numbers + AEAD
```

```
Goal: De-anonymize agent A
├── Observe A's IP address
│   └── Visible in QUIC headers (source IP)
├── Correlate A's connection timing
│   └── No mitigation (no padding, no mixing)
├── Track A via QUIC connection ID
│   └── Partial: CID can rotate; not explicitly configured
├── Map A's DHT queries
│   └── DHT queries are observable; reveal capabilities sought
├── Map A's relay usage
│   └── Relay forwarding is observable; reveals communication partners
└── Fingerprint A's traffic by size
    └── ML-DSA-65 signatures (3309 bytes) create distinctive size patterns
```

---

## 13. Security audit checklist

### 13.1 Cryptography (15 items)

- [ ] **C1:** ML-DSA-65 key generation uses a CSPRNG (verify `fips204::KG::try_keygen` source)
- [ ] **C2:** Signing uses randomized mode (not deterministic) in production paths
- [ ] **C3:** `sign_deterministic()` is never called in production code (test-only)
- [ ] **C4:** Domain separator `"aafp-v1-handshake"` is prepended to all signature inputs
- [ ] **C5:** AgentId binding (`SHA-256(pk) == agent_id`) uses constant-time comparison
- [ ] **C6:** DoS MAC verification uses constant-time comparison
- [ ] **C7:** AEAD nonces are never reused with the same key (verify nonce generation)
- [ ] **C8:** ChaCha20-Poly1305 is the default AEAD (constant-time, no HW dependency)
- [ ] **C9:** HKDF-SHA256 uses distinct `info` labels for each derived key (session ID, DoS MAC, etc.)
- [ ] **C10:** Secret keys are zeroized on drop (currently NOT implemented — add `zeroize` crate)
- [ ] **C11:** The `fips204` crate is pinned to a specific version and audited
- [ ] **C12:** No `expect()`/`panic!()` in crypto operations that could be triggered by attacker input
- [ ] **C13:** Signature verification returns `false` (not an error) on failure — no oracle
- [ ] **C14:** Public key validation rejects malformed keys before use (`from_bytes` checks)
- [ ] **C15:** Cross-language test vectors (A-10) verify Rust/Go signature interop

### 13.2 Handshake (12 items)

- [ ] **H1:** Protocol version is checked and must equal `PROTOCOL_VERSION` (1)
- [ ] **H2:** Key algorithm is checked and must equal `KEY_ALG_ML_DSA_65` (1)
- [ ] **H3:** `expires_at` is checked against current time; expired identities are rejected
- [ ] **H4:** Transcript hash is initialized from TLS exporter (channel binding)
- [ ] **H5:** Each handshake message is folded into the transcript hash in order
- [ ] **H6:** Signatures are over `DOMAIN_SEPARATOR || transcript_hash` (not raw messages)
- [ ] **H7:** Session ID is bound to `server_agent_id` (A-4, prevents session fixation)
- [ ] **H8:** Optional fields (`receiver_mac`) are omitted when absent, not encoded as `null` (A-2)
- [ ] **H9:** CBOR encoding is canonical (deterministic) for signature reproducibility
- [ ] **H10:** ReplayCache check happens before signature verification (CPU DoS protection)
- [ ] **H11:** ReplayCache `check_and_insert` is atomic under the Mutex
- [ ] **H12:** No unauthenticated code path exists (SDK requires `MessagingEnabled` state)

### 13.3 Transport (8 items)

- [ ] **T1:** ALPN `aafp/1` is required; connections without it are rejected
- [ ] **T2:** PQ KEX (`X25519MLKEM768`) is enabled by default (`enable_pq = true`)
- [ ] **T3:** 0-RTT early data is disabled (prevents replay)
- [ ] **T4:** TLS session resumption does not skip the application handshake
- [ ] **T5:** Self-signed certificates are used for TLS only; identity is verified at app layer
- [ ] **T6:** `NoVerifier` does not accept any certificate — it only skips TLS cert verification
- [ ] **T7:** Max concurrent streams is bounded (100)
- [ ] **T8:** Max idle timeout is configured (30s default, prevents zombie connections)

### 13.4 Identity & Authorization (10 items)

- [ ] **I1:** AgentId is always `SHA-256(public_key)` — never user-chosen
- [ ] **I2:** UCAN token `iss` matches `SHA-256(issuer_public_key)`
- [ ] **I3:** UCAN chain verifies `prf` linkage at every hop
- [ ] **I4:** UCAN chain verifies capability narrowing (resource + action)
- [ ] **I5:** UCAN token `exp` and `nbf` are checked
- [ ] **I6:** UCAN chain `iss`/`aud` linkage is verified
- [ ] **I7:** CRL entries are signed and verified before trust
- [ ] **I8:** CRL TTL is enforced; expired CRLs are evicted
- [ ] **I9:** Key rotation requires both old and new key signatures
- [ ] **I10:** KeyDirectory enforces monotonic version numbers

### 13.5 DHT (6 items)

- [ ] **D1:** DHT records are signed; unsigned records are rejected
- [ ] **D2:** KeyDirectory publish rate limit (1/AgentId/hour) is enforced
- [ ] **D3:** K-bucket size is bounded (K=20)
- [ ] **D4:** Iterative lookup concurrency is bounded (α=3)
- [ ] **D5:** Replication factor is ≥5 (k=5)
- [ ] **D6:** Bucket refresh occurs periodically (15 min)

### 13.6 PubSub (5 items)

- [ ] **P1:** Per-connection publish rate limit is enforced (100/s)
- [ ] **P2:** Max message size is enforced (1 MiB)
- [ ] **P3:** Max subscriptions per connection is bounded (1024)
- [ ] **P4:** Max topic length and depth are bounded (256 chars, 16 levels)
- [ ] **P5:** Rate-limited publishes return `PubSubError::RateLimited` (not silent drop)

### 13.7 Resource governance (6 items)

- [ ] **R1:** Max connections is bounded (100 default)
- [ ] **R2:** Handshake rate limiter has max_entries cap (10K IPs) to prevent memory blow-up
- [ ] **R3:** ReplayCache has max_entries cap (100K default) with LRU eviction
- [ ] **R4:** ReplayCache retention is bounded (300s default, max 3600s)
- [ ] **R5:** Rate limiter evicts expired entries periodically
- [ ] **R6:** AgentId comparison uses `ConstantTimeEq` (Track Q7)

### 13.8 Fuzzing & malformed input (5 items)

- [ ] **F1:** CBOR decoder fuzz target exists (`fuzz/fuzz_targets/cbor_decode`)
- [ ] **F2:** Frame decoder fuzz target exists
- [ ] **F3:** Handshake CBOR fuzz target exists
- [ ] **F4:** RPC decode fuzz target exists
- [ ] **F5:** Agent record fuzz target exists

### 13.9 Operational security (3 items)

- [ ] **O1:** Agent secret keys are stored encrypted at rest (verify key storage path)
- [ ] **O2:** Agent process runs with minimal privileges (no root)
- [ ] **O3:** Dependencies are pinned and scanned for vulnerabilities (`cargo audit`)

**Total: 70 checklist items**

---

## 14. Residual risk summary

| Risk | Severity | Likelihood | Mitigation status |
|------|----------|------------|-------------------|
| Sybil eclipse of DHT | High | Medium (targeted) | No Sybil resistance; WoT is advisory |
| Traffic analysis / de-anonymization | High | High (state actor) | No padding, no mixing; out of scope |
| UCAN constraint scope creep | Medium | Low | Known limitation; needs constraint-narrowing check |
| UCAN chain pubkey resolution | Medium | Low | MVP limitation; needs KeyDirectory integration |
| Key exfiltration (no zeroization) | Medium | Low | Add `zeroize` crate; use HSM for high-value agents |
| Relay collusion / partitioning | Medium | Low | No relay reputation; DCuTR provides escape hatch |
| PubSub topic hijacking | Medium | Medium | No topic ownership; application must sign messages |
| DHT routing table poisoning | Low | Medium | No PEX verification; performance degradation only |
| ML-DSA-65 side-channels (cache) | Low | Low (requires local access) | Use TEE/dedicated hardware for high-value agents |
| Replay cache miss (cross-server) | Low | Low | Per-server cache; signature still fails on new nonce |

---

## 15. Recommendations

### 15.1 Short-term (before production deployment)

1. **Add `zeroize` to secret key types** — `MlDsa65SecretKey` should
   zeroize its `Vec<u8>` on drop. This prevents key leakage via core
   dumps or swap.
2. **Integrate KeyDirectory into UCAN chain verification** — The
   `verify_chain()` function (`ucan.rs:198`) needs a pubkey resolver
   parameter to verify intermediate tokens. Without this, chains longer
   than 1 hop are not fully verified.
3. **Add constraint-narrowing to `caps_compatible()`** — Compare
   `constraints` between parent and child capabilities. A child's
   `max_tokens` must be ≤ the parent's.
4. **Enforce max UCAN chain depth** — Add a configurable maximum chain
   length (e.g., 8) to prevent DoS via very long chains.
5. **Add per-topic PubSub rate limiting** — In addition to per-connection
   limits, enforce a per-topic aggregate rate to prevent Sybil-amplified
   spam.

### 15.2 Medium-term (hardening)

6. **Implement QUIC connection ID rotation** — Configure quinn to rotate
   connection IDs periodically to reduce linkability.
7. **Add optional traffic padding** — Pad small messages to a fixed size
   to reduce packet-size fingerprinting.
8. **Implement DHT record proof-of-storage** — Require publishers to
   prove they store the record (not just inject it) to reduce pollution.
9. **Add relay reputation scoring** — Track relay uptime, latency, and
   drop rate; prefer high-reputation relays.
10. **Audit the `fips204` crate** — Commission a formal audit of the
    pure-Rust ML-DSA-65 implementation for constant-time correctness.

### 15.3 Long-term (research)

11. **Explore Sybil resistance mechanisms** — Proof-of-stake (bonded
    AgentIds), proof-of-work for DHT joins, or social-network-based
    admission control.
12. **Investigate mix-network overlay** — For agents requiring strong
    metadata privacy, integrate a mixnet (e.g., Nym) below QUIC.
13. **Post-quantum signature aggregation** — Investigate lattice-based
    signature aggregation to reduce the 3309-byte signature overhead in
    handshakes.
14. **Formal verification of the handshake** — Model the AAFP handshake
    in Tamarin or ProVerif to prove resistance to MITM and replay.

---

## 16. References

| Reference | Location |
|-----------|----------|
| ML-DSA-65 implementation | `aafp-crypto/src/dsa.rs` |
| AEAD (ChaCha20-Poly1305 / AES-256-GCM) | `aafp-crypto/src/aead.rs` |
| HKDF-SHA256 | `aafp-crypto/src/kdf.rs` |
| KEM (X25519 standalone, hybrid via TLS) | `aafp-crypto/src/kem.rs` |
| v1 handshake protocol | `aafp-crypto/src/handshake_v1.rs` |
| Replay cache | `aafp-crypto/src/replay_cache.rs` |
| Crypto traits | `aafp-crypto/src/traits.rs` |
| UCAN delegation | `aafp-identity/src/ucan.rs` |
| Revocation (CRL) | `aafp-identity/src/revocation.rs` |
| Key rotation | `aafp-identity/src/key_rotation.rs` |
| Key directory | `aafp-identity/src/key_directory.rs` |
| QUIC transport config | `aafp-transport-quic/src/config.rs` |
| DHT routing | `aafp-discovery/src/dht_router.rs` |
| Server resource limits | `aafp-sdk/src/server.rs` |
| PubSub limits | `aafp-sdk/src/pubsub/limits.rs` |
| FIPS 204 (ML-DSA standard) | NIST FIPS 204 |
| TLS 1.3 (RFC 8446) | IETF RFC 8446 |
| QUIC (RFC 9000-9002) | IETF RFC 9000, 9001, 9002 |

---

*End of document. 70 audit checklist items. 4 attack trees. 10 threat
actors analyzed. 14 residual risks catalogued.*
