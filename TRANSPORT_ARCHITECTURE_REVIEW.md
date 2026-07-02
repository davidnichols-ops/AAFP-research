# Transport Architecture Review

**Review date:** 2026-07-02
**Scope:** `aafp-transport-mcp` crate, its dependencies, and its relationship to the AAFP core architecture
**Reviewer:** Architectural review pass

---

## 1. Executive Summary

The `aafp-transport-mcp` crate is architecturally sound in its core design
decision: it uses AAFP DATA frames (frame type 0x01) to carry MCP JSON-RPC
messages, which is exactly the usage pattern intended by RFC-0002 §4.1. The
transport does not bypass AAFP's framing model — it correctly uses the
public `encode_frame` / `Frame::data` APIs.

However, the review identified **three architectural concerns** that should
be addressed before public release:

1. **Stream ID violation**: The transport uses stream ID 1, which RFC-0002 §7.1
   reserves for future protocol use. Application streams must use IDs ≥ 4.
2. **TLS exporter access via `raw()`**: The transport reaches into the
   underlying quinn connection via `QuicConnection::raw()` to access the TLS
   exporter. This is a leaky abstraction that should be encapsulated.
3. **Duplicated handshake logic**: The `connect`/`accept` methods duplicate
   the session state machine transitions that `AgentClient::connect` and
   `AgentServer::accept_one` already implement. A shared abstraction would
   prevent drift.

No refactoring is recommended for stylistic reasons. The three concerns above
have functional or protocol-compliance implications.

---

## 2. Dependency Graph

```
aafp-transport-mcp
├── aafp-sdk          (AgentBuilder, Agent, drive_client/server_handshake, PeerInfo, SdkError)
│   ├── aafp-transport-quic  (QuicTransport, QuicConnection, QuicSendStream, QuicRecvStream)
│   ├── aafp-core            (Session, SessionState, AuthorizationProvider, TestingAuthProvider)
│   ├── aafp-crypto          (AgentKeypair, TLS_EXPORTER_LABEL)
│   ├── aafp-identity        (AgentId, AgentRecord)
│   ├── aafp-messaging       (Frame, encode_frame, CloseManager)
│   └── aafp-discovery       (CapabilityDht, RegionalDiscovery, BootstrapDiscovery)
├── aafp-core         (AuthorizationProvider, Error, TestingAuthProvider)
├── aafp-crypto       (TLS_EXPORTER_LABEL)
├── aafp-identity     (AgentId)
├── aafp-messaging    (Frame, encode_frame, AAFP_VERSION, FRAME_HEADER_SIZE)
├── aafp-transport-quic (QuicConnection, QuicSendStream, QuicRecvStream)
├── rmcp              (Transport<R>, ServiceRole, TxJsonRpcMessage, RxJsonRpcMessage)
├── serde / serde_json
├── tokio
└── thiserror / tracing
```

**Observation:** The crate depends on 6 AAFP crates directly. Of these,
`aafp-core`, `aafp-crypto`, and `aafp-identity` are used only for types
re-exported through `aafp-sdk`. If `aafp-sdk` re-exported these types, the
direct dependency count could be reduced to 3 (`aafp-sdk`,
`aafp-messaging`, `aafp-transport-quic`), reducing coupling.

---

## 3. Crate Relationships

```
┌─────────────────────────────────────────────────────────┐
│                    Application                           │
│                  (MCP server/client)                     │
├─────────────────────────────────────────────────────────┤
│                  rmcp SDK                                │
│            (Transport<R> trait, ServiceExt)              │
├─────────────────────────────────────────────────────────┤
│              aafp-transport-mcp                          │
│           (AafpMcpTransport struct)                      │
├──────────────┬──────────────┬───────────────────────────┤
│  aafp-sdk    │ aafp-messaging│ aafp-transport-quic       │
│ (handshake,  │ (Frame,       │ (QuicConnection,          │
│  Agent,      │  encode_frame)│  QuicSend/RecvStream)     │
│  AgentBuilder│               │                           │
│  )           │               │                           │
├──────────────┼──────────────┼───────────────────────────┤
│  aafp-core   │               │  quinn                    │
│ (Session,    │               │  rustls                   │
│  AuthProvider│               │                           │
│  )           │               │                           │
├──────────────┤               │                           │
│  aafp-crypto │               │                           │
│ (TLS_EXPORTER│               │                           │
│  _LABEL)     │               │                           │
└──────────────┴──────────────┴───────────────────────────┘
```

