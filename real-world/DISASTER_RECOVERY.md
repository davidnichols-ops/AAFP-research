# AAFP Disaster Recovery & High Availability

**Author:** Research synthesis
**Date:** 2026-07-05
**Status:** Reference document for production DR design
**Related RFCs:** RFC 0001 (Transport), RFC 0002 (Handshake), RFC 0009 (Identity/PKI),
RFC 0010 (Circuit Relay, AutoNAT, DCuTR), RFC 0011 (DHT Discovery)
**Related crates:** `aafp-transport-quic`, `aafp-discovery`, `aafp-nat`, `aafp-identity`,
`aafp-sdk`
**Related docs:** `NAT_TRAVERSAL_NETWORKING.md`, `docs/OPERATIONS.md`,
`ADAPTIVE_ROUTING_PLANE.md`, `NORTH_STAR.md`

---

## 0. Why This Document Exists

AAFP's strategic vision is explicit: *"You cannot build an agent operating system on a
protocol that has never touched the real internet."* The real internet loses packets,
drops connections, partitions networks, crashes processes, and occasionally compromises
certificates. A deployment that cannot survive these events is a demo, not a product.

This document is the disaster-recovery (DR) and high-availability (HA) field guide for
AAFP. It maps the protocol's primitives — QUIC connection migration, Kademlia DHT
replication, circuit-relay reservations, UCAN-derived identity, attestation storage —
onto the failure modes a production fleet actually encounters, and specifies the
recovery procedures, time/objective targets, and operational runbooks that turn those
primitives into a resilient system.

The guiding principle, drawn from `NORTH_STAR.md` §1.5, is that **the wire protocol is
frozen (Rev 6) and resilience logic lives above it**. DR is not a protocol feature; it
is an operational discipline built on top of stable transport, discovery, and identity
layers. Where the protocol provides a hook (e.g., session resumption, DHT refresh,
relay reservation TTL), this document specifies how an operator uses it. Where the
protocol is silent (e.g., checkpointing, hot standby), this document specifies the
implementation-level pattern that should be standardized across deployments.

**Scope:** agent crash recovery, connection recovery, DHT partition healing, relay
failover, multi-region deployment, hot standby, checkpointing, data durability, failure
modes, RTO/RPO targets, chaos engineering, and a concrete DR runbook for a 100-agent
production deployment.

**Non-goals:** application-level transaction semantics, cross-agent consensus (that is
the future Execution Fabric), or backup/restore of off-platform data stores (e.g., a
vector DB backing an agent). Those are workload concerns layered on top of AAFP's
transport-and-discovery guarantees.

---

## 1. AAFP's Resilience Substrates

Before describing recovery procedures, this section inventories the protocol primitives
that DR builds on. Every recovery mechanism in this document is a composition of these
substrates; nothing here requires new wire-format changes.

### 1.1 Transport (QUIC + PQ-TLS + CBOR)

| Substrate | Source | DR relevance |
|-----------|--------|--------------|
| QUIC connection migration | RFC 9000 §9, `aafp-transport-quic` | Survives IP/port change without tearing down the connection |
| 0-RTT session resumption | Track I, `transport.rs:76-116` | Sub-millisecond reconnect after migration failure (607x speedup for pooled connections) |
| Connection pool + keep-alive | Track I | Repeated RPCs 17x faster; idle connections kept warm |
| Stream multiplexing | QUIC native | One connection carries many in-flight RPCs; loss of one stream does not kill the connection |
| PQ-TLS (ML-DSA-65) | Track A, P | Forward-secret channel; post-quantum identity |
| Replay cache | RFC 0002 | 0-RTT replay protection across reconnections |

The single most important transport fact for DR: **QUIC connection migration is the
first line of defense, and reconnect-with-resumption is the fallback.** Track O6
measured a 76% failure rate on hard handoffs (Wi-Fi→cellular) because quinn's passive
migration detection does not always rebind in time. The documented fallback
(`test-results/interop/wan-connection-migration.json`) is: detect migration failure,
close the broken connection, re-dial with TLS session resumption. This provides
sub-millisecond reconnection after migration failure and is the basis for the
RTO < 5s connection-recovery target in §10.

### 1.2 Discovery (Kademlia DHT)

| Substrate | Source | DR relevance |
|-----------|--------|--------------|
| 256-bit SHA-256 keyspace, 256 k-buckets | Track R | O(log N) lookups; scales to 500+ nodes verified |
| Routing table k=20 | Track R | Up to 5120 peers in routing state |
| Record replication k=5 closest peers | Track R, `DhtRouter::republish_own_record()` | Records survive loss of up to 4 of 5 replicas |
| Iterative lookup, α=3 concurrency | Track R | Parallel lookups; resilient to slow peers |
| Adaptive TTL | Track E5 | Record freshness extended by recent heartbeats |
| SQLite persistence | NORTH_STAR §3 | DHT records persist across process restart |
| Refresh / republish | Track R3 | Re-announces own record before TTL expiry |
| Partition detection + reconciliation | Track R6 | Split-brain prevention, latest-timestamp-wins merge |
| Churn handling (ping liveness, graceful depart) | Track R4 | 3 missed pings → peer marked offline |

The DHT is the system of record for *agent presence and capability*, not for agent
state. This distinction drives the entire DR model: an agent's identity, capabilities,
and attestations are durable and replicated; an agent's in-memory working state is not,
unless the operator layers checkpointing on top (§7).

### 1.3 Identity & Trust (UCAN + WoT + CA)

| Substrate | Source | DR relevance |
|-----------|--------|--------------|
| Ed25519 / ML-DSA-65 agent keys | Track P, A | Self-sovereign identity; keys are the agent |
| UCAN capability delegations | RFC 0009 | Delegated authority survives delegator outage |
| Web of Trust (WoT) | Track P | Decentralized trust; no single CA dependency |
| CA issuance + rotation + revocation | Track P | `TrustManager` handles cert lifecycle |
| Attestation store (separate DHT namespace) | Track E5 | Third-party reputation persists independently of agent liveness |

Identity is the *immutable boundary*. An agent's `AgentId` is derived from its keys; the
keys are the recovery token. Lose the keys and you lose the identity, regardless of how
much DHT state survives. This makes **key custody the single highest-stakes DR concern**
(see §8.5 and §9.5).

### 1.4 NAT Traversal & Relay (RFC 0010)

| Substrate | Source | DR relevance |
|-----------|--------|--------------|
| Circuit relay v2 (QUIC-native) | RFC 0010 §2-5 | Connectivity when direct dial fails |
| Relay reservation TTL (`DEFAULT_MAX_DURATION_SECS = 3600`) | RFC 0010 | Reservations persist across suspend/resume |
| Relay discovery via DHT `relay` capability | `relay_discovery.rs` | Agents find healthy relays dynamically |
| Relay health checks (`has_capacity() && is_healthy()`) | `relay_discovery.rs` | Failover signal |
| AutoNAT dial-back | RFC 0010 §6 | Agent learns its own NAT status |
| DCuTR coordinate + simultaneous open | RFC 0010 §7 | Upgrade relayed → direct when possible |
| TURN fallback | `NAT_TRAVERSAL_NETWORKING.md` §2.2 | Connectivity when no AAFP relay is deployed |

