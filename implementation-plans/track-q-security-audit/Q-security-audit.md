# Track Q: Security Audit — Adversarial Testing & Attack Surface Analysis

**Priority:** HIGH
**Duration:** 2-3 weeks
**Blocked by:** Track P (identity/PKI — need trust model to audit)
**Blocks:** nothing (but informs all production deployment decisions)

---

## Problem

The AAFP protocol implements sound cryptography (ML-DSA-65 signatures,
TLS 1.3 with post-quantum KEX, ReplayCache, AEAD). But "implements the
spec correctly" is not the same as "survives real attackers." There has
been no:

1. **Adversarial testing.** No tests simulate an attacker trying to
   forge signatures, replay handshakes, exhaust resources, or crash
   the server.

2. **Fuzzing.** No fuzz testing of the CBOR decoder, frame parser,
   handshake state machine, or RPC handler. Malformed inputs could
   cause panics, memory corruption, or logic bugs.

3. **Resource exhaustion testing.** No tests for:
   - Connection flood (1000 connections/second)
   - Stream exhaustion (open 1000 streams on one connection)
   - Large frame attack (send a 1GB frame)
   - Slow loris (open connection, send data very slowly)
   - Memory exhaustion (cause the agent to allocate until OOM)

4. **Attack surface analysis.** No systematic review of:
   - What inputs does an agent accept from unauthenticated peers?
   - What happens when TLS handshake fails mid-way?
   - Can an attacker downgrade the PQ KEX?
   - Can an attacker forge an AgentId?

5. **Threat model documentation.** No documented threat model listing:
   - What assets are we protecting?
   - What are the attack surfaces?
   - What are the trust boundaries?
   - What attacks are in scope vs. out of scope?

---

## Steps

### Q1: Threat model documentation

Document the AAFP threat model.

