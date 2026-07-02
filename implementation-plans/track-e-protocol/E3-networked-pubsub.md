# Plan E3: Networked PubSub (Gossipsub Over QUIC)

**Priority:** MEDIUM (long-term extension, not a P1 item)
**Track:** E (Protocol Features)
**Estimated effort:** 10-15 hours
**Blocked by:** E2 (PubSub needs discovery to find peers)
**Blocks:** nothing

---

## Objective

Upgrade the in-memory PubSub (`aafp-messaging/src/pubsub.rs`) to a
networked PubSub that propagates messages between agents over QUIC.
Start with a simpler floodsub protocol, then upgrade to gossipsub if
time permits.

**Current state:** `PubSub` struct in `pubsub.rs` is local-only (186 lines).
It uses `tokio::sync::broadcast` channels for local pub/sub. No network
propagation.

**Source:** ROADMAP.md long-term extension #3, RFC-0001 §6.4

---

## RFC Context

RFC-0001 §6.4: "v1 includes an in-memory pubsub implementation. A gossipsub
protocol for distributed pubsub is deferred to a future RFC."

**This plan implements the future RFC.** You should write a brief RFC
amendment or new RFC (0009) specifying the networked PubSub protocol before
implementing.

---

## Prerequisites

- E2 complete (discovery for finding PubSub peers)
- Read `crates/aafp-messaging/src/pubsub.rs` (186 lines — current local impl)
- Read `RFCs/0001-protocol-overview.md` §6.4

---

## Steps

### E3.1: Write RFC 0009 (PubSub Protocol)

Create `RFCs/0009-pubsub.md` specifying:

1. **Topic subscription:** SUBSCRIBE/UNSUBSCRIBE control messages
2. **Message propagation:** PUBLISH messages forwarded to peers subscribed
   to the same topic
3. **Frame types:** Use DATA frames with a PubSub header extension, or
   define new RPC methods (`aafp.pubsub.subscribe`, `aafp.pubsub.publish`)
4. **Floodsub (v1):** Forward published messages to ALL known peers
   subscribed to the topic. Simple but sufficient for small networks.
5. **Gossipsub (v2, future):** Mesh-based propagation with gossip.
   Document as future work.

Keep the RFC concise (200-300 lines). Focus on the wire format and
semantics. Don't over-engineer.

### E3.2: Implement networked PubSub

Upgrade `crates/aafp-messaging/src/pubsub.rs`:

```rust
//! Networked PubSub: topic-based publish/subscribe over AAFP.
//!
//! v1 implements floodsub: published messages are forwarded to all
//! known peers subscribed to the same topic. A gossipsub upgrade is
//! planned for the future (RFC 0009 §6).

use std::collections::{HashMap, HashSet};
use aafp_identity::AgentId;
use tokio::sync::{broadcast, Mutex};

/// Networked PubSub system.
pub struct NetworkedPubSub {
    /// Local subscriptions: topic → broadcast sender
    local: HashMap<Topic, broadcast::Sender<TopicMessage>>,
    /// Remote peer subscriptions: topic → set of peer AgentIds
    remote: HashMap<Topic, HashSet<AgentId>>,
    /// Our agent ID
    our_id: AgentId,
    /// Buffer size for local channels
    buffer_size: usize,
}

impl NetworkedPubSub {
    /// Subscribe to a topic locally.
    pub fn subscribe(&mut self, topic: &str) -> broadcast::Receiver<TopicMessage> { ... }

    /// Unsubscribe from a topic.
    pub fn unsubscribe(&mut self, topic: &str) { ... }

    /// Publish a message locally and to all remote subscribers.
    pub async fn publish(&self, topic: &str, data: Vec<u8>) -> Result<(), PubSubError> {
        // 1. Publish to local subscribers
        // 2. For each remote peer subscribed to this topic:
        //    - Send the message as a DATA frame on a QUIC stream
        //    - Include topic name in the frame extension or payload header
    }

    /// Handle a received PubSub message from a remote peer.
    pub async fn handle_remote_message(&self, msg: TopicMessage) -> Result<(), PubSubError> {
        // 1. Publish to local subscribers
        // 2. Optionally re-forward to other peers (floodsub)
    }

    /// Register a remote peer's subscription.
    pub fn add_remote_subscriber(&mut self, topic: &str, peer: AgentId) { ... }

    /// Remove a remote peer's subscription.
    pub fn remove_remote_subscriber(&mut self, topic: &str, peer: &AgentId) { ... }
}
```

### E3.3: Wire PubSub into the SDK

Edit `crates/aafp-sdk/src/` to:
1. Hold a `NetworkedPubSub` instance in `PeerConnection` or `Agent`
2. Route incoming PubSub messages to `handle_remote_message`
3. Provide `publish`/`subscribe` methods on `AgentClient`

### E3.4: Write tests

```rust
#[tokio::test]
async fn test_networked_pubsub() {
    // 1. Start two agents (server + client)
    // 2. Both subscribe to "test-topic"
    // 3. Client publishes a message
    // 4. Server receives it via QUIC
    // 5. Verify message content matches
}

#[tokio::test]
async fn test_multi_peer_propagation() {
    // 1. Start three agents (A, B, C)
    // 2. All subscribe to "test-topic"
    // 3. A publishes a message
    // 4. B and C both receive it (floodsub)
}
```

### E3.5: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
feat: implement networked PubSub (floodsub over QUIC, RFC 0009)

Upgrades the in-memory PubSub to a networked floodsub:
- Messages published to a topic are forwarded to all known peers
  subscribed to that topic
- SUBSCRIBE/UNSUBSCRIBE tracked per peer
- Uses AAFP DATA frames for message propagation
- RFC 0009 specifies the wire format and semantics
- Gossipsub (mesh-based) documented as future work

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Also commit the RFC in the umbrella:
```bash
cd /Users/david/projects/AAFP-research
git add RFCs/0009-pubsub.md implementations/rust
git commit -m "feat: networked PubSub (floodsub, RFC 0009)"
```

---

## Verification

### E3.6: Tests pass

```bash
cargo test -p aafp-messaging pubsub -v
cargo test --workspace
```

### E3.7: Clippy clean

```bash
cargo clippy --workspace -- -D warnings
```

---

## Risks & Mitigations

1. **Gossipsub is complex:** The full gossipsub protocol (mesh maintenance,
   gossip, IWANT/IHAVE, score-based peer selection) is very complex.
   **Mitigation:** Start with floodsub (simple forwarding). Document
   gossipsub as future work. Floodsub is sufficient for small networks
   (<100 peers).

2. **Message loops:** In floodsub, a message could loop forever if peers
   re-forward it. **Mitigation:** Add a "seen" cache (message ID →
   timestamp) and drop messages that have been seen recently. TTL-based
   eviction.

3. **No backpressure:** If a peer is slow, messages queue up. **Mitigation:**
   Use bounded channels and drop messages if the queue is full (with a
   warning log).

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark E3.1 through E3.7 as `[x]`
- Set E3 status to `COMPLETE`