The relay layer is the connectivity safety net. DR for relays (§5) is about ensuring
that safety net itself is highly available.

---

## 2. Agent Crash Recovery

### 2.1 The Crash Scenario

An agent process terminates unexpectedly (OOM kill, segfault, host reboot, scheduler
eviction). At the moment of crash the agent held:

- In-memory working state (conversation context, in-flight tasks, cached DHT lookups).
- One or more QUIC connections to peers and relays.
- A DHT routing table and replicated records stored locally (SQLite).
- Possibly a relay reservation.
- Possibly UCAN delegations it had issued to others.

Recovery must reconstruct enough of this to resume operation, or hand off to a standby
(§6).

### 2.2 State Reconstruction Sources

AAFP distinguishes three classes of state by their recoverability:

| State class | Stored where | Recoverable? | Mechanism |
|-------------|--------------|--------------|-----------|
| **Identity & capability** (AgentRecord, keys) | Local keystore + DHT (k=5 replicas) | Yes, fully | Re-load keys from keystore; re-publish AgentRecord to DHT |
| **Reputation** (attestations about this agent) | DHT attestation namespace (k=5 replicas) | Yes, fully | Re-fetch attestations by subject AgentId prefix scan |
| **Connectivity** (routing table, peer addresses) | DHT + PEX peer exchange | Yes, eventually | Re-bootstrap from seed peers; PEX repopulates routing table |
| **Working state** (tasks, conversation, caches) | In-memory only (v1) | **No, unless checkpointed** | See §7; v1 = lost on crash |
| **In-flight RPCs** | In-memory only | No | Caller's retry policy (§3.4) handles re-issue |

The critical design choice: **AAFP v1 makes no protocol-level guarantee about working
state durability.** An agent that crashes loses in-flight tasks. Callers detect this via
connection loss and re-issue via retry-with-backoff (§3.4). Long-running agents that
cannot tolerate this must use checkpointing (§7), which is an application-layer
discipline the protocol does not mandate but this document standardizes.

### 2.3 Crash Recovery Procedure (Single Agent)

1. **Process restart.** The supervisor (systemd, k8s, supervisord) restarts the agent
   binary. Target: process back up in < 2s.
2. **Keystore load.** Agent loads its Ed25519/ML-DSA-65 keypair from the local keystore
   (encrypted at rest, see §8.5). Without keys, the agent cannot prove its identity.
3. **DHT bootstrap.** Agent connects to configured seed peers and bootstraps its routing
   table. PEX peer exchange accelerates repopulation. Target: routing table usable in
   < 5s.
4. **AgentRecord re-publish.** Agent calls `DhtRouter::republish_own_record()` to
   re-announce its AgentRecord to the k=5 closest peers. Even if the old record had not
   yet expired (adaptive TTL), re-publishing refreshes it and signals liveness.
5. **Attestation re-fetch.** Agent fetches attestations where it is the subject
   (`get_attestations(subject = self)`). These were stored by *other* agents and survive
   this agent's crash.
6. **Relay reservation re-establishment.** If the agent was behind NAT, it re-requests a
   relay reservation (RFC 0010 §3). The old reservation expired on crash; the relay's
   reservation TTL was at most 3600s.
7. **Inbound connection re-acceptance.** Agent begins listening on its transport.
   Callers that lost their connection will reconnect (§3).
8. **Working state reconstruction (if checkpointed).** If the agent persisted
   checkpoints (§7), it loads the latest snapshot and resumes. Otherwise it starts
   stateless.

### 2.4 What Callers See During a Crash

A caller with an open connection to the crashed agent experiences:

1. QUIC connection enters draining/close (the peer stopped responding to keep-alives).
2. In-flight streams fail with a connection-closed error.
3. The caller's retry policy (§3.4) kicks in: exponential backoff + full jitter.
4. The caller re-resolves the agent via DHT lookup. While the agent is down, the lookup
   may still return its record (TTL not yet expired) but direct dial and relay dial
   both fail.
5. Once the agent restarts and re-publishes, the next DHT lookup returns a reachable
   address and the caller reconnects.

The window during which the caller sees failures is bounded by: crash detection
(keep-alive timeout, typically 2-3x the keep-alive interval) + agent restart time +
re-publish time. With the targets in §10, this is < 30s for agent failover.

---

## 3. Connection Recovery

### 3.1 The Two Failure Classes

Connection loss falls into two classes with different recovery paths:

| Class | Example | Recovery |
|-------|---------|----------|
| **Path change** (endpoints alive, path changed) | Wi-Fi→cellular handoff, NAT rebinding | QUIC connection migration (preferred) → reconnect+resumption (fallback) |
| **Peer loss** (endpoint dead) | Agent crash, relay crash, host down | Reconnect+resumption to same peer after restart, or failover to standby (§6) |

### 3.2 QUIC Connection Migration (Path Change)

QUIC (RFC 9000 §9) allows a connection to survive a change in the client's IP/port
without tearing down, because the connection is identified by a connection ID (CID),
not by the 4-tuple. `quinn` (the QUIC library AAFP uses) handles this at the transport
layer: when a packet arrives from a new path with a valid CID, quinn can migrate the
connection to the new path.

**Known limitation (Track O6):** passive migration detection has a 76% failure rate on
hard handoffs (Wi-Fi→cellular) because the new path's first packets may arrive before
quinn validates the path change, or the old path's NAT mapping expires mid-handoff. The
documented mitigation is **active migration initialization** plus the reconnect fallback
below.

**Recommended configuration:**
- Enable quinn's connection migration (CID rotation, path validation per RFC 9000 §9.3).
- Implement a draining period on the old path so in-flight packets are not lost.
- Treat migration failure as a trigger for the reconnect fallback, not a fatal error.

### 3.3 Reconnect with Session Resumption (Fallback)

When connection migration fails or the peer was lost and has restarted, AAFP falls back
to a fresh QUIC connection that reuses the TLS session ticket for 0-RTT resumption
(Track I, `transport.rs:76-116`). Measured benefit: **607x speedup for pooled
connections** vs. full handshake, because the PQ-TLS handshake (ML-DSA-65 signature
verification is ~1ms per operation) is skipped.

The reconnect sequence:
1. Detect connection failure (stream error, keep-alive timeout, or migration failure).
2. Close the broken connection (draining state, do not leak CIDs).
3. Look up the peer's current address via DHT (the record may have been re-published
   with a new address after a restart).
4. Open a new QUIC connection with 0-RTT session resumption.
5. Replay the replay-cache-protected RPCs that were in flight (the replay cache
   prevents nonce reuse across reconnections, RFC 0002).
6. Resume the connection pool entry.

