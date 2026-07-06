# AAFP Network Topology & Graph Analysis

> **Scope**: How the AAFP network is shaped — the physical and logical graph
> that agents form, how that graph evolves as agents join and leave, and how
> the topology affects discovery latency, fault tolerance, and routing
> efficiency. Covers DHT routing geometry, capability dependency graphs,
> partition tolerance, and concrete topology diagrams from 10 to 100K agents.
>
> **Source code references**:
> - `aafp-discovery/src/dht_router.rs` — Kademlia-style routing table, k-buckets, iterative lookup, PEX, partition detection/reconciliation
> - `aafp-discovery/src/routing_table` (within `dht_router.rs`) — 256 k-buckets keyed by XOR distance
> - `aafp-discovery/src/regional.rs` — latency-based regional grouping
> - `aafp-discovery/src/bootstrap.rs` — seed-node bootstrap
> - `aafp-discovery/src/semantic/graph.rs` — capability dependency graph (adjacency list)
> - `aafp-discovery/src/semantic/edge.rs` — `Requires` / `Enables` / `Precedes` / `Alternative` / `Specializes` edges
> - `aafp-loadtest/src/topology.rs` — Mesh / Star / Ring / Random edge generators
> - `aafp-loadtest/src/config.rs` — `Topology` enum, `max_connections_per_agent`, `random_degree`
> - `aafp-identity/src/trust_manager.rs` — trust anchors (RFC 0011 §8)
> - `aafp-identity/src/web_of_trust.rs` — transitive trust graph

---

## Table of Contents

