# AAFP Cryptographic Agility & Post-Quantum Roadmap

> **Status:** Living document — tracks the cryptographic foundation of the AAFP
> protocol, its agility mechanisms, and the multi-year migration path as NIST
> post-quantum standards mature.
>
> **Scope:** All cryptographic primitives used by the AAFP Rust implementation
> (`aafp-crypto`, `aafp-identity`, `aafp-transport-quic`), their current
> selections, negotiation design, upgrade procedures, and side-channel posture.

---

## Table of Contents

1. [Current Cryptographic Stack](#1-current-cryptographic-stack)
2. [NIST PQC Standardization Status](#2-nist-pqc-standardization-status)
3. [Crypto Agility Design Principles](#3-crypto-agility-design-principles)
4. [Algorithm Negotiation in the Handshake](#4-algorithm-negotiation-in-the-handshake)
5. [Hybrid Signatures (Transition Period)](#5-hybrid-signatures-transition-period)
6. [Key Rotation Strategy](#6-key-rotation-strategy)
7. [When ML-DSA-65 Might Need Replacement](#7-when-ml-dsa-65-might-need-replacement)
8. [Migration to ML-DSA-87 (NIST Level 5)](#8-migration-to-ml-dsa-87-nist-level-5)
9. [Hash Function Agility](#9-hash-function-agility)
10. [AEAD Agility](#10-aead-agility)
11. [Side-Channel Countermeasures](#11-side-channel-countermeasures)
12. [HSM / TEE Integration](#12-hsm--tee-integration)
13. [Concrete Crypto Upgrade Plan & Timeline](#13-concrete-crypto-upgrade-plan--timeline)
14. [Appendix: Algorithm Identifier Registry](#appendix-algorithm-identifier-registry)

---

## 1. Current Cryptographic Stack

AAFP is a post-quantum-first agent communication protocol. Every cryptographic
primitive was chosen with two goals: (a) resist harvest-now-decrypt-later
attacks today, and (b) remain swappable without protocol-level changes as the
PQC landscape evolves.

### 1.1 Primitive Inventory

| Layer | Primitive | Standard | Security Level | Crate / Backend |
|-------|-----------|----------|----------------|-----------------|
| **Signatures** | ML-DSA-65 | FIPS 204 | NIST Level 3 (≈AES-192) | `fips204` (pure Rust) |
| **Key Exchange** | X25519MLKEM768 (hybrid) | draft-kwiatkowski-tls-ecdhe-mlkem | Level 1 + classical | `quinn` + `rustls` (`aws-lc-rs`, `prefer-post-quantum`) |
| **AEAD (default)** | ChaCha20-Poly1305 | RFC 8439 | 256-bit | `chacha20poly1305` |
| **AEAD (optional)** | AES-256-GCM | FIPS 197 / SP 800-38D | 256-bit | `aes-gcm` (AES-NI) |
| **KDF** | HKDF-SHA256 | RFC 5869 | 128-bit | `hkdf` + `sha2` |
| **Transcript Hash** | SHA-256 | FIPS 180-4 | 128-bit | `sha2` |
| **MAC (DoS)** | HMAC-SHA256 | FIPS 198-1 | 128-bit | `hmac` + `sha2` |
| **AgentId** | SHA-256(public_key) | — | 128-bit collision resistance | `sha2` |
| **TLS cert (transport)** | Ed25519 (self-signed) | RFC 8032 | 128-bit | `rustls` + `aws-lc-rs` |

### 1.2 Why These Choices

**ML-DSA-65 (not SLH-DSA or Falcon):** ML-DSA-65 offers the best balance of
signature size (3309 bytes), public key size (1952 bytes), and verification
speed among the NIST Level 3 signature finalists. SLH-DSA has stateless
security but 17 KB signatures; Falcon has smaller signatures but a complex
FFT-based signing procedure that is harder to implement in constant time. The
`fips204` crate was selected after the previous `pqcrypto-mldsa` crate was
flagged by three RustSec advisories (RUSTSEC-2026-0162/0163/0166); the
migration preserved wire compatibility because both use raw FIPS 204 byte
encoding.

**X25519MLKEM768 (hybrid, not pure ML-KEM):** A hybrid KEX combines classical
X25519 with ML-KEM-768 so that the session secret is secure if *either*
component remains unbroken. This is the defense-in-depth strategy recommended
by NIST SP 800-227 and IETF draft-reddy-tls-hybrid-design. The hybrid KEX is
performed inside the TLS 1.3 handshake by `rustls` with the
`prefer-post-quantum` feature; the resulting secret is exported via the TLS
exporter (`EXPORTER-AAFP-Channel-Binding`) and bound into the application-layer
handshake transcript.

**ChaCha20-Poly1305 as default AEAD:** ChaCha20-Poly1305 is constant-time in
software with no hardware dependency, making it safe on platforms without
AES-NI (ARM Cortex-A53, RISC-V, embedded agents). AES-256-GCM is offered as an
alternative for x86_64 / aarch64 where AES-NI/ARMv8 Crypto Extensions provide
hardware acceleration and the constant-time guarantee comes from the CPU
instruction itself.

**HKDF-SHA256:** SHA-256 is the most widely deployed and audited hash function.
For a 128-bit security level it is adequate. The KDF is a thin wrapper (see
`kdf.rs`); swapping to HKDF-SHA3-256 or HKDF-BLAKE3 requires changing only the
type parameter.

### 1.3 Source File Map

| File | Role |
|------|------|
| `aafp-crypto/src/traits.rs` | `SignatureScheme` and `KeyEncapsulation` traits — the agility interface |
| `aafp-crypto/src/dsa.rs` | ML-DSA-65 implementation (FIPS 204) + deterministic test-vector helpers |
| `aafp-crypto/src/kem.rs` | X25519 KEM (standalone test path) + `HybridKem` marker for the production PQ path |
| `aafp-crypto/src/aead.rs` | `Aead` struct with `AeadAlgorithm` enum (ChaCha20Poly1305 / Aes256Gcm) |
| `aafp-crypto/src/kdf.rs` | `hkdf_sha256()` and `derive_key()` |
| `aafp-crypto/src/handshake_v1.rs` | RFC-0002 compliant 3-way handshake, transcript hash, session ID derivation |
| `aafp-crypto/src/handshake.rs` | Legacy v0 handshake (binary wire format, benchmarks only) |
| `aafp-crypto/src/replay_cache.rs` | Cross-connection nonce replay detection (RFC-0002 §6.7) |
| `aafp-identity/src/key_rotation.rs` | `KeyRotationRecord` — old+new key signing for identity continuity |
| `aafp-identity/src/identity_v1.rs` | `AgentId` with constant-time `PartialEq` |
| `aafp-transport-quic/src/config.rs` | QUIC/TLS config enabling `X25519MLKEM768` |

---

## 2. NIST PQC Standardization Status

NIST's Post-Quantum Cryptography Standardization project began in 2016 and has
produced three finalized standards (August 2024) with a fourth round ongoing.

### 2.1 Finalized Standards (FIPS, August 2024)

| Standard | FIPS Number | Algorithm | Use Case | NIST Level | Status in AAFP |
|----------|-------------|-----------|----------|------------|----------------|
| **ML-KEM** | FIPS 203 | Module-Lattice-based KEM | Key encapsulation | Level 1 (ML-KEM-512), Level 3 (ML-KEM-768), Level 5 (ML-KEM-1024) | ML-KEM-768 used in hybrid KEX via TLS |
| **ML-DSA** | FIPS 204 | Module-Lattice-based DSA | General-purpose signatures | Level 2 (ML-DSA-44), Level 3 (ML-DSA-65), Level 5 (ML-DSA-87) | **ML-DSA-65 is the primary signature** |
| **SLH-DSA** | FIPS 205 | Stateful Hash-based DSA (SPHINCS+) | Signatures with minimal security assumptions | Levels 1, 3, 5 (128s, 192s, 256s variants) | Not currently used; candidate for "conservative" fallback |

### 2.2 Additional Algorithms

**Falcon (FIPS 206, draft):** NIST is standardizing Falcon as a companion
signature scheme with smaller signature sizes (~666 bytes at Level 1 vs.
ML-DSA-44's 2420 bytes). Falcon's advantage is compact signatures; its
disadvantage is the complex FFT-based signing, which makes constant-time
implementation difficult. FIPS 206 is expected to be finalized in 2025–2026.
Falcon is a candidate for bandwidth-constrained AAFP deployments (e.g., IoT
agents over LoRa).

**HQC (Round 4, KEM):** NIST selected HQC as a backup KEM to ML-KEM in March
2025. HQC is code-based rather than lattice-based, providing diversity against
potential cryptanalytic breaks of the lattice family. If a structural weakness
in ML-KEM is discovered, HQC is the designated replacement. AAFP's KEM trait
abstraction (see §3) allows adding an HQC hybrid without protocol changes.

**FN-DSA / EagleSign / additional signatures:** NIST has opened additional
signature on-ramps for signatures with small signatures or small verification
keys. These are multi-year efforts and not yet relevant to AAFP's deployment
horizon.

### 2.3 What This Means for AAFP

AAFP's current selections (ML-DSA-65, ML-KEM-768-in-hybrid) are aligned with
the finalized FIPS standards. The protocol's agility design (§3–§4) ensures
that when NIST publishes updates, revisions, or new algorithms, AAFP can adopt
them through configuration and library updates rather than protocol redesign.

---

## 3. Crypto Agility Design Principles

Cryptographic agility is the ability to change algorithms without changing the
protocol. AAFP achieves this through three mechanisms:

### 3.1 Trait-Based Algorithm Abstraction

The core agility interface is in `aafp-crypto/src/traits.rs`:

```rust
pub trait SignatureScheme: Send + Sync {
    type PublicKey: AsRef<[u8]> + Clone + Send + Sync;
    type SecretKey: AsRef<[u8]> + Clone + Send + Sync;
    type Signature: AsRef<[u8]> + Clone + Send + Sync;

    fn keypair() -> (Self::PublicKey, Self::SecretKey);
    fn sign(secret: &Self::SecretKey, msg: &[u8]) -> Self::Signature;
    fn verify(public: &Self::PublicKey, msg: &[u8], sig: &Self::Signature) -> bool;
    fn algorithm_name() -> &'static str;
}

pub trait KeyEncapsulation: Send + Sync {
    type PublicKey: AsRef<[u8]> + Clone + Send + Sync;
    type SecretKey: AsRef<[u8]> + Clone + Send + Sync;
    type Ciphertext: AsRef<[u8]> + Clone + Send + Sync;
    type SharedSecret: AsRef<[u8]> + Clone + Send + Sync;

    fn keypair() -> (Self::PublicKey, Self::SecretKey);
    fn encapsulate(public: &Self::PublicKey) -> (Self::Ciphertext, Self::SharedSecret);
    fn decapsulate(secret: &Self::SecretKey, ct: &Self::Ciphertext) -> Self::SharedSecret;
    fn algorithm_name() -> &'static str;
}
```

Any signature scheme or KEM that implements these traits can be used as a drop-in
replacement. The `algorithm_name()` method provides a string identifier for
negotiation and logging. The associated types are byte-serializable (`AsRef<[u8]>`)
so that keys and signatures can be transmitted over the wire without the protocol
layer needing to know their internal structure.

**Adding a new signature scheme** (e.g., SLH-DSA-192s) requires:
1. Implementing `SignatureScheme` for a new struct (e.g., `SlhDsa192s`).
2. Registering a new algorithm identifier in the negotiation registry (§4).
3. No changes to `handshake_v1.rs`, `key_rotation.rs`, or any consumer.

### 3.2 Algorithm Identifiers in Wire Messages

Every identity-bearing message carries a `key_algorithm` field (CBOR key 10 in
`ClientHello` and `ServerHello`). Currently only `KEY_ALG_ML_DSA_65 = 1` is
defined. This is a u64, providing room for 2^64 algorithm identifiers — far
more than will ever be needed. The receiver checks this field before attempting
to parse the public key or verify the signature, so an unknown algorithm
produces a clean `UnsupportedAlgorithm` error rather than a parsing crash.

### 3.3 AEAD Algorithm Selection at Runtime

The `Aead` struct takes an `AeadAlgorithm` enum at construction time:

```rust
pub enum AeadAlgorithm {
    ChaCha20Poly1305,
    Aes256Gcm,
}
```

The session key derived from the handshake is 32 bytes, compatible with both
algorithms. The choice is made per-session (or per-deployment) and does not
require protocol changes. Adding a third AEAD (e.g., AES-GCM-SIV) means adding
a variant to the enum and a match arm in `encrypt()`/`decrypt()`.

### 3.4 KDF Parameterization

`hkdf_sha256()` takes `salt`, `ikm`, `info`, and `output_len` as parameters.
The hash function is a type parameter on `Hkdf<Sha256>`. To switch to
HKDF-SHA3-256, one changes the type parameter — no protocol change needed
(though the transcript hash and AgentId derivation would also need to change
for consistency; see §9).

---

## 4. Algorithm Negotiation in the Handshake

### 4.1 Current Negotiation (v1 Handshake)

The RFC-0002 compliant handshake (`handshake_v1.rs`) uses a single
`key_algorithm` field rather than a full offer/accept negotiation. The client
sends its algorithm in `ClientHello.key_algorithm` (CBOR key 10), and the
server either accepts it (by using the same algorithm in `ServerHello`) or
rejects it with `UnsupportedAlgorithm`.

The legacy v0 handshake (`handshake.rs`) has a richer negotiation structure:

```
ClientHello:
  key_shares: Vec<(u16 algorithm_id, Vec<u8> key_share)>  // client offers multiple KEX
  signature_algorithm: u16                                  // client's signature choice
ServerHello:
  selected_kex_algorithm: u16                               // server picks one KEX
```

This allows the client to offer multiple KEX algorithms simultaneously (e.g.,
X25519MLKEM768 and a future pure-ML-KEM-1024), and the server selects one. The
signature algorithm is currently single-valued, but the u16 namespace
(`ALG_X25519MLKEM768 = 0x0001`, `ALG_ML_DSA_65 = 0x0001`) provides room for
expansion.

### 4.2 How to Add a New Signature Algorithm

To add, say, ML-DSA-87 as an alternative signature:

1. **Define the algorithm identifier:**
   ```rust
   pub const KEY_ALG_ML_DSA_87: u64 = 2;  // in handshake_v1.rs
   ```

2. **Implement the scheme:**
   ```rust
   pub struct MlDsa87;
   impl SignatureScheme for MlDsa87 { /* ... */ }
   ```

3. **Update `verify_client_hello` / `verify_server_hello`:**
   Add a match arm for `KEY_ALG_ML_DSA_87` that:
   - Validates the public key length (ML-DSA-87 pk = 2592 bytes).
   - Constructs the appropriate verifier.
   - Verifies the signature over the same transcript hash.

4. **Update `AgentId` derivation:** AgentId = SHA-256(public_key) is
   algorithm-agnostic, so no change is needed. The `key_algorithm` field
   tells the receiver how to interpret the public key bytes.

5. **Update key rotation:** `KeyRotationRecord` carries `new_public_key` as a
   byte vector, so it is already algorithm-agnostic. The `verify()` method
   constructs the verifier based on key length or an explicit algorithm field
   (a future extension).

No changes to the CBOR wire format, the transcript hash computation, or the
session ID derivation are required.

### 4.3 How to Add a New KEX Algorithm

KEX negotiation is handled at the TLS layer for the production path. To add a
new hybrid (e.g., X25519 + HQC-128):

1. Wait for `rustls` / `aws-lc-rs` to support the new group.
2. Enable it in the `rustls::crypto::CryptoProvider` configuration.
3. Update the `HybridKem` algorithm ID if a standalone path is needed.

For the standalone test path, implement `KeyEncapsulation` for the new KEM and
add its algorithm ID to the `key_shares` vector in `client_init()`.

### 4.4 Backward Compatibility During Negotiation

When a new algorithm is introduced, both old and new clients/servers must
coexist. The strategy is:

- **New clients** offer both old and new algorithms (in preference order).
- **Old servers** ignore the unknown algorithm and select one they support.
- **New servers** prefer the new algorithm but fall back to the old one.

This is standard TLS-style grease-and-negotiate. The `key_algorithm` field in
the v1 handshake is checked with an explicit `UnsupportedAlgorithm` error, so
old implementations fail cleanly rather than misinterpreting an unknown
algorithm's key bytes.

---

## 5. Hybrid Signatures (Transition Period)

### 5.1 Rationale

During the transition from classical to post-quantum signatures, there is
uncertainty about the security of lattice-based schemes. A hybrid signature —
signing the same data with both a classical scheme (Ed25519) and a PQ scheme
(ML-DSA-65) — provides security if *either* scheme remains unbroken. This is
the same principle as hybrid KEX, applied to authentication.

### 5.2 Current State

AAFP currently uses **pure ML-DSA-65** for agent identity signatures. The TLS
transport layer uses self-signed Ed25519 certificates, but these are for
transport encryption only — agent identity authentication is entirely at the
application layer via ML-DSA-65.

This means AAFP's identity layer is already "post-quantum only" with no
classical fallback. This is acceptable for a PQ-first protocol, but a hybrid
signature mode should be added for high-assurance deployments that want
defense-in-depth during the PQC transition decade (2025–2035).

### 5.3 Proposed Hybrid Signature Design

A hybrid signature would extend the `ClientHello` and `ServerHello` with an
optional second signature:

```cbor
; Extension to ClientHello (future, key 11)
11: bstr  ; classical_signature: Ed25519 over the same transcript hash
```

The `key_algorithm` field would be extended to indicate hybrid mode:

| Value | Meaning |
|-------|---------|
| 1 | ML-DSA-65 (pure PQ, current) |
| 2 | ML-DSA-87 (pure PQ, high-security) |
| 3 | ML-DSA-65 + Ed25519 (hybrid transition) |
| 4 | SLH-DSA-192s (conservative fallback) |

Verification logic for hybrid mode:
1. Verify the ML-DSA-65 signature (PQ security).
2. Verify the Ed25519 signature (classical security).
3. Both MUST verify. If either fails, reject.

### 5.4 Implementation Path

1. Add `ed25519-dalek` as a dependency of `aafp-crypto`.
2. Implement `Ed25519SignatureScheme` (trivial — it already fits the
   `SignatureScheme` trait).
3. Add a `HybridSignature` wrapper that holds both signatures and verifies both.
4. Extend `ClientHello`/`ServerHello` CBOR with the second signature field.
5. Update `verify_client_hello` / `verify_server_hello` to handle hybrid mode.
6. Update `KeyRotationRecord` to support dual signatures during rotation.

The `SignatureScheme` trait's associated types make this clean: a hybrid
scheme can be a new struct with `type Signature = HybridSig` where `HybridSig`
contains both the ML-DSA-65 and Ed25519 signature bytes.

### 5.5 When to Use Hybrid Signatures

- **High-assurance deployments:** Government, financial, critical infrastructure
  where the cost of a second signature is acceptable.
- **Transition period (2025–2032):** While ML-DSA cryptanalysis is still maturing.
- **Long-lived signatures:** Agent identity records that may be verified 10+
  years after signing, when classical security may be broken but PQ security
  is proven (or vice versa).

For most AAFP deployments, pure ML-DSA-65 is sufficient. Hybrid mode is an
opt-in for paranoid configurations.

---

## 6. Key Rotation Strategy

### 6.1 KeyRotationRecord (RFC 0011 §6)

AAFP implements identity-preserving key rotation via `KeyRotationRecord` in
`aafp-identity/src/key_rotation.rs`. When an agent generates a new keypair
(for security hygiene, algorithm upgrade, or key compromise concern), it
creates a record signed by **both** the old and new keys:

```cbor
KeyRotationRecord = {
    1: tstr,    ; "aafp-rotation-v1"
    2: bstr,    ; old_agent_id (32 bytes)
    3: bstr,    ; new_agent_id (32 bytes)
    4: bstr,    ; new_public_key (1952 bytes for ML-DSA-65)
    5: uint,    ; timestamp (unix seconds)
    6: bstr,    ; old_signature: ML-DSA-65 over fields 1-5
    7: bstr,    ; new_signature: ML-DSA-65 over fields 1-5
}
```

Both signatures are over `"aafp-v1-rotation" || CBOR(fields 1-5)` — the same
data, signed by two different keys. This proves:
- **old_signature:** The old key authorized the rotation (not an attacker
  creating a fake successor).
- **new_signature:** The new key is controlled by the same entity (the new
  key holder accepts the succession).

### 6.2 Verification

`KeyRotationRecord::verify()` performs five checks:
1. `record_type == "aafp-rotation-v1"`
2. `new_agent_id == SHA-256(new_public_key)` — the new identity is correctly
   derived from the new key.
3. `old_agent_id == SHA-256(old_public_key)` — the old identity matches the
   old key (caller provides `old_public_key` from the directory/WoT).
4. `old_signature` verifies under `old_public_key`.
5. `new_signature` verifies under `new_public_key`.

All five must pass. If either signature fails, the rotation is rejected.

### 6.3 Post-Rotation Revocation

After a successful rotation, the old key should be revoked. The
`KeyRotationRecord` provides helper methods:
- `revoke_old_key()` — creates a `RevocationEntry` signed by the old key.
- `create_revocation_crl()` — creates a `RevocationList` (CRL) containing the
  revocation, with a configurable TTL.

This ensures that any peer who encounters the old key after the rotation
timestamp can verify that it was deliberately superseded, not just abandoned.

### 6.4 Rotation Triggers

| Trigger | Action | Urgency |
|---------|--------|---------|
| **Routine hygiene** | Rotate every 365 days | Low |
| **NIST algorithm update** | Rotate to new parameter set | Medium (planned) |
| **Suspected key compromise** | Rotate immediately + revoke old key | Critical |
| **Algorithm deprecation** | Rotate before deprecation deadline | High |
| **HSM migration** | Rotate key into HSM-backed key | Medium |

### 6.5 Cross-Algorithm Rotation

The `KeyRotationRecord` carries `new_public_key` as a raw byte vector, so it
is algorithm-agnostic. An agent can rotate from ML-DSA-65 to ML-DSA-87 by:
1. Generating an ML-DSA-87 keypair.
2. Creating a `KeyRotationRecord` with the new public key (2592 bytes).
3. Signing with both the old ML-DSA-65 and new ML-DSA-87 secret keys.

The verifier needs to know which algorithm to use for the new key. Currently
this is inferred from key length (1952 → ML-DSA-65, 2592 → ML-DSA-87). A
future extension could add an explicit `new_key_algorithm` field to the
record for unambiguous identification.

---

## 7. When ML-DSA-65 Might Need Replacement

ML-DSA-65 is a lattice-based scheme (Module Learning with Errors / Module
Short Integer Solution). Its security rests on the conjectured hardness of
the Module-LWE and Module-SIS problems. Replacement would be needed if:

### 7.1 Cryptanalytic Break

A significant improvement in lattice cryptanalysis could reduce ML-DSA-65's
security below its claimed Level 3 (≈AES-192). Scenarios:
- **Subexponential algorithms:** If a subexponential attack on Module-LWE is
  discovered, all lattice-based schemes (ML-KEM, ML-DSA, Falcon) would be
  affected simultaneously. This would be a PQC emergency.
- **Quantum algorithm improvements:** A better quantum algorithm for the
  Shortest Vector Problem (SVP) could reduce security levels. Current
  estimates assume Grover's speedup only.
- **Implementation-specific attacks:** A flaw in the `fips204` crate's
  sampling or rejection could leak the secret key. This would require a
  library patch, not an algorithm change.

**Monitoring:** AAFP should track the IACR ePrint lattice cryptanalysis
feed and NIST's PQC verification reports. A security break would trigger an
emergency rotation to SLH-DSA (which has no lattice dependency) or to a
non-lattice KEM (HQC).

### 7.2 NIST Parameter Revision

NIST may revise FIPS 204 parameters if cryptanalysis suggests the current
parameters are too aggressive. Historically, NIST adjusted parameters between
rounds (e.g., CRYSTALS-Dilithium's dimension changes). If FIPS 204 is revised
with larger parameters, AAFP would need to:
1. Update the `fips204` crate.
2. Update key/signature length constants.
3. Rotate all agent keys to the new parameter set.

The wire format (raw FIPS 204 bytes) would change in length but not in
structure, so the protocol layer remains unchanged.

### 7.3 Performance Requirements

If ML-DSA-65's 3309-byte signatures become a bottleneck (e.g., in
high-frequency capability delegation chains), AAFP might switch to Falcon for
smaller signatures (~1280 bytes at Level 3) or to a hash-based scheme for
specific use cases. The `SignatureScheme` trait makes this a local change.

### 7.4 Regulatory Requirements

Some environments (e.g., NSA CNSA 2.0, BSI TR-02102) may mandate specific
algorithms or parameter levels. If a regulator requires Level 5 security,
AAFP would migrate to ML-DSA-87 (see §8).

### 7.5 Deprecation Timeline

NIST has not announced a deprecation timeline for FIPS 204. Based on the
SHA-1 deprecation precedent (NIST 2010 announcement → 2030 deadline), we
estimate:
- **2024–2030:** ML-DSA-65 is the recommended standard.
- **2030–2035:** Potential parameter revisions or companion standards.
- **2035+:** If no breaks occur, ML-DSA-65 remains viable for decades.

AAFP's agility design means any replacement can be deployed within a single
release cycle (weeks), not a multi-year protocol redesign.

---

## 8. Migration to ML-DSA-87 (NIST Level 5)

### 8.1 Why ML-DSA-87

ML-DSA-87 provides NIST Security Level 5 (≈AES-256), the highest category.
It uses larger lattice dimensions, resulting in:

| Parameter | ML-DSA-65 (Level 3) | ML-DSA-87 (Level 5) |
|-----------|---------------------|---------------------|
| Public key | 1952 bytes | 2592 bytes |
| Secret key | 4032 bytes | 4896 bytes |
| Signature | 3309 bytes | 4595 bytes |
| Security level | ≈AES-192 | ≈AES-256 |

### 8.2 When to Migrate

ML-DSA-87 is appropriate for:
- **High-security applications:** Classified data, long-term archival (30+
  year horizon), critical infrastructure control.
- **Regulatory compliance:** Environments requiring CNSA 2.0 Level 5.
- **Conservative deployments:** Organizations that prefer the highest
  available security level regardless of performance cost.

For most AAFP deployments, ML-DSA-65 (Level 3) is sufficient. The 39% larger
signatures and ~20% slower signing of ML-DSA-87 are justified only when the
threat model demands it.

### 8.3 Migration Procedure

1. **Implement `MlDsa87`** in a new module `aafp-crypto/src/dsa_87.rs`,
   following the same pattern as `dsa.rs` but using `fips204::ml_dsa_87`.
2. **Register `KEY_ALG_ML_DSA_87 = 2`** in the algorithm registry.
3. **Update verification functions** to handle both `KEY_ALG_ML_DSA_65` and
   `KEY_ALG_ML_DSA_87` based on the `key_algorithm` field.
4. **Deploy with dual-algorithm support:** New agents generate ML-DSA-87
   keys; old agents continue with ML-DSA-65.
5. **Rotate keys:** Agents that want Level 5 create a `KeyRotationRecord`
   from their ML-DSA-65 key to a new ML-DSA-87 key.
6. **Set a deprecation date** for ML-DSA-65 (e.g., 2 years after ML-DSA-87
   deployment) for high-security deployments.

### 8.4 Mixed-Algorithm Interoperability

During the migration period, a peer's `key_algorithm` field determines which
verifier to use. An agent with an ML-DSA-87 key can verify an ML-DSA-65
peer's signatures and vice versa — the algorithms are independent. The
`KeyRotationRecord` bridges trust across the algorithm boundary.

---

## 9. Hash Function Agility

### 9.1 Current Hash Usage

SHA-256 is used in four places:
1. **Transcript hash** (`handshake_v1.rs`): `TranscriptHash` wraps `Sha256`.
2. **AgentId derivation**: `AgentId = SHA-256(public_key)`.
3. **HKDF** (`kdf.rs`): `Hkdf<Sha256>`.
4. **HMAC** (DoS MAC): `Hmac<Sha256>`.

### 9.2 When to Change the Hash Function

SHA-256 is not currently under threat. However, migration would be considered if:
- **Grover's algorithm becomes practical:** SHA-256 provides 128-bit
  post-quantum security. If larger margins are needed, SHA-384 or SHA-512
  (256-bit PQ security) would be used.
- **NIST recommends SHA-3 family:** If NIST shifts its hash recommendation
  toward SHA-3 (Keccak) for diversity from SHA-2's Merkle-Damgård structure.
- **Performance:** BLAKE3 is significantly faster than SHA-256 on modern CPUs
  and is being considered for standardization. If it becomes a NIST standard,
  it could replace SHA-256 for performance-critical paths.

### 9.3 Migration Impact

Changing the hash function is more invasive than changing a signature scheme
because it affects the AgentId namespace. All existing AgentIds would change,
breaking identity continuity. The migration path:

1. **Introduce a hash algorithm identifier** in the handshake (similar to
   `key_algorithm` but for hashing, e.g., `hash_algorithm` field).
2. **Support both hashes simultaneously:** New agents derive AgentId with the
   new hash; old agents keep SHA-256.
3. **Use `KeyRotationRecord`** to bridge: an agent rotates from a SHA-256
   AgentId to a new-hash AgentId, with both old and new signatures.
4. **Deprecate SHA-256** after a transition period.

The `TranscriptHash` struct and `Hkdf<H>` type parameter make the code change
straightforward; the challenge is the identity namespace migration.

### 9.4 Candidate Replacements

| Hash | Output | PQ Security | Notes |
|------|--------|-------------|-------|
| SHA-256 (current) | 256-bit | 128-bit | Universal, audited |
| SHA-384 | 384-bit | 192-bit | Same family, larger margin |
| SHA-512/256 | 256-bit | 128-bit | 64-bit optimized |
| SHA3-256 | 256-bit | 128-bit | Different structure (sponge) |
| SHA3-384 | 384-bit | 192-bit | Sponge, diversity from SHA-2 |
| BLAKE3 | 256-bit | 128-bit | Fastest, tree-structured, not yet FIPS |

---

## 10. AEAD Agility

### 10.1 Current AEAD Selection

The `Aead` struct (`aead.rs`) supports two algorithms via `AeadAlgorithm`:

```rust
pub enum AeadAlgorithm {
    ChaCha20Poly1305,  // default, constant-time, no hardware dependency
    Aes256Gcm,         // hardware-accelerated (AES-NI / ARMv8)
}
```

Both use 32-byte keys and 12-byte nonces, so they are interchangeable for any
session key derived by HKDF-SHA256.

### 10.2 When to Change the AEAD

- **Nonce misuse concern:** If a deployment cannot guarantee nonce uniqueness
  (e.g., stateless servers that might reuse nonces after restart), AES-GCM-SIV
  (RFC 8452) provides misuse-resistant authenticated encryption. A single
  nonce reuse does not reveal the plaintext or the authentication key.
- **Performance:** On platforms with AES-NI, AES-256-GCM is faster than
  ChaCha20-Poly1305. On platforms without, ChaCha20-Poly1305 is faster and
  safer.
- **Standardization shifts:** If NIST or IETF deprecates ChaCha20-Poly1305
  (unlikely in the near term), AAFP would migrate.

### 10.3 Adding AES-GCM-SIV

1. Add `aes-gcm-siv` crate dependency.
2. Add `AeadAlgorithm::Aes256GcmSiv` variant.
3. Add match arms in `encrypt()` and `decrypt()`.
4. The 32-byte key and 12-byte nonce are compatible.

No protocol changes needed — the AEAD algorithm is selected at session
establishment time, not negotiated on the wire (it is a local configuration
choice, though both peers must use the same algorithm for a given session
key).

### 10.4 Nonce Management

AAFP uses 12-byte (96-bit) nonces. The ReplayCache (`replay_cache.rs`)
tracks `(agent_id, nonce)` pairs to detect cross-connection replay. Nonce
uniqueness is critical for both ChaCha20-Poly1305 and AES-256-GCM — a nonce
reuse with the same key catastrophically breaks confidentiality. AES-GCM-SIV
is the only variant that tolerates nonce reuse (with reduced but not
catastrophic security loss).

### 10.5 Candidate AEADs

| AEAD | Key | Nonce | Misuse-Resistant | Notes |
|------|-----|-------|------------------|-------|
| ChaCha20-Poly1305 (current) | 256-bit | 96-bit | No | Default, constant-time |
| AES-256-GCM (current) | 256-bit | 96-bit | No | Hardware-accelerated |
| AES-256-GCM-SIV | 256-bit | 96-bit | Yes | Misuse-resistant |
| XChaCha20-Poly1305 | 256-bit | 192-bit | No (wider nonce) | Extended nonce, random nonces safe |

---

## 11. Side-Channel Countermeasures

### 11.1 Constant-Time Comparisons

AAFP uses `subtle::ConstantTimeEq` for all security-critical comparisons:

- **AgentId equality** (`aafp-identity/src/identity_v1.rs`): `PartialEq` is
  manually implemented using `ct_eq` rather than the derived byte-by-byte
  comparison. This prevents timing oracles when comparing agent identifiers
  in lookup or authorization paths.
- **AgentId binding check** (`handshake_v1.rs:515`): The
  `verify_agent_id_binding` function compares `SHA-256(public_key)` against
  the claimed `agent_id` using `ct_eq`. Although both values are
  attacker-provided (so no secret leaks), constant-time comparison is used as
  defense-in-depth (Track Q7).
- **DoS receiver MAC verification** (`handshake_v1.rs:380-388`): The MAC is
  compared with a manual constant-time loop (`diff |= a ^ b; diff == 0`).
- **Rate limiting** (`aafp-sdk/src/server.rs`): Per-IP handshake rate
  limiting uses `subtle::ConstantTimeEq` for AgentId comparison to prevent
  timing-based enumeration.

### 11.2 Blinding and Randomization

- **ML-DSA-65 signing** uses randomized signing (FIPS 204 default). The
  `fips204` crate's `try_sign()` draws fresh randomness for each signature,
  preventing deterministic signature attacks. The `sign_deterministic()`
  method (used only for test vector generation) explicitly sets the
  randomness seed and is never used in production.
- **X25519 KEM** uses `x25519_dalek`'s `StaticSecret` / `EphemeralSecret`,
  which implement constant-time scalar multiplication via Montgomery's
  ladder. The `OsRng` source provides cryptographically secure randomness.

### 11.3 Timing Analysis

The `aafp-tests/tests/timing_analysis.rs` test suite measures timing variance
across security-critical operations to detect timing side-channels. Results
are recorded in `aafp-tests/test-results/security/timing-analysis.json`. The
test verifies that:
- Signature verification time does not correlate with key validity.
- AgentId comparison time is constant regardless of match position.
- MAC verification time is constant.

### 11.4 Memory Safety

- Secret keys are held in `Vec<u8>` / `[u8; N]` and are not zeroized on drop
  in the current implementation. **This is a known gap.** A future
  improvement would wrap secret keys in `zeroize::Zeroizing<Vec<u8>>` to
  ensure secrets are wiped from memory when no longer needed.
- The `fips204` crate's `PrivateKey` type handles its own zeroization
  internally, but the raw byte copies in `MlDsa65SecretKey` are not zeroized.

### 11.5 Recommendations

| Countermeasure | Status | Priority |
|----------------|--------|----------|
| Constant-time AgentId comparison | ✅ Implemented | — |
| Constant-time MAC verification | ✅ Implemented | — |
| Constant-time agent_id binding | ✅ Implemented | — |
| Randomized ML-DSA-65 signing | ✅ Implemented (via `fips204`) | — |
| Constant-time X25519 | ✅ Implemented (via `x25519_dalek`) | — |
| Secret key zeroization | ❌ Not implemented | Medium |
| Constant-time key directory lookup | ⚠️ Partial (AgentId eq is CT, but HashMap is not) | Low |
| Cache-timing hardening for AES-GCM | ✅ (AES-NI is constant-time) | — |

---

## 12. HSM / TEE Integration

### 12.1 Current Key Storage

Currently, ML-DSA-65 keypairs are stored in memory as `MlDsa65SecretKey`
(raw byte vectors). The `AgentKeypair` struct in `aafp-identity` holds the
public and secret keys. There is no HSM or TEE integration — keys are
software-resident.

This is acceptable for development and many production deployments, but
high-assurance environments require key storage in tamper-resistant hardware.

### 12.2 HSM Integration Design

The `SignatureScheme` trait's `sign()` method takes a `&Self::SecretKey`. For
HSM integration, the "secret key" would be an opaque handle (e.g., a key ID
or PKCS#11 object handle) rather than raw key material. The signing operation
would be delegated to the HSM via a provider interface.

Proposed design:

```rust
/// HSM-backed ML-DSA-65 signing provider.
pub struct HsmMlDsa65 {
    key_id: Vec<u8>,        // HSM key identifier (not the raw secret)
    provider: Box<dyn HsmProvider>,
}

pub trait HsmProvider: Send + Sync {
    fn sign(&self, key_id: &[u8], msg: &[u8]) -> Result<Vec<u8>, HsmError>;
    fn generate_keypair(&self) -> Result<(Vec<u8>, Vec<u8>), HsmError>; // (pk, key_id)
}
```

The `HsmMlDsa65` would implement `SignatureScheme` with:
- `type SecretKey = HsmKeyHandle` (just the key ID, not the raw key).
- `sign()` delegates to `HsmProvider::sign()`.
- `keypair()` calls `HsmProvider::generate_keypair()` and returns the public
  key + handle.

This design preserves the trait interface — all consumers of
`SignatureScheme` work unchanged.

### 12.3 TEE Integration (Intel SGX / AMD SEV / ARM TrustZone)

For TEE-based key protection, the approach is similar but the signing
operation executes inside an enclave:

1. **Key generation** occurs inside the TEE; the private key never leaves
   the enclave.
2. **Signing** is an ECALL into the enclave; the enclave reads the message,
   signs internally, and returns the signature.
3. **Attestation** (remote attestation) verifies that the enclave is genuine
   and running the expected code.

For AAFP, the `HsmProvider` trait can be implemented by a TEE backend. The
Rust `sgx-isa` or `rust-sev` crates provide the low-level interfaces.

### 12.4 PKCS#11 / KMS Support

For cloud deployments, the `HsmProvider` trait can be implemented against:
- **AWS KMS** (if ML-DSA support is added by AWS).
- **Azure Key Vault** (if ML-DSA support is added by Azure).
- **PKCS#11** (for YubiHSM, Thales Luna, Utimaco, etc.).

Currently, no major cloud KMS supports ML-DSA. This is expected to change as
FIPS 204 adoption grows (2025–2027). AAFP's trait design ensures that when
KMS support arrives, integration is a matter of implementing `HsmProvider`
for the cloud SDK — no protocol changes.

### 12.5 Implementation Priority

HSM/TEE integration is a **post-MVP** feature. The current priority is
protocol correctness and performance. HSM support should be added when:
- AAFP is deployed in environments that mandate hardware key protection.
- Cloud KMS providers add ML-DSA support.
- A hardware-backed `HsmProvider` implementation is needed for compliance.

The trait design ensures this can be added without breaking existing
deployments.

---

## 13. Concrete Crypto Upgrade Plan & Timeline

### Phase 0: Current State (2025 Q1–Q2) ✅

- [x] ML-DSA-65 signatures (FIPS 204) via `fips204` crate
- [x] X25519MLKEM768 hybrid KEX via `rustls` + `aws-lc-rs`
- [x] ChaCha20-Poly1305 / AES-256-GCM AEAD
- [x] HKDF-SHA256 key derivation
- [x] `SignatureScheme` / `KeyEncapsulation` trait abstractions
- [x] `KeyRotationRecord` for identity-preserving key changes
- [x] Constant-time comparisons for AgentId, MAC, binding
- [x] ReplayCache for nonce replay detection
- [x] Cross-language ML-DSA-65 test vectors (Rust ↔ Go, A-10)

### Phase 1: Hardening (2025 Q3–Q4)

- [ ] Secret key zeroization (`zeroize` crate integration)
- [ ] Hybrid signature mode (ML-DSA-65 + Ed25519) for high-assurance deployments
- [ ] Formal `key_algorithm` registry document (RFC-0003 update)
- [ ] Timing analysis test expansion (more operations, statistical rigor)
- [ ] FIPS 140-3 readiness assessment (if targeting FIPS-validated deployments)
- [ ] Audit `fips204` crate for constant-time compliance (third-party audit)

**Deliverable:** AAFP v1.1 with hybrid signature support and zeroized secrets.

### Phase 2: Algorithm Expansion (2026 Q1–Q2)

- [ ] ML-DSA-87 implementation (`KEY_ALG_ML_DSA_87 = 2`) for Level 5 deployments
- [ ] SLH-DSA-192s implementation as conservative fallback (`KEY_ALG_SLH_DSA_192 = 4`)
- [ ] Multi-algorithm negotiation in v1 handshake (client offers list, server selects)
- [ ] Cross-algorithm `KeyRotationRecord` with explicit `new_key_algorithm` field
- [ ] AES-GCM-SIV AEAD option for nonce-misuse-resistant deployments
- [ ] XChaCha20-Poly1305 AEAD option for extended-nonce safety

**Deliverable:** AAFP v1.2 with multi-algorithm support and three signature
options (ML-DSA-65, ML-DSA-87, SLH-DSA-192s).

### Phase 3: Hardware Integration (2026 Q3–Q4)

- [ ] `HsmProvider` trait definition and PKCS#11 implementation
- [ ] YubiHSM 2 ML-DSA support (if firmware supports it)
- [ ] Cloud KMS integration (AWS / Azure, pending provider ML-DSA support)
- [ ] TEE signing prototype (ARM TrustZone / SGX)
- [ ] Key generation inside HSM (key never exits hardware)

**Deliverable:** AAFP v1.3 with optional HSM-backed key storage and signing.

### Phase 4: Hash Agility (2027 Q1–Q2)

- [ ] `hash_algorithm` field in handshake messages
- [ ] SHA-3-256 and BLAKE3 backend options for HKDF and transcript hash
- [ ] Dual-hash AgentId support (old SHA-256 + new hash during migration)
- [ ] Hash migration via `KeyRotationRecord`

**Deliverable:** AAFP v2.0 with pluggable hash functions (SHA-256, SHA-3-256,
BLAKE3).

### Phase 5: Post-Standardization (2027+)

- [ ] Falcon integration (FIPS 206, when finalized) for compact signatures
- [ ] HQC hybrid KEX (if ML-KEM cryptanalysis warrants diversification)
- [ ] NIST on-ramp signature candidates (small-sig / small-key categories)
- [ ] Continuous cryptanalysis monitoring and parameter adjustment
- [ ] Deprecation plan for ML-DSA-65 if superseded

**Deliverable:** AAFP v2.x with the full NIST PQC suite available.

### Timeline Summary

```
2025 Q1-Q2  ████████████  Phase 0: Current PQ stack (done)
2025 Q3-Q4  ████████████  Phase 1: Hardening (zeroize, hybrid sig, audit)
2026 Q1-Q2  ████████████  Phase 2: Algorithm expansion (ML-DSA-87, SLH-DSA)
2026 Q3-Q4  ████████████  Phase 3: HSM/TEE integration
2027 Q1-Q2  ████████████  Phase 4: Hash agility (SHA-3, BLAKE3)
2027+       ████████████  Phase 5: Post-standardization (Falcon, HQC)
```

### Emergency Response Plan

If a critical break in ML-DSA or ML-KEM is announced:

1. **T+0:** Acknowledge the advisory. Assess severity (theoretical vs.
   practical attack).
2. **T+24h:** If practical: publish an AAFP security advisory. Recommend
   immediate key rotation.
3. **T+72h:** Release a patched `aafp-crypto` with the replacement algorithm
   (SLH-DSA for signatures, HQC for KEX). The trait abstraction means this is
   a new module + registry update, not a protocol change.
4. **T+7d:** Deploy patched agents. Use `KeyRotationRecord` to rotate all
   agent keys from the broken algorithm to the replacement.
5. **T+30d:** Deprecate the broken algorithm. Reject handshakes using it.

The entire emergency rotation is possible because:
- The `SignatureScheme` / `KeyEncapsulation` traits allow drop-in replacement.
- The `key_algorithm` field in the handshake allows algorithm identification.
- The `KeyRotationRecord` preserves identity continuity across algorithms.
- The CBOR wire format uses length-prefixed byte strings, so key/signature
  size changes do not break the parser.

---

## Appendix: Algorithm Identifier Registry

### Signature Algorithms (`key_algorithm` field, u64)

| ID | Algorithm | FIPS | Level | Public Key | Signature | Status |
|----|-----------|------|-------|------------|-----------|--------|
| 1 | ML-DSA-65 | FIPS 204 | 3 | 1952 B | 3309 B | ✅ Active |
| 2 | ML-DSA-87 | FIPS 204 | 5 | 2592 B | 4595 B | 📋 Planned (Phase 2) |
| 3 | ML-DSA-65 + Ed25519 (hybrid) | FIPS 204 + RFC 8032 | 3 + 128-bit | 1952 + 32 B | 3309 + 64 B | 📋 Planned (Phase 1) |
| 4 | SLH-DSA-192s | FIPS 205 | 3 | 48 B | 16224 B | 📋 Planned (Phase 2) |
| 5 | Falcon-512 | FIPS 206 (draft) | 1 | 897 B | ~666 B | 🔮 Future (Phase 5) |
| 6 | Falcon-1024 | FIPS 206 (draft) | 5 | 1793 B | ~1280 B | 🔮 Future (Phase 5) |

### KEX Algorithms (TLS group / standalone `algorithm_id`, u16)

| ID | Algorithm | Level | Status |
|----|-----------|-------|--------|
| 0x0001 | X25519MLKEM768 (hybrid) | 1 + classical | ✅ Active (via TLS) |
| 0x0002 | X25519 (standalone, test) | Classical | ✅ Active (test only) |
| 0x0003 | ML-KEM-768 (pure PQ) | 3 | 🔮 Future |
| 0x0004 | X25519HQC128 (hybrid) | 1 + classical | 🔮 Future (Phase 5) |
| 0x0005 | ML-KEM-1024 (pure PQ) | 5 | 🔮 Future |

### AEAD Algorithms (local config, `AeadAlgorithm` enum)

| Variant | Algorithm | Nonce | Misuse-Resistant | Status |
|---------|-----------|-------|------------------|--------|
| 0 | ChaCha20-Poly1305 | 96-bit | No | ✅ Active (default) |
| 1 | AES-256-GCM | 96-bit | No | ✅ Active (optional) |
| 2 | AES-256-GCM-SIV | 96-bit | Yes | 📋 Planned (Phase 2) |
| 3 | XChaCha20-Poly1305 | 192-bit | No (wider nonce) | 📋 Planned (Phase 2) |

### Hash Functions (future `hash_algorithm` field)

| ID | Hash | PQ Security | Status |
|----|------|-------------|--------|
| 1 | SHA-256 | 128-bit | ✅ Active (implicit) |
| 2 | SHA-384 | 192-bit | 📋 Planned (Phase 4) |
| 3 | SHA3-256 | 128-bit | 📋 Planned (Phase 4) |
| 4 | SHA3-384 | 192-bit | 📋 Planned (Phase 4) |
| 5 | BLAKE3 | 128-bit | 🔮 Future (pending standardization) |

---

## Summary

AAFP's cryptographic architecture is built on three pillars:

1. **Post-quantum primitives today:** ML-DSA-65 signatures and
   X25519MLKEM768 hybrid KEX provide quantum resistance against
   harvest-now-decrypt-later attacks, using finalized NIST FIPS standards.

2. **Trait-based agility:** The `SignatureScheme` and `KeyEncapsulation`
   traits, combined with the `key_algorithm` negotiation field and the
   `AeadAlgorithm` enum, allow any primitive to be replaced without protocol
   changes. Adding a new algorithm is a library-level implementation, not a
   protocol redesign.

3. **Identity continuity:** The `KeyRotationRecord` (dual-signed by old and
   new keys) ensures that algorithm upgrades, key compromises, and routine
   rotations all preserve agent identity and trust relationships across the
   network.

The upgrade plan (Phases 0–5) provides a concrete path from the current
PQ-first stack to a fully agile, hardware-backed, multi-algorithm
cryptographic foundation over the 2025–2027 horizon. The emergency response
plan ensures that if a cryptanalytic break occurs, AAFP can migrate to a
replacement algorithm within days, not years.

---

*Document version: 1.0 | Last updated: 2025 | Source: `aafp-crypto/src/{dsa,kem,aead,kdf,handshake_v1,traits}.rs`, `aafp-identity/src/key_rotation.rs`, `aafp-transport-quic/src/config.rs`*