This is the mechanism that delivers the **RTO < 5s for connection recovery** target
(§10). The dominant cost is one network RTT to the peer (0-RTT eliminates the handshake
RTT) plus DHT lookup latency (< 100ms for < 100 nodes per the DHT scale report).

### 3.4 Retry Policy (Caller-Side)

For RPCs that fail due to connection loss, the caller applies the resilience layer
specified in `AR_T3_T4_BREAKER_HEDGING.md`:

- **Exponential backoff with full jitter:** `delay = base * multiplier^attempt`, with
  full jitter (random within `[0, delay]`) to avoid thundering herd. Default base=100ms,
  multiplier=2.0, cap=5s.
- **Circuit breaker (3-state):** closed → open after N consecutive failures → half-open
  probe. Prevents a caller from hammering a down peer.
- **Bulkhead:** limit concurrent in-flight requests per peer so one slow peer does not
  exhaust the caller's connection pool.
- **Request hedging (optional):** for latency-sensitive RPCs, issue a second request
  after a deadline if the first has not responded; take the first response.

The retry policy is the caller's responsibility; AAFP v1 does not mandate it in the
protocol, but the SDK ships it (`aafp-sdk` simple API). Production deployments MUST
enable it.

### 3.5 Connection Recovery Decision Tree

```
connection error
   │
   ├── path changed & peer alive?
   │     ├── yes → QUIC connection migration
   │     │         ├── success → continue on migrated connection
   │     │         └── fail → reconnect + 0-RTT resumption (§3.3)
   │     └── no (peer dead)
   │           ├── peer has standby? (§6)
   │           │     ├── yes → failover to standby
   │           │     └── no → retry with backoff until peer restarts (§3.4)
   │           └── relay-only path? → relay failover (§5)
```

---

## 4. DHT Partition Healing

### 4.1 The Partition Scenario

A network partition splits the agent fleet into two or more groups that cannot reach
each other. Each group's DHT continues to operate independently. This is the classic
split-brain risk for any distributed store.

### 4.2 AAFP's Partition Model (Track R6)

AAFP's DHT partition handling is specified in `track-r-wan-discovery/R-wan-discovery.md`
R6 and implemented in `aafp-discovery/src/discovery_v1.rs` and `rpc_handler.rs`:

**Detection:**
- A single peer becoming unreachable is a peer failure (R4), not a partition.
- *Many* peers becoming unreachable simultaneously is a partition. The DHT logs a
  partition event for debugging.

**During partition:**
- Both sides accept `announce` operations independently. There is no global "pause."
- Each side's records are valid within that side. This is intentional: agents on each
  side can still discover and use each other.

**On heal (reconnection):**
- Peers exchange records via the refresh mechanism (R3).
- **Reconciliation rule: union of all records, latest timestamp wins.** For records
  with the same `agent_id` but different content, the one with the later timestamp is
  kept; the other is logged as a warning.
- **No rollback.** Both sides' records are considered valid; there is no "abort" of
  writes that happened during the partition. This is a last-writer-wins (LWW) model,
  deliberately simple.

**Conflict case — same agent_id, different public_key:**
- This indicates either a key rotation or a malicious re-identity attempt. The
  later-timestamp record wins, but a warning is logged and the operator should
  investigate (this is one of the CA-compromise signals, §9.5).

### 4.3 Record Reconciliation Walkthrough

```
Partition: fleet splits into {A,B,C,D,E} and {F,G,H,I,J}
   │
   ├── Side 1: A announces cap "python"; B announces cap "rust"
   ├── Side 2: F announces cap "go";   G announces cap "python" (newer timestamp)
   │
Heal: A-J reconnect
   │
   ├── refresh exchanges records across the boundary
   ├── "python" record: G's (newer) wins over A's; all 10 nodes converge on G
   ├── "rust" record: propagates to side 2
   ├── "go" record: propagates to side 1
   └── final state: all 10 nodes have {python(G), rust(B), go(F)}
```

### 4.4 Attestation Reconciliation

Attestations live in a separate DHT key namespace
(`SHA-256(b"aafp-attestation" || subject || attester)`, Track E5). They are immutable
once written (signature-bound) and expire by TTL. Partition healing for attestations is
therefore simpler: **union of all attestations from both sides; expired ones evicted by
the standard `evict_expired()` pass.** There is no LWW conflict because an attestation's
content cannot change — a new attestation from the same attester for the same subject is
a new record with a new signature, not an update.

### 4.5 Partition Healing RTO

The heal time is dominated by the refresh round-trips across the formerly-partitioned
boundary. With α=3 concurrency and k=5 replication, a single refresh pass converges in
O(log N) round-trips. For a 100-agent fleet, this is on the order of seconds once
connectivity is restored. The **RTO < 30s for agent failover** target (§10) covers the
combined detect + heal window for partitions that trigger failover.

### 4.6 Operational Guidance

- **Do not run a single CA across a partition boundary.** If a partition separates the
  CA from the agents that need it, cert renewal stalls. Deploy CAs per region (§6) or
  use WoT for partition-prone environments.
- **Monitor partition events.** The DHT logs them; surface them to the operator. A
  partition that heals silently can mask a real network fault.
- **Beware stale records after long partitions.** A record that was "latest" on one side
  may be hours stale. The adaptive TTL (extended by heartbeats) mitigates this: an agent
  that was reachable during the partition has a fresh heartbeat and thus a longer TTL,
  but an agent that was unreachable should have its TTL decay so stale records expire.

---

## 5. Relay Failover

### 5.1 The Relay Failure Scenario

An agent behind NAT depends on a relay (RFC 0010) for inbound connectivity. If that
relay crashes or becomes unhealthy, the agent is unreachable until it fails over to a
backup relay. Relay failover is therefore on the critical path for HA.

### 5.2 Relay Discovery and Health

`relay_discovery.rs` (RFC 0010 §9) implements DHT lookup of the `relay` capability and
health checks. A relay is considered usable when `has_capacity() && is_healthy()`. The
agent maintains a candidate list of relays, ordered by health and capacity.

**Health signals:**
- Active health probe (RFC 0010 RPC) returns success.
- Reservation requests succeed within a deadline.
- The relay's advertised capacity is above a threshold.

### 5.3 Failover Procedure

1. **Detect relay failure.** The active relay's health probe fails, or an in-flight
   reservation request times out, or the relay's QUIC connection drops.
2. **Mark relay unhealthy.** The agent's `RelayDiscoveryService` demotes the relay in its
   candidate list.
3. **Select backup relay.** Pick the next healthy relay from the candidate list. If the
   list is empty, run a fresh DHT lookup for the `relay` capability.
4. **Request new reservation.** RFC 0010 §3 reservation RPC to the backup relay.
5. **Re-advertise relayed address.** Update the agent's AgentRecord with the new relay's
   multiaddr and re-publish to the DHT (k=5).
6. **If no AAFP relay is available, fall back to TURN** (`NAT_TRAVERSAL_NETWORKING.md`
   §2.2). TURN is not QUIC-native and does not carry PQ-TLS end-to-end the same way, so
   it is a last resort, but it guarantees connectivity.

