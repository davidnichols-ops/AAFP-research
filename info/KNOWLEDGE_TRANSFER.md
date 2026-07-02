# AAFP Knowledge Transfer Document

**Audience:** Senior protocol architect taking ownership of the AAFP
(Agent-Agent First Networking Protocol) project.
**Purpose:** Provide a single, self-contained reference covering the
specification, both implementations, the design history, the open issues,
and the operational state of the repository as of the v1 freeze candidate.
**Date:** June 2026 (post-Phase E, pre-v1.0-rc1).

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Repository Map](#2-repository-map)
3. [Protocol Specification (RFC Series)](#3-protocol-specification-rfc-series)
4. [Wire Format Reference](#4-wire-format-reference)
5. [Cryptographic Stack](#5-cryptographic-stack)
6. [Rust Reference Implementation](#6-rust-reference-implementation)
7. [Go Wire-Format Implementation](#7-go-wire-format-implementation)
8. [Testing, Conformance, and Interop](#8-testing-conformance-and-interop)
9. [Design History and Evolution](#9-design-history-and-evolution)
10. [Open Issues and Red-Team Findings](#10-open-issues-and-red-team-findings)
11. [Build, Test, and Verification Commands](#11-build-test-and-verification-commands)
12. [Glossary](#12-glossary)
13. [Recommended Next Actions](#13-recommended-next-actions)

---

## 1. Executive Summary

AAFP is a post-quantum, agent-native peer-to-peer networking protocol
designed for autonomous AI agents. It replaces libp2p's classical
cryptography (Noise + Ed25519) with a post-quantum stack
(X25519MLKEM768 hybrid KEX + ML-DSA-65 signatures) while retaining
libp2p's modular Transport/Swarm/NetworkBehaviour abstractions and
DCUtR-style NAT traversal concepts.

**Current state:** The v1 specification (RFCs 0001–0006, all at
Revision 5, "Freeze Candidate") is complete and validated by two
independent implementations that produce byte-for-byte identical wire
format. All P0 protocol-complete items are finished. The Rust
implementation is the full reference; the Go implementation is a
wire-format reference (no QUIC transport, no ML-DSA-65 signatures).

**Recommendation from Phase E:** Freeze the specification and prepare
the `v1.0-rc1` release candidate. The wire format is the contract and
it is verified; remaining work (Go ML-DSA-65, Go QUIC transport,
performance validation, CI) is post-freeze.

**Key numbers:**
- 554 Rust tests, 0 failures
- 138+ Go tests, 0 failures
- 17 golden wire traces, all verified by both implementations
- 34 interop fixtures, all round-trip verified
- 6 RFCs, 4 review cycles, 2 amendment rounds, 5 revisions
- 13 Rust crates, ~12,000 LOC
- 8 Go packages, ~4,600 LOC

---

## 2. Repository Map

```
AAFP-research/
├── RFCs/                          # Specification (6 RFCs + amendments + reviews)
│   ├── 0001-protocol-overview.md
│   ├── 0002-transport-framing.md
│   ├── 0003-identity-authentication.md
│   ├── 0004-discovery.md
│   ├── 0005-error-model.md
│   ├── 0006-versioning-compatibility.md
│   ├── AMENDMENTS-0001.md         # 18 amendments (6 Critical, 12 High)
│   ├── AMENDMENTS-0002.md         # 4 Critical interop fixes + 10 High + 9 normative gaps
│   ├── AMENDMENT_STATUS.md        # Approval gate for AMENDMENTS-0001
│   ├── REVIEW-0001.md             # First-pass review
│   ├── REVIEW-0002.md             # Second-pass review (primary-source verification)
│   ├── REVIEW-0003.md             # Independent spec review (cold-read)
│   ├── REVIEW-0004.md             # Formal threat model review
│   └── RFC_CHANGELOG.md           # Revision 1 → 5 history
│
├── implementations/
│   ├── rust/                      # Reference implementation (13-crate workspace)
│   │   ├── Cargo.toml             # Workspace manifest
│   │   ├── crates/
│   │   │   ├── aafp-cbor/         # Canonical CBOR (RFC 8949 §4.2.3)
│   │   │   ├── aafp-crypto/       # ML-DSA-65, AEAD, HKDF, handshake_v1
│   │   │   ├── aafp-identity/     # AgentId, AgentRecord, UCAN
│   │   │   ├── aafp-core/         # Transport/Swarm/Session traits
│   │   │   ├── aafp-transport-quic/  # quinn + rustls PQ transport
│   │   │   ├── aafp-discovery/    # Bootstrap, regional, capability DHT
│   │   │   ├── aafp-nat/          # AutoNAT, DCUtR, relay (stubs)
│   │   │   ├── aafp-messaging/    # Framing, RPC, streams, pubsub
│   │   │   ├── aafp-sdk/          # High-level Agent API + handshake driver
│   │   │   ├── aafp-cli/          # `aafp` CLI binary
│   │   │   ├── aafp-conformance/  # RFC conformance tests + trace generators
│   │   │   ├── aafp-benchmark/    # Criterion benchmarks
│   │   │   └── aafp-tests/        # Cross-crate integration tests
│   │   └── golden_traces/         # 17 canonical wire traces (JSON + bin + hex)
│   │
│   └── go/                        # Wire-format reference implementation
│       ├── go.mod                 # Module: aafp-go
│       ├── cbor/                  # Canonical CBOR
│       ├── frame/                 # Frame encoding/decoding
│       ├── frameext/              # Frame extensions
│       ├── handshake/             # Handshake structures
│       ├── identity/              # AgentId, AgentRecord
│       ├── errors/                # Error codes
│       ├── interop/               # Rust→Go fixture verification
│       ├── interop_fixtures/      # Binary fixtures (generated by Rust)
│       ├── goldentrace/           # Golden trace verification (17 traces)
│       ├── testvectors/           # Published test vector verification
│       ├── versionneg/            # Version negotiation matrix tests
│       ├── racestress/            # Concurrency/race tests
│       └── cmd/generate_interop_fixtures/  # Go→Rust fixture generator
│
├── docs/
│   └── status/
│       ├── PHASE2_STATUS_REPORT.md       # Pre-stabilization assessment
│       ├── STABILIZATION_REPORT.md       # Post-Phase C (545 tests, 0 warnings)
│       └── PHASE_E_REPORT.md             # Protocol candidate validation (554 tests)
│
├── ARCHITECTURAL_RED_TEAM_REVIEW.md      # 15 findings (3 Critical, 7 High, 5 Medium)
├── RED_TEAM_EXECUTIVE_SUMMARY.md         # 7 must-fix issues (pre-amendment)
├── RED_TEAM_FINDINGS_RANKED.md           # Detailed finding rankings
├── PROTOCOL_CANDIDATE_CHECKLIST.md       # P0/P1/P2 item tracking
├── ROADMAP.md                            # Phase 2 roadmap + P0/P1 status
├── README.md                             # Project overview
└── .gitmodules                           # Submodule pointers (rust + go)
```

**Note on submodules:** `implementations/rust` and `implementations/go`
are git submodules. The parent `AAFP-research` repo holds the RFCs and
documentation; the implementations live in their own repos.

---

## 3. Protocol Specification (RFC Series)

### 3.1 RFC Overview

| RFC | Title | Type | Lines | Status |
|-----|-------|------|-------|--------|
| 0001 | Protocol Overview, Goals, Layer Architecture | Informational | 427 | Freeze Candidate (Rev 5) |
| 0002 | Transport, Framing, Stream Multiplexing, Wire Format | Standards Track | 1101 | Freeze Candidate (Rev 5) |
| 0003 | Identity, AgentRecord, Capability, Authorization, Session | Standards Track | 990 | Freeze Candidate (Rev 5) |
| 0004 | Discovery | Standards Track | 458 | Freeze Candidate (Rev 5) |
| 0005 | Error Model | Standards Track | 456 | Freeze Candidate (Rev 5) |
| 0006 | Versioning, Extension Registry, Compatibility | Standards Track | 538 | Freeze Candidate (Rev 5) |

### 3.2 Layer Architecture (RFC-0001)

```
┌─────────────────────────────────────────────┐
│           Application Layer                  │  (agent-defined)
├─────────────────────────────────────────────┤
│           SDK Layer (aafp-sdk)               │  AgentBuilder, AgentClient, AgentServer
├─────────────────────────────────────────────┤
│  Messaging │ Discovery │ NAT Traversal       │  Frames, RPC, DHT, Relay, DCUtR
├─────────────────────────────────────────────┤
│        Identity & Authentication             │  AgentId, AgentRecord, UCAN
├─────────────────────────────────────────────┤
│        Cryptography                          │  ML-DSA-65, AEAD, HKDF, handshake
├─────────────────────────────────────────────┤
│        Transport (QUIC + TLS 1.3 + PQ KEX)   │  quinn + rustls + aws-lc-rs
└─────────────────────────────────────────────┘
```

### 3.3 Key Normative Requirements (Cross-RFC Summary)

**Transport (RFC-0002):**
- ALPN `aafp/1` MUST be negotiated in the TLS handshake.
- X25519MLKEM768 MUST be offered; SHOULD be preferred.
- Self-signed TLS certificates (TOFU model); NO CA chain validation.
- TLS exporter label `"EXPORTER-AAFP-Channel-Binding"` (32 bytes) binds
  the application-layer handshake to the TLS channel.
- Frame header is 28 bytes, big-endian, with 64-bit Stream ID, 64-bit
  Payload Length, 64-bit Extension Length.
- Maximum payload: 1 MiB (1,048,576 bytes). Maximum extensions: 64 KiB.
- Stream 0 is reserved for the handshake and connection-level control
  frames (PING/PONG, CLOSE, fatal ERROR). It MUST remain open for the
  connection lifetime. It MUST NOT carry DATA or RPC after handshake.
- Client-initiated streams: ≥ 4. Server-initiated streams: ≥ 5.

**Identity (RFC-0003):**
- AgentId = SHA-256(public_key), 32 bytes. Verified during handshake.
- AgentRecord is self-signed with ML-DSA-65 over
  `"aafp-v1-record" || canonical_CBOR(record_without_sig)`.
- Maximum AgentRecord expiry: 30 days (deployment warning, not
  verification rejection per SA-0003).
- CapabilityDescriptor metadata field (key 2) MUST always be present;
  empty metadata is `0xa0` (empty CBOR map).
- Fingerprint format: `AAFP-<base32(first_16_bytes)>-<CRC32>`.
  Display MUST occur before exchanging sensitive data.
- UCAN delegation chain max depth: 8. Recommended expiry: 1 hour.

**Handshake (RFC-0002 §5):**
- Three-way: ClientHello → ServerHello → ClientFinished on stream 0.
- Transcript hash: running SHA-256, initialized from TLS binding:
  ```
  h = SHA-256(tls_binding)
  h = SHA-256(h || canonical_CBOR(ClientHello_without_sig_and_mac))
  h = SHA-256(h || canonical_CBOR(ServerHello_without_sig))
  h = SHA-256(h || canonical_CBOR(ClientFinished_without_sig))
  ```
- Each signature is over `"aafp-v1-handshake" || h` where `h` is the
  transcript hash AFTER folding in the current message.
- Session ID: `HKDF-Expand(HKDF-Extract(salt=client_nonce||server_nonce,
  IKM=h_after_clienthello), info="aafp-session-id-v1", L=32)`.
- DoS receiver MAC (optional, SHOULD for Internet-facing):
  `HMAC-SHA256(HKDF(receiver_agent_id, "aafp-v1-dos-mac-key"), ch_cbor)`.

**Discovery (RFC-0004):**
- Bootstrap nodes MUST accept connections, store AgentRecords, respond
  to lookups, verify requester signatures, evict expired records.
- Rate limits: announce 1/60s, lookup 10/60s, pex 1/60s per connection.
- Unauthenticated lookup: max 5 records. Authenticated: max 10.
- All records in DHT MUST be self-signed. Expired records MUST be evicted.

**Error Model (RFC-0005):**
- 45 error codes across 10 categories (0xxx–9xxx).
- Always fatal: all 2xxx (Authentication), 8004, 8005, 8006, 8009.
- ERROR frame data field MUST NOT exceed 4096 bytes.
- Receiving an ERROR frame MUST NOT trigger a reply ERROR; MUST close
  with CLOSE frame instead.

**Versioning (RFC-0006):**
- Version 0 (pre-RFC MVP) is NOT compatible with version 1.
- ALPN identifies version: `aafp/1`, `aafp/2`, etc.
- Unknown version: send ERROR 8006 and close.
- Extension types: 0x0000–0x3FFF standards-track, 0x4000–0x7FFF
  experimental, 0x8000–0xBFFF private-use, 0xC000–0xFFFF reserved.
- Critical bit (0x80 in Flags): unknown critical frame type → ERROR 8004
  + close. Unknown non-critical → skip and continue.
- Unknown CBOR map fields: skip (ignore). Unknown non-critical
  extensions: skip. Unknown critical extensions: ERROR 8005 + close.

### 3.4 Amendment History

The RFCs went through 5 revisions driven by 4 review cycles:

| Revision | Trigger | Key Changes |
|----------|---------|-------------|
| Rev 1 | Initial draft | RFCs 0001–0006 published |
| Rev 2 | AMENDMENTS-0001 (REVIEW-0001/0002) | 18 amendments: integer CBOR keys, transcript construction, channel binding, extension format, RPC params, domain separation, DoS MAC, error codes, fingerprint, bootstrap rate limiting |
| Rev 3 | AMENDMENTS-0002 (REVIEW-0003/0004) | 4 Critical interop fixes (unified signature/transcript model, canonical CBOR for sig inputs, extension critical bit, session ID circular dependency) + Trust Model section, fingerprint MUST, key management requirements, UCAN depth MUST, Security Limitations |
| Rev 4 | SA-0001, SA-0002 | CapabilityDescriptor metadata MUST always be present; empty map key-type determined from schema |
| Rev 5 | SA-0003 | 30-day expiry is a deployment warning, not verification rejection |

**One-way doors (decisions extremely expensive to reverse):**
1. Integer CBOR keys (C1)
2. Transcript hash construction (C2)
3. Extension format (C3)
4. RPC params type (C4)
5. TLS channel binding in transcript (C5)
6. Domain separator strings (H1)
7. `expires_at` as required field (H4)
8. `key_algorithm` as required field (H8)

---

## 4. Wire Format Reference

### 4.1 Frame Header (28 bytes, big-endian)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||    Version    |    FrameType  |     Flags     |  Reserved     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||                        Stream ID (64)                          ||
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||                         Payload Length                         ||
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||               Payload Length (continued, 32 bits)              ||
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||                      Extension Length                          ||
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||               Extension Length (continued, 32 bits)            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

**Note:** The header is 28 bytes total. Version is 8-bit (currently 1).
FrameType is 8-bit. Flags is 8-bit. Reserved is 8-bit (MUST be 0).
Stream ID, Payload Length, and Extension Length are each 64-bit.

### 4.2 Frame Types

| Type | Name | Critical | Description |
|------|------|----------|-------------|
| 0x01 | DATA | No | Application data on streams ≥ 4 |
| 0x02 | HANDSHAKE | Yes | Handshake messages (stream 0 only) |
| 0x03 | RPC_REQUEST | No | RPC call |
| 0x04 | RPC_RESPONSE | No | RPC reply |
| 0x05 | CLOSE | Yes | Graceful connection close |
| 0x06 | ERROR | Yes | Protocol error (fatal flag in payload) |
| 0x07 | PING | No | Keepalive probe |
| 0x08 | PONG | No | Keepalive response (same stream as PING) |
| 0x00, 0x09–0xFF | Reserved | — | Standards-track assignment via RFC |

### 4.3 Flags

| Bit | Name | Meaning |
|-----|------|---------|
| 0x80 | CRITICAL | Frame type is critical (unknown → error+close) |
| 0x01 | MORE | More fragments follow (DATA frame fragmentation) |
| 0x02 | COMPRESSED | Payload is compressed |
| 0x04 | ENCRYPTED | Payload is application-layer encrypted |
| 0x08 | ACK | Frame is an acknowledgment |
| 0x10–0x40 | Reserved | MUST be 0 by senders, ignored by receivers |

### 4.4 Extension Format (per extension)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||          Extension Type (16)         ||C|      Reserved      ||
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||                   Extension Data Length (32)                 ||
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
||                                                               |
+                   Extension Data (variable)                   +
||                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

The `C` bit is the critical flag for the extension. Unknown critical
extension → ERROR 8005 + close. Unknown non-critical → skip.

### 4.5 CBOR Structures (Integer Keys)

All AAFP CBOR structures use integer keys for compact encoding and
canonical ordering (length-first, per RFC 8949 §4.2.3).

**ClientHello:**
```cbor
ClientHello = {
    1: uint,       // protocol_version (1)
    2: bstr,       // agent_id (32 bytes)
    3: bstr,       // public_key (1952 bytes, ML-DSA-65)
    4: bstr,       // nonce (32 bytes)
    5: [ *CapabilityDescriptor ],  // capabilities
    6: [ *ExtensionEntry ],        // extensions
    7: bstr,       // signature (3309 bytes)
    8: uint,       // expires_at (Unix timestamp)
    9: bstr / null, // receiver_mac (optional DoS MAC)
    10: uint,      // key_algorithm (1 = ML-DSA-65)
}
```

**ServerHello:**
```cbor
ServerHello = {
    1: uint,       // protocol_version
    2: bstr,       // agent_id
    3: bstr,       // public_key
    4: bstr,       // nonce
    5: [ *CapabilityDescriptor ],  // capabilities
    6: [ *ExtensionEntry ],        // extensions (accepted subset)
    7: bstr,       // session_id (32 bytes)
    8: bstr,       // signature
    9: uint,       // expires_at
    10: uint,      // key_algorithm
}
```

**ClientFinished:**
```cbor
ClientFinished = {
    1: bstr,       // session_id (echoed from ServerHello)
    2: bstr,       // signature over final transcript hash
}
```

**AgentRecord:**
```cbor
AgentRecord = {
    1: tstr,       // record_type ("aafp-record-v1")
    2: bstr,       // agent_id (32 bytes)
    3: bstr,       // public_key
    4: [ *CapabilityDescriptor ],  // capabilities
    5: [ *tstr ],   // endpoints (multiaddr strings)
    6: uint,       // created_at
    7: uint,       // expires_at
    8: bstr,       // signature
    9: uint,       // key_algorithm
}
```

**CapabilityDescriptor:**
```cbor
CapabilityDescriptor = {
    1: tstr,                          // name
    2: { *tstr => MetadataValue },    // metadata (MUST be present, MAY be empty)
}
```

**RpcRequest / RpcResponse / ErrorMessage / CloseMessage:**
```cbor
RpcRequest  = { 1: uint, 2: tstr, 3: any }
RpcResponse = { 1: uint, 2: any / null, 3: RpcErrorObject / null }
RpcErrorObject = { 1: uint, 2: tstr, 3: bstr / null }
ErrorMessage = { 1: uint, 2: tstr, 3: bstr / null, 4: bool }
CloseMessage = { 1: uint, 2: tstr }
```

### 4.6 Error Code Registry (Summary)

| Range | Category | Always Fatal? |
|-------|----------|---------------|
| 0xxx | Success/Information | No |
| 1xxx | Transport | No |
| 2xxx | Authentication | **Yes** |
| 3xxx | Authorization | No |
| 4xxx | Discovery | No |
| 5xxx | Messaging | No |
| 6xxx | Capability | No |
| 7xxx | Resource (reserved) | No |
| 8xxx | Protocol | 8004, 8005, 8006, 8009 are always fatal |
| 9xxx | Application (reserved) | No |

Key codes: 2001 (INVALID_SIGNATURE), 2007 (INVALID_AGENT_ID),
8001 (FRAME_TOO_LARGE), 8006 (INVALID_VERSION).

---

## 5. Cryptographic Stack

### 5.1 Algorithm Selection

| Purpose | Algorithm | Rationale | Standard |
|---------|-----------|-----------|----------|
| TLS KEX | X25519MLKEM768 (hybrid) | Hedging; deployed by Cloudflare/Chrome/AWS; rustls native | IETF draft |
| Agent signatures | ML-DSA-65 | L3 security; 3.3KB sig; ~500µs sign; NIST minimum | FIPS 204 |
| AgentId | SHA-256(pubkey) | Compact (32B); collision-resistant; PQ-compatible | — |
| AEAD | ChaCha20-Poly1305 (default), AES-256-GCM | Constant-time / hardware-accel | RFC 8439 / RFC 5116 |
| KDF | HKDF-SHA256 | Standard, simple | RFC 5869 |
| Transcript | SHA-256 (running) | TLS 1.3 model | RFC 8446 |
| DoS MAC | HMAC-SHA256 | Standard | RFC 2104 |

### 5.2 Key Sizes (ML-DSA-65)

| Artifact | Size |
|----------|------|
| Public key | 1952 bytes |
| Secret key | 4032 bytes |
| Signature | 3309 bytes |

### 5.3 Domain Separators

| Constant | Value | Used For |
|----------|-------|----------|
| `DOMAIN_SEPARATOR` | `"aafp-v1-handshake"` | Handshake signatures |
| `SESSION_ID_INFO` | `"aafp-session-id-v1"` | Session ID HKDF info |
| `DOS_MAC_KEY_INFO` | `"aafp-v1-dos-mac-key"` | DoS MAC key HKDF info |
| `TLS_EXPORTER_LABEL` | `"EXPORTER-AAFP-Channel-Binding"` | TLS exporter label |
| Record domain | `"aafp-v1-record"` | AgentRecord signatures |
| UCAN domain | `"aafp-v1-ucan"` | UCAN token signatures |

### 5.4 Production PQ Path

The post-quantum key exchange (X25519MLKEM768) is performed **inside the
TLS 1.3 handshake** by `quinn` + `rustls` (with the `prefer-post-quantum`
feature and `aws-lc-rs` backend). The application-layer handshake
(ClientHello/ServerHello/ClientFinished) provides agent authentication
via ML-DSA-65 signatures and binds to the TLS channel via the exporter.

**Rust crypto dependencies:**
- `fips204` v0.4 (features: `ml-dsa-65`, `default-rng`) — ML-DSA-65
- `rustls` v0.23 (features: `prefer-post-quantum`, `aws-lc-rs`) — TLS
- `aws-lc-rs` v1 — crypto backend
- `chacha20poly1305` v0.10, `aes-gcm` v0.10 — AEAD
- `sha2` v0.10, `hkdf` v0.12, `hmac` v0.12 — hashing/KDF/MAC

**Migration note:** The project migrated from `pqcrypto-mldsa`
(unmaintained, RUSTSEC-2026-0162/0163/0166) to `fips204` in Phase D.
Signature output verified byte-identical.

---

## 6. Rust Reference Implementation

### 6.1 Workspace Overview

13 crates, workspace version `0.1.0`, edition 2021, license
`MIT OR Apache-2.0`. ~12,000 LOC. 554 tests, 0 failures, 0 warnings,
0 clippy lints.

### 6.2 Crate Dependency Graph

```
aafp-cbor (foundation, no internal deps)
    ↓
aafp-crypto ────────────────────────────────┐
    ↓                                        ↓
aafp-identity ──────────── aafp-core         │
    ↓                        ↓               │
aafp-discovery           aafp-transport-quic │
aafp-nat                     ↓               │
    ↓                        ↓               │
aafp-messaging ────────── aafp-sdk ─────────┘
    ↓                        ↓
aafp-conformance          aafp-cli
aafp-benchmark            aafp-tests
```

### 6.3 Crate Summary

| Crate | Responsibility | Key Types | Notes |
|-------|---------------|-----------|-------|
| `aafp-cbor` | Canonical CBOR | `Value`, `encode`, `decode`, `int_map` | RFC 8949 §4.2.3 |
| `aafp-crypto` | PQ crypto + handshake | `MlDsa65`, `Aead`, `TranscriptHash`, `ClientHello`, `ServerHello`, `ClientFinished` | `handshake` (v0) deprecated |
| `aafp-identity` | Identity | `AgentId`, `AgentRecord`, `CapabilityDescriptor`, `UcanToken`, `AgentKeypair` | `agent_record` (legacy) deprecated |
| `aafp-core` | Traits + session | `Transport`, `Connection`, `Stream`, `Swarm`, `Session`, `SessionState` | Session enforces auth |
| `aafp-transport-quic` | QUIC transport | `QuicTransport`, `QuicConnection`, `QuicConfig`, `AAFP_ALPN` | quinn + rustls PQ |
| `aafp-discovery` | Discovery | `CapabilityDht`, `BootstrapDiscovery`, `RegionalDiscovery` | In-memory DHT (MVP) |
| `aafp-nat` | NAT traversal | `AutoNat`, `Dcutr`, `RelayService` | **Stubs only** |
| `aafp-messaging` | Messaging | `Frame`, `FrameType`, `RpcRequest`, `RpcResponse`, `MessageStream`, `PubSub` | `rpc` (legacy) deprecated |
| `aafp-sdk` | High-level API | `AgentBuilder`, `AgentClient`, `AgentServer`, `PeerInfo`, `drive_client_handshake` | Session enforcement |
| `aafp-cli` | CLI | `aafp init/start/discover/connect/send/status/relay` | clap-based |
| `aafp-conformance` | Conformance tests | 10 modules (adversarial, negative, rfc0002–0006, etc.) + 5 binaries | Trace/vector generators |
| `aafp-benchmark` | Benchmarks | Criterion: handshake, discovery, messaging | — |
| `aafp-tests` | Integration tests | `tests/integration.rs` | Full lifecycle |

### 6.4 Session State Machine (aafp-core)

The `Session` state machine enforces that all connections complete the
v1 handshake before application messages can be sent:

```
Connecting → TransportEstablished → IdentityVerified
    → AuthorizationVerified → Authenticated → MessagingEnabled
    → Closing → Closed
```

No unauthenticated code path exists in the SDK. `AgentClient::connect()`
and `AgentServer::accept_one()` both perform the full handshake.

### 6.5 Handshake Driver (aafp-sdk)

`drive_client_handshake(conn, keypair, tls_binding)` and
`drive_server_handshake(conn, keypair, tls_binding)` orchestrate the
three-way handshake over QUIC stream 0:

1. Extract TLS channel binding via `quinn`'s `export_keying_material()`.
2. Build transcript hash from TLS binding.
3. Exchange ClientHello → ServerHello → ClientFinished as HANDSHAKE
   frames (frame type 0x02) with 28-byte headers.
4. Verify all signatures, AgentId bindings, expiry, session ID.
5. Return `(Session, QuicConnection, PeerInfo)`.

### 6.6 Protocol Frames (aafp-sdk)

The `protocol_frames` module provides:
- `send_close_frame(stream, code, message)` — graceful CLOSE.
- `send_error_frame(stream, code, message, data, fatal)` — ERROR frame.
- `parse_control_frame(payload)` — parse incoming CLOSE/ERROR.

`PeerConnection::begin_close()` and `AgentClient::disconnect()` use
`send_close_frame` for graceful shutdown. `AgentClient::send_error()`
provides centralized error frame transmission.

### 6.7 Deprecated Modules (Legacy Isolation)

| Crate | Deprecated Module | Replacement | Reason |
|-------|------------------|-------------|--------|
| aafp-crypto | `handshake` (v0) | `handshake_v1` | Binary wire format, not RFC-compliant |
| aafp-identity | `agent_record` | `identity_v1` | serde/string keys, not RFC-compliant |
| aafp-messaging | `rpc` | `rpc_v1` | serde/string keys, not RFC-compliant |
| aafp-discovery | `capability_dht` | `discovery_v1` | In-memory only |

Legacy modules are marked `#[deprecated]`, not re-exported from crate
roots, and kept only for benchmarks/tests. Full removal deferred to
avoid breaking downstream consumers.

### 6.8 NAT Traversal Status

**All three NAT components are stubs** — no actual network operations:
- `AutoNat`: tracks `NatStatus` (Public/Private/Unknown) and probe
  results, but performs no dial-back protocol.
- `Dcutr`: tracks upgrade attempts, but performs no hole punching.
- `RelayService`: tracks relay configuration, but implements no Relay
  v2 protocol.

This is a known gap for production deployment.

---

## 7. Go Wire-Format Implementation

### 7.1 Overview

Module `aafp-go`, Go 1.21. ~4,600 LOC. 138+ tests, 0 failures. 8
packages + 1 CLI tool. **No QUIC transport, no ML-DSA-65 signatures**
(uses placeholder signatures for testing).

### 7.2 Packages

| Package | Purpose | LOC |
|---------|---------|-----|
| `cbor` | Canonical CBOR encoder/decoder | 490 |
| `frame` | Frame encoding/decoding | 184 |
| `frameext` | Frame extensions | 109 |
| `handshake` | Handshake structures (ClientHello, ServerHello, ClientFinished) | 332 |
| `identity` | AgentId, AgentRecord, CapabilityDescriptor | 273 |
| `errors` | Error codes and categories | 81 |
| `interop` | Rust→Go fixture verification (701 LOC of tests) | 0 (test-only) |
| `goldentrace` | Golden trace verification (17 traces) | 0 (test-only) |
| `testvectors` | Published test vector verification | 0 (test-only) |
| `versionneg` | Version negotiation matrix tests | 0 (test-only) |
| `racestress` | Concurrency/race detector tests | 0 (test-only) |
| `cmd/generate_interop_fixtures` | Go→Rust fixture generator | — |

### 7.3 Go Capabilities

**Implemented:**
- Canonical CBOR encoding (byte-for-byte with Rust)
- Frame encoding/decoding (all 8 frame types)
- Handshake structure encoding
- Transcript hash computation (all 4 stages)
- Session ID derivation
- AgentRecord encoding/verification
- RPC message encoding/decoding
- Error code classification
- Extension encoding/decoding
- Version negotiation behavior

**Not implemented:**
- QUIC transport (no network layer)
- ML-DSA-65 signatures (placeholder only)
- Live handshake over network
- Discovery protocol over network

### 7.4 Go-Specific Tests

- **RFC Rev 4 conformance** (`rev4_conformance_test.go`): 7 tests for
  SA-0001 (metadata always present) and SA-0002 (empty map key-type).
- **RFC Rev 5 conformance** (`rev5_conformance_test.go`): 4 tests for
  SA-0003 (30-day expiry is warning, not rejection).
- **Race/stress** (`racestress_test.go`): 8 concurrent tests with Go
  race detector (16–32 goroutines × 25–200 iterations).

---

## 8. Testing, Conformance, and Interop

### 8.1 Test Counts

| Implementation | Tests | Failures |
|---------------|-------|----------|
| Rust workspace | 554 | 0 |
| Go packages | 138+ | 0 |
| **Total** | **692+** | **0** |

### 8.2 Rust Test Breakdown

| Crate | Tests | Type |
|-------|-------|------|
| aafp-cbor | ~20 | Unit |
| aafp-core | 8 | Unit |
| aafp-crypto | 77 | Unit + comprehensive |
| aafp-identity | 36 | Unit |
| aafp-messaging | 47 | Unit |
| aafp-discovery | 29 | Unit |
| aafp-nat | 13 | Unit |
| aafp-transport-quic | 5 | Unit |
| aafp-sdk | 8 | Unit + e2e handshake |
| aafp-conformance | ~200 | Conformance |
| aafp-tests | 8 | Integration |
| aafp-benchmark | 1 | Placeholder |

### 8.3 Conformance Suite (aafp-conformance)

10 modules mapping directly to RFC normative requirements:
- `adversarial` — malformed CBOR, truncated frames, oversized lengths,
  duplicate extensions, invalid state transitions, replayed handshakes,
  unknown mandatory extensions, version downgrade attempts.
- `negative` — non-canonical CBOR, duplicate map keys, invalid frames,
  oversized payloads, invalid signatures, expired records.
- `protocol_compliance` — identity, handshake, authorization invariants.
- `handshake_vectors` — canonical transcript + signature vectors.
- `test_vectors` — deterministic wire-format vectors.
- `version_negotiation` — version rejection, extension handling, frame
  criticality, transcript behavior.
- `rfc0002` through `rfc0005` — RFC-specific conformance.

### 8.4 Golden Wire Traces (17 traces)

Located at `implementations/rust/golden_traces/`. Each trace has:
- `trace.bin` — raw bytes
- `trace.hex` — hex dump with annotations
- `meta.json` — metadata (frames, transcript hashes, session ID, outcome)

| # | Name | Frames | Bytes | Outcome |
|---|------|--------|-------|---------|
| 01 | successful_handshake | 3 | 14178 | success |
| 02 | unknown_critical_extension | 2 | 5468 | failure (2005) |
| 03 | unknown_noncritical_extension | 3 | 14189 | success |
| 04 | version_mismatch | 2 | 102 | failure (8006) |
| 05 | invalid_signature | 2 | 5463 | failure (2001) |
| 06 | oversized_frame | 2 | 114 | failure (8001) |
| 07 | rpc_request_response | 2 | 114 | success |
| 08 | error_exchange | 3 | 159 | terminated |
| 09 | discovery_announce | 2 | 10815 | success |
| 10 | ping_pong | 2 | 56 | success |
| 11 | graceful_close | 1 | 48 | terminated |
| 12 | fatal_error | 1 | 79 | failure (2001) |
| 13 | nonfatal_error | 1 | 65 | non-fatal |
| 14 | capability_exchange | 2 | 123 | success |
| 15 | data_with_extension | 1 | 54 | success |
| 16 | full_handshake_with_transcripts | 3 | 14178 | success |
| 17 | fragmented_data | 2 | 69 | success |

All 17 verified by the Go implementation.

### 8.5 Interop Fixtures

Located at `implementations/go/interop_fixtures/` (generated by Rust).
37 fixtures across 7 categories: CBOR (16), frames (6), handshake (3),
AgentRecord (3), RPC (6), transcript hashes (4), session ID (1).

All 34 round-trip tests pass (Rust→Go decode + re-encode + compare).

### 8.6 Fuzzing

5 fuzz targets in `aafp-conformance`. ~10.5M iterations run, 0 crashes
after fixes.

### 8.7 Benchmarks (Criterion)

- `mldsa65_keypair`, `mldsa65_sign`, `mldsa65_verify`
- `pq_handshake_full`
- `aead_encrypt_1kb`, `aead_decrypt_1kb`
- `frame_serialize_1kb`, `frame_deserialize_1kb`
- `dht_put`, `dht_get_100_agents`
- `agent_record_create`, `agent_record_verify`

---

## 9. Design History and Evolution

### 9.1 Origin

AAFP originated from a feasibility study
(`AAFP_Research_Report.md`, not in this repo) evaluating whether to
build an agent-native P2P protocol by forking rust-libp2p. The study
compared three architectures:

| Architecture | Description | Weighted Score |
|-------------|-------------|----------------|
| A (Conservative) | Light fork, Noise + Ed25519 | 6.15 |
| **B (Aggressive)** | Heavy fork, PQ + capability DHT | **7.75** |
| C (Clean-slate) | From scratch | 7.35 |

**Architecture B was selected.** It retains libp2p's
Transport/Swarm/NetworkBehaviour abstractions and DCUtR NAT traversal
concepts while replacing the cryptography, identity, and discovery
layers.

### 9.2 Phase Timeline

| Phase | Focus | Outcome |
|-------|-------|---------|
| Research | Feasibility, technology survey, architecture selection | Architecture B chosen |
| MVP (v0.1) | 100-agent single-machine test, basic QUIC + PQ | Functional prototype |
| Phase 2 | RFC-driven redesign, wire format specification | RFCs 0001–0006 published (Rev 1) |
| Review 1/2 | Primary-source verification, issue identification | 6 Critical + 12 High issues found |
| Amendment 1 | Fix Critical/High issues | 18 amendments applied (Rev 2) |
| Review 3/4 | Independent spec review + threat model | 4 Critical interop bugs + 9 normative gaps |
| Amendment 2 | Fix interop bugs + close normative gaps | 13 amendments applied (Rev 3) |
| Phase C/D | Stabilization + P0 implementation | 545 tests, 0 warnings, pqcrypto migration, handshake state machine, identity enforcement |
| Red Team | Architectural review of frozen candidate | 15 findings (3 Critical, 7 High, 5 Medium) |
| Phase E | Protocol candidate validation | 554 tests, ALPN, ERROR/CLOSE frames, 17 golden traces, Go conformance |
| **Current** | **Pre-v1.0-rc1** | **Freeze candidate ready** |

### 9.3 Key Architectural Decisions (One-Way Doors)

These decisions are extremely expensive to reverse (would require v2
wire break):

1. **Integer CBOR keys** — All AAFP CBOR maps use integer keys, not
   string keys. Chosen for compact encoding.
2. **Transcript hash construction** — Running SHA-256, TLS 1.3 model,
   initialized from TLS channel binding.
3. **Extension format** — 8-byte header per extension with 16-bit type,
   1-bit critical flag, 32-bit data length.
4. **RPC params type** — `any` (direct CBOR decoding, not nested
   CBOR-in-bytes).
5. **TLS channel binding in transcript** — Binds application handshake
   to TLS session, prevents relay attacks.
6. **Domain separator strings** — `"aafp-v1-handshake"`,
   `"aafp-v1-record"`, `"aafp-v1-ucan"`.
7. **`expires_at` as required field** — All hello messages and records
   must include expiry.
8. **`key_algorithm` as required field** — All hello messages and
   records must specify signature algorithm.

### 9.4 Rejected Alternatives

| Decision | Rejected | Reason |
|----------|----------|--------|
| Transport | TCP + Noise (libp2p default) | 2.5 RTT, no 0-RTT, no PQ |
| Transport | ant-quic (pure-PQ QUIC) | Loses ecosystem compatibility |
| Security | Pure classical (Ed25519 + X25519) | Quantum-vulnerable |
| Security | Pure PQ (ML-KEM-768 only) | No classical fallback |
| Signatures | SLH-DSA-128s for operational | Too slow (~10ms sign, 7.8KB sig) |
| Discovery | Flat Kademlia | Churn-fragile at billion scale |
| Discovery | DNS-based | Doesn't scale to billion agents |

---

## 10. Open Issues and Red-Team Findings

### 10.1 Red-Team Summary

The architectural red-team review
(`ARCHITECTURAL_RED_TEAM_REVIEW.md`) found 15 issues. **Important
context:** This review was conducted against the pre-amendment
specification. Several findings have since been addressed by
AMENDMENTS-0002 (Rev 3) or are documented as known limitations. The
remaining open items are listed below.

### 10.2 Rev 6 Categorization

The red-team findings have been reclassified into two categories for
the Rev 6 implementation plan
([`docs/REV6_IMPLEMENTATION_PLAN.md`](REV6_IMPLEMENTATION_PLAN.md)):

**Category A — Rev 6 Protocol Amendments (Specification Correctness):**
Issues that cause implementation divergence, signature incompatibility,
replay attacks, downgrade risk, memory exhaustion, or MITM ambiguity.
These MUST be resolved before the specification is declared stable.
Note: 7 of 10 Category A items (A-1 through A-7) have been implemented
and pass local conformance tests. 3 remain pending (A-8 through A-10).

**Category B — Post-v1 Enhancements (Implementation Milestones):**
Significant implementation work required for a deployable v1 product
but not for specification freeze. Tracked separately so specification
freeze is not gated on implementation work.

### 10.3 Findings Status (Rev 6 Categorized)

| Red-Team ID | Rev 6 ID | Category | Description | Status |
|-------------|----------|----------|-------------|--------|
| C-1 | A-1 | Protocol Blocker | RPC params encoding ambiguity | **DONE** — params defaults to empty map, null rejected |
| C-3 | A-4 | Protocol Blocker | Session ID not bound to server identity | **DONE** — server_agent_id in HKDF input |
| H-1 | A-3 | Protocol Blocker | AgentRecord replay (no monotonic version) | **DONE** — record_version (key 10) added |
| H-3 | A-5 | Protocol Blocker | Frame extension length unbounded | **DONE** — 64 KiB limit, checked before allocation |
| H-6 | A-6 | Protocol Blocker | Handshake state machine not normative | **DONE** — normative state machine in RFC-0002 §5.10; Rust + Go impls + 90+ tests |
| H-7 | A-7 | Protocol Blocker | Extension processing before sig verification | **DONE** — 20-phase normative pipeline in RFC-0002 §6.5; Rust + Go impls + 88+ tests |
| M-3 | A-8 | Protocol Blocker | CLOSE frame semantics underspecified | **PENDING** — full edge-case spec |
| M-5 | A-9 | Protocol Blocker | Nonce reuse detection not specified | **PENDING** — 5-min retention guidance |
| (new) | A-2 | Protocol Blocker | Optional field encoding (null vs omitted) | **DONE** — omit-when-absent, null rejected |
| (new) | A-10 | Protocol Blocker | Cross-signature verification (Go ML-DSA-65) | **PENDING** — Go impl gap |
| C-2 | B-1 | Post-v1 Enhancement | Revocation mechanism | **Deferred** — new feature, not spec fix |
| H-2 | — | Accepted limitation | CapabilityDescriptor frozen at 2 fields | Use metadata map for evolution |
| H-4 | — | Accepted limitation | UCAN lacks forward secrecy | Advise external timestamping |
| H-5 | — | Mitigated | No capability versioning | Use metadata key convention |
| M-1 | — | Accepted (v2) | AgentId hash agility | Requires v2 protocol version |
| M-2 | — | Deferred | No stream prioritization | Optional extension |
| M-4 | — | Addressed | ERROR data field unbounded | 4096-byte limit in Security Considerations |
| (new) | B-2 | Post-v1 Enhancement | Discovery persistence | Implementation milestone |
| (new) | B-3 | Post-v1 Enhancement | PubSub | New feature, needs RFC |
| (new) | B-4 | Post-v1 Enhancement | NAT traversal | Implementation milestone |
| (new) | B-5 | Post-v1 Enhancement | CI/CD | Engineering practice |
| (new) | B-6 | Post-v1 Enhancement | Performance validation | Implementation milestone |

### 10.4 Release Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Two independent implementations | **MET** (Rust + Go) |
| 2 | Bidirectional wire interop | **MET** (17 traces + 34 fixtures) |
| 3 | Cross-signature verification | **NOT MET** (Go lacks ML-DSA-65 → A-10) |
| 4 | Published test vectors | **MET** |
| 5 | Published golden traces | **MET** (17 traces) |
| 6 | No unresolved ambiguities | **NOT MET** (A-8 pending; A-6 resolved) |
| 7 | No security-critical issues | **NOT MET** (A-9 pending; A-3, A-4, A-5, A-7 resolved) |
| 8 | Conformance suite passing | **MET** (554 + 138 tests) |
| 9 | Performance targets | **NOT MET** (network perf untested → B-6) |
| 10 | Supply-chain review | **MET** (pqcrypto migrated to fips204) |

**5 of 10 met.** The Rev 6 Category A items (A-1 through A-10) close
criteria #3, #6, and #7. Category B items (B-5, B-6) close #9.
Criterion #6 and #7 are reclassified from "MET" to "NOT MET" because
the red-team findings (now categorized as Protocol Blockers) represent
unresolved ambiguities and security issues that must be fixed before
the specification is truly stable.

### 10.5 Implementation Status Summary

| Area | Status |
|------|--------|
| **Implemented** | Frame format, CBOR encoding, handshake structures, ML-DSA-65 (Rust), AEAD, HKDF, transcript hash, session ID, ALPN, ERROR/CLOSE frames, Session state machine, AgentRecord, CapabilityDescriptor, UCAN structures, discovery DHT (in-memory), Go wire-format encoding |
| **Partially implemented** | Handshake over QUIC (Rust only, no Go), SDK client/server (echo-only server), discovery (no network RPC), NAT traversal (stubs only) |
| **Deferred to v2** | AgentId hash agility (M-1), distributed Kademlia DHT, 0-RTT resumption, connection migration, gossipsub, hierarchical regional clustering, onion routing |
| **Known limitations** | No revocation (B-1), no UCAN forward secrecy (H-4), CapabilityDescriptor frozen at 2 fields (H-2), TOFU MITM on first connection, no Sybil resistance, no network partition tolerance |
| **Security assumptions** | TLS channel binding is reliable (no fallback paths), ML-DSA-65 is secure (FIPS 204), SHA-256 is collision-resistant, bootstrap nodes are not malicious, OS key storage is secure |
| **Operational readiness** | NOT PRODUCTION-READY. Specification has 10 pending protocol blockers (Category A). Implementation has stubs for NAT traversal, PubSub, and persistent discovery. No CI. No performance validation. |
| **Threat model** | Decentralized trust (no CA), TOFU for TLS certificates, self-attested agent identity, 30-day max AgentRecord expiry, UCAN max depth 8, bootstrap nodes trusted by configuration only |
| **Release checklist** | See [`docs/REV6_IMPLEMENTATION_PLAN.md`](REV6_IMPLEMENTATION_PLAN.md) §Acceptance Criteria |
| **Deployment checklist** | (Not yet defined — requires Category B completion) |

---

## 11. Build, Test, and Verification Commands

### 11.1 Rust

```bash
cd implementations/rust

# Format check
cargo fmt --all -- --check

# Build (all crates)
cargo build --workspace

# Lint
cargo clippy --workspace

# Test (all 554 tests)
cargo test --workspace

# Run benchmarks
cargo bench --workspace

# Generate golden traces
cargo run --bin generate_golden_traces
cargo run --bin generate_traces
cargo run --bin generate_vectors
cargo run --bin generate_interop_fixtures

# Verify Go-generated fixtures
cargo run --bin verify_go_fixtures
```

### 11.2 Go

```bash
cd implementations/go

# Test all packages
go test ./...

# Test with race detector
go test -race ./...

# Generate Go→Rust interop fixtures
go run ./cmd/generate_interop_fixtures
```

### 11.3 Verification Matrix

| Check | Command | Expected Result |
|-------|---------|-----------------|
| Rust format | `cargo fmt --all -- --check` | 0 diffs |
| Rust build | `cargo build --workspace` | 0 warnings |
| Rust clippy | `cargo clippy --workspace` | 0 lints |
| Rust tests | `cargo test --workspace` | 554 pass, 0 fail |
| Go tests | `go test ./...` | 7 packages pass, 0 fail |
| Golden traces | `go test ./goldentrace/` | 17/17 pass |

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| AAFP | Agent-Agent First Networking Protocol |
| AgentId | SHA-256(ML-DSA-65 public key), 32 bytes |
| AgentRecord | Self-signed CBOR record advertising an agent's capabilities and endpoints |
| AEAD | Authenticated Encryption with Associated Data |
| ALPN | Application-Layer Protocol Negotiation (TLS extension) |
| CapabilityDescriptor | Name + metadata map describing an agent capability |
| CBOR | Concise Binary Object Representation (RFC 8949) |
| DCUtR | Direct Connection Upgrade through Relay |
| HKDF | HMAC-based Key Derivation Function (RFC 5869) |
| KEX | Key Exchange |
| ML-DSA-65 | Module-Lattice Digital Signature Algorithm, security level 3 (FIPS 204) |
| ML-KEM-768 | Module-Lattice Key Encapsulation Mechanism, security level 3 (FIPS 203) |
| PQ | Post-Quantum |
| QUIC | Quick UDP Internet Connections (RFC 9000) |
| Session | AAFP connection state machine (Connecting → ... → Closed) |
| TOFU | Trust On First Use |
| Transcript Hash | Running SHA-256 over handshake messages, initialized from TLS binding |
| UCAN | User Controlled Authorization Networks (capability delegation) |
| X25519MLKEM768 | Hybrid PQ key exchange (classical X25519 + ML-KEM-768) |

---

## 13. Recommended Next Actions

**Full plan:** [`docs/REV6_IMPLEMENTATION_PLAN.md`](REV6_IMPLEMENTATION_PLAN.md)

The Rev 6 plan separates work into two categories to ensure
specification freeze is not gated on implementation work:

- **Category A (10 items):** v1 Protocol Blockers — specification
  correctness issues that MUST be resolved before the spec is stable.
- **Category B (6 items):** Post-v1 Enhancements — implementation
  milestones required for deployment but not for specification freeze.

### 13.1 Phase F-1: Specification Amendments (Category A)

Draft AMENDMENTS-0003.md and update RFCs to Revision 6:

1. **A-1: RPC encoding** — normatively define `params` as exactly one
   canonical CBOR item (not nested, not JSON, not text).
2. **A-2: Optional field encoding** — if absent, field MUST be omitted
   (NOT `null`); if present, MUST contain typed value.
3. **A-3: AgentRecord replay protection** — add `record_version`
   (monotonic uint64) as field 10; reject older versions.
4. **A-4: Session ID binding** — bind to server AgentId in HKDF input.
5. **A-5: Frame extension limits** — normative 64 KiB max per
   extension and total; reject before allocation.
6. **A-6: Handshake state machine** — **DONE.** Normative state machine
   added to RFC-0002 §5.10 (9 client + 9 server states, transition tables,
   timeout spec, duplicate handling, frame disposition matrix, close
   semantics). Implemented in Rust (`aafp-core::handshake_state`) and Go
   (`handshake/state_machine.go`) with 90+ tests including 100K-iteration
   property tests.
7. **A-7: Extension processing order** — DONE. 20-phase normative
   processing pipeline added to RFC-0002 §6.5. Extension semantics
   execute only in Phase 18, after signature verification (Phase 10),
   AgentId binding (Phase 11), session validation (Phase 12),
   authorization (Phase 13), and capability checks (Phase 14).
   Implemented in Rust (`aafp-messaging::pipeline`) and Go
   (`pipeline/pipeline.go`) with 88+ tests including conformance,
   adversarial, and differential test vectors.
8. **A-8: CLOSE semantics** — graceful close, error close, timeout,
   peer disappearance, duplicate CLOSE, ERROR after CLOSE,
   half-closed streams.
9. **A-9: Nonce reuse detection** — 5-minute retention, error 2008
   on duplicate.
10. **A-10: Cross-signature verification** — implement ML-DSA-65 in
    Go; cross-verify both directions.

### 13.2 Phase F-2: Implementation (Category A)

1. Update Rust implementation to match Rev 6 exactly.
2. Update Go implementation to match Rev 6 exactly.
3. Add Go ML-DSA-65 (A-10).
4. Generate new golden traces and interop fixtures.
5. Add conformance tests for every new normative requirement.
6. Run all tests; fix failures.

### 13.3 Phase F-3: Validation

1. Cross-signature verification (Rust ↔ Go).
2. Full interop test suite.
3. Fuzz testing with new edge cases.
4. Declare specification stable (Rev 6).

### 13.4 Phase F-4: Post-v1 Implementation (Category B)

Tracked separately. Not gated on specification freeze. Can proceed in
parallel with F-2/F-3 where dependencies allow:

1. **B-1: Revocation** — RevocationRecord object, bootstrap storage,
   propagation.
2. **B-2: Discovery persistence** — embedded database (SQLite/RocksDB).
3. **B-3: PubSub** — publish, subscribe, unsubscribe, duplicate
   suppression.
4. **B-4: NAT traversal** — AutoNAT, Relay v2, DCUtR, interop test.
5. **B-5: CI/CD** — GitHub Actions (Rust, Go, interop, fuzz, clippy,
   race detector, golden traces).
6. **B-6: Performance validation** — handshake latency, throughput,
   memory, concurrent peers, DHT operations.

### 13.5 Long-term (v2 considerations)

1. **AgentId hash agility** (M-1) — plan migration path if SHA-256
   needs replacement.
2. **Distributed Kademlia DHT** — replacing in-memory DHT for scale.
3. **0-RTT session resumption** — HQRT-style PQ 0-RTT.
4. **Connection migration** — QUIC CID-based.
5. **Gossipsub** — for PubSub and liveness propagation.
6. **Hierarchical regional clustering** — inter-cluster super-peer DHT.

---

## Appendix A: Key File Index

### Specification
- `RFCs/0001-protocol-overview.md` — Architecture, trust model, security limitations
- `RFCs/0002-transport-framing.md` — Frame format, handshake, extensions, streams
- `RFCs/0003-identity-authentication.md` — AgentId, AgentRecord, UCAN, capabilities
- `RFCs/0004-discovery.md` — Bootstrap, DHT, regional, PEX
- `RFCs/0005-error-model.md` — Error codes, ERROR/CLOSE frames
- `RFCs/0006-versioning-compatibility.md` — Versioning, extension registry, conformance

### Rust Implementation (key files)
- `implementations/rust/Cargo.toml` — Workspace manifest
- `crates/aafp-crypto/src/handshake_v1.rs` — v1 handshake (1218 lines)
- `crates/aafp-crypto/src/dsa.rs` — ML-DSA-65 wrapper
- `crates/aafp-crypto/src/aead.rs` — ChaCha20-Poly1305 / AES-256-GCM
- `crates/aafp-identity/src/identity_v1.rs` — AgentRecord, CapabilityDescriptor
- `crates/aafp-core/src/session.rs` — Session state machine
- `crates/aafp-transport-quic/src/config.rs` — QUIC/TLS config, ALPN
- `crates/aafp-transport-quic/src/transport.rs` — QuicTransport
- `crates/aafp-messaging/src/framing.rs` — Frame encode/decode
- `crates/aafp-sdk/src/handshake_driver.rs` — Handshake orchestration
- `crates/aafp-sdk/src/protocol_frames.rs` — ERROR/CLOSE frame transmission
- `crates/aafp-sdk/src/client.rs` — AgentClient
- `crates/aafp-sdk/src/server.rs` — AgentServer

### Go Implementation (key files)
- `implementations/go/cbor/cbor.go` — Canonical CBOR
- `implementations/go/frame/frame.go` — Frame encoding
- `implementations/go/handshake/handshake.go` — Handshake structures
- `implementations/go/identity/identity.go` — AgentId, AgentRecord
- `implementations/go/interop/interop_test.go` — Rust→Go verification

### Status Reports
- `docs/REV6_IMPLEMENTATION_PLAN.md` — Rev 6 plan with v1-blocker/post-v1 categorization
- `docs/status/PHASE_E_REPORT.md` — Protocol candidate validation (current)
- `docs/status/STABILIZATION_REPORT.md` — Post-Phase C stabilization
- `docs/status/PHASE2_STATUS_REPORT.md` — Pre-stabilization assessment
- `ARCHITECTURAL_RED_TEAM_REVIEW.md` — 15 findings (3 Critical, 7 High, 5 Medium)
- `RED_TEAM_EXECUTIVE_SUMMARY.md` — 7 must-fix issues (pre-categorization)
- `RED_TEAM_FINDINGS_RANKED.md` — Detailed finding rankings
- `ROADMAP.md` — P0/P1 status, Rev 6 categorization, and roadmap
- `PROTOCOL_CANDIDATE_CHECKLIST.md` — Protocol candidate criteria with Rev 6 items

### Test Artifacts
- `implementations/rust/golden_traces/` — 17 canonical wire traces
- `implementations/go/interop_fixtures/` — 37 binary interop fixtures
- `crates/aafp-conformance/src/` — 10 conformance modules
- `crates/aafp-tests/tests/integration.rs` — Cross-crate integration

---

*This document was generated as a knowledge transfer artifact for the
AAFP project. It synthesizes information from the RFC series, both
implementations, all status reports, and the red-team reviews into a
single reference for a senior protocol architect.*
