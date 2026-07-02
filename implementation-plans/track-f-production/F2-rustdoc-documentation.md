# Plan F2: Rustdoc Documentation for All Public APIs (P1-7)

**Priority:** MEDIUM (P1-7, required before public release)
**Track:** F (Production Readiness)
**Estimated effort:** 8-10 hours
**Blocked by:** nothing (can run in parallel with other plans)
**Blocks:** nothing

---

## Objective

Document all public APIs in the AAFP Rust workspace with Rustdoc comments.
Generate and verify the documentation builds cleanly. This is P1-7 from
ROADMAP.md — without docs, third parties can't use the SDK.

**Current state:** Some crates have good doc comments (aafp-transport-mcp,
aafp-transport-a2a), others have minimal documentation (aafp-sdk has 42
lines of doc comments in lib.rs). Many public functions lack `///` docs.

**Source:** ROADMAP.md P1-7

---

## Prerequisites

- Working directory: `/Users/david/projects/AAFP-research/implementations/rust`
- Read each crate's `src/lib.rs` to assess current documentation state

---

## Documentation Standards

Every public item MUST have a `///` doc comment:
- `pub struct`, `pub enum`, `pub trait`
- `pub fn`, `pub async fn`
- `pub type`, `pub const`
- `pub mod` (module-level `//!` docs)

Doc comments should explain:
1. **What** the item does (one sentence)
2. **Why** or **when** to use it (context)
3. **How** to use it (example, if non-obvious)
4. **Errors** or **panics** (if applicable)

Use `#[doc(alias = "...")]` for discoverability where appropriate.

---

## Steps

### F2.1: Audit documentation coverage

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo doc --workspace --no-deps 2>&1 | grep "warning:" | head -50
```

This shows missing doc warnings. Count them:
```bash
cargo doc --workspace --no-deps 2>&1 | grep -c "warning: missing"
```

### F2.2: Document aafp-sdk (highest priority — the main user-facing API)

Read and document every public item in:
- `crates/aafp-sdk/src/lib.rs` — module-level docs, re-exports
- `crates/aafp-sdk/src/agent.rs` — Agent, AgentBuilder
- `crates/aafp-sdk/src/client.rs` — AgentClient
- `crates/aafp-sdk/src/server.rs` — AgentServer
- `crates/aafp-sdk/src/transport_binding.rs` — establish_session
- `crates/aafp-sdk/src/handshake_driver.rs` — drive_client_handshake, drive_server_handshake

For `AgentBuilder`, add a usage example:
```rust
/// Builder for creating an AAFP agent.
///
/// # Example
///
/// ```no_run
/// use aafp_sdk::AgentBuilder;
///
/// # async fn example() {
/// let agent = AgentBuilder::new()
///     .bind("127.0.0.1:0".parse().unwrap())
///     .build()
///     .await
///     .expect("failed to build agent");
/// # }
/// ```
```

### F2.3: Document aafp-core

Document:
- `Session` struct and its state machine
- `SessionState` enum (all variants)
- `AuthorizationProvider` trait
- `Error` type
- `Multiaddr` type

### F2.4: Document aafp-crypto

Document:
- `MlDsa65` — key generation, signing, verification
- `AgentKeypair` — keypair struct
- `ReplayCache` — nonce replay detection
- All public constants (domain separators, etc.)
- `TLS_EXPORTER_LABEL` — what it is and why it matters

### F2.5: Document aafp-identity

Document:
- `AgentId` — what it is (SHA-256 of public key), how it's used
- `AgentRecord` — self-signed CBOR record
- `CapabilityDescriptor` — capability advertisement
- `AgentKeypair` — keypair with public/secret keys
- UCAN types (if any are public)

### F2.6: Document aafp-messaging

Document:
- `Frame` enum and all variants
- `FrameType` enum
- `encode_frame`, `decode_frame` functions
- `PubSub` struct
- `CloseManager` (if public)
- `PingTracker` (from E1)

### F2.7: Document aafp-transport-quic

Document:
- `QuicConnection` — QUIC connection wrapper
- `QuicSendStream`, `QuicRecvStream` — stream types
- `export_tls_binding()` — TLS channel binding
- `TransportConfig` — configuration

### F2.8: Document transport binding crates

Verify documentation in:
- `aafp-transport-mcp` — should already be well-documented (B1/B3)
- `aafp-transport-a2a` — should already be well-documented (B1)

Fill in any gaps.

### F2.9: Document aafp-discovery, aafp-nat

Document the public APIs in:
- `aafp-discovery` — CapabilityDht, DiscoveryClient, DiscoveryRpcHandler
- `aafp-nat` — RelayService, AutoNat, DcutrService

### F2.10: Verify docs build cleanly

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo doc --workspace --no-deps
```
**Expected:** 0 warnings. If there are warnings, fix them.

Also check for broken intra-doc links:
```bash
RUSTDOCFLAGS="-D rustdoc::broken-intra-doc-links" cargo doc --workspace --no-deps
```

### F2.11: Verify doc tests pass

```bash
cargo test --doc --workspace
```
**Expected:** All doc tests pass. If any fail, fix the example code in the
doc comments.

### F2.12: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
docs: document all public APIs with Rustdoc (P1-7)

Adds comprehensive Rustdoc documentation for all public items across
the workspace:
- aafp-sdk: Agent, AgentBuilder, AgentClient, AgentServer, establish_session
- aafp-core: Session, SessionState, AuthorizationProvider, Error
- aafp-crypto: MlDsa65, AgentKeypair, ReplayCache, constants
- aafp-identity: AgentId, AgentRecord, CapabilityDescriptor
- aafp-messaging: Frame, FrameType, PubSub, PingTracker, CloseManager
- aafp-transport-quic: QuicConnection, streams, export_tls_binding
- aafp-discovery: CapabilityDht, DiscoveryClient, DiscoveryRpcHandler
- aafp-nat: RelayService, AutoNat, DcutrService

cargo doc builds with 0 warnings. All doc tests pass.

Closes ROADMAP.md P1-7.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### F2.13: Zero doc warnings

```bash
cargo doc --workspace --no-deps 2>&1 | grep -c "warning:"
# Expected: 0
```

### F2.14: Doc tests pass

```bash
cargo test --doc --workspace
# Expected: all pass
```

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark F2.1 through F2.14 as `[x]`
- Set F2 status to `COMPLETE`