### 5.4 Relay HA Topology

For production, deploy relays in N+1 or N+2 redundancy per region:

```
Region us-east:
  relay-us-east-1 (primary)
  relay-us-east-2 (hot backup)
  relay-us-east-3 (capacity overflow)

Region eu-west:
  relay-eu-west-1 (primary)
  relay-eu-west-2 (hot backup)
```

Agents discover all of them via DHT and keep the top 2-3 warm. Failover is automatic
and bounded by the health-probe interval + reservation RTT, targeting **RTO < 5s for
connection recovery** (the relay is part of the connection path).

### 5.5 Reservation Persistence Across Suspend/Resume

`NAT_TRAVERSAL_NETWORKING.md` notes that relay reservations should persist across
suspend/resume (e.g., laptop sleep). The relay holds the reservation for up to
`DEFAULT_MAX_DURATION_SECS = 3600`. On resume, the agent verifies the reservation is
still valid (probe) before reusing it; if expired, it re-requests. This avoids a
full re-discovery cycle on short suspend/resume cycles.

---

## 6. Multi-Region Deployment

### 6.1 Topology

A multi-region AAFP deployment places agents, relays, and DHT seed peers in each
region, with geo-aware routing preferring same-region peers:

```
            ┌─────────────────────────────────────────┐
            │           Global DHT keyspace            │
            │   (256-bit, k=5 replication, no shards)  │
            └─────────────────────────────────────────┘
              │                    │                    │
        ┌─────┴─────┐        ┌─────┴─────┐        ┌─────┴─────┐
        │ us-east   │        │ eu-west   │        │ ap-south  │
        │ 40 agents │        │ 35 agents │        │ 25 agents │
        │ 3 relays  │        │ 3 relays  │        │ 2 relays  │
        │ 1 CA      │        │ 1 CA      │        │ 1 CA      │
        │ 2 seeds   │        │ 2 seeds   │        │ 2 seeds   │
        └───────────┘        └───────────┘        └───────────┘
```

### 6.2 Geo-Aware Routing

