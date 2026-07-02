# RFC-0002: AAFP Transport & Framing

```
Status:         Release Candidate (Revision 6)
Number:         0002
Title:          Transport, Framing, Stream Multiplexing, and Wire Format
Author:         AAFP Project
Created:        2025-06-25
Revised:        2025-01-15 (Revision 4: SA-0002 clarification — empty
                CBOR map key-type interpretation)
                2025-01-16 (Revision 5: no content changes, version bump
                for consistency with RFC-0003)
Type:           Standards Track
Obsoletes:      —
Obsoleted by:   —
```

## 1. Overview

This RFC specifies the AAFP wire format: how messages are framed on
QUIC streams, how protocol versioning is carried, how extensions are
encoded, and how independent implementations interoperate.

This is the most critical RFC in the AAFP series. It defines what goes
on the wire. Once independent implementations exist, changes to this
document require a new protocol version.

### 1.1 Normative Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

### 1.2 Terminology

- **Frame**: The basic unit of data on an AAFP stream.
- **Stream**: A logical bidirectional or unidirectional communication
  channel, mapped to a QUIC stream.
- **Connection**: A QUIC connection between two agents.
- **Session**: The authenticated, established state of a connection
  after the AAFP handshake completes.
- **Extension**: An optional protocol feature identified by a numeric
  type, carried in the frame header or as a dedicated frame type.

## 2. Transport: QUIC

### 2.1 QUIC Version

AAFP uses QUIC version 1 (RFC 9000). Future versions of QUIC may be
supported via the transport negotiation mechanism (see RFC-0006).

### 2.2 TLS ALPN

AAFP registers the ALPN identifier `aafp/1` for v1 of the protocol.
Implementations MUST negotiate this ALPN identifier during the TLS
handshake. If ALPN negotiation fails, the connection MUST be closed
with a TLS alert.

Future protocol versions register additional ALPN identifiers (e.g.,
`aafp/2`). ALPN negotiation determines which protocol version is in
use for the connection.

### 2.3 TLS Key Exchange

Implementations MUST offer the `X25519MLKEM768` key exchange group
and SHOULD prefer it over classical-only groups. Implementations MAY
offer `X25519` as a fallback for compatibility with implementations
that do not support PQ KEX, but this fallback SHOULD be disabled in
production deployments requiring post-quantum security.

### 2.4 TLS Certificates

Implementations MUST use self-signed certificates. The certificate's
public key is not used for AAFP identity verification; agent identity
is verified at the application layer (see RFC-0003).

Implementations MUST NOT require CA-signed certificates. Implementations
MUST NOT perform certificate chain validation beyond verifying the
self-signed certificate's integrity.

### 2.5 Connection Lifecycle

1. **Connect**: The initiating agent opens a QUIC connection to the
   peer's multiaddr. TLS negotiation occurs, including ALPN and PQ KEX.
2. **Channel Binding**: After TLS completes, both sides compute the
   TLS channel binding value (see Section 5.6).
3. **Handshake**: The AAFP application-layer handshake occurs on
   stream 0 (see Section 5). The channel binding value is included
   in the handshake transcript hash.
4. **Established**: The session is authenticated. Agents may open
   additional streams for messaging.
5. **Close**: Either agent may close the connection. The closing agent
   SHOULD send a close frame (see Section 4.5) before closing the QUIC
   connection.

After TLS handshake completion and before sending the ClientHello,
both sides MUST compute the TLS channel binding value:

```
tls_binding = TLS-Exporter("EXPORTER-AAFP-Channel-Binding", "", 32)
```

The TLS exporter is defined in RFC 8446 Section 7.5. It produces a
32-byte value unique to the TLS session. Including this value in the
AAFP transcript hash (Section 5.6) binds the AAFP session to the
specific TLS channel, preventing relay attacks. See RFC 9266 for
the standard TLS 1.3 channel binding mechanism.

If the TLS exporter is not available (e.g., the TLS implementation
does not support RFC 8446 exporters), the implementation MUST NOT
proceed with the handshake. The connection MUST be closed with
error code 2006 (HANDSHAKE_FAILED).

## 3. Frame Format

### 3.1 Frame Header

Every AAFP frame begins with a fixed-size header:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Version    |    FrameType  |     Flags     |  Reserved     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        Stream ID (64)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                      Stream ID (continued)                     +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload Length                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|               Payload Length (continued, 32 bits)              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Extension Length                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|               Extension Length (continued, 32 bits)            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Fields:

| Field | Size | Description |
|-------|------|-------------|
| Version | 8 bits | AAFP protocol version (1 for v1). See RFC-0006. |
| FrameType | 8 bits | Frame type. See Section 4. |
| Flags | 8 bits | Frame-specific flags. See Section 4. |
| Reserved | 8 bits | Reserved for future use. MUST be set to 0 by senders. MUST be ignored by receivers. |
| Stream ID | 64 bits | The stream this frame belongs to. Stream 0 is reserved for the handshake. |
| Payload Length | 64 bits | Length of the payload section in bytes. |
| Extension Length | 64 bits | Length of the extension section in bytes. 0 if no extensions. |

All integer fields are encoded in network byte order (big-endian).

### 3.2 Frame Body

After the header, the frame body consists of two sections:

```
+---------------------------------------------------------------+
|                      Extensions                               |
|                  (Extension Length bytes)                     |
+---------------------------------------------------------------+
|                       Payload                                 |
|                   (Payload Length bytes)                       |
+---------------------------------------------------------------+
```

- **Extensions**: Zero or more extension blocks (see Section 6).
  `Extension Length` is 0 if no extensions are present.
- **Payload**: Frame-type-specific data. For data frames, this is
  application data. For control frames, this is a CBOR-encoded
  control message.

### 3.3 Frame Ordering

Frames within a single QUIC stream are ordered (QUIC guarantees this).
Frames across streams are NOT ordered. Implementations MUST NOT assume
cross-stream ordering.

### 3.4 Maximum Frame Size

The maximum payload size is 1 MiB (1,048,576 bytes). The maximum
extension section size is 64 KiB (65,536 bytes). Implementations
MUST reject frames where either the Payload Length or Extension Length
exceeds these limits by sending an ERROR frame (see RFC-0005) with
error code `8001` (FRAME_TOO_LARGE) and closing the stream. The ERROR
frame's fatal flag SHOULD be false (non-fatal), allowing the connection
to continue for other streams. If the peer repeatedly sends oversized
frames, the implementation MAY set the fatal flag to true and close
the connection.

Larger application messages MUST be fragmented across multiple frames
on the same stream. The `MORE` flag (see Section 4.1) indicates that
more fragments follow.

### 3.5 Backward Compatibility Note

The v0.1 MVP implementation uses a simpler frame format:
`[4-byte length][payload]`. This format is NOT compatible with the v1
frame format specified above. The v0.1 format is a pre-RFC
implementation artifact and is superseded by this specification.

Implementations conforming to RFC-0002 MUST use the frame format
specified in Section 3.1.

## 4. Frame Types

### 4.1 DATA Frame (0x01)

```
FrameType = 0x01
Payload:  Application data (opaque bytes)
```

Flags:
- `0x01` (MORE): More fragments follow on this stream. The receiver
  MUST buffer fragments until a DATA frame without the MORE flag is
  received, then deliver the assembled message.
- `0x02` (COMPRESSED): The payload is compressed. The compression
  algorithm is negotiated via extensions (see RFC-0006). If compression
  was not negotiated, the receiver MUST return error `8002`
  (unexpected compression).

DATA frames carry application-layer messages. The interpretation of
the payload is determined by the application protocol running on the
stream.

### 4.2 HANDSHAKE Frame (0x02)

```
FrameType = 0x02
Payload:  CBOR-encoded handshake message (see Section 5)
```

The HANDSHAKE frame is used only on stream 0 during connection
establishment. It MUST NOT be sent on other streams. Receivers MUST
return error `8003` (handshake on non-zero stream) if a HANDSHAKE
frame is received on a stream other than 0.

### 4.3 RPC_REQUEST Frame (0x03)

```
FrameType = 0x03
Payload:  CBOR-encoded RpcRequest
```

The `RpcRequest` CBOR structure (integer keys, per Section 8):

```cbor
RpcRequest = {
    1: uint,       // "id": Correlation ID (unique per connection)
    2: tstr,       // "method": Method name
    3: any,        // "params": Method parameters (CBOR any type)
                   // Structure depends on the method. See individual
                   // method definitions (e.g., RFC-0004 Section 3.3).
                   // For methods with no parameters, use null.
}
```

### 4.4 RPC_RESPONSE Frame (0x04)

```
FrameType = 0x04
Payload:  CBOR-encoded RpcResponse
```

The `RpcResponse` CBOR structure (integer keys, per Section 8):

```cbor
RpcResponse = {
    1: uint,                    // "id": Matches the request ID
    2: any / null,              // "result": Result data (null if error)
                                // Structure depends on the method.
    3: {                        // "error": Error object (null if success)
        1: uint,                //   "code": Error code (see RFC-0005)
        2: tstr,                //   "message": Human-readable message
        3: bstr / null,         //   "data": Optional structured data
    } / null,
}
```

### 4.5 CLOSE Frame (0x05)

```
FrameType = 0x05
Payload:  CBOR-encoded CloseMessage
```

The `CloseMessage` CBOR structure (integer keys, per Section 8):

```cbor
CloseMessage = {
    1: uint,       // "code": Close reason code (see RFC-0005)
    2: tstr,       // "message": Human-readable close reason
}
```

A CLOSE frame indicates that the sender is closing the connection.
After sending a CLOSE frame, the sender MUST NOT send additional
frames. The receiver SHOULD send a CLOSE frame in response and then
close the QUIC connection.

### 4.6 ERROR Frame (0x06)

```
FrameType = 0x06
Payload:  CBOR-encoded ErrorMessage
```

The `ErrorMessage` CBOR structure (integer keys, per Section 8):

```cbor
ErrorMessage = {
    1: uint,            // "code": Protocol error code (see RFC-0005)
    2: tstr,            // "message": Human-readable error message
    3: bstr / null,     // "data": Optional structured error data
    4: bool,            // "fatal": If true, the connection must be closed
}
```

If `fatal` is true, the receiver MUST close the connection after
receiving the error frame. If `fatal` is false, the error is
non-fatal and the connection may continue.

### 4.7 PING Frame (0x07)

```
FrameType = 0x07
Payload:  Empty (0 bytes)
```

A PING frame is an application-layer keepalive probe. The receiver
MUST respond with a PONG frame on the same stream.

PING frames MAY be sent on any open stream, including stream 0
(the handshake stream, which remains open after the handshake
completes). Sending PING on stream 0 is RECOMMENDED for
connection-level keepalive, as it does not require opening a new
stream.

Note: QUIC provides its own transport-level keepalive mechanism
(via idle timeout and PING frames at the QUIC layer). AAFP PING/
PONG frames are for application-layer liveness checks and are
distinct from QUIC's keepalive. Implementations MAY use either or
both mechanisms.

### 4.8 PONG Frame (0x08)

```
FrameType = 0x08
Payload:  Empty (0 bytes)
```

A PONG frame is the response to a PING frame. It MUST be sent on
the same stream as the PING frame.

### 4.9 Reserved Frame Types

Frame types 0x00 and 0x09–0xFF are reserved for future use.
Implementations receiving an unknown frame type MUST:

1. If the frame's `Flags` field has the critical bit (0x80) set,
   return error `8004` (unknown critical frame type) and close the
   connection.
2. If the critical bit is not set, skip the frame and continue
   processing.

The critical bit mechanism allows new frame types to be introduced
without breaking existing implementations. See RFC-0006 for the
extension registration process.

## 5. Handshake

### 5.1 Overview

The AAFP handshake occurs on stream 0 after the TLS handshake
completes. It authenticates the agents to each other using ML-DSA-65
signatures and establishes the session.

### 5.2 Handshake Messages

The handshake consists of three messages, exchanged as HANDSHAKE
frames on stream 0:

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

Stream 0 remains open for the lifetime of the connection after the
handshake completes. It is used for connection-level frames:
- PING / PONG frames (Section 4.7)
- GOAWAY frames (Section 4.8)
- ERROR frames with fatal severity (RFC-0005 Section 4.4)

Stream 0 MUST NOT be used for DATA frames or RPC frames after the
handshake. Application data flows on streams >= 4 (client-initiated)
or >= 5 (server-initiated).

### 5.3 ClientHello

