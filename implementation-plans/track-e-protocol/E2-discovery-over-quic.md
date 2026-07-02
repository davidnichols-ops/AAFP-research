# Plan E2: Discovery Announce/Lookup Over QUIC (RFC-0004 §3)

**Priority:** HIGH (P1-2, required before public release)
**Track:** E (Protocol Features)
**Estimated effort:** 8-10 hours
**Blocked by:** E1 (keep-alive needed for long-lived discovery connections)
**Blocks:** E4 (relay needs discovery to find relay nodes), F4 (DHT extends this)

---

## Objective

Implement the network protocol for AAFP discovery: agents can announce
their AgentRecord to peers and look up agents by capability over QUIC
streams. Currently, discovery is in-memory only — there's no network
protocol to exchange AgentRecords between agents.

**Current state:**
- `aafp-discovery` crate has: `capability_dht.rs` (in-memory DHT),
  `discovery_v1.rs` (RPC method constants: `aafp.discovery.announce`,
  `aafp.discovery.lookup`), `bootstrap.rs`, `regional.rs`
- The RPC method names and params are defined but NOT wired to QUIC streams
- No server-side handler for incoming discovery RPC requests

**Source:** ROADMAP.md P1-2, RFC-0004 §3

---

## RFC Requirements (read RFC-0004 §3 before starting)

1. **Announce** (`aafp.discovery.announce`): Agent sends its AgentRecord
   to a peer. Peer responds with known peers (AgentRecords it has).
2. **Lookup** (`aafp.discovery.lookup`): Agent requests agents matching
   a capability name. Peer responds with matching AgentRecords.
3. Rate limiting: announce 1/60s, lookup 10/60s per connection
4. Bootstrap nodes are statically configured
5. AgentRecords have expiration (TTL)
6. DHT evicts expired records periodically

---

## Prerequisites

- E1 complete (keep-alive)
- Read `crates/aafp-discovery/src/discovery_v1.rs` (RPC method definitions)
- Read `crates/aafp-discovery/src/capability_dht.rs` (in-memory DHT)
- Read `RFCs/0004-discovery.md` §3 (network protocol)

---

## Steps

### E2.1: Implement discovery RPC server handler

Create `crates/aafp-discovery/src/rpc_handler.rs`:

```rust
//! Server-side handler for discovery RPC requests over QUIC.
//!
//! Handles `aafp.discovery.announce` and `aafp.discovery.lookup`
//! RPC requests received on AAFP RPC frames.

use std::sync::Arc;
use tokio::sync::Mutex;
use crate::capability_dht::CapabilityDht;
use crate::discovery_v1::*;
use aafp_identity::{AgentId, AgentRecord};

pub struct DiscoveryRpcHandler {
    dht: Arc<Mutex<CapabilityDht>>,
    /// Rate limiter: (agent_id, last_announce_time)
    announce_limits: Mutex<HashMap<AgentId, Instant>>,
    /// Rate limiter: (agent_id, last_lookup_time)
    lookup_limits: Mutex<HashMap<AgentId, Instant>>,
}

impl DiscoveryRpcHandler {
    pub fn new(dht: Arc<Mutex<CapabilityDht>>) -> Self {
        Self {
            dht,
            announce_limits: Mutex::new(HashMap::new()),
            lookup_limits: Mutex::new(HashMap::new()),
        }
    }

    /// Handle an incoming RPC request.
    /// Returns the RPC response payload (CBOR-encoded).
    pub async fn handle_request(
        &self,
        method: &str,
        params: &[u8],  // CBOR-encoded params
        caller_id: &AgentId,
    ) -> Result<Vec<u8>, DiscoveryError> {
        match method {
            METHOD_ANNOUNCE => self.handle_announce(params, caller_id).await,
            METHOD_LOOKUP => self.handle_lookup(params, caller_id).await,
            _ => Err(DiscoveryError::UnknownMethod(method.to_string())),
        }
    }

    async fn handle_announce(&self, params: &[u8], caller_id: &AgentId) -> Result<Vec<u8>, DiscoveryError> {
        // 1. Rate limit check (1 per 60s)
        // 2. Decode AgentRecord from params
        // 3. Verify the record's AgentId matches caller_id
        // 4. Insert into DHT
        // 5. Return known peers (up to a limit)
    }

    async fn handle_lookup(&self, params: &[u8], caller_id: &AgentId) -> Result<Vec<u8>, DiscoveryError> {
        // 1. Rate limit check (10 per 60s)
        // 2. Decode capability name from params
        // 3. Query DHT for matching records
        // 4. Return matching records (up to limit)
    }
}
```