The AgentRecord extensions (Track E5) include a `by_geo` secondary index. The adaptive
routing plane (`ADAPTIVE_ROUTING_PLANE.md`) uses this to prefer same-region candidates
when resolving a capability. This reduces latency (cross-region RTT is 50-150ms vs.
< 10ms intra-region) and contains failures (a region partition does not affect other
regions' local lookups).

**Routing preference order:**
1. Same-region, healthy, low-load peer.
2. Same-region, healthy peer.
3. Cross-region, healthy peer (with latency penalty in scoring).
4. Relay-routed peer if direct dial fails.

### 6.3 DHT Across Regions

AAFP uses a single global DHT keyspace (no sharding for < 1000 nodes per the DHT scale
report's recommendation). Cross-region DHT traffic is the cost of global discovery.
Mitigations:
- **Local lookup cache (5-min TTL)** significantly reduces repeat cross-region lookups.
- **Region-local seed peers** so bootstrap does not require cross-region round-trips.
- **Republish to k=5 closest** naturally places replicas in the nearest nodes, which
  for a geo-clustered fleet are usually same-region.

For > 1000 nodes, the DHT scale report recommends hierarchical DHT or sharding; that is
a future concern (v2 world-scale, per NORTH_STAR §3).

### 6.4 Region Failure

If an entire region becomes unreachable (cloud provider outage), the other regions'
DHTs continue to operate. Records from the failed region expire by TTL (adaptive, but
bounded). Agents that had cross-region connections fail over per §3. Agents whose
*only* presence was in the failed region become undiscoverable until the region returns
or a standby elsewhere takes over (§7).

### 6.5 CA Per Region

Each region runs its own CA (RFC 0009) so cert issuance does not depend on cross-region
connectivity. CAs cross-sign or are anchored in a shared root of trust so that an agent
cert issued in us-east is verifiable in eu-west. This is the WoT/CA hybrid model from
Track P.

---

## 7. Hot Standby Agents & Checkpointing

### 7.1 The Stateful-Agent Problem

A stateless agent (e.g., a pure RPC handler) can crash and restart with no data loss —
its state is the union of its DHT record and its keys, both durable. A *stateful* agent
(e.g., one holding a long conversation, a multi-step task, a streaming session) loses
working state on crash. For these, AAFP offers two complementary patterns: **hot
standby** and **checkpointing**. Both are implementation-layer disciplines; the protocol
provides the hooks (DHT for presence, UCAN for delegation) but does not mandate either.

### 7.2 Hot Standby Pattern

A hot standby is a second agent process, with a separate `AgentId` (standby keys), that
is ready to take over a primary's workload if the primary fails. The takeover is
coordinated via UCAN delegation (RFC 0009):

```
Primary agent P (AgentId_P, keys_P)
   │
   ├── issues UCAN delegation to Standby S:
   │     "S may handle capability 'python' for workload W
   │      if P is unreachable for > T seconds"
   │
Standby agent S (AgentId_S, keys_S)
   │
   ├── monitors P via health probe (DHT + direct dial)
   ├── on P failure: S activates
   │     ├── re-publishes AgentRecord advertising capability 'python'
   │     ├── callers' DHT lookups now return S
   │     └── S resumes workload W from last checkpoint (§7.3)
```

**Key properties:**
- The standby has its *own* identity; it does not impersonate P. Callers see a different
  `AgentId` but the same capability. The UCAN delegation proves S is authorized.
- The standby does not hold P's keys (that would be a key-custody violation, §8.5). It
  holds a delegation.
- Takeover requires the workload to be checkpointed or reconstructable, otherwise S
  starts the workload from scratch.

**RTO target:** standby activation + DHT re-publish + caller re-lookup < 30s (§10).

### 7.3 Checkpointing

For long-running stateful agents, periodic state snapshots are written to a durable
store (local disk, object storage, or a replicated log). This is the "Stateful Mobility"
item listed as Future in NORTH_STAR §1.5 ("checkpoint, serialize, move, resume"). This
document standardizes the pattern so deployments converge on it:

**Checkpoint format:**
- A versioned, signed CBOR blob containing the agent's working state (conversation
  history, task graph, in-flight RPC metadata).
- Signed with the agent's key so a standby can verify it before resuming.
- Stored out-of-band from the DHT (the DHT is for presence, not bulk state; the 64 KiB
  record limit enforces this).

**Checkpoint cadence:**
- Periodic: every N seconds or M messages, whichever comes first. Default N=10s, M=100.
- On graceful shutdown: a final checkpoint before exit.
- On delegation: when issuing a UCAN delegation to a standby, include the latest
  checkpoint pointer so the standby knows where to resume.

**RPO implication:** with N=10s checkpoints, the worst-case data loss on crash is
< 10s of work. The **RPO < 1s for stateful agents** target (§10) requires either
N=1s checkpoints (expensive) or an append-only operation log that is fsync'd per
entry. The latter is the recommended pattern for RPO-sensitive workloads: every
state-mutating operation is appended to a durable WAL before the agent acts on it,
so a crash loses at most the in-flight operation.

### 7.4 Checkpoint + Standby Combined

The production-grade HA pattern for stateful agents combines both:

1. Primary checkpoints every 10s to a replicated store.
2. Primary streams an operation WAL (fsync per entry) for RPO < 1s.
3. Standby tails the WAL and applies checkpoints, staying warm.
4. On primary failure, standby has at most one in-flight operation to re-apply.
5. Standby activates, re-publishes, and serves.

This is the pattern that meets both RTO < 30s and RPO < 1s simultaneously.

### 7.5 Stateless Agents (RPO = 0)

A stateless agent — one whose response is a pure function of the request and its
durable identity/capability — has **RPO = 0 by construction**. A crash loses no data
because there is no working state. The caller re-issues the failed RPC and gets the
same answer. Most AAFP agents in v1 are stateless (RPC handlers, capability
resolvers); stateful agents are the exception and require the patterns above.

---

## 8. Data Durability

### 8.1 DHT Record Replication Factor

Records are replicated to the **k=5 closest peers** by XOR distance in the 256-bit
keyspace (Track R, `DhtRouter::republish_own_record()`). This means:

- A record survives the loss of up to 4 of its 5 replicas.
- At 30% churn, 70% of replicas survive → 95% lookup success (DHT scale report).
- At 20% churn, 95% lookup success.
- At 10% churn, 100% lookup success.

**Operational tuning:** for environments with higher churn (e.g., ephemeral agents),
increase k to 7 or 8. The tradeoff is more storage per record and more republish
traffic. The DHT scale report recommends tuning k and α for 100-1000 node fleets.

### 8.2 DHT Persistence

DHT records persist to SQLite locally (NORTH_STAR §3). A node that restarts re-loads its
local replica set. This means even a full fleet restart (e.g., region reboot) preserves
records as long as the SQLite files survive. **Operators must back up the SQLite DHT
store** as part of host-level backup; it is the local copy of replicated data.

### 8.3 Adaptive TTL

Record TTL is not fixed; it is extended by recent heartbeats (Track E5). An agent that
is actively heartbeating keeps its record fresh; an agent that goes silent has its
record's TTL decay so stale records expire. This prevents the DHT from accumulating
ghost records of dead agents, which would otherwise degrade lookup quality over time.

### 8.4 Attestation Persistence

Attestations (third-party reputation statements) are stored in a **separate DHT key
namespace** (`SHA-256(b"aafp-attestation" || subject || attester)`, Track E5) and
replicated to k=5 closest peers, same as AgentRecords. They are:

- **Signature-bound:** an attestation cannot be modified without invalidating the
  attester's signature, so they are tamper-evident.
- **TTL-expiring:** `evict_expired()` removes stale attestations; an attester must
  re-attest to keep reputation fresh.
- **Self-attestation rejected:** §7.5 Sybil resistance — an agent cannot attest about
  itself.
- **Subject-indexed:** prefix scanning on `subject_agent_id` allows fetching all
  attestations about an agent, which is what a trust scorer needs.

**Durability implication:** an agent's reputation survives the agent's own crash
because attestations are stored *by other agents*. This is a key property: reputation
is not self-reported, so it is not lost when the subject crashes.

### 8.5 Key Custody (The Highest-Stakes Durability Concern)

An agent's keys are its identity. Lose the keys and:

- The agent cannot prove it is the same agent (DHT record with a new key = new AgentId).
- UCAN delegations issued by the old key become unverifiable.
- Attestations about the old AgentId no longer apply to the new one.

**Key custody requirements:**
- Keys are stored encrypted at rest in a local keystore (OS keychain, HSM, or encrypted
  file with a passphrase/KMS-unwrapped key).
- Keys are **never** stored in the DHT. The DHT stores the *public* key in the
  AgentRecord; the private key is sole-custody.
- Key backup: the encrypted keystore must be backed up. Without it, a host failure is
  an unrecoverable identity loss.
- Key rotation (Track P) allows an agent to transition to a new key while preserving
  identity continuity — but rotation requires the *old* key to sign the transition. A
  lost key cannot be rotated from.

**DR implication:** the keystore backup is the single most important backup in an AAFP
deployment. The DR runbook (§12) treats it as a P0 item.

---

## 9. Failure Modes

This section catalogs the failure modes AAFP must survive, their detection signals, and
the recovery section that handles each.

### 9.1 Agent Crash

- **Detection:** keep-alive timeout on peers; DHT ping failure (3 missed → offline).
- **Impact:** in-flight RPCs to the agent fail; its DHT record persists until TTL.
- **Recovery:** §2 (state reconstruction) + §3 (caller reconnect) + §6/§7 if standby.

### 9.2 Relay Crash

- **Detection:** relay health probe failure; reservation RPC timeout; QUIC connection
  drop to the relay.
- **Impact:** agents using that relay for inbound connectivity become unreachable via
  the relayed path until failover.
- **Recovery:** §5 (relay failover to backup relay or TURN).

### 9.3 Network Partition

- **Detection:** many peers unreachable simultaneously (R6); cross-region connectivity
  loss.
- **Impact:** split-brain DHT operation; each side functions independently.
- **Recovery:** §4 (partition healing, LWW reconciliation on heal).

### 9.4 DHT Corruption

- **Detection:** signature verification failure on a record (ML-DSA-65 verify is ~1ms
  per record); inconsistent records across replicas; unexpectedly high record size
  (the 64 KiB hard limit rejects oversized records on `put()`).
- **Impact:** corrupted records can poison lookups if not rejected.
- **Recovery:**
  - Signature verification (mandatory on every lookup) rejects forged records.
  - Republish from the authoritative source (the agent that owns the record) overwrites
    corrupted replicas.
  - If a node is persistently corrupt, evict it from routing tables (R4 churn handling)
    and let its records expire.
  - Worst case: the agent re-publishes its own record, which re-replicates to k=5
    healthy peers, outvoting the corrupt copies.

### 9.5 CA Compromise

- **Detection:** unauthorized certs observed in the wild; CA key leakage indicators;
  anomalous issuance patterns.
- **Impact:** an attacker can mint agent certs and impersonate agents. This is the
  highest-severity failure mode.
- **Recovery:**
  - **Revocation:** the compromised CA's cert is revoked via the revocation mechanism
    (Track P). `TrustManager` propagates revocation so agents reject the compromised
    chain.
  - **Rotation:** affected agents rotate to a new CA (or to WoT-only trust) and
    re-issue certs.
  - **Re-attestation:** attestations signed by agents whose identity was forged must be
    re-verified; the trust scorer must discount attestations from the compromised
    window.
  - **Forensic:** DHT records with the compromised CA's issuance are auditable (records
    are signed and timestamped). The operator identifies and reverts malicious records.
- **This is the one failure mode with RTO measured in hours, not seconds**, because it
  requires human incident response (key revocation, forensics, re-issuance). The
  protocol provides the mechanisms; the operator drives the timeline.