```cbor
ClientHello = {
    1: uint,       // "protocol_version": AAFP version (1)
    2: bstr,       // "agent_id": 32-byte AgentId
    3: bstr,       // "public_key": ML-DSA-65 public key (1952 bytes)
    4: bstr,       // "nonce": 32-byte random nonce
    5: [ *CapabilityDescriptor ],  // "capabilities"
    6: [ *ExtensionEntry ],        // "extensions" (see Section 6.4)
    7: bstr,       // "signature": ML-DSA-65 signature (see Section 5.6)
    8: uint,       // "expires_at": Unix timestamp (seconds)
    9: bstr / null, // "receiver_mac": Optional DoS pre-verification
                    //   MAC (see Section 5.8). Null if DoS profile
                    //   is not active.
    10: uint,      // "key_algorithm": Signature algorithm (see
                   //   RFC-0003 Section 2.3). 1 = ML-DSA-65.
}
```

### 5.4 ServerHello

```cbor
ServerHello = {
    1: uint,       // "protocol_version": AAFP version (1)
    2: bstr,       // "agent_id": 32-byte AgentId
    3: bstr,       // "public_key": ML-DSA-65 public key (1952 bytes)
    4: bstr,       // "nonce": 32-byte random nonce
    5: [ *CapabilityDescriptor ],  // "capabilities"
    6: [ *ExtensionEntry ],        // "extensions" (accepted subset,
                                   //   see Section 6.4)
    7: bstr,       // "session_id": Session identifier (see Section 5.7)
    8: bstr,       // "signature": ML-DSA-65 signature (see Section 5.6)
    9: uint,       // "expires_at": Unix timestamp (seconds)
    10: uint,      // "key_algorithm": Signature algorithm
}
```

### 5.5 ClientFinished

```cbor
ClientFinished = {
    1: bstr,       // "session_id": Echoed from ServerHello
    2: bstr,       // "signature": ML-DSA-65 signature over
                   //   transcript hash (see Section 5.6)
}
```

### 5.6 Transcript Hash and Signature Computation

The handshake transcript hash is a running SHA-256 hash over the
canonical CBOR encodings of handshake messages, prefixed with the
TLS channel binding value (see Section 2.5). Every handshake signature
is computed over the transcript hash **after** the current message's
CBOR has been folded into the hash. This is the single source of truth
for signature inputs — there are no separate concatenation formulas.

#### Signature Input Encoding

When a signature input specification says
`canonical_CBOR(Message_without_field_X)`, this means:

1. Construct a NEW CBOR map containing exactly the fields of the
   message EXCLUDING the specified field(s).
2. Encode this map using canonical CBOR (Section 8.1).
3. The resulting byte sequence is the signature input component.

The excluded fields are omitted entirely — they are not present in
the map, not encoded as null, and not encoded with zero-length
values. The map length reflects only the included fields.

For example, `canonical_CBOR(ClientHello_without_signature_and_receiver_mac)`
produces a CBOR map with 8 entries (keys 1, 2, 3, 4, 5, 6, 8, 10),
encoded in canonical form. Keys 7 (signature) and 9 (receiver_mac)
are absent from the map.

#### Transcript Hash and Signature Procedure

All AAFP signatures use domain separators (see RFC-0003 Section 3.5)
to prevent cross-protocol signature reuse. The domain separator
for handshake signatures is `"aafp-v1-handshake"`.

The signature is over the 32-byte transcript hash (prefixed with the
domain separator), not raw message concatenation. This is important
for ML-DSA-65 which has a maximum message size.

**Step 1: Initialize**

After TLS handshake completion, both sides compute the TLS channel
binding and initialize the transcript hash:
```
tls_binding = TLS-Exporter("EXPORTER-AAFP-Channel-Binding", "", 32)
h = SHA-256(tls_binding)
```

**Step 2: ClientHello Phase**

Sender (client):
1. Construct ClientHello without signature (key 7) and receiver_mac
   (key 9).
2. Compute `CH_CBOR = canonical_CBOR(ClientHello_without_sig_and_mac)`.
3. Update transcript: `h = SHA-256(h || CH_CBOR)`.
4. Compute signature:
   ```
   ClientHello.signature = ML-DSA-65.Sign(
       secret_key,
       "aafp-v1-handshake" || h)
   ```
5. Insert signature into ClientHello (key 7).
6. Send ClientHello.

Receiver (server):
1. Receive ClientHello.
2. Extract `CH_CBOR = canonical_CBOR(ClientHello_without_sig_and_mac)`.
3. Update transcript: `h = SHA-256(h || CH_CBOR)`.
4. Verify `ClientHello.signature` against `h` using the public key
   in ClientHello (key 3).

**Step 3: ServerHello Phase**

Sender (server):
1. Construct ServerHello without signature (key 8).
2. Compute `SH_CBOR = canonical_CBOR(ServerHello_without_sig)`.
3. Update transcript: `h = SHA-256(h || SH_CBOR)`.
4. Compute signature:
   ```
   ServerHello.signature = ML-DSA-65.Sign(
       secret_key,
       "aafp-v1-handshake" || h)
   ```
5. Insert signature into ServerHello (key 8).
6. Send ServerHello.

Receiver (client):
1. Receive ServerHello.
2. Extract `SH_CBOR = canonical_CBOR(ServerHello_without_sig)`.
3. Update transcript: `h = SHA-256(h || SH_CBOR)`.
4. Verify `ServerHello.signature` against `h` using the public key
   in ServerHello (key 3).

**Step 4: ClientFinished Phase**

Sender (client):
1. Construct ClientFinished without signature (key 2).
2. Compute `CF_CBOR = canonical_CBOR(ClientFinished_without_sig)`.
3. Update transcript: `h = SHA-256(h || CF_CBOR)`.
4. Compute signature:
   ```
   ClientFinished.signature = ML-DSA-65.Sign(
       secret_key,
       "aafp-v1-handshake" || h)
   ```
5. Insert signature into ClientFinished (key 2).
6. Send ClientFinished.

Receiver (server):
1. Receive ClientFinished.
2. Extract `CF_CBOR = canonical_CBOR(ClientFinished_without_sig)`.
3. Update transcript: `h = SHA-256(h || CF_CBOR)`.
4. Verify `ClientFinished.signature` against `h`.

**Step 5: Session Established**

The final transcript hash `h` (after Step 4) is used for Session ID
derivation (Section 5.7).

#### Key Principle

The signature is ALWAYS computed over `"aafp-v1-handshake" || h` where
`h` is the transcript hash AFTER the current message's CBOR has been
folded in. The receiver ALWAYS updates the transcript hash BEFORE
verifying the signature. This ensures both sides have the same `h`
value at verification time.

### 5.7 Session ID

The Session ID is a cryptographically unique identifier bound to the
authenticated session. It MUST satisfy the following properties:

1. **Uniqueness**: No two sessions between any pair of agents share
   the same Session ID.
2. **Unpredictability**: An adversary cannot predict the Session ID
   before the handshake completes.
3. **Binding**: The Session ID is cryptographically bound to both
   agents' identities and the handshake transcript.

The Session ID MUST be derived using HKDF-SHA256 over the transcript
hash after the ClientHello phase (Section 5.6, Step 2) and both
agents' nonces:

```
prk = HKDF-Extract(
    salt = client_nonce || server_nonce,
    IKM  = h_after_clienthello)
session_id = HKDF-Expand(prk, info = "aafp-session-id-v1", L = 32)
```

Where:
- `h_after_clienthello` is the transcript hash after Step 2 of
  Section 5.6 (after ClientHello CBOR is folded in, before ServerHello).
- `client_nonce` is the 32-byte nonce from ClientHello (key 4).
- `server_nonce` is the 32-byte nonce from ServerHello (key 4).
- Nonce concatenation order: `client_nonce` first, then `server_nonce`
  (64 bytes total).
- HKDF uses SHA-256 as the hash function.
- The `info` string `"aafp-session-id-v1"` is encoded as raw UTF-8
  bytes (no null terminator, no length prefix, no CBOR encoding).

The server computes the Session ID before constructing ServerHello
(it knows `h_after_clienthello` from receiving ClientHello, and it
knows both nonces). The server includes the Session ID in ServerHello
(key 7).

