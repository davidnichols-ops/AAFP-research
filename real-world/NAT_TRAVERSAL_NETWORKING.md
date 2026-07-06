# AAFP NAT Traversal & Real-World Networking

**Author:** Research synthesis
**Date:** 2026-07-04
**Status:** Reference document for `aafp-nat` crate design
**Related RFC:** RFC 0010 (Circuit Relay, AutoNAT, DCuTR)
**Related crate:** `implementations/rust/crates/aafp-nat/`

---

## 0. Why This Document Exists

The strategic vision (`STRATEGIC_VISION.md`) is explicit: *"You cannot build an
agent operating system on a protocol that has never touched the real
internet."* Track O (WAN testing) and Track R (WAN discovery) demand that AAFP
work across the messy reality of home routers, carrier-grade NAT, mobile
networks, corporate firewalls, and IPv6 transition mechanisms.

This document is the networking layer's field guide. It maps the abstract
concepts in RFC 0010 — relay, AutoNAT, DCuTR — onto the physical realities of
the internet, and sketches how the existing Rust stubs in `aafp-nat` evolve
into production code. Every section ends with concrete Rust architecture
pointers to the relevant module.

The existing crate already contains substantial scaffolding:

| Module | Status | Purpose |
|--------|--------|---------|
| `relay.rs` | Stub | Legacy relay config/assignment tracking |
| `relay_v1.rs` | RFC 0010 §2-5 | Reservation lifecycle, RPC methods, capacity limits |
| `relay_forwarding.rs` | RFC 0010 §4.2 | Bidirectional QUIC stream byte-pipe |
| `relay_discovery.rs` | RFC 0010 §9 | DHT lookup of `relay` capability, health checks |
| `auto_nat.rs` | Stub | Legacy NAT status tracker |
| `auto_nat_v1.rs` | RFC 0010 §6 | Dial-back detection, observed address collection |
| `dcutr.rs` | Stub | Legacy upgrade attempt history |
| `dcutr_v1.rs` | RFC 0010 §7 | Coordinate messages, simultaneous open, NAT classification |

The v1 modules are the RFC-compliant path. The legacy stubs are kept only for
backward compatibility and benchmarks, mirroring the convention used across the
workspace (v1 types are primary).

---

## 1. NAT Types and AAFP's Approach to Each

### 1.1 The Four NAT Behaviors

NAT behavior is conventionally classified by two independent axes — *mapping*
(how the NAT assigns the public endpoint for an outbound flow) and *filtering*
(how the NAT decides which inbound packets to allow). RFC 3489's four classic
types collapse these axes; the modern RFC 4787/RFC 5382 terminology is more
precise but the four-type model remains the useful mental model for hole
punching.

```
┌──────────────────┬────────────────────────────┬──────────────────────────────┐
│ NAT Type         │ Mapping Behavior           │ Filtering Behavior           │
├──────────────────┼────────────────────────────┼──────────────────────────────┤
│ Full Cone        │ Same public 4-tuple for    │ Any inbound to that endpoint │
│ (Endpoint-       │ any destination            │ is forwarded                 │
│  Independent     │                            │                              │
│  Mapping +       │                            │                              │
│  Address-        │                            │                              │
│  Dependent       │                            │                              │
│  Filtering)      │                            │                              │
├──────────────────┼────────────────────────────┼──────────────────────────────┤
│ Restricted Cone  │ Same public 4-tuple for    │ Inbound allowed only from    │
│ (Endpoint-       │ any destination            │ IPs the local host has       │
│  Independent     │                            │ previously sent to           │
│  Mapping +       │                            │                              │
│  Address- and    │                            │                              │
│  Port-Dependent  │                            │                              │
│  Filtering)      │                            │                              │
├──────────────────┼────────────────────────────┼──────────────────────────────┤
│ Port-Restricted  │ Same public 4-tuple for    │ Inbound allowed only from    │
│ Cone             │ any destination            │ the exact IP+port the local  │
│ (Endpoint-       │                            │ host has previously sent to  │
│  Independent     │                            │                              │
│  Mapping +       │                            │                              │
│  Address- and    │                            │                              │
│  Port-Dependent  │                            │                              │
│  Filtering)      │                            │                              │
├──────────────────┼────────────────────────────┼──────────────────────────────┤
│ Symmetric        │ New public 4-tuple for     │ Inbound allowed only from    │
│ (Endpoint-       │ each new destination       │ the exact IP+port the local  │
│  Dependent       │ (port may even vary)       │ host sent to, on that exact  │
│  Mapping)        │                            │ mapped port                  │
└──────────────────┴────────────────────────────┴──────────────────────────────┘
```

The critical distinction for hole punching is the **mapping** axis:

- **Endpoint-independent mapping** (the three "cone" types): the NAT reuses
  the same public `ip:port` for all destinations. A peer that learns the
  public endpoint via a STUN-like observation can dial it back and the NAT
  will route it to the local host (subject to the filtering rule, which
  simultaneous open satisfies).
- **Endpoint-dependent mapping** (symmetric): the NAT assigns a *different*
  public port per destination. The endpoint observed by relay/peer A is
  useless to peer B, because B will see a different mapped port. Classic
  hole punching fails.

### 1.2 AAFP's Strategy per NAT Type

AAFP does not require the agent to know its NAT type a priori. The
`dcutr_v1::NatType` enum classifies NAT behavior empirically from observed
addresses, and the connection strategy adapts:

```
┌──────────────────┬──────────────────────────────────────────────────────────┐
│ Detected NAT     │ AAFP Strategy                                            │
├──────────────────┼──────────────────────────────────────────────────────────┤
│ NoNat            │ Direct QUIC. No relay. Advertise all local addresses.   │
│ ConeNat          │ Attempt DCuTR hole punch after relayed bootstrap.       │
│                  │ Simultaneous open satisfies the filtering rule.          │
│                  │ Upgrade relayed → direct on success.                     │
│ SymmetricNat     │ Relay is the only reliable path. DCuTR is skipped       │
│                  │ (classify_nat_type() returns SymmetricNat → set_enabled │
│                  │ (false) for that peer). Relay stays the transport.       │
│ Unknown          │ Attempt DCuTR optimistically; fall back to relay on     │
│                  │ failure. Re-probe periodically via AutoNAT.             │
└──────────────────┴──────────────────────────────────────────────────────────┘
```

