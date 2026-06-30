# AAFP v1 Release-Blocker Implementation Plan (Rev 6)

**Date:** June 2026
**Predecessor:** Phase E Report (protocol freeze candidate)
**Mission:** Bring AAFP from "freeze candidate" to a production-ready v1
specification by eliminating every interoperability ambiguity and every
security issue identified during the architectural review.

---

## Categorization Principle

The 16 release blockers fall into two fundamentally different categories.
Conflating them obscures the release criteria and makes validation harder.
This plan separates them explicitly:

### Category A — v1 Protocol Blockers (Specification Correctness)

These are **protocol-specification defects**. They cause implementation
divergence, signature incompatibility, replay attacks, downgrade risk,
memory exhaustion, or MITM ambiguity. The specification is not
production-ready until every one of these is resolved. They require RFC
amendments (Revision 6) and wire-format or normative-text changes.

**No issue in this category may be marked "accepted limitation" if it
causes:**
- implementation divergence
- signature incompatibility
- replay attacks
- downgrade risk
- memory exhaustion
- MITM ambiguity

### Category B — Post-v1 Enhancements (Implementation Milestones)

These are **significant implementation work items** that are not
inherently protocol-specification blockers. They are required for a
*deployable* v1 product, but they do not represent ambiguities or
defects in the wire format or normative requirements. They can be
implemented against the frozen specification without further RFC
changes (except where noted). They should be tracked separately so
that the specification freeze is not gated on implementation work.

---

## Category A — v1 Protocol Blockers

These MUST be resolved in RFC Revision 6 before the specification is
declared stable. Each requires updates to the RFCs, both
implementations, the conformance suite, and golden vectors.

### A-1: RPC Encoding (was #1)

**Problem:** RFC-0002 §4.3 defines `RpcRequest.params` as `any` type,
but does not normatively specify the encoding depth. Different
languages can legally encode different payloads. This causes
implementation divergence.

**Required change:**
- Normatively define RPC serialization in RFC-0002 §4.3.
- `params` (key 3) MUST be exactly one canonical CBOR item.
- NOT CBOR-inside-bytes. NOT JSON. NOT text. NOT
  implementation-defined.
- Signature inputs MUST use canonical CBOR encoding.
- Receivers MUST reject: non-canonical encoding, duplicate keys,
  indefinite-length encoding.
- Add positive examples, negative examples, and cross-language vectors.

**Definition of done:** Rust and Go produce identical bytes for every
RPC fixture. Conformance tests reject all non-canonical encodings.

**RFCs affected:** RFC-0002, RFC-0004 (discovery RPC methods).

### A-2: Optional Field Encoding (was #2)

**Problem:** The spec alternates between `null` and "field omitted" for
optional fields. This changes signature bytes — two implementations
that disagree on which convention to use will produce different
transcript hashes and signatures will not verify.

**Required change:**
- Normatively define: every optional field has exactly one encoding.
- Rule: if absent, the field MUST be omitted entirely (NOT encoded as
  `null`).
- If present, the field MUST contain its typed value (e.g., `bstr` for
  `receiver_mac`).
- Update every CBOR schema in RFC-0002, RFC-0003.
- Update signature computation to reflect the omission-when-absent rule.
- Update all tests and golden vectors.

**RFCs affected:** RFC-0002 (ClientHello receiver_mac, ExtensionEntry),
RFC-0003 (AgentRecord, CapabilityDescriptor metadata).

### A-3: AgentRecord Replay Protection (was #3)

**Problem:** Old signed records can overwrite new ones in the DHT.
There is no monotonic version number, so an attacker can replay a valid
old AgentRecord to different bootstrap nodes, poisoning the DHT with
stale capabilities/endpoints.

**Required change:**
- Add `record_version` (monotonic uint64) as field 10 in AgentRecord.
- Updated AgentRecord schema:
  ```
  1: record_type
  2: agent_id
  3: public_key
  4: capabilities
  5: endpoints
  6: created_at
  7: expires_at
  8: signature
  9: key_algorithm
  10: record_version
  ```
- Verification rules: reject older versions. Equal version: accept only
  if bytes are identical; otherwise reject.
- Update DHT rules in RFC-0004.
- Update bootstrap behavior.
- Add replay tests.

**RFCs affected:** RFC-0003 (AgentRecord schema), RFC-0004 (DHT rules).

### A-4: Session ID Binding (was #5)

**Problem:** Session ID is derived from `h_after_clienthello`, which
includes only the client's identity and TLS binding — not the server's
identity. This creates a session-fixation vulnerability in degraded
scenarios (e.g., if TLS fallback paths exist).