### 9.6 Keystore Loss (Agent Identity Loss)

- **Detection:** agent cannot decrypt/load its keys on restart.
- **Impact:** the agent's AgentId is permanently lost. Its DHT record expires by TTL.
  Its attestations become orphaned (about a now-dead AgentId).
- **Recovery:** there is no cryptographic recovery. The operator must:
  - Create a new agent with a new AgentId.
  - Re-establish reputation (re-attestation by peers — slow).
  - Re-issue UCAN delegations under the new identity.
  - Update callers' configuration / DHT records to point to the new AgentId.
- **Prevention:** keystore backup (§8.5) is the only mitigation. This is why the DR
  runbook treats keystore backup as P0.

### 9.7 QUIC Connection Migration Failure

- **Detection:** connection error after a path change; keep-alive failure on the new
  path.
- **Impact:** the connection is lost; in-flight streams fail.
- **Recovery:** §3.3 (reconnect with 0-RTT session resumption). Expected in ~76% of
  hard handoffs (Track O6), so the fallback must always be enabled.

### 9.8 Clock Skew

- **Detection:** timestamp-based LWW reconciliation produces surprising results
  (§4.2); attestation expiry fires early or late.
- **Impact:** incorrect record selection on partition heal; premature/late attestation
  expiry.
- **Recovery:** operators must run NTP/chrony on all agents. The protocol uses
  timestamps for LWW but does not require synchronized clocks for correctness of
  signature verification (which is the strong guarantee). Clock skew degrades LWW
  quality, not security.

---

## 10. Recovery Time & Recovery Point Objectives

### 10.1 RTO/RPO Table

| Failure | RTO target | RPO target | Mechanism |
|---------|-----------|-----------|-----------|
| Connection loss (path change) | < 5s | 0 (in-flight RPCs replayed) | §3.2 migration, §3.3 resumption |
| Connection loss (peer restart) | < 5s | 0 (caller retries) | §3.3 reconnect + resumption |
| Agent crash, stateless | < 30s | 0 | §2 restart + re-publish |
| Agent crash, stateful (checkpointed) | < 30s | < checkpoint interval (default 10s) | §7.3 |
| Agent crash, stateful (WAL) | < 30s | < 1s | §7.4 |
| Agent failover to standby | < 30s | < 1s (with WAL) | §7.2 + §7.4 |
| Relay failover | < 5s | 0 (reservations are stateless) | §5 |
| DHT partition heal | < 30s after reconnect | 0 (LWW merge, no data loss) | §4 |
| Region failure | < 5min (manual) | region's agents' RPO | §6.4 |
| CA compromise | hours (manual IR) | n/a (security incident) | §9.5 |
| Keystore loss | unrecoverable (new identity) | all working state | §9.6 (prevent via backup) |

### 10.2 How the Targets Are Met

**RTO < 5s for connection recovery:** the dominant cost is one network RTT (0-RTT
resumption eliminates the handshake RTT) + DHT lookup (< 100ms for < 100 nodes). With
sub-millisecond local crypto (session resumption skips ML-DSA-65 handshake signature
verification), 5s is generous even on high-latency links.

**RTO < 30s for agent failover:** crash detection (keep-alive, ~2-3 intervals) +
supervisor restart (< 2s) + DHT bootstrap + re-publish (< 5s) + caller re-lookup and
reconnect (< 5s) + standby activation if used (< 5s). The 30s budget accommodates
worst-case detection latency.

**RPO = 0 for stateless agents:** by definition — no working state to lose. The caller
re-issues the failed RPC and gets an equivalent result.

**RPO < 1s for stateful agents:** requires the WAL pattern (§7.4) where every
state-mutating operation is fsync'd to a durable log before the agent acts. A crash
loses at most the single in-flight operation that had not yet been fsync'd. Periodic
checkpoints (10s) provide a coarser fallback; the WAL is what delivers the < 1s bound.

### 10.3 SLO Monitoring

Each target must be monitored in production:
- Connection recovery time: measure from connection-error event to first successful
  RPC on the recovered connection.
- Agent failover time: measure from crash detection to first successful RPC to the
  recovered/standby agent.
- Partition heal time: measure from partition-heal event to full record convergence.
- Relay failover time: measure from relay-health-fail to successful reservation on the
  backup relay.

These metrics feed the chaos engineering program (§11).

---

## 11. Chaos Engineering Plan

### 11.1 Goal

Continuously validate that the DR mechanisms in this document actually work under
realistic failure injection, in a staging environment that mirrors production. Chaos
engineering is not optional for a system claiming the RTO/RPO targets in §10.

### 11.2 Failure Injection Catalog

| Experiment | Injection method | Measured outcome | Target |
|-----------|------------------|------------------|--------|
| Agent crash | `kill -9` random agent process | Caller RPC success rate, recovery time | RTO < 30s, 0% permanent data loss |
| Relay crash | `kill -9` primary relay | Agent reachability, failover time | RTO < 5s, 0% permanent unreachability |
| Network partition | iptables/tc drop between agent groups | DHT lookup success per side, heal convergence | RTO < 30s post-heal, LWW correctness |
| Packet loss | tc netem 1-10% loss | RPC success rate, throughput degradation | graceful degradation, no hard failure |
| Latency injection | tc netem +50-200ms RTT | Connection migration success, resumption success | migration fallback triggers correctly |
| Path change (migration) | change agent's bind address mid-connection | Migration success rate; fallback success | < 5s recovery via §3.2 or §3.3 |
| Clock skew | offset system clock by ±500ms | LWW reconciliation correctness | no security impact; LWW quality degrades gracefully |
| DHT corruption | inject a forged record (bad signature) | Signature rejection rate | 100% rejection; no poison propagation |
| CA compromise (simulated) | revoke a CA cert mid-flight | Agent cert rejection, re-issuance time | revocation propagates < 60s |
| Keystore loss | remove keystore file, restart agent | Detection, alerting | alert fires; operator notified (P0) |
| Region failure | blackhole a region's subnet | Cross-region failover, RTO | < 5min manual, automated target TBD |
| Slow peer (gray failure) | tc netem +2s delay on one agent | Outlier detection, circuit breaker | peer ejected from routing; callers fail over |

### 11.3 Cadence

- **Weekly (staging):** run the agent-crash, relay-crash, and partition experiments
  automatically. Alert on RTO/RPO breach.
- **Monthly (staging):** run the full catalog including CA compromise simulation and
  region failure. Produce a chaos report.
- **Pre-release (staging):** full catalog must pass before any production release.
- **Quarterly (production, game-day):** a carefully scoped, pre-announced chaos
  experiment in production (agent crash only, on a non-critical agent) to validate that
  staging and production behave identically.

### 11.4 Success Criteria

An experiment "passes" when:
1. The measured RTO is within the §10 target.
2. The measured RPO is within the §10 target.
3. No permanent data loss (records, attestations, identity).
4. No security regression (no forged records accepted, no auth bypass).
5. The system self-heals without operator intervention for the automated failure modes
   (agent crash, relay failover, partition, migration).

