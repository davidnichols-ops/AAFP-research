# RFC 0009: Networked PubSub Protocol

**Status:** Experimental
**Version:** 0.1.0
**Date:** 2026-07-02

---

## Abstract

This RFC specifies a networked publish/subscribe protocol for AAFP that
propagates messages between agents over QUIC streams. Version 1 implements
**floodsub** — published messages are forwarded to all known peers subscribed
to the same topic. A gossipsub upgrade (mesh-based propagation) is documented
as future work.

---

## 1. Introduction

RFC-0001 §6.4 specifies an in-memory pubsub for v1. This RFC extends pubsub
to the network layer, allowing agents on different nodes to subscribe to
topics and receive messages published by any peer.

### 1.1 Design Goals

- **Simplicity:** Floodsub is easy to implement and sufficient for small
  networks (<100 peers).
- **Topic-based:** Messages are routed by topic string, not by agent ID.
- **Decoupled:** Publishers don't need to know subscribers.
- **Extensible:** The protocol can be upgraded to gossipsub without breaking
  the wire format.

---

## 2. Wire Format

### 2.1 RPC Methods

PubSub uses AAFP RPC frames (RFC-0002 §4.4) with the following methods:

| Method | Direction | Description |
|--------|-----------|-------------|
| `aafp.pubsub.subscribe` | Client→Server | Subscribe to a topic |
| `aafp.pubsub.unsubscribe` | Client→Server | Unsubscribe from a topic |
| `aafp.pubsub.publish` | Client→Server | Publish a message to a topic |

### 2.2 Subscribe Request

```cbor
{
  1: tstr,   // topic: Topic name
}
```

Response: empty map `{}` on success.

### 2.3 Unsubscribe Request

```cbor
{
  1: tstr,   // topic: Topic name
}
```

Response: empty map `{}` on success.

### 2.4 Publish Request

```cbor
{
  1: tstr,       // topic: Topic name
  2: bstr,       // data: Message payload
  3: uint,       // ttl: Time-to-live (hops remaining, default 3)
  4: [ *tstr ],  // seen: List of AgentIds that have seen this message
}
```

Response: empty map `{}` on success.

---

## 3. Floodsub Protocol (v1)

### 3.1 Subscription Tracking

Each agent maintains a map of `topic → set(peer AgentId)` for remote
subscriptions. When a peer subscribes to a topic, the agent adds the peer
to the topic's subscriber set.

### 3.2 Message Propagation

When an agent publishes a message to a topic:

1. Deliver the message to local subscribers (via broadcast channel).
2. For each remote peer subscribed to the topic:
   a. If the peer is in the `seen` list, skip (already forwarded).
   b. Send the message as an `aafp.pubsub.publish` RPC request.
   c. Decrement the TTL. If TTL reaches 0, don't re-forward.

### 3.3 Message Deduplication

Each message includes a `seen` list of AgentIds that have handled it.
When a peer receives a message:
1. If the peer's own AgentId is in `seen`, drop the message.
2. Add the peer's AgentId to `seen`.
3. Deliver locally and forward to other subscribers.

### 3.4 TTL

The TTL (time-to-live) field limits the hop count to prevent infinite
loops. Default TTL is 3. Each forward decrements TTL by 1. When TTL
reaches 0, the message is delivered locally but not re-forwarded.

---

## 4. Gossipsub (v2, Future Work)

Gossipsub improves on floodsub by:
- Maintaining a **mesh** of connected peers per topic (not all peers).
- **Gossip** messages (IHAVE/IWANT) for metadata exchange.
- **Score-based** peer selection to penalize misbehaving peers.
- Lower bandwidth overhead in large networks.

The wire format in §2 is compatible with gossipsub — the upgrade only
changes the propagation logic, not the frame format.

---

## 5. Security

- PubSub messages are carried over authenticated AAFP connections (RFC-0002).
- The `from` field in `TopicMessage` is verified against the connection's
  peer AgentId.
- Subscriptions are per-connection — when a connection closes, all
  subscriptions from that peer are removed.

---

## 6. IANA Considerations

None. RPC method names are prefixed with `aafp.pubsub.` and are not
registered with IANA.

---

## 7. Normative References

- RFC-0001: AAFP Protocol Overview (§6.4 PubSub)
- RFC-0002: AAFP Transport Framing (§4.4 RPC frames)
- RFC-0004: AAFP Discovery (for finding PubSub peers)