The classification logic lives in `dcutr_v1::DcutrV1::classify_nat_type`:

```rust
pub fn classify_nat_type(observations: &[String]) -> NatType {
    if observations.is_empty() {
        return NatType::Unknown;
    }
    let first = &observations[0];
    if observations.iter().all(|a| a == first) {
        NatType::ConeNat
    } else {
        NatType::SymmetricNat
    }
}
```

This is the simplified libp2p heuristic: if the observed public endpoint is
stable across multiple observers, treat as cone; if it varies, treat as
symmetric. It produces false positives for symmetric NATs that happen to reuse
ports, but those cases still hole-punch successfully, so the misclassification
is harmless. The dangerous direction — classifying a cone NAT as symmetric —
is avoided because a cone NAT by definition produces a stable endpoint.

### 1.3 The Symmetric-NAT Escape Hatch

When both peers are behind symmetric NAT, no amount of coordination produces a
direct connection. AAFP's answer is not to fight this but to make the relay
path first-class. The relay is not a failure mode; it is the default transport
for the majority of real-world agents (home users, mobile devices, containers
behind cloud NATs). DCuTR is an *optimization* that upgrades relayed
connections to direct ones *when physics permits*.

This aligns with the strategic principle *"Compete with gravity, don't fight
it."* Symmetric NAT is gravity. The relay is the path of least resistance.

---

## 2. STUN/TURN Integration for AAFP

### 2.1 Why Reuse WebRTC Infrastructure

The WebRTC ecosystem has spent fifteen years building STUN and TURN
infrastructure. Google operates public STUN servers (`stun.l.google.com:19302`).
Every major cloud has TURN offerings. Coturn is a mature open-source STUN/TURN
server. Reusing this infrastructure gives AAFP:

- **Day-one reachability** without deploying a global relay fleet.
- **Battle-tested NAT classification** (STUN's RFC 5780 binding tests).
- **TURN as a fallback relay** when no AAFP-native relay is reachable.
- **A migration story** for WebRTC applications moving to AAFP.

### 2.2 The Layering

AAFP does not speak STUN/TURN on the wire directly for its primary transport
(STUN is a separate UDP protocol on port 3478, not QUIC). Instead, STUN/TURN
serves two roles:

```
┌─────────────────────────────────────────────────────────────────┐
│ AAFP Transport (QUIC + PQ-TLS + CBOR)                           │
├─────────────────────────────────────────────────────────────────┤
│ AAFP Relay (RFC 0010)        ← primary relay, QUIC-native       │
├─────────────────────────────────────────────────────────────────┤
│ AAFP AutoNAT (dial-back)     ← replaces STUN binding for AAFP   │
├─────────────────────────────────────────────────────────────────┤
│ STUN client (RFC 8489)       ← used only for endpoint discovery │
│ TURN client (RFC 8656)       ← fallback relay when no AAFP relay│
├─────────────────────────────────────────────────────────────────┤
│ UDP                                                           │
└─────────────────────────────────────────────────────────────────┘
```

**STUN's role:** When an agent boots and has no AAFP peers yet, it cannot run
AutoNAT dial-back (which requires a peer willing to dial back). A STUN binding
request to a public STUN server gives the agent its reflexive (public)
endpoint in one round trip with no AAFP-specific dependencies. This seeds the
`observed_addresses` table in `auto_nat_v1::AutoNatV1DialBack` before any AAFP
peer is reachable.

**TURN's role:** If DHT relay discovery (`relay_discovery`) returns zero
healthy AAFP relays, the agent falls back to a configured TURN server. TURN
allocates a relayed address on the TURN server; the agent advertises that
address as its relay multiaddr. The AAFP relay protocol (RFC 0010 §4) is
preferred because it is QUIC-native and carries PQ-TLS end-to-end, but TURN
guarantees connectivity in environments where no AAFP relay has been deployed
yet.

### 2.3 Rust Architecture Sketch

```rust
// crates/aafp-nat/src/stun.rs (proposed)

use aafp_transport_quic::QuicTransport;
use std::net::SocketAddr;

/// A STUN-obtained reflexive endpoint.
pub struct ReflexiveEndpoint {
    pub public_addr: SocketAddr,
    pub server: SocketAddr,
    pub obtained_at: Instant,
}

/// Minimal STUN client for endpoint discovery only.
/// Does NOT implement full RFC 5780 NAT classification — that is
/// AutoNAT's job via dial-back. STUN here is a bootstrap shortcut.
pub struct StunClient {
    servers: Vec<SocketAddr>,
}

impl StunClient {
    /// Query all configured STUN servers, return the most commonly
    /// reported reflexive address (majority vote to tolerate one
    /// misbehaving server).
    pub async fn discover_reflexive(&self) -> Option<ReflexiveEndpoint> { /* ... */ }
}

/// TURN fallback: allocates a relayed address when no AAFP relay is found.
pub struct TurnFallback {
    turn_servers: Vec<TurnServerConfig>,
    allocation: Option<TurnAllocation>,
}

impl TurnFallback {
    /// Called by RelayDiscovery when DHT lookup returns empty.
    /// Allocates a TURN relayed address and wraps it as an
    /// AAFP-compatible RelayNodeInfo so the rest of the stack
    /// is unaware it is talking to TURN, not an AAFP relay.
    pub async fn ensure_relay(&mut self) -> Option<RelayNodeInfo> { /* ... */ }
}
```

The key design rule: **STUN/TURN are pluggable backends behind AAFP-native
interfaces.** The rest of the stack sees `ReflexiveEndpoint` and
`RelayNodeInfo`, not STUN/TURN wire formats. This keeps the PQ-TLS and CBOR
framing layers pure while still leveraging existing infrastructure.

---

## 3. ICE-like Candidate Gathering for QUIC

### 3.1 The ICE Model, Adapted

WebRTC's ICE (RFC 8445) gathers three candidate types:

- **Host candidates:** local interface addresses.
- **Server-reflexive (srflx) candidates:** public endpoints learned via STUN.
- **Relay candidates:** addresses allocated on a TURN/relay server.

AAFP gathers the same three categories, but the "transport" is QUIC, not
bare ICE/DTLS. The adaptation:

```
ICE (WebRTC)                    AAFP (QUIC)
─────────────                   ───────────
Host candidate                  Local QUIC listen address
Srflx candidate                 AutoNAT/STUN observed address
Relay candidate                 AAFP relay multiaddr (p2p-circuit)
                                or TURN-allocated address
ICE connectivity checks         QUIC handshake = the check
ICE nomination                  First successful QUIC handshake wins
ICE restart                     QUIC connection migration (§10)
```

The crucial simplification: **QUIC's handshake *is* the connectivity check.**
There is no separate STUN binding-request ping phase. Each candidate pair is
tested by attempting a QUIC connection; the TLS handshake authenticates the
peer and the connection either succeeds or fails. This eliminates an entire
layer of ICE state machinery.

### 3.2 Candidate Gathering Sequence

```
Agent A wants to reach Agent B
│
├─ 1. Resolve B's AgentId via DHT → get B's advertised addresses
│     (host addrs, srflx addrs, relay multiaddrs)
│
├─ 2. Gather A's local candidates
│     ├─ Enumerate local interfaces → host candidates
│     ├─ Query STUN / request AutoNAT observe → srflx candidate
│     └─ Ensure relay reservation → relay candidate
│
├─ 3. Form candidate pairs (A_local × B_advertised)
│     Prioritize: host-host > srflx-srflx > relay-relay
│
├─ 4. Attempt QUIC handshakes in priority order (racing)
│     Each attempt = full QUIC connection with PQ-TLS
│     First to complete handshake wins; others are cancelled
│
└─ 5. Connection established
      If winner is a relay candidate → schedule DCuTR upgrade
```

### 3.3 Rust Architecture Sketch

```rust
// crates/aafp-nat/src/candidate_gathering.rs (proposed)

use aafp_identity::AgentId;
use aafp_transport_quic::QuicTransport;
use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub enum Candidate {
    /// Local interface address.
    Host { addr: SocketAddr },
    /// Public endpoint observed via STUN/AutoNAT.
    Srflx { addr: SocketAddr, source: String },
    /// Relay multiaddr (AAFP circuit or TURN).
    Relay { multiaddr: String, relay_id: AgentId },
}

impl Candidate {
    /// ICE-like priority: higher = preferred.
    pub fn priority(&self) -> u32 {
        match self {
            Candidate::Host { .. } => 126,
            Candidate::Srflx { .. } => 100,
            Candidate::Relay { .. } => 10,
        }
    }
}

pub struct CandidateGatherer {
    transport: QuicTransport,
    stun: Option<StunClient>,
    relay_discovery: RelayDiscoveryService,
}

impl CandidateGatherer {
    /// Gather all local candidates for this agent.
    pub async fn gather(&self) -> Vec<Candidate> {
        let mut candidates = Vec::new();
        // Host candidates: local interface addresses
        candidates.extend(self.local_host_candidates());
        // Srflx: STUN or AutoNAT observe
        if let Some(stun) = &self.stun {
            if let Some(ep) = stun.discover_reflexive().await {
                candidates.push(Candidate::Srflx {
                    addr: ep.public_addr,
                    source: format!("stun:{}", ep.server),
                });
            }
        }
        // Relay candidate
        if let Some(relay) = self.relay_discovery.best_relay().await {
            candidates.push(Candidate::Relay {
                multiaddr: relay.addr.clone(),
                relay_id: relay.agent_id,
            });
        }
        candidates.sort_by_key(|c| std::cmp::Reverse(c.priority()));
        candidates
    }

    /// Race QUIC handshakes against all candidate pairs.
    /// First successful handshake wins.
    pub async fn connect(
        &self,
        remote_candidates: &[Candidate],
    ) -> Result<QuicConnection, ConnectError> {
        let local = self.gather().await;
        let pairs = self.form_pairs(&local, remote_candidates);
        // Race all pairs; first to complete QUIC handshake wins.
        self.race_handshakes(pairs).await
    }
}
```

### 3.4 Why Not Full ICE?

Full ICE implements a stateful checker with frozen/waiting/in-progress/succeeded
states, triggered checks, and nomination. AAFP collapses this because:

1. **QUIC handles retransmission and authentication** — no need for STUN
   binding requests as liveness probes.
2. **AAFP's relay is always available** — ICE's aggressive nomination exists
   because TURN is expensive; AAFP treats relay as the default and DCuTR as
   the optimization, so there is no urgency to nominate a direct path.
3. **Connection migration (§10) handles path changes** — if a better path
   appears mid-connection, QUIC migrates rather than requiring an ICE restart.

The trade-off: AAFP's racing may open more simultaneous QUIC handshakes than
ICE's paced checks. This is acceptable because QUIC handshakes are cheap (1-RTT
with 0-RTT resumption) and the candidate count is small (typically 2-4 per
side).

