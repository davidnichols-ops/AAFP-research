# AAFP Agent Discovery in Practice

**Status:** Research Document
**Date:** 2025-01-20
**Scope:** How real-world discovery scenarios map onto the current AAFP
discovery implementation, the gaps that exist today, and the architecture
needed to close them.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current DHT Design](#2-current-dht-design)
3. [Real-World Discovery Scenarios](#3-real-world-discovery-scenarios)
   - 3.1 [Scenario 1: Translate Japanese to English](#31-scenario-1-translate-japanese-to-english)
   - 3.2 [Scenario 2: Cheapest OCR Agent](#32-scenario-2-cheapest-ocr-agent)
   - 3.3 [Scenario 3: Europe with <100ms Latency](#33-scenario-3-europe-with-100ms-latency)
   - 3.4 [Scenario 4: Pipeline OCR → Translate → Summarize](#34-scenario-4-pipeline-ocr--translate--summarize)
   - 3.5 [Scenario 5: Trusted Code Execution Agents](#35-scenario-5-trusted-code-execution-agents)
4. [DHT vs Registry vs DNS](#4-dht-vs-registry-vs-dns)
5. [Caching Strategy](#5-caching-strategy)
6. [Discovery Latency Budget](#6-discovery-latency-budget)
7. [Bootstrapping](#7-bootstrapping)
8. [Discovery in Disconnected Environments](#8-discovery-in-disconnected-environments)
9. [Negative Discovery](#9-negative-discovery)
10. [Discovery Security](#10-discovery-security)
11. [Conclusion](#11-conclusion)

---

## 1. Executive Summary

The AAFP discovery layer today is a **capability-keyed DHT**: agents
announce the capabilities they provide (plain strings like `"inference"`,
`"translation"`, `"image-ocr"`), and the network stores these records
indexed by `SHA-256(capability_string)`. A discovering agent issues a
lookup for a capability name and receives a list of `AgentRecord`s that
advertise that exact string.

This works for the simplest case — "find me *an* agent that does X" — but
real-world discovery is almost never that simple. Practitioners ask
compound questions: "find me an agent that does X **and** speaks language
Y **and** costs less than Z **and** is in region R **and** that I trust."
The current DHT answers none of the attribute predicates; it only returns
the candidate set. All filtering, ranking, and planning must happen
client-side, and the attributes to filter on are not even part of the
discovery key.

This document maps five canonical real-world discovery scenarios onto the
current architecture, identifies the exact gaps, and specifies the
concrete flow each scenario should follow once the semantic capability
graph (Track U) and adaptive routing plane (Track T) are in place. It also
covers the operational concerns that practitioners raise most often:
caching, latency budgets, bootstrapping, disconnected operation, negative
discovery, and security.

---

## 2. Current DHT Design

### 2.1 Data Structure

**File:** `crates/aafp-discovery/src/capability_dht.rs` (lines 50-56)

```rust
pub struct CapabilityDht {
    /// Map: DhtKey → Vec<DhtRecord>.
    store: HashMap<DhtKey, Vec<DhtRecord>>,
    /// Map: AgentId → Vec<capability_string> (for reverse lookup).
    agent_caps: HashMap<AgentId, Vec<String>>,
}
```

The store is a **flat `HashMap`** keyed by `DhtKey = [u8; 32]`, which is
`SHA-256(capability_string)`. Each value is a `Vec<DhtRecord>` — every
agent that advertised that exact capability string. There is no
secondary index, no attribute store, no ordering, and no ranking.

### 2.2 Key Derivation

**File:** `capability_dht.rs` (lines 68-75)

```rust
pub fn hash_capability(capability: &str) -> DhtKey {
    let mut hasher = Sha256::new();
    hasher.update(capability.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}
```

The key is a straight hash of the capability **string**. This means:

- `"translation"` and `"translate"` hash to **different** keys — no
  semantic normalization, no synonyms, no stemming.
- `"translation"` and `"translation "` (trailing space) hash to different
  keys — no normalization at all.
- There is no namespace or version in the key. `"ocr:v1"` and `"ocr:v2"`
  are unrelated unless an agent advertises both strings.

### 2.3 Lookup Semantics

**File:** `capability_dht.rs` (lines 107-142)

Three lookup methods exist:

| Method | Semantics | Use Case |
|--------|-----------|----------|
| `get(cap)` | Exact string match on one capability | "Find agents that do X" |
| `get_any(&[caps])` | Union: agents matching *any* of the capabilities | "Find agents that do X or Y" |
| `get_all(&[caps])` | Intersection: agents matching *all* capabilities | "Find agents that do X and Y" |

All three return `Vec<&AgentRecord>` — an **unfiltered, unranked** list.
The caller receives every agent that advertised the string, regardless of
language, cost, latency, region, trust, or version. There is no
server-side predicate evaluation.

### 2.4 What the AgentRecord Contains

**File:** `crates/aafp-identity/src/identity_v1.rs`

The `AgentRecord` carries:
- `agent_id: AgentId` (256-bit public key hash)
- `capabilities: Vec<String>` (plain strings)
- `addresses: Vec<Multiaddr>` (transport endpoints)
- `version: u64` (monotonic, for conflict resolution)
- `signature` (ML-DSA-65 over the CBOR-encoded record)

It does **not** carry structured attributes, performance profiles, cost
models, geographic tags, trust scores, or language lists. The
`CapabilityDescriptor` in `identity_v1.rs` (lines 417-549) has a `metadata:
HashMap<String, MetadataValue>` field that *could* hold these, but it is
not indexed by the DHT and is not part of the lookup key.

### 2.5 Multi-Node Routing

**File:** `crates/aafp-discovery/src/dht_router.rs`

The `DhtRouter` wraps the in-memory `CapabilityDht` with Kademlia-style
routing: 256 k-buckets (one per bit of the 256-bit AgentId), XOR distance
for peer selection, iterative lookup with α=3 concurrency, and
replication to k=5 closest peers. This makes the flat HashMap
**distributed** — the key space is partitioned across nodes — but the
lookup semantics remain exact string match. Routing tells you *which node
to ask*; it does not change *what you can ask*.

### 2.6 Summary of Limitations

| Limitation | Impact on Real-World Discovery |
|------------|-------------------------------|
| Exact string match only | "translate" ≠ "translation" ≠ "translating" |
| No attribute indexing | Cannot query by language, cost, latency, region |
| No server-side filtering | Caller must download full candidate set and filter locally |
| No ranking | No "cheapest first" or "lowest latency first" |
| No composition | No pipeline assembly, no dependency resolution |
| No negative results | No "wanted" requests when no agent has the capability |
| No semantic normalization | Capability strings are ad hoc; no ontology |

These are the gaps that the Semantic Capability Graphs design (Track U)
and the Adaptive Routing Plane (Track T) are intended to close. The
remainder of this document shows, scenario by scenario, what the
discovery flow looks like today versus what it should look like.

---

## 3. Real-World Discovery Scenarios

### 3.1 Scenario 1: Translate Japanese to English

> **Query:** "Find me an agent that can translate Japanese to English."

#### What This Requires

- **Capability:** `translation` (or `translate`, or `text-translation`)
- **Attribute:** source language = `ja`, target language = `en`
- **Implicit:** the agent must actually support this language pair, not
  just claim "translation" generically.

#### Current Flow (Today)

```
┌──────────┐    1. lookup("translation")     ┌─────────┐
│  Client   │ ──────────────────────────────► │   DHT   │
│  Agent    │                                │  Node   │
│           │    2. Vec<AgentRecord>          │         │
│           │ ◄────────────────────────────── │         │
│           │    (all agents advertising      │         │
│           │     the string "translation")   │         │
│           │                                │         │
│  3. Client-side filter:                    │         │
│     for each record:                       │         │
│       - No language attribute available     │         │
│       - Must connect and ask each agent    │         │
│         "Do you support ja→en?"            │         │
│           │                                │         │
│  4. Connect to agent_1                     │         │
│     ── RPC: "Do you support ja→en?" ──►   │         │
│     ◄── "Yes" / "No" / "Only en→ja" ──    │         │
│           │                                │         │
│  5. If yes, use it. If no, try next.       │         │
└──────────┘                                └─────────┘
```

**Problem:** The DHT returns every agent that advertised the string
`"translation"`. The client has no way to know which ones support
Japanese→English without connecting to each one and asking. With 50
translation agents in the network, the client may issue 50 connection
attempts to find one that supports the right language pair.

**Latency:** O(N) connections where N = number of agents advertising
"translation". Each connection + query round-trip is ~50-200ms. Worst
case: 50 × 100ms = 5 seconds.

#### Target Flow (With Semantic Capabilities)

```
┌──────────┐    1. CapabilityQuery {                     ┌─────────┐
│  Client   │         name: "translation",               │   DHT   │
│  Agent    │         filters: [                         │  Node   │
│           │           Equality("source_lang", "ja"),   │         │
│           │           Equality("target_lang", "en"),   │         │
│           │         ]                                  │         │
│           │       }                                    │         │
│           │ ──────────────────────────────────────────►│         │
│           │                                            │         │
│           │    2. DHT lookup by SHA-256("translation") │         │
│           │       → candidate records with semantic    │         │
│           │         metadata in CapabilityDescriptor   │         │
│           │                                            │         │
│           │    3. Server-side (or local) filter:       │         │
│           │       source_lang == "ja" AND              │         │
│           │       target_lang == "en"                  │         │
│           │                                            │         │
│           │    4. Vec<AgentRecord> (filtered)          │         │
│           │ ◄──────────────────────────────────────────│         │
│           │    (only agents supporting ja→en)          │         │
│           │                                            │         │
│  5. Pick best (by trust, latency, cost).              │         │
│  6. Connect to one agent.                              │         │
└──────────┘                                            └─────────┘
```

**Latency:** One DHT lookup (~50-100ms) + one connection (~50ms) =
~100-150ms total.

#### Implementation Path

The `CapabilityDescriptor.metadata` field already exists. The semantic
capability design (Track U, §3.1) proposes a `CapabilityAttributes`
struct with a `languages: Vec<String>` field. The query language (Track U,
§4) supports `QueryFilter::Equality { key: "source_lang", value: "ja" }`.
The missing piece is **indexing**: the DHT must either (a) evaluate
predicates server-side before returning records, or (b) return the full
candidate set and let the client filter locally using a
`CapabilityIndex` (Track U, §5.2). Option (b) is simpler and keeps the
DHT dumb; the client builds a local index from discovered records and
filters in <1ms.

---

### 3.2 Scenario 2: Cheapest OCR Agent

> **Query:** "Find me the cheapest OCR agent."

#### What This Requires

- **Capability:** `image-ocr` (or `ocr`)
- **Attribute:** cost per invocation (or per token, per image)
- **Ranking:** sort by cost ascending, return cheapest first
- **Implicit:** "cheapest" may also factor in quality — a free agent that
  fails 50% of the time is not actually cheaper.

#### Current Flow (Today)

```
┌──────────┐    1. lookup("image-ocr")          ┌─────────┐
│  Client   │ ────────────────────────────────► │   DHT   │
│  Agent    │                                  │  Node   │
│           │    2. Vec<AgentRecord>            │         │
│           │       (all OCR agents,            │         │
│           │        no cost info)              │         │
│           │ ◄────────────────────────────────│         │
│           │                                  │         │
│  3. No cost attribute in AgentRecord.        │         │
│     Must query each agent for pricing.       │         │
│           │                                  │         │
│  4. For each candidate:                      │         │
│     ── RPC: "What's your cost per image?" ─►│         │
│     ◄── "0.0001 USD" / "0.00005 USD" / ...  │         │
│           │                                  │         │
│  5. Sort by cost, pick cheapest.             │         │
│  6. Connect to cheapest agent.               │         │
└──────────┘                                  └─────────┘
```

**Problem:** Cost is not part of the discovery record. The client must
contact every OCR agent to ask for pricing, then sort locally. This is
N round-trips just to learn prices, before any actual OCR work begins.

**Latency:** O(N) pricing queries. With 20 OCR agents at ~100ms each,
that's ~2 seconds just for price discovery.

#### Target Flow (With Cost Model)

```
┌──────────┐    1. CapabilityQuery {                ┌─────────┐
│  Client   │         name: "image-ocr",            │   DHT   │
│  Agent    │         cost: CostFilter {            │  Node   │
│           │           sort_by: CostSort::         │         │
│           │             PerInvocationAscending,   │         │
│           │         }                             │         │
│           │       }                               │         │
│           │ ─────────────────────────────────────►│         │
│           │                                       │         │
│           │    2. DHT returns candidates with     │         │
│           │       CostModel in semantic metadata  │         │
│           │                                       │         │
│           │    3. Local sort by                   │         │
│           │       per_invocation_micro_usd        │         │
│           │                                       │         │
│           │    4. Sorted Vec<AgentRecord>         │         │
│           │ ◄─────────────────────────────────────│         │
│           │    [cheapest, ..., most expensive]    │         │
│           │                                       │         │
│  5. Connect to cheapest agent.                   │         │
│     (Optionally apply quality floor:             │         │
│      trust_score >= 80 before selecting.)        │         │
└──────────┘                                       └─────────┘
```

**Latency:** One DHT lookup (~50-100ms) + local sort (<1ms) + one
connection (~50ms) = ~100-150ms total.

#### Implementation Path

The `CostModel` struct (Track U, §3.1) with `per_invocation_micro_usd`
and `per_token_micro_usd` fields encodes pricing in the semantic
capability metadata. The client's `CapabilityIndex` (Track U, §5.2)
maintains a `BTreeMap<cost, Vec<Capability>>` for O(log N) sorted
retrieval. The DHT itself does not sort — it returns the candidate set,
and the client sorts locally from the index. This keeps the DHT simple
and avoids server-side computational load.

**Important nuance:** "Cheapest" is rarely the *only* criterion. A
practical query combines cost with a quality floor:

```rust
CapabilityQuery::new("image-ocr")
    .with_cost(CostFilter {
        sort_by: CostSort::PerInvocationAscending,
    })
    .with_quality(QualityFilter {
        min_trust_score: Some(80),
        min_accuracy: Some(0.95),
    })
    .build()
```

This returns agents sorted by cost, but only among those with trust ≥ 80
and accuracy ≥ 0.95. The filtering happens locally; the sort happens
locally; the DHT just provides the candidate set.

---

### 3.3 Scenario 3: Europe with <100ms Latency

> **Query:** "Find me an agent in Europe with <100ms latency."

#### What This Requires

- **Capability:** (unspecified — any capability, or a specific one)
- **Attribute:** geographic region = Europe
- **Performance:** average latency < 100ms
- **Implicit:** "in Europe" may mean the agent is *located* in Europe, or
  that the agent is *reachable from the client* with European-latency
  characteristics. These are different things.

#### Current Flow (Today)

```
┌──────────┐    1. lookup("inference")           ┌─────────┐
│  Client   │ ──────────────────────────────────► │   DHT   │
│  Agent    │    (or whatever capability)         │  Node   │
│ (in EU)   │                                     │         │
│           │    2. Vec<AgentRecord>              │         │
│           │       (all inference agents,        │         │
│           │        no geo or latency info)      │         │
│           │ ◄──────────────────────────────────│         │
│           │                                     │         │
│  3. For each candidate:                        │         │
│     - Ping to measure latency                  │         │
│     - No geo info in record                    │         │
│     - Must infer region from latency           │         │
│           │                                     │         │
│  4. Ping agent_1: 180ms → too slow             │         │
│     Ping agent_2: 45ms  → OK, likely EU        │         │
│     Ping agent_3: 220ms → too slow             │         │
│     ...                                        │         │
│           │                                     │         │
│  5. Use agent_2.                               │         │
└──────────┘                                     └─────────┘
```

**Problem:** The `AgentRecord` has no geographic field. The `regional.rs`
module (lines 62-71) infers region from latency using rough buckets
(0-50ms = UsEast, 51-100ms = UsWest, 101-150ms = Europe), but this is
backwards — it infers *the client's* region from latency, not the
*agent's* region. And it requires actually pinging each agent, which is
N round-trips.

**Latency:** O(N) pings at ~50-200ms each. With 30 inference agents,
that's 1.5-6 seconds.

#### Target Flow (With Geo + Performance)

```
┌──────────┐    1. CapabilityQuery {              ┌─────────┐
│  Client   │         name: "inference",          │   DHT   │
│  Agent    │         geo: GeoFilter {            │  Node   │
│ (in EU)   │           region: Region::Europe,   │         │
│           │         },                          │         │
│           │         performance: PerformanceFilter {  │   │
│           │           max_avg_latency_ms: 100.0,│         │
│           │         }                           │         │
│           │       }                             │         │
│           │ ───────────────────────────────────►│         │
│           │                                     │         │
│           │    2. DHT returns candidates with   │         │
│           │       GeoConstraint +               │         │
│           │       PerformanceProfile in         │         │
│           │       semantic metadata             │         │
│           │                                     │         │
│           │    3. Local filter:                 │         │
│           │       geo.region == Europe AND      │         │
│           │       performance.avg_latency < 100 │         │
│           │       (cross-reference with live    │         │
│           │        ping from Adaptive Routing   │         │
│           │        Plane for accuracy)          │         │
│           │                                     │         │
│           │    4. Filtered Vec<AgentRecord>     │         │
│           │ ◄──────────────────────────────────│         │
│           │                                     │         │
│  5. Connect to best candidate.                 │         │
└──────────┘                                     └─────────┘
```

**Latency:** One DHT lookup (~50-100ms) + one confirmation ping (~50ms)
+ one connection (~50ms) = ~150-200ms total.

#### Static vs Dynamic Geo

There is an important distinction:

- **Static geo** (in the capability record): where the agent is
  *deployed*. This is advertised in `GeoConstraint` and is relatively
  stable. It tells you "this agent runs in a Frankfurt datacenter."
- **Dynamic geo** (from the routing plane): what latency the client
  *actually experiences*. This is measured by live pings and is tracked
  by the Adaptive Routing Plane (Track T). It tells you "from my
  location, this agent responds in 45ms."

The query should filter on static geo first (cheap, from the record) and
then confirm with dynamic latency (one ping). This avoids pinging agents
that are obviously in the wrong region.

#### Implementation Path

The `GeoConstraint` (Track U, §3.1) and `PerformanceProfile` (Track U,
§3.1) structs encode static geo and advertised performance. The
`RegionalDiscovery` module (`regional.rs`) already has a `Region` enum
with `Europe`, `UsEast`, etc. The `CapabilityIndex` (Track U, §5.2)
should include a `by_region: HashMap<Region, Vec<Capability>>` secondary
index. The Adaptive Routing Plane (Track T) provides live latency
measurements for the final confirmation step.

---

### 3.4 Scenario 4: Pipeline OCR → Translate → Summarize

> **Query:** "Find me a pipeline: OCR → translate → summarize."

#### What This Requires

- **Multi-capability planning:** three distinct capabilities, executed in
  sequence, with data flowing between them.
- **Composition:** the output of each step must be compatible with the
  input of the next.
- **Agent selection:** each step may be performed by a different agent,
  or all by one agent.
- **Dependency resolution:** "translate" may require "document-read"
  first; "summarize" may require "translation" to produce text first.

#### Current Flow (Today)

```
┌──────────┐
│  Client   │
│  Agent    │
│           │
│  1. lookup("image-ocr")    ──► DHT → [agent_A, agent_B, ...]
│  2. lookup("translation")  ──► DHT → [agent_C, agent_D, ...]
│  3. lookup("summarization")──► DHT → [agent_E, agent_F, ...]
│           │
│  4. Manually select one agent for each step:
│     - OCR: agent_A
│     - Translate: agent_C (but which language pair?)
│     - Summarize: agent_E
│           │
│  5. Execute pipeline manually:
│     ── image ──► agent_A (OCR) ──► text (ja)
│     ── text (ja) ──► agent_C (translate ja→en) ──► text (en)
│     ── text (en) ──► agent_E (summarize) ──► summary
│           │
│  6. If agent_C doesn't support ja→en, go back to step 2,
│     try agent_D, repeat.
└──────────┘
```

**Problem:** The client must manually orchestrate three separate
discovery queries, manually select agents for each step, manually verify
compatibility (does the translator accept the OCR's output format? does
it support the right language pair?), and manually execute the pipeline
with data handoff between steps. There is no notion of pipeline
assembly, dependency resolution, or compatibility checking in the
discovery layer.

**Latency:** 3 × DHT lookup (~300ms) + N × compatibility checks
(variable) + 3 × execution (variable). Discovery alone: ~300-600ms.
With trial-and-error for language pairs: potentially seconds.

#### Target Flow (With Capability Graph + Planner)

```
┌──────────┐
│  Client   │
│  Agent    │
│           │
│  1. Goal: "Summarize a Japanese image document in English"
│           │
│  2. CapabilityPlanner::plan(goal, available_capabilities)
│           │
│     Planner reasoning:
│     ┌─────────────────────────────────────────────────┐
│     │ Goal: text summary (en) of image document (ja)  │
│     │                                                  │
│     │ Step 1: image-ocr (ja)                           │
│     │   → produces: text (ja)                          │
│     │   → agent: {those with ocr + lang=ja}            │
│     │                                                  │
│     │ Step 2: translation (ja→en)                      │
│     │   → requires: text (ja) [from step 1]            │
│     │   → produces: text (en)                          │
│     │   → agent: {those with translation + ja→en}      │
│     │                                                  │
│     │ Step 3: summarization (en)                       │
│     │   → requires: text (en) [from step 2]            │
│     │   → produces: summary (en)                       │
│     │   → agent: {those with summarization + lang=en}  │
│     └─────────────────────────────────────────────────┘
│           │
│  3. DHT lookups (batched, concurrent):
│     ┌─ lookup("image-ocr")     ──► [agent_A, agent_B]
│     ├─ lookup("translation")   ──► [agent_C, agent_D]
│     └─ lookup("summarization") ──► [agent_E, agent_F]
│        (all three in parallel, ~100ms total)
│           │
│  4. Local filtering + pipeline assembly:
│     - OCR: agent_A (supports ja, avg 40ms, $0.0001/img)
│     - Translate: agent_C (ja→en, avg 80ms, $0.0001/1k tokens)
│     - Summarize: agent_E (en, avg 120ms, $0.0002/1k tokens)
│           │
│  5. ExecutionPlan {
│       steps: [OCR, Translate, Summarize],
│       estimated_total_latency_ms: 240,
│       estimated_total_cost_micro_usd: 400,
│     }
│           │
│  6. Execute:
│     image ──► agent_A ──► text(ja)
│                      ──► agent_C ──► text(en)
│                                    ──► agent_E ──► summary
└──────────┘
```

**Latency:** 3 concurrent DHT lookups (~100ms with α=3 parallelism) +
local planning (<5ms) + 3 sequential executions (variable, but
discovery is ~100-150ms).

#### Implementation Path

This is the most complex scenario and requires the full Track U stack:

1. **CapabilityGraph** (Track U, §6): a directed graph where nodes are
   capabilities and edges are `CapabilityEdge` with types `Precedes`,
   `Requires`, `Enables`, `Alternative`, `Specializes`.
2. **PipelineAssembler** (Track U, §6.1): traverses the graph to find a
   path from available inputs to desired outputs, using topological sort
   on `Precedes` edges.
3. **CapabilityPlanner** (Track U, §10): a heuristic planner (greedy or
   A* search) that takes a goal query and available capabilities and
   produces an `ExecutionPlan` with ordered steps, estimated latency,
   and estimated cost.
4. **OutputSpec / Requirement** (Track U, §3.1): each capability
   declares what it requires (inputs) and what it provides (outputs),
   enabling compatibility checking between pipeline steps.

The `semantic/pipeline.rs` and `semantic/planner.rs` files already exist
in the discovery crate's `semantic/` subdirectory, indicating this work
is underway.

---

### 3.5 Scenario 5: Trusted Code Execution Agents

> **Query:** "Find me agents I trust for code execution."

#### What This Requires

- **Capability:** `code-execute`
- **Trust filtering:** only agents that the client has a trust
  relationship with, or that have a trust score above a threshold.
- **Security sensitivity:** code execution is the highest-risk
  capability — the agent runs arbitrary code. Trust is not optional; it
  is the primary filter.

#### Current Flow (Today)

```
┌──────────┐    1. lookup("code-execute")         ┌─────────┐
│  Client   │ ──────────────────────────────────► │   DHT   │
│  Agent    │                                     │  Node   │
│           │    2. Vec<AgentRecord>              │         │
│           │       (all code-execute agents,     │         │
│           │        no trust info)               │         │
│           │ ◄──────────────────────────────────│         │
│           │                                     │         │
│  3. For each candidate:                        │         │
│     - Check TrustManager for trust relationship│         │
│     - Check if agent_id is in trust anchors    │         │
│     - Check if agent has a CA-signed cert      │         │
│     - Check TOFU status                       │         │
│           │                                     │         │
│  4. Filter to trusted agents only.             │         │
│  5. Connect to trusted agent.                  │         │
└──────────┘                                     └─────────┘
```

**Problem:** Trust information is not in the DHT. The `TrustManager`
(`aafp-identity::trust_manager`) maintains trust anchors, revocation
lists, and Web of Trust relationships, but these are local to each
agent. The DHT returns all code-execute agents; the client must
cross-reference each one against its local trust store. This is correct
(trust is subjective and local), but the filtering is O(N) and happens
after the full candidate set is downloaded.

**Latency:** One DHT lookup (~50-100ms) + O(N) local trust lookups
(<1ms each, in-memory) = ~50-100ms. This is actually acceptable — the
trust check is local and fast. The issue is not latency but
**completeness**: the client can only filter by agents it already knows
about. A new, highly trusted agent that the client has never seen will
be filtered out.

#### Target Flow (With Trust Scores + UCAN Attestation)

```
┌──────────┐    1. CapabilityQuery {              ┌─────────┐
│  Client   │         name: "code-execute",       │   DHT   │
│  Agent    │         quality: QualityFilter {    │  Node   │
│           │           min_trust_score: 90,      │         │
│           │         }                           │         │
│           │       }                             │         │
│           │ ───────────────────────────────────►│         │
│           │                                     │         │
│           │    2. DHT returns candidates with   │         │
│           │       QualityMetrics in semantic    │         │
│           │       metadata (trust_score,        │         │
│           │       success_count, uptime_pct)    │         │
│           │                                     │         │
│           │    3. Local filter (two layers):    │         │
│           │       a) Objective: trust_score ≥ 90│         │
│           │          (from semantic metadata,   │         │
│           │           attested by UCAN chain)   │         │
│           │       b) Subjective: is this agent  │         │
│           │          in my TrustManager?        │         │
│           │          - Direct trust? ✓          │         │
│           │          - CA-signed? ✓             │         │
│           │          - Web of Trust path? ✓     │         │
│           │          - TOFU? (configurable)     │         │
│           │                                     │         │
│           │    4. Filtered Vec<AgentRecord>     │         │
│           │       (trusted code-execute agents) │         │
│           │ ◄──────────────────────────────────│         │
│           │                                     │         │
│  5. Connect to trusted agent.                  │         │
│     - UCAN capability chain authorizes the     │         │
│       specific code-execution scope.           │         │
│     - Sandbox type, timeout, resource limits   │         │
│       verified from semantic metadata.         │         │
└──────────┘                                     └─────────┘
```

**Latency:** One DHT lookup (~50-100ms) + local trust evaluation
(<5ms) + one connection (~50ms) = ~100-155ms.

#### Two-Layer Trust Model

Trust in AAFP is **not a single number**. It is a combination of:

1. **Objective trust score** (in `QualityMetrics`): a 0-100 score
   derived from successful invocations, uptime, and attestations. This
   is advertised in the semantic capability metadata and is verifiable
   via UCAN capability chains. It answers: "Is this agent reliable?"
2. **Subjective trust relationship** (in `TrustManager`): the client's
   own trust anchors, CA signatures, and Web of Trust paths. This is
   local and never advertised. It answers: "Do *I* trust this agent?"

For code execution, both layers are required. An agent with a high
objective trust score that the client has no subjective trust
relationship with should still require explicit approval (TOFU prompt or
CA verification). An agent the client directly trusts but has a low
objective score should trigger a warning.

#### Implementation Path

The `TrustManager` (`aafp-identity::trust_manager`) already implements
RFC 0011's hybrid trust model (Web of Trust, CA-signed certs, key
rotation). The `QualityMetrics` struct (Track U, §3.1) with
`trust_score`, `success_count`, and `uptime_pct` provides the objective
layer. The UCAN capability chain (`aafp-identity`) provides attestation.
The missing piece is **connecting** the trust manager to the discovery
filter pipeline — the `CapabilityQuery` should accept a `TrustFilter`
that delegates to the local `TrustManager` for the subjective layer.

---

## 4. DHT vs Registry vs DNS

AAFP has three potential discovery mechanisms. They are not
competitors — they serve different layers of the discovery stack.

### 4.1 Capability DHT

| Property | Value |
|----------|-------|
| **What it finds** | Agents by capability ("who does X?") |
| **Key** | SHA-256(capability_string) |
| **Value** | Vec<AgentRecord> |
| **Distribution** | P2P, Kademlia-style, no central server |
| **Consistency** | Eventually consistent, k=5 replication |
| **Latency** | ~50-100ms (multi-hop iterative lookup) |
| **Failure mode** | Degrades gracefully — partial results from reachable nodes |
| **Best for** | Dynamic, decentralized capability discovery where agents join and leave frequently |

**Use when:** You need to find agents by what they *can do*, the network
is peer-to-peer, and no central authority should be required.

### 4.2 Registry (Key Directory)

| Property | Value |
|----------|-------|
| **What it finds** | AgentRecord by AgentId ("who is this agent?") |
| **Key** | AgentId (256-bit) |
| **Value** | AgentRecord (current, signed) |
| **Distribution** | Centralized or federated server (with SQLite backend) |
| **Consistency** | Strong — single writer per AgentId, monotonic versions |
| **Latency** | ~100ms-1s (network round-trip to registry server) |
| **Failure mode** | Registry down → cannot resolve new agents; cached records still usable |
| **Best for** | Authoritative identity resolution, key rotation, revocation |

**File:** `crates/aafp-identity/src/key_directory.rs` — in-memory and
SQLite backends, rate-limited publishing (1/AgentId/hour), signature
verification, monotonic version enforcement.

**Use when:** You have an AgentId and need the current AgentRecord (e.g.,
after a DHT lookup returned a stale record, or to verify a key rotation).
The registry is the *authoritative* source for identity; the DHT is the
*searchable* source for capability.

### 4.3 DNS

| Property | Value |
|----------|-------|
| **What it finds** | Network address by hostname ("where is seed1.aafp.io?") |
| **Key** | Domain name (e.g., "seed1.aafp.io") |
| **Value** | IP address (A/AAAA record) |
| **Distribution** | Global DNS hierarchy |
| **Consistency** | TTL-based caching, eventually consistent |
| **Latency** | ~1-50ms (cached) to ~100ms (recursive) |
| **Failure mode** | DNS down → cannot resolve hostnames; direct IPs still work |
| **Best for** | Bootstrapping — resolving seed node hostnames to IP addresses |

**Use when:** You are bootstrapping and need to resolve a seed node's
hostname to an IP address. DNS is *not* used for capability discovery —
it is used only for the initial "how do I find my first peer" step.

### 4.4 When to Use Each

```
┌─────────────────────────────────────────────────────────────┐
│                  Discovery Decision Tree                     │
│                                                              │
│  Do you have an AgentId and need its current record?        │
│    YES → Registry (KeyDirectory)                            │
│    NO ↓                                                     │
│                                                              │
│  Do you have a hostname and need an IP address?             │
│    YES → DNS                                                │
│    NO ↓                                                     │
│                                                              │
│  Do you need to find agents by capability?                  │
│    YES → Capability DHT                                     │
│    NO ↓                                                     │
│                                                              │
│  Are you bootstrapping with no peers?                       │
│    YES → DNS (resolve seeds) → DHT (find peers)            │
│    NO  → Direct connection (you already have the address)   │
└─────────────────────────────────────────────────────────────┘
```

### 4.5 Combined Usage Pattern

A typical discovery session uses all three:

1. **DNS:** Resolve `seed1.aafp.io` → `203.0.113.42`
2. **DHT:** Connect to seed, lookup `("translation")` →
   `[AgentRecord for agent_C, ...]`
3. **Registry:** Verify `agent_C`'s record is current by querying the
   KeyDirectory with `agent_C`'s AgentId → confirmed, version 7 is
   latest.

Each layer handles a different question: *where* (DNS), *who does X*
(DHT), *who exactly is this* (Registry).

---

## 5. Caching Strategy

### 5.1 Why Cache?

DHT lookups are expensive: ~50-100ms per lookup with multi-hop
iterative routing. A client that issues the same lookup repeatedly
(e.g., "find translation agents" for every translation request) wastes
network round-trips. A local cache reduces repeated lookups to <1ms.

### 5.2 Cache Architecture

```
┌──────────────────────────────────────────────────┐
│                  Client Agent                     │
│                                                   │
│  ┌─────────────┐    miss    ┌─────────────┐      │
│  │  Local Cache │ ────────► │  DHT Lookup  │      │
│  │  (TTL-based) │           │  (network)   │      │
│  │              │  ◄──────── │              │      │
│  │  cap → records│  fill     │              │      │
│  └──────┬───────┘           └─────────────┘      │
│         │                                        │
│         │ hit (<1ms)                             │
│         ▼                                        │
│  ┌─────────────┐                                │
│  │  Capability  │                                │
│  │  Index       │                                │
│  │  (secondary  │                                │
│  │   indexes)   │                                │
│  └─────────────┘                                │
└──────────────────────────────────────────────────┘
```

### 5.3 Cache Entry

```rust
pub struct CacheEntry {
    /// The capability string this entry is cached for.
    pub capability: String,
    /// The cached agent records.
    pub records: Vec<AgentRecord>,
    /// When this entry was populated.
    pub cached_at: Instant,
    /// Time-to-live: when this entry expires.
    pub expires_at: Instant,
    /// Hash of the records (for invalidation comparison).
    pub records_hash: [u8; 32],
}
```

### 5.4 TTL Strategy

| Cache Tier | TTL | Rationale |
|------------|-----|-----------|
| Hot capabilities (frequently queried) | 60s | High churn risk, but query frequency justifies short caching |
| Warm capabilities (occasionally queried) | 300s | Moderate churn, moderate query frequency |
| Cold capabilities (rarely queried) | 900s | Low churn, low query frequency — long TTL is safe |
| Agent identity (AgentId → AgentRecord) | 3600s | Identity changes rarely (key rotation is rare) |
| Negative results (capability not found) | 30s | Short TTL — a new agent may announce at any time |

### 5.5 Invalidation

Cache invalidation is triggered by:

1. **TTL expiry:** Entry expires, next lookup goes to DHT.
2. **Capability change notification:** When an agent announces an
   updated `AgentRecord` (new version number), all caches holding that
   agent's record are invalidated. This uses a gossip-based invalidation
   message: `{"type": "invalidate", "agent_id": "...", "version": 7}`.
3. **Explicit refresh:** The client can force a cache bypass with a
   `refresh = true` flag on the lookup, useful when the client suspects
   staleness (e.g., after a connection failure to a cached agent).
4. **Liveness-based eviction:** If a cached agent fails a health check
   (ping), its record is evicted from the cache immediately, regardless
   of TTL.

### 5.6 Cache Size Limits

The cache should have a maximum size (e.g., 10,000 entries) with LRU
eviction. Each entry is ~1-5KB (an AgentRecord with semantic metadata),
so 10K entries = ~10-50MB — acceptable for an agent process.

---

## 6. Discovery Latency Budget

### 6.1 Budget Table

| Discovery Path | Budget | Typical | Worst Case |
|----------------|--------|---------|------------|
| **Local cache hit** | <10ms | <1ms | 5ms (large result set sort) |
| **DHT lookup (single-hop)** | <50ms | 20-40ms | 80ms (congested node) |
| **DHT lookup (multi-hop)** | <100ms | 50-80ms | 200ms (3 hops, α=3) |
| **Registry lookup** | <1s | 100-300ms | 800ms (remote registry, TLS) |
| **DNS resolution** | <50ms | 1-10ms (cached) | 100ms (recursive) |
| **Full pipeline planning** | <500ms | 100-200ms | 400ms (complex graph) |
| **Negative discovery** | <200ms | 100ms | 200ms (DHT + wanted publish) |

### 6.2 End-to-End Budget for Each Scenario

| Scenario | Path | Budget |
|----------|------|--------|
| 1. Translate ja→en | cache (1ms) or DHT (100ms) + connect (50ms) | <150ms |
| 2. Cheapest OCR | DHT (100ms) + local sort (1ms) + connect (50ms) | <150ms |
| 3. EU + <100ms | DHT (100ms) + ping (50ms) + connect (50ms) | <200ms |
| 4. Pipeline 3-step | 3× DHT concurrent (100ms) + plan (5ms) + 3× exec | <150ms discovery |
| 5. Trusted code-exec | DHT (100ms) + trust eval (5ms) + connect (50ms) | <155ms |

### 6.3 Meeting the Budget

The <10ms cached budget is met by keeping the cache in-process (no
network, no serialization). The <100ms DHT budget is met by α=3
concurrent iterative lookups with a max of 10 iterations (configured in
`DhtRouterConfig.max_lookup_iterations`). The <1s registry budget is
met by using a nearby registry server (or a federated registry with
anycast routing).

If a lookup exceeds its budget, the client should:
1. Return partial results (if any were received).
2. Log the latency violation.
3. Fall back to a cached result if available (even if stale).

---

## 7. Bootstrapping

### 7.1 The Cold Start Problem

A new agent that has just started knows nothing about the network. It
has no peers, no routing table entries, and no capability records. It
must discover its first peers to join the DHT. This is the
**bootstrapping problem**.

### 7.2 Bootstrap Sequence

```
┌──────────┐
│ New Agent │
│ (just     │
│  started) │
│           │
│  Step 1: Load seed list
│    - From config file: seed_nodes = [
│        "quic://seed1.aafp.io:4433",
│        "quic://seed2.aafp.io:4433",
│        "quic://seed3.aafp.io:4433",
│      ]
│    - Or from DNS TXT record: 
│      dig TXT _aafp._seed.example.com
│      → "quic://seed1.aafp.io:4433"
│           │
│  Step 2: DNS resolution
│    - Resolve seed1.aafp.io → 203.0.113.42
│    - Resolve seed2.aafp.io → 198.51.100.7
│    - (parallel, ~10-50ms)
│           │
│  Step 3: Connect to seed nodes (parallel)
│    - QUIC handshake with seed1 (PQ TLS)
│    - QUIC handshake with seed2
│    - Timeout: 30s (BootstrapConfig.timeout)
│    - Min peers: 3 (BootstrapConfig.min_peers)
│           │
│  Step 4: Announce self
│    - Send AgentRecord to seed1 via
│      aafp.discovery.announce RPC
│    - Seed responds with known peers
│      (AnnounceResult.peers)
│    - Add peers to routing table
│           │
│  Step 5: PEX (Peer Exchange)
│    - Send aafp.discovery.pex to seed1
│      with our AgentRecord + known peers
│    - Seed responds with its peer list
│    - Add all new peers to routing table
│    - Repeat with seed2, seed3
│           │
│  Step 6: Routing table populated
│    - K-buckets filled from PEX results
│    - Begin bucket refresh (15-min interval)
│    - Begin capability lookups as needed
│           │
│  Step 7: Bootstrap complete
│    - is_complete() == true when
│      discovered.len() >= min_peers
└──────────┘
```

**File:** `crates/aafp-discovery/src/bootstrap.rs` (lines 26-44) —
`BootstrapConfig` with `seed_nodes`, `timeout` (30s default), and
`min_peers` (3 default). The `BootstrapDiscovery` struct (lines 51-107)
manages the process, verifying each discovered record's signature before
adding it.

### 7.3 Seed List Sources

| Source | When to Use | Reliability |
|--------|-------------|-------------|
| **Config file** | Production deployments with known seeds | High (operator-controlled) |
| **DNS TXT records** | Dynamic seed discovery without config updates | Medium (DNS can be spoofed) |
| **Hardcoded defaults** | First-run / development | Low (seeds may be down) |
| **mDNS** | LAN-only / disconnected environments | High (local, no internet needed) |
| **Peer referral** | After initial bootstrap, peers share more peers via PEX | High (trust propagates) |

### 7.4 Seed Node Requirements

Seed nodes are not special — they are regular agents that are
well-known and highly available. Their only job is to respond to
`announce` and `pex` RPCs from new agents. A seed node should:
- Have a stable IP address (or DNS name).
- Be always online (high uptime).
- Have a large routing table (connected to many peers).
- Rate-limit announce requests (1 per AgentId per 60s, per
  `discovery_v1.rs` line 38).

---

## 8. Discovery in Disconnected Environments

### 8.1 LAN-Only Operation

In environments with no internet access (air-gapped networks, isolated
LANs, disaster scenarios), the DHT must function without seed nodes or
DNS. The solution is **mDNS (Multicast DNS)** for local peer discovery.

```
┌─────────────────────────────────────────────────────┐
│                  LAN (no internet)                   │
│                                                      │
│   ┌──────────┐    mDNS broadcast    ┌──────────┐    │
│   │  Agent A  │ ──────────────────► │  Agent B  │    │
│   │  (OCR)    │   _aafp._tcp.local  │  (Translate)│  │
│   │           │ ◄────────────────── │           │    │
│   └──────────┘                     └──────────┘    │
│         ▲                                ▲          │
│         │   mDNS broadcast               │          │
│         │   _aafp._tcp.local             │          │
│         ▼                                ▼          │
│   ┌──────────┐                     ┌──────────┐    │
│   │  Agent C  │                     │  Agent D  │    │
│   │ (Summarize)│                    │ (Code-exec)│   │
│   └──────────┘                     └──────────┘    │
│                                                      │
│   No DNS, no seed nodes, no internet.               │
│   mDNS discovers all local agents.                  │
│   DHT operates on local peers only.                 │
└─────────────────────────────────────────────────────┘
```

### 8.2 mDNS Discovery Flow

1. Agent starts, listens for mDNS queries on `_aafp._tcp.local`.
2. Agent broadcasts its presence via mDNS: name, IP, port, AgentId.
3. Other agents on the LAN receive the broadcast and add the new agent
   to their routing table.
4. Standard DHT operations (announce, lookup, pex) proceed over the LAN.
5. No DNS resolution needed — mDNS provides local name resolution.

### 8.3 Hybrid Mode

An agent can operate in both internet-connected and LAN modes
simultaneously:
- Internet DHT: global capability discovery via seed nodes.
- LAN DHT: local capability discovery via mDNS.
- The routing table contains both internet and LAN peers.
- Lookups query both sets (with preference for LAN peers when latency
  is critical).

### 8.4 Challenges in Disconnected Environments

| Challenge | Mitigation |
|-----------|------------|
| Small peer count (3-5 agents) | DHT still works — k-buckets are mostly empty but lookups succeed |
| No capability available locally | Negative discovery with "wanted" requests (see §9) |
| No registry for identity verification | Cache AgentRecords locally; use TOFU for new agents |
| No CA for certificate verification | Web of Trust (transitive trust from known local agents) |
| Stale records (no churn from internet) | Longer TTLs acceptable; lower churn in stable LANs |

---

## 9. Negative Discovery

### 9.1 The Problem

When a client looks up a capability and no agent in the DHT has it, the
lookup returns an empty `Vec<AgentRecord>`. The client knows the
capability is unavailable *now*, but has no way to express "I need this
capability — please tell me if anyone announces it in the future."

### 9.2 Wanted Requests

**Negative discovery** is the mechanism for publishing unmet needs:

```
┌──────────┐                                     ┌─────────┐
│  Client   │    1. lookup("swahili-translation") │   DHT   │
│  Agent    │ ──────────────────────────────────► │  Node   │
│           │                                     │         │
│           │    2. Vec<AgentRecord> = []         │         │
│           │       (no agents have this cap)     │         │
│           │ ◄──────────────────────────────────│         │
│           │                                     │         │
│  3. Publish "wanted" request:                  │         │
│     ── wanted({                              ──►│         │
│          capability: "swahili-translation",    │         │
│          attributes: {source: "sw", target:"en"},│       │
│          callback: "quic://client:4433",       │         │
│          ttl: 3600s,                           │         │
│        })                                      │         │
│           │                                     │         │
│  4. DHT stores wanted request in a             │         │
│     separate "wanted" key space.               │         │
│     Key = SHA-256("wanted:" + capability)      │         │
│           │                                     │         │
│  ─────────────────────────────────────────────  │         │
│  ...time passes...                              │         │
│  ─────────────────────────────────────────────  │         │
│           │                                     │         │
│  ┌──────────┐                                   │         │
│  │ New Agent │  5. Announces "swahili-translation"│       │
│  │ (just     │     capability                    │         │
│  │  joined)  │ ────────────────────────────────►│         │
│  └──────────┘                                   │         │
│           │                                     │         │
│  6. DHT node checks wanted list,               │         │
│     finds matching wanted request,             │         │
│     notifies client via callback.              │         │
│           │                                     │         │
│           │    7. Notification:                 │         │
│           │    "Agent X now provides            │         │
│           │     swahili-translation"            │         │
│           │ ◄──────────────────────────────────│         │
│           │                                     │         │
│  8. Client connects to new agent.              │         │
└──────────┘                                     └─────────┘
```

### 9.3 Wanted Request Structure

```rust
pub struct WantedRequest {
    /// The capability needed.
    pub capability: String,
    /// Optional attribute filters (semantic query).
    pub filters: Vec<QueryFilter>,
    /// Callback address for notification.
    pub callback: Multiaddr,
    /// Time-to-live for this wanted request.
    pub ttl: Duration,
    /// Requester's AgentId (for trust scoring of responses).
    pub requester: AgentId,
    /// Signature over the request.
    pub signature: Vec<u8>,
}
```

### 9.4 Wanted Request Lifecycle

1. **Publish:** Client stores the wanted request in the DHT under
   `SHA-256("wanted:" + capability)`. The DHT node replicates it to k=5
   closest peers (same as regular records).
2. **Match:** When a new agent announces a capability, the DHT node
   checks its local wanted list for matching requests. If the capability
   string matches and the attribute filters pass, the node sends a
   notification to the callback address.
3. **Notify:** The notification includes the new agent's `AgentRecord`
   and the matching wanted request ID.
4. **Expire:** Wanted requests expire after their TTL. The DHT node
   garbage-collects expired requests.
5. **Cancel:** The client can explicitly cancel a wanted request by
   sending a signed cancellation message.

### 9.5 Negative Discovery as a Market Signal

Wanted requests are not just a technical mechanism — they are a
**market signal**. If multiple clients publish wanted requests for
"swahili-translation," that signals demand. Agent operators monitoring
the wanted feed can deploy agents for in-demand capabilities. This
creates a self-organizing market where supply follows demand.

---

## 10. Discovery Security

### 10.1 Threat Model

| Threat | Description | Severity |
|--------|-------------|----------|
| **DHT poisoning** | Malicious agent injects false capability records | High |
| **Capability spoofing** | Agent claims a capability it doesn't have | High |
| **Sybil attack** | Attacker creates many fake AgentIds to dominate a capability key | High |
| **Eclipse attack** | Attacker surrounds a victim with malicious peers, controlling all its DHT lookups | High |
| **Stale record attack** | Attacker replays an old, valid AgentRecord after the agent has left | Medium |
| **Wanted request spam** | Attacker floods the wanted request space | Low |
| **Query injection** | Malicious queries exhaust node resources | Low |

### 10.2 DHT Poisoning Prevention

**Current defense:** Every `AgentRecord` is signed with ML-DSA-65 (a
post-quantum signature scheme). The `CapabilityDht::put()` method
(line 79) verifies the signature before storing:

```rust
pub fn put(&mut self, record: AgentRecord) -> Result<(), DhtError> {
    if !record.verify() {
        return Err(DhtError::VerificationFailed);
    }
    // ... store
}
```

This prevents an attacker from injecting records with forged AgentIds.
However, it does **not** prevent an attacker from creating a legitimate
keypair and advertising false capabilities. Signature verification
proves *who* signed the record, not *what they can do*.

**Additional defenses needed:**

1. **Rate limiting:** The `discovery_v1.rs` rate limits announce to 1
   per AgentId per 60 seconds (line 38). This slows down poisoning but
   does not prevent it.
2. **Reputation scoring:** Track the historical accuracy of an agent's
   advertised capabilities. If an agent claims "translation" but fails
   translation tasks, its reputation score drops, and future lookups
   deprioritize it.
3. **UCAN capability attestation:** A capability claim should be
   backed by a UCAN chain — a delegation from a trusted authority
   attesting that the agent can perform the capability. This is the
   strongest defense: an agent can only claim a capability if a trusted
   attester has delegated it.
4. **Challenge-response verification:** Before relying on a capability
   claim, the client sends a small challenge (e.g., "translate this
   10-word sentence"). If the agent fails, the claim is marked
   unverified.

### 10.3 Sybil Attack Prevention

A Sybil attack creates many fake identities to dominate a DHT key space.
Defenses:

1. **Proof of work for AgentId generation:** Require a small PoW
   (e.g., AgentId must start with 10 zero bits). This makes creating
   many identities computationally expensive.
2. **Trust-weighted routing:** In the routing table, peers are weighted
   by trust score. A Sybil attacker with many low-trust peers has less
   influence than a few high-trust peers.
3. **CA-signed AgentRecords:** If the network requires AgentRecords to
   be signed by a CA, the attacker must obtain CA signatures for each
   fake identity — expensive and rate-limited.
4. **K-bucket diversity:** Kademlia's k-bucket structure naturally
   limits the influence of Sybil nodes — they can only fill buckets
   corresponding to their XOR distance, not arbitrary buckets.

### 10.4 Eclipse Attack Prevention

An eclipse attack isolates a victim by filling its routing table with
attacker-controlled peers. Defenses:

1. **Multiple seed nodes:** Bootstrap from multiple independent seeds
   (3+). If one seed is compromised, the others provide honest peers.
2. **Peer diversity enforcement:** Ensure the routing table contains
   peers from different k-bucket ranges, not concentrated in one range.
3. **Random peer eviction:** Occasionally evict a random peer and
   replace it with a newly discovered one, breaking eclipse attempts.
4. **PEX cross-validation:** When receiving peer lists via PEX,
   cross-validate with multiple sources. If a peer is only recommended
   by one source, treat it with suspicion.

### 10.5 Verifying Advertised Capabilities

Signature verification proves *identity*, not *capability*. To verify
that an agent actually has a capability:

| Method | Cost | Confidence |
|--------|------|------------|
| **UCAN attestation** | Low (verify a chain) | High (if attester is trusted) |
| **Challenge-response** | Medium (one round-trip + computation) | High (for the specific task) |
| **Reputation score** | Low (lookup) | Medium (historical, may not reflect current state) |
| **Trial invocation** | High (full task) | Highest (but expensive) |
| **Third-party audit** | Low (lookup) | High (if auditor is trusted) |

The recommended approach is **layered**: use UCAN attestation as the
baseline (cheap, high confidence if the attester is trusted), fall back
to challenge-response for high-stakes capabilities (code execution,
financial operations), and use reputation scoring as a tiebreaker.

### 10.6 Query Injection Prevention

Malicious queries could exhaust node resources (e.g., a query that
expands to millions of results). Defenses:

1. **Query complexity limits:** Cap the number of filters, nesting
   depth, and result set size per query.
2. **Rate limiting:** Limit queries per AgentId per time window (10 per
   60 seconds, per `discovery_v1.rs` line 41).
3. **Result set caps:** `DEFAULT_LIMIT_UNAUTH = 5`,
   `DEFAULT_LIMIT_AUTH = 10` (lines 29-32) — unauthenticated lookups
   get fewer results, reducing amplification.
4. **Timeouts:** Each lookup has a timeout (part of
   `DhtRouterConfig.max_lookup_iterations = 10`).

---

## 11. Conclusion

The current AAFP discovery system — a flat, in-memory, exact-string-match
DHT — is the right *starting point*. It is simple, correct, and
demonstrably works for the basic "find me an agent that does X" case.
But real-world discovery is richer:

- **Attribute filtering** (language, cost, latency, region) requires
  semantic capability metadata and local secondary indexes.
- **Ranking** (cheapest, fastest, most trusted) requires structured
  performance and cost models in the capability record.
- **Pipeline assembly** (OCR → translate → summarize) requires a
  capability graph with typed edges and a planner.
- **Trust filtering** requires connecting the discovery layer to the
  TrustManager and UCAN attestation chains.
- **Negative discovery** requires a "wanted" request mechanism that
  publishes unmet needs and notifies on fulfillment.
- **Disconnected operation** requires mDNS for LAN-only bootstrapping.
- **Security** requires layered defenses: signatures (have), rate
  limiting (have), UCAN attestation (need), reputation (need),
  challenge-response (need).

The Semantic Capability Graphs design (Track U) and Adaptive Routing
Plane (Track T) address the attribute, ranking, and pipeline gaps. The
operational concerns — caching, latency budgets, bootstrapping,
disconnected operation, negative discovery, and security — require
additional work that builds on the existing infrastructure.

The key architectural principle is: **keep the DHT dumb, push
intelligence to the edges.** The DHT should remain a simple key-value
store keyed by capability name. All filtering, ranking, planning, and
trust evaluation should happen locally on the discovering agent, using
semantic metadata retrieved from the DHT and local indexes built from
discovered records. This keeps the DHT fast, simple, and scalable, while
enabling rich discovery queries at the client level.

---

## Appendix A: Scenario-to-Implementation Mapping

| Scenario | Current Gap | Track U Component | Track T Component | Operational Need |
|----------|-------------|-------------------|-------------------|------------------|
| 1. Translate ja→en | No language attribute | `CapabilityAttributes.languages` | — | Local `CapabilityIndex` |
| 2. Cheapest OCR | No cost model | `CostModel` | — | `BTreeMap` sort index |
| 3. EU + <100ms | No geo or perf data | `GeoConstraint`, `PerformanceProfile` | Live latency probes | `RegionalDiscovery` |
| 4. Pipeline 3-step | No composition | `CapabilityGraph`, `PipelineAssembler`, `CapabilityPlanner` | — | `semantic/pipeline.rs` |
| 5. Trusted code-exec | No trust in discovery | `QualityMetrics.trust_score` | — | `TrustManager` integration |

## Appendix B: File Reference

| File | Purpose |
|------|---------|
| `crates/aafp-discovery/src/capability_dht.rs` | In-memory flat DHT (exact string match) |
| `crates/aafp-discovery/src/discovery_v1.rs` | v1 discovery protocol, RPC params/results, rate limits |
| `crates/aafp-discovery/src/dht_router.rs` | Kademlia routing table, iterative lookup, PEX |
| `crates/aafp-discovery/src/bootstrap.rs` | Bootstrap discovery (seed nodes, min_peers) |
| `crates/aafp-discovery/src/regional.rs` | Regional discovery (Region enum, latency buckets) |
| `crates/aafp-discovery/src/persistent_dht.rs` | SQLite-backed persistent DHT |
| `crates/aafp-discovery/src/semantic/` | Semantic capability graph (Track U, in progress) |
| `crates/aafp-identity/src/identity_v1.rs` | AgentRecord, CapabilityDescriptor, MetadataValue |
| `crates/aafp-identity/src/trust_manager.rs` | Hybrid trust model (WoT, CA, key rotation) |
| `crates/aafp-identity/src/key_directory.rs` | AgentId → AgentRecord registry (in-memory + SQLite) |