1. [Topology Types](#1-topology-types)
2. [DHT Topology: Kademlia-Style Routing](#2-dht-topology-kademlia-style-routing)
3. [Connection Graph Analysis](#3-connection-graph-analysis)
4. [Agent Relationship Graph](#4-agent-relationship-graph)
5. [Topology Visualization Tools](#5-topology-visualization-tools)
6. [Network Partition Tolerance](#6-network-partition-tolerance)
7. [Optimal Topology by Use Case](#7-optimal-topology-by-use-case)
8. [Topology Evolution](#8-topology-evolution)
9. [Churn Analysis](#9-churn-analysis)
10. [Concrete Topology Diagrams](#10-concrete-topology-diagrams)
11. [Implementation Reference](#11-implementation-reference)

---

## 1. Topology Types

AAFP does not mandate a single network shape. The topology emerges from
how agents choose to dial each other, and different deployments settle
into different shapes depending on scale, trust boundaries, and latency
constraints. The load-test harness (`aafp-loadtest/src/topology.rs`)
ships four canonical generators — Mesh, Star, Ring, Random — and the
DHT layer (`aafp-discovery/src/dht_router.rs`) imposes a Kademlia
overlay on top of whatever underlay the agents form. Four topology
families cover the realistic deployment space:

### 1.1 Mesh

Every agent connects to every other agent (or, for large N, to a capped
number of nearest peers). This is the default for small deployments and
is what `Topology::Mesh` in `config.rs` produces: agent `i` dials
agents `i+1, i+2, ..., i+max` mod N, giving each agent exactly
`min(max_connections_per_agent, N-1)` outgoing edges.

```
    A --- B
    |\ /| |
    | X  |
    |/ \| |
    C --- D
```

**Properties**: diameter 1 (full mesh) or `ceil(N / max)` (capped),
highest fault tolerance, highest connection overhead. Discovery is
trivial — you already know everyone — so the DHT is degenerate. Used
for ≤ ~30 agents where the cost of maintaining a routing table exceeds
the cost of a full broadcast.

### 1.2 Hierarchical

Agents cluster into department- or team-based groups, with a small set
of "upstream" agents that bridge clusters. This is the natural shape
inside a single enterprise: each team runs its own agents, team leads
interconnect, and a single org-root trust anchor sits at the top. The
shape is a tree (or a forest of trees if multiple orgs coexist).

```
          [Org Root]
         /    |    \
      [TL1] [TL2] [TL3]
      / \    |     / \
    A   B   C    D   E
```

**Properties**: diameter `O(log N)`, low fan-out at the leaves, high
fan-in at the root. The root is a bottleneck and a single point of
failure unless replicated. Trust flows downward via UCAN delegation
chains (`aafp-identity/src/ucan.rs`); capabilities flow upward via
announce forwarding.

### 1.3 Hub-and-Spoke (Star)

All agents connect to a single central hub. This is `Topology::Star`
in the load-test config: agent 0 is the hub, every other agent dials
only agent 0. The hub holds the authoritative DHT view; spokes hold
only their own records and the hub's address.

```
      A   B   C
       \  |  /
        \ | /
         Hub
        / | \
       /  |  \
      D   E   F
```

**Properties**: diameter 2, N-1 edges, minimal connection overhead, but
the hub is a hard single point of failure and a bandwidth bottleneck.
Useful for controlled environments (a single inference cluster behind
one gateway) and as the bootstrap shape before a mesh forms.

### 1.4 Federated

Multiple independent AAFP networks — each with its own trust anchors,
its own DHT, its own seed nodes — interconnected through a small set of
gateway agents. This is the global-scale shape described in
`FEDERATION_TRUST.md`: each org is sovereign, gateways hold cross-org
UCAN delegations, and there is no global root.

```
   [Org A mesh] --- gateway A↔B --- [Org B mesh]
        |                              |
   gateway A↔C                  gateway B↔C
        |                              |
        +------- [Org C mesh] ---------+
```

**Properties**: diameter is the sum of intra-org diameter plus the
inter-org gateway hop count. Trust is not transitive by default — A
trusting B and B trusting C does not imply A trusts C unless an
explicit UCAN chain bridges the gap. The DHT does not span federations;
each org runs its own DHT, and gateways translate lookups across the
boundary.

### 1.5 Comparison Matrix

| Topology | Diameter | Edges | Fault Tolerance | Trust Model | Best Scale |
|----------|----------|-------|-----------------|-------------|-----------|
| Mesh (full) | 1 | N²/2 | Excellent | TOFU, all peers | ≤ 30 |
| Mesh (capped) | N/max | N·max | Good | TOFU | ≤ 500 |
| Hierarchical | log N | N-1 | Poor at root | UCAN delegation | 100–10K |
| Hub-and-spoke | 2 | N-1 | Poor (hub) | CA-anchored | ≤ 100 |
| Federated | intra + hops | intra + gw | Excellent | Bilateral | 1K–100K+ |
| Ring | N/2 | N | Poor (cut) | TOFU | ≤ 50, demo only |
| Random (K-regular) | log N | N·K | Good | TOFU | 100–10K |

---

## 2. DHT Topology: Kademlia-Style Routing

The DHT is the part of AAFP that has the most rigorously defined
topology. It is a Kademlia-style overlay keyed by 256-bit AgentIds,
implemented in `aafp-discovery/src/dht_router.rs`. The overlay sits on
top of whatever physical connection graph the agents form — the DHT
defines *logical* routing, while the underlay (mesh, star, federated)
defines *physical* reachability.

### 2.1 XOR Distance Metric

The core of Kademlia is the XOR distance metric. Each AgentId is a
256-bit (32-byte) value. The distance between two IDs is their bitwise
XOR, which has the properties of a metric space: it is non-negative,
symmetric, and satisfies the triangle inequality. The implementation is
`Distance::between` in `dht_router.rs`:

```rust
pub fn between(a: &AgentId, b: &AgentId) -> Self {
    let mut result = [0u8; 32];
    for (result_byte, (a_byte, b_byte)) in
        result.iter_mut().zip(a.0.iter().zip(b.0.iter())) {
        *result_byte = a_byte ^ b_byte;
    }
    Self(result)
}
```

Capability strings are mapped into the same 256-bit space by SHA-256
hashing (`Distance::to_capability_key`), so a lookup for `"inference"`
is really a lookup for the node whose ID is closest to
`SHA256("inference")`. This unifies node-routing and key-routing into a
single metric space.

### 2.2 K-Buckets

The routing table (`RoutingTable` in `dht_router.rs`) holds 256
k-buckets — one per bit of the 256-bit AgentId. Bucket `i` contains
peers whose XOR distance from `self_id` has its most-significant set
bit at position `i`. The bucket index is computed by
`Distance::bucket_index`, which finds the first non-zero byte and then
the leading-zero count within that byte.

```
Bucket 0   : peers differing in the MSB (farthest, ~half the network)
Bucket 1   : peers differing in bit 1
...
Bucket 254 : peers differing in the second-to-last bit
Bucket 255 : peers differing in the LSB (closest, most numerous in practice)
```

Each bucket holds up to `K_BUCKET_SIZE` (default 20) peer entries,
ordered by insertion — oldest first. This ordering is important for
churn handling: when a bucket is full, a new peer is rejected unless
the oldest peer fails a liveness ping (the production rule; the current
MVP simply rejects, as noted in the `KBucket::insert` comment).

Constants from `dht_router.rs`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `K_BUCKET_SIZE` | 20 | Max peers per bucket (Kademlia default) |
| `ID_BITS` | 256 | Bits in an AgentId |
| `ALPHA` | 3 | Concurrency factor for iterative lookups |
| `REPLICATION_FACTOR` | 5 | Closest peers that store a record |
| `BUCKET_REFRESH_INTERVAL` | 15 min | How often to refresh stale buckets |

### 2.3 Routing Table Structure

```
RoutingTable {
    self_id:  AgentId,           // this node's 256-bit ID
    buckets:  Vec<KBucket>,      // 256 buckets, indexed 0..255
    k:        usize,             // bucket capacity (default 20)
}

KBucket {
    max_size: usize,             // = k
    entries:  Vec<PeerEntry>,    // ordered oldest-first
}

PeerEntry {
    record:   AgentRecord,       // signed identity + capabilities
    last_seen: Instant,          // for liveness / eviction
}
```

The total routing table capacity is `256 × 20 = 5120` peers, but in
practice only a handful of buckets are populated — the buckets
corresponding to the most-significant differing bits are nearly empty
(few peers share your high-order bits), while the low-order buckets
fill up first. `active_bucket_count()` reports how many buckets are
non-empty, a useful health metric.

### 2.4 Iterative Lookup

The primary discovery operation is `find_peers(capability, k)`, an
iterative Kademlia lookup. The algorithm (from `dht_router.rs`
§`find_peers`):

1. Check the local `CapabilityDht` store. If ≥ k results, return.
2. Select the `alpha` (3) closest peers to the capability key from the
   routing table.
3. Send `lookup_on_peer` RPCs to those `alpha` peers in parallel.
4. Each peer returns matching records plus closer peers it knows (via
   PEX).
5. Add returned peers to the routing table; query the next `alpha`
   closest unqueried peers.
6. Repeat until k results are found, no new peers are discovered, or
   `max_lookup_iterations` (10) is hit.

The lookup converges in `O(log N)` rounds with `O(log N)` RPCs per
round, giving `O(log² N)` total RPCs — the standard Kademlia bound.
Results are cached for `cache_ttl` (300s) so repeated lookups for the
same capability are local.

### 2.5 PEX (Peer Exchange)

PEX is the mechanism by which routing tables get populated outside of
lookups. When two agents establish a connection, both sides send a
`aafp.discovery.pex` RPC (`PexParams` in `dht_router.rs`):

```cbor
{ 1: AgentRecord,        // sender's own record
  2: [ *AgentRecord ] }  // peers the sender already knows
```

The receiver adds all received peers to its routing table (after
signature verification) and responds with its own known peers. This is
gossip-style dissemination: each new connection seeds both sides with
referrals, and the routing table fills organically. PEX is also used
inside `find_peers` as the referral channel — each queried peer returns
closer peers via PEX rather than via a separate "closer peers" field.

### 2.6 Replication

When an agent announces a capability (`announce(record)`), the record
is stored locally and forwarded to the `REPLICATION_FACTOR` (5) closest
peers to the capability key. Each of those peers stores the record in
its own local DHT. This means a record lives on `1 + 5 = 6` nodes by
default, so the loss of any single node does not lose the record.
Replication is best-effort: if fewer than 5 peers are known, the record
is stored on fewer replicas.

---

## 3. Connection Graph Analysis

The connection graph is the *physical* graph: nodes are agents, edges
are open QUIC connections. This is distinct from the DHT routing graph,
which is logical. The two coincide only in a full mesh.

### 3.1 Degree Distribution

In the load-test topologies (`topology.rs`):

- **Mesh (capped)**: regular graph, every node has out-degree
  `min(max_connections_per_agent, N-1)`. Degree distribution is a delta
  function. Total edges = `N × max`.
- **Star**: one node has in-degree N-1, all others have out-degree 1.
  Heavy-tailed (a single hub).
- **Ring**: every node has out-degree 1 and in-degree 1. Total edges =
  N.
- **Random (K-regular)**: every node has out-degree K. Degree
  distribution is a delta at K. Generated with a deterministic LCG so
  runs are reproducible.

In a real Kademlia overlay, the *logical* degree distribution is
determined by the k-bucket structure: each node has at most
`256 × K_BUCKET_SIZE = 5120` logical neighbors, but the actual count
depends on network size. For N nodes, the expected number of populated
buckets is `log₂ N`, giving an expected logical degree of
`K_BUCKET_SIZE × log₂ N`. For N=1000, that is `20 × 10 = 200` logical
neighbors per node.

### 3.2 Clustering Coefficient

The clustering coefficient C of a graph measures how tightly a node's
neighbors are interconnected among themselves.

- **Full mesh**: C = 1 (everyone knows everyone).
- **Capped mesh**: C ≈ `max / N` — low for large N, since your
  neighbors are unlikely to also be neighbors of each other.
- **Star**: C = 0 (spokes never connect to each other).
- **Ring**: C = 0 (your neighbor's neighbor is not your neighbor).
- **Random K-regular**: C ≈ `K / N` — vanishes for large N.
- **Kademlia overlay**: C is low by design. Kademlia's XOR metric does
  not produce clustered neighborhoods — two nodes close to you are not
  necessarily close to each other. This is a feature: low clustering
  means lookups spread rapidly rather than getting stuck in a clique.

### 3.3 Small-World Properties

A graph is "small-world" if it has high clustering (like a lattice) but
low diameter (like a random graph). AAFP's pure topologies are
*either/or*:

- Mesh: low diameter, but also low clustering at scale → not
  small-world, just dense.
- Ring: high clustering locally, but diameter N/2 → not small-world.
- Random: low diameter (log N), low clustering → "random-world," the
  routing-efficient but socially-flat case.

The *practical* AAFP network is small-world because of the DHT overlay:
agents form a capped mesh or random underlay (giving local clustering
via PEX gossip among nearby peers) *plus* the Kademlia overlay (giving
long-range "shortcut" edges via k-bucket routing). The combination is
exactly the Watts-Strogatz small-world construction: a regular local
graph plus a few long-range edges. The long-range edges in AAFP are the
high-index k-bucket entries — peers in bucket 0 are on the opposite side
of the ID space, providing the shortcut.

**Measured**: the DHT scales to 500 nodes with 100% lookup success
(per `AGENTS.md` and the multi-node DHT tests in `aafp-tests`).
Lookups converge in `O(log N)` hops, which for N=500 is ~9 hops —
firmly in small-world territory.

### 3.4 Diameter

| Topology | Diameter (N nodes) |
|----------|-------------------|
| Full mesh | 1 |
| Capped mesh (max=m) | `ceil(N / m)` |
| Star | 2 |
| Ring | `floor(N / 2)` |
| Random K-regular | `O(log N / log K)` |
| Kademlia overlay | `O(log N)` |

---

## 4. Agent Relationship Graph

There are *three* distinct relationship graphs in AAFP, and conflating
them is a common source of confusion.

### 4.1 Connection Graph (Physical)

Who has an open QUIC stream to whom. Edges are bidirectional (QUIC
streams are unidirectional, but a connection implies both directions are
possible). This is the graph the load-test topology generators produce.
It changes on every connect/disconnect.

### 4.2 Capability Dependency Graph (Semantic)

Defined in `aafp-discovery/src/semantic/graph.rs` and
`semantic/edge.rs`. Nodes are `(capability, agent)` pairs — a specific
agent offering a specific capability. Edges are typed:

| EdgeType | Meaning | Example |
|----------|---------|---------|
| `Requires` | Source cannot function without target | `code-exec` requires `sandbox` |
| `Enables` | Source unlocks / makes target possible | `auth` enables `admin-api` |
| `Precedes` | Source must run before target | `fetch-data` precedes `train-model` |
| `Alternative` | Target is a substitute for source | `openai-inference` alternative `anthropic-inference` |
| `Specializes` | Source is a specialized form of target | `gpu-inference` specializes `inference` |

The graph is stored as an adjacency list keyed by source capability
name, with a reverse-adjacency map for requirement resolution and
topological sort (used by the pipeline planner in `semantic/planner.rs`).
This graph is *static* — it describes capability relationships, not
runtime call patterns — but it drives pipeline assembly.

### 4.3 Trust Graph

Defined in `aafp-identity/src/web_of_trust.rs` and `trust_manager.rs`
(RFC 0011). Nodes are agents; edges are trust signatures (one agent
signing another's identity, attesting "I vouch for this agent"). The
graph is directed and weighted by trust score. Three trust modes coexist:

- **Web of Trust (TOFU)**: transitive trust. If A trusts B and B trusts
  C, A may extend limited trust to C with a decay factor. The trust
  score is computed by walking the graph up to a configurable depth.
- **CA-signed certificates**: hierarchical trust. A root CA signs
  intermediate CAs, which sign agent identities. The graph is a tree.
- **Key rotation / directories**: the `KeyDirectory`
  (`aafp-identity/src/key_directory.rs`) maps AgentId → current
  AgentRecord, with monotonic version enforcement to prevent rollback.

### 4.4 Runtime Call Graph (Who Calls Whom)

At runtime, when agent A invokes a capability on agent B, a directed
edge `A → B` is formed in the call graph. This graph is *not* stored
persistently in the current implementation, but it can be reconstructed
from `AgentMetrics` (`aafp-sdk/src/metrics.rs`), which tracks
per-peer message counts and bytes. The call graph typically mirrors the
capability dependency graph: if `code-exec` requires `sandbox`, then
the agent offering `code-exec` will have call edges to agents offering
`sandbox`.

### 4.5 Putting the Three Together

```
  Trust graph          Capability dep graph       Runtime call graph
  (who vouches for     (what needs what)          (who actually calls
   whom)                                          whom at runtime)

  A --trusts--> B      code-exec --requires-->    A --calls--> C
  B --trusts--> C      sandbox                    A --calls--> D
                                                (because A offers code-exec
                                                 which requires sandbox,
                                                 offered by C and D)
```

The trust graph gates *whether* a call is allowed (via UCAN
delegation). The capability graph determines *what* calls are needed.
The call graph is the runtime realization, constrained by both.

---

## 5. Topology Visualization Tools

### 5.1 `aafp topology` Command (Proposed)

The CLI does not currently ship a `topology` subcommand, but the
building blocks exist. A proposed command would:

1. Query the local `DhtRouter::all_peers()` to get the routing table.
2. Query `RoutingTable::bucket(i)` for each bucket to get per-bucket
   fill.
3. Emit the graph in one of three formats: Graphviz DOT, JSON (for
   D3.js), or an ASCII rendering for terminal use.

Sketch:

```
$ aafp topology --format dot
digraph aafp {
  "self" [shape=doublecircle];
  "self" -> "peer_0x1a2b..." [label="bucket 240"];
  "self" -> "peer_0x3c4d..." [label="bucket 251"];
  ...
}

$ aafp topology --format ascii
        ┌──────────────┐
        │  self (0xab) │
        └──────┬───────┘
           bucket 240 │ bucket 251
   ┌─────────┼─────────────┐
   ▼         ▼             ▼
 peer_1a2b peer_3c4d   peer_5e6f
 (3 peers) (7 peers)  (20 peers)
```

### 5.2 Graphviz DOT Export

The DOT format is the simplest interchange. Each agent is a node; each
DHT routing-table entry is a directed edge labeled with the bucket
index. Rendering with `dot -Tsvg topology.dot -o topology.svg`
produces a static diagram suitable for documentation. For large
networks, `fdp` or `sfdp` layouts scale better than `dot`.

### 5.3 D3.js Force-Directed Visualization

For interactive exploration, a JSON export feeding a D3.js
force-directed graph is the standard approach. The JSON shape:

```json
{
  "nodes": [
    {"id": "0xab...", "capabilities": ["inference"], "region": "us-east"},
    {"id": "0xcd...", "capabilities": ["sandbox"], "region": "europe"}
  ],
  "links": [
    {"source": "0xab...", "target": "0xcd...", "bucket": 251, "type": "dht"}
  ]
}
```

A force-directed layout naturally clusters agents by capability
(because capability-adjacent agents have more DHT edges between them)
and separates regions (because regional peers have lower-latency, more
stable connections). This is the recommended visualization for
operator dashboards.

### 5.4 Metrics-Driven Health Views

`AgentMetrics` (`aafp-sdk/src/metrics.rs`) exposes lock-free
AtomicU64 counters for connections, messages, bytes, handshakes, DHT
records, and uptime, plus a `HealthStatus` (Healthy / Degraded /
Unhealthy). A topology view overlaid with health status colors nodes
green / yellow / red, letting operators spot degraded clusters at a
glance. This pairs naturally with the D3.js view.

---

## 6. Network Partition Tolerance

Network partitions — where the network splits into two or more
islands that cannot reach each other — are a first-class concern in
AAFP because it is a peer-to-peer system with no central coordinator.
The DHT layer implements explicit partition detection and
reconciliation in `dht_router.rs` (Track R6).

### 6.1 Partition Detection

`DhtRouter::detect_partition(threshold)` pings every peer in the
routing table. If the fraction of unreachable peers exceeds
`threshold` (e.g., 0.5), the network is considered partitioned from
this node's perspective. The method returns
`(total_peers, reachable_peers, is_partitioned)`.

```rust
pub async fn detect_partition(&self, threshold: f64) -> (usize, usize, bool)
```

This is a local view — a node can believe it is partitioned when in
fact only its own network link is down. Correlating across multiple
nodes' views (via a gossip protocol or an out-of-band monitoring
channel) distinguishes a true partition from a single-node outage.

### 6.2 Behavior During a Split

When a partition occurs, each island continues to operate
independently:

- **DHT lookups** succeed within the island if the capability is
  offered by an agent in the same island. Lookups for capabilities
  only offered in the other island return empty results (the iterative
  lookup exhausts the local routing table and converges without
  finding the key).
- **Announces** are replicated only within the local island (the
  `REPLICATION_FACTOR` closest peers are all local). When the
  partition heals, the record exists in both islands but may have
  diverged versions.
- **Sessions** in progress across the split stall. QUIC connections
  time out; the `CloseManager` (`aafp-messaging::close_manager`)
  eventually transitions them to `Closed`. New sessions cannot be
  established across the split.
- **Trust** is unaffected — trust is a local graph property, not a
  network property. UCAN delegations remain valid; they just cannot
  be exercised across the split.

### 6.3 Reconciliation After Healing

`DhtRouter::reconcile_after_partition()` is called once
`is_partition_healed(threshold)` returns true. It:

1. Calls `refresh_from_peers()` — requests all records from every
   reachable peer via the `refresh_on_peer` RPC and merges them into
   the local DHT.
2. Calls `republish_own_record()` — re-announces this node's own
   record to the `REPLICATION_FACTOR` closest peers, ensuring it is
   re-replicated into the now-healed network.
3. Invalidates the entire lookup cache, forcing fresh lookups.

Conflict resolution is last-writer-wins by record timestamp (the
`AgentRecord` carries a monotonic version enforced by `KeyDirectory`).
This is acceptable because records are signed and versioned; a
stale-but-signed record is valid, just superseded.

### 6.4 Split-Brain Risk

The main split-brain risk is *announce divergence*: two agents in
different islands announce the same capability with different records
(e.g., an agent that migrated across the split). On heal, both records
exist in the merged DHT. The lookup returns both; the caller picks the
one with the higher version number. This is safe because records are
signature-bound to a single AgentId — you cannot forge a record for
someone else's agent, so the worst case is two valid records for the
same agent with different versions, and the higher version wins.

---

## 7. Optimal Topology by Use Case

### 7.1 Startup (Small Mesh)

**Scale**: 2–30 agents. **Topology**: full mesh, everyone knows
everyone.

At this scale the DHT is unnecessary overhead — every agent can hold
every other agent's record directly. The recommended configuration:

- `K_BUCKET_SIZE` can stay at 20; with N ≤ 30, all peers fit in a
  single bucket.
- Bootstrap against any one peer; PEX fills the rest in one round.
- No regional grouping needed; latency differences are negligible.
- Trust: TOFU (Web of Trust). Every agent signs every other agent on
  first contact.

```
  A --- B --- C
  |  \  |  /  |
  D --- E --- F
```

**Why mesh**: diameter 1 means zero routing hops. Discovery is O(1).
The cost is N²/2 connections, which for N=30 is 435 — trivial.

### 7.2 Enterprise (Hierarchical)

**Scale**: 100–10,000 agents across departments. **Topology**:
hierarchical clusters with team-lead bridges.

Each department runs a local mesh (or capped mesh) of its agents. One
or two "team lead" agents per department maintain connections to team
leads in other departments, forming a sparse inter-department graph.
The org root trust anchor sits above all team leads.

```
              [Org Root CA]
             /      |      \
         [Eng TL] [Sales TL] [Ops TL]
          /  \      |    \     /  \
        A    B     C     D    E    F
       (mesh)    (mesh)    (mesh)
```

**Why hierarchical**: mirrors the org chart, matches UCAN delegation
flow (root → TL → agent), limits cross-department traffic. Each
department's DHT is local; cross-department lookups go through the TL
bridge agents, which act as DHT gateways. Trust is CA-anchored at the
org root.

### 7.3 Global (Federated)

**Scale**: 1,000–100,000+ agents across organizations and continents.
**Topology**: federated regional clusters with gateway agents.

Each region (US-East, Europe, APAC — per `regional.rs`'s `Region` enum)
runs its own DHT. Regional clusters are interconnected through a small
set of gateway agents that hold cross-org UCAN delegations. No global
DHT exists; lookups are first local, then forwarded to gateways if the
capability is not found regionally.

```
  [US-East cluster] --- gw --- [Europe cluster] --- gw --- [APAC cluster]
     (own DHT,               (own DHT,              (own DHT,
      own trust anchor)       own trust anchor)      own trust anchor)
```

**Why federated**: sovereignty (each org controls its own trust),
latency (regional DHT lookups are fast; cross-region is rare), and
scalability (no single DHT must hold 100K agents' records). The
`RegionalDiscovery` struct in `regional.rs` provides the region
grouping; `find_closest(target_region, limit)` returns same-region
agents first, then spills to other regions.

### 7.4 Edge (Tree Topology)

**Scale**: 10,000–1,000,000+ agents, mostly constrained sensors.
**Topology**: tree — sensors → edge gateways → regional cloud →
central cloud.

Sensors are low-power, high-churn, and cannot run a full DHT node.
They connect to a single edge gateway (star topology at the leaf
level). Edge gateways form a mesh among themselves and connect upward
to regional cloud agents, which in turn connect to a central cloud.

```
                    [Central Cloud]
                    /      |      \
            [Region US] [Region EU] [Region AP]
              / \          / \         / \
           [gw] [gw]    [gw] [gw]   [gw] [gw]
          /| \  /|\    /| \  /|\   /| \  /|\
         s s s s s s  s s s s s s s s s s s
```

**Why tree**: matches the physical network (sensors are close to their
gateway, gateways are close to each other, cloud is far). Sensors do
not participate in the DHT — they announce their capabilities to their
gateway, which acts as their DHT proxy. This keeps the DHT node count
low (only gateways and cloud agents) while supporting a huge sensor
fleet. Churn at the sensor level does not destabilize the DHT because
sensors are not DHT nodes.

---

## 8. Topology Evolution

AAFP networks grow organically. The topology at day 1 is rarely the
topology at day 100. The evolution typically follows this path:

### 8.1 Phase 1: Bootstrap (N = 1–5)

A new agent connects to seed nodes (`bootstrap.rs`,
`BootstrapConfig::seed_nodes`). The default seeds are
`quic://seed1.aafp.io:4433`, `seed2`, `seed3`. The agent exchanges PEX
with each seed and populates its routing table. At this point the
topology is a star: the new agent at the center, seeds as spokes.

### 8.2 Phase 2: Mesh Formation (N = 5–30)

As more agents join via the same seeds, PEX gossip propagates peer
lists. Each new connection seeds both sides with referrals. Within a
few rounds, every agent knows every other agent — the star has become
a mesh. The DHT routing table is sparse (most buckets empty) but
functional because lookups can fall back to broadcasting to all known
peers.

### 8.3 Phase 3: Capped Mesh / Random (N = 30–500)

As N grows past ~30, maintaining N-1 connections per agent becomes
wasteful. Agents naturally cap their connection count
(`max_connections_per_agent` in load-test config, default 10). The
topology becomes a capped mesh or, if connections are chosen by
latency, a random K-regular graph. The DHT routing table starts to
fill multiple buckets; lookups become truly iterative rather than
broadcast.

### 8.4 Phase 4: Regional Clustering (N = 500–5,000)

Latency starts to dominate. `RegionalDiscovery` groups agents by
latency buckets (≤50ms = US-East, 51–100ms = US-West, etc.). Agents
prefer same-region connections, so the topology develops regional
clusters with sparse inter-region links. This is the small-world
regime: high local clustering (within a region) plus long-range
shortcuts (inter-region DHT edges).

### 8.5 Phase 5: Federation (N = 5,000+)

At this scale, a single trust anchor and a single DHT become
operational liabilities. The network federates: organizations
establish gateway agents, each org runs its own DHT, and cross-org
lookups go through gateways. The topology is now a *graph of clusters*
rather than a graph of agents. This is the terminal state for global
deployments.

### 8.6 Evolution Summary

| Phase | N | Topology | DHT Role | Trust |
|-------|---|----------|----------|-------|
| Bootstrap | 1–5 | Star | Degenerate | TOFU |
| Mesh | 5–30 | Full mesh | Broadcast fallback | TOFU |
| Capped mesh | 30–500 | Capped / random | Iterative lookup | TOFU + WoT |
| Regional | 500–5K | Clustered small-world | Full Kademlia | WoT + CA |
| Federated | 5K+ | Graph of clusters | Per-org DHT | Federated CA |

---

## 9. Churn Analysis

Churn — agents joining and leaving — is the primary stress on a DHT.
AAFP's churn handling is implemented in `dht_router.rs` (Track R4).

### 9.1 Joining

A new agent:

1. Generates an `AgentKeypair` (ML-DSA-65) and derives its `AgentId`.
2. Creates an `AgentRecord` with its capabilities and endpoints.
3. Connects to seed nodes and runs PEX to populate its routing table.
4. Calls `announce(record)` to store its record on the
   `REPLICATION_FACTOR` closest peers.
5. Calls `refresh_from_peers()` to pull records from its new neighbors.

The join is complete when the agent's record is replicated and it can
resolve lookups. With α=3 and log N iterations, a join takes
`O(log N)` RPC rounds — for N=1000, roughly 10 rounds × ~50ms RTT =
~500ms.

### 9.2 Leaving (Graceful)

A graceful departure calls `DhtRouter::depart()`, which:

1. Sends a `depart_on_peer` RPC to all peers in the routing table.
2. Each peer removes the departing agent's records from its local DHT
   and routing table.
3. The departing agent removes its own record from its local DHT and
   invalidates its cache.

Graceful departure is fast (one round of RPCs) and leaves no stale
records. The `REPLICATION_FACTOR - 1` other replicas of the departing
agent's record remain on the closest peers, so the capability is not
lost — but the replication count drops by one. A periodic
republish from the original agent is not possible (it has left), so
the record will eventually expire unless another agent re-announces
it.

### 9.3 Leaving (Ungraceful / Crash)

If an agent crashes without calling `depart()`, its records persist on
its replicas until their TTL expires. The routing table entries
pointing to it go stale. `check_peer_liveness(max_missed)` pings all
peers; peers that fail are removed from the routing table (after
`max_missed` consecutive failures, or immediately if `max_missed == 0`
in the current MVP).

### 9.4 DHT Stabilization Time

After a churn event (join or leave), the DHT needs time to stabilize:

- **Join**: the new agent's record must be replicated to 5 peers, and
  other agents' routing tables must learn about the new agent via PEX.
  Stabilization: `O(log N)` rounds for replication, plus the PEX
  gossip interval (one PEX per new connection).
- **Leave (graceful)**: immediate — depart RPCs are synchronous.
- **Leave (crash)**: bounded by the liveness check interval and the
  record TTL. With a 15-minute bucket refresh and a default record TTL
  (typically 1 hour), a crashed agent's records linger for up to 1
  hour and its routing-table entries linger until the next liveness
  check.

### 9.5 Churn Rate vs. Stability

The DHT remains stable as long as the churn rate is well below the
stabilization rate. Empirically (per `AGENTS.md`), the implementation
scales to 500 nodes with 100% lookup success. The theoretical churn
tolerance is:

- Each lookup touches `O(log N)` nodes. If the per-node churn rate is
  `r` (fraction of nodes leaving per stabilization interval), the
  probability that all `log N` nodes in a lookup path are stable is
  `(1 - r)^{log N}`. For 99% lookup success at N=1000 (log N ≈ 10),
  `r` must be below ~0.1% per stabilization interval — i.e., fewer
  than 1 node in 1000 leaves between refreshes.

### 9.6 Churn by Use Case

| Use case | Churn rate | Mitigation |
|----------|-----------|------------|
| Startup | Very low (stable servers) | None needed |
| Enterprise | Low (planned restarts) | Graceful depart |
| Global | Medium (orgs join/leave) | Gateway redundancy |
| Edge | High (sensors sleep/wake) | Sensors are not DHT nodes; gateways absorb churn |

The edge case is notable: by keeping sensors out of the DHT (they
announce through their gateway), the DHT's effective churn rate stays
low even when the sensor fleet has high churn. This is the key design
insight for edge deployments.

---

## 10. Concrete Topology Diagrams

### 10.1 10-Agent Network (Startup Mesh)

Full mesh, every agent connects to every other. 45 bidirectional
edges. DHT is degenerate (all peers in one or two buckets).

```
        A ───── B
        │ \   / │
        │  \ /  │
        D ── X ── C
        │  / \  │
        │ /   \ │
        E ───── F
       / \     / \
      G   H   I   J
```

- Connections: 45 (full mesh) or 10×max (capped at max=5 → 50 directed).
- DHT buckets populated: ~4 (log₂ 10 ≈ 3.3).
- Lookup hops: 1 (everyone is a direct peer).
- Trust: TOFU, all-pairs signatures.
- Bootstrap: connect to any one agent, PEX fills the rest.

### 10.2 100-Agent Network (Enterprise Hub-and-Spoke)

Star topology with a replicated hub, or a two-level hierarchy. The
load-test `agents_100()` config uses `Topology::Star`.

```
                    [Hub A] ←─── [Hub B]   (hub-to-hub link)
                   /    |    \      |
                 /      |      \    |
               A1      A2       A3  B1..B50
              / \      / \      / \
            A1a A1b  A2a A2b  A3a A3b
            ... (50 agents under Hub A)
```

- Connections: 99 (star) or ~200 (two hubs + spokes).
- DHT buckets populated: ~7 (log₂ 100 ≈ 6.6).
- Lookup hops: 2 (spoke → hub → spoke) or 3 (cross-hub).
- Trust: CA-anchored at the org root; hubs hold delegation chains.
- Bottleneck: hub bandwidth. Mitigate with 2–3 replicated hubs.

### 10.3 1,000-Agent Network (Regional Federated)

Three regional clusters of ~333 agents each, connected through
gateway agents. Each region runs its own DHT.

```
   ┌─────────────────┐     gw      ┌─────────────────┐
   │  US-East cluster │←──────────→│  Europe cluster  │
   │  ~333 agents     │             │  ~333 agents     │
   │  own DHT         │             │  own DHT         │
   │  own trust CA    │             │  own trust CA    │
   └────────┬─────────┘             └────────┬─────────┘
            │ gw                              │ gw
            └──────────┐    ┌─────────────────┘
                       ▼    ▼
              ┌─────────────────┐
              │  APAC cluster   │
              │  ~333 agents    │
              │  own DHT        │
              └─────────────────┘
```

- Connections per agent: ~20 (K_BUCKET_SIZE within region) + 2–3
  gateway links.
- DHT buckets populated: ~10 (log₂ 333 ≈ 8.4) per region.
- Lookup hops: ~9 within region (log₂ 333), +1–2 for cross-region via
  gateway.
- Trust: per-region CA; gateways hold cross-region UCAN delegations.
- Total DHT nodes: 1,000 (all agents participate).
- Gateway load: moderate — only cross-region lookups traverse
  gateways.

### 10.4 100,000-Agent Network (Global Federated + Edge)

100K agents is beyond a single DHT. The deployment is a federation of
~100 orgs, each running ~1,000 agents, plus a large edge sensor fleet
that does not participate in the DHT directly.

```
  [Federation of 100 orgs]
   each org: ~1,000 agents, own DHT, own trust CA
   orgs interconnected via 2–4 gateway agents each

  [Edge layer: 900K sensors]
   sensors → edge gateways (star, per-gateway ~100 sensors)
   edge gateways → org DHT (gateways are DHT nodes, sensors are not)

  Total DHT nodes: ~100,000 (org agents + gateways)
  Total non-DHT agents: ~900,000 (sensors)
```

- DHT nodes: 100K. DHT buckets populated: ~17 (log₂ 100K ≈ 16.6).
- Lookup hops within an org: ~10. Cross-org via gateway: +2–3.
- Gateway fan-in: each gateway handles ~100 sensors + cross-org
  lookups for its org.
- Trust: 100 independent CAs, cross-signed via gateway UCAN chains.
- Churn: sensor churn is high but invisible to the DHT. Org-agent
  churn is low. Gateway churn is the critical path — each org runs
  2–4 gateways for redundancy.
- Partition tolerance: an org disconnecting from the federation
  continues to operate internally; reconnection triggers
  `reconcile_after_partition()` on the gateways.

**Scaling math**: at 100K DHT nodes with K=20 and log N ≈ 17 buckets
populated, each node holds ~340 routing-table entries. Total routing
state across the network: 100K × 340 = 34M entries, distributed —
~340 entries per node, ~680 bytes per entry (AgentRecord is small),
so ~2KB of routing state per node. Trivial.

---

## 11. Implementation Reference

### 11.1 Key Files

| File | Role |
|------|------|
| `aafp-discovery/src/dht_router.rs` | Kademlia routing table, k-buckets, iterative lookup, PEX, announce, churn, partition detection/reconciliation |
| `aafp-discovery/src/regional.rs` | Latency-based region grouping (`Region` enum, `RegionalDiscovery`) |
| `aafp-discovery/src/bootstrap.rs` | Seed-node bootstrap (`BootstrapConfig`, `BootstrapDiscovery`) |
| `aafp-discovery/src/discovery_v1.rs` | RFC-compliant capability DHT (sharded, rate-limited) |
| `aafp-discovery/src/persistent_dht.rs` | SQLite-backed DHT persistence |
| `aafp-discovery/src/semantic/graph.rs` | Capability dependency graph (adjacency list) |
| `aafp-discovery/src/semantic/edge.rs` | `EdgeType` enum: Requires / Enables / Precedes / Alternative / Specializes |
| `aafp-discovery/src/semantic/planner.rs` | Pipeline planner (topological sort over capability graph) |
| `aafp-loadtest/src/topology.rs` | Mesh / Star / Ring / Random edge generators |
| `aafp-loadtest/src/config.rs` | `Topology` enum, `LoadTestConfig` |
| `aafp-identity/src/trust_manager.rs` | Unified trust decision API (RFC 0011 §8) |
| `aafp-identity/src/web_of_trust.rs` | Transitive trust graph, trust scoring |
| `aafp-identity/src/key_directory.rs` | AgentId → AgentRecord directory, monotonic versioning |
| `aafp-sdk/src/metrics.rs` | Lock-free `AgentMetrics`, `HealthStatus` |

### 11.2 Key Constants

| Constant | Location | Value |
|----------|----------|-------|
| `K_BUCKET_SIZE` | `dht_router.rs` | 20 |
| `ID_BITS` | `dht_router.rs` | 256 |
| `ALPHA` | `dht_router.rs` | 3 |
| `REPLICATION_FACTOR` | `dht_router.rs` | 5 |
| `BUCKET_REFRESH_INTERVAL` | `dht_router.rs` | 15 min |
| `cache_ttl` (lookup cache) | `DhtRouter` | 300 s |
| `max_lookup_iterations` | `DhtRouterConfig` | 10 |
| `max_connections_per_agent` | `LoadTestConfig` | 10 (default) |
| `random_degree` | `LoadTestConfig` | 5 (default) |

### 11.3 Regions (`regional.rs`)

| Region | Latency range | Label |
|--------|--------------|-------|
| UsEast | 0–50 ms | `us-east` |
| UsWest | 51–100 ms | `us-west` |
| Europe | 101–150 ms | `europe` |
| AsiaPacific | 151–200 ms | `asia-pacific` |
| SouthAmerica | — | `south-america` |
| Africa | — | `africa` |
| Oceania | 201–300 ms | `oceania` |
| Unknown | >300 ms | `unknown` |

### 11.4 Load-Test Topologies (`config.rs`)

| `Topology` variant | Edge generator | Edge count |
|--------------------|---------------|------------|
| `Mesh` (default) | `generate_mesh` | `N × min(max, N-1)` |
| `Star` | `generate_star` | `N - 1` |
| `Ring` | `generate_ring` | `N` |
| `Random` | `generate_random` (deterministic LCG) | `N × K` |

### 11.5 Partition Handling API (`dht_router.rs`)

| Method | Purpose |
|--------|---------|
| `detect_partition(threshold)` | Ping all peers; return `(total, reachable, is_partitioned)` |
| `is_partition_healed(threshold)` | True if reachable fraction ≥ threshold |
| `reconcile_after_partition()` | Refresh from peers + republish own record + invalidate cache |
| `check_peer_liveness(max_missed)` | Ping all peers; remove unreachable after `max_missed` |
| `depart()` | Graceful leave: notify all peers, remove own records |
| `repair_routing_table()` | PEX with all peers to refill underfilled buckets |

### 11.6 Reproducing the Diagrams

The load-test harness can generate each topology for benchmarking:

```bash
# 10-agent mesh
cargo run --release --bin loadtest -- --agents 10 --topology mesh

# 100-agent star
cargo run --release --bin loadtest -- --agents 100 --topology star

# 1000-agent random
cargo run --release --bin loadtest -- --agents 1000 --topology random \
  --random-degree 20

# 1000-agent mesh capped at 20 connections
cargo run --release --bin loadtest -- --agents 1000 --topology mesh \
  --max-connections 20
```

For topology visualization, the proposed `aafp topology` command (see
§5) would emit DOT or JSON from a running agent's routing table. Until
that command exists, the routing table can be inspected via
`DhtRouter::all_peers()` and `RoutingTable::bucket(i)` programmatically,
and the load-test `metrics.rs` module captures per-agent connection
counts that can be post-processed into a graph.

---

## Appendix A: Glossary

- **Underlay**: the physical connection graph (who has open QUIC
  connections to whom).
- **Overlay**: the logical routing graph (the DHT, keyed by XOR
  distance).
- **K-bucket**: a slot in the Kademlia routing table holding up to K
  peers at a given XOR distance range.
- **XOR distance**: `id1 ⊕ id2`, the Kademlia metric. Closer XOR
  distance means more shared high-order bits.
- **PEX**: Peer Exchange — gossip protocol that propagates peer lists
  on each new connection.
- **Churn**: the rate at which agents join and leave the network.
- **Stabilization**: the process by which the DHT recovers from churn
  (replication, bucket refresh, liveness checks).
- **Federation**: interconnecting independent AAFP networks via gateway
  agents with cross-org UCAN delegations.
- **Small-world**: a graph with high local clustering and low global
  diameter — the natural shape of a Kademlia overlay on a capped mesh.
- **Diameter**: the longest shortest path between any two nodes.
- **Clustering coefficient**: the fraction of a node's neighbors that
  are also neighbors of each other.

## Appendix B: Theoretical Bounds

| Property | Bound | Notes |
|----------|-------|-------|
| DHT lookup hops | `O(log N)` | Kademlia, α=3, K=20 |
| DHT lookup RPCs | `O(log² N)` | α × log N per round × log N rounds |
| Routing table size | `O(log N)` populated buckets × K | = `K × log N` entries |
| Join time | `O(log N)` RPC rounds | announce + PEX |
| Stabilization after crash | `O(TTL)` | bounded by record TTL |
| Partition detection | `O(N_routing)` pings | = routing table size |
| Mesh edge count | `O(N × max)` | capped mesh |
| Full mesh edge count | `O(N²)` | impractical past ~30 |
| Federated lookup | `O(log N_org) + O(log N_region)` | gateway hop + intra-org |

---

*This document covers AAFP network topology as implemented in the Rust
workspace under `implementations/rust/crates/aafp-discovery/` and
`aafp-loadtest/`. For the federation trust model that governs
cross-org topology, see `FEDERATION_TRUST.md`. For edge deployment
topology, see `EDGE_IOT_DEPLOYMENT.md`. For load-test topology
benchmarks, see `PERFORMANCE_SCALABILITY.md`.*