If an experiment fails, it is a release blocker. The failure is root-caused, the
mechanism is fixed, and the experiment is re-run until green.

### 11.5 Tooling

- **Failure injection:** tc/netem for network; `kill`/`systemctl stop` for processes;
  iptables for partitions; a custom "DHT corruptor" test harness that injects
  bad-signature records.
- **Measurement:** the existing `AgentMetrics` (Track S4) and Prometheus endpoint
  provide the signals. Add chaos-specific metrics: `aafp_chaos_recovery_seconds`,
  `aafp_chaos_data_loss_events`, `aafp_chaos_security_regressions`.
- **Orchestration:** a chaos runner that selects a random target, injects the failure,
  waits for recovery or timeout, measures, and reports. Reuse the load-test harness
  from Track S (100-agent, 399K-message workload) as the background traffic.

---

## 12. DR Runbook: 100-Agent Production Deployment

This is a concrete, step-by-step runbook for a 100-agent AAFP fleet split across three
regions (us-east 40, eu-west 35, ap-south 25), with 8 relays (3/3/2), 3 CAs (one per
region), and a mix of stateless and stateful agents.

### 12.1 Steady-State Prerequisites

Before any incident, the following must be true (verified weekly):

- [ ] **Keystore backups** exist for every agent and are restorable. (P0 — §8.5)
- [ ] **DHT SQLite stores** are backed up on every node. (P1 — §8.2)
- [ ] **Relays** are deployed N+1 per region (3 in us-east, 3 in eu-west, 2 in
  ap-south). (P1 — §5.4)
- [ ] **CAs** are per-region with a shared root; revocation lists are current. (P1 — §6.5)
- [ ] **Standby agents** are deployed for every stateful agent, with UCAN delegations
  in place. (P1 — §7.2)
- [ ] **Checkpointing + WAL** is enabled for every stateful agent. (P1 — §7.4)
- [ ] **Retry policy** (backoff + circuit breaker + bulkhead) is enabled on every
  caller. (P1 — §3.4)
- [ ] **Monitoring** covers: connection recovery time, agent failover time, partition
  events, relay health, DHT lookup success, cert expiry. (P2 — §10.3)
- [ ] **Chaos experiments** pass weekly in staging. (P2 — §11.3)

### 12.2 Incident: Single Agent Crash (Stateless)

**Detect:** monitoring alerts `agent_down` for `agent-us-east-12`.

1. Verify the supervisor restarted the agent (`systemctl status aafp-agent-12`).
   - If not restarted, start it manually: `systemctl start aafp-agent-12`.
2. Wait for the agent to re-bootstrap and re-publish (target < 10s).
3. Confirm DHT lookup for the agent's capability returns its new address.
4. Confirm callers reconnected (check `aafp_connection_recovery_seconds` metric).
5. If RTO > 30s, open a postmortem. Check supervisor restart time, DHT bootstrap time,
   and caller retry configuration.
6. **No data loss expected** (stateless, RPO = 0).

**Expected duration:** < 30s, often self-healing with no operator action.

### 12.3 Incident: Single Agent Crash (Stateful, with Standby)

**Detect:** monitoring alerts `agent_down` for `agent-eu-west-07` (stateful).

1. Confirm the standby `agent-eu-west-07-standby` activated:
   - Check it re-published the capability to the DHT.
   - Check callers' DHT lookups now return the standby.
2. Confirm the standby resumed from the latest checkpoint + WAL tail (RPO < 1s).
3. Decide: repair the primary or promote the standby.
   - **Repair primary:** fix the host, restart the primary. The primary loads its
     latest checkpoint, catches up from the WAL, and re-publishes. The standby stands
     down (reverts to standby). Callers fail back to the primary via DHT lookup.
   - **Promote standby:** if the primary is unrecoverable, promote the standby to
     primary. Issue a new UCAN delegation to a *new* standby. The old primary's
     AgentId is retired (let its DHT record expire).
4. Verify no WAL gap: compare the standby's last-applied WAL entry to the primary's
   last-fsync'd entry. A gap > 1 entry is an RPO breach; investigate.
5. **Expected data loss:** < 1s of operations.

### 12.4 Incident: Relay Crash

**Detect:** monitoring alerts `relay_unhealthy` for `relay-us-east-1`.

1. Confirm agents failed over:
   - Check `aafp_relay_failover_seconds` metric (target < 5s).
   - Confirm agents now hold reservations on `relay-us-east-2` or `relay-us-east-3`.
2. Confirm no agent is stranded (DHT lookup returns a relayed address that works).
3. If all 3 us-east relays are down, confirm TURN fallback engaged for NAT'd agents.
4. Restore the failed relay: diagnose (OOM? network? cert?), restart, verify health.
5. Agents will re-discover the healthy relay and may migrate back (optional; not
   required for correctness).
6. **No data loss** (reservations are stateless).

### 12.5 Incident: Network Partition (Region Split)

**Detect:** monitoring alerts `partition_detected` — us-east cannot reach eu-west/ap-south.

1. Confirm each region continues to operate locally (DHT lookups within region succeed).
2. Do **not** force a merge while the partition is active; LWW reconciliation handles
   the merge on heal (§4).
3. Identify the partition cause (cloud provider, misconfigured firewall, BGP).
4. Restore connectivity.
5. Confirm partition heal:
   - DHT refresh propagates records across the boundary.
   - `aafp_partition_heal_seconds` metric (target < 30s post-reconnect).
   - Spot-check: an agent announced in us-east during the partition is now discoverable
     in eu-west.
6. Review LWW conflicts in the logs (records with same agent_id, different content).
   Investigate any `public_key` conflicts (possible §9.5 signal).