### E2.2: Implement discovery RPC client

Create `crates/aafp-discovery/src/rpc_client.rs`:

```rust
//! Client-side discovery RPC over QUIC.
//!
//! Sends `aafp.discovery.announce` and `aafp.discovery.lookup`
//! RPC requests to peers over AAFP RPC frames.

use aafp_sdk::AgentClient;
use aafp_identity::{AgentId, AgentRecord};
use crate::discovery_v1::*;

pub struct DiscoveryClient;

impl DiscoveryClient {
    /// Announce our AgentRecord to a peer.
    pub async fn announce(
        conn: &mut AgentClient,
        record: &AgentRecord,
    ) -> Result<Vec<AgentRecord>, DiscoveryError> {
        // 1. Encode AgentRecord as CBOR
        // 2. Send RPC_REQUEST with method "aafp.discovery.announce"
        // 3. Receive RPC_RESPONSE
        // 4. Decode response as Vec<AgentRecord> (known peers)
    }

    /// Look up agents by capability name.
    pub async fn lookup(
        conn: &mut AgentClient,
        capability: &str,
    ) -> Result<Vec<AgentRecord>, DiscoveryError> {
        // 1. Encode capability name as CBOR
        // 2. Send RPC_REQUEST with method "aafp.discovery.lookup"
        // 3. Receive RPC_RESPONSE
        // 4. Decode response as Vec<AgentRecord>
    }
}
```

### E2.3: Wire discovery into the SDK

Edit `crates/aafp-sdk/src/` to:
1. Allow registering a `DiscoveryRpcHandler` on an `AgentServer`
2. Route incoming RPC_REQUEST frames with `aafp.discovery.*` methods
   to the handler
3. Provide a convenience method on `AgentClient` for discovery operations

### E2.4: Implement bootstrap node connection

Edit `crates/aafp-discovery/src/bootstrap.rs` to:
1. Connect to configured bootstrap nodes over QUIC
2. Announce our AgentRecord to each bootstrap node
3. Look up agents by our required capabilities
4. Store discovered agents in the local DHT

### E2.5: Write tests

Create `crates/aafp-tests/tests/discovery.rs`:

```rust
#[tokio::test]
async fn test_announce_and_lookup() {
    // 1. Start server agent with discovery handler
    // 2. Server announces itself with capability "test-service"
    // 3. Client connects and looks up "test-service"
    // 4. Client receives server's AgentRecord
    // 5. Verify record matches
}

#[tokio::test]
async fn test_rate_limiting() {
    // 1. Connect client
    // 2. Send 2 announces within 60 seconds
    // 3. Second should be rate-limited (error response)
}

#[tokio::test]
async fn test_bootstrap() {
    // 1. Start server as bootstrap node
    // 2. Client bootstraps from server
    // 3. Client discovers server's capabilities
}
```

### E2.6: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
feat: implement discovery announce/lookup over QUIC (RFC-0004 §3, P1-2)

Adds the network protocol for AAFP discovery:
- DiscoveryRpcHandler: server-side handler for announce/lookup RPC
- DiscoveryClient: client-side RPC for announcing and looking up
- Rate limiting: announce 1/60s, lookup 10/60s per connection
- Bootstrap node connection: connect, announce, lookup
- Wired into SDK: AgentServer routes discovery RPCs to handler

Closes ROADMAP.md P1-2.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### E2.7: Tests pass

```bash
cargo test --test discovery -v
cargo test --workspace
```

### E2.8: Clippy clean

```bash
cargo clippy --workspace -- -D warnings
```

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark E2.1 through E2.8 as `[x]`
- Set E2 status to `COMPLETE`