---

## 4. Public API Usage Analysis

### 4.1 APIs used correctly (stable public API)

| API | Source | Usage | Assessment |
|-----|--------|-------|------------|
| `AgentBuilder::new().bind().build()` | `aafp-sdk` | Create agents | Correct |
| `agent.transport.dial(addr)` | `aafp-sdk` / `aafp-transport-quic` | QUIC dial | Correct |
| `agent.transport.accept()` | `aafp-sdk` / `aafp-transport-quic` | QUIC accept | Correct |
| `agent.transport.local_addr()` | `aafp-transport-quic` | Get listen address | Correct |
| `agent.keypair` | `aafp-sdk` (public field) | Access signing key | Correct |
| `drive_client_handshake()` | `aafp-sdk` | AAFP v1 handshake | Correct |
| `drive_server_handshake()` | `aafp-sdk` | AAFP v1 handshake | Correct |
| `PeerInfo.agent_id` | `aafp-sdk` (public field) | Authorization | Correct |
| `PeerInfo.public_key` | `aafp-sdk` (public field) | Authorization | Correct |
| `Frame::data(stream_id, payload)` | `aafp-messaging` | Create DATA frame | Correct |
| `encode_frame(&frame)` | `aafp-messaging` | Encode frame to bytes | Correct |
| `QuicConnection.open_bi()` | `aafp-transport-quic` | Open bidirectional stream | Correct |
| `QuicConnection.accept_bi()` | `aafp-transport-quic` | Accept bidirectional stream | Correct |
| `QuicSendStream.write_all()` | `aafp-transport-quic` | Write frame bytes | Correct |
| `QuicSendStream.finish()` | `aafp-transport-quic` | Signal stream end | Correct |
| `QuicRecvStream.read_exact()` | `aafp-transport-quic` | Read frame bytes | Correct |
| `QuicConnection.close()` | `aafp-transport-quic` | Close QUIC connection | Correct |
| `Session.on_*()` transitions | `aafp-core` | State machine | Correct |
| `AuthorizationProvider.authorize()` | `aafp-core` | Authorization | Correct |
| `TestingAuthProvider` | `aafp-core` | Default auth (allows all) | Correct (test default) |

### 4.2 APIs that reach into internals

| API | Source | Usage | Concern |
|-----|--------|-------|---------|
| `QuicConnection::raw()` | `aafp-transport-quic` | Access `quinn::Connection` for TLS exporter | **Leaky abstraction** — see §5.1 |
| `TLS_EXPORTER_LABEL` | `aafp-crypto` | TLS exporter context string | Acceptable (constant, but should be encapsulated) |

### 4.3 Duplicated logic

| Logic | Location | Duplication |
|-------|----------|-------------|
| TLS binding extraction | `aafp-transport-mcp::extract_tls_binding()` | Also in `aafp-sdk::handshake_driver` (private) |
| Session state transitions | `connect()` / `accept()` | Also in `AgentClient::connect()` / `AgentServer::accept_one()` |
| Authorization flow | `connect()` / `accept()` | Also in `AgentClient::connect()` / `AgentServer::accept_one()` |

---

## 5. Architectural Concerns

### 5.1 CONCERN: `QuicConnection::raw()` exposes quinn internals

**Location:** `lib.rs:301`
```rust
fn extract_tls_binding(conn: &QuicConnection) -> Result<[u8; 32], AafpMcpError> {
    conn.raw()
        .export_keying_material(&mut binding, TLS_EXPORTER_LABEL.as_bytes(), &[])
        ...
}
```

**Problem:** `QuicConnection::raw()` returns `&quinn::Connection`, exposing
the underlying QUIC library. The MCP transport uses this to call
`export_keying_material()` for the TLS channel binding required by the AAFP
v1 handshake. This couples the transport crate to quinn's API surface.