7. **No data loss** (LWW merge; both sides' records preserved).

### 12.6 Incident: DHT Corruption

**Detect:** monitoring alerts `dht_signature_verification_failure` spike; or
`dht_oversized_record_rejected`.

1. Identify the corrupt node (the source of bad-signature records).
2. Evict the node from routing tables (R4 churn handling). Its records expire by TTL.
3. Have the affected agents re-publish their own records (re-replicate to k=5 healthy
   peers, outvoting corrupt copies).
4. If the corruption is a security event (forged signatures), escalate to §12.8.
5. Confirm lookup success rate returns to 100%.
6. **No data loss** (authoritative re-publish overwrites corruption).

### 12.7 Incident: Region Failure (Whole Region Down)

**Detect:** monitoring alerts `region_unreachable` for ap-south.

1. Confirm us-east and eu-west continue to operate (they should — independent DHT,
   independent CAs, independent relays).
2. Confirm ap-south's agents are failed over:
   - Stateless agents with standbys in other regions: standbys activate (§7.2).
   - Stateful agents with cross-region checkpoint replication: standbys resume from
     checkpoint (RPO = checkpoint interval).
   - Agents with no cross-region standby: undiscoverable until ap-south returns.
3. Decide: wait for region recovery or promote cross-region standbys.
   - **Wait:** if the outage is expected to be short (< 5min), wait. ap-south's records
     persist (TTL); agents restart on region recovery.
   - **Promote:** if the outage is long, promote cross-region standbys to primary.
     Retire the ap-south AgentIds (let records expire).
4. On ap-south recovery, re-bootstrap agents, re-publish, re-establish relays.
5. **Expected duration:** < 5min for failover (manual decision); RPO per agent's
   checkpoint/standby config.

### 12.8 Incident: CA Compromise (Security)

**Detect:** alert `unauthorized_cert_observed` or `ca_key_leak_indicator`.

1. **Declare incident.** This is a P0 security event with human incident response.
2. **Revoke** the compromised CA's cert (Track P revocation). `TrustManager`
   propagates revocation; agents reject the compromised chain (target < 60s
   propagation).
3. **Identify** all certs issued by the compromised CA (audit logs).
4. **Re-issue** affected agent certs from a new/backup CA.
5. **Rotate** affected agent keys if there is any indication the CA compromise
   enabled agent key compromise (rare, but possible if the CA also held key-escrow —
   AAFP CAs do not escrow agent keys, so this should not apply).
6. **Audit** DHT records and attestations from the compromise window. Re-verify
   attestations; discount those from suspect identities.
7. **Forensic** report; postmortem; remediation to prevent recurrence.
8. **RTO:** hours, not seconds. This is the one failure mode where the §10 sub-second
   targets do not apply — it is a security incident requiring human judgment.

### 12.9 Incident: Keystore Loss (Agent Identity Loss)

**Detect:** agent fails to start; log shows `keystore_decrypt_failed` or
`keystore_file_missing`.

1. **Attempt restore** from backup (§8.5). If the backup is valid, restore and restart.
   - This is why keystore backup is P0 — it is the only recovery path.
2. **If no backup:** the AgentId is permanently lost. Execute §9.6 recovery:
   - Create a new agent with a new AgentId.
   - Re-establish reputation (re-attestation — slow, days).
   - Re-issue UCAN delegations.
   - Update callers / DHT to point to the new AgentId.
3. **Postmortem:** why was the backup missing or corrupt? Fix the backup process.
4. **RPO:** all working state of the old identity (reputation, delegations) is lost.
   This is the worst-case data-loss scenario and is entirely preventable with backups.

### 12.10 Post-Incident Actions (All Incidents)

- [ ] Confirm all §10 RTO/RPO targets were met; record actuals.
- [ ] File a postmortem for any target breach.
- [ ] Update the chaos catalog if the incident revealed an untested failure mode.
- [ ] Verify monitoring captured the incident end-to-end.
- [ ] If a standby was promoted, deploy a new standby and issue fresh UCAN delegations.
- [ ] If a relay was replaced, update the candidate lists and confirm agent re-discovery.

---

## 13. Open Questions & Future Work

These items are beyond v1 scope but inform the DR roadmap:

1. **Execution Fabric (NORTH_STAR §1.5, Track V):** work scheduling, pipeline assembly,
   and *protocol-level* checkpointing. Today checkpointing is an implementation
   discipline (§7); the Execution Fabric would standardize it as a protocol primitive,
   enabling cross-agent task migration with guaranteed RPO.
2. **Durable event log (GAP_ANALYSIS_EVENT_DRIVEN):** a persistent, replicated event
   sourcing layer would give stateful agents RPO = 0 without per-operation fsync. This
   is the v2 path to strong durability for stateful workloads.
3. **Automated region failover:** §12.7 is currently a manual decision. An automated
   policy (fail over after N seconds of region unreachability, with a quorum check)
   would reduce RTO for region failure from < 5min to < 1min.
4. **Hierarchical DHT for > 1000 nodes:** the DHT scale report recommends sharding or
   hierarchy beyond 1000 nodes. DR for a sharded DHT adds shard-level partition
   healing, which is not covered here.
5. **Cross-region WAL replication:** §7.4's WAL is region-local today. Replicating the
   WAL cross-region would give stateful agents RPO < 1s even across region failure
   (§12.7), at the cost of cross-region write latency.
6. **Connection migration hardening:** the 76% hard-handoff failure rate (Track O6)
   needs real mobile-hardware validation and, likely, active migration initialization
   in the transport layer to push the success rate above 95%.

---

## 14. Quick Reference: Recovery Mechanism by Failure

| Failure | Section | Primary mechanism | Fallback |
|---------|---------|-------------------|----------|
| Path change | §3.2 | QUIC connection migration | Reconnect + 0-RTT resumption (§3.3) |
| Peer restart | §3.3 | Reconnect + 0-RTT resumption | Retry with backoff (§3.4) |
| Agent crash (stateless) | §2 | Restart + re-publish | — |
| Agent crash (stateful) | §7 | Checkpoint + WAL restore | Hot standby takeover (§7.2) |
| Relay crash | §5 | Failover to backup relay | TURN fallback |
| Network partition | §4 | LWW reconciliation on heal | — |
| DHT corruption | §9.4 | Signature rejection + re-publish | Evict corrupt node |
| CA compromise | §9.5 | Revocation + re-issuance | WoT-only fallback |
| Keystore loss | §9.6 | Restore from backup | New identity (last resort) |
| Region failure | §6.4, §12.7 | Cross-region standby failover | Wait for region recovery |
| Clock skew | §9.8 | NTP/chrony | LWW degrades gracefully |

---

## 15. References

- `NORTH_STAR.md` — strategic direction, current state, architecture layers
- `NAT_TRAVERSAL_NETWORKING.md` — relay, AutoNAT, DCuTR, TURN fallback field guide
- `ADAPTIVE_ROUTING_PLANE.md` — geo-aware routing, candidate scoring
- `AGENT_RECORD_EXTENSIONS.md` — DHT record extensions, attestation storage, adaptive TTL
- `RFCs/0010-circuit-relay.md` — relay reservation protocol
- `RFCs/0009-*` — identity, UCAN, WoT, CA, rotation, revocation
- `implementation-plans/track-r-wan-discovery/R-wan-discovery.md` — DHT partition
  handling (R6), churn (R4), replication (k=5)
- `implementation-plans/track-i-connection-lifecycle/I-connection-lifecycle.md` —
  connection pool, migration, keep-alive, session resumption
- `builder-prompts/AR_T3_T4_BREAKER_HEDGING.md` — circuit breaker, bulkhead, retry,
  backoff, hedging
- `test-results/performance/dht-scale-report.md` — DHT scale/churn numbers
- `test-results/interop/wan-connection-migration.json` — migration test results and
  76% failure-rate finding
- `docs/OPERATIONS.md` — production operations, monitoring, metrics
- `info/AAFP_Architecture_Deliverable.md` — flat Kademlia analysis, threat models

---

*End of document. This is a living reference; update it as the Execution Fabric (Track V)
and durable event log work mature, and as chaos engineering (§11) produces empirical
RTO/RPO data that refines the targets in §10.*
