# Plan B3: Extract Shared establish_session()

**Priority:** MEDIUM (code quality, not a blocker)
**Track:** B (Strategic)
**Estimated effort:** 2-3 hours
**Blocked by:** B1 (need the second transport binding before extracting shared code)
**Blocks:** nothing

---

## Objective

Extract the duplicated handshake + authorization + session-transition logic
into a single shared function `establish_session()` in `aafp-sdk`. This logic
is currently duplicated in three places:

1. `aafp-sdk/src/client.rs` — `AgentClient::connect()`
2. `aafp-sdk/src/server.rs` — `AgentServer::accept_one()`
3. `aafp-transport-mcp/src/lib.rs` — `AafpMcpTransport::connect_with_auth()` / `accept_with_auth()`

After B1, it will be duplicated in a fourth place:
4. `aafp-transport-a2a/src/lib.rs` — `AafpA2aTransport::connect_with_auth()` / `accept_with_auth()`

This plan consolidates all four into one shared function. It also encapsulates
the `QuicConnection::raw()` leak (TRANSPORT_ARCHITECTURE_REVIEW.md §5.1) by
adding `QuicConnection::export_tls_binding()`.

**Source:** TRANSPORT_ARCHITECTURE_REVIEW.md §5.1, §5.3, §6.3

---

## Prerequisites

- B1 complete (aafp-transport-a2a exists and passes tests)
- Working directory: `/Users/david/projects/AAFP-research/implementations/rust`
- Read these files completely before starting:
  - `crates/aafp-sdk/src/client.rs`
  - `crates/aafp-sdk/src/server.rs`
  - `crates/aafp-transport-mcp/src/lib.rs` (lines 213-317 — the connect/accept logic)
  - `crates/aafp-transport-a2a/src/lib.rs` (the same logic, copied in B1)
  - `crates/aafp-transport-quic/src/connection.rs` (to understand `raw()`)

---

## Steps

### B3.1: Create crates/aafp-sdk/src/transport_binding.rs

This module contains the shared `establish_session()` function:

```rust
//! Shared transport binding infrastructure.
//!
//! Used by AgentClient, AgentServer, and all transport binding crates
//! (aafp-transport-mcp, aafp-transport-a2a) to avoid duplicating the
//! handshake + authorization + session-transition logic.

use std::sync::Arc;
use aafp_core::{AuthorizationProvider, Session, SessionState};
use aafp_crypto::{AgentKeypair, ReplayCache, TLS_EXPORTER_LABEL};
use aafp_identity::AgentId;
use aafp_sdk::{drive_client_handshake, drive_server_handshake, PeerInfo, SdkError};
use aafp_transport_quic::QuicConnection;

/// Establish an authenticated AAFP session over a QUIC connection.
///
/// This performs:
/// 1. TLS channel binding extraction
/// 2. AAFP v1 handshake (client or server side)
/// 3. Authorization via the provided AuthorizationProvider
/// 4. Session state transitions to MessagingEnabled
///
/// Returns (Session, QuicConnection, PeerInfo) on success.
///
/// # Parameters
/// - `conn`: The QUIC connection (consumed and returned)
/// - `keypair`: The local agent's keypair
/// - `auth_provider`: Authorization provider for peer authorization
/// - `is_client`: true for client-side handshake, false for server-side
/// - `replay_cache`: Optional replay cache for nonce reuse detection
pub async fn establish_session(
    conn: QuicConnection,
    keypair: &AgentKeypair,
    auth_provider: Arc<dyn AuthorizationProvider>,
    is_client: bool,
    replay_cache: Option<&ReplayCache>,
) -> Result<(Session, QuicConnection, PeerInfo), SdkError> {
    // 1. Extract TLS channel binding
    let tls_binding = conn.export_tls_binding(TLS_EXPORTER_LABEL.as_bytes(), &[])?;

    // 2. Drive AAFP v1 handshake
    let (mut session, conn, peer_info) = if is_client {
        drive_client_handshake(conn, keypair, tls_binding, replay_cache).await?
    } else {
        drive_server_handshake(conn, keypair, tls_binding, replay_cache).await?
    };

    // 3. Authorization
    let auth_ctx = auth_provider
        .authorize(&peer_info.agent_id, &peer_info.public_key)
        .await
        .map_err(|e| SdkError::Authorization(e.to_string()))?;
    session.on_authorization_verified(auth_ctx)?;

    // 4. Transition to MessagingEnabled
    session.on_authenticated()?;
    session.on_messaging_enabled()?;

    Ok((session, conn, peer_info))
}
```