**Root cause:** The AAFP SDK's `handshake_driver` also needs the TLS exporter,
but it accesses it through a private path. The `raw()` method was exposed
publicly to allow transport bindings to do the same, but this is a leaky
abstraction.

**Recommended fix:** Add a method to `QuicConnection`:
```rust
pub fn export_tls_binding(&self, label: &[u8], context: &[u8]) -> Result<[u8; 32], Error>
```
This encapsulates the quinn dependency. The MCP transport would then call
`conn.export_tls_binding(TLS_EXPORTER_LABEL.as_bytes(), &[])` instead of
`conn.raw().export_keying_material(...)`.

**Severity:** Medium. Functionally correct but creates coupling that will
break if quinn's API changes. Also affects any future transport binding.

> **RESOLVED** (B3): Added `QuicConnection::export_tls_binding()`. Transport
> crates no longer call `raw()`. The `raw()` method is now deprecated.

### 5.2 CONCERN: Stream ID violation (RFC-0002 §7.1)

**Location:** `lib.rs:92`
```rust
const MCP_STREAM_ID: u64 = 1;
```

**Problem:** RFC-0002 §7.1 states:
> Stream 0 is reserved for the handshake. Streams 1 and 2 are reserved
> for future protocol use. Application streams start at stream ID 4
> (client-initiated) or 5 (server-initiated).

The MCP transport uses stream ID 1 for application data, which violates
this reservation.

**Note:** The stream ID in the AAFP frame header is a logical identifier
that is distinct from the QUIC stream ID. The QUIC stream is opened by
`open_bi()` / `accept_bi()` and has its own ID assigned by quinn. The AAFP
frame's `stream_id` field is an application-level tag. However, the RFC
reservation applies to the AAFP frame's stream_id field, not the QUIC
stream ID.

**Recommended fix:** Change `MCP_STREAM_ID` to 4 (the first
client-initiated application stream ID per RFC-0002 §7.1).

**Severity:** Medium. Protocol compliance issue. Does not cause functional
problems today but violates the spec and could conflict with future
protocol features that use streams 1-2.

### 5.3 CONCERN: Duplicated handshake + authorization logic

**Location:** `lib.rs:153-199` (connect), `lib.rs:215-255` (accept)

**Problem:** The `connect_with_auth` and `accept_with_auth` methods
duplicate the following logic that already exists in
`AgentClient::connect` and `AgentServer::accept_one`:

1. TLS binding extraction
2. Handshake driver invocation
3. Authorization provider call
4. Session state transitions (IdentityVerified → AuthorizationVerified →
   Authenticated → MessagingEnabled)

This duplication means that if the handshake flow changes (e.g., new
session states, new authorization steps), the transport crate must be
updated independently.

**Root cause:** The SDK's `AgentClient` and `AgentServer` are designed for
the "one stream per message" pattern. The MCP transport needs a long-lived
stream, so it cannot use `AgentClient::connect` (which doesn't expose the
underlying connection for stream management). The transport must perform
the handshake itself to retain ownership of the `QuicConnection`.

**Recommended fix:** Extract a shared function in `aafp-sdk`:
```rust
pub async fn establish_session(
    conn: QuicConnection,
    keypair: &AgentKeypair,
    auth_provider: Arc<dyn AuthorizationProvider>,
    is_client: bool,
) -> Result<(Session, QuicConnection, PeerInfo), SdkError>
```
This would be used by both `AgentClient::connect`, `AgentServer::accept_one`,
and `AafpMcpTransport::connect_with_auth` / `accept_with_auth`.

**Severity:** Low-Medium. Functionally correct today but creates maintenance
risk. Not a blocker for public release but should be addressed before
adding more transport bindings (A2A, etc.).

> **RESOLVED** (B3): Extracted `establish_session()` to
> `aafp-sdk::transport_binding`. All 4 call sites (MCP connect/accept, A2A
> connect/accept) now use the shared function.

---

## 6. Reusability for Future Transport Bindings

The crate's design was evaluated for reuse by a future `aafp-transport-a2a`
crate (RFC 0008).

### 6.1 What is reusable

- The handshake + authorization flow (concern 5.3 above)
- The TLS binding extraction (concern 5.1 above)
- The frame read/write logic (`read_data_frame`, `encode_frame`)
- The `Transport<R>` trait implementation pattern

