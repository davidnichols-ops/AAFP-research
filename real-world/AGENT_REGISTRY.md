# AAFP Agent Registry & Discovery Service

> **Status:** Design proposal / research document
> **Scope:** Real-world deployment of AAFP agent discovery at internet scale
> **Related code:** `implementations/rust/crates/aafp-discovery/`, `aafp-identity/`
> **Related RFCs:** RFC-0004 (Discovery), RFC-0003 (Identity), RFC-0011 (Trust)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [DHT-Only Discovery: What Exists Today](#2-dht-only-discovery-what-exists-today)
3. [Limitations of DHT-Only Discovery](#3-limitations-of-dht-only-discovery)
4. [Agent Registry: Design Overview](#4-agent-registry-design-overview)
5. [Registry API: Search Dimensions](#5-registry-api-search-dimensions)
6. [Registry as an AAFP Agent](#6-registry-as-an-aafp-agent)
7. [Self-Registration Protocol](#7-self-registration-protocol)
8. [Registry Verification](#8-registry-verification)
9. [Registry Reputation](#9-registry-reputation)
10. [Registry Federation](#10-registry-federation)
11. [Public vs Private Registries](#11-public-vs-private-registries)
12. [Registry Caching](#12-registry-caching)
13. [Registry vs DHT: When to Use Which](#13-registry-vs-dht-when-to-use-which)
14. [Anti-Abuse Measures](#14-anti-abuse-measures)
15. [Concrete API Design](#15-concrete-api-design)
16. [Example Queries](#16-example-queries)
17. [Implementation Roadmap](#17-implementation-roadmap)

---

## 1. Executive Summary

The AAFP protocol currently provides peer-to-peer discovery via a
Kademlia-style Distributed Hash Table (DHT) keyed by capability strings.
This works well for small-to-medium networks where an agent already knows
which capability it needs and is willing to tolerate eventual consistency.
However, the DHT alone cannot support the full range of discovery
use cases that real-world deployments demand: multi-dimensional search
(by language, region, cost, reputation), ranked results, verified
listings, and a human-browsable directory.

This document proposes an **Agent Registry** — a curated, searchable
directory of AAFP agents that complements the DHT. The registry is
itself an AAFP agent (exposing the `aafp.registry.search` capability),
accepts self-registrations from agents, verifies that registrants are
reachable and match their advertised capabilities, aggregates reputation
from third-party attestations, and federates with other registries to
avoid a single point of control.

The registry is not a replacement for the DHT. The two serve different
layers of the discovery stack:

| Layer | Mechanism | Latency | Consistency | Query Power |
|-------|-----------|---------|-------------|-------------|
| **Directory** | Registry | Seconds-minutes | Strong (curated) | Multi-dimensional, ranked |
| **Real-time** | DHT | Sub-second | Eventual | Exact capability match |

Agents use the registry to *find* candidate peers; they use the DHT to
*track* peers that have gone offline or come online since the registry
was last updated.

---

## 2. DHT-Only Discovery: What Exists Today

The Rust implementation in `aafp-discovery/` provides a complete
Kademlia-style DHT. The key components are:

### 2.1 Capability DHT (`discovery_v1.rs`)

The core store is `CapabilityDht`, an in-memory index mapping capability
names to sets of `AgentId`s:

```rust
// discovery_v1.rs:246
pub struct CapabilityDht {
    index: HashMap<String, HashSet<[u8; 32]>>,   // capability_name -> AgentIds
    records: HashMap<[u8; 32], AgentRecord>,      // AgentId -> AgentRecord
}
```

Records are inserted via `put()` (called `announce` on the wire) and
retrieved via `get(capability)` (called `lookup`). The DHT enforces:

- **Monotonic versioning**: a newer record (higher `created_at`) replaces
  an older one for the same `AgentId` (line 267-270).
- **Max records cap**: `MAX_RECORDS = 100_000` per node (line 35).
- **Expiry eviction**: `evict_expired(now)` removes records past their
  `expires_at` timestamp (line 355).

A **256-way sharded** variant (`ShardedCapabilityDht`, line 450) uses
per-shard `RwLock`s so that `put()` on one shard does not block `get()`
on another, eliminating the single-lock bottleneck.

### 2.2 Kademlia Routing (`dht_router.rs`)

`DhtRouter` adds multi-node routing on top of the local DHT:

- **256 k-buckets** keyed by XOR distance from `self_id` (line 234).
- **Iterative lookup** with α=3 concurrency: query the 3 closest known
  peers, follow referrals, iterate until k results found (line 17-23).
- **Replication**: records are forwarded to the `REPLICATION_FACTOR=5`
  closest peers for fault tolerance (line 54).
- **PEX (Peer Exchange)**: `aafp.discovery.pex` RPC exchanges peer lists
  to build the routing table (line 26-28).
- **Lookup cache**: a TTL-based cache (default 300s) avoids repeated
  network lookups for the same capability (line 622-624).

### 2.3 RPC Handler (`rpc_handler.rs`)

`DiscoveryRpcHandler` and `ShardedDiscoveryRpcHandler` process incoming
discovery RPCs with rate limiting:

- **Announce**: 1 per 60 seconds per peer (line 21).
- **Lookup**: 10 per 60 seconds per peer (line 24).
- **AgentId match**: the record's `agent_id` must match the caller's
  authenticated identity (line 122-127).

### 2.4 Persistent DHT (`persistent_dht.rs`)

`PersistentDht` backs the capability DHT with SQLite, surviving process
restarts. Records are stored as CBOR blobs with a `capabilities` text
column for `LIKE`-based queries (line 93). This is a single-node
persistent store, not a distributed database.

### 2.5 Bootstrap (`bootstrap.rs`)

`BootstrapDiscovery` connects to hardcoded seed nodes
(e.g., `quic://seed1.aafp.io:4433`) to join the network. Seeds return
known peer records, which are then used to populate the routing table
via PEX.

### 2.6 Regional Discovery (`regional.rs`)

`RegionalDiscovery` groups agents by geographic region (determined by
latency probes). `find_closest(target_region, limit)` returns agents
in the same region first, then fills from adjacent regions. This is a
local optimization layer, not a network-wide service.

### 2.7 Semantic Capability Graphs (`semantic/`)

The semantic module adds structured capability descriptors with
multi-dimensional attributes:

- `SemanticCapability` (capability.rs:189) carries category, languages,
  modalities, hardware specs, performance profile, quality metrics, cost
  model, geo constraints, and version.
- `CapabilityQuery` (query.rs:131) is a builder with filters for
  performance, quality, cost, geo, and version constraints.
- `QueryFilter` (query.rs:26) supports Equality, Range, In, Exists, and
  SemanticMatch predicates.

Critically, **semantic queries are evaluated locally** after DHT
retrieval (evaluation.rs:1-15). The DHT is still keyed only by
capability name; all filtering happens client-side. This means the DHT
cannot push filter evaluation to the network — every candidate record
must be fetched and inspected.

---

## 3. Limitations of DHT-Only Discovery

The DHT is an excellent substrate for decentralized, fault-tolerant
key-value lookup. But as a *discovery service* for a global agent
network, it has fundamental limitations:

### 3.1 No Multi-Dimensional Search

The DHT is keyed by a single dimension: the capability name string.
A query like "find inference agents that speak Japanese, are in
Asia-Pacific, cost less than $0.01/1K tokens, and have a trust score
above 80" cannot be answered by the DHT. The caller must:

1. Look up all agents with capability `"inference"` (potentially
   thousands).
2. Fetch each `AgentRecord` (which may carry semantic metadata).
3. Evaluate the `CapabilityQuery` filters locally against each record.

At scale, this is O(N) per query where N is the number of agents
advertising that capability. For popular capabilities like `"inference"`,
N could be tens of thousands.

### 3.2 No Ranking

The DHT returns an unordered set of records. There is no way to ask
"give me the top 5 inference agents by trust score" without fetching
all candidates and sorting locally. The `LookupParams` struct
(discovery_v1.rs:129) supports only a `limit` parameter — no sort
order, no scoring, no relevance.

### 3.3 Eventual Consistency

DHT records have a `created_at` timestamp and a 30-day max expiry
(identity_v1.rs:30). Between announcements, records can be stale:

- An agent may have gone offline but its record hasn't expired.
- An agent may have changed its capabilities but hasn't re-announced.
- A new agent may have announced but the record hasn't propagated to
  the querier's local DHT yet.

The lookup cache (default 300s TTL) adds further staleness. For
real-time connectivity this is acceptable; for directory-style
discovery where users browse available agents, stale listings erode
trust.

### 3.4 No Verification of Advertised Capabilities

The DHT verifies that an `AgentRecord` is self-consistent (the signature
is valid, the `agent_id` matches the public key). But it does **not**
verify that the agent actually *provides* the capabilities it advertises.
An agent can announce `"inference"` without ever serving an inference
request. The DHT has no concept of verification, attestation, or
reachability confirmation.

### 3.5 No Reputation Aggregation

The reputation extension (`extensions/reputation.rs`) carries
*references* to third-party attestations, and the attestation store
(`extensions/attestation_store.rs`) provides a separate DHT namespace
for attestation documents. But there is no aggregated reputation score
available at query time. A caller looking up `"inference"` gets raw
records — it must then fetch and evaluate all attestations for each
candidate to compute a trust score. This is impractical for interactive
discovery.

### 3.6 No Human-Browsable Directory

The DHT is a machine-to-machine protocol. There is no way for a human
to browse available agents, see what capabilities exist on the network,
or compare agents side-by-side. A registry with a web UI (or at least
a structured API that a UI can consume) fills this gap.

### 3.7 Bootstrap Dependency

Every new agent must connect to hardcoded seed nodes to join the
network (`bootstrap.rs`). If all seeds are down, new agents cannot
discover peers. A registry provides an alternative entry point: an
agent can query the registry for a list of known-active peers and
connect directly.

### 3.8 No Cost-Aware Discovery

The `CostExtension` (`extensions/cost.rs`) and `CostModel`
(semantic/capability.rs:146) carry pricing in micro-USD. But the DHT
cannot filter by cost — a caller must fetch all candidates and compare
prices locally. For cost-sensitive workloads (e.g., "cheapest
translation agent"), this is inefficient.

---

## 4. Agent Registry: Design Overview

The Agent Registry is a **curated, searchable, federated directory** of
AAFP agents. It sits above the DHT and provides:

1. **Multi-dimensional search**: filter by capability, language, region,
   reputation, cost, performance, and more.
2. **Ranked results**: sort by trust score, latency, cost, or
   custom scoring functions.
3. **Verified listings**: the registry confirms that each listed agent
   is reachable and provides its advertised capabilities.
4. **Aggregated reputation**: a single reputation score per agent,
   computed from multiple attestation sources.
5. **Human-browsable**: a web UI and structured API for browsing and
   comparing agents.
6. **Federated**: multiple registries sync agent records, avoiding a
   single point of control.

### 4.1 Architecture

```
                    ┌──────────────────────────────────┐
                    │       Public Registry             │
                    │       (aafp.net)                  │
                    │                                  │
                    │  ┌─────────┐  ┌──────────────┐   │
                    │  │ Search  │  │ Verification │   │
                    │  │ Engine  │  │ Service      │   │
                    │  └────┬────┘  └──────┬───────┘   │
                    │       │              │           │
                    │  ┌────▼──────────────▼───────┐   │
                    │  │   Agent Record Database    │   │
                    │  │   (PostgreSQL / SQLite)    │   │
                    │  └───────────────────────────┘   │
                    │                                  │
                    │  ┌───────────────────────────┐   │
                    │  │  Federation Sync Service   │   │
                    │  └───────────────────────────┘   │
                    └──────────┬───────────────────────┘
                               │  federation
                    ┌──────────▼──────────┐
                    │  Enterprise Registry │
                    │  (private)           │
                    └──────────────────────┘

Agent A ──register──► Registry
Agent B ──search───► Registry ──► results
Agent C ──DHT──────► Agent A (real-time)
```

### 4.2 Key Design Principles

- **The registry is an AAFP agent**, not a separate protocol. It
  communicates using the same AAFP RPC framework, handshake, and
  transport as any other agent.
- **Self-registration**: agents publish their `AgentRecord` to the
  registry, just as they announce to the DHT. The registry then
  verifies the record.
- **Read-heavy, write-light**: most operations are searches; writes
  (registrations) are infrequent and rate-limited.
- **Federated, not centralized**: the public registry at `aafp.net` is
  the default, but enterprises can run private registries that sync
  with the public one (or stay air-gapped).
- **DHT-compatible**: the registry does not replace the DHT. It indexes
  DHT records and provides a richer query interface on top.

---

## 5. Registry API: Search Dimensions

The registry supports search across the following dimensions, all
derived from the existing `AgentRecord` and its extensions:

| Dimension | Source | Example Filter |
|-----------|--------|----------------|
| **Capability** | `CapabilityDescriptor.name` | `capability = "inference"` |
| **Language** | `CapabilityAttributes.languages` | `language in ["en", "ja"]` |
| **Modality** | `CapabilityAttributes.modalities` | `modality = Text` |
| **Region** | `GeoExtension.country_code` / `region` | `region = "us-east"` |
| **Reputation** | Aggregated from attestations | `trust_score >= 80` |
| **Cost** | `CostExtension` / `CostModel` | `per_token_micro_usd <= 500` |
| **Performance** | `PerformanceExtension` | `avg_latency_ms <= 100` |
| **Quality** | `QualityMetrics` | `uptime_pct >= 99.9` |
| **Version** | `SemanticVersion` | `version >= 2.0.0` |
| **Hardware** | `HardwareSpec` | `hardware.gpu.model = "RTX5090"` |
| **Framework** | `CapabilityAttributes.frameworks` | `framework = "TensorRT"` |
| **Free tier** | `CostModel.has_free_tier` | `has_free_tier = true` |
| **Data residency** | `GeoExtension.data_residency` | `data_residency = "EU"` |

These map directly to the `CapabilityQuery` filter types already defined
in `semantic/query.rs`:

- `QueryFilter::Equality` → exact match on language, modality, etc.
- `QueryFilter::Range` → latency, cost, trust score thresholds.
- `QueryFilter::In` → language in a set of acceptable values.
- `QueryFilter::Exists` → "has GPU", "has free tier".
- `PerformanceFilter` → max latency, min throughput.
- `QualityFilter` → min trust score, min uptime.
- `CostFilter` → max per-invocation cost, require free tier.
- `GeoFilter` → region, country.
- `VersionFilter` → exact, minimum, or range.

The registry's advantage over local evaluation is that it can **push
these filters to the database** (SQL indexes, materialized views)
rather than fetching all candidates and filtering client-side.

### 5.1 Ranking

Beyond filtering, the registry supports **ranking** of results:

- **By trust score**: `ORDER BY trust_score DESC`
- **By latency**: `ORDER BY avg_latency_ms ASC`
- **By cost**: `ORDER BY per_token_micro_usd ASC`
- **By composite score**: a weighted function of trust, latency, cost,
  and uptime. The caller can specify weights:
  `score = 0.4 * trust + 0.3 * (1/latency) + 0.2 * (1/cost) + 0.1 * uptime`

The DHT has no equivalent — it returns an unsorted set.

---

## 6. Registry as an AAFP Agent

A key design decision is that **the registry is itself an AAFP agent**.
It has its own `AgentId`, `AgentRecord`, keypair, and endpoints. It
participates in the AAFP network like any other agent, with one
advertised capability: `aafp.registry.search`.

### 6.1 Why This Matters

- **No new protocol**: the registry uses the same QUIC transport, v1
  handshake, RPC framing, and CBOR encoding as every other AAFP agent.
  No separate HTTP API is required (though one can be layered on top
  for web UI convenience).
- **Authentication**: clients authenticate to the registry using the
  standard AAFP handshake (ML-DSA-65 signatures, PQ TLS). The registry
  can enforce per-client rate limits, require UCAN capability tokens
  for write operations, and reject unauthenticated traffic.
- **Discoverable**: the registry announces itself to the DHT under
  `aafp.registry.search`. An agent that needs a registry can look up
  this capability and find the nearest registry agent.
- **Federatable**: registries can talk to each other as AAFP peers,
  syncing records via standard RPCs.

### 6.2 Registry AgentRecord

The registry's own `AgentRecord` advertises:

```cbor
{
  1: "aafp-record-v1",
  2: <registry_agent_id>,      // 32 bytes
  3: <registry_public_key>,     // ML-DSA-65
  4: [ { name: "aafp.registry.search" } ],
  5: [ "quic://registry.aafp.net:4433" ],
  6: <created_at>,
  7: <expires_at>,
  8: <signature>,
  9: 1,                         // ML-DSA-65
  10: 1                         // record_version
}
```

### 6.3 Registry RPC Methods

The registry exposes the following AAFP RPC methods (all encoded as
CBOR IntMaps, consistent with RFC-0004):

| Method | Direction | Purpose |
|--------|-----------|---------|
| `aafp.registry.register` | Agent → Registry | Publish AgentRecord for listing |
| `aafp.registry.search` | Agent → Registry | Multi-dimensional search query |
| `aafp.registry.get` | Agent → Registry | Fetch a single agent's full record |
| `aafp.registry.verify` | Registry → Agent | Probe agent reachability (verification) |
| `aafp.registry.federate` | Registry → Registry | Sync agent records between registries |
| `aafp.registry.attest` | Agent → Registry | Submit a third-party attestation |

These are new method names, distinct from the DHT's
`aafp.discovery.announce` and `aafp.discovery.lookup`.

---

## 7. Self-Registration Protocol

Agents register themselves with the registry by sending their signed
`AgentRecord`. The flow is:

```
Agent                          Registry
  │                               │
  │  1. AAFP handshake            │
  │ ─────────────────────────────►│
  │◄───────────────────────────── │
  │                               │
  │  2. aafp.registry.register    │
  │     { record: AgentRecord }   │
  │ ─────────────────────────────►│
  │                               │
  │  3. Verify signature          │
  │     Check agent_id == caller  │
  │     Rate limit check          │
  │                               │
  │  4. 202 Accepted (pending)    │
  │◄───────────────────────────── │
  │                               │
  │  5. Verification probe        │
  │◄───────────────────────────── ││ (connects to agent's endpoints)
  │                               │
  │  6. 200 Verified              │
  │◄───────────────────────────── │
  │                               │
  │  (record now visible in       │
  │   search results)             │
```

### 7.1 Registration Request

```cbor
RegistryRegisterParams = {
    1: AgentRecord,          // the agent's signed record
    ? 2: [ *tstr ],          // verification tokens (optional)
}
```

The registry performs the following checks (mirroring the DHT's
`handle_announce` in `rpc_handler.rs:108`):

1. **Rate limit**: max 1 registration per `AgentId` per hour (matching
   the `KeyDirectory` rate limit in `key_directory.rs:14`).
2. **Signature verification**: `record.verify(now)` must succeed
   (same check as `DhtRouter::add_peer` in `dht_router.rs:759`).
3. **AgentId match**: `record.agent_id` must equal the caller's
   authenticated identity (same check as `rpc_handler.rs:122`).
4. **Monotonic version**: if a record already exists for this
   `AgentId`, the new `record_version` must be >= the existing one
   (RFC-0003 A-3, enforced in `discovery_v1.rs:267`).
5. **Expiry check**: `record.expires_at > now` (reject expired records).

### 7.2 Registration Response

```cbor
RegistryRegisterResult = {
    1: uint,                 // status: 0=pending, 1=verified, 2=rejected
    2: tstr,                 // message (human-readable)
    ? 3: uint,               // verification_deadline (unix seconds)
}
```

The response is `202 Pending` initially. The registry then runs
verification (§8) asynchronously. Once verified, the record becomes
visible in search results with a `verified: true` flag.

### 7.3 Record Updates

Agents re-register when their capabilities, endpoints, or extensions
change. The registry replaces the old record if the new one has a
higher `record_version`. This mirrors the DHT's monotonic version
enforcement.

### 7.4 Deregistration

Agents can deregister by sending a `aafp.registry.register` with a
record that has `expires_at = now` (immediately expired). The registry
removes the record from its index. Alternatively, records auto-expire
after 30 days (matching `MAX_RECORD_EXPIRY` in `identity_v1.rs:30`) if
not renewed.

---

## 8. Registry Verification

The registry does not blindly trust self-reported capabilities. After
a registration is accepted, the registry runs a **verification probe**
to confirm the agent is reachable and provides its advertised
capabilities.

### 8.1 Reachability Check

The registry connects to each endpoint in the `AgentRecord`'s
`endpoints` list (e.g., `quic://1.2.3.4:4433`) and performs an AAFP
handshake. If the handshake succeeds, the agent is reachable. If all
endpoints fail, the record is marked `unverified` and eventually
removed.

This is similar to the `DhtTransport::ping_peer` method
(`dht_router.rs:530`) but with a full handshake rather than a simple
ping, confirming that the agent's public key matches its `AgentRecord`.

### 8.2 Capability Confirmation

For each advertised capability, the registry sends a **probe request**
— a minimal invocation that tests whether the agent can actually
perform the capability. For example:

- `inference`: send a tiny prompt ("Hello") and check for a response.
- `translation`: send "translate: hello" and check for output.
- `aafp.registry.search` (for federated registries): send a search
  query and check for a valid response.

The probe is capability-specific. The registry maintains a table of
probe templates per capability name. Agents that fail capability probes
are listed with a `verified: false` flag but are not removed (they may
be temporarily overloaded).

### 8.3 Periodic Re-verification

Verification is not one-time. The registry re-probes each listed agent
on a schedule:

- **Reachability**: every 1 hour (matching the DHT's bucket refresh
  interval of 15 minutes, but less aggressive for the registry).
- **Capability confirmation**: every 24 hours.
- **On-demand**: when a user reports an agent as non-functional.

Agents that fail re-verification are downgraded: `verified: false`,
and after 7 consecutive failures, removed from the directory.

### 8.4 Verification Metadata

Each record in the registry carries verification metadata:

```cbor
VerificationStatus = {
    1: uint,           // status: 0=unverified, 1=pending, 2=verified, 3=failed
    2: uint,           // last_checked (unix seconds)
    3: uint,           // next_check (unix seconds)
    ? 4: [ *tstr ],    // failed_capabilities (names that failed probe)
    ? 5: uint,         // consecutive_failures
}
```

This metadata is visible in search results, allowing callers to filter
for verified-only agents.

---

## 9. Registry Reputation

The registry aggregates reputation from multiple sources to produce a
single trust score per agent. This builds on the existing attestation
infrastructure in `aafp-identity/src/extensions/`:

### 9.1 Attestation Sources

The existing `Attestation` struct (`attestation.rs:27`) is a signed
document where an attester reports a metric about a subject:

```cbor
Attestation = {
    1: "aafp-attestation-v1",
    2: <subject_agent_id>,
    3: <attester_agent_id>,
    4: <attester_signature>,
    5: <metric>,        // "latency_ms", "success_rate", "uptime_pct"
    6: <value>,         // the measured value
    7: <timestamp>,
}
```

Attestations are stored in a separate DHT namespace
(`attestation_store.rs:17`) keyed by
`SHA-256("aafp-attestation" || subject || attester)`. The registry
collects all attestations for a given subject and aggregates them.

### 9.2 Aggregation Algorithm

The registry computes a composite trust score (0-100) from multiple
attested metrics:

```
trust_score = w1 * normalized_success_rate
            + w2 * normalized_uptime
            + w3 * normalized_latency_inverse
            + w4 * attester_diversity_bonus
```

Where:

- **`success_rate`**: average of all `success_rate` attestations,
  weighted by attester reputation (recursive, but capped at depth 2 to
  avoid cycles).
- **`uptime`**: average of all `uptime_pct` attestations.
- **`latency_inverse`**: `100 - min(latency_ms, 100)` averaged across
  attestations.
- **`attester_diversity_bonus`**: reward for having attestations from
  many distinct attesters (sybil resistance — see §14.3).

Default weights: `w1=0.4, w2=0.3, w3=0.2, w4=0.1`.

### 9.3 Self-Reported Scores (Unverified)

The `ReputationExtension.self_claimed_score` (reputation.rs:34) is
explicitly marked as **unverified** and is never used in the aggregate
trust score. It is displayed in search results as "self-claimed" for
transparency but does not affect ranking.

### 9.4 Attestation Submission

Agents can submit attestations about other agents via the
`aafp.registry.attest` RPC:

```cbor
RegistryAttestParams = {
    1: Attestation,        // signed attestation document
}
```

The registry verifies the attester's signature, rejects self-attestations
(`attester == subject`, per `attestation_store.rs:91`), and stores the
attestation. The subject's trust score is recomputed asynchronously.

### 9.5 Reputation Refresh

Trust scores are recomputed:

- When a new attestation is submitted for the subject.
- Periodically (every 6 hours) to incorporate expired attestation
  eviction.
- On-demand when a user queries with a `trust_score` filter.

---

## 10. Registry Federation

A single registry is a single point of failure and control. Federation
allows multiple registries to sync agent records, providing redundancy
and decentralization.

### 10.1 Federation Protocol

Registries sync via the `aafp.registry.federate` RPC:

```cbor
FederateParams = {
    1: uint,               // sync_mode: 0=full, 1=incremental
    2: uint,               // since_timestamp (for incremental)
    ? 3: [ *AgentRecord ], // records to push (optional)
}

FederateResult = {
    1: [ *AgentRecord ],   // records to pull (newer than since_timestamp)
    2: uint,               // current_sync_timestamp
}
```

- **Full sync**: registry A requests all records from registry B.
  Used on first federation or after a long partition.
- **Incremental sync**: registry A requests records updated since
  `since_timestamp`. Used for periodic sync (every 5 minutes).

### 10.2 Conflict Resolution

When two registries have different records for the same `AgentId`:

1. Compare `record_version`: higher version wins (monotonic, matching
   DHT behavior in `discovery_v1.rs:267`).
2. If versions are equal, compare `created_at`: newer timestamp wins.
3. If both are equal, the records are identical — no conflict.

Verification status is **per-registry**: registry A may have verified
an agent that registry B has not. The `VerificationStatus` is merged
by taking the most recent check from either registry.

### 10.3 Federation Topology

```
    aafp.net (public)
       /        \
  eu.aafp.net   na.aafp.net
       |              |
  enterprise-eu   enterprise-na
```

- **Public registries**: `aafp.net`, `eu.aafp.net`, `na.aafp.net`.
  These sync with each other every 5 minutes.
- **Private registries**: enterprise deployments that sync from public
  registries (pull-only) or are fully air-gapped.
- **Regional registries**: optimize for low-latency queries by serving
  only agents in their region, with cross-region fallback.

### 10.4 Federation Authentication

Registries authenticate to each other using the standard AAFP
handshake. Federation can be restricted via UCAN capability tokens:
a registry may only accept `aafp.registry.federate` calls from
pre-configured peer registries (identified by `AgentId`).

---

## 11. Public vs Private Registries

### 11.1 Public Registry (`aafp.net`)

The default registry, operated by the AAFP project. Features:

- **Open registration**: any agent with a valid `AgentRecord` can
  register.
- **Public search**: anyone can search without authentication (with
  stricter rate limits — matching `DEFAULT_LIMIT_UNAUTH = 5` in
  `discovery_v1.rs:29`).
- **Free tier**: no cost to register or search.
- **Community-governed**: verification probes and reputation
  aggregation follow community-agreed rules.

### 11.2 Private/Enterprise Registries

Enterprises run their own registries for internal agent networks.
Features:

- **Restricted registration**: only agents with enterprise-issued
  UCAN tokens can register.
- **Private search**: search requires authentication.
- **Custom verification**: the enterprise may run custom capability
  probes (e.g., compliance checks, security scans).
- **Air-gapped option**: no federation with the public registry.
- **Custom reputation**: the enterprise may weight attesters
  differently (e.g., internal auditors weighted higher than external
  community members).

### 11.3 Hybrid Model

An enterprise can run a private registry that **mirrors** the public
registry (pull-only federation) and adds internal-only agents. This
gives enterprise users access to both public and private agents
through a single search interface, with clear `public`/`private`
tagging in results.

---

## 12. Registry Caching

### 12.1 Client-Side Caching

Agents cache registry search results locally to avoid repeated queries.
This mirrors the DHT's lookup cache (`dht_router.rs:622`):

```rust
struct RegistryCache {
    // query hash → (results, cached_at)
    cache: HashMap<u64, (Vec<RegistryEntry>, u64)>,
    // TTL in seconds
    ttl: u64,  // default: 300 (5 minutes, matching DHT cache)
}
```

Cache keys are hashes of the `RegistrySearchParams` CBOR encoding.
On a cache miss, the agent queries the registry. On a hit, it returns
cached results if within TTL.

### 12.2 Cache Invalidation

- **TTL-based**: entries expire after 5 minutes (configurable).
- **Push invalidation** (optional): the registry can send
  `aafp.registry.invalidate` notifications to subscribed clients when
  records change. This uses a long-lived QUIC stream (similar to PEX
  in the DHT).
- **Manual**: `cache.invalidate(query)` clears a specific entry;
  `cache.invalidate_all()` clears everything (matching
  `DhtRouter::invalidate_cache` in `dht_router.rs:702`).

### 12.3 Registry-Side Caching

The registry itself caches:

- **Aggregated trust scores**: recomputed every 6 hours, cached in
  between (avoids re-aggregating attestations on every search).
- **Verification status**: cached per agent, refreshed on the
  re-verification schedule.
- **Popular queries**: the top 100 most common search queries are
  cached with a 60-second TTL (LRU eviction).

### 12.4 Cache Coherence

The registry exposes a `last_updated` timestamp per agent record.
Clients can use `If-Modified-Since` semantics: "give me results only
if they changed since timestamp T." This reduces bandwidth for
polling clients.

---

## 13. Registry vs DHT: When to Use Which

The registry and DHT serve complementary roles. Here is a decision
matrix:

| Use Case | Use Registry | Use DHT | Why |
|----------|:---:|:---:|-----|
| Initial discovery: "find inference agents" | ✓ | | Registry provides ranked, verified results |
| Multi-dimensional search: "inference + Japanese + low cost" | ✓ | | DHT can't filter by language/cost |
| Browsing available capabilities | ✓ | | Registry lists all known capabilities |
| Comparing agents side-by-side | ✓ | | Registry provides structured comparison |
| Real-time peer tracking after initial discovery | | ✓ | DHT provides live announce/depart |
| Finding peers in your routing table neighborhood | | ✓ | DHT's XOR-distance routing is optimal |
| Bootstrapping a new agent | ✓ | ✓ | Registry for known-active peers; DHT for PEX |
| Detecting agent departure | | ✓ | DHT's `depart` RPC is real-time |
| Cost-aware selection | ✓ | | Registry indexes cost; DHT doesn't |
| Reputation-filtered selection | ✓ | | Registry aggregates attestations |
| Offline-capable discovery | | ✓ | DHT works without a central registry |
| Censorship-resistant discovery | | ✓ | DHT has no central authority |
| Human-browsable directory | ✓ | | Registry has a web UI |

### 13.1 Recommended Workflow

For most agents, the recommended discovery workflow is:

1. **Register** with the public registry on startup (once).
2. **Search** the registry when you need a new capability partner.
3. **Connect** to the search results via AAFP handshake.
4. **Announce** to the DHT for real-time peer tracking.
5. **PEX** with connected peers to build your routing table.
6. **Cache** registry results locally; refresh on TTL expiry.

This gives you the best of both worlds: rich directory search via the
registry, and real-time peer tracking via the DHT.

### 13.2 Fallback: Registry-Down Scenario

If the registry is unreachable, agents fall back to DHT-only discovery.
This is degraded (no ranking, no verification, no multi-dimensional
search) but functional. The DHT's bootstrap seeds
(`bootstrap.rs:93`) provide an alternative entry point to the network.

---

## 14. Anti-Abuse Measures

A public registry is a target for abuse: spam registrations, sybil
attacks, fake attestations, and capability fraud. The registry
incorporates multiple layers of defense.

### 14.1 Rate Limiting Registrations

Following the existing rate-limit patterns in the codebase:

- **Per-AgentId**: 1 registration per hour (matching `KeyDirectory`'s
  `RATE_LIMIT_SECS = 3600` in `key_directory.rs:14`).
- **Per-IP**: 10 registrations per hour per source IP (matching the
  SDK's per-IP handshake rate limit of 10/sec, but much stricter for
  registrations).
- **Per-capability**: 100 new capability listings per hour globally
  (prevents flooding a single capability namespace).

Rate limiting uses the same sliding-window approach as
`DiscoveryRpcHandler::check_rate_limit` (`rpc_handler.rs:184`):

```rust
fn check_rate_limit(
    &self,
    limits: &Mutex<HashMap<AgentId, Vec<Instant>>>,
    agent_id: &AgentId,
    max_per_window: u32,
) -> bool {
    let now = Instant::now();
    let window_start = now - RATE_LIMIT_WINDOW;
    let mut limits = limits.lock().unwrap();
    let timestamps = limits.entry(*agent_id).or_default();
    timestamps.retain(|&t| t > window_start);
    if timestamps.len() >= max_per_window as usize {
        return false;
    }
    timestamps.push(now);
    true
}
```

### 14.2 Identity Verification

The registry requires a valid, self-consistent `AgentRecord`:

1. **Signature verification**: `record.verify(now)` must succeed
   (ML-DSA-65, post-quantum).
2. **AgentId match**: `record.agent_id == SHA-256(record.public_key)`.
3. **Caller identity**: the authenticated caller's `AgentId` must match
   `record.agent_id` (prevents impersonation — same check as
   `rpc_handler.rs:122`).
4. **Endpoint reachability**: at least one endpoint must respond to
   an AAFP handshake (§8.1).

### 14.3 Sybil Resistance

A sybil attack creates many fake identities to manipulate reputation
or flood search results. Defenses:

- **Proof-of-work for registration**: the registry may require a
  computational proof (e.g., find a nonce such that
  `SHA-256(agent_id || nonce) < target`). This makes mass registration
  expensive. The difficulty is adjustable.
- **Attester diversity weighting**: in reputation aggregation
  (§9.2), the `attester_diversity_bonus` rewards attestations from
  *distinct* attesters. N attestations from 1 attester count less than
  N attestations from N/2 distinct attesters.
- **Self-attestation rejection**: `attester == subject` is rejected
  (already enforced in `attestation_store.rs:91`).
- **Trust propagation depth limit**: reputation is computed from
  attester reputation, but only to depth 2 (attester's attester).
  This prevents reputation pumping via long synthetic chains.
- **Registration deposit** (optional, for high-trust registries):
  agents stake a small amount of cryptocurrency or provide a
  credit card on file. Slashed if the agent is found to be fraudulent.

### 14.4 Capability Fraud Prevention

An agent advertises capabilities it doesn't actually provide. Defenses:

- **Capability probes** (§8.2): the registry tests each advertised
  capability. Failed probes result in `verified: false`.
- **Community reporting**: users can report agents as non-functional.
  Multiple reports trigger an immediate re-verification.
- **Attestation-based confirmation**: third-party attestations
  confirming that an agent successfully handled requests for a
  capability increase confidence in the listing.

### 14.5 Fake Attestation Prevention

Attestations are signed by the attester, not the subject. Defenses:

- **Signature verification**: the registry verifies each attestation's
  signature against the attester's public key.
- **Attester reputation weighting**: attestations from low-reputation
  attesters contribute less to the subject's score.
- **Attestation rate limiting**: max 10 attestations per attester per
  hour (prevents flooding).
- **Temporal decay**: older attestations contribute less (exponential
  decay with a 30-day half-life, matching `MAX_RECORD_EXPIRY`).

### 14.6 DDoS Resistance

- **Per-client rate limiting** on search queries (10/minute for
  authenticated, 5/minute for unauthenticated — matching
  `DEFAULT_LIMIT_AUTH` and `DEFAULT_LIMIT_UNAUTH` in
  `discovery_v1.rs:29-32`).
- **QUIC-based transport**: QUIC's built-in flow control and
  connection migration make DDoS harder than raw TCP/HTTP.
- **Geo-distributed registry nodes**: anycast routing distributes
  query load across regions.

---

## 15. Concrete API Design

### 15.1 Search Request

```cbor
RegistrySearchParams = {
    ? 1: tstr,                // capability name (exact or prefix)
    ? 2: [ *tstr ],           // languages (BCP-47 tags)
    ? 3: [ *tstr ],           // modalities ("text", "image", "audio", "video")
    ? 4: tstr,                // region code ("na", "eu", "apac")
    ? 5: tstr,                // country code (ISO 3166-1 alpha-2)
    ? 6: uint,                // min_trust_score (0-100)
    ? 7: uint,                // max_per_invocation_micro_usd
    ? 8: uint,                // max_per_token_micro_usd
    ? 9: bool,                // require_free_tier
    ? 10: uint,               // max_avg_latency_ms
    ? 11: uint,               // min_uptime_bps (10000 = 100%)
    ? 12: [ *tstr ],          // frameworks ("TensorRT", "ONNX")
    ? 13: [ *QueryFilter ],   // custom attribute filters
    ? 14: tstr,               // sort_by ("trust", "latency", "cost", "score")
    ? 15: bool,               // sort_desc (default: false)
    ? 16: uint,               // limit (default: 20, max: 100)
    ? 17: uint,               // offset (for pagination)
    ? 18: bool,               // verified_only (default: true)
    ? 19: tstr,               // data_residency jurisdiction
    ? 20: SemanticVersion,    // min_version
}
```

All fields are optional. An empty search returns the most popular
agents (by search frequency) across all capabilities.

### 15.2 Search Response

```cbor
RegistrySearchResult = {
    1: [ *RegistryEntry ],    // matching agents
    2: uint,                  // total_count (before limit/offset)
    3: uint,                  // query_timestamp (for cache coherence)
    ? 4: tstr,                // cursor (for pagination, if more results)
}

RegistryEntry = {
    1: AgentRecord,           // the full signed record
    2: uint,                  // trust_score (0-100, aggregated)
    3: VerificationStatus,    // verification state
    4: uint,                  // registration_time (unix seconds)
    ? 5: float,               // composite_score (if sort_by="score")
    ? 6: [ *tstr ],           // highlighted_capabilities (matching the query)
}
```

### 15.3 Get Single Agent

```cbor
// Request
RegistryGetParams = {
    1: bstr,                  // agent_id (32 bytes)
}

// Response
RegistryGetResult = {
    1: RegistryEntry,         // full entry with all metadata
    ? 2: [ *Attestation ],    // recent attestations (optional)
}
```

### 15.4 Register

```cbor
// Request (see §7.1)
RegistryRegisterParams = {
    1: AgentRecord,
    ? 2: [ *tstr ],           // verification tokens
}

// Response (see §7.2)
RegistryRegisterResult = {
    1: uint,                  // status: 0=pending, 1=verified, 2=rejected
    2: tstr,                  // message
    ? 3: uint,                // verification_deadline
}
```

### 15.5 Attest

```cbor
// Request
RegistryAttestParams = {
    1: Attestation,           // signed attestation document
}

// Response
RegistryAttestResult = {
    1: bool,                  // accepted
    ? 2: tstr,                // rejection reason (if not accepted)
}
```

### 15.6 Federate

```cbor
// Request (see §10.1)
FederateParams = {
    1: uint,                  // sync_mode: 0=full, 1=incremental
    2: uint,                  // since_timestamp
    ? 3: [ *AgentRecord ],    // records to push
}

// Response
FederateResult = {
    1: [ *AgentRecord ],      // records to pull
    2: uint,                  // current_sync_timestamp
}
```

---

## 16. Example Queries

### 16.1 Basic Capability Search

"Find inference agents."

```cbor
RegistrySearchParams = {
    1: "inference",
    14: "trust",        // sort by trust score
    15: true,           // descending (highest trust first)
    16: 10,             // limit 10
    18: true,           // verified only
}
```

Expected response: 10 verified inference agents, sorted by trust score.

### 16.2 Multi-Dimensional Search

"Find Japanese translation agents in Asia-Pacific with trust ≥ 80,
cost ≤ $0.005/token, and latency ≤ 200ms."

```cbor
RegistrySearchParams = {
    1: "translation",
    2: ["ja"],
    4: "apac",
    6: 80,                      // min_trust_score
    8: 5000,                    // max_per_token_micro_usd ($0.005)
    10: 200,                    // max_avg_latency_ms
    14: "score",                // composite score
    15: true,
    16: 5,
    18: true,
}
```

### 16.3 Cost-Optimized Search

"Find the cheapest text-to-speech agent that supports English and has
a free tier."

```cbor
RegistrySearchParams = {
    1: "text-to-speech",
    2: ["en"],
    3: ["audio"],
    9: true,                     // require_free_tier
    14: "cost",                  // sort by cost
    15: false,                   // ascending (cheapest first)
    16: 5,
    18: true,
}
```

### 16.4 Region-Locked Search (GDPR Compliance)

"Find RAG agents with data residency in the EU."

```cbor
RegistrySearchParams = {
    1: "information-retrieval",
    5: "DE",                     // country: Germany
    19: "EU",                    // data_residency: EU
    16: 10,
    18: true,
}
```

### 16.5 Hardware-Specific Search

"Find inference agents running on RTX 5090 GPUs with TensorRT."

```cbor
RegistrySearchParams = {
    1: "inference",
    12: ["TensorRT"],
    13: [                        // custom filters
        {
            type: "Equality",
            key: "hardware.gpu.model",
            value: "RTX5090"
        }
    ],
    14: "latency",
    15: false,
    16: 5,
    18: true,
}
```

### 16.6 Federated Enterprise Search

An enterprise registry that mirrors the public registry plus internal
agents. Search for internal-only coding agents:

```cbor
RegistrySearchParams = {
    1: "code-generation",
    6: 90,                       // high trust threshold
    14: "trust",
    15: true,
    16: 20,
    18: true,
}
// Results include both public and private agents, tagged accordingly.
```

### 16.7 Pagination

"Give me the next 20 inference agents after the previous batch."

```cbor
RegistrySearchParams = {
    1: "inference",
    14: "trust",
    15: true,
    16: 20,
    17: 20,                      // offset: skip first 20
    18: true,
}
```

### 16.8 Registration Example

An agent registers with the public registry:

```
1. Agent generates AgentRecord:
   - capabilities: ["inference", "translation"]
   - endpoints: ["quic://my-agent.example.com:4433"]
   - extensions: cost, geo, performance, reputation
   - signed with ML-DSA-65

2. Agent connects to registry.aafp.net:4433
   - AAFP v1 handshake (PQ TLS, ML-DSA-65)

3. Agent sends aafp.registry.register:
   { 1: <AgentRecord> }

4. Registry responds:
   { 1: 0, 2: "Registration accepted, verification pending", 3: 1700003600 }

5. Registry connects to my-agent.example.com:4433
   - Handshake succeeds
   - Sends inference probe: "Hello"
   - Agent responds: "Hi there!"
   - Sends translation probe: "translate:hello"
   - Agent responds: "Bonjour"
   - Verification passes

6. Registry updates record:
   { 1: 1, 2: "Verified" }

7. Agent is now visible in search results with verified=true.
```

---

## 17. Implementation Roadmap

### Phase 1: Registry Core (MVP)

- [ ] Define `RegistrySearchParams` / `RegistrySearchResult` CBOR types
- [ ] Implement `RegistryAgent` struct (wraps `AgentRecord` + verification
      status + trust score)
- [ ] Implement `aafp.registry.register` RPC handler
- [ ] Implement `aafp.registry.search` RPC handler with SQL-backed
      filtering (SQLite initially, PostgreSQL for production)
- [ ] Basic reachability verification (handshake probe)
- [ ] Client-side `RegistryCache` (TTL-based, mirroring DHT cache)

**Estimated effort:** 2-3 weeks. Reuses `AgentRecord` CBOR encoding
from `identity_v1.rs`, rate limiting from `rpc_handler.rs`, and
SQLite patterns from `persistent_dht.rs`.

### Phase 2: Verification & Reputation

- [ ] Capability-specific probe templates
- [ ] Periodic re-verification scheduler
- [ ] Attestation aggregation (`aafp.registry.attest`)
- [ ] Trust score computation (weighted multi-metric)
- [ ] `VerificationStatus` in search results

**Estimated effort:** 3-4 weeks. Builds on attestation infrastructure
in `extensions/attestation.rs` and `attestation_store.rs`.

### Phase 3: Federation

- [ ] `aafp.registry.federate` RPC handler
- [ ] Incremental sync protocol
- [ ] Conflict resolution (monotonic version + timestamp)
- [ ] Federation topology configuration
- [ ] UCAN-based federation authentication

**Estimated effort:** 2-3 weeks.

### Phase 4: Anti-Abuse Hardening

- [ ] Proof-of-work for registration
- [ ] Per-IP rate limiting (beyond per-AgentId)
- [ ] Sybil resistance scoring (attester diversity)
- [ ] Community reporting API
- [ ] DDoS mitigation (geo-distributed nodes)

**Estimated effort:** 2-3 weeks.

### Phase 5: Web UI & Developer Experience

- [ ] HTTP gateway (translates REST/JSON ↔ AAFP RPC/CBOR)
- [ ] Web UI for browsing and searching agents
- [ ] Agent profile pages (showing capabilities, reputation, verification)
- [ ] CLI integration (`aafp-cli` registry commands)
- [ ] SDK convenience methods (`aafp-sdk` registry client)

**Estimated effort:** 3-4 weeks.

### Phase 6: Production Deployment

- [ ] Deploy `registry.aafp.net` with PostgreSQL backend
- [ ] Deploy regional registry nodes (`eu.aafp.net`, `na.aafp.net`)
- [ ] Set up federation between regional nodes
- [ ] Monitor verification coverage and reputation freshness
- [ ] Publish registry API documentation and OpenAPI spec

**Estimated effort:** 2-3 weeks.

---

## Appendix A: Mapping to Existing Code

| Registry Concept | Existing Code Reference |
|-----------------|------------------------|
| AgentRecord (signed) | `identity_v1.rs:121` |
| CapabilityDescriptor | `identity_v1.rs` (CapabilityDescriptor) |
| SemanticCapability | `semantic/capability.rs:189` |
| CapabilityQuery (filters) | `semantic/query.rs:131` |
| QueryFilter predicates | `semantic/query.rs:26` |
| PerformanceFilter | `semantic/query.rs:68` |
| QualityFilter | `semantic/query.rs:81` |
| CostFilter | `semantic/query.rs:92` |
| GeoFilter | `semantic/query.rs:103` |
| VersionFilter | `semantic/query.rs:112` |
| CostExtension | `extensions/cost.rs:22` |
| GeoExtension | `extensions/geo.rs:14` |
| PerformanceExtension | `extensions/performance.rs:14` |
| ReputationExtension | `extensions/reputation.rs:28` |
| Attestation | `extensions/attestation.rs:27` |
| AttestationStore | `extensions/attestation_store.rs:26` |
| Rate limiting (sliding window) | `rpc_handler.rs:184` |
| KeyDirectory rate limit (1/hr) | `key_directory.rs:14` |
| DHT lookup cache (TTL) | `dht_router.rs:622` |
| DHT monotonic version | `discovery_v1.rs:267` |
| DHT max records cap | `discovery_v1.rs:35` |
| DHT record expiry | `identity_v1.rs:30` |
| Bootstrap seeds | `bootstrap.rs:93` |
| Regional grouping | `regional.rs:83` |
| PersistentDht (SQLite) | `persistent_dht.rs:15` |

## Appendix B: CBOR Key Allocation

Registry-specific CBOR IntMap keys (to avoid conflicts with existing
RFC-0003/RFC-0004 allocations):

| Key Range | Allocation |
|-----------|-----------|
| 1-20 | `RegistrySearchParams` |
| 1-6 | `RegistrySearchResult` / `RegistryEntry` |
| 1-5 | `VerificationStatus` |
| 1-3 | `RegistryRegisterParams` / `Result` |
| 1-2 | `RegistryAttestParams` / `Result` |
| 1-2 | `FederateParams` / `Result` |

All keys use the integer-key CBOR map convention established in
RFC-0003 §3 (deterministic encoding, no duplicate keys).

---

*This document is a design proposal. Implementation details may evolve
based on testing and community feedback. The existing DHT
infrastructure in `aafp-discovery/` provides the foundation; the
registry builds on top of it without modifying DHT semantics.*
