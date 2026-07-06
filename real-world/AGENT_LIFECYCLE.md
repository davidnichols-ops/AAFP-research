# AAFP Agent Lifecycle Management

> **Research document** — maps the AAFP Rust implementation's APIs and
> data structures onto the full agent lifecycle: registration,
> deregistration, hibernation, migration, versioning, health monitoring,
> restart, scaling, composition, retirement, lifecycle events, and
> state management.
>
> **Primary source**: `implementations/rust/crates/aafp-sdk/src/simple.rs`
> and supporting crates (`aafp-discovery`, `aafp-identity`,
> `aafp-messaging`, `aafp-nat`, `aafp-core`, `aafp-transport-quic`).

---

## Table of Contents

1. [Lifecycle Overview & State Machine](#1-lifecycle-overview--state-machine)
2. [Agent Registration](#2-agent-registration)
3. [Agent Deregistration](#3-agent-deregistration)
4. [Agent Hibernation](#4-agent-hibernation)
5. [Agent Migration](#5-agent-migration)
6. [Agent Versioning](#6-agent-versioning)
7. [Agent Health Monitoring](#7-agent-health-monitoring)
8. [Agent Restart & Crash Recovery](#8-agent-restart--crash-recovery)
9. [Agent Scaling](#9-agent-scaling)
10. [Agent Composition](#10-agent-composition)
11. [Agent Retirement](#11-agent-retirement)
12. [Lifecycle Events](#12-lifecycle-events)
13. [State Management](#13-state-management)
14. [Cross-Cutting Concerns](#14-cross-cutting-concerns)
15. [Reference: Key Types & File Locations](#15-reference-key-types--file-locations)

---

## 1. Lifecycle Overview & State Machine

An AAFP agent progresses through a well-defined set of lifecycle states.
The high-level state machine below shows the transitions and the SDK
APIs that trigger them.

### 1.1 High-Level Agent State Machine

```
                            ┌──────────┐
                            │  Created │
                            └────┬─────┘
                                 │  AgentBuilder::build().await
                                 │  (keypair, transport, DHT, record)
                                 ▼
                            ┌──────────┐
              ┌─────────────│ Registered │─────────────┐
              │             └─────┬─────┘             │
              │  ServingAgent::   │  ConnectedAgent::  │
              │  start().await    │  connect().await   │
              ▼                   ▼                    │
       ┌──────────┐        ┌───────────┐               │
       │  Serving │        │ Connected │               │
       └──┬───┬──┘        └─────┬─────┘               │
          │   │   stop()        │  discover()/call()   │
          │   └────────┐        ▼                      │
          │            │  ┌──────────┐                 │
          │            │  │  Active  │                 │
          │            │  └──┬───┬──┘                 │
          │            │     │   │                     │
          │            │     │   │ hibernate()         │
          │            │     │   ▼                     │
          │            │     │  ┌──────────┐           │
          │            │     │  │Hibernating│          │
          │            │     │  └────┬─────┘           │
          │            │     │       │ wake()          │
          │            │     │       └──────► Active   │
          │            │     │                         │
          │            │     │ migrate()                │
          │            │     ▼                         │
          │            │  ┌──────────┐                 │
          │            │  │Migrating │                 │
          │            │  └────┬─────┘                 │
          │            │       │ complete              │
          │            │       └──────► Active         │
          │            │                               │
          │            ▼                               │
       ┌──────────┐                              │
       │Deregister│◄─────────────────────────────┘
       └────┬─────┘
            │ archive + revoke
            ▼
       ┌──────────┐
       │ Retired  │
       └──────────┘
            │
            │ crash / kill -9
            ▼
       ┌──────────┐
       │  Crashed │ ──── restart() ────► Registered
       └──────────┘
```

### 1.2 Session-Level State Machine (RFC-0002 §5.10)

The session state machine governs the per-connection lifecycle. It is
orthogonal to the agent lifecycle but tightly coupled during
registration and deregistration.

```
   ┌─────────────┐
   │   Idle      │
   └──────┬──────┘
          │ transport.accept() / transport.dial()
          ▼
   ┌──────────────────┐
   │   Connecting     │
   └──────┬───────────┘
          │ on_transport_established()
          ▼
   ┌──────────────────────┐
   │ TransportEstablished │
   └──────┬───────────────┘
          │ ClientHello / ServerHello exchange
          ▼
   ┌──────────────────┐
   │ IdentityVerified │
   └──────┬───────────┘
          │ AuthorizationProvider::authorize()
          ▼
   ┌──────────────────────┐
   │ AuthorizationVerified│
   └──────┬───────────────┘
          │ SDK transitions
          ▼
   ┌──────────────────┐
   │ MessagingEnabled │ ◄──── steady state (RPC, streaming)
   └──────┬───────────┘
          │ CLOSE frame (local or remote)
          ▼
   ┌──────────┐
   │  Closed  │
   └──────────┘
```

**Source**: `aafp-sdk/src/handshake_driver.rs` (lines 1-24),
`aafp-core::handshake_state` (normative RFC-0002 §5.10 implementation).

### 1.3 Close Frame State Machine (RFC-0002 §6.6)

The `CloseManager` governs graceful connection teardown with 5 states:
`Open → LocalCloseSent → RemoteCloseReceived → CloseReceived → Closed`.

**Source**: `aafp-messaging::close_manager` (normative RFC-0002 §6.6).

---

## 2. Agent Registration

Registration is the process by which an agent joins the AAFP network:
generating or loading an identity, creating a self-signed `AgentRecord`,
publishing it to the DHT, and bootstrapping connectivity to seed nodes.

### 2.1 Identity Creation

Every agent has a cryptographic identity rooted in an ML-DSA-65 keypair.
The `AgentId` is `SHA-256(public_key)` — a 32-byte identifier that
cryptographically binds the identity to the key.

```rust
// Auto-generated keypair (ephemeral identity)
let agent = AgentBuilder::new()
    .with_capabilities(vec!["inference".into()])
    .build().await?;

// Persistent identity (load keypair from disk)
let kp = AgentKeypair::from_seed(&seed_bytes);
let agent = AgentBuilder::new()
    .with_keypair(kp)
    .with_capabilities(vec!["inference".into()])
    .build().await?;
```

**Source**: `aafp-sdk/src/builder.rs` lines 49-53 (`with_keypair`),
`aafp-identity/src/keypair.rs` (`AgentKeypair::generate`).

### 2.2 AgentRecord Creation

During `AgentBuilder::build()`, a self-signed `AgentRecord` is created
binding the agent's identity to its capabilities and endpoints:

```rust
// From builder.rs line 165:
let record = AgentRecord::new(&keypair, self.capabilities.clone(), vec![local_addr]);
```

The `AgentRecord` contains:
- `agent_id`: SHA-256(public_key) — 32 bytes
- `public_key`: ML-DSA-65 public key — 1952 bytes
- `capabilities`: e.g., `["inference", "translation"]`
- `endpoints`: e.g., `["quic://1.2.3.4:4433"]`
- `version`: monotonically increasing (starts at 1)
- `timestamp`: Unix epoch seconds at creation
- `signature`: ML-DSA-65 self-signature over CBOR-encoded record

**Source**: `aafp-identity/src/agent_record.rs` lines 9-26, 44-67.

### 2.3 DHT Publish (Local)

The agent's own record is immediately placed in the local
`CapabilityDht` during build:

```rust
// From builder.rs lines 177-179:
let mut dht = dht;
dht.put(record.clone())
    .map_err(|e| SdkError::Discovery(e.to_string()))?;
```

The `CapabilityDht` indexes records by `SHA-256(capability_string)`:
- Key: `[u8; 32]` — hash of capability name
- Value: `Vec<DhtRecord>` — all agents advertising that capability
- Reverse index: `AgentId → Vec<capability_string>` for removal

**Source**: `aafp-discovery/src/capability_dht.rs` lines 50-104.

### 2.4 DHT Publish (Network — `aafp.discovery.announce`)

For network-wide discovery, the agent announces its record to peers via
the `aafp.discovery.announce` RPC (RFC-0004 §3.3):

```
Client → Server:  aafp.discovery.announce { 1: AgentRecord }
Server → Client:  { 1: [ *AgentRecord ] }  (known peers)
```

Rate limits (RFC-0004 §3.4):
- Announce: 1 per 60 seconds per agent
- Lookup: 10 per 60 seconds per agent
- Max records stored by a bootstrap node: 100,000
- Max concurrent streams per connection: 100

**Source**: `aafp-discovery/src/discovery_v1.rs` lines 22-44, 51-75.

### 2.5 Bootstrap

The agent connects to seed nodes to join the network:

```rust
let agent = Agent::connect()
    .with_seeds(vec!["quic://seed1.aafp.io:4433".into()])
    .connect().await?;
```

`BootstrapConfig` defaults:
- `timeout`: 30 seconds
- `min_peers`: 3 (bootstrap considered complete when 3+ peers discovered)

The bootstrap driver connects to seeds, exchanges peer lists via PEX
(Peer Exchange), and verifies `AgentRecord` signatures before adding
discovered peers.

**Source**: `aafp-discovery/src/bootstrap.rs` lines 26-44, 56-90,
`aafp-sdk/src/simple.rs` lines 887-924 (`ConnectBuilder`).

### 2.6 Registration Sequence Diagram

```
  New Agent                Seed Node              DHT Network
     │                        │                       │
     │ 1. Generate keypair    │                       │
     │ 2. Create AgentRecord  │                       │
     │ 3. Put in local DHT    │                       │
     │                        │                       │
     │ 4. QUIC connect ──────►│                       │
     │ 5. AAFP v1 handshake   │                       │
     │ 6. announce(record) ──►│                       │
     │                        │ 7. Verify signature   │
     │                        │ 8. Store in DHT ─────►│
     │ ◄────── peer list ─────│                       │
     │                        │                       │
     │ 9. PEX with new peers  │                       │
     │ 10. Build routing table│                       │
     │                        │                       │
     │ ◄─── bootstrap complete (min_peers reached) ───│
```

### 2.7 Serving vs Connecting

The SDK distinguishes two registration modes:

**Serving** (`Agent::serve()`): Agent binds a QUIC listener, accepts
incoming connections, and handles RPC requests. Returns a
`ServingAgent` with a `stop()` method.

```rust
let server = Agent::serve()
    .capability("echo")
    .on_capability("echo", |req, ctx| async move {
        Ok(Response::text(req.body()))
    })
    .start().await?;
```

**Connecting** (`Agent::connect()`): Agent joins the network as a
client, discovers peers by capability, and calls them. Returns a
`ConnectedAgent` with `discover()` and `call_at()` methods.

```rust
let client = Agent::connect()
    .with_seeds(vec!["quic://seed:4433".into()])
    .connect().await?;
let resp = client.discover("echo").call(Request::text("hi")).await?;
```

**Source**: `aafp-sdk/src/simple.rs` lines 513-628 (`ServeBuilder`),
881-924 (`ConnectBuilder`), 1506-1531 (`Agent` entry point).

---

## 3. Agent Deregistration

Deregistration is the graceful exit process: stop accepting connections,
notify peers, expire DHT records, and close all active connections.

### 3.1 Stopping the Server

The `ServingAgent::stop()` method sets an atomic boolean flag that
causes the accept loop to break:

```rust
// From simple.rs lines 874-878:
pub fn stop(&self) {
    self.running
        .store(false, std::sync::atomic::Ordering::SeqCst);
}
```

The accept loop checks this flag each iteration:

```rust
// From simple.rs lines 632-635:
loop {
    if !running_clone.load(std::sync::atomic::Ordering::SeqCst) {
        break;
    }
    let conn = match agent_clone.transport.accept().await { ... };
}
```

**Gap**: The current implementation stops accepting new connections but
does not proactively close existing connections or send CLOSE frames to
connected peers. A production implementation should:
1. Stop the accept loop (current behavior)
2. Send CLOSE frames to all active sessions (via `CloseManager`)
3. Wait for in-flight requests to complete (grace period)
4. Close the QUIC listener
5. Remove the agent's record from the DHT (or let it expire)

### 3.2 DHT Record Expiry

DHT records have a `timestamp` field and are subject to TTL-based
expiry. The `PersistentDht` (SQLite backend) stores an `expires_at`
column:

```sql
CREATE TABLE agent_records (
    agent_id BLOB PRIMARY KEY,
    record_data BLOB NOT NULL,
    capabilities TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_expires_at ON agent_records(expires_at);
```

When an agent deregisters, it should either:
- **Explicit removal**: Call `dht.remove_agent(&agent_id)` to
  immediately remove the record from the local DHT
- **TTL expiry**: Stop republishing the record; peers will evict it
  when `expires_at` is reached

**Source**: `aafp-discovery/src/persistent_dht.rs` lines 39-56,
`aafp-discovery/src/capability_dht.rs` (remove_agent method).

### 3.3 Connection Pool Cleanup

The `ConnectionPool` should be drained during deregistration:

```rust
// Evict all idle connections
pool.evict_idle().await;

// Remove specific peer connections
for peer_id in pool.peers().await {
    pool.remove(&peer_id).await;  // Sends close(0, "pool removal")
}
```

Each `remove()` call closes the QUIC connection with a reason code:

```rust
// From connection_pool.rs lines 282-287:
pub async fn remove(&self, peer_id: &AgentId) {
    let mut conns = self.connections.lock().await;
    if let Some(pc) = conns.remove(peer_id) {
        pc.conn.close(0, b"pool removal");
    }
}
```

**Source**: `aafp-sdk/src/connection_pool.rs` lines 278-287, 304-330.

### 3.4 Peer Notification

For graceful deregistration, the agent should notify connected peers
that it is going offline. This can be done via:

1. **CLOSE frame** (RFC-0002 §6.6): Sent on each active stream to
   indicate graceful closure. The `CloseManager` transitions:
   `Open → LocalCloseSent → CloseReceived → Closed`.

2. **DHT record update**: Publish a final `AgentRecord` with an empty
   endpoint list or a far-future expiry, signaling that the agent is
   no longer available.

3. **Relay disconnect**: If the agent uses relay forwarding (RFC 0010),
   it should disconnect from relays and stop relay reservations.

### 3.5 Deregistration Sequence Diagram

```
  Departing Agent          Peer A           Peer B         DHT
       │                     │                │             │
       │ 1. stop() ──────────│                │             │
       │ 2. CLOSE stream ───►│                │             │
       │ 3. CLOSE stream ───────────────────►│             │
       │ 4. Wait grace period│                │             │
       │ 5. Close QUIC conn ►│                │             │
       │ 6. Close QUIC conn ─────────────────►│             │
       │ 7. remove_agent() ───────────────────────────────►│
       │ 8. Evict pool       │                │             │
       │ 9. Disconnect relay │                │             │
       │                     │                │             │
       │ ◄── deregistered ───│                │             │
```

---

## 4. Agent Hibernation

Hibernation is a low-power mode where the agent reduces its resource
footprint: minimizes DHT participation, closes idle connections, and
stops proactive discovery — while remaining able to wake on demand.

### 4.1 Connection Pool Idle Eviction

The primary hibernation mechanism in the current implementation is the
connection pool's idle eviction. Connections not used for
`idle_timeout` (default: 60 seconds) are automatically closed:

```rust
// From connection_pool.rs lines 315-330:
fn evict_idle_locked(&self, conns: &mut HashMap<AgentId, PooledConnection>) -> usize {
    let now = Instant::now();
    let timeout = self.config.idle_timeout;
    let to_evict: Vec<AgentId> = conns
        .iter()
        .filter(|(_, pc)| now.duration_since(pc.last_used) > timeout)
        .map(|(id, _)| *id)
        .collect();
    for id in &to_evict {
        if let Some(pc) = conns.remove(id) {
            pc.conn.close(0, b"idle timeout");
        }
    }
    to_evict.len()
}
```

**Source**: `aafp-sdk/src/connection_pool.rs` lines 44-45
(`DEFAULT_IDLE_TIMEOUT = 60s`), 315-330.

### 4.2 Keep-Alive Tuning

Keep-alive PING/PONG behavior (RFC-0002 §4.7-4.8) can be tuned for
hibernation:

```rust
// Active mode: frequent keep-alives
let active_config = KeepAliveConfig {
    interval: Duration::from_secs(30),
    timeout: Duration::from_secs(10),
    max_missed: 3,
};

// Hibernation mode: infrequent keep-alives (or disabled)
let hibernate_config = KeepAliveConfig::disabled();
// or:
let hibernate_config = KeepAliveConfig {
    interval: Duration::from_secs(300),  // 5 minutes
    timeout: Duration::from_secs(60),
    max_missed: 1,
};
```

**Source**: `aafp-sdk/src/builder.rs` lines 85-97 (`with_keepalive`,
`disable_keepalive`).

### 4.3 Hibernation Strategy (Recommended)

A full hibernation implementation would layer these reductions:

| Resource | Active | Hibernating |
|----------|--------|-------------|
| Connection pool idle timeout | 60s | 5s (aggressive eviction) |
| Keep-alive interval | 30s | 300s or disabled |
| DHT bucket refresh | 15 min | 60 min or paused |
| Bootstrap re-discovery | Continuous | On wake only |
| Accept loop | Running | Paused |
| Metrics reporting | Active | Reduced frequency |

### 4.4 Hibernation State Diagram

```
   ┌──────────┐    hibernate()     ┌──────────────┐
   │  Active  │──────────────────►│  Hibernating │
   └────┬─────┘                    └──────┬───────┘
        │                                 │
        │ wake() / incoming connection    │
        │◄────────────────────────────────┘
        │                                 │
        │  (wake triggers:                │
        │   - incoming QUIC connection    │
        │   - explicit wake() call        │
        │   - scheduled task)             │
        │                                 │
   ┌────▼─────┐                    ┌──────▼───────┐
   │  Active  │                    │  Hibernating │
   │ (full    │                    │ (reduced     │
   │  pool,   │                    │  pool,       │
   │  refresh)│                    │  no refresh) │
   └──────────┘                    └──────────────┘
```

---

## 5. Agent Migration

Migration moves an agent to a new host while preserving its identity
and redirecting peers to the new location.

### 5.1 Identity Portability

The agent's identity is rooted in its `AgentKeypair`. As long as the
keypair is preserved, the `AgentId` remains the same across hosts:

```rust
// On old host: save keypair
let kp = agent.keypair.clone();
let kp_bytes = kp.to_bytes();
// ... transfer kp_bytes to new host ...

// On new host: restore keypair
let kp = AgentKeypair::from_bytes(&kp_bytes)?;
let agent = AgentBuilder::new()
    .with_keypair(kp)
    .with_capabilities(vec!["inference".into()])
    .bind(new_addr)
    .build().await?;
```

**Source**: `aafp-sdk/src/builder.rs` lines 49-53,
`aafp-identity/src/keypair.rs`.

### 5.2 Endpoint Update & DHT Republish

The new host will have a different endpoint address. The agent must
create a new `AgentRecord` with the updated endpoint and an incremented
version number, then republish to the DHT:

```rust
// Create updated record with new endpoint and version + 1
let new_record = AgentRecord::new_with_version(
    &keypair,
    capabilities,
    vec![new_multiaddr],  // new endpoint
    old_record.version + 1,
    now,
);

// Publish to local DHT (replaces old record via remove_agent + re-index)
dht.put(new_record)?;

// Announce to network
// → aafp.discovery.announce RPC to seed nodes
```

The `CapabilityDht::put()` automatically removes old capabilities for
the same `AgentId` before indexing the new ones:

```rust
// From capability_dht.rs lines 83-87:
let agent_id = record.agent_id;
self.remove_agent(&agent_id);  // Remove old capabilities
// Then index by each new capability...
```

**Source**: `aafp-discovery/src/capability_dht.rs` lines 78-104,
`aafp-identity/src/agent_record.rs` lines 69-90 (`new_with_version`).

### 5.3 Monotonic Version Enforcement

The `KeyDirectory` enforces monotonic version numbers to prevent
rollback attacks during migration:

```rust
// From key_directory.rs lines 94-99:
if let Some(existing) = self.records.get(&record.agent_id) {
    if record.record_version < existing.record_version {
        return Err(DirectoryError::InvalidRecord(
            "record_version is older than existing".to_string(),
        ));
    }
}
```

Rate limiting: 1 publish per `AgentId` per hour (RFC 0011 §3.7).

**Source**: `aafp-identity/src/key_directory.rs` lines 13-14, 80-99.

### 5.4 Peer Redirect

During migration, peers that have cached the old endpoint will fail to
connect. They will fall back to DHT lookup, which returns the updated
record with the new endpoint. The failover mechanism in
`DiscoveryBuilder::call()` tries all candidates:

```rust
// From simple.rs lines 1056-1071:
let mut last_error: Option<SdkError> = None;
for peer in candidates {
    if let Some(addr) = peer.endpoints.first() {
        match call_agent_with_pool(&self.agent, &self.pool, addr, request.clone()).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                tracing::warn!("call to {addr} failed: {e:?}, trying next candidate");
                last_error = Some(e);
                continue;
            }
        }
    }
}
```

**Source**: `aafp-sdk/src/simple.rs` lines 1041-1071.

### 5.5 Migration Sequence Diagram

```
  Old Host              New Host            DHT Network         Peers
     │                     │                    │                 │
     │ 1. Save keypair     │                    │                 │
     │ 2. Stop serving     │                    │                 │
     │ 3. Transfer kp ────►│                    │                 │
     │                     │ 4. Build agent     │                 │
     │                     │ 5. New record v+1  │                 │
     │                     │ 6. announce ──────►│                 │
     │                     │                    │ 7. Update record│
     │                     │                    │    (version chk)│
     │                     │ 8. Start serving   │                 │
     │                     │                    │                 │
     │                     │                    │ 9. Peer lookup ─►│
     │                     │                    │    → new endpoint│
     │                     │ ◄──────────────────────── connect    │
     │                     │ 10. Serve requests │                 │
```

### 5.6 Key Rotation (Identity Migration)

If the agent needs a new keypair (not just a new host), it uses the
key rotation protocol (RFC 0011 §6). A `KeyRotationRecord` is signed by
both old and new keys, proving continuity of identity:

```cbor
KeyRotationRecord = {
    1: tstr,    // type: "aafp-rotation-v1"
    2: bstr,    // old_agent_id: 32 bytes
    3: bstr,    // new_agent_id: 32 bytes
    4: bstr,    // new_public_key: 1952 bytes
    5: uint,    // timestamp
    6: bstr,    // old_signature (ML-DSA-65)
    7: bstr,    // new_signature (ML-DSA-65)
}
```

**Source**: `aafp-identity/src/key_rotation.rs` lines 1-22, 78-100.

---

## 6. Agent Versioning

Versioning covers capability version negotiation and backward
compatibility across agent software versions.

### 6.1 AgentRecord Version Field

The `AgentRecord` has a `version: u64` field that is monotonically
increasing. This is used for:
- **Record freshness**: Peers prefer higher version records
- **Rollback prevention**: `KeyDirectory` rejects older versions
- **Update detection**: Peers can detect when a record has been updated

**Source**: `aafp-identity/src/agent_record.rs` lines 20-21, 69-90.

### 6.2 Capability Strings

Capabilities are free-form strings (e.g., `"inference"`,
`"translation"`, `"echo"`). Versioning of capabilities is by
convention:

```
"inference"          → latest version
"inference.v1"       → pinned to v1
"inference.v2"       → pinned to v2
"sum"                → v2 structured params (Params IntMap)
```

The SDK supports both v1 (text body) and v2 (structured `Params`) for
the same capability. The server routes based on the RPC method name
(which is the capability string):

```rust
// From simple.rs lines 706-720:
let capability = rpc_req.method.clone();
let mut request = match &rpc_req.params {
    Value::TextString(s) => Request::text(s.clone()),      // v1
    Value::ByteString(b) => Request::data(b.clone()),       // v1 binary
    Value::IntMap(entries) => {                             // v2 structured
        let params = Params { entries: entries.clone() };
        Request::with_params(params)
    }
    _ => Request::text(String::new()),
};
```

**Source**: `aafp-sdk/src/simple.rs` lines 700-720.

### 6.3 Protocol Version Negotiation

The AAFP v1 handshake includes protocol version negotiation. The
`PROTOCOL_VERSION` constant and `KEY_ALG_ML_DSA_65` algorithm
identifier are exchanged in `ClientHello` / `ServerHello` messages.

The handshake driver verifies:
1. Protocol version compatibility
2. Key algorithm support (ML-DSA-65)
3. Feature negotiation (PQ KEX enabled/disabled)

**Source**: `aafp-sdk/src/handshake_driver.rs` lines 26-33,
`aafp-sdk/src/builder.rs` lines 79-83 (`with_pq`).

### 6.4 Backward Compatibility Strategy

| Component | v1 (Legacy) | v2 (Current) | Compatibility |
|-----------|-------------|--------------|---------------|
| RPC params | Text string / bytes | CBOR IntMap (`Params`) | Auto-detect by type |
| Handlers | `handler()` — single fallback | `on_capability()` — per-cap | v1 wraps into v2 |
| Streaming | N/A | `on_streaming()` | New feature |
| AgentRecord | `agent_record.rs` (deprecated) | `identity_v1::AgentRecord` | Both kept |
| Handshake | `handshake.rs` (deprecated) | `handshake_v1` (RFC-compliant) | Legacy for benchmarks |

The v1 `handler()` API is converted to v2 internally:

```rust
// From simple.rs lines 542-556:
pub fn handler<F, Fut>(mut self, f: F) -> Self
where F: Fn(Request) -> Fut + Send + Sync + 'static,
      Fut: Future<Output = Result<Response, String>> + Send + 'static,
{
    let f = Arc::new(f);
    self.fallback_handler = Some(Arc::new(move |req: Request, _ctx: HandlerContext| {
        let f = f.clone();
        Box::pin(async move {
            let s = f(req).await;
            s.map_err(HandlerError::Application)
        })
    }));
    self
}
```

**Source**: `aafp-sdk/src/simple.rs` lines 538-556.

### 6.5 Capability Negotiation State Diagram

```
   ┌─────────────┐
   │   Client    │
   │ discover()  │
   │ "inference" │
   └──────┬──────┘
          │ find_by_capability("inference")
          ▼
   ┌──────────────────┐
   │ DHT returns      │
   │ [AgentRecord]    │
   │ caps: ["infer.."]│
   └──────┬───────────┘
          │
          │ ├─ v2 client? → Request::with_params(Params)
          │ │                method = "inference"
          │ │
          │ └─ v1 client? → Request::text("hello")
          │                  method = "call"
          ▼
   ┌──────────────────┐
   │ Server routes    │
   │ by method name   │
   └──────┬───────────┘
          │
          ├─ streaming_handlers["inference"]? → stream
          ├─ capability_handlers["inference"]? → unary
          └─ fallback_handler? → unary
```

---

## 7. Agent Health Monitoring

Health monitoring combines self-reported metrics, peer observation, and
relay monitoring to determine agent health.

### 7.1 Self-Reporting: AgentMetrics

`AgentMetrics` provides lock-free atomic counters updated from any
thread:

| Counter | Description |
|---------|-------------|
| `connections_active` | Current authenticated connections |
| `connections_total` | Cumulative connections ever established |
| `messages_sent` / `messages_received` | Total message count |
| `bytes_sent` / `bytes_received` | Total bytes transferred |
| `handshakes_completed` / `handshakes_failed` | Handshake outcomes |
| `dht_records` | DHT records stored |
| `relay_connections` | Active relay connections |
| `messages_failed` | Messages that failed (send error, timeout) |
| `start_time` | Agent start time (for uptime) |

```rust
// Recording events:
agent.metrics.record_connection();
agent.metrics.record_sent(1024);
agent.metrics.record_received(512);
agent.metrics.record_handshake();
agent.metrics.record_disconnect();
```

**Source**: `aafp-sdk/src/metrics.rs` lines 17-43, 64-115.

### 7.2 Health Status Derivation

`HealthStatus` is derived from the metrics snapshot:

```rust
// From metrics.rs lines 260-277:
pub fn from_metrics(snapshot: &MetricsSnapshot) -> Self {
    let error_rate = snapshot.error_rate();
    let handshake_failure_rate = snapshot.handshake_failure_rate();
    let has_connections = snapshot.connections_active > 0;
    let uptime_ok = snapshot.uptime_seconds > 60;

    // Unhealthy: no connections after warmup, or critical error rate
    if (!has_connections && uptime_ok) || error_rate > 0.5 {
        return Self::Unhealthy;
    }

    // Degraded: high error rate, or high handshake failure rate
    if error_rate > 0.1 || handshake_failure_rate > 0.3 {
        return Self::Degraded;
    }

    Self::Healthy
}
```

| Status | Condition |
|--------|-----------|
| **Healthy** | Has connections, error rate ≤ 10%, handshake failure ≤ 30% |
| **Degraded** | Error rate > 10%, or handshake failure > 30%, or < 1 conn after 60s |
| **Unhealthy** | No connections after 60s uptime, or error rate > 50% |

**Warmup period**: During the first 60 seconds of uptime, no
connections is considered Healthy (not Unhealthy).

**Source**: `aafp-sdk/src/metrics.rs` lines 230-277.

### 7.3 Metrics RPC

Health and metrics are exposed via the `aafp.metrics` RPC method,
returning a `MetricsRpcResponse` (CBOR-serialized):

```rust
pub struct MetricsRpcResponse {
    pub metrics: MetricsSnapshot,
    pub health: HealthStatus,
    pub agent_id: String,
}
```

**Source**: `aafp-sdk/src/metrics.rs` lines 284-317.

### 7.4 Prometheus Export

The `PrometheusExporter` serves metrics in Prometheus format on a
configurable HTTP endpoint:

```rust
let server = Agent::serve()
    .capability("echo")
    .with_metrics("127.0.0.1:9090".parse().unwrap())
    .start().await?;
```

**Source**: `aafp-sdk/src/simple.rs` lines 604-607, 828-839,
`aafp-sdk/src/prometheus.rs`.

### 7.5 Peer Observation

Peers observe health indirectly through:
- **Connection health checks**: The connection pool's `is_healthy()`
  method tests connections by opening a bidirectional stream
- **Keep-alive PING/PONG**: RFC-0002 §4.7-4.8 — missed PONGs indicate
  peer unreachability
- **DHT record freshness**: Stale records (old timestamp) suggest the
  agent is no longer republishing

```rust
// Connection pool health check (connection_pool.rs lines 337-347):
async fn is_healthy(conn: &QuicConnection) -> bool {
    match conn.open_bi().await {
        Ok((_send, _recv)) => true,
        Err(_) => false,
    }
}
```

### 7.6 Relay Monitoring

Relay nodes (RFC 0010) monitor connected agents:
- `relay_connections` metric tracks active relay connections
- `RelayDiscovery` health-checks bootstrap relays and selects the best
  one for relayed connections
- `AutoNatV1DialBack` detects NAT status via peer dial-back checks

```rust
// Agent NAT status (lib.rs lines 167-184):
pub fn nat_status_v1(&self) -> &aafp_nat::auto_nat_v1::NatStatus { ... }
pub fn is_behind_nat(&self) -> bool { ... }
pub fn is_publicly_reachable(&self) -> bool { ... }
pub fn select_best_relay(&self) -> Option<&aafp_nat::RelayNodeInfo> { ... }
```

**Source**: `aafp-sdk/src/lib.rs` lines 167-199,
`aafp-nat/src/auto_nat_v1.rs`, `aafp-nat/src/relay_discovery.rs`.

### 7.7 Health Monitoring Architecture

```
   ┌─────────────────────────────────────────────────────┐
   │                   Agent Process                      │
   │                                                      │
   │  ┌──────────────┐    ┌──────────────┐               │
   │  │ AgentMetrics │    │ HealthStatus │               │
   │  │ (AtomicU64)  │───►│ from_metrics │               │
   │  └──────┬───────┘    └──────┬───────┘               │
   │         │                   │                        │
   │         │ self-report       │ aafp.metrics RPC       │
   │         ▼                   ▼                        │
   │  ┌──────────┐       ┌──────────────┐                │
   │  │ Prometheus│       │ MetricsRpc   │                │
   │  │ Exporter  │       │ Response     │                │
   │  └──────────┘       └──────────────┘                │
   └─────────────────────────────────────────────────────┘
          │                           │
          │ scrape /metrics           │ RPC call
          ▼                           ▼
   ┌──────────┐              ┌──────────────┐
   │  Monitor │              │  Peer Agent  │
   │ (Grafana)│              │ (observer)   │
   └──────────┘              └──────┬───────┘
                                    │
                                    │ keep-alive PING/PONG
                                    │ connection pool health check
                                    │ DHT record freshness
                                    ▼
                             ┌──────────────┐
                             │ Health       │
                             │ Determination│
                             └──────────────┘
```

---

## 8. Agent Restart & Crash Recovery

Restart covers crash recovery and state reconstruction from persistent
storage and peer state.

### 8.1 Persistent DHT (SQLite)

The `PersistentDht` provides SQLite-backed DHT storage that survives
process restarts:

```rust
// Open persistent DHT from file
let dht = PersistentDht::open("agent_dht.db")?;

// Or in-memory (for testing)
let dht = PersistentDht::in_memory()?;
```

Schema:
```sql
CREATE TABLE agent_records (
    agent_id BLOB PRIMARY KEY,
    record_data BLOB NOT NULL,
    capabilities TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_capabilities ON agent_records(capabilities);
CREATE INDEX idx_expires_at ON agent_records(expires_at);
PRAGMA journal_mode=WAL;
```

On restart, the agent loads all records from SQLite, reconstructing its
local DHT view. Expired records (where `expires_at < now`) are
evicted.

**Source**: `aafp-discovery/src/persistent_dht.rs` lines 14-56.

### 8.2 Keypair Persistence

The `AgentKeypair` must be persisted to maintain identity across
restarts. The keypair can be derived from a seed:

```rust
// Save seed (32 bytes) securely
let seed = keypair.seed();
// ... store seed in secure storage (vault, HSM, encrypted file) ...

// On restart: reconstruct keypair from seed
let kp = AgentKeypair::from_seed(&seed);
```

ML-DSA-65 supports deterministic key generation from seeds (FIPS 204),
enabling identical keys across restarts. Cross-language interop is
verified (A-10): Rust and Go produce identical keys from the same seed.

**Source**: `aafp-crypto::dsa::MlDsa65::keypair_from_seed()`.

### 8.3 State Reconstruction

On restart, the agent reconstructs its state from multiple sources:

| State | Source | Reconstruction Method |
|-------|--------|----------------------|
| Identity (keypair) | Secure storage | `AgentKeypair::from_seed()` |
| AgentRecord | Keypair + config | `AgentRecord::new()` (re-sign) |
| DHT records | SQLite (`PersistentDht`) | `PersistentDht::open()` |
| Peer connections | DHT lookup | `find_by_capability()` |
| Routing table | Bootstrap + PEX | Connect to seeds, exchange peers |
| Metrics | Reset to zero | `AgentMetrics::new()` |
| Session state | N/A (per-connection) | New handshakes required |
| UCAN delegations | Persistent storage | Load from disk, verify expiry |

### 8.4 Restart Sequence Diagram

```
  Crashed Agent          SQLite DHT         Seed Nodes        Peers
       │                     │                 │               │
       │ 1. Process starts   │                 │               │
       │ 2. Load keypair     │                 │               │
       │    from seed        │                 │               │
       │ 3. Open DHT ───────►│                 │               │
       │ ◄─── records ───────│                 │               │
       │ 4. Create record    │                 │               │
       │    (same AgentId)   │                 │               │
       │ 5. Build agent      │                 │               │
       │ 6. Bootstrap ───────────────────────►│               │
       │ ◄────────── peer list ───────────────│               │
       │ 7. PEX with peers ──────────────────────────────────►│
       │ 8. Re-establish connections                          │
       │ 9. Resume serving                                    │
       │                                                      │
       │ ◄─── recovered ──────────────────────────────────────│
```

### 8.5 Crash Recovery Considerations

- **No WAL data loss**: SQLite WAL mode ensures committed records
  survive crashes
- **Connection pool reset**: All pooled connections are lost on crash;
  new handshakes are required (240µs each)
- **In-flight requests**: Lost on crash; clients must retry with
  failover (the `DiscoveryBuilder::call()` tries all candidates)
- **UCAN token expiry**: Tokens have `exp` (expiration) and `nbf`
  (not-before) timestamps; expired tokens are automatically rejected

---

## 9. Agent Scaling

Scaling covers horizontal (more instances) and vertical (more
capabilities) approaches.

### 9.1 Horizontal Scaling (More Instances)

Multiple agent instances can serve the same capability. The DHT
naturally supports this — `find_by_capability()` returns all agents
advertising a capability:

```rust
// From lib.rs lines 207-209:
pub fn find_by_capability(&self, capability: &str) -> Vec<&AgentRecord> {
    self.dht.get(capability)
}
```

The `DiscoveryBuilder::call()` implements automatic failover across all
discovered candidates:

```rust
// From simple.rs lines 1056-1071:
for peer in candidates {
    if let Some(addr) = peer.endpoints.first() {
        match call_agent_with_pool(&self.agent, &self.pool, addr, request.clone()).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                tracing::warn!("call to {addr} failed: {e:?}, trying next candidate");
                last_error = Some(e);
                continue;
            }
        }
    }
}
```

**Load balancing**: The current implementation tries candidates in
DHT-returned order (not round-robin or least-connections). A production
implementation would add:
- Random candidate ordering
- Weighted selection by latency/health
- Circuit breakers per peer

### 9.2 Vertical Scaling (More Capabilities)

An agent can advertise multiple capabilities:

```rust
let server = Agent::serve()
    .capability("inference")
    .capability("translation")
    .capability("sum")
    .on_capability("inference", inference_handler)
    .on_capability("translation", translation_handler)
    .on_capability("sum", sum_handler)
    .start().await?;
```

Each capability gets its own handler, routed by the RPC method name:

```rust
// From simple.rs lines 746-776:
let handler = capability_handlers
    .get(&capability)
    .cloned()
    .or_else(|| fallback_handler.clone());
```

**Source**: `aafp-sdk/src/simple.rs` lines 531-537, 746-776.

### 9.3 Connection Scaling

The server enforces resource limits (Track Q4):

| Limit | Default | Configurable |
|-------|---------|-------------|
| Max connections | 100 | `ServerConfig::max_connections` |
| Handshake rate (per IP) | 10/sec | `ServerConfig::handshake_rate_limit` |
| Rate limiter max entries | 10,000 | `HandshakeRateLimiter::max_entries` |
| Connection pool max size | 100 | `PoolConfig::max_size` |
| Connection pool idle timeout | 60s | `PoolConfig::idle_timeout` |

```rust
let server = AgentServer::with_config(ServerConfig {
    max_connections: 1000,
    handshake_rate_limit: 50,
});
```

**Source**: `aafp-sdk/src/server.rs` lines 24-28, 30-46, 53-64.

### 9.4 Runtime Scaling

The Tokio runtime can be tuned for workload characteristics:

```rust
// High-throughput: multi-thread, auto workers
let agent = AgentBuilder::new()
    .with_runtime_config(RuntimeConfig::high_throughput())
    .build().await?;

// Low-latency: single-thread (84% less overhead for localhost RPC)
let agent = AgentBuilder::new()
    .with_low_latency_runtime()
    .build().await?;
```

| Preset | Flavor | Workers | Stack Size | Best For |
|--------|--------|---------|------------|----------|
| `default()` | MultiThread | auto (core count) | 2MB | Production servers |
| `low_latency()` | CurrentThread | 1 | 2MB | Localhost RPC |
| `high_throughput()` | MultiThread | auto | 2MB | Concurrent connections |

**Source**: `aafp-sdk/src/runtime_config.rs` lines 1-60,
`aafp-sdk/src/builder.rs` lines 99-118.

### 9.5 Scaling State Diagram

```
   HORIZONTAL SCALING                    VERTICAL SCALING
   (more instances)                     (more capabilities)

   ┌────────┐ ┌────────┐ ┌────────┐    ┌────────────────────┐
   │Agent A │ │Agent B │ │Agent C │    │     Agent D         │
   │"infer" │ │"infer" │ │"infer" │    │ "infer"+"translate"│
   └───┬────┘ └───┬────┘ └───┬────┘    └─────────┬──────────┘
       │          │          │                    │
       └──────────┴──────────┘                    │
                  │                               │
            ┌─────▼─────┐                   ┌─────▼─────┐
            │    DHT    │                   │  Handler  │
            │ "infer" → │                   │  Router   │
            │ [A, B, C] │                   │           │
            └─────┬─────┘                   └─────┬─────┘
                  │                               │
            ┌─────▼─────┐              ┌──────────┼──────────┐
            │  Client   │              │          │          │
            │  failover │              ▼          ▼          ▼
            │  A→B→C    │          infer_h    trans_h    sum_h
            └───────────┘          handler    handler    handler
```

---

## 10. Agent Composition

Composition allows a parent agent to spawn child agents for subtasks,
delegating capabilities via UCAN tokens.

### 10.1 UCAN Capability Delegation

UCAN (User Controlled Authorization Networks) tokens delegate
capabilities from a parent (issuer) to a child (audience) agent:

```rust
// From ucan.rs lines 72-107:
pub fn delegate(
    issuer: &AgentKeypair,       // Parent agent's keypair
    audience: &AgentId,          // Child agent's AgentId
    capabilities: Vec<Capability>,
    expires_at: u64,
) -> Result<Self, IdentityError>
```

Each `Capability` specifies:
- `resource`: e.g., `"compute.inference"`
- `action`: e.g., `"invoke"`
- `constraints`: Optional JSON (e.g., `{"max_tokens": 1000}`)

**Source**: `aafp-identity/src/ucan.rs` lines 22-31, 72-107.

### 10.2 UCAN Chain Linking

Delegation chains are built by linking tokens via the `prf` (proof)
field — a hash of the parent token:

```rust
// From ucan.rs lines 109-120:
pub fn delegate_with_proof(
    issuer: &AgentKeypair,
    audience: &AgentId,
    capabilities: Vec<Capability>,
    expires_at: u64,
    parent_token: &UcanToken,  // Links to parent for chain verification
) -> Result<Self, IdentityError>
```

Chain verification walks from root → leaf, checking ML-DSA-65
signatures at each link.

### 10.3 Parent-Child Agent Pattern

```
   ┌─────────────────┐
   │   Parent Agent   │
   │   caps: ["orch"] │
   └────────┬────────┘
            │
            │ UCAN delegate(
            │   issuer: parent_kp,
            │   audience: child_id,
            │   caps: [Capability {
            │     resource: "compute.inference",
            │     action: "invoke",
            │     constraints: {"max_tokens": 1000}
            │   }],
            │   expires_at: now + 3600
            │ )
            │
     ┌──────┴──────┐
     ▼             ▼
   ┌─────┐       ┌─────┐
   │Child│       │Child│
   │  A  │       │  B  │
   │"inf"│       │"inf"│
   └──┬──┘       └──┬──┘
      │              │
      │ UCAN chain   │ UCAN chain
      │ (root→A)     │ (root→B)
      ▼              ▼
   ┌──────────────────┐
   │  Target Agent    │
   │  caps: ["infer"] │
   │  verifies chain  │
   └──────────────────┘
```

### 10.4 Composition Lifecycle

1. **Parent spawns child**: Parent generates a new keypair for the
   child (or the child generates its own and shares its `AgentId`)
2. **Parent delegates**: Parent creates a UCAN token delegating
   specific capabilities to the child
3. **Child registers**: Child joins the network with its own
   `AgentRecord` and the delegated UCAN token
4. **Child acts**: Child presents the UCAN chain when invoking
   capabilities on target agents
5. **Child reports**: Child sends results back to parent (via RPC or
   pubsub)
6. **Child retires**: UCAN token expires; child deregisters

### 10.5 Authorization Provider Integration

The `AuthorizationProvider` trait is pluggable — UCAN-based
authorization verifies the token chain during the handshake:

```rust
// Session authorization check (server.rs lines 152-155):
pub fn is_authorized(&self, capability: &str) -> bool {
    self.session.is_authorized(capability)
}
```

**Source**: `aafp-sdk/src/server.rs` lines 128-156,
`aafp-core::AuthorizationProvider`.

---

## 11. Agent Retirement

Retirement is the final lifecycle stage: archive data, revoke UCAN
delegations, and notify dependents.

### 11.1 Data Archival

Before retirement, the agent should archive:
- **DHT records**: Export from `PersistentDht` to cold storage
- **Metrics history**: Export `MetricsSnapshot` series to time-series DB
- **UCAN tokens**: Archive issued delegation tokens (for audit trail)
- **AgentRecord**: Archive the final record (with max version number)

### 11.2 UCAN Revocation

UCAN tokens have expiration timestamps (`exp`). To revoke before
expiry:

1. **Natural expiry**: Stop renewing tokens; they expire at `exp`
2. **Explicit revocation**: Publish a `RevocationEntry` to a CRL
   (Certificate Revocation List)

```rust
// From revocation.rs lines 61-80:
pub fn new(
    agent_id: AgentId,        // The AgentId being revoked
    revoked_at: u64,          // Timestamp
    reason: Option<String>,   // "compromised", "retired", etc.
    revoking_key_id: AgentId, // Who signed the revocation
    secret_key: &MlDsa65SecretKey,
) -> Self
```

The CRL is CBOR-encoded and signed with ML-DSA-65. Peers check the CRL
before accepting connections (default CRL TTL: 1 hour).

**Source**: `aafp-identity/src/revocation.rs` lines 14-17, 44-80.

### 11.3 Key Revocation

If the agent's key is compromised (not just retired), a
`RevocationEntry` with reason `"compromised"` is published. The
`TrustManager` checks revocation status after handshake:

```rust
// From trust_manager.rs lines 50-73:
pub enum TrustResult {
    Trusted { source: TrustSource, level: u8 },
    Untrusted { reason: String },
    Revoked { reason: String },        // ← checked via RevocationStore
    Unknown { suggestion: TrustSuggestion },
}
```

**Source**: `aafp-identity/src/trust_manager.rs` lines 50-73.

### 11.4 Dependent Notification

Agents that depend on the retiring agent must be notified:

1. **Direct dependents**: Agents that hold UCAN tokens delegated by the
   retiring agent — notify via RPC or pubsub
2. **DHT peers**: The DHT record expires; peers discover the
   retirement via failed lookups
3. **Relay nodes**: Disconnect from relays; relay reservations are
   cancelled
4. **Connection pool peers**: Active connections are closed with CLOSE
   frames

### 11.5 Retirement Sequence Diagram

```
  Retiring Agent       CRL Distribution     Dependents       DHT
       │                     │                 │              │
       │ 1. Archive data     │                 │              │
       │ 2. Create CRL entry │                 │              │
       │    (reason: retired)│                 │              │
       │ 3. Publish CRL ────►│                 │              │
       │                     │ 4. Distribute ─►│              │
       │ 5. Notify deps ─────────────────────►│              │
       │ 6. CLOSE conns ─────────────────────►│              │
       │ 7. Stop serving     │                 │              │
       │ 8. Remove DHT record──────────────────────────────►│
       │ 9. Disconnect relays│                 │              │
       │ 10. Zero keypair    │                 │              │
       │     (secure wipe)   │                 │              │
       │                     │                 │              │
       │ ◄── retired ────────│                 │              │
```

---

## 12. Lifecycle Events

Lifecycle events are hooks that fire at key transitions, allowing
agents to execute custom logic.

### 12.1 Currently Implemented Events

| Event | Trigger | Mechanism |
|-------|---------|-----------|
| **on_connect** | New QUIC connection accepted | `transport.accept()` in accept loop |
| **on_handshake_complete** | AAFP v1 handshake succeeds | `establish_session()` returns `Ok` |
| **on_request** | RPC request received | Handler invocation via `on_capability()` |
| **on_streaming_request** | Streaming RPC request | `on_streaming()` handler |
| **on_disconnect** | Client disconnects | `CancellationToken` fires in handler |
| **on_stop** | `ServingAgent::stop()` called | Atomic boolean flag checked in loop |

### 12.2 Handler Context (Cancellation)

The `HandlerContext` provides a cancellation token that fires when the
client disconnects, allowing handlers to abort long-running operations:

```rust
// From simple.rs lines 224-229:
pub struct HandlerContext {
    pub cancel: tokio_util::sync::CancellationToken,
    pub capability: String,
}
```

Usage in a handler:

```rust
Agent::serve()
    .on_capability("long_task", |req, ctx| async move {
        // Check for cancellation during long operations
        for i in 0..1000 {
            if ctx.cancel.is_cancelled() {
                return Err(HandlerError::Application("cancelled".into()));
            }
            // ... do work ...
        }
        Ok(Response::text("done"))
    })
    .start().await?;
```

**Source**: `aafp-sdk/src/simple.rs` lines 218-229, 727-789.

### 12.3 Streaming Handler Context

Streaming handlers get a `StreamingHandlerContext` with a
`ResponseSender` for sending multiple response frames:

```rust
// From simple.rs lines 494-501:
pub struct StreamingHandlerContext {
    pub cancel: tokio_util::sync::CancellationToken,
    pub capability: String,
    pub sender: ResponseSender,
}
```

The streaming handler is monitored for client disconnect via a
`tokio::select!` race between the handler channel and the recv stream:

```rust
// From simple.rs lines 1167-1180:
let item = tokio::select! {
    item = rx.recv() => match item {
        Some(item) => item,
        None => break,
    },
    read_res = recv.read(&mut disconnect_buf) => {
        let _ = read_res;
        cancel_token.cancel();
        disconnected = true;
        break;
    }
};
```

**Source**: `aafp-sdk/src/simple.rs` lines 1143-1264.

### 12.4 Recommended Lifecycle Event API

The current SDK does not expose explicit lifecycle event callbacks
(`on_register`, `on_deregister`, `on_migrate`, `on_health_change`).
A recommended extension:

```rust
pub trait LifecycleHooks {
    /// Called after the agent's record is published to the DHT.
    fn on_register(&self, record: &AgentRecord) -> impl Future<Output = ()>;

    /// Called before the agent stops serving and removes its DHT record.
    fn on_deregister(&self, record: &AgentRecord) -> impl Future<Output = ()>;

    /// Called when the agent's endpoint changes (migration).
    fn on_migrate(&self, old: &AgentRecord, new: &AgentRecord) -> impl Future<Output = ()>;

    /// Called when health status transitions (e.g., Healthy → Degraded).
    fn on_health_change(&self, old: HealthStatus, new: HealthStatus) -> impl Future<Output = ()>;
}
```

### 12.5 Event Flow Diagram

```
   ┌──────────┐
   │  Build   │
   └────┬─────┘
        │ on_register(record)
        ▼
   ┌──────────┐
   │ Serving  │◄──── on_request(req, ctx) ──── per RPC
   └────┬─────┘◄──── on_streaming(req, ctx) ── per stream
        │
        │ on_health_change(Healthy → Degraded)
        │ on_health_change(Degraded → Unhealthy)
        │ on_health_change(Unhealthy → Healthy)
        │
        │ on_migrate(old_record, new_record)
        │
        │ on_deregister(record)
        ▼
   ┌──────────┐
   │ Stopped  │
   └──────────┘
```

---

## 13. State Management

This section categorizes what state must persist vs. what can be
reconstructed.

### 13.1 State Classification

```
   ┌─────────────────────────────────────────────────────────────┐
   │                    AGENT STATE                              │
   │                                                             │
   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
   │  │  PERSIST    │  │ RECONSTRUCT │  │  EPHEMERAL  │        │
   │  │  (must save)│  │ (rebuild)   │  │ (discard)   │        │
   │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
   │         │                │                │                 │
   │  • Keypair seed    • AgentRecord    • Session state        │
   │  • DHT records     • Routing table  • Connection pool      │
   │  • UCAN tokens     • Peer list      • In-flight requests   │
   │  • Trust anchors   • Metrics (reset)• Stream buffers       │
   │  • CRL entries     • NAT status     • Nonce cache          │
   │  • Config          • Relay selection• Replay cache         │
   └─────────────────────────────────────────────────────────────┘
```

### 13.2 Persistent State (Must Survive Restart)

| State | Storage | API |
|-------|---------|-----|
| Keypair (seed) | Secure storage (HSM, vault) | `AgentKeypair::from_seed()` |
| DHT records | SQLite (`PersistentDht`) | `PersistentDht::open(path)` |
| UCAN tokens | Application-managed | `UcanToken` (CBOR-serializable) |
| Trust anchors | `TrustManager` config | `TrustManager::new()` |
| CRL entries | `RevocationStore` | `RevocationList` (CBOR) |
| Agent config | Config file / env | `AgentBuilder` chain |

### 13.3 Reconstructible State (Rebuild from Network)

| State | Reconstruction Method |
|-------|----------------------|
| AgentRecord | `AgentRecord::new(&keypair, caps, endpoints)` |
| Routing table | Bootstrap to seeds → PEX → iterative lookup |
| Peer list | `BootstrapDiscovery::discovered()` |
| DHT (local view) | `PersistentDht::open()` + announce from peers |
| NAT status | `AutoNatV1DialBack` dial-back checks |
| Relay selection | `RelayDiscovery::select_best_relay()` |
| Metrics | `AgentMetrics::new()` (reset to zero) |

### 13.4 Ephemeral State (Discard on Restart)

| State | Lifetime | Notes |
|-------|----------|-------|
| Session state | Per-connection | New handshakes required (240µs) |
| Connection pool | Process lifetime | `ConnectionPool::new()` on restart |
| In-flight requests | Per-RPC | Clients retry with failover |
| Stream buffers | Per-stream | Lost on disconnect |
| Nonce cache | Per-handshake | Fresh nonces generated |
| Replay cache | Process lifetime | `ReplayCache::new()` on restart |
| Keep-alive state | Per-connection | PING/PONG resets |

### 13.5 State Consistency Guarantees

| Mechanism | Guarantee | Source |
|-----------|-----------|--------|
| AgentRecord signature | Record authenticity | `AgentRecord::verify()` |
| Monotonic version | No rollback | `KeyDirectory` version check |
| Rate-limited publish | 1/AgentId/hour | `KeyDirectory::RATE_LIMIT_SECS` |
| Replay cache | Nonce uniqueness | `ReplayCache::check_and_insert()` |
| CloseManager | Graceful teardown | 5-state machine (RFC-0002 §6.6) |
| UCAN expiry | Time-bounded delegation | `UcanPayload::exp` |
| CRL TTL | Revocation freshness | `DEFAULT_CRL_TTL_SECS = 3600` |

### 13.6 State Diagram: Persistence vs. Reconstruction

```
   ┌──────────────────────────────────────────────────┐
   │                  PERSISTENT LAYER                 │
   │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
   │  │ Keypair │  │   DHT   │  │  UCAN   │          │
   │  │  Seed   │  │ (SQLite)│  │ Tokens  │          │
   │  └────┬────┘  └────┬────┘  └────┬────┘          │
   │       │            │            │                 │
   └───────┼────────────┼────────────┼─────────────────┘
           │            │            │
   ┌───────▼────────────▼────────────▼─────────────────┐
   │               RECONSTRUCTED LAYER                  │
   │  ┌───────────┐  ┌───────────┐  ┌───────────┐     │
   │  │    Agent  │  │  Routing  │  │  Trust    │     │
   │  │  Record   │  │   Table   │  │  Manager  │     │
   │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘     │
   └────────┼──────────────┼──────────────┼───────────┘
            │              │              │
   ┌────────▼──────────────▼──────────────▼───────────┐
   │                 EPHEMERAL LAYER                    │
   │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐ │
   │  │Session │  │  Pool  │  │Metrics │  │ Replay │ │
   │  │ State  │  │ Conns  │  │ (reset)│  │ Cache  │ │
   │  └────────┘  └────────┘  └────────┘  └────────┘ │
   └──────────────────────────────────────────────────┘
```

---

## 14. Cross-Cutting Concerns

### 14.1 Security Throughout the Lifecycle

| Lifecycle Stage | Security Mechanism |
|----------------|-------------------|
| Registration | ML-DSA-65 keypair, self-signed AgentRecord |
| Connection | AAFP v1 handshake (PQ TLS + ML-DSA-65 signatures) |
| Messaging | Session keys from handshake, per-stream encryption |
| Authorization | UCAN capability chains, pluggable `AuthorizationProvider` |
| Deregistration | CRL revocation, UCAN token expiry |
| Retirement | Key revocation, CRL distribution, secure key wipe |

### 14.2 NAT Traversal Throughout the Lifecycle

| Lifecycle Stage | NAT Mechanism |
|----------------|--------------|
| Registration | AutoNAT dial-back detects NAT status |
| Active | DCuTR hole punching upgrades relayed → direct |
| Hibernation | Relay reservations maintained (reduced frequency) |
| Migration | New host's NAT status re-evaluated |
| Deregistration | Relay reservations cancelled |

**Source**: `aafp-sdk/src/lib.rs` lines 126-141, `aafp-nat/` crate.

### 14.3 Discovery Throughout the Lifecycle

| Lifecycle Stage | Discovery Activity |
|----------------|-------------------|
| Registration | Bootstrap to seeds, announce record, PEX |
| Active | DHT lookups, bucket refresh (15 min), PEX on new connections |
| Hibernation | Paused (no bucket refresh, no PEX) |
| Migration | Republish record with new endpoint (version + 1) |
| Deregistration | Remove record or let TTL expire |
| Restart | Load from `PersistentDht`, re-bootstrap |

### 14.4 Trust Throughout the Lifecycle

The `TrustManager` (RFC 0011 §8) combines five trust sources:

1. **Direct trust**: Connected before, key cached
2. **Web of Trust**: Transitive trust from peers
3. **CA trust**: Certificate from a trusted CA
4. **Directory trust**: Record from a trusted key directory
5. **TOFU**: Trust On First Use (no other source)

Trust is evaluated after handshake, before application data exchange.

**Source**: `aafp-identity/src/trust_manager.rs` lines 1-80.

---

## 15. Reference: Key Types & File Locations

### 15.1 SDK API (`aafp-sdk`)

| Type | File | Lines | Purpose |
|------|------|-------|---------|
| `Agent` (entry point) | `src/simple.rs` | 1506-1531 | `serve()` / `connect()` |
| `ServeBuilder` | `src/simple.rs` | 518-628 | Build serving agent |
| `ServingAgent` | `src/simple.rs` | 851-879 | Running server, `stop()` |
| `ConnectBuilder` | `src/simple.rs` | 887-924 | Build connected agent |
| `ConnectedAgent` | `src/simple.rs` | 931-1012 | Discovery + calls |
| `DiscoveryBuilder` | `src/simple.rs` | 1031-1096 | Discover + call with failover |
| `DirectCallBuilder` | `src/simple.rs` | 1100-1134 | Call by AgentId |
| `Request` / `Response` | `src/simple.rs` | 307-417 | RPC payload types |
| `Params` | `src/simple.rs` | 86-172 | CBOR IntMap structured data |
| `HandlerContext` | `src/simple.rs` | 224-229 | Cancellation + capability |
| `StreamingHandlerContext` | `src/simple.rs` | 494-501 | Streaming + sender |
| `HandlerError` | `src/simple.rs` | 235-293 | Typed errors (RFC-0005 codes) |
| `AgentBuilder` | `src/builder.rs` | 14-231 | Low-level agent builder |
| `Agent` (struct) | `src/lib.rs` | 110-143 | Full agent with all subsystems |
| `AgentMetrics` | `src/metrics.rs` | 17-143 | Lock-free atomic counters |
| `HealthStatus` | `src/metrics.rs` | 230-277 | Healthy/Degraded/Unhealthy |
| `MetricsSnapshot` | `src/metrics.rs` | 164-228 | Point-in-time metrics view |
| `ConnectionPool` | `src/connection_pool.rs` | 125-353 | QUIC connection reuse |
| `PoolConfig` | `src/connection_pool.rs` | 78-93 | Pool size + idle timeout |
| `AgentServer` | `src/server.rs` | 159-312 | Server with resource limits |
| `ServerConfig` | `src/server.rs` | 30-46 | Max conns + rate limit |
| `HandshakeRateLimiter` | `src/server.rs` | 53-126 | Per-IP handshake limiting |
| `RuntimeConfig` | `src/runtime_config.rs` | 44-56 | Tokio runtime tuning |
| `establish_session()` | `src/transport_binding.rs` | — | Handshake orchestration |
| `drive_client/server_handshake()` | `src/handshake_driver.rs` | 1-60 | v1 handshake driver |

### 15.2 Discovery (`aafp-discovery`)

| Type | File | Purpose |
|------|------|---------|
| `CapabilityDht` | `src/capability_dht.rs` | In-memory capability DHT |
| `PersistentDht` | `src/persistent_dht.rs` | SQLite-backed DHT |
| `DhtRouter` | `src/dht_router.rs` | Kademlia routing (256 k-buckets) |
| `BootstrapDiscovery` | `src/bootstrap.rs` | Seed-based network joining |
| `RegionalDiscovery` | `src/regional.rs` | Geographic discovery |
| `discovery_v1` | `src/discovery_v1.rs` | RFC-0004 announce/lookup/PEX |

### 15.3 Identity (`aafp-identity`)

| Type | File | Purpose |
|------|------|---------|
| `AgentId` | `src/agent_id.rs` | SHA-256(public_key), 32 bytes |
| `AgentKeypair` | `src/keypair.rs` | ML-DSA-65 keypair |
| `AgentRecord` | `src/agent_record.rs` | Self-signed identity record |
| `UcanToken` | `src/ucan.rs` | UCAN capability delegation |
| `KeyDirectory` | `src/key_directory.rs` | AgentId → AgentRecord mapping |
| `KeyRotationRecord` | `src/key_rotation.rs` | Old key signs new key (RFC 0011 §6) |
| `RevocationEntry` | `src/revocation.rs` | CRL-based revocation |
| `TrustManager` | `src/trust_manager.rs` | Unified trust decisions (RFC 0011 §8) |
| `WebOfTrust` | `src/web_of_trust.rs` | Transitive trust from peers |
| `CaCertificate` | `src/ca_certificate.rs` | CA-signed certificates |

### 15.4 Key Constants

| Constant | Value | Source |
|----------|-------|--------|
| `DEFAULT_MAX_POOL_SIZE` | 100 | `connection_pool.rs:48` |
| `DEFAULT_IDLE_TIMEOUT` | 60s | `connection_pool.rs:45` |
| `HEALTH_CHECK_THRESHOLD` | 5s | `connection_pool.rs:53` |
| `DEFAULT_MAX_CONNECTIONS` | 100 | `server.rs:25` |
| `DEFAULT_HANDSHAKE_RATE_LIMIT` | 10/sec | `server.rs:28` |
| `K_BUCKET_SIZE` | 20 | `dht_router.rs:45` |
| `ALPHA` (lookup concurrency) | 3 | `dht_router.rs:51` |
| `REPLICATION_FACTOR` | 5 | `dht_router.rs:54` |
| `BUCKET_REFRESH_INTERVAL` | 15 min | `dht_router.rs:57` |
| `RATE_LIMIT_SECS` (KeyDir) | 3600s | `key_directory.rs:14` |
| `DEFAULT_CRL_TTL_SECS` | 3600s | `revocation.rs:17` |
| `MAX_RECORDS` (bootstrap) | 100,000 | `discovery_v1.rs:35` |

---

## Appendix A: Complete Lifecycle State Machine

```
                         ┌─────────────────────────────────────────────────┐
                         │              AGENT LIFECYCLE                     │
                         │                                                 │
    ┌────────┐           │   ┌────────┐   register    ┌──────────┐         │
    │ Created│──────────►│   │Registered│────────────►│ Serving  │         │
    └────────┘           │   └────┬─────┘             └──┬───┬───┘         │
                         │        │                      │   │             │
                         │        │ connect()            │   │ stop()      │
                         │        ▼                      │   ▼             │
                         │   ┌──────────┐                │ ┌────────┐     │
                         │   │Connected │                │ │Deregister│   │
                         │   └────┬─────┘                │ └────┬───┘     │
                         │        │ discover/call        │      │          │
                         │        ▼                      │      │          │
                         │   ┌──────────┐                │      │          │
                         │   │  Active  │◄───────────────┘      │          │
                         │   └──┬───┬──┘                        │          │
                         │      │   │                            │          │
                         │      │   │ hibernate                  │          │
                         │      │   ▼                            │          │
                         │      │ ┌────────────┐                 │          │
                         │      │ │Hibernating │                 │          │
                         │      │ └────┬───────┘                 │          │
                         │      │      │ wake                     │          │
                         │      │      └────► Active              │          │
                         │      │                               │          │
                         │      │ migrate                       │          │
                         │      ▼                               │          │
                         │   ┌──────────┐                      │          │
                         │   │Migrating │──complete──►Active    │          │
                         │   └──────────┘                      │          │
                         │                                      │          │
                         │   ┌──────────┐                      │          │
                         │   │ Crashed  │◄─── kill -9 ── Active│          │
                         │   └────┬─────┘                      │          │
                         │        │ restart()                  │          │
                         │        └──────► Registered           │          │
                         │                                      ▼          │
                         │                               ┌──────────┐     │
                         │                               │ Retired  │     │
                         │                               └──────────┘     │
                         └─────────────────────────────────────────────────┘
```

## Appendix B: Session Lifecycle (Per-Connection)

```
   ┌──────┐     ┌───────────┐     ┌──────────────────────┐
   │ Idle │────►│Connecting │────►│TransportEstablished  │
   └──────┘     └───────────┘     └──────────┬───────────┘
                                             │
                                             ▼
                                   ┌──────────────────┐
                                   │IdentityVerified  │
                                   └────────┬─────────┘
                                            │
                                            ▼
                                   ┌──────────────────────┐
                                   │AuthorizationVerified │
                                   └────────┬─────────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │ MessagingEnabled │◄─── RPC / streaming
                                   └────────┬─────────┘
                                            │
                                            │ CLOSE (local or remote)
                                            ▼
                                   ┌──────────────────┐
                                   │     Closed       │
                                   └──────────────────┘
```

## Appendix C: DHT Record Lifecycle

```
   ┌────────────┐     put()      ┌─────────────┐
   │  Created   │───────────────►│  In DHT     │
   │ (signed)   │                │ (indexed by │
   └────────────┘                │  capability)│
                                 └──────┬──────┘
                                        │
                          ┌─────────────┼─────────────┐
                          │             │             │
                    remove_agent    TTL expiry    republish
                          │             │         (version+1)
                          ▼             ▼             │
                   ┌──────────┐  ┌──────────┐        │
                   │ Removed  │  │ Expired  │        │
                   └──────────┘  └──────────┘        │
                                                      ▼
                                               ┌─────────────┐
                                               │  In DHT     │
                                               │ (updated)   │
                                               └─────────────┘
```

---

*Document end. Generated from AAFP Rust implementation source code
analysis. All file paths and line numbers reference
`implementations/rust/crates/`.*
