# AAFP Protocol Candidate Checklist

This document defines the objective criteria for declaring AAFP v0.1
Protocol Candidate. Each requirement must be checked off before the
protocol freeze.

## Status Legend

- [x] Complete
- [ ] Not yet complete
- [~] In progress

## Wire Protocol

| Requirement | Status | Notes |
|-------------|--------|-------|
| Stable frame format (28-byte header) | [x] | RFC-0002 §3.1, implemented in aafp-messaging |
| Version negotiation via ALPN | [x] | RFC-0002 §2.2, RFC-0006 §2.2 |
| Extension rules specified | [x] | RFC-0002 §6, RFC-0006 §3 |
| Unknown-field handling rules | [x] | RFC-0006 §6 |
| Capability descriptor encoding | [x] | RFC-0003 §4 |
| Standardized error frames | [x] | RFC-0002 §4.6, RFC-0005 §3-4 |
| Reserved extension space | [x] | RFC-0006 §3.1 (0xC000–0xFFFF reserved) |
| Frame type registry | [x] | RFC-0006 §4.1 (0x01–0x08 active) |
| CBOR canonical encoding rules | [x] | RFC-0002 §8 |
| Integer key mapping table | [x] | RFC-0002 §8.4 |

## Handshake & Identity

| Requirement | Status | Notes |
|-------------|--------|-------|
| Identity verification (agent_id == SHA-256(public_key)) | [x] | Enforced in verify_client_hello/verify_server_hello |
| ML-DSA-65 signature verification | [x] | fips204 crate, FIPS 204 compliant |
| TLS channel binding (exporter) | [x] | RFC-0002 §2.5, implemented in handshake_driver |
| Transcript hash computation | [x] | RFC-0002 §5.6, implemented in TranscriptHash |
| Session ID derivation (HKDF) | [x] | RFC-0002 §5.7, implemented in derive_session_id |
| Handshake uses proper HANDSHAKE frames (0x02) | [x] | Wire-compliant in handshake_driver |
| Domain separator in signatures | [x] | "aafp-v1-handshake" prefix |
| expires_at enforcement | [x] | Checked in verify functions |
| key_algorithm field | [x] | ML-DSA-65 = 1 |

## Session Lifecycle

| Requirement | Status | Notes |
|-------------|--------|-------|
| Session state machine specified | [x] | Connecting→TransportEstablished→IdentityVerified→AuthorizationVerified→Authenticated→MessagingEnabled→Closing→Closed |
| Session lifecycle implemented | [x] | aafp-core::Session |
| Authorization abstraction complete | [x] | AuthorizationProvider trait, pluggable |
| No unauthenticated messaging path | [x] | SDK enforces MessagingEnabled state |

## Implementation Conformance

| Requirement | Status | Notes |
|-------------|--------|-------|
| Rust implementation conforms | [x] | 516 tests, 0 failures |
| Go implementation conforms | [ ] | Pending Phase C-3 |
| Rust ↔ Go authenticated interoperability | [ ] | Pending Go conformance |
| Wire compatibility tests | [ ] | Pending golden trace generation |

## Testing

| Requirement | Status | Notes |
|-------------|--------|-------|
| Protocol compliance test suite | [x] | aafp-conformance/protocol_compliance.rs |
| RFC-specific conformance tests | [x] | aafp-conformance/rfc0002-0006 |
| End-to-end handshake over QUIC | [x] | test_full_end_to_end_handshake_over_quic |
| Fuzzing of parser/framing | [x] | aafp-conformance/adversarial.rs (deterministic fuzz) |
| Property-based testing | [x] | aafp-conformance/adversarial.rs (invariants) |
| Adversarial testing (malformed inputs) | [x] | aafp-conformance/adversarial.rs (28 tests) |

## Error Model

| Requirement | Status | Notes |
|-------------|--------|-------|
| Error code registry frozen | [x] | RFC-0005 §3 (53 codes assigned) |
| Error category system | [x] | Thousands digit categorization |
| Fatal vs non-fatal semantics | [x] | RFC-0005 §4.3-4.4 |
| ERROR frame wire format | [x] | RFC-0002 §4.6 |

## Security

| Requirement | Status | Notes |
|-------------|--------|-------|
| Post-quantum signatures (ML-DSA-65) | [x] | FIPS 204 compliant |
| Post-quantum KEX (X25519MLKEM768) | [x] | RFC-0002 §2.3 |
| Channel binding prevents relay attacks | [x] | TLS exporter in transcript hash |
| Version downgrade protection | [x] | ALPN-based, TLS-integrity-protected |
| Critical extension enforcement | [x] | RFC-0006 §6.2 |

## Summary

- **Complete**: 29 items
- **Pending**: 3 items
- **In progress**: 0 items

The 3 pending items are:
1. Go implementation conformance
2. Rust ↔ Go authenticated interoperability
3. Wire compatibility tests (golden traces)

The protocol specification is complete. The remaining work is
implementation-side: porting to Go and generating golden traces
for cross-implementation validation.
