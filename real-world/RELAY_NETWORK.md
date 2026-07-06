# AAFP Relay Network Architecture

**Document type:** Real-world deployment architecture
**Scope:** Relay agent design, discovery, federation, pricing, trust, resistance, capacity, Rust implementation, browser transports, health monitoring, and a concrete 10-relay / 5-region deployment
**Reference implementation:** `implementations/rust/crates/aafp-nat/`
**Normative spec:** `RFCs/0010-circuit-relay.md`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Relay Agent Design](#2-relay-agent-design)
3. [Relay Discovery](#3-relay-discovery)
4. [Relay Federation](#4-relay-federation)
5. [Relay Pricing Model](#5-relay-pricing-model)
6. [Relay Trust Model](#6-relay-trust-model)
7. [Relay Resistance](#7-relay-resistance)
8. [Relay Capacity Planning](#8-relay-capacity-planning)
9. [Relay Implementation in Rust](#9-relay-implementation-in-rust)
10. [WebSocket Relay for Browser Agents](#10-websocket-relay-for-browser-agents)
11. [WebTransport Relay for Browser Agents](#11-webtransport-relay-for-browser-agents)
12. [Relay Health Monitoring and Failover](#12-relay-health-monitoring-and-failover)
13. [Concrete Deployment: 10 Relays, 5 Regions](#13-concrete-deployment-10-relays-5-regions)
14. [Open Questions and Future Work](#14-open-questions-and-future-work)

---

## 1. Executive Summary

A large fraction of AAFP agents run behind NAT or restrictive firewalls and
cannot accept inbound QUIC connections. The AAFP relay network solves this by
providing a fleet of publicly reachable relay nodes that forward frames
between two NAT'd agents. Relays are **dumb pipes**: they forward bytes
verbatim and cannot read application payloads because all relayed traffic is
end-to-end encrypted by the AAFP session layer (QUIC TLS + the v1 handshake
key schedule).

This document describes the full relay network architecture, grounded in the
existing `aafp-nat` crate (`relay.rs`, `relay_v1.rs`, `relay_forwarding.rs`,
`relay_discovery.rs`, `auto_nat.rs`, `dcutr.rs`, `dcutr_v1.rs`). It covers
discovery, federation between relays, a two-tier pricing model (free
community + paid premium), the trust and traffic-analysis resistance model,
capacity planning, the Rust implementation path, browser-facing transports
(WebSocket and WebTransport), health monitoring and failover, and a concrete
deployment of 10 relays across 5 regions serving 50K concurrent connections
each (500K total).

**Key design principles:**

- Relays never inspect, decrypt, or rewrite application payloads.
- Relays are replaceable and federated; no single relay is a trust anchor.
- Discovery is multi-sourced (DHT, DNS, bootstrap) so no single channel is a
  single point of failure.
- Free community relays and paid premium relays coexist on the same protocol;
  pricing is an operational concern, not a protocol concern.
- Browser agents use WebSocket or WebTransport gateways that bridge to QUIC
  on the relay side.

---

## 2. Relay Agent Design

### 2.1 Role

A relay is a special AAFP agent that (a) has a publicly reachable QUIC
listener and (b) advertises the `relay` capability (see
`relay_discovery.rs:17`, `RELAY_CAPABILITY`). Its sole job is to forward
bytes between two agents that cannot connect directly:

```
   Caller A (NAT'd)              Relay                 Target B (NAT'd)
        │                          │                          │
        │── QUIC conn ────────────▶│                          │
        │                          │◀────────── QUIC conn ────│
        │── reserve RPC ──────────▶│                          │
        │                          │                          │
        │── connect RPC (target B)▶│                          │
        │                          │── open bi-stream to B ──▶│
        │                          │   [0xFE + conn_id]       │
        │── data bi-stream ───────▶│                          │
        │   [0xFF + conn_id]       │                          │
        │                          │── forward bytes ────────▶│
        │                          │◀── forward bytes ────────│
        │◀── forward bytes ────────│                          │
```

The relay is a **byte pipe**. After the `connect` RPC succeeds and returns a
`connection_id`, the caller opens a new bidirectional QUIC stream and writes
the 9-byte data-stream header `[0xFF magic][8-byte connection_id]` (see
`relay_forwarding.rs:44-50`). The relay looks up the pending target stream,
then copies bytes verbatim in both directions via `forward_data()`
(`relay_forwarding.rs:454`). On the target side, the relay opens a bi-stream
and writes `[0xFE magic][8-byte connection_id]` so the target can identify
the incoming relayed connection.

### 2.2 No Payload Inspection

The relay forwards raw QUIC stream bytes. It does not:

- Parse AAFP frames inside the relayed stream.
- Decrypt or re-encrypt TLS records.
- Validate message types or capabilities.
- Modify sequence numbers, nonces, or any header fields.

This is enforced structurally: `forward_data()` (`relay_forwarding.rs:454`)
reads into a plain `Vec<u8>` buffer and writes the same bytes to the other
side. There is no code path that decodes frames on the forwarding path. The
only bytes the relay interprets are the 9-byte data-stream header used to
demultiplex to the correct pending connection.

### 2.3 Reservation Lifecycle

Before a target can be reached through a relay, the target must hold an
active **reservation** with that relay (RFC 0010 §3, `relay_v1.rs:74-97`).
The lifecycle is:

1. **Reserve** (`aafp.relay.reserve`): target requests a time-limited
   reservation. Relay checks capacity (`max_reservations`, default 100) and
   duration (`max_duration_secs`, default 3600s), creates a `Reservation`
   with a unique ID and TTL, and returns `{reservation_id, expires_at,
   relay_addr}` (`relay_v1.rs:411-459`).
2. **Renew** (`aafp.relay.renew`): target extends the TTL before expiry.
   Ownership is verified (`relay_v1.rs:462-493`).
3. **Cancel** (`aafp.relay.cancel`): target explicitly releases the
   reservation (`relay_v1.rs:496-516`).
4. **Expire**: the relay periodically evicts expired reservations via
   `evict_expired()` (`relay_v1.rs:562-576`).

A relayed **connection** (`aafp.relay.connect`, `relay_v1.rs:519-560`) is
created when a caller requests to reach a target. The relay verifies the
target has a non-expired reservation, checks connection capacity
(`max_connections`, default 50), and returns a `connection_id`.

### 2.4 DCuTR Upgrade

Relayed connections are a fallback, not a permanent state. After a relayed
connection is established, both peers attempt a **direct connection upgrade**
(DCuTR, RFC 0010 §7, `dcutr_v1.rs`). Peers exchange `CoordinateMessage`
(`{observed_addr, my_addr}`) over the relayed stream, then simultaneously
dial each other (hole punching). If either side succeeds, the direct QUIC
connection replaces the relayed stream and the relay stops forwarding. DCuTR
works for cone NAT types but not symmetric NAT (`dcutr_v1.rs:36-47`).

This means a well-provisioned relay network is self-lightening: successful
hole punches remove load from relays, leaving relays to carry only the
connections that truly cannot be upgraded.

---

## 3. Relay Discovery

Agents that need a relay discover relay nodes through three complementary
channels, implemented in `relay_discovery.rs`. No single channel is a single
point of failure.

### 3.1 DHT Capability Lookup (primary)

The AAFP capability DHT (RFC 0004, `aafp-discovery` crate) maps capabilities
to agent records. Relays advertise the `"relay"` capability
(`RELAY_CAPABILITY`, `relay_discovery.rs:17`). An agent needing a relay
performs a DHT lookup for the `relay` capability and receives a set of
`AgentRecord`s, each containing the relay's `AgentId`, multiaddrs, and
capability metadata.

```
   Agent (NAT'd)                 DHT                    Relay
        │                         │                        │
        │── get_providers("relay")▶                        │
        │◀── AgentRecord[] ───────│                        │
        │                         │                        │
        │── QUIC dial relay ──────────────────────────────▶│
        │── health check (latency probe) ──────────────────▶│
        │── reserve ───────────────────────────────────────▶│
```

The DHT is decentralized (Kademlia-style, 256 k-buckets, α=3 concurrency,
k=5 replication) and has no central directory to compromise or take down.

### 3.2 Bootstrap Relays (fallback)

At startup, before the DHT is populated, agents use a configured list of
**bootstrap relay addresses** (`RelayDiscovery::bootstrap_relays`,
`relay_discovery.rs:181`). These are well-known, hard-coded or
config-file-provided addresses (e.g., `quic://relay-us-east.aafp.net:4433`)
that are guaranteed to be online. Bootstrap relays serve two purposes:

1. They provide an initial relay before DHT discovery completes.
2. They can provide DHT bootstrap peers, bootstrapping the DHT itself.

### 3.3 DNS Well-Known Endpoints (tertiary)

For environments where the DHT is unreachable (e.g., a fresh agent behind a
restrictive firewall that blocks DHT UDP traffic but allows DNS), agents can
resolve DNS records to find relays:

- **SRV records:** `_aafp-relay._udp.example.com SRV 10 10 4433
  relay-us-east.aafp.net` — standard DNS service discovery.
- **TXT records:** `aafp-relay=quic://relay-eu-west.aafp.net:4433` — a
  simple key-value advertisement.
- **A/AAAA + well-known path:** Resolve `relay.aafp.net` to an IP, then
  fetch `https://relay.aafp.net/.well-known/aafp-relays` for a JSON/CBOR
  list of relay endpoints.

DNS discovery is cached and validated with a health check before use.

### 3.4 Relay Selection

Once a set of candidate relays is gathered, the `RelayDiscovery` cache
(`relay_discovery.rs:175-376`) selects the best relay using this priority
(`select_best_relay()`, `relay_discovery.rs:271-288`):

1. **Healthy** — last health check succeeded
   (`is_healthy()`, `relay_discovery.rs:65`).
2. **Has capacity** — `current_connections < max_connections`
   (`has_capacity()`, `relay_discovery.rs:70`).
3. **Lowest latency** — measured RTT from health check
   (`latency_ms`).
4. **Lowest utilization** — `current / max` ratio
   (`utilization()`, `relay_discovery.rs:78`).

The cache is bounded (`max_relays`, default 5) and evicts the worst relay
(highest latency or unhealthiest) when full (`evict_worst()`,
`relay_discovery.rs:310-335`). Health checks are refreshed on a configurable
interval (default 300s, `DEFAULT_REFRESH_INTERVAL_SECS`).

```
┌─────────────────────────────────────────────────────────────┐
│                   Relay Discovery Flow                       │
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                 │
│  │   DHT    │   │ Bootstrap│   │   DNS    │                 │
│  │ lookup   │   │  list    │   │ SRV/TXT  │                 │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘                 │
│       │              │              │                        │
│       └──────────────┴──────────────┘                        │
│                      ▼                                       │
│            ┌───────────────────┐                             │
│            │  RelayDiscovery   │  (bounded cache, ≤5)        │
│            │  cache            │                             │
│            └────────┬──────────┘                             │
│                     ▼                                        │
│            ┌───────────────────┐                             │
│            │ Health check +    │  (QUIC dial, measure RTT)   │
│            │ latency probe     │                             │
│            └────────┬──────────┘                             │
│                     ▼                                        │
│            ┌───────────────────┐                             │
│            │ select_best_relay │  healthy → capacity →       │
│            │                   │  latency → utilization      │
│            └───────────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Relay Federation

### 4.1 Motivation

A single relay can only forward traffic between agents that both have
reservations on *that same relay*. If agent A is relayed through relay R1
and agent B is relayed through relay R2, a caller wanting to reach B must
connect to R2 — it cannot reach B through R1. This creates an
O(relays²) coordination problem as the network grows.

Relay federation solves this by allowing relays to peer with each other and
forward traffic across relay boundaries.

### 4.2 Federation Topology

```
   Region: US-East          Region: EU-West          Region: AP-South
   ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
   │   Relay US-1  │◀──────▶│   Relay EU-1  │◀──────▶│   Relay AP-1  │
   │   Relay US-2  │        │   Relay EU-2  │        │   Relay AP-2  │
   └───────┬───────┘        └───────┬───────┘        └───────┬───────┘
           │                        │                        │
      ┌────┴────┐              ┌────┴────┐              ┌────┴────┐
      │ Agents  │              │ Agents  │              │ Agents  │
      │ (NAT'd) │              │ (NAT'd) │              │ (NAT'd) │
      └─────────┘              └─────────┘              └─────────┘
```

Federation uses a **full mesh among regional hubs** with **partial mesh
within regions**. Each relay maintains peer links to 2-4 other relays
(typically the other relay in its region plus the hubs in adjacent regions).
This keeps the diameter low (max 2 relay hops between any two agents) while
bounding per-relay federation state.

### 4.3 Federation Protocol

Federation extends the circuit relay protocol with a relay-to-relay
forwarding mode. When relay R1 receives a `connect` RPC for a target that
has no reservation on R1, R1 can:

1. **DHT lookup** the target's relay (the target's `AgentRecord` includes
   its relay's `AgentId` and multiaddr).
2. **Establish a federation link** to R2 (a persistent QUIC connection,
   reused across multiple relayed connections).
3. **Forward the connection** through R2: R1 opens a data stream to R2 with
   a federation header `[0xFD magic][8-byte federation_id][32-byte
   target_agent_id]`, and R2 treats it as a local `connect` to the target.

```
  Caller A ──QUIC──▶ R1 ──fed link──▶ R2 ──QUIC──▶ Target B
   (NAT'd)          (US-1)          (EU-1)          (NAT'd)
```

The federation link is a normal QUIC connection between two relays. R2
authenticates R1 via AAFP identity (UCAN capability chain, RFC 0011) and
verifies R1 is a peer relay before accepting federation traffic. Federation
links are rate-limited and capacity-accounted separately from agent
connections so that a misbehaving peer relay cannot exhaust an agent-facing
connection pool.

### 4.4 Federation Routing

Routing across relays uses a simple **relay distance vector**: each relay
advertises the set of agents it has active reservations for (or, for
privacy, a Bloom filter of those agent IDs). A relay receiving a `connect`
for a target checks:

1. Does the target have a reservation on me? → forward directly.
2. Does a peer relay advertise the target? → forward via federation link.
3. Otherwise → DHT lookup the target's relay, then forward.

To avoid routing loops, each federation frame carries a TTL (default 2,
max 3) and a visited-relay list. A relay drops a federation frame if it
appears in the visited list or the TTL reaches zero.

---

## 5. Relay Pricing Model

### 5.1 Two-Tier Model

The relay network supports two tiers that coexist on the same protocol:

| Tier | Operator | Capacity | SLA | Cost | Discovery |
|------|----------|----------|-----|------|-----------|
| **Community** | Volunteers, non-profits | Low (hundreds of connections) | Best-effort | Free | DHT, open bootstrap |
| **Premium** | AAFP Foundation, paid operators | High (50K+ connections) | 99.9% uptime | Paid (subscription or metered) | DNS, authenticated bootstrap |

Pricing is an **operational and economic concern, not a protocol concern**.
Both tiers use identical relay RPC (`aafp.relay.reserve/connect/...`). The
protocol distinguishes tiers only through capability metadata in the
`AgentRecord` (e.g., `tier: "premium"`, `max_connections: 50000`,
`sla_uptime: 99.9`).

### 5.2 Community Relays

Community relays are run by volunteers — similar to Tor relays or IPFS
bootstrap nodes. They are:

- **Free** to use by any authenticated AAFP agent.
- **Best-effort**: no uptime guarantee, may rate-limit or cap bandwidth.
- **Self-selected**: an agent opts in by setting `is_relay: true` in its
  `RelayConfig` (`relay.rs:40-47`) and advertising the `relay` capability.
- **Discoverable** via DHT and open bootstrap lists.

Community relays are essential for bootstrapping the network and for users
who cannot or will not pay. They are the default tier for new agents.

### 5.3 Premium Relays

Premium relays are operated by the AAFP Foundation or certified partners.
They provide:

- **High capacity**: 50K+ concurrent connections, Gbps aggregate bandwidth.
- **Geographic distribution**: deployed in 5+ regions for low latency.
- **SLA**: 99.9% uptime, sub-50ms intra-region forwarding latency.
- **Authentication**: premium relays present a CA-signed certificate (RFC
  0011 trust model) and are discoverable via authenticated DNS endpoints.

Premium relay access is gated by a **relay token**: a UCAN capability
(`capability: "relay.premium"`, `audience: <relay_agent_id>`) issued by the
operator to a paying agent. The relay validates the UCAN chain during the
`reserve` RPC. Agents without a valid token are rejected or downgraded to a
best-effort queue.

### 5.4 Metered Billing (optional)

For metered pricing, the relay records per-connection byte counts
(`RelayedConnection.bytes_forwarded`, `relay_v1.rs:111`) and periodically
reports them to a billing service. The relay cannot see *what* it forwarded
(encrypted), only *how much*. Billing records are signed by the relay and
verifiable by the agent, preventing disputes.

```
┌──────────────────────────────────────────────────────────────┐
│                  Pricing Decision Tree                        │
│                                                              │
│  Agent needs relay                                           │
│       │                                                      │
│       ├── Has premium token? ── Yes ──▶ Premium relay        │
│       │                                  (SLA, low latency)  │
│       │                                                      │
│       └── No ─────────────────────────▶ Community relay      │
│                                          (free, best-effort) │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. Relay Trust Model

### 6.1 Relays Cannot Read Content

All relayed traffic is end-to-end encrypted by the AAFP session layer. The
v1 handshake (`aafp-crypto`) establishes shared keys between the caller and
target directly — the relay is not a party to the handshake and never
receives session keys. QUIC's TLS 1.3 (with PQ hybrid via rustls) encrypts
both the control RPC streams and the data forwarding streams
end-to-end between agent and relay, but the *application-layer* AAFP frame
encryption (AEAD with the handshake-derived keys) is between the two agents
only.

Concretely, the relay sees:

- QUIC stream bytes (TLS-encrypted between relay and each agent).
- The 9-byte data-stream header (magic + connection_id).

The relay does **not** see:

- AAFP frame payloads (encrypted with caller↔target session keys).
- Message types, capability invocations, or RPC contents (inside the
  encrypted AAFP frames).
- The handshake key material (handshake is end-to-end between agents).

Even if a relay is fully compromised, it cannot decrypt past or future
relayed traffic — it can only drop, reorder, or inject bytes, which the
AAFP frame layer detects via sequence numbers and AEAD authentication.

### 6.2 What Relays Can Observe (Metadata)

While relays cannot read content, they **can** observe metadata:

- **Source and target AgentIds**: the `connect` RPC includes the target
  `AgentId` (`relay_v1.rs:286-290`), and the caller is authenticated via the
  QUIC TLS identity.
- **Connection timing**: when a connection starts, how long it lasts, when
  it ends.
- **Traffic volume**: bytes forwarded per connection
  (`RelayedConnection.bytes_forwarded`).
- **Traffic patterns**: packet sizes, inter-packet timing, directionality
  (which side sends more).
- **Network addresses**: the IP addresses of both agents (visible at the
  QUIC layer).

This metadata leakage is inherent to any relay design. Mitigations are
covered in §7.

### 6.3 Relay Authentication

Relays authenticate agents via the QUIC TLS identity (PQ hybrid, ML-DSA-65
certificates per RFC 0003). The `extract_caller_id()` function
(`relay_forwarding.rs:523-534`) currently uses a placeholder (extracting
caller_id from RPC params for testing); in production it extracts the
`AgentId` from the TLS certificate chain. This means:

- Agents cannot spoof another agent's identity to a relay.
- Reservations are bound to the authenticated caller (`RelayV1Service`
  verifies ownership on renew/cancel, `relay_v1.rs:479, 508`).
- A relay cannot impersonate an agent to another relay (federation links
  are mutually authenticated).

### 6.4 Trust Hierarchy

```
  ┌─────────────────────────────────────────────────────────┐
  │  Trust Level  │  Who                │  What they can do  │
  ├───────────────┼─────────────────────┼────────────────────┤
  │  Highest      │  Caller + Target    │  Read/write content│
  │               │  (end-to-end keys)  │  (full access)     │
  ├───────────────┼─────────────────────┼────────────────────┤
  │  Medium       │  Relay              │  Forward bytes,    │
  │               │                     │  observe metadata  │
  ├───────────────┼─────────────────────┼────────────────────┤
  │  Lowest       │  Federation peer    │  Forward bytes     │
  │               │  relay              │  across relay hop  │
  └─────────────────────────────────────────────────────────┘
```

No party below "Caller + Target" can read content. This is the core trust
guarantee of the relay network.

---

## 7. Relay Resistance

### 7.1 Threat Model

The relay network faces three classes of adversary:

1. **Honest-but-curious relay**: follows the protocol but records metadata
   for later analysis.
2. **Malicious relay**: actively drops, reorders, injects, or delays
   traffic; may collude with other relays or network observers.
3. **Global passive adversary**: observes all network traffic (e.g., an
   ISP or nation-state) but does not control any relay.

### 7.2 Traffic Analysis Resistance

A relay observing traffic can attempt to correlate "who is talking to whom"
and infer communication patterns. Mitigations:

- **End-to-end encryption**: the relay cannot read content, only metadata
  (§6.2). This is the baseline; it does not hide metadata.
- **Multiple relays per agent**: an agent can hold reservations on multiple
  relays simultaneously and distribute connections across them, so no single
  relay sees the agent's full communication graph.
- **Relay rotation**: agents periodically rotate to a new relay (every N
  connections or every T minutes), breaking long-term correlation.
- **Federation indirection**: a connection that traverses two relays (via
  federation, §4) means neither relay alone sees both endpoints' network
  addresses.

### 7.3 Timing Attack Resistance

A relay or observer can use packet timing to fingerprint applications or
link two connections (timing correlation). Mitigations:

- **QUIC stream multiplexing**: multiple relayed connections share a single
  QUIC connection to the relay, so an observer sees interleaved streams and
  cannot easily attribute timing to a specific relayed connection.
- **Optional padding**: the AAFP frame layer can add variable-length padding
  to frames, obscuring payload sizes. (This is a frame-layer feature, not a
  relay feature, but it benefits relayed traffic.)
- **Batched forwarding**: the relay can batch small writes before
  forwarding, introducing a small, randomized delay (e.g., 1-5ms) that
  blurs timing fingerprints. This is an optional relay policy, off by
  default to minimize latency.
- **DCuTR upgrade**: once a direct connection is established, the relay no
  longer sees timing data for that connection.

### 7.4 Connection Correlation Resistance

A global passive adversary observing both the caller→relay and
relay→target legs can correlate them by timing and volume. Mitigations:

- **Federation hops**: introducing a second relay breaks the single-observer
  correlation (the adversary must observe both relay links).
- **Traffic shaping**: the relay can normalize throughput to a fixed rate,
  making volume-based correlation harder (at the cost of latency/bandwidth).
- **Multiple concurrent connections**: an agent with many concurrent
  relayed connections makes per-connection correlation noisier.

### 7.5 Active Attack Resistance

- **Dropping/injecting bytes**: detected by the AAFP frame layer's AEAD
  authentication and sequence numbers. Injected bytes fail AEAD
  verification; dropped bytes create sequence gaps that the receiver
  detects.
- **Replay**: the `ReplayCache` (`aafp-crypto::replay_cache`, RFC 0002 §6.7)
  detects nonce reuse across connections. A relay replaying captured
  encrypted bytes will fail the replay check.
- **Reservation DoS**: a relay can refuse reservations (`AtCapacity`,
  `relay_v1.rs:43`) or drop reservations silently. Agents detect this via
  health checks and failover to another relay (§12). Capacity limits
  (`max_reservations`, `max_connections`) prevent a single caller from
  exhausting the relay.

### 7.6 Resistance Summary

| Attack | Adversary | Mitigation | Residual risk |
|--------|-----------|------------|---------------|
| Content decryption | Curious relay | E2E encryption | None (relay has no keys) |
| Metadata: who→who | Curious relay | Multi-relay, rotation | Relay sees per-connection pair |
| Timing fingerprint | Relay / observer | QUIC muxing, padding, batching | Advanced analysis still possible |
| Connection correlation | Global observer | Federation hops, shaping | Requires observing all links |
| Byte injection | Malicious relay | AEAD authentication | None (detected) |
| Replay | Malicious relay | ReplayCache | None (detected) |
| Reservation DoS | Malicious relay | Health check + failover | Temporary outage on that relay |

---

## 8. Relay Capacity Planning

### 8.1 Resource Model

A relay consumes resources proportional to the number of concurrent
relayed connections and their aggregate bandwidth. Per connection, a relay
holds:

- 1 QUIC connection to the caller (shared across multiple connections from
  the same caller).
- 1 QUIC connection to the target (shared across multiple connections to
  the same target).
- 2 bidirectional QUIC streams per relayed connection (one caller-side, one
  target-side).
- 2 tokio tasks for bidirectional forwarding (`forward_data()`,
  `relay_forwarding.rs:464-497`).
- A `PendingConnection` entry until the data stream is opened
  (`relay_forwarding.rs:54-59`).
- A `RelayedConnection` entry for bookkeeping (`relay_v1.rs:99-112`).

### 8.2 Concurrent Connections

The default `max_connections` is 50 (`relay_v1.rs:38`), suitable for a
community relay. A premium relay targets 50,000 concurrent connections.
This requires:

- **File descriptors**: each QUIC connection is one UDP socket (shared) +
  streams. With connection pooling, ~2K FDs for 50K connections (agents
  multiplex connections over shared QUIC connections to the relay).
- **Memory**: ~8KB per forwarding buffer (`vec![0u8; 8192]` per direction,
  `relay_forwarding.rs:465, 483`) → ~800MB for 50K connections. Plus
  `RelayedConnection` structs (~200 bytes each → ~10MB) and QUIC stream
  state (~50KB per stream → ~5GB for 100K streams). Total: ~6GB.
- **CPU**: forwarding is `recv → write` copies. At 8KB chunks, a modern
  core handles ~100K copies/sec. For 50K connections at 100KB/s each (5
  Gbps aggregate), ~6 cores needed for forwarding.
- **Tokio tasks**: 2 tasks per connection → 100K tasks. Tokio handles this
  comfortably (tasks are lightweight, ~128 bytes each).

### 8.3 Bandwidth

A premium relay with 50K connections at an average of 100KB/s each carries
5 Gbps aggregate. At 10 Gbps NIC capacity, this leaves headroom for peaks.
Relays should be provisioned with:

- 10 Gbps NIC (or 2× 10 Gbps bonded for redundancy).
- Sufficient CPU to saturate the NIC (forwarding is copy-bound, ~1 core
  per Gbps with 8KB chunks).
- BGP-capable upstream for anycast (§13).

### 8.4 Geographic Distribution

Latency is dominated by the caller→relay and relay→target RTTs. To minimize
added latency, relays must be geographically distributed so that any agent
has a relay within ~50ms RTT. The concrete deployment (§13) places 2
relays in each of 5 regions, covering North America, Europe, Asia, South
America, and Oceania.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Geographic Relay Distribution                     │
│                                                                     │
│   ┌────────────────────────────────────────────────┐                │
│   │  US-East (Virginia)     US-West (Oregon)       │                │
│   │  ● Relay US-1          ● Relay US-2            │                │
│   │  RTT to NA agents: <30ms                       │                │
│   ├────────────────────────────────────────────────┤                │
│   │  EU-West (Ireland)     EU-Central (Frankfurt)  │                │
│   │  ● Relay EU-1          ● Relay EU-2            │                │
│   │  RTT to EU agents: <30ms                       │                │
│   ├────────────────────────────────────────────────┤                │
│   │  AP-South (Singapore)  AP-Northeast (Tokyo)    │                │
│   │  ● Relay AP-1          ● Relay AP-2            │                │
│   │  RTT to AP agents: <40ms                       │                │
│   ├────────────────────────────────────────────────┤                │
│   │  SA-East (São Paulo)   OC-Australia (Sydney)   │                │
│   │  ● Relay SA-1          ● Relay OC-1            │                │
│   │  RTT to SA/OC agents: <50ms                    │                │
│   └────────────────────────────────────────────────┘                │
│                                                                     │
│   Total: 10 relays, 5 regions, 500K concurrent connections           │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.5 Capacity Headroom

Each relay is provisioned for 50K connections but configured with
`max_connections: 40000` (80% utilization target). This leaves 20% headroom
for:

- Failover traffic from a downed peer relay in the same region.
- Bursty connection spikes.
- Federation traffic (which is accounted separately but shares resources).

When a relay reaches 80% utilization, `has_capacity()` returns false and
`select_best_relay()` routes new connections to other relays
(`relay_discovery.rs:70-75, 271-288`).

---

## 9. Relay Implementation in Rust

### 9.1 Existing Crate Structure

The `aafp-nat` crate (`implementations/rust/crates/aafp-nat/src/`)
already contains the core relay building blocks:

| Module | Status | Purpose |
|--------|--------|---------|
| `relay.rs` | Stub | `RelayService`, `RelayConfig`, `RelayNode` — relay assignment tracking |
| `relay_v1.rs` | Implemented | `RelayV1Service` — reservation lifecycle (reserve/renew/cancel), connection management, capacity limits, RPC params/results with CBOR encoding |
| `relay_forwarding.rs` | Implemented | `RelayV1Server` — QUIC accept loop, control/data stream dispatch, `forward_data()` bidirectional byte pipe, `RelayV1CallerHelper`, `RelayV1TargetHandler` |
| `relay_discovery.rs` | Implemented | `RelayDiscovery` cache, `RelayNodeInfo`, `RelayHealthChecker`, `RelayDiscoveryService` — DHT/bootstrap discovery, health checks, best-relay selection |
| `auto_nat.rs` | Stub | `AutoNat`, `NatStatus` — dial-back NAT detection |
| `auto_nat_v1.rs` | Implemented | `AutoNatClient`, `AutoNatV1DialBack` — dial-back based NAT detection (RFC 0010 §6) |
| `dcutr.rs` | Stub | `Dcutr` — hole punch attempt tracking |
| `dcutr_v1.rs` | Implemented | `DcutrV1`, `DcutrCoordinator`, `CoordinateMessage`, `NatType` — hole punching (RFC 0010 §7) |

### 9.2 The Forwarding Hot Path

The core forwarding loop is in `forward_data()` (`relay_forwarding.rs:454`).
It spawns two tokio tasks — one per direction — that copy bytes between
QUIC streams in 8KB chunks:

```rust
// relay_forwarding.rs:454-503 (simplified)
pub async fn forward_data(
    caller_recv: QuicRecvStream,
    caller_send: QuicSendStream,
    target_send: QuicSendStream,
    target_recv: QuicRecvStream,
) {
    // Task 1: caller → target
    let task1 = tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        loop {
            match caller_recv.read(&mut buf).await {
                Ok(Some(0)) | Ok(None) | Err(_) => break,
                Ok(Some(n)) => {
                    if target_send.write_all(&buf[..n]).await.is_err() { break; }
                }
            }
        }
        target_send.finish();
    });

    // Task 2: target → caller (symmetric)
    let task2 = tokio::spawn(async move { /* ... */ });

    let _ = task1.await;
    let _ = task2.await;
}
```

This is the performance-critical path. For a production premium relay,
optimizations include:

- **Larger buffers**: 64KB or 256KB chunks to reduce syscall count (at the
  cost of memory: 64KB × 100K tasks = 6.4GB).
- **`recv_buf`/`send_buf` tuning**: quinn's per-stream buffer sizes should
  be tuned for high throughput.
- **Zero-copy where possible**: quinn does not currently support true
  zero-copy, but `write_all` with large buffers minimizes copies.
- **`tokio::select!` instead of two tasks**: a single task with
  `tokio::select!` over both directions reduces task overhead, though it
  sacrifices parallelism on multi-core.

### 9.3 Relay Server Architecture

The `RelayV1Server` (`relay_forwarding.rs:63-155`) is the production relay
entry point:

```rust
pub struct RelayV1Server {
    transport: QuicTransport,
    service: Arc<Mutex<RelayV1Service>>,
    agent_connections: Arc<Mutex<HashMap<AgentId, QuicConnection>>>,
    pending_connections: Arc<Mutex<HashMap<u64, PendingConnection>>>,
}
```

The `run()` method (`relay_forwarding.rs:117-144`) accepts QUIC connections
in a loop and spawns a task per connection. Each connection task accepts
bi-streams and dispatches them: the first byte distinguishes control
streams (RPC) from data streams (`relay_forwarding.rs:209-237`).

For a premium relay, the `std::sync::Mutex` on `agent_connections` and
`pending_connections` should be replaced with `tokio::sync::RwLock` or a
`dashmap::DashMap` to avoid contention at 50K connections. The
`RelayV1Service` mutex is held only briefly (during synchronous RPC
handling), so it is less of a bottleneck.

### 9.4 Production Relay Configuration

```rust
use aafp_nat::relay_v1::{RelayV1Config, RelayV1Service};
use aafp_nat::relay_forwarding::RelayV1Server;
use aafp_transport_quic::QuicTransport;

let config = RelayV1Config {
    max_reservations: 100_000,      // premium relay
    max_duration_secs: 7200,        // 2 hours
    max_connections: 40_000,        // 80% of 50K capacity
    relay_addr: "quic://relay-us-east-1.aafp.net:4433".into(),
};

let transport = QuicTransport::new(QuicConfig::default())?;
let service = Arc::new(Mutex::new(RelayV1Service::new(config)));
let server = RelayV1Server::new(transport, service);

// Advertise relay capability in DHT
// Start health monitor
// Start federation links

server.run().await;  // accepts and forwards forever
```

### 9.5 What Needs To Be Built

The existing crate provides the protocol-level relay. To reach the
production deployment described in this document, the following must be
added:

1. **Federation module** (`relay_federation.rs`): relay-to-relay forwarding,
   federation link management, distance-vector routing, TTL/loop prevention.
2. **Premium relay auth**: UCAN validation for `relay.premium` capability
   during `reserve` RPC (integrate with `aafp-identity::trust_manager`).
3. **Production caller_id extraction**: replace the placeholder
   `extract_caller_id()` (`relay_forwarding.rs:523-534`) with TLS
   certificate-based extraction.
4. **WebSocket gateway**: `relay_ws.rs` — accept WebSocket connections from
   browsers and bridge to QUIC (§10).
5. **WebTransport gateway**: `relay_webtransport.rs` — accept HTTP/3
   WebTransport sessions from browsers (§11).
6. **Health monitor**: `relay_health.rs` — Prometheus metrics exporter,
   active health checks, failover coordinator (§12).
7. **Capacity reporting**: relays report `current_connections` and
   `max_connections` in their DHT `AgentRecord` so `RelayNodeInfo` can
   use real capacity data (`relay_discovery.rs:44-46`).
8. **DashMap migration**: replace `std::sync::Mutex<HashMap>` with
   `DashMap` for high-concurrency state.

---

## 10. WebSocket Relay for Browser Agents

### 10.1 Problem

Browser-based AAFP agents cannot open raw QUIC connections (browsers do not
expose a UDP socket API). They can only use WebSocket (`ws://` or `wss://`)
or WebTransport (HTTP/3, §11). A browser agent behind NAT needs a relay,
but it cannot speak the QUIC-based relay protocol directly.

### 10.2 WebSocket-to-QUIC Bridge

A WebSocket relay gateway accepts WebSocket connections from browsers and
bridges each WebSocket message to a QUIC stream on the relay's internal
QUIC fabric:

```
  Browser Agent                WebSocket Gateway              QUIC Relay
  (behind NAT)                 (relay-ws.aafp.net)            (relay.aafp.net)
       │                              │                              │
       │── wss://relay-ws.aafp.net ─▶│                              │
       │   (WebSocket upgrade)        │                              │
       │                              │── QUIC conn (internal) ─────▶│
       │── WS binary frame ──────────▶│── QUIC stream write ────────▶│
       │   (relay RPC or data)        │                              │
       │◀── WS binary frame ──────────│◀── QUIC stream read ─────────│
```

The WebSocket gateway is a thin shim. It:

1. Accepts a `wss://` connection (TLS-terminated at the gateway).
2. Authenticates the browser agent via the AAFP v1 handshake (carried in
   WebSocket binary frames).
3. Opens a QUIC connection to the relay's QUIC listener.
4. Bridges each WebSocket binary frame to a QUIC stream write, and vice
   versa.

The gateway does **not** terminate the AAFP session — it is a transport
bridge, not a protocol terminator. The end-to-end encryption (browser ↔
target agent) is preserved because the handshake keys are established
browser-to-target, not browser-to-gateway.

### 10.3 Framing

WebSocket binary frames carry AAFP frames directly. The first frame from
the browser is the v1 handshake init; subsequent frames are DATA frames
(relay RPC, application data). The gateway is frame-opaque: it forwards
bytes without parsing AAFP frames.

For the relay RPC protocol, the browser sends `aafp.relay.reserve` /
`aafp.relay.connect` as AAFP RPC frames inside WebSocket binary frames.
The gateway forwards them to the relay's QUIC control stream. Data streams
are multiplexed over the WebSocket using a stream-ID prefix (since
WebSocket has no native multiplexing):

```
  WS binary frame: [4-byte stream_id][payload]
```

The gateway maps `stream_id` to a QUIC bi-stream on the relay connection.
Stream ID 0 is the control stream (RPC); stream IDs ≥ 1 are data streams.

### 10.4 Deployment

The WebSocket gateway runs as a separate process, co-located with or
adjacent to the QUIC relay. It listens on `wss://relay-ws.aafp.net:443`
(TLS on 443 for browser compatibility) and connects to
`quic://relay-internal.aafp.net:4433` on the backend.

```
┌──────────────────────────────────────────────────────────────┐
│              Browser → WebSocket → QUIC Path                  │
│                                                              │
│  Browser ──wss://443──▶ WS Gateway ──quic://4433──▶ Relay    │
│  (agent)                 (TLS term)              (forwarder)  │
│                          (frame bridge)                       │
│                                                              │
│  End-to-end encryption: Browser ←──AAFP session keys──→ Target│
│  WS gateway sees: encrypted bytes only                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 11. WebTransport Relay for Browser Agents

### 11.1 Why WebTransport

WebSocket has a fundamental limitation for the relay protocol: it is a
single ordered stream. The AAFP relay protocol uses multiple independent
QUIC bi-streams (one control stream + N data streams). Multiplexing these
over a single WebSocket adds head-of-line blocking — a stalled data stream
blocks the control stream.

WebTransport (HTTP/3 based) solves this. It provides **multiple
bidirectional and unidirectional streams** over HTTP/3, with independent
flow control per stream — closely matching QUIC's stream model. This allows
a direct mapping:

| QUIC (native relay) | WebTransport (browser relay) |
|---------------------|------------------------------|
| QUIC connection | WebTransport session |
| QUIC bi-stream | WebTransport bidirectional stream |
| QUIC uni-stream | WebTransport unidirectional stream |
| QUIC datagram | WebTransport datagram |

### 11.2 WebTransport Gateway

The WebTransport gateway accepts HTTP/3 sessions from browsers and bridges
each WebTransport stream to a QUIC stream on the relay:

```
  Browser Agent              WebTransport Gateway           QUIC Relay
  (behind NAT)               (relay-wt.aafp.net)            (relay.aafp.net)
       │                            │                              │
       │── HTTP/3 CONNECT ────────▶│                              │
       │   /aafp-relay              │                              │
       │   (WebTransport session)   │                              │
       │                            │── QUIC conn (internal) ─────▶│
       │── WT bi-stream (control) ─▶│── QUIC bi-stream ───────────▶│
       │── WT bi-stream (data) ────▶│── QUIC bi-stream ───────────▶│
       │   [0xFF + conn_id]         │                              │
       │◀── WT bi-stream ───────────│◀── QUIC bi-stream ───────────│
```

The mapping is 1:1: each WebTransport bi-stream becomes a QUIC bi-stream on
the relay connection. The gateway does not need the stream-ID prefix that
the WebSocket gateway uses — WebTransport's native stream multiplexing
handles it.

### 11.3 Datagram Support

WebTransport datagrams map to QUIC datagrams, which are useful for
low-latency, loss-tolerant relayed traffic (e.g., real-time agent
telemetry). The relay can forward datagrams without stream overhead, though
datagrams are optional and may be dropped under congestion.

### 11.4 Browser Compatibility

WebTransport is supported in Chromium-based browsers (Chrome, Edge) and
Firefox (behind a flag as of 2026). For Safari and older browsers, the
WebSocket gateway (§10) remains the fallback. The browser agent detects
WebTransport support at runtime and selects the appropriate gateway:

```javascript
if (typeof WebTransport !== 'undefined') {
    // Use WebTransport relay: https://relay-wt.aafp.net/aafp-relay
} else {
    // Fallback to WebSocket relay: wss://relay-ws.aafp.net
}
```

### 11.5 Co-Deployment

The WebTransport gateway and WebSocket gateway can run in the same process
(an HTTP/3 server that handles both WebTransport CONNECT requests and
WebSocket upgrade requests), or as separate processes behind a load
balancer. Co-deployment simplifies operations:

```
┌─────────────────────────────────────────────────────────────┐
│            Browser Relay Gateway (port 443)                  │
│                                                             │
│  ┌─────────────────┐    ┌──────────────────┐                │
│  │ WebTransport    │    │ WebSocket        │                │
│  │ (HTTP/3 CONNECT)│    │ (wss:// upgrade) │                │
│  └────────┬────────┘    └────────┬─────────┘                │
│           └──────────┬───────────┘                          │
│                      ▼                                      │
│           ┌────────────────────┐                            │
│           │ Stream Bridge      │  (WT stream ↔ QUIC stream) │
│           │ (WS frame ↔ QUIC)  │                            │
│           └────────┬───────────┘                            │
│                    ▼                                        │
│           ┌────────────────────┐                            │
│           │ QUIC Backend       │──▶ relay.aafp.net:4433     │
│           └────────────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 12. Relay Health Monitoring and Failover

### 12.1 Health Monitoring

Each relay is monitored through three layers:

**Layer 1 — Self-monitoring (relay-internal):**
The relay exports Prometheus metrics via an HTTP endpoint
(`/metrics` on port 9090):

| Metric | Type | Description |
|--------|------|-------------|
| `aafp_relay_active_reservations` | gauge | Current reservation count |
| `aafp_relay_active_connections` | gauge | Current relayed connection count |
| `aafp_relay_bytes_forwarded_total` | counter | Total bytes forwarded |
| `aafp_relay_connections_total` | counter | Total connections accepted |
| `aafp_relay_connection_duration_seconds` | histogram | Connection duration distribution |
| `aafp_relay_reserve_failures_total` | counter | Reserve RPC failures (by reason) |
| `aafp_relay_federation_hops` | gauge | Active federation links |
| `aafp_relay_health_check_latency_ms` | gauge | Last self-check latency |

These are sourced from `RelayV1Service` state (`reservation_count()`,
`connection_count()`, `relay_v1.rs:578-586`) and per-connection byte
counters (`RelayedConnection.bytes_forwarded`, `relay_v1.rs:111`).

**Layer 2 — Active probing (agent-side):**
Agents health-check relays via `RelayHealthChecker::check()`
(`relay_discovery.rs:387-420`), which opens a QUIC connection, measures
RTT, and records `(healthy, latency_ms)` in `RelayNodeInfo`
(`relay_discovery.rs:86-90`). Health checks run on the refresh interval
(default 300s, `DEFAULT_REFRESH_INTERVAL_SECS`). The
`RelayDiscoveryService::refresh_health_checks()` method
(`relay_discovery.rs:483-501`) re-probes all known relays.

**Layer 3 — Cross-relay probing (federation):**
Peer relays in the federation mesh probe each other every 30s. A relay
that fails 3 consecutive probes is marked unhealthy in the federation
routing table and traffic is rerouted.

### 12.2 Failover

When a relay becomes unhealthy, failover happens at two levels:

**Agent-level failover:**
If an agent's active relay becomes unhealthy (detected by health check or
connection failure), the agent:

1. Calls `select_best_relay_excluding()` (`relay_discovery.rs:291-307`) to
   find an alternative relay.
2. Establishes a new reservation on the alternative relay.
3. Re-establishes active connections through the new relay.
4. Attempts DCuTR upgrade on the new connections (which may succeed if the
   relay change altered NAT traversal conditions).

```
┌──────────────────────────────────────────────────────────────┐
│                   Agent Failover Flow                         │
│                                                              │
│  Agent ──using──▶ Relay R1 (unhealthy)                       │
│    │                                                          │
│    │ Health check fails / connection drops                    │
│    ▼                                                          │
│  select_best_relay_excluding(R1)                              │
│    │                                                          │
│    ▼                                                          │
│  Relay R2 (healthy, has capacity)                             │
│    │                                                          │
│    ├── reserve on R2                                          │
│    ├── reconnect to peers via R2                              │
│    └── attempt DCuTR upgrade (may go direct)                  │
└──────────────────────────────────────────────────────────────┘
```

**Relay-level failover (federation):**
If a relay in the federation mesh goes down, peer relays detect it via
cross-relay probing and update their routing tables. Federation traffic
that would have routed through the downed relay is rerouted to an
alternative path. The TTL and visited-relay list prevent loops during
rerouting.

### 12.3 Graceful Shutdown

A relay undergoing maintenance sends a `relay.shutdown` notification
(a new RPC method, not in the current spec) to all agents with active
reservations. Agents receive a 60-second warning and migrate to another
relay. The relay stops accepting new reservations immediately but keeps
existing connections alive until they close or the 60-second window
expires.

### 12.4 Circuit Breakers

Each relay implements circuit breakers to protect itself under load:

- **Reservation rate limit**: max N new reservations per second (default
  100/s). Excess requests get `AtCapacity` (`relay_v1.rs:43`).
- **Connection rate limit**: max N new connections per second.
- **Per-agent connection cap**: max M concurrent connections from a single
  agent (prevents one agent from monopolizing the relay).
- **Bandwidth cap**: `RelayNode.max_bps` (`relay.rs:33`) per connection,
  enforced by the forwarding loop (a future enhancement; currently
  `max_bps` is stored but not enforced in `forward_data()`).

When a circuit breaker trips, the relay returns `AtCapacity` and the agent
fails over to another relay.

---

## 13. Concrete Deployment: 10 Relays, 5 Regions

### 13.1 Topology

```
┌───────────────────────────────────────────────────────────────────────┐
│                    AAFP Relay Network — 10 Relays                      │
│                                                                       │
│   Region          Relay ID       Location          Connections         │
│   ─────────       ──────────     ───────────       ───────────        │
│   US-East         relay-us-1     Virginia, US      50K (cap 40K)      │
│   US-West         relay-us-2     Oregon, US        50K (cap 40K)      │
│   EU-West         relay-eu-1     Ireland           50K (cap 40K)      │
│   EU-Central      relay-eu-2     Frankfurt, DE     50K (cap 40K)      │
│   AP-South        relay-ap-1     Singapore         50K (cap 40K)      │
│   AP-Northeast    relay-ap-2     Tokyo, JP         50K (cap 40K)      │
│   SA-East         relay-sa-1     São Paulo, BR     50K (cap 40K)      │
│   OC-Australia    relay-oc-1     Sydney, AU        50K (cap 40K)      │
│   NA-Central      relay-na-1     Dallas, US        50K (cap 40K)      │
│   AF-South        relay-af-1     Cape Town, ZA     50K (cap 40K)      │
│                                                                       │
│   Total capacity: 500K concurrent connections                         │
│   Federation: full mesh among 10 relays (45 links)                    │
│   Anycast: relay.aafp.net resolves to nearest relay via BGP           │
└───────────────────────────────────────────────────────────────────────┘
```

### 13.2 Per-Relay Hardware

| Component | Specification | Rationale |
|-----------|--------------|-----------|
| CPU | 16 cores / 32 threads (AMD EPYC or Xeon) | Forwarding is copy-bound; ~1 core/Gbps + overhead |
| RAM | 32 GB ECC | ~6GB for 50K connections + OS + quinn buffers |
| NIC | 2× 10 Gbps (bonded) | 5 Gbps typical, 10 Gbps peak, redundancy |
| Storage | 100 GB NVMe | Logs, metrics, no persistent relay state |
| Network | BGP-capable, /24 anycast prefix | Anycast routing for `relay.aafp.net` |

### 13.3 Anycast Routing

`relay.aafp.net` is advertised as an anycast /24 from all 10 relay
locations via BGP. A browser or agent resolving `relay.aafp.net` gets the
IP of the nearest relay (by BGP routing, which approximates geographic
proximity). This provides:

- **Automatic geographic routing**: agents connect to the nearest relay
  without explicit geo-detection.
- **Automatic failover**: if a relay's BGP announcement is withdrawn
  (e.g., the relay goes down), traffic automatically routes to the next-
  nearest relay within seconds.
- **DDoS distribution**: an attack on `relay.aafp.net` is distributed
  across all 10 locations.

### 13.4 DNS Configuration

```
;; Anycast address (BGP-advertised from all 10 locations)
relay.aafp.net.           A    192.0.2.1
relay.aafp.net.           AAAA 2001:db8::1

;; Per-region names (for explicit relay selection)
relay-us-east.aafp.net.   A    <us-east-1 IP>
relay-us-west.aafp.net.   A    <us-west-1 IP>
relay-eu-west.aafp.net.   A    <eu-west-1 IP>
relay-eu-central.aafp.net. A   <eu-central-1 IP>
relay-ap-south.aafp.net.  A    <ap-south-1 IP>
relay-ap-northeast.aafp.net. A <ap-northeast-1 IP>
relay-sa-east.aafp.net.   A    <sa-east-1 IP>
relay-oc-australia.aafp.net. A <oc-1 IP>
relay-na-central.aafp.net. A   <na-1 IP>
relay-af-south.aafp.net.  A    <af-1 IP>

;; SRV records for DHT-less discovery
_aafp-relay._udp.aafp.net. SRV 10 10 4433 relay-us-east.aafp.net.
_aafp-relay._udp.aafp.net. SRV 10 10 4433 relay-eu-west.aafp.net.
_aafp-relay._udp.aafp.net. SRV 10 10 4433 relay-ap-south.aafp.net.
;; ... (one SRV per relay)

;; WebSocket/WebTransport gateways
relay-ws.aafp.net.  CNAME relay.aafp.net.   (anycast, port 443)
relay-wt.aafp.net.  CNAME relay.aafp.net.   (anycast, port 443)
```

### 13.5 Federation Mesh

The 10 relays form a full mesh (45 bidirectional federation links). Each
relay maintains 9 federation links. Federation link state is lightweight
(one persistent QUIC connection per peer relay), so 9 links per relay is
trivial overhead.

Federation traffic is routed by the distance-vector protocol (§4.4). With
a full mesh, any agent can reach any other agent through at most 2 relay
hops (caller's relay → target's relay), and usually 1 hop (same relay).

```
┌─────────────────────────────────────────────────────────────────┐
│              Federation Mesh (10 relays, full mesh)              │
│                                                                 │
│    us-1 ─── us-2 ─── na-1                                      │
│     │ ╲   ╱ │       ╱ │                                        │
│     │  ╲ ╱  │      ╱  │                                        │
│     │  ╱ ╲  │     ╱   │                                        │
│     │ ╱   ╲ │    ╱    │                                        │
│    eu-1 ─ eu-2 ─ sa-1                                       │
│     │       │      │                                           │
│     │       │      │                                           │
│    ap-1 ── ap-2 ── oc-1 ── af-1                               │
│                                                                 │
│  Each line = bidirectional federation link (QUIC connection)    │
│  Max relay hops between any two agents: 2                       │
│  Federation links per relay: 9                                  │
│  Total federation links: 45                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 13.6 Capacity Math

| Metric | Per relay | Fleet total (10 relays) |
|--------|-----------|------------------------|
| Max concurrent connections | 50,000 | 500,000 |
| Configured cap (80%) | 40,000 | 400,000 |
| Aggregate bandwidth | 5 Gbps | 50 Gbps |
| Forwarding tasks | 100,000 | 1,000,000 |
| Memory (connections) | ~6 GB | ~60 GB |
| Federation links | 9 | 45 |
| Prometheus metrics | ~20 | ~200 |

### 13.7 Deployment Checklist

For each relay in the fleet:

- [ ] Provision hardware (§13.2) in the target region.
- [ ] Install `aafp-relay` binary (compiled from `aafp-nat` crate + production
  modules from §9.5).
- [ ] Configure `RelayV1Config` with region-specific `relay_addr`,
  `max_connections: 40000`, `max_reservations: 100000`.
- [ ] Generate relay `AgentKeypair` (ML-DSA-65) and obtain CA-signed
  certificate (RFC 0011) for premium tier.
- [ ] Advertise `relay` capability in DHT with capacity metadata.
- [ ] Configure BGP anycast announcement for `192.0.2.1` / `2001:db8::1`.
- [ ] Start QUIC listener on port 4433.
- [ ] Start WebSocket gateway on port 443 (wss://).
- [ ] Start WebTransport gateway on port 443 (HTTP/3).
- [ ] Start Prometheus metrics exporter on port 9090.
- [ ] Establish federation links to the other 9 relays.
- [ ] Configure health check probes (agent-side + cross-relay).
- [ ] Set up alerting: connection count, bandwidth, error rate, health
  check failures.
- [ ] Run load test: verify 40K concurrent connections at 5 Gbps with
  <50ms intra-region forwarding latency.

### 13.8 Cost Estimate

| Item | Monthly cost (USD) | Notes |
|------|-------------------|-------|
| 10× dedicated servers | $10,000 | $1,000/server, 16-core/32GB/10Gbps |
| BGP anycast /24 | $2,000 | Transit + IP space |
| Bandwidth (50 Gbps peak) | $5,000 | Transit at ~$0.50/Mbps |
| DNS (anycast, SRV) | $500 | Managed DNS provider |
| TLS certificates | $0 | Let's Encrypt or included with CA |
| Monitoring (Prometheus + Grafana) | $500 | Self-hosted on 2 servers |
| Operations engineering | $15,000 | 1 FTE shared across fleet |
| **Total** | **~$33,000/month** | **~$400K/year** |

Community relays (volunteer-operated) are not included in this cost; they
supplement the premium fleet at no cost to the operator.

---

## 14. Open Questions and Future Work

### 14.1 Relay Privacy Enhancements

- **Onion routing**: chaining multiple relays (like Tor) so no single relay
  knows both endpoints. This is incompatible with the current 2-hop
  federation limit and would require a separate protocol extension.
- **Cover traffic**: relays could inject dummy traffic to obscure traffic
  patterns, at significant bandwidth cost.
- **VRF-based relay selection**: agents select relays using a verifiable
  random function, making relay selection unpredictable to an adversary.

### 14.2 Relay Incentives

- **Relay credits**: agents that run community relays earn credits that can
  be spent on premium relays. Requires a ledger (on-chain or off-chain).
- **Proof of relay**: a cryptographic proof that a relay forwarded N bytes,
  verifiable by the agent, enabling micropayments per byte forwarded.

### 14.3 Protocol Extensions

- **`relay.shutdown` notification**: graceful shutdown RPC (§12.3).
- **`relay.federate` RPC**: explicit federation link establishment and
  capacity exchange.
- **`relay.metrics` RPC**: relays expose real-time capacity and health to
  agents (beyond the static DHT metadata).
- **Datagram relay**: forwarding QUIC datagrams (not just streams) for
  low-latency relayed traffic.

### 14.4 Browser Agent Maturity

- **WebTransport adoption tracking**: monitor browser support and
  deprecate the WebSocket gateway when WebTransport is universally
  available.
- **WebRTC fallback**: for browsers that support neither WebTransport nor
  reliable WebSocket multiplexing, a WebRTC data channel bridge could
  provide stream multiplexing over ICE/STUN.

### 14.5 Scaling Beyond 10 Relays

- **Regional expansion**: add relays in Africa, Middle East, and South Asia
  as adoption grows.
- **Hierarchical federation**: as relay count grows beyond ~50, switch from
  full mesh to a hierarchical federation (regional hubs + global
  super-hubs) to bound federation link count.
- **Elastic scaling**: auto-provision relays in response to demand spikes,
  using cloud instances for burst capacity.

---

## Appendix A: Wire Format Reference

### A.1 Relay RPC Methods (RFC 0010 §2.1)

| Method | Params | Result | Reference |
|--------|--------|--------|-----------|
| `aafp.relay.reserve` | `{1: uint duration_secs}` | `{1: uint reservation_id, 2: uint expires_at, 3: tstr relay_addr}` | `relay_v1.rs:120-200` |
| `aafp.relay.renew` | `{1: uint reservation_id, 2: uint duration_secs}` | same as reserve | `relay_v1.rs:207-247` |
| `aafp.relay.cancel` | `{1: uint reservation_id}` | `{}` | `relay_v1.rs:254-279` |
| `aafp.relay.connect` | `{1: bstr target (32 bytes)}` | `{1: uint connection_id}` | `relay_v1.rs:286-351` |

### A.2 Data Stream Headers (RFC 0010 §4.2)

| Direction | Magic | Header | Reference |
|-----------|-------|--------|-----------|
| Caller → Relay | `0xFF` | `[0xFF][8-byte connection_id BE]` | `relay_forwarding.rs:44` |
| Relay → Target | `0xFE` | `[0xFE][8-byte connection_id BE]` | `relay_forwarding.rs:47` |
| Federation (proposed) | `0xFD` | `[0xFD][8-byte fed_id][32-byte target]` | (not yet implemented) |

### A.3 Capacity Defaults (RFC 0010 §5)

| Parameter | Default | Premium | Reference |
|-----------|---------|---------|-----------|
| `max_reservations` | 100 | 100,000 | `relay_v1.rs:32` |
| `max_duration_secs` | 3600 (1h) | 7200 (2h) | `relay_v1.rs:35` |
| `max_connections` | 50 | 40,000 | `relay_v1.rs:38` |
| `max_bps` | 0 (unlimited) | configurable | `relay.rs:33` |
| `max_relays` (cache) | 5 | 10 | `relay_discovery.rs:20` |
| `refresh_interval` | 300s | 60s | `relay_discovery.rs:23` |
| `health_check_timeout` | 5s | 3s | `relay_discovery.rs:26` |

---

## Appendix B: Relay State Machine

### B.1 Reservation State

```
  [none] ──reserve()──▶ [active] ──expire()──▶ [expired] ──evict()──▶ [none]
                           │                       │
                           │──renew()──▶ [active]  │
                           │                       │
                           └──cancel()──▶ [none]   │
                                                   │
                          [active] ──is_expired()──┘
```

### B.2 Connection State

```
  [none] ──connect()──▶ [pending] ──data stream opened──▶ [forwarding]
                                                           │
                                                           ├──stream close──▶ [closed]
                                                           │
                                                           └──DCuTR upgrade──▶ [upgraded/direct]
```

### B.3 Agent Relay Selection State

```
  [no relay] ──discover()──▶ [candidates] ──health check──▶ [healthy relay]
                                                                  │
                                                                  ├──reserve()──▶ [reserved]
                                                                  │                  │
                                                                  │                  └──connect()──▶ [connected]
                                                                  │
                                                                  └──unhealthy──▶ [candidates]
```

---

## Appendix C: File-to-Feature Mapping

| Feature | Source file | Key types/functions |
|---------|------------|---------------------|
| Relay config & assignment | `relay.rs` | `RelayConfig`, `RelayNode`, `RelayService` |
| Reservation lifecycle | `relay_v1.rs` | `RelayV1Service`, `Reservation`, `handle_reserve/renew/cancel` |
| Connection management | `relay_v1.rs` | `RelayedConnection`, `handle_connect`, `evict_expired` |
| RPC params/results | `relay_v1.rs` | `ReserveParams`, `ConnectParams`, `ReserveResult`, `ConnectResult` |
| QUIC server & forwarding | `relay_forwarding.rs` | `RelayV1Server`, `forward_data()`, `handle_bi_stream` |
| Caller-side helper | `relay_forwarding.rs` | `RelayV1CallerHelper::connect` |
| Target-side handler | `relay_forwarding.rs` | `RelayV1TargetHandler::reserve/accept_incoming` |
| Wire format constants | `relay_forwarding.rs` | `DATA_STREAM_MAGIC (0xFF)`, `INCOMING_STREAM_MAGIC (0xFE)` |
| Discovery cache | `relay_discovery.rs` | `RelayDiscovery`, `RelayNodeInfo`, `select_best_relay` |
| Health checking | `relay_discovery.rs` | `RelayHealthChecker::check`, `RelayDiscoveryService` |
| NAT detection | `auto_nat.rs`, `auto_nat_v1.rs` | `AutoNat`, `NatStatus`, `AutoNatV1DialBack` |
| Hole punching | `dcutr.rs`, `dcutr_v1.rs` | `Dcutr`, `DcutrV1`, `CoordinateMessage`, `NatType` |

---

*End of document. This architecture is grounded in the existing `aafp-nat`
crate (9 source files, ~3000 lines) and RFC 0010. Production deployment
requires the extensions listed in §9.5 (federation, premium auth, browser
gateways, health monitoring, DashMap migration). The core forwarding and
reservation protocol is already implemented and tested.*
