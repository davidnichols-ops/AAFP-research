# AAFP Architectural Red-Team Review — Post-Phase C

**Review Date**: 2026-06-29  
**Review Type**: Architectural red-team review (wire compatibility focus)  
**Scope**: RFC-0001 through RFC-0006 (Revision 5, Freeze Candidate)  
**Assumption**: All claims in architecture documents are true unless contradicted by protocol specification  
**Focus**: Protocol mistakes requiring v2 wire break if discovered post-release

---

## Executive Summary

AAFP demonstrates strong architectural discipline. The protocol has undergone multiple review cycles (REVIEW-0001 through REVIEW-0004, AMENDMENTS-0001/0002) that addressed most critical interoperability issues. The specification is unusually complete for a pre-v1 protocol.

**CRITICAL FINDINGS (wire-breaking if unfixed): 3**  
**HIGH FINDINGS (likely wire-breaking): 7**  
**MEDIUM FINDINGS (complex migration): 5**

The most severe issues identified:

1. **CRITICAL-1**: RPC params/result encoding ambiguity — nested CBOR vs direct `any` type
2. **CRITICAL-2**: AgentRecord expiry enforcement creates revocation impossibility
3. **CRITICAL-3**: Session ID derivation timing vulnerability
4. **HIGH-1**: No replay protection for AgentRecords enables DHT poisoning
5. **HIGH-2**: CapabilityDescriptor cannot evolve without wire break
6. **HIGH-3**: Frame extension length limits future protocol design
7. **HIGH-4**: No forward secrecy for UCAN delegation chains

---

## Ranking by Wire-Break Likelihood

### CRITICAL (99%+ probability of requiring v2)

#### C-1: RPC Params Encoding Ambiguity

**Location**: RFC-0002 §4.3, RFC-0004 §3.3  
**Impact**: Independent implementations will produce non-interoperable RPC calls

**Problem**: RFC-0002 §4.3 defines `RpcRequest.params` as:
```cbor
3: any,  // "params": Method parameters (CBOR any type)
```

But RFC-0004 §3.3 shows method-specific structures:
```cbor
// aafp.discovery.announce params
{
    1: AgentRecord,    // "record": The agent's AgentRecord
}
```

**The ambiguity**: Is the `params` field:
- (a) A CBOR map with method-specific integer keys (the `any` decodes directly to the structure), OR
- (b) A CBOR byte string containing a nested CBOR-encoded structure (double encoding)?

**Why this matters**:
- Option (a): `params` at position 3 in RpcRequest decodes directly to a map `{1: AgentRecord}`. CBOR decoding stops at the map boundary.
- Option (b): `params` at position 3 decodes to `bstr`, then that byte string is decoded as CBOR to get `{1: AgentRecord}`. This is nested/double encoding.

The RFC-0002 §8.3 note says "RPC params and results use CBOR `any` type" but doesn't clarify whether this is direct or nested.

**Test for wire incompatibility**: An implementer following RFC-0004 literally would encode:
```
RpcRequest = {
    1: uint (id),
    2: tstr (method),
    3: {1: AgentRecord}  // Direct map
}
```

Another implementer interpreting "CBOR any" as nested would encode:
```
RpcRequest = {
    1: uint (id),
    2: tstr (method),
    3: bstr(cbor_encode({1: AgentRecord}))  // Nested
}
```

These produce different wire formats and cannot interoperate.

**Why not caught earlier**: The Rust implementation likely uses direct encoding (serde_cbor with `#[serde(flatten)]` or similar), and the Go implementation hasn't implemented RPC yet. Once Go implements RPC from the spec alone, this will manifest as deserialization failures.

**Recommendation**: Add normative text to RFC-0002 §4.3:
> The `params` field (key 3) is CBOR `any` type, meaning it decodes directly to the method-specific structure. It is NOT nested CBOR (not a byte string containing CBOR). The RPC frame's payload contains the RpcRequest map, and the `params` field within that map IS the method-specific structure, decoded in place. This is single-level CBOR encoding, not nested.