### 6.2 What is MCP-specific

- The `rmcp` dependency and `Transport<R>` trait
- JSON serialization (`serde_json`)
- The `AafpMcpError` type
- The `AafpMcpTransport` struct name

### 6.3 Recommended abstraction

If a future A2A transport binding is implemented, the shared infrastructure
(handshake, TLS binding, frame I/O) should be extracted into a common
module or crate. Two options:

**Option A: Shared module in `aafp-sdk`**
Add a `pub mod transport_binding` to `aafp-sdk` that provides:
- `establish_session()` — handshake + authorization
- `read_data_frame()` / `write_data_frame()` — frame I/O helpers
- `TransportConfig` — stream ID, max payload, etc.

**Option B: New `aafp-transport-core` crate**
A minimal crate with no protocol-specific dependencies, providing the
shared transport binding primitives. Both `aafp-transport-mcp` and
`aafp-transport-a2a` depend on it.

**Recommendation:** Option A is simpler and sufficient for 2-3 transport
bindings. Option B is preferable if the number of bindings grows or if
the shared code has dependencies that shouldn't be in `aafp-sdk`.

**Do not implement this now.** Wait until the A2A binding is actually
built to avoid premature abstraction. The current duplication is
tolerable for a single binding.

> **RESOLVED** (B1+B3): Second transport binding (A2A) implemented in B1,
> then shared code extracted in B3 using Option A (`aafp-sdk::transport_binding`
> module with `establish_session()`). The A2A binding validated the abstraction
> before extraction, avoiding premature design.

---

## 7. Frame Read Logic

The `read_data_frame` function (`lib.rs:310-365`) manually parses the
28-byte frame header instead of using `aafp_messaging::decode_frame`.

**Reason:** `decode_frame` operates on a complete byte buffer, but the
transport reads from a QUIC stream where the frame arrives in arbitrary
chunks. The manual implementation reads the header first, then the
extensions, then the payload, using `read_exact` for each section.

**Assessment:** This is correct and necessary. A streaming `FrameCodec`
exists in `aafp-messaging` but is designed for tokio I/O streams. The
transport's manual parsing is functionally equivalent and avoids
introducing a dependency on the codec's specific I/O pattern.

**No change recommended.** However, if `aafp-messaging` adds a
`read_frame_from_stream` helper in the future, the transport should
use it to avoid duplicating the header parsing logic.

---

## 8. Summary of Recommended Refactors

| # | Concern | Severity | Action | When |
|---|---------|----------|--------|------|
| 1 | `raw()` exposes quinn internals | Medium | Add `export_tls_binding()` to `QuicConnection` | Before public release |
| 2 | Stream ID 1 violates RFC-0002 §7.1 | Medium | Change `MCP_STREAM_ID` to 4 | Before public release |
| 3 | Duplicated handshake logic | Low-Medium | Extract `establish_session()` to `aafp-sdk` | When A2A binding is built |
| 4 | Direct deps on 6 AAFP crates | Low | Reduce to 3 via re-exports | Optional, not blocking |

**Refactors 1 and 2 should be done before public release.** Refactor 3
should wait until a second transport binding is built to avoid premature
abstraction. Refactor 4 is optional.

---

## 9. What Is Architecturally Correct

To avoid giving the impression that the implementation is flawed, the
following design decisions are explicitly affirmed:

1. **DATA frames for JSON-RPC**: Correct per RFC-0002 §4.1. DATA frames
   carry opaque application payloads. Using them for JSON-RPC is the
   intended pattern, not a shortcut.

2. **Single long-lived stream**: The MCP transport opens one bidirectional
   QUIC stream and reuses it for all messages. This differs from the SDK's
   `AgentClient::send()` (one stream per message) but is a valid
   application protocol choice. JSON-RPC is a request/response protocol
   that benefits from stream reuse (avoiding per-message stream setup
   latency).

3. **JSON encoding (not CBOR)**: MCP's wire format is JSON-RPC 2.0 with
   JSON serialization. The transport correctly preserves this rather than
   transcoding to CBOR. Transcoding would break compatibility with the
   rmcp SDK and MCP specification.

