# Track R: WAN Discovery — Multi-Node DHT Routing & Churn

**Priority:** HIGH
**Duration:** 2 weeks
**Blocked by:** Track O (WAN testing infrastructure)
**Blocks:** nothing (but required for production deployment)

---

## Problem

The AAFP discovery layer (RFC 0004) has a Capability DHT that is
"in-memory only, not RFC-compliant" according to the legacy module
deprecation notice. The v1 discovery module (`discovery_v1.rs`) exists
but has only been tested in-process. The DHT has never:

1. **Routed a lookup across multiple networked nodes.** All discovery
   tests are in-process: one agent announces, another looks up, both
   in the same process. Real DHT routing requires multiple nodes on
   different machines, with records propagating through the network.

2. **Handled churn.** What happens when agents go offline and come back?
   The DHT has TTL-based expiry but no active churn handling:
   - No republishing (agents must re-announce before TTL expires)
   - No replication (records exist on only one node — if that node
     goes down, the record is lost)
   - No refresh (when a node joins, it doesn't request records from peers)

3. **Bootstrapped from seed nodes.** The bootstrap module exists but
   has never been tested with real seed nodes on different machines.
   An agent joining the network needs to connect to a seed, get a peer
   list, and start participating in the DHT.

4. **Scaled beyond a few nodes.** All tests use 2-3 agents. Production
   needs hundreds. The DHT's sharding (256-way) was benchmarked for
   throughput but never for routing efficiency with many nodes.

5. **Handled network partitions.** What happens when the network splits?
   Do records survive on both sides? When the partition heals, do
   records reconcile?

---

## Steps

### R1: Multi-node DHT routing protocol

Implement Kademlia-style routing for the capability DHT.

- Current state: `CapabilityDht` is a local store. `DiscoveryRpcHandler`
  handles announce/lookup RPCs but only checks the local store.
  There's no routing table, no peer selection, no iterative lookup.

- Implement `DhtRouter`:
  - Maintains a routing table (KBucket per capability prefix)
  - `find_peers(capability, k) → Vec<AgentRecord>`: iterative lookup
    1. Check local store
    2. If fewer than k results, query known peers for more
    3. Peers return their known records + closer peers
    4. Iterate until k results or no new peers
  - `announce(capability, record)`: store locally + forward to k closest peers
  - `lookup(capability) → Vec<AgentRecord>`: find_peers + filter by capability

- Implement peer exchange (PEX):
  - `aafp.discovery.pex` RPC method (already defined in discovery_v1.rs)
  - Exchange known peer lists on connection
  - Build routing table from PEX responses

- Implement routing table:
  - `KBucket` with k-bucket size (default 20)
  - Bucket refresh: every 15 minutes, query random peer in each bucket
  - Bucket split: when bucket is full and agent_id is in the bucket's range

- **VERIFY:** 5-node test: agent A announces, agent E (5 hops away) can
  lookup A's record through iterative routing

KEY FILES:
  implementations/rust/crates/aafp-discovery/src/discovery_v1.rs
    - CapabilityDht, AnnounceParams, LookupParams
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs
    - DiscoveryRpcHandler, DiscoveryClient
  implementations/rust/crates/aafp-discovery/src/lib.rs
    - Add dht_router module

### R2: Bootstrap and peer discovery

Make the bootstrap process actually work over a network.

- Current state: `BootstrapDiscovery` exists but is a stub that returns
  hardcoded seed addresses. No actual connection to seeds, no peer
  list exchange, no routing table initialization.

- Implement `Bootstrap`:
  1. Connect to configured seed nodes (quic://seed1, seed2, ...)
  2. Send PEX request to each seed
  3. Receive peer lists (agent_id, multiaddr, capabilities)
  4. Build initial routing table from peer lists
  5. Connect to k closest peers from the routing table
  6. Announce own record to closest peers

- Add `BootstrapConfig`:
  - seed_nodes: Vec<String> (multiaddrs)
  - min_peers: usize (default 10) — keep connecting until we have this many
  - bootstrap_timeout: Duration (default 30s)
  - refresh_interval: Duration (default 15min)

- Add `Agent::bootstrap()`:
  - Called on agent start
  - Runs the bootstrap process
  - Returns when min_peers are connected or timeout
  - Background task: periodic refresh

- **VERIFY:** Agent A starts with 3 seed nodes, bootstraps, connects to
  10+ peers, and can route lookups through them

KEY FILES:
  implementations/rust/crates/aafp-discovery/src/bootstrap.rs
    - BootstrapDiscovery (replace stub)
  implementations/rust/crates/aafp-sdk/src/builder.rs
    - AgentBuilder::with_bootstrap(seeds)

### R3: Record replication and republishing

Make records survive node failures.

- Current state: records exist on only one node (the node that received
  the announce). If that node goes down, the record is lost.

- Implement record replication:
  - When an agent announces, the record is stored on the k closest
    nodes to the capability key (default k=5)
  - `announce()` forwards the record to k closest peers
  - Each receiving peer stores the record locally

- Implement republishing:
  - Agents must re-announce before their record's TTL expires
  - Default TTL: 1 hour (configurable)
  - Default republish interval: 30 minutes (half of TTL)
  - Background task: republish all own records every 30 minutes

- Implement record refresh:
  - When a node joins the network, it requests records from peers
  - `aafp.discovery.refresh` RPC: "send me all records you have"
  - New node populates its store from refresh responses

- Implement record expiration:
  - Records with expired TTL are evicted (already exists)
  - Add active expiration check: every 5 minutes, evict expired records
  - Log when records expire (for debugging)

- **VERIFY:** Agent A announces to node N1. N1 replicates to N2-N5.
  N1 goes down. Agent B can still look up A's record from N2-N5.

KEY FILES:
  implementations/rust/crates/aafp-discovery/src/discovery_v1.rs
    - CapabilityDht — add replication logic
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs
    - Add refresh RPC method

### R4: Churn handling

Handle agents going offline and coming back.

- Implement peer liveness tracking:
  - Ping each peer every 60 seconds (using PING/PONG from E1)
  - If a peer doesn't respond to 3 consecutive pings, mark as dead
  - Remove dead peers from routing table
  - Trigger bucket refresh for the dead peer's bucket

- Implement re-announcement on rejoin:
  - When an agent comes back online, it re-announces to k closest peers
  - Peers that had the agent's record update the timestamp
  - Peers that didn't have it store it

- Implement graceful departure:
  - `Agent::leave()` — announce departure to k closest peers
  - Peers remove the agent's record immediately (don't wait for TTL)
  - `aafp.discovery.depart` RPC method

- Implement routing table repair:
  - When a bucket has fewer than k entries, query known peers for
    more peers in that bucket's range
  - Background task: every 15 minutes, check all buckets, repair
    underfilled ones

- **VERIFY:** Agent A goes offline (3 missed pings), peers detect
  within 3 minutes, remove A's records. A comes back, re-announces,
  records are visible again within 1 minute.

KEY FILES:
  implementations/rust/crates/aafp-messaging/src/keepalive.rs
    - PingTracker (E1) — use for liveness
  implementations/rust/crates/aafp-discovery/src/discovery_v1.rs
    - Add churn handling

### R5: DHT query optimization

Optimize DHT routing for production scale.

- Implement parallel lookups:
  - Send lookup requests to α (alpha) peers simultaneously (default α=3)
  - As responses arrive, send more requests to closer peers
  - Terminate when no closer peers are found for 2 rounds

- Implement cached lookups:
  - Cache recent lookup results (TTL: 5 minutes)
  - If a cached result is still valid, return it without network lookup
  - Invalidate cache on announce/depart

- Implement iterative vs. recursive lookup:
  - Iterative (default): caller queries peers one by one, follows referrals
  - Recursive (optional): first peer does the full lookup, returns result
  - Configurable via `LookupParams::recursive`

- Benchmark DHT routing:
  - 10 nodes: lookup time, hops, messages sent
  - 50 nodes: same metrics
  - 100 nodes: same metrics
  - Compare iterative vs. recursive

- **VERIFY:** Lookup with 50 nodes completes in <100ms with <5 hops

KEY FILES:
  implementations/rust/crates/aafp-discovery/src/discovery_v1.rs
  implementations/rust/crates/aafp-benchmark/benches/discovery.rs

### R6: Network partition handling

Handle network splits and reconciliation.

- Implement partition detection:
  - If a peer becomes unreachable but the network is otherwise fine,
    it's a single peer failure (handled by R4)
  - If many peers become unreachable simultaneously, it's a partition
  - Log partition events for debugging

- Implement record reconciliation:
  - When a partition heals, peers exchange records via refresh (R3)
  - Conflicting records (same agent_id, different public_key): keep the
    one with the later timestamp, log a warning
  - Missing records: request from peers

- Implement split-brain prevention:
  - During partition, both sides accept announces independently
  - On heal, merge records: union of all records, latest timestamp wins
  - No "rollback" — both sides' records are valid

- **VERIFY:** 10 nodes split into 2 groups of 5. Each group accepts
  announces. Partition heals. All 10 nodes have all records.

KEY FILES:
  implementations/rust/crates/aafp-discovery/src/discovery_v1.rs
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs

### R7: Multi-node integration test

End-to-end test with multiple nodes on different machines (or different
localhost ports).

- Create `tests/multi_node_dht.rs`:
  - Start 10 agents on ports 4433-4442
  - Agent 1 bootstraps from seed (agent 0)
  - Agents 2-9 bootstrap from agent 0
  - Each agent announces a unique capability
  - Each agent looks up all other capabilities
  - Verify all lookups succeed
  - Kill agent 5, verify its records expire
  - Restart agent 5, verify records reappear
  - Partition: kill agents 5-9, verify agents 0-4 still work
  - Heal: restart agents 5-9, verify all records reconcile

- Create `scripts/test-multi-node-dht.sh`:
  - Starts 10 agents in separate processes
  - Runs the test scenarios
  - Outputs JSON results

- Write results to `test-results/interop/multi-node-dht.json`
- **VERIFY:** 10-node DHT test passes all scenarios

KEY FILES:
  tests/multi_node_dht.rs (NEW)
  scripts/test-multi-node-dht.sh (NEW)
  test-results/interop/multi-node-dht.json (NEW)

### R8: DHT performance and scale report

Benchmark and document DHT performance at scale.

- Benchmark scenarios:
  - 10, 50, 100, 500 nodes (localhost simulation)
  - Metrics: lookup latency, announce latency, routing table size,
    messages per lookup, hops per lookup, memory per node
  - Churn: 10% nodes going offline per minute — how does it affect
    lookup success rate and latency?

- Create `test-results/performance/dht-scale-report.md`:
  - Performance at each scale
  - Bottleneck analysis (network? CPU? memory?)
  - Recommended max nodes per DHT (before sharding needed)
  - Churn tolerance graph

- Update `PERFORMANCE_STATUS.md` with DHT scale results
- **VERIFY:** DHT scales to 100 nodes with <100ms lookup latency

---

## Expected Outcomes

| Capability | Before | After |
|-----------|--------|-------|
| DHT routing | In-process only | Multi-node Kademlia routing |
| Bootstrap | Stub | Working (seed → peer list → routing table) |
| Replication | None | k=5 closest peers store each record |
| Republishing | None | Automatic every 30 min |
| Churn handling | TTL expiry only | Ping-based liveness + rejoin |
| Partition handling | None | Detection + reconciliation |
| Scale tested | 2-3 nodes | 100+ nodes |
| Lookup latency | N/A | <100ms at 50 nodes |

---

## Risks & Mitigations

1. **Kademlia routing may be overkill.** AAFP's DHT is keyed by
   capability string, not by agent_id. There may be only 10-100
   distinct capabilities, so the keyspace is small. **Mitigation:**
   Start with a simpler gossip-based approach. If that doesn't scale
   to 100+ nodes, implement full Kademlia.

2. **Network conditions may cause false churn detection.** A peer
   that's temporarily unreachable (network blip) shouldn't be marked
   dead. **Mitigation:** Require 3 consecutive missed pings (3 minutes)
   before marking dead. Allow re-join without penalty.

3. **Record conflicts during partition heal.** Two sides may have
   different records for the same agent_id. **Mitigation:** Latest
   timestamp wins. Log conflicts for manual review.

4. **Bootstrap may fail if all seeds are down.** **Mitigation:**
   Require at least 2 seed nodes. If all seeds are down, retry with
   exponential backoff. Cache last-known peer list for emergency
   bootstrap.