**Wire break if fixed post-v1**: YES. Changing from direct to nested (or vice versa) invalidates all existing RPC calls.

---

#### C-2: AgentRecord Expiry Creates Revocation Impossibility

**Location**: RFC-0003 §3.6, §3.7  
**Impact**: Protocol structurally prevents revocation mechanism

**Problem**: RFC-0003 §3.6 says:
> Check that `expires_at > current_time`. If expired, reject with error code 2002 (IDENTITY_EXPIRED).

AMENDMENTS-0002 A-T3 strengthens this:
> Implementations MUST enforce a maximum AgentRecord expiry of 30 days.

But RFC-0003 §3.7 says:
> Future versions of AgentRecord MAY add new fields with integer keys ≥ 10. Implementations MUST ignore unknown fields.

**The impossibility**: Suppose v2 adds a revocation mechanism via a new field:
```cbor
AgentRecord v2 = {
    // ... existing fields 1-9 ...
    10: uint,  // "revocation_timestamp": Unix timestamp of revocation
    11: bstr,  // "revocation_signature": Proof of revocation
}
```

A v1 implementation MUST ignore fields 10-11 (per §3.7 forward compatibility rule). Therefore:
- If `expires_at` is 30 days in the future, and the key is compromised on day 1, the attacker has 29 days of validity.
- A v2 revocation field (keys ≥10) does nothing because v1 nodes ignore it.
- The v1 node cannot distinguish "revoked but not expired" from "valid".

The only way to force v1 nodes to reject a revoked record is to make them reject based on a field they understand. But there are only two rejection mechanisms in v1:
1. Signature verification failure (requires breaking the ML-DSA-65 signature, infeasible)
2. `expires_at` in the past (requires time to advance, cannot be done instantly)

**Why this is a wire break**: To fix this, v2 would need to:
- Add a "revocation_list_commitment" field in the existing 1-9 range, OR
- Change the verification semantics of an existing field (e.g., redefine `expires_at` to mean "expires_at OR revoked_at, whichever is earlier")

Both options break v1 compatibility because they change the semantics of fields that v1 implementations parse.

**Recommendation**: 
1. **Immediate**: Add a reserved field in the 1-9 range for future revocation:
   ```cbor
   AgentRecord = {
       // ... existing fields ...
       9: bstr / null,  // RESERVED for future revocation mechanism
   }
   ```
   v1 implementations MUST parse this field but MAY treat `null` as "not revoked". v2 can define non-null semantics.

2. **Specification fix**: Change RFC-0003 §3.6 to:
   > Check that `expires_at > current_time`. If expired, reject. Check that field 9 (if present and non-null) does not indicate revocation per the revocation RFC. If revoked, reject with error code 2005 (IDENTITY_REVOKED, new code).

**Wire break if fixed post-v1**: YES. Cannot add revocation without either (a) changing field semantics v1 nodes rely on, or (b) requiring v2-only networks (v1 nodes cannot verify revoked records).

---

#### C-3: Session ID Derivation Timing Vulnerability

**Location**: RFC-0002 §5.7  
**Impact**: Session fixation and potential MITM

**Problem**: RFC-0002 §5.7 specifies:
```
session_id = HKDF-Expand(
    prk  = HKDF-Extract(salt = client_nonce || server_nonce,
                        IKM  = h_after_clienthello),
    info = "aafp-session-id-v1",
    L    = 32)
```

The session_id is derived after ClientHello but before ClientFinished. The server computes it and includes it in ServerHello. The client verifies it matches after receiving ServerHello.

**The vulnerability**: `h_after_clienthello` includes:
- TLS channel binding (via `tls_binding` in the transcript hash)
- ClientHello fields (agent_id, public_key, capabilities, extensions)