4. **`encode_frame` / `Frame::data`**: The transport uses the public
   framing API correctly. It does not manually construct frame headers
   (except in `read_data_frame`, which is necessary for streaming I/O).

5. **Handshake driver usage**: The transport correctly uses
   `drive_client_handshake` / `drive_server_handshake` from `aafp-sdk`,
   which are the canonical handshake functions.

6. **Session state enforcement**: The transport correctly transitions
   the Session through IdentityVerified → AuthorizationVerified →
   Authenticated → MessagingEnabled before opening application streams.

7. **Authorization provider pattern**: The transport correctly accepts
   a custom `AuthorizationProvider` via `connect_with_auth` /
   `accept_with_auth`, with `TestingAuthProvider` as the default.

---

## 10. Public API Review

### 10.1 API surface inventory

| # | API | Visibility | Assessment | Action |
|---|-----|------------|------------|--------|
| 1 | `AafpMcpTransport` (struct) | `pub` | **Keep public** — main type. Fields are private. | None |
| 2 | `AafpMcpTransport::connect()` | `pub` | **Keep public** — primary constructor | None |
| 3 | `AafpMcpTransport::connect_with_auth()` | `pub` | **Keep public** — production auth | None |
| 4 | `AafpMcpTransport::accept()` | `pub` | **Keep public** — primary constructor | None |
| 5 | `AafpMcpTransport::accept_with_auth()` | `pub` | **Keep public** — production auth | None |
| 6 | `AafpMcpTransport::from_streams()` | `pub` | **Keep public** — advanced escape hatch. Document as such. | None |
| 7 | `AafpMcpTransport::peer_agent_id()` | `pub` | **Fixed** — was a stub returning `None`. Now stores peer AgentId from handshake. | **Done** |
| 8 | `AafpMcpTransport::send_for_test()` | `#[doc(hidden)] pub` | **Gated behind `test-utils` feature** — was always public. Now only available with `--features test-utils`. | **Done** |
| 9 | `AafpMcpError` (enum) | `pub` | **Keep public** — error type for `Transport<R>` impl | None |
| 10 | `impl From<FrameError> for AafpMcpError` | `pub` | **Keep public** — necessary error conversion | None |
| 11 | `MCP_STREAM_ID` | private `const` | **Keep private** — implementation detail | None |
| 12 | `impl Transport<R> for AafpMcpTransport` | `pub` | **Keep public** — required by rmcp | None |

### 10.2 Changes made

1. **`peer_agent_id()` fixed**: Previously returned `None` always (stub). Now
   stores the peer `AgentId` from the `PeerInfo` returned by the handshake
   driver. The field is set in `connect()` and `accept()`, and is `None` for
   `from_streams()`.

2. **`send_for_test()` gated behind `test-utils` feature**: Previously
   `#[doc(hidden)]` but always compiled. Now only available when the
   `test-utils` feature is enabled. This prevents accidental use in
   production code while keeping it available for conformance tests.

3. **Stream ID fixed**: Changed `MCP_STREAM_ID` from 1 to 4, per RFC-0002
   §7.1. Streams 1-2 are reserved for future protocol use.

### 10.3 Final API surface

The public API surface is now:

```
pub struct AafpMcpTransport { /* private fields */ }

impl AafpMcpTransport {
    pub async fn connect(agent: &Agent, addr: &str) -> Result<Self, AafpMcpError>
    pub async fn connect_with_auth(agent: &Agent, addr: &str, auth: Arc<dyn AuthorizationProvider>) -> Result<Self, AafpMcpError>
    pub async fn accept(agent: &Agent) -> Result<Self, AafpMcpError>
    pub async fn accept_with_auth(agent: &Agent, auth: Arc<dyn AuthorizationProvider>) -> Result<Self, AafpMcpError>
    pub fn from_streams(send: QuicSendStream, recv: QuicRecvStream, conn: Option<QuicConnection>) -> Self
    pub fn peer_agent_id(&self) -> Option<&AgentId>
}

impl<R: ServiceRole> Transport<R> for AafpMcpTransport { ... }

pub enum AafpMcpError { ... }
```

This is a small, stable API surface with 7 public methods, 1 public type,
and 1 public error enum. No implementation details are exposed.