**Note:** The exact error types and method signatures must match the existing
code. Read `client.rs` and `server.rs` to verify the exact `Session` methods
and error handling patterns before writing this. Adapt the code above to match
the real API.

### B3.2: Add module to aafp-sdk

Edit `crates/aafp-sdk/src/lib.rs`. Add:
```rust
pub mod transport_binding;
```

Place it after the existing module declarations. Also re-export the function:
```rust
pub use transport_binding::establish_session;
```

### B3.3: Add QuicConnection::export_tls_binding()

Edit `crates/aafp-transport-quic/src/connection.rs`. Add a method to
`QuicConnection`:

```rust
/// Export TLS channel binding material via the TLS exporter.
///
/// This encapsulates the quinn `export_keying_material` call, avoiding
/// the need for transport binding crates to access `raw()` directly.
///
/// # Parameters
/// - `label`: The exporter label (e.g., TLS_EXPORTER_LABEL)
/// - `context`: Optional context bytes
///
/// Returns 32 bytes of keying material.
pub fn export_tls_binding(&self, label: &[u8], context: &[u8]) -> Result<[u8; 32], Error> {
    let mut binding = [0u8; 32];
    self.raw()
        .export_keying_material(&mut binding, label, context)
        .map_err(|e| Error::TlsExport(e.to_string()))?;
    Ok(binding)
}
```

**Note:** Check the actual `Error` type in `aafp-transport-quic` — it may not
have a `TlsExport` variant. If not, add one or use an existing variant. Read
the error type definition first.

**Also:** Check if `raw()` is currently `pub` or `pub(crate)`. If it's `pub`,
keep it for backward compatibility but document that `export_tls_binding()`
is the preferred API. If it's `pub(crate)`, you may need to make it `pub` or
keep `export_tls_binding()` as a wrapper.

### B3.4: Refactor AgentClient::connect

Edit `crates/aafp-sdk/src/client.rs`. Find `AgentClient::connect()` (or
`connect_with_auth()`). Replace the inline handshake/auth/session logic with
a call to `establish_session()`:

```rust
pub async fn connect_with_auth(
    agent: &Agent,
    addr: &str,
    auth_provider: Arc<dyn AuthorizationProvider>,
) -> Result<Self, SdkError> {
    let conn = agent.transport.dial(addr).await?;
    let (session, conn, peer_info) =
        establish_session(conn, &agent.keypair, auth_provider, true, None).await?;
    // ... rest of connect logic (open streams, etc.)
}
```

Keep any logic that happens AFTER `establish_session` (e.g., opening streams,
creating the client struct) in `connect_with_auth`.

### B3.5: Refactor AgentServer::accept_one

Edit `crates/aafp-sdk/src/server.rs`. Same pattern as B3.4 but with
`is_client: false`:

```rust
pub async fn accept_one_with_auth(
    agent: &Agent,
    auth_provider: Arc<dyn AuthorizationProvider>,
) -> Result<Self, SdkError> {
    let conn = agent.transport.accept().await?;
    let (session, conn, peer_info) =
        establish_session(conn, &agent.keypair, auth_provider, false, None).await?;
    // ... rest of accept logic
}
```

### B3.6: Refactor AafpMcpTransport

Edit `crates/aafp-transport-mcp/src/lib.rs`. In `connect_with_auth()` and
`accept_with_auth()`, replace the inline logic with `establish_session()`:

```rust
pub async fn connect_with_auth(
    agent: &Agent,
    addr: &str,
    auth_provider: Arc<dyn AuthorizationProvider>,
) -> Result<Self, AafpMcpError> {
    let conn = agent.transport.dial(addr).await?;
    let (_session, conn, peer_info) =
        aafp_sdk::establish_session(conn, &agent.keypair, auth_provider, true, None)
            .await
            .map_err(AafpMcpError::from)?;
    let (send, recv) = conn.open_bi().await?;
    Ok(Self {
        send: Arc::new(Mutex::new(Some(send))),
        recv,
        conn: Some(conn),
        closed: false,
        peer_agent_id: Some(peer_info.agent_id),
    })
}
```