- Create `docs/THREAT_MODEL.md`:
  - **Assets:** agent private keys, session data, message content,
    agent identity, network metadata
  - **Attack surfaces:** QUIC listener, TLS handshake, AAFP handshake,
    frame parser, CBOR decoder, RPC handler, discovery DHT, relay service
  - **Trust boundaries:** unauthenticated (pre-handshake) vs. authenticated
    (post-handshake) vs. authorized (post-authorization)
  - **In-scope attacks:** MITM, replay, forgery, resource exhaustion,
    downgrade, timing side-channel
  - **Out-of-scope:** physical access, OS compromise, supply chain
    (document but don't attempt to mitigate)
  - **Attackers:** passive eavesdropper, active MITM, malicious peer
    (authenticated but untrusted), compromised CA, relay operator

- For each attack surface, document:
  - What inputs it accepts
  - What validation it performs
  - What happens on invalid input
  - What resources it consumes

- **VERIFY:** Threat model document exists and covers all attack surfaces

### Q2: Fuzz testing infrastructure

Set up fuzz testing for all input parsers.

- Add `cargo-fuzz` or `afl.rs` as a dev dependency
- Create fuzz targets for:
  1. `fuzz_cbor_decode`: Feed random bytes to `aafp_cbor::decode()`
     - Must not panic, must return error on invalid input
  2. `fuzz_frame_decode`: Feed random bytes to frame decoder
     - Must not panic, must handle malformed headers
  3. `fuzz_handshake_frame`: Feed random bytes to `read_handshake_frame()`
     - Must not panic, must reject invalid frames
  4. `fuzz_rpc_request`: Feed random CBOR to RPC handlers
     - Must not panic, must return error on invalid request
  5. `fuzz_relay_request`: Feed random CBOR to relay RPC handler
     - Must not panic, must return error on invalid request
  6. `fuzz_discovery_request`: Feed random CBOR to discovery RPC handler
     - Must not panic, must return error on invalid request

- Run each fuzzer for at least 1 hour (or 10M iterations)
- Fix any panics, crashes, or hangs found
- Add regression tests for any bugs found
- **VERIFY:** All fuzz targets run for 1 hour without panics

KEY FILES:
  implementations/rust/crates/aafp-cbor/src/ (CBOR decoder)
  implementations/rust/crates/aafp-messaging/src/framing.rs (frame decoder)
  implementations/rust/crates/aafp-sdk/src/handshake_driver.rs (handshake frames)
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs (RPC handler)
  implementations/rust/crates/aafp-nat/src/relay_v1.rs (relay handler)

### Q3: Adversarial handshake tests

Test the AAFP handshake against attacks.

- Test: **Signature forgery**
  - Generate a random keypair, sign a ClientHello with a different key
  - Send to server → must reject (signature doesn't match public_key)

- Test: **AgentId forgery**
  - Create a ClientHello with agent_id != SHA-256(public_key)
  - Send to server → must reject (agent_id mismatch)

- Test: **Replay attack**
  - Capture a valid ClientHello, send it twice
  - Second attempt → must reject (nonce reuse in ReplayCache)

- Test: **Expired handshake**
  - Create a ClientHello with expires_at in the past
  - Send to server → must reject (expired)

- Test: **Version downgrade**
  - Create a ClientHello with protocol_version = 0 (lower than 1)
  - Send to server → must reject (version mismatch)

- Test: **MITM during handshake**
  - Attacker intercepts ClientHello, modifies a field, re-signs
  - Server → must reject (signature invalid after modification)

- Test: **TLS downgrade**
  - Attempt to negotiate a weaker TLS cipher suite
  - Must reject (rustls enforces strong ciphers, but verify)

- Test: **PQ KEX downgrade**
  - Attempt to negotiate non-PQ key exchange
  - Must reject (rustls prefer-post-quantum feature should prevent this)

- Write results to `test-results/security/handshake-attacks.json`
- **VERIFY:** All 8 handshake attacks are rejected

KEY FILES:
  implementations/rust/crates/aafp-crypto/src/handshake_v1.rs
    - verify_client_hello, verify_server_hello, verify_client_finished
  implementations/rust/crates/aafp-crypto/src/replay_cache.rs
    - ReplayCache (replay detection)
  implementations/rust/crates/aafp-sdk/src/handshake_driver.rs
    - drive_server_handshake (where attacks land)

### Q4: Resource exhaustion testing

Test AAFP against resource exhaustion attacks.

- Test: **Connection flood**
  - Open 1000 connections in 1 second
  - Measure: CPU, memory, file descriptors
  - Verify: agent stays responsive, rejects excess connections
  - Add: max_connections config (default 100)

- Test: **Stream exhaustion**
  - Open 1000 bidirectional streams on one connection
  - Measure: memory per stream, total memory
  - Verify: quinn enforces max_streams_bidi (configured in J3)
  - Add: explicit stream limit check in SDK

- Test: **Large frame attack**
  - Send a frame with payload_len = 1GB (but don't send the payload)
  - Verify: server rejects the frame header immediately
  - Current code: `if payload_len > 1024 * 1024 { return Err }` — verify this
  - Test: send a frame with payload_len = 1MB (at the limit) — should work

- Test: **Slow loris**
  - Open a connection, send 1 byte per second
  - Measure: how long until timeout? (should be max_idle_timeout = 30s)
  - Verify: connection is closed after idle timeout

- Test: **Memory exhaustion**
  - Send many large messages to fill memory
  - Measure: memory usage, does it OOM?
  - Add: backpressure mechanism (if quinn doesn't handle it)

- Test: **CPU exhaustion**
  - Send many handshake requests (ML-DSA-65 verify is CPU-intensive)
  - Measure: CPU usage, does the agent become unresponsive?
  - Add: rate limiting for handshake attempts (e.g., 10/second per IP)

- Write results to `test-results/security/resource-exhaustion.json`
- **VERIFY:** Agent survives all resource exhaustion attacks

KEY FILES:
  implementations/rust/crates/aafp-transport-quic/src/config.rs
    - QuicConfig (max_idle_timeout, stream limits)
  implementations/rust/crates/aafp-sdk/src/server.rs
    - AgentServer (accept loop — add rate limiting)
  implementations/rust/crates/aafp-messaging/src/framing.rs
    - Frame size limits

### Q5: Timing side-channel analysis

Check for timing side-channels in security-critical code.

- Test: **Signature verification timing**
  - Measure time to verify a valid signature vs. invalid signature
  - If times differ significantly, there's a side-channel
  - ML-DSA-65 verify should be constant-time (verify in aws-lc-rs)

- Test: **AgentId comparison timing**
  - Measure time to compare matching vs. non-matching AgentIds
  - Use constant-time comparison (already done? verify)

- Test: **ReplayCache lookup timing**
  - Measure time for cache hit vs. cache miss
  - If times differ, attacker can determine if a nonce was seen

- Test: **CBOR decode timing**
  - Measure time to decode valid vs. invalid CBOR
  - If times differ, attacker can use timing to probe valid prefixes

- Use `criterion` for micro-benchmarking timing differences
- If any timing side-channel is found, fix with constant-time operations
- Write results to `test-results/security/timing-analysis.json`
- **VERIFY:** No significant timing differences in security-critical paths

KEY FILES:
  implementations/rust/crates/aafp-crypto/src/dsa.rs
    - MlDsa65::verify (should be constant-time)
  implementations/rust/crates/aafp-identity/src/agent_id.rs
    - AgentId comparison (should be constant-time)
  implementations/rust/crates/aafp-crypto/src/replay_cache.rs
    - ReplayCache lookup

### Q6: Malformed input testing

Test all input parsers with edge-case inputs.

- Test: **CBOR edge cases**
  - Empty input: `[]` → must return error, not panic
  - Very deep nesting: 100 levels of arrays → must not stack overflow
  - Integer overflow: u64::MAX → must handle correctly
  - Invalid UTF-8 in strings → must return error
  - Indefinite-length items → must handle or reject
  - Duplicate map keys → must handle (last wins or error)
  - Tagged values → must handle or reject

- Test: **Frame edge cases**
  - 0-byte payload → valid? (yes, control frames can have 0 payload)
  - payload_len = 0 but ext_len = 1000 → valid? (no, but verify no panic)
  - Version = 255 → must reject
  - Frame type = 255 (unknown) → must reject
  - Truncated header (27 bytes instead of 28) → must reject, not panic

- Test: **Handshake edge cases**
  - ClientHello with empty public_key → must reject
  - ClientHello with 1951-byte public_key (1 byte short) → must reject
  - ClientHello with empty signature → must reject
  - ClientHello with capabilities = [null] → must reject or handle
  - ServerHello with session_id = all zeros → valid? (yes, but unusual)

- Test: **RPC edge cases**
  - Empty method string → must reject
  - Method = "aafp.evil.method" → must reject (unknown method)
  - Params = null → must reject
  - Params = {} (empty map) → depends on method
  - Very large params (1MB) → must reject or handle

- Write results to `test-results/security/malformed-inputs.json`
- **VERIFY:** All malformed inputs are rejected without panics

KEY FILES:
  implementations/rust/crates/aafp-cbor/src/ (CBOR decoder)
  implementations/rust/crates/aafp-messaging/src/framing.rs (frame decoder)
  implementations/rust/crates/aafp-crypto/src/handshake_v1.rs (handshake)
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs (RPC)

### Q7: Attack surface review and hardening

Systematic review of all code that handles unauthenticated input.

- Audit all code paths that execute before the AAFP handshake completes:
  - QUIC connection acceptance
  - TLS handshake (handled by rustls — verify config)
  - Frame reading (before handshake)
  - Handshake message parsing

- For each code path, verify:
  - Input validation is complete (no missing checks)
  - Error handling doesn't leak information (no "signature invalid" vs.
    "key not found" distinction that enables enumeration)
  - Resource consumption is bounded (no unbounded allocation)
  - No panics on malformed input (use Result, not unwrap/expect)

- Add `#[cfg(test)]` adversarial test module to each crate:
  - `aafp-cbor/tests/adversarial.rs`
  - `aafp-messaging/tests/adversarial.rs`
  - `aafp-crypto/tests/adversarial.rs`
  - `aafp-sdk/tests/adversarial.rs`

- Fix any issues found:
  - Replace unwrap()/expect() with proper error handling in input paths
  - Add missing input validation
  - Add rate limiting where needed
  - Add size limits where missing

- **VERIFY:** Code review complete, all issues fixed, adversarial tests pass

### Q8: Security report

Compile all security findings into a comprehensive report.

- Create `test-results/security/SECURITY_REPORT.md`:
  - Threat model summary
  - Fuzz testing results (bugs found, fixes applied)
  - Adversarial handshake test results
  - Resource exhaustion test results
  - Timing analysis results
  - Malformed input test results
  - Attack surface review findings
  - Remaining risks and recommendations
  - Comparison to OWASP guidelines where applicable

- Update `STATUS.md` with security audit results
- **VERIFY:** Comprehensive security report exists

---

## Expected Outcomes

| Capability | Before | After |
|-----------|--------|-------|
| Threat model | None | Documented |
| Fuzz testing | None | 6 fuzz targets, 1hr each |
| Adversarial tests | None | 8 handshake attack tests |
| Resource exhaustion tests | None | 6 DoS scenario tests |
| Timing analysis | None | 4 side-channel checks |
| Malformed input tests | None | 20+ edge case tests |
| Attack surface review | None | Complete, issues fixed |
| Security report | None | Comprehensive |

---

## Risks & Mitigations

1. **Fuzzing may find serious bugs.** The CBOR decoder or frame parser
   may have panics on malformed input. **Mitigation:** Fix all bugs
   found. Add regression tests. This is the point of fuzzing.

2. **Resource exhaustion may reveal missing limits.** The agent may
   not have max_connections or rate limiting. **Mitigation:** Add
   configurable limits. Default to safe values (100 connections,
   10 handshakes/second per IP).

3. **Timing side-channels may be hard to fix.** Constant-time
   comparison requires careful implementation. **Mitigation:** Use
   `subtle` crate for constant-time operations. If a side-channel
   can't be fixed, document it as a known limitation.

4. **Security review may reveal design flaws.** The trust model
   (TOFU) may be insufficient. **Mitigation:** This is why Track P
   (identity/PKI) exists. Document any trust model issues and
   reference Track P for the fix.