---

## 4. Relay Node Design

### 4.1 The Relay's Role

An AAFP relay is an agent that volunteers to forward traffic between two NAT'd
agents. It is the QUIC-native equivalent of a TURN server. The relay
participates in the DHT and advertises the `relay` capability
(`relay_discovery::RELAY_CAPABILITY`).

```
   Agent A (NAT'd)              Relay R (public)            Agent B (NAT'd)
        │                            │                            │
        │  1. RESERVE (RPC)          │                            │
        │ ─────────────────────────► │                            │
        │  ◄──── reservation_id ──── │                            │
        │                            │                            │
        │                            │  2. B already has          │
        │                            │     a reservation          │
        │                            │                            │
        │  3. CONNECT (target=B)     │                            │
        │ ─────────────────────────► │                            │
        │  ◄──── connection_id ───── │                            │
        │                            │                            │
        │  4. open bi-stream,        │  5. relay opens bi-stream  │
        │     write 0xFF + conn_id   │     to B, writes 0xFE      │
        │ ─────────────────────────► │ ─────────────────────────► │
        │                            │                            │
        │  6. bidirectional byte-pipe: A ←→ R ←→ B               │
        │ ══════════════════════════ │ ══════════════════════════ │
```

### 4.2 Reservation Lifecycle (RFC 0010 §3)

A reservation is a time-bounded claim on relay capacity. It exists so that a
NAT'd agent can advertise a stable relay address in the DHT without an active
connection. The lifecycle:

```
   create ──► active ──► renew ──► active ──► expire
                 │                       │
                 └──► cancel ────────────┘
```

Implemented in `relay_v1::RelayV1Service` with `METHOD_RESERVE`,
`METHOD_RENEW`, `METHOD_CANCEL`. Defaults:

