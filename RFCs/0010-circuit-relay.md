# RFC 0010: Circuit Relay Protocol

**Status:** Experimental
**Version:** 0.1.0
**Date:** 2026-07-02

---

## Abstract

This RFC specifies a circuit relay protocol for AAFP that allows agents
behind NAT to communicate through relay nodes. Agents behind NAT request
reservations from relay nodes; third-party agents connect to the relay
and request relayed connections to the NAT'd agent.

---

## 1. Introduction

Agents behind NAT cannot accept incoming QUIC connections. The circuit
relay protocol solves this by having a relay node forward traffic between
two agents. The relay acts as a intermediary: the NAT'd agent maintains
a reservation with the relay, and other agents connect through the relay
to reach the NAT'd agent.

### 1.1 Design Goals

- **Simple reservation model:** Agents request time-limited reservations.
- **Capacity limits:** Relays enforce max concurrent connections and duration.
- **TTL-based expiration:** Reservations expire automatically.
- **DCUtR upgrade:** After relayed connection, peers attempt direct connection.

---

## 2. Wire Format

### 2.1 RPC Methods

Relay uses AAFP RPC frames (RFC-0002 §4.4) with the following methods:

| Method | Direction | Description |
|--------|-----------|-------------|
| `aafp.relay.reserve` | Agent→Relay | Request a relay reservation |
| `aafp.relay.renew` | Agent→Relay | Renew an existing reservation |
| `aafp.relay.cancel` | Agent→Relay | Cancel a reservation |
| `aafp.relay.connect` | Agent→Relay | Request a relayed connection to a target |

### 2.2 Reserve Request

```cbor
{
  1: uint,  // duration_secs: Requested reservation duration
}
```

### 2.3 Reserve Response

```cbor
{
  1: uint,      // reservation_id: Unique reservation ID
  2: uint,      // expires_at: Unix timestamp when reservation expires
  3: tstr,      // relay_addr: Relay's multiaddr for relayed connections
}
```

### 2.4 Renew Request

```cbor
{
  1: uint,  // reservation_id: ID of reservation to renew
  2: uint,  // duration_secs: New duration
}
```

### 2.5 Cancel Request

```cbor
{
  1: uint,  // reservation_id: ID of reservation to cancel
}
```

### 2.6 Connect Request

```cbor
{
  1: bstr,  // target: AgentId of the target agent (32 bytes)
}
```

### 2.7 Connect Response

```cbor
{
  1: uint,  // connection_id: Unique relayed connection ID
}
```

---

## 3. Reservation Lifecycle

### 3.1 Reservation Creation

1. Agent sends `aafp.relay.reserve` with desired duration.
2. Relay checks capacity (max concurrent reservations).
3. Relay creates a reservation with a unique ID and TTL.
4. Relay returns reservation ID and expiry timestamp.

### 3.2 Reservation Renewal

1. Agent sends `aafp.relay.renew` before the reservation expires.
2. Relay extends the reservation's TTL.
3. Relay returns new expiry timestamp.

### 3.3 Reservation Cancellation

1. Agent sends `aafp.relay.cancel` with the reservation ID.
2. Relay removes the reservation.

### 3.4 Reservation Expiration

Reservations are evicted when their TTL expires. The relay periodically
runs eviction to clean up expired reservations.

---

## 4. Relayed Connections

### 4.1 Connection Establishment

1. Agent B sends `aafp.relay.connect` with target AgentId A.
2. Relay checks that A has an active reservation.
3. Relay creates a relayed connection with a unique ID.
4. Relay returns the connection ID to B.
5. B and A exchange DATA frames through the relay on dedicated streams.

### 4.2 Data Forwarding

The relay forwards DATA frames between the source and target agents:
- B sends DATA frames on a stream to the relay.
- The relay forwards the DATA to A on a separate stream.
- A responds with DATA frames back through the relay to B.

### 4.3 Connection Close

Either agent can close the relayed connection by closing the QUIC stream.
The relay detects the stream close and cleans up the connection.

---

## 5. Capacity Limits

Relay nodes enforce configurable limits:
- **Max concurrent reservations:** Default 100.
- **Max reservation duration:** Default 3600 seconds (1 hour).
- **Max concurrent relayed connections:** Default 50.
- **Max bandwidth per connection:** Configurable (0 = unlimited).

---

## 6. AutoNAT

AutoNAT detects if the local agent is behind NAT:
1. Agent asks peers to report the observed address.
2. If observed address differs from local address, NAT is detected.
3. If behind NAT, the agent requests a relay reservation.

---

## 7. DCUtR (Direct Connection Upgrade)

After a relayed connection is established, peers attempt a direct
connection via simultaneous open (hole punching):
1. Both peers exchange observed addresses through the relay.
2. Both peers initiate QUIC connections to each other simultaneously.
3. If either connection succeeds, it replaces the relayed connection.
4. If both fail, the relayed connection continues.

DCUtR works for cone NAT types but not symmetric NAT.

---

## 8. Security

- Relay reservations require an authenticated AAFP connection.
- Only the agent that created a reservation can renew or cancel it.
- Relayed connections inherit the AAFP security stack (TLS, identity).
- The relay cannot read relayed traffic (end-to-end encrypted via QUIC TLS).

---

## 9. Normative References

- RFC-0001: AAFP Protocol Overview (§6.3 NAT traversal)
- RFC-0002: AAFP Transport Framing (§4.4 RPC frames)
- RFC-0004: AAFP Discovery (for finding relay nodes)
