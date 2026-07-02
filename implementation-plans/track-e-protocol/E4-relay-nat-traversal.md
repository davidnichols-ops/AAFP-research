# Plan E4: Relay Protocol / NAT Traversal (P1-8)

**Priority:** MEDIUM (P1-8, required before public release)
**Track:** E (Protocol Features)
**Estimated effort:** 10-15 hours
**Blocked by:** E2 (relay needs discovery to find relay nodes)
**Blocks:** nothing

---

## Objective

Implement a basic circuit relay protocol that allows agents behind NAT to
communicate through relay nodes. This implements P1-8 from ROADMAP.md and
requires a new RFC for the relay protocol specification.

**Current state:** `aafp-nat/src/relay.rs` is a stub (202 lines) that tracks
relay assignments in memory but doesn't implement actual relayed connections.
`aafp-nat/src/dcutr.rs` is a stub for Direct Connection Upgrade through Relay.
`aafp-nat/src/auto_nat.rs` is a stub for automatic NAT detection.

**Source:** ROADMAP.md P1-8, RFC-0001 §6.3

---

## Prerequisites

- E2 complete (discovery for finding relay nodes)
- Read `crates/aafp-nat/src/relay.rs` (202 lines — current stub)
- Read `crates/aafp-nat/src/dcutr.rs` (stub)
- Read `crates/aafp-nat/src/auto_nat.rs` (stub)
- Read libp2p circuit relay v2 spec for reference (but adapt to AAFP, don't copy)

---

## Steps

### E4.1: Write RFC 0010 (Circuit Relay Protocol)

Create `RFCs/0010-circuit-relay.md` specifying:

1. **Relay reservation:** An agent behind NAT requests a reservation from
   a relay node. The relay allocates a slot and tracks the reservation.

2. **Relayed connection:** A third agent connects to the relay and requests
   a connection to the NAT'd agent. The relay forwards traffic between them.

3. **Wire format:**
   - Use AAFP RPC frames for reservation requests/responses
   - Use DATA frames on a dedicated stream for relayed traffic
   - Method: `aafp.relay.reserve`, `aafp.relay.connect`, `aafp.relay.close`

4. **Reservation lifecycle:** TTL-based expiration, renewal, cancellation.

5. **Capacity limits:** Max concurrent relayed connections, max bandwidth,
   max duration (configurable per relay node).

6. **DCUtR (Direct Connection Upgrade):** After a relayed connection is
   established, peers attempt a direct connection via simultaneous open
   (hole punching). If successful, the relay is no longer needed.

Keep the RFC concise (300-400 lines). Focus on the wire format and
reservation lifecycle.

### E4.2: Implement relay reservation protocol

Upgrade `crates/aafp-nat/src/relay.rs`:

```rust
//! Circuit relay protocol (RFC 0010).
//!
//! Allows agents behind NAT to communicate through relay nodes.

pub struct RelayService {
    config: RelayConfig,
    /// Active reservations: agent_id → Reservation
    reservations: HashMap<AgentId, Reservation>,
    /// Active relayed connections
    relayed_connections: HashMap<ConnectionId, RelayedConnection>,
}

struct Reservation {
    agent_id: AgentId,
    created: Instant,
    expires: Instant,
    max_duration: Duration,
}

struct RelayedConnection {
    id: ConnectionId,
    source: AgentId,
    target: AgentId,
    created: Instant,
    bytes_forwarded: u64,
}

impl RelayService {
    /// Handle a relay reservation request.
    pub async fn handle_reserve(&mut self, agent_id: AgentId) -> Result<ReservationResponse, RelayError> {
        // 1. Check capacity
        // 2. Create reservation with TTL
        // 3. Return reservation details
    }

    /// Handle a relay connect request (from a third party wanting to reach the NAT'd agent).
    pub async fn handle_connect(&mut self, target: AgentId) -> Result<RelayedStream, RelayError> {
        // 1. Check target has active reservation
        // 2. Create relayed connection
        // 3. Return a stream that forwards data between source and target
    }

    /// Expire old reservations.
    pub fn evict_expired(&mut self) {
        // Remove reservations past their TTL
    }
}
```

### E4.3: Implement relayed data forwarding

The relay needs to forward DATA frames between the source and target agents:

```rust
/// Forward data between two QUIC streams.
async fn forward_data(
    relay: &RelayService,
    source_stream: QuicRecvStream,
    target_stream: QuicSendStream,
) -> Result<u64, RelayError> {
    let mut bytes_forwarded = 0u64;
    let mut buf = vec![0u8; 4096];
    loop {
        let n = source_stream.read(&mut buf).await?;
        if n == 0 { break; }
        target_stream.write_all(&buf[..n]).await?;
        bytes_forwarded += n as u64;
    }
    Ok(bytes_forwarded)
}
```

### E4.4: Implement relay client

Create `crates/aafp-nat/src/relay_client.rs`:

```rust
/// Client for requesting relay reservations and connecting through relays.
pub struct RelayClient;

impl RelayClient {
    /// Request a reservation from a relay node.
    pub async fn reserve(conn: &mut AgentClient, duration: Duration) -> Result<Reservation, RelayError> { ... }

    /// Connect to a target agent through a relay.
    pub async fn connect_through_relay(
        relay: &mut AgentClient,
        target: &AgentId,
    ) -> Result<QuicConnection, RelayError> { ... }
}
```

### E4.5: Implement AutoNAT (automatic NAT detection)

Upgrade `crates/aafp-nat/src/auto_nat.rs`:

```rust
//! Automatic NAT detection.
//!
//! Determines if the local agent is behind NAT by asking peers
//! to report the observed address. If the observed address differs
//! from the local address, NAT is detected.

pub struct AutoNat {
    /// Whether we've determined our NAT status
    status: NatStatus,
    /// Observed addresses reported by peers
    observed_addresses: Vec<Multiaddr>,
}

enum NatStatus {
    Unknown,
    NotBehindNat,
    BehindNat { relay_needed: bool },
}
```

### E4.6: Implement DCUtR (Direct Connection Upgrade)

Upgrade `crates/aafp-nat/src/dcutr.rs`:

```rust
//! Direct Connection Upgrade through Relay (DCUtR).
//!
//! After a relayed connection is established, peers attempt
//! a direct connection via simultaneous open (hole punching).

pub async fn attempt_direct_connection(
    relay: &RelayService,
    target: &AgentId,
    target_observed_addr: &Multiaddr,
) -> Result<QuicConnection, DcutrError> {
    // 1. Both peers initiate a QUIC connection to each other's observed address
    //    simultaneously (hole punching)
    // 2. If either connection succeeds, use it as the direct connection
    // 3. If both fail, continue using the relay
}
```

### E4.7: Write tests

```rust
#[tokio::test]
async fn test_relay_reservation() {
    // 1. Start relay node
    // 2. Agent requests reservation
    // 3. Verify reservation is granted with TTL
}

#[tokio::test]
async fn test_relayed_connection() {
    // 1. Start relay node
    // 2. Agent A (behind NAT) requests reservation
    // 3. Agent B connects to A through relay
    // 4. B sends a message, A receives it
    // 5. A sends a response, B receives it
}

#[tokio::test]
async fn test_reservation_expiry() {
    // 1. Start relay with short TTL
    // 2. Agent requests reservation
    // 3. Wait for TTL to expire
    // 4. Verify reservation is evicted
}
```

### E4.8: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
feat: implement circuit relay protocol (RFC 0010, P1-8)

Adds NAT traversal for agents behind NAT:
- Relay reservation protocol with TTL-based expiration
- Relayed data forwarding over QUIC streams
- AutoNAT: automatic NAT detection via peer-reported addresses
- DCUtR: direct connection upgrade (hole punching) after relay established
- RFC 0010 specifies the wire format and reservation lifecycle

Closes ROADMAP.md P1-8.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Commit RFC in umbrella:
```bash
cd /Users/david/projects/AAFP-research
git add RFCs/0010-circuit-relay.md implementations/rust
git commit -m "feat: circuit relay protocol + NAT traversal (RFC 0010, P1-8)"
```

---

## Verification

### E4.9: Tests pass

```bash
cargo test -p aafp-nat -v
cargo test --workspace
```

### E4.10: Clippy clean

```bash
cargo clippy --workspace -- -D warnings
```

---

## Risks & Mitigations

1. **Hole punching doesn't work in all NAT types:** Symmetric NATs can't be
   punched. **Mitigation:** Fall back to relay if DCUtR fails. Document
   which NAT types are supported.

2. **Relay abuse:** A malicious agent could request many reservations.
   **Mitigation:** Rate limiting, capacity limits, and reservation TTL.

3. **Complexity:** Full relay + DCUtR + AutoNAT is a lot of code.
   **Mitigation:** Implement in phases — relay reservation first, then
   data forwarding, then AutoNAT, then DCUtR. Each phase is independently
   useful.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark E4.1 through E4.10 as `[x]`
- Set E4 status to `COMPLETE`