- `DEFAULT_MAX_RESERVATIONS = 100` per relay
- `DEFAULT_MAX_DURATION_SECS = 3600` (1 hour, renewable)
- `DEFAULT_MAX_CONNECTIONS = 50` concurrent relayed connections

### 4.3 Data Forwarding (RFC 0010 §4.2)

Once a `connect` RPC returns a `connection_id`, the caller opens a bidirectional
QUIC stream and writes a 9-byte header:

```
┌──────────┬──────────────────────────────┐
│ 0xFF     │ connection_id (u64 BE)       │
│ (1 byte) │ (8 bytes)                    │
└──────────┴──────────────────────────────┘
```

The relay reads this header, looks up the pending target stream, and from that
point forwards bytes verbatim in both directions. On the target side, the relay
opens a bi-stream with header `0xFE + connection_id`. The target reads the
header to identify the incoming relayed connection, then reads/writes
application data.

This is implemented in `relay_forwarding::RelayV1Server` and
`relay_forwarding::RelayV1TargetHandler`. The magic bytes
(`DATA_STREAM_MAGIC = 0xFF`, `INCOMING_STREAM_MAGIC = 0xFE`) distinguish
caller-initiated data streams from relay-initiated incoming streams on the
target side.

### 4.4 Relay Capacity and Fairness

A production relay must enforce:

- **Per-agent reservation limits** — prevent one agent from exhausting capacity.
- **Per-connection bandwidth caps** — `RelayNode.max_bps` in the legacy stub;
  the v1 service should enforce this in the forwarding loop.
- **Reservation expiry** — `RelayV1Service` must evict expired reservations
  (a background task scans `is_expired()`).
- **Connection duration limits** — `DEFAULT_MAX_DURATION_SECS` bounds how long
  a relayed connection can stay open without renewal.

```rust
// Sketch: bandwidth-limited forwarding in relay_forwarding
async fn forward_limited(
    mut from: QuicRecvStream,
    mut to: QuicSendStream,
    max_bps: u64,
) -> Result<u64, RelayV1Error> {
    let mut total = 0u64;
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = from.read(&mut buf).await?;
        if n == 0 { break; }
        to.write_all(&buf[..n]).await?;
        total += n as u64;
        if max_bps > 0 {
            let elapsed = Duration::from_secs_f64(n as f64 / max_bps as f64);
            tokio::time::sleep(elapsed).await;
        }
    }
    Ok(total)
}
```

### 4.5 Relay Discovery (RFC 0010 §9)

`relay_discovery::RelayDiscoveryService` finds relays by:

1. DHT lookup of the `relay` capability string.
2. Checking bootstrap nodes for relay advertisements.
3. Maintaining a cache (`DEFAULT_MAX_RELAYS = 5`).
4. Health-checking cached relays (`DEFAULT_HEALTH_CHECK_TIMEOUT_SECS = 5`).
5. Refreshing every `DEFAULT_REFRESH_INTERVAL_SECS = 300` (5 min).

`RelayNodeInfo` tracks latency, capacity, and utilization. The "best" relay is
selected by lowest latency among relays with capacity
(`has_capacity() && is_healthy()`).

---

## 5. AutoNAT Protocol (RFC 0010 §6)

### 5.1 The Problem AutoNAT Solves

An agent does not inherently know whether it is behind NAT. It can list its
local interface addresses, but it cannot tell whether those are reachable from
the public internet. AutoNAT answers this question empirically: *ask peers to
dial you back.*

### 5.2 Dial-Back Protocol

```
   Agent A (am I NAT'd?)        Peer P (public)
        │                            │
        │  OBSERVE request           │
        │ ─────────────────────────► │
        │  ◄── observed_addr ─────── │  (P reports A's remote addr)
        │                            │
        │  DIALBACK_REQUEST          │
        │  (advertised_addr = A's    │
        │   candidate public addr)   │
        │ ─────────────────────────► │
        │                            │  P attempts QUIC dial to
        │                            │  advertised_addr
        │  ◄── DialBackResult ────── │
        │      { success,            │
        │        observed_addr }     │
        │                            │
   A records result:
     success ≥ threshold → Public
     failure ≥ threshold → Private
```

Two RPC methods (defined in `auto_nat_v1`):

- `aafp.autonat.observe` (`METHOD_OBSERVE`): peer reports the remote address it
  sees for the requesting agent. No dial attempt — just observation.
- `aafp.autonat.dialback_request` (`METHOD_DIALBACK_REQUEST`): agent sends its
  advertised address; peer attempts a real QUIC dial and reports success/failure
  plus the observed address.

### 5.3 Status Determination

`AutoNatV1DialBack` accumulates results and flips status at
`DEFAULT_CONFIRMATION_THRESHOLD = 2`:

```rust
pub fn record_dialback(&mut self, result: &DialBackResult) {
    if result.success {
        self.successful_dialbacks += 1;
        if let Some(ref addr) = result.observed_addr {
            self.record_observed(addr.clone());
        }
    } else {
        self.failed_dialbacks += 1;
    }
    if self.successful_dialbacks >= self.confirmation_threshold {
        self.status = NatStatus::Public;
    } else if self.failed_dialbacks >= self.confirmation_threshold {
        self.status = NatStatus::Private;
    }
}
```

The threshold of 2 tolerates a single misbehaving peer (false success or false
failure). The observed addresses are aggregated by frequency
(`best_observed_address()` returns the most-reported one), which is robust
against a peer reporting a stale or spoofed address.

### 5.4 Advertising the Relay Address

Once AutoNAT concludes `Private`, the agent:

1. Runs `RelayDiscoveryService` to find a healthy relay.
2. Calls `aafp.relay.reserve` to obtain a reservation.
3. Publishes its relay multiaddr to the DHT as part of its `AgentRecord`.

```
AgentRecord {
    agent_id: A,
    addresses: [
        "quic://relay.example.com:4433/p2p/<relay_id>/p2p-circuit/<A>"
    ],
    capabilities: [...],
    ...
}
```

Other agents looking up A in the DHT see only the relay multiaddr and connect
through it. A's private address never needs to be advertised.

### 5.5 Re-probing

NAT status is not permanent. A laptop moving from home Wi-Fi (cone NAT) to
cellular (carrier-grade NAT, often symmetric) changes status. `AutoNat` (legacy
stub) tracks `probe_interval` (default 60s) and `needs_probe()` returns true
when the interval elapses. The v1 client should trigger re-probe on network
change events (see §10, connection migration).

