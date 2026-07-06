# AAFP Wire Protocol Future Evolution

**Document Type:** Research / Forward-Looking Analysis
**Scope:** Wire protocol (RFC-0002), versioning (RFC-0006), and future v2 considerations
**Status:** Analytical — not normative. Informs future RFC decisions.
**Date:** 2026-07-02

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current v1 Wire Protocol](#2-current-v1-wire-protocol)
   - 2.1 [Frame Format](#21-frame-format)
   - 2.2 [Frame Types](#22-frame-types)
   - 2.3 [Handshake](#23-handshake)
   - 2.4 [RPC](#24-rpc)
   - 2.5 [PubSub](#25-pubsub)
   - 2.6 [Extensions](#26-extensions)
   - 2.7 [Stream Multiplexing](#27-stream-multiplexing)
3. [Version Negotiation Mechanism](#3-version-negotiation-mechanism)
4. [Potential v2 Improvements](#4-potential-v2-improvements)
   - 4.1 [Batch Frames](#41-batch-frames)
   - 4.2 [Compressed Frames](#42-compressed-frames)
   - 4.3 [Priority Fields](#43-priority-fields)
   - 4.4 [Deadline Propagation](#44-deadline-propagation)
   - 4.5 [Trace Context in Frame Header](#45-trace-context-in-frame-header)
   - 4.6 [Bidirectional Streaming Native Support](#46-bidirectional-streaming-native-support)
   - 4.7 [Multiplexed Streams over Single QUIC Stream](#47-multiplexed-streams-over-single-quic-stream)
5. [Backward Compatibility Strategy](#5-backward-compatibility-strategy)
6. [Deprecation Policy](#6-deprecation-policy)
7. [Experimental Features via Frame Extensions](#7-experimental-features-via-frame-extensions)
8. [Impact Analysis](#8-impact-analysis)
9. [When NOT to Change the Wire Protocol](#9-when-not-to-change-the-wire-protocol)
10. [Recommendations](#10-recommendations)

---

## 1. Executive Summary

AAFP v1 defines a stable, security-first wire protocol built on QUIC
with a 28-byte fixed frame header, CBOR-encoded control messages,
ML-DSA-65 post-quantum signatures, and a 20-phase normative frame
processing pipeline. The protocol has achieved Protocol Candidate
status with two independent interoperable implementations (Rust and
Go), 326/326 conformance steps complete, and 17 golden wire traces
verified by both.

This document analyzes the current wire protocol's design and explores
how a future v2 could evolve it. The central tension is between
**wire-level efficiency** (batching, compression, priority, deadline
propagation, trace context) and **protocol simplicity** (the v1
philosophy of "keep the wire dumb, push complexity to the SDK"). Many
proposed v2 features can be achieved at the SDK or application layer
without touching the wire format. The ones that genuinely require wire
changes are those that benefit from transport-level awareness: batch
frames for head-of-line efficiency, compression negotiation, and
browser/WASM multiplexing.

The key finding: **AAFP v1's extension mechanism, reserved fields, and
ALPN-based version negotiation provide a robust foundation for v2
evolution. Most v2 features can be prototyped as v1 extensions before
requiring a wire-format-breaking v2.** A v2 should be deferred until
real-world deployment data demonstrates that SDK-level solutions are
insufficient.

---

## 2. Current v1 Wire Protocol

### 2.1 Frame Format

Every AAFP frame begins with a fixed 28-byte header (RFC-0002 §3.1):

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Version    |    FrameType  |     Flags     |  Reserved     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        Stream ID (64)                          |
+                                                               +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload Length                         |
+                                                               +
|               Payload Length (continued, 32 bits)              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Extension Length                          |
+                                                               +
|               Extension Length (continued, 32 bits)            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field             | Size    | Description |
|-------------------|---------|-------------|
| Version           | 8 bits  | AAFP protocol version (1 for v1) |
| FrameType         | 8 bits  | Frame type (see §2.2) |
| Flags             | 8 bits  | Frame-specific flags (MORE, COMPRESSED, ENCRYPTED, ACK, CRITICAL) |
| Reserved          | 8 bits  | Reserved for future use. MUST be 0. MUST be ignored by receivers. |
| Stream ID         | 64 bits | QUIC stream this frame belongs to. Stream 0 = handshake/control. |
| Payload Length    | 64 bits | Length of payload section in bytes. Max 1 MiB. |
| Extension Length  | 64 bits | Length of extension section in bytes. Max 64 KiB. |

**Key design properties:**

- **Fixed-size header**: The 28-byte header allows receivers to read
  and validate the header before allocating any buffer for payload or
  extensions. This is critical for DoS resistance (Phase 3 of the
  processing pipeline rejects oversized frames before allocation).
- **Big-endian integers**: All integer fields use network byte order.
- **Two-section body**: After the header, the frame body contains
  Extensions (Extension Length bytes) followed by Payload (Payload
  Length bytes). Extensions come first so they can be processed
  before payload semantics.
- **Maximum sizes**: Payload is capped at 1 MiB; extensions at 64 KiB.
  Larger messages must be fragmented across multiple frames using the
  `MORE` flag.
- **Reserved byte**: The 8-bit Reserved field in the header is set to
  0 by senders and ignored by receivers. This provides forward
  compatibility — a future version can assign meaning to these bits
  without breaking v1 receivers.

**Flags byte layout (RFC-0006 §5.2):**

| Bit  | Name        | Description |
|------|-------------|-------------|
| 0x80 | CRITICAL    | Frame type is critical; unknown types must error |
| 0x01 | MORE        | More fragments follow (DATA frames) |
| 0x02 | COMPRESSED  | Payload is compressed (negotiated via extension) |
| 0x04 | ENCRYPTED   | Payload is application-layer encrypted |
| 0x08 | ACK         | Frame is an acknowledgment |
| 0x10–0x40 | Reserved | MUST be 0. MUST be ignored by receivers. |

The reserved flag bits (0x10–0x40) provide additional forward
compatibility for future per-frame features.

### 2.2 Frame Types

Eight frame types are defined in v1 (RFC-0002 §4, RFC-0006 §4.1):

| Type  | Name          | Payload | Critical Default | Description |
|-------|---------------|---------|-------------------|-------------|
| 0x00  | Reserved      | —       | —                 | Not used |
| 0x01  | DATA          | Opaque bytes | No           | Application data |
| 0x02  | HANDSHAKE     | CBOR    | Yes               | Handshake messages (stream 0 only) |
| 0x03  | RPC_REQUEST   | CBOR    | No                | RPC request |
| 0x04  | RPC_RESPONSE  | CBOR    | No                | RPC response |
| 0x05  | CLOSE         | CBOR    | Yes               | Graceful connection close |
| 0x06  | ERROR         | CBOR    | Yes               | Protocol error (fatal or non-fatal) |
| 0x07  | PING          | Empty   | No                | Application-layer keepalive |
| 0x08  | PONG          | Empty   | No                | Keepalive response |
| 0x09–0x7F | Reserved  | —       | —                 | Standards-track (assigned via RFC) |
| 0x80–0xFF | Experimental | —    | —                 | No assignment needed |

**Critical bit mechanism**: The high bit of the Flags field (0x80)
indicates whether the receiver must understand the frame type. If an
unknown frame type arrives with the critical bit set, the receiver
MUST send ERROR 8004 (UNKNOWN_CRITICAL_FRAME_TYPE) and close the
connection. If the critical bit is clear, the receiver MUST skip the
frame and continue processing. This allows new frame types to be
introduced without breaking existing implementations.

### 2.3 Handshake

The AAFP handshake occurs on stream 0 after TLS completes
(RFC-0002 §5). It is a three-message exchange:

```
Client                                          Server
  |                                               |
  |  HANDSHAKE (ClientHello)                      |
  |---------------------------------------------->|
  |                                               |
  |                  HANDSHAKE (ServerHello)      |
  |<----------------------------------------------|
  |                                               |
  |  HANDSHAKE (ClientFinished)                   |
  |---------------------------------------------->|
  |                                               |
  |             Session Established                |
```

**ClientHello** (CBOR, integer keys):
- `protocol_version` (1): AAFP version (1)
- `agent_id` (2): 32-byte AgentId = SHA-256(public_key)
- `public_key` (3): ML-DSA-65 public key (1952 bytes)
- `nonce` (4): 32-byte random nonce
- `capabilities` (5): Array of CapabilityDescriptor
- `extensions` (6): Array of ExtensionEntry (handshake extension negotiation)
- `signature` (7): ML-DSA-65 signature over transcript hash
- `expires_at` (8): Unix timestamp
- `receiver_mac` (9): Optional DoS pre-verification MAC
- `key_algorithm` (10): Signature algorithm (1 = ML-DSA-65)

**ServerHello** (CBOR, integer keys):
- `protocol_version` (1): AAFP version (1)
- `agent_id` (2): 32-byte AgentId
- `public_key` (3): ML-DSA-65 public key
- `nonce` (4): 32-byte random nonce
- `capabilities` (5): Array of CapabilityDescriptor
- `extensions` (6): Accepted subset of client's proposed extensions
- `session_id` (7): HKDF-derived session identifier
- `signature` (8): ML-DSA-65 signature over transcript hash
- `expires_at` (9): Unix timestamp
- `key_algorithm` (10): Signature algorithm

**ClientFinished** (CBOR, integer keys):
- `session_id` (1): Echoed from ServerHello
- `signature` (2): ML-DSA-65 signature over full transcript hash

**Transcript hash**: A running SHA-256 hash over canonical CBOR
encodings of handshake messages, prefixed with the TLS channel binding
value (`TLS-Exporter("EXPORTER-AAFP-Channel-Binding", "", 32)`). Every
signature is computed over `"aafp-v1-handshake" || h` where `h` is the
transcript hash after the current message's CBOR has been folded in.

**Session ID derivation** (HKDF-SHA256):
```
prk = HKDF-Extract(salt = client_nonce || server_nonce, IKM = h_after_clienthello)
session_id = HKDF-Expand(prk, info = "aafp-session-id-v1", L = 32)
```

**Security properties**:
- Post-quantum signatures (ML-DSA-65, FIPS 204)
- Post-quantum KEX (X25519MLKEM768)
- TLS channel binding prevents relay attacks
- Nonce replay detection (ReplayCache, check-before-verify)
- DoS mitigation profile (optional HMAC pre-verification, ~1μs vs ~1ms)
- ALPN-based version negotiation (TLS-integrity-protected, no downgrade)

**Normative state machine**: The handshake has a complete normative
state machine (RFC-0002 §5.10) with 9 client states and 9 server
states, explicit transition tables, timeout specifications, and
unexpected-frame handling rules.

### 2.4 RPC

AAFP RPC uses two frame types (RFC-0002 §4.3–4.4):

**RPC_REQUEST (0x03)**:
```cbor
RpcRequest = {
    1: uint,    // "id": Correlation ID (unique per connection)
    2: tstr,    // "method": Method name
    3: any,     // "params": Method parameters (CBOR any type)
}
```

**RPC_RESPONSE (0x04)**:
```cbor
RpcResponse = {
    1: uint,               // "id": Matches the request ID
    2: any / null,         // "result": Result data (null if error)
    3: {                   // "error": Error object (null if success)
        1: uint,           //   "code": Error code (RFC-0005)
        2: tstr,           //   "message": Human-readable message
        3: bstr / null,    //   "data": Optional structured data
    } / null,
}
```

RPC is a simple request-response pattern. Each request has a unique
correlation ID. Responses match the request ID. There is no
streaming RPC in v1 — each request produces exactly one response.
This is a deliberate simplification: streaming can be achieved using
DATA frames on a dedicated stream, with the RPC serving as the
initial setup.

**Key observations for v2**:
- No batch support: each RPC is a separate frame, a separate QUIC
  stream, and a separate CBOR encode/decode. For high-throughput
  workloads (e.g., DHT lookups, pubsub fan-out), this means N frames
  for N requests.
- No deadline field: the request has no explicit timeout. The caller
  must manage deadlines at the application layer.
- No trace context: distributed tracing metadata must be carried in
  the `params` or via frame extensions, not in the frame header.
- No streaming: bidirectional streaming requires the application to
  open a DATA stream and manage the protocol itself.

### 2.5 PubSub

PubSub (RFC-0009) is built on top of RPC frames, not as a separate
wire-level mechanism. It defines three RPC methods:

| Method | Direction | Description |
|--------|-----------|-------------|
| `aafp.pubsub.subscribe` | Client→Server | Subscribe to a topic |
| `aafp.pubsub.unsubscribe` | Client→Server | Unsubscribe from a topic |
| `aafp.pubsub.publish` | Client→Server | Publish a message to a topic |

**Publish request**:
```cbor
{
  1: tstr,       // topic
  2: bstr,       // data: Message payload
  3: uint,       // ttl: Time-to-live (hops remaining, default 3)
  4: [ *tstr ],  // seen: List of AgentIds that have seen this message
}
```

v1 implements floodsub — published messages are forwarded to all
known peers subscribed to the same topic. A gossipsub upgrade is
documented as future work but does not require wire format changes
(it only changes propagation logic).

**Key observations for v2**:
- PubSub is entirely application-layer; the wire protocol doesn't
  know about topics or subscriptions. This is good for simplicity
  but means the wire protocol can't optimize pubsub traffic (e.g.,
  priority for control messages vs data messages).
- Each publish is a separate RPC frame. For high-throughput pubsub,
  batch frames would significantly reduce overhead.
- The `seen` list grows linearly with network size. For large
  networks, this becomes a significant payload overhead. A Bloom
  filter or compact membership structure could reduce this, but
  that's an application-layer optimization, not a wire protocol
  change.

### 2.6 Extensions

AAFP has a dual extension mechanism (RFC-0002 §6):

**Frame-level extensions** (binary, per-frame):
Each extension in the frame body's Extension section is encoded as:
```
| Extension Type (16 bits) | Critical (8 bits) | Reserved (8 bits) |
| Extension Data Length (32 bits) | Extension Data (variable)     |
```

- Extension Type: 16-bit identifier (RFC-0006 §3.1 registry)
- Critical: 0x01 = mandatory (reject if unknown), 0x00 = optional (skip if unknown)
- Multiple extensions are concatenated directly; each is self-delimiting

**Handshake-level extensions** (CBOR, session-wide):
Negotiated during the handshake via ExtensionEntry maps in
ClientHello.extensions and ServerHello.extensions. The server
accepts a subset of the client's proposals. Once negotiated, the
extension is active for the session.

**Extension type registry (RFC-0006 §3.1):**

| Range | Assignment Policy |
|-------|-------------------|
| 0x0000–0x3FFF | Standards-track (assigned via RFC) |
| 0x4000–0x7FFF | Experimental (no assignment needed) |
| 0x8000–0xBFFF | Private-use (no assignment needed) |
| 0xC000–0xFFFF | Reserved (MUST NOT be used) |

**Defined handshake extensions:**
- 0x0001: dos-mitigation (DoS pre-verification profile)
- 0x0002–0x3FFF: Reserved for standards-track

**20-phase processing pipeline** (RFC-0002 §6.5):
Every frame passes through 20 phases in strict order:
1. validate_frame_header (version, reserved)
2. validate_lengths (payload ≤ 1 MiB, extensions ≤ 64 KiB)
3. reject_oversized_before_allocation (no buffer before size check)
4. read_payload
5. read_extensions
6. decode_canonical_cbor
7. reject_duplicate_cbor_keys
8. reject_non_canonical_cbor
9. validate_transcript_state (handshake only)
10. verify_signatures (ML-DSA-65 or AEAD)
11. verify_agent_id
12. verify_session_state
13. verify_authorization
14. verify_required_capabilities
15. decode_extensions
16. check_unknown_critical_extensions
17. check_non_negotiated_extensions
18. process_extension_semantics (ONLY phase where callbacks execute)
19. validate_final_state
20. deliver_to_upper_layer

**Critical security invariant**: Extension semantics MUST NOT execute
before authentication and authorization (Phases 10–14). This prevents
forgery attacks where an unauthenticated peer triggers extension
callbacks.

### 2.7 Stream Multiplexing

AAFP maps logical streams to QUIC streams (RFC-0002 §7):

- Stream 0: Handshake and connection-level control (PING/PONG, CLOSE, fatal ERROR)
- Streams 1–2: Reserved for future use
- Streams ≥ 4 (even): Client-initiated
- Streams ≥ 5 (odd): Server-initiated

Frames within a single QUIC stream are ordered (QUIC guarantees this).
Frames across streams are NOT ordered. QUIC provides per-stream and
per-connection flow control; AAFP adds no additional flow control.

**Key observation for v2**: The 1:1 mapping between AAFP logical
streams and QUIC streams is elegant for native QUIC implementations
but problematic for browser/WASM environments where QUIC streams may
not be directly accessible (browsers expose HTTP/3, not raw QUIC).
See §4.7 for multiplexed-streams-over-single-QUIC-stream discussion.

---

## 3. Version Negotiation Mechanism

AAFP uses **TLS ALPN** for protocol version negotiation
(RFC-0002 §2.2, RFC-0006 §2.2):

- `aafp/1` → AAFP version 1
- `aafp/2` → AAFP version 2 (future)

**How v2 would be introduced:**

1. A new RFC series (e.g., RFC-0002 Revision 7 or a new RFC-0012)
   specifies the v2 wire format.
2. Implementations register the ALPN identifier `aafp/2`.
3. During TLS handshake, the client offers both `aafp/1` and `aafp/2`
   in the ALPN list. The server selects the highest version it
   supports.
4. If ALPN negotiation fails (no common version), the connection is
   closed with a TLS alert. There is no in-band version downgrade.
5. The selected ALPN identifier determines the wire format for the
   entire connection. The `Version` field in every frame header
   confirms the version (1 or 2).

**Security properties of ALPN-based negotiation:**
- **Downgrade protection**: ALPN negotiation is integrity-protected
  by TLS 1.3. An active attacker cannot modify the ALPN selection
  without being detected.
- **No fallback**: Implementations MUST NOT fall back to a lower
  version if the requested version is not supported. If no common
  version exists, the connection fails. This prevents downgrade
  attacks.
- **Per-connection version**: The version is fixed for the entire
  connection. There is no mid-connection version upgrade.

**Why ALPN and not in-band negotiation:**
In-band version negotiation (e.g., a version field in the first
frame that the receiver checks and potentially downgrades) is
vulnerable to downgrade attacks unless protected by a transcript
signature. ALPN avoids this by leveraging TLS's built-in
integrity protection. The AAFP handshake signature covers the
transcript hash, which includes the TLS channel binding, but the
ALPN selection itself is protected by TLS — no additional AAFP
mechanism is needed.

**v1 and v2 coexistence:**
An implementation that supports both v1 and v2 offers both ALPN
identifiers. The server selects the highest mutually supported
version. A v1-only implementation offers only `aafp/1`; a v2-only
implementation offers only `aafp/2`. A dual-stack implementation
offers both and processes frames according to the negotiated
version's rules.

The `Version` field in the frame header (8 bits) provides a
per-frame confirmation. A v2 receiver that receives a frame with
Version=1 knows to apply v1 rules (backward compatibility). A v1
receiver that receives a frame with Version=2 sends ERROR 8006
(INVALID_VERSION) and closes — v1 receivers cannot process v2
frames.

---

## 4. Potential v2 Improvements

This section analyzes seven candidate improvements for a future v2
wire protocol. For each, we assess:
- **What problem it solves**
- **Wire-level changes required**
- **Whether it can be done as a v1 extension instead**
- **Trade-offs and risks**

### 4.1 Batch Frames

**Problem**: In v1, each RPC request is a separate frame on a
separate QUIC stream. For workloads that issue many small RPCs
(e.g., DHT lookups, pubsub fan-out, bulk metadata queries), this
means:
- N frames × 28 bytes header overhead = 28N bytes of header
- N QUIC streams opened (each with stream-level flow control state)
- N separate CBOR encode/decode operations
- N separate frame processing pipeline executions (20 phases each)

For 1000 small RPCs with 50-byte payloads, the header overhead
alone is 28,000 bytes — a 56% overhead ratio.

**Proposed v2 feature**: A BATCH frame type (e.g., 0x09) whose
payload is a CBOR array of RpcRequest or RpcResponse objects. A
single BATCH frame on a single stream carries N RPCs:

```cbor
BatchRequest = {
    1: [ *RpcRequest ],   // Array of requests
}
```

**Wire-level changes**:
- New frame type (0x09) — can be done in v1 via the reserved
  frame type range (0x09–0x7F) with the critical bit mechanism.
- No header format change needed.

**Can it be done as a v1 extension?** Yes, partially. A new frame
type 0x09 (BATCH) can be registered in the v1 frame type registry
(RFC-0006 §4.1, range 0x09–0x7F). v1 receivers that don't understand
BATCH frames would skip them (if non-critical) or error (if
critical). However, for this to work, both peers must support the
BATCH frame type, which requires handshake capability negotiation.

**Trade-offs**:
- **Pro**: Reduces header overhead, stream creation overhead, and
  per-frame pipeline cost. Significant for high-throughput RPC
  workloads.
- **Con**: Adds complexity to the frame processing pipeline (a
  BATCH frame must be decomposed into N sub-frames, each of which
  goes through authorization and capability checks). Error handling
  is more complex (what if request 3 of 10 fails authorization?).
- **Con**: Partial failure semantics: must the entire batch fail,
  or can individual requests succeed/fail independently? This needs
  careful specification.
- **Risk**: Head-of-line blocking within a batch if the receiver
  processes requests sequentially on a single stream.

**Recommendation**: Prototype as a v1 extension (experimental frame
type 0x80–0xFF) first. If deployment data shows significant benefit,
standardize as 0x09 in a v1-compatible way (no wire format change
needed — just a new frame type). A full v2 is not required.

### 4.2 Compressed Frames

**Problem**: v1 already defines a COMPRESSED flag (0x02) in the
Flags byte and states that "the compression algorithm is negotiated
via extensions" (RFC-0002 §4.1). However, no compression extension
is currently defined. For large payloads (e.g., AgentRecord
propagation, large pubsub messages, file transfer), compression
could significantly reduce bandwidth usage.

**Current v1 support**: The wire protocol already has the hook:
- Flag bit 0x02 (COMPRESSED) is defined
- If compression was not negotiated, the receiver returns error
  8002 (unexpected compression)
- Compression algorithm negotiation would use the handshake
  extension mechanism

**Proposed v2 feature**: Define compression extensions for zstd
and lz4:
- Handshake extension type 0x0002 (compression): client proposes
  supported algorithms and levels; server selects one.
- Frame-level: the COMPRESSED flag indicates the payload is
  compressed with the negotiated algorithm.

**Wire-level changes**: None. This is entirely achievable within
v1's existing extension and flag mechanism.

**Can it be done as a v1 extension?** Yes, completely. This is
exactly what the v1 extension mechanism was designed for. The
COMPRESSED flag and the extension negotiation infrastructure already
exist. A new RFC defining the compression extension would be
sufficient.

**Trade-offs**:
- **Pro**: Significant bandwidth savings for compressible payloads
  (AgentRecords, JSON-like metadata, repetitive pubsub messages).
  zstd can achieve 3:1–10:1 compression on typical structured data.
- **Con**: CPU cost of compression/decompression. For small
  payloads (< 1 KiB), compression overhead may exceed bandwidth
  savings. A minimum payload size threshold should be defined.
- **Con**: Security: compression side-channel attacks (CRIME/BREACH
  style). If the payload contains attacker-controlled data mixed
  with secret data, compression ratios can leak information. This
  is mitigated by the fact that AAFP payloads are typically
  application-defined (not mixing attacker input with secrets in
  the same frame), but the risk must be documented.
- **Con**: The 1 MiB payload limit applies to the compressed or
  uncompressed payload? This must be clarified. If compressed, the
  effective uncompressed limit is higher, which could be a memory
  exhaustion vector (zip bomb). Recommendation: limit the
  uncompressed size, not the compressed size.

**Recommendation**: Define as a v1 extension (standards-track type
0x0002). No v2 needed. Specify a minimum payload threshold (e.g.,
compress only payloads > 256 bytes) and an uncompressed size limit
(e.g., 4 MiB max uncompressed) to mitigate zip bombs.

### 4.3 Priority Fields

**Problem**: In v1, all frames on all streams are treated equally
by the frame processing pipeline. There is no way to indicate that
a particular frame is high-priority (e.g., a cancellation RPC, a
security-critical control message) vs. low-priority (e.g., a bulk
data transfer). In a resource-constrained receiver, low-priority
frames can block high-priority frames.

QUIC itself has stream priority (via stream dependencies and
prioritization in HTTP/3), but AAFP does not expose this at the
application layer.

**Proposed v2 feature**: Add a Priority field to the frame header.
Options:
- **Option A**: Use the reserved byte (8 bits) in the v1 header as
  a priority field. This is a wire-format change but is
  backward-compatible (v1 receivers ignore the reserved byte).
- **Option B**: Use a reserved flag bit (0x10–0x40) for a 3-level
  priority (high/normal/low). This is more limited but requires
  no header change.
- **Option C**: Use a frame extension to carry priority metadata.
  No wire change, but adds per-frame extension overhead (8 bytes
  minimum for the extension header).

**Wire-level changes**:
- Option A: Repurpose the Reserved byte. v1 receivers ignore it,
  so this is forward-compatible. But v1 senders set it to 0, which
  v2 receivers would interpret as "default priority." This works.
- Option B: Use reserved flag bits. Same forward-compatibility
  argument.
- Option C: No wire change. Extension-based.

**Can it be done as a v1 extension?** Yes, via Option C (frame
extension). However, extensions are processed in Phase 18 of the
20-phase pipeline — after authentication, authorization, and
capability checks. This means the priority is not visible to the
receiver until late in processing, which limits its usefulness for
early scheduling decisions.

**Trade-offs**:
- **Pro**: Enables QoS differentiation. Critical control messages
  (cancellation, security alerts) can preempt bulk data transfers.
- **Con**: QUIC already provides stream-level prioritization. If
  AAFP maps logical streams to QUIC streams, the application can
  use QUIC's prioritization. Adding AAFP-level priority duplicates
  this.
- **Con**: Priority is a scheduling concern, not a wire protocol
  concern. The wire protocol's job is to deliver frames; the
  receiver's scheduler decides processing order. A priority field
  in the frame header is a hint, not a guarantee.
- **Risk**: Priority inversion: if a high-priority frame is on the
  same QUIC stream as a low-priority frame, QUIC's in-order
  delivery prevents the high-priority frame from being processed
  first.

**Recommendation**: Defer. Priority is better handled at the SDK
level (the application chooses which stream to send on, and QUIC
handles stream prioritization). If real-world deployment shows that
SDK-level priority is insufficient, consider Option A (repurpose the
reserved byte) in v2.

### 4.4 Deadline Propagation

**Problem**: In v1, an RPC request has no explicit deadline. The
caller manages timeouts at the application layer. If the caller
times out and cancels, the callee has no way to know the request
was cancelled — it continues processing until it completes or fails.
This wastes callee resources, especially for expensive operations
(e.g., DHT lookups, large queries).

Distributed systems benefit from deadline propagation: the caller
includes a deadline (absolute timestamp or relative duration) in
the request, and the callee can abort processing if the deadline
has passed. This is standard in gRPC (deadline propagation via
gRPC metadata), HTTP (the `Deadline` header in some frameworks),
and other RPC systems.

**Proposed v2 feature**: Add a `deadline` field to the RpcRequest
CBOR structure:

```cbor
RpcRequest = {
    1: uint,       // "id": Correlation ID
    2: tstr,       // "method": Method name
    3: any,        // "params": Method parameters
    4: uint / null, // "deadline": Unix timestamp (seconds) or null
}
```

**Wire-level changes**: None. This is a CBOR schema evolution, not
a frame header change. New CBOR fields are added with new integer
keys. v1 receivers ignore unknown keys (RFC-0006 §6.1: "Unknown
CBOR map fields → Skip (ignore)").

**Can it be done as a v1 extension?** Yes, completely. Adding a
new field to the RpcRequest CBOR map is backward-compatible:
- v1 senders: don't include the field (key 4 absent)
- v1 receivers: ignore the field if present (unknown key skipping)
- v2 senders: include the field
- v2 receivers: read the field and enforce the deadline

No wire format change, no version bump, no extension negotiation
needed. This is pure CBOR schema evolution, which v1 explicitly
supports (RFC-0002 §8.3: "New fields MAY be added to maps.
Implementations MUST ignore unknown fields unless the field is
marked critical").

**Trade-offs**:
- **Pro**: Enables callee-side deadline enforcement, reducing
  wasted work. Standard practice in distributed systems.
- **Pro**: No wire change. Can be done in v1.
- **Con**: The callee must check the deadline at each processing
  step, which adds branching overhead (minimal).
- **Con**: Clock skew between caller and callee can cause premature
  or missed deadlines. Using a relative duration instead of an
  absolute timestamp avoids clock skew but requires the callee to
  track elapsed time.

**Recommendation**: Add as a v1-compatible CBOR schema evolution.
Define key 4 (deadline) in RpcRequest as an optional field. No v2
needed. Document clock skew considerations and recommend relative
durations for short deadlines.

### 4.5 Trace Context in Frame Header

**Problem**: Distributed tracing (e.g., W3C Trace Context, OpenTelemetry)
propagates trace identifiers across service boundaries. In v1, trace
context must be carried in the RPC `params` or as a frame extension.
This is workable but has drawbacks:
- Carrying trace context in `params` pollutes the method's schema
  with tracing concerns.
- Frame extensions are processed late (Phase 18), after
  authentication. Trace context is needed early for logging and
  debugging during all phases of frame processing.
- Each frame extension has a minimum 8-byte overhead (type + critical
  + reserved + length). For a trace context (trace ID + span ID +
  flags = ~26 bytes), the total is ~34 bytes per frame.

**Proposed v2 feature**: Add trace context fields to the frame
header. Options:
- **Option A**: Use the reserved byte + reserved flag bits to carry
  a compact trace context (very limited — only 11 bits available).
- **Option B**: Add a variable-length trace context section to the
  frame header (between the fixed header and the extensions). This
  is a wire-format change.
- **Option C**: Use a frame extension with an early-processing
  exemption (process before Phase 18). This requires changing the
  processing pipeline, not the wire format.

**Wire-level changes**:
- Option A: Insufficient space for a meaningful trace context.
- Option B: Wire-format change. The frame header would need a
  Trace Context Length field, and the trace context would be placed
  after the fixed header. This breaks v1 frame parsing (v1 receivers
  expect Extensions immediately after the header).
- Option C: No wire change, but requires relaxing the processing
  pipeline's security invariant (no extension semantics before
  authentication). This is dangerous — trace context processing
  (e.g., logging) before authentication could leak information
  about frame contents to an unauthenticated peer.

**Can it be done as a v1 extension?** Yes, via frame extension.
The trace context extension (type in 0x0000–0x3FFF range, standards-
track) would carry the W3C Trace Context (traceparent + tracestate).
The drawback is that it's processed in Phase 18, after auth.

**Alternative**: Carry trace context in the RPC `params` as a
reserved key (e.g., key 99 = trace_context). This is application-
layer, requires no wire change, and no extension negotiation. The
callee extracts the trace context from params before processing the
method-specific parameters.

**Trade-offs**:
- **Pro**: First-class trace context enables observability across
  the AAFP network, which is critical for debugging distributed
  agent systems.
- **Con**: Wire-header-level trace context is a significant change
  that breaks v1 frame parsing. Not worth the complexity.
- **Con**: Extension-level trace context is processed too late for
  early-phase logging.
- **Con**: Params-level trace context pollutes method schemas but
  is the simplest approach.

**Recommendation**: Use a frame extension (v1-compatible) for trace
context. Accept that it's processed in Phase 18. For early-phase
tracing, use the stream ID and connection-level correlation (which
are available from the frame header without any extension). If
deployment shows this is insufficient, consider a v2 header change.

### 4.6 Bidirectional Streaming Native Support

**Problem**: v1 RPC is strictly request-response: one request, one
response. Bidirectional streaming (where both client and server
send a sequence of messages over a long-lived RPC) is not natively
supported. The application can achieve streaming by opening a DATA
stream and managing the protocol at the application layer, but
this means every streaming protocol is ad hoc — there's no standard
way to set up, manage, and tear down a streaming RPC.

gRPC supports four RPC patterns: unary, server-streaming, client-
streaming, and bidirectional-streaming. AAFP v1 supports only
unary.

**Proposed v2 feature**: Add streaming RPC frame types:
- `RPC_STREAM_OPEN` (0x09): Opens a streaming RPC on a stream.
  Payload: same as RpcRequest but with a stream-mode flag.
- `RPC_STREAM_DATA` (0x0A): A message in a streaming RPC. Payload:
  CBOR with the correlation ID and a message payload.
- `RPC_STREAM_CLOSE` (0x0B): Ends the streaming RPC. Payload:
  CBOR with the correlation ID and an optional error.

**Wire-level changes**: New frame types (0x09–0x0B). These can be
registered in the v1 frame type registry (0x09–0x7F range). No
header format change needed.

**Can it be done as a v1 extension?** Yes, via new frame types.
The v1 frame type registry has 0x09–0x7F reserved for standards-
track assignments. New frame types can be added without a version
bump, using the critical bit mechanism for forward compatibility.

**Alternative approach**: Use the existing DATA frame for streaming.
The RPC_REQUEST establishes the stream (method + params), and
subsequent DATA frames on the same QUIC stream carry the streaming
messages. The stream is closed with a CLOSE frame or QUIC stream
reset. This requires no new frame types — just a convention that
an RPC_REQUEST on a stream can be followed by DATA frames.

**Trade-offs**:
- **Pro**: Native streaming RPC is a standard feature in modern RPC
  systems. It enables patterns like subscription streams, chunked
  processing, and interactive protocols.
- **Pro**: Can be done without wire format changes (new frame types
  or DATA frame convention).
- **Con**: Adds complexity to the RPC model. The simple request-
  response pattern of v1 is easy to implement, test, and reason
  about. Streaming introduces flow control, partial failure, and
  cancellation concerns.
- **Con**: QUIC streams already provide bidirectional communication.
  A streaming RPC on a QUIC stream is redundant with just using
  DATA frames on the stream.
- **Risk**: If streaming RPC is added, every implementation must
  support it, increasing implementation complexity.

**Recommendation**: Use the DATA-frame-on-RPC-stream convention
first (no wire change). If deployment shows that a formal streaming
RPC protocol is needed, add frame types 0x09–0x0B as a v1-compatible
extension. A full v2 is not required.

### 4.7 Multiplexed Streams over Single QUIC Stream

**Problem**: v1 maps each AAFP logical stream to a dedicated QUIC
stream. This is elegant for native QUIC implementations but
problematic for environments where QUIC streams are not directly
accessible:

- **Browser/WASM**: Browsers expose HTTP/3 (which runs over QUIC)
  but do not expose raw QUIC streams to JavaScript. A browser-based
  AAFP client cannot open arbitrary QUIC streams.
- **HTTP/2 proxies**: Some network paths only allow HTTP/2, which
  has its own stream multiplexing. An AAFP client behind an HTTP/2
  proxy cannot use QUIC streams directly.
- **WebSocket transport**: For environments that only support
  WebSocket, all AAFP traffic must flow over a single TCP
  connection with application-layer multiplexing.

This is identified in the Protocol Candidate Checklist as a post-v1
enhancement (B-4: Browser/WASM support).

**Proposed v2 feature**: A multiplexing mode where all AAFP logical
streams are carried over a single QUIC stream (or a small pool of
QUIC streams). The AAFP Stream ID in the frame header becomes a
logical identifier, not a QUIC stream identifier. The receiver
demultiplexes frames based on the AAFP Stream ID.

**Wire-level changes**:
- The frame header already has a 64-bit Stream ID field. In v1,
  this matches the QUIC stream ID. In v2 multiplexing mode, this
  is a logical stream ID that may not correspond to a QUIC stream.
- A handshake extension would negotiate multiplexing mode. If
  negotiated, all frames flow over a single QUIC stream (e.g.,
  stream 4) and are demultiplexed by the AAFP Stream ID.
- No frame header change needed — the Stream ID field is already
  present and 64 bits wide.

**Can it be done as a v1 extension?** Partially. A handshake
extension can negotiate "single-stream mode," and the implementation
can send all frames on one QUIC stream. However, v1's stream
semantics (stream 0 = control, even = client-initiated, odd =
server-initiated) assume a 1:1 mapping with QUIC streams. A v1
receiver receiving multiple logical stream IDs on a single QUIC
stream may not demultiplex correctly.

**Trade-offs**:
- **Pro**: Enables browser/WASM support, which is critical for
  AAFP's adoption in web-based agent systems.
- **Pro**: No frame header change needed (Stream ID is already
  logical).
- **Con**: Loses QUIC's per-stream flow control and head-of-line
  blocking isolation. All logical streams share one QUIC stream's
  flow control window, and a blocked logical stream blocks all
  others.
- **Con**: Adds demultiplexing complexity to the receiver.
- **Con**: The 1:1 stream mapping is one of v1's most elegant
  properties. Multiplexing breaks this simplicity.
- **Risk**: Performance regression for native QUIC implementations
  if multiplexing becomes the default.

**Recommendation**: This is the strongest candidate for a v2 wire
protocol change — not because the frame format needs to change, but
because the stream mapping semantics need to change. However, it
can potentially be done as a v1 extension with careful specification.
A v2 may be justified if the stream semantics change is significant
enough to warrant a clean break. Alternatively, a separate transport
binding (like RFC-0007 MCP transport binding or RFC-0008 A2A
transport binding) could define a multiplexed mode without changing
the core wire format.

---

## 5. Backward Compatibility Strategy

AAFP's backward compatibility strategy is defined in RFC-0006 §7
and is based on four mechanisms:

### 5.1 Forward Compatibility (new sender, old receiver)

Old implementations can process messages from new implementations
through:

1. **Reserved fields**: Reserved bits and bytes in the frame header
   are ignored by old implementations. A v2 sender can use the
   reserved byte for priority; a v1 receiver ignores it.
2. **Unknown field skipping**: Old implementations skip unknown
   CBOR map fields. A v2 RpcRequest with a `deadline` field (key 4)
   is processed by a v1 receiver that ignores the unknown key.
3. **Extension mechanism**: New features are added as extensions.
   Non-critical extensions are skipped by old implementations.
   Critical extensions cause rejection (which is the correct
   behavior — the feature is required and the old implementation
   can't provide it).
4. **Feature flags**: New features use reserved flag bits, which
   old implementations ignore.

**Limitation**: Forward compatibility works for additive changes
(new fields, new extensions, new flag bits) but not for structural
changes (changed field semantics, removed fields, changed frame
header layout). A v2 that repurposes the reserved byte for priority
is forward-compatible; a v2 that changes the Stream ID from 64 bits
to 32 bits is not.

### 5.2 Backward Compatibility (old sender, new receiver)

New implementations can process messages from old implementations
through:

1. **Version field**: The new implementation reads the Version field
   and applies the old version's rules. A v2 receiver that sees
   Version=1 applies v1 rules.
2. **Optional fields**: New fields in CBOR structures are optional.
   Old messages without these fields are valid.
3. **Extension absence**: Old messages don't include extensions.
   The new implementation handles their absence gracefully.

### 5.3 v1 and v2 Coexistence

The coexistence strategy is:

1. **Dual-stack implementations**: An implementation that supports
   both v1 and v2 offers both ALPN identifiers (`aafp/1` and
   `aafp/2`). The TLS handshake selects the highest mutually
   supported version.
2. **Per-connection version**: The negotiated ALPN identifier
   determines the wire format for the entire connection. There is
   no mid-connection version switching.
3. **Version field confirmation**: Every frame's Version field
   confirms the version. A v2 receiver that receives a v1 frame
   (e.g., from a legacy peer on a pre-negotiated v1 connection)
   applies v1 rules.
4. **No mixed-version frames**: A single connection uses one
   version. Frames from different versions are not mixed on the
   same connection.

### 5.4 Migration Path

When v2 is introduced:

1. **Phase 1 (Coexistence)**: Both v1 and v2 are supported. New
   implementations offer both ALPN identifiers. v1-only
   implementations continue to work. v2 is preferred when both
   are available.
2. **Phase 2 (v2 Default)**: New implementations default to v2
   but still support v1. v1-only implementations are considered
   legacy.
3. **Phase 3 (v1 Deprecation)**: v1 is marked deprecated. New
   implementations SHOULD use v2. v1 support is maintained for
   backward compatibility.
4. **Phase 4 (v1 Retirement)**: v1 is retired. The `aafp/1` ALPN
   identifier MAY be reassigned. v1-only implementations are no
   longer supported.

### 5.5 What v2 Must Preserve

To maintain backward compatibility, v2 MUST:
- Keep the 28-byte fixed header layout (same field positions and
  sizes). New fields go in the reserved byte or in extensions.
- Keep the Version field at byte 0 (8 bits).
- Keep the FrameType field at byte 1 (8 bits).
- Keep the Flags field at byte 2 (8 bits).
- Keep the Stream ID at bytes 4–11 (64 bits).
- Keep the Payload Length at bytes 12–19 (64 bits).
- Keep the Extension Length at bytes 20–27 (64 bits).
- Keep the Extensions-then-Payload body order.
- Keep canonical CBOR encoding for control messages.
- Keep the 20-phase processing pipeline's security invariants
  (authentication before extension semantics).

v2 MAY:
- Repurpose the Reserved byte (byte 3) for new header fields.
- Repurpose reserved flag bits (0x10–0x40) for new flags.
- Add new frame types (0x09–0x7F, already reserved).
- Add new extension types.
- Add new CBOR fields to existing structures (with new integer keys).
- Change stream mapping semantics (with handshake negotiation).

---

## 6. Deprecation Policy

AAFP's deprecation policy is defined in RFC-0006 §7.4:

1. **Deprecation notice**: An RFC marks the feature as deprecated.
2. **Grace period**: The feature remains in the registry for at
   least one major version cycle.
3. **Removal**: The feature is removed in a new major version.
   Implementations of the new version MUST NOT send the deprecated
   feature. Implementations MAY accept the deprecated feature for
   backward compatibility.

**Key rules:**
- Deprecated features MUST NOT be removed within the same major
  version. Removal requires a new protocol version (v1 → v2).
- The grace period is "at least one major version cycle." If v2
  is the next major version after v1, a feature deprecated in v1
  can be removed in v2 but not in a v1 revision.

**How long should v1 be supported after v2?**

Based on industry practice (HTTP/1.1 → HTTP/2 → HTTP/3, TLS 1.2 →
TLS 1.3, gRPC over HTTP/2):

- **Minimum**: 2 years after v2 reaches "Active" status (two
  independent interoperable implementations). This gives the
  ecosystem time to upgrade.
- **Recommended**: 3–5 years. This accommodates slow-moving
  deployments (embedded systems, enterprise environments) that
  cannot upgrade quickly.
- **Factors**:
  - Number of v1-only deployments in the wild
  - Cost of upgrading (if v2 requires significant implementation
    changes)
  - Security: if v1 has security vulnerabilities that v2 fixes,
    the deprecation period should be shorter.
  - Ecosystem size: a larger ecosystem means a longer tail of
    legacy implementations.

**Proposed v1 deprecation timeline (if v2 is introduced):**

| Milestone | Timeline | Action |
|-----------|----------|--------|
| v2 RFC published | T+0 | v2 specification complete |
| v2 Active | T+6–12 months | Two independent implementations interop |
| v1 Deprecated | T+12 months | v1 marked deprecated; v2 preferred |
| v1 support expected | T+12 to T+36 months | Implementations SHOULD support both |
| v1 Retirement candidate | T+36 months | v1 MAY be retired if ecosystem has migrated |
| v1 Retired | T+48 months (earliest) | `aafp/1` ALPN MAY be reassigned |

**Deprecation of specific v1 features:**

Even without a full v2, individual v1 features can be deprecated:
- A frame type can be deprecated (senders MUST NOT send it, receivers
  MAY accept it).
- An extension type can be deprecated.
- A flag bit can be deprecated.
- A CBOR field can be deprecated (senders MUST NOT include it,
  receivers MAY accept it).

Deprecation of individual features follows the same notice → grace
period → removal process, but within the same major version (v1).
Removal of the feature's wire encoding requires v2.

---

## 7. Experimental Features via Frame Extensions

The v1 wire protocol already has a robust extension mechanism that
allows experimental features to be tested without modifying the
core wire format or bumping the protocol version.

### 7.1 Experimental Extension Types

RFC-0006 §3.1 defines the extension type registry with a dedicated
experimental range:

| Range | Assignment Policy |
|-------|-------------------|
| 0x4000–0x7FFF | Experimental (no assignment needed) |

Experimental extensions in this range can be used freely for testing
and prototyping. They do not require RFC assignment. Implementations
MUST NOT rely on experimental extensions for production use.

### 7.2 Experimental Frame Types

RFC-0006 §4.1 defines an experimental frame type range:

| Range | Assignment Policy |
|-------|-------------------|
| 0x80–0xFF | Experimental (no assignment needed) |

Experimental frame types can be used to prototype new frame
semantics (e.g., BATCH, RPC_STREAM_DATA) without registering them.
The critical bit mechanism ensures that unknown experimental frame
types are either skipped (non-critical) or rejected (critical) by
implementations that don't support them.

### 7.3 Prototyping v2 Features as v1 Extensions

Most v2 candidate features can be prototyped as v1 extensions before
committing to a wire-format-breaking v2:

| v2 Feature | v1 Extension Prototype | Wire Change Needed? |
|------------|----------------------|---------------------|
| Batch frames | Experimental frame type 0x80 (BATCH) | No — new frame type |
| Compressed frames | Handshake extension 0x0002 + COMPRESSED flag | No — flag already exists |
| Priority fields | Frame extension (type 0x4001) | No — extension |
| Deadline propagation | CBOR field key 4 in RpcRequest | No — schema evolution |
| Trace context | Frame extension (type 0x4002) | No — extension |
| Bidirectional streaming | DATA frames on RPC stream, or experimental frame types 0x81–0x83 | No — new frame types |
| Multiplexed streams | Handshake extension for single-stream mode | No — semantic change |

**This is the key insight: almost every v2 candidate feature can be
prototyped within v1's extension mechanism.** A v2 wire format change
should be reserved for features that genuinely cannot be expressed
as extensions — primarily structural changes to the frame header
layout or fundamental changes to stream semantics.

### 7.4 Extension Lifecycle

The lifecycle of an extension from experimental to standards-track:

1. **Experimental**: Use type in 0x4000–0x7FFF (extensions) or
   0x80–0xFF (frame types). Test with willing peers. No RFC needed.
2. **Standards-track proposal**: Write an RFC specifying the
   extension's semantics, data format, and negotiation rules.
3. **Standards-track assignment**: RFC is accepted; type is assigned
   from 0x0000–0x3FFF (extensions) or 0x09–0x7F (frame types).
4. **Mandatory (optional)**: An RFC MAY declare the extension
   mandatory for a specific protocol version. The critical bit is
   always set.
5. **Deprecation**: The extension is marked deprecated. After a
   grace period, it is removed in a new major version.

### 7.5 Risks of Extension Proliferation

While the extension mechanism is powerful, overuse carries risks:
- **Implementation complexity**: Each extension adds code paths,
  test cases, and potential bugs.
- **Interoperability fragmentation**: If different implementations
  support different extension sets, interoperability becomes a
  matrix of supported features.
- **Negotiation overhead**: Each extension proposed in the handshake
  adds bytes to ClientHello and ServerHello. The 64 KiB extension
  limit in the frame header doesn't apply to handshake extensions
  (they're in the CBOR payload), but large extension lists increase
  handshake message size.
- **Security surface**: Each extension is a potential attack vector.
  The 20-phase processing pipeline ensures extensions are processed
  after authentication, but extension callbacks (Phase 18) can still
  have bugs.

**Mitigation**: Keep the standards-track extension set small. Prefer
SDK-level solutions over wire extensions. Only standardize extensions
that require transport-level awareness and have proven benefit in
experimental deployment.

---

## 8. Impact Analysis

This section analyzes the impact of specific wire protocol changes
on existing implementations, conformance tests, and the processing
pipeline.

### 8.1 Adding a New Frame Type

**Example**: Adding frame type 0x09 (BATCH).

**Impact on v1 receivers**:
- If the critical bit is set (0x80 in Flags): v1 receivers that
  don't understand 0x09 send ERROR 8004 (UNKNOWN_CRITICAL_FRAME_TYPE)
  and close the connection. This is a hard failure.
- If the critical bit is clear: v1 receivers skip the frame and
  continue. The batch is silently lost. This is a soft failure but
  means the feature doesn't work unless both peers support it.

**Impact on the processing pipeline**:
- Phase 1 (validate_frame_header): No change — frame type is read
  from the header.
- Phases 2–14: No change — these phases are frame-type-agnostic
  (they validate lengths, decode CBOR, verify auth).
- Phase 15–18 (extension processing): No change — extensions are
  processed regardless of frame type.
- Phase 20 (deliver_to_upper_layer): The upper layer must handle
  the new frame type. This is an SDK change, not a wire change.

**Impact on conformance tests**:
- New golden traces must be added for the new frame type.
- The conformance test suite must verify that unknown frame types
  are handled correctly (skip if non-critical, error if critical).
- Existing tests are not affected.

**Impact on implementations**:
- Rust and Go implementations must add a handler for the new frame
  type.
- The handshake must negotiate support for the new frame type
  (otherwise peers that don't support it will skip or reject it).
- No changes to the frame parser (the header format is unchanged).

**Verdict**: Low impact. Adding a frame type is the safest wire
protocol change. The critical bit mechanism and the frame type
registry (0x09–0x7F reserved) are designed for exactly this.

### 8.2 Adding a Header Field

**Example**: Repurposing the Reserved byte (byte 3) as a Priority
field.

**Impact on v1 receivers**:
- v1 receivers ignore the Reserved byte (RFC-0002 §3.1: "MUST be
  ignored by receivers"). A v2 sender that sets the Priority field
  in byte 3 is compatible with v1 receivers.
- v1 senders set byte 3 to 0. A v2 receiver interprets 0 as
  "default priority." This is correct.

**Impact on the processing pipeline**:
- Phase 1 (validate_frame_header): Currently checks `reserved == 0`
  and errors with 8008 (RESERVED_FIELD_NONZERO) if not. This check
  MUST be removed or relaxed for v2 frames. This requires version-
  dependent logic in Phase 1: if Version=1, check reserved==0; if
  Version=2, interpret byte 3 as Priority.
- All other phases: No change.

**Impact on conformance tests**:
- The test that verifies ERROR 8008 for non-zero reserved fields
  must be updated to only apply to v1 frames.
- New tests must verify Priority field handling for v2 frames.
- Golden traces for v1 frames are unchanged (v1 frames still have
  reserved=0).

**Impact on implementations**:
- Frame parser: No change (byte 3 is already read as part of the
  28-byte header).
- Frame validator: Must add version-dependent logic for byte 3.
- Upper layer: Must handle Priority field (scheduling logic).

**Verdict**: Medium impact. The change is backward-compatible (v1
ignores the field), but the processing pipeline's Phase 1 must
become version-aware. This is a subtle change that could introduce
bugs if not carefully tested.

### 8.3 Changing Field Semantics

**Example**: Changing the Stream ID from a QUIC stream identifier
to a logical stream identifier (for multiplexing mode).

**Impact on v1 receivers**:
- v1 receivers use the Stream ID to determine which QUIC stream the
  frame belongs to. If the Stream ID is a logical identifier that
  doesn't match the QUIC stream, v1 receivers may misroute the
  frame.
- This is NOT backward-compatible. v1 receivers cannot handle
  multiplexed streams. This requires version negotiation (v2-only
  feature, negotiated via handshake extension or ALPN).

**Impact on the processing pipeline**:
- Phase 12 (verify_session_state): The session state check may need
  to account for logical stream IDs.
- Phase 20 (deliver_to_upper_layer): The upper layer must
  demultiplex logical streams.

**Impact on conformance tests**:
- New tests for multiplexed stream demultiplexing.
- Existing tests for stream 0 (handshake) and stream 4+ (data)
  routing must be updated for multiplexing mode.

**Impact on implementations**:
- Significant: the stream management layer must be rewritten to
  support logical stream demultiplexing.
- QUIC stream lifecycle (open, half-close, close) must be mapped
  to logical stream lifecycle.

**Verdict**: High impact. This is the most disruptive change
analyzed. It fundamentally changes the stream model and requires
version-gated negotiation. This is the strongest candidate for a
v2-only feature.

### 8.4 Changing the Frame Header Layout

**Example**: Adding a new fixed-size field to the header (e.g., a
32-bit Trace Context ID between the Reserved byte and the Stream ID).

**Impact on v1 receivers**:
- v1 receivers read a 28-byte header. If the header is now 32 bytes,
  v1 receivers misparse all subsequent fields (Stream ID, Payload
  Length, Extension Length are all at wrong offsets).
- This is NOT backward-compatible. This requires a new protocol
  version (v2) with a different ALPN identifier.

**Impact on the processing pipeline**:
- Phase 1: Header size changes from 28 to 32 bytes. The parser
  must be version-aware.
- All subsequent phases: Field offsets change.

**Impact on conformance tests**:
- All golden traces must be regenerated for v2.
- v1 golden traces remain unchanged (v1 connections use v1 format).

**Impact on implementations**:
- Frame parser must be rewritten for v2.
- Both v1 and v2 parsers must coexist in dual-stack implementations.

**Verdict**: Very high impact. This is a wire-format-breaking change
that requires a full v2. Only justified if the benefit is substantial
and cannot be achieved through extensions or reserved fields.

### 8.5 Impact Summary

| Change Type | Backward Compatible? | v2 Required? | Impact Level |
|-------------|---------------------|---------------|--------------|
| New frame type (0x09–0x7F) | Yes (critical bit mechanism) | No | Low |
| New CBOR field (new integer key) | Yes (unknown key skipping) | No | Low |
| New extension type | Yes (extension mechanism) | No | Low |
| Repurpose Reserved byte | Yes (v1 ignores it) | No (but Phase 1 changes) | Medium |
| Repurpose Reserved flag bits | Yes (v1 ignores them) | No | Low |
| Change Stream ID semantics | No (v1 misroutes) | Yes (negotiated) | High |
| Change header layout (add field) | No (v1 misparses) | Yes | Very High |
| Change header field size | No (v1 misparses) | Yes | Very High |

---

## 9. When NOT to Change the Wire Protocol

The v1 wire protocol was designed with a deliberate philosophy: keep
the wire format simple and push complexity to the SDK and application
layers. This section argues for restraint — many features that seem
to require wire protocol changes are better handled at higher layers.

### 9.1 SDK-Level Features (No Wire Change Needed)

The following features are commonly requested but should NOT be wire
protocol changes:

**Retry logic**: Retries, backoff, and circuit breaking are SDK
responsibilities. The wire protocol delivers frames; the SDK decides
when to retry. Adding retry metadata to frames would complicate the
wire format without benefit — the SDK already has all the
information it needs (request ID, response, error code).

**Load balancing**: The wire protocol should not know about load
balancing. The SDK or a proxy layer handles request routing across
multiple connections. Wire-level load balancing metadata would
couple the transport to the deployment topology.

**Observability beyond trace context**: Metrics (request latency,
error rates) are computed by the SDK from frame timestamps and
response data. The wire protocol doesn't need to carry metrics
metadata.

**Authentication token refresh**: Token rotation is an SDK/session
concern. The wire protocol's handshake establishes identity; token
refresh is an application-layer operation (e.g., a re-handshake or
an RPC method).

**Schema validation**: The wire protocol carries CBOR; schema
validation is the SDK's job. Adding schema identifiers to frames
would couple the transport to the application schema, which changes
more frequently than the wire protocol.

**Content negotiation**: Method-specific content types (e.g., "this
RPC returns JSON vs CBOR") are application-layer concerns. The wire
protocol carries opaque CBOR; the method definition specifies the
schema.

### 9.2 The "Keep It Simple" Principle

The v1 wire protocol has 8 frame types, a 28-byte header, and a
20-phase processing pipeline. This is already complex enough. Every
wire-level feature adds:
- Parser complexity (more fields to read, validate, and handle)
- Conformance test burden (more golden traces, more edge cases)
- Implementation burden (every implementation must support it)
- Security surface (more fields = more potential for bugs)
- Specification burden (more normative text, more edge cases)

The extension mechanism exists to allow incremental feature addition
without bloating the core wire format. Features that can be
extensions SHOULD be extensions. Features that can be SDK-level
SHOULD be SDK-level. Only features that require transport-level
awareness and cannot be expressed as extensions should be wire
protocol changes.

### 9.3 The "Real-World Data" Principle

v1 has achieved Protocol Candidate status with two interoperable
implementations and 326/326 conformance steps complete. However,
the Protocol Candidate Checklist notes: "Production deployment
experience: NONE. No real-world deployment data."

Before designing v2, we need real-world deployment data to answer:
- Which v1 features are actually used?
- Which v1 limitations are actually encountered?
- What are the real performance bottlenecks?
- Which proposed v2 features would actually help?

Designing v2 without deployment data risks adding features that
solve imagined problems while missing features that solve real ones.
The HTTP/2 → HTTP/3 transition was driven by real-world TCP head-of-
line blocking observed in HTTP/2 deployments, not by theoretical
analysis.

**Recommendation**: Deploy v1 in real-world scenarios. Collect
performance data, feature usage statistics, and developer feedback.
Use this data to prioritize v2 features. A v2 designed from
deployment data will be better than one designed from speculation.

### 9.4 The "One-Way Door" Principle

Wire protocol changes are one-way doors (RFC-0006 §11.2): once v2
is deployed with a wire format change, it cannot be undone without
another version bump. The amendment process requires identifying
one-way doors and verifying them carefully.

Features that can be added as extensions are two-way doors: if the
feature doesn't work out, the extension can be deprecated and
removed without a wire format change. Features that require header
layout changes are one-way doors.

**Recommendation**: Prefer two-way doors (extensions, SDK features)
over one-way doors (wire format changes). Only open a one-way door
when the feature is proven (via experimental extension) and the
benefit clearly outweighs the cost.

### 9.5 Summary: When to Change vs. When Not to Change

| Change the wire protocol when... | Don't change the wire protocol when... |
|----------------------------------|---------------------------------------|
| The feature requires transport-level awareness | The feature is an SDK concern |
| The feature cannot be expressed as an extension | The feature can be an extension |
| Real-world deployment data proves the need | The need is theoretical |
| The benefit clearly outweighs the cost | The benefit is marginal |
| The feature is a one-way door that must be opened | The feature is a two-way door (try extension first) |
| The change fixes a security vulnerability | The change adds convenience |
| The change enables a fundamentally new transport (e.g., browser) | The change optimizes a niche use case |

---

## 10. Recommendations

### 10.1 Short-Term (v1-compatible, no version bump)

1. **Compression extension**: Define a standards-track compression
   extension (type 0x0002) supporting zstd and lz4. Use the existing
   COMPRESSED flag (0x02). Specify a minimum payload threshold and
   an uncompressed size limit. This is the highest-impact v1-
   compatible improvement.

2. **Deadline propagation**: Add `deadline` (key 4) as an optional
   field in RpcRequest. This is pure CBOR schema evolution — no
   wire change, no extension negotiation, no version bump. v1
   receivers ignore the unknown key.

3. **Trace context extension**: Define a standards-track frame
   extension (type 0x0003) carrying W3C Trace Context. Accept that
   it's processed in Phase 18 (post-auth). Use stream ID and
   connection-level correlation for early-phase tracing.

4. **Batch frames (experimental)**: Prototype BATCH frames using
   experimental frame type 0x80. Test with willing peers. If
   beneficial, propose as standards-track type 0x09.

5. **Streaming RPC (experimental)**: Prototype bidirectional
   streaming using DATA frames on RPC streams. If a formal protocol
   is needed, prototype with experimental frame types 0x81–0x83.

### 10.2 Medium-Term (v1 extensions, possible minor version)

6. **Browser/WASM transport binding**: Define a multiplexed-stream
   mode as a handshake extension. All logical streams flow over a
   single QUIC stream, demultiplexed by AAFP Stream ID. This may
   require a separate transport binding RFC (like RFC-0007 MCP
   binding or RFC-0008 A2A binding) rather than a core wire format
   change.

7. **Priority field (experimental)**: Prototype priority using a
   frame extension (type 0x4001). If deployment data shows that
   extension-based priority is insufficient (processed too late in
   the pipeline), consider repurposing the Reserved byte in a future
   version.

### 10.3 Long-Term (v2, if justified by deployment data)

8. **v2 wire protocol**: Only if real-world deployment data
   demonstrates that v1 extensions are insufficient. A v2 should:
   - Preserve the 28-byte header layout (use reserved fields, not
     new fields).
   - Keep the 20-phase processing pipeline and its security
     invariants.
   - Graduate proven experimental extensions to standards-track.
   - Potentially change stream mapping semantics (if browser/WASM
     support requires it).
   - Include a migration path with v1 coexistence for 3–5 years.

9. **v1 deprecation**: Only after v2 has been Active for at least
   12 months and the ecosystem has begun migrating. v1 support
   should be maintained for at least 36 months after v2 Active
   status.

### 10.4 Governance Recommendations

10. **Extension review board**: Establish a process for reviewing
    experimental extensions before they are proposed for standards-
    track. The review should assess: real-world usage data, security
    implications, interoperability impact, and whether the feature
    is better handled at the SDK layer.

11. **Deployment data collection**: Instrument v1 implementations to
    collect anonymized performance metrics (frame sizes, RPC
    latency, stream counts, extension usage). Use this data to
    inform v2 prioritization.

12. **Regular extension audits**: Periodically review the extension
    registry to identify unused or broken extensions. Deprecate
    extensions that have no known implementations.

---

## Appendix A: v1 Wire Protocol Quick Reference

### Frame Header (28 bytes, big-endian)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | Version (1 for v1) |
| 1 | 1 | FrameType |
| 2 | 1 | Flags |
| 3 | 1 | Reserved (0) |
| 4 | 8 | Stream ID |
| 12 | 8 | Payload Length (max 1 MiB) |
| 20 | 8 | Extension Length (max 64 KiB) |

### Frame Body

| Section | Size | Content |
|---------|------|---------|
| Extensions | Extension Length | Concatenated extension blocks |
| Payload | Payload Length | Frame-type-specific data |

### Frame Types

| Type | Name | Critical Default |
|------|------|-----------------|
| 0x01 | DATA | No |
| 0x02 | HANDSHAKE | Yes |
| 0x03 | RPC_REQUEST | No |
| 0x04 | RPC_RESPONSE | No |
| 0x05 | CLOSE | Yes |
| 0x06 | ERROR | Yes |
| 0x07 | PING | No |
| 0x08 | PONG | No |

### Flags

| Bit | Name |
|-----|------|
| 0x80 | CRITICAL |
| 0x01 | MORE |
| 0x02 | COMPRESSED |
| 0x04 | ENCRYPTED |
| 0x08 | ACK |
| 0x10–0x40 | Reserved |

### Extension Block (in frame body)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 2 | Extension Type |
| 2 | 1 | Critical (0x01) or Optional (0x00) |
| 3 | 1 | Reserved (0) |
| 4 | 4 | Extension Data Length |
| 8 | variable | Extension Data |

### Extension Type Registry

| Range | Policy |
|-------|--------|
| 0x0000–0x3FFF | Standards-track |
| 0x4000–0x7FFF | Experimental |
| 0x8000–0xBFFF | Private-use |
| 0xC000–0xFFFF | Reserved |

### ALPN Identifiers

| ALPN | Version |
|------|---------|
| `aafp/1` | v1 |
| `aafp/2` | v2 (future) |

---

## Appendix B: v2 Candidate Feature Assessment Matrix

| Feature | Wire Change? | v1 Extension Possible? | Impact | Priority | Recommendation |
|---------|-------------|------------------------|--------|----------|----------------|
| Batch frames | New frame type | Yes (0x80 experimental) | Low | Medium | Prototype as v1 ext |
| Compressed frames | None (flag exists) | Yes (handshake ext 0x0002) | Low | High | Define as v1 ext |
| Priority fields | Repurpose reserved byte | Yes (frame ext 0x4001) | Medium | Low | Defer; SDK-level first |
| Deadline propagation | None (CBOR field) | Yes (key 4 in RpcRequest) | Low | High | Add as v1 CBOR field |
| Trace context | None (frame ext) | Yes (frame ext 0x0003) | Low | Medium | Define as v1 ext |
| Bidirectional streaming | New frame types | Yes (0x81–0x83 experimental) | Low | Medium | Prototype as v1 ext |
| Multiplexed streams | Semantic change | Partially (handshake ext) | High | High | v2 or transport binding |

---

## Appendix C: References

- RFC-0002: AAFP Transport & Framing (wire format, handshake, extensions)
- RFC-0003: AAFP Identity & Authentication (AgentId, signatures, capabilities)
- RFC-0005: AAFP Error Model (error codes, fatal/non-fatal semantics)
- RFC-0006: AAFP Versioning & Compatibility (version negotiation, extension registry, deprecation)
- RFC-0009: AAFP Networked PubSub Protocol (floodsub, future gossipsub)
- PROTOCOL_CANDIDATE_CHECKLIST.md: v1 completion status (326/326 steps)
- RFC 9000: QUIC (transport)
- RFC 9266: TLS Channel Binding
- FIPS 204: ML-DSA (post-quantum signatures)
- RFC 8949: CBOR (canonical encoding)

---

*End of document.*