**Note:** The MCP transport currently doesn't keep the `Session` object (it
only needs the connection and peer info). If `establish_session` returns
`Session`, you can discard it with `_session` or store it if needed. Check
the current code — if the MCP transport doesn't use Session, discarding is fine.

### B3.7: Refactor AafpA2aTransport

Edit `crates/aafp-transport-a2a/src/lib.rs`. Same pattern as B3.6.

### B3.8: Remove extract_tls_binding from transport crates

In both `aafp-transport-mcp/src/lib.rs` and `aafp-transport-a2a/src/lib.rs`,
remove the `extract_tls_binding()` helper function. It's no longer needed —
`establish_session()` uses `QuicConnection::export_tls_binding()` internally.

Also remove the `use aafp_crypto::TLS_EXPORTER_LABEL;` import if it's no
longer used directly in those files.

### B3.9: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
refactor: extract shared establish_session() to aafp-sdk

Consolidates the duplicated handshake + authorization + session-transition
logic from four call sites into a single shared function:
- AgentClient::connect
- AgentServer::accept_one
- AafpMcpTransport::connect_with_auth / accept_with_auth
- AafpA2aTransport::connect_with_auth / accept_with_auth

Also adds QuicConnection::export_tls_binding() to encapsulate the quinn
TLS exporter access, removing the need for transport crates to call
conn.raw().export_keying_material() directly.

Addresses TRANSPORT_ARCHITECTURE_REVIEW.md §5.1 (leaky abstraction) and
§5.3 (duplicated handshake logic).

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Update umbrella submodule pointer:
```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule — extract establish_session()"
```

---

## Verification

### B3.10: All tests pass

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo test --workspace
```
**Expected:** All 1011+ tests pass, 0 failures. This is the critical
verification — if any test fails, the refactor broke something. The most
likely failure is a subtle difference in the session state transitions or
error handling. If tests fail, compare the refactored `establish_session()`
against the original inline logic carefully.

### B3.11: No raw() calls in transport crates

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
grep -r "\.raw()" crates/aafp-transport-mcp/src/ crates/aafp-transport-a2a/src/
```
**Expected:** No output (0 matches). If `raw()` is still called, the refactor
is incomplete.

### B3.12: Single source of handshake logic

```bash
grep -r "drive_client_handshake\|drive_server_handshake" crates/aafp-sdk/src/ crates/aafp-transport-mcp/src/ crates/aafp-transport-a2a/src/
```
**Expected:** `drive_client_handshake` and `drive_server_handshake` appear
only in `crates/aafp-sdk/src/transport_binding.rs` (and possibly in the
deprecated `handshake_driver.rs` if it still exists). They should NOT appear
in the transport crates directly.

---

## Risks & Mitigations

1. **Session ownership:** The current MCP/A2A transports may not keep the
   `Session` object (they only need the connection). If `establish_session`
   returns `Session`, the transports discard it. This is fine as long as the
   session state machine has already transitioned to `MessagingEnabled` —
   the connection is authenticated at that point. **Mitigation:** If tests
   fail because Session is needed later, store it in the transport struct.

2. **Error type mapping:** `establish_session` returns `SdkError`. The
   transport crates use their own error types (`AafpMcpError`, `AafpA2aError`).
   Ensure `From<SdkError>` impls exist for both. They should (the transports
   already have `#[from] SdkError`), but verify.

3. **ReplayCache parameter:** The current transports pass `None` for the
   replay cache. `establish_session` accepts `Option<&ReplayCache>`. This
   is correct — transports can opt into replay protection by passing a cache.

4. **Backward compatibility:** `QuicConnection::raw()` should remain `pub`
   for backward compatibility (other code may use it). The new
   `export_tls_binding()` is the preferred API, but `raw()` is not removed.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark B3.1 through B3.12 as `[x]`
- Set B3 status to `COMPLETE`