The client computes the Session ID after receiving ServerHello (it
needs the server's nonce). The client MUST verify that the Session ID
in ServerHello (key 7) matches its independently derived value. If
they differ, the client MUST send an ERROR frame with code 2006
(HANDSHAKE_FAILED) and close the connection.

The Session ID is bound to:
- The TLS channel binding (via `h_after_clienthello`)
- The ClientHello content (agent_id, public_key, capabilities,
  extensions)
- Both agents' nonces

It is NOT directly bound to ServerHello content, but the ServerHello
signature covers the full transcript (which includes ServerHello),
and the ClientFinished signature covers the full transcript including
ClientFinished. This provides end-to-end binding.

This derivation is normative (MUST). All implementations MUST use
this exact derivation to ensure session ID interoperability for
future session resumption features.

### 5.8 DoS Mitigation Profile (Optional)

Deployments facing DoS threats (e.g., Internet-facing bootstrap nodes,
public network deployments) SHOULD implement the pre-verification
mechanism described in this section. Private network deployments or
authenticated environments MAY omit it.

The DoS mitigation profile provides cheap HMAC verification (~1μs)
before expensive ML-DSA-65 signature verification (~1ms), reducing
the cost of rejecting invalid ClientHello messages by ~1000x.

This profile is OPTIONAL. Implementations conforming to AAFP v1 are
not required to implement it. However, Internet-facing deployments
SHOULD enable it.

#### Mechanism

When the DoS mitigation profile is active, the ClientHello includes
field 9 (receiver_mac) containing a receiver MAC:

```
mac_key = HKDF-SHA256(
    input = receiver_agent_id,
    info  = "aafp-v1-dos-mac-key",
    L     = 32)
receiver_mac = HMAC-SHA256(
    key  = mac_key,
    data = canonical_CBOR(ClientHello_without_signature_and_receiver_mac))
```

The `canonical_CBOR(ClientHello_without_signature_and_receiver_mac)`
used for the receiver_mac computation is the same byte sequence as
`CH_CBOR` used in the transcript hash (Section 5.6, Step 2). This is
the canonical CBOR encoding of a map with keys 1, 2, 3, 4, 5, 6, 8,
10 (excluding keys 7 and 9), per the signature input encoding rules
in Section 5.6.

The server verifies the receiver_mac (a cheap HMAC operation, ~1μs)
before verifying the ML-DSA-65 signature (~1ms). If the MAC is
invalid, the server rejects the ClientHello with error code 2009
(RECEIVER_MAC_INVALID) without performing signature verification.

The receiver_mac proves that the sender knows the receiver's
AgentId. It does NOT authenticate the sender (the sender's identity
is verified by the ML-DSA-65 signature). The purpose of
receiver_mac is to allow the server to reject messages from
attackers who do not know the server's AgentId, without performing
expensive signature verification.

#### Negotiation

The DoS mitigation profile is negotiated via a handshake extension
(type 0x0001, "dos-mitigation"). The client includes this extension
in ClientHello.extensions if it supports the profile. The server
includes it in ServerHello.extensions if it requires the profile.

If the server requires the profile but the client did not propose
it, the server MUST send an ERROR frame with code 2005
(UNSUPPORTED_EXTENSIONS) and close the connection.

If neither side requires the profile, ClientHello field 9
(receiver_mac) MAY be null. If field 9 is null, the server proceeds
directly to signature verification.

#### Cookie Mechanism (Future)

A cookie-based mechanism (similar to WireGuard's mac2) for
proof-of-IP under load is deferred to a future RFC. The current
profile provides receiver-identity verification but not
source-address verification.

### 5.9 Handshake Error Handling

If the handshake fails, the detecting side MUST send an ERROR frame
with an appropriate error code (see RFC-0005) and close the connection.

Handshake error codes:
- `2001`: Invalid signature (ML-DSA-65 signature verification failed)
- `2002`: Expired or revoked identity (`expires_at` is in the past)
- `2003`: Unknown agent
- `2004`: Protocol version mismatch
- `2005`: Unsupported extensions
- `2006`: Handshake failed (including TLS exporter unavailable)
- `2007`: Invalid AgentId (AgentId does not match SHA-256(public_key))
- `2009`: Receiver MAC invalid (DoS pre-verification failed)
- `2008`: Nonce reuse detected (replay attack, see Section 6.7)
- `2010`: Unsupported key algorithm

### 5.10 Normative Handshake State Machine (Rev 6)

This section defines the complete, normative state machine for the
AAFP handshake and session lifecycle. Implementations MUST conform to
these states, transitions, timeouts, and error handling rules.

#### 5.10.1 Client States

| State | Description |
|-------|-------------|
| `C_IDLE` | No connection initiated. Initial state. |
| `C_CONNECTING` | QUIC connection in progress, TLS handshake underway. |
| `C_CH_SENT` | ClientHello sent on stream 0, awaiting ServerHello. |
| `C_SH_VERIFIED` | ServerHello received and cryptographically verified. Session ID derived. |
| `C_CF_SENT` | ClientFinished sent. Handshake complete. Awaiting authorization. |
| `C_AUTHORIZED` | Authorization verified. Ready to enable messaging. |
| `C_MESSAGING` | Application data flowing. AEAD applied to streams. |
| `C_CLOSING` | CLOSE frame sent. Awaiting peer CLOSE or timeout. |
| `C_CLOSED` | Terminal state. QUIC connection fully closed. |

#### 5.10.2 Server States

| State | Description |
|-------|-------------|
| `S_LISTENING` | Waiting for incoming QUIC connections. Initial state. |
| `S_TRANSPORT_READY` | QUIC + TLS established. Awaiting ClientHello on stream 0. |
| `S_CH_VERIFIED` | ClientHello received and cryptographically verified. |
| `S_SH_SENT` | ServerHello sent. Awaiting ClientFinished. |
| `S_CF_VERIFIED` | ClientFinished received and verified. Handshake complete. |
| `S_AUTHORIZED` | Authorization verified. Ready to enable messaging. |
| `S_MESSAGING` | Application data flowing. AEAD applied to streams. |
| `S_CLOSING` | CLOSE frame sent. Awaiting peer CLOSE or timeout. |
| `S_CLOSED` | Terminal state. QUIC connection fully closed. |

#### 5.10.3 State Diagram

```
Client:                                    Server:

C_IDLE                                     S_LISTENING
  | connect()                                 | QUIC accept + TLS
  v                                           v
C_CONNECTING                               S_TRANSPORT_READY
  | QUIC+TLS done                             | ClientHello received
  | Send ClientHello                          | Verify ClientHello
  v                                           v
C_CH_SENT                                  S_CH_VERIFIED
  | ServerHello received                      | Send ServerHello
  | Verify ServerHello                        v
  v                                         S_SH_SENT
C_SH_VERIFIED                                | ClientFinished received
  | Send ClientFinished                       | Verify ClientFinished
  v                                           v
C_CF_SENT                                  S_CF_VERIFIED
  | Authorization verified                    | Authorization verified
  v                                           v
C_AUTHORIZED                               S_AUTHORIZED
  | Enable messaging                          | Enable messaging
  v                                           v
C_MESSAGING                                S_MESSAGING
  | CLOSE / Fatal ERROR / Transport reset     | CLOSE / Fatal ERROR / Transport reset
  v                                           v
C_CLOSING                                  S_CLOSING
  | Peer CLOSE / Timeout                      | Peer CLOSE / Timeout
  v                                           v
C_CLOSED                                   S_CLOSED
```

#### 5.10.4 Client Transition Table

| Current State | Incoming Event | Validation | Action | Next State | Error Code | Timeout |
|---------------|----------------|------------|--------|------------|------------|---------|
| C_IDLE | `connect()` | — | Open QUIC connection | C_CONNECTING | — | 30s connect timeout |
| C_CONNECTING | QUIC + TLS established | ALPN = `aafp/1`, TLS exporter available | Compute channel binding, send ClientHello on stream 0 | C_CH_SENT | 2004 (ALPN fail), 2006 (no exporter) | 30s |
| C_CONNECTING | QUIC/TLS failure | — | — | C_CLOSED | 2006 | — |
| C_CONNECTING | Timeout | — | — | C_CLOSED | 2006 | 30s |
| C_CH_SENT | HANDSHAKE frame (ServerHello) | Verify: version, agent_id, public_key, signature, expiry, key_algorithm | Derive session_id, send ClientFinished | C_SH_VERIFIED → C_CF_SENT | 2001 (sig), 2007 (agent_id), 2002 (expired), 2004 (version), 2010 (algorithm) | 30s |
| C_CH_SENT | ERROR frame | — | Close connection | C_CLOSED | (from ERROR frame) | — |
| C_CH_SENT | Timeout | — | Send ERROR 2006, close | C_CLOSED | 2006 | 30s |
| C_CH_SENT | Unexpected frame type | Frame type ≠ HANDSHAKE | Send ERROR 2008, close | C_CLOSED | 2008 | — |
| C_CH_SENT | Unexpected stream ID | Stream ID ≠ 0 | Send ERROR 2008, close | C_CLOSED | 2008 | — |
| C_CH_SENT | Duplicate ServerHello | — | Send ERROR 2008, close | C_CLOSED | 2008 | — |
| C_CF_SENT | Authorization success | — | — | C_AUTHORIZED | — | — |
| C_CF_SENT | Authorization failure | — | Send ERROR 3001, close | C_CLOSED | 3001 | — |
| C_CF_SENT | ERROR frame (fatal) | — | Close | C_CLOSED | (from ERROR) | — |
| C_AUTHORIZED | `enable_messaging()` | — | Apply AEAD to streams | C_MESSAGING | — | — |
| C_MESSAGING | `close()` initiated | — | Send CLOSE frame | C_CLOSING | — | 5s close timeout |
| C_MESSAGING | CLOSE frame received | — | Send CLOSE frame in response | C_CLOSING | — | 5s |
| C_MESSAGING | Fatal ERROR frame | — | Close QUIC | C_CLOSED | (from ERROR) | — |
| C_MESSAGING | Transport reset / EOF | — | — | C_CLOSED | — | — |
| C_MESSAGING | Non-fatal ERROR frame | — | Log, continue | C_MESSAGING | — | — |
| C_MESSAGING | Unexpected HANDSHAKE frame | — | Send ERROR 2008, close | C_CLOSED | 2008 | — |
| C_CLOSING | CLOSE frame received | — | Close QUIC connection | C_CLOSED | — | — |
| C_CLOSING | Timeout | — | Close QUIC (force) | C_CLOSED | — | 5s |
| C_CLOSING | Any frame other than CLOSE | — | Discard, continue waiting | C_CLOSING | — | 5s |
| Any non-terminal | Abort (local) | — | Close QUIC immediately | C_CLOSED | — | — |
| Any non-terminal | Fatal ERROR (received) | — | Close QUIC | C_CLOSED | (from ERROR) | — |

#### 5.10.5 Server Transition Table

| Current State | Incoming Event | Validation | Action | Next State | Error Code | Timeout |
|---------------|----------------|------------|--------|------------|------------|---------|
| S_LISTENING | QUIC connection accepted | — | Perform TLS handshake | S_TRANSPORT_READY | — | 30s |
| S_TRANSPORT_READY | QUIC + TLS established | ALPN = `aafp/1`, TLS exporter available | Compute channel binding | S_TRANSPORT_READY | 2004, 2006 | 30s |
| S_TRANSPORT_READY | HANDSHAKE frame (ClientHello) | Verify: version, agent_id, public_key, signature, expiry, key_algorithm, receiver_mac (if present) | — | S_CH_VERIFIED | 2001, 2007, 2002, 2004, 2009, 2010 | 30s |
| S_TRANSPORT_READY | Timeout | — | Close | S_CLOSED | 2006 | 30s |
| S_TRANSPORT_READY | Unexpected frame type | Frame type ≠ HANDSHAKE | Send ERROR 2008, close | S_CLOSED | 2008 | — |
| S_TRANSPORT_READY | Unexpected stream ID | Stream ID ≠ 0 | Send ERROR 2008, close | S_CLOSED | 2008 | — |
| S_CH_VERIFIED | Entry action | Session ID derived, ServerHello constructed and signed | Send ServerHello on stream 0 | S_SH_SENT | — | — |
| S_SH_SENT | HANDSHAKE frame (ClientFinished) | Verify: session_id matches, signature valid | — | S_CF_VERIFIED | 2001 (sig), 2008 (session_id mismatch → nonce reuse) | 30s |
| S_SH_SENT | ERROR frame | — | Close | S_CLOSED | (from ERROR) | — |
| S_SH_SENT | Timeout | — | Send ERROR 2006, close | S_CLOSED | 2006 | 30s |
| S_SH_SENT | Duplicate ClientHello | — | Send ERROR 2008, close | S_CLOSED | 2008 | — |
| S_SH_SENT | Unexpected frame type | Frame type ≠ HANDSHAKE | Send ERROR 2008, close | S_CLOSED | 2008 | — |
| S_CF_VERIFIED | Authorization success | — | — | S_AUTHORIZED | — | — |
| S_CF_VERIFIED | Authorization failure | — | Send ERROR 3001, close | S_CLOSED | 3001 | — |
| S_AUTHORIZED | `enable_messaging()` | — | Apply AEAD to streams | S_MESSAGING | — | — |
| S_MESSAGING | `close()` initiated | — | Send CLOSE frame | S_CLOSING | — | 5s |
| S_MESSAGING | CLOSE frame received | — | Send CLOSE frame in response | S_CLOSING | — | 5s |
| S_MESSAGING | Fatal ERROR frame | — | Close QUIC | S_CLOSED | (from ERROR) | — |
| S_MESSAGING | Transport reset / EOF | — | — | S_CLOSED | — | — |
| S_MESSAGING | Non-fatal ERROR frame | — | Log, continue | S_MESSAGING | — | — |
| S_MESSAGING | Unexpected HANDSHAKE frame | — | Send ERROR 2008, close | S_CLOSED | 2008 | — |
| S_CLOSING | CLOSE frame received | — | Close QUIC | S_CLOSED | — | — |
| S_CLOSING | Timeout | — | Close QUIC (force) | S_CLOSED | — | 5s |
| S_CLOSING | Any frame other than CLOSE | — | Discard, continue waiting | S_CLOSING | — | 5s |
| Any non-terminal | Abort (local) | — | Close QUIC immediately | S_CLOSED | — | — |
| Any non-terminal | Fatal ERROR (received) | — | Close QUIC | S_CLOSED | (from ERROR) | — |

#### 5.10.6 Duplicate and Replay Handling

**Duplicate handshake messages**: If a handshake message is received
that has the same type as one already processed in the current
handshake, the receiver MUST send ERROR 2008 and close the connection.
This includes:
- Duplicate ClientHello at `S_TRANSPORT_READY` or `S_SH_SENT`
- Duplicate ServerHello at `C_CH_SENT`
- Duplicate ClientFinished at `S_SH_SENT`

**Nonce reuse detection (A-9)**: The server MUST maintain a
`ReplayCache` of observed `(agent_id, client_nonce)` pairs and the
client MUST maintain a `ReplayCache` of observed `(agent_id,
server_nonce)` pairs, with a configurable retention window (default:
300 seconds). If a duplicate pair is detected, the recipient MUST
send ERROR 2008 (NONCE_REUSE) and abort the handshake. The replay
check MUST be performed before signature verification. See
Section 6.7 for the full normative specification, including cache
structure, invariants, eviction policy, and concurrency
requirements. See Section 5.10.8 for resource limits.

**Retransmissions**: AAFP handshake messages are NOT retransmitted at
the application layer. QUIC provides reliable delivery. If the QUIC
stream is reset during the handshake, the connection MUST be closed
with error 2006.

#### 5.10.7 Unexpected Frame Handling

| Current State | Allowed Frame Types | All Others |
|---------------|-------------------|------------|
| C_CH_SENT | HANDSHAKE (ServerHello), ERROR | ERROR 2008, close |
| C_SH_VERIFIED → C_CF_SENT | ERROR | ERROR 2008, close |
| C_AUTHORIZED / C_MESSAGING | DATA, RPC_REQUEST, RPC_RESPONSE, PING, PONG, CLOSE, ERROR | ERROR 2008, close |
| C_CLOSING | CLOSE | Discard silently |
| S_TRANSPORT_READY | HANDSHAKE (ClientHello), ERROR | ERROR 2008, close |
| S_SH_SENT | HANDSHAKE (ClientFinished), ERROR | ERROR 2008, close |
| S_CF_VERIFIED → S_AUTHORIZED | ERROR | ERROR 2008, close |
| S_MESSAGING | DATA, RPC_REQUEST, RPC_RESPONSE, PING, PONG, CLOSE, ERROR | ERROR 2008, close |
| S_CLOSING | CLOSE | Discard silently |

HANDSHAKE frames received during `C_MESSAGING` or `S_MESSAGING` state
MUST be rejected with ERROR 2008 and the connection closed. There is
no legitimate reason for a handshake message after the session is
established.

#### 5.10.8 Timeout Specification

| Phase | Default Timeout | Configurable | On Expiry |
|-------|----------------|-------------|-----------|
| QUIC connection establishment | 30 seconds | Yes | Close, error 2006 |
| Waiting for ClientHello (server) | 30 seconds | Yes | Close, error 2006 |
| Waiting for ServerHello (client) | 30 seconds | Yes | Close, error 2006 |
| Waiting for ClientFinished (server) | 30 seconds | Yes | Close, error 2006 |
| Graceful close (waiting for peer CLOSE) | 5 seconds | Yes | Force close QUIC |
| Nonce reuse cache retention (§6.7) | 300 seconds | Yes | Evict entry |

Implementations MAY configure different timeout values but MUST
document the defaults. The minimum handshake timeout is 10 seconds.
The minimum close timeout is 1 second.

#### 5.10.9 Close Behavior

> **Note (Rev 6, A-8):** This section is retained for backward
> compatibility. The normative, complete specification of CLOSE frame
> semantics — including the CloseManager state machine, all
> transitions, crossed close, duplicate handling, timeout behavior,
> resource cleanup, and security considerations — is defined in
> **Section 6.6**. Implementations MUST implement Section 6.6. The
> behavior described below is a summary; in case of conflict,
> Section 6.6 takes precedence.

**Graceful close**: An agent sends a CLOSE frame with code 0 and a
human-readable message. After sending CLOSE, the agent MUST NOT send
any additional frames except a responding CLOSE. The receiver of a
CLOSE frame SHOULD send a CLOSE frame in response and then close the
QUIC connection. If no CLOSE is received within the close timeout
(default 5 seconds), the initiator MUST force-close the QUIC
connection.

**Fatal error close**: An agent sends an ERROR frame with `fatal=true`
and an appropriate error code. The receiver MUST close the QUIC
connection immediately. The sender closes the QUIC connection after
sending the fatal ERROR frame. No response is expected.

**Transport reset**: If the QUIC connection is reset or receives an
EOF without a prior CLOSE frame, the agent MUST transition to the
`C_CLOSED` / `S_CLOSED` state. Outstanding RPCs and DATA streams are
considered failed.

**Crossed CLOSE**: If both agents send CLOSE frames simultaneously
(both transition to `C_CLOSING` / `S_CLOSING`), the connection is
gracefully closed. No error is generated.

**Duplicate CLOSE**: If a CLOSE frame is received while in `C_CLOSING`
or `S_CLOSING` state, it is treated as the peer's response and the
connection is closed. If a second CLOSE is received, it is silently
discarded.

**ERROR after CLOSE**: If an ERROR frame is received while in
`C_CLOSING` or `S_CLOSING` state, it is silently discarded. The
closing process continues.

**Half-closed streams**: After a CLOSE frame is sent, existing
streams that are already open MAY continue to drain (receive
remaining data). No new streams MAY be opened. Streams that are
mid-transfer are terminated when the QUIC connection is closed.

**Outstanding RPCs**: All outstanding RPC requests that have not
received a response at the time of CLOSE are considered failed.
The caller SHOULD be notified with an error indicating connection
closed.

**Outstanding DATA**: All outstanding DATA frames in flight at the
time of CLOSE may be lost. Applications requiring reliable delivery
SHOULD implement application-level acknowledgments.

**Outstanding PING**: A PING frame that has not received a PONG at
the time of CLOSE is considered unanswered. No error is generated;
the connection close itself is the indication.

#### 5.10.10 Cancellation

Either agent MAY abort the connection at any time by closing the
QUIC connection without sending a CLOSE frame. This is an ungraceful
close. The peer will detect the transport reset and transition to
`C_CLOSED` / `S_CLOSED`. This is permitted but discouraged for
normal operation; it SHOULD be used only for emergency shutdown or
when the peer is unresponsive.

#### 5.10.11 Session State Mapping

The handshake states map to the session states defined in RFC-0003
as follows:

| Handshake State (Client) | Handshake State (Server) | Session State (RFC-0003) |
|--------------------------|--------------------------|--------------------------|
| C_IDLE, C_CONNECTING | S_LISTENING | Connecting |
| C_CH_SENT | S_TRANSPORT_READY, S_CH_VERIFIED | TransportEstablished |
| C_SH_VERIFIED, C_CF_SENT | S_SH_SENT | (handshake in progress) |
| C_AUTHORIZED | S_CF_VERIFIED, S_AUTHORIZED | IdentityVerified → AuthorizationVerified |
| C_MESSAGING | S_MESSAGING | Authenticated → MessagingEnabled |
| C_CLOSING | S_CLOSING | Closing |
| C_CLOSED | S_CLOSED | Closed |

### 6.1 Extension Encoding

Extensions are carried in the `Extensions` section of the frame body.
Each extension is encoded as:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         Extension Type        |    Critical   |   Reserved    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Extension Data Length                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|               Extension Data Length (continued)                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Extension Data ...                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field | Size | Description |
|-------|------|-------------|
| Extension Type | 16 bits | Extension type identifier. See RFC-0006 for registry. |
| Critical | 8 bits | If 0x01, the extension is critical. Unknown critical extensions MUST cause the frame to be rejected. If 0x00, unknown extensions MUST be skipped. |
| Reserved | 8 bits | MUST be 0. MUST be ignored by receivers. |
| Extension Data Length | 32 bits | Length of extension data in bytes. Big-endian unsigned integer. |
| Extension Data | Variable | Extension-type-specific data. |

Multiple extensions are concatenated directly within the Extensions
section of the frame body. Each extension is self-delimiting via its
Extension Data Length field. There is no additional framing between
extensions. The total size of all extensions MUST equal the Extension
Length field in the frame header.

Example with two extensions:
```
[Ext1.Type:2][Ext1.Critical:1][Ext1.Reserved:1][Ext1.DataLen:4][Ext1.Data:N]
[Ext2.Type:2][Ext2.Critical:1][Ext2.Reserved:1][Ext2.DataLen:4][Ext2.Data:M]
```

### 6.2 Extension Ordering

Extensions MAY appear in any order. Implementations MUST NOT assume
a specific ordering. If two extensions of the same type appear in a
single frame, the first one MUST be used and subsequent ones MUST be
ignored (or rejected if critical).

### 6.3 Negotiated vs Optional Extensions

- **Optional extensions** (Critical = 0): The sender includes the
  extension; the receiver may ignore it. No negotiation required.
- **Negotiated extensions**: The sender proposes the extension in
  the handshake; the receiver accepts or rejects in its handshake
  response. Once negotiated, the extension is active for the session.
- **Mandatory extensions** (Critical = 1): The sender requires the
  receiver to understand the extension. If the receiver does not
  recognize it, the frame MUST be rejected.

See Section 6.4 for the handshake extension negotiation protocol.
See RFC-0006 for the extension type registry.

### 6.4 Handshake Extension Negotiation

Extensions are negotiated during the handshake. The ClientHello
includes a list of proposed extensions; the ServerHello includes a
list of accepted extensions (a subset of the client's proposals).

#### Extension Entry Format

Each extension entry in the handshake is a CBOR map with integer
keys (per Section 8):

```cbor
ExtensionEntry = {
    1: uint,       // "type": Extension type (see RFC-0006 registry)
    2: bstr,       // "data": Extension-type-specific data
    3: bool,       // "critical": If true, the extension is mandatory.
                   //   If the server does not accept it, the handshake
                   //   MUST fail with error 2005.
                   //   If false, the extension is optional and the
                   //   server MAY silently drop it.
}
```

The ClientHello.extensions field (key 6) is a CBOR array of
ExtensionEntry maps, listing all extensions the client proposes.

The ServerHello.extensions field (key 6) is a CBOR array of
ExtensionEntry maps, listing the extensions the server accepts.
This MUST be a subset of the extensions proposed by the client.
The server MUST NOT include extensions that the client did not
propose.

#### Parameter Negotiation

When a client proposes an extension, the extension data (key 2)
contains the client's proposed parameters. When the server accepts
the extension, the server's extension data (key 2) contains the
server's selected parameters, which MAY differ from the client's
proposal.

The semantics of parameter negotiation are extension-type-specific.
The extension specification MUST define:
- What parameters the client proposes
- What parameters the server may select
- Whether the server must select a subset of the client's proposal
  or may choose independently

Example (hypothetical max-frame-size extension, type 0x0003):
- Client proposes: data = CBOR uint 1048576 (1 MiB)
- Server selects: data = CBOR uint 262144 (256 KiB)
- Both sides use 256 KiB as the maximum frame size for the session.

#### Negotiation Rules

1. The client proposes extensions by including ExtensionEntry maps
   in ClientHello.extensions.
2. The server accepts a subset by including ExtensionEntry maps in
   ServerHello.extensions. The server MAY include extension data
   that differs from the client's proposal (e.g., selecting
   parameters).
3. Extensions not included in ServerHello.extensions are NOT active
   for the session.
4. If the client proposed an extension with `critical = true` (key 3)
   and the server did not accept it (did not include it in
   ServerHello.extensions), the server MUST send an ERROR frame with
   code 2005 (UNSUPPORTED_EXTENSIONS) and close the connection. If
   `critical = false`, the server MAY silently drop the extension.
5. Using a non-negotiated extension in a subsequent frame (after the
   handshake) is a protocol error. The receiver MUST send an ERROR
   frame with code 8007 (INVALID_FLAGS) and close the connection.

#### Relationship to Frame Extensions

Frame-level extensions (Section 6.1) use a binary encoding in the
frame body's Extension section. Handshake-level extensions use CBOR
ExtensionEntry maps in the handshake messages. These are distinct
mechanisms:

- Handshake extensions negotiate session-wide features.
- Frame extensions carry per-frame metadata.

A handshake extension MAY correspond to a frame extension type. For
example, a compression extension negotiated in the handshake would
enable the COMPRESSED flag in DATA frames.

#### Defined Handshake Extensions

| Type | Name | Description |
|------|------|-------------|
| 0x0001 | dos-mitigation | DoS pre-verification profile (Section 5.8) |
| 0x0002–0x3FFF | Reserved | Standards-track (assigned via RFC) |

### 6.5 Normative Extension Processing Order (Rev 6)

This section defines the complete, normative processing pipeline for
all AAFP frames. Implementations MUST execute these phases in the
exact order specified. Each phase MUST either succeed or produce a
typed error with a specific error code. No phase MAY be skipped. No
phase MAY be reordered.

> **Security invariant**: Extension semantics MUST NOT execute before
> successful authentication and authorization. This is the core
> security property of the AAFP frame processing pipeline. Any
> implementation that executes extension callbacks before signature
> verification, AgentId binding, session validation, and authorization
> is non-conformant and vulnerable to forgery attacks.

#### 6.5.1 Processing Pipeline

The following 20 phases MUST be executed in order for every frame
received on any stream:

| Phase | Name | Action | Error Code on Failure | Fatal |
|-------|------|--------|-----------------------|-------|
| 1 | `validate_frame_header` | Read 28-byte header. Validate version = 1. Validate reserved byte = 0. | 8006 (INVALID_VERSION), 8008 (RESERVED_FIELD_NONZERO) | Yes |
| 2 | `validate_lengths` | Validate Payload Length ≤ 1 MiB. Validate Extension Length ≤ 64 KiB. Validate total frame size does not overflow. | 8001 (FRAME_TOO_LARGE) | No (stream-level) |
| 3 | `reject_oversized_before_allocation` | Reject if Payload Length or Extension Length exceeds limits BEFORE any allocation. No buffer MAY be allocated for oversized frames. | 8001 (FRAME_TOO_LARGE) | No |
| 4 | `read_payload` | Read Payload Length bytes from the frame body. | 5001 (MALFORMED_FRAME) | Yes |
| 5 | `read_extensions` | Read Extension Length bytes from the frame body. | 5001 (MALFORMED_FRAME) | Yes |
| 6 | `decode_canonical_cbor` | Decode payload as canonical CBOR (RFC 8949 §4.2.3). Reject indefinite-length. Reject non-shortest integer encoding. | 5003 (SERIALIZATION_ERROR) | Yes |
| 7 | `reject_duplicate_cbor_keys` | Reject CBOR maps with duplicate keys. | 5003 (SERIALIZATION_ERROR) | Yes |
| 8 | `reject_non_canonical_cbor` | Reject CBOR that is not length-first deterministic encoding. | 5003 (SERIALIZATION_ERROR) | Yes |
| 9 | `validate_transcript_state` | For HANDSHAKE frames: verify the transcript hash is in the expected state. | 2006 (HANDSHAKE_FAILED) | Yes |
| 10 | `verify_signatures` | For HANDSHAKE frames: verify the ML-DSA-65 signature over the handshake message. For DATA/RPC frames: verify AEAD authentication tag (if AEAD is active). | 2001 (INVALID_SIGNATURE) | Yes |
| 11 | `verify_agent_id` | Verify AgentId = SHA-256(public_key) matches the claimed identity. | 2007 (INVALID_AGENT_ID) | Yes |
| 12 | `verify_session_state` | Verify the session is in `MessagingEnabled` state (for non-handshake frames) or the correct handshake state (for handshake frames). | 8009 (PROTOCOL_VIOLATION) | Yes |
| 13 | `verify_authorization` | Verify the peer is authorized to perform the requested action. | 3001 (UNAUTHORIZED) | Yes |
| 14 | `verify_required_capabilities` | Verify the peer advertises the capabilities required for the requested action. | 3002 (INSUFFICIENT_CAPABILITY) | Yes |
| 15 | `decode_extensions` | Parse the raw extension bytes into structured Extension objects. Reject malformed extension headers. Reject truncated extensions. | 5001 (MALFORMED_FRAME) | Yes |
| 16 | `check_unknown_critical_extensions` | If any extension has Critical = 1 and is not in the negotiated set, reject. | 8005 (UNKNOWN_CRITICAL_EXTENSION) | Yes |
| 17 | `check_non_negotiated_extensions` | If any extension type was not negotiated during the handshake, reject. | 8007 (INVALID_FLAGS) | Yes |
| 18 | `process_extension_semantics` | Execute extension callbacks. This is the ONLY phase where extension semantics MAY execute. | (extension-specific) | (extension-specific) |
| 19 | `validate_final_state` | Verify the frame did not cause an illegal state transition. | 8009 (PROTOCOL_VIOLATION) | Yes |
| 20 | `deliver_to_upper_layer` | Deliver the decoded, authenticated, authorized message to the application layer. | — | — |

#### 6.5.2 Phase Ordering Invariants

The following invariants are normative and MUST be enforced:

1. **No allocation before size validation** (Phases 1-3): No buffer
   MAY be allocated for payload or extensions until Phase 3 has
   succeeded. This prevents memory exhaustion attacks.

2. **No CBOR semantics before structural validation** (Phases 4-8):
   CBOR decoding MUST NOT begin until the frame has been fully read
   and the header validated.

3. **No extension parsing before authentication** (Phases 9-14):
   Extension bytes MUST NOT be parsed into structured Extension
   objects until signature verification, AgentId binding, session
   validation, and authorization have all succeeded.

4. **No extension semantics before extension validation** (Phases 15-17):
   Extension callbacks MUST NOT execute until all extensions have been
   parsed, unknown critical extensions rejected, and non-negotiated
   extensions rejected.

5. **No application delivery before extension processing** (Phase 18-20):
   The message MUST NOT be delivered to the upper layer until all
   extension semantics have been processed.

#### 6.5.3 Sequence Diagram

```
Receiver                          Frame arrives
  |
  |  Phase 1: validate_frame_header
  |  ├── version == 1?           ── no ──→ ERROR 8006, close
  |  ├── reserved == 0?          ── no ──→ ERROR 8008, close
  |
  |  Phase 2: validate_lengths
  |  ├── payload_len ≤ 1 MiB?    ── no ──→ ERROR 8001, close stream
  |  ├── ext_len ≤ 64 KiB?       ── no ──→ ERROR 8001, close stream
  |
  |  Phase 3: reject_oversized_before_allocation
  |  ├── (no allocation yet)
  |
  |  Phase 4: read_payload
  |  ├── allocate payload buffer
  |  ├── copy payload bytes      ── truncated ──→ ERROR 5001, close
  |
  |  Phase 5: read_extensions
  |  ├── allocate extension buffer
  |  ├── copy extension bytes    ── truncated ──→ ERROR 5001, close
  |
  |  Phase 6: decode_canonical_cbor
  |  ├── decode payload CBOR     ── malformed ──→ ERROR 5003, close
  |
  |  Phase 7: reject_duplicate_cbor_keys
  |  ├── check for dup keys      ── dup found ──→ ERROR 5003, close
  |
  |  Phase 8: reject_non_canonical_cbor
  |  ├── check determinism       ── non-canon ──→ ERROR 5003, close
  |
  |  Phase 9: validate_transcript_state
  |  ├── (handshake only)        ── mismatch ──→ ERROR 2006, close
  |
  |  Phase 10: verify_signatures
  |  ├── verify ML-DSA-65 / AEAD ── fail ──→ ERROR 2001, close
  |
  |  Phase 11: verify_agent_id
  |  ├── SHA-256(pubkey) match?  ── no ──→ ERROR 2007, close
  |
  |  Phase 12: verify_session_state
  |  ├── session in correct state? ── no ──→ ERROR 8009, close
  |
  |  Phase 13: verify_authorization
  |  ├── peer authorized?        ── no ──→ ERROR 3001, close
  |
  |  Phase 14: verify_required_capabilities
  |  ├── capabilities sufficient? ── no ──→ ERROR 3002, close
  |
  |  ═══════════════════════════════════════════════════
  |  ║ AUTHENTICATION AND AUTHORIZATION COMPLETE        ║
  |  ║ Extension semantics MAY now execute.              ║
  |  ═══════════════════════════════════════════════════
  |
  |  Phase 15: decode_extensions
  |  ├── parse extension bytes   ── malformed ──→ ERROR 5001, close
  |
  |  Phase 16: check_unknown_critical_extensions
  |  ├── unknown + critical?     ── yes ──→ ERROR 8005, close
  |
  |  Phase 17: check_non_negotiated_extensions
  |  ├── not negotiated?         ── yes ──→ ERROR 8007, close
  |
  |  Phase 18: process_extension_semantics
  |  ├── execute callbacks       ── error ──→ (extension-specific)
  |
  |  Phase 19: validate_final_state
  |  ├── state legal?            ── no ──→ ERROR 8009, close
  |
  |  Phase 20: deliver_to_upper_layer
  |  ├── deliver to application
  |
  v  Done
```

#### 6.5.4 Failure Ordering

Each failure path MUST specify the error code, connection state, and
close behavior:

| Failure | Error Code | Connection State | Close Behavior |
|---------|-----------|-----------------|----------------|
| Oversized payload (Phase 2-3) | 8001 (FRAME_TOO_LARGE) | Active | Non-fatal ERROR on stream; stream closed, connection continues |
| Oversized extension (Phase 2-3) | 8001 (FRAME_TOO_LARGE) | Active | Non-fatal ERROR on stream; stream closed, connection continues |
| Malformed CBOR (Phase 6-8) | 5003 (SERIALIZATION_ERROR) | Active | Fatal ERROR; connection closed |
| Invalid signature (Phase 10) | 2001 (INVALID_SIGNATURE) | Active | Fatal ERROR; connection closed |
| Invalid AgentId (Phase 11) | 2007 (INVALID_AGENT_ID) | Active | Fatal ERROR; connection closed |
| Invalid session state (Phase 12) | 8009 (PROTOCOL_VIOLATION) | Active | Fatal ERROR; connection closed |
| Unauthorized (Phase 13) | 3001 (UNAUTHORIZED) | Active | Fatal ERROR; connection closed |
| Insufficient capability (Phase 14) | 3002 (INSUFFICIENT_CAPABILITY) | Active | Fatal ERROR; connection closed |
| Unknown critical extension (Phase 16) | 8005 (UNKNOWN_CRITICAL_EXTENSION) | Active | Fatal ERROR; connection closed |
| Non-negotiated extension (Phase 17) | 8007 (INVALID_FLAGS) | Active | Fatal ERROR; connection closed |
| Malformed extension header (Phase 15) | 5001 (MALFORMED_FRAME) | Active | Fatal ERROR; connection closed |
| Truncated extension (Phase 15) | 5001 (MALFORMED_FRAME) | Active | Fatal ERROR; connection closed |
| Invalid version (Phase 1) | 8006 (INVALID_VERSION) | Active | Fatal ERROR; connection closed |
| Reserved field nonzero (Phase 1) | 8008 (RESERVED_FIELD_NONZERO) | Active | Fatal ERROR; connection closed |

#### 6.5.5 Unknown Extension Handling

| Extension Type | Critical | Negotiated | Disposition |
|---------------|----------|------------|-------------|
| Known | Yes | Yes | Process semantics (Phase 18) |
| Known | Yes | No | ERROR 8007, close (Phase 17) |
| Known | No | Yes | Process semantics (Phase 18) |
| Known | No | No | ERROR 8007, close (Phase 17) |
| Unknown | Yes | — | ERROR 8005, close (Phase 16) |
| Unknown | No | — | Ignore silently, continue (Phase 18 skips this extension) |

Unknown non-critical extensions MUST NOT cause extension callback
invocation. They MUST be silently ignored. The frame processing
continues with the remaining extensions.

#### 6.5.6 Extension Callback Invocation Count

For every failure in Phases 1-17, the extension callback invocation
count MUST be zero. No extension callback MAY execute before Phase 18.

For a successful frame:
- Each known, negotiated extension invokes its callback exactly once.
- Unknown non-critical extensions do not invoke any callback.
- Unknown critical extensions cause rejection (Phase 16).

#### 6.5.7 Handshake Frame Specialization

For HANDSHAKE frames (type 0x02) on stream 0:
- Extensions are forbidden (Extension Length MUST be 0). If
  Extension Length > 0, the receiver MUST send ERROR 8009
  (PROTOCOL_VIOLATION) and close the connection.
- Phases 15-18 are skipped (no frame extensions to process).
- Handshake-level extensions (CBOR ExtensionEntry maps in the
  handshake payload) are processed during Phase 10 (signature
  verification includes the full transcript, which contains the
  handshake extensions).

For DATA, RPC_REQUEST, RPC_RESPONSE, PING, PONG, CLOSE, and ERROR
frames:
- All 20 phases apply.
- Phases 9 (transcript) and 10 (signature) use AEAD authentication
  instead of ML-DSA-65 signatures when AEAD is active.

#### 6.5.8 Examples

**Example 1: Valid DATA frame with one known extension**

```
1. Header: version=1, type=0x01 (DATA), flags=0, stream_id=4,
   payload_len=100, ext_len=12
2. Lengths: 100 ≤ 1MiB ✓, 12 ≤ 64KiB ✓
3. No oversized → proceed
4. Read 100 bytes payload
5. Read 12 bytes extensions
6. Decode payload (application data, not CBOR) → skip Phase 6-8
7-8. (skipped for DATA)
9. (skipped for DATA)
10. AEAD verify → ✓
11. AgentId already verified during handshake → ✓
12. Session = MessagingEnabled → ✓
13. Authorized → ✓
14. Capabilities sufficient → ✓
15. Decode extensions: [type=0x0001, critical=false, data=4 bytes]
16. No unknown critical extensions → ✓
17. Extension 0x0001 was negotiated → ✓
18. Process extension 0x0001 callback → ✓
19. State still MessagingEnabled → ✓
20. Deliver DATA to application → ✓

Extension callback count: 1
```

**Example 2: Frame with invalid signature**

```
1. Header: version=1, type=0x02 (HANDSHAKE), stream_id=0,
   payload_len=500, ext_len=0
2-3. Lengths OK
4. Read 500 bytes payload
5. Read 0 bytes extensions
6-8. CBOR decode OK
9. Transcript state OK
10. Verify signature → FAIL (signature does not match)

→ ERROR 2001 (INVALID_SIGNATURE), fatal, close connection

Extension callback count: 0
```

**Example 3: Frame with unknown critical extension**

```
1-14. All validation passes (authenticated, authorized)
15. Decode extensions: [type=0xBEEF, critical=true, data=2 bytes]
16. 0xBEEF is not in known types AND critical=true

→ ERROR 8005 (UNKNOWN_CRITICAL_EXTENSION), fatal, close

Extension callback count: 0
```

**Example 4: Frame with oversized extension**

```
1. Header: version=1, type=0x01, payload_len=100, ext_len=70000
2. ext_len 70000 > 64 KiB (65536)

→ ERROR 8001 (FRAME_TOO_LARGE), non-fatal, close stream

Extension callback count: 0
No allocation occurred for the 70000-byte extension.
```

### 6.6 Normative CLOSE Frame Semantics (Rev 6)

This section defines the complete, normative lifecycle of a CLOSE
frame (frame type 0x05, Section 4.5). Implementations MUST implement
a CloseManager that tracks the close state of a connection and
enforces the invariants specified here. The CloseManager is the
single authority for all close-related state transitions; the
handshake state machine (Section 5.10) consults it before accepting
or discarding a CLOSE frame.

#### 6.6.1 CloseManager State Machine

The CloseManager tracks one of five states per connection:

| State | Description |
|-------|-------------|
| `Open` | No CLOSE sent or received. Application data flows normally. |
| `LocalCloseSent` | Local agent has sent a CLOSE frame. Awaiting peer CLOSE or timeout. |
| `RemoteCloseReceived` | Remote agent has sent a CLOSE frame. Local agent should respond with CLOSE. |
| `CloseReceived` | Both sides have exchanged CLOSE frames (crossed or sequential). Connection is being torn down. |
| `Closed` | Terminal. QUIC connection has been closed. No further frames may be sent or received. |

The normative transition table:

| Current State | Event | Action | Next State |
|---------------|-------|--------|------------|
| `Open` | `initiate_close(code, msg)` | Send CLOSE frame, start close timer | `LocalCloseSent` |
| `Open` | CLOSE frame received | Record remote code/msg, send responding CLOSE, start close timer | `RemoteCloseReceived` |
| `LocalCloseSent` | CLOSE frame received | Stop close timer, close QUIC | `CloseReceived` → `Closed` |
| `LocalCloseSent` | Close timer expired | Force-close QUIC | `Closed` |
| `LocalCloseSent` | Any non-CLOSE frame received | Silently discard, remain in state | `LocalCloseSent` |
| `RemoteCloseReceived` | `respond_close()` called | Send CLOSE frame, stop timer | `CloseReceived` → `Closed` |
| `RemoteCloseReceived` | Close timer expired | Force-close QUIC (peer did not wait) | `Closed` |
| `RemoteCloseReceived` | Second CLOSE frame received | Silently discard (duplicate) | `RemoteCloseReceived` |
| `CloseReceived` | Entry action | Close QUIC connection | `Closed` |
| `Closed` | Any event | No-op (terminal) | `Closed` |

**Invariants:**

1. **At most one outbound CLOSE**: A CloseManager in `LocalCloseSent`,
   `CloseReceived`, or `Closed` state MUST NOT send a second CLOSE
   frame. A call to `initiate_close()` in these states is a no-op
   that returns success (idempotent).

2. **At most one responding CLOSE**: A CloseManager in
   `RemoteCloseReceived` state that transitions to `CloseReceived`
   sends exactly one responding CLOSE. If already in `CloseReceived`
   or `Closed`, no further CLOSE is sent.

3. **No data after CLOSE sent**: Once a CloseManager enters
   `LocalCloseSent`, the connection MUST NOT send DATA,
   RPC_REQUEST, RPC_RESPONSE, PING, or PONG frames. Only a
   responding CLOSE (in `RemoteCloseReceived` → `CloseReceived`) is
   permitted. This invariant is enforced by the CloseManager's
   `can_send(frame_type)` method.

4. **Terminal state is irreversible**: Once `Closed`, no transition
   out is possible. All events are no-ops.

5. **Timer discipline**: The close timer is started when entering
   `LocalCloseSent` or `RemoteCloseReceived`. It is stopped when the
   peer's CLOSE is received (`LocalCloseSent`) or when the local
   responding CLOSE is sent (`RemoteCloseReceived`). On expiry, the
   QUIC connection is force-closed.

#### 6.6.2 Close Initiation

An agent initiates a graceful close by calling
`CloseManager.initiate_close(code, message)`:

1. If the CloseManager is not in `Open` state, return success
   (idempotent — the close is already in progress).
2. Construct a `CloseMessage` with the given `code` (uint) and
   `message` (tstr).
3. Encode the `CloseMessage` as canonical CBOR (Section 8).
4. Build a CLOSE frame (type 0x05) with stream_id=0, flags=0, no
   extensions, and the encoded payload.
5. Send the frame on the control stream (stream 0).
6. Transition to `LocalCloseSent` and start the close timer.

**Close code semantics:**

| Code | Meaning | When to use |
|------|---------|-------------|
| 0 | Normal shutdown | Application-initiated graceful close |
| 1000 | Going away | Application is shutting down all connections |
| 1001 | Protocol error | Protocol violation detected (non-fatal) |
| 1002 | Unsupported extension | Required extension not negotiated |
| Non-zero RFC-0005 codes | Error-specific | Match the error condition per RFC-0005 |

Code 0 SHOULD be used for normal application shutdown. Non-zero
codes indicate an abnormal close. The `message` field SHOULD be a
human-readable ASCII or UTF-8 string not exceeding 256 bytes.

#### 6.6.3 Close Reception

When a CLOSE frame is received and passes pipeline validation
(Section 6.5), the CloseManager processes it via
`on_close_received(code, message)`:

1. If the CloseManager is in `Open` state:
   a. Record the remote close code and message.
   b. Transition to `RemoteCloseReceived`.
   c. Start the close timer.
   d. The caller SHOULD call `respond_close(0, "ack")` to send a
      responding CLOSE frame, then close the QUIC connection.
   e. If the caller does not respond within the close timeout, the
      CloseManager force-closes the QUIC connection.

2. If the CloseManager is in `LocalCloseSent` state:
   a. This is the peer's responding CLOSE (or a crossed CLOSE).
   b. Stop the close timer.
   c. Transition to `CloseReceived`, then `Closed`.
   d. Close the QUIC connection.

3. If the CloseManager is in `RemoteCloseReceived` state:
   a. This is a duplicate CLOSE (the peer sent two). Silently
      discard. Do not transition.

4. If the CloseManager is in `CloseReceived` or `Closed` state:
   a. Silently discard. No-op.

#### 6.6.4 Crossed CLOSE (Simultaneous Close)

If both agents send CLOSE frames before receiving the other's CLOSE,
the CloseManagers on both sides will be in `LocalCloseSent` when the
peer's CLOSE arrives. Both transition to `CloseReceived` → `Closed`.
This is a **crossed close** and is graceful — no error is generated.

The close timer on each side is stopped upon receipt of the peer's
CLOSE, so no timeout fires.

#### 6.6.5 Close Timeout

The close timeout governs how long an agent waits for the peer's
CLOSE before force-closing the QUIC connection.

| Parameter | Default | Minimum | Configurable |
|-----------|---------|---------|-------------|
| Close timeout | 5 seconds | 1 second | Yes |

On timeout in `LocalCloseSent`: The peer did not respond. Force-close
the QUIC connection. Transition to `Closed`. Outstanding RPCs and
streams are failed.

On timeout in `RemoteCloseReceived`: The local agent did not send a
responding CLOSE in time (this is a local bug or slow application).
Force-close the QUIC connection. Transition to `Closed`.

#### 6.6.6 Frame Disposition During Close

The CloseManager cooperates with the handshake state machine
(Section 5.10) to determine frame disposition:

| CloseManager State | Frame Type | Disposition |
|--------------------|------------|-------------|
| `Open` | Any allowed frame | Accept (per handshake state machine) |
| `LocalCloseSent` | CLOSE (0x05) | Accept (peer's response) |
| `LocalCloseSent` | Any other | Discard silently |
| `RemoteCloseReceived` | CLOSE (0x05) | Discard silently (duplicate) |
| `RemoteCloseReceived` | Any other | Discard silently |
| `CloseReceived` | Any | Discard silently |
| `Closed` | Any | Discard silently |

**No ERROR is sent for frames received during close.** The
connection is being torn down; sending ERROR frames would violate
the "no frames after CLOSE sent" invariant (for `LocalCloseSent`)
and is pointless (for `RemoteCloseReceived`).

#### 6.6.7 Outstanding Resources on Close

When the CloseManager transitions to `Closed`, the following
resource cleanup MUST occur:

| Resource | Action |
|----------|--------|
| Outstanding RPC requests | Mark as failed with error `1003` (STREAM_CLOSED). Notify callers. |
| Outstanding RPC responses (being sent) | Cancel. The peer will not receive them. |
| Open DATA streams | Terminate. In-flight data may be lost. |
| Pending PING frames | Mark as unanswered. No error generated. |
| Close timer | Cancel. |
| Stream receive buffers | Drain and discard. |
| AEAD send/recv contexts | Zeroize. |
| Session state | Transition to `Closed` (RFC-0003). |

Applications requiring reliable delivery of in-flight DATA frames
SHOULD implement application-level acknowledgments and retry on a
new connection.

#### 6.6.8 Fatal ERROR vs CLOSE

A fatal ERROR frame (Section 4.6, `fatal=true`) is distinct from a
CLOSE frame:

| Property | CLOSE frame | Fatal ERROR frame |
|----------|-------------|-------------------|
| Frame type | 0x05 | 0x06 |
| Payload | CloseMessage | ErrorMessage |
| Response expected | Yes (peer SHOULD send CLOSE) | No |
| CloseManager state after send | `LocalCloseSent` | `Closed` (immediate) |
| Peer action | Send CLOSE, close QUIC | Close QUIC immediately |
| Use case | Graceful shutdown | Protocol error, security violation |

A fatal ERROR bypasses the CloseManager's graceful path. The
CloseManager transitions directly to `Closed`. The peer, upon
receiving a fatal ERROR, also transitions its CloseManager to
`Closed` and closes the QUIC connection without sending a CLOSE.

#### 6.6.9 Transport Reset (Ungraceful Close)

If the QUIC connection is reset or receives an EOF without a prior
CLOSE frame, the CloseManager transitions directly to `Closed`:

1. If in `Open` or `LocalCloseSent` or `RemoteCloseReceived`:
   transition to `Closed`.
2. Cancel the close timer if running.
3. Fail all outstanding RPCs and streams.
4. This is an ungraceful close. No CLOSE frame is sent (the
   transport is gone).

#### 6.6.10 CloseManager API Summary

Implementations MUST provide a CloseManager with the following
interface (language-agnostic):

```
state: CloseState  // current state, initially Open
remote_code: Option<u32>  // code from peer's CLOSE, if received
remote_message: Option<String>  // message from peer's CLOSE
close_timeout: Duration  // configurable, default 5s, min 1s
timer_active: bool

// Queries
can_send(frame_type: u8) -> bool
is_closed() -> bool
is_closing() -> bool  // true if LocalCloseSent, RemoteCloseReceived, or CloseReceived

// Commands
initiate_close(code: u32, message: String) -> Result<CloseAction, Error>
on_close_received(code: u32, message: String) -> Result<CloseAction, Error>
on_fatal_error_received() -> CloseAction
on_transport_reset() -> CloseAction
on_timeout() -> CloseAction
respond_close(code: u32, message: String) -> Result<CloseAction, Error>
```

`CloseAction` is an enum describing what the caller should do:

| Variant | Meaning |
|---------|---------|
| `SendCloseFrame(code, message)` | Encode and send a CLOSE frame |
| `CloseQuic` | Close the QUIC connection |
| `None` | No action needed (e.g., duplicate, already closed) |

#### 6.6.11 Sequence Diagrams

**Normal graceful close (client initiates):**

```
Client                                         Server
  |                                              |
  |  initiate_close(0, "goodbye")                |
  |  → SendCloseFrame                            |
  |  state = LocalCloseSent, timer starts        |
  |                                              |
  |  CLOSE frame (code=0, "goodbye")             |
  |--------------------------------------------->|
  |                                              |  on_close_received(0, "goodbye")
  |                                              |  state = RemoteCloseReceived
  |                                              |  respond_close(0, "ack")
  |                                              |  → SendCloseFrame
  |                                              |  state = CloseReceived → Closed
  |                                              |  → CloseQuic
  |  CLOSE frame (code=0, "ack")                 |
  |<---------------------------------------------|
  |  on_close_received(0, "ack")                 |
  |  state = CloseReceived → Closed              |
  |  timer stopped                               |
  |  → CloseQuic                                 |
  |                                              |
  X                                              X
```

**Crossed close (simultaneous):**

```
Client                                         Server
  |                                              |
  |  initiate_close(0, "bye")                    |  initiate_close(0, "bye")
  |  state = LocalCloseSent                      |  state = LocalCloseSent
  |                                              |
  |  CLOSE frame (code=0, "bye")                 |  CLOSE frame (code=0, "bye")
  |--------------------------------------------->|<-----------------------------|
  |<---------------------------------------------|                              |
  |                                              |                              |
  |  on_close_received(0, "bye")                 |  on_close_received(0, "bye")
  |  state = CloseReceived → Closed              |  state = CloseReceived → Closed
  |  → CloseQuic                                 |  → CloseQuic
  X                                              X
```

**Close timeout (peer unresponsive):**

```
Client                                         Server
  |                                              |
  |  initiate_close(0, "goodbye")                |
  |  state = LocalCloseSent, timer=5s            |
  |                                              |
  |  CLOSE frame (code=0, "goodbye")             |
  |--------------------------------------------->|
  |                                              |  (server is hung / network loss)
  |                                              |
  |  ... 5 seconds pass ...                      |
  |  timer expires                               |
  |  on_timeout()                                |
  |  state = Closed                              |
  |  → CloseQuic (force)                         |
  X                                              |
```

#### 6.6.12 Security Considerations for CLOSE

1. **Close code validation**: The `code` field in a CLOSE frame MUST
   be a valid uint. Unknown codes MUST NOT cause the CloseManager to
   reject the frame — the connection is closing anyway. The code is
   informational.

2. **Message length limit**: The `message` field SHOULD be limited
   to 256 bytes. Implementations MAY truncate or reject messages
   longer than 256 bytes. A CLOSE frame with an oversized message
   is still a valid CLOSE — the CloseManager SHOULD accept it and
   truncate the message for logging.

3. **No close amplification**: A single received CLOSE frame results
   in at most one sent CLOSE frame. The CloseManager MUST NOT send
   multiple CLOSE frames in response to a single received CLOSE
   (duplicate CLOSE frames are silently discarded).

4. **Close timer as DoS mitigation**: The close timeout (default 5s)
   bounds the time a connection spends in the closing state. An
   attacker cannot keep a connection half-open indefinitely by
   sending a CLOSE and then stalling.

5. **Resource cleanup is mandatory**: On transition to `Closed`, all
   outstanding resources (RPCs, streams, timers, buffers, crypto
   contexts) MUST be cleaned up. A CloseManager that leaks resources
   is a denial-of-service vector.

### 6.7 Normative Nonce Replay Detection (Rev 6 A-9)

This section defines the complete, normative replay-protection
mechanism for AAFP handshakes. Implementations MUST implement a
`ReplayCache` that tracks observed handshake nonces and rejects
replayed handshakes before cryptographic verification is performed.
The `ReplayCache` is the single authority for cross-connection nonce
uniqueness; the handshake state machine (Section 5.10) consults it
upon receipt of a ClientHello (server side) or ServerHello (client
side).

#### 6.7.1 Threat Model

An attacker records a legitimate handshake message (ClientHello or
ServerHello) and retransmits it to the original recipient in a new
QUIC connection. Without replay detection, the recipient would:

1. Allocate CPU for signature verification (DoS amplification).
2. Derive a session ID that collides with the original session
   (session-ID aliasing).
3. In a stateful server, consume a connection slot and handshake
   timer.

Although the attacker cannot complete the handshake (the
ClientFinished / ServerHello signature requires the peer's private
key), the replay itself is a resource-exhaustion and session-aliasing
vector. The `ReplayCache` rejects replays **before** signature
verification, conserving CPU and preventing session-ID collisions.

**In-scope attacks**:
- Replay of a recorded ClientHello to a server.
- Replay of a recorded ServerHello to a client.
- Cross-connection replay (same nonce on a new QUIC connection).

**Out-of-scope** (mitigated by other mechanisms):
- Intra-handshake duplicate messages (Section 5.10.6).
- AgentRecord replay (mitigated by `record_version`, A-3).
- Man-in-the-middle (mitigated by ML-DSA signatures + TLS 1.3).

#### 6.7.2 ReplayCache Structure

A `ReplayCache` is a time-bounded set of observed nonces. Each entry
records:

| Field | Type | Description |
|-------|------|-------------|
| `nonce` | bstr (32 bytes) | The handshake nonce (ClientHello key 4 or ServerHello key 4). |
| `agent_id` | bstr (32 bytes) | The AgentId of the peer that produced the nonce. Used as a scope key to avoid false positives across agents. |
| `inserted_at` | timestamp | When the entry was inserted (monotonic clock). |
| `expires_at` | timestamp | `inserted_at + retention`. Entries are eligible for eviction after this time. |

The cache key is the tuple `(agent_id, nonce)`. A nonce is considered
a replay if and only if an entry with the same `(agent_id, nonce)`
exists and has not expired.

**Rationale for `agent_id` scoping**: A 32-byte random nonce has a
collision probability below 2^-120 for any realistic number of
handshakes. Scoping by `agent_id` is defense-in-depth: it ensures
that a nonce collision between two different agents (which would be
statistically extraordinary) does not cause a false-positive replay
rejection. It also allows per-agent cache partitioning for
implementations that shard the cache.

#### 6.7.3 Cache Parameters

| Parameter | Default | Minimum | Maximum | Configurable |
|-----------|---------|---------|---------|-------------|
| `retention` | 300 seconds | 60 seconds | 3600 seconds | Yes |
| `max_entries` | 100,000 | 1,000 | 10,000,000 | Yes |
| `eviction_policy` | `expire-lru` | — | — | Yes |

- **`retention`**: How long a nonce entry remains valid after
  insertion. After `retention` elapses, the entry is eligible for
  eviction and a replay of that nonce is no longer rejected (it is
  treated as a fresh handshake). This bounds memory usage and
  accommodates clock drift across connections.
- **`max_entries`**: Upper bound on cache size. When the cache is full
  and a new entry must be inserted, the implementation MUST evict
  expired entries first. If no expired entries exist, the
  least-recently-used non-expired entry is evicted (`expire-lru`
  policy). This prevents unbounded memory growth under load.
- **`eviction_policy`**: `expire-lru` evicts expired entries first,
  then LRU. Implementations MAY support other policies but MUST
  document them.

#### 6.7.4 Normative Invariants

1. **Check-before-verify**: The replay check MUST be performed before
   signature verification. This ensures that a replayed handshake
   does not consume signature-verification CPU.

2. **Insert-after-verify** (server side): The server MUST insert the
   `(agent_id, client_nonce)` entry into the cache **after** the
   ClientHello signature is verified but **before** the ServerHello is
   sent. This prevents an attacker from poisoning the cache with
   invalid nonces that would block a legitimate client.

3. **Insert-after-verify** (client side): The client MUST insert the
   `(agent_id, server_nonce)` entry into the cache **after** the
   ServerHello signature is verified but **before** the ClientFinished
   is sent.

4. **Atomicity**: The check-and-insert operation MUST be atomic with
   respect to concurrent handshakes. If two connections arrive with
   the same `(agent_id, nonce)` simultaneously, exactly one MUST
   succeed and the other MUST receive `NONCE_REUSE`.

5. **No silent acceptance**: If a replay is detected, the recipient
   MUST send ERROR 2008 (NONCE_REUSE) and close the connection. The
   recipient MUST NOT silently discard the handshake or proceed with
   it.

6. **Eviction is non-blocking**: Eviction of expired entries MAY
   happen lazily (on access) or via a background sweep. Eviction MUST
   not block handshake processing for longer than 1 millisecond.

7. **Persistence is optional**: The `ReplayCache` MAY be in-memory
   only. If an implementation persists the cache across restarts, it
   MUST use a monotonic or hybrid logical clock to avoid evicting
   entries too early after a clock reset.

#### 6.7.5 Server-Side Replay Check

When a server receives a ClientHello in state `S_TRANSPORT_READY`:

1. Extract `client_nonce` (key 4) and `agent_id` (key 2) from the
   ClientHello.
2. Validate that `client_nonce` is exactly 32 bytes. If not, send
   ERROR 2008 and close.
3. Query the `ReplayCache` for `(agent_id, client_nonce)`.
   - If a non-expired entry exists: send ERROR 2008 (NONCE_REUSE),
     close the connection, and abort the handshake. Do NOT verify the
     signature.
   - If no entry exists (or the entry has expired): proceed to step 4.
4. Verify the ClientHello signature (Section 5.6).
   - If verification fails: send ERROR 2001 (INVALID_SIGNATURE) and
     close. Do NOT insert into the cache.
5. Insert `(agent_id, client_nonce)` into the `ReplayCache` with
   `expires_at = now + retention`.
6. Proceed to send ServerHello.

#### 6.7.6 Client-Side Replay Check

When a client receives a ServerHello in state `C_CH_SENT`:

1. Extract `server_nonce` (key 4) and `agent_id` (key 2) from the
   ServerHello.
2. Validate that `server_nonce` is exactly 32 bytes. If not, send
   ERROR 2008 and close.
3. Query the `ReplayCache` for `(agent_id, server_nonce)`.
   - If a non-expired entry exists: send ERROR 2008 (NONCE_REUSE),
     close the connection, and abort the handshake. Do NOT verify the
     signature.
   - If no entry exists (or the entry has expired): proceed to step 4.
4. Verify the ServerHello signature (Section 5.6) and session ID
   (Section 5.7).
   - If verification fails: send the appropriate ERROR (2001 or 2008)
     and close. Do NOT insert into the cache.
5. Insert `(agent_id, server_nonce)` into the `ReplayCache` with
   `expires_at = now + retention`.
6. Proceed to send ClientFinished.

#### 6.7.7 Eviction and Resource Management

The `ReplayCache` MUST NOT grow without bound. The implementation
MUST enforce `max_entries`:

1. **Lazy eviction**: On every `check()` or `insert()`, the
   implementation MAY scan a small batch of entries and remove those
   with `expires_at <= now`. This is the recommended approach for
   in-memory caches.
2. **Background sweep**: A background task MAY periodically sweep the
   cache and remove expired entries. The sweep interval SHOULD be
   `retention / 4` but not less than 10 seconds.
3. **LRU fallback**: When the cache is at `max_entries` and no expired
   entries can be evicted, the least-recently-accessed entry is
   evicted. The evicted entry's nonce becomes eligible for replay
   again; this is an accepted trade-off to prevent OOM.

**Memory budget**: At `max_entries = 100,000`, each entry is
approximately 96 bytes (32-byte nonce + 32-byte agent_id + 16-byte
timestamps + 16-byte overhead), yielding ~9.6 MB. Implementations
SHOULD document their memory budget.

#### 6.7.8 Concurrency Requirements

The `ReplayCache` MUST be safe for concurrent access from multiple
handshake goroutines / tasks. The check-and-insert operation (steps
3-5 in §6.7.5 / §6.7.6) MUST be atomic: if two handshakes with the
same `(agent_id, nonce)` arrive concurrently, exactly one MUST
proceed and the other MUST receive `NONCE_REUSE`.

Implementations SHOULD use a sharded lock or lock-free data structure
to minimize contention. A single global mutex is acceptable for
correctness but may become a bottleneck under high load.

#### 6.7.9 ReplayCache API Summary

```
struct ReplayCache {
    fn new(retention: Duration, max_entries: usize) -> Self;
    fn with_capacity(retention: Duration, max_entries: usize, capacity: usize) -> Self;

    /// Check if (agent_id, nonce) is a replay. Does NOT insert.
    /// Returns true if a non-expired entry exists (replay detected).
    fn check(&self, agent_id: &[u8], nonce: &[u8; 32]) -> bool;

    /// Atomically check-and-insert. Returns Ok(()) if the nonce is
    /// fresh (inserted), Err(()) if it is a replay (already present).
    fn check_and_insert(&mut self, agent_id: &[u8], nonce: &[u8; 32]) -> Result<(), ()>;

    /// Insert a nonce without checking. Used when the caller has
    /// already verified uniqueness via check().
    fn insert(&mut self, agent_id: &[u8], nonce: &[u8; 32]);

    /// Evict all expired entries. Returns the number evicted.
    fn evict_expired(&mut self) -> usize;

    /// Current number of entries (including expired, not yet swept).
    fn len(&self) -> usize;

    /// Whether the cache is empty.
    fn is_empty(&self) -> bool;

    /// Configured retention duration.
    fn retention(&self) -> Duration;

    /// Configured max entries.
    fn max_entries(&self) -> usize;
}
```

The `check_and_insert` method is the primary entry point for
handshake integration (§6.7.5 step 3-5, §6.7.6 step 3-5). It
combines the replay check and cache insertion into a single atomic
operation, satisfying Invariant 4.

#### 6.7.10 Sequence Diagrams

**Normal handshake (no replay)**:
```
Client                          Server
  |                               |
  |--- ClientHello (nonce=N1) --->|
  |                               | check_and_insert(A, N1) -> Ok
  |                               | verify signature -> Ok
  |<--- ServerHello (nonce=N2) ---|
  | check_and_insert(B, N2) -> Ok |
  | verify signature -> Ok        |
  |--- ClientFinished ------------>|
  |                               | handshake complete
```

**Replayed ClientHello (server-side detection)**:
```
Attacker                        Server
  |                               |
  |--- ClientHello (nonce=N1) --->|  (recorded from prior session)
  |                               | check_and_insert(A, N1) -> Err (replay)
  |                               | send ERROR 2008
  |<--- ERROR 2008 ---------------|
  |                               | close connection
  |  (signature NOT verified)     |
```

**Replayed ServerHello (client-side detection)**:
```
Server                          Client(Attacker target)
  |                               |
  |--- ServerHello (nonce=N2) --->|  (recorded from prior session)
  |                               | check_and_insert(B, N2) -> Err (replay)
  |                               | send ERROR 2008
  |<--- ERROR 2008 ---------------|
  |                               | close connection
  |  (signature NOT verified)     |
```

**Concurrent replay (race resolution)**:
```
Attacker A  ──ClientHello(N1)──>  Server
Attacker B  ──ClientHello(N1)──>  Server
                                     |
                                     | check_and_insert(A, N1):
                                     |   A wins -> Ok,  B gets Err
                                     | A: verify sig -> Ok -> ServerHello
                                     | B: send ERROR 2008 -> close
```

#### 6.7.11 Security Considerations for Replay Detection

1. **Check-before-verify is critical**: If signature verification
   precedes the replay check, an attacker can amplify CPU consumption
   by replaying the same ClientHello many times. Each replay would
   trigger a full ML-DSA-65 verification (~1 ms). The replay check
   MUST be O(1) or O(log n) and MUST precede verification.

2. **Cache poisoning prevention**: By inserting into the cache only
   after signature verification (Invariant 2, 3), an attacker cannot
   block a legitimate client by sending a forged ClientHello with the
   client's `agent_id` and a guessed nonce. The forged message would
   fail signature verification and would not be inserted.

3. **Retention window trade-off**: A longer `retention` provides
   stronger replay protection but consumes more memory. The default
   of 300 seconds is chosen to cover the maximum expected handshake
   duration (30 s timeout × 3 phases = 90 s) with a safety margin.
   A retention shorter than the handshake timeout creates a window
   where a nonce can be reused after the original handshake has
   timed out but before the peer has cleaned up; implementations
   SHOULD set `retention >= 4 × handshake_timeout`.

4. **False positives are impossible**: Because nonces are 32 random
   bytes, the probability of a legitimate client generating the same
   nonce twice within the retention window is negligible
   (birthday bound: ~2^-120 for 100,000 handshakes). False positives
   would only occur if the client's RNG is broken, which is a
   separate security failure.

5. **Cache exhaustion**: Under a DDoS with many unique nonces, the
   cache may reach `max_entries` and begin LRU eviction. This
   degrades replay protection but does not break the protocol: the
   signature verification still prevents an attacker from completing
   a replayed handshake. The `max_entries` limit is a safety valve,
   not a security boundary.

6. **Cross-restart persistence**: If the cache is in-memory only, a
   server restart clears all entries, allowing replays of nonces
   from before the restart. This is acceptable because the
   legitimate client's nonce is fresh per connection; a replay
   would only succeed if the attacker replays within the new
   retention window, which requires the original client to have
   connected immediately before the restart. Implementations with
   strict replay requirements MAY persist the cache to disk.

7. **Interaction with session resumption**: AAFP does not currently
   define session resumption. If a future extension allows session
   resumption (reusing a session ID across connections), the replay
   cache MUST be consulted before resumption to prevent replay of
   the resumption ticket.

## 7. Stream Multiplexing

### 7.1 Stream IDs

Stream IDs are 64-bit unsigned integers. The low bit indicates
initiator:

- Even stream IDs: Client-initiated
- Odd stream IDs: Server-initiated

Stream 0 is reserved for the handshake. Streams 1 and 2 are reserved
for future protocol use. Application streams start at stream ID 4
(client-initiated) or 5 (server-initiated).

### 7.2 Stream Lifecycle

1. **Open**: An agent opens a QUIC bidirectional stream and sends
   one or more DATA frames on it.
2. **Active**: Both agents may send and receive frames on the stream.
3. **Half-close**: An agent finishes sending by closing the send
   side of the QUIC stream. The receive side remains open.
4. **Closed**: Both sides are closed. The stream ID may not be reused.

### 7.3 Flow Control

QUIC provides per-stream and per-connection flow control. AAFP does
not add additional flow control. Implementations SHOULD rely on QUIC's
built-in flow control.

## 8. CBOR Encoding Rules

### 8.1 Canonical CBOR

All AAFP CBOR structures MUST be encoded using length-first core
deterministic encoding requirements (RFC 8949 Section 4.2.3) with
the following rules:

1. Map keys are sorted by the length-first canonical byte ordering
   of their CBOR encoding, as specified in RFC 8949 Section 4.2.3.
   This means:
   - Keys with shorter CBOR encodings come before keys with longer
     encodings.
   - Within the same encoding length, keys are sorted bytewise
     lexicographically.
   
   For integer keys (CBOR major type 0 or 1):
   - Integers 0-23: encoded as 1 byte. Sorted numerically.
   - Integers 24-255: encoded as 2 bytes (0x18 prefix + value).
     Sorted by value, which is the same as bytewise order.
   - All 1-byte keys sort before all 2-byte keys.
   
   Example: keys 1, 2, 5, 10 sort as 1, 2, 5, 10 (all 1-byte).
   Example: keys 1, 24, 100 sort as 1 (1-byte), then 24, 100 (2-byte).
2. Integers use the shortest encoding.
3. Floating-point values use the shortest encoding that preserves
   precision. (Note: AAFP v1 does not use floating-point values in
   any defined structure. This rule is included for completeness and
   future compatibility.)
4. Indefinite-length arrays and maps MUST NOT be used.
5. Text strings use definite-length UTF-8 encoding.
6. All CBOR maps use integer keys (not string keys). See Section 8.4
   for the normative key mapping table.

**Exception**: The CapabilityDescriptor metadata map (RFC-0003
Section 4.5) uses text string keys (CBOR major type 3), not integer
keys. This is because metadata keys are application-defined and
cannot be pre-assigned integer values. String keys in the metadata
map are sorted by length-first canonical byte ordering of their
UTF-8 encoding, consistent with RFC 8949 Section 4.2.3. All other
AAFP CBOR maps use integer keys.

**Empty map key type (Revision 4 clarification)**: When a CBOR map
is empty (encoded as `a0`, major type 5, 0 entries), the CBOR
encoding does not distinguish between int-keyed and string-keyed
maps — both produce the byte `0xa0`. For AAFP fields with a
schema-defined key type, the key type MUST be determined from the
enclosing schema, not from the CBOR major type of the encoded data.
Specifically:

- A field defined as `map<uint, T>` (int-keyed) MUST be interpreted
  as an integer-keyed map, even when empty.
- A field defined as `map<tstr, T>` (string-keyed, e.g.,
  CapabilityDescriptor metadata) MUST be interpreted as a
  string-keyed map, even when empty.

This rule prevents decoders from rejecting valid empty maps due to
ambiguous CBOR major type interpretation. See RFC-0003 §4.5 for the
specific application to CapabilityDescriptor metadata.

Note: RFC 8949 obsoletes RFC 7049. The length-first deterministic
encoding in RFC 8949 Section 4.2.3 is compatible with the canonical
CBOR rules in RFC 7049 Section 3.9.

### 8.2 Why Canonical Encoding

Canonical CBOR ensures that the same logical value produces the same
byte sequence across implementations. This is required for:

- **Signature verification**: Signatures are computed over CBOR-encoded
  bytes. Non-canonical encoding would cause signature verification
  failures across implementations.
- **Hashing**: AgentRecords may be hashed for deduplication. Canonical
  encoding ensures consistent hashes.
- **Caching**: Canonical encoding enables byte-level cache comparison.

### 8.3 Schema Evolution

CBOR schemas in AAFP are designed for forward and backward
compatibility:

- New fields MAY be added to maps. Implementations MUST ignore unknown
  fields unless the field is marked critical (see RFC-0006).
- Fields MUST NOT be removed. Deprecated fields MUST be retained with
  their original semantics.
- Field types MUST NOT change. A field that is `uint` in v1 MUST
  remain `uint` in all future versions.

### 8.4 Integer Key Mapping Table

All AAFP CBOR structures use integer keys for compact encoding and
deterministic canonical ordering. The following table maps integer
keys to field names for all structures defined in this RFC:

| Structure | Key | Field Name |
|-----------|-----|------------|
| RpcRequest | 1 | id |
| RpcRequest | 2 | method |
| RpcRequest | 3 | params |
| RpcResponse | 1 | id |
| RpcResponse | 2 | result |
| RpcResponse | 3 | error |
| RpcResponse.error | 1 | code |
| RpcResponse.error | 2 | message |
| RpcResponse.error | 3 | data |
| CloseMessage | 1 | code |
| CloseMessage | 2 | message |
| ErrorMessage | 1 | code |
| ErrorMessage | 2 | message |
| ErrorMessage | 3 | data |
| ErrorMessage | 4 | fatal |
| ClientHello | 1 | protocol_version |
| ClientHello | 2 | agent_id |
| ClientHello | 3 | public_key |
| ClientHello | 4 | nonce |
| ClientHello | 5 | capabilities |
| ClientHello | 6 | extensions |
| ClientHello | 7 | signature |
| ClientHello | 8 | expires_at |
| ClientHello | 9 | receiver_mac |
| ClientHello | 10 | key_algorithm |
| ServerHello | 1 | protocol_version |
| ServerHello | 2 | agent_id |
| ServerHello | 3 | public_key |
| ServerHello | 4 | nonce |
| ServerHello | 5 | capabilities |
| ServerHello | 6 | extensions |
| ServerHello | 7 | session_id |
| ServerHello | 8 | signature |
| ServerHello | 9 | expires_at |
| ServerHello | 10 | key_algorithm |
| ClientFinished | 1 | session_id |
| ClientFinished | 2 | signature |
| ExtensionEntry | 1 | type |
| ExtensionEntry | 2 | data |
| ExtensionEntry | 3 | critical |

For structures defined in other RFCs (AgentRecord, CapabilityDescriptor,
UcanToken), see the key mapping in those RFCs.

## 9. Security Considerations

### 9.1 Frame Header Integrity

The frame header is not encrypted by AAFP. It is protected by QUIC's
packet protection, which encrypts all QUIC payload including AAFP
frames. Implementations MUST NOT rely on AAFP-level encryption; QUIC
provides transport encryption.

### 9.2 Extension Security

Extensions may carry security-sensitive data (e.g., authorization
tokens). Implementations MUST process extensions according to the
normative processing pipeline defined in Section 6.5. Extension
semantics MUST NOT execute before successful authentication and
authorization (Section 6.5.2, invariant 3). Critical extensions
MUST be rejected if unknown (Section 6.5.5). Non-negotiated
extensions MUST be rejected (Section 6.5.5).

### 9.3 DoS Mitigation

- The maximum frame size (1 MiB) limits memory consumption per frame.
- Implementations SHOULD enforce a maximum number of concurrent streams
  per connection.
- Implementations SHOULD enforce a rate limit on PING frames.
- Implementations SHOULD close connections that send malformed frames
  at a high rate.

## 10. IANA Considerations

This RFC defines the following registries (managed per RFC-0006):

- **AAFP Frame Types**: Values 0x00–0xFF
- **AAFP Extension Types**: Values 0x0000–0xFFFF
- **AAFP ALPN Identifiers**: e.g., `aafp/1`

## 11. References

- RFC 2119: Key words for use in RFCs to indicate requirement levels
- RFC 8949: Concise Binary Object Representation (CBOR) [obsoletes
  RFC 7049]
- RFC 9000: QUIC: A UDP-Based Multiplexed and Secure Transport
- RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3
- RFC 9266: Channel Bindings for TLS 1.3
- FIPS 203: Module-Lattice-Based Key-Encapsulation Mechanism (ML-KEM)
- FIPS 204: Module-Lattice-Based Digital Signature Standard (ML-DSA)
- RFC-0001: AAFP Protocol Overview
- RFC-0003: AAFP Identity & Authentication
- RFC-0005: AAFP Error Model
- RFC-0006: AAFP Versioning & Compatibility