**Required change:**
- Bind session ID to server identity.
- New HKDF input MUST include: transcript hash AND server AgentId.
- Document exact concatenation order in RFC-0002 §5.7.
- Add test vectors.
- Update both implementations.

**RFCs affected:** RFC-0002 §5.7.

### A-5: Frame Extension Limits (was #6)

**Problem:** Per-extension length and total extension length are not
normatively bounded. An attacker can send `Extension Length: 2^64 - 1`,
causing OOM before validation.

**Required change:**
- Normatively define in RFC-0002 §6.1:
  - Maximum single extension length: 64 KiB (65,536 bytes).
  - Maximum total extension section length: 64 KiB (65,536 bytes).
- Receivers MUST reject before allocation. Return error 8001
  (FRAME_TOO_LARGE).
- No dynamic allocation before length validation.
- Add fuzz tests for oversized extension lengths.

**RFCs affected:** RFC-0002 §3.4, §6.1.

### A-6: Handshake State Machine (was #7)

**Problem:** RFC-0002 §5 lacks a normative state machine. Implementations
diverge on out-of-order message handling, duplicate messages, timeouts,
and retransmission.

**Required change:**
- Add normative state machine diagram to RFC-0002 §5:
  ```
  Connecting → TLS Established → ClientHello Sent → ServerHello Verified
    → ClientFinished Sent → Authenticated → Messaging → Closing → Closed
  ```
- Specify invalid transitions and required error codes for each.
- Specify timeout behavior.
- Specify retransmission policy.
- Specify duplicate message handling.
- Implement identical logic in Rust.
- Go parser must validate transitions.

**RFCs affected:** RFC-0002 §5 (new subsection).

### A-7: Extension Processing Order (was #8) — DONE

**Problem:** Extensions may be processed before authentication, creating
a vulnerability window where extension-parsing bugs are exploitable via
unsigned messages.

**Required change:**
- Normatively specify in RFC-0002 §6.5 a 20-phase processing pipeline
  that receiver MUST execute in order:
  1. Validate frame header (version, reserved fields).
  2. Validate payload and extension lengths (reject oversized before allocation).
  3. Read payload and extension bytes.
  4. Decode and validate canonical CBOR.
  5. Validate transcript state (handshake frames).
  6. Verify signatures (ML-DSA-65 or AEAD).
  7. Verify AgentId binding.
  8. Verify session state.
  9. Verify authorization.
  10. Verify required capabilities.
  11. Decode extensions into structured objects.
  12. Check for unknown critical extensions.
  13. Check for non-negotiated extensions.
  14. Process extension semantics (ONLY in Phase 18).
  15. Validate final state.
  16. Deliver to upper layer.
- Never process extension semantics before authentication.

**Status:** DONE. 20-phase normative pipeline added to RFC-0002 §6.5.
Implemented in Rust (`aafp-messaging::pipeline`) and Go
(`pipeline/pipeline.go`). 88+ tests (conformance + adversarial +
differential). Security invariant verified: callback count = 0 for all
failures in Phases 1-17.

**RFCs affected:** RFC-0002 §6.5 (new), §9.2 (updated).

### A-8: CLOSE Semantics (was #9)

**Problem:** CLOSE frame timeout behavior, in-flight frame handling, and
edge cases (duplicate CLOSE, ERROR after CLOSE, half-closed streams) are
underspecified. Implementations handle connection cleanup differently.

**Required change:**
- Define in RFC-0002 §4.5:
  - Graceful close (sender sends CLOSE, waits for in-flight frames,
    then closes QUIC).
  - Error close (ERROR frame with fatal=true, then CLOSE, then QUIC
    close).
  - Timeout close (no response within timeout, force close).
  - Peer disappearance (QUIC connection lost without CLOSE).
  - Receiving duplicate CLOSE (ignore second).
  - Receiving ERROR after CLOSE (log, ignore).
  - Half-closed streams (finish pending streams, no new streams).

**RFCs affected:** RFC-0002 §4.5.

### A-9: Nonce Reuse Detection (was #10)

**Problem:** Error code 2008 (NONCE_REUSE) is defined but no guidance on
retention window or enforcement. Implementations may not implement
replay detection consistently.

**Required change:**
- Specify in RFC-0002 §5.3: implementations SHOULD remember
  `(client_nonce, server_nonce)` pairs for a minimum of 5 minutes.
- Duplicate pair: terminate handshake with error 2008.
- Add conformance tests for nonce reuse detection.