But it does NOT include:
- ServerHello fields (server's agent_id, public_key, capabilities)
- The fact that ClientFinished was sent (mutual authentication confirmation)

**Attack scenario**:
1. Client connects to attacker (MITM).
2. Attacker relays ClientHello to real server.
3. Real server computes `session_id` from `h_after_clienthello` and sends ServerHello to attacker.
4. Attacker receives `session_id` and real server's ServerHello.
5. Attacker terminates TLS to real server, creates NEW TLS session to client.
6. Attacker constructs fake ServerHello with:
   - Attacker's agent_id and public_key (attacker controls)
   - The real server's `session_id` (copied from step 4)
   - Attacker's signature (attacker can sign its own messages)
7. Client receives fake ServerHello, computes its own `session_id` from `h_after_clienthello`.

**Why this might work**:
- If the attacker can create a TLS session with the client where the `tls_binding` value is predictable or manipulated, AND
- If the attacker can construct a ServerHello that makes the client's `h_after_clienthello` match the real server's `h_after_clienthello`, THEN
- The `session_id` values match, and the client accepts the attacker's ServerHello.

**Why this is mitigated (but fragile)**:
- The `tls_binding` is derived from TLS-Exporter, which is bound to the TLS session keys. The attacker cannot create the same `tls_binding` as the real server's TLS session.
- The ClientHello includes the client's agent_id, so `h_after_clienthello` includes client identity.

**But**: The session_id is NOT bound to the server's identity. If the attacker can:
- Compromise the TLS channel binding (e.g., if TLS-Exporter is not available and RFC-0002 §2.5 fallback is used),
- OR manipulate the client into accepting a different ServerHello for the same ClientHello,

Then session_id fixation is possible.

**Why this is a wire break**: To fix this properly, session_id should be derived AFTER the full handshake:
```
session_id = HKDF(salt = client_nonce || server_nonce,
                  IKM  = h_after_clientfinished)  // Full transcript
```

But this requires moving session_id OUT of ServerHello (it cannot be computed before ServerHello if it depends on ClientFinished). This changes the ServerHello wire format.

**Recommendation**:
1. **Defer session_id to post-handshake**: Do not include session_id in ServerHello. Instead, both sides compute it after ClientFinished and use it for future operations (session resumption, 0-RTT).
2. **Alternative (if session_id MUST be in ServerHello)**: Bind session_id to BOTH agents:
   ```
   IKM = h_after_clienthello || server_agent_id
   ```
   This prevents the attacker from reusing the session_id across different servers.

**Wire break if fixed post-v1**: YES. Either removes session_id from ServerHello (changes key 7) or changes derivation formula (breaks resumption).

---

### HIGH (75%+ probability of requiring v2)

#### H-1: No Replay Protection for AgentRecords

**Location**: RFC-0003 §3.2, RFC-0004 §4.3  
**Impact**: DHT poisoning via replay attacks

**Problem**: AgentRecords are self-signed with a `created_at` timestamp. RFC-0004 §4.3 says:
> If a record with the same AgentId already exists, it is replaced. The new record MUST have a `created_at` timestamp greater than or equal to the existing record's `created_at`.

But there is no monotonic counter or nonce. An attacker can:
1. Observe a valid AgentRecord with `created_at = T`.
2. Wait until the agent updates its record with `created_at = T+1`.
3. Replay the old record with `created_at = T` to a different bootstrap node.
4. The bootstrap node has never seen this AgentId, so it accepts the record.
5. The DHT now contains an outdated record for this agent.

**Attack variant**: If the agent changes its capabilities or endpoints, an attacker can replay the old record with stale capabilities, causing lookups to fail (DoS) or routing agents to the wrong endpoint.

**Why this is HIGH severity**: This enables DHT poisoning even with valid signatures. The attacker doesn't need to break ML-DSA-65, just record and replay.

**Why this requires a wire break**: To fix this, AgentRecords need either:
- (a) A monotonic version number (field in 1-9 range to force v1 implementations to parse), OR
- (b) A nonce or timestamp that is verified against a global oracle (requires new infrastructure)

**Recommendation**: Add a `version` field to AgentRecord:
```cbor
AgentRecord = {
    // ... existing fields ...
    9: uint,  // "version": Monotonic version number, starts at 1
}
```

Update verification rules:
> If a record with the same AgentId exists, the new record MUST have `version > existing.version`. If `version <= existing.version`, reject with error 4003 (RECORD_INVALID).

**Wire break**: YES. Adding a new required field in the 1-9 range changes the signature input and breaks v1 compatibility.

---

#### H-2: CapabilityDescriptor Cannot Evolve

**Location**: RFC-0003 §4.2, §4.8  
**Impact**: Future capability matching features require wire break

**Problem**: RFC-0003 §4.2 defines:
```cbor
CapabilityDescriptor = {
    1: tstr,                    // "name": capability name
    2: { *tstr => MetadataValue },  // "metadata": MUST be present, MAY be empty
}
```

RFC-0003 §4.8 says:
> Future versions of CapabilityDescriptor MAY add new fields with integer keys ≥ 3.

But RFC-0003 §3.4 says:
> The signature is computed over canonical_CBOR(fields 1-7 and field 9), excluding field 8.

And CapabilityDescriptor is embedded in AgentRecord field 4, which is covered by the AgentRecord signature.

**The problem**: If v2 adds a new field:
```cbor
CapabilityDescriptor v2 = {
    1: tstr,   // "name"
    2: map,    // "metadata"
    3: uint,   // NEW: "priority" or "cost" or "ttl"
}
```

A v1 implementation:
- Receives the AgentRecord containing this CapabilityDescriptor.
- Per RFC-0006 §6.1, it MUST ignore unknown fields.
- It verifies the AgentRecord signature over the canonical CBOR, which includes field 3.
- Signature verification SUCCEEDS (the signature covers all fields 1-9).

But when the v1 implementation RE-ENCODES the CapabilityDescriptor (e.g., to forward it or store it), it MAY omit field 3 (unknown field handling is "ignore", not "preserve").

When the v1 node re-broadcasts this AgentRecord, the signature verification FAILS (signature was over fields 1-3, but re-encoded CBOR has only fields 1-2).

**Why this is HIGH severity**: This breaks transparent forwarding of AgentRecords across v1/v2 boundaries. v1 nodes become "lossy proxies" that corrupt v2 AgentRecords.

**Why this requires a wire break**: To fix this, AgentRecords need a format that allows unknown fields to be preserved opaquely. Options:
- (a) Change signature to cover only fields 1-2 of CapabilityDescriptor (but this breaks v1 signatures), OR
- (b) Require implementations to preserve unknown fields as opaque byte strings (but this breaks the "ignore unknown fields" rule), OR
- (c) Version the CapabilityDescriptor schema and require v2 nodes to re-sign when forwarding (but this changes the AgentRecord semantics)

**Recommendation**: Accept that CapabilityDescriptor is effectively frozen at 2 fields for v1. If v2 needs new capability metadata, use:
```cbor
CapabilityDescriptor v2 = {
    1: tstr,   // "name"
    2: map,    // "metadata": Extensible metadata (use new metadata keys for v2 features)
}
```

Metadata keys can evolve without signature issues because the metadata map is already defined as string-keyed and the signature covers the entire map.

**Wire break if unfixed**: MEDIUM-HIGH. Not a breaking change to ADD fields, but breaks signature preservation across versions.

---

#### H-3: Frame Extension Length Limits Future Protocol

**Location**: RFC-0002 §3.1  
**Impact**: Cannot add large extensions in future

**Problem**: The frame header defines:
```
Extension Length: 64 bits
```

RFC-0002 §3.4 says:
> The maximum payload size is 1 MiB (1,048,576 bytes).

But there is NO specified maximum for Extension Length. An attacker can send:
```
Extension Length: 0xFFFFFFFFFFFFFFFF (2^64 - 1 bytes)
Payload Length: 0
```

A naive implementation might allocate 2^64 bytes of memory, causing immediate OOM.

**Why this is HIGH severity**: This is a DoS vector, but more importantly, it reveals that the protocol has not specified bounds for extensions. Future extensions might legitimately need large data (e.g., a future "compression-dictionary" extension with a 10MB dictionary). But if the limit is 1 MiB (copied from payload), that limits future extensibility.

**Why this requires a wire break**: To fix this post-v1, implementations need to agree on a maximum extension length. But if v1 implementations have different implicit limits (some use 1 MiB, some use 16 MiB, some have no limit), v2 cannot standardize a limit without breaking some v1 implementations.

**Recommendation**: Add normative text to RFC-0002 §6.1:
> The maximum total extension length (sum of all extensions in a frame) is 1 MiB (1,048,576 bytes), the same as the maximum payload size. Implementations MUST reject frames with Extension Length > 1,048,576 by sending an ERROR frame with code 8001 (FRAME_TOO_LARGE, fatal = true).

**Wire break**: NO, if fixed before v1 release. YES, if fixed after v1 (some implementations might have accepted >1 MiB extensions).

---

#### H-4: UCAN Delegation Lacks Forward Secrecy

**Location**: RFC-0003 §5.4, §5.5  
**Impact**: Key compromise reveals all historical delegations

**Problem**: UCAN tokens are signed with ML-DSA-65. If an agent's secret key is compromised:
- The attacker can forge NEW UCAN tokens (this is expected).
- The attacker can also forge HISTORICAL UCAN tokens with past timestamps (this is bad).

**Attack scenario**:
1. Agent A issues a UCAN token to Agent B on 2026-01-01.
2. Agent B uses the token to access resources.
3. Agent A's key is compromised on 2026-06-29.
4. Attacker forges a UCAN token with:
   - Issuer: Agent A (attacker has the key)
   - Subject: Agent B
   - Issued_at: 2026-01-01 (backdated)
   - Expires_at: 2026-12-31
   - Capabilities: ["admin", "write", "delete"] (escalated)
   - Signature: Valid (attacker signs with compromised key)
5. Agent B receives the forged token. Agent B cannot tell it's forged (signature is valid).
6. Attacker uses the forged token to claim Agent A authorized Agent B for admin access on 2026-01-01.

**Why this is HIGH severity**: This breaks non-repudiation. UCAN tokens cannot serve as audit logs because a compromised issuer can rewrite history.

**Why this requires a wire break**: To fix this, UCAN tokens need either:
- (a) A timestamp signature from a trusted timestamping authority (requires new infrastructure), OR
- (b) Inclusion in a blockchain or other append-only log (requires new infrastructure), OR
- (c) Short-lived certificates where the signing key rotates frequently (but this breaks the current AgentId model where AgentId = SHA-256(public_key))

**Recommendation**: Document this as a known limitation in RFC-0003 Security Considerations. For applications requiring non-repudiation, recommend external timestamping or blockchain anchoring.

**Wire break**: YES, if fixed by changing UCAN format. NO, if mitigated via external mechanisms.

---

#### H-5: No Protection Against Extension Downgrade

**Location**: RFC-0002 §6.4, RFC-0006 §6.2  
**Impact**: Attacker can strip security-critical extensions

**Problem**: RFC-0002 §6.4 says:
> If the client proposed an extension with `critical = true` (key 3) and the server did not accept it, [...] the server MUST send an ERROR frame with code 2005 (UNSUPPORTED_EXTENSIONS).

But this only protects against servers that don't support critical extensions. An active MITM can:
1. Intercept ClientHello with critical extension (e.g., "require-authorization").
2. Remove the critical extension from ClientHello before forwarding to server.
3. Server sees no critical extension, proceeds normally.
4. Intercept ServerHello, forward to client.
5. Client sees server did not accept the extension, but critical bit was set by MITM in step 2 (client's memory), so client SHOULD abort.

BUT: The transcript hash includes the ClientHello WITH extensions. If the MITM modifies the ClientHello, the signature verification fails (server receives different ClientHello bytes than client sent).

**Wait, this is mitigated by signatures**: The transcript hash covers ClientHello, so any modification breaks signature verification.

**Except**: The signature verification is AFTER the server has processed the ClientHello. If the server has a vulnerability in extension parsing, the attacker can exploit it before signature verification fails.

**Real issue**: Extensions are parsed BEFORE signature verification. RFC-0002 §6.4 should specify:
> Implementations MUST verify the handshake signature BEFORE processing any extensions in the handshake message.

**Recommendation**: Add to RFC-0002 §5.6:
> Implementations MUST verify the signature BEFORE processing extensions in ClientHello or ServerHello. If signature verification fails, the implementation MUST discard the message without processing extensions. This prevents extension-parsing vulnerabilities from being exploited via unsigned/modified messages.

**Wire break**: NO (implementation guidance only).

---

#### H-6: No Capability Versioning

**Location**: RFC-0003 §4.7  
**Impact**: Cannot disambiguate "inference-v1" from "inference-v2"

**Problem**: Capability names are opaque strings. If a capability evolves incompatibly (e.g., "inference" changes from GPT-3 to GPT-4 API), agents cannot distinguish versions.

**Workaround**: Use suffixed names ("inference-gpt3", "inference-gpt4"). But this is convention, not enforced by protocol.

**Why this is HIGH**: Once agents start using "inference" in production, changing it to "inference-v1" breaks existing queries. The protocol has no migration path.

**Recommendation**: Reserve a metadata key for versioning:
```cbor
CapabilityDescriptor = {
    1: "inference",  // name
    2: {
        "version": "1",  // RESERVED metadata key
        "model": "gpt-oss-120b"
    }
}
```

Add to RFC-0003 §4.5:
> The metadata key `"version"` is RESERVED for capability versioning. Implementations SHOULD include `"version": "<semver>"` in all capability descriptors. Implementations performing capability lookup SHOULD filter by version when specified.

**Wire break**: NO (uses existing metadata extension point).

---

#### H-7: Handshake State Machine Not Specified

**Location**: RFC-0002 §5, RFC-0003 §6  
**Impact**: Implementations may handle invalid state transitions differently

**Problem**: The RFCs describe the happy path (ClientHello → ServerHello → ClientFinished) but do not specify:
- What happens if ClientFinished arrives before ServerHello?
- What happens if a second ClientHello arrives after the first?
- What happens if ServerHello arrives on a stream other than stream 0?
- What happens if DATA frames arrive before handshake completes?

RFC-0002 §4.2 says:
> Receivers MUST return error `8003` (handshake on non-zero stream) if a HANDSHAKE frame is received on a stream other than 0.

But there is no state machine specification that says "MUST reject ClientFinished if not in state AWAITING_CLIENT_FINISHED".

**Why this is HIGH**: State machine divergence causes interoperability failures. Some implementations might accept out-of-order messages (async processing), while others reject them.

**Recommendation**: Add a state machine diagram to RFC-0002 §5:
```
State: INIT
  → receive ClientHello on stream 0 → AWAITING_SERVER_HELLO
State: AWAITING_SERVER_HELLO
  → send ServerHello on stream 0 → AWAITING_CLIENT_FINISHED
  → receive anything else → ERROR 2006 (HANDSHAKE_FAILED)
State: AWAITING_CLIENT_FINISHED
  → receive ClientFinished on stream 0 → AUTHENTICATED
  → receive anything else on stream 0 → ERROR 2006
  → receive HANDSHAKE frame on stream != 0 → ERROR 8003
State: AUTHENTICATED
  → receive HANDSHAKE frame on any stream → ERROR 8003
```

**Wire break**: NO (clarification only), but divergence might be treated as non-conformance.

---

### MEDIUM (50% probability or complex migration path)

#### M-1: AgentId Hash Agility Impossible

**Location**: RFC-0003 §2.2  
**Impact**: Cannot migrate away from SHA-256 without breaking all AgentIds

**Problem**: RFC-0003 §2.2 says:
> The hash function used for AgentId derivation (SHA-256) is fixed for v1. Hash function agility is an explicit future design consideration [...] NOT solved by the `key_algorithm` field.

If SHA-256 needs to be replaced (e.g., quantum attack, collision found):
- All AgentIds change (AgentId = HASH(public_key)).
- All AgentRecords need to be reissued.
- All DHT indexes need to be rebuilt.
- All peer databases need to be migrated.

**Why this is MEDIUM not HIGH**: SHA-256 is likely secure for 10+ years. But the protocol has no migration path.

**Recommendation**: RFC-0003 §2.2 already discusses this. Accept that AgentId migration requires a protocol version bump (v1 → v2) and a flag-day cutover. Document the migration procedure:
1. v2 defines `AgentId_v2 = BLAKE3(public_key)`.
2. v2 AgentRecords include both v1 and v2 AgentIds during transition.
3. DHT supports dual indexing for N months.
4. After N months, v1 AgentIds are deprecated.

**Wire break**: YES, but this is accepted as a future v2 requirement.

---

#### M-2: No Stream Prioritization

**Location**: RFC-0002 §7  
**Impact**: Cannot add QoS without wire changes

**Problem**: QUIC supports stream prioritization, but AAFP does not expose it. If future applications need QoS (e.g., prioritize control streams over bulk data), the frame format has no priority field.

**Why this is MEDIUM**: This can be added via extensions without breaking existing frames. But it requires all implementations to upgrade to support it.

**Recommendation**: Add a reserved extension type for stream priority:
```
Extension Type 0x0002: Stream Priority
Extension Data: CBOR uint (0 = lowest, 255 = highest)
```

Implementations SHOULD use QUIC stream priority mapping when this extension is present.

**Wire break**: NO (optional extension).

---

#### M-3: CLOSE Frame Semantics Underspecified

**Location**: RFC-0002 §4.5  
**Impact**: Implementations may handle half-close differently

**Problem**: RFC-0002 §4.5 says:
> After sending a CLOSE frame, the sender MUST NOT send additional frames. The receiver SHOULD send a CLOSE frame in response and then close the QUIC connection.

But it does not specify:
- How long the receiver should wait before closing the connection if the sender does not close?
- What happens if the receiver has in-flight frames when it receives CLOSE?
- Is CLOSE graceful (finish sending buffered data) or immediate (abort)?

**Why this is MEDIUM**: Different implementations might implement different close behaviors. This mostly affects cleanup, not correctness.

**Recommendation**: Add to RFC-0002 §4.5:
> After receiving a CLOSE frame, the receiver SHOULD send a CLOSE frame in response within 5 seconds. If no CLOSE response is received within 10 seconds, the sender MAY forcibly close the QUIC connection. In-flight frames MAY be flushed before closing (graceful close) or discarded (immediate close); the CLOSE frame does not distinguish between them.

**Wire break**: NO (clarification).

---

#### M-4: ERROR Frame Data Field Size Unbounded

**Location**: RFC-0005 §4.2, §9.3  
**Impact**: DoS via large error data

**Problem**: RFC-0005 §9.3 says:
> The `data` field in ERROR frames MUST NOT exceed 4096 bytes. Implementations MUST truncate or reject larger `data` fields.

But RFC-0005 §4.2 defines:
```cbor
3: bstr / null,  // "data": Optional structured error data
```

CBOR `bstr` can be up to 2^64 bytes. The 4096-byte limit is in Security Considerations, not normative requirements.

**Why this is MEDIUM**: Implementations might not enforce the limit, allowing DoS.

**Recommendation**: Move the limit to RFC-0005 §4.2:
> The `data` field (key 3) MUST NOT exceed 4096 bytes. Implementations MUST reject ERROR frames with `data` larger than 4096 bytes by closing the connection (do not send ERROR in response to ERROR).

**Wire break**: NO if fixed before v1. MAYBE if fixed after (depends on whether implementations enforced limit).

---

#### M-5: Nonce Reuse Detection Not Specified

**Location**: RFC-0002 §5.3, §5.4, RFC-0005 §3.3  
**Impact**: Implementations might not detect replay attacks

**Problem**: RFC-0005 defines error code 2008 (NONCE_REUSE) but no RFC specifies:
- How long to retain seen nonces?
- Is retention per-peer or global?
- What happens if nonce database is lost (restart)?

**Why this is MEDIUM**: This is a security feature, but the lack of specification means implementations might not implement it (treating it as optional).

**Recommendation**: Add to RFC-0002 §5.9:
> Implementations SHOULD track recently seen (agent_id, nonce) pairs to detect replay attacks. The retention window SHOULD be at least 5 minutes (longer than typical network latency). If a duplicate (agent_id, nonce) is detected within the retention window, the implementation MUST reject the ClientHello with error code 2008 (NONCE_REUSE) without performing signature verification. Nonce tracking is per-agent, not per-connection; the same agent connecting twice with the same nonce (even on different connections or to different servers) SHOULD be detected as replay.

**Wire break**: NO (implementation guidance).

---

## Cross-Cutting Concerns

### Specification Completeness

**Positive**: The RFCs are unusually complete. Most interoperability ambiguities have been addressed in AMENDMENTS-0001/0002.

**Gaps**:
- RPC params encoding (C-1) is the most glaring.
- State machine specification (H-7) is a common omission in protocol specs.
- Error handling in edge cases (M-3) often requires implementation experience to discover.

### Independent Implementation Test

**Critical test**: Implement the following in a fresh Go codebase, strictly from RFCs only (no Rust reference):
1. Encode an `RpcRequest` for `aafp.discovery.announce`.
2. Encode an `AgentRecord` and verify signature.
3. Perform a full handshake including transcript hash computation.

If these produce byte-identical wire formats with the Rust implementation, the specification is sufficient. If not, specification gaps exist.

---

## Recommendations by Priority

### IMMEDIATE (Before Protocol Freeze)

1. **Fix C-1 (RPC encoding)**: Add normative text clarifying direct vs nested CBOR.
2. **Fix C-2 (revocation)**: Add reserved field for future revocation or accept that v2 is needed.
3. **Fix C-3 (session ID)**: Either bind to server identity or defer to post-handshake.
4. **Fix H-3 (extension limits)**: Add maximum extension length.

### HIGH PRIORITY (Before Public Release)

1. **Fix H-1 (record replay)**: Add version number to AgentRecord.
2. **Fix H-2 (capability evolution)**: Document that CapabilityDescriptor fields 1-2 are frozen, use metadata for evolution.
3. **Fix H-7 (state machine)**: Add explicit state machine diagram.

### MEDIUM PRIORITY (Before v1.1)

1. **Fix M-4 (error data size)**: Make 4096-byte limit normative.
2. **Fix M-5 (nonce tracking)**: Add normative guidance on replay detection.

### ACCEPT AS LIMITATIONS

1. **H-4 (UCAN forward secrecy)**: Document as known limitation. Mitigation requires external mechanisms.
2. **M-1 (hash agility)**: Accept that migration is a v2 event.
3. **M-2 (stream priority)**: Can be added later via extensions.

---

## Conclusion

AAFP is architecturally sound and has benefited from multiple review cycles. The critical findings (C-1, C-2, C-3) are fixable before v1 release. The high-severity findings (H-1 through H-7) require careful consideration but have known solutions.

**Key risk**: RPC encoding ambiguity (C-1) is the most likely to cause independent implementation failures. This should be the top priority to clarify before declaring the protocol stable.

**Overall assessment**: With fixes to C-1, C-2, C-3, and H-3, the protocol is ready for independent implementation and interoperability testing. The remaining issues are either mitigatable via implementation guidance or acceptable as v2 evolution requirements.