---

## 6. DCuTR — Decentralized Hole Punching via Relay

### 6.1 The Upgrade Flow

DCuTR (Direct Connection Upgrade through Relay) takes an established relayed
connection and attempts to replace it with a direct one. The relay is used as a
signaling channel to exchange observed addresses, then both peers attempt
simultaneous QUIC dials.

```
   Agent A ←──relay──→ Agent B   (relayed connection active)
        │                  │
        │  CoordinateMsg   │  CoordinateMsg
        │  {observed: B's  │  {observed: A's
        │   addr from A,   │   addr from B,
        │   my_addr: A}    │   my_addr: B}
        │ ────via relay────► │ ────via relay────►
        │                  │
        │  both wait sync_delay (100ms) to align
        │                  │
        │  A dials B:my_addr   B dials A:my_addr
        │ ────────────────►   ◄─────────────────
        │                  │
        │  If either QUIC handshake succeeds:
        │     migrate to direct connection
        │     tear down relayed stream
        │  Else:
        │     keep relayed connection
```

### 6.2 Coordinate Message (RFC 0010 §7)

```cbor
{ 1: tstr, 2: tstr }
```
- key 1: `observed_addr` — the address this peer observes for the other (via
  the relayed connection's remote address).
- key 2: `my_addr` — the address this peer wants to be dialed at (its srflx
  candidate).

Implemented as `dcutr_v1::CoordinateMessage` with `encode()`/`decode()`.

### 6.3 Simultaneous Open

`DcutrV1::attempt_hole_punch` creates a temporary `QuicTransport`, waits
`sync_delay_ms` (default 100ms) to align with the peer's simultaneous attempt,
then dials with `timeout_secs` (default 10s). The sync delay is critical: both
peers must create the NAT mapping before either's dial arrives, so the
filtering rule is satisfied.

```rust
pub async fn attempt_hole_punch(&mut self, peer_addr: &str) -> HolePunchResult {
    let start = Instant::now();
    let timeout = Duration::from_secs(self.timeout_secs);
    let transport = QuicTransport::new(QuicConfig::default())?;
    // Align with peer's simultaneous open
    tokio::time::sleep(Duration::from_millis(self.sync_delay_ms)).await;
    let dial_result = tokio::time::timeout(timeout, transport.dial(peer_addr)).await;
    // ... map result to HolePunchResult
}
```

### 6.4 When DCuTR Is Skipped

`DcutrV1::classify_nat_type` returns `SymmetricNat` when observed addresses
vary across observations. The coordinator should disable DCuTR for that peer:

```rust
if matches!(nat_type, NatType::SymmetricNat) {
    dcutr.set_enabled(false);
    // relay stays the transport; no hole punch attempt
}
```

This avoids wasting 10 seconds on a hole punch that cannot succeed.

### 6.5 DCuTR Coordinator

`DcutrCoordinator` wraps the driver and provides the full protocol:

```rust
pub async fn run_hole_punch(
    &self,
    peer_observed_addr: String,
    peer_coordinate: &CoordinateMessage,
) -> HolePunchResult {
    let _my_msg = self.create_coordinate_message(peer_observed_addr);
    self.handle_coordinate_message(peer_coordinate).await
}
```

In production, `_my_msg` would be sent over the relayed control stream before
calling `run_hole_punch`. The coordinator records every attempt (capped at 50)
for diagnostics and success-rate metrics.

---

## 7. Mobile Network Considerations

### 7.1 Carrier-Grade NAT (CGNAT)

Most mobile networks deploy CGNAT — a single public IPv4 address shared across
thousands of subscribers. CGNAT is almost always symmetric (endpoint-dependent
mapping) at the subscriber-visible layer. Consequences:

- **Hole punching fails.** DCuTR will classify the peer as `SymmetricNat` and
  fall back to relay.
- **Relay is mandatory** for mobile-to-mobile and mobile-to-home connections.
- **Relay latency matters.** A relay on another continent doubles mobile RTT.
  `RelayDiscoveryService` must select by latency, and the network should
  naturally grow region-local relays as mobile agents join.

### 7.2 IP Address Changes

Mobile devices change IP frequently: Wi-Fi → cellular handoff, cell tower
transition, sleep/wake cycles that release the DHCP lease. AAFP handles this
via QUIC connection migration (§10), but the NAT layer must also:

- **Re-run AutoNAT on network change.** The new network may have different NAT
  behavior.
- **Re-reserve relay if the old reservation's advertised address is stale.**
  The relay multiaddr itself does not change (it points at the relay, not the
  agent), but the agent's binding to the relay may need re-establishment.
- **Publish updated AgentRecord** if the observed address changes.

```rust
// Sketch: network change handler in the SDK
async fn on_network_change(&mut self) {
    self.auto_nat.reset();
    self.auto_nat.probe().await;          // re-detect NAT status
    if self.auto_nat.is_behind_nat() {
        self.relay_service.renew_reservation().await;
    }
    self.publish_agent_record().await;    // update DHT
    // QUIC connection migration handles in-flight connections (§10)
}
```

### 7.3 Battery

Mobile agents must minimize radio wake time. NAT traversal is inherently
chatty (dial-backs, hole punches, relay heartbeats). Mitigations:

- **Batch AutoNAT probes.** Rather than probing every 60s, align probes with
  existing connection activity. If the agent already has an open connection,
  piggyback an `observe` request on it.
- **Long relay reservation durations.** `DEFAULT_MAX_DURATION_SECS = 3600`
  means one renewal per hour, not per minute. Renewals can be aligned with
  other traffic.
- **Avoid aggressive DCuTR retries.** If a hole punch fails, do not retry every
  30s — the NAT type has not changed. Retry on network change events only.
- **0-RTT resumption.** QUIC 0-RTT lets a mobile agent resume a connection in
  a single datagram, minimizing radio time for reconnection.

### 7.4 Doze / App Suspend

When a mobile OS suspends the app, the QUIC connection dies. On wake:

1. QUIC attempts path validation on the old connection ID (may still work if
   the OS preserved the socket and the NAT mapping has not expired).
2. If path validation fails, initiate connection migration with a new path.
3. If the peer is unreachable directly, reconnect via relay.

The relay reservation should persist across suspend/resume (the relay holds it
for up to `max_duration_secs`). The agent only needs to re-establish the
relayed *connection*, not the reservation.

---

## 8. IPv6 Deployment

### 8.1 The Good News

IPv6 has no NAT in the normal case. Every device gets a globally routable
address (via SLAAC or DHCPv6). For AAFP this means:

- **No NAT traversal needed on IPv6.** Host candidates are directly reachable.
- **AutoNAT on IPv6 almost always returns Public.**
- **DCuTR is unnecessary** — direct QUIC works.

### 8.2 Dual-Stack

AAFP agents should bind both IPv4 and IPv6 sockets and advertise both address
families. The DHT stores all advertised addresses; candidate gathering
(§3) includes both. QUIC's racing naturally prefers whichever path completes
first; on dual-stack networks, IPv6 usually wins (no NAT, lower latency).

```rust
// Sketch: dual-stack listen
let v4 = QuicTransport::bind("0.0.0.0:4433").await?;
let v6 = QuicTransport::bind("[::]:4433").await?;
// Advertise both in AgentRecord
record.addresses = vec![
    format!("quic://{}", v4.local_addr()?),
    format!("quic://{}", v6.local_addr()?),
];
```

### 8.3 IPv6-Only with NAT64

Some mobile carriers (T-Mobile US, Reliance Jio) are IPv6-only with NAT64
(RFC 6146) providing IPv4 reachability via DNS64 synthetic AAAA records. AAFP
agents on such networks:

- **Can reach IPv6 peers directly** — no relay needed.
- **Cannot reach IPv4-only peers directly** — the NAT64 gateway maps the
  agent's IPv6 source to an IPv4 address, but the mapping is typically
  symmetric (per-destination), so hole punching fails.
- **Need a dual-stack relay** to bridge to IPv4-only agents. The relay has
  both IPv4 and IPv6 connectivity; the IPv6-only agent connects to the relay
  over IPv6, and the relay connects to the IPv4-only agent over IPv4.

```
   IPv6-only Agent A          Dual-stack Relay R         IPv4-only Agent B
        │ (IPv6)                    │ (IPv4 + IPv6)            │ (IPv4)
        │ ════════════════════════ │ ════════════════════════ │
        │  QUIC over IPv6           │  QUIC over IPv4          │
```

This is the same relay architecture as NAT traversal — the relay is
network-topology-agnostic. The only requirement is that relays deploy in
dual-stack mode, which is the default recommendation.

### 8.4 Happy Eyeballs

For dual-stack peers, AAFP should implement a Happy Eyeballs (RFC 8305)
strategy in candidate racing: attempt IPv6 first, fall back to IPv4 after a
short delay (250ms) if IPv6 does not connect. This avoids the 300-second IPv6
black-hole timeout on broken dual-stack networks.

---

## 9. Firewall Traversal

### 9.1 The Problem

Corporate and cloud firewalls often block outbound UDP entirely, or allow only
specific ports. QUIC runs over UDP, so a firewall blocking UDP blocks AAFP's
primary transport.

### 9.2 QUIC over Port 443

The simplest mitigation: run AAFP QUIC on UDP port 443. Many firewalls allow
outbound UDP/443 because QUIC (HTTP/3) is now mainstream. This is not
guaranteed — some firewalls do deep packet inspection and block non-HTTP/3
QUIC — but it covers a large fraction of corporate networks.

```rust
let config = QuicConfig {
    bind_addr: "0.0.0.0:443".parse()?,
    ..Default::default()
};
```

### 9.3 WebTransport as Fallback

For firewalls that block all UDP, AAFP needs a TCP-based fallback. The natural
choice is **WebTransport over HTTP/3** (RFC 9220) when UDP is available, or
**WebTransport over HTTP/2** (RFC 8441-style) when only TCP is available.

WebTransport provides a multiplexed, secure stream abstraction over HTTP/3
(QUIC) or HTTP/2 (TCP). From AAFP's perspective, it is an alternative
`Transport` implementation with the same `dial`/`accept`/`open_bi_stream`
interface as `QuicTransport`.

```
┌─────────────────────────────────────────────────┐
│ AAFP Messaging (frames, RPC, streams)           │
├─────────────────────────────────────────────────┤
│ Transport trait                                  │
├──────────────┬──────────────┬───────────────────┤
│ QuicTransport│ WebTransport │ WebTransport      │
│ (UDP/4433)   │ (HTTP/3)     │ (HTTP/2, TCP/443) │
├──────────────┴──────────────┴───────────────────┤
│ UDP           │ UDP           │ TCP              │
└──────────────┴──────────────┴───────────────────┘
```

The fallback chain:

1. **QUIC on UDP/4433** (primary, full performance).
2. **QUIC on UDP/443** (firewall-friendly, full performance).
3. **WebTransport over HTTP/3** (if UDP/443 is blocked but QUIC-as-HTTP/3
   passes DPI — same UDP, different framing).
4. **WebTransport over HTTP/2** (TCP-only environments, higher latency due to
   TCP head-of-line blocking but connectivity guaranteed).
5. **Relay** (if the agent cannot establish any direct transport, route through
   a relay that *can* use one of the above).

### 9.4 Rust Architecture Sketch

```rust
// crates/aafp-transport-webtransport (proposed)

use aafp_core::transport::Transport;

pub struct WebTransportH3 {
    // wtransport crate: WebTransport over HTTP/3
}

pub struct WebTransportH2 {
    // webtransport-h2 crate or custom: WebTransport over HTTP/2
}

impl Transport for WebTransportH3 { /* ... */ }
impl Transport for WebTransportH2 { /* ... */ }

// crates/aafp-nat/src/fallback.rs (proposed)
pub struct FirewallTraversal {
    strategies: Vec<TransportStrategy>,
}

impl FirewallTraversal {
    /// Try each strategy in order; first that connects wins.
    pub async fn connect(&self, addr: &str) -> Result<Box<dyn Transport>, Error> {
        for strategy in &self.strategies {
            if let Ok(t) = strategy.try_connect(addr).await {
                return Ok(t);
            }
        }
        Err(Error::AllStrategiesFailed)
    }
}
```

### 9.5 DPI Evasion Considerations

AAFP does not attempt to disguise its traffic. The protocol is designed for an
open agent internet, not for circumventing censorship. Port 443 and
WebTransport are about *interoperability with mainstream network policy*, not
evasion. Agents that need censorship resistance should tunnel AAFP over an
external VPN/Tor — that is outside the protocol's scope.

---

## 10. Multi-Homing

### 10.1 Multiple Addresses per Agent

An agent may be reachable via multiple addresses simultaneously: a home Wi-Fi
address, a VPN address, a relay multiaddr, an IPv6 address. All are advertised
in the `AgentRecord` and considered during candidate gathering (§3).

```
AgentRecord for Agent A:
  addresses:
    - quic://192.168.1.50:4433          (home LAN, host candidate)
    - quic://[2001:db8::1]:4433         (IPv6, host candidate)
    - quic://203.0.113.5:4433           (srflx via STUN)
    - quic://relay.example.com:4433/
        p2p/<relay>/p2p-circuit/<A>     (relay candidate)
```

### 10.2 Preference and Reachability

Not all advertised addresses are useful to all peers. A peer on the same LAN
can use the `192.168.1.50` address; a remote peer cannot. The candidate
gathering logic forms pairs and races them; the unreachable ones simply fail
the QUIC handshake and are pruned.

To avoid advertising private addresses globally (which leaks topology and
wastes peer candidate slots), AAFP should tag addresses with scope:

```rust
pub enum AddrScope {
    /// Link-local / private (RFC 1918, fc00::/7). Useful only on same network.
    Local,
    /// Globally routable. Useful to any peer.
    Global,
    /// Relay multiaddr. Useful to any peer but routes through relay.
    Relay,
}
```

Private addresses are advertised only to peers known to be on the same network
(determined by observing that the peer's connection comes from a private
address in the same range). Globally, only srflx, IPv6, and relay addresses are
published.

---

## 11. Connection Migration (QUIC Connection ID Rotation)

### 11.1 The QUIC Feature

QUIC connections are identified by a *connection ID* (CID), not by the 4-tuple
(source IP, source port, dest IP, dest port). When a mobile device changes
network (Wi-Fi → cellular), the 4-tuple changes but the CID does not. The peer
sees packets arriving from a new address with the same CID and can *migrate*
the connection to the new path after validating it.

This is the single most important feature QUIC provides for AAFP's mobile
story: **connections survive network changes without re-handshake.**

### 11.2 Migration Sequence

```
   Agent A (Wi-Fi: 192.168.1.50)        Peer B
        │                                  │
        │  QUIC CID = 0xA1B2C3...          │
        │ ════════════════════════════════ │
        │                                  │
   A switches to cellular (203.0.113.99)  │
        │                                  │
        │  packet from new 4-tuple,        │
        │  same CID 0xA1B2C3...            │
        │ ──────────────────────────────── ►│
        │                                  │
        │                                  │  B sees new path,
        │                                  │  sends PATH_CHALLENGE
        │  ◄── PATH_CHALLENGE ──────────── │
        │  ── PATH_RESPONSE ──────────────► │
        │                                  │  B validates path,
        │                                  │  migrates to new 4-tuple
        │ ════════════════════════════════ │
        │  connection continues,           │
        │  no re-handshake                 │
```

### 11.3 CID Rotation for Privacy

QUIC also supports CID rotation: the peer changes the CID mid-connection so
that an observer cannot correlate packets across the rotation point. This
makes passive traffic analysis harder. AAFP should enable CID rotation by
default (quinn supports this via `Endpoint` configuration).

### 11.4 NAT Layer Interaction

Connection migration handles the *transport* layer. The *NAT* layer must also
adapt:

1. **AutoNAT re-probe.** The new network may have different NAT behavior. A
   `Private` agent on Wi-Fi may become `Public` on IPv6 cellular, or vice
   versa.
2. **Relay reservation.** If the agent was relayed and the new network changes
   the agent's ability to reach the relay, the reservation may need renewal
   (the relay multiaddr is unchanged, but the agent's connection to the relay
   must be re-established, possibly via migration).
3. **DCuTR re-attempt.** A connection that was relayed because of symmetric NAT
   on Wi-Fi may become directly connectable on IPv6 cellular. After migration,
   schedule a DCuTR attempt on the new path.

```rust
// Sketch: post-migration hook
async fn on_path_validated(&mut self, new_addr: SocketAddr) {
    // Re-probe NAT status on the new path
    if self.auto_nat.needs_probe() {
        let _ = self.auto_nat.probe_on_new_path(new_addr).await;
    }
    // If now public and was relayed, attempt DCuTR upgrade
    if self.auto_nat.is_public() && self.relay_service.is_relayed() {
        self.dcutr.schedule_upgrade().await;
    }
    // Update advertised addresses if observed address changed
    self.publish_agent_record().await;
}
```

### 11.5 Rust Architecture Sketch

```rust
// crates/aafp-transport-quic/src/migration.rs (proposed)

use quinn::Connection;

pub struct MigrationManager {
    connection: Connection,
    current_path: Option<SocketAddr>,
    migration_count: u64,
}

impl MigrationManager {
    /// Called when the QUIC stack reports a path change.
    pub async fn on_path_change(&mut self, new_addr: SocketAddr) {
        tracing::info!(
            "QUIC path change: {:?} → {:?} (migration #{})",
            self.current_path, new_addr, self.migration_count + 1
        );
        self.current_path = Some(new_addr);
        self.migration_count += 1;
        // Notify NAT layer to re-probe
        self.notify_nat_layer(new_addr).await;
    }

    /// Force a CID rotation for privacy.
    pub fn rotate_cid(&self) {
        // quinn does not expose this directly; would require
        // a custom QUIC implementation or a patch to quinn.
        // For now, rely on quinn's default rotation policy.
    }
}
```

---

## 12. Putting It All Together: The Connection Lifecycle

```
Agent A boots
│
├─ 1. Bind QUIC on UDP/4433 (and 443 if configured)
├─ 2. Gather candidates
│     ├─ Host: local interfaces (IPv4 + IPv6)
│     ├─ Srflx: STUN binding → public endpoint
│     └─ Relay: DHT lookup of "relay" capability → reserve
│
├─ 3. Run AutoNAT
│     ├─ Send OBSERVE to bootstrap peers
│     ├─ Send DIALBACK_REQUEST to 2+ peers
│     └─ Determine status: Public / Private
│
├─ 4. Publish AgentRecord to DHT
│     ├─ If Public: advertise host + srflx addresses
│     └─ If Private: advertise relay multiaddr only
│
├─ 5. Accept incoming connections (if serving)
│     └─ QUIC handshake on any advertised address
│
├─ 6. Initiate outgoing connections
│     ├─ Resolve target AgentId → AgentRecord
│     ├─ Gather candidate pairs (local × remote)
│     ├─ Race QUIC handshakes (ICE-like)
│     └─ First successful handshake wins
│
├─ 7. If connection is relayed → schedule DCuTR
│     ├─ Exchange CoordinateMessage via relay
│     ├─ Classify peer NAT type
│     ├─ If ConeNat: attempt simultaneous open
│     └─ If success: migrate to direct connection
│
├─ 8. During connection lifetime
│     ├─ QUIC connection migration on network change
│     ├─ CID rotation for privacy
│     └─ Re-probe AutoNAT on network change
│
└─ 9. On shutdown
      ├─ Cancel relay reservation
      └─ Close QUIC connections gracefully (CLOSE frame)
```

---

## 13. Open Questions and Future Work

### 13.1 Relay Incentives

Why would an agent volunteer to be a relay? The strategic vision mentions an
economic layer (Phase 7). Before that, relay operation should be:

- **Default-on for public agents.** An agent that AutoNAT determines is
  `Public` should automatically offer relay capacity (with configurable limits)
  so the network has relays without explicit deployment.
- **Capability-gated.** Only agents with spare bandwidth and uptime advertise
  the `relay` capability. The adaptive routing plane (Track T) will eventually
  factor relay load into routing decisions.

### 13.2 Relay Chaining

This document assumes a single relay hop. For deeply nested NAT scenarios
(agent behind CGNAT behind carrier NAT), relay chaining (A → R1 → R2 → B) may
be needed. This is not in RFC 0010 and is left for future work. The
`p2p-circuit` multiaddr format supports nesting in principle.

### 13.3 STUN as a First-Class Crate

The `stun.rs` sketch in §2.3 should become a real crate (`aafp-stun`) or a
module within `aafp-nat`. It needs only binding requests (RFC 8489) for
reflexive endpoint discovery — full NAT classification (RFC 5780) is AutoNAT's
job. A minimal implementation is ~300 lines.

### 13.4 WebTransport Crate

The `aafp-transport-webtransport` crate (§9.3) is the firewall-traversal
fallback. It depends on the `wtransport` crate (or equivalent) for HTTP/3
WebTransport and a custom implementation for HTTP/2 WebTransport. This is a
Phase 2 deliverable alongside WAN testing.

### 13.5 Empirical NAT Distribution

The design assumes symmetric NAT is common enough to matter (especially on
mobile). Real-world testing (Track O) should measure the actual distribution of
NAT types encountered by AAFP agents. If 90% are cone NAT, DCuTR's value is
enormous; if 90% are symmetric, relay optimization becomes the priority.

### 13.6 Relay Authentication

RFC 0010 does not specify whether relays must authenticate agents. Current
stubs do not enforce authentication on relay reservations. Production relays
should require a valid AAFP handshake (PQ-TLS + UCAN) before accepting
reservations, to prevent abuse. The relay's `RelayV1Service` should integrate
with the SDK's session enforcement (no unauthenticated code path).

---

## 14. Cross-Reference to Existing Code

| Concept | Module | Key Type/Function |
|---------|--------|-------------------|
| NAT status (legacy) | `auto_nat.rs` | `AutoNat`, `NatStatus` |
| NAT status (v1) | `auto_nat_v1.rs` | `AutoNatV1DialBack`, `AutoNatClient` |
| Dial-back RPC | `auto_nat_v1.rs` | `encode_dialback_request`, `perform_dialback` |
| Observe RPC | `auto_nat_v1.rs` | `encode_observe_request`, `handle_observe_request` |
| Relay config (legacy) | `relay.rs` | `RelayConfig`, `RelayNode`, `RelayService` |
| Relay reservation (v1) | `relay_v1.rs` | `Reservation`, `ReserveParams`, `ReserveResult` |
| Relay RPC methods | `relay_v1.rs` | `METHOD_RESERVE`, `METHOD_RENEW`, `METHOD_CANCEL`, `METHOD_CONNECT` |
| Relay forwarding | `relay_forwarding.rs` | `RelayV1Server`, `RelayV1CallerHelper`, `RelayV1TargetHandler` |
| Relay discovery | `relay_discovery.rs` | `RelayDiscoveryService`, `RelayNodeInfo`, `RELAY_CAPABILITY` |
| DCuTR (legacy) | `dcutr.rs` | `Dcutr`, `UpgradeResult` |
| DCuTR (v1) | `dcutr_v1.rs` | `DcutrV1`, `DcutrCoordinator`, `CoordinateMessage` |
| NAT type classification | `dcutr_v1.rs` | `NatType`, `DcutrV1::classify_nat_type` |
| Hole punch attempt | `dcutr_v1.rs` | `DcutrV1::attempt_hole_punch`, `attempt_hole_punch_with_config` |

---

## 15. Summary

AAFP's NAT traversal strategy is a layered fallback:

1. **Direct QUIC** when the agent is public (AutoNAT confirms).
2. **DCuTR hole punch** when both peers are behind cone NAT (upgrade from
   relayed).
3. **Relay** when direct and hole punch both fail (symmetric NAT, CGNAT,
   firewall). This is the default for the majority of real-world agents.
4. **WebTransport fallback** when UDP is blocked entirely (corporate
   firewalls).
5. **QUIC connection migration** to survive network changes without
   reconnection.

The design reuses WebRTC's STUN/TURN infrastructure for bootstrap and
fallback, adapts ICE's candidate gathering to QUIC (where the handshake *is*
the connectivity check), and treats the relay not as a failure mode but as the
primary transport for NAT'd agents — with DCuTR as a physics-permitting
optimization.

The existing `aafp-nat` crate contains RFC 0010-compliant implementations of
relay, AutoNAT, and DCuTR. The gaps for production WAN deployment are:
STUN client (`aafp-stun`), WebTransport transport
(`aafp-transport-webtransport`), candidate gathering orchestration
(`candidate_gathering.rs`), firewall fallback chaining (`fallback.rs`), and
connection migration hooks (`migration.rs`). These are the concrete deliverables
that move AAFP from "works on localhost" to "works on the real internet."