**RFCs affected:** RFC-0002 §5.3, RFC-0005 §3.3.

### A-10: Cross-Signature Verification (was #16)

**Problem:** Go implementation lacks ML-DSA-65, so cross-signature
verification (release criterion #3) cannot be tested. This is an
implementation completeness gap that blocks validation of the
specification's cryptographic correctness.

**Required change:**
- Implement full ML-DSA-65 verification in Go.
- Cross-verify: Rust signs → Go verifies; Go signs → Rust verifies.
- Must pass.

**RFCs affected:** None (implementation only). But blocks validation of
RFC-0003 §3.4-3.6.

---

## Category B — Post-v1 Enhancements

These are required for a *deployable* v1 product but are NOT
protocol-specification blockers. They can be implemented against the
frozen specification. They should be tracked separately so that the
specification freeze is not gated on implementation work.

### B-1: Revocation (was #4)

**Problem:** Compromised ML-DSA-65 key remains trusted until AgentRecord
expiry (max 30 days). No revocation mechanism exists.

**Classification rationale:** Revocation is a **new protocol feature**,
not a fix to an existing ambiguity. It adds new wire objects
(RevocationRecord), new RPC methods, and new node behavior. It can be
added via a future RFC amendment without breaking existing wire format.
The 30-day maximum expiry provides a bounded trust window in the
interim.

**Required change (when prioritized):**
- New `RevocationRecord` object: AgentId, revoked_key, reason, timestamp,
  sequence, signature.
- Bootstrap nodes MUST store revocations.
- Nodes MUST reject revoked records.
- Revocation MUST propagate through discovery.
- Update RFC-0003 and RFC-0004.
- Add tests.

**RFCs affected:** RFC-0003, RFC-0004 (new sections).

### B-2: Discovery Persistence (was #11)

**Problem:** DHT exists only in memory. Records are lost on restart.

**Classification rationale:** This is an implementation choice, not a
protocol-specification issue. The RFC specifies what the DHT must do
(store, retrieve, evict); it does not mandate a storage backend.

**Required change (when prioritized):**
- Implement persistent storage (SQLite, RocksDB, Badger, or equivalent).
- Records survive restart.
- Replay protection persists.
- Revocations persist (once B-1 is implemented).

**RFCs affected:** None (implementation only).

### B-3: PubSub (was #12)

**Problem:** PubSub is not implemented (in-memory stub only).

**Classification rationale:** PubSub is a new messaging feature, not a
fix to existing protocol ambiguity. The frame format and stream
multiplexing already support it; the gossipsub propagation layer is the
missing piece.

**Required change (when prioritized):**
- Implement: publish, subscribe, unsubscribe, topic advertisement,
  message IDs, duplicate suppression.

**RFCs affected:** May require a new RFC (RFC-0007 or amendment to
RFC-0002) for gossipsub protocol specification.

### B-4: NAT Traversal (was #13)

**Problem:** AutoNAT, Relay, and DCUtR are stubs. No actual NAT
traversal is implemented.

**Classification rationale:** NAT traversal is a critical *deployment*
capability but not a *protocol-specification* blocker. The relay
protocol needs its own RFC (P1-8 in the roadmap). DCUtR and AutoNAT are
implementation of existing concepts.

**Required change (when prioritized):**
- Implement AutoNAT (dial-back detection).
- Implement Relay v2 (circuit relay).
- Implement DCUtR (hole punching).
- Interop test: two peers behind NAT.

**RFCs affected:** Requires new RFC for relay protocol specification.

### B-5: CI/CD (was #14)

**Problem:** No automated CI. All testing is manual.

**Classification rationale:** CI is an engineering practice, not a
protocol concern.

**Required change (when prioritized):**
- GitHub Actions: Rust (test, clippy, fmt, audit), Go (test, race
  detector), interop, fuzz, golden trace verification.

**RFCs affected:** None.

### B-6: Performance Validation (was #15)

**Problem:** Network-level benchmarks not yet run.

**Classification rationale:** Performance is an implementation concern.
The protocol specification does not mandate specific performance
targets.

**Required change (when prioritized):**
- Benchmarks: handshake latency, throughput, memory, concurrent peers,
  discovery lookup, DHT insert.
- Publish results.

**RFCs affected:** None.

---

## Summary Table

| ID | Category | Item | Type | RFCs Affected | Blocks Spec Freeze? |
|----|----------|------|------|---------------|---------------------|
| A-1 | Protocol Blocker | RPC Encoding | Ambiguity fix | 0002, 0004 | **YES** |
| A-2 | Protocol Blocker | Optional Field Encoding | Ambiguity fix | 0002, 0003 | **YES** |
| A-3 | Protocol Blocker | AgentRecord Replay Protection | Security fix | 0003, 0004 | **YES** |
| A-4 | Protocol Blocker | Session ID Binding | Security fix | 0002 | **YES** |
| A-5 | Protocol Blocker | Frame Extension Limits | DoS fix | 0002 | **YES** |
| A-6 | Protocol Blocker | Handshake State Machine | Normative gap | 0002 | **YES** |
| A-7 | Protocol Blocker | Extension Processing Order | Security fix | 0002 | **YES** |
| A-8 | Protocol Blocker | CLOSE Semantics | Ambiguity fix | 0002 | **YES** |
| A-9 | Protocol Blocker | Nonce Reuse Detection | Security fix | 0002, 0005 | **YES** |
| A-10 | Protocol Blocker | Cross-Signature Verification | Impl completeness | None | **YES** (blocks validation) |
| B-1 | Post-v1 Enhancement | Revocation | New feature | 0003, 0004 | NO |
| B-2 | Post-v1 Enhancement | Discovery Persistence | Impl milestone | None | NO |
| B-3 | Post-v1 Enhancement | PubSub | New feature | New RFC | NO |
| B-4 | Post-v1 Enhancement | NAT Traversal | Impl milestone | New RFC | NO |
| B-5 | Post-v1 Enhancement | CI/CD | Engineering practice | None | NO |
| B-6 | Post-v1 Enhancement | Performance Validation | Impl milestone | None | NO |

---

## Deliverables

### Specification

| Deliverable | Action |
|-------------|--------|
| RFC-0002 | Update (A-1, A-2, A-4, A-5, A-6, A-7, A-8, A-9) |
| RFC-0003 | Update (A-2, A-3) |
| RFC-0004 | Update (A-1, A-3) |
| RFC-0005 | Update (A-9) |
| RFC-0006 | Update (conformance requirements) |
| AMENDMENTS-0003.md | Create (documents all Rev 6 changes) |
| RFC_CHANGELOG.md | Update (Rev 5 → Rev 6) |

### Rust Implementation

Update implementation to match Rev 6 exactly. No TODOs. No stubs for
implemented protocol pieces.

| Item | Crates Affected |
|------|----------------|
| A-1 (RPC encoding) | aafp-messaging, aafp-conformance |
| A-2 (Optional fields) | aafp-crypto, aafp-identity, aafp-messaging |
| A-3 (Replay protection) | aafp-identity, aafp-discovery, aafp-conformance |
| A-4 (Session ID binding) | aafp-crypto, aafp-sdk |
| A-5 (Extension limits) | aafp-messaging |
| A-6 (State machine) | aafp-core, aafp-sdk |
| A-7 (Extension order) | aafp-sdk, aafp-crypto |
| A-8 (CLOSE semantics) | aafp-sdk, aafp-messaging |
| A-9 (Nonce reuse) | aafp-crypto, aafp-sdk |
| A-10 (Cross-sig) | No Rust change (Go implements) |

### Go Implementation

Update wire implementation. Maintain byte-for-byte compatibility with
Rust. Generate new fixtures.

| Item | Packages Affected |
|------|-------------------|
| A-1 (RPC encoding) | cbor, handshake, interop |
| A-2 (Optional fields) | handshake, identity |
| A-3 (Replay protection) | identity |
| A-4 (Session ID binding) | handshake |
| A-5 (Extension limits) | frame, frameext |
| A-6 (State machine) | handshake (parser validation) |
| A-7 (Extension order) | handshake |
| A-8 (CLOSE semantics) | frame |
| A-9 (Nonce reuse) | handshake |
| A-10 (Cross-sig) | identity (new ML-DSA-65 dependency) |

### Tests

| Deliverable | Description |
|-------------|-------------|
| Conformance tests | Cover every new normative requirement (A-1 through A-9) |
| Golden traces | New traces for: RPC encoding, optional field omission, replay rejection, session ID binding, extension limit rejection, state machine violations, CLOSE semantics, nonce reuse |
| Cross-signature tests | Rust↔Go ML-DSA-65 signature verification (A-10) |
| All tests pass | Zero failures across both implementations |

### Documentation

| Deliverable | Action |
|-------------|--------|
| Knowledge Transfer Document | Update with Rev 6 status, categorized items, implementation status |
| PHASE_E_REPORT.md | Update with Rev 6 forward reference |

---

## Acceptance Criteria

### Specification Freeze (Category A complete)

The specification is declared Rev 6 stable only when:

- [ ] A-1: RPC encoding normatively defined; Rust and Go produce
      identical bytes for every RPC fixture
- [ ] A-2: Optional field encoding deterministic; every CBOR schema
      updated; signatures match
- [ ] A-3: AgentRecord replay protection implemented; `record_version`
      enforced; DHT rejects older versions
- [ ] A-4: Session ID bound to server identity; vectors published; both
      implementations updated
- [ ] A-5: Frame extension limits normative (64 KiB); rejection before
      allocation; fuzz tests pass
- [ ] A-6: Handshake state machine normative; all transitions specified;
      invalid transitions return correct error codes
- [x] A-7: Extension processing order normative; no extension semantics
      before authentication
- [ ] A-8: CLOSE semantics fully specified; all edge cases covered
- [ ] A-9: Nonce reuse detection specified; 5-minute retention; error
      2008 on duplicate
- [ ] A-10: Go ML-DSA-65 implemented; cross-signature verification passes
      both directions
- [ ] No unresolved interoperability ambiguities
- [ ] No failing tests
- [ ] New golden vectors generated
- [ ] Knowledge transfer document updated

### Production Readiness (Category A + Category B complete)

The project is considered v1-production-ready only when ALL of the
following are additionally true:

- [ ] B-1: Revocation implemented and tested
- [ ] B-2: Persistent DHT implemented
- [ ] B-3: PubSub implemented
- [ ] B-4: NAT traversal implemented and interop-tested
- [ ] B-5: CI operational
- [ ] B-6: Benchmarks published

**Do not declare the protocol production-ready until every acceptance
criterion above has been satisfied and validated by automated tests.**

---

## Sequencing

### Phase F-1: Specification Amendments (Category A)

1. Draft AMENDMENTS-0003.md covering A-1 through A-9.
2. Update RFCs 0002, 0003, 0004, 0005, 0006 to Revision 6.
3. Update RFC_CHANGELOG.md.
4. Review and approve amendments.

### Phase F-2: Implementation (Category A)

1. Update Rust implementation to match Rev 6.
2. Update Go implementation to match Rev 6.
3. Add Go ML-DSA-65 (A-10).
4. Generate new golden traces.
5. Generate new interop fixtures.
6. Add conformance tests for every new normative requirement.
7. Run all tests; fix failures.

### Phase F-3: Validation

1. Cross-signature verification (Rust↔Go).
2. Full interop test suite.
3. Fuzz testing with new edge cases.
4. Declare specification stable (Rev 6).

### Phase F-4: Post-v1 Implementation (Category B)

Tracked separately. Not gated on specification freeze. Can proceed in
parallel with F-2/F-3 where dependencies allow.

---

## Relationship to Existing Roadmap

This plan supersedes the P0/P1 categorization in `ROADMAP.md` for the
Rev 6 work. The existing P0 items (P0-1 through P0-7) are complete
(Phase E). The existing P1 items are reclassified:

| Existing P1 Item | Rev 6 Classification |
|-----------------|---------------------|
| P1-1 (PING/PONG) | Post-v1 (implementation, not spec) |
| P1-2 (Discovery RPC over QUIC) | Post-v1 (implementation, not spec) |
| P1-3 (CI) | B-5 (Post-v1 enhancement) |
| P1-4 (Go ML-DSA-65) | A-10 (v1 protocol blocker — blocks validation) |
| P1-5 (Performance) | B-6 (Post-v1 enhancement) |
| P1-7 (Rustdoc) | Post-v1 (documentation) |
| P1-8 (Relay protocol) | B-4 (Post-v1 enhancement, needs new RFC) |

The red-team findings (C-1 through M-5) map to Category A items as
follows:

| Red-Team Finding | Rev 6 Item |
|-----------------|------------|
| C-1 (RPC encoding) | A-1 |
| C-2 (Revocation) | B-1 (reclassified as post-v1) |
| C-3 (Session ID) | A-4 |
| H-1 (Replay) | A-3 |
| H-3 (Extension limits) | A-5 |
| H-6 (State machine) | A-6 |
| H-7 (Extension order) | A-7 |
| M-3 (CLOSE semantics) | A-8 |
| M-5 (Nonce reuse) | A-9 |

Red-team findings C-2 (revocation), H-2 (CapabilityDescriptor frozen),
H-4 (UCAN forward secrecy), H-5 (capability versioning), M-1 (hash
agility), M-2 (stream prioritization), M-4 (ERROR data limit) are
accepted as documented limitations or post-v1 items.
